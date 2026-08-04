import { describe, it, expect } from "vitest";

import { computeDelta, isBaseReportReusable } from "../../scripts/drift-delta.js";
import type { DeltaKey } from "../../scripts/drift-delta.js";
import { DriftClass } from "../../scripts/drift-types.js";
import type { DriftEntry, DriftReport, ParsedDiff } from "../../scripts/drift-types.js";

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
    path: "knownVoiceModelFamilies",
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

/** A single entry with an explicit scenario, for multi-scenario reports. */
function entryOf(provider: string, scenario: string, diffs: ParsedDiff[]): DriftEntry {
  return {
    provider,
    scenario,
    builderFile: "b.ts",
    builderFunctions: ["f"],
    typesFile: null,
    sdkShapesFile: "shapes.ts",
    diffs,
  };
}

function reportOfEntries(
  entries: DriftEntry[],
  timestamp = "2026-08-04T00:00:00.000Z",
): DriftReport {
  return { timestamp, entries };
}

/** `provider:scenario:id` — the full identity the delta layer must key on. */
function scopedKeys(list: DeltaKey[]): string[] {
  return list.map((k) => `${k.provider}:${k.scenario}:${k.id}`).sort();
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
        const dk: DeltaKey = {
          provider: entry.provider,
          scenario: entry.scenario,
          id: d.id ?? d.path,
          class: d.class,
        };
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
      diff({ path: "knownVoiceModelFamilies", id: "a" }),
      diff({ path: "knownVoiceModelFamilies", id: "b" }),
      diff({ path: "knownVoiceModelFamilies", id: "c" }),
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

// ---------------------------------------------------------------------------
// SCENARIO must be part of the delta key.
//
// `keyOf` used to be `provider::id`, with `id` defaulting to the diff's `path`.
// A `path` is a wire path (`usage.prompt_tokens`), and the SAME wire path is
// asserted by MANY scenarios of the same provider — `openaiChatCompletionShape`
// (non-streaming text) and the tool-call shape both carry `usage.prompt_tokens`
// (src/__tests__/drift/sdk-shapes.ts). So a drift already present on main in
// scenario A absorbed a genuinely NEW drift on the same field in scenario B:
// both collapsed to one key, the key was base-present, and the new finding was
// routed to `advisory` — a FAIL-SILENT pass of the required check on drift the
// diff introduced.
// ---------------------------------------------------------------------------
describe("delta key includes scenario (fail-silent collapse)", () => {
  const driftedField = () =>
    diff({ path: "usage.prompt_tokens", id: "usage.prompt_tokens", class: DriftClass.Advisory });
  const newCritical = () =>
    diff({ path: "usage.prompt_tokens", id: "usage.prompt_tokens", class: DriftClass.Critical });

  const base = reportOfEntries([entryOf("OpenAI Chat", "non-streaming text", [driftedField()])]);
  const head = reportOfEntries([
    entryOf("OpenAI Chat", "non-streaming text", [driftedField()]),
    entryOf("OpenAI Chat", "non-streaming tool call", [newCritical()]),
  ]);

  it("a new critical drift on the same path in a DIFFERENT scenario BLOCKS", () => {
    const { block, advisory, fixed } = computeDelta(base, head);
    expect(scopedKeys(block)).toEqual(["OpenAI Chat:non-streaming tool call:usage.prompt_tokens"]);
    expect(block[0].class).toBe(DriftClass.Critical);
    expect(scopedKeys(advisory)).toEqual(["OpenAI Chat:non-streaming text:usage.prompt_tokens"]);
    expect(fixed).toEqual([]);
  });

  it("KNOWN-NEGATIVE control: an unchanged base/head pair still blocks nothing", () => {
    const { block, advisory, fixed } = computeDelta(head, head);
    expect(block).toEqual([]);
    expect(fixed).toEqual([]);
    // Both scenarios survive as DISTINCT advisory keys — pre-existing drift
    // stays pre-existing; the scenario scoping must not manufacture a block.
    expect(scopedKeys(advisory)).toEqual([
      "OpenAI Chat:non-streaming text:usage.prompt_tokens",
      "OpenAI Chat:non-streaming tool call:usage.prompt_tokens",
    ]);
  });

  it("a scenario disappearing from head is `fixed`, not silently absorbed", () => {
    const { block, advisory, fixed } = computeDelta(head, base);
    expect(block).toEqual([]);
    expect(scopedKeys(advisory)).toEqual(["OpenAI Chat:non-streaming text:usage.prompt_tokens"]);
    expect(scopedKeys(fixed)).toEqual(["OpenAI Chat:non-streaming tool call:usage.prompt_tokens"]);
  });
});

// ---------------------------------------------------------------------------
// A residual collision (same provider + scenario + id, e.g. two assertions in
// one scenario reporting the same path) used to be resolved LAST-WINS, which
// made the annotated `class` depend on report order: [Critical, Advisory]
// annotated the key `advisory`, and the reversed order annotated it `critical`.
// Routing never depended on it, but the human-facing annotation on a blocking
// key did. The more severe class must win, deterministically.
// ---------------------------------------------------------------------------
describe("colliding keys resolve to the MOST SEVERE class, order-independently", () => {
  const empty = reportOfEntries([entryOf("OpenAI Chat", "non-streaming text", [])]);

  function collision(classes: DriftClass[]): DriftReport {
    return reportOfEntries([
      entryOf(
        "OpenAI Chat",
        "non-streaming text",
        classes.map((c) =>
          diff({ path: "usage.prompt_tokens", id: "usage.prompt_tokens", class: c }),
        ),
      ),
    ]);
  }

  it("critical wins whether it is seen first or last", () => {
    const first = computeDelta(empty, collision([DriftClass.Critical, DriftClass.Advisory]));
    const last = computeDelta(empty, collision([DriftClass.Advisory, DriftClass.Critical]));
    expect(first.block).toHaveLength(1);
    expect(last.block).toHaveLength(1);
    expect(first.block[0].class).toBe(DriftClass.Critical);
    expect(last.block[0].class).toBe(DriftClass.Critical);
  });

  it("quarantine outranks advisory and none, in both orders", () => {
    const first = computeDelta(empty, collision([DriftClass.Quarantine, DriftClass.None]));
    const last = computeDelta(empty, collision([DriftClass.None, DriftClass.Quarantine]));
    expect(first.block[0].class).toBe(DriftClass.Quarantine);
    expect(last.block[0].class).toBe(DriftClass.Quarantine);
  });

  it("a classified diff outranks an unclassified (legacy) one, in both orders", () => {
    const classed = () =>
      diff({ path: "usage.prompt_tokens", id: "usage.prompt_tokens", class: DriftClass.Critical });
    const legacy = () => {
      const d = diff({ path: "usage.prompt_tokens", id: "usage.prompt_tokens" });
      delete d.class;
      return d;
    };
    const first = computeDelta(
      empty,
      reportOfEntries([entryOf("OpenAI Chat", "non-streaming text", [classed(), legacy()])]),
    );
    const last = computeDelta(
      empty,
      reportOfEntries([entryOf("OpenAI Chat", "non-streaming text", [legacy(), classed()])]),
    );
    expect(first.block[0].class).toBe(DriftClass.Critical);
    expect(last.block[0].class).toBe(DriftClass.Critical);
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
