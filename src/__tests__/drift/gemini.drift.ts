/**
 * Google Gemini GenerateContent API drift tests.
 *
 * Three-way comparison: SDK types × real API × llmock output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport, shouldFail } from "./schema.js";
import {
  geminiContentResponseShape,
  geminiToolCallResponseShape,
  geminiStreamChunkShape,
  geminiStreamLastChunkShape,
} from "./sdk-shapes.js";
import { geminiNonStreaming, geminiStreaming } from "./providers.js";
import { httpPost, parseDataOnlySSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!GOOGLE_API_KEY)("Google Gemini drift", () => {
  const config = { apiKey: GOOGLE_API_KEY! };

  it("non-streaming text shape matches", async () => {
    const sdkShape = geminiContentResponseShape();

    const [realRes, mockRes] = await Promise.all([
      geminiNonStreaming(config, [{ role: "user", parts: [{ text: "Say hello" }] }]),
      httpPost(`${instance.url}/v1beta/models/gemini-2.5-flash:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Gemini (non-streaming text)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming text shape matches", async () => {
    const sdkChunkShape = geminiStreamChunkShape();
    const sdkLastShape = geminiStreamLastChunkShape();

    const [realStream, mockStreamRes] = await Promise.all([
      geminiStreaming(config, [{ role: "user", parts: [{ text: "Say hello" }] }]),
      httpPost(`${instance.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
        contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
      }),
    ]);

    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    // Compare intermediate chunks (if multiple exist)
    if (realStream.rawEvents.length > 1 && mockChunks.length > 1) {
      const realChunkShape = extractShape(realStream.rawEvents[0].data);
      const mockChunkShape = extractShape(mockChunks[0]);

      const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
      const report = formatDriftReport("Gemini (streaming intermediate chunk)", diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
    }

    // Compare last chunk
    const realLastShape = extractShape(realStream.rawEvents[realStream.rawEvents.length - 1].data);
    const mockLastShape = extractShape(mockChunks[mockChunks.length - 1]);

    const lastDiffs = triangulate(sdkLastShape, realLastShape, mockLastShape);
    const lastReport = formatDriftReport("Gemini (streaming last chunk)", lastDiffs);

    if (shouldFail(lastDiffs)) {
      expect.soft([], lastReport).toEqual(lastDiffs.filter((d) => d.severity === "critical"));
    }
  });

  it("non-streaming tool call shape matches", async () => {
    const sdkShape = geminiToolCallResponseShape();

    const tools = [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "OBJECT",
              properties: {
                city: { type: "STRING" },
              },
              required: ["city"],
            },
          },
        ],
      },
    ];

    const [realRes, mockRes] = await Promise.all([
      geminiNonStreaming(config, [{ role: "user", parts: [{ text: "Weather in Paris" }] }], tools),
      httpPost(`${instance.url}/v1beta/models/gemini-2.5-flash:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "Weather in Paris" }] }],
        tools,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Gemini (non-streaming tool call)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming tool call shape matches", async () => {
    const sdkLastShape = geminiStreamLastChunkShape();

    const tools = [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "OBJECT",
              properties: {
                city: { type: "STRING" },
              },
              required: ["city"],
            },
          },
        ],
      },
    ];

    const [realStream, mockStreamRes] = await Promise.all([
      geminiStreaming(config, [{ role: "user", parts: [{ text: "Weather in Paris" }] }], tools),
      httpPost(`${instance.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
        contents: [{ role: "user", parts: [{ text: "Weather in Paris" }] }],
        tools,
      }),
    ]);

    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    const realLastShape = extractShape(realStream.rawEvents[realStream.rawEvents.length - 1].data);
    const mockLastShape = extractShape(mockChunks[mockChunks.length - 1]);

    const diffs = triangulate(sdkLastShape, realLastShape, mockLastShape);
    const report = formatDriftReport("Gemini (streaming tool call)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });
});
