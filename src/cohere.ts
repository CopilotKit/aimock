/**
 * Cohere v2 Chat API endpoint support.
 *
 * Translates incoming /v2/chat requests into the ChatCompletionRequest
 * format used by the fixture router, and converts fixture responses back into
 * Cohere's typed SSE streaming (or non-streaming) format.
 *
 * Cohere uses typed SSE events (event: + data: lines), similar to the
 * Claude Messages handler in messages.ts.
 */

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  HandlerDefaults,
  RecordedTimings,
  ResponseOverrides,
  StreamingProfile,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  generateMessageId,
  generateToolCallId,
  generateDeterministicEmbedding,
  extractOverrides,
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isEmbeddingResponse,
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
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse, delay, calculateDelay } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Cohere v2 Chat request types ───────────────────────────────────────────

interface CohereToolCallDef {
  id?: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface CohereContentPart {
  type: string;
  text?: string;
}

interface CohereMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | CohereContentPart[];
  tool_call_id?: string;
  tool_calls?: CohereToolCallDef[];
}

// OpenAI-style tool definition (wrapped in { type: "function", function: { ... } })
interface CohereToolDefOpenAI {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

// Cohere v2 native tool definition (flat: { name, description, parameter_definitions })
interface CohereToolDefNative {
  name: string;
  description?: string;
  parameter_definitions?: object;
}

type CohereToolDef = CohereToolDefOpenAI | CohereToolDefNative;

interface CohereRequest {
  model: string;
  messages: CohereMessage[];
  stream?: boolean;
  tools?: CohereToolDef[];
  response_format?: { type: string; json_schema?: object };
  temperature?: number;
  max_tokens?: number;
}

// ─── Cohere SSE event types ─────────────────────────────────────────────────

interface CohereSSEEvent {
  type: string;
  [key: string]: unknown;
}

// ─── Zero-value usage block ─────────────────────────────────────────────────

const ZERO_USAGE = {
  billed_units: { input_tokens: 0, output_tokens: 0, search_units: 0, classifications: 0 },
  tokens: { input_tokens: 0, output_tokens: 0 },
};

// ─── Cohere finish reason / usage mapping ──────────────────────────────────

function cohereFinishReason(
  overrideFinishReason: string | undefined,
  defaultReason: string,
): string {
  if (!overrideFinishReason) return defaultReason;
  if (overrideFinishReason === "stop") return "COMPLETE";
  if (overrideFinishReason === "tool_calls") return "TOOL_CALL";
  if (overrideFinishReason === "length") return "MAX_TOKENS";
  return overrideFinishReason;
}

function cohereUsage(overrides?: ResponseOverrides): typeof ZERO_USAGE {
  if (!overrides?.usage) return ZERO_USAGE;
  const inputTokens = overrides.usage.input_tokens ?? overrides.usage.prompt_tokens ?? 0;
  const outputTokens = overrides.usage.output_tokens ?? overrides.usage.completion_tokens ?? 0;
  return {
    billed_units: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      search_units: 0,
      classifications: 0,
    },
    tokens: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ─── Input conversion: Cohere → ChatCompletionRequest ───────────────────────

/** Extract plain text from structured content (array of { type, text } parts) or passthrough string. */
function extractTextContent(content: string | CohereContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && part.text !== undefined)
    .map((part) => part.text!)
    .join("");
}

/** Type guard: is this an OpenAI-style tool definition (has `function` key)? */
function isOpenAIToolDef(t: CohereToolDef): t is CohereToolDefOpenAI {
  return "function" in t && typeof (t as CohereToolDefOpenAI).function === "object";
}

export function cohereToCompletionRequest(req: CohereRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  for (const msg of req.messages) {
    const textContent = extractTextContent(msg.content);
    if (msg.role === "system") {
      messages.push({ role: "system", content: textContent });
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: textContent });
    } else if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        messages.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id ?? generateToolCallId(),
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        });
      } else {
        messages.push({ role: "assistant", content: textContent });
      }
    } else if (msg.role === "tool") {
      messages.push({
        role: "tool",
        content: textContent,
        tool_call_id: msg.tool_call_id,
      });
    }
  }

  // Convert tools — accept both OpenAI format and Cohere v2 native format
  let tools: ToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => {
      if (isOpenAIToolDef(t)) {
        return {
          type: "function" as const,
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        };
      }
      // Cohere v2 native format: { name, description, parameter_definitions }
      return {
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameter_definitions,
        },
      };
    });
  }

  return {
    model: req.model,
    messages,
    stream: req.stream,
    tools,
    ...(req.response_format && { response_format: req.response_format }),
    ...(req.temperature !== undefined && { temperature: req.temperature }),
    ...(req.max_tokens !== undefined && { max_tokens: req.max_tokens }),
  };
}

