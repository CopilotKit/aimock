/**
 * OpenAI Transcription/STT API drift tests.
 *
 * Validates aimock's /v1/audio/transcriptions endpoint against:
 *   1. Basic JSON response shape: { text: string }
 *   2. Verbose JSON response shape: { task, language, duration, text, words?, segments? }
 *   3. OpenAI Whisper API spec (via SDK shape definitions)
 *
 * Unlike other drift tests, this endpoint uses multipart/form-data
 * (not JSON), so we use fetch() with FormData directly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { openaiTranscriptionBasicShape, openaiTranscriptionVerboseShape } from "./sdk-shapes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Basic fixture — no words/segments, so handler returns { text } */
const BASIC_FIXTURE: Fixture = {
  match: { endpoint: "transcription" },
  response: {
    transcription: {
      text: "Hello, world. This is a test transcription.",
      language: "english",
      duration: 3.5,
    },
  },
};

/** Verbose fixture — includes words and segments, so handler returns verbose shape */
const VERBOSE_FIXTURE: Fixture = {
  match: { endpoint: "transcription" },
  response: {
    transcription: {
      text: "Hello, world.",
      language: "english",
      duration: 2.1,
      words: [
        { word: "Hello,", start: 0.0, end: 0.4 },
        { word: "world.", start: 0.5, end: 1.0 },
      ],
      segments: [{ id: 0, text: "Hello, world.", start: 0.0, end: 2.1 }],
    },
  },
};

// ---------------------------------------------------------------------------
// Server lifecycle — separate instances for basic vs verbose
// ---------------------------------------------------------------------------

let basicInstance: ServerInstance;
let verboseInstance: ServerInstance;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  [basicInstance, verboseInstance] = await Promise.all([
    createServer([BASIC_FIXTURE], { port: 0 }),
    createServer([VERBOSE_FIXTURE], { port: 0 }),
  ]);
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => basicInstance.server.close(() => r())),
    new Promise<void>((r) => verboseInstance.server.close(() => r())),
  ]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * POST multipart/form-data to the transcription endpoint.
 * Uses fetch() with FormData since the Whisper API requires multipart.
 */
