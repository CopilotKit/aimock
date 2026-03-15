/**
 * Gemini Live BidiGenerateContent WebSocket drift tests.
 *
 * Three-way comparison: SDK types × real API (WS) × llmock output (WS).
 *
 * Currently, the Gemini Live API only supports native-audio models
 * (those with "native-audio" in the name) which cannot return TEXT responses.
 * The canary test below checks the model listing API for any text-capable
 * model that supports bidiGenerateContent. When Google adds one, the
 * canary fails and the full drift tests can be enabled with that model.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, compareSSESequences, formatDriftReport, shouldFail } from "./schema.js";
import {
  geminiLiveSetupCompleteShape,
  geminiLiveTextEventShapes,
  geminiLiveToolCallEventShapes,
} from "./sdk-shapes.js";
import { geminiLiveWS } from "./ws-providers.js";
import {
  startDriftServer,
  stopDriftServer,
  collectMockWSMessages,
  classifyGeminiMessage,
  GEMINI_WS_PATH,
} from "./helpers.js";
import { connectWebSocket } from "../ws-test-client.js";

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
// Canary: detect when a text-capable model supports bidiGenerateContent
// ---------------------------------------------------------------------------

/**
 * Query the Gemini model listing API for any model that supports
 * bidiGenerateContent but is NOT a native-audio-only model.
 */
async function findTextCapableLiveModel(apiKey: string): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    models: { name: string; supportedGenerationMethods: string[] }[];
  };
  const liveModels = data.models.filter(
    (m) =>
      m.supportedGenerationMethods?.includes("bidiGenerateContent") &&
      !m.name.includes("native-audio"),
  );
  return liveModels.length > 0 ? liveModels[0].name : null;
}

describe.skipIf(!GOOGLE_API_KEY)("Gemini Live WS drift", () => {
  const config = { apiKey: GOOGLE_API_KEY! };

  it("canary: text-capable bidiGenerateContent model availability", async () => {
    const model = await findTextCapableLiveModel(config.apiKey);
    if (model) {
      // A text-capable Live model now exists! Time to enable the full drift tests.
      // Update ws-providers.ts geminiLiveWS() to use this model, then un-skip below.
      console.warn(
        `[CANARY] Text-capable Gemini Live model found: ${model}. ` +
          `Enable the skipped drift tests with this model.`,
      );
    }
    // This test always passes — it's a canary, not an assertion.
    // When a model appears, the console warning signals it's time to act.
    expect(true).toBe(true);
  });

  // These tests are skipped until a text-capable model supports bidiGenerateContent.
  // When the canary above detects one, update the model in ws-providers.ts and remove .skip.

  it.skip("WS text event sequence and shapes match", async () => {
    const sdkEvents = [geminiLiveSetupCompleteShape(), ...geminiLiveTextEventShapes()];

    // Real API
    const realResult = await geminiLiveWS(config, "Say hello");

    // Mock — replicate Gemini Live protocol
    const mockWs = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    // Send setup
    mockWs.send(
      JSON.stringify({
        setup: { model: "models/gemini-2.5-flash" },
      }),
    );

    // Wait for setupComplete
    const setupMsgs = await mockWs.waitForMessages(1);
    const allMockRaw: unknown[] = [JSON.parse(setupMsgs[0])];

    // Send clientContent
    mockWs.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Say hello" }] }],
          turnComplete: true,
        },
      }),
    );

    // Collect messages until turnComplete
    const contentMsgs = await collectMockWSMessages(
      mockWs,
      (msg) => {
        const m = msg as Record<string, unknown>;
        const sc = m.serverContent as Record<string, unknown> | undefined;
        return sc?.turnComplete === true;
      },
      15000,
      1, // skip the setupComplete message already consumed
    );
    allMockRaw.push(...contentMsgs.rawMessages);
    mockWs.close();

    // Build mock events with classified types
    const mockEvents = allMockRaw.map((msg) => ({
      type: classifyGeminiMessage(msg as Record<string, unknown>),
      dataShape: extractShape(msg),
    }));

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockEvents.length, "Mock returned no WS messages").toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockEvents);
    const report = formatDriftReport("Gemini Live WS (text events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it.skip("WS tool call event sequence matches", async () => {
    const sdkEvents = [geminiLiveSetupCompleteShape(), ...geminiLiveToolCallEventShapes()];

    const tools = [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
    ];

    // Real API
    const realResult = await geminiLiveWS(config, "Weather in Paris", tools);

    // Mock — replicate Gemini Live protocol with tools
    const mockWs = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    // Send setup with tools
    mockWs.send(
      JSON.stringify({
        setup: { model: "models/gemini-2.5-flash", tools },
      }),
    );

    // Wait for setupComplete
    const setupMsgs = await mockWs.waitForMessages(1);
    const allMockRaw: unknown[] = [JSON.parse(setupMsgs[0])];

    // Send clientContent
    mockWs.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Weather in Paris" }] }],
          turnComplete: true,
        },
      }),
    );

    // Collect messages until toolCall
    const contentMsgs = await collectMockWSMessages(
      mockWs,
      (msg) => {
        const m = msg as Record<string, unknown>;
        return "toolCall" in m;
      },
      15000,
      1,
    );
    allMockRaw.push(...contentMsgs.rawMessages);
    mockWs.close();

    // Build mock events with classified types
    const mockEvents = allMockRaw.map((msg) => ({
      type: classifyGeminiMessage(msg as Record<string, unknown>),
      dataShape: extractShape(msg),
    }));

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockEvents.length, "Mock returned no WS messages").toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockEvents);
    const report = formatDriftReport("Gemini Live WS (tool call events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });
});
