import type {
  LiveFixtureResponse,
  LiveJson,
  LiveObject,
  LiveOptions,
  LivePosition,
  LiveTranscript,
} from "./live-types.js";

export const DEFAULT_LIVE_OPTIONS = Object.freeze({
  maxSessions: 16,
  maxMessageBytes: 1024 * 1024,
  maxBufferedBytes: 2 * 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxDecodedAudioBytes: 16 * 1024 * 1024,
  maxDurationMs: 120_000,
  idleTimeoutMs: 30_000,
  mismatchTimeoutMs: 30_000,
});

// Frozen from independently reviewed contract.v3.json (a2ccf050b464c2ca0cfb2f8e880b4976
// 17d2a028c5147662a1accbcbacd6339d). Additional JSON fields remain literal.
interface Shape {
  type?: string | string[];
  const?: LiveJson;
  enum?: LiveJson[];
  $ref?: string;
  anyOf?: Shape[];
  properties?: { [key: string]: Shape };
  required?: string[];
  items?: Shape;
  additionalProperties?: boolean;
}
const DEFINITIONS: { [key: string]: Shape } = {
  Pcm24: {
    type: "object",
    properties: { type: { const: "audio/pcm" }, rate: { const: 24000 } },
    required: ["type", "rate"],
    additionalProperties: true,
  },
  Voice: {
    anyOf: [
      { type: "string" },
      {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: true,
      },
    ],
  },
  Audio: {
    type: "object",
    properties: {
      format: { $ref: "#/$defs/Pcm24" },
      output: {
        type: "object",
        properties: { voice: { $ref: "#/$defs/Voice" } },
        required: [],
        additionalProperties: true,
      },
    },
    required: [],
    additionalProperties: true,
  },
  FunctionTool: {
    type: "object",
    properties: {
      type: { const: "function" },
      name: { type: "string" },
      description: { type: ["string", "null"] },
      parameters: { type: ["object", "null"] },
      strict: { type: ["boolean", "null"] },
    },
    required: ["type", "name"],
    additionalProperties: true,
  },
  Backend: {
    type: "object",
    properties: {
      model: { type: "string" },
      instructions: { type: ["string", "null"] },
      max_output_tokens: { type: ["number", "null"] },
      parallel_tool_calls: { type: ["boolean", "null"] },
      reasoning: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              effort: { enum: ["none", "minimal", "low", "medium", "high", "xhigh", null] },
              summary: { enum: ["concise", "detailed", "auto", null] },
            },
            required: [],
            additionalProperties: true,
          },
        ],
      },
      service_tier: {
        enum: ["auto", "default", "fast_tier_temp_pilot", "flex", "priority", "ultrafast", null],
      },
      text: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: { verbosity: { enum: ["low", "medium", "high", null] } },
            required: [],
            additionalProperties: true,
          },
        ],
      },
      tool_choice: {
        anyOf: [
          { enum: ["auto", "none", "required"] },
          {
            type: "object",
            properties: { type: { const: "function" }, name: { type: "string" } },
            required: ["type", "name"],
            additionalProperties: true,
          },
          {
            type: "object",
            properties: {
              type: { const: "mcp" },
              name: { type: "string" },
              server_label: { type: "string" },
            },
            required: ["type", "name", "server_label"],
            additionalProperties: true,
          },
        ],
      },
      tools: {
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/FunctionTool" },
            {
              type: "object",
              properties: { type: { const: "web_search" } },
              required: ["type"],
              additionalProperties: true,
            },
          ],
        },
      },
    },
    required: ["model"],
    additionalProperties: true,
  },
  BackendPatch: {
    type: "object",
    properties: {
      model: { type: "string" },
      instructions: { type: ["string", "null"] },
      max_output_tokens: { type: ["number", "null"] },
      parallel_tool_calls: { type: ["boolean", "null"] },
      reasoning: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              effort: { enum: ["none", "minimal", "low", "medium", "high", "xhigh", null] },
              summary: { enum: ["concise", "detailed", "auto", null] },
            },
            required: [],
            additionalProperties: true,
          },
        ],
      },
      service_tier: {
        enum: ["auto", "default", "fast_tier_temp_pilot", "flex", "priority", "ultrafast", null],
      },
      text: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: { verbosity: { enum: ["low", "medium", "high", null] } },
            required: [],
            additionalProperties: true,
          },
        ],
      },
      tool_choice: {
        anyOf: [
          { enum: ["auto", "none", "required"] },
          {
            type: "object",
            properties: { type: { const: "function" }, name: { type: "string" } },
            required: ["type", "name"],
            additionalProperties: true,
          },
          {
            type: "object",
            properties: {
              type: { const: "mcp" },
              name: { type: "string" },
              server_label: { type: "string" },
            },
            required: ["type", "name", "server_label"],
            additionalProperties: true,
          },
        ],
      },
      tools: {
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/FunctionTool" },
            {
              type: "object",
              properties: { type: { const: "web_search" } },
              required: ["type"],
              additionalProperties: true,
            },
          ],
        },
      },
    },
    required: [],
    additionalProperties: true,
  },
  Delegation: {
    anyOf: [
      { type: "null" },
      {
        type: "object",
        properties: { type: { const: "client" } },
        required: ["type"],
        additionalProperties: true,
      },
      {
        type: "object",
        properties: { type: { const: "responses" }, responses: { $ref: "#/$defs/Backend" } },
        required: ["type", "responses"],
        additionalProperties: true,
      },
    ],
  },
  DelegationPatch: {
    anyOf: [
      { type: "null" },
      {
        type: "object",
        properties: { type: { const: "client" } },
        required: ["type"],
        additionalProperties: true,
      },
      {
        type: "object",
        properties: { type: { const: "responses" }, responses: { $ref: "#/$defs/BackendPatch" } },
        required: ["type"],
        additionalProperties: true,
      },
    ],
  },
  SessionConfig: {
    type: "object",
    properties: {
      model: { const: "gpt-live-1" },
      audio: { $ref: "#/$defs/Audio" },
      delegation: { $ref: "#/$defs/Delegation" },
      instructions: { type: ["string", "null"] },
      store: { type: "boolean" },
      input: { type: "array", items: { type: "object" } },
      client: { type: "object" },
    },
    required: ["model"],
    additionalProperties: true,
  },
  SessionResource: {
    type: "object",
    properties: {
      model: { const: "gpt-live-1" },
      audio: { $ref: "#/$defs/Audio" },
      delegation: { $ref: "#/$defs/Delegation" },
      instructions: { type: ["string", "null"] },
      store: { type: "boolean" },
      input: { type: "array", items: { type: "object" } },
      client: { type: "object" },
      id: { type: "string" },
      expires_at: { type: "number" },
      status: { const: "active" },
    },
    required: ["id", "expires_at", "model", "status"],
    additionalProperties: true,
  },
  SessionPatch: {
    type: "object",
    properties: { delegation: { $ref: "#/$defs/DelegationPatch" } },
    required: [],
    additionalProperties: true,
  },
  Usage: {
    type: "object",
    properties: { seconds: { type: "number" } },
    required: ["seconds"],
    additionalProperties: true,
  },
  DelegationEventBody: {
    type: "object",
    properties: {
      id: { type: "string" },
      type: { const: "delegation" },
      target: { enum: ["client", "responses"] },
      response_id: { type: "string" },
    },
    required: ["id", "type", "target"],
    additionalProperties: true,
  },
  Error: {
    type: "object",
    properties: {
      type: { type: "string" },
      code: { type: "string" },
      message: { type: "string" },
      param: { type: ["string", "null"] },
      client_event_id: { type: "string" },
    },
    required: ["type", "code", "message"],
    additionalProperties: true,
  },
  FunctionOutput: {
    type: "object",
    properties: {
      type: { const: "function_call_output" },
      call_id: { type: "string" },
      output: { type: "string" },
      id: { type: "string" },
      status: { enum: ["in_progress", "completed", "incomplete"] },
    },
    required: ["type", "call_id", "output"],
    additionalProperties: true,
  },
  NestedResponse: {
    type: "object",
    properties: {
      type: { type: "string" },
      sequence_number: { type: "number" },
      response: {
        type: "object",
        properties: {
          id: { type: "string" },
          previous_response_id: { type: ["string", "null"] },
          status: { type: "string" },
          usage: { type: ["object", "null"] },
          output: { type: "array" },
          instructions: { type: ["string", "null"] },
          tools: { type: "array" },
        },
        required: [],
        additionalProperties: true,
      },
      item: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          call_id: { type: "string" },
          arguments: { type: "string" },
          name: { type: "string" },
          status: { type: "string" },
        },
        required: [],
        additionalProperties: true,
      },
      item_id: { type: "string" },
      output_index: { type: "number" },
      delta: { type: "string" },
      arguments: { type: "string" },
    },
    required: [],
    additionalProperties: true,
  },
};
const CLIENT_SCHEMAS: { [key: string]: Shape } = {
  "session.start": {
    type: "object",
    properties: {
      type: { const: "session.start" },
      event_id: { type: ["string", "null"] },
      session: { $ref: "#/$defs/SessionConfig" },
    },
    required: ["type", "session"],
    additionalProperties: true,
  },
  "session.update": {
    type: "object",
    properties: {
      type: { const: "session.update" },
      event_id: { type: ["string", "null"] },
      session: { $ref: "#/$defs/SessionPatch" },
    },
    required: ["type", "session"],
    additionalProperties: true,
  },
  "session.input_audio.append": {
    type: "object",
    properties: {
      type: { const: "session.input_audio.append" },
      event_id: { type: ["string", "null"] },
      audio: { type: "string" },
    },
    required: ["type", "audio"],
    additionalProperties: true,
  },
  "response.item.create": {
    type: "object",
    properties: {
      type: { const: "response.item.create" },
      event_id: { type: ["string", "null"] },
      item: { $ref: "#/$defs/FunctionOutput" },
    },
    required: ["type", "item"],
    additionalProperties: true,
  },
  "response.create": {
    type: "object",
    properties: { type: { const: "response.create" }, event_id: { type: ["string", "null"] } },
    required: ["type"],
    additionalProperties: true,
  },
  "session.close": {
    type: "object",
    properties: { type: { const: "session.close" }, event_id: { type: ["string", "null"] } },
    required: ["type"],
    additionalProperties: true,
  },
  "session.instructions.append": {
    type: "object",
    properties: {
      type: { const: "session.instructions.append" },
      event_id: { type: ["string", "null"] },
      content: { type: "string" },
      delegation_id: { type: ["string", "null"] },
    },
    required: ["type", "content", "delegation_id"],
    additionalProperties: true,
  },
  "session.thinking.append": {
    type: "object",
    properties: {
      type: { const: "session.thinking.append" },
      event_id: { type: ["string", "null"] },
      content: { type: "string" },
      delegation_id: { type: ["string", "null"] },
    },
    required: ["type", "content", "delegation_id"],
    additionalProperties: true,
  },
  "session.commentary.append": {
    type: "object",
    properties: {
      type: { const: "session.commentary.append" },
      event_id: { type: ["string", "null"] },
      content: { type: "string" },
      delegation_id: { type: ["string", "null"] },
    },
    required: ["type", "content", "delegation_id"],
    additionalProperties: true,
  },
  "session.input_audio.mute": {
    type: "object",
    properties: {
      type: { const: "session.input_audio.mute" },
      event_id: { type: ["string", "null"] },
    },
    required: ["type"],
    additionalProperties: true,
  },
  "session.input_audio.unmute": {
    type: "object",
    properties: {
      type: { const: "session.input_audio.unmute" },
      event_id: { type: ["string", "null"] },
    },
    required: ["type"],
    additionalProperties: true,
  },
};
const SERVER_SCHEMAS: { [key: string]: Shape } = {
  "session.started": {
    type: "object",
    properties: {
      type: { const: "session.started" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      session: { $ref: "#/$defs/SessionResource" },
    },
    required: ["type", "event_id", "session"],
    additionalProperties: true,
  },
  "session.updated": {
    type: "object",
    properties: {
      type: { const: "session.updated" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      session: { $ref: "#/$defs/SessionResource" },
    },
    required: ["type", "event_id", "session"],
    additionalProperties: true,
  },
  "session.closed": {
    type: "object",
    properties: {
      type: { const: "session.closed" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      session: { $ref: "#/$defs/SessionResource" },
      usage: { $ref: "#/$defs/Usage" },
      reason: {
        enum: ["close_requested", "expired", "content", "remote_hangup", "connection_lost"],
      },
    },
    required: ["type", "event_id", "session", "usage", "reason"],
    additionalProperties: true,
  },
  "session.output_audio.delta": {
    type: "object",
    properties: {
      type: { const: "session.output_audio.delta" },
      delta: { type: "string" },
      start_ms: { type: "number" },
      end_ms: { type: "number" },
    },
    required: ["type", "delta"],
    additionalProperties: true,
  },
  "session.input_transcript.delta": {
    type: "object",
    properties: {
      type: { const: "session.input_transcript.delta" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      start_ms: { type: "number" },
      end_ms: { type: "number" },
      delta: { type: "string" },
    },
    required: ["type", "event_id", "start_ms", "end_ms", "delta"],
    additionalProperties: true,
  },
  "session.output_transcript.delta": {
    type: "object",
    properties: {
      type: { const: "session.output_transcript.delta" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      start_ms: { type: "number" },
      end_ms: { type: "number" },
      delta: { type: "string" },
    },
    required: ["type", "event_id", "start_ms", "end_ms", "delta"],
    additionalProperties: true,
  },
  "session.instructions.appended": {
    type: "object",
    properties: {
      type: { const: "session.instructions.appended" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      start_ms: { type: "number" },
      end_ms: { type: "number" },
    },
    required: ["type", "event_id", "start_ms", "end_ms"],
    additionalProperties: true,
  },
  "session.thinking.appended": {
    type: "object",
    properties: {
      type: { const: "session.thinking.appended" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      start_ms: { type: "number" },
      end_ms: { type: "number" },
    },
    required: ["type", "event_id", "start_ms", "end_ms"],
    additionalProperties: true,
  },
  "session.commentary.appended": {
    type: "object",
    properties: {
      type: { const: "session.commentary.appended" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      start_ms: { type: "number" },
      end_ms: { type: "number" },
    },
    required: ["type", "event_id", "start_ms", "end_ms"],
    additionalProperties: true,
  },
  "session.input_audio.muted": {
    type: "object",
    properties: {
      type: { const: "session.input_audio.muted" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
    },
    required: ["type", "event_id"],
    additionalProperties: true,
  },
  "session.input_audio.unmuted": {
    type: "object",
    properties: {
      type: { const: "session.input_audio.unmuted" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
    },
    required: ["type", "event_id"],
    additionalProperties: true,
  },
  "session.delegation.created": {
    type: "object",
    properties: {
      type: { const: "session.delegation.created" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      delegation: { $ref: "#/$defs/DelegationEventBody" },
      offset_ms: { type: "number" },
    },
    required: ["type", "event_id", "delegation", "offset_ms"],
    additionalProperties: true,
  },
  "session.usage.updated": {
    type: "object",
    properties: {
      type: { const: "session.usage.updated" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      usage: { $ref: "#/$defs/Usage" },
      context_window: {
        type: "object",
        properties: { usage_ratio: { type: "number" } },
        required: ["usage_ratio"],
        additionalProperties: true,
      },
    },
    required: ["type", "event_id", "usage"],
    additionalProperties: true,
  },
  "response.event": {
    type: "object",
    properties: {
      type: { const: "response.event" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      event: { $ref: "#/$defs/NestedResponse" },
      delegation_id: { type: ["string", "null"] },
    },
    required: ["type", "event_id", "event"],
    additionalProperties: true,
  },
  error: {
    type: "object",
    properties: {
      type: { const: "error" },
      event_id: { type: "string" },
      client_event_id: { type: "string" },
      error: { $ref: "#/$defs/Error" },
    },
    required: ["type", "event_id", "error"],
    additionalProperties: true,
  },
};
const DOCUMENTED_ONLY = new Set([
  "session.instructions.append",
  "session.input_audio.mute",
  "session.input_audio.unmute",
]);

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 5_000_000;
const dangerous = new Set(["__proto__", "prototype", "constructor"]);
function fail(path: string, message: string): never {
  throw new Error(`Live fixture ${path}: ${message}`);
}
function object(value: LiveJson | undefined, path: string): LiveObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value;
}
function string(value: LiveJson | undefined, path: string): string {
  if (typeof value !== "string" || !value.length) fail(path, "must be a nonempty string");
  return value;
}
function integer(value: LiveJson | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(path, "must be a nonnegative safe integer");
  return value;
}
function array(value: LiveJson | undefined, path: string): LiveJson[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

/** Clone before registration; reject getters, prototypes, cycles and oversized JSON before allocating. */
function cloneJson(value: unknown, maxBytes = MAX_JSON_BYTES, rootPath = "live"): LiveJson {
  let bytes = 0;
  const ancestors = new Set<object>();
  function charge(count: number, path: string) {
    bytes += count;
    if (bytes > maxBytes) fail(path, "exceeds JSON byte limit");
  }
  function visit(current: unknown, path: string, depth: number): LiveJson {
    if (depth > 32) fail(path, "exceeds JSON depth 32");
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "number" ||
      typeof current === "string"
    ) {
      if (typeof current === "number" && !Number.isFinite(current))
        fail(path, "must be finite JSON");
      // A string's UTF-16 length is a lower bound on its serialized byte length.
      if (typeof current === "string" && current.length > maxBytes - bytes)
        fail(path, "exceeds JSON byte limit");
      charge(Buffer.byteLength(JSON.stringify(current)), path);
      return current;
    }
    if (typeof current !== "object") fail(path, "must be JSON");
    if (ancestors.has(current)) fail(path, "contains a cycle");
    const isArray = Array.isArray(current);
    if (
      Object.getPrototypeOf(current) !== (isArray ? Array.prototype : Object.prototype) &&
      Object.getPrototypeOf(current) !== null
    )
      fail(path, "must have a plain JSON prototype");
    if (Object.getOwnPropertySymbols(current).length) fail(path, "symbol properties are not JSON");
    ancestors.add(current);
    charge(2, path);
    const result: LiveObject | LiveJson[] = isArray ? [] : {};
    const keys = Object.getOwnPropertyNames(current);
    if (isArray && current.length > MAX_ENTRIES) fail(path, "exceeds array entry limit");
    let count = 0;
    for (const key of keys) {
      if (isArray && key === "length") continue;
      if (dangerous.has(key)) fail(`${path}.${key}`, "unsafe property");
      const desc = Object.getOwnPropertyDescriptor(current, key);
      if (!desc || !desc.enumerable || !("value" in desc))
        fail(`${path}.${key}`, "must be an enumerable data property");
      if (isArray && key !== String(count)) fail(path, "must be a dense JSON array");
      charge((count++ ? 1 : 0) + (isArray ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1), path);
      const child = visit(desc.value, isArray ? `${path}[${key}]` : `${path}.${key}`, depth + 1);
      if (Array.isArray(result)) result.push(child);
      else result[key] = child;
    }
    if (isArray && count !== current.length) fail(path, "must be a dense JSON array");
    ancestors.delete(current);
    return result;
  }
  return visit(value, rootPath, 0);
}

function shape(value: LiveJson | undefined, schema: Shape, path: string): void {
  if (schema.$ref) return shape(value, DEFINITIONS[schema.$ref.slice("#/$defs/".length)], path);
  if (schema.anyOf) {
    for (const option of schema.anyOf) {
      try {
        shape(value, option, path);
        return;
      } catch {
        /* Try the next documented union member. */
      }
    }
    fail(path, "does not match documented shape");
  }
  if ("const" in schema && value !== schema.const)
    fail(path, `must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value ?? null)) fail(path, "is not a documented value");
  if (schema.type) {
    const types = typeof schema.type === "string" ? [schema.type] : schema.type;
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(actual)) fail(path, `must be ${types.join(" or ")}`);
  }
  if (schema.properties || schema.required) {
    const obj = object(value, path);
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(obj, key)) fail(`${path}.${key}`, "is required");
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (Object.hasOwn(obj, key)) shape(obj[key], child, `${path}.${key}`);
  }
  if (schema.items)
    array(value, path).forEach((item, i) => shape(item, schema.items!, `${path}[${i}]`));
}

export function normalizeLiveOptions(options: LiveOptions = {}) {
  const result: { -readonly [K in keyof typeof DEFAULT_LIVE_OPTIONS]: number } = {
    ...DEFAULT_LIVE_OPTIONS,
  };
  for (const key of Object.keys(DEFAULT_LIVE_OPTIONS) as (keyof typeof DEFAULT_LIVE_OPTIONS)[]) {
    const value = options[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value <= 0)
        fail(`options.${key}`, "must be a positive safe integer");
      result[key] = value;
    }
  }
  if (
    options.secretValues !== undefined &&
    (!Array.isArray(options.secretValues) ||
      options.secretValues.some((value) => typeof value !== "string"))
  )
    fail("options.secretValues", "must be strings");
  return { ...result, secretValues: options.secretValues?.slice() ?? [] };
}

/** Canonical object ordering without changing arrays or literal unknown fields. */
function canonical(value: LiveJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
// Provider snapshots may add resolved fields, but cannot change explicitly configured values.
function matchConfiguration(expected: LiveJson, actual: LiveJson | undefined, path: string): void {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const actualObject = object(actual, path);
    for (const [key, value] of Object.entries(expected))
      matchConfiguration(value, actualObject[key], `${path}.${key}`);
  } else if (actual === undefined || canonical(expected) !== canonical(actual))
    fail(path, "differs from accepted configuration");
}
function pcmBytes(value: LiveJson | undefined, path: string, remaining: number): number {
  if (typeof value !== "string") fail(path, "must be canonical base64 PCM");
  if (
    value.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    fail(path, "must be canonical base64 PCM");
  const bytes = (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (bytes > remaining) fail(path, "exceeds decoded audio byte limit");
  if (bytes % 2) fail(path, "must contain complete PCM16 samples");
  // Check unused padding bits without decoding/allocating a second audio buffer.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    (value.endsWith("==") && alphabet.indexOf(value.at(-3)!) & 15) ||
    (value.endsWith("=") && !value.endsWith("==") && alphabet.indexOf(value.at(-2)!) & 3)
  )
    fail(path, "must be canonical base64 PCM");
  return bytes;
}
/** Shared shape check; callers retain capture source, mode and lifecycle policy. */
function validateClientShape(event: LiveObject, path: string): void {
  const type = string(event.type, `${path}.type`);
  if (!Object.hasOwn(CLIENT_SCHEMAS, type)) fail(`${path}.type`, "unsupported client command");
  shape(event, CLIENT_SCHEMAS[type], path);
}

/** Validate one inbound command before matching a fixture or starting a recording.
 * Per-session audio totals, startup configuration and update/lifecycle policy belong to the caller.
 */
export function validateLiveClientEvent(value: unknown, options: LiveOptions = {}): LiveObject {
  const limits = normalizeLiveOptions(options);
  const event = object(
    cloneJson(value, Math.min(limits.maxMessageBytes, MAX_JSON_BYTES), "event"),
    "event",
  );
  validateClientShape(event, "event");
  if (event.type === "session.input_audio.append")
    pcmBytes(event.audio, "event.audio", limits.maxDecodedAudioBytes);
  return event;
}

function pointer(event: LiveObject, path: string): LiveJson | undefined {
  if (!path.startsWith("/") || /~(?![01])/u.test(path))
    fail("bindings.pointer", "must be a JSON Pointer");
  let value: LiveJson | undefined = event;
  for (const segment of path.slice(1).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (dangerous.has(key)) fail("bindings.pointer", "unsafe segment");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = Array.isArray(value) ? value[Number(key)] : value[key];
  }
  return value;
}

export type Site = {
  namespace: string;
  owner: "client" | "server";
  define: boolean;
  imported?: boolean;
};
const lifecycle = new Set(["response.created", "response.in_progress", "response.completed"]);
export function bindingSites(event: LiveObject, direction: string): Map<string, Site> {
  const sites = new Map<string, Site>();
  const server = direction === "server";
  function add(
    path: string,
    namespace: string,
    define = false,
    owner: "client" | "server" = "server",
    imported = false,
  ) {
    if (typeof pointer(event, path) === "string")
      sites.set(path, { namespace, owner, define, imported });
  }
  add("/event_id", server ? "server-event" : "client-event", true, server ? "server" : "client");
  if (server) add("/client_event_id", "client-event", false, "client");
  if (server && event.type === "error")
    add("/error/client_event_id", "client-event", false, "client");
  if (
    server &&
    ["session.started", "session.updated", "session.closed"].includes(String(event.type))
  )
    add("/session/id", "session", event.type === "session.started");
  if (server && event.type === "session.delegation.created") {
    add("/delegation/id", "delegation", true);
    add("/delegation/response_id", "response", true);
  }
  if (
    (!server &&
      [
        "session.thinking.append",
        "session.commentary.append",
        "session.instructions.append",
      ].includes(String(event.type))) ||
    (server && event.type === "response.event")
  )
    add("/delegation_id", "delegation");
  if (!server && event.type === "response.item.create") add("/item/call_id", "tool-call");
  if (server && event.type === "response.event") {
    const nested = object(event.event, "event.event");
    add("/event/response/id", "response", nested.type === "response.created");
    add(
      "/event/response/previous_response_id",
      "response",
      false,
      "server",
      lifecycle.has(String(nested.type)),
    );
    add("/event/item/id", "response-item", nested.type === "response.output_item.added");
    add("/event/item_id", "response-item");
    add("/event/item/call_id", "tool-call", nested.type === "response.output_item.added");
  }
  return sites;
}

export function validateLiveTranscript(value: unknown, options: LiveOptions = {}): LiveTranscript {
  const limits = normalizeLiveOptions(options);
  const root = object(cloneJson(value), "live");
  if (root.version !== 1) fail("version", "must equal 1");
  if (root.model !== "gpt-live-1") fail("model", "must equal gpt-live-1");
  if (root.mode !== "client" && root.mode !== "managed") fail("mode", "must be client or managed");
  const audio = object(root.audio, "audio");
  if (audio.encoding !== "pcm16le" || audio.sampleRateHz !== 24000 || audio.channels !== 1)
    fail("audio", "requires mono PCM16LE at 24000 Hz");
  const config = object(root.configuration, "configuration");
  shape(config, DEFINITIONS.SessionConfig, "configuration");
  shape(
    object(config.audio, "configuration.audio").format,
    DEFINITIONS.Pcm24,
    "configuration.audio.format",
  );
  const delegation = object(config.delegation, "configuration.delegation");
  if (delegation.type !== (root.mode === "managed" ? "responses" : "client"))
    fail("configuration.delegation", "must match mode explicitly");
  let effectiveConfiguration = structuredClone(config);
  const capture = object(root.capture, "capture");
  if (capture.complete !== true)
    fail("capture.complete", "only complete successful captures are loadable");
  if (capture.source !== "authored" && capture.source !== "provider")
    fail("capture.source", "must be authored or provider");
  if (capture.provenance !== undefined) {
    const provenance = object(capture.provenance, "capture.provenance");
    string(provenance.host, "capture.provenance.host");
    string(provenance.referenceVersion, "capture.provenance.referenceVersion");
    if (
      !Number.isFinite(Date.parse(string(provenance.observedAt, "capture.provenance.observedAt")))
    )
      fail("capture.provenance.observedAt", "must be a timestamp");
    if (provenance.path !== "/v1/live/sessions" || provenance.sanitationVersion !== 1)
      fail("capture.provenance", "invalid path or sanitationVersion");
  }
  const entries = array(root.entries, "entries");
  if (!entries.length || entries.length > MAX_ENTRIES) fail("entries", "invalid entry count");
  const terminal = integer(capture.terminalEntry, "capture.terminalEntry");
  if (terminal !== entries.length - 1)
    fail("capture.terminalEntry", "must identify the final session.closed event");
  const bindings = array(root.bindings, "bindings");
  const byEntry = new Map<number, { binding: LiveObject; path: string }[]>();
  bindings.forEach((raw, index) => {
    const path = `bindings[${index}]`;
    const binding = object(raw, path);
    const entry = integer(binding.entry, `${path}.entry`);
    if (entry >= entries.length) fail(`${path}.entry`, "out of range");
    const bucket = byEntry.get(entry) ?? [];
    bucket.push({ binding, path });
    byEntry.set(entry, bucket);
  });
  const identities = new Map<string, { name: string; owner: string; value: string }>();
  const names = new Map<
    string,
    { namespace: string; owner: string; value: string; acceptedAt?: LivePosition }
  >();
  let command = 0,
    audioBytes = 0,
    previousTime = -1,
    previousServerCommand = 0,
    previousServerAudio = 0;
  const runBytes = new Map<number, number>([[0, 0]]);
  const totals = { client: 0, server: 0 };
  for (let i = 0; i < entries.length; i++) {
    const path = `entries[${i}]`;
    const entry = object(entries[i], path);
    if (entry.direction !== "client" && entry.direction !== "server")
      fail(`${path}.direction`, "must be client or server");
    const atMs = integer(entry.atMs, `${path}.atMs`);
    if (atMs < previousTime || atMs > limits.maxDurationMs)
      fail(`${path}.atMs`, "must be monotonic and within duration limit");
    previousTime = atMs;
    const event = object(entry.event, `${path}.event`);
    const type = string(event.type, `${path}.event.type`);
    const client = entry.direction === "client";
    if (client) {
      validateClientShape(event, `${path}.event`);
      if (capture.source === "provider" && DOCUMENTED_ONLY.has(type))
        fail(`${path}.event.type`, "unsupported client command for this capture source");
    } else if (Object.hasOwn(SERVER_SCHEMAS, type))
      shape(event, SERVER_SCHEMAS[type], `${path}.event`);
    if (Buffer.byteLength(JSON.stringify(event)) > limits.maxMessageBytes)
      fail(`${path}.event`, "exceeds message byte limit");
    if (type === "error") fail(`${path}.event`, "error probes are not successful fixtures");
    if (i === 0 && (!client || type !== "session.start"))
      fail(path, "must begin with client session.start");
    if (type === "session.start") {
      if (!client || i !== 0) fail(`${path}.event.type`, "session.start is only valid at startup");
      if (canonical(event.session) !== canonical(config))
        fail(`${path}.event.session`, "must equal configuration");
    }
    if (type === "session.update" && client) {
      const patch = object(event.session, `${path}.event.session`);
      const del = object(patch.delegation, `${path}.event.session.delegation`);
      const backend = object(del.responses, `${path}.event.session.delegation.responses`);
      if (
        root.mode !== "managed" ||
        Object.keys(patch).some((key) => key !== "delegation") ||
        Object.keys(del).some((key) => key !== "type" && key !== "responses") ||
        (del.type !== undefined && del.type !== "responses") ||
        Object.keys(backend).some((key) => key !== "instructions") ||
        !Object.hasOwn(backend, "instructions")
      )
        fail(`${path}.event.session`, "only observed backend instructions update is supported");
    }
    if (client && type === "session.update") {
      const backend = object(
        object(
          object(event.session, `${path}.event.session`).delegation,
          `${path}.event.session.delegation`,
        ).responses,
        `${path}.event.session.delegation.responses`,
      );
      const del = object(effectiveConfiguration.delegation, "configuration.delegation");
      effectiveConfiguration = {
        ...effectiveConfiguration,
        delegation: {
          ...del,
          responses: {
            ...object(del.responses, "configuration.delegation.responses"),
            instructions: backend.instructions,
          },
        },
      };
    }
    if (!client && ["session.started", "session.updated", "session.closed"].includes(type))
      matchConfiguration(effectiveConfiguration, event.session, `${path}.event.session`);
    if (!client && type === "response.event") {
      const nested = object(event.event, `${path}.event.event`);
      if (lifecycle.has(String(nested.type)))
        string(
          object(nested.response, `${path}.event.event.response`).id,
          `${path}.event.event.response.id`,
        );
      if (
        ["response.output_item.added", "response.output_item.done"].includes(String(nested.type)) &&
        object(nested.item, `${path}.event.event.item`).type === "function_call"
      ) {
        const item = object(nested.item, `${path}.event.event.item`);
        for (const field of ["id", "call_id", "name"])
          string(item[field], `${path}.event.event.item.${field}`);
        if (typeof item.arguments !== "string")
          fail(`${path}.event.event.item.arguments`, "must be a string");
      }
      if (
        [
          "response.function_call_arguments.delta",
          "response.function_call_arguments.done",
        ].includes(String(nested.type))
      )
        string(nested.item_id, `${path}.event.event.item_id`);
    }
    let decoded = 0;
    if (
      (client && type === "session.input_audio.append") ||
      (!client && type === "session.output_audio.delta")
    ) {
      decoded = pcmBytes(
        event[client ? "audio" : "delta"],
        `${path}.event.${client ? "audio" : "delta"}`,
        limits.maxDecodedAudioBytes - totals[entry.direction],
      );
      totals[entry.direction] += decoded;
    }
    if (client) {
      if (entry.barrier !== undefined)
        fail(`${path}.barrier`, "client entries cannot have barriers");
      if (type === "session.input_audio.append") audioBytes += decoded;
      else {
        command++;
        audioBytes = 0;
      }
      runBytes.set(command, audioBytes);
    } else {
      const barrier = object(entry.barrier, `${path}.barrier`);
      const c = integer(barrier.command, `${path}.barrier.command`);
      const a = integer(barrier.audioBytes, `${path}.barrier.audioBytes`);
      if (
        a % 2 ||
        c > command ||
        a > (runBytes.get(c) ?? -1) ||
        c < previousServerCommand ||
        (c === previousServerCommand && a < previousServerAudio)
      )
        fail(
          `${path}.barrier`,
          "must be monotonic, sample-aligned and within preceding client prefix",
        );
      previousServerCommand = c;
      previousServerAudio = a;
    }
    if (
      i === terminal &&
      (client ||
        type !== "session.closed" ||
        !["close_requested", "remote_hangup"].includes(String(event.reason)))
    )
      fail("capture.terminalEntry", "must identify successful server session.closed");
    if (i !== terminal && type === "session.closed")
      fail(`${path}.event.type`, "session.closed must be terminal");
    const sites = bindingSites(event, entry.direction);
    const annotated = new Set<string>();
    // Ordinary definitions first, imported definitions next, then references at one wire entry.
    const ordered = (byEntry.get(i) ?? []).slice().sort((a, b) => {
      const rank = (binding: LiveObject) =>
        binding.action === "reference" ? 2 : binding.origin === "imported-context" ? 1 : 0;
      return rank(a.binding) - rank(b.binding);
    });
    for (const { binding, path: bindingPath } of ordered) {
      const ptr = string(binding.pointer, `${bindingPath}.pointer`);
      const value = pointer(event, ptr);
      const site = sites.get(ptr);
      if (!site || typeof value !== "string" || !value.length)
        fail(`${bindingPath}.pointer`, "not a non-null described identifier field");
      if (annotated.has(ptr)) fail(bindingPath, "duplicate pointer annotation");
      annotated.add(ptr);
      const name = string(binding.name, `${bindingPath}.name`);
      if (binding.owner !== site.owner) fail(`${bindingPath}.owner`, "does not match descriptor");
      if (binding.action !== "define" && binding.action !== "reference")
        fail(`${bindingPath}.action`, "must be define or reference");
      if (
        binding.origin !== undefined &&
        binding.origin !== "observed" &&
        binding.origin !== "imported-context"
      )
        fail(`${bindingPath}.origin`, "invalid origin");
      const imported = binding.origin === "imported-context";
      if (
        imported &&
        (binding.action !== "define" || !site.imported || client || site.owner !== "server")
      )
        fail(`${bindingPath}.origin`, "illegal imported-context site");
      const key = JSON.stringify([site.namespace, value]);
      const prior = identities.get(key);
      const named = names.get(name);
      if (binding.action === "define") {
        if ((!site.define && !imported) || prior || named)
          fail(bindingPath, "invalid or duplicate identity definition");
        identities.set(key, { name, owner: site.owner, value });
        names.set(name, {
          namespace: site.namespace,
          owner: site.owner,
          value,
          ...(client ? { acceptedAt: { command, audioBytes } } : {}),
        });
      } else if (
        !prior ||
        !named ||
        prior.name !== name ||
        named.namespace !== site.namespace ||
        named.owner !== site.owner ||
        named.value !== value
      )
        fail(bindingPath, "reference precedes definition or violates identifier bijection");
      else if (
        !client &&
        named.acceptedAt &&
        (previousServerCommand < named.acceptedAt.command ||
          (previousServerCommand === named.acceptedAt.command &&
            previousServerAudio < named.acceptedAt.audioBytes))
      )
        fail(`${path}.barrier`, `precedes referenced client input at ${ptr}`);
    }
    for (const ptr of sites.keys())
      if (!annotated.has(ptr)) fail(`${path}.event${ptr}`, "missing identifier binding");
  }
  // Every structural field and all JSON values have been checked above; the cast exposes the public contract.
  return root as LiveObject & LiveTranscript;
}

export function normalizeLiveFixture(
  value: unknown,
  options: LiveOptions = {},
): LiveFixtureResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("response", "must be an object");
  const descriptor = Object.getOwnPropertyDescriptor(value, "live");
  if (!descriptor || !("value" in descriptor))
    fail("response.live", "must be an own data property");
  const timing = Object.getOwnPropertyDescriptor(value, "liveTiming");
  if (
    timing &&
    (!("value" in timing) || (timing.value !== "recorded" && timing.value !== "immediate"))
  )
    fail("response.liveTiming", "must be recorded or immediate");
  const live = validateLiveTranscript(descriptor.value, options);
  return timing ? { live, liveTiming: timing.value } : { live };
}
