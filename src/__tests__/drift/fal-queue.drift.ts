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
