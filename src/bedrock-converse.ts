/**
 * AWS Bedrock Converse API support.
 *
 * Translates incoming Converse and Converse-stream requests (Bedrock Converse
 * format) into the ChatCompletionRequest format used by the fixture router,
 * and converts fixture responses back into Converse API format — either a
 * single JSON response or an Event Stream binary stream.
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
  generateToolUseId,
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
import { writeErrorResponse } from "./sse-writer.js";
import { writeEventStream } from "./aws-event-stream.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Converse request types ─────────────────────────────────────────────────

interface ConverseContentBlock {
  text?: string;
  toolUse?: { toolUseId: string; name: string; input: object };
  toolResult?: { toolUseId: string; content: { text?: string }[] };
}

interface ConverseMessage {
  role: "user" | "assistant";
  content: ConverseContentBlock[];
}

interface ConverseToolSpec {
  name: string;
  description?: string;
  inputSchema?: object;
}

interface ConverseRequest {
  messages: ConverseMessage[];
  system?: { text: string }[];
  inferenceConfig?: { maxTokens?: number; temperature?: number };
  toolConfig?: { tools: { toolSpec: ConverseToolSpec }[] };
}

// ─── Converse stop_reason mapping ──────────────────────────────────────────

function converseStopReason(
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
 * Build Converse-format usage from fixture overrides.
 *
 * When no overrides are provided (the common case for mocks), all token
 * counts default to zero.  This is intentional — aimock is a mock server
 * and does not perform real tokenisation.  Callers that need non-zero
 * usage should supply explicit `usage` overrides in their fixture.
 */
function converseUsage(overrides?: ResponseOverrides): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  if (!overrides?.usage) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const inputTokens = overrides.usage.input_tokens ?? overrides.usage.prompt_tokens ?? 0;
  const outputTokens = overrides.usage.output_tokens ?? overrides.usage.completion_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function parseConverseToolArgumentsForStream(toolCall: ToolCall, logger: Logger): string {
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

function buildBedrockStreamTextEvents(
  content: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
): Array<{ eventType: string; payload: object }> {
  const events: Array<{ eventType: string; payload: object }> = [
    { eventType: "messageStart", payload: { role: "assistant" } },
  ];

  if (reasoning) {
    const blockIndex = 0;
    events.push({
      eventType: "contentBlockStart",
      payload: { contentBlockIndex: blockIndex, start: { reasoningContent: {} } },
    });
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      events.push({
        eventType: "contentBlockDelta",
        payload: {
          contentBlockIndex: blockIndex,
          delta: { reasoningContent: { text: reasoning.slice(i, i + chunkSize) } },
        },
      });
    }
    events.push({
      eventType: "contentBlockStop",
      payload: { contentBlockIndex: blockIndex },
    });
  }

  const textBlockIndex = reasoning ? 1 : 0;
  events.push({
    eventType: "contentBlockStart",
    payload: { contentBlockIndex: textBlockIndex, start: {} },
  });
  for (let i = 0; i < content.length; i += chunkSize) {
    events.push({
      eventType: "contentBlockDelta",
      payload: {
        contentBlockIndex: textBlockIndex,
        delta: { text: content.slice(i, i + chunkSize) },
      },
    });
  }
  events.push({
    eventType: "contentBlockStop",
    payload: { contentBlockIndex: textBlockIndex },
  });
  events.push({
    eventType: "messageStop",
    payload: { stopReason: converseStopReason(overrides?.finishReason, "end_turn") },
  });
  const usage = converseUsage(overrides);
  events.push({
    eventType: "metadata",
    payload: { usage, metrics: { latencyMs: 0 } },
  });
  return events;
}

function buildBedrockStreamContentWithToolCallsEvents(
  content: string,
  toolCalls: ToolCall[],
  chunkSize: number,
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
): Array<{ eventType: string; payload: object }> {
  const events = buildBedrockStreamTextEvents(content, chunkSize, reasoning, overrides);
  // Remove trailing metadata + messageStop events — we re-emit them after tool blocks
  for (let i = events.length - 1; i >= 0; i--) {
    const et = (events[i] as { eventType: string }).eventType;
    if (et === "metadata" || et === "messageStop") {
      events.splice(i, 1);
    }
  }
  let blockIndex = reasoning ? 2 : 1;

  for (const tc of toolCalls) {
    const toolUseId = tc.id || generateToolUseId();
    events.push({
      eventType: "contentBlockStart",
      payload: {
        contentBlockIndex: blockIndex,
        start: { toolUse: { toolUseId, name: tc.name } },
      },
    });
    const argsStr = parseConverseToolArgumentsForStream(tc, logger);
    for (let i = 0; i < argsStr.length; i += chunkSize) {
      events.push({
        eventType: "contentBlockDelta",
        payload: {
          contentBlockIndex: blockIndex,
          delta: { toolUse: { input: argsStr.slice(i, i + chunkSize) } },
        },
      });
    }
    events.push({
      eventType: "contentBlockStop",
      payload: { contentBlockIndex: blockIndex },
    });
    blockIndex++;
  }
  events.push({
    eventType: "messageStop",
    payload: { stopReason: converseStopReason(overrides?.finishReason, "tool_use") },
  });
  const usage = converseUsage(overrides);
  events.push({
    eventType: "metadata",
    payload: { usage, metrics: { latencyMs: 0 } },
  });
  return events;
}

