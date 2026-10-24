/**
 * @internal Shape checks for raw passthrough responses (#549). One pure
 * checker serves load-time validation (`validateFixtures`) and the serve-time
 * check, which runs on every raw fixture served (including factories and
 * `on()` fixtures, which skip load validation). Not exported from the package
 * entry point.
 */
import { validateHeaderName, validateHeaderValue } from "node:http";
import type { RawResponse, RawWireId } from "./types.js";

export interface RawFinding {
  severity: "error" | "warning";
  message: string;
}

/** Every {@link RawWireId}; the `satisfies` + exhaustiveness check keep it in sync. */
export const RAW_WIRE_IDS = [
  "openai-responses",
  "openai-chat",
  "anthropic",
  "gemini",
  "gemini-interactions",
  "cohere",
  "ollama",
  "ollama-generate",
  "bedrock-invoke",
  "bedrock-converse",
] as const satisfies readonly RawWireId[];

// Compile-time: fails if RawWireId gains a member RAW_WIRE_IDS lacks.
type MissingRawWire = Exclude<RawWireId, (typeof RAW_WIRE_IDS)[number]>;
const rawWireIdsComplete: MissingRawWire extends never ? true : never = true;
void rawWireIdsComplete;

export function isRawWireId(value: unknown): value is RawWireId {
  return typeof value === "string" && (RAW_WIRE_IDS as readonly string[]).includes(value);
}

/** Headers that break or misdescribe a body aimock frames itself. */
const FORBIDDEN_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "content-encoding",
]);

/** Wires whose framing takes the SSE event name from the event's string `type`. */
const TYPE_NAMED_WIRES: ReadonlySet<RawWireId> = new Set([
  "openai-responses",
  "anthropic",
  "cohere",
]);

/** The fields of `raw`; any other key is reported as ignored. */
const RAW_FIELDS: readonly string[] = [
  "wire",
  "events",
  "json",
  "status",
  "headers",
  "done",
] satisfies (keyof RawResponse["raw"])[];

/** Statuses whose replies carry no body: Node drops anything written for them. */
const BODYLESS_STATUSES: ReadonlySet<number> = new Set([204, 304]);

/**
 * The longest AWS event-stream header value, in bytes. The encoder writes the
 * length as a uint16 (aws-event-stream.ts), so it cannot frame a longer one.
 */
const EVENT_STREAM_HEADER_VALUE_MAX_BYTES = 0xffff;

/** A plain object, as JSON.parse makes one: not an array, Date, Map or class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The first part of `value` that JSON.parse cannot produce (a sparse-array
 * hole, `undefined`, a non-finite number, a function, a Date or other
 * non-plain object, a cycle), as `[path, problem]`. Undefined for plain JSON.
 */
function jsonProblem(
  value: unknown,
  path: string,
  ancestors: readonly object[] = [],
): [string, string] | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : [path, "must be a finite number"];
  }
  if (typeof value !== "object") return [path, `must be a JSON value; got ${typeof value}`];
  if (ancestors.includes(value)) return [path, "must not contain itself"];
  const inner = [...ancestors, value];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) return [`${path}[${i}]`, "must not be a hole in a sparse array"];
      const problem = jsonProblem(value[i], `${path}[${i}]`, inner);
      if (problem) return problem;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return [path, "must be a plain JSON object"];
  for (const [key, item] of Object.entries(value)) {
    const problem = jsonProblem(item, `${path}[${JSON.stringify(key)}]`, inner);
    if (problem) return problem;
  }
  return undefined;
}

/** What the caller knows about the fixture around `raw`. */
export interface RawCheckContext {
  /**
   * Response-type keys written next to `raw`, such as `customToolCalls` or
   * `responsesBlocks` (a legacy server drops these two before serving).
   */
  otherResponseKeys?: readonly string[];
  /** Whether the fixture sets its own `misbehavior`. */
  fixtureMisbehavior?: boolean;
}

/**
 * Check a raw response's `raw` value and the fixture facts in `context`.
 * Returns every finding. The fixture is servable when no finding has severity
 * `"error"`: an empty array or one with only warnings. Pure: no logging, no
 * throwing. Load validation and serve time both call it, so they agree on
 * what a valid raw fixture is.
 */
