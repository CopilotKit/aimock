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

/** Stream: are there any reasoning summary events? */
function hasReasoningStreamEvents(body: string): boolean {
  return parseSSEEvents(body).some(
    (e) => typeof e.type === "string" && e.type.startsWith("response.reasoning_summary_text"),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const reasoningFixture: Fixture = {
  match: { userMessage: "think" },
  response: {
    content: "The answer is 42.",
    reasoning: "Let me reason step by step.",
  },
};

const reasoningWithToolFixture: Fixture = {
  match: { userMessage: "tool-think" },
  response: {
    content: "Calling a tool.",
    reasoning: "Deliberating about the tool call.",
    toolCalls: [{ name: "lookup", arguments: '{"q":"x"}' }],
  },
};

const noReasoningFixture: Fixture = {
  match: { userMessage: "plain" },
  response: { content: "Just plain text." },
};

const allFixtures: Fixture[] = [reasoningFixture, reasoningWithToolFixture, noReasoningFixture];

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

describe("Responses API reasoning capability gating — text response", () => {
  it("reasoning-capable model emits reasoning (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(`${instance.url}/v1/responses`, responsesBody("think", "o3", false));
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(true);
  });

  it("reasoning-capable model emits reasoning (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(`${instance.url}/v1/responses`, responsesBody("think", "o3", true));
    expect(res.status).toBe(200);
    expect(hasReasoningStreamEvents(res.body)).toBe(true);
  });

  it("non-reasoning model, strict OFF: still emits reasoning but warns (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("think", "gpt-4.1", false),
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
      responsesBody("think", "gpt-4.1", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamEvents(res.body)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("non-reasoning model, strict ON (header): suppresses reasoning (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("think", "gpt-4.1", false),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(false);
  });

  it("non-reasoning model, strict ON (header): suppresses reasoning (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("think", "gpt-4.1", true),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamEvents(res.body)).toBe(false);
  });

  it("non-reasoning model, server --strict: suppresses reasoning (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0, strict: true });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("think", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(false);
  });

  it("unknown model emits reasoning, no warn (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("think", "future-x", false),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("no fixture reasoning: no-op, no warn even for non-reasoning model", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("plain", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("Responses API reasoning capability gating — content+toolCalls response", () => {
  it("reasoning-capable model emits reasoning (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-think", "o3", false),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(true);
  });

  it("non-reasoning model, strict ON: suppresses reasoning (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-think", "gpt-4.1", false),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(false);
  });

  it("non-reasoning model, strict ON: suppresses reasoning (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-think", "gpt-4.1", true),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamEvents(res.body)).toBe(false);
  });

  it("non-reasoning model, strict OFF: emits reasoning + warns (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/responses`,
      responsesBody("tool-think", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningOutputItem(res.body)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});
