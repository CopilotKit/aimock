/**
 * Anthropic Claude Messages API support.
 *
 * Translates incoming /v1/messages requests into the ChatCompletionRequest
 * format used by the fixture router, and converts fixture responses back into
 * the Claude Messages API streaming (or non-streaming) format.
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
  resolveReasoningForModel,
  strictOverrideField,
  getContext,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse, delay, calculateDelay } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

/**
 * Non-empty placeholder signature written into emitted `thinking` blocks.
 *
 * The real Anthropic signature is a cryptographic value aimock cannot
 * reproduce, but extended-thinking invariant (b) requires a non-empty
 * `signature` on the leading thinking block of a tool-loop continuation turn.
 * Emitting "" would make a record→replay round-trip of an aimock thinking turn
 * self-trip that invariant under strict mode. A non-empty placeholder keeps
 * round-trips green; the invariant only checks for non-emptiness, not value.
 */
const PLACEHOLDER_SIGNATURE = "aimock-placeholder-signature";

// ─── Claude Messages API request types ──────────────────────────────────────

interface ClaudeContentBlock {
  type:
    | "text"
    | "tool_use"
    | "tool_result"
    | "image"
    | "document"
    | "thinking"
    | "redacted_thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ClaudeContentBlock[];
  is_error?: boolean;
  // Extended-thinking fields (Anthropic): `thinking` blocks carry the reasoning
  // text plus a cryptographic `signature`; `redacted_thinking` blocks carry an
  // opaque `data` payload instead.
  thinking?: string;
  signature?: string;
  data?: string;
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

interface ClaudeToolDef {
  name: string;
  description?: string;
  input_schema?: object;
}

interface ClaudeRequest {
  model: string;
  messages: ClaudeMessage[];
  system?: string | ClaudeContentBlock[];
  tools?: ClaudeToolDef[];
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens: number;
  temperature?: number;
  // Extended-thinking config. Explicitly modeled so it is no longer swallowed
  // by the index signature below; read defensively (may be a non-object).
  thinking?: { type?: "enabled" | "disabled"; budget_tokens?: number };
  [key: string]: unknown;
}

// ─── Extended-thinking request invariants (Anthropic) ───────────────────────

/**
 * A detected violation of the Anthropic extended-thinking request invariants on
 * a tool-loop continuation turn. `kind` distinguishes the three failure modes
 * so callers can template a per-kind error message and tests can assert without
 * string matching.
 */
interface ThinkingViolation {
  kind: "missing_thinking_first" | "missing_signature" | "dropped_redacted_thinking";
  messageIndex: number;
  observedFirstBlockType?: string;
}

// ─── Input conversion: Claude → ChatCompletions messages ────────────────────

function extractClaudeTextContent(content: string | ClaudeContentBlock[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b != null && typeof b === "object" && b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

export function claudeToCompletionRequest(req: ClaudeRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // system field → system message
  if (req.system) {
    const systemText =
      typeof req.system === "string"
        ? req.system
        : Array.isArray(req.system)
          ? req.system
              .filter((b) => b != null && typeof b === "object" && b.type === "text")
              .map((b) => b.text ?? "")
              .join("")
          : "";
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  const reqMessages = Array.isArray(req.messages) ? req.messages : [];
  for (const msg of reqMessages) {
    // `req.messages` is untrusted JSON; entries may be null / non-object.
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "user") {
      // Check for tool_result blocks
      if (typeof msg.content !== "string" && Array.isArray(msg.content)) {
        // Content blocks are equally untrusted; skip null / non-object entries.
        const blocks = msg.content.filter((b) => b != null && typeof b === "object");
        const toolResults = blocks.filter((b) => b.type === "tool_result");
        const textBlocks = blocks.filter((b) => b.type === "text");

        if (toolResults.length > 0) {
          // Each tool_result → tool message
          for (const tr of toolResults) {
            const resultContent =
              typeof tr.content === "string"
                ? tr.content
                : Array.isArray(tr.content)
                  ? tr.content
                      .filter((b) => b != null && typeof b === "object" && b.type === "text")
                      .map((b) => b.text ?? "")
                      .join("")
                  : "";
            messages.push({
              role: "tool",
              content: resultContent,
              tool_call_id: tr.tool_use_id,
            });
          }
          // Any accompanying text blocks → user message
          if (textBlocks.length > 0) {
            messages.push({
              role: "user",
              content: textBlocks.map((b) => b.text ?? "").join(""),
            });
          }
          continue;
        }
      }
      // Regular user message
      messages.push({
        role: "user",
        content: extractClaudeTextContent(msg.content),
      });
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        messages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolUseBlocks = msg.content.filter(
          (b) => b != null && typeof b === "object" && b.type === "tool_use",
        );
        // Only `text` blocks feed fixture matching; `thinking` /
        // `redacted_thinking` blocks are intentionally excluded from the
        // matchable content.
        const textContent = extractClaudeTextContent(msg.content);

        if (toolUseBlocks.length > 0) {
          messages.push({
            role: "assistant",
            content: textContent || null,
            tool_calls: toolUseBlocks.map((b) => ({
              id: b.id ?? generateToolUseId(),
              type: "function" as const,
              function: {
                name: b.name ?? "",
                arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}),
              },
            })),
          });
        } else {
          messages.push({ role: "assistant", content: textContent || null });
        }
      } else {
        // null/undefined content — tool-only assistant turn
        messages.push({ role: "assistant", content: null });
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
    model: req.model,
    messages,
    stream: req.stream,
    temperature: req.temperature,
    max_tokens: req.max_tokens,
    tools,
    _endpointType: "chat",
  };
}

// ─── Extended-thinking invariant validation ─────────────────────────────────

/** True iff `req.thinking` is an object with `type === "enabled"`. */
function isThinkingEnabled(req: ClaudeRequest): boolean {
  const t = req.thinking;
  return typeof t === "object" && t !== null && (t as { type?: unknown }).type === "enabled";
}

/**
 * True iff the user turn at `req.messages[userIndex]` carries a `tool_result`
 * referencing one of `toolUseIds` — i.e. it answers the preceding assistant
 * turn's `tool_use` block(s), making that assistant turn a tool-loop
 * continuation point.
 */
function userTurnAnswersToolUse(msg: ClaudeMessage | undefined, toolUseIds: Set<string>): boolean {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) return false;
  return msg.content.some(
    (b) =>
      b != null &&
      typeof b === "object" &&
      b.type === "tool_result" &&
      typeof b.tool_use_id === "string" &&
      toolUseIds.has(b.tool_use_id),
  );
}

/**
 * Validate the Anthropic extended-thinking request invariants on tool-loop
 * continuation turns. Pure: returns the first detected `ThinkingViolation` or
 * `null` when thinking is disabled or every in-scope turn is well-formed.
 *
 * Scope: an assistant turn is in-scope only when it (a) is array content
 * carrying at least one `tool_use` block and (b) is followed by a matching
 * `tool_result` on the next user turn. Text-only / `end_turn` turns, string or
 * empty turns, and trailing unanswered `tool_use` turns are all exempt.
 *
 * Scope detection assumes well-formed Anthropic transcripts: `tool_use` ids are
 * unique, and a tool_use turn is answered by the immediately-following user
 * turn's `tool_result` (adjacency). Malformed shapes — non-adjacent answers,
 * idless `tool_use` blocks, or a `tool_result` separated from its `tool_use` by
 * intervening turns — are intentionally treated as out-of-scope (and therefore
 * not 400'd) rather than validated, since the real Anthropic API would never
 * have produced them.
 */
export function validateThinkingInvariants(req: ClaudeRequest): ThinkingViolation | null {
  if (!isThinkingEnabled(req)) return null;

  const messages = Array.isArray(req.messages) ? req.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // `req.messages` is untrusted JSON; entries may be null / non-object.
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "assistant" || !Array.isArray(msg.content) || msg.content.length === 0) {
      continue;
    }

