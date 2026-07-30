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
  FixtureBlock,
  HandlerDefaults,
  ResponseOverrides,
  StreamingProfile,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  generateId,
  generateToolCallId,
  resolveFixtureBlocks,
  extractOverrides,
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  serializeErrorResponse,
  flattenHeaders,
  getTestId,
  resolveResponse,
  resolveStrictMode,
  resolveReasoningForModel,
  strictOverrideField,
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { isReasoningModel } from "./model-utils.js";
import { matchFixtureDiagnostic, recordMatchOptions } from "./router.js";
import { writeErrorResponse, delay, calculateDelay } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import type { RecordedTimings } from "./types.js";
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
  // Additional output data requested by the caller, e.g.
  // "reasoning.encrypted_content" (gates encrypted-reasoning emission).
  include?: string[];
  // Server-side storage flag. `false` (ZDR / stateless replay) is one of the
  // triggers for encrypted reasoning; see `requestWantsEncryptedReasoning`.
  store?: boolean;
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
  const input = overrides.usage.input_tokens ?? overrides.usage.prompt_tokens ?? 0;
  const output = overrides.usage.output_tokens ?? overrides.usage.completion_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: overrides.usage.total_tokens ?? input + output,
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
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): ResponsesSSEEvent[] {
  const { respId, created, events, prefixOutputItems, nextOutputIndex } = buildResponsePreamble(
    model,
    chunkSize,
    reasoning,
    webSearches,
    overrides,
    emitEncryptedReasoning,
    synthesizeSummarylessReasoning,
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
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): ResponsesSSEEvent[] {
  const { respId, created, events, prefixOutputItems, nextOutputIndex } = buildResponsePreamble(
    model,
    chunkSize,
    reasoning,
    webSearches,
    overrides,
    emitEncryptedReasoning,
    synthesizeSummarylessReasoning,
  );

  const fcOutputItems: object[] = [];

  for (let idx = 0; idx < toolCalls.length; idx++) {
    const tc = toolCalls[idx];
    const callId = tc.id || generateToolCallId();
    const fcId = generateId("fc");
    const outputIndex = nextOutputIndex + idx;

    // output_item.added (function_call)
    events.push({
      type: "response.output_item.added",
      output_index: outputIndex,
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
        output_index: outputIndex,
        delta: slice,
      });
    }

    // function_call_arguments.done
    events.push({
      type: "response.function_call_arguments.done",
      item_id: fcId,
      output_index: outputIndex,
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
      output_index: outputIndex,
      item: doneItem,
    });

    fcOutputItems.push(doneItem);
  }

  // response.completed
  events.push({
    type: "response.completed",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model: overrides?.model ?? model,
      status: responsesStatus(overrides?.finishReason, "completed"),
      output: [...prefixOutputItems, ...fcOutputItems],
      usage: responsesUsage(overrides),
    },
  });

  return events;
}

/**
 * Whether the incoming Responses request should receive encrypted reasoning.
 *
 * Two observed triggers, gated on EITHER:
 *  - `include: ["reasoning.encrypted_content"]` — the explicit opt-in, and what
 *    `agent-framework-openai` >= 1.11.0 auto-appends on its stateless-replay path
 *    (it never sends `store`), so this is the branch that fires for real clients.
 *  - `store: false` — captured responses carry the blob when not server-side
 *    stored (ZDR) and omit it when stored; kept as a secondary trigger for
 *    clients that go stateless without opting in via `include`.
 *
 * Stored / opted-out replays stay byte-identical. Exported so the WebSocket
 * Responses transport can share one gate.
 */
export function requestWantsEncryptedReasoning(req: ResponsesRequest): boolean {
  if (requestIncludesEncryptedReasoning(req)) return true;
  return req.store === false;
}

/**
 * Whether the request carries the EXPLICIT `include` opt-in — a strictly
 * narrower gate than `requestWantsEncryptedReasoning`, which also fires on
 * `store: false`.
 *
 * This is the gate for SYNTHESIZING a reasoning item that the fixture does not
 * declare (see `shouldSynthesizeBlobOnlyReasoning`), and it is deliberately the
 * narrow one. Attaching a field to an item aimock was already emitting is a much
 * smaller step than conjuring a whole output item that did not previously exist,
 * so the larger behavior change gets the gate that is directly observable in the
 * request rather than the inferred `store: false` one. `agent-framework-openai`
 * >= 1.11.0 auto-appends `include` on its stateless-replay path and never sends
 * `store` at all, so the motivating client is fully served by this branch — the
 * narrowing costs the feature nothing.
 *
 * Exported so the WebSocket Responses transport shares one gate.
 */
