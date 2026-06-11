import type * as http from "node:http";
import crypto from "node:crypto";
import type {
  ChatCompletionRequest,
  Fixture,
  HandlerDefaults,
  RecordConfig,
  VideoResponse,
} from "./types.js";
import type { Logger } from "./logger.js";
import {
  isVideoResponse,
  isErrorResponse,
  serializeErrorResponse,
  flattenHeaders,
  getTestId,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { DEFAULT_TEST_ID } from "./constants.js";
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaos } from "./chaos.js";
import { resolveProgression } from "./fal.js";
import {
  buildFixtureMatch,
  buildForwardHeaders,
  clampTimeout,
  persistFixture,
  sanitizeHeaderValue,
} from "./recorder.js";
import { resolveUpstreamUrl } from "./url.js";

/**
 * OpenRouter async video lifecycle mock (`/api/v1/videos`). Mirrors the
 * dedicated OpenRouter video-generation API: submit returns a job envelope,
 * status polls advance `pending → in_progress → completed | failed`, and a
 * `/content` endpoint serves the bytes. With `record.providers.openrouter`
 * configured, unmatched submits become a live interactive proxy: the submit
 * is forwarded upstream and answered with a mock-rewritten envelope, each
 * client poll is proxied upstream 1:1, and a completed job is captured
 * eagerly as a fixture (strict mode still wins over record).
 */

interface OpenRouterVideoRequest {
  model?: string;
  prompt?: string;
  [key: string]: unknown;
}

const DEFAULT_OPENROUTER_VIDEO_MODEL = "bytedance/seedance-2.0";

// ─── OpenRouterVideoJobMap (TTL + bounded) ──────────────────────────────────

export const OPENROUTER_VIDEO_MAX_ENTRIES = 10_000;
const OPENROUTER_VIDEO_TTL_MS = 3_600_000; // 1 hour

type OpenRouterVideoStatus = "pending" | "in_progress" | "completed" | "failed";

interface OpenRouterVideoReplayJob {
  kind: "replay";
  jobId: string;
  status: OpenRouterVideoStatus;
  /** Number of status polls the caller has made against this job. */
  pollCount: number;
  /** Poll-count threshold for `pending → in_progress` transition. */
  pollsBeforeInProgress: number;
  /** Poll-count threshold for the transition to the terminal status. */
  pollsBeforeCompleted: number;
  /** The matched fixture's video object (terminal status, bytes, cost, error). */
  video: VideoResponse["video"];
  /**
   * Latch for the empty-`error` authoring warn on failed polls — a polling
   * loop must surface the fixture defect once per job, not once per poll.
   */
  emptyErrorWarned?: boolean;
  /**
   * Latch for the per-download fixture-defect warns on the content endpoint
   * (b64 corruption / empty b64 / ignored url). The job's `video` is
   * immutable after submit, so the warn set is identical on every download —
   * surface it once per job, not once per re-download.
   */
  contentWarnsLatched?: boolean;
}

/**
 * A job whose lifecycle is proxied live upstream (record mode, no fixture
 * matched at submit). Every client poll is forwarded 1:1 to
 * `upstreamPollingUrl`; when the upstream reports a terminal status the
 * entry is captured as a fixture and MUTATED into a terminal
 * OpenRouterVideoReplayJob — so the content endpoint serves it like any
 * replay job. Under `record.proxyOnly` nothing is ever captured or mutated:
 * the job stays `kind: "record"` (terminal statuses included) and the
 * content endpoint live-proxies the stored upstream `unsigned_urls`.
 */
interface OpenRouterVideoRecordJob {
  kind: "record";
  /** The mock-issued jobId the client polls with. */
  jobId: string;
  /**
   * Last upstream status relayed to the client. Terminal values occur under
   * proxyOnly (the job stays a live proxy forever) and during the capturing
   * window — `completed` is set synchronously with `capturing` so the content
   * endpoint can live-proxy downloads while the eager capture is in flight.
   * Outside those two cases the capturing path mutates the entry into a
   * replay job at the terminal poll.
   */
  status: OpenRouterVideoStatus;
  /** Upstream's own job id (recorded as the fixture's video.id). */
  upstreamJobId: string;
  /** Origin-validated absolute upstream URL proxied on every client poll. */
  upstreamPollingUrl: string;
  /**
   * Match snapshot built at submit time (post requestTransform). Its `model`
   * is the submitted model as recorded by the standard model-normalization
   * rules — date suffixes stripped unless `recordFullModelVersion`; model-less
   * submits record the assumed default model.
   */
  match: Fixture["match"];
  /**
   * Upstream content URLs from a completed poll, stored under proxyOnly and
   * during the capturing window so the content endpoint can live-proxy the
   * bytes (never cached). Stored UNFILTERED — positions must line up with the
   * indexes the rewritten relay handed the client — so entries may be
   * non-strings; the content proxy skips unusable entries at use time.
   */
  upstreamUnsignedUrls?: unknown[];
  /**
   * Set synchronously before the first await of the eager-capture sequence so
   * a concurrent completed poll relays the upstream body instead of starting
   * a second capture/persist.
   */
  capturing?: boolean;
  /**
   * Latches for the per-poll upstream-defect warns in rewriteRecordPollBody
   * (mirrors emptyErrorWarned): a polling loop must surface each defect once
   * per job, not once per poll.
   */
  nonArrayUrlsWarned?: boolean;
  badCostWarned?: boolean;
}

export type OpenRouterVideoJob = OpenRouterVideoReplayJob | OpenRouterVideoRecordJob;

interface OpenRouterVideoEntry {
  job: OpenRouterVideoJob;
  createdAt: number;
}

/**
 * Per-testId job state for the OpenRouter video handler. Mirrors
 * FalQueueStateMap (fal.ts): lazy TTL eviction on `get`, FIFO eviction of the
 * oldest entries on `set` when over capacity, no background sweep timer.
 * Deliberate divergences from FalQueueStateMap:
 *   - lifetime: this map is per-server-instance (cleared on server
 *     close/reset) while FalQueueStateMap is module-global;
 *   - `set()` refreshes: delete-before-set moves a re-inserted key to the
 *     back of the FIFO order AND resets its createdAt, so a refreshed entry
 *     gets a fresh TTL — FalQueueStateMap's plain overwrite keeps the
 *     original insertion slot and is never used as a TTL refresh.
 * Keys are `${testId}:${jobId}`.
 */
export class OpenRouterVideoJobMap {
  private readonly entries = new Map<string, OpenRouterVideoEntry>();
  private worldGeneration = 0;

  /**
   * Monotonic world-generation counter, incremented by `clear()` (a fixtures
   * reset). Identity checks (`jobs.get(key) === job`) can only guard
   * continuations whose job was ALREADY inserted — a continuation that has
   * not inserted yet (the submit proxy's upstream fetch) captures this value
   * before its await and compares after, so it can detect that the world it
   * belongs to was reset mid-flight and skip seeding the new world.
   */
  get generation(): number {
    return this.worldGeneration;
  }

  get(key: string): OpenRouterVideoJob | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > OPENROUTER_VIDEO_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.job;
  }

  set(key: string, job: OpenRouterVideoJob): void {
    // Delete-before-set so a refreshed key moves to the BACK of the Map's
    // insertion order. A plain overwrite keeps the original insertion slot,
    // so the FIFO eviction below would treat a freshly TTL-refreshed entry
    // as the oldest and could evict it under capacity pressure — breaking
    // the documented "each successful proxied poll refreshes the TTL"
    // guarantee.
    this.entries.delete(key);
    this.entries.set(key, { job, createdAt: Date.now() });
    if (this.entries.size > OPENROUTER_VIDEO_MAX_ENTRIES) {
      const excess = this.entries.size - OPENROUTER_VIDEO_MAX_ENTRIES;
      const iter = this.entries.keys();
      for (let i = 0; i < excess; i++) {
        const next = iter.next();
        if (!next.done) this.entries.delete(next.value);
      }
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.worldGeneration++;
  }

  get size(): number {
    return this.entries.size;
  }
}

// ─── Job progression ────────────────────────────────────────────────────────

/**
 * Maps the fixture's terminal video status onto the job lifecycle. Anything
 * that is not "failed" — including a fixture authored as "processing" — is
 * treated as completed, since this surface always drives jobs to a terminal
 * state. handleOpenRouterVideoCreate warns when a "processing" fixture is
 * coerced this way.
 */
function terminalStatus(job: OpenRouterVideoReplayJob): OpenRouterVideoStatus {
  return job.video.status === "failed" ? "failed" : "completed";
}

/**
 * Mutates a job in place to advance its state on a status poll.
 * `pending → in_progress → completed | failed` based on poll-count thresholds.
 * No-op once terminal. The in_progress threshold is checked first so a job
 * whose thresholds are equal still spends one poll in in_progress instead of
 * jumping straight to the terminal status (fal advanceJob semantics).
 */
function advanceJob(job: OpenRouterVideoReplayJob): void {
  if (job.status === "completed" || job.status === "failed") return;

  job.pollCount += 1;
  if (job.status === "pending" && job.pollCount >= job.pollsBeforeInProgress) {
    job.status = "in_progress";
  } else if (job.pollCount >= job.pollsBeforeCompleted) {
    job.status = terminalStatus(job);
  }
}

/**
 * First non-empty value of a possibly array-typed, possibly comma-joined
 * header. An empty header value or a leading-comma list (", host") would
 * otherwise yield "" — triggering a spurious rejection warn and discarding
 * valid later entries — so empty segments are skipped.
 */
function firstForwardedValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw === undefined) return undefined;
  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

// Conservative host[:port] shape for x-forwarded-host. Spaces, slashes,
// userinfo, or any other URL-structure character would corrupt (or smuggle
// paths into) the generated URLs the value is interpolated into. Underscores
// are admitted: the value feeds URL-string interpolation, not DNS validation,
// and underscore hostnames are routine in docker-compose/k8s networks
// (e.g. my_project_aimock:4010).
const FORWARDED_HOST_RE = /^[a-zA-Z0-9._-]+(:\d+)?$/;
// Bracketed IPv6 literal host[:port], e.g. [::1] or [::1]:8080 — the bare
// RE above cannot admit ":" inside the host without also admitting junk.
const FORWARDED_HOST_IPV6_RE = /^\[[0-9a-fA-F:.]+\](:\d+)?$/;

function requestBase(req: http.IncomingMessage, logger: Logger): string {
  // Honor x-forwarded-proto and x-forwarded-host so generated URLs survive a
  // TLS-terminating or host-rewriting proxy in front of the mock. First
  // non-empty value wins on comma-joined lists.
  const candidate = firstForwardedValue(req.headers["x-forwarded-proto"])?.toLowerCase();
  // Allowlist http/https — any other value (ws, junk header data) falls back.
  const proto = candidate === "http" || candidate === "https" ? candidate : "http";
  // Like the proto allowlist, a forwarded host that doesn't look like a bare
  // host[:port] (or a bracketed IPv6 literal) falls back to the Host header —
  // with a warn, so a misconfigured proxy isn't silently ignored.
  const fwdHost = firstForwardedValue(req.headers["x-forwarded-host"]);
  // The Host fallback gets the same host[:port] validation — a junk Host
  // (e.g. "evil.com/path") could otherwise smuggle URL structure into the
  // generated URLs. No warn: a missing/odd Host is transport-level noise,
  // unlike a misconfigured proxy's x-forwarded-host.
  const rawHost = req.headers.host;
  let host =
    rawHost !== undefined &&
    (FORWARDED_HOST_RE.test(rawHost) || FORWARDED_HOST_IPV6_RE.test(rawHost))
      ? rawHost
      : "localhost";
  if (fwdHost !== undefined) {
    if (FORWARDED_HOST_RE.test(fwdHost) || FORWARDED_HOST_IPV6_RE.test(fwdHost)) {
      host = fwdHost;
    } else {
      logger.warn(
        `x-forwarded-host value rejected, falling back to Host header: ${JSON.stringify(fwdHost.slice(0, 100))}`,
      );
    }
  }
  return `${proto}://${host}`;
}

