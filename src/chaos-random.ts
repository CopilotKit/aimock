/**
 * Seeded randomness for chaos verdicts and streaming jitter.
 *
 * Without a seed, every chaos draw and every jitter draw is `Math.random()`,
 * exactly as before: no key is hashed, no occurrence is counted and no seeded
 * state is recorded. The module is still entered (the server opens a request
 * scope, `readBody` records the client body text in it, the split gates record
 * the request identity, and an unseeded verdict clears any seeded state left in
 * its scope), but none of that changes an unseeded verdict or its timing. With
 * a seed (`chaos.seed`, `--chaos-seed`, the `x-aimock-chaos-seed` header or
 * `POST /__aimock/chaos`), every draw is a pure function of four inputs:
 *
 *   - the seed;
 *   - the request's identity key (method, target less `testId`, and a hash of
 *     the body the client sent). Live-transcription jitter on the realtime
 *     WebSocket is the exception: it keys from the turn request at the fixed
 *     path `/v1/realtime`, not from a client body;
 *   - the action kind (`drop`, `malformed`, `rateLimit`, `disconnect`, or
 *     `jitter`);
 *   - for a verdict, the occurrence: how many times this key was seen before
 *     under this seed and testId. A jitter draw takes the chunk index here
 *     instead (see {@link createJitterSource}).
 *
 * That shape buys three properties:
 *
 *   - **Reproducibility.** The same seed and the same requests give the same
 *     verdicts on a fresh server.
 *   - **Order independence.** The Nth verdict for a key does not depend on
 *     other requests that were interleaved with it, nor on requests under
 *     another testId.
 *   - **Kind independence.** Each action kind draws from its own stream, so a
 *     change to one rate does not move the draws of another.
 *
 * Design and initial implementation by AnshulBhati01 in #618.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_TEST_ID } from "./constants.js";
import { Logger } from "./logger.js";

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
  /**
   * The effective seed: the header's, else the fixture's, else the server's; or,
   * when a caller passes its own resolved config to `evaluateChaos`, that
   * config's seed.
   */
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
 * Field separator for hash material: the ASCII unit separator (U+001F). Each
 * hash input has at most ONE field that can contain it, so the fields of one
 * input cannot overlap: reading the separators from both ends finds every
 * boundary.
 *
 *   - Request key (`method`, `path`, `body`): an HTTP method is a token and
 *     cannot contain it; the body is canonical JSON (a non-JSON body is
 *     encoded as `text:` followed by a JSON string), which escapes it, or the bare token
 *     `absent`. Only the path, between them, can.
 *   - Draw (`seed`, `kind`, `key`, `occurrence`): a seed cannot contain it
 *     (see {@link normalizeChaosSeed}); the kind is a fixed word, the key is
 *     hex and the occurrence is a number.
 *   - Occurrence counter id (`testId`, `seed`, `key`): only the testId can
 *     contain it (a `?testId=%1F`), and it is the first field.
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
 * JSON with object keys sorted at every depth, so two PARSED bodies that differ
 * only in key order get one key. Array order is kept. `undefined` (no body) is
 * a bare token that no JSON value can render as. Raw text is not encoded here:
 * {@link canonicalBody} tags it apart first.
 *
 * Iterative, with an explicit work stack, so a body nested to any depth (the
 * body limit allows hundreds of thousands of levels) is keyed instead of
 * overflowing the call stack. The output is the same string a recursive walk
 * gives.
 */
export function canonicalJSON(root: unknown): string {
  const out: string[] = [];
  // A work item is either text to emit as-is, or a value to encode. Pushed in
  // reverse, so items pop in output order.
  const work: ({ text: string } | { value: unknown })[] = [{ value: root }];
  while (work.length > 0) {
    const item = work.pop()!;
    if ("text" in item) {
      out.push(item.text);
      continue;
    }
    const value = item.value;
    if (value === undefined) {
      out.push("absent");
    } else if (value === null || typeof value !== "object") {
      out.push(JSON.stringify(value) ?? "null");
    } else if (Array.isArray(value)) {
      work.push({ text: "]" });
      for (let i = value.length - 1; i >= 0; i--) {
        work.push({ value: value[i] });
        if (i > 0) work.push({ text: "," });
      }
      out.push("[");
    } else {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined);
      work.push({ text: "}" });
      for (let i = keys.length - 1; i >= 0; i--) {
        work.push({ value: record[keys[i]] });
        work.push({ text: `${i > 0 ? "," : ""}${JSON.stringify(keys[i])}:` });
      }
      out.push("{");
    }
  }
  return out.join("");
}

