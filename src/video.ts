import type * as http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults, VideoResponse } from "./types.js";
import {
  isVideoResponse,
  isErrorResponse,
  isJsonObject,
  serializeErrorResponse,
  flattenHeaders,
  getTestId,
  resolveResponse,
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import { renderError } from "./response/errors.js";
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";
import { extractBoundary, extractFormField } from "./transcription.js";

interface VideoRequest {
  model?: string;
  prompt: string;
  [key: string]: unknown;
}

// ─── VideoStateMap with TTL and size bound ────────────────────────────────

const VIDEO_STATE_MAX_ENTRIES = 10_000;
const VIDEO_STATE_TTL_MS = 3_600_000; // 1 hour

interface VideoStateEntry {
  video: VideoResponse["video"];
  createdAt: number;
}

/**
 * A Map wrapper for video state that enforces a maximum size and per-entry TTL.
 * Entries older than VIDEO_STATE_TTL_MS are lazily evicted on `get`.
 * When the map exceeds VIDEO_STATE_MAX_ENTRIES on `set`, the oldest entries
 * are removed to stay within bounds.
 */
export class VideoStateMap {
  private readonly entries = new Map<string, VideoStateEntry>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Proactive sweep every 60 seconds to evict expired entries
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (now - entry.createdAt > VIDEO_STATE_TTL_MS) {
          this.entries.delete(key);
        }
      }
    }, 60_000);
    // Allow the process to exit even if the timer is still running
    if (this.sweepTimer.unref) {
      this.sweepTimer.unref();
    }
  }

  getEntry(key: string): { video: VideoResponse["video"]; createdAtUnix: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > VIDEO_STATE_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return { video: entry.video, createdAtUnix: Math.floor(entry.createdAt / 1000) };
  }

  getCreatedAtUnix(key: string): number | undefined {
    const e = this.getEntry(key);
    return e?.createdAtUnix;
  }

  set(key: string, video: VideoResponse["video"]): void {
    this.entries.set(key, { video, createdAt: Date.now() });
    // Evict oldest entries if over capacity
    if (this.entries.size > VIDEO_STATE_MAX_ENTRIES) {
      const excess = this.entries.size - VIDEO_STATE_MAX_ENTRIES;
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

  destroy(): void {
    clearInterval(this.sweepTimer);
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export async function handleVideoCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  videoStates: VideoStateMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? "/v1/videos";
  const method = req.method ?? "POST";

  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  const isMultipart = (contentType ?? "").toLowerCase().includes("multipart/form-data");

  let videoReq: VideoRequest;
  if (isMultipart) {
    // The OpenAI SDK (6.28.0+) sends POST /v1/videos as multipart/form-data;
    // older SDKs sent JSON for a File-less body. Parse the form fields into the
    // same shape the JSON path produces, reusing the transcription multipart
    // helpers. Numeric fields (e.g. `seconds`) arrive as strings and are
    // coerced to numbers to match the JSON body's types.
    const boundary = extractBoundary(contentType);
    const prompt = extractFormField(raw, "prompt", boundary);
    const model = extractFormField(raw, "model", boundary);
    const size = extractFormField(raw, "size", boundary);
    const secondsRaw = extractFormField(raw, "seconds", boundary);
    videoReq = { prompt: prompt ?? "" };
    if (model !== undefined) videoReq.model = model;
    if (size !== undefined) videoReq.size = size;
    if (secondsRaw !== undefined) {
      const secondsNum = Number(secondsRaw);
      videoReq.seconds = Number.isNaN(secondsNum) ? secondsRaw : secondsNum;
    }
  } else {
    try {
      videoReq = JSON.parse(raw) as VideoRequest;
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
        renderError("openai", "validation", {
          message: `Malformed JSON: ${detail}`,
          type: "invalid_request_error",
          code: "invalid_json",
        }).body,
      );
      return;
    }
  }

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `videoReq.prompt` throws a TypeError that
  // surfaces as a 500 instead of a 400. The multipart branch above builds its
  // own object and needs no guard.
  if (!isJsonObject(videoReq)) {
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
      renderError("openai", "validation", {
        message: "Request body must be a JSON object",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  if (!videoReq.prompt) {
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
      renderError("openai", "validation", {
        message: "Missing required parameter: 'prompt'",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  const prompt = videoReq.prompt;
  const validParts =
    Array.isArray(prompt) &&
    prompt.length > 0 &&
    prompt.every(
      (part: unknown) =>
        isJsonObject(part) &&
        typeof part.type === "string" &&
        (!("text" in part) || typeof part.text === "string"),
    );
  if (typeof prompt !== "string" && !validParts) {
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
      renderError("openai", "validation", {
        message:
          "Invalid parameter: 'prompt' must be a string or a non-empty array of content parts",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  const syntheticReq: ChatCompletionRequest = {
    model: videoReq.model ?? "sora-2",
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
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      fixture ? "fixture" : "proxy",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    const fixtureMiss = resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss;
    if (fixtureMiss) {
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
        renderError("openai", "strict-miss", {
          message: strictMessage,
          type: "invalid_request_error",
          code: "no_fixture_match",
        }).body,
      );
      return;
    }
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        "openai",
        req.url ?? "/v1/videos",
        fixtures,
        defaults,
        raw,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method,
          path,
          headers: flattenHeaders(req.headers),
          body: syntheticReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
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
      renderError("openai", "fixture-miss", {
        message: "No fixture matched",
        type: "invalid_request_error",
        code: "no_fixture_match",
      }).body,
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
      renderError("openai", "unknown-response", {
        message: "Fixture response is not a video type",
        type: "server_error",
      }).body,
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

  const video = response.video;

  // Store for GET status checks
  const stateKey = `${testId}:${video.id}`;
  videoStates.set(stateKey, video);
  const created_at = videoStates.getCreatedAtUnix(stateKey)!;

  if (video.status === "completed") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: video.id, status: video.status, url: video.url, created_at }));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: video.id, status: video.status, created_at }));
  }
}

export async function handleVideoStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  videoId: string,
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  videoStates: VideoStateMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? `/v1/videos/${videoId}`;
  const method = req.method ?? "GET";

  if (
    await applyChaosAsync(
      res,
      null,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: null },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  const testId = getTestId(req);
  const stateKey = `${testId}:${videoId}`;
  const entry = videoStates.getEntry(stateKey);

  if (!entry) {
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
      renderError("openai", "route-failure", {
        message: `Video ${videoId} not found`,
        type: "not_found",
      }).body,
    );
    return;
  }

  const { video, createdAtUnix: created_at } = entry;

  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null },
  });

  const body: Record<string, unknown> = {
    id: video.id,
    status: video.status,
    created_at,
  };
  if (video.url) body.url = video.url;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
