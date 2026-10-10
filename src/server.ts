import * as http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Fixture,
  FixtureFileEntry,
  ChatCompletionRequest,
  ChaosConfig,
  ChaosDefaults,
  HandlerDefaults,
  MisbehaviorScope,
  MisbehaviorConfig,
  JournalEntry,
  MockServerOptions,
  Mountable,
  RecordProviderKey,
} from "./types.js";
import {
  getFixtureMisbehaviorPosition,
  setFixtureMisbehaviorPosition,
  MISBEHAVIOR_CATALOG,
  WIRE_SUPPORT,
  parseMisbehavior,
  parseMisbehaviorHeader,
  resolveMisbehaviorSeed,
  planMisbehavior,
  recordMisbehaviorOutcome,
  resolveMisbehaviorShortCircuit,
} from "./misbehavior.js";
import { Journal } from "./journal.js";
import { matchFixtureDiagnostic, recordMatchOptions } from "./router.js";
import {
  validateFixtures,
  entryToFixture,
  isInjectableStatus,
  INJECTED_STATUS_RANGE,
  queueOneShotError,
  isOneShotError,
  claimOneShotError,
  clearFixtureQueue,
  releaseOneShotError,
  FixtureLoadError,
  MisbehaviorConfigError,
  enableHeldFixtureMisbehavior,
  markFixtureResponsesToolsExtended,
} from "./fixture-loader.js";
import { writeSSEStream, writeErrorResponse } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import {
  prepareOpenAIChatMisbehavior,
  resolveOpenAIChatMisbehaviorUsage,
  buildOpenAIRefusalChunks,
  buildOpenAIRefusalCompletion,
  buildOpenAIContentFilterChunks,
  buildOpenAIContentFilterCompletion,
  buildOpenAIReasoningChunks,
  buildOpenAIReasoningCompletion,
  buildTextChunks,
  buildToolCallChunks,
  buildTextCompletion,
  buildToolCallCompletion,
  buildContentWithToolCallsChunks,
  buildContentWithToolCallsCompletion,
  buildUsageChunk,
  resolveUsage,
  resolveFixtureBlockOutcome,
  extractOverrides,
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  serializeErrorResponse,
  isAudioResponse,
  isResponseFactory,
  isVideoResponse,
  isTranscriptionResponse,
  isImageResponse,
  isEmbeddingResponse,
  isJSONResponse,
  flattenHeaders,
  isJsonObject,
  validateToolsField,
  getTestId,
  resolveTestId,
  readBody,
  readBodyBufferBounded,
  RequestBodyTooLargeError,
  fixtureToolCallErrorCode,
  googleFixtureToolCallErrorDetails,
  isFixtureToolCallError,
  requireServedFunctionToolCalls,
  requireEmittedFunctionToolCalls,
  resolveRequestId,
  markMintedRequestId,
  resolveResponse,
  resolveStrictMode,
  wouldProxyMiss,
  resolveReasoningForModel,
  strictOverrideField,
  strictNoMatchMessage,
  strictNoMatchLogLine,
  runWithToolArgumentsScope,
  setFixtureListResponsesTools,
  getContext,
  describeMatch,
} from "./helpers.js";
import { DEFAULT_TEST_ID } from "./constants.js";
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
import {
  handleBytePlusVideoCreate,
  handleBytePlusVideoStatus,
  BytePlusVideoJobMap,
} from "./byteplus-video.js";
import { handleElevenLabsAudio, handleElevenLabsTTS } from "./elevenlabs-audio.js";
import {
  handleElevenLabsVoiceDesign,
  handleElevenLabsVoiceCreate,
  handleElevenLabsVoiceGet,
  handleElevenLabsVoiceDelete,
  clearElevenLabsVoices,
} from "./elevenlabs-voice.js";
import { handleFalQueue, falJobs } from "./fal-audio.js";
import { handleFal, falQueueStates, falWillHandle } from "./fal.js";
import { handleOllama, handleOllamaGenerate, handleOllamaEmbeddings } from "./ollama.js";
import { handleCohere, handleCohereEmbed } from "./cohere.js";
import { handleSearch, type SearchFixture } from "./search.js";
import { handleRerank, type RerankFixture } from "./rerank.js";
import { handleModeration, type ModerationFixture } from "./moderation.js";
import {
  handleBatchesCreate,
  handleBatchesList,
  handleBatchesRetrieve,
  handleBatchesCancel,
  clearBatchStore,
} from "./batches.js";
import {
  handleFilesCreate,
  handleFilesList,
  handleFilesRetrieve,
  handleFilesContent,
  handleFilesDelete,
  clearFileStore,
  FILES_BODY_DRAIN_MAX_BYTES,
  FILES_BODY_MAX_BYTES,
  FILES_BODY_OVERSIZED,
} from "./files.js";
import {
  handleFineTuningCreate,
  handleFineTuningList,
  handleFineTuningRetrieve,
  handleFineTuningCancel,
  handleFineTuningEvents,
  clearFineTuningStore,
} from "./fine-tuning.js";
import {
  handleVectorStoresCreate,
  handleVectorStoresList,
  handleVectorStoresRetrieve,
  handleVectorStoresModify,
  handleVectorStoresDelete,
  handleVectorStoreFilesCreate,
  handleVectorStoreFilesList,
  handleVectorStoreFilesRetrieve,
  handleVectorStoreFilesDelete,
  handleVectorFileBatchesCreate,
  handleVectorFileBatchesRetrieve,
  handleVectorFileBatchesCancel,
  handleVectorFileBatchesFiles,
  handleVectorStoresSearch,
  clearVectorStoreStore,
} from "./vector-stores.js";
import { upgradeToWebSocket, type WebSocketConnection } from "./ws-framing.js";
import { handleLiveSession } from "./ws-live.js";
import { normalizeLiveOptions } from "./live-fixture.js";
import { handleWebSocketResponses } from "./ws-responses.js";
import { handleWebSocketRealtime } from "./ws-realtime.js";
import { handleWebSocketGeminiLive } from "./ws-gemini-live.js";
import { Logger } from "./logger.js";
import {
  applyChaosAction,
  awaitChaosLatency,
  describeUnwritableReason,
  evaluateChaos,
  responseGoneReason,
  isChaosScope,
  resolveChaosConfig,
  resetChaosWarnings,
  parseChaosField,
  CHAOS_FIELDS,
  CHAOS_FIELD_NAMES,
} from "./chaos.js";
import { buildOpenApiDocument, CATALOG_ROUTES } from "./openapi.js";
// Route paths/patterns are the router's single source of truth — shared with
// the machine-readable catalog (`route-registry.ts` → `openapi.ts`), so the
// catalog cannot drift from the dispatcher. Every literal and pattern matched
// below comes from this module: adding a surface means adding it there, and
// `matchRouteDefinition` (used by the terminal-404 drift guard) resolves
// against the same table the catalog is derived from.
import {
  BATCHES_PATH,
  BATCHES_ID_RE,
  BATCHES_CANCEL_RE,
  COMPLETIONS_PATH,
  RESPONSES_PATH,
  REALTIME_PATH,
  LIVE_PATH,
  GEMINI_LIVE_PATH,
  MESSAGES_PATH,
  EMBEDDINGS_PATH,
  COHERE_CHAT_PATH,
  COHERE_EMBED_PATH,
  SEARCH_PATH,
  RERANK_PATH,
  MODERATIONS_PATH,
  IMAGES_PATH,
  IMAGES_EDIT_PATH,
  IMAGES_VARIATIONS_PATH,
  SPEECH_PATH,
  TRANSCRIPTIONS_PATH,
  TRANSLATIONS_PATH,
  VIDEOS_PATH,
  GROK_VIDEO_SUBMIT_PATH,
  GROK_VIDEO_STATUS_RE,
  VEO_PREDICT_LRO_RE,
  VEO_OPERATION_RE,
  GEMINI_PREDICT_RE,
  ELEVENLABS_SOUND_GENERATION_PATH,
  ELEVENLABS_TTS_RE,
  ELEVENLABS_MUSIC_RE,
  ELEVENLABS_VOICE_DESIGN_PATH,
  ELEVENLABS_VOICE_CREATE_PATH,
  ELEVENLABS_VOICE_RE,
  FAL_QUEUE_SUBMIT_RE,
  FAL_QUEUE_REQUESTS_RE,
  FAL_RUN_RE,
  FAL_ROUTE_RE,
  GEMINI_INTERACTIONS_PATH,
  GEMINI_PATH_RE,
  GEMINI_EMBED_RE,
  AZURE_DEPLOYMENT_RE,
  BEDROCK_INVOKE_RE,
  BEDROCK_STREAM_RE,
  BEDROCK_CONVERSE_RE,
  BEDROCK_CONVERSE_STREAM_RE,
  VERTEX_AI_RE,
  OLLAMA_CHAT_PATH,
  OLLAMA_GENERATE_PATH,
  OLLAMA_EMBEDDINGS_PATH,
  OLLAMA_EMBED_PATH,
  OLLAMA_TAGS_PATH,
  OPENROUTER_VIDEOS_PATH,
  OPENROUTER_VIDEO_MODELS_PATH,
  OPENROUTER_MODELS_PATH,
  OPENROUTER_KEY_PATH,
  OPENROUTER_CREDITS_PATH,
  OPENROUTER_VIDEO_CONTENT_RE,
  OPENROUTER_VIDEO_STATUS_RE,
  HEALTH_PATH,
  READY_PATH,
  METRICS_PATH,
  MODELS_PATH,
  REQUESTS_PATH,
  FILES_PATH,
  FILES_ID_RE,
  FILES_CONTENT_RE,
  VECTOR_STORES_PATH,
  VECTOR_STORES_SEARCH_RE,
  VECTOR_STORES_BATCH_FILES_RE,
  VECTOR_STORES_BATCH_CANCEL_RE,
  VECTOR_STORES_BATCH_RE,
  VECTOR_STORES_FILE_RE,
  VECTOR_STORES_ID_RE,
  VECTOR_STORES_FILES_RE,
  VECTOR_STORES_FILE_BATCHES_RE,
  BYTEPLUS_VIDEO_SUBMIT_RE,
  BYTEPLUS_VIDEO_STATUS_RE,
  FINE_TUNING_JOBS_PATH,
  FINE_TUNING_ID_RE,
  FINE_TUNING_CANCEL_RE,
  FINE_TUNING_EVENTS_RE,
  CONTROL_PREFIX,
  matchRouteDefinition,
} from "./route-registry.js";
import { createMetricsRegistry, normalizePathLabel, DESTROYED_STATUS_LABEL } from "./metrics.js";
import { proxyAndRecord } from "./recorder.js";
import {
  resolveInboundAuth,
  markAuthenticatedRequest,
  validateRequestApiKey,
  writeApiKeyHttpRejection,
  writeApiKeyUpgradeRejection,
  type ResolvedInboundAuth,
} from "./api-key-auth.js";
import type { McpFakeSource } from "./types.js";
import {
  ensureFakeMount,
  findFakeMount,
  handOffMcpFakes,
  isFakeMount,
  mountConflictDetail,
  type MountList,
} from "./mcp-fakes-mount.js";
import { handleFakesReportRoute } from "./mcp-fakes-report.js";
import { MCP_FAKES_DEFAULT_MOUNT, McpFakeStore, McpFakesAddError, blockIdOf } from "./mcp-fakes.js";
import { MCPMock } from "./mcp-mock.js";
import { build, msg, quote } from "./message-text.js";

const liveClosers = new WeakMap<HandlerDefaults, (testId?: string) => void>();

export interface ServerInstance {
  closeLiveSessions(testId?: string): void;
  server: http.Server;
  journal: Journal;
  url: string;
  defaults: HandlerDefaults;
  videoStates: VideoStateMap;
  openRouterVideoJobs: OpenRouterVideoJobMap;
  veoVideoJobs: VeoVideoJobMap;
  grokVideoJobs: GrokVideoJobMap;
  bytePlusVideoJobs: BytePlusVideoJobMap;
}

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

// OpenRouter async video lifecycle (/api/v1/videos). Dispatch order matters:
// content RE → models exact → status RE → submit exact. The status RE's
// `[^/]+` segment would otherwise swallow the `models` listing path. The
// content/status REs are shared with the route registry and metrics.ts
// path-label normalization (imported above).

const DEFAULT_MODELS = [
  "gpt-4",
  "gpt-4o",
  "claude-3-5-sonnet-20241022",
  "gemini-2.0-flash",
  "text-embedding-3-small",
];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  // Every method the dispatcher serves: PUT is dispatched for
  // `/fal/queue/requests/{requestId}` (status/cancel/result), so a preflight
  // that omits it makes browsers refuse that call.
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  // Response headers are invisible to cross-origin JS unless exposed. The
  // journal's pagination total is a response header (the body stays a bare
  // array for back-compat), so a browser harness needs this to read it.
  "Access-Control-Expose-Headers": "X-Total-Count, X-Request-Id",
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

/** The complete `GET /__aimock/fixtures` query-param vocabulary; anything else 400s. */
const FIXTURES_PARAMS: ReadonlySet<string> = new Set(["include"]);

/** The complete `GET /__aimock/journal` query-param vocabulary; anything else 400s. */
const JOURNAL_PARAMS: ReadonlySet<string> = new Set([
  "limit",
  "offset",
  "path",
  "method",
  "status",
  "service",
  "testId",
  "requestId",
]);

/**
 * The per-server state a full reset clears. `ServerInstance` structurally
 * satisfies this, so `LLMock.reset()` and the control-API full-reset route
 * share a single definition of "everything" instead of two lists that drift.
 */
export interface FullResetTargets {
  journal: Journal;
  videoStates: VideoStateMap;
  openRouterVideoJobs: OpenRouterVideoJobMap;
  veoVideoJobs: VeoVideoJobMap;
  grokVideoJobs: GrokVideoJobMap;
  bytePlusVideoJobs: BytePlusVideoJobMap;
  defaults: HandlerDefaults;
  /**
   * The server's mounts. A full reset unloads every MCP fake on them (R1, R2);
   * the entry-id counters and MCP sessions are kept.
   */
  mounts?: MountList;
}

/**
 * Perform a full reset: clear the fixtures array, the journal (entries *and*
 * per-test fixture match-counts, i.e. sequence position), the video and fal.ai
 * job/queue state, the fine-tuning store (jobs, their append-only event logs,
 * their poll counts, the create-time suffixes their model names are built from,
 * and the module's monotonic clock), the ElevenLabs Voice Design store, the
 * Gemini interaction/event-id counters, and any runtime chaos override
 * (reverting to the construction-time chaos config), then re-zero the
 * `aimock_fixtures_loaded` gauge.
 *
 * `targets` is `null` when no server is running (an in-process `reset()` before
 * `start()`). The process-global generation state is reset either way, since it
 * is not owned by any one server instance.
 *
 * Shared by `POST /__aimock/reset` (canonical), its deprecated
 * `POST /__aimock/reset/fixtures` alias, and `LLMock.reset()`.
 */
export function performFullReset(fixtures: Fixture[], targets: FullResetTargets | null): void {
  // Also invalidates one-shot claims parked in flight (see `clearFixtureQueue`).
  clearFixtureQueue(fixtures);
  falJobs.clear();
  falQueueStates.clear();
  clearBatchStore();
  clearElevenLabsVoices();
  clearFileStore();
  clearFineTuningStore();
  clearVectorStoreStore();
  resetInteractionCounter();
  resetEventIdCounter();
  if (!targets) return;
  liveClosers.get(targets.defaults)?.();
  targets.journal.clear();
  // Chaos warning latches are per-server state too: a suite that resets between
  // tests must see a bad static chaos value reported again, not inherit the
  // latch the previous test left armed. Scoped by the server's logger, so this
  // clears THIS server's latch and cannot re-arm a concurrent server's.
  resetChaosWarnings(targets.defaults.logger);
  // Drop any runtime chaos override installed via POST /__aimock/chaos, so the
  // server returns to the chaos configuration it was STARTED with. Reset is the
  // isolation barrier every parallel harness leans on; chaos leaking past it
  // poisons later tests with 500s that look like application bugs.
  targets.defaults.chaos = undefined;
  targets.defaults.misbehavior?.byTestId.clear();
  targets.videoStates.clear();
  targets.openRouterVideoJobs.clear();
  targets.veoVideoJobs.clear();
  targets.grokVideoJobs.clear();
  targets.bytePlusVideoJobs.clear();
  for (const { handler } of targets.mounts ?? []) handler.clearMcpFakes?.();
  if (targets.defaults.registry) {
    targets.defaults.registry.setGauge("aimock_fixtures_loaded", {}, fixtures.length);
  }
}

/**
 * JSON-safe redaction for control-API inspection output. Functions (fixture
 * `predicate`s, response factories) and RegExps do not survive
 * JSON.stringify as anything useful, so they become marker strings.
 */
function redactForInspection(value: unknown): unknown {
  if (typeof value === "function") return "[function]";
  if (value instanceof RegExp) return String(value);
  if (Array.isArray(value)) return value.map(redactForInspection);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactForInspection(entry);
    }
    return out;
  }
  return value;
}

/**
 * One-line kind label for a fixture response used by
 * `GET /__aimock/fixtures?include=fixtures` (e.g. "text", "error").
 * Response factories are reported as "factory".
 *
 * Discriminates with the same `is*Response` guards the request handlers use,
 * in the same order — NOT by inspecting keys. Every response shape extends
 * `ResponseOverrides` (`id`/`created`/`model`/`usage`), so a recorded fixture's
 * first key is usually an envelope override rather than the discriminant. The
 * audio-before-content/toolCalls order is the ORDERING CONTRACT documented on
 * `AudioResponse` in types.ts: those shapes structurally overlap.
 */
