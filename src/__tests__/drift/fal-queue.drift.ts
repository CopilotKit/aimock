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
import { extractShape, compareShapes, formatDriftReport } from "./schema.js";
import { falQueueLifecycleCanary, FalCanarySkip, type FalQueueCanaryResult } from "./providers.js";
import {
  falQueueSubmitShape,
  falQueueStatusShape,
  falQueueResultShape,
  falQueueCancelShape,
  assertLiveFalQueueEnvelopes,
} from "./fal-queue-contract.js";

const FAL_KEY = process.env.FAL_KEY;

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

/** Cheapest reliably-available fal image model; cancelled ASAP after submit. */
const FAL_CANARY_MODEL = "fal-ai/flux/schnell";

describe.skipIf(!FAL_KEY)("fal.ai queue lifecycle (live, cost-safe)", () => {
  it("real submit + status + cancel envelopes match aimock's queue contract", async (ctx) => {
    // Drive the real fal queue (submit + immediate cancel) and the aimock
    // server in parallel, then grade each envelope on SHAPE per step.
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

    const mockSubmitBody = await mockSubmitRes.json();
    const mockStatusRes = await fetch(
      `${mock.url}/fal/${FAL_CANARY_MODEL}/requests/${mockSubmitBody.request_id}/status`,
      { headers: { "x-fal-target-host": "queue.fal.run" } },
    );
    const mockStatusBody = await mockStatusRes.json();

    // State-agnostic across the WHOLE job lifecycle: submit/status/cancel are
    // graded on ENVELOPE SHAPE (triangulate), never on the job being in a
    // specific state — or the status poll returning a specific 2xx code — at
    // observation time. The shape grading still reports a 2xx-wrong-shape as
    // critical drift. See fal-queue-contract.ts + fal-queue-contract.test.ts.
    assertLiveFalQueueEnvelopes(live, mockSubmitBody, mockStatusBody);
  });
});
