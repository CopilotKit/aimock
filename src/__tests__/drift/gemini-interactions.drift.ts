/**
 * Google Gemini Interactions API drift tests.
 *
 * Three-way comparison: SDK types x real API x aimock output.
 *
 * The Interactions API is in Beta — shapes may shift as Google
 * iterates on the endpoint.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { withFaultFixture } from "../helpers/misbehavior-server.js";
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

// Full accepted native captures; preserve exact bytes (including SSE framing).
// K5 stream is checked separately as approved modeled/native-unverified behavior.
const incompleteCaptures = [
  {
    name: "K5 object",
    source: "capture-k5-nonstream-20261008T171931Z.json",
    captureSha256: "9428bd886b2e390d0dacacd2b9bc16d758bb6ac5ab973f16353281b62dfe6b57",
    rawSha256: "933c60795a9169b7f7f544dda3c160e73de32b72cfdb52b379f6c42e434c21b5",
    raw: '{"status":"incomplete","usage":{"total_tokens":107,"total_input_tokens":78,"input_tokens_by_modality":[{"modality":"text","tokens":78}],"total_cached_tokens":0,"total_output_tokens":0,"total_tool_use_tokens":0,"total_thought_tokens":29},"created":"2026-10-08T17:19:32Z","updated":"2026-10-08T17:19:32Z","service_tier":"standard","object":"interaction","model":"gemini-2.5-flash"}',
    request: {
      model: "gemini-2.5-flash",
      input:
        "Call weather with city equal to this exact long string: Paris London Tokyo Berlin Rome Madrid Lisbon Vienna Prague Warsaw Oslo Stockholm Helsinki Copenhagen Dublin Edinburgh Amsterdam Brussels Zurich Geneva Athens Istanbul Cairo Nairobi Sydney Melbourne Auckland Toronto Vancouver Seattle Boston Chicago Austin Denver Miami.",
      tools: [
        {
          type: "function",
          name: "weather",
          parameters: {
            type: "object",
            properties: {
              city: {
                type: "string",
              },
            },
            required: ["city"],
          },
        },
      ],
      generation_config: {
        max_output_tokens: 32,
        tool_choice: "any",
      },
      store: false,
      stream: false,
    },
  },
  {
    name: "K9 stream",
    source: "capture-k9-stream-20261008T172003Z.json",
    captureSha256: "30b7c7a5f56ab42c541b4ab6c283e3a636ce55b16b1a110752a1a4a665024e73",
    rawSha256: "64f85ee47d28e2650b462f5963ebb95f82683c3ef083eb1def0a3a60e2d79836",
    raw: 'event: interaction.created\ndata: {"interaction":{"id":"","status":"in_progress","object":"interaction","model":"gemini-2.5-flash"},"event_type":"interaction.created"}\n\nevent: interaction.status_update\ndata: {"interaction_id":"","status":"in_progress","event_type":"interaction.status_update"}\n\nevent: step.start\ndata: {"index":0,"step":{"type":"thought"},"event_type":"step.start"}\n\nevent: step.delta\ndata: {"index":0,"delta":{"content":{"text":"**Analyzing Subset Counts**\\n\\nI\'m currently focused on determining the number of subsets, A, within the set S = {1, 2, ..., 100} that meet certain conditions. I\'ve begun to consider the constraints on these subsets, but haven\'t yet identified what those conditions are. The approach is to explore different criteria that might need to be met.\\n\\n\\n","type":"text"},"type":"thought_summary"},"event_type":"step.delta"}\n\nevent: step.stop\ndata: {"index":0,"event_type":"step.stop"}\n\nevent: interaction.completed\ndata: {"interaction":{"id":"","status":"incomplete","usage":{"total_tokens":69,"total_input_tokens":41,"input_tokens_by_modality":[{"modality":"text","tokens":41}],"total_cached_tokens":0,"total_output_tokens":0,"total_tool_use_tokens":0,"total_thought_tokens":28},"created":"2026-10-08T17:20:06Z","updated":"2026-10-08T17:20:06Z","service_tier":"standard","object":"interaction","model":"gemini-2.5-flash"},"event_type":"interaction.completed"}\n\nevent: done\ndata: [DONE]\n\n',
    request: {
      model: "gemini-2.5-flash",
      input:
        "Count the number of subsets of integers 1 through 100 whose sum is 1700 and whose cardinality is exactly 37. Work carefully before giving the exact final integer.",
      generation_config: {
        max_output_tokens: 32,
        thinking_level: "high",
        thinking_summaries: "auto",
      },
      store: false,
      stream: true,
    },
  },
  {
    name: "K9 object",
    source: "capture-k9-nonstream-20261008T173052Z.json",
    captureSha256: "7324da84963d25e136f5d4f40ca5391a6cf3ced4c60c17445cd6db47aa529f30",
    rawSha256: "4306db9da77a6ee0c006cdecac5d422256e19842aa77b3fd0c34a793f792ccc9",
    raw: '{"status":"incomplete","usage":{"total_tokens":69,"total_input_tokens":41,"input_tokens_by_modality":[{"modality":"text","tokens":41}],"total_cached_tokens":0,"total_output_tokens":0,"total_tool_use_tokens":0,"total_thought_tokens":28},"created":"2026-10-08T17:30:55Z","updated":"2026-10-08T17:30:55Z","service_tier":"standard","steps":[{"signature":"","summary":[{"text":"Here\'s my attempt at summarizing the thought process, tailored for an expert audience:\\n\\n**Analyzing Subset Constraints**\\n\\nOkay, so we\'re starting with the set S, defined as the integers from 1 to 100. That\'s a familiar ground, a classic finite set. The core problem is finding subsets of this set, and not just *any* subset, but subsets that adhere to certain, as-yet-unspecified, conditions. The setup is typical for combinatorics problems, specifically those involving power sets and subset enumeration. The \\"...\\" at the end suggests there\'s a constraint we haven\'t been shown yet. I\'ll need to see that constraint before I can start determining how to count those subsets effectively. It\'s almost guaranteed to involve some clever application of combinatorial principles, generating functions, or perhaps even a recursion. I\'ll be keeping an eye out for potential tricks like the Principle of Inclusion-Exclusion or maybe a clever bijection. Let\'s see what we\'re really dealing with...\\n","type":"text"}],"type":"thought"}],"object":"interaction","model":"gemini-2.5-flash"}',
    request: {
      model: "gemini-2.5-flash",
      input:
        "Count the number of subsets of integers 1 through 100 whose sum is 1700 and whose cardinality is exactly 37. Work carefully before giving the exact final integer.",
      generation_config: {
        max_output_tokens: 32,
        thinking_level: "high",
        thinking_summaries: "auto",
      },
      store: false,
      stream: false,
    },
  },
] as const;

type IncompleteCapture = (typeof incompleteCaptures)[number];
function nativeObject(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

// Read every frame, including terminal framing; never trim away answer/tool steps.
function nativeEvents(raw: string): Record<string, unknown>[] {
  expect(raw.endsWith("\n\n")).toBe(true);
  const frames = raw.split("\n\n");
  expect(frames.pop()).toBe("");
  const events: Record<string, unknown>[] = [];
  let done = false;
  for (const frame of frames) {
    expect(done).toBe(false);
    const lines = frame.split("\n");
    const data = lines.filter((line) => line.startsWith("data: "));
    expect(data).toHaveLength(1);
    const labels = lines.filter((line) => line.startsWith("event: "));
    expect(lines.length).toBe(data.length + labels.length);
    expect(labels.length).toBeLessThanOrEqual(1);
    const payload = data[0].slice(6);
    if (payload === "[DONE]") {
      expect(labels).toEqual(["event: done"]);
      expect(events.at(-1)?.event_type).toBe("interaction.completed");
      done = true;
      continue;
    }
    const event = nativeObject(JSON.parse(payload));
    if (labels.length) expect(labels[0]).toBe(`event: ${String(event.event_type)}`);
    events.push(event);
  }
  return events;
}

function incompleteContract(raw: string, capture: IncompleteCapture) {
  const reasoning = capture.name.startsWith("K9");
  let body: Record<string, unknown>;
  if (capture.request.stream) {
    const events = nativeEvents(raw);
    const sequence = events.map((event) => event.event_type);
    const deltas = events.filter((event) => event.event_type === "step.delta");
    expect(deltas.length).toBeGreaterThan(0);
    // Native status_update is optional transport metadata, not a content step.
    expect(sequence).toEqual(
      sequence.includes("interaction.status_update")
        ? [
            "interaction.created",
            "interaction.status_update",
            "step.start",
            ...deltas.map(() => "step.delta"),
            "step.stop",
            "interaction.completed",
          ]
        : [
            "interaction.created",
            "step.start",
            ...deltas.map(() => "step.delta"),
            "step.stop",
            "interaction.completed",
          ],
    );
    const start = events.find((event) => event.event_type === "step.start")!;
    const stop = events.find((event) => event.event_type === "step.stop")!;
    expect(start.index).toBe(0);
    expect(stop.index).toBe(start.index);
    expect(nativeObject(start.step).type).toBe("thought");
    let text = "";
    for (const delta of deltas) {
      expect(delta.index).toBe(start.index);
      const summary = nativeObject(delta.delta);
      expect(summary.type).toBe("thought_summary");
      const content = nativeObject(summary.content);
      expect(content).toEqual({ type: "text", text: expect.any(String) });
      text += content.text;
    }
    expect(text).not.toBe("");
    body = nativeObject(events.at(-1)!.interaction);
    expect(body.steps ?? []).toEqual([]);
  } else {
    body = nativeObject(JSON.parse(raw));
    const steps = body.steps ?? [];
    expect(Array.isArray(steps)).toBe(true);
    if (reasoning) {
      expect(steps).toHaveLength(1);
      const thought = nativeObject((steps as unknown[])[0]);
      expect(thought).toEqual({
        type: "thought",
        signature: expect.any(String),
        summary: expect.any(Array),
      });
      let text = "";
      for (const value of thought.summary as unknown[]) {
        const summary = nativeObject(value);
        expect(summary).toEqual({ type: "text", text: expect.any(String) });
        text += summary.text;
      }
      expect(text).not.toBe("");
    } else expect(steps).toEqual([]);
  }
  expect(body.status).toBe("incomplete");
  expect(body.output_text).toBeUndefined();
  const usage = nativeObject(body.usage);
  expect(usage.total_output_tokens).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(usage.total_output_tokens)).toBe(true);
  if (reasoning) {
    expect(usage.total_output_tokens).toBe(0);
    expect(usage.total_thought_tokens).toBeGreaterThan(0);
    expect(usage.total_input_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(
      Number(usage.total_input_tokens) + Number(usage.total_thought_tokens),
    );
  }
  return {
    status: body.status,
    // K5 uses estimated billing counts; only K9 requires zero answer tokens.
    outputTokens: reasoning ? usage.total_output_tokens : "estimated",
    content: reasoning ? "thought" : "empty",
  };
}

async function compareLocalIncomplete(capture: IncompleteCapture, nativeRaw: string) {
  expect(createHash("sha256").update(capture.raw).digest("hex")).toBe(capture.rawSha256);
  const reference = incompleteContract(capture.raw, capture);
  expect(incompleteContract(nativeRaw, capture)).toEqual(reference);
  const fault = capture.name.startsWith("K5")
    ? { fault: "stop-length-mid-tool", at: 0.5 }
    : { fault: "reasoning-only", reasoning: "Considering options." };
  await withFaultFixture({ faults: [fault] }, async ({ url }) => {
    const response = await fetch(`${url}/v1beta/interactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...capture.request, input: "weather" }),
      signal: AbortSignal.timeout(5000),
    });
    const raw = await response.text();
    console.log(
      JSON.stringify({ case: capture.name, capture: capture.source, status: response.status, raw }),
    );
    expect(response.status).toBe(200);
    expect(incompleteContract(raw, capture)).toEqual(reference);
  });
}

describe("Gemini Interactions captured incomplete contracts", () => {
  it.each(incompleteCaptures)("$name matches actual localhost response", async (capture) => {
    await compareLocalIncomplete(capture, capture.raw);
  });
});

// Derived metamorphic inputs, NOT new native captures: split the captured text
// without changing its value, and replay those bytes through real local HTTP.
function segmentedThought(capture: IncompleteCapture, invalid?: "answer" | "terminal") {
  const split = (value: unknown) => {
    expect(typeof value).toBe("string");
    const text = String(value);
    const middle = Math.floor(text.length / 2);
    const parts = [text.slice(0, middle), text.slice(middle)];
    expect(parts.join("")).toBe(text);
    return parts.map((text) => ({ type: "text", text }));
  };
  if (!capture.request.stream) {
    const body = nativeObject(JSON.parse(capture.raw));
    const thought = nativeObject((body.steps as unknown[])[0]);
    thought.summary = split(nativeObject((thought.summary as unknown[])[0]).text);
    if (invalid === "answer") body.output_text = "Visible answer";
    if (invalid === "terminal") body.status = "completed";
    return JSON.stringify(body);
  }
  return capture.raw
    .split("\n\n")
    .map((frame) => {
      if (frame.startsWith("event: step.delta\n")) {
        const event = nativeObject(JSON.parse(frame.split("\ndata: ")[1]));
        const delta = nativeObject(event.delta);
        return split(nativeObject(delta.content).text)
          .map(
            (content, index) =>
              `event: step.delta\ndata: ${JSON.stringify({
                ...event,
                delta: {
                  ...delta,
                  type: invalid === "answer" && index === 1 ? "text_delta" : delta.type,
                  content,
                },
              })}`,
          )
          .join("\n\n");
      }
      if (invalid === "terminal" && frame.startsWith("event: interaction.completed\n")) {
        const event = nativeObject(JSON.parse(frame.split("\ndata: ")[1]));
        nativeObject(event.interaction).status = "completed";
        return `event: interaction.completed\ndata: ${JSON.stringify(event)}`;
      }
      return frame;
    })
    .join("\n\n");
}

async function replayDerivedThought(raw: string) {
  const server = createServer((_request, response) => response.end(raw));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing replay port");
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    const received = await response.text();
    expect(received).toBe(raw);
    console.log(
      JSON.stringify({
        provenance: "capture-derived segmentation, not native capture",
        raw: received,
      }),
    );
    return received;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("Gemini Interactions derived segmentation contracts", () => {
  const thoughts = incompleteCaptures.filter((capture) => capture.name.startsWith("K9"));
  it.each(thoughts)("$name accepts equivalent segmentation through HTTP", async (capture) => {
    await compareLocalIncomplete(capture, await replayDerivedThought(segmentedThought(capture)));
  });
  it.each(thoughts)(
    "$name rejects answer and terminal corruption through HTTP",
    async (capture) => {
      for (const invalid of ["answer", "terminal"] as const) {
        const raw = await replayDerivedThought(segmentedThought(capture, invalid));
        await expect(compareLocalIncomplete(capture, raw)).rejects.toThrow();
      }
    },
  );
});

// Same contract on the recurring live-key path. No retry or empty-result acceptance.
// These requests are intentionally bounded; a changed trigger is a drift failure.
describe.skipIf(!GOOGLE_API_KEY)("Gemini Interactions live incomplete contracts", () => {
  it.each(incompleteCaptures)("$name matches native and localhost", async (capture) => {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GOOGLE_API_KEY! },
      body: JSON.stringify(capture.request),
      signal: AbortSignal.timeout(45000),
    });
    const raw = await response.text();
    expect(response.status).toBe(200);
    await compareLocalIncomplete(capture, raw);
  });
});

// Retained native attempt: no tool step, NOT_TRIGGERED, never modeled evidence.
const nativeK5StreamAttempt = {
  source: "capture-k5-stream-20261008T171932Z.json",
  captureSha256: "3c0d1a0fb50f320566682938413bf826e6c27c05df190bc2c0985933001178e8",
  rawSha256: "554a520213922a609acafc9d632c43b63a6486b0134ccffc493044a2f34b0e82",
  raw: 'event: interaction.created\ndata: {"interaction":{"id":"","status":"in_progress","object":"interaction","model":"gemini-2.5-flash"},"event_type":"interaction.created"}\n\nevent: interaction.status_update\ndata: {"interaction_id":"","status":"in_progress","event_type":"interaction.status_update"}\n\nevent: interaction.completed\ndata: {"interaction":{"id":"","status":"incomplete","usage":{"total_tokens":107,"total_input_tokens":78,"input_tokens_by_modality":[{"modality":"text","tokens":78}],"total_cached_tokens":0,"total_output_tokens":0,"total_tool_use_tokens":0,"total_thought_tokens":29},"created":"2026-10-08T17:19:32Z","updated":"2026-10-08T17:19:32Z","service_tier":"standard","object":"interaction","model":"gemini-2.5-flash"},"event_type":"interaction.completed"}\n\nevent: done\ndata: [DONE]\n\n',
  request: {
    model: "gemini-2.5-flash",
    input:
      "Call weather with city equal to this exact long string: Paris London Tokyo Berlin Rome Madrid Lisbon Vienna Prague Warsaw Oslo Stockholm Helsinki Copenhagen Dublin Edinburgh Amsterdam Brussels Zurich Geneva Athens Istanbul Cairo Nairobi Sydney Melbourne Auckland Toronto Vancouver Seattle Boston Chicago Austin Denver Miami.",
    tools: [
      {
        type: "function",
        name: "weather",
        parameters: {
          type: "object",
          properties: {
            city: {
              type: "string",
            },
          },
          required: ["city"],
        },
      },
    ],
    generation_config: {
      max_output_tokens: 32,
      tool_choice: "any",
    },
    store: false,
    stream: true,
  },
} as const;

// Validate complete framing/lifecycle before deciding whether a native request
// induced the target. Missing closure, malformed fields or transport failure
// must never become NOT_TRIGGERED. Chunk segmentation is deliberately variable.
function modeledK5StreamContract(raw: string, local = false) {
  if (!local) expect(raw.endsWith("event: done\ndata: [DONE]\n\n")).toBe(true);
  const events = nativeEvents(raw);
  expect(events[0]?.event_type).toBe("interaction.created");
  expect(nativeObject(events[0].interaction).status).toBe("in_progress");
  expect(events.at(-1)?.event_type).toBe("interaction.completed");
  const terminal = nativeObject(events.at(-1)!.interaction);
  expect(["completed", "requires_action", "incomplete"]).toContain(terminal.status);
  if (terminal.output_text !== undefined) expect(typeof terminal.output_text).toBe("string");
  if (terminal.steps !== undefined) {
    expect(Array.isArray(terminal.steps)).toBe(true);
    for (const step of terminal.steps as unknown[]) nativeObject(step);
  }
  const usage = nativeObject(terminal.usage);
  for (const field of ["total_input_tokens", "total_output_tokens", "total_tokens"]) {
    expect(Number.isInteger(usage[field])).toBe(true);
    expect(usage[field]).toBeGreaterThanOrEqual(0);
  }
  let active: { index: number; type: string; text: string; fragments: number } | undefined;
  let nextIndex = 0;
  let cut = false;
  let toolCount = 0;
  let answer = "";
  for (const event of events.slice(1, -1)) {
    if (event.event_type === "interaction.status_update") {
      expect(nextIndex).toBe(0);
      expect(active).toBeUndefined();
      expect(event.status).toBe("in_progress");
      continue;
    }
    if (event.event_type === "step.start") {
      expect(active).toBeUndefined();
      expect(cut).toBe(false);
      expect(event.index).toBe(nextIndex++);
      const step = nativeObject(event.step);
      expect(["thought", "model_output", "function_call"]).toContain(step.type);
      if (step.type === "function_call") {
        expect(typeof step.name).toBe("string");
        expect(step.name).not.toBe("");
        expect(typeof step.id).toBe("string");
        expect(nativeObject(step.arguments)).toEqual({});
        toolCount++;
      }
      active = { index: Number(event.index), type: String(step.type), text: "", fragments: 0 };
    } else if (event.event_type === "step.delta") {
      expect(active).toBeDefined();
      expect(event.index).toBe(active!.index);
      const delta = nativeObject(event.delta);
      active!.fragments++;
      if (active!.type === "function_call") {
        expect(delta.type).toBe("arguments_delta");
        expect(typeof delta.arguments).toBe("string");
        active!.text += delta.arguments;
      } else if (active!.type === "thought") {
        expect(delta.type).toBe("thought_summary");
        const content = nativeObject(delta.content);
        expect(content).toEqual({ type: "text", text: expect.any(String) });
        active!.text += content.text;
      } else {
        expect(delta.type).toBe("text");
        expect(typeof delta.text).toBe("string");
        answer += delta.text;
      }
    } else {
      expect(event.event_type).toBe("step.stop");
      expect(active).toBeDefined();
      expect(event.index).toBe(active!.index);
      expect(active!.fragments).toBeGreaterThan(0);
      if (active!.type === "function_call") {
        try {
          JSON.parse(active!.text);
        } catch {
          cut = true;
        }
        if (local) {
          const complete = JSON.stringify({ city: "Paris" });
          expect(active!.text).toBe(complete.slice(0, Math.floor(complete.length * 0.5)));
          expect(cut).toBe(true);
        }
      }
      active = undefined;
    }
  }
  expect(active).toBeUndefined();
  if (cut) expect(terminal.status).toBe("incomplete");
  if (local) {
    expect(cut).toBe(true);
    expect(toolCount).toBe(1);
    expect(nextIndex).toBe(1);
    expect(answer).toBe("");
    expect(terminal.output_text).toBeUndefined();
    expect(terminal.steps ?? []).toEqual([]);
    expect(usage.total_input_tokens).toBe(2);
    expect(usage.total_output_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(2 + Number(usage.total_output_tokens));
  }
  return cut ? "TRIGGERED_MODELED_CONTRACT_MATCH" : "NOT_TRIGGERED";
}

async function checkLocalModeledK5Stream() {
  await withFaultFixture(
    { faults: [{ fault: "stop-length-mid-tool", at: 0.5 }] },
    async ({ url, mock }) => {
      const response = await fetch(`${url}/v1beta/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...nativeK5StreamAttempt.request, input: "weather" }),
        signal: AbortSignal.timeout(5000),
      });
      const raw = await response.text();
      console.log(
        JSON.stringify({
          case: "K5 stream modeled/native-unverified",
          status: response.status,
          raw,
          journal: mock.getRequests(),
        }),
      );
      expect(response.status).toBe(200);
      expect(modeledK5StreamContract(raw, true)).toBe("TRIGGERED_MODELED_CONTRACT_MATCH");
      expect(mock.getRequests()).toHaveLength(1);
      expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
        applied: true,
        fault: "stop-length-mid-tool",
      });
    },
  );
}

it("modeled K5 stream matches actual localhost response", checkLocalModeledK5Stream);
it("retained native K5 stream is NOT_TRIGGERED, malformed/truncated evidence fails", () => {
  expect(createHash("sha256").update(nativeK5StreamAttempt.raw).digest("hex")).toBe(
    nativeK5StreamAttempt.rawSha256,
  );
  expect(modeledK5StreamContract(nativeK5StreamAttempt.raw)).toBe("NOT_TRIGGERED");
  console.log(
    JSON.stringify({
      case: "K5 stream",
      source: nativeK5StreamAttempt.source,
      disposition: "NOT_TRIGGERED",
    }),
  );
  expect(() => modeledK5StreamContract(nativeK5StreamAttempt.raw.slice(0, -1))).toThrow();
  expect(() =>
    modeledK5StreamContract(
      nativeK5StreamAttempt.raw.replace('"total_tokens":107', '"total_tokens":"bad"'),
    ),
  ).toThrow();
});

// Derived malformed terminal fields exercise the actual capture reader; they
// are not native fault captures or a replacement for the localhost replay.
it.each([
  ["steps numeric", { steps: 123 }],
  ["steps null", { steps: null }],
  ["steps non-object item", { steps: [123] }],
  ["output_text object", { output_text: { bad: true } }],
  ["output_text null", { output_text: null }],
])("modeled K5 reader rejects malformed terminal %s", (_label, fields) => {
  const raw = nativeK5StreamAttempt.raw.replace(
    '"status":"incomplete","usage"',
    `"status":"incomplete",${JSON.stringify(fields).slice(1, -1)},"usage"`,
  );
  expect(() => modeledK5StreamContract(raw)).toThrow();
});
it("modeled K5 reader permits valid native terminal answer fields", () => {
  const raw = nativeK5StreamAttempt.raw.replace(
    '"status":"incomplete","usage"',
    '"status":"incomplete","steps":[],"output_text":"Visible answer","usage"',
  );
  expect(modeledK5StreamContract(raw)).toBe("NOT_TRIGGERED");
});

// One additional request on the existing live-key path: exact retained request,
// max_output_tokens32, 45s including body, no retries. Total new semantic live
// cases = 4 (plus five unchanged ordinary cases); no implicit extra API calls.
describe.skipIf(!GOOGLE_API_KEY)("Gemini Interactions live modeled K5 stream", () => {
  it("records genuine non-triggers and rejects contradictory triggered contracts", async () => {
    await checkLocalModeledK5Stream();
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GOOGLE_API_KEY! },
      body: JSON.stringify(nativeK5StreamAttempt.request),
      signal: AbortSignal.timeout(45000),
    });
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const disposition = modeledK5StreamContract(raw);
    console.log(
      JSON.stringify({
        case: "K5 stream",
        model: nativeK5StreamAttempt.request.model,
        request: nativeK5StreamAttempt.request,
        disposition,
        raw,
      }),
    );
  });
});
