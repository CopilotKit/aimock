import { describe, it, expect } from "vitest";
import { evaluateChaos, resolveChaosLatencyMs, applyChaosAction } from "../chaos.js";
import { createServer } from "../server.js";
import { Journal } from "../journal.js";
import type { Fixture } from "../types.js";
import type * as http from "node:http";

function textFixture(message: string): Fixture {
  return { match: { userMessage: message }, response: { content: message } };
}

function fakeRes(onStatus: (s: number, h?: Record<string, string>) => void): http.ServerResponse {
  return {
    writeHead: (s: number, h?: Record<string, string>) => onStatus(s, h),
    end: () => {},
    destroy: () => {},
  } as unknown as http.ServerResponse;
}

describe("chaos latency + ratelimit", () => {
  it("evaluates rateLimit at 1.0 and latency resolves deterministically", () => {
    expect(evaluateChaos(null, { rateLimitRate: 1.0 }, undefined)).toBe("rateLimit");
    expect(evaluateChaos(null, { rateLimitRate: 0 }, undefined)).toBe(null);
    expect(resolveChaosLatencyMs(null, { latencyMs: 150 }, undefined)).toBe(150);
    expect(resolveChaosLatencyMs(null, { latencyMs: 50000 }, undefined)).toBe(30000);
    expect(resolveChaosLatencyMs(null, undefined, undefined)).toBe(0);
    expect(
      resolveChaosLatencyMs(null, { latencyMs: 10 }, { "x-aimock-chaos-latency": "250" }),
    ).toBe(250);
    expect(evaluateChaos(null, { rateLimitRate: 0 }, { "x-aimock-chaos-ratelimit": "1" })).toBe(
      "rateLimit",
    );
    expect(
      resolveChaosLatencyMs(
        { match: {}, response: { content: "x" }, chaos: { latencyMs: 77 } },
        { latencyMs: 5 },
        undefined,
      ),
    ).toBe(77);
  });

  it("rateLimit action writes 429 with Retry-After and journals", () => {
    const journal = new Journal();
    let status = 0;
    const headers: Record<string, string> = {};
    const res = fakeRes((s, h) => {
      status = s;
      Object.assign(headers, h ?? {});
    });
    applyChaosAction(
      "rateLimit",
      res,
      null,
      journal,
      { method: "POST", path: "/v1/chat/completions", headers: {}, body: null },
      "internal",
    );
    expect(status).toBe(429);
    expect(headers["Retry-After"]).toBe("1");
    expect(journal.getAll()[0].response.status).toBe(429);
  });

  it("server 429s via header and control API round-trips new fields", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {});
    try {
      const rl = await fetch(`${instance.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-aimock-chaos-ratelimit": "1",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello-chaos" }],
        }),
      });
      expect(rl.status).toBe(429);
      expect(rl.headers.get("retry-after")).toBe("1");

      const set = await fetch(`${instance.url}/__aimock/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latencyMs: 120, rateLimitRate: 0 }),
      });
      expect(set.status).toBe(200);
      expect(((await set.json()) as { chaos: { latencyMs: number } }).chaos.latencyMs).toBe(120);

      const ok = await fetch(`${instance.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello-chaos" }],
        }),
      });
      expect(ok.status).toBe(200);

      const bad = await fetch(`${instance.url}/__aimock/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latencyMs: 99999 }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });

  it("async helper delays then applies terminal chaos", async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    let status = 0;
    const res = fakeRes((s) => {
      status = s;
    });
    const t0 = Date.now();
    const fired = await applyChaosAsync(
      res,
      null,
      { latencyMs: 60, rateLimitRate: 1.0 },
      {},
      "/v1/chat/completions",
      journal,
      { method: "POST", path: "/v1/chat/completions", headers: {}, body: null },
      "internal",
    );
    expect(fired).toBe(true);
    expect(status).toBe(429);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });
});
