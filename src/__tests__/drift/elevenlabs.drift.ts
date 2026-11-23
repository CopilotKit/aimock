/**
 * ElevenLabs Audio API drift tests.
 *
 * Validates aimock response shape for ElevenLabs endpoints:
 * - /v1/sound-generation — binary audio with Content-Type header
 * - /v1/music — binary audio with song-id header
 * - /v1/music/stream — chunked binary audio
 * - /v1/music/plan — JSON composition plan (passthrough conformance of a
 *   test-authored fixture against the SDK's `MusicPrompt.Raw`; no vendor observation)
 *
 * Since ElevenLabs returns binary audio (not JSON), drift testing focuses on
 * Content-Type headers, binary payload presence, and JSON plan structure
 * rather than three-way JSON shape comparison.
 *
 * LIVE COVERAGE: the /v1/sound-generation case below fetches the real
 * `api.elevenlabs.io` when ELEVENLABS_API_KEY is set and emits the one
 * `elevenlabs` drift block graded against a vendor response (status,
 * Content-Type, body presence — the body is opaque audio), which is what earns
 * this surface `liveCoverage: "live"`. Every other case here is offline
 * conformance against the local mock. Without the key the live case skips and
 * the run proves nothing about the vendor.
 *
 * The Voice Design routes (`/v1/text-to-voice/design`, `/v1/text-to-voice`) are
 * NOT covered here — they have no live leg at all and live in
 * `elevenlabs-voice.drift.ts` as the separately-declared, offline-only
 * `elevenlabs-voice` surface.
 *
 * Requires: ELEVENLABS_API_KEY (for the one real-API case; omitted → it skips)
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

// The plan handler (`src/elevenlabs-audio.ts`, `subType === "plan"`) writes
// `response.content` to the wire VERBATIM, so the fixture itself has to be
// vendor-shaped: this is a `MusicPrompt.Raw` (see `musicPlanResponseShape`).
const PLAN_FIXTURE: Fixture = {
  match: { userMessage: "jazz composition", endpoint: "audio-gen" },
  response: {
    content: JSON.stringify({
      positive_global_styles: ["jazz", "swing"],
      negative_global_styles: ["distorted"],
      sections: [
        {
          section_name: "intro",
          positive_local_styles: ["brushed drums", "walking bass"],
          negative_local_styles: ["vocals"],
          duration_ms: 12000,
          lines: ["(instrumental)"],
        },
      ],
    }),
  },
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
  // `instance` is unset when `beforeAll` threw; closing it then raises a
  // TypeError here that REPLACES the real failure in the report.
  if (!instance) return;
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
        // A socket error or an abort AFTER the headers arrive settles nothing
        // on `req`, so without these two the promise stays pending and the
        // failure surfaces as a 60s testTimeout with no cause named.
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("response aborted before end")));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
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

async function realSoundGeneration(text: string): Promise<{
  status: number;
  contentType: string | null;
  bodyLength: number;
  /** The vendor's error envelope on a non-2xx, so a failing live leg names its cause. */
  errorBody: string | null;
}> {
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
    errorBody: res.ok ? null : Buffer.from(buf).toString("utf8"),
  };
}

// ---------------------------------------------------------------------------
// SDK shape stubs for JSON plan endpoint
// ---------------------------------------------------------------------------

/**
 * Expected shape for the `POST /v1/music/plan` response.
 *
 * SOURCE (secondary — the official client, NOT a recorded vendor response):
 * `@elevenlabs/elevenlabs-js@2.68.0`, read out of the published npm tarball
 * (the package is not a dependency of this repo):
 *   - `api/resources/music/resources/compositionPlan/client/Client.js` joins
 *     `"v1/music/plan"` onto the base URL and parses the body with
 *     `serializers.music.CompositionPlanCreateResponse.parseOrThrow`;
 *   - `serialization/resources/music/resources/compositionPlan/types/
 *     CompositionPlanCreateResponse.d.ts`:
 *     `type Raw = MusicPrompt.Raw | CompositionPlan.Raw`;
 *   - `serialization/types/MusicPrompt.d.ts` `Raw`:
 *     `{ positive_global_styles: string[]; negative_global_styles: string[];
 *     sections: SongSection.Raw[] }`;
 *   - `serialization/types/SongSection.d.ts` `Raw`:
 *     `{ section_name: string; positive_local_styles: string[];
 *     negative_local_styles: string[]; duration_ms: number; lines: string[];
 *     source_from?: SectionSource.Raw | null }` (`source_from` is optional
 *     and omitted here).
 *
 * This is the `MusicPrompt.Raw` arm (the `music_v1` composition plan) — the
 * shape the SDK will PARSE, not one this repo has observed on the wire: no
 * live `/v1/music/plan` request has ever been made from here, and the
 * `elevenlabs` surface's `liveCoverage: "live"` is earned by the
 * `/v1/sound-generation` leg alone (see the file header).
 *
 * What the case below grades is passthrough conformance against a
 * test-authored fixture, with no vendor observation: the plan handler writes
 * `PLAN_FIXTURE`'s `response.content` verbatim, so the only things that can
 * red it are a passthrough bug or the fixture and this shape disagreeing.
 */
