/**
 * Google Gemini Interactions API support.
 *
 * Translates incoming Interactions requests into the ChatCompletionRequest
 * format used by the fixture router, and converts fixture responses back
 * into the Gemini Interactions format — either a single JSON response or
 * an SSE stream with event_type-based framing.
 */
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import { renderError } from "./response/errors.js";

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  FixtureBlock,
  HandlerDefaults,
  RecordedTimings,
  ResponseOverrides,
  StreamingProfile,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  requireEmittedFunctionToolCalls,
  isTextResponse,
  isToolCallResponse,
  isCombinedFixtureResponse,
  isErrorResponse,
  extractOverrides,
  generateToolCallId,
  flattenHeaders,
  isJsonObject,
  getTestId,
  getContext,
  resolveResponse,
  strictNoMatchMessage,
  strictNoMatchLogLine,
  resolveFixtureBlockOutcome,
  servedToolArgs,
  prepareOpenAIChatMisbehavior,
  resolveOpenAIChatMisbehaviorUsage,
} from "./helpers.js";
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse, sseCodec } from "./sse-writer.js";
import { httpSink, runFrameLoop, type FrameCodec } from "./response/frame-loop.js";
import { deliverJson, deliverStream } from "./response/deliver.js";
import { proxyInterruption, withHangUpDetection } from "./response/proxy.js";
import { misbehaviorPayloadLength, servedPayloadLength } from "./response/timing.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaosAsync } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";
import { render as renderInteractionsUsage } from "./response/usage/codecs/interactions.js";
import {
  planMisbehavior,
  recordMisbehaviorOutcome,
  type MisbehaviorPlan,
  type MisbehaviorSkip,
} from "./misbehavior.js";

// ─── Interactions request types ────────────────────────────────────────────

interface InteractionsContentBlock {
  type: string;
  text?: string;
  name?: string;
  call_id?: string;
  id?: string;
  arguments?: Record<string, unknown>;
  output?: unknown;
  result?: unknown;
}

interface InteractionsTurn {
  role: string;
  content?: InteractionsContentBlock[];
  parts?: InteractionsContentBlock[];
}

/**
 * Top-level Step envelope accepted by the live Gemini Interactions API.
 * The SDK's TypeScript union does not include Step[], but the wire contract
 * does — clients following the live API send these at the top level of `input`.
 * Discriminated by `type`; no `role` field (distinguishes from Turn[]).
 */
interface InteractionsStep {
  type: string;
  content?: InteractionsContentBlock[];
  call_id?: string;
  id?: string;
  name?: string;
  result?: unknown;
  output?: unknown;
  is_error?: boolean;
  signature?: string;
}

/** Step types whose payload is a tool/agent result keyed by call_id. */
const STEP_RESULT_TYPES = new Set<string>([
  "function_result",
  "code_execution_result",
  "url_context_result",
  "google_search_result",
  "google_maps_result",
  "mcp_server_tool_result",
  "file_search_result",
]);

/** All recognized top-level Step types (used as the Step[] discriminator). */
const STEP_TYPES = new Set<string>(["user_input", "model_output", ...STEP_RESULT_TYPES]);

interface InteractionsFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: object;
}

interface InteractionsRequest {
  model?: string;
  input?: string | InteractionsTurn[] | InteractionsStep[] | InteractionsContentBlock[];
  system_instruction?: string;
  tools?: InteractionsFunctionTool[];
  generation_config?: {
    temperature?: number;
    max_output_tokens?: number;
    [key: string]: unknown;
  };
  stream?: boolean;
  previous_interaction_id?: string;
  [key: string]: unknown;
}

// Check unsupported numeric input and containers consumed by the selected variant.
// Other values retain their existing normalization, including omitted input.
function validateInteractionsInput(input: unknown): string | null {
  if (typeof input === "number") return "input must not be a number";
  if (!Array.isArray(input)) return null;
  const first = input[0];
  if (isJsonObject(first) && "role" in first) {
    for (const [index, turn] of input.entries()) {
      if (!isJsonObject(turn)) continue;
      const blocks = turn.content ?? turn.parts;
      // Empty strings, falsy values and empty arrays bypass the converter's
      // filters. Preserve that behavior and the content ?? parts selection.
      if (typeof blocks === "string" && blocks.length > 0) {
        const field = turn.content != null ? "content" : "parts";
        return `input[${index}].${field} must be an array`;
      }
    }
  } else if (
    !(isJsonObject(first) && typeof first.type === "string" && STEP_TYPES.has(first.type))
  ) {
    const nullIndex = input.findIndex((part) => part === null);
    if (nullIndex !== -1) return `input[${nullIndex}] must be an object`;
  }
  return null;
}

