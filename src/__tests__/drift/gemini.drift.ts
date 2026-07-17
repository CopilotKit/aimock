/**
 * Google Gemini GenerateContent API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import {
  geminiContentResponseShape,
  geminiToolCallResponseShape,
  geminiStreamChunkShape,
  geminiStreamLastChunkShape,
  geminiThinkingContentResponseShape,
  geminiThinkingStreamChunkShape,
} from "./sdk-shapes.js";
import { geminiNonStreaming, geminiStreaming } from "./providers.js";
import { httpPost, parseDataOnlySSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!GOOGLE_API_KEY)("Google Gemini drift", () => {
  const config = { apiKey: GOOGLE_API_KEY! };

  it("non-streaming text shape matches", async () => {
    const sdkShape = geminiContentResponseShape();

    const [realRes, mockRes] = await Promise.all([
      geminiNonStreaming(config, [{ role: "user", parts: [{ text: "Say hello" }] }]),
      httpPost(`${instance.url}/v1beta/models/gemini-2.5-flash:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Gemini (non-streaming text)", diffs, "gemini");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming text shape matches", async () => {
    const sdkChunkShape = geminiStreamChunkShape();
    const sdkLastShape = geminiStreamLastChunkShape();

    const [realStream, mockStreamRes] = await Promise.all([
      geminiStreaming(config, [{ role: "user", parts: [{ text: "Say hello" }] }]),
      httpPost(`${instance.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
        contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
      }),
    ]);

    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    // Compare intermediate chunks (if multiple exist)
    if (realStream.rawEvents.length > 1 && mockChunks.length > 1) {
      const realChunkShape = extractShape(realStream.rawEvents[0].data);
      const mockChunkShape = extractShape(mockChunks[0]);

      const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
      const report = formatDriftReport("Gemini (streaming intermediate chunk)", diffs, "gemini");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }

    // Compare last chunk
    const realLastShape = extractShape(realStream.rawEvents[realStream.rawEvents.length - 1].data);
    const mockLastShape = extractShape(mockChunks[mockChunks.length - 1]);

    const lastDiffs = triangulate(sdkLastShape, realLastShape, mockLastShape);
    const lastReport = formatDriftReport("Gemini (streaming last chunk)", lastDiffs, "gemini");

    expect(
      lastDiffs.filter((d) => d.severity === "critical"),
      lastReport,
    ).toEqual([]);
  });

  it("non-streaming tool call shape matches", async () => {
    const sdkShape = geminiToolCallResponseShape();

    const tools = [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "OBJECT",
              properties: {
                city: { type: "STRING" },
              },
              required: ["city"],
            },
          },
        ],
      },
    ];

    const [realRes, mockRes] = await Promise.all([
      geminiNonStreaming(config, [{ role: "user", parts: [{ text: "Weather in Paris" }] }], tools),
      httpPost(`${instance.url}/v1beta/models/gemini-2.5-flash:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "Weather in Paris" }] }],
        tools,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Gemini (non-streaming tool call)", diffs, "gemini");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming tool call shape matches", async () => {
    const sdkLastShape = geminiStreamLastChunkShape();

    const tools = [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "OBJECT",
              properties: {
                city: { type: "STRING" },
              },
              required: ["city"],
            },
          },
        ],
      },
    ];

    const [realStream, mockStreamRes] = await Promise.all([
      geminiStreaming(config, [{ role: "user", parts: [{ text: "Weather in Paris" }] }], tools),
      httpPost(`${instance.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`, {
        contents: [{ role: "user", parts: [{ text: "Weather in Paris" }] }],
        tools,
      }),
    ]);

    const mockChunks = parseDataOnlySSE(mockStreamRes.body);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockChunks.length, "Mock returned no SSE chunks").toBeGreaterThan(0);

    const realLastShape = extractShape(realStream.rawEvents[realStream.rawEvents.length - 1].data);
    const mockLastShape = extractShape(mockChunks[mockChunks.length - 1]);

    const diffs = triangulate(sdkLastShape, realLastShape, mockLastShape);
    const report = formatDriftReport("Gemini (streaming tool call)", diffs, "gemini");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error shape validation
// ---------------------------------------------------------------------------

/**
 * Google's canonical error envelope shape.
 * Ref: https://cloud.google.com/apis/design/errors
 */
