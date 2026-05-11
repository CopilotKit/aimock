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
  HandlerDefaults,
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
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
} from "./helpers.js";
import { matchFixture } from "./router.js";
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

interface InteractionsFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: object;
}

interface InteractionsRequest {
  model?: string;
  input?: string | InteractionsTurn[] | InteractionsContentBlock[];
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
      // Could be Turn[] or Content[]
      const firstItem = req.input[0];
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
  const input = overrides.usage.input_tokens ?? overrides.usage.prompt_tokens ?? 0;
  const output = overrides.usage.output_tokens ?? overrides.usage.completion_tokens ?? 0;
  return {
    total_input_tokens: input,
    total_output_tokens: output,
    total_tokens: input + output,
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
    outputs: [{ type: "text", text: content }],
    usage: interactionsUsage(overrides),
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
    outputs: toolCalls.map((tc) => {
      let argsObj: unknown;
      try {
        argsObj = JSON.parse(tc.arguments || "{}");
      } catch {
        logger.warn(
          `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
        );
        argsObj = {};
      }
      return {
        type: "function_call",
        id: tc.id || generateToolCallId(),
        name: tc.name,
        arguments: argsObj,
      };
    }),
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
): object {
  const outputs: object[] = [{ type: "text", text: content }];
  for (const tc of toolCalls) {
    let argsObj: unknown;
    try {
      argsObj = JSON.parse(tc.arguments || "{}");
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsObj = {};
    }
    outputs.push({
      type: "function_call",
      id: tc.id || generateToolCallId(),
      name: tc.name,
      arguments: argsObj,
    });
  }

  return {
    id: interactionId,
    status: "requires_action",
    model: overrides?.model ?? model,
    role: "model",
    outputs,
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

  // interaction.start
  events.push({
    event_type: "interaction.start",
    interaction: { id: interactionId, status: "in_progress" },
    event_id: nextEventId(),
  });

  // content.start
  events.push({
    event_type: "content.start",
    index: 0,
    content: { type: "text" },
    event_id: nextEventId(),
  });

  // content.delta(s)
  if (content.length === 0) {
    events.push({
      event_type: "content.delta",
      index: 0,
      delta: { type: "text", text: "" },
      event_id: nextEventId(),
    });
  } else {
    for (let i = 0; i < content.length; i += chunkSize) {
      const slice = content.slice(i, i + chunkSize);
      events.push({
        event_type: "content.delta",
        index: 0,
        delta: { type: "text", text: slice },
        event_id: nextEventId(),
      });
    }
  }

  // content.stop
  events.push({
    event_type: "content.stop",
    index: 0,
    event_id: nextEventId(),
  });

  // interaction.complete
  events.push({
    event_type: "interaction.complete",
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

  // interaction.start
  events.push({
    event_type: "interaction.start",
    interaction: { id: interactionId, status: "in_progress" },
    event_id: nextEventId(),
  });

  // Each tool call gets its own content.start/delta/stop bracket
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
      event_type: "content.start",
      index: idx,
      content: { type: "function_call" },
      event_id: nextEventId(),
    });

    events.push({
      event_type: "content.delta",
      index: idx,
      delta: {
        type: "function_call",
        id: tc.id || generateToolCallId(),
        name: tc.name,
        arguments: argsObj,
      },
      event_id: nextEventId(),
    });

    events.push({
      event_type: "content.stop",
      index: idx,
      event_id: nextEventId(),
    });
  }

  // interaction.complete
  events.push({
    event_type: "interaction.complete",
    interaction: {
      id: interactionId,
      status: "requires_action",
      usage: interactionsUsage(overrides),
    },
    event_id: nextEventId(),
  });

  return events;
}

export function buildInteractionsContentWithToolCallsSSEEvents(
  content: string,
  toolCalls: ToolCall[],
  interactionId: string,
  chunkSize: number,
  logger: Logger,
  overrides?: ResponseOverrides,
): InteractionsSSEEvent[] {
  const events: InteractionsSSEEvent[] = [];

  // interaction.start
  events.push({
    event_type: "interaction.start",
    interaction: { id: interactionId, status: "in_progress" },
    event_id: nextEventId(),
  });

  // Text content at index 0
  events.push({
    event_type: "content.start",
    index: 0,
    content: { type: "text" },
    event_id: nextEventId(),
  });

  if (content.length === 0) {
    events.push({
      event_type: "content.delta",
      index: 0,
      delta: { type: "text", text: "" },
      event_id: nextEventId(),
    });
  } else {
    for (let i = 0; i < content.length; i += chunkSize) {
      const slice = content.slice(i, i + chunkSize);
      events.push({
        event_type: "content.delta",
        index: 0,
        delta: { type: "text", text: slice },
        event_id: nextEventId(),
      });
    }
  }

  events.push({
    event_type: "content.stop",
    index: 0,
    event_id: nextEventId(),
  });

  // Tool calls at index 1+
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const idx = i + 1; // offset by 1 because text is index 0
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
      event_type: "content.start",
      index: idx,
      content: { type: "function_call" },
      event_id: nextEventId(),
    });

    events.push({
      event_type: "content.delta",
      index: idx,
      delta: {
        type: "function_call",
        id: tc.id || generateToolCallId(),
        name: tc.name,
        arguments: argsObj,
      },
      event_id: nextEventId(),
    });

    events.push({
      event_type: "content.stop",
      index: idx,
      event_id: nextEventId(),
    });
  }

  // interaction.complete
  events.push({
    event_type: "interaction.complete",
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
    // Data-only SSE (no event: prefix, no [DONE])
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    onChunkSent?.();
    if (signal?.aborted) return false;
    chunkIndex++;
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
  completionReq._endpointType = "chat";

  const streaming = interactionsReq.stream !== false; // default true
  const model = completionReq.model;

  const testId = getTestId(req);
  const fixture = matchFixture(
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
      if (outcome === "relayed") {
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
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const strictStatus = effectiveStrict ? 503 : 404;
    const strictMessage = effectiveStrict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (effectiveStrict) {
      logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${urlPath}`);
    }
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
      JSON.stringify(
        buildInteractionsErrorResponse(
          strictMessage,
          effectiveStrict ? "UNAVAILABLE" : "NOT_FOUND",
        ),
      ),
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
        response.content,
        response.toolCalls,
        model,
        interactionId,
        logger,
        overrides,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildInteractionsContentWithToolCallsSSEEvents(
        response.content,
        response.toolCalls,
        interactionId,
        chunkSize,
        logger,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeGeminiInteractionsSSEStream(res, events, {
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