function fixtureResponseKind(response: Fixture["response"]): string {
  if (isResponseFactory(response)) return "factory";
  if (isErrorResponse(response)) return "error";
  if (isAudioResponse(response)) return "audio";
  if (isVideoResponse(response)) return "video";
  if (isTranscriptionResponse(response)) return "transcription";
  if (isImageResponse(response)) return "image";
  if (isEmbeddingResponse(response)) return "embedding";
  if (isJSONResponse(response)) return "json";
  if (isContentWithToolCallsResponse(response)) return "contentWithToolCalls";
  if (isToolCallResponse(response)) return "toolCalls";
  if (isTextResponse(response)) return "text";
  return "unknown";
}

/**
 * The testId a journal entry was scoped under — `resolveTestId` applied to the
 * journaled headers and path, i.e. the SAME function that scoped the request
 * (fixture match-counts, chaos) when it arrived. Node folds a repeated
 * `X-Test-Id` into one string ("a, a") before either side sees it, and the
 * request is counted and chaos-evaluated under that folded string, so the
 * `?testId=` filter matches it verbatim too: no token-splitting here that the
 * scoping path does not also do. (Splitting on "," additionally broke every
 * legitimately comma-bearing id.) A raw `path.includes("testId=t1")` both
 * prefix-collides with `t10` and matches unrelated params like `notTestId`.
 *
 * An MCP mount records the test id it resolved on the entry (I9, B3): a
 * decoded header or query value, or the one bound to the session at
 * `initialize`. That value wins; LLM entries carry none and are attributed as
 * before.
 */
function journalEntryTestId(entry: JournalEntry): string {
  return entry.testId ?? resolveTestId(entry.headers, entry.path);
}

/**
 * The testId a chaos override is stored under, and read back with — resolved by
 * `getTestId`, i.e. `X-Test-Id` header then `?testId=`, exactly as
 * `resolveScopedDefaults` resolves the traffic being evaluated. A control call
 * and the requests it is meant to affect can then never land in different
 * scopes. `DEFAULT_TEST_ID` (neither header nor param) means the server-wide
 * baseline.
 *
 * Returns `null` when `X-Test-Id` is PRESENT but blank. `String(testId ?? "")`
 * in a harness produces that trivially, and silently treating it as "untagged"
 * would install a server-wide baseline that fails every other test — the exact
 * cross-test leak per-testId scoping exists to prevent. Callers must 400.
 */
function chaosScopeId(req: http.IncomingMessage): string | null {
  const headerValue = req.headers["x-test-id"];
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw === "string" && raw.trim() === "") return null;
  return getTestId(req);
}

/** 400 for a control call whose `X-Test-Id` is present but blank. */
function writeBlankTestId(res: http.ServerResponse): true {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Invalid 'X-Test-Id': header is present but empty" }));
  return true;
}

/**
 * The chaos config in effect for one testId: its override, else the baseline —
 * one or the other, never the two merged. Mirrors `resolveScopedDefaults` in
 * chaos.ts, so what `GET /__aimock/chaos` reports for a scope is exactly what
 * that scope's traffic is evaluated against.
 */
function effectiveChaos(defaults: HandlerDefaults, scopeId: string): ChaosConfig {
  // `has`, not truthiness — an installed-but-empty override is a selection (see
  // `resolveScopedDefaults`), so it must shadow the baseline here too or `GET`
  // would report a config the traffic is not evaluated against.
  if (defaults.chaosByTestId?.has(scopeId)) return defaults.chaosByTestId.get(scopeId) ?? {};
  const current = defaults.chaos;
  if (!current) return {};
  return isChaosScope(current) ? (current.base ?? {}) : current;
}

/** The `GET /__aimock/mcp/fakes` query-param vocabulary; anything else 400s. */
const MCP_FAKES_PARAMS = new Set(["testId", "context", "mount"]);

/** A block's `mount` path, read without running getters; the add validates it. */
function controlFakeMountOf(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return MCP_FAKES_DEFAULT_MOUNT;
  const value: unknown = Object.getOwnPropertyDescriptor(raw, "mount")?.value;
  return typeof value === "string" ? value : MCP_FAKES_DEFAULT_MOUNT;
}

/** The blocks of one control-API `mcpFakes` value that go to one mount path. */
interface ControlFakeGroup {
  path: string;
  /** Position of each block in the request's `mcpFakes` value. */
  positions: number[];
  sources: McpFakeSource[];
}

/** What the after-start auto-mount of a control-API add is wired with (W6, as W4). */
interface ControlFakeWiring {
  journal: Journal;
  defaults: HandlerDefaults;
}

/**
 * Check one `POST /__aimock/fixtures` `mcpFakes` value against the live
 * mounts (F10, W6) without changing anything. Returns every error in input
 * order (an empty list when the value can be added), and `apply`, which adds
 * the blocks (auto-mounting an MCPMock where no mount serves a block's path)
 * and returns the number of blocks added.
 *
 * The whole value is checked before any mount is touched, and the check
 * never adds to a real mount: each group is added to a throwaway store,
 * whose errors are the ones reported (it numbers the add `control-api#1`, as
 * a new mount would; for an existing MCPMock the rejected group is re-run on
 * its atomic add, so the errors name that mount's next `<n>`, I7). A group
 * whose path no request to it can reach (a mount that is not an MCPMock
 * serves it, an MCPMock answers it as its root, or it is under the control
 * prefix) is a mount conflict (one error per block).
 */
function planControlApiFakes(
  raw: unknown,
  mounts: MountList,
): { errors: FixtureLoadError[]; apply(wiring: ControlFakeWiring): number } {
  const items: Array<{ position: number; source: McpFakeSource }> = Array.isArray(raw)
    ? raw.map((block: unknown, position) => ({
        position,
        source: { source: "control-api", blockIndex: position, raw: block },
      }))
    : [{ position: 0, source: { source: "control-api", blockIndex: null, raw } }];

  const groups = new Map<string, ControlFakeGroup>();
  // An empty `mcpFakes` array is one (bad) add to the default mount.
  if (items.length === 0) {
    groups.set(MCP_FAKES_DEFAULT_MOUNT, {
      path: MCP_FAKES_DEFAULT_MOUNT,
      positions: [],
      sources: [],
    });
  }
  for (const { position, source } of items) {
    const path = controlFakeMountOf(source.raw);
    const group = groups.get(path) ?? { path, positions: [], sources: [] };
    group.positions.push(position);
    group.sources.push(source);
    groups.set(path, group);
  }

  const found: Array<{ position: number; error: FixtureLoadError }> = [];
  /** The paths `apply` auto-mounts, in order. */
  const pending: string[] = [];
  for (const group of groups.values()) {
    const target = findFakeMount(mounts, group.path, pending);
    if (target.kind === "conflict") {
      group.positions.forEach((position) => {
        const where = Array.isArray(raw) ? msg`mcpFakes[${position}]` : msg`mcpFakes`;
        found.push({
          position,
          error: new FixtureLoadError({
            rule: "mcp-fakes/mount-conflict",
            file: null,
            blockId: null,
            entryId: null,
            detail: msg`${where}: ${mountConflictDetail(group.path, target)}`,
          }),
        });
      });
      continue;
    }
    let failure = addFailure(() => new McpFakeStore().add(group.sources, { kind: "control-api" }));
    if (target.kind === "none") pending.push(group.path);
    if (!failure) continue;
    // The throwaway numbers the add `control-api#1`; an existing MCPMock's
    // errors must name its own next `<n>` (I7). Its add is atomic (a throw
    // adds nothing and consumes no `<n>`), so the same rejected input is
    // re-run on it for the numbered errors. A mount with any other add is
    // never called here (A2).
    if (target.kind === "mcp" && target.handler.addMcpFakes === MCPMock.prototype.addMcpFakes) {
      const handler = target.handler;
      failure =
        addFailure(() => handler.addMcpFakes?.(group.sources, { kind: "control-api" })) ?? failure;
    }
    for (const error of failure.errors) {
      found.push({ position: positionOf(error, group), error });
    }
  }
  found.sort((a, b) => a.position - b.position);

  return {
    errors: found.map((f) => f.error),
    apply(wiring: ControlFakeWiring): number {
      let added = 0;
      for (const group of groups.values()) {
        const target = ensureFakeMount(
          mounts,
          group.path,
          {
            journal: wiring.journal,
            registry: wiring.defaults.registry,
            logger: wiring.defaults.logger,
            replaySpeed: wiring.defaults.replaySpeed,
          },
          wiring.defaults.logger,
        );
        // The plan found no conflict, and nothing else runs in between.
        if ("conflict" in target) continue;
        const result = target.handler.addMcpFakes?.(group.sources, { kind: "control-api" });
        for (const warning of result?.warnings ?? []) wiring.defaults.logger.warn(warning.message);
        added += group.sources.length;
      }
      return added;
    },
  };
}

/** The `McpFakesAddError` that `add` throws, or `null` when it adds. */
function addFailure(add: () => unknown): McpFakesAddError | null {
  try {
    add();
    return null;
  } catch (err) {
    if (err instanceof McpFakesAddError) return err;
    throw err;
  }
}

/**
 * The request position of the block an add error names. The add numbers a
 * run-time group's blocks by their place in the group (`[<j>]`), or gives no
 * index to a single-object value; an error tied to no block sorts with the
 * group's first block.
 */
function positionOf(error: FixtureLoadError, group: ControlFakeGroup): number {
  const first = group.positions[0] ?? 0;
  if (error.blockId == null || error.file === null) return first;
  const at = group.positions.findIndex(
    (_, j) => error.blockId === blockIdOf(error.file ?? "", "", j),
  );
  return at === -1 ? first : group.positions[at];
}

/** The listing half of an MCP mount, as `MCPMock` has it. */
interface FakesSnapshotSource {
  fakesSnapshot: MCPMock["fakesSnapshot"];
}

function hasFakesSnapshot(handler: Mountable): handler is Mountable & FakesSnapshotSource {
  return "fakesSnapshot" in handler && typeof handler.fakesSnapshot === "function";
}

/**
 * `GET /__aimock/mcp/fakes` (spec 6.5, I9): for each MCP mount (or the one
 * named by `mount`), the blocks that apply to the requested test id and
 * context, with every entry id and its consumed state for that test id.
 * A mount is listed when it takes fakes (it implements `addMcpFakes`, the
 * check every other fakes path uses); one with no `fakesSnapshot` lists no
 * blocks.
 */
function listControlApiFakes(
  mounts: MountList,
  testId: string | null,
  context: string | null,
  mount: string | null,
): Array<{ mount: string; blocks: ReturnType<MCPMock["fakesSnapshot"]> }> | null {
  const listed = mounts.flatMap(({ path, handler }) =>
    isFakeMount(handler) && (mount === null || path === mount)
      ? [
          {
            mount: path,
            blocks: hasFakesSnapshot(handler) ? handler.fakesSnapshot(testId, context) : [],
          },
        ]
      : [],
  );
  return mount !== null && listed.length === 0 ? null : listed;
}

// Per-server addition identities survive fixture deletion and full resets.
const controlFixtureAdditions = new WeakMap<HandlerDefaults, number>();

/**
 * Handle requests under `/__aimock/`. Returns `true` if the request was
 * handled, `false` if the path doesn't match the control prefix.
 */
