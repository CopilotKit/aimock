/**
 * OpenAI Responses API support for aimock.
 *
 * Translates incoming /v1/responses requests into the ChatCompletionRequest
 * format used by the fixture router, and converts fixture responses back into
 * the Responses API streaming (or non-streaming) format expected by @ai-sdk/openai.
 */

import type * as http from "node:http";
import { randomBytes } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatMessage,
  ContentPart,
  CustomToolCall,
  CustomToolDefinition,
  Fixture,
  FixtureBlock,
  FixtureToolCall,
  HandlerDefaults,
  ResponseOverrides,
  ResponsesFixtureBlock,
  StreamingProfile,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import type { Logger } from "./logger.js";
import {
  generateId,
  generateToolCallId,
  resolveFixtureBlocks,
  assertResponsesToolCalls,
  extractOverrides,
  isTextResponse,
  isToolCallResponse,
  isCombinedFixtureResponse,
  isErrorResponse,
  serializeErrorResponse,
  flattenHeaders,
  isJsonObject,
  getTestId,
  resolveResponse,
  resolveStrictMode,
  resolveReasoningForModel,
  strictOverrideField,
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
  prepareOpenAIChatMisbehavior,
  resolveOpenAIChatMisbehaviorUsage,
  assertCustomToolCalls,
  resolveServedBlockOutcome,
  servedToolCalls,
  toolCallFixtureBlock,
  withoutLegacyNamespaces,
} from "./helpers.js";
import type { MisbehaviorPlan } from "./misbehavior.js";
import { isReasoningModel } from "./model-utils.js";
import { matchFixtureDiagnostic, recordMatchOptions, setResponsesOfferedTools } from "./router.js";
import { writeErrorResponse, delay, calculateDelay } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import type { RecordedTimings } from "./types.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";
import { planMisbehavior, recordMisbehaviorOutcome } from "./misbehavior.js";

// ─── Responses API request types ────────────────────────────────────────────

