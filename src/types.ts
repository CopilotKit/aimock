import type * as http from "node:http";
import type * as net from "node:net";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

// LLMock type definitions — shared across all provider adapters and the fixture router.

export interface Mountable {
  handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean>;
  handleUpgrade?(socket: net.Socket, head: Buffer, pathname: string): Promise<boolean>;
  health?(): { status: string; [key: string]: unknown };
  setJournal?(journal: Journal): void;
  setBaseUrl?(url: string): void;
  setRegistry?(registry: MetricsRegistry): void;
}

export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
}

export interface ToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  tool_choice?: string | object;
  response_format?: { type: string; [key: string]: unknown };
  /** Embedding input text, set by the embeddings handler for fixture matching. */
  embeddingInput?: string;
  /** Endpoint type, set by handlers for fixture endpoint filtering. */
  _endpointType?: string;
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: object };
}

// Fixture matching

export interface FixtureMatch {
  userMessage?: string | RegExp;
  /**
   * Substring, regexp, or array of substrings matched against the concatenated
   * text content of every `system` role message in the request. Gates fixture
   * activation on values the host plumbs in via system messages (agent
   * context, persona, dynamic config) instead of the user-typed prompt — so
   * changing context state in the calling app causes stale fixtures to fall
   * through to a real upstream instead of silently returning a baked response
   * that no longer reflects reality.
   *
   * When given an array of strings, ALL substrings must be present (AND
   * semantics). Useful when the gate must combine multiple non-adjacent
   * tokens — e.g., a default name AND a default activity list whose JSON
   * positions vary across requests.
   */
  systemMessage?: string | string[] | RegExp;
  inputText?: string | RegExp;
  toolCallId?: string;
  toolName?: string;
  model?: string | RegExp;
  responseFormat?: string;
  predicate?: (req: ChatCompletionRequest) => boolean;
  /** Which occurrence of this match to respond to (0-indexed). Undefined means match any. */
  sequenceIndex?: number;
  turnIndex?: number;
  hasToolResult?: boolean;
  endpoint?:
    | "chat"
    | "image"
    | "speech"
    | "transcription"
    | "video"
    | "embedding"
    | "audio-gen"
    | "fal-audio"
    | "fal"
    | "realtime"
    | "realtime-transcription"
    | "realtime-translation";
}

// Fixture response types

/**
 * Fields that override auto-generated envelope values in the built response.
 * Scalar fields (finishReason, role) use OpenAI-canonical values — provider
 * handlers translate automatically. For usage, provide field names native to
 * your target provider (OpenAI Chat: prompt_tokens, completion_tokens;
 * Responses API: input_tokens, output_tokens; Anthropic: input_tokens,
 * output_tokens; Gemini: promptTokenCount, candidatesTokenCount).
 *
 * When total_tokens (or provider equivalent) is omitted, it is auto-computed
 * from the component fields.
 *
 * Provider support: OpenAI Chat (all 7), Responses API (5: no role,
 * systemFingerprint), Claude (5: no created, systemFingerprint),
 * Gemini (2: only finishReason, usage).
 */
export interface ResponseOverrides {
  id?: string;
  created?: number;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  systemFingerprint?: string;
  finishReason?: string;
  role?: string;
}

export interface TextResponse extends ResponseOverrides {
  content: string;
  reasoning?: string;
  webSearches?: string[];
}

export interface ToolCall {
  name: string;
  arguments: string;
  id?: string;
}

export interface ToolCallResponse extends ResponseOverrides {
  toolCalls: ToolCall[];
  webSearches?: string[];
}

export interface ContentWithToolCallsResponse extends ResponseOverrides {
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  webSearches?: string[];
}

export interface ErrorResponse {
  error: { message: string; type?: string; param?: string | null; code?: string };
  status?: number;
}

export interface EmbeddingResponse {
  embedding: number[];
}

export interface ImageItem {
  url?: string;
  b64Json?: string;
  revisedPrompt?: string;
}

export interface ImageResponse {
  image?: ImageItem;
  images?: ImageItem[];
}

export interface AudioResponse {
  audio: string | { b64Json: string; contentType?: string };
  format?: string;
}

export interface TranscriptionResponse {
  transcription: {
    text: string;
    language?: string;
    duration?: number;
    words?: Array<{ word: string; start: number; end: number }>;
    segments?: Array<{ id: number; text: string; start: number; end: number }>;
  };
}

