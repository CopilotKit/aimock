import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

// LLMock type definitions — shared across all provider adapters and the fixture router.

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
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: object };
}

// Fixture matching

export interface FixtureMatch {
  userMessage?: string | RegExp;
  inputText?: string | RegExp;
  toolCallId?: string;
  toolName?: string;
  model?: string | RegExp;
  responseFormat?: string;
  predicate?: (req: ChatCompletionRequest) => boolean;
  /** Which occurrence of this match to respond to (0-indexed). Undefined means match any. */
  sequenceIndex?: number;
}

// Fixture response types

export interface TextResponse {
  content: string;
  role?: string;
  finishReason?: string;
}

export interface ToolCall {
  name: string;
  arguments: string;
  id?: string;
}

export interface ToolCallResponse {
  toolCalls: ToolCall[];
  finishReason?: string;
}

export interface ErrorResponse {
  error: { message: string; type?: string; code?: string };
  status?: number;
}

export interface EmbeddingResponse {
  embedding: number[];
}

export type FixtureResponse = TextResponse | ToolCallResponse | ErrorResponse | EmbeddingResponse;

// Streaming physics

export interface StreamingProfile {
  ttft?: number; // Time to first token (ms)
  tps?: number; // Tokens per second
  jitter?: number; // Random variance factor (0-1), default 0
}

export interface ChaosConfig {
  dropRate?: number;
  malformedRate?: number;
  disconnectRate?: number;
}

export type ChaosAction = "drop" | "malformed" | "disconnect";

// Fixture

export interface Fixture {
  match: FixtureMatch;
  response: FixtureResponse;
  latency?: number;
  chunkSize?: number;
  truncateAfterChunks?: number;
  disconnectAfterMs?: number;
  streamingProfile?: StreamingProfile;
  chaos?: ChaosConfig;
}

export type FixtureOpts = Omit<Fixture, "match" | "response">;
export type EmbeddingFixtureOpts = Pick<FixtureOpts, "latency" | "chaos">;

// Fixture file format (JSON on disk)

export interface FixtureFile {
  fixtures: FixtureFileEntry[];
}

export interface FixtureFileEntry {
  match: {
    userMessage?: string;
    inputText?: string;
    toolCallId?: string;
    toolName?: string;
    model?: string;
    responseFormat?: string;
    sequenceIndex?: number;
    // predicate not supported in JSON files
  };
  response: FixtureResponse;
  latency?: number;
  chunkSize?: number;
  truncateAfterChunks?: number;
  disconnectAfterMs?: number;
  streamingProfile?: StreamingProfile;
  chaos?: ChaosConfig;
}

// Request journal

export interface JournalEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: ChatCompletionRequest | null;
  response: {
    status: number;
    fixture: Fixture | null;
    interrupted?: boolean;
    interruptReason?: string;
    chaosAction?: ChaosAction;
  };
}

// SSE chunk types (OpenAI format)

export interface SSEChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: SSEChoice[];
}

export interface SSEChoice {
  index: number;
  delta: SSEDelta;
  finish_reason: string | null;
}

export interface SSEDelta {
  role?: string;
  content?: string | null;
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
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: string;
}

export interface ChatCompletionMessage {
  role: "assistant";
  content: string | null;
  refusal: string | null;
  tool_calls?: ToolCallMessage[];
}

// Server options

export type RecordProviderKey =
  | "openai"
  | "anthropic"
  | "gemini"
  | "vertexai"
  | "bedrock"
  | "azure"
  | "ollama"
  | "cohere";

export interface RecordConfig {
  providers: Partial<Record<RecordProviderKey, string>>;
  fixturePath?: string;
}

export interface MockServerOptions {
  port?: number;
  host?: string;
  latency?: number;
  chunkSize?: number;
  /** Log verbosity. CLI default is "info"; programmatic default (when omitted) is "silent". */
  logLevel?: "silent" | "info" | "debug";
  chaos?: ChaosConfig;
  /** Enable Prometheus-compatible /metrics endpoint. */
  metrics?: boolean;
  /** Strict mode: return 503 instead of 404 when no fixture matches. */
  strict?: boolean;
  /** Record-and-replay: proxy unmatched requests to upstream and save fixtures. */
  record?: RecordConfig;
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
}