// Preserve tools that the converter ignores; reject only these unsafe reads.
function validateInteractionsTools(tools: unknown): string | null {
  if (typeof tools === "string" && tools.length > 0) return "tools must be an array";
  if (Array.isArray(tools)) {
    const nullIndex = tools.findIndex((tool) => tool === null);
    if (nullIndex !== -1) return `tools[${nullIndex}] must be an object`;
  }
  return null;
}

// ─── Input conversion: Interactions → ChatCompletionRequest ───────────────

export function geminiInteractionsToCompletionRequest(
  req: InteractionsRequest,
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  const model = req.model ?? "gemini-2.5-flash";

  // system_instruction → system message
  if (req.system_instruction) {
    messages.push({ role: "system", content: req.system_instruction });
  }

  // Parse input
  if (req.input !== undefined) {
    if (typeof req.input === "string") {
      // Simple string input → single user message
      messages.push({ role: "user", content: req.input });
    } else if (Array.isArray(req.input)) {
      // Could be Turn[], Step[], or Content[]
      const firstItem = req.input[0] as
        | InteractionsTurn
        | InteractionsStep
        | InteractionsContentBlock
        | undefined;
      const isStepArray =
        !!firstItem &&
        !("role" in firstItem) &&
        typeof firstItem.type === "string" &&
        STEP_TYPES.has(firstItem.type);

      if (firstItem && "role" in firstItem) {
        // Turn[] format
        for (const turn of req.input as InteractionsTurn[]) {
          const role = turn.role === "model" ? "assistant" : turn.role;
          const blocks = turn.content ?? turn.parts;
          if (!blocks || blocks.length === 0) {
            if (role === "user" || role === "assistant") {
              messages.push({ role: role as "user" | "assistant", content: "" });
            }
            continue;
          }

          // Check for function_call or function_result parts
          const funcCallParts = blocks.filter((p) => p.type === "function_call");
          const funcResultParts = blocks.filter((p) => p.type === "function_result");
          const textParts = blocks.filter((p) => p.type === "text");

          if (funcCallParts.length > 0) {
            // Assistant tool call message
            const textContent = textParts.map((p) => p.text ?? "").join("");
            messages.push({
              role: "assistant",
              content: textContent || null,
              tool_calls: funcCallParts.map((p) => ({
                id: p.id ?? p.call_id ?? generateToolCallId(),
                type: "function" as const,
                function: {
                  name: p.name ?? "",
                  arguments: JSON.stringify(p.arguments ?? {}),
                },
              })),
            });
          } else if (funcResultParts.length > 0) {
            // Tool response messages
            for (const part of funcResultParts) {
              const resultValue = part.result ?? part.output;
              messages.push({
                role: "tool",
                content:
                  typeof resultValue === "string" ? resultValue : JSON.stringify(resultValue ?? ""),
                tool_call_id: part.call_id ?? part.id ?? "",
              });
            }
            // Any text parts alongside → separate user message
            if (textParts.length > 0) {
              const text = textParts.map((p) => p.text ?? "").join("");
              if (text) {
                messages.push({ role: "user", content: text });
              }
            }
          } else {
            // Text-only turn
            const text = textParts.map((p) => p.text ?? "").join("");
            if (role === "user" || role === "assistant" || role === "system") {
              messages.push({
                role: role as "user" | "assistant" | "system",
                content: text,
              });
            }
          }
        }
      } else if (isStepArray) {
        // Step[] format — the wire contract Google's /v1beta/interactions accepts.
        for (const step of req.input as InteractionsStep[]) {
          if (step.type === "user_input") {
            const text = (step.content ?? [])
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("");
            messages.push({ role: "user", content: text });
          } else if (step.type === "model_output") {
            const blocks = step.content ?? [];
            const funcCallParts = blocks.filter((p) => p.type === "function_call");
            const textParts = blocks.filter((p) => p.type === "text");
            const textContent = textParts.map((p) => p.text ?? "").join("");

            if (funcCallParts.length > 0) {
              messages.push({
                role: "assistant",
                content: textContent || null,
                tool_calls: funcCallParts.map((p) => ({
                  id: p.id ?? p.call_id ?? generateToolCallId(),
                  type: "function" as const,
                  function: {
                    name: p.name ?? "",
                    arguments: JSON.stringify(p.arguments ?? {}),
                  },
                })),
              });
            } else {
              messages.push({ role: "assistant", content: textContent });
            }
          } else if (STEP_RESULT_TYPES.has(step.type)) {
            const resultValue = step.result ?? step.output;
            messages.push({
              role: "tool",
              content:
                typeof resultValue === "string" ? resultValue : JSON.stringify(resultValue ?? ""),
              tool_call_id: step.call_id ?? step.id ?? "",
            });
          }
        }
      } else {
        // Content[] format — single user message with content blocks
        const textParts = (req.input as InteractionsContentBlock[]).filter(
          (p) => p.type === "text",
        );
        const text = textParts.map((p) => p.text ?? "").join("");
        messages.push({ role: "user", content: text || "" });
      }
    }
  }

  // Convert tools
  let tools: ToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    const funcTools = req.tools.filter((t) => t.type === "function");
    if (funcTools.length > 0) {
      tools = funcTools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }
  }

  return {
    model,
    messages,
    stream: req.stream !== false, // default true
    temperature: req.generation_config?.temperature,
    max_tokens: req.generation_config?.max_output_tokens,
    tools,
  };
}