/**
 * Query-string suffix embedding the request's testId into generated URLs
 * (polling_url, unsigned_urls). The @openrouter/sdk fetches these URLs with
 * standard Authorization but no aimock-specific headers (no x-test-id) — so
 * the testId must travel in the URL for getTestId's `?testId=` fallback to
 * resolve the right job scope. The default testId is omitted to keep
 * single-tenant URLs clean.
 */
function testIdSuffix(testId: string, sep: "?" | "&"): string {
  return testId === DEFAULT_TEST_ID ? "" : `${sep}testId=${encodeURIComponent(testId)}`;
}

/** Default upstream timeout for the live lifecycle proxy (matches recorder.ts). */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Abort signal for the SMALL-JSON upstream fetches on this surface (submit,
 * status poll, models listing), honoring `record.upstreamTimeoutMs` with the
 * same clamp conventions as recorder.ts (non-finite / non-positive values
 * fall back to the 30s default). Note the nuance (documented on
 * RecordConfig.upstreamTimeoutMs): these envelope-sized fetches use the value
 * as a TOTAL deadline via AbortSignal.timeout — indistinguishable from a
 * socket-idle timeout for small bodies. The byte-bearing content fetches use
 * `fetchHeadersWithTimeout` + `readBodyIdle` instead, which implement true
 * idle semantics. An abort rejects the fetch and surfaces through the
 * caller's existing failure path (502 proxy_error on submit/poll, models
 * synthesis fallback).
 */
function upstreamTimeoutSignal(record: RecordConfig | undefined): AbortSignal {
  return AbortSignal.timeout(clampTimeout(record?.upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS));
}

/**
 * Fetch a byte-bearing upstream URL with `record.upstreamTimeoutMs` gating
 * only the HEADERS: the abort timer is cleared the moment the response head
 * arrives, so a long — but steadily progressing — body download is never
 * killed by a total deadline. Body progress is governed separately by
 * `readBodyIdle` (between-chunk idle semantics).
 */
async function fetchHeadersWithTimeout(
  url: URL,
  headers: Record<string, string>,
  record: RecordConfig | undefined,
): Promise<Response> {
  const timeoutMs = clampTimeout(record?.upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Upstream response headers timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Buffer a fetch Response body with IDLE-based timeout semantics: a timer
 * clamped from `record.bodyTimeoutMs` (30s default — same clamp as
 * recorder.ts) is re-armed for every chunk, so a steadily-dripping body of
 * any total duration completes and only a silent mid-body stall rejects.
 * When `cap` > 0 the byte count is enforced DURING the read: on exceed the
 * stream is cancelled and `{ overCap: true }` is returned with NOTHING
 * oversized retained in memory — the cap is a memory guard as much as a
 * disk guard.
 */
async function readBodyIdle(
  res: Response,
  record: RecordConfig | undefined,
  cap = 0,
): Promise<{ overCap: false; buf: Buffer } | { overCap: true; bytesRead: number }> {
  const body = res.body;
  if (!body) return { overCap: false, buf: Buffer.alloc(0) };
  const idleMs = clampTimeout(record?.bodyTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      let idleTimer: NodeJS.Timeout | undefined;
      // A stream error landing AFTER the idle timeout has already won the
      // race must never become an unhandledRejection (process crash) — attach
      // a no-op rejection handler to the read promise BEFORE racing.
      // Promise.race subscribes to its inputs too, so this is deliberate
      // defense-in-depth pinning the invariant against a refactor that races
      // the read differently; the race below still observes the rejection
      // normally when the read loses first.
      const readPromise = reader.read();
      readPromise.catch(() => {});
      const result = await Promise.race([
        readPromise,
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new Error(`Upstream response body idle for ${idleMs}ms`)),
            idleMs,
          );
        }),
      ]).finally(() => clearTimeout(idleTimer));
      if (result.done) break;
      total += result.value.byteLength;
      if (cap > 0 && total > cap) {
        return { overCap: true, bytesRead: total };
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    // Idle expiry and the over-cap early return leave the stream open —
    // release it. After a normal completion this is a no-op.
    void reader.cancel().catch(() => {});
  }
  return { overCap: false, buf: Buffer.concat(chunks) };
}

/**
 * Cap on an upstream ERROR body (401/403 relays) buffered by the content
 * proxy. Error bodies are envelope-sized JSON in practice — 64 KB is generous
 * — and unlike the video bytes they are buffered in full before the relay, so
 * an unbounded read would be a memory hole on a hostile upstream.
 */
const OPENROUTER_VIDEO_ERROR_BODY_CAP = 64 * 1024;

/**
 * Cap on the small-JSON upstream envelope bodies (submit, status poll, models
 * listing) buffered before parse/relay. Envelopes are KB-scale in practice —
 * 1 MB is generous headroom even for a large models listing — and, like the
 * error-body cap above, they are buffered in full, so an unbounded `text()`
 * would be a memory hole on a hostile upstream.
 */
const OPENROUTER_VIDEO_ENVELOPE_BODY_CAP = 1024 * 1024;

/**
 * Bounded read of a small-JSON upstream envelope body (submit, status poll,
 * models listing): readBodyIdle's idle semantics plus the envelope cap. An
 * over-cap body is a hard failure — the throw surfaces through each caller's
 * existing failure path (502 proxy_error on submit/poll, models synthesis
 * fallback) without retaining anything oversized in memory.
 */
async function readEnvelopeText(res: Response, record: RecordConfig | undefined): Promise<string> {
  const read = await readBodyIdle(res, record, OPENROUTER_VIDEO_ENVELOPE_BODY_CAP);
  if (read.overCap) {
    throw new Error(
      `Upstream envelope body exceeded ${OPENROUTER_VIDEO_ENVELOPE_BODY_CAP} bytes (read aborted at ${read.bytesRead})`,
    );
  }
  return read.buf.toString("utf8");
}

/**
 * Rewrite an upstream poll body for relay to the client. Every field is
 * relayed verbatim EXCEPT the ones that would let the client escape the mock
 * or learn upstream identifiers:
 *   - `id` → the mock jobId;
 *   - a present `polling_url` → the mock's poll URL (testId embedded);
 *   - a present `unsigned_urls` array → an array of the SAME length whose
 *     element i is the mock content URL with `?index=i`. On post-capture
 *     REPLAYS the mock content endpoint serves the index-0 bytes for every
 *     index (only index 0 is captured); during the capture window and under
 *     proxyOnly the index selects the live-proxied upstream URL.
 * `usage` passes through untouched: a non-number `usage.cost` warns but is
 * never coerced or dropped, and no usage is ever invented.
 */
function rewriteRecordPollBody(args: {
  upstreamBody: Record<string, unknown>;
  job: OpenRouterVideoRecordJob;
  req: http.IncomingMessage;
  testId: string;
  logger: Logger;
}): Record<string, unknown> {
  const { upstreamBody, job, req, testId, logger } = args;
  const base = requestBase(req, logger);
  const body: Record<string, unknown> = { ...upstreamBody, id: job.jobId };
  if (upstreamBody.polling_url !== undefined) {
    body.polling_url = `${base}/api/v1/videos/${job.jobId}${testIdSuffix(testId, "?")}`;
  }
  if (Array.isArray(upstreamBody.unsigned_urls)) {
    body.unsigned_urls = upstreamBody.unsigned_urls.map(
      (_url, i) =>
        `${base}/api/v1/videos/${job.jobId}/content?index=${i}${testIdSuffix(testId, "&")}`,
    );
  } else if (upstreamBody.unsigned_urls !== undefined) {
    // A non-array unsigned_urls cannot be index-rewritten — relaying it
    // verbatim would leak the upstream value to the client, the exact escape
    // this rewrite exists to prevent. Strip it with a warn (the any-value
    // treatment polling_url gets above). Latched once per job (mirroring
    // emptyErrorWarned): a polling loop must not spam the warn.
    delete body.unsigned_urls;
    if (!job.nonArrayUrlsWarned) {
      job.nonArrayUrlsWarned = true;
      logger.warn(
        `Upstream video job ${job.upstreamJobId} reported a non-array unsigned_urls (${JSON.stringify(upstreamBody.unsigned_urls).slice(0, 100)}) — stripped from the relay`,
      );
    }
  }
  const usage = upstreamBody.usage;
  if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
    const cost = (usage as Record<string, unknown>).cost;
    if (cost !== undefined && typeof cost !== "number" && !job.badCostWarned) {
      job.badCostWarned = true;
      logger.warn(
        `Upstream video job ${job.upstreamJobId} reported a non-number usage.cost (${JSON.stringify(cost).slice(0, 50)}) — passing it through untouched`,
      );
    }
  }
  return body;
}

/**
 * Synthesizes a structurally valid journal body for field-validation 400s.
 * JournalEntry.body is typed `ChatCompletionRequest | null`, so the raw
 * parsed body cannot be journaled as-is — journal consumers may walk
 * `body.messages`. The result is ChatCompletionRequest-shaped: `model` is a
 * string (a non-string value is JSON-encoded so the field stays a string
 * without dropping what the caller sent) and `messages` is an empty array
 * (there is no validated prompt to wrap). Raw request fields (including
 * `prompt`) are preserved via the index signature only on this validation
 * path — the success path's syntheticReq is built from scratch and does not
 * carry them.
 */
function validationJournalBody(videoReq: OpenRouterVideoRequest): ChatCompletionRequest {
  const rawModel = videoReq.model;
  const model =
    typeof rawModel === "string"
      ? rawModel
      : rawModel === undefined
        ? ""
        : JSON.stringify(rawModel);
  // Underscore-prefixed keys (`_endpointType`, `_context`, ...) are reserved
  // for handler-set discriminators that journal consumers treat as trusted —
  // strip them from the raw client body so a request cannot spoof them.
  const sanitized = Object.fromEntries(
    Object.entries(videoReq).filter(([key]) => !key.startsWith("_")),
  );
  return { ...sanitized, model, messages: [] };
}

// ─── GET /api/v1/videos/{jobId} — status poll ───────────────────────────────

