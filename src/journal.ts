import { generateId } from "./helpers.js";
import type {
  ChatCompletionRequest,
  Fixture,
  FixtureMatch,
  JournalBody,
  JournalEntry,
  MisbehaviorCounterKey,
  MisbehaviorCounters,
} from "./types.js";
import { DEFAULT_TEST_ID } from "./constants.js";
export { DEFAULT_TEST_ID } from "./constants.js";

/**
 * Maximum UTF-8 byte length of a serialized request body retained in a
 * journal entry. Bodies whose JSON serialization exceeds this byte size are
 * replaced with a truncation marker.
 *
 * Only the request `body` field is capped here. `headers` and `path` are
 * retained uncapped, but they are naturally bounded by Node's default ~16 KB
 * maximum HTTP header size, so the per-entry overhead beyond the body cap
 * remains small. Combined with the journal's maxEntries limit (default 1000),
 * the total `JSON.stringify(journal.getAll())` output stays well under V8's
 * ~512 MB string limit even at maximum capacity.
 */
const JOURNAL_BODY_CAP_BYTES = 64 * 1024; // 64 KB

/**
 * If `body` serializes to more than JOURNAL_BODY_CAP_BYTES (in UTF-8 bytes),
 * replace it with a truncation marker. Returns the original body when within
 * the cap, or null when `body` is null.
 *
 * The gate uses Buffer.byteLength (UTF-8 bytes) rather than .length (UTF-16
 * code units) to match the constant name and to correctly cap multibyte
 * content (e.g. CJK/emoji) whose code-unit count falls under the threshold
 * but whose byte size does not.
 */
function capBody(body: JournalBody | null): JournalBody | null {
  if (body === null) return null;
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") <= JOURNAL_BODY_CAP_BYTES) return body;
  // The marker is not a chat request, and `JournalBody` no longer claims it is
  // — downstream consumers (e.g. GET /journal) treat the body as opaque JSON.
  return {
    __aimock_truncated: true,
    originalByteSize: Buffer.byteLength(serialized, "utf8"),
    note: "body truncated by aimock journal cap (64 KB limit)",
  };
}

/**
 * Narrow a journaled body to a chat-completion request.
 *
 * `JournalEntry.body` is a union (see {@link JournalBody}): most entries hold a
 * chat request, but the fine-tuning create payload and this module's own
 * truncation marker do not. Anything reading `messages`, `model` or the rest of
 * the chat shape off a journal entry — inside aimock or in a consumer's test
 * — goes through here, so an entry that is not a chat request fails as a
 * `false` it can assert on rather than as an undefined property three accesses
 * later.
 *
 * `messages` is the discriminator because it is the one required field no
 * other journaled shape carries.
 */
export function isChatCompletionBody(
  body: JournalBody | null | undefined,
): body is ChatCompletionRequest {
  return (
    body !== null &&
    body !== undefined &&
    Array.isArray((body as { messages?: unknown }).messages) &&
    typeof (body as { model?: unknown }).model === "string"
  );
}

/**
 * Compare two field values, handling RegExp by source+flags rather than reference.
 */
function fieldEqual(a: unknown, b: unknown): boolean {
  if (a instanceof RegExp && b instanceof RegExp)
    return a.source === b.source && a.flags === b.flags;
  return a === b;
}

/**
 * Compare two systemMessage values. Handles string, string[], and RegExp.
 * Both-undefined is treated as equal.
 */
function systemMessageEqual(
  a: string | string[] | RegExp | undefined,
  b: string | string[] | RegExp | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i]);
  if (a instanceof RegExp && b instanceof RegExp)
    return a.source === b.source && a.flags === b.flags;
  return false;
}

/**
 * Check whether two fixture match objects have the same criteria
 * (ignoring sequenceIndex). Used to group sequenced fixtures.
 */
function matchCriteriaEqual(a: FixtureMatch, b: FixtureMatch): boolean {
  return (
    fieldEqual(a.userMessage, b.userMessage) &&
    systemMessageEqual(a.systemMessage, b.systemMessage) &&
    fieldEqual(a.inputText, b.inputText) &&
    fieldEqual(a.toolCallId, b.toolCallId) &&
    fieldEqual(a.toolName, b.toolName) &&
    fieldEqual(a.model, b.model) &&
    fieldEqual(a.responseFormat, b.responseFormat) &&
    fieldEqual(a.predicate, b.predicate) &&
    fieldEqual(a.endpoint, b.endpoint) &&
    fieldEqual(a.turnIndex, b.turnIndex) &&
    fieldEqual(a.hasToolResult, b.hasToolResult) &&
    fieldEqual(a.toolResultContains, b.toolResultContains) &&
    fieldEqual(a.context, b.context)
  );
}

