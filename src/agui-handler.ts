// ─── AG-UI Handler ───────────────────────────────────────────────────────────
//
// Matching functions, event builders, and SSE writer for AG-UI protocol.

import * as http from "node:http";
import { randomUUID } from "node:crypto";

import type { Logger } from "./logger.js";
import type {
  AGUIRunAgentInput,
  AGUIFixtureMatch,
  AGUIFixture,
  AGUIEvent,
  AGUIMessage,
  AGUIRunStartedEvent,
  AGUIRunFinishedEvent,
  AGUIRunFinishedOutcome,
  AGUIRunErrorEvent,
  AGUITextMessageStartEvent,
  AGUITextMessageContentEvent,
  AGUITextMessageEndEvent,
  AGUITextMessageChunkEvent,
  AGUIToolCallStartEvent,
  AGUIToolCallArgsEvent,
  AGUIToolCallEndEvent,
  AGUIToolCallChunkEvent,
  AGUIToolCallResultEvent,
  AGUIStateSnapshotEvent,
  AGUIStateDeltaEvent,
  AGUIMessagesSnapshotEvent,
  AGUIStepStartedEvent,
  AGUIStepFinishedEvent,
  AGUIReasoningStartEvent,
  AGUIReasoningMessageStartEvent,
  AGUIReasoningMessageContentEvent,
  AGUIReasoningMessageEndEvent,
  AGUIReasoningMessageChunkEvent,
  AGUIReasoningEndEvent,
  AGUIReasoningEncryptedValueEvent,
  AGUIReasoningEncryptedValueSubtype,
  AGUIActivitySnapshotEvent,
  AGUIActivityDeltaEvent,
  AGUIRawEvent,
  AGUICustomEvent,
} from "./agui-types.js";

// ─── Matching functions ──────────────────────────────────────────────────────

/**
 * Extract the content of the last message with role "user" from the input.
 * Walks structured content arrays (e.g. `[{type:"text", text:"..."}, {type:"document", ...}]`)
 * and joins their text parts. Returns `""` when no user message is present or has no text.
 */
export function extractLastUserMessage(input: AGUIRunAgentInput): string {
  if (!input.messages || input.messages.length === 0) return "";
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const msg = input.messages[i];
    if (msg.role !== "user") continue;
    const text = extractTextFromContent(msg.content);
    if (text) return text;
  }
  return "";
}

function extractTextFromContent(content: AGUIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text
    ) {
      parts.push(part.text);
    }
  }
  return parts.join(" ").trim();
}

/**
 * Return the absolute last message if it has role "tool", otherwise null.
 */
export function getLastMessageIfToolResult(input: AGUIRunAgentInput): AGUIMessage | null {
  if (!input.messages || input.messages.length === 0) return null;
  const last = input.messages[input.messages.length - 1];
  return last.role === "tool" ? last : null;
}

/**
 * Check whether an input matches a fixture's match criteria.
 * All specified criteria must pass (AND logic).
 */
export function matchesFixture(input: AGUIRunAgentInput, match: AGUIFixtureMatch): boolean {
  if (match.message !== undefined) {
    const text = extractLastUserMessage(input);
    if (typeof match.message === "string") {
      if (!text.includes(match.message)) return false;
    } else {
      match.message.lastIndex = 0;
      if (!match.message.test(text)) return false;
    }
  }

  if (match.toolCallId !== undefined) {
    const lastMsg = input.messages?.[input.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "tool" || lastMsg.toolCallId !== match.toolCallId) {
      return false;
    }
  }

  if (match.toolName !== undefined) {
    const tools = input.tools ?? [];
    if (!tools.some((t) => t.name === match.toolName)) return false;
  }

  if (match.stateKey !== undefined) {
    if (
      input.state === null ||
      input.state === undefined ||
      typeof input.state !== "object" ||
      !(match.stateKey in (input.state as Record<string, unknown>))
    ) {
      return false;
    }
  }

  if (match.predicate !== undefined) {
    if (!match.predicate(input)) return false;
  }

  return true;
}

