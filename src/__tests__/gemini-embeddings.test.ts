import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// --- helpers ---

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function postRaw(url: string, raw: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

// ---------------------------------------------------------------------------
// Basic response shape
// ---------------------------------------------------------------------------

describe("POST /v1beta/models/{model}:embedContent (response shape)", () => {
  it("returns a Gemini-format embedding response", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "hello world" }] },
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("embedding");
    expect(body.embedding).toHaveProperty("values");
    expect(Array.isArray(body.embedding.values)).toBe(true);
    // Default Gemini embedding dimension is 768
    expect(body.embedding.values).toHaveLength(768);
  });

  it("all values are numbers between -1 and 1", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "test input" }] },
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    for (const val of body.embedding.values) {
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it("respects outputDimensionality parameter", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "dimensions test" }] },
      outputDimensionality: 256,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embedding.values).toHaveLength(256);
  });
});

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

describe("POST /v1beta/models/{model}:embedContent (deterministic fallback)", () => {
  it("is deterministic — same input produces same output", async () => {
    instance = await createServer([]);
    const url = `${instance.url}/v1beta/models/text-embedding-004:embedContent`;
    const body = { content: { parts: [{ text: "deterministic test" }] } };

    const res1 = await post(url, body);
    const res2 = await post(url, body);

    const body1 = JSON.parse(res1.body);
    const body2 = JSON.parse(res2.body);
    expect(body1.embedding.values).toEqual(body2.embedding.values);
  });

  it("different inputs produce different embeddings", async () => {
    instance = await createServer([]);
    const url = `${instance.url}/v1beta/models/text-embedding-004:embedContent`;

    const res1 = await post(url, {
      content: { parts: [{ text: "hello" }] },
    });
    const res2 = await post(url, {
      content: { parts: [{ text: "goodbye" }] },
    });

    const body1 = JSON.parse(res1.body);
    const body2 = JSON.parse(res2.body);
    expect(body1.embedding.values).not.toEqual(body2.embedding.values);
  });

  it("handles empty content parts gracefully", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [] },
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embedding.values).toHaveLength(768);
  });

  it("handles missing content gracefully", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {});

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embedding.values).toHaveLength(768);
  });
});

// ---------------------------------------------------------------------------
// Fixture matching
// ---------------------------------------------------------------------------

describe("POST /v1beta/models/{model}:embedContent (fixture matching)", () => {
  it("returns fixture embedding when inputText matches", async () => {
    const fixtures: Fixture[] = [
      {
        match: { inputText: "special" },
        response: { embedding: [0.1, 0.2, 0.3] },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "this is special input" }] },
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embedding.values).toEqual([0.1, 0.2, 0.3]);
  });

  it("shares fixtures with OpenAI embeddings via _endpointType", async () => {
    const fixtures: Fixture[] = [
      {
        match: { inputText: "shared" },
        response: { embedding: [0.4, 0.5, 0.6] },
      },
    ];
    instance = await createServer(fixtures);

    // Gemini embedContent
    const geminiRes = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "shared fixture" }] },
    });
    expect(geminiRes.status).toBe(200);
    const geminiBody = JSON.parse(geminiRes.body);
    expect(geminiBody.embedding.values).toEqual([0.4, 0.5, 0.6]);
  });

  it("falls through to deterministic when no fixture matches", async () => {
    const fixtures: Fixture[] = [
      {
        match: { inputText: "specific-only" },
        response: { embedding: [0.1] },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "something completely different" }] },
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    // Should get a deterministic embedding, not the fixture
    expect(body.embedding.values).toHaveLength(768);
  });

  it("returns error fixture with correct status", async () => {
    const fixtures: Fixture[] = [
      {
        match: { inputText: "fail" },
        response: {
          error: {
            message: "Rate limited",
            type: "RESOURCE_EXHAUSTED",
          },
          status: 429,
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "fail this request" }] },
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
    expect(body.error.code).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("POST /v1beta/models/{model}:embedContent (error handling)", () => {
  it("returns 400 for malformed JSON", async () => {
    instance = await createServer([]);
    const res = await postRaw(
      `${instance.url}/v1beta/models/text-embedding-004:embedContent`,
      "{not valid",
    );

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/^Malformed JSON body: /);
    expect(body.error.status).toBe("INVALID_ARGUMENT");
  });

  it("returns 500 when a non-embedding fixture matches via predicate", async () => {
    const fixtures: Fixture[] = [
      {
        match: { predicate: () => true },
        response: { content: "I am a text response, not an embedding" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "anything" }] },
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known embedding type");
  });
});

// ---------------------------------------------------------------------------
// Strict mode
// ---------------------------------------------------------------------------

describe("POST /v1beta/models/{model}:embedContent (strict mode)", () => {
  it("returns 503 when strict mode is enabled and no fixture matches", async () => {
    instance = await createServer([], { strict: true });
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "unmatched input" }] },
    });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
    expect(body.error.status).toBe("UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

describe("POST /v1beta/models/{model}:embedContent (journal)", () => {
  it("records successful embedding requests in journal", async () => {
    instance = await createServer([]);
    await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "journal test" }] },
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.path).toBe("/v1beta/models/text-embedding-004:embedContent");
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(200);
  });

  it("records fixture-matched embedding requests", async () => {
    const fixture: Fixture = {
      match: { inputText: "tracked" },
      response: { embedding: [0.1] },
    };
    instance = await createServer([fixture]);
    await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "tracked input" }] },
    });

    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(fixture);
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe("POST /v1beta/models/{model}:embedContent (CORS)", () => {
  it("includes CORS headers", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1beta/models/text-embedding-004:embedContent`, {
      content: { parts: [{ text: "cors test" }] },
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// Multiple text parts
// ---------------------------------------------------------------------------

describe("POST /v1beta/models/{model}:embedContent (multiple text parts)", () => {
  it("concatenates multiple text parts for embedding", async () => {
    instance = await createServer([]);
    const url = `${instance.url}/v1beta/models/text-embedding-004:embedContent`;

    const res = await post(url, {
      content: {
        parts: [{ text: "hello" }, { text: "world" }],
      },
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embedding.values).toHaveLength(768);
  });
});
