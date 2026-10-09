/**
 * Ollama drift tests.
 *
 * Compares aimock's Ollama endpoint output shapes against a real Ollama
 * instance. Native comparisons skip unless OLLAMA_HOST is set.
 * Local K9 SDK regressions always run against aimock.
 *
 * Requires: OLLAMA_HOST env var (e.g. http://localhost:11434)
 */

import { Ollama, type ChatResponse } from "ollama";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { withFaultFixture } from "../helpers/misbehavior-server.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Environment-based opt-in (consistent with other drift files)
// ---------------------------------------------------------------------------

// Accept both a full base URL ("http://127.0.0.1:11434") and Ollama's native
// host:port form ("127.0.0.1:11434" — the value the daemon itself uses). The
// test issues real HTTP requests, so a scheme is required; prefix http:// when
// one is absent.
const RAW_OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_HOST = /^https?:\/\//.test(RAW_OLLAMA_HOST)
  ? RAW_OLLAMA_HOST
  : `http://${RAW_OLLAMA_HOST}`;

// The model to exercise against the live daemon. Defaults to "llama3.2" for a
// local developer run, but CI provisions a much smaller model (to keep the
// daemon pull cheap) and points the leg at it via OLLAMA_MODEL. Both /api/chat
// and /api/generate use the same model.
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// SDK shape stubs
// ---------------------------------------------------------------------------

/**
 * Minimal Ollama /api/chat response shape (non-streaming final message).
 */
function ollamaChatResponseShape() {
  return extractShape({
    model: "llama3.2",
    created_at: "2024-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "Hello!",
    },
    done: true,
    done_reason: "stop",
    total_duration: 1000000,
    load_duration: 100000,
    prompt_eval_count: 10,
    prompt_eval_duration: 500000,
    eval_count: 5,
    eval_duration: 400000,
  });
}

/**
 * Minimal Ollama /api/generate response shape (non-streaming).
 */
