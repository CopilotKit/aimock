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
export { handleResponses } from "./responses.js";
export { handleMessages } from "./messages.js";
export { handleGemini } from "./gemini.js";

// Helpers
export {
  generateId,
  generateToolCallId,
  generateMessageId,
  generateToolUseId,
  buildTextChunks,
  buildToolCallChunks,
} from "./helpers.js";

// SSE
export { writeSSEStream, writeErrorResponse } from "./sse-writer.js";

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
