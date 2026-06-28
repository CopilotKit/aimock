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
import { readEnvelopeText, upstreamTimeoutSignal } from "./video-proxy-shared.js";

/**
 * Google Veo async video lifecycle mock. Submit
 * `POST /v1beta/models/{model}:predictLongRunning` returns
 * `{ name: "operations/..." }`; status `GET /v1beta/operations/{name}` polls
 * `done:false → done:true`. The Files-API `uri` is served AS-IS — aimock does
 * NOT proxy or capture video bytes. With `record.providers.veo` configured an
 * unmatched submit becomes a live interactive proxy (submit + poll forwarded
 * 1:1, eager fixture capture on terminal status). Strict mode still wins.
 *
 * ASSUMED Veo create body shape (the `@google/genai` :predictLongRunning
 * envelope from issue #278): `{ instances: [{ prompt, image? }], parameters }`.
 * Match surface is `instances[0].prompt` only.
 */

/** Files-API-shaped placeholder served when a completed fixture omits a uri. */
const DEFAULT_VEO_FILES_URI = "https://generativelanguage.googleapis.com/v1beta/files/placeholder";

// The `:predictLongRunning` envelope nests the prompt under instances[].
interface VeoVideoRequest {
  instances?: Array<{ prompt?: unknown; [key: string]: unknown }>;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── VeoVideoJobMap (TTL + bounded) ─────────────────────────────────────────

export const VEO_VIDEO_MAX_ENTRIES = 10_000;
const VEO_VIDEO_TTL_MS = 3_600_000; // 1 hour

type VeoVideoStatus = "pending" | "in_progress" | "completed" | "failed";

interface VeoVideoReplayJob {
  kind: "replay";
  operationName: string;
  status: VeoVideoStatus;
  pollCount: number;
  pollsBeforeInProgress: number;
  pollsBeforeCompleted: number;
  video: VideoResponse["video"];
  /** Latch for the empty-`error` authoring warn on failed polls (once/job). */
  emptyErrorWarned?: boolean;
}

interface VeoVideoRecordJob {
  kind: "record";
  operationName: string;
  status: VeoVideoStatus;
  upstreamOperationName: string;
  upstreamPollingUrl: string;
  match: Fixture["match"];
  capturing?: boolean;
}

export type VeoVideoJob = VeoVideoReplayJob | VeoVideoRecordJob;

interface VeoVideoEntry {
  job: VeoVideoJob;
  createdAt: number;
}

/**
 * Per-testId job state for the Veo video handler. Mirrors OpenRouterVideoJobMap
 * (openrouter-video.ts): lazy TTL eviction on `get`, FIFO eviction of the
 * oldest entries on `set` when over capacity, delete-before-set TTL refresh,
 * monotonic world-generation counter for reset-mid-flight detection, no
 * background sweep timer. Keys are `${testId}:${operationName}`.
 */
export class VeoVideoJobMap {
  private readonly entries = new Map<string, VeoVideoEntry>();
  private worldGeneration = 0;

  get generation(): number {
    return this.worldGeneration;
  }

  get(key: string): VeoVideoJob | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > VEO_VIDEO_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.job;
  }

