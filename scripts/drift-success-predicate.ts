/// <reference types="node" />

/**
 * Drift-Success Predicate (WS-2)
 *
 * A pure predicate — plus a thin CLI wrapper — that decides whether an
 * auto-fix run ACTUALLY resolved API drift, versus merely GAMING the drift
 * detector by relaxing one of the comparison legs (the SDK-shape fixture, the
 * triangulation schema/allowlist, the real-API harness, or a `*.drift.ts`
 * assertion).
 *
 * The hole this closes: the drift tests are three-way triangulations
 * (SDK vs real API vs mock). The SDK leg is literally the repo fixture
 * `src/__tests__/drift/sdk-shapes.ts`. Deleting a field from that fixture makes
 * the SDK leg null for that path, so the "critical" branch cannot fire and the
 * collector reports clean (exit 0) WITHOUT any change to the mock builder.
 * Re-running the collector alone therefore cannot detect the cheat — its own
 * SDK leg reads the relaxed fixture. The old guard in fix-drift.ts
 * (`builderFiles.length === 0 && testFiles.length === 0`) ACCEPTS such a run
 * because `testFiles` is non-empty.
 *
 * The predicate requires THREE independent signals for `resolved:true`:
 *   1. AUTHORITATIVE — the post-fix collector re-run is clean (exit 0 AND
 *      criticalCount 0).
 *   2. PRODUCTION CHANGE — at least one PRODUCTION mock-builder file changed
 *      (`src/**` excluding `src/__tests__/`). A relaxation NEVER changes one.
 *   3. NO STANDALONE COMPARISON-LEG RELAXATION — a change that touches a
 *      gameable comparison leg must be ACCOMPANIED by a production change, and
 *      edits to the triangulation allowlist / `*.drift.ts` assertions are
 *      ALWAYS blocked (silencing the detector is never a valid drift fix).
 *
 * Additionally, the production change should intersect the report's SANCTIONED
 * target set (`union(entry.builderFile, entry.typesFile≠null)`); an off-target
 * production change is a WARNING that still blocks (a shared helper MAY be the
 * real fix, so it is distinct from an outright cheat).
 *
 * CLI exit codes (mirrors drift-report-collector.ts's distinct-code discipline):
 *   0  — RESOLVED
 *   10 — NO_PRODUCTION_CHANGE
 *   11 — COMPARISON_LEG_ONLY          (the headline cheat)
 *   12 — SUPPRESSION_SUSPECTED        (allowlist / *.drift.ts assertion edited)
 *   13 — STILL_DIRTY                  (post-fix collector exit 2)
 *   14 — QUARANTINE_AFTER_FIX         (post-fix collector exit 5)
 *   15 — COLLECTOR_INFRA              (post-fix collector exit 1)
 *   16 — PRODUCTION_CHANGE_OFF_TARGET (WARNING, still blocks)
 *   2  — CONFIG_ERROR                 (missing/unreadable report, bad args)
 *
 * Usage:
 *   npx tsx scripts/drift-success-predicate.ts \
 *     --report drift-report.json \
 *     --post-fix-report drift-report.post-fix.json \
 *     --post-fix-exit <N> \
 *     [--changed-file src/helpers.ts ...]
 *
 * When no --changed-file args are supplied the CLI derives the changed set from
 * `git status --porcelain` (mirrors fix-drift.ts:getChangedFiles()).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DriftReport } from "./drift-types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export enum PredicateReason {
  RESOLVED = "resolved",
  NO_PRODUCTION_CHANGE = "no-production-change",
  COMPARISON_LEG_ONLY = "comparison-leg-only",
  SUPPRESSION_SUSPECTED = "suppression-suspected",
  STILL_DIRTY = "still-dirty",
  QUARANTINE_AFTER_FIX = "quarantine-after-fix",
  COLLECTOR_INFRA = "collector-infra",
  PRODUCTION_CHANGE_OFF_TARGET = "production-change-off-target",
  CONFIG_ERROR = "config-error",
}

/** Stable exit code for each reason (see module header). */
export const REASON_EXIT_CODE: Record<PredicateReason, number> = {
  [PredicateReason.RESOLVED]: 0,
  [PredicateReason.NO_PRODUCTION_CHANGE]: 10,
  [PredicateReason.COMPARISON_LEG_ONLY]: 11,
  [PredicateReason.SUPPRESSION_SUSPECTED]: 12,
  [PredicateReason.STILL_DIRTY]: 13,
  [PredicateReason.QUARANTINE_AFTER_FIX]: 14,
  [PredicateReason.COLLECTOR_INFRA]: 15,
  [PredicateReason.PRODUCTION_CHANGE_OFF_TARGET]: 16,
  [PredicateReason.CONFIG_ERROR]: 2,
};

