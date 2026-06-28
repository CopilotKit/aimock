/**
 * Google Gemini Interactions API support.
 *
 * Translates incoming Interactions requests into the ChatCompletionRequest
 * format used by the fixture router, and converts fixture responses back
 * into the Gemini Interactions format — either a single JSON response or
 * an SSE stream with event_type-based framing.
 */

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
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  extractOverrides,
  generateToolCallId,
  flattenHeaders,
  getTestId,
  getContext,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
  strictNoMatchMessage,
  strictNoMatchLogLine,
  resolveFixtureBlocks,
} from "./helpers.js";
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse, delay, calculateDelay } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

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
  if (!overrides?.usage) return { total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0 };
  const input =
    overrides.usage.input_tokens ??
    overrides.usage.prompt_tokens ??
    overrides.usage.promptTokenCount ??
    0;
  const output =
    overrides.usage.output_tokens ??
    overrides.usage.completion_tokens ??
    overrides.usage.candidatesTokenCount ??
    0;
  const total = overrides.usage.total_tokens ?? overrides.usage.totalTokenCount ?? input + output;
  return {
    total_input_tokens: input,
    total_output_tokens: output,
    total_tokens: total,
  };
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
// reusing the existing malformed-arguments guard (logger.warn + {} fallback).
function buildFunctionCallStep(tc: ToolCall, logger: Logger): object {
  let argsObj: unknown;
  try {
    argsObj = JSON.parse(tc.arguments || "{}");
  } catch {
    logger.warn(`Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`);
    argsObj = {};
  }
  return {
    type: "function_call",
    id: tc.id || generateToolCallId(),
    name: tc.name,
    arguments: argsObj,
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

  if (blocks && blocks.length > 0) {
    // NEW PATH: the non-stream `steps[]` array is index/step-addressed and
    // ordered, so emit one step per block in fixture ARRAY ORDER. A toolCall
    // block placed before a text block therefore yields a function_call step
    // ahead of the model_output step — tool-first, the opposite of the legacy
    // (text-step-always-first) shape below.
    const ordered = resolveFixtureBlocks(blocks);
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
    status: "requires_action",
    model: overrides?.model ?? model,
    role: "model",
    output_text: outputText,
    steps,
    usage: interactionsUsage(overrides),
  };
}

function buildInteractionsErrorResponse(message: string, code?: string): object {
  return {
    error: {
      code: code ?? "INVALID_ARGUMENT",
      message,
    },
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
    let argsObj: unknown;
    try {
      argsObj = JSON.parse(tc.arguments || "{}");
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsObj = {};
    }

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
        arguments: JSON.stringify(argsObj),
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
  let argsObj: unknown;
  try {
    argsObj = JSON.parse(tc.arguments || "{}");
  } catch {
    logger.warn(`Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`);
    argsObj = {};
  }

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
      arguments: JSON.stringify(argsObj),
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

  if (blocks && blocks.length > 0) {
    // NEW PATH: stream one step per block in fixture ARRAY ORDER. The step
    // `index` increments with array position, so a toolCall block before a text
    // block yields a function_call step at a LOWER index than the model_output
    // step — tool-first, the opposite of the legacy (text-at-index-0) shape.
    const ordered = resolveFixtureBlocks(blocks);
    let idx = 0;
    for (const block of ordered) {
      if (block.type === "text") {
        pushTextStepEvents(events, idx, block.text, chunkSize);
      } else {
        pushFunctionCallStepEvents(
          events,
          idx,
          { name: block.name, arguments: block.arguments, id: block.id },
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
      status: "requires_action",
      usage: interactionsUsage(overrides),
    },
    event_id: nextEventId(),
  });

  return events;
}

// ─── SSE writer for Interactions streaming ────────────────────────────────

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
    // Data-only SSE (no event: prefix, no [DONE])
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // Only count step deltas for truncateAfterChunks — framing events
    // (interaction.created, step.start, step.stop, interaction.completed)
    // should not consume chunk budget or trigger the chunk-sent callback.
    if (event.event_type === "step.delta") {
      onChunkSent?.();
      chunkIndex++;
    }
    if (signal?.aborted) return false;
  }

  if (!res.writableEnded) {
    res.end();
  }
  return true;
}

// ─── Request handler ──────────────────────────────────────────────────────

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
      JSON.stringify(
        buildInteractionsErrorResponse(`Malformed JSON body: ${detail}`, "INVALID_ARGUMENT"),
      ),
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
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
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
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    if (effectiveStrict) {
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
        JSON.stringify(buildInteractionsErrorResponse(strictMessage, "UNAVAILABLE")),
      );
      return;
    }
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        completionReq,
        "gemini-interactions",
        urlPath,
        fixtures,
        defaults,
        raw,
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
      JSON.stringify(buildInteractionsErrorResponse("No fixture matched", "NOT_FOUND")),
    );
    return;
  }

  const response = await resolveResponse(fixture, completionReq);
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);
  const replaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    writeErrorResponse(
      res,
      status,
      JSON.stringify(
        buildInteractionsErrorResponse(response.error.message, response.error.type ?? "ERROR"),
      ),
      { retryAfter: response.retryAfter },
    );
    return;
  }

  const interactionId = nextInteractionId();

  // Content + tool calls response
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Gemini Interactions API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildInteractionsContentWithToolCallsResponse(
        response.content ?? "",
        response.toolCalls ?? [],
        model,
        interactionId,
        logger,
        overrides,
        response.blocks,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildInteractionsContentWithToolCallsSSEEvents(
        response.content ?? "",
        response.toolCalls ?? [],
        interactionId,
        chunkSize,
        logger,
        overrides,
        response.blocks,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeGeminiInteractionsSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed,
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
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Gemini Interactions API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildInteractionsTextResponse(response.content, model, interactionId, overrides);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildInteractionsTextSSEEvents(
        response.content,
        interactionId,
        chunkSize,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeGeminiInteractionsSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed,
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
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Gemini Interactions API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildInteractionsToolCallResponse(
        response.toolCalls,
        model,
        interactionId,
        logger,
        overrides,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildInteractionsToolCallSSEEvents(
        response.toolCalls,
        interactionId,
        logger,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeGeminiInteractionsSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed,
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
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: completionReq,
    response: { status: 500, fixture },
  });
  writeErrorResponse(
    res,
    500,
    JSON.stringify(
      buildInteractionsErrorResponse("Fixture response did not match any known type", "INTERNAL"),
    ),
  );
}
