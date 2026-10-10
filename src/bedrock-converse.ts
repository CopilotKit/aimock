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
  FixtureBlock,
  HandlerDefaults,
  ResponseOverrides,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  requireEmittedFunctionToolCalls,
  requireFunctionToolCalls,
  type FunctionFixtureBlock,
  generateToolUseId,
  estimatePromptTokens,
  estimateTokens,
  extractOverrides,
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  resolveFixtureBlockOutcome,
  isErrorResponse,
  flattenHeaders,
  isJsonObject,
  getContext,
  getTestId,
  resolveResponse,
  resolveReasoningForModel,
  resolveStrictMode,
  strictOverrideField,
  strictNoMatchMessage,
  strictNoMatchLogLine,
  toolArgsForWire,
  servedToolArgs,
  InvalidToolArgumentsError,
} from "./helpers.js";
import { matchFixtureDiagnostic, recordMatchOptions } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { writeEventStream } from "./aws-event-stream.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaosAsync } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";
import { planMisbehavior, recordMisbehaviorOutcome, type MisbehaviorPlan } from "./misbehavior.js";

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
  return servedToolArgs(toolCall, "string", logger).text;
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
  blocks?: FixtureBlock[],
): Array<{ eventType: string; payload: object }> {
  if (blocks && blocks.length > 0) {
    // NEW PATH: stream `text`/`toolUse` content blocks in the fixture's array
    // order. Converse's indexed contentBlock events make ordering observable —
    // a `toolCall` block can take a lower `contentBlockIndex` than a `text`
    // block. Indices are assigned in encounter order, continuing from any
    // leading reasoning block (which occupies index 0).
    const events: Array<{ eventType: string; payload: object }> = [
      { eventType: "messageStart", payload: { role: "assistant" } },
    ];

    let blockIndex = 0;
    if (reasoning) {
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
      blockIndex++;
    }

    const outcome = resolveFixtureBlockOutcome(blocks);
    const ordered = outcome.ordered;
    for (const block of ordered) {
      if (block.type === "text") {
        events.push({
          eventType: "contentBlockStart",
          payload: { contentBlockIndex: blockIndex, start: {} },
        });
        for (let i = 0; i < block.text.length; i += chunkSize) {
          events.push({
            eventType: "contentBlockDelta",
            payload: {
              contentBlockIndex: blockIndex,
              delta: { text: block.text.slice(i, i + chunkSize) },
            },
          });
        }
        events.push({
          eventType: "contentBlockStop",
          payload: { contentBlockIndex: blockIndex },
        });
      } else {
        const toolUseId = block.id || generateToolUseId();
        events.push({
          eventType: "contentBlockStart",
          payload: {
            contentBlockIndex: blockIndex,
            start: { toolUse: { toolUseId, name: block.name } },
          },
        });
        const argsStr = parseConverseToolArgumentsForStream(
          { name: block.name, arguments: block.arguments } as ToolCall,
          logger,
        );
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
      }
      blockIndex++;
    }

    events.push({
      eventType: "messageStop",
      payload: {
        stopReason: converseStopReason(
          overrides?.finishReason,
          outcome.hasToolCalls ? "tool_use" : "end_turn",
        ),
      },
    });
    events.push({
      eventType: "metadata",
      payload: { usage: converseUsage(overrides), metrics: { latencyMs: 0 } },
    });
    return events;
  }

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
  reasoning?: string,
  overrides?: ResponseOverrides,
): Array<{ eventType: string; payload: object }> {
  const events: Array<{ eventType: string; payload: object }> = [
    { eventType: "messageStart", payload: { role: "assistant" } },
  ];

  // A leading reasoning block occupies contentBlockIndex 0, shifting the
  // toolUse blocks by +1 (mirrors the content+tool builder's sequencing).
  if (reasoning) {
    const reasoningBlockIndex = 0;
    events.push({
      eventType: "contentBlockStart",
      payload: { contentBlockIndex: reasoningBlockIndex, start: { reasoningContent: {} } },
    });
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      events.push({
        eventType: "contentBlockDelta",
        payload: {
          contentBlockIndex: reasoningBlockIndex,
          delta: { reasoningContent: { text: reasoning.slice(i, i + chunkSize) } },
        },
      });
    }
    events.push({
      eventType: "contentBlockStop",
      payload: { contentBlockIndex: reasoningBlockIndex },
    });
  }

  const toolBlockOffset = reasoning ? 1 : 0;

  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const blockIndex = tcIdx + toolBlockOffset;
    const tc = toolCalls[tcIdx];
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

