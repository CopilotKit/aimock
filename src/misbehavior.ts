import {
  isContentWithToolCallsResponse,
  isErrorResponse,
  isTextResponse,
  isToolCallResponse,
  resolveFixtureBlockOutcome,
  resolveTestId,
  toolArgsForWire,
} from "./helpers.js";
import { parseChaosNumber } from "./chaos.js";
import type {
  ChatCompletionRequest,
  ContentWithToolCallsResponse,
  Fixture,
  FixtureBlock,
  FixtureResponse,
  HandlerDefaults,
  JournalEntry,
  MisbehaviorConfig,
  MisbehaviorFault,
  MisbehaviorFaultId,
  WireId,
} from "./types.js";

/** Internal preparation contract; selection and firing belong to the planner. */
export interface MisbehaviorCandidateContext {
  wire: WireId;
  response: FixtureResponse;
  request: ChatCompletionRequest;
  stream: boolean;
  /** Actual selected output mode capability; required by K4 preparation. */
  emitsToolCallIds?: boolean;
  /** Current normal output emits only nonempty authored IDs, evaluated per target. */
  toolCallIdMode?: "authored-nonempty";
}

export interface MisbehaviorCandidate {
  response: FixtureResponse;
  stop?: "tool_calls" | "stop" | "length" | "content_filter" | "refusal";
  target?: { tool: string; index: number };
  detail?: string;
  refusal?: string;
  refusalCategory?: string | null;
  reasoning?: string;
  duplicateId?: { sourceIndex: number; destinationIndex: number };
}

export type MisbehaviorCandidateResult =
  | { kind: "ready"; candidate: MisbehaviorCandidate }
  | { kind: "not-applicable"; detail: string };

/** Direct constraints only; refs and applicators are deliberately not evaluated. */
export interface DirectToolSchema {
  properties: Record<string, unknown>;
  required: readonly string[];
  additionalProperties?: unknown;
  patternProperties?: Record<string, unknown>;
}

function normalizeDirectConstraints(schema: unknown): DirectToolSchema | undefined {
  if (!isObject(schema)) return undefined;
  if (schema.properties !== undefined && !isObject(schema.properties)) return undefined;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === "string"))
  )
    return undefined;
  if (schema.patternProperties !== undefined && !isObject(schema.patternProperties))
    return undefined;
  return {
    properties: schema.properties ?? {},
    required: schema.required ?? [],
    ...(Object.hasOwn(schema, "additionalProperties")
      ? { additionalProperties: schema.additionalProperties }
      : {}),
    ...(schema.patternProperties !== undefined
      ? { patternProperties: schema.patternProperties }
      : {}),
  };
}

interface MisbehaviorSchemaInput {
  readonly tools?: readonly unknown[];
}

/** Private tools-only input also permits native Cohere definitions before adaptation. */
export function normalizeDirectToolSchema(
  request: MisbehaviorSchemaInput,
  toolName: string,
): DirectToolSchema | undefined {
  for (const tool of request.tools ?? []) {
    if (!isObject(tool)) continue;
    if (tool.type === "function" && isObject(tool.function) && tool.function.name === toolName) {
      return normalizeDirectConstraints(tool.function.parameters);
    }
    if (tool.name !== toolName || !Object.hasOwn(tool, "parameter_definitions")) continue;
    const definitions = tool.parameter_definitions;
    if (!isObject(definitions)) return undefined;
    const required: string[] = [];
    for (const [name, definition] of Object.entries(definitions)) {
      if (!isObject(definition)) return undefined;
      if (definition.required !== undefined && typeof definition.required !== "boolean")
        return undefined;
      if (definition.required === true) required.push(name);
    }
    return { properties: definitions, required };
  }
  return undefined;
}

export type DirectJSONType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "null";

function normalizeDirectType(value: unknown): DirectJSONType | undefined {
  if (typeof value !== "string") return undefined;
  const type = value.toLowerCase();
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "array":
    case "object":
    case "null":
      return type;
    default:
      return undefined;
  }
}

export function directPropertyTypes(
  propertySchema: unknown,
): readonly DirectJSONType[] | undefined {
  if (!isObject(propertySchema)) return undefined;
  const rawTypes = Array.isArray(propertySchema.type) ? propertySchema.type : [propertySchema.type];
  if (rawTypes.length === 0) return undefined;
  const types: DirectJSONType[] = [];
  for (const rawType of rawTypes) {
    const type = normalizeDirectType(rawType);
    // Dropping an unknown union member could incorrectly prove a value invalid.
    if (type === undefined) return undefined;
    types.push(type);
  }
  return types;
}

export function acceptsDirectType(value: unknown, type: DirectJSONType): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}

function invalidJsonArguments(
  canonical: string,
  style: NonNullable<Extract<MisbehaviorFault, { fault: "tool-args-invalid-json" }>["style"]>,
): string | undefined {
  let candidate = canonical;
  if (style === "truncated")
    candidate = canonical.slice(0, Math.max(1, Math.floor(canonical.length / 2)));
  else if (style === "trailing-comma" && canonical.endsWith("}"))
    candidate = `${canonical.slice(0, -1)},}`;
  else if (style === "single-quotes") {
    // Consume escape pairs before delimiters, preserving quoted string content.
    candidate = canonical.replace(/\\[\s\S]|"/g, (token) => (token === '"' ? "'" : token));
  }
  if (candidate === canonical) return undefined;
  try {
    JSON.parse(candidate);
    return undefined;
  } catch {
    return candidate;
  }
}

/** Prepare K1 without selecting a fault, spending counters, or mutating input. */
export function prepareInvalidJsonCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "tool-args-invalid-json" }>,
): MisbehaviorCandidateResult {
  const response = context.response;
  const combined = isContentWithToolCallsResponse(response);
  if (isErrorResponse(response) || !(combined || isToolCallResponse(response)))
    return { kind: "not-applicable", detail: "Response has no tool calls" };
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls = outcome?.toolCalls ?? response.toolCalls ?? [];
  const index = fault.tool === undefined ? 0 : calls.findIndex((call) => call.name === fault.tool);
  const target = calls[index];
  if (!target) return { kind: "not-applicable", detail: "Target tool call is absent" };
  const args = toolArgsForWire(target);
  const canonical = args.kind === "parsed" ? args.text : args.raw;
  const style = fault.style ?? MISBEHAVIOR_CATALOG[fault.fault].defaults.style;
  const argumentsText = invalidJsonArguments(canonical, style);
  if (argumentsText === undefined)
    return { kind: "not-applicable", detail: `${style} cannot produce changed invalid JSON` };
  const toolCalls = calls.map((call, callIndex) => ({
    ...call,
    ...(callIndex === index ? { arguments: argumentsText } : {}),
  }));
  let rewritten: FixtureResponse = { ...response, toolCalls };
  if (outcome) {
    let callIndex = 0;
    const blocks = outcome.ordered.map((block) => {
      if (block.type === "text") return { ...block };
      return { ...block, arguments: toolCalls[callIndex++].arguments };
    });
    rewritten = { ...response, content: outcome.content, toolCalls, blocks };
  }
  return {
    kind: "ready",
    candidate: { response: rewritten, target: { tool: target.name, index }, detail: style },
  };
}

