/**
 * OpenAI Chat Completions API drift tests.
 *
 * Three-way comparison: SDK types × real API × llmock output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport, shouldFail } from "./schema.js";
import {
  openaiChatCompletionShape,
  openaiChatCompletionToolCallShape,
  openaiChatCompletionChunkShape,
} from "./sdk-shapes.js";
import { openaiChatNonStreaming, openaiChatStreaming } from "./providers.js";
import { httpPost, parseDataOnlySSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!OPENAI_API_KEY)("OpenAI Chat Completions drift", () => {
  const config = { apiKey: OPENAI_API_KEY! };

  it("non-streaming text shape matches", async () => {
    const sdkShape = openaiChatCompletionShape();

    const [realRes, mockRes] = await Promise.all([
      openaiChatNonStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello" }],
        stream: false,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Chat (non-streaming text)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming text shape matches", async () => {
    const sdkChunkShape = openaiChatCompletionChunkShape();

    const [realStream, mockStreamRes] = await Promise.all([
      openaiChatStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello" }],
        stream: true,
      }),
    ]);

    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    const realChunkShape = extractShape(realStream.rawEvents[0].data);
    const mockChunkShape = extractShape(mockChunks[0]);

    const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
    const report = formatDriftReport("OpenAI Chat (streaming text chunks)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("non-streaming tool call shape matches", async () => {
    const sdkShape = openaiChatCompletionToolCallShape();

    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];

    const [realRes, mockRes] = await Promise.all([
      openaiChatNonStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Weather in Paris" }],
        stream: false,
        tools,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Chat (non-streaming tool call)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming tool call shape matches", async () => {
    const sdkChunkShape = openaiChatCompletionChunkShape();

    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];

    const [realStream, mockStreamRes] = await Promise.all([
      openaiChatStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Weather in Paris" }],
        stream: true,
        tools,
      }),
    ]);

    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    const realChunkShape = extractShape(realStream.rawEvents[0].data);
    const mockChunkShape = extractShape(mockChunks[0]);

    const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
    const report = formatDriftReport("OpenAI Chat (streaming tool call chunks)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });
});
