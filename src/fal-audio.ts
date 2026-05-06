import type http from "node:http";
import crypto from "node:crypto";
import type { AudioResponse, ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import {
  isAudioResponse,
  isErrorResponse,
  FORMAT_TO_CONTENT_TYPE,
  getTestId,
  resolveResponse,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { proxyAndRecord } from "./recorder.js";
import type { Journal } from "./journal.js";

// ─── FalJobMap with TTL and size bound ───────────────────────────────────

const FAL_JOB_MAX_ENTRIES = 10_000;
const FAL_JOB_TTL_MS = 3_600_000; // 1 hour

interface FalJob {
  requestId: string;
  modelId: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  result: Record<string, unknown> | null;
  createdAt: number;
}

interface FalJobEntry {
  job: FalJob;
  createdAt: number;
}

/**
 * A Map wrapper for fal.ai queue jobs that enforces a maximum size and per-entry TTL.
 * Entries older than FAL_JOB_TTL_MS are lazily evicted on `get`.
 * When the map exceeds FAL_JOB_MAX_ENTRIES on `set`, the oldest entries
 * are removed to stay within bounds.
 */
export class FalJobMap {
  private readonly entries = new Map<string, FalJobEntry>();

  get(key: string): FalJob | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > FAL_JOB_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.job;
  }

  set(key: string, job: FalJob): void {
    this.entries.set(key, { job, createdAt: Date.now() });
    // Evict oldest entries if over capacity
    if (this.entries.size > FAL_JOB_MAX_ENTRIES) {
      const excess = this.entries.size - FAL_JOB_MAX_ENTRIES;
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

// Module-level singleton — exported so server.ts can clear it during reset
export const falJobs = new FalJobMap();

// ─── Audio response translation ──────────────────────────────────────────

export function audioToFalFile(response: AudioResponse): Record<string, unknown> {
  let contentType: string;
  let data: string;

  if (typeof response.audio === "string") {
    data = response.audio;
    contentType = FORMAT_TO_CONTENT_TYPE[response.format ?? "mp3"] ?? "audio/mpeg";
  } else {
    data = response.audio.b64Json;
    contentType = response.audio.contentType ?? "audio/mpeg";
  }

  const ext =
    response.format ??
    (contentType !== "audio/mpeg"
      ? (Object.entries(FORMAT_TO_CONTENT_TYPE).find(([, v]) => v === contentType)?.[0] ?? "mp3")
      : "mp3");

  const fileSize =
    Math.ceil((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

  return {
    audio: {
      url: `https://mock.fal.media/files/generated_audio.${ext}`,
      content_type: contentType,
      file_name: `generated_audio.${ext}`,
      file_size: fileSize,
    },
  };
}

// ─── Route patterns ──────────────────────────────────────────────────────

const QUEUE_SUBMIT_RE = /^\/fal\/queue\/submit\/(.+)$/;
const QUEUE_STATUS_RE = /^\/fal\/queue\/requests\/([^/]+)\/status$/;
const QUEUE_RESULT_RE = /^\/fal\/queue\/requests\/([^/]+)$/;
const QUEUE_CANCEL_RE = /^\/fal\/queue\/requests\/([^/]+)\/cancel$/;
const SYNC_RUN_RE = /^\/fal\/run\/(.+)$/;

// ─── Handler ─────────────────────────────────────────────────────────────

export async function handleFalQueue(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  pathname: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<void> {
  const testId = getTestId(req);
  const matchCounts = journal.getFixtureMatchCountsForTest(testId);

  // ── Queue Submit ───────────────────────────────────────────────────
  const submitMatch = QUEUE_SUBMIT_RE.exec(pathname);
  if (submitMatch && req.method === "POST") {
    const modelId = submitMatch[1];
    return handleQueueSubmit(
      req,
      res,
      body,
      pathname,
      modelId,
      testId,
      fixtures,
      defaults,
      matchCounts,
      journal,
    );
  }

  // ── Queue Status ───────────────────────────────────────────────────
  const statusMatch = QUEUE_STATUS_RE.exec(pathname);
  if (statusMatch) {
    const requestId = statusMatch[1];
    return handleQueueStatus(req, res, pathname, requestId, testId, journal);
  }

  // ── Queue Cancel ───────────────────────────────────────────────────
  const cancelMatch = QUEUE_CANCEL_RE.exec(pathname);
  if (cancelMatch) {
    const requestId = cancelMatch[1];
    return handleQueueCancel(req, res, pathname, requestId, testId, journal);
  }

  // ── Queue Result ───────────────────────────────────────────────────
  const resultMatch = QUEUE_RESULT_RE.exec(pathname);
  if (resultMatch) {
    const requestId = resultMatch[1];
    return handleQueueResult(req, res, pathname, requestId, testId, journal);
  }

  // ── Synchronous Run ────────────────────────────────────────────────
  const runMatch = SYNC_RUN_RE.exec(pathname);
  if (runMatch && req.method === "POST") {
    const modelId = runMatch[1];
    return handleSyncRun(
      req,
      res,
      body,
      pathname,
      modelId,
      fixtures,
      defaults,
      matchCounts,
      journal,
    );
  }

  // Unknown fal path
  const errorBody = { error: { message: "Unknown fal.ai endpoint", type: "not_found" } };
  journal.add({
    method: req.method ?? "GET",
    path: pathname,
    headers: {},
    body: null,
    response: { status: 404, fixture: null },
  });
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(errorBody));
}

// ─── Sub-handlers ────────────────────────────────────────────────────────

async function handleQueueSubmit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  pathname: string,
  modelId: string,
  testId: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  matchCounts: Map<Fixture, number>,
  journal: Journal,
): Promise<void> {
  let parsed: Record<string, unknown> = {};
  if (body.trim()) {
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      journal.add({
        method: req.method ?? "POST",
        path: pathname,
        headers: {},
        body: null,
        response: { status: 400, fixture: null },
      });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Malformed JSON", type: "invalid_request_error" },
        }),
      );
      return;
    }
  }

  const prompt =
    (typeof parsed.prompt === "string" ? parsed.prompt : null) ??
    (typeof parsed.text === "string" ? parsed.text : null) ??
    "";

  const syntheticReq: ChatCompletionRequest = {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    _endpointType: "fal-audio",
  };

  const fixture = matchFixture(fixtures, syntheticReq, matchCounts, defaults.requestTransform);

  if (!fixture) {
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        "fal",
        pathname,
        fixtures,
        defaults,
        body,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome === "relayed") {
        journal.add({
          method: req.method ?? "POST",
          path: pathname,
          headers: {},
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
      method: req.method ?? "POST",
      path: pathname,
      headers: {},
      body: syntheticReq,
      response: { status: strictStatus, fixture: null },
    });
    res.writeHead(strictStatus, { "Content-Type": "application/json" });
    res.end(
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

  journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  const response = await resolveResponse(fixture, syntheticReq);

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path: pathname,
      headers: {},
      body: syntheticReq,
      response: { status, fixture },
    });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  if (!isAudioResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path: pathname,
      headers: {},
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Fixture response is not an audio type", type: "server_error" },
      }),
    );
    return;
  }

  const requestId = crypto.randomUUID();
  const result = audioToFalFile(response);

  const job: FalJob = {
    requestId,
    modelId,
    status: "COMPLETED",
    result,
    createdAt: Date.now(),
  };

  const stateKey = `${testId}:${requestId}`;
  falJobs.set(stateKey, job);

  journal.add({
    method: req.method ?? "POST",
    path: pathname,
    headers: {},
    body: syntheticReq,
    response: { status: 200, fixture },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      request_id: requestId,
      response_url: `https://queue.fal.run/${modelId}/requests/${requestId}/response`,
      status_url: `https://queue.fal.run/${modelId}/requests/${requestId}/status`,
      cancel_url: `https://queue.fal.run/${modelId}/requests/${requestId}/cancel`,
      queue_position: 0,
    }),
  );
}

function handleQueueStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  requestId: string,
  testId: string,
  journal: Journal,
): void {
  const stateKey = `${testId}:${requestId}`;
  const job = falJobs.get(stateKey);

  if (!job) {
    journal.add({
      method: req.method ?? "GET",
      path: pathname,
      headers: {},
      body: null,
      response: { status: 404, fixture: null },
    });
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `Request ${requestId} not found`, type: "not_found" },
      }),
    );
    return;
  }

  journal.add({
    method: req.method ?? "GET",
    path: pathname,
    headers: {},
    body: null,
    response: { status: 200, fixture: null },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: job.status,
      request_id: job.requestId,
      response_url: `https://queue.fal.run/${job.modelId}/requests/${requestId}/response`,
    }),
  );
}

function handleQueueResult(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  requestId: string,
  testId: string,
  journal: Journal,
): void {
  const stateKey = `${testId}:${requestId}`;
  const job = falJobs.get(stateKey);

  if (!job) {
    journal.add({
      method: req.method ?? "GET",
      path: pathname,
      headers: {},
      body: null,
      response: { status: 404, fixture: null },
    });
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `Request ${requestId} not found`, type: "not_found" },
      }),
    );
    return;
  }

  journal.add({
    method: req.method ?? "GET",
    path: pathname,
    headers: {},
    body: null,
    response: { status: 200, fixture: null },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(job.result));
}

function handleQueueCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  requestId: string,
  testId: string,
  journal: Journal,
): void {
  const stateKey = `${testId}:${requestId}`;
  const job = falJobs.get(stateKey);

  if (!job) {
    journal.add({
      method: req.method ?? "DELETE",
      path: pathname,
      headers: {},
      body: null,
      response: { status: 404, fixture: null },
    });
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "NOT_FOUND" }));
    return;
  }

  // Since we complete immediately, cancellation always returns ALREADY_COMPLETED
  journal.add({
    method: req.method ?? "DELETE",
    path: pathname,
    headers: {},
    body: null,
    response: { status: 400, fixture: null },
  });
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ALREADY_COMPLETED" }));
}

async function handleSyncRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  pathname: string,
  modelId: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  matchCounts: Map<Fixture, number>,
  journal: Journal,
): Promise<void> {
  let parsed: Record<string, unknown> = {};
  if (body.trim()) {
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      journal.add({
        method: req.method ?? "POST",
        path: pathname,
        headers: {},
        body: null,
        response: { status: 400, fixture: null },
      });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Malformed JSON", type: "invalid_request_error" },
        }),
      );
      return;
    }
  }

  const prompt =
    (typeof parsed.prompt === "string" ? parsed.prompt : null) ??
    (typeof parsed.text === "string" ? parsed.text : null) ??
    "";

  const syntheticReq: ChatCompletionRequest = {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    _endpointType: "fal-audio",
  };

  const fixture = matchFixture(fixtures, syntheticReq, matchCounts, defaults.requestTransform);

  if (!fixture) {
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        "fal",
        pathname,
        fixtures,
        defaults,
        body,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome === "relayed") {
        journal.add({
          method: req.method ?? "POST",
          path: pathname,
          headers: {},
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
      method: req.method ?? "POST",
      path: pathname,
      headers: {},
      body: syntheticReq,
      response: { status: strictStatus, fixture: null },
    });
    res.writeHead(strictStatus, { "Content-Type": "application/json" });
    res.end(
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

  journal.incrementFixtureMatchCount(fixture, fixtures, getTestId(req));
  const response = await resolveResponse(fixture, syntheticReq);

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path: pathname,
      headers: {},
      body: syntheticReq,
      response: { status, fixture },
    });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  if (!isAudioResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path: pathname,
      headers: {},
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Fixture response is not an audio type", type: "server_error" },
      }),
    );
    return;
  }

  const result = audioToFalFile(response);

  journal.add({
    method: req.method ?? "POST",
    path: pathname,
    headers: {},
    body: syntheticReq,
    response: { status: 200, fixture },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}