/** Prepare K2 missing-required without selecting a fault or spending counters. */
export function prepareMissingRequiredCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "tool-args-schema-violation" }>,
): MisbehaviorCandidateResult {
  const response = context.response;
  const combined = isContentWithToolCallsResponse(response);
  if (isErrorResponse(response) || !(combined || isToolCallResponse(response)))
    return { kind: "not-applicable", detail: "Response has no tool calls" };
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls = outcome?.toolCalls ?? response.toolCalls ?? [];
  const index = fault.tool === undefined ? 0 : calls.findIndex((call) => call.name === fault.tool);
  const target = calls[index];
  if (!target) return { kind: "not-applicable", detail: "Target tool call is absent" };
  const args = toolArgsForWire(target);
  if (args.kind !== "parsed" || !isObject(args.value))
    return { kind: "not-applicable", detail: "Arguments must parse to an object" };
  const value = args.value;
  const schema = normalizeDirectToolSchema(context.request, target.name);
  if (!schema) return { kind: "not-applicable", detail: "Target tool has no direct schema" };
  const property = fault.property ?? schema.required.find((name) => Object.hasOwn(value, name));
  if (
    property === undefined ||
    !schema.required.includes(property) ||
    !Object.hasOwn(value, property)
  )
    return { kind: "not-applicable", detail: "No present required property can be removed" };
  const copied = { ...value };
  delete copied[property];
  const argumentsText = JSON.stringify(copied);
  const toolCalls = calls.map((call, callIndex) => ({
    ...call,
    ...(callIndex === index ? { arguments: argumentsText } : {}),
  }));
  let rewritten: FixtureResponse = { ...response, toolCalls };
  if (outcome) {
    let callIndex = 0;
    const blocks = outcome.ordered.map((block) => {
      if (block.type === "text") return { ...block };
      return { ...block, arguments: toolCalls[callIndex++].arguments };
    });
    rewritten = { ...response, content: outcome.content, toolCalls, blocks };
  }
  return {
    kind: "ready",
    candidate: {
      response: rewritten,
      target: { tool: target.name, index },
      detail: "missing-required",
    },
  };
}

function wrongTypeReplacement(type: DirectJSONType): unknown {
  switch (type) {
    case "string":
    case "null":
      return 12345;
    case "number":
    case "integer":
      return "not-a-number";
    case "boolean":
      return "true";
    case "array":
      return {};
    case "object":
      return "[object]";
  }
}

/** Prepare K2 wrong-type without selecting a fault or spending counters. */
export function prepareWrongTypeCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "tool-args-schema-violation" }>,
): MisbehaviorCandidateResult {
  const response = context.response;
  const combined = isContentWithToolCallsResponse(response);
  if (isErrorResponse(response) || !(combined || isToolCallResponse(response)))
    return { kind: "not-applicable", detail: "Response has no tool calls" };
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls = outcome?.toolCalls ?? response.toolCalls ?? [];
  const index = fault.tool === undefined ? 0 : calls.findIndex((call) => call.name === fault.tool);
  const target = calls[index];
  if (!target) return { kind: "not-applicable", detail: "Target tool call is absent" };
  const args = toolArgsForWire(target);
  if (args.kind !== "parsed" || !isObject(args.value))
    return { kind: "not-applicable", detail: "Arguments must parse to an object" };
  const value = args.value;
  const schema = normalizeDirectToolSchema(context.request, target.name);
  if (!schema) return { kind: "not-applicable", detail: "Target tool has no direct schema" };
  const names = fault.property === undefined ? Object.keys(schema.properties) : [fault.property];
  let mutation: { property: string; replacement: unknown } | undefined;
  for (const property of names) {
    if (!Object.hasOwn(value, property) || !Object.hasOwn(schema.properties, property)) continue;
    const propertySchema = schema.properties[property];
    const types = directPropertyTypes(propertySchema);
    if (!types) continue;
    // Scalar types keep their named replacement; unions use catalog order.
    const replacements: unknown[] = !(
      isObject(propertySchema) && Array.isArray(propertySchema.type)
    )
      ? [wrongTypeReplacement(types[0])]
      : [12345, "not-a-number", "true", {}, "[object]", null];
    const replacement = replacements.find((candidate) =>
      types.every((type) => !acceptsDirectType(candidate, type)),
    );
    if (
      replacement === undefined ||
      JSON.stringify(replacement) === JSON.stringify(value[property])
    )
      continue;
    mutation = { property, replacement };
    break;
  }
  if (!mutation)
    return {
      kind: "not-applicable",
      detail: "No present declared property has a provably wrong replacement",
    };
  const argumentsText = JSON.stringify({ ...value, [mutation.property]: mutation.replacement });
  const toolCalls = calls.map((call, callIndex) => ({
    ...call,
    ...(callIndex === index ? { arguments: argumentsText } : {}),
  }));
  let rewritten: FixtureResponse = { ...response, toolCalls };
  if (outcome) {
    let callIndex = 0;
    const blocks = outcome.ordered.map((block) => {
      if (block.type === "text") return { ...block };
      return { ...block, arguments: toolCalls[callIndex++].arguments };
    });
    rewritten = { ...response, content: outcome.content, toolCalls, blocks };
  }
  return {
    kind: "ready",
    candidate: {
      response: rewritten,
      target: { tool: target.name, index },
      detail: "wrong-type",
    },
  };
}

/** Prepare K2 extra-property only when direct constraints prove the addition invalid. */
export function prepareExtraPropertyCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "tool-args-schema-violation" }>,
): MisbehaviorCandidateResult {
  const response = context.response;
  const combined = isContentWithToolCallsResponse(response);
  if (isErrorResponse(response) || !(combined || isToolCallResponse(response)))
    return { kind: "not-applicable", detail: "Response has no tool calls" };
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls = outcome?.toolCalls ?? response.toolCalls ?? [];
  const index = fault.tool === undefined ? 0 : calls.findIndex((call) => call.name === fault.tool);
  const target = calls[index];
  if (!target) return { kind: "not-applicable", detail: "Target tool call is absent" };
  const args = toolArgsForWire(target);
  if (args.kind !== "parsed" || !isObject(args.value))
    return { kind: "not-applicable", detail: "Arguments must parse to an object" };
  const value = args.value;
  const schema = normalizeDirectToolSchema(context.request, target.name);
  if (!schema || schema.additionalProperties !== false)
    return {
      kind: "not-applicable",
      detail: "Target schema does not forbid additional properties",
    };
  const property = fault.property ?? "__aimock_extra";
  if (Object.hasOwn(schema.properties, property) || Object.hasOwn(value, property))
    return { kind: "not-applicable", detail: "Extra property name is already declared or present" };
  for (const [pattern, patternSchema] of Object.entries(schema.patternProperties ?? {})) {
    try {
      // A literal-false pattern directly forbids the value; other matching schemas remain unproven.
      if (new RegExp(pattern).test(property) && patternSchema !== false)
        return { kind: "not-applicable", detail: "A pattern covers the extra property name" };
    } catch {
      return { kind: "not-applicable", detail: "A property pattern cannot be evaluated" };
    }
  }
  const argumentsText = JSON.stringify({ ...value, [property]: true });
  const toolCalls = calls.map((call, callIndex) => ({
    ...call,
    ...(callIndex === index ? { arguments: argumentsText } : {}),
  }));
  let rewritten: FixtureResponse = { ...response, toolCalls };
  if (outcome) {
    let callIndex = 0;
    const blocks = outcome.ordered.map((block) => {
      if (block.type === "text") return { ...block };
      return { ...block, arguments: toolCalls[callIndex++].arguments };
    });
    rewritten = { ...response, content: outcome.content, toolCalls, blocks };
  }
  return {
    kind: "ready",
    candidate: {
      response: rewritten,
      target: { tool: target.name, index },
      detail: "extra-property",
    },
  };
}

