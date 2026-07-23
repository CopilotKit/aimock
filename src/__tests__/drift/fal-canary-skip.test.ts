/**
 * Regression + guard tests for the live fal queue canary (#327 re-look).
 *
 * These drive the REAL `falQueueLifecycleCanary` (no mock of the canary itself —
 * only `globalThis.fetch` is stubbed to simulate fal's real responses) and the
 * REAL `triangulate`/`extractShape` the live leg uses, so they exercise the same
 * surface the live drift leg runs against funded fal.
 *
 * BUG 1 (#327): funded `flux/schnell` returns `status:"IN_PROGRESS"` on submit
 * IMMEDIATELY (never sits in `IN_QUEUE`). By cancel time the job may be running
 * or completed, so fal's cancel envelope is `{detail:"..."}` (no `status`
 * field). The old leg hard-asserted `typeof cancel.body.status === "string"` →
 * AssertionError → the collector could not map it → exit-5 quarantine.
 *   RED (pre-fix): `typeof cancel.body.status` is NOT "string" → old assert throws.
 *   GREEN (post-fix): the leg accepts any valid state + `{status}|{detail}`
 *   cancel body, and triangulate reports no critical drift → leg PASSES.
 *
 * BUG 2 (#327/#329): with FAL_KEY set but the account balance EXHAUSTED, fal
 * returns `403 {"detail":"User is locked..."}` at submit. The canary threw a
 * hard `InfraError` the collector could not parse → exit-5 quarantine.
 *   RED (pre-fix): canary rejects with `InfraError`.
 *   GREEN (post-fix): canary rejects with `FalCanarySkip` (the leg → `ctx.skip`).
 *
 * GUARD (must stay RED on real drift): a 2xx submit whose envelope shape
 * diverges from the mock is NOT an infra status and is NOT swallowed by the
 * skip — the canary returns normally and the shape comparison still reports
 * critical drift.
 */
import { describe, it, expect, afterEach } from "vitest";
import { falQueueLifecycleCanary, FalCanarySkip, InfraError } from "./providers.js";
import { extractShape, triangulate } from "./schema.js";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** A valid fal queue submit envelope (the contract the mock must match). */
const GOOD_SUBMIT_ENVELOPE = {
  request_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  status_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/aaaaaaaa/status",
  response_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/aaaaaaaa",
  cancel_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/aaaaaaaa/cancel",
  queue_position: 0,
};

describe("fal canary IN_PROGRESS lifecycle (#327)", () => {
  it("REGRESSION: IN_PROGRESS submit + {detail} cancel — canary handles it, no shape drift", async () => {
    // Simulate a fast funded model: submit returns IN_PROGRESS immediately (no
    // queue_position), status still IN_PROGRESS, and cancel of a
    // running/completed job returns a 400 `{detail}` body with NO `status`
    // field — the exact envelope that broke the original brittle assertion.
    const realSubmit = {
      status: "IN_PROGRESS",
      request_id: "req-inprogress-1",
      response_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-inprogress-1",
      status_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-inprogress-1/status",
      cancel_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-inprogress-1/cancel",
    };
    const realStatus = {
      status: "IN_PROGRESS",
      request_id: "req-inprogress-1",
      response_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-inprogress-1",
    };
    // fal's cancel-on-a-running/completed-job error envelope: `{detail}`, no status.
    const realCancelDetail = { detail: "Request req-inprogress-1 is already completed." };

    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") return new Response(JSON.stringify(realSubmit), { status: 200 });
      if (method === "PUT") return new Response(JSON.stringify(realCancelDetail), { status: 400 });
      return new Response(JSON.stringify(realStatus), { status: 200 });
    }) as typeof fetch;

    // The real canary handles IN_PROGRESS without throwing (submit -> status ->
    // cancel all fire regardless of state).
    const live = await falQueueLifecycleCanary("k", "fal-ai/flux/schnell", { prompt: "c" });

    // Submit is 2xx and reports IN_PROGRESS (NOT IN_QUEUE) — the #327 reality.
    expect(live.submit.status).toBe(200);
    expect(live.submit.body?.status).toBe("IN_PROGRESS");

    // The cancel body is the `{detail}` variant with NO `status` field. The OLD
    // leg asserted `typeof cancel.body.status === "string"` here → AssertionError
    // → quarantine. Documenting the RED: that field genuinely is not a string.
    expect(typeof live.cancel.body?.status).not.toBe("string");
    expect(live.cancel.body).not.toBeNull();
    expect(typeof live.cancel.body).toBe("object");

    // GREEN: the shape triangulation the live leg runs reports NO critical
    // drift for the IN_PROGRESS submit — the leg passes instead of throwing.
    const submitDiffs = triangulate(
      extractShape(GOOD_SUBMIT_ENVELOPE), // exemplar
      extractShape(live.submit.body), // real (IN_PROGRESS)
      extractShape(GOOD_SUBMIT_ENVELOPE), // mock
    );
    expect(submitDiffs.filter((d) => d.severity === "critical")).toEqual([]);
  });
});