  set(key: string, job: VeoVideoJob): void {
    this.entries.delete(key);
    this.entries.set(key, { job, createdAt: Date.now() });
    if (this.entries.size > VEO_VIDEO_MAX_ENTRIES) {
      const excess = this.entries.size - VEO_VIDEO_MAX_ENTRIES;
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
function terminalStatus(job: VeoVideoReplayJob): VeoVideoStatus {
  return job.video.status === "failed" ? "failed" : "completed";
}

/**
 * Mutates a job in place to advance its state on a status poll.
 * `pending → in_progress → completed | failed` based on poll-count thresholds.
 * No-op once terminal. The in_progress threshold is checked first so a job
 * whose thresholds are equal still spends one poll in in_progress instead of
 * jumping straight to the terminal status (fal advanceJob semantics). The wire
 * value is derived from this internal status (pending/in_progress → done:false,
 * completed/failed → done:true).
 */
function advanceVeoJob(job: VeoVideoReplayJob): void {
  if (job.status === "completed" || job.status === "failed") return;

  job.pollCount += 1;
  if (job.status === "pending" && job.pollCount >= job.pollsBeforeInProgress) {
    job.status = "in_progress";
  } else if (job.pollCount >= job.pollsBeforeCompleted) {
    job.status = terminalStatus(job);
  }
}

/** Gemini-style error envelope used by every Veo error response. */
function geminiError(code: number, message: string, status: string): string {
  return JSON.stringify({ error: { code, message, status } });
}

/**
 * The done:true operation body for a completed replay job — the Files-API uri
 * is served as-is (the fixture's stored `video.url`, or the documented
 * placeholder when omitted).
 */
function completedOperationBody(operationName: string, uri: string): Record<string, unknown> {
  return {
    name: operationName,
    done: true,
    response: {
      generateVideoResponse: {
        generatedSamples: [{ video: { uri } }],
      },
    },
  };
}

// ─── POST /v1beta/models/{model}:predictLongRunning — submit ─────────────────

export async function handleVeoVideoCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  model: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: VeoVideoJobMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? `/v1beta/models/${model}:predictLongRunning`;
  const method = req.method ?? "POST";

  let videoReq: VeoVideoRequest;
  try {
    videoReq = JSON.parse(raw) as VeoVideoRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(res, 400, geminiError(400, `Malformed JSON: ${detail}`, "INVALID_ARGUMENT"));
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
      geminiError(400, "Request body must be a JSON object", "INVALID_ARGUMENT"),
    );
    return;
  }

  // Prompt lives at instances[0].prompt (the @google/genai envelope).
  const firstInstance = Array.isArray(videoReq.instances) ? videoReq.instances[0] : undefined;
  const prompt = firstInstance?.prompt;
  // Synthesize a structurally valid journal body for field-validation 400s
  // (JournalEntry.body is ChatCompletionRequest | null). Strip reserved
  // underscore-prefixed keys so a request cannot spoof handler discriminators.
  const sanitized = Object.fromEntries(
    Object.entries(videoReq).filter(([key]) => !key.startsWith("_")),
  );
  const parsedBody: ChatCompletionRequest = { ...sanitized, model, messages: [] };

  if (typeof prompt !== "string" || !prompt) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: parsedBody,
      response: { status: 400, fixture: null },
    });
    const message =
      prompt === undefined
        ? "Missing required parameter: 'instances[0].prompt'"
        : "Invalid type for parameter: 'instances[0].prompt' must be a non-empty string";
    writeErrorResponse(res, 400, geminiError(400, message, "INVALID_ARGUMENT"));
    return;
  }

  const syntheticReq: ChatCompletionRequest = {
    model,
    messages: [{ role: "user", content: prompt }],
    _endpointType: "video",
    _videoProvider: "veo",
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
    defaults.logger.debug(
      `No fixture matched for Veo request (model=${model}, msg="${prompt.slice(0, 80)}")`,
    );
  }

  // Chaos rolls AFTER body validation and fixture matching (mirrors the
  // OpenRouter submit). An unmatched submit is proxied upstream when record
  // mode has a veo provider AND strict would not win — label that roll "proxy".
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
          : defaults.record?.providers.veo
            ? "proxy"
            : "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    // Strict mode wins over record: a strict no-match fails loudly with 503.
    if (resolveStrictMode(defaults.strict, req.headers)) {
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
      writeErrorResponse(res, 503, geminiError(503, strictMessage, "UNAVAILABLE"));
      return;
    }

    if (defaults.record) {
      const outcome = await proxyVeoVideoSubmit({
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
    writeErrorResponse(res, 404, geminiError(404, "No fixture matched", "NOT_FOUND"));
    return;
  }

  // World-generation snapshot (mirrors the record-submit guard): a fixtures
  // reset can land while the fixture's ResponseFactory below is awaited, and
  // the job insertion at the bottom must not seed the NEW world.
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
      geminiError(500, "Fixture response is not a video type", "INTERNAL"),
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
      `Veo video fixture has status "processing" — treated as completed for the operations lifecycle`,
    );
  } else if (fixtureStatus !== "completed" && fixtureStatus !== "failed") {
    defaults.logger.warn(
      `Veo video fixture has unknown status "${fixtureStatus}" — treating as completed`,
    );
  }

  const operationName = `operations/${crypto.randomUUID()}`;
  const progression = resolveProgression(defaults.veoVideo);
  const job: VeoVideoReplayJob = {
    kind: "replay",
    operationName,
    status: "pending",
    pollCount: 0,
    pollsBeforeInProgress: progression.pollsBeforeInProgress,
    pollsBeforeCompleted: progression.pollsBeforeCompleted,
    video: { ...response.video },
  };
  // Default 0/0 progression seeds the job terminal at submit; the submit
  // envelope still reports a not-done operation.
  if (progression.pollsBeforeCompleted === 0) {
    job.status = terminalStatus(job);
  }
  if (jobs.generation === worldGeneration) {
    jobs.set(`${testId}:${operationName}`, job);
  } else {
    defaults.logger.warn(
      `Veo video submit resolved after a fixtures reset — not inserting operation ${operationName} into the new world (its polls will 404)`,
    );
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ name: operationName }));
}