export interface ResponsesInputItem {
  role?: string;
  type?: string;
  content?: string | ResponsesContentPart[];
  call_id?: string;
  name?: string;
  /** `function_call` / `custom_tool_call`: the namespace of the called tool. */
  namespace?: string;
  arguments?: string;
  /** `custom_tool_call`: the free-text input. */
  input?: string;
  /** `function_call_output` / `custom_tool_call_output`: a string or content parts. */
  output?: string | ResponsesContentPart[];
  /** `additional_tools` / `tool_search_output`: tools made available at this item. */
  tools?: ResponsesToolDef[];
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

interface ResponsesFunctionToolDef {
  type: "function";
  name: string;
  description?: string;
  parameters?: object;
  strict?: boolean;
}

interface ResponsesCustomToolDef {
  type: "custom";
  name: string;
  description?: string;
  format?: unknown;
}

interface ResponsesNamespaceToolDef {
  type: "namespace";
  name: string;
  description?: string;
  tools: Array<ResponsesFunctionToolDef | ResponsesCustomToolDef>;
}

/**
 * A Responses request tool. `function`, `custom` and `namespace` tools are
 * flattened for matching; any other tool type is accepted and ignored.
 */
export type ResponsesToolDef =
  | ResponsesFunctionToolDef
  | ResponsesCustomToolDef
  | ResponsesNamespaceToolDef
  | { type: string; name?: string; [key: string]: unknown };

// ─── Input conversion: Responses → ChatCompletions messages ─────────────────

function extractTextContent(content: string | ResponsesContentPart[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "input_text" || p.type === "output_text")
    .map((p) => p.text ?? "")
    .join("");
}

/**
 * A `custom_tool_call_output.output` is a string or a list of content parts
 * (`input_text` / `input_image` / `input_file`). Flatten a list to its
 * concatenated `input_text` text so text matchers such as
 * `toolResultContains` see it.
 *
 * The value comes straight from the request body, so it is read as `unknown`.
 * Like `function_call_output`, a malformed output never fails the request:
 * any other value (null, an object, a number) yields empty text, and list
 * entries that are not `input_text` parts with string text are skipped.
 */
function customToolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .map((p: unknown) => {
      if (p === null || typeof p !== "object") return "";
      const part = p as { type?: unknown; text?: unknown };
      return part.type === "input_text" && typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

/** Options for converting a Responses request into the router's request shape. */
export interface ResponsesConversionOptions {
  /**
   * `responsesTools: "extended"`: count custom tool call history, keep history
   * namespaces, and offer namespaced, custom and `additional_tools` /
   * `tool_search_output` tools to `toolName` and predicates. Default false:
   * the conversion of earlier releases.
   */
  extended?: boolean;
  /** Receives one warning per malformed tool item dropped in extended mode. */
  logger?: Logger;
}

/**
 * Convert Responses input items into chat messages for fixture matching. The
 * default is the conversion of earlier releases: `custom_tool_call` and
 * `custom_tool_call_output` items are skipped, and history namespaces are not
 * kept. With `extended`, a custom tool call becomes an assistant message with
 * `custom_tool_calls` (so turn counting sees it), its output becomes a `tool`
 * message (so `hasToolResult` and `toolCallId` see it), and a `function_call`
 * keeps its `namespace`.
 */
export function responsesInputToMessages(req: ResponsesRequest, extended = false): ChatMessage[] {
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

  /** A synthesized call for an output item that has no matching call. */
  const attachSynthesizedCall = (target: ChatMessage, item: ResponsesInputItem): void => {
    const id = item.call_id ?? generateToolCallId();
    if (item.type === "custom_tool_call_output") {
      (target.custom_tool_calls ??= []).push({ id, type: "custom", name: "", input: "" });
    } else {
      (target.tool_calls ??= []).push({
        id,
        type: "function",
        function: { name: "", arguments: "" },
      });
    }
  };
  const hasCalls = (m: ChatMessage): boolean =>
    m.tool_calls !== undefined || m.custom_tool_calls !== undefined;

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
            ...(extended && typeof item.namespace === "string"
              ? { namespace: item.namespace }
              : {}),
            function: { name: item.name ?? "", arguments: item.arguments ?? "" },
          },
        ],
      });
    } else if (extended && item.type === "custom_tool_call") {
      // Previous assistant custom tool call. The pushed assistant message makes
      // turn counting see the call. A non-string input (malformed history)
      // becomes "", the same coercion customToolOutputText applies to a
      // custom output.
      messages.push({
        role: "assistant",
        content: null,
        custom_tool_calls: [
          {
            id: item.call_id ?? generateToolCallId(),
            type: "custom",
            name: item.name ?? "",
            input: typeof item.input === "string" ? item.input : "",
            ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
          },
        ],
      });
    } else if (
      item.type === "function_call_output" ||
      (extended && item.type === "custom_tool_call_output")
    ) {
      // Bug 1 fix: If there's no preceding assistant message with a matching
      // tool_call for this call_id, synthesize one. This happens when the AI SDK
      // sends [user, item_reference, function_call_output] — the item_reference
      // placeholder (see below) has no tool_calls, so we need a real assistant
      // message with the tool_call for turnIndex counting. In extended mode a
      // custom_tool_call_output is handled the same way, and its synthesized
      // call is a custom one.
      const hasMatchingToolCall = messages.some(
        (m) =>
          m.role === "assistant" &&
          (m.tool_calls?.some((tc) => tc.id === item.call_id) ||
            m.custom_tool_calls?.some((tc) => tc.id === item.call_id)),
      );
      if (!hasMatchingToolCall) {
        // Check if the last message is an item_reference placeholder — if so,
        // upgrade it to carry the tool_call instead of synthesizing a duplicate.
        const lastMsg = messages[messages.length - 1];
        if (
          lastMsg &&
          lastMsg.role === "assistant" &&
          itemReferencePlaceholders.has(lastMsg) &&
          !hasCalls(lastMsg)
        ) {
          lastMsg.content = null;
          attachSynthesizedCall(lastMsg, item);
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
            if (m.role === "assistant" && hasCalls(m)) {
              attachSynthesizedCall(m, item);
              appended = true;
              break;
            }
            // Stop scanning if we hit a user message — different turn
            if (m.role === "user") break;
          }
          if (!appended) {
            const synthesized: ChatMessage = { role: "assistant", content: null };
            attachSynthesizedCall(synthesized, item);
            messages.push(synthesized);
          }
        }
      }
      messages.push({
        role: "tool",
        content:
          item.type === "custom_tool_call_output"
            ? customToolOutputText(item.output)
            : // function_call_output keeps its handling from earlier releases:
              // an array output passes through as content parts, so text
              // matchers do not see it.
              ((item.output ?? "") as string | ContentPart[]),
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
      // matching. Without extended mode this includes custom tool call items.
    }
  }

  return messages;
}

/** The request tools of earlier releases: top-level `function` tools only. */
function responsesToolsToCompletionsTools(
  tools?: ResponsesToolDef[],
): ToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name as string,
        description: t.description as string | undefined,
        parameters: (t as { parameters?: object }).parameters,
      },
    }));
}

