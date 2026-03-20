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
});
