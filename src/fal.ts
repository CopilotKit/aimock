import type http from "node:http";
import crypto from "node:crypto";
import type {
  ChatCompletionRequest,
  FalQueueConfig,
  Fixture,
  HandlerDefaults,
  ImageItem,
  ImageResponse,
  RawJSONResponse,
  VideoResponse,
} from "./types.js";
import {
  isAudioResponse,
  isErrorResponse,
  serializeErrorResponse,
  isJSONResponse,
  flattenHeaders,
  getContext,
  getTestId,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { writeErrorResponse } from "./sse-writer.js";
import { matchFixtureDiagnostic } from "./router.js";
import { buildFixtureMatch, persistFixture, proxyAndRecord } from "./recorder.js";
import { resolveUpstreamUrl } from "./url.js";
import type { Journal } from "./journal.js";
import { audioToFalFile } from "./fal-audio.js";

// ─── FalQueueState (TTL + bounded) ───────────────────────────────────────

const FAL_QUEUE_MAX_ENTRIES = 10_000;
const FAL_QUEUE_TTL_MS = 3_600_000; // 1 hour

type FalQueueStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

interface FalQueueJob {
  requestId: string;
  modelId: string;
  status: FalQueueStatus;
  result: unknown;
  /** Number of `/status` (or `/{id}`) polls the caller has made against this job. */
  pollCount: number;
  /** Poll-count threshold for `IN_QUEUE → IN_PROGRESS` transition. */
  pollsBeforeInProgress: number;
  /** Poll-count threshold for `IN_PROGRESS → COMPLETED` transition. */
  pollsBeforeCompleted: number;
  submittedAt: number;
  completedAt: number | null;
  /** State-transition log entries surfaced in the `/status` response. */
  logs: Array<{ timestamp: string; level: string; message: string }>;
  createdAt: number;
}

interface FalQueueEntry {
  job: FalQueueJob;
  createdAt: number;
}

/**
 * Per-testId queue state for the general fal handler. Mirrors FalJobMap from
 * fal-audio.ts but stores arbitrary JSON payloads instead of audio file
 * objects, so it can serve any fal model (image, video, motion, music, etc.).
 */
export class FalQueueStateMap {
  private readonly entries = new Map<string, FalQueueEntry>();

  get(key: string): FalQueueJob | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > FAL_QUEUE_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.job;
  }

  set(key: string, job: FalQueueJob): void {
    this.entries.set(key, { job, createdAt: Date.now() });
    if (this.entries.size > FAL_QUEUE_MAX_ENTRIES) {
      const excess = this.entries.size - FAL_QUEUE_MAX_ENTRIES;
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

export const falQueueStates = new FalQueueStateMap();

// ─── Typed-response → fal envelope converters ───────────────────────────

function extractExtension(url: string, fallback: string): { fileName: string; ext: string } {
  const segment = url.split("?")[0].split("#")[0].split("/").pop() ?? "";
  const fileName = segment.length > 0 ? segment : "";
  const dotIdx = fileName.lastIndexOf(".");
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : fallback;
  return { fileName, ext };
}

function imageItemToFalImage(item: ImageItem, index: number): Record<string, unknown> {
  const url = item.url ?? `https://mock.fal.media/files/generated_image_${index}.png`;
  const { ext } = extractExtension(url, "png");
  const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  return {
    url,
    width: 1024,
    height: 1024,
    content_type: contentType,
  };
}

/**
 * Translate an `ImageResponse` fixture into fal's image envelope shape:
 * `{ images: [...], timings, seed, has_nsfw_concepts, prompt }`.
 * Used by `LLMock.onFalImage` to keep callers from re-deriving the wire shape.
 */
export function imageResponseToFalJson(response: ImageResponse): Record<string, unknown> {
  const items = response.images ?? (response.image ? [response.image] : []);
  const images = items.map((item, i) => imageItemToFalImage(item, i));
  return {
    images,
    timings: { inference: 0 },
    seed: 0,
    has_nsfw_concepts: images.map(() => false),
    prompt: "",
  };
}

/**
 * Translate a `VideoResponse` fixture into fal's video envelope shape:
 * `{ video: { url, content_type, file_name, file_size }, seed }`.
 */
export function videoResponseToFalJson(response: VideoResponse): Record<string, unknown> {
  const url = response.video.url ?? "https://mock.fal.media/files/generated_video.mp4";
  const { fileName, ext } = extractExtension(url, "mp4");
  return {
    video: {
      url,
      content_type: `video/${ext}`,
      file_name: fileName || "generated_video.mp4",
      file_size: 0,
    },
    seed: 0,
  };
}

// ─── Queue progression ─────────────────────────────────────────────────

export function resolveProgression(config: FalQueueConfig | undefined): {
  pollsBeforeInProgress: number;
  pollsBeforeCompleted: number;
} {
  // Thresholds must resolve to non-negative integers: a NaN would make
  // advanceJob's `pollCount >= threshold` comparison permanently false (a
  // polling client never reaches terminal), and a negative would break the
  // documented "explicit 0 enables progression" contract. Non-finite values
  // are treated as unset; anything else is floored and clamped to >= 0.
  const sanitize = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : undefined;
  const explicitInProgress = sanitize(config?.pollsBeforeInProgress);
  const explicitCompleted = sanitize(config?.pollsBeforeCompleted);
  const pollsBeforeInProgress = explicitInProgress ?? 0;
  // When only pollsBeforeInProgress is set, default pollsBeforeCompleted to one
  // poll later so the job actually passes through IN_PROGRESS. When the caller
  // sets both explicitly, clamp completed >= inProgress so a misconfigured
  // pair (e.g. completed < inProgress) can't silently skip the IN_PROGRESS
  // transition. When neither is set, both stay 0 (completes on submit).
  let pollsBeforeCompleted: number;
  if (explicitCompleted !== undefined) {
    pollsBeforeCompleted = Math.max(pollsBeforeInProgress, explicitCompleted);
  } else if (explicitInProgress !== undefined) {
    pollsBeforeCompleted = pollsBeforeInProgress + 1;
  } else {
    pollsBeforeCompleted = 0;
  }
  return { pollsBeforeInProgress, pollsBeforeCompleted };
}

/**
 * Mutates a job in place to advance its state on a status/result poll.
 * IN_QUEUE → IN_PROGRESS → COMPLETED based on poll-count thresholds. No-op
 * once COMPLETED or CANCELLED.
 */
function advanceJob(job: FalQueueJob): void {
  if (job.status === "COMPLETED" || job.status === "CANCELLED") return;

  job.pollCount += 1;
  // Check IN_PROGRESS before COMPLETED so a job whose thresholds are equal
  // still spends one poll in IN_PROGRESS instead of jumping straight to
  // COMPLETED.
  if (job.status === "IN_QUEUE" && job.pollCount >= job.pollsBeforeInProgress) {
    job.status = "IN_PROGRESS";
    job.logs.push({
      timestamp: new Date().toISOString(),
      level: "INFO",
      message: "Job started processing.",
    });
  } else if (job.pollCount >= job.pollsBeforeCompleted) {
    job.status = "COMPLETED";
    job.completedAt = Date.now();
    job.logs.push({
      timestamp: new Date().toISOString(),
      level: "INFO",
      message: "Job completed.",
    });
  }
}

function queuePosition(job: FalQueueJob): number {
  if (job.status !== "IN_QUEUE") return 0;
  return Math.max(0, job.pollsBeforeInProgress - job.pollCount);
}

function statusResponseBody(job: FalQueueJob): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status: job.status,
    request_id: job.requestId,
    response_url: `https://${FAL_HOSTS.queue}/${job.modelId}/requests/${job.requestId}`,
    logs: job.logs,
  };
  if (job.status === "IN_QUEUE" || job.status === "IN_PROGRESS") {
    body.queue_position = queuePosition(job);
  }
  if (job.status === "COMPLETED" && job.completedAt != null) {
    body.metrics = {
      inference_time: (job.completedAt - job.submittedAt) / 1000,
    };
  }
  return body;
}

// ─── Hosts and routing ──────────────────────────────────────────────────

const FAL_HOSTS = {
  queue: "queue.fal.run",
  sync: "fal.run",
  storage: "rest.fal.ai",
  storageAlpha: "rest.alpha.fal.ai",
  gateway: "gateway.fal.ai",
} as const;

const QUEUE_REQUESTS_RE = /^(.+)\/requests\/([^/]+)(\/status|\/cancel)?$/;
const STORAGE_INITIATE_PATH = "/storage/upload/initiate";

function stripFalPrefix(pathname: string): string {
  const stripped = pathname.replace(/^\/fal/, "");
  return stripped.length > 0 ? stripped : "/";
}

function extractPromptFromBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const obj = body as Record<string, unknown>;
  if (typeof obj.prompt === "string") return obj.prompt;
  if (typeof obj.text === "string") return obj.text;
  const input = obj.input;
  if (input && typeof input === "object") {
    const inputObj = input as Record<string, unknown>;
    if (typeof inputObj.prompt === "string") return inputObj.prompt;
    if (typeof inputObj.text === "string") return inputObj.text;
  }
  return "";
}

