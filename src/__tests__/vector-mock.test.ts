import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { VectorMock } from "../vector-mock.js";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";

// ---- HTTP Helpers ----

interface HttpResult {
  status: number;
  body: string;
}

function request(url: string, path: string, method: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      ...(payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(payload)),
          }
        : {}),
    };
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method,
        headers,
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
    if (payload) req.write(payload);
    req.end();
  });
}

function get(url: string, path: string): Promise<HttpResult> {
  return request(url, path, "GET");
}

function post(url: string, path: string, body: unknown): Promise<HttpResult> {
  return request(url, path, "POST", body);
}

function put(url: string, path: string, body: unknown): Promise<HttpResult> {
  return request(url, path, "PUT", body);
}

function del(url: string, path: string): Promise<HttpResult> {
  return request(url, path, "DELETE");
}

// ---- Tests ----

describe("VectorMock", () => {
  let vector: VectorMock | null = null;
  let llm: LLMock | null = null;

  afterEach(async () => {
    if (vector) {
      try {
        await vector.stop();
      } catch {
        // not started
      }
      vector = null;
    }
    if (llm) {
      try {
        await llm.stop();
      } catch {
        // not started
      }
      llm = null;
    }
  });

  // ---- Standalone mode ----

  describe("standalone mode", () => {
    it("starts and stops", async () => {
      vector = new VectorMock();
      const url = await vector.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      await vector.stop();
      vector = null;
    });
  });

  // ---- Mounted mode ----

  describe("mounted mode", () => {
    it("routes via LLMock mount", async () => {
      vector = new VectorMock();
      vector
        .addCollection("default", { dimension: 3 })
        .onQuery("default", [{ id: "v1", score: 0.95 }]);

      llm = new LLMock();
      llm.mount("/vector", vector);
      await llm.start();

      const res = await post(llm.url, "/vector/query", {
        vector: [0.1, 0.2, 0.3],
        topK: 5,
        namespace: "default",
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.matches).toHaveLength(1);
      expect(data.matches[0].id).toBe("v1");
    });
  });

  // ---- Configuration ----

  describe("addCollection + onQuery", () => {
    it("static results", async () => {
      vector = new VectorMock();
      vector.addCollection("test-col", { dimension: 3 });
      vector.onQuery("test-col", [
        { id: "a", score: 0.9, metadata: { label: "first" } },
        { id: "b", score: 0.8 },
      ]);
      const url = await vector.start();

      const res = await post(url, "/query", {
        vector: [1, 2, 3],
        topK: 10,
        namespace: "test-col",
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.matches).toHaveLength(2);
      expect(data.matches[0].id).toBe("a");
      expect(data.matches[0].metadata).toEqual({ label: "first" });
    });

    it("function handler", async () => {
      vector = new VectorMock();
      vector.addCollection("dynamic", { dimension: 2 });
      vector.onQuery("dynamic", (query) => {
        const topK = query.topK ?? 1;
        return Array.from({ length: topK }, (_, i) => ({
          id: `result-${i}`,
          score: 1 - i * 0.1,
        }));
      });
      const url = await vector.start();

      const res = await post(url, "/query", {
        vector: [1, 0],
        topK: 3,
        namespace: "dynamic",
      });
      const data = JSON.parse(res.body);
      expect(data.matches).toHaveLength(3);
      expect(data.matches[0].id).toBe("result-0");
      expect(data.matches[2].id).toBe("result-2");
    });
  });

  // ---- Pinecone endpoints ----

  describe("Pinecone", () => {
    it("POST /query returns correct response format", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 3 });
      vector.onQuery("default", [
        { id: "vec-1", score: 0.99, metadata: { category: "test" } },
        { id: "vec-2", score: 0.85 },
      ]);
      const url = await vector.start();

      const res = await post(url, "/query", {
        vector: [0.1, 0.2, 0.3],
        topK: 5,
        namespace: "default",
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.matches).toBeDefined();
      expect(data.matches).toHaveLength(2);
      expect(data.matches[0]).toEqual({ id: "vec-1", score: 0.99, metadata: { category: "test" } });
      expect(data.matches[1]).toEqual({ id: "vec-2", score: 0.85 });
    });

    it("POST /vectors/upsert returns upsertedCount", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 2 });
      const url = await vector.start();

      const res = await post(url, "/vectors/upsert", {
        vectors: [
          { id: "v1", values: [1.0, 2.0], metadata: { tag: "a" } },
          { id: "v2", values: [3.0, 4.0] },
        ],
        namespace: "default",
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.upsertedCount).toBe(2);
    });

    it("POST /vectors/delete returns ok", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 2 });
      vector.upsert("default", [
        { id: "v1", values: [1, 2] },
        { id: "v2", values: [3, 4] },
      ]);
      const url = await vector.start();

      const res = await post(url, "/vectors/delete", {
        ids: ["v1"],
        namespace: "default",
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toEqual({});
    });

    it("GET /describe-index-stats", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 128 });
      vector.upsert("default", [
        { id: "v1", values: new Array(128).fill(0) },
        { id: "v2", values: new Array(128).fill(0) },
      ]);
      const url = await vector.start();

      const res = await get(url, "/describe-index-stats");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.dimension).toBe(128);
      expect(data.totalVectorCount).toBe(2);
    });
  });

  // ---- Qdrant endpoints ----

  describe("Qdrant", () => {
    it("POST /collections/{name}/points/search returns correct format", async () => {
      vector = new VectorMock();
      vector.addCollection("my-col", { dimension: 3 });
      vector.onQuery("my-col", [{ id: "q1", score: 0.95, metadata: { source: "web" } }]);
      const url = await vector.start();

      const res = await post(url, "/collections/my-col/points/search", {
        vector: [0.1, 0.2, 0.3],
        limit: 5,
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.result).toBeDefined();
      expect(data.result).toHaveLength(1);
      expect(data.result[0]).toEqual({ id: "q1", score: 0.95, payload: { source: "web" } });
    });

    it("PUT /collections/{name}/points returns ok", async () => {
      vector = new VectorMock();
      vector.addCollection("my-col", { dimension: 2 });
      const url = await vector.start();

      const res = await put(url, "/collections/my-col/points", {
        points: [
          { id: "p1", vector: [1.0, 2.0], payload: { tag: "a" } },
          { id: "p2", vector: [3.0, 4.0] },
        ],
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("ok");
    });

    it("POST /collections/{name}/points/delete returns ok", async () => {
      vector = new VectorMock();
      vector.addCollection("my-col", { dimension: 2 });
      vector.upsert("my-col", [{ id: "p1", values: [1, 2] }]);
      const url = await vector.start();

      const res = await post(url, "/collections/my-col/points/delete", {
        points: ["p1"],
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe("ok");
    });
  });

  // ---- ChromaDB endpoints ----

  describe("ChromaDB", () => {
    it("POST /api/v1/collections/{id}/query returns correct format", async () => {
      vector = new VectorMock();
      vector.addCollection("chroma-col", { dimension: 3 });
      vector.onQuery("chroma-col", [
        { id: "c1", score: 0.12, metadata: { source: "doc" } },
        { id: "c2", score: 0.34 },
      ]);
      const url = await vector.start();

      const res = await post(url, "/api/v1/collections/chroma-col/query", {
        query_embeddings: [[0.1, 0.2, 0.3]],
        n_results: 5,
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ids).toEqual([["c1", "c2"]]);
      expect(data.distances).toEqual([[0.12, 0.34]]);
      expect(data.metadatas).toEqual([[{ source: "doc" }, null]]);
    });

    it("POST /api/v1/collections/{id}/add returns true", async () => {
      vector = new VectorMock();
      vector.addCollection("chroma-col", { dimension: 2 });
      const url = await vector.start();

      const res = await post(url, "/api/v1/collections/chroma-col/add", {
        ids: ["d1", "d2"],
        embeddings: [
          [1, 2],
          [3, 4],
        ],
        metadatas: [{ label: "a" }, { label: "b" }],
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toBe(true);
    });

    it("GET /api/v1/collections lists collections", async () => {
      vector = new VectorMock();
      vector.addCollection("col-a", { dimension: 3 });
      vector.addCollection("col-b", { dimension: 5 });
      const url = await vector.start();

      const res = await get(url, "/api/v1/collections");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveLength(2);
      const names = data.map((c: { name: string }) => c.name).sort();
      expect(names).toEqual(["col-a", "col-b"]);
    });

    it("DELETE /api/v1/collections/{id} deletes collection", async () => {
      vector = new VectorMock();
      vector.addCollection("to-delete", { dimension: 3 });
      const url = await vector.start();

      const res = await del(url, "/api/v1/collections/to-delete");
      expect(res.status).toBe(200);

      // Verify it's gone
      const listRes = await get(url, "/api/v1/collections");
      const data = JSON.parse(listRes.body);
      expect(data).toHaveLength(0);
    });
  });

  // ---- Error cases ----

  describe("error handling", () => {
    it("unknown collection returns 404", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/query", {
        vector: [1, 2, 3],
        topK: 5,
        namespace: "nonexistent",
      });
      expect(res.status).toBe(404);
    });

    it("malformed JSON body returns 400 for POST (standalone)", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      // Send invalid JSON via raw http request
      const parsed = new URL(url);
      const result = await new Promise<HttpResult>((resolve, reject) => {
        const payload = "not valid json {{{";
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: "/query",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
      expect(result.status).toBe(400);
      const data = JSON.parse(result.body);
      expect(data.error).toBe("Malformed JSON body");
    });

    it("malformed JSON body returns 400 for POST (mounted mode)", async () => {
      vector = new VectorMock();
      llm = new LLMock();
      llm.mount("/vector", vector);
      await llm.start();

      const parsed = new URL(llm.url);
      const result = await new Promise<HttpResult>((resolve, reject) => {
        const payload = "not valid json {{{";
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: "/vector/query",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
      expect(result.status).toBe(400);
      const data = JSON.parse(result.body);
      expect(data.error).toBe("Malformed JSON body");
    });

    it("malformed JSON body is ignored for GET requests", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 128 });
      vector.upsert("default", [{ id: "v1", values: new Array(128).fill(0) }]);
      const url = await vector.start();

      // GET with invalid body should still work (body ignored for GET)
      const parsed = new URL(url);
      const result = await new Promise<HttpResult>((resolve, reject) => {
        const payload = "not valid json";
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: "/describe-index-stats",
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
      expect(result.status).toBe(200);
      const data = JSON.parse(result.body);
      expect(data.dimension).toBe(128);
    });

    it("unhandled route returns 404 in standalone mode", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await get(url, "/nonexistent/path");
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toBe("Not found");
    });

    it("Qdrant search on non-existent collection returns 404", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/collections/missing/points/search", {
        vector: [0.1, 0.2],
        limit: 5,
      });
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.status.error).toContain("missing");
    });

    it("ChromaDB query on non-existent collection returns 404", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/api/v1/collections/missing/query", {
        query_embeddings: [[0.1, 0.2]],
        n_results: 5,
      });
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("missing");
    });

    it("ChromaDB delete on non-existent collection returns 404", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await del(url, "/api/v1/collections/missing");
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("missing");
    });
  });

  // ---- Default/edge-case behavior ----

  describe("defaults and edge cases", () => {
    it("Pinecone query uses 'default' namespace when none specified", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 2 });
      vector.onQuery("default", [{ id: "d1", score: 0.5 }]);
      const url = await vector.start();

      const res = await post(url, "/query", {
        vector: [1, 0],
        topK: 5,
        // no namespace field
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.matches).toHaveLength(1);
      expect(data.matches[0].id).toBe("d1");
    });

    it("Pinecone query defaults topK to 10 and truncates results", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 2 });
      // Return 15 results from handler
      vector.onQuery(
        "default",
        Array.from({ length: 15 }, (_, i) => ({ id: `v${i}`, score: 1 - i * 0.01 })),
      );
      const url = await vector.start();

      // No topK specified - should default to 10
      const res = await post(url, "/query", {
        vector: [1, 0],
        namespace: "default",
      });
      const data = JSON.parse(res.body);
      expect(data.matches).toHaveLength(10);
    });

    it("Pinecone upsert auto-creates collection", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/vectors/upsert", {
        vectors: [{ id: "v1", values: [1.0, 2.0] }],
        namespace: "auto-created",
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.upsertedCount).toBe(1);

      // Verify the collection exists via describe-index-stats
      const stats = await get(url, "/describe-index-stats");
      const statsData = JSON.parse(stats.body);
      expect(statsData.totalVectorCount).toBe(1);
    });

    it("Pinecone upsert with default namespace", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/vectors/upsert", {
        vectors: [{ id: "v1", values: [1.0, 2.0] }],
        // no namespace - defaults to "default"
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).upsertedCount).toBe(1);
    });

    it("Pinecone delete on non-existent collection is a no-op", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/vectors/delete", {
        ids: ["v1"],
        namespace: "nonexistent",
      });
      expect(res.status).toBe(200);
    });

    it("Pinecone delete with default namespace", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/vectors/delete", {
        ids: ["v1"],
        // no namespace - defaults to "default"
      });
      expect(res.status).toBe(200);
    });

    it("Qdrant upsert auto-creates collection", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await put(url, "/collections/new-col/points", {
        points: [{ id: "p1", vector: [1.0, 2.0], payload: { tag: "auto" } }],
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("ok");
    });

    it("Qdrant delete on non-existent collection is a no-op", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/collections/nonexistent/points/delete", {
        points: ["p1"],
      });
      expect(res.status).toBe(200);
    });

    it("Qdrant search defaults limit to 10 and truncates results", async () => {
      vector = new VectorMock();
      vector.addCollection("test-qdrant", { dimension: 2 });
      vector.onQuery(
        "test-qdrant",
        Array.from({ length: 15 }, (_, i) => ({ id: `q${i}`, score: 1 - i * 0.01 })),
      );
      const url = await vector.start();

      const res = await post(url, "/collections/test-qdrant/points/search", {
        vector: [1, 0],
        // no limit specified - defaults to 10
      });
      const data = JSON.parse(res.body);
      expect(data.result).toHaveLength(10);
    });

    it("ChromaDB add auto-creates collection", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/api/v1/collections/auto-col/add", {
        ids: ["d1"],
        embeddings: [[1, 2, 3]],
        metadatas: [{ label: "auto" }],
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toBe(true);

      // Verify collection shows up
      const listRes = await get(url, "/api/v1/collections");
      const list = JSON.parse(listRes.body);
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("auto-col");
    });

    it("ChromaDB query with multiple query_embeddings", async () => {
      vector = new VectorMock();
      vector.addCollection("multi-q", { dimension: 2 });
      vector.onQuery("multi-q", [{ id: "r1", score: 0.5 }]);
      const url = await vector.start();

      const res = await post(url, "/api/v1/collections/multi-q/query", {
        query_embeddings: [
          [1, 0],
          [0, 1],
        ],
        n_results: 5,
      });
      const data = JSON.parse(res.body);
      // Should have results for each query embedding
      expect(data.ids).toHaveLength(2);
      expect(data.distances).toHaveLength(2);
      expect(data.metadatas).toHaveLength(2);
    });

    it("ChromaDB query defaults n_results to 10", async () => {
      vector = new VectorMock();
      vector.addCollection("default-n", { dimension: 2 });
      vector.onQuery(
        "default-n",
        Array.from({ length: 15 }, (_, i) => ({ id: `c${i}`, score: i * 0.1 })),
      );
      const url = await vector.start();

      const res = await post(url, "/api/v1/collections/default-n/query", {
        query_embeddings: [[1, 0]],
        // no n_results - defaults to 10
      });
      const data = JSON.parse(res.body);
      expect(data.ids[0]).toHaveLength(10);
    });

    it("describe-index-stats with no collections returns zeros", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await get(url, "/describe-index-stats");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.dimension).toBe(0);
      expect(data.totalVectorCount).toBe(0);
    });

    it("Qdrant search result uses payload instead of metadata", async () => {
      vector = new VectorMock();
      vector.addCollection("qdrant-meta", { dimension: 2 });
      vector.onQuery("qdrant-meta", [{ id: "q1", score: 0.8 }]);
      const url = await vector.start();

      const res = await post(url, "/collections/qdrant-meta/points/search", {
        vector: [1, 0],
        limit: 5,
      });
      const data = JSON.parse(res.body);
      // No metadata -> no payload key at all
      expect(data.result[0]).toEqual({ id: "q1", score: 0.8 });
      expect(data.result[0]).not.toHaveProperty("payload");
    });

    it("Pinecone query result omits metadata when undefined", async () => {
      vector = new VectorMock();
      vector.addCollection("no-meta", { dimension: 2 });
      vector.onQuery("no-meta", [{ id: "v1", score: 0.9 }]);
      const url = await vector.start();

      const res = await post(url, "/query", {
        vector: [1, 0],
        topK: 5,
        namespace: "no-meta",
      });
      const data = JSON.parse(res.body);
      expect(data.matches[0]).toEqual({ id: "v1", score: 0.9 });
      expect(data.matches[0]).not.toHaveProperty("metadata");
    });
  });

  // ---- Reset ----

  describe("reset", () => {
    it("clears collections and query handlers", async () => {
      vector = new VectorMock();
      vector.addCollection("test", { dimension: 3 });
      vector.onQuery("test", [{ id: "v1", score: 0.9 }]);

      vector.reset();

      expect(vector.health().collections).toBe(0);
    });

    it("reset clears query handlers so queries return empty", async () => {
      vector = new VectorMock();
      vector.addCollection("test", { dimension: 3 });
      vector.onQuery("test", [{ id: "v1", score: 0.9 }]);
      const url = await vector.start();

      vector.reset();
      vector.addCollection("test", { dimension: 3 });

      const res = await post(url, "/query", {
        vector: [1, 2, 3],
        topK: 5,
        namespace: "test",
      });
      const data = JSON.parse(res.body);
      expect(data.matches).toHaveLength(0);
    });
  });

  // ---- Health ----

  describe("health", () => {
    it("returns collection count", () => {
      vector = new VectorMock();
      vector.addCollection("a", { dimension: 3 });
      vector.addCollection("b", { dimension: 5 });

      const health = vector.health();
      expect(health).toEqual({ status: "ok", collections: 2 });
    });
  });

  // ---- Journal ----

  describe("journal", () => {
    it("shared journal with service: vector", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 3 });
      vector.onQuery("default", [{ id: "v1", score: 0.9 }]);

      llm = new LLMock();
      llm.mount("/vector", vector);
      await llm.start();

      await post(llm.url, "/vector/query", {
        vector: [1, 2, 3],
        topK: 5,
        namespace: "default",
      });

      const entries = llm.getRequests();
      const vectorEntries = entries.filter((e) => e.service === "vector");
      expect(vectorEntries.length).toBeGreaterThan(0);
      expect(vectorEntries[0].service).toBe("vector");
    });
  });

  // ---- getRequests ----

  describe("getRequests", () => {
    it("returns empty array without journal", () => {
      vector = new VectorMock();
      expect(vector.getRequests()).toEqual([]);
    });
  });

  // ---- Lifecycle errors ----

  describe("lifecycle", () => {
    it("start() throws if already started", async () => {
      vector = new VectorMock();
      await vector.start();
      await expect(vector.start()).rejects.toThrow("Server already started");
    });

    it("stop() throws if not started", async () => {
      vector = new VectorMock();
      await expect(vector.stop()).rejects.toThrow("Server not started");
    });
  });

  // ---- deleteCollection ----

  describe("deleteCollection", () => {
    it("removes the collection and its query handler", () => {
      vector = new VectorMock();
      vector.addCollection("to-remove", { dimension: 3 });
      vector.onQuery("to-remove", [{ id: "v1", score: 0.9 }]);

      vector.deleteCollection("to-remove");
      expect(vector.health().collections).toBe(0);
    });
  });

  // ---- upsert method ----

  describe("upsert method", () => {
    it("auto-creates collection when it does not exist", async () => {
      vector = new VectorMock();
      vector.upsert("auto", [{ id: "v1", values: [1, 2, 3] }]);
      expect(vector.health().collections).toBe(1);
    });

    it("updates existing vectors in a collection", async () => {
      vector = new VectorMock();
      vector.addCollection("col", { dimension: 2 });
      vector.upsert("col", [{ id: "v1", values: [1, 2] }]);
      vector.upsert("col", [{ id: "v1", values: [3, 4] }]);
      // Should still have 1 collection, and the vector is updated (not duplicated)
      expect(vector.health().collections).toBe(1);
    });
  });

  // ---- Constructor options ----

  describe("constructor", () => {
    it("accepts custom host and port options", async () => {
      vector = new VectorMock({ host: "127.0.0.1", port: 0 });
      const url = await vector.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  // ---- ChromaDB add edge cases ----

  describe("ChromaDB add edge cases", () => {
    it("adds with missing optional fields (no embeddings, no metadatas)", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/api/v1/collections/sparse-col/add", {
        ids: ["d1", "d2"],
        // no embeddings, no metadatas
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toBe(true);
    });

    it("adds with missing embedding for specific index", async () => {
      vector = new VectorMock();
      vector.addCollection("partial", { dimension: 2 });
      const url = await vector.start();

      // embeddings array shorter than ids - embeddings[1] will be undefined
      const res = await post(url, "/api/v1/collections/partial/add", {
        ids: ["d1", "d2"],
        embeddings: [[1, 2]],
        metadatas: [{ a: 1 }, { b: 2 }],
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toBe(true);
    });
  });

  // ---- Standalone journal ----

  describe("standalone journal", () => {
    it("journals requests in standalone mode when journal is set via setJournal", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 3 });
      vector.onQuery("default", [{ id: "v1", score: 0.9 }]);

      // Manually set a journal to cover the standalone journal branch
      const journal = new Journal();
      vector.setJournal(journal);

      const url = await vector.start();

      await post(url, "/query", {
        vector: [1, 2, 3],
        topK: 5,
        namespace: "default",
      });

      // getRequests should return journal entries filtered to service=vector
      const requests = vector.getRequests();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0].service).toBe("vector");
    });

    it("does NOT journal unhandled requests in standalone mode", async () => {
      vector = new VectorMock();
      const journal = new Journal();
      vector.setJournal(journal);
      const url = await vector.start();

      const res = await get(url, "/nonexistent");
      expect(res.status).toBe(404);

      // Unhandled 404 should NOT create a journal entry
      const requests = vector.getRequests();
      expect(requests).toHaveLength(0);
    });

    it("journals handled requests in standalone mode", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 128 });
      vector.upsert("default", [{ id: "v1", values: new Array(128).fill(0) }]);
      const journal = new Journal();
      vector.setJournal(journal);
      const url = await vector.start();

      const res = await get(url, "/describe-index-stats");
      expect(res.status).toBe(200);

      // Handled 200 SHOULD create a journal entry
      const requests = vector.getRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].service).toBe("vector");
    });

    it("journals requests in mounted mode via LLMock", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 3 });
      vector.onQuery("default", [{ id: "v1", score: 0.9 }]);

      llm = new LLMock();
      llm.mount("/vector", vector);
      await llm.start();

      await post(llm.url, "/vector/query", {
        vector: [1, 2, 3],
        topK: 5,
        namespace: "default",
      });

      const requests = vector.getRequests();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0].service).toBe("vector");
    });
  });

  // ---- Qdrant URL-encoded collection names ----

  describe("URL-encoded collection names", () => {
    it("Qdrant handles URL-encoded collection names", async () => {
      vector = new VectorMock();
      vector.addCollection("my collection", { dimension: 2 });
      vector.onQuery("my collection", [{ id: "q1", score: 0.8 }]);
      const url = await vector.start();

      const res = await post(url, "/collections/my%20collection/points/search", {
        vector: [1, 0],
        limit: 5,
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.result).toHaveLength(1);
    });
  });

  // ---- resolveQuery with no handler ----

  describe("query with no handler", () => {
    it("returns empty matches when collection exists but no query handler set", async () => {
      vector = new VectorMock();
      vector.addCollection("no-handler", { dimension: 2 });
      const url = await vector.start();

      const res = await post(url, "/query", {
        vector: [1, 0],
        topK: 5,
        namespace: "no-handler",
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.matches).toHaveLength(0);
    });
  });

  // ---- Missing/empty body field defaults ----

  describe("missing body field defaults", () => {
    it("Qdrant delete with no points field defaults to empty array", async () => {
      vector = new VectorMock();
      vector.addCollection("qdrant-del", { dimension: 2 });
      vector.upsert("qdrant-del", [{ id: "p1", values: [1, 2] }]);
      const url = await vector.start();

      // Send body without 'points' field — should default to empty array, delete nothing
      const res = await post(url, "/collections/qdrant-del/points/delete", {});
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("ok");
    });

    it("ChromaDB query with no query_embeddings field returns empty results", async () => {
      vector = new VectorMock();
      vector.addCollection("chroma-empty", { dimension: 2 });
      vector.onQuery("chroma-empty", [{ id: "c1", score: 0.5 }]);
      const url = await vector.start();

      // Send body without 'query_embeddings' — should default to empty array
      const res = await post(url, "/api/v1/collections/chroma-empty/query", {});
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ids).toEqual([]);
      expect(data.distances).toEqual([]);
      expect(data.metadatas).toEqual([]);
    });

    it("ChromaDB add with no ids field is a no-op", async () => {
      vector = new VectorMock();
      vector.addCollection("chroma-noid", { dimension: 2 });
      const url = await vector.start();

      // Send body without 'ids' — should default to empty array, add nothing
      const res = await post(url, "/api/v1/collections/chroma-noid/add", {});
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toBe(true);
    });

    it("Pinecone upsert with no vectors field defaults to empty array", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 2 });
      const url = await vector.start();

      const res = await post(url, "/vectors/upsert", {
        namespace: "default",
        // no vectors field
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).upsertedCount).toBe(0);
    });

    it("Pinecone upsert auto-creates collection with dimension 0 when vectors is empty", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await post(url, "/vectors/upsert", {
        vectors: [],
        namespace: "empty-vec",
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).upsertedCount).toBe(0);

      // Collection was auto-created with dimension 0
      const stats = await get(url, "/describe-index-stats");
      const data = JSON.parse(stats.body);
      expect(data.dimension).toBe(0);
      expect(data.totalVectorCount).toBe(0);
    });

    it("Qdrant upsert auto-creates collection with dimension 0 when points is empty", async () => {
      vector = new VectorMock();
      const url = await vector.start();

      const res = await put(url, "/collections/empty-qdrant/points", {
        points: [],
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("ok");
    });

    it("Pinecone delete with no ids field defaults to empty array", async () => {
      vector = new VectorMock();
      vector.addCollection("default", { dimension: 2 });
      vector.upsert("default", [{ id: "v1", values: [1, 2] }]);
      const url = await vector.start();

      const res = await post(url, "/vectors/delete", {
        namespace: "default",
        // no ids field
      });
      expect(res.status).toBe(200);
    });

    it("Qdrant upsert with no points field defaults to empty array", async () => {
      vector = new VectorMock();
      vector.addCollection("qdrant-empty", { dimension: 2 });
      const url = await vector.start();

      const res = await put(url, "/collections/qdrant-empty/points", {});
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("ok");
    });
  });
});
