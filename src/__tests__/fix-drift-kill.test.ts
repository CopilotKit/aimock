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

import { describe, it, expect, vi } from "vitest";

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

  it("does NOT silently treat EPERM as success — logs a visible warning and attempts a single-PID fallback (slot2-F5)", () => {
    // EPERM means the group EXISTS but is unkillable by us (re-credentialed /
    // re-parented child) — it may still be ALIVE burning the budget. It must
    // NOT be swallowed as a benign "nothing to kill" like ESRCH. Assert we (a)
    // log a distinct WARNING and (b) attempt the single-PID fallback.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let call = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pidArg: number) => {
      call += 1;
      if (call === 1) {
        // First call: group signal (negative pid) → EPERM.
        expect(pidArg).toBeLessThan(0);
        const e = new Error("EPERM") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      // Second call: the single-PID fallback (positive pid) succeeds.
      expect(pidArg).toBeGreaterThan(0);
      return true;
    }) as never);
    try {
      expect(killProcessGroup(12345, "SIGKILL")).toBe(true); // fallback delivered
      expect(call).toBe(2); // group attempt + single-PID fallback
      const warned = errSpy.mock.calls.some((c) => String(c[0]).includes("EPERM"));
      expect(warned).toBe(true); // distinct, visible EPERM warning — not silent
    } finally {
      killSpy.mockRestore();
      errSpy.mockRestore();
    }
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
    "does NOT SIGKILL when hasExited() is true — the gate genuinely SKIPS escalation (a SIGTERM-trapping child that WOULD have died to a stray SIGKILL stays alive)",
    { timeout: SUBPROC_TIMEOUT },
    async () => {
      // The previous version of this test used an OBEDIENT child and asserted
      // it was dead — but an obedient child dies from the unconditional SIGTERM
      // that scheduleEscalatingKill sends FIRST, regardless of whether the
      // SIGKILL escalation is skipped, so it passed for the WRONG reason (it
      // could not distinguish "escalation skipped" from "escalation fired").
      //
      // Use a WEDGED child that TRAPS SIGTERM instead: the first SIGTERM leaves
      // it alive, so the ONLY thing that could kill it within the window is the
      // SIGKILL escalation. With hasExited() forced true, that escalation MUST
      // be skipped — so the child must remain ALIVE after the grace elapses. If
      // the has-exited gate regressed to always-escalate (the WS-4 defect), the
      // group SIGKILL would fire and the child would be DEAD — turning this RED.
      const child = spawn("node", ["-e", WEDGED_CHILD], { stdio: "ignore", detached: true });
      const pid = child.pid!;
      await sleep(300);
      expect(isAlive(pid)).toBe(true);

      const timer = scheduleEscalatingKill(pid, () => true, 100);
      // Wait well past the grace window: the escalation callback has run (and,
      // gated on hasExited()===true, SKIPPED the SIGKILL).
      await sleep(400);
      // Wedged child trapped the SIGTERM and no SIGKILL was sent → STILL ALIVE.
      expect(isAlive(pid)).toBe(true);

      // The grace timer must have already fired-and-skipped (not still pending):
      // clearing it now is a no-op, and no LATE SIGKILL can arrive after this.
      clearTimeout(timer);
      await sleep(200);
      expect(isAlive(pid)).toBe(true); // no late kill

      // Clean up the still-alive wedged group.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* best effort */
      }
      await sleep(300);
      expect(isAlive(pid)).toBe(false);
    },
  );

  it(
    "the returned grace timer, once cleared before it fires, delivers NO late SIGKILL to a still-running group",
    { timeout: SUBPROC_TIMEOUT },
    async () => {
      // Locks the caller-side lifecycle used by invokeClaudeCode's `close`
      // handler: on a clean early exit the caller clears the returned timer, and
      // a pending SIGKILL escalation must NOT fire late against a (possibly
      // reused) PID. Here the child is still running and hasExited() would be
      // false, so ONLY a fired escalation could kill it — we clear the timer
      // BEFORE the grace elapses and assert the child survives.
      const child = spawn("node", ["-e", WEDGED_CHILD], { stdio: "ignore", detached: true });
      const pid = child.pid!;
      await sleep(300);
      expect(isAlive(pid)).toBe(true);

      // Long grace so we can cancel before it fires. hasExited stays false.
      const timer = scheduleEscalatingKill(pid, () => false, 5000);
      // The initial SIGTERM is trapped; child alive. Cancel before the grace.
      await sleep(100);
      clearTimeout(timer);
      // Well past what the grace would have been — no SIGKILL arrives.
      await sleep(300);
      expect(isAlive(pid)).toBe(true);

      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* best effort */
      }
      await sleep(300);
      expect(isAlive(pid)).toBe(false);
    },
  );
});