interface ParsedFalPath {
  modelId: string;
  requestId?: string;
  action?: "status" | "cancel" | "result";
}

function parseFalPath(stripped: string): ParsedFalPath | null {
  if (!stripped.startsWith("/")) return null;
  const trimmed = stripped.replace(/^\/+/, "");
  if (!trimmed) return null;

  const m = QUEUE_REQUESTS_RE.exec(`/${trimmed}`);
  if (m) {
    const modelId = m[1].replace(/^\/+/, "");
    const action = m[3] === "/status" ? "status" : m[3] === "/cancel" ? "cancel" : "result";
    return { modelId, requestId: m[2], action };
  }
  return { modelId: trimmed };
}

export type HandleFalOutcome = "handled" | "passthrough";

interface FalRouteInfo {
  kind: "queue-submit" | "queue-status" | "queue-result" | "queue-cancel" | "sync-run" | "storage";
  modelId?: string;
  requestId?: string;
  targetHost: string;
}

function classifyRoute(
  req: http.IncomingMessage,
  pathname: string,
  targetHost: string,
): FalRouteInfo | null {
  const stripped = stripFalPrefix(pathname);

  if (targetHost === FAL_HOSTS.storage || targetHost === FAL_HOSTS.storageAlpha) {
    if (req.method === "POST" && stripped === STORAGE_INITIATE_PATH) {
      return { kind: "storage", targetHost };
    }
    return null;
  }

  const parsed = parseFalPath(stripped);
  if (!parsed) return null;

  if (targetHost === FAL_HOSTS.queue) {
    if (parsed.requestId) {
      if (parsed.action === "status" && req.method === "GET") {
        return {
          kind: "queue-status",
          modelId: parsed.modelId,
          requestId: parsed.requestId,
          targetHost,
        };
      }
      if (parsed.action === "cancel" && req.method === "PUT") {
        return {
          kind: "queue-cancel",
          modelId: parsed.modelId,
          requestId: parsed.requestId,
          targetHost,
        };
      }
      if (parsed.action === "result" && req.method === "GET") {
        return {
          kind: "queue-result",
          modelId: parsed.modelId,
          requestId: parsed.requestId,
          targetHost,
        };
      }
      return null;
    }
    if (req.method === "POST") {
      return { kind: "queue-submit", modelId: parsed.modelId, targetHost };
    }
    return null;
  }

  if (targetHost === FAL_HOSTS.sync) {
    if (req.method === "POST" && parsed.modelId) {
      return { kind: "sync-run", modelId: parsed.modelId, targetHost };
    }
    return null;
  }

  return null;
}