// ─── GET /v1beta/operations/{name} — status poll ─────────────────────────────

export async function handleVeoVideoStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  operationName: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: VeoVideoJobMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? `/v1beta/${operationName}`;
  const method = req.method ?? "GET";

  // Chaos rolls BEFORE the job lookup — the label stays "internal" even in
  // record mode, and a chaos-dropped poll never reaches the upstream.
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
  const key = `${testId}:${operationName}`;
  const job = jobs.get(key);

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
      geminiError(404, `Operation ${operationName} not found`, "NOT_FOUND"),
    );
    return;
  }

  if (job.kind === "record") {
    // Strict means nothing reaches an upstream — a record job's polls are pure
    // upstream proxies, so an effective-strict request is refused with 503.
    if (resolveStrictMode(defaults.strict, req.headers)) {
      defaults.logger.error(
        `STRICT: Veo operation ${operationName} is proxied live upstream (record mode) — refusing the upstream poll`,
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
        geminiError(
          503,
          `Strict mode: Veo operation ${operationName} is proxied live upstream (record mode) — nothing reaches an upstream under strict mode`,
          "UNAVAILABLE",
        ),
      );
      return;
    }
    await proxyVeoVideoRecordPoll({
      req,
      res,
      job,
      key,
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

  // Guard BEFORE advancing or journaling (file convention): a disconnected
  // client consumes no progression step or TTL refresh.
  if (res.destroyed || res.writableEnded) return;
  advanceVeoJob(job);
  // Refresh the TTL on every replay poll (delete-before-set also moves the
  // entry to the back of the FIFO eviction order).
  jobs.set(key, job);
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null },
  });

  let body: Record<string, unknown>;
  if (job.status === "completed") {
    // Truthy guard (not `??`): an empty-string fixture url must still fall back
    // to the placeholder Files-API uri rather than being served as an empty uri.
    const rawUrl = job.video.url;
    body = completedOperationBody(
      operationName,
      typeof rawUrl === "string" && rawUrl ? rawUrl : DEFAULT_VEO_FILES_URI,
    );
  } else if (job.status === "failed") {
    if (job.video.error === "" && !job.emptyErrorWarned) {
      job.emptyErrorWarned = true;
      defaults.logger.warn(
        `Veo video fixture for operation ${operationName} has an empty error message — using the default`,
      );
    }
    body = {
      name: operationName,
      done: true,
      error: { code: 3, message: job.video.error || "Video generation failed" },
    };
  } else {
    body = { name: operationName, done: false };
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── Record mode: live interactive proxy (submit) ───────────────────────────

/**
 * Proxy an unmatched Veo submit to the configured upstream and answer the
 * client with a mock-rewritten envelope: a fresh aimock operation name. The
 * upstream lifecycle is driven interactively by the client's own polls.
 *
 * Returns "no_upstream" when record mode has no veo provider URL — the caller
 * falls through to its 404 branch (fal convention).
 */
async function proxyVeoVideoSubmit(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  raw: string;
  syntheticReq: ChatCompletionRequest;
  record: RecordConfig;
  journal: Journal;
  defaults: HandlerDefaults;
  jobs: VeoVideoJobMap;
  method: string;
  path: string;
}): Promise<"handled" | "no_upstream"> {
  const { req, res, raw, syntheticReq, record, journal, defaults, jobs, method, path } = args;

  const upstreamBase = record.providers.veo;
  if (!upstreamBase) {
    defaults.logger.warn(`No upstream URL configured for provider "veo" — cannot proxy`);
    return "no_upstream";
  }

  const proxyError = (msg: string): "handled" => {
    defaults.logger.error(`Veo video submit proxy failed: ${msg}`);
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

  const submitPath = `/v1beta/models/${syntheticReq.model}:predictLongRunning`;
  let submitUrl: URL;
  let upstreamOrigin: string;
  try {
    submitUrl = resolveUpstreamUrl(upstreamBase, submitPath);
    upstreamOrigin = new URL(upstreamBase).origin;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return proxyError(`Invalid upstream URL: ${upstreamBase} (${msg})`);
  }

  defaults.logger.warn(
    `NO FIXTURE MATCH — proxying Veo video submit to ${upstreamBase}${submitPath}`,
  );

  // World-generation snapshot: a fixtures reset landing during the upstream
  // fetch clears the job map — the insertion guard compares against this.
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
    return proxyError(err instanceof Error ? err.message : "Unknown proxy error");
  }

  if (fetched.status === 401 || fetched.status === 403) {
    // Real-API fidelity: relay an upstream auth rejection verbatim.
    defaults.logger.warn(
      `Upstream rejected the Veo video submit (${fetched.status}) — relaying the upstream status`,
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

  let upstreamOperationName: string;
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
    upstreamOperationName = String((parsed as Record<string, unknown>).name ?? "").trim();
    if (!upstreamOperationName) {
      return proxyError("Submit response missing name");
    }
  }

  // Veo has no polling_url field — the poll URL is constructed from the
  // provider base + `/v1beta/{operationName}`. Origin-validate the constructed
  // URL (the client's Authorization travels to it on every poll); fall back to
  // a string on the provider base on any parse failure.
  let upstreamPollingUrl: string;
  try {
    const constructed = resolveUpstreamUrl(
      upstreamBase,
      `/v1beta/${upstreamOperationName.replace(/^\/+/, "")}`,
    );
    if (constructed.origin === upstreamOrigin) {
      upstreamPollingUrl = constructed.toString();
    } else {
      defaults.logger.warn(
        `Constructed Veo poll URL origin ${constructed.origin} differs from the configured provider origin ${upstreamOrigin} — using the provider-origin URL`,
      );
      upstreamPollingUrl = `${upstreamOrigin}/v1beta/${upstreamOperationName.replace(/^\/+/, "")}`;
    }
  } catch {
    defaults.logger.warn(
      `Could not construct the Veo poll URL for ${upstreamOperationName} — using the provider-origin URL`,
    );
    upstreamPollingUrl = `${upstreamOrigin}/v1beta/${upstreamOperationName.replace(/^\/+/, "")}`;
  }

  const testId = getTestId(req);
  const matchRequest = defaults.requestTransform
    ? defaults.requestTransform(syntheticReq)
    : syntheticReq;
  const operationName = `operations/${crypto.randomUUID()}`;
  const job: VeoVideoRecordJob = {
    kind: "record",
    operationName,
    status: "pending",
    upstreamOperationName,
    upstreamPollingUrl,
    match: buildFixtureMatch(matchRequest, record),
  };
  if (jobs.generation === worldGeneration) {
    jobs.set(`${testId}:${operationName}`, job);
  } else {
    defaults.logger.warn(
      `Veo video submit for upstream operation ${upstreamOperationName} completed after a fixtures reset — not inserting the job into the new world (its polls will 404)`,
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
  res.end(JSON.stringify({ name: operationName }));
  return "handled";
}

// ─── Record mode: live interactive proxy (poll + eager capture) ─────────────

/**
 * Proxy a status poll for a record-mode Veo job 1:1 to the upstream and relay
 * the result with the operation name rewritten to the mock operation (the
 * Files-API uri inside `response` passes through verbatim — aimock never
 * downloads bytes). When the upstream reports `done:true` with a `response`,
 * the rewritten body is relayed IMMEDIATELY and the eager capture (persist the
 * uri as a fixture, mutate to a terminal replay job) runs DETACHED. A
 * `done:true` with an `error` persists a failed fixture synchronously. Under
 * `record.proxyOnly` nothing is captured, persisted, or mutated. Every
 * post-await map mutation is identity-guarded.
 */
async function proxyVeoVideoRecordPoll(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  job: VeoVideoRecordJob;
  key: string;
  testId: string;
  fixtures: Fixture[];
  journal: Journal;
  defaults: HandlerDefaults;
  jobs: VeoVideoJobMap;
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
    logger.error(`Veo video poll proxy failed: ${msg}`);
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

  // Recording can be disabled mid-flight — an orphaned record job must fail
  // loudly before contacting the upstream.
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
      `Upstream rejected the Veo status poll for operation ${job.upstreamOperationName} (${fetched.status}) — relaying the upstream status`,
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

  // Rewrite ONLY the top-level operation name so no upstream identifier
  // escapes — the `response` (carrying the Files-API uri the client needs) and
  // every other field pass through verbatim.
  const relayBody: Record<string, unknown> = { ...upstreamBody, name: job.operationName };

  const relayJson = (): void => {
    if (res.destroyed || res.writableEnded) return;
    journalProxy(200);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(relayBody));
  };

  const done = upstreamBody.done === true;
  const upstreamError = upstreamBody.error;
  const hasError =
    upstreamError !== undefined && upstreamError !== null && typeof upstreamError === "object";

  if (!done) {
    // Non-terminal: identity-guarded status write + TTL refresh, relay.
    if (jobs.get(key) === job) {
      if (!job.capturing && job.status !== "completed" && job.status !== "failed") {
        job.status = "in_progress";
      }
      jobs.set(key, job);
    }
    relayJson();
    return;
  }

  if (hasError) {
    // Terminal failure: persist a failed fixture synchronously (mirrors the
    // OpenRouter failed branch), then relay.
    if (record.proxyOnly) {
      if (jobs.get(key) === job) {
        job.status = "failed";
        jobs.set(key, job);
      }
      relayJson();
      return;
    }
    if (jobs.get(key) !== job) {
      // A concurrent terminal poll already persisted/replaced the entry, or a
      // fixtures reset cleared the world — relay without a duplicate fixture.
      relayJson();
      return;
    }
    const errObj = upstreamError as Record<string, unknown>;
    const rawMessage = errObj.message;
    const error = typeof rawMessage === "string" && rawMessage ? rawMessage : undefined;
    const video: VideoResponse["video"] = {
      id: job.upstreamOperationName,
      status: "failed",
      ...(error !== undefined ? { error } : {}),
    };
    const persistResult = persistFixture({
      record,
      providerKey: "veo",
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
      operationName: job.operationName,
      status: "failed",
      pollCount: 0,
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 0,
      video: { ...video },
    });
    relayJson();
    return;
  }

  // Terminal success (done:true with a response).
  if (record.proxyOnly) {
    if (jobs.get(key) === job) {
      job.status = "completed";
      jobs.set(key, job);
    }
    relayJson();
    return;
  }

  if (job.capturing || jobs.get(key) !== job) {
    // A concurrent poll already entered the capture sequence, or this
    // reference is detached — relay without starting a second capture and
    // never re-insert the stale object.
    if (jobs.get(key) === job) {
      jobs.set(key, job); // TTL refresh
    }
    relayJson();
    return;
  }

  // Open the capturing window SYNCHRONOUSLY before the first await.
  job.capturing = true;
  job.status = "completed";
  jobs.set(key, job); // TTL refresh — identity-checked above, no await since

  // Relay IMMEDIATELY; the persist + replay mutation runs DETACHED.
  relayJson();

  void captureVeoVideoRecordFixture({
    job,
    key,
    testId,
    fixtures,
    defaults,
    jobs,
    record,
    upstreamBody,
  });
}

/**
 * Detached eager-capture for a completed Veo record job. Extracts the
 * Files-API uri from the terminal poll body (NO download), persists a
 * fixture, and mutates the map entry into a terminal replay job. Every failure
 * is handled internally; the returned promise NEVER rejects. World-generation
 * guarded immediately before persist.
 */
async function captureVeoVideoRecordFixture(args: {
  job: VeoVideoRecordJob;
  key: string;
  testId: string;
  fixtures: Fixture[];
  defaults: HandlerDefaults;
  jobs: VeoVideoJobMap;
  record: RecordConfig;
  upstreamBody: Record<string, unknown>;
}): Promise<void> {
  const { job, key, testId, fixtures, defaults, jobs, record, upstreamBody } = args;
  const logger = defaults.logger;

  try {
    // Drill into response.generateVideoResponse.generatedSamples[0].video.uri.
    let uri: string | undefined;
    const response = upstreamBody.response;
    if (response !== null && typeof response === "object" && !Array.isArray(response)) {
      const gvr = (response as Record<string, unknown>).generateVideoResponse;
      if (gvr !== null && typeof gvr === "object" && !Array.isArray(gvr)) {
        const samples = (gvr as Record<string, unknown>).generatedSamples;
        const first = Array.isArray(samples) ? samples[0] : undefined;
        if (first !== null && typeof first === "object" && !Array.isArray(first)) {
          const video = (first as Record<string, unknown>).video;
          if (video !== null && typeof video === "object" && !Array.isArray(video)) {
            const rawUri = (video as Record<string, unknown>).uri;
            if (typeof rawUri === "string" && rawUri) uri = rawUri;
          }
        }
      }
    }
    if (!uri) {
      logger.warn(
        `Upstream Veo operation ${job.upstreamOperationName} completed without a usable Files-API uri — capture skipped, nothing persisted; the next completed poll retries`,
      );
      return;
    }

    const video: VideoResponse["video"] = {
      id: job.upstreamOperationName,
      status: "completed",
      url: uri,
    };

    // World-generation guard: a fixtures reset landing during the await above
    // clears the job map — map identity is a valid proxy for "same world".
    if (jobs.get(key) !== job) {
      logger.warn(
        `Veo video capture for operation ${job.upstreamOperationName} discarded: the job map no longer holds this job (fixtures reset or TTL eviction) — nothing persisted`,
      );
      return;
    }
    persistFixture({
      record,
      providerKey: "veo",
      testId,
      fixture: { match: job.match, response: { video } },
      fixtures,
      logger,
    });

    // Mutate the entry into a terminal replay job: later polls serve locally.
    if (jobs.get(key) === job) {
      jobs.set(key, {
        kind: "replay",
        operationName: job.operationName,
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
      `Veo video capture for operation ${job.upstreamOperationName} failed unexpectedly (${msg}) — fixture not persisted; the job keeps proxying live`,
    );
  } finally {
    // Close the capturing window when the map still holds this record job (a
    // step threw before the replay mutation). On the success path the entry
    // was just replaced; the detached object deliberately keeps capturing=true.
    if (jobs.get(key) === job) {
      job.capturing = false;
    }
  }
}
