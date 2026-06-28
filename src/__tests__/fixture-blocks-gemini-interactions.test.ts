/**
 * Gemini Interactions API (SDK 2.x step protocol): ordered `blocks` replay.
 *
 * The Interactions step protocol is index/step-addressed and ordered, so
 * tool-first IS wire-expressible on REPLAY. When a combined
 * content+toolCalls fixture (or a blocks-only fixture) sets the optional
 * `blocks` field, the builder must emit `steps[]` (non-stream) and the
 * streamed `step.*` brackets in the fixture's block ARRAY ORDER. A `toolCall`
 * block placed before a `text` block therefore yields a `function_call` step
 * AHEAD of the `model_output` step — the opposite of the legacy
 * (text-step-always-first) shape.
 *
 * Real mock-server surface (mirrors gemini-interactions.test.ts): an actual
 * server listens, a real HTTP request hits `/v1beta/interactions`, and
 * assertions read the wire bytes for both `stream: false` (steps[]) and
 * `stream: true` (step.start sequence).
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import type { Fixture, FixtureBlock } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { resetInteractionCounter, resetEventIdCounter } from "../gemini-interactions.js";

// --- helpers (mirror gemini-interactions.test.ts) ---

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function parseInteractionsSSEEvents(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    }
  }
  return events;
}

// Step type of a step.start event (function_call | model_output).
function stepStartTypesInOrder(events: Array<Record<string, unknown>>): string[] {
  return events
    .filter((e) => e.event_type === "step.start")
    .map((e) => (e.step as Record<string, unknown>).type as string);
}

// --- fixtures ---

const toolFirstBlocks: FixtureBlock[] = [
  { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}', id: "call_tf" },
  { type: "text", text: "Here you go." },
];

const toolFirstFixture: Fixture = {
  match: { userMessage: "gi blocks tool-first" },
  response: {
    content: "Here you go.",
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}', id: "call_tf" }],
    blocks: toolFirstBlocks,
  },
};

const blocksOnlyFixture: Fixture = {
  match: { userMessage: "gi blocks-only tool-first" },
  response: {
    blocks: [
      { type: "toolCall", name: "lookup", arguments: '{"q":"x"}', id: "call_bo" },
      { type: "text", text: "Done." },
    ],
  },
};

const legacyContentWithToolsFixture: Fixture = {
  match: { userMessage: "gi legacy combined" },
  response: {
    content: "Let me help you",
    toolCalls: [{ name: "analyze_data", arguments: '{"dataset":"sales"}', id: "call_legacy" }],
  },
};

const allFixtures: Fixture[] = [toolFirstFixture, blocksOnlyFixture, legacyContentWithToolsFixture];

// --- tests ---

let instance: ServerInstance | null = null;

beforeEach(() => {
  resetInteractionCounter();
  resetEventIdCounter();
});

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

describe("Gemini Interactions API — fixture block ordering (#274)", () => {
  // ── tool-first: non-stream steps[] order ──────────────────────────────────
  it("tool-first blocks: function_call step precedes model_output in non-stream steps[]", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "gi blocks tool-first",
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      steps: Array<Record<string, unknown>>;
      output_text?: string;
    };
    const types = body.steps.map((s) => s.type as string);
    // RED before fix: legacy emits model_output FIRST (index 0), function_call after.
    expect(types.indexOf("function_call")).toBeLessThan(types.indexOf("model_output"));
    expect(types[0]).toBe("function_call");
    // The function_call step carries name + parsed arguments.
    expect(body.steps[0].name).toBe("get_weather");
    expect(body.steps[0].arguments).toEqual({ city: "NYC" });
    // Text still present.
    expect(body.output_text).toBe("Here you go.");
    const textStep = body.steps.find((s) => s.type === "model_output")!;
    expect((textStep.content as Array<{ text: string }>)[0].text).toBe("Here you go.");
  });

  // ── tool-first: streamed step.start order ─────────────────────────────────
  it("tool-first blocks: function_call step.start precedes model_output step.start when streaming", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "gi blocks tool-first",
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = parseInteractionsSSEEvents(res.body);
    const startTypes = stepStartTypesInOrder(events);
    // RED before fix: legacy streams model_output at index 0 first.
    expect(startTypes.indexOf("function_call")).toBeLessThan(startTypes.indexOf("model_output"));
    expect(startTypes[0]).toBe("function_call");

    // The function_call step.start carries identity; args stream as arguments_delta.
    const fcStart = events.find(
      (e) =>
        e.event_type === "step.start" &&
        (e.step as Record<string, unknown>).type === "function_call",
    )!;
    expect((fcStart.step as Record<string, unknown>).name).toBe("get_weather");
    const argDelta = events.find(
      (e) =>
        e.event_type === "step.delta" &&
        (e.delta as Record<string, unknown>).type === "arguments_delta",
    )!;
    expect(JSON.parse((argDelta.delta as Record<string, unknown>).arguments as string)).toEqual({
      city: "NYC",
    });

    // Text deltas still accumulate.
    const textDeltas = events.filter(
      (e) => e.event_type === "step.delta" && (e.delta as Record<string, unknown>).type === "text",
    );
    const accumulated = textDeltas
      .map((e) => (e.delta as Record<string, unknown>).text as string)
      .join("");
    expect(accumulated).toBe("Here you go.");
  });

  // ── blocks-only: streams tool-first ───────────────────────────────────────
  it("blocks-only fixture streams tool-first (function_call before model_output)", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "gi blocks-only tool-first",
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = parseInteractionsSSEEvents(res.body);
    const startTypes = stepStartTypesInOrder(events);
    expect(startTypes[0]).toBe("function_call");
    expect(startTypes.indexOf("function_call")).toBeLessThan(startTypes.indexOf("model_output"));

    const fcStart = events.find(
      (e) =>
        e.event_type === "step.start" &&
        (e.step as Record<string, unknown>).type === "function_call",
    )!;
    expect((fcStart.step as Record<string, unknown>).name).toBe("lookup");

    const textDeltas = events.filter(
      (e) => e.event_type === "step.delta" && (e.delta as Record<string, unknown>).type === "text",
    );
    expect(textDeltas.map((e) => (e.delta as Record<string, unknown>).text).join("")).toBe("Done.");
  });

  it("blocks-only fixture returns tool-first non-stream steps[]", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "gi blocks-only tool-first",
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      steps: Array<Record<string, unknown>>;
      output_text?: string;
    };
    const types = body.steps.map((s) => s.type as string);
    expect(types[0]).toBe("function_call");
    expect(types.indexOf("function_call")).toBeLessThan(types.indexOf("model_output"));
    expect(body.steps[0].name).toBe("lookup");
    expect(body.output_text).toBe("Done.");
  });

  // ── back-compat: no-blocks fixture is identical legacy (non-stream) ────────
  it("back-compat: a no-blocks combined fixture keeps legacy text-first steps[]", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "gi legacy combined",
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      steps: Array<Record<string, unknown>>;
      output_text?: string;
    };
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].type).toBe("model_output");
    expect((body.steps[0].content as Array<{ text: string }>)[0].text).toBe("Let me help you");
    expect(body.steps[1].type).toBe("function_call");
    expect(body.steps[1].name).toBe("analyze_data");
    expect(body.output_text).toBe("Let me help you");
  });

  // ── back-compat: no-blocks fixture is identical legacy (streamed) ──────────
  it("back-compat: a no-blocks combined fixture keeps legacy text-first stream", async () => {
    instance = await createServer([...allFixtures]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "gi legacy combined",
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = parseInteractionsSSEEvents(res.body);
    const startTypes = stepStartTypesInOrder(events);
    // Legacy: model_output (index 0) leads, function_call follows.
    expect(startTypes[0]).toBe("model_output");
    expect(startTypes.indexOf("model_output")).toBeLessThan(startTypes.indexOf("function_call"));

    const textDeltas = events.filter(
      (e) => e.event_type === "step.delta" && (e.delta as Record<string, unknown>).type === "text",
    );
    expect(textDeltas.map((e) => (e.delta as Record<string, unknown>).text).join("")).toBe(
      "Let me help you",
    );
    const argDelta = events.find(
      (e) =>
        e.event_type === "step.delta" &&
        (e.delta as Record<string, unknown>).type === "arguments_delta",
    )!;
    expect(JSON.parse((argDelta.delta as Record<string, unknown>).arguments as string)).toEqual({
      dataset: "sales",
    });
  });
});
