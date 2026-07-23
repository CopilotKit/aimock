/**
 * Regression + guard tests for the live fal queue canary's infra resilience.
 *
 * BUG (main baseline regression, #327): with FAL_KEY set but the fal account
 * balance EXHAUSTED, fal returns `403 {"detail":"User is locked. Reason:
 * Exhausted balance..."}` at submit. The canary threw a hard `InfraError`, which
 * the drift collector could not parse into a finding → exit-5 quarantine → the
 * "Base drift report" step (run against main) FAILED on every PR and the
 * scheduled run.
 *
 * FIX: infra-class statuses (401/402/403/429/5xx) become an honest
 * `FalCanarySkip` the live leg catches → `ctx.skip()`, NEVER a hard InfraError.
 *
 * RED (pre-fix): canary rejects with `InfraError` (…403…Exhausted balance).
 * GREEN (post-fix): canary rejects with `FalCanarySkip` carrying a clear reason.
 *
 * GUARD (must stay RED on real drift): a 2xx submit whose envelope shape
 * diverges from the mock is NOT an infra status, so it is NOT swallowed by the
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

describe("fal canary infra resilience", () => {
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
