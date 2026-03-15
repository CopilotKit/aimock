/**
 * OpenAI Responses API drift tests.
 *
 * Three-way comparison: SDK types × real API × llmock output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import {
  extractShape,
  triangulate,
  compareSSESequences,
  formatDriftReport,
  shouldFail,
} from "./schema.js";
import {
  openaiResponsesNonStreamingShape,
  openaiResponsesTextEventShapes,
  openaiResponsesToolCallEventShapes,
} from "./sdk-shapes.js";
import { openaiResponsesNonStreaming, openaiResponsesStreaming } from "./providers.js";
import { httpPost, parseTypedSSE, startDriftServer, stopDriftServer } from "./helpers.js";

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

describe.skipIf(!OPENAI_API_KEY)("OpenAI Responses API drift", () => {
  const config = { apiKey: OPENAI_API_KEY! };

  it("non-streaming text shape matches", async () => {
    const sdkShape = openaiResponsesNonStreamingShape();

    const [realRes, mockRes] = await Promise.all([
      openaiResponsesNonStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/responses`, {
        model: "gpt-4o-mini",
        input: [{ role: "user", content: "Say hello" }],
        stream: false,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Responses (non-streaming text)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming text event sequence and shapes match", async () => {
    const sdkEvents = openaiResponsesTextEventShapes();

    const [realStream, mockStreamRes] = await Promise.all([
      openaiResponsesStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/responses`, {
        model: "gpt-4o-mini",
        input: [{ role: "user", content: "Say hello" }],
        stream: true,
      }),
    ]);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realStream.events, mockSSEShapes);
    const report = formatDriftReport("OpenAI Responses (streaming text events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("non-streaming tool call shape matches", async () => {
    const sdkShape = openaiResponsesNonStreamingShape();

    const tools = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const [realRes, mockRes] = await Promise.all([
      openaiResponsesNonStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/responses`, {
        model: "gpt-4o-mini",
        input: [{ role: "user", content: "Weather in Paris" }],
        stream: false,
        tools,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Responses (non-streaming tool call)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming tool call event sequence matches", async () => {
    const sdkEvents = [
      ...openaiResponsesTextEventShapes().filter(
        (e) => e.type === "response.created" || e.type === "response.completed",
      ),
      ...openaiResponsesToolCallEventShapes(),
    ];

    const tools = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const [realStream, mockStreamRes] = await Promise.all([
      openaiResponsesStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/responses`, {
        model: "gpt-4o-mini",
        input: [{ role: "user", content: "Weather in Paris" }],
        stream: true,
        tools,
      }),
    ]);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realStream.events, mockSSEShapes);
    const report = formatDriftReport("OpenAI Responses (streaming tool call events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });
});