function musicPlanResponseShape() {
  return extractShape({
    positive_global_styles: ["jazz"],
    negative_global_styles: ["distorted"],
    sections: [
      {
        section_name: "intro",
        positive_local_styles: ["brushed drums"],
        negative_local_styles: ["vocals"],
        duration_ms: 12000,
        lines: ["(instrumental)"],
      },
    ],
  });
}

/**
 * aimock's HOUSE error envelope — NOT ElevenLabs'. The real service answers a
 * missing or invalid body field with 422 `{ detail: [ { type, loc, msg, ... } ] }`
 * (a pydantic-style ARRAY; observed keyless on the Voice Design routes on
 * 2026-09-15 — see the provenance block in `src/elevenlabs-voice.ts`) and an
 * auth failure with 401 `{ detail: { type, code, message, status, request_id } }`.
 * The 400 cases below pin aimock's own missing-parameter contract; they say
 * nothing about the vendor's error shape.
 */
function aimockErrorEnvelopeShape() {
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

  it("/v1/sound-generation missing text field returns 400 with aimock's error envelope (vendor shape not observed on this route)", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/sound-generation`, {});

    expect(mockRes.status).toBe(400);
    expect(mockRes.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(mockRes.bodyBuffer.toString("utf8"));
    const expectedShape = aimockErrorEnvelopeShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(expectedShape, expectedShape, mockShape);
    const report = formatDriftReport(
      "ElevenLabs /v1/sound-generation 400 error (aimock envelope)",
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

      expect(realRes.status, `vendor error body: ${realRes.errorBody}`).toBe(200);
      // Real API returns audio content type
      expect(realRes.contentType).toMatch(/^audio\//);
      expect(realRes.bodyLength).toBeGreaterThan(0);

      // Compare that mock also returns an audio content type
      const mockRes = await httpPostBinary(`${instance.url}/v1/sound-generation`, {
        text: "castle door opening",
      });
      expect(mockRes.status).toBe(200);
      expect(mockRes.headers["content-type"]).toMatch(/^audio\//);

      // The only surface-keyed drift block in this file that is graded against
      // a VENDOR response. The body is opaque audio, so what is compared is the
      // response envelope: status, Content-Type presence/type, and whether any
      // bytes came back. `elevenlabs`'s `liveCoverage: "live"` rests on this
      // block alone; every other emit in this file is offline conformance.
      const realShape = extractShape({
        status: realRes.status,
        contentType: realRes.contentType,
        hasAudioBytes: realRes.bodyLength > 0,
      });
      const mockShape = extractShape({
        status: mockRes.status,
        contentType: mockRes.headers["content-type"] ?? null,
        hasAudioBytes: mockRes.bodyBuffer.byteLength > 0,
      });
      const diffs = triangulate(realShape, realShape, mockShape);
      const report = formatDriftReport(
        "ElevenLabs /v1/sound-generation (live response envelope)",
        diffs,
        "elevenlabs",
      );
      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
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
    expect(mockRes.headers["content-type"]).toContain("application/json");

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

  it("/v1/music missing prompt returns 400 with aimock's error envelope (vendor shape not observed on this route)", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/music`, {});

    expect(mockRes.status).toBe(400);
    expect(mockRes.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(mockRes.bodyBuffer.toString("utf8"));
    const expectedShape = aimockErrorEnvelopeShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(expectedShape, expectedShape, mockShape);
    const report = formatDriftReport(
      "ElevenLabs /v1/music 400 error (aimock envelope)",
      diffs,
      "elevenlabs",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("/v1/music/plan does not set the song-id header", async () => {
    const mockRes = await httpPostBinary(`${instance.url}/v1/music/plan`, {
      prompt: "jazz composition",
    });

    expect(mockRes.status).toBe(200);
    // Plan endpoint should NOT set song-id header
    expect(mockRes.headers["song-id"]).toBeUndefined();
  });
});
