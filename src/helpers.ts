import type { MisbehaviorPlan, ServedMisbehaviorToolCall } from "./misbehavior.js";
import type { LiveFixtureResponse } from "./live-types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type * as http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { DEFAULT_TEST_ID, MCP_FAKES_ECHO_LIMIT } from "./constants.js";
import { cutText } from "./echo-text.js";
import { build, fixed, msg, quote, type MessageValue } from "./message-text.js";
import type { Logger } from "./logger.js";
import { isReasoningModel } from "./model-utils.js";
import { isRecognizedApiKeyHeader } from "./api-key-auth.js";
import type {
  ChatCompletionRequest,
  Fixture,
  FixtureMatch,
  FixtureResponse,
  ResponseFactory,
  TextResponse,
  ToolCallResponse,
  ContentWithToolCallsResponse,
  ErrorResponse,
  EmbeddingResponse,
  ImageResponse,
  AudioResponse,
  TranscriptionResponse,
  VideoResponse,
  RawJSONResponse,
  SSEChunk,
  ToolCall,
  FixtureToolCall,
  CustomToolCall,
  JournalEntry,
  FixtureBlock,
  FixtureFileBlock,
  FixtureFileResponsesBlock,
  ResponsesFixtureBlock,
  ChatCompletion,
  ResponseOverrides,
  RecordConfig,
  RecordProviderKey,
  McpFakeIdentity,
  McpFakeUndeclaredPolicy,
} from "./types.js";
import type { MCPSession } from "./mcp-types.js";

/** Preserve authored text for string wires without silently repairing invalid JSON. */
export function toolArgsForWire(tc: Pick<ToolCall, "name" | "arguments">) {
  const raw = tc.arguments || "{}";
  try {
    const value: unknown = JSON.parse(raw);
    return { kind: "parsed" as const, value, text: JSON.stringify(value), raw };
  } catch {
    return { kind: "verbatim" as const, raw };
  }
}

/** Object wires reject the verbatim branch; string wires never need this error. */
export class InvalidToolArgumentsError extends Error {
  readonly toolName: string;
  readonly parseDiagnostic: string;

  constructor(tc: Pick<ToolCall, "name" | "arguments">) {
    let parseDiagnostic = "";
    try {
      JSON.parse(tc.arguments || "{}");
    } catch (error) {
      parseDiagnostic = error instanceof Error ? error.message : String(error);
    }
    super(
      `aimock: fixture tool call "${tc.name}" has invalid JSON arguments; this wire carries arguments as an object. ` +
        `Use a wire that carries tool arguments as a string to test malformed JSON. (${parseDiagnostic})`,
    );
    this.name = "InvalidToolArgumentsError";
    this.toolName = tc.name;
    this.parseDiagnostic = parseDiagnostic;
  }
}

/**
 * The `strictToolArguments` server option and logger in effect for the request
 * being served. The server enters it once per HTTP request and once per Gemini
 * Live message, so response builders read it without extra parameters.
 */
interface ToolArgumentsScope {
  strict: boolean;
  logger?: Logger;
}

const toolArgumentsScope = new AsyncLocalStorage<ToolArgumentsScope>();

/** Run `fn` with the `strictToolArguments` setting and logger of one request. */
export function runWithToolArgumentsScope<T>(scope: ToolArgumentsScope, fn: () => T): T {
  return toolArgumentsScope.run(scope, fn);
}

/** Whether `strictToolArguments` is on for the request being served (default off). */
export function strictToolArgumentsEnabled(): boolean {
  return toolArgumentsScope.getStore()?.strict === true;
}

/**
 * Serve the rest of this request's tool arguments as authored (the
 * `strictToolArguments` behavior). An applied misbehavior fault calls this so
 * that the malformed arguments it injects are not replaced with `{}`; the
 * planner only applies a fault to a fixture whose own arguments are valid
 * wherever the default would replace them.
 */
export function keepAuthoredToolArguments(): void {
  const scope = toolArgumentsScope.getStore();
  if (scope) scope.strict = true;
}

/**
 * The fixture tool-call arguments a wire serves on its normal (no misbehavior)
 * path. Valid JSON gives the parsed value, its re-serialized text, and the
 * authored text. Invalid JSON logs one warning and, by default, is served as
 * `{}` / `"{}"`, as in 1.44.0. With `strictToolArguments`, an object wire
 * (`"object"`) throws {@link InvalidToolArgumentsError} and a string wire
 * (`"string"`) serves the authored text unchanged.
 */
