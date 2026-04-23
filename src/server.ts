import * as http from "node:http";
import type {
  Fixture,
  FixtureFileEntry,
  ChatCompletionRequest,
  HandlerDefaults,
  MockServerOptions,
  Mountable,
  RecordProviderKey,
} from "./types.js";
import { Journal } from "./journal.js";
import { matchFixture } from "./router.js";
import { validateFixtures, entryToFixture } from "./fixture-loader.js";
import { writeSSEStream, writeErrorResponse } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import {
  buildTextChunks,
  buildToolCallChunks,
  buildTextCompletion,
  buildToolCallCompletion,
  buildContentWithToolCallsChunks,
  buildContentWithToolCallsCompletion,
  extractOverrides,
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  flattenHeaders,
  getTestId,
} from "./helpers.js";
import { handleResponses } from "./responses.js";
import { handleMessages } from "./messages.js";
import { handleGemini } from "./gemini.js";
import { handleBedrock, handleBedrockStream } from "./bedrock.js";
import { handleConverse, handleConverseStream } from "./bedrock-converse.js";
import { handleEmbeddings } from "./embeddings.js";
import { handleImages } from "./images.js";
import { handleSpeech } from "./speech.js";
import { handleTranscription } from "./transcription.js";
import { handleVideoCreate, handleVideoStatus, VideoStateMap } from "./video.js";
import { handleOllama, handleOllamaGenerate } from "./ollama.js";
import { handleCohere } from "./cohere.js";
import { handleSearch, type SearchFixture } from "./search.js";
import { handleRerank, type RerankFixture } from "./rerank.js";
import { handleModeration, type ModerationFixture } from "./moderation.js";
import { upgradeToWebSocket, type WebSocketConnection } from "./ws-framing.js";
import { handleWebSocketResponses } from "./ws-responses.js";
import { handleWebSocketRealtime } from "./ws-realtime.js";
import { handleWebSocketGeminiLive } from "./ws-gemini-live.js";
import { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { createMetricsRegistry, normalizePathLabel } from "./metrics.js";
import { proxyAndRecord } from "./recorder.js";

export interface ServerInstance {
  server: http.Server;
  journal: Journal;
  url: string;
  defaults: HandlerDefaults;
  videoStates: VideoStateMap;
}

const COMPLETIONS_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";
const REALTIME_PATH = "/v1/realtime";
const GEMINI_LIVE_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MESSAGES_PATH = "/v1/messages";
const EMBEDDINGS_PATH = "/v1/embeddings";
const COHERE_CHAT_PATH = "/v2/chat";
const SEARCH_PATH = "/search";
const RERANK_PATH = "/v2/rerank";
const MODERATIONS_PATH = "/v1/moderations";
const IMAGES_PATH = "/v1/images/generations";
const SPEECH_PATH = "/v1/audio/speech";
const TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";
const VIDEOS_PATH = "/v1/videos";
const VIDEOS_STATUS_RE = /^\/v1\/videos\/([^/]+)$/;
const GEMINI_PREDICT_RE = /^\/v1beta\/models\/([^:]+):predict$/;
const DEFAULT_CHUNK_SIZE = 20;

// OpenAI-compatible endpoint suffixes for path prefix normalization.
// Providers like BigModel (/v4/) use non-standard base URL prefixes.
// Only includes endpoints that third-party OpenAI-compatible providers are
// likely to serve — excludes provider-specific paths (/messages, /realtime)
// and endpoints unlikely to appear behind non-standard prefixes
// (/moderations, /videos, /models).
const COMPAT_SUFFIXES = [
  "/chat/completions",
  "/embeddings",
  "/responses",
  "/audio/speech",
  "/audio/transcriptions",
  "/images/generations",
];

/**
 * Normalize OpenAI-compatible paths with arbitrary prefixes.
 * Strips /openai/ prefix and rewrites paths ending in known suffixes to /v1/<suffix>.
 * Skips /v1/ (already standard) and /v2/ (Cohere convention).
 */
function normalizeCompatPath(pathname: string, logger?: Logger): string {
  // Strip /openai/ prefix (Groq/OpenAI-compat alias)
  if (pathname.startsWith("/openai/")) {
    pathname = pathname.slice("/openai".length);
  }

  // Normalize arbitrary prefixes to /v1/
  if (!pathname.startsWith("/v1/") && !pathname.startsWith("/v2/")) {
    for (const suffix of COMPAT_SUFFIXES) {
      if (pathname.endsWith(suffix)) {
        if (logger) logger.debug(`Path normalized: ${pathname} → /v1${suffix}`);
        pathname = "/v1" + suffix;
        break;
      }
    }
  }

  return pathname;
}

const GEMINI_PATH_RE = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/;
const AZURE_DEPLOYMENT_RE = /^\/openai\/deployments\/([^/]+)\/(chat\/completions|embeddings)$/;
const BEDROCK_INVOKE_RE = /^\/model\/([^/]+)\/invoke$/;
const BEDROCK_STREAM_RE = /^\/model\/([^/]+)\/invoke-with-response-stream$/;
const BEDROCK_CONVERSE_RE = /^\/model\/([^/]+)\/converse$/;
const BEDROCK_CONVERSE_STREAM_RE = /^\/model\/([^/]+)\/converse-stream$/;
const VERTEX_AI_RE =
  /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

const OLLAMA_CHAT_PATH = "/api/chat";
const OLLAMA_GENERATE_PATH = "/api/generate";
const OLLAMA_TAGS_PATH = "/api/tags";

const HEALTH_PATH = "/health";
const READY_PATH = "/ready";
const MODELS_PATH = "/v1/models";
const REQUESTS_PATH = "/v1/_requests";

const DEFAULT_MODELS = [
  "gpt-4",
  "gpt-4o",
  "claude-3-5-sonnet-20241022",
  "gemini-2.0-flash",
  "text-embedding-3-small",
];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function setCorsHeaders(res: http.ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  const buffers: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      req.destroy();
      throw new Error(`Request body exceeded size limit of ${maxBytes} bytes`);
    }
    buffers.push(buf);
  }
  return Buffer.concat(buffers).toString();
}

