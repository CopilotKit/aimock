/**
 * AWS Bedrock Claude endpoint support — invoke and invoke-with-response-stream.
 *
 * Handles four Bedrock endpoint families (split across two modules):
 *
 *   This file (bedrock.ts):
 *     - POST /model/{modelId}/invoke                  — non-streaming invoke
 *     - POST /model/{modelId}/invoke-with-response-stream — binary EventStream streaming
 *
 *   bedrock-converse.ts:
 *     - POST /model/{modelId}/converse                — Converse API (non-streaming)
 *     - POST /model/{modelId}/converse-stream         — Converse API (EventStream streaming)
 *
 * Translates incoming Bedrock Claude format into the ChatCompletionRequest
 * format used by the fixture router, and converts fixture responses back into
 * the appropriate Bedrock response format (JSON for invoke, AWS Event Stream
 * binary encoding for streaming).
 */

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  HandlerDefaults,
  ResponseOverrides,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  generateMessageId,
  generateToolUseId,
  extractOverrides,
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  flattenHeaders,
  getTestId,
  resolveResponse,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { writeEventStream } from "./aws-event-stream.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Bedrock Claude request types ────────────────────────────────────────────

interface BedrockContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image" | "document";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | BedrockContentBlock[];
  is_error?: boolean;
}

interface BedrockMessage {
  role: "user" | "assistant";
  content: string | BedrockContentBlock[];
}

interface BedrockToolDef {
  name: string;
  description?: string;
  input_schema?: object;
}

interface BedrockRequest {
  anthropic_version?: string;
  messages: BedrockMessage[];
  system?: string | BedrockContentBlock[];
  tools?: BedrockToolDef[];
  tool_choice?: unknown;
  max_tokens: number;
  temperature?: number;
  [key: string]: unknown;
}

// ─── Bedrock stop_reason mapping ───────────────────────────────────────────

function bedrockStopReason(
  overrideFinishReason: string | undefined,
  defaultReason: string,
): string {
  if (!overrideFinishReason) return defaultReason;
  if (overrideFinishReason === "stop") return "end_turn";
  if (overrideFinishReason === "tool_calls") return "tool_use";
  if (overrideFinishReason === "length") return "max_tokens";
  return overrideFinishReason;
}

/**
 * Build a Bedrock-style usage object from optional overrides.
 *
 * When no overrides are provided (the common case for mock fixtures),
 * returns all-zero token counts. This is intentional — aimock does not
 * attempt to estimate token usage from fixture content. Callers that
 * need realistic usage numbers should set `usage` in their fixture's
 * response overrides.
 */
function bedrockUsage(overrides?: ResponseOverrides): {
  input_tokens: number;
  output_tokens: number;
} {
  if (!overrides?.usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: overrides.usage.input_tokens ?? overrides.usage.prompt_tokens ?? 0,
    output_tokens: overrides.usage.output_tokens ?? overrides.usage.completion_tokens ?? 0,
  };
}

// ─── Input conversion: Bedrock → ChatCompletionRequest ──────────────────────

function extractTextContent(content: string | BedrockContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

export function bedrockToCompletionRequest(
  req: BedrockRequest,
  modelId: string,
  logger?: Logger,
): ChatCompletionRequest {
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
        // Warn about non-text content blocks that will be dropped (image, document, etc.)
        const unsupportedBlocks = msg.content.filter(
          (b) => b.type !== "text" && b.type !== "tool_result",
        );
        if (unsupportedBlocks.length > 0 && logger) {
          const types = [...new Set(unsupportedBlocks.map((b) => b.type))].join(", ");
          logger.warn(
            `Bedrock user message contains unsupported content block types [${types}] — these will be dropped during conversion`,
          );
        }

        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const textBlocks = msg.content.filter((b) => b.type === "text");

        if (toolResults.length > 0) {
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
          if (textBlocks.length > 0) {
            messages.push({
              role: "user",
              content: textBlocks.map((b) => b.text ?? "").join(""),
            });
          }
          continue;
        }
      }
      messages.push({
        role: "user",
        content: extractTextContent(msg.content),
      });
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        messages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
        const textContent = extractTextContent(msg.content);

        if (toolUseBlocks.length > 0) {
          messages.push({
            role: "assistant",
            content: textContent ?? null,
            tool_calls: toolUseBlocks.map((b, index) => {
              if (!b.id && logger) {
                logger.warn(
                  `Bedrock assistant tool_use block at index ${index} is missing an id — using deterministic fallback "tool_use_${index}"`,
                );
              }
              return {
                id: b.id ?? `tool_use_${index}`,
                type: "function" as const,
                function: {
                  name: b.name ?? "",
                  arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}),
                },
              };
            }),
          });
        } else {
          messages.push({ role: "assistant", content: textContent ?? null });
        }
      } else {
        messages.push({ role: "assistant", content: null });
      }
    } else {
      if (logger) {
        logger.warn(
          `Bedrock message has unexpected role "${(msg as { role: string }).role}" — skipping`,
        );
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
    model: modelId,
    messages,
    stream: false,
    temperature: req.temperature,
    tools,
  };
}