/** Prepare K2 enum-mismatch without selecting a fault or spending counters. */
export function prepareEnumMismatchCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "tool-args-schema-violation" }>,
): MisbehaviorCandidateResult {
  const response = context.response;
  const combined = isContentWithToolCallsResponse(response);
  if (isErrorResponse(response) || !(combined || isToolCallResponse(response)))
    return { kind: "not-applicable", detail: "Response has no tool calls" };
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls = outcome?.toolCalls ?? response.toolCalls ?? [];
  const index = fault.tool === undefined ? 0 : calls.findIndex((call) => call.name === fault.tool);
  const target = calls[index];
  if (!target) return { kind: "not-applicable", detail: "Target tool call is absent" };
  const args = toolArgsForWire(target);
  if (args.kind !== "parsed" || !isObject(args.value))
    return { kind: "not-applicable", detail: "Arguments must parse to an object" };
  const value = args.value;
  const schema = normalizeDirectToolSchema(context.request, target.name);
  if (!schema) return { kind: "not-applicable", detail: "Target tool has no direct schema" };
  const names = fault.property === undefined ? Object.keys(schema.properties) : [fault.property];
  let mutation: { property: string; replacement: unknown } | undefined;
  for (const property of names) {
    if (!Object.hasOwn(value, property) || !Object.hasOwn(schema.properties, property)) continue;
    const propertySchema = schema.properties[property];
    if (!isObject(propertySchema) || !Array.isArray(propertySchema.enum)) continue;
    let replacement = "__aimock_not_in_enum";
    let suffix = 2;
    while (propertySchema.enum.includes(replacement)) {
      replacement = `__aimock_not_in_enum_${suffix++}`;
    }
    if (replacement === value[property]) continue;
    mutation = { property, replacement };
    break;
  }
  if (!mutation)
    return {
      kind: "not-applicable",
      detail: "No present declared enum property has a changed out-of-enum replacement",
    };
  const argumentsText = JSON.stringify({ ...value, [mutation.property]: mutation.replacement });
  const toolCalls = calls.map((call, callIndex) => ({
    ...call,
    ...(callIndex === index ? { arguments: argumentsText } : {}),
  }));
  let rewritten: FixtureResponse = { ...response, toolCalls };
  if (outcome) {
    let callIndex = 0;
    const blocks = outcome.ordered.map((block) => {
      if (block.type === "text") return { ...block };
      return { ...block, arguments: toolCalls[callIndex++].arguments };
    });
    rewritten = { ...response, content: outcome.content, toolCalls, blocks };
  }
  return {
    kind: "ready",
    candidate: {
      response: rewritten,
      target: { tool: target.name, index },
      detail: "enum-mismatch",
    },
  };
}

/** Prepare K2 not-object without selecting a fault or spending counters. */
export function prepareNotObjectCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "tool-args-schema-violation" }>,
): MisbehaviorCandidateResult {
  if (!supportsMisbehavior(context.wire, { ...fault, violation: "not-object" }, context.stream))
    return { kind: "not-applicable", detail: "not-object is unsupported on this wire/output mode" };
  const response = context.response;
  const combined = isContentWithToolCallsResponse(response);
  if (isErrorResponse(response) || !(combined || isToolCallResponse(response)))
    return { kind: "not-applicable", detail: "Response has no tool calls" };
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls = outcome?.toolCalls ?? response.toolCalls ?? [];
  const index = fault.tool === undefined ? 0 : calls.findIndex((call) => call.name === fault.tool);
  const target = calls[index];
  if (!target) return { kind: "not-applicable", detail: "Target tool call is absent" };
  const args = toolArgsForWire(target);
  if (args.kind !== "parsed" || !isObject(args.value))
    return { kind: "not-applicable", detail: "Arguments must parse to an object" };
  const argumentsText = JSON.stringify(args.text);
  const toolCalls = calls.map((call, callIndex) => ({
    ...call,
    ...(callIndex === index ? { arguments: argumentsText } : {}),
  }));
  let rewritten: FixtureResponse = { ...response, toolCalls };
  if (outcome) {
    let callIndex = 0;
    const blocks = outcome.ordered.map((block) => {
      if (block.type === "text") return { ...block };
      return { ...block, arguments: toolCalls[callIndex++].arguments };
    });
    rewritten = { ...response, content: outcome.content, toolCalls, blocks };
  }
  return {
    kind: "ready",
    candidate: {
      response: rewritten,
      target: { tool: target.name, index },
      detail: "not-object",
    },
  };
}

const fixtureMisbehaviorPositions = new WeakMap<Fixture, string>();

export function setFixtureMisbehaviorPosition(fixture: Fixture, position: string): void {
  fixtureMisbehaviorPositions.set(fixture, position);
}

export function getFixtureMisbehaviorPosition(fixture: Fixture): string | undefined {
  return fixtureMisbehaviorPositions.get(fixture);
}

export function copyFixtureMisbehaviorPosition(from: Fixture, to: Fixture): void {
  const position = getFixtureMisbehaviorPosition(from);
  if (position !== undefined) setFixtureMisbehaviorPosition(to, position);
}

/** Shared by fixture identity and the seeded planner; hash UTF-8 bytes, not UTF-16 units. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash >>> 0;
}

/** Canonicalize the declared match/config domain without shortening strings or arrays. */
function canonicalIdentityValue(value: unknown): unknown {
  if (value instanceof RegExp) return { $regexp: value.toString() };
  if (typeof value === "function") return "fn";
  if (Array.isArray(value)) return value.map(canonicalIdentityValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalIdentityValue(child)]),
    );
  }
  return value;
}

/** Ingress must assign a logical load/addition position before planning a fixture fault. */
export function fixtureMisbehaviorSourceKey(fixture: Fixture, config: MisbehaviorConfig): string {
  const position = getFixtureMisbehaviorPosition(fixture);
  if (!position) throw new Error("Missing fixture misbehavior position: internal invariant");
  const canonicalMatch = JSON.stringify(canonicalIdentityValue(fixture.match));
  const seedlessConfig = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== "seed"),
  );
  const canonicalConfig = JSON.stringify(canonicalIdentityValue(seedlessConfig));
  return `fixture:${fnv1a32(`${canonicalMatch}|${canonicalConfig}|${position}`)}`;
}

export type MisbehaviorRule =
  | "misbehavior/unknown-key"
  | "misbehavior/bad-value"
  | "misbehavior/not-applicable"
  | "misbehavior/unsupported-on-wire";
export interface MisbehaviorIssue {
  rule: MisbehaviorRule;
  path: string;
  value: unknown;
  message: string;
}
export type MisbehaviorParseResult =
  | { ok: true; config: MisbehaviorConfig }
  | { ok: false; issue: MisbehaviorIssue };

type ValueCheck = (value: unknown) => boolean;
const string: ValueCheck = (value) => typeof value === "string";
const finite: ValueCheck = (value) => typeof value === "number" && Number.isFinite(value);
const choices =
  (...values: string[]): ValueCheck =>
  (value) =>
    typeof value === "string" && values.includes(value);

/** Single catalog for accepted parameters and their defaults. Defaults are applied by the planner. */
export const MISBEHAVIOR_CATALOG = {
  "tool-args-invalid-json": {
    parameters: { style: choices("truncated", "trailing-comma", "single-quotes") },
    defaults: { style: "truncated" },
  },
  "tool-args-schema-violation": {
    parameters: {
      violation: choices(
        "missing-required",
        "wrong-type",
        "extra-property",
        "enum-mismatch",
        "not-object",
      ),
      property: string,
    },
    defaults: { violation: "missing-required" },
  },
  "tool-unknown-name": { parameters: { name: string }, defaults: {} },
  "tool-call-id-duplicate": { parameters: {}, defaults: {} },
  "stop-length-mid-tool": {
    parameters: { at: (v: unknown) => typeof v === "number" && finite(v) && v > 0 && v < 1 },
    defaults: { at: 0.5 },
  },
  "empty-response": { parameters: {}, defaults: {} },
  refusal: {
    parameters: { message: string, category: (v: unknown) => v === null || string(v) },
    defaults: { message: "I can't help with that.", category: null },
  },
  "content-filter": { parameters: {}, defaults: {} },
  "reasoning-only": { parameters: { reasoning: string }, defaults: {} },
} as const satisfies Record<
  MisbehaviorFaultId,
  { parameters: Record<string, ValueCheck>; defaults: object }