/**
 * The parts of a request that decide its chaos key. Headers are left out on
 * purpose: a retry with a new request id is the same request for fault
 * injection.
 */
export interface ChaosRequestIdentity {
  method: string;
  /**
   * The request target. Pass the raw URL (query string included) when there is one;
   * the key leaves its `testId` query parameter out ({@link chaosKeyPath}).
   */
  path: string;
  /**
   * The request body, or `undefined` for a bodiless request. A JSON body is
   * parsed, so key order and whitespace do not change the key; a JSON `null`
   * body is `null`, not `undefined`. A body that is not JSON is its raw text
   * with {@link ChaosRequestIdentity.rawText} set. For a seeded key this is
   * replaced by the client's own body text when `readBody` recorded one
   * ({@link chaosKeyIdentity}); the body a caller passes is used only without it.
   */
  body: unknown;
  /**
   * `true` when `body` is raw text that did not parse as JSON. It is keyed as
   * that exact string (key order and whitespace inside it DO change the key),
   * and never as the JSON string with the same characters.
   */
  rawText?: boolean;
}

/**
 * The canonical form of a request body for its key. Raw text (a body that did
 * not parse as JSON) is tagged `text:` and encoded as one JSON string, so it
 * never collides with a JSON value: the raw text `hello` and the JSON string
 * `"hello"` get different keys. No JSON value renders with a leading `text:`,
 * and `absent` (no body) is a bare token too, so the three kinds cannot meet.
 */
function canonicalBody(identity: ChaosRequestIdentity): string {
  if (identity.rawText === true && typeof identity.body === "string") {
    return `text:${JSON.stringify(identity.body)}`;
  }
  return canonicalJSON(identity.body);
}

/**
 * The body half of a request identity, from the body text exactly as the
 * client sent it: empty text is no body (`undefined`), text that parses as
 * JSON is the parsed value (a JSON `null` stays `null`), and anything else is
 * the raw text, marked {@link ChaosRequestIdentity.rawText}.
 */
export function chaosBodyFromRaw(raw: string): Pick<ChaosRequestIdentity, "body" | "rawText"> {
  if (raw === "") return { body: undefined };
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return { body: raw, rawText: true };
  }
}