// ─── Interaction ID generation ────────────────────────────────────────────

let interactionCounter = 0;

export function resetInteractionCounter(): void {
  interactionCounter = 0;
}

function nextInteractionId(): string {
  return `aimock-int-${interactionCounter++}`;
}

// ─── Usage helpers ────────────────────────────────────────────────────────

function interactionsUsage(overrides?: ResponseOverrides): {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
} {
  return renderInteractionsUsage(overrides);
}

// ─── Response building: fixture → Interactions format ─────────────────────

export function buildInteractionsTextResponse(
  content: string,
  model: string,
  interactionId: string,
  overrides?: ResponseOverrides,
): object {
  return {
    id: interactionId,
    status: "completed",
    model: overrides?.model ?? model,
    role: "model",
    output_text: content,
    steps: [{ type: "model_output", content: [{ type: "text", text: content }] }],
    usage: interactionsUsage(overrides),
  };
}

// Build a single SDK 2.x function_call step from a fixture tool call,
// serving malformed arguments as `{}` (or rejecting them under strictToolArguments).
function buildFunctionCallStep(tc: ToolCall, logger: Logger): object {
  const args = servedToolArgs(tc, "object", logger);
  return {
    type: "function_call",
    id: tc.id || generateToolCallId(),
    name: tc.name,
    arguments: args.value,
  };
}

export function buildInteractionsToolCallResponse(
  toolCalls: ToolCall[],
  model: string,
  interactionId: string,
  logger: Logger,
  overrides?: ResponseOverrides,
): object {
  return {
    id: interactionId,
    status: "requires_action",
    model: overrides?.model ?? model,
    role: "model",
    steps: toolCalls.map((tc) => buildFunctionCallStep(tc, logger)),
    usage: interactionsUsage(overrides),
  };
}

export function buildInteractionsContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  interactionId: string,
  logger: Logger,
  overrides?: ResponseOverrides,
  blocks?: FixtureBlock[],
): object {
  const steps: object[] = [];
  // Collect output_text in step order so the top-level field mirrors the
  // concatenated text steps regardless of where they appear in `steps`.
  let outputText = "";

  let hasToolCalls = true;
  if (blocks && blocks.length > 0) {
    // NEW PATH: the non-stream `steps[]` array is index/step-addressed and
    // ordered, so emit one step per block in fixture ARRAY ORDER. A toolCall
    // block placed before a text block therefore yields a function_call step
    // ahead of the model_output step — tool-first, the opposite of the legacy
    // (text-step-always-first) shape below.
    const outcome = resolveFixtureBlockOutcome(blocks);
    const ordered = outcome.ordered;
    hasToolCalls = outcome.hasToolCalls;
    for (const block of ordered) {
      if (block.type === "text") {
        steps.push({ type: "model_output", content: [{ type: "text", text: block.text }] });
        outputText += block.text;
      } else {
        steps.push(
          buildFunctionCallStep(
            { name: block.name, arguments: block.arguments, id: block.id },
            logger,
          ),
        );
      }
    }
  } else {
    // LEGACY PATH: a single text step first, then function_call steps —
    // unchanged from the pre-blocks behavior (text always leads `steps`).
    steps.push({ type: "model_output", content: [{ type: "text", text: content }] });
    outputText = content;
    for (const tc of toolCalls) {
      steps.push(buildFunctionCallStep(tc, logger));
    }
  }

  return {
    id: interactionId,
    status: hasToolCalls ? "requires_action" : "completed",
    model: overrides?.model ?? model,
    role: "model",
    output_text: outputText,
    steps,
    usage: interactionsUsage(overrides),
  };
}

