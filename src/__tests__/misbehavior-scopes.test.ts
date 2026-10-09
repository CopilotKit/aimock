import { describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";
import type { Fixture, MisbehaviorConfig, MisbehaviorCounterKey } from "../types.js";

const fixture: Fixture = { match: {}, response: { content: "ok" } };
function key(testId = "a", sourceKey = "source", entryIndex = 0): MisbehaviorCounterKey {
  return { testId, sourceKey, entryIndex };
}
function seed(journal: Journal, testId: string) {
  journal.incrementFixtureMatchCount(fixture, undefined, testId);
  journal.nextOrdinal(key(testId));
  journal.recordFiring(key(testId));
}
function expectReset(journal: Journal, testId: string) {
  expect(journal.getFixtureMatchCount(fixture, testId)).toBe(0);
  expect(journal.getFiringCount(key(testId))).toBe(0);
  expect(journal.nextOrdinal(key(testId))).toBe(0);
}

describe("Journal misbehavior counters", () => {
  it("isolates test, source and entry identities without delimiter collisions", () => {
    const journal = new Journal();
    const keys = [
      key(),
      key("b"),
      key("a", "other"),
      key("a", "source", 1),
      key("a|source", ""),
      key("a", "source|"),
    ];
    for (const counter of keys) {
      expect(journal.nextOrdinal(counter)).toBe(0);
      journal.recordFiring(counter);
    }
    for (const counter of keys) {
      expect(journal.nextOrdinal(counter)).toBe(1);
      expect(journal.getFiringCount(counter)).toBe(1);
    }
  });

  it("counts attempted rolls independently of successful firings", () => {
    const journal = new Journal();
    // The planner calls nextOrdinal even for rate 0/1 and failed comparisons.
    expect(journal.nextOrdinal(key())).toBe(0);
    expect(journal.nextOrdinal(key())).toBe(1);
    expect(journal.getFiringCount(key())).toBe(0);
    journal.recordFiring(key());
    journal.recordFiring(key());
    expect(journal.getFiringCount(key())).toBe(2);
    expect(journal.nextOrdinal(key())).toBe(2);
  });

  it("keeps read-only misses outside FIFO admission", () => {
    const journal = new Journal({ fixtureCountsMaxTestIds: 1 });
    seed(journal, "a");
    expect(journal.getFiringCount(key("missing"))).toBe(0);
    expect(journal.getFixtureMatchCountsForTest("missing").size).toBe(0);
    expect(journal.getFiringCount(key())).toBe(1);
    expect(journal.getFixtureMatchCount(fixture, "a")).toBe(1);
  });

  it.each(["match", "ordinal", "firing"] as const)(
    "shares FIFO admission and eviction for %s mutations",
    (mutation) => {
      const journal = new Journal({ fixtureCountsMaxTestIds: 2 });
      seed(journal, "a");
      seed(journal, "b");
      seed(journal, "a"); // Mutating an admitted ID must not refresh its FIFO age.
      if (mutation === "match") journal.incrementFixtureMatchCount(fixture, undefined, "c");
      if (mutation === "ordinal") journal.nextOrdinal(key("c"));
      if (mutation === "firing") journal.recordFiring(key("c"));
      expect(journal.getFiringCount(key("b"))).toBe(1);
      expect(journal.getFixtureMatchCount(fixture, "b")).toBe(1);
      expectReset(journal, "a");
    },
  );

  it("does not re-admit an ID when a second kind of state is created", () => {
    const journal = new Journal({ fixtureCountsMaxTestIds: 2 });
    journal.recordFiring(key("a"));
    journal.incrementFixtureMatchCount(fixture, undefined, "b");
    journal.incrementFixtureMatchCount(fixture, undefined, "a");
    journal.recordFiring(key("c"));
    expect(journal.getFixtureMatchCount(fixture, "b")).toBe(1);
    expectReset(journal, "a");
  });

  it("clears fault counters by scope without clearing match state", () => {
    const journal = new Journal();
    seed(journal, "a");
    seed(journal, "b");
    journal.clearMisbehaviorCounters("a");
    expect(journal.getFiringCount(key("a"))).toBe(0);
    expect(journal.nextOrdinal(key("a"))).toBe(0);
    expect(journal.getFiringCount(key("b"))).toBe(1);
    expect(journal.getFixtureMatchCount(fixture, "a")).toBe(1);
    journal.clearMisbehaviorCounters();
    expect(journal.getFiringCount(key("b"))).toBe(0);
    expect(journal.nextOrdinal(key("b"))).toBe(0);
    expect(journal.getFixtureMatchCount(fixture, "b")).toBe(1);
  });

  it("clears both counter kinds for scoped and full match resets", () => {
    const journal = new Journal();
    seed(journal, "a");
    seed(journal, "b");
    journal.clearMatchCounts("a");
    expect(journal.getFiringCount(key("b"))).toBe(1);
    expectReset(journal, "a");
    journal.clearMatchCounts();
    expectReset(journal, "b");
  });

  it("preserves counters on clearEntries and clears them on full reset", () => {
    const journal = new Journal();
    seed(journal, "a");
    journal.add({
      method: "POST",
      path: "/",
      headers: {},
      body: null,
      response: { status: 200, fixture: null },
    });
    journal.clearEntries();
    expect(journal.size).toBe(0);
    expect(journal.getFiringCount(key())).toBe(1);
    expect(journal.nextOrdinal(key())).toBe(1);
    expect(journal.getFixtureMatchCount(fixture, "a")).toBe(1);
    journal.clear();
    expectReset(journal, "a");
  });

  it("preserves FIFO age when only fault counters are cleared", () => {
    const journal = new Journal({ fixtureCountsMaxTestIds: 2 });
    seed(journal, "a");
    seed(journal, "b");
    journal.clearMisbehaviorCounters("a");
    journal.recordFiring(key("a"));
    journal.recordFiring(key("c"));
    expect(journal.getFiringCount(key("b"))).toBe(1);
    expectReset(journal, "a");
  });
});

// These tests exercise the actual reset doors and their state owner. Fault delivery
// through the SDK is a separate integration obligation of the provider adapter.
const baseline: MisbehaviorConfig = { faults: [{ fault: "tool-unknown-name", times: 1 }] };
const override: MisbehaviorConfig = { faults: [{ fault: "tool-args-invalid-json", times: 2 }] };

async function withResetMock(run: (mock: LLMock) => Promise<void>) {
  const mock = new LLMock({ port: 0, logLevel: "silent", misbehavior: baseline });
  await mock.start();
  try {
    await run(mock);
  } finally {
    await mock.stop();
  }
}

async function scopeRequest(
  mock: LLMock,
  method: string,
  testId?: string,
  body?: MisbehaviorConfig,
) {
  const response = await fetch(`${mock.url}/__aimock/misbehavior`, {
    method,
    headers: { "Content-Type": "application/json", ...(testId ? { "X-Test-Id": testId } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function resetDoor(mock: LLMock, door: string) {
  if (door === "R4") mock.reset();
  else if (door === "R5") mock.clearFixtures();
  else {
    const path = door === "R1" ? "/reset" : door === "R2" ? "/reset/fixtures" : "/fixtures";
    const response = await fetch(`${mock.url}/__aimock${path}`, {
      method: door === "R3" ? "DELETE" : "POST",
    });
    expect(response.status).toBe(200);
  }
}

describe("misbehavior reset doors on a running server", () => {
  it.each(["R1", "R2", "R4"])(
    "%s clears overrides and counters, revealing the construction baseline",
    async (door) => {
      await withResetMock(async (mock) => {
        await scopeRequest(mock, "POST", undefined, override);
        await scopeRequest(mock, "POST", "a", { faults: [] });
        seed(mock.journal, "a");
        seed(mock.journal, "b");
        await resetDoor(mock, door);
        expect(await scopeRequest(mock, "GET", "a")).toEqual({ misbehavior: baseline });
        expect(await scopeRequest(mock, "GET", "b")).toEqual({ misbehavior: baseline });
        expectReset(mock.journal, "a");
        expectReset(mock.journal, "b");
      });
    },
  );

  it.each(["R3", "R5"])(
    "%s clears semantic counters while preserving match counts and overrides",
    async (door) => {
      await withResetMock(async (mock) => {
        mock.addFixture(fixture);
        await scopeRequest(mock, "POST", "a", override);
        seed(mock.journal, "a");
        seed(mock.journal, "b");
        await resetDoor(mock, door);
        mock.addFixture(fixture);
        for (const testId of ["a", "b"]) {
          expect(mock.journal.getFiringCount(key(testId))).toBe(0);
          expect(mock.journal.nextOrdinal(key(testId))).toBe(0);
          expect(mock.journal.getFixtureMatchCount(fixture, testId)).toBe(1);
        }
        expect(await scopeRequest(mock, "GET", "a")).toEqual({ misbehavior: override });
      });
    },
  );

  it("R6 resets only the named test's counters and preserves runtime overrides", async () => {
    await withResetMock(async (mock) => {
      await scopeRequest(mock, "POST", "a", override);
      seed(mock.journal, "a");
      seed(mock.journal, "b");
      mock.resetMatchCounts("a");
      expectReset(mock.journal, "a");
      expect(mock.journal.getFiringCount(key("b"))).toBe(1);
      expect(mock.journal.nextOrdinal(key("b"))).toBe(1);
      expect(await scopeRequest(mock, "GET", "a")).toEqual({ misbehavior: override });
    });
  });

  it.each(["HTTP", "LLMock"])("R7 %s journal clearing preserves semantic state", async (door) => {
    await withResetMock(async (mock) => {
      await scopeRequest(mock, "POST", "a", override);
      seed(mock.journal, "a");
      if (door === "HTTP") {
        const response = await fetch(`${mock.url}/__aimock/reset/journal`, { method: "POST" });
        expect(response.status).toBe(200);
      } else mock.clearRequests();
      expect(mock.journal.getFiringCount(key())).toBe(1);
      expect(mock.journal.nextOrdinal(key())).toBe(1);
      expect(mock.journal.getFixtureMatchCount(fixture, "a")).toBe(1);
      expect(await scopeRequest(mock, "GET", "a")).toEqual({ misbehavior: override });
    });
  });

  it("full reset retains setter changes and does not resurrect a cleared baseline", async () => {
    await withResetMock(async (mock) => {
      mock.setMisbehavior(override);
      await scopeRequest(mock, "POST", "a", { faults: [] });
      mock.reset();
      expect(await scopeRequest(mock, "GET", "a")).toEqual({ misbehavior: override });
      mock.clearMisbehavior();
      await scopeRequest(mock, "POST", "a", baseline);
      mock.reset();
      expect(await scopeRequest(mock, "GET", "a")).toEqual({ misbehavior: { faults: [] } });
    });
  });
});