>;

type FaultSupport = "yes" | "stream-only" | "n/a";
interface WireSupport {
  faults: Readonly<Record<MisbehaviorFaultId, FaultSupport>>;
  /** Explicit parameter restrictions even when the base fault is supported. */
  refusalCategory: boolean;
  notObject: { stream: boolean; nonstream: boolean };
}
/** Engine stage: all nine faults are supported only on OpenAI Chat. */
export const WIRE_SUPPORT: Readonly<Record<WireId, Readonly<WireSupport>>> = {
  "openai-chat": {
    faults: {
      "tool-args-invalid-json": "yes",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "yes",
      "empty-response": "yes",
      refusal: "yes",
      "content-filter": "yes",
      "reasoning-only": "yes",
    },
    refusalCategory: false,
    notObject: { stream: true, nonstream: true },
  },
  "openai-responses": {
    faults: {
      "tool-args-invalid-json": "yes",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "yes",
      "empty-response": "yes",
      refusal: "yes",
      "content-filter": "yes",
      "reasoning-only": "yes",
    },
    refusalCategory: false,
    notObject: { stream: true, nonstream: true },
  },
  "openai-realtime": {
    faults: {
      "tool-args-invalid-json": "yes",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "yes",
      "empty-response": "yes",
      refusal: "n/a",
      "content-filter": "yes",
      "reasoning-only": "n/a",
    },
    refusalCategory: false,
    notObject: { stream: true, nonstream: true },
  },
  anthropic: {
    faults: {
      "tool-args-invalid-json": "stream-only",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "yes",
      "empty-response": "yes",
      refusal: "yes",
      "content-filter": "n/a",
      "reasoning-only": "yes",
    },
    refusalCategory: true,
    notObject: { stream: true, nonstream: false },
  },
  "bedrock-invoke": {
    faults: {
      "tool-args-invalid-json": "stream-only",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "yes",
      "empty-response": "yes",
      refusal: "yes",
      "content-filter": "n/a",
      "reasoning-only": "yes",
    },
    refusalCategory: true,
    notObject: { stream: true, nonstream: false },
  },
  "bedrock-converse": {
    faults: {
      "tool-args-invalid-json": "yes",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "yes",
      "empty-response": "yes",
      refusal: "n/a",
      "content-filter": "yes",
      "reasoning-only": "yes",
    },
    refusalCategory: false,
    notObject: { stream: true, nonstream: false },
  },
  gemini: {
    faults: {
      "tool-args-invalid-json": "yes",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "yes",
      "empty-response": "yes",
      refusal: "n/a",
      "content-filter": "yes",
      "reasoning-only": "yes",
    },
    refusalCategory: false,
    notObject: { stream: false, nonstream: false },
  },
  "gemini-live": {
    faults: {
      "tool-args-invalid-json": "yes",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "n/a",
      "empty-response": "yes",
      refusal: "n/a",
      "content-filter": "n/a",
      "reasoning-only": "n/a",
    },
    refusalCategory: false,
    notObject: { stream: false, nonstream: false },
  },
  "gemini-interactions": {
    faults: {
      "tool-args-invalid-json": "stream-only",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "yes",
      "empty-response": "yes",
      refusal: "n/a",
      "content-filter": "n/a",
      "reasoning-only": "yes",
    },
    refusalCategory: false,
    notObject: { stream: true, nonstream: false },
  },
  cohere: {
    faults: {
      "tool-args-invalid-json": "yes",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "yes",
      "stop-length-mid-tool": "yes",
      "empty-response": "yes",
      refusal: "n/a",
      "content-filter": "n/a",
      "reasoning-only": "n/a",
    },
    refusalCategory: false,
    notObject: { stream: true, nonstream: true },
  },
  ollama: {
    faults: {
      "tool-args-invalid-json": "yes",
      "tool-args-schema-violation": "yes",
      "tool-unknown-name": "yes",
      "tool-call-id-duplicate": "n/a",
      "stop-length-mid-tool": "n/a",
      "empty-response": "yes",
      refusal: "n/a",
      "content-filter": "n/a",
      "reasoning-only": "yes",
    },
    refusalCategory: false,
    notObject: { stream: false, nonstream: false },
  },
};

export function supportsMisbehavior(
  wire: string,
  fault: MisbehaviorFault,
  stream: boolean,
): boolean {
  if (!isWireId(wire)) return false;
  const support = WIRE_SUPPORT[wire];
  const mode = stream ? "stream" : "nonstream";
  const base = support.faults[fault.fault];
  if (base === "n/a" || (base === "stream-only" && !stream)) return false;
  if (fault.fault === "refusal" && Object.hasOwn(fault, "category") && !support.refusalCategory)
    return false;
  return (
    fault.fault !== "tool-args-schema-violation" ||
    fault.violation !== "not-object" ||
    support.notObject[mode]
  );
}

