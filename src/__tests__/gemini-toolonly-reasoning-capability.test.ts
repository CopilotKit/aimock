import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
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
          ...headers,
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

function parseGeminiSSEChunks(body: string): GeminiChunk[] {
  const chunks: GeminiChunk[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      chunks.push(JSON.parse(line.slice(6)) as GeminiChunk);
    }
  }
  return chunks;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
}

interface GeminiChunk {
  candidates: {
    content: { role: string; parts: GeminiPart[] };
    finishReason?: string;
    index: number;
  }[];
}

// "thought parts" = parts emitted on the synthesized reasoning channel.
function thoughtParts(parts: GeminiPart[]): GeminiPart[] {
  return parts.filter((p) => p.thought === true);
}

function reasoningInChunks(chunks: GeminiChunk[]): boolean {
  return chunks.some((c) => thoughtParts(c.candidates[0].content.parts).length > 0);
}

function functionCallInChunks(chunks: GeminiChunk[]): boolean {
  return chunks.some((c) => c.candidates[0].content.parts.some((p) => p.functionCall));
}

// ---------------------------------------------------------------------------
// Fixtures — tool-only (no content) responses
// ---------------------------------------------------------------------------

const REASONING = "Let me think about which tool to call.";

const toolOnlyReasoningFixture: Fixture = {
  match: { userMessage: "call-with-reasoning" },
  response: {
    reasoning: REASONING,
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
  },
};

const toolOnlyNoReasoningFixture: Fixture = {
  match: { userMessage: "call-no-reasoning" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
  },
};

const allFixtures: Fixture[] = [toolOnlyReasoningFixture, toolOnlyNoReasoningFixture];

const GEN = "generateContent";
const STREAM_GEN = "streamGenerateContent";

function geminiUrl(base: string, model: string, op: string): string {
  return `${base}/v1beta/models/${model}:${op}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

describe("Gemini tool-only reasoning capability gating (non-streaming)", () => {
  it("emits a thought part for a reasoning-capable model, tool call intact", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "gemini-2.5-pro", GEN), {
      contents: [{ role: "user", parts: [{ text: "call-with-reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    const parts = body.candidates[0].content.parts;
    const thoughts = thoughtParts(parts);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe(REASONING);
    // Tool call still present.
    expect(parts.some((p) => p.functionCall?.name === "get_weather")).toBe(true);
  });

  it("strict ON: suppresses thought for a non-reasoning model, tool call intact", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-flash", GEN),
      { contents: [{ role: "user", parts: [{ text: "call-with-reasoning" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    const parts = body.candidates[0].content.parts;
    expect(thoughtParts(parts)).toHaveLength(0);
    expect(parts.some((p) => p.functionCall?.name === "get_weather")).toBe(true);
  });

  it("strict OFF: emits thought for a non-reasoning model but warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { logLevel: "warn" });
    const res = await post(geminiUrl(instance.url, "gemini-1.5-flash", GEN), {
      contents: [{ role: "user", parts: [{ text: "call-with-reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    expect(thoughtParts(body.candidates[0].content.parts)).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("gemini-1.5-flash");
  });

  it("emits a thought part for an unknown model (defaults to capable)", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "some-future-model", GEN), {
      contents: [{ role: "user", parts: [{ text: "call-with-reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    expect(thoughtParts(body.candidates[0].content.parts)).toHaveLength(1);
  });

  it("no-op when fixture carries no reasoning (no thought parts, no log)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    instance = await createServer(allFixtures, { logLevel: "warn" });
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-flash", GEN),
      { contents: [{ role: "user", parts: [{ text: "call-no-reasoning" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    const parts = body.candidates[0].content.parts;
    expect(thoughtParts(parts)).toHaveLength(0);
    expect(parts.some((p) => p.functionCall?.name === "get_weather")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("Gemini tool-only reasoning capability gating (streaming)", () => {
  it("emits thought chunks for a reasoning-capable model, function_call intact", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "gemini-2.5-pro", STREAM_GEN), {
      contents: [{ role: "user", parts: [{ text: "call-with-reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(true);
    expect(functionCallInChunks(chunks)).toBe(true);
  });

  it("strict ON: suppresses thought chunks for a non-reasoning model, function_call intact", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-flash", STREAM_GEN),
      { contents: [{ role: "user", parts: [{ text: "call-with-reasoning" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(false);
    expect(functionCallInChunks(chunks)).toBe(true);
  });

  it("strict OFF: emits thought chunks for a non-reasoning model and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { logLevel: "warn" });
    const res = await post(geminiUrl(instance.url, "gemini-1.5-flash", STREAM_GEN), {
      contents: [{ role: "user", parts: [{ text: "call-with-reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(true);
    expect(functionCallInChunks(chunks)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("no-op when fixture carries no reasoning (no thought chunks)", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "gemini-2.5-pro", STREAM_GEN), {
      contents: [{ role: "user", parts: [{ text: "call-no-reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(false);
    expect(functionCallInChunks(chunks)).toBe(true);
  });
});