/** One Responses `function` or `custom` tool in aimock's normalized form. */
function normalizeResponsesTool(
  tool: unknown,
  namespace?: string,
): ToolDefinition | CustomToolDefinition | undefined {
  if (tool === null || typeof tool !== "object") return undefined;
  const t = tool as Record<string, unknown>;
  const ns = namespace !== undefined ? { namespace } : {};
  if (t.type === "function") {
    const fn = t as unknown as ResponsesFunctionToolDef;
    return {
      type: "function",
      ...ns,
      function: {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      },
    };
  }
  if (t.type === "custom") {
    const custom = t as unknown as ResponsesCustomToolDef;
    return {
      type: "custom",
      name: custom.name,
      ...(custom.description !== undefined ? { description: custom.description } : {}),
      ...ns,
      ...(custom.format !== undefined ? { format: custom.format } : {}),
    };
  }
  return undefined;
}

/**
 * Input items whose `tools` add to the request's tools:
 * `additional_tools` (Codex responses-lite) and `tool_search_output` (tools
 * loaded by tool search, e.g. Codex's deferred MCP namespaces). Both carry the
 * same function / custom / namespace tool shapes as `req.tools`.
 */
function isToolCarryingItemType(type: unknown): boolean {
  return type === "additional_tools" || type === "tool_search_output";
}

/**
 * Why a `namespace` tool cannot be flattened, or undefined when it can: its
 * name is not a non-empty string (OpenAI's `NamespaceToolParam` requires
 * `name` with `minLength: 1`), or its `tools` is not an array.
 */
function namespaceToolProblem(tool: { name?: unknown; tools?: unknown }): string | undefined {
  if (typeof tool.name !== "string" || tool.name === "") return "name is not a non-empty string";
  if (!Array.isArray(tool.tools)) return "tools is not an array";
  return undefined;
}

/**
 * Flatten every Responses tool a request offers, for extended matching and for
 * `toolNamespace`. Sources, in order: `req.tools`, then the `tools` of every
 * `additional_tools` or `tool_search_output` input item, in input order.
 * `namespace` tools contribute one entry per inner function/custom tool, each
 * carrying the namespace; other tool types are ignored.
 *
 * Malformed items never fail the request (earlier releases ignored them): a
 * `namespace` tool without a non-empty string name or with a non-array
 * `tools`, a `null` entry, and a tool-carrying item whose `tools` is not an
 * array are dropped, with a warning when `warn` is given.
 */
function flattenResponsesTools(
  req: ResponsesRequest,
  warn?: (message: string) => void,
): { tools: ToolDefinition[]; customTools: CustomToolDefinition[]; sourceCount: number } {
  const tools: ToolDefinition[] = [];
  const customTools: CustomToolDefinition[] = [];
  const add = (normalized: ToolDefinition | CustomToolDefinition | undefined) => {
    if (!normalized) return;
    if (normalized.type === "custom") customTools.push(normalized);
    else tools.push(normalized);
  };
  const sources: Array<{ tool: unknown; path: string }> = [];
  if (Array.isArray(req.tools)) {
    req.tools.forEach((tool, i) => sources.push({ tool, path: `tools[${i}]` }));
  }
  if (Array.isArray(req.input)) {
    req.input.forEach((item, i) => {
      if (!isToolCarryingItemType(item?.type) || item?.tools === undefined) return;
      if (!Array.isArray(item.tools)) {
        warn?.(`Ignoring input[${i}].tools: not an array`);
        return;
      }
      item.tools.forEach((tool, j) => sources.push({ tool, path: `input[${i}].tools[${j}]` }));
    });
  }
  for (const { tool, path } of sources) {
    const t = tool as { type?: unknown; name?: unknown; tools?: unknown } | null;
    if (t === null) {
      warn?.(`Ignoring ${path}: null tool`);
      continue;
    }
    if (t?.type === "namespace") {
      const problem = namespaceToolProblem(t);
      if (problem) {
        warn?.(`Ignoring namespace tool ${path}: ${problem}`);
        continue;
      }
      (t.tools as unknown[]).forEach((inner, k) => {
        if (inner === null) warn?.(`Ignoring ${path}.tools[${k}]: null tool`);
        else add(normalizeResponsesTool(inner, t.name as string));
      });
      continue;
    }
    add(normalizeResponsesTool(tool));
  }
  return { tools, customTools, sourceCount: sources.length };
}

