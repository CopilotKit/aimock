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

interface ChatSSEEvent {
  choices?: {
    delta?: { content?: string; reasoning_content?: string; role?: string };
    finish_reason?: string | null;
  }[];
  [key: string]: unknown;
}

function parseSSEEvents(body: string): ChatSSEEvent[] {
  const events: ChatSSEEvent[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]") {
      events.push(JSON.parse(line.slice(6)) as ChatSSEEvent);
    }
  }
  return events;
}

/** Non-stream: does the assistant message carry a reasoning_content field? */
function nonStreamReasoning(body: string): string | undefined {
  const parsed = JSON.parse(body) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  };
  return parsed.choices?.[0]?.message?.reasoning_content;
}

/** Non-stream: the normal assistant content. */
function nonStreamContent(body: string): string | undefined {
  const parsed = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
  return parsed.choices?.[0]?.message?.content;
}

/** Stream: are there any reasoning_content deltas? */
function hasReasoningStreamDeltas(body: string): boolean {
  return parseSSEEvents(body).some((e) => e.choices?.[0]?.delta?.reasoning_content !== undefined);
}

/** Stream: concatenated normal content deltas. */
function streamContent(body: string): string {
  return parseSSEEvents(body)
    .filter((e) => {
      const c = e.choices?.[0]?.delta?.content;
      return c !== undefined && c !== "";
    })
    .map((e) => e.choices![0].delta!.content)
    .join("");
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

const noReasoningFixture: Fixture = {
  match: { userMessage: "plain" },
  response: { content: "Just plain text." },
};

const allFixtures: Fixture[] = [reasoningFixture, noReasoningFixture];

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

function chatBody(userMessage: string, model: string, stream: boolean) {
  return {
    model,
    messages: [{ role: "user", content: userMessage }],
    stream,
  };
}

// ---------------------------------------------------------------------------
// Tests — canonical aimock#254 repro path: /v1/chat/completions + gpt-4.1
// ---------------------------------------------------------------------------

describe("/v1/chat/completions reasoning capability gating (aimock#254 repro)", () => {
  it("non-reasoning model gpt-4.1, strict OFF: still emits reasoning but warns (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(nonStreamReasoning(res.body)).toBe("Let me reason step by step.");
    expect(nonStreamContent(res.body)).toBe("The answer is 42.");
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("gpt-4.1");
  });

  it("non-reasoning model gpt-4.1, strict OFF: still emits reasoning but warns (stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think", "gpt-4.1", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamDeltas(res.body)).toBe(true);
    expect(streamContent(res.body)).toBe("The answer is 42.");
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("gpt-4.1");
  });

  it("non-reasoning model gpt-4.1, strict ON (header): suppresses reasoning, content intact (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think", "gpt-4.1", false),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(nonStreamReasoning(res.body)).toBeUndefined();
    expect(nonStreamContent(res.body)).toBe("The answer is 42.");
  });

  it("non-reasoning model gpt-4.1, strict ON (header): suppresses reasoning, content intact (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think", "gpt-4.1", true),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamDeltas(res.body)).toBe(false);
    expect(streamContent(res.body)).toBe("The answer is 42.");
  });

  it("non-reasoning model gpt-4.1, server --strict: suppresses reasoning (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0, strict: true });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(nonStreamReasoning(res.body)).toBeUndefined();
    expect(nonStreamContent(res.body)).toBe("The answer is 42.");
  });

  it("non-reasoning model gpt-4.1, server --strict: suppresses reasoning (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0, strict: true });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think", "gpt-4.1", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamDeltas(res.body)).toBe(false);
    expect(streamContent(res.body)).toBe("The answer is 42.");
  });

  it("reasoning-capable model o3-mini: emits reasoning, no warn (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think", "o3-mini", false),
    );
    expect(res.status).toBe(200);
    expect(nonStreamReasoning(res.body)).toBe("Let me reason step by step.");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reasoning-capable model o3-mini: emits reasoning, no warn (stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think", "o3-mini", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamDeltas(res.body)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fixture with no reasoning, gpt-4.1: no-op, no warn (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("plain", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(nonStreamReasoning(res.body)).toBeUndefined();
    expect(nonStreamContent(res.body)).toBe("Just plain text.");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fixture with no reasoning, gpt-4.1: no-op, no warn (stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("plain", "gpt-4.1", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamDeltas(res.body)).toBe(false);
    expect(streamContent(res.body)).toBe("Just plain text.");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
