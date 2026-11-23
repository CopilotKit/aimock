/**
 * AWS Bedrock OFFLINE SHAPE-CONFORMANCE tests.
 *
 * NOT drift tests. Nothing here ever reaches AWS — this repo implements no
 * SigV4 request signing (no `@aws-sdk` dependency, no HMAC signer anywhere), so
 * there is no live leg to compare against. Every case below drives the LOCAL
 * aimock server and grades its output against a hand-written SDK-shape fixture
 * in this file / `sdk-shapes.ts`. That catches an aimock builder regression; it
 * cannot catch AWS changing its wire format.
 *
 * The four surfaces these cases emit (`bedrock-invoke`, `bedrock-invoke-stream`,
 * `bedrock-converse`, `bedrock-converse-stream`) are therefore declared
 * `liveCoverage: "none"` in `surface-registry.ts`, and the drift report lists
 * them under `unverifiedSurfaces` on every run so a green report never reads as
 * "AWS was checked".
 *
 * They run UNCONDITIONALLY. They used to sit behind
 * `describe.skipIf(!AWS_ACCESS_KEY_ID && ...)` — an AWS-credential gate on a
 * body that needs no AWS — and no drift workflow sets those variables, so all
 * six cases had never executed in CI while four surfaces reported as covered.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost, startDriftServer, stopDriftServer } from "./helpers.js";
import {
  anthropicMessageShape,
  bedrockConverseStreamEventShapes,
  bedrockConverseStreamToolShapes,
  bedrockConverseStreamReasoningShapes,
  bedrockInvokeStreamEventShapes,
} from "./sdk-shapes.js";

// ---------------------------------------------------------------------------
// Model pin
// ---------------------------------------------------------------------------
//
// The infra-unavailable / model-not-found "honest skip" classification used by
// the other retrofit legs (which DO drive a real provider endpoint) does not
// apply here: a 4xx/5xx from the mock server is never a live-provider
// condition, it is a mock regression, and must hard-fail like any other drift
// finding. This constant just collapses the dated snapshot id into ONE named
// value (was duplicated across every URL literal below).
const BEDROCK_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0";

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
 * Bedrock InvokeModel response shape, as it appears ON THE WIRE.
 *
 * For an `anthropic.*` model id the HTTP response body IS the Anthropic
 * Messages envelope, verbatim — Bedrock adds no envelope of its own over HTTP.
 * So this delegates to `anthropicMessageShape()`, the SAME fixture the LIVE
 * Anthropic drift leg grades `api.anthropic.com` against every run. That keeps
 * the expected shape tethered to something a real provider response moves: if
 * Anthropic changes the envelope, the live leg reds and this fixture is updated
 * with it, and this offline check follows along.
 *
 * It used to describe `{ body, contentType, $metadata }` instead. Those are
 * `aws-sdk-js-v3` CLIENT artifacts (`$metadata` is the smithy `MetadataBearer`
 * the middleware stack bolts on; `body`/`contentType` are how the JS client
 * hands you the payload), not fields any HTTP response carries. aimock is an
 * HTTP mock and serves the wire body, so that fixture asserted three fields
 * that could never be present — and, because the gate meant these cases never
 * ran, nobody saw it fail.
 */
function bedrockInvokeResponseShape() {
  return anthropicMessageShape();
}

/**
 * Minimal Bedrock Converse response shape, as it appears ON THE WIRE.
 *
 * `$metadata` is deliberately absent: it is the `aws-sdk-js-v3` smithy
 * `MetadataBearer` the client middleware attaches (hence the `$` prefix), never
 * a field in the Converse HTTP body. It used to be asserted here, which made
 * this case fail against a correct mock the moment it was allowed to run.
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

describe("Bedrock mock shape conformance (offline — no live AWS leg)", () => {
  it("invoke-with-response-stream mock shape is plausible", async () => {
    const sdkShape = bedrockInvokeResponseShape();

    // Bedrock streaming uses binary event-stream framing, so we test the
    // mock's JSON response shape for the non-streaming invoke endpoint.
    const mockRes = await httpPost(`${instance.url}/model/${BEDROCK_MODEL_ID}/invoke`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 10,
      messages: [{ role: "user", content: "Say hello" }],
    });

    expect(mockRes.status).toBe(200);

    const mockShape = extractShape(JSON.parse(mockRes.body));
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Bedrock Invoke", diffs, "bedrock-invoke");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("invoke-with-response-stream mock shape matches SDK expectations", async () => {
    const sdkEvents = bedrockInvokeStreamEventShapes();

    const mockRes = await httpPostBinary(
      `${instance.url}/model/${BEDROCK_MODEL_ID}/invoke-with-response-stream`,
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
      const envelope = f.payload as { bytes: string };
      const payload = JSON.parse(Buffer.from(envelope.bytes, "base64").toString("utf8")) as Record<
        string,
        unknown
      >;
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
      const report = formatDriftReport(
        `Bedrock InvokeStream:${sdkEvent.type}`,
        diffs,
        "bedrock-invoke-stream",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });

  it("converse mock shape matches SDK expectations", async () => {
    const sdkShape = bedrockConverseResponseShape();

    const mockRes = await httpPost(`${instance.url}/model/${BEDROCK_MODEL_ID}/converse`, {
      messages: [
        {
          role: "user",
          content: [{ text: "Say hello" }],
        },
      ],
      inferenceConfig: { maxTokens: 10 },
    });

    expect(mockRes.status).toBe(200);

    const mockShape = extractShape(JSON.parse(mockRes.body));
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Bedrock Converse", diffs, "bedrock-converse");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("converse-stream payloads are flat (not double-wrapped with event type name)", async () => {
    const mockRes = await httpPostBinary(
      `${instance.url}/model/${BEDROCK_MODEL_ID}/converse-stream`,
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
      const report = formatDriftReport(
        `Bedrock ConverseStream:${sdkEvent.type}`,
        diffs,
        "bedrock-converse-stream",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });

  it("converse-stream tool-call event shapes match SDK expectations", async () => {
    const mockRes = await httpPostBinary(
      `${instance.url}/model/${BEDROCK_MODEL_ID}/converse-stream`,
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
      const report = formatDriftReport(
        `Bedrock ConverseStream Tool:${sdkEvent.type}`,
        diffs,
        "bedrock-converse-stream",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
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
        `${reasoningInstance.url}/model/${BEDROCK_MODEL_ID}/converse-stream`,
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
          "bedrock-converse-stream",
        );

        expect(
          diffs.filter((d) => d.severity === "critical"),
          report,
        ).toEqual([]);
      }
    } finally {
      await new Promise<void>((r) => reasoningInstance.server.close(() => r()));
    }
  });
});