/**
 * General fal.ai handler. Routes by `x-fal-target-host` header (the convention
 * used by `@fal-ai/client`'s server-side requestMiddleware workaround for the
 * fact that `proxyUrl` is browser-only).
 *
 * Returns `"passthrough"` when the request does not look like a host-mirrored
 * fal call, so the caller can fall back to the legacy `/fal/queue/...` and
 * `/fal/run/...` audio routes.
 */
export async function handleFal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  pathname: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<HandleFalOutcome> {
  const targetHostHeader = req.headers["x-fal-target-host"];
  const targetHost = Array.isArray(targetHostHeader) ? targetHostHeader[0] : targetHostHeader;
  if (!targetHost) return "passthrough";

  const route = classifyRoute(req, pathname, targetHost);
  if (!route) return "passthrough";

  const testId = getTestId(req);
  const stateKey = (id: string) => `${testId}:${id}`;

  switch (route.kind) {
    case "queue-status": {
      const job = falQueueStates.get(stateKey(route.requestId!));
      if (!job) {
        respondNotFound(req, res, pathname, journal, route.requestId!);
        return "handled";
      }
      advanceJob(job);
      writeJson(req, res, 200, statusResponseBody(job), pathname, journal);
      return "handled";
    }

    case "queue-result": {
      const job = falQueueStates.get(stateKey(route.requestId!));
      if (!job) {
        respondNotFound(req, res, pathname, journal, route.requestId!);
        return "handled";
      }
      // Callers may fetch result without first polling status — advance so
      // tests that skip the status check still reach completion.
      advanceJob(job);
      if (job.status !== "COMPLETED") {
        writeJson(req, res, 202, statusResponseBody(job), pathname, journal);
        return "handled";
      }
      writeJson(req, res, 200, job.result, pathname, journal);
      return "handled";
    }

    case "queue-cancel": {
      const job = falQueueStates.get(stateKey(route.requestId!));
      if (!job) {
        journal.add({
          method: req.method ?? "PUT",
          path: pathname,
          headers: flattenHeaders(req.headers),
          body: null,
          response: { status: 404, fixture: null },
        });
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "NOT_FOUND" }));
        return "handled";
      }
      if (job.status === "COMPLETED") {
        journal.add({
          method: req.method ?? "PUT",
          path: pathname,
          headers: flattenHeaders(req.headers),
          body: null,
          response: { status: 400, fixture: null },
        });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ALREADY_COMPLETED" }));
        return "handled";
      }
      if (job.status === "CANCELLED") {
        journal.add({
          method: req.method ?? "PUT",
          path: pathname,
          headers: flattenHeaders(req.headers),
          body: null,
          response: { status: 200, fixture: null },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "CANCELLED" }));
        return "handled";
      }
      job.status = "CANCELLED";
      job.logs.push({
        timestamp: new Date().toISOString(),
        level: "INFO",
        message: "Job cancelled.",
      });
      journal.add({
        method: req.method ?? "PUT",
        path: pathname,
        headers: flattenHeaders(req.headers),
        body: null,
        response: { status: 200, fixture: null },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "CANCELLED" }));
      return "handled";
    }

    case "storage": {
      let filename = "upload.bin";
      try {
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        if (typeof parsed.filename === "string") filename = parsed.filename;
        if (typeof parsed.file_name === "string") filename = parsed.file_name;
      } catch {
        // ignore — stub doesn't require a structured body
      }
      const fileId = crypto.randomUUID();
      const responseBody = {
        upload_url: `https://${route.targetHost}/storage/upload/${fileId}`,
        file_url: `https://${route.targetHost}/files/${fileId}/${filename}`,
      };
      writeJson(req, res, 200, responseBody, pathname, journal);
      return "handled";
    }

    case "queue-submit":
    case "sync-run": {
      const modelId = route.modelId!;
      let parsedBody: Record<string, unknown> | null;
      try {
        parsedBody = parseBody(body);
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Invalid JSON body";
        journal.add({
          method: req.method ?? "POST",
          path: pathname,
          headers: flattenHeaders(req.headers),
          body: null,
          response: { status: 400, fixture: null },
        });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: detail,
              type: "invalid_request_error",
              code: "invalid_json",
            },
          }),
        );
        return "handled";
      }
      const prompt = extractPromptFromBody(parsedBody);
      const syntheticReq: ChatCompletionRequest = {
        model: modelId,
        messages: [{ role: "user", content: prompt || JSON.stringify(parsedBody ?? {}) }],
        _endpointType: "fal",
        _context: getContext(req),
      };

      const matchCounts = journal.getFixtureMatchCountsForTest(testId);
      const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
        fixtures,
        syntheticReq,
        matchCounts,
        defaults.requestTransform,
      );

      if (!fixture) {
        const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
        if (effectiveStrict) {
          const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
          defaults.logger.error(
            strictNoMatchLogLine(req.method ?? "POST", pathname, skippedBySequenceOrTurn),
          );
          journal.add({
            method: req.method ?? "POST",
            path: pathname,
            headers: flattenHeaders(req.headers),
            body: syntheticReq,
            response: {
              status: 503,
              fixture: null,
              ...strictOverrideField(defaults.strict, req.headers),
            },
          });
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: strictMessage,
                type: "invalid_request_error",
                code: "no_fixture_match",
              },
            }),
          );
          return "handled";
        }
        if (defaults.record) {
          const effectiveDefaults = withFalUpstream(defaults, route.targetHost);
          // queue-submit must walk the queue upstream (submit → poll status →
          // get result) before persisting, so the fixture stores the FINAL job
          // body, not the IN_QUEUE envelope. sync-run is already a single
          // request/response cycle and the generic recorder handles it.
          if (route.kind === "queue-submit") {
            const outcome = await proxyAndRecordFalQueueSubmit({
              req,
              res,
              syntheticReq,
              modelId,
              pathname,
              strippedPath: stripFalPrefix(pathname),
              body,
              fixtures,
              defaults: effectiveDefaults,
              stateKey,
              journal,
            });
            if (outcome === "handled") return "handled";
            // outcome === "no_upstream" — fall through to strict/404
          } else {
            const outcome = await proxyAndRecord(
              req,
              res,
              syntheticReq,
              "fal",
              stripFalPrefix(pathname),
              fixtures,
              effectiveDefaults,
              body,
            );
            if (outcome === "handled_by_hook") return "handled";
            if (outcome !== "not_configured") {
              journal.add({
                method: req.method ?? "POST",
                path: pathname,
                headers: flattenHeaders(req.headers),
                body: syntheticReq,
                response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
              });
              return "handled";
            }
          }
        }

        journal.add({
          method: req.method ?? "POST",
          path: pathname,
          headers: flattenHeaders(req.headers),
          body: syntheticReq,
          response: {
            status: 404,
            fixture: null,
            ...strictOverrideField(defaults.strict, req.headers),
          },
        });
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "No fixture matched",
              type: "invalid_request_error",
              code: "no_fixture_match",
            },
          }),
        );
        return "handled";
      }

      journal.incrementFixtureMatchCount(fixture, fixtures, testId);
      const response = await resolveResponse(fixture, syntheticReq);

      if (isErrorResponse(response)) {
        const status = response.status ?? 500;
        journal.add({
          method: req.method ?? "POST",
          path: pathname,
          headers: flattenHeaders(req.headers),
          body: syntheticReq,
          response: { status, fixture },
        });
        writeErrorResponse(res, status, serializeErrorResponse(response), {
          retryAfter: response.retryAfter,
        });
        return "handled";
      }

      let payload: unknown;
      if (isJSONResponse(response)) {
        payload = (response as RawJSONResponse).json;
      } else if (isAudioResponse(response)) {
        payload = audioToFalFile(response);
      } else {
        journal.add({
          method: req.method ?? "POST",
          path: pathname,
          headers: flattenHeaders(req.headers),
          body: syntheticReq,
          response: { status: 500, fixture },
        });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Fixture response is not JSON or audio for fal endpoint",
              type: "server_error",
            },
          }),
        );
        return "handled";
      }

      if (route.kind === "sync-run") {
        journal.add({
          method: req.method ?? "POST",
          path: pathname,
          headers: flattenHeaders(req.headers),
          body: syntheticReq,
          response: { status: 200, fixture },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return "handled";
      }

      const requestId = crypto.randomUUID();
      const progression = resolveProgression(defaults.falQueue);
      const now = Date.now();
      const initialStatus: FalQueueStatus =
        progression.pollsBeforeCompleted === 0 ? "COMPLETED" : "IN_QUEUE";
      const job: FalQueueJob = {
        requestId,
        modelId,
        status: initialStatus,
        result: payload,
        pollCount: 0,
        pollsBeforeInProgress: progression.pollsBeforeInProgress,
        pollsBeforeCompleted: progression.pollsBeforeCompleted,
        submittedAt: now,
        completedAt: initialStatus === "COMPLETED" ? now : null,
        logs: [
          {
            timestamp: new Date(now).toISOString(),
            level: "INFO",
            message: "Job enqueued.",
          },
        ],
        createdAt: now,
      };
      falQueueStates.set(stateKey(requestId), job);
      const envelope = {
        request_id: requestId,
        response_url: `https://${FAL_HOSTS.queue}/${modelId}/requests/${requestId}`,
        status_url: `https://${FAL_HOSTS.queue}/${modelId}/requests/${requestId}/status`,
        cancel_url: `https://${FAL_HOSTS.queue}/${modelId}/requests/${requestId}/cancel`,
        queue_position: queuePosition(job),
      };
      journal.add({
        method: req.method ?? "POST",
        path: pathname,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: 200, fixture },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(envelope));
      return "handled";
    }
  }
}