/**
 * Find the first fixture whose match criteria pass for the given input.
 */
export function findFixture(input: AGUIRunAgentInput, fixtures: AGUIFixture[]): AGUIFixture | null {
  for (const fixture of fixtures) {
    if (matchesFixture(input, fixture.match)) {
      return fixture;
    }
  }
  return null;
}

// ─── Builder options ─────────────────────────────────────────────────────────

export interface AGUIBuildOpts {
  threadId?: string;
  runId?: string;
  parentRunId?: string;
  /** For tool call builder: include a result event */
  result?: string;
}

// ─── Event builders ──────────────────────────────────────────────────────────

function makeRunStarted(opts?: AGUIBuildOpts): AGUIRunStartedEvent {
  return {
    type: "RUN_STARTED",
    threadId: opts?.threadId ?? randomUUID(),
    runId: opts?.runId ?? randomUUID(),
    ...(opts?.parentRunId ? { parentRunId: opts.parentRunId } : {}),
  };
}

function makeRunFinished(
  started: AGUIRunStartedEvent,
  finishOpts?: { outcome?: AGUIRunFinishedOutcome; result?: unknown },
): AGUIRunFinishedEvent {
  return {
    type: "RUN_FINISHED",
    threadId: started.threadId,
    runId: started.runId,
    ...(finishOpts?.result !== undefined ? { result: finishOpts.result } : {}),
    ...(finishOpts?.outcome !== undefined ? { outcome: finishOpts.outcome } : {}),
  };
}

/**
 * Build a complete text message response sequence.
 * [RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, RUN_FINISHED]
 */