    const toolUseIds = new Set<string>();
    for (const b of msg.content) {
      // Content blocks are equally untrusted; skip null / non-object entries.
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use" && typeof b.id === "string") toolUseIds.add(b.id);
    }
    // Not a tool_use-bearing turn → not a reasoning-bearing continuation turn.
    if (toolUseIds.size === 0) continue;
    // Trailing/unanswered tool_use (no matching tool_result follows) → out of scope.
    if (!userTurnAnswersToolUse(messages[i + 1], toolUseIds)) continue;

    const first = msg.content[0];

    // A null / non-object leading block cannot be a thinking block → it
    // violates invariant (a) just as a wrong-typed block would.
    if (!first || typeof first !== "object") {
      return {
        kind: "missing_thinking_first",
        messageIndex: i,
        observedFirstBlockType: undefined,
      };
    }

    // (a) The in-scope turn must lead with a thinking / redacted_thinking block.
    if (first.type !== "thinking" && first.type !== "redacted_thinking") {
      return {
        kind: "missing_thinking_first",
        messageIndex: i,
        observedFirstBlockType: first.type,
      };
    }

    // (b) A leading `thinking` block must carry a non-empty string `signature`.
    if (first.type === "thinking") {
      if (typeof first.signature !== "string" || first.signature.length === 0) {
        return { kind: "missing_signature", messageIndex: i };
      }
    }

