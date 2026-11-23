/**
 * Seeded randomness for chaos verdicts and streaming jitter.
 *
 * Without a seed, chaos rolls `Math.random()` exactly as it always has and
 * nothing in this module is touched. With a seed (`chaos.seed`,
 * `--chaos-seed`, the `x-aimock-chaos-seed` header or `POST /__aimock/chaos`),
 * every draw is a pure function of four inputs:
 *
 *   - the seed;
 *   - the request's identity key (method, target and a hash of the body);
 *   - the action kind (`drop`, `malformed`, `rateLimit`, `disconnect`, or
 *     `jitter`);
 *   - the occurrence: how many times this key was seen before under this seed.
 *
 * That shape buys three properties:
 *
 *   - **Reproducibility.** The same seed and the same requests give the same
 *     verdicts on a fresh server.
 *   - **Order independence.** The Nth verdict for a key does not depend on
 *     other requests that were interleaved with it.
 *   - **Kind independence.** Each action kind draws from its own stream, so a
 *     change to one rate does not move the draws of another.
 *
 * Design and initial implementation by AnshulBhati01 in #618.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_TEST_ID } from "./constants.js";

/** Per-request seed override. Also sent back on a seeded chaos hit. */
export const CHAOS_SEED_HEADER = "x-aimock-chaos-seed";
/** Sent back on a seeded chaos hit: the request's identity key. */
export const CHAOS_KEY_HEADER = "x-aimock-chaos-key";
/** Sent back on a seeded chaos hit: which occurrence of its key the request was. */
export const CHAOS_OCCURRENCE_HEADER = "x-aimock-chaos-occurrence";

/**
 * Where a seeded verdict came from: enough to reproduce it. Only a request
 * that resolved a seed has one; an unseeded verdict has no origin and reports
 * nothing new.
 */
export interface ChaosOrigin {
  /** The effective seed: the header's, else the fixture's, else the server's. */
  seed: string;
  /** The request's identity key (16 hex characters). */
  key: string;
  /** 0 for this key's first verdict under this seed and testId, then 1, 2, ... */
  occurrence: number;
}

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * Field separator for hash material: the ASCII unit separator. A seed cannot
 * contain it (see {@link normalizeChaosSeed}) and JSON escapes it, so the
 * fields of one hash input cannot overlap.
 */
const SEP = "\u001f";

/** Longest seed accepted, in characters. */
export const MAX_CHAOS_SEED_LENGTH = 128;

/**
 * Visible ASCII except the comma. Visible ASCII because a seed must be safe to
 * send back in a response header. No comma because the `x-aimock-chaos-seed`
 * request header is read like every other chaos header: a comma separates
 * repeated values (that is how Node folds a repeated header), so a seed with a
 * comma could be reported but never replayed through the header.
 */
const SEED_GRAMMAR = /^[\x21-\x2b\x2d-\x7e]+$/;

/**
 * The default cap on distinct (testId, seed, key) occurrence counters per
 * server. See {@link ChaosOccurrenceRegistry}.
 */
export const DEFAULT_CHAOS_KEYS_MAX = 10_000;