export function servedToolArgs(
  tc: Pick<ToolCall, "name" | "arguments">,
  wire: "object" | "string",
  logger?: Logger,
): { value: unknown; text: string; raw: string } {
  const args = toolArgsForWire(tc);
  if (args.kind === "parsed") return args;
  const scope = toolArgumentsScope.getStore();
  (logger ?? scope?.logger)?.warn(
    `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
  );
  if (scope?.strict !== true) return { value: {}, text: "{}", raw: "{}" };
  if (wire === "object") throw new InvalidToolArgumentsError(tc);
  return { value: undefined, text: args.raw, raw: args.raw };
}

/**
 * A custom (freeform) tool call reached a wire that has no faithful projection
 * for it. Only the OpenAI Responses API (HTTP and WebSocket) emits custom tool
 * calls, from a fixture's `customToolCalls` or a `customToolCall` block in its
 * `responsesBlocks`. The handlers of the other wires raise this through
 * {@link rejectResponsesOnlyToolCalls} (usually via
 * {@link requireEmittedFunctionToolCalls}) before they write any content.
 * Ollama `/api/generate` is the exception: it rejects every tool-call fixture
 * with a 400 before this check.
 */
export class UnsupportedToolCallError extends Error {
  readonly toolName: string;
  readonly wire: string;

  constructor(toolName: string, wire: string) {
    super(
      `aimock: fixture tool call "${toolName}" is a custom tool call, which only the OpenAI Responses API supports; ` +
        `this request arrived on ${wire}`,
    );
    this.name = "UnsupportedToolCallError";
    this.toolName = toolName;
    this.wire = wire;
  }
}

/**
 * A fixture tool call is malformed: a `toolCalls` entry that is not an object,
 * a malformed `customToolCalls` entry, or a malformed tool block in
 * `responsesBlocks`. Programmatic and factory fixtures skip load validation,
 * so this request-time guard is their validation for the rules
 * {@link assertResponsesToolCalls} and {@link resolveResponsesBlocks} check.
 * An HTTP request then fails with a 500 that carries this message and `code`;
 * a WebSocket turn gets the transport's error message with the code. A
 * malformed legacy `blocks` entry keeps the plain Error of
 * {@link resolveFixtureBlocks}.
 */
export class InvalidFixtureToolCallError extends Error {
  readonly code = "aimock_invalid_fixture_tool_call";

  constructor(
    index: number,
    problem: string,
    carrier: "toolCalls" | "customToolCalls" | "blocks" = "toolCalls",
  ) {
    super(
      carrier === "blocks"
        ? `Invalid fixture block at index ${index}: ${problem}`
        : `Invalid fixture tool call: ${problem} (${carrier}[${index}])`,
    );
    this.name = "InvalidFixtureToolCallError";
  }
}

/**
 * Request-time guard for one custom tool call (a `customToolCalls` entry).
 * Programmatic and factory fixtures skip load validation, so this is their
 * validation: an object with a non-empty string `name`, a string `input`, no
 * `arguments`, a string `id` when present and a non-empty string `namespace`
 * when present.
 */
function assertCustomToolCall(call: unknown, index: number): void {
  const fail = (problem: string): never => {
    throw new InvalidFixtureToolCallError(index, problem, "customToolCalls");
  };
  if (!isPlainObject(call)) fail("expected an object");
  const tc = call as Record<string, unknown>;
  if (tc.namespace !== undefined && (typeof tc.namespace !== "string" || tc.namespace === "")) {
    fail('"namespace" must be a non-empty string when present');
  }
  if (typeof tc.name !== "string" || tc.name === "") {
    fail('custom tool call requires a non-empty string "name" field');
  }
  if (typeof tc.input !== "string") fail('"input" must be a string for a custom tool call');
  if (tc.arguments !== undefined) fail('custom tool call takes "input", not "arguments"');
  if (tc.id !== undefined && typeof tc.id !== "string") {
    fail('custom tool call "id" must be a string when present');
  }
}

/**
 * Validate a response's `customToolCalls` (OpenAI Responses only) before it is
 * served. Throws {@link InvalidFixtureToolCallError} on the first malformed
 * entry. The key is new, so no fixture of an earlier release reaches this.
 */
export function assertCustomToolCalls(response: object): void {
  const list = (response as { customToolCalls?: unknown }).customToolCalls;
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    throw new InvalidFixtureToolCallError(0, "customToolCalls must be an array", "customToolCalls");
  }
  list.forEach((call, i) => assertCustomToolCall(call, i));
}

/**
 * Validate the custom calls among the tool calls the OpenAI Responses API is
 * about to serve (see {@link servedToolCalls}). Function calls are not
 * checked here: they keep the handling of earlier releases (a non-string
 * `arguments` fails with the uncoded error of the Responses builders).
 */
export function assertResponsesToolCalls(calls: readonly FixtureToolCall[]): void {
  let customIndex = 0;
  for (const tc of calls) {
    if (isPlainObject(tc) && tc.type === "custom") assertCustomToolCall(tc, customIndex++);
  }
}

/**
 * A fixture's `toolCalls` for a wire that cannot carry custom tool calls.
 * Every entry is a function call and passes through unchanged, exactly as in
 * earlier releases (the builders read its `name`, `arguments` and `id`; its
 * Responses-only `namespace` is not emitted). Custom calls live in
 * `customToolCalls`, which {@link rejectResponsesOnlyToolCalls} rejects.
 */
export function requireFunctionToolCalls(calls: ToolCall[]): ToolCall[] {
  return calls;
}

/**
 * Reject the Responses-only custom tool calls on a wire that cannot carry
 * them: a non-empty `customToolCalls`, or a `customToolCall` block in
 * `responsesBlocks`. Throws {@link UnsupportedToolCallError} naming `wire`.
 * Both keys are new, so no fixture of an earlier release reaches this error.
 */
export function rejectResponsesOnlyToolCalls(response: object, wire: string): void {
  const r = response as { customToolCalls?: unknown; responsesBlocks?: unknown };
  if (Array.isArray(r.customToolCalls) && r.customToolCalls.length > 0) {
    const first: unknown = r.customToolCalls[0];
    const name = isPlainObject(first) && typeof first.name === "string" ? first.name : "";
    throw new UnsupportedToolCallError(name, wire);
  }
  if (Array.isArray(r.responsesBlocks)) {
    for (const block of r.responsesBlocks as unknown[]) {
      if (isPlainObject(block) && block.type === "customToolCall") {
        throw new UnsupportedToolCallError(typeof block.name === "string" ? block.name : "", wire);
      }
    }
  }
}

/**
 * {@link rejectResponsesOnlyToolCalls}, then {@link requireFunctionToolCalls}
 * on the response's `toolCalls` (ignoring any `blocks`).
 */
export function requireServedFunctionToolCalls(
  response: { toolCalls?: ToolCall[] },
  wire: string,
): ToolCall[] {
  rejectResponsesOnlyToolCalls(response, wire);
  return requireFunctionToolCalls(response.toolCalls ?? []);
}

/**
 * The function calls a non-Responses wire emits for this response, after
 * {@link rejectResponsesOnlyToolCalls}. Non-empty ordered `blocks` are
 * authoritative: the builders stream them (and validate them through
 * {@link resolveFixtureBlocks}) and never emit the legacy `toolCalls`, so the
 * result is empty. Without blocks, `toolCalls` is checked by
 * {@link requireFunctionToolCalls}.
 */
export function requireEmittedFunctionToolCalls(
  response: { toolCalls?: ToolCall[]; blocks?: FixtureFileBlock[] },
  wire: string,
): ToolCall[] {
  rejectResponsesOnlyToolCalls(response, wire);
  if (Array.isArray(response.blocks) && response.blocks.length > 0) return [];
  return requireFunctionToolCalls(response.toolCalls ?? []);
}

/** A fixture tool-call error that a handler surfaces as a coded 500. */
export type FixtureToolCallError =
  | InvalidToolArgumentsError
  | UnsupportedToolCallError
  | InvalidFixtureToolCallError;

/** True for the fixture tool-call errors a handler surfaces as a coded 500. */
export function isFixtureToolCallError(error: unknown): error is FixtureToolCallError {
  return (
    error instanceof InvalidToolArgumentsError ||
    error instanceof UnsupportedToolCallError ||
    error instanceof InvalidFixtureToolCallError
  );
}

/** The aimock error code carried in every provider envelope for a fixture tool-call error. */
export function fixtureToolCallErrorCode(
  error: FixtureToolCallError,
):
  | "aimock_unsupported_tool_call"
  | "aimock_invalid_tool_arguments"
  | "aimock_invalid_fixture_tool_call" {
  if (error instanceof UnsupportedToolCallError) return "aimock_unsupported_tool_call";
  if (error instanceof InvalidFixtureToolCallError) return error.code;
  return "aimock_invalid_tool_arguments";
}

/**
 * Google RPC error `details` carrying an aimock fixture tool-call code, for the
 * Gemini, Vertex AI and Gemini Live envelopes (`google.rpc.ErrorInfo`: an
 * UPPER_SNAKE `reason`, a `domain`, and string `metadata`).
 */
export function googleFixtureToolCallErrorDetails(code: string) {
  return [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: code.toUpperCase(),
      domain: "aimock",
      metadata: { code },
    },
  ];
}

/**
 * Run a WebSocket preflight `check` that may raise a fixture tool-call error
 * ({@link InvalidToolArgumentsError}, {@link UnsupportedToolCallError} or
 * {@link InvalidFixtureToolCallError}).
 * Such an error marks the already-journaled entry as a 500 carrying the
 * message, then propagates to the transport's error handler.
 */
export function journalFixtureToolCallError<T>(journalEntry: JournalEntry, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (isFixtureToolCallError(error)) {
      journalEntry.response.status = 500;
      journalEntry.response.error = error.message;
    }
    throw error;
  }
}

/**
 * Resolve effective strict mode from per-request header and server default.
 * Header values override the server default — same precedence pattern as chaos
 * config headers (see resolveChaosConfig in chaos.ts).
 *
 * Header: `X-AIMock-Strict` — "true"/"1" → strict on, "false"/"0" → strict off
 * (case-insensitive, surrounding whitespace trimmed).
 * When absent or unrecognised, falls back to the server-level default.
 */
export function resolveStrictMode(
  serverDefault: boolean | undefined,
  rawHeaders?: IncomingHttpHeaders,
): boolean {
  if (rawHeaders) {
    const header = rawHeaders["x-aimock-strict"];
    const rawVal =
      typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
    if (typeof rawVal === "string") {
      const val = rawVal.trim().toLowerCase();
      if (val === "true" || val === "1") return true;
      if (val === "false" || val === "0") return false;
    }
  }
  return serverDefault ?? false;
}

const STRICT_INTEGER_RE = /^\d+$/;

/**
 * Strict decimal-integer grammar shared by the query/list parsers that grew
 * their own local copy on separate branches (files `limit`, fine-tuning
 * `limit`, chaos integer fields): an unsigned digit run and nothing else — no
 * sign, no exponent, no radix prefix, no surrounding whitespace (callers that
 * accept padded input trim before calling).
 *
 * Deliberately narrower than `Number()`, which reads `0x10` as 16, `1e3` as
 * 1000 and strips whitespace and a leading `+`. Returns the value, or `null`
 * when the text is not a safe integer literal. Range checks and error
 * messages stay with the callers — this is the grammar gate only, so sharing
 * it cannot change any surface's accepted range or its 400 text.
 */
export function parseStrictIntegerText(text: string): number | null {
  if (!STRICT_INTEGER_RE.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Would a fixture miss on this request have been forwarded upstream? This is
 * the ONE rule behind the no-fixture chaos journal `source` label: "proxy"
 * only when record mode has an upstream for THIS provider and strict mode is
 * not refusing the miss first. `effectiveStrict` is the header-resolved value
 * from {@link resolveStrictMode}. `record.providers` is read guarded — a JS
 * caller can hand over `record: {}`.
 */
export function wouldProxyMiss(
  effectiveStrict: boolean,
  record: RecordConfig | undefined,
  providerKey: RecordProviderKey | undefined,
): boolean {
  if (effectiveStrict || providerKey === undefined) return false;
  return Boolean(record?.providers?.[providerKey]);
}

/**
 * Returns `true` or `false` when the X-AIMock-Strict header overrides the
 * server default, or `undefined` when it doesn't. Designed to be spread
 * directly into a journal entry's `response` object:
 *
 *   response: { status, fixture, ...strictOverrideField(defaults.strict, req.headers) }
 */
export function strictOverrideField(
  serverDefault: boolean | undefined,
  rawHeaders?: IncomingHttpHeaders,
): { strictOverride?: boolean } {
  const effective = resolveStrictMode(serverDefault, rawHeaders);
  if (effective !== (serverDefault ?? false)) {
    return { strictOverride: effective };
  }
  return {};
}

/**
 * Build the strict-mode 503 error message, distinguishing a true no-match from
 * a sequence/turn-exhausted miss.
 *
 * `skippedBySequenceOrTurn` is the count reported by `matchFixtureDiagnostic`
 * (router.ts): the number of fixtures that matched the request SHAPE but were
 * rejected ONLY by their `sequenceIndex`/`turnIndex` count state.
 *
 *   - `0`  → `"Strict mode: no fixture matched"` (no candidate had a matching shape)
 *   - `>0` → `"Strict mode: N candidate fixture(s) skipped by sequence/turn state"`
 *
 * The HTTP status (503) and error envelope shape are unchanged at every call
 * site — only this message string differs. Endpoints with no sequence/turn
 * gates always pass `0` and therefore see the generic message.
 */
export function strictNoMatchMessage(skippedBySequenceOrTurn: number): string {
  if (skippedBySequenceOrTurn > 0) {
    return `Strict mode: ${skippedBySequenceOrTurn} candidate fixture(s) skipped by sequence/turn state`;
  }
  return "Strict mode: no fixture matched";
}

/**
 * Build the strict-mode error LOG line, mirroring {@link strictNoMatchMessage}'s
 * disambiguation so the error log distinguishes the two miss kinds too.
 */
export function strictNoMatchLogLine(
  method: string,
  url: string,
  skippedBySequenceOrTurn: number,
): string {
  if (skippedBySequenceOrTurn > 0) {
    return `STRICT: ${skippedBySequenceOrTurn} candidate fixture(s) skipped by sequence/turn state for ${method} ${url}`;
  }
  return `STRICT: No fixture matched for ${method} ${url}`;
}

/**
 * Resolve the reasoning string to actually emit for a given model.
 *
 * aimock synthesizes a reasoning channel whenever a fixture carries a
 * `reasoning` string, regardless of the requested model. But a non-reasoning
 * model (e.g. `gpt-4.1`) would emit no reasoning against the real provider, so
 * replaying it is a false green (see aimock#254). This gates the emission on
 * the requested model's capability:
 *
 *   - no fixture reasoning            → undefined (no-op, short-circuit)
 *   - reasoning-capable model         → emit unchanged, no log
 *   - non-reasoning model, strict OFF → `logger.warn`, still emit (preserves
 *                                       current behavior)
 *   - non-reasoning model, strict ON  → `logger.error`, suppress (return undefined)
 *
 * Capability is decided from the REQUESTED model id (what the backend was wired
 * to), not any `overrides.model` echoed in the payload.
 */
export function resolveReasoningForModel(
  reasoning: string | undefined,
  model: string | undefined,
  strict: boolean,
  logger: Logger,
): string | undefined {
  if (!reasoning) return undefined;
  if (isReasoningModel(model)) return reasoning;
  if (strict) {
    logger.error(
      `Strict mode: fixture has a reasoning channel but model "${model}" is not reasoning-capable — suppressing reasoning emission`,
    );
    return undefined;
  }
  logger.warn(
    `Fixture has a reasoning channel but model "${model}" is not reasoning-capable — the real provider would emit no reasoning. Emitting anyway (set X-AIMock-Strict: true to suppress).`,
  );
  return reasoning;
}

/**
 * Resolve the encrypted reasoning artifacts (`reasoningSignature` and
 * `redactedThinking`) to actually emit for a given model.
 *
 * `redacted_thinking` blocks and a thinking `signature` ARE part of the
 * reasoning channel — they are just the encrypted form of it — so they must be
 * gated on the same model-capability resolution as the plaintext `reasoning`
 * string (see resolveReasoningForModel). Gating only the plaintext channel
 * leaves a half-gated reasoning path: replaying a fixture recorded from a
 * reasoning model against a non-reasoning model would strip the `thinking`
 * block but still emit `redacted_thinking` blocks, which the real provider for
 * that model would never produce.
 *
 * Capability is decided from the REQUESTED model id, independently of whether a
 * plaintext `reasoning` string is present — a fixture may carry only
 * `redactedThinking` with no plaintext reasoning.
 *
 *   - reasoning-capable model         → emit both unchanged, no log
 *   - non-reasoning model, no artifacts → no-op, nothing to suppress
 *   - non-reasoning model, strict OFF → `logger.warn`, still emit (preserves
 *                                       current behavior)
 *   - non-reasoning model, strict ON  → `logger.error`, suppress both
 *
 * Must be invoked alongside resolveReasoningForModel with identical model/strict
 * inputs so the plaintext and encrypted channels stay suppressed together.
 */
export function resolveReasoningArtifactsForModel(
  reasoningSignature: string | undefined,
  redactedThinking: string[] | undefined,
  model: string | undefined,
  strict: boolean,
  logger: Logger,
): { reasoningSignature?: string; redactedThinking?: string[] } {
  const hasArtifacts = reasoningSignature !== undefined || (redactedThinking?.length ?? 0) > 0;
  if (!hasArtifacts || isReasoningModel(model)) {
    return { reasoningSignature, redactedThinking };
  }
  if (strict) {
    logger.error(
      `Strict mode: fixture has encrypted reasoning artifacts (redacted_thinking/signature) but model "${model}" is not reasoning-capable — suppressing reasoning emission`,
    );
    return {};
  }
  logger.warn(
    `Fixture has encrypted reasoning artifacts (redacted_thinking/signature) but model "${model}" is not reasoning-capable — the real provider would emit no reasoning. Emitting anyway (set X-AIMock-Strict: true to suppress).`,
  );
  return { reasoningSignature, redactedThinking };
}

export function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (isRecognizedApiKeyHeader(key)) {
      flat[key] = "[REDACTED]";
    } else {
      flat[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return flat;
}

/** Structural discriminator; registration performs full transcript validation. */
export function isLiveResponse(value: unknown): value is LiveFixtureResponse {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "live" in value;
}

export function isResponseFactory(r: FixtureResponse | ResponseFactory): r is ResponseFactory {
  return typeof r === "function";
}

export async function resolveResponse(
  fixture: Fixture,
  request: ChatCompletionRequest,
): Promise<FixtureResponse> {
  if (typeof fixture.response === "function") {
    let normalized: FixtureResponse;
    try {
      const raw = await fixture.response(request);
      normalized = normalizeFactoryResponse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Response factory threw: ${msg}`, { cause: err });
    }
    return sanitizeFixtureResponse(normalized);
  }
  return sanitizeFixtureResponse(fixture.response);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A non-empty string, the only valid value of a tool call's `namespace`. */
