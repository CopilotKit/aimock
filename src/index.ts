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

// Service mocks
export { handleSearch } from "./search.js";
export type { SearchResult, SearchFixture } from "./search.js";
export { handleRerank } from "./rerank.js";
export type { RerankResult, RerankFixture } from "./rerank.js";
export { handleModeration } from "./moderation.js";
export type { ModerationResult, ModerationFixture } from "./moderation.js";
export type { ServiceFixtures } from "./server.js";

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

// URL
export { resolveUpstreamUrl } from "./url.js";

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

// Mountable
export type { Mountable } from "./types.js";

// MCP
export { MCPMock } from "./mcp-mock.js";
export type {
  MCPMockOptions,
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPPromptDefinition,
  MCPContent,
  MCPResourceContent,
  MCPPromptResult,
  MCPSession,
} from "./mcp-types.js";

// Vector
export { VectorMock } from "./vector-mock.js";
export type {
  VectorMockOptions,
  VectorCollection,
  VectorEntry,
  QueryResult,
  VectorQuery,
  QueryHandler,
} from "./vector-types.js";

// A2A
export { A2AMock } from "./a2a-mock.js";
export type {
  A2AMockOptions,
  A2AAgentDefinition,
  A2APart,
  A2AArtifact,
  A2ATaskResponse,
  A2AStreamEvent,
  A2ATask,
  A2AMessage,
  A2ARole,
  A2ATaskState,
} from "./a2a-types.js";

// JSON-RPC
export { createJsonRpcDispatcher } from "./jsonrpc.js";
export type { JsonRpcResponse, MethodHandler, JsonRpcDispatcherOptions } from "./jsonrpc.js";

// Config loader
export { loadConfig, startFromConfig } from "./config-loader.js";
export type { AimockConfig } from "./config-loader.js";

// Suite
export { createMockSuite } from "./suite.js";
export type { MockSuite, MockSuiteOptions } from "./suite.js";

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
  ChatCompletion,
  ChatCompletionChoice,
  ChatCompletionMessage,
} from "./types.js";