/** FNV-1a over UTF-16 code units, low byte then high byte. `state` chains hashes. */
function fnv1a(input: string, state: number = FNV_OFFSET): number {
  let h = state >>> 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h = Math.imul(h ^ (code & 0xff), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ ((code >>> 8) & 0xff), FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** One mulberry32 step: a 32-bit state in, a value in [0, 1) out. */
function mulberry32(state: number): number {
  let t = (state + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hex32(word: number): string {
  return (word >>> 0).toString(16).padStart(8, "0");
}

/**
 * JSON with object keys sorted at every depth, so two bodies that differ only
 * in key order get one key. Array order is kept. `undefined` (no body) is a
 * bare token that no JSON value can render as.
 */
function canonicalJSON(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJSON(record[key])}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * The parts of a request that decide its chaos key. Headers are left out on
 * purpose: a retry with a new request id is the same request for fault
 * injection.
 */
export interface ChaosRequestIdentity {
  method: string;
  /** The request target. Pass the raw URL (query string included) when there is one. */
  path: string;
  /** The parsed request body, or `undefined` for a bodiless request. */
  body: unknown;
}

/** A 16-hex-character key for a request identity. */
export function chaosKeyFor(identity: ChaosRequestIdentity): string {
  const material = `${(identity.method || "GET").toUpperCase()}${SEP}${identity.path}${SEP}${canonicalJSON(identity.body)}`;
  const low = fnv1a(material);
  const high = fnv1a(material, (low ^ 0x9e3779b9) >>> 0);
  return hex32(high) + hex32(low);
}

/** A draw in [0, 1) for one (seed, key, kind, occurrence). Pure. */
export function chaosDraw(seed: string, key: string, kind: string, occurrence: number): number {
  const material = `${seed}${SEP}${kind}${SEP}${key}${SEP}${occurrence}`;
  const low = fnv1a(material);
  const high = fnv1a(material, (low ^ 0x9e3779b9) >>> 0);
  return mulberry32((low ^ Math.imul(high, FNV_PRIME)) >>> 0);
}

/**
 * The canonical string form of a seed, or `undefined` when the value is not a
 * usable seed. A finite number becomes its decimal string, so `42` and `"42"`
 * are one seed. A string is trimmed and must then be 1 to
 * {@link MAX_CHAOS_SEED_LENGTH} visible ASCII characters (no spaces, no
 * commas), so it can always be reported back in a response header unchanged
 * and replayed through the `x-aimock-chaos-seed` request header unchanged.
 */
export function normalizeChaosSeed(value: unknown): string | undefined {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return undefined;
  }
  if (text.length === 0 || text.length > MAX_CHAOS_SEED_LENGTH) return undefined;
  return SEED_GRAMMAR.test(text) ? text : undefined;
}

/** Per-chunk jitter draw in [0, 1), indexed by chunk. */
export type JitterSource = (chunkIndex: number) => number;

/**
 * Jitter for one request, on its seed and key. Occurrence is not part of it:
 * the same request streams with the same pacing every time.
 */
export function createJitterSource(seed: string, key: string): JitterSource {
  return (chunkIndex: number) => chaosDraw(seed, key, "jitter", chunkIndex);
}

/**
 * Per-key occurrence counters, so the second identical request draws on its
 * own instead of repeating the first verdict forever.
 *
 * BOUNDED. A long-running server sees an unbounded number of distinct request
 * bodies, so the registry holds at most `max` counters and evicts the least
 * recently used one first (a `Map` iterates in insertion order, and a touched
 * entry is re-inserted at the end). An evicted key starts again at occurrence
 * 0, so its verdicts repeat from the start of its sequence. With the default
 * cap that only happens to a key that was idle while 10,000 other keys were
 * seen.
 *
 * Counters are namespaced by testId, so two tests that run in parallel on one
 * server keep independent sequences, and one test's chaos reset does not
 * rewind another's.
 */
export class ChaosOccurrenceRegistry {
  private readonly counts = new Map<string, { scope: string; count: number }>();
  readonly max: number;

  constructor(max: number = DEFAULT_CHAOS_KEYS_MAX) {
    this.max = Number.isInteger(max) && max > 0 ? max : DEFAULT_CHAOS_KEYS_MAX;
  }

  /** Take the next occurrence for (scope, seed, key): 0 the first time, then 1, 2, ... */
  next(scope: string, seed: string, key: string): number {
    const id = `${scope}${SEP}${seed}${SEP}${key}`;
    const entry = this.counts.get(id);
    const occurrence = entry?.count ?? 0;
    if (entry) this.counts.delete(id);
    else if (this.counts.size >= this.max) {
      const oldest = this.counts.keys().next();
      if (!oldest.done) this.counts.delete(oldest.value);
    }
    this.counts.set(id, { scope, count: occurrence + 1 });
    return occurrence;
  }

  /** Number of counters held. */
  get size(): number {
    return this.counts.size;
  }

  /** Drop the counters of one testId scope. */
  clearScope(scope: string): void {
    this.clearScopesWhere((s) => s === scope);
  }

  /** Drop the counters of every testId scope that `drop` accepts. */
  clearScopesWhere(drop: (scope: string) => boolean): void {
    for (const [id, entry] of this.counts) {
      if (drop(entry.scope)) this.counts.delete(id);
    }
  }

  /** Drop every counter. */
  clear(): void {
    this.counts.clear();
  }
}

/**
 * The registry for callers that pass a plain `ChaosConfig` (or a scope no
 * server registered): embedders calling `evaluateChaos` directly. Bounded like
 * every server's registry. Rewound by {@link resetChaosOccurrences}.
 */
export const fallbackChaosOccurrences = new ChaosOccurrenceRegistry();

/**
 * Rewind the seeded occurrence counters that callers WITHOUT a server count in:
 * an embedder calling `evaluateChaos` (or the deprecated `applyChaos`) with a
 * plain `ChaosConfig` that carries a seed. After a reset the next seeded call
 * for a key starts again at occurrence 0, so a fresh run replays the same
 * verdicts. A server's own counters are not touched: its reset and `POST
 * /__aimock/chaos` rewind those (see {@link clearChaosOccurrences}), and
 * clearing this process-wide registry from one server's reset would rewind
 * every other embedder's sequence.
 */
export function resetChaosOccurrences(): void {
  fallbackChaosOccurrences.clear();
}

/**
 * Occurrence registries, one per server, keyed by the server's chaos
 * `byTestId` map: the one object a server's `ChaosScope` always carries, and
 * stable for the server's life. Keyed this way so the registry reaches the
 * verdict through the `serverDefaults` argument every chaos call site already
 * passes. A `WeakMap`, so a stopped server's registry goes with it.
 */
const occurrenceRegistries = new WeakMap<object, ChaosOccurrenceRegistry>();

/** Attach a server's occurrence registry to its chaos scope map. Called once by `createServer`. */
export function registerChaosOccurrences(
  byTestId: object,
  registry: ChaosOccurrenceRegistry,
): void {
  occurrenceRegistries.set(byTestId, registry);
}

/** The registry registered for a server's chaos scope map, if any. */
export function chaosOccurrencesFor(byTestId: object): ChaosOccurrenceRegistry | undefined {
  return occurrenceRegistries.get(byTestId);
}

/**
 * Drop a server's seeded-chaos occurrence counters: every testId's, or only
 * `scope`'s. The next seeded request for a key starts again at occurrence 0,
 * which is what makes a reset (or a re-install through `POST
 * /__aimock/chaos`) replay the same verdicts.
 */
export function clearChaosOccurrences(byTestId: object, scope?: string): void {
  const registry = occurrenceRegistries.get(byTestId);
  if (!registry) return;
  if (scope === undefined) registry.clear();
  else registry.clearScope(scope);
}

/**
 * Drop the counters of every testId scope that inherits the server-wide chaos
 * baseline: the default scope, and every testId with no override of its own in
 * `byTestId` (the server's chaos override map, which holds the baseline
 * override under the default testId). Called when the baseline changes, so
 * re-installing the same seeded baseline replays every scope that runs on it.
 * A testId with its own override keeps its counters: the change does not
 * reach it.
 */
export function clearBaselineChaosOccurrences(byTestId: ReadonlyMap<string, unknown>): void {
  const registry = occurrenceRegistries.get(byTestId);
  if (!registry) return;
  registry.clearScopesWhere((scope) => scope === DEFAULT_TEST_ID || !byTestId.has(scope));
}

/**
 * Per-request seeded-chaos state that has to reach code the chaos roll does
 * not call directly: the stream writers that compute jitter, and the chaos
 * action that reports the verdict's origin. Entered once per HTTP request by
 * the server (`runInChaosRequestScope`); written only when the request
 * resolved a seed, so an unseeded request leaves it empty, its jitter stays on
 * `Math.random()` and its chaos response carries nothing new.
 */
interface ChaosRequestState {
  identity?: ChaosRequestIdentity;
  jitter?: JitterSource;
  origin?: ChaosOrigin;
}

const chaosRequestScope = new AsyncLocalStorage<ChaosRequestState>();

/** Run `fn` with a fresh, empty chaos request state. */
export function runInChaosRequestScope<T>(fn: () => T): T {
  return chaosRequestScope.run({}, fn);
}

/**
 * Record what the request being served is, for a chaos roll that is not handed
 * it directly (the split gates in `src/server.ts` roll through `evaluateChaos`).
 * Only read when the request turns out to be seeded.
 */
export function setRequestChaosIdentity(identity: ChaosRequestIdentity): void {
  const state = chaosRequestScope.getStore();
  if (state) state.identity = identity;
}

/** The identity recorded for the request being served, or `undefined`. */
export function currentChaosIdentity(): ChaosRequestIdentity | undefined {
  return chaosRequestScope.getStore()?.identity;
}

/** Record a seeded verdict's origin and jitter source for the request being served. */
export function setRequestChaosSeeding(origin: ChaosOrigin, jitter: JitterSource): void {
  const state = chaosRequestScope.getStore();
  if (!state) return;
  state.origin = origin;
  state.jitter = jitter;
}

/**
 * Forget any seeded verdict origin and jitter source recorded for the request
 * being served. Called by an UNSEEDED verdict, so it cannot report, or stream
 * with, a seed left behind by an earlier seeded verdict in the same request.
 * A no-op outside a request scope and on a scope that was never seeded.
 */
export function clearRequestChaosSeeding(): void {
  const state = chaosRequestScope.getStore();
  if (!state) return;
  delete state.origin;
  delete state.jitter;
}

/** The seeded jitter source for the request being served, or `undefined`. */
export function currentChaosJitter(): JitterSource | undefined {
  return chaosRequestScope.getStore()?.jitter;
}

/** The seeded verdict origin for the request being served, or `undefined`. */
export function currentChaosOrigin(): ChaosOrigin | undefined {
  return chaosRequestScope.getStore()?.origin;
}