function isWireId(value: unknown): value is WireId {
  return typeof value === "string" && Object.hasOwn(WIRE_SUPPORT, value);
}
function isFaultId(value: unknown): value is MisbehaviorFaultId {
  return typeof value === "string" && Object.hasOwn(MISBEHAVIOR_CATALOG, value);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
/** Error reporting must not invoke user-authored primitive conversion hooks. */
function describeInvalidValue(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? typeof value;
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "[unserializable value]";
  }
}
function failure(rule: MisbehaviorRule, path: string, value: unknown): MisbehaviorParseResult {
  return {
    ok: false,
    issue: {
      rule,
      path,
      value,
      message: `${rule} at ${path}: invalid value ${describeInvalidValue(value)}`,
    },
  };
}
const common: Record<string, ValueCheck> = {
  rate: (v) => parseChaosNumber(v, 1) !== undefined,
  times: (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
  tool: string,
  providers: (v) => Array.isArray(v),
};

/** Strict object/shorthand parser; wire applicability is evaluated after scope/provider selection. */
export function parseMisbehavior(input: unknown, path = "misbehavior"): MisbehaviorParseResult {
  if (typeof input === "string") {
    return isFaultId(input)
      ? { ok: true, config: { faults: [{ fault: input }] } }
      : failure("misbehavior/bad-value", path, input);
  }
  if (!isObject(input)) return failure("misbehavior/bad-value", path, input);
  for (const key of Object.keys(input)) {
    if (key !== "seed" && key !== "faults")
      return failure("misbehavior/unknown-key", `${path}.${key}`, input[key]);
  }
  if (
    Object.hasOwn(input, "seed") &&
    input.seed !== "random" &&
    !(typeof input.seed === "number" && Number.isInteger(input.seed))
  ) {
    return failure("misbehavior/bad-value", `${path}.seed`, input.seed);
  }
  if (!Array.isArray(input.faults))
    return failure("misbehavior/bad-value", `${path}.faults`, input.faults);
  const faults: MisbehaviorFault[] = [];
  for (let index = 0; index < input.faults.length; index++) {
    const entry: unknown = input.faults[index];
    const entryPath = `${path}.faults[${index}]`;
    if (!isObject(entry)) return failure("misbehavior/bad-value", entryPath, entry);
    if (!isFaultId(entry.fault))
      return failure("misbehavior/bad-value", `${entryPath}.fault`, entry.fault);
    const parameters: Readonly<Record<string, ValueCheck>> =
      MISBEHAVIOR_CATALOG[entry.fault].parameters;
    for (const key of Object.keys(entry)) {
      if (key === "fault") continue;
      const check = Object.hasOwn(common, key)
        ? common[key]
        : Object.hasOwn(parameters, key)
          ? parameters[key]
          : undefined;
      if (!check) return failure("misbehavior/unknown-key", `${entryPath}.${key}`, entry[key]);
      if (!check(entry[key]))
        return failure("misbehavior/bad-value", `${entryPath}.${key}`, entry[key]);
    }
    if (Array.isArray(entry.providers)) {
      for (let i = 0; i < entry.providers.length; i++) {
        if (!isWireId(entry.providers[i]))
          return failure(
            "misbehavior/bad-value",
            `${entryPath}.providers[${i}]`,
            entry.providers[i],
          );
      }
    }
    // Every own field and discriminant has been checked against the catalog above.
    // TypeScript cannot derive a discriminated union from that data-driven validation.
    faults.push({
      ...entry,
      ...(Object.hasOwn(entry, "rate") ? { rate: parseChaosNumber(entry.rate, 1) } : {}),
      ...(Array.isArray(entry.providers) ? { providers: [...entry.providers] } : {}),
    } as MisbehaviorFault);
  }
  return {
    ok: true,
    config: {
      ...(typeof input.seed === "number" || input.seed === "random" ? { seed: input.seed } : {}),
      faults,
    },
  };
}

/**
 * One fault followed by semicolon-delimited scalar key=value pairs. Values are
 * literal text: the first equals sign separates the key, with no unquoting.
 * Node's repeated-header comma joining must still parse as one whole grammar.
 */
export function parseMisbehaviorHeader(
  value: string | string[] | undefined,
): MisbehaviorParseResult | undefined {
  if (value === undefined) return undefined;
  const path = "headers.x-aimock-misbehavior";
  const text = Array.isArray(value) ? value.join(", ") : value;
  const [fault, ...pairs] = text.split(";").map((part) => part.trim());
  if (!isFaultId(fault)) return failure("misbehavior/bad-value", path, value);
  const entry: Record<string, unknown> = { fault };
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    const key = pair.slice(0, separator).trim();
    if (separator < 0 || !key) return failure("misbehavior/bad-value", path, pair);
    const fieldPath = `${path}.faults[0].${key}`;
    if (key === "fault" || key === "times" || key === "providers")
      return failure("misbehavior/unknown-key", fieldPath, pair);
    if (Object.hasOwn(entry, key)) return failure("misbehavior/bad-value", fieldPath, pair);
    const scalar = pair.slice(separator + 1).trim();
    // Only `at` needs conversion here; the shared config parser normalizes rate.
    // An invalid numeric spelling stays invalid, including an empty string.
    const parsed = key === "at" ? (parseChaosNumber(scalar, 1) ?? scalar) : scalar;
    Object.defineProperty(entry, key, { value: parsed, enumerable: true });
  }
  return parseMisbehavior({ faults: [entry] }, path);
}

/** Only statically decidable S3/S4 checks; no factories or request schemas are evaluated. */
export function validateFixtureMisbehavior(
  fixture: Fixture,
  path = "misbehavior",
): MisbehaviorIssue | undefined {
  if (fixture.misbehavior === undefined) return undefined;
  const parsed = parseMisbehavior(fixture.misbehavior, path);
  if (!parsed.ok) return parsed.issue;
  const endpoint = fixture.match.endpoint;
  const wires = Object.keys(WIRE_SUPPORT)
    .filter(isWireId)
    .filter((wire) =>
      endpoint === "realtime"
        ? wire === "openai-realtime"
        : endpoint === "chat"
          ? wire !== "openai-realtime"
          : true,
    );
  const nonchat = endpoint !== undefined && endpoint !== "chat" && endpoint !== "realtime";
  const response = fixture.response;
  for (const [index, fault] of parsed.config.faults.entries()) {
    const possible = wires.filter(
      (wire) => fault.providers === undefined || fault.providers.includes(wire),
    );
    if (possible.length === 0) continue;
    let reason: MisbehaviorRule | undefined;
    if (nonchat) reason = "misbehavior/not-applicable";
    else if (typeof response !== "function") {
      const combined = isContentWithToolCallsResponse(response);
      if (
        isErrorResponse(response) ||
        !(combined || isTextResponse(response) || isToolCallResponse(response))
      ) {
        reason = "misbehavior/not-applicable";
      } else {
        const calls =
          combined && response.blocks?.length
            ? resolveFixtureBlockOutcome(response.blocks).toolCalls
            : "toolCalls" in response
              ? (response.toolCalls ?? [])
              : [];
        const target =
          fault.tool === undefined ? calls[0] : calls.find((call) => call.name === fault.tool);
        const toolFault = fault.fault.startsWith("tool-") || fault.fault === "stop-length-mid-tool";
        if ((toolFault || fault.tool !== undefined) && !target)
          reason = "misbehavior/not-applicable";
        else if (target) {
          const args = toolArgsForWire(target);
          const canonical = args.kind === "parsed" ? args.text : args.raw;
          if (fault.fault === "tool-args-schema-violation") {
            if (
              args.kind !== "parsed" ||
              args.value === null ||
              typeof args.value !== "object" ||
              Array.isArray(args.value)
            ) {
              reason = "misbehavior/not-applicable";
            } else {
              const violation =
                fault.violation ?? MISBEHAVIOR_CATALOG[fault.fault].defaults.violation;
              // These prerequisites depend only on arguments. Schema eligibility stays request-time.
              if (violation === "extra-property") {
                if (Object.hasOwn(args.value, fault.property ?? "__aimock_extra")) {
                  reason = "misbehavior/not-applicable";
                }
              } else if (violation !== "not-object") {
                const hasTarget =
                  fault.property === undefined
                    ? Object.keys(args.value).length > 0
                    : Object.hasOwn(args.value, fault.property);
                if (!hasTarget) reason = "misbehavior/not-applicable";
              }
            }
          } else if (fault.fault === "stop-length-mid-tool") {
            const cut = Math.max(
              1,
              Math.floor(
                canonical.length * (fault.at ?? MISBEHAVIOR_CATALOG[fault.fault].defaults.at),
              ),
            );
            if (cut >= canonical.length) reason = "misbehavior/not-applicable";
          } else if (fault.fault === "tool-args-invalid-json") {
            const style = fault.style ?? MISBEHAVIOR_CATALOG[fault.fault].defaults.style;
            if (invalidJsonArguments(canonical, style) === undefined)
              reason = "misbehavior/not-applicable";
          }
        }
      }
    }
    if (
      !reason &&
      !possible.some(
        (wire) => supportsMisbehavior(wire, fault, false) || supportsMisbehavior(wire, fault, true),
      )
    ) {
      reason = "misbehavior/unsupported-on-wire";
    }
    if (reason) {
      const entryPath = `${path}.faults[${index}]`;
      return {
        rule: reason,
        path: entryPath,
        value: fault,
        message: `${reason} at ${entryPath}: ${fault.fault} cannot apply to this fixture`,
      };
    }
  }
  return undefined;
}

