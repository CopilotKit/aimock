/**
 * fal.ai response shape drift tests.
 *
 * Validates that aimock's fal sync-run handler (`POST /fal/{owner}/{model}`
 * with `x-fal-target-host: fal.run`) returns the fixture's RawJSONResponse
 * payload directly — no envelope, no shape coercion.
 *
 * Scope: sync run response shape only. Queue lifecycle is tested separately.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { LLMock } from "../../llmock.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let mock: LLMock;

/** A representative fal.ai image-generation response (flux-style). */
const FAL_IMAGE_PAYLOAD = {
  images: [
    {
      url: "https://fal.media/files/abc123/output.png",
      width: 1024,
      height: 1024,
      content_type: "image/png",
    },
  ],
  timings: { inference: 1.42 },
  seed: 42,
  has_nsfw_concepts: [false],
  prompt: "a cat in a spacesuit",
};

/** A minimal flat payload to verify arbitrary JSON passthrough. */
const FAL_FLAT_PAYLOAD = {
  text: "transcribed audio output",
  chunks: [{ timestamp: [0, 1.5], text: "transcribed" }],
};

beforeAll(async () => {
  mock = new LLMock({ port: 0 });
  mock.onFalRun(/flux/, FAL_IMAGE_PAYLOAD);
  mock.onFalRun(/whisper/, FAL_FLAT_PAYLOAD);
  await mock.start();
});

afterAll(async () => {
  await mock?.stop();
});

// ---------------------------------------------------------------------------
// HTTP helper (supports custom headers, unlike the shared httpPost)
// ---------------------------------------------------------------------------

async function falPost(
  url: string,
  body: object,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fal.ai sync-run response shape", () => {
  it("returns fixture JSON directly — no queue envelope", async () => {
    const res = await falPost(
      `${mock.url}/fal/fal-ai/flux/dev`,
      { prompt: "a cat in a spacesuit" },
      { "x-fal-target-host": "fal.run" },
    );

    expect(res.status).toBe(200);

    const parsed = JSON.parse(res.body);

    // Must NOT have queue envelope fields
    expect(parsed.request_id).toBeUndefined();
    expect(parsed.response_url).toBeUndefined();
    expect(parsed.status_url).toBeUndefined();
    expect(parsed.cancel_url).toBeUndefined();
    expect(parsed.queue_position).toBeUndefined();

    // Must exactly match the fixture payload
    expect(parsed).toEqual(FAL_IMAGE_PAYLOAD);
  });

  it("Content-Type is application/json", async () => {
    const res = await falPost(
      `${mock.url}/fal/fal-ai/flux/dev`,
      { prompt: "a cat in a spacesuit" },
      { "x-fal-target-host": "fal.run" },
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("RawJSONResponse passthrough preserves nested structure", async () => {
    const expectedShape = extractShape(FAL_IMAGE_PAYLOAD);

    const res = await falPost(
      `${mock.url}/fal/fal-ai/flux/dev`,
      { prompt: "a cat in a spacesuit" },
      { "x-fal-target-host": "fal.run" },
    );

    expect(res.status).toBe(200);
    const mockShape = extractShape(JSON.parse(res.body));

    // Two-way triangulation: expected shape is both the "SDK" and "real" reference
    // since fal passthrough should be identity.
    const diffs = triangulate(expectedShape, expectedShape, mockShape);
    const report = formatDriftReport("fal.ai sync-run (image payload)", diffs, "fal-sync");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("RawJSONResponse passthrough works for arbitrary payload shapes", async () => {
    const expectedShape = extractShape(FAL_FLAT_PAYLOAD);

    const res = await falPost(
      `${mock.url}/fal/fal-ai/whisper/v3`,
      { audio_url: "https://example.com/audio.mp3" },
      { "x-fal-target-host": "fal.run" },
    );

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);

    // Exact payload match
    expect(parsed).toEqual(FAL_FLAT_PAYLOAD);

    // Shape match via triangulation
    const mockShape = extractShape(parsed);
    const diffs = triangulate(expectedShape, expectedShape, mockShape);
    const report = formatDriftReport("fal.ai sync-run (flat payload)", diffs, "fal-sync");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});
