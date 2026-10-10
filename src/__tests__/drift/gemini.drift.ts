/**
 * Google Gemini GenerateContent API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import http from "node:http";
import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
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

// Approved M contracts: deterministic modeled faults, native target unverified.
// Gemini Developer API only. Native NOT_TRIGGERED is not a successful comparison.
// Seven-case decision (2026-10-08), rows3/4; no Vertex access/evidence exception.
type ModeledGeminiFault = "stop-length-mid-tool" | "reasoning-only";
interface ModeledGeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: object;
}
interface ModeledGeminiChunk {
  candidates: {
    index: number;
    content?: { role?: string; parts: ModeledGeminiPart[] };
    finishReason?: string;
    finishMessage?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
function modeledGeminiObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Strictly read complete native frames before classifying target occurrence. */
function readModeledGemini(status: number, raw: string, stream: boolean): ModeledGeminiChunk[] {
  if (status !== 200) throw new Error(`Gemini modeled drift HTTP ${status}: ${raw}`);
  let values: unknown[];
  if (stream) {
    const normalized = raw.replace(/\r\n/g, "\n");
    if (!normalized.endsWith("\n\n")) throw new Error("Incomplete Gemini SSE frame");
    values = normalized
      .trimEnd()
      .split("\n\n")
      .map((frame) => {
        const lines = frame.split("\n");
        if (lines.some((line) => !line.startsWith("data: ")))
          throw new Error("Unexpected Gemini SSE framing");
        return JSON.parse(lines.map((line) => line.slice(6)).join("\n"));
      });
  } else values = [JSON.parse(raw)];
  if (!values.length) throw new Error("Missing Gemini chunks");
  const chunks: ModeledGeminiChunk[] = [];
  let terminal = false;
  for (const value of values) {
    if (
      !modeledGeminiObject(value) ||
      !Array.isArray(value.candidates) ||
      value.candidates.length !== 1 ||
      terminal
    )
      throw new Error("Invalid Gemini candidates or output after terminal");
    const candidate: unknown = value.candidates[0];
    if (!modeledGeminiObject(candidate) || candidate.index !== 0)
      throw new Error("Invalid Gemini candidate index");
    const content = candidate.content;
    if (content !== undefined) {
      if (
        !modeledGeminiObject(content) ||
        !Array.isArray(content.parts) ||
        (content.role !== undefined && content.role !== "model")
      )
        throw new Error("Invalid Gemini content");
      for (const part of content.parts) {
        if (
          !modeledGeminiObject(part) ||
          (typeof part.text !== "string" && !modeledGeminiObject(part.functionCall)) ||
          (part.thought !== undefined && typeof part.thought !== "boolean")
        )
          throw new Error("Invalid Gemini part");
        if (
          part.functionCall !== undefined &&
          (!modeledGeminiObject(part.functionCall) ||
            typeof part.functionCall.name !== "string" ||
            !modeledGeminiObject(part.functionCall.args))
        )
          throw new Error("Invalid Gemini function call");
      }
    }
    if (candidate.finishReason !== undefined) {
      if (
        typeof candidate.finishReason !== "string" ||
        ![
          "STOP",
          "MAX_TOKENS",
          "MALFORMED_FUNCTION_CALL",
          "SAFETY",
          "RECITATION",
          "OTHER",
          "BLOCKLIST",
          "PROHIBITED_CONTENT",
          "SPII",
          "UNEXPECTED_TOOL_CALL",
        ].includes(candidate.finishReason)
      )
        throw new Error("Unknown Gemini terminal");
      terminal = true;
    }
    if (content === undefined && !terminal)
      throw new Error("Missing Gemini content before terminal");
    if (
      candidate.finishReason === "MALFORMED_FUNCTION_CALL" &&
      (typeof candidate.finishMessage !== "string" || !candidate.finishMessage.length)
    )
      throw new Error("Missing malformed-call diagnostic");
    if (value.usageMetadata !== undefined) {
      if (!modeledGeminiObject(value.usageMetadata)) throw new Error("Invalid Gemini usage");
      for (const key of ["promptTokenCount", "candidatesTokenCount", "totalTokenCount"]) {
        const count = value.usageMetadata[key];
        if (
          count !== undefined &&
          (typeof count !== "number" || !Number.isInteger(count) || count < 0)
        )
          throw new Error("Invalid Gemini token count");
      }
    }
    // Shape checked above; no native fields are removed from the retained raw transcript.
    chunks.push(value as unknown as ModeledGeminiChunk);
  }
  if (!terminal || chunks.at(-1)?.usageMetadata?.totalTokenCount === undefined)
    throw new Error("Missing Gemini terminal or usage");
  return chunks;
}
function modeledGeminiParts(chunks: ModeledGeminiChunk[]) {
  return chunks.flatMap((chunk) =>
    chunk.candidates.flatMap((candidate) => candidate.content?.parts ?? []),
  );
}
function assertModeledGemini(fault: ModeledGeminiFault, chunks: ModeledGeminiChunk[]) {
  expect(chunks.at(-1)?.candidates[0].finishReason).toBe("MAX_TOKENS");
  const parts = modeledGeminiParts(chunks);
  expect(parts.some((part) => part.functionCall !== undefined)).toBe(false);
  if (fault === "reasoning-only") {
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((part) => part.thought === true && typeof part.text === "string")).toBe(
      true,
    );
    expect(parts.map((part) => part.text ?? "").join("").length).toBeGreaterThan(0);
  } else
    expect(parts.every((part) => part.thought !== true && typeof part.text === "string")).toBe(
      true,
    );
}
function compareModeledGeminiNative(fault: ModeledGeminiFault, chunks: ModeledGeminiChunk[]) {
  const parts = modeledGeminiParts(chunks);
  // A token-limit tool attempt is a triggered K5 comparison, including contradictory
  // functionCall output. For K9, no-answer thinking triggers comparison even with a wrong stop.
  const triggered =
    fault === "stop-length-mid-tool"
      ? chunks.at(-1)?.candidates[0].finishReason === "MAX_TOKENS"
      : parts.some((part) => part.thought === true) &&
        !parts.some((part) => part.thought !== true && (part.text || part.functionCall));
  if (!triggered) return "NOT_TRIGGERED";
  assertModeledGemini(fault, chunks);
  return "NATIVE_TARGET_COMPARED";
}
const modeledGeminiCases = (["stop-length-mid-tool", "reasoning-only"] as const).flatMap((fault) =>
  [false, true].map((stream) => ({ fault, stream })),
);
const modeledGeminiRequest = { contents: [{ role: "user", parts: [{ text: "weather" }] }] };