export interface JournalOptions {
  /**
   * Maximum number of entries to retain. When exceeded, oldest entries are
   * dropped FIFO. Set to 0 (or omit) for unbounded retention (the historical
   * default — suitable for short-lived test runs only). Negative values are
   * rejected at the CLI parse layer; programmatically they are treated as 0
   * (unbounded) for back-compat.
   *
   * Long-running servers (e.g. mock proxies in CI/demo environments) should
   * always set a finite cap: every request appends an entry holding the
   * request body + headers + fixture reference, and without a cap the
   * journal grows until the process OOMs.
   */
  maxEntries?: number;
  /**
   * Maximum number of unique testIds retained across fixture match-count
   * and misbehavior counters. When exceeded, the oldest testId
   * (by first-insertion order) is evicted FIFO. Set to 0 (or omit) for
   * unbounded retention. Negative values are rejected at the CLI parse
   * layer; programmatically they are treated as 0 (unbounded) for
   * back-compat. Without a cap this map can grow over time in long-running
   * servers that see many unique testIds.
   */
  fixtureCountsMaxTestIds?: number;
  /**
   * Called with every entry {@link Journal.add} creates, right after it is
   * recorded. The hook exists so an embedder can attribute an entry to the
   * request that produced it WITHOUT touching each of the ~100 `journal.add`
   * call sites spread across the handler modules: the server binds the entry
   * to the in-flight `IncomingMessage` here, and its error arm then amends
   * that exact object rather than guessing from a caller-supplied header.
   *
   * The entry is already recorded when the hook runs, so a hook that throws
   * does not lose the write — but it does propagate out of `add` into the
   * caller's error path, so a hook must not throw.
   */
  onAdd?: (entry: JournalEntry) => void;
}

export class Journal implements MisbehaviorCounters {
  private entries: JournalEntry[] = [];
  private readonly matchedFixtures = new WeakMap<JournalEntry, Fixture>();
  private readonly fixtureMatchCountsByTestId: Map<string, Map<Fixture, number>> = new Map();
  private fixtureCountIdentity = (fixture: Fixture): Fixture => fixture;
  private createFixtureCountMap = (): Map<Fixture, number> => new Map();
  private fixtureCountIdentityConfigured = false;
  private readonly counterTestIds = new Set<string>();
  private readonly misbehaviorCountersByTestId = new Map<
    string,
    Map<string, Map<number, { ordinal: number; firings: number }>>
  >();
  private readonly maxEntries: number;
  private readonly fixtureCountsMaxTestIds: number;
  private readonly onAdd?: (entry: JournalEntry) => void;

  constructor(options: JournalOptions = {}) {
    this.onAdd = options.onAdd;
    // Treat 0 or negative as "unbounded" to preserve prior behavior when
    // the option is omitted or explicitly disabled.
    const cap = options.maxEntries;
    this.maxEntries = cap !== undefined && cap > 0 ? cap : 0;
    const testIdCap = options.fixtureCountsMaxTestIds;
    this.fixtureCountsMaxTestIds = testIdCap !== undefined && testIdCap > 0 ? testIdCap : 0;
  }

  /**
   * The per-test-id cap on fixture match-count maps, for an MCP mount to pass
   * to `McpFakeStore.setMaxTestIds`. Always a non-negative safe integer, `0`
   * meaning unbounded, and never throws, whatever option was passed:
   * omitted, zero, negative or `NaN` is `0`; `Infinity` or a value above
   * `Number.MAX_SAFE_INTEGER` (never reached) is `0`; a fraction of 1 or more
   * is rounded down (`1.5` evicts at 2 ids, so it keeps 1). For these values
   * it is the number of test ids the journal keeps.
   *
   * An option between 0 and 1 is the exception. The journal keeps no test id
   * (each new count map is evicted as soon as it is made, so counts never
   * advance), and a store cap cannot say "keep none" because `0` is
   * unbounded. The getter returns `1`, the smallest bounded cap, so a store
   * given it keeps 1 test id where the journal keeps 0.
   */
  get fixtureCountsMaxTestIdsCap(): number {
    const cap = this.fixtureCountsMaxTestIds;
    if (!(cap > 0) || cap > Number.MAX_SAFE_INTEGER) return 0;
    return Math.max(1, Math.floor(cap));
  }

