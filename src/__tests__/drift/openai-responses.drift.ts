/**
 * OpenAI Responses API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, compareSSESequences, formatDriftReport } from "./schema.js";
import {
  openaiResponsesNonStreamingShape,
  openaiResponsesTextEventShapes,
  openaiResponsesToolCallEventShapes,
  openaiResponsesReasoningEventShapes,
} from "./sdk-shapes.js";
import { openaiResponsesNonStreaming, openaiResponsesStreaming } from "./providers.js";
import {
  httpPost,
  httpPostRaw,
  parseTypedSSE,
  startDriftServer,
  stopDriftServer,
} from "./helpers.js";

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

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
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

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
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

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
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

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error shape validation (mock-only — no real API key needed)
// ---------------------------------------------------------------------------

/**
 * Expected error shape per OpenAI Responses API spec.
 * Ref: https://platform.openai.com/docs/api-reference/responses
 *
 * Real OpenAI errors include { error: { message, type, param, code } }.
 * aimock omits `param` (nullable in the spec) but must emit message, type, code.
 */
function openaiResponsesErrorShape() {
  return extractShape({
    error: {
      message: "Some error",
      type: "invalid_request_error",
      code: "some_code",
    },
  });
}

describe("OpenAI Responses API error shapes", () => {
  it("error fixture response has correct error shape", async () => {
    const errorFixture: Fixture = {
      match: { userMessage: "trigger error" },
      response: {
        error: {
          message: "Rate limited",
          type: "rate_limit_error",
          code: "rate_limit",
        },
        status: 429,
      },
    };

    const errorInstance = await createServer([errorFixture], {
      port: 0,
      chunkSize: 100,
    });

    try {
      const res = await httpPost(`${errorInstance.url}/v1/responses`, {
        model: "gpt-4o-mini",
        input: [{ role: "user", content: "trigger error" }],
        stream: false,
      });

      expect(res.status).toBe(429);

      const body = JSON.parse(res.body);
      const sdkShape = openaiResponsesErrorShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("OpenAI Responses (error fixture shape)", diffs);

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);

      // Verify concrete values
      expect(body.error.message).toBe("Rate limited");
      expect(body.error.type).toBe("rate_limit_error");
      expect(body.error.code).toBe("rate_limit");
    } finally {
      await new Promise<void>((r) => errorInstance.server.close(() => r()));
    }
  });

  it("no-fixture-match error has correct error shape", async () => {
    const res = await httpPost(`${instance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "this will not match any fixture" }],
      stream: false,
    });

    expect(res.status).toBe(404);

    const body = JSON.parse(res.body);
    const sdkShape = openaiResponsesErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenAI Responses (no-fixture-match error shape)", diffs);

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    // Verify concrete values
    expect(body.error.message).toBe("No fixture matched");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("no_fixture_match");
  });

  it("malformed request error has correct error shape", async () => {
    const res = await httpPostRaw(`${instance.url}/v1/responses`, "{not valid json");

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body);
    const sdkShape = openaiResponsesErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenAI Responses (malformed request error shape)", diffs);

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    // Verify concrete values
    expect(body.error.message).toMatch(/^Malformed JSON/);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("invalid_json");
  });
});

// ---------------------------------------------------------------------------
// Reasoning events (mock-only — no real API key needed)
// ---------------------------------------------------------------------------

describe("OpenAI Responses API reasoning drift", () => {
  const REASONING_TEXT = "Step by step, I will solve this problem.";
  const REASONING_FIXTURE: Fixture = {
    match: { userMessage: "Think carefully" },
    response: {
      content: "The answer is 42.",
      reasoning: REASONING_TEXT,
    },
  };

  let reasoningInstance: ServerInstance;

  beforeAll(async () => {
    reasoningInstance = await createServer([REASONING_FIXTURE], {
      port: 0,
      chunkSize: 100,
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
  });

  it("streaming reasoning events include delta and done", async () => {
    const res = await httpPost(`${reasoningInstance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "Think carefully" }],
      stream: true,
    });

    expect(res.status).toBe(200);

    const events = parseTypedSSE(res.body);
    expect(events.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const eventTypes = events.map((e) => e.type);

    // reasoning_summary_text.delta and .done must be present
    expect(eventTypes, "missing reasoning_summary_text.delta").toContain(
      "response.reasoning_summary_text.delta",
    );
    expect(eventTypes, "missing reasoning_summary_text.done").toContain(
      "response.reasoning_summary_text.done",
    );

    // reasoning_summary_part.added and .done must be present
    expect(eventTypes, "missing reasoning_summary_part.added").toContain(
      "response.reasoning_summary_part.added",
    );
    expect(eventTypes, "missing reasoning_summary_part.done").toContain(
      "response.reasoning_summary_part.done",
    );

    // Reasoning output_item.added must have type: "reasoning"
    const reasoningAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.data as { item?: { type?: string } }).item?.type === "reasoning",
    );
    expect(reasoningAdded, "no output_item.added with type=reasoning").toBeDefined();
  });

  it("reasoning event shapes include item_id, output_index, summary_index", async () => {
    const res = await httpPost(`${reasoningInstance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "Think carefully" }],
      stream: true,
    });

    expect(res.status).toBe(200);

    const events = parseTypedSSE(res.body);

    // Check delta event shape
    const deltaEvent = events.find((e) => e.type === "response.reasoning_summary_text.delta");
    expect(deltaEvent).toBeDefined();
    const deltaData = deltaEvent!.data as Record<string, unknown>;
    expect(deltaData).toHaveProperty("item_id");
    expect(deltaData).toHaveProperty("output_index", 0);
    expect(deltaData).toHaveProperty("summary_index", 0);
    expect(deltaData).toHaveProperty("delta");
    expect(typeof deltaData.item_id).toBe("string");
    expect(typeof deltaData.delta).toBe("string");

    // Check done event shape
    const doneEvent = events.find((e) => e.type === "response.reasoning_summary_text.done");
    expect(doneEvent).toBeDefined();
    const doneData = doneEvent!.data as Record<string, unknown>;
    expect(doneData).toHaveProperty("item_id");
    expect(doneData).toHaveProperty("output_index", 0);
    expect(doneData).toHaveProperty("summary_index", 0);
    expect(doneData).toHaveProperty("text", REASONING_TEXT);
    expect(typeof doneData.item_id).toBe("string");

    // item_id is consistent across reasoning events
    expect(deltaData.item_id).toBe(doneData.item_id);

    // Check part.added shape
    const partAdded = events.find((e) => e.type === "response.reasoning_summary_part.added");
    expect(partAdded).toBeDefined();
    const partAddedData = partAdded!.data as Record<string, unknown>;
    expect(partAddedData).toHaveProperty("item_id", deltaData.item_id);
    expect(partAddedData).toHaveProperty("output_index", 0);
    expect(partAddedData).toHaveProperty("summary_index", 0);
    expect(partAddedData).toHaveProperty("part");
    expect((partAddedData.part as { type: string }).type).toBe("summary_text");

    // Check part.done shape
    const partDone = events.find((e) => e.type === "response.reasoning_summary_part.done");
    expect(partDone).toBeDefined();
    const partDoneData = partDone!.data as Record<string, unknown>;
    expect(partDoneData).toHaveProperty("item_id", deltaData.item_id);
    expect(partDoneData).toHaveProperty("output_index", 0);
    expect(partDoneData).toHaveProperty("summary_index", 0);
    expect((partDoneData.part as { type: string; text: string }).text).toBe(REASONING_TEXT);
  });

  it("reasoning event shapes triangulate against SDK expectations", async () => {
    const sdkEvents = openaiResponsesReasoningEventShapes();

    const res = await httpPost(`${reasoningInstance.url}/v1/responses`, {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: "Think carefully" }],
      stream: true,
    });

    expect(res.status).toBe(200);

    const mockEvents = parseTypedSSE(res.body);
    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    // Triangulate reasoning-specific events against SDK shapes.
    // Since reasoning is not available on gpt-4o-mini via real API, we
    // use SDK shapes as both "expected" and "real" for shape validation.
    for (const sdkEvent of sdkEvents) {
      const mockEvent = mockSSEShapes.find((m) => m.type === sdkEvent.type);
      if (!mockEvent) {
        expect.fail(`Mock missing reasoning event type: ${sdkEvent.type}`);
        continue;
      }

      const diffs = triangulate(sdkEvent.dataShape, sdkEvent.dataShape, mockEvent.dataShape);
      const report = formatDriftReport(`OpenAI Responses Reasoning:${sdkEvent.type}`, diffs);

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });
});
