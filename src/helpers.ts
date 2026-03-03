import { randomBytes } from "node:crypto";
import type {
  FixtureResponse,
  TextResponse,
  ToolCallResponse,
  ErrorResponse,
  SSEChunk,
  ToolCall,
  ChatCompletion,
} from "./types.js";

export function generateId(prefix = "chatcmpl"): string {
  return `${prefix}-${randomBytes(12).toString("base64url")}`;
}

export function generateToolCallId(): string {
  return `call_${randomBytes(12).toString("base64url")}`;
}

export function generateMessageId(): string {
  return `msg_${randomBytes(12).toString("base64url")}`;
}

export function generateToolUseId(): string {
  return `toolu_${randomBytes(12).toString("base64url")}`;
}

export function isTextResponse(r: FixtureResponse): r is TextResponse {
  return "content" in r && typeof (r as TextResponse).content === "string";
}

export function isToolCallResponse(r: FixtureResponse): r is ToolCallResponse {
  return "toolCalls" in r && Array.isArray((r as ToolCallResponse).toolCalls);
}

export function isErrorResponse(r: FixtureResponse): r is ErrorResponse {
  return (
    "error" in r &&
    (r as ErrorResponse).error !== null &&
    typeof (r as ErrorResponse).error === "object"
  );
}

export function buildTextChunks(content: string, model: string, chunkSize: number): SSEChunk[] {
  const id = generateId();
  const created = Math.floor(Date.now() / 1000);
  const chunks: SSEChunk[] = [];

  // Role chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });

  // Content chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: slice }, finish_reason: null }],
    });
  }

  // Finish chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });

  return chunks;
}

export function buildToolCallChunks(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
): SSEChunk[] {
  const id = generateId();
  const created = Math.floor(Date.now() / 1000);
  const chunks: SSEChunk[] = [];

  // Role chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
  });

  // Tool call chunks — one initial chunk per tool call, then argument chunks
  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    const tcId = tc.id || generateToolCallId();

    // Initial tool call chunk (id + function name)
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: tcIdx,
                id: tcId,
                type: "function",
                function: { name: tc.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });

    // Argument streaming chunks
    const args = tc.arguments;
    for (let i = 0; i < args.length; i += chunkSize) {
      const slice = args.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: tcIdx, function: { arguments: slice } }],
            },
            finish_reason: null,
          },
        ],
      });
    }
  }

  // Finish chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });

  return chunks;
}

// Non-streaming response builders

export function buildTextCompletion(content: string, model: string): ChatCompletion {
  return {
    id: generateId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function buildToolCallCompletion(toolCalls: ToolCall[], model: string): ChatCompletion {
  return {
    id: generateId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id || generateToolCallId(),
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