  /** Backwards-compatible accessor — returns the default (no testId) count map. */
  get fixtureMatchCounts(): Map<Fixture, number> {
    return this.getFixtureMatchCountsForTest(DEFAULT_TEST_ID);
  }

  /** @internal matchedFixture preserves identity when Live supplies safe diagnostics. */
  add(entry: Omit<JournalEntry, "id" | "timestamp">, matchedFixture?: Fixture): JournalEntry {
    const full: JournalEntry = {
      id: generateId("req"),
      timestamp: Date.now(),
      ...entry,
      body: capBody(entry.body),
    };
    if (matchedFixture) this.matchedFixtures.set(full, matchedFixture);
    this.entries.push(full);
    // FIFO eviction when over capacity. Array.prototype.shift() is O(n)
    // regardless of how many we drop per add; we accept it at small caps
    // (default 1000) because the constant factor is tiny and this runs once
    // per request. For much larger caps, switch to a ring buffer for true
    // O(1) eviction.
    if (this.maxEntries > 0 && this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.onAdd?.(full);
    return full;
  }

  /**
   * Return every entry, or with `limit` the most recent `limit` entries.
   * `0` returns `[]` — exactly what `GET /__aimock/journal?limit=0` answers.
   * `slice(-0)` is `slice(0)`, so a `0` used to return the ENTIRE journal; it
   * is special-cased so the library and the HTTP route agree. This is a public
   * library API, so odd limits are tolerated rather than thrown on: a
   * non-finite limit (`NaN`, `Infinity`) means "no limit", a fractional limit
   * floors, and any limit at or below `0` asks for nothing.
   */
  getAll(opts?: { limit?: number }): JournalEntry[] {
    if (opts?.limit !== undefined && Number.isFinite(opts.limit)) {
      const limit = Math.floor(opts.limit);
      if (limit <= 0) return [];
      return this.entries.slice(-limit);
    }
    return this.entries.slice();
  }

  getLast(): JournalEntry | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
  }

  findByFixture(fixture: Fixture): JournalEntry[] {
    return this.entries.filter(
      (e) => (this.matchedFixtures.get(e) ?? e.response.fixture) === fixture,
    );
  }

  /**
   * READ-ONLY accessor. Returns the existing count map for `testId`, or an
   * empty transient Map if none exists. Does NOT insert into the cache and
   * does NOT trigger FIFO eviction — callers may read freely without
   * perturbing cache state. For the write path, see
   * `getOrCreateFixtureMatchCountsForTest`.
   */
  getFixtureMatchCountsForTest(testId: string): Map<Fixture, number> {
    return this.fixtureMatchCountsByTestId.get(testId) ?? this.createFixtureCountMap();
  }

  /**
   * WRITE path: get the count map for `testId`, inserting a fresh empty Map
   * if missing and running FIFO eviction when the testId cap is exceeded.
   * Only callers that intend to mutate the map (e.g. incrementing a count)
   * should use this.
   */
  private getOrCreateFixtureMatchCountsForTest(testId: string): Map<Fixture, number> {
    let counts = this.fixtureMatchCountsByTestId.get(testId);
    if (!counts) {
      counts = this.createFixtureCountMap();
      this.fixtureMatchCountsByTestId.set(testId, counts);
      this.admitCounterTestId(testId);
    }
    return counts;
  }

  /** Match and fault mutations share one admission order and capacity. */
  private admitCounterTestId(testId: string): void {
    this.counterTestIds.add(testId);
    if (
      this.fixtureCountsMaxTestIds > 0 &&
      this.counterTestIds.size > this.fixtureCountsMaxTestIds
    ) {
      const oldest = this.counterTestIds.values().next().value;
      if (oldest !== undefined) {
        this.counterTestIds.delete(oldest);
        this.fixtureMatchCountsByTestId.delete(oldest);
        this.misbehaviorCountersByTestId.delete(oldest);
      }
    }
  }

