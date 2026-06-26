import type * as http from "node:http";
import crypto from "node:crypto";
import type {
  ChatCompletionRequest,
  Fixture,
  HandlerDefaults,
  RecordConfig,
  VideoResponse,
} from "./types.js";
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
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaos } from "./chaos.js";
import { resolveProgression } from "./fal.js";
import {
  buildFixtureMatch,
  buildForwardHeaders,
  persistFixture,
  sanitizeHeaderValue,
} from "./recorder.js";
import { resolveUpstreamUrl } from "./url.js";
import { handleVideoStatus, type VideoStateMap } from "./video.js";
import { readEnvelopeText, upstreamTimeoutSignal } from "./video-proxy-shared.js";

/**
 * xAI Grok Imagine async video lifecycle mock. Submit
 * `POST /v1/videos/generations` returns `{ request_id }`; status
 * `GET /v1/videos/{request_id}` polls `pending → done | failed | expired` with
 * a synthesized `progress`. Multipart submits are rejected with HTTP 400
 * BEFORE body parse (the real API is JSON-only). `video.url` is served AS-IS —
 * aimock does NOT proxy or capture video bytes. With `record.providers.grok`
 * configured an unmatched submit becomes a live interactive proxy (submit +
 * poll forwarded 1:1, eager fixture capture of url/duration/cost on terminal
 * status). Strict mode wins.
 *
 * Grok status shares the `/v1/videos/{id}` path with Sora: the dispatch does a
 * job-map-first lookup and falls through to the UNCHANGED Sora
 * `handleVideoStatus` on a miss (disjoint id namespaces → unambiguous).
 *
 * cost_in_usd_ticks ↔ USD: USD = ticks / 1e10 (ASSUMED). Record persists USD in
 * `video.cost`; replay reconstructs ticks = round(cost * 1e10).
 */

interface GrokVideoRequest {
  model?: string;
  prompt?: string;
  [key: string]: unknown;
}

const DEFAULT_GROK_VIDEO_MODEL = "grok-imagine-video";

// USD ←→ Grok cost_in_usd_ticks conversion (ASSUMED: 1e10 ticks per USD).
const GROK_USD_TICKS_PER_USD = 1e10;

// Default placeholder when a completed fixture omits `video.url` — every other
// coercion on this surface is documented; the real API always returns a url.
const GROK_DEFAULT_VIDEO_URL = "https://cdn.x.ai/aimock-placeholder-video.mp4";

// ─── GrokVideoJobMap (TTL + bounded) ────────────────────────────────────────

export const GROK_VIDEO_MAX_ENTRIES = 10_000;
const GROK_VIDEO_TTL_MS = 3_600_000; // 1 hour

type GrokVideoStatus = "pending" | "in_progress" | "completed" | "failed";

interface GrokVideoReplayJob {
  kind: "replay";
  requestId: string;
  status: GrokVideoStatus;
  /** Number of status polls the caller has made against this job. */
  pollCount: number;
  /** Poll-count threshold for `pending → in_progress` transition. */
  pollsBeforeInProgress: number;
  /** Poll-count threshold for the transition to the terminal status. */
  pollsBeforeCompleted: number;
  /** The matched fixture's video object (terminal status, url, duration, cost, error). */
  video: VideoResponse["video"];
  /** Latch for the empty-`error` authoring warn on failed polls (once per job). */
  emptyErrorWarned?: boolean;
}

/**
 * A job whose lifecycle is proxied live upstream (record mode, no fixture
 * matched at submit). Every client poll is forwarded 1:1 to
 * `upstreamPollingUrl`; when the upstream reports a terminal status (`done`/
 * `failed`) the entry is captured as a fixture and MUTATED into a terminal
 * GrokVideoReplayJob. `expired` (and any unrepresentable status) pass through
 * with a warn and keep proxying. Under `record.proxyOnly` nothing is ever
 * captured or mutated.
 */