function buildBedrockStreamToolCallEvents(
  toolCalls: ToolCall[],
  chunkSize: number,
  logger: Logger,
  overrides?: ResponseOverrides,
): Array<{ eventType: string; payload: object }> {
  const events: Array<{ eventType: string; payload: object }> = [
    { eventType: "messageStart", payload: { role: "assistant" } },
  ];

  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    const toolUseId = tc.id || generateToolUseId();
    events.push({
      eventType: "contentBlockStart",
      payload: {
        contentBlockIndex: tcIdx,
        start: { toolUse: { toolUseId, name: tc.name } },
      },
    });
    const argsStr = parseConverseToolArgumentsForStream(tc, logger);
    for (let i = 0; i < argsStr.length; i += chunkSize) {
      events.push({
        eventType: "contentBlockDelta",
        payload: {
          contentBlockIndex: tcIdx,
          delta: { toolUse: { input: argsStr.slice(i, i + chunkSize) } },
        },
      });
    }
    events.push({
      eventType: "contentBlockStop",
      payload: { contentBlockIndex: tcIdx },
    });
  }
  events.push({
    eventType: "messageStop",
    payload: { stopReason: converseStopReason(overrides?.finishReason, "tool_use") },
  });
  const usage = converseUsage(overrides);
  events.push({
    eventType: "metadata",
    payload: { usage, metrics: { latencyMs: 0 } },
  });
  return events;
}

// ─── Input conversion: Converse → ChatCompletionRequest ─────────────────────

export function converseToCompletionRequest(
  req: ConverseRequest,
  modelId: string,
  logger?: Logger,
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // system field → system message
  if (req.system && req.system.length > 0) {
    const systemText = req.system.map((s) => s.text).join("");
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  for (const msg of req.messages) {
    if (msg.role === "user") {
      // Check for toolResult blocks
      const toolResults = msg.content.filter((b) => b.toolResult);
      const textBlocks = msg.content.filter(
        (b) => b.text !== undefined && b.text !== "" && !b.toolResult,
      );
      const unsupportedBlocks = msg.content.filter(
        (b) => b.text === undefined && !b.toolResult && !b.toolUse,
      );
      if (unsupportedBlocks.length > 0 && logger) {
        logger.warn(
          `Converse user message contains unsupported content block types — these will be dropped during conversion`,
        );
      }

      if (toolResults.length > 0) {
        for (const block of toolResults) {
          const tr = block.toolResult!;
          const resultContent = tr.content.map((c) => c.text ?? "").join("");
          messages.push({
            role: "tool",
            content: resultContent,
            tool_call_id: tr.toolUseId,
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

      // Plain user message
      const text = msg.content
        .filter((b) => b.text !== undefined && b.text !== "")
        .map((b) => b.text ?? "")
        .join("");
      messages.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const toolUseBlocks = msg.content.filter((b) => b.toolUse);
      const textContent = msg.content
        .filter((b) => b.text !== undefined && b.text !== "")
        .map((b) => b.text ?? "")
        .join("");

      if (toolUseBlocks.length > 0) {
        messages.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolUseBlocks.map((b) => ({
            id: b.toolUse!.toolUseId,
            type: "function" as const,
            function: {
              name: b.toolUse!.name,
              arguments: JSON.stringify(b.toolUse!.input),
            },
          })),
        });
      } else {
        messages.push({ role: "assistant", content: textContent || null });
      }
    } else {
      const warnMsg = `Unexpected message role "${msg.role}" in Converse request — skipping`;
      if (logger) {
        logger.warn(warnMsg);
      }
    }
  }

  // Convert tools
  let tools: ToolDefinition[] | undefined;
  if (req.toolConfig?.tools && req.toolConfig.tools.length > 0) {
    tools = req.toolConfig.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.toolSpec.name,
        description: t.toolSpec.description,
        parameters: (t.toolSpec.inputSchema && "json" in t.toolSpec.inputSchema
          ? (t.toolSpec.inputSchema as Record<string, unknown>).json
          : t.toolSpec.inputSchema) as object | undefined,
      },
    }));
  }

  return {
    model: modelId,
    messages,
    stream: false,
    temperature: req.inferenceConfig?.temperature,
    max_tokens: req.inferenceConfig?.maxTokens,
    tools,
  };
}