export function responsesToCompletionRequest(
  req: ResponsesRequest,
  options: ResponsesConversionOptions = {},
): ChatCompletionRequest {
  const extended = options.extended === true;
  const all = flattenResponsesTools(
    req,
    extended && options.logger
      ? (message) => options.logger?.warn(`Responses request: ${message}`)
      : undefined,
  );
  const completionReq: ChatCompletionRequest = {
    model: req.model,
    messages: responsesInputToMessages(req, extended),
    stream: req.stream,
    temperature: req.temperature,
    max_tokens: req.max_output_tokens,
    tools: extended
      ? all.sourceCount > 0
        ? all.tools
        : undefined
      : responsesToolsToCompletionsTools(req.tools),
    ...(extended && all.customTools.length > 0 ? { customTools: all.customTools } : {}),
    tool_choice: req.tool_choice,
    response_format: req.response_format,
  };
  setResponsesOfferedTools(completionReq, { tools: all.tools, customTools: all.customTools });
  return completionReq;
}

/**
 * The HTTP request check of earlier releases for `tools`: keep the
 * converter's empty/falsy bypass, and reject only a collection the legacy
 * converter would throw on (not an array, or a `null` entry). Malformed
 * nested tools (inside a `namespace` tool or a tool-carrying input item) are
 * dropped by the conversion instead.
 */
export function validateResponsesTools(tools: unknown): string | undefined {
  if (tools && (tools as { length?: unknown }).length !== 0) {
    if (!Array.isArray(tools)) return "tools must be an array";
    if (tools.some((tool) => tool === null)) return "tools entries must not be null";
  }
  return undefined;
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

function requireFixtureToolArguments(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error('Invalid fixture tool call: "arguments" must be a string after normalization');
  }
  return value;
}

function requireFixtureToolInput(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error('Invalid fixture tool call: "input" must be a string for a custom tool call');
  }
  return value;
}

/**
 * A tool call to emit: a `toolCalls` entry, or a normalized `toolCall` /
 * `customToolCall` block passed through as-is.
 */
type EmittableToolCall = FixtureToolCall | Exclude<ResponsesFixtureBlock, { type: "text" }>;

function isCustomEmittable(
  call: EmittableToolCall,
): call is CustomToolCall | Extract<ResponsesFixtureBlock, { type: "customToolCall" }> {
  // A non-object entry (only reachable from an untyped fixture) takes the
  // function path, which fails on it exactly as earlier releases did.
  if (call === null || typeof call !== "object") return false;
  return call.type === "custom" || call.type === "customToolCall";
}

/**
 * A Responses `function_call` item. `namespace` is added only when the fixture
 * sets it, so a call without one keeps the keys and key order it had before
 * namespaces existed (existing fixtures stay byte-identical on the wire).
 */
function functionCallItem(
  call: { name: string; namespace?: string },
  fcId: string,
  callId: string,
  args: string,
  status: "in_progress" | "completed",
): Record<string, unknown> {
  return {
    type: "function_call",
    id: fcId,
    call_id: callId,
    ...(call.namespace !== undefined ? { namespace: call.namespace } : {}),
    name: call.name,
    arguments: args,
    status,
  };
}

/**
 * `ctc_…` item id, the prefix the OpenAI guide and Codex's item-id map use for
 * custom tool calls. The underscore separator is deliberate: it matches the
 * real id format, so this does not use `generateId` (which would give
 * `ctc-…`, like aimock's own `fc-…` ids).
 */
function customToolCallItemId(): string {
  return `ctc_${randomBytes(12).toString("base64url")}`;
}

/** A Responses `custom_tool_call` item; `namespace` is added only when set. */
function customToolCallItem(
  call: { name: string; namespace?: string },
  ctcId: string,
  callId: string,
  input: string,
  status: "in_progress" | "completed",
): Record<string, unknown> {
  return {
    type: "custom_tool_call",
    id: ctcId,
    call_id: callId,
    ...(call.namespace !== undefined ? { namespace: call.namespace } : {}),
    name: call.name,
    input,
    status,
  };
}

/**
 * A `toolCalls` entry as earlier releases served it: a function call whose
 * `type`, `input` and `namespace` are ignored. The exported builders take
 * fixtures in that form; the handler passes `namespace` (extended mode) and
 * custom calls to the internal builders instead.
 */
function legacyFunctionCall(call: ToolCall): FixtureToolCall {
  if (call === null || typeof call !== "object") return call;
  const { name, arguments: args, id } = call;
  return id !== undefined ? { name, arguments: args, id } : { name, arguments: args };
}

/** Resolve exported-builder `blocks` as earlier releases did (no namespace emitted). */
function legacyOrderedBlocks(
  blocks: FixtureBlock[] | undefined,
): ResponsesFixtureBlock[] | undefined {
  if (!blocks || blocks.length === 0) return undefined;
  return resolveFixtureBlocks(blocks).map((block) => {
    if (block.type === "text" || block.namespace === undefined) return block;
    const copy = { ...block };
    delete copy.namespace;
    return copy;
  });
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
  return toolCallStreamEvents(
    toolCalls.map(legacyFunctionCall),
    model,
    chunkSize,
    reasoning,
    webSearches,
    overrides,
    emitEncryptedReasoning,
    synthesizeSummarylessReasoning,
  );
}