export interface VideoResponse {
  video: {
    id: string;
    status: "processing" | "completed" | "failed";
    url?: string;
  };
}

/**
 * Pass-through JSON response. Used by handlers (e.g. fal.ai) that record
 * arbitrary upstream JSON payloads and replay them verbatim, without the
 * provider-specific shape coercion the other response types impose.
 */
export interface RawJSONResponse extends ResponseOverrides {
  json: unknown;
  status?: number;
}

export type FixtureResponse =
  | TextResponse
  | ToolCallResponse
  | ContentWithToolCallsResponse
  | ErrorResponse
  | EmbeddingResponse
  | ImageResponse
  | AudioResponse
  | TranscriptionResponse
  | VideoResponse
  | RawJSONResponse;

// GA Realtime session types

export type RealtimePhase = "final_answer" | "commentary";

export interface GASessionAudioConfig {
  voice: string | null;
  input_audio_format: string | null;
  output_audio_format: string | null;
  input_audio_noise_reduction: { type: string } | null;
  input_audio_transcription: { model: string } | null;
}

export interface GASessionConfig {
  model: string;
  modalities: string[];
  instructions: string;
  tools: unknown[];
  temperature: number;
  max_response_output_tokens: number | "inf";
  audio: GASessionAudioConfig;
  turn_detection: unknown | null;
  input_audio_transcription: { model: string } | null;
  type: "conversation" | "transcription" | "translation";
  reasoning: { effort: string } | null;
}

// Streaming physics

export interface StreamingProfile {
  ttft?: number; // Time to first token (ms)
  tps?: number; // Tokens per second
  jitter?: number; // Random variance factor (0-1), default 0
}

/**
 * Probabilistic chaos injection rates.
 *
 * Rates are evaluated sequentially per request — drop → malformed → disconnect
 * — and the first hit wins. Consequently malformedRate is conditional on drop
 * not firing, and disconnectRate is conditional on neither drop nor malformed
 * firing. A config of `{ dropRate: 0.5, malformedRate: 0.5 }` yields a ~25 %
 * effective malformed rate, not 50 %.
 */
export interface ChaosConfig {
  dropRate?: number;
  malformedRate?: number;
  disconnectRate?: number;
}

export type ChaosAction = "drop" | "malformed" | "disconnect";

// Response factory — allows dynamic fixture responses based on the incoming request

export type ResponseFactory = (
  req: ChatCompletionRequest,
) => FixtureResponse | Promise<FixtureResponse>;

// Fixture

export interface Fixture {
  match: FixtureMatch;
  response: FixtureResponse | ResponseFactory;
  latency?: number;
  chunkSize?: number;
  truncateAfterChunks?: number;
  disconnectAfterMs?: number;
  streamingProfile?: StreamingProfile;
  chaos?: ChaosConfig;
  metadata?: {
    systemHash?: string;
    toolsHash?: string;
  };
}

export type FixtureOpts = Omit<Fixture, "match" | "response">;
export type EmbeddingFixtureOpts = Pick<FixtureOpts, "latency" | "chaos">;

// Fixture file format (JSON on disk)
//
// File-entry types are intentionally relaxed compared to their runtime
// counterparts so that fixture authors can write JSON objects where the
// API ultimately expects a JSON *string*.  The fixture loader auto-
// stringifies these before building the runtime Fixture.

export interface FixtureFileToolCall {
  name: string;
  /** Accepts a JSON object or array for convenience — the loader will JSON.stringify it. */
  arguments: string | Record<string, unknown> | unknown[];
  id?: string;
}

export interface FixtureFileToolCallResponse extends ResponseOverrides {
  toolCalls: FixtureFileToolCall[];
  webSearches?: string[];
}

export interface FixtureFileTextResponse extends ResponseOverrides {
  /** Accepts a JSON object or array (structured output) — the loader will JSON.stringify it. */
  content: string | Record<string, unknown> | unknown[];
  reasoning?: string;
  webSearches?: string[];
}

export interface FixtureFileContentWithToolCallsResponse extends ResponseOverrides {
  /** Accepts a JSON object or array (structured output) — the loader will JSON.stringify it. */
  content: string | Record<string, unknown> | unknown[];
  toolCalls: FixtureFileToolCall[];
  reasoning?: string;
  webSearches?: string[];
}

