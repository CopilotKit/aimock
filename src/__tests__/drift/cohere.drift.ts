/**
 * Cohere drift tests.
 *
 * Three-way comparison: expected shape x real API x llmock output.
 * Covers /v2/chat non-streaming and streaming endpoints.
 *
 * Requires: COHERE_API_KEY
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport, shouldFail } from "./schema.js";
import { httpPost, parseDataOnlySSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Credentials check
// ---------------------------------------------------------------------------

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const HAS_CREDENTIALS = !!COHERE_API_KEY;

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
 * Minimal Cohere /v2/chat response shape (non-streaming).
 */
function cohereChatResponseShape() {
  return extractShape({
    id: "chat-abc123",
    finish_reason: "COMPLETE",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
    },
    usage: {
      billed_units: {
        input_tokens: 10,
        output_tokens: 5,
      },
      tokens: {
        input_tokens: 10,
        output_tokens: 5,
      },
    },
  });
}

/**
 * Minimal Cohere /v2/chat streaming chunk shape.
 */
function cohereChatStreamChunkShape() {
  return extractShape({
    id: "chat-abc123",
    type: "content-delta",
    delta: {
      message: {
        content: { text: "Hel" },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Real API helpers
// ---------------------------------------------------------------------------

async function cohereChatNonStreaming(
  messages: { role: string; content: string }[],
): Promise<{ status: number; body: string }> {
  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "command-r-plus",
      messages,
      stream: false,
      max_tokens: 10,
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function cohereChatStreaming(
  messages: { role: string; content: string }[],
): Promise<{ status: number; body: string }> {
  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "command-r-plus",
      messages,
      stream: true,
      max_tokens: 10,
    }),
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_CREDENTIALS)("Cohere drift", () => {
  it("non-streaming /v2/chat shape matches", async () => {
    const sdkShape = cohereChatResponseShape();
    const messages = [{ role: "user", content: "Say hello" }];

    const [realRes, mockRes] = await Promise.all([
      cohereChatNonStreaming(messages),
      httpPost(`${instance.url}/v2/chat`, {
        model: "command-r-plus",
        messages,
        stream: false,
      }),
    ]);

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      const realShape = extractShape(JSON.parse(realRes.body));
      const mockShape = extractShape(JSON.parse(mockRes.body));

      const diffs = triangulate(sdkShape, realShape, mockShape);
      const report = formatDriftReport("Cohere /v2/chat (non-streaming)", diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
    }
  });

  it("streaming /v2/chat shape matches", async () => {
    const sdkChunkShape = cohereChatStreamChunkShape();
    const messages = [{ role: "user", content: "Say hello" }];

    const [realRes, mockRes] = await Promise.all([
      cohereChatStreaming(messages),
      httpPost(`${instance.url}/v2/chat`, {
        model: "command-r-plus",
        messages,
        stream: true,
      }),
    ]);

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      // Parse SSE chunks from both responses
      const realChunks = parseDataOnlySSE(realRes.body);
      const mockChunks = parseDataOnlySSE(mockRes.body);

      if (realChunks.length > 0 && mockChunks.length > 0) {
        // Compare first chunk shape (content-delta)
        const realChunkShape = extractShape(realChunks[0]);
        const mockChunkShape = extractShape(mockChunks[0]);

        const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
        const report = formatDriftReport("Cohere /v2/chat (streaming first chunk)", diffs);

        if (shouldFail(diffs)) {
          expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
        }

        // Also compare the LAST chunk shape (has finish_reason, usage)
        const sdkLastChunkShape = extractShape({
          id: "chat-abc123",
          type: "message-end",
          delta: {
            finish_reason: "COMPLETE",
            usage: {
              billed_units: { input_tokens: 10, output_tokens: 5 },
              tokens: { input_tokens: 10, output_tokens: 5 },
            },
          },
        });

        const realLastShape = extractShape(realChunks[realChunks.length - 1]);
        const mockLastShape = extractShape(mockChunks[mockChunks.length - 1]);

        const lastDiffs = triangulate(sdkLastChunkShape, realLastShape, mockLastShape);
        const lastReport = formatDriftReport("Cohere /v2/chat (streaming last chunk)", lastDiffs);

        if (shouldFail(lastDiffs)) {
          expect.soft([], lastReport).toEqual(lastDiffs.filter((d) => d.severity === "critical"));
        }
      }
    }
  });
});
