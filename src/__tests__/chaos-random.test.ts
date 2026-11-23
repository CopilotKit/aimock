import { describe, it, expect } from "vitest";
import {
  ChaosOccurrenceRegistry,
  DEFAULT_CHAOS_KEYS_MAX,
  chaosDraw,
  chaosKeyFor,
  createJitterSource,
  normalizeChaosSeed,
} from "../chaos-random.js";
import { calculateDelayWithJitter } from "../sse-writer.js";

describe("ChaosOccurrenceRegistry", () => {
  it("counts 0, 1, 2 per (scope, seed, key) independently", () => {
    const registry = new ChaosOccurrenceRegistry();
    expect(registry.next("t", "s", "a")).toBe(0);
    expect(registry.next("t", "s", "a")).toBe(1);
    expect(registry.next("t", "s", "b")).toBe(0);
    expect(registry.next("t", "other-seed", "a")).toBe(0);
    expect(registry.next("other-test", "s", "a")).toBe(0);
    expect(registry.next("t", "s", "a")).toBe(2);
  });

  it("never holds more than its cap and evicts the least recently used counter", () => {
    const registry = new ChaosOccurrenceRegistry(3);
    for (const key of ["a", "b", "c"]) registry.next("t", "s", key);
    registry.next("t", "s", "a"); // a is now the most recent
    registry.next("t", "s", "d"); // evicts b
    expect(registry.size).toBe(3);
    expect(registry.next("t", "s", "a")).toBe(2);
    expect(registry.next("t", "s", "b")).toBe(0); // b restarted
    for (let i = 0; i < 1000; i++) registry.next("t", "s", `k${i}`);
    expect(registry.size).toBe(3);
  });

  it("falls back to the default cap for a non-positive or fractional max", () => {
    for (const max of [0, -1, 1.5, Number.NaN]) {
      expect(new ChaosOccurrenceRegistry(max).max).toBe(DEFAULT_CHAOS_KEYS_MAX);
    }
    expect(new ChaosOccurrenceRegistry().max).toBe(10_000);
  });

  it("clearScope drops one testId's counters and keeps the others", () => {
    const registry = new ChaosOccurrenceRegistry();
    registry.next("t1", "s", "a");
    registry.next("t2", "s", "a");
    registry.clearScope("t1");
    expect(registry.next("t1", "s", "a")).toBe(0);
    expect(registry.next("t2", "s", "a")).toBe(1);
  });

  it("clear drops everything", () => {
    const registry = new ChaosOccurrenceRegistry();
    registry.next("t", "s", "a");
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.next("t", "s", "a")).toBe(0);
  });
});

describe("chaos keys and draws", () => {
  it("keys ignore JSON key order but not values, method or path", () => {
    const base = { method: "POST", path: "/v1/x", body: { a: 1, b: [1, 2] } };
    expect(chaosKeyFor({ ...base, body: { b: [1, 2], a: 1 } })).toBe(chaosKeyFor(base));
    expect(chaosKeyFor({ ...base, body: { a: 1, b: [2, 1] } })).not.toBe(chaosKeyFor(base));
    expect(chaosKeyFor({ ...base, method: "PUT" })).not.toBe(chaosKeyFor(base));
    expect(chaosKeyFor({ ...base, path: "/v1/x?q=1" })).not.toBe(chaosKeyFor(base));
    expect(chaosKeyFor({ ...base, body: undefined })).not.toBe(
      chaosKeyFor({ ...base, body: null }),
    );
    expect(chaosKeyFor(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("draws are pure, in [0, 1), and differ by kind and occurrence", () => {
    const d = chaosDraw("seed", "key", "drop", 0);
    expect(chaosDraw("seed", "key", "drop", 0)).toBe(d);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(1);
    expect(chaosDraw("seed", "key", "malformed", 0)).not.toBe(d);
    expect(chaosDraw("seed", "key", "drop", 1)).not.toBe(d);
    expect(chaosDraw("other", "key", "drop", 0)).not.toBe(d);
  });

  it("draws are roughly uniform", () => {
    let hits = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (chaosDraw("uniform", `k${i}`, "drop", 0) < 0.3) hits++;
    expect(hits / n).toBeGreaterThan(0.28);
    expect(hits / n).toBeLessThan(0.32);
  });
});

describe("normalizeChaosSeed", () => {
  it("accepts finite numbers and visible-ASCII strings, trimmed", () => {
    expect(normalizeChaosSeed(42)).toBe("42");
    expect(normalizeChaosSeed(1.5)).toBe("1.5");
    expect(normalizeChaosSeed("  abc-123  ")).toBe("abc-123");
    expect(normalizeChaosSeed("x".repeat(128))).toBe("x".repeat(128));
  });

  it("rejects everything else", () => {
    for (const bad of [
      "",
      "   ",
      "has space",
      "x".repeat(129),
      "café",
      "tab\there",
      Number.NaN,
      Infinity,
      true,
      null,
      {},
    ]) {
      expect(normalizeChaosSeed(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("seeded jitter in calculateDelay", () => {
  const profile = { ttft: 100, tps: 10, jitter: 0.5 };

  it("is reproducible for the same seed and key", () => {
    const a = createJitterSource("seed", "key");
    const b = createJitterSource("seed", "key");
    const delaysA = [0, 1, 2, 3].map((i) =>
      calculateDelayWithJitter(i, profile, 0, undefined, 1, a),
    );
    const delaysB = [0, 1, 2, 3].map((i) =>
      calculateDelayWithJitter(i, profile, 0, undefined, 1, b),
    );
    expect(delaysB).toEqual(delaysA);
    // Jitter actually moved the delays off the unjittered values.
    expect(delaysA).not.toEqual([100, 100, 100, 100]);
  });

  it("stays within the jitter band", () => {
    const source = createJitterSource("band", "key");
    for (let i = 1; i < 200; i++) {
      const d = calculateDelayWithJitter(i, profile, 0, undefined, 1, source);
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThanOrEqual(150);
    }
  });
});