export function toolCallStreamEvents(
  toolCalls: FixtureToolCall[],
  model: string,
  chunkSize: number,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): ResponsesSSEEvent[] {
  assertResponsesToolCalls(toolCalls);
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
    const { events: callEvents, item } = buildToolCallOutputEvents(
      toolCalls[idx],
      chunkSize,
      nextOutputIndex + idx,
    );
    events.push(...callEvents);
    fcOutputItems.push(item);
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
  forceReasoning = false,
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
    forceReasoning ||
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

/** One streamed tool-call item: a `function_call` or a `custom_tool_call`. */
interface ToolCallBlockResult {
  events: ResponsesSSEEvent[];
  item: object;
}

/**
 * Emit the output_item.added → arguments deltas → arguments.done →
 * output_item.done events for a single function_call at `outputIndex`,
 * returning the completed item for the final `output` array. Every Responses
 * streaming builder (tool-only, legacy content+toolCalls and ordered blocks)
 * reaches this through {@link buildToolCallOutputEvents}, so a given
 * (tool, outputIndex) has the same wire output on every path.
 */
function buildFunctionCallOutputEvents(
  toolCall: { name: string; arguments: string; id?: string; namespace?: string },
  chunkSize: number,
  outputIndex: number,
): ToolCallBlockResult {
  const callId = toolCall.id || generateToolCallId();
  const fcId = generateId("fc");
  const args = requireFixtureToolArguments(toolCall.arguments);
  const events: ResponsesSSEEvent[] = [];

  events.push({
    type: "response.output_item.added",
    output_index: outputIndex,
    item: functionCallItem(toolCall, fcId, callId, "", "in_progress"),
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

  const item = functionCallItem(toolCall, fcId, callId, args, "completed");
  events.push({ type: "response.output_item.done", output_index: outputIndex, item });

  return { events, item };
}

/**
 * `text` cut into slices of at most `chunkSize` UTF-16 units, never between
 * the two halves of a surrogate pair: a cut that would land inside a pair
 * moves back before it, or, when that would leave the slice empty
 * (`chunkSize` 1), forward past it. The slices rejoin to `text` exactly.
 */
function surrogateSafeChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + chunkSize, text.length);
    const high = text.charCodeAt(end - 1);
    const low = text.charCodeAt(end);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      end = end - 1 > i ? end - 1 : end + 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/**
 * Emit output_item.added → custom_tool_call_input.delta×N →
 * custom_tool_call_input.done → output_item.done for one `custom_tool_call` at
 * `outputIndex`, returning the completed item. An empty `input`
 * yields no delta event.
 */
function buildCustomToolCallOutputEvents(
  call: { name: string; input: string; id?: string; namespace?: string },
  chunkSize: number,
  outputIndex: number,
): ToolCallBlockResult {
  const callId = call.id || generateToolCallId();
  const ctcId = customToolCallItemId();
  const input = requireFixtureToolInput(call.input);
  const events: ResponsesSSEEvent[] = [];

  events.push({
    type: "response.output_item.added",
    output_index: outputIndex,
    item: customToolCallItem(call, ctcId, callId, "", "in_progress"),
  });

  for (const delta of surrogateSafeChunks(input, chunkSize)) {
    events.push({
      type: "response.custom_tool_call_input.delta",
      item_id: ctcId,
      output_index: outputIndex,
      delta,
    });
  }

  events.push({
    type: "response.custom_tool_call_input.done",
    item_id: ctcId,
    output_index: outputIndex,
    input,
  });

  const item = customToolCallItem(call, ctcId, callId, input, "completed");
  events.push({ type: "response.output_item.done", output_index: outputIndex, item });

  return { events, item };
}

/** Streaming dispatcher: one function or custom tool call at `outputIndex`. */
function buildToolCallOutputEvents(
  call: EmittableToolCall,
  chunkSize: number,
  outputIndex: number,
): ToolCallBlockResult {
  return isCustomEmittable(call)
    ? buildCustomToolCallOutputEvents(call, chunkSize, outputIndex)
    : buildFunctionCallOutputEvents(call, chunkSize, outputIndex);
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

export function buildTextResponse(
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
  toolCalls: FixtureToolCall[],
  model: string,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): object {
  assertResponsesToolCalls(toolCalls);
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
    output.push(buildToolCallOutputItem(tc));
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
  return contentWithToolCallsStreamEvents(
    content,
    toolCalls.map(legacyFunctionCall),
    model,
    chunkSize,
    reasoning,
    webSearches,
    overrides,
    legacyOrderedBlocks(blocks),
    emitEncryptedReasoning,
    synthesizeSummarylessReasoning,
  );
}

/**
 * Internal content+tool-calls builder. `ordered` is already resolved (see
 * {@link resolveServedBlockOutcome}); when non-empty it is streamed in array
 * order, otherwise the legacy message-first path runs over `toolCalls`.
 */
export function contentWithToolCallsStreamEvents(
  content: string,
  toolCalls: FixtureToolCall[],
  model: string,
  chunkSize: number,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
  ordered?: ResponsesFixtureBlock[],
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

  if (ordered && ordered.length > 0) {
    // NEW PATH: stream items in the fixture's block ARRAY ORDER. A tool block
    // placed before a text block therefore yields a tool call item at
    // a LOWER output_index than the message — it leads the output array.
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
        const { events: callEvents, item } = buildToolCallOutputEvents(
          block,
          chunkSize,
          outputIndex,
        );
        events.push(...callEvents);
        orderedOutputItems.push(item);
      }
      outputIndex += 1;
    }
  } else {
    assertResponsesToolCalls(toolCalls);
    // LEGACY PATH: message item first, then tool call items (function_call or
    // custom_tool_call). The message always leads the output; for fixtures
    // without custom calls or namespaces this is byte-for-byte the pre-blocks
    // output.
    const { events: msgEvents, msgItem } = buildMessageOutputEvents(
      content,
      chunkSize,
      nextOutputIndex,
    );
    events.push(...msgEvents);
    orderedOutputItems.push(msgItem);

    for (let idx = 0; idx < toolCalls.length; idx++) {
      const { events: callEvents, item } = buildToolCallOutputEvents(
        toolCalls[idx],
        chunkSize,
        nextOutputIndex + 1 + idx,
      );
      events.push(...callEvents);
      orderedOutputItems.push(item);
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

/** Non-streaming dispatcher: the completed function or custom tool call item. */
function buildToolCallOutputItem(tc: EmittableToolCall): object {
  if (isCustomEmittable(tc)) {
    return customToolCallItem(
      tc,
      customToolCallItemId(),
      tc.id || generateToolCallId(),
      requireFixtureToolInput(tc.input),
      "completed",
    );
  }
  return functionCallItem(
    tc,
    generateId("fc"),
    tc.id || generateToolCallId(),
    requireFixtureToolArguments(tc.arguments),
    "completed",
  );
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
  toolCalls: FixtureToolCall[],
  model: string,
  reasoning?: string,
  webSearches?: string[],
  overrides?: ResponseOverrides,
  ordered?: ResponsesFixtureBlock[],
  emitEncryptedReasoning = false,
  synthesizeSummarylessReasoning = false,
): object {
  if (ordered && ordered.length > 0) {
    // NEW PATH: the non-streaming `output[]` array is positionally observable,
    // so emit the prefix (reasoning / web_search_call), then the blocks in
    // fixture ARRAY ORDER. A tool block before a text block therefore
    // yields a tool call item ahead of the message — matching the streaming
    // path's ordering for the same `blocks` fixture.
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
        output.push(buildToolCallOutputItem(block));
      }
    }
    return buildResponseEnvelope(model, output, overrides);
  }

  // LEGACY PATH: message item first, then tool call items (function_call or
  // custom_tool_call), as before blocks existed.
  assertResponsesToolCalls(toolCalls);
  const output = buildOutputPrefix(
    content,
    model,
    reasoning,
    webSearches,
    emitEncryptedReasoning,
    synthesizeSummarylessReasoning,
  );
  for (const tc of toolCalls) {
    output.push(buildToolCallOutputItem(tc));
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

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `responsesReq.model` throws a TypeError that
  // surfaces as a 500 instead of a 400.
  if (!isJsonObject(responsesReq)) {
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
          message: "Request body must be a JSON object",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Guard only shapes consumed by input conversion. Other item fields may be
  // intentionally ignored, and falsy message content normalizes to empty text.
  let inputError: string | undefined;
  if (typeof responsesReq.input !== "string" && !Array.isArray(responsesReq.input)) {
    inputError = "input must be a string or an array";
  } else if (Array.isArray(responsesReq.input)) {
    for (const [index, item] of responsesReq.input.entries()) {
      if (item === null) {
        inputError = `input[${index}] must not be null`;
        break;
      }
      if (
        (item.role === "system" ||
          item.role === "developer" ||
          item.role === "user" ||
          item.role === "assistant") &&
        item.content &&
        typeof item.content !== "string" &&
        !Array.isArray(item.content)
      ) {
        inputError = `input[${index}].content must be a string or an array`;
        break;
      }
    }
  }
  const validationError = inputError ?? validateResponsesTools(responsesReq.tools);
  if (validationError) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: responsesReq,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({ error: { message: validationError, type: "invalid_request_error" } }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const extendedTools = defaults.responsesTools === "extended";
  const completionReq = responsesToCompletionRequest(responsesReq, {
    extended: extendedTools,
    logger: defaults.logger,
  });
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
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
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

  // Without responsesTools "extended", a namespace on a toolCalls entry or a
  // toolCall block is not emitted, as in earlier releases.
  const resolvedResponse = await resolveResponse(fixture, completionReq);
  const response = extendedTools ? resolvedResponse : withoutLegacyNamespaces(resolvedResponse);
  const misbehavior = planMisbehavior({
    wire: "openai-responses",
    fixture,
    response,
    request: completionReq,
    stream: responsesReq.stream === true,
    emitsToolCallIds: true,
    defaults,
    rawHeaders: req.headers,
    url: req.url,
  });
  if (misbehavior.kind === "error") {
    const entry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: misbehavior.status, fixture },
    });
    recordMisbehaviorOutcome({ entry, summary: misbehavior.summary, defaults, testId });
    if (!misbehavior.summary?.evaluations.some((evaluation) => evaluation.outcome === "error")) {
      defaults.logger.error(misbehavior.message);
    }
    writeErrorResponse(
      res,
      misbehavior.status,
      JSON.stringify({
        error: {
          message: misbehavior.message,
          type: "invalid_request_error",
          code: misbehavior.code,
        },
      }),
    );
    return;
  }

  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);
  const fixtureTimings = fixture.recordedTimings;
  const effectiveReplaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;

  if (misbehavior.kind === "applied") {
    const prepared = prepareResponsesMisbehavior(misbehavior);
    const output = buildResponsesMisbehavior(
      prepared,
      completionReq,
      chunkSize,
      emitEncryptedReasoning,
    );
    const entry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    recordMisbehaviorOutcome({ entry, summary: prepared.summary, defaults, testId });
    if (responsesReq.stream !== true) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(output.response));
    } else {
      const appliedTimings =
        prepared.duplicateId && fixtureTimings
          ? { ...fixtureTimings, interChunkDelaysMs: [...fixtureTimings.interChunkDelaysMs] }
          : fixtureTimings;
      if (prepared.duplicateId && appliedTimings) {
        const lastGap = appliedTimings.interChunkDelaysMs.at(-1) ?? 0;
        while (appliedTimings.interChunkDelaysMs.length < output.events.length - 1) {
          appliedTimings.interChunkDelaysMs.push(lastGap);
        }
      }
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeResponsesSSEStream(res, output.events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: appliedTimings,
        replaySpeed: effectiveReplaySpeed,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
      });
      if (!completed) {
        if (!res.writableEnded) res.destroy();
        entry.response.interrupted = true;
        entry.response.interruptReason = interruption?.reason();
      }
      interruption?.cleanup();
    }
    return;
  }

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/responses",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    writeErrorResponse(res, status, serializeErrorResponse(response), {
      retryAfter: response.retryAfter,
    });
    return;
  }

  // Combined content + tool calls response
  if (isCombinedFixtureResponse(response)) {
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
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    // Resolve the served blocks (responsesBlocks, else legacy blocks) after
    // journaling, where earlier releases' builders resolved them.
    const ordered = resolveServedBlockOutcome(response)?.ordered;
    if (!ordered) assertCustomToolCalls(response);
    const toolCalls = servedToolCalls(response);
    if (responsesReq.stream !== true) {
      const body = buildContentWithToolCallsResponse(
        response.content ?? "",
        toolCalls,
        completionReq.model,
        effReasoning,
        response.webSearches,
        overrides,
        ordered,
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = contentWithToolCallsStreamEvents(
        response.content ?? "",
        toolCalls,
        completionReq.model,
        chunkSize,
        effReasoning,
        response.webSearches,
        overrides,
        ordered,
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
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
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
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    assertCustomToolCalls(response);
    if (responsesReq.stream !== true) {
      const body = buildToolCallResponse(
        servedToolCalls(response),
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
      const events = toolCallStreamEvents(
        servedToolCalls(response),
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
  const journalEntry = journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/v1/responses",
    headers: flattenHeaders(req.headers),
    body: completionReq,
    response: { status: 500, fixture },
  });
  recordMisbehaviorOutcome({ entry: journalEntry, summary: misbehavior.summary, defaults, testId });
  writeErrorResponse(
    res,
    500,
    JSON.stringify({
      error: { message: "Fixture response did not match any known type", type: "server_error" },
    }),
  );
}

/** Prepare call IDs once, retaining the engine's effective blocks and exact served-call metadata. */
export function prepareResponsesMisbehavior(plan: MisbehaviorPlan): MisbehaviorPlan {
  return prepareOpenAIChatMisbehavior(plan);
}

/** Build one faulted payload/event sequence for both HTTP and Responses WebSocket consumers. */
export function buildResponsesMisbehavior(
  plan: MisbehaviorPlan,
  request: ChatCompletionRequest,
  chunkSize: number,
  emitEncryptedReasoning = false,
) {
  const response = plan.response;
  if (
    !(
      isCombinedFixtureResponse(response) ||
      isTextResponse(response) ||
      isToolCallResponse(response)
    )
  ) {
    throw new Error("Responses misbehavior requires a prepared chat response");
  }
  const overrides = extractOverrides(response);
  const reasoning = plan.reasoning ?? ("reasoning" in response ? response.reasoning : undefined);
  const webSearches = "webSearches" in response ? response.webSearches : undefined;
  const { respId, created, events, prefixOutputItems, nextOutputIndex } = buildResponsePreamble(
    request.model,
    chunkSize,
    reasoning,
    webSearches,
    overrides,
    emitEncryptedReasoning,
    false,
    plan.reasoning !== undefined,
  );
  const output = [...prefixOutputItems];
  let outputIndex = nextOutputIndex;
  const incomplete = plan.stop === "length" || plan.stop === "content_filter";

  if (plan.refusal !== undefined) {
    const id = itemId();
    const part = { type: "refusal", refusal: plan.refusal };
    const item = { id, type: "message", role: "assistant", status: "completed", content: [part] };
    const position = { item_id: id, output_index: outputIndex, content_index: 0 };
    events.push(
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", content: [] },
      },
      { type: "response.content_part.added", ...position, part: { type: "refusal", refusal: "" } },
    );
    for (let i = 0; i < plan.refusal.length; i += chunkSize) {
      events.push({
        type: "response.refusal.delta",
        ...position,
        delta: plan.refusal.slice(i, i + chunkSize),
      });
    }
    events.push(
      { type: "response.refusal.done", ...position, refusal: plan.refusal },
      { type: "response.content_part.done", ...position, part },
      { type: "response.output_item.done", output_index: outputIndex, item },
    );
    output.push(item);
  } else if (
    plan.summary.fault !== "empty-response" &&
    plan.stop !== "content_filter" &&
    plan.reasoning === undefined
  ) {
    const combined = isCombinedFixtureResponse(response);
    // Custom tool calls and namespaces pass through a fault unchanged.
    const outcome = combined ? resolveServedBlockOutcome(response) : undefined;
    const blocks: ResponsesFixtureBlock[] = outcome?.ordered ?? [
      ...("content" in response && typeof response.content === "string"
        ? [{ type: "text" as const, text: response.content }]
        : []),
      ...(combined || isToolCallResponse(response)
        ? servedToolCalls(response).map(toolCallFixtureBlock)
        : []),
    ];
    let callIndex = 0;
    for (const block of blocks) {
      if (block.type === "text") {
        const message = buildMessageOutputEvents(block.text, chunkSize, outputIndex);
        events.push(...message.events);
        output.push(message.msgItem);
      } else {
        const call =
          block.type === "customToolCall"
            ? buildCustomToolCallOutputEvents(block, chunkSize, outputIndex)
            : buildFunctionCallOutputEvents(block, chunkSize, outputIndex);
        const cut =
          plan.summary.fault === "stop-length-mid-tool" && callIndex === plan.target?.index;
        const item = cut ? { ...call.item, status: "incomplete" } : call.item;
        // Live K5 capture retains both done events, with an incomplete call item.
        events.push(
          ...call.events.map((event) =>
            cut && event.type === "response.output_item.done" ? { ...event, item } : event,
          ),
        );
        output.push(item);
        callIndex++;
      }
      outputIndex++;
    }
  }
  const usage = resolveOpenAIChatMisbehaviorUsage(plan, request);
  const body = {
    id: respId,
    object: "response",
    created_at: created,
    model: overrides?.model ?? request.model,
    status: incomplete ? "incomplete" : responsesStatus(overrides?.finishReason, "completed"),
    ...(incomplete
      ? {
          incomplete_details: {
            reason: plan.stop === "content_filter" ? "content_filter" : "max_output_tokens",
          },
        }
      : {}),
    output,
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
  };
  events.push({ type: incomplete ? "response.incomplete" : "response.completed", response: body });
  return { response: body, events };
}