    // (c) A leading `redacted_thinking` block must preserve a non-empty `data`.
    if (first.type === "redacted_thinking") {
      if (typeof first.data !== "string" || first.data.length === 0) {
        return { kind: "dropped_redacted_thinking", messageIndex: i };
      }
    }
  }

  return null;
}

/** Render the Anthropic-shaped 400 error message for a thinking violation. */
function thinkingViolationMessage(v: ThinkingViolation): string {
  const prefix = `messages.${v.messageIndex}.content.0`;
  switch (v.kind) {
    case "missing_thinking_first":
      return `${prefix}: when \`thinking\` is enabled, a tool-loop continuation assistant turn must begin with a \`thinking\` block; got \`${v.observedFirstBlockType ?? "unknown"}\`.`;
    case "missing_signature":
      return `${prefix}: the leading \`thinking\` block is missing a non-empty \`signature\`.`;
    case "dropped_redacted_thinking":
      return `${prefix}: the leading \`redacted_thinking\` block must preserve its \`data\`.`;
  }
}

// ─── Response building: fixture → Claude Messages API format ────────────────

function claudeStopReason(finishReason: string | undefined, defaultReason: string): string {
  if (!finishReason) return defaultReason;
  if (finishReason === "stop") return "end_turn";
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return finishReason;
}

function claudeUsage(overrides?: ResponseOverrides): {
  input_tokens: number;
  output_tokens: number;
} {
  if (!overrides?.usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: overrides.usage.input_tokens ?? overrides.usage.prompt_tokens ?? 0,
    output_tokens: overrides.usage.output_tokens ?? overrides.usage.completion_tokens ?? 0,
  };
}

interface ClaudeSSEEvent {
  type: string;
  [key: string]: unknown;
}

function buildClaudeTextStreamEvents(
  content: string,
  model: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
  reasoningSignature?: string,
): ClaudeSSEEvent[] {
  const msgId = overrides?.id ?? generateMessageId();
  const effectiveModel = overrides?.model ?? model;
  // Prefer a recorded real signature when one was captured; otherwise fall back
  // to the round-trip-safe placeholder.
  const signature = reasoningSignature ?? PLACEHOLDER_SIGNATURE;
  const events: ClaudeSSEEvent[] = [];

  // message_start
  events.push({
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: overrides?.role ?? "assistant",
      content: [],
      model: effectiveModel,
      stop_reason: null,
      stop_sequence: null,
      usage: claudeUsage(overrides),
    },
  });

  let blockIndex = 0;

  // Thinking block (emitted before text when reasoning is present)
  if (reasoning) {
    // Real Anthropic emits an empty `signature` on the thinking
    // `content_block_start`; the cryptographic signature arrives only via the
    // trailing `signature_delta`. Mirror that wire shape here.
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });

    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "thinking_delta", thinking: slice },
      });
    }

    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "signature_delta", signature },
    });

    events.push({
      type: "content_block_stop",
      index: blockIndex,
    });

    blockIndex++;
  }

  // content_block_start (text)
  events.push({
    type: "content_block_start",
    index: blockIndex,
    content_block: { type: "text", text: "" },
  });

  // content_block_delta — text chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: slice },
    });
  }

  // content_block_stop
  events.push({
    type: "content_block_stop",
    index: blockIndex,
  });

  // message_delta
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: claudeStopReason(overrides?.finishReason, "end_turn"),
      stop_sequence: null,
    },
    usage: { output_tokens: claudeUsage(overrides).output_tokens },
  });

  // message_stop
  events.push({ type: "message_stop" });

  return events;
}