export function buildTextResponse(text: string, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const messageId = randomUUID();
  return [
    started,
    {
      type: "TEXT_MESSAGE_START",
      messageId,
      role: "assistant",
    } as AGUITextMessageStartEvent,
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta: text,
    } as AGUITextMessageContentEvent,
    {
      type: "TEXT_MESSAGE_END",
      messageId,
    } as AGUITextMessageEndEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a text chunk response (single chunk, no start/end envelope).
 * [RUN_STARTED, TEXT_MESSAGE_CHUNK, RUN_FINISHED]
 */
export function buildTextChunkResponse(text: string, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "TEXT_MESSAGE_CHUNK",
      messageId: randomUUID(),
      role: "assistant",
      delta: text,
    } as AGUITextMessageChunkEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a tool call response sequence.
 * [RUN_STARTED, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, (TOOL_CALL_RESULT)?, RUN_FINISHED]
 */
export function buildToolCallResponse(
  toolName: string,
  args: string,
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const toolCallId = randomUUID();
  const events: AGUIEvent[] = [
    started,
    {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: toolName,
    } as AGUIToolCallStartEvent,
    {
      type: "TOOL_CALL_ARGS",
      toolCallId,
      delta: args,
    } as AGUIToolCallArgsEvent,
    {
      type: "TOOL_CALL_END",
      toolCallId,
    } as AGUIToolCallEndEvent,
  ];

  if (opts?.result !== undefined) {
    events.push({
      type: "TOOL_CALL_RESULT",
      messageId: randomUUID(),
      toolCallId,
      content: opts.result,
      role: "tool",
    } as AGUIToolCallResultEvent);
  }

  events.push(makeRunFinished(started));
  return events;
}

/**
 * Build a state snapshot response.
 * [RUN_STARTED, STATE_SNAPSHOT, RUN_FINISHED]
 */
export function buildStateUpdate(snapshot: unknown, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "STATE_SNAPSHOT",
      snapshot,
    } as AGUIStateSnapshotEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a state delta response (JSON Patch).
 * [RUN_STARTED, STATE_DELTA, RUN_FINISHED]
 */
export function buildStateDelta(patches: unknown[], opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "STATE_DELTA",
      delta: patches,
    } as AGUIStateDeltaEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a messages snapshot response.
 * [RUN_STARTED, MESSAGES_SNAPSHOT, RUN_FINISHED]
 */
export function buildMessagesSnapshot(messages: AGUIMessage[], opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "MESSAGES_SNAPSHOT",
      messages,
    } as AGUIMessagesSnapshotEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a reasoning response sequence.
 * [RUN_STARTED, REASONING_START, REASONING_MESSAGE_START, REASONING_MESSAGE_CONTENT,
 *  REASONING_MESSAGE_END, REASONING_END, RUN_FINISHED]
 */
export function buildReasoningResponse(text: string, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const messageId = randomUUID();
  return [
    started,
    {
      type: "REASONING_START",
      messageId,
    } as AGUIReasoningStartEvent,
    {
      type: "REASONING_MESSAGE_START",
      messageId,
      role: "reasoning",
    } as AGUIReasoningMessageStartEvent,
    {
      type: "REASONING_MESSAGE_CONTENT",
      messageId,
      delta: text,
    } as AGUIReasoningMessageContentEvent,
    {
      type: "REASONING_MESSAGE_END",
      messageId,
    } as AGUIReasoningMessageEndEvent,
    {
      type: "REASONING_END",
      messageId,
    } as AGUIReasoningEndEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build an activity snapshot response.
 * [RUN_STARTED, ACTIVITY_SNAPSHOT, RUN_FINISHED]
 */
export function buildActivityResponse(
  messageId: string,
  activityType: string,
  content: Record<string, unknown>,
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId,
      activityType,
      content,
      replace: true,
    } as AGUIActivitySnapshotEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build an error response.
 * [RUN_STARTED, RUN_ERROR] (no RUN_FINISHED — the run errored)
 */
export function buildErrorResponse(
  message: string,
  code?: string,
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "RUN_ERROR",
      message,
      ...(code !== undefined ? { code } : {}),
    } as AGUIRunErrorEvent,
  ];
}

/**
 * Build a step-wrapped text response.
 * [RUN_STARTED, STEP_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT,
 *  TEXT_MESSAGE_END, STEP_FINISHED, RUN_FINISHED]
 */
export function buildStepWithText(
  stepName: string,
  text: string,
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const messageId = randomUUID();
  return [
    started,
    {
      type: "STEP_STARTED",
      stepName,
    } as AGUIStepStartedEvent,
    {
      type: "TEXT_MESSAGE_START",
      messageId,
      role: "assistant",
    } as AGUITextMessageStartEvent,
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta: text,
    } as AGUITextMessageContentEvent,
    {
      type: "TEXT_MESSAGE_END",
      messageId,
    } as AGUITextMessageEndEvent,
    {
      type: "STEP_FINISHED",
      stepName,
    } as AGUIStepFinishedEvent,
    makeRunFinished(started),
  ];
}

/**
 * Combine multiple builder outputs into a single run.
 * Strips RUN_STARTED/RUN_FINISHED from each input, wraps all inner events
 * in one RUN_STARTED...RUN_FINISHED pair.
 */
export function buildCompositeResponse(
  builderOutputs: AGUIEvent[][],
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  const inner: AGUIEvent[] = [];

  for (const events of builderOutputs) {
    for (const event of events) {
      if (event.type !== "RUN_STARTED" && event.type !== "RUN_FINISHED") {
        inner.push(event);
      }
    }
  }

  const hasError = inner.some((e) => e.type === "RUN_ERROR");
  return [started, ...inner, ...(hasError ? [] : [makeRunFinished(started)])];
}

// ─── Convenience event builders ─────────────────────────────────────────────

/**
 * Build an activity delta response (JSON Patch on an activity).
 * [RUN_STARTED, ACTIVITY_DELTA, RUN_FINISHED]
 */
export function buildActivityDelta(
  messageId: string,
  activityType: string,
  patch: unknown[],
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "ACTIVITY_DELTA",
      messageId,
      activityType,
      patch,
    } as AGUIActivityDeltaEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a tool call chunk response (single chunk, no start/end envelope).
 * [RUN_STARTED, TOOL_CALL_CHUNK, RUN_FINISHED]
 */
