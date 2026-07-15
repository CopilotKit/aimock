/// <reference types="node" />

/**
 * Drift Retry Wrapper — "retry before alert"
 *
 * Wraps `drift-report-collector.ts` so a TRANSIENT real-API hiccup no longer
 * pages the team. Real LLM provider APIs occasionally fail a single streaming
 * call mid-flight (e.g. emit `error` + `response.failed` with no terminal
 * `response.completed`). That looks identical to a "critical diff" to the
 * collector — but it is NOT a format change, and clears on a re-run a moment
 * later. Alerting on it produces false alarms.
 *
 * Policy (matches the owner directive — "if it ran the collector/detector a
 * second time and it passed, it should not have emitted the warning"):
 *
 *   - collector exit 0 → no critical drift → SUCCESS, no further runs (fast
 *     common green path).
 *   - collector exit 2 → critical drift → retry up to `maxAttempts` total runs
 *     with a short backoff between attempts. As soon as ANY attempt returns 0
 *     critical → transient → SUCCESS, no alert.
 *   - Only when EVERY attempt (all `maxAttempts`) shows critical drift do we
 *     declare a real failure (exit 2) → the `notify` job alerts.
 *   - collector exit 1 (or any other non-0/2 code) → script/infra crash, NOT
 *     drift → propagate immediately without retrying (the collector already
 *     distinguishes infra errors from drift internally; a crash here is a real
 *     break worth surfacing, and retrying won't help).
 *
 * Retries hit real provider APIs, so `maxAttempts` is kept small.
 *
 * The retry decision is implemented as a pure function (`retryUntilStable`)
 * with injected collector-runner / sleep / log, so it is unit-testable without
 * spawning subprocesses or sleeping. `main()` wires the real collector
 * subprocess and emits a `drift_runs` marker via GITHUB_OUTPUT recording how
 * many attempts confirmed the drift (so the alert can say "confirmed across N
 * runs").
 *
 * CLI usage (in CI):
 *   npx tsx scripts/drift-retry.ts [-- <args forwarded to collector>]
 *
 * Exit codes mirror the collector's contract so downstream YAML logic is
 * unchanged: 0 = clean (or transient), 2 = persistent critical drift, other =
 * collector crash.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Collector exit-code contract (see drift-report-collector.ts header).
export const EXIT_CLEAN = 0;
export const EXIT_CRITICAL_DRIFT = 2;
export const EXIT_QUARANTINE = 5;

// Defaults: keep the fleet of real-API calls small. 3 total attempts with a
// ~45s backoff mirrors the observed transient window (the Fix Drift workflow
// re-ran the collector ~1 minute later and saw 0 critical).
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 45_000;

export interface RetryAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** The collector process exit code for this attempt. */
  exitCode: number;
}

export interface RetryOptions {
  /** Total number of collector runs to attempt before giving up. */
  maxAttempts: number;
  /** Milliseconds to wait between attempts after a critical run. */
  backoffMs: number;
  /** Runs the collector once and returns its exit code. */
  runCollector: () => number;
  /** Sleeps synchronously for the given milliseconds (injected for tests). */
  sleep: (ms: number) => void;
  /** Logger (injected so tests stay quiet). */
  log: (msg: string) => void;
}

export interface RetryResult {
  /** Final exit code to propagate (0 = clean/transient, 2 = persistent, 5 = quarantine, other = crash). */
  exitCode: number;
  /** True when at least one critical run was seen but a later run cleared it. */
  transient: boolean;
  /** Number of attempts that reported critical drift. */
  criticalRuns: number;
  /** Per-attempt record, in order. */
  attempts: RetryAttempt[];
  /** True when the collector exited with EXIT_QUARANTINE (5): unparseable output quarantined. */
  quarantine?: boolean;
}

/**
 * Core "retry before alert" decision loop. Pure given its injected
 * dependencies — no subprocesses, no real sleeping.
 */
