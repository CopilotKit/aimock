// Main class
export { LLMock } from "./llmock.js";

// Server
export { createServer, type ServerInstance } from "./server.js";

// Fixture loading
export { loadFixtureFile, loadFixturesFromDir } from "./fixture-loader.js";

// Journal
export { Journal } from "./journal.js";

// Router
export { matchFixture, getTextContent } from "./router.js";

// Provider handlers
export { handleResponses, buildTextStreamEvents, buildToolCallStreamEvents } from "./responses.js";
export type { ResponsesSSEEvent } from "./responses.js";
export { handleMessages } from "./messages.js";
export { handleGemini } from "./gemini.js";

// WebSocket
export { WebSocketConnection, upgradeToWebSocket, computeAcceptKey } from "./ws-framing.js";
export { handleWebSocketResponses } from "./ws-responses.js";
export { handleWebSocketRealtime } from "./ws-realtime.js";
export { handleWebSocketGeminiLive } from "./ws-gemini-live.js";

// Helpers
export {
  generateId,
  generateToolCallId,
  generateMessageId,
  generateToolUseId,
  buildTextChunks,
  buildToolCallChunks,
} from "./helpers.js";

// Interruption
export { createInterruptionSignal } from "./interruption.js";
export type { InterruptionControl } from "./interruption.js";

// SSE
export { writeSSEStream, writeErrorResponse, delay } from "./sse-writer.js";
export type { StreamOptions } from "./sse-writer.js";

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
  FixtureResponse,
  Fixture,
  FixtureFile,
  FixtureFileEntry,
  JournalEntry,
  SSEChunk,
  SSEChoice,
  SSEDelta,
  SSEToolCallDelta,
  MockServerOptions,
  ToolCallMessage,
} from "./types.js";