function buildClaudeToolCallStreamEvents(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
  reasoningSignature?: string,
): ClaudeSSEEvent[] {
  const msgId = overrides?.id ?? generateMessageId();
  const effectiveModel = overrides?.model ?? model;
  // Prefer a recorded real signature when one was captured; otherwise fall back
  // to the round-trip-safe placeholder.
  const signature = reasoningSignature ?? PLACEHOLDER_SIGNATURE;
  const events: ClaudeSSEEvent[] = [];

  // message_start
  events.push({
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: overrides?.role ?? "assistant",
      content: [],
      model: effectiveModel,
      stop_reason: null,
      stop_sequence: null,
      usage: claudeUsage(overrides),
    },
  });

  let blockIndex = 0;

  // Optional thinking block (emitted before the tool_use blocks when reasoning
  // is present). Mirrors buildClaudeContentWithToolCallsStreamEvents exactly so
  // a pure-tool-call turn under extended thinking emits a leading thinking
  // block — without it, replaying the emitted turn under strict self-trips
  // `missing_thinking_first`.
  if (reasoning) {
    // Real Anthropic emits an empty `signature` on the thinking
    // `content_block_start`; the cryptographic signature arrives only via the
    // trailing `signature_delta`. Mirror that wire shape here.
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });

    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "thinking_delta", thinking: slice },
      });
    }

    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "signature_delta", signature },
    });

    events.push({
      type: "content_block_stop",
      index: blockIndex,
    });

    blockIndex++;
  }

  for (const tc of toolCalls) {
    const toolUseId = tc.id || generateToolUseId();

    // Parse arguments to JSON object (Claude uses objects, not strings)
    let argsObj: unknown;
    try {
      argsObj = JSON.parse(tc.arguments || "{}");
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsObj = {};
    }
    const argsJson = JSON.stringify(argsObj);

    // content_block_start
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolUseId,
        name: tc.name,
        input: {},
      },
    });

    // content_block_delta — input_json_delta chunks
    for (let i = 0; i < argsJson.length; i += chunkSize) {
      const slice = argsJson.slice(i, i + chunkSize);
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: slice },
      });
    }

    // content_block_stop
    events.push({
      type: "content_block_stop",
      index: blockIndex,
    });

    blockIndex++;
  }

  // message_delta
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: claudeStopReason(overrides?.finishReason, "tool_use"),
      stop_sequence: null,
    },
    usage: { output_tokens: claudeUsage(overrides).output_tokens },
  });

  // message_stop
  events.push({ type: "message_stop" });

  return events;
}

// Non-streaming response builders

function buildClaudeTextResponse(
  content: string,
  model: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
  reasoningSignature?: string,
): object {
  const contentBlocks: object[] = [];

  if (reasoning) {
    contentBlocks.push({
      type: "thinking",
      thinking: reasoning,
      // Prefer a recorded real signature; otherwise the round-trip-safe placeholder.
      signature: reasoningSignature ?? PLACEHOLDER_SIGNATURE,
    });
  }

  contentBlocks.push({ type: "text", text: content });

  return {
    id: overrides?.id ?? generateMessageId(),
    type: "message",
    role: overrides?.role ?? "assistant",
    content: contentBlocks,
    model: overrides?.model ?? model,
    stop_reason: claudeStopReason(overrides?.finishReason, "end_turn"),
    stop_sequence: null,
    usage: claudeUsage(overrides),
  };
}

function buildClaudeToolCallResponse(
  toolCalls: ToolCall[],
  model: string,
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
  reasoningSignature?: string,
): object {
  const contentBlocks: object[] = [];

  // Leading thinking block when reasoning is present — mirrors
  // buildClaudeContentWithToolCallsResponse so a pure-tool-call turn under
  // extended thinking carries the same leading thinking block.
  if (reasoning) {
    contentBlocks.push({
      type: "thinking",
      thinking: reasoning,
      // Prefer a recorded real signature; otherwise the round-trip-safe placeholder.
      signature: reasoningSignature ?? PLACEHOLDER_SIGNATURE,
    });
  }

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
      type: "tool_use",
      id: tc.id || generateToolUseId(),
      name: tc.name,
      input: argsObj,
    });
  }

  return {
    id: overrides?.id ?? generateMessageId(),
    type: "message",
    role: overrides?.role ?? "assistant",
    content: contentBlocks,
    model: overrides?.model ?? model,
    stop_reason: claudeStopReason(overrides?.finishReason, "tool_use"),
    stop_sequence: null,
    usage: claudeUsage(overrides),
  };
}

