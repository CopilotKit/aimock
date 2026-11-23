// ─── AG-UI Protocol Types ────────────────────────────────────────────────────
//
// Type definitions for the AG-UI (Agent-User Interaction) protocol.
// Canonical source: @ag-ui/core (ag-ui/sdks/typescript/packages/core/src/events.ts)

// ─── Event type string union ─────────────────────────────────────────────────

export type AGUIEventType =
  // Lifecycle
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "STEP_STARTED"
  | "STEP_FINISHED"
  // Text messages
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "TEXT_MESSAGE_CHUNK"
  // Tool calls
  | "TOOL_CALL_START"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_END"
  | "TOOL_CALL_CHUNK"
  | "TOOL_CALL_RESULT"
  // State
  | "STATE_SNAPSHOT"
  | "STATE_DELTA"
  | "MESSAGES_SNAPSHOT"
  // Activity
  | "ACTIVITY_SNAPSHOT"
  | "ACTIVITY_DELTA"
  // Reasoning
  | "REASONING_START"
  | "REASONING_MESSAGE_START"
  | "REASONING_MESSAGE_CONTENT"
  | "REASONING_MESSAGE_END"
  | "REASONING_MESSAGE_CHUNK"
  | "REASONING_END"
  | "REASONING_ENCRYPTED_VALUE"
  // Subagents
  | "SUBAGENT_STARTED"
  | "SUBAGENT_FINISHED"
  | "SUBAGENT_ERROR"
  // Special
  | "RAW"
  | "CUSTOM"
  // Deprecated (pre-1.0)
  | "THINKING_START"
  | "THINKING_END"
  | "THINKING_TEXT_MESSAGE_START"
  | "THINKING_TEXT_MESSAGE_CONTENT"
  | "THINKING_TEXT_MESSAGE_END";

// ─── Base event fields ───────────────────────────────────────────────────────

export interface AGUIBaseEvent {
  type: AGUIEventType;
  timestamp?: number;
  rawEvent?: unknown;
  // Declared once here because canonical AG-UI declares it once on
  // BaseEventSchema, so every event type carries it.
  metadata?: Record<string, unknown>;
}

// ─── Individual event interfaces ─────────────────────────────────────────────

// Lifecycle

export interface AGUIRunStartedEvent extends AGUIBaseEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  protocolVersion?: string;
  parentRunId?: string;
  input?: AGUIRunAgentInput;
}

export interface AGUIRunFinishedEvent extends AGUIBaseEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  result?: unknown;
  outcome?: AGUIRunFinishedOutcome;
  usage?: AGUITokenUsage[];
}

export interface AGUIRunErrorEvent extends AGUIBaseEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
  usage?: AGUITokenUsage[];
}

export interface AGUIStepStartedEvent extends AGUIBaseEvent {
  type: "STEP_STARTED";
  stepName: string;
  subagentRunId?: string;
}

export interface AGUIStepFinishedEvent extends AGUIBaseEvent {
  type: "STEP_FINISHED";
  stepName: string;
  subagentRunId?: string;
}

// Text messages

export type AGUITextMessageRole = "developer" | "system" | "assistant" | "user";

export type AGUIMessageRole =
  | "developer"
  | "system"
  | "assistant"
  | "user"
  | "tool"
  | "activity"
  | "reasoning";

export interface AGUITextMessageStartEvent extends AGUIBaseEvent {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role: AGUITextMessageRole;
  name?: string;
  subagentRunId?: string;
}

export interface AGUITextMessageContentEvent extends AGUIBaseEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
  subagentRunId?: string;
}

export interface AGUITextMessageEndEvent extends AGUIBaseEvent {
  type: "TEXT_MESSAGE_END";
  messageId: string;
  subagentRunId?: string;
}

export interface AGUITextMessageChunkEvent extends AGUIBaseEvent {
  type: "TEXT_MESSAGE_CHUNK";
  messageId?: string;
  role?: AGUITextMessageRole;
  delta?: string;
  name?: string;
  subagentRunId?: string;
}

// Tool calls

export interface AGUIToolCallStartEvent extends AGUIBaseEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
  subagentRunId?: string;
}

export interface AGUIToolCallArgsEvent extends AGUIBaseEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
  subagentRunId?: string;
}

export interface AGUIToolCallEndEvent extends AGUIBaseEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
  subagentRunId?: string;
}

export interface AGUIToolCallChunkEvent extends AGUIBaseEvent {
  type: "TOOL_CALL_CHUNK";
  toolCallId?: string;
  toolCallName?: string;
  parentMessageId?: string;
  delta?: string;
  subagentRunId?: string;
}

export interface AGUIToolCallResultEvent extends AGUIBaseEvent {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  content: string;
  role?: "tool";
  subagentRunId?: string;
}

// State

export interface AGUIStateSnapshotEvent extends AGUIBaseEvent {
  type: "STATE_SNAPSHOT";
  snapshot: unknown;
  subagentRunId?: string;
}