// ─── Response building: fixture → Cohere v2 Chat format ─────────────────────

// Non-streaming text response
function buildCohereTextResponse(
  content: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
): object {
  const contentBlocks: { type: string; text: string }[] = [];
  if (reasoning) {
    contentBlocks.push({ type: "text", text: reasoning });
  }
  contentBlocks.push({ type: "text", text: content });

  return {
    id: overrides?.id ?? generateMessageId(),
    finish_reason: cohereFinishReason(overrides?.finishReason, "COMPLETE"),
    message: {
      role: "assistant",
      content: contentBlocks,
      tool_calls: [],
      tool_plan: "",
      citations: [],
    },
    usage: cohereUsage(overrides),
  };
}

// Non-streaming tool call response
function buildCohereToolCallResponse(
  toolCalls: ToolCall[],
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
): object {
  const cohereCalls = toolCalls.map((tc) => {
    // Validate arguments JSON
    let argsJson: string;
    try {
      JSON.parse(tc.arguments || "{}");
      argsJson = tc.arguments || "{}";
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsJson = "{}";
    }
    return {
      id: tc.id || generateToolCallId(),
      type: "function",
      function: {
        name: tc.name,
        arguments: argsJson,
      },
    };
  });

  // Reasoning as a leading text block (Cohere has no native reasoning type)
  const contentBlocks: { type: string; text: string }[] = [];
  if (reasoning) {
    contentBlocks.push({ type: "text", text: reasoning });
  }

  return {
    id: overrides?.id ?? generateMessageId(),
    finish_reason: cohereFinishReason(overrides?.finishReason, "TOOL_CALL"),
    message: {
      role: "assistant",
      content: contentBlocks,
      tool_calls: cohereCalls,
      tool_plan: "",
      citations: [],
    },
    usage: cohereUsage(overrides),
  };
}

// Non-streaming content + tool calls response
function buildCohereContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
): object {
  const cohereCalls = toolCalls.map((tc) => {
    let argsJson: string;
    try {
      JSON.parse(tc.arguments || "{}");
      argsJson = tc.arguments || "{}";
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsJson = "{}";
    }
    return {
      id: tc.id || generateToolCallId(),
      type: "function",
      function: {
        name: tc.name,
        arguments: argsJson,
      },
    };
  });

  const contentBlocks: { type: string; text: string }[] = [];
  if (reasoning) {
    contentBlocks.push({ type: "text", text: reasoning });
  }
  contentBlocks.push({ type: "text", text: content });

  return {
    id: overrides?.id ?? generateMessageId(),
    finish_reason: cohereFinishReason(overrides?.finishReason, "TOOL_CALL"),
    message: {
      role: "assistant",
      content: contentBlocks,
      tool_calls: cohereCalls,
      tool_plan: "",
      citations: [],
    },
    usage: cohereUsage(overrides),
  };
}

// ─── Streaming event builders ───────────────────────────────────────────────

function buildCohereTextStreamEvents(
  content: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
): CohereSSEEvent[] {
  const msgId = overrides?.id ?? generateMessageId();
  const events: CohereSSEEvent[] = [];

  // message-start
  events.push({
    id: msgId,
    type: "message-start",
    delta: {
      message: {
        role: "assistant",
        content: [],
        tool_plan: "",
        tool_calls: [],
        citations: [],
      },
    },
  });

  let contentIndex = 0;

  // Reasoning as a text block before main content (Cohere has no native reasoning type)
  if (reasoning) {
    events.push({
      type: "content-start",
      index: contentIndex,
      delta: { message: { content: { type: "text" } } },
    });
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      events.push({
        type: "content-delta",
        index: contentIndex,
        delta: { message: { content: { type: "text", text: slice } } },
      });
    }
    events.push({ type: "content-end", index: contentIndex });
    contentIndex++;
  }

  // content-start (type: "text" only, no text field)
  events.push({
    type: "content-start",
    index: contentIndex,
    delta: {
      message: {
        content: { type: "text" },
      },
    },
  });

  // content-delta — text chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    events.push({
      type: "content-delta",
      index: contentIndex,
      delta: {
        message: {
          content: { type: "text", text: slice },
        },
      },
    });
  }

  // content-end
  events.push({
    type: "content-end",
    index: contentIndex,
  });

  // message-end
  events.push({
    type: "message-end",
    delta: {
      finish_reason: cohereFinishReason(overrides?.finishReason, "COMPLETE"),
      usage: cohereUsage(overrides),
    },
  });

  return events;
}

