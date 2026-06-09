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
  inlineData?: { mimeType: string; data: string };
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

function allParts(chunks: GeminiChunk[]): GeminiPart[] {
  return chunks.flatMap((c) => c.candidates[0].content.parts);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REASONING = "User wants audio plus a lookup.";

// An audio turn carrying a companion reasoning channel, text content, and a
// tool call — the full companion set the recorder can preserve on an audio
// fixture. The capability gate must only suppress the reasoning companion.
const audioReasoningFixture: Fixture = {
  match: { userMessage: "audio reasoning" },
  response: {
    audio: "SGVsbG8=",
    format: "mp3",
    content: "Here is the audio you asked for.",
    reasoning: REASONING,
    toolCalls: [{ id: "call_1", name: "lookup", arguments: '{"query":"weather"}' }],
  },
};

// An audio turn with no reasoning channel — gating must be a no-op (no thought
// part, and no warn/error log even under strict).
const audioNoReasoningFixture: Fixture = {
  match: { userMessage: "audio plain" },
  response: { audio: "SGVsbG8=", format: "mp3", content: "Just audio." },
};

const allFixtures: Fixture[] = [audioReasoningFixture, audioNoReasoningFixture];

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

describe("Gemini audio reasoning capability gating (non-streaming)", () => {
  it("emits the thought companion for a reasoning-capable model", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "gemini-2.5-pro", GEN), {
      contents: [{ role: "user", parts: [{ text: "audio reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    const parts = body.candidates[0].content.parts;
    const thoughts = thoughtParts(parts);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe(REASONING);
    // Audio companion intact and first.
    expect(parts[0].inlineData).toEqual({ mimeType: "audio/mpeg", data: "SGVsbG8=" });
  });

  it("strict ON: suppresses the thought companion for a non-reasoning model, leaving audio/content/toolCalls intact", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-flash", GEN),
      { contents: [{ role: "user", parts: [{ text: "audio reasoning" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    const parts = body.candidates[0].content.parts;
    // Reasoning companion suppressed.
    expect(thoughtParts(parts)).toHaveLength(0);
    // Audio still present and first.
    expect(parts[0].inlineData).toEqual({ mimeType: "audio/mpeg", data: "SGVsbG8=" });
    // Content companion intact.
    expect(parts.some((p) => p.text === "Here is the audio you asked for." && !p.thought)).toBe(
      true,
    );
    // Tool call companion intact + FUNCTION_CALL finish reason.
    const fc = parts.find((p) => p.functionCall);
    expect(fc?.functionCall?.name).toBe("lookup");
    expect(body.candidates[0].finishReason).toBe("FUNCTION_CALL");
  });

  it("strict OFF: emits the thought companion for a non-reasoning model but warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { logLevel: "warn" });
    const res = await post(geminiUrl(instance.url, "gemini-1.5-flash", GEN), {
      contents: [{ role: "user", parts: [{ text: "audio reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    expect(thoughtParts(body.candidates[0].content.parts)).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("gemini-1.5-flash");
  });

  it("emits the thought companion for an unknown model (defaults to capable)", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "lyria-3", GEN), {
      contents: [{ role: "user", parts: [{ text: "audio reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    expect(thoughtParts(body.candidates[0].content.parts)).toHaveLength(1);
  });

  it("no-op when the audio fixture carries no reasoning (no thought part, no log)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    instance = await createServer(allFixtures, { logLevel: "warn" });
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-flash", GEN),
      { contents: [{ role: "user", parts: [{ text: "audio plain" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as GeminiChunk;
    const parts = body.candidates[0].content.parts;
    expect(thoughtParts(parts)).toHaveLength(0);
    expect(parts[0].inlineData).toEqual({ mimeType: "audio/mpeg", data: "SGVsbG8=" });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("Gemini audio reasoning capability gating (streaming)", () => {
  it("emits the thought companion chunk for a reasoning-capable model", async () => {
    instance = await createServer(allFixtures);
    const res = await post(geminiUrl(instance.url, "gemini-2.5-pro", STREAM_GEN), {
      contents: [{ role: "user", parts: [{ text: "audio reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(true);
  });

  it("strict ON: suppresses the thought companion chunk for a non-reasoning model, leaving audio/content/toolCalls intact", async () => {
    instance = await createServer(allFixtures);
    const res = await post(
      geminiUrl(instance.url, "gemini-1.5-flash", STREAM_GEN),
      { contents: [{ role: "user", parts: [{ text: "audio reasoning" }] }] },
      { "X-AIMock-Strict": "true" },
    );

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    const parts = allParts(chunks);
    // Reasoning companion suppressed.
    expect(reasoningInChunks(chunks)).toBe(false);
    // Audio still present.
    expect(parts.some((p) => p.inlineData)).toBe(true);
    // Content companion intact.
    expect(parts.some((p) => p.text === "Here is the audio you asked for." && !p.thought)).toBe(
      true,
    );
    // Tool call companion intact + FUNCTION_CALL finish reason.
    expect(parts.some((p) => p.functionCall?.name === "lookup")).toBe(true);
    expect(chunks.some((c) => c.candidates[0].finishReason === "FUNCTION_CALL")).toBe(true);
  });

  it("strict OFF: emits the thought companion chunk for a non-reasoning model and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    instance = await createServer(allFixtures, { logLevel: "warn" });
    const res = await post(geminiUrl(instance.url, "gemini-1.5-flash", STREAM_GEN), {
      contents: [{ role: "user", parts: [{ text: "audio reasoning" }] }],
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    expect(reasoningInChunks(chunks)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