function isValidNamespace(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Drop the keys a served `toolCalls` entry or `toolCall` block ignores, so
 * no handler reads them: on a `toolCalls` entry, `type` and `input` (a
 * `toolCalls` entry is always a function call; custom calls live in
 * `customToolCalls`) and an invalid `namespace` (not a non-empty string); on a
 * `toolCall` block, `input` and an invalid `namespace`. Earlier releases
 * ignored all of these, so fixtures that carry them serve exactly as before.
 * Returns the same object when nothing needs dropping. `customToolCalls` and
 * `responsesBlocks` are new keys and are validated, not sanitized.
 */
export function sanitizeFixtureResponse(response: FixtureResponse): FixtureResponse {
  if (!isPlainObject(response)) return response;
  const r = response as Record<string, unknown>;
  const dropKeys = (entry: unknown, keys: readonly string[]): unknown => {
    if (!isPlainObject(entry)) return entry;
    const drop = keys.filter(
      (key) => key in entry && (key !== "namespace" || !isValidNamespace(entry.namespace)),
    );
    if (drop.length === 0) return entry;
    const copy: Record<string, unknown> = { ...entry };
    for (const key of drop) delete copy[key];
    return copy;
  };
  const sanitizeList = (list: unknown, pick: (entry: unknown) => unknown): unknown => {
    if (!Array.isArray(list)) return list;
    const next = list.map(pick);
    return next.some((entry, k) => entry !== list[k]) ? next : list;
  };
  const toolCalls = sanitizeList(r.toolCalls, (entry) =>
    dropKeys(entry, ["type", "input", "namespace"]),
  );
  let blocks = sanitizeList(r.blocks, (entry) =>
    isPlainObject(entry) && entry.type === "toolCall"
      ? dropKeys(entry, ["input", "namespace"])
      : entry,
  );
  // A custom-free `responsesBlocks` with no `blocks` beside it is served as
  // `blocks` by the wires that do not read `responsesBlocks`. (The OpenAI
  // Responses API still prefers `responsesBlocks`; a fixture with a custom
  // call in it is rejected off that API.)
  if (
    !(Array.isArray(r.blocks) && r.blocks.length > 0) &&
    Array.isArray(r.responsesBlocks) &&
    r.responsesBlocks.length > 0 &&
    !r.responsesBlocks.some((entry) => isPlainObject(entry) && entry.type === "customToolCall")
  ) {
    blocks = r.responsesBlocks;
  }
  if (toolCalls === r.toolCalls && blocks === r.blocks) return response;
  const copy: Record<string, unknown> = { ...r };
  if (toolCalls !== r.toolCalls) copy.toolCalls = toolCalls;
  if (blocks !== r.blocks) copy.blocks = blocks;
  return copy as unknown as FixtureResponse;
}

/**
 * Drop `namespace` from every `toolCalls` entry and `toolCall` block, for
 * OpenAI Responses requests served without `responsesTools: "extended"`:
 * earlier releases never emitted it. `customToolCalls` and `responsesBlocks`
 * keep theirs (new keys are honored in every mode). Returns the same object
 * when no namespace is set.
 */
export function withoutLegacyNamespaces<T extends FixtureResponse>(response: T): T {
  if (!isPlainObject(response)) return response;
  const r = response as Record<string, unknown>;
  const strip = (list: unknown, isTarget: (entry: Record<string, unknown>) => boolean) => {
    if (!Array.isArray(list)) return list;
    if (!list.some((entry) => isPlainObject(entry) && isTarget(entry) && "namespace" in entry)) {
      return list;
    }
    return list.map((entry) => {
      if (!isPlainObject(entry) || !isTarget(entry) || !("namespace" in entry)) return entry;
      const copy: Record<string, unknown> = { ...entry };
      delete copy.namespace;
      return copy;
    });
  };
  const toolCalls = strip(r.toolCalls, () => true);
  const blocks = strip(r.blocks, (entry) => entry.type === "toolCall");
  if (toolCalls === r.toolCalls && blocks === r.blocks) return response;
  const copy: Record<string, unknown> = { ...r };
  if (toolCalls !== r.toolCalls) copy.toolCalls = toolCalls;
  if (blocks !== r.blocks) copy.blocks = blocks;
  return copy as unknown as T;
}

function normalizeFactoryResponse(raw: FixtureResponse): FixtureResponse {
  const r = { ...raw } as Record<string, unknown>;
  if (typeof r.content === "object" && r.content !== null) {
    r.content = JSON.stringify(r.content);
  }
  if (Array.isArray(r.toolCalls)) {
    r.toolCalls = (r.toolCalls as Array<Record<string, unknown>>).map((tc) => {
      if (typeof tc.arguments === "object" && tc.arguments !== null) {
        return { ...tc, arguments: JSON.stringify(tc.arguments) };
      }
      return { ...tc };
    });
  }
  // Mirror the toolCalls[].arguments idiom for the optional ordered `blocks`
  // array: auto-stringify object `arguments` on each `toolCall` block so a
  // programmatic ResponseFactory may return objects (resolveFixtureBlocks
  // requires string `arguments`). Text blocks and string arguments pass
  // through unchanged. Matches the loader's block handling.
  if (Array.isArray(r.blocks)) {
    r.blocks = (r.blocks as Array<Record<string, unknown>>).map((block) => {
      if (
        block != null &&
        block.type === "toolCall" &&
        typeof block.arguments === "object" &&
        block.arguments !== null
      ) {
        return { ...block, arguments: JSON.stringify(block.arguments) };
      }
      return { ...block };
    });
  }
  // `responsesBlocks` (new): the same idiom, but a non-object entry stays as it
  // is for resolveResponsesBlocks to reject. A custom call's `input` (in
  // `customToolCalls` or a `customToolCall` block) is free text and is never
  // stringified.
  if (Array.isArray(r.responsesBlocks)) {
    r.responsesBlocks = (r.responsesBlocks as unknown[]).map((block) =>
      isPlainObject(block) &&
      block.type === "toolCall" &&
      typeof block.arguments === "object" &&
      block.arguments !== null
        ? { ...block, arguments: JSON.stringify(block.arguments) }
        : block,
    );
  }
  return r as unknown as FixtureResponse;
}

export function generateId(prefix = "chatcmpl"): string {
  return `${prefix}-${randomBytes(12).toString("base64url")}`;
}

/**
 * Resolve the request id for this HTTP request.
 *
 * - When the caller sends a well-formed `X-Request-Id` (1-128 chars of
 *   `A-Za-z0-9-_.:`), it is echoed verbatim so distributed traces correlate.
 * - Otherwise (absent, empty, too long, or illegal characters) a fresh
 *   `req-…` id is generated — never trust an attacker-controlled correlation
 *   value to be a valid log key.
 *
 * Returns `{ id, generated }`. The server normalizes
 * `req.headers["x-request-id"]` to the resolved value, so every downstream
 * `flattenHeaders` journal snapshot carries it with zero per-handler edits —
 * which also means a MINTED id would otherwise ride the egress header set to
 * a real provider. The server therefore passes `generated` to
 * `markMintedRequestId` so `buildForwardHeaders` can drop it; a caller's own
 * id still forwards verbatim.
 */
export function resolveRequestId(rawHeaders: http.IncomingHttpHeaders): {
  id: string;
  generated: boolean;
} {
  const raw = rawHeaders["x-request-id"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first === "string") {
    const trimmed = first.trim();
    if (trimmed.length >= 1 && trimmed.length <= 128 && /^[A-Za-z0-9\-_.:]+$/.test(trimmed)) {
      return { id: trimmed, generated: false };
    }
  }
  return { id: generateId("req"), generated: true };
}

/**
 * Requests whose `x-request-id` aimock MINTED (the caller sent none, or sent
 * an unusable one). The normalized header is indistinguishable from a
 * caller-supplied one by inspection, so the provenance is tracked out-of-band
 * and keyed on the request object, exactly like the egress auth marker.
 */
const mintedRequestIds = new WeakSet<http.IncomingMessage>();

/** @internal Record that this request's `x-request-id` is aimock's own. */
export function markMintedRequestId(req: http.IncomingMessage, generated: boolean): void {
  if (generated) mintedRequestIds.add(req);
}

/**
 * @internal True when `x-request-id` on this request was minted by aimock.
 * Egress paths use it to avoid transmitting an invented correlation id to a
 * real provider.
 */
export function hasMintedRequestId(req: http.IncomingMessage): boolean {
  return mintedRequestIds.has(req);
}

export function generateToolCallId(): string {
  return `call_${randomBytes(12).toString("base64url")}`;
}

export function generateMessageId(): string {
  return `msg_${randomBytes(12).toString("base64url")}`;
}

export function generateToolUseId(): string {
  return `toolu_${randomBytes(12).toString("base64url")}`;
}

export function isTextResponse(r: FixtureResponse): r is TextResponse {
  return "content" in r && typeof (r as TextResponse).content === "string" && !("toolCalls" in r);
}

export function isToolCallResponse(r: FixtureResponse): r is ToolCallResponse {
  return (
    "toolCalls" in r &&
    Array.isArray((r as ToolCallResponse).toolCalls) &&
    !("content" in r && typeof (r as unknown as Record<string, unknown>).content === "string")
  );
}

export function isContentWithToolCallsResponse(
  r: FixtureResponse,
): r is ContentWithToolCallsResponse {
  const o = r as ContentWithToolCallsResponse;
  // LEGACY / COMBINED shape — BOTH content (string) + toolCalls (array). This
  // clause is byte-identical to the original guard, so every fixture that
  // matched before still matches here and is classified exactly as before.
  const hasContentAndToolCalls =
    "content" in r &&
    typeof o.content === "string" &&
    "toolCalls" in r &&
    Array.isArray(o.toolCalls);
  // BLOCKS-ONLY shape (additive, #274 F0) — a non-empty `blocks` array with no
  // content/toolCalls. This is a pure RELAXATION: it recognizes MORE, never
  // reclassifies an existing fixture. A blocks-only fixture cannot be claimed by
  // any earlier/looser guard in the dispatch order — `isTextResponse` requires a
  // string `content` AND `!("toolCalls" in r)`, and `isToolCallResponse`
  // requires a `toolCalls` array — so it would otherwise fall through to 500.
  // `isAudioResponse` (checked first everywhere) requires an `audio` field, which
  // blocks-only lacks, so there is no overlap there either.
  const hasNonEmptyBlocks = Array.isArray(o.blocks) && o.blocks.length > 0;
  // RESPONSES-BLOCKS shape (new key): a non-empty `responsesBlocks` array. The
  // OpenAI Responses API serves it; other wires serve a custom-free one as
  // `blocks` (see sanitizeFixtureResponse) and reject a custom call in it.
  const hasNonEmptyResponsesBlocks =
    Array.isArray(o.responsesBlocks) && o.responsesBlocks.length > 0;
  return hasContentAndToolCalls || hasNonEmptyBlocks || hasNonEmptyResponsesBlocks;
}

/**
 * Validate and pass through the ordered `blocks` field of a combined
 * content+toolCalls fixture. Used ONLY on the new block-iteration path (when a
 * fixture explicitly sets `blocks`); it is NOT a legacy-order reconstructor —
 * fixtures without `blocks` never reach this function and keep their unchanged
 * text-first path.
 *
 * An EMPTY `blocks` array is treated as "no blocks" by every builder's
 * streaming gate (`blocks && blocks.length > 0`), so it falls back to the
 * legacy `{content, toolCalls}` path and never reaches this function — the gate
 * is the single source of truth for "has blocks". This validator therefore only
 * ever runs on a non-empty array.
 *
 * Accepts the relaxed on-disk {@link FixtureFileBlock} input shape — a
 * `toolCall` block's `arguments` may be a string OR a JSON object/array — which
 * makes the object-tolerance below type-visible and mirrors how
 * normalizeResponse types its file-form input (see {@link FixtureFileBlock} /
 * {@link FixtureFileContentWithToolCallsResponse}). The in-memory
 * {@link FixtureBlock} form (string `arguments`) is a structural subtype, so
 * existing callers that pass `FixtureBlock[]` continue to type-check.
 *
 * Returns the blocks in array order, NORMALIZED to {@link FixtureBlock}: a
 * `text` block with a string `text`, or a `toolCall` block with string `name` +
 * string `arguments` (object/array `arguments` is JSON.stringified) and an
 * optional string `id`. The return type guarantees `arguments: string` — every
 * caller relies on that. Throws on a malformed array or entry — same fail-fast
 * idiom as the other fixture validators in this module (see e.g. the factory
 * guard at {@link resolveResponse}). A `customToolCall` block is not a
 * `blocks` entry (it belongs in `responsesBlocks`, see
 * {@link resolveResponsesBlocks}) and fails as an unknown type.
 */
export function resolveFixtureBlocks(blocks: FixtureFileBlock[]): FixtureBlock[] {
  if (!Array.isArray(blocks)) {
    throw new Error(`Invalid fixture blocks: expected an array, got ${typeof blocks}`);
  }
  // Validate each block and return a normalized COPY. Builders iterate the
  // result and must not observe later mutations of — nor be able to mutate —
  // the caller's stored fixture array, and block objects are consumed read-only
  // downstream, so we never mutate the input in place: any normalization (e.g.
  // stringifying object `arguments`) is applied to a fresh per-block copy.
  return blocks.map((block, i) => {
    if (block === null || typeof block !== "object") {
      throw new Error(`Invalid fixture block at index ${i}: expected an object`);
    }
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      if (typeof b.text !== "string") {
        throw new Error(
          `Invalid fixture block at index ${i}: "text" block requires a string "text" field`,
        );
      }
      return { type: "text", text: b.text };
    } else if (b.type === "toolCall") {
      if (typeof b.name !== "string") {
        throw new Error(
          `Invalid fixture block at index ${i}: "toolCall" block requires a string "name" field`,
        );
      }
      if (b.id !== undefined && typeof b.id !== "string") {
        throw new Error(
          `Invalid fixture block at index ${i}: "toolCall" block "id" must be a string when present`,
        );
      }
      // `arguments` is a JSON string in normalized (file-load) form. The
      // programmatic path (addFixture/addFixtures/prependFixture) stores RAW
      // fixtures with no normalizeResponse pass, so an OBJECT `arguments` can
      // reach here. Be tolerant: stringify an object/array (mirroring
      // normalizeResponse's `JSON.stringify`) into a fresh block copy so the
      // programmatic path is safe and the caller's stored fixture is untouched.
      // A string stays byte-identical (file-load path unchanged); any other
      // type is still rejected.
      if (typeof b.arguments === "object" && b.arguments !== null) {
        return { ...b, arguments: JSON.stringify(b.arguments) } as unknown as FixtureBlock;
      }
      if (typeof b.arguments !== "string") {
        throw new Error(
          `Invalid fixture block at index ${i}: "toolCall" block requires a string or object "arguments" field`,
        );
      }
      return { ...b, type: "toolCall", name: b.name, arguments: b.arguments } as FixtureBlock;
    } else {
      throw new Error(
        `Invalid fixture block at index ${i}: unknown type ${JSON.stringify(b.type)} (expected "text" or "toolCall")`,
      );
    }
  });
}