function handleOptions(res: http.ServerResponse): void {
  setCorsHeaders(res);
  res.writeHead(204);
  res.end();
}

function handleNotFound(res: http.ServerResponse, message: string): void {
  setCorsHeaders(res);
  writeErrorResponse(res, 404, JSON.stringify({ error: { message, type: "not_found" } }));
}

// ---------------------------------------------------------------------------
// /__aimock/* control API — used by aimock-pytest and other test harnesses
// to manage fixtures, journal, and error injection without restarting the
// server.
// ---------------------------------------------------------------------------

const CONTROL_PREFIX = "/__aimock";

/**
 * Handle requests under `/__aimock/`. Returns `true` if the request was
 * handled, `false` if the path doesn't match the control prefix.
 */
async function handleControlAPI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  fixtures: Fixture[],
  journal: Journal,
  videoStates: VideoStateMap,
  defaults: HandlerDefaults,
): Promise<boolean> {
  if (!pathname.startsWith(CONTROL_PREFIX)) return false;

  const subPath = pathname.slice(CONTROL_PREFIX.length);
  setCorsHeaders(res);

  // GET /__aimock/health
  if (subPath === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return true;
  }

  // GET /__aimock/journal
  if (subPath === "/journal" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(journal.getAll()));
    return true;
  }

  // POST /__aimock/fixtures — add fixtures dynamically
  if (subPath === "/fixtures" && req.method === "POST") {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      defaults.logger.error(`POST /__aimock/fixtures: failed to read body: ${msg}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Failed to read request body: ${msg}` }));
      return true;
    }

    let parsed: { fixtures?: FixtureFileEntry[] };
    try {
      parsed = JSON.parse(raw) as { fixtures?: FixtureFileEntry[] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      defaults.logger.error(`POST /__aimock/fixtures: invalid JSON: ${msg}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid JSON: ${msg}` }));
      return true;
    }

    if (!Array.isArray(parsed.fixtures)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid "fixtures" array' }));
      return true;
    }

    const converted = parsed.fixtures.map(entryToFixture);
    const issues = validateFixtures(converted);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Validation failed", details: errors }));
      return true;
    }

    fixtures.push(...converted);
    if (defaults.registry) {
      defaults.registry.setGauge("aimock_fixtures_loaded", {}, fixtures.length);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ added: converted.length }));
    return true;
  }

  // DELETE /__aimock/fixtures — clear all fixtures
  if (subPath === "/fixtures" && req.method === "DELETE") {
    fixtures.length = 0;
    if (defaults.registry) {
      defaults.registry.setGauge("aimock_fixtures_loaded", {}, fixtures.length);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cleared: true }));
    return true;
  }

  // POST /__aimock/reset — clear fixtures + journal + match counts
  if (subPath === "/reset" && req.method === "POST") {
    fixtures.length = 0;
    journal.clear();
    videoStates.clear();
    if (defaults.registry) {
      defaults.registry.setGauge("aimock_fixtures_loaded", {}, fixtures.length);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reset: true }));
    return true;
  }

  // POST /__aimock/error — queue a one-shot error
  if (subPath === "/error" && req.method === "POST") {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      defaults.logger.error(`POST /__aimock/error: failed to read body: ${msg}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Failed to read request body: ${msg}` }));
      return true;
    }

    let parsed: { status?: number; body?: { message?: string; type?: string; code?: string } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      defaults.logger.error(`POST /__aimock/error: invalid JSON: ${msg}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid JSON: ${msg}` }));
      return true;
    }

    const status = parsed.status ?? 500;
    const errorBody = parsed.body;
    const errorFixture: Fixture = {
      match: { predicate: () => true },
      response: {
        error: {
          message: errorBody?.message ?? "Injected error",
          type: errorBody?.type ?? "server_error",
          code: errorBody?.code,
        },
        status,
      },
    };
    // Insert at front so it matches before everything else
    fixtures.unshift(errorFixture);
    // Remove synchronously on first match to prevent race conditions where
    // two concurrent requests both match before the removal fires.
    const original = errorFixture.match.predicate!;
    errorFixture.match.predicate = (req) => {
      const result = original(req);
      if (result) {
        const idx = fixtures.indexOf(errorFixture);
        if (idx !== -1) fixtures.splice(idx, 1);
      }
      return result;
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: true }));
    return true;
  }

  // Unknown control path
  handleNotFound(res, `Unknown control endpoint: ${pathname}`);
  return true;
}

