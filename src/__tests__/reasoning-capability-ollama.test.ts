import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
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

const REASONING = "Let me think step by step about this problem.";

// Match on userMessage only so any requested model id routes to the same
// reasoning-bearing fixture; the model id drives the capability gate.
const fixtures: Fixture[] = [
  {
    match: { userMessage: "think" },
    response: { content: "The answer is 42.", reasoning: REASONING },
  },
  {
    match: { userMessage: "plain" },
    response: { content: "Just plain text." },
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
// /api/chat — reasoning-capable model emits reasoning
// ---------------------------------------------------------------------------

describe("Ollama /api/chat reasoning gating — reasoning-capable model", () => {
  it("non-streaming: reasoning-capable id emits reasoning_content", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "think" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.content).toBe("The answer is 42.");
    expect(body.message.reasoning_content).toBe(REASONING);
  });

  it("streaming: reasoning-capable id emits reasoning_content chunks", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "deepseek-r1",
      messages: [{ role: "user", content: "think" }],
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
    expect(reasoningChunks.length).toBeGreaterThan(0);
    expect(reasoningChunks.map((c) => c.message.reasoning_content).join("")).toBe(REASONING);
  });
});

// ---------------------------------------------------------------------------
// /api/chat — non-reasoning model (forced via env override): warn vs suppress
// ---------------------------------------------------------------------------

describe("Ollama /api/chat reasoning gating — non-reasoning model", () => {
  it("strict OFF: still emits reasoning_content (warn-by-default)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "no-think-model",
      messages: [{ role: "user", content: "think" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.content).toBe("The answer is 42.");
    expect(body.message.reasoning_content).toBe(REASONING);
  });

  it("strict ON: suppresses reasoning_content (non-streaming)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/api/chat`,
      {
        model: "no-think-model",
        messages: [{ role: "user", content: "think" }],
        stream: false,
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.content).toBe("The answer is 42.");
    expect(body.message.reasoning_content).toBeUndefined();
  });

  it("strict ON: suppresses reasoning_content chunks (streaming)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/api/chat`,
      {
        model: "no-think-model",
        messages: [{ role: "user", content: "think" }],
        stream: true,
      },
      { "X-AIMock-Strict": "true" },
    );

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
// /api/chat — unknown local model id defaults to reasoning-capable (emit)
// ---------------------------------------------------------------------------

describe("Ollama /api/chat reasoning gating — unknown local model", () => {
  it("unknown local id emits reasoning (fail-open default)", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "llama3.1",
      messages: [{ role: "user", content: "think" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.reasoning_content).toBe(REASONING);
  });

  it("unknown local id, strict ON, still emits (unknown defaults capable)", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/api/chat`,
      {
        model: "mistral",
        messages: [{ role: "user", content: "think" }],
        stream: false,
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.reasoning_content).toBe(REASONING);
  });
});

// ---------------------------------------------------------------------------
// /api/chat — no fixture reasoning is a no-op
// ---------------------------------------------------------------------------

describe("Ollama /api/chat reasoning gating — no fixture reasoning", () => {
  it("no reasoning_content when fixture has no reasoning (even non-reasoning model)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/chat`, {
      model: "no-think-model",
      messages: [{ role: "user", content: "plain" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message.content).toBe("Just plain text.");
    expect(body.message.reasoning_content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /api/generate — same gating on the generate path
// ---------------------------------------------------------------------------

describe("Ollama /api/generate reasoning gating", () => {
  it("reasoning-capable id emits reasoning_content (non-streaming)", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/generate`, {
      model: "deepseek-r1",
      prompt: "think",
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response).toBe("The answer is 42.");
    expect(body.reasoning_content).toBe(REASONING);
  });

  it("non-reasoning id, strict ON, suppresses reasoning_content (non-streaming)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/api/generate`,
      {
        model: "no-think-model",
        prompt: "think",
        stream: false,
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response).toBe("The answer is 42.");
    expect(body.reasoning_content).toBeUndefined();
  });

  it("non-reasoning id, strict OFF, still emits reasoning_content (warn-by-default)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/generate`, {
      model: "no-think-model",
      prompt: "think",
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.reasoning_content).toBe(REASONING);
  });

  it("non-reasoning id, strict ON, suppresses reasoning_content chunks (streaming)", async () => {
    vi.stubEnv("AIMOCK_NONREASONING_MODELS", "no-think-model");
    instance = await createServer(fixtures);
    const res = await httpPost(
      `${instance.url}/api/generate`,
      {
        model: "no-think-model",
        prompt: "think",
        stream: true,
      },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const chunks = parseNDJSON(res.body) as Array<{
      reasoning_content?: string;
      done: boolean;
    }>;
    const reasoningChunks = chunks.filter((c) => !c.done && c.reasoning_content !== undefined);
    expect(reasoningChunks.length).toBe(0);
  });

  it("unknown local id emits reasoning (fail-open default)", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/generate`, {
      model: "llama3.1",
      prompt: "think",
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.reasoning_content).toBe(REASONING);
  });

  it("no reasoning_content when fixture has no reasoning", async () => {
    instance = await createServer(fixtures);
    const res = await httpPost(`${instance.url}/api/generate`, {
      model: "deepseek-r1",
      prompt: "plain",
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response).toBe("Just plain text.");
    expect(body.reasoning_content).toBeUndefined();
  });
});
