/**
 * ElevenLabs Audio API drift tests.
 *
 * Validates aimock response shape for ElevenLabs endpoints:
 * - /v1/sound-generation — binary audio with Content-Type header
 * - /v1/music — binary audio with song-id header
 * - /v1/music/stream — chunked binary audio
 * - /v1/music/plan — JSON composition plan
 *
 * Since ElevenLabs returns binary audio (not JSON), drift testing focuses on
 * Content-Type headers, binary payload presence, and JSON plan structure
 * rather than three-way JSON shape comparison.
 *
 * Requires: ELEVENLABS_API_KEY (for real API comparison; tests run mock-only otherwise)
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";

// ---------------------------------------------------------------------------
// Credentials check
// ---------------------------------------------------------------------------

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const HAS_CREDENTIALS = !!ELEVENLABS_API_KEY;

// ---------------------------------------------------------------------------
// Audio fixtures — ElevenLabs needs audio-gen endpoint type
// ---------------------------------------------------------------------------

const SOUND_FIXTURE: Fixture = {
  match: { userMessage: "castle door opening", endpoint: "audio-gen" },
  response: { audio: "SGVsbG8=", format: "mp3" },
};

const MUSIC_FIXTURE: Fixture = {
  match: { userMessage: "upbeat piano", endpoint: "audio-gen" },
  response: { audio: "SGVsbG8=", format: "mp3" },
};

const PLAN_FIXTURE: Fixture = {
  match: { userMessage: "jazz composition", endpoint: "audio-gen" },
  response: { content: JSON.stringify({ sections: ["intro", "verse", "chorus"], bpm: 120 }) },
};

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer([SOUND_FIXTURE, MUSIC_FIXTURE, PLAN_FIXTURE], {
    port: 0,
    chunkSize: 100,
  });
});

afterAll(async () => {
  await new Promise<void>((r) => instance.server.close(() => r()));
});

// ---------------------------------------------------------------------------
// HTTP helpers (binary-aware)
// ---------------------------------------------------------------------------

function httpPostBinary(
  url: string,
  body: object,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; bodyBuffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            bodyBuffer: Buffer.concat(chunks),
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
// Real API helpers (used when ELEVENLABS_API_KEY is available)
// ---------------------------------------------------------------------------

async function realSoundGeneration(
  text: string,
): Promise<{ status: number; contentType: string | null; bodyLength: number }> {
  const res = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVENLABS_API_KEY!,
    },
    body: JSON.stringify({ text, duration_seconds: 1 }),
  });
  const buf = await res.arrayBuffer();
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    bodyLength: buf.byteLength,
  };
}

// ---------------------------------------------------------------------------
// SDK shape stubs for JSON plan endpoint
// ---------------------------------------------------------------------------

/**
 * Expected shape for /v1/music/plan response — returns a JSON composition plan.
 */
function musicPlanResponseShape() {
  return extractShape({
    sections: ["intro", "verse", "chorus"],
    bpm: 120,
  });
}

/**
 * Expected shape for ElevenLabs error responses.
 */
function elevenLabsErrorShape() {
  return extractShape({
    error: {
      message: "Missing required parameter: 'text'",
      type: "invalid_request_error",
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ElevenLabs drift — sound generation", () => {
  it("/v1/sound-generation returns binary audio with correct Content-Type", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/sound-generation`, {
      text: "castle door opening",
    });

    expect(mockRes.status).toBe(200);
    expect(mockRes.headers["content-type"]).toBe("audio/mpeg");
    expect(mockRes.bodyBuffer.byteLength).toBeGreaterThan(0);

    // "SGVsbG8=" decodes to "Hello" (5 bytes)
    expect(mockRes.bodyBuffer.byteLength).toBe(5);
  });

  it("/v1/sound-generation missing text field returns 400 with error shape", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/sound-generation`, {});

    expect(mockRes.status).toBe(400);
    expect(mockRes.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(mockRes.bodyBuffer.toString("utf8"));
    const sdkShape = elevenLabsErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "ElevenLabs /v1/sound-generation 400 error",
      diffs,
      "elevenlabs",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it.skipIf(!HAS_CREDENTIALS)(
    "/v1/sound-generation real API returns audio content-type",
    async () => {
      const realRes = await realSoundGeneration("castle door opening");

      expect(realRes.status).toBe(200);
      // Real API returns audio content type
      expect(realRes.contentType).toMatch(/^audio\//);
      expect(realRes.bodyLength).toBeGreaterThan(0);

      // Compare that mock also returns an audio content type
      const mockRes = await httpPostBinary(`${instance.url}/v1/sound-generation`, {
        text: "castle door opening",
      });
      expect(mockRes.status).toBe(200);
      expect(mockRes.headers["content-type"]).toMatch(/^audio\//);
    },
  );
});

describe("ElevenLabs drift — music endpoints", () => {
  it("/v1/music returns binary audio with song-id header", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/music`, {
      prompt: "upbeat piano",
    });

    expect(mockRes.status).toBe(200);
    expect(mockRes.headers["content-type"]).toBe("audio/mpeg");
    expect(mockRes.headers["song-id"]).toBeTruthy();
    expect(mockRes.headers["song-id"]).toMatch(/^mock-song-/);
    expect(mockRes.bodyBuffer.byteLength).toBeGreaterThan(0);
  });

  it("/v1/music/stream returns binary audio with chunked encoding", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/music/stream`, {
      prompt: "upbeat piano",
    });

    expect(mockRes.status).toBe(200);
    expect(mockRes.headers["content-type"]).toBe("audio/mpeg");
    // Stream endpoints use chunked transfer encoding
    expect(mockRes.headers["transfer-encoding"]).toBe("chunked");
    expect(mockRes.bodyBuffer.byteLength).toBeGreaterThan(0);
  });

  it("/v1/music/plan returns JSON with application/json Content-Type", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/music/plan`, {
      prompt: "jazz composition",
    });

    expect(mockRes.status).toBe(200);
    expect(mockRes.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(mockRes.bodyBuffer.toString("utf8"));
    const sdkShape = musicPlanResponseShape();
    const mockShape = extractShape(body);

    // Three-way comparison: use SDK shape as both expected and real
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("ElevenLabs /v1/music/plan", diffs, "elevenlabs");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("/v1/music missing prompt returns 400 with error shape", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/music`, {});

    expect(mockRes.status).toBe(400);
    expect(mockRes.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(mockRes.bodyBuffer.toString("utf8"));
    const expectedShape = extractShape({
      error: {
        message: "Missing required parameter: 'prompt'",
        type: "invalid_request_error",
      },
    });
    const mockShape = extractShape(body);

    const diffs = triangulate(expectedShape, expectedShape, mockShape);
    const report = formatDriftReport("ElevenLabs /v1/music 400 error", diffs, "elevenlabs");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("/v1/music song-id header absent on plan endpoint", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/music/plan`, {
      prompt: "jazz composition",
    });

    expect(mockRes.status).toBe(200);
    // Plan endpoint should NOT set song-id header
    expect(mockRes.headers["song-id"]).toBeUndefined();
  });
});