// ─── SSE event builders ──────────────────────────────────────────────────

interface InteractionsSSEEvent {
  event_type: string;
  [key: string]: unknown;
}

let eventIdCounter = 0;

export function resetEventIdCounter(): void {
  eventIdCounter = 0;
}

function nextEventId(): string {
  return `evt_${++eventIdCounter}`;
}

export function buildInteractionsTextSSEEvents(
  content: string,
  interactionId: string,
  chunkSize: number,
  overrides?: ResponseOverrides,
): InteractionsSSEEvent[] {
  const events: InteractionsSSEEvent[] = [];

  // interaction.created
  events.push({
    event_type: "interaction.created",
    interaction: { id: interactionId, status: "in_progress" },
    event_id: nextEventId(),
  });

  // step.start — text step is the model_output
  events.push({
    event_type: "step.start",
    index: 0,
    step: { type: "model_output" },
    event_id: nextEventId(),
  });

  // step.delta(s) — inner delta shape is unchanged ({ type: "text", text })
  if (content.length === 0) {
    events.push({
      event_type: "step.delta",
      index: 0,
      delta: { type: "text", text: "" },
      event_id: nextEventId(),
    });
  } else {
    for (let i = 0; i < content.length; i += chunkSize) {
      const slice = content.slice(i, i + chunkSize);
      events.push({
        event_type: "step.delta",
        index: 0,
        delta: { type: "text", text: slice },
        event_id: nextEventId(),
      });
    }
  }

  // step.stop
  events.push({
    event_type: "step.stop",
    index: 0,
    event_id: nextEventId(),
  });

  // interaction.completed
  events.push({
    event_type: "interaction.completed",
    interaction: {
      id: interactionId,
      status: "completed",
      usage: interactionsUsage(overrides),
    },
    event_id: nextEventId(),
  });

  return events;
}

export function buildInteractionsToolCallSSEEvents(
  toolCalls: ToolCall[],
  interactionId: string,
  logger: Logger,
  overrides?: ResponseOverrides,
): InteractionsSSEEvent[] {
  const events: InteractionsSSEEvent[] = [];

  // interaction.created
  events.push({
    event_type: "interaction.created",
    interaction: { id: interactionId, status: "in_progress" },
    event_id: nextEventId(),
  });

  // Each tool call gets its own step.start/delta/stop bracket. In SDK 2.x the
  // call identity (id, name) lives on step.start; the arguments stream as a
  // dedicated `arguments_delta` carrying a JSON-string fragment, and step.start
  // carries an empty `arguments: {}` placeholder.
  for (let idx = 0; idx < toolCalls.length; idx++) {
    const tc = toolCalls[idx];
    const args = servedToolArgs(tc, "string", logger);

    events.push({
      event_type: "step.start",
      index: idx,
      step: {
        type: "function_call",
        id: tc.id || generateToolCallId(),
        name: tc.name,
        arguments: {},
      },
      event_id: nextEventId(),
    });

    // arguments_delta.arguments is a string fragment. The real SDK may split
    // the args across several fragments that concatenate into valid JSON; the
    // mock emits the whole serialized object as one fragment (a valid
    // degenerate case the collapser handles identically).
    events.push({
      event_type: "step.delta",
      index: idx,
      delta: {
        type: "arguments_delta",
        arguments: args.text,
      },
      event_id: nextEventId(),
    });

    events.push({
      event_type: "step.stop",
      index: idx,
      event_id: nextEventId(),
    });
  }

  // interaction.completed
  events.push({
    event_type: "interaction.completed",
    interaction: {
      id: interactionId,
      status: "requires_action",
      usage: interactionsUsage(overrides),
    },
    event_id: nextEventId(),
  });

  return events;
}

// Emit the step.start/delta(s)/stop bracket for a text (model_output) step at
// a given step `index`. Inner delta shape ({ type: "text", text }) and the
// empty-content single-empty-delta behavior are unchanged from the legacy path.
function pushTextStepEvents(
  events: InteractionsSSEEvent[],
  index: number,
  content: string,
  chunkSize: number,
): void {
  events.push({
    event_type: "step.start",
    index,
    step: { type: "model_output" },
    event_id: nextEventId(),
  });

  if (content.length === 0) {
    events.push({
      event_type: "step.delta",
      index,
      delta: { type: "text", text: "" },
      event_id: nextEventId(),
    });
  } else {
    for (let i = 0; i < content.length; i += chunkSize) {
      const slice = content.slice(i, i + chunkSize);
      events.push({
        event_type: "step.delta",
        index,
        delta: { type: "text", text: slice },
        event_id: nextEventId(),
      });
    }
  }

  events.push({
    event_type: "step.stop",
    index,
    event_id: nextEventId(),
  });
}

