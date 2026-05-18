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

// --- tests ---

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

describe("Cohere /v2/embed", () => {
  it("returns deterministic embeddings for multi-text request (no fixture)", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v2/embed`, {
      texts: ["hello world", "goodbye world"],
      model: "embed-v4.0",
      input_type: "search_document",
      embedding_types: ["float"],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);

    // Response shape
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
    expect(body.texts).toEqual(["hello world", "goodbye world"]);
    expect(body.meta).toEqual({ api_version: { version: "2" } });

    // Embeddings shape — one vector per input text
    expect(body.embeddings).toBeDefined();
    expect(body.embeddings.float).toBeDefined();
    expect(body.embeddings.float).toHaveLength(2);
    expect(Array.isArray(body.embeddings.float[0])).toBe(true);
    expect(body.embeddings.float[0].length).toBeGreaterThan(0);

    // All values are numbers
    for (const vec of body.embeddings.float) {
      for (const val of vec) {
        expect(typeof val).toBe("number");
      }
    }
  });

  it("deterministic fallback produces same embeddings for same input", async () => {
    instance = await createServer([]);

    const req1 = await post(`${instance.url}/v2/embed`, {
      texts: ["deterministic test"],
      model: "embed-v4.0",
      input_type: "search_document",
      embedding_types: ["float"],
    });
    const req2 = await post(`${instance.url}/v2/embed`, {
      texts: ["deterministic test"],
      model: "embed-v4.0",
      input_type: "search_document",
      embedding_types: ["float"],
    });

    const body1 = JSON.parse(req1.body);
    const body2 = JSON.parse(req2.body);
    expect(body1.embeddings.float[0]).toEqual(body2.embeddings.float[0]);
  });

  it("different inputs produce different embeddings", async () => {
    instance = await createServer([]);

    const res = await post(`${instance.url}/v2/embed`, {
      texts: ["alpha", "beta"],
      model: "embed-v4.0",
      input_type: "search_document",
      embedding_types: ["float"],
    });

    const body = JSON.parse(res.body);
    expect(body.embeddings.float[0]).not.toEqual(body.embeddings.float[1]);
  });

  it("defaults to float embedding type when none specified", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v2/embed`, {
      texts: ["hello"],
      model: "embed-v4.0",
      input_type: "search_document",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embeddings.float).toBeDefined();
    expect(body.embeddings.float).toHaveLength(1);
  });

  it("supports multiple embedding types", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v2/embed`, {
      texts: ["hello"],
      model: "embed-v4.0",
      input_type: "search_document",
      embedding_types: ["float", "int8"],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embeddings.float).toBeDefined();
    expect(body.embeddings.int8).toBeDefined();
  });

  it("returns 400 for missing model", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v2/embed`, {
      texts: ["hello"],
      input_type: "search_document",
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("model is required");
  });

  it("returns 400 for missing texts", async () => {
    instance = await createServer([]);
    const res = await post(`${instance.url}/v2/embed`, {
      model: "embed-v4.0",
      input_type: "search_document",
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("texts array is required");
  });

  it("uses fixture embedding when matched", async () => {
    const embeddingFixture: Fixture = {
      match: { inputText: "fixture test" },
      response: { embedding: [0.1, 0.2, 0.3, 0.4, 0.5] },
    };
    instance = await createServer([embeddingFixture]);

    const res = await post(`${instance.url}/v2/embed`, {
      texts: ["fixture test"],
      model: "embed-v4.0",
      input_type: "search_document",
      embedding_types: ["float"],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embeddings.float).toHaveLength(1);
    expect(body.embeddings.float[0]).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it("returns error from fixture when matched", async () => {
    const errorFixture: Fixture = {
      match: { inputText: "error test" },
      response: {
        error: { message: "Rate limited", type: "rate_limit_error" },
        status: 429,
      },
    };
    instance = await createServer([errorFixture]);

    const res = await post(`${instance.url}/v2/embed`, {
      texts: ["error test"],
      model: "embed-v4.0",
      input_type: "search_document",
      embedding_types: ["float"],
    });

    expect(res.status).toBe(429);
  });

  it("journals requests", async () => {
    instance = await createServer([]);
    await post(`${instance.url}/v2/embed`, {
      texts: ["journal test"],
      model: "embed-v4.0",
      input_type: "search_document",
      embedding_types: ["float"],
    });

    const entries = instance.journal.getAll();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries[entries.length - 1];
    expect(last.path).toBe("/v2/embed");
    expect(last.response.status).toBe(200);
  });
});