interface GrokVideoRecordJob {
  kind: "record";
  /** The mock-issued requestId the client polls with. */
  requestId: string;
  /** Last upstream status relayed to the client. */
  status: GrokVideoStatus;
  /** Upstream's own request id (recorded as the fixture's video.id). */
  upstreamRequestId: string;
  /** Origin-validated absolute upstream URL proxied on every client poll. */
  upstreamPollingUrl: string;
  /** Match snapshot built at submit time (post requestTransform). */
  match: Fixture["match"];
  /**
   * Set synchronously before the first await of the eager-capture sequence so
   * a concurrent terminal poll relays the upstream body instead of starting a
   * second capture/persist.
   */
  capturing?: boolean;
}

export type GrokVideoJob = GrokVideoReplayJob | GrokVideoRecordJob;

interface GrokVideoEntry {
  job: GrokVideoJob;
  createdAt: number;
}

/**
 * Per-testId job state for the Grok video handler. Mirrors OpenRouterVideoJobMap
 * (openrouter-video.ts): lazy TTL eviction on `get`, FIFO eviction of the
 * oldest entries on `set` when over capacity, delete-before-set TTL refresh,
 * monotonic world-generation counter for reset-mid-flight detection, no
 * background sweep timer. Keys are `${testId}:${requestId}`.
 */
export class GrokVideoJobMap {
  private readonly entries = new Map<string, GrokVideoEntry>();
  private worldGeneration = 0;

  get generation(): number {
    return this.worldGeneration;
  }