async function handleCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  modelFallback?: string,
  providerKey?: RecordProviderKey,
): Promise<void> {
  setCorsHeaders(res);

  // Read request body
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to read request body";
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 500, fixture: null },
    });
    writeErrorResponse(
      res,
      500,
      JSON.stringify({
        error: {
          message: `Request body read failed: ${msg}`,
          type: "server_error",
        },
      }),
    );
    return;
  }

  // Parse JSON body
  let body: ChatCompletionRequest;
  try {
    body = JSON.parse(raw) as ChatCompletionRequest;
    // Azure deployments may omit model from body — use deployment ID as fallback
    if (modelFallback && !body.model) {
      body.model = modelFallback;
    }
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
          code: "invalid_json",
        },
      }),
    );
    return;
  }

  // Validate messages array
  if (!Array.isArray(body.messages)) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Missing required parameter: 'messages'",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Match fixture
  body._endpointType = "chat";
  const testId = getTestId(req);
  const fixture = matchFixture(
    fixtures,
    body,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  const method = req.method ?? "POST";
  const path = req.url ?? COMPLETIONS_PATH;
  const flatHeaders = flattenHeaders(req.headers);

  // Apply chaos before normal response handling
  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      {
        method,
        path,
        headers: flatHeaders,
        body,
      },
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    // Try record-and-replay proxy if configured
    if (defaults.record && providerKey) {
      const proxied = await proxyAndRecord(
        req,
        res,
        body,
        providerKey,
        req.url ?? COMPLETIONS_PATH,
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
        journal.add({
          method: req.method ?? "POST",
          path: req.url ?? COMPLETIONS_PATH,
          headers: flattenHeaders(req.headers),
          body,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }

    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (defaults.strict) {
      defaults.logger.error(
        `STRICT: No fixture matched for ${req.method ?? "POST"} ${req.url ?? COMPLETIONS_PATH}`,
      );
    }

    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: strictStatus, fixture: null },
    });
    writeErrorResponse(
      res,
      strictStatus,
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

  const response = fixture.response;
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  // Content + tool calls response
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      defaults.logger.warn(
        "webSearches in fixture response are not supported for Chat Completions API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    if (body.stream !== true) {
      const completion = buildContentWithToolCallsCompletion(
        response.content,
        response.toolCalls,
        body.model,
        response.reasoning,
        overrides,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(completion));
    } else {
      const chunks = buildContentWithToolCallsChunks(
        response.content,
        response.toolCalls,
        body.model,
        chunkSize,
        response.reasoning,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeSSEStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
      });
      if (!completed) {
        if (!res.writableEnded) res.destroy();
        journalEntry.response.interrupted = true;
        journalEntry.response.interruptReason = interruption?.reason();
      }
      interruption?.cleanup();
    }
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    if (response.webSearches?.length) {
      defaults.logger.warn(
        "webSearches in fixture response are not supported for Chat Completions API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    if (body.stream !== true) {
      const completion = buildTextCompletion(
        response.content,
        body.model,
        response.reasoning,
        overrides,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(completion));
    } else {
      const chunks = buildTextChunks(
        response.content,
        body.model,
        chunkSize,
        response.reasoning,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeSSEStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
      });
      if (!completed) {
        if (!res.writableEnded) res.destroy();
        journalEntry.response.interrupted = true;
        journalEntry.response.interruptReason = interruption?.reason();
      }
      interruption?.cleanup();
    }
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    if (body.stream !== true) {
      const completion = buildToolCallCompletion(response.toolCalls, body.model, overrides);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(completion));
    } else {
      const chunks = buildToolCallChunks(response.toolCalls, body.model, chunkSize, overrides);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeSSEStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
      });
      if (!completed) {
        if (!res.writableEnded) res.destroy();
        journalEntry.response.interrupted = true;
        journalEntry.response.interruptReason = interruption?.reason();
      }
      interruption?.cleanup();
    }
    return;
  }

  // Fixture response matched no known type — guard against silent hang
  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? COMPLETIONS_PATH,
    headers: flattenHeaders(req.headers),
    body,
    response: { status: 500, fixture },
  });
  writeErrorResponse(
    res,
    500,
    JSON.stringify({
      error: {
        message: "Fixture response did not match any known type",
        type: "server_error",
      },
    }),
  );
}

