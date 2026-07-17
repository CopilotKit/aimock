/**
 * Cohere Rerank v2 API drift tests.
 *
 * Three-way comparison: expected shape x real API x aimock output.
 * Covers POST /v2/rerank endpoint.
 *
 * Requires: COHERE_API_KEY
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { createServer } from "../../server.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { httpPost } from "./helpers.js";
import type { RerankFixture } from "../../rerank.js";

// ---------------------------------------------------------------------------
// Credentials check
// ---------------------------------------------------------------------------

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const HAS_CREDENTIALS = !!COHERE_API_KEY;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

const RERANK_FIXTURES: RerankFixture[] = [
  {
    match: /.*/,
    results: [
      { index: 0, relevance_score: 0.99 },
      { index: 1, relevance_score: 0.75 },
    ],
  },
];

beforeAll(async () => {
  instance = await createServer(
    [], // no chat fixtures needed
    { port: 0, chunkSize: 100 },
    undefined, // no mounts
    { search: [], rerank: RERANK_FIXTURES, moderation: [] },
  );
});

afterAll(async () => {
  await new Promise<void>((r) => instance.server.close(() => r()));
});

// ---------------------------------------------------------------------------
// SDK shape stubs
// ---------------------------------------------------------------------------

/**
 * Cohere Rerank v2 response shape — matches the documented API contract:
 * { id?, results: [{ index, relevance_score }], meta?: { ... } }
 */
function cohereRerankResponseShape() {
  return extractShape({
    id: "rerank-abc123",
    results: [
      {
        index: 0,
        relevance_score: 0.99,
      },
    ],
    meta: {
      billed_units: { search_units: 1 },
    },
  });
}

// ---------------------------------------------------------------------------
// Real API helper
// ---------------------------------------------------------------------------

async function cohereRerankReal(
  query: string,
  documents: string[],
): Promise<{ status: number; body: string }> {
  const res = await fetch("https://api.cohere.com/v2/rerank", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "rerank-v3.5",
      query,
      documents,
      top_n: 2,
    }),
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_CREDENTIALS)("Cohere Rerank drift", () => {
  it("/v2/rerank response shape matches", async () => {
    const sdkShape = cohereRerankResponseShape();
    const query = "What is machine learning?";
    const documents = ["ML is a subset of AI", "Deep learning overview"];

    const [realRes, mockRes] = await Promise.all([
      cohereRerankReal(query, documents),
      httpPost(`${instance.url}/v2/rerank`, {
        model: "rerank-v3.5",
        query,
        documents,
      }),
    ]);

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBe(200);

    const realShape = extractShape(JSON.parse(realRes.body));
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Cohere /v2/rerank", diffs, "rerank");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

describe("Cohere Rerank mock-only shape validation", () => {
  it("mock response has correct top-level structure", async () => {
    const mockRes = await httpPost(`${instance.url}/v2/rerank`, {
      model: "rerank-v3.5",
      query: "test query",
      documents: ["First document", "Second document"],
    });

    expect(mockRes.status).toBe(200);
    const body = JSON.parse(mockRes.body);

    // Verify top-level fields
    expect(body).toHaveProperty("id");
    expect(body.id).toMatch(/^rerank-/);
    expect(body).toHaveProperty("results");
    expect(body).toHaveProperty("meta");
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("each result has index and relevance_score (no document field)", async () => {
    const mockRes = await httpPost(`${instance.url}/v2/rerank`, {
      model: "rerank-v3.5",
      query: "test query",
      documents: ["First document", "Second document"],
    });

    expect(mockRes.status).toBe(200);
    const body = JSON.parse(mockRes.body);

    for (const result of body.results) {
      expect(result).toHaveProperty("index");
      expect(typeof result.index).toBe("number");
      expect(result).toHaveProperty("relevance_score");
      expect(typeof result.relevance_score).toBe("number");
      expect(result).not.toHaveProperty("document");
    }
  });

  it("meta contains billed_units", async () => {
    const mockRes = await httpPost(`${instance.url}/v2/rerank`, {
      model: "rerank-v3.5",
      query: "test query",
      documents: ["doc"],
    });

    expect(mockRes.status).toBe(200);
    const body = JSON.parse(mockRes.body);

    expect(body.meta).toHaveProperty("billed_units");
    expect(body.meta.billed_units).toHaveProperty("search_units");
    expect(typeof body.meta.billed_units.search_units).toBe("number");
  });

  it("mock shape matches expected SDK shape (triangulate without real)", async () => {
    const sdkShape = cohereRerankResponseShape();

    const mockRes = await httpPost(`${instance.url}/v2/rerank`, {
      model: "rerank-v3.5",
      query: "test query",
      documents: ["First document", "Second document"],
    });

    expect(mockRes.status).toBe(200);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    // Two-way: SDK vs mock (no real API needed)
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Cohere /v2/rerank (mock vs SDK)", diffs, "rerank");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});
