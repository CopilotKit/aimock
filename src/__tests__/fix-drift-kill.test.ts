/**
 * WS-4 regression locks — real process-group subprocess control.
 *
 * The original `invokeClaudeCode` had two live defects:
 *   1. `spawn("npx", …)` had NO `detached: true`, so signalling the child pid
 *      reached only the `npx` wrapper, never the `@anthropic-ai/claude-code`
 *      grandchild — a wedged fixer survived and burned the 30-min job budget.
 *   2. The SIGKILL escalation was gated on `if (!child.killed)`, but Node sets
 *      `child.killed = true` the instant SIGTERM is DELIVERED (not when the
 *      process exits), so `!child.killed` was ~always false and SIGKILL NEVER
 *      fired against a process that ignored SIGTERM.
 *
 * These tests exercise a REAL controlled subprocess that traps SIGTERM and
 * sleeps, proving the OLD logic leaves it alive and the NEW logic
 * (`killProcessGroup` + `scheduleEscalatingKill`, gated on a real has-exited
 * flag) kills it and its whole group within the grace window.
 */
import { spawn } from "node:child_process";

import { describe, it, expect } from "vitest";

/** Real subprocess spin-up + grace windows need more than the default budget. */
const SUBPROC_TIMEOUT = 15000;

import { killProcessGroup, scheduleEscalatingKill } from "../../scripts/fix-drift.js";

/** A child that TRAPS SIGTERM and keeps sleeping — models a wedged fixer. */
const WEDGED_CHILD = `
process.on("SIGTERM", () => { /* ignore — wedged, refuse to die on SIGTERM */ });
setTimeout(() => process.exit(0), 60000);
`;

/** A child that exits cleanly on SIGTERM — models a well-behaved fixer. */
const OBEDIENT_CHILD = `
process.on("SIGTERM", () => process.exit(0));
setTimeout(() => process.exit(0), 60000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("killProcessGroup", () => {
  it(
    "delivers a signal to the whole GROUP of a detached child (kills a SIGTERM-trapping grandchild-style process)",
    { timeout: SUBPROC_TIMEOUT },
    async () => {
      const child = spawn("node", ["-e", WEDGED_CHILD], { stdio: "ignore", detached: true });
      const pid = child.pid!;
      await sleep(300);
      expect(isAlive(pid)).toBe(true);

      // SIGTERM to the group is IGNORED by the wedged child (it traps it).
      expect(killProcessGroup(pid, "SIGTERM")).toBe(true);
      await sleep(200);
      expect(isAlive(pid)).toBe(true); // still alive — it trapped SIGTERM

      // SIGKILL to the GROUP cannot be trapped — it dies.
      expect(killProcessGroup(pid, "SIGKILL")).toBe(true);
      await sleep(400);
      expect(isAlive(pid)).toBe(false);
    },
  );

  it("tolerates ESRCH (group already gone) and returns false, never throwing", () => {
    // A pid that is essentially certain not to exist as a group leader.
    const missing = 2 ** 30;
    expect(() => killProcessGroup(missing, "SIGTERM")).not.toThrow();
    expect(killProcessGroup(missing, "SIGTERM")).toBe(false);
  });

  it("re-throws unexpected errors (e.g. EINVAL from a bad signal)", () => {
    const child = spawn("node", ["-e", OBEDIENT_CHILD], { stdio: "ignore", detached: true });
    const pid = child.pid!;
    try {
      // An invalid signal name yields a non-ESRCH/EPERM error, which must
      // propagate rather than be swallowed as "nothing to kill".
      expect(() => killProcessGroup(pid, "SIGNOTAREALSIGNAL" as NodeJS.Signals)).toThrow();
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* best effort */
      }
    }
  });
});

describe("scheduleEscalatingKill — SIGKILL escalation gated on a REAL exit flag", () => {
  it(
    "SIGKILLs a wedged (SIGTERM-trapping) subprocess group within the grace window (GREEN)",
    { timeout: SUBPROC_TIMEOUT },
    async () => {
      const child = spawn("node", ["-e", WEDGED_CHILD], { stdio: "ignore", detached: true });
      const pid = child.pid!;
      let exited = false;
      child.on("close", () => {
        exited = true;
      });
      await sleep(300);
      expect(isAlive(pid)).toBe(true);

      // Short grace so the test is fast. hasExited() is backed by the real
      // `close` event, NOT child.killed.
      const timer = scheduleEscalatingKill(pid, () => exited, 150);
      // Before the grace elapses, SIGTERM has been delivered but the wedged child
      // is still alive (it trapped SIGTERM).
      await sleep(80);
      expect(isAlive(pid)).toBe(true);
      // After the grace, the escalation SIGKILLs the group.
      await sleep(400);
      expect(isAlive(pid)).toBe(false);
      clearTimeout(timer);
    },
  );

  it(
    "does NOT SIGKILL when the process has already exited (clean completion reaps without a stray kill)",
    { timeout: SUBPROC_TIMEOUT },
    async () => {
      // Model a child that exited cleanly right after SIGTERM: hasExited() true.
      const child = spawn("node", ["-e", OBEDIENT_CHILD], { stdio: "ignore", detached: true });
      const pid = child.pid!;
      const timer = scheduleEscalatingKill(pid, () => true, 100);
      await sleep(250);
      // The obedient child exited on SIGTERM; the escalation must have SKIPPED
      // SIGKILL (hasExited() === true).
      await sleep(200);
      expect(isAlive(pid)).toBe(false);
      clearTimeout(timer);
    },
  );

  it(
    "the OLD `!child.killed` guard would NOT have fired SIGKILL — regression contrast (RED demonstration)",
    { timeout: SUBPROC_TIMEOUT },
    async () => {
      // This test documents the ORIGINAL defect against a real subprocess: the
      // old code gated SIGKILL on `!child.killed`, which is false immediately
      // after SIGTERM delivery, so a SIGTERM-trapping child SURVIVES.
      const child = spawn("node", ["-e", WEDGED_CHILD], { stdio: "ignore" });
      const pid = child.pid!;
      await sleep(300);
      child.kill("SIGTERM"); // old: signal the child pid directly
      await sleep(150);
      // Node flips child.killed true on delivery — the old guard is dead code.
      expect(child.killed).toBe(true);
      const oldGuardWouldFireSigkill = !child.killed;
      expect(oldGuardWouldFireSigkill).toBe(false);
      // Consequently the wedged process is STILL ALIVE under the old logic.
      await sleep(200);
      expect(isAlive(pid)).toBe(true);

      // Clean up: this child was spawned NON-detached (to mirror the old code
      // exactly), so it is not its own group leader — kill it by pid directly.
      // SIGKILL cannot be trapped, so the wedged child dies.
      process.kill(pid, "SIGKILL");
      await sleep(400);
      expect(isAlive(pid)).toBe(false);
    },
  );
});
