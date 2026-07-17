/**
 * Tests for the WS-2 drift-success predicate.
 *
 * These exercise the REAL exported pure function `evaluateDriftResolved` and
 * the CLI helpers from scripts/drift-success-predicate.ts. The predicate is a
 * pure function over a small `DriftReport` fixture + a synthetic changed-file
 * array — no live API, no LLM, no aimock needed.
 *
 * The headline case is the fixture-relaxation cheat: a run that changes ONLY
 * `src/__tests__/drift/sdk-shapes.ts` (relaxing the SDK leg) must be REJECTED
 * (COMPARISON_LEG_ONLY), whereas the OLD fix-drift.ts guard (`builderFiles>0 ||
 * testFiles>0`) would have ACCEPTED it — demonstrated by contrast below.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import type { DriftEntry, DriftReport, ParsedDiff } from "../../scripts/drift-types.js";
import {
  evaluateDriftResolved,
  PredicateReason,
  REASON_EXIT_CODE,
  isProductionFile,
  isComparisonLeg,
  isSuppressionSurface,
  isGameableLeg,
  canonicalizePath,
  isAllowlisted,
  sanctionedTargets,
  countCriticalDiffs,
  parseCliArgs,
  parsePorcelainLine,
  crossCheckChangedFiles,
  PredicateConfigError,
  readReport,
  runCli,
} from "../../scripts/drift-success-predicate.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function diff(overrides: Partial<ParsedDiff> = {}): ParsedDiff {
  return {
    path: "choices[0].message.content",
    severity: "critical",
    issue: "field present in SDK+real but missing from mock",
    expected: "string",
    real: "string",
    mock: "<missing>",
    ...overrides,
  };
}

function entry(overrides: Partial<DriftEntry> = {}): DriftEntry {
  return {
    provider: "OpenAI",
    scenario: "chat completion",
    builderFile: "src/helpers.ts",
    builderFunctions: ["buildChatCompletion"],
    typesFile: "src/types.ts",
    sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
    diffs: [diff()],
    ...overrides,
  };
}

function report(entries: DriftEntry[] = [entry()]): DriftReport {
  return { timestamp: "2026-07-16T00:00:00.000Z", entries };
}

/** The OLD, gameable guard from fix-drift.ts:638 — for contrast assertions. */
function oldGuardWouldAccept(changedFiles: string[]): boolean {
  const builderFiles = changedFiles.filter(
    (f) => f.startsWith("src/") && !f.startsWith("src/__tests__/"),
  );
  const testFiles = changedFiles.filter((f) => f.startsWith("src/__tests__/"));
  // OLD guard aborts ONLY when BOTH are empty; otherwise it proceeds.
  return !(builderFiles.length === 0 && testFiles.length === 0);
}

// ---------------------------------------------------------------------------
// RED cases — resolved:false
// ---------------------------------------------------------------------------

describe("evaluateDriftResolved — RED (cheat/failure) cases", () => {
  it("HEADLINE: fixture-relaxation-only (sdk-shapes.ts) → COMPARISON_LEG_ONLY, and the OLD guard would have ACCEPTED it", () => {
    const changedFiles = ["src/__tests__/drift/sdk-shapes.ts"];
    const verdict = evaluateDriftResolved({
      changedFiles,
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });

    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.COMPARISON_LEG_ONLY);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/sdk-shapes.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(11);

    // Contrast: the OLD guard would have proceeded (testFiles non-empty).
    expect(oldGuardWouldAccept(changedFiles)).toBe(true);
  });

  it("schema/allowlist edit + real builder change → SUPPRESSION_SUSPECTED (blocks even with a prod change)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/schema.ts", "src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/schema.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
  });

  it("*.drift.ts assertion loosened only → SUPPRESSION_SUSPECTED", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/openai-chat.drift.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
  });

  it("no changes at all → NO_PRODUCTION_CHANGE", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: [],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.NO_PRODUCTION_CHANGE);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(10);
  });

  it("production change but collector still dirty (exit 2) → STILL_DIRTY", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 2,
      postFixCriticalCount: 1,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.STILL_DIRTY);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(13);
  });

  it("production change + collector exit 0 but criticalCount>0 → STILL_DIRTY (belt-and-suspenders)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 3,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.STILL_DIRTY);
  });

  it("post-fix quarantine (exit 5) → QUARANTINE_AFTER_FIX", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 5,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.QUARANTINE_AFTER_FIX);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(14);
  });

  it("post-fix collector infra (exit 1) → COLLECTOR_INFRA", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 1,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.COLLECTOR_INFRA);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(15);
  });

  it("production change off-target → PRODUCTION_CHANGE_OFF_TARGET", () => {
    // report names src/helpers.ts; the change is an unrelated production file.
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/gemini.ts"],
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.PRODUCTION_CHANGE_OFF_TARGET);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(16);
  });

  // -------------------------------------------------------------------------
  // WS-2b HYBRID CHEAT — a gameable-leg edit ACCOMPANIED by a trivial, on-target
  // production edit. Pre-fix the predicate ignored the leg once ANY production
  // file changed → RESOLVED (the exact WS-2b auto-merge cheat). Post-fix a leg
  // edit ALWAYS blocks (SUPPRESSION_SUSPECTED), regardless of production files.
  // -------------------------------------------------------------------------
  it("HEADLINE WS-2b: sdk-shapes.ts relaxation + on-target production edit → SUPPRESSION_SUSPECTED (block), NOT resolved", () => {
    const changedFiles = ["src/__tests__/drift/sdk-shapes.ts", "src/helpers.ts"];
    const verdict = evaluateDriftResolved({
      changedFiles,
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/sdk-shapes.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
    // Contrast: the OLD guard would have proceeded (both builder + test present).
    expect(oldGuardWouldAccept(changedFiles)).toBe(true);
  });

  it("harness leg (providers.ts) relaxation + on-target production edit → SUPPRESSION_SUSPECTED (block)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/providers.ts", "src/helpers.ts"],
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/providers.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
  });

  it("harness-only leg edit (ws-providers.ts), no production change → COMPARISON_LEG_ONLY (block, pure relaxation)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/ws-providers.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    // Leg edit with NO production change → COMPARISON_LEG_ONLY (a pure
    // relaxation; no mock fix even attempted). Still a hard block (exit 11).
    expect(verdict.reason).toBe(PredicateReason.COMPARISON_LEG_ONLY);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(11);
  });

  // -------------------------------------------------------------------------
  // FIX #2 — dual-classification precedence: voice-models.ts is BOTH a harness
  // leg AND a legit fixture target. Block-classification MUST win (fail-closed).
  // -------------------------------------------------------------------------
  it("voice-models.ts (dual-classified harness+target) + on-target production edit → SUPPRESSION_SUSPECTED (block wins)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/voice-models.ts", "src/ws-realtime.ts"],
      report: report([entry({ builderFile: "src/ws-realtime.ts", typesFile: null })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/voice-models.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
  });

  // -------------------------------------------------------------------------
  // FIX #3 — empty sanctioned-target set must fail closed (needs-human), not
  // silently accept any production change by disabling the off-target guard.
  // -------------------------------------------------------------------------
  it("empty sanctionedTargets (report entries have no usable target) → PRODUCTION_CHANGE_OFF_TARGET (fail-closed)", () => {
    // Fabricate a report whose entries yield ZERO sanctioned targets: builderFile
    // "" and typesFile null. (evaluateDriftResolved does not re-validate the
    // report shape — it only reads builderFile/typesFile via sanctionedTargets.)
    const emptyTargetReport: DriftReport = {
      timestamp: "2026-07-16T00:00:00.000Z",
      entries: [
        {
          provider: "OpenAI",
          scenario: "chat completion",
          builderFile: "",
          builderFunctions: ["buildChatCompletion"],
          typesFile: null,
          sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
          diffs: [diff()],
        },
      ],
    };
    expect(sanctionedTargets(emptyTargetReport).size).toBe(0);
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: emptyTargetReport,
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.PRODUCTION_CHANGE_OFF_TARGET);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(16);
  });

  // -------------------------------------------------------------------------
  // FIX #6 — exit 5/1 WITH parseable criticalCount>0 gets its OWN reason
  // (quarantine/infra), NOT STILL_DIRTY. The collector-state classification
  // wins over the belt-and-suspenders criticalCount check.
  // -------------------------------------------------------------------------
  it("post-fix quarantine (exit 5) with criticalCount>0 → QUARANTINE_AFTER_FIX (not STILL_DIRTY)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 5,
      postFixCriticalCount: 4,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.QUARANTINE_AFTER_FIX);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(14);
  });

  it("post-fix infra (exit 1) with criticalCount>0 → COLLECTOR_INFRA (not STILL_DIRTY)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 1,
      postFixCriticalCount: 4,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.COLLECTOR_INFRA);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// GREEN cases — resolved:true
