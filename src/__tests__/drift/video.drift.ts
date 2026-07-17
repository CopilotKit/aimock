/**
 * Video API drift tests.
 *
 * Validates response shapes for POST /v1/videos (create) and
 * GET /v1/videos/{id} (status polling). Two fixture scenarios:
 *   1. Completed — response includes `url`
 *   2. Processing — response omits `url`
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, compareShapes, formatDriftReport } from "./schema.js";
import { httpPost } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VIDEO_COMPLETED_FIXTURE: Fixture = {
  match: { userMessage: "a guitar solo", endpoint: "video" },
  response: {
    video: { id: "vid_completed", status: "completed", url: "https://example.com/guitar.mp4" },
  },
};

const VIDEO_PROCESSING_FIXTURE: Fixture = {
  match: { userMessage: "slow motion rain", endpoint: "video" },
  response: {
    video: { id: "vid_processing", status: "processing" },
  },
};

// ---------------------------------------------------------------------------
// Expected shapes
// ---------------------------------------------------------------------------

function videoCreateCompletedShape() {
  return extractShape({
    id: "vid_completed",
    status: "completed",
    url: "https://example.com/guitar.mp4",
    created_at: 1700000000,
  });
}

function videoCreateProcessingShape() {
  return extractShape({
    id: "vid_processing",
    status: "processing",
    created_at: 1700000000,
  });
}

function videoStatusCompletedShape() {
  return extractShape({
    id: "vid_completed",
    status: "completed",
    url: "https://example.com/guitar.mp4",
    created_at: 1700000000,
  });
}

function videoStatusProcessingShape() {
  return extractShape({
    id: "vid_processing",
    status: "processing",
    created_at: 1700000000,
  });
}

// ---------------------------------------------------------------------------
// HTTP GET helper
// ---------------------------------------------------------------------------

async function httpGet(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer([VIDEO_COMPLETED_FIXTURE, VIDEO_PROCESSING_FIXTURE], {
    port: 0,
  });
});

afterAll(async () => {
  await new Promise<void>((r) => instance.server.close(() => r()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Video API drift", () => {
  describe("POST /v1/videos (create)", () => {
    it("completed video returns { id, status, url, created_at }", async () => {
      const expected = videoCreateCompletedShape();

      const res = await httpPost(`${instance.url}/v1/videos`, {
        model: "sora-2",
        prompt: "a guitar solo",
      });

      expect(res.status).toBe(200);
      const mockShape = extractShape(JSON.parse(res.body));
      const diffs = compareShapes(expected, mockShape);
      const report = formatDriftReport("Video create (completed)", diffs, "video");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    });

    it("processing video returns { id, status, created_at } without url", async () => {
      const expected = videoCreateProcessingShape();

      const res = await httpPost(`${instance.url}/v1/videos`, {
        model: "sora-2",
        prompt: "slow motion rain",
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      const mockShape = extractShape(body);
      const diffs = compareShapes(expected, mockShape);
      const report = formatDriftReport("Video create (processing)", diffs, "video");

      // Processing response must NOT include url
      expect(body.url).toBeUndefined();

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    });
  });

  describe("GET /v1/videos/{id} (status)", () => {
    it("completed video status returns { id, status, url, created_at }", async () => {
      // First create the video so it exists in state
      await httpPost(`${instance.url}/v1/videos`, {
        model: "sora-2",
        prompt: "a guitar solo",
      });

      const expected = videoStatusCompletedShape();
      const res = await httpGet(`${instance.url}/v1/videos/vid_completed`);

      expect(res.status).toBe(200);
      const mockShape = extractShape(JSON.parse(res.body));
      const diffs = compareShapes(expected, mockShape);
      const report = formatDriftReport("Video status (completed)", diffs, "video");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    });

    it("processing video status returns { id, status, created_at } without url", async () => {
      // First create the video so it exists in state
      await httpPost(`${instance.url}/v1/videos`, {
        model: "sora-2",
        prompt: "slow motion rain",
      });

      const expected = videoStatusProcessingShape();
      const res = await httpGet(`${instance.url}/v1/videos/vid_processing`);

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      const mockShape = extractShape(body);
      const diffs = compareShapes(expected, mockShape);
      const report = formatDriftReport("Video status (processing)", diffs, "video");

      // Processing status must NOT include url
      expect(body.url).toBeUndefined();

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    });

    it("unknown video id returns 404", async () => {
      const res = await httpGet(`${instance.url}/v1/videos/nonexistent`);
      expect(res.status).toBe(404);

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe("not_found");
    });
  });
});
