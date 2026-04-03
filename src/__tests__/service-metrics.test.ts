import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
import { A2AMock } from "../a2a-mock.js";
import { VectorMock } from "../vector-mock.js";

// ---- HTTP Helpers ----

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  url: string,
  path: string,
  method: string,
  body?: object,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      ...(payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(payload)),
          }
        : {}),
      ...extraHeaders,
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
            headers: res.headers,
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

function post(
  url: string,
  path: string,
  body: object,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  return request(url, path, "POST", body, extraHeaders);
}

function jsonRpc(
  url: string,
  path: string,
  method: string,
  params?: unknown,
  id?: number,
  extraHeaders?: Record<string, string>,
) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  body.id = id ?? 1;
  return post(url, path, body, extraHeaders);
}

function notification(
  url: string,
  path: string,
  method: string,
  params?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  return post(url, path, body, extraHeaders);
}

async function initMcpSession(url: string, path: string): Promise<string> {
  const res = await jsonRpc(url, path, "initialize", {}, 1);
  const sessionId = res.headers["mcp-session-id"] as string;
  await notification(url, path, "notifications/initialized", {}, { "mcp-session-id": sessionId });
  return sessionId;
}

// ---- Tests ----

describe("service metrics", () => {
  let llm: LLMock | null = null;

  afterEach(async () => {
    if (llm) {
      try {
        await llm.stop();
      } catch {
        // not started
      }
      llm = null;
    }
  });

  // ---- MCP Metrics ----

  describe("MCP metrics (aimock_mcp_requests_total)", () => {
    it("increments counter with method label for tools/list", async () => {
      const mcp = new MCPMock();
      mcp.addTool({ name: "echo", description: "Echo tool" });

      llm = new LLMock({ metrics: true });
      llm.mount("/mcp", mcp);
      const url = await llm.start();

      const sessionId = await initMcpSession(url, "/mcp");
      await jsonRpc(url, "/mcp", "tools/list", {}, 2, { "mcp-session-id": sessionId });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toContain("aimock_mcp_requests_total");
      // initialize + notifications/initialized + tools/list = 3 entries
      expect(metrics.body).toMatch(/aimock_mcp_requests_total\{method="tools\/list"\} 1/);
      expect(metrics.body).toMatch(/aimock_mcp_requests_total\{method="initialize"\} 1/);
    });

    it("increments counter for tools/call", async () => {
      const mcp = new MCPMock();
      mcp.addTool({ name: "echo", description: "Echo tool" });
      mcp.onToolCall("echo", (args) => `echo: ${JSON.stringify(args)}`);

      llm = new LLMock({ metrics: true });
      llm.mount("/mcp", mcp);
      const url = await llm.start();

      const sessionId = await initMcpSession(url, "/mcp");
      await jsonRpc(url, "/mcp", "tools/call", { name: "echo", arguments: { text: "hi" } }, 2, {
        "mcp-session-id": sessionId,
      });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toMatch(/aimock_mcp_requests_total\{method="tools\/call"\} 1/);
    });

    it("increments counter for resources/read", async () => {
      const mcp = new MCPMock();
      mcp.addResource({ uri: "file:///test.txt", name: "test" }, { text: "hello" });

      llm = new LLMock({ metrics: true });
      llm.mount("/mcp", mcp);
      const url = await llm.start();

      const sessionId = await initMcpSession(url, "/mcp");
      await jsonRpc(url, "/mcp", "resources/read", { uri: "file:///test.txt" }, 2, {
        "mcp-session-id": sessionId,
      });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toMatch(/aimock_mcp_requests_total\{method="resources\/read"\} 1/);
    });
  });

  // ---- A2A Metrics ----

  describe("A2A metrics (aimock_a2a_requests_total)", () => {
    it("increments counter for GetAgentCard", async () => {
      const a2a = new A2AMock();
      a2a.registerAgent({ name: "test-agent", description: "Test agent" });

      llm = new LLMock({ metrics: true });
      llm.mount("/a2a", a2a);
      const url = await llm.start();

      await get(url, "/a2a/.well-known/agent-card.json");

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toContain("aimock_a2a_requests_total");
      expect(metrics.body).toMatch(/aimock_a2a_requests_total\{method="GetAgentCard"\} 1/);
    });

    it("increments counter for SendMessage", async () => {
      const a2a = new A2AMock();
      a2a.registerAgent({ name: "test-agent", description: "Test agent" });
      a2a.onMessage("test-agent", "hello", [{ text: "world" }]);

      llm = new LLMock({ metrics: true });
      llm.mount("/a2a", a2a);
      const url = await llm.start();

      await post(url, "/a2a", {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            messageId: "msg-1",
            role: "ROLE_USER",
            parts: [{ text: "hello" }],
          },
        },
      });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toMatch(/aimock_a2a_requests_total\{method="SendMessage"\} 1/);
    });

    it("increments counter for GetTask", async () => {
      const a2a = new A2AMock();
      a2a.registerAgent({ name: "test-agent", description: "Test agent" });

      llm = new LLMock({ metrics: true });
      llm.mount("/a2a", a2a);
      const url = await llm.start();

      // GetTask for a nonexistent task (error, but still counted)
      await post(url, "/a2a", {
        jsonrpc: "2.0",
        id: 1,
        method: "GetTask",
        params: { id: "nonexistent" },
      });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toMatch(/aimock_a2a_requests_total\{method="GetTask"\} 1/);
    });
  });

  // ---- Vector Metrics ----

  describe("Vector metrics (aimock_vector_requests_total)", () => {
    it("increments counter for Pinecone query", async () => {
      const vector = new VectorMock();
      vector.addCollection("default", { dimension: 3 });
      vector.onQuery("default", [{ id: "v1", score: 0.9 }]);

      llm = new LLMock({ metrics: true });
      llm.mount("/vector", vector);
      const url = await llm.start();

      await post(url, "/vector/query", {
        vector: [1, 0, 0],
        topK: 5,
        namespace: "default",
      });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toContain("aimock_vector_requests_total");
      expect(metrics.body).toMatch(
        /aimock_vector_requests_total\{operation="query",provider="pinecone"\} 1/,
      );
    });

    it("increments counter for Pinecone upsert", async () => {
      const vector = new VectorMock();
      vector.addCollection("default", { dimension: 3 });

      llm = new LLMock({ metrics: true });
      llm.mount("/vector", vector);
      const url = await llm.start();

      await post(url, "/vector/vectors/upsert", {
        vectors: [{ id: "v1", values: [1, 0, 0] }],
        namespace: "default",
      });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toMatch(
        /aimock_vector_requests_total\{operation="upsert",provider="pinecone"\} 1/,
      );
    });

    it("increments counter for Qdrant search", async () => {
      const vector = new VectorMock();
      vector.addCollection("my-collection", { dimension: 3 });
      vector.onQuery("my-collection", [{ id: "v1", score: 0.9 }]);

      llm = new LLMock({ metrics: true });
      llm.mount("/vector", vector);
      const url = await llm.start();

      await post(url, "/vector/collections/my-collection/points/search", {
        vector: [1, 0, 0],
        limit: 5,
      });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toMatch(
        /aimock_vector_requests_total\{operation="query",provider="qdrant"\} 1/,
      );
    });

    it("increments counter for ChromaDB query", async () => {
      const vector = new VectorMock();
      vector.addCollection("my-collection", { dimension: 3 });
      vector.onQuery("my-collection", [{ id: "v1", score: 0.1 }]);

      llm = new LLMock({ metrics: true });
      llm.mount("/vector", vector);
      const url = await llm.start();

      await post(url, "/vector/api/v1/collections/my-collection/query", {
        query_embeddings: [[1, 0, 0]],
        n_results: 5,
      });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toMatch(
        /aimock_vector_requests_total\{operation="query",provider="chromadb"\} 1/,
      );
    });

    it("tracks multiple providers independently", async () => {
      const vector = new VectorMock();
      vector.addCollection("default", { dimension: 3 });
      vector.addCollection("my-col", { dimension: 3 });
      vector.onQuery("default", [{ id: "v1", score: 0.9 }]);
      vector.onQuery("my-col", [{ id: "v2", score: 0.8 }]);

      llm = new LLMock({ metrics: true });
      llm.mount("/vector", vector);
      const url = await llm.start();

      // Pinecone query
      await post(url, "/vector/query", {
        vector: [1, 0, 0],
        topK: 5,
        namespace: "default",
      });

      // Qdrant search
      await post(url, "/vector/collections/my-col/points/search", {
        vector: [1, 0, 0],
        limit: 5,
      });

      const metrics = await get(url, "/metrics");
      expect(metrics.body).toMatch(
        /aimock_vector_requests_total\{operation="query",provider="pinecone"\} 1/,
      );
      expect(metrics.body).toMatch(
        /aimock_vector_requests_total\{operation="query",provider="qdrant"\} 1/,
      );
    });
  });

  // ---- Metrics disabled ----

  describe("no metrics when disabled", () => {
    it("does not emit service counters when metrics is not enabled", async () => {
      const mcp = new MCPMock();
      mcp.addTool({ name: "echo", description: "Echo tool" });

      llm = new LLMock({}); // no metrics: true
      llm.mount("/mcp", mcp);
      const url = await llm.start();

      // /metrics should 404
      const res = await get(url, "/metrics");
      expect(res.status).toBe(404);
    });
  });
});
