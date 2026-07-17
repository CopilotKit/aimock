/**
 * Google Gemini Interactions API drift tests.
 *
 * Three-way comparison: SDK types x real API x aimock output.
 *
 * The Interactions API is in Beta — shapes may shift as Google
 * iterates on the endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, compareSSESequences, formatDriftReport } from "./schema.js";
import {
  geminiInteractionsResponseShape,
  geminiInteractionsToolCallResponseShape,
  geminiInteractionsStreamEventShapes,
  geminiInteractionsToolCallStreamEventShapes,
} from "./sdk-shapes.js";
import {
  geminiInteractionsNonStreaming,
  geminiInteractionsNonStreamingSteps,
  geminiInteractionsStreaming,
} from "./providers.js";
import { httpPost, parseInteractionsSSE, startDriftServer, stopDriftServer } from "./helpers.js";

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

describe.skipIf(!GOOGLE_API_KEY)("Gemini Interactions API drift", () => {
  const config = { apiKey: GOOGLE_API_KEY! };

  it("non-streaming text shape matches", async () => {
    const sdkShape = geminiInteractionsResponseShape();

    let realRes;
    try {
      realRes = await geminiInteractionsNonStreaming(config, "Say hello");
    } catch (err) {
      console.warn(
        "Gemini Interactions API unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    if (
      !realRes.body ||
      (typeof realRes.body === "object" && Object.keys(realRes.body).length === 0)
    ) {
      console.warn("Gemini Interactions non-streaming API returned empty body — skipping");
      return;
    }

    const mockRes = await httpPost(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "Say hello",
      stream: false,
    });

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport(
      "Gemini Interactions (non-streaming text)",
      diffs,
      "gemini-interactions",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("non-streaming text shape matches (Step[] input)", async () => {
    const sdkShape = geminiInteractionsResponseShape();

    let realRes;
    try {
      realRes = await geminiInteractionsNonStreamingSteps(config, "Say hello");
    } catch (err) {
      console.warn(
        "Gemini Interactions API unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    if (
      !realRes.body ||
      (typeof realRes.body === "object" && Object.keys(realRes.body).length === 0)
    ) {
      console.warn("Gemini Interactions non-streaming API returned empty body — skipping");
      return;
    }

    const mockRes = await httpPost(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: [{ type: "user_input", content: [{ type: "text", text: "Say hello" }] }],
      stream: false,
    });

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport(
      "Gemini Interactions (non-streaming text, Step[] input)",
      diffs,
      "gemini-interactions",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming text event sequence and shapes match", async () => {
    const sdkEvents = geminiInteractionsStreamEventShapes();

    let realStream;
    try {
      realStream = await geminiInteractionsStreaming(config, "Say hello");
    } catch (err) {
      console.warn(
        "Gemini Interactions API unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    if (realStream.rawEvents.length === 0) {
      console.warn("Gemini Interactions streaming API returned 200 but no SSE events — skipping");
      return;
    }

    const mockStreamRes = await httpPost(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "Say hello",
      stream: true,
    });

    const mockEvents = parseInteractionsSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.event_type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realStream.events, mockSSEShapes);
    const report = formatDriftReport(
      "Gemini Interactions (streaming text events)",
      diffs,
      "gemini-interactions",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("non-streaming tool call shape matches", async () => {
    const sdkShape = geminiInteractionsToolCallResponseShape();

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

    let realRes;
    try {
      realRes = await geminiInteractionsNonStreaming(config, "Weather in Paris", tools);
    } catch (err) {
      console.warn(
        "Gemini Interactions API unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    if (
      !realRes.body ||
      (typeof realRes.body === "object" && Object.keys(realRes.body).length === 0)
    ) {
      console.warn(
        "Gemini Interactions non-streaming tool call API returned empty body — skipping",
      );
      return;
    }

    const mockRes = await httpPost(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "Weather in Paris",
      stream: false,
      tools,
    });

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport(
      "Gemini Interactions (non-streaming tool call)",
      diffs,
      "gemini-interactions",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming tool call event sequence matches", async () => {
    const sdkEvents = geminiInteractionsToolCallStreamEventShapes();

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

    let realStream;
    try {
      realStream = await geminiInteractionsStreaming(config, "Weather in Paris", tools);
    } catch (err) {
      console.warn(
        "Gemini Interactions API unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    if (realStream.rawEvents.length === 0) {
      console.warn(
        "Gemini Interactions streaming tool call API returned 200 but no SSE events — skipping",
      );
      return;
    }

    const mockStreamRes = await httpPost(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "Weather in Paris",
      stream: true,
      tools,
    });

    const mockEvents = parseInteractionsSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.event_type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realStream.events, mockSSEShapes);
    const report = formatDriftReport(
      "Gemini Interactions (streaming tool call events)",
      diffs,
      "gemini-interactions",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});
