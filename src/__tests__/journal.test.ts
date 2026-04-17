import { describe, it, expect } from "vitest";
import { Journal } from "../journal.js";
import type { Fixture, JournalEntry } from "../types.js";

// Minimal valid entry fields (everything except id and timestamp)
function makeEntry(
  overrides: Partial<Omit<JournalEntry, "id" | "timestamp">> = {},
): Omit<JournalEntry, "id" | "timestamp"> {
  return {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: {
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
    },
    response: { status: 200, fixture: null },
    ...overrides,
  };
}

describe("Journal", () => {
  describe("add", () => {
    it("returns the stored entry with id and timestamp assigned", () => {
      const journal = new Journal();
      const entry = journal.add(makeEntry());

      expect(entry.id).toMatch(/^req-/);
      expect(typeof entry.timestamp).toBe("number");
      expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
      expect(entry.method).toBe("POST");
      expect(entry.path).toBe("/v1/chat/completions");
    });

    it("assigns unique ids to each entry", () => {
      const journal = new Journal();
      const ids = Array.from({ length: 20 }, () => journal.add(makeEntry()).id);
      const unique = new Set(ids);
      expect(unique.size).toBe(20);
    });

    it("preserves all supplied fields on the returned entry", () => {
      const journal = new Journal();
      const entry = journal.add(
        makeEntry({
          method: "GET",
          path: "/custom",
          headers: { authorization: "Bearer tok" },
          response: { status: 404, fixture: null },
        }),
      );

      expect(entry.method).toBe("GET");
      expect(entry.path).toBe("/custom");
      expect(entry.headers).toEqual({ authorization: "Bearer tok" });
      expect(entry.response.status).toBe(404);
    });
  });

  describe("size", () => {
    it("starts at zero", () => {
      const journal = new Journal();
      expect(journal.size).toBe(0);
    });

    it("increments with each add", () => {
      const journal = new Journal();
      journal.add(makeEntry());
      expect(journal.size).toBe(1);
      journal.add(makeEntry());
      expect(journal.size).toBe(2);
    });
  });

  describe("getAll", () => {
    it("returns entries in insertion order", () => {
      const journal = new Journal();
      const e1 = journal.add(makeEntry({ path: "/a" }));
      const e2 = journal.add(makeEntry({ path: "/b" }));
      const e3 = journal.add(makeEntry({ path: "/c" }));

      const all = journal.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].id).toBe(e1.id);
      expect(all[1].id).toBe(e2.id);
      expect(all[2].id).toBe(e3.id);
    });

    it("returns a copy — mutations do not affect internal state", () => {
      const journal = new Journal();
      journal.add(makeEntry());
      const all = journal.getAll();
      all.pop();
      expect(journal.size).toBe(1);
    });

    it("returns all entries when no limit is provided", () => {
      const journal = new Journal();
      for (let i = 0; i < 5; i++) journal.add(makeEntry({ path: `/${i}` }));
      expect(journal.getAll()).toHaveLength(5);
    });

    it("returns the last N entries when limit is given", () => {
      const journal = new Journal();
      for (let i = 0; i < 5; i++) journal.add(makeEntry({ path: `/${i}` }));

      const limited = journal.getAll({ limit: 3 });
      expect(limited).toHaveLength(3);
      expect(limited[0].path).toBe("/2");
      expect(limited[1].path).toBe("/3");
      expect(limited[2].path).toBe("/4");
    });

    it("returns all entries when limit exceeds count", () => {
      const journal = new Journal();
      journal.add(makeEntry());
      journal.add(makeEntry());

      expect(journal.getAll({ limit: 100 })).toHaveLength(2);
    });

    it("returns empty array when journal is empty", () => {
      const journal = new Journal();
      expect(journal.getAll()).toEqual([]);
      expect(journal.getAll({ limit: 5 })).toEqual([]);
    });
  });

  describe("getLast", () => {
    it("returns null when journal is empty", () => {
      const journal = new Journal();
      expect(journal.getLast()).toBeNull();
    });

    it("returns the most recently added entry", () => {
      const journal = new Journal();
      journal.add(makeEntry({ path: "/first" }));
      const last = journal.add(makeEntry({ path: "/last" }));

      expect(journal.getLast()!.id).toBe(last.id);
      expect(journal.getLast()!.path).toBe("/last");
    });

    it("updates after each add", () => {
      const journal = new Journal();
      journal.add(makeEntry({ path: "/a" }));
      expect(journal.getLast()!.path).toBe("/a");

      journal.add(makeEntry({ path: "/b" }));
      expect(journal.getLast()!.path).toBe("/b");
    });
  });

  describe("findByFixture", () => {
    it("returns entries matching the given fixture reference", () => {
      const journal = new Journal();
      const fixtureA: Fixture = { match: { userMessage: "a" }, response: { content: "A" } };
      const fixtureB: Fixture = { match: { userMessage: "b" }, response: { content: "B" } };

      journal.add(makeEntry({ response: { status: 200, fixture: fixtureA } }));
      journal.add(makeEntry({ response: { status: 200, fixture: fixtureB } }));
      journal.add(makeEntry({ response: { status: 200, fixture: fixtureA } }));

      const results = journal.findByFixture(fixtureA);
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.response.fixture === fixtureA)).toBe(true);
    });

    it("returns empty array when no entries match", () => {
      const journal = new Journal();
      const fixture: Fixture = { match: { userMessage: "x" }, response: { content: "X" } };
      journal.add(makeEntry());

      expect(journal.findByFixture(fixture)).toEqual([]);
    });

    it("returns empty array on empty journal", () => {
      const journal = new Journal();
      const fixture: Fixture = { match: { userMessage: "x" }, response: { content: "X" } };
      expect(journal.findByFixture(fixture)).toEqual([]);
    });
  });

  describe("fixture match counting", () => {
    it("incrementFixtureMatchCount increments siblings with same criteria but different sequenceIndex", () => {
      const journal = new Journal();
      const f0: Fixture = {
        match: { userMessage: "hello", sequenceIndex: 0 },
        response: { content: "First" },
      };
      const f1: Fixture = {
        match: { userMessage: "hello", sequenceIndex: 1 },
        response: { content: "Second" },
      };
      const allFixtures = [f0, f1];

      journal.incrementFixtureMatchCount(f0, allFixtures);

      expect(journal.getFixtureMatchCount(f0)).toBe(1);
      expect(journal.getFixtureMatchCount(f1)).toBe(1);
    });

    it("incrementFixtureMatchCount does NOT treat fixtures differing on a field as siblings", () => {
      const journal = new Journal();
      const f0: Fixture = {
        match: { userMessage: "hello", sequenceIndex: 0 },
        response: { content: "First" },
      };
      const f1: Fixture = {
        match: { userMessage: "goodbye", sequenceIndex: 1 },
        response: { content: "Second" },
      };
      const allFixtures = [f0, f1];

      journal.incrementFixtureMatchCount(f0, allFixtures);

      expect(journal.getFixtureMatchCount(f0)).toBe(1);
      expect(journal.getFixtureMatchCount(f1)).toBe(0);
    });

    it("incrementFixtureMatchCount without allFixtures does not increment siblings", () => {
      const journal = new Journal();
      const f0: Fixture = {
        match: { userMessage: "hello", sequenceIndex: 0 },
        response: { content: "First" },
      };
      const f1: Fixture = {
        match: { userMessage: "hello", sequenceIndex: 1 },
        response: { content: "Second" },
      };

      journal.incrementFixtureMatchCount(f0);

      expect(journal.getFixtureMatchCount(f0)).toBe(1);
      expect(journal.getFixtureMatchCount(f1)).toBe(0);
    });

    it("clearMatchCounts clears the map", () => {
      const journal = new Journal();
      const f: Fixture = {
        match: { userMessage: "hello" },
        response: { content: "Hi" },
      };

      journal.incrementFixtureMatchCount(f);
      expect(journal.getFixtureMatchCount(f)).toBe(1);

      journal.clearMatchCounts();
      expect(journal.getFixtureMatchCount(f)).toBe(0);
    });

    it("RegExp-based sequenced fixtures are correctly grouped as siblings", () => {
      const journal = new Journal();
      const f0: Fixture = {
        match: { userMessage: /hel+o/, sequenceIndex: 0 },
        response: { content: "First" },
      };
      const f1: Fixture = {
        match: { userMessage: /hel+o/, sequenceIndex: 1 },
        response: { content: "Second" },
      };
      const allFixtures = [f0, f1];

      journal.incrementFixtureMatchCount(f0, allFixtures);

      expect(journal.getFixtureMatchCount(f0)).toBe(1);
      expect(journal.getFixtureMatchCount(f1)).toBe(1);
    });

    it("RegExp fixtures with different patterns are NOT siblings", () => {
      const journal = new Journal();
      const f0: Fixture = {
        match: { userMessage: /hello/, sequenceIndex: 0 },
        response: { content: "First" },
      };
      const f1: Fixture = {
        match: { userMessage: /world/, sequenceIndex: 1 },
        response: { content: "Second" },
      };
      const allFixtures = [f0, f1];

      journal.incrementFixtureMatchCount(f0, allFixtures);

      expect(journal.getFixtureMatchCount(f0)).toBe(1);
      expect(journal.getFixtureMatchCount(f1)).toBe(0);
    });
  });

  describe("clear", () => {
    it("empties the journal", () => {
      const journal = new Journal();
      journal.add(makeEntry());
      journal.add(makeEntry());

      journal.clear();
      expect(journal.size).toBe(0);
      expect(journal.getAll()).toEqual([]);
      expect(journal.getLast()).toBeNull();
    });

    it("allows adding entries after clearing", () => {
      const journal = new Journal();
      journal.add(makeEntry());
      journal.clear();

      const entry = journal.add(makeEntry({ path: "/after-clear" }));
      expect(journal.size).toBe(1);
      expect(journal.getLast()!.id).toBe(entry.id);
    });
  });

  describe("maxEntries (FIFO eviction)", () => {
    it("caps entries to maxEntries, dropping oldest (FIFO)", () => {
      const journal = new Journal({ maxEntries: 3 });

      journal.add(makeEntry({ path: "/a" }));
      journal.add(makeEntry({ path: "/b" }));
      journal.add(makeEntry({ path: "/c" }));
      journal.add(makeEntry({ path: "/d" }));
      journal.add(makeEntry({ path: "/e" }));

      expect(journal.size).toBe(3);
      const all = journal.getAll();
      expect(all.map((e) => e.path)).toEqual(["/c", "/d", "/e"]);
    });

    it("does not cap when maxEntries is unset (backwards compat)", () => {
      const journal = new Journal();
      for (let i = 0; i < 5000; i++) journal.add(makeEntry({ path: `/${i}` }));
      expect(journal.size).toBe(5000);
    });

    it("treats maxEntries = 0 or negative as uncapped", () => {
      const journal0 = new Journal({ maxEntries: 0 });
      const journalNeg = new Journal({ maxEntries: -1 });
      for (let i = 0; i < 100; i++) {
        journal0.add(makeEntry({ path: `/${i}` }));
        journalNeg.add(makeEntry({ path: `/${i}` }));
      }
      expect(journal0.size).toBe(100);
      expect(journalNeg.size).toBe(100);
    });

    it("getLast returns the most recent after eviction", () => {
      const journal = new Journal({ maxEntries: 2 });
      journal.add(makeEntry({ path: "/a" }));
      journal.add(makeEntry({ path: "/b" }));
      const last = journal.add(makeEntry({ path: "/c" }));
      expect(journal.getLast()!.id).toBe(last.id);
      expect(journal.getLast()!.path).toBe("/c");
    });

    it("findByFixture only returns surviving entries after eviction", () => {
      const journal = new Journal({ maxEntries: 2 });
      const fixture: Fixture = { match: { userMessage: "x" }, response: { content: "X" } };

      journal.add(makeEntry({ response: { status: 200, fixture } }));
      journal.add(makeEntry({ response: { status: 200, fixture } }));
      journal.add(makeEntry({ response: { status: 200, fixture } }));

      expect(journal.findByFixture(fixture)).toHaveLength(2);
    });

    it("memory does not grow unbounded under sustained load with cap", () => {
      // Red-green anchor for the leak fix: 100k adds with cap=500 must stay at 500.
      const journal = new Journal({ maxEntries: 500 });
      for (let i = 0; i < 100_000; i++) {
        journal.add(makeEntry({ path: `/${i}` }));
      }
      expect(journal.size).toBe(500);
      // Last 500 paths preserved, oldest 99,500 evicted
      expect(journal.getLast()!.path).toBe("/99999");
      expect(journal.getAll()[0].path).toBe("/99500");
    });
  });

  describe("fixtureCountsMaxTestIds (FIFO eviction on testId map)", () => {
    // Minimal fixture shared by these tests — only the reference matters.
    const fixture: Fixture = { match: { userMessage: "x" }, response: { content: "X" } };

    it("does not cap when fixtureCountsMaxTestIds is unset (backwards compat)", () => {
      const journal = new Journal();
      for (let i = 0; i < 2000; i++) {
        journal.incrementFixtureMatchCount(fixture, undefined, `test-${i}`);
      }
      // Every testId retained under unbounded default (historical behavior).
      expect(journal.getFixtureMatchCount(fixture, "test-0")).toBe(1);
      expect(journal.getFixtureMatchCount(fixture, "test-1999")).toBe(1);
    });

    it("treats fixtureCountsMaxTestIds = 0 or negative as uncapped", () => {
      const j0 = new Journal({ fixtureCountsMaxTestIds: 0 });
      const jNeg = new Journal({ fixtureCountsMaxTestIds: -1 });
      for (let i = 0; i < 100; i++) {
        j0.incrementFixtureMatchCount(fixture, undefined, `test-${i}`);
        jNeg.incrementFixtureMatchCount(fixture, undefined, `test-${i}`);
      }
      expect(j0.getFixtureMatchCount(fixture, "test-0")).toBe(1);
      expect(jNeg.getFixtureMatchCount(fixture, "test-0")).toBe(1);
    });

    it("evicts the oldest testId when size exceeds the cap (FIFO)", () => {
      const journal = new Journal({ fixtureCountsMaxTestIds: 3 });

      journal.incrementFixtureMatchCount(fixture, undefined, "t1");
      journal.incrementFixtureMatchCount(fixture, undefined, "t2");
      journal.incrementFixtureMatchCount(fixture, undefined, "t3");
      // At cap (3). All three retained.
      expect(journal.getFixtureMatchCount(fixture, "t1")).toBe(1);
      expect(journal.getFixtureMatchCount(fixture, "t2")).toBe(1);
      expect(journal.getFixtureMatchCount(fixture, "t3")).toBe(1);

      // Fourth unique testId triggers eviction of the oldest (t1).
      journal.incrementFixtureMatchCount(fixture, undefined, "t4");

      // After eviction, t1's prior count is gone. Reads are non-mutating,
      // so looking up t1 returns 0 without re-inserting.
      expect(journal.getFixtureMatchCount(fixture, "t1")).toBe(0);
      expect(journal.getFixtureMatchCount(fixture, "t2")).toBe(1);
      expect(journal.getFixtureMatchCount(fixture, "t3")).toBe(1);
      expect(journal.getFixtureMatchCount(fixture, "t4")).toBe(1);
    });

    it("getFixtureMatchCount does NOT mutate cache on unknown testId", () => {
      const journal = new Journal({ fixtureCountsMaxTestIds: 3 });

      journal.incrementFixtureMatchCount(fixture, undefined, "t1");
      journal.incrementFixtureMatchCount(fixture, undefined, "t2");
      journal.incrementFixtureMatchCount(fixture, undefined, "t3");
      // Snapshot the internal size via a retained-testId probe: t1 is still
      // present (count=1). Reading an unknown testId must not evict it.
      expect(journal.getFixtureMatchCount(fixture, "t1")).toBe(1);

      // Read many unknown testIds — each would have triggered insert+evict
      // under the old behavior, evicting t1/t2/t3 one by one.
      for (let i = 0; i < 50; i++) {
        expect(journal.getFixtureMatchCount(fixture, `unknown-${i}`)).toBe(0);
      }

      // All original testIds must still be intact.
      expect(journal.getFixtureMatchCount(fixture, "t1")).toBe(1);
      expect(journal.getFixtureMatchCount(fixture, "t2")).toBe(1);
      expect(journal.getFixtureMatchCount(fixture, "t3")).toBe(1);
    });

    it("holds steady at the cap under sustained load with many unique testIds", () => {
      // Red-green anchor: 10k unique testIds with cap=100 must stay at 100.
      const journal = new Journal({ fixtureCountsMaxTestIds: 100 });
      for (let i = 0; i < 10_000; i++) {
        journal.incrementFixtureMatchCount(fixture, undefined, `t-${i}`);
      }
      // Only the last 100 testIds should have counts > 0 retained.
      // Access an early one — since it was evicted, getFixtureMatchCount
      // returns 0 (the read path is non-mutating on miss).
      expect(journal.getFixtureMatchCount(fixture, "t-0")).toBe(0);
      // Most recently added testIds retained.
      expect(journal.getFixtureMatchCount(fixture, "t-9999")).toBe(1);
    });
  });
});
