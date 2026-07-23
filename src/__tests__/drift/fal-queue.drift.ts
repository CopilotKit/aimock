/**
 * fal.ai Queue Lifecycle drift test.
 *
 * Validates the queue envelope shapes returned by aimock's fal handler:
 *   1. Submit (POST /fal/{owner}/{model} with x-fal-target-host: queue.fal.run)
 *   2. Status (GET .../requests/{id}/status)
 *   3. Result (GET .../requests/{id})
 *   4. Cancel (PUT .../requests/{id}/cancel)
 *
 * Does NOT cover sync run shapes — that is a separate test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LLMock } from "../../llmock.js";
import { extractShape, compareShapes, triangulate, formatDriftReport } from "./schema.js";
import { falQueueLifecycleCanary, FalCanarySkip, type FalQueueCanaryResult } from "./providers.js";

const FAL_KEY = process.env.FAL_KEY;

// ---------------------------------------------------------------------------
// Expected shapes (fal.ai queue contract)
// ---------------------------------------------------------------------------

function falQueueSubmitShape() {
  return extractShape({
    request_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    status_url: "https://queue.fal.run/fal-ai/flux/dev/requests/aaaaaaaa/status",
    response_url: "https://queue.fal.run/fal-ai/flux/dev/requests/aaaaaaaa",
    cancel_url: "https://queue.fal.run/fal-ai/flux/dev/requests/aaaaaaaa/cancel",
    queue_position: 0,
  });
}

function falQueueStatusShape() {
  return extractShape({
    status: "COMPLETED",
    request_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    response_url: "https://queue.fal.run/fal-ai/flux/dev/requests/aaaaaaaa",
  });
}

function falQueueResultShape() {
  return extractShape({
    images: [{ url: "https://example.com/cat.png" }],
  });
}

function falQueueCancelShape() {
  return extractShape({
    status: "ALREADY_COMPLETED",
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let mock: LLMock;

const FAL_FIXTURE_PAYLOAD = { images: [{ url: "https://example.com/cat.png" }] };

beforeAll(async () => {
  mock = new LLMock({ port: 0 });
  mock.onFalQueue(/flux/, FAL_FIXTURE_PAYLOAD);
  await mock.start();
});

afterAll(async () => {
  await mock?.stop();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fal.ai queue lifecycle shapes", () => {
  let requestId: string;

  it("submit returns queue envelope with correct shape", async () => {
    const expectedShape = falQueueSubmitShape();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-fal-target-host": "queue.fal.run",
      },
      body: JSON.stringify({ input: { prompt: "a cat" } }),
    });

    expect(res.status).toBe(200);
    const envelope = await res.json();

    // Stash for subsequent tests
    requestId = envelope.request_id;

    // Validate required fields exist with correct types
    expect(envelope.request_id).toEqual(expect.any(String));
    expect(envelope.status_url).toEqual(expect.any(String));
    expect(envelope.response_url).toEqual(expect.any(String));
    expect(envelope.cancel_url).toEqual(expect.any(String));
    expect(envelope.queue_position).toEqual(expect.any(Number));

    // Validate URLs contain the request_id
    expect(envelope.status_url).toContain(envelope.request_id);
    expect(envelope.response_url).toContain(envelope.request_id);
    expect(envelope.cancel_url).toContain(envelope.request_id);

    // Shape comparison
    const mockShape = extractShape(envelope);
    const diffs = compareShapes(expectedShape, mockShape);
    const report = formatDriftReport("fal.ai queue submit envelope", diffs, "fal-queue");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("status returns COMPLETED with correct shape", async () => {
    // Ensure submit ran first
    if (!requestId) {
      // Run a submit to get a requestId
      const submitRes = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-fal-target-host": "queue.fal.run",
        },
        body: JSON.stringify({ input: { prompt: "a cat" } }),
      });
      const envelope = await submitRes.json();
      requestId = envelope.request_id;
    }

    const expectedShape = falQueueStatusShape();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${requestId}/status`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("COMPLETED");
    expect(body.request_id).toBe(requestId);
    expect(body.response_url).toContain(requestId);

    const mockShape = extractShape(body);
    const diffs = compareShapes(expectedShape, mockShape);
    const report = formatDriftReport("fal.ai queue status", diffs, "fal-queue");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("result returns the fixture JSON payload", async () => {
    // Ensure submit ran first
    if (!requestId) {
      const submitRes = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-fal-target-host": "queue.fal.run",
        },
        body: JSON.stringify({ input: { prompt: "a cat" } }),
      });
      const envelope = await submitRes.json();
      requestId = envelope.request_id;
    }

    const expectedShape = falQueueResultShape();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${requestId}`, {
      headers: { "x-fal-target-host": "queue.fal.run" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // Exact payload match
    expect(body).toEqual(FAL_FIXTURE_PAYLOAD);

    const mockShape = extractShape(body);
    const diffs = compareShapes(expectedShape, mockShape);
    const report = formatDriftReport("fal.ai queue result", diffs, "fal-queue");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("cancel returns ALREADY_COMPLETED with 400", async () => {
    // Ensure submit ran first
    if (!requestId) {
      const submitRes = await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-fal-target-host": "queue.fal.run",
        },
        body: JSON.stringify({ input: { prompt: "a cat" } }),
      });
      const envelope = await submitRes.json();
      requestId = envelope.request_id;
    }

    const expectedShape = falQueueCancelShape();

    const res = await fetch(`${mock.url}/fal/fal-ai/flux/dev/requests/${requestId}/cancel`, {
      method: "PUT",
      headers: { "x-fal-target-host": "queue.fal.run" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();

    expect(body.status).toBe("ALREADY_COMPLETED");

    const mockShape = extractShape(body);
    const diffs = compareShapes(expectedShape, mockShape);
    const report = formatDriftReport("fal.ai queue cancel", diffs, "fal-queue");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LIVE queue-lifecycle canary (COST-SAFE, gated on FAL_KEY).
//
// Skips in CI until FAL_KEY is mirrored to repo secrets. Drives the REAL fal
// queue API through submit -> status -> IMMEDIATE cancel and triangulates each
// envelope (exemplar x real x aimock mock). It NEVER fetches the completed
// result payload — that is the only paid retrieval, so the completed-result
// envelope stays STATIC-only (the mock-vs-exemplar tests above).
//
// COST: fal bills compute only when a queued job RUNS. Submitting is free and
// the job is cancelled while still IN_QUEUE, so the expected cost is $0.
// Cheapest reliably-available model is used to bound the worst case; residual
// exposure is at most one sub-cent generation if the model races to completion
// before the cancel lands.
// ---------------------------------------------------------------------------

/** Cheapest reliably-available fal image model; cancelled before it runs. */
const FAL_CANARY_MODEL = "fal-ai/flux/schnell";