/** Prepare K3 without selecting a fault, spending counters, or mutating input. */
export function prepareUnknownNameCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "tool-unknown-name" }>,
): MisbehaviorCandidateResult {
  const response = context.response;
  const combined = isContentWithToolCallsResponse(response);
  if (isErrorResponse(response) || !(combined || isToolCallResponse(response)))
    return { kind: "not-applicable", detail: "Response has no tool calls" };
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls = outcome?.toolCalls ?? response.toolCalls ?? [];
  const index = fault.tool === undefined ? 0 : calls.findIndex((call) => call.name === fault.tool);
  const target = calls[index];
  if (!target) return { kind: "not-applicable", detail: "Target tool call is absent" };
  const declared = new Set((context.request.tools ?? []).map((tool) => tool.function.name));
  let name = fault.name ?? `${target.name}_v2`;
  if (fault.name !== undefined && declared.has(name))
    return {
      kind: "not-applicable",
      detail: "Explicit replacement tool name is declared in the request",
    };
  if (fault.name === undefined) {
    const base = name;
    for (let suffix = 2; declared.has(name); suffix++) name = `${base}_${suffix}`;
  }
  if (name === target.name)
    return { kind: "not-applicable", detail: "Replacement tool name is unchanged" };
  const toolCalls = calls.map((call, callIndex) => ({
    ...call,
    ...(callIndex === index ? { name } : {}),
  }));
  let rewritten: FixtureResponse = { ...response, toolCalls };
  if (outcome) {
    let callIndex = 0;
    const blocks = outcome.ordered.map((block) => {
      if (block.type === "text") return { ...block };
      return { ...block, name: toolCalls[callIndex++].name };
    });
    rewritten = { ...response, content: outcome.content, toolCalls, blocks };
  }
  return {
    kind: "ready",
    candidate: { response: rewritten, target: { tool: target.name, index }, detail: name },
  };
}

/** Prepare shared identity without allocating the renderer's opaque call IDs. */
export function prepareDuplicateIdCandidate(
  context: MisbehaviorCandidateContext &
    ({ emitsToolCallIds: boolean } | { toolCallIdMode: "authored-nonempty" }),
  fault: Extract<MisbehaviorFault, { fault: "tool-call-id-duplicate" }>,
): MisbehaviorCandidateResult {
  if (
    context.toolCallIdMode !== "authored-nonempty" &&
    typeof context.emitsToolCallIds !== "boolean"
  )
    throw new TypeError(
      "K4 preparation requires the selected output mode's emitsToolCallIds capability",
    );
  if (context.toolCallIdMode === undefined && !context.emitsToolCallIds)
    return { kind: "not-applicable", detail: "Current output mode does not emit tool call IDs" };
  const response = context.response;
  const combined = isContentWithToolCallsResponse(response);
  if (isErrorResponse(response) || !(combined || isToolCallResponse(response)))
    return { kind: "not-applicable", detail: "Response has no tool calls" };
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls = outcome?.toolCalls ?? response.toolCalls ?? [];
  const sourceIndex =
    fault.tool === undefined ? 0 : calls.findIndex((call) => call.name === fault.tool);
  const source = calls[sourceIndex];
  if (!source) return { kind: "not-applicable", detail: "Target tool call is absent" };
  if (context.toolCallIdMode === "authored-nonempty") {
    const emitsToolCallIds = Boolean(source.id);
    if (context.emitsToolCallIds !== undefined && context.emitsToolCallIds !== emitsToolCallIds)
      throw new Error("Conflicting current output ID capabilities: internal invariant");
    if (!emitsToolCallIds)
      return {
        kind: "not-applicable",
        detail: "Current output mode does not emit target tool call ID",
      };
  }
  const destinationIndex = calls.length === 1 ? 1 : (sourceIndex + 1) % calls.length;
  const toolCalls = calls.map((call) => ({ ...call }));
  if (calls.length === 1) toolCalls.push({ ...source });
  if (source.id === undefined) delete toolCalls[destinationIndex].id;
  else toolCalls[destinationIndex].id = source.id;
  let rewritten: FixtureResponse = { ...response, toolCalls };
  if (outcome) {
    let callIndex = 0;
    const blocks = outcome.ordered.flatMap<FixtureBlock>((block) => {
      if (block.type === "text") return [{ ...block }];
      const call = toolCalls[callIndex++];
      const rewrittenBlock = { ...block, ...call };
      if (call.id === undefined) delete rewrittenBlock.id;
      return calls.length === 1 ? [rewrittenBlock, { ...rewrittenBlock }] : [rewrittenBlock];
    });
    rewritten = { ...response, content: outcome.content, toolCalls, blocks };
  }
  return {
    kind: "ready",
    candidate: {
      response: rewritten,
      target: { tool: source.name, index: sourceIndex },
      duplicateId: { sourceIndex, destinationIndex },
    },
  };
}

/** Prepare a strict argument prefix without selecting a fault or spending counters. */
export function prepareLengthCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "stop-length-mid-tool" }>,
): MisbehaviorCandidateResult {
  const response = context.response;
  const combined = isContentWithToolCallsResponse(response);
  if (isErrorResponse(response) || !(combined || isToolCallResponse(response)))
    return { kind: "not-applicable", detail: "Response has no tool calls" };
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls = outcome?.toolCalls ?? response.toolCalls ?? [];
  const index = fault.tool === undefined ? 0 : calls.findIndex((call) => call.name === fault.tool);
  const target = calls[index];
  if (!target) return { kind: "not-applicable", detail: "Target tool call is absent" };
  const args = toolArgsForWire(target);
  const canonical = args.kind === "parsed" ? args.text : args.raw;
  const at = fault.at ?? MISBEHAVIOR_CATALOG[fault.fault].defaults.at;
  const cut = Math.max(1, Math.floor(canonical.length * at));
  if (canonical.length < 2 || !(cut < canonical.length))
    return { kind: "not-applicable", detail: "Arguments have no strict nonempty proper prefix" };
  const toolCalls = calls.slice(0, index + 1).map((call, callIndex) => ({
    ...call,
    ...(callIndex === index ? { arguments: canonical.slice(0, cut) } : {}),
  }));
  let rewritten: FixtureResponse = { ...response, toolCalls };
  if (outcome) {
    const blocks: FixtureBlock[] = [];
    let callIndex = 0;
    let content = "";
    for (const block of outcome.ordered) {
      if (block.type === "text") {
        content += block.text;
        blocks.push({ ...block });
      } else {
        blocks.push({ ...block, arguments: toolCalls[callIndex].arguments });
        if (callIndex++ === index) break;
      }
    }
    rewritten = { ...response, content, toolCalls, blocks };
  }
  return {
    kind: "ready",
    candidate: { response: rewritten, stop: "length", target: { tool: target.name, index } },
  };
}

/** Remove all chat output channels while preserving response metadata. */
function clearChatOutput(response: ContentWithToolCallsResponse): ContentWithToolCallsResponse {
  const cleared = { ...response, content: "" };
  delete cleared.blocks;
  delete cleared.toolCalls;
  delete cleared.reasoning;
  delete cleared.reasoningSignature;
  delete cleared.redactedThinking;
  delete cleared.webSearches;
  delete cleared.finishReason;
  delete cleared.nativeFinishReason;
  return cleared;
}

/** Prepare an empty normal completion without mutating the resolved response. */
export function prepareEmptyCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "empty-response" }>,
): MisbehaviorCandidateResult {
  const response = context.response;
  if (
    isErrorResponse(response) ||
    !(
      isContentWithToolCallsResponse(response) ||
      isTextResponse(response) ||
      isToolCallResponse(response)
    )
  )
    return { kind: "not-applicable", detail: "Response is not a chat response" };
  if (fault.tool !== undefined) {
    const calls =
      isContentWithToolCallsResponse(response) && response.blocks?.length
        ? resolveFixtureBlockOutcome(response.blocks).toolCalls
        : "toolCalls" in response
          ? (response.toolCalls ?? [])
          : [];
    if (!calls.some((call) => call.name === fault.tool))
      return { kind: "not-applicable", detail: "Target tool call is absent" };
  }
  return { kind: "ready", candidate: { response: clearChatOutput(response), stop: "stop" } };
}

/** Prepare structured refusal data; the planner checks support on the original fault. */
export function prepareRefusalCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "refusal" }>,
): MisbehaviorCandidateResult {
  const empty = prepareEmptyCandidate(context, { fault: "empty-response", tool: fault.tool });
  if (empty.kind !== "ready") return empty;
  return {
    kind: "ready",
    candidate: {
      response: empty.candidate.response,
      stop: "refusal",
      refusal: fault.message ?? MISBEHAVIOR_CATALOG.refusal.defaults.message,
      refusalCategory: fault.category ?? MISBEHAVIOR_CATALOG.refusal.defaults.category,
    },
  };
}