export function buildToolCallChunk(
  delta: string,
  opts?: AGUIBuildOpts & {
    toolCallId?: string;
    toolCallName?: string;
    parentMessageId?: string;
  },
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "TOOL_CALL_CHUNK",
      ...(opts?.toolCallId !== undefined ? { toolCallId: opts.toolCallId } : {}),
      ...(opts?.toolCallName !== undefined ? { toolCallName: opts.toolCallName } : {}),
      ...(opts?.parentMessageId !== undefined ? { parentMessageId: opts.parentMessageId } : {}),
      delta,
    } as AGUIToolCallChunkEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a raw event response.
 * [RUN_STARTED, RAW, RUN_FINISHED]
 */
export function buildRawEvent(event: unknown, source?: string, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "RAW",
      event,
      ...(source !== undefined ? { source } : {}),
    } as AGUIRawEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a custom event response.
 * [RUN_STARTED, CUSTOM, RUN_FINISHED]
 */
export function buildCustomEvent(name: string, value: unknown, opts?: AGUIBuildOpts): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "CUSTOM",
      name,
      value,
    } as AGUICustomEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a reasoning message chunk response (single chunk, no start/end envelope).
 * [RUN_STARTED, REASONING_MESSAGE_CHUNK, RUN_FINISHED]
 */
export function buildReasoningChunk(
  delta: string,
  opts?: AGUIBuildOpts & { messageId?: string },
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "REASONING_MESSAGE_CHUNK",
      ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
      delta,
    } as AGUIReasoningMessageChunkEvent,
    makeRunFinished(started),
  ];
}

/**
 * Build a reasoning encrypted value event response.
 * [RUN_STARTED, REASONING_ENCRYPTED_VALUE, RUN_FINISHED]
 */
export function buildReasoningEncryptedValue(
  subtype: AGUIReasoningEncryptedValueSubtype,
  entityId: string,
  encryptedValue: string,
  opts?: AGUIBuildOpts,
): AGUIEvent[] {
  const started = makeRunStarted(opts);
  return [
    started,
    {
      type: "REASONING_ENCRYPTED_VALUE",
      subtype,
      entityId,
      encryptedValue,
    } as AGUIReasoningEncryptedValueEvent,
    makeRunFinished(started),
  ];
}

// ─── SSE writer ──────────────────────────────────────────────────────────────

/**
 * Write AG-UI events as an SSE stream to an HTTP response.
 * Sets appropriate headers, serializes each event as `data: {...}\n\n`,
 * and optionally delays between events.
 */
export async function writeAGUIEventStream(
  res: http.ServerResponse,
  events: AGUIEvent[],
  opts?: { delayMs?: number; signal?: AbortSignal; logger?: Logger },
): Promise<void> {
  const delayMs = opts?.delayMs ?? 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const event of events) {
    if (opts?.signal?.aborted) break;
    if (res.socket?.destroyed) break;

    const stamped = { ...event, timestamp: event.timestamp ?? Date.now() };
    try {
      res.write(`data: ${JSON.stringify(stamped)}\n\n`);
    } catch (err) {
      if (err instanceof TypeError || err instanceof RangeError) {
        const msg = (err as Error).message;
        if (opts?.logger) {
          opts.logger.warn("AG-UI SSE write failed (serialization):", msg);
        } else {
          console.warn("AG-UI SSE write failed (serialization):", msg);
        }
      } else if (err instanceof Error) {
        if (opts?.logger) {
          opts.logger.warn("AG-UI SSE write failed:", err.message);
        } else {
          console.warn("AG-UI SSE write failed:", err.message);
        }
      } else {
        const msg = String(err);
        if (opts?.logger) {
          opts.logger.warn("AG-UI SSE write failed:", msg);
        } else {
          console.warn("AG-UI SSE write failed:", msg);
        }
      }
      break;
    }

    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!res.writableEnded) res.end();
}
