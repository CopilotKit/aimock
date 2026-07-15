import { describe, it, expect } from "vitest";

import { EXIT_QUARANTINE, retryUntilStable } from "../../scripts/drift-retry.js";
import type { RetryAttempt, RetryOptions, RetryResult } from "../../scripts/drift-retry.js";

// ---------------------------------------------------------------------------
// retryUntilStable
//
// Wraps the drift collector with a "retry before alert" policy:
//   - collector exit 0 → no critical drift → SUCCESS (no further runs)
//   - collector exit 2 → critical drift → retry (up to maxAttempts) with backoff
//   - collector exit 1 (or other non-0/2) → script/infra crash → propagate now
//
// A run is only treated as a real failure (alert) if EVERY attempt reports
// critical drift. Any single clean attempt → transient → SUCCESS, no alert.
// ---------------------------------------------------------------------------

/**
 * Build a fake collector runner that returns the given exit codes in sequence
 * and records how many times it was invoked.
 */
function fakeRunner(exitCodes: number[]): { run: () => number; calls: () => number } {
  let i = 0;
  let calls = 0;
  return {
    run: () => {
      calls++;
      const code = exitCodes[Math.min(i, exitCodes.length - 1)];
      i++;
      return code;
    },
    calls: () => calls,
  };
}

function makeOptions(overrides: Partial<RetryOptions> = {}): RetryOptions {
  return {
    maxAttempts: 3,
    backoffMs: 1000,
    runCollector: () => 0,
    sleep: () => {},
    log: () => {},
    ...overrides,
  };
}

describe("retryUntilStable", () => {
  it("returns success after a single clean run (exit 0), no retries", () => {
    const runner = fakeRunner([0]);
    const opts = makeOptions({ runCollector: runner.run });
    const result: RetryResult = retryUntilStable(opts);

    expect(result.exitCode).toBe(0);
    expect(result.transient).toBe(false);
    expect(runner.calls()).toBe(1);
  });

  it("treats critical-then-clean as transient SUCCESS (no alert)", () => {
    const runner = fakeRunner([2, 0]);
    const opts = makeOptions({ runCollector: runner.run });
    const result = retryUntilStable(opts);

    expect(result.exitCode).toBe(0);
    expect(result.transient).toBe(true);
    expect(result.attempts.length).toBe(2);
    // Stops as soon as a clean run is seen — does not exhaust maxAttempts
    expect(runner.calls()).toBe(2);
  });

  it("alerts (exit 2) only when EVERY attempt shows critical drift", () => {
    const runner = fakeRunner([2, 2, 2]);
    const opts = makeOptions({ runCollector: runner.run, maxAttempts: 3 });
    const result = retryUntilStable(opts);

    expect(result.exitCode).toBe(2);
    expect(result.transient).toBe(false);
    expect(result.attempts.length).toBe(3);
    expect(runner.calls()).toBe(3);
    // Persistent drift is confirmed across all attempts
    expect(result.criticalRuns).toBe(3);
  });

  it("propagates a collector crash (exit 1) immediately without retrying", () => {
    const runner = fakeRunner([1, 0, 0]);
    const opts = makeOptions({ runCollector: runner.run });
    const result = retryUntilStable(opts);

    expect(result.exitCode).toBe(1);
    expect(result.transient).toBe(false);
    expect(runner.calls()).toBe(1);
  });

  it("propagates an unexpected non-0/2 exit code immediately", () => {
    const runner = fakeRunner([7, 0]);
    const opts = makeOptions({ runCollector: runner.run });
    const result = retryUntilStable(opts);

    expect(result.exitCode).toBe(7);
    expect(runner.calls()).toBe(1);
  });

  it("backs off between critical attempts but not before the first or after the last", () => {
    const sleeps: number[] = [];
    const runner = fakeRunner([2, 2, 2]);
    const opts = makeOptions({
      runCollector: runner.run,
      maxAttempts: 3,
      backoffMs: 1234,
      sleep: (ms: number) => {
        sleeps.push(ms);
      },
    });
    retryUntilStable(opts);

    // 3 attempts → 2 inter-attempt sleeps (no sleep before #1, none after the last)
    expect(sleeps).toEqual([1234, 1234]);
  });

  it("does not sleep when the first run is clean", () => {
    const sleeps: number[] = [];
    const runner = fakeRunner([0]);
    const opts = makeOptions({
      runCollector: runner.run,
      sleep: (ms: number) => {
        sleeps.push(ms);
      },
    });
    retryUntilStable(opts);

    expect(sleeps).toEqual([]);
  });

  it("records each attempt's exit code in order", () => {
    const runner = fakeRunner([2, 2, 0]);
    const opts = makeOptions({ runCollector: runner.run });
    const result = retryUntilStable(opts);

    expect(result.attempts.map((a: RetryAttempt) => a.exitCode)).toEqual([2, 2, 0]);
  });

  it("treats exit 5 (quarantine) as a distinct terminal outcome — no retry, quarantine:true", () => {
    // exit 5 = collector quarantined unparseable output; must propagate immediately
    // without retrying and mark the result with quarantine:true.
    const runner = fakeRunner([EXIT_QUARANTINE, 0, 0]);
    const opts = makeOptions({ runCollector: runner.run });
    const result: RetryResult = retryUntilStable(opts);

    // Propagated as exit 5, not swallowed into the crash branch
    expect(result.exitCode).toBe(EXIT_QUARANTINE);
    // Quarantine flag set
    expect(result.quarantine).toBe(true);
    // No retry — only one attempt
    expect(runner.calls()).toBe(1);
    // Not treated as a transient drift event
    expect(result.transient).toBe(false);
  });
});
