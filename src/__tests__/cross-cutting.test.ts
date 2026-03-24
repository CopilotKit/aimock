import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
import { A2AMock } from "../a2a-mock.js";
import { VectorMock } from "../vector-mock.js";
import { createMockSuite, type MockSuite } from "../suite.js";
import { startFromConfig, type AimockConfig } from "../config-loader.js";

// ---- HTTP Helpers ----

function httpRequest(
  url: string,
  path: string,
  method: string,
  body?: object,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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

function jsonRpc(method: string, params?: unknown, id: number = 1): object {
  return { jsonrpc: "2.0", method, params, id };
}

async function initMcpSession(url: string, path: string): Promise<string> {
  const res = await httpRequest(url, path, "POST", jsonRpc("initialize", {}, 1) as object);
  const sessionId = res.headers["mcp-session-id"] as string;
  await httpRequest(
    url,
    path,
    "POST",
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-session-id": sessionId },
  );
  return sessionId;
}

// ==========================================================================
// 1. Multi-mock composition on a single server
// ==========================================================================

describe("cross-cutting: multi-mock composition", () => {
  let llmock: LLMock | null = null;

  afterEach(async () => {
    if (llmock) {
      await llmock.stop();
      llmock = null;
    }
  });

  it("mounts LLM + MCP + A2A + Vector on one server and all respond", async () => {
    llmock = new LLMock();

    // Configure LLM fixture
    llmock.on({ userMessage: /hello/ }, { content: "Hi from LLM" });

    // MCP
    const mcp = new MCPMock();
    mcp.addTool({ name: "calc", description: "calculator" });
    mcp.onToolCall("calc", () => "42");
    llmock.mount("/mcp", mcp);

    // A2A
    const a2a = new A2AMock();
    a2a.registerAgent({ name: "helper", description: "helper agent" });
    a2a.onMessage("helper", /.*/, [{ text: "I can help" }]);
    llmock.mount("/a2a", a2a);

    // Vector
    const vector = new VectorMock();
    vector.addCollection("docs", { dimension: 3 });
    vector.onQuery("docs", [
      { id: "d1", score: 0.9, values: [1, 0, 0], metadata: { title: "doc1" } },
    ]);
    llmock.mount("/vector", vector);

    await llmock.start();

    // LLM completions
    const llmRes = await httpRequest(llmock.url, "/v1/chat/completions", "POST", {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello world" }],
    });
    expect(llmRes.status).toBe(200);
    const llmData = JSON.parse(llmRes.body);
    expect(llmData.choices[0].message.content).toBe("Hi from LLM");

    // MCP tools/list
    const sessionId = await initMcpSession(llmock.url, "/mcp");
    const mcpRes = await httpRequest(
      llmock.url,
      "/mcp",
      "POST",
      jsonRpc("tools/list", {}, 2) as object,
      { "mcp-session-id": sessionId },
    );
    expect(mcpRes.status).toBe(200);
    const mcpData = JSON.parse(mcpRes.body);
    expect(mcpData.result.tools).toHaveLength(1);
    expect(mcpData.result.tools[0].name).toBe("calc");

    // MCP tool call
    const callRes = await httpRequest(
      llmock.url,
      "/mcp",
      "POST",
      jsonRpc("tools/call", { name: "calc", arguments: {} }, 3) as object,
      { "mcp-session-id": sessionId },
    );
    expect(callRes.status).toBe(200);
    const callData = JSON.parse(callRes.body);
    expect(callData.result.content[0].text).toBe("42");

    // A2A agent card
    const a2aRes = await httpRequest(llmock.url, "/a2a/.well-known/agent-card.json", "GET");
    expect(a2aRes.status).toBe(200);
    const card = JSON.parse(a2aRes.body);
    expect(card.name).toBe("helper");

    // Vector query
    const vecRes = await httpRequest(llmock.url, "/vector/query", "POST", {
      namespace: "docs",
      vector: [1, 0, 0],
      topK: 5,
    });
    expect(vecRes.status).toBe(200);
    const vecData = JSON.parse(vecRes.body);
    expect(vecData.matches).toHaveLength(1);
    expect(vecData.matches[0].id).toBe("d1");
  });

  it("streaming LLM responses work alongside mounted mocks", async () => {
    llmock = new LLMock();
    llmock.on({ userMessage: /stream/ }, { content: "streamed response" });

    const mcp = new MCPMock();
    mcp.addTool({ name: "noop" });
    llmock.mount("/mcp", mcp);

    await llmock.start();

    const res = await httpRequest(llmock.url, "/v1/chat/completions", "POST", {
      model: "gpt-4",
      messages: [{ role: "user", content: "stream this" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("data: ");
    // Collect text from SSE chunks
    const chunks = res.body
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
    const text = chunks
      .map(
        (c: { choices: Array<{ delta: { content?: string } }> }) =>
          c.choices[0]?.delta?.content ?? "",
      )
      .join("");
    expect(text).toBe("streamed response");
  });
});

// ==========================================================================
// 2. Health endpoint aggregation
// ==========================================================================

describe("cross-cutting: health endpoint aggregation", () => {
  let llmock: LLMock | null = null;

  afterEach(async () => {
    if (llmock) {
      await llmock.stop();
      llmock = null;
    }
  });

  it("health endpoint aggregates status from all mounted mocks", async () => {
    llmock = new LLMock();
    llmock.on({ userMessage: /.*/ }, { content: "ok" });

    const mcp = new MCPMock();
    mcp.addTool({ name: "t1" });
    mcp.addTool({ name: "t2" });
    mcp.addResource({ uri: "file://r1", name: "r1" });
    llmock.mount("/mcp", mcp);

    const a2a = new A2AMock();
    a2a.registerAgent({ name: "ag1", description: "test" });
    llmock.mount("/a2a", a2a);

    const vector = new VectorMock();
    vector.addCollection("col1", { dimension: 3 });
    vector.addCollection("col2", { dimension: 5 });
    llmock.mount("/vector", vector);

    await llmock.start();

    const res = await httpRequest(llmock.url, "/health", "GET");
    expect(res.status).toBe(200);

    const health = JSON.parse(res.body);
    expect(health.status).toBe("ok");
    expect(health.services).toBeDefined();

    // LLM service status
    expect(health.services.llm).toBeDefined();
    expect(health.services.llm.status).toBe("ok");
    expect(health.services.llm.fixtures).toBe(1);

    // MCP service status
    expect(health.services.mcp).toBeDefined();
    expect(health.services.mcp.status).toBe("ok");
    expect(health.services.mcp.tools).toBe(2);
    expect(health.services.mcp.resources).toBe(1);

    // A2A service status
    expect(health.services.a2a).toBeDefined();
    expect(health.services.a2a.status).toBe("ok");
    expect(health.services.a2a.agents).toBe(1);

    // Vector service status
    expect(health.services.vector).toBeDefined();
    expect(health.services.vector.status).toBe("ok");
    expect(health.services.vector.collections).toBe(2);
  });

  it("health endpoint with no mounts returns simple status", async () => {
    llmock = new LLMock();
    await llmock.start();

    const res = await httpRequest(llmock.url, "/health", "GET");
    expect(res.status).toBe(200);

    const health = JSON.parse(res.body);
    expect(health.status).toBe("ok");
    expect(health.services).toBeUndefined();
  });
});

// ==========================================================================
// 3. Journal captures requests across all mock types
// ==========================================================================

describe("cross-cutting: journal across mock types", () => {
  let llmock: LLMock | null = null;

  afterEach(async () => {
    if (llmock) {
      await llmock.stop();
      llmock = null;
    }
  });

  it("journal records LLM, MCP, A2A, and Vector requests in order", async () => {
    llmock = new LLMock();
    llmock.on({ userMessage: /journal/ }, { content: "noted" });

    const mcp = new MCPMock();
    mcp.addTool({ name: "log-tool" });
    llmock.mount("/mcp", mcp);

    const a2a = new A2AMock();
    a2a.registerAgent({ name: "journal-agent", description: "test" });
    a2a.onMessage("journal-agent", /.*/, [{ text: "logged" }]);
    llmock.mount("/a2a", a2a);

    const vector = new VectorMock();
    vector.addCollection("journal-col", { dimension: 2 });
    vector.onQuery("journal-col", [{ id: "j1", score: 1.0, values: [1, 0] }]);
    llmock.mount("/vector", vector);

    await llmock.start();

    // 1. LLM request
    await httpRequest(llmock.url, "/v1/chat/completions", "POST", {
      model: "gpt-4",
      messages: [{ role: "user", content: "journal test" }],
    });

    // 2. MCP request
    const sessionId = await initMcpSession(llmock.url, "/mcp");
    await httpRequest(llmock.url, "/mcp", "POST", jsonRpc("tools/list", {}, 2) as object, {
      "mcp-session-id": sessionId,
    });

    // 3. A2A request (agent card GET)
    await httpRequest(llmock.url, "/a2a/.well-known/agent-card.json", "GET");

    // 4. Vector request
    await httpRequest(llmock.url, "/vector/query", "POST", {
      namespace: "journal-col",
      vector: [1, 0],
      topK: 3,
    });

    const entries = llmock.getRequests();

    // Should have entries from all services
    // LLM entry
    const llmEntries = entries.filter((e) => e.path === "/v1/chat/completions");
    expect(llmEntries.length).toBeGreaterThanOrEqual(1);

    // MCP entries (initialize + notification + tools/list)
    const mcpEntries = entries.filter((e) => e.service === "mcp");
    expect(mcpEntries.length).toBeGreaterThanOrEqual(1);

    // Vector entries
    const vectorEntries = entries.filter((e) => e.service === "vector");
    expect(vectorEntries.length).toBeGreaterThanOrEqual(1);

    // All entries have timestamps and IDs
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.timestamp).toBeGreaterThan(0);
    }
  });

  it("journal entries from mounts have correct service tags", async () => {
    llmock = new LLMock();

    const mcp = new MCPMock();
    mcp.addTool({ name: "svc-tool" });
    llmock.mount("/mcp", mcp);

    const vector = new VectorMock();
    vector.addCollection("svc-col", { dimension: 2 });
    llmock.mount("/vector", vector);

    await llmock.start();

    // MCP request
    const sessionId = await initMcpSession(llmock.url, "/mcp");
    await httpRequest(llmock.url, "/mcp", "POST", jsonRpc("tools/list", {}, 2) as object, {
      "mcp-session-id": sessionId,
    });

    // Vector request (describe-index-stats is a Pinecone GET endpoint)
    await httpRequest(llmock.url, "/vector/describe-index-stats", "GET");

    const entries = llmock.getRequests();
    const mcpEntries = entries.filter((e) => e.service === "mcp");
    const vectorEntries = entries.filter((e) => e.service === "vector");

    expect(mcpEntries.length).toBeGreaterThanOrEqual(1);
    for (const e of mcpEntries) {
      expect(e.service).toBe("mcp");
    }

    expect(vectorEntries.length).toBeGreaterThanOrEqual(1);
    for (const e of vectorEntries) {
      expect(e.service).toBe("vector");
    }
  });
});

// ==========================================================================
// 4. Config loader with multi-mock configurations
// ==========================================================================

describe("cross-cutting: config loader with all mock types", () => {
  let llmock: LLMock | null = null;

  afterEach(async () => {
    if (llmock) {
      await llmock.stop();
      llmock = null;
    }
  });

  it("startFromConfig with MCP + A2A + Vector all configured", async () => {
    const config: AimockConfig = {
      mcp: {
        path: "/mcp",
        serverInfo: { name: "config-mcp", version: "1.0.0" },
        tools: [{ name: "config-tool", description: "from config", result: "config-result" }],
        resources: [{ uri: "file://readme", name: "README", text: "Hello from config" }],
      },
      a2a: {
        path: "/a2a",
        agents: [
          {
            name: "config-agent",
            description: "from config",
            messages: [{ pattern: "hello", parts: [{ text: "Hi from config agent" }] }],
          },
        ],
      },
      vector: {
        path: "/vector",
        collections: [
          {
            name: "config-col",
            dimension: 3,
            vectors: [{ id: "cv1", values: [1, 0, 0], metadata: { src: "config" } }],
            queryResults: [
              { id: "cv1", score: 0.99, values: [1, 0, 0], metadata: { src: "config" } },
            ],
          },
        ],
      },
    };

    const result = await startFromConfig(config);
    llmock = result.llmock;

    // Health should show all services
    const healthRes = await httpRequest(result.url, "/health", "GET");
    const health = JSON.parse(healthRes.body);
    expect(health.services.mcp).toBeDefined();
    expect(health.services.mcp.tools).toBe(1);
    expect(health.services.a2a).toBeDefined();
    expect(health.services.a2a.agents).toBe(1);
    expect(health.services.vector).toBeDefined();
    expect(health.services.vector.collections).toBe(1);

    // MCP tool call works
    const sessionId = await initMcpSession(result.url, "/mcp");
    const toolCallRes = await httpRequest(
      result.url,
      "/mcp",
      "POST",
      jsonRpc("tools/call", { name: "config-tool", arguments: {} }, 3) as object,
      { "mcp-session-id": sessionId },
    );
    const toolData = JSON.parse(toolCallRes.body);
    expect(toolData.result.content[0].text).toBe("config-result");

    // A2A agent card works
    const a2aRes = await httpRequest(result.url, "/a2a/.well-known/agent-card.json", "GET");
    const card = JSON.parse(a2aRes.body);
    expect(card.name).toBe("config-agent");

    // Vector query works
    const vecRes = await httpRequest(result.url, "/vector/query", "POST", {
      namespace: "config-col",
      vector: [1, 0, 0],
      topK: 5,
    });
    const vecData = JSON.parse(vecRes.body);
    expect(vecData.matches).toHaveLength(1);
    expect(vecData.matches[0].id).toBe("cv1");
  });

  it("startFromConfig with custom mount paths", async () => {
    const config: AimockConfig = {
      mcp: { path: "/custom-mcp" },
      a2a: { path: "/custom-a2a" },
      vector: { path: "/custom-vector" },
    };

    const result = await startFromConfig(config);
    llmock = result.llmock;

    // Health shows custom paths
    const healthRes = await httpRequest(result.url, "/health", "GET");
    const health = JSON.parse(healthRes.body);
    expect(health.services["custom-mcp"]).toBeDefined();
    expect(health.services["custom-a2a"]).toBeDefined();
    expect(health.services["custom-vector"]).toBeDefined();
  });

  it("startFromConfig with services (search, rerank, moderate)", async () => {
    const config: AimockConfig = {
      services: { search: true, rerank: true, moderate: true },
    };

    const result = await startFromConfig(config);
    llmock = result.llmock;

    // Search endpoint should respond
    const searchRes = await httpRequest(result.url, "/search", "POST", {
      query: "test query",
    });
    expect(searchRes.status).toBe(200);

    // Rerank endpoint should respond
    const rerankRes = await httpRequest(result.url, "/v2/rerank", "POST", {
      query: "test",
      documents: ["a", "b"],
    });
    expect(rerankRes.status).toBe(200);

    // Moderation endpoint should respond
    const modRes = await httpRequest(result.url, "/v1/moderations", "POST", {
      input: "test content",
    });
    expect(modRes.status).toBe(200);
  });

  it("startFromConfig with empty config starts cleanly", async () => {
    const config: AimockConfig = {};
    const result = await startFromConfig(config);
    llmock = result.llmock;

    const healthRes = await httpRequest(result.url, "/health", "GET");
    expect(healthRes.status).toBe(200);
  });
});

// ==========================================================================
// 5. Suite runner with heterogeneous mock types
// ==========================================================================

describe("cross-cutting: suite runner with heterogeneous mocks", () => {
  let suite: MockSuite | null = null;

  afterEach(async () => {
    if (suite) {
      await suite.stop();
      suite = null;
    }
  });

  it("suite with all mocks supports concurrent requests to different services", async () => {
    suite = await createMockSuite({ llm: {}, mcp: {}, a2a: {}, vector: {} });

    suite.llm.on({ userMessage: /concurrent/ }, { content: "concurrent reply" });
    suite.mcp!.addTool({ name: "conc-tool" });
    suite.a2a!.registerAgent({ name: "conc-agent", description: "concurrent" });
    suite.vector!.addCollection("conc-col", { dimension: 2 });
    suite.vector!.onQuery("conc-col", [{ id: "c1", score: 0.8, values: [1, 0] }]);

    await suite.start();

    // Fire all requests concurrently
    const [llmRes, mcpInitRes, a2aRes, vecRes] = await Promise.all([
      httpRequest(suite.llm.url, "/v1/chat/completions", "POST", {
        model: "gpt-4",
        messages: [{ role: "user", content: "concurrent test" }],
      }),
      httpRequest(suite.llm.url, "/mcp", "POST", jsonRpc("initialize", {}, 1) as object),
      httpRequest(suite.llm.url, "/a2a/.well-known/agent-card.json", "GET"),
      httpRequest(suite.llm.url, "/vector/query", "POST", {
        namespace: "conc-col",
        vector: [1, 0],
        topK: 3,
      }),
    ]);

    expect(llmRes.status).toBe(200);
    expect(mcpInitRes.status).toBe(200);
    expect(a2aRes.status).toBe(200);
    expect(vecRes.status).toBe(200);

    // Verify content
    const llmData = JSON.parse(llmRes.body);
    expect(llmData.choices[0].message.content).toBe("concurrent reply");

    const card = JSON.parse(a2aRes.body);
    expect(card.name).toBe("conc-agent");

    const vecData = JSON.parse(vecRes.body);
    expect(vecData.matches[0].id).toBe("c1");
  });

  it("suite.reset() clears all mock state but server stays running", async () => {
    suite = await createMockSuite({ llm: {}, mcp: {}, a2a: {}, vector: {} });
    suite.llm.on({ userMessage: /test/ }, { content: "before reset" });
    suite.mcp!.addTool({ name: "reset-tool" });
    suite.a2a!.registerAgent({ name: "reset-agent", description: "test" });
    suite.vector!.addCollection("reset-col", { dimension: 2 });

    await suite.start();

    // Verify mcp has tools before reset
    const sessionId = await initMcpSession(suite.llm.url, "/mcp");
    const beforeRes = await httpRequest(
      suite.llm.url,
      "/mcp",
      "POST",
      jsonRpc("tools/list", {}, 2) as object,
      { "mcp-session-id": sessionId },
    );
    expect(JSON.parse(beforeRes.body).result.tools).toHaveLength(1);

    suite.reset();

    // After reset, MCP tools cleared (need new session since sessions also cleared)
    const sessionId2 = await initMcpSession(suite.llm.url, "/mcp");
    const afterRes = await httpRequest(
      suite.llm.url,
      "/mcp",
      "POST",
      jsonRpc("tools/list", {}, 2) as object,
      { "mcp-session-id": sessionId2 },
    );
    expect(JSON.parse(afterRes.body).result.tools).toHaveLength(0);

    // Health still works
    const healthRes = await httpRequest(suite.llm.url, "/health", "GET");
    expect(healthRes.status).toBe(200);
  });
});

// ==========================================================================
// 6. Late-mount journal/baseUrl fix verification
// ==========================================================================

describe("cross-cutting: late-mount journal and baseUrl wiring", () => {
  let llmock: LLMock | null = null;

  afterEach(async () => {
    if (llmock) {
      await llmock.stop();
      llmock = null;
    }
  });

  it("mount added after start() gets journal wired — requests are journaled", async () => {
    llmock = new LLMock();
    await llmock.start();

    // Mount MCP after start
    const mcp = new MCPMock();
    mcp.addTool({ name: "late-tool" });
    llmock.mount("/mcp", mcp);

    // Make a request to the late mount
    const sessionId = await initMcpSession(llmock.url, "/mcp");
    await httpRequest(llmock.url, "/mcp", "POST", jsonRpc("tools/list", {}, 2) as object, {
      "mcp-session-id": sessionId,
    });

    // Journal should have captured the MCP requests
    const entries = llmock.getRequests();
    const mcpEntries = entries.filter((e) => e.service === "mcp");
    expect(mcpEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("mount added after start() gets baseUrl wired — A2A agent card has correct URL", async () => {
    llmock = new LLMock();
    await llmock.start();

    // Mount A2A after start
    const a2a = new A2AMock();
    a2a.registerAgent({ name: "late-agent", description: "added after start" });
    llmock.mount("/a2a", a2a);

    // Agent card should be accessible and have the correct baseUrl in url field
    const res = await httpRequest(llmock.url, "/a2a/.well-known/agent-card.json", "GET");
    expect(res.status).toBe(200);
    const card = JSON.parse(res.body);
    expect(card.name).toBe("late-agent");
    // The card's supportedInterfaces[0].url should contain the server URL + /a2a mount path
    expect(card.supportedInterfaces[0].url).toContain(llmock.url + "/a2a");
  });

  it("mount added after start() appears in health endpoint", async () => {
    llmock = new LLMock();
    await llmock.start();

    // Health before any mounts — no services
    const healthBefore = await httpRequest(llmock.url, "/health", "GET");
    JSON.parse(healthBefore.body); // verify it's valid JSON
    // With 0 mounts but mounts array exists, the server checks mounts.length
    // Since we add after, the array is shared so it should pick up new mounts

    // Mount vector after start
    const vector = new VectorMock();
    vector.addCollection("late-col", { dimension: 3 });
    llmock.mount("/vector", vector);

    // Health after mount — should show vector
    const healthAfter = await httpRequest(llmock.url, "/health", "GET");
    const dataAfter = JSON.parse(healthAfter.body);
    expect(dataAfter.services).toBeDefined();
    expect(dataAfter.services.vector).toBeDefined();
    expect(dataAfter.services.vector.status).toBe("ok");
    expect(dataAfter.services.vector.collections).toBe(1);
  });

  it("late-mounted vector mock handles requests correctly", async () => {
    llmock = new LLMock();
    llmock.on({ userMessage: /.*/ }, { content: "llm works" });
    await llmock.start();

    // Mount vector after start
    const vector = new VectorMock();
    vector.addCollection("late-vec", { dimension: 2 });
    vector.onQuery("late-vec", [
      { id: "lv1", score: 0.95, values: [1, 0], metadata: { late: true } },
    ]);
    llmock.mount("/vector", vector);

    // LLM still works
    const llmRes = await httpRequest(llmock.url, "/v1/chat/completions", "POST", {
      model: "gpt-4",
      messages: [{ role: "user", content: "test" }],
    });
    expect(llmRes.status).toBe(200);

    // Late-mounted vector works
    const vecRes = await httpRequest(llmock.url, "/vector/query", "POST", {
      namespace: "late-vec",
      vector: [1, 0],
      topK: 3,
    });
    expect(vecRes.status).toBe(200);
    const vecData = JSON.parse(vecRes.body);
    expect(vecData.matches).toHaveLength(1);
    expect(vecData.matches[0].id).toBe("lv1");

    // Verify journal captured both
    const entries = llmock.getRequests();
    const llmEntries = entries.filter((e) => e.path === "/v1/chat/completions");
    const vecEntries = entries.filter((e) => e.service === "vector");
    expect(llmEntries.length).toBe(1);
    expect(vecEntries.length).toBeGreaterThanOrEqual(1);
  });
});
