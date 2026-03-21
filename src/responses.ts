/**
 * OpenAI Responses API support for LLMock.
 *
 * Translates incoming /v1/responses requests into the ChatCompletionRequest
 * format used by the fixture router, and converts fixture responses back into
 * the Responses API streaming (or non-streaming) format expected by @ai-sdk/openai.
 */

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  HandlerDefaults,
  StreamingProfile,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  generateId,
  generateToolCallId,
  isTextResponse,
  isToolCallResponse,
  isErrorResponse,
  flattenHeaders,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse, delay, calculateDelay } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Responses API request types ────────────────────────────────────────────

interface ResponsesInputItem {
  role?: string;
  type?: string;
  content?: string | ResponsesContentPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  id?: string;
}

interface ResponsesContentPart {
  type: string;
  text?: string;
}

interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesToolDef[];
  tool_choice?: string | object;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  [key: string]: unknown;
}

interface ResponsesToolDef {
  type: "function";
  name: string;
  description?: string;
  parameters?: object;
  strict?: boolean;
}

// ─── Input conversion: Responses → ChatCompletions messages ─────────────────

function extractTextContent(content: string | ResponsesContentPart[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "input_text" || p.type === "output_text")
    .map((p) => p.text ?? "")
    .join("");
}

export function responsesInputToMessages(req: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // instructions field → system message
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }

  for (const item of req.input) {
    if (item.role === "system" || item.role === "developer") {
      messages.push({ role: "system", content: extractTextContent(item.content) });
    } else if (item.role === "user") {
      messages.push({ role: "user", content: extractTextContent(item.content) });
    } else if (item.role === "assistant") {
      messages.push({ role: "assistant", content: extractTextContent(item.content) });
    } else if (item.type === "function_call") {
      // Previous assistant tool call — emit as assistant message with tool_calls
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? generateToolCallId(),
            type: "function",
            function: { name: item.name ?? "", arguments: item.arguments ?? "" },
          },
        ],
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        content: item.output ?? "",
        tool_call_id: item.call_id,
      });
    }
    // Skip item_reference, local_shell_call, etc. — not needed for fixture matching
  }

  return messages;
}

function responsesToolsToCompletionsTools(
  tools?: ResponsesToolDef[],
): ToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

export function responsesToCompletionRequest(req: ResponsesRequest): ChatCompletionRequest {
  return {
    model: req.model,
    messages: responsesInputToMessages(req),
    stream: req.stream,
    temperature: req.temperature,
    tools: responsesToolsToCompletionsTools(req.tools),
    tool_choice: req.tool_choice,
  };
}

// ─── Response building: fixture → Responses API format ──────────────────────

function responseId(): string {
  return generateId("resp");
}

function itemId(): string {
  return generateId("msg");
}

// Streaming events for Responses API

export interface ResponsesSSEEvent {
  type: string;
  [key: string]: unknown;
}

export function buildTextStreamEvents(
  content: string,
  model: string,
  chunkSize: number,
): ResponsesSSEEvent[] {
  const respId = responseId();
  const msgId = itemId();
  const created = Math.floor(Date.now() / 1000);
  const events: ResponsesSSEEvent[] = [];

  // response.created
  events.push({
    type: "response.created",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model,
      status: "in_progress",
      output: [],
    },
  });

  // response.in_progress
  events.push({
    type: "response.in_progress",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model,
      status: "in_progress",
      output: [],
    },
  });

  // output_item.added (message)
  events.push({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "message",
      id: msgId,
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  });

  // content_part.added
  events.push({
    type: "response.content_part.added",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  // text deltas
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    events.push({
      type: "response.output_text.delta",
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      delta: slice,
    });
  }

  // output_text.done
  events.push({
    type: "response.output_text.done",
    output_index: 0,
    content_index: 0,
    text: content,
  });

  // content_part.done
  events.push({
    type: "response.content_part.done",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: content },
  });

  // output_item.done
  events.push({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      id: msgId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content }],
    },
  });

  // response.completed
  events.push({
    type: "response.completed",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model,
      status: "completed",
      output: [
        {
          type: "message",
          id: msgId,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: content }],
        },
      ],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    },
  });

  return events;
}