/** Validate only message fields consumed by the user-message converter. */
function validateConverseMessages(req: ConverseRequest): string | undefined {
  for (const [i, message] of req.messages.entries()) {
    if (message === null) return `Invalid request: messages[${i}] must not be null`;
    // Unknown roles are intentionally skipped; assistant toolResult is inert.
    if (message.role !== "user") continue;
    if (!Array.isArray(message.content)) {
      return `Invalid request: messages[${i}].content must be an array`;
    }
    for (const [j, block] of message.content.entries()) {
      if (block === null) {
        return `Invalid request: messages[${i}].content[${j}] must not be null`;
      }
      if (block.toolResult && !Array.isArray(block.toolResult.content)) {
        return `Invalid request: messages[${i}].content[${j}].toolResult.content must be an array`;
      }
    }
  }
  return undefined;
}

/** Validate only system fields consumed by the converter. */
function validateConverseSystem(req: ConverseRequest): string | undefined {
  if (req.system && req.system.length > 0) {
    if (!Array.isArray(req.system)) {
      return "Invalid request: system must be an array";
    }
    for (const [i, block] of req.system.entries()) {
      if (block === null) return `Invalid request: system[${i}] must not be null`;
    }
  }
  return undefined;
}

/** Validate only tool fields consumed by the converter. */
function validateConverseTools(req: ConverseRequest): string | undefined {
  if (req.toolConfig?.tools && req.toolConfig.tools.length > 0) {
    if (!Array.isArray(req.toolConfig.tools)) {
      return "Invalid request: toolConfig.tools must be an array";
    }
    for (const [i, tool] of req.toolConfig.tools.entries()) {
      if (tool?.toolSpec === null) {
        return `Invalid request: toolConfig.tools[${i}].toolSpec must not be null`;
      }
    }
  }
  return undefined;
}

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
  reasoning?: string,
  overrides?: ResponseOverrides,
): object {
  const contentBlocks: object[] = [];
  if (reasoning) {
    contentBlocks.push({
      reasoningContent: { reasoningText: { text: reasoning } },
    });
  }
  for (const tc of toolCalls) {
    const args = servedToolArgs(tc, "object", logger);
    contentBlocks.push({
      toolUse: {
        toolUseId: tc.id || generateToolUseId(),
        name: tc.name,
        input: args.value,
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

function buildConverseContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
  blocks?: FixtureBlock[],
): object {
  const contentBlocks: object[] = [];
  if (reasoning) {
    contentBlocks.push({
      reasoningContent: { reasoningText: { text: reasoning } },
    });
  }

  // Converse `input` requires a JSON value; reject malformed arguments before
  // emitting an object response instead of substituting an empty object.
  const toolUseBlock = (tc: { name: string; arguments: string; id?: string }): object => {
    const args = servedToolArgs(tc, "object", logger);
    return {
      toolUse: {
        toolUseId: tc.id || generateToolUseId(),
        name: tc.name,
        input: args.value,
      },
    };
  };

  let blockHasTools: boolean | undefined;
  if (blocks && blocks.length > 0) {
    // NEW PATH: the non-streaming `content[]` array is positionally observable,
    // so emit `text`/`toolUse` content blocks in the fixture's ARRAY ORDER
    // (after any leading reasoning block). A toolCall block before a text block
    // therefore yields a toolUse ahead of the text — matching the streaming
    // path for the same `blocks` fixture.
    const outcome = resolveFixtureBlockOutcome(blocks);
    const ordered = outcome.ordered;
    blockHasTools = outcome.hasToolCalls;
    for (const block of ordered) {
      if (block.type === "text") {
        contentBlocks.push({ text: block.text });
      } else {
        contentBlocks.push(
          toolUseBlock({ name: block.name, arguments: block.arguments, id: block.id }),
        );
      }
    }
  } else {
    // LEGACY PATH (unchanged): text content block, then toolUse blocks in
    // `toolCalls` order.
    contentBlocks.push({ text: content });
    for (const tc of toolCalls) {
      contentBlocks.push(toolUseBlock(tc));
    }
  }

  return {
    output: {
      message: {
        role: "assistant",
        content: contentBlocks,
      },
    },
    stopReason: converseStopReason(
      overrides?.finishReason,
      blockHasTools === false ? "end_turn" : "tool_use",
    ),
    usage: converseUsage(overrides),
    metrics: { latencyMs: 0 },
  };
}

interface PreparedConverseMisbehavior {
  plan: MisbehaviorPlan;
  blocks: FunctionFixtureBlock[];
  reasoning: string;
  stopReason: string;
  usage: ReturnType<typeof converseUsage>;
}

/** Prepare actual emitted calls and identities before journaling or writing bytes. */
function prepareConverseMisbehavior(
  plan: MisbehaviorPlan,
  request: ChatCompletionRequest,
  stream: boolean,
  defaults: HandlerDefaults,
  headers: http.IncomingHttpHeaders,
): PreparedConverseMisbehavior {
  const response = plan.response;
  const combined = isContentWithToolCallsResponse(response);
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  // The planner skips a custom-call fixture on this wire, so the narrowing
  // below never throws; the normal path's guard rejects it instead.
  let blocks: FunctionFixtureBlock[] = outcome?.ordered.map((block) => ({ ...block })) ?? [
    ...("content" in response && response.content
      ? [{ type: "text" as const, text: response.content }]
      : []),
    ...requireFunctionToolCalls(
      combined || isToolCallResponse(response) ? (response.toolCalls ?? []) : [],
      "Bedrock Converse",
    ).map((call) => ({ ...call, type: "toolCall" as const })),
  ];
  const calls = blocks.filter((block) => block.type === "toolCall");
  const preparedCalls = calls.map((call, index) => {
    const args = toolArgsForWire(call);
    return {
      ...call,
      arguments: args.kind === "parsed" ? args.text : args.raw,
      ...(index === plan.duplicateId?.destinationIndex
        ? {}
        : { id: call.id || generateToolUseId() }),
    };
  });
  if (plan.duplicateId) {
    preparedCalls[plan.duplicateId.destinationIndex].id =
      preparedCalls[plan.duplicateId.sourceIndex].id;
  }
  let callIndex = 0;
  blocks = blocks.map((block) => (block.type === "toolCall" ? preparedCalls[callIndex++] : block));
  let stopReason = converseStopReason(
    "finishReason" in response ? response.finishReason : undefined,
    calls.length ? "tool_use" : "end_turn",
  );
  if (plan.stop === "stop") stopReason = "end_turn";
  if (plan.stop === "length") stopReason = "max_tokens";
  if (plan.stop === "content_filter") stopReason = "content_filtered";
  if (!stream && plan.summary.fault === "tool-args-invalid-json") {
    // This native signal carries no malformed object and no toolUse blocks.
    blocks = blocks.filter((block) => block.type !== "toolCall");
    stopReason = "malformed_tool_use";
  }
  if (!stream && plan.summary.fault === "stop-length-mid-tool") {
    // Captured Converse max_tokens output retains the unfinished call with empty input.
    let index = 0;
    blocks = blocks.map((block) => {
      if (block.type !== "toolCall") return block;
      return index++ === plan.target?.index ? { ...block, arguments: "{}" } : block;
    });
  }
  const reasoning =
    plan.reasoning ??
    resolveReasoningForModel(
      "reasoning" in response ? response.reasoning : undefined,
      request.model,
      resolveStrictMode(defaults.strict, headers),
      defaults.logger,
    ) ??
    "";
  const servedToolCalls = blocks.flatMap((block) =>
    block.type === "toolCall"
      ? [{ name: block.name, arguments: block.arguments, id: block.id }]
      : [],
  );
  const inputTokens = estimatePromptTokens(request.messages);
  const outputTokens = estimateTokens(
    reasoning +
      blocks
        .map((block) => (block.type === "text" ? block.text : block.name + block.arguments))
        .join(""),
  );
  return {
    plan: { ...plan, summary: { ...plan.summary, servedToolCalls } },
    blocks,
    reasoning,
    stopReason,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}

function buildConverseMisbehaviorResponse(prepared: PreparedConverseMisbehavior): object {
  const content: object[] =
    prepared.reasoning || prepared.plan.summary.fault === "reasoning-only"
      ? [{ reasoningContent: { reasoningText: { text: prepared.reasoning } } }]
      : [];
  for (const block of prepared.blocks) {
    if (block.type === "text") content.push({ text: block.text });
    else {
      const args = toolArgsForWire(block);
      if (args.kind === "verbatim") throw new InvalidToolArgumentsError(block);
      content.push({ toolUse: { toolUseId: block.id, name: block.name, input: args.value } });
    }
  }
  return {
    output: { message: { role: "assistant", content } },
    stopReason: prepared.stopReason,
    usage: prepared.usage,
    metrics: { latencyMs: 0 },
  };
}

function buildConverseMisbehaviorEvents(
  prepared: PreparedConverseMisbehavior,
  chunkSize: number,
): Array<{ eventType: string; payload: object }> {
  const events: Array<{ eventType: string; payload: object }> = [
    { eventType: "messageStart", payload: { role: "assistant" } },
  ];
  let index = 0;
  if (prepared.reasoning || prepared.plan.summary.fault === "reasoning-only") {
    events.push({
      eventType: "contentBlockStart",
      payload: { contentBlockIndex: index, start: { reasoningContent: {} } },
    });
    for (let i = 0; i < prepared.reasoning.length; i += chunkSize) {
      events.push({
        eventType: "contentBlockDelta",
        payload: {
          contentBlockIndex: index,
          delta: { reasoningContent: { text: prepared.reasoning.slice(i, i + chunkSize) } },
        },
      });
    }
    events.push({ eventType: "contentBlockStop", payload: { contentBlockIndex: index++ } });
  }
  for (const block of prepared.blocks) {
    events.push({
      eventType: "contentBlockStart",
      payload: {
        contentBlockIndex: index,
        start:
          block.type === "toolCall" ? { toolUse: { toolUseId: block.id, name: block.name } } : {},
      },
    });
    const value = block.type === "text" ? block.text : block.arguments;
    for (let i = 0; i < value.length; i += chunkSize) {
      const part = value.slice(i, i + chunkSize);
      events.push({
        eventType: "contentBlockDelta",
        payload: {
          contentBlockIndex: index,
          delta: block.type === "text" ? { text: part } : { toolUse: { input: part } },
        },
      });
    }
    events.push({ eventType: "contentBlockStop", payload: { contentBlockIndex: index++ } });
  }
  events.push(
    { eventType: "messageStop", payload: { stopReason: prepared.stopReason } },
    { eventType: "metadata", payload: { usage: prepared.usage, metrics: { latencyMs: 0 } } },
  );
  return events;
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

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `converseReq.messages` throws a TypeError that
  // surfaces as a 500 instead of a 400.
  if (!isJsonObject(converseReq)) {
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
          message: "Request body must be a JSON object",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const messageError = !Array.isArray(converseReq.messages)
    ? "Invalid request: messages array is required"
    : (validateConverseMessages(converseReq) ??
      validateConverseSystem(converseReq) ??
      validateConverseTools(converseReq));
  if (messageError) {
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
          message: messageError,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const completionReq = converseToCompletionRequest(converseReq, modelId, logger);
  completionReq._endpointType = "chat";
  completionReq._context = getContext(req);

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
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
  }

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
  let misbehavior = planMisbehavior({
    wire: "bedrock-converse",
    emitsToolCallIds: true,
    fixture,
    response,
    request: completionReq,
    stream: false,
    defaults,
    rawHeaders: req.headers,
    url: req.url,
  });
  const addResponseEntry = (input: Parameters<Journal["add"]>[0]) => {
    const entry = journal.add(input);
    recordMisbehaviorOutcome({ entry, summary: misbehavior.summary, defaults, testId });
    return entry;
  };
  if (misbehavior.kind === "error") {
    if (!misbehavior.summary?.evaluations.length) logger.error(misbehavior.message);
    addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: misbehavior.status, fixture, error: misbehavior.message },
    });
    const type = misbehavior.status === 400 ? "ValidationException" : "InternalServerException";
    res.setHeader("x-amzn-errortype", type);
    writeErrorResponse(
      res,
      misbehavior.status,
      JSON.stringify({
        __type: type,
        message: misbehavior.message,
        code: misbehavior.code,
      }),
    );
    return;
  }

  if (misbehavior.kind === "applied") {
    const prepared = prepareConverseMisbehavior(
      misbehavior,
      completionReq,
      false,
      defaults,
      req.headers,
    );
    misbehavior = prepared.plan;
    const body = buildConverseMisbehaviorResponse(prepared);
    addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    addResponseEntry({
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
    writeErrorResponse(res, status, JSON.stringify(errBody), {
      retryAfter: response.retryAfter,
    });
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
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      resolveStrictMode(defaults.strict, req.headers),
      logger,
    );
    addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const functionToolCalls = requireEmittedFunctionToolCalls(response, "Bedrock Converse");
    const body = buildConverseContentWithToolCallsResponse(
      response.content ?? "",
      functionToolCalls,
      logger,
      effReasoning,
      overrides,
      response.blocks,
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
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      resolveStrictMode(defaults.strict, req.headers),
      logger,
    );
    addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const body = buildConverseTextResponse(response.content, effReasoning, overrides);
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
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      resolveStrictMode(defaults.strict, req.headers),
      logger,
    );
    addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const functionToolCalls = requireEmittedFunctionToolCalls(response, "Bedrock Converse");
    const body = buildConverseToolCallResponse(functionToolCalls, logger, effReasoning, overrides);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Unknown response type
  addResponseEntry({
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

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `converseReq.messages` throws a TypeError that
  // surfaces as a 500 instead of a 400.
  if (!isJsonObject(converseReq)) {
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
          message: "Request body must be a JSON object",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const messageError = !Array.isArray(converseReq.messages)
    ? "Invalid request: messages array is required"
    : (validateConverseMessages(converseReq) ??
      validateConverseSystem(converseReq) ??
      validateConverseTools(converseReq));
  if (messageError) {
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
          message: messageError,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const completionReq = converseToCompletionRequest(converseReq, modelId, logger);
  completionReq.stream = true;
  completionReq._endpointType = "chat";
  completionReq._context = getContext(req);

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
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
  }

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
  let misbehavior = planMisbehavior({
    wire: "bedrock-converse",
    emitsToolCallIds: true,
    fixture,
    response,
    request: completionReq,
    stream: true,
    defaults,
    rawHeaders: req.headers,
    url: req.url,
  });
  const addResponseEntry = (input: Parameters<Journal["add"]>[0]) => {
    const entry = journal.add(input);
    recordMisbehaviorOutcome({ entry, summary: misbehavior.summary, defaults, testId });
    return entry;
  };
  if (misbehavior.kind === "error") {
    if (!misbehavior.summary?.evaluations.length) logger.error(misbehavior.message);
    addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: misbehavior.status, fixture, error: misbehavior.message },
    });
    const type = misbehavior.status === 400 ? "ValidationException" : "InternalServerException";
    res.setHeader("x-amzn-errortype", type);
    writeErrorResponse(
      res,
      misbehavior.status,
      JSON.stringify({
        __type: type,
        message: misbehavior.message,
        code: misbehavior.code,
      }),
    );
    return;
  }
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  if (misbehavior.kind === "applied") {
    const prepared = prepareConverseMisbehavior(
      misbehavior,
      completionReq,
      true,
      defaults,
      req.headers,
    );
    misbehavior = prepared.plan;
    const events = buildConverseMisbehaviorEvents(prepared, chunkSize);
    const entry = addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const interruption = createInterruptionSignal(fixture);
    const completed = await writeEventStream(res, events, {
      latency,
      streamingProfile: fixture.streamingProfile,
      recordedTimings: fixture.recordedTimings,
      replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
      signal: interruption?.signal,
      onChunkSent: interruption?.tick,
    });
    if (!completed) {
      if (!res.writableEnded) res.destroy();
      entry.response.interrupted = true;
      entry.response.interruptReason = interruption?.reason();
    }
    interruption?.cleanup();
    return;
  }

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    addResponseEntry({
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
    writeErrorResponse(res, status, JSON.stringify(errBody), {
      retryAfter: response.retryAfter,
    });
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
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      resolveStrictMode(defaults.strict, req.headers),
      logger,
    );
    const journalEntry = addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const functionToolCalls = requireEmittedFunctionToolCalls(response, "Bedrock Converse");
    const events = buildBedrockStreamContentWithToolCallsEvents(
      response.content ?? "",
      functionToolCalls,
      chunkSize,
      logger,
      effReasoning,
      overrides,
      response.blocks,
    );
    const interruption = createInterruptionSignal(fixture);
    const completed = await writeEventStream(res, events, {
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
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      resolveStrictMode(defaults.strict, req.headers),
      logger,
    );
    const journalEntry = addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const events = buildBedrockStreamTextEvents(
      response.content,
      chunkSize,
      effReasoning,
      overrides,
    );
    const interruption = createInterruptionSignal(fixture);
    const completed = await writeEventStream(res, events, {
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
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      resolveStrictMode(defaults.strict, req.headers),
      logger,
    );
    const journalEntry = addResponseEntry({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const functionToolCalls = requireEmittedFunctionToolCalls(response, "Bedrock Converse");
    const events = buildBedrockStreamToolCallEvents(
      functionToolCalls,
      chunkSize,
      logger,
      effReasoning,
      overrides,
    );
    const interruption = createInterruptionSignal(fixture);
    const completed = await writeEventStream(res, events, {
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
    return;
  }

  // Unknown response type
  addResponseEntry({
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