export function requestIncludesEncryptedReasoning(req: ResponsesRequest): boolean {
  const include = req.include;
  return Array.isArray(include) && include.includes("reasoning.encrypted_content");
}

/**
 * Synthetic stand-in for OpenAI's opaque `reasoning.encrypted_content`. aimock
 * has no real ciphertext; it emits a base64 placeholder derived from the
 * reasoning id (stable for a given item, opaque like the real field). Consumers
 * store it (e.g. as agent-framework `protected_data`) and replay it verbatim;
 * aimock matches on content and ignores the echoed blob. Without it,
 * agent-framework-openai >= 1.11.0 hard-fails a reasoning + multi-tool chain on
 * the follow-up request. See microsoft/agent-framework#7233.
 *
 * aimock skips inbound reasoning items entirely, so it cannot reproduce
 * OpenAI's `invalid_encrypted_content` rejection of a mismatched blob/id — a
 * known replay-only limitation.
 */
function syntheticEncryptedReasoning(reasoningId: string): string {
  return Buffer.from(`aimock-encrypted-reasoning:${reasoningId}`).toString("base64");
}

/**
 * Build a Responses `reasoning` output item. `summaryText` controls the summary
 * (present for the terminal `done` / non-streaming item, omitted for the
 * in-progress `added` item); `emitEncrypted` controls the blob INDEPENDENTLY of
 * the summary, so a blob with an empty summary is expressible. aimock emits the
 * blob only on the terminal item and omits it on `added`: real OpenAI populates
 * `added` opportunistically, but the field is `anyOf: [string, null]` and
 * non-required, so consumers should read it at `done` and treat `added` as
 * best-effort — omitting there is legal and harmless.
 */
function buildReasoningOutputItem(
  reasoningId: string,
  opts: { summaryText?: string; emitEncrypted?: boolean } = {},
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    type: "reasoning",
    id: reasoningId,
    summary:
      opts.summaryText === undefined ? [] : [{ type: "summary_text", text: opts.summaryText }],
  };
  if (opts.emitEncrypted) {
    item.encrypted_content = syntheticEncryptedReasoning(reasoningId);
  }
  return item;
}

/**
 * Whether to synthesize a summary-LESS reasoning item that exists purely to
 * carry the encrypted blob.
 *
 * Every reasoning item aimock emits otherwise originates in a fixture's declared
 * `reasoning` summary text. But a fixture RECORDED from the real stateless
 * agent-framework flow typically has NO summary — OpenAI returns `summary: []`
 * unless summaries are explicitly requested — so keying the item on a declared
 * summary starves the exact flow this feature exists to serve: fully opted in,
 * yet no reasoning item and therefore no blob. Real OpenAI, for a
 * reasoning-capable model, still returns a reasoning item (`summary: []`) with
 * the blob populated. So synthesize one, gated on:
 *
 *  - the EXPLICIT `include` opt-in ONLY (`requestIncludesEncryptedReasoning`),
 *    which is NARROWER than the `requestWantsEncryptedReasoning` gate that
 *    controls the blob itself. A `store: false` request whose fixture declares no
 *    summary therefore gets NO reasoning item, exactly as before this change.
 *    Two reasons: (1) creating an output item that did not previously exist is a
 *    bigger behavior change than adding a field to an item already being
 *    emitted, so it earns the gate that is directly observable in the request
 *    rather than the inferred one; (2) the `store: false` trigger's supporting
 *    capture evidence is not verifiable from this repo, and a larger change must
 *    not be stacked on an unverifiable premise. `agent-framework-openai` >=
 *    1.11.0 sends `include` and never `store`, so nothing is lost.
 *  - the REQUESTED model's reasoning capability (aimock#254) — emitting a
 *    reasoning item for gpt-4o would be LESS faithful, not more, since that
 *    model has no reasoning channel at all. Unlike `resolveReasoningForModel`,
 *    which fails open for a declared summary (a recorded summary is evidence the
 *    model did reason), there is nothing to preserve here: a synthesized item on
 *    a non-reasoning model would be pure fabrication, so this gate is hard.
 *
 * Note this is INDEPENDENT of `emitEncryptedReasoning`: when a fixture DOES
 * declare a summary, the blob still rides on it under either trigger (including
 * `store: false`), unchanged.
 */
