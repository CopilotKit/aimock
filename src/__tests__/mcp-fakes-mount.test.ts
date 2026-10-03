/**
 * MCP fakes on the MCP mount: the request path (spec sections 6.4, 8, 9, 10
 * and the H, I, B rules), over the wire.
 *
 * Real surface only: a real `MCPMock` listening on a real TCP port, either
 * standalone (W5) or mounted on an `LLMock` started with `metrics: true`, and
 * the real MCP client SDKs (`@modelcontextprotocol/sdk` v1 and
 * `@modelcontextprotocol/client` v2) talking Streamable HTTP to it. Raw
 * `fetch` is used where a test needs the HTTP status or a request shape the
 * SDK clients do not send (a test id on `initialize` only).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Client as ClientV2 } from "@modelcontextprotocol/client";
import { MCPMock } from "../mcp-mock.js";
import { McpFakeStore } from "../mcp-fakes.js";
import { LLMock } from "../llmock.js";
import { Logger } from "../logger.js";
import { connectV1, connectV2, enc, expectMcpError } from "./mcp-fakes-harness.js";

// ---------------------------------------------------------------------------
// Fixtures (spec 6.4)

const RETRY_ID = "tickets › retry on timeout";
const RETRY = {
  scope: { testId: RETRY_ID },
  tools: [
    {
      name: "create_ticket",
      calls: [
        { id: "first-try", args: { title: "Refund" }, error: "upstream timeout" },
        { id: "retry", args: { title: "Refund" }, result: "TICKET-42" },
      ],
    },
  ],
};

const WEATHER_ID = "weather › seattle";
const WEATHER = {
  scope: { testId: WEATHER_ID },
  tools: [
    {
      name: "get_weather",
      calls: [{ args: { city: "Seattle" }, result: { tempF: 60, conditions: "rain" } }],
    },
  ],
};

const DOCS = {
  scope: { context: "docs-search" },
  tools: [
    {
      name: "search_docs",
      calls: [
        { anyArgs: true, result: [{ type: "text", text: "Doc A: refunds take 5 days" }] },
        { anyArgs: true, result: [{ type: "text", text: "Doc B: contact support" }] },
      ],
    },
  ],
};

const READ_ONLY_ID = "account › read only";
const READ_ONLY = {
  scope: { testId: READ_ONLY_ID },
  undeclaredTools: "deny",
  tools: [{ name: "get_account", calls: [{ args: { id: "u1" }, result: '{"plan":"pro"}' }] }],
};

const SHARED = {
  scope: "shared",
  tools: [{ name: "shared_tool", calls: [{ anyArgs: true, result: "shared answer" }] }],
};

// ---------------------------------------------------------------------------
// Helpers

/** A logger that keeps every line it is given, by level. */
class CaptureLogger extends Logger {
  lines: Array<{ level: "info" | "warn" | "error" | "debug"; text: string }> = [];
  constructor() {
    super("silent");
  }
  override info(...args: unknown[]): void {
    this.lines.push({ level: "info", text: args.map(String).join(" ") });
  }
  override debug(...args: unknown[]): void {
    this.lines.push({ level: "debug", text: args.map(String).join(" ") });
  }
  override warn(...args: unknown[]): void {
    this.lines.push({ level: "warn", text: args.map(String).join(" ") });
  }
  override error(...args: unknown[]): void {
    this.lines.push({ level: "error", text: args.map(String).join(" ") });
  }
  at(level: "info" | "warn" | "error"): string[] {
    return this.lines.filter((l) => l.level === level).map((l) => l.text);
  }
}

interface Rig {
  mcp: MCPMock;
  /** URL of the MCP endpoint (the mount root). */
  url: string;
  llm?: LLMock;
  stop(): Promise<void>;
}

const rigs: Rig[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const r of rigs.splice(0)) await r.stop().catch(() => undefined);
});

async function mounted(
  setup: (mcp: MCPMock) => void,
  opts: { maxTestIds?: number } = {},
): Promise<Rig & { llm: LLMock }> {
  const mcp = new MCPMock();
  setup(mcp);
  const llm = new LLMock({
    metrics: true,
    ...(opts.maxTestIds !== undefined ? { fixtureCountsMaxTestIds: opts.maxTestIds } : {}),
  });
  llm.mount("/mcp", mcp);
  await llm.start();
  const rig = { mcp, llm, url: `${llm.url}/mcp`, stop: () => llm.stop() };
  rigs.push(rig);
  return rig;
}

async function standalone(setup: (mcp: MCPMock) => void): Promise<Rig> {
  const mcp = new MCPMock();
  setup(mcp);
  const url = await mcp.start();
  const rig = { mcp, url, stop: () => mcp.stop() };
  rigs.push(rig);
  return rig;
}

async function v1(url: string, headers?: Record<string, string>): Promise<Client> {
  const c = await connectV1(url, headers ? { headers } : {});
  clients.push(c);
  return c;
}

async function v2(url: string, headers?: Record<string, string>): Promise<ClientV2> {
  const c = await connectV2(url, headers ? { headers } : {});
  clients.push(c);
  return c;
}

function withQuery(url: string, query: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

function firstText(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("content" in result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || !("text" in first)) return undefined;
  return typeof first.text === "string" ? first.text : undefined;
}

/** The thrown client error's `message` and `data.aimock`. */
async function caught(promise: Promise<unknown>): Promise<{ message: string; aimock: unknown }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { message?: unknown; data?: { aimock?: unknown } };
    return { message: String(e.message), aimock: e.data?.aimock };
  }
  throw new Error("expected the client call to throw");
}

interface RawResponse {
  status: number;
  sessionId: string | null;
  body: unknown;
  text: string;
}

let rpcId = 1;

/** One raw JSON-RPC POST with `fetch`. */
async function rawPost(
  url: string,
  message: Record<string, unknown>,
  opts: { sessionId?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(opts.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
      ...opts.headers,
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), body, text };
}

function initMessage(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: rpcId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "raw", version: "1" },
    },
  };
}

/** Initialize a raw session (initialize + notifications/initialized); returns its id. */
async function rawSession(url: string, headers?: Record<string, string>): Promise<string> {
  const init = await rawPost(url, initMessage(), { headers });
  expect(init.status).toBe(200);
  const sessionId = init.sessionId;
  if (!sessionId) throw new Error("no session id");
  const note = await rawPost(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { sessionId },
  );
  expect(note.status).toBe(202);
  return sessionId;
}

function rawCall(
  url: string,
  sessionId: string,
  name: string,
  args: unknown,
  headers?: Record<string, string>,
): Promise<RawResponse> {
  return rawPost(
    url,
    { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } },
    { sessionId, headers },
  );
}

function resultText(r: RawResponse): string | undefined {
  const body = r.body as { result?: unknown };
  return firstText(body.result);
}

