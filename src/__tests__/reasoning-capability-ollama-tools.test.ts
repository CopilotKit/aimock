import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";

// ---------------------------------------------------------------------------
// Reasoning capability gating on the Ollama /api/chat tool-bearing paths:
//   - content + toolCalls (combined response)
//   - tool-only (toolCalls without content)
//
// Mirrors reasoning-capability-ollama.test.ts (TEXT path) but exercises the
// tool builders, which previously dropped reasoning entirely. Non-reasoning
// ids are forced via AIMOCK_NONREASONING_MODELS (same mechanism the TEXT
// suite uses); unknown local ids fail open to reasoning-capable.
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: object,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function parseNDJSON(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const REASONING = "Let me reason about which tool to call.";

// Match on userMessage only so any requested model id routes to the same
// reasoning-bearing fixture; the model id drives the capability gate.
const fixtures: Fixture[] = [
  {
    // content + tool calls, with reasoning
    match: { userMessage: "combo" },
    response: {
      content: "Calling the tool now.",
      reasoning: REASONING,
      toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
    },
  },
  {
    // content + tool calls, no reasoning (no-op). Disjoint match string (not a
    // substring of "combo") so the router does not fall through to the
    // reasoning-bearing fixture above.
    match: { userMessage: "alphacontent" },
    response: {
      content: "Calling the tool now.",
      toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
    },
  },
  {
    // tool-only, with reasoning
    match: { userMessage: "toolonly" },
    response: {
      reasoning: REASONING,
      toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
    },
  },
  {
    // tool-only, no reasoning (no-op). Disjoint match string (not a substring
    // of "toolonly").
    match: { userMessage: "betatool" },
    response: {
      toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
    },
  },
];

let instance: ServerInstance | null = null;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

// ---------------------------------------------------------------------------
// content + toolCalls — reasoning-capable model emits reasoning + tool_calls
// ---------------------------------------------------------------------------

describe("Ollama /api/chat content+tool reasoning gating — capable model", () => {
  it("non-streaming: emits reasoning_content alongside content + tool_calls", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "combo" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.content).toBe("Calling the tool now.");
    expect(body.message.reasoning_content).toBe(REASONING);
    expect(body.message.tool_calls).toHaveLength(1);
    expect(body.message.tool_calls[0].function.name).toBe("get_weather");
  });

  it("streaming: emits reasoning_content chunks alongside content + tool_calls", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "combo" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as Array<{
      message: {
        content?: string;
        reasoning_content?: string;
        tool_calls?: Array<{ function: { name: string } }>;
      };
      done: boolean;
    }>;
    const reasoningChunks = chunks.filter(
      (c) => !c.done && c.message?.reasoning_content !== undefined,
    );
    expect(reasoningChunks.length).toBeGreaterThan(0);
    expect(reasoningChunks.map((c) => c.message.reasoning_content).join("")).toBe(REASONING);

    const toolChunk = chunks.find((c) => c.message?.tool_calls !== undefined);
    expect(toolChunk).toBeDefined();
    expect(toolChunk!.message.tool_calls![0].function.name).toBe("get_weather");
  });
});

describe("Ollama /api/chat content+tool reasoning gating — non-reasoning model", () => {
  it("strict ON: suppresses reasoning_content but keeps content + tool_calls (non-streaming)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/api/chat`,
      {
        model: "no-think-model",
        messages: [{ role: "user", content: "combo" }],
        stream: false,
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.content).toBe("Calling the tool now.");
    expect(body.message.reasoning_content).toBeUndefined();
    expect(body.message.tool_calls).toHaveLength(1);
  });

  it("strict ON: suppresses reasoning_content chunks but keeps tool_calls (streaming)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/api/chat`,
      {
        model: "no-think-model",
        messages: [{ role: "user", content: "combo" }],
        stream: true,
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as Array<{
      message: { reasoning_content?: string; tool_calls?: unknown[] };
      done: boolean;
    }>;
    const reasoningChunks = chunks.filter(
      (c) => !c.done && c.message?.reasoning_content !== undefined,
    );
    expect(reasoningChunks.length).toBe(0);
    const toolChunk = chunks.find((c) => c.message?.tool_calls !== undefined);
    expect(toolChunk).toBeDefined();
  });

  it("strict OFF: still emits reasoning_content (warn-by-default)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "no-think-model",
      messages: [{ role: "user", content: "combo" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.reasoning_content).toBe(REASONING);
  });
});