/** Prepare withheld output; the planner checks support on the original fault. */
export function prepareContentFilterCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "content-filter" }>,
): MisbehaviorCandidateResult {
  const empty = prepareEmptyCandidate(context, { fault: "empty-response", tool: fault.tool });
  if (empty.kind !== "ready") return empty;
  return {
    kind: "ready",
    candidate: { response: empty.candidate.response, stop: "content_filter" },
  };
}

/** Prepare reasoning-only output; the planner checks support on the original fault. */
export function prepareReasoningOnlyCandidate(
  context: MisbehaviorCandidateContext,
  fault: Extract<MisbehaviorFault, { fault: "reasoning-only" }>,
): MisbehaviorCandidateResult {
  const empty = prepareEmptyCandidate(context, { fault: "empty-response", tool: fault.tool });
  if (empty.kind !== "ready") return empty;
  const fixtureReasoning = "reasoning" in context.response ? context.response.reasoning : undefined;
  return {
    kind: "ready",
    candidate: {
      response: empty.candidate.response,
      stop: "length",
      reasoning: fault.reasoning ?? fixtureReasoning ?? "Thinking...",
    },
  };
}

/** Dispatch only after the planner has checked authored parameter/wire support. */
export function prepareMisbehaviorCandidate(
  context: MisbehaviorCandidateContext,
  fault: MisbehaviorFault,
): MisbehaviorCandidateResult {
  switch (fault.fault) {
    case "tool-args-invalid-json":
      return prepareInvalidJsonCandidate(context, fault);
    case "tool-args-schema-violation": {
      const violation = fault.violation ?? "missing-required";
      switch (violation) {
        case "missing-required":
          return prepareMissingRequiredCandidate(context, fault);
        case "wrong-type":
          return prepareWrongTypeCandidate(context, fault);
        case "extra-property":
          return prepareExtraPropertyCandidate(context, fault);
        case "enum-mismatch":
          return prepareEnumMismatchCandidate(context, fault);
        case "not-object":
          return prepareNotObjectCandidate(context, fault);
        default:
          return assertUnreachableMisbehavior(violation);
      }
    }
    case "tool-unknown-name":
      return prepareUnknownNameCandidate(context, fault);
    case "tool-call-id-duplicate": {
      if (context.toolCallIdMode === "authored-nonempty")
        return prepareDuplicateIdCandidate(
          { ...context, toolCallIdMode: context.toolCallIdMode },
          fault,
        );
      // OpenAI Chat's normal builders always emit IDs, including generated ones.
      const emitsToolCallIds = context.wire === "openai-chat" ? true : context.emitsToolCallIds;
      if (emitsToolCallIds === undefined)
        throw new Error("Missing current output ID capability: internal invariant");
      return prepareDuplicateIdCandidate({ ...context, emitsToolCallIds }, fault);
    }
    case "stop-length-mid-tool":
      return prepareLengthCandidate(context, fault);
    case "empty-response":
      return prepareEmptyCandidate(context, fault);
    case "refusal":
      return prepareRefusalCandidate(context, fault);
    case "content-filter":
      return prepareContentFilterCandidate(context, fault);
    case "reasoning-only":
      return prepareReasoningOnlyCandidate(context, fault);
    default:
      return assertUnreachableMisbehavior(fault);
  }
}

function assertUnreachableMisbehavior(value: never): never {
  throw new Error(`Unknown misbehavior candidate: ${String(value)}`);
}

export interface MisbehaviorEvaluation {
  entryIndex: number;
  fault: MisbehaviorFaultId;
  outcome: "applied" | "skipped" | "error";
  reason?:
    | "provider-excluded"
    | "not-applicable"
    | "unsupported-on-wire"
    | "times-exhausted"
    | "not-rolled";
  ordinal?: number;
}
export interface ServedMisbehaviorToolCall {
  name: string;
  arguments: string;
  id?: string;
}
export interface MisbehaviorSummary {
  applied: boolean;
  evaluations: MisbehaviorEvaluation[];
  source?: "header" | "fixture" | "scope" | "server";
  wire?: WireId;
  fault?: MisbehaviorFaultId;
  target?: { tool: string; index: number };
  detail?: string;
  ordinal?: number;
  reason?: MisbehaviorEvaluation["reason"] | "disabled" | "proxied" | "chaos-fired";
  /** Provider preparation must supply actual served calls before journaling an applied plan. */
  servedToolCalls?: ServedMisbehaviorToolCall[];
}
export interface MisbehaviorPlan extends MisbehaviorCandidate {
  kind: "applied";
  summary: MisbehaviorSummary;
}
export interface MisbehaviorSkip {
  kind: "skipped";
  summary?: MisbehaviorSummary;
}
export interface MisbehaviorError {
  kind: "error";
  status: 400 | 501;
  code:
    | "aimock_misbehavior_invalid"
    | "aimock_misbehavior_not_applicable"
    | "aimock_misbehavior_unsupported";
  message: string;
  summary?: MisbehaviorSummary;
}

let processMisbehaviorSeed: number | undefined;
/** Shared with config inspection so a random run can be replayed with this numeric seed. */
export function resolveMisbehaviorSeed(
  seed: MisbehaviorConfig["seed"],
  logger: HandlerDefaults["logger"],
): number {
  if (seed !== "random") return seed ?? 0;
  if (processMisbehaviorSeed === undefined) {
    processMisbehaviorSeed = Math.floor(Math.random() * 0x100000000);
    logger.info(`Misbehavior random seed: ${processMisbehaviorSeed}`);
  }
  return processMisbehaviorSeed;
}