/** A normalized block on a wire that cannot carry custom tool calls. */
export type FunctionFixtureBlock = FixtureBlock;

/**
 * Validate and normalize a fixture's `responsesBlocks` (OpenAI Responses
 * only). Same rules and normalized copy as {@link resolveFixtureBlocks}, plus:
 * a `customToolCall` block with a non-empty string `name`, a string `input`
 * (never parsed or stringified), no `arguments` and an optional string `id`;
 * on either tool block, `namespace` must be a non-empty string when present,
 * and a `toolCall` block carries no `input`. The key is new, so a malformed
 * tool block throws the coded {@link InvalidFixtureToolCallError}; a malformed
 * text block or an unknown type throws a plain Error.
 */
export function resolveResponsesBlocks(
  blocks: readonly (FixtureFileResponsesBlock | ResponsesFixtureBlock)[],
): ResponsesFixtureBlock[] {
  if (!Array.isArray(blocks)) {
    throw new Error(`Invalid fixture responsesBlocks: expected an array, got ${typeof blocks}`);
  }
  return blocks.map((block, i): ResponsesFixtureBlock => {
    if (!isPlainObject(block)) {
      throw new Error(`Invalid fixture block at index ${i}: expected an object`);
    }
    const b = block as Record<string, unknown>;
    const failToolCall = (problem: string): never => {
      throw new InvalidFixtureToolCallError(i, problem, "blocks");
    };
    if (
      (b.type === "toolCall" || b.type === "customToolCall") &&
      b.namespace !== undefined &&
      (typeof b.namespace !== "string" || b.namespace === "")
    ) {
      failToolCall('"namespace" must be a non-empty string when present');
    }
    const namespace = typeof b.namespace === "string" ? { namespace: b.namespace } : {};
    const id = typeof b.id === "string" ? { id: b.id } : {};
    if (b.type === "text") {
      if (typeof b.text !== "string") {
        throw new Error(
          `Invalid fixture block at index ${i}: "text" block requires a string "text" field`,
        );
      }
      return { type: "text", text: b.text };
    }
    if (b.type === "toolCall") {
      if (b.input !== undefined) failToolCall('"input" is only valid on a "customToolCall" block');
      if (typeof b.name !== "string")
        failToolCall('"toolCall" block requires a string "name" field');
      if (b.id !== undefined && typeof b.id !== "string") {
        failToolCall('"toolCall" block "id" must be a string when present');
      }
      const args =
        typeof b.arguments === "object" && b.arguments !== null
          ? JSON.stringify(b.arguments)
          : b.arguments;
      if (typeof args !== "string") {
        failToolCall('"toolCall" block requires a string or object "arguments" field');
      }
      return {
        type: "toolCall",
        name: b.name as string,
        arguments: args as string,
        ...id,
        ...namespace,
      };
    }
    if (b.type === "customToolCall") {
      if (typeof b.name !== "string" || b.name === "") {
        failToolCall('"customToolCall" block requires a non-empty string "name" field');
      }
      if (typeof b.input !== "string") {
        failToolCall('"customToolCall" block requires a string "input" field');
      }
      if (b.arguments !== undefined) {
        failToolCall('"customToolCall" block takes "input", not "arguments"');
      }
      if (b.id !== undefined && typeof b.id !== "string") {
        failToolCall('"customToolCall" block "id" must be a string when present');
      }
      return {
        type: "customToolCall",
        name: b.name as string,
        input: b.input as string,
        ...id,
        ...namespace,
      };
    }
    throw new Error(
      `Invalid fixture block at index ${i}: unknown type ${JSON.stringify(b.type)} (expected "text", "toolCall" or "customToolCall")`,
    );
  });
}

/** Allocate the exact OpenAI call identities once for both wire output and observations. */
export function prepareOpenAIChatMisbehavior(plan: MisbehaviorPlan): MisbehaviorPlan {
  const response = plan.response;
  const combined = isContentWithToolCallsResponse(response);
  // Custom tool calls reach here only on the OpenAI Responses API; the planner
  // skips every other wire's custom-call fixture so its guard rejects it.
  const outcome = combined ? resolveServedBlockOutcome(response) : undefined;
  const calls =
    outcome?.toolCalls ??
    (combined || isToolCallResponse(response) ? servedToolCalls(response) : []);
  const duplicate = plan.duplicateId;
  const toolCalls = calls.map((call, index) => ({
    ...call,
    ...(index === duplicate?.destinationIndex ? {} : { id: call.id || generateToolCallId() }),
  }));
  if (duplicate) {
    toolCalls[duplicate.destinationIndex].id = toolCalls[duplicate.sourceIndex].id;
  }
  let preparedResponse = { ...response };
  if ("usage" in preparedResponse) delete preparedResponse.usage;
  if (plan.stop === "length") preparedResponse = { ...preparedResponse, finishReason: "length" };
  if (outcome) {
    preparedResponse = withServedToolCalls(
      { ...preparedResponse, content: outcome.content },
      toolCalls,
      rebuildOrderedBlocks(outcome.ordered, toolCalls),
    );
  } else if (combined || isToolCallResponse(response)) {
    preparedResponse = withServedToolCalls(preparedResponse, toolCalls);
  }
  return {
    ...plan,
    response: preparedResponse,
    summary: {
      ...plan.summary,
      servedToolCalls: toolCalls.map(servedMisbehaviorToolCall),
    },
  };
}

/**
 * The journaled form of a served misbehavior tool call: `{ name, arguments,
 * id }`. A Responses custom tool call adds `type: "custom"` and carries its
 * free-text `input` in `arguments`; `namespace` is recorded only when set.
 */
export function servedMisbehaviorToolCall(call: FixtureToolCall): ServedMisbehaviorToolCall {
  const namespace = call.namespace !== undefined ? { namespace: call.namespace } : {};
  return call.type === "custom"
    ? { type: "custom", name: call.name, arguments: call.input, id: call.id, ...namespace }
    : { name: call.name, arguments: call.arguments, id: call.id, ...namespace };
}

/** The text a tool call contributes to an estimated completion: name plus arguments or input. */
export function toolCallUsageText(call: FixtureToolCall): string {
  return call.name + (call.type === "custom" ? call.input : call.arguments);
}

/** Estimate once from the full applied output, before any delivery interruption. */
export function resolveOpenAIChatMisbehaviorUsage(
  plan: MisbehaviorPlan,
  request: ChatCompletionRequest,
  exposeReasoning = true,
): ReturnType<typeof resolveUsage> {
  const response = plan.response;
  const combined = isContentWithToolCallsResponse(response);
  const outcome = combined ? resolveServedBlockOutcome(response) : undefined;
  const calls =
    outcome?.toolCalls ??
    (combined || isToolCallResponse(response) ? servedToolCalls(response) : []);
  const content =
    outcome?.content ??
    ("content" in response && typeof response.content === "string" ? response.content : "");
  const reasoning =
    plan.reasoning ??
    ("reasoning" in response && typeof response.reasoning === "string" ? response.reasoning : "");
  const promptText = request.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => part.text ?? "").join("")
          : "",
    )
    .join("");
  const completionText =
    content +
    calls.map(toolCallUsageText).join("") +
    (plan.refusal ?? "") +
    (exposeReasoning ? reasoning : "");
  return resolveUsage(undefined, promptText, completionText);
}

/** Project normalized ordered blocks without changing the fixture or generating ids. */
export function resolveFixtureBlockOutcome(blocks: FixtureFileBlock[]) {
  const ordered = resolveFixtureBlocks(blocks);
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const block of ordered) {
    if (block.type === "text") content += block.text;
    else
      toolCalls.push({
        name: block.name,
        arguments: block.arguments,
        ...(block.id !== undefined ? { id: block.id } : {}),
      });
  }
  return { ordered, content, toolCalls, hasToolCalls: toolCalls.length > 0 };
}

/**
 * Every tool call a response serves, in order: the function calls of
 * `toolCalls`, then the custom calls of `customToolCalls` (each tagged
 * `type: "custom"`). Only the OpenAI Responses API may serve the custom ones;
 * the other wires reject a non-empty `customToolCalls` first
 * ({@link rejectResponsesOnlyToolCalls}).
 */
export function servedToolCalls(response: {
  toolCalls?: ToolCall[];
  customToolCalls?: CustomToolCall[];
}): FixtureToolCall[] {
  const calls: FixtureToolCall[] = [...(response.toolCalls ?? [])];
  for (const call of Array.isArray(response.customToolCalls) ? response.customToolCalls : []) {
    calls.push(isPlainObject(call) ? { ...call, type: "custom" } : call);
  }
  return calls;
}

/**
 * Resolve the ordered blocks a response serves, with each tool block projected
 * to its {@link FixtureToolCall}: a non-empty `responsesBlocks` (OpenAI
 * Responses only, through {@link resolveResponsesBlocks}), else a non-empty
 * legacy `blocks` (through {@link resolveFixtureBlocks}, which rejects a
 * `customToolCall` block with the error of earlier releases). Undefined when
 * the response has neither.
 */
export function resolveServedBlockOutcome(response: object):
  | {
      ordered: ResponsesFixtureBlock[];
      content: string;
      toolCalls: FixtureToolCall[];
      hasToolCalls: boolean;
      source: "responsesBlocks" | "blocks";
    }
  | undefined {
  const r = response as {
    blocks?: FixtureFileBlock[];
    responsesBlocks?: FixtureFileResponsesBlock[];
  };
  let ordered: ResponsesFixtureBlock[];
  let source: "responsesBlocks" | "blocks";
  if (Array.isArray(r.responsesBlocks) && r.responsesBlocks.length > 0) {
    ordered = resolveResponsesBlocks(r.responsesBlocks);
    source = "responsesBlocks";
  } else if (Array.isArray(r.blocks) && r.blocks.length > 0) {
    ordered = resolveFixtureBlocks(r.blocks);
    source = "blocks";
  } else return undefined;
  let content = "";
  const toolCalls: FixtureToolCall[] = [];
  for (const block of ordered) {
    if (block.type === "text") content += block.text;
    else toolCalls.push(fixtureBlockToolCall(block));
  }
  return { ordered, content, toolCalls, hasToolCalls: toolCalls.length > 0, source };
}

/**
 * Write rewritten served tool calls (and, with `ordered`, rebuilt ordered
 * blocks) back into a copy of `response`, split by carrier: function calls go
 * to `toolCalls`, custom calls to `customToolCalls`, and the blocks to
 * `responsesBlocks` when the response served those, else to `blocks`.
 */
export function withServedToolCalls<T extends object>(
  response: T,
  toolCalls: readonly FixtureToolCall[],
  ordered?: ResponsesFixtureBlock[],
): T {
  const functionCalls: ToolCall[] = [];
  const customCalls: CustomToolCall[] = [];
  for (const call of toolCalls) {
    if (call.type === "custom") customCalls.push(call);
    else functionCalls.push(call);
  }
  const out: Record<string, unknown> = { ...response, toolCalls: functionCalls };
  if (customCalls.length > 0 || "customToolCalls" in response) out.customToolCalls = customCalls;
  if (ordered) {
    const r = response as { responsesBlocks?: unknown[] };
    if (Array.isArray(r.responsesBlocks) && r.responsesBlocks.length > 0) {
      out.responsesBlocks = ordered;
    } else {
      out.blocks = ordered;
    }
  }
  return out as T;
}

/** Project one normalized tool block to the matching served tool call. */
export function fixtureBlockToolCall(
  block: Exclude<ResponsesFixtureBlock, { type: "text" }>,
): FixtureToolCall {
  const id = block.id !== undefined ? { id: block.id } : {};
  const namespace = block.namespace !== undefined ? { namespace: block.namespace } : {};
  return block.type === "customToolCall"
    ? { type: "custom", name: block.name, input: block.input, ...id, ...namespace }
    : { name: block.name, arguments: block.arguments, ...id, ...namespace };
}

/** Project one served tool call back to its ordered tool block. */
export function toolCallFixtureBlock(
  call: FixtureToolCall,
): Exclude<ResponsesFixtureBlock, { type: "text" }> {
  const id = call.id !== undefined ? { id: call.id } : {};
  const namespace = call.namespace !== undefined ? { namespace: call.namespace } : {};
  return call.type === "custom"
    ? { type: "customToolCall", name: call.name, input: call.input, ...id, ...namespace }
    : { type: "toolCall", name: call.name, arguments: call.arguments, ...id, ...namespace };
}

/**
 * Rebuild ordered blocks after their tool calls were rewritten one-for-one:
 * text blocks are copied and the Nth tool block becomes `toolCalls[N]`.
 */
export function rebuildOrderedBlocks(
  ordered: readonly ResponsesFixtureBlock[],
  toolCalls: readonly FixtureToolCall[],
): ResponsesFixtureBlock[] {
  let callIndex = 0;
  return ordered.map((block) =>
    block.type === "text" ? { ...block } : toolCallFixtureBlock(toolCalls[callIndex++]),
  );
}

