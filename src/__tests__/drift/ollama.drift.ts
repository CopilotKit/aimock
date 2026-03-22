/**
 * Ollama drift tests.
 *
 * Compares llmock's Ollama endpoint output shapes against a real local
 * Ollama instance. Skips automatically if Ollama is not reachable.
 *
 * Requires: local Ollama running at http://localhost:11434
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport, shouldFail } from "./schema.js";
import { httpPost, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Connectivity check
// ---------------------------------------------------------------------------

let OLLAMA_REACHABLE = false;

async function checkOllamaConnectivity(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  OLLAMA_REACHABLE = await checkOllamaConnectivity();
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

describe.skipIf(!OLLAMA_REACHABLE)("Ollama drift", () => {
  it("/api/chat response shape matches", async () => {
    const sdkShape = ollamaChatResponseShape();

    const body = {
      model: "llama3.2",
      messages: [{ role: "user", content: "Say hello" }],
      stream: false,
    };

    const [realRes, mockRes] = await Promise.all([
      httpPost("http://localhost:11434/api/chat", body),
      httpPost(`${instance.url}/api/chat`, body),
    ]);

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      const realShape = extractShape(JSON.parse(realRes.body));
      const mockShape = extractShape(JSON.parse(mockRes.body));

      const diffs = triangulate(sdkShape, realShape, mockShape);
      const report = formatDriftReport("Ollama /api/chat", diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
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
      httpPost("http://localhost:11434/api/chat", body),
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
      const report = formatDriftReport("Ollama /api/chat (streaming chunk)", diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
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
      httpPost("http://localhost:11434/api/generate", body),
      httpPost(`${instance.url}/api/generate`, body),
    ]);

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      const realShape = extractShape(JSON.parse(realRes.body));
      const mockShape = extractShape(JSON.parse(mockRes.body));

      const diffs = triangulate(sdkShape, realShape, mockShape);
      const report = formatDriftReport("Ollama /api/generate", diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
    }
  });
});