export async function handleOpenRouterVideoStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: OpenRouterVideoJobMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? `/api/v1/videos/${jobId}`;
  const method = req.method ?? "GET";

  // Chaos rolls BEFORE the job lookup, so it cannot know whether the poll
  // would have been proxied (record job) or served locally — the label stays
  // "internal" even in record mode, and a chaos-dropped poll never reaches
  // the upstream.
  if (
    applyChaos(
      res,
      null,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: null },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  const testId = getTestId(req);
  const job = jobs.get(`${testId}:${jobId}`);

  if (!job) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 404, fixture: null },
    });
    writeErrorResponse(
      res,
      404,
      JSON.stringify({ error: { message: `Video job ${jobId} not found`, code: 404 } }),
    );
    return;
  }

  if (job.kind === "record") {
    // Strict means nothing reaches an upstream — a record job's polls are
    // pure upstream proxies, so an effective-strict request is refused with
    // the strict 503 family (same gate as the models proxy; the submit-time
    // gate cannot help a job that was created under a strict-off override).
    if (resolveStrictMode(defaults.strict, req.headers)) {
      defaults.logger.error(
        `STRICT: video job ${jobId} is proxied live upstream (record mode) — refusing the upstream poll`,
      );
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        body: null,
        response: {
          status: 503,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
      });
      writeErrorResponse(
        res,
        503,
        JSON.stringify({
          error: {
            message: `Strict mode: video job ${jobId} is proxied live upstream (record mode) — nothing reaches an upstream under strict mode`,
            type: "invalid_request_error",
            code: "no_fixture_match",
          },
        }),
      );
      return;
    }
    await proxyOpenRouterVideoRecordPoll({
      req,
      res,
      job,
      key: `${testId}:${jobId}`,
      testId,
      fixtures,
      journal,
      defaults,
      jobs,
      method,
      path,
    });
    return;
  }

  // Guard BEFORE advancing or journaling (file convention): a client that
  // disconnected while the poll was queued gets neither a write nor a
  // journal entry — and consumes no progression step or TTL refresh, so the
  // next LIVE poll observes the state this one would have consumed.
  if (res.destroyed || res.writableEnded) return;
  advanceJob(job);
  // Refresh the TTL on every replay poll, mirroring the record-job proxy
  // path: the delete-before-set semantics also move the entry to the back of
  // the FIFO eviction order, so an actively-polled job survives both the TTL
  // and capacity pressure however long the client keeps polling.
  jobs.set(`${testId}:${jobId}`, job);
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null },
  });

  const body: Record<string, unknown> = { id: job.jobId, status: job.status };
  if (job.status === "completed") {
    body.unsigned_urls = [
      `${requestBase(req, defaults.logger)}/api/v1/videos/${job.jobId}/content?index=0${testIdSuffix(testId, "&")}`,
    ];
    body.usage = { cost: job.video.cost ?? 0 };
  } else if (job.status === "failed") {
    if (job.video.error === "" && !job.emptyErrorWarned) {
      // An explicit-but-empty error is an authoring mistake — warn (mirroring
      // the empty-b64 warn) instead of serving an empty failure reason. Once
      // per job: a polling loop on a failed job must not spam the warn.
      job.emptyErrorWarned = true;
      defaults.logger.warn(
        `Video fixture for job ${job.jobId} has an empty error message — using the default`,
      );
    }
    body.error = job.video.error || "Video generation failed";
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── GET /api/v1/videos/{jobId}/content — download ──────────────────────────

// Minimal valid-prefix MP4 placeholder served when a completed fixture has no
// `b64` payload: a bare 24-byte `ftyp` box (major brand isom, minor 0x200,
// compatible brands isom + mp42). Enough for clients that sniff the container
// signature without requiring real video bytes in every fixture.
const PLACEHOLDER_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
]);

// The `index` query param is accepted but ignored (jobs are single-video), and
// fetching content deliberately does NOT advance job state — clients only
// learn the content URL from a completed status poll (API fidelity; diverges
// from fal's advance-on-result queue semantics). Exception: a completed
// kind:"record" job — reachable under record.proxyOnly AND during the eager
// capture window — live-proxies the stored upstream unsigned_urls instead,
// honoring the index.
export async function handleOpenRouterVideoContent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: OpenRouterVideoJobMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? `/api/v1/videos/${jobId}/content`;
  const method = req.method ?? "GET";

  if (
    applyChaos(
      res,
      null,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: null },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  // The real endpoint requires Bearer auth even though the unsigned URL is
  // otherwise self-contained — the @openrouter/sdk fetches it with the key.
  // RFC 7235 auth schemes are case-insensitive; the credential must be
  // non-empty.
  const authorization = req.headers.authorization;
  if (!authorization || !/^bearer\s+\S/i.test(authorization)) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 401, fixture: null },
    });
    writeErrorResponse(
      res,
      401,
      JSON.stringify({ error: { message: "No auth credentials found", code: 401 } }),
    );
    return;
  }

  const testId = getTestId(req);
  const job = jobs.get(`${testId}:${jobId}`);

  if (!job) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 404, fixture: null },
    });
    writeErrorResponse(
      res,
      404,
      JSON.stringify({ error: { message: `Video job ${jobId} not found`, code: 404 } }),
    );
    return;
  }

  if (job.status !== "completed") {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: `Video job ${jobId} is not completed (status: ${job.status})`,
          code: 400,
        },
      }),
    );
    return;
  }

  const queryIdx = path.indexOf("?");
  const indexParam =
    queryIdx === -1 ? null : new URLSearchParams(path.slice(queryIdx + 1)).get("index");

  // A completed record job is reachable under record.proxyOnly (live proxy
  // forever) and during the capturing window (a concurrent poll relayed the
  // terminal body while the eager capture is still in flight). Live-proxy the
  // stored upstream URL in both cases (the bytes are never cached).
  if (job.kind === "record") {
    // Strict means nothing reaches an upstream — gate the live content proxy
    // exactly like the models proxy and the record-job poll path.
    if (resolveStrictMode(defaults.strict, req.headers)) {
      defaults.logger.error(
        `STRICT: video job ${jobId} content is proxied live upstream (record mode) — refusing the upstream fetch`,
      );
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        body: null,
        response: {
          status: 503,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
      });
      writeErrorResponse(
        res,
        503,
        JSON.stringify({
          error: {
            message: `Strict mode: video job ${jobId} is proxied live upstream (record mode) — nothing reaches an upstream under strict mode`,
            type: "invalid_request_error",
            code: "no_fixture_match",
          },
        }),
      );
      return;
    }
    await proxyOpenRouterVideoRecordContent({
      req,
      res,
      job,
      key: `${testId}:${jobId}`,
      indexParam,
      journal,
      defaults,
      jobs,
      method,
      path,
    });
    return;
  }

  // `index` is accepted but ignored (jobs are single-video) — warn when a
  // present value asks for anything other than index 0, since the caller is
  // silently getting index-0 bytes either way.
  if (indexParam !== null && Number(indexParam) !== 0) {
    defaults.logger.warn(
      `Video content request for job ${jobId} asked for index=${indexParam} — the index param is ignored (jobs are single-video); serving index 0`,
    );
  }

  let bytes: Buffer;
  if (job.video.b64) {
    bytes = Buffer.from(job.video.b64, "base64");
    // Node's base64 decoder is lenient — invalid characters are skipped and
    // the first "=" terminates the decode — so a corrupt payload silently
    // truncates instead of erroring. Compare the decoded byte count against
    // what the sanitized input length should yield (every 4 chars → 3 bytes,
    // floor for a partial final group) and warn on mismatch. Sanitization
    // mirrors the decoder: whitespace stripped, base64url normalized, and
    // everything from the first "=" on dropped (counting post-padding
    // characters as data chars would false-flag concatenated-but-valid
    // payloads like "QQ==QQ==", which Node decodes as just their first
    // group). A length check — rather than byte-exact re-encode equality —
    // tolerates valid non-canonical base64 whose final character carries
    // nonzero discarded trailing bits (e.g. "QR" re-encodes as "QQ") while
    // still catching skipped-character corruption. The decode is served as-is.
    const sanitized = job.video.b64
      .replace(/\s+/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/=.*$/, "");
    const expectedBytes = Math.floor((sanitized.length * 3) / 4);
    if (bytes.length === 0 && !job.contentWarnsLatched) {
      // Padding-only payloads (e.g. "=", "====") are truthy but sanitize to
      // "" and decode to 0 bytes — dodging both the empty-string warn and
      // the length-mismatch check below. Warn whenever a non-empty b64
      // decodes to nothing; the zero-byte body is still served as-is.
      defaults.logger.warn(
        `Video fixture b64 for job ${jobId} decoded to zero bytes — the fixture is not controlling the served content`,
      );
    }
    if (sanitized.length % 4 === 1) {
      // A length ≡ 1 (mod 4) is base64 the mismatch check cannot catch: the
      // floor formula agrees with Node's lenient decode whether the payload
      // is genuinely truncated or merely contains invalid characters the
      // sanitizer does not strip (e.g. "AAAA!" decodes fully).
      if (!job.contentWarnsLatched) {
        defaults.logger.warn(
          `Video fixture b64 for job ${jobId} has length ≡ 1 (mod 4) after sanitization (${sanitized.length} chars) — payload is malformed or contains invalid characters`,
        );
      }
    } else if (bytes.length !== expectedBytes && !job.contentWarnsLatched) {
      defaults.logger.warn(
        `Video fixture b64 for job ${jobId} decoded to ${bytes.length} bytes where its length implies ${expectedBytes} — likely corrupt base64`,
      );
    }
  } else {
    if (job.video.b64 === "" && !job.contentWarnsLatched) {
      // An explicit-but-empty b64 is indistinguishable from an absent one to
      // the truthiness check above — warn so the author learns the fixture
      // is not controlling the served bytes.
      defaults.logger.warn(
        `Video fixture for job ${jobId} has an empty b64 — serving the placeholder MP4`,
      );
    }
    if (job.video.url && !job.contentWarnsLatched) {
      // Every other coercion on this surface warns — so does dropping the
      // author's url. The real OpenRouter content endpoint serves bytes, not
      // a redirect, so the mock has nothing to do with a url-only fixture.
      defaults.logger.warn(
        `Video fixture for job ${jobId} sets video.url but no b64 — url is ignored on the OpenRouter content endpoint; use b64 to control the served bytes (serving the placeholder MP4)`,
      );
    }
    bytes = PLACEHOLDER_MP4;
  }
  // Latch the fixture-defect warns above once per job: video is immutable
  // after submit, so re-downloads would only repeat the identical warn set.
  job.contentWarnsLatched = true;

  // Guard BEFORE journaling (file convention): a client that disconnected
  // before the write gets neither a response nor a journal entry.
  if (res.destroyed || res.writableEnded) return;
  // Refresh the TTL on a successful serve, mirroring the replay poll path: a
  // client stepping through downloads (or re-fetching) keeps the job alive
  // however long the session runs. delete-before-set (jobs.set) also moves
  // the entry to the back of the FIFO eviction order.
  jobs.set(`${testId}:${jobId}`, job);
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null },
  });

  // Always video/mp4 — the real endpoint serves video/mp4 even when the
  // client (e.g. the Speakeasy-generated @openrouter/sdk) sends
  // Accept: application/octet-stream.
  res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
  res.end(bytes);
}

/**
 * Live-proxy a content download for a completed record job — reachable under
 * proxyOnly (forever) and during the eager-capture window: the stored
 * upstream `unsigned_urls[index || 0]` is fetched with the same same-origin
 * Bearer-forwarding gate as the eager-capture path (headers gated by
 * `upstreamTimeoutMs`, body by `bodyTimeoutMs` idle semantics), and the bytes
 * are STREAMED to the client as `video/mp4` (matching the real API regardless
 * of the upstream's content-type) — chunks are relayed as they arrive, so the
 * whole video is never buffered in memory. An upstream 401/403 passes through
 * verbatim (real-API fidelity); other pre-relay failures 502 (a mid-stream
 * stall can only abort the already-committed 200). No state is mutated and
 * nothing is cached — repeated downloads hit the upstream every time.
 * Journaled source:"proxy" when the relay commits. Refuses with 502 before
 * contacting the upstream when record mode was disabled mid-flight. A
 * committed relay refreshes the job's TTL (identity-guarded) — a client
 * working through a long download list must not lose the job mid-way.
 */