export function retryUntilStable(opts: RetryOptions): RetryResult {
  const attempts: RetryAttempt[] = [];
  let criticalRuns = 0;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (attempt > 1) {
      opts.log(
        `Critical drift on attempt ${attempt - 1}; re-running collector ` +
          `(attempt ${attempt}/${opts.maxAttempts}) after ${opts.backoffMs}ms backoff ` +
          `to confirm it is not a transient API hiccup...`,
      );
      opts.sleep(opts.backoffMs);
    }

    const exitCode = opts.runCollector();
    attempts.push({ attempt, exitCode });

    if (exitCode === EXIT_CLEAN) {
      const transient = criticalRuns > 0;
      if (transient) {
        opts.log(
          `Attempt ${attempt} returned 0 critical — earlier critical drift was ` +
            `transient (cleared on retry). No alert.`,
        );
      }
      return { exitCode: EXIT_CLEAN, transient, criticalRuns, attempts };
    }

    if (exitCode === EXIT_CRITICAL_DRIFT) {
      criticalRuns++;
      continue;
    }

    if (exitCode === EXIT_QUARANTINE) {
      // Quarantine is a distinct terminal outcome: the collector encountered
      // output it could not parse/classify. No retry — propagate immediately.
      opts.log(`Collector exited ${exitCode} (quarantine) — propagating without retry.`);
      return {
        exitCode: EXIT_QUARANTINE,
        transient: false,
        criticalRuns,
        attempts,
        quarantine: true,
      };
    }

    // Any other code = collector crash / infra error. Do not retry — surface it.
    opts.log(`Collector exited ${exitCode} (not drift) — propagating without retry.`);
    return { exitCode, transient: false, criticalRuns, attempts };
  }

  // Exhausted all attempts and every one showed critical drift → persistent.
  opts.log(
    `Critical drift persisted across all ${opts.maxAttempts} attempts — treating as ` +
      `real drift and alerting.`,
  );
  return {
    exitCode: EXIT_CRITICAL_DRIFT,
    transient: false,
    criticalRuns,
    attempts,
  };
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

/** Run the collector subprocess once, inheriting stdio, returning its exit code. */
function runCollectorSubprocess(forwardArgs: string[]): number {
  const result = spawnSync("npx", ["tsx", "scripts/drift-report-collector.ts", ...forwardArgs], {
    stdio: "inherit",
    encoding: "utf-8",
  });
  if (result.error) {
    // Failed to even spawn — treat as a crash (non-0/2) so it is not retried.
    console.error(`Failed to run collector: ${result.error.message}`);
    return 1;
  }
  // A signal kill has null status; map to 1 (crash).
  return result.status ?? 1;
}

function writeGithubOutput(name: string, value: string): void {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  appendFileSync(outPath, `${name}=${value}\n`, "utf-8");
}

function main(): void {
  // Forward anything after a literal `--` to the collector (e.g. --out).
  const argv = process.argv.slice(2);
  const sepIndex = argv.indexOf("--");
  const forwardArgs = sepIndex !== -1 ? argv.slice(sepIndex + 1) : [];

  const result = retryUntilStable({
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoffMs: DEFAULT_BACKOFF_MS,
    runCollector: () => runCollectorSubprocess(forwardArgs),
    sleep: (ms: number) => {
      // Synchronous busy-free sleep via Atomics so the CLI can stay sync.
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, ms);
    },
    log: (msg: string) => console.log(`[drift-retry] ${msg}`),
  });

  // Expose how many runs confirmed the drift so the alert can note
  // "confirmed across N runs". Only meaningful when we actually alert.
  if (result.exitCode === EXIT_CRITICAL_DRIFT) {
    writeGithubOutput("drift_runs", String(result.criticalRuns));
  }

  process.exit(result.exitCode);
}

// Only run as a CLI — guard so importing this module (e.g. from tests) does
// not execute main().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