async function handleControlAPI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  fixtures: Fixture[],
  journal: Journal,
  videoStates: VideoStateMap,
  openRouterVideoJobs: OpenRouterVideoJobMap,
  veoVideoJobs: VeoVideoJobMap,
  grokVideoJobs: GrokVideoJobMap,
  bytePlusVideoJobs: BytePlusVideoJobMap,
  defaults: HandlerDefaults,
  mounts: MountList,
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

  // GET /__aimock/openapi.json — machine-readable route catalog.
  if (subPath === "/openapi.json" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildOpenApiDocument()));
    return true;
  }

  // GET /__aimock/routes — flat method+path list for shells.
  if (subPath === "/routes" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: CATALOG_ROUTES.length, routes: CATALOG_ROUTES }));
    return true;
  }

  // GET /__aimock/journal — optionally filtered/paginated.
  // No query params → full array (historical behaviour, unchanged).
  // Supported params: limit (int >= 0), offset (int >= 0, default 0),
  // path (SUBSTRING), method (exact, case-insensitive), status (int),
  // service (EXACT), testId (resolved exactly as the server resolves it).
  // Anything else is a 400: silently ignoring an unknown param would let
  // `?statusCode=404` return the whole journal and pass a caller's assertion
  // against traffic it never meant to select.
  if (subPath === "/journal" && req.method === "GET") {
    const bad = (message: string): true => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return true;
    };
    for (const key of searchParams.keys()) {
      if (!JOURNAL_PARAMS.has(key)) {
        return bad(
          `Unknown query parameter: '${key}'. Supported: ${[...JOURNAL_PARAMS].join(", ")}`,
        );
      }
    }
    const parseNonNegativeInt = (name: string, fallback: number): number | null => {
      const raw = searchParams.get(name);
      if (raw === null) return fallback;
      if (!/^\d+$/.test(raw.trim())) return null;
      return Number(raw);
    };
    const limit = parseNonNegativeInt("limit", -1);
    const offset = parseNonNegativeInt("offset", 0);
    if (limit === null) return bad("Invalid 'limit': must be an integer >= 0");
    if (offset === null) return bad("Invalid 'offset': must be an integer >= 0");
    let statusFilter: number | undefined;
    const statusRaw = searchParams.get("status");
    if (statusRaw !== null) {
      if (!/^\d+$/.test(statusRaw.trim())) return bad("Invalid 'status': must be an integer");
      statusFilter = Number(statusRaw);
    }
    const pathFilter = searchParams.get("path");
    const methodFilter = searchParams.get("method");
    const serviceFilter = searchParams.get("service");
    const testIdFilter = searchParams.get("testId");
    const requestIdFilter = searchParams.get("requestId");

    let entries: JournalEntry[] = journal.getAll();
    if (methodFilter !== null) {
      const want = methodFilter.toUpperCase();
      entries = entries.filter((e) => e.method.toUpperCase() === want);
    }
    if (pathFilter !== null) {
      entries = entries.filter((e) => e.path.includes(pathFilter));
    }
    if (statusFilter !== undefined) {
      entries = entries.filter((e) => e.response.status === statusFilter);
    }
    if (serviceFilter !== null) {
      entries = entries.filter((e) => e.service === serviceFilter);
    }
    if (testIdFilter !== null) {
      entries = entries.filter((e) => journalEntryTestId(e) === testIdFilter);
    }
    if (requestIdFilter !== null) {
      entries = entries.filter((e) => e.headers["x-request-id"] === requestIdFilter);
    }
    // Count AFTER filtering but BEFORE pagination, so a paging caller can tell
    // when it is done. It ships as a header because the body is a bare array
    // for back-compat and can never grow an envelope.
    const total = entries.length;
    if (offset > 0) entries = entries.slice(offset);
    if (limit >= 0) entries = entries.slice(0, limit);

    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Total-Count": String(total),
    });
    res.end(JSON.stringify(entries));
    return true;
  }

  // GET /__aimock/fixtures — inspect current fixture count. With
  // ?include=fixtures, also dump each fixture's (redacted) match criteria
  // and response kind so harnesses can assert what would match.
  if (subPath === "/fixtures" && req.method === "GET") {
    // Unknown params 400 for the same reason `/journal` does: a typo like
    // `?incluide=fixtures` must never quietly return the count-only body and
    // pass an assertion against a dump the caller never received.
    for (const key of searchParams.keys()) {
      if (!FIXTURES_PARAMS.has(key)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Unknown query parameter: '${key}'. Supported: ${[...FIXTURES_PARAMS].join(", ")}`,
          }),
        );
        return true;
      }
    }
    const include = searchParams.get("include");
    if (include === null) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: fixtures.length }));
      return true;
    }
    if (include !== "fixtures") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid 'include': expected 'fixtures'" }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        count: fixtures.length,
        fixtures: fixtures.map((fixture, index) => ({
          index,
          match: redactForInspection(fixture.match),
          // NOT `response` — that name already means the response ITSELF on
          // `Fixture`, and this is only a one-word kind label. A queued
          // one-shot error carries a FACTORY response (the factory performs
          // the idempotent claim), so the shape test alone reports "factory"
          // and this surface loses the one signal it exists to give: that an
          // injection is armed. Take the kind from the one-shot MARKER.
          responseKind: isOneShotError(fixture) ? "error" : fixtureResponseKind(fixture.response),
          ...(fixture.latency !== undefined ? { latency: fixture.latency } : {}),
          ...(fixture.chaos !== undefined ? { chaos: fixture.chaos } : {}),
        })),
      }),
    );
    return true;
  }

  if (subPath === "/misbehavior/catalog" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ catalog: MISBEHAVIOR_CATALOG, WIRE_SUPPORT }));
    return true;
  }

  if (
    subPath === "/misbehavior" &&
    (req.method === "GET" || req.method === "POST" || req.method === "DELETE")
  ) {
    const scopeId = chaosScopeId(req);
    if (scopeId === null) return writeBlankTestId(res);
    const reply = (status: number, body: unknown): true => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return true;
    };
    const scope = defaults.misbehavior;
    if (!scope && req.method !== "GET") {
      return reply(409, {
        error:
          "misbehavior is not enabled: start aimock with enableMisbehavior: true (CLI: --misbehavior)",
      });
    }
    if (req.method === "POST") {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        defaults.logger.error(`POST /__aimock/misbehavior: failed to read body: ${msg}`);
        return reply(400, { error: `Failed to read request body: ${msg}` });
      }
      let input: unknown;
      try {
        input = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        defaults.logger.error(`POST /__aimock/misbehavior: invalid JSON: ${msg}`);
        return reply(400, { error: `Invalid JSON: ${msg}` });
      }
      // Only this route treats an empty object as an explicit opt-out.
      if (isJsonObject(input) && Object.keys(input).length === 0) input = { faults: [] };
      const parsed = parseMisbehavior(input);
      if (!parsed.ok) {
        return reply(400, {
          error: "Validation failed",
          rule: parsed.issue.rule,
          message: parsed.issue.message,
        });
      }
      const config =
        parsed.config.seed === "random"
          ? { ...parsed.config, seed: resolveMisbehaviorSeed(parsed.config.seed, defaults.logger) }
          : parsed.config;
      scope?.byTestId.set(scopeId, config);
    } else if (req.method === "DELETE") {
      scope?.byTestId.delete(scopeId);
    }
    return reply(200, {
      misbehavior: scope?.byTestId.get(scopeId) ?? scope?.baseline ?? { faults: [] },
    });
  }

  // GET /__aimock/chaos — read the chaos config in effect for THIS caller's
  // testId: its own override if one is installed, else the server-wide
  // baseline (the construction config, or an untagged override).
  if (subPath === "/chaos" && req.method === "GET") {
    const scopeId = chaosScopeId(req);
    if (scopeId === null) return writeBlankTestId(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ chaos: effectiveChaos(defaults, scopeId) }));
    return true;
  }

  // DELETE /__aimock/chaos — drop the override for this caller's testId (or the
  // server-wide baseline when untagged), falling back to what it shadowed.
  // `POST {}` means "explicitly no chaos"; this means "forget I said anything".
  //
  // SYMMETRIC with POST: an untagged DELETE drops the untagged baseline ONLY.
  // Dropping every per-testId override too would let one test's cleanup revoke
  // a concurrently-running test's opt-out. `POST /__aimock/reset` is the one
  // route that clears everything.
  if (subPath === "/chaos" && req.method === "DELETE") {
    const scopeId = chaosScopeId(req);
    if (scopeId === null) return writeBlankTestId(res);
    defaults.chaosByTestId?.delete(scopeId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ chaos: effectiveChaos(defaults, scopeId) }));
    return true;
  }

  // POST /__aimock/chaos — replace the server chaos config at runtime (no
  // restart). Accepts any subset of dropRate/malformedRate/disconnectRate as
  // numbers in [0, 1]; `{}` means explicitly no chaos. Unknown fields and
  // out-of-range values are rejected with 400.
  //
  // SCOPED to the caller's testId (`X-Test-Id`, else `?testId=`), like every
  // other mutable axis in the server (fixture match-counts, video job maps): an
  // override installed by test `t1` applies only to traffic resolving to `t1`.
  // An untagged call sets the server-wide baseline. `POST /__aimock/reset`
  // drops all of it, restoring the chaos config the server was STARTED with.
  //
  // REPLACES WHOLESALE — the body is not merged over the config it shadows. A
  // server started with `--chaos-latency 500` that is sent `{ "dropRate": 1 }`
  // for `t1` gives `t1` drops and NO latency: restate `latencyMs` to keep it.
  // That is what makes `POST {}` ("explicitly no chaos") different from
  // `DELETE` ("fall back to what I was shadowing"); under a merge, `POST {}`
  // would be a no-op. The 200 body echoes the config actually in effect for the
  // scope, and any field that WAS in effect and is not restated is named in a
  // warning, so a dropped baseline rate is never silent.
  if (subPath === "/chaos" && req.method === "POST") {
    const scopeId = chaosScopeId(req);
    if (scopeId === null) return writeBlankTestId(res);
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      defaults.logger.error(`POST /__aimock/chaos: failed to read body: ${msg}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Failed to read request body: ${msg}` }));
      return true;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      defaults.logger.error(`POST /__aimock/chaos: invalid JSON: ${msg}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid JSON: ${msg}` }));
      return true;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid body: expected a JSON object" }));
      return true;
    }
    // The set of fields and their bounds come from `CHAOS_FIELDS`, and each
    // value is validated by the same `parseChaosField` every other chaos source
    // uses. Re-typing the limits here is how this endpoint used to accept
    // `{ latencyMs: 250.5 }` with a 200 and echo it back from `GET`, while the
    // resolver silently discarded it at request time as a non-integer: the
    // control API reported a config the traffic never saw.
    for (const key of Object.keys(parsed)) {
      if (!(CHAOS_FIELD_NAMES as readonly string[]).includes(key)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown chaos field: '${key}'` }));
        return true;
      }
    }
    const next: ChaosConfig = {};
    for (const key of CHAOS_FIELD_NAMES) {
      const value = parsed[key];
      if (value === undefined) continue;
      // JSON body: the field must be a number. A numeric STRING is a
      // client-side type error here, not a wire spelling to be parsed — the
      // header API is the surface that takes text.
      const accepted = typeof value === "number" ? parseChaosField(key, value) : undefined;
      if (accepted === undefined) {
        const shape = CHAOS_FIELDS[key].integer ? "a whole number of ms" : "a number";
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Invalid '${key}': must be ${shape} between 0 and ${CHAOS_FIELDS[key].max}`,
          }),
        );
        return true;
      }
      next[key] = accepted;
    }
    // The install REPLACES what was in effect for this scope; it does not merge
    // over it. Name every field that was in effect and is not restated, so a
    // baseline rate a test silently loses (the classic case: a server-wide
    // `--chaos-latency` vanishing under a scoped `{ dropRate: 1 }`) shows up in
    // the log instead of as a mystery in the timings.
    const shadowed = effectiveChaos(defaults, scopeId);
    const droppedFields = (Object.keys(shadowed) as (keyof ChaosConfig)[]).filter(
      (key) => shadowed[key] !== undefined && next[key] === undefined,
    );
    if (droppedFields.length > 0) {
      const lost = droppedFields.map((key) => `${key}=${shadowed[key]}`).join(", ");
      defaults.logger.warn(
        `[chaos] POST /__aimock/chaos (testId '${scopeId}') replaces the chaos config for this ` +
          `scope wholesale, it is not merged: ${lost} no longer applies here. ` +
          `Restate the field in the body to keep it.`,
      );
    }
    defaults.chaosByTestId?.set(scopeId, next);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ chaos: effectiveChaos(defaults, scopeId) }));
    return true;
  }

  // GET /__aimock/mcp/fakes — the MCP fakes that apply to a test id/context,
  // per mount, with each entry's consumed state (spec 6.5, I9).
  if (subPath === "/mcp/fakes" && req.method === "GET") {
    const reply = (status: number, body: unknown): true => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return true;
    };
    for (const key of searchParams.keys()) {
      if (!MCP_FAKES_PARAMS.has(key)) {
        return reply(400, {
          error: `Unknown query parameter: '${key}'. Supported: ${[...MCP_FAKES_PARAMS].join(", ")}`,
        });
      }
    }
    // Empty values are not supplied (I1, I2).
    const testId = searchParams.get("testId") || null;
    const context = searchParams.get("context") || null;
    const mount = searchParams.get("mount") || null;
    const listed = listControlApiFakes(mounts, testId, context, mount);
    if (listed === null) {
      return reply(404, { error: build(msg`No MCP mount at ${quote(mount ?? "")}`) });
    }
    return reply(200, { testId, context, mounts: listed });
  }

  // GET /__aimock/mcp/fakes/report — the per-test fake report (RP6).
  if (subPath === "/mcp/fakes/report" && req.method === "GET") {
    return handleFakesReportRoute(res, searchParams, mounts);
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

    let parsed: { fixtures?: FixtureFileEntry[]; mcpFakes?: unknown } | null;
    try {
      parsed = JSON.parse(raw) as { fixtures?: FixtureFileEntry[]; mcpFakes?: unknown } | null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      defaults.logger.error(`POST /__aimock/fixtures: invalid JSON: ${msg}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid JSON: ${msg}` }));
      return true;
    }

    // F10, B6: `fixtures` is optional when the body carries `mcpFakes`.
    const withFakes =
      typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, "mcpFakes");
    if (
      parsed === null ||
      (!Array.isArray(parsed.fixtures) && !(withFakes && parsed.fixtures === undefined))
    ) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing or invalid "fixtures" array' }));
      return true;
    }
    const entries: FixtureFileEntry[] = Array.isArray(parsed.fixtures) ? parsed.fixtures : [];

    const missingMatchIndex = entries.findIndex(
      (entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry) && entry.match == null,
    );
    if (missingMatchIndex !== -1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Fixture at index ${missingMatchIndex} is missing match` }));
      return true;
    }

    const invalidMatchIndex = entries.findIndex(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        entry.match != null &&
        (typeof entry.match !== "object" || Array.isArray(entry.match)),
    );
    if (invalidMatchIndex !== -1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: `Fixture at index ${invalidMatchIndex}: match must be an object` }),
      );
      return true;
    }

    const addition = controlFixtureAdditions.get(defaults) ?? 0;
    controlFixtureAdditions.set(defaults, addition + 1);
    const converted: Fixture[] = [];
    const loadErrors: (FixtureLoadError | MisbehaviorConfigError)[] = [];
    for (const [index, entry] of entries.entries()) {
      try {
        const fixture = entryToFixture(entry, undefined, undefined, {
          file: `control-api#${addition}`,
          index,
        });
        if (defaults.misbehavior) enableHeldFixtureMisbehavior(fixture);
        if (defaults.responsesTools === "extended") markFixtureResponsesToolsExtended(fixture);
        converted.push(fixture);
      } catch (error) {
        if (!(error instanceof FixtureLoadError || error instanceof MisbehaviorConfigError)) {
          throw error;
        }
        loadErrors.push(error);
      }
    }
    // Only a fully converted batch preserves the original validation indices.
    const issues = loadErrors.length === 0 ? validateFixtures(converted) : [];
    const errors = issues.filter((i) => i.severity === "error");
    // The whole body is checked before anything is added (W6): the LLM
    // fixtures, then every `mcpFakes` block against the live mounts.
    const fakes = withFakes ? planControlApiFakes(parsed.mcpFakes, mounts) : null;
    const fakeErrors = fakes?.errors ?? [];
    const validationFailed = (details: unknown[]): true => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Validation failed", details }));
      return true;
    };
    if (loadErrors.length > 0 || errors.length > 0 || fakeErrors.length > 0) {
      return validationFailed([
        ...loadErrors.map((e) => e.toJSON()),
        ...errors,
        ...fakeErrors.map((e) => e.toJSON()),
      ]);
    }

    let mcpFakesAdded = 0;
    if (fakes) {
      try {
        mcpFakesAdded = fakes.apply({ journal, defaults });
      } catch (err) {
        if (!(err instanceof McpFakesAddError)) throw err;
        return validationFailed(err.errors.map((e) => e.toJSON()));
      }
    }
    fixtures.push(...converted);
    if (defaults.registry) {
      defaults.registry.setGauge("aimock_fixtures_loaded", {}, fixtures.length);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        withFakes ? { added: converted.length, mcpFakesAdded } : { added: converted.length },
      ),
    );
    return true;
  }

  // DELETE /__aimock/fixtures — clear all fixtures, and every MCP fake (R3)
  if (subPath === "/fixtures" && req.method === "DELETE") {
    clearFixtureQueue(fixtures);
    journal.clearMisbehaviorCounters();
    for (const { handler } of mounts) handler.clearMcpFakes?.();
    if (defaults.registry) {
      defaults.registry.setGauge("aimock_fixtures_loaded", {}, fixtures.length);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cleared: true }));
    return true;
  }

  const resetTargets = (): FullResetTargets => ({
    journal,
    videoStates,
    openRouterVideoJobs,
    veoVideoJobs,
    grokVideoJobs,
    bytePlusVideoJobs,
    defaults,
    mounts,
  });

  // POST /__aimock/reset — full reset (fixtures, journal entries + fixture
  // match-counts, video/fal job state, Gemini counters)
  if (subPath === "/reset" && req.method === "POST") {
    performFullReset(fixtures, resetTargets());
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

  // POST /__aimock/reset/fixtures — DEPRECATED alias for /reset. The name
  // promises a fixtures-only reset but it always performed the full reset;
  // /reset is the honest route. Behaviour is unchanged for existing callers.
  if (subPath === "/reset/fixtures" && req.method === "POST") {
    performFullReset(fixtures, resetTargets());
    const deprecation =
      "POST /__aimock/reset/fixtures is deprecated; use POST /__aimock/reset (full reset) or POST /__aimock/reset/journal (journal only)";
    defaults.logger.warn(
      "POST /__aimock/reset/fixtures is deprecated; use /__aimock/reset or /__aimock/reset/journal",
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

    // Validate the payload — an unchecked `status` reaches
    // `res.writeHead(status)` on the next matched request and throws
    // ERR_HTTP_INVALID_STATUS_CODE for 99, 0, 1000 or 99.5, losing the
    // injected error and degrading to a generic 500.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid body: expected a JSON object" }));
      return true;
    }
    // Omitted — or an explicit null, which is how a serializer spells an absent
    // optional — keeps the historic default of 500.
    const status = parsed.status ?? 500;
    if (!isInjectableStatus(status)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid 'status': must be ${INJECTED_STATUS_RANGE}` }));
      return true;
    }
    const errorBody = parsed.body;
    // `body: null` is an absent body, not a malformed one — same rule as the
    // fields below and as `status`. Rejecting it broke a call that worked
    // (main defaulted every field) for a shape any serializer emits for an
    // unset optional.
    if (errorBody !== undefined && errorBody !== null) {
      if (typeof errorBody !== "object" || Array.isArray(errorBody)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid 'body': must be an object" }));
        return true;
      }
      for (const field of ["message", "type", "code"] as const) {
        const value = errorBody[field];
        // null means absent, not invalid: aimock's own error envelope
        // (`serializeErrorResponse`) emits `code: null`, and so does a real
        // OpenAI error, so a captured body can be pasted back verbatim.
        if (value !== undefined && value !== null && typeof value !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Invalid 'body.${field}': must be a string` }));
          return true;
        }
      }
    }
    // Shared with `LLMock.nextRequestError`: same endpoint gate, consumed when
    // served rather than when its predicate is evaluated.
    queueOneShotError(fixtures, status, errorBody ?? undefined);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: true }));
    return true;
  }

  // Unknown control path
  handleNotFound(res, `Unknown control endpoint: ${pathname}`);
  return true;
}

/**
 * The client tore the connection down before its request body had fully
 * arrived. Node rejects the pending body read with `aborted` (ECONNRESET) and
 * destroys the response, so the rejection surfaces in the handler's read arm
 * looking like any other thrown error. It is caller behaviour, not a server
 * fault: no status can reach the client, so none must be journaled as
 * delivered. A body that blew its size cap also leaves the request destroyed
 * and incomplete, but that one is aimock's own decision, not a peer abort.
 */
function clientAbortedMidBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  err: unknown,
): boolean {
  if (err instanceof RequestBodyTooLargeError) return false;
  return res.destroyed && !req.complete;
}