// Emit the step.start/arguments_delta/stop bracket for a function_call step at
// a given step `index`. Identity (id, name) lives on step.start with an empty
// `arguments: {}` placeholder; the arguments stream as a single
// `arguments_delta` JSON-string fragment — unchanged from the legacy path.
function pushFunctionCallStepEvents(
  events: InteractionsSSEEvent[],
  index: number,
  tc: ToolCall,
  logger: Logger,
): void {
  const args = servedToolArgs(tc, "string", logger);

  events.push({
    event_type: "step.start",
    index,
    step: {
      type: "function_call",
      id: tc.id || generateToolCallId(),
      name: tc.name,
      arguments: {},
    },
    event_id: nextEventId(),
  });

  events.push({
    event_type: "step.delta",
    index,
    delta: {
      type: "arguments_delta",
      arguments: args.text,
    },
    event_id: nextEventId(),
  });

  events.push({
    event_type: "step.stop",
    index,
    event_id: nextEventId(),
  });
}

export function buildInteractionsContentWithToolCallsSSEEvents(
  content: string,
  toolCalls: ToolCall[],
  interactionId: string,
  chunkSize: number,
  logger: Logger,
  overrides?: ResponseOverrides,
  blocks?: FixtureBlock[],
): InteractionsSSEEvent[] {
  const events: InteractionsSSEEvent[] = [];

  // interaction.created
  events.push({
    event_type: "interaction.created",
    interaction: { id: interactionId, status: "in_progress" },
    event_id: nextEventId(),
  });

  let hasToolCalls = true;
  if (blocks && blocks.length > 0) {
    // NEW PATH: stream one step per block in fixture ARRAY ORDER. The step
    // `index` increments with array position, so a toolCall block before a text
    // block yields a function_call step at a LOWER index than the model_output
    // step — tool-first, the opposite of the legacy (text-at-index-0) shape.
    const outcome = resolveFixtureBlockOutcome(blocks);
    const ordered = outcome.ordered;
    hasToolCalls = outcome.hasToolCalls;
    let idx = 0;
    for (const block of ordered) {
      if (block.type === "text") {
        pushTextStepEvents(events, idx, block.text, chunkSize);
      } else {
        pushFunctionCallStepEvents(
          events,
          idx,
          {
            name: block.name,
            arguments: block.arguments,
            id: block.id,
          },
          logger,
        );
      }
      idx += 1;
    }
  } else {
    // LEGACY PATH: text content at index 0 (model_output step), tool calls at
    // index 1+ — byte-for-byte unchanged from the pre-blocks behavior.
    pushTextStepEvents(events, 0, content, chunkSize);
    for (let i = 0; i < toolCalls.length; i++) {
      pushFunctionCallStepEvents(events, i + 1, toolCalls[i], logger);
    }
  }

  // interaction.completed
  events.push({
    event_type: "interaction.completed",
    interaction: {
      id: interactionId,
      status: hasToolCalls ? "requires_action" : "completed",
      usage: interactionsUsage(overrides),
    },
    event_id: nextEventId(),
  });

  return events;
}

// ─── SSE writer for Interactions streaming ────────────────────────────────

// Data-only SSE (no event: prefix, no [DONE]). Only step deltas count for the
// chunk index and truncateAfterChunks: framing events (interaction.created,
// step.start, step.stop, interaction.completed) pay the delay at the current
// index but do not consume chunk budget or trigger the chunk-sent callback.
const interactionsCodec: FrameCodec<InteractionsSSEEvent> = {
  ...sseCodec<InteractionsSSEEvent>({ done: false }),
  counts: (event) => event.event_type === "step.delta",
};

interface InteractionsStreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
  recordedTimings?: RecordedTimings;
  replaySpeed?: number;
  signal?: AbortSignal;
  onChunkSent?: () => void;
}