export interface PredicateInputs {
  /** Changed-file paths from getChangedFiles() (git porcelain). */
  changedFiles: string[];
  /** The ORIGINAL pre-fix drift report (source of sanctioned fix targets). */
  report: DriftReport;
  /** Exit code of the re-run collector (0 clean / 2 dirty / 5 quarantine / 1 infra). */
  postFixCollectorExit: number;
  /** criticalCount parsed from the re-run report (belt-and-suspenders vs exit 0). */
  postFixCriticalCount: number;
}

export interface PredicateResult {
  resolved: boolean;
  reason: PredicateReason;
  /** Human-readable one-liner for Slack / PR body. */
  detail: string;
  /** The subset of changedFiles that triggered a block (for LOUD alerts). */
  offendingFiles: string[];
}

// ---------------------------------------------------------------------------
// File classification (see spec §2)
// ---------------------------------------------------------------------------

/**
 * The triangulation SCHEMA file. Editing it (esp. its ALLOWLISTED_PATHS set)
 * silences diffs globally — a human-reviewed artifact, never a valid fix.
 */
const SCHEMA_FILE = "src/__tests__/drift/schema.ts";

/**
 * The SDK-shape fixture — the SDK leg of the three-way compare and the primary
 * cheat surface (relaxing it makes the critical branch unreachable).
 */
const SDK_SHAPES_FILE = "src/__tests__/drift/sdk-shapes.ts";

/**
 * The real-API call harness files. Weakening these could elicit a smaller real
 * shape (shrinking the real leg), making a diff disappear without a mock change.
 */
const HARNESS_FILES: ReadonlySet<string> = new Set([
  "src/__tests__/drift/providers.ts",
  "src/__tests__/drift/ws-providers.ts",
  "src/__tests__/drift/helpers.ts",
  "src/__tests__/drift/voice-models.ts",
]);

/**
 * LEGITIMATE-FIXTURE-THAT-IS-THE-FIX-TARGET: drift fixtures under
 * `src/__tests__/drift/` that ARE the correct fix target for certain drifts
 * (the known-models canary routes fixes to these model-list files). These are
 * NOT gameable comparison legs — adding a newly-shipped model id here is a
 * legit fix, not a relaxation. They are allowed as accompanying changes and are
 * never counted as a standalone comparison-leg cheat.
 */
const LEGIT_FIXTURE_TARGETS: ReadonlySet<string> = new Set([
  "src/__tests__/drift/model-registry.ts",
  "src/__tests__/drift/model-family.ts",
  "src/__tests__/drift/voice-models.ts",
]);

/**
 * True when `file` is a PRODUCTION mock-builder source file: under `src/` but
 * NOT under `src/__tests__/`. This matches fix-drift.ts's existing
 * `builderFiles` predicate exactly.
 */
export function isProductionFile(file: string): boolean {
  return file.startsWith("src/") && !file.startsWith("src/__tests__/");
}

/**
 * True when `file` is a `*.drift.ts` test file whose assertions could be
 * loosened to make a diff disappear (e.g. `expect(...).toEqual([])`).
 */
export function isDriftTestFile(file: string): boolean {
  return file.startsWith("src/__tests__/drift/") && file.endsWith(".drift.ts");
}

