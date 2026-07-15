import { describe, it, expect } from "vitest";

import { computeDelta, isBaseReportReusable } from "../../scripts/drift-delta.js";
import type { DeltaKey } from "../../scripts/drift-delta.js";
import { DriftClass } from "../../scripts/drift-types.js";
import type { DriftReport, ParsedDiff } from "../../scripts/drift-types.js";

// ---------------------------------------------------------------------------
// drift-delta: the delta-gating core.
//
// The gate must BLOCK only on drift attributable to the PR diff (new-in-head),
// treat drift already present on main as ADVISORY (environmental / world drift),
// and report base-only drift as FIXED. The block/advisory decision is by KEY
// PRESENCE alone — `DriftClass` is annotation and must NEVER route.
// ---------------------------------------------------------------------------

function diff(overrides: Partial<ParsedDiff> = {}): ParsedDiff {
  return {
    path: "knownModels",
    severity: "critical",
    issue: "model drift",
    expected: "x",
    real: "y",
    mock: "z",
    ...overrides,
  };
}

function report(
  provider: string,
  diffs: ParsedDiff[],
  timestamp = "2026-07-14T00:00:00.000Z",
): DriftReport {
  return {
    timestamp,
    entries: [
      {
        provider,
        scenario: "s",
        builderFile: "b.ts",
        builderFunctions: ["f"],
        typesFile: null,
        sdkShapesFile: "shapes.ts",
        diffs,
      },
    ],
  };
}

function keys(list: DeltaKey[]): string[] {
  return list.map((k) => `${k.provider}:${k.id}`).sort();
}

// ---------------------------------------------------------------------------
// The M-1 golden regression (#292).
//
// A real-drift/critical failure that is NEW-in-head MUST BLOCK. The old broken
// rule routed by CLASS (real-drift/critical → advisory), which would have
// greenlit #292. This test proves the class-routed rule fails and computeDelta
// blocks regardless of class.
// ---------------------------------------------------------------------------
describe("M-1 golden: new-in-head critical MUST block regardless of class", () => {
  // Head introduces a critical/real-drift finding that base does not have.
  const base = report("anthropic", [diff({ id: "claude-3-opus", class: DriftClass.None })]);
  const head = report("anthropic", [
    diff({ id: "claude-3-opus", class: DriftClass.None }),
    diff({ id: "claude-4-new-model", class: DriftClass.Critical }),
  ]);

  // Simulate the OLD broken rule: route purely by class. A critical drift is
  // sent to advisory, so a new-in-head #292 failure is NOT blocked. This stub
  // encodes the pre-fix behavior we are regressing against.
  const classRouted = (r: DriftReport) => {
    const block: DeltaKey[] = [];
    const advisory: DeltaKey[] = [];
    for (const entry of r.entries) {
      for (const d of entry.diffs) {
        const dk: DeltaKey = { provider: entry.provider, id: d.id ?? d.path, class: d.class };
        if (d.class === DriftClass.Critical) advisory.push(dk);
        else block.push(dk);
      }
    }
    return { block, advisory };
  };

  it("RED regression: the CLASS-ROUTED rule fails to block the new-in-head critical (would greenlight #292)", () => {
    const result = classRouted(head);
    const newCriticalBlocked = result.block.some((k) => k.id === "claude-4-new-model");
    // The broken rule sends the critical to advisory, NOT block. If this ever
    // starts blocking, the class-routed regression is no longer being exercised.
    expect(newCriticalBlocked).toBe(false);
    expect(result.advisory.some((k) => k.id === "claude-4-new-model")).toBe(true);
  });

  it("GREEN: computeDelta blocks the new-in-head critical regardless of class", () => {
    const { block, advisory } = computeDelta(base, head);
    expect(keys(block)).toEqual(["anthropic:claude-4-new-model"]);
    expect(keys(advisory)).toEqual(["anthropic:claude-3-opus"]);
    // The blocked key is critical — proving class did not route it to advisory.
    expect(block[0].class).toBe(DriftClass.Critical);
  });
});