function buildClaudeContentWithToolCallsStreamEvents(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
  reasoningSignature?: string,
): ClaudeSSEEvent[] {
  const msgId = overrides?.id ?? generateMessageId();
  const effectiveModel = overrides?.model ?? model;
  // Prefer a recorded real signature when one was captured; otherwise fall back
  // to the round-trip-safe placeholder.
  const signature = reasoningSignature ?? PLACEHOLDER_SIGNATURE;
  const events: ClaudeSSEEvent[] = [];

  // message_start
  events.push({
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: overrides?.role ?? "assistant",
      content: [],
      model: effectiveModel,
      stop_reason: null,
      stop_sequence: null,
      usage: claudeUsage(overrides),
    },
  });

  let blockIndex = 0;

  // Optional thinking block
  if (reasoning) {
    // Real Anthropic emits an empty `signature` on the thinking
    // `content_block_start`; the cryptographic signature arrives only via the
    // trailing `signature_delta`. Mirror that wire shape here.
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });

    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "thinking_delta", thinking: slice },
      });
    }

    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "signature_delta", signature },
    });

    events.push({
      type: "content_block_stop",
      index: blockIndex,
    });

    blockIndex++;
  }

  // Text content block
  events.push({
    type: "content_block_start",
    index: blockIndex,
    content_block: { type: "text", text: "" },
  });

  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: slice },
    });
  }

  events.push({
    type: "content_block_stop",
    index: blockIndex,
  });

  blockIndex++;

  // Tool use blocks
  for (const tc of toolCalls) {
    const toolUseId = tc.id || generateToolUseId();

    let argsObj: unknown;
    try {
      argsObj = JSON.parse(tc.arguments || "{}");
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsObj = {};
    }
    const argsJson = JSON.stringify(argsObj);

    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolUseId,
        name: tc.name,
        input: {},
      },
    });

    for (let i = 0; i < argsJson.length; i += chunkSize) {
      const slice = argsJson.slice(i, i + chunkSize);
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: slice },
      });
    }

    events.push({
      type: "content_block_stop",
      index: blockIndex,
    });

    blockIndex++;
  }

  // message_delta
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: claudeStopReason(overrides?.finishReason, "tool_use"),
      stop_sequence: null,
    },
    usage: { output_tokens: claudeUsage(overrides).output_tokens },
  });

  // message_stop
  events.push({ type: "message_stop" });

  return events;
}

function buildClaudeContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
  reasoningSignature?: string,
): object {
  const contentBlocks: object[] = [];

  if (reasoning) {
    contentBlocks.push({
      type: "thinking",
      thinking: reasoning,
      // Prefer a recorded real signature; otherwise the round-trip-safe placeholder.
      signature: reasoningSignature ?? PLACEHOLDER_SIGNATURE,
    });
  }

  contentBlocks.push({ type: "text", text: content });

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
      type: "tool_use",
      id: tc.id || generateToolUseId(),
      name: tc.name,
      input: argsObj,
    });
  }

  return {
    id: overrides?.id ?? generateMessageId(),
    type: "message",
    role: overrides?.role ?? "assistant",
    content: contentBlocks,
    model: overrides?.model ?? model,
    stop_reason: claudeStopReason(overrides?.finishReason, "tool_use"),
    stop_sequence: null,
    usage: claudeUsage(overrides),
  };
}

// ─── SSE writer for Claude Messages API ─────────────────────────────────────

interface ClaudeStreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
  recordedTimings?: RecordedTimings;
  replaySpeed?: number;
  signal?: AbortSignal;
  onChunkSent?: () => void;
}

