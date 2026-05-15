/**
 * OpenAI Realtime API WebSocket drift tests.
 *
 * Three-way comparison: SDK types x real API (WS) x aimock output (WS).
 * Updated for GA protocol — uses gpt-realtime-2 and GA event names.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, compareSSESequences, formatDriftReport } from "./schema.js";
import { openaiRealtimeTextEventShapes, openaiRealtimeToolCallEventShapes } from "./sdk-shapes.js";
import { openaiRealtimeWS } from "./ws-providers.js";
import { listOpenAIModels } from "./providers.js";
import { startDriftServer, stopDriftServer, collectMockWSMessages } from "./helpers.js";
import { connectWebSocket } from "../ws-test-client.js";

// ---------------------------------------------------------------------------
// GA <-> Beta event name mapping (local copy for normalization in tests)
// ---------------------------------------------------------------------------

const GA_TO_BETA_EVENT: Record<string, string> = {
  "response.output_text.delta": "response.text.delta",
  "response.output_text.done": "response.text.done",
  "response.output_audio.delta": "response.audio.delta",
  "response.output_audio.done": "response.audio.done",
  "response.output_audio_transcript.delta": "response.audio_transcript.delta",
  "response.output_audio_transcript.done": "response.audio_transcript.done",
  "conversation.item.added": "conversation.item.created",
};

const BETA_SUPPRESSED_EVENTS = new Set(["conversation.item.done"]);

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

describe.skipIf(!OPENAI_API_KEY)("OpenAI Realtime API drift", () => {
  const config = { apiKey: OPENAI_API_KEY! };

  it("canary: GA realtime models available", async () => {
    const models = await listOpenAIModels(config.apiKey);

    const gaModels = [
      "gpt-realtime",
      "gpt-realtime-2",
      "gpt-realtime-2025-08-28",
      "gpt-realtime-1.5",
      "gpt-realtime-mini",
      "gpt-realtime-mini-2025-10-06",
      "gpt-realtime-mini-2025-12-15",
    ];
    const knownModels = new Set([
      ...gaModels,
      // Translate/whisper models (also contain "realtime" in some variants)
      "gpt-realtime-translate",
      "gpt-realtime-whisper",
      // Audio models also valid in realtime sessions
      "gpt-audio-1.5",
      "gpt-audio-mini",
      "gpt-audio-mini-2025-10-06",
      "gpt-audio-mini-2025-12-15",
      // Transcription/translation models
      "gpt-4o-transcribe",
      "gpt-4o-mini-transcribe",
      "whisper-1",
      // Legacy preview models (may still appear)
      "gpt-4o-realtime-preview",
      "gpt-4o-mini-realtime-preview",
      "gpt-4o-realtime-preview-2024-10-01",
      "gpt-4o-realtime-preview-2024-12-17",
      "gpt-4o-realtime-preview-2025-06-03",
      "gpt-4o-mini-realtime-preview-2024-12-17",
    ]);

    const realtimeModels = models.filter((m) => m.includes("realtime"));

    // At least one GA model should exist
    const hasGA = realtimeModels.some((m) => gaModels.includes(m));
    expect(hasGA).toBe(true);

    // Flag unknown realtime models
    const unknown = realtimeModels.filter((m) => !knownModels.has(m));
    if (unknown.length > 0) {
      console.warn(`[DRIFT] Unknown realtime models detected: ${unknown.join(", ")}`);
    }
    expect(unknown).toEqual([]);
  });

  it.skipIf(!process.env.OPENAI_REALTIME_KEY)(
    "WS text event sequence and shapes match (GA)",
    async () => {
      const sdkEvents = openaiRealtimeTextEventShapes();

      // Real API — GA mode (no Beta header)
      const realResult = await openaiRealtimeWS(config, "Say hello", undefined, false);

      // Mock — replicate the Realtime protocol sequence (GA mode)
      const mockWs = await connectWebSocket(instance.url, "/v1/realtime");

      // session.created is sent automatically on connect
      const sessionCreatedMsgs = await mockWs.waitForMessages(1);
      const allMockRaw: unknown[] = [JSON.parse(sessionCreatedMsgs[0])];

      // session.update
      mockWs.send(
        JSON.stringify({
          type: "session.update",
          session: { model: "gpt-4o-mini", modalities: ["text"] },
        }),
      );
      const sessionUpdatedMsgs = await mockWs.waitForMessages(2);
      allMockRaw.push(JSON.parse(sessionUpdatedMsgs[1]));

      // conversation.item.create
      mockWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Say hello" }],
          },
        }),
      );
      const itemCreatedMsgs = await mockWs.waitForMessages(3);
      allMockRaw.push(JSON.parse(itemCreatedMsgs[2]));

      // response.create — triggers the response
      mockWs.send(JSON.stringify({ type: "response.create" }));

      // Collect remaining messages until response.done
      const responseMsgs = await collectMockWSMessages(
        mockWs,
        (msg) => (msg as Record<string, unknown>).type === "response.done",
        15000,
        3, // skip the 3 messages already consumed
      );
      allMockRaw.push(...responseMsgs.rawMessages);
      mockWs.close();

      // Build mock events from all collected messages
      const mockEvents = allMockRaw.map((msg) => {
        const m = msg as Record<string, unknown>;
        return {
          type: m.type as string,
          dataShape: extractShape(msg),
        };
      });

      expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
      expect(mockEvents.length, "Mock returned no WS messages").toBeGreaterThan(0);

      const diffs = compareSSESequences(sdkEvents, realResult.events, mockEvents);
      const report = formatDriftReport("OpenAI Realtime WS (GA text events)", diffs);

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    },
  );

  it.skipIf(!process.env.OPENAI_REALTIME_KEY)(
    "WS tool call event sequence matches (GA)",
    async () => {
      const sdkEvents = [
        ...openaiRealtimeTextEventShapes().filter(
          (e) =>
            e.type === "session.created" ||
            e.type === "session.updated" ||
            e.type === "conversation.item.added" ||
            e.type === "response.created" ||
            e.type === "response.done",
        ),
        ...openaiRealtimeToolCallEventShapes(),
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

      // Real API — GA mode
      const realResult = await openaiRealtimeWS(config, "Weather in Paris", tools, false);

      // Mock — replicate the Realtime protocol sequence
      const mockWs = await connectWebSocket(instance.url, "/v1/realtime");

      // session.created
      const sessionCreatedMsgs = await mockWs.waitForMessages(1);
      const allMockRaw: unknown[] = [JSON.parse(sessionCreatedMsgs[0])];

      // session.update with tools
      mockWs.send(
        JSON.stringify({
          type: "session.update",
          session: { model: "gpt-4o-mini", modalities: ["text"], tools },
        }),
      );
      const sessionUpdatedMsgs = await mockWs.waitForMessages(2);
      allMockRaw.push(JSON.parse(sessionUpdatedMsgs[1]));

      // conversation.item.create
      mockWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Weather in Paris" }],
          },
        }),
      );
      const itemCreatedMsgs = await mockWs.waitForMessages(3);
      allMockRaw.push(JSON.parse(itemCreatedMsgs[2]));

      // response.create
      mockWs.send(JSON.stringify({ type: "response.create" }));

      // Collect remaining messages until response.done
      const responseMsgs = await collectMockWSMessages(
        mockWs,
        (msg) => (msg as Record<string, unknown>).type === "response.done",
        15000,
        3,
      );
      allMockRaw.push(...responseMsgs.rawMessages);
      mockWs.close();

      // Build mock events
      const mockEvents = allMockRaw.map((msg) => {
        const m = msg as Record<string, unknown>;
        return {
          type: m.type as string,
          dataShape: extractShape(msg),
        };
      });

      expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
      expect(mockEvents.length, "Mock returned no WS messages").toBeGreaterThan(0);

      const diffs = compareSSESequences(sdkEvents, realResult.events, mockEvents);
      const report = formatDriftReport("OpenAI Realtime WS (GA tool call events)", diffs);

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    },
  );

  it.skipIf(!process.env.OPENAI_REALTIME_KEY)(
    "GA and Beta event sequences are consistent after normalization",
    async () => {
      // GA connection (no Beta header)
      const gaResult = await openaiRealtimeWS(config, "Say hello in one word.", undefined, false);

      // Beta connection
      const betaResult = await openaiRealtimeWS(config, "Say hello in one word.", undefined, true);

      // Normalize GA events to Beta names for comparison
      const gaToComparable = (type: string) => GA_TO_BETA_EVENT[type] ?? type;

      const gaTypes = gaResult.events
        .map((e) => e.type)
        .filter((t) => !BETA_SUPPRESSED_EVENTS.has(t))
        .map(gaToComparable);
      const betaTypes = betaResult.events.map((e) => e.type);

      // Deduplicate consecutive repeated types so that differences in delta
      // count (non-deterministic LLM output length) don't cause false failures.
      function dedupeConsecutive(types: string[]): string[] {
        return types.filter((t, i) => i === 0 || t !== types[i - 1]);
      }
      expect(dedupeConsecutive(gaTypes)).toEqual(dedupeConsecutive(betaTypes));
    },
  );
});