export function buildToolCallStreamEvents(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
): ResponsesSSEEvent[] {
  const respId = responseId();
  const created = Math.floor(Date.now() / 1000);
  const events: ResponsesSSEEvent[] = [];

  // response.created
  events.push({
    type: "response.created",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model,
      status: "in_progress",
      output: [],
    },
  });

  events.push({
    type: "response.in_progress",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model,
      status: "in_progress",
      output: [],
    },
  });

  const outputItems: object[] = [];

  for (let idx = 0; idx < toolCalls.length; idx++) {
    const tc = toolCalls[idx];
    const callId = tc.id || generateToolCallId();
    const fcId = generateId("fc");

    // output_item.added (function_call)
    events.push({
      type: "response.output_item.added",
      output_index: idx,
      item: {
        type: "function_call",
        id: fcId,
        call_id: callId,
        name: tc.name,
        arguments: "",
        status: "in_progress",
      },
    });

    // function_call_arguments.delta
    const args = tc.arguments;
    for (let i = 0; i < args.length; i += chunkSize) {
      const slice = args.slice(i, i + chunkSize);
      events.push({
        type: "response.function_call_arguments.delta",
        item_id: fcId,
        output_index: idx,
        delta: slice,
      });
    }

    // function_call_arguments.done
    events.push({
      type: "response.function_call_arguments.done",
      output_index: idx,
      arguments: args,
    });

    const doneItem = {
      type: "function_call",
      id: fcId,
      call_id: callId,
      name: tc.name,
      arguments: args,
      status: "completed",
    };

    // output_item.done
    events.push({
      type: "response.output_item.done",
      output_index: idx,
      item: doneItem,
    });

    outputItems.push(doneItem);
  }

  // response.completed
  events.push({
    type: "response.completed",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model,
      status: "completed",
      output: outputItems,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    },
  });

  return events;
}

// Non-streaming response builders

function buildTextResponse(content: string, model: string): object {
  const respId = responseId();
  const msgId = itemId();
  return {
    id: respId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [
      {
        type: "message",
        id: msgId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: content }],
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function buildToolCallResponse(toolCalls: ToolCall[], model: string): object {
  const respId = responseId();
  return {
    id: respId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: toolCalls.map((tc) => ({
      type: "function_call",
      id: generateId("fc"),
      call_id: tc.id || generateToolCallId(),
      name: tc.name,
      arguments: tc.arguments,
      status: "completed",
    })),
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

// ─── SSE writer for Responses API ───────────────────────────────────────────

interface ResponsesStreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
  signal?: AbortSignal;
  onChunkSent?: () => void;
}

async function writeResponsesSSEStream(
  res: http.ServerResponse,
  events: ResponsesSSEEvent[],
  optionsOrLatency?: number | ResponsesStreamOptions,
): Promise<boolean> {
  const opts: ResponsesStreamOptions =
    typeof optionsOrLatency === "number" ? { latency: optionsOrLatency } : (optionsOrLatency ?? {});
  const latency = opts.latency ?? 0;
  const profile = opts.streamingProfile;
  const signal = opts.signal;
  const onChunkSent = opts.onChunkSent;

  if (res.writableEnded) return true;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let chunkIndex = 0;
  for (const event of events) {
    const chunkDelay = calculateDelay(chunkIndex, profile, latency);
    if (chunkDelay > 0) await delay(chunkDelay, signal);
    if (signal?.aborted) return false;
    if (res.writableEnded) return true;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    onChunkSent?.();
    if (signal?.aborted) return false;
    chunkIndex++;
  }

  if (!res.writableEnded) {
    res.end();
  }
  return true;
}

// ─── Request handler ────────────────────────────────────────────────────────

export async function handleResponses(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  setCorsHeaders(res);

  let responsesReq: ResponsesRequest;
  try {
    responsesReq = JSON.parse(raw) as ResponsesRequest;
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: {} as ChatCompletionRequest,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: { message: "Malformed JSON", type: "invalid_request_error", code: "invalid_json" },
      }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = responsesToCompletionRequest(responsesReq);

  const fixture = matchFixture(fixtures, completionReq, journal.fixtureMatchCounts);

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      {
        method: req.method ?? "POST",
        path: req.url ?? "/v1/responses",
        headers: flattenHeaders(req.headers),
        body: completionReq,
      },
      defaults.registry,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      const proxied = await proxyAndRecord(
        req,
        res,
        completionReq,
        "openai",
        req.url ?? "/v1/responses",
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
        journal.add({
          method: req.method ?? "POST",
          path: req.url ?? "/v1/responses",
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null },
        });
        return;
      }
    }
    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (defaults.strict) {
      defaults.logger.error(
        `STRICT: No fixture matched for ${req.method ?? "POST"} ${req.url ?? "/v1/responses"}`,
      );
    }
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: strictStatus, fixture: null },
    });
    writeErrorResponse(
      res,
      strictStatus,
      JSON.stringify({
        error: {
          message: strictMessage,
          type: "invalid_request_error",
          code: "no_fixture_match",
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
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (responsesReq.stream !== true) {
      const body = buildTextResponse(response.content, completionReq.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildTextStreamEvents(response.content, completionReq.model, chunkSize);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeResponsesSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
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
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (responsesReq.stream !== true) {
      const body = buildToolCallResponse(response.toolCalls, completionReq.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildToolCallStreamEvents(response.toolCalls, completionReq.model, chunkSize);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeResponsesSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
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

  // Unknown response type
  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/v1/responses",
    headers: flattenHeaders(req.headers),
    body: completionReq,
    response: { status: 500, fixture },
  });
  writeErrorResponse(
    res,
    500,
    JSON.stringify({
      error: { message: "Fixture response did not match any known type", type: "server_error" },
    }),
  );
}
