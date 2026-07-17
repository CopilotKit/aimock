/**
 * OpenAI Images API drift tests.
 *
 * Two-way comparison: SDK types × aimock output.
 * (Real API calls are skipped — DALL-E generations are expensive and slow.)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost } from "./helpers.js";
import type { Fixture } from "../../types.js";

// ---------------------------------------------------------------------------
// SDK shapes — minimal conformant instances matching OpenAI's Images API
// ---------------------------------------------------------------------------

/** Shape for `POST /v1/images/generations` with `response_format: "url"` */
function openaiImageUrlResponseShape() {
  return extractShape({
    created: 1700000000,
    data: [
      {
        url: "https://example.com/image.png",
        revised_prompt: "A cute baby sea otter",
      },
    ],
  });
}

/** Shape for `POST /v1/images/generations` with `response_format: "b64_json"` */
function openaiImageB64ResponseShape() {
  return extractShape({
    created: 1700000000,
    data: [
      {
        b64_json: "iVBORw0KGgo...",
        revised_prompt: "A cute baby sea otter",
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Image fixtures
// ---------------------------------------------------------------------------

const IMAGE_URL_FIXTURE: Fixture = {
  match: { userMessage: "Generate a cat" },
  response: {
    image: {
      url: "https://mock.aimock.dev/cat.png",
      revisedPrompt: "A fluffy orange tabby cat sitting on a windowsill",
    },
  },
};

const IMAGE_B64_FIXTURE: Fixture = {
  match: { userMessage: "Generate a dog" },
  response: {
    image: {
      b64Json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
      revisedPrompt: "A golden retriever playing in a park",
    },
  },
};

const IMAGE_MULTI_FIXTURE: Fixture = {
  match: { userMessage: "Generate animals" },
  response: {
    images: [
      {
        url: "https://mock.aimock.dev/cat.png",
        revisedPrompt: "A fluffy cat",
      },
      {
        url: "https://mock.aimock.dev/dog.png",
        revisedPrompt: "A happy dog",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer([IMAGE_URL_FIXTURE, IMAGE_B64_FIXTURE, IMAGE_MULTI_FIXTURE], {
    port: 0,
  });
});

afterAll(async () => {
  await new Promise<void>((r) => instance.server.close(() => r()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAI Images API drift", () => {
  it("url variant response shape matches SDK", async () => {
    const sdkShape = openaiImageUrlResponseShape();

    const mockRes = await httpPost(`${instance.url}/v1/images/generations`, {
      model: "dall-e-3",
      prompt: "Generate a cat",
    });

    expect(mockRes.status, `Expected 200 but got ${mockRes.status}: ${mockRes.body}`).toBe(200);

    const mockShape = extractShape(JSON.parse(mockRes.body));

    // Two-way: SDK vs mock (no real API call — DALL-E is expensive)
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenAI Images (url variant)", diffs, "images");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("b64_json variant response shape matches SDK", async () => {
    const sdkShape = openaiImageB64ResponseShape();

    const mockRes = await httpPost(`${instance.url}/v1/images/generations`, {
      model: "dall-e-3",
      prompt: "Generate a dog",
      response_format: "b64_json",
    });

    expect(mockRes.status, `Expected 200 but got ${mockRes.status}: ${mockRes.body}`).toBe(200);

    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenAI Images (b64_json variant)", diffs, "images");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("multi-image response shape matches SDK", async () => {
    const sdkShape = openaiImageUrlResponseShape();

    const mockRes = await httpPost(`${instance.url}/v1/images/generations`, {
      model: "dall-e-3",
      prompt: "Generate animals",
      n: 2,
    });

    expect(mockRes.status, `Expected 200 but got ${mockRes.status}: ${mockRes.body}`).toBe(200);

    const parsed = JSON.parse(mockRes.body);
    expect(parsed.data.length, "Expected multiple images in response").toBe(2);

    const mockShape = extractShape(parsed);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenAI Images (multi-image)", diffs, "images");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("missing prompt returns 400 error", async () => {
    const mockRes = await httpPost(`${instance.url}/v1/images/generations`, {
      model: "dall-e-3",
    });

    expect(mockRes.status).toBe(400);
    const body = JSON.parse(mockRes.body);
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("prompt");
  });

  it("response contains created timestamp as number", async () => {
    const mockRes = await httpPost(`${instance.url}/v1/images/generations`, {
      model: "dall-e-3",
      prompt: "Generate a cat",
    });

    expect(mockRes.status).toBe(200);
    const body = JSON.parse(mockRes.body);
    expect(typeof body.created).toBe("number");
    expect(body.created).toBeGreaterThan(0);
  });
});
