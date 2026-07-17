/**
 * Anthropic Claude Messages API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, compareSSESequences, formatDriftReport } from "./schema.js";
import {
  anthropicMessageShape,
  anthropicMessageToolCallShape,
  anthropicStreamEventShapes,
  anthropicToolStreamEventShapes,
  anthropicThinkingMessageShape,
  anthropicThinkingStreamEventShapes,
} from "./sdk-shapes.js";
import { anthropicNonStreaming, anthropicStreaming } from "./providers.js";
import { httpPost, parseTypedSSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!ANTHROPIC_API_KEY)("Anthropic Claude Messages drift", () => {
  const config = { apiKey: ANTHROPIC_API_KEY! };

  it("non-streaming text shape matches", async () => {
    const sdkShape = anthropicMessageShape();

    const [realRes, mockRes] = await Promise.all([
      anthropicNonStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/messages`, {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say hello" }],
        stream: false,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Anthropic Claude (non-streaming text)", diffs, "anthropic");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming text event sequence and shapes match", async () => {
    const sdkEvents = anthropicStreamEventShapes();

    const [realStream, mockStreamRes] = await Promise.all([
      anthropicStreaming(config, [{ role: "user", content: "Say hello" }]),
      httpPost(`${instance.url}/v1/messages`, {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say hello" }],
        stream: true,
      }),
    ]);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realStream.events, mockSSEShapes);
    const report = formatDriftReport(
      "Anthropic Claude (streaming text events)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("non-streaming tool call shape matches", async () => {
    const sdkShape = anthropicMessageToolCallShape();

    const tools = [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const [realRes, mockRes] = await Promise.all([
      anthropicNonStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/messages`, {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        messages: [{ role: "user", content: "Weather in Paris" }],
        stream: false,
        tools,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport(
      "Anthropic Claude (non-streaming tool call)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming tool call event sequence matches", async () => {
    const sdkEvents = [
      ...anthropicStreamEventShapes().filter(
        (e) =>
          e.type === "message_start" || e.type === "message_delta" || e.type === "message_stop",
      ),
      ...anthropicToolStreamEventShapes(),
    ];

    const tools = [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const [realStream, mockStreamRes] = await Promise.all([
      anthropicStreaming(config, [{ role: "user", content: "Weather in Paris" }], tools),
      httpPost(`${instance.url}/v1/messages`, {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        messages: [{ role: "user", content: "Weather in Paris" }],
        stream: true,
        tools,
      }),
    ]);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realStream.events, mockSSEShapes);
    const report = formatDriftReport(
      "Anthropic Claude (streaming tool call events)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Extended thinking
// ---------------------------------------------------------------------------

describe("Anthropic Claude extended thinking shapes", () => {
  it("non-streaming thinking shape matches", async () => {
    const sdkShape = anthropicThinkingMessageShape();

    const mockRes = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content: "Think about hello" }],
      stream: false,
    });

    expect(mockRes.status).toBe(200);
    const mockBody = JSON.parse(mockRes.body);
    const mockShape = extractShape(mockBody);

    // Verify thinking block is present alongside text
    expect(mockBody.content).toBeInstanceOf(Array);
    expect(mockBody.content.length).toBe(2);
    expect(mockBody.content[0].type).toBe("thinking");
    expect(mockBody.content[0].thinking).toBe("I need to consider...");
    // Real Anthropic non-streaming returns a non-empty cryptographic signature
    // on the assembled thinking block (assembled here from the signature_delta).
    expect(typeof mockBody.content[0].signature).toBe("string");
    expect(mockBody.content[0].signature.length).toBeGreaterThan(0);
    expect(mockBody.content[1].type).toBe("text");
    expect(mockBody.content[1].text).toBe("Hello!");

    // Shape triangulation (mock-only, no real API call for thinking)
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "Anthropic Claude (non-streaming thinking)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming thinking event sequence and shapes match", async () => {
    const sdkEvents = anthropicThinkingStreamEventShapes();

    const mockStreamRes = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content: "Think about hello" }],
      stream: true,
    });

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    // Verify thinking-specific events are present
    const thinkingBlockStart = mockEvents.find(
      (e) => e.type === "content_block_start" && e.data?.content_block?.type === "thinking",
    );
    expect(thinkingBlockStart, "Missing content_block_start with type=thinking").toBeTruthy();
    expect(thinkingBlockStart!.data.content_block.thinking).toBe("");
    expect(thinkingBlockStart!.data.content_block.signature).toBe("");

    const thinkingDeltas = mockEvents.filter(
      (e) => e.type === "content_block_delta" && e.data?.delta?.type === "thinking_delta",
    );
    expect(thinkingDeltas.length, "Missing thinking_delta events").toBeGreaterThan(0);

    // Reconstruct full thinking text from deltas
    const thinkingText = thinkingDeltas.map((e) => e.data.delta.thinking).join("");
    expect(thinkingText).toBe("I need to consider...");

    // Verify signature_delta event is present after thinking deltas
    const signatureDeltas = mockEvents.filter(
      (e) => e.type === "content_block_delta" && e.data?.delta?.type === "signature_delta",
    );
    expect(signatureDeltas.length, "Missing signature_delta event").toBe(1);
    // Real Anthropic delivers the non-empty cryptographic signature here (the
    // `content_block_start` carried ""); an SDK assembles the block's signature
    // from this delta.
    expect(typeof signatureDeltas[0].data.delta.signature).toBe("string");
    expect(signatureDeltas[0].data.delta.signature.length).toBeGreaterThan(0);

    // Verify text block follows thinking block
    const textBlockStart = mockEvents.find(
      (e) => e.type === "content_block_start" && e.data?.content_block?.type === "text",
    );
    expect(textBlockStart, "Missing content_block_start with type=text").toBeTruthy();

    // Shape triangulation
    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, sdkEvents, mockSSEShapes);
    const report = formatDriftReport(
      "Anthropic Claude (streaming thinking events)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("thinking block index precedes text block index", async () => {
    const mockStreamRes = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content: "Think about hello" }],
      stream: true,
    });

    const mockEvents = parseTypedSSE(mockStreamRes.body);

    const thinkingStart = mockEvents.find(
      (e) => e.type === "content_block_start" && e.data?.content_block?.type === "thinking",
    );
    const textStart = mockEvents.find(
      (e) => e.type === "content_block_start" && e.data?.content_block?.type === "text",
    );

    expect(thinkingStart).toBeTruthy();
    expect(textStart).toBeTruthy();
    expect(thinkingStart!.data.index).toBeLessThan(textStart!.data.index);
  });
});

// ---------------------------------------------------------------------------
// Error shape validation
// ---------------------------------------------------------------------------

describe("Anthropic Claude error shapes", () => {
  it("no-fixture-match returns Anthropic error envelope (not OpenAI style)", async () => {
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: "this will definitely not match any fixture" }],
      stream: false,
    });

    // Should be 404 (no fixture matched, non-strict mode)
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);

    // Anthropic wraps errors as { type: "error", error: { type, message } }
    // NOT OpenAI style { error: { message, type, code } }
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("type");
    expect(body.error).toHaveProperty("message");
    expect(body.error.type).toBe("invalid_request_error");
    expect(typeof body.error.message).toBe("string");

    // Anthropic errors must NOT have a `code` field
    expect(body.error.code).toBeUndefined();
  });

  it("malformed JSON returns Anthropic error envelope", async () => {
    // Send raw invalid JSON to the Anthropic endpoint
    const res = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = http.request(
        `${instance.url}/v1/messages`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({
              status: r.statusCode!,
              headers: r.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.write("{not valid json");
      req.end();
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);

    // Must have Anthropic error structure
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("type");
    expect(body.error).toHaveProperty("message");
    expect(body.error.type).toBe("invalid_request_error");

    // Anthropic errors must NOT have a `code` field
    expect(body.error.code).toBeUndefined();
  });

  it("error envelope has exactly the expected fields (no extras)", async () => {
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: "unmatched request for shape test" }],
      stream: false,
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);

    // Anthropic error envelope: only `error` at top (and optionally `type: "error"`)
    const topKeys = Object.keys(body);
    // Must have `error`; may have `type: "error"` but nothing else
    expect(topKeys).toContain("error");
    for (const key of topKeys) {
      expect(["type", "error"]).toContain(key);
    }

    // Inner error object: only `type` and `message` — no `code`, `param`, etc.
    const innerKeys = Object.keys(body.error);
    expect(innerKeys.sort()).toEqual(["message", "type"]);
  });

  it("Content-Type is application/json on error", async () => {
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: "yet another unmatched message" }],
      stream: false,
    });

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Canary: detect when Anthropic adds new capabilities
// ---------------------------------------------------------------------------

describe.skipIf(!ANTHROPIC_API_KEY)("Anthropic capability canaries", () => {
  it("canary: detect WebSocket API", async () => {
    // Anthropic doesn't have a WebSocket API as of 2026-03.
    // If they add one, this test will detect it via upgrade headers.
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "OPTIONS",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
    });
    // If Anthropic adds WebSocket support, they'll likely add upgrade headers
    const upgradeHeader = res.headers.get("upgrade");
    if (upgradeHeader) {
      console.warn("[CANARY] Anthropic may now support WebSocket upgrade. Investigate.");
    }
    expect(true).toBe(true); // canary always passes
  });

  it("canary: detect embeddings API", async () => {
    // Anthropic doesn't have an embeddings API as of 2026-03.
    const res = await fetch("https://api.anthropic.com/v1/embeddings", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", input: "test" }),
    });
    // If they add it, we'd get a 200 or 400 (bad request format) instead of 404
    if (res.status !== 404) {
      console.warn(`[CANARY] Anthropic /v1/embeddings returned ${res.status}. May now exist.`);
    }
    expect(true).toBe(true);
  });
});