function parseBody(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    throw new Error(`Malformed JSON: ${detail}`);
  }
}

// ─── Queue-walk recording ──────────────────────────────────────────────
//
// The fal queue protocol surfaces three endpoints — submit (POST), status
// (GET, polled), and result (GET) — but at the fixture layer we only store ONE
// thing: the FINAL job body. A naive `proxyAndRecord` against submit would
// persist the IN_QUEUE envelope, which is useless to replay (the SDK polls
// status and then reads the result body, expecting `{ images: [...] }`-shaped
// model output, not an envelope). So during recording we walk the upstream
// queue ourselves, capture the result body, and write THAT as the fixture —
// then synthesise the local envelope the same way the replay path does.

const DEFAULT_FAL_POLL_INTERVAL_MS = 1000;
// Video generations (kling, veo, runway, etc.) routinely take 5–10 minutes
// on the upstream queue; 15 min gives headroom without trapping a genuinely
// hung job indefinitely.
const DEFAULT_FAL_TIMEOUT_MS = 900_000;

// Hop-by-hop and client-set headers excluded from upstream forwarding.
// Mirrors STRIP_HEADERS in recorder.ts.
const FAL_STRIP_FORWARD_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "host",
  "content-length",
  "cookie",
  "accept-encoding",
]);

export function buildFalForwardHeaders(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, val] of Object.entries(req.headers)) {
    if (val === undefined) continue;
    if (FAL_STRIP_FORWARD_HEADERS.has(name.toLowerCase())) continue;
    out[name] = Array.isArray(val) ? val.join(", ") : val;
  }
  return out;
}

