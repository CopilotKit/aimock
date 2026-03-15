/**
 * OpenAI Responses API WebSocket drift tests.
 *
 * Three-way comparison: SDK types × real API (WS) × llmock output (WS).
 * The Responses WS protocol uses the same event shapes as HTTP SSE.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { compareSSESequences, formatDriftReport, shouldFail } from "./schema.js";
import {
  openaiResponsesTextEventShapes,
  openaiResponsesToolCallEventShapes,
} from "./sdk-shapes.js";
import { openaiResponsesWS } from "./ws-providers.js";
import { startDriftServer, stopDriftServer, collectMockWSMessages } from "./helpers.js";
import { connectWebSocket } from "../ws-test-client.js";

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

describe.skipIf(!OPENAI_API_KEY)("OpenAI Responses WS drift", () => {
  const config = { apiKey: OPENAI_API_KEY! };

  it("WS text event sequence and shapes match", async () => {
    const sdkEvents = openaiResponsesTextEventShapes();

    // Real API via WS
    const realResult = await openaiResponsesWS(config, [{ role: "user", content: "Say hello" }]);

    // Mock via WS — uses flat format matching real API
    const mockWs = await connectWebSocket(instance.url, "/v1/responses");
    mockWs.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-4o-mini",
        input: [{ role: "user", content: "Say hello" }],
      }),
    );
    const mockResult = await collectMockWSMessages(mockWs, (msg) => {
      const m = msg as Record<string, unknown>;
      return m.type === "response.completed" || m.type === "response.done";
    });
    mockWs.close();

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockResult.events.length, "Mock returned no WS messages").toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockResult.events);
    const report = formatDriftReport("OpenAI Responses WS (text events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("WS tool call event sequence matches", async () => {
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

    // Real API via WS
    const realResult = await openaiResponsesWS(
      config,
      [{ role: "user", content: "Weather in Paris" }],
      tools,
    );

    // Mock via WS — uses flat format matching real API
    const mockWs = await connectWebSocket(instance.url, "/v1/responses");
    mockWs.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-4o-mini",
        input: [{ role: "user", content: "Weather in Paris" }],
        tools,
      }),
    );
    const mockResult = await collectMockWSMessages(mockWs, (msg) => {
      const m = msg as Record<string, unknown>;
      return m.type === "response.completed" || m.type === "response.done";
    });
    mockWs.close();

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockResult.events.length, "Mock returned no WS messages").toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockResult.events);
    const report = formatDriftReport("OpenAI Responses WS (tool call events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });
});