export type FixtureFileResponse =
  | FixtureFileTextResponse
  | FixtureFileToolCallResponse
  | FixtureFileContentWithToolCallsResponse
  | ErrorResponse
  | EmbeddingResponse
  | ImageResponse
  | AudioResponse
  | TranscriptionResponse
  | VideoResponse
  | RawJSONResponse;

export interface FixtureFile {
  fixtures: FixtureFileEntry[];
}

export interface FixtureFileEntry {
  match: {
    userMessage?: string;
    /**
     * String (single substring) or array of strings (all must be present).
     * Mirrors the runtime FixtureMatch.systemMessage but without the RegExp
     * form, which JSON cannot express.
     */
    systemMessage?: string | string[];
    inputText?: string;
    toolCallId?: string;
    toolName?: string;
    model?: string;
    responseFormat?: string;
    sequenceIndex?: number;
    turnIndex?: number;
    hasToolResult?: boolean;
    endpoint?:
      | "chat"
      | "image"
      | "speech"
      | "transcription"
      | "video"
      | "embedding"
      | "audio-gen"
      | "fal-audio"
      | "fal"
      | "realtime"
      | "realtime-transcription"
      | "realtime-translation";
    // predicate not supported in JSON files
  };
  response: FixtureFileResponse;
  latency?: number;
  chunkSize?: number;
  truncateAfterChunks?: number;
  disconnectAfterMs?: number;
  streamingProfile?: StreamingProfile;
  chaos?: ChaosConfig;
  metadata?: {
    systemHash?: string;
    toolsHash?: string;
  };
}

// Request journal

export interface JournalEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: ChatCompletionRequest | null;
  service?: string;
  response: {
    status: number;
    fixture: Fixture | null;
    /**
     * What was going to serve this request. "fixture" = a fixture matched (or
     * would have, before chaos intervened). "proxy" = no fixture matched and
     * proxy was configured. Absent when the distinction doesn't apply (e.g.
     * 404/503 fallback where nothing was going to serve).
     */
    source?: "fixture" | "proxy" | "internal";
    interrupted?: boolean;
    interruptReason?: string;
    chaosAction?: ChaosAction;
    /** When the X-AIMock-Strict header overrode the server default. */
    strictOverride?: boolean;
  };
}

// SSE chunk types (OpenAI format)

export interface SSEChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: SSEChoice[];
  system_fingerprint?: string;
}

export interface SSEChoice {
  index: number;
  delta: SSEDelta;
  logprobs: null;
  finish_reason: string | null;
}

export interface SSEDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: SSEToolCallDelta[];
}

export interface SSEToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

// Non-streaming completion response types (OpenAI format)

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  system_fingerprint?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  logprobs: null;
  finish_reason: string;
}

export interface ChatCompletionMessage {
  role: string;
  content: string | null;
  refusal: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCallMessage[];
}

// Server options

export type RecordProviderKey =
  | "openai"
  | "anthropic"
  | "gemini"
  | "gemini-interactions"
  | "vertexai"
  | "bedrock"
  | "azure"
  | "ollama"
  | "cohere"
  | "elevenlabs"
  | "fal";

export interface RecordConfig {
  providers: Partial<Record<RecordProviderKey, string>>;
  fixturePath?: string;
  /** Proxy unmatched requests without saving fixtures or caching in memory. */
  proxyOnly?: boolean;
  /**
   * When true, record the exact model version string returned by the provider
   * (e.g. "gpt-4o-2024-08-06") instead of stripping the date suffix to a
   * canonical alias (e.g. "gpt-4o"). Default: false.
   */
  recordFullModelVersion?: boolean;
  /**
   * fal-specific recording knobs for the queue-walk recorder. During recording
   * the queue handler POSTs submit, polls `status_url` until COMPLETED, then
   * GETs `response_url` for the final job body — saved as the fixture. Tune
   * the poll cadence and timeout here if upstream is unusually slow or fast.
   */
  fal?: FalRecordConfig;
  /**
   * Connection idle timeout (ms) on the upstream request socket — fires if the
   * socket is inactive for this duration at any point before the response body
   * begins. Default: 30_000 (30s). Increase for upstreams with slow initial
   * responses (reasoning models, queue-backed providers).
   */
  upstreamTimeoutMs?: number;
  /**
   * Idle timeout (ms) on the upstream response body — fires if the upstream
   * goes silent (no bytes) for this long after the response has started.
   * Default: 30_000 (30s). Reasoning models under concurrent load can leave
   * 30s+ gaps between streaming chunks while the model is thinking; lift this
   * to e.g. 180_000 in those setups.
   */
  bodyTimeoutMs?: number;
}