/** A 16-hex-character key for a request identity. */
export function chaosKeyFor(identity: ChaosRequestIdentity): string {
  const material = `${(identity.method || "GET").toUpperCase()}${SEP}${identity.path}${SEP}${canonicalBody(identity)}`;
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
 * usable seed. A finite number becomes `String(value)`, so `42` and `"42"`
 * are one seed. That is JavaScript's number form, not always a plain decimal:
 * `1e21` becomes `"1e+21"` and `0.0000001` becomes `"1e-7"`. A string is
 * trimmed and must then be 1 to {@link MAX_CHAOS_SEED_LENGTH} visible ASCII
 * characters (no spaces, no commas), so it can always be reported back in a
 * response header unchanged and replayed through the `x-aimock-chaos-seed` request header unchanged.
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

/**
 * `JSON.stringify` for a value named in a warning, that never throws. A config
 * written in plain JS can hold anything, and a BigInt (or a cycle) makes
 * `JSON.stringify` throw: the warning about a bad value must not itself crash
 * the request. A BigInt reads as its literal (`42n`); any other value that
 * cannot be serialized reads as `String(value)`. Every value `JSON.stringify`
 * accepts reads exactly as it did.
 */
export function describeChaosValue(raw: unknown): string | undefined {
  try {
    return JSON.stringify(raw);
  } catch {
    if (typeof raw === "bigint") return `${raw}n`;
    try {
      return String(raw);
    } catch {
      return Object.prototype.toString.call(raw);
    }
  }
}

/** Per-chunk jitter draw in [0, 1), indexed by chunk. */
export type JitterSource = (chunkIndex: number) => number;

/**
 * Jitter for one request, on its seed and key. The draw is indexed by the
 * chunk index, passed where `chaosDraw` takes an occurrence; the request's
 * occurrence is not part of it, so the same request streams with the same
 * pacing every time.
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
 * cap that only happens to a key that was idle while 10,000 other
 * (testId, seed, key) counters were used.
 *
 * Counters are namespaced by testId, so two tests that run in parallel on one
 * server keep independent sequences, and a testId-scoped chaos reset does not
 * rewind another testId's. A full reset, and a baseline change, rewind every
 * scope they reach (see {@link clearChaosOccurrences} and
 * {@link clearBaselineChaosOccurrences}).
 *
 * Both fallbacks are logged when a logger is given: an invalid `max` (the
 * default cap applies instead), and an eviction at the cap. The eviction
 * warning is once per burst: it fires on the first eviction, then stays quiet
 * until a clear takes the registry below its cap again, so a server pinned at
 * the cap does not log on every request.
 */
export class ChaosOccurrenceRegistry {
  private readonly counts = new Map<string, { scope: string; count: number }>();
  readonly max: number;
  private readonly logger: Logger | undefined;
  private evictionWarned = false;

  constructor(max: number = DEFAULT_CHAOS_KEYS_MAX, logger?: Logger) {
    this.logger = logger;
    if (Number.isInteger(max) && max > 0) {
      this.max = max;
    } else {
      this.max = DEFAULT_CHAOS_KEYS_MAX;
      logger?.warn(
        `[chaos] invalid chaosKeysMax ${JSON.stringify(max)} — must be a positive integer; ` +
          `using the default of ${DEFAULT_CHAOS_KEYS_MAX}`,
      );
    }
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
      if (!this.evictionWarned) {
        this.evictionWarned = true;
        this.logger?.warn(
          `[chaos] seeded chaos key cap reached (chaosKeysMax=${this.max}): evicting the least ` +
            `recently used key, which restarts at occurrence 0 if seen again. Raise ` +
            `chaosKeysMax to keep more keys. Further evictions are not logged until the ` +
            `counters are cleared.`,
        );
      }
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
    this.rearmEvictionWarning();
  }

  /** Drop every counter. */
  clear(): void {
    this.counts.clear();
    this.rearmEvictionWarning();
  }

  /** A registry back below its cap has ended an eviction burst; the next one is logged. */
  private rearmEvictionWarning(): void {
    if (this.counts.size < this.max) this.evictionWarned = false;
  }
}

/**
 * The registry for callers that pass a plain `ChaosConfig` (or a scope no
 * server registered): embedders calling `evaluateChaos` directly. Bounded like
 * every server's registry. Rewound by {@link resetChaosOccurrences}.
 *
 * There is no server logger here, and the caller's logger does not reach a
 * process-wide registry, so it gets its own warn-level `Logger`: the cap
 * eviction warning prints through `console.warn` with the `[aimock]` prefix,
 * once per burst like a server registry's, instead of evicting silently.
 */
export const fallbackChaosOccurrences = new ChaosOccurrenceRegistry(
  DEFAULT_CHAOS_KEYS_MAX,
  new Logger("warn"),
);

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
 * the server (`runInChaosRequestScope`). The client body text is recorded by
 * `readBody` when it reads a text body, and the request identity by the split
 * gates that call {@link setRequestChaosIdentity}, seeded or not; a route's
 * `applyChaos` passes its identity directly instead. The origin and the
 * jitter source are written only when the request resolved a seed, and an
 * unseeded verdict clears them, so an unseeded request has neither: its jitter
 * stays on `Math.random()` and its chaos response carries nothing new.
 */
interface ChaosRequestState {
  identity?: ChaosRequestIdentity;
  /**
   * The request body text exactly as the client sent it, recorded by
   * `readBody` (`src/helpers.ts`) the first time the request's body is read.
   * A seeded key is built from this, not from the body a handler hands the
   * chaos roll, which is often the TRANSLATED request carrying internal fields
   * (`_endpointType`, and `_context` copied from the `X-AIMock-Context`
   * header). Absent when the body was not read as text (no body read yet, a
   * multipart upload, or a binary route): the handler's body is used then.
   */
  clientBody?: string;
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

/**
 * Record the body text the client sent for the request being served. The
 * FIRST call wins: a later `readBody` in the same request cannot replace it.
 * (`readBody` records only a server request's body, never a response it reads.) A no-op outside a request scope.
 */
export function recordRequestChaosBody(raw: string): void {
  const state = chaosRequestScope.getStore();
  if (state && state.clientBody === undefined) state.clientBody = raw;
}

/** The client body text recorded for the request being served, or `undefined`. */
export function currentChaosClientBody(): string | undefined {
  return chaosRequestScope.getStore()?.clientBody;
}

/**
 * The identity a seeded key is built from. The body is the client's own body
 * text when one was recorded ({@link recordRequestChaosBody}), so the key
 * depends on what the client sent and never on the handler's translation of
 * it or on headers copied into it. Otherwise it is the body the caller passed,
 * with its top-level `_`-prefixed internal fields left out for the same reason.
 * The path leaves out the `testId` query parameter ({@link chaosKeyPath}).
 */
export function chaosKeyIdentity(identity: ChaosRequestIdentity): ChaosRequestIdentity {
  const path = chaosKeyPath(identity.path);
  const clientBody = currentChaosClientBody();
  if (clientBody !== undefined) {
    return { method: identity.method, path, ...chaosBodyFromRaw(clientBody) };
  }
  const { body } = identity;
  const plain =
    identity.rawText === true || body === null || typeof body !== "object" || Array.isArray(body);
  if (plain || !Object.keys(body).some((k) => k.startsWith("_"))) return { ...identity, path };
  const record = body as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(record)) if (!k.startsWith("_")) clean[k] = record[k];
  return { method: identity.method, path, body: clean };
}

/**
 * The request target as a seeded key sees it: the `testId` query parameter is
 * left out, because `?testId=x` and the `X-Test-Id: x` header tag the same
 * test and must give the same key. Every other query parameter is kept, in
 * order and as sent. A parameter name is compared percent-decoded, with `+` as
 * a space, the way `resolveTestId` reads it.
 */
export function chaosKeyPath(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const kept = url
    .slice(q + 1)
    .split("&")
    .filter((part) => {
      const eq = part.indexOf("=");
      const rawName = (eq === -1 ? part : part.slice(0, eq)).replace(/\+/g, " ");
      let name = rawName;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        // A malformed escape is not `testId`; keep the part as sent.
      }
      return name !== "testId";
    });
  return kept.length > 0 ? `${url.slice(0, q)}?${kept.join("&")}` : url.slice(0, q);
}

