// Main class
export { LLMock } from "./llmock.js";

// Server
export { createServer, type ServerInstance } from "./server.js";

// Fixture loading
export { loadFixtureFile, loadFixturesFromDir, validateFixtures } from "./fixture-loader.js";
export type { ValidationResult } from "./fixture-loader.js";

// Logger
export { Logger } from "./logger.js";
export type { LogLevel } from "./logger.js";

// Journal
export { Journal } from "./journal.js";

// Router
export { matchFixture, getTextContent } from "./router.js";

// Provider handlers
export { handleResponses, buildTextStreamEvents, buildToolCallStreamEvents } from "./responses.js";
export type { ResponsesSSEEvent } from "./responses.js";
export { handleMessages } from "./messages.js";
export { handleGemini } from "./gemini.js";
export { handleEmbeddings } from "./embeddings.js";
export { handleBedrock, bedrockToCompletionRequest, handleBedrockStream } from "./bedrock.js";

// Bedrock Converse
export {
  handleConverse,
  handleConverseStream,
  converseToCompletionRequest,
} from "./bedrock-converse.js";

// AWS Event Stream
export {
  encodeEventStreamFrame,
  encodeEventStreamMessage,
  writeEventStream,
} from "./aws-event-stream.js";

// Metrics
export { createMetricsRegistry, normalizePathLabel } from "./metrics.js";
export type { MetricsRegistry } from "./metrics.js";

// NDJSON
export { writeNDJSONStream } from "./ndjson-writer.js";
export type { NDJSONStreamOptions } from "./ndjson-writer.js";

// Ollama
export { handleOllama, handleOllamaGenerate, ollamaToCompletionRequest } from "./ollama.js";

// Cohere
export { handleCohere, cohereToCompletionRequest } from "./cohere.js";

// WebSocket
export { WebSocketConnection, upgradeToWebSocket, computeAcceptKey } from "./ws-framing.js";
export { handleWebSocketResponses } from "./ws-responses.js";
export { handleWebSocketRealtime } from "./ws-realtime.js";
export { handleWebSocketGeminiLive } from "./ws-gemini-live.js";

// Helpers
export {
  flattenHeaders,
  generateId,
  generateToolCallId,
  generateMessageId,
  generateToolUseId,
  buildTextChunks,
  buildToolCallChunks,
  isEmbeddingResponse,
  generateDeterministicEmbedding,
  buildEmbeddingResponse,
} from "./helpers.js";
export type { EmbeddingAPIResponse } from "./helpers.js";

// Interruption
export { createInterruptionSignal } from "./interruption.js";
export type { InterruptionControl } from "./interruption.js";

// SSE
export { writeSSEStream, writeErrorResponse, delay, calculateDelay } from "./sse-writer.js";
export type { StreamOptions } from "./sse-writer.js";

// Chaos
export { evaluateChaos, applyChaos } from "./chaos.js";
export type { ChaosAction } from "./types.js";

// Recorder
export { proxyAndRecord } from "./recorder.js";

// Stream Collapse
export {
  collapseOpenAISSE,
  collapseAnthropicSSE,
  collapseGeminiSSE,
  collapseOllamaNDJSON,
  collapseCohereSSE,
  collapseBedrockEventStream,
  collapseStreamingResponse,
} from "./stream-collapse.js";
export type { CollapseResult } from "./stream-collapse.js";

// Types
export type {
  ChatMessage,
  ChatCompletionRequest,
  ContentPart,
  ToolDefinition,
  FixtureMatch,
  TextResponse,
  ToolCall,
  ToolCallResponse,
  ErrorResponse,
  EmbeddingResponse,
  FixtureResponse,
  Fixture,
  FixtureFile,
  FixtureFileEntry,
  JournalEntry,
  SSEChunk,
  SSEChoice,
  SSEDelta,
  SSEToolCallDelta,
  ChaosConfig,
  MockServerOptions,
  StreamingProfile,
  FixtureOpts,
  EmbeddingFixtureOpts,
  ToolCallMessage,
  RecordConfig,
  RecordProviderKey,
} from "./types.js";