function buildCohereToolCallStreamEvents(
  toolCalls: ToolCall[],
  chunkSize: number,
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
): CohereSSEEvent[] {
  const msgId = overrides?.id ?? generateMessageId();
  const events: CohereSSEEvent[] = [];

  // message-start
  events.push({
    id: msgId,
    type: "message-start",
    delta: {
      message: {
        role: "assistant",
        content: [],
        tool_plan: "",
        tool_calls: [],
        citations: [],
      },
    },
  });

  // Reasoning as a text block before the tool plan (Cohere has no native reasoning type)
  if (reasoning) {
    events.push({
      type: "content-start",
      index: 0,
      delta: { message: { content: { type: "text" } } },
    });
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      events.push({
        type: "content-delta",
        index: 0,
        delta: { message: { content: { type: "text", text: slice } } },
      });
    }
    events.push({ type: "content-end", index: 0 });
  }

  // tool-plan-delta
  events.push({
    type: "tool-plan-delta",
    delta: {
      message: {
        tool_plan: "I will use the requested tool.",
      },
    },
  });

  for (let idx = 0; idx < toolCalls.length; idx++) {
    const tc = toolCalls[idx];
    const callId = tc.id || generateToolCallId();

    // Validate arguments JSON
    let argsJson: string;
    try {
      JSON.parse(tc.arguments || "{}");
      argsJson = tc.arguments || "{}";
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsJson = "{}";
    }

    // tool-call-start
    events.push({
      type: "tool-call-start",
      index: idx,
      delta: {
        message: {
          tool_calls: {
            id: callId,
            type: "function",
            function: {
              name: tc.name,
              arguments: "",
            },
          },
        },
      },
    });

    // tool-call-delta — chunked arguments
    for (let i = 0; i < argsJson.length; i += chunkSize) {
      const slice = argsJson.slice(i, i + chunkSize);
      events.push({
        type: "tool-call-delta",
        index: idx,
        delta: {
          message: {
            tool_calls: {
              function: {
                arguments: slice,
              },
            },
          },
        },
      });
    }

    // tool-call-end
    events.push({
      type: "tool-call-end",
      index: idx,
    });
  }

  // message-end
  events.push({
    type: "message-end",
    delta: {
      finish_reason: cohereFinishReason(overrides?.finishReason, "TOOL_CALL"),
      usage: cohereUsage(overrides),
    },
  });

  return events;
}

