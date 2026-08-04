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
import { matchFixtureDiagnostic, recordMatchOptions } from "./router.js";
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
  buildUsageChunk,
  resolveUsage,
  resolveFixtureBlocks,
  extractOverrides,
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  serializeErrorResponse,
  isAudioResponse,
  flattenHeaders,
  getTestId,
  readBody,
  resolveResponse,
  resolveStrictMode,
  resolveReasoningForModel,
  strictOverrideField,
  strictNoMatchMessage,
  strictNoMatchLogLine,
  getContext,
} from "./helpers.js";
import {
  isOpenRouterPath,
  buildOpenRouterCandidates,
  resolveOpenRouterShaping,
  shapeOpenRouterCompletion,
  shapeOpenRouterChunks,
  serializeOpenRouterError,
  handleOpenRouterModels,
  handleOpenRouterKey,
  handleOpenRouterCredits,
} from "./openrouter-chat.js";
import type {
  FixtureResponse,
  ErrorResponse,
  ChatCompletion,
  SSEChunk,
  ResponseOverrides,
} from "./types.js";
import { handleResponses } from "./responses.js";
import { handleMessages } from "./messages.js";
import { handleGemini } from "./gemini.js";
import { handleGeminiEmbedContent } from "./gemini-embeddings.js";
import { handleBedrock, handleBedrockStream } from "./bedrock.js";
import { handleConverse, handleConverseStream } from "./bedrock-converse.js";
import {
  handleGeminiInteractions,
  resetInteractionCounter,
  resetEventIdCounter,
} from "./gemini-interactions.js";
import { handleEmbeddings } from "./embeddings.js";
import { handleImages, handleImageEdit, handleImageVariations } from "./images.js";
import { handleSpeech } from "./speech.js";
import { handleTranscription } from "./transcription.js";
import { handleVideoCreate, VideoStateMap } from "./video.js";
import {
  handleOpenRouterVideoCreate,
  handleOpenRouterVideoStatus,
  handleOpenRouterVideoContent,
  handleOpenRouterVideoModels,
  OpenRouterVideoJobMap,
  OPENROUTER_VIDEO_DEFAULT_MAX_CONTENT_BYTES,
} from "./openrouter-video.js";
import { handleVeoVideoCreate, handleVeoVideoStatus, VeoVideoJobMap } from "./veo-video.js";
import { handleGrokVideoCreate, handleGrokVideoStatus, GrokVideoJobMap } from "./grok-video.js";
import { handleElevenLabsAudio, handleElevenLabsTTS } from "./elevenlabs-audio.js";
import { handleFalQueue, falJobs } from "./fal-audio.js";
import { handleFal, falQueueStates } from "./fal.js";
import { handleOllama, handleOllamaGenerate, handleOllamaEmbeddings } from "./ollama.js";
import { handleCohere, handleCohereEmbed } from "./cohere.js";
import { handleSearch, type SearchFixture } from "./search.js";
import { handleRerank, type RerankFixture } from "./rerank.js";
import { handleModeration, type ModerationFixture } from "./moderation.js";
import { upgradeToWebSocket, type WebSocketConnection } from "./ws-framing.js";
import { handleWebSocketResponses } from "./ws-responses.js";
import { handleWebSocketRealtime } from "./ws-realtime.js";
import { handleWebSocketGeminiLive } from "./ws-gemini-live.js";
import { Logger } from "./logger.js";
import { applyChaosAction, evaluateChaos } from "./chaos.js";
import {
  createMetricsRegistry,
  normalizePathLabel,
  OPENROUTER_VIDEO_CONTENT_RE,
  OPENROUTER_VIDEO_STATUS_RE,
  VEO_PREDICT_LRO_RE,
  VEO_OPERATION_RE,
  GROK_VIDEO_SUBMIT_PATH,
  GROK_VIDEO_STATUS_RE,
} from "./metrics.js";
import { proxyAndRecord } from "./recorder.js";
import {
  resolveInboundAuth,
  markAuthenticatedRequest,
  validateRequestApiKey,
  writeApiKeyHttpRejection,
  writeApiKeyUpgradeRejection,
  type ResolvedInboundAuth,
} from "./api-key-auth.js";

export interface ServerInstance {
  server: http.Server;
  journal: Journal;
  url: string;
  defaults: HandlerDefaults;
  videoStates: VideoStateMap;
  openRouterVideoJobs: OpenRouterVideoJobMap;
  veoVideoJobs: VeoVideoJobMap;
  grokVideoJobs: GrokVideoJobMap;
}

const COMPLETIONS_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";
const REALTIME_PATH = "/v1/realtime";
const GEMINI_LIVE_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MESSAGES_PATH = "/v1/messages";
const EMBEDDINGS_PATH = "/v1/embeddings";
const COHERE_CHAT_PATH = "/v2/chat";
const COHERE_EMBED_PATH = "/v2/embed";
const SEARCH_PATH = "/search";
const RERANK_PATH = "/v2/rerank";
const MODERATIONS_PATH = "/v1/moderations";
const IMAGES_PATH = "/v1/images/generations";
const IMAGES_EDIT_PATH = "/v1/images/edits";
const IMAGES_VARIATIONS_PATH = "/v1/images/variations";
const SPEECH_PATH = "/v1/audio/speech";
const TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";
const TRANSLATIONS_PATH = "/v1/audio/translations";
const VIDEOS_PATH = "/v1/videos";
const GEMINI_PREDICT_RE = /^\/v1beta\/models\/([^:]+):predict$/;
const ELEVENLABS_SOUND_GENERATION_PATH = "/v1/sound-generation";
const ELEVENLABS_TTS_RE = /^\/v1\/text-to-speech\/([^/]+)$/;
const ELEVENLABS_MUSIC_RE = /^\/v1\/music(?:\/(.+))?$/;
const FAL_QUEUE_SUBMIT_RE = /^\/fal\/queue\/submit\/(.+)$/;
const FAL_QUEUE_REQUESTS_RE = /^\/fal\/queue\/requests\/(.+)$/;
const FAL_RUN_RE = /^\/fal\/run\/(.+)$/;
const FAL_PREFIX_RE = /^\/fal(?:\/.*)?$/;
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
  "/audio/translations",
  "/images/generations",
  "/images/edits",
  "/images/variations",
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

const GEMINI_INTERACTIONS_PATH = "/v1beta/interactions";
const GEMINI_PATH_RE = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/;
const GEMINI_EMBED_RE = /^\/v1beta\/models\/([^:]+):embedContent$/;
const AZURE_DEPLOYMENT_RE = /^\/openai\/deployments\/([^/]+)\/(chat\/completions|embeddings)$/;
const BEDROCK_INVOKE_RE = /^\/model\/([^/]+)\/invoke$/;
const BEDROCK_STREAM_RE = /^\/model\/([^/]+)\/invoke-with-response-stream$/;
const BEDROCK_CONVERSE_RE = /^\/model\/([^/]+)\/converse$/;
const BEDROCK_CONVERSE_STREAM_RE = /^\/model\/([^/]+)\/converse-stream$/;
const VERTEX_AI_RE =
  /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

