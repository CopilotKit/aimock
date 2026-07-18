/**
 * WS-4 residual lock (slot2-F1) — a SYNCHRONOUS throw during the Promise
 * executor setup of `invokeClaudeCode` must NOT strand the already-armed 30-min
 * `killTimer`.
 *
 * The executor arms `killTimer` (a 30-minute setTimeout that would later
 * group-kill `child.pid`) BEFORE it wires the stdout/stderr handlers. If
 * `child.stdout` is null (a spawn edge case), `child.stdout.on(...)` throws a
 * TypeError synchronously inside the executor. Without the fix, that throw
 * rejects the Promise but leaves `killTimer` LIVE — a leaked 30-min timer that
 * could later SIGKILL a reused PID. The fix clears the timer before rejecting.
 *
 * We mock `spawn` to return a fake child with NULL streams, drive
 * `invokeClaudeCode`, and assert (a) the Promise REJECTS (not hangs) and (b) no
 * timer is left pending (fake timers report zero pending after the reject).
 */
import { EventEmitter } from "node:events";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";

import { invokeClaudeCode } from "../../scripts/fix-drift.js";

const mockedSpawn = vi.mocked(spawn);

/** A fake detached child whose stdout/stderr are NULL (the edge case). */
function makeNullStreamChild(pid = 4242): EventEmitter & {
  pid: number;
  stdout: null;
  stderr: null;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: null;
    stderr: null;
  };
  child.pid = pid;
  child.stdout = null;
  child.stderr = null;
  return child;
}

describe("invokeClaudeCode — executor-setup throw must not strand killTimer (WS-4/slot2-F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("REJECTS when the child has null streams (no stdout/stderr to attach handlers to)", async () => {
    mockedSpawn.mockReturnValue(makeNullStreamChild() as never);
    await expect(invokeClaudeCode("prompt")).rejects.toThrow(/no stdout\/stderr pipe/i);
  });

  it("clears the 30-min killTimer on the setup-throw path — NO timer is left pending", async () => {
    mockedSpawn.mockReturnValue(makeNullStreamChild() as never);

    // The executor arms killTimer, then throws attaching the null-stream
    // handler. The fix must clearTimeout(killTimer) before rejecting, so after
    // the reject settles there must be ZERO pending fake timers. Without the
    // fix, the 30-min killTimer would still be pending here.
    await expect(invokeClaudeCode("prompt")).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