export function isErrorResponse(r: FixtureResponse): r is ErrorResponse {
  return (
    "error" in r &&
    (r as ErrorResponse).error !== null &&
    typeof (r as ErrorResponse).error === "object" &&
    "message" in ((r as ErrorResponse).error as Record<string, unknown>) &&
    typeof ((r as ErrorResponse).error as Record<string, unknown>).message === "string"
  );
}

/**
 * Serialize an ErrorResponse to JSON, stripping the internal-only `status`
 * field that controls the HTTP status code but should never appear in the
 * response body.  Real LLM APIs don't include it.
 */
export function serializeErrorResponse(response: ErrorResponse): string {
  return JSON.stringify({
    error: {
      message: response.error.message,
      type: response.error.type ?? "server_error",
      param: response.error.param ?? null,
      code: response.error.code ?? null,
    },
  });
}

export function isEmbeddingResponse(r: FixtureResponse): r is EmbeddingResponse {
  return "embedding" in r && Array.isArray((r as EmbeddingResponse).embedding);
}

export function isImageResponse(r: FixtureResponse): r is ImageResponse {
  return (
    ("image" in r && typeof r.image === "object" && r.image != null) ||
    ("images" in r && Array.isArray((r as ImageResponse).images))
  );
}

export function isAudioResponse(r: FixtureResponse): r is AudioResponse {
  if (!("audio" in r)) return false;
  const a = (r as AudioResponse).audio;
  return typeof a === "string" || (typeof a === "object" && a !== null && "b64Json" in a);
}

/**
 * Map audio format shorthand to MIME content types.
 * Shared between speech, ElevenLabs, and fal audio handlers.
 */
export const FORMAT_TO_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

/**
 * Resolve a format string (e.g. "mp3", "opus") to its MIME content type.
 * Falls back to "application/octet-stream" for unknown formats.
 */
export function formatToMime(format: string): string {
  return FORMAT_TO_CONTENT_TYPE[format] ?? "application/octet-stream";
}

export function isTranscriptionResponse(r: FixtureResponse): r is TranscriptionResponse {
  return (
    "transcription" in r &&
    (r as TranscriptionResponse).transcription != null &&
    typeof (r as TranscriptionResponse).transcription === "object"
  );
}

export function isVideoResponse(r: FixtureResponse): r is VideoResponse {
  return (
    "video" in r &&
    (r as VideoResponse).video != null &&
    typeof (r as VideoResponse).video === "object"
  );
}

export function isJSONResponse(r: FixtureResponse): r is RawJSONResponse {
  return "json" in r && (r as RawJSONResponse).json !== undefined;
}

export function extractOverrides(
  response: TextResponse | ToolCallResponse | ContentWithToolCallsResponse,
): ResponseOverrides {
  const r = response;
  return {
    ...(r.id !== undefined && { id: r.id }),
    ...(r.created !== undefined && { created: r.created }),
    ...(r.model !== undefined && { model: r.model }),
    ...(r.usage !== undefined && { usage: r.usage }),
    ...(r.systemFingerprint !== undefined && { systemFingerprint: r.systemFingerprint }),
    ...(r.finishReason !== undefined && { finishReason: r.finishReason }),
    ...(r.role !== undefined && { role: r.role }),
    ...(r.provider !== undefined && { provider: r.provider }),
    ...(r.nativeFinishReason !== undefined && { nativeFinishReason: r.nativeFinishReason }),
  };
}

// ─── Token estimation ────────────────────────────────────────────────────

/**
 * Rough token count estimation based on character length.
 * Uses the ~4 characters per token heuristic common for English text.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Estimate prompt tokens from a request's messages array.
 */
export function estimatePromptTokens(messages: ChatCompletionRequest["messages"]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.text) totalChars += part.text.length;
      }
    }
  }
  return Math.max(1, Math.ceil(totalChars / 4));
}

/**
 * Build usage object: use explicit overrides if provided, otherwise estimate.
 *
 * Shared by BOTH the non-streaming completion builders (below) and the
 * streaming usage-chunk sites in server.ts — the single source of truth for
 * "explicit token override wins, cost-only override still estimates". Exported
 * so the streaming path does not re-implement the estimation logic.
 */
export function resolveUsage(
  overrides: ResponseOverrides | undefined,
  promptText: string,
  completionText: string,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  if (overrides?.usage) {
    const u = overrides.usage;
    // A usage override that scripts only cost fields (e.g. `{ cost: 0.5 }`)
    // carries NO token counts. Real providers always report real token usage,
    // so estimate the counts rather than forcing them to 0 — otherwise a
    // cost-scripting fixture is unfaithful (cost present, tokens 0). When the
    // override DOES set any token count we preserve the explicit-or-zero merge
    // behavior, and any explicit token value always wins.
    const hasExplicitTokens =
      u.prompt_tokens !== undefined ||
      u.completion_tokens !== undefined ||
      u.total_tokens !== undefined ||
      u.input_tokens !== undefined ||
      u.output_tokens !== undefined ||
      u.promptTokenCount !== undefined ||
      u.candidatesTokenCount !== undefined ||
      u.totalTokenCount !== undefined;
    const fallbackPrompt = hasExplicitTokens ? 0 : estimateTokens(promptText || "x");
    const fallbackCompletion = hasExplicitTokens ? 0 : estimateTokens(completionText || "x");
    const prompt = u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? fallbackPrompt;
    const completion =
      u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? fallbackCompletion;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: u.total_tokens ?? u.totalTokenCount ?? prompt + completion,
    };
  }
  const prompt = estimateTokens(promptText || "x");
  const completion = estimateTokens(completionText || "x");
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/**
 * Build an SSE usage chunk for streaming responses.
 * OpenAI emits this as the final chunk before [DONE] when
 * stream_options.include_usage is true. It has an empty choices array.
 */
export function buildUsageChunk(
  id: string,
  model: string,
  created: number,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  fingerprint?: string,
): SSEChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage,
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  };
}

export function buildTextChunks(
  content: string,
  model: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
): SSEChunk[] {
  const id = overrides?.id ?? generateId();
  const created = overrides?.created ?? Math.floor(Date.now() / 1000);
  const effectiveModel = overrides?.model ?? model;
  const chunks: SSEChunk[] = [];
  const fingerprint = overrides?.systemFingerprint;

  // Reasoning chunks (emitted before content, OpenRouter format)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          { index: 0, delta: { reasoning_content: slice }, logprobs: null, finish_reason: null },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Role chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: { role: overrides?.role ?? "assistant", content: "" },
        logprobs: null,
        finish_reason: null,
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  // Content chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [{ index: 0, delta: { content: slice }, logprobs: null, finish_reason: null }],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });
  }

  // Finish chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      { index: 0, delta: {}, logprobs: null, finish_reason: overrides?.finishReason ?? "stop" },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  return chunks;
}

/** K9 exposure is selected by the provider path, never the echoed response model. */
export function buildOpenAIReasoningChunks(
  reasoning: string,
  model: string,
  chunkSize: number,
  exposeReasoning: boolean,
  overrides?: ResponseOverrides,
): SSEChunk[] {
  return buildTextChunks(exposeReasoning ? reasoning : "", model, chunkSize, undefined, {
    ...overrides,
    role: "assistant",
    finishReason: "length",
  }).map((chunk) => ({
    ...chunk,
    choices: chunk.choices.map((choice) => ({
      ...choice,
      delta:
        choice.delta.role !== undefined
          ? { role: "assistant", content: null }
          : typeof choice.delta.content === "string"
            ? {
                role: "assistant",
                content: "",
                reasoning: choice.delta.content,
                reasoning_details: [
                  {
                    type: "reasoning.text" as const,
                    text: choice.delta.content,
                    format: "unknown" as const,
                    index: 0,
                  },
                ],
              }
            : {},
    })),
  }));
}

/** Render exposed reasoning or native OpenAI's empty length completion. */
export function buildOpenAIReasoningCompletion(
  reasoning: string,
  model: string,
  exposeReasoning: boolean,
  overrides?: ResponseOverrides,
  requestMessages?: ChatCompletionRequest["messages"],
): ChatCompletion {
  const visible = exposeReasoning ? reasoning : "";
  const completion = buildTextCompletion(
    visible,
    model,
    undefined,
    {
      ...overrides,
      role: "assistant",
      finishReason: "length",
      usage: undefined,
    },
    requestMessages,
  );
  return {
    ...completion,
    choices: completion.choices.map((choice) => ({
      ...choice,
      message: {
        role: "assistant",
        content: null,
        refusal: null,
        ...(exposeReasoning
          ? {
              reasoning: visible,
              reasoning_details: [
                {
                  type: "reasoning.text" as const,
                  text: visible,
                  format: "unknown" as const,
                  index: 0,
                },
              ],
            }
          : {}),
      },
    })),
  };
}

/** Render withheld output with only the role and native content-filter terminal. */
export function buildOpenAIContentFilterChunks(
  model: string,
  overrides?: ResponseOverrides,
): SSEChunk[] {
  return buildTextChunks("", model, 1, undefined, {
    ...overrides,
    role: "assistant",
    finishReason: "content_filter",
  }).map((chunk) => ({
    ...chunk,
    choices: chunk.choices.map((choice) => ({
      ...choice,
      delta: choice.delta.role !== undefined ? { role: "assistant", content: null } : {},
    })),
  }));
}

/** Non-streaming filtered output contains no answer, refusal text, reasoning, or calls. */
export function buildOpenAIContentFilterCompletion(
  model: string,
  overrides?: ResponseOverrides,
  requestMessages?: ChatCompletionRequest["messages"],
): ChatCompletion {
  const completion = buildTextCompletion(
    "",
    model,
    undefined,
    {
      ...overrides,
      role: "assistant",
      finishReason: "content_filter",
      usage: undefined,
    },
    requestMessages,
  );
  return {
    ...completion,
    choices: completion.choices.map((choice) => ({
      ...choice,
      message: { role: "assistant", content: null, refusal: null },
    })),
  };
}

/** Render an applied refusal on its own channel without ordinary content or reasoning. */
export function buildOpenAIRefusalChunks(
  refusal: string,
  model: string,
  chunkSize: number,
  overrides?: ResponseOverrides,
) {
  return buildTextChunks(refusal, model, chunkSize, undefined, {
    ...overrides,
    role: "assistant",
    finishReason: "stop",
  }).map((chunk) => ({
    ...chunk,
    choices: chunk.choices.map((choice) => {
      const delta: typeof choice.delta & { refusal?: string } =
        choice.delta.role !== undefined
          ? { role: "assistant", content: null }
          : typeof choice.delta.content === "string"
            ? { refusal: choice.delta.content }
            : {};
      return { ...choice, delta };
    }),
  }));
}

/** Refusal-only counterpart of the ordinary text completion builder. */
export function buildOpenAIRefusalCompletion(
  refusal: string,
  model: string,
  overrides?: ResponseOverrides,
  requestMessages?: ChatCompletionRequest["messages"],
): ChatCompletion {
  const completion = buildTextCompletion(
    refusal,
    model,
    undefined,
    {
      ...overrides,
      role: "assistant",
      finishReason: "stop",
      usage: undefined,
    },
    requestMessages,
  );
  return {
    ...completion,
    choices: completion.choices.map((choice) => ({
      ...choice,
      message: { role: "assistant", content: null, refusal },
    })),
  };
}

export function buildToolCallChunks(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
): SSEChunk[] {
  const id = overrides?.id ?? generateId();
  const created = overrides?.created ?? Math.floor(Date.now() / 1000);
  const effectiveModel = overrides?.model ?? model;
  const chunks: SSEChunk[] = [];
  const fingerprint = overrides?.systemFingerprint;

  // Reasoning chunks (emitted before tool calls, OpenRouter format)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          { index: 0, delta: { reasoning_content: slice }, logprobs: null, finish_reason: null },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Role chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: { role: overrides?.role ?? "assistant", content: null },
        logprobs: null,
        finish_reason: null,
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  // Tool call chunks — one initial chunk per tool call, then argument chunks
  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    const tcId = tc.id || generateToolCallId();

    // Initial tool call chunk (id + function name)
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: tcIdx,
                id: tcId,
                type: "function",
                function: { name: tc.name, arguments: "" },
              },
            ],
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });

    // Argument streaming chunks
    const args = tc.arguments;
    for (let i = 0; i < args.length; i += chunkSize) {
      const slice = args.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: tcIdx, function: { arguments: slice } }],
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Finish chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  return chunks;
}

// Non-streaming response builders

export function buildTextCompletion(
  content: string,
  model: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
  requestMessages?: ChatCompletionRequest["messages"],
): ChatCompletion {
  const promptText = requestMessages
    ? requestMessages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => p.text ?? "").join("")
              : "",
        )
        .join("")
    : "";
  return {
    id: overrides?.id ?? generateId(),
    object: "chat.completion",
    created: overrides?.created ?? Math.floor(Date.now() / 1000),
    model: overrides?.model ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: overrides?.role ?? "assistant",
          content,
          refusal: null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "stop",
      },
    ],
    usage: resolveUsage(overrides, promptText, content),
    ...(overrides?.systemFingerprint !== undefined && {
      system_fingerprint: overrides.systemFingerprint,
    }),
  };
}

