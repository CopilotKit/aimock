/**
 * Anthropic Claude Messages API support.
 *
 * Translates incoming /v1/messages requests into the ChatCompletionRequest
 * format used by the fixture router, and converts fixture responses back into
 * the Claude Messages API streaming (or non-streaming) format.
 */

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  generateMessageId,
  generateToolUseId,
  isTextResponse,
  isToolCallResponse,
  isErrorResponse,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";

// ─── Claude Messages API request types ──────────────────────────────────────

interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ClaudeContentBlock[];
  is_error?: boolean;
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

interface ClaudeToolDef {
  name: string;
  description?: string;
  input_schema?: object;
}

interface ClaudeRequest {
  model: string;
  messages: ClaudeMessage[];
  system?: string | ClaudeContentBlock[];
  tools?: ClaudeToolDef[];
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens: number;
  temperature?: number;
  [key: string]: unknown;
}

// ─── Input conversion: Claude → ChatCompletions messages ────────────────────

function extractClaudeTextContent(content: string | ClaudeContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

export function claudeToCompletionRequest(req: ClaudeRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // system field → system message
  if (req.system) {
    const systemText =
      typeof req.system === "string"
        ? req.system
        : req.system
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  for (const msg of req.messages) {
    if (msg.role === "user") {
      // Check for tool_result blocks
      if (typeof msg.content !== "string" && Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const textBlocks = msg.content.filter((b) => b.type === "text");

        if (toolResults.length > 0) {
          // Each tool_result → tool message
          for (const tr of toolResults) {
            const resultContent =
              typeof tr.content === "string"
                ? tr.content
                : Array.isArray(tr.content)
                  ? tr.content
                      .filter((b) => b.type === "text")
                      .map((b) => b.text ?? "")
                      .join("")
                  : "";
            messages.push({
              role: "tool",
              content: resultContent,
              tool_call_id: tr.tool_use_id,
            });
          }
          // Any accompanying text blocks → user message
          if (textBlocks.length > 0) {
            messages.push({
              role: "user",
              content: textBlocks.map((b) => b.text ?? "").join(""),
            });
          }
          continue;
        }
      }
      // Regular user message
      messages.push({
        role: "user",
        content: extractClaudeTextContent(msg.content),
      });
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        messages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
        const textContent = extractClaudeTextContent(msg.content);

        if (toolUseBlocks.length > 0) {
          messages.push({
            role: "assistant",
            content: textContent || null,
            tool_calls: toolUseBlocks.map((b) => ({
              id: b.id ?? generateToolUseId(),
              type: "function" as const,
              function: {
                name: b.name ?? "",
                arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}),
              },
            })),
          });
        } else {
          messages.push({ role: "assistant", content: textContent || null });
        }
      } else {
        // null/undefined content — tool-only assistant turn
        messages.push({ role: "assistant", content: null });
      }
    }
  }

  // Convert tools
  let tools: ToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  return {
    model: req.model,
    messages,
    stream: req.stream,
    temperature: req.temperature,
    tools,
  };
}

// ─── Response building: fixture → Claude Messages API format ────────────────

interface ClaudeSSEEvent {
  type: string;
  [key: string]: unknown;
}

function buildClaudeTextStreamEvents(
  content: string,
  model: string,
  chunkSize: number,
): ClaudeSSEEvent[] {
  const msgId = generateMessageId();
  const events: ClaudeSSEEvent[] = [];

  // message_start
  events.push({
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // content_block_start
  events.push({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  // content_block_delta — text chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: slice },
    });
  }

  // content_block_stop
  events.push({
    type: "content_block_stop",
    index: 0,
  });

  // message_delta
  events.push({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
  });

  // message_stop
  events.push({ type: "message_stop" });

  return events;
}

function buildClaudeToolCallStreamEvents(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
): ClaudeSSEEvent[] {
  const msgId = generateMessageId();
  const events: ClaudeSSEEvent[] = [];

  // message_start
  events.push({
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  for (let idx = 0; idx < toolCalls.length; idx++) {
    const tc = toolCalls[idx];
    const toolUseId = tc.id || generateToolUseId();

    // Parse arguments to JSON object (Claude uses objects, not strings)
    let argsObj: unknown;
    try {
      argsObj = JSON.parse(tc.arguments || "{}");
    } catch {
      argsObj = {};
    }
    const argsJson = JSON.stringify(argsObj);

    // content_block_start
    events.push({
      type: "content_block_start",
      index: idx,
      content_block: {
        type: "tool_use",
        id: toolUseId,
        name: tc.name,
        input: {},
      },
    });

    // content_block_delta — input_json_delta chunks
    for (let i = 0; i < argsJson.length; i += chunkSize) {
      const slice = argsJson.slice(i, i + chunkSize);
      events.push({
        type: "content_block_delta",
        index: idx,
        delta: { type: "input_json_delta", partial_json: slice },
      });
    }

    // content_block_stop
    events.push({
      type: "content_block_stop",
      index: idx,
    });
  }

  // message_delta
  events.push({
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 0 },
  });

  // message_stop
  events.push({ type: "message_stop" });

  return events;
}

// Non-streaming response builders

function buildClaudeTextResponse(content: string, model: string): object {
  return {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: content }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function buildClaudeToolCallResponse(toolCalls: ToolCall[], model: string): object {
  return {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    content: toolCalls.map((tc) => {
      let argsObj: unknown;
      try {
        argsObj = JSON.parse(tc.arguments || "{}");
      } catch {
        argsObj = {};
      }
      return {
        type: "tool_use",
        id: tc.id || generateToolUseId(),
        name: tc.name,
        input: argsObj,
      };
    }),
    model,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ─── SSE writer for Claude Messages API ─────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeClaudeSSEStream(
  res: http.ServerResponse,
  events: ClaudeSSEEvent[],
  latency = 0,
): Promise<void> {
  if (res.writableEnded) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  for (const event of events) {
    if (latency > 0) await delay(latency);
    if (res.writableEnded) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  if (!res.writableEnded) {
    res.end();
  }
}

// ─── Request handler ────────────────────────────────────────────────────────

export async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: { latency: number; chunkSize: number },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  setCorsHeaders(res);

  let claudeReq: ClaudeRequest;
  try {
    claudeReq = JSON.parse(raw) as ClaudeRequest;
  } catch {
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = claudeToCompletionRequest(claudeReq);

  const fixture = matchFixture(fixtures, completionReq);

  if (!fixture) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/messages",
      headers: {},
      body: completionReq,
      response: { status: 404, fixture: null },
    });
    writeErrorResponse(
      res,
      404,
      JSON.stringify({
        error: {
          message: "No fixture matched",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const response = fixture.response;
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/messages",
      headers: {},
      body: completionReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/messages",
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (claudeReq.stream === false) {
      const body = buildClaudeTextResponse(response.content, completionReq.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildClaudeTextStreamEvents(response.content, completionReq.model, chunkSize);
      await writeClaudeSSEStream(res, events, latency);
    }
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/messages",
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (claudeReq.stream === false) {
      const body = buildClaudeToolCallResponse(response.toolCalls, completionReq.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildClaudeToolCallStreamEvents(
        response.toolCalls,
        completionReq.model,
        chunkSize,
      );
      await writeClaudeSSEStream(res, events, latency);
    }
    return;
  }

  // Unknown response type
  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/v1/messages",
    headers: {},
    body: completionReq,
    response: { status: 500, fixture },
  });
  writeErrorResponse(
    res,
    500,
    JSON.stringify({
      error: {
        message: "Fixture response did not match any known type",
        type: "server_error",
      },
    }),
  );
}