// ---------------------------------------------------------------------------

describe("evaluateDriftResolved — GREEN (real fix) cases", () => {
  it("real src/helpers.ts fix + clean collector → RESOLVED", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "src/types.ts"],
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(0);
  });

  it("legit canary: model-registry.ts + ws-realtime.ts (report sanctions BOTH) → RESOLVED", () => {
    // The known-models canary routes its fix to the production ws-realtime.ts
    // (builderFile) AND the model list fixture (typesFile). Under the allowlist a
    // fixture is accepted ONLY when the report names it as a target — so the
    // report here sanctions model-registry.ts via typesFile.
    const canary = report([
      entry({
        provider: "OpenAI Realtime",
        scenario: "known-models canary",
        builderFile: "src/ws-realtime.ts",
        builderFunctions: ["buildRealtimeSession"],
        typesFile: "src/__tests__/drift/model-registry.ts",
        diffs: [
          diff({ path: "knownModels", issue: "Unknown realtime model detected", mock: "<none>" }),
        ],
      }),
    ]);
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/model-registry.ts", "src/ws-realtime.ts"],
      report: canary,
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });

  it("AG-UI: report names src/agui-types.ts; change to that file → RESOLVED", () => {
    const agui = report([
      entry({
        provider: "AG-UI",
        scenario: "missing event types",
        builderFile: "src/agui-types.ts",
        builderFunctions: ["AGUIEventType"],
        typesFile: "src/agui-types.ts",
        sdkShapesFile: "src/__tests__/drift/agui-schema.drift.ts",
        diffs: [diff({ path: "AGUIEventType", issue: "missing event type" })],
      }),
    ]);
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/agui-types.ts"],
      report: agui,
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });

  it("production change + accompanying report-NAMED canary fixture → RESOLVED", () => {
    // model-family.ts is accepted as an accompanying change ONLY because the
    // report names it (typesFile) — under the allowlist a fixture is not a free
    // pass by static membership; it must be sanctioned by the report for this run.
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/ws-realtime.ts", "src/__tests__/drift/model-family.ts"],
      report: report([
        entry({
          builderFile: "src/ws-realtime.ts",
          typesFile: "src/__tests__/drift/model-family.ts",
        }),
      ]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });
});

// ---------------------------------------------------------------------------
// ALLOWLIST INVERSION (round-2 CR F1/F2/F3) — a fix is RESOLVED only when EVERY
// changed file is on the allowlist. Anything not recognized as production source
// or a report-sanctioned fixture target BLOCKS. This closes path-spelling
// sneak-ins, stale-denylist gaps, and in-diff vectors (package.json / lockfiles
// / sub-fixtures / unknown paths).
// ---------------------------------------------------------------------------

