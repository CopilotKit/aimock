/**
 * OpenAI Realtime API WebSocket drift tests.
 *
 * Three-way comparison: SDK types x real API (WS) x aimock output (WS).
 * Updated for GA protocol — uses gpt-realtime-mini and GA event names.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, compareSSESequences, formatDriftReport } from "./schema.js";
import { openaiRealtimeTextEventShapes, openaiRealtimeToolCallEventShapes } from "./sdk-shapes.js";
import { openaiRealtimeWS } from "./ws-providers.js";
import { listOpenAIModels } from "./providers.js";
import { detectVoiceModelDrift } from "./voice-models.js";
import { startDriftServer, stopDriftServer, collectMockWSMessages } from "./helpers.js";
import { connectWebSocket } from "../ws-test-client.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
// The known-models canary — the entire reason this suite exists — fetches the
// model list via GET /v1/models, which returns ALL models for ANY valid OpenAI
// key regardless of realtime access. So it uses OPENAI_API_KEY (the credential
// CI actually provides to the drift job) and is gated ONLY on OPENAI_API_KEY,
// guaranteeing it runs in CI and cannot silently skip.
//
// The real realtime WS *session* tests connect a live socket that requires
// realtime model access. OpenAI Realtime authenticates with the STANDARD
// project key (scope is project-level; there is no separate "realtime key"
// type), so these probes resolve their credential as OPENAI_REALTIME_KEY (an
// optional explicit override, kept for the rare case where realtime access
// lives on a different project) ELSE the standard OPENAI_API_KEY that CI
// already provides. Preferring the explicit override but falling back to the
// standard key lets the protocol probes run LIVE in daily CI without adding a
// new secret. (If CI ever shows these probes failing with an auth/scope error,
// it means this project's OPENAI_API_KEY lacks Realtime access and a separate
// OPENAI_REALTIME_KEY genuinely is required.)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_KEY = process.env.OPENAI_REALTIME_KEY;
// Resolved realtime credential: explicit override preferred, standard key as
// fallback. Non-empty whenever the describe below runs (it gates on
// OPENAI_API_KEY), so the protocol probes RUN in CI instead of skipping.
const OPENAI_REALTIME_CREDENTIAL = OPENAI_REALTIME_KEY ?? OPENAI_API_KEY;

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
  // Session config for the real WS realtime tests: explicit OPENAI_REALTIME_KEY
  // override if set, else the standard OPENAI_API_KEY (which CI provides and
  // which authenticates Realtime at project scope). The canary below reads
  // OPENAI_API_KEY directly and does NOT use this.
  const config = { apiKey: OPENAI_REALTIME_CREDENTIAL! };

  it("canary: GA realtime models available", async () => {
    // Fetch via GET /v1/models, which lists ALL models for ANY valid key. Use
    // OPENAI_API_KEY (guaranteed present by the describe.skipIf above and the
    // credential CI provides) so the canary ALWAYS runs in CI and never skips —
    // gating this on OPENAI_REALTIME_KEY (which CI does NOT provide) would have
    // silently skipped the one check this whole suite exists to run.
    const models = await listOpenAIModels(OPENAI_API_KEY!);

    // Run the SHARED detection code path (also driven directly by the unit test
    // in ws-realtime-canary.test.ts). The voice/audio family matcher is broader
    // than the old `includes("realtime")` filter so a NEW voice family whose id
    // lacks the "realtime" substring (e.g. gpt-live-1) is still flagged.
    const { candidateModels: realtimeModels, unknown, hasGA } = detectVoiceModelDrift(models);

    // Compute the unknown-model list BEFORE the hasGA assertion. A run can be
    // BOTH GA-family-gone AND carry new unknown models; because the hasGA
    // assertion below throws first, the later unknown-models assertion would
    // never run and its list would be lost from the NO_GA failure message (and
    // therefore from the auto-fix prompt). So we carry the unknown list into the
    // NO_GA marker too — no information is lost in the combined case.
    if (unknown.length > 0) {
      console.warn(`[DRIFT] Unknown voice/audio models detected: ${unknown.join(", ")}`);
    }

    // At least one GA model should exist. Carry the OBSERVED realtime models in
    // a stable custom assertion message (symmetric to UNKNOWN_REALTIME_MODELS=
    // below) so that when the GA family is renamed/removed — or the credential
    // cannot see any realtime models — the drift collector recognizes the
    // NO_GA_REALTIME_MODELS= marker and emits a CRITICAL OpenAI-Realtime entry
    // (exit 2, auto-remediated) instead of crashing to exit 1. Without the
    // marker, "expected false to be true" is an unrecognized shape that the
    // collector would treat as unparseable and throw on.
    //
    // The message ALSO carries the unknown list after a ` | UNKNOWN_REALTIME_MODELS=`
    // segment so the combined (no-GA AND unknown-models-present) case does not
    // lose the unknown list when this assertion short-circuits the one below.
    // The collector splits the two markers apart; each list stays clean.
    expect(
      hasGA,
      `NO_GA_REALTIME_MODELS=${realtimeModels.join(",")} | UNKNOWN_REALTIME_MODELS=${unknown.join(",")}`,
    ).toBe(true);

    // Carry the FULL unknown-model list in a stable custom assertion message.
    // vitest truncates the printed array in failureMessages (`…(N)`), so the
    // drift collector cannot recover ids beyond the first from the array. The
    // custom message is emitted verbatim and is NOT truncated, so the collector
    // parses the UNKNOWN_REALTIME_MODELS= marker as its source of truth.
    expect(unknown, `UNKNOWN_REALTIME_MODELS=${unknown.join(",")}`).toEqual([]);
  });

  it.skipIf(!OPENAI_REALTIME_CREDENTIAL)(
    "WS text event sequence and shapes match (GA)",
    async () => {
      const sdkEvents = openaiRealtimeTextEventShapes();

      // Real API — GA mode (no Beta header)
      const realResult = await openaiRealtimeWS(config, "Say hello", undefined);

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
      const report = formatDriftReport(
        "OpenAI Realtime WS (GA text events)",
        diffs,
        "openai-realtime",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    },
  );

  it.skipIf(!OPENAI_REALTIME_CREDENTIAL)("WS tool call event sequence matches (GA)", async () => {
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
    const report = formatDriftReport(
      "OpenAI Realtime WS (GA tool call events)",
      diffs,
      "openai-realtime",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  // NOTE: A GA<->Beta event-sequence consistency probe used to live here. It was
  // removed because OpenAI RETIRED the Realtime Beta API — a live Beta handshake
  // now returns {"code":"beta_api_shape_disabled","message":"The Realtime Beta
  // API is no longer supported. Please use /v1/realtime for the GA API."}, which
  // quarantined the whole leg (exit 5). GA is the only live surface and the only
  // surface aimock mocks, so the drift suite probes GA exclusively.
});
