/**
 * OpenAI Responses API support for aimock.
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
  ResponseOverrides,
  StreamingProfile,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  generateId,
  generateToolCallId,
  extractOverrides,
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  flattenHeaders,
  getTestId,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
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
  input: string | ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesToolDef[];
  tool_choice?: string | object;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  response_format?: { type: string; [key: string]: unknown };
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
  // Track item_reference placeholders so we can upgrade or clean them up
  const itemReferencePlaceholders = new WeakSet<ChatMessage>();

  // instructions field → system message
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }

  // The OpenAI Responses API accepts either a plain string or an array of input items.
  // When a string is passed, treat it as a single user message.
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
    return messages;
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
      // Bug 1 fix: If there's no preceding assistant message with a matching
      // tool_call for this call_id, synthesize one. This happens when the AI SDK
      // sends [user, item_reference, function_call_output] — the item_reference
      // placeholder (see below) has no tool_calls, so we need a real assistant
      // message with the tool_call for turnIndex counting.
      const hasMatchingToolCall = messages.some(
        (m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === item.call_id),
      );
      if (!hasMatchingToolCall) {
        // Check if the last message is an item_reference placeholder — if so,
        // upgrade it to carry the tool_call instead of synthesizing a duplicate.
        const lastMsg = messages[messages.length - 1];
        if (
          lastMsg &&
          lastMsg.role === "assistant" &&
          itemReferencePlaceholders.has(lastMsg) &&
          !lastMsg.tool_calls
        ) {
          lastMsg.content = null;
          lastMsg.tool_calls = [
            {
              id: item.call_id ?? generateToolCallId(),
              type: "function",
              function: { name: "", arguments: "" },
            },
          ];
          itemReferencePlaceholders.delete(lastMsg);
        } else {
          // Multi-fco case: look for a recent assistant with tool_calls that
          // belongs to the same turn. After the first fco upgrades a placeholder,
          // subsequent fco's see [assistant(call_A), tool(call_A)] — the last
          // assistant with tool_calls (right before the trailing tool messages)
          // is the correct target.
          let appended = false;
          for (let k = messages.length - 1; k >= 0; k--) {
            const m = messages[k];
            if (m.role === "assistant" && m.tool_calls) {
              m.tool_calls.push({
                id: item.call_id ?? generateToolCallId(),
                type: "function",
                function: { name: "", arguments: "" },
              });
              appended = true;
              break;
            }
            // Stop scanning if we hit a user message — different turn
            if (m.role === "user") break;
          }
          if (!appended) {
            messages.push({
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: item.call_id ?? generateToolCallId(),
                  type: "function",
                  function: { name: "", arguments: "" },
                },
              ],
            });
          }
        }
      }
      messages.push({
        role: "tool",
        content: item.output ?? "",
        tool_call_id: item.call_id,
      });
    } else if (item.type === "item_reference") {
      // Bug 6 fix: item_reference items represent prior assistant turns (text
      // or function_call). Push a placeholder so they count in assistantCount.
      // If a subsequent function_call_output arrives, the handler above will
      // upgrade this placeholder to carry tool_calls (avoiding double-count).
      const placeholder: ChatMessage = { role: "assistant", content: "" };
      itemReferencePlaceholders.add(placeholder);
      messages.push(placeholder);
    } else {
      // Skip local_shell_call, mcp_list_tools, etc. — not needed for fixture
      // matching.
    }
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
    max_tokens: req.max_output_tokens,
    tools: responsesToolsToCompletionsTools(req.tools),
    tool_choice: req.tool_choice,
    response_format: req.response_format,
  };
}

// ─── Response building: fixture → Responses API format ──────────────────────

function responsesStatus(finishReason: string | undefined, defaultStatus: string): string {
  if (!finishReason) return defaultStatus;
  if (finishReason === "stop") return "completed";
  if (finishReason === "tool_calls") return "completed";
  if (finishReason === "length") return "incomplete";
  if (finishReason === "content_filter") return "failed";
  return finishReason;
}

function responsesUsage(overrides?: ResponseOverrides): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  if (!overrides?.usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: overrides.usage.input_tokens ?? 0,
    output_tokens: overrides.usage.output_tokens ?? 0,
    total_tokens:
      overrides.usage.total_tokens ??
      (overrides.usage.input_tokens ?? 0) + (overrides.usage.output_tokens ?? 0),
  };
}

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
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
): ResponsesSSEEvent[] {
  const { respId, created, events, prefixOutputItems, nextOutputIndex } = buildResponsePreamble(
    model,
    chunkSize,
    reasoning,
    webSearches,
    overrides,
  );

  const { events: msgEvents, msgItem } = buildMessageOutputEvents(
    content,
    chunkSize,
    nextOutputIndex,
  );
  events.push(...msgEvents);

  events.push({
    type: "response.completed",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model: overrides?.model ?? model,
      status: responsesStatus(overrides?.finishReason, "completed"),
      output: [...prefixOutputItems, msgItem],
      usage: responsesUsage(overrides),
    },
  });

  return events;
}

export function buildToolCallStreamEvents(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  overrides?: ResponseOverrides,
): ResponsesSSEEvent[] {
  const respId = overrides?.id ?? responseId();
  const created = overrides?.created ?? Math.floor(Date.now() / 1000);
  const effectiveModel = overrides?.model ?? model;
  const events: ResponsesSSEEvent[] = [];

  // response.created
  events.push({
    type: "response.created",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model: effectiveModel,
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
      model: effectiveModel,
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
      item_id: fcId,
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
      model: effectiveModel,
      status: responsesStatus(overrides?.finishReason, "completed"),
      output: outputItems,
      usage: responsesUsage(overrides),
    },
  });

  return events;
}

function buildReasoningStreamEvents(
  reasoning: string,
  model: string,
  chunkSize: number,
): ResponsesSSEEvent[] {
  const reasoningId = generateId("rs");
  const events: ResponsesSSEEvent[] = [];

  events.push({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "reasoning",
      id: reasoningId,
      summary: [],
    },
  });

  events.push({
    type: "response.reasoning_summary_part.added",
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    part: { type: "summary_text", text: "" },
  });

  for (let i = 0; i < reasoning.length; i += chunkSize) {
    const slice = reasoning.slice(i, i + chunkSize);
    events.push({
      type: "response.reasoning_summary_text.delta",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      delta: slice,
    });
  }

  events.push({
    type: "response.reasoning_summary_text.done",
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    text: reasoning,
  });

  events.push({
    type: "response.reasoning_summary_part.done",
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    part: { type: "summary_text", text: reasoning },
  });

  events.push({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "reasoning",
      id: reasoningId,
      summary: [{ type: "summary_text", text: reasoning }],
    },
  });

  return events;
}

function buildWebSearchStreamEvents(
  queries: string[],
  startOutputIndex: number,
): ResponsesSSEEvent[] {
  const events: ResponsesSSEEvent[] = [];

  for (let i = 0; i < queries.length; i++) {
    const searchId = generateId("ws");
    const outputIndex = startOutputIndex + i;

    events.push({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "web_search_call",
        id: searchId,
        status: "in_progress",
        action: { type: "search", query: queries[i] },
      },
    });

    events.push({
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "web_search_call",
        id: searchId,
        status: "completed",
        action: { type: "search", query: queries[i] },
      },
    });
  }

  return events;
}

// ─── Shared streaming helpers ────────────────────────────────────────────────

interface PreambleResult {
  respId: string;
  created: number;
  events: ResponsesSSEEvent[];
  prefixOutputItems: object[];
  nextOutputIndex: number;
}

function buildResponsePreamble(
  model: string,
  chunkSize: number,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
): PreambleResult {
  const respId = overrides?.id ?? responseId();
  const created = overrides?.created ?? Math.floor(Date.now() / 1000);
  const effectiveModel = overrides?.model ?? model;
  const events: ResponsesSSEEvent[] = [];
  const prefixOutputItems: object[] = [];
  let nextOutputIndex = 0;

  events.push({
    type: "response.created",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model: effectiveModel,
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
      model: effectiveModel,
      status: "in_progress",
      output: [],
    },
  });

  if (reasoning) {
    const reasoningEvents = buildReasoningStreamEvents(reasoning, model, chunkSize);
    events.push(...reasoningEvents);
    const doneEvent = reasoningEvents.find(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as { type: string })?.type === "reasoning",
    );
    if (doneEvent) prefixOutputItems.push(doneEvent.item as object);
    nextOutputIndex++;
  }

  if (webSearches && webSearches.length > 0) {
    const searchEvents = buildWebSearchStreamEvents(webSearches, nextOutputIndex);
    events.push(...searchEvents);
    const doneEvents = searchEvents.filter(
      (e) =>
        e.type === "response.output_item.done" &&
        (e.item as { type: string })?.type === "web_search_call",
    );
    for (const de of doneEvents) prefixOutputItems.push(de.item as object);
    nextOutputIndex += webSearches.length;
  }

  return { respId, created, events, prefixOutputItems, nextOutputIndex };
}

interface MessageBlockResult {
  events: ResponsesSSEEvent[];
  msgItem: object;
}

function buildMessageOutputEvents(
  content: string,
  chunkSize: number,
  outputIndex: number,
): MessageBlockResult {
  const msgId = itemId();
  const events: ResponsesSSEEvent[] = [];

  events.push({
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { type: "message", id: msgId, status: "in_progress", role: "assistant", content: [] },
  });
  events.push({
    type: "response.content_part.added",
    item_id: msgId,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });

  for (let i = 0; i < content.length; i += chunkSize) {
    events.push({
      type: "response.output_text.delta",
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      delta: content.slice(i, i + chunkSize),
    });
  }

  events.push({
    type: "response.output_text.done",
    item_id: msgId,
    output_index: outputIndex,
    content_index: 0,
    text: content,
  });
  events.push({
    type: "response.content_part.done",
    item_id: msgId,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: content, annotations: [] },
  });

  const msgItem = {
    type: "message",
    id: msgId,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: content, annotations: [] }],
  };

  events.push({ type: "response.output_item.done", output_index: outputIndex, item: msgItem });

  return { events, msgItem };
}

// ─── Non-streaming response builders ────────────────────────────────────────

function buildOutputPrefix(content: string, reasoning?: string, webSearches?: string[]): object[] {
  const output: object[] = [];

  if (reasoning) {
    output.push({
      type: "reasoning",
      id: generateId("rs"),
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }

  if (webSearches && webSearches.length > 0) {
    for (const query of webSearches) {
      output.push({
        type: "web_search_call",
        id: generateId("ws"),
        status: "completed",
        action: { type: "search", query },
      });
    }
  }

  output.push({
    type: "message",
    id: itemId(),
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: content, annotations: [] }],
  });

  return output;
}

function buildResponseEnvelope(
  model: string,
  output: object[],
  overrides?: ResponseOverrides,
): object {
  return {
    id: overrides?.id ?? responseId(),
    object: "response",
    created_at: overrides?.created ?? Math.floor(Date.now() / 1000),
    model: overrides?.model ?? model,
    status: responsesStatus(overrides?.finishReason, "completed"),
    output,
    usage: responsesUsage(overrides),
  };
}

function buildTextResponse(
  content: string,
  model: string,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
): object {
  return buildResponseEnvelope(
    model,
    buildOutputPrefix(content, reasoning, webSearches),
    overrides,
  );
}

function buildToolCallResponse(
  toolCalls: ToolCall[],
  model: string,
  overrides?: ResponseOverrides,
): object {
  return buildResponseEnvelope(
    model,
    toolCalls.map((tc) => ({
      type: "function_call",
      id: generateId("fc"),
      call_id: tc.id || generateToolCallId(),
      name: tc.name,
      arguments: tc.arguments,
      status: "completed",
    })),
    overrides,
  );
}

export function buildContentWithToolCallsStreamEvents(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
): ResponsesSSEEvent[] {
  const { respId, created, events, prefixOutputItems, nextOutputIndex } = buildResponsePreamble(
    model,
    chunkSize,
    reasoning,
    webSearches,
    overrides,
  );

  const { events: msgEvents, msgItem } = buildMessageOutputEvents(
    content,
    chunkSize,
    nextOutputIndex,
  );
  events.push(...msgEvents);

  const fcOutputItems: object[] = [];
  for (let idx = 0; idx < toolCalls.length; idx++) {
    const tc = toolCalls[idx];
    const callId = tc.id || generateToolCallId();
    const fcId = generateId("fc");
    const fcOutputIndex = nextOutputIndex + 1 + idx;
    const args = tc.arguments;

    events.push({
      type: "response.output_item.added",
      output_index: fcOutputIndex,
      item: {
        type: "function_call",
        id: fcId,
        call_id: callId,
        name: tc.name,
        arguments: "",
        status: "in_progress",
      },
    });

    for (let i = 0; i < args.length; i += chunkSize) {
      events.push({
        type: "response.function_call_arguments.delta",
        item_id: fcId,
        output_index: fcOutputIndex,
        delta: args.slice(i, i + chunkSize),
      });
    }

    events.push({
      type: "response.function_call_arguments.done",
      item_id: fcId,
      output_index: fcOutputIndex,
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
    events.push({ type: "response.output_item.done", output_index: fcOutputIndex, item: doneItem });
    fcOutputItems.push(doneItem);
  }

  events.push({
    type: "response.completed",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model: overrides?.model ?? model,
      status: responsesStatus(overrides?.finishReason, "completed"),
      output: [...prefixOutputItems, msgItem, ...fcOutputItems],
      usage: responsesUsage(overrides),
    },
  });

  return events;
}

function buildContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
): object {
  const output = buildOutputPrefix(content, reasoning, webSearches);
  for (const tc of toolCalls) {
    output.push({
      type: "function_call",
      id: generateId("fc"),
      call_id: tc.id || generateToolCallId(),
      name: tc.name,
      arguments: tc.arguments,
      status: "completed",
    });
  }
  return buildResponseEnvelope(model, output, overrides);
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
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: `Malformed JSON: ${detail}`,
          type: "invalid_request_error",
          code: "invalid_json",
        },
      }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = responsesToCompletionRequest(responsesReq);
  completionReq._endpointType = "chat";

  const testId = getTestId(req);
  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    defaults.logger.debug(
      `Responses fixture matched for ${req.method ?? "POST"} ${req.url ?? "/v1/responses"}`,
    );
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  } else {
    defaults.logger.debug(
      `No responses fixture matched for ${req.method ?? "POST"} ${req.url ?? "/v1/responses"}`,
    );
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
      fixture ? "fixture" : "proxy",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        completionReq,
        "openai",
        req.url ?? "/v1/responses",
        fixtures,
        defaults,
        raw,
      );
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: req.url ?? "/v1/responses",
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const strictStatus = effectiveStrict ? 503 : 404;
    const strictMessage = effectiveStrict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (effectiveStrict) {
      defaults.logger.error(
        `STRICT: No fixture matched for ${req.method ?? "POST"} ${req.url ?? "/v1/responses"}`,
      );
    }
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: {
        status: strictStatus,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
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

  const response = await resolveResponse(fixture, completionReq);
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

  // Combined content + tool calls response
  if (isContentWithToolCallsResponse(response)) {
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (responsesReq.stream !== true) {
      const body = buildContentWithToolCallsResponse(
        response.content,
        response.toolCalls,
        completionReq.model,
        response.reasoning,
        response.webSearches,
        overrides,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildContentWithToolCallsStreamEvents(
        response.content,
        response.toolCalls,
        completionReq.model,
        chunkSize,
        response.reasoning,
        response.webSearches,
        overrides,
      );
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

  // Text response
  if (isTextResponse(response)) {
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (responsesReq.stream !== true) {
      const body = buildTextResponse(
        response.content,
        completionReq.model,
        response.reasoning,
        response.webSearches,
        overrides,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildTextStreamEvents(
        response.content,
        completionReq.model,
        chunkSize,
        response.reasoning,
        response.webSearches,
        overrides,
      );
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
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (responsesReq.stream !== true) {
      const body = buildToolCallResponse(response.toolCalls, completionReq.model, overrides);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildToolCallStreamEvents(
        response.toolCalls,
        completionReq.model,
        chunkSize,
        overrides,
      );
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
