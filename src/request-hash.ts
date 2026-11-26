/**
 * Stale-fixture detection (#638).
 *
 * The recorder stores `metadata.requestHash`, a hash of the request it
 * recorded on. At replay, when the served fixture carries one and the incoming
 * request hashes differently, the request has changed since the recording
 * (for example a tool result changed), but it still matches the fixture. The
 * journal entry then gets `response.staleFixture` and the server logs one
 * warning. Serving does not change.
 */
import * as crypto from "node:crypto";
import { canonicalJSON } from "./chaos-random.js";
import { normalizeModelName } from "./model-utils.js";
import type { ChatCompletionRequest, Fixture } from "./types.js";

/**
 * The request fields the hash covers: `messages` (without tool-call ids, see
 * {@link withoutCallIds}), `tools`, `customTools`, `tool_choice`,
 * `response_format`, `temperature` and `max_tokens`, plus the model with its
 * date suffix removed (a dated model name does not change the hash). No other
 * field is covered: for example `top_p`, `seed`, `stop`,
 * `max_completion_tokens`, the stream flag and stream options, SDK fields and
 * the request context. `embeddingInput` is listed, but an embedding recording
 * has no system prompt or tools, so it gets no hash and is never checked.
 */
const HASHED_FIELDS = [
  "messages",
  "tools",
  "customTools",
  "tool_choice",
  "response_format",
  "temperature",
  "max_tokens",
  "embeddingInput",
] as const;

/** Structural logger shape (the router's matcher logger is `{ warn }` only). */
type WarnLogger = { warn(...args: unknown[]): void };

/** A copy of `value` without own property `key`. A non-object is returned as-is. */
function omitKey(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

/**
 * `messages` without tool-call ids: `tool_call_id` on each message and `id` on
 * each `tool_calls` / `custom_tool_calls` entry. When a client sends a tool
 * call without an id, the Responses, Cohere and Gemini Interactions converters
 * make up a random one, so a hashed id would change on every request. Function
 * names, arguments and tool-result content stay in the hash.
 */
function withoutCallIds(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message: unknown) => {
    const copy = omitKey(message, "tool_call_id");
    if (copy === null || typeof copy !== "object" || Array.isArray(copy)) return copy;
    const record = copy as Record<string, unknown>;
    for (const field of ["tool_calls", "custom_tool_calls"]) {
      const calls = record[field];
      if (Array.isArray(calls)) record[field] = calls.map((call: unknown) => omitKey(call, "id"));
    }
    return record;
  });
}

/**
 * Throw when `root` contains an object that contains itself. Walks iteratively
 * (a deeply nested body cannot overflow the stack) and tracks only the objects
 * on the current path, so one object shared by two branches is not a cycle.
 */
function assertAcyclic(root: unknown): void {
  const onPath = new Set<object>();
  const work: { value: unknown; leave?: true }[] = [{ value: root }];
  while (work.length > 0) {
    const { value, leave } = work.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (leave) {
      onPath.delete(value);
      continue;
    }
    if (onPath.has(value)) throw new Error("request contains a circular reference");
    onPath.add(value);
    work.push({ value, leave: true });
    for (const child of Object.values(value)) work.push({ value: child });
  }
}

/**
 * Hash a request for stale-fixture detection. Pass the request after
 * `requestTransform`. Key order and whitespace do not change the hash: the
 * request is hashed in canonical JSON (keys sorted at every depth, built
 * iteratively so a deeply nested body cannot overflow the stack).
 *
 * Never throws. When the request cannot be hashed (for example a
 * `requestTransform` result with a circular reference or a BigInt), it logs
 * one warning and returns undefined, and the caller skips the stale check.
 */
export function computeRequestHash(
  request: ChatCompletionRequest,
  logger?: WarnLogger,
): string | undefined {
  try {
    const material: Record<string, unknown> = {
      model: normalizeModelName(request.model),
    };
    for (const field of HASHED_FIELDS) material[field] = request[field];
    material.messages = withoutCallIds(material.messages);
    assertAcyclic(material);
    return crypto.createHash("sha256").update(canonicalJSON(material)).digest("hex").slice(0, 16);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`Stale-fixture check skipped: cannot hash request (${msg})`);
    return undefined;
  }
}

/** A served fixture whose recorded request hash differs from the request's. */
export interface StaleFixtureMark {
  fixture: Fixture;
  expected: string;
  actual: string;
}

/** The last stale match for each request object, read when the request is journaled. */
const staleMarks = new WeakMap<object, StaleFixtureMark>();

/**
 * Compare a selected fixture's recorded hash with the request's. `req` is the
 * request object the handler matched (and later journals); `effective` is
 * that request after `requestTransform`. A fixture without a recorded hash is
 * never checked, and neither is a request that cannot be hashed.
 */
export function noteStaleFixture(
  req: ChatCompletionRequest,
  fixture: Fixture,
  effective: ChatCompletionRequest,
  logger?: WarnLogger,
): void {
  const expected = fixture.metadata?.requestHash;
  if (typeof expected !== "string") {
    staleMarks.delete(req);
    return;
  }
  const actual = computeRequestHash(effective, logger);
  if (actual === undefined || actual === expected) staleMarks.delete(req);
  else staleMarks.set(req, { fixture, expected, actual });
}

/**
 * The stale mark for a journaled request body, when `fixture` is the fixture
 * the mark was made for. Returns undefined otherwise.
 */
export function staleFixtureFor(
  body: unknown,
  fixture: Fixture | null,
): { expected: string; actual: string } | undefined {
  if (!fixture || body === null || typeof body !== "object") return undefined;
  const mark = staleMarks.get(body);
  if (!mark || mark.fixture !== fixture) return undefined;
  return { expected: mark.expected, actual: mark.actual };
}