describe("allowlist inversion — non-allowlisted changed files ALWAYS block", () => {
  // A report that sanctions src/helpers.ts as the fix target, so the production
  // edit itself is legitimately allowlisted; the SECOND file is the attack.
  const sanctioned = () =>
    report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]);

  const cleanSignal = { postFixCollectorExit: 0, postFixCriticalCount: 0 };

  it("package.json changed alongside a real production fix → UNSANCTIONED_CHANGE (block)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "package.json"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.UNSANCTIONED_CHANGE);
    expect(verdict.offendingFiles).toContain("package.json");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(17);
  });

  it("pnpm-lock.yaml changed alongside a real production fix → UNSANCTIONED_CHANGE (block)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "pnpm-lock.yaml"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.UNSANCTIONED_CHANGE);
    expect(verdict.offendingFiles).toContain("pnpm-lock.yaml");
  });

  it("tsconfig.json changed alongside a real production fix → UNSANCTIONED_CHANGE (block)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "tsconfig.json"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.UNSANCTIONED_CHANGE);
  });

  it("an unknown/unrecognized path alongside a real production fix → UNSANCTIONED_CHANGE (block)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "scripts/fix-drift.ts"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.UNSANCTIONED_CHANGE);
    expect(verdict.offendingFiles).toContain("scripts/fix-drift.ts");
  });

  it("a drift-dir *.test.ts (NOT a *.drift.ts) alongside a real production fix → UNSANCTIONED_CHANGE (closes the drift-dir .test.ts gap)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "src/__tests__/drift/model-registry.test.ts"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(false);
    // A drift-dir unit test is not a gameable comparison leg (isGameableLeg is
    // false for it) and is not allowlisted → UNSANCTIONED_CHANGE.
    expect(verdict.reason).toBe(PredicateReason.UNSANCTIONED_CHANGE);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/model-registry.test.ts");
  });

  it("a non-drift __tests__ file alongside a real production fix → UNSANCTIONED_CHANGE (block)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "src/__tests__/server.test.ts"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.UNSANCTIONED_CHANGE);
  });

  it("model-registry.ts fixture NOT named by the report + prod fix → UNSANCTIONED_CHANGE (fixtures allowlisted ONLY when report-named)", () => {
    // model-registry.ts is a legit fixture target but the report does NOT name it
    // (builderFile/typesFile are src/helpers.ts / src/types.ts). It is therefore
    // NOT on the allowlist for THIS run and must block.
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "src/__tests__/drift/model-registry.ts"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.UNSANCTIONED_CHANGE);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/model-registry.ts");
  });

  it("FIX #F2 (round-4): a report-NAMED fixture target ALONE (no production change) → NO_PRODUCTION_CHANGE (routed to human, NOT auto-resolved)", () => {
    // A canary that names ONLY the fixture as its target and whose diff touches
    // ONLY that fixture (model-registry.ts) — with NO production/builder change.
    // The module invariant (Signal 2) requires >=1 production mock-builder change
    // for RESOLVED: a fixture-target-only change is not independently verifiable
    // (the re-collect reads the same fixture), so it must route to human review,
    // never auto-resolve. This is the canary-only bypass F2 closes.
    const canary = report([
      entry({
        provider: "OpenAI Realtime",
        scenario: "known-models canary",
        builderFile: "src/__tests__/drift/model-registry.ts",
        builderFunctions: ["knownModels"],
        typesFile: null,
        diffs: [diff({ path: "knownModels", issue: "new model shipped" })],
      }),
    ]);
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/model-registry.ts"],
      report: canary,
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.NO_PRODUCTION_CHANGE);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(10);
  });

  it("FIX #F2 (round-4): a report-NAMED fixture target ACCOMPANIED BY a production change → RESOLVED (the legit canary shape)", () => {
    // The legit canary shape: the report names BOTH a production builder and the
    // fixture, and BOTH change. The production change satisfies the >=1
    // production-change invariant, so this auto-resolves (unlike the
    // fixture-only case above).
    const canary = report([
      entry({
        provider: "OpenAI Realtime",
        scenario: "known-models canary",
        builderFile: "src/ws-realtime.ts",
        builderFunctions: ["buildRealtimeSession"],
        typesFile: "src/__tests__/drift/model-registry.ts",
        diffs: [diff({ path: "knownModels", issue: "new model shipped" })],
      }),
    ]);
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/ws-realtime.ts", "src/__tests__/drift/model-registry.ts"],
      report: canary,
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });

  it("production-source-only fix (no fixtures at all) + clean collector → RESOLVED", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });
});

// ---------------------------------------------------------------------------
// PATH CANONICALIZATION (round-2 CR slot-1/slot-2 F1) — a leg edit presented
// under an equivalent-but-non-identical spelling must still be recognized and
// blocked; classification runs on the canonical form.
// ---------------------------------------------------------------------------

describe("path canonicalization defeats spelling-variant leg sneak-ins", () => {
  it("./src/... leading-dot spelling of the SDK leg still blocks", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["./src/__tests__/drift/sdk-shapes.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.COMPARISON_LEG_ONLY);
  });

  it("doubled-slash spelling of the SDK leg + prod edit still blocks (SUPPRESSION_SUSPECTED)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src//__tests__/drift/sdk-shapes.ts", "src/helpers.ts"],
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
  });

  it("trailing-dot-segment spelling of a production target canonicalizes and RESOLVES", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["./src/helpers.ts"],
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });

  it("canonicalizePath normalizes ./ , // and . segments", () => {
    expect(canonicalizePath("./src/helpers.ts")).toBe("src/helpers.ts");
    expect(canonicalizePath("src//__tests__/drift/sdk-shapes.ts")).toBe(
      "src/__tests__/drift/sdk-shapes.ts",
    );
    expect(canonicalizePath("src/./helpers.ts")).toBe("src/helpers.ts");
    expect(canonicalizePath("src/helpers.ts")).toBe("src/helpers.ts");
  });

  it("canonicalizePath rejects a path escaping the repo root (fail-closed)", () => {
    expect(() => canonicalizePath("../ag-ui/events.ts")).toThrow(PredicateConfigError);
    expect(() => canonicalizePath("src/../../etc/passwd")).toThrow(PredicateConfigError);
  });
});

// ---------------------------------------------------------------------------
// F6 — empty / non-integer --post-fix-exit must FAIL CLOSED (Number("")===0
// must NOT be treated as a clean exit 0).
// ---------------------------------------------------------------------------

