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

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import type { DriftEntry, DriftReport, ParsedDiff } from "../../scripts/drift-types.js";
import {
  evaluateDriftResolved,
  PredicateReason,
  REASON_EXIT_CODE,
  isProductionFile,
  isComparisonLeg,
  isSuppressionSurface,
  sanctionedTargets,
  countCriticalDiffs,
  parseCliArgs,
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

  it("legit canary: model-registry.ts + ws-realtime.ts (report sanctions ws-realtime.ts) → RESOLVED", () => {
    // The known-models canary routes its fix to the production ws-realtime.ts
    // (builderFile), while the model list lives in the model-registry fixture.
    const canary = report([
      entry({
        provider: "OpenAI Realtime",
        scenario: "known-models canary",
        builderFile: "src/ws-realtime.ts",
        builderFunctions: ["buildRealtimeSession"],
        typesFile: null,
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

  it("production change + accompanying legit canary fixture (not a comparison leg) → RESOLVED", () => {
    // model-family.ts is a legit fixture target, not a gameable comparison leg,
    // so accompanying a real production change it does not trip the cheat guard.
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/ws-realtime.ts", "src/__tests__/drift/model-family.ts"],
      report: report([entry({ builderFile: "src/ws-realtime.ts", typesFile: null })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
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

  it("isComparisonLeg flags SDK/schema/harness/*.drift.ts but NOT legit fixture targets", () => {
    expect(isComparisonLeg("src/__tests__/drift/sdk-shapes.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/schema.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/providers.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/ws-providers.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/helpers.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/openai-chat.drift.ts")).toBe(true);
    // Legit fixture targets are NOT comparison legs.
    expect(isComparisonLeg("src/__tests__/drift/model-registry.ts")).toBe(false);
    expect(isComparisonLeg("src/__tests__/drift/model-family.ts")).toBe(false);
    expect(isComparisonLeg("src/__tests__/drift/voice-models.ts")).toBe(false);
    // Production files are not comparison legs.
    expect(isComparisonLeg("src/helpers.ts")).toBe(false);
  });

  it("isSuppressionSurface flags schema + *.drift.ts only", () => {
    expect(isSuppressionSurface("src/__tests__/drift/schema.ts")).toBe(true);
    expect(isSuppressionSurface("src/__tests__/drift/openai-chat.drift.ts")).toBe(true);
    expect(isSuppressionSurface("src/__tests__/drift/sdk-shapes.ts")).toBe(false);
    expect(isSuppressionSurface("src/helpers.ts")).toBe(false);
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
  it("throws PredicateConfigError on a missing file", () => {
    expect(() => readReport("/no/such/drift-report.json")).toThrow(PredicateConfigError);
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

  it("exits 11 for the comparison-leg-only cheat", () => {
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
    expect(code).toBe(11);
  });

  it("exits 0 for a real production fix", () => {
    const paths = writeReports(
      report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      report([]),
    );
    const code = runCli([
      "--report",
      paths.pre,
      "--post-fix-report",
      paths.post,
      "--post-fix-exit",
      "0",
      "--changed-file",
      "src/helpers.ts",
    ]);
    expect(code).toBe(0);
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