async function metricsText(llm: LLMock): Promise<string> {
  const res = await fetch(`${llm.url}/metrics`);
  return res.text();
}

const EXHAUSTED_MESSAGE =
  'aimock MCP fake exhausted: tool "create_ticket" with {"title":"Refund"} was called again, but all 2 matching fakes are already used (testId "tickets › retry on timeout").';

const EVICTED_PREFIX = (id: string, cap: number) =>
  `aimock MCP fake evicted: consumption state for testId "${id}" was evicted by the per-mount test-id cap (${cap}); reset before reusing this test id`;

// ---------------------------------------------------------------------------
// Spec 6.4 examples, both modes, both clients

describe.each([
  ["standalone", (setup: (m: MCPMock) => void) => standalone(setup)],
  ["mounted on LLMock", (setup: (m: MCPMock) => void) => mounted(setup)],
] as const)("spec 6.4 retry scenario (%s)", (_mode, start) => {
  it("v1: error, then TICKET-42, then MCP_FAKE_EXHAUSTED (-31010)", async () => {
    const rig = await start((m) => void m.loadFakes(RETRY));
    const c = await v1(withQuery(rig.url, { testId: RETRY_ID }));
    const call = () => c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });

    const first = await call();
    expect(first.isError).toBe(true);
    expect(firstText(first)).toBe("upstream timeout");

    const second = await call();
    expect(second.isError).toBe(false);
    expect(firstText(second)).toBe("TICKET-42");

    const data = await expectMcpError(call(), { code: -31010, aimockCode: "MCP_FAKE_EXHAUSTED" });
    expect(data).toEqual({
      aimock: {
        code: "MCP_FAKE_EXHAUSTED",
        tool: "create_ticket",
        testId: RETRY_ID,
        context: null,
        mount: rig.llm ? "/mcp" : "/",
        received: { title: "Refund" },
        matchingDeclared: 2,
        matchingConsumed: 2,
        matchingIds: ["code#1:first-try", "code#1:retry"],
      },
    });
    const again = await caught(call());
    expect(again.message).toContain(EXHAUSTED_MESSAGE);
  });

  it("v2: the same three answers; exhaustion throws a ProtocolError", async () => {
    const rig = await start((m) => void m.loadFakes(RETRY));
    const c = await v2(withQuery(rig.url, { testId: RETRY_ID }));
    const call = () => c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    const first = await call();
    expect(first.isError).toBe(true);
    expect(firstText(first)).toBe("upstream timeout");
    expect(firstText(await call())).toBe("TICKET-42");
    await expectMcpError(call(), { code: -31010, aimockCode: "MCP_FAKE_EXHAUSTED" });
  });
});

describe("spec 6.4 other examples and 9.2 error bodies (mounted)", () => {
  it("success with an object result: text JSON plus structuredContent", async () => {
    const rig = await mounted((m) => void m.loadFakes(WEATHER));
    const c = await v1(rig.url, { "X-Test-Id": enc(WEATHER_ID) });
    const r = await c.callTool({ name: "get_weather", arguments: { city: "Seattle" } });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({ tempF: 60, conditions: "rain" });
    expect(firstText(r)).toBe(JSON.stringify({ tempF: 60, conditions: "rain" }));
  });

  it("MCP_FAKE_MISMATCH: -32602 with the 9.2 message and data, never a handler", async () => {
    let handlerCalls = 0;
    const rig = await mounted((m) => {
      m.onToolCall("get_weather", () => {
        handlerCalls++;
        return "from handler";
      });
      m.loadFakes(WEATHER);
    });
    const c = await v1(rig.url, { "X-Test-Id": enc(WEATHER_ID) });
    const call = () => c.callTool({ name: "get_weather", arguments: { city: "seattle" } });
    const data = await expectMcpError(call(), { code: -32602, aimockCode: "MCP_FAKE_MISMATCH" });
    expect(data).toEqual({
      aimock: {
        code: "MCP_FAKE_MISMATCH",
        tool: "get_weather",
        testId: WEATHER_ID,
        context: null,
        mount: "/mcp",
        received: { city: "seattle" },
        declared: [{ id: "code#1:get_weather#0", args: { city: "Seattle" }, consumed: false }],
        firstDifference: '$.city: expected "Seattle", received "seattle"',
      },
    });
    const { message } = await caught(call());
    expect(message).toContain(
      'aimock MCP fake mismatch: tool "get_weather" was called with arguments that match no declared fake (testId "weather › seattle"). Received {"city":"seattle"}. Declared: code#1:get_weather#0 {"city":"Seattle"}.',
    );
    expect(handlerCalls).toBe(0);
  });

  it("MCP_FAKE_NOT_DECLARED under deny: -32602, 9.2 message, blocks a handler (B8)", async () => {
    let handlerCalls = 0;
    const rig = await mounted((m) => {
      m.onToolCall("delete_account", () => {
        handlerCalls++;
        return "deleted";
      });
      m.loadFakes(READ_ONLY);
    });
    const c = await v1(rig.url, { "X-Test-Id": enc(READ_ONLY_ID) });
    expect(firstText(await c.callTool({ name: "get_account", arguments: { id: "u1" } }))).toBe(
      '{"plan":"pro"}',
    );
    const call = () => c.callTool({ name: "delete_account", arguments: { id: "u1" } });
    const data = await expectMcpError(call(), {
      code: -32602,
      aimockCode: "MCP_FAKE_NOT_DECLARED",
    });
    expect(data).toEqual({
      aimock: {
        code: "MCP_FAKE_NOT_DECLARED",
        tool: "delete_account",
        testId: READ_ONLY_ID,
        context: null,
        mount: "/mcp",
        declaredTools: ["get_account"],
      },
    });
    const { message } = await caught(call());
    expect(message).toContain(
      'Unknown tool: delete_account (aimock MCP fake not declared: this scenario denies undeclared tools; testId "account › read only").',
    );
    expect(handlerCalls).toBe(0);
  });

  it("anyArgs: each call takes the next entry whatever the arguments (context scope)", async () => {
    const rig = await mounted((m) => void m.loadFakes(DOCS));
    const c = await v1(withQuery(rig.url, { context: "docs-search" }));
    const a = await c.callTool({ name: "search_docs", arguments: { q: "refund policy" } });
    const b = await c.callTool({ name: "search_docs", arguments: { query: "how to contact" } });
    expect(firstText(a)).toBe("Doc A: refunds take 5 days");
    expect(firstText(b)).toBe("Doc B: contact support");
    await expectMcpError(c.callTool({ name: "search_docs", arguments: {} }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });
  });

  it("v2 client throws on mismatch and not-declared too", async () => {
    const rig = await mounted((m) => void m.loadFakes([WEATHER, READ_ONLY]));
    const w = await v2(rig.url, { "X-Test-Id": enc(WEATHER_ID) });
    await expectMcpError(w.callTool({ name: "get_weather", arguments: { city: "Paris" } }), {
      code: -32602,
      aimockCode: "MCP_FAKE_MISMATCH",
    });
    const r = await v2(rig.url, { "X-Test-Id": enc(READ_ONLY_ID) });
    await expectMcpError(r.callTool({ name: "drop_db", arguments: {} }), {
      code: -32602,
      aimockCode: "MCP_FAKE_NOT_DECLARED",
    });
  });
});

