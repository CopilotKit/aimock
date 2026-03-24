import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { createMockSuite, type MockSuite } from "../suite.js";

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
  // Send initialized notification
  await httpRequest(
    url,
    path,
    "POST",
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-session-id": sessionId },
  );
  return sessionId;
}

// ---- Tests ----

describe("createMockSuite", () => {
  let suite: MockSuite | null = null;

  afterEach(async () => {
    if (suite) {
      await suite.stop();
      suite = null;
    }
  });

  it("with llm only — start/stop/reset work", async () => {
    suite = await createMockSuite({ llm: {} });
    await suite.start();

    expect(suite.llm.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(suite.mcp).toBeUndefined();
    expect(suite.a2a).toBeUndefined();
    expect(suite.vector).toBeUndefined();

    // Reset should not throw
    suite.reset();

    await suite.stop();
    suite = null;
  });

  it("with mcp — MCPMock mounted, tools/list works", async () => {
    suite = await createMockSuite({ llm: {}, mcp: {} });
    suite.mcp!.addTool({ name: "test-tool", description: "A test tool" });
    await suite.start();

    const sessionId = await initMcpSession(suite.llm.url, "/mcp");

    const res = await httpRequest(
      suite.llm.url,
      "/mcp",
      "POST",
      jsonRpc("tools/list", {}, 2) as object,
      { "mcp-session-id": sessionId },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result.tools).toHaveLength(1);
    expect(data.result.tools[0].name).toBe("test-tool");
  });

  it("with a2a — A2AMock mounted, agent card served", async () => {
    suite = await createMockSuite({ llm: {}, a2a: {} });
    suite.a2a!.registerAgent({
      name: "suite-agent",
      description: "Agent in suite",
    });
    await suite.start();

    const res = await httpRequest(suite.llm.url, "/a2a/.well-known/agent-card.json", "GET");
    expect(res.status).toBe(200);
    const card = JSON.parse(res.body);
    expect(card.name).toBe("suite-agent");
  });

  it("with vector — VectorMock mounted, query works", async () => {
    suite = await createMockSuite({ llm: {}, vector: {} });
    suite.vector!.addCollection("test-col", { dimension: 3 });
    suite.vector!.onQuery("test-col", [
      { id: "v1", score: 0.95, values: [1, 0, 0], metadata: { label: "first" } },
    ]);
    await suite.start();

    const res = await httpRequest(suite.llm.url, "/vector/query", "POST", {
      namespace: "test-col",
      vector: [1, 0, 0],
      topK: 5,
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].id).toBe("v1");
    expect(data.matches[0].score).toBe(0.95);
  });

  it("reset() delegates to all present mocks including a2a and vector", async () => {
    suite = await createMockSuite({ llm: {}, mcp: {}, a2a: {}, vector: {} });
    suite.mcp!.addTool({ name: "reset-tool", description: "will be cleared" });
    suite.a2a!.registerAgent({ name: "reset-agent", description: "will be cleared" });
    suite.vector!.addCollection("reset-col", { dimension: 2 });
    await suite.start();

    // reset() should not throw and should delegate to all mocks
    expect(() => suite!.reset()).not.toThrow();

    // After reset, mcp tools should be cleared — verify via tools/list returning empty
    const sessionId = await initMcpSession(suite.llm.url, "/mcp");
    const res = await httpRequest(
      suite.llm.url,
      "/mcp",
      "POST",
      jsonRpc("tools/list", {}, 2) as object,
      { "mcp-session-id": sessionId },
    );
    const data = JSON.parse(res.body);
    expect(data.result.tools).toHaveLength(0);
  });

  it("default options — creates suite with no explicit llm options", async () => {
    suite = await createMockSuite();
    await suite.start();
    expect(suite.llm.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(suite.mcp).toBeUndefined();
    expect(suite.a2a).toBeUndefined();
    expect(suite.vector).toBeUndefined();
    await suite.stop();
    suite = null;
  });

  it("all mocks — suite with all four mock types", async () => {
    suite = await createMockSuite({ llm: {}, mcp: {}, a2a: {}, vector: {} });
    expect(suite.llm).toBeDefined();
    expect(suite.mcp).toBeDefined();
    expect(suite.a2a).toBeDefined();
    expect(suite.vector).toBeDefined();
    await suite.start();
    expect(suite.llm.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
