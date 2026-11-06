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
 * WHAT GATE-3 IS AND IS NOT (run 31465219443, 2026-08-11). The re-collect runs
 * in the same workspace as the fix, so it can FILTER a cheat but cannot PROVE
 * correctness — that has always been its contract. What it also cannot do is
 * answer a question about an edit it has no surface for: two consecutive runs of
 * the identical changeset `74f6efa43753f7d0` (two gemini deprecations) got
 * `gate-failed` and then `ok-applied`, because gate-3's input is a fresh LIVE
 * observation of EVERY drift surface aimock has, and nothing about that is a
 * function of the changeset. So gate-3 now:
 *
 *   * is SKIPPED, with the reason recorded in the verdict, when the caller knows
 *     a re-collect cannot observe this run's edit (`skipRecollect`);
 *   * REFUSES on a positive critical finding and NAMES the diffs, so the next
 *     refusal is triageable from the log instead of being a bare count;
 *   * stops claiming "clean re-collect" for a zero it cannot believe — a
 *     quarantined or AG-UI-skipped report is reported as UNCONFIRMED, carried by
 *     gates 1 and 2 (see `reportTrustNote`).
 *
 * C5 only ADDS this script + its test. Wiring it into `fix-drift.yml` in place
 * of the "Assert drift truly resolved" step, and deleting
 * `drift-success-predicate.ts`, is C3's job.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  MODEL_REGISTRY_REL_PATH,
  familySetMemberLines,
  gate3SkipReason,
  getChangedFiles,
  type FamilyOutcome,
  type Provider,
} from "./drift-sync.js";
import { LOGIC_PIN_REL_PATH, SYNC_REPINNABLE_KEYS, verifyPinFileEdit } from "./drift-pin-file.js";
import type { DriftReport } from "./drift-types.js";

// ---------------------------------------------------------------------------
// Reasons / exit codes
// ---------------------------------------------------------------------------

export enum SyncCheckReason {
  OK = "ok",
  OFF_ALLOWLIST_CHANGE = "off-allowlist-change",
  PIN_FILE_NOT_A_MEMBERSHIP_REPIN = "pin-file-not-a-membership-repin",
  PIN_CHECK_FAILED = "pin-check-failed",
  RESIDUAL_CRITICAL_DRIFT = "residual-critical-drift",
  CONFIG_ERROR = "config-error",
}

