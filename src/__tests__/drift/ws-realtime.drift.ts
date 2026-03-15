/**
 * OpenAI Realtime API WebSocket drift tests.
 *
 * Three-way comparison: SDK types x real API (WS) x llmock output (WS).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, compareSSESequences, formatDriftReport, shouldFail } from "./schema.js";
import { openaiRealtimeTextEventShapes, openaiRealtimeToolCallEventShapes } from "./sdk-shapes.js";
import { openaiRealtimeWS } from "./ws-providers.js";
import { listOpenAIModels } from "./providers.js";
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

const REALTIME_MODEL = "gpt-4o-mini-realtime-preview";

describe.skipIf(!OPENAI_API_KEY)("OpenAI Realtime API drift", () => {
  const config = { apiKey: OPENAI_API_KEY! };

  it("canary: realtime preview model still available", async () => {
    const models = await listOpenAIModels(config.apiKey);
    const found = models.some((m) => m === REALTIME_MODEL || m.startsWith(`${REALTIME_MODEL}-`));
    if (!found) {
      // Check if a GA model replaced it
      const ga = models.find((m) => m === "gpt-4o-mini-realtime" || m === "gpt-realtime-mini");
      const hint = ga ? ` Found GA model "${ga}" — update REALTIME_MODEL.` : "";
      expect.fail(
        `Realtime model "${REALTIME_MODEL}" no longer in model listing.${hint} ` +
          `Update ws-providers.ts and this test.`,
      );
    }
  });

  it("WS text event sequence and shapes match", async () => {
    const sdkEvents = openaiRealtimeTextEventShapes();

    // Real API
    const realResult = await openaiRealtimeWS(config, "Say hello");

    // Mock — replicate the Realtime protocol sequence
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
    const report = formatDriftReport("OpenAI Realtime WS (text events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("WS tool call event sequence matches", async () => {
    const sdkEvents = [
      ...openaiRealtimeTextEventShapes().filter(
        (e) =>
          e.type === "session.created" ||
          e.type === "session.updated" ||
          e.type === "conversation.item.created" ||
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

    // Real API
    const realResult = await openaiRealtimeWS(config, "Weather in Paris", tools);

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
    const report = formatDriftReport("OpenAI Realtime WS (tool call events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });
});