describe.skipIf(!FAL_KEY)("fal.ai queue lifecycle (live, cost-safe)", () => {
  it("real submit + status + cancel envelopes match aimock's queue contract", async (ctx) => {
    // Drive the real fal queue (submit + immediate cancel) and the aimock
    // server in parallel, then triangulate exemplar x real x mock per step.
    let live: FalQueueCanaryResult;
    let mockSubmitRes: Response;
    try {
      [live, mockSubmitRes] = await Promise.all([
        falQueueLifecycleCanary(FAL_KEY!, FAL_CANARY_MODEL, {
          prompt: "aimock drift canary — cancelled immediately",
          num_images: 1,
        }),
        fetch(`${mock.url}/fal/${FAL_CANARY_MODEL}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-fal-target-host": "queue.fal.run",
          },
          body: JSON.stringify({ input: { prompt: "a cat" } }),
        }),
      ]);
    } catch (err) {
      // fal itself unavailable (locked account / exhausted balance / rate /
      // 5xx) is NOT drift — skip the live canary with a clear reason instead of
      // failing the drift suite and poisoning the baseline. A genuine envelope
      // drift is a 2xx-with-wrong-shape and never lands here.
      if (err instanceof FalCanarySkip) {
        console.warn(`[fal drift] ${err.message}`);
        ctx.skip(err.message);
        return;
      }
      throw err;
    }

    // --- Submit: the queue contract's load-bearing fields, then triangulate ---
    expect(live.submit.status, JSON.stringify(live.submit.body)).toBe(200);
    expect(typeof live.submit.body?.request_id).toBe("string");
    expect(typeof live.submit.body?.status_url).toBe("string");
    expect(typeof live.submit.body?.response_url).toBe("string");
    expect(typeof live.submit.body?.cancel_url).toBe("string");

    const mockSubmitBody = await mockSubmitRes.json();
    const submitDiffs = triangulate(
      falQueueSubmitShape(),
      extractShape(live.submit.body),
      extractShape(mockSubmitBody),
    );
    expect(
      submitDiffs.filter((d) => d.severity === "critical"),
      formatDriftReport("fal.ai queue submit (live)", submitDiffs, "fal-queue"),
    ).toEqual([]);

    // --- Status: triangulate real vs aimock vs exemplar (shape, not value) ---
    const mockStatusRes = await fetch(
      `${mock.url}/fal/${FAL_CANARY_MODEL}/requests/${mockSubmitBody.request_id}/status`,
      { headers: { "x-fal-target-host": "queue.fal.run" } },
    );
    expect(live.statusPoll.status, JSON.stringify(live.statusPoll.body)).toBe(200);
    expect(typeof live.statusPoll.body?.status).toBe("string");

    const statusDiffs = triangulate(
      falQueueStatusShape(),
      extractShape(live.statusPoll.body),
      extractShape(await mockStatusRes.json()),
    );
    expect(
      statusDiffs.filter((d) => d.severity === "critical"),
      formatDriftReport("fal.ai queue status (live)", statusDiffs, "fal-queue"),
    ).toEqual([]);

    // --- Cancel: real fal returns a { status } envelope (200
    // CANCELLATION_REQUESTED while queued, or 400 ALREADY_COMPLETED on a race).
    // The load-bearing field is `status: string` either way. ---
    expect([200, 400]).toContain(live.cancel.status);
    expect(typeof live.cancel.body?.status).toBe("string");

    const cancelDiffs = triangulate(
      falQueueCancelShape(),
      extractShape(live.cancel.body),
      falQueueCancelShape(),
    );
    expect(
      cancelDiffs.filter((d) => d.severity === "critical"),
      formatDriftReport("fal.ai queue cancel (live)", cancelDiffs, "fal-queue"),
    ).toEqual([]);
  });
});