export const REASON_EXIT_CODE: Record<SyncCheckReason, number> = {
  [SyncCheckReason.OK]: 0,
  [SyncCheckReason.OFF_ALLOWLIST_CHANGE]: 20,
  [SyncCheckReason.PIN_FILE_NOT_A_MEMBERSHIP_REPIN]: 23,
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
 * The files a sync may edit directly: the model-registry DATA file
 * (`includeFamilies`/`excludeFamilies` literal entries), and the membership
 * pins that describe it. model-registry.ts also hosts P0's frozen logic
 * surfaces — see the pin re-assert in gate (2), which blocks an edit there that
 * touches one of those surfaces. Gate-2 cannot do the same job for
 * `logic-pin.test.ts`, because that file is gate-2's own oracle: re-pasting a
 * FROZEN checksum makes gate-2 green BY CONSTRUCTION. `checkPinFileEdit`
 * (gate-1b) is what constrains that file.
 */
const ALLOWED_EXACT_FILES: ReadonlySet<string> = new Set([
  "src/__tests__/drift/model-registry.ts",
  // The membership checksums live here, and drift-sync re-pins the ONE affected
  // key in the same run that applies a human-approved classification. Without
  // the entry the approved edit lands and gate-2 immediately reds on the
  // now-stale pin, so every approval reported gate-failed instead of ok-applied
  // — the approval affordance the note advertises never worked.
  //
  // ADMITTING IT AT THE PATH LEVEL IS NOT THE WHOLE STORY, and it must not be:
  // `model-registry.ts` is allowlisted too, so a path-level admission alone lets
  // a run widen `isClassifiedFamily` AND re-paste that surface's FROZEN pin, and
  // pass gate-1 and gate-2 both — the exact "bot told to make the drift job
  // pass" this file's own header names (reproduced; see checkPinFileEdit).
  // `checkPinFileEdit` below is the narrowing, and it runs HERE, over the git
  // diff, not inside the writer: a constraint on the pin file that only the
  // writer enforces is not a constraint on the pin file.
  "src/__tests__/drift/logic-pin.test.ts",
]);

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

/**
 * Gate-1b: a `logic-pin.test.ts` diff must be a MEMBERSHIP RE-PIN and nothing
 * else — no byte outside a `pin:` literal moved, and the only pins that moved
 * belong to the six `(include|exclude)Families.<provider>` DATA_FROZEN keys.
 *
 * This is the constraint that replaces the path-level admission above. It is
 * evaluated on the DIFF (HEAD vs the working tree), so it holds for whatever
 * produced the edit — not only for the writer that promises to behave.
 *
 * `before` is the file at HEAD; `after` is the working tree.
 */
export function checkPinFileEdit(before: string, after: string): { ok: boolean; detail: string } {
  return verifyPinFileEdit(before, after, SYNC_REPINNABLE_KEYS);
}

// ---------------------------------------------------------------------------
// (2) Checksum-pin re-assert.
// ---------------------------------------------------------------------------

/** The exact test file P0 froze the classification logic in. Single source of truth. */
const LOGIC_PIN_TEST = LOGIC_PIN_REL_PATH;

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

/** One residual critical diff, identified well enough to triage without re-running anything. */
export interface CriticalDiffRef {
  provider: string;
  scenario: string;
  path: string;
  id?: string;
}

/**
 * Every `severity === "critical"` diff in a report, IDENTIFIED.
 *
 * The gate used to carry only a COUNT into its verdict, and the re-collect report
 * itself (`drift-report.sync-check.json`) is never uploaded by the workflow. So
 * `gate-failed … still reports 1 critical diff(s)` was the entire record of run
 * 31465219443 — which diff fired that morning is NOT recoverable from it. Naming
 * the diffs is what makes the next one diagnosable from the log alone.
 */
export function listCriticalDiffs(report: DriftReport): CriticalDiffRef[] {
  return report.entries.flatMap((entry) =>
    entry.diffs
      .filter((d) => d.severity === "critical")
      .map((d) => ({
        provider: entry.provider,
        scenario: entry.scenario,
        path: d.path,
        ...(d.id !== undefined ? { id: d.id } : {}),
      })),
  );
}

/** Count `severity === "critical"` diffs across every entry of a report. */
export function countCriticalDiffs(report: DriftReport): number {
  return listCriticalDiffs(report).length;
}

/** Render `listCriticalDiffs` output for a verdict detail line. */
export function formatCriticalDiffs(diffs: readonly CriticalDiffRef[]): string {
  return diffs.map((d) => `${d.provider}/${d.scenario}: ${d.id ?? d.path}`).join("; ");
}

/**
 * Can a ZERO critical count in this report be believed as "the live suite is
 * clean", or did the collector fail to make a trustworthy, complete observation?
 *
 * The collector writes `conclusion` from its own exit code
 * (`conclusionForExitCode`): "clean" (0), "critical" (2), "quarantine" (5 — a
 * failure it could not parse into a trustworthy finding) or "skipped" (1 — the
 * AG-UI drift leg could not run, so `entries` is missing that whole surface).
 * Only "clean" and "critical" are positive determinations.
 *
 * This gate used to read `entries` alone, so a quarantined or AG-UI-skipped
 * re-collect counted zero criticals and was reported as a "clean re-collect" —
 * an UNKNOWN collapsing into the answer that passes. Both mornings of the
 * 74f6efa43753f7d0 pair quarantined on the same live Gemini WS timeout, and the
 * 08-12 log claims a clean re-collect for it.
 *
 * A zero that cannot be believed does not become a REFUSAL — a refusal would red
 * an unattended cron on someone else's flaky live surface. It stops being a CLAIM:
 * the verdict says the re-collect could not confirm the edit, and gate-1 and
 * gate-2 carry it. A positive critical finding is still a refusal (see
 * `evaluateSyncCheck`) — an UNKNOWN must not veto, but a POSITIVE finding must.
 */
export function reportTrustNote(report: DriftReport): string | null {
  const quarantined = report.quarantine?.length ?? 0;
  if (quarantined > 0) {
    return `the collector quarantined ${quarantined} failure(s) it could not parse into a trustworthy finding`;
  }
  if (report.conclusion === undefined) {
    return "the report carries no `conclusion`, so the collector's own verdict on it is unknown";
  }
  if (report.conclusion === "skipped") {
    return "the collector's AG-UI drift leg could not run, so the report is missing that surface entirely";
  }
  if (report.conclusion !== "clean" && report.conclusion !== "critical") {
    return `the collector reported conclusion="${report.conclusion}", which is not a positive determination`;
  }
  return null;
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
// (3a) When gate-3 cannot observe the edit — derived from the DIFF, not trusted.
// ---------------------------------------------------------------------------

const SYNC_PROVIDERS: readonly Provider[] = ["openai", "anthropic", "gemini"];

/**
 * Read a registry diff back into the `deprecation-recorded` outcomes that would
 * have produced it, or `null` when the diff is anything else.
 *
 * `null` unless BOTH hold: every member added to a `deprecatedFamilies.<provider>`
 * array sits on its own line, and deleting exactly those lines from `after`
 * reproduces `before` byte for byte. So any other edit — an `includeFamilies` or
 * `excludeFamilies` change, a removal, a touched rule — returns `null`, and the
 * live re-collect runs.
 */
export function deprecationOnlyOutcomes(before: string, after: string): FamilyOutcome[] | null {
  const outcomes: FamilyOutcome[] = [];
  const addedLines = new Set<number>();
  for (const provider of SYNC_PROVIDERS) {
    const was = familySetMemberLines(before, "deprecatedFamilies", provider);
    const now = familySetMemberLines(after, "deprecatedFamilies", provider);
    if (was === null || now === null) return null;
    for (const [family, line] of now) {
      if (was.has(family)) continue;
      outcomes.push({
        provider,
        family,
        action: "deprecation-recorded",
        detail: `recorded in deprecatedFamilies.${provider} (read from the diff)`,
      });
      addedLines.add(line);
    }
  }
  const rest = after
    .split("\n")
    .filter((_, i) => !addedLines.has(i))
    .join("\n");
  return rest === before ? outcomes : null;
}

/**
 * Why gate-3 cannot observe this change set, or `null` when it must run. The
 * answer is drift-sync's own {@link gate3SkipReason}, applied to outcomes this
 * check re-derives from the diff (`changedFiles`, and the registry before and
 * after) instead of taking drift-sync's word for them. Only a diff that touches
 * `model-registry.ts` alone and only appends to `deprecatedFamilies` qualifies.
 */
export function recollectSkipReason(
  changedFiles: readonly string[],
  readRegistryBefore: () => string,
  readRegistryAfter: () => string,
): string | null {
  if (changedFiles.length !== 1 || changedFiles[0] !== MODEL_REGISTRY_REL_PATH) return null;
  const outcomes = deprecationOnlyOutcomes(readRegistryBefore(), readRegistryAfter());
  if (outcomes === null || outcomes.length === 0) return null;
  return gate3SkipReason(outcomes);
}

// ---------------------------------------------------------------------------
// The check (composition of gates 1-3).
// ---------------------------------------------------------------------------

export interface SyncCheckDeps {
  getChangedFiles: () => string[];
  /**
   * `logic-pin.test.ts` as of HEAD (pre-sync) and in the working tree
   * (post-sync), for gate-1b. Required, not optional: a gate that silently
   * turns itself off when a dep is absent is not a gate.
   */
  readCommittedPinFile: () => string;
  readWorkingPinFile: () => string;
  runPinCheck: () => PinCheckResult;
  recollect: () => DriftReport;
}

export interface EvaluateSyncCheckOptions {
  /**
   * Run gate-1 (allowlist) + gate-2 (pin) but SKIP gate-3 (the live
   * re-collect), because for THIS run's edit a fresh collector run cannot
   * answer the question gate-3 asks. Two such runs exist — see
   * `gate3SkipReason` in drift-sync.ts for both, with their evidence. Gate-1
   * and gate-2 remain in force: the edit is still proven data-only with the
   * frozen classification logic intact.
   */
  skipRecollect?: boolean;
  /**
   * WHY gate-3 was skipped, quoted into the verdict detail. Required whenever
   * `skipRecollect` is set: a skipped gate that does not say what it could not
   * observe reads in the log exactly like a gate that ran and passed.
   */
  skipRecollectReason?: string;
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

  if (changedFiles.includes(LOGIC_PIN_TEST)) {
    const pinEdit = checkPinFileEdit(deps.readCommittedPinFile(), deps.readWorkingPinFile());
    if (!pinEdit.ok) {
      return {
        ok: false,
        reason: SyncCheckReason.PIN_FILE_NOT_A_MEMBERSHIP_REPIN,
        detail:
          `${LOGIC_PIN_TEST} is on the allowlist ONLY for membership re-pins of ` +
          `${[...SYNC_REPINNABLE_KEYS].sort().join(", ")}, and this diff is not one: ${pinEdit.detail}`,
        offendingFiles: [LOGIC_PIN_TEST],
      };
    }
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

  // gate-3 (live re-collect) is skipped when it cannot observe THIS run's edit —
  // see EvaluateSyncCheckOptions.skipRecollect.
  if (opts.skipRecollect) {
    // A skip with no stated reason reads in the log exactly like a gate that ran
    // and passed, so it is a CONFIG ERROR rather than a silent default: the
    // caller that turns gate-3 off must say what it could not observe.
    if (!opts.skipRecollectReason) {
      throw new SyncCheckConfigError(
        "skipRecollect was set with no skipRecollectReason — a gate that is turned off " +
          "must record why, or its verdict is indistinguishable from a gate that ran",
      );
    }
    return {
      ok: true,
      reason: SyncCheckReason.OK,
      detail:
        "drift-sync-check passed: changed files are data-only, classification pins intact " +
        `(live re-collect NOT RUN — ${opts.skipRecollectReason}; ` +
        "this edit is carried by gate-1 + gate-2, not by a re-collect)",
      offendingFiles: [],
    };
  }

  const report = deps.recollect();
  const criticalDiffs = listCriticalDiffs(report);
  if (criticalDiffs.length > 0) {
    // A POSITIVE finding, so it refuses — and it names the diffs, because a bare
    // count is not triageable after the fact (see `listCriticalDiffs`).
    return {
      ok: false,
      reason: SyncCheckReason.RESIDUAL_CRITICAL_DRIFT,
      detail:
        `Clean re-collect after sync still reports ${criticalDiffs.length} critical diff(s) — ` +
        `sync did not resolve the drift: ${formatCriticalDiffs(criticalDiffs)}`,
      offendingFiles: [],
    };
  }

  // Zero criticals. Whether that zero is BELIEVABLE is a separate question — a
  // quarantined or incomplete re-collect must not be reported as a clean one.
  const trustNote = reportTrustNote(report);
  if (trustNote !== null) {
    return {
      ok: true,
      reason: SyncCheckReason.OK,
      detail:
        "drift-sync-check passed: changed files are data-only, classification pins intact " +
        `(re-collect found no critical drift but could NOT CONFIRM the edit — ${trustNote}; ` +
        "this edit is carried by gate-1 + gate-2)",
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

/**
 * A tracked file's content at HEAD. Fail-closed: if git cannot produce it, the
 * gate has no baseline to judge the diff against and must refuse, never fall
 * back to "assume unchanged".
 */
export function readCommittedFile(relPath: string, rev = "HEAD"): string {
  try {
    return execFileSync("git", ["show", `${rev}:${relPath}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    throw new SyncCheckConfigError(
      `Could not read ${relPath} at ${rev} (${err instanceof Error ? err.message : String(err)}) — ` +
        `the check cannot judge a diff without its pre-sync baseline`,
    );
  }
}

/** Every file that differs from `base`: committed since it, staged, unstaged or untracked. */
export function changedFilesSince(base: string): string[] {
  let committed: string;
  try {
    committed = execFileSync("git", ["diff", "--name-only", "--no-renames", base], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    throw new SyncCheckConfigError(
      `Could not diff against --base ${base} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return [...new Set([...committed.split("\n").filter(Boolean), ...getChangedFiles()])].sort();
}

/** The CLI deps: the gates, plus the gate-3 skip derived from the diff against `base`. */
export interface CliDeps extends SyncCheckDeps {
  /** See {@link recollectSkipReason}. `null` runs the live re-collect. */
  recollectSkipReason: () => string | null;
}

export function realCliDeps(base: string): CliDeps {
  return {
    getChangedFiles,
    readCommittedPinFile: () => readCommittedFile(LOGIC_PIN_TEST),
    readWorkingPinFile: () => readFileSync(resolve(LOGIC_PIN_TEST), "utf-8"),
    runPinCheck: () => runPinCheck(),
    recollect: () => recollect(),
    recollectSkipReason: () =>
      recollectSkipReason(
        changedFilesSince(base),
        () => readCommittedFile(MODEL_REGISTRY_REL_PATH, base),
        () => readFileSync(resolve(MODEL_REGISTRY_REL_PATH), "utf-8"),
      ),
  };
}

/**
 * `--base <rev>`: the pre-sync commit. drift-sync COMMITS its edit before the
 * workflow runs this check, so without it the diff against HEAD is empty and
 * nothing can be derived from it. Defaults to HEAD (an uncommitted sync).
 */
export function parseCliArgs(argv: readonly string[]): { base: string } {
  if (argv.length === 0) return { base: "HEAD" };
  if (argv.length === 2 && argv[0] === "--base" && argv[1]) return { base: argv[1] };
  throw new SyncCheckConfigError(
    `usage: drift-sync-check.ts [--base <rev>] (got: ${argv.join(" ")})`,
  );
}

/** Run the check against real deps, printing a machine-readable `reason=` line. */
export function runCli(deps: CliDeps | (() => CliDeps)): number {
  let verdict: SyncCheckVerdict;
  try {
    const d = typeof deps === "function" ? deps() : deps;
    const skipReason = d.recollectSkipReason();
    verdict = evaluateSyncCheck(
      d,
      skipReason !== null ? { skipRecollect: true, skipRecollectReason: skipReason } : {},
    );
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
  process.exit(runCli(() => realCliDeps(parseCliArgs(process.argv.slice(2)).base)));
}