export interface FalRecordConfig {
  /** Interval between status polls upstream during recording. Default: 1000ms. */
  pollIntervalMs?: number;
  /** Total budget for an upstream queue walk before aborting. Default: 900000ms (15 min) to accommodate video generation. */
  timeoutMs?: number;
}

export interface MockServerOptions {
  port?: number;
  host?: string;
  latency?: number;
  chunkSize?: number;
  /** Log verbosity. CLI default is "info"; programmatic default (when omitted) is "silent". */
  logLevel?: "silent" | "warn" | "info" | "debug";
  chaos?: ChaosConfig;
  /** Enable Prometheus-compatible /metrics endpoint. */
  metrics?: boolean;
  /** Strict mode: return 503 instead of 404 when no fixture matches. */
  strict?: boolean;
  /** Record-and-replay: proxy unmatched requests to upstream and save fixtures. */
  record?: RecordConfig;
  /**
   * Maximum number of request/response entries to retain in the in-memory
   * journal. Oldest entries are dropped FIFO when the cap is exceeded.
   * Set to 0 (or omit) for unbounded retention. Negative values are
   * rejected at the CLI parse layer; programmatically they are treated
   * as 0 (unbounded) for back-compat.
   *
   * Default: 1000 (applied by `createServer` when omitted). The CLI passes
   * through its own default. Short-lived test harnesses that want every
   * request recorded can opt in to unbounded retention by passing 0.
   */
  journalMaxEntries?: number;
  /**
   * Maximum number of unique testIds retained in the journal's fixture
   * match-count map. Oldest testIds are dropped FIFO when the cap is
   * exceeded. Set to 0 (or omit) for unbounded retention. Negative values
   * are rejected at the CLI parse layer; programmatically they are treated
   * as 0 (unbounded) for back-compat.
   *
   * Default: 500 (applied by `createServer` when omitted). Without a cap
   * this map can grow over time in long-running servers that see many
   * unique testIds.
   */
  fixtureCountsMaxTestIds?: number;
  /**
   * Normalize requests before matching and recording. Useful for stripping
   * dynamic data (timestamps, UUIDs, session IDs) that would cause fixture
   * mismatches on replay.
   *
   * When set, string matching for `userMessage` and `inputText` uses exact
   * equality (`===`) instead of substring (`includes`) to prevent false
   * positives from shortened keys.
   */
  requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest;
  /**
   * Configure fal.ai queue polling progression. By default a job completes
   * on submit (preserves the legacy `COMPLETED`-on-submit shape). Opt into a
   * realistic `IN_QUEUE → IN_PROGRESS → COMPLETED` progression by setting
   * positive poll thresholds — useful for exercising client code that polls
   * `/status` and reacts to intermediate states.
   *
   * Applies to the general fal handler (`x-fal-target-host`-routed); the
   * legacy `/fal/queue/...` audio handler is unaffected.
   */
  falQueue?: FalQueueConfig;
}

export interface FalQueueConfig {
  /**
   * Status polls before transitioning `IN_QUEUE → IN_PROGRESS`. Default: 0.
   * When `pollsBeforeCompleted` is also unset, the job completes synchronously
   * on submit (no IN_QUEUE / IN_PROGRESS polls emitted).
   */
  pollsBeforeInProgress?: number;
  /**
   * Status polls before transitioning to `COMPLETED`. Default: 0 when
   * `pollsBeforeInProgress` is also unset (no progression), otherwise
   * `pollsBeforeInProgress + 1` so the job spends one poll in IN_PROGRESS.
   * An explicit value lower than `pollsBeforeInProgress` is clamped up so
   * IN_PROGRESS is never skipped.
   */
  pollsBeforeCompleted?: number;
}

// Handler defaults — the common shape passed from server.ts to every handler

// TODO: Consider adding a resolveChunkSize(fixture, defaults) helper to centralize
// the Math.max(1, fixture.chunkSize ?? defaults.chunkSize) pattern used by all handlers.
export interface HandlerDefaults {
  latency: number;
  chunkSize: number;
  logger: Logger;
  chaos?: ChaosConfig;
  registry?: MetricsRegistry;
  record?: RecordConfig;
  strict?: boolean;
  requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest;
  falQueue?: FalQueueConfig;
}
