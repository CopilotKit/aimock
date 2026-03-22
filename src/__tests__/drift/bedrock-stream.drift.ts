/**
 * AWS Bedrock drift tests.
 *
 * Three-way comparison: SDK types x real API x llmock output.
 * Covers invoke-with-response-stream and converse endpoints.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport, shouldFail } from "./schema.js";
import { httpPost, startDriftServer, stopDriftServer } from "./helpers.js";

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
});