export async function writeGeminiInteractionsSSEStream(
  res: http.ServerResponse,
  events: InteractionsSSEEvent[],
  optionsOrLatency?: number | InteractionsStreamOptions,
): Promise<boolean> {
  const opts: InteractionsStreamOptions =
    typeof optionsOrLatency === "number" ? { latency: optionsOrLatency } : (optionsOrLatency ?? {});
  // No lifecycle: a caller gets close-awareness only through its own `signal`.
  // With no events an aborted signal does not stop the writer (it still ends
  // the response and returns true), so the loop gets no signal then.
  return runFrameLoop(
    httpSink(res),
    events,
    interactionsCodec,
    {
      latency: opts.latency,
      streamingProfile: opts.streamingProfile,
      recordedTimings: opts.recordedTimings,
      replaySpeed: opts.replaySpeed,
    },
    { signal: events.length > 0 ? opts.signal : undefined, onChunkSent: opts.onChunkSent },
  );
}

// ─── Request handler ──────────────────────────────────────────────────────

function prepareInteractionsMisbehavior(
  plan: MisbehaviorPlan,
  streaming: boolean,
): MisbehaviorPlan {
  if (!streaming && plan.summary.fault === "stop-length-mid-tool") {
    // The object wire cannot represent the selected partial argument string.
    // Earlier completed calls/text survive; omit the cut call before allocating
    // IDs and preparing servedToolCalls/usage.
    const response = plan.response;
    const combined = isCombinedFixtureResponse(response);
    const outcome =
      combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
    const calls =
      outcome?.toolCalls ??
      (combined || isToolCallResponse(response) ? (response.toolCalls ?? []) : []);
    const toolCalls = calls.filter((_, index) => index !== plan.target?.index);
    let callIndex = 0;
    const blocks = outcome?.ordered.filter(
      (block) => block.type === "text" || callIndex++ !== plan.target?.index,
    );
    plan = { ...plan, response: { ...response, toolCalls, ...(blocks ? { blocks } : {}) } };
  }
  // Both modes always emit IDs. The shared preparation preserves effective
  // block order and allocates each wire/journal identity exactly once.
  return prepareOpenAIChatMisbehavior(plan);
}

function finalizeInteractionsMisbehavior(
  events: InteractionsSSEEvent[],
  plan: MisbehaviorPlan | MisbehaviorSkip,
): InteractionsSSEEvent[] {
  if (plan.kind !== "applied" || plan.summary.fault !== "stop-length-mid-tool") return events;
  // Approved modeled K5 contract: keep the cut arguments and step.stop, then
  // terminate incomplete. Native truncated-tool closure remains unverified.
  return events.map((event) =>
    event.event_type === "interaction.completed" && isJsonObject(event.interaction)
      ? { ...event, interaction: { ...event.interaction, status: "incomplete" } }
      : event,
  );
}

