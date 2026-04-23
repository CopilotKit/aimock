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
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { writeEventStream } from "./aws-event-stream.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";
import {
  buildBedrockStreamTextEvents,
  buildBedrockStreamToolCallEvents,
  buildBedrockStreamContentWithToolCallsEvents,
} from "./bedrock.js";

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

// ─── Input conversion: Converse → ChatCompletionRequest ─────────────────────

export function converseToCompletionRequest(
  req: ConverseRequest,
  modelId: string,
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
      const textBlocks = msg.content.filter((b) => b.text !== undefined && !b.toolResult);

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
        .filter((b) => b.text !== undefined)
        .map((b) => b.text ?? "")
        .join("");
      messages.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const toolUseBlocks = msg.content.filter((b) => b.toolUse);
      const textContent = msg.content
        .filter((b) => b.text !== undefined)
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
        parameters: t.toolSpec.inputSchema,
      },
    }));
  }

  return {
    model: modelId,
    messages,
    stream: false,
    temperature: req.inferenceConfig?.temperature,
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

  const completionReq = converseToCompletionRequest(converseReq, modelId);
  completionReq._endpointType = "chat";

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
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      const proxied = await proxyAndRecord(
        req,
        res,
        completionReq,
        "bedrock",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
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

  const response = fixture.response;

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
        type: response.error.type || "invalid_request_error",
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

  const completionReq = converseToCompletionRequest(converseReq, modelId);
  completionReq._endpointType = "chat";

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
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      const proxied = await proxyAndRecord(
        req,
        res,
        completionReq,
        "bedrock",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
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

  const response = fixture.response;
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
        type: response.error.type || "invalid_request_error",
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
