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
  StreamingProfile,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  generateMessageId,
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
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Cohere v2 Chat request types ───────────────────────────────────────────

interface CohereMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
}

interface CohereToolDef {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

interface CohereRequest {
  model: string;
  messages: CohereMessage[];
  stream?: boolean;
  tools?: CohereToolDef[];
  response_format?: { type: string; json_schema?: object };
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

// ─── Input conversion: Cohere → ChatCompletionRequest ───────────────────────

export function cohereToCompletionRequest(req: CohereRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  for (const msg of req.messages) {
    if (msg.role === "system") {
      messages.push({ role: "system", content: msg.content });
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: msg.content });
    } else if (msg.role === "tool") {
      messages.push({
        role: "tool",
        content: msg.content,
        tool_call_id: msg.tool_call_id,
      });
    }
  }

  // Convert tools
  let tools: ToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
  }

  return {
    model: req.model,
    messages,
    stream: req.stream,
    tools,
  };
}

// ─── Response building: fixture → Cohere v2 Chat format ─────────────────────

// Non-streaming text response
function buildCohereTextResponse(content: string): object {
  return {
    id: generateMessageId(),
    finish_reason: "COMPLETE",
    message: {
      role: "assistant",
      content: [{ type: "text", text: content }],
      tool_calls: [],
      tool_plan: "",
      citations: [],
    },
    usage: ZERO_USAGE,
  };
}

// Non-streaming tool call response
function buildCohereToolCallResponse(toolCalls: ToolCall[], logger: Logger): object {
  const cohereCalls = toolCalls.map((tc) => {
    // Validate arguments JSON
    try {
      JSON.parse(tc.arguments || "{}");
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
    }
    return {
      id: tc.id || generateToolCallId(),
      type: "function",
      function: {
        name: tc.name,
        arguments: tc.arguments || "{}",
      },
    };
  });

  return {
    id: generateMessageId(),
    finish_reason: "TOOL_CALL",
    message: {
      role: "assistant",
      content: [],
      tool_calls: cohereCalls,
      tool_plan: "",
      citations: [],
    },
    usage: ZERO_USAGE,
  };
}

// ─── Streaming event builders ───────────────────────────────────────────────

function buildCohereTextStreamEvents(content: string, chunkSize: number): CohereSSEEvent[] {
  const msgId = generateMessageId();
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

  // content-start (type: "text" only, no text field)
  events.push({
    type: "content-start",
    index: 0,
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
      index: 0,
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
    index: 0,
  });

  // message-end
  events.push({
    type: "message-end",
    delta: {
      finish_reason: "COMPLETE",
      usage: ZERO_USAGE,
    },
  });

  return events;
}

function buildCohereToolCallStreamEvents(
  toolCalls: ToolCall[],
  chunkSize: number,
  logger: Logger,
): CohereSSEEvent[] {
  const msgId = generateMessageId();
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
      finish_reason: "TOOL_CALL",
      usage: ZERO_USAGE,
    },
  });

  return events;
}

// ─── SSE writer for Cohere typed events ─────────────────────────────────────

interface CohereStreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
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
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: {} as ChatCompletionRequest,
      response: { status: 400, fixture: null },
    });
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

  // Validate required model field
  if (!cohereReq.model) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: {} as ChatCompletionRequest,
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
      body: {} as ChatCompletionRequest,
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
        path: req.url ?? "/v2/chat",
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
        "cohere",
        req.url ?? "/v2/chat",
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
        journal.add({
          method: req.method ?? "POST",
          path: req.url ?? "/v2/chat",
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
      logger.error(
        `STRICT: No fixture matched for ${req.method ?? "POST"} ${req.url ?? "/v2/chat"}`,
      );
    }
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/chat",
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
      path: req.url ?? "/v2/chat",
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
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (cohereReq.stream !== true) {
      const body = buildCohereTextResponse(response.content);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildCohereTextStreamEvents(response.content, chunkSize);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeCohereSSEStream(res, events, {
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
      path: req.url ?? "/v2/chat",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (cohereReq.stream !== true) {
      const body = buildCohereToolCallResponse(response.toolCalls, logger);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildCohereToolCallStreamEvents(response.toolCalls, chunkSize, logger);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeCohereSSEStream(res, events, {
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