// ─── Response builders ──────────────────────────────────────────────────────

function buildBedrockTextResponse(
  content: string,
  model: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
): object {
  const contentBlocks: object[] = [];
  if (reasoning) {
    contentBlocks.push({ type: "thinking", thinking: reasoning });
  }
  contentBlocks.push({ type: "text", text: content });

  return {
    id: overrides?.id ?? generateMessageId(),
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: overrides?.model ?? model,
    stop_reason: bedrockStopReason(overrides?.finishReason, "end_turn"),
    stop_sequence: null,
    usage: bedrockUsage(overrides),
  };
}

function buildBedrockToolCallResponse(
  toolCalls: ToolCall[],
  model: string,
  logger: Logger,
  overrides?: ResponseOverrides,
): object {
  return {
    id: overrides?.id ?? generateMessageId(),
    type: "message",
    role: "assistant",
    content: toolCalls.map((tc) => {
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
        type: "tool_use",
        id: tc.id || generateToolUseId(),
        name: tc.name,
        input: argsObj,
      };
    }),
    model: overrides?.model ?? model,
    stop_reason: bedrockStopReason(overrides?.finishReason, "tool_use"),
    stop_sequence: null,
    usage: bedrockUsage(overrides),
  };
}

// ─── Request handler ────────────────────────────────────────────────────────