/**
 * Walk a fal-shaped queue protocol upstream: POST submit, poll status until
 * COMPLETED, GET final result body. Returns the parsed final body so the caller
 * can persist it as the fixture and seed local queue state.
 *
 * Decoupled from the route layer so the legacy `/fal/queue/submit/{model}`
 * audio path (`fal-audio.ts`) can reuse the same logic.
 */
export async function walkFalQueue(args: {
  upstreamBase: string;
  submitPath: string;
  body: string;
  headers: Record<string, string>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /**
   * Build the status-poll URL from `request_id` when upstream's submit
   * response doesn't return a usable `status_url`. The legacy path uses
   * aimock-internal `/fal/queue/requests/<id>/status` rather than fal.ai's
   * `/<model>/requests/<id>/status` layout.
   */
  fallbackStatusPath: (requestId: string) => string;
  fallbackResultPath: (requestId: string) => string;
}): Promise<unknown> {
  const {
    upstreamBase,
    submitPath,
    body,
    headers,
    pollIntervalMs = DEFAULT_FAL_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_FAL_TIMEOUT_MS,
    fallbackStatusPath,
    fallbackResultPath,
  } = args;

  const deadline = Date.now() + timeoutMs;

  // ── 1. POST submit ────────────────────────────────────────────────
  const submitUrl = resolveUpstreamUrl(upstreamBase, submitPath);
  const submitRes = await fetch(submitUrl, { method: "POST", headers, body });
  const submitText = await submitRes.text();
  if (!submitRes.ok) {
    throw new Error(`Submit ${submitRes.status}: ${submitText.slice(0, 200)}`);
  }
  const submitJson = parseJsonOrThrow(submitText, "Submit");
  const env = submitJson as Record<string, unknown>;
  const upstreamRequestId = String(env.request_id ?? "").trim();
  if (!upstreamRequestId) {
    throw new Error("Submit response missing request_id");
  }

  // Prefer the URLs upstream returned — a proxy in front of fal.ai may sit on
  // a different host than the canonical `queue.fal.run` — and only fall back
  // to constructed paths if the envelope omits them.
  const envStatusUrl = env.status_url;
  const envResponseUrl = env.response_url;
  const statusUrl =
    typeof envStatusUrl === "string" && envStatusUrl
      ? new URL(envStatusUrl)
      : resolveUpstreamUrl(upstreamBase, fallbackStatusPath(upstreamRequestId));
  const resultUrl =
    typeof envResponseUrl === "string" && envResponseUrl
      ? new URL(envResponseUrl)
      : resolveUpstreamUrl(upstreamBase, fallbackResultPath(upstreamRequestId));

  // ── 2. Poll status until COMPLETED ───────────────────────────────
  while (true) {
    if (Date.now() > deadline) throw new Error(`Queue walk timed out after ${timeoutMs}ms`);
    const statusRes = await fetch(statusUrl, { headers });
    const statusText = await statusRes.text();
    if (!statusRes.ok) {
      throw new Error(`Status ${statusRes.status}: ${statusText.slice(0, 200)}`);
    }
    const statusJson = parseJsonOrThrow(statusText, "Status") as Record<string, unknown>;
    const s = String(statusJson.status ?? "");
    if (s === "COMPLETED") break;
    if (s === "FAILED" || s === "ERROR" || s === "CANCELLED") {
      throw new Error(`Upstream job terminated with status ${s}`);
    }
    const remaining = deadline - Date.now();
    const sleep = Math.min(pollIntervalMs, Math.max(0, remaining));
    if (sleep <= 0) throw new Error(`Queue walk timed out after ${timeoutMs}ms`);
    await new Promise<void>((r) => setTimeout(r, sleep));
  }

  // ── 3. GET final result ──────────────────────────────────────────
  const resultRes = await fetch(resultUrl, { headers });
  const resultText = await resultRes.text();
  if (!resultRes.ok) {
    throw new Error(`Result ${resultRes.status}: ${resultText.slice(0, 200)}`);
  }
  return parseJsonOrThrow(resultText, "Result");
}

