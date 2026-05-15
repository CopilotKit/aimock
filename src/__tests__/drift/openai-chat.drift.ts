/**
 * OpenAI Chat Completions API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { createServer } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import {
  openaiChatCompletionShape,
  openaiChatCompletionToolCallShape,
  openaiChatCompletionChunkShape,
  openaiChatCompletionReasoningShape,
  openaiChatCompletionReasoningChunkShape,
} from "./sdk-shapes.js";
import { openaiChatNonStreaming, openaiChatStreaming } from "./providers.js";
import { httpPost, parseDataOnlySSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!OPENAI_API_KEY)("OpenAI Chat Completions drift", () => {
  const config = { apiKey: OPENAI_API_KEY! };

  it("non-streaming text shape matches", async () => {
    const sdkShape = openaiChatCompletionShape();

    const [realRes, mockRes] = await Promise.all([
      openaiChatNonStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello" }],
        stream: false,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Chat (non-streaming text)", diffs);

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming text shape matches", async () => {
    const sdkChunkShape = openaiChatCompletionChunkShape();

    const [realStream, mockStreamRes] = await Promise.all([
      openaiChatStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello" }],
        stream: true,
      }),
    ]);

    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    const realChunkShape = extractShape(realStream.rawEvents[0].data);
    const mockChunkShape = extractShape(mockChunks[0]);

    const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
    const report = formatDriftReport("OpenAI Chat (streaming text chunks)", diffs);

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("non-streaming tool call shape matches", async () => {
    const sdkShape = openaiChatCompletionToolCallShape();

    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];

    const [realRes, mockRes] = await Promise.all([
      openaiChatNonStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Weather in Paris" }],
        stream: false,
        tools,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Chat (non-streaming tool call)", diffs);

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming tool call shape matches", async () => {
    const sdkChunkShape = openaiChatCompletionChunkShape();

    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];

    const [realStream, mockStreamRes] = await Promise.all([
      openaiChatStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Weather in Paris" }],
        stream: true,
        tools,
      }),
    ]);

    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    const realChunkShape = extractShape(realStream.rawEvents[0].data);
    const mockChunkShape = extractShape(mockChunks[0]);

    const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
    const report = formatDriftReport("OpenAI Chat (streaming tool call chunks)", diffs);

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error shape tests (mock-only — no real API key required)
// ---------------------------------------------------------------------------

describe("OpenAI Chat Completions error shapes", () => {
  /**
   * OpenAI error envelope per spec:
   * https://platform.openai.com/docs/guides/error-codes
   *
   * { error: { message: string, type: string, param: string | null, code: string | null } }
   */
  function openaiErrorShape() {
    return extractShape({
      error: {
        message: "example error",
        type: "invalid_request_error",
        param: null,
        code: "invalid_json",
      },
    });
  }

  it("400 error fixture returns OpenAI error envelope shape", async () => {
    // Stand up a server with an error fixture that triggers on any request
    const errorFixtures: Fixture[] = [
      {
        match: { userMessage: "trigger-error" },
        response: {
          error: {
            message: "You exceeded your current quota",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
          status: 400,
        },
      },
    ];
    const errorInstance = await createServer(errorFixtures, { port: 0, chunkSize: 100 });

    try {
      const res = await httpPost(`${errorInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "trigger-error" }],
        stream: false,
      });

      expect(res.status).toBe(400);

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.message).toBe("You exceeded your current quota");
      expect(body.error.type).toBe("insufficient_quota");

      // Validate shape matches OpenAI error envelope
      const sdkShape = openaiErrorShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("OpenAI Chat error fixture (400)", diffs);

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => errorInstance.server.close(() => r()));
    }
  });

  it("404 no-fixture-match returns OpenAI error envelope shape", async () => {
    // Empty fixtures — any request will 404
    const emptyInstance = await createServer([], { port: 0, chunkSize: 100 });

    try {
      const res = await httpPost(`${emptyInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "no fixture will match this" }],
        stream: false,
      });

      expect(res.status).toBe(404);

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.message).toBe("No fixture matched");
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("no_fixture_match");

      // Validate shape: error envelope should have message + type + code
      const sdkShape = openaiErrorShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("OpenAI Chat no-fixture-match (404)", diffs);

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => emptyInstance.server.close(() => r()));
    }
  });

  it("malformed JSON body returns 400 with OpenAI error envelope shape", async () => {
    // Any server — the JSON parse error happens before fixture matching
    const malformedInstance = await createServer([], { port: 0, chunkSize: 100 });

    try {
      // Send raw malformed JSON using http directly (httpPost would stringify a valid object)
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const url = new URL(`${malformedInstance.url}/v1/chat/completions`);
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (c) => chunks.push(c));
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on("error", reject);
        req.write("{not valid json!!!}}}");
        req.end();
      });

      expect(res.status).toBe(400);

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.message).toMatch(/^Malformed JSON/);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("invalid_json");

      // Validate shape matches OpenAI error envelope
      const sdkShape = openaiErrorShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("OpenAI Chat malformed JSON (400)", diffs);

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => malformedInstance.server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// Reasoning (reasoning_content) shape tests — mock-only, no real API key
// ---------------------------------------------------------------------------

