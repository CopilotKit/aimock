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
 * The parts of a request the hash covers: the conversation, the tools offered
 * and the parameters that change the reply. The model is hashed with its date
 * suffix removed, so a dated model name does not change the hash. Transport
 * details (headers, the stream flag and stream options, SDK fields, the
 * request context) are not covered.
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

/**
 * Hash a request for stale-fixture detection. Pass the request after
 * `requestTransform`. Key order and whitespace do not change the hash: the
 * request is hashed in canonical JSON (keys sorted at every depth, built
 * iteratively so a deeply nested body cannot overflow the stack).
 */
export function computeRequestHash(request: ChatCompletionRequest): string {
  const material: Record<string, unknown> = {
    model: normalizeModelName(request.model),
  };
  for (const field of HASHED_FIELDS) material[field] = request[field];
  return crypto.createHash("sha256").update(canonicalJSON(material)).digest("hex").slice(0, 16);
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
 * never checked.
 */
export function noteStaleFixture(
  req: ChatCompletionRequest,
  fixture: Fixture,
  effective: ChatCompletionRequest,
): void {
  const expected = fixture.metadata?.requestHash;
  if (typeof expected !== "string") {
    staleMarks.delete(req);
    return;
  }
  const actual = computeRequestHash(effective);
  if (actual === expected) staleMarks.delete(req);
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