  get(key: string): GrokVideoJob | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > GROK_VIDEO_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.job;
  }

  set(key: string, job: GrokVideoJob): void {
    this.entries.delete(key);
    this.entries.set(key, { job, createdAt: Date.now() });
    if (this.entries.size > GROK_VIDEO_MAX_ENTRIES) {
      const excess = this.entries.size - GROK_VIDEO_MAX_ENTRIES;
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
 * state.
 */
function terminalStatus(job: GrokVideoReplayJob): GrokVideoStatus {
  return job.video.status === "failed" ? "failed" : "completed";
}

/**
 * Mutates a job in place to advance its state on a status poll.
 * `pending → in_progress → completed | failed` based on poll-count thresholds.
 * No-op once terminal. The in_progress threshold is checked first so a job
 * whose thresholds are equal still spends one poll in in_progress instead of
 * jumping straight to the terminal status (fal advanceJob semantics).
 */
function advanceJob(job: GrokVideoReplayJob): void {
  if (job.status === "completed" || job.status === "failed") return;

  job.pollCount += 1;
  if (job.status === "pending" && job.pollCount >= job.pollsBeforeInProgress) {
    job.status = "in_progress";
  } else if (job.pollCount >= job.pollsBeforeCompleted) {
    job.status = terminalStatus(job);
  }
}

/**
 * Synthesize the Grok wire `progress` (0..100) from poll-count progress toward
 * the completed threshold. A terminal-completed job is always 100 (the only way
 * to reach 100 — it is the wire signal for "done"). Every other state reports
 * its progress-at-failure/at-poll, capped at 99. A seed-terminal job with a
 * non-positive completion target has done zero polls toward completion, so it
 * reports 0 (a failed seed job is 0%, never 100).
 */
function grokProgress(job: GrokVideoReplayJob): number {
  if (job.status === "completed") return 100;
  const target = job.pollsBeforeCompleted;
  if (target <= 0) return 0;
  const ratio = Math.min(1, job.pollCount / target);
  return Math.min(99, Math.round(ratio * 100));
}

/** Map the internal job status onto the Grok wire `status` token. */
function grokWireStatus(status: GrokVideoStatus): "done" | "failed" | "pending" {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  return "pending";
}

/**
 * Synthesizes a structurally valid journal body for field-validation 400s.
 * Mirrors openrouter-video's validationJournalBody: `model` stays a string and
 * `messages` is an empty array; underscore-prefixed keys are stripped so a
 * request cannot spoof handler-set discriminators.
 */
function validationJournalBody(videoReq: GrokVideoRequest): ChatCompletionRequest {
  const rawModel = videoReq.model;
  const model =
    typeof rawModel === "string"
      ? rawModel
      : rawModel === undefined
        ? ""
        : JSON.stringify(rawModel);
  const sanitized = Object.fromEntries(
    Object.entries(videoReq).filter(([key]) => !key.startsWith("_")),
  );
  return { ...sanitized, model, messages: [] };
}

// ─── POST /v1/videos/generations — submit ────────────────────────────────────

export async function handleGrokVideoCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: GrokVideoJobMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? "/v1/videos/generations";
  const method = req.method ?? "POST";

  // MULTIPART REJECT FIRST — the real Grok API is JSON-only. Reject BEFORE any
  // body parse so a multipart body never reaches the JSON parser (and never
  // reuses Sora's accept-multipart branch).
  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  if ((contentType ?? "").toLowerCase().includes("multipart/form-data")) {
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
        code: "invalid_request",
        error: "multipart/form-data is not supported — the Grok video API is JSON-only",
      }),
    );
    return;
  }

  let videoReq: GrokVideoRequest;
  try {
    videoReq = JSON.parse(raw) as GrokVideoRequest;
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
      JSON.stringify({ code: "invalid_json", error: `Malformed JSON: ${detail}` }),
    );
    return;
  }

  // Reject bodies that parsed but are not a JSON object before touching fields.
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
      JSON.stringify({ code: "invalid_request", error: "Request body must be a JSON object" }),
    );
    return;
  }

  const parsedBody = validationJournalBody(videoReq);

  if (typeof videoReq.prompt !== "string" || !videoReq.prompt) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: parsedBody,
      response: { status: 400, fixture: null },
    });
    const message =
      videoReq.prompt === undefined
        ? "Missing required parameter: 'prompt'"
        : "Invalid type for parameter: 'prompt' must be a non-empty string";
    writeErrorResponse(res, 400, JSON.stringify({ code: "invalid_request", error: message }));
    return;
  }

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
        code: "invalid_request",
        error: "Invalid type for parameter: 'model' must be a non-empty string",
      }),
    );
    return;
  }

  const syntheticReq: ChatCompletionRequest = {
    model: videoReq.model ?? DEFAULT_GROK_VIDEO_MODEL,
    messages: [{ role: "user", content: videoReq.prompt }],
    _endpointType: "video",
    _videoProvider: "grok",
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
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    defaults.logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    const snippet = videoReq.prompt.slice(0, 80);
    defaults.logger.debug(
      `No fixture matched for request (model=${syntheticReq.model}, msg="${snippet}")`,
    );
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      fixture
        ? "fixture"
        : resolveStrictMode(defaults.strict, req.headers)
          ? "internal"
          : defaults.record?.providers.grok
            ? "proxy"
            : "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
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
        JSON.stringify({ code: "no_fixture_match", error: strictMessage }),
      );
      return;
    }

    if (defaults.record) {
      const outcome = await proxyGrokVideoSubmit({
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
      JSON.stringify({ code: "not_found", error: "No fixture matched" }),
    );
    return;
  }

  const worldGeneration = jobs.generation;
  const response = await resolveResponse(fixture, syntheticReq);

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

  const fixtureStatus: string = response.video.status;
  if (fixtureStatus === "processing") {
    defaults.logger.warn(
      `Video fixture has status "processing" — treated as completed for /v1/videos/generations jobs`,
    );
  } else if (fixtureStatus !== "completed" && fixtureStatus !== "failed") {
    defaults.logger.warn(
      `Video fixture has unknown status "${fixtureStatus}" — treating as completed for /v1/videos/generations jobs`,
    );
  }

  const requestId = crypto.randomUUID();
  const progression = resolveProgression(defaults.grokVideo);
  const job: GrokVideoReplayJob = {
    kind: "replay",
    requestId,
    status: "pending",
    pollCount: 0,
    pollsBeforeInProgress: progression.pollsBeforeInProgress,
    pollsBeforeCompleted: progression.pollsBeforeCompleted,
    video: { ...response.video },
  };
  if (progression.pollsBeforeCompleted === 0) {
    job.status = terminalStatus(job);
  }
  if (jobs.generation === worldGeneration) {
    jobs.set(`${testId}:${requestId}`, job);
  } else {
    defaults.logger.warn(
      `Grok video submit resolved after a fixtures reset — not inserting job ${requestId} into the new world (its polls will 404)`,
    );
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ request_id: requestId }));
}