// ─── Response builders ──────────────────────────────────────────────────────

function buildConverseTextResponse(
  content: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
): object {
  const contentBlocks: object[] = [];
  if (reasoning) {
    contentBlocks.push({
      reasoningContent: { reasoningText: { text: reasoning } },
    });
  }
  contentBlocks.push({ text: content });

  return {
    output: {
      message: {
        role: "assistant",
        content: contentBlocks,
      },
    },
    stopReason: converseStopReason(overrides?.finishReason, "end_turn"),
    usage: converseUsage(overrides),
    metrics: { latencyMs: 0 },
  };
}

function buildConverseToolCallResponse(
  toolCalls: ToolCall[],
  logger: Logger,
  overrides?: ResponseOverrides,
): object {
  return {
    output: {
      message: {
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
            toolUse: {
              toolUseId: tc.id || generateToolUseId(),
              name: tc.name,
              input: argsObj,
            },
          };
        }),
      },
    },
    stopReason: converseStopReason(overrides?.finishReason, "tool_use"),
    usage: converseUsage(overrides),
    metrics: { latencyMs: 0 },
  };
}

function buildConverseContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
): object {
  const contentBlocks: object[] = [];
  if (reasoning) {
    contentBlocks.push({
      reasoningContent: { reasoningText: { text: reasoning } },
    });
  }
  contentBlocks.push({ text: content });
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
    contentBlocks.push({
      toolUse: {
        toolUseId: tc.id || generateToolUseId(),
        name: tc.name,
        input: argsObj,
      },
    });
  }

  return {
    output: {
      message: {
        role: "assistant",
        content: contentBlocks,
      },
    },
    stopReason: converseStopReason(overrides?.finishReason, "tool_use"),
    usage: converseUsage(overrides),
    metrics: { latencyMs: 0 },
  };
}

// ─── Request handlers ───────────────────────────────────────────────────────

export async function handleConverse(
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

  const urlPath = req.url ?? `/model/${modelId}/converse`;

  let converseReq: ConverseRequest;
  try {
    converseReq = JSON.parse(raw) as ConverseRequest;
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
      JSON.stringify({
        error: {
          message: `Malformed JSON: ${detail}`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!converseReq.messages || !Array.isArray(converseReq.messages)) {
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

  const completionReq = converseToCompletionRequest(converseReq, modelId, logger);
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
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    if (effectiveStrict) {
      const strictStatus = 503;
      const strictMessage = "Strict mode: no fixture matched";
      logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${urlPath}`);
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
        "bedrock",
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
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
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
    const errBody = {
      type: "error",
      error: {
        type: response.error.type ?? "invalid_request_error",
        message: response.error.message,
      },
    };
    writeErrorResponse(res, status, JSON.stringify(errBody));
    return;
  }

  // Content + tool calls response
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Bedrock Converse API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const body = buildConverseContentWithToolCallsResponse(
      response.content,
      response.toolCalls,
      logger,
      response.reasoning,
      overrides,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Bedrock Converse API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const body = buildConverseTextResponse(response.content, response.reasoning, overrides);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Bedrock Converse API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const body = buildConverseToolCallResponse(response.toolCalls, logger, overrides);
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

export async function handleConverseStream(
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

  const urlPath = req.url ?? `/model/${modelId}/converse-stream`;

  let converseReq: ConverseRequest;
  try {
    converseReq = JSON.parse(raw) as ConverseRequest;
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
      JSON.stringify({
        error: {
          message: `Malformed JSON: ${detail}`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!converseReq.messages || !Array.isArray(converseReq.messages)) {
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

  const completionReq = converseToCompletionRequest(converseReq, modelId, logger);
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
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    if (effectiveStrict) {
      const strictStatus = 503;
      const strictMessage = "Strict mode: no fixture matched";
      logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${urlPath}`);
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
        "bedrock",
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
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
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
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    const errBody = {
      type: "error",
      error: {
        type: response.error.type ?? "invalid_request_error",
        message: response.error.message,
      },
    };
    writeErrorResponse(res, status, JSON.stringify(errBody));
    return;
  }

  // Content + tool calls response — stream as Event Stream
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Bedrock Converse API — ignoring",
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
    const events = buildBedrockStreamContentWithToolCallsEvents(
      response.content,
      response.toolCalls,
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
      logger.warn(
        "webSearches in fixture response are not supported for Bedrock Converse API — ignoring",
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
    const events = buildBedrockStreamTextEvents(
      response.content,
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
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Bedrock Converse API — ignoring",
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
    const events = buildBedrockStreamToolCallEvents(
      response.toolCalls,
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