function buildCohereContentWithToolCallsStreamEvents(
  content: string,
  toolCalls: ToolCall[],
  chunkSize: number,
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
): CohereSSEEvent[] {
  const msgId = overrides?.id ?? generateMessageId();
  const events: CohereSSEEvent[] = [];

  // message-start
  events.push({
    id: msgId,
    type: "message-start",
    delta: {
      message: {
        role: "assistant",
        content: [],
        tool_plan: "",
        tool_calls: [],
        citations: [],
      },
    },
  });

  let contentIndex = 0;

  // Reasoning as a text block before main content
  if (reasoning) {
    events.push({
      type: "content-start",
      index: contentIndex,
      delta: { message: { content: { type: "text" } } },
    });
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      events.push({
        type: "content-delta",
        index: contentIndex,
        delta: { message: { content: { type: "text", text: slice } } },
      });
    }
    events.push({ type: "content-end", index: contentIndex });
    contentIndex++;
  }

  // content-start (type: "text" only, no text field)
  events.push({
    type: "content-start",
    index: contentIndex,
    delta: {
      message: {
        content: { type: "text" },
      },
    },
  });

  // content-delta — text chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    events.push({
      type: "content-delta",
      index: contentIndex,
      delta: {
        message: {
          content: { type: "text", text: slice },
        },
      },
    });
  }

  // content-end
  events.push({
    type: "content-end",
    index: contentIndex,
  });

  // tool-plan-delta
  events.push({
    type: "tool-plan-delta",
    delta: {
      message: {
        tool_plan: "I will use the requested tool.",
      },
    },
  });

  // Tool call events
  for (let idx = 0; idx < toolCalls.length; idx++) {
    const tc = toolCalls[idx];
    const callId = tc.id || generateToolCallId();

    let argsJson: string;
    try {
      JSON.parse(tc.arguments || "{}");
      argsJson = tc.arguments || "{}";
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsJson = "{}";
    }

    // tool-call-start
    events.push({
      type: "tool-call-start",
      index: idx,
      delta: {
        message: {
          tool_calls: {
            id: callId,
            type: "function",
            function: {
              name: tc.name,
              arguments: "",
            },
          },
        },
      },
    });

    // tool-call-delta — chunked arguments
    for (let i = 0; i < argsJson.length; i += chunkSize) {
      const slice = argsJson.slice(i, i + chunkSize);
      events.push({
        type: "tool-call-delta",
        index: idx,
        delta: {
          message: {
            tool_calls: {
              function: {
                arguments: slice,
              },
            },
          },
        },
      });
    }

    // tool-call-end
    events.push({
      type: "tool-call-end",
      index: idx,
    });
  }

  // message-end
  events.push({
    type: "message-end",
    delta: {
      finish_reason: cohereFinishReason(overrides?.finishReason, "TOOL_CALL"),
      usage: cohereUsage(overrides),
    },
  });

  return events;
}

// ─── SSE writer for Cohere typed events ─────────────────────────────────────

interface CohereStreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
  recordedTimings?: RecordedTimings;
  replaySpeed?: number;
  signal?: AbortSignal;
  onChunkSent?: () => void;
}

