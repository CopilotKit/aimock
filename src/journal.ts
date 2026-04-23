import { generateId } from "./helpers.js";
import type { Fixture, FixtureMatch, JournalEntry } from "./types.js";

/** Sentinel testId used when no explicit test scope is provided. */
export const DEFAULT_TEST_ID = "__default__";

/**
 * Compare two field values, handling RegExp by source+flags rather than reference.
 */
function fieldEqual(a: unknown, b: unknown): boolean {
  if (a instanceof RegExp && b instanceof RegExp)
    return a.source === b.source && a.flags === b.flags;
  return a === b;
}

/**
 * Check whether two fixture match objects have the same criteria
 * (ignoring sequenceIndex). Used to group sequenced fixtures.
 */
function matchCriteriaEqual(a: FixtureMatch, b: FixtureMatch): boolean {
  return (
    fieldEqual(a.userMessage, b.userMessage) &&
    fieldEqual(a.inputText, b.inputText) &&
    fieldEqual(a.toolCallId, b.toolCallId) &&
    fieldEqual(a.toolName, b.toolName) &&
    fieldEqual(a.model, b.model) &&
    fieldEqual(a.responseFormat, b.responseFormat) &&
    fieldEqual(a.predicate, b.predicate) &&
    fieldEqual(a.endpoint, b.endpoint)
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
   * Maximum number of unique testIds retained in the fixture match-count
   * map (`fixtureMatchCountsByTestId`). When exceeded, the oldest testId
   * (by first-insertion order) is evicted FIFO. Set to 0 (or omit) for
   * unbounded retention. Negative values are rejected at the CLI parse
   * layer; programmatically they are treated as 0 (unbounded) for
   * back-compat. Without a cap this map can grow over time in long-running
   * servers that see many unique testIds.
   */
  fixtureCountsMaxTestIds?: number;
}

export class Journal {
  private entries: JournalEntry[] = [];
  private readonly fixtureMatchCountsByTestId: Map<string, Map<Fixture, number>> = new Map();
  private readonly maxEntries: number;
  private readonly fixtureCountsMaxTestIds: number;

  constructor(options: JournalOptions = {}) {
    // Treat 0 or negative as "unbounded" to preserve prior behavior when
    // the option is omitted or explicitly disabled.
    const cap = options.maxEntries;
    this.maxEntries = cap !== undefined && cap > 0 ? cap : 0;
    const testIdCap = options.fixtureCountsMaxTestIds;
    this.fixtureCountsMaxTestIds = testIdCap !== undefined && testIdCap > 0 ? testIdCap : 0;
  }

  /** Backwards-compatible accessor — returns the default (no testId) count map. */
  get fixtureMatchCounts(): Map<Fixture, number> {
    return this.getFixtureMatchCountsForTest(DEFAULT_TEST_ID);
  }

  add(entry: Omit<JournalEntry, "id" | "timestamp">): JournalEntry {
    const full: JournalEntry = {
      id: generateId("req"),
      timestamp: Date.now(),
      ...entry,
    };
    this.entries.push(full);
    // FIFO eviction when over capacity. Array.prototype.shift() is O(n)
    // regardless of how many we drop per add; we accept it at small caps
    // (default 1000) because the constant factor is tiny and this runs once
    // per request. For much larger caps, switch to a ring buffer for true
    // O(1) eviction.
    if (this.maxEntries > 0 && this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    return full;
  }

  getAll(opts?: { limit?: number }): JournalEntry[] {
    if (opts?.limit !== undefined) {
      return this.entries.slice(-opts.limit);
    }
    return this.entries.slice();
  }

  getLast(): JournalEntry | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
  }

  findByFixture(fixture: Fixture): JournalEntry[] {
    return this.entries.filter((e) => e.response.fixture === fixture);
  }

  /**
   * READ-ONLY accessor. Returns the existing count map for `testId`, or an
   * empty transient Map if none exists. Does NOT insert into the cache and
   * does NOT trigger FIFO eviction — callers may read freely without
   * perturbing cache state. For the write path, see
   * `getOrCreateFixtureMatchCountsForTest`.
   */
  getFixtureMatchCountsForTest(testId: string): Map<Fixture, number> {
    return this.fixtureMatchCountsByTestId.get(testId) ?? new Map();
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
      counts = new Map();
      this.fixtureMatchCountsByTestId.set(testId, counts);
      // FIFO eviction when over capacity. JS Map preserves insertion order,
      // so the first key returned by keys() is the oldest. Same O(n) shift
      // caveat as `entries`: acceptable at small caps (default 500).
      if (
        this.fixtureCountsMaxTestIds > 0 &&
        this.fixtureMatchCountsByTestId.size > this.fixtureCountsMaxTestIds
      ) {
        const oldest = this.fixtureMatchCountsByTestId.keys().next().value;
        if (oldest !== undefined) {
          this.fixtureMatchCountsByTestId.delete(oldest);
        }
      }
    }
    return counts;
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
        if (sibling === fixture) continue;
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
    } else {
      this.fixtureMatchCountsByTestId.clear();
    }
  }

  clear(): void {
    this.entries = [];
    this.fixtureMatchCountsByTestId.clear();
  }

  get size(): number {
    return this.entries.length;
  }
}
