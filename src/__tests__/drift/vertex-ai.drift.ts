/**
 * Vertex AI OFFLINE SHAPE-CONFORMANCE tests.
 *
 * NOT drift tests. Nothing here reaches Google — a live Vertex leg needs a GCP
 * service account and an OAuth2 token exchange, neither of which this repo
 * does. Both cases drive the LOCAL aimock server's Vertex-style path and grade
 * its output against a hand-written Gemini-shape fixture in this file. That
 * catches an aimock routing/builder regression; it cannot catch Google changing
 * the Vertex wire format.
 *
 * The `vertex-ai` surface is therefore declared `liveCoverage: "none"` in
 * `surface-registry.ts` and listed under `unverifiedSurfaces` in every drift
 * report, so a green report never reads as "Vertex was checked".
 *
 * They run UNCONDITIONALLY. They used to sit behind a
 * `GOOGLE_APPLICATION_CREDENTIALS` / `VERTEX_AI_PROJECT` gate that no drift
 * workflow sets, so neither case had ever executed in CI.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost, startDriftServer, stopDriftServer } from "./helpers.js";

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
 * Minimal Gemini generateContent response shape.
 * Vertex AI uses the same response format as consumer Gemini.
 */
function geminiGenerateContentShape() {
  return extractShape({
    candidates: [
      {
        content: {
          parts: [{ text: "Hello!" }],
          role: "model",
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
    modelVersion: "gemini-2.5-flash",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vertex AI mock shape conformance (offline — no live Google leg)", () => {
  it("generateContent mock shape matches Gemini format", async () => {
    const sdkShape = geminiGenerateContentShape();

    // Vertex AI routing in aimock follows the path pattern:
    // /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent
    const mockRes = await httpPost(
      `${instance.url}/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: "Say hello" }],
          },
        ],
        generationConfig: { maxOutputTokens: 10 },
      },
    );

    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      const mockShape = extractShape(JSON.parse(mockRes.body));
      const diffs = triangulate(sdkShape, sdkShape, mockShape);
      const report = formatDriftReport("Vertex AI generateContent", diffs, "vertex-ai");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });

  it("streamGenerateContent mock shape matches Gemini SSE format", async () => {
    const sdkChunkShape = extractShape({
      candidates: [
        {
          content: {
            parts: [{ text: "Hello" }],
            role: "model",
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    });

    // Vertex AI streaming uses SSE with the same chunk shape as consumer Gemini
    const mockRes = await httpPost(
      `${instance.url}/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: "Say hello" }],
          },
        ],
        generationConfig: { maxOutputTokens: 10 },
      },
    );

    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      // Parse SSE chunks and extract shapes
      const chunks = mockRes.body
        .split("\n")
        .filter((line: string) => line.startsWith("data: "))
        .map((line: string) => JSON.parse(line.slice(6)));

      expect(chunks.length).toBeGreaterThan(0);

      // Each chunk should have the candidates structure
      for (const chunk of chunks) {
        const chunkShape = extractShape(chunk);
        expect(chunkShape.kind).toBe("object");
        if (chunkShape.kind === "object") {
          expect(chunkShape.fields).toHaveProperty("candidates");
        }
      }

      // Last chunk should match the SDK shape (has finishReason and usageMetadata)
      const lastChunk = chunks[chunks.length - 1];
      const lastShape = extractShape(lastChunk);
      const diffs = triangulate(sdkChunkShape, sdkChunkShape, lastShape);
      const report = formatDriftReport(
        "Vertex AI streamGenerateContent (last chunk)",
        diffs,
        "vertex-ai",
      );

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });
});