async function proxyOpenRouterVideoRecordContent(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  job: OpenRouterVideoRecordJob;
  key: string;
  indexParam: string | null;
  journal: Journal;
  defaults: HandlerDefaults;
  jobs: OpenRouterVideoJobMap;
  method: string;
  path: string;
}): Promise<void> {
  const { req, res, job, key, indexParam, journal, defaults, jobs, method, path } = args;
  const logger = defaults.logger;

  const proxyError = (msg: string): void => {
    logger.error(`OpenRouter video content proxy failed: ${msg}`);
    // Guard BEFORE journaling (file convention): a disconnected client gets
    // neither a write nor a journal entry.
    if (res.destroyed || res.writableEnded) return;
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: {
        status: 502,
        fixture: null,
        source: "proxy",
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      502,
      JSON.stringify({
        error: { message: `Proxy to upstream failed: ${msg}`, type: "proxy_error" },
      }),
    );
  };

  // Recording can be disabled mid-flight (LLMock.disableRecording) — an
  // orphaned record job must fail loudly BEFORE contacting the upstream
  // (and before forwarding the client's Bearer anywhere), mirroring the
  // record-job poll gate. The snapshot below is used for every later read
  // (same discipline as the poll path): the gate and its consumers must see
  // ONE config object even if the defaults are swapped mid-relay.
  const record = defaults.record;
  if (!record) {
    proxyError("record mode is no longer configured for an in-flight record job");
    return;
  }

  const urls = job.upstreamUnsignedUrls ?? [];
  const parsedIndex = indexParam === null ? 0 : Number(indexParam);
  const index = Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0;
  if (indexParam !== null && index !== parsedIndex) {
    // Mirror the replay path's warn convention: a coerced index silently
    // changes which bytes the caller gets.
    logger.warn(
      `Video content request for job ${job.jobId} has an unusable index=${indexParam} — serving index 0`,
    );
  }
  // The stored array is UNFILTERED (positions align with the rewritten relay
  // indexes), so the addressed entry may be a non-string — skip unusable
  // entries at use time, warning before the index-0 fallback.
  const addressed = urls[index];
  let target = typeof addressed === "string" && addressed ? addressed : undefined;
  if (target === undefined && index !== 0) {
    // Two distinct upstream defects share this fallback — name the right one:
    // an index past the array is the CLIENT asking for more videos than the
    // upstream reported, while an in-range-but-unusable entry is the UPSTREAM
    // having reported a non-string/empty URL at that position.
    if (index >= urls.length) {
      logger.warn(
        `Video content request for job ${job.jobId} asked for index=${index} but the upstream reported only ${urls.length} unsigned_urls — serving index 0`,
      );
    } else {
      logger.warn(
        `Video content request for job ${job.jobId} asked for index=${index} but the upstream's unsigned_urls[${index}] is unusable (non-string or empty) — serving index 0`,
      );
    }
    const first = urls[0];
    target = typeof first === "string" && first ? first : undefined;
  }
  if (!target) {
    // Name the actual condition: an empty array is the upstream reporting no
    // URLs at all, while a non-empty array whose entry 0 is unusable is a
    // different upstream defect (the index>0 warns above draw the same line).
    proxyError(
      urls.length === 0
        ? `Upstream job ${job.upstreamJobId} completed without usable unsigned_urls`
        : `Upstream job ${job.upstreamJobId} completed but its unsigned_urls[0] is unusable (non-string or empty)`,
    );
    return;
  }

  let contentUrl: URL;
  try {
    contentUrl = new URL(target);
  } catch {
    proxyError(`Upstream unsigned_urls[${index}] is not a valid URL (${target.slice(0, 100)})`);
    return;
  }

  // The client's Bearer is forwarded ONLY to the configured provider origin —
  // the same gate as the eager-capture path.
  const providerBase = record.providers.openrouter;
  let providerOrigin: string;
  try {
    providerOrigin = new URL(providerBase ?? job.upstreamPollingUrl).origin;
  } catch {
    try {
      providerOrigin = new URL(job.upstreamPollingUrl).origin;
    } catch {
      proxyError(
        `Cannot determine the provider origin (invalid provider URL and polling URL) — refusing to forward credentials`,
      );
      return;
    }
  }
  const headers = buildForwardHeaders(req);
  if (contentUrl.origin !== providerOrigin) {
    delete headers.authorization;
    logger.warn(
      `Upstream unsigned_urls[${index}] origin ${contentUrl.origin} differs from the provider origin ${providerOrigin} — fetching content WITHOUT the client's Authorization header`,
    );
  }

  // Headers gated by upstreamTimeoutMs, body by bodyTimeoutMs IDLE semantics
  // — a steadily-downloading large video must never be killed by a total
  // deadline (see fetchHeadersWithTimeout).
  let contentRes: Response;
  try {
    contentRes = await fetchHeadersWithTimeout(contentUrl, headers, record);
  } catch (err) {
    proxyError(err instanceof Error ? err.message : "Unknown proxy error");
    return;
  }
  if (contentRes.status === 401 || contentRes.status === 403) {
    // Real-API fidelity: an upstream auth rejection is the client's
    // problem (bad or expired Bearer) — relay the upstream status and body
    // instead of wrapping them in a generic 502 proxy_error. The body read
    // is bounded like every other upstream body on this surface (the header
    // timer was cleared when the head arrived, so a bare arrayBuffer() here
    // could hang forever): idle semantics from `record.bodyTimeoutMs` plus a
    // small hard cap. Documented choices — a mid-body STALL 502s (the
    // upstream status cannot be relayed faithfully without its body), while
    // an OVER-CAP body relays the upstream status with an empty body
    // (status fidelity preserved; an error body past 64 KB is pathological).
    let errBody: Buffer;
    try {
      const read = await readBodyIdle(contentRes, record, OPENROUTER_VIDEO_ERROR_BODY_CAP);
      if (read.overCap) {
        logger.warn(
          `Upstream ${contentRes.status} error body for job ${job.upstreamJobId} exceeded ${OPENROUTER_VIDEO_ERROR_BODY_CAP} bytes — relaying the status with an empty body`,
        );
        errBody = Buffer.alloc(0);
      } else {
        errBody = read.buf;
      }
    } catch (err) {
      proxyError(err instanceof Error ? err.message : "Unknown proxy error");
      return;
    }
    logger.warn(
      `Upstream content host rejected the download for job ${job.upstreamJobId} (${contentRes.status}) — relaying the upstream status`,
    );
    if (res.destroyed || res.writableEnded) return;
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: {
        status: contentRes.status,
        fixture: null,
        source: "proxy",
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    res.writeHead(contentRes.status, {
      "Content-Type": contentRes.headers.get("content-type") ?? "application/json",
    });
    res.end(errBody);
    return;
  }
  if (!contentRes.ok) {
    // Include a bounded body sample so the failure is diagnosable (every
    // other proxy error on this surface carries a body snippet). Bounded
    // exactly like the 401/403 relay above: idle semantics + the error cap.
    let sample = "";
    try {
      const read = await readBodyIdle(contentRes, record, OPENROUTER_VIDEO_ERROR_BODY_CAP);
      if (!read.overCap) sample = read.buf.toString("utf8").slice(0, 200);
    } catch {
      // Body unreadable — the status alone still names the failure.
    }
    proxyError(`Content ${contentRes.status}${sample ? `: ${sample}` : ""}`);
    return;
  }

  // Guard BEFORE journaling: a client that disconnected mid-fetch gets
  // neither a write nor a journal entry — the journaled 200 must reflect a
  // response that actually left.
  if (res.destroyed || res.writableEnded) {
    void contentRes.body?.cancel().catch(() => {});
    return;
  }
  // Journal when the relay COMMITS (the status line is about to hit the
  // wire), then STREAM the body chunk-by-chunk: the whole video is never
  // buffered in memory and the first bytes reach the client while the
  // upstream is still sending. Journal-accuracy choice: a mid-stream abort
  // (upstream stall / client disconnect) still happened as a 200 on the wire
  // — just truncated — so journaling at commit time stays accurate to what
  // left, whereas journaling only on completion would drop truncated relays
  // entirely. Aborts are additionally logged below.
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: {
      status: 200,
      fixture: null,
      source: "proxy",
      ...strictOverrideField(defaults.strict, req.headers),
    },
  });
  // TTL refresh at commit time, identity-guarded like every post-await map
  // touch: an actively-downloading job must not be evicted between fetches.
  if (jobs.get(key) === job) {
    jobs.set(key, job);
  }
  // Always video/mp4 — matching both the real API and the replay path above.
  // No Content-Length: the bytes are relayed as they arrive (chunked).
  res.writeHead(200, { "Content-Type": "video/mp4" });

  const body = contentRes.body;
  if (!body) {
    res.end();
    return;
  }
  // Same IDLE semantics as readBodyIdle: the timer is re-armed per chunk, so
  // a steadily-dripping body of any total duration completes and only a
  // silent mid-body stall aborts.
  const idleMs = clampTimeout(record.bodyTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS);
  const reader = body.getReader();
  try {
    for (;;) {
      let idleTimer: NodeJS.Timeout | undefined;
      // Same orphaned-read hygiene as readBodyIdle: a stream error landing
      // after the idle timeout won the race must never become an
      // unhandledRejection (see the readBodyIdle comment for the full
      // reasoning — deliberate defense-in-depth).
      const readPromise = reader.read();
      readPromise.catch(() => {});
      const result = await Promise.race([
        readPromise,
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new Error(`Upstream response body idle for ${idleMs}ms`)),
            idleMs,
          );
        }),
      ]).finally(() => clearTimeout(idleTimer));
      if (result.done) break;
      if (res.destroyed) return; // client went away mid-stream — stop relaying
      if (!res.write(Buffer.from(result.value))) {
        // Backpressure: wait for drain, bailing on close so a client that
        // disconnects mid-stall cannot wedge the relay — and BOUND the wait
        // with the same clamped bodyTimeoutMs: a stalled-OPEN client (socket
        // alive, never reading) would otherwise wedge the relay and pin the
        // upstream reader forever.
        const drained = await new Promise<boolean>((resolve) => {
          const cleanup = (): void => {
            res.off("drain", onDrain);
            res.off("close", onClose);
            clearTimeout(drainTimer);
          };
          const onDrain = (): void => {
            cleanup();
            resolve(true);
          };
          const onClose = (): void => {
            cleanup();
            // The loop's res.destroyed check stops the relay — though the
            // upstream reader's release can lag by up to one idle period
            // (the next read must resolve or idle-expire before the
            // destroyed check runs).
            resolve(true);
          };
          const drainTimer = setTimeout(() => {
            cleanup();
            resolve(false);
          }, idleMs);
          res.once("drain", onDrain);
          res.once("close", onClose);
        });
        if (!drained) {
          logger.warn(
            `OpenRouter video content relay for job ${job.upstreamJobId} aborted: the client stopped reading for ${idleMs}ms — destroying the response and releasing the upstream`,
          );
          res.destroy(); // the finally below releases the upstream reader
          return;
        }
      }
    }
    res.end();
  } catch (err) {
    // The headers are already on the wire — a 502 is no longer possible.
    // Destroy the response so the client observes a truncated transfer
    // instead of a hang, and log the abort (the journaled 200 stands: a 200
    // status line did leave — see the journal-accuracy note above).
    logger.error(
      `OpenRouter video content relay aborted mid-stream: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.destroy();
  } finally {
    // Stall abort and the client-gone return leave the stream open — release
    // it. After a normal completion this is a no-op.
    void reader.cancel().catch(() => {});
  }
}

// ─── GET /api/v1/videos/models — model listing ──────────────────────────────

const DEFAULT_OPENROUTER_VIDEO_MODELS = [DEFAULT_OPENROUTER_VIDEO_MODEL, "openai/sora-2"];

function modelEntry(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    supported_durations: [4, 8],
    supported_resolutions: ["720p", "1080p"],
    supported_aspect_ratios: ["16:9", "9:16", "1:1"],
    supported_frame_images: [],
    supported_sizes: [],
    generate_audio: false,
    seed: true,
    pricing_skus: [],
  };
}

/**
 * Synthesizes the OpenRouter video model listing from loaded fixtures —
 * video-endpoint fixtures with a string `match.model` (mirrors the Ollama
 * `/api/tags` synthesis in server.ts). Falls back to a default model set when
 * no video fixtures are loaded. Note video models do not appear in the plain
 * `/api/v1/models` listing on the real API, hence the dedicated route.
 *
 * With `record.providers.openrouter` configured the listing is proxied
 * upstream instead and relayed verbatim on success (journaled
 * source:"proxy", never recorded as a fixture); an upstream failure warns
 * and falls back to the synthesis below. Strict mode disables the proxy —
 * a strict request is always served the synthesized listing (strict means
 * "nothing reaches an upstream").
 */
export async function handleOpenRouterVideoModels(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? "/api/v1/videos/models";
  const method = req.method ?? "GET";

  if (
    applyChaos(
      res,
      null,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: null },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  // Snapshot (file discipline): the gate and its consumers below must see ONE
  // config object even if the defaults are swapped mid-request.
  const record = defaults.record;
  const upstreamBase = record?.providers.openrouter;
  let proxyAttemptFailed = false;
  if (upstreamBase && !resolveStrictMode(defaults.strict, req.headers)) {
    // The try covers ONLY the upstream fetch: a throw from the journal/relay
    // writes below must not be misattributed to the upstream (it would warn
    // "proxy failed", double-journal, and attempt a second response via the
    // synthesis fallback).
    let relay: { text: string; contentType: string } | undefined;
    try {
      const target = resolveUpstreamUrl(upstreamBase, "/api/v1/videos/models");
      const upstreamRes = await fetch(target, {
        headers: buildForwardHeaders(req),
        signal: upstreamTimeoutSignal(record),
      });
      const text = await readEnvelopeText(upstreamRes, record);
      if (!upstreamRes.ok) {
        throw new Error(`Models ${upstreamRes.status}: ${text.slice(0, 200)}`);
      }
      relay = {
        text,
        contentType: upstreamRes.headers.get("content-type") ?? "application/json",
      };
    } catch (err) {
      proxyAttemptFailed = true;
      const msg = err instanceof Error ? err.message : "Unknown proxy error";
      defaults.logger.warn(
        `OpenRouter video models proxy failed (${msg}) — falling back to the synthesized listing`,
      );
    }
    if (relay) {
      // Guard BEFORE journaling (file convention): a client that
      // disconnected while the upstream fetch was in flight gets neither a
      // write nor a journal entry — and never the synthesis fallback.
      if (res.destroyed || res.writableEnded) return;
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        body: null,
        // strictOverrideField on every journaled response (the file-wide
        // convention — proxied entries included): a proxied path is reachable
        // with a strict-ON server default only via a per-request strict-OFF
        // override, which journal consumers must see.
        response: {
          status: 200,
          fixture: null,
          source: "proxy",
          ...strictOverrideField(defaults.strict, req.headers),
        },
      });
      // Verbatim relay — listings are metadata, never recorded as fixtures.
      res.writeHead(200, { "Content-Type": relay.contentType });
      res.end(relay.text);
      return;
    }
  }

  const modelIds = new Set<string>();
  let sawVideoFixture = false;
  for (const f of fixtures) {
    if (f.match.endpoint === "video") {
      sawVideoFixture = true;
      if (f.match.model && typeof f.match.model === "string") {
        modelIds.add(f.match.model);
      }
    }
  }
  if (modelIds.size === 0 && sawVideoFixture) {
    // Video fixtures are loaded but none has a string match.model (e.g. all
    // RegExp models or onVideo registrations) — the listing silently serves
    // the default set, which can surprise fixture authors.
    defaults.logger.warn(
      "No video fixture contributes a string model — serving the default video model set",
    );
  }
  const ids = modelIds.size > 0 ? [...modelIds] : DEFAULT_OPENROUTER_VIDEO_MODELS;

  // Guard BEFORE journaling (file convention): the synthesis is reachable
  // after an AWAITED-but-failed proxy attempt above, so the client may have
  // disconnected while that fetch was in flight — it gets neither a write
  // nor a journal entry.
  if (res.destroyed || res.writableEnded) return;
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    // A synthesis serving as the fallback for a FAILED proxy attempt is
    // labeled source:"internal" so journal consumers can tell it apart from
    // a relay that actually came from the upstream. A synthesis whose proxy
    // was never attempted — strict-suppressed or plain no-record — omits
    // source (the surface's existing convention); a strict override that
    // suppressed the proxy is surfaced via strictOverrideField like every
    // other strict-influenced journal entry on this surface.
    response: {
      status: 200,
      fixture: null,
      ...(proxyAttemptFailed ? { source: "internal" as const } : {}),
      ...strictOverrideField(defaults.strict, req.headers),
    },
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: ids.map((id) => modelEntry(id)) }));
}

// ─── POST /api/v1/videos — submit ───────────────────────────────────────────

export async function handleOpenRouterVideoCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: OpenRouterVideoJobMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? "/api/v1/videos";
  const method = req.method ?? "POST";

  let videoReq: OpenRouterVideoRequest;
  try {
    videoReq = JSON.parse(raw) as OpenRouterVideoRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: `Malformed JSON: ${detail}`,
          type: "invalid_request_error",
          code: "invalid_json",
        },
      }),
    );
    return;
  }

  // Reject bodies that parsed but are not a JSON object (null, arrays,
  // numbers, strings) before touching any fields — mirrors fal's parseBody
  // guard so callers get a 400 instead of a raw TypeError 500.
  if (videoReq === null || typeof videoReq !== "object" || Array.isArray(videoReq)) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Request body must be a JSON object",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Field-validation 400s journal the parsed body (unlike the malformed-JSON
  // and non-object paths above, where there is no meaningful object to log).
  const parsedBody = validationJournalBody(videoReq);

  if (typeof videoReq.prompt !== "string" || !videoReq.prompt) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: parsedBody,
      response: { status: 400, fixture: null },
    });
    // Distinguish an absent prompt from one that is present but unusable
    // (non-string or empty) — "missing" would be wrong for the latter. The
    // invalid-type message mirrors the model check below.
    const message =
      videoReq.prompt === undefined
        ? "Missing required parameter: 'prompt'"
        : "Invalid type for parameter: 'prompt' must be a non-empty string";
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: { message, type: "invalid_request_error" },
      }),
    );
    return;
  }

  // An empty-string model is as unusable as a non-string one — it matches no
  // fixture and is not a real model id — so both get the same 400.
  if (videoReq.model !== undefined && (typeof videoReq.model !== "string" || !videoReq.model)) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: parsedBody,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Invalid type for parameter: 'model' must be a non-empty string",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const syntheticReq: ChatCompletionRequest = {
    // Model-less submits assume the default model — a fixture restricted to
    // DEFAULT_OPENROUTER_VIDEO_MODEL will match them.
    model: videoReq.model ?? DEFAULT_OPENROUTER_VIDEO_MODEL,
    messages: [{ role: "user", content: videoReq.prompt }],
    _endpointType: "video",
    _context: getContext(req),
  };

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    syntheticReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    // Match count increments BEFORE applyChaos below by design (mirrors
    // handleCompletions): a chaos-dropped submit still consumes the fixture's
    // sequence slot.
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    defaults.logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    const snippet = videoReq.prompt.slice(0, 80);
    defaults.logger.debug(
      `No fixture matched for request (model=${syntheticReq.model}, msg="${snippet}")`,
    );
  }

  // Chaos deliberately rolls AFTER body validation and fixture matching
  // (mirrors handleCompletions) — unlike the GET endpoints above, where chaos
  // rolls first. Divergence from the generic record path (server.ts):
  // EVERY firing chaos action here suppresses the would-be proxy entirely —
  // the submit never reaches the upstream and nothing is recorded. On the
  // generic path that is true only for drop/disconnect; a chaos "malformed"
  // there still proxies upstream and swaps the relay body via the
  // beforeWriteResponse hook (the fixture records what upstream really
  // said), whereas here "malformed" synthesizes a mock body with no
  // upstream contact. The roll is still LABELED "proxy" below because that
  // is what the request would have been had chaos not fired.
  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      // An unmatched submit is proxied upstream when record mode has an
      // openrouter provider configured AND strict would not win (strict 503s
      // before any proxy attempt) — label that chaos roll "proxy". A strict
      // no-match, or no record/provider, is served internally.
      fixture
        ? "fixture"
        : resolveStrictMode(defaults.strict, req.headers)
          ? "internal"
          : defaults.record?.providers.openrouter
            ? "proxy"
            : "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    // Strict mode wins over record: a strict no-match must fail loudly with
    // 503 rather than silently recording a new fixture.
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    if (effectiveStrict) {
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      defaults.logger.error(strictNoMatchLogLine(method, path, skippedBySequenceOrTurn));
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: {
          status: 503,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
      });
      writeErrorResponse(
        res,
        503,
        JSON.stringify({
          error: {
            message: strictMessage,
            type: "invalid_request_error",
            code: "no_fixture_match",
          },
        }),
      );
      return;
    }

    if (defaults.record) {
      const outcome = await proxyOpenRouterVideoSubmit({
        req,
        res,
        raw,
        syntheticReq,
        record: defaults.record,
        journal,
        defaults,
        jobs,
        method,
        path,
      });
      if (outcome === "handled") return;
      // outcome === "no_upstream" — fall through to 404 (fal convention).
    }

    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      404,
      JSON.stringify({ error: { message: "No fixture matched", code: 404 } }),
    );
    return;
  }

  // World-generation snapshot (mirrors the record-submit guard): a fixtures
  // reset can land while the fixture's ResponseFactory below is awaited, and
  // the job insertion at the bottom must not seed the NEW world with this
  // pre-reset submit's job.
  const worldGeneration = jobs.generation;
  const response = await resolveResponse(fixture, syntheticReq);

  // Guards BEFORE journaling on every branch below (file convention):
  // resolveResponse awaits the fixture's ResponseFactory, which can be
  // arbitrarily slow — a client that disconnected meanwhile gets neither a
  // write nor a journal entry.
  if (isErrorResponse(response)) {
    if (res.destroyed || res.writableEnded) return;
    const status = response.status ?? 500;
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, serializeErrorResponse(response), {
      retryAfter: response.retryAfter,
    });
    return;
  }

  if (!isVideoResponse(response)) {
    if (res.destroyed || res.writableEnded) return;
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    writeErrorResponse(
      res,
      500,
      JSON.stringify({
        error: { message: "Fixture response is not a video type", type: "server_error" },
      }),
    );
    return;
  }

  if (res.destroyed || res.writableEnded) return;
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture },
  });

  // A fixture authored with any non-terminal status — "processing" or a
  // status outside the union entirely (JSON fixtures bypass the compile-time
  // check) — has no terminal state to converge on; terminalStatus coerces it
  // to completed. Keep the behavior (jobs always terminate) but surface the
  // coercion. Widen to string first: the runtime value may not be in the union.
  const fixtureStatus: string = response.video.status;
  if (fixtureStatus === "processing") {
    defaults.logger.warn(
      `Video fixture has status "processing" — treated as completed for /api/v1/videos jobs`,
    );
  } else if (fixtureStatus !== "completed" && fixtureStatus !== "failed") {
    defaults.logger.warn(
      `Video fixture has unknown status "${fixtureStatus}" — treating as completed for /api/v1/videos jobs`,
    );
  }

  const jobId = crypto.randomUUID();
  const progression = resolveProgression(defaults.openRouterVideo);
  const job: OpenRouterVideoReplayJob = {
    kind: "replay",
    jobId,
    status: "pending",
    pollCount: 0,
    pollsBeforeInProgress: progression.pollsBeforeInProgress,
    pollsBeforeCompleted: progression.pollsBeforeCompleted,
    // Shallow-copy so later mutation of the fixture/factory response object
    // cannot retroactively change an in-flight job's stored video.
    video: { ...response.video },
  };
  // Default 0/0 progression seeds the job terminal at submit (mirrors fal's
  // COMPLETED-on-submit initial status) — content is downloadable with zero
  // polls; the first poll merely reports the already-terminal status. The
  // submit envelope still reports "pending" like the real API.
  if (progression.pollsBeforeCompleted === 0) {
    job.status = terminalStatus(job);
  }
  if (jobs.generation === worldGeneration) {
    jobs.set(`${testId}:${jobId}`, job);
  } else {
    // A fixtures reset landed while the ResponseFactory was awaited — the
    // world this submit belongs to is gone. Mirror the record-submit guard:
    // skip the insertion but still relay the envelope below (the client's
    // polls will 404, the same observable outcome as TTL eviction — warned
    // here so the 404s are attributable).
    defaults.logger.warn(
      `OpenRouter video submit resolved after a fixtures reset — not inserting job ${jobId} into the new world (its polls will 404)`,
    );
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: jobId,
      polling_url: `${requestBase(req, defaults.logger)}/api/v1/videos/${jobId}${testIdSuffix(testId, "?")}`,
      status: "pending",
    }),
  );
}

// ─── Record mode: live interactive proxy (submit) ───────────────────────────

const OPENROUTER_VIDEOS_PATH = "/api/v1/videos";

/**
 * Proxy an unmatched video submit to the configured OpenRouter upstream and
 * answer the client with a mock-rewritten envelope: a fresh aimock jobId and
 * a polling_url pointing back at the mock (testId embedded). The upstream
 * lifecycle is then driven interactively by the client's own polls — unlike
 * fal's synchronous queue walk, nothing is polled server-side at submit.
 *
 * Returns "no_upstream" when record mode has no openrouter provider URL —
 * the caller falls through to its 404 branch (fal convention).
 */
async function proxyOpenRouterVideoSubmit(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  raw: string;
  syntheticReq: ChatCompletionRequest;
  record: RecordConfig;
  journal: Journal;
  defaults: HandlerDefaults;
  jobs: OpenRouterVideoJobMap;
  method: string;
  path: string;
}): Promise<"handled" | "no_upstream"> {
  const { req, res, raw, syntheticReq, record, journal, defaults, jobs, method, path } = args;

  const upstreamBase = record.providers.openrouter;
  if (!upstreamBase) {
    defaults.logger.warn(`No upstream URL configured for provider "openrouter" — cannot proxy`);
    return "no_upstream";
  }

  const proxyError = (msg: string): "handled" => {
    defaults.logger.error(`OpenRouter video submit proxy failed: ${msg}`);
    // Guard BEFORE journaling (file convention): a disconnected client gets
    // neither a write nor a journal entry.
    if (res.destroyed || res.writableEnded) return "handled";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: 502,
        fixture: null,
        source: "proxy",
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      502,
      JSON.stringify({
        error: { message: `Proxy to upstream failed: ${msg}`, type: "proxy_error" },
      }),
    );
    return "handled";
  };

  let submitUrl: URL;
  let upstreamOrigin: string;
  try {
    submitUrl = resolveUpstreamUrl(upstreamBase, OPENROUTER_VIDEOS_PATH);
    upstreamOrigin = new URL(upstreamBase).origin;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return proxyError(`Invalid upstream URL: ${upstreamBase} (${msg})`);
  }

  defaults.logger.warn(
    `NO FIXTURE MATCH — proxying video submit to ${upstreamBase}${OPENROUTER_VIDEOS_PATH}`,
  );

  // World-generation snapshot: a fixtures reset landing during the upstream
  // fetch below clears the job map — the insertion guard after the fetch
  // compares against this value (identity checks cannot help here: the job
  // has not been inserted yet).
  const worldGeneration = jobs.generation;

  let fetched: { status: number; contentType: string | null; text: string };
  try {
    const upstreamRes = await fetch(submitUrl, {
      method: "POST",
      headers: buildForwardHeaders(req),
      body: raw,
      signal: upstreamTimeoutSignal(record),
    });
    fetched = {
      status: upstreamRes.status,
      contentType: upstreamRes.headers.get("content-type"),
      text: await readEnvelopeText(upstreamRes, record),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown proxy error";
    return proxyError(msg);
  }

  if (fetched.status === 401 || fetched.status === 403) {
    // Real-API fidelity (mirrors the poll and content paths): an upstream
    // auth rejection is the client's problem (bad or expired Bearer) — relay
    // the upstream status and body verbatim instead of wrapping them in a
    // generic 502 proxy_error. No job is created; a retried submit with
    // fixed credentials proxies again.
    defaults.logger.warn(
      `Upstream rejected the video submit (${fetched.status}) — relaying the upstream status`,
    );
    if (res.destroyed || res.writableEnded) return "handled";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: fetched.status,
        fixture: null,
        source: "proxy",
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    res.writeHead(fetched.status, {
      "Content-Type": fetched.contentType ?? "application/json",
    });
    res.end(fetched.text);
    return "handled";
  }

  let upstreamJobId: string;
  let envelope: Record<string, unknown>;
  {
    if (fetched.status < 200 || fetched.status >= 300) {
      return proxyError(`Submit ${fetched.status}: ${fetched.text.slice(0, 200)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fetched.text);
    } catch {
      return proxyError(`Submit returned non-JSON: ${fetched.text.slice(0, 200)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return proxyError("Submit response is not a JSON object");
    }
    envelope = parsed as Record<string, unknown>;
    upstreamJobId = String(envelope.id ?? "").trim();
    if (!upstreamJobId) {
      return proxyError("Submit response missing id");
    }
  }

  // Origin-validate upstream's polling_url before adopting it: every client
  // poll forwards the client's Authorization header to this URL, so an
  // envelope nominating a foreign host must not receive it. Off-origin (or
  // missing/unparseable) polling_urls fall back to the constructed path on
  // the configured provider origin.
  let upstreamPollingUrl = resolveUpstreamUrl(
    upstreamBase,
    `${OPENROUTER_VIDEOS_PATH}/${encodeURIComponent(upstreamJobId)}`,
  ).toString();
  const envPolling = envelope.polling_url;
  if (typeof envPolling === "string" && envPolling) {
    try {
      const parsedPolling = new URL(envPolling);
      if (parsedPolling.origin === upstreamOrigin) {
        upstreamPollingUrl = parsedPolling.toString();
      } else {
        defaults.logger.warn(
          `Upstream polling_url origin ${parsedPolling.origin} differs from the configured provider origin ${upstreamOrigin} — using the constructed poll URL instead`,
        );
      }
    } catch {
      defaults.logger.warn(
        `Upstream polling_url is not a valid URL (${String(envPolling).slice(0, 100)}) — using the constructed poll URL instead`,
      );
    }
  }

  const testId = getTestId(req);
  const matchRequest = defaults.requestTransform
    ? defaults.requestTransform(syntheticReq)
    : syntheticReq;
  const jobId = crypto.randomUUID();
  const job: OpenRouterVideoRecordJob = {
    kind: "record",
    jobId,
    status: "pending",
    upstreamJobId,
    upstreamPollingUrl,
    match: buildFixtureMatch(matchRequest, record),
  };
  if (jobs.generation === worldGeneration) {
    jobs.set(`${testId}:${jobId}`, job);
  } else {
    // A fixtures reset landed while the upstream submit was in flight — the
    // world this submit belongs to is gone. Seeding the NEW world with a
    // stale record job would resurrect pre-reset state, so skip the
    // insertion but still relay the envelope below (the client's polls will
    // 404, the same observable outcome as TTL eviction — warned here so the
    // 404s are attributable).
    defaults.logger.warn(
      `OpenRouter video submit for upstream job ${upstreamJobId} completed after a fixtures reset — not inserting the job into the new world (its polls will 404)`,
    );
  }

  // Guard BEFORE journaling (file convention): a client that disconnected
  // while the upstream submit was in flight gets neither a write nor a
  // journal entry. The job entry above stays — TTL eviction reaps it.
  if (res.destroyed || res.writableEnded) return "handled";
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: {
      status: 200,
      fixture: null,
      source: "proxy",
      ...strictOverrideField(defaults.strict, req.headers),
    },
  });

  // Same envelope shape as the replay path: mock jobId, mock polling_url
  // (testId embedded for header-less polls), "pending" for API fidelity.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: jobId,
      polling_url: `${requestBase(req, defaults.logger)}/api/v1/videos/${jobId}${testIdSuffix(testId, "?")}`,
      status: "pending",
    }),
  );
  return "handled";
}

// ─── Record mode: live interactive proxy (status poll + eager capture) ──────

/**
 * Default cap on the DECODED byte size embedded as `b64` in a recorded
 * fixture (32 MB). Override per-server via
 * `record.openRouterVideo.maxContentBytes` (0 = unlimited; negative or
 * non-integer values are treated as the default, with a createServer warn).
 * The cap protects disk AND memory: a capture whose upstream response
 * DECLARES an over-cap Content-Length is skipped without downloading, while
 * a response with no declared length is read as a stream with the byte count
 * enforced during the read — on exceed the download aborts with nothing
 * oversized retained in memory. In both cases the fixture is persisted
 * without `b64` and the same-session job serves the placeholder MP4.
 */
export const OPENROUTER_VIDEO_DEFAULT_MAX_CONTENT_BYTES = 32 * 1024 * 1024;

/**
 * Proxy a status poll for a record-mode job 1:1 to the upstream and relay
 * the result with mock-rewritten identifiers (rewriteRecordPollBody: id,
 * polling_url, unsigned_urls; everything else verbatim). When the upstream
 * reports `completed`, the rewritten body is relayed IMMEDIATELY and the
 * eager capture (server-side fetch of unsigned_urls[0], forwarding the
 * polling client's Bearer ONLY same-origin; persist; replay mutation) runs
 * DETACHED in the background — see captureOpenRouterVideoRecordFixture — so
 * an SDK poller is never blocked on a multi-minute download; the content
 * handler (and every later poll) serves the job locally once the capture
 * lands. `failed` persists a failed fixture synchronously on the relaying
 * poll. Every post-await map mutation is identity-guarded
 * (`jobs.get(key) === job`) so a stale response resolving after a concurrent
 * poll's capture replaced the entry can never resurrect the detached record
 * object over the terminal replay job.
 * `cancelled`/`expired` (not representable in VideoResponse.status) pass
 * through with a warn and are never recorded. Under `record.proxyOnly`
 * nothing is captured, persisted, or mutated: terminal polls relay the
 * rewritten upstream body, the upstream unsigned_urls are stored on the
 * record job for the content endpoint to live-proxy, and every later poll
 * keeps proxying upstream. Each successful proxied poll of a record job
 * refreshes its TTL so a long generation cannot be evicted mid-recording.
 */
async function proxyOpenRouterVideoRecordPoll(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  job: OpenRouterVideoRecordJob;
  key: string;
  testId: string;
  fixtures: Fixture[];
  journal: Journal;
  defaults: HandlerDefaults;
  jobs: OpenRouterVideoJobMap;
  method: string;
  path: string;
}): Promise<void> {
  const { req, res, job, key, testId, fixtures, journal, defaults, jobs, method, path } = args;
  const logger = defaults.logger;

  const journalProxy = (status: number): void => {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: {
        status,
        fixture: null,
        source: "proxy",
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
  };

  const proxyError = (msg: string): void => {
    logger.error(`OpenRouter video poll proxy failed: ${msg}`);
    // Guard BEFORE journaling (file convention): a disconnected client gets
    // neither a write nor a journal entry.
    if (res.destroyed || res.writableEnded) return;
    journalProxy(502);
    writeErrorResponse(
      res,
      502,
      JSON.stringify({
        error: { message: `Proxy to upstream failed: ${msg}`, type: "proxy_error" },
      }),
    );
  };

  // Recording can be disabled mid-flight (LLMock.disableRecording) — an
  // orphaned record job must fail loudly on ANY poll, before contacting the
  // upstream, rather than silently relaying non-terminal statuses and only
  // erroring at the terminal poll.
  const record = defaults.record;
  if (!record) {
    proxyError("record mode is no longer configured for an in-flight record job");
    return;
  }

  let fetched: { status: number; contentType: string | null; text: string };
  try {
    const upstreamRes = await fetch(job.upstreamPollingUrl, {
      headers: buildForwardHeaders(req),
      // The locally captured `record` — not defaults.record, which is the
      // same object today but would silently diverge if the defaults were
      // ever swapped between the gate above and this fetch.
      signal: upstreamTimeoutSignal(record),
    });
    fetched = {
      status: upstreamRes.status,
      contentType: upstreamRes.headers.get("content-type"),
      text: await readEnvelopeText(upstreamRes, record),
    };
  } catch (err) {
    proxyError(err instanceof Error ? err.message : "Unknown proxy error");
    return;
  }

  if (fetched.status === 401 || fetched.status === 403) {
    // Real-API fidelity (mirrors the content path): an upstream auth
    // rejection is the client's problem (bad or expired Bearer) — relay the
    // upstream status and body verbatim instead of wrapping them in a
    // generic 502 proxy_error. The job is untouched: a later poll with fixed
    // credentials proxies again.
    logger.warn(
      `Upstream rejected the status poll for job ${job.upstreamJobId} (${fetched.status}) — relaying the upstream status`,
    );
    if (res.destroyed || res.writableEnded) return;
    journalProxy(fetched.status);
    res.writeHead(fetched.status, {
      "Content-Type": fetched.contentType ?? "application/json",
    });
    res.end(fetched.text);
    return;
  }

  let upstreamBody: Record<string, unknown>;
  {
    if (fetched.status < 200 || fetched.status >= 300) {
      proxyError(`Status ${fetched.status}: ${fetched.text.slice(0, 200)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fetched.text);
    } catch {
      proxyError(`Status returned non-JSON: ${fetched.text.slice(0, 200)}`);
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      proxyError("Status response is not a JSON object");
      return;
    }
    upstreamBody = parsed as Record<string, unknown>;
  }

  const relayJson = (body: Record<string, unknown>): void => {
    // Guard BEFORE journaling: a client that disconnected while the upstream
    // poll was in flight gets neither a write nor a journal entry — the
    // journaled 200 must reflect a response that actually left.
    if (res.destroyed || res.writableEnded) return;
    journalProxy(200);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Mock-rewritten relay body — used by EVERY branch below so no upstream
  // URL-bearing field (polling_url, unsigned_urls) can escape the mock.
  const relayBody = rewriteRecordPollBody({ upstreamBody, job, req, testId, logger });

  const upstreamStatus = String(upstreamBody.status ?? "");

  if (upstreamStatus === "pending" || upstreamStatus === "in_progress") {
    // Identity guard on EVERY post-await mutation/re-insert: the upstream
    // fetch above may have resolved AFTER a concurrent poll's capture
    // replaced the map entry with a terminal replay job (or after TTL
    // eviction). Mutating or re-inserting the detached dispatch-time
    // reference would regress the terminal job back to a live proxy — the
    // body is still relayed either way.
    if (jobs.get(key) === job) {
      // Identity alone is NOT enough during the capture window (and under
      // proxyOnly after a terminal poll): the SAME record object stays in
      // the map with status "completed"/"failed", so a stale non-terminal
      // response resolving late would regress it and reopen the content
      // endpoint's 400 window. Skip the status write once capturing or
      // terminal; the TTL refresh below still applies.
      if (!job.capturing && job.status !== "completed" && job.status !== "failed") {
        job.status = upstreamStatus;
      }
      // Refresh the TTL: an actively-polled record job must not be evicted
      // mid-recording however long the generation takes.
      jobs.set(key, job);
    }
    relayJson(relayBody);
    return;
  }

  if (upstreamStatus === "completed") {
    if (record.proxyOnly) {
      // Proxy-only: no fixtures, no in-memory caching, no replay mutation.
      // The job stays kind:"record"; the upstream unsigned_urls are stored so
      // the content endpoint can live-proxy the bytes (id mapping is
      // inherently stateful — the bytes never are). Stored UNFILTERED so the
      // live proxy's indexes stay aligned with the rewritten relay's.
      // Identity-guarded like every post-await mutation in this function.
      if (jobs.get(key) === job) {
        const urls = upstreamBody.unsigned_urls;
        job.status = "completed";
        // Refresh the stash only from an array body (the capture-window twin
        // below guards this exact case): a later completed poll that omits or
        // corrupts unsigned_urls must not clobber a usable stash with
        // undefined.
        if (Array.isArray(urls)) {
          job.upstreamUnsignedUrls = [...urls];
        }
        jobs.set(key, job); // TTL refresh
      }
      relayJson(relayBody);
      return;
    }

    if (job.capturing || jobs.get(key) !== job) {
      // A concurrent poll already entered the capture sequence (capturing
      // latched), or this dispatch-time reference is detached — the map entry
      // was replaced by the finished capture's replay job (or TTL-evicted)
      // while the upstream fetch above was in flight. Relay the rewritten
      // body either way, but NEVER re-insert the stale object (it would
      // resurrect a permanent live proxy OVER the terminal replay job) and
      // never start a second capture/persist.
      if (jobs.get(key) === job) {
        // Refresh the stored upstream URLs from THIS poll's body (mirroring
        // the proxyOnly branch): upstream unsigned URLs can rotate between
        // polls (signed-by-time CDN links), so in-window content
        // live-proxies must use the freshest set. Non-array bodies keep the
        // existing stash — a defective later poll must not clobber a usable
        // one.
        const freshUrls = upstreamBody.unsigned_urls;
        if (Array.isArray(freshUrls)) {
          job.upstreamUnsignedUrls = [...freshUrls];
        }
        jobs.set(key, job); // TTL refresh, like every other successful proxied poll
      }
      relayJson(relayBody);
      return;
    }
    const urls = upstreamBody.unsigned_urls;
    // Open the capturing window SYNCHRONOUSLY, before the first await of the
    // capture sequence: `capturing` is the double-capture guard, and the
    // terminal status + stashed upstream unsigned_urls make the job fully
    // observable as completed while the capture is in flight — a client that
    // follows this (or a concurrent) poll's relayed content URL gets a
    // live-proxied download instead of a 400.
    job.capturing = true;
    job.status = "completed";
    // Refresh the stash only from an array body (the proxyOnly and
    // capture-window siblings above guard this exact case): a later completed
    // poll that omits or corrupts unsigned_urls must not clobber a usable
    // stash with undefined.
    if (Array.isArray(urls)) {
      job.upstreamUnsignedUrls = [...urls];
    }
    jobs.set(key, job); // TTL refresh — identity-checked above, no await since

    // Relay the completed body IMMEDIATELY: a real video download can take
    // minutes, and an SDK poller blocked on it would time out. The capture
    // (download + persist + replay mutation) runs DETACHED below; the
    // capturing window keeps the job serving correctly meanwhile.
    relayJson(relayBody);

    // Detached eager capture. Handles every failure internally and never
    // rejects; closes the capturing window in its finally.
    void captureOpenRouterVideoRecordFixture({
      req,
      job,
      key,
      testId,
      fixtures,
      defaults,
      jobs,
      record,
      upstreamBody,
    });
    return;
  }

  if (upstreamStatus === "failed") {
    if (record.proxyOnly) {
      // Proxy-only: relay the rewritten failure body, persist nothing, keep
      // the job a live proxy. Identity-guarded like every post-await
      // mutation in this function.
      if (jobs.get(key) === job) {
        job.status = "failed";
        jobs.set(key, job); // TTL refresh
      }
      relayJson(relayBody);
      return;
    }

    if (jobs.get(key) !== job) {
      // Concurrency guard: a concurrent poll at "failed" already persisted
      // the failure fixture and replaced the entry while this poll's
      // upstream fetch was in flight (everything below the fetch is
      // synchronous, so the first poll to resume wins atomically). Relay
      // without persisting a duplicate fixture or re-registering it.
      // This identity check ALSO covers a fixtures reset landing during the
      // upstream fetch: performFixturesReset clears the job map, so a
      // cleared world fails the check and the stale failure fixture never
      // pollutes the next world's fixtures array — valid because everything
      // from here to persistFixture below is synchronous (no interleaving
      // point between check and persist).
      relayJson(relayBody);
      return;
    }

    const rawError = upstreamBody.error;
    let error: string | undefined;
    if (typeof rawError === "string" && rawError) {
      error = rawError;
    } else if (rawError !== null && typeof rawError === "object" && !Array.isArray(rawError)) {
      // Canonical envelope shape ({ error: { message, code } }) — extract the
      // message like the recorder's error-fixture detection does.
      const message = (rawError as Record<string, unknown>).message;
      if (typeof message === "string" && message) {
        error = message;
      }
    }
    if (error === undefined && rawError !== undefined && rawError !== null) {
      logger.warn(
        `Upstream video job ${job.upstreamJobId} failed with an unusable error value (${JSON.stringify(rawError).slice(0, 100)}) — recording the fixture without an error message (replay serves the default)`,
      );
    }
    const video: VideoResponse["video"] = {
      id: job.upstreamJobId,
      status: "failed",
      ...(error !== undefined ? { error } : {}),
    };
    const persistResult = persistFixture({
      record,
      providerKey: "openrouter",
      testId,
      fixture: { match: job.match, response: { video } },
      fixtures,
      logger,
    });
    if (persistResult.kind === "failed" && !res.headersSent) {
      res.setHeader("X-AIMock-Record-Error", sanitizeHeaderValue(persistResult.error));
    }
    jobs.set(key, {
      kind: "replay",
      jobId: job.jobId,
      status: "failed",
      pollCount: 0,
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 0,
      video: { ...video },
    });
    // Passthrough of the upstream failure body, identifiers rewritten.
    relayJson(relayBody);
    return;
  }

  // cancelled / expired / anything else: terminal upstream states that are
  // not representable in VideoResponse.status — pass through (identifiers
  // rewritten), record nothing, and keep proxying any further polls live.
  logger.warn(
    `Upstream video job ${job.upstreamJobId} reported status "${upstreamStatus}" — not representable in fixture video.status; passing through without recording`,
  );
  // Identity-guarded TTL refresh — the job keeps proxying live, but a
  // detached reference is never re-inserted over a replaced entry.
  if (jobs.get(key) === job) {
    jobs.set(key, job);
  }
  relayJson(relayBody);
}

/**
 * Detached eager-capture sequence for a completed record job. Runs AFTER the
 * triggering completed poll has been relayed (the client is never blocked on
 * a potentially multi-minute video download): fetches `unsigned_urls[0]`
 * server-side (the polling client's Bearer is forwarded ONLY same-origin),
 * persists the fixture, and mutates the map entry into a terminal replay job.
 * Every failure is handled internally and the returned promise NEVER
 * rejects. Failure semantics: a capture FAILURE — no usable
 * unsigned_urls, an invalid content URL, or a content fetch that errors on
 * headers, status, or body — persists NOTHING and leaves the job a live
 * proxy, so the next completed poll retries the capture (each failure
 * warns). The ONLY degraded persist is the over-cap path (declared or
 * streamed): retrying would always re-exceed the cap, so the b64-less
 * fixture + placeholder is the deliberate, permanent outcome. The capturing
 * window opened by the caller is closed in the finally when the map still
 * holds this record job; on the success path the entry was just replaced and
 * the detached record object deliberately KEEPS capturing=true so a
 * concurrent poll that read it before the replacement still early-relays
 * instead of starting a second capture.
 */
async function captureOpenRouterVideoRecordFixture(args: {
  req: http.IncomingMessage;
  job: OpenRouterVideoRecordJob;
  key: string;
  testId: string;
  fixtures: Fixture[];
  defaults: HandlerDefaults;
  jobs: OpenRouterVideoJobMap;
  record: RecordConfig;
  upstreamBody: Record<string, unknown>;
}): Promise<void> {
  const { req, job, key, testId, fixtures, defaults, jobs, record, upstreamBody } = args;
  const logger = defaults.logger;
  const urls = upstreamBody.unsigned_urls;

  const warnings: string[] = [];
  let capturedB64: string | undefined;
  try {
    const usage = upstreamBody.usage;
    const rawCost =
      usage !== null && typeof usage === "object" && !Array.isArray(usage)
        ? (usage as Record<string, unknown>).cost
        : undefined;
    const cost = typeof rawCost === "number" ? rawCost : undefined;

    // Sanitized like the poll-threshold configs: a negative/non-integer cap
    // is treated as the default (createServer warns at startup).
    const rawCap = record.openRouterVideo?.maxContentBytes;
    const cap =
      rawCap !== undefined && Number.isInteger(rawCap) && rawCap >= 0
        ? rawCap
        : OPENROUTER_VIDEO_DEFAULT_MAX_CONTENT_BYTES;

    const urlArray = Array.isArray(urls) ? urls : undefined;
    if (urlArray && urlArray.length > 1) {
      logger.warn(
        `Upstream video job ${job.upstreamJobId} reported ${urlArray.length} unsigned_urls — only index 0 is captured; post-capture replays serve the index-0 bytes for every index`,
      );
    }
    const firstRaw = urlArray?.[0];
    const firstUrl = typeof firstRaw === "string" && firstRaw ? firstRaw : undefined;
    if (!firstUrl) {
      // Capture FAILURE: persist nothing, leave the job a live
      // proxy (the finally clears `capturing`) so the next completed poll —
      // whose upstream body may carry usable URLs — retries. Distinguish
      // "no unsigned_urls at all" from "unsigned_urls present but [0] is
      // unusable" (non-string, or an empty string) — the two point at
      // different upstream defects.
      if (urlArray && urlArray.length > 0) {
        logger.warn(
          `Upstream video job ${job.upstreamJobId} completed with an unusable unsigned_urls[0] (${JSON.stringify(firstRaw).slice(0, 100)}) — capture skipped, nothing persisted; the next completed poll retries`,
        );
      } else {
        logger.warn(
          `Upstream video job ${job.upstreamJobId} completed without unsigned_urls — capture skipped, nothing persisted; the next completed poll retries`,
        );
      }
      return;
    }
    let contentUrl: URL;
    try {
      contentUrl = new URL(firstUrl);
    } catch {
      // Capture failure — persist nothing, retry on the next completed poll.
      logger.warn(
        `Upstream unsigned_urls[0] is not a valid URL (${firstUrl.slice(0, 100)}) — capture skipped, nothing persisted; the next completed poll retries`,
      );
      return;
    }
    {
      // The client's Bearer is forwarded ONLY to the configured provider
      // origin — an off-origin content host (CDN or a hostile envelope)
      // must not receive it.
      const providerBase = record.providers.openrouter;
      let providerOrigin: string | undefined;
      try {
        providerOrigin = new URL(providerBase ?? job.upstreamPollingUrl).origin;
      } catch {
        try {
          providerOrigin = new URL(job.upstreamPollingUrl).origin;
        } catch {
          // Double parse failure (unreachable in practice — the polling URL
          // was origin-validated at submit). The relay has already left, so
          // there is no response to 502 — log, persist nothing, and let the
          // finally close the capturing window (the job stays a live
          // proxy; a later poll retries the capture).
          logger.error(
            `OpenRouter video capture for job ${job.upstreamJobId} aborted: cannot determine the provider origin (invalid provider URL and polling URL) — refusing to forward credentials`,
          );
          return;
        }
      }
      const headers = buildForwardHeaders(req);
      if (contentUrl.origin !== providerOrigin) {
        delete headers.authorization;
        logger.warn(
          `Upstream unsigned_urls[0] origin ${contentUrl.origin} differs from the provider origin ${providerOrigin} — fetching content WITHOUT the client's Authorization header`,
        );
      }
      try {
        // Headers gated by upstreamTimeoutMs; the body streams under
        // bodyTimeoutMs IDLE semantics so a long steady download (a >30s
        // video render) is never aborted by a total deadline.
        const contentRes = await fetchHeadersWithTimeout(contentUrl, headers, record);
        if (!contentRes.ok) {
          // Bounded body sample (idle semantics + the error cap, like the
          // content proxy's failure path) — a bare status is not diagnosable.
          let sample = "";
          try {
            const read = await readBodyIdle(contentRes, record, OPENROUTER_VIDEO_ERROR_BODY_CAP);
            if (!read.overCap) sample = read.buf.toString("utf8").slice(0, 200);
          } catch {
            // Body unreadable — the status alone still names the failure.
          }
          throw new Error(`Content ${contentRes.status}${sample ? `: ${sample}` : ""}`);
        }
        const declaredLength = Number(contentRes.headers.get("content-length") ?? NaN);
        if (cap > 0 && Number.isFinite(declaredLength) && declaredLength > cap) {
          // Memory guard: the upstream DECLARED an over-cap size — skip the
          // download entirely instead of buffering it just to discard it.
          // Over-cap is the ONE degraded persist (see the function doc): a
          // retry would always re-exceed the cap, so the b64-less fixture is
          // deliberate and permanent.
          void contentRes.body?.cancel().catch(() => {});
          logger.warn(
            `Captured video for job ${job.upstreamJobId} declares Content-Length ${declaredLength} — over maxContentBytes (${cap}); skipping the download; fixture persisted WITHOUT b64 (content serves the placeholder MP4)`,
          );
          warnings.push(
            `Declared content length (${declaredLength} bytes) exceeded maxContentBytes (${cap}) — download skipped, b64 omitted`,
          );
        } else {
          // The cap is enforced DURING the streamed read: on exceed the
          // read aborts and nothing oversized is retained in memory —
          // the same-session job serves the placeholder, exactly like
          // the declared-length skip above (the same deliberate over-cap
          // persist).
          const read = await readBodyIdle(contentRes, record, cap);
          if (read.overCap) {
            logger.warn(
              `Captured video for job ${job.upstreamJobId} streamed past maxContentBytes (${cap}) — download aborted at ${read.bytesRead} bytes; fixture persisted WITHOUT b64 (content serves the placeholder MP4)`,
            );
            warnings.push(
              `Captured video exceeded maxContentBytes (${cap}) — download aborted, b64 omitted`,
            );
          } else {
            capturedB64 = read.buf.toString("base64");
          }
        }
      } catch (err) {
        // Capture failure (headers, status, or body) — transient by nature:
        // persist nothing, leave the job live, warn; the next completed poll
        // retries (was: persist a b64-less fixture forever).
        const msg = err instanceof Error ? err.message : "Unknown capture error";
        logger.warn(
          `OpenRouter video content capture failed (${msg}) — nothing persisted; the job keeps proxying live and the next completed poll retries`,
        );
        return;
      }
    }

    const video: VideoResponse["video"] = {
      id: job.upstreamJobId,
      status: "completed",
      ...(capturedB64 !== undefined ? { b64: capturedB64 } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };
    // World-generation guard: a fixtures reset (POST
    // /__aimock/reset/fixtures) landing during the multi-second capture
    // above clears BOTH the fixtures array and the job map
    // (performFixturesReset) — so map identity is a valid proxy for "same
    // world": if `jobs.get(key)` no longer returns this job, the world this
    // capture belongs to is gone and persisting would push a stale fixture
    // into the NEXT world's array (and write a file the new world never
    // asked for). Checked immediately before persistFixture with no await
    // in between.
    if (jobs.get(key) !== job) {
      logger.warn(
        `OpenRouter video capture for job ${job.upstreamJobId} discarded: the job map no longer holds this job (fixtures reset or TTL eviction mid-capture) — nothing persisted`,
      );
      return;
    }
    // A persist failure cannot ride an X-AIMock-Record-Error header here —
    // the relay left before the capture started (the failed branch, which
    // persists synchronously, still sets the header). persistFixture logs
    // the failure; the replay mutation below still happens so the in-memory
    // session serves the captured bytes.
    persistFixture({
      record,
      providerKey: "openrouter",
      testId,
      fixture: { match: job.match, response: { video } },
      fixtures,
      warnings,
      logger,
    });

    // Mutate the map entry into a terminal replay job: later polls and the
    // content handler serve it locally from here on. An over-cap capture
    // never keeps bytes in memory (the streamed read aborted at the cap),
    // so the replayed content is the placeholder MP4. Identity-guarded: a
    // TTL-evicted (or otherwise replaced) entry is never resurrected.
    if (jobs.get(key) === job) {
      jobs.set(key, {
        kind: "replay",
        jobId: job.jobId,
        status: "completed",
        pollCount: 0,
        pollsBeforeInProgress: 0,
        pollsBeforeCompleted: 0,
        video: { ...video },
      });
    }
  } catch (err) {
    // Nothing may reject unhandled out of the detached capture. An
    // unexpected throw (every expected failure is handled above) leaves the
    // job a live proxy; a later completed poll retries the capture.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `OpenRouter video capture for job ${job.upstreamJobId} failed unexpectedly (${msg}) — fixture not persisted; the job keeps proxying live`,
    );
  } finally {
    // Close the capturing window when the map still holds this record job
    // (a capture step threw before the replay mutation) — a latched
    // `capturing` would make every later poll early-relay and the job
    // could never be captured. On the success path the entry was just
    // replaced; the detached record object deliberately KEEPS
    // capturing=true (see the function doc).
    if (jobs.get(key) === job) {
      job.capturing = false;
    }
  }
}