/**
 * SUPPRESSION surface: editing these ALWAYS blocks, even alongside a production
 * change, because silencing the detector (allowlist growth, loosened assertions)
 * is never a valid drift fix. The schema file carries ALLOWLISTED_PATHS; the
 * `*.drift.ts` files carry the assertions.
 */
export function isSuppressionSurface(file: string): boolean {
  return file === SCHEMA_FILE || isDriftTestFile(file);
}

/**
 * GAMEABLE-COMPARISON-LEG: a comparison leg (SDK fixture, schema, real-API
 * harness, or drift-test assertion) whose edit can erase a diff WITHOUT
 * changing mock output. Explicitly EXCLUDES LEGIT_FIXTURE_TARGETS
 * (canary model-list fixtures) — those are legit fix targets, not cheats.
 * Note `voice-models.ts` is both a harness file AND a legit canary target; it
 * is treated as a legit target (excluded here) so a canary fix is not blocked.
 */
export function isComparisonLeg(file: string): boolean {
  if (LEGIT_FIXTURE_TARGETS.has(file)) return false;
  if (file === SDK_SHAPES_FILE) return true;
  if (file === SCHEMA_FILE) return true;
  if (HARNESS_FILES.has(file)) return true;
  if (isDriftTestFile(file)) return true;
  return false;
}

/**
 * Derive the SANCTIONED fix-target set from the pre-fix report:
 * `union(entry.builderFile, entry.typesFile≠null)`. These are the files the
 * collector itself named as the correct place to fix each drift.
 */
export function sanctionedTargets(report: DriftReport): Set<string> {
  const targets = new Set<string>();
  for (const entry of report.entries) {
    if (entry.builderFile) targets.add(entry.builderFile);
    if (entry.typesFile) targets.add(entry.typesFile);
  }
  return targets;
}

// ---------------------------------------------------------------------------
// The predicate (see spec §3)
// ---------------------------------------------------------------------------

