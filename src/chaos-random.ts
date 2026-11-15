/**
 * Deterministic randomness for aimock's stochastic surfaces.
 *
 * aimock's promise is that a test run is reproducible. Chaos injection and
 * streaming jitter were the two exceptions: both called `Math.random()`, so a
 * CI failure that hinged on a dropped request could not be replayed.
 *
 * Every draw here is a pure function of four inputs - the seed, a per-request
 * key, a stream name, and an occurrence counter. That shape is what buys the
 * three properties callers depend on:
 *
 *   - **Order independence.** The Nth decision for a given key is the same no
 *     matter what other requests were interleaved, so adding an unrelated
 *     request to a test does not reshuffle the outcomes of the rest.
 *   - **Stream independence.** Each chaos kind draws from its own stream, so
 *     turning `dropRate` up does not change which requests come back malformed.
 *   - **Rate independence.** The draw is computed before any rate is consulted
 *     and never conditionally, so raising a rate only ever adds firings.
 */

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * Field separator for hash material. ASCII unit separator, which cannot appear
 * in a JSON-serialized body, a URL path, or a trimmed seed, so concatenated
 * fields cannot be made to overlap by choosing a devious seed or path.
 */
const SEP = String.fromCharCode(31);

/** Width of a chaos key, in hex characters. */
const KEY_HEX_WIDTH = 16;

/**
 * FNV-1a over a string's UTF-16 code units, low byte then high byte, so the
 * hash is stable for non-ASCII content without a TextEncoder round trip.
 * `state` chains one hash into the next.
 */
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

/** Render a 32-bit word as fixed-width lowercase hex. */
function hex32(word: number): string {
  return (word >>> 0).toString(16).padStart(8, "0");
}

/**
 * Serialize a value with object keys sorted at every depth, so two bodies that
 * differ only in key order - which is invisible over JSON - hash alike.
 * Array order is meaningful and is preserved.
 */