export interface AGUIStateDeltaEvent extends AGUIBaseEvent {
  type: "STATE_DELTA";
  delta: unknown[]; // JSON Patch (RFC 6902)
  subagentRunId?: string;
}

export interface AGUIMessagesSnapshotEvent extends AGUIBaseEvent {
  type: "MESSAGES_SNAPSHOT";
  messages: AGUIMessage[];
}

// Activity

export interface AGUIActivitySnapshotEvent extends AGUIBaseEvent {
  type: "ACTIVITY_SNAPSHOT";
  messageId: string;
  activityType: string;
  content: Record<string, unknown>;
  replace?: boolean;
  subagentRunId?: string;
}

export interface AGUIActivityDeltaEvent extends AGUIBaseEvent {
  type: "ACTIVITY_DELTA";
  messageId: string;
  activityType: string;
  patch: unknown[];
  subagentRunId?: string;
}

// Reasoning

export interface AGUIReasoningStartEvent extends AGUIBaseEvent {
  type: "REASONING_START";
  messageId: string;
  subagentRunId?: string;
}

export interface AGUIReasoningMessageStartEvent extends AGUIBaseEvent {
  type: "REASONING_MESSAGE_START";
  messageId: string;
  role: "reasoning";
  subagentRunId?: string;
}

export interface AGUIReasoningMessageContentEvent extends AGUIBaseEvent {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
  subagentRunId?: string;
}

export interface AGUIReasoningMessageEndEvent extends AGUIBaseEvent {
  type: "REASONING_MESSAGE_END";
  messageId: string;
  subagentRunId?: string;
}

export interface AGUIReasoningMessageChunkEvent extends AGUIBaseEvent {
  type: "REASONING_MESSAGE_CHUNK";
  messageId?: string;
  delta?: string;
  subagentRunId?: string;
}

export interface AGUIReasoningEndEvent extends AGUIBaseEvent {
  type: "REASONING_END";
  messageId: string;
  subagentRunId?: string;
}

export type AGUIReasoningEncryptedValueSubtype = "tool-call" | "message";

export interface AGUIReasoningEncryptedValueEvent extends AGUIBaseEvent {
  type: "REASONING_ENCRYPTED_VALUE";
  subtype: AGUIReasoningEncryptedValueSubtype;
  entityId: string;
  encryptedValue: string;
  subagentRunId?: string;
}

// Subagents

export interface AGUISubagentStartedEvent extends AGUIBaseEvent {
  type: "SUBAGENT_STARTED";
  subagentRunId: string;
  name: string;
  description?: string;
  parentSubagentRunId?: string;
  // Link back to the tool call (and the message that held it) that spawned this
  // subagent, for the agents-as-tools pattern. Lets a consumer correlate the
  // subagent to its spawning call without inspecting rawEvent.metadata.
  parentToolCallId?: string;
  parentMessageId?: string;
}

export interface AGUISubagentFinishedEvent extends AGUIBaseEvent {
  type: "SUBAGENT_FINISHED";
  subagentRunId: string;
  result?: unknown;
  // Absent means success (the legacy reading). Unlike RUN_FINISHED.outcome this
  // field postdates the valueless-field cleanup, so it never tolerates null.
  outcome?: AGUISubagentFinishedOutcome;
}

export interface AGUISubagentErrorEvent extends AGUIBaseEvent {
  type: "SUBAGENT_ERROR";
  subagentRunId: string;
  message: string;
  code?: string;
}

// Special

export interface AGUIRawEvent extends AGUIBaseEvent {
  type: "RAW";
  event: unknown;
  source?: string;
  subagentRunId?: string;
}

export interface AGUICustomEvent extends AGUIBaseEvent {
  type: "CUSTOM";
  name: string;
  value: unknown;
  subagentRunId?: string;
}

// Deprecated

export interface AGUIThinkingStartEvent extends AGUIBaseEvent {
  type: "THINKING_START";
  title?: string;
}

export interface AGUIThinkingEndEvent extends AGUIBaseEvent {
  type: "THINKING_END";
}

export interface AGUIThinkingTextMessageStartEvent extends AGUIBaseEvent {
  type: "THINKING_TEXT_MESSAGE_START";
}

export interface AGUIThinkingTextMessageContentEvent extends AGUIBaseEvent {
  type: "THINKING_TEXT_MESSAGE_CONTENT";
  delta: string;
}

export interface AGUIThinkingTextMessageEndEvent extends AGUIBaseEvent {
  type: "THINKING_TEXT_MESSAGE_END";
}

// ─── Discriminated union of all events ───────────────────────────────────────