function misbehaviorRoll(seed: number): number {
  let value = seed + 0x6d2b79f5;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

/** Complete preparation precedes selection; every candidate sees the original response. */
export function planMisbehavior(input: {
  wire: WireId;
  fixture: Fixture;
  response: FixtureResponse;
  request: ChatCompletionRequest;
  stream: boolean;
  emitsToolCallIds?: boolean;
  toolCallIdMode?: "authored-nonempty";
  /** False when this endpoint has no renderer for otherwise supported wire faults. */
  faultRenderingAvailable?: boolean;
  defaults: HandlerDefaults;
  rawHeaders: import("node:http").IncomingHttpHeaders;
  url: string | undefined;
}): MisbehaviorPlan | MisbehaviorSkip | MisbehaviorError {
  const { wire, fixture, defaults } = input;
  const testId = resolveTestId(input.rawHeaders, input.url);
  let source: NonNullable<MisbehaviorSummary["source"]>;
  let parsed = parseMisbehaviorHeader(input.rawHeaders["x-aimock-misbehavior"]);
  if (parsed !== undefined) source = "header";
  else if (fixture.misbehavior !== undefined) {
    source = "fixture";
    parsed = parseMisbehavior(fixture.misbehavior);
  } else if (defaults.misbehavior?.byTestId.has(testId)) {
    source = "scope";
    parsed = parseMisbehavior(defaults.misbehavior.byTestId.get(testId));
  } else if (defaults.misbehavior?.baseline !== undefined) {
    source = "server";
    parsed = parseMisbehavior(defaults.misbehavior.baseline);
  } else return { kind: "skipped" };
  if (!parsed.ok)
    return {
      kind: "error",
      status: source === "header" ? 400 : 501,
      code:
        source === "header" ? "aimock_misbehavior_invalid" : "aimock_misbehavior_not_applicable",
      message: `${wire}: ${parsed.issue.message}`,
      summary: { applied: false, source, wire, evaluations: [] },
    };
  const config = parsed.config;
  const explicit = source === "header" || source === "fixture";
  const evaluations: MisbehaviorEvaluation[] = [];
  const candidates = new Map<number, MisbehaviorCandidate>();
  const details = new Map<number, string>();
  const summaryFor = (row?: MisbehaviorEvaluation): MisbehaviorSummary => ({
    applied: row?.outcome === "applied",
    source,
    wire,
    evaluations: [...evaluations].sort((a, b) => a.entryIndex - b.entryIndex),
    ...(row
      ? {
          fault: row.fault,
          ...(row.reason !== undefined ? { reason: row.reason } : {}),
          ...(row.ordinal !== undefined ? { ordinal: row.ordinal } : {}),
          ...(details.has(row.entryIndex) ? { detail: details.get(row.entryIndex) } : {}),
        }
      : { reason: "disabled" }),
  });
  for (const [entryIndex, fault] of config.faults.entries()) {
    if (fault.providers !== undefined && !fault.providers.includes(wire)) {
      evaluations.push({
        entryIndex,
        fault: fault.fault,
        outcome: "skipped",
        reason: "provider-excluded",
      });
      continue;
    }
    let reason: MisbehaviorEvaluation["reason"];
    let detail: string | undefined;
    const response = input.response;
    const combined = isContentWithToolCallsResponse(response);
    if (
      isErrorResponse(response) ||
      !(combined || isTextResponse(response) || isToolCallResponse(response))
    ) {
      reason = "not-applicable";
      detail = "Response is not a chat response";
    } else if (
      input.faultRenderingAvailable === false ||
      !supportsMisbehavior(wire, fault, input.stream)
    ) {
      reason = "unsupported-on-wire";
      detail = "Fault or authored parameter is unsupported in this wire/output mode";
    } else {
      const prepared = prepareMisbehaviorCandidate(input, fault);
      if (prepared.kind === "ready") candidates.set(entryIndex, prepared.candidate);
      else {
        reason = "not-applicable";
        detail = prepared.detail;
      }
    }
    if (reason) {
      if (detail !== undefined) details.set(entryIndex, detail);
      const row: MisbehaviorEvaluation = {
        entryIndex,
        fault: fault.fault,
        outcome: explicit ? "error" : "skipped",
        reason,
      };
      evaluations.push(row);
      if (explicit)
        return {
          kind: "error",
          status: 501,
          code:
            reason === "unsupported-on-wire"
              ? "aimock_misbehavior_unsupported"
              : "aimock_misbehavior_not_applicable",
          message: `${fault.fault} on ${wire}: ${reason}: ${detail}`,
          summary: summaryFor(row),
        };
    }
  }
  if (candidates.size > 0) {
    const counters = defaults.misbehaviorCounters;
    if (!counters) throw new Error("Missing misbehavior journal counters: internal invariant");
    const sourceKey =
      source === "fixture"
        ? fixtureMisbehaviorSourceKey(fixture, config)
        : source === "scope"
          ? `scope:${testId}`
          : source;
    const seed = resolveMisbehaviorSeed(config.seed, defaults.logger);
    for (const [entryIndex, candidate] of candidates) {
      const fault = config.faults[entryIndex];
      const key = { testId, sourceKey, entryIndex };
      if (fault.times !== undefined && counters.getFiringCount(key) >= fault.times) {
        evaluations.push({
          entryIndex,
          fault: fault.fault,
          outcome: "skipped",
          reason: "times-exhausted",
        });
        continue;
      }
      const ordinal = counters.nextOrdinal(key);
      const roll = misbehaviorRoll(
        fnv1a32(`${seed}|${testId}|${sourceKey}|${entryIndex}|${ordinal}`),
      );
      if (roll >= (fault.rate ?? 1)) {
        evaluations.push({
          entryIndex,
          fault: fault.fault,
          outcome: "skipped",
          reason: "not-rolled",
          ordinal,
        });
        continue;
      }
      counters.recordFiring(key);
      const row: MisbehaviorEvaluation = {
        entryIndex,
        fault: fault.fault,
        outcome: "applied",
        ordinal,
      };
      evaluations.push(row);
      return {
        kind: "applied",
        ...candidate,
        summary: {
          ...summaryFor(row),
          ...(candidate.target !== undefined ? { target: candidate.target } : {}),
          ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
        },
      };
    }
  }
  const last = [...evaluations].sort((a, b) => a.entryIndex - b.entryIndex).at(-1);
  return { kind: "skipped", summary: summaryFor(last) };
}

// Entry identity, rather than request/test IDs, prevents duplicate observations
// when more than one response-finalization path sees the same request.
const recordedMisbehaviorEntries = new WeakSet<JournalEntry>();
const warnedUnsupportedMisbehavior = new WeakMap<HandlerDefaults["logger"], Set<string>>();

/** Record prepared output on the existing request; this is not a delivery receipt. */
export function recordMisbehaviorOutcome({
  entry,
  summary,
  defaults,
  testId,
}: {
  entry: JournalEntry;
  summary: MisbehaviorSummary | undefined;
  defaults: HandlerDefaults;
  testId: string;
}): void {
  if (!summary || recordedMisbehaviorEntries.has(entry)) return;
  if (summary.applied && !Array.isArray(summary.servedToolCalls)) {
    throw new Error("Applied misbehavior requires prepared servedToolCalls before journaling");
  }
  if (summary.evaluations.length > 0 && summary.wire === undefined) {
    throw new Error("Misbehavior evaluations require a wire before journaling");
  }

  entry.response.misbehavior = summary;
  recordedMisbehaviorEntries.add(entry);
  for (const evaluation of summary.evaluations) {
    // A wire is required only for evaluated rows; short circuits have none.
    if (summary.wire === undefined) continue;
    const outcome = evaluation.reason
      ? `${evaluation.outcome}:${evaluation.reason}`
      : evaluation.outcome;
    defaults.registry?.incrementCounter("aimock_misbehavior_total", {
      fault: evaluation.fault,
      wire: summary.wire,
      outcome,
    });
    const message = `[misbehavior] ${evaluation.fault} ${outcome} on ${summary.wire} (testId=${testId})`;
    if (evaluation.outcome === "error") {
      defaults.logger.error(message);
    } else if (evaluation.outcome === "applied") {
      defaults.logger.info(message);
    } else if (evaluation.reason === "unsupported-on-wire") {
      let warned = warnedUnsupportedMisbehavior.get(defaults.logger);
      if (!warned) {
        warned = new Set();
        warnedUnsupportedMisbehavior.set(defaults.logger, warned);
      }
      const key = JSON.stringify([testId, evaluation.fault, summary.wire]);
      if (!warned.has(key)) {
        warned.add(key);
        defaults.logger.warn(message);
      }
    } else {
      defaults.logger.debug(message);
    }
  }
}

/** Resolve configuration presence only; request boundaries validate headers before bypassing. */
export function resolveMisbehaviorShortCircuit(input: {
  wire: WireId;
  fixture?: Fixture;
  defaults: HandlerDefaults;
  rawHeaders: import("node:http").IncomingHttpHeaders;
  url: string | undefined;
  reason: "proxied" | "chaos-fired";
}): MisbehaviorSummary | undefined {
  const { wire, fixture, defaults, rawHeaders, url, reason } = input;
  const testId = resolveTestId(rawHeaders, url);
  let source: NonNullable<MisbehaviorSummary["source"]>;
  if (rawHeaders["x-aimock-misbehavior"] !== undefined) source = "header";
  else if (fixture?.misbehavior !== undefined) source = "fixture";
  else if (defaults.misbehavior?.byTestId.has(testId)) source = "scope";
  else if (defaults.misbehavior?.baseline !== undefined) source = "server";
  else return undefined;
  return { applied: false, source, wire, reason, evaluations: [] };
}