describe("fal canary infra resilience (#329, folded in)", () => {
  it("REGRESSION: 403 user-locked / exhausted-balance at submit → FalCanarySkip, not InfraError", async () => {
    globalThis.fetch = (async () =>
      new Response(
        '{"detail":"User is locked. Reason: Exhausted balance. Add funds to continue."}',
        {
          status: 403,
        },
      )) as typeof fetch;

    const err = await falQueueLifecycleCanary("locked-key", "fal-ai/flux/schnell", {
      prompt: "canary",
    }).then(
      () => {
        throw new Error("expected canary to reject with a skip");
      },
      (e: unknown) => e,
    );

    // Honest skip — NOT a hard InfraError that the collector would quarantine.
    expect(err).toBeInstanceOf(FalCanarySkip);
    expect(err).not.toBeInstanceOf(InfraError);
    const skip = err as FalCanarySkip;
    expect(skip.status).toBe(403);
    expect(skip.message).toMatch(/user-locked/);
    expect(skip.message).toMatch(/skipping live canary/);
  });

  it("skips on other infra statuses (401 stale-key, 402 payment-required) too", async () => {
    // Non-retryable statuses so the assertion is instant (429/5xx go through the
    // same isFalInfraStatus gate but incur real retry backoff).
    for (const status of [401, 402]) {
      globalThis.fetch = (async () =>
        new Response("upstream unavailable", { status })) as typeof fetch;
      const err = await falQueueLifecycleCanary("k", "fal-ai/flux/schnell", { prompt: "c" }).then(
        () => {
          throw new Error("expected skip");
        },
        (e: unknown) => e,
      );
      expect(err, `status ${status}`).toBeInstanceOf(FalCanarySkip);
      expect((err as FalCanarySkip).status, `status ${status}`).toBe(status);
    }
  });

  it("GUARD: a 2xx submit whose envelope diverges from the mock is NOT skipped — real drift still surfaces", async () => {
    // fal returns 200 but the REAL envelope's queue_position is a string where
    // the mock has a number — a genuine, critical shape drift. This mirrors the
    // live leg's own triangulate(exemplar, real, mock) drift check exactly.
    const driftedRealSubmit = {
      request_id: "id-1",
      status_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/id-1/status",
      response_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/id-1",
      cancel_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/id-1/cancel",
      queue_position: "0", // TYPE DRIFT: string vs mock's number
    };
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST")
        return new Response(JSON.stringify(driftedRealSubmit), { status: 200 });
      if (method === "PUT")
        return new Response(JSON.stringify({ status: "CANCELLATION_REQUESTED" }), { status: 200 });
      return new Response(JSON.stringify({ status: "IN_QUEUE", request_id: "id-1" }), {
        status: 200,
      });
    }) as typeof fetch;

    // Must NOT throw a skip: 200 is not an infra status.
    const result = await falQueueLifecycleCanary("k", "fal-ai/flux/schnell", { prompt: "c" });
    expect(result.submit.status).toBe(200);

    // The exact triangulation the live leg runs still flags the drift as critical.
    const diffs = triangulate(
      extractShape(GOOD_SUBMIT_ENVELOPE), // exemplar
      extractShape(result.submit.body), // real (drifted)
      extractShape(GOOD_SUBMIT_ENVELOPE), // mock
    );
    const critical = diffs.filter((d) => d.severity === "critical");
    expect(critical.length).toBeGreaterThan(0);
  });
});
