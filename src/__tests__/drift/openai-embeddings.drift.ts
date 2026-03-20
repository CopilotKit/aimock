/**
 * OpenAI Embeddings API drift tests.
 *
 * Three-way comparison: SDK types × real API × llmock output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport, shouldFail } from "./schema.js";
import { openaiEmbeddingResponseShape } from "./sdk-shapes.js";
import { openaiEmbeddings } from "./providers.js";
import { httpPost, startDriftServer, stopDriftServer } from "./helpers.js";

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

describe.skipIf(!OPENAI_API_KEY)("OpenAI Embeddings drift", () => {
  const config = { apiKey: OPENAI_API_KEY! };

  it("embedding response shape matches", async () => {
    const sdkShape = openaiEmbeddingResponseShape();

    const [realRes, mockRes] = await Promise.all([
      openaiEmbeddings(config, "Hello world"),
      httpPost(`${instance.url}/v1/embeddings`, {
        model: "text-embedding-3-small",
        input: "Hello world",
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Embeddings", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("multiple-input embedding response shape matches", async () => {
    const sdkShape = openaiEmbeddingResponseShape();

    const [realRes, mockRes] = await Promise.all([
      openaiEmbeddings(config, ["Hello", "World"]),
      httpPost(`${instance.url}/v1/embeddings`, {
        model: "text-embedding-3-small",
        input: ["Hello", "World"],
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("OpenAI Embeddings (multiple inputs)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });
});