function ollamaGenerateResponseShape() {
  return extractShape({
    model: "llama3.2",
    created_at: "2024-01-01T00:00:00Z",
    response: "Hello!",
    done: true,
    done_reason: "stop",
    total_duration: 1000000,
    load_duration: 100000,
    prompt_eval_count: 10,
    prompt_eval_duration: 500000,
    eval_count: 5,
    eval_duration: 400000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Streaming shape stubs
// ---------------------------------------------------------------------------

/**
 * Minimal Ollama /api/chat streaming chunk shape (non-final).
 */
function ollamaChatStreamChunkShape() {
  return extractShape({
    model: "llama3.2",
    created_at: "2024-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "H",
    },
    done: false,
  });
}

function parseNDJSON(body: string): object[] {
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as object);
}

describe.skipIf(!process.env.OLLAMA_HOST)("Ollama drift", () => {
  it("/api/chat response shape matches", async () => {
    const sdkShape = ollamaChatResponseShape();

    const body = {
      model: OLLAMA_MODEL,
      messages: [{ role: "user", content: "Say hello" }],
      stream: false,
    };

    const [realRes, mockRes] = await Promise.all([
      httpPost(`${OLLAMA_HOST}/api/chat`, body),
      httpPost(`${instance.url}/api/chat`, body),
    ]);

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      const realShape = extractShape(JSON.parse(realRes.body));
      const mockShape = extractShape(JSON.parse(mockRes.body));

      const diffs = triangulate(sdkShape, realShape, mockShape);
      const report = formatDriftReport("Ollama /api/chat", diffs, "ollama");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });

  it("/api/chat streaming NDJSON chunk shapes match", async () => {
    const sdkChunkShape = ollamaChatStreamChunkShape();

    const body = {
      model: OLLAMA_MODEL,
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    };

    const [realRes, mockRes] = await Promise.all([
      httpPost(`${OLLAMA_HOST}/api/chat`, body),
      httpPost(`${instance.url}/api/chat`, body),
    ]);

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      const realChunks = parseNDJSON(realRes.body);
      const mockChunks = parseNDJSON(mockRes.body);

      expect(realChunks.length).toBeGreaterThan(0);
      expect(mockChunks.length).toBeGreaterThan(0);

      // Compare first (non-final) chunk shapes
      const realFirstShape = extractShape(realChunks[0]);
      const mockFirstShape = extractShape(mockChunks[0]);

      const diffs = triangulate(sdkChunkShape, realFirstShape, mockFirstShape);
      const report = formatDriftReport("Ollama /api/chat (streaming chunk)", diffs, "ollama");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });

  it("/api/generate response shape matches", async () => {
    const sdkShape = ollamaGenerateResponseShape();

    const body = {
      model: OLLAMA_MODEL,
      prompt: "Say hello",
      stream: false,
    };

    const [realRes, mockRes] = await Promise.all([
      httpPost(`${OLLAMA_HOST}/api/generate`, body),
      httpPost(`${instance.url}/api/generate`, body),
    ]);

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      const realShape = extractShape(JSON.parse(realRes.body));
      const mockShape = extractShape(JSON.parse(mockRes.body));

      const diffs = triangulate(sdkShape, realShape, mockShape);
      const report = formatDriftReport("Ollama /api/generate", diffs, "ollama");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });
});

// Local SDK comparisons stay outside the native host gate. Capture actual bytes
// before handing the same complete body to the SDK; never serialize SDK values
// and label them as wire evidence. Ollama's SDK does not retry requests.
type LocalOllamaBody = {
  bytes: Buffer<ArrayBuffer>;
  body: string;
  status: number;
  contentType: string | null;
};

async function readLocalOllamaBody(response: Response, onRead?: (body: LocalOllamaBody) => void) {
  if (!response.body) throw new Error("Missing Ollama response body");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) throw new Error("Ollama response exceeds 262144 bytes");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(parts);
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const observed = {
    bytes,
    body,
    status: response.status,
    contentType: response.headers.get("content-type"),
  };
  onRead?.(observed);
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${body}`);
  return observed;
}

let ollamaLocalK9Passed = 0;

for (const cell of [
  { name: "object tools", stream: false, mixed: false },
  { name: "stream tools", stream: true, mixed: false },
  { name: "stream mixed", stream: true, mixed: true },
]) {
  it(`P1 Ollama K9 local ${cell.name}`, async () => {
    await withFaultFixture(
      { faults: [{ fault: "reasoning-only", reasoning: "Checking carefully." }] },
      async ({ mock, url }) => {
        const wire: Awaited<ReturnType<typeof readLocalOllamaBody>>[] = [];
        const requests: { url: string; body: unknown }[] = [];
        const client = new Ollama({
          host: url,
          fetch: async (input, init) => {
            requests.push({ url: String(input), body: init?.body });
            const response = await fetch(input, { ...init, signal: AbortSignal.timeout(5000) });
            const observed = await readLocalOllamaBody(response, (body) => wire.push(body));
            return new Response(observed.bytes, {
              status: response.status,
              headers: response.headers,
            });
          },
        });
        const request = {
          model: "local-ollama",
          messages: [{ role: "user", content: "weather" }],
        };
        const chunks: ChatResponse[] = [];
        try {
          if (cell.stream) {
            for await (const chunk of await client.chat({ ...request, stream: true }))
              chunks.push(chunk);
          } else chunks.push(await client.chat({ ...request, stream: false }));
        } finally {
          console.log(
            JSON.stringify({
              cell: cell.name,
              requests,
              attempts: requests.length,
              wire: wire.map(({ bytes, ...response }) => ({
                ...response,
                rawBase64: bytes.toString("base64"),
                byteLength: bytes.length,
              })),
              sdkChunks: chunks,
              journal: mock
                .getRequests()
                .map(({ method, path, body, response }) => ({ method, path, body, response })),
            }),
          );
        }
        expect(requests).toHaveLength(1);
        expect(wire).toHaveLength(1);
        expect(wire[0].status).toBe(200);
        expect(wire[0].contentType).toContain(
          cell.stream ? "application/x-ndjson" : "application/json",
        );
        if (cell.stream) expect(wire[0].body.endsWith("\n")).toBe(true);
        const records: unknown[] = cell.stream
          ? wire[0].body
              .trimEnd()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [JSON.parse(wire[0].body)];
        expect(records).toEqual(chunks);
        expect(chunks.map((c) => c.message.thinking ?? "").join("")).toBe("Checking carefully.");
        expect(chunks.map((c) => c.message.content).join("")).toBe("");
        expect(chunks.flatMap((c) => c.message.tool_calls ?? [])).toEqual([]);
        expect(chunks.filter((c) => c.done)).toHaveLength(1);
        expect(chunks.slice(0, -1).every((c) => c.done === false)).toBe(true);
        expect(chunks.at(-1)?.done).toBe(true);
        expect(chunks.at(-1)?.done_reason).toBe("length");
        expect(wire[0].body).not.toContain("reasoning_content");
        expect(wire[0].body).not.toContain("Answer to suppress");
        expect(mock.getRequests()).toHaveLength(1);
        expect(mock.getLastRequest()?.response.misbehavior?.applied).toBe(true);
        ollamaLocalK9Passed++;
      },
      {
        response: {
          ...(cell.mixed ? { content: "Answer to suppress" } : {}),
          toolCalls: [{ name: "weather", arguments: { city: "Paris" } }],
        },
      },
    );
  }, 55000);
}

// These are transport controls served over real loopback HTTP, not LLM replies.
for (const failure of ["http", "interrupted", "limit", "deadline", "utf8"] as const) {
  it(`P1 Ollama local transport rejects ${failure}`, async () => {
    const server = createServer((_request, response) => {
      response.writeHead(failure === "http" ? 503 : 200, {
        "content-type": "application/octet-stream",
        ...(failure === "interrupted" ? { "content-length": "100", connection: "close" } : {}),
      });
      response.flushHeaders();
      if (failure === "deadline") return;
      if (failure === "interrupted") {
        response.end("short");
        return;
      }
      response.end(
        failure === "limit"
          ? Buffer.alloc(262145)
          : failure === "utf8"
            ? Buffer.from([255])
            : "unavailable",
      );
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing transport port");
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        signal: AbortSignal.timeout(failure === "deadline" ? 100 : 5000),
      });
      const result = readLocalOllamaBody(response);
      if (failure === "http") await expect(result).rejects.toThrow("Ollama HTTP 503");
      else if (failure === "limit") await expect(result).rejects.toThrow("exceeds 262144 bytes");
      else if (failure === "interrupted") await expect(result).rejects.toThrow("terminated");
      else await expect(result).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 55000);
}

// Original S5-Ollama native-k9-{object,stream}-raw.bin, captured 2026-10-08
// on gemma4:26b. Hashes cover original bytes, including all 23 NDJSON records.
const ollamaK9Captures = [
  {
    mode: "object",
    sha256: "861739a918b6be3b8a1ef31d26a6ef9f63748325dc7bb444547f666703623ad0",
    base64:
      "eyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDoyNi4xMTg0ODlaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiKiAgIE9iamVjdDogUmVndWxhciBpY29zYWhlZHJvbiAoMTIgdmVydGljZXMsIDMwIGVkZ2VzLCAyMCBmYWNlcykuXG4gICAgKiAgIENvbG9yczoifSwiZG9uZSI6dHJ1ZSwiZG9uZV9yZWFzb24iOiJsZW5ndGgiLCJ0b3RhbF9kdXJhdGlvbiI6MTgyNDQ2NzE2NjYsImxvYWRfZHVyYXRpb24iOjE3NDQ2ODM2NjY2LCJwcm9tcHRfZXZhbF9jb3VudCI6NjksInByb21wdF9ldmFsX2R1cmF0aW9uIjoxMDA1MTIwMDAsImV2YWxfY291bnQiOjMyLCJldmFsX2R1cmF0aW9uIjo1NzczNDEwMDB9",
    status: 200,
    contentType: "application/json; charset=utf-8",
  },
  {
    mode: "stream",
    sha256: "b11fc007ede79c3b9eafd5fbb6622f0226cf50ee480b1a20be47980dda7ae357",
    base64:
      "eyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDo0NS42MzMyNFoiLCJtZXNzYWdlIjp7InJvbGUiOiJhc3Npc3RhbnQiLCJjb250ZW50IjoiIiwidGhpbmtpbmciOiIqIn0sImRvbmUiOmZhbHNlfQp7Im1vZGVsIjoiZ2VtbWE0OjI2YiIsImNyZWF0ZWRfYXQiOiIyMDI2LTEwLTA4VDIzOjAwOjQ1LjY2MjVaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiICAgT2JqZWN0In0sImRvbmUiOmZhbHNlfQp7Im1vZGVsIjoiZ2VtbWE0OjI2YiIsImNyZWF0ZWRfYXQiOiIyMDI2LTEwLTA4VDIzOjAwOjQ1LjY5NDY3NVoiLCJtZXNzYWdlIjp7InJvbGUiOiJhc3Npc3RhbnQiLCJjb250ZW50IjoiIiwidGhpbmtpbmciOiI6In0sImRvbmUiOmZhbHNlfQp7Im1vZGVsIjoiZ2VtbWE0OjI2YiIsImNyZWF0ZWRfYXQiOiIyMDI2LTEwLTA4VDIzOjAwOjQ1LjY5NDY5MloiLCJtZXNzYWdlIjp7InJvbGUiOiJhc3Npc3RhbnQiLCJjb250ZW50IjoiIiwidGhpbmtpbmciOiIgUmVndWxhciJ9LCJkb25lIjpmYWxzZX0KeyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDo0NS42OTQ4MDlaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiIGljb3NhIn0sImRvbmUiOmZhbHNlfQp7Im1vZGVsIjoiZ2VtbWE0OjI2YiIsImNyZWF0ZWRfYXQiOiIyMDI2LTEwLTA4VDIzOjAwOjQ1LjcyNjUyNVoiLCJtZXNzYWdlIjp7InJvbGUiOiJhc3Npc3RhbnQiLCJjb250ZW50IjoiIiwidGhpbmtpbmciOiJoZWRyb24ifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDUuNzI2NTdaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiICgifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDUuNzU5ODY2WiIsIm1lc3NhZ2UiOnsicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOiIiLCJ0aGlua2luZyI6IjEifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDUuNzU5OTEzWiIsIm1lc3NhZ2UiOnsicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOiIiLCJ0aGlua2luZyI6IjIifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDUuNzU5OTc1WiIsIm1lc3NhZ2UiOnsicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOiIiLCJ0aGlua2luZyI6IiB2ZXJ0aWNlcyJ9LCJkb25lIjpmYWxzZX0KeyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDo0NS43NjAwMTRaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiLCJ9LCJkb25lIjpmYWxzZX0KeyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDo0NS43OTMzOTRaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiIDMifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDUuNzkzNjM0WiIsIm1lc3NhZ2UiOnsicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOiIiLCJ0aGlua2luZyI6IjAifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDUuNzkzNjQ2WiIsIm1lc3NhZ2UiOnsicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOiIiLCJ0aGlua2luZyI6IiBlZGdlcyJ9LCJkb25lIjpmYWxzZX0KeyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDo0NS44OTIyNDdaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiLCJ9LCJkb25lIjpmYWxzZX0KeyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDo0NS44OTMwMzJaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiIDIifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDUuODkzMTM0WiIsIm1lc3NhZ2UiOnsicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOiIiLCJ0aGlua2luZyI6IjAifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDUuOTM3OTUzWiIsIm1lc3NhZ2UiOnsicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOiIiLCJ0aGlua2luZyI6IiBmYWNlcyJ9LCJkb25lIjpmYWxzZX0KeyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDo0NS45Mzc5ODFaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiKS4ifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDYuMDE3NjcyWiIsIm1lc3NhZ2UiOnsicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOiIiLCJ0aGlua2luZyI6IlxuICAgICoifSwiZG9uZSI6ZmFsc2V9CnsibW9kZWwiOiJnZW1tYTQ6MjZiIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMDhUMjM6MDA6NDYuMDE3ODM3WiIsIm1lc3NhZ2UiOnsicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOiIiLCJ0aGlua2luZyI6IiAgIENvbG9ycyJ9LCJkb25lIjpmYWxzZX0KeyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDo0Ni4wMTc4OTJaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiIsInRoaW5raW5nIjoiOiJ9LCJkb25lIjpmYWxzZX0KeyJtb2RlbCI6ImdlbW1hNDoyNmIiLCJjcmVhdGVkX2F0IjoiMjAyNi0xMC0wOFQyMzowMDo0Ni4wMTgyNThaIiwibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6IiJ9LCJkb25lIjp0cnVlLCJkb25lX3JlYXNvbiI6Imxlbmd0aCIsInRvdGFsX2R1cmF0aW9uIjoxOTg5ODAwNzIwOCwibG9hZF9kdXJhdGlvbiI6MTkzNjAwMzQ3OTEsInByb21wdF9ldmFsX2NvdW50Ijo2OSwicHJvbXB0X2V2YWxfZHVyYXRpb24iOjEwNjc1MTAwMCwiZXZhbF9jb3VudCI6MzIsImV2YWxfZHVyYXRpb24iOjQyODA4MTAwMH0K",
    status: 200,
    contentType: "application/x-ndjson",
  },
];

type OllamaK9Raw = { status: number; contentType: string; bytes: Uint8Array; complete: boolean };
function ollamaRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported Ollama K9 object");
  return value as Record<string, unknown>;
}
function readOllamaK9(raw: OllamaK9Raw, stream: boolean) {
  if (!raw.complete || raw.status !== 200 || raw.bytes.byteLength > 262144)
    throw new Error("Incomplete or unsuccessful Ollama K9 response");
  if (
    raw.contentType.split(";")[0].trim() !== (stream ? "application/x-ndjson" : "application/json")
  )
    throw new Error("Unexpected Ollama K9 content type");
  const body = new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes);
  if (stream && !body.endsWith("\n")) throw new Error("Incomplete Ollama NDJSON framing");
  const records = (
    stream
      ? body
          .slice(0, -1)
          .split("\n")
          .map((line) => JSON.parse(line))
      : [JSON.parse(body)]
  ).map(ollamaRecord);
  let thinking = "";
  let model: string | undefined;
  for (const [index, record] of records.entries()) {
    if (
      "error" in record ||
      typeof record.model !== "string" ||
      !record.model ||
      typeof record.created_at !== "string" ||
      !Number.isFinite(Date.parse(record.created_at))
    )
      throw new Error("Unsupported Ollama K9 metadata");
    model ??= record.model;
    if (record.model !== model) throw new Error("Ollama model changed within response");
    const message = ollamaRecord(record.message);
    if (
      message.role !== "assistant" ||
      typeof message.content !== "string" ||
      (message.thinking !== undefined && typeof message.thinking !== "string") ||
      (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) ||
      "reasoning_content" in message
    )
      throw new Error("Unsupported Ollama K9 message");
    if (
      message.content !== "" ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length !== 0)
    )
      throw new Error("Ollama K9 NOT_TRIGGERED: visible output");
    thinking += message.thinking ?? "";
    const final = index === records.length - 1;
    if (
      record.done !== final ||
      (final ? record.done_reason !== "length" : record.done_reason !== undefined)
    )
      throw new Error("Invalid Ollama K9 terminal");
    for (const key of [
      "total_duration",
      "load_duration",
      "prompt_eval_count",
      "prompt_eval_duration",
      "eval_count",
      "eval_duration",
    ]) {
      const value = record[key];
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      )
        throw new Error(`Invalid Ollama K9 ${key}`);
    }
  }
  if (!thinking.trim()) throw new Error("Ollama K9 NOT_TRIGGERED: no thinking");
  return { records, thinking, model, content: "", tools: [], done: true, doneReason: "length" };
}
for (const capture of ollamaK9Captures) {
  const stream = capture.mode === "stream";
  const raw = { ...capture, bytes: Buffer.from(capture.base64, "base64"), complete: true };
  it(`P1 Ollama K9 captured ${capture.mode}`, () => {
    expect(createHash("sha256").update(raw.bytes).digest("hex")).toBe(capture.sha256);
    expect(() => readOllamaK9(raw, stream)).not.toThrow();
  });
  it(`P1 Ollama K9 captured ${capture.mode} compares with local SDK`, async () => {
    const control = readOllamaK9(raw, stream);
    await withFaultFixture(
      { faults: [{ fault: "reasoning-only", reasoning: control.thinking }] },
      async ({ url }) => {
        const wire: LocalOllamaBody[] = [];
        const client = new Ollama({
          host: url,
          fetch: async (input, init) => {
            const response = await fetch(input, { ...init, signal: AbortSignal.timeout(5000) });
            const observed = await readLocalOllamaBody(response, (body) => wire.push(body));
            return new Response(observed.bytes, {
              status: observed.status,
              headers: response.headers,
            });
          },
        });
        const chunks: ChatResponse[] = [];
        const request = { model: "local-ollama", messages: [{ role: "user", content: "weather" }] };
        if (stream) {
          for await (const chunk of await client.chat({ ...request, stream: true }))
            chunks.push(chunk);
        } else chunks.push(await client.chat({ ...request, stream: false }));
        expect(wire).toHaveLength(1);
        const target = readOllamaK9(
          { ...wire[0], contentType: wire[0].contentType ?? "", complete: true },
          stream,
        );
        expect(target.records).toEqual(chunks);
        expect([
          target.thinking,
          target.content,
          target.tools,
          target.done,
          target.doneReason,
        ]).toEqual([
          control.thinking,
          control.content,
          control.tools,
          control.done,
          control.doneReason,
        ]);
        console.log(
          JSON.stringify({
            cell: `captured ${capture.mode} local comparison`,
            request,
            nativeCaptureSha256: capture.sha256,
            sdkChunks: chunks,
            wire: wire.map(({ bytes, ...response }) => ({
              ...response,
              rawBase64: bytes.toString("base64"),
              byteLength: bytes.length,
            })),
          }),
        );
      },
    );
  }, 55000);
  for (const mutation of [
    "incomplete",
    "status",
    "content-type",
    "utf8",
    "json",
    "visible",
    "thinking",
    "tools",
    "terminal",
    "done",
    "model",
    "usage",
    "fractional-usage",
    "role",
  ] as const) {
    it(`P1 Ollama K9 derivative ${capture.mode} ${mutation}`, () => {
      const derivative = { ...raw };
      const records = stream
        ? parseNDJSON(raw.bytes.toString("utf8"))
        : [JSON.parse(raw.bytes.toString("utf8"))];
      if (mutation === "incomplete") derivative.complete = false;
      else if (mutation === "status") derivative.status = 500;
      else if (mutation === "content-type") derivative.contentType = "text/plain";
      else if (mutation === "utf8") derivative.bytes = Buffer.from([255]);
      else if (mutation === "json") derivative.bytes = raw.bytes.subarray(0, raw.bytes.length - 2);
      else {
        const first = records[0];
        const last = records.at(-1);
        if (mutation === "visible") first.message.content = "visible derivative";
        if (mutation === "thinking") first.message.thinking = 42;
        if (mutation === "tools")
          first.message.tool_calls = [{ function: { name: "derivative", arguments: {} } }];
        if (mutation === "terminal") last.done_reason = "stop";
        if (mutation === "done") last.done = false;
        if (mutation === "model") first.model = 42;
        if (mutation === "role") first.message.role = "user";
        if (mutation === "usage") last.eval_count = -1;
        if (mutation === "fractional-usage") last.eval_count = 1.5;
        derivative.bytes = Buffer.from(
          stream
            ? records.map((record: object) => JSON.stringify(record)).join("\n") + "\n"
            : JSON.stringify(first),
        );
      }
      expect(() => readOllamaK9(derivative, stream)).toThrow();
    });
  }
  if (stream) {
    for (const mutation of [
      "final-newline",
      "missing-terminal",
      "duplicate-terminal",
      "after-terminal",
    ] as const) {
      it(`P1 Ollama K9 derivative stream ${mutation}`, () => {
        const lines = raw.bytes.toString("utf8").trimEnd().split("\n");
        const body =
          mutation === "final-newline"
            ? lines.join("\n")
            : mutation === "missing-terminal"
              ? lines.slice(0, -1).join("\n") + "\n"
              : lines.join("\n") +
                "\n" +
                (mutation === "duplicate-terminal" ? lines.at(-1) : lines[0]) +
                "\n";
        expect(() => readOllamaK9({ ...raw, bytes: Buffer.from(body) }, true)).toThrow();
      });
    }
  }
}

function selectOllamaK9Model(host: string | undefined, model: string | undefined) {
  if (!host?.trim() || !model?.trim())
    throw new Error(
      "Native K9 requires OLLAMA_HOST and explicit AIMOCK_OLLAMA_K9_MODEL; no fallback or pull",
    );
  if (model !== model.trim()) throw new Error("K9 model must be an exact model name");
  return model;
}

it("P1 Ollama K9 model selection requires explicit host and model", () => {
  expect(() => selectOllamaK9Model("localhost:11434", undefined)).toThrow();
  expect(() => selectOllamaK9Model(undefined, "gemma4:26b")).toThrow();
  expect(() => selectOllamaK9Model("localhost:11434", " ")).toThrow();
  expect(selectOllamaK9Model("localhost:11434", "gemma4:26b")).toBe("gemma4:26b");
});

// K1: both reviewed gemma4 attempts returned valid tools (NOT_TRIGGERED);
// exact native parser err= wording remains uncaptured. No new K1 waiver or K4 change.
// Native K9 is sequential and fails closed. The daily outer retry wrapper may
// run this suite three times: at most six K9 generations / 192 requested tokens.
describe
  .skipIf(!process.env.OLLAMA_HOST && !process.env.AIMOCK_OLLAMA_K9_MODEL)
  .sequential("P1 Ollama K9 native", () => {
    let failed = false;
    for (const stream of [false, true]) {
      it(
        stream ? "stream" : "object",
        async () => {
          if (failed) throw new Error("Prior native K9 failure blocks remaining generation");
          failed = true;
          expect(
            ollamaLocalK9Passed,
            "All three local SDK K9 values must pass before native generation",
          ).toBe(3);
          const model = selectOllamaK9Model(
            process.env.OLLAMA_HOST,
            process.env.AIMOCK_OLLAMA_K9_MODEL,
          );
          const signal = AbortSignal.timeout(45000);
          const preflight: LocalOllamaBody[] = [];
          const wire: LocalOllamaBody[] = [];
          const chunks: ChatResponse[] = [];
          const request = {
            model,
            stream,
            keep_alive: 0,
            think: true,
            options: { num_ctx: 2048, temperature: 0, num_predict: 32 },
            messages: [
              {
                role: "user",
                content:
                  "Determine and rigorously justify the exact number of ways to color the vertices of a regular icosahedron with six named colors, each appearing exactly twice, up to rotational symmetry. Work through every Burnside conjugacy class and fixed-coloring constraint carefully before giving any final answer.",
              },
            ],
          };
          let attempts = 0;
          try {
            // Read-only capability check. Never pull, choose an alternative, or retry.
            const metadata = await readLocalOllamaBody(
              await fetch(`${OLLAMA_HOST}/api/show`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model }),
                signal,
              }),
            );
            preflight.push(metadata);
            const info = ollamaRecord(JSON.parse(metadata.body));
            expect(info.capabilities, "Exact installed K9 model must support thinking").toContain(
              "thinking",
            );
            const client = new Ollama({
              host: OLLAMA_HOST,
              fetch: async (input, init) => {
                attempts++;
                if (attempts > 1) throw new Error("Native K9 generation retry forbidden");
                const response = await fetch(input, { ...init, signal });
                const observed = await readLocalOllamaBody(response, (body) => wire.push(body));
                // Validate complete original bytes before SDK parsing can hide framing defects.
                readOllamaK9(
                  { ...observed, contentType: observed.contentType ?? "", complete: true },
                  stream,
                );
                return new Response(observed.bytes, {
                  status: observed.status,
                  headers: response.headers,
                });
              },
            });
            if (stream) {
              for await (const chunk of await client.chat({ ...request, stream: true }))
                chunks.push(chunk);
            } else chunks.push(await client.chat({ ...request, stream: false }));
            expect(attempts).toBe(1);
            expect(wire).toHaveLength(1);
            const target = readOllamaK9(
              { ...wire[0], contentType: wire[0].contentType ?? "", complete: true },
              stream,
            );
            expect(target.records).toEqual(chunks);
            expect(target.model).toBe(model);
            // Compare stable target semantics, without equating model text or token usage.
            const captured = ollamaK9Captures.find(
              (entry) => entry.mode === (stream ? "stream" : "object"),
            )!;
            const control = readOllamaK9(
              { ...captured, bytes: Buffer.from(captured.base64, "base64"), complete: true },
              stream,
            );
            expect([target.content, target.tools, target.done, target.doneReason]).toEqual([
              control.content,
              control.tools,
              control.done,
              control.doneReason,
            ]);
            failed = false;
          } finally {
            console.log(
              JSON.stringify({
                cell: stream ? "native stream" : "native object",
                model,
                request,
                attempts,
                wire: wire.map(({ bytes, ...response }) => ({
                  ...response,
                  rawBase64: bytes.toString("base64"),
                  byteLength: bytes.length,
                })),
                preflight: preflight.map(({ bytes, ...response }) => ({
                  ...response,
                  rawBase64: bytes.toString("base64"),
                  byteLength: bytes.length,
                })),
                sdkChunks: chunks,
                usage: chunks.length
                  ? Object.fromEntries(
                      Object.entries(chunks[chunks.length - 1]).filter(
                        ([key]) => key.endsWith("_count") || key.endsWith("_duration"),
                      ),
                    )
                  : undefined,
              }),
            );
          }
        },
        { timeout: 55000, retry: 0 },
      );
    }
  });