describe("OpenAI Chat Completions reasoning shapes", () => {
  const REASONING_FIXTURE: Fixture = {
    match: { userMessage: "Think carefully" },
    response: {
      content: "The answer is 42.",
      reasoning: "Let me think step by step about this problem.",
    },
  };

  it("non-streaming reasoning_content shape matches SDK expectations", async () => {
    const reasoningInstance = await createServer([REASONING_FIXTURE], {
      port: 0,
      chunkSize: 100,
    });

    try {
      const mockRes = await httpPost(`${reasoningInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Think carefully" }],
        stream: false,
      });

      expect(mockRes.status).toBe(200);

      const body = JSON.parse(mockRes.body);

      // ── Structural assertions on reasoning_content ────────────────────
      expect(body.choices).toBeDefined();
      expect(body.choices.length).toBeGreaterThanOrEqual(1);

      const message = body.choices[0].message;
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("The answer is 42.");
      expect(message.reasoning_content).toBe("Let me think step by step about this problem.");
      expect(typeof message.reasoning_content).toBe("string");

      // ── Shape triangulation against SDK expectations ───────────────────
      const sdkShape = openaiChatCompletionReasoningShape();
      const mockShape = extractShape(body);

      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("OpenAI Chat (non-streaming reasoning)", diffs);

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
    }
  });

  it("streaming reasoning_content chunks have correct delta shape", async () => {
    const reasoningInstance = await createServer([REASONING_FIXTURE], {
      port: 0,
      chunkSize: 10,
    });

    try {
      const mockStreamRes = await httpPost(`${reasoningInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Think carefully" }],
        stream: true,
      });

      expect(mockStreamRes.status).toBe(200);

      const mockChunks = parseDataOnlySSE(mockStreamRes.body);
      expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

      // ── Identify reasoning chunks vs content chunks ───────────────────
      type DeltaChunk = {
        choices: Array<{
          delta: { reasoning_content?: string; content?: string; role?: string };
          finish_reason: string | null;
        }>;
      };

      const reasoningChunks = mockChunks.filter(
        (c) => (c as DeltaChunk).choices?.[0]?.delta?.reasoning_content !== undefined,
      ) as DeltaChunk[];

      const contentChunks = mockChunks.filter(
        (c) =>
          (c as DeltaChunk).choices?.[0]?.delta?.content !== undefined &&
          (c as DeltaChunk).choices?.[0]?.delta?.content !== "",
      ) as DeltaChunk[];

      expect(reasoningChunks.length, "No reasoning chunks emitted").toBeGreaterThan(0);
      expect(contentChunks.length, "No content chunks emitted").toBeGreaterThan(0);

      // ── Validate reasoning chunk shape ────────────────────────────────
      for (const chunk of reasoningChunks) {
        const delta = chunk.choices[0].delta;
        expect(typeof delta.reasoning_content).toBe("string");
        // Reasoning chunks should NOT have content or role
        expect(delta.content).toBeUndefined();
        expect(delta.role).toBeUndefined();
        expect(chunk.choices[0].finish_reason).toBeNull();
      }

      // ── Reassemble reasoning text ─────────────────────────────────────
      const fullReasoning = reasoningChunks
        .map((c) => c.choices[0].delta.reasoning_content!)
        .join("");
      expect(fullReasoning).toBe("Let me think step by step about this problem.");

      // ── Reassemble content text ───────────────────────────────────────
      const fullContent = contentChunks.map((c) => c.choices[0].delta.content!).join("");
      expect(fullContent).toBe("The answer is 42.");

      // ── Shape triangulation on a reasoning chunk ──────────────────────
      const sdkChunkShape = openaiChatCompletionReasoningChunkShape();
      const mockChunkShape = extractShape(reasoningChunks[0]);

      const diffs = triangulate(sdkChunkShape, sdkChunkShape, mockChunkShape);
      const report = formatDriftReport("OpenAI Chat (streaming reasoning chunks)", diffs);

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    } finally {
      await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
    }
  });

  it("reasoning chunks precede role chunk in stream order", async () => {
    const reasoningInstance = await createServer([REASONING_FIXTURE], {
      port: 0,
      chunkSize: 10,
    });

    try {
      const mockStreamRes = await httpPost(`${reasoningInstance.url}/v1/chat/completions`, {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Think carefully" }],
        stream: true,
      });

      const mockChunks = parseDataOnlySSE(mockStreamRes.body);

      type DeltaChunk = {
        choices: Array<{
          delta: { reasoning_content?: string; content?: string; role?: string };
          finish_reason: string | null;
        }>;
      };

      // Find indices of first/last reasoning and first role chunks
      const firstReasoningIdx = mockChunks.findIndex(
        (c) => (c as DeltaChunk).choices?.[0]?.delta?.reasoning_content !== undefined,
      );
      const firstRoleIdx = mockChunks.findIndex(
        (c) => (c as DeltaChunk).choices?.[0]?.delta?.role !== undefined,
      );
      const lastReasoningIdx = mockChunks.reduce(
        (last, c, i) =>
          (c as DeltaChunk).choices?.[0]?.delta?.reasoning_content !== undefined ? i : last,
        -1,
      );

      expect(firstReasoningIdx, "No reasoning chunk found").toBeGreaterThanOrEqual(0);
      expect(firstRoleIdx, "No role chunk found").toBeGreaterThanOrEqual(0);

      // All reasoning chunks must precede the role chunk
      expect(lastReasoningIdx, "Last reasoning chunk must come before the role chunk").toBeLessThan(
        firstRoleIdx,
      );

      // The finish chunk must be last
      const finishIdx = mockChunks.findIndex(
        (c) => (c as DeltaChunk).choices?.[0]?.finish_reason === "stop",
      );
      expect(finishIdx, "No finish chunk found").toBeGreaterThanOrEqual(0);
      expect(finishIdx).toBe(mockChunks.length - 1);
    } finally {
      await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
    }
  });
});
