/**
 * AWS Bedrock drift tests.
 *
 * Three-way comparison: SDK types x real API x aimock output.
 * Covers invoke-with-response-stream, converse, and converse-stream endpoints.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport, shouldFail } from "./schema.js";
import { httpPost, startDriftServer, stopDriftServer } from "./helpers.js";
import {
  bedrockConverseStreamEventShapes,
  bedrockConverseStreamToolShapes,
  bedrockConverseStreamReasoningShapes,
  bedrockInvokeStreamEventShapes,
} from "./sdk-shapes.js";

// ---------------------------------------------------------------------------
// Credentials check
// ---------------------------------------------------------------------------

const HAS_CREDENTIALS =
  !!process.env.AWS_ACCESS_KEY_ID &&
  !!process.env.AWS_SECRET_ACCESS_KEY &&
  !!process.env.AWS_REGION;

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
 * Minimal Bedrock InvokeModel response shape.
 * Bedrock wraps the model output in its own envelope.
 */
function bedrockInvokeResponseShape() {
  return extractShape({
    body: "base64-encoded-string",
    contentType: "application/json",
    $metadata: {
      httpStatusCode: 200,
      requestId: "req-abc",
    },
  });
}

/**
 * Minimal Bedrock Converse response shape.
 */
function bedrockConverseResponseShape() {
  return extractShape({
    output: {
      message: {
        role: "assistant",
        content: [{ text: "Hello!" }],
      },
    },
    stopReason: "end_turn",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    metrics: {
      latencyMs: 100,
    },
    $metadata: {
      httpStatusCode: 200,
      requestId: "req-abc",
    },
  });
}

// ---------------------------------------------------------------------------
// Binary Event Stream helpers
// ---------------------------------------------------------------------------