export function buildToolCallCompletion(
  toolCalls: ToolCall[],
  model: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
  requestMessages?: ChatCompletionRequest["messages"],
): ChatCompletion {
  const promptText = requestMessages
    ? requestMessages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => p.text ?? "").join("")
              : "",
        )
        .join("")
    : "";
  const completionText = toolCalls.map((tc) => tc.name + tc.arguments).join("");
  return {
    id: overrides?.id ?? generateId(),
    object: "chat.completion",
    created: overrides?.created ?? Math.floor(Date.now() / 1000),
    model: overrides?.model ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: overrides?.role ?? "assistant",
          content: null,
          refusal: null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id || generateToolCallId(),
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    usage: resolveUsage(overrides, promptText, completionText),
    ...(overrides?.systemFingerprint !== undefined && {
      system_fingerprint: overrides.systemFingerprint,
    }),
  };
}

export function buildContentWithToolCallsChunks(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
  blocks?: FixtureBlock[],
): SSEChunk[] {
  const id = overrides?.id ?? generateId();
  const created = overrides?.created ?? Math.floor(Date.now() / 1000);
  const effectiveModel = overrides?.model ?? model;
  const chunks: SSEChunk[] = [];
  const fingerprint = overrides?.systemFingerprint;

  if (blocks && blocks.length > 0) {
    // NEW: emit chunks in fixture block array order.
    //
    // DEGENERATE PROVIDER NOTE: in OpenAI chat-completions, `delta.content` and
    // `delta.tool_calls` are SEPARATE channels that the client merges with no
    // positional interleaving. So "tool-call-before-text" is NOT semantically
    // observable to a real client — it reassembles content and tool calls into
    // their own buckets regardless of chunk order. We still emit honest
    // array-order chunks (the SSE chunk SEQUENCE is the contract this path
    // asserts), but we do NOT fake interleaving the channel cannot express.
    const outcome = resolveFixtureBlockOutcome(blocks);
    const ordered = outcome.ordered;

    // Reasoning chunks (emitted first, OpenRouter format) — unchanged from legacy.
    if (reasoning) {
      for (let i = 0; i < reasoning.length; i += chunkSize) {
        const slice = reasoning.slice(i, i + chunkSize);
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model: effectiveModel,
          choices: [
            {
              index: 0,
              delta: {
                ...(i === 0 && { role: overrides?.role ?? "assistant" }),
                reasoning_content: slice,
              },
              logprobs: null,
              finish_reason: null,
            },
          ],
          ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
        });
      }
    }

    // Role chunk — preserved exactly as the legacy path.
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [
        {
          index: 0,
          delta: { role: overrides?.role ?? "assistant", content: "" },
          logprobs: null,
          finish_reason: null,
        },
      ],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });

    // Tool-call `index` is assigned in encounter order across the block array.
    let tcIdx = 0;
    for (const block of ordered) {
      if (block.type === "text") {
        for (let i = 0; i < block.text.length; i += chunkSize) {
          const slice = block.text.slice(i, i + chunkSize);
          chunks.push({
            id,
            object: "chat.completion.chunk",
            created,
            model: effectiveModel,
            choices: [{ index: 0, delta: { content: slice }, logprobs: null, finish_reason: null }],
            ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
          });
        }
      } else {
        const tcId = block.id || generateToolCallId();

        // Initial tool call chunk (id + function name)
        chunks.push({
          id,
          object: "chat.completion.chunk",
          created,
          model: effectiveModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: tcIdx,
                    id: tcId,
                    type: "function",
                    function: { name: block.name, arguments: "" },
                  },
                ],
              },
              logprobs: null,
              finish_reason: null,
            },
          ],
          ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
        });

        // Argument streaming chunks
        const args = block.arguments;
        for (let i = 0; i < args.length; i += chunkSize) {
          const slice = args.slice(i, i + chunkSize);
          chunks.push({
            id,
            object: "chat.completion.chunk",
            created,
            model: effectiveModel,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: tcIdx, function: { arguments: slice } }],
                },
                logprobs: null,
                finish_reason: null,
              },
            ],
            ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
          });
        }
        tcIdx++;
      }
    }

    // Derive the default terminal from the blocks actually emitted.
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [
        {
          index: 0,
          delta: {},
          logprobs: null,
          finish_reason: overrides?.finishReason ?? (outcome.hasToolCalls ? "tool_calls" : "stop"),
        },
      ],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });

    return chunks;
  }

  // EXISTING legacy code, byte-for-byte UNCHANGED.
  // Reasoning chunks (emitted before content, OpenRouter format)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          {
            index: 0,
            delta: {
              ...(i === 0 && { role: overrides?.role ?? "assistant" }),
              reasoning_content: slice,
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Role chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: { role: overrides?.role ?? "assistant", content: "" },
        logprobs: null,
        finish_reason: null,
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  // Content chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [{ index: 0, delta: { content: slice }, logprobs: null, finish_reason: null }],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });
  }

  // Tool call chunks — one initial chunk per tool call, then argument chunks
  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    const tcId = tc.id || generateToolCallId();

    // Initial tool call chunk (id + function name)
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: tcIdx,
                id: tcId,
                type: "function",
                function: { name: tc.name, arguments: "" },
              },
            ],
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });

    // Argument streaming chunks
    const args = tc.arguments;
    for (let i = 0; i < args.length; i += chunkSize) {
      const slice = args.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: tcIdx, function: { arguments: slice } }],
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Finish chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  return chunks;
}

// NOTE (#274): this NON-streaming OpenAI chat-completions builder is
// intentionally degenerate w.r.t. `blocks` ordering. A chat.completion puts
// `message.content` and `message.tool_calls` in SEPARATE fields on a single
// message object — they are NOT a positionally-observable array, so a
// tool-first `blocks` fixture cannot be expressed in the wire shape. Honoring
// block order here would be a no-op, so the legacy content+tool_calls fields
// are unchanged. (Order-observable surfaces — Claude `content[]`, Gemini
// `parts[]`, Responses `output[]` — DO honor block order; see those builders.)
export function buildContentWithToolCallsCompletion(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
  requestMessages?: ChatCompletionRequest["messages"],
): ChatCompletion {
  const promptText = requestMessages
    ? requestMessages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => p.text ?? "").join("")
              : "",
        )
        .join("")
    : "";
  const completionText = content + toolCalls.map((tc) => tc.name + tc.arguments).join("");
  return {
    id: overrides?.id ?? generateId(),
    object: "chat.completion",
    created: overrides?.created ?? Math.floor(Date.now() / 1000),
    model: overrides?.model ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: overrides?.role ?? "assistant",
          content,
          refusal: null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id || generateToolCallId(),
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    usage: resolveUsage(overrides, promptText, completionText),
    ...(overrides?.systemFingerprint !== undefined && {
      system_fingerprint: overrides.systemFingerprint,
    }),
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * A body read that stopped because the CLIENT sent more bytes than the route
 * allows. The socket is already destroyed when this rejects, so no status line
 * ever reaches the caller — but the fault is the caller's, and error arms that
 * journal and log the failure need to say so. Carrying the classification on
 * the error type (rather than re-matching the message text) is what lets them:
 * the message is unchanged from the plain `Error` this replaced.
 */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeded size limit of ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * Read a request body as raw bytes, preserving every octet.
 *
 * This is the byte-level primitive {@link readBody} is built on: routes that
 * must not lose bytes (binary file uploads) take the Buffer, everything else
 * keeps taking the decoded string. Splitting it this way leaves the text path
 * byte-identical — `readBody` performs exactly the same `Buffer.concat(...)`
 * + default (utf8) `toString()` it always did, just one call later.
 */
export function readBodyBuffer(
  req: http.IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        req.destroy();
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * A body read with a buffering bound that does NOT cost the caller its socket.
 *
 * `buffer` is `null` when the body went over the buffering bound: the bytes
 * read so far were released and the rest was drained, so the request still
 * reaches `end` and the route can answer a real status (with CORS) instead of
 * the client seeing an `ECONNRESET`.
 */
export interface BoundedBody {
  buffer: Buffer | null;
  /** Bytes seen on the wire, counted past the buffering bound. */
  bytesRead: number;
}

/**
 * Read a request body that may legitimately be over-size, without either
 * buffering it all or dropping the socket.
 *
 * {@link readBodyBuffer} answers an over-size body with `req.destroy()`: no
 * status line, no body, no CORS headers. That is the right default for routes
 * whose limit is a pure DoS bound, but it is the wrong answer for a route that
 * owes the caller a `400` describing what was wrong — the caller cannot read an
 * error it never receives. So this variant splits the two concerns:
 *
 * - `maxBytes` bounds MEMORY. Past it the buffered chunks are dropped and the
 *   body is only counted, so peak retention never exceeds `maxBytes` no matter
 *   how large the body is. The caller gets `buffer: null` and answers itself.
 * - `drainMaxBytes` bounds WORK, and is the only socket drop here: a body that
 *   keeps coming past it is not worth draining and rejects as `readBodyBuffer`
 *   would.
 */
export function readBodyBufferBounded(
  req: http.IncomingMessage,
  maxBytes: number,
  drainMaxBytes: number,
): Promise<BoundedBody> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] | null = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (chunks !== null && totalBytes > maxBytes) {
        // Release on the FIRST chunk over the bound, before pushing it: the
        // bytes are unusable now, and holding them is what would make peak
        // memory track the attacker's body size instead of `maxBytes`.
        chunks = null;
      }
      if (totalBytes > drainMaxBytes) {
        settled = true;
        req.destroy();
        reject(new RequestBodyTooLargeError(drainMaxBytes));
        return;
      }
      if (chunks !== null) chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ buffer: chunks === null ? null : Buffer.concat(chunks), bytesRead: totalBytes });
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

export function readBody(
  req: http.IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  return readBodyBuffer(req, maxBytes).then((buf) => buf.toString());
}

// ─── Pattern matching ─────────────────────────────────────────────────────

/**
 * Case-insensitive substring/regex match used for search, rerank, and
 * moderation endpoints where exact casing rarely matters. String patterns
 * are lowercased on both sides before comparison.
 *
 * Note: This intentionally differs from the case-sensitive matching in
 * {@link matchFixture} (router.ts), where fixture authors expect exact
 * string matching against chat completion user messages.
 */
export function matchesPattern(text: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
  // A global/sticky RegExp carries mutable `lastIndex` state that `.test()`
  // advances. Save and restore it so callers reusing the same regex object
  // (search/rerank/moderation filter loops) are not left with mutated state
  // and get consistent results across repeated calls.
  const savedLastIndex = pattern.lastIndex;
  pattern.lastIndex = 0;
  const result = pattern.test(text);
  pattern.lastIndex = savedLastIndex;
  return result;
}

/**
 * Which test LLM and other HTTP-route traffic belongs to: the `X-Test-Id`
 * header (raw, not percent-decoded) wins, then `?testId=` in the query string
 * (read through `URLSearchParams`, so percent-decoded and with `+` as a
 * space), then `DEFAULT_TEST_ID`. Every per-test axis of those routes
 * (fixture match-counts, the journal filter, chaos scoping) resolves through
 * this. MCP mounts resolve the test id with {@link resolveMcpIdentity}
 * instead, which percent-decodes the header, so `X-Test-Id: a%20b` is `a%20b`
 * here and `a b` there. Both read a `+` in the query as a space.
 */
export function resolveTestId(headers: IncomingHttpHeaders, url: string | undefined): string {
  const headerValue = headers["x-test-id"];
  if (Array.isArray(headerValue)) {
    if (headerValue.length > 0 && headerValue[0]) return headerValue[0];
  } else if (typeof headerValue === "string" && headerValue) {
    return headerValue;
  }

  const qIdx = (url ?? "/").indexOf("?");
  if (qIdx !== -1) {
    const params = new URLSearchParams((url ?? "/").slice(qIdx + 1));
    const queryValue = params.get("testId");
    if (queryValue) return queryValue;
  }

  return DEFAULT_TEST_ID;
}

export function getTestId(req: http.IncomingMessage): string {
  return resolveTestId(req.headers, req.url);
}

export function getContext(req: http.IncomingMessage): string | undefined {
  const headerValue = req.headers["x-aimock-context"];
  if (Array.isArray(headerValue)) {
    if (headerValue.length > 0 && headerValue[0]) return headerValue[0];
  } else if (typeof headerValue === "string" && headerValue) {
    return headerValue;
  }
  return undefined;
}

