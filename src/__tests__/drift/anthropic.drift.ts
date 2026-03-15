/**
 * Anthropic Claude Messages API drift tests.
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
  anthropicMessageShape,
  anthropicMessageToolCallShape,
  anthropicStreamEventShapes,
  anthropicToolStreamEventShapes,
} from "./sdk-shapes.js";
import { anthropicNonStreaming, anthropicStreaming } from "./providers.js";
import { httpPost, parseTypedSSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!ANTHROPIC_API_KEY)("Anthropic Claude Messages drift", () => {
  const config = { apiKey: ANTHROPIC_API_KEY! };

  it("non-streaming text shape matches", async () => {
    const sdkShape = anthropicMessageShape();

    const [realRes, mockRes] = await Promise.all([
      anthropicNonStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/messages`, {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say hello" }],
        stream: false,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Anthropic Claude (non-streaming text)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming text event sequence and shapes match", async () => {
    const sdkEvents = anthropicStreamEventShapes();

    const [realStream, mockStreamRes] = await Promise.all([
      anthropicStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/messages`, {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say hello" }],
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
    const report = formatDriftReport("Anthropic Claude (streaming text events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("non-streaming tool call shape matches", async () => {
    const sdkShape = anthropicMessageToolCallShape();

    const tools = [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const [realRes, mockRes] = await Promise.all([
      anthropicNonStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/messages`, {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        messages: [{ role: "user", content: "Weather in Paris" }],
        stream: false,
        tools,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Anthropic Claude (non-streaming tool call)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming tool call event sequence matches", async () => {
    const sdkEvents = [
      ...anthropicStreamEventShapes().filter(
        (e) =>
          e.type === "message_start" || e.type === "message_delta" || e.type === "message_stop",
      ),
      ...anthropicToolStreamEventShapes(),
    ];

    const tools = [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const [realStream, mockStreamRes] = await Promise.all([
      anthropicStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/messages`, {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        messages: [{ role: "user", content: "Weather in Paris" }],
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
    const report = formatDriftReport("Anthropic Claude (streaming tool call events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });
});
