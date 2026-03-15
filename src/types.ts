// OpenAI Chat Completion request types (subset we care about)

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
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: object };
}

// Fixture matching

export interface FixtureMatch {
  userMessage?: string | RegExp;
  toolCallId?: string;
  toolName?: string;
  model?: string | RegExp;
  predicate?: (req: ChatCompletionRequest) => boolean;
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

export type FixtureResponse = TextResponse | ToolCallResponse | ErrorResponse;

// Fixture

export interface Fixture {
  match: FixtureMatch;
  response: FixtureResponse;
  latency?: number;
  chunkSize?: number;
  truncateAfterChunks?: number;
  disconnectAfterMs?: number;
}

// Fixture file format (JSON on disk)

export interface FixtureFile {
  fixtures: FixtureFileEntry[];
}

export interface FixtureFileEntry {
  match: {
    userMessage?: string;
    toolCallId?: string;
    toolName?: string;
    model?: string;
    // predicate not supported in JSON files
  };
  response: FixtureResponse;
  latency?: number;
  chunkSize?: number;
  truncateAfterChunks?: number;
  disconnectAfterMs?: number;
}

// Request journal

export interface JournalEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: ChatCompletionRequest;
  response: {
    status: number;
    fixture: Fixture | null;
    interrupted?: boolean;
    interruptReason?: string;
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

export interface MockServerOptions {
  port?: number;
  host?: string;
  latency?: number;
  chunkSize?: number;
}
