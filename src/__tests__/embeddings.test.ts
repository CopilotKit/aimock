import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import {
  isEmbeddingResponse,
  generateDeterministicEmbedding,
  buildEmbeddingResponse,
} from "../helpers.js";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// isEmbeddingResponse type guard
// ---------------------------------------------------------------------------

describe("isEmbeddingResponse", () => {
  it("identifies embedding responses", () => {
    expect(isEmbeddingResponse({ embedding: [0.1, -0.2, 0.3] })).toBe(true);
  });

  it("identifies empty embedding array as embedding response", () => {
    expect(isEmbeddingResponse({ embedding: [] })).toBe(true);
  });

  it("rejects text responses", () => {
    expect(isEmbeddingResponse({ content: "hello" })).toBe(false);
  });

  it("rejects tool call responses", () => {
    expect(isEmbeddingResponse({ toolCalls: [] })).toBe(false);
  });

  it("rejects error responses", () => {
    expect(isEmbeddingResponse({ error: { message: "fail" } })).toBe(false);
  });

  it("rejects objects where embedding is not an array", () => {
    expect(isEmbeddingResponse({ embedding: "not-an-array" } as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateDeterministicEmbedding
// ---------------------------------------------------------------------------

describe("generateDeterministicEmbedding", () => {
  it("generates an embedding of the default dimension (1536)", () => {
    const embedding = generateDeterministicEmbedding("hello");
    expect(embedding).toHaveLength(1536);
  });

  it("generates an embedding of a custom dimension", () => {
    const embedding = generateDeterministicEmbedding("hello", 768);
    expect(embedding).toHaveLength(768);
  });

  it("all values are numbers between -1 and 1", () => {
    const embedding = generateDeterministicEmbedding("test input");
    for (const val of embedding) {
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic — same input produces same output", () => {
    const a = generateDeterministicEmbedding("hello world");
    const b = generateDeterministicEmbedding("hello world");
    expect(a).toEqual(b);
  });

  it("different inputs produce different embeddings", () => {
    const a = generateDeterministicEmbedding("hello");
    const b = generateDeterministicEmbedding("goodbye");
    expect(a).not.toEqual(b);
  });

  it("generates a single-dimension embedding", () => {
    const embedding = generateDeterministicEmbedding("test", 1);
    expect(embedding).toHaveLength(1);
    expect(typeof embedding[0]).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// buildEmbeddingResponse
// ---------------------------------------------------------------------------

describe("buildEmbeddingResponse", () => {
  it("builds a valid OpenAI embedding response for a single input", () => {
    const embedding = [0.1, -0.2, 0.3];
    const response = buildEmbeddingResponse([embedding], "text-embedding-3-small");

    expect(response.object).toBe("list");
    expect(response.model).toBe("text-embedding-3-small");
    expect(response.data).toHaveLength(1);
    expect(response.data[0].object).toBe("embedding");
    expect(response.data[0].index).toBe(0);
    expect(response.data[0].embedding).toEqual(embedding);
    expect(response.usage).toEqual({ prompt_tokens: 0, total_tokens: 0 });
  });

  it("builds a response for multiple inputs with correct indices", () => {
    const embeddings = [
      [0.1, -0.2],
      [0.3, -0.4],
      [0.5, -0.6],
    ];
    const response = buildEmbeddingResponse(embeddings, "text-embedding-3-small");

    expect(response.data).toHaveLength(3);
    expect(response.data[0].index).toBe(0);
    expect(response.data[1].index).toBe(1);
    expect(response.data[2].index).toBe(2);
    expect(response.data[0].embedding).toEqual([0.1, -0.2]);
    expect(response.data[1].embedding).toEqual([0.3, -0.4]);
    expect(response.data[2].embedding).toEqual([0.5, -0.6]);
  });

  it("preserves the model name", () => {
    const response = buildEmbeddingResponse([[0.1]], "custom-model");
    expect(response.model).toBe("custom-model");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: POST /v1/embeddings
// ---------------------------------------------------------------------------

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

describe("POST /v1/embeddings (no fixture — deterministic fallback)", () => {
  it("returns a deterministic embedding for a single string input", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hello world",
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.object).toBe("list");
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].object).toBe("embedding");
    expect(body.data[0].index).toBe(0);
    expect(body.data[0].embedding).toHaveLength(1536);
    expect(body.usage).toEqual({ prompt_tokens: 0, total_tokens: 0 });
  });

  it("returns deterministic embeddings for multiple string inputs", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: ["hello", "world"],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].index).toBe(0);
    expect(body.data[1].index).toBe(1);
    expect(body.data[0].embedding).toHaveLength(1536);
    expect(body.data[1].embedding).toHaveLength(1536);
    // Different inputs produce different embeddings
    expect(body.data[0].embedding).not.toEqual(body.data[1].embedding);
  });

  it("respects the dimensions parameter", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "test",
      dimensions: 256,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data[0].embedding).toHaveLength(256);
  });

  it("is deterministic — same input produces same embedding", async () => {
    instance = await createServer([]);
    const res1 = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "deterministic test",
    });
    const res2 = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "deterministic test",
    });

    const body1 = JSON.parse(res1.body);
    const body2 = JSON.parse(res2.body);
    expect(body1.data[0].embedding).toEqual(body2.data[0].embedding);
  });
});

describe("POST /v1/embeddings (fixture matching)", () => {
  it("returns fixture embedding when inputText matches", async () => {
    const fixtures: Fixture[] = [
      {
        match: { inputText: "special" },
        response: { embedding: [0.1, 0.2, 0.3] },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "this is special input",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("returns fixture embedding for each input in a multi-input request", async () => {
    const fixtures: Fixture[] = [
      {
        match: { inputText: "match" },
        response: { embedding: [0.5, 0.6] },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: ["match this", "also match this"],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
    // Both should get the fixture embedding since the combined input matches
    expect(body.data[0].embedding).toEqual([0.5, 0.6]);
    expect(body.data[1].embedding).toEqual([0.5, 0.6]);
  });

  it("returns error fixture with correct status", async () => {
    const fixtures: Fixture[] = [
      {
        match: { inputText: "fail" },
        response: {
          error: {
            message: "Rate limited",
            type: "rate_limit_error",
            code: "rate_limit",
          },
          status: 429,
        },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "fail this request",
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
  });

  it("falls through to deterministic when no fixture matches", async () => {
    const fixtures: Fixture[] = [
      {
        match: { inputText: "specific-only" },
        response: { embedding: [0.1] },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "something completely different",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    // Should get a deterministic embedding, not the fixture
    expect(body.data[0].embedding).toHaveLength(1536);
  });
});

describe("POST /v1/embeddings (error handling)", () => {
  it("returns 400 for malformed JSON", async () => {
    instance = await createServer([]);
    const res = await postRaw(`${instance.url}/v1/embeddings`, "{not valid");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
    expect(body.error.code).toBe("invalid_json");
  });
});

describe("POST /v1/embeddings (journal)", () => {
  it("records successful embedding requests in journal", async () => {
    instance = await createServer([]);
    await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "journal test",
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.path).toBe("/v1/embeddings");
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(200);
  });

  it("records fixture-matched embedding requests", async () => {
    const fixture: Fixture = {
      match: { inputText: "tracked" },
      response: { embedding: [0.1] },
    };
    instance = await createServer([fixture]);
    await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "tracked input",
    });

    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(fixture);
  });
});

describe("POST /v1/embeddings (incompatible fixture response type)", () => {
  it("returns 500 when a non-embedding fixture matches via predicate", async () => {
    const fixtures: Fixture[] = [
      {
        match: { predicate: () => true },
        response: { content: "I am a text response, not an embedding" },
      },
    ];
    instance = await createServer(fixtures);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "anything",
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known embedding type");
  });
});

describe("POST /v1/embeddings (CORS)", () => {
  it("includes CORS headers", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "cors test",
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
