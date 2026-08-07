/// <reference types="node" />

/**
 * Drift Sync Check — the deterministic REPLACEMENT for the 916-line LLM
 * anti-cheat predicate (`drift-success-predicate.ts`, spec §3/§6).
 *
 * `drift-sync.ts` (C2) never freewrites a fix — it only ever performs one of
 * two deterministic, data-only edits: (a) append one comment-marked family
 * literal to a `model-registry.ts` set (a recorded deprecation, or a
 * human-approved new family), or (b) drop a needs-human dedup note file
 * under `drift-proposals/`. Because the SYNC path can no longer produce an
 * arbitrary diff, verifying it is "real" no longer needs adversarial-intent
 * modeling or TS-diff parsing (the predicate's whole reason for being 916
 * lines) — it only needs three trivial, mechanical assertions:
 *
 *   1. CHANGED-FILE ALLOWLIST — every file the sync touched is either the
 *      model-registry DATA file or a `drift-proposals/` note file. Anything
 *      else (detector source, predicate, test harness, *.drift.ts, schema,
 *      sdk-shapes, CI workflow, ...) fails closed.
 *   2. CHECKSUM-PIN RE-ASSERT — P0's `logic-pin.test.ts` must still be green
 *      after the sync. Being on the allowlist above does NOT exempt
 *      `model-registry.ts` from this: a sync that mutated a frozen surface
 *      inside that file (familySet, NON_MODEL_TOKENS, PREVIEW_FAMILY, ...)
 *      is caught here even though the file itself was "allowed" to change.
 *   3. CLEAN RE-COLLECT — a fresh drift-report-collector run reports zero
 *      residual critical diffs, so a sync that claims to resolve drift but
 *      didn't is never waved through.
 *
 * No LLM, no model call, no heuristic scoring — every one of the three gates
 * above is a plain data check. A sync that fails any of them is NOT resolved
 * and no PR opens (mirrors the predicate's fail-closed contract, spec §3).
 *
 * C5 only ADDS this script + its test. Wiring it into `fix-drift.yml` in place
 * of the "Assert drift truly resolved" step, and deleting
 * `drift-success-predicate.ts`, is C3's job.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { getChangedFiles } from "./drift-sync.js";
import type { DriftReport } from "./drift-types.js";

// ---------------------------------------------------------------------------
// Reasons / exit codes
// ---------------------------------------------------------------------------

export enum SyncCheckReason {
  OK = "ok",
  OFF_ALLOWLIST_CHANGE = "off-allowlist-change",
  PIN_CHECK_FAILED = "pin-check-failed",
  RESIDUAL_CRITICAL_DRIFT = "residual-critical-drift",
  CONFIG_ERROR = "config-error",
}

export const REASON_EXIT_CODE: Record<SyncCheckReason, number> = {
  [SyncCheckReason.OK]: 0,
  [SyncCheckReason.OFF_ALLOWLIST_CHANGE]: 20,
  [SyncCheckReason.PIN_CHECK_FAILED]: 21,
  [SyncCheckReason.RESIDUAL_CRITICAL_DRIFT]: 22,
  [SyncCheckReason.CONFIG_ERROR]: 2,
};

/** Fail-closed config error (missing report, unreadable output, etc). */
export class SyncCheckConfigError extends Error {}

// ---------------------------------------------------------------------------
// (1) Changed-file allowlist — DATA surfaces only.
// ---------------------------------------------------------------------------

/**
 * The ONLY file a sync may edit directly: the model-registry DATA file
 * (`includeFamilies`/`excludeFamilies` literal entries). It also hosts P0's
 * frozen logic surfaces — see the pin re-assert in gate (2), which still
 * blocks an edit here that touches one of those surfaces.
 */
const ALLOWED_EXACT_FILES: ReadonlySet<string> = new Set(["src/__tests__/drift/model-registry.ts"]);

/**
 * Needs-human dedup note files (C2) live under this prefix — never a code
 * file, always a plain artifact recording a genuinely-new family alert.
 */
const ALLOWED_PREFIXES: readonly string[] = ["drift-proposals/"];