/**
 * Decode one MCP identity value: an `X-Test-Id` / `X-AIMock-Context` header
 * value, and also each query name and (through {@link decodeMcpQueryValue})
 * each `?testId=` / `?context=` / `?undeclared=` query value. Clients send `encodeURIComponent(id)` because
 * `fetch` rejects characters such as `›` in a header. A value that is not
 * valid percent-encoding (a raw `applies 50% discount`) is used as-is, with
 * `fellBack: true` so the caller can log the fallback. Only that `URIError`
 * is caught; any other throw propagates. MCP requests only: LLM routes read
 * the header raw and the query through `URLSearchParams` (see
 * {@link resolveTestId}).
 */
export function decodeMcpHeaderValue(raw: string): { value: string; fellBack: boolean } {
  try {
    return { value: decodeURIComponent(raw), fellBack: false };
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
    return { value: raw, fellBack: true };
  }
}

/**
 * Decode one MCP query value (`?testId=`, `?context=`, `?undeclared=`) the way
 * `URLSearchParams` reads it (spec I1): a `+` is a space, then the value is
 * percent-decoded by the {@link decodeMcpHeaderValue} rule. So a query built
 * with `URL.searchParams.set(...)` (a space sent as `+`) and one built with
 * `encodeURIComponent` both resolve to the id itself. A value that is not
 * valid percent-encoding is used as-is (its `+` still a space), with
 * `fellBack: true`.
 */
function decodeMcpQueryValue(raw: string): { value: string; fellBack: boolean } {
  return decodeMcpHeaderValue(raw.replace(/\+/g, " "));
}

/** The parts of a request that {@link resolveMcpIdentity} reads. */
export type McpIdentityRequest = Pick<http.IncomingMessage, "headers" | "url"> &
  Partial<Pick<http.IncomingMessage, "headersDistinct">>;

/**
 * Every value of the header `name`, one per header line: `[]` when absent.
 * Node joins a repeated header into one comma-joined `req.headers` string, so
 * the values come from `req.headersDistinct` (one element per line) when the
 * request has it. A caller without it (a hand-built request) is read from
 * `req.headers`: one element for a string, each element for an array.
 */
function headerValues(req: McpIdentityRequest, name: string): string[] {
  const distinct = req.headersDistinct?.[name];
  if (distinct !== undefined) return distinct;
  const value = req.headers[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** One `name=value` pair of a query string, its name decoded. */
interface McpQueryPair {
  /** The decoded name, or `null` when the name is not valid percent-encoding. */
  name: string | null;
  /** The raw (still percent-encoded) value; `""` for a bare name with no `=`. */
  value: string;
}

/**
 * Every pair of a query string, in order, each name decoded by the
 * `decodeMcpHeaderValue` rule. A bare `name` with no `=` counts as an
 * occurrence with an empty value, so `?testId&testId=t1` has two. Each value
 * is left raw for the caller to decode with {@link decodeMcpQueryValue}.
 * A name that is not valid percent-encoding (`test%Id`) gets `name: null`: it
 * matches no field, and the caller counts it.
 */
function queryPairs(query: string): McpQueryPair[] {
  if (query === "") return [];
  return query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const key = decodeMcpHeaderValue(eq === -1 ? pair : pair.slice(0, eq));
    return { name: key.fellBack ? null : key.value, value: eq === -1 ? "" : pair.slice(eq + 1) };
  });
}

/**
 * A request value as a message part, the way the message builder quotes every
 * user string: JSON-quoted (quotes and control characters escaped), then cut
 * once as JSON text, so the whole echo, quotes, escapes and the
 * `… (<n> more chars)` count included, fits in `MCP_FAKES_ECHO_LIMIT` and the
 * cut never splits a JSON escape or a surrogate pair.
 */
function echoIdentityValue(value: string): MessageValue {
  return quote(value, MCP_FAKES_ECHO_LIMIT);
}

/** The session fields an MCP session binds at `initialize`. */
type McpIdentitySession = Pick<MCPSession, "testId" | "context" | "undeclared">;

/** An MCP identity input: the test id, the context or the undeclared override. */
export type McpIdentityField = "testId" | "context" | "undeclared";

/**
 * Why an MCP request's identity inputs cannot be honored. The MCP mount is
 * meant to answer `status` with `{ "error": message }` and serve nothing.
 * - `MCP_INVALID_UNDECLARED`: an undeclared override (`X-AIMock-MCP-Undeclared`
 *   / `?undeclared=`) other than `allow` / `deny`, so a typo such as `denied`
 *   can never turn a `deny` scenario into the permissive default. `raw` is
 *   the value as sent (the query value still percent-encoded), not quoted,
 *   cut by `cutText` to `MCP_FAKES_ECHO_LIMIT` chars, so a huge value is
 *   never carried in full. A query value that
 *   is not valid percent-encoding is also an error, and the message says so.
 * - `MCP_DUPLICATE_IDENTITY`: one field sent more than once on one path (a
 *   header array with more than one element, or a repeated query name, empty
 *   or not). No value is picked. `count` is how many were sent.
 */
export type McpIdentityError =
  | {
      code: "MCP_INVALID_UNDECLARED";
      status: 400;
      field: "undeclared";
      source: "header" | "query";
      raw: string;
      message: string;
    }
  | {
      code: "MCP_DUPLICATE_IDENTITY";
      status: 400;
      field: McpIdentityField;
      source: "header" | "query";
      count: number;
      message: string;
    };

/** The result of {@link resolveMcpIdentity}: a resolved identity, or an error to answer with. */
export type McpIdentityResolution =
  | {
      ok: true;
      identity: McpFakeIdentity;
      /** Whether the request itself carried each field (raw header/query, not the session). */
      supplied: { testId: boolean; context: boolean; undeclared: boolean };
      /**
       * Whether a header or query value sent for each field was not valid
       * percent-encoding and fell back to the raw value. Set also when the
       * header supplied the field and the ignored query value did not decode,
       * so bad encoding is never silent. For the MCP mount to log a warning,
       * once per session per field.
       */
      fellBack: { testId: boolean; context: boolean };
      /**
       * How many query names were not valid percent-encoding (`?test%Id=`).
       * Such a name matches no field. Present only when at least one was
       * found, for the MCP mount to log.
       */
      undecodedQueryNames?: number;
    }
  | { ok: false; error: McpIdentityError };

const MCP_IDENTITY_INPUTS: Record<
  McpIdentityField,
  { header: string; query: string; label: string }
> = {
  testId: { header: "x-test-id", query: "testId", label: "X-Test-Id" },
  context: { header: "x-aimock-context", query: "context", label: "X-AIMock-Context" },
  undeclared: {
    header: "x-aimock-mcp-undeclared",
    query: "undeclared",
    label: "X-AIMock-MCP-Undeclared",
  },
};

/**
 * Resolve the identity (test id, context, undeclared override) of one MCP request.
 * Each field resolves on its own, first of: the header, the query parameter,
 * the session value bound at `initialize`. A field sent more than once on
 * either path (more than one header line, read from `headersDistinct` because
 * Node joins repeated lines into one `headers` string; a header array from a
 * hand-built request; a repeated query name) is an error
 * (`MCP_DUPLICATE_IDENTITY`), even when the other path also carries it. For
 * the test id and the context, a header value is decoded with
 * `decodeURIComponent` (raw value on failure, with `fellBack` set) and a query
 * value the way `URLSearchParams` reads it (spec I1): a `+` is a space, then
 * the same `decodeURIComponent` rule. So `encodeURIComponent` output (what
 * clients send) and a query built with `URL.searchParams` both decode to the
 * id itself, while a raw `+` is a `+` in the header and a space in the query.
 * When both paths carry a test id or a context, the header is used and the
 * query value is ignored, even if the two differ, but an ignored query value
 * that does not decode still sets `fellBack`. The undeclared header is not
 * percent-decoded; its query value is, by the same query rule. Both are
 * trimmed and compared case-insensitively. `supplied` says whether the
 * request itself carried a non-empty header or query value for the field,
 * never `resolveTestId`'s result (which returns `"__default__"` when nothing
 * is sent). Blank values: an empty value is not supplied and falls through;
 * it is never rejected. A whitespace-only value is not supplied for the
 * undeclared override (it is trimmed), but is a real value for the test id
 * and the context, which match exactly and are never trimmed (Node trims a
 * header value, so only the query or a hand-built request can carry one). A
 * lone query name with no `=` carries no value. An empty session value counts
 * as none, and a missing `req.url` as `/`. A field with no value anywhere is
 * `null`. An unrecognized undeclared override on the header or the query is
 * an error (`ok: false`), not a fall-through: both are checked before the
 * header one is used, so a valid header does not hide a mistyped query value.
 * Bad percent-encoding is never silent: a test id or context value that does
 * not decode sets `fellBack`, on either path, used or ignored; an undeclared
 * query value that does not decode is that error, with the message saying
 * so; and a query name that does not decode matches no field and is counted
 * in `undecodedQueryNames`. `resolveTestId` / `getContext` stay unchanged for
 * LLM routes.
 */
export function resolveMcpIdentity(
  req: McpIdentityRequest,
  session?: McpIdentitySession,
): McpIdentityResolution {
  const url = req.url ?? "/";
  const qIdx = url.indexOf("?");
  const pairs = queryPairs(qIdx === -1 ? "" : url.slice(qIdx + 1));

  // Collect each field's one raw value per path, rejecting any repetition first.
  const raw = {} as Record<McpIdentityField, { header?: string; query?: string }>;
  for (const field of ["testId", "context", "undeclared"] as const) {
    const input = MCP_IDENTITY_INPUTS[field];
    const sent = [
      ["header", headerValues(req, input.header)],
      ["query", pairs.filter((p) => p.name === input.query).map((p) => p.value)],
    ] as const;
    for (const [source, values] of sent) {
      if (values.length > 1) {
        const label =
          source === "header"
            ? msg`${fixed(input.label)} header`
            : msg`?${fixed(input.query)}= query parameter`;
        return {
          ok: false,
          error: {
            code: "MCP_DUPLICATE_IDENTITY",
            status: 400,
            field,
            source,
            count: values.length,
            message: build(msg`Duplicate ${label}: ${values.length} values sent, expected one`),
          },
        };
      }
    }
    raw[field] = { header: sent[0][1][0], query: sent[1][1][0] };
  }

  const fromRequest = (
    field: "testId" | "context",
  ): { value: string | null; fellBack: boolean } => {
    const { header, query: q } = raw[field];
    const fromQuery = q ? decodeMcpQueryValue(q) : null;
    if (header) {
      // The header wins; an ignored query value that does not decode still flags.
      const used = decodeMcpHeaderValue(header);
      return { value: used.value, fellBack: used.fellBack || (fromQuery?.fellBack ?? false) };
    }
    return fromQuery ?? { value: null, fellBack: false };
  };

  const testId = fromRequest("testId");
  const context = fromRequest("context");

  // Check every supplied undeclared value before using one: the header wins,
  // but a mistyped query value next to it is still an error.
  let undeclared: McpFakeUndeclaredPolicy | null = null;
  for (const source of ["header", "query"] as const) {
    const sent = raw.undeclared[source];
    if (sent === undefined) continue;
    // Header decoding covers only X-Test-Id / X-AIMock-Context; this header is
    // not percent-decoded. The query value is decoded.
    const decoded =
      source === "header" ? { value: sent, fellBack: false } : decodeMcpQueryValue(sent);
    if (decoded.value.trim() === "") continue;
    const parsed = parseMcpUndeclared(decoded.value);
    if (parsed === null) {
      const echoed = echoIdentityValue(sent);
      const label =
        source === "header"
          ? msg`X-AIMock-MCP-Undeclared header`
          : msg`?undeclared= query parameter`;
      const note = decoded.fellBack ? msg` (not valid percent-encoding)` : msg``;
      return {
        ok: false,
        error: {
          code: "MCP_INVALID_UNDECLARED",
          status: 400,
          field: "undeclared",
          source,
          raw: cutText(sent),
          message: build(msg`Invalid ${label} value ${echoed}${note}: expected allow or deny`),
        },
      };
    }
    undeclared ??= parsed;
  }

  const undecodedQueryNames = pairs.filter((p) => p.name === null).length;
  return {
    ok: true,
    identity: {
      testId: testId.value ?? (session?.testId || null),
      context: context.value ?? (session?.context || null),
      undeclared: undeclared ?? session?.undeclared ?? null,
    },
    supplied: {
      testId: testId.value !== null,
      context: context.value !== null,
      undeclared: undeclared !== null,
    },
    fellBack: { testId: testId.fellBack, context: context.fellBack },
    ...(undecodedQueryNames > 0 ? { undecodedQueryNames } : {}),
  };
}

// ─── Snapshot recording helpers ──────────────────────────────────────────────

/**
 * Convert a test ID (e.g. Playwright titlePath) into a filesystem-safe slug
 * suitable for use as a directory name in snapshot-style recording.
 */
