import { describe, it, expect, vi } from "vitest";
import { createServer } from "../server.js";

/**
 * Every `/fal/*` handler path must (a) await the configured deterministic
 * latency and (b) roll the chaos dice EXACTLY ONCE.
 *
 * Both invariants were broken before: the two server-side fal gates rolled
 * without awaiting the latency at all (the fal paths returned in ~1ms with a
 * 900ms delay configured), and the `x-fal-target-host` gate rolled a SECOND
 * time on every request whose outcome was `"passthrough"` — a configured
 * dropRate of 0.5 produced an effective 0.75.
 */

const QUEUE = "queue.fal.run";
const SYNC = "fal.run";
/** A host `classifyRoute` does not recognise — forces `handleFal` to passthrough. */
const PASSTHROUGH_HOST = "gateway.fal.ai";

const JSON_CT = "application/json";
const BODY = JSON.stringify({ prompt: "hello" });

interface FalCase {
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

/** Every distinct fal dispatch shape: general handler, both gates, passthrough, legacy. */
const FAL_CASES: FalCase[] = [
  {
    name: "general handler: queue-submit",
    method: "POST",
    path: "/fal/queue/submit/fal-ai/flux",
    headers: { "content-type": JSON_CT, "x-fal-target-host": QUEUE },
    body: BODY,
  },
  {
    name: "general handler: sync-run",
    method: "POST",
    path: "/fal/run/fal-ai/flux",
    headers: { "content-type": JSON_CT, "x-fal-target-host": SYNC },
    body: BODY,
  },
  {
    name: "general handler: queue-status",
    method: "GET",
    path: "/fal/fal-ai/flux/requests/missing-id/status",
    headers: { "x-fal-target-host": QUEUE },
  },
  {
    name: "general handler: queue-result",
    method: "GET",
    path: "/fal/fal-ai/flux/requests/missing-id",
    headers: { "x-fal-target-host": QUEUE },
  },
  {
    name: "general handler: queue-cancel",
    method: "PUT",
    path: "/fal/fal-ai/flux/requests/missing-id/cancel",
    headers: { "content-type": JSON_CT, "x-fal-target-host": QUEUE },
    body: BODY,
  },
  {
    name: "legacy gate: queue status",
    method: "GET",
    path: "/fal/queue/requests/missing-id/status",
    headers: {},
  },
  {
    name: "legacy gate: queue result",
    method: "GET",
    path: "/fal/queue/requests/missing-id",
    headers: {},
  },
  {
    name: "legacy gate: queue status via passthrough",
    method: "GET",
    path: "/fal/queue/requests/missing-id/status",
    headers: { "x-fal-target-host": PASSTHROUGH_HOST },
  },
  {
    name: "passthrough -> legacy submit",
    method: "POST",
    path: "/fal/queue/submit/fal-ai/flux",
    headers: { "content-type": JSON_CT, "x-fal-target-host": PASSTHROUGH_HOST },
    body: BODY,
  },
  {
    name: "passthrough -> legacy run",
    method: "POST",
    path: "/fal/run/fal-ai/flux",
    headers: { "content-type": JSON_CT, "x-fal-target-host": PASSTHROUGH_HOST },
    body: BODY,
  },
  {
    name: "legacy submit",
    method: "POST",
    path: "/fal/queue/submit/fal-ai/flux",
    headers: { "content-type": JSON_CT },
    body: BODY,
  },
  {
    name: "legacy run",
    method: "POST",
    path: "/fal/run/fal-ai/flux",
    headers: { "content-type": JSON_CT },
    body: BODY,
  },
];

function request(url: string, c: FalCase, extraHeaders: Record<string, string> = {}) {
  return fetch(url + c.path, {
    method: c.method,
    headers: { ...c.headers, ...extraHeaders },
    body: c.body,
  });
}

describe("fal chaos gates", () => {
  const LATENCY_MS = 250;

  it("awaits the configured latency exactly once on every fal handler path", async () => {
    const instance = await createServer([], { chaos: { latencyMs: LATENCY_MS } });
    try {
      // Issued concurrently: the delay is a timer, not a lock, so this keeps
      // the test at ~one delay of wall-clock instead of one per case.
      const timings = await Promise.all(
        FAL_CASES.map(async (c) => {
          const t0 = performance.now();
          const res = await request(instance.url, c);
          await res.text();
          return { name: c.name, ms: performance.now() - t0 };
        }),
      );
      for (const { name, ms } of timings) {
        // Lower bound: the delay was awaited at all (was ~1ms).
        expect(ms, `${name} did not await the configured latency`).toBeGreaterThanOrEqual(
          LATENCY_MS - 15,
        );
        // Upper bound: it was awaited ONCE, not twice (a double-delay is 500ms).
        expect(ms, `${name} awaited the configured latency more than once`).toBeLessThan(
          LATENCY_MS * 2 - 40,
        );
      }
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });

  it("rolls the chaos dice exactly once per request on every fal handler path", async () => {
    // A single configured rate means `evaluateChaos` consumes exactly one
    // `Math.random()` per roll, so the call count IS the roll count. 0.99 never
    // trips a 0.5 dropRate, so no roll short-circuits the request and a second
    // roll, if one exists, is always reached.
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const instance = await createServer([], { chaos: { dropRate: 0.5 } });
    try {
      for (const c of FAL_CASES) {
        spy.mockClear();
        const res = await request(instance.url, c);
        await res.text();
        expect(
          spy.mock.calls.length,
          `${c.name} rolled chaos ${spy.mock.calls.length} time(s)`,
        ).toBe(1);
      }
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });

  it('journals un-fixtured fal chaos as source "internal", never "fixture"', async () => {
    const instance = await createServer([], { chaos: { dropRate: 1 } });
    try {
      const gated = FAL_CASES.filter(
        (c) => c.name.startsWith("general handler") || c.name === "legacy gate: queue status",
      );
      for (const c of gated) {
        const res = await request(instance.url, c);
        expect(res.status, c.name).toBe(500);
        await res.text();
      }
      const entries = instance.journal
        .getAll()
        .filter((e) => e.response.chaosAction === "drop" && e.path.startsWith("/fal"));
      expect(entries.length).toBe(gated.length);
      for (const e of entries) {
        expect(e.response.fixture, `${e.path} journalled a fixture`).toBeNull();
        expect(e.response.source, `${e.path} mislabelled its chaos source`).toBe("internal");
      }
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });

  it("keeps fal chaos scoped to the testId that configured it", async () => {
    const instance = await createServer([], {});
    try {
      const set = await fetch(`${instance.url}/__aimock/chaos`, {
        method: "POST",
        headers: { "content-type": JSON_CT, "x-test-id": "t1" },
        body: JSON.stringify({ dropRate: 1 }),
      });
      expect(set.status).toBe(200);

      for (const c of FAL_CASES) {
        const tagged = await request(instance.url, c, { "x-test-id": "t1" });
        await tagged.text();
        expect(tagged.status, `${c.name} (t1) escaped its own chaos`).toBe(500);

        const other = await request(instance.url, c, { "x-test-id": "t2" });
        await other.text();
        expect(other.status, `${c.name} (t2) leaked another test's chaos`).not.toBe(500);
      }
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });
});
