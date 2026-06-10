import type * as http from "node:http";
import crypto from "node:crypto";
import type { ChatCompletionRequest, Fixture, HandlerDefaults, VideoResponse } from "./types.js";
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

/**
 * OpenRouter async video lifecycle mock (`/api/v1/videos`). Mirrors the
 * dedicated OpenRouter video-generation API: submit returns a job envelope,
 * status polls advance `pending → in_progress → completed | failed`, and a
 * `/content` endpoint serves the bytes. Replay/strict-only — record mode is
 * not wired for this surface.
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

interface OpenRouterVideoJob {
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
}

interface OpenRouterVideoEntry {
  job: OpenRouterVideoJob;
  createdAt: number;
}

/**
 * Per-testId job state for the OpenRouter video handler. Mirrors
 * FalQueueStateMap (fal.ts): lazy TTL eviction on `get`, FIFO eviction of the
 * oldest entries on `set` when over capacity, no background sweep timer.
 * Keys are `${testId}:${jobId}`.
 */
export class OpenRouterVideoJobMap {
  private readonly entries = new Map<string, OpenRouterVideoEntry>();

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
function terminalStatus(job: OpenRouterVideoJob): OpenRouterVideoStatus {
  return job.video.status === "failed" ? "failed" : "completed";
}

/**
 * Mutates a job in place to advance its state on a status poll.
 * `pending → in_progress → completed | failed` based on poll-count thresholds.
 * No-op once terminal. The in_progress threshold is checked first so a job
 * whose thresholds are equal still spends one poll in in_progress instead of
 * jumping straight to the terminal status (fal advanceJob semantics).
 */
function advanceJob(job: OpenRouterVideoJob): void {
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
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

// Conservative host[:port] shape for x-forwarded-host. Spaces, slashes,
// userinfo, or any other URL-structure character would corrupt (or smuggle
// paths into) the generated URLs the value is interpolated into.
const FORWARDED_HOST_RE = /^[a-zA-Z0-9.-]+(:\d+)?$/;
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
  let host = req.headers.host ?? "localhost";
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
 * (polling_url, unsigned_urls). The @openrouter/sdk fetches these URLs bare —
 * no custom headers — so the testId must travel in the URL for getTestId's
 * `?testId=` fallback to resolve the right job scope. The default testId is
 * omitted to keep single-tenant URLs clean.
 */
function testIdSuffix(testId: string, sep: "?" | "&"): string {
  return testId === DEFAULT_TEST_ID ? "" : `${sep}testId=${encodeURIComponent(testId)}`;
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

export function handleOpenRouterVideoStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: OpenRouterVideoJobMap,
): void {
  setCorsHeaders(res);
  const path = req.url ?? `/api/v1/videos/${jobId}`;
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

  advanceJob(job);

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
    body.error = job.video.error ?? "Video generation failed";
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
// from fal's advance-on-result queue semantics).
export function handleOpenRouterVideoContent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: OpenRouterVideoJobMap,
): void {
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

  // `index` is accepted but ignored (jobs are single-video) — warn when a
  // present value asks for anything other than index 0, since the caller is
  // silently getting index-0 bytes either way.
  const queryIdx = path.indexOf("?");
  const indexParam =
    queryIdx === -1 ? null : new URLSearchParams(path.slice(queryIdx + 1)).get("index");
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
    if (bytes.length === 0) {
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
      defaults.logger.warn(
        `Video fixture b64 for job ${jobId} has length ≡ 1 (mod 4) after sanitization (${sanitized.length} chars) — payload is malformed or contains invalid characters`,
      );
    } else if (bytes.length !== expectedBytes) {
      defaults.logger.warn(
        `Video fixture b64 for job ${jobId} decoded to ${bytes.length} bytes where its length implies ${expectedBytes} — likely corrupt base64`,
      );
    }
  } else {
    if (job.video.b64 === "") {
      // An explicit-but-empty b64 is indistinguishable from an absent one to
      // the truthiness check above — warn so the author learns the fixture
      // is not controlling the served bytes.
      defaults.logger.warn(
        `Video fixture for job ${jobId} has an empty b64 — serving the placeholder MP4`,
      );
    }
    if (job.video.url) {
      // Every other coercion on this surface warns — so does dropping the
      // author's url. The real OpenRouter content endpoint serves bytes, not
      // a redirect, so the mock has nothing to do with a url-only fixture.
      defaults.logger.warn(
        `Video fixture for job ${jobId} sets video.url but no b64 — url is ignored on the OpenRouter content endpoint; use b64 to control the served bytes (serving the placeholder MP4)`,
      );
    }
    bytes = PLACEHOLDER_MP4;
  }

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
 */
export function handleOpenRouterVideoModels(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
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
    defaults.logger.debug(
      "No video fixture contributes a string model — serving the default video model set",
    );
  }
  const ids = modelIds.size > 0 ? [...modelIds] : DEFAULT_OPENROUTER_VIDEO_MODELS;

  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null },
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
  // rolls first.
  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      // This surface never proxies (replay/strict-only) — the no-fixture
      // chaos path is still served internally.
      fixture ? "fixture" : "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      defaults.logger.warn(
        "record mode is not supported for /api/v1/videos — returning 404/503 no-match response",
      );
    }
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

  const response = await resolveResponse(fixture, syntheticReq);

  if (isErrorResponse(response)) {
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
  const job: OpenRouterVideoJob = {
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
  jobs.set(`${testId}:${jobId}`, job);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: jobId,
      polling_url: `${requestBase(req, defaults.logger)}/api/v1/videos/${jobId}${testIdSuffix(testId, "?")}`,
      status: "pending",
    }),
  );
}
