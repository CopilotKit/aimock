import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { MCPMock } from "../mcp-mock.js";
import { LLMock } from "../llmock.js";
import type { MCPContent } from "../mcp-types.js";

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
  if (id !== undefined) {
    body.id = id;
  } else {
    body.id = 1;
  }
  return request(url, path, "POST", body, extraHeaders);
}

function notification(
  url: string,
  path: string,
  method: string,
  params?: unknown,
  extraHeaders?: Record<string, string>,
) {
  // Notifications have no id field
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  return request(url, path, "POST", body, extraHeaders);
}

async function initSession(url: string, path = "/"): Promise<string> {
  const res = await jsonRpc(url, path, "initialize", {}, 1);
  const sessionId = res.headers["mcp-session-id"] as string;
  // Send initialized notification
  await notification(url, path, "notifications/initialized", {}, { "mcp-session-id": sessionId });
  return sessionId;
}

// ---- Tests ----

describe("MCPMock", () => {
  let mcp: MCPMock | null = null;
  let llm: LLMock | null = null;

  afterEach(async () => {
    if (mcp) {
      try {
        await mcp.stop();
      } catch {
        // not started
      }
      mcp = null;
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
      mcp = new MCPMock();
      const url = await mcp.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      await mcp.stop();
      mcp = null;
    });

    it("handles initialize handshake", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();

      const res = await jsonRpc(url, "/", "initialize", {}, 1);
      expect(res.status).toBe(200);

      const data = JSON.parse(res.body);
      expect(data.result.protocolVersion).toBe("2025-03-26");
      expect(data.result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
      expect(data.result.serverInfo).toEqual({ name: "mcp-mock", version: "1.0.0" });

      const sessionId = res.headers["mcp-session-id"];
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe("string");
    });

    it("custom serverInfo", async () => {
      mcp = new MCPMock({ serverInfo: { name: "test-server", version: "2.0.0" } });
      const url = await mcp.start();

      const res = await jsonRpc(url, "/", "initialize", {}, 1);
      const data = JSON.parse(res.body);
      expect(data.result.serverInfo).toEqual({ name: "test-server", version: "2.0.0" });
    });
  });

  // ---- Mounted mode ----

  describe("mounted mode", () => {
    it("routes via LLMock mount", async () => {
      mcp = new MCPMock();
      mcp.addTool({ name: "echo", description: "Echo tool" });

      llm = new LLMock();
      llm.mount("/mcp", mcp);
      await llm.start();

      const sessionId = await initSession(llm.url, "/mcp");

      const res = await jsonRpc(llm.url, "/mcp", "tools/list", {}, 2, {
        "mcp-session-id": sessionId,
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.result.tools).toHaveLength(1);
      expect(data.result.tools[0].name).toBe("echo");
    });

    it("does not intercept non-root paths", async () => {
      mcp = new MCPMock();
      llm = new LLMock();
      llm.mount("/mcp", mcp);
      llm.onMessage("hello", { content: "world" });
      await llm.start();

      // /mcp/something should fall through because MCPMock only handles /
      const res = await request(llm.url, "/v1/chat/completions", "POST", {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.choices[0].message.content).toBe("world");
    });
  });

  // ---- Session management ----

  describe("sessions", () => {
    it("initialize returns session ID in header", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();

      const res = await jsonRpc(url, "/", "initialize", {}, 1);
      expect(res.headers["mcp-session-id"]).toBeDefined();
    });

    it("notifications/initialized marks session as ready", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();

      const initRes = await jsonRpc(url, "/", "initialize", {}, 1);
      const sessionId = initRes.headers["mcp-session-id"] as string;

      // Send notification (no id field)
      const notifRes = await notification(
        url,
        "/",
        "notifications/initialized",
        {},
        {
          "mcp-session-id": sessionId,
        },
      );
      // Notifications return 202
      expect(notifRes.status).toBe(202);

      // Session should be initialized
      const sessions = mcp.getSessions();
      const session = sessions.get(sessionId);
      expect(session).toBeDefined();
      expect(session!.initialized).toBe(true);
    });

    it("missing session header returns 400", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();

      const res = await jsonRpc(url, "/", "tools/list", {}, 1);
      expect(res.status).toBe(400);
    });

    it("invalid session ID returns 404", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();

      const res = await jsonRpc(url, "/", "tools/list", {}, 1, {
        "mcp-session-id": "nonexistent-id",
      });
      expect(res.status).toBe(404);
    });

    it("uninitialized session rejects requests with -32002", async () => {
      mcp = new MCPMock();
      mcp.addTool({ name: "echo" });
      const url = await mcp.start();

      // Step 1: send initialize to get a session ID
      const initRes = await jsonRpc(url, "/", "initialize", {}, 1);
      const sessionId = initRes.headers["mcp-session-id"] as string;
      expect(sessionId).toBeDefined();

      // Step 2: WITHOUT sending notifications/initialized, try tools/list
      const res = await jsonRpc(url, "/", "tools/list", {}, 2, {
        "mcp-session-id": sessionId,
      });
      expect(res.status).toBe(400);

      const data = JSON.parse(res.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32002);
      expect(data.error.message).toBe("Session not initialized");
    });

    it("DELETE removes session", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();

      const sessionId = await initSession(url);

      // DELETE the session
      const delRes = await request(url, "/", "DELETE", undefined, {
        "mcp-session-id": sessionId,
      });
      expect(delRes.status).toBe(200);

      // Session should be gone
      const sessions = mcp.getSessions();
      expect(sessions.has(sessionId)).toBe(false);

      // Subsequent requests with that session ID should 404
      const res = await jsonRpc(url, "/", "tools/list", {}, 1, {
        "mcp-session-id": sessionId,
      });
      expect(res.status).toBe(404);
    });

    it("DELETE with missing header returns 400", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();

      const res = await request(url, "/", "DELETE");
      expect(res.status).toBe(400);
    });

    it("DELETE with unknown session returns 404", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();

      const res = await request(url, "/", "DELETE", undefined, {
        "mcp-session-id": "does-not-exist",
      });
      expect(res.status).toBe(404);
    });

    it("multiple concurrent sessions", async () => {
      mcp = new MCPMock();
      mcp.addTool({ name: "test-tool" });
      const url = await mcp.start();

      const session1 = await initSession(url);
      const session2 = await initSession(url);

      expect(session1).not.toBe(session2);

      // Both sessions can make requests
      const res1 = await jsonRpc(url, "/", "tools/list", {}, 1, { "mcp-session-id": session1 });
      const res2 = await jsonRpc(url, "/", "tools/list", {}, 1, { "mcp-session-id": session2 });

      expect(JSON.parse(res1.body).result.tools).toHaveLength(1);
      expect(JSON.parse(res2.body).result.tools).toHaveLength(1);

      // Delete one session, other still works
      await request(url, "/", "DELETE", undefined, { "mcp-session-id": session1 });

      const res3 = await jsonRpc(url, "/", "tools/list", {}, 1, { "mcp-session-id": session2 });
      expect(res3.status).toBe(200);

      const res4 = await jsonRpc(url, "/", "tools/list", {}, 1, { "mcp-session-id": session1 });
      expect(res4.status).toBe(404);
    });
  });

  // ---- Tools ----

  describe("tools", () => {
    it("tools/list returns registered tools", async () => {
      mcp = new MCPMock();
      mcp.addTool({
        name: "search",
        description: "Search the web",
        inputSchema: { type: "object" },
      });
      mcp.addTool({ name: "calc", description: "Calculator" });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "tools/list", {}, 1, { "mcp-session-id": sessionId });
      const data = JSON.parse(res.body);
      expect(data.result.tools).toHaveLength(2);
      expect(data.result.tools[0]).toEqual({
        name: "search",
        description: "Search the web",
        inputSchema: { type: "object" },
      });
      expect(data.result.tools[1]).toEqual({
        name: "calc",
        description: "Calculator",
      });
    });

    it("tools/call with function handler", async () => {
      mcp = new MCPMock();
      mcp.onToolCall("add", (args: unknown) => {
        const { a, b } = args as { a: number; b: number };
        return `${a + b}`;
      });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(
        url,
        "/",
        "tools/call",
        { name: "add", arguments: { a: 2, b: 3 } },
        1,
        {
          "mcp-session-id": sessionId,
        },
      );
      const data = JSON.parse(res.body);
      expect(data.result.isError).toBe(false);
      expect(data.result.content).toEqual([{ type: "text", text: "5" }]);
    });

    it("tools/call with MCPContent[] handler", async () => {
      mcp = new MCPMock();
      mcp.onToolCall("rich", (): MCPContent[] => {
        return [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ];
      });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "tools/call", { name: "rich" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.result.isError).toBe(false);
      expect(data.result.content).toHaveLength(2);
    });

    it("tools/call unknown tool returns -32602", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "tools/call", { name: "nonexistent" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
    });

    it("tools/call handler error returns isError: true", async () => {
      mcp = new MCPMock();
      mcp.onToolCall("fail", () => {
        throw new Error("Something went wrong");
      });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "tools/call", { name: "fail" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.result.isError).toBe(true);
      expect(data.result.content).toEqual([{ type: "text", text: "Something went wrong" }]);
    });

    it("tools/call with no handler returns empty content", async () => {
      mcp = new MCPMock();
      mcp.addTool({ name: "noop" });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "tools/call", { name: "noop" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.result.isError).toBe(false);
      expect(data.result.content).toEqual([]);
    });
  });

  // ---- Resources ----

  describe("resources", () => {
    it("resources/list returns registered resources", async () => {
      mcp = new MCPMock();
      mcp.addResource(
        { uri: "file:///readme.md", name: "README", mimeType: "text/markdown" },
        { text: "# Hello" },
      );
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "resources/list", {}, 1, { "mcp-session-id": sessionId });
      const data = JSON.parse(res.body);
      expect(data.result.resources).toHaveLength(1);
      expect(data.result.resources[0]).toEqual({
        uri: "file:///readme.md",
        name: "README",
        mimeType: "text/markdown",
      });
    });

    it("resources/read returns content", async () => {
      mcp = new MCPMock();
      mcp.addResource(
        { uri: "file:///data.json", name: "Data", mimeType: "application/json" },
        { text: '{"key":"value"}', mimeType: "application/json" },
      );
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "resources/read", { uri: "file:///data.json" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.result.contents).toHaveLength(1);
      expect(data.result.contents[0].uri).toBe("file:///data.json");
      expect(data.result.contents[0].text).toBe('{"key":"value"}');
      expect(data.result.contents[0].mimeType).toBe("application/json");
    });

    it("resources/read unknown URI returns -32602", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "resources/read", { uri: "file:///nope" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
    });
  });

  // ---- Prompts ----

  describe("prompts", () => {
    it("prompts/list returns registered prompts", async () => {
      mcp = new MCPMock();
      mcp.addPrompt({
        name: "summarize",
        description: "Summarize text",
        arguments: [{ name: "text", required: true }],
      });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "prompts/list", {}, 1, { "mcp-session-id": sessionId });
      const data = JSON.parse(res.body);
      expect(data.result.prompts).toHaveLength(1);
      expect(data.result.prompts[0].name).toBe("summarize");
    });

    it("prompts/get with handler returns result", async () => {
      mcp = new MCPMock();
      mcp.addPrompt(
        { name: "greet", arguments: [{ name: "name", required: true }] },
        (args: unknown) => {
          const { name } = args as { name: string };
          return {
            messages: [
              { role: "user", content: { type: "text" as const, text: `Hello, ${name}!` } },
            ],
          };
        },
      );
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(
        url,
        "/",
        "prompts/get",
        { name: "greet", arguments: { name: "World" } },
        1,
        {
          "mcp-session-id": sessionId,
        },
      );
      const data = JSON.parse(res.body);
      expect(data.result.messages).toHaveLength(1);
      expect(data.result.messages[0].content.text).toBe("Hello, World!");
    });

    it("prompts/get unknown prompt returns -32602", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "prompts/get", { name: "missing" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
    });
  });

  // ---- Ping ----

  describe("ping", () => {
    it("returns empty object", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "ping", {}, 1, { "mcp-session-id": sessionId });
      const data = JSON.parse(res.body);
      expect(data.result).toEqual({});
    });
  });

  // ---- Reset ----

  describe("reset", () => {
    it("clears tools, resources, prompts, and sessions", async () => {
      mcp = new MCPMock();
      mcp.addTool({ name: "t1" });
      mcp.addResource({ uri: "file:///r1", name: "R1" });
      mcp.addPrompt({ name: "p1" });
      const url = await mcp.start();

      await initSession(url);
      expect(mcp.getSessions().size).toBe(1);

      mcp.reset();

      const health = mcp.health();
      expect(health.tools).toBe(0);
      expect(health.resources).toBe(0);
      expect(health.prompts).toBe(0);
      expect(health.sessions).toBe(0);
    });
  });

  // ---- Health ----

  describe("health", () => {
    it("returns counts", async () => {
      mcp = new MCPMock();
      mcp.addTool({ name: "t1" });
      mcp.addTool({ name: "t2" });
      mcp.addResource({ uri: "file:///r1", name: "R1" });

      const health = mcp.health();
      expect(health).toEqual({
        status: "ok",
        tools: 2,
        resources: 1,
        prompts: 0,
        sessions: 0,
      });
    });
  });

  // ---- Tools edge cases ----

  describe("tools edge cases", () => {
    it("tools/call with missing name returns -32602", async () => {
      mcp = new MCPMock();
      mcp.addTool({ name: "t1" });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "tools/call", { arguments: {} }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
      expect(data.error.message).toBe("Missing tool name");
    });

    it("onToolCall on existing tool attaches handler", async () => {
      mcp = new MCPMock();
      mcp.addTool({ name: "echo", description: "Echo tool" });
      mcp.onToolCall("echo", (args: unknown) => {
        return `echoed: ${JSON.stringify(args)}`;
      });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(
        url,
        "/",
        "tools/call",
        { name: "echo", arguments: { msg: "hi" } },
        1,
        { "mcp-session-id": sessionId },
      );
      const data = JSON.parse(res.body);
      expect(data.result.isError).toBe(false);
      expect(data.result.content[0].text).toContain("hi");
    });

    it("tools/call handler throwing non-Error returns string coercion", async () => {
      mcp = new MCPMock();
      mcp.onToolCall("throws-string", () => {
        throw "raw string error";
      });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "tools/call", { name: "throws-string" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.result.isError).toBe(true);
      expect(data.result.content[0].text).toBe("raw string error");
    });
  });

  // ---- Resources edge cases ----

  describe("resources edge cases", () => {
    it("resources/read with missing URI returns -32602", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "resources/read", {}, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
      expect(data.error.message).toBe("Missing resource URI");
    });

    it("resources/read with blob content", async () => {
      mcp = new MCPMock();
      mcp.addResource(
        { uri: "file:///image.png", name: "Image" },
        { blob: "aGVsbG8=", mimeType: "image/png" },
      );
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "resources/read", { uri: "file:///image.png" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.result.contents[0].blob).toBe("aGVsbG8=");
      expect(data.result.contents[0].mimeType).toBe("image/png");
      expect(data.result.contents[0].text).toBeUndefined();
    });

    it("resources/read with no content fields", async () => {
      mcp = new MCPMock();
      mcp.addResource({ uri: "file:///empty", name: "Empty" });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "resources/read", { uri: "file:///empty" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.result.contents[0].uri).toBe("file:///empty");
      expect(data.result.contents[0].text).toBeUndefined();
      expect(data.result.contents[0].blob).toBeUndefined();
    });
  });

  // ---- Prompts edge cases ----

  describe("prompts edge cases", () => {
    it("prompts/get with missing name returns -32602", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "prompts/get", { arguments: {} }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
      expect(data.error.message).toBe("Missing prompt name");
    });

    it("prompts/get with no handler returns empty messages", async () => {
      mcp = new MCPMock();
      mcp.addPrompt({ name: "no-handler" });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "prompts/get", { name: "no-handler" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.result.messages).toEqual([]);
    });

    it("prompts/get handler error returns -32603", async () => {
      mcp = new MCPMock();
      mcp.addPrompt({ name: "fail" }, () => {
        throw new Error("prompt boom");
      });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "prompts/get", { name: "fail" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32603);
      expect(data.error.message).toContain("prompt boom");
    });

    it("prompts/get handler throwing non-Error returns string coercion", async () => {
      mcp = new MCPMock();
      mcp.addPrompt({ name: "fail-string" }, () => {
        throw "string error";
      });
      const url = await mcp.start();
      const sessionId = await initSession(url);

      const res = await jsonRpc(url, "/", "prompts/get", { name: "fail-string" }, 1, {
        "mcp-session-id": sessionId,
      });
      const data = JSON.parse(res.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32603);
      expect(data.error.message).toContain("string error");
    });
  });

  // ---- Protocol edge cases ----

  describe("protocol edge cases", () => {
    it("malformed JSON body returns parse error", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();
      const sessionId = await initSession(url);

      // Send invalid JSON to the server
      // The request helper sends no body when body is undefined,
      // so we need to send raw invalid JSON
      const parsed = new URL(url);
      const result = await new Promise<HttpResult>((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: "/",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "12",
              "mcp-session-id": sessionId,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (c: Buffer) => chunks.push(c));
            response.on("end", () => {
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString(),
              });
            });
          },
        );
        req.on("error", reject);
        req.write("{not valid}!");
        req.end();
      });

      expect(result.status).toBe(200);
      const data = JSON.parse(result.body);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32700);
    });

    it("non-POST/non-DELETE method is rejected in mounted mode", async () => {
      mcp = new MCPMock();
      llm = new LLMock();
      llm.mount("/mcp", mcp);
      await llm.start();

      const res = await request(llm.url, "/mcp", "GET");
      // MCPMock returns false for GET, so LLMock handles it (likely 404 or similar)
      expect(res.status).not.toBe(200);
    });
  });

  // ---- Lifecycle edge cases ----

  describe("lifecycle", () => {
    it("start() when already started throws", async () => {
      mcp = new MCPMock();
      await mcp.start();
      await expect(mcp.start()).rejects.toThrow("Server already started");
    });

    it("stop() when not started throws", async () => {
      mcp = new MCPMock();
      await expect(mcp.stop()).rejects.toThrow("Server not started");
      mcp = null; // prevent afterEach from trying to stop
    });

    it("start() with explicit host and port options", async () => {
      mcp = new MCPMock({ host: "127.0.0.1", port: 0 });
      const url = await mcp.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("standalone server catch block handles requestHandler rejection", async () => {
      mcp = new MCPMock();
      const url = await mcp.start();

      // Monkey-patch the private requestHandler to throw
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mcp as any).requestHandler = async () => {
        throw new Error("synthetic handler crash");
      };

      // Suppress console.error noise
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await request(url, "/", "POST", { jsonrpc: "2.0", method: "initialize", id: 1 });
      expect(res.status).toBe(500);
      expect(res.body).toBe("Internal server error");

      spy.mockRestore();
    });

    it("getRequests() with no journal returns empty array", () => {
      mcp = new MCPMock();
      expect(mcp.getRequests()).toEqual([]);
    });

    it("reset() returns this for chaining", () => {
      mcp = new MCPMock();
      mcp.addTool({ name: "t1" });
      const result = mcp.reset();
      expect(result).toBe(mcp);
    });
  });

  // ---- Journal ----

  describe("journal", () => {
    it("setJournal records entries with service: mcp", async () => {
      mcp = new MCPMock();
      llm = new LLMock();
      llm.mount("/mcp", mcp);
      await llm.start();

      const sessionId = await initSession(llm.url, "/mcp");

      await jsonRpc(llm.url, "/mcp", "tools/list", {}, 1, {
        "mcp-session-id": sessionId,
      });

      const entries = llm.getRequests();
      const mcpEntries = entries.filter((e) => e.service === "mcp");
      expect(mcpEntries.length).toBeGreaterThan(0);
    });

    it("getRequests() returns filtered journal entries when journal is set", async () => {
      mcp = new MCPMock();
      llm = new LLMock();
      llm.mount("/mcp", mcp);
      await llm.start();

      const sessionId = await initSession(llm.url, "/mcp");

      await jsonRpc(llm.url, "/mcp", "tools/list", {}, 1, {
        "mcp-session-id": sessionId,
      });

      // Use mcp.getRequests() directly (not llm.getRequests())
      const mcpEntries = mcp.getRequests();
      expect(mcpEntries.length).toBeGreaterThan(0);
      expect((mcpEntries[0] as { service: string }).service).toBe("mcp");
    });
  });
});
