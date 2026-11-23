import { describe, it, expect, vi } from "vitest";
import { applyChaos, applyChaosAsync } from "../index.js";
import { Journal } from "../journal.js";
import type * as http from "node:http";

// ---------------------------------------------------------------------------
// The public barrel still exports a SYNCHRONOUS `applyChaos`, which cannot await
// and therefore silently skips the configured chaos latency — while every module
// inside src/ is now forbidden from calling it (chaos-async-call-sites.test.ts).
// A library consumer embedding aimock would have hit that contradiction with no
// signal at all, so the export is deprecated: it keeps working (it has shipped
// since v1.10.0) but names the gap once per process.
//
// This test pins BOTH halves — the warning fires exactly once, and the fault
// behaviour is otherwise byte-for-byte what it always was.
// ---------------------------------------------------------------------------

function fakeRes(onStatus: (s: number, h?: Record<string, string>) => void): http.ServerResponse {
  return {
    writeHead: (s: number, h?: Record<string, string>) => onStatus(s, h),
    end: () => {},
    destroy: () => {},
  } as unknown as http.ServerResponse;
}

const CTX = { method: "POST", path: "/v1/chat/completions", headers: {}, body: null } as const;

describe("deprecated public sync applyChaos export", () => {
  it("warns once about the skipped latency, stays silent after, and behaves unchanged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const journal = new Journal();
      let status = 0;
      const headers: Record<string, string> = {};
      const res = fakeRes((s, h) => {
        status = s;
        Object.assign(headers, h ?? {});
      });

      // A latency-only config: nothing terminal rolls, so the only effect a
      // latency-honouring implementation could have is a delay.
      const t0 = Date.now();
      const first = applyChaos(
        res,
        null,
        { latencyMs: 400 },
        {},
        undefined,
        journal,
        CTX,
        "internal",
      );
      const second = applyChaos(
        res,
        null,
        { latencyMs: 400 },
        {},
        undefined,
        journal,
        CTX,
        "internal",
      );
      const third = applyChaos(
        res,
        null,
        { latencyMs: 400 },
        {},
        undefined,
        journal,
        CTX,
        "internal",
      );
      const elapsed = Date.now() - t0;

      // Behaviour unchanged: no action, no delay, nothing journalled.
      expect([first, second, third]).toEqual([false, false, false]);
      expect(elapsed).toBeLessThan(400);
      expect(journal.getAll()).toHaveLength(0);

      // Warned exactly once, and the message names the latency gap and the fix.
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("applyChaos() is deprecated");
      expect(message).toContain("latency");
      expect(message).toContain("applyChaosAsync");

      // Faults still fire identically through the deprecated export.
      expect(
        applyChaos(res, null, { rateLimitRate: 1 }, {}, undefined, journal, CTX, "internal"),
      ).toBe(true);
      expect(status).toBe(429);
      expect(headers["Retry-After"]).toBe("1");
      expect(warn).toHaveBeenCalledTimes(1);

      // And the replacement really is the one that honours latency.
      const asyncStart = Date.now();
      await applyChaosAsync(res, null, { latencyMs: 120 }, {}, undefined, journal, CTX, "internal");
      expect(Date.now() - asyncStart).toBeGreaterThanOrEqual(100);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