export async function handleBedrock(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  modelId: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  const urlPath = req.url ?? `/model/${modelId}/invoke`;

  let bedrockReq: BedrockRequest;
  try {
    bedrockReq = JSON.parse(raw) as BedrockRequest;
  } catch {
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
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!bedrockReq.messages || !Array.isArray(bedrockReq.messages)) {
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
  const completionReq = bedrockToCompletionRequest(bedrockReq, modelId, logger);
  completionReq._endpointType = "chat";

  const testId = getTestId(req);
  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
  }

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
        "bedrock",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }
    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (defaults.strict) {
      logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${urlPath}`);
    }
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
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

  const response = await resolveResponse(fixture, completionReq);

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
    // Bedrock Claude error format: { type: "error", error: { type, message } }
    // Uses ?? (nullish coalescing) intentionally — preserves explicit empty-string types from fixtures.
    const anthropicError = {
      type: "error",
      error: {
        type: response.error.type ?? "api_error",
        message: response.error.message,
      },
    };
    writeErrorResponse(res, status, JSON.stringify(anthropicError));
    return;
  }

  // Content + tool calls response
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Bedrock API — ignoring");
    }
    const overrides = extractOverrides(response);
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const textBody = buildBedrockTextResponse(
      response.content,
      completionReq.model,
      response.reasoning,
      overrides,
    );
    const toolBody = buildBedrockToolCallResponse(
      response.toolCalls,
      completionReq.model,
      logger,
      overrides,
    );
    // Merge: take the text response as base, append tool_use blocks, set stop_reason to tool_use
    const merged = {
      ...(textBody as Record<string, unknown>),
      content: [
        ...((textBody as Record<string, unknown>).content as object[]),
        ...((toolBody as Record<string, unknown>).content as object[]),
      ],
      stop_reason: bedrockStopReason(overrides?.finishReason, "tool_use"),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(merged));
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Bedrock API — ignoring");
    }
    const overrides = extractOverrides(response);
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const body = buildBedrockTextResponse(
      response.content,
      completionReq.model,
      response.reasoning,
      overrides,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    if ("webSearches" in response) {
      logger.warn("webSearches in fixture response are not supported for Bedrock API — ignoring");
    }
    const overrides = extractOverrides(response);
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const body = buildBedrockToolCallResponse(
      response.toolCalls,
      completionReq.model,
      logger,
      overrides,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
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
    JSON.stringify({
      error: {
        message: "Fixture response did not match any known type",
        type: "server_error",
      },
    }),
  );
}

// ─── Streaming event builders ───────────────────────────────────────────────

const BEDROCK_INVOKE_STREAM_EVENT_TYPE = "chunk";

function buildBedrockInvokeMessageStart(
  model: string,
  overrides?: ResponseOverrides,
): { eventType: string; payload: object } {
  return {
    eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
    payload: {
      type: "message_start",
      message: {
        id: overrides?.id ?? generateMessageId(),
        type: "message",
        role: "assistant",
        content: [],
        model: overrides?.model ?? model,
        stop_reason: null,
        stop_sequence: null,
        usage: bedrockUsage(overrides),
      },
    },
  };
}

function buildBedrockInvokeMessageDelta(stopReason: string): {
  eventType: string;
  payload: object;
} {
  return {
    eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
    payload: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    },
  };
}

function buildBedrockInvokeMessageStop(): { eventType: string; payload: object } {
  return {
    eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
    payload: { type: "message_stop" },
  };
}

function parseToolArgumentsForStream(toolCall: ToolCall, logger: Logger): string {
  try {
    const parsed = JSON.parse(toolCall.arguments || "{}");
    return JSON.stringify(parsed);
  } catch {
    logger.warn(
      `Malformed JSON in fixture tool call arguments for "${toolCall.name}": ${toolCall.arguments}`,
    );
    return "{}";
  }
}

export function buildBedrockStreamTextEvents(
  content: string,
  model: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
): Array<{ eventType: string; payload: object }> {
  const events: Array<{ eventType: string; payload: object }> = [];

  events.push(buildBedrockInvokeMessageStart(model, overrides));

  // Thinking block (emitted before text when reasoning is present)
  if (reasoning) {
    const blockIndex = 0;
    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: {
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "thinking", thinking: "" },
      },
    });

    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      events.push({
        eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
        payload: {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "thinking_delta", thinking: slice },
        },
      });
    }

    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: { type: "content_block_stop", index: blockIndex },
    });
  }

  // Text block
  const textBlockIndex = reasoning ? 1 : 0;

  events.push({
    eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
    payload: {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    },
  });

  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: {
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text: slice },
      },
    });
  }

  events.push({
    eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
    payload: { type: "content_block_stop", index: textBlockIndex },
  });

  events.push(
    buildBedrockInvokeMessageDelta(bedrockStopReason(overrides?.finishReason, "end_turn")),
  );
  events.push(buildBedrockInvokeMessageStop());

  return events;
}

export function buildBedrockStreamContentWithToolCallsEvents(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
): Array<{ eventType: string; payload: object }> {
  const events: Array<{ eventType: string; payload: object }> = [];

  events.push(buildBedrockInvokeMessageStart(model, overrides));

  let blockIndex = 0;

  // Thinking block (emitted before text when reasoning is present)
  if (reasoning) {
    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: {
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "thinking", thinking: "" },
      },
    });
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      events.push({
        eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
        payload: {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "thinking_delta", thinking: slice },
        },
      });
    }
    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: { type: "content_block_stop", index: blockIndex },
    });
    blockIndex++;
  }

  // Text block
  events.push({
    eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
    payload: {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    },
  });
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "text_delta", text: slice },
      },
    });
  }
  events.push({
    eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
    payload: { type: "content_block_stop", index: blockIndex },
  });
  blockIndex++;

  // Tool call blocks
  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    const toolUseId = tc.id || generateToolUseId();
    const currentBlock = blockIndex + tcIdx;

    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: {
        type: "content_block_start",
        index: currentBlock,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: tc.name,
          input: {},
        },
      },
    });

    const argsStr = parseToolArgumentsForStream(tc, logger);

    for (let i = 0; i < argsStr.length; i += chunkSize) {
      const slice = argsStr.slice(i, i + chunkSize);
      events.push({
        eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
        payload: {
          type: "content_block_delta",
          index: currentBlock,
          delta: { type: "input_json_delta", partial_json: slice },
        },
      });
    }

    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: { type: "content_block_stop", index: currentBlock },
    });
  }

  events.push(
    buildBedrockInvokeMessageDelta(bedrockStopReason(overrides?.finishReason, "tool_use")),
  );
  events.push(buildBedrockInvokeMessageStop());

  return events;
}

export function buildBedrockStreamToolCallEvents(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  logger: Logger,
  overrides?: ResponseOverrides,
): Array<{ eventType: string; payload: object }> {
  const events: Array<{ eventType: string; payload: object }> = [];

  events.push(buildBedrockInvokeMessageStart(model, overrides));

  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    const toolUseId = tc.id || generateToolUseId();

    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: {
        type: "content_block_start",
        index: tcIdx,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: tc.name,
          input: {},
        },
      },
    });

    const argsStr = parseToolArgumentsForStream(tc, logger);

    for (let i = 0; i < argsStr.length; i += chunkSize) {
      const slice = argsStr.slice(i, i + chunkSize);
      events.push({
        eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
        payload: {
          type: "content_block_delta",
          index: tcIdx,
          delta: { type: "input_json_delta", partial_json: slice },
        },
      });
    }

    events.push({
      eventType: BEDROCK_INVOKE_STREAM_EVENT_TYPE,
      payload: { type: "content_block_stop", index: tcIdx },
    });
  }

  events.push(
    buildBedrockInvokeMessageDelta(bedrockStopReason(overrides?.finishReason, "tool_use")),
  );
  events.push(buildBedrockInvokeMessageStop());

  return events;
}

// ─── Streaming request handler ──────────────────────────────────────────────

export async function handleBedrockStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  modelId: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  const urlPath = req.url ?? `/model/${modelId}/invoke-with-response-stream`;

  let bedrockReq: BedrockRequest;
  try {
    bedrockReq = JSON.parse(raw) as BedrockRequest;
  } catch {
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
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!bedrockReq.messages || !Array.isArray(bedrockReq.messages)) {
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
      JSON.stringify({
        error: {
          message: "Invalid request: messages array is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const completionReq = bedrockToCompletionRequest(bedrockReq, modelId, logger);
  completionReq.stream = true;
  completionReq._endpointType = "chat";

  const testId = getTestId(req);
  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
  }

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
        "bedrock",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }
    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (defaults.strict) {
      logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${urlPath}`);
    }
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
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
    // Bedrock Claude error format: { type: "error", error: { type, message } }
    // Uses ?? (nullish coalescing) intentionally — preserves explicit empty-string types from fixtures.
    const anthropicError = {
      type: "error",
      error: {
        type: response.error.type ?? "api_error",
        message: response.error.message,
      },
    };
    writeErrorResponse(res, status, JSON.stringify(anthropicError));
    return;
  }

  // Content + tool calls response — stream as Event Stream
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Bedrock API — ignoring");
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const events = buildBedrockStreamContentWithToolCallsEvents(
      response.content,
      response.toolCalls,
      completionReq.model,
      chunkSize,
      logger,
      response.reasoning,
      overrides,
    );
    const interruption = createInterruptionSignal(fixture);
    const completed = await writeEventStream(res, events, {
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
    return;
  }

  // Text response — stream as Event Stream
  if (isTextResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Bedrock API — ignoring");
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const events = buildBedrockStreamTextEvents(
      response.content,
      completionReq.model,
      chunkSize,
      response.reasoning,
      overrides,
    );
    const interruption = createInterruptionSignal(fixture);
    const completed = await writeEventStream(res, events, {
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
    return;
  }

  // Tool call response — stream as Event Stream
  if (isToolCallResponse(response)) {
    if ("webSearches" in response) {
      logger.warn("webSearches in fixture response are not supported for Bedrock API — ignoring");
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const events = buildBedrockStreamToolCallEvents(
      response.toolCalls,
      completionReq.model,
      chunkSize,
      logger,
      overrides,
    );
    const interruption = createInterruptionSignal(fixture);
    const completed = await writeEventStream(res, events, {
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
    JSON.stringify({
      error: {
        message: "Fixture response did not match any known type",
        type: "server_error",
      },
    }),
  );
}