/** True when `file` is on the sync's data-only allowlist. */
export function isAllowedSyncFile(file: string): boolean {
  if (ALLOWED_EXACT_FILES.has(file)) return true;
  return ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/** Return the subset of `changedFiles` that is NOT on the allowlist. */
export function checkChangedFileAllowlist(changedFiles: string[]): string[] {
  return changedFiles.filter((file) => !isAllowedSyncFile(file));
}

// ---------------------------------------------------------------------------
// (2) Checksum-pin re-assert.
// ---------------------------------------------------------------------------

/** The exact test file P0 froze the classification logic in. Single source of truth. */
const LOGIC_PIN_TEST = "src/__tests__/drift/logic-pin.test.ts";

export interface CommandResult {
  status: number;
  output: string;
}

/** Run `file args...`, capturing stdout+stderr and the real exit status (never throws). */
export function runCommand(file: string, args: string[]): CommandResult {
  try {
    const output = execFileSync(file, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err: unknown) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return { status: e.status ?? 1, output };
  }
}

export interface PinCheckResult {
  ok: boolean;
  output: string;
}

/**
 * Re-assert P0's checksum freeze after a sync by spawning vitest directly
 * against `logic-pin.test.ts` — the SAME test file, not a re-implementation
 * of its hashing, so there is exactly one source of truth for "frozen".
 */
export function runPinCheck(
  runner: (file: string, args: string[]) => CommandResult = runCommand,
): PinCheckResult {
  const { status, output } = runner("pnpm", ["exec", "vitest", "run", LOGIC_PIN_TEST]);
  return { ok: status === 0, output };
}

// ---------------------------------------------------------------------------
// (3) Clean re-collect.
// ---------------------------------------------------------------------------

const DEFAULT_RECOLLECT_OUT = "drift-report.sync-check.json";

/** Count `severity === "critical"` diffs across every entry of a report. */
export function countCriticalDiffs(report: DriftReport): number {
  return report.entries.reduce(
    (sum, entry) => sum + entry.diffs.filter((d) => d.severity === "critical").length,
    0,
  );
}

/**
 * Run a fresh `drift-report-collector.ts` pass and read back its report. Throws
 * `SyncCheckConfigError` (fail-closed) if the collector did not produce a
 * readable report — a missing/corrupt post-sync report must never be treated
 * as an implicit "clean".
 */
export function recollect(
  runner: (file: string, args: string[]) => CommandResult = runCommand,
  outPath: string = resolve(DEFAULT_RECOLLECT_OUT),
): DriftReport {
  runner("npx", ["tsx", "scripts/drift-report-collector.ts", "--out", outPath]);
  if (!existsSync(outPath)) {
    throw new SyncCheckConfigError(`Clean re-collect did not produce a report at ${outPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outPath, "utf-8"));
  } catch (err: unknown) {
    throw new SyncCheckConfigError(
      `Post-sync report at ${outPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    throw new SyncCheckConfigError(
      `Post-sync report at ${outPath} has invalid structure: expected { entries: [...] }`,
    );
  }
  return parsed as DriftReport;
}

// ---------------------------------------------------------------------------
// The check (composition of gates 1-3).
// ---------------------------------------------------------------------------

export interface SyncCheckDeps {
  getChangedFiles: () => string[];
  runPinCheck: () => PinCheckResult;
  recollect: () => DriftReport;
}

export interface EvaluateSyncCheckOptions {
  /**
   * Run gate-1 (allowlist) + gate-2 (pin) but SKIP gate-3 (the live
   * re-collect). Used by the sync core for a run that applied a mechanical
   * registry edit but ALSO deferred a family to a human: a fresh collector run
   * would still (correctly) report that deferred family as residual critical
   * drift, so gate-3 is not a meaningful full-resolution check for such a run
   * and — left on — would wrongly revert the valid mechanical edit. Gate-1 and
   * gate-2 remain in force: the edit is still proven data-only with the frozen
   * classification logic intact.
   */
  skipRecollect?: boolean;
}

export interface SyncCheckVerdict {
  ok: boolean;
  reason: SyncCheckReason;
  detail: string;
  offendingFiles: string[];
}

/**
 * Evaluate the three deterministic gates in order, short-circuiting on the
 * first failure (fail-closed — no gate is skipped when an earlier one could
 * have already caught the problem, but there is no reason to pay for a live
 * re-collect once the changed-file/pin gates already refused).
 */
export function evaluateSyncCheck(
  deps: SyncCheckDeps,
  opts: EvaluateSyncCheckOptions = {},
): SyncCheckVerdict {
  const changedFiles = deps.getChangedFiles();
  const offendingFiles = checkChangedFileAllowlist(changedFiles);
  if (offendingFiles.length > 0) {
    return {
      ok: false,
      reason: SyncCheckReason.OFF_ALLOWLIST_CHANGE,
      detail: `Sync touched file(s) outside the data-only allowlist: ${offendingFiles.join(", ")}`,
      offendingFiles,
    };
  }

  const pin = deps.runPinCheck();
  if (!pin.ok) {
    return {
      ok: false,
      reason: SyncCheckReason.PIN_CHECK_FAILED,
      detail: `Frozen classification-logic checksum pin failed after sync — a pinned rule moved:\n${pin.output}`,
      offendingFiles: [],
    };
  }

  // gate-3 (live re-collect) is skipped for a run that ALSO deferred a family
  // to a human — see EvaluateSyncCheckOptions.skipRecollect.
  if (opts.skipRecollect) {
    return {
      ok: true,
      reason: SyncCheckReason.OK,
      detail:
        "drift-sync-check passed: changed files are data-only, classification pins intact " +
        "(live re-collect skipped — this run also deferred a family to a human)",
      offendingFiles: [],
    };
  }

  const report = deps.recollect();
  const criticalCount = countCriticalDiffs(report);
  if (criticalCount > 0) {
    return {
      ok: false,
      reason: SyncCheckReason.RESIDUAL_CRITICAL_DRIFT,
      detail: `Clean re-collect after sync still reports ${criticalCount} critical diff(s) — sync did not resolve the drift`,
      offendingFiles: [],
    };
  }

  return {
    ok: true,
    reason: SyncCheckReason.OK,
    detail:
      "drift-sync-check passed: changed files are data-only, classification pins intact, clean re-collect",
    offendingFiles: [],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const REAL_DEPS: SyncCheckDeps = {
  getChangedFiles,
  runPinCheck: () => runPinCheck(),
  recollect: () => recollect(),
};

/** Run the check against real deps, printing a machine-readable `reason=` line. */
export function runCli(deps: SyncCheckDeps = REAL_DEPS): number {
  let verdict: SyncCheckVerdict;
  try {
    verdict = evaluateSyncCheck(deps);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CONFIG_ERROR: ${msg}`);
    console.log(`reason=${SyncCheckReason.CONFIG_ERROR}`);
    return REASON_EXIT_CODE[SyncCheckReason.CONFIG_ERROR];
  }

  if (verdict.ok) {
    console.log(verdict.detail);
  } else {
    console.error(`DRIFT SYNC NOT RESOLVED [${verdict.reason}]: ${verdict.detail}`);
    if (verdict.offendingFiles.length > 0) {
      console.error(`Offending files: ${verdict.offendingFiles.join(", ")}`);
    }
  }
  console.log(`reason=${verdict.reason}`);
  return REASON_EXIT_CODE[verdict.reason];
}

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
  process.exit(runCli());
}