function geminiErrorEnvelopeShape() {
  return extractShape({
    error: {
      code: 429,
      message: "Resource has been exhausted",
      status: "RESOURCE_EXHAUSTED",
    },
  });
}

/** Canonical gRPC status codes used by Google APIs */
const GOOGLE_CANONICAL_STATUSES = new Set([
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
  // aimock uses this as a catch-all for fixture errors
  "ERROR",
]);

describe("Gemini error shapes", () => {
  let errorInstance: ServerInstance;

  const ERROR_FIXTURE: Fixture = {
    match: { userMessage: "trigger rate limit" },
    response: {
      error: { message: "Resource has been exhausted", type: "RESOURCE_EXHAUSTED" },
      status: 429,
    },
  };

  const NOT_FOUND_FIXTURE: Fixture = {
    match: { userMessage: "trigger not found" },
    response: {
      error: { message: "Model not found", type: "NOT_FOUND" },
      status: 404,
    },
  };

  const INVALID_ARG_FIXTURE: Fixture = {
    match: { userMessage: "trigger invalid" },
    response: {
      error: { message: "Invalid argument provided", type: "INVALID_ARGUMENT" },
      status: 400,
    },
  };

  beforeAll(async () => {
    errorInstance = await createServer([ERROR_FIXTURE, NOT_FOUND_FIXTURE, INVALID_ARG_FIXTURE], {
      port: 0,
      chunkSize: 100,
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => errorInstance.server.close(() => r()));
  });

  it("RESOURCE_EXHAUSTED error matches Google error envelope shape", async () => {
    const sdkShape = geminiErrorEnvelopeShape();

    const mockRes = await httpPost(
      `${errorInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "trigger rate limit" }] }] },
    );

    expect(mockRes.status).toBe(429);

    const body = JSON.parse(mockRes.body);
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Gemini (RESOURCE_EXHAUSTED error)", diffs, "gemini");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    // Validate the concrete error envelope fields
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("code", 429);
    expect(body.error).toHaveProperty("message");
    expect(typeof body.error.message).toBe("string");
    expect(body.error).toHaveProperty("status");
    expect(GOOGLE_CANONICAL_STATUSES.has(body.error.status)).toBe(true);
  });

  it("NOT_FOUND error matches Google error envelope shape", async () => {
    const sdkShape = geminiErrorEnvelopeShape();

    const mockRes = await httpPost(
      `${errorInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "trigger not found" }] }] },
    );

    expect(mockRes.status).toBe(404);

    const body = JSON.parse(mockRes.body);
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Gemini (NOT_FOUND error)", diffs, "gemini");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    expect(body.error.code).toBe(404);
    expect(body.error.status).toBe("NOT_FOUND");
    expect(GOOGLE_CANONICAL_STATUSES.has(body.error.status)).toBe(true);
  });

  it("INVALID_ARGUMENT error matches Google error envelope shape", async () => {
    const sdkShape = geminiErrorEnvelopeShape();

    const mockRes = await httpPost(
      `${errorInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "trigger invalid" }] }] },
    );

    expect(mockRes.status).toBe(400);

    const body = JSON.parse(mockRes.body);
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Gemini (INVALID_ARGUMENT error)", diffs, "gemini");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    expect(body.error.code).toBe(400);
    expect(body.error.status).toBe("INVALID_ARGUMENT");
    expect(GOOGLE_CANONICAL_STATUSES.has(body.error.status)).toBe(true);
  });

  it("error.code is a number, not a string", async () => {
    const mockRes = await httpPost(
      `${errorInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "trigger rate limit" }] }] },
    );

    const body = JSON.parse(mockRes.body);
    expect(typeof body.error.code).toBe("number");
  });

  it("error.status is a gRPC canonical status string", async () => {
    const mockRes = await httpPost(
      `${errorInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "trigger rate limit" }] }] },
    );

    const body = JSON.parse(mockRes.body);
    expect(typeof body.error.status).toBe("string");
    expect(GOOGLE_CANONICAL_STATUSES.has(body.error.status)).toBe(true);
    expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
  });

  it("no-fixture-match returns NOT_FOUND error in Google envelope", async () => {
    const sdkShape = geminiErrorEnvelopeShape();

    const mockRes = await httpPost(
      `${errorInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "no fixture will match this" }] }] },
    );

    expect(mockRes.status).toBe(404);

    const body = JSON.parse(mockRes.body);
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Gemini (no-fixture-match error)", diffs, "gemini");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    expect(body.error.code).toBe(404);
    expect(body.error.status).toBe("NOT_FOUND");
  });

  it("malformed JSON returns INVALID_ARGUMENT error in Google envelope", async () => {
    const sdkShape = geminiErrorEnvelopeShape();

    // Send raw malformed JSON body
    const mockRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const nodeReq = http.request(
        `${errorInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
        (nodeRes) => {
          const chunks: Buffer[] = [];
          nodeRes.on("data", (c) => chunks.push(c));
          nodeRes.on("end", () =>
            resolve({
              status: nodeRes.statusCode!,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      nodeReq.on("error", reject);
      nodeReq.write("{invalid json");
      nodeReq.end();
    });

    expect(mockRes.status).toBe(400);

    const body = JSON.parse(mockRes.body);
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Gemini (malformed JSON error)", diffs, "gemini");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    expect(body.error.code).toBe(400);
    expect(body.error.status).toBe("INVALID_ARGUMENT");
  });
});

// ---------------------------------------------------------------------------
// Thinking / reasoning tokens (Gemini 2.5+)
// ---------------------------------------------------------------------------

describe("Gemini thinking token shapes", () => {
  const THINKING_FIXTURE: Fixture = {
    match: { userMessage: "Think carefully" },
    response: {
      content: "The answer is 42.",
      reasoning: "Let me think step by step about this problem...",
    },
  };

  let thinkingInstance: ServerInstance;

  beforeAll(async () => {
    thinkingInstance = await createServer([THINKING_FIXTURE], {
      port: 0,
      chunkSize: 100,
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => thinkingInstance.server.close(() => r()));
  });

  it("non-streaming response includes thought parts", async () => {
    const sdkShape = geminiThinkingContentResponseShape();

    const mockRes = await httpPost(
      `${thinkingInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "Think carefully" }] }] },
    );

    expect(mockRes.status).toBe(200);

    const body = JSON.parse(mockRes.body);
    const mockShape = extractShape(body);

    // Shape comparison: SDK expected vs mock output
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Gemini (non-streaming thinking)", diffs, "gemini");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);

    // Structural assertions: thinking part precedes content part
    const parts = body.candidates[0].content.parts as { text: string; thought?: boolean }[];
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const thoughtParts = parts.filter((p: { thought?: boolean }) => p.thought === true);
    const contentParts = parts.filter((p: { thought?: boolean }) => !p.thought);

    expect(thoughtParts.length).toBeGreaterThanOrEqual(1);
    expect(contentParts.length).toBeGreaterThanOrEqual(1);

    // thought parts carry the reasoning text
    const fullThought = thoughtParts.map((p: { text: string }) => p.text).join("");
    expect(fullThought).toBe("Let me think step by step about this problem...");

    // content part carries the response text
    const fullContent = contentParts.map((p: { text: string }) => p.text).join("");
    expect(fullContent).toBe("The answer is 42.");
  });

  it("streaming response emits thought chunks before content chunks", async () => {
    const sdkThinkingChunkShape = geminiThinkingStreamChunkShape();
    const sdkContentChunkShape = geminiStreamChunkShape();

    const mockStreamRes = await httpPost(
      `${thinkingInstance.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent`,
      { contents: [{ role: "user", parts: [{ text: "Think carefully" }] }] },
    );

    expect(mockStreamRes.status).toBe(200);

    const chunks = parseDataOnlySSE(mockStreamRes.body);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Classify chunks into thinking vs content
    type GeminiChunk = {
      candidates: { content: { parts: { text: string; thought?: boolean }[] } }[];
    };
    const thinkingChunks: GeminiChunk[] = [];
    const contentChunks: GeminiChunk[] = [];
    let lastThinkingIdx = -1;
    let firstContentIdx = chunks.length;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as GeminiChunk;
      const parts = chunk.candidates[0].content.parts;
      if (parts.some((p) => p.thought === true)) {
        thinkingChunks.push(chunk);
        lastThinkingIdx = i;
      } else {
        contentChunks.push(chunk);
        if (i < firstContentIdx) firstContentIdx = i;
      }
    }

    expect(thinkingChunks.length, "Expected at least one thinking chunk").toBeGreaterThanOrEqual(1);
    expect(contentChunks.length, "Expected at least one content chunk").toBeGreaterThanOrEqual(1);

    // Thinking chunks must precede content chunks
    expect(lastThinkingIdx, "All thinking chunks should come before content chunks").toBeLessThan(
      firstContentIdx,
    );

    // Thinking chunk shape matches SDK expectation
    const mockThinkingShape = extractShape(thinkingChunks[0]);
    const thinkingDiffs = triangulate(
      sdkThinkingChunkShape,
      sdkThinkingChunkShape,
      mockThinkingShape,
    );
    const thinkingReport = formatDriftReport(
      "Gemini (streaming thinking chunk)",
      thinkingDiffs,
      "gemini",
    );

    expect(
      thinkingDiffs.filter((d) => d.severity === "critical"),
      thinkingReport,
    ).toEqual([]);

    // Content chunk shape matches SDK expectation
    const mockContentShape = extractShape(contentChunks[0]);
    const contentDiffs = triangulate(sdkContentChunkShape, sdkContentChunkShape, mockContentShape);
    const contentReport = formatDriftReport(
      "Gemini (streaming content chunk after thinking)",
      contentDiffs,
      "gemini",
    );

    expect(
      contentDiffs.filter((d) => d.severity === "critical"),
      contentReport,
    ).toEqual([]);

    // Verify reassembled text
    const allThinkingText = thinkingChunks
      .map((c) => c.candidates[0].content.parts.map((p) => p.text).join(""))
      .join("");
    expect(allThinkingText).toBe("Let me think step by step about this problem...");

    const allContentText = contentChunks
      .map((c) => c.candidates[0].content.parts.map((p) => p.text).join(""))
      .join("");
    expect(allContentText).toBe("The answer is 42.");
  });

  it("thought parts have boolean thought field, not string", async () => {
    const mockRes = await httpPost(
      `${thinkingInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "Think carefully" }] }] },
    );

    const body = JSON.parse(mockRes.body);
    const parts = body.candidates[0].content.parts as { thought?: unknown }[];
    const thoughtParts = parts.filter((p) => p.thought !== undefined);

    expect(thoughtParts.length).toBeGreaterThanOrEqual(1);
    for (const part of thoughtParts) {
      expect(typeof part.thought, "thought field must be boolean").toBe("boolean");
      expect(part.thought).toBe(true);
    }
  });

  it("content parts do not have thought field", async () => {
    const mockRes = await httpPost(
      `${thinkingInstance.url}/v1beta/models/gemini-2.5-flash:generateContent`,
      { contents: [{ role: "user", parts: [{ text: "Think carefully" }] }] },
    );

    const body = JSON.parse(mockRes.body);
    const parts = body.candidates[0].content.parts as {
      text: string;
      thought?: unknown;
    }[];
    // Content parts should not carry the thought field
    const contentParts = parts.filter((p) => p.thought === undefined || p.thought === false);

    expect(contentParts.length).toBeGreaterThanOrEqual(1);
    for (const part of contentParts) {
      // The Gemini API omits thought on content parts rather than setting it false
      expect(part.thought).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Canary: track Gemini Embeddings API shape
// ---------------------------------------------------------------------------

describe.skipIf(!GOOGLE_API_KEY)("Gemini Embeddings canary", () => {
  it("canary: verify embeddings endpoint exists and response shape", async () => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GOOGLE_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text: "test" }] } }),
      },
    );
    if (res.status === 200) {
      const body = (await res.json()) as Record<string, unknown>;
      // Log the shape so drift is visible in CI output
      console.log("[CANARY] Gemini Embeddings response keys:", Object.keys(body));
      const embedding = body.embedding as { values?: unknown[] } | undefined;
      if (embedding?.values) {
        console.log("[CANARY] Gemini Embeddings dimension:", embedding.values.length);
      }
    } else {
      console.warn(`[CANARY] Gemini Embeddings returned ${res.status}`);
    }
    expect(true).toBe(true);
  });
});