describe("F6 — --post-fix-exit fails closed on empty/whitespace", () => {
  it("throws on an empty --post-fix-exit (Number('')===0 must not slip through)", () => {
    expect(() =>
      parseCliArgs(["--report", "a.json", "--post-fix-report", "b.json", "--post-fix-exit", ""]),
    ).toThrow(PredicateConfigError);
  });

  it("throws on a whitespace-only --post-fix-exit", () => {
    expect(() =>
      parseCliArgs(["--report", "a.json", "--post-fix-report", "b.json", "--post-fix-exit", "  "]),
    ).toThrow(PredicateConfigError);
  });
});

// ---------------------------------------------------------------------------
// F8 — a malformed post-fix report that crashes countCriticalDiffs must be
// caught and mapped to a NAMED config-error reason, not a bare stacktrace.
// ---------------------------------------------------------------------------

describe("F8 — malformed post-fix report → named config-error (not a bare crash)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("runCli exits 2 (CONFIG_ERROR) when the post-fix report has entries with no diffs array", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-f8-"));
    const preP = join(dir, "drift-report.json");
    const postP = join(dir, "drift-report.post-fix.json");
    writeFileSync(preP, JSON.stringify(report()), "utf-8");
    // Structurally passes readReport (timestamp + entries array) but each entry
    // is missing `diffs`, so countCriticalDiffs would throw.
    writeFileSync(
      postP,
      JSON.stringify({ timestamp: "t", entries: [{ provider: "OpenAI" }] }),
      "utf-8",
    );
    const code = runCli(["--report", preP, "--post-fix-report", postP, "--post-fix-exit", "0"]);
    expect(code).toBe(REASON_EXIT_CODE[PredicateReason.CONFIG_ERROR]);
  });
});

// ---------------------------------------------------------------------------
// File-classification unit coverage
// ---------------------------------------------------------------------------

describe("file classification", () => {
  it("isProductionFile matches src/** except src/__tests__/**", () => {
    expect(isProductionFile("src/helpers.ts")).toBe(true);
    expect(isProductionFile("src/agui-types.ts")).toBe(true);
    expect(isProductionFile("src/__tests__/drift/sdk-shapes.ts")).toBe(false);
    expect(isProductionFile("scripts/fix-drift.ts")).toBe(false);
  });

  it("isComparisonLeg flags SDK/schema/harness/*.drift.ts (incl dual-classified voice-models) but NOT pure legit targets", () => {
    expect(isComparisonLeg("src/__tests__/drift/sdk-shapes.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/schema.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/providers.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/ws-providers.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/helpers.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/openai-chat.drift.ts")).toBe(true);
    // Dual-classified voice-models.ts blocks (fix #2: harness membership wins).
    expect(isComparisonLeg("src/__tests__/drift/voice-models.ts")).toBe(true);
    // PURE legit fixture targets (not also a harness leg) are NOT comparison legs.
    expect(isComparisonLeg("src/__tests__/drift/model-registry.ts")).toBe(false);
    expect(isComparisonLeg("src/__tests__/drift/model-family.ts")).toBe(false);
    // Production files are not comparison legs.
    expect(isComparisonLeg("src/helpers.ts")).toBe(false);
  });

  it("isSuppressionSurface flags the NARROW always-suppress set (schema + *.drift.ts) only", () => {
    // Suppression surface = the actively-silencing subset: schema/allowlist and
    // *.drift.ts assertions. These always map to SUPPRESSION_SUSPECTED. The
    // broader legs (sdk-shapes / harness) are gameable but are NOT suppression
    // surfaces (they map to COMPARISON_LEG_ONLY when standalone).
    expect(isSuppressionSurface("src/__tests__/drift/schema.ts")).toBe(true);
    expect(isSuppressionSurface("src/__tests__/drift/openai-chat.drift.ts")).toBe(true);
    expect(isSuppressionSurface("src/__tests__/drift/sdk-shapes.ts")).toBe(false);
    expect(isSuppressionSurface("src/__tests__/drift/providers.ts")).toBe(false);
    expect(isSuppressionSurface("src/__tests__/drift/voice-models.ts")).toBe(false);
    expect(isSuppressionSurface("src/helpers.ts")).toBe(false);
  });

  it("isGameableLeg flags every leg (incl dual-classified voice-models) but NOT model-registry/model-family/production", () => {
    expect(isGameableLeg("src/__tests__/drift/sdk-shapes.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/schema.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/providers.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/ws-providers.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/helpers.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/openai-chat.drift.ts")).toBe(true);
    // Dual-classified: harness membership wins over legit-target (fix #2).
    expect(isGameableLeg("src/__tests__/drift/voice-models.ts")).toBe(true);
    // Pure legit fixture targets are NOT gameable legs.
    expect(isGameableLeg("src/__tests__/drift/model-registry.ts")).toBe(false);
    expect(isGameableLeg("src/__tests__/drift/model-family.ts")).toBe(false);
    expect(isGameableLeg("src/helpers.ts")).toBe(false);
  });

  it("isAllowlisted: production source is allowed; config/manifests/tests are not", () => {
    const targets = new Set<string>(["src/helpers.ts", "src/__tests__/drift/model-registry.ts"]);
    // Production source (non-test) is always allowlisted.
    expect(isAllowlisted("src/helpers.ts", targets)).toBe(true);
    expect(isAllowlisted("src/agui-types.ts", targets)).toBe(true);
    // A report-named fixture target is allowlisted.
    expect(isAllowlisted("src/__tests__/drift/model-registry.ts", targets)).toBe(true);
    // A fixture NOT named by the report is not allowlisted.
    expect(isAllowlisted("src/__tests__/drift/model-family.ts", targets)).toBe(false);
    // Config/manifests/lockfiles/unknown paths are not allowlisted.
    expect(isAllowlisted("package.json", targets)).toBe(false);
    expect(isAllowlisted("pnpm-lock.yaml", targets)).toBe(false);
    expect(isAllowlisted("tsconfig.json", targets)).toBe(false);
    expect(isAllowlisted("scripts/fix-drift.ts", targets)).toBe(false);
    // A non-production src config-ish manifest is not allowlisted.
    expect(isAllowlisted("src/__tests__/server.test.ts", targets)).toBe(false);
  });

  it("sanctionedTargets unions builderFile + non-null typesFile", () => {
    const t = sanctionedTargets(
      report([
        entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" }),
        entry({ builderFile: "src/gemini.ts", typesFile: null }),
      ]),
    );
    expect(t.has("src/helpers.ts")).toBe(true);
    expect(t.has("src/types.ts")).toBe(true);
    expect(t.has("src/gemini.ts")).toBe(true);
    expect(t.has("src/__tests__/drift/sdk-shapes.ts")).toBe(false);
  });

  it("countCriticalDiffs counts only critical severities", () => {
    const r = report([
      entry({
        diffs: [
          diff({ severity: "critical" }),
          diff({ severity: "warning" }),
          diff({ severity: "critical" }),
        ],
      }),
    ]);
    expect(countCriticalDiffs(r)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CLI arg parsing + config errors (exit 2)
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  it("parses a full valid arg set", () => {
    const args = parseCliArgs([
      "--report",
      "a.json",
      "--post-fix-report",
      "b.json",
      "--post-fix-exit",
      "0",
      "--changed-file",
      "src/helpers.ts",
      "--changed-file",
      "src/types.ts",
    ]);
    expect(args.reportPath).toBe("a.json");
    expect(args.postFixReportPath).toBe("b.json");
    expect(args.postFixExit).toBe(0);
    expect(args.changedFiles).toEqual(["src/helpers.ts", "src/types.ts"]);
  });

  it("null changedFiles when no --changed-file flag (derive from git later)", () => {
    const args = parseCliArgs([
      "--report",
      "a.json",
      "--post-fix-report",
      "b.json",
      "--post-fix-exit",
      "2",
    ]);
    expect(args.changedFiles).toBeNull();
  });

  it("throws on missing --report", () => {
    expect(() => parseCliArgs(["--post-fix-report", "b.json", "--post-fix-exit", "0"])).toThrow(
      PredicateConfigError,
    );
  });

  it("throws on non-integer --post-fix-exit", () => {
    expect(() =>
      parseCliArgs(["--report", "a.json", "--post-fix-report", "b.json", "--post-fix-exit", "abc"]),
    ).toThrow(PredicateConfigError);
  });

  it("throws on unknown argument", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(PredicateConfigError);
  });
});

describe("readReport", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("throws PredicateConfigError on a missing file", () => {
    expect(() => readReport("/no/such/drift-report.json")).toThrow(PredicateConfigError);
  });

  // FIX #6 — align the strict/loose validators. readReport must fail-closed on a
  // structurally-untrustworthy report the same way fix-drift.ts:readDriftReport
  // does: a missing/non-string `timestamp` is a corrupt/truncated collector run
  // and must be REJECTED, never silently trusted as a clean signal.
  it("rejects a report missing the timestamp field (fail-closed, aligns with readDriftReport)", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-readreport-"));
    const p = join(dir, "no-ts.json");
    writeFileSync(p, JSON.stringify({ entries: [] }), "utf-8");
    expect(() => readReport(p)).toThrow(PredicateConfigError);
  });

  it("rejects a non-object / non-{entries:[]} structure", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-readreport-"));
    const p = join(dir, "bad.json");
    writeFileSync(p, JSON.stringify({ timestamp: "t", entries: "nope" }), "utf-8");
    expect(() => readReport(p)).toThrow(PredicateConfigError);
  });

  // A legitimately-clean post-fix report IS { entries: [] } — the collector
  // emits exactly that when no drift remains. It must be ACCEPTED (the trust
  // anchor for "clean" is the collector EXIT CODE, corroborated by fix #1's
  // always-block-on-leg-edit rule, not the entries array being non-empty).
  it("accepts a well-formed EMPTY report (the genuine clean-collector signal)", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-readreport-"));
    const p = join(dir, "clean.json");
    writeFileSync(p, JSON.stringify({ timestamp: "t", entries: [] }), "utf-8");
    expect(() => readReport(p)).not.toThrow();
  });

  it("accepts a well-formed non-empty report", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-readreport-"));
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify(report()), "utf-8");
    expect(() => readReport(p)).not.toThrow();
  });
});