export interface ServiceFixtures {
  search: SearchFixture[];
  rerank: RerankFixture[];
  moderation: ModerationFixture[];
}

// NOTE: The fixtures array is read by reference on each request. Callers
// (e.g. LLMock) may mutate it after the server starts and changes will
// be visible immediately. This is intentional — do not copy the array.
export async function createServer(
  fixtures: Fixture[],
  options?: MockServerOptions,
  mounts?: Array<{ path: string; handler: Mountable }>,
  serviceFixtures?: ServiceFixtures,
): Promise<ServerInstance> {
  const host = options?.host ?? "127.0.0.1";
  const port = options?.port ?? 0;
  const logger = new Logger(options?.logLevel ?? "silent");
  const registry = options?.metrics ? createMetricsRegistry() : undefined;
  const serverOptions = options ?? {};
  const defaults = {
    latency: serverOptions.latency ?? 0,
    chunkSize: Math.max(1, serverOptions.chunkSize ?? DEFAULT_CHUNK_SIZE),
    logger,
    get chaos() {
      return serverOptions.chaos;
    },
    registry,
    get record() {
      return serverOptions.record;
    },
    get strict() {
      return serverOptions.strict;
    },
    get requestTransform() {
      return serverOptions.requestTransform;
    },
  };

  // Validate chaos config rates
  if (options?.chaos) {
    const chaosRates = [
      { name: "dropRate", value: options.chaos.dropRate },
      { name: "malformedRate", value: options.chaos.malformedRate },
      { name: "disconnectRate", value: options.chaos.disconnectRate },
    ];
    for (const { name, value } of chaosRates) {
      if (value !== undefined && (value < 0 || value > 1)) {
        logger.warn(`Chaos ${name} (${value}) is outside 0-1 range — will be clamped at runtime`);
      }
    }
  }

  // Programmatic default: finite caps so long-running embedders don't inherit
  // an unbounded journal / fixture-count map. Callers that need unbounded
  // retention (e.g. short-lived test harnesses) can opt in by passing 0.
  const journal = new Journal({
    maxEntries: options?.journalMaxEntries ?? 1000,
    fixtureCountsMaxTestIds: options?.fixtureCountsMaxTestIds ?? 500,
  });
  const videoStates = new VideoStateMap();

  // Share journal and metrics registry with mounted services
  if (mounts) {
    for (const { handler } of mounts) {
      if (handler.setJournal) handler.setJournal(journal);
      if (registry && handler.setRegistry) handler.setRegistry(registry);
    }
  }

  // Set initial fixtures-loaded gauge
  if (registry) {
    registry.setGauge("aimock_fixtures_loaded", {}, fixtures.length);
  }

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    // Delegate to async handler — catch unhandled rejections to prevent Node.js crashes
    handleHttpRequest(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Internal error";
      defaults.logger.warn(`Unhandled request error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: msg, type: "server_error" } }));
      }
    });
  });

  async function handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // OPTIONS preflight
    if (req.method === "OPTIONS") {
      handleOptions(res);
      return;
    }

    // Record start time for metrics
    const startTime = registry ? process.hrtime.bigint() : 0n;

    // Parse the URL pathname (strip query string)
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let pathname = parsedUrl.pathname;

    // Instrument response completion for metrics. The finish callback reads
    // pathname via closure after normalizeCompatPath has rewritten it, so
    // metrics record the canonical /v1/... path.
    if (registry) {
      res.on("finish", () => {
        try {
          const normalizedPath = normalizePathLabel(pathname);
          const method = req.method ?? "UNKNOWN";
          const status = String(res.statusCode);
          registry.incrementCounter("aimock_requests_total", {
            method,
            path: normalizedPath,
            status,
          });
          const elapsed = Number(process.hrtime.bigint() - startTime) / 1e9;
          registry.observeHistogram(
            "aimock_request_duration_seconds",
            { method, path: normalizedPath },
            elapsed,
          );
        } catch (err) {
          defaults.logger.warn("metrics instrumentation error", err);
        }
      });
    }

    // Control API — must be checked before mounts and path rewrites
    if (pathname.startsWith(CONTROL_PREFIX)) {
      await handleControlAPI(req, res, pathname, fixtures, journal, videoStates, defaults);
      return;
    }

    // Dispatch to mounted services before any path rewrites
    if (mounts) {
      for (const { path: mountPath, handler } of mounts) {
        if (pathname === mountPath || pathname.startsWith(mountPath + "/")) {
          const subPath = pathname.slice(mountPath.length) || "/";
          const handled = await handler.handleRequest(req, res, subPath);
          if (handled) return;
        }
      }
    }

    // Azure OpenAI: /openai/deployments/{id}/{operation} → /v1/{operation} (chat/completions, embeddings)
    // Must be checked BEFORE the generic /openai/ prefix strip
    let azureDeploymentId: string | undefined;
    const azureMatch = pathname.match(AZURE_DEPLOYMENT_RE);
    if (azureMatch && req.method === "POST") {
      azureDeploymentId = azureMatch[1];
      const operation = azureMatch[2];
      pathname = `/v1/${operation}`;
    }

    // Normalize OpenAI-compatible paths (strip /openai/ prefix + rewrite arbitrary prefixes)
    if (!azureDeploymentId) {
      pathname = normalizeCompatPath(pathname, logger);
    }

    // Health / readiness probes
    if (pathname === HEALTH_PATH && req.method === "GET") {
      setCorsHeaders(res);
      if (mounts && mounts.length > 0) {
        const services: Record<string, unknown> = {
          llm: { status: "ok", fixtures: fixtures.length },
        };
        for (const { path: mountPath, handler } of mounts) {
          if (handler.health) {
            const name = mountPath.replace(/^\//, "");
            services[name] = handler.health();
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", services }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      }
      return;
    }

    if (pathname === READY_PATH && req.method === "GET") {
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ready" }));
      return;
    }

    // Prometheus metrics
    if (pathname === "/metrics" && req.method === "GET") {
      if (!registry) {
        handleNotFound(res, "Not found");
        return;
      }
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(registry.serialize());
      return;
    }

    // Models listing
    if (pathname === MODELS_PATH && req.method === "GET") {
      setCorsHeaders(res);
      const modelIds = new Set<string>();
      for (const f of fixtures) {
        if (f.match.model && typeof f.match.model === "string") {
          modelIds.add(f.match.model);
        }
      }
      const ids = modelIds.size > 0 ? [...modelIds] : DEFAULT_MODELS;
      const data = ids.map((id) => ({
        id,
        object: "model" as const,
        created: 1686935002,
        owned_by: "aimock",
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
      return;
    }

    // Journal inspection endpoints
    if (pathname === REQUESTS_PATH) {
      setCorsHeaders(res);
      if (req.method === "GET") {
        const limitParam = parsedUrl.searchParams.get("limit");
        let opts: { limit: number } | undefined;
        if (limitParam) {
          const limit = parseInt(limitParam, 10);
          if (Number.isNaN(limit) || limit <= 0) {
            writeErrorResponse(
              res,
              400,
              JSON.stringify({
                error: {
                  message: `Invalid limit parameter: "${limitParam}"`,
                  type: "invalid_request_error",
                },
              }),
            );
            return;
          }
          opts = { limit };
        }
        const entries = journal.getAll(opts);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(entries));
        return;
      }
      if (req.method === "DELETE") {
        journal.clear();
        res.writeHead(204);
        res.end();
        return;
      }
      handleNotFound(res, "Not found");
      return;
    }

    // POST /v1/responses — OpenAI Responses API
    if (pathname === RESPONSES_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleResponses(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: { message: msg } })}\n\n`);
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
          res.end();
        }
      }
      return;
    }

    // POST /v1/messages — Anthropic Claude Messages API
    if (pathname === MESSAGES_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleMessages(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: { message: msg } })}\n\n`);
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
          res.end();
        }
      }
      return;
    }

    // POST /v2/chat — Cohere v2 Chat API
    if (pathname === COHERE_CHAT_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleCohere(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: { message: msg } })}\n\n`);
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
          res.end();
        }
      }
      return;
    }

    // POST /v1/embeddings — OpenAI Embeddings API
    if (pathname === EMBEDDINGS_PATH && req.method === "POST") {
      try {
        const deploymentId = azureDeploymentId;
        const embeddingsProvider: RecordProviderKey = azureDeploymentId ? "azure" : "openai";
        let raw = await readBody(req);
        // Azure deployments may omit model from body — use deployment ID as fallback
        if (deploymentId) {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (!parsed.model) {
              parsed.model = deploymentId;
              raw = JSON.stringify(parsed);
            }
          } catch {
            // Fall through — let handleEmbeddings report the parse error
          }
        }
        await handleEmbeddings(
          req,
          res,
          raw,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          embeddingsProvider,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /v1/images/generations — OpenAI Image Generation API
    if (pathname === IMAGES_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleImages(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /v1/audio/speech — OpenAI TTS API
    if (pathname === SPEECH_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleSpeech(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /v1/audio/transcriptions — OpenAI Transcription API
    if (pathname === TRANSCRIPTIONS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleTranscription(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /v1/videos — Video Generation API
    if (pathname === VIDEOS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleVideoCreate(
          req,
          res,
          raw,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          videoStates,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // GET /v1/videos/{id} — Video Status Check
    const videoStatusMatch = pathname.match(VIDEOS_STATUS_RE);
    if (videoStatusMatch && req.method === "GET") {
      const videoId = videoStatusMatch[1];
      handleVideoStatus(req, res, videoId, journal, setCorsHeaders, videoStates);
      return;
    }

    // POST /v1beta/models/{model}:predict — Gemini Imagen API
    const geminiPredictMatch = pathname.match(GEMINI_PREDICT_RE);
    if (geminiPredictMatch && req.method === "POST") {
      const predictModel = geminiPredictMatch[1];
      try {
        const raw = await readBody(req);
        await handleImages(
          req,
          res,
          raw,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          "gemini",
          predictModel,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /v1beta/models/{model}:(generateContent|streamGenerateContent) — Google Gemini
    const geminiMatch = pathname.match(GEMINI_PATH_RE);
    if (geminiMatch && req.method === "POST") {
      const geminiModel = geminiMatch[1];
      const streaming = geminiMatch[2] === "streamGenerateContent";
      try {
        const raw = await readBody(req);
        await handleGemini(
          req,
          res,
          raw,
          geminiModel,
          streaming,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          try {
            res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
          res.end();
        }
      }
      return;
    }

    // POST /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:(generateContent|streamGenerateContent) — Vertex AI
    const vertexMatch = pathname.match(VERTEX_AI_RE);
    if (vertexMatch && req.method === "POST") {
      const vertexModel = vertexMatch[1];
      const streaming = vertexMatch[2] === "streamGenerateContent";
      try {
        const raw = await readBody(req);
        await handleGemini(
          req,
          res,
          raw,
          vertexModel,
          streaming,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          "vertexai",
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          try {
            res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
          res.end();
        }
      }
      return;
    }

    // POST /model/{modelId}/invoke — AWS Bedrock Claude API
    const bedrockMatch = pathname.match(BEDROCK_INVOKE_RE);
    if (bedrockMatch && req.method === "POST") {
      const bedrockModelId = bedrockMatch[1];
      try {
        const raw = await readBody(req);
        await handleBedrock(
          req,
          res,
          raw,
          bedrockModelId,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /model/{modelId}/invoke-with-response-stream — AWS Bedrock Claude streaming
    const bedrockStreamMatch = pathname.match(BEDROCK_STREAM_RE);
    if (bedrockStreamMatch && req.method === "POST") {
      const bedrockModelId = bedrockStreamMatch[1];
      try {
        const raw = await readBody(req);
        await handleBedrockStream(
          req,
          res,
          raw,
          bedrockModelId,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /model/{modelId}/converse — AWS Bedrock Converse API
    const converseMatch = pathname.match(BEDROCK_CONVERSE_RE);
    if (converseMatch && req.method === "POST") {
      const converseModelId = converseMatch[1];
      try {
        const raw = await readBody(req);
        await handleConverse(
          req,
          res,
          raw,
          converseModelId,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /model/{modelId}/converse-stream — AWS Bedrock Converse streaming API
    const converseStreamMatch = pathname.match(BEDROCK_CONVERSE_STREAM_RE);
    if (converseStreamMatch && req.method === "POST") {
      const converseStreamModelId = converseStreamMatch[1];
      try {
        const raw = await readBody(req);
        await handleConverseStream(
          req,
          res,
          raw,
          converseStreamModelId,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /api/chat — Ollama Chat API
    if (pathname === OLLAMA_CHAT_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleOllama(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /api/generate — Ollama Generate API
    if (pathname === OLLAMA_GENERATE_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleOllamaGenerate(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // GET /api/tags — Ollama Models listing
    if (pathname === OLLAMA_TAGS_PATH && req.method === "GET") {
      setCorsHeaders(res);
      const modelIds = new Set<string>();
      for (const f of fixtures) {
        if (f.match.model && typeof f.match.model === "string") {
          modelIds.add(f.match.model);
        }
      }
      const ids = modelIds.size > 0 ? [...modelIds] : DEFAULT_MODELS;
      const models = ids.map((name) => ({
        name,
        model: name,
        modified_at: new Date().toISOString(),
        size: 0,
        digest: "",
        details: {},
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }

    // POST /search — Web Search API (Tavily-compatible)
    if (pathname === SEARCH_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleSearch(
          req,
          res,
          raw,
          serviceFixtures?.search ?? [],
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /v2/rerank — Reranking API (Cohere rerank-compatible)
    if (pathname === RERANK_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleRerank(
          req,
          res,
          raw,
          serviceFixtures?.rerank ?? [],
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /v1/moderations — Moderation API (OpenAI-compatible)
    if (pathname === MODERATIONS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleModeration(
          req,
          res,
          raw,
          serviceFixtures?.moderation ?? [],
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({ error: { message: msg, type: "server_error" } }),
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
      return;
    }

    // POST /v1/chat/completions — Chat Completions API
    if (pathname !== COMPLETIONS_PATH) {
      handleNotFound(res, "Not found");
      return;
    }
    if (req.method !== "POST") {
      handleNotFound(res, "Not found");
      return;
    }

    const completionsProvider: RecordProviderKey = azureDeploymentId ? "azure" : "openai";
    try {
      await handleCompletions(
        req,
        res,
        fixtures,
        journal,
        defaults,
        azureDeploymentId,
        completionsProvider,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Internal error";
      if (!res.headersSent) {
        writeErrorResponse(
          res,
          500,
          JSON.stringify({
            error: {
              message: msg,
              type: "server_error",
            },
          }),
        );
      } else if (!res.writableEnded) {
        // Headers already sent (SSE stream in progress) — write error event then close
        try {
          res.write(
            `data: ${JSON.stringify({ error: { message: msg, type: "server_error" } })}\n\n`,
          );
        } catch (writeErr) {
          logger.debug("Failed to write error recovery response:", writeErr);
        }
        res.end();
      }
    }
  }

  // ─── WebSocket upgrade handling ──────────────────────────────────────────

  const activeConnections = new Set<WebSocketConnection>();

  server.on(
    "upgrade",
    (req: http.IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
      handleUpgradeRequest(req, socket, head).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Internal error";
        defaults.logger.warn(`Unhandled upgrade error: ${msg}`);
        if (!socket.destroyed) socket.destroy();
      });
    },
  );

  async function handleUpgradeRequest(
    req: http.IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): Promise<void> {
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let pathname = parsedUrl.pathname;

    // Dispatch to mounted services before any path rewrites
    if (mounts) {
      for (const { path: mountPath, handler } of mounts) {
        if (
          (pathname === mountPath || pathname.startsWith(mountPath + "/")) &&
          handler.handleUpgrade
        ) {
          const subPath = pathname.slice(mountPath.length) || "/";
          if (await handler.handleUpgrade(socket, head, subPath)) return;
        }
      }
    }

    // Normalize OpenAI-compatible paths (strip /openai/ prefix + rewrite arbitrary prefixes)
    // Skip Azure deployment paths — they have their own rewrite in the HTTP handler
    if (!pathname.match(AZURE_DEPLOYMENT_RE)) {
      pathname = normalizeCompatPath(pathname, logger);
    }

    if (
      pathname !== RESPONSES_PATH &&
      pathname !== REALTIME_PATH &&
      pathname !== GEMINI_LIVE_PATH
    ) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    // Push any buffered data back before upgrading
    if (head.length > 0) {
      socket.unshift(head);
    }

    let ws: WebSocketConnection;
    try {
      ws = upgradeToWebSocket(req, socket);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "WebSocket upgrade failed";
      logger.error(`WebSocket upgrade error: ${msg}`);
      if (!socket.destroyed) socket.destroy();
      return;
    }

    activeConnections.add(ws);

    ws.on("error", (err: Error) => {
      logger.error(`WebSocket error: ${err.message}`);
      activeConnections.delete(ws);
    });

    ws.on("close", () => {
      activeConnections.delete(ws);
    });

    // Route to handler
    const wsTestId = getTestId(req);
    if (pathname === RESPONSES_PATH) {
      handleWebSocketResponses(ws, fixtures, journal, {
        ...defaults,
        model: "gpt-4",
        testId: wsTestId,
      });
    } else if (pathname === REALTIME_PATH) {
      const model = parsedUrl.searchParams.get("model") ?? "gpt-4o-realtime";
      handleWebSocketRealtime(ws, fixtures, journal, {
        ...defaults,
        model,
        testId: wsTestId,
      });
    } else if (pathname === GEMINI_LIVE_PATH) {
      handleWebSocketGeminiLive(ws, fixtures, journal, {
        ...defaults,
        model: "gemini-2.0-flash",
        testId: wsTestId,
      });
    }
  }

  // Close active WS connections when server shuts down
  const originalClose = server.close.bind(server);
  server.close = function (this: http.Server, callback?: (err?: Error) => void) {
    for (const ws of activeConnections) {
      ws.close(1001, "Server shutting down");
    }
    activeConnections.clear();
    originalClose(callback);
    return this;
  } as typeof server.close;

  return new Promise<ServerInstance>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected address format"));
        return;
      }
      const url = `http://${addr.address}:${addr.port}`;

      // Set base URL on mounted services that support it
      if (mounts) {
        for (const { path: mountPath, handler } of mounts) {
          if (handler.setBaseUrl) handler.setBaseUrl(url + mountPath);
        }
      }

      resolve({ server, journal, url, defaults, videoStates });
    });
  });
}