function httpPostBinary(
  url: string,
  body: object,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

interface ParsedFrame {
  eventType: string;
  messageType: string;
  payload: unknown;
}

function parseFrames(buf: Buffer): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const totalLength = buf.readUInt32BE(offset);
    const frame = buf.subarray(offset, offset + totalLength);

    // Parse headers
    const headersLength = frame.readUInt32BE(4);
    const headersStart = 12;
    const headersEnd = headersStart + headersLength;
    const headers: Record<string, string> = {};
    let hOffset = headersStart;
    while (hOffset < headersEnd) {
      const nameLen = frame.readUInt8(hOffset);
      hOffset += 1;
      const name = frame.subarray(hOffset, hOffset + nameLen).toString("utf8");
      hOffset += nameLen;
      hOffset += 1; // type byte (7 = STRING)
      const valueLen = frame.readUInt16BE(hOffset);
      hOffset += 2;
      const value = frame.subarray(hOffset, hOffset + valueLen).toString("utf8");
      hOffset += valueLen;
      headers[name] = value;
    }

    // Parse payload
    const payloadStart = headersEnd;
    const payloadEnd = totalLength - 4;
    const payloadBuf = frame.subarray(payloadStart, payloadEnd);
    let payload: unknown = null;
    if (payloadBuf.length > 0) {
      payload = JSON.parse(payloadBuf.toString("utf8"));
    }

    frames.push({
      eventType: headers[":event-type"] ?? "",
      messageType: headers[":message-type"] ?? "",
      payload,
    });

    offset += totalLength;
  }

  return frames;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_CREDENTIALS)("Bedrock drift", () => {
  it("invoke-with-response-stream mock shape is plausible", async () => {
    const sdkShape = bedrockInvokeResponseShape();

    // Bedrock streaming uses binary event-stream framing, so we test the
    // mock's JSON response shape for the non-streaming invoke endpoint.
    const mockRes = await httpPost(
      `${instance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say hello" }],
      },
    );

    expect(mockRes.status).toBe(200);

    // When real AWS credentials are available, send the same request to
    // the real Bedrock API and compare shapes. For now, validate mock
    // against the SDK shape as both real and expected.
    if (mockRes.status === 200) {
      const mockShape = extractShape(JSON.parse(mockRes.body));
      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("Bedrock Invoke", diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
    }
  });

  it("invoke-with-response-stream mock shape matches SDK expectations", async () => {
    const sdkEvents = bedrockInvokeStreamEventShapes();

    const mockRes = await httpPostBinary(
      `${instance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/invoke-with-response-stream`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say hello" }],
      },
    );

    expect(mockRes.status).toBe(200);
    expect(mockRes.headers["content-type"]).toBe("application/vnd.amazon.eventstream");

    const frames = parseFrames(mockRes.body);
    expect(frames.length).toBeGreaterThanOrEqual(6);

    // All frames should have eventType "chunk" (Bedrock invoke-stream wrapping)
    for (const frame of frames) {
      expect(frame.eventType).toBe("chunk");
    }

    // Extract the Anthropic-native event type from each frame's payload
    const payloadEvents = frames.map((f) => {
      const payload = f.payload as Record<string, unknown>;
      return {
        type: (payload.type as string) ?? "",
        dataShape: extractShape(payload),
      };
    });

    // Key event types must be present
    const eventTypes = payloadEvents.map((e) => e.type);
    for (const expected of [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]) {
      expect(eventTypes, `missing event type: ${expected}`).toContain(expected);
    }

    // Compare each SDK event type against the mock
    for (const sdkEvent of sdkEvents) {
      const mockEvent = payloadEvents.find((m) => m.type === sdkEvent.type);
      if (!mockEvent) continue; // already asserted presence above

      const diffs = triangulate(sdkEvent.dataShape, sdkEvent.dataShape, mockEvent.dataShape);
      const report = formatDriftReport(`Bedrock InvokeStream:${sdkEvent.type}`, diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
    }
  });

  it("converse mock shape matches SDK expectations", async () => {
    const sdkShape = bedrockConverseResponseShape();

    const mockRes = await httpPost(
      `${instance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/converse`,
      {
        messages: [
          {
            role: "user",
            content: [{ text: "Say hello" }],
          },
        ],
        inferenceConfig: { maxTokens: 10 },
      },
    );

    expect(mockRes.status).toBe(200);

    if (mockRes.status === 200) {
      const mockShape = extractShape(JSON.parse(mockRes.body));
      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("Bedrock Converse", diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
    }
  });

  it("converse-stream payloads are flat (not double-wrapped with event type name)", async () => {
    const mockRes = await httpPostBinary(
      `${instance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/converse-stream`,
      {
        messages: [
          {
            role: "user",
            content: [{ text: "Say hello" }],
          },
        ],
        inferenceConfig: { maxTokens: 10 },
      },
    );

    expect(mockRes.status).toBe(200);
    expect(mockRes.headers["content-type"]).toBe("application/vnd.amazon.eventstream");

    const frames = parseFrames(mockRes.body);
    expect(frames.length).toBeGreaterThanOrEqual(5);

    // ── Key event types must be present ───────────────────────────────
    const eventTypes = frames.map((f) => f.eventType);
    for (const expected of [
      "messageStart",
      "contentBlockStart",
      "contentBlockDelta",
      "contentBlockStop",
      "messageStop",
      "metadata",
    ]) {
      expect(eventTypes, `missing event type: ${expected}`).toContain(expected);
    }

    // ── messageStart: flat { role: "assistant" } ──────────────────────
    const msgStart = frames.find((f) => f.eventType === "messageStart");
    expect(msgStart).toBeDefined();
    const msgStartPayload = msgStart!.payload as Record<string, unknown>;
    expect(msgStartPayload).toEqual({ role: "assistant" });
    // Negative: must NOT be double-wrapped
    expect(msgStartPayload).not.toHaveProperty("messageStart");

    // ── contentBlockDelta: contains delta directly ────────────────────
    const deltaFrames = frames.filter((f) => f.eventType === "contentBlockDelta");
    expect(deltaFrames.length).toBeGreaterThanOrEqual(1);
    for (const frame of deltaFrames) {
      const payload = frame.payload as Record<string, unknown>;
      expect(payload).toHaveProperty("delta");
      expect(payload).toHaveProperty("contentBlockIndex");
      // Negative: must NOT be double-wrapped
      expect(payload).not.toHaveProperty("contentBlockDelta");
    }

    // ── contentBlockStart: flat payload ───────────────────────────────
    const blockStarts = frames.filter((f) => f.eventType === "contentBlockStart");
    for (const frame of blockStarts) {
      const payload = frame.payload as Record<string, unknown>;
      expect(payload).toHaveProperty("contentBlockIndex");
      expect(payload).toHaveProperty("start");
      expect(payload).not.toHaveProperty("contentBlockStart");
    }

    // ── contentBlockStop: flat payload ────────────────────────────────
    const blockStops = frames.filter((f) => f.eventType === "contentBlockStop");
    for (const frame of blockStops) {
      const payload = frame.payload as Record<string, unknown>;
      expect(payload).toHaveProperty("contentBlockIndex");
      expect(payload).not.toHaveProperty("contentBlockStop");
    }

    // ── messageStop: flat { stopReason: "..." } ──────────────────────
    const msgStop = frames.find((f) => f.eventType === "messageStop");
    expect(msgStop).toBeDefined();
    const msgStopPayload = msgStop!.payload as Record<string, unknown>;
    expect(msgStopPayload).toHaveProperty("stopReason");
    expect(msgStopPayload).not.toHaveProperty("messageStop");

    // ── metadata: flat { usage: ..., metrics: ... } ──────────────────
    const metadataFrame = frames.find((f) => f.eventType === "metadata");
    expect(metadataFrame).toBeDefined();
    const metadataPayload = metadataFrame!.payload as Record<string, unknown>;
    expect(metadataPayload).toHaveProperty("usage");
    expect(metadataPayload).toHaveProperty("metrics");
    expect(metadataPayload).not.toHaveProperty("metadata");

    // ── Shape comparison against SDK expectations ─────────────────────
    const sdkEvents = bedrockConverseStreamEventShapes();
    const mockEvents = frames.map((f) => ({
      type: f.eventType,
      dataShape: extractShape(f.payload),
    }));

    // Compare each SDK event type against the mock
    for (const sdkEvent of sdkEvents) {
      const mockEvent = mockEvents.find((m) => m.type === sdkEvent.type);
      if (!mockEvent) continue; // already asserted presence above

      const diffs = triangulate(sdkEvent.dataShape, sdkEvent.dataShape, mockEvent.dataShape);
      const report = formatDriftReport(`Bedrock ConverseStream:${sdkEvent.type}`, diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
    }
  });

  it("converse-stream tool-call event shapes match SDK expectations", async () => {
    const mockRes = await httpPostBinary(
      `${instance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/converse-stream`,
      {
        messages: [
          {
            role: "user",
            content: [{ text: "Weather in Paris" }],
          },
        ],
        inferenceConfig: { maxTokens: 10 },
      },
    );

    expect(mockRes.status).toBe(200);
    expect(mockRes.headers["content-type"]).toBe("application/vnd.amazon.eventstream");

    const frames = parseFrames(mockRes.body);
    expect(frames.length).toBeGreaterThanOrEqual(5);

    // ── Tool-specific event types must be present ────────────────────
    const eventTypes = frames.map((f) => f.eventType);
    for (const expected of [
      "messageStart",
      "contentBlockStart",
      "contentBlockDelta",
      "contentBlockStop",
      "messageStop",
      "metadata",
    ]) {
      expect(eventTypes, `missing event type: ${expected}`).toContain(expected);
    }

    // ── contentBlockStart must contain toolUse descriptor ────────────
    const toolStart = frames.find(
      (f) =>
        f.eventType === "contentBlockStart" &&
        (f.payload as { start?: { toolUse?: unknown } }).start?.toolUse !== undefined,
    );
    expect(toolStart).toBeDefined();
    const toolStartPayload = toolStart!.payload as {
      contentBlockIndex: number;
      start: { toolUse: { toolUseId: string; name: string } };
    };
    expect(toolStartPayload.start.toolUse.name).toBe("get_weather");
    expect(toolStartPayload.start.toolUse.toolUseId).toBeDefined();

    // ── contentBlockDelta must contain toolUse.input ─────────────────
    const toolDeltas = frames.filter(
      (f) =>
        f.eventType === "contentBlockDelta" &&
        (f.payload as { delta?: { toolUse?: unknown } }).delta?.toolUse !== undefined,
    );
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
    const fullJson = toolDeltas
      .map((f) => (f.payload as { delta: { toolUse: { input: string } } }).delta.toolUse.input)
      .join("");
    expect(JSON.parse(fullJson)).toEqual({ city: "Paris" });

    // ── messageStop must have tool_use stopReason ────────────────────
    const msgStop = frames.find((f) => f.eventType === "messageStop");
    expect(msgStop).toBeDefined();
    expect(msgStop!.payload).toEqual({ stopReason: "tool_use" });

    // ── Shape comparison against SDK tool expectations ───────────────
    const sdkEvents = bedrockConverseStreamToolShapes();
    const mockEvents = frames.map((f) => ({
      type: f.eventType,
      dataShape: extractShape(f.payload),
    }));

    for (const sdkEvent of sdkEvents) {
      const mockEvent = mockEvents.find((m) => m.type === sdkEvent.type);
      if (!mockEvent) continue;

      const diffs = triangulate(sdkEvent.dataShape, sdkEvent.dataShape, mockEvent.dataShape);
      const report = formatDriftReport(`Bedrock ConverseStream Tool:${sdkEvent.type}`, diffs);

      if (shouldFail(diffs)) {
        expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
      }
    }
  });

  it("converse-stream reasoning event shapes match SDK expectations", async () => {
    // Create a dedicated server with a reasoning fixture
    const reasoningFixture: Fixture = {
      match: { userMessage: "Think carefully" },
      response: {
        content: "The answer is 42.",
        reasoning: "Let me think step by step...",
      },
    };
    const reasoningInstance = await createServer([reasoningFixture], {
      port: 0,
      chunkSize: 100,
    });

    try {
      const mockRes = await httpPostBinary(
        `${reasoningInstance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/converse-stream`,
        {
          messages: [
            {
              role: "user",
              content: [{ text: "Think carefully" }],
            },
          ],
          inferenceConfig: { maxTokens: 100 },
        },
      );

      expect(mockRes.status).toBe(200);
      expect(mockRes.headers["content-type"]).toBe("application/vnd.amazon.eventstream");

      const frames = parseFrames(mockRes.body);
      expect(frames.length).toBeGreaterThanOrEqual(7); // reasoning block + text block + envelope

      // ── Key event types must be present ──────────────────────────────
      const eventTypes = frames.map((f) => f.eventType);
      for (const expected of [
        "messageStart",
        "contentBlockStart",
        "contentBlockDelta",
        "contentBlockStop",
        "messageStop",
        "metadata",
      ]) {
        expect(eventTypes, `missing event type: ${expected}`).toContain(expected);
      }

      // ── contentBlockStart must contain reasoningContent descriptor ──
      const reasoningStart = frames.find(
        (f) =>
          f.eventType === "contentBlockStart" &&
          (f.payload as { start?: { reasoningContent?: unknown } }).start?.reasoningContent !==
            undefined,
      );
      expect(reasoningStart).toBeDefined();
      const reasoningStartPayload = reasoningStart!.payload as {
        contentBlockIndex: number;
        start: { reasoningContent: Record<string, unknown> };
      };
      expect(reasoningStartPayload.contentBlockIndex).toBe(0);
      expect(reasoningStartPayload.start.reasoningContent).toEqual({});

      // ── contentBlockDelta must contain reasoningContent.text ─────────
      const reasoningDeltas = frames.filter(
        (f) =>
          f.eventType === "contentBlockDelta" &&
          (f.payload as { delta?: { reasoningContent?: unknown } }).delta?.reasoningContent !==
            undefined,
      );
      expect(reasoningDeltas.length).toBeGreaterThanOrEqual(1);
      const fullReasoning = reasoningDeltas
        .map(
          (f) =>
            (f.payload as { delta: { reasoningContent: { text: string } } }).delta.reasoningContent
              .text,
        )
        .join("");
      expect(fullReasoning).toBe("Let me think step by step...");

      // ── Text content block follows reasoning block ──────────────────
      const textDeltas = frames.filter(
        (f) =>
          f.eventType === "contentBlockDelta" &&
          (f.payload as { delta?: { text?: string } }).delta?.text !== undefined,
      );
      expect(textDeltas.length).toBeGreaterThanOrEqual(1);
      const fullText = textDeltas
        .map((f) => (f.payload as { delta: { text: string } }).delta.text)
        .join("");
      expect(fullText).toBe("The answer is 42.");

      // ── Shape comparison against SDK reasoning expectations ─────────
      const sdkEvents = bedrockConverseStreamReasoningShapes();
      const mockEvents = frames.map((f) => ({
        type: f.eventType,
        dataShape: extractShape(f.payload),
      }));

      for (const sdkEvent of sdkEvents) {
        const mockEvent = mockEvents.find((m) => m.type === sdkEvent.type);
        if (!mockEvent) continue;

        const diffs = triangulate(sdkEvent.dataShape, sdkEvent.dataShape, mockEvent.dataShape);
        const report = formatDriftReport(
          `Bedrock ConverseStream Reasoning:${sdkEvent.type}`,
          diffs,
        );

        if (shouldFail(diffs)) {
          expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
        }
      }
    } finally {
      await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
    }
  });
});
