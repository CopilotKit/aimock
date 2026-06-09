import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

interface ResponsesSSEEvent {
  type?: string;
  output_index?: number;
  item?: { type?: string };
  [key: string]: unknown;
}

function parseSSEEvents(body: string): ResponsesSSEEvent[] {
  const events: ResponsesSSEEvent[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]") {
      events.push(JSON.parse(line.slice(6)) as ResponsesSSEEvent);
    }
  }
  return events;
}

/** Non-stream: does the response output[] contain a reasoning item? */
function hasReasoningOutputItem(body: string): boolean {
  const parsed = JSON.parse(body) as { output?: Array<{ type?: string }> };
  return (parsed.output ?? []).some((item) => item.type === "reasoning");
}

/** Non-stream: does the response output[] contain a function_call item? */
function hasFunctionCallOutputItem(body: string): boolean {
  const parsed = JSON.parse(body) as { output?: Array<{ type?: string }> };
  return (parsed.output ?? []).some((item) => item.type === "function_call");
}

/** Stream: are there any reasoning summary events? */
function hasReasoningStreamEvents(body: string): boolean {
  return parseSSEEvents(body).some(
    (e) => typeof e.type === "string" && e.type.startsWith("response.reasoning_summary_text"),
  );
}

/** Stream: are there any function_call argument events? */
function hasFunctionCallStreamEvents(body: string): boolean {
  return parseSSEEvents(body).some(
    (e) => typeof e.type === "string" && e.type.startsWith("response.function_call_arguments"),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const toolOnlyReasoningFixture: Fixture = {
  match: { userMessage: "tool-only-think" },
  response: {
    reasoning: "Deciding which tool to call.",
    toolCalls: [{ name: "lookup", arguments: '{"q":"x"}' }],
  },
};

const toolOnlyNoReasoningFixture: Fixture = {
  match: { userMessage: "tool-only-plain" },
  response: {
    toolCalls: [{ name: "lookup", arguments: '{"q":"x"}' }],
  },
};

const allFixtures: Fixture[] = [toolOnlyReasoningFixture, toolOnlyNoReasoningFixture];

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

function responsesBody(userMessage: string, model: string, stream: boolean) {
  return {
    model,
    input: [{ role: "user", content: userMessage }],
    stream,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Responses API reasoning capability gating — tool-call-only response", () => {
  it("reasoning-capable model emits reasoning (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-think", "o3", false),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(true);
    expect(hasFunctionCallOutputItem(res.body)).toBe(true);
  });

  it("reasoning-capable model emits reasoning (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-think", "o3", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamEvents(res.body)).toBe(true);
    expect(hasFunctionCallStreamEvents(res.body)).toBe(true);
  });

  it("non-reasoning model, strict OFF: still emits reasoning but warns (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-think", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("gpt-4.1");
  });

  it("non-reasoning model, strict OFF: still emits reasoning but warns (stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-think", "gpt-4.1", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamEvents(res.body)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("non-reasoning model, strict ON (header): suppresses reasoning (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-think", "gpt-4.1", false),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(false);
    // Tool calls must still be present when reasoning is suppressed.
    expect(hasFunctionCallOutputItem(res.body)).toBe(true);
  });

  it("non-reasoning model, strict ON (header): suppresses reasoning (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-think", "gpt-4.1", true),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamEvents(res.body)).toBe(false);
    expect(hasFunctionCallStreamEvents(res.body)).toBe(true);
  });

  it("non-reasoning model, server --strict: suppresses reasoning (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0, strict: true });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-think", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(false);
    expect(hasFunctionCallOutputItem(res.body)).toBe(true);
  });

  it("no fixture reasoning: no-op, no warn even for non-reasoning model (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-plain", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(false);
    expect(hasFunctionCallOutputItem(res.body)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // output_index ordering: a leading reasoning item occupies output_index 0,
  // which must shift the function_call output items to start at index 1. This
  // guards against the index-arithmetic regression called out in the spec.
  // ───────────────────────────────────────────────────────────────────────
  it("leading reasoning item shifts function_call output_index to 1 (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-think", "o3", true),
    );
    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);

    // The reasoning output item must be added at output_index 0.
    const reasoningAdded = events.find(
      (e) => e.type === "response.output_item.added" && e.item?.type === "reasoning",
    );
    expect(reasoningAdded).toBeDefined();
    expect(reasoningAdded?.output_index).toBe(0);

    // The function_call output item must be added at output_index 1 (shifted by
    // the leading reasoning item).
    const fcAdded = events.find(
      (e) => e.type === "response.output_item.added" && e.item?.type === "function_call",
    );
    expect(fcAdded).toBeDefined();
    expect(fcAdded?.output_index).toBe(1);

    // All function_call argument events carry the shifted output_index too.
    const fcArgEvents = events.filter(
      (e) => typeof e.type === "string" && e.type.startsWith("response.function_call_arguments"),
    );
    expect(fcArgEvents.length).toBeGreaterThan(0);
    for (const e of fcArgEvents) {
      expect(e.output_index).toBe(1);
    }
  });

  it("without reasoning the function_call output_index starts at 0 (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-only-plain", "o3", true),
    );
    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);

    const fcAdded = events.find(
      (e) => e.type === "response.output_item.added" && e.item?.type === "function_call",
    );
    expect(fcAdded).toBeDefined();
    expect(fcAdded?.output_index).toBe(0);
  });
});
