import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture, SSEChunk } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SSEChunkWithUsage extends SSEChunk {
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function parseAllSSEChunks(body: string): SSEChunkWithUsage[] {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}

function hasUsageChunk(chunks: SSEChunkWithUsage[]): boolean {
  return chunks.some((c) => c.usage !== undefined && c.choices.length === 0);
}

function getUsageChunk(chunks: SSEChunkWithUsage[]): SSEChunkWithUsage | undefined {
  return chunks.find((c) => c.usage !== undefined && c.choices.length === 0);
}

async function httpPost(url: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

describe("stream_options.include_usage", () => {
  const fixtures: Fixture[] = [
    {
      match: { userMessage: "hello" },
      response: { content: "Hello! How can I help?" },
    },
    {
      match: { userMessage: "tool-test" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    },
    {
      match: { userMessage: "mixed" },
      response: {
        content: "Let me check...",
        toolCalls: [{ name: "search", arguments: '{"q":"test"}' }],
      },
    },
  ];

  it("emits usage chunk when include_usage is true (text response)", async () => {
    instance = await createServer([...fixtures], { port: 0 });
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(200);

    const chunks = parseAllSSEChunks(res.body);
    expect(hasUsageChunk(chunks)).toBe(true);

    const usage = getUsageChunk(chunks)!;
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toBeDefined();
    expect(usage.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(usage.usage!.completion_tokens).toBeGreaterThan(0);
    expect(usage.usage!.total_tokens).toBe(
      usage.usage!.prompt_tokens + usage.usage!.completion_tokens,
    );
    // Usage chunk should be the last chunk (before [DONE])
    expect(chunks[chunks.length - 1]).toBe(usage);
  });

  it("does NOT emit usage chunk when include_usage is absent", async () => {
    instance = await createServer([...fixtures], { port: 0 });
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(200);

    const chunks = parseAllSSEChunks(res.body);
    expect(hasUsageChunk(chunks)).toBe(false);
  });

  it("does NOT emit usage chunk when include_usage is false", async () => {
    instance = await createServer([...fixtures], { port: 0 });
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      stream_options: { include_usage: false },
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(200);

    const chunks = parseAllSSEChunks(res.body);
    expect(hasUsageChunk(chunks)).toBe(false);
  });

  it("emits usage chunk for tool call responses", async () => {
    instance = await createServer([...fixtures], { port: 0 });
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "tool-test" }],
    });
    expect(res.status).toBe(200);

    const chunks = parseAllSSEChunks(res.body);
    const usage = getUsageChunk(chunks);
    expect(usage).toBeDefined();
    expect(usage!.choices).toEqual([]);
    expect(usage!.usage!.completion_tokens).toBeGreaterThan(0);
  });

  it("emits usage chunk for content+toolCalls responses", async () => {
    instance = await createServer([...fixtures], { port: 0 });
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "mixed" }],
    });
    expect(res.status).toBe(200);

    const chunks = parseAllSSEChunks(res.body);
    const usage = getUsageChunk(chunks);
    expect(usage).toBeDefined();
    expect(usage!.choices).toEqual([]);
    expect(usage!.usage!.total_tokens).toBeGreaterThan(0);
  });

  it("uses explicit fixture usage overrides in usage chunk", async () => {
    const fixturesWithUsage: Fixture[] = [
      {
        match: { userMessage: "explicit" },
        response: {
          content: "Hello!",
          usage: {
            prompt_tokens: 42,
            completion_tokens: 10,
            total_tokens: 52,
          },
        },
      },
    ];
    instance = await createServer(fixturesWithUsage, { port: 0 });
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "explicit" }],
    });
    expect(res.status).toBe(200);

    const chunks = parseAllSSEChunks(res.body);
    const usage = getUsageChunk(chunks);
    expect(usage).toBeDefined();
    expect(usage!.usage).toEqual({
      prompt_tokens: 42,
      completion_tokens: 10,
      total_tokens: 52,
    });
  });

  it("usage chunk shares id/model/created with content chunks", async () => {
    instance = await createServer([...fixtures], { port: 0 });
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(200);

    const chunks = parseAllSSEChunks(res.body);
    const contentChunk = chunks.find((c) => c.choices.length > 0);
    const usage = getUsageChunk(chunks);
    expect(contentChunk).toBeDefined();
    expect(usage).toBeDefined();
    expect(usage!.id).toBe(contentChunk!.id);
    expect(usage!.model).toBe(contentChunk!.model);
    expect(usage!.created).toBe(contentChunk!.created);
  });

  it("does not affect non-streaming requests", async () => {
    instance = await createServer([...fixtures], { port: 0 });
    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      stream: false,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(200);
    // Non-streaming should return regular JSON, no SSE
    const json = JSON.parse(res.body);
    expect(json.object).toBe("chat.completion");
    expect(json.usage).toBeDefined();
  });
});
