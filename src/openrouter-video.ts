import type * as http from "node:http";
import crypto from "node:crypto";
import type { ChatCompletionRequest, Fixture, HandlerDefaults, VideoResponse } from "./types.js";
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

const OPENROUTER_VIDEO_MAX_ENTRIES = 10_000;
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
  createdAt: number;
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

function requestBase(req: http.IncomingMessage): string {
  // Honor x-forwarded-proto so generated URLs survive a TLS-terminating
  // proxy in front of the mock. First value wins on comma-joined lists.
  const fwdProto = req.headers["x-forwarded-proto"];
  const protoRaw = Array.isArray(fwdProto) ? fwdProto[0] : fwdProto;
  const proto = protoRaw?.split(",")[0]?.trim() || "http";
  return `${proto}://${req.headers.host ?? "localhost"}`;
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
      `${requestBase(req)}/api/v1/videos/${job.jobId}/content?index=0${testIdSuffix(testId, "&")}`,
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
  if (!req.headers.authorization?.startsWith("Bearer ")) {
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

  const bytes = job.video.b64 ? Buffer.from(job.video.b64, "base64") : PLACEHOLDER_MP4;

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
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  setCorsHeaders(res);
  const path = req.url ?? "/api/v1/videos/models";
  const method = req.method ?? "GET";

  const modelIds = new Set<string>();
  for (const f of fixtures) {
    if (f.match.endpoint === "video" && typeof f.match.model === "string") {
      modelIds.add(f.match.model);
    }
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

  if (typeof videoReq.prompt !== "string" || !videoReq.prompt) {
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
        error: { message: "Missing required parameter: 'prompt'", type: "invalid_request_error" },
      }),
    );
    return;
  }

  if (videoReq.model !== undefined && typeof videoReq.model !== "string") {
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
          message: "Invalid type for parameter: 'model' must be a string",
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
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    defaults.logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    defaults.logger.debug(`No fixture matched for request`);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      fixture ? "fixture" : "proxy",
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

  const jobId = crypto.randomUUID();
  const progression = resolveProgression(defaults.openRouterVideo);
  const job: OpenRouterVideoJob = {
    jobId,
    status: "pending",
    pollCount: 0,
    pollsBeforeInProgress: progression.pollsBeforeInProgress,
    pollsBeforeCompleted: progression.pollsBeforeCompleted,
    video: response.video,
    createdAt: Date.now(),
  };
  // Default 0/0 progression reaches the terminal status on the first poll —
  // seed terminal directly (mirrors fal's COMPLETED-on-submit initial status);
  // the submit envelope still reports "pending" like the real API.
  if (progression.pollsBeforeCompleted === 0) {
    job.status = terminalStatus(job);
  }
  jobs.set(`${testId}:${jobId}`, job);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: jobId,
      polling_url: `${requestBase(req)}/api/v1/videos/${jobId}${testIdSuffix(testId, "?")}`,
      status: "pending",
    }),
  );
}