// ─── GET /v1/videos/{id} — status poll (Grok-first, Sora fall-through) ───────

export async function handleGrokVideoStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  grokJobs: GrokVideoJobMap,
  videoStates: VideoStateMap,
): Promise<void> {
  const testId = getTestId(req);
  const key = `${testId}:${id}`;
  const job = grokJobs.get(key);
  if (!job) {
    // Grok miss → Sora status, UNCHANGED (byte-for-byte; it sets CORS + rolls
    // chaos itself). Disjoint id namespaces make this unambiguous.
    handleVideoStatus(req, res, id, journal, defaults, setCorsHeaders, videoStates);
    return;
  }

  // Grok hit: this handler owns the response from here. Set CORS and roll
  // chaos (mirroring handleOpenRouterVideoStatus — chaos rolls before any work).
  setCorsHeaders(res);
  const path = req.url ?? `/v1/videos/${id}`;
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

  if (job.kind === "record") {
    if (resolveStrictMode(defaults.strict, req.headers)) {
      defaults.logger.error(
        `STRICT: video job ${id} is proxied live upstream (record mode) — refusing the upstream poll`,
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
          code: "no_fixture_match",
          error: `Strict mode: video job ${id} is proxied live upstream (record mode) — nothing reaches an upstream under strict mode`,
        }),
      );
      return;
    }
    await proxyGrokVideoRecordPoll({
      req,
      res,
      job,
      key,
      testId,
      fixtures,
      journal,
      defaults,
      jobs: grokJobs,
      method,
      path,
    });
    return;
  }

  // Replay: guard BEFORE advancing or journaling (file convention).
  if (res.destroyed || res.writableEnded) return;
  advanceJob(job);
  grokJobs.set(key, job);
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null },
  });

  const body = serializeGrokReplay(job, defaults);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Serialize a replay job into the Grok wire body. STORED `video.status` is the
 * 3-value VideoResponse union; the wire `status` is derived here
 * (completed → "done"). cost_in_usd_ticks is reconstructed from the stored USD
 * `video.cost` (round(cost * 1e10)).
 */
function serializeGrokReplay(
  job: GrokVideoReplayJob,
  defaults: HandlerDefaults,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    request_id: job.requestId,
    status: grokWireStatus(job.status),
    progress: grokProgress(job),
  };
  if (job.status === "completed") {
    body.video = {
      url: job.video.url || GROK_DEFAULT_VIDEO_URL,
      duration: job.video.duration ?? 0,
    };
    body.usage = {
      cost_in_usd_ticks: Math.round((job.video.cost ?? 0) * GROK_USD_TICKS_PER_USD),
    };
  } else if (job.status === "failed") {
    if (job.video.error === "" && !job.emptyErrorWarned) {
      job.emptyErrorWarned = true;
      defaults.logger.warn(
        `Video fixture for job ${job.requestId} has an empty error message — using the default`,
      );
    }
    body.code = "generation_failed";
    body.error = job.video.error || "Video generation failed";
  }
  return body;
}

// ─── Record mode: live interactive proxy (submit) ────────────────────────────

const GROK_VIDEO_SUBMIT_PATH = "/v1/videos/generations";

/**
 * Proxy an unmatched Grok video submit to the configured upstream and answer
 * the client with a mock-rewritten `{ request_id }`. The upstream lifecycle is
 * then driven interactively by the client's own polls. Returns "no_upstream"
 * when record mode has no grok provider URL — the caller falls through to 404.
 */
