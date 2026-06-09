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
    delta?: {
      content?: string;
      reasoning_content?: string;
      role?: string;
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
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
    choices?: { message?: { reasoning_content?: string } }[];
  };
  return parsed.choices?.[0]?.message?.reasoning_content;
}

/** Non-stream: the name of the first tool call in the assistant message. */
function nonStreamToolCallName(body: string): string | undefined {
  const parsed = JSON.parse(body) as {
    choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[];
  };
  return parsed.choices?.[0]?.message?.tool_calls?.[0]?.function?.name;
}

/** Stream: are there any reasoning_content deltas? */
function hasReasoningStreamDeltas(body: string): boolean {
  return parseSSEEvents(body).some((e) => e.choices?.[0]?.delta?.reasoning_content !== undefined);
}

/** Stream: the name of the first tool call seen across deltas. */
function streamToolCallName(body: string): string | undefined {
  for (const e of parseSSEEvents(body)) {
    const name = e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name;
    if (name) return name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fixtures — tool-only responses (no content)
// ---------------------------------------------------------------------------

const toolOnlyReasoningFixture: Fixture = {
  match: { userMessage: "think-tool" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
    reasoning: "Let me reason step by step.",
  },
};

const toolOnlyNoReasoningFixture: Fixture = {
  match: { userMessage: "plain-tool" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
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

function chatBody(userMessage: string, model: string, stream: boolean) {
  return {
    model,
    messages: [{ role: "user", content: userMessage }],
    stream,
  };
}

// ---------------------------------------------------------------------------
// Tests — tool-only response path reasoning capability gating
// ---------------------------------------------------------------------------

describe("/v1/chat/completions tool-only reasoning capability gating", () => {
  it("reasoning-capable model o3-mini: emits reasoning, tool_call intact, no warn (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think-tool", "o3-mini", false),
    );
    expect(res.status).toBe(200);
    expect(nonStreamReasoning(res.body)).toBe("Let me reason step by step.");
    expect(nonStreamToolCallName(res.body)).toBe("get_weather");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reasoning-capable model o3-mini: emits reasoning, tool_call intact, no warn (stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think-tool", "o3-mini", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamDeltas(res.body)).toBe(true);
    expect(streamToolCallName(res.body)).toBe("get_weather");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("non-reasoning model gpt-4.1, strict OFF: still emits reasoning but warns (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think-tool", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(nonStreamReasoning(res.body)).toBe("Let me reason step by step.");
    expect(nonStreamToolCallName(res.body)).toBe("get_weather");
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("gpt-4.1");
  });

  it("non-reasoning model gpt-4.1, strict OFF: still emits reasoning but warns (stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think-tool", "gpt-4.1", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamDeltas(res.body)).toBe(true);
    expect(streamToolCallName(res.body)).toBe("get_weather");
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("gpt-4.1");
  });

  it("non-reasoning model gpt-4.1, strict ON (header): suppresses reasoning, tool_call intact (non-stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think-tool", "gpt-4.1", false),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(nonStreamReasoning(res.body)).toBeUndefined();
    expect(nonStreamToolCallName(res.body)).toBe("get_weather");
  });

  it("non-reasoning model gpt-4.1, strict ON (header): suppresses reasoning, tool_call intact (stream)", async () => {
    instance = await createServer(allFixtures, { port: 0 });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("think-tool", "gpt-4.1", true),
      { "X-AIMock-Strict": "true" },
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamDeltas(res.body)).toBe(false);
    expect(streamToolCallName(res.body)).toBe("get_weather");
  });

  it("fixture with no reasoning, gpt-4.1: no-op, no warn, tool_call intact (non-stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("plain-tool", "gpt-4.1", false),
    );
    expect(res.status).toBe(200);
    expect(nonStreamReasoning(res.body)).toBeUndefined();
    expect(nonStreamToolCallName(res.body)).toBe("get_weather");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fixture with no reasoning, gpt-4.1: no-op, no warn, tool_call intact (stream)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { port: 0, logLevel: "warn" });
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatBody("plain-tool", "gpt-4.1", true),
    );
    expect(res.status).toBe(200);
    expect(hasReasoningStreamDeltas(res.body)).toBe(false);
    expect(streamToolCallName(res.body)).toBe("get_weather");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