  private getOrCreateMisbehaviorCounter(key: MisbehaviorCounterKey) {
    let sources = this.misbehaviorCountersByTestId.get(key.testId);
    if (!sources) {
      sources = new Map();
      this.misbehaviorCountersByTestId.set(key.testId, sources);
      this.admitCounterTestId(key.testId);
    }
    let entries = sources.get(key.sourceKey);
    if (!entries) {
      entries = new Map();
      sources.set(key.sourceKey, entries);
    }
    let counter = entries.get(key.entryIndex);
    if (!counter) {
      counter = { ordinal: 0, firings: 0 };
      entries.set(key.entryIndex, counter);
    }
    return counter;
  }

  getFiringCount(key: MisbehaviorCounterKey): number {
    return (
      this.misbehaviorCountersByTestId.get(key.testId)?.get(key.sourceKey)?.get(key.entryIndex)
        ?.firings ?? 0
    );
  }

  nextOrdinal(key: MisbehaviorCounterKey): number {
    return this.getOrCreateMisbehaviorCounter(key).ordinal++;
  }

  recordFiring(key: MisbehaviorCounterKey): void {
    this.getOrCreateMisbehaviorCounter(key).firings++;
  }

  clearMisbehaviorCounters(testId?: string): void {
    if (testId !== undefined) {
      this.misbehaviorCountersByTestId.delete(testId);
      if (!this.fixtureMatchCountsByTestId.has(testId)) this.counterTestIds.delete(testId);
    } else {
      this.misbehaviorCountersByTestId.clear();
      for (const id of this.counterTestIds) {
        if (!this.fixtureMatchCountsByTestId.has(id)) this.counterTestIds.delete(id);
      }
    }
  }

  /** @internal LLMock configures caller count identity before serving requests. */
  configureFixtureCountIdentity(
    identity: (fixture: Fixture) => Fixture,
    createMap: () => Map<Fixture, number>,
  ): void {
    if (this.fixtureCountIdentityConfigured || this.fixtureMatchCountsByTestId.size > 0) {
      throw new Error("Fixture count identity must be configured once before counting");
    }
    this.fixtureCountIdentity = identity;
    this.createFixtureCountMap = createMap;
    this.fixtureCountIdentityConfigured = true;
  }

  getFixtureMatchCount(fixture: Fixture, testId = DEFAULT_TEST_ID): number {
    return this.getFixtureMatchCountsForTest(testId).get(fixture) ?? 0;
  }

  incrementFixtureMatchCount(
    fixture: Fixture,
    allFixtures?: readonly Fixture[],
    testId = DEFAULT_TEST_ID,
  ): void {
    const counts = this.getOrCreateFixtureMatchCountsForTest(testId);
    counts.set(fixture, (counts.get(fixture) ?? 0) + 1);
    // When a sequenced fixture matches, also increment all siblings with matching criteria
    if (fixture.match.sequenceIndex !== undefined && allFixtures) {
      for (const sibling of allFixtures) {
        if (this.fixtureCountIdentity(sibling) === this.fixtureCountIdentity(fixture)) continue;
        if (sibling.match.sequenceIndex === undefined) continue;
        if (matchCriteriaEqual(fixture.match, sibling.match)) {
          counts.set(sibling, (counts.get(sibling) ?? 0) + 1);
        }
      }
    }
  }

  clearMatchCounts(testId?: string): void {
    if (testId !== undefined) {
      this.fixtureMatchCountsByTestId.delete(testId);
      this.clearMisbehaviorCounters(testId);
    } else {
      this.fixtureMatchCountsByTestId.clear();
      this.clearMisbehaviorCounters();
    }
  }

  /**
   * Clear ONLY the request journal entries, preserving fixture match-counts.
   * Match-counts are fixture-matching/sequencing state, not journal data, so
   * clearing the journal must not silently rewind sequenced fixtures. Used by
   * `POST /__aimock/reset/journal`. For a full reset (entries + match-counts),
   * use `clear()` instead.
   */
  clearEntries(): void {
    this.entries = [];
  }

  clear(): void {
    this.entries = [];
    this.clearMatchCounts();
  }

  get size(): number {
    return this.entries.length;
  }
}
