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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REASONING = "Let me think step by step about this.";

const textReasoningFixture: Fixture = {
  match: { userMessage: "explain" },
  response: { content: "The answer is 42.", reasoning: REASONING },
};

const textNoReasoningFixture: Fixture = {
  match: { userMessage: "plain" },
  response: { content: "No reasoning here." },
};

const contentWithToolsReasoningFixture: Fixture = {
  match: { userMessage: "tooled" },
  response: {
    content: "I will call a tool.",
    reasoning: REASONING,
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
  },
};

const allFixtures: Fixture[] = [
  textReasoningFixture,
  textNoReasoningFixture,
  contentWithToolsReasoningFixture,
];

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

describe("Gemini reasoning capability gating (non-streaming)", () => {
  it("emits thought parts for a reasoning-capable model", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "gemini-2.5-pro", GEN), {
      contents: [{ role: "user", parts: [{ text: "explain" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    const thoughts = thoughtParts(body.candidates[0].content.parts);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe(REASONING);
  });

  it("strict OFF: emits thought parts for a non-reasoning model but warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { logLevel: "warn" });
    const res = await post(geminiUrl(instance.url, "gemini-1.5-pro", GEN), {
      contents: [{ role: "user", parts: [{ text: "explain" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    expect(thoughtParts(body.candidates[0].content.parts)).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("gemini-1.5-pro");
  });

  it("strict ON: suppresses thought parts for a non-reasoning model", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-pro", GEN),
      { contents: [{ role: "user", parts: [{ text: "explain" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    expect(thoughtParts(body.candidates[0].content.parts)).toHaveLength(0);
    // Content is still present.
    expect(body.candidates[0].content.parts.some((p) => p.text === "The answer is 42.")).toBe(true);
  });

  it("emits thought parts for an unknown model (defaults to capable)", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "some-future-model", GEN), {
      contents: [{ role: "user", parts: [{ text: "explain" }] }],
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
      geminiUrl(instance.url, "gemini-1.5-pro", GEN),
      { contents: [{ role: "user", parts: [{ text: "plain" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    expect(thoughtParts(body.candidates[0].content.parts)).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("strict ON: suppresses reasoning on the content+toolCalls path", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-pro", GEN),
      { contents: [{ role: "user", parts: [{ text: "tooled" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    expect(thoughtParts(body.candidates[0].content.parts)).toHaveLength(0);
    // Tool call still present.
    expect(body.candidates[0].content.parts.some((p) => p.functionCall)).toBe(true);
  });

  it("content+toolCalls path emits reasoning for a capable model", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "gemini-2.5-pro", GEN), {
      contents: [{ role: "user", parts: [{ text: "tooled" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    expect(thoughtParts(body.candidates[0].content.parts)).toHaveLength(1);
  });
});

describe("Gemini reasoning capability gating (streaming)", () => {
  it("emits thought chunks for a reasoning-capable model", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "gemini-2.5-pro", STREAM_GEN), {
      contents: [{ role: "user", parts: [{ text: "explain" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(true);
  });

  it("strict ON: suppresses thought chunks for a non-reasoning model", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-pro", STREAM_GEN),
      { contents: [{ role: "user", parts: [{ text: "explain" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(false);
    // Content chunks still present.
    const fullText = chunks.map((c) => c.candidates[0].content.parts[0]?.text ?? "").join("");
    expect(fullText).toContain("The answer is 42.");
  });

  it("strict OFF: emits thought chunks for a non-reasoning model and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { logLevel: "warn" });
    const res = await post(geminiUrl(instance.url, "gemini-1.5-pro", STREAM_GEN), {
      contents: [{ role: "user", parts: [{ text: "explain" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("strict ON: suppresses reasoning on the streaming content+toolCalls path", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-pro", STREAM_GEN),
      { contents: [{ role: "user", parts: [{ text: "tooled" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(false);
    expect(chunks.some((c) => c.candidates[0].content.parts.some((p) => p.functionCall))).toBe(
      true,
    );
  });
});