export function checkRawResponse(raw: unknown, context: RawCheckContext = {}): RawFinding[] {
  const findings: RawFinding[] = [];
  const error = (message: string) => findings.push({ severity: "error", message });

  for (const key of context.otherResponseKeys ?? []) {
    error(
      `raw cannot be combined with ${JSON.stringify(key)}: a raw fixture has no other response type`,
    );
  }
  if (context.fixtureMisbehavior) {
    error("misbehavior does not apply to raw fixtures");
  }

  if (!isPlainObject(raw)) {
    error("raw must be an object");
    return findings;
  }

  for (const key of Object.keys(raw)) {
    if (!RAW_FIELDS.includes(key)) {
      findings.push({
        severity: "warning",
        message: `raw[${JSON.stringify(key)}] is ignored: not a raw field (${RAW_FIELDS.join(", ")})`,
      });
    }
  }

  const wire = isRawWireId(raw.wire) ? raw.wire : undefined;
  if (wire === undefined) {
    error(`raw.wire must be one of ${RAW_WIRE_IDS.join(", ")}; got ${JSON.stringify(raw.wire)}`);
  }

  const events = raw.events;
  if (events === undefined && raw.json === undefined) {
    error('raw needs "events" (streaming), "json" (non-streaming), or both');
  }
  if (events !== undefined) {
    if (!Array.isArray(events)) {
      error("raw.events must be an array");
    } else {
      if (events.length === 0) {
        findings.push({
          severity: "warning",
          message: "raw.events is empty; a streaming request gets no frames",
        });
      }
      // An index loop, not forEach: forEach skips the holes of a sparse array.
      for (let i = 0; i < events.length; i++) {
        const event: unknown = events[i];
        if (!isPlainObject(event)) {
          error(`raw.events[${i}] must be a JSON object`);
          continue;
        }
        const problem = jsonProblem(event, `raw.events[${i}]`);
        if (problem) {
          error(`${problem[0]} ${problem[1]}`);
          continue;
        }
        if (wire !== undefined && TYPE_NAMED_WIRES.has(wire)) {
          if (typeof event.type !== "string") {
            error(`raw.events[${i}] needs a string "type" on ${wire}`);
          } else if (/[\r\n]/.test(event.type)) {
            // The type is written as the SSE `event:` line; a line break
            // would start another SSE field or frame.
            error(`raw.events[${i}].type must not contain a line break (CR or LF) on ${wire}`);
          }
        }
        if (wire === "bedrock-converse") {
          const keys = Object.keys(event);
          if (keys.length !== 1) {
            error(
              `raw.events[${i}] must have exactly one top-level key (the event type) on bedrock-converse`,
            );
          } else if (Buffer.byteLength(keys[0], "utf8") > EVENT_STREAM_HEADER_VALUE_MAX_BYTES) {
            error(
              `raw.events[${i}] has an event type key over ${EVENT_STREAM_HEADER_VALUE_MAX_BYTES} bytes, the event-stream header limit, on bedrock-converse`,
            );
          } else if (!isPlainObject(event[keys[0]])) {
            error(
              `raw.events[${i}].${keys[0]} must be a JSON object (the frame payload) on bedrock-converse`,
            );
          }
        }
      }
    }
  }

  if (raw.status !== undefined) {
    const status = raw.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
      error(`raw.status must be an integer from 200 to 599; got ${JSON.stringify(status)}`);
    } else if (BODYLESS_STATUSES.has(status)) {
      error(
        `raw.status ${status} cannot carry a body, so "events" and "json" would be dropped; use a status that allows a body`,
      );
    }
  }

  if (raw.headers !== undefined) {
    if (!isPlainObject(raw.headers)) {
      error("raw.headers must be an object of string values");
    } else {
      for (const [name, value] of Object.entries(raw.headers)) {
        const label = `raw.headers[${JSON.stringify(name)}]`;
        if (typeof value !== "string") {
          error(`${label} must be a string`);
          continue;
        }
        try {
          validateHeaderName(name);
        } catch {
          error(`${label} is not a valid header name`);
          continue;
        }
        try {
          validateHeaderValue(name, value);
        } catch {
          error(`${label} has an invalid header value`);
          continue;
        }
        if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
          error(`${label} is not allowed: aimock frames the body and sets this header itself`);
        }
      }
    }
  }

  if (raw.done !== undefined && typeof raw.done !== "boolean") {
    error(`raw.done must be a boolean; got ${JSON.stringify(raw.done)}`);
  } else if (raw.done !== undefined && wire !== undefined && wire !== "openai-chat") {
    error(
      `raw.done applies only to openai-chat (the only wire with a [DONE] terminal), not ${wire}`,
    );
  }

  return findings;
}