export async function handleGeminiInteractions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  const urlPath = req.url ?? "/v1beta/interactions";

  let interactionsReq: InteractionsRequest;
  try {
    interactionsReq = JSON.parse(raw) as InteractionsRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError("interactions", "validation", {
        message: `Malformed JSON body: ${detail}`,
        code: "INVALID_ARGUMENT",
      }).body,
    );
    return;
  }

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `interactionsReq.stream` throws a TypeError that
  // surfaces as a 500 instead of a 400.
  if (!isJsonObject(interactionsReq)) {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError("interactions", "validation", {
        message: "Request body must be a JSON object",
        code: "INVALID_ARGUMENT",
      }).body,
    );
    return;
  }

  const validationError =
    validateInteractionsInput(interactionsReq.input) ??
    validateInteractionsTools(interactionsReq.tools);
  if (validationError) {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError("interactions", "validation", {
        message: validationError,
        code: "INVALID_ARGUMENT",
      }).body,
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = geminiInteractionsToCompletionRequest(interactionsReq);
  // Keep "chat" rather than "gemini-interactions" — the router's endpoint
  // compatibility filter (router.ts) treats "chat" as a pass-through that
  // matches any unendpointed fixture.  Switching to "gemini-interactions"
  // would make the request fall into the multimedia guard branch, preventing
  // generic chat fixtures from matching and breaking existing users.  The
  // recorder would also start emitting `endpoint: "gemini-interactions"` in
  // recorded fixtures, creating a one-way compatibility break.
  completionReq._endpointType = "chat";
  completionReq._context = getContext(req);

  const streaming = interactionsReq.stream !== false; // default true
  const model = completionReq.model;

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
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
        path: urlPath,
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
    const decisions = resolveRequestDecisions(defaults.strict, req.headers);
    if (decisions.fixtureMiss) {
      const strictStatus = 503;
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      logger.error(strictNoMatchLogLine(req.method ?? "POST", urlPath, skippedBySequenceOrTurn));
      journal.add({
        method: req.method ?? "POST",
        path: urlPath,
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
        renderError("interactions", "strict-miss", {
          message: strictMessage,
          code: "UNAVAILABLE",
        }).body,
      );
      return;
    }
    if (decisions.upstream && defaults.record) {
      const { outcome, clientHungUp } = await withHangUpDetection(req, res, () =>
        proxyAndRecord(
          req,
          res,
          completionReq,
          "gemini-interactions",
          urlPath,
          fixtures,
          defaults,
          raw,
        ),
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: {
            status: res.statusCode ?? 200,
            fixture: null,
            source: "proxy",
            ...proxyInterruption(res, clientHungUp),
          },
        });
        return;
      }
    }
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
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
      renderError("interactions", "fixture-miss", {
        message: "No fixture matched",
        code: "NOT_FOUND",
      }).body,
    );
    return;
  }

  let response = await resolveResponse(fixture, completionReq);
  let misbehavior = planMisbehavior({
    wire: "gemini-interactions",
    fixture,
    response,
    request: completionReq,
    stream: streaming,
    emitsToolCallIds: true,
    defaults,
    rawHeaders: req.headers,
    url: req.url,
  });
  if (misbehavior.kind === "error") {
    const entry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: misbehavior.status, fixture },
    });
    recordMisbehaviorOutcome({ entry, summary: misbehavior.summary, defaults, testId });
    if (!misbehavior.summary?.evaluations.some((evaluation) => evaluation.outcome === "error")) {
      logger.error(`${req.method ?? "POST"} ${urlPath}: ${misbehavior.message}`);
    }
    writeErrorResponse(
      res,
      misbehavior.status,
      renderError("interactions", "misbehavior", {
        message: misbehavior.message,
        code: misbehavior.code,
      }).body,
    );
    return;
  }
  if (misbehavior.kind === "applied") {
    misbehavior = prepareInteractionsMisbehavior(misbehavior, streaming);
    response = misbehavior.response;
  }
  const appliedUsage =
    misbehavior.kind === "applied"
      ? resolveOpenAIChatMisbehaviorUsage(misbehavior, completionReq)
      : undefined;
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);
  const replaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;
  const streamTiming = {
    latency,
    streamingProfile: fixture.streamingProfile,
    recordedTimings: fixture.recordedTimings,
    replaySpeed,
  };
  // Non-streaming replies size their (opt-in) wait from the served payload.
  // An applied plan is merged into `response`, so every JSON site below is a
  // misbehavior path when one applied. Interactions serves no fixture
  // reasoning, so there is no effective reasoning to count.
  const applied = misbehavior.kind === "applied" ? misbehavior : undefined;
  const jsonOpts = () => ({
    surface: "other" as const,
    payloadLength: applied
      ? misbehaviorPayloadLength(applied, undefined)
      : servedPayloadLength(response),
    chunkSize,
    recordedTimings: fixture.recordedTimings,
    duplicateId: !!applied?.duplicateId,
    replaySpeed,
  });
  const markIncomplete = <T extends object>(body: T): T | (T & { status: "incomplete" }) =>
    applied?.summary.fault === "stop-length-mid-tool" ? { ...body, status: "incomplete" } : body;

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
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
    writeErrorResponse(
      res,
      status,
      renderError("interactions", "fixture", {
        message: response.error.message,
        code: response.error.type ?? "ERROR",
      }).body,
      { retryAfter: response.retryAfter },
    );
    return;
  }

  // The content+tool and tool-call branches draw their interaction id after
  // requireEmittedFunctionToolCalls, so a fixture it rejects (a custom tool
  // call or a malformed toolCalls entry) consumes no id. A rejection raised
  // later, inside a builder, comes after the draw and does consume an id:
  // invalid JSON arguments on the non-streaming path, or a malformed block
  // from resolveFixtureBlockOutcome (the streaming path has also consumed
  // event ids by then).

  if (misbehavior.kind === "applied" && misbehavior.summary.fault === "reasoning-only") {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
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
    // Reasoning-only output carries no tool call, so it has no tool-call check
    // to pass before drawing its id.
    const interactionId = nextInteractionId();
    const usage = renderInteractionsUsage({ usage: appliedUsage }, "applied-reasoning-only");
    if (!streaming) {
      const overrides =
        isTextResponse(response) ||
        isToolCallResponse(response) ||
        isCombinedFixtureResponse(response)
          ? extractOverrides(response)
          : undefined;
      const reasoning = misbehavior.reasoning ?? "";
      await deliverJson(
        res,
        journalEntry,
        fixture,
        () => ({
          id: interactionId,
          model: overrides?.model ?? model,
          status: "incomplete",
          steps: [
            {
              type: "thought",
              signature: "",
              summary: [{ type: "text", text: reasoning }],
            },
          ],
          usage,
        }),
        jsonOpts(),
      );
      return;
    }
    const events: InteractionsSSEEvent[] = [
      {
        event_type: "interaction.created",
        interaction: { id: interactionId, status: "in_progress" },
        event_id: nextEventId(),
      },
      { event_type: "step.start", index: 0, step: { type: "thought" }, event_id: nextEventId() },
      {
        event_type: "step.delta",
        index: 0,
        delta: {
          type: "thought_summary",
          content: { type: "text", text: misbehavior.reasoning ?? "" },
        },
        event_id: nextEventId(),
      },
      { event_type: "step.stop", index: 0, event_id: nextEventId() },
      {
        event_type: "interaction.completed",
        interaction: {
          id: interactionId,
          status: "incomplete",
          usage,
        },
        event_id: nextEventId(),
      },
    ];
    await deliverStream(res, journalEntry, fixture, interactionsCodec, events, streamTiming);
    return;
  }

  // Content + tool calls response
  if (isCombinedFixtureResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Gemini Interactions API — ignoring",
      );
    }
    const overrides = {
      ...extractOverrides(response),
      ...(appliedUsage ? { usage: appliedUsage } : {}),
    };
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
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
    const functionToolCalls = requireEmittedFunctionToolCalls(response, "Gemini Interactions");
    const interactionId = nextInteractionId();
    if (!streaming) {
      const content = response.content ?? "";
      const blocks = response.blocks;
      await deliverJson(
        res,
        journalEntry,
        fixture,
        () =>
          markIncomplete(
            buildInteractionsContentWithToolCallsResponse(
              content,
              functionToolCalls,
              model,
              interactionId,
              logger,
              overrides,
              blocks,
            ),
          ),
        jsonOpts(),
      );
    } else {
      const events = buildInteractionsContentWithToolCallsSSEEvents(
        response.content ?? "",
        functionToolCalls,
        interactionId,
        chunkSize,
        logger,
        overrides,
        response.blocks,
      );
      await deliverStream(
        res,
        journalEntry,
        fixture,
        interactionsCodec,
        finalizeInteractionsMisbehavior(events, misbehavior),
        streamTiming,
      );
    }
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Gemini Interactions API — ignoring",
      );
    }
    const overrides = {
      ...extractOverrides(response),
      ...(appliedUsage ? { usage: appliedUsage } : {}),
    };
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
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
    const interactionId = nextInteractionId();
    if (!streaming) {
      const content = response.content;
      await deliverJson(
        res,
        journalEntry,
        fixture,
        () =>
          markIncomplete(buildInteractionsTextResponse(content, model, interactionId, overrides)),
        jsonOpts(),
      );
    } else {
      const events = buildInteractionsTextSSEEvents(
        response.content,
        interactionId,
        chunkSize,
        overrides,
      );
      await deliverStream(
        res,
        journalEntry,
        fixture,
        interactionsCodec,
        finalizeInteractionsMisbehavior(events, misbehavior),
        streamTiming,
      );
    }
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Gemini Interactions API — ignoring",
      );
    }
    const overrides = {
      ...extractOverrides(response),
      ...(appliedUsage ? { usage: appliedUsage } : {}),
    };
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
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
    const functionToolCalls = requireEmittedFunctionToolCalls(response, "Gemini Interactions");
    const interactionId = nextInteractionId();
    if (!streaming) {
      await deliverJson(
        res,
        journalEntry,
        fixture,
        () =>
          markIncomplete(
            buildInteractionsToolCallResponse(
              functionToolCalls,
              model,
              interactionId,
              logger,
              overrides,
            ),
          ),
        jsonOpts(),
      );
    } else {
      const events = buildInteractionsToolCallSSEEvents(
        functionToolCalls,
        interactionId,
        logger,
        overrides,
      );
      await deliverStream(
        res,
        journalEntry,
        fixture,
        interactionsCodec,
        finalizeInteractionsMisbehavior(events, misbehavior),
        streamTiming,
      );
    }
    return;
  }

  // Unknown response type
  const journalEntry = journal.add({
    method: req.method ?? "POST",
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: completionReq,
    response: { status: 500, fixture },
  });
  recordMisbehaviorOutcome({ entry: journalEntry, summary: misbehavior.summary, defaults, testId });
  writeErrorResponse(
    res,
    500,
    renderError("interactions", "unknown-response", {
      message: "Fixture response did not match any known type",
      code: "INTERNAL",
    }).body,
  );
}