// ---------------------------------------------------------------------------
// Section 10: precedence and tools/list

describe("precedence (spec 10)", () => {
  it("a fake answers before a registered handler for the same tool", async () => {
    const rig = await mounted((m) => {
      m.onToolCall("create_ticket", () => "from handler");
      m.loadFakes(RETRY);
    });
    const c = await v1(rig.url, { "X-Test-Id": enc(RETRY_ID) });
    const r = await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    expect(firstText(r)).toBe("upstream timeout");
  });

  it("allow + no fake: today's behavior (handler, empty content, Unknown tool)", async () => {
    const rig = await mounted((m) => {
      m.onToolCall("echo", (args) => `echo ${JSON.stringify(args)}`);
      m.addTool({ name: "silent" });
      m.loadFakes(RETRY);
    });
    const c = await v1(rig.url, { "X-Test-Id": enc(RETRY_ID) });
    expect(firstText(await c.callTool({ name: "echo", arguments: { a: 1 } }))).toBe('echo {"a":1}');
    const silent = await c.callTool({ name: "silent", arguments: {} });
    expect(silent.content).toEqual([]);
    const unknown = await caught(c.callTool({ name: "nope", arguments: {} }));
    expect(unknown.message).toContain("Unknown tool: nope");
    expect(unknown.aimock).toBeUndefined();
  });

  it("a scoped deny wins over a shared fake for undeclared tools, shared fakes still answer", async () => {
    let handlerCalls = 0;
    const rig = await mounted((m) => {
      m.onToolCall("delete_account", () => {
        handlerCalls++;
        return "from handler";
      });
      m.loadFakes([SHARED, READ_ONLY]);
    });
    const c = await v1(rig.url, { "X-Test-Id": enc(READ_ONLY_ID) });
    expect(firstText(await c.callTool({ name: "shared_tool", arguments: {} }))).toBe(
      "shared answer",
    );
    // The shared block (undeclaredTools: allow by default) does not reopen
    // the scoped deny: an undeclared tool is NOT_DECLARED, its handler unrun.
    await expectMcpError(c.callTool({ name: "delete_account", arguments: {} }), {
      code: -32602,
      aimockCode: "MCP_FAKE_NOT_DECLARED",
    });
    expect(handlerCalls).toBe(0);
  });

  it("tools/list: union of registered and fake tools; registered metadata wins", async () => {
    const rig = await mounted((m) => {
      m.addTool({
        name: "get_weather",
        description: "registered",
        inputSchema: { type: "object" },
      });
      m.addTool({ name: "registered_only", inputSchema: { type: "object" } });
      m.loadFakes([
        WEATHER,
        {
          scope: { testId: WEATHER_ID },
          tools: [
            {
              name: "with_meta",
              description: "Fake with metadata",
              inputSchema: { type: "object", properties: { q: { type: "string" } } },
              calls: [{ anyArgs: true, result: "x" }],
            },
            { name: "bare", calls: [{ anyArgs: true, result: "x" }] },
          ],
        },
      ]);
    });
    const c = await v1(rig.url, { "X-Test-Id": enc(WEATHER_ID) });
    const { tools } = await c.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual(
      ["bare", "get_weather", "registered_only", "with_meta"].sort(),
    );
    expect(byName.get("get_weather")?.description).toBe("registered");
    expect(byName.get("with_meta")?.description).toBe("Fake with metadata");
    expect(byName.get("with_meta")?.inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
    expect(byName.get("bare")?.inputSchema).toEqual({ type: "object" });

    // An untagged client sees only registered tools (the blocks are scoped).
    const untagged = await v1(rig.url);
    const names = (await untagged.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_weather", "registered_only"]);
  });

  it("tools/list under deny still lists every registered tool", async () => {
    const rig = await mounted((m) => {
      m.addTool({ name: "delete_account", inputSchema: { type: "object" } });
      m.loadFakes(READ_ONLY);
    });
    const c = await v1(rig.url, { "X-Test-Id": enc(READ_ONLY_ID) });
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["delete_account", "get_account"]);
  });
});

// ---------------------------------------------------------------------------
// Section 8: parallel calls

describe("concurrency (spec 8)", () => {
  it("parallel calls with different arguments each find their own entry", async () => {
    const rig = await mounted(
      (m) =>
        void m.loadFakes({
          scope: { testId: "par" },
          tools: [
            {
              name: "lookup",
              calls: [
                { args: { k: "a" }, result: "A" },
                { args: { k: "b" }, result: "B" },
                { args: { k: "c" }, result: "C" },
                { args: { k: "a" }, result: "A2" },
              ],
            },
          ],
        }),
    );
    const c = await v1(rig.url, { "X-Test-Id": "par" });
    const results = await Promise.all(
      ["c", "a", "b", "a"].map((k) => c.callTool({ name: "lookup", arguments: { k } })),
    );
    const texts = results.map(firstText);
    expect(texts[0]).toBe("C");
    expect(texts[2]).toBe("B");
    expect([texts[1], texts[3]].sort()).toEqual(["A", "A2"]);
  });

  it("parallel calls with the same arguments never share an entry", async () => {
    const rig = await mounted((m) => void m.loadFakes(RETRY));
    const c = await v1(rig.url, { "X-Test-Id": enc(RETRY_ID) });
    const settled = await Promise.allSettled(
      [0, 1, 2].map(() => c.callTool({ name: "create_ticket", arguments: { title: "Refund" } })),
    );
    const ok = settled.filter((s) => s.status === "fulfilled").map((s) => firstText(s.value));
    expect(ok.sort()).toEqual(["TICKET-42", "upstream timeout"]);
    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// I1-I3 and H1-H4 over the wire

describe("identity over the wire (I1-I3, H1-H5)", () => {
  const ID_TOOL = (scope: Record<string, string>, answer: string) => ({
    scope,
    tools: [{ name: "who", calls: [{ anyArgs: true, result: answer }] }],
  });

  it("an encoded › test id matches in the header and in the query", async () => {
    const rig = await mounted((m) => void m.loadFakes(RETRY));
    const viaHeader = await v1(rig.url, { "X-Test-Id": enc(RETRY_ID) });
    expect(
      firstText(
        await viaHeader.callTool({ name: "create_ticket", arguments: { title: "Refund" } }),
      ),
    ).toBe("upstream timeout");
    const viaQuery = await v1(`${rig.url}?testId=${enc(RETRY_ID)}`);
    // Same test id: shares consumption state with the header client.
    expect(
      firstText(await viaQuery.callTool({ name: "create_ticket", arguments: { title: "Refund" } })),
    ).toBe("TICKET-42");
  });

  it("%25 decodes to a literal %: an id holding %41 is sent as %2541", async () => {
    const rig = await mounted((m) => void m.loadFakes(ID_TOOL({ testId: "x%41y" }, "pct")));
    const c = await v1(rig.url, { "X-Test-Id": "x%2541y" });
    expect(firstText(await c.callTool({ name: "who", arguments: {} }))).toBe("pct");
    const wrong = await v1(rig.url, { "X-Test-Id": "x%41y" }); // decodes to "xAy"
    await expect(wrong.callTool({ name: "who", arguments: {} })).rejects.toThrow(/Unknown tool/);
  });

  it("a raw 50% test id is never rejected and matches a raw scope", async () => {
    const id = "applies 50% discount";
    const rig = await mounted((m) => void m.loadFakes(ID_TOOL({ testId: id }, "raw ok")));
    const c = await v1(rig.url, { "X-Test-Id": id });
    expect(firstText(await c.callTool({ name: "who", arguments: {} }))).toBe("raw ok");
  });

  it("a test id on the initialize URL only binds the session for later calls (I3)", async () => {
    const rig = await mounted((m) => void m.loadFakes(ID_TOOL({ testId: "bound" }, "bound ok")));
    const sessionId = await rawSession(`${rig.url}?testId=bound`);
    const r = await rawCall(rig.url, sessionId, "who", {});
    expect(r.status).toBe(200);
    expect(resultText(r)).toBe("bound ok");
  });

  it("a per-request header wins over the session's test id", async () => {
    const rig = await mounted(
      (m) =>
        void m.loadFakes([
          ID_TOOL({ testId: "session-id" }, "from session"),
          ID_TOOL({ testId: "header-id" }, "from header"),
        ]),
    );
    const sessionId = await rawSession(`${rig.url}?testId=session-id`);
    const r = await rawCall(rig.url, sessionId, "who", {}, { "X-Test-Id": "header-id" });
    expect(resultText(r)).toBe("from header");
    const s = await rawCall(rig.url, sessionId, "who", {});
    expect(resultText(s)).toBe("from session");
  });

  it("session test id plus a context-only request resolves to both", async () => {
    const rig = await mounted(
      (m) =>
        void m.loadFakes([
          ID_TOOL({ testId: "T" }, "test id only"),
          ID_TOOL({ testId: "T", context: "C" }, "both"),
        ]),
    );
    const sessionId = await rawSession(`${rig.url}?testId=T`);
    const r = await rawCall(rig.url, sessionId, "who", {}, { "X-AIMock-Context": "C" });
    expect(resultText(r)).toBe("both");
  });

  it("I2: ?context= on the MCP URL selects a context-scoped block; LLM routes ignore it", async () => {
    const rig = await mounted((m) => void m.loadFakes(DOCS));
    rig.llm.addFixture({
      match: { userMessage: "ctx?", context: "docs-search" },
      response: { content: "context applied" },
    });
    rig.llm.addFixture({ match: { userMessage: "ctx?" }, response: { content: "no context" } });

    // MCP: a real v1 client whose only context source is the URL query.
    const c = await v1(withQuery(rig.url, { context: "docs-search" }));
    expect(firstText(await c.callTool({ name: "search_docs", arguments: { q: "x" } }))).toBe(
      "Doc A: refunds take 5 days",
    );
    // Without it the context-scoped block is not visible.
    const bare = await v1(rig.url);
    await expect(bare.callTool({ name: "search_docs", arguments: {} })).rejects.toThrow(
      /Unknown tool: search_docs/,
    );

    // LLM route: the same query is not a context source (header only).
    const res = await fetch(`${rig.llm.url}/v1/chat/completions?context=docs-search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "ctx?" }] }),
    });
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("no context");
  });

  it("untagged requests see only shared blocks", async () => {
    const rig = await mounted((m) => void m.loadFakes([SHARED, RETRY, DOCS]));
    const c = await v1(rig.url);
    expect(firstText(await c.callTool({ name: "shared_tool", arguments: {} }))).toBe(
      "shared answer",
    );
    await expect(
      c.callTool({ name: "create_ticket", arguments: { title: "Refund" } }),
    ).rejects.toThrow(/Unknown tool: create_ticket/);
    await expect(c.callTool({ name: "search_docs", arguments: {} })).rejects.toThrow(
      /Unknown tool: search_docs/,
    );
  });

  it("B4: a mount without fakes answers as today when the headers are sent", async () => {
    const rig = await mounted((m) => {
      m.addTool({ name: "t1", description: "one", inputSchema: { type: "object" } });
      m.onToolCall("t1", () => "handled");
    });
    const c = await v1(rig.url, {
      "X-Test-Id": enc("some › test"),
      "X-AIMock-Context": "ctx",
    });
    expect(firstText(await c.callTool({ name: "t1", arguments: {} }))).toBe("handled");
    expect((await c.listTools()).tools).toEqual([
      { name: "t1", description: "one", inputSchema: { type: "object" } },
    ]);
    await expect(c.callTool({ name: "t2", arguments: {} })).rejects.toThrow(/Unknown tool: t2/);
  });

  it("H4: ' DENY ' and 'Allow' are accepted; deny turns an undeclared tool into NOT_DECLARED", async () => {
    const rig = await mounted((m) => {
      m.onToolCall("handled", () => "by handler");
      m.loadFakes(RETRY);
    });
    const deny = await v1(rig.url, {
      "X-Test-Id": enc(RETRY_ID),
      "X-AIMock-MCP-Undeclared": " DENY ",
    });
    await expectMcpError(deny.callTool({ name: "handled", arguments: {} }), {
      code: -32602,
      aimockCode: "MCP_FAKE_NOT_DECLARED",
    });
    const allow = await v1(`${rig.url}?undeclared=Allow`, { "X-Test-Id": enc(RETRY_ID) });
    expect(firstText(await allow.callTool({ name: "handled", arguments: {} }))).toBe("by handler");
  });

  describe("MCP_INVALID_UNDECLARED (H4): HTTP 400, exact body", () => {
    const HEADER_BODY = {
      error: 'Invalid X-AIMock-MCP-Undeclared header value "denied": expected allow or deny',
      code: "MCP_INVALID_UNDECLARED",
    };
    const QUERY_BODY = {
      error: 'Invalid ?undeclared= query parameter value "denied": expected allow or deny',
      code: "MCP_INVALID_UNDECLARED",
    };

    it("header on initialize: 400, no session created", async () => {
      const rig = await mounted((m) => void m.loadFakes(RETRY));
      const r = await rawPost(rig.url, initMessage(), {
        headers: { "X-AIMock-MCP-Undeclared": "denied" },
      });
      expect(r.status).toBe(400);
      expect(r.body).toEqual(HEADER_BODY);
      expect(r.sessionId).toBeNull();
      expect(rig.mcp.getSessions().size).toBe(0);
    });

    it("query on initialize: 400", async () => {
      const rig = await mounted((m) => void m.loadFakes(RETRY));
      const r = await rawPost(`${rig.url}?undeclared=denied`, initMessage());
      expect(r.status).toBe(400);
      expect(r.body).toEqual(QUERY_BODY);
    });

    it("header and query on a later tools/call: 400", async () => {
      const rig = await mounted((m) => void m.loadFakes(RETRY));
      const sessionId = await rawSession(rig.url);
      const h = await rawCall(
        rig.url,
        sessionId,
        "create_ticket",
        {},
        {
          "X-AIMock-MCP-Undeclared": "denied",
        },
      );
      expect(h.status).toBe(400);
      expect(h.body).toEqual(HEADER_BODY);
      const q = await rawCall(`${rig.url}?undeclared=denied`, sessionId, "create_ticket", {});
      expect(q.status).toBe(400);
      expect(q.body).toEqual(QUERY_BODY);
    });

    it("the v1 client's connect() fails", async () => {
      const rig = await mounted((m) => void m.loadFakes(RETRY));
      await expect(
        connectV1(rig.url, { headers: { "X-AIMock-MCP-Undeclared": "denied" } }),
      ).rejects.toThrow();
      await expect(connectV1(`${rig.url}?undeclared=denied`)).rejects.toThrow();
    });

    it("applies on a mount without fakes too", async () => {
      const rig = await standalone(() => undefined);
      const r = await rawPost(rig.url, initMessage(), {
        headers: { "X-AIMock-MCP-Undeclared": "denied" },
      });
      expect(r.status).toBe(400);
      expect(r.body).toEqual(HEADER_BODY);
    });
  });

  it("MCP_DUPLICATE_IDENTITY (H5): a repeated query name is HTTP 400", async () => {
    const rig = await mounted((m) => void m.loadFakes(RETRY));
    const r = await rawPost(`${rig.url}?testId=a&testId=b`, initMessage());
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: "Duplicate ?testId= query parameter: 2 values sent, expected one",
      code: "MCP_DUPLICATE_IDENTITY",
    });
  });

  it("L2: a decode fallback warns once per session per header, only with fakes loaded", async () => {
    const logger = new CaptureLogger();
    const rig = await mounted((m) => {
      m.loadFakes(ID_TOOL({ testId: "50% off" }, "x"));
    });
    // After start: the server mount loop sets its own logger (W1).
    rig.mcp.setLogger(logger);
    const c = await v1(rig.url, { "X-Test-Id": "50% off", "X-AIMock-Context": "100% ctx" });
    await c.callTool({ name: "who", arguments: {} });
    await c.callTool({ name: "who", arguments: {} }).catch(() => undefined);
    const warns = logger.at("warn").filter((l) => l.startsWith("MCP-FAKE:"));
    expect(warns.filter((l) => l.includes("X-Test-Id"))).toHaveLength(1);
    expect(warns.filter((l) => l.includes("X-AIMock-Context"))).toHaveLength(1);
    expect(warns.find((l) => l.includes("X-Test-Id"))).toContain('"50% off"');

    // Positive control above; no fakes → no L2.
    const quiet = new CaptureLogger();
    const bare = await mounted((m) => {
      m.addTool({ name: "t" });
    });
    // After start: the server mount loop sets its own logger (W1).
    bare.mcp.setLogger(quiet);
    const q = await v1(bare.url, { "X-Test-Id": "50% off" });
    await q.callTool({ name: "t", arguments: {} });
    expect(quiet.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MCP_FAKE_EVICTED (9.2, I5, L10)

describe("MCP_FAKE_EVICTED (cap 2)", () => {
  const block = {
    scope: "shared",
    tools: [
      {
        name: "step",
        calls: [
          { anyArgs: true, result: "entry 0" },
          { anyArgs: true, result: "entry 1" },
        ],
      },
    ],
  };

  it("an evicted test id fails loud on every lookup, side channels included, until reset", async () => {
    const logger = new CaptureLogger();
    const rig = await mounted(
      (m) => {
        m.loadFakes(block);
      },
      { maxTestIds: 2 },
    );
    // After start: the server mount loop sets its own logger (W1).
    rig.mcp.setLogger(logger);
    for (const t of ["T1", "T2", "T3"]) {
      const c = await v1(rig.url, { "X-Test-Id": t });
      expect(firstText(await c.callTool({ name: "step", arguments: {} }))).toBe("entry 0");
    }
    const c1 = await v1(rig.url, { "X-Test-Id": "T1" });
    const c2 = await v2(rig.url, { "X-Test-Id": "T1" });
    for (const call of [
      () => c1.callTool({ name: "step", arguments: {} }),
      () => c2.callTool({ name: "step", arguments: {} }),
    ]) {
      const data = await expectMcpError(call(), { code: -31011, aimockCode: "MCP_FAKE_EVICTED" });
      expect(data).toEqual({
        aimock: {
          code: "MCP_FAKE_EVICTED",
          tool: "step",
          testId: "T1",
          context: null,
          mount: "/mcp",
          cap: 2,
        },
      });
      const { message } = await caught(call());
      // M8: the evicted message ends like the other three: identity, period.
      expect(message).toContain(`${EVICTED_PREFIX("T1", 2)} (testId "T1").`);
    }

    const evictedEntries = rig.llm
      .getRequests()
      .filter((e) => e.service === "mcp" && e.response.mcpFake?.outcome === "evicted");
    expect(evictedEntries.length).toBe(4);
    expect(evictedEntries[0].response.mcpFake).toEqual({ id: null, outcome: "evicted" });
    expect(evictedEntries[0].testId).toBe("T1");

    expect(await metricsText(rig.llm)).toMatch(
      /aimock_mcp_fake_failures_total\{code="MCP_FAKE_EVICTED"\} 4/,
    );
    const l10 = logger.at("error").filter((l) => l.startsWith('MCP-FAKE: evicted testId "T1"'));
    expect(l10).toHaveLength(4);
    expect(l10[0]).toContain("(cap 2) for tools/call step");

    rig.mcp.resetScenarioState("T1");
    expect(firstText(await c1.callTool({ name: "step", arguments: {} }))).toBe("entry 0");
  });
});

// ---------------------------------------------------------------------------
// Side channels: journal (B2, B3), metric, L1

describe("side channels when mounted (9.3, B2, B3, L1)", () => {
  it("journals body, testId, context and response.mcpFake; counts failures; logs L1", async () => {
    const logger = new CaptureLogger();
    const rig = await mounted((m) => {
      m.loadFakes([RETRY, WEATHER, READ_ONLY]);
    });
    // After start: the server mount loop sets its own logger (W1).
    rig.mcp.setLogger(logger);
    const c = await v1(rig.url, {
      "X-Test-Id": enc(RETRY_ID),
      "X-AIMock-Context": "ctx-1",
    });
    const call = () => c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    await call();
    await call();
    await call().catch(() => undefined);
    const w = await v1(rig.url, { "X-Test-Id": enc(WEATHER_ID) });
    await w.callTool({ name: "get_weather", arguments: { city: "x" } }).catch(() => undefined);
    const r = await v1(rig.url, { "X-Test-Id": enc(READ_ONLY_ID) });
    await r.callTool({ name: "nope", arguments: {} }).catch(() => undefined);

    const calls = rig.llm
      .getRequests()
      .filter(
        (e) =>
          e.service === "mcp" && (e.body as { method?: string } | null)?.method === "tools/call",
      );
    expect(calls.map((e) => e.response.mcpFake)).toEqual([
      { id: "code#1[0]:first-try", outcome: "answered" },
      { id: "code#1[0]:retry", outcome: "answered" },
      { id: null, outcome: "exhausted" },
      { id: null, outcome: "mismatch" },
      { id: null, outcome: "not_declared" },
    ]);
    expect(calls[0].testId).toBe(RETRY_ID);
    expect(calls[0].context).toBe("ctx-1");
    expect(calls[0].body).toMatchObject({
      method: "tools/call",
      params: { name: "create_ticket", arguments: { title: "Refund" } },
    });

    // Non-tools/call MCP entries also carry the resolved identity (B3).
    const init = rig.llm
      .getRequests()
      .find(
        (e) =>
          e.service === "mcp" && e.headers["x-test-id"] === enc(READ_ONLY_ID) && e.body === null,
      );
    expect(init?.testId).toBe(READ_ONLY_ID);
    expect(init?.context).toBeNull();

    const metrics = await metricsText(rig.llm);
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_EXHAUSTED"\} 1/);
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_MISMATCH"\} 1/);
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_NOT_DECLARED"\} 1/);
    expect(metrics).toMatch(/aimock_mcp_requests_total\{method="tools\/call"\} 5/);

    const l1 = logger.at("error").filter((l) => l.startsWith("MCP-FAKE:"));
    expect(l1).toHaveLength(3);
    expect(l1[0]).toMatch(
      /^MCP-FAKE: exhausted for tools\/call create_ticket \(testId "tickets › retry on timeout", context "ctx-1", mount \/mcp\)/,
    );
    expect(l1[1]).toMatch(
      /^MCP-FAKE: mismatch for tools\/call get_weather \(testId "weather › seattle", mount \/mcp\)/,
    );
    expect(l1[2]).toMatch(
      /^MCP-FAKE: not declared for tools\/call nope \(testId "account › read only", mount \/mcp\)/,
    );
  });

  it("untagged MCP journal entries carry testId __default__ and context null", async () => {
    const rig = await mounted((m) => void m.loadFakes(SHARED));
    const c = await v1(rig.url);
    await c.callTool({ name: "shared_tool", arguments: {} });
    const call = rig.llm
      .getRequests()
      .find((e) => (e.body as { method?: string } | null)?.method === "tools/call");
    expect(call?.testId).toBe("__default__");
    expect(call?.context).toBeNull();
    expect(call?.response.mcpFake).toEqual({ id: "code#1:shared_tool#0", outcome: "answered" });
  });
});

// ---------------------------------------------------------------------------
// G2 review round 1: request shapes the SDK clients never send, session
// teardown, and the failure paths of the mount itself.

/** One raw POST of `text` as the body, for batches and malformed JSON. */
async function rawText(
  url: string,
  text: string,
  opts: { sessionId?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(opts.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
      ...opts.headers,
    },
    body: text,
  });
  const body = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    body: parsed,
    text: body,
  };
}

function callMessage(name: string, args: unknown, id?: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    ...(id !== undefined ? { id } : {}),
    method: "tools/call",
    params: { name, arguments: args },
  };
}

const ARGS_TOOL = (testId: string) => ({
  scope: { testId },
  tools: [{ name: "f", calls: [{ args: { a: 1 }, result: "one" }] }],
});

describe("M1: a JSON-RPC batch journals every tools/call on its own", () => {
  it("[mismatch, answered, ping]: one entry per message, each with its body and outcome", async () => {
    const rig = await mounted((m) => void m.loadFakes(ARGS_TOOL("b")));
    const sessionId = await rawSession(rig.url, { "X-Test-Id": "b" });
    const before = rig.llm.getRequests().length;
    const batch = [
      callMessage("f", { a: 2 }, 501),
      callMessage("f", { a: 1 }, 502),
      { jsonrpc: "2.0", id: 503, method: "ping" },
    ];
    const r = await rawText(rig.url, JSON.stringify(batch), { sessionId });
    expect(r.status).toBe(200);
    const answers = r.body as Array<{
      id: number;
      error?: { data?: { aimock?: { code?: string } } };
    }>;
    expect(answers.map((a) => a.id)).toEqual([501, 502, 503]);
    expect(answers[0].error?.data?.aimock?.code).toBe("MCP_FAKE_MISMATCH");

    const entries = rig.llm.getRequests().slice(before);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.body)).toEqual([batch[0], batch[1], null]);
    expect(entries.map((e) => e.response.mcpFake ?? null)).toEqual([
      { id: null, outcome: "mismatch" },
      { id: "code#1:f#0", outcome: "answered" },
      null,
    ]);
    expect(entries.every((e) => e.testId === "b" && e.response.status === 200)).toBe(true);
  });
});

describe("M2/T: session DELETE", () => {
  it("drops the session's L2 dedupe state; journals the teardown identity; unknown session is 404", async () => {
    const logger = new CaptureLogger();
    const rig = await mounted((m) => {
      m.loadFakes(ARGS_TOOL("50% off"));
    });
    // After start: the server mount loop sets its own logger (W1).
    rig.mcp.setLogger(logger);
    const sessionId = await rawSession(rig.url, { "X-Test-Id": "50% off" });
    expect(logger.at("warn").filter((l) => l.startsWith("MCP-FAKE:"))).toHaveLength(1);
    const decodeWarned = Reflect.get(rig.mcp, "decodeWarned") as Map<string, unknown>;
    expect(decodeWarned.has(sessionId)).toBe(true);

    const del = await fetch(rig.url, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId, "X-Test-Id": "50% off" },
    });
    expect(del.status).toBe(200);
    await del.text();
    expect(decodeWarned.has(sessionId)).toBe(false);
    const teardown = rig.llm.getRequests().at(-1);
    expect(teardown?.method).toBe("DELETE");
    expect(teardown?.testId).toBe("50% off");

    const again = await fetch(rig.url, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    expect(again.status).toBe(404);
    await again.text();
  });
});

describe("M3: the L2 line names the source and the value that did not decode", () => {
  async function warnsOf(
    url: (base: string) => string,
    headers?: Record<string, string>,
  ): Promise<string[]> {
    const logger = new CaptureLogger();
    const rig = await mounted((m) => {
      m.loadFakes(ARGS_TOOL("t"));
    });
    // After start: the server mount loop sets its own logger (W1).
    rig.mcp.setLogger(logger);
    await rawSession(url(rig.url), headers);
    return logger.at("warn").filter((l) => l.startsWith("MCP-FAKE:"));
  }

  it("a query value: the ?testId= label and the value as used", async () => {
    const warns = await warnsOf((u) => `${u}?testId=50%25%`);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('?testId= query parameter value "50%25%"');
    expect(warns[0]).not.toContain("X-Test-Id");
  });

  it("header used, ignored query value bad: names the query value, not the good header", async () => {
    const warns = await warnsOf((u) => `${u}?context=9%`, { "X-AIMock-Context": "fine" });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('?context= query parameter value "9%"');
    expect(warns[0]).not.toContain('"fine"');
  });

  it("a query name that does not decode is logged once per session", async () => {
    const warns = await warnsOf((u) => `${u}?test%Id=t`);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("1 query parameter name");
    expect(warns[0]).toContain("not valid percent-encoding");
  });

  it("a body that does not parse still reports a decode fallback on a known session", async () => {
    const logger = new CaptureLogger();
    const rig = await mounted((m) => {
      m.loadFakes(ARGS_TOOL("t"));
    });
    // After start: the server mount loop sets its own logger (W1).
    rig.mcp.setLogger(logger);
    const sessionId = await rawSession(rig.url);
    const r = await rawText(rig.url, "{not json", {
      sessionId,
      headers: { "X-Test-Id": "75% raw" },
    });
    expect((r.body as { error?: { code?: number } }).error?.code).toBe(-32700);
    const warns = logger.at("warn").filter((l) => l.startsWith("MCP-FAKE:"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('X-Test-Id header value "75% raw"');
    // Malformed JSON keeps the resolved identity in the journal.
    expect(rig.llm.getRequests().at(-1)?.testId).toBe("75% raw");
  });

  it("T: once per session, so a second session with the same raw value warns again", async () => {
    const logger = new CaptureLogger();
    const rig = await mounted((m) => {
      m.loadFakes(ARGS_TOOL("50% off"));
    });
    // After start: the server mount loop sets its own logger (W1).
    rig.mcp.setLogger(logger);
    for (let i = 0; i < 2; i++) {
      const c = await v1(rig.url, { "X-Test-Id": "50% off" });
      await c.callTool({ name: "f", arguments: { a: 1 } }).catch(() => undefined);
      await c.callTool({ name: "f", arguments: { a: 1 } }).catch(() => undefined);
    }
    const warns = logger.at("warn").filter((l) => l.includes('X-Test-Id header value "50% off"'));
    expect(warns).toHaveLength(2);
  });

  it("T: malformed JSON with a bad undeclared override is still a 400 identity rejection", async () => {
    const rig = await mounted((m) => void m.loadFakes(ARGS_TOOL("t")));
    const r = await rawText(`${rig.url}?undeclared=bogus`, "{not json");
    expect(r.status).toBe(400);
    expect((r.body as { code?: string }).code).toBe("MCP_INVALID_UNDECLARED");
  });
});

describe("M4: a claim that throws fails loud", () => {
  it("logs, counts, journals, and answers -32603 with data.aimock", async () => {
    const logger = new CaptureLogger();
    const rig = await mounted((m) => {
      m.loadFakes(ARGS_TOOL("c"));
    });
    // After start: the server mount loop sets its own logger (W1).
    rig.mcp.setLogger(logger);
    vi.spyOn(McpFakeStore.prototype, "claim").mockImplementation(() => {
      throw new Error("result cannot be built");
    });
    const c = await v1(rig.url, { "X-Test-Id": "c" });
    const data = await expectMcpError(c.callTool({ name: "f", arguments: { a: 1 } }), {
      code: -32603,
      aimockCode: "MCP_FAKE_INTERNAL_ERROR",
    });
    expect(data).toEqual({
      aimock: {
        code: "MCP_FAKE_INTERNAL_ERROR",
        tool: "f",
        testId: "c",
        context: null,
        mount: "/mcp",
        error: "result cannot be built",
      },
    });
    const l1 = logger.at("error").filter((l) => l.startsWith("MCP-FAKE:"));
    expect(l1).toHaveLength(1);
    expect(l1[0]).toContain("MCP-FAKE: internal error for tools/call f");
    expect(l1[0]).toContain("result cannot be built");
    expect(await metricsText(rig.llm)).toMatch(
      /aimock_mcp_fake_failures_total\{code="MCP_FAKE_INTERNAL_ERROR"\} 1/,
    );
    const entry = rig.llm
      .getRequests()
      .find((e) => (e.body as { method?: string } | null)?.method === "tools/call");
    expect(entry?.response.error).toContain("result cannot be built");
  });
});

describe("M5: a tools/call notification (no id) consumes nothing", () => {
  it("202, no claim, no failure counted; the next real call gets the entry", async () => {
    const rig = await mounted((m) => void m.loadFakes(ARGS_TOOL("n")));
    const sessionId = await rawSession(rig.url, { "X-Test-Id": "n" });
    const note = await rawPost(rig.url, callMessage("f", { a: 1 }), { sessionId });
    expect(note.status).toBe(202);
    const r = await rawCall(rig.url, sessionId, "f", { a: 1 });
    expect(resultText(r)).toBe("one");
    expect(await metricsText(rig.llm)).not.toMatch(/aimock_mcp_fake_failures_total/);
  });
});

describe("M5b: a tools/call notification runs the registered handler (origin/main parity)", () => {
  const RIGS: Array<[string, (setup: (mcp: MCPMock) => void) => Promise<Rig>]> = [
    ["mounted", mounted],
    ["standalone", standalone],
  ];

  it.each(RIGS)("%s, no fakes: 202 and the handler runs once", async (_label, rigOf) => {
    let calls = 0;
    const rig = await rigOf((m) => {
      m.onToolCall("h", () => {
        calls++;
        return "handled";
      });
    });
    const sessionId = await rawSession(rig.url);
    const note = await rawPost(rig.url, callMessage("h", {}), { sessionId });
    expect(note.status).toBe(202);
    expect(calls).toBe(1);
  });

  it("with fakes: the handler runs and the fake entry is not consumed", async () => {
    let calls = 0;
    const rig = await mounted((m) => {
      m.loadFakes(ARGS_TOOL("n"));
      m.onToolCall("f", () => {
        calls++;
        return "handled";
      });
    });
    const sessionId = await rawSession(rig.url, { "X-Test-Id": "n" });
    const note = await rawPost(rig.url, callMessage("f", { a: 1 }), { sessionId });
    expect(note.status).toBe(202);
    expect(calls).toBe(1);
    const r = await rawCall(rig.url, sessionId, "f", { a: 1 });
    expect(resultText(r)).toBe("one");
    expect(calls).toBe(1);
  });
});

describe("N1:a tools/call with a null or wrongly typed id is served (origin/main parity)", () => {
  const BAD_IDS: Array<[string, unknown]> = [
    ["null", null],
    ["true", true],
    ["{}", {}],
  ];

  it.each(BAD_IDS)(
    "id %s: a registered handler answers with id null, as on origin/main",
    async (_label, id) => {
      const rig = await mounted((m) => {
        m.addTool({ name: "h" });
        m.onToolCall("h", () => "handled");
      });
      const sessionId = await rawSession(rig.url);
      const r = await rawPost(
        rig.url,
        { jsonrpc: "2.0", id, method: "tools/call", params: { name: "h", arguments: {} } },
        { sessionId },
      );
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        jsonrpc: "2.0",
        id: null,
        result: { content: [{ type: "text", text: "handled" }], isError: false },
      });
    },
  );

  it.each(BAD_IDS)(
    "id %s: claims the fake entry; the next call is exhausted",
    async (_label, id) => {
      const rig = await mounted((m) => void m.loadFakes(ARGS_TOOL("bad-id")));
      const sessionId = await rawSession(rig.url, { "X-Test-Id": "bad-id" });
      const r = await rawPost(
        rig.url,
        { jsonrpc: "2.0", id, method: "tools/call", params: { name: "f", arguments: { a: 1 } } },
        { sessionId },
      );
      expect((r.body as { id?: unknown }).id).toBeNull();
      expect(resultText(r)).toBe("one");
      const journaled = rig.llm
        .getRequests()
        .filter((e) => (e.body as { method?: string } | null)?.method === "tools/call");
      expect(journaled.at(-1)?.response.mcpFake).toMatchObject({ outcome: "answered" });
      const next = await rawCall(rig.url, sessionId, "f", { a: 1 });
      const err = (next.body as { error?: { data?: { aimock?: { code?: string } } } }).error;
      expect(err?.data?.aimock?.code).toBe("MCP_FAKE_EXHAUSTED");
    },
  );

  it.each(BAD_IDS)(
    "id %s: under deny an undeclared tool is MCP_FAKE_NOT_DECLARED",
    async (_label, id) => {
      const rig = await mounted((m) => {
        m.onToolCall("other", () => "from handler");
        m.loadFakes(READ_ONLY);
      });
      const sessionId = await rawSession(rig.url, { "X-Test-Id": enc(READ_ONLY_ID) });
      const r = await rawPost(
        rig.url,
        { jsonrpc: "2.0", id, method: "tools/call", params: { name: "other", arguments: {} } },
        { sessionId },
      );
      const body = r.body as {
        id?: unknown;
        error?: { code: number; data?: { aimock?: { code?: string } } };
      };
      expect(body.id).toBeNull();
      expect(body.error?.code).toBe(-32602);
      expect(body.error?.data?.aimock?.code).toBe("MCP_FAKE_NOT_DECLARED");
    },
  );

  it("a true notification (no id member) in a batch consumes nothing; an id null call beside it does", async () => {
    const rig = await mounted(
      (m) =>
        void m.loadFakes({
          scope: { testId: "mix" },
          tools: [
            {
              name: "f",
              calls: [
                { args: { a: 1 }, result: "one" },
                { args: { a: 1 }, result: "two" },
              ],
            },
          ],
        }),
    );
    const sessionId = await rawSession(rig.url, { "X-Test-Id": "mix" });
    const batch = await rawText(
      rig.url,
      JSON.stringify([callMessage("f", { a: 1 }), { ...callMessage("f", { a: 1 }), id: null }]),
      { sessionId },
    );
    expect(batch.status).toBe(200);
    expect(batch.body).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        result: expect.objectContaining({ content: [{ type: "text", text: "one" }] }),
      },
    ]);
    const r = await rawCall(rig.url, sessionId, "f", { a: 1 });
    expect(resultText(r)).toBe("two");
  });
});

describe("M7: a non-string tool name is invalid params, before fakes and deny", () => {
  it("-32602 naming the type", async () => {
    const rig = await mounted((m) => void m.loadFakes(READ_ONLY));
    const sessionId = await rawSession(rig.url, { "X-Test-Id": enc(READ_ONLY_ID) });
    for (const [name, type] of [
      [5, "number"],
      [{}, "object"],
    ] as const) {
      const r = await rawPost(
        rig.url,
        { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: {} } },
        { sessionId },
      );
      const err = (r.body as { error?: { code: number; message: string } }).error;
      expect(err?.code).toBe(-32602);
      expect(err?.message).toBe(`Invalid tool name: expected a string, got ${type}`);
    }
  });
});

describe("M11: a mismatch with no declared entry says so", () => {
  it('"Declared: none." instead of "Declared: ."', async () => {
    const rig = await mounted((m) => void m.loadFakes(ARGS_TOOL("m")));
    vi.spyOn(McpFakeStore.prototype, "claim").mockReturnValue({
      kind: "mismatch",
      tool: "f",
      received: { a: 2 },
      declared: [],
      firstDifference: "$",
    });
    const c = await v1(rig.url, { "X-Test-Id": "m" });
    const { message } = await caught(c.callTool({ name: "f", arguments: { a: 2 } }));
    expect(message).toContain('Received {"a":2}. Declared: none.');
  });
});

describe("T: a trailing-slash request on a mount", () => {
  it("/mcp/ reports mount /mcp", async () => {
    const rig = await mounted((m) => void m.loadFakes(ARGS_TOOL("s")));
    const c = await v1(`${rig.url}/`, { "X-Test-Id": "s" });
    const data = (await expectMcpError(c.callTool({ name: "f", arguments: { a: 9 } }), {
      code: -32602,
      aimockCode: "MCP_FAKE_MISMATCH",
    })) as { aimock: { mount: string } };
    expect(data.aimock.mount).toBe("/mcp");
  });
});