async function postTranscription(
  url: string,
  opts: { model?: string; responseFormat?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const formData = new FormData();
  formData.append("file", new Blob(["fake audio data"], { type: "audio/wav" }), "test.wav");
  formData.append("model", opts.model ?? "whisper-1");
  if (opts.responseFormat) {
    formData.append("response_format", opts.responseFormat);
  }

  const res = await fetch(`${url}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: "Bearer test-key" },
    body: formData,
  });

  const text = await res.text();
  return {
    status: res.status,
    body: JSON.parse(text),
  };
}

// ---------------------------------------------------------------------------
// Tests — mock-only (always run)
// ---------------------------------------------------------------------------

describe("Transcription API shape validation", () => {
  it("basic response shape: { text: string }", async () => {
    const sdkShape = openaiTranscriptionBasicShape();
    const mockRes = await postTranscription(basicInstance.url);

    expect(mockRes.status).toBe(200);

    const mockShape = extractShape(mockRes.body);
    // Two-way comparison: SDK vs mock (no real API call needed)
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Transcription basic JSON", diffs, "transcription");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("verbose response shape: { task, language, duration, text, words, segments }", async () => {
    const sdkShape = openaiTranscriptionVerboseShape();
    const mockRes = await postTranscription(verboseInstance.url, {
      model: "whisper-1",
      responseFormat: "verbose_json",
    });

    expect(mockRes.status).toBe(200);

    const body = mockRes.body as Record<string, unknown>;
    // Verify required verbose fields exist
    expect(body).toHaveProperty("task");
    expect(body).toHaveProperty("language");
    expect(body).toHaveProperty("duration");
    expect(body).toHaveProperty("text");
    expect(body).toHaveProperty("words");
    expect(body).toHaveProperty("segments");

    const mockShape = extractShape(body);
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Transcription verbose JSON", diffs, "transcription");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("verbose response field types match Whisper spec", async () => {
    const mockRes = await postTranscription(verboseInstance.url, {
      model: "whisper-1",
      responseFormat: "verbose_json",
    });

    const body = mockRes.body as Record<string, unknown>;

    // task is always "transcribe" for transcriptions
    expect(body.task).toBe("transcribe");
    // language is a string
    expect(typeof body.language).toBe("string");
    // duration is a number (seconds)
    expect(typeof body.duration).toBe("number");
    // text is a string
    expect(typeof body.text).toBe("string");

    // words array — each entry has { word, start, end }
    const words = body.words as Array<Record<string, unknown>>;
    expect(Array.isArray(words)).toBe(true);
    if (words.length > 0) {
      const w = words[0];
      expect(typeof w.word).toBe("string");
      expect(typeof w.start).toBe("number");
      expect(typeof w.end).toBe("number");
    }

    // segments array — each entry has { id, text, start, end }
    const segments = body.segments as Array<Record<string, unknown>>;
    expect(Array.isArray(segments)).toBe(true);
    if (segments.length > 0) {
      const s = segments[0];
      expect(typeof s.id).toBe("number");
      expect(typeof s.text).toBe("string");
      expect(typeof s.start).toBe("number");
      expect(typeof s.end).toBe("number");
    }
  });

  it("basic response excludes verbose-only fields", async () => {
    const mockRes = await postTranscription(basicInstance.url);

    expect(mockRes.status).toBe(200);

    const body = mockRes.body as Record<string, unknown>;
    // Basic format only has { text }
    expect(body).toHaveProperty("text");
    expect(typeof body.text).toBe("string");
    // Should NOT have verbose-only fields
    expect(body).not.toHaveProperty("task");
    expect(body).not.toHaveProperty("language");
    expect(body).not.toHaveProperty("duration");
    expect(body).not.toHaveProperty("words");
    expect(body).not.toHaveProperty("segments");
  });
});

// ---------------------------------------------------------------------------
// Tests — three-way with real API (skipped without key)
// ---------------------------------------------------------------------------

describe.skipIf(!OPENAI_API_KEY)("Transcription drift (three-way)", () => {
  /**
   * Call the real OpenAI Whisper API with a minimal audio file.
   * We send a tiny WAV header — enough for OpenAI to parse and return
   * an error-free (possibly empty) transcription.
   */
  async function realTranscription(
    responseFormat?: string,
  ): Promise<{ status: number; body: unknown }> {
    // Minimal valid WAV: 44-byte header + 0 audio samples
    const wavHeader = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x24,
      0x00,
      0x00,
      0x00, // chunk size (36 bytes)
      0x57,
      0x41,
      0x56,
      0x45, // "WAVE"
      0x66,
      0x6d,
      0x74,
      0x20, // "fmt "
      0x10,
      0x00,
      0x00,
      0x00, // subchunk1 size (16)
      0x01,
      0x00, // audio format (PCM = 1)
      0x01,
      0x00, // num channels (1)
      0x80,
      0x3e,
      0x00,
      0x00, // sample rate (16000)
      0x00,
      0x7d,
      0x00,
      0x00, // byte rate (32000)
      0x02,
      0x00, // block align (2)
      0x10,
      0x00, // bits per sample (16)
      0x64,
      0x61,
      0x74,
      0x61, // "data"
      0x00,
      0x00,
      0x00,
      0x00, // data size (0)
    ]);

    const formData = new FormData();
    formData.append("file", new Blob([wavHeader], { type: "audio/wav" }), "test.wav");
    formData.append("model", "whisper-1");
    if (responseFormat) {
      formData.append("response_format", responseFormat);
    }

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });

    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) };
  }

  it("basic response shape matches real API", async () => {
    const sdkShape = openaiTranscriptionBasicShape();

    const [realRes, mockRes] = await Promise.all([
      realTranscription(),
      postTranscription(basicInstance.url),
    ]);

    // Real API may return an error for empty audio — only compare shapes on 200
    if (realRes.status === 200) {
      const realShape = extractShape(realRes.body);
      const mockShape = extractShape(mockRes.body);

      const diffs = triangulate(sdkShape, realShape, mockShape);
      const report = formatDriftReport("Transcription basic (three-way)", diffs, "transcription");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });

  it("verbose response shape matches real API", async () => {
    const sdkShape = openaiTranscriptionVerboseShape();

    const [realRes, mockRes] = await Promise.all([
      realTranscription("verbose_json"),
      postTranscription(verboseInstance.url, {
        model: "whisper-1",
        responseFormat: "verbose_json",
      }),
    ]);

    if (realRes.status === 200) {
      const realShape = extractShape(realRes.body);
      const mockShape = extractShape(mockRes.body);

      const diffs = triangulate(sdkShape, realShape, mockShape);
      const report = formatDriftReport("Transcription verbose (three-way)", diffs, "transcription");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });
});
