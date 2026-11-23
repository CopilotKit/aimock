/**
 * C7 / FA3: recorded `notifications/message` lines replay only on a mount
 * that has at least one loaded call entry with one. That mount advertises
 * `capabilities.logging`, answers `logging/setLevel` and replays the lines at
 * or above the session's level, in syslog order. Every other mount is as on
 * main: no `logging` capability, and `logging/setLevel` is `-32601`.
 *
 * Real surface: an `LLMock` on a real TCP port loading the fixture
 * directories, a real v1 MCP SDK client over Streamable HTTP, and raw `fetch`
 * for the byte-level checks.
 */
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LoggingMessageNotificationSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { LLMock } from "../llmock.js";
import { connectV1, enc } from "./mcp-fakes-harness.js";

const LOGS_DIR = resolve(__dirname, "fixtures/mcp-record/contract-logs");
const TICKETS_DIR = resolve(__dirname, "fixtures/mcp-fakes/tickets");
const LOGS_ID = "mcp › contract logs";
const TICKETS_ID = "tickets › retry on timeout";

const mocks: LLMock[] = [];
const clients: Client[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const m of mocks.splice(0)) await m.stop().catch(() => {});
  vi.restoreAllMocks();
});

async function startWith(dir: string): Promise<string> {
  const llm = new LLMock({ port: 0, replaySpeed: 100 });
  mocks.push(llm);
  llm.loadFixtureDir(dir);
  return llm.start();
}

async function connect(url: string, testId: string): Promise<Client> {
  const client = await connectV1(url, { headers: { "X-Test-Id": enc(testId) } });
  clients.push(client);
  return client;
}

/** POST one raw JSON-RPC message; returns status and body text. */
async function rawPost(
  url: string,
  message: unknown,
  sessionId?: string,
): Promise<{ status: number; body: string; sessionId: string | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  return {
    status: res.status,
    body: await res.text(),
    sessionId: res.headers.get("mcp-session-id"),
  };
}

/** A raw session (initialize + notifications/initialized); returns the id and the initialize body. */
async function rawSession(url: string): Promise<{ sessionId: string; init: unknown }> {
  const init = await rawPost(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "raw", version: "1" },
    },
  });
  if (!init.sessionId) throw new Error("no session id");
  await rawPost(url, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  return { sessionId: init.sessionId, init: JSON.parse(init.body) };
}

describe("C7: recorded log notifications", () => {
  it("advertises logging only on the mount with recorded logs", async () => {
    const logsUrl = await startWith(LOGS_DIR);
    const ticketsUrl = await startWith(TICKETS_DIR);
    const logs = await rawSession(logsUrl + "/mcp");
    const tickets = await rawSession(ticketsUrl + "/mcp");
    expect(logs.init).toMatchObject({
      result: { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } },
    });
    expect(tickets.init).toMatchObject({
      result: { capabilities: { tools: {}, resources: {}, prompts: {} } },
    });
    expect(tickets.init).not.toHaveProperty("result.capabilities.logging");
  });

  it("after setLoggingLevel('warning'), warning and error arrive in order before the result; info does not", async () => {
    const url = await startWith(LOGS_DIR);
    const client = await connect(url + "/mcp", LOGS_ID);
    const events: string[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      events.push(`${n.params.level}:${String(n.params.data)}`);
    });
    await client.setLoggingLevel("warning");
    const result = await client.callTool({ name: "echo", arguments: { message: "log" } });
    events.push("result");
    expect(result).toEqual({ content: [{ type: "text", text: "Echo: log" }] });
    expect(events).toEqual(["warning:warning line", "error:error line", "result"]);
  });

  it("without setLoggingLevel, no message notification arrives", async () => {
    const url = await startWith(LOGS_DIR);
    const client = await connect(url + "/mcp", LOGS_ID);
    const events: string[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      events.push(String(n.params.level));
    });
    const result = await client.callTool({ name: "echo", arguments: { message: "log" } });
    expect(result).toEqual({ content: [{ type: "text", text: "Echo: log" }] });
    expect(events).toEqual([]);
  });

  it("on a mount with no recorded logs, logging/setLevel is -32601, byte-identical to an unknown method", async () => {
    const url = await startWith(TICKETS_DIR);
    const { sessionId } = await rawSession(url + "/mcp");
    const setLevel = await rawPost(
      url + "/mcp",
      { jsonrpc: "2.0", id: 5, method: "logging/setLevel", params: { level: "info" } },
      sessionId,
    );
    const unknown = await rawPost(
      url + "/mcp",
      { jsonrpc: "2.0", id: 5, method: "no/such/method", params: {} },
      sessionId,
    );
    expect(setLevel.status).toBe(200);
    expect(setLevel.body).toBe(
      '{"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"Method not found"}}',
    );
    expect(setLevel.body).toBe(unknown.body);

    const client = await connect(url + "/mcp", TICKETS_ID);
    await expect(client.setLoggingLevel("info")).rejects.toSatisfy(
      (e: unknown) => e instanceof McpError && e.code === -32601,
    );
  });

  it("an invalid level gets -32602", async () => {
    const url = await startWith(LOGS_DIR);
    const { sessionId } = await rawSession(url + "/mcp");
    const res = await rawPost(
      url + "/mcp",
      { jsonrpc: "2.0", id: 9, method: "logging/setLevel", params: { level: "loud" } },
      sessionId,
    );
    expect(JSON.parse(res.body)).toMatchObject({ id: 9, error: { code: -32602 } });
  });
});