async function writeClaudeSSEStream(
  res: http.ServerResponse,
  events: ClaudeSSEEvent[],
  optionsOrLatency?: number | ClaudeStreamOptions,
): Promise<boolean> {
  const opts: ClaudeStreamOptions =
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

export async function handleMessages(
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

  let claudeReq: ClaudeRequest;
  try {
    claudeReq = JSON.parse(raw) as ClaudeRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/messages",
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

  // Extended-thinking invariant validation. The validator runs whenever
  // thinking is enabled (it self-short-circuits to null otherwise). On a
  // detected violation: strict ON → 400, strict OFF → warn + replay. Mirrors
  // the real Anthropic API, which 400s on these.
  const thinkingViolation = validateThinkingInvariants(claudeReq);
  if (thinkingViolation) {
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const violationMessage = thinkingViolationMessage(thinkingViolation);
    if (effectiveStrict) {
      logger.error(`THINKING: ${violationMessage}`);
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/v1/messages",
        headers: flattenHeaders(req.headers),
        body: null,
        response: {
          status: 400,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
      });
      writeErrorResponse(
        res,
        400,
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: violationMessage,
          },
        }),
      );
      return;
    }
    logger.warn(`THINKING: ${violationMessage} (strict off — replaying anyway)`);
    // Fall through to existing match/replay behavior.
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = claudeToCompletionRequest(claudeReq);
  completionReq._context = getContext(req);

  const testId = getTestId(req);
  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    const lastUserMsg = completionReq.messages.filter((m) => m.role === "user").pop();
    const snippet =
      typeof lastUserMsg?.content === "string" ? lastUserMsg.content.slice(0, 80) : "";
    logger.debug(
      `No fixture matched for request (model=${completionReq.model ?? "?"}, msg="${snippet}")`,
    );
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
        path: req.url ?? "/v1/messages",
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
      logger.error(
        `STRICT: No fixture matched for ${req.method ?? "POST"} ${req.url ?? "/v1/messages"}`,
      );
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/v1/messages",
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
        "anthropic",
        req.url ?? "/v1/messages",
        fixtures,
        defaults,
        raw,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: req.url ?? "/v1/messages",
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/messages",
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
      path: req.url ?? "/v1/messages",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    // Anthropic-style error format: { type: "error", error: { type, message } }
    const anthropicError = {
      type: "error",
      error: {
        type: response.error.type ?? "api_error",
        message: response.error.message,
      },
    };
    writeErrorResponse(res, status, JSON.stringify(anthropicError), {
      retryAfter: response.retryAfter,
    });
    return;
  }

  // Content + tool calls response (must be checked before text/tool-only branches)
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn(
        "webSearches in fixture response are not supported for Claude Messages API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      defaults.logger,
    );
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/messages",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (claudeReq.stream !== true) {
      const body = buildClaudeContentWithToolCallsResponse(
        response.content,
        response.toolCalls,
        completionReq.model,
        logger,
        effReasoning,
        overrides,
        response.reasoningSignature,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildClaudeContentWithToolCallsStreamEvents(
        response.content,
        response.toolCalls,
        completionReq.model,
        chunkSize,
        logger,
        effReasoning,
        overrides,
        response.reasoningSignature,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeClaudeSSEStream(res, events, {
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
        "webSearches in fixture response are not supported for Claude Messages API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      defaults.logger,
    );
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/messages",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (claudeReq.stream !== true) {
      const body = buildClaudeTextResponse(
        response.content,
        completionReq.model,
        effReasoning,
        overrides,
        response.reasoningSignature,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildClaudeTextStreamEvents(
        response.content,
        completionReq.model,
        chunkSize,
        effReasoning,
        overrides,
        response.reasoningSignature,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeClaudeSSEStream(res, events, {
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
        "webSearches in fixture response are not supported for Claude Messages API — ignoring",
      );
    }
    const overrides = extractOverrides(response);
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      defaults.logger,
    );
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/messages",
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (claudeReq.stream !== true) {
      const body = buildClaudeToolCallResponse(
        response.toolCalls,
        completionReq.model,
        logger,
        effReasoning,
        overrides,
        response.reasoningSignature,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const events = buildClaudeToolCallStreamEvents(
        response.toolCalls,
        completionReq.model,
        chunkSize,
        logger,
        effReasoning,
        overrides,
        response.reasoningSignature,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeClaudeSSEStream(res, events, {
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
    path: req.url ?? "/v1/messages",
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
