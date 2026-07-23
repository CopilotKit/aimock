/**
 * fal.ai queue-lifecycle contract: expected envelope shapes, the set of valid
 * lifecycle states, and the STATE-AGNOSTIC assertion the live canary leg runs.
 *
 * Extracted from `fal-queue.drift.ts` so the live-leg assertion sequence is a
 * pure, unit-testable function (`assertLiveFalQueueEnvelopes`) — driven with
 * stubbed lifecycle states by `fal-queue-contract.test.ts` — instead of only
 * being exercisable against funded fal in CI. The load-bearing invariant is
 * that EVERY observation is graded on ENVELOPE SHAPE (via `triangulate`), never
 * on the job happening to be in a particular lifecycle state at poll time.
 */
import { expect } from "vitest";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import type { FalQueueCanaryResult } from "./providers.js";

// ---------------------------------------------------------------------------
// Expected shapes (fal.ai queue contract)
// ---------------------------------------------------------------------------

export function falQueueSubmitShape() {
  return extractShape({
    request_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    status_url: "https://queue.fal.run/fal-ai/flux/dev/requests/aaaaaaaa/status",
    response_url: "https://queue.fal.run/fal-ai/flux/dev/requests/aaaaaaaa",
    cancel_url: "https://queue.fal.run/fal-ai/flux/dev/requests/aaaaaaaa/cancel",
    queue_position: 0,
  });
}

export function falQueueStatusShape() {
  return extractShape({
    status: "COMPLETED",
    request_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    response_url: "https://queue.fal.run/fal-ai/flux/dev/requests/aaaaaaaa",
  });
}

export function falQueueResultShape() {
  return extractShape({
    images: [{ url: "https://example.com/cat.png" }],
  });
}

export function falQueueCancelShape() {
  return extractShape({
    status: "ALREADY_COMPLETED",
  });
}

/**
 * Valid fal queue states. A funded job may report ANY of these — a fast model
 * skips `IN_QUEUE` and returns `IN_PROGRESS` on submit immediately, and may even
 * reach `COMPLETED`/`CANCELLED` by the time we poll. The canary is
 * state-agnostic; the load-bearing invariant is that the reported state is one
 * of the known lifecycle values, never that it is specifically `IN_QUEUE`.
 */
export const VALID_QUEUE_STATUSES = new Set([
  "IN_QUEUE",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "CANCELLATION_REQUESTED",
]);

/**
 * Assert the three cost-safe live queue envelopes (submit, status, cancel)
 * against aimock's contract, STATE-AGNOSTICALLY. Timing is never assumed: the
 * job may be IN_QUEUE, IN_PROGRESS, COMPLETED, or CANCELLED at each observation.
 *
 * Every step accepts the real HTTP-status range fal returns across lifecycle
 * states, but the ENVELOPE SHAPE is always graded by `triangulate` — so a
 * genuine 2xx-with-wrong-shape STILL reports critical drift. State-tolerance is
 * NOT shape-blindness.
 *
 * @param live       the real fal submit/status/cancel observations
 * @param mockSubmit aimock's queue-submit body (parsed JSON)
 * @param mockStatus aimock's queue-status body (parsed JSON)
 */
export function assertLiveFalQueueEnvelopes(
  live: FalQueueCanaryResult,
  mockSubmit: unknown,
  mockStatus: unknown,
): void {
  // fal's queue API returns DIFFERENT HTTP status codes at each lifecycle step
  // purely as a function of job timing — a fast model is IN_PROGRESS on submit,
  // the status poll answers 202 while running vs 200 once COMPLETED, and cancel
  // answers 2xx (CANCELLATION_REQUESTED) while cancellable vs 4xx
  // (ALREADY_COMPLETED) on a completion race. Asserting any SPECIFIC code is
  // therefore inherently flaky. So we do NOT grade the HTTP status code at the
  // lifecycle steps at all — the actual drift signal is the ENVELOPE SHAPE,
  // which `triangulate` grades below at every step. Infra/auth codes
  // (401/402/403/429/5xx) are the ONE meaningful class, and the canary already
  // converts those to an honest FalCanarySkip BEFORE we get here (see
  // falQueueLifecycleCanary). ANTI-CHEAT: a genuine 2xx-wrong-shape still
  // reports critical drift because the shape grading is untouched.

  // --- Submit: enqueue must succeed (any 2xx); everything else is shape. The
  // request_id + the three lifecycle URLs are present at EVERY submit outcome
  // (only `queue_position` is timing-variable, so it is left to triangulate) —
  // these are timing-stable shape checks, not status-code checks. ---
  expect(live.submit.status, JSON.stringify(live.submit.body)).toBeGreaterThanOrEqual(200);
  expect(live.submit.status, JSON.stringify(live.submit.body)).toBeLessThan(300);
  expect(typeof live.submit.body?.request_id).toBe("string");
  expect(typeof live.submit.body?.status_url).toBe("string");
  expect(typeof live.submit.body?.response_url).toBe("string");
  expect(typeof live.submit.body?.cancel_url).toBe("string");
  // fal returns `status` on the submit envelope; when present it must be a
  // recognized lifecycle state (a wrong VALUE here is real drift, not timing).
  if (live.submit.body?.status !== undefined) {
    expect(VALID_QUEUE_STATUSES, JSON.stringify(live.submit.body)).toContain(
      live.submit.body.status,
    );
  }

  const submitDiffs = triangulate(
    falQueueSubmitShape(),
    extractShape(live.submit.body),
    extractShape(mockSubmit),
  );
  expect(
    submitDiffs.filter((d) => d.severity === "critical"),
    formatDriftReport("fal.ai queue submit (live)", submitDiffs, "fal-queue"),
  ).toEqual([]);

  // --- Status: grade SHAPE only; the HTTP code (200 COMPLETED vs 202 running)
  // is timing noise, deliberately NOT asserted. The status field's VALUE must
  // still be a recognized lifecycle state (a wrong value is drift, not timing). ---
  expect(live.statusPoll.body, JSON.stringify(live.statusPoll.body)).toBeTypeOf("object");
  expect(live.statusPoll.body).not.toBeNull();
  expect(typeof live.statusPoll.body?.status).toBe("string");
  expect(VALID_QUEUE_STATUSES, JSON.stringify(live.statusPoll.body)).toContain(
    live.statusPoll.body?.status,
  );

  const statusDiffs = triangulate(
    falQueueStatusShape(),
    extractShape(live.statusPoll.body),
    extractShape(mockStatus),
  );
  expect(
    statusDiffs.filter((d) => d.severity === "critical"),
    formatDriftReport("fal.ai queue status (live)", statusDiffs, "fal-queue"),
  ).toEqual([]);

  // --- Cancel: grade SHAPE only; the HTTP code (2xx CANCELLATION_REQUESTED vs
  // 4xx ALREADY_COMPLETED) is timing noise, deliberately NOT asserted. We only
  // require a JSON envelope came back, then triangulate its shape. We do NOT
  // require a `status` string — a completed job's `{detail}` body has none, and
  // demanding it was the original brittle bug. ---
  expect(live.cancel.body, JSON.stringify(live.cancel.body)).toBeTypeOf("object");
  expect(live.cancel.body).not.toBeNull();

  const cancelDiffs = triangulate(
    falQueueCancelShape(),
    extractShape(live.cancel.body),
    falQueueCancelShape(),
  );
  expect(
    cancelDiffs.filter((d) => d.severity === "critical"),
    formatDriftReport("fal.ai queue cancel (live)", cancelDiffs, "fal-queue"),
  ).toEqual([]);
}
