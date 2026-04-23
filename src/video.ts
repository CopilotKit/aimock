import type * as http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults, VideoResponse } from "./types.js";
import { isVideoResponse, isErrorResponse, flattenHeaders, getTestId } from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

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

  get(key: string): VideoResponse["video"] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > VIDEO_STATE_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.video;
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

  let videoReq: VideoRequest;
  try {
    videoReq = JSON.parse(raw) as VideoRequest;
  } catch {
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
        error: { message: "Malformed JSON", type: "invalid_request_error", code: "invalid_json" },
      }),
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
      JSON.stringify({
        error: { message: "Missing required parameter: 'prompt'", type: "invalid_request_error" },
      }),
    );
    return;
  }

  const syntheticReq: ChatCompletionRequest = {
    model: videoReq.model ?? "sora-2",
    messages: [{ role: "user", content: videoReq.prompt }],
    _endpointType: "video",
  };

  const testId = getTestId(req);
  const fixture = matchFixture(
    fixtures,
    syntheticReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      const proxied = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        "openai",
        req.url ?? "/v1/videos",
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
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

    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: strictStatus, fixture: null },
    });
    writeErrorResponse(
      res,
      strictStatus,
      JSON.stringify({
        error: { message: strictMessage, type: "invalid_request_error", code: "no_fixture_match" },
      }),
    );
    return;
  }

  const response = fixture.response;

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
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

  const video = response.video;
  const created_at = Math.floor(Date.now() / 1000);

  // Store for GET status checks
  const stateKey = `${testId}:${video.id}`;
  videoStates.set(stateKey, video);

  if (video.status === "completed") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: video.id, status: video.status, url: video.url, created_at }));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: video.id, status: video.status, created_at }));
  }
}

export function handleVideoStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  videoId: string,
  journal: Journal,
  setCorsHeaders: (res: http.ServerResponse) => void,
  videoStates: VideoStateMap,
): void {
  setCorsHeaders(res);
  const path = req.url ?? `/v1/videos/${videoId}`;
  const method = req.method ?? "GET";

  const testId = getTestId(req);
  const stateKey = `${testId}:${videoId}`;
  const video = videoStates.get(stateKey);

  if (!video) {
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
      JSON.stringify({ error: { message: `Video ${videoId} not found`, type: "not_found" } }),
    );
    return;
  }

  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null },
  });

  const created_at = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    id: video.id,
    status: video.status,
    created_at,
  };
  if (video.url) body.url = video.url;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