/** The identity recorded for the request being served, or `undefined`. */
export function currentChaosIdentity(): ChaosRequestIdentity | undefined {
  return chaosRequestScope.getStore()?.identity;
}

let warnedSeedingOutsideScope = false;

/**
 * Record a seeded verdict's origin and jitter source for the request being served.
 *
 * Outside a request scope (an embedder calling `evaluateChaos` directly) there
 * is no per-request place to keep the jitter source: a process-wide slot would
 * hand one call's pacing to another, concurrent one. The verdict itself stays
 * seeded, but stream jitter stays on `Math.random()`. That is warned once per
 * process through `logger` (or `console.warn` with the `[aimock]` prefix when
 * there is none, as the `applyChaos` notice does), never dropped silently.
 */
export function setRequestChaosSeeding(
  origin: ChaosOrigin,
  jitter: JitterSource,
  logger?: Logger,
): void {
  const state = chaosRequestScope.getStore();
  if (!state) {
    if (!warnedSeedingOutsideScope) {
      warnedSeedingOutsideScope = true;
      const notice =
        "[chaos] seeded chaos verdict outside a server request: the verdict is seeded, " +
        "but stream jitter is not and falls back to Math.random(). (Warned once per process.)";
      if (logger) logger.warn(notice);
      else console.warn(`[aimock] ${notice}`);
    }
    return;
  }
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