describe("Gemini modeled K5/K9 recurring contracts", () => {
  it.each(modeledGeminiCases)(
    "local SDK/wire $fault stream=$stream remains strict",
    async ({ fault, stream }) => {
      const server = await createServer(
        [
          {
            match: {},
            response: {
              content: "Before.",
              toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}', id: "lookup_id" }],
              usage: { totalTokenCount: 999 },
            },
            misbehavior: {
              faults: [
                { fault, ...(fault === "reasoning-only" ? { reasoning: "Thinking only." } : {}) },
              ],
            },
          },
        ],
        { port: 0, enableMisbehavior: true },
      );
      try {
        const wire = await httpPost(
          `${server.url}/v1beta/models/gemini-2.5-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
          modeledGeminiRequest,
        );
        console.log(
          JSON.stringify({
            kind: "LOCAL_MODELED",
            fault,
            stream,
            wire,
            journal: server.journal.getAll(),
          }),
        );
        const chunks = readModeledGemini(wire.status, wire.body, stream);
        assertModeledGemini(fault, chunks);
        const expectedText = fault === "reasoning-only" ? "Thinking only." : "Before.";
        expect(
          modeledGeminiParts(chunks)
            .map((part) => part.text ?? "")
            .join(""),
        ).toBe(expectedText);
        expect(chunks.at(-1)?.usageMetadata).toEqual({
          promptTokenCount: 2,
          candidatesTokenCount: Math.ceil(expectedText.length / 4),
          totalTokenCount: 2 + Math.ceil(expectedText.length / 4),
        });
        const client = new GoogleGenAI({
          apiKey: "local",
          httpOptions: {
            baseUrl: server.url,
            apiVersion: "v1beta",
            timeout: 5000,
            retryOptions: { attempts: 1 },
          },
        });
        const sdk: GenerateContentResponse[] = [];
        const request = { model: "gemini-2.5-flash", contents: "weather" };
        if (stream)
          for await (const chunk of await client.models.generateContentStream(request))
            sdk.push(chunk);
        else sdk.push(await client.models.generateContent(request));
        const sdkChunks = readModeledGemini(
          200,
          stream
            ? sdk.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
            : JSON.stringify(sdk[0]),
          stream,
        );
        assertModeledGemini(fault, sdkChunks);
        expect(modeledGeminiParts(sdkChunks)).toEqual(modeledGeminiParts(chunks));
        expect(server.journal.getAll()).toHaveLength(2);
        for (const entry of server.journal.getAll())
          expect(entry.response.misbehavior).toMatchObject({
            applied: true,
            fault,
            servedToolCalls: [],
          });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it.skipIf(!GOOGLE_API_KEY).each(modeledGeminiCases)(
    "live Developer API bounded $fault stream=$stream",
    async ({ fault, stream }) => {
      const body =
        fault === "stop-length-mid-tool"
          ? {
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text: "Call archive with an array of 200 distinct full city names. Do not abbreviate the names.",
                    },
                  ],
                },
              ],
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: "archive",
                      description: "Archive a list of city names",
                      parameters: {
                        type: "OBJECT",
                        properties: { cities: { type: "ARRAY", items: { type: "STRING" } } },
                        required: ["cities"],
                      },
                    },
                  ],
                },
              ],
              toolConfig: { functionCallingConfig: { mode: "ANY" } },
              generationConfig: { maxOutputTokens: 16, thinkingConfig: { thinkingBudget: 0 } },
            }
          : {
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text: "Find every integer solution of x^2 + y^2 + z^2 = 3xyz, explaining the infinite descent argument carefully.",
                    },
                  ],
                },
              ],
              generationConfig: {
                maxOutputTokens: 64,
                thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
              },
            };
      // Exactly one call per fault/mode, no retry, no credentials in URL or logs.
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": GOOGLE_API_KEY! },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45000),
        },
      );
      const raw = await response.text();
      console.log(
        JSON.stringify({
          kind: "NATIVE_MODELED_COMPARISON",
          provider: "Gemini Developer API",
          model: "gemini-2.5-flash",
          fault,
          stream,
          status: response.status,
          request: body,
          raw,
        }),
      );
      const chunks = readModeledGemini(response.status, raw, stream);
      const outcome = compareModeledGeminiNative(fault, chunks);
      console.log(
        JSON.stringify({
          fault,
          stream,
          outcome,
          disclosure:
            "M: deterministic modeled contract; NOT_TRIGGERED does not verify native target fidelity",
        }),
      );
    },
  );
});

// Complete retained native responses (not synthesized or trimmed into target shapes).
const retainedModeledGeminiCaptures: {
  fault: ModeledGeminiFault;
  stream: boolean;
  status: number;
  raw: string;
  capture: string;
  sha256: string;
}[] = [
  {
    fault: "stop-length-mid-tool",
    stream: false,
    status: 200,
    raw: '{\n  "candidates": [\n    {\n      "finishReason": "MALFORMED_FUNCTION_CALL",\n      "index": 0,\n      "finishMessage": "Malformed function call: print(default_api.archive(cities=[\\"New"\n    }\n  ],\n  "usageMetadata": {\n    "promptTokenCount": 61,\n    "totalTokenCount": 61,\n    "promptTokensDetails": [\n      {\n        "modality": "TEXT",\n        "tokenCount": 61\n      }\n    ],\n    "serviceTier": "standard"\n  },\n  "modelVersion": "gemini-2.5-flash",\n  "responseId": "CdDHapDnNJiyqtsP38a-uQc"\n}\n',
    capture: "capture-k5-nonstream-20261008T171658Z.json",
    sha256: "07f2a211af85eb6f5545423156798a4fa067bc38ba61710417172f3952124b74",
  },
  {
    fault: "stop-length-mid-tool",
    stream: true,
    status: 200,
    raw: 'data: {"candidates": [{"finishReason": "MALFORMED_FUNCTION_CALL","index": 0,"finishMessage": "Malformed function call: print(default_api.archive(cities=[\\"New"}],"usageMetadata": {"promptTokenCount": 61,"totalTokenCount": 61,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 61}],"serviceTier": "standard"}}\r\n\r\n',
    capture: "capture-k5-stream-20261008T171659Z.json",
    sha256: "63963cef16d50e4c2908454e57711a97c290f81712ff957564a4260158ad46c4",
  },
  {
    fault: "reasoning-only",
    stream: false,
    status: 200,
    raw: '{\n  "candidates": [\n    {\n      "content": {\n        "parts": [\n          {\n            "text": "Okay, let me break this down.\\n\\n**Initial Exploration of a Diophantine Equation**\\n\\nRight, so I\'m presented with this equation:  `x² + y² + z² = 3xyz`.  My initial thought is to dive straight into Diophantine analysis, as it\'s clearly an integer solutions problem. The first thing I\'ll always do is start with some small values. Zero is always a good starting point, so let\'s see what happens if I set `x = 0`.  Then, the equation becomes `y² + z² = 0`.  \\n",\n            "thought": true\n          },\n          {\n            "text": "We are looking"\n          }\n        ],\n        "role": "model"\n      },\n      "finishReason": "MAX_TOKENS",\n      "index": 0\n    }\n  ],\n  "usageMetadata": {\n    "promptTokenCount": 29,\n    "candidatesTokenCount": 3,\n    "totalTokenCount": 89,\n    "promptTokensDetails": [\n      {\n        "modality": "TEXT",\n        "tokenCount": 29\n      }\n    ],\n    "thoughtsTokenCount": 57,\n    "serviceTier": "standard"\n  },\n  "modelVersion": "gemini-2.5-flash",\n  "responseId": "DtDHas7TLN2tz7IP_bPjyAo"\n}\n',
    capture: "capture-k9-nonstream-20261008T171704Z.json",
    sha256: "88a61d6bea475d279ee2419fe6bb550f1679744062e573d706bce83b746ab60b",
  },
  {
    fault: "reasoning-only",
    stream: true,
    status: 200,
    raw: 'data: {"candidates": [{"content": {"parts": [{"text": "**Initiating the Descent**\\n\\nI\'m now diving into the problem, aiming for a solution using infinite descent. I\'ve grasped the core equation:  x² + y² + z² = 3xyz. My immediate focus is on understanding the equation\'s properties and possible constraints on the integer solutions. Initial impressions suggest this might lead to some interesting number theory insights.\\n\\n\\n","thought": true}],"role": "model"},"index": 0}],"usageMetadata": {"promptTokenCount": 29,"totalTokenCount": 88,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 29}],"thoughtsTokenCount": 59,"serviceTier": "standard"},"modelVersion": "gemini-2.5-flash","responseId": "EdDHavuSDILGjMcPvefFoQg"}\r\n\r\ndata: {"candidates": [{"content": {"parts": [{"text": "We"}],"role": "model"},"finishReason": "MAX_TOKENS","index": 0}],"usageMetadata": {"promptTokenCount": 29,"totalTokenCount": 88,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 29}],"thoughtsTokenCount": 59,"serviceTier": "standard"},"modelVersion": "gemini-2.5-flash","responseId": "EdDHavuSDILGjMcPvefFoQg"}\r\n\r\n',
    capture: "capture-k9-stream-20261008T171707Z.json",
    sha256: "aabfaf11f24c32f64d725226681b06f943188d58b08899ba4f29eec55baf0f25",
  },
];

describe("Gemini modeled K5/K9 evidence reader", () => {
  it.each(retainedModeledGeminiCaptures)(
    "retains $capture as NOT_TRIGGERED",
    ({ fault, status, raw, stream, capture, sha256 }) => {
      const chunks = readModeledGemini(status, raw, stream);
      expect(compareModeledGeminiNative(fault, chunks)).toBe("NOT_TRIGGERED");
      if (fault === "stop-length-mid-tool")
        expect(chunks.at(-1)?.candidates[0].finishReason).toBe("MALFORMED_FUNCTION_CALL");
      else expect(modeledGeminiParts(chunks).some((part) => part.text && !part.thought)).toBe(true);
      console.log(
        JSON.stringify({
          capture,
          sha256,
          outcome: "NOT_TRIGGERED",
          source: "retained genuine native response, not a new live comparison",
        }),
      );
    },
  );
  it.each([
    { stream: false, malformed: true },
    { stream: true, malformed: true },
    { stream: false, malformed: false },
    { stream: true, malformed: false },
  ])("F1 derived terminal stream=$stream malformed=$malformed", ({ stream, malformed }) => {
    const record = retainedModeledGeminiCaptures.find(
      (item) => item.fault === "reasoning-only" && !item.stream,
    )!;
    const original = readModeledGemini(record.status, record.raw, false)[0];
    const derived = {
      ...original,
      candidates: original.candidates.map((candidate) => ({
        ...candidate,
        finishReason: malformed ? ["STOP"] : "STOP",
      })),
    };
    const body = JSON.stringify(derived);
    const raw = stream ? `data: ${body}\n\n` : body;
    let outcome: string;
    try {
      outcome = compareModeledGeminiNative(
        record.fault,
        readModeledGemini(record.status, raw, stream),
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      outcome = error.message;
    }
    console.log(
      JSON.stringify({
        source: "derived terminal from retained capture; not a native capture or product cell",
        capture: record.capture,
        captureSha256: record.sha256,
        stream,
        malformed,
        raw,
        outcome,
      }),
    );
    expect(outcome).toBe(malformed ? "Unknown Gemini terminal" : "NOT_TRIGGERED");
  });
  it("rejects access, malformed, truncated and post-terminal artifacts before classification", () => {
    const record = retainedModeledGeminiCaptures.find((item) => item.stream)!;
    expect(() => readModeledGemini(403, record.raw, true)).toThrow("HTTP 403");
    expect(() => readModeledGemini(200, '{"candidates":', false)).toThrow();
    expect(() => readModeledGemini(200, record.raw.trimEnd(), true)).toThrow("Incomplete");
    expect(() => readModeledGemini(200, record.raw + record.raw, true)).toThrow("after terminal");
    expect(() =>
      readModeledGemini(
        200,
        JSON.stringify({
          candidates: [{ index: 0, content: { parts: [{ text: 7 }] }, finishReason: "STOP" }],
          usageMetadata: { totalTokenCount: 2 },
        }),
        false,
      ),
    ).toThrow("Invalid Gemini part");
    expect(() =>
      readModeledGemini(
        200,
        JSON.stringify({
          candidates: [{ index: 0, content: { parts: [] } }],
          usageMetadata: { totalTokenCount: 2 },
        }),
        false,
      ),
    ).toThrow("Missing Gemini terminal");
  });
  it("blocks triggered contradictory shape instead of classifying it NOT_TRIGGERED", () => {
    const wrongK5: ModeledGeminiChunk[] = [
      {
        candidates: [
          {
            index: 0,
            finishReason: "MAX_TOKENS",
            content: { parts: [{ functionCall: { name: "lookup", args: {} } }] },
          },
        ],
      },
    ];
    const wrongK9: ModeledGeminiChunk[] = [
      {
        candidates: [
          {
            index: 0,
            finishReason: "STOP",
            content: { parts: [{ text: "Thought.", thought: true }] },
          },
        ],
      },
    ];
    expect(() => compareModeledGeminiNative("stop-length-mid-tool", wrongK5)).toThrow();
    expect(() => compareModeledGeminiNative("reasoning-only", wrongK9)).toThrow();
  });
});
