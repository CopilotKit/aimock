/**
 * OpenAI Moderations API drift tests.
 *
 * Validates the aimock moderation response shape against the OpenAI
 * Moderations API spec: { id, model, results: [{ flagged, categories, category_scores }] }.
 *
 * This is a mock-only test — the handler returns a default unflagged result
 * without requiring a real API key.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import { openaiModerationResponseShape } from "./sdk-shapes.js";
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
// Tests
// ---------------------------------------------------------------------------

describe("OpenAI Moderations drift", () => {
  it("moderation response shape matches", async () => {
    const sdkShape = openaiModerationResponseShape();

    const mockRes = await httpPost(`${instance.url}/v1/moderations`, {
      input: "Hello world",
    });

    const mockBody = JSON.parse(mockRes.body);

    expect(mockRes.status).toBe(200);
    expect(mockBody.id).toMatch(/^modr-/);
    expect(mockBody.model).toBe("text-moderation-latest");
    expect(mockBody.results).toBeInstanceOf(Array);
    expect(mockBody.results).toHaveLength(1);

    const mockShape = extractShape(mockBody);
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("OpenAI Moderations", diffs, "moderation");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("moderation result contains all required category fields", async () => {
    const mockRes = await httpPost(`${instance.url}/v1/moderations`, {
      input: "Test content",
    });

    const mockBody = JSON.parse(mockRes.body);
    const result = mockBody.results[0];

    // Validate required fields exist
    expect(result).toHaveProperty("flagged");
    expect(typeof result.flagged).toBe("boolean");
    expect(result).toHaveProperty("categories");
    expect(result).toHaveProperty("category_scores");

    // Validate all standard OpenAI moderation categories
    const expectedCategories = [
      "sexual",
      "hate",
      "harassment",
      "self-harm",
      "sexual/minors",
      "hate/threatening",
      "violence/graphic",
      "self-harm/intent",
      "self-harm/instructions",
      "harassment/threatening",
      "violence",
      "illicit",
      "illicit/violent",
    ];

    for (const cat of expectedCategories) {
      expect(result.categories, `Missing category: ${cat}`).toHaveProperty(cat);
      expect(typeof result.categories[cat], `categories.${cat} should be boolean`).toBe("boolean");
      expect(result.category_scores, `Missing category_score: ${cat}`).toHaveProperty(cat);
      expect(typeof result.category_scores[cat], `category_scores.${cat} should be number`).toBe(
        "number",
      );
    }
  });

  it("array input is accepted", async () => {
    const mockRes = await httpPost(`${instance.url}/v1/moderations`, {
      input: ["Hello", "World"],
    });

    const mockBody = JSON.parse(mockRes.body);

    expect(mockRes.status).toBe(200);
    expect(mockBody.id).toMatch(/^modr-/);
    expect(mockBody.results).toHaveLength(1);
    expect(mockBody.results[0].flagged).toBe(false);
  });

  it("malformed JSON returns 400 error", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `${instance.url}/v1/moderations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.write("not json");
      req.end();
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("invalid_json");
  });
});