export function evaluateDriftResolved(i: PredicateInputs): PredicateResult {
  const { changedFiles, report, postFixCollectorExit, postFixCriticalCount } = i;

  // ---- Signal 1: AUTHORITATIVE — collector clean on re-run. -------------
  // Checked FIRST: a dirty/quarantine/infra collector makes any file-set moot.
  if (postFixCollectorExit === 2 || postFixCriticalCount > 0) {
    return {
      resolved: false,
      reason: PredicateReason.STILL_DIRTY,
      detail:
        "Post-fix drift collector still reports critical drift " +
        `(exit ${postFixCollectorExit}, criticalCount ${postFixCriticalCount}). The fix did not resolve the drift.`,
      offendingFiles: [],
    };
  }
  if (postFixCollectorExit === 5) {
    return {
      resolved: false,
      reason: PredicateReason.QUARANTINE_AFTER_FIX,
      detail:
        "Post-fix drift collector returned quarantine (exit 5) — unparseable/untrusted output after the fix. Needs human review.",
      offendingFiles: [],
    };
  }
  if (postFixCollectorExit === 1) {
    return {
      resolved: false,
      reason: PredicateReason.COLLECTOR_INFRA,
      detail:
        "Post-fix drift collector returned infra failure (exit 1) — AG-UI skipped or the collector crashed. Cannot trust a clean signal.",
      offendingFiles: [],
    };
  }
  if (postFixCollectorExit !== 0) {
    // Any other non-zero exit is an unrecognized collector state — fail closed.
    return {
      resolved: false,
      reason: PredicateReason.COLLECTOR_INFRA,
      detail: `Post-fix drift collector returned an unexpected exit code (${postFixCollectorExit}). Failing closed.`,
      offendingFiles: [],
    };
  }

  // ---- Classify the changed-file set. -----------------------------------
  const productionFiles = changedFiles.filter(isProductionFile);
  const comparisonLegFiles = changedFiles.filter(isComparisonLeg);
  const suppressionFiles = changedFiles.filter(isSuppressionSurface);

  // ---- Signal 3 (suppression): ALWAYS block. ----------------------------
  // Edits to the allowlist/schema or a *.drift.ts assertion silence the
  // detector and are never a valid fix — block even with a production change.
  if (suppressionFiles.length > 0) {
    return {
      resolved: false,
      reason: PredicateReason.SUPPRESSION_SUSPECTED,
      detail:
        "Fix edited the triangulation schema/allowlist or a *.drift.ts assertion " +
        `(${suppressionFiles.join(", ")}) — silencing the drift detector is never a valid fix. Needs human review.`,
      offendingFiles: suppressionFiles,
    };
  }

  // ---- Signal 2: PRODUCTION change present. ------------------------------
  if (productionFiles.length === 0) {
    // No production change at all. Distinguish the pure comparison-leg cheat
    // (the headline case) from a truly empty / non-source change.
    if (comparisonLegFiles.length > 0) {
      return {
        resolved: false,
        reason: PredicateReason.COMPARISON_LEG_ONLY,
        detail:
          "Fix changed ONLY comparison-leg files " +
          `(${comparisonLegFiles.join(", ")}) with no production mock-builder change — ` +
          "this relaxes the drift detector instead of fixing the mock. The exact cheat this gate blocks.",
        offendingFiles: comparisonLegFiles,
      };
    }
    return {
      resolved: false,
      reason: PredicateReason.NO_PRODUCTION_CHANGE,
      detail:
        "Fix changed zero PRODUCTION mock-builder files — a clean collector is meaningless without a real mock change. Nothing shippable.",
      offendingFiles: [],
    };
  }

  // ---- Signal 3 (off-target WARNING): production change must intersect ---
  // the report's sanctioned target set. A shared helper MAY legitimately be
  // the real fix, so this WARNS and blocks but is distinct from a cheat.
  const targets = sanctionedTargets(report);
  const onTarget = productionFiles.some((f) => targets.has(f));
  if (targets.size > 0 && !onTarget) {
    return {
      resolved: false,
      reason: PredicateReason.PRODUCTION_CHANGE_OFF_TARGET,
      detail:
        "Production change did not touch any file the drift report named as a fix target " +
        `(changed: ${productionFiles.join(", ")}; sanctioned: ${[...targets].join(", ")}). ` +
        "May be a legitimate shared-helper fix — needs human review.",
      offendingFiles: productionFiles,
    };
  }

  // ---- All signals satisfied. -------------------------------------------
  return {
    resolved: true,
    reason: PredicateReason.RESOLVED,
    detail:
      "Drift genuinely resolved: post-fix collector clean, " +
      `real production change (${productionFiles.join(", ")}), no comparison-leg relaxation.`,
    offendingFiles: [],
  };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/** Thrown for malformed CLI args / unreadable inputs — maps to exit 2. */
export class PredicateConfigError extends Error {}

interface CliArgs {
  reportPath: string;
  postFixReportPath: string;
  postFixExit: number;
  /** Explicit changed files, or null to derive from git. */
  changedFiles: string[] | null;
}

/** Parse argv (without node/script) into CliArgs. Throws PredicateConfigError. */
export function parseCliArgs(argv: string[]): CliArgs {
  let reportPath: string | null = null;
  let postFixReportPath: string | null = null;
  let postFixExit: number | null = null;
  const changedFiles: string[] = [];
  let sawChangedFlag = false;

  for (let idx = 0; idx < argv.length; idx++) {
    const arg = argv[idx];
    const next = argv[idx + 1];
    switch (arg) {
      case "--report":
        if (!next) throw new PredicateConfigError("--report requires a path argument");
        reportPath = next;
        idx++;
        break;
      case "--post-fix-report":
        if (!next) throw new PredicateConfigError("--post-fix-report requires a path argument");
        postFixReportPath = next;
        idx++;
        break;
      case "--post-fix-exit": {
        if (next === undefined)
          throw new PredicateConfigError("--post-fix-exit requires a numeric argument");
        const parsed = Number(next);
        if (!Number.isInteger(parsed)) {
          throw new PredicateConfigError(`--post-fix-exit must be an integer, got "${next}"`);
        }
        postFixExit = parsed;
        idx++;
        break;
      }
      case "--changed-file":
        if (!next) throw new PredicateConfigError("--changed-file requires a path argument");
        sawChangedFlag = true;
        changedFiles.push(next);
        idx++;
        break;
      default:
        throw new PredicateConfigError(`Unknown argument: ${arg}`);
    }
  }

  if (!reportPath) throw new PredicateConfigError("--report is required");
  if (!postFixReportPath) throw new PredicateConfigError("--post-fix-report is required");
  if (postFixExit === null) throw new PredicateConfigError("--post-fix-exit is required");

  return {
    reportPath,
    postFixReportPath,
    postFixExit,
    changedFiles: sawChangedFlag ? changedFiles : null,
  };
}

/** Minimal drift-report read + shape validation. Throws PredicateConfigError. */
export function readReport(path: string): DriftReport {
  if (!existsSync(path)) {
    throw new PredicateConfigError(`Drift report not found at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    throw new PredicateConfigError(
      `Drift report at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    throw new PredicateConfigError(
      `Drift report at ${path} has invalid structure: expected { entries: [...] }`,
    );
  }
  return parsed as DriftReport;
}

/**
 * Count critical diffs in a (post-fix) report. Belt-and-suspenders against a
 * collector exit code that disagrees with the report contents.
 */
export function countCriticalDiffs(report: DriftReport): number {
  return report.entries.reduce(
    (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
    0,
  );
}

/**
 * Parse a `git status --porcelain` line into a file path. Handles quoted paths
 * and rename notation. Kept in sync with fix-drift.ts:parsePorcelainLine.
 */
export function parsePorcelainLine(line: string): string {
  let path = line.slice(3).trim();
  const arrowIdx = path.indexOf(" -> ");
  if (arrowIdx !== -1) path = path.slice(arrowIdx + 4);
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  return path;
}

/** Changed files from `git status --porcelain`. */
export function gitChangedFiles(): string[] {
  const out = execSync("git status --porcelain", { encoding: "utf-8" }).trimEnd();
  return out.split("\n").filter(Boolean).map(parsePorcelainLine);
}

/**
 * Run the predicate from CLI args. Returns the process exit code and prints
 * `detail` (and offending files for LOUD reasons) to stdout/stderr.
 */
export function runCli(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CONFIG_ERROR: ${msg}`);
    console.log(`reason=${PredicateReason.CONFIG_ERROR}`);
    return REASON_EXIT_CODE[PredicateReason.CONFIG_ERROR];
  }

  let report: DriftReport;
  let postFixReport: DriftReport;
  try {
    report = readReport(args.reportPath);
    postFixReport = readReport(args.postFixReportPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CONFIG_ERROR: ${msg}`);
    console.log(`reason=${PredicateReason.CONFIG_ERROR}`);
    return REASON_EXIT_CODE[PredicateReason.CONFIG_ERROR];
  }

  let changedFiles: string[];
  try {
    changedFiles = args.changedFiles ?? gitChangedFiles();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CONFIG_ERROR: could not read changed files from git: ${msg}`);
    console.log(`reason=${PredicateReason.CONFIG_ERROR}`);
    return REASON_EXIT_CODE[PredicateReason.CONFIG_ERROR];
  }

  const verdict = evaluateDriftResolved({
    changedFiles,
    report,
    postFixCollectorExit: args.postFixExit,
    postFixCriticalCount: countCriticalDiffs(postFixReport),
  });

  if (verdict.resolved) {
    console.log(verdict.detail);
  } else {
    console.error(`DRIFT NOT RESOLVED [${verdict.reason}]: ${verdict.detail}`);
    if (verdict.offendingFiles.length > 0) {
      console.error(`Offending files: ${verdict.offendingFiles.join(", ")}`);
    }
  }
  // Emit a machine-readable reason line for the workflow to capture.
  console.log(`reason=${verdict.reason}`);
  return REASON_EXIT_CODE[verdict.reason];
}

// ---------------------------------------------------------------------------
// Entry-point guard (mirrors drift-report-collector.ts:isDirectRun)
// ---------------------------------------------------------------------------

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exit(runCli(process.argv.slice(2)));
}