async function proxyGrokVideoSubmit(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  raw: string;
  syntheticReq: ChatCompletionRequest;
  record: RecordConfig;
  journal: Journal;
  defaults: HandlerDefaults;
  jobs: GrokVideoJobMap;
  method: string;
  path: string;
}): Promise<"handled" | "no_upstream"> {
  const { req, res, raw, syntheticReq, record, journal, defaults, jobs, method, path } = args;

  const upstreamBase = record.providers.grok;
  if (!upstreamBase) {
    defaults.logger.warn(`No upstream URL configured for provider "grok" — cannot proxy`);
    return "no_upstream";
  }

  const proxyError = (msg: string): "handled" => {
    defaults.logger.error(`Grok video submit proxy failed: ${msg}`);
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
      JSON.stringify({ code: "proxy_error", error: `Proxy to upstream failed: ${msg}` }),
    );
    return "handled";
  };

  let submitUrl: URL;
  let upstreamOrigin: string;
  try {
    submitUrl = resolveUpstreamUrl(upstreamBase, GROK_VIDEO_SUBMIT_PATH);
    upstreamOrigin = new URL(upstreamBase).origin;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return proxyError(`Invalid upstream URL: ${upstreamBase} (${msg})`);
  }

  defaults.logger.warn(
    `NO FIXTURE MATCH — proxying video submit to ${upstreamBase}${GROK_VIDEO_SUBMIT_PATH}`,
  );

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
    res.writeHead(fetched.status, { "Content-Type": fetched.contentType ?? "application/json" });
    res.end(fetched.text);
    return "handled";
  }

  let upstreamRequestId: string;
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
    const envelope = parsed as Record<string, unknown>;
    upstreamRequestId = String(envelope.request_id ?? "").trim();
    if (!upstreamRequestId) {
      return proxyError("Submit response missing request_id");
    }
  }

  // Construct the poll URL on the configured provider origin (Grok submit
  // returns only request_id, no polling_url — so there is nothing off-origin
  // to validate; we always build it ourselves on the trusted origin).
  void upstreamOrigin;
  const upstreamPollingUrl = resolveUpstreamUrl(
    upstreamBase,
    `/v1/videos/${encodeURIComponent(upstreamRequestId)}`,
  ).toString();

  const testId = getTestId(req);
  const matchRequest = defaults.requestTransform
    ? defaults.requestTransform(syntheticReq)
    : syntheticReq;
  const requestId = crypto.randomUUID();
  const job: GrokVideoRecordJob = {
    kind: "record",
    requestId,
    status: "pending",
    upstreamRequestId,
    upstreamPollingUrl,
    match: buildFixtureMatch(matchRequest, record),
  };
  if (jobs.generation === worldGeneration) {
    jobs.set(`${testId}:${requestId}`, job);
  } else {
    defaults.logger.warn(
      `Grok video submit for upstream request ${upstreamRequestId} completed after a fixtures reset — not inserting the job into the new world (its polls will 404)`,
    );
  }

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

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ request_id: requestId }));
  return "handled";
}

// ─── Record mode: live interactive proxy (status poll + eager capture) ───────

/**
 * Proxy a status poll for a record-mode job 1:1 to the upstream and relay the
 * result with the mock requestId substituted. On `done` the rewritten body is
 * relayed IMMEDIATELY and an eager capture runs (synchronously here — there is
 * NO byte download, only the url/duration/cost from the terminal poll body —
 * but structured to mirror openrouter-video's terminal path). `failed`
 * persists a failed fixture synchronously. `expired` (and any unrepresentable
 * status) pass through with a warn and keep proxying. Every post-await map
 * mutation is identity-guarded. Each successful proxied poll refreshes the TTL.
 */
