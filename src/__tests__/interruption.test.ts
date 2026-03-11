import { describe, it, expect, vi, afterEach } from "vitest";
import { createInterruptionSignal } from "../interruption.js";
import type { Fixture } from "../types.js";

function makeFixture(overrides?: Partial<Fixture>): Fixture {
  return {
    match: { userMessage: "test" },
    response: { content: "hello" },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createInterruptionSignal", () => {
  it("returns null when no interruption fields are set", () => {
    const result = createInterruptionSignal(makeFixture());
    expect(result).toBeNull();
  });

  it("returns null when both fields are undefined", () => {
    const result = createInterruptionSignal(
      makeFixture({ truncateAfterChunks: undefined, disconnectAfterMs: undefined }),
    );
    expect(result).toBeNull();
  });

  it("truncateAfterChunks: aborts after N ticks", () => {
    const ctrl = createInterruptionSignal(makeFixture({ truncateAfterChunks: 3 }));
    expect(ctrl).not.toBeNull();
    expect(ctrl!.signal.aborted).toBe(false);

    ctrl!.tick();
    expect(ctrl!.signal.aborted).toBe(false);
    ctrl!.tick();
    expect(ctrl!.signal.aborted).toBe(false);
    ctrl!.tick();
    expect(ctrl!.signal.aborted).toBe(true);
    expect(ctrl!.reason()).toBe("truncateAfterChunks");

    ctrl!.cleanup();
  });

  it("truncateAfterChunks: extra ticks after abort are no-ops", () => {
    const ctrl = createInterruptionSignal(makeFixture({ truncateAfterChunks: 1 }));
    ctrl!.tick();
    expect(ctrl!.signal.aborted).toBe(true);
    // Should not throw
    ctrl!.tick();
    ctrl!.tick();
    expect(ctrl!.reason()).toBe("truncateAfterChunks");
    ctrl!.cleanup();
  });

  it("disconnectAfterMs: aborts after timeout", async () => {
    vi.useFakeTimers();
    const ctrl = createInterruptionSignal(makeFixture({ disconnectAfterMs: 100 }));
    expect(ctrl).not.toBeNull();
    expect(ctrl!.signal.aborted).toBe(false);

    vi.advanceTimersByTime(99);
    expect(ctrl!.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(ctrl!.signal.aborted).toBe(true);
    expect(ctrl!.reason()).toBe("disconnectAfterMs");

    ctrl!.cleanup();
  });

  it("both set: truncateAfterChunks fires first wins", () => {
    vi.useFakeTimers();
    const ctrl = createInterruptionSignal(
      makeFixture({ truncateAfterChunks: 2, disconnectAfterMs: 10000 }),
    );

    ctrl!.tick();
    ctrl!.tick();
    expect(ctrl!.signal.aborted).toBe(true);
    expect(ctrl!.reason()).toBe("truncateAfterChunks");

    ctrl!.cleanup();
  });

  it("both set: disconnectAfterMs fires first wins", () => {
    vi.useFakeTimers();
    const ctrl = createInterruptionSignal(
      makeFixture({ truncateAfterChunks: 100, disconnectAfterMs: 50 }),
    );

    ctrl!.tick(); // 1 of 100
    expect(ctrl!.signal.aborted).toBe(false);

    vi.advanceTimersByTime(50);
    expect(ctrl!.signal.aborted).toBe(true);
    expect(ctrl!.reason()).toBe("disconnectAfterMs");

    ctrl!.cleanup();
  });

  it("cleanup clears the timer", () => {
    vi.useFakeTimers();
    const ctrl = createInterruptionSignal(makeFixture({ disconnectAfterMs: 100 }));

    ctrl!.cleanup();

    vi.advanceTimersByTime(200);
    expect(ctrl!.signal.aborted).toBe(false);
    expect(ctrl!.reason()).toBeUndefined();
  });

  it("reason returns undefined before abort", () => {
    const ctrl = createInterruptionSignal(makeFixture({ truncateAfterChunks: 5 }));
    expect(ctrl!.reason()).toBeUndefined();
    ctrl!.cleanup();
  });

  it("truncateAfterChunks: 0 aborts immediately on first tick", () => {
    const ctrl = createInterruptionSignal(makeFixture({ truncateAfterChunks: 0 }));
    expect(ctrl).not.toBeNull();
    expect(ctrl!.signal.aborted).toBe(false);

    ctrl!.tick();
    expect(ctrl!.signal.aborted).toBe(true);
    expect(ctrl!.reason()).toBe("truncateAfterChunks");

    ctrl!.cleanup();
  });

  it("disconnectAfterMs: 0 aborts promptly", async () => {
    const ctrl = createInterruptionSignal(makeFixture({ disconnectAfterMs: 0 }));
    expect(ctrl).not.toBeNull();

    await new Promise((r) => setTimeout(r, 10));
    expect(ctrl!.signal.aborted).toBe(true);
    expect(ctrl!.reason()).toBe("disconnectAfterMs");

    ctrl!.cleanup();
  });
});