const OLLAMA_CHAT_PATH = "/api/chat";
const OLLAMA_GENERATE_PATH = "/api/generate";
const OLLAMA_EMBEDDINGS_PATH = "/api/embeddings";
const OLLAMA_EMBED_PATH = "/api/embed";
const OLLAMA_TAGS_PATH = "/api/tags";

// OpenRouter async video lifecycle (/api/v1/videos). Dispatch order matters:
// content RE → models exact → status RE → submit exact. The status RE's
// `[^/]+` segment would otherwise swallow the `models` listing path. The
// content/status REs are shared with metrics.ts path-label normalization
// (imported above).
const OPENROUTER_VIDEOS_PATH = "/api/v1/videos";
const OPENROUTER_VIDEO_MODELS_PATH = "/api/v1/videos/models";

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
  "Access-Control-Allow-Headers": "*",
};

function setCorsHeaders(res: http.ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
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
 * Perform a full fixtures reset: clear the fixtures array, journal, video/fal
 * generation state, and the interaction/event-id counters, then zero the
 * `aimock_fixtures_loaded` gauge. Shared by `/reset/fixtures` and the
 * deprecated `/reset` alias.
 */
function performFixturesReset(
  fixtures: Fixture[],
  journal: Journal,
  videoStates: VideoStateMap,
  openRouterVideoJobs: OpenRouterVideoJobMap,
  veoVideoJobs: VeoVideoJobMap,
  grokVideoJobs: GrokVideoJobMap,
  defaults: HandlerDefaults,
): void {
  fixtures.length = 0;
  journal.clear();
  videoStates.clear();
  openRouterVideoJobs.clear();
  veoVideoJobs.clear();
  grokVideoJobs.clear();
  falJobs.clear();
  falQueueStates.clear();
  resetInteractionCounter();
  resetEventIdCounter();
  if (defaults.registry) {
    defaults.registry.setGauge("aimock_fixtures_loaded", {}, fixtures.length);
  }
}

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
  openRouterVideoJobs: OpenRouterVideoJobMap,
  veoVideoJobs: VeoVideoJobMap,
  grokVideoJobs: GrokVideoJobMap,
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

    const converted = parsed.fixtures.map((e) => entryToFixture(e));
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

  // POST /__aimock/reset/fixtures — full reset (fixtures + journal + match counts)
  if (subPath === "/reset/fixtures" && req.method === "POST") {
    performFixturesReset(
      fixtures,
      journal,
      videoStates,
      openRouterVideoJobs,
      veoVideoJobs,
      grokVideoJobs,
      defaults,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reset: true }));
    return true;
  }

  // POST /__aimock/reset/journal — clear only the request journal entries,
  // preserving fixture match-counts (sequencing state stays intact)
  if (subPath === "/reset/journal" && req.method === "POST") {
    journal.clearEntries();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reset: true }));
    return true;
  }

  // POST /__aimock/reset — DEPRECATED alias for /reset/fixtures (full reset)
  if (subPath === "/reset" && req.method === "POST") {
    performFixturesReset(
      fixtures,
      journal,
      videoStates,
      openRouterVideoJobs,
      veoVideoJobs,
      grokVideoJobs,
      defaults,
    );
    const deprecation =
      "POST /__aimock/reset is deprecated; use POST /__aimock/reset/fixtures (full reset) or POST /__aimock/reset/journal (journal only)";
    defaults.logger.warn(
      "POST /__aimock/reset is deprecated; use /__aimock/reset/fixtures or /__aimock/reset/journal",
    );
    res.writeHead(200, { "Content-Type": "application/json", Deprecation: "true" });
    res.end(JSON.stringify({ reset: true, deprecated: true, deprecation }));
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
    // One-shot: match once then self-remove.  We use a `consumed` flag to
    // prevent double-matching from concurrent requests and defer the actual
    // splice via queueMicrotask so it never mutates the fixtures array while
    // matchFixture is iterating over it.
    let consumed = false;
    const original = errorFixture.match.predicate!;
    errorFixture.match.predicate = (req) => {
      if (consumed) return false;
      const result = original(req);
      if (result) {
        consumed = true;
        queueMicrotask(() => {
          const idx = fixtures.indexOf(errorFixture);
          if (idx !== -1) fixtures.splice(idx, 1);
        });
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
  openRouter = false,
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
      openRouter
        ? serializeOpenRouterError(500, `Request body read failed: ${msg}`)
        : JSON.stringify({
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
  } catch (parseErr: unknown) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown parse error";
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
      openRouter
        ? serializeOpenRouterError(400, `Malformed JSON: ${detail}`)
        : JSON.stringify({
            error: {
              message: `Malformed JSON: ${detail}`,
              type: "invalid_request_error",
              param: null,
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
      openRouter
        ? serializeOpenRouterError(400, "Missing required parameter: 'messages'")
        : JSON.stringify({
            error: {
              message: "Missing required parameter: 'messages'",
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          }),
    );
    return;
  }

  const method = req.method ?? "POST";
  const path = req.url ?? COMPLETIONS_PATH;
  const flatHeaders = flattenHeaders(req.headers);

  // Set endpoint type once early so router/recorder and journal see it
  body._endpointType = "chat";
  body._context = getContext(req);

  // Match fixture first — chaos resolution depends on fixture-level overrides
  // (headers > fixture.chaos > server defaults), so the fixture has to be
  // known before we can roll with the right config.
  const testId = getTestId(req);
  const matchOptions = recordMatchOptions(
    // In record mode a miss proxies upstream to capture a fresh turn, so an
    // earlier-turn capture must not shadow a longer request via the relaxed
    // turnIndex disambiguator — keep turnIndex a strict gate while recording.
    // This handler's record gate (below) is `defaults.record && providerKey`.
    !!(defaults.record && providerKey),
    defaults.logger,
  );

  // OpenRouter `models[]` fallback simulation. When the request arrived on the
  // OpenRouter base AND carries a fallback array, attempt the candidate list
  // `[model, ...models]` in order and serve the FIRST non-error fixture match
  // — an ERROR-fixture candidate simulates a RUNTIME provider failure (429/503)
  // and falls through, exactly as real OpenRouter fails over on a runtime
  // error. The winning slug is echoed back as the response `model` (the only
  // fallback signal a real client sees). `preResolvedResponse` is the winner's
  // already-resolved response so the shared branch below does not re-resolve
  // (and thus does not re-invoke a response factory). Requests without a
  // fallback array take the ordinary single-model match path unchanged.
  //
  // Deliberate non-goal (mock vs real): real OpenRouter rejects an
  // unknown/invalid model in `models[]` up front with a 400 "not a valid model
  // ID" and does NOT fail over from it (failover is runtime-error only). aimock
  // is fixture-driven — an unknown model simply matches no fixture (a strict
  // miss / 404), so we do not replicate that up-front 400.
  let fixture: Fixture | null = null;
  let skippedBySequenceOrTurn = 0;
  let preResolvedResponse: FixtureResponse | null = null;
  // The model echoed back in the RESPONSE — the winner of the fallback chain,
  // or the requested model when there is no chain. The client's originally
  // requested `body.model` is left UNTOUCHED so the journaled request records
  // what was actually sent: it is the RESPONSE, not the request, that carries
  // the fallback outcome (`response.model` = winner).
  let responseModel = body.model;
  // Whether the fallback loop already advanced the served fixture's match count
  // (so the shared increment below does not double-count it).
  let fixtureCountIncremented = false;
  const openRouterFallback = openRouter && Array.isArray(body.models) && body.models.length > 0;

  if (openRouterFallback) {
    const candidates = buildOpenRouterCandidates(body);
    // Re-read after each in-loop increment (below). `getFixtureMatchCountsForTest`
    // returns the LIVE cached map only once a map exists for `testId`; on the
    // FIRST request for a testId it returns a fresh TRANSIENT empty map that
    // `incrementFixtureMatchCount` (which lazily creates the cached map) never
    // touches. Without the refresh, a single fixture matched by MULTIPLE
    // candidates in one request would evaluate later candidates against a stale
    // count-0 snapshot — re-matching the same sequenced/turn-gated fixture and
    // over-advancing its count. Refreshing binds `matchCounts` to the live map.
    let matchCounts = journal.getFixtureMatchCountsForTest(testId);
    // Fail-CLOSED gate: `provider.allow_fallbacks: false` suppresses fall-through
    // — only the primary is tried and a primary error fixture is served as
    // terminal. Absent / `true` keeps the default runtime-error fall-through.
    const allowFallbacks = body.provider?.allow_fallbacks !== false;
    let lastErrorFixture: Fixture | null = null;
    let lastErrorResponse: FixtureResponse | null = null;
    // Separable resolver step: a candidate's success/error decision goes through
    // this small lookup (fixture match today) kept OUT of the loop's control
    // flow, so the loop could later resolve a candidate against a live upstream
    // without re-welding the iteration to `matchFixtureDiagnostic`.
    const resolveCandidate = async (
      candidate: string,
    ): Promise<{ fixture: Fixture; response: FixtureResponse; isError: boolean } | null> => {
      const probe: ChatCompletionRequest = { ...body, model: candidate };
      const attempt = matchFixtureDiagnostic(
        fixtures,
        probe,
        matchCounts,
        defaults.requestTransform,
        matchOptions,
      );
      skippedBySequenceOrTurn = Math.max(skippedBySequenceOrTurn, attempt.skippedBySequenceOrTurn);
      if (!attempt.fixture) return null;
      const response = await resolveResponse(attempt.fixture, probe);
      return { fixture: attempt.fixture, response, isError: isErrorResponse(response) };
    };
    for (const candidate of candidates) {
      const outcome = await resolveCandidate(candidate);
      if (!outcome) {
        // Primary produced no fixture and fall-through is suppressed — stop.
        if (!allowFallbacks) break;
        continue;
      }
      // A candidate whose fixture matched-and-resolved is "consumed": advance
      // its match count (INCLUDING error candidates used as failovers) so a
      // sequenced/turn-gated fixture progresses across requests exactly as a
      // single match would — otherwise a sequenced error primary replays the
      // same failover on every request.
      journal.incrementFixtureMatchCount(outcome.fixture, fixtures, testId);
      fixtureCountIncremented = true;
      // Rebind to the now-live cached map so subsequent candidates in THIS
      // request see the increment (see the `let matchCounts` note above).
      matchCounts = journal.getFixtureMatchCountsForTest(testId);
      responseModel = candidate;
      if (outcome.isError) {
        // Per-error-fixture failover gate. An ERROR fixture may set
        // `fallthrough: false` to mark its error CLASS as non-failover-eligible
        // — reproducing OpenRouter serving a 403/generic provider error as
        // terminal instead of advancing to the next `models[]` candidate
        // (openclaw #60191). Absent / `true` keeps the default fall-through.
        // Composes with the request-level `allowFallbacks` gate: fail over only
        // when BOTH allow it (if EITHER says don't, this candidate is terminal).
        const errorFallsThrough = (outcome.response as ErrorResponse).fallthrough !== false;
        if (allowFallbacks && errorFallsThrough) {
          // Runtime provider failure — remember it and fail over to the next.
          lastErrorFixture = outcome.fixture;
          lastErrorResponse = outcome.response;
          continue;
        }
      }
      // Success, or a terminal error (allow_fallbacks:false or fallthrough:false).
      fixture = outcome.fixture;
      preResolvedResponse = outcome.response;
      break;
    }
    if (!fixture && lastErrorFixture) {
      // Every candidate failed — serve the last provider's error (faithful to
      // "primary and every fallback failed"). It was already counted above.
      fixture = lastErrorFixture;
      preResolvedResponse = lastErrorResponse;
    }
  } else {
    const single = matchFixtureDiagnostic(
      fixtures,
      body,
      journal.getFixtureMatchCountsForTest(testId),
      defaults.requestTransform,
      matchOptions,
    );
    fixture = single.fixture;
    skippedBySequenceOrTurn = single.skippedBySequenceOrTurn;
  }

  if (fixture) {
    // The fallback loop already advanced the served fixture's count; only the
    // single-match path still needs to increment here (never double-count).
    if (!fixtureCountIncremented) journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    defaults.logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    const lastUserMsg = body.messages.filter((m) => m.role === "user").pop();
    const snippet =
      typeof lastUserMsg?.content === "string" ? lastUserMsg.content.slice(0, 80) : "";
    defaults.logger.debug(
      `No fixture matched for request (model=${body.model ?? "?"}, msg="${snippet}")`,
    );
  }

  // Roll chaos once per request. Dispatch by action + path:
  //   drop / disconnect → apply immediately; upstream is never called and no
  //                       response body is produced.
  //   malformed, fixture path → write invalid JSON instead of the fixture.
  //   malformed, proxy path  → proxy to upstream, then swap body via the
  //                            beforeWriteResponse hook (passed only when the
  //                            action is malformed, so the hook doesn't need
  //                            to re-check the action).
  const chaosAction = evaluateChaos(fixture, defaults.chaos, req.headers, defaults.logger);
  const chaosContext = { method, path, headers: flatHeaders, body };

  if (chaosAction === "drop" || chaosAction === "disconnect") {
    applyChaosAction(
      chaosAction,
      res,
      fixture,
      journal,
      chaosContext,
      fixture ? "fixture" : "proxy",
      defaults.registry,
    );
    return;
  }

  if (fixture && chaosAction === "malformed") {
    applyChaosAction(
      chaosAction,
      res,
      fixture,
      journal,
      chaosContext,
      "fixture",
      defaults.registry,
    );
    return;
  }

  if (!fixture) {
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    if (effectiveStrict) {
      const strictStatus = 503;
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      defaults.logger.error(
        strictNoMatchLogLine(
          req.method ?? "POST",
          req.url ?? COMPLETIONS_PATH,
          skippedBySequenceOrTurn,
        ),
      );
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? COMPLETIONS_PATH,
        headers: flattenHeaders(req.headers),
        body,
        response: {
          status: strictStatus,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
      });
      writeErrorResponse(
        res,
        strictStatus,
        openRouter
          ? serializeOpenRouterError(strictStatus, strictMessage)
          : JSON.stringify({
              error: {
                message: strictMessage,
                type: "invalid_request_error",
                param: null,
                code: "no_fixture_match",
              },
            }),
      );
      return;
    }

    // Try record-and-replay proxy if configured
    if (defaults.record && providerKey) {
      // Hook is only passed when chaos wants to mutate the response. When
      // it's passed, it unconditionally applies malformed + journals + tells
      // proxyAndRecord to skip its default relay. The hook has no branching
      // logic — that decision is made here, at the call site.
      const hookOptions =
        chaosAction === "malformed"
          ? {
              // Malformed is emitted as a hardcoded invalid-JSON body, so the
              // captured upstream response isn't used here (the parameter is
              // intentionally omitted rather than declared-and-ignored).
              // Future dispatch (phase 3: non-JSON / streaming) will accept
              // the response and branch on contentType.
              beforeWriteResponse: () => {
                applyChaosAction(
                  chaosAction,
                  res,
                  null,
                  journal,
                  chaosContext,
                  "proxy",
                  defaults.registry,
                );
                return true;
              },
              // Streaming responses can't be mutated post-facto (bytes already
              // on the wire). Record the bypass so the rolled action isn't
              // invisible in logs / Prometheus.
              onHookBypassed: (reason: "sse_streamed" | "ndjson_streamed" | "binary_streamed") => {
                defaults.logger.warn(
                  `[chaos] malformed bypassed on proxy: upstream returned streaming response (${reason})`,
                );
                defaults.registry?.incrementCounter("aimock_chaos_bypassed_total", {
                  action: "malformed",
                  source: "proxy",
                  reason,
                });
              },
            }
          : undefined;

      const outcome = await proxyAndRecord(
        req,
        res,
        body,
        providerKey,
        req.url ?? COMPLETIONS_PATH,
        fixtures,
        defaults,
        raw,
        hookOptions,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: req.url ?? COMPLETIONS_PATH,
          headers: flattenHeaders(req.headers),
          body,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
      // outcome === "not_configured" — fall through to 404
    }

    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      404,
      openRouter
        ? serializeOpenRouterError(404, "No fixture matched")
        : JSON.stringify({
            error: {
              message: "No fixture matched",
              type: "invalid_request_error",
              param: null,
              code: "no_fixture_match",
            },
          }),
    );
    return;
  }

  // Reuse the response already resolved by the OpenRouter fallback loop (so a
  // response factory is not invoked twice); otherwise resolve it now.
  const response = preResolvedResponse ?? (await resolveResponse(fixture, body));
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);
  // OpenRouter always accounts usage (cost) in the response, including as the
  // final streaming chunk — the OpenAI `stream_options.include_usage` gate is a
  // deprecated no-op there.
  const includeUsage = body.stream === true && body.stream_options?.include_usage === true;
  const emitStreamingUsage = includeUsage || openRouter;

  // Prompt text for streaming usage-chunk token estimation, concatenated from
  // the request messages exactly as the non-streaming completion builders do
  // (see buildTextCompletion et al. in helpers.ts) so both paths estimate the
  // same prompt token count. The streaming usage chunk is then resolved through
  // the SAME helpers.ts `resolveUsage` as the non-streaming path — a single
  // source of truth for "explicit token override wins, cost-only override still
  // estimates" (replaces three formerly-duplicated inline `?? 0` copies).
  const streamingPromptText = body.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => p.text ?? "").join("")
          : "",
    )
    .join("");
  const resolveStreamingUsageTokens = (
    overrides: ResponseOverrides | undefined,
    completionText: string,
  ): { prompt_tokens: number; completion_tokens: number; total_tokens: number } =>
    resolveUsage(overrides, streamingPromptText, completionText);

  // OpenRouter response shaping (no-op for OpenAI callers). Applied as a
  // post-pass over the objects the shared OpenAI builders produce so the
  // OpenAI code path is untouched. All OpenRouter-specific field shapes live in
  // openrouter-chat.ts. The fixture's `id` override still wins verbatim (the
  // `gen-` prefix rewrite only applies to auto-generated ids).
  const shapeORCompletion = (
    completion: ChatCompletion,
    overrides: ResponseOverrides | undefined,
  ): ChatCompletion => {
    if (!openRouter) return completion;
    return shapeOpenRouterCompletion(
      completion,
      resolveOpenRouterShaping(overrides, overrides?.model ?? responseModel),
      overrides?.id !== undefined,
    );
  };
  const shapeORChunks = (
    chunks: SSEChunk[],
    usageChunk: SSEChunk | undefined,
    overrides: ResponseOverrides | undefined,
  ): void => {
    if (!openRouter) return;
    const shaping = resolveOpenRouterShaping(overrides, overrides?.model ?? responseModel);
    shapeOpenRouterChunks(chunks, shaping, overrides?.id !== undefined);
    // The final usage chunk shares the stream id and provider; shaping it also
    // augments its usage with cost/cost_details.
    if (usageChunk) shapeOpenRouterChunks([usageChunk], shaping, overrides?.id !== undefined);
  };
  // Opt-in `: OPENROUTER PROCESSING` keepalive comment lines (default off).
  const openRouterProcessing = !!(openRouter && fixture.openRouterProcessing);

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
    writeErrorResponse(
      res,
      status,
      openRouter
        ? serializeOpenRouterError(status, response.error.message, response.error.metadata)
        : serializeErrorResponse(response),
      {
        retryAfter: response.retryAfter,
      },
    );
    return;
  }

  // Audio responses are not supported on the chat completions endpoint
  if (isAudioResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 422, fixture },
    });
    writeErrorResponse(
      res,
      422,
      openRouter
        ? serializeOpenRouterError(
            422,
            "Audio responses are not supported on the chat completions endpoint. Use Gemini generateContent or a dedicated audio endpoint.",
          )
        : JSON.stringify({
            error: {
              message:
                "Audio responses are not supported on the chat completions endpoint. Use Gemini generateContent or a dedicated audio endpoint.",
              type: "invalid_request_error",
            },
          }),
    );
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
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      responseModel,
      effectiveStrict,
      defaults.logger,
    );
    // Resolve the ordered streaming blocks ONCE, BEFORE recording success in the
    // journal. resolveFixtureBlocks validates and can throw on a malformed
    // `blocks` array; doing it here (rather than inside the chunk builder AND a
    // second time for the usage estimate, both of which previously ran AFTER
    // journal.add) guarantees a malformed fixture never leaves a spurious
    // status-200 journal entry. The single resolved array is reused for both
    // chunk emission and the completion-token estimate — the builder re-normalizes
    // it idempotently (a can't-fail pass on already-validated blocks), so this is
    // the only resolution that can throw. Only the streaming path consumes blocks
    // (the non-streaming builder ignores them), so gate on `stream` to leave the
    // non-streaming path's behavior byte-identical.
    const streaming = body.stream === true;
    const streamingBlocks =
      streaming && response.blocks && response.blocks.length > 0
        ? resolveFixtureBlocks(response.blocks)
        : undefined;
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const completion = buildContentWithToolCallsCompletion(
        response.content ?? "",
        response.toolCalls ?? [],
        responseModel,
        effReasoning,
        overrides,
        body.messages,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(shapeORCompletion(completion, overrides)));
    } else {
      const chunks = buildContentWithToolCallsChunks(
        response.content ?? "",
        response.toolCalls ?? [],
        responseModel,
        chunkSize,
        effReasoning,
        overrides,
        streamingBlocks,
      );
      // Build usage chunk for stream_options.include_usage (always for OpenRouter).
      // When the fixture is blocks-driven, the streamed text comes from the
      // ordered blocks (content/toolCalls are ignored by the chunk builder), so
      // the completion-token estimate must derive from the SAME block text —
      // otherwise a blocks-only fixture reports ~1 completion token. Reuse the
      // single pre-resolved `streamingBlocks` (no second resolveFixtureBlocks).
      const completionText = streamingBlocks
        ? streamingBlocks.map((b) => (b.type === "text" ? b.text : b.name + b.arguments)).join("")
        : (response.content ?? "") +
          (response.toolCalls ?? []).map((tc) => tc.name + tc.arguments).join("");
      const usageChunk = emitStreamingUsage
        ? buildUsageChunk(
            chunks[0]?.id ?? "chatcmpl-unknown",
            overrides?.model ?? responseModel,
            chunks[0]?.created ?? Math.floor(Date.now() / 1000),
            resolveStreamingUsageTokens(overrides, completionText),
            overrides?.systemFingerprint,
          )
        : undefined;
      shapeORChunks(chunks, usageChunk, overrides);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeSSEStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
        usageChunk,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
        openRouterProcessing,
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
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      responseModel,
      effectiveStrict,
      defaults.logger,
    );
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
        responseModel,
        effReasoning,
        overrides,
        body.messages,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(shapeORCompletion(completion, overrides)));
    } else {
      const chunks = buildTextChunks(
        response.content,
        responseModel,
        chunkSize,
        effReasoning,
        overrides,
      );
      const usageChunk = emitStreamingUsage
        ? buildUsageChunk(
            chunks[0]?.id ?? "chatcmpl-unknown",
            overrides?.model ?? responseModel,
            chunks[0]?.created ?? Math.floor(Date.now() / 1000),
            resolveStreamingUsageTokens(overrides, response.content),
            overrides?.systemFingerprint,
          )
        : undefined;
      shapeORChunks(chunks, usageChunk, overrides);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeSSEStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
        usageChunk,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
        openRouterProcessing,
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
    if (response.webSearches?.length) {
      defaults.logger.warn(
        "webSearches in fixture response are not supported for Chat Completions API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      responseModel,
      effectiveStrict,
      defaults.logger,
    );
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    if (body.stream !== true) {
      const completion = buildToolCallCompletion(
        response.toolCalls,
        responseModel,
        effReasoning,
        overrides,
        body.messages,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(shapeORCompletion(completion, overrides)));
    } else {
      const chunks = buildToolCallChunks(
        response.toolCalls,
        responseModel,
        chunkSize,
        effReasoning,
        overrides,
      );
      const completionText = response.toolCalls.map((tc) => tc.name + tc.arguments).join("");
      const usageChunk = emitStreamingUsage
        ? buildUsageChunk(
            chunks[0]?.id ?? "chatcmpl-unknown",
            overrides?.model ?? responseModel,
            chunks[0]?.created ?? Math.floor(Date.now() / 1000),
            resolveStreamingUsageTokens(overrides, completionText),
            overrides?.systemFingerprint,
          )
        : undefined;
      shapeORChunks(chunks, usageChunk, overrides);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeSSEStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
        usageChunk,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
        openRouterProcessing,
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
    openRouter
      ? serializeOpenRouterError(500, "Fixture response did not match any known type")
      : JSON.stringify({
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
  const resolvedAuth = resolveInboundAuth({ value: options?.auth, label: "options.auth" });
  return createServerWithResolvedAuth(fixtures, options, resolvedAuth, mounts, serviceFixtures);
}

/** @internal Config startup uses this to avoid parsing a selected auth source twice. */
export async function createServerWithResolvedAuth(
  fixtures: Fixture[],
  options: MockServerOptions | undefined,
  resolvedAuth: ResolvedInboundAuth,
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
    replaySpeed: serverOptions.replaySpeed ?? 1.0,
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
    get falQueue() {
      return serverOptions.falQueue;
    },
    get openRouterVideo() {
      return serverOptions.openRouterVideo;
    },
    get veoVideo() {
      return serverOptions.veoVideo;
    },
    get grokVideo() {
      return serverOptions.grokVideo;
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

  // Validate poll-progression thresholds (resolveProgression treats
  // non-finite values as unset and floors/clamps the rest to >= 0 integers)
  for (const { name, config } of [
    { name: "falQueue", config: options?.falQueue },
    { name: "openRouterVideo", config: options?.openRouterVideo },
    { name: "veoVideo", config: options?.veoVideo },
    { name: "grokVideo", config: options?.grokVideo },
  ]) {
    if (!config) continue;
    for (const field of ["pollsBeforeInProgress", "pollsBeforeCompleted"] as const) {
      const value = config[field];
      if (value === undefined) continue;
      if (!Number.isFinite(value)) {
        logger.warn(`${name}.${field} (${value}) is not a finite number — treating as unset`);
      } else if (!Number.isInteger(value) || value < 0) {
        logger.warn(
          `${name}.${field} (${value}) is not a non-negative integer — flooring/clamping to a non-negative integer`,
        );
      }
    }
  }

  // Validate the recorded-b64 cap: the capture path treats a negative or
  // non-integer record.openRouterVideo.maxContentBytes as the default rather
  // than letting `cap > 0` checks misbehave on negatives or NaN.
  {
    const cap = options?.record?.openRouterVideo?.maxContentBytes;
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 0)) {
      logger.warn(
        `record.openRouterVideo.maxContentBytes (${cap}) is not a non-negative integer — using the default cap (${OPENROUTER_VIDEO_DEFAULT_MAX_CONTENT_BYTES})`,
      );
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
  const openRouterVideoJobs = new OpenRouterVideoJobMap();
  const veoVideoJobs = new VeoVideoJobMap();
  const grokVideoJobs = new GrokVideoJobMap();

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
      const stack = err instanceof Error ? (err.stack ?? msg) : msg;
      const method = req.method ?? "?";
      const url = req.url ?? "?";
      defaults.logger.warn(`Unhandled request error on ${method} ${url}: ${msg}\n${stack}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: msg, type: "server_error" } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  async function handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Record start time for metrics
    const startTime = registry ? process.hrtime.bigint() : 0n;

    // Parse the URL pathname (strip query string)
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let pathname = parsedUrl.pathname;
    // Capture the ORIGINAL path before normalizeCompatPath rewrites it — the
    // OpenRouter `/api/v1/` base is the detection signal and would otherwise be
    // erased (`/api/v1/chat/completions` → `/v1/chat/completions`).
    const originalPathname = pathname;
    const isOpenRouter = isOpenRouterPath(originalPathname);

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

    // Browser CORS preflights do not carry application credentials. A bare
    // OPTIONS is still a route request and must pass the normal auth boundary.
    if (
      req.method === "OPTIONS" &&
      (!resolvedAuth.policy.enabled ||
        (req.headers.origin !== undefined &&
          req.headers["access-control-request-method"] !== undefined))
    ) {
      handleOptions(res);
      return;
    }

    const isPublicProbe =
      req.method === "GET" &&
      (pathname === HEALTH_PATH || pathname === READY_PATH || pathname === "/metrics");
    if (!isPublicProbe) {
      if (!validateRequestApiKey(req, resolvedAuth.policy).ok) {
        writeApiKeyHttpRejection(res, setCorsHeaders);
        return;
      }
      markAuthenticatedRequest(req, resolvedAuth.policy);
    }

    // Control API — must be checked before mounts and path rewrites
    if (pathname.startsWith(CONTROL_PREFIX)) {
      await handleControlAPI(
        req,
        res,
        pathname,
        fixtures,
        journal,
        videoStates,
        openRouterVideoJobs,
        veoVideoJobs,
        grokVideoJobs,
        defaults,
      );
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

    // Ollama /api/* routes must be dispatched BEFORE normalizeCompatPath, which
    // rewrites any path ending in /embeddings to /v1/embeddings.  The /api/chat,
    // /api/generate, and /api/embed paths are unaffected (their suffixes aren't
    // in COMPAT_SUFFIXES), but /api/embeddings would collide with the OpenAI
    // handler.  /api/embed is the current Ollama endpoint
    // (https://github.com/ollama/ollama/blob/main/docs/api.md); /api/embeddings
    // is the legacy path kept for backwards-compatibility.  Both route to the
    // same handler.
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

    if (
      (pathname === OLLAMA_EMBEDDINGS_PATH || pathname === OLLAMA_EMBED_PATH) &&
      req.method === "POST"
    ) {
      try {
        const raw = await readBody(req);
        await handleOllamaEmbeddings(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
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

    // OpenRouter async video lifecycle (/api/v1/videos). Like the Ollama
    // /api/* routes above, dispatched before normalizeCompatPath. Order:
    // content RE → models exact → status RE → submit exact (the status RE's
    // `[^/]+` segment would otherwise swallow the `models` listing path; the
    // content path's extra `/content` segment can never match it).

    // GET /api/v1/videos/{jobId}/content — download the generated bytes
    const openRouterVideoContentMatch = pathname.match(OPENROUTER_VIDEO_CONTENT_RE);
    if (openRouterVideoContentMatch && req.method === "GET") {
      try {
        await handleOpenRouterVideoContent(
          req,
          res,
          openRouterVideoContentMatch[1],
          journal,
          defaults,
          setCorsHeaders,
          openRouterVideoJobs,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        defaults.logger.error(`openrouter-video content: ${msg}`);
        if (!res.headersSent) {
          // Journal the failed request so it isn't invisible to consumers —
          // guarded on headersSent so a throw after a successful journal +
          // response does not double-journal. Wrapped so journaling can
          // never mask the 500 write below.
          try {
            journal.add({
              method: req.method ?? "GET",
              path: req.url ?? pathname,
              headers: flattenHeaders(req.headers),
              body: null,
              response: { status: 500, fixture: null },
            });
          } catch (jErr) {
            defaults.logger.warn(
              `openrouter-video content: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
            );
          }
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

    // GET /api/v1/videos/models — video model listing (must precede the
    // status RE, whose [^/]+ segment would otherwise capture "models")
    if (pathname === OPENROUTER_VIDEO_MODELS_PATH && req.method === "GET") {
      try {
        await handleOpenRouterVideoModels(req, res, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        defaults.logger.error(`openrouter-video models: ${msg}`);
        if (!res.headersSent) {
          // Journal the failed request so it isn't invisible to consumers —
          // guarded on headersSent so a throw after a successful journal +
          // response does not double-journal. Wrapped so journaling can
          // never mask the 500 write below.
          try {
            journal.add({
              method: req.method ?? "GET",
              path: req.url ?? pathname,
              headers: flattenHeaders(req.headers),
              body: null,
              response: { status: 500, fixture: null },
            });
          } catch (jErr) {
            defaults.logger.warn(
              `openrouter-video models: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
            );
          }
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

    // GET /api/v1/videos/{jobId} — poll job status
    const openRouterVideoStatusMatch = pathname.match(OPENROUTER_VIDEO_STATUS_RE);
    if (openRouterVideoStatusMatch && req.method === "GET") {
      try {
        await handleOpenRouterVideoStatus(
          req,
          res,
          openRouterVideoStatusMatch[1],
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          openRouterVideoJobs,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        defaults.logger.error(`openrouter-video status: ${msg}`);
        if (!res.headersSent) {
          // Journal the failed request so it isn't invisible to consumers —
          // guarded on headersSent so a throw after a successful journal +
          // response does not double-journal. Wrapped so journaling can
          // never mask the 500 write below.
          try {
            journal.add({
              method: req.method ?? "GET",
              path: req.url ?? pathname,
              headers: flattenHeaders(req.headers),
              body: null,
              response: { status: 500, fixture: null },
            });
          } catch (jErr) {
            defaults.logger.warn(
              `openrouter-video status: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
            );
          }
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

    // POST /api/v1/videos — submit a video generation job
    if (pathname === OPENROUTER_VIDEOS_PATH && req.method === "POST") {
      // CORS headers before the body is read: a readBody throw (e.g. the
      // body-size cap) lands in the catch below, which must not write a 500
      // that is opaque to browser clients. The handler re-applies the same
      // headers (setHeader is idempotent).
      setCorsHeaders(res);
      try {
        const raw = await readBody(req);
        await handleOpenRouterVideoCreate(
          req,
          res,
          raw,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          openRouterVideoJobs,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        defaults.logger.error(`openrouter-video submit: ${msg}`);
        if (!res.headersSent) {
          // Journal the failed request so it isn't invisible to consumers —
          // on submit a throw may have already consumed a fixture-sequence
          // slot, which would otherwise leave no trace. Guarded on
          // headersSent so a throw after a successful journal + response
          // does not double-journal (the guard only covers post-write
          // throws — a throw between the handler's journal.add and its
          // writeHead would still double-journal, though that window is
          // effectively throw-free today). Wrapped so journaling can never
          // mask the 500 write below.
          try {
            journal.add({
              method: req.method ?? "POST",
              path: req.url ?? pathname,
              headers: flattenHeaders(req.headers),
              body: null,
              response: { status: 500, fixture: null },
            });
          } catch (jErr) {
            defaults.logger.warn(
              `openrouter-video submit: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
            );
          }
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

    // OpenRouter discovery endpoints. Dispatched BEFORE normalizeCompatPath
    // (which does not rewrite these — /models etc. are excluded from
    // COMPAT_SUFFIXES — so they would otherwise 404), mirroring the
    // /api/v1/videos ordering above. Read-only metadata; no body.
    if (pathname === "/api/v1/models" && req.method === "GET") {
      handleOpenRouterModels(req, res, fixtures, journal, defaults, setCorsHeaders);
      return;
    }
    if (pathname === "/api/v1/key" && req.method === "GET") {
      handleOpenRouterKey(req, res, journal, setCorsHeaders);
      return;
    }
    if (pathname === "/api/v1/credits" && req.method === "GET") {
      handleOpenRouterCredits(req, res, journal, setCorsHeaders);
      return;
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
        // Clear only the request journal entries, preserving fixture
        // match-counts (sequencing state). Clearing the request log must not
        // silently rewind sequenced fixtures. For a full reset (entries +
        // match-counts), use POST /__aimock/reset/fixtures.
        journal.clearEntries();
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
            res.end();
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
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
            res.end();
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
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
            res.end();
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
        }
      }
      return;
    }

    // POST /v2/embed — Cohere v2 Embed API
    if (pathname === COHERE_EMBED_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleCohereEmbed(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
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
          } catch (err) {
            if (!(err instanceof SyntaxError)) {
              defaults.logger.error(
                `Unexpected error in Azure model injection: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            // Fall through for parse errors — let handleEmbeddings report them
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

    // POST /v1/images/edits — OpenAI Image Edit API (multipart/form-data)
    if (pathname === IMAGES_EDIT_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleImageEdit(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
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

    // POST /v1/images/variations — OpenAI Image Variations API (multipart/form-data)
    if (pathname === IMAGES_VARIATIONS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleImageVariations(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
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

    // POST /v1/audio/translations — OpenAI Translation API
    if (pathname === TRANSLATIONS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleTranscription(
          req,
          res,
          raw,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          "translation",
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

    // POST /v1/videos/generations — xAI Grok Imagine video submit. A distinct
    // exact path from Sora's POST /v1/videos (no collision). Must precede the
    // Sora GET status RE which would otherwise parse `generations` as an id on
    // a GET — but this is a POST, so the guard is method-level here and
    // `id !== "generations"` in the GET block below. (T0: stub filled in T2.)
    if (pathname === GROK_VIDEO_SUBMIT_PATH && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = await readBody(req);
        await handleGrokVideoCreate(
          req,
          res,
          raw,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          grokVideoJobs,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        defaults.logger.error(`grok-video submit: ${msg}`);
        if (!res.headersSent) {
          try {
            journal.add({
              method: req.method ?? "POST",
              path: req.url ?? pathname,
              headers: flattenHeaders(req.headers),
              body: null,
              response: { status: 500, fixture: null },
            });
          } catch (jErr) {
            defaults.logger.warn(
              `grok-video submit: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
            );
          }
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

    // GET /v1/videos/{id} — Grok-first video status check. Grok Imagine and
    // Sora share this path: handleGrokVideoStatus does a job-map-first lookup
    // and falls through to the UNCHANGED Sora handleVideoStatus on a Grok miss
    // (disjoint id namespaces → unambiguous). The `id !== "generations"` guard
    // keeps the Grok submit literal out of the status RE. (T0: the Grok job map
    // is always empty, so every GET delegates to Sora — behavior-preserving.)
    const grokVideoStatusMatch = pathname.match(GROK_VIDEO_STATUS_RE);
    if (grokVideoStatusMatch && grokVideoStatusMatch[1] !== "generations" && req.method === "GET") {
      try {
        await handleGrokVideoStatus(
          req,
          res,
          grokVideoStatusMatch[1],
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          grokVideoJobs,
          videoStates,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        defaults.logger.error(`grok-video status: ${msg}`);
        if (!res.headersSent) {
          try {
            journal.add({
              method: req.method ?? "GET",
              path: req.url ?? pathname,
              headers: flattenHeaders(req.headers),
              body: null,
              response: { status: 500, fixture: null },
            });
          } catch (jErr) {
            defaults.logger.warn(
              `grok-video status: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
            );
          }
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

    // POST /v1beta/models/{model}:predictLongRunning — Google Veo video submit.
    // Anchored on `:predictLongRunning`, so it never collides with the Gemini
    // `:predict` Imagen route below. (T0: handler is a stub filled in T1.)
    const veoPredictMatch = pathname.match(VEO_PREDICT_LRO_RE);
    if (veoPredictMatch && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = await readBody(req);
        await handleVeoVideoCreate(
          req,
          res,
          raw,
          veoPredictMatch[1],
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          veoVideoJobs,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        defaults.logger.error(`veo-video submit: ${msg}`);
        if (!res.headersSent) {
          try {
            journal.add({
              method: req.method ?? "POST",
              path: req.url ?? pathname,
              headers: flattenHeaders(req.headers),
              body: null,
              response: { status: 500, fixture: null },
            });
          } catch (jErr) {
            defaults.logger.warn(
              `veo-video submit: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
            );
          }
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

    // GET /v1beta/operations/{name} — Google Veo video status poll.
    // (T0: handler is a stub filled in T1.)
    const veoOperationMatch = pathname.match(VEO_OPERATION_RE);
    if (veoOperationMatch && req.method === "GET") {
      try {
        await handleVeoVideoStatus(
          req,
          res,
          veoOperationMatch[1],
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          veoVideoJobs,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        defaults.logger.error(`veo-video status: ${msg}`);
        if (!res.headersSent) {
          try {
            journal.add({
              method: req.method ?? "GET",
              path: req.url ?? pathname,
              headers: flattenHeaders(req.headers),
              body: null,
              response: { status: 500, fixture: null },
            });
          } catch (jErr) {
            defaults.logger.warn(
              `veo-video status: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
            );
          }
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

    // POST /v1beta/interactions — Google Gemini Interactions API
    if (pathname === GEMINI_INTERACTIONS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleGeminiInteractions(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
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
            res.end();
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
        }
      }
      return;
    }

    // POST /v1beta/models/{model}:embedContent — Google Gemini Embedding
    const geminiEmbedMatch = pathname.match(GEMINI_EMBED_RE);
    if (geminiEmbedMatch && req.method === "POST") {
      const embedModel = geminiEmbedMatch[1];
      try {
        const raw = await readBody(req);
        await handleGeminiEmbedContent(
          req,
          res,
          raw,
          embedModel,
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
            res.end();
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
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
            res.end();
          } catch (writeErr) {
            logger.debug("Failed to write error recovery response:", writeErr);
          }
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

    // POST /v1/sound-generation — ElevenLabs Sound Generation API
    if (pathname === ELEVENLABS_SOUND_GENERATION_PATH && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = await readBody(req);
        await handleElevenLabsAudio(req, res, raw, fixtures, defaults, journal, "sound-generation");
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

    // POST /v1/text-to-speech/{voice_id} — ElevenLabs TTS API
    const elevenLabsTTSMatch = pathname.match(ELEVENLABS_TTS_RE);
    if (elevenLabsTTSMatch && req.method === "POST") {
      setCorsHeaders(res);
      const voiceId = elevenLabsTTSMatch[1];
      try {
        const raw = await readBody(req);
        await handleElevenLabsTTS(req, res, raw, fixtures, defaults, journal, voiceId);
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

    // POST /v1/music/(generation|variation|remix|extend) — ElevenLabs Music API
    const musicMatch = pathname.match(ELEVENLABS_MUSIC_RE);
    if (musicMatch && req.method === "POST") {
      setCorsHeaders(res);
      const musicSubType = musicMatch[1] ?? "music";
      try {
        const raw = await readBody(req);
        await handleElevenLabsAudio(req, res, raw, fixtures, defaults, journal, musicSubType);
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

    // Body read by the general fal handler; preserved so legacy fal-audio
    // routes below don't double-consume the stream on passthrough.
    let falBody: string | undefined;

    // /fal/* with `x-fal-target-host` header — general fal.ai routing
    // (queue.fal.run, fal.run, rest.fal.ai, rest.alpha.fal.ai).
    // Matches the requestMiddleware path-mirror convention used by
    // @fal-ai/client when proxyUrl can't be honoured server-side.
    if (FAL_PREFIX_RE.test(pathname) && req.headers["x-fal-target-host"]) {
      setCorsHeaders(res);
      try {
        falBody = req.method === "POST" || req.method === "PUT" ? await readBody(req) : "";
        const raw = falBody;
        const chaosAction = evaluateChaos(null, defaults.chaos, req.headers, defaults.logger);
        if (chaosAction) {
          applyChaosAction(
            chaosAction,
            res,
            null,
            journal,
            {
              method: req.method ?? "GET",
              path: pathname,
              headers: flattenHeaders(req.headers),
              body: { model: "", messages: [] },
            },
            "fixture",
            defaults.registry,
          );
          return;
        }
        const outcome = await handleFal(req, res, raw, pathname, fixtures, defaults, journal);
        if (outcome === "handled") return;
        // passthrough: fall through to legacy fal-audio routes below
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
        return;
      }
    }

    // POST /fal/queue/submit/{model} — fal.ai Queue Submit
    const falQueueSubmitMatch = pathname.match(FAL_QUEUE_SUBMIT_RE);
    if (falQueueSubmitMatch && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = falBody ?? (await readBody(req));
        await handleFalQueue(req, res, raw, pathname, fixtures, defaults, journal);
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

    // GET /fal/queue/requests/{requestId} — fal.ai Queue Status/Result
    const falQueueRequestsMatch = pathname.match(FAL_QUEUE_REQUESTS_RE);
    if (
      falQueueRequestsMatch &&
      (req.method === "GET" || req.method === "POST" || req.method === "PUT")
    ) {
      setCorsHeaders(res);
      try {
        const raw =
          req.method === "POST" || req.method === "PUT" ? (falBody ?? (await readBody(req))) : "{}";
        const chaosAction = evaluateChaos(null, defaults.chaos, req.headers, defaults.logger);
        if (chaosAction) {
          applyChaosAction(
            chaosAction,
            res,
            null,
            journal,
            {
              method: req.method ?? "GET",
              path: pathname,
              headers: flattenHeaders(req.headers),
              body: { model: "", messages: [] },
            },
            "fixture",
            defaults.registry,
          );
          return;
        }
        await handleFalQueue(req, res, raw, pathname, fixtures, defaults, journal);
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

    // POST /fal/run/{model} — fal.ai Synchronous Run
    const falRunMatch = pathname.match(FAL_RUN_RE);
    if (falRunMatch && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = falBody ?? (await readBody(req));
        await handleFalQueue(req, res, raw, pathname, fixtures, defaults, journal);
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

    // OpenRouter callers (original path under /api/v1/) get the OpenRouter
    // provider key + response shaping; OpenAI (/v1/...) callers are unchanged.
    const completionsProvider: RecordProviderKey = azureDeploymentId
      ? "azure"
      : isOpenRouter
        ? "openrouter"
        : "openai";
    try {
      await handleCompletions(
        req,
        res,
        fixtures,
        journal,
        defaults,
        azureDeploymentId,
        completionsProvider,
        isOpenRouter,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Internal error";
      if (!res.headersSent) {
        writeErrorResponse(
          res,
          500,
          isOpenRouter
            ? serializeOpenRouterError(500, msg)
            : JSON.stringify({
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
            `data: ${
              isOpenRouter
                ? serializeOpenRouterError(500, msg)
                : JSON.stringify({ error: { message: msg, type: "server_error" } })
            }\n\n`,
          );
          res.end();
        } catch (writeErr) {
          logger.debug("Failed to write error recovery response:", writeErr);
        }
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

    if (!validateRequestApiKey(req, resolvedAuth.policy).ok) {
      writeApiKeyUpgradeRejection(socket);
      return;
    }

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
        upgradeHeaders: req.headers,
      });
    } else if (pathname === REALTIME_PATH) {
      const transcriptionIntent = parsedUrl.searchParams.get("intent") === "transcription";
      const model = transcriptionIntent
        ? "gpt-transcribe"
        : (parsedUrl.searchParams.get("model") ?? "gpt-realtime-2");
      handleWebSocketRealtime(ws, fixtures, journal, {
        ...defaults,
        model,
        transcriptionIntent,
        testId: wsTestId,
        upgradeHeaders: req.headers,
      });
    } else if (pathname === GEMINI_LIVE_PATH) {
      handleWebSocketGeminiLive(ws, fixtures, journal, {
        ...defaults,
        model: "gemini-2.0-flash",
        testId: wsTestId,
        upgradeHeaders: req.headers,
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
    videoStates.clear();
    openRouterVideoJobs.clear();
    veoVideoJobs.clear();
    grokVideoJobs.clear();
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

      resolve({
        server,
        journal,
        url,
        defaults,
        videoStates,
        openRouterVideoJobs,
        veoVideoJobs,
        grokVideoJobs,
      });
    });
  });
}
