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
 * ALLOWLIST MODEL (round-2 CR — replaces the earlier denylist). A denylist of
 * "known gameable legs" leaks: any editable collector input NOT on the list
 * (package.json/lockfile pinning a vendored SDK, a tsconfig, an imported
 * sub-fixture, an unknown path, a drift-dir `*.test.ts`) could accompany a token
 * on-target production edit and reach `resolved:true`. So the predicate INVERTS
 * to an allowlist: a fix is RESOLVED only when EVERY changed file is on the
 * allowlist, which is (a) PRODUCTION SOURCE — `src/**` that is NOT under
 * `src/__tests__/` and is not a config/manifest — PLUS (b) a fixture file
 * EXPLICITLY NAMED for a drift entry in the report (`entry.builderFile` /
 * `entry.typesFile`, e.g. a canary model-registry.ts the collector sanctioned).
 * ANYTHING else blocks: any other `src/__tests__/**` file (legs, `*.drift.ts`,
 * `*.test.ts`, providers/ws-providers/schema/sdk-shapes), package.json /
 * lockfiles / manifests / config, and any unrecognized path. All paths are
 * CANONICALIZED (strip `./`, collapse `//`, resolve `.`/`..`, reject repo-root
 * escapes) before classification so a spelling variant cannot sneak a leg past
 * the matcher.
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
 *   3. NO GAMEABLE-LEG EDIT AT ALL — the changed set touches NO gameable leg.
 *      HARDENED (fix #1): a gameable-leg edit ALWAYS blocks, INDEPENDENT of how
 *      many production files also changed. A legitimate auto-remediation updates
 *      the mock BUILDER to match the SDK; it never edits a comparison/SDK/harness
 *      leg (those change only on a deliberate human vendored-SDK bump). This
 *      closes the WS-2b hybrid cheat (relax a leg + one trivial on-target
 *      production edit) that the old "only check legs when productionFiles===0"
 *      logic passed straight to auto-merge. Schema/allowlist and `*.drift.ts`
 *      assertion edits always map to SUPPRESSION_SUSPECTED (actively silencing
 *      the detector); other gameable legs (sdk-shapes, harness incl the
 *      dual-classified voice-models.ts) map to SUPPRESSION_SUSPECTED when paired
 *      with a production change and COMPARISON_LEG_ONLY when standalone.
 *
 * Additionally, the production change should intersect the report's SANCTIONED
 * target set (`union(entry.builderFile, entry.typesFile≠null)`); an off-target
 * production change is a WARNING that still blocks (a shared helper MAY be the
 * real fix, so it is distinct from an outright cheat). An EMPTY sanctioned set is
 * fail-closed (fix #3): with no named target we cannot verify the change landed
 * where the drift lives, so it routes to human rather than rubber-stamps.
 *
 * CLI exit codes (mirrors drift-report-collector.ts's distinct-code discipline):
 *   0  — RESOLVED
 *   10 — NO_PRODUCTION_CHANGE
 *   11 — COMPARISON_LEG_ONLY          (leg edit with NO production change)
 *   12 — SUPPRESSION_SUSPECTED        (schema/*.drift.ts edit, OR any gameable
 *                                      leg edited ALONGSIDE a production change)
 *   13 — STILL_DIRTY                  (post-fix collector exit 2, or exit 0 with
 *                                      criticalCount>0)
 *   14 — QUARANTINE_AFTER_FIX         (post-fix collector exit 5 — checked BEFORE
 *                                      criticalCount, so exit 5 wins)
 *   15 — COLLECTOR_INFRA              (post-fix collector exit 1 — likewise wins
 *                                      over criticalCount)
 *   16 — PRODUCTION_CHANGE_OFF_TARGET (off-target OR zero sanctioned targets;
 *                                      WARNING, still blocks)
 *   17 — UNSANCTIONED_CHANGE          (a changed file is NOT on the allowlist —
 *                                      package.json/lockfile/config/unknown path/
 *                                      non-drift or drift `*.test.ts`; a real fix
 *                                      touches only production source + report-
 *                                      named fixture targets)
 *   18 — VERSION_BUMP_FAILED          (NOT scored by the predicate — surfaced by
 *                                      fix-drift.ts's createPr when the mandatory
 *                                      version bump / CHANGELOG step fails, so an
 *                                      unversioned fix that never publishes is
 *                                      never opened as a PR; fail-closed to human)
 *   2  — CONFIG_ERROR                 (missing/unreadable report, bad args, a
 *                                      --changed-file list that disagrees w/ git,
 *                                      a path escaping the repo root, or a
 *                                      malformed post-fix report that cannot be
 *                                      scored)
 *
 * Usage:
 *   npx tsx scripts/drift-success-predicate.ts \
 *     --report drift-report.json \
 *     --post-fix-report drift-report.post-fix.json \
 *     --post-fix-exit <N> \
 *     [--changed-file src/helpers.ts ...]
 *
 * When no --changed-file args are supplied the CLI derives the changed set from
 * `git status --porcelain` (mirrors fix-drift.ts:getChangedFiles()). When a
 * --changed-file list IS supplied it is cross-checked against git and rejected
 * (CONFIG_ERROR) on any mismatch (fix #4 — a leg-omitting list must not blind
 * the predicate).
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
  UNSANCTIONED_CHANGE = "unsanctioned-change",
  STILL_DIRTY = "still-dirty",
  QUARANTINE_AFTER_FIX = "quarantine-after-fix",
  COLLECTOR_INFRA = "collector-infra",
  PRODUCTION_CHANGE_OFF_TARGET = "production-change-off-target",
  CONFIG_ERROR = "config-error",
  /**
   * The version bump / CHANGELOG step failed while opening a drift-fix PR. A
   * release ALWAYS accompanies an auto-remediation; without it the PR would
   * merge a fix that never publishes (silent value loss). This is a hard,
   * fail-closed reason surfaced by fix-drift.ts's createPr — never produced by
   * the predicate's own scoring — routed to human review like any other
   * needs-human reason.
   */
  VERSION_BUMP_FAILED = "version-bump-failed",
  /**
   * The `--post-fix-*` arguments were present but could not be parsed/read
   * while opening a drift-fix PR (e.g. an empty/non-integer `--post-fix-exit`
   * from a skipped recollect, or an unreadable post-fix report). fix-drift.ts
   * already fails CLOSED on this (no PR), but the throw historically reached the
   * top-level catch with a BLANK `reason=`; this names the cause so the Slack
   * alert is not blank. Surfaced by fix-drift.ts's main(), never the predicate.
   */
  POST_FIX_PARSE_ERROR = "post-fix-parse-error",
  /**
   * A git operation (checkout / add / commit / push) failed while opening a
   * drift-fix PR. This fails CLOSED (no PR is opened — the push never completed,
   * so no partial/unversioned PR ships) but historically alerted with a BLANK
   * `reason=`; this names the cause. Surfaced by fix-drift.ts's createPr, never
   * the predicate.
   */
  GIT_PUSH_FAILED = "git-push-failed",
}

/** Stable exit code for each reason (see module header). */
export const REASON_EXIT_CODE: Record<PredicateReason, number> = {
  [PredicateReason.RESOLVED]: 0,
  [PredicateReason.NO_PRODUCTION_CHANGE]: 10,
  [PredicateReason.COMPARISON_LEG_ONLY]: 11,
  [PredicateReason.SUPPRESSION_SUSPECTED]: 12,
  [PredicateReason.UNSANCTIONED_CHANGE]: 17,
  [PredicateReason.STILL_DIRTY]: 13,
  [PredicateReason.QUARANTINE_AFTER_FIX]: 14,
  [PredicateReason.COLLECTOR_INFRA]: 15,
  [PredicateReason.PRODUCTION_CHANGE_OFF_TARGET]: 16,
  [PredicateReason.CONFIG_ERROR]: 2,
  [PredicateReason.VERSION_BUMP_FAILED]: 18,
  [PredicateReason.POST_FIX_PARSE_ERROR]: 19,
  [PredicateReason.GIT_PUSH_FAILED]: 20,
};

export interface PredicateInputs {
  /** Changed-file paths from getChangedFiles() (git porcelain). */
  changedFiles: string[];
  /** The ORIGINAL pre-fix drift report (source of sanctioned fix targets). */
  report: DriftReport;
  /** Exit code of the re-run collector (0 clean / 2 dirty / 5 quarantine / 1 infra). */
  postFixCollectorExit: number;
  /**
   * criticalCount parsed from the re-run report (belt-and-suspenders vs exit 0).
   *
   * FIX #7 — INDEPENDENCE CAVEAT: this signal (and the collector exit code) is
   * derived from the SAME fixtures the fixer was told to make pass, so it is
   * NOT independent of a fixture-relaxation cheat — a run that relaxed the SDK
   * leg reports clean here too. It is therefore only trustworthy BECAUSE the
   * ALLOWLIST gate now requires EVERY changed file to be production source or a
   * report-named fixture target (see isAllowlisted / the UNSANCTIONED_CHANGE +
   * SUPPRESSION_SUSPECTED + COMPARISON_LEG_ONLY branches). Any leg/fixture/config
   * edit that could relax the collector's own inputs is NOT allowlisted and
   * blocks, regardless of production files. That default-deny rule is
   * load-bearing: it is what makes a clean post-fix signal mean "the mock was
   * really fixed" rather than "an input the collector reads was relaxed".
   *
   * FIX #4 (assess) — the criticalCount and the post-fix exit code are both
   * scored from the AUTHORITATIVE in-workflow re-collect output
   * (drift-report.post-fix.json, written by the "Re-collect drift" step), NOT a
   * repo-committed file the fixer could forge: neither the pre-fix report nor the
   * post-fix report is committed to the repo (see .github/workflows/fix-drift.yml
   * — both are produced by collector invocations in-workflow). The re-collect
   * runs AFTER autofix and OVERWRITES anything written to that path during the
   * fix, so the predicate scores a freshly-generated report, not attacker
   * content.
   */
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

/** Thrown for malformed CLI args / unreadable inputs / bad paths — maps to exit 2. */
export class PredicateConfigError extends Error {}

// ---------------------------------------------------------------------------
// File classification (see spec §2)
// ---------------------------------------------------------------------------

/**
 * Canonicalize a git-reported path to a stable repo-relative POSIX form BEFORE
 * classification, so an equivalent-but-non-identical spelling of a leg cannot
 * sneak past the exact-string matchers (round-2 CR F1 / slot-1 / slot-2):
 *   - strip a leading `./`
 *   - collapse doubled slashes (`//` → `/`)
 *   - resolve `.` segments and interior `..` segments
 *   - FAIL CLOSED (PredicateConfigError → exit 2) on any path that escapes the
 *     repo root (a leading `..` after resolution) or is absolute — such a path
 *     was never a legitimate in-repo change and must not be silently reclassified.
 */
export function canonicalizePath(file: string): string {
  if (file.startsWith("/")) {
    throw new PredicateConfigError(`Refusing to classify an absolute path: ${file}`);
  }
  const rawSegments = file.split("/");
  const out: string[] = [];
  for (const seg of rawSegments) {
    if (seg === "" || seg === ".") continue; // drop empty (//, leading ./) and `.`
    if (seg === "..") {
      if (out.length === 0) {
        throw new PredicateConfigError(`Path escapes the repo root (fail-closed): ${file}`);
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

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
 * never counted as a comparison-leg cheat.
 *
 * FIX #2 — `voice-models.ts` is deliberately NOT listed here: it is also a
 * real-API HARNESS file, and block-classification wins over legit-accept
 * (fail-closed precedence). It is classified as a gameable leg in isGameableLeg.
 */
const LEGIT_FIXTURE_TARGETS: ReadonlySet<string> = new Set([
  "src/__tests__/drift/model-registry.ts",
  "src/__tests__/drift/model-family.ts",
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
 * GAMEABLE-LEG (the block set). Editing ANY of these can erase a drift diff
 * WITHOUT changing the mock output — either by relaxing a comparison leg (the
 * SDK-shape fixture, the schema/allowlist, the real-API harness) or by loosening
 * a `*.drift.ts` assertion. Every one of these is a HUMAN-REVIEWED artifact: a
 * legitimate auto-remediation updates the mock BUILDER to match the SDK, and the
 * leg only changes on a deliberate human vendored-SDK bump. So any leg edit —
 * ALONE OR ACCOMPANIED BY A PRODUCTION CHANGE — is fail-closed to needs-human
 * (SUPPRESSION_SUSPECTED). This closes the WS-2b hybrid cheat (relax a leg +
 * one trivial on-target production edit), which the old "only check legs when
 * productionFiles===0" logic let through to auto-merge.
 *
 * FIX #2 — CLASSIFICATION PRECEDENCE: a file that is BOTH a harness leg AND a
 * legit fixture target (e.g. `voice-models.ts`) is treated as gameable (block).
 * Block-classification wins over legit-accept; fail-closed. Only PURE legit
 * fixture targets (model-registry.ts / model-family.ts), which are NOT harness
 * legs, are excluded — a canary model-list fix routes to those plus its
 * production builder and is not blocked.
 */
export function isGameableLeg(file: string): boolean {
  // Block-set membership is checked FIRST (fix #2 precedence): a file that is
  // BOTH a harness leg AND a legit fixture target (voice-models.ts) matches
  // HARNESS_FILES here and blocks, before the legit-target set is ever consulted.
  if (file === SDK_SHAPES_FILE) return true;
  if (file === SCHEMA_FILE) return true;
  if (HARNESS_FILES.has(file)) return true;
  if (isDriftTestFile(file)) return true;
  // PURE legit fixture targets (not also a harness leg) are explicitly
  // non-gameable — a canary model-list fix routes here plus its production
  // builder and must not be blocked.
  if (LEGIT_FIXTURE_TARGETS.has(file)) return false;
  // Everything else (production files, unrelated paths) is non-gameable.
  return false;
}

/**
 * SUPPRESSION surface (the NARROW always-SUPPRESSION_SUSPECTED subset): the
 * triangulation schema/allowlist and `*.drift.ts` assertion files. Editing these
 * ACTIVELY SILENCES the detector (allowlist growth, loosened assertion) and is
 * never a valid fix — so it ALWAYS maps to SUPPRESSION_SUSPECTED, standalone or
 * alongside a production change. (The broader gameable-leg set below — sdk-shapes,
 * harness — also always blocks per fix #1, but maps to COMPARISON_LEG_ONLY when
 * standalone and SUPPRESSION_SUSPECTED only when paired with a production change.)
 */
export function isSuppressionSurface(file: string): boolean {
  return file === SCHEMA_FILE || isDriftTestFile(file);
}

/**
 * GAMEABLE-COMPARISON-LEG (retained for API compatibility / classification
 * unit coverage). Same full set as isGameableLeg — every leg edit blocks.
 */
export function isComparisonLeg(file: string): boolean {
  return isGameableLeg(file);
}

/**
 * Derive the SANCTIONED fix-target set from the pre-fix report:
 * `union(entry.builderFile, entry.typesFile≠null)`. These are the files the
 * collector itself named as the correct place to fix each drift.
 */
export function sanctionedTargets(report: DriftReport): Set<string> {
  const targets = new Set<string>();
  for (const entry of report.entries) {
    if (entry.builderFile) targets.add(canonicalizePath(entry.builderFile));
    if (entry.typesFile) targets.add(canonicalizePath(entry.typesFile));
  }
  return targets;
}

/**
 * ALLOWLIST membership (round-2 CR F1/F2/F3 — the inversion). A changed file is
 * SANCTIONED for an auto-fix run when it is either:
 *   (a) PRODUCTION SOURCE — `src/**` that is NOT under `src/__tests__/` (a mock
 *       builder / type file, the legitimate fix target); OR
 *   (b) a fixture file EXPLICITLY NAMED for a drift entry in the report
 *       (`entry.builderFile` / `entry.typesFile`, e.g. a canary model-registry.ts
 *       the collector itself sanctioned as the fix target for this run).
 *
 * EVERYTHING else is NOT allowlisted and blocks: any other `src/__tests__/**`
 * file (comparison legs, `*.drift.ts`, `*.test.ts`, providers/schema/sdk-shapes),
 * `package.json` / lockfiles / manifests / config, and any unrecognized path.
 * `file` MUST already be canonicalized; `sanctioned` is the canonicalized
 * sanctioned-target set (see sanctionedTargets).
 */
export function isAllowlisted(file: string, sanctioned: ReadonlySet<string>): boolean {
  if (isProductionFile(file)) return true;
  if (sanctioned.has(file)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The predicate (see spec §3)
// ---------------------------------------------------------------------------

export function evaluateDriftResolved(i: PredicateInputs): PredicateResult {
  const { report, postFixCollectorExit, postFixCriticalCount } = i;
  // Canonicalize every changed path BEFORE classification so a spelling variant
  // (`./src/...`, `src//...`, `.`/`..` segments) of a leg cannot slip past the
  // exact-string matchers (round-2 CR F1). An absolute path or a repo-root escape
  // throws PredicateConfigError from canonicalizePath → CONFIG_ERROR at the CLI.
  const changedFiles = i.changedFiles.map(canonicalizePath);

  // ---- Signal 1: AUTHORITATIVE — collector clean on re-run. -------------
  // Checked FIRST: a dirty/quarantine/infra collector makes any file-set moot.
  //
  // FIX #6 — the collector-STATE classification (exit 2/5/1) is checked BEFORE
  // the belt-and-suspenders criticalCount>0 branch. A quarantine (exit 5) or an
  // infra failure (exit 1) that ALSO happens to carry a parseable criticalCount>0
  // is a quarantine/infra event, NOT a plain STILL_DIRTY — it gets its own
  // distinct reason so the Slack alert names the real cause. STILL_DIRTY is
  // reserved for exit 2, or a clean-looking exit 0 that nonetheless reports
  // criticalCount>0 (report/exit disagreement).
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
  const targets = sanctionedTargets(report);
  const productionFiles = changedFiles.filter(isProductionFile);
  const gameableLegFiles = changedFiles.filter(isGameableLeg);
  const suppressionFiles = changedFiles.filter(isSuppressionSurface);

  // ---- Signal 3a (suppression surface): ALWAYS block, standalone or paired. -
  // Editing the schema/allowlist or a *.drift.ts assertion actively SILENCES the
  // detector — never a valid fix, even alongside a production change. Distinct
  // reason so the workflow's Slack alert names "silenced the detector".
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

  // ---- Signal 3b (gameable leg): ALWAYS block, independent of production. -
  // FIX #1 (HEADLINE) + FIX #2 — a legitimate auto-remediation updates the mock
  // BUILDER to match the SDK; it NEVER edits a comparison/SDK/harness leg (those
  // change only on a deliberate human vendored-SDK bump). So the presence of ANY
  // gameable-leg file blocks REGARDLESS of how many production files also
  // changed. This closes the WS-2b hybrid cheat (relax sdk-shapes.ts + one
  // trivial on-target production edit) that the old "only check legs when
  // productionFiles===0" logic passed straight to auto-merge. voice-models.ts is
  // dual-classified (harness + legit target) and blocks here (fix #2 precedence).
  //
  // Reason split (both distinct, both NEEDS-HUMAN in the workflow):
  //   • leg edit WITH a production change → SUPPRESSION_SUSPECTED — the WS-2b
  //     hybrid, the dangerous auto-merge vector.
  //   • leg edit with NO production change → COMPARISON_LEG_ONLY — a pure
  //     relaxation, no mock fix even attempted.
  if (gameableLegFiles.length > 0) {
    if (productionFiles.length > 0) {
      return {
        resolved: false,
        reason: PredicateReason.SUPPRESSION_SUSPECTED,
        detail:
          "Fix edited a gameable comparison/SDK/harness leg " +
          `(${gameableLegFiles.join(", ")}) ALONGSIDE a production change — relaxing a leg is never a valid ` +
          "drift fix (a real fix updates the mock builder, not the leg). The WS-2b hybrid cheat. Needs human review.",
        offendingFiles: gameableLegFiles,
      };
    }
    return {
      resolved: false,
      reason: PredicateReason.COMPARISON_LEG_ONLY,
      detail:
        "Fix changed ONLY comparison/SDK/harness-leg files " +
        `(${gameableLegFiles.join(", ")}) with no production mock-builder change — ` +
        "this relaxes the drift detector instead of fixing the mock. The exact cheat this gate blocks.",
      offendingFiles: gameableLegFiles,
    };
  }

  // ---- ALLOWLIST GATE (round-2 CR F1/F2/F3 — the inversion): EVERY changed file
  // must be on the allowlist. The suppression + gameable-leg branches above give
  // the KNOWN gameable legs their own LOUD, specific reasons; this gate catches
  // EVERYTHING ELSE that is not sanctioned — package.json / lockfiles / manifests
  // / config, a drift-dir `*.test.ts`, a non-drift `__tests__` file, an imported
  // sub-fixture the report did not name, or any unrecognized path. A denylist of
  // "known legs" leaks these; an allowlist does not (default-deny). This is what
  // closes the in-diff vectors (F3) and the drift-dir `.test.ts` gap.
  const unsanctionedFiles = changedFiles.filter((f) => !isAllowlisted(f, targets));
  if (unsanctionedFiles.length > 0) {
    return {
      resolved: false,
      reason: PredicateReason.UNSANCTIONED_CHANGE,
      detail:
        "Fix changed files that are NOT on the sanctioned allowlist " +
        `(${unsanctionedFiles.join(", ")}) — a real drift fix touches only production mock-builder ` +
        "source and the fixture targets the report named. Any other change (deps/config/manifests, " +
        "unrelated tests, unnamed fixtures) could game the collector. Fail-closed, needs human review.",
      offendingFiles: unsanctionedFiles,
    };
  }

  // ---- Signal 2: at least one PRODUCTION mock-builder change is present. --
  // The module invariant (Signal 2 in the header) is that a genuine drift fix
  // ALWAYS changes at least one production mock-builder file (`src/**` excluding
  // `src/__tests__/`) — that is the only place the mock output is produced. A run
  // that changed ZERO production files cannot be a real fix, even if it edited a
  // report-named fixture target (the canary model-registry.ts case): a
  // fixture-target-only change (e.g. adding a model id to the model-list fixture
  // with NO production/builder change) is NOT independently verifiable — the
  // re-collect's clean signal is derived from the same fixture the change touched,
  // so a clean post-fix report there means only "the fixture agrees with itself",
  // not "the mock was fixed". Fix #F2 (round-4): require >=1 production change for
  // RESOLVED, unconditionally. A fixture-target-only diff is routed to
  // needs-human (NO_PRODUCTION_CHANGE) rather than auto-resolved — matching the
  // docstring invariant, which the earlier `onTargetFiles`-satisfies-it logic
  // violated (it let a canary fixture-only edit reach resolved:true).
  const onTargetFiles = changedFiles.filter((f) => targets.has(f));
  if (productionFiles.length === 0) {
    return {
      resolved: false,
      reason: PredicateReason.NO_PRODUCTION_CHANGE,
      detail:
        "Fix changed zero production mock-builder files — a real drift fix always updates the " +
        "production mock builder (src/** outside src/__tests__/). A fixture-target-only change " +
        "(e.g. a model-list fixture edit with no builder change) is not independently verifiable " +
        "(the re-collect reads the same fixture) and is routed to human review, not auto-resolved.",
      offendingFiles: [],
    };
  }

  // ---- Signal 3 (on-target): the change must land on a file the report named as
  // a fix target. A production change to an UNNAMED file (a shared helper) MAY be
  // a legitimate fix, so it WARNS and blocks (distinct from a cheat).
  //
  // FIX #3 — an EMPTY sanctioned-target set is fail-closed, not a free pass. An
  // empty target set means the report could not name where to fix the drift —
  // route to human rather than rubber-stamp an unverifiable change.
  if (targets.size === 0) {
    return {
      resolved: false,
      reason: PredicateReason.PRODUCTION_CHANGE_OFF_TARGET,
      detail:
        "Drift report named ZERO sanctioned fix targets (no builderFile/typesFile) — cannot verify the " +
        `change (${productionFiles.join(", ")}) landed where the drift lives. Fail-closed, needs human review.`,
      offendingFiles: productionFiles,
    };
  }
  if (onTargetFiles.length === 0) {
    return {
      resolved: false,
      reason: PredicateReason.PRODUCTION_CHANGE_OFF_TARGET,
      detail:
        "Change did not touch any file the drift report named as a fix target " +
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
      `the change landed on a report-named fix target (${onTargetFiles.join(", ")}), and every ` +
      "changed file is on the sanctioned allowlist (production source + report-named fixture targets only).",
    offendingFiles: [],
  };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

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
        // FIX #6 — fail CLOSED on an empty/whitespace value. `Number("")` and
        // `Number("  ")` are both 0, which Number.isInteger accepts, so a missing
        // recollect output (`--post-fix-exit ""`) would masquerade as a clean
        // exit 0 and be trusted as authoritative-clean. Reject it explicitly.
        if (next.trim() === "") {
          throw new PredicateConfigError(
            "--post-fix-exit is empty/whitespace — a missing collector exit code must fail closed, not be treated as clean exit 0",
          );
        }
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
  // FIX #6 — align this (previously loose) validator with the stricter
  // fix-drift.ts:readDriftReport: a report missing/carrying a non-string
  // `timestamp` is a corrupt/truncated collector run and must fail-closed rather
  // than be silently trusted as a clean "drift is gone" signal. NOTE: an EMPTY
  // `entries: []` is intentionally ACCEPTED — that is exactly what the collector
  // emits when no drift remains (the legitimate clean signal); the trust anchor
  // for "clean" is the collector EXIT CODE plus fix #1's always-block-on-leg-edit
  // rule, not a non-empty entries array.
  if (typeof (parsed as Record<string, unknown>).timestamp !== "string") {
    throw new PredicateConfigError(
      `Drift report at ${path} is missing a string "timestamp" — corrupt/truncated report, failing closed`,
    );
  }

  // F3 — ENTRY-LEVEL validation, aligned with fix-drift.ts:readDriftReport. The
  // predicate reads `entry.builderFile` / `entry.typesFile` (sanctionedTargets)
  // and `entry.diffs` (countCriticalDiffs); a structurally-valid report whose
  // entries are malformed at those fields would otherwise throw a bare TypeError
  // deep inside classification, caught only by the outer runCli try/catch and
  // surfaced as an UNNAMED config-error. Validate here so every malformed shape
  // fails-closed with a DISTINCT, named PredicateConfigError → CONFIG_ERROR.
  const entries = (parsed as { entries: unknown[] }).entries;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as Record<string, unknown> | null | undefined;
    if (!entry || typeof entry !== "object") {
      throw new PredicateConfigError(`Drift report at ${path} entry[${i}] is not an object`);
    }
    if (typeof entry.builderFile !== "string" || entry.builderFile === "") {
      throw new PredicateConfigError(
        `Drift report at ${path} entry[${i}] has a missing/empty "builderFile" — cannot derive the sanctioned target set, failing closed`,
      );
    }
    if (entry.typesFile !== null && typeof entry.typesFile !== "string") {
      throw new PredicateConfigError(
        `Drift report at ${path} entry[${i}] "typesFile" must be a string or null, failing closed`,
      );
    }
    if (!Array.isArray(entry.diffs)) {
      throw new PredicateConfigError(
        `Drift report at ${path} entry[${i}] is missing a "diffs" array — cannot score criticalCount, failing closed`,
      );
    }
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

/**
 * Changed files from `git status --porcelain`. `-c core.quotePath=false` keeps
 * non-ASCII paths verbatim (UTF-8) rather than C-quoted/octal-escaped, so a leg
 * path with a special character is not mangled into a non-matching spelling
 * before classification (round-2 CR slot-1/slot-2 path finding).
 */
export function gitChangedFiles(): string[] {
  const out = execSync("git -c core.quotePath=false status --porcelain", {
    encoding: "utf-8",
  }).trimEnd();
  return out.split("\n").filter(Boolean).map(parsePorcelainLine);
}

/**
 * FIX #4 — AUTHORITATIVE changed-file set. The git working tree is the single
 * source of truth for what actually changed. An explicit `--changed-file` list
 * is only a hint, and a supplied list that OMITS a relaxed leg would BLIND the
 * predicate (the exact WS-2b vector, from the other side). So when a list is
 * supplied we cross-check it against git as a set and fail-closed
 * (PredicateConfigError → exit 2) on ANY disagreement — a missing file (leg
 * hidden) OR an extra file (phantom) both mean the caller's view diverges from
 * ground truth and the verdict cannot be trusted. When no list is supplied we
 * use the git set directly.
 */
export function crossCheckChangedFiles(explicit: string[] | null, git: string[]): string[] {
  if (explicit === null) return git;
  const gitSet = new Set(git);
  const explicitSet = new Set(explicit);
  const missing = git.filter((f) => !explicitSet.has(f)); // git has it, list omits it
  const extra = explicit.filter((f) => !gitSet.has(f)); // list has it, git does not
  if (missing.length > 0 || extra.length > 0) {
    throw new PredicateConfigError(
      "--changed-file list disagrees with the git working tree (fail-closed): " +
        `${missing.length > 0 ? `omitted by the list: ${missing.join(", ")}; ` : ""}` +
        `${extra.length > 0 ? `not present in git: ${extra.join(", ")}` : ""}`.trim(),
    );
  }
  return explicit;
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

  // FIX #4 — always derive the AUTHORITATIVE changed set from git, and
  // cross-check any supplied --changed-file list against it (fail-closed on
  // mismatch) so a leg-omitting list cannot blind the predicate.
  let changedFiles: string[];
  try {
    changedFiles = crossCheckChangedFiles(args.changedFiles, gitChangedFiles());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CONFIG_ERROR: ${msg}`);
    console.log(`reason=${PredicateReason.CONFIG_ERROR}`);
    return REASON_EXIT_CODE[PredicateReason.CONFIG_ERROR];
  }

  // FIX #8 — a post-fix report that structurally passes readReport (has a
  // string timestamp + an entries array) can still be malformed at the entry
  // level (e.g. an entry missing its `diffs` array), which would make
  // countCriticalDiffs throw a bare TypeError. evaluateDriftResolved can also
  // throw PredicateConfigError from canonicalizePath (a repo-root-escaping or
  // absolute changed-file path). Catch both here and map to a NAMED CONFIG_ERROR
  // so the human gets a named cause instead of an uncaught stacktrace with an
  // empty reason= line.
  let verdict: PredicateResult;
  try {
    verdict = evaluateDriftResolved({
      changedFiles,
      report,
      postFixCollectorExit: args.postFixExit,
      postFixCriticalCount: countCriticalDiffs(postFixReport),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CONFIG_ERROR: unable to score the drift reports: ${msg}`);
    console.log(`reason=${PredicateReason.CONFIG_ERROR}`);
    return REASON_EXIT_CODE[PredicateReason.CONFIG_ERROR];
  }

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