export type AGUIEvent =
  | AGUIRunStartedEvent
  | AGUIRunFinishedEvent
  | AGUIRunErrorEvent
  | AGUIStepStartedEvent
  | AGUIStepFinishedEvent
  | AGUITextMessageStartEvent
  | AGUITextMessageContentEvent
  | AGUITextMessageEndEvent
  | AGUITextMessageChunkEvent
  | AGUIToolCallStartEvent
  | AGUIToolCallArgsEvent
  | AGUIToolCallEndEvent
  | AGUIToolCallChunkEvent
  | AGUIToolCallResultEvent
  | AGUIStateSnapshotEvent
  | AGUIStateDeltaEvent
  | AGUIMessagesSnapshotEvent
  | AGUIActivitySnapshotEvent
  | AGUIActivityDeltaEvent
  | AGUIReasoningStartEvent
  | AGUIReasoningMessageStartEvent
  | AGUIReasoningMessageContentEvent
  | AGUIReasoningMessageEndEvent
  | AGUIReasoningMessageChunkEvent
  | AGUIReasoningEndEvent
  | AGUIReasoningEncryptedValueEvent
  | AGUISubagentStartedEvent
  | AGUISubagentFinishedEvent
  | AGUISubagentErrorEvent
  | AGUIRawEvent
  | AGUICustomEvent
  | AGUIThinkingStartEvent
  | AGUIThinkingEndEvent
  | AGUIThinkingTextMessageStartEvent
  | AGUIThinkingTextMessageContentEvent
  | AGUIThinkingTextMessageEndEvent;

// ─── Interrupt / Resume types ────────────────────────────────────────────────

export interface AGUIInterrupt {
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  responseSchema?: Record<string, unknown>;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  // The subagent whose work raised this interrupt; absent when the root raised
  // it. Attribution sits on each interrupt rather than on the run because one
  // run can carry interrupts from several subagents, so a consumer can render
  // the request inside its own subagent's group.
  subagentRunId?: string;
}

export interface AGUIResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

export type AGUIRunFinishedOutcome =
  | { type: "success" }
  | { type: "interrupt"; interrupts: AGUIInterrupt[] };

/**
 * Mirrors `AGUIRunFinishedOutcome` one level down: a subagent's terminal closes
 * its stream segment for this run either because the work completed
 * ("success") or because the workflow is paused awaiting outside input
 * ("suspended" — on resume the same `subagentRunId` is re-announced as a
 * continuation). `interruptIds` names the run-level interrupts this subagent
 * directly owns, and may be absent: an ancestor that suspended because a
 * descendant interrupted owns no interrupt itself.
 */
export type AGUISubagentFinishedOutcome =
  | { type: "success" }
  | { type: "suspended"; interruptIds?: string[] };

/**
 * Numeric-only token usage summary, mirroring `TokenUsageSchema` in
 * `@ag-ui/core`. Deliberately carries no content-bearing or identifying
 * fields — only provider/model labels and non-negative integer token counts.
 * Carried as an array on RUN_FINISHED / RUN_ERROR so a run that invokes
 * multiple models keeps them separate.
 */
export interface AGUITokenUsage {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

// ─── Request types ───────────────────────────────────────────────────────────

export interface AGUIRunAgentInput {
  threadId: string;
  runId: string;
  parentRunId?: string;
  state?: unknown;
  messages?: AGUIMessage[];
  tools?: AGUIToolDefinition[];
  context?: Array<{ description: string; value: string }>;
  forwardedProps?: unknown;
  resume?: AGUIResumeEntry[];
}

export interface AGUIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  encryptedValue?: string;
}

export type AGUIMessageContentPart =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export interface AGUIMessage {
  id: string;
  role: AGUIMessageRole;
  content?: string | AGUIMessageContentPart[];
  name?: string;
  encryptedValue?: string;
  error?: string;
  toolCallId?: string;
  toolCalls?: AGUIToolCall[];
  subagentRunId?: string;
}

export interface AGUIToolDefinition {
  name: string;
  description: string;
  parameters?: unknown; // JSON Schema
  metadata?: Record<string, unknown>;
}

// ─── Fixture types ───────────────────────────────────────────────────────────

export interface AGUIFixtureMatch {
  message?: string | RegExp;
  toolCallId?: string;
  toolName?: string;
  stateKey?: string;
  predicate?: (input: AGUIRunAgentInput) => boolean;
}

export interface AGUIFixture {
  match: AGUIFixtureMatch;
  events: AGUIEvent[];
  delayMs?: number;
}

export interface AGUIMockOptions {
  port?: number;
  host?: string;
  logLevel?: string;
}

export interface AGUIRecordConfig {
  upstream: string;
  fixturePath?: string;
  proxyOnly?: boolean;
  /**
   * Maximum number of bytes the AG-UI recorder will accumulate in memory from a
   * single proxied upstream SSE stream in order to parse + journal it. The full
   * stream is still relayed to the client byte-for-byte in real time; this cap
   * only bounds the in-memory buffer that is later `Buffer.concat`-ed and
   * stringified for fixture construction. Once exceeded the recorder stops
   * appending to the buffer, marks the recording truncated, and skips fixture
   * construction — preventing both unbounded heap growth and the
   * `RangeError: Invalid string length` a >512MB `Buffer.concat(chunks).toString()`
   * would otherwise throw. Clamped to `AGUI_RECORD_BUFFER_HARD_CEILING`.
   * Default: 64 MiB.
   */
  maxRecordBufferBytes?: number;
}