describe("computeDelta routing by key presence", () => {
  it("same key in base+head → advisory (even critical)", () => {
    const base = report("openai", [diff({ id: "gpt-4", class: DriftClass.Critical })]);
    const head = report("openai", [diff({ id: "gpt-4", class: DriftClass.Critical })]);
    const { block, advisory, fixed } = computeDelta(base, head);
    expect(block).toEqual([]);
    expect(keys(advisory)).toEqual(["openai:gpt-4"]);
    expect(fixed).toEqual([]);
  });

  it("head-only transient → block (keyed by provider+id)", () => {
    const base = report("openai", []);
    const head = report("openai", [diff({ id: "gpt-5-preview", class: DriftClass.Critical })]);
    const { block, advisory, fixed } = computeDelta(base, head);
    expect(keys(block)).toEqual(["openai:gpt-5-preview"]);
    expect(advisory).toEqual([]);
    expect(fixed).toEqual([]);
  });

  it("base-only failure → fixed (informational, not block/advisory)", () => {
    const base = report("openai", [diff({ id: "gpt-3.5", class: DriftClass.Critical })]);
    const head = report("openai", []);
    const { block, advisory, fixed } = computeDelta(base, head);
    expect(block).toEqual([]);
    expect(advisory).toEqual([]);
    expect(keys(fixed)).toEqual(["openai:gpt-3.5"]);
  });

  it("keys by provider+id (path bucket must NOT collapse N distinct ids into one)", () => {
    const base = report("anthropic", []);
    const head = report("anthropic", [
      diff({ path: "knownModels", id: "a" }),
      diff({ path: "knownModels", id: "b" }),
      diff({ path: "knownModels", id: "c" }),
    ]);
    const { block } = computeDelta(base, head);
    expect(keys(block)).toEqual(["anthropic:a", "anthropic:b", "anthropic:c"]);
  });

  it("same id across different providers → distinct keys", () => {
    const base = report("openai", [diff({ id: "shared" })]);
    const head = {
      timestamp: base.timestamp,
      entries: [...base.entries, ...report("anthropic", [diff({ id: "shared" })]).entries],
    };
    const { block, advisory } = computeDelta(base, head);
    expect(keys(block)).toEqual(["anthropic:shared"]);
    expect(keys(advisory)).toEqual(["openai:shared"]);
  });

  it("falls back to path when id is absent (legacy diffs still participate)", () => {
    const base = report("cohere", []);
    const head = report("cohere", [diff({ path: "legacyBucket" })]); // no id
    const { block } = computeDelta(base, head);
    expect(keys(block)).toEqual(["cohere:legacyBucket"]);
  });
});

describe("isBaseReportReusable (O-2)", () => {
  const good = report("openai", [diff({ id: "gpt-4" })]);

  it("accepts a non-empty, known-good, same-UTC-day report", () => {
    expect(isBaseReportReusable(good, "clean", true)).toBe(true);
    expect(isBaseReportReusable(good, "success", true)).toBe(true);
  });

  it("rejects an empty-entries report (malformed cached base)", () => {
    const empty: DriftReport = { timestamp: "2026-07-14T00:00:00.000Z", entries: [] };
    expect(isBaseReportReusable(empty, "clean", true)).toBe(false);
  });

  it("rejects a null / malformed report object", () => {
    expect(isBaseReportReusable(null, "clean", true)).toBe(false);
    expect(isBaseReportReusable(undefined, "clean", true)).toBe(false);
    // Malformed: entries missing entirely.
    expect(isBaseReportReusable({ timestamp: "t" } as unknown as DriftReport, "clean", true)).toBe(
      false,
    );
  });

  it("rejects an unknown / bad conclusion (crash, quarantine, empty)", () => {
    expect(isBaseReportReusable(good, "failure", true)).toBe(false);
    expect(isBaseReportReusable(good, "quarantine", true)).toBe(false);
    expect(isBaseReportReusable(good, "", true)).toBe(false);
    expect(isBaseReportReusable(good, null, true)).toBe(false);
    expect(isBaseReportReusable(good, undefined, true)).toBe(false);
  });

  it("rejects a stale (different-UTC-day) report", () => {
    expect(isBaseReportReusable(good, "clean", false)).toBe(false);
  });
});