function shouldSynthesizeBlobOnlyReasoning(
  reasoning: string | undefined,
  model: string | undefined,
  synthesizeSummarylessReasoning: boolean,
): boolean {
  if (reasoning) return false; // a declared summary already produces the item
  if (!synthesizeSummarylessReasoning) return false; // no explicit `include` opt-in
  return isReasoningModel(model);
}

/**
 * `reasoning` is `undefined` for a synthesized blob-only item (see
 * `shouldSynthesizeBlobOnlyReasoning`). In that case the item's `summary` is
 * `[]`, so the summary-part / summary-text events are SKIPPED entirely — they
 * would describe a part that does not exist on the item — leaving a coherent
 * `output_item.added` → `output_item.done` pair with nothing between.
 */
function buildReasoningStreamEvents(
  reasoning: string | undefined,
  chunkSize: number,
  emitEncryptedReasoning = false,
): ResponsesSSEEvent[] {
  const reasoningId = generateId("rs");
  const events: ResponsesSSEEvent[] = [];

  events.push({
    type: "response.output_item.added",
    output_index: 0,
    item: buildReasoningOutputItem(reasoningId),
  });

  if (reasoning !== undefined) {
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
  }

  events.push({
    type: "response.output_item.done",
    output_index: 0,
    item: buildReasoningOutputItem(reasoningId, {
      summaryText: reasoning,
      emitEncrypted: emitEncryptedReasoning,
    }),
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
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
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

  if (
    reasoning ||
    shouldSynthesizeBlobOnlyReasoning(reasoning, model, synthesizeSummarylessReasoning)
  ) {
    const reasoningEvents = buildReasoningStreamEvents(
      reasoning,
      chunkSize,
      emitEncryptedReasoning,
    );
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

interface FunctionCallBlockResult {
  events: ResponsesSSEEvent[];
  fcItem: object;
}

/**
 * Emit the output_item.added → arguments deltas → arguments.done →
 * output_item.done events for a single function_call at `outputIndex`,
 * returning the completed item for the final `output` array. Behavior is
 * identical to the inline per-tool-call loop in the legacy path; both the
 * legacy branch and the ordered-blocks branch share this so wire output stays
 * byte-identical for a given (tool, outputIndex).
 */
function buildFunctionCallOutputEvents(
  toolCall: ToolCall,
  chunkSize: number,
  outputIndex: number,
): FunctionCallBlockResult {
  const callId = toolCall.id || generateToolCallId();
  const fcId = generateId("fc");
  const args = toolCall.arguments;
  const events: ResponsesSSEEvent[] = [];

  events.push({
    type: "response.output_item.added",
    output_index: outputIndex,
    item: {
      type: "function_call",
      id: fcId,
      call_id: callId,
      name: toolCall.name,
      arguments: "",
      status: "in_progress",
    },
  });

  for (let i = 0; i < args.length; i += chunkSize) {
    events.push({
      type: "response.function_call_arguments.delta",
      item_id: fcId,
      output_index: outputIndex,
      delta: args.slice(i, i + chunkSize),
    });
  }

  events.push({
    type: "response.function_call_arguments.done",
    item_id: fcId,
    output_index: outputIndex,
    arguments: args,
  });

  const fcItem = {
    type: "function_call",
    id: fcId,
    call_id: callId,
    name: toolCall.name,
    arguments: args,
    status: "completed",
  };
  events.push({ type: "response.output_item.done", output_index: outputIndex, item: fcItem });

  return { events, fcItem };
}

// ─── Non-streaming response builders ────────────────────────────────────────

function buildOutputPrefix(
  content: string,
  model: string,
  reasoning?: string,
  webSearches?: string[],
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): object[] {
  const output: object[] = [];

  if (
    reasoning ||
    shouldSynthesizeBlobOnlyReasoning(reasoning, model, synthesizeSummarylessReasoning)
  ) {
    output.push(
      buildReasoningOutputItem(generateId("rs"), {
        summaryText: reasoning,
        emitEncrypted: emitEncryptedReasoning,
      }),
    );
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
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): object {
  return buildResponseEnvelope(
    model,
    buildOutputPrefix(
      content,
      model,
      reasoning,
      webSearches,
      emitEncryptedReasoning,
      synthesizeSummarylessReasoning,
    ),
    overrides,
  );
}

function buildToolCallResponse(
  toolCalls: ToolCall[],
  model: string,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): object {
  const output: object[] = [];
  if (
    reasoning ||
    shouldSynthesizeBlobOnlyReasoning(reasoning, model, synthesizeSummarylessReasoning)
  ) {
    output.push(
      buildReasoningOutputItem(generateId("rs"), {
        summaryText: reasoning,
        emitEncrypted: emitEncryptedReasoning,
      }),
    );
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

export function buildContentWithToolCallsStreamEvents(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
  blocks?: FixtureBlock[],
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): ResponsesSSEEvent[] {
  const { respId, created, events, prefixOutputItems, nextOutputIndex } = buildResponsePreamble(
    model,
    chunkSize,
    reasoning,
    webSearches,
    overrides,
    emitEncryptedReasoning,
    synthesizeSummarylessReasoning,
  );

  // The output items assembled in emission order (after any reasoning /
  // web-search prefix items). Each output_index is assigned sequentially as we
  // walk the chosen item order, so the `output_index` on every emitted event
  // matches that item's slot in the final `response.completed.output` array.
  const orderedOutputItems: object[] = [];

  if (blocks && blocks.length > 0) {
    // NEW PATH: stream items in the fixture's block ARRAY ORDER. A toolCall
    // block placed before a text block therefore yields a function_call item at
    // a LOWER output_index than the message — it leads the output array.
    const ordered = resolveFixtureBlocks(blocks);
    let outputIndex = nextOutputIndex;
    for (const block of ordered) {
      if (block.type === "text") {
        const { events: msgEvents, msgItem } = buildMessageOutputEvents(
          block.text,
          chunkSize,
          outputIndex,
        );
        events.push(...msgEvents);
        orderedOutputItems.push(msgItem);
      } else {
        const { events: fcEvents, fcItem } = buildFunctionCallOutputEvents(
          { name: block.name, arguments: block.arguments, id: block.id },
          chunkSize,
          outputIndex,
        );
        events.push(...fcEvents);
        orderedOutputItems.push(fcItem);
      }
      outputIndex += 1;
    }
  } else {
    // LEGACY PATH: message item first, then function_call items — byte-for-byte
    // unchanged from the pre-blocks behavior (message always leads the output).
    const { events: msgEvents, msgItem } = buildMessageOutputEvents(
      content,
      chunkSize,
      nextOutputIndex,
    );
    events.push(...msgEvents);
    orderedOutputItems.push(msgItem);

    for (let idx = 0; idx < toolCalls.length; idx++) {
      const fcOutputIndex = nextOutputIndex + 1 + idx;
      const { events: fcEvents, fcItem } = buildFunctionCallOutputEvents(
        toolCalls[idx],
        chunkSize,
        fcOutputIndex,
      );
      events.push(...fcEvents);
      orderedOutputItems.push(fcItem);
    }
  }

  events.push({
    type: "response.completed",
    response: {
      id: respId,
      object: "response",
      created_at: created,
      model: overrides?.model ?? model,
      status: responsesStatus(overrides?.finishReason, "completed"),
      output: [...prefixOutputItems, ...orderedOutputItems],
      usage: responsesUsage(overrides),
    },
  });

  return events;
}

function buildFunctionCallOutputItem(tc: { name: string; arguments: string; id?: string }): object {
  return {
    type: "function_call",
    id: generateId("fc"),
    call_id: tc.id || generateToolCallId(),
    name: tc.name,
    arguments: tc.arguments,
    status: "completed",
  };
}

function buildMessageOutputItem(content: string): object {
  return {
    type: "message",
    id: itemId(),
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: content, annotations: [] }],
  };
}

function buildContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
  blocks?: FixtureBlock[],
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): object {
  if (blocks && blocks.length > 0) {
    // NEW PATH: the non-streaming `output[]` array is positionally observable,
    // so emit the prefix (reasoning / web_search_call), then the blocks in
    // fixture ARRAY ORDER. A toolCall block before a text block therefore
    // yields a function_call item ahead of the message — matching the streaming
    // path's ordering for the same `blocks` fixture.
    const ordered = resolveFixtureBlocks(blocks);
    const output: object[] = [];
    if (
      reasoning ||
      shouldSynthesizeBlobOnlyReasoning(reasoning, model, synthesizeSummarylessReasoning)
    ) {
      output.push(
        buildReasoningOutputItem(generateId("rs"), {
          summaryText: reasoning,
          emitEncrypted: emitEncryptedReasoning,
        }),
      );
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
    for (const block of ordered) {
      if (block.type === "text") {
        output.push(buildMessageOutputItem(block.text));
      } else {
        output.push(
          buildFunctionCallOutputItem({
            name: block.name,
            arguments: block.arguments,
            id: block.id,
          }),
        );
      }
    }
    return buildResponseEnvelope(model, output, overrides);
  }

  // LEGACY PATH: message item first, then function_call items — unchanged.
  const output = buildOutputPrefix(
    content,
    model,
    reasoning,
    webSearches,
    emitEncryptedReasoning,
    synthesizeSummarylessReasoning,
  );
  for (const tc of toolCalls) {
    output.push(buildFunctionCallOutputItem(tc));
  }
  return buildResponseEnvelope(model, output, overrides);
}

// ─── SSE writer for Responses API ───────────────────────────────────────────

interface ResponsesStreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
  recordedTimings?: RecordedTimings;
  replaySpeed?: number;
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
  const { recordedTimings, replaySpeed } = opts;
  const signal = opts.signal;
  const onChunkSent = opts.onChunkSent;

  if (res.writableEnded) return true;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let chunkIndex = 0;
  for (const event of events) {
    const chunkDelay = calculateDelay(chunkIndex, profile, latency, recordedTimings, replaySpeed);
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
  completionReq._context = getContext(req);

  // Emit a synthetic `reasoning.encrypted_content` only when the request wants it
  // (opted in via `include`, or stateless `store: false` — mirrors real OpenAI).
  // This is what agent-framework-openai >= 1.11.0 sends on stateless-replay
  // requests; without the blob it hard-fails a reasoning + multi-tool chain.
  // See microsoft/agent-framework#7233.
  const emitEncryptedReasoning = requestWantsEncryptedReasoning(responsesReq);
  // Synthesizing a reasoning item the fixture never declared is a bigger step
  // than adding a field to one already being emitted, so it takes the NARROWER
  // explicit-`include` gate: a `store: false` request with a summary-less fixture
  // keeps emitting no reasoning item at all. See
  // `shouldSynthesizeBlobOnlyReasoning`.
  const synthesizeSummarylessReasoning = requestIncludesEncryptedReasoning(responsesReq);

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
    // Record mode proxies on a miss to capture a fresh turn (see record gate
    // below), so keep turnIndex strict to prevent an earlier-turn fixture from
    // shadowing a longer request and skipping the new turn's recording.
    recordMatchOptions(!!defaults.record, defaults.logger),
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
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    if (effectiveStrict) {
      const strictStatus = 503;
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      defaults.logger.error(
        strictNoMatchLogLine(
          req.method ?? "POST",
          req.url ?? "/v1/responses",
          skippedBySequenceOrTurn,
        ),
      );
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
      if (outcome === "handled_by_hook") return;
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
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      404,
      JSON.stringify({
        error: {
          message: "No fixture matched",
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
  const fixtureTimings = fixture.recordedTimings;
  const effectiveReplaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;

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
    writeErrorResponse(res, status, serializeErrorResponse(response), {
      retryAfter: response.retryAfter,
    });
    return;
  }

  // Combined content + tool calls response
  if (isContentWithToolCallsResponse(response)) {
    const overrides = extractOverrides(response);
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      defaults.logger,
    );
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (responsesReq.stream !== true) {
      const body = buildContentWithToolCallsResponse(
        response.content ?? "",
        response.toolCalls ?? [],
        completionReq.model,
        effReasoning,
        response.webSearches,
        overrides,
        response.blocks,
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildContentWithToolCallsStreamEvents(
        response.content ?? "",
        response.toolCalls ?? [],
        completionReq.model,
        chunkSize,
        effReasoning,
        response.webSearches,
        overrides,
        response.blocks,
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeResponsesSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixtureTimings,
        replaySpeed: effectiveReplaySpeed,
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
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      defaults.logger,
    );
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
        effReasoning,
        response.webSearches,
        overrides,
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildTextStreamEvents(
        response.content,
        completionReq.model,
        chunkSize,
        effReasoning,
        response.webSearches,
        overrides,
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeResponsesSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixtureTimings,
        replaySpeed: effectiveReplaySpeed,
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
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      defaults.logger,
    );
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (responsesReq.stream !== true) {
      const body = buildToolCallResponse(
        response.toolCalls,
        completionReq.model,
        effReasoning,
        response.webSearches,
        overrides,
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildToolCallStreamEvents(
        response.toolCalls,
        completionReq.model,
        chunkSize,
        effReasoning,
        response.webSearches,
        overrides,
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeResponsesSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixtureTimings,
        replaySpeed: effectiveReplaySpeed,
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