describe("parsePorcelainLine", () => {
  it("strips the 2-char status + space prefix", () => {
    expect(parsePorcelainLine(" M src/helpers.ts")).toBe("src/helpers.ts");
    expect(parsePorcelainLine("?? src/new.ts")).toBe("src/new.ts");
    expect(parsePorcelainLine("A  src/added.ts")).toBe("src/added.ts");
  });

  it("takes the NEW path from rename notation (old -> new)", () => {
    expect(parsePorcelainLine("R  src/old.ts -> src/new.ts")).toBe("src/new.ts");
  });

  it("unquotes paths with special characters", () => {
    expect(parsePorcelainLine('?? "src/weird name.ts"')).toBe("src/weird name.ts");
    expect(parsePorcelainLine('R  "src/old x.ts" -> "src/new x.ts"')).toBe("src/new x.ts");
  });
});

// ---------------------------------------------------------------------------
// runCli end-to-end (in-process): exit codes over real temp report files
// ---------------------------------------------------------------------------

describe("runCli", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeReports(pre: DriftReport, post: DriftReport): { pre: string; post: string } {
    dir = mkdtempSync(join(tmpdir(), "ws2-predicate-"));
    const preP = join(dir, "drift-report.json");
    const postP = join(dir, "drift-report.post-fix.json");
    writeFileSync(preP, JSON.stringify(pre), "utf-8");
    writeFileSync(postP, JSON.stringify(post), "utf-8");
    return { pre: preP, post: postP };
  }

  // NOTE (fix #4): runCli now ALWAYS cross-checks any --changed-file list
  // against the real git working tree, so a synthetic list that does not match
  // the checkout is rejected (exit 2) BEFORE the predicate runs. The exit-code-
  // per-reason mapping for the cheat / real-fix cases is covered directly by the
  // evaluateDriftResolved + REASON_EXIT_CODE tests above; here we lock the
  // cross-check itself (the fix #4 blinding guard) at the runCli boundary.
  it("exits 2 (CONFIG_ERROR) when --changed-file disagrees with git (fix #4 blinding guard)", () => {
    const paths = writeReports(report(), report([]));
    const code = runCli([
      "--report",
      paths.pre,
      "--post-fix-report",
      paths.post,
      "--post-fix-exit",
      "0",
      "--changed-file",
      "src/__tests__/drift/sdk-shapes.ts",
    ]);
    expect(code).toBe(2);
  });

  it("exits 2 (CONFIG_ERROR) on a missing post-fix report", () => {
    const paths = writeReports(report(), report());
    const code = runCli([
      "--report",
      paths.pre,
      "--post-fix-report",
      join(dir!, "does-not-exist.json"),
      "--post-fix-exit",
      "0",
      "--changed-file",
      "src/helpers.ts",
    ]);
    expect(code).toBe(2);
  });

  it("exits 2 (CONFIG_ERROR) on malformed args", () => {
    const code = runCli(["--bogus"]);
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FIX #4 — authoritative changed-files: crossCheckChangedFiles
// ---------------------------------------------------------------------------

describe("crossCheckChangedFiles", () => {
  it("returns the git set when no explicit list is supplied", () => {
    const git = ["src/helpers.ts", "src/types.ts"];
    expect(crossCheckChangedFiles(null, git)).toEqual(git);
  });

  it("accepts an explicit list that matches the git set (order-independent)", () => {
    const git = ["src/helpers.ts", "src/types.ts"];
    expect(crossCheckChangedFiles(["src/types.ts", "src/helpers.ts"], git)).toEqual(
      expect.arrayContaining(git),
    );
  });

  it("throws when the explicit list OMITS a file git reports (leg-blinding attack)", () => {
    const git = ["src/helpers.ts", "src/__tests__/drift/sdk-shapes.ts"];
    // Attacker passes only the benign production file, hiding the relaxed leg.
    expect(() => crossCheckChangedFiles(["src/helpers.ts"], git)).toThrow(PredicateConfigError);
  });

  it("throws when the explicit list ADDS a file git does not report", () => {
    const git = ["src/helpers.ts"];
    expect(() => crossCheckChangedFiles(["src/helpers.ts", "src/phantom.ts"], git)).toThrow(
      PredicateConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// REVERT GUARD + RED-COUNT LOCK
// ---------------------------------------------------------------------------

describe("revert guard — old always-accept predicate would FAIL these locks", () => {
  // The pre-hardening predicate ignored gameable legs once ANY production file
  // changed (and had a legacy always-accept fallback). This models that old
  // behavior; asserting it DISAGREES with the real predicate on the WS-2b cheat
  // proves the hardening is load-bearing. If someone reverts evaluateDriftResolved
  // to the old logic, the HEADLINE WS-2b test above flips and the suite breaks.
  function oldPredicateWouldAccept(changedFiles: string[]): boolean {
    const productionFiles = changedFiles.filter(isProductionFile);
    // Old logic: leg files only checked when productionFiles === 0.
    return productionFiles.length > 0;
  }

  it("WS-2b cheat: old predicate ACCEPTS, real predicate BLOCKS (SUPPRESSION_SUSPECTED)", () => {
    const cheat = ["src/__tests__/drift/sdk-shapes.ts", "src/helpers.ts"];
    // Old behavior would have accepted (a production file is present).
    expect(oldPredicateWouldAccept(cheat)).toBe(true);
    // Real predicate blocks.
    const verdict = evaluateDriftResolved({
      changedFiles: cheat,
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
  });

  // ALLOWLIST-INVERSION revert lock: the OLD denylist only blocked KNOWN gameable
  // legs, so an in-diff vector NOT on the denylist (package.json, a lockfile, an
  // unknown path) paired with an on-target production edit sailed through to
  // RESOLVED. The allowlist inverts that: anything not explicitly allowed blocks.
  // Reverting evaluateDriftResolved to a denylist model flips these to RESOLVED
  // and breaks the suite.
  function denylistWouldAccept(changedFiles: string[]): boolean {
    // Old denylist model: block ONLY if a changed file is a known gameable leg;
    // otherwise (production + package.json/lockfile/unknown) accept.
    return !changedFiles.some(isGameableLeg) && changedFiles.some(isProductionFile);
  }

  it("in-diff vector (package.json + prod): old DENYLIST accepts, allowlist BLOCKS (UNSANCTIONED_CHANGE)", () => {
    const vector = ["src/helpers.ts", "package.json"];
    // The old denylist would have accepted (no known leg in the set).
    expect(denylistWouldAccept(vector)).toBe(true);
    const verdict = evaluateDriftResolved({
      changedFiles: vector,
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.UNSANCTIONED_CHANGE);
  });
});

describe("exit-code distinctness lock", () => {
  // Structural lock on the reason→exit-code contract: every block reason maps to
  // a distinct NON-ZERO exit code and RESOLVED alone is 0. This does NOT count
  // RED test cases (it asserts the code table, not the number of scenarios) — it
  // guarantees the workflow can route each cause to its own Slack DETAIL without
  // two reasons colliding on one exit code.
  const BLOCK_REASONS = [
    PredicateReason.NO_PRODUCTION_CHANGE,
    PredicateReason.COMPARISON_LEG_ONLY,
    PredicateReason.SUPPRESSION_SUSPECTED,
    PredicateReason.UNSANCTIONED_CHANGE,
    PredicateReason.STILL_DIRTY,
    PredicateReason.QUARANTINE_AFTER_FIX,
    PredicateReason.COLLECTOR_INFRA,
    PredicateReason.PRODUCTION_CHANGE_OFF_TARGET,
    PredicateReason.CONFIG_ERROR,
  ];

  it("every block reason has a distinct non-zero exit code and RESOLVED is 0", () => {
    expect(REASON_EXIT_CODE[PredicateReason.RESOLVED]).toBe(0);
    const codes = BLOCK_REASONS.map((r) => REASON_EXIT_CODE[r]);
    for (const c of codes) expect(c).not.toBe(0);
    expect(new Set(codes).size).toBe(codes.length); // all distinct
  });
});

// ---------------------------------------------------------------------------
// CR round-3 slot-3 LOW gaps — unrecognized collector exit code + `..`/absolute
// canonicalization variants driven end-to-end through the predicate/runCli.
// ---------------------------------------------------------------------------

describe("unrecognized collector exit code fails closed → COLLECTOR_INFRA", () => {
  // The `postFixCollectorExit !== 0` catch-all (COLLECTOR_INFRA / exit 15) had
  // no locking test. Tests only fed 0/1/2/5. A future refactor could let an
  // unknown exit fall through to a clean accept — this pins it closed.
  for (const exit of [3, 7, 99]) {
    it(`exit ${exit} (unrecognized) with a production change → COLLECTOR_INFRA / exit 15`, () => {
      const verdict = evaluateDriftResolved({
        changedFiles: ["src/helpers.ts"],
        report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
        postFixCollectorExit: exit,
        postFixCriticalCount: 0,
      });
      expect(verdict.resolved).toBe(false);
      expect(verdict.reason).toBe(PredicateReason.COLLECTOR_INFRA);
      expect(REASON_EXIT_CODE[verdict.reason]).toBe(15);
    });
  }
});

describe("`..`-segment and absolute path variants block/fail-closed THROUGH the predicate", () => {
  it("a `..`-containing spelling of the SDK leg canonicalizes and BLOCKS (COMPARISON_LEG_ONLY)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/foo/../sdk-shapes.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.COMPARISON_LEG_ONLY);
  });

  it("an absolute changed-file path throws PredicateConfigError from evaluateDriftResolved", () => {
    expect(() =>
      evaluateDriftResolved({
        changedFiles: ["/etc/passwd"],
        report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
        postFixCollectorExit: 0,
        postFixCriticalCount: 0,
      }),
    ).toThrow(PredicateConfigError);
  });

  it("a `..`-escaping changed-file path throws PredicateConfigError from evaluateDriftResolved", () => {
    expect(() =>
      evaluateDriftResolved({
        changedFiles: ["src/../../etc/passwd"],
        report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
        postFixCollectorExit: 0,
        postFixCriticalCount: 0,
      }),
    ).toThrow(PredicateConfigError);
  });
});

describe("runCli maps a repo-escaping/absolute changed-file to CONFIG_ERROR (exit 2)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  // Drive an absolute/`..`-escaping path all the way through runCli. A supplied
  // --changed-file cross-checks against git first, so an absolute path that git
  // never reports would be rejected by the cross-check (still exit 2). To pin the
  // fix #8 canonicalize-throw path specifically, we assert the CONFIG_ERROR exit.
  it("runCli exits 2 (CONFIG_ERROR) when a --changed-file is an absolute path", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-canon-"));
    const preP = join(dir, "drift-report.json");
    const postP = join(dir, "drift-report.post-fix.json");
    writeFileSync(preP, JSON.stringify(report()), "utf-8");
    writeFileSync(postP, JSON.stringify(report([])), "utf-8");
    const code = runCli([
      "--report",
      preP,
      "--post-fix-report",
      postP,
      "--post-fix-exit",
      "0",
      "--changed-file",
      "/etc/passwd",
    ]);
    expect(code).toBe(REASON_EXIT_CODE[PredicateReason.CONFIG_ERROR]);
  });
});

// ---------------------------------------------------------------------------
// FIX #F3 (round-4) — a collector-output artifact left in the repo working tree
// (drift-report.post-fix.json / drift-report.json / claude-code-output.log)
// appears as an untracked file in `git status --porcelain` and is scored by the
// predicate as UNSANCTIONED_CHANGE, breaking the happy path. The workflow fix
// writes those artifacts to $RUNNER_TEMP (outside the checkout) so they never
// enter the changed-file set. These pure-function locks prove the predicate's
// behaviour on BOTH sides of that move.
// ---------------------------------------------------------------------------
describe("FIX #F3 — collector-output artifacts must not be in the changed-file set", () => {
  const sanctioned = () =>
    report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]);
  const cleanSignal = { postFixCollectorExit: 0, postFixCriticalCount: 0 };

  it("RED (the bug): a post-fix report artifact in the changed set → UNSANCTIONED_CHANGE (happy path broken)", () => {
    // This is exactly what happened when the re-collect wrote into the repo cwd:
    // the untracked drift-report.post-fix.json joined the changed set and, being
    // neither production source nor a report-named target, fail-closed the run.
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "drift-report.post-fix.json"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.UNSANCTIONED_CHANGE);
    expect(verdict.offendingFiles).toContain("drift-report.post-fix.json");
  });

  it("GREEN (the fix): the SAME production fix WITHOUT the artifact (now in $RUNNER_TEMP) → RESOLVED", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: sanctioned(),
      ...cleanSignal,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });
});

// ---------------------------------------------------------------------------
// TEST-TIGHTNESS (round-4 slot-3) — lock the runCli behaviour the workflow
// depends on: (F2) the machine-readable `reason=<reason>` stdout line the
// "Assert" step greps for Slack routing, and (F1) the CONFIG_ERROR path so
// deleting the parse-error catch fails a test. These drive the REAL runCli in an
// isolated temp git repo so gitChangedFiles() returns a controlled set.
// ---------------------------------------------------------------------------
describe("runCli machine-readable reason= line + CONFIG_ERROR lock (slot-3 F1/F2)", () => {
  let repo: string | null = null;
  let logSpy: ReturnType<typeof vi.spyOn> | null = null;
  let errSpy: ReturnType<typeof vi.spyOn> | null = null;
  const origCwd = process.cwd();

  afterEach(() => {
    process.chdir(origCwd);
    logSpy?.mockRestore();
    errSpy?.mockRestore();
    logSpy = null;
    errSpy = null;
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = null;
  });

  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "ws2-runcli-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    return dir;
  }

  function captureConsole(): void {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  }

  function stdoutLines(): string[] {
    return (logSpy?.mock.calls ?? []).map((c) => String(c[0]));
  }

  it("prints `reason=resolved` on a genuine RESOLVED verdict (the line the workflow greps)", () => {
    repo = initRepo();
    // A real production change in the working tree → gitChangedFiles() reports it.
    // `git add -N` (intent-to-add) makes porcelain list the INDIVIDUAL file
    // (`A src/helpers.ts`) rather than collapsing an all-untracked dir to `?? src/`.
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "helpers.ts"), "export const x = 1;\n", "utf-8");
    execFileSync("git", ["add", "-N", "src/helpers.ts"], { cwd: repo });
    // Report files live OUTSIDE the repo (mirrors the workflow's $RUNNER_TEMP,
    // FIX #F3) so they are NOT untracked entries in `git status --porcelain` and
    // do not pollute the changed-file set the predicate scores.
    const outDir = mkdtempSync(join(tmpdir(), "ws2-runcli-out-"));
    const rep = report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]);
    const preP = join(outDir, "pre.json");
    const postP = join(outDir, "post.json");
    writeFileSync(preP, JSON.stringify(rep), "utf-8");
    writeFileSync(postP, JSON.stringify(report([])), "utf-8");
    process.chdir(repo);
    captureConsole();
    try {
      const code = runCli(["--report", preP, "--post-fix-report", postP, "--post-fix-exit", "0"]);
      expect(code).toBe(0);
      expect(stdoutLines()).toContain(`reason=${PredicateReason.RESOLVED}`);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("prints `reason=unsanctioned-change` (non-zero) on a blocked verdict — the Slack routing key", () => {
    repo = initRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "helpers.ts"), "export const x = 1;\n", "utf-8");
    // package.json IN the repo is the unsanctioned change; reports live OUTSIDE.
    writeFileSync(join(repo, "package.json"), '{"name":"x"}\n', "utf-8");
    execFileSync("git", ["add", "-N", "src/helpers.ts", "package.json"], { cwd: repo });
    const outDir = mkdtempSync(join(tmpdir(), "ws2-runcli-out-"));
    const rep = report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]);
    const preP = join(outDir, "pre.json");
    const postP = join(outDir, "post.json");
    writeFileSync(preP, JSON.stringify(rep), "utf-8");
    writeFileSync(postP, JSON.stringify(report([])), "utf-8");
    process.chdir(repo);
    captureConsole();
    try {
      const code = runCli(["--report", preP, "--post-fix-report", postP, "--post-fix-exit", "0"]);
      expect(code).toBe(REASON_EXIT_CODE[PredicateReason.UNSANCTIONED_CHANGE]);
      expect(stdoutLines()).toContain(`reason=${PredicateReason.UNSANCTIONED_CHANGE}`);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("prints `reason=config-error` and exits 2 when the report is unreadable (CONFIG_ERROR lock)", () => {
    repo = initRepo();
    process.chdir(repo);
    captureConsole();
    const code = runCli([
      "--report",
      join(repo, "does-not-exist.json"),
      "--post-fix-report",
      join(repo, "also-missing.json"),
      "--post-fix-exit",
      "0",
    ]);
    expect(code).toBe(REASON_EXIT_CODE[PredicateReason.CONFIG_ERROR]);
    expect(stdoutLines()).toContain(`reason=${PredicateReason.CONFIG_ERROR}`);
  });
});

// ---------------------------------------------------------------------------
// CR round-3 F3 — readReport ENTRY-LEVEL validation aligned with
// fix-drift.ts:readDriftReport. A structurally-valid report whose entries are
// malformed at the fields the predicate reads must fail-closed with a DISTINCT,
// NAMED PredicateConfigError (not a bare TypeError caught as an unnamed error).
// ---------------------------------------------------------------------------

describe("readReport entry-level validation (F3)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeAndRead(obj: unknown): void {
    dir = mkdtempSync(join(tmpdir(), "ws2-f3-"));
    const p = join(dir, "r.json");
    writeFileSync(p, JSON.stringify(obj), "utf-8");
    readReport(p);
  }

  it("throws a named PredicateConfigError when an entry is missing its diffs array", () => {
    expect(() =>
      writeAndRead({
        timestamp: "t",
        entries: [{ provider: "OpenAI", builderFile: "src/helpers.ts", typesFile: null }],
      }),
    ).toThrow(PredicateConfigError);
  });

  it('throws a named PredicateConfigError when "diffs" is present via the message', () => {
    expect(() =>
      writeAndRead({
        timestamp: "t",
        entries: [{ provider: "OpenAI", builderFile: "src/helpers.ts", typesFile: null }],
      }),
    ).toThrow(/diffs/);
  });

  it("throws when an entry has a non-string builderFile (cannot derive sanctioned set)", () => {
    expect(() =>
      writeAndRead({
        timestamp: "t",
        entries: [{ provider: "OpenAI", builderFile: 123, typesFile: null, diffs: [] }],
      }),
    ).toThrow(PredicateConfigError);
  });

  it("throws when an entry has an empty builderFile", () => {
    expect(() =>
      writeAndRead({
        timestamp: "t",
        entries: [{ provider: "OpenAI", builderFile: "", typesFile: null, diffs: [] }],
      }),
    ).toThrow(/builderFile/);
  });

  it("throws when an entry has a numeric typesFile (must be string or null)", () => {
    expect(() =>
      writeAndRead({
        timestamp: "t",
        entries: [{ provider: "OpenAI", builderFile: "src/helpers.ts", typesFile: 42, diffs: [] }],
      }),
    ).toThrow(/typesFile/);
  });

  it("throws when an entry is not an object", () => {
    expect(() => writeAndRead({ timestamp: "t", entries: [null] })).toThrow(PredicateConfigError);
  });

  it("still ACCEPTS a well-formed report (empty entries + valid entries both OK)", () => {
    expect(() => writeAndRead({ timestamp: "t", entries: [] })).not.toThrow();
    expect(() =>
      writeAndRead({
        timestamp: "t",
        entries: [
          { provider: "OpenAI", builderFile: "src/helpers.ts", typesFile: null, diffs: [] },
        ],
      }),
    ).not.toThrow();
  });
});
