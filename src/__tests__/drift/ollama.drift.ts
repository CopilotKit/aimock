/**
 * Ollama drift tests.
 *
 * Compares aimock's Ollama endpoint output shapes against a real Ollama
 * instance. Skips unless OLLAMA_HOST is set in the environment.
 *
 * Requires: OLLAMA_HOST env var (e.g. http://localhost:11434)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Environment-based opt-in (consistent with other drift files)
// ---------------------------------------------------------------------------

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

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
      model: "llama3.2",
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
      model: "llama3.2",
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
      model: "llama3.2",
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