export function slugifyTestId(testId: string): string {
  return testId
    .replace(/^.*?\.(?:spec|test|e2e)\.(?:tsx|ts|jsx|js|mjs|cjs)(?=\s|›|$)\s*›?\s*/i, "") // strip test file extension prefix
    .replace(/\s*[›>]\s*/g, "--") // Playwright titlePath separator → double dash
    .replace(/[^\w-]/g, "-") // non-word chars → dash
    .replace(/-{3,}/g, "--") // collapse 3+ dashes to double
    .replace(/^-+|-+$/g, "") // trim leading/trailing dashes
    .toLowerCase();
}

/**
 * Make a request context (the `X-AIMock-Context` header value) safe to use as
 * a single directory segment in a recorded-fixture path. The header is
 * attacker-controllable, so a raw value containing `../`, path separators, or
 * an absolute-path prefix would let the written fixture escape the configured
 * fixtures base directory. Mirrors `slugifyTestId`: non-word characters
 * (including `/`, `\`, and `.`) collapse to dashes, so the result is always a
 * single flat segment with no traversal semantics. Returns "" when the value
 * sanitizes to nothing (caller treats that as "no context segment").
 */
export function slugifyContext(context: string): string {
  return context
    .replace(/[^\w-]/g, "-") // non-word chars (incl. / \ . :) → dash
    .replace(/-{3,}/g, "--") // collapse 3+ dashes to double
    .replace(/^-+|-+$/g, "") // trim leading/trailing dashes
    .toLowerCase();
}

// ─── Request shape validation ──────────────────────────────────────────────

/**
 * Validate the shape of a chat `messages` array (Cohere / Ollama / Bedrock
 * style: entries with `content` and optional `tool_calls`).
 *
 * Returns an error detail string when the shape is wrong, or null when the
 * provider converter can safely consume it. Wrong types here used to throw
 * inside the converters (`content.filter` on a number, `.map` on a string
 * `tools`, `msg.role` on a null entry) and surface as 500s. `null` content
 * is accepted — assistant messages legitimately carry `content: null`
 * alongside tool calls, and the converters coerce it to "".
 *
 * `checkToolCalls` must be false for providers whose converter never reads
 * `msg.tool_calls` (Bedrock: tool calls are `tool_use` content blocks and
 * `tool_calls` is not a field of the Anthropic Messages body at all). There a
 * stray `tool_calls` is inert — rejecting it turns a request that used to
 * match a fixture and return 200 into a 400.
 */
export function validateChatMessages(
  messages: unknown,
  { checkToolCalls = true }: { checkToolCalls?: boolean } = {},
): string | null {
  // Matches the historic "messages array is required" detail so handlers can
  // compose the exact legacy message for a missing/non-array field.
  if (!Array.isArray(messages)) return "messages array is required";
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown> | null;
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return `messages[${i}] must be an object`;
    }
    const content = msg.content;
    if (
      content !== undefined &&
      content !== null &&
      typeof content !== "string" &&
      !Array.isArray(content)
    ) {
      return `messages[${i}].content must be a string or an array`;
    }
    if (Array.isArray(content) && content.some((p) => p === null || p === undefined)) {
      return `messages[${i}].content must be a string or an array`;
    }
    const toolCalls = msg.tool_calls;
    if (checkToolCalls && toolCalls !== undefined && toolCalls !== null) {
      if (!Array.isArray(toolCalls)) {
        return `messages[${i}].tool_calls must be an array`;
      }
      for (const tc of toolCalls) {
        if (tc === null || typeof tc !== "object" || Array.isArray(tc)) {
          return `messages[${i}].tool_calls entries must be objects`;
        }
        const fn = (tc as Record<string, unknown>).function;
        if (fn === null || typeof fn !== "object" || Array.isArray(fn)) {
          return `messages[${i}].tool_calls entries must have a function object`;
        }
      }
    }
  }
  return null;
}

/**
 * Validate an optional top-level `tools` field. A string (or other
 * non-array) value passes the `req.tools && req.tools.length` gate
 * (`"hi".length > 0`) and then throws on `.map` — a 500 instead of a 400.
 * Returns an error detail string, or null when absent or a valid array.
 */
export function validateToolsField(tools: unknown): string | null {
  if (tools !== undefined && tools !== null && !Array.isArray(tools)) {
    return "tools must be an array";
  }
  if (Array.isArray(tools)) {
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i] as Record<string, unknown> | null;
      if (t === null || typeof t !== "object" || Array.isArray(t)) {
        return `tools[${i}] must be an object`;
      }
    }
  }
  return null;
}

// ─── Request body helpers ──────────────────────────────────────────────────

/**
 * True when a parsed JSON request body is a plain object.
 *
 * `JSON.parse("null")` yields `null`, and `"123"` / `"\"hi\""` yield
 * non-objects — every handler that then reads `body.field` throws a TypeError
 * that surfaces as a 500. Call this right after `JSON.parse` and answer 400
 * ("Request body must be a JSON object") instead. Arrays are rejected too:
 * `[].field` reads as `undefined` today, which degrades into a misleading
 * "missing parameter" 400 — rejecting up front names the real problem.
 */
export function isJsonObject(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

// ─── Embedding helpers ─────────────────────────────────────────────────────

const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/**
 * Maximum embedding dimensions accepted by POST /v1/embeddings.
 *
 * A serialization budget, not an allocation bound. The ECMAScript array-length
 * bound (2**32 - 1) is where `new Array(n)` throws RangeError, but the handler
 * does not stop at allocating: `generateDeterministicEmbedding` fills the array
 * and the response is JSON-serialized, so at that bound a single request aborts
 * the process ("FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript
 * heap out of memory") before any response is written — taking every other test
 * sharing the server with it. A cap the server cannot serve is not a cap.
 *
 * Derivation, measured on this tree: a response body costs 19.58 bytes per
 * dimension (4096 -> 80,456 B; 100,000 -> 1,958,539 B; 1,000,000 ->
 * 19,583,034 B). At 100,000 the body is ~1.96 MB, built in 7 ms at 83 MB RSS
 * under a 1 GB heap — comfortably serviceable.
 *
 * Deliberately still not a model width: /v1/embeddings also serves Azure and
 * every OpenAI-compatible server routed through COMPAT_SUFFIXES, where
 * 4096-dimension models are ordinary. 100,000 leaves >12x headroom over the
 * widest width in circulation while keeping every accepted request answerable.
 */
export const MAX_EMBEDDING_DIMENSIONS = 100_000;

/**
 * Validate an embeddings `dimensions` parameter.
 * Returns the effective dimensions (default 1536) or null when invalid.
 * Valid: undefined/null (→ default), integer in [1, MAX_EMBEDDING_DIMENSIONS].
 */
export function validateEmbeddingDimensions(raw: unknown): number | null {
  // null means "unset" too — the previous code was `dimensions ?? 1536`.
  if (raw === undefined || raw === null) return 1536;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  if (raw < 1 || raw > MAX_EMBEDDING_DIMENSIONS) return null;
  return raw;
}

/**
 * Normalize an embeddings `input` into the texts to embed.
 * Accepts every shape EmbeddingCreateParams.input declares
 * (openai/resources/embeddings.d.ts): `string | string[] | number[] | number[][]`,
 * the last two being pre-tokenized input. Returns null for shapes the API
 * rejects (non-string scalars, objects, mixed arrays).
 */
export function normalizeEmbeddingInput(raw: unknown): string[] | null {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) {
    if (raw.every((el) => typeof el === "string")) return raw as string[];
    // number[] — one pre-tokenized input.
    if (raw.every((el) => typeof el === "number")) return [raw.join(" ")];
    // number[][] — a batch of pre-tokenized inputs.
    if (raw.every((el) => Array.isArray(el) && el.every((t) => typeof t === "number"))) {
      return (raw as number[][]).map((tokens) => tokens.join(" "));
    }
    return null;
  }
  return null;
}

/**
 * Normalize a free-text field (moderation input, search/rerank query).
 * Accepts a string, or any array — joined with " " as before, so no array that
 * used to return 200 starts failing, and ModerationCreateParams' multimodal
 * parts (openai/resources/moderations.d.ts) contribute their `.text`. Returns
 * null only for non-string, non-array values, which used to 500.
 */
export function normalizeTextInput(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((el) => {
        if (typeof el === "string") return el;
        if (el === null || el === undefined) return "";
        if (typeof el === "object") {
          const part = el as { type?: unknown; text?: unknown };
          return part.type === "text" && typeof part.text === "string" ? part.text : "";
        }
        return String(el);
      })
      .join(" ");
  }
  return null;
}

/**
 * Generate a deterministic embedding vector from input text.
 * Hashes the input with SHA-256 and spreads the hash bytes across
 * the requested number of dimensions, producing values in [-1, 1].
 */
export function generateDeterministicEmbedding(
  input: string,
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): number[] {
  let currentHash = createHash("sha256").update(input).digest();
  const embedding: number[] = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    if (i > 0 && i % 32 === 0) {
      currentHash = createHash("sha256").update(currentHash).digest();
    }
    // Map 0-255 → -1.0 to 1.0
    embedding[i] = currentHash[i % 32] / 127.5 - 1;
  }
  return embedding;
}

export interface EmbeddingAPIResponse {
  object: "list";
  data: { object: "embedding"; index: number; embedding: number[] }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Build an OpenAI-format embeddings API response for one or more inputs.
 */
export function buildEmbeddingResponse(
  embeddings: number[][],
  model: string,
  usage?: { prompt_tokens?: number; total_tokens?: number },
): EmbeddingAPIResponse {
  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({
      object: "embedding" as const,
      index,
      embedding,
    })),
    model,
    usage: { prompt_tokens: usage?.prompt_tokens ?? 0, total_tokens: usage?.total_tokens ?? 0 },
  };
}

/**
 * Build a stable, human-readable identifier for a fixture's match shape, for
 * any log line that has to name WHICH fixture it means. The `Fixture` type
 * carries no `id`/`name`, so the matchers are the only handle a reader has.
 *
 * Used by the relaxed-turnIndex warning (`router.ts`) and by the chaos
 * rejected-value warning (`chaos.ts`); one implementation so the two name the
 * same fixture the same way. The obvious `JSON.stringify(match)` is unfit: it
 * DROPS `predicate` functions (non-serialisable) and serialises any RegExp
 * matcher to `{}`, so a predicate- or regex-gated fixture's warning collapsed to
 * an uninformative "served fixture {}" / `{"userMessage":{}}` blob.
 *
 * Instead we list the PRESENT matcher keys in declaration order, annotating each
 * by VALUE KIND so predicates and regexes survive: `predicate(fn)`,
 * `userMessage(regex)`, `userMessage("hello")`, `turnIndex=0`, etc. The
 * fixture's array `index` is prefixed as a stable positional identifier when
 * the caller knows it (i.e. `>= 0`); callers holding only the fixture object
 * pass `-1` and get the matcher summary alone. String/number values are shown
 * inline (truncated) so a content match remains recognisable; the whole string
 * is capped to keep the log line bounded.
 */
const DESCRIBE_MATCH_MAX = 160;

export function describeMatch(match: FixtureMatch, index: number): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(match)) {
    if (value === undefined) continue;
    if (typeof value === "function") {
      parts.push(key === "predicate" ? "[predicate]" : `${key}[fn]`);
    } else if (value instanceof RegExp) {
      parts.push(`${key}(${value})`);
    } else if (typeof value === "string") {
      const v = value.length > 40 ? `${value.slice(0, 40)}…` : value;
      parts.push(`${key}(${JSON.stringify(v)})`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}(${value.length} item${value.length === 1 ? "" : "s"})`);
    } else if (typeof value === "object" && value !== null) {
      // `String(obj)` is "[object Object]"; show the (bounded) JSON instead.
      const json = JSON.stringify(value);
      parts.push(`${key}(${json.length > 40 ? `${json.slice(0, 40)}…` : json})`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  const keys = parts.length > 0 ? parts.join(", ") : "no matchers";
  const prefix = index >= 0 ? `#${index} ` : "";
  const full = `${prefix}{ ${keys} }`;
  if (full.length <= DESCRIBE_MATCH_MAX) return full;
  // Cut at a matcher boundary (never mid-token) and mark the elision; a lone
  // oversized matcher is hard-cut but still marked.
  const head = full.slice(0, DESCRIBE_MATCH_MAX - 4);
  const cut = head.lastIndexOf(", ");
  return `${cut > 0 ? head.slice(0, cut) : head}, … }`;
}

// ─── MCP fakes: undeclared-tool override ────────────────────────────────────

/**
 * Parse an `X-AIMock-MCP-Undeclared` header or `?undeclared=` value.
 * Modeled on {@link resolveStrictMode}: case-insensitive, surrounding
 * whitespace trimmed. Returns `null` when unrecognised; unlike the strict
 * header, {@link resolveMcpIdentity} turns that into an error rather than a
 * fall-through, because falling through would turn a mistyped `deny` into
 * the permissive default.
 */
function parseMcpUndeclared(raw: string): McpFakeUndeclaredPolicy | null {
  const val = raw.trim().toLowerCase();
  if (val === "allow" || val === "deny") return val;
  return null;
}