export function canonicalJSON(value: unknown): string {
  // A bare token, so it cannot collide with any body: `JSON.stringify` quotes
  // every string, so no value off the wire renders as an unquoted word.
  if (value === undefined) return "absent";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSON(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJSON(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Digest an identity string down to a fixed-width opaque key. */
function digestIdentity(identity: string): string {
  const low = fnv1a(identity);
  const high = fnv1a(identity, (low ^ 0x9e3779b9) >>> 0);
  return (hex32(high) + hex32(low)).slice(0, KEY_HEX_WIDTH);
}

/**
 * The identity of a request for chaos purposes: method, path (query string
 * included - a different query is a different request), and the canonical form
 * of the body. Headers are deliberately excluded: a retry that carries a new
 * request id is the same request as far as fault injection is concerned.
 *
 * `override` short-circuits all of that. A client that passes an explicit key
 * groups its own requests however it likes, which is how a caller pins one
 * logical call that varies in some irrelevant field.
 */
function buildChaosKey(
  method: string,
  path: string,
  body: unknown,
  override?: string | null,
): string {
  if (typeof override === "string" && override.trim().length > 0) {
    return digestIdentity(`label${SEP}${override.trim()}`);
  }
  const verb = (method || "GET").toUpperCase();
  return digestIdentity(`${verb}${SEP}${path}${SEP}${canonicalJSON(body)}`);
}

/**
 * A draw in [0, 1) for one (seed, key, stream, occurrence). Pure: no state, no
 * clock, no `Math.random()`. Two servers given the same four inputs agree.
 */
function chaosDraw(seed: string, key: string, stream: string, occurrence: number): number {
  const material = `${seed}${SEP}${stream}${SEP}${key}${SEP}${occurrence}`;
  const low = fnv1a(material);
  const high = fnv1a(material, (low ^ 0x9e3779b9) >>> 0);
  return mulberry32((low ^ Math.imul(high, FNV_PRIME)) >>> 0);
}

/**
 * Per-key occurrence counters, so the second identical request draws
 * independently of the first instead of repeating its verdict forever.
 *
 * Nothing is evicted while a server is alive. A capped map would let unrelated
 * traffic rewind a key's counter, and a verdict that depends on how many other
 * requests happened to arrive is exactly what the seed exists to eliminate.
 * The reset routes are how a caller reclaims the space.
 */
class ChaosKeyRegistry {
  private readonly counts = new Map<string, number>();

  /** Consume the next occurrence for `key`: 0 the first time, then 1, 2, ... */
  next(key: string): number {
    const current = this.counts.get(key) ?? 0;
    this.counts.set(key, current + 1);
    return current;
  }

  get size(): number {
    return this.counts.size;
  }

  clear(): void {
    this.counts.clear();
  }
}

/**
 * A fresh seed for a server that was not given one. Printed at startup and
 * served from the control API so a red run can be replayed by feeding it back.
 */
function generateChaosSeed(): string {
  const high = Math.floor(Math.random() * 0x100000000);
  const low = Math.floor(Math.random() * 0x100000000);
  return hex32(high) + hex32(low);
}

/**
 * Coerce a configured seed to its canonical string form, or null when the value
 * carries no usable seed. Numbers are accepted because config files and CLI
 * flags routinely carry `42`.
 *
 * Null means "no seed here", and the caller falls through to the next
 * precedence level, so a rejected seed behaves exactly as a blank one does.
 * Only a value that is all whitespace (or a non-finite number) is rejected.
 * A nonblank string is opaque: its spaces and other characters remain part
 * of its identity. HTTP reporting handles transport encoding separately.
 */
export function normalizeChaosSeed(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  if (value.trim().length === 0) return null;
  return value;
}

/** Per-chunk jitter source, indexed by chunk. Returns a value in [0, 1). */
export type JitterSource = (chunkIndex: number) => number;

/**
 * A jitter source drawn from the "jitter" stream, so enabling chaos never
 * shifts a stream's timing and vice versa.
 */
export function createJitterSource(seed: string, key: string): JitterSource {
  return (chunkIndex: number) => chaosDraw(seed, key, "jitter", chunkIndex);
}

/** What a request identifies itself by when asking for its draws. */
interface ChaosDrawInput {
  method: string;
  path: string;
  body: unknown;
  /** Explicit grouping key from `x-aimock-chaos-key`. */
  keyOverride?: string | null;
  /** Per-request seed override from the fixture or `x-aimock-chaos-seed`. */
  seed?: string | number | null;
}

/** One request's draws: all three kinds, always, whatever the rates are. */
export interface ChaosDraws {
  seed: string;
  key: string;
  occurrence: number;
  drop: number;
  malformed: number;
  disconnect: number;
}

/**
 * A server's deterministic randomness. Owns the run seed and the occurrence
 * counters; hands out draws and jitter sources.
 */
export class ChaosRandomizer {
  /** The server-wide seed: the configured one, or the one generated for this run. */
  readonly seed: string;

  private readonly registry = new ChaosKeyRegistry();

  constructor(seed?: string | number | null) {
    this.seed = normalizeChaosSeed(seed) ?? generateChaosSeed();
  }

  /**
   * Draw for one request. Consumes an occurrence, so a caller that wants the
   * verdict without advancing the sequence must not call this.
   *
   * Occurrence counters are namespaced by the effective seed: a request that
   * overrides the seed to replay a failure gets that seed's own sequence rather
   * than a position polluted by the surrounding run.
   */
  draw(input: ChaosDrawInput): ChaosDraws {
    const seed = normalizeChaosSeed(input.seed) ?? this.seed;
    const key = buildChaosKey(input.method, input.path, input.body, input.keyOverride);
    const occurrence = this.registry.next(`${seed}${SEP}${key}`);
    return {
      seed,
      key,
      occurrence,
      drop: chaosDraw(seed, key, "drop", occurrence),
      malformed: chaosDraw(seed, key, "malformed", occurrence),
      disconnect: chaosDraw(seed, key, "disconnect", occurrence),
    };
  }

  /** Number of distinct (seed, key) pairs currently tracked. */
  get trackedKeys(): number {
    return this.registry.size;
  }

  /** Drop every occurrence counter. The seed is unchanged - a reset replays. */
  reset(): void {
    this.registry.clear();
  }
}