async function handleCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  getRequestEntry: () => JournalEntry | null,
  modelFallback?: string,
  providerKey?: RecordProviderKey,
  openRouter = false,
  beforeFixtureSelection?: () => void,
  bytePlusPath = false,
): Promise<void> {
  setCorsHeaders(res);
  // Named in fixture tool-call rejections, so the message says which door the
  // request came through. The BytePlus door is the `/api/v3/` path itself
  // (`bytePlusPath`), not the record-gated `providerKey`, so a replay-only
  // request is named the same as a recording one.
  const wire =
    providerKey === "azure"
      ? "Azure OpenAI Chat Completions"
      : providerKey === "openrouter"
        ? "OpenRouter Chat Completions"
        : providerKey === "byteplus" || bytePlusPath
          ? "BytePlus ModelArk Chat Completions"
          : "OpenAI Chat Completions";

  // Read request body
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to read request body";
    // Same classification every `routeError` route applies to this failure: a
    // body that blew its size cap is the CALLER's fault, logged at warn.
    // If the reader destroyed the socket, no status was delivered.
    // This arm catches the read itself
    // rather than letting it reach `routeError`, so it has to say so on its
    // own — and it logs either way, because a read failure answered in
    // silence is a request that vanishes from the logs.
    const clientFault = err instanceof RequestBodyTooLargeError;
    const route = `${req.method ?? "POST"} ${req.url ?? COMPLETIONS_PATH}`;
    const clientAbort = clientAbortedMidBody(req, res, err);
    const bodyLimitDisconnect = clientFault && (req.destroyed || res.destroyed);
    if (clientAbort || bodyLimitDisconnect) {
      // The body reader or caller destroyed the socket: nothing can be
      // delivered and nothing crashed. Journal the torn socket the way the proxy arm
      // and chaos `disconnect` do, never a status the client did not get.
      const interruptReason = bodyLimitDisconnect
        ? "request body exceeded size limit"
        : "client aborted";
      defaults.logger.warn(
        bodyLimitDisconnect ? `${route}: ${msg}` : `${route}: client aborted mid-body (${msg})`,
      );
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? COMPLETIONS_PATH,
        headers: flattenHeaders(req.headers),
        body: null,
        response: {
          status: 0,
          fixture: null,
          interrupted: true,
          interruptReason,
        },
      });
      return;
    }
    const status = clientFault ? 400 : 500;
    if (clientFault) defaults.logger.warn(`${route}: ${msg}`);
    else defaults.logger.error(`${route}: ${msg}`);
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status, fixture: null },
    });
    writeErrorResponse(
      res,
      status,
      openRouter
        ? serializeOpenRouterError(status, `Request body read failed: ${msg}`)
        : JSON.stringify({
            error: {
              message: `Request body read failed: ${msg}`,
              type: clientFault ? "invalid_request_error" : "server_error",
            },
          }),
    );
    return;
  }

  // Parse JSON body
  let body: ChatCompletionRequest;
  try {
    body = JSON.parse(raw) as ChatCompletionRequest;
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

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `body.messages` throws a TypeError that
  // surfaces as a 500 instead of a 400.
  if (!isJsonObject(body)) {
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
        ? serializeOpenRouterError(400, "Request body must be a JSON object")
        : JSON.stringify({
            error: {
              message: "Request body must be a JSON object",
              type: "invalid_request_error",
            },
          }),
    );
    return;
  }

  // Azure deployments may omit model from body — use deployment ID as fallback
  if (modelFallback && !body.model) {
    body.model = modelFallback;
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

  const nullMessageIndex = body.messages.findIndex((message) => message === null);
  if (nullMessageIndex !== -1) {
    const message = `Invalid request: messages[${nullMessageIndex}] must be an object`;
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
        ? serializeOpenRouterError(400, message)
        : JSON.stringify({
            error: {
              message,
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          }),
    );
    return;
  }

  // Only native OpenAI ingress applies this shape rule; compatible routes
  // retain their own tool conventions. Missing-function shorthand stays valid.
  if (new URL(req.url ?? COMPLETIONS_PATH, "http://localhost").pathname === COMPLETIONS_PATH) {
    let toolsError = validateToolsField(body.tools);
    if (!toolsError && Array.isArray(body.tools)) {
      const nullFunctionIndex = body.tools.findIndex((tool) => tool?.function === null);
      if (nullFunctionIndex !== -1) {
        toolsError = `tools[${nullFunctionIndex}].function must not be null`;
      }
    }
    if (toolsError) {
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
        JSON.stringify({ error: { message: toolsError, type: "invalid_request_error" } }),
      );
      return;
    }
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
  // Select the fixture to serve for `probe`, CLAIMING a one-shot injected error
  // the instant it is selected — synchronously, before any chaos-latency await
  // and before its factory runs — so exactly one request consumes it. A
  // one-shot another in-flight request already claimed is no longer in
  // `fixtures`, so re-running the match falls through to the next candidate.
  const selectFixture = (
    probe: ChatCompletionRequest,
    counts: ReturnType<typeof journal.getFixtureMatchCountsForTest>,
  ): ReturnType<typeof matchFixtureDiagnostic> => {
    for (;;) {
      beforeFixtureSelection?.();
      const attempt = matchFixtureDiagnostic(
        fixtures,
        probe,
        counts,
        defaults.requestTransform,
        matchOptions,
      );
      if (
        attempt.fixture &&
        isOneShotError(attempt.fixture) &&
        !claimOneShotError(fixtures, attempt.fixture)
      ) {
        continue;
      }
      return attempt;
    }
  };

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
      const attempt = selectFixture(probe, matchCounts);
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
    const single = selectFixture(body, journal.getFixtureMatchCountsForTest(testId));
    fixture = single.fixture;
    skippedBySequenceOrTurn = single.skippedBySequenceOrTurn;
  }

  if (fixture) {
    // The fallback loop already advanced the served fixture's count; only the
    // single-match path still needs to increment here (never double-count).
    if (!fixtureCountIncremented) journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    // `JSON.stringify` drops functions/RegExps, so a predicate fixture logged
    // as `{}`; `describeMatch` names every present matcher by kind.
    defaults.logger.debug(
      `Fixture matched: ${describeMatch(fixture.match, fixtures.indexOf(fixture))}`,
    );
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
  // Deterministic latency is injected BEFORE the terminal actions are rolled,
  // so a configured delay applies to every outcome (served fixture, proxied
  // response, streamed response, and each chaos failure alike) — and, being
  // resolved from the same per-testId scope as the rates, never leaks into a
  // concurrently-running test that did not configure it.
  // Resolved ONCE and threaded into both the latency await and the action roll:
  // re-resolving would re-parse the chaos headers and emit every invalid/out-of-range
  // warning twice per request.
  const chaosConfig = resolveChaosConfig(
    fixture,
    defaults.chaos,
    req.headers,
    defaults.logger,
    req.url,
  );
  await awaitChaosLatency(
    fixture,
    defaults.chaos,
    req.headers,
    defaults.logger,
    req.url,
    res,
    chaosConfig,
  );
  // C13: the latency await resolves EARLY when the client hangs up mid-delay
  // (the timer is cancelled off `res`'s `close`). `applyChaosAsync` re-checks
  // writability at exactly this point; a SPLIT gate has to do it itself.
  // Without this the handler carries on and builds, "serves" and JOURNALS a
  // full response into a dead socket — a phantom entry for bytes no client
  // ever received.
  const goneAfterLatency = responseGoneReason(res);
  if (goneAfterLatency !== null) {
    // Claimed at selection, but no error body ever reached a client — re-arm
    // so the injection is not burned by a client that walked away.
    releaseOneShotError(fixtures, fixture);
    defaults.logger.debug(
      `[chaos] ${method} ${path}: ${describeUnwritableReason(goneAfterLatency)} after the ` +
        `latency delay — not served, not journalled`,
    );
    return;
  }
  const chaosAction = evaluateChaos(
    fixture,
    defaults.chaos,
    req.headers,
    defaults.logger,
    req.url,
    chaosConfig,
  );
  const chaosContext = { method, path, headers: flatHeaders, body };
  // With no fixture, the response is aimock's own unless this request was
  // going to be proxied — so the journal source is "internal", not "proxy",
  // on the non-proxied path. A miss is only proxied when record mode has an
  // upstream for THIS provider and strict is not refusing it first; the
  // shared rule lives in `wouldProxyMiss` (also used by elevenlabs-voice.ts).
  const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
  const missWouldProxy = wouldProxyMiss(effectiveStrict, defaults.record, providerKey);
  const noFixtureSource = missWouldProxy ? "proxy" : "internal";
  // Chaos writes its own entry. Resolve by request identity, including after
  // awaited proxy hooks, so concurrent requests cannot receive each other's marker.
  const recordBypass = (reason: "proxied" | "chaos-fired"): void => {
    const entry = getRequestEntry();
    if (!entry) return; // A skipped chaos action did not write a response.
    recordMisbehaviorOutcome({
      entry,
      summary: resolveMisbehaviorShortCircuit({
        wire: "openai-chat",
        fixture: fixture ?? undefined,
        defaults,
        rawHeaders: req.headers,
        url: req.url,
        reason,
      }),
      defaults,
      testId,
    });
  };

  if (chaosAction === "drop" || chaosAction === "disconnect" || chaosAction === "rateLimit") {
    applyChaosAction(
      chaosAction,
      res,
      fixture,
      journal,
      chaosContext,
      fixture ? "fixture" : noFixtureSource,
      defaults.registry,
      defaults.logger,
    );
    recordBypass("chaos-fired");
    // The chaos action, not the fixture, answered this request — a claimed
    // one-shot's error body was never written, so put it back in the queue.
    releaseOneShotError(fixtures, fixture);
    return;
  }

  // `malformed` is applied here whenever there is no upstream response to
  // mutate: a matched fixture, or a miss that would not be proxied (the 404
  // and strict-503 paths). Only the proxied no-fixture case defers, to the
  // `beforeWriteResponse` hook below — the same `wouldProxyMiss` rule as the
  // source label above, so a strict-mode miss with an upstream configured is
  // answered here rather than skipped for a 503 that never rolled. Before
  // this, a rolled `malformed` on the no-fixture non-proxied path fell through
  // to a plain 404 — never applied, journalled or counted. With no fixture,
  // nothing here was ever proxied, so the source is aimock itself:
  // `"internal"`, never `"proxy"`.
  if (chaosAction === "malformed" && (fixture || !missWouldProxy)) {
    applyChaosAction(
      chaosAction,
      res,
      fixture,
      journal,
      chaosContext,
      fixture ? "fixture" : "internal",
      defaults.registry,
      defaults.logger,
    );
    recordBypass("chaos-fired");
    // Same as the terminal actions above: malformed replaces the body, so a
    // claimed one-shot's error was never served.
    releaseOneShotError(fixtures, fixture);
    return;
  }

  if (!fixture) {
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
                  defaults.logger,
                );
                recordBypass("chaos-fired");
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

      // WHO killed a mid-flight stream decides what the journal says, and
      // after the fact the two look identical: `req.aborted`, `req.destroyed`
      // and `res.destroyed` all read the same whether the peer hung up or the
      // recorder tore the response down. The one signal that separates them is
      // the peer's FIN/RST, which arrives on the request socket as `end` (or
      // `error`) and only ever when the CLIENT went away. Removed afterwards:
      // a keep-alive socket outlives this request.
      let clientHungUp = false;
      const noteClientHangUp = (): void => {
        if (!res.writableEnded) clientHungUp = true;
      };
      req.socket?.on("end", noteClientHangUp);
      req.socket?.on("error", noteClientHangUp);
      let outcome: Awaited<ReturnType<typeof proxyAndRecord>>;
      try {
        outcome = await proxyAndRecord(
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
      } finally {
        req.socket?.off("end", noteClientHangUp);
        req.socket?.off("error", noteClientHangUp);
      }
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        // A stream that died mid-flight still carries the 200 it opened with;
        // mark it interrupted so the journal shows what the client actually
        // got rather than a clean success, and name the side that killed it —
        // a client hang-up is normal caller behaviour, an upstream/recorder
        // tear-down is a fault worth chasing.
        const destroyedMidStream = res.destroyed && !res.writableEnded;
        journal.add({
          method: req.method ?? "POST",
          path: req.url ?? COMPLETIONS_PATH,
          headers: flattenHeaders(req.headers),
          body,
          response: {
            status: res.statusCode ?? 200,
            fixture: null,
            source: "proxy",
            ...(destroyedMidStream
              ? {
                  interrupted: true,
                  interruptReason: clientHungUp ? "client aborted" : "proxy stream destroyed",
                }
              : {}),
          },
        });
        recordBypass("proxied");
        return;
      }
      // outcome === "not_configured" — nothing was written; fall through to
      // 404, unless a rolled `malformed` is still owed to the client. Nothing
      // was proxied, so the source is `"internal"`.
      if (chaosAction === "malformed") {
        applyChaosAction(
          chaosAction,
          res,
          null,
          journal,
          chaosContext,
          "internal",
          defaults.registry,
          defaults.logger,
        );
        recordBypass("chaos-fired");
        return;
      }
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
  const resolvedResponse = preResolvedResponse ?? (await resolveResponse(fixture, body));
  const evaluation = planMisbehavior({
    wire: "openai-chat",
    fixture,
    response: resolvedResponse,
    request: body,
    stream: body.stream === true,
    defaults,
    rawHeaders: req.headers,
    url: req.url,
  });
  if (evaluation.kind === "error") {
    const entry = journal.add({
      method,
      path,
      headers: flatHeaders,
      body,
      response: { status: evaluation.status, fixture },
    });
    recordMisbehaviorOutcome({ entry, summary: evaluation.summary, defaults, testId });
    if (!evaluation.summary?.evaluations.some((row) => row.outcome === "error")) {
      defaults.logger.error(`${evaluation.code}: ${evaluation.message}`);
    }

    writeErrorResponse(
      res,
      evaluation.status,
      openRouter
        ? serializeOpenRouterError(evaluation.status, `${evaluation.code}: ${evaluation.message}`)
        : JSON.stringify({
            error: {
              message: evaluation.message,
              type: "invalid_request_error",
              param: null,
              code: evaluation.code,
            },
          }),
    );
    return;
  }
  const appliedPlan =
    evaluation.kind === "applied" ? prepareOpenAIChatMisbehavior(evaluation) : undefined;
  const response = appliedPlan?.response ?? resolvedResponse;
  const summary = appliedPlan?.summary ?? evaluation.summary;
  const recordOutcome = (entry: JournalEntry): void => {
    recordMisbehaviorOutcome({ entry, summary, defaults, testId });
  };
  // Resolve ordinary applied reasoning once, before usage and delivery, using
  // the same strict/model gate as the selected response builder.
  const appliedReasoning =
    appliedPlan &&
    appliedPlan.reasoning === undefined &&
    (isTextResponse(response) ||
      isToolCallResponse(response) ||
      isContentWithToolCallsResponse(response))
      ? resolveReasoningForModel(
          response.reasoning,
          responseModel,
          resolveStrictMode(defaults.strict, req.headers),
          defaults.logger,
        )
      : undefined;
  // Only the existing OpenRouter route exposes K9 reasoning. Use that same
  // decision for full-output estimation, before any transport interruption.
  const appliedUsage = appliedPlan
    ? resolveOpenAIChatMisbehaviorUsage(
        appliedPlan,
        body,
        appliedPlan.reasoning === undefined ? appliedReasoning !== undefined : openRouter,
      )
    : undefined;
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
    appliedUsage ?? resolveUsage(overrides, streamingPromptText, completionText);

  const resolveRecordedTimings = (chunks: SSEChunk[]) => {
    const timings = fixture.recordedTimings;
    if (!appliedPlan?.duplicateId || !timings) return timings;
    const gaps = timings.interChunkDelaysMs;
    return {
      ...timings,
      interChunkDelaysMs: Array.from(
        { length: Math.max(gaps.length, chunks.length - 1) },
        (_, index) => gaps[index] ?? gaps.at(-1) ?? 0,
      ),
    };
  };

  // OpenRouter response shaping (no-op for OpenAI callers). Applied as a
  // post-pass over the objects the shared OpenAI builders produce so the
  // OpenAI code path is untouched. All OpenRouter-specific field shapes live in
  // openrouter-chat.ts. The fixture's `id` override still wins verbatim (the
  // `gen-` prefix rewrite only applies to auto-generated ids).
  const shapeORCompletion = (
    completion: ChatCompletion,
    overrides: ResponseOverrides | undefined,
  ): ChatCompletion => {
    if (appliedUsage) completion.usage = appliedUsage;
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
    const entry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status, fixture },
    });
    recordOutcome(entry);
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
    const entry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 422, fixture },
    });
    recordOutcome(entry);
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

  // Fault-specific terminals have distinct native message/delta shapes. Keep
  // ordinary builders and their historical finishReason mapping unchanged.
  if (
    appliedPlan &&
    isTextResponse(response) &&
    (appliedPlan.stop === "refusal" ||
      appliedPlan.stop === "content_filter" ||
      appliedPlan.reasoning !== undefined)
  ) {
    const overrides = extractOverrides(response);
    const entry = journal.add({
      method,
      path,
      headers: flatHeaders,
      body,
      response: { status: 200, fixture },
    });
    recordOutcome(entry);
    if (body.stream !== true) {
      const completion =
        appliedPlan.stop === "refusal"
          ? buildOpenAIRefusalCompletion(
              appliedPlan.refusal ?? "",
              responseModel,
              overrides,
              body.messages,
            )
          : appliedPlan.stop === "content_filter"
            ? buildOpenAIContentFilterCompletion(responseModel, overrides, body.messages)
            : buildOpenAIReasoningCompletion(
                appliedPlan.reasoning ?? "",
                responseModel,
                openRouter,
                overrides,
                body.messages,
              );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(shapeORCompletion(completion, overrides)));
    } else {
      const chunks =
        appliedPlan.stop === "refusal"
          ? buildOpenAIRefusalChunks(appliedPlan.refusal ?? "", responseModel, chunkSize, overrides)
          : appliedPlan.stop === "content_filter"
            ? buildOpenAIContentFilterChunks(responseModel, overrides)
            : buildOpenAIReasoningChunks(
                appliedPlan.reasoning ?? "",
                responseModel,
                chunkSize,
                openRouter,
                overrides,
              );
      const usageChunk = emitStreamingUsage
        ? buildUsageChunk(
            chunks[0].id,
            overrides?.model ?? responseModel,
            chunks[0].created,
            resolveStreamingUsageTokens(overrides, ""),
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
        recordedTimings: resolveRecordedTimings(chunks),
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
        openRouterProcessing,
      });
      if (!completed) {
        if (!res.writableEnded) res.destroy();
        entry.response.interrupted = true;
        entry.response.interruptReason = interruption?.reason();
      }
      interruption?.cleanup();
    }
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
    const effReasoning = appliedPlan
      ? appliedReasoning
      : resolveReasoningForModel(
          response.reasoning,
          responseModel,
          effectiveStrict,
          defaults.logger,
        );
    // Validate authoritative blocks before recording success in either mode.
    // Reuse their normalized payload for nonstream responses and usage estimates.
    const streaming = body.stream === true;
    const blockOutcome =
      response.blocks && response.blocks.length > 0
        ? resolveFixtureBlockOutcome(response.blocks)
        : undefined;
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    recordOutcome(journalEntry);
    // A Responses-only custom tool call (customToolCalls / responsesBlocks) is
    // rejected before any byte is written. It runs after journaling so the 500
    // entry keeps the request body and the matched fixture (routeError amends
    // it).
    const toolCalls = requireEmittedFunctionToolCalls(response, wire);
    if (!streaming) {
      const completion = buildContentWithToolCallsCompletion(
        blockOutcome?.content ?? response.content ?? "",
        blockOutcome?.toolCalls ?? toolCalls,
        responseModel,
        effReasoning,
        blockOutcome
          ? {
              ...overrides,
              finishReason:
                overrides?.finishReason ?? (blockOutcome.hasToolCalls ? "tool_calls" : "stop"),
            }
          : overrides,
        body.messages,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(shapeORCompletion(completion, overrides)));
    } else {
      const chunks = buildContentWithToolCallsChunks(
        blockOutcome?.content ?? response.content ?? "",
        blockOutcome?.toolCalls ?? toolCalls,
        responseModel,
        chunkSize,
        effReasoning,
        overrides,
        blockOutcome?.ordered,
      );
      // Estimate usage from the same authoritative payload sent to the client.
      const completionText = blockOutcome
        ? blockOutcome.content + blockOutcome.toolCalls.map((tc) => tc.name + tc.arguments).join("")
        : (response.content ?? "") + toolCalls.map((tc) => tc.name + tc.arguments).join("");
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
        recordedTimings: resolveRecordedTimings(chunks),
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
    const effReasoning = appliedPlan
      ? appliedReasoning
      : resolveReasoningForModel(
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
    recordOutcome(journalEntry);
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
        recordedTimings: resolveRecordedTimings(chunks),
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
    const effReasoning = appliedPlan
      ? appliedReasoning
      : resolveReasoningForModel(
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
    recordOutcome(journalEntry);
    const toolCalls = requireServedFunctionToolCalls(response, wire);
    if (body.stream !== true) {
      const completion = buildToolCallCompletion(
        toolCalls,
        responseModel,
        effReasoning,
        overrides,
        body.messages,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(shapeORCompletion(completion, overrides)));
    } else {
      const chunks = buildToolCallChunks(
        toolCalls,
        responseModel,
        chunkSize,
        effReasoning,
        overrides,
      );
      const completionText = toolCalls.map((tc) => tc.name + tc.arguments).join("");
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
        recordedTimings: resolveRecordedTimings(chunks),
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
  const entry = journal.add({
    method: req.method ?? "POST",
    path: req.url ?? COMPLETIONS_PATH,
    headers: flattenHeaders(req.headers),
    body,
    response: { status: 500, fixture },
  });
  recordOutcome(entry);
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
  /** MCP fake blocks, handed off at start to the MCPMock serving each block's `mount` (F2). */
  mcpFakes?: McpFakeSource[];
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
  const logger = new Logger(options?.logLevel ?? "silent");
  // Mounts-array rule (spec 5.2): one server-owned array for every use below.
  // A caller's array is that array, so a later `LLMock.mount()` push is seen.
  const mountList = mounts ?? [];
  // F2: hand MCP fakes off before the mount loop; a bad input rejects start().
  // A start that fails later takes the hand-off back, so a retry loads each
  // block once.
  const handOff =
    serviceFixtures?.mcpFakes && serviceFixtures.mcpFakes.length > 0
      ? handOffMcpFakes(mountList, serviceFixtures.mcpFakes, logger)
      : null;
  try {
    return await startServer(
      fixtures,
      options,
      resolvedAuth,
      mountList,
      logger,
      serviceFixtures,
      () => handOff?.commit(),
    );
  } catch (err) {
    handOff?.undo();
    throw err;
  }
}

/**
 * The server of `createServerWithResolvedAuth`, after the MCP fakes hand-off.
 * `commitHandOff` runs once the server listens; if it throws, the server is
 * closed and start rejects.
 */
async function startServer(
  fixtures: Fixture[],
  options: MockServerOptions | undefined,
  resolvedAuth: ResolvedInboundAuth,
  mountList: MountList,
  logger: Logger,
  serviceFixtures: ServiceFixtures | undefined,
  commitHandOff: () => void,
): Promise<ServerInstance> {
  // Keep raw entries in the caller's live array, assigning only absent identities.
  let rawFixtureAddition = 0;
  function ensureRawFixturePositions(): void {
    const existingPositions = new Set(
      fixtures.map(getFixtureMisbehaviorPosition).filter((position) => position !== undefined),
    );
    for (const fixture of fixtures) {
      if (getFixtureMisbehaviorPosition(fixture) !== undefined) continue;
      let position: string;
      do {
        position = `createServer#${rawFixtureAddition++}`;
      } while (existingPositions.has(position));
      setFixtureMisbehaviorPosition(fixture, position);
      existingPositions.add(position);
    }
  }
  ensureRawFixturePositions();

  const host = options?.host ?? "127.0.0.1";
  const port = options?.port ?? 0;
  const registry = options?.metrics ? createMetricsRegistry() : undefined;
  const serverOptions = options ?? {};
  if (
    serverOptions.responsesTools !== undefined &&
    serverOptions.responsesTools !== "legacy" &&
    serverOptions.responsesTools !== "extended"
  ) {
    throw new TypeError(
      `responsesTools must be "legacy" or "extended", got ${JSON.stringify(serverOptions.responsesTools)}`,
    );
  }
  setFixtureListResponsesTools(fixtures, () => serverOptions.responsesTools);
  // Runtime-mutable server chaos config. Reads fall through to the construction
  // options until POST /__aimock/chaos installs an override, which is scoped to
  // the caller's testId. The untagged baseline lives in the SAME map under
  // DEFAULT_TEST_ID, so "drop the baseline" and "drop one test's override" are
  // one operation and neither can accidentally take the other's overrides with
  // it; only assigning `undefined` (a full reset) clears the map.
  const chaosByTestId = new Map<string, ChaosConfig>();
  let misbehaviorBaseline: MisbehaviorConfig | undefined;
  const misbehavior: MisbehaviorScope = {
    byTestId: new Map(),
    // The default-ID override is the runtime baseline for every unnamed scope.
    // Keep its construction/setter fallback separate so DELETE reveals it.
    get baseline() {
      return this.byTestId.get(DEFAULT_TEST_ID) ?? misbehaviorBaseline;
    },
    set baseline(config: MisbehaviorConfig | undefined) {
      misbehaviorBaseline = config;
      if (config === undefined) this.byTestId.delete(DEFAULT_TEST_ID);
      else if (this.byTestId.has(DEFAULT_TEST_ID)) this.byTestId.set(DEFAULT_TEST_ID, config);
    },
  };
  // Misbehavior is opt-in (enableMisbehavior). Without it there is no scope,
  // so no fault is planned, and the `misbehavior` option, fixture keys and the
  // X-AIMock-Misbehavior header are ignored, as in 1.44.0.
  const misbehaviorEnabled = serverOptions.enableMisbehavior === true;
  if (misbehaviorEnabled) fixtures.forEach(enableHeldFixtureMisbehavior);
  if (misbehaviorEnabled && serverOptions.misbehavior !== undefined) {
    const parsed = parseMisbehavior(serverOptions.misbehavior);
    if (!parsed.ok) throw new TypeError(`${parsed.issue.rule}: ${parsed.issue.message}`);
    misbehavior.baseline =
      parsed.config.seed === "random"
        ? { ...parsed.config, seed: resolveMisbehaviorSeed(parsed.config.seed, logger) }
        : parsed.config;
  }

  const defaults = {
    latency: serverOptions.latency ?? 0,
    chunkSize: Math.max(1, serverOptions.chunkSize ?? DEFAULT_CHUNK_SIZE),
    replaySpeed: serverOptions.replaySpeed ?? 1.0,
    logger,
    chaosByTestId,
    misbehavior: misbehaviorEnabled ? misbehavior : undefined,
    get misbehaviorCounters(): Journal {
      return journal;
    },
    // Handlers get a SCOPE, not a flat config: chaos.ts picks the override for
    // the request's X-Test-Id and falls back to the baseline.
    get chaos(): ChaosDefaults {
      return {
        base: chaosByTestId.get(DEFAULT_TEST_ID) ?? serverOptions.chaos,
        byTestId: chaosByTestId,
      };
    },
    // Assigning `undefined` drops EVERY runtime override instead of latching an
    // empty one, so the construction-time chaos config is always recoverable
    // (that is what `POST /__aimock/reset` does). `POST {}` still installs a
    // real, empty override: "explicitly no chaos".
    set chaos(value: ChaosDefaults | undefined) {
      if (value === undefined) {
        chaosByTestId.clear();
        return;
      }
      const base = isChaosScope(value) ? value.base : value;
      if (base === undefined) chaosByTestId.delete(DEFAULT_TEST_ID);
      else chaosByTestId.set(DEFAULT_TEST_ID, base);
    },
    registry,
    get record() {
      return serverOptions.record;
    },
    get strict() {
      return serverOptions.strict;
    },
    get strictToolArguments() {
      return serverOptions.strictToolArguments;
    },
    get responsesTools() {
      return serverOptions.responsesTools;
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
    get bytePlusVideo() {
      return serverOptions.bytePlusVideo;
    },
  };

  // Validate chaos defaults through the ONE chaos table, so what startup warns
  // about is exactly what the runtime rejects (same fields, same bounds, same
  // words). The hand-rolled range check this replaces said nothing for
  // `latencyMs: 250.5`, which the runtime then rejected on every request.
  if (options?.chaos) {
    const chaosDefaults = options.chaos as Record<string, unknown>;
    for (const field of CHAOS_FIELD_NAMES) {
      const value = chaosDefaults[field];
      if (value === undefined) continue;
      // Typed config, like the control API's JSON body: a numeric string is a
      // type error, not a wire spelling to be parsed.
      if (typeof value === "number" && parseChaosField(field, value) !== undefined) continue;
      const shape = CHAOS_FIELDS[field].integer ? "a whole number of ms" : "a number";
      logger.warn(
        `Chaos default ${field} value ${JSON.stringify(value)} — must be ${shape} in [0,${CHAOS_FIELDS[field].max}]; rejected at runtime, never clamped: this default is ignored`,
      );
    }
  }

  // Validate poll-progression thresholds (resolveProgression treats
  // non-finite values as unset and floors/clamps the rest to >= 0 integers)
  for (const { name, config } of [
    { name: "falQueue", config: options?.falQueue },
    { name: "openRouterVideo", config: options?.openRouterVideo },
    { name: "veoVideo", config: options?.veoVideo },
    { name: "grokVideo", config: options?.grokVideo },
    { name: "bytePlusVideo", config: options?.bytePlusVideo },
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

  // Reject a BytePlus upstream base that already carries Ark's `/api/v3`
  // prefix. `record.providers.byteplus` is an ORIGIN: the video handlers pass
  // the full `/api/v3/contents/generations/tasks[...]` constant to
  // resolveUpstreamUrl, and the chat/images proxies relay the client's raw
  // `req.url` (which is itself `/api/v3/...`). `@tanstack/ai-byteplus@0.3.4`
  // ships `https://ark.ap-southeast.bytepluses.com/api/v3` as its default Ark
  // `base_url` (`BYTEPLUS_ARK_BASE_URL`, which its own author labels
  // "Docs-derived" — this repo has not read BytePlus's docs), so pasting that
  // into --provider-byteplus is the expected mistake, and it composes
  // `/api/v3/api/v3/...` on every BytePlus path. The origin+prefix itself IS
  // observed to serve: a keyless GET under it answers 401, not 404.
  //
  // This THROWS rather than silently stripping the suffix, for two reasons.
  // (1) Nothing is being taken away: the doubled form cannot serve any
  // BytePlus request, so there is no working configuration to preserve —
  // whereas a silent strip would make aimock rewrite an operator-supplied URL
  // and would be flatly wrong for the one case where a path-suffixed base is
  // deliberate (a reverse proxy mounted under a path: stripping sends the
  // request to the origin, bypassing the mount). (2) A warn is easy to miss in
  // a mock server's log stream, and the symptom it leaves behind — a relayed
  // upstream 404 — does not name its cause. Fail at startup, where the message
  // can.
  {
    const bytePlusBase = options?.record?.providers?.byteplus;
    if (bytePlusBase !== undefined) {
      let basePath: string | undefined;
      try {
        basePath = new URL(bytePlusBase).pathname;
      } catch {
        // Not parseable as an absolute URL — leave it to the request path to
        // report; this guard only speaks to the prefix-doubling mistake.
      }
      if (basePath !== undefined && /(^|\/)api\/v3\/?$/.test(basePath)) {
        throw new Error(
          `record.providers.byteplus (${bytePlusBase}) ends in /api/v3, but aimock ` +
            `appends the /api/v3 prefix itself — every BytePlus request would go to ` +
            `/api/v3/api/v3/... and fail upstream. Configure the ORIGIN only ` +
            `(e.g. https://ark.ap-southeast.bytepluses.com).`,
        );
      }
    }
  }

  /**
   * The in-flight request, scoped to the async execution that serves it.
   * Entered once in the `http.createServer` callback, so every handler —
   * including the ones in other modules that only ever see the shared
   * `journal` — runs inside it.
   */
  const requestScope = new AsyncLocalStorage<http.IncomingMessage>();
  /** The journal entry each request produced, keyed by the request object. */
  const ownJournalEntry = new WeakMap<http.IncomingMessage, JournalEntry>();

  // Programmatic default: finite caps so long-running embedders don't inherit
  // an unbounded journal / fixture-count map. Callers that need unbounded
  // retention (e.g. short-lived test harnesses) can opt in by passing 0.
  const journal = new Journal({
    maxEntries: options?.journalMaxEntries ?? 1000,
    fixtureCountsMaxTestIds: options?.fixtureCountsMaxTestIds ?? 500,
    onAdd: (entry) => {
      const req = requestScope.getStore();
      if (req) ownJournalEntry.set(req, entry);
    },
  });
  const videoStates = new VideoStateMap();
  const openRouterVideoJobs = new OpenRouterVideoJobMap();
  const veoVideoJobs = new VeoVideoJobMap();
  const grokVideoJobs = new GrokVideoJobMap();
  const bytePlusVideoJobs = new BytePlusVideoJobMap();

  /**
   * The OpenAI error `type` that goes with a status: 4xx is the caller's
   * fault, everything else is ours. Shared by `routeError` and the envelopes
   * it calls so the body can never disagree with the status line.
   */
  function errorTypeForStatus(status: number): string {
    return status >= 400 && status < 500 ? "invalid_request_error" : "server_error";
  }

  /**
   * Envelope for a fixture tool-call error (see isFixtureToolCallError: invalid
   * JSON arguments on an object wire, a custom tool call on a non-Responses
   * wire, or a malformed fixture tool call). It is the provider envelope aimock
   * emits for that route, with the aimock `code` in it: Google's
   * `google.rpc.ErrorInfo` detail on Gemini and Vertex AI, a string
   * `error.code` on Gemini Interactions and Anthropic Messages, a `reason`
   * member on Bedrock (a `code` member would replace `__type` as the AWS SDK's
   * error name), and a sibling `code` on Ollama's bare string error. Every
   * other route, Cohere included, gets the OpenAI-style
   * `{error: {message, type, code}}`. OpenRouter routes pass their own
   * `toolCallEnvelope` instead of using this one.
   */
  function invalidToolArgumentsEnvelope(pathname: string, message: string, code: string): string {
    if (pathname === OLLAMA_CHAT_PATH) return JSON.stringify({ error: message, code });
    if (pathname === GEMINI_INTERACTIONS_PATH) {
      return JSON.stringify({ error: { code, message } });
    }
    if (GEMINI_PATH_RE.test(pathname) || VERTEX_AI_RE.test(pathname)) {
      return JSON.stringify({
        error: {
          code: 500,
          message,
          status: "INTERNAL",
          details: googleFixtureToolCallErrorDetails(code),
        },
      });
    }
    if (pathname === MESSAGES_PATH) {
      return JSON.stringify({ type: "error", error: { type: "api_error", code, message } });
    }
    if (
      BEDROCK_INVOKE_RE.test(pathname) ||
      BEDROCK_STREAM_RE.test(pathname) ||
      BEDROCK_CONVERSE_RE.test(pathname) ||
      BEDROCK_CONVERSE_STREAM_RE.test(pathname)
    ) {
      return JSON.stringify({ __type: "InternalServerException", message, reason: code });
    }
    return JSON.stringify({ error: { message, type: "server_error", code } });
  }

  function invalidMisbehaviorHeaderEnvelope(pathname: string, detail: string): string {
    const code = "aimock_misbehavior_invalid";
    const message = `${code}: ${detail}`;
    if (pathname === OLLAMA_CHAT_PATH || pathname === OLLAMA_GENERATE_PATH) {
      return JSON.stringify({ error: message });
    }
    if (pathname === COHERE_CHAT_PATH) return JSON.stringify({ message });
    if (pathname === GEMINI_INTERACTIONS_PATH) {
      return JSON.stringify({ error: { code, message } });
    }
    if (GEMINI_PATH_RE.test(pathname) || VERTEX_AI_RE.test(pathname)) {
      return JSON.stringify({ error: { code: 400, message, status: "INVALID_ARGUMENT" } });
    }
    if (pathname === MESSAGES_PATH) {
      return JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", code, message },
      });
    }
    if (
      BEDROCK_INVOKE_RE.test(pathname) ||
      BEDROCK_STREAM_RE.test(pathname) ||
      BEDROCK_CONVERSE_RE.test(pathname) ||
      BEDROCK_CONVERSE_STREAM_RE.test(pathname)
    ) {
      return JSON.stringify({ __type: "ValidationException", message });
    }
    return JSON.stringify({ error: { message, type: "invalid_request_error", code } });
  }

  /**
   * The newest journal entry this request already produced, or null.
   *
   * Attribution is by the identity of the `IncomingMessage` the entry was
   * written under — never by `x-request-id`. That header is CALLER-supplied
   * (`resolveRequestId` echoes a well-formed one) and nothing makes it
   * unique: a retry, a harness that pins one id, or a load generator sends
   * the same id on many requests, and keying off it made a crash rewrite an
   * EARLIER request's entry while leaving the crashing request untraced. The
   * request object cannot be collided by a caller, so one entry belongs to
   * exactly one request. A handler writes at most one entry; if it writes
   * more, the newest wins, which is the entry the old scan would have found.
   */
  function lastJournalEntryFor(req: http.IncomingMessage): JournalEntry | null {
    return ownJournalEntry.get(req) ?? null;
  }

  /**
   * Uniform terminal arm for a route handler that threw. Every route error
   * path logs the route, journals the failure, sets CORS and answers the error
   * envelope — so a handler crash is never invisible in the logs or in
   * `/__aimock/journal`.
   *
   * ONE request produces ONE entry. `res.headersSent` is not the test for that:
   * a handler that journaled its 200 and then threw before `writeHead` has
   * sent no headers, and journaling again would leave two contradicting
   * entries for one request. So the existing entry is looked up by request
   * identity ({@link lastJournalEntryFor}) and AMENDED — status to what the
   * client actually got when the response is still changeable, or interrupted
   * when it isn't — and a fresh entry is
   * added only when the handler journaled nothing. That holds after the
   * response too: a handler that answered and then crashed before its own
   * journal write gets an entry carrying the status already sent, so a
   * post-response crash is never invisible.
   *
   * Once headers are on the wire the status can't change, so the socket is
   * destroyed: a clean `end()` reads as EOF and the client treats a truncated
   * stream as a complete response. The chat-style SSE routes whose clients
   * surface an error frame pass `streamEvent`; that frame is written first,
   * but the tear-down still follows it.
   *
   * A body that blew its size cap is the CALLER's fault, not a server fault:
   * it logs at warn, but if the reader destroyed the socket it journals an
   * interruption with status 0 because no 4xx reached the client. A client
   * that hung up before its body arrived
   * ({@link clientAbortedMidBody}) is not a fault at all: it logs at warn and
   * journals a torn socket (`interrupted`, status 0), never a 500 the client
   * could not have received.
   */
  function routeError(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    err: unknown,
    pathname: string,
    opts?: {
      service?: string;
      /**
       * Provider-shaped error body. Takes the STATUS routeError settled on —
       * a client-fault body cap answers 400, and an envelope that hardcoded
       * 500 would contradict the status line it is sent with.
       */
      envelope?: (msg: string, status: number) => string;
      /**
       * Provider-shaped body for a fixture tool-call error (always a 500),
       * carrying the aimock `code`. Defaults to the envelope the pathname
       * implies ({@link invalidToolArgumentsEnvelope}).
       */
      toolCallEnvelope?: (msg: string, code: string) => string;
      streamEvent?: (msg: string, status: number) => string;
    },
  ): void {
    const route = `${req.method ?? "?"} ${pathname}`;
    const msg = err instanceof Error ? err.message : "Internal error";
    const invalidToolArguments = isFixtureToolCallError(err);
    const clientFault = err instanceof RequestBodyTooLargeError;
    const clientAbort = clientAbortedMidBody(req, res, err);
    const status = clientFault ? 400 : 500;
    if (clientAbort) logger.warn(`${route}: client aborted mid-body (${msg})`);
    else if (clientFault) logger.warn(`${route}: ${msg}`);
    else logger.error(`${route}: ${msg}`);
    if (err instanceof Error && err.stack) logger.debug(err.stack);
    const existing = lastJournalEntryFor(req);
    const bodyLimitDisconnect = clientFault && (req.destroyed || res.destroyed);
    if ((clientAbort || bodyLimitDisconnect) && !res.headersSent) {
      const interruptReason = bodyLimitDisconnect
        ? "request body exceeded size limit"
        : "client aborted";
      // Nothing reached the client and nothing crashed: the entry records a
      // torn socket (status 0, same as chaos `disconnect` before headers), and
      // there is no socket left to answer on.
      if (existing) {
        if (!existing.response.interrupted) {
          existing.response.status = 0;
          existing.response.interrupted = true;
          existing.response.interruptReason = interruptReason;
        }
        return;
      }
      try {
        journal.add({
          method: req.method ?? "?",
          path: req.url ?? "?",
          headers: flattenHeaders(req.headers),
          body: null,
          ...(opts?.service ? { service: opts.service } : {}),
          response: {
            status: 0,
            fixture: null,
            source: "internal",
            interrupted: true,
            interruptReason,
          },
        });
      } catch (jErr) {
        logger.warn(
          `${route}: journal write failed after body-read interruption: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
        );
      }
      return;
    }
    if (!res.headersSent) {
      if (existing) {
        // The handler's own entry, corrected to the status the client gets.
        // `source`/`fixture` are left alone: they record what was going to
        // serve this request, which the crash didn't change.
        existing.response.status = status;
        if (invalidToolArguments) existing.response.error = msg;
      } else {
        // Wrapped so journaling can never mask the error write below.
        try {
          journal.add({
            method: req.method ?? "?",
            path: req.url ?? "?",
            headers: flattenHeaders(req.headers),
            body: null,
            ...(opts?.service ? { service: opts.service } : {}),
            response: {
              status,
              fixture: null,
              source: "internal",
              ...(invalidToolArguments ? { error: msg } : {}),
            },
          });
        } catch (jErr) {
          logger.warn(
            `${route}: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
          );
        }
      }
      setCorsHeaders(res);
      writeErrorResponse(
        res,
        status,
        invalidToolArguments
          ? (opts?.toolCallEnvelope ?? ((m, c) => invalidToolArgumentsEnvelope(pathname, m, c)))(
              msg,
              fixtureToolCallErrorCode(err),
            )
          : opts?.envelope
            ? opts.envelope(msg, status)
            : JSON.stringify({
                error: {
                  message: msg,
                  type: errorTypeForStatus(status),
                },
              }),
      );
    } else {
      // Headers are on the wire, so the status the client got is fixed. If the
      // handler already journaled, mark its entry so the journal and the
      // metrics finish hook agree with the torn socket instead of reporting a
      // clean success. If it journaled nothing (it crashed on the way to
      // journaling, after the response went out), ADD the entry now — a
      // post-response crash must never leave a request without a trace.
      //
      // `interrupted` means the client did not get a complete body. Once
      // `end()` has run it did, so a crash after that point is recorded in
      // `error` with the status that was delivered, never as an interruption.
      const midStreamReason = clientAbort ? "client aborted" : "handler crashed mid-stream";
      if (existing) {
        if (res.writableEnded) {
          if (existing.response.error === undefined) existing.response.error = msg;
        } else if (!existing.response.interrupted) {
          existing.response.interrupted = true;
          existing.response.interruptReason = midStreamReason;
        }
      } else {
        try {
          journal.add({
            method: req.method ?? "?",
            path: req.url ?? "?",
            headers: flattenHeaders(req.headers),
            body: null,
            ...(opts?.service ? { service: opts.service } : {}),
            response: {
              status: res.statusCode,
              fixture: null,
              source: "internal",
              ...(res.writableEnded
                ? { error: msg }
                : { interrupted: true, interruptReason: midStreamReason }),
            },
          });
        } catch (jErr) {
          logger.warn(
            `${route}: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
          );
        }
      }
      // A response that already completed has nothing left to tear down.
      if (res.writableEnded) return;
      if (opts?.streamEvent) {
        try {
          // Destroy once the frame is flushed — written, then torn down, never
          // ended cleanly.
          res.write(opts.streamEvent(msg, status), () => {
            if (!res.destroyed) res.destroy();
          });
        } catch (writeErr) {
          logger.debug("Failed to write error recovery response:", writeErr);
          res.destroy();
        }
      } else {
        res.destroy();
      }
    }
  }

  // Share journal and metrics registry with mounted services
  for (const { handler } of mountList) {
    if (handler.setJournal) handler.setJournal(journal);
    if (registry && handler.setRegistry) handler.setRegistry(registry);
    if (handler.setLogger) handler.setLogger(logger);
    // B11/R12: only aimock's own MCPMock takes the replay speed; a custom
    // Mountable is never called (1.44.0 had no such hook).
    if (handler instanceof MCPMock) handler.setReplaySpeed(defaults.replaySpeed);
  }

  // Set initial fixtures-loaded gauge
  if (registry) {
    registry.setGauge("aimock_fixtures_loaded", {}, fixtures.length);
  }
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    // Delegate to async handler — catch unhandled rejections to prevent Node.js crashes.
    // Run inside the request scope so every journal write made while serving
    // this request (in any handler module) is attributed back to it.
    requestScope.run(req, () => {
      runWithToolArgumentsScope({ strict: defaults.strictToolArguments === true, logger }, () =>
        handleHttpRequest(req, res).catch((err: unknown) => {
          routeError(req, res, err, req.url ?? "?");
        }),
      );
    });
  });

  async function handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Record start time for metrics
    const startTime = registry ? process.hrtime.bigint() : 0n;

    // Request-id propagation: echo a well-formed caller id, else mint one.
    // Normalized back onto `req.headers` so every downstream
    // `flattenHeaders` journal snapshot carries it with zero per-handler
    // edits, and echoed on the response for trace correlation. A MINTED id is
    // aimock's own invention and must never reach a real provider, so the
    // provenance is marked for `buildForwardHeaders` to strip on egress; a
    // caller-supplied id is the caller's header and forwards untouched.
    const { id: requestId, generated: requestIdMinted } = resolveRequestId(req.headers);
    req.headers["x-request-id"] = requestId;
    markMintedRequestId(req, requestIdMinted);
    res.setHeader("X-Request-Id", requestId);

    let pathname = "";

    // Instrument response completion for metrics. The callbacks read pathname
    // via closure after normalizeCompatPath has rewritten it, so metrics
    // record the canonical /v1/... path. Registered BEFORE the URL is parsed:
    // a request whose target or `Host` header will not parse is answered 400,
    // and hooking after the parse would leave that response
    // uncounted. It reaches `normalizePathLabel` with the empty pre-parse
    // pathname and lands in `{unknown}`, like every other pre-routing reject.
    //
    // Two terminal events, one count. `finish` fires only when the body was
    // ended; a response torn down by `res.destroy()` — the `disconnect` chaos
    // action, a body-cap reset, a catch-arm teardown — never finishes and only
    // ever emits `close`. Those were invisible to `/metrics`, so the request
    // total under-counted by exactly the failures worth watching. `close`
    // also follows every `finish`, hence the guard: a normal response counts
    // once, under its status; a destroyed one counts once, as `destroyed`.
    if (registry) {
      let recorded = false;
      const recordOutcome = (status: string): void => {
        if (recorded) return;
        recorded = true;
        try {
          // Read the mount table at record time, not at start: `LLMock.mount()`
          // after `start()` pushes onto this same array, and a snapshot taken
          // here at startup labelled that (correctly routed) traffic `{unknown}`.
          const normalizedPath = normalizePathLabel(
            pathname,
            mountList.map((m) => m.path),
          );
          const method = req.method ?? "UNKNOWN";
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
      };
      res.on("finish", () => recordOutcome(String(res.statusCode)));
      res.on("close", () => {
        if (!res.writableFinished) recordOutcome(DESTROYED_STATUS_LABEL);
      });
    }

    // Parse the URL pathname (strip query string)
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch (err: unknown) {
      const route = `${req.method ?? "?"} ${req.url ?? "?"}`;
      const msg = err instanceof Error ? err.message : "Internal error";
      logger.error(`${route}: ${msg}`);
      if (err instanceof Error && err.stack) logger.debug(err.stack);
      try {
        journal.add({
          method: req.method ?? "?",
          path: req.url ?? "?",
          headers: flattenHeaders(req.headers),
          body: null,
          response: { status: 400, fixture: null, source: "internal" },
        });
      } catch (jErr) {
        logger.warn(
          `${route}: journal write failed after handler error: ${jErr instanceof Error ? jErr.message : String(jErr)}`,
        );
      }
      setCorsHeaders(res);
      writeErrorResponse(
        res,
        400,
        JSON.stringify({
          error: { message: "Invalid request target", type: "invalid_request_error" },
        }),
      );
      return;
    }
    pathname = parsedUrl.pathname;
    // Capture the ORIGINAL path before normalizeCompatPath rewrites it — the
    // OpenRouter `/api/v1/` base is the detection signal and would otherwise be
    // erased (`/api/v1/chat/completions` → `/v1/chat/completions`).
    const originalPathname = pathname;
    const isOpenRouter = isOpenRouterPath(originalPathname);
    // BytePlus Ark attribution, GATED ON CONFIGURATION. A path prefix is not
    // evidence of a vendor — the COMPAT_SUFFIXES comment above exists precisely
    // because arbitrary vendors ride arbitrary prefixes (BigModel uses /v4/).
    // Ungated, anyone serving an OpenAI-compatible vendor under /api/v3 with
    // `record.providers.openai` configured would suddenly look up a byteplus
    // upstream, find none, and lose record mode entirely. Requiring a
    // configured byteplus upstream makes the new behavior reachable only for
    // the user who asked for it.
    const isBytePlusArk =
      defaults.record?.providers.byteplus !== undefined && originalPathname.startsWith("/api/v3/");

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
      (pathname === HEALTH_PATH || pathname === READY_PATH || pathname === METRICS_PATH);
    if (!isPublicProbe) {
      if (!validateRequestApiKey(req, resolvedAuth.policy).ok) {
        writeApiKeyHttpRejection(res, setCorsHeaders);
        return;
      }
      markAuthenticatedRequest(req, resolvedAuth.policy);
    }

    // Control API — must be checked before mounts and path rewrites
    if (pathname.startsWith(CONTROL_PREFIX)) {
      ensureRawFixturePositions();
      await handleControlAPI(
        req,
        res,
        pathname,
        parsedUrl.searchParams,
        fixtures,
        journal,
        videoStates,
        openRouterVideoJobs,
        veoVideoJobs,
        grokVideoJobs,
        bytePlusVideoJobs,
        defaults,
        mountList,
      );
      return;
    }

    // Validate the entire Node-normalized value before any provider can serve
    // or skip unsupported faults. Repeated fields must parse as one grammar;
    // never select only the first value. Keep valid headers intact for planning.
    const misbehaviorHeader = defaults.misbehavior
      ? parseMisbehaviorHeader(req.headers["x-aimock-misbehavior"])
      : undefined;
    if (misbehaviorHeader && !misbehaviorHeader.ok) {
      const detail = misbehaviorHeader.issue.message;
      const message = `aimock_misbehavior_invalid: ${detail}`;
      logger.error(`${req.method ?? "?"} ${pathname}: ${message}`);
      journal.add({
        method: req.method ?? "?",
        path: req.url ?? pathname,
        headers: flattenHeaders(req.headers),
        body: null,
        response: { status: 400, fixture: null, source: "internal", error: message },
      });
      setCorsHeaders(res);
      writeErrorResponse(
        res,
        400,
        invalidMisbehaviorHeaderEnvelope(normalizeCompatPath(pathname), detail),
      );
      return;
    }

    // Dispatch to mounted services before any path rewrites
    for (const { path: mountPath, handler } of mountList) {
      if (pathname === mountPath || pathname.startsWith(mountPath + "/")) {
        const subPath = pathname.slice(mountPath.length) || "/";
        const handled = await handler.handleRequest(req, res, subPath);
        if (handled) return;
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
        ensureRawFixturePositions();
        await handleOllama(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    if (pathname === OLLAMA_GENERATE_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleOllamaGenerate(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    if (
      (pathname === OLLAMA_EMBEDDINGS_PATH || pathname === OLLAMA_EMBED_PATH) &&
      req.method === "POST"
    ) {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleOllamaEmbeddings(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // GET /api/v1/videos/models — video model listing (must precede the
    // status RE, whose [^/]+ segment would otherwise capture "models")
    if (pathname === OPENROUTER_VIDEO_MODELS_PATH && req.method === "GET") {
      try {
        ensureRawFixturePositions();
        await handleOpenRouterVideoModels(req, res, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // GET /api/v1/videos/{jobId} — poll job status
    const openRouterVideoStatusMatch = pathname.match(OPENROUTER_VIDEO_STATUS_RE);
    if (openRouterVideoStatusMatch && req.method === "GET") {
      try {
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /api/v1/videos — submit a video generation job (202 Accepted)
    if (pathname === OPENROUTER_VIDEOS_PATH && req.method === "POST") {
      // CORS headers before the body is read: a readBody throw (e.g. the
      // body-size cap) lands in the catch below, which must not write a 500
      // that is opaque to browser clients. The handler re-applies the same
      // headers (setHeader is idempotent).
      setCorsHeaders(res);
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // ── BytePlus Ark (Seedance) async video task lifecycle ──────────────────
    // Registered in the PRE-REWRITE band, alongside the OpenRouter video routes
    // above: normalizeCompatPath does not currently claim these paths, but the
    // Ollama block documents that hazard and the mount dispatch also runs
    // pre-rewrite, so keeping every raw-path route in one band keeps one rule.
    //
    // The REs anchor an ENUMERATED optional `/api/v3` prefix (see metrics.ts).
    // That matters here specifically because this band runs ~1,100 lines ahead
    // of every fal branch, so a wildcard prefix would take
    // `/fal/contents/generations/tasks` away from the fal proxy.
    //
    // Status is tested BEFORE submit and each is method-guarded, so a future
    // DELETE .../tasks/{id} falls through to 404 rather than being mis-served.
    const bytePlusVideoStatusMatch = pathname.match(BYTEPLUS_VIDEO_STATUS_RE);
    if (bytePlusVideoStatusMatch && req.method === "GET") {
      try {
        ensureRawFixturePositions();
        await handleBytePlusVideoStatus(
          req,
          res,
          bytePlusVideoStatusMatch[1],
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          bytePlusVideoJobs,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    if (BYTEPLUS_VIDEO_SUBMIT_RE.test(pathname) && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleBytePlusVideoCreate(
          req,
          res,
          raw,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          bytePlusVideoJobs,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // OpenRouter discovery endpoints. Dispatched BEFORE normalizeCompatPath
    // (which does not rewrite these — /models etc. are excluded from
    // COMPAT_SUFFIXES — so they would otherwise 404), mirroring the
    // /api/v1/videos ordering above. Read-only metadata; no body.
    if (pathname === OPENROUTER_MODELS_PATH && req.method === "GET") {
      ensureRawFixturePositions();
      handleOpenRouterModels(req, res, fixtures, journal, defaults, setCorsHeaders);
      return;
    }
    if (pathname === OPENROUTER_KEY_PATH && req.method === "GET") {
      handleOpenRouterKey(req, res, journal, setCorsHeaders);
      return;
    }
    if (pathname === OPENROUTER_CREDITS_PATH && req.method === "GET") {
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
      if (mountList.length > 0) {
        const services: Record<string, unknown> = {
          llm: { status: "ok", fixtures: fixtures.length },
        };
        for (const { path: mountPath, handler } of mountList) {
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
    if (pathname === METRICS_PATH && req.method === "GET") {
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

    // Batches API — cancel RE before id RE (the id RE would swallow /cancel).
    // Cancel takes no payload — the `openai` SDK posts an empty body — but the
    // body is still read, and discarded, before the handler runs. Reading it is
    // what applies `readBody`'s 10 MB ceiling: a POST route that never touches
    // the stream lets node quietly dump whatever the client sends, so this one
    // route would accept an unbounded upload while the create route beside it
    // (the sibling pattern followed here, down to the error arm) rejects the
    // same bytes.
    const batchesCancelMatch = pathname.match(BATCHES_CANCEL_RE);
    if (batchesCancelMatch && req.method === "POST") {
      try {
        await readBody(req);
        await handleBatchesCancel(
          req,
          res,
          batchesCancelMatch[1],
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "batches" });
      }
      return;
    }
    const batchesIdMatch = pathname.match(BATCHES_ID_RE);
    if (batchesIdMatch && req.method === "GET") {
      try {
        await handleBatchesRetrieve(req, res, batchesIdMatch[1], journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "batches" });
      }
      return;
    }
    if (pathname === BATCHES_PATH && req.method === "GET") {
      try {
        await handleBatchesList(req, res, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "batches" });
      }
      return;
    }
    if (pathname === BATCHES_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleBatchesCreate(req, res, raw, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, {
          service: "batches",
        });
      }
      return;
    }

    // Files API mock — dispatch order matters: content RE → id RE → collection.
    // The id RE's `[^/]+` would otherwise swallow `/content`, and the
    // collection exact match must not claim an id path.
    //
    // Every branch is method-guarded, so an unhandled method on a files path
    // (`PATCH /v1/files/{id}`, and also `HEAD`, which nothing here implements)
    // falls through to the shared 404. That is this server's convention, not a
    // files-specific gap: there is no `405` anywhere in this file, the BytePlus
    // block above documents the same fallthrough by name, and measured against
    // a live server `HEAD /health` and `PATCH /v1/models` answer 404 exactly
    // like their files equivalents. Answering 405 + `Allow` here — or serving
    // HEAD — would make files the only surface in the mock that behaves that
    // way, which is a bigger inconsistency than the one it fixes. Changing it
    // is a server-wide change and belongs in its own pass.
    const filesContentMatch = pathname.match(FILES_CONTENT_RE);
    if (filesContentMatch && req.method === "GET") {
      try {
        await handleFilesContent(req, res, filesContentMatch[1], journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "files" });
      }
      return;
    }
    const filesIdMatch = pathname.match(FILES_ID_RE);
    if (filesIdMatch && req.method === "GET") {
      try {
        await handleFilesRetrieve(req, res, filesIdMatch[1], journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "files" });
      }
      return;
    }
    if (filesIdMatch && req.method === "DELETE") {
      try {
        await handleFilesDelete(req, res, filesIdMatch[1], journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "files" });
      }
      return;
    }
    if (pathname === FILES_PATH && req.method === "GET") {
      // `purpose` is NOT read here. It used to be, with `searchParams.get`,
      // which silently first-wins a repeat and hands `""` through for
      // `?purpose=`; the files module reads all four list parameters itself so
      // one rule covers them all.
      try {
        await handleFilesList(req, res, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "files" });
      }
      return;
    }
    if (pathname === FILES_PATH && req.method === "POST") {
      try {
        // A Buffer, not readBody's string: a multipart upload can carry
        // arbitrary binary and a utf8 decode here would corrupt it before
        // files.ts ever sees the bytes. Every other route keeps using readBody
        // unchanged.
        //
        // Bounded, not readBodyBuffer: this route must answer a
        // 400 for a body that is *over* its content cap, and readBodyBuffer's
        // only answer to over-size is destroying the socket — which the caller
        // reads as ECONNRESET, with no status and no CORS. Here the bound is
        // on memory, not on the socket. See the constants' doc comments.
        const body = await readBodyBufferBounded(
          req,
          FILES_BODY_MAX_BYTES,
          FILES_BODY_DRAIN_MAX_BYTES,
        );
        await handleFilesCreate(
          req,
          res,
          body.buffer ?? FILES_BODY_OVERSIZED,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, {
          service: "files",
        });
      }
      return;
    }

    // Fine-tuning jobs — cancel/events REs before id RE.
    // Cancel takes no payload — the `openai` SDK posts an empty body — but the
    // body is still read, and discarded, before the handler runs. Reading it is
    // what applies `readBody`'s 10 MB ceiling: a POST route that never touches
    // the stream lets node quietly dump whatever the client sends, so this one
    // route would accept an unbounded upload while the create route beside it
    // (the sibling pattern followed here, down to the error arm) rejects the
    // same bytes.
    const ftCancelMatch = pathname.match(FINE_TUNING_CANCEL_RE);
    if (ftCancelMatch && req.method === "POST") {
      try {
        await readBody(req);
        await handleFineTuningCancel(req, res, ftCancelMatch[1], journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, {
          service: "fine-tuning",
        });
      }
      return;
    }
    const ftEventsMatch = pathname.match(FINE_TUNING_EVENTS_RE);
    if (ftEventsMatch && req.method === "GET") {
      try {
        await handleFineTuningEvents(req, res, ftEventsMatch[1], journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "fine-tuning" });
      }
      return;
    }
    const ftIdMatch = pathname.match(FINE_TUNING_ID_RE);
    if (ftIdMatch && req.method === "GET") {
      try {
        await handleFineTuningRetrieve(req, res, ftIdMatch[1], journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "fine-tuning" });
      }
      return;
    }
    if (pathname === FINE_TUNING_JOBS_PATH && req.method === "GET") {
      try {
        await handleFineTuningList(req, res, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "fine-tuning" });
      }
      return;
    }
    if (pathname === FINE_TUNING_JOBS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleFineTuningCreate(req, res, raw, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, {
          service: "fine-tuning",
        });
      }
      return;
    }

    // Vector Stores — most-specific REs before the id RE, collection last.
    // The id RE's `[^/]+` would otherwise swallow `/files`, `/search` and
    // the file-batch suffixes, and the collection exact match must not claim
    // an id path. Every branch is method-guarded so unhandled methods fall
    // through to the shared 404, the server-wide convention (see the files
    // block above).
    const vsSearchMatch = pathname.match(VECTOR_STORES_SEARCH_RE);
    if (vsSearchMatch && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleVectorStoresSearch(
          req,
          res,
          vsSearchMatch[1],
          raw,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    const vsBatchFilesMatch = pathname.match(VECTOR_STORES_BATCH_FILES_RE);
    if (vsBatchFilesMatch && req.method === "GET") {
      try {
        await handleVectorFileBatchesFiles(
          req,
          res,
          vsBatchFilesMatch[1],
          vsBatchFilesMatch[2],
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    const vsBatchCancelMatch = pathname.match(VECTOR_STORES_BATCH_CANCEL_RE);
    if (vsBatchCancelMatch && req.method === "POST") {
      try {
        await readBody(req);
        await handleVectorFileBatchesCancel(
          req,
          res,
          vsBatchCancelMatch[1],
          vsBatchCancelMatch[2],
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    const vsBatchMatch = pathname.match(VECTOR_STORES_BATCH_RE);
    if (vsBatchMatch && req.method === "GET") {
      try {
        await handleVectorFileBatchesRetrieve(
          req,
          res,
          vsBatchMatch[1],
          vsBatchMatch[2],
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    const vsFileMatch = pathname.match(VECTOR_STORES_FILE_RE);
    if (vsFileMatch && req.method === "GET") {
      try {
        await handleVectorStoreFilesRetrieve(
          req,
          res,
          vsFileMatch[1],
          vsFileMatch[2],
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    if (vsFileMatch && req.method === "DELETE") {
      try {
        await handleVectorStoreFilesDelete(
          req,
          res,
          vsFileMatch[1],
          vsFileMatch[2],
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    // Note: VECTOR_STORES_ID_RE only matches the exact 3-segment id path,
    // so it can never swallow the /files, /search or /file_batches suffixes
    // handled above — no extra depth guards needed.
    const vsIdMatch = pathname.match(VECTOR_STORES_ID_RE);
    if (vsIdMatch && req.method === "GET") {
      try {
        await handleVectorStoresRetrieve(req, res, vsIdMatch[1], journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    if (vsIdMatch && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleVectorStoresModify(
          req,
          res,
          vsIdMatch[1],
          raw,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    if (vsIdMatch && req.method === "DELETE") {
      try {
        await handleVectorStoresDelete(req, res, vsIdMatch[1], journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    if (VECTOR_STORES_FILES_RE.test(pathname) && req.method === "POST") {
      try {
        const raw = await readBody(req);
        const storeId = pathname.split("/")[3];
        await handleVectorStoreFilesCreate(
          req,
          res,
          storeId,
          raw,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    if (VECTOR_STORES_FILES_RE.test(pathname) && req.method === "GET") {
      try {
        const storeId = pathname.split("/")[3];
        await handleVectorStoreFilesList(req, res, storeId, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    if (VECTOR_STORES_FILE_BATCHES_RE.test(pathname) && req.method === "POST") {
      try {
        const raw = await readBody(req);
        const storeId = pathname.split("/")[3];
        await handleVectorFileBatchesCreate(
          req,
          res,
          storeId,
          raw,
          journal,
          defaults,
          setCorsHeaders,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    if (pathname === VECTOR_STORES_PATH && req.method === "GET") {
      try {
        await handleVectorStoresList(req, res, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }
    if (pathname === VECTOR_STORES_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        await handleVectorStoresCreate(req, res, raw, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "vector-stores" });
      }
      return;
    }

    // Journal inspection endpoints
    if (pathname === REQUESTS_PATH) {
      setCorsHeaders(res);
      if (req.method === "GET") {
        const limitParam = parsedUrl.searchParams.get("limit");
        let opts: { limit: number } | undefined;
        if (limitParam) {
          const limit = Number(limitParam);
          if (!/^\+?\d+$/.test(limitParam.trim()) || !Number.isSafeInteger(limit) || limit <= 0) {
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
        // match-counts), use POST /__aimock/reset.
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
        ensureRawFixturePositions();
        await handleResponses(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, {
          streamEvent: (m) =>
            `event: error\ndata: ${JSON.stringify({ error: { message: m } })}\n\n`,
        });
      }
      return;
    }

    // POST /v1/messages — Anthropic Claude Messages API
    if (pathname === MESSAGES_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleMessages(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, {
          streamEvent: (m) =>
            `event: error\ndata: ${JSON.stringify({ error: { message: m } })}\n\n`,
        });
      }
      return;
    }

    // POST /v2/chat — Cohere v2 Chat API
    if (pathname === COHERE_CHAT_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleCohere(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, {
          streamEvent: (m) =>
            `event: error\ndata: ${JSON.stringify({ error: { message: m } })}\n\n`,
        });
      }
      return;
    }

    // POST /v2/embed — Cohere v2 Embed API
    if (pathname === COHERE_EMBED_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleCohereEmbed(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
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
        ensureRawFixturePositions();
        await handleEmbeddings(
          req,
          res,
          raw,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          embeddingsProvider,
          originalPathname === EMBEDDINGS_PATH,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1/images/generations — OpenAI Image Generation API
    if (pathname === IMAGES_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleImages(
          req,
          res,
          raw,
          fixtures,
          journal,
          defaults,
          setCorsHeaders,
          "openai",
          undefined,
          isBytePlusArk ? "byteplus" : undefined,
        );
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1/images/edits — OpenAI Image Edit API (multipart/form-data)
    if (pathname === IMAGES_EDIT_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleImageEdit(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1/images/variations — OpenAI Image Variations API (multipart/form-data)
    if (pathname === IMAGES_VARIATIONS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleImageVariations(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1/audio/speech — OpenAI TTS API
    if (pathname === SPEECH_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleSpeech(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1/audio/transcriptions — OpenAI Transcription API
    if (pathname === TRANSCRIPTIONS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleTranscription(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1/audio/translations — OpenAI Translation API
    if (pathname === TRANSLATIONS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
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
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1/videos — Video Generation API
    if (pathname === VIDEOS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
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
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
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
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // GET /v1beta/operations/{name} — Google Veo video status poll.
    // (T0: handler is a stub filled in T1.)
    const veoOperationMatch = pathname.match(VEO_OPERATION_RE);
    if (veoOperationMatch && req.method === "GET") {
      try {
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1beta/models/{model}:predict — Gemini Imagen API
    const geminiPredictMatch = pathname.match(GEMINI_PREDICT_RE);
    if (geminiPredictMatch && req.method === "POST") {
      const predictModel = geminiPredictMatch[1];
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1beta/interactions — Google Gemini Interactions API
    if (pathname === GEMINI_INTERACTIONS_PATH && req.method === "POST") {
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleGeminiInteractions(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, {
          streamEvent: (m) => `data: ${JSON.stringify({ error: { message: m } })}\n\n`,
        });
      }
      return;
    }

    // POST /v1beta/models/{model}:embedContent — Google Gemini Embedding
    const geminiEmbedMatch = pathname.match(GEMINI_EMBED_RE);
    if (geminiEmbedMatch && req.method === "POST") {
      const embedModel = geminiEmbedMatch[1];
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
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
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname, {
          streamEvent: (m) => `data: ${JSON.stringify({ error: { message: m } })}\n\n`,
        });
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
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname, {
          streamEvent: (m) => `data: ${JSON.stringify({ error: { message: m } })}\n\n`,
        });
      }
      return;
    }

    // POST /model/{modelId}/invoke — AWS Bedrock Claude API
    const bedrockMatch = pathname.match(BEDROCK_INVOKE_RE);
    if (bedrockMatch && req.method === "POST") {
      const bedrockModelId = bedrockMatch[1];
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /model/{modelId}/invoke-with-response-stream — AWS Bedrock Claude streaming
    const bedrockStreamMatch = pathname.match(BEDROCK_STREAM_RE);
    if (bedrockStreamMatch && req.method === "POST") {
      const bedrockModelId = bedrockStreamMatch[1];
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /model/{modelId}/converse — AWS Bedrock Converse API
    const converseMatch = pathname.match(BEDROCK_CONVERSE_RE);
    if (converseMatch && req.method === "POST") {
      const converseModelId = converseMatch[1];
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /model/{modelId}/converse-stream — AWS Bedrock Converse streaming API
    const converseStreamMatch = pathname.match(BEDROCK_CONVERSE_STREAM_RE);
    if (converseStreamMatch && req.method === "POST") {
      const converseStreamModelId = converseStreamMatch[1];
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
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
        routeError(req, res, err, pathname);
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
        routeError(req, res, err, pathname, {
          service: "search",
        });
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
        routeError(req, res, err, pathname, {
          service: "rerank",
        });
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
        routeError(req, res, err, pathname, {
          service: "moderation",
        });
      }
      return;
    }

    // POST /v1/sound-generation — ElevenLabs Sound Generation API
    if (pathname === ELEVENLABS_SOUND_GENERATION_PATH && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleElevenLabsAudio(req, res, raw, fixtures, defaults, journal, "sound-generation");
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1/text-to-voice/design — ElevenLabs Voice Design (must precede create)
    if (pathname === ELEVENLABS_VOICE_DESIGN_PATH && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleElevenLabsVoiceDesign(req, res, raw, fixtures, defaults, journal);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "elevenlabs-voice" });
      }
      return;
    }

    // POST /v1/text-to-voice — save a designed preview as a permanent voice
    if (pathname === ELEVENLABS_VOICE_CREATE_PATH && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = await readBody(req);
        ensureRawFixturePositions();
        await handleElevenLabsVoiceCreate(req, res, raw, fixtures, defaults, journal);
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "elevenlabs-voice" });
      }
      return;
    }

    // GET|DELETE /v1/voices/{voice_id} — slot management after Voice Design save
    const elevenLabsVoiceMatch = pathname.match(ELEVENLABS_VOICE_RE);
    if (elevenLabsVoiceMatch && (req.method === "GET" || req.method === "DELETE")) {
      setCorsHeaders(res);
      // The id arrives percent-encoded on the wire while the voice store is
      // keyed by the id exactly as it appears in JSON, so the raw path segment
      // made any id carrying a space or a slash permanently unreachable.
      // `decodeURIComponent` throws `URIError` on a malformed escape — that is
      // a bad request, not a server fault, so it is answered 400 rather than
      // falling into the 500 handler below.
      let voiceId: string;
      try {
        voiceId = decodeURIComponent(elevenLabsVoiceMatch[1]);
      } catch {
        writeErrorResponse(
          res,
          400,
          JSON.stringify({
            error: {
              message: `Invalid voice id '${elevenLabsVoiceMatch[1]}': malformed percent-encoding`,
              type: "invalid_request_error",
            },
          }),
        );
        // Journaled AFTER the write, like every other terminal arm in this
        // batch: the caller's answer never waits on bookkeeping. Tagged with
        // the service so this rejection is selectable under
        // `?service=elevenlabs-voice` with the rest of the route's branches —
        // it was the one voice branch that left no journal entry at all.
        journal.add({
          method: req.method ?? "GET",
          path: req.url ?? pathname,
          headers: flattenHeaders(req.headers),
          service: "elevenlabs-voice",
          body: null,
          response: { status: 400, fixture: null },
        });
        return;
      }
      try {
        if (req.method === "GET") {
          ensureRawFixturePositions();
          await handleElevenLabsVoiceGet(req, res, voiceId, fixtures, defaults, journal);
        } else {
          ensureRawFixturePositions();
          await handleElevenLabsVoiceDelete(req, res, voiceId, fixtures, defaults, journal);
        }
      } catch (err: unknown) {
        routeError(req, res, err, pathname, { service: "elevenlabs-voice" });
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
        ensureRawFixturePositions();
        await handleElevenLabsTTS(req, res, raw, fixtures, defaults, journal, voiceId);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
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
        ensureRawFixturePositions();
        await handleElevenLabsAudio(req, res, raw, fixtures, defaults, journal, musicSubType);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
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
    if (FAL_ROUTE_RE.test(pathname) && req.headers["x-fal-target-host"]) {
      setCorsHeaders(res);
      try {
        falBody = req.method === "POST" || req.method === "PUT" ? await readBody(req) : "";
        const raw = falBody;
        // Chaos is rolled EXACTLY ONCE per fal request. This gate owns the roll
        // only when the general handler is actually going to own the request;
        // if `handleFal` would return "passthrough" the request continues to
        // the legacy `/fal/queue/...` / `/fal/run/...` routes below, and THEIR
        // `applyChaosAsync` (or the queue-requests gate) is the single roll.
        // Rolling here unconditionally would double-roll every passthrough
        // (observed: 0.72 effective drop rate for a configured 0.5).
        //
        // The deterministic latency is awaited BEFORE the roll, so a configured
        // delay applies to every outcome on this path — served state, proxied
        // response and each chaos failure alike — exactly as the completions
        // path does, and resolved from the same per-testId scope as the rates.
        //
        // `source` is "internal": the roll happens before any fixture match or
        // upstream call, so nothing was going to serve this but aimock's own
        // fal logic. Mirrors the veo/grok/openrouter lifecycle gates.
        if (falWillHandle(req, pathname)) {
          // Resolved ONCE and threaded into both the latency await and the
          // action roll — re-resolving would re-parse the chaos headers and
          // warn twice per request. `res` is passed so a client that hangs up
          // mid-delay CANCELS the pending timer instead of leaving the handler
          // waiting out the full latency. Both mirror the completions path.
          const chaosConfig = resolveChaosConfig(
            null,
            defaults.chaos,
            req.headers,
            defaults.logger,
            req.url,
          );
          await awaitChaosLatency(
            null,
            defaults.chaos,
            req.headers,
            defaults.logger,
            req.url,
            res,
            chaosConfig,
          );
          // C13: the latency await resolves EARLY when the client hangs up
          // mid-delay (the timer is cancelled off `res`'s `close`).
          // `applyChaosAsync` re-checks writability at exactly this point; a
          // SPLIT gate has to do it itself. Without this the handler carries
          // on and builds, "serves" and JOURNALS a full response into a dead
          // socket — a phantom entry for bytes no client ever received.
          const goneAfterLatency = responseGoneReason(res);
          if (goneAfterLatency !== null) {
            defaults.logger.debug(
              `[chaos] ${req.method ?? "GET"} ${pathname}: ` +
                `${describeUnwritableReason(goneAfterLatency)} after the latency delay — ` +
                `not served, not journalled`,
            );
            return;
          }
          const chaosAction = evaluateChaos(
            null,
            defaults.chaos,
            req.headers,
            defaults.logger,
            req.url,
            chaosConfig,
          );
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
                body: null,
              },
              "internal",
              defaults.registry,
              defaults.logger,
            );
            return;
          }
        }
        ensureRawFixturePositions();
        const outcome = await handleFal(req, res, raw, pathname, fixtures, defaults, journal);
        if (outcome === "handled") return;
        // passthrough: fall through to legacy fal-audio routes below
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
        return;
      }
    }

    // POST /fal/queue/submit/{model} — fal.ai Queue Submit
    const falQueueSubmitMatch = pathname.match(FAL_QUEUE_SUBMIT_RE);
    if (falQueueSubmitMatch && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = falBody ?? (await readBody(req));
        ensureRawFixturePositions();
        await handleFalQueue(req, res, raw, pathname, fixtures, defaults, journal);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
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
        // Status / cancel / result are pure state lookups: `handleFalQueue`
        // rolls no chaos for them, so this gate is their single roll. Latency
        // first, then the roll — same order as every other handler path.
        // `source` is "internal" (no fixture, no upstream: aimock's own queue
        // state was going to serve this), matching the veo status gate.
        // Resolved ONCE and threaded into both the latency await and the action
        // roll; `res` makes the delay cancellable on client disconnect. Same
        // shape as the completions path and the `x-fal-target-host` gate above.
        const chaosConfig = resolveChaosConfig(
          null,
          defaults.chaos,
          req.headers,
          defaults.logger,
          req.url,
        );
        await awaitChaosLatency(
          null,
          defaults.chaos,
          req.headers,
          defaults.logger,
          req.url,
          res,
          chaosConfig,
        );
        // C13: the latency await resolves EARLY when the client hangs up
        // mid-delay (the timer is cancelled off `res`'s `close`).
        // `applyChaosAsync` re-checks writability at exactly this point; a
        // SPLIT gate has to do it itself. Without this the handler carries on
        // and builds, "serves" and JOURNALS a full response into a dead
        // socket — a phantom entry for bytes no client ever received.
        const goneAfterLatency = responseGoneReason(res);
        if (goneAfterLatency !== null) {
          defaults.logger.debug(
            `[chaos] ${req.method ?? "GET"} ${pathname}: ` +
              `${describeUnwritableReason(goneAfterLatency)} after the latency delay — ` +
              `not served, not journalled`,
          );
          return;
        }
        const chaosAction = evaluateChaos(
          null,
          defaults.chaos,
          req.headers,
          defaults.logger,
          req.url,
          chaosConfig,
        );
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
              body: null,
            },
            "internal",
            defaults.registry,
            defaults.logger,
          );
          return;
        }
        ensureRawFixturePositions();
        await handleFalQueue(req, res, raw, pathname, fixtures, defaults, journal);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /fal/run/{model} — fal.ai Synchronous Run
    const falRunMatch = pathname.match(FAL_RUN_RE);
    if (falRunMatch && req.method === "POST") {
      setCorsHeaders(res);
      try {
        const raw = falBody ?? (await readBody(req));
        ensureRawFixturePositions();
        await handleFalQueue(req, res, raw, pathname, fixtures, defaults, journal);
      } catch (err: unknown) {
        routeError(req, res, err, pathname);
      }
      return;
    }

    // POST /v1/chat/completions — Chat Completions API
    if (pathname !== COMPLETIONS_PATH) {
      // Registry drift guard: the catalog claims every ROUTE_DEFINITIONS
      // entry is mounted. If the registry matches a request the dispatcher
      // just fell through, the two have drifted — warn loudly (the 404
      // stands; this never changes serving behavior). Exempt: /metrics 404s
      // by design when the server runs with `metrics: false`.
      const catalogMatch = matchRouteDefinition(req.method ?? "", pathname);
      if (catalogMatch && !(pathname === METRICS_PATH && !registry)) {
        defaults.logger.warn(
          `Route drift: ${req.method ?? "?"} ${pathname} matches the route catalog ` +
            `(${catalogMatch.method} ${catalogMatch.path} — ${catalogMatch.description}) ` +
            `but no dispatcher branch served it. The catalog entry or the dispatcher ` +
            `is stale — see route-registry.ts.`,
        );
      }
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
        : isBytePlusArk
          ? "byteplus"
          : "openai";
    try {
      await handleCompletions(
        req,
        res,
        fixtures,
        journal,
        defaults,
        () => lastJournalEntryFor(req),
        azureDeploymentId,
        completionsProvider,
        isOpenRouter,
        ensureRawFixturePositions,
        originalPathname.startsWith("/api/v3/"),
      );
    } catch (err: unknown) {
      routeError(req, res, err, pathname, {
        envelope: (m, status) =>
          isOpenRouter
            ? serializeOpenRouterError(status, m)
            : JSON.stringify({
                error: { message: m, type: errorTypeForStatus(status) },
              }),
        // OpenRouter's numeric `error.code` is the HTTP status, so the aimock
        // code rides in its free-form `metadata`.
        ...(isOpenRouter
          ? { toolCallEnvelope: (m, code) => serializeOpenRouterError(500, m, { reason: code }) }
          : {}),
        streamEvent: (m, status) =>
          `data: ${
            isOpenRouter
              ? serializeOpenRouterError(status, m)
              : JSON.stringify({ error: { message: m, type: errorTypeForStatus(status) } })
          }\n\n`,
      });
    }
  }

  // ─── WebSocket upgrade handling ──────────────────────────────────────────

  const activeConnections = new Set<WebSocketConnection>();
  const liveLimits = normalizeLiveOptions(options?.live);
  const liveSessions = new Map<symbol, { testId: string; dispose: () => void }>();
  const closeLiveSessions = (testId?: string) => {
    for (const session of [...liveSessions.values()]) {
      if (testId === undefined || session.testId === testId) session.dispose();
    }
  };
  liveClosers.set(defaults, closeLiveSessions);

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

  /**
   * Body bytes the platform already parsed onto `req` for an upgrade request.
   *
   * Node >= 26 delivers an upgrade request's body here and leaves `head`
   * empty; Node <= 24 leaves the body in `head` and ends `req` with nothing.
   * The stream has already ended in both cases, so this resolves on the next
   * tick either way — it never waits on the network.
   */
  function drainParsedRequestBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      };
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", done);
      req.on("error", done);
      req.on("close", done);
      req.resume();
    });
  }

  async function handleUpgradeRequest(
    req: http.IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): Promise<void> {
    // `Upgrade: h2c` + `Connection: Upgrade` on plain requests — including
    // ones with a body — to probe for HTTP/2 cleartext support. Only actual
    // WebSocket upgrades belong on this path.
    //
    // Node fires "upgrade" instead of "request" for any `Connection: Upgrade`,
    // whatever protocol is named, and the request never reaches the normal
    // pipeline. Rather than reimplementing body parsing, rebuild the request
    // line and headers with `Upgrade`/`Connection` dropped — the only thing
    // that made this look like an upgrade — replay them onto the socket, and
    // let Node re-parse the connection from scratch as an ordinary request.
    //
    // WHERE THE BODY LIVES DEPENDS ON THE NODE VERSION, and both cases must be
    // replayed or the re-parsed request stalls forever waiting on a
    // `Content-Length` worth of bytes that will never arrive:
    //
    //   - Node <= 24 detaches the parser at "upgrade", so `req` yields nothing
    //     and any body bytes already read land in `head` (or, if the client
    //     sent them later, still arrive on the socket afterwards).
    //   - Node >= 26 parses the body onto `req` and leaves `head` EMPTY. The
    //     bytes are not on the socket either — draining `req` is the only way
    //     to get them back.
    //
    // Draining `req` is safe on both: on the older behaviour it ends
    // immediately with zero bytes, so the concat below is a no-op there and
    // `head` carries the body as before.
    if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      const parsedBody = await drainParsedRequestBody(req);
      const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      const headerLines: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (/^(?:upgrade|connection)$/i.test(req.rawHeaders[i])) continue;
        headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      const rebuilt = Buffer.from(requestLine + headerLines.join("\r\n") + "\r\n\r\n");
      socket.unshift(Buffer.concat([rebuilt, parsedBody, head]));
      server.emit("connection", socket);
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Internal error";
      defaults.logger.warn(`Unhandled upgrade error: ${msg}`);
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    let pathname = parsedUrl.pathname;

    if (!validateRequestApiKey(req, resolvedAuth.policy).ok) {
      writeApiKeyUpgradeRejection(socket);
      return;
    }

    // Dispatch to mounted services before any path rewrites
    for (const { path: mountPath, handler } of mountList) {
      if (
        (pathname === mountPath || pathname.startsWith(mountPath + "/")) &&
        handler.handleUpgrade
      ) {
        const subPath = pathname.slice(mountPath.length) || "/";
        if (await handler.handleUpgrade(socket, head, subPath)) return;
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
      pathname !== GEMINI_LIVE_PATH &&
      pathname !== LIVE_PATH
    ) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (
      defaults.misbehavior &&
      pathname !== LIVE_PATH &&
      req.headers["x-aimock-misbehavior"] !== undefined
    ) {
      const code = "aimock_misbehavior_invalid";
      const message = "use the runtime scope: POST /__aimock/misbehavior with X-Test-Id";
      const body = JSON.stringify({
        error:
          pathname === GEMINI_LIVE_PATH
            ? { code: 400, status: "INVALID_ARGUMENT", message: `${code}: ${message}` }
            : { type: "invalid_request_error", code, message },
      });
      socket.end(
        "HTTP/1.1 400 Bad Request\r\n" +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          "Connection: close\r\n\r\n" +
          body,
      );
      return;
    }

    let liveId: symbol | undefined;
    if (pathname === LIVE_PATH) {
      if (req.method !== "GET" || parsedUrl.searchParams.has("model")) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      if (liveSessions.size >= liveLimits.maxSessions) {
        socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
        return;
      }
      liveId = Symbol("live-session");
      const reservedId = liveId;
      liveSessions.set(reservedId, {
        testId: getTestId(req),
        dispose: () => {
          socket.destroy();
          liveSessions.delete(reservedId);
        },
      });
    }

    // Push any buffered data back before upgrading
    if (head.length > 0) {
      socket.unshift(head);
    }

    let ws: WebSocketConnection;
    try {
      ws = upgradeToWebSocket(req, socket, pathname === LIVE_PATH ? liveLimits : undefined);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "WebSocket upgrade failed";
      if (liveId !== undefined) liveSessions.delete(liveId);
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
    if (pathname === LIVE_PATH && liveId !== undefined) {
      const sessionId = liveId;
      const dispose = handleLiveSession(ws, fixtures, journal, {
        defaults,
        limits: liveLimits,
        localApiKeys: resolvedAuth.publicConfig?.apiKeys,
        testId: wsTestId,
        headers: req.headers,
        onDispose: () => {
          liveSessions.delete(sessionId);
          activeConnections.delete(ws);
        },
      });
      liveSessions.set(sessionId, { testId: wsTestId, dispose });
    } else if (pathname === RESPONSES_PATH) {
      handleWebSocketResponses(ws, fixtures, journal, {
        ...defaults,
        model: "gpt-4",
        testId: wsTestId,
        upgradeHeaders: req.headers,
        beforeProcessMessage: ensureRawFixturePositions,
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
        beforeProcessMessage: ensureRawFixturePositions,
      });
    } else if (pathname === GEMINI_LIVE_PATH) {
      handleWebSocketGeminiLive(ws, fixtures, journal, {
        ...defaults,
        model: "gemini-2.0-flash",
        testId: wsTestId,
        upgradeHeaders: req.headers,
        beforeProcessMessage: ensureRawFixturePositions,
      });
    }
  }

  // Close active WS connections when server shuts down
  const originalClose = server.close.bind(server);
  server.close = function (this: http.Server, callback?: (err?: Error) => void) {
    closeLiveSessions();
    for (const ws of activeConnections) {
      ws.close(1001, "Server shutting down");
    }
    activeConnections.clear();
    videoStates.clear();
    openRouterVideoJobs.clear();
    veoVideoJobs.clear();
    grokVideoJobs.clear();
    bytePlusVideoJobs.clear();
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

      try {
        commitHandOff();
      } catch (err) {
        server.close(() => reject(err));
        return;
      }

      // Set base URL on mounted services that support it
      for (const { path: mountPath, handler } of mountList) {
        if (handler.setBaseUrl) handler.setBaseUrl(url + mountPath);
      }

      resolve({
        closeLiveSessions,
        server,
        journal,
        url,
        defaults,
        videoStates,
        openRouterVideoJobs,
        veoVideoJobs,
        grokVideoJobs,
        bytePlusVideoJobs,
      });
    });
  });
}