describe("Ollama /api/chat content+tool reasoning gating — no fixture reasoning", () => {
  it("no reasoning_content when fixture has no reasoning (non-streaming)", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "alphacontent" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.content).toBe("Calling the tool now.");
    expect(body.message.reasoning_content).toBeUndefined();
    expect(body.message.tool_calls).toHaveLength(1);
  });

  it("no reasoning_content when fixture has no reasoning (streaming)", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "alphacontent" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as Array<{
      message: { reasoning_content?: string };
      done: boolean;
    }>;
    const reasoningChunks = chunks.filter(
      (c) => !c.done && c.message?.reasoning_content !== undefined,
    );
    expect(reasoningChunks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tool-only — reasoning gating on the tool-call-only path
// ---------------------------------------------------------------------------

describe("Ollama /api/chat tool-only reasoning gating — capable model", () => {
  it("non-streaming: emits reasoning_content alongside tool_calls", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "toolonly" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.reasoning_content).toBe(REASONING);
    expect(body.message.tool_calls).toHaveLength(1);
    expect(body.message.tool_calls[0].function.name).toBe("get_weather");
  });

  it("streaming: emits reasoning_content chunks alongside tool_calls", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "toolonly" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as Array<{
      message: {
        reasoning_content?: string;
        tool_calls?: Array<{ function: { name: string } }>;
      };
      done: boolean;
    }>;
    const reasoningChunks = chunks.filter(
      (c) => !c.done && c.message?.reasoning_content !== undefined,
    );
    expect(reasoningChunks.length).toBeGreaterThan(0);
    expect(reasoningChunks.map((c) => c.message.reasoning_content).join("")).toBe(REASONING);

    const toolChunk = chunks.find((c) => c.message?.tool_calls !== undefined);
    expect(toolChunk).toBeDefined();
    expect(toolChunk!.message.tool_calls![0].function.name).toBe("get_weather");
  });
});

describe("Ollama /api/chat tool-only reasoning gating — non-reasoning model", () => {
  it("strict ON: suppresses reasoning_content but keeps tool_calls (non-streaming)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/api/chat`,
      {
        model: "no-think-model",
        messages: [{ role: "user", content: "toolonly" }],
        stream: false,
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.reasoning_content).toBeUndefined();
    expect(body.message.tool_calls).toHaveLength(1);
  });

  it("strict ON: suppresses reasoning_content chunks but keeps tool_calls (streaming)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/api/chat`,
      {
        model: "no-think-model",
        messages: [{ role: "user", content: "toolonly" }],
        stream: true,
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as Array<{
      message: { reasoning_content?: string; tool_calls?: unknown[] };
      done: boolean;
    }>;
    const reasoningChunks = chunks.filter(
      (c) => !c.done && c.message?.reasoning_content !== undefined,
    );
    expect(reasoningChunks.length).toBe(0);
    const toolChunk = chunks.find((c) => c.message?.tool_calls !== undefined);
    expect(toolChunk).toBeDefined();
  });
});

describe("Ollama /api/chat tool-only reasoning gating — no fixture reasoning", () => {
  it("no reasoning_content when fixture has no reasoning (non-streaming)", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "betatool" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.reasoning_content).toBeUndefined();
    expect(body.message.tool_calls).toHaveLength(1);
  });

  it("no reasoning_content when fixture has no reasoning (streaming)", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "betatool" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as Array<{
      message: { reasoning_content?: string };
      done: boolean;
    }>;
    const reasoningChunks = chunks.filter(
      (c) => !c.done && c.message?.reasoning_content !== undefined,
    );
    expect(reasoningChunks.length).toBe(0);
  });
});