async function writeCohereSSEStream(
  res: http.ServerResponse,
  events: CohereSSEEvent[],
  optionsOrLatency?: number | CohereStreamOptions,
): Promise<boolean> {
  const opts: CohereStreamOptions =
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

export async function handleCohere(
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

  let cohereReq: CohereRequest;
  try {
    cohereReq = JSON.parse(raw) as CohereRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: `Malformed JSON body: ${detail}`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Validate required model field
  if (!cohereReq.model) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "model is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!cohereReq.messages || !Array.isArray(cohereReq.messages)) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Invalid request: messages array is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = cohereToCompletionRequest(cohereReq);
  completionReq._endpointType = "chat";
  completionReq._context = getContext(req);

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
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
        path: req.url ?? "/v2/chat",
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
      logger.error(
        strictNoMatchLogLine(req.method ?? "POST", req.url ?? "/v2/chat", skippedBySequenceOrTurn),
      );
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/v2/chat",
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
        "cohere",
        req.url ?? "/v2/chat",
        fixtures,
        defaults,
        raw,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: req.url ?? "/v2/chat",
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
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
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, serializeErrorResponse(response), {
      retryAfter: response.retryAfter,
    });
    return;
  }

  // Content + tool calls response (must be checked before text/tool-only branches)
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Cohere v2 Chat API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      cohereReq.model,
      effectiveStrict,
      logger,
    );
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (cohereReq.stream !== true) {
      const body = buildCohereContentWithToolCallsResponse(
        response.content,
        response.toolCalls,
        logger,
        effReasoning,
        overrides,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildCohereContentWithToolCallsStreamEvents(
        response.content,
        response.toolCalls,
        chunkSize,
        logger,
        effReasoning,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeCohereSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
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
        "webSearches in fixture response are not supported for Cohere v2 Chat API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      cohereReq.model,
      effectiveStrict,
      logger,
    );
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (cohereReq.stream !== true) {
      const body = buildCohereTextResponse(response.content, effReasoning, overrides);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildCohereTextStreamEvents(
        response.content,
        chunkSize,
        effReasoning,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeCohereSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
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
        "webSearches in fixture response are not supported for Cohere v2 Chat API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      cohereReq.model,
      effectiveStrict,
      logger,
    );
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (cohereReq.stream !== true) {
      const body = buildCohereToolCallResponse(response.toolCalls, logger, effReasoning, overrides);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildCohereToolCallStreamEvents(
        response.toolCalls,
        chunkSize,
        logger,
        effReasoning,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeCohereSSEStream(res, events, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
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
    path: req.url ?? "/v2/chat",
    headers: flattenHeaders(req.headers),
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

// ─── Cohere v2 Embed API types ────────────────────────────────────────────

interface CohereEmbedRequest {
  texts: string[];
  model: string;
  input_type?: string;
  embedding_types?: string[];
  truncate?: string;
}

interface CohereEmbedResponse {
  id: string;
  texts: string[];
  embeddings: Record<string, number[][]>;
  meta: { api_version: { version: string } };
}

// ─── Cohere Embed handler ─────────────────────────────────────────────────

export async function handleCohereEmbed(
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

  let embedReq: CohereEmbedRequest;
  try {
    embedReq = JSON.parse(raw) as CohereEmbedRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/embed",
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: `Malformed JSON body: ${detail}`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Validate required fields
  if (!embedReq.model) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/embed",
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "model is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!embedReq.texts || !Array.isArray(embedReq.texts)) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/embed",
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Invalid request: texts array is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Concatenate all texts for fixture matching
  const combinedInput = embedReq.texts.join(" ");

  // Build a synthetic ChatCompletionRequest for the fixture router
  const syntheticReq: ChatCompletionRequest = {
    model: embedReq.model,
    messages: [],
    embeddingInput: combinedInput,
    _endpointType: "embedding",
    _context: getContext(req),
  };

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    syntheticReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
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
        path: req.url ?? "/v2/embed",
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
      },
      fixture ? "fixture" : "proxy",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  // Determine requested embedding types (default to float)
  const embeddingTypes =
    embedReq.embedding_types && embedReq.embedding_types.length > 0
      ? embedReq.embedding_types
      : ["float"];

  if (fixture) {
    const response = await resolveResponse(fixture, syntheticReq);

    // Error response
    if (isErrorResponse(response)) {
      const status = response.status ?? 500;
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/v2/embed",
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status, fixture },
      });
      writeErrorResponse(res, status, serializeErrorResponse(response), {
        retryAfter: response.retryAfter,
      });
      return;
    }

    // Embedding response — use the fixture's embedding for each input text
    if (isEmbeddingResponse(response)) {
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/v2/embed",
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: 200, fixture },
      });
      const vectors = embedReq.texts.map(() => [...response.embedding]);
      const embeddings: Record<string, number[][]> = {};
      for (const t of embeddingTypes) {
        embeddings[t] = vectors;
      }
      const body: CohereEmbedResponse = {
        id: generateMessageId(),
        texts: embedReq.texts,
        embeddings,
        meta: { api_version: { version: "2" } },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Fixture matched but response type is not compatible with embeddings
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/embed",
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    writeErrorResponse(
      res,
      500,
      JSON.stringify({
        error: {
          message:
            "Fixture response did not match any known embedding type (must have embedding or error)",
          type: "server_error",
        },
      }),
    );
    return;
  }

  // No fixture match — check strict mode
  if (resolveStrictMode(defaults.strict, req.headers)) {
    const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
    logger.error(
      strictNoMatchLogLine(req.method ?? "POST", req.url ?? "/v2/embed", skippedBySequenceOrTurn),
    );
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/embed",
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: 503,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      503,
      JSON.stringify({
        error: {
          message: strictMessage,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Try record-and-replay proxy
  if (defaults.record) {
    const outcome = await proxyAndRecord(
      req,
      res,
      syntheticReq,
      "cohere",
      req.url ?? "/v2/embed",
      fixtures,
      defaults,
      raw,
    );
    if (outcome === "handled_by_hook") return;
    if (outcome !== "not_configured") {
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/v2/embed",
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
      });
      return;
    }
  }

  // No fixture match — generate deterministic embeddings from input texts
  logger.warn(
    `No embedding fixture matched for "${combinedInput.slice(0, 80)}" — returning deterministic fallback`,
  );
  const dimensions = 1024; // Cohere embed-v4.0 default
  const vectors = embedReq.texts.map((text) => generateDeterministicEmbedding(text, dimensions));
  const embeddings: Record<string, number[][]> = {};
  for (const t of embeddingTypes) {
    embeddings[t] = vectors;
  }

  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/v2/embed",
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture: null },
  });

  const body: CohereEmbedResponse = {
    id: generateMessageId(),
    texts: embedReq.texts,
    embeddings,
    meta: { api_version: { version: "2" } },
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