async function proxyAndRecordFalQueueSubmit(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  syntheticReq: ChatCompletionRequest;
  modelId: string;
  pathname: string;
  strippedPath: string;
  body: string;
  fixtures: Fixture[];
  defaults: HandlerDefaults;
  stateKey: (id: string) => string;
  journal: Journal;
}): Promise<"handled" | "no_upstream"> {
  const {
    req,
    res,
    syntheticReq,
    modelId,
    pathname,
    strippedPath,
    body,
    fixtures,
    defaults,
    stateKey,
    journal,
  } = args;

  const record = defaults.record;
  if (!record) return "no_upstream";
  const upstreamBase = record.providers.fal;
  if (!upstreamBase) {
    defaults.logger.warn(`No upstream URL configured for provider "fal" — cannot proxy`);
    return "no_upstream";
  }

  defaults.logger.warn(`NO FIXTURE MATCH — walking fal queue at ${upstreamBase}${strippedPath}`);

  let finalBody: unknown;
  try {
    finalBody = await walkFalQueue({
      upstreamBase,
      submitPath: strippedPath,
      body,
      headers: buildFalForwardHeaders(req),
      pollIntervalMs: record.fal?.pollIntervalMs,
      timeoutMs: record.fal?.timeoutMs,
      fallbackStatusPath: (id) => `${modelId}/requests/${id}/status`,
      fallbackResultPath: (id) => `${modelId}/requests/${id}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown queue-walk error";
    defaults.logger.error(`fal queue-walk proxy failed: ${msg}`);
    journal.add({
      method: req.method ?? "POST",
      path: pathname,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 502, fixture: null, source: "proxy" },
    });
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `Proxy to upstream failed: ${msg}`, type: "proxy_error" },
      }),
    );
    return "handled";
  }

  // ── 4. Persist fixture using the FINAL body, not the submit envelope ──
  const matchRequest = defaults.requestTransform
    ? defaults.requestTransform(syntheticReq)
    : syntheticReq;
  const fixture: Fixture = {
    match: buildFixtureMatch(matchRequest, record),
    response: { json: finalBody, status: 200 },
  };
  persistFixture({
    record,
    providerKey: "fal",
    testId: getTestId(req),
    fixture,
    fixtures,
    logger: defaults.logger,
  });

  // ── 5. Synthesise envelope + seed state (same shape as the replay path) ──
  const newRequestId = crypto.randomUUID();
  const progression = resolveProgression(defaults.falQueue);
  const now = Date.now();
  const initialStatus: FalQueueStatus =
    progression.pollsBeforeCompleted === 0 ? "COMPLETED" : "IN_QUEUE";
  const job: FalQueueJob = {
    requestId: newRequestId,
    modelId,
    status: initialStatus,
    result: finalBody,
    pollCount: 0,
    pollsBeforeInProgress: progression.pollsBeforeInProgress,
    pollsBeforeCompleted: progression.pollsBeforeCompleted,
    submittedAt: now,
    completedAt: initialStatus === "COMPLETED" ? now : null,
    logs: [{ timestamp: new Date(now).toISOString(), level: "INFO", message: "Job enqueued." }],
    createdAt: now,
  };
  falQueueStates.set(stateKey(newRequestId), job);
  const envelope = {
    request_id: newRequestId,
    response_url: `https://${FAL_HOSTS.queue}/${modelId}/requests/${newRequestId}`,
    status_url: `https://${FAL_HOSTS.queue}/${modelId}/requests/${newRequestId}/status`,
    cancel_url: `https://${FAL_HOSTS.queue}/${modelId}/requests/${newRequestId}/cancel`,
    queue_position: queuePosition(job),
  };
  journal.add({
    method: req.method ?? "POST",
    path: pathname,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture: null, source: "proxy" },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(envelope));
  return "handled";
}

function parseJsonOrThrow(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function withFalUpstream(defaults: HandlerDefaults, targetHost: string): HandlerDefaults {
  if (!defaults.record) return defaults;
  // Respect an explicit record.providers.fal — tests and dev configs need to
  // point at a stub upstream. Only synthesise from the header when the user
  // didn't configure one (the "or omit upstream URL — it's in the request
  // hostname" mode from the issue).
  if (defaults.record.providers.fal) return defaults;
  return {
    ...defaults,
    record: {
      ...defaults.record,
      providers: {
        ...defaults.record.providers,
        fal: `https://${targetHost}`,
      },
    },
  };
}

function writeJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  pathname: string,
  journal: Journal,
): void {
  journal.add({
    method: req.method ?? "GET",
    path: pathname,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status, fixture: null },
  });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function respondNotFound(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  journal: Journal,
  requestId: string,
): void {
  journal.add({
    method: req.method ?? "GET",
    path: pathname,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 404, fixture: null },
  });
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: { message: `Request ${requestId} not found`, type: "not_found" },
    }),
  );
}