async function proxyGrokVideoRecordPoll(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  job: GrokVideoRecordJob;
  key: string;
  testId: string;
  fixtures: Fixture[];
  journal: Journal;
  defaults: HandlerDefaults;
  jobs: GrokVideoJobMap;
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
    logger.error(`Grok video poll proxy failed: ${msg}`);
    if (res.destroyed || res.writableEnded) return;
    journalProxy(502);
    writeErrorResponse(
      res,
      502,
      JSON.stringify({ code: "proxy_error", error: `Proxy to upstream failed: ${msg}` }),
    );
  };

  const record = defaults.record;
  if (!record) {
    proxyError("record mode is no longer configured for an in-flight record job");
    return;
  }

  let fetched: { status: number; contentType: string | null; text: string };
  try {
    const upstreamRes = await fetch(job.upstreamPollingUrl, {
      headers: buildForwardHeaders(req),
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
    logger.warn(
      `Upstream rejected the status poll for job ${job.upstreamRequestId} (${fetched.status}) — relaying the upstream status`,
    );
    if (res.destroyed || res.writableEnded) return;
    journalProxy(fetched.status);
    res.writeHead(fetched.status, { "Content-Type": fetched.contentType ?? "application/json" });
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

  // Rewrite the relay so no upstream id escapes (request_id → mock id);
  // status/progress/video/usage pass through verbatim.
  const relayBody: Record<string, unknown> = { ...upstreamBody, request_id: job.requestId };

  const relayJson = (body: Record<string, unknown>): void => {
    if (res.destroyed || res.writableEnded) return;
    journalProxy(200);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const upstreamStatus = String(upstreamBody.status ?? "");

  if (upstreamStatus === "pending" || upstreamStatus === "in_progress") {
    if (jobs.get(key) === job) {
      if (!job.capturing && job.status !== "completed" && job.status !== "failed") {
        job.status = upstreamStatus === "in_progress" ? "in_progress" : "pending";
      }
      jobs.set(key, job); // TTL refresh
    }
    relayJson(relayBody);
    return;
  }

  if (upstreamStatus === "done") {
    if (record.proxyOnly) {
      if (jobs.get(key) === job) {
        job.status = "completed";
        jobs.set(key, job); // TTL refresh
      }
      relayJson(relayBody);
      return;
    }

    if (job.capturing || jobs.get(key) !== job) {
      if (jobs.get(key) === job) jobs.set(key, job); // TTL refresh
      relayJson(relayBody);
      return;
    }

    // Open the capturing window SYNCHRONOUSLY. There is no byte download, so
    // the capture is synchronous, but mirror the structure: latch capturing,
    // set terminal status, relay, persist, mutate to a terminal replay job.
    job.capturing = true;
    job.status = "completed";
    jobs.set(key, job);

    relayJson(relayBody);

    captureGrokVideoRecordFixture({
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
      if (jobs.get(key) === job) {
        job.status = "failed";
        jobs.set(key, job); // TTL refresh
      }
      relayJson(relayBody);
      return;
    }

    if (jobs.get(key) !== job) {
      relayJson(relayBody);
      return;
    }

    const rawError = upstreamBody.error;
    let error: string | undefined;
    if (typeof rawError === "string" && rawError) {
      error = rawError;
    } else if (rawError !== null && typeof rawError === "object" && !Array.isArray(rawError)) {
      const message = (rawError as Record<string, unknown>).message;
      if (typeof message === "string" && message) error = message;
    }
    if (error === undefined && rawError !== undefined && rawError !== null) {
      logger.warn(
        `Upstream video job ${job.upstreamRequestId} failed with an unusable error value (${JSON.stringify(rawError).slice(0, 100)}) — recording the fixture without an error message (replay serves the default)`,
      );
    }
    const video: VideoResponse["video"] = {
      id: job.upstreamRequestId,
      status: "failed",
      ...(error !== undefined ? { error } : {}),
    };
    const persistResult = persistFixture({
      record,
      providerKey: "grok",
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
      requestId: job.requestId,
      status: "failed",
      pollCount: 0,
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 0,
      video: { ...video },
    });
    relayJson(relayBody);
    return;
  }

  // expired / anything else: terminal upstream states not representable in
  // VideoResponse.status — pass through (id rewritten), record nothing, keep
  // proxying.
  logger.warn(
    `Upstream video job ${job.upstreamRequestId} reported status "${upstreamStatus}" — not representable in fixture video.status; passing through without recording`,
  );
  if (jobs.get(key) === job) {
    jobs.set(key, job);
  }
  relayJson(relayBody);
}

/**
 * Capture a completed Grok record job into a fixture (PERSIST only — NO byte
 * download): builds `video` from the terminal poll body (id = upstream
 * request_id, status = stored "completed", url/duration/cost), persists it, and
 * mutates the map entry into a terminal replay job. World-generation guard
 * before persist (a fixtures reset mid-flight invalidates the world).
 */
function captureGrokVideoRecordFixture(args: {
  job: GrokVideoRecordJob;
  key: string;
  testId: string;
  fixtures: Fixture[];
  defaults: HandlerDefaults;
  jobs: GrokVideoJobMap;
  record: RecordConfig;
  upstreamBody: Record<string, unknown>;
}): void {
  const { job, key, testId, fixtures, defaults, jobs, record, upstreamBody } = args;
  const logger = defaults.logger;

  try {
    const upstreamVideo =
      upstreamBody.video !== null &&
      typeof upstreamBody.video === "object" &&
      !Array.isArray(upstreamBody.video)
        ? (upstreamBody.video as Record<string, unknown>)
        : undefined;
    const rawUrl = upstreamVideo?.url;
    const url = typeof rawUrl === "string" && rawUrl ? rawUrl : GROK_DEFAULT_VIDEO_URL;
    const rawDuration = upstreamVideo?.duration;
    const duration = typeof rawDuration === "number" ? rawDuration : undefined;

    const usage =
      upstreamBody.usage !== null &&
      typeof upstreamBody.usage === "object" &&
      !Array.isArray(upstreamBody.usage)
        ? (upstreamBody.usage as Record<string, unknown>)
        : undefined;
    const rawTicks = usage?.cost_in_usd_ticks;
    const cost = typeof rawTicks === "number" ? rawTicks / GROK_USD_TICKS_PER_USD : undefined;

    const video: VideoResponse["video"] = {
      id: job.upstreamRequestId,
      status: "completed",
      url,
      ...(duration !== undefined ? { duration } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };

    // World-generation guard: a fixtures reset clears the job map, so map
    // identity is a valid proxy for "same world".
    if (jobs.get(key) !== job) {
      logger.warn(
        `Grok video capture for job ${job.upstreamRequestId} discarded: the job map no longer holds this job (fixtures reset or TTL eviction) — nothing persisted`,
      );
      return;
    }
    persistFixture({
      record,
      providerKey: "grok",
      testId,
      fixture: { match: job.match, response: { video } },
      fixtures,
      logger,
    });

    if (jobs.get(key) === job) {
      jobs.set(key, {
        kind: "replay",
        requestId: job.requestId,
        status: "completed",
        pollCount: 0,
        pollsBeforeInProgress: 0,
        pollsBeforeCompleted: 0,
        video: { ...video },
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `Grok video capture for job ${job.upstreamRequestId} failed unexpectedly (${msg}) — fixture not persisted; the job keeps proxying live`,
    );
  } finally {
    // Reset unconditionally (defense-in-depth): the flag lives on this `job`
    // object, so clearing it is always safe — harmless on an orphaned/replaced
    // job (the success path swaps in a fresh replay entry; the old object is
    // discarded either way). The previous `jobs.get(key) === job` guard was a
    // latent landmine: if capture were ever made async/detached, an eviction
    // mid-flight would leave `capturing=true` stuck forever and silently block
    // re-capture. Unconditional reset removes that hazard.
    job.capturing = false;
  }
}
