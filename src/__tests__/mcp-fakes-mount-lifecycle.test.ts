/**
 * MCP fakes on the MCP mount: the mount lifecycle (spec 5.2 W5/W6, 5.3 R8,
 * 5.4 McpFakesAddError, I6-I8, B1, B2, 9.3, L1).
 *
 * Real surface only: a real `MCPMock` on a real TCP port (standalone, or
 * mounted on an `LLMock` with `metrics: true`) and the real
 * `@modelcontextprotocol/sdk` v1 client over Streamable HTTP. Raw `fetch` is
 * used for HTTP status codes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCPMock } from "../mcp-mock.js";
import { LLMock } from "../llmock.js";
import { Logger } from "../logger.js";
import { FixtureLoadError } from "../fixture-loader.js";
import { McpFakesAddError } from "../mcp-fakes.js";
import { connectV1, expectMcpError } from "./mcp-fakes-harness.js";

const ONE = (testId: string, answers: string[] = ["a0", "a1"]) => ({
  scope: { testId },
  tools: [
    {
      name: "step",
      calls: answers.map((result) => ({ anyArgs: true as const, result })),
    },
  ],
});

class CaptureLogger extends Logger {
  lines: Array<{ level: string; text: string }> = [];
  constructor() {
    super("silent");
  }
  override info(...args: unknown[]): void {
    this.lines.push({ level: "info", text: args.map(String).join(" ") });
  }
  override warn(...args: unknown[]): void {
    this.lines.push({ level: "warn", text: args.map(String).join(" ") });
  }
  override error(...args: unknown[]): void {
    this.lines.push({ level: "error", text: args.map(String).join(" ") });
  }
}

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f().catch(() => undefined);
  vi.restoreAllMocks();
});

async function mountedLLM(
  mounts: Array<[string, MCPMock]>,
  opts: { maxTestIds?: number } = {},
): Promise<LLMock> {
  const llm = new LLMock({
    metrics: true,
    ...(opts.maxTestIds !== undefined ? { fixtureCountsMaxTestIds: opts.maxTestIds } : {}),
  });
  for (const [path, mcp] of mounts) llm.mount(path, mcp);
  await llm.start();
  cleanups.push(() => llm.stop());
  return llm;
}

async function client(url: string, headers?: Record<string, string>): Promise<Client> {
  const c = await connectV1(url, headers ? { headers } : {});
  cleanups.push(() => c.close());
  return c;
}

function firstText(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("content" in result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || !("text" in first)) return undefined;
  return typeof first.text === "string" ? first.text : undefined;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

/** Entry ids of a tool, as the exhausted error's `matchingIds` reports them. */
async function idsOf(c: Client, tool: string, calls: number): Promise<string[]> {
  for (let i = 0; i < calls; i++) await c.callTool({ name: tool, arguments: {} });
  const data = (await expectMcpError(c.callTool({ name: tool, arguments: {} }), {
    code: -31010,
    aimockCode: "MCP_FAKE_EXHAUSTED",
  })) as { aimock: { matchingIds: string[] } };
  return data.aimock.matchingIds;
}

describe("addMcpFakes / loadFakes contract", () => {
  it("returns { warnings }: the L8 warning for args after anyArgs, empty otherwise", () => {
    const mcp = new MCPMock();
    const shadowed = mcp.addMcpFakes(
      [
        {
          source: "f.json",
          blockIndex: null,
          raw: {
            scope: { testId: "t" },
            tools: [
              {
                name: "x",
                calls: [
                  { anyArgs: true, result: "any" },
                  { args: { a: 1 }, result: "specific" },
                ],
              },
            ],
          },
        },
      ],
      { kind: "file" },
    );
    expect(shadowed.warnings).toHaveLength(1);
    expect(shadowed.warnings[0].message).toContain(
      'entry "f.json:x#1" is shadowed until the preceding anyArgs entry "f.json:x#0" is consumed',
    );
    expect(mcp.loadFakes(ONE("t2"))).toEqual({ warnings: [] });
  });

  it("two bad blocks: one McpFakesAddError, nothing added, the code#<n> counter not advanced", async () => {
    const mcp = new MCPMock();
    mcp.loadFakes(ONE("first")); // code#1
    const err = thrown(() =>
      mcp.loadFakes([
        { tools: [{ name: "bad", calls: [{ anyArgs: true, result: "x" }] }] }, // (a) no scope
        {
          scope: { testId: "t" },
          tools: [{ name: "bad", calls: [{ anyArgs: "yes", result: "x" }] }],
        }, // (j)
      ]),
    );
    expect(err).toBeInstanceOf(McpFakesAddError);
    expect(err).toBeInstanceOf(FixtureLoadError);
    const e = err as McpFakesAddError;
    expect(e.name).toBe("McpFakesAddError");
    expect(e.errors).toHaveLength(2);
    expect(e.errors.map((x) => x.rule)).toEqual(["mcp-fakes/bad-block:a", "mcp-fakes/bad-block:j"]);
    expect(e.rule).toBe("mcp-fakes/bad-block:a");
    expect(e.file).toBe("code#2");
    expect(e.blockId).toBe("code#2[0]");
    expect(e.entryId ?? null).toBeNull();
    expect(e.errors[1].entryId).toBe("code#2[1]:bad#0");

    const llm = await mountedLLM([["/mcp", mcp]]);
    const c = await client(`${llm.url}/mcp`, { "X-Test-Id": "t" });
    // Nothing added: today's answer for the tool, and no fake tool listed.
    await expect(c.callTool({ name: "bad", arguments: {} })).rejects.toThrow(/Unknown tool: bad/);
    expect((await c.listTools()).tools).toEqual([]);

    // The failed add consumed no number: the next good add is code#2 too.
    mcp.loadFakes(ONE("next"));
    const next = await client(`${llm.url}/mcp`, { "X-Test-Id": "next" });
    expect(await idsOf(next, "step", 2)).toEqual(["code#2:step#0", "code#2:step#1"]);
  });

  it("I8: an entry-id collision on the mount is bad block (f); two mounts may hold equal ids", async () => {
    const a = new MCPMock();
    const b = new MCPMock();
    a.addMcpFakes([{ source: "x.json", blockIndex: null, raw: ONE("t") }], { kind: "file" });
    b.addMcpFakes([{ source: "x.json", blockIndex: null, raw: ONE("t") }], { kind: "file" });
    // Same source again on `a` is a second load (@2), not a collision.
    a.addMcpFakes([{ source: "x.json", blockIndex: null, raw: ONE("t2") }], { kind: "file" });
    const collision = thrown(() =>
      a.addMcpFakes(
        [
          {
            source: "y.json",
            blockIndex: null,
            raw: {
              scope: "shared",
              tools: [
                {
                  name: "dup",
                  calls: [
                    { anyArgs: true, result: "1" },
                    { id: "dup#0", anyArgs: true, result: "2" },
                  ],
                },
              ],
            },
          },
        ],
        { kind: "file" },
      ),
    ) as McpFakesAddError;
    expect(collision.rule).toBe("mcp-fakes/bad-block:f");

    const llm = await mountedLLM([
      ["/mcp", a],
      ["/mcp2", b],
    ]);
    const ca = await client(`${llm.url}/mcp`, { "X-Test-Id": "t" });
    const cb = await client(`${llm.url}/mcp2`, { "X-Test-Id": "t" });
    expect(await idsOf(ca, "step", 2)).toEqual(["x.json:step#0", "x.json:step#1"]);
    const dataB = (await (async () => {
      await cb.callTool({ name: "step", arguments: {} });
      await cb.callTool({ name: "step", arguments: {} });
      return expectMcpError(cb.callTool({ name: "step", arguments: {} }), {
        code: -31010,
        aimockCode: "MCP_FAKE_EXHAUSTED",
      });
    })()) as { aimock: { matchingIds: string[]; mount: string } };
    expect(dataB.aimock.matchingIds).toEqual(["x.json:step#0", "x.json:step#1"]);
    expect(dataB.aimock.mount).toBe("/mcp2");
    const c2 = await client(`${llm.url}/mcp`, { "X-Test-Id": "t2" });
    expect(await idsOf(c2, "step", 2)).toEqual(["x.json@2:step#0", "x.json@2:step#1"]);
  });
});

describe("R8: MCPMock.reset()", () => {
  it("clears fakes and keeps the counters: the next load is code#<n+1>", async () => {
    const mcp = new MCPMock();
    mcp.loadFakes(ONE("t")); // code#1
    mcp.reset();
    const llm = await mountedLLM([["/mcp", mcp]]);
    const c = await client(`${llm.url}/mcp`, { "X-Test-Id": "t" });
    await expect(c.callTool({ name: "step", arguments: {} })).rejects.toThrow(/Unknown tool: step/);
    mcp.loadFakes(ONE("t"));
    const c2 = await client(`${llm.url}/mcp`, { "X-Test-Id": "t" });
    expect(await idsOf(c2, "step", 2)).toEqual(["code#2:step#0", "code#2:step#1"]);
  });

  it("clears the evicted mark: T1 is answered from entry 0 after reset and reload", async () => {
    const mcp = new MCPMock();
    const block = {
      scope: "shared",
      tools: [{ name: "s", calls: [{ anyArgs: true, result: "e0" }] }],
    };
    mcp.loadFakes(block);
    const llm = await mountedLLM([["/mcp", mcp]], { maxTestIds: 2 });
    for (const t of ["T1", "T2", "T3"]) {
      const c = await client(`${llm.url}/mcp`, { "X-Test-Id": t });
      expect(firstText(await c.callTool({ name: "s", arguments: {} }))).toBe("e0");
    }
    const t1 = await client(`${llm.url}/mcp`, { "X-Test-Id": "T1" });
    await expectMcpError(t1.callTool({ name: "s", arguments: {} }), {
      code: -31011,
      aimockCode: "MCP_FAKE_EVICTED",
    });
    mcp.reset();
    mcp.loadFakes(block);
    const again = await client(`${llm.url}/mcp`, { "X-Test-Id": "T1" });
    expect(firstText(await again.callTool({ name: "s", arguments: {} }))).toBe("e0");
  });

  it("clearMcpFakes and resetScenarioState", async () => {
    const mcp = new MCPMock();
    mcp.loadFakes(ONE("t", ["only"]));
    const llm = await mountedLLM([["/mcp", mcp]]);
    const c = await client(`${llm.url}/mcp`, { "X-Test-Id": "t" });
    expect(firstText(await c.callTool({ name: "step", arguments: {} }))).toBe("only");
    await expectMcpError(c.callTool({ name: "step", arguments: {} }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });
    mcp.resetScenarioState("other");
    await expectMcpError(c.callTool({ name: "step", arguments: {} }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });
    mcp.resetScenarioState("t");
    expect(firstText(await c.callTool({ name: "step", arguments: {} }))).toBe("only");
    mcp.resetScenarioState();
    expect(firstText(await c.callTool({ name: "step", arguments: {} }))).toBe("only");
    mcp.clearMcpFakes();
    await expect(c.callTool({ name: "step", arguments: {} })).rejects.toThrow(/Unknown tool/);
  });
});

describe("W5: standalone MCPMock", () => {
  it("serves fakes with no journal, no metric and no log line", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const warnSpy = vi.spyOn(console, "warn");
    const logSpy = vi.spyOn(console, "log");
    const mcp = new MCPMock();
    mcp.loadFakes(ONE("t", ["only"]));
    const url = await mcp.start();
    cleanups.push(() => mcp.stop());
    const c = await client(url, { "X-Test-Id": "50% raw" });
    const t = await client(url, { "X-Test-Id": "t" });
    expect(firstText(await t.callTool({ name: "step", arguments: {} }))).toBe("only");
    await expectMcpError(t.callTool({ name: "step", arguments: {} }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });
    await c.callTool({ name: "nope", arguments: {} }).catch(() => undefined);
    expect(mcp.getRequests()).toEqual([]);
    // No metric: a standalone mount is never given a registry, and serves no
    // /metrics of its own.
    expect(Reflect.get(mcp, "registry")).toBeNull();
    const metrics = await fetch(`${url}/metrics`);
    expect(metrics.status).toBe(405);
    expect(await metrics.text()).not.toContain("aimock_mcp");
    const printed = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map(String);
    expect(printed.filter((s) => s.includes("MCP-FAKE"))).toEqual([]);
  });
});

describe("B1: GET on the mount root answers 405", () => {
  it("mounted and standalone; the v1 client connects with no transport error", async () => {
    const mounted = new MCPMock();
    const llm = await mountedLLM([["/mcp", mounted]]);
    const solo = new MCPMock();
    const soloUrl = await solo.start();
    cleanups.push(() => solo.stop());
    for (const url of [`${llm.url}/mcp`, soloUrl]) {
      const res = await fetch(url, { method: "GET", headers: { accept: "text/event-stream" } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST, DELETE");
      await res.text();

      // The listener is attached before connect(): the SDK starts its GET
      // SSE attempt from inside connect, without awaiting it.
      const transportErrors: unknown[] = [];
      const c = new Client({ name: "b1", version: "1.0.0" });
      c.onerror = (e) => transportErrors.push(e);
      await c.connect(new StreamableHTTPClientTransport(new URL(url)));
      cleanups.push(() => c.close());
      await c.listTools();
      await new Promise((r) => setTimeout(r, 50));
      expect(transportErrors).toEqual([]);
    }
  });
});

describe("B2 journal shape, L1 line per failure, metric by code", () => {
  it("one journal entry per request; failures counted and logged per code", async () => {
    const logger = new CaptureLogger();
    const mcp = new MCPMock();
    mcp.loadFakes({
      scope: { testId: "j" },
      undeclaredTools: "deny",
      tools: [{ name: "only", calls: [{ args: { a: 1 }, result: "ok" }] }],
    });
    const llm = await mountedLLM([["/mcp", mcp]]);
    // After start: the server mount loop sets its own logger (W1).
    mcp.setLogger(logger);
    const c = await client(`${llm.url}/mcp`, { "X-Test-Id": "j" });
    expect(firstText(await c.callTool({ name: "only", arguments: { a: 1 } }))).toBe("ok");
    await c.callTool({ name: "only", arguments: { a: 1 } }).catch(() => undefined); // exhausted
    await c.callTool({ name: "only", arguments: { a: 2 } }).catch(() => undefined); // mismatch
    await c.callTool({ name: "other", arguments: {} }).catch(() => undefined); // not declared
    await c.callTool({ name: "other", arguments: {} }).catch(() => undefined); // not declared

    const toolCalls = llm
      .getRequests()
      .filter((e) => (e.body as { method?: string } | null)?.method === "tools/call");
    expect(toolCalls).toHaveLength(5);
    const first = toolCalls[0];
    expect(first.service).toBe("mcp");
    expect(first.method).toBe("POST");
    expect(first.response.status).toBe(200);
    expect(first.response.fixture).toBeNull();
    expect(first.response.mcpFake).toEqual({ id: "code#1:only#0", outcome: "answered" });
    expect(first.testId).toBe("j");
    expect(first.context).toBeNull();
    expect(toolCalls.map((e) => e.response.mcpFake?.outcome)).toEqual([
      "answered",
      "exhausted",
      "mismatch",
      "not_declared",
      "not_declared",
    ]);
    // tools/list and other methods keep body null and carry no mcpFake.
    const others = llm.getRequests().filter((e) => e.service === "mcp" && e.body === null);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((e) => e.response.mcpFake === undefined)).toBe(true);

    const metrics = await (await fetch(`${llm.url}/metrics`)).text();
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_EXHAUSTED"\} 1/);
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_MISMATCH"\} 1/);
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_NOT_DECLARED"\} 2/);

    const l1 = logger.lines.filter((l) => l.level === "error" && l.text.startsWith("MCP-FAKE:"));
    expect(l1.map((l) => l.text.split(" for ")[0])).toEqual([
      "MCP-FAKE: exhausted",
      "MCP-FAKE: mismatch",
      "MCP-FAKE: not declared",
      "MCP-FAKE: not declared",
    ]);
  });
});

/** A logger that keeps error lines and throws from `warn` (a broken user logger). */
class ThrowingWarnLogger extends CaptureLogger {
  override warn(): void {
    throw new Error("logger warn exploded");
  }
}

/** Raw request status, `Allow` header and body text. */
async function raw(url: string, method: string): Promise<{ status: number; allow: string | null }> {
  const res = await fetch(url, { method });
  await res.text();
  return { status: res.status, allow: res.headers.get("allow") };
}

describe("M9: method routing, mounted and standalone (B1)", () => {
  it("mounted root: GET 405, off the root not the mount; standalone: GET 405 on every path", async () => {
    const mounted = new MCPMock();
    const llm = await mountedLLM([["/mcp", mounted]]);
    expect(await raw(`${llm.url}/mcp`, "GET")).toEqual({ status: 405, allow: "POST, DELETE" });
    for (const method of ["GET", "POST", "PUT"]) {
      expect((await raw(`${llm.url}/mcp/other`, method)).status, method).toBe(404);
    }
    // (Mounted OPTIONS: the server's CORS layer answers it before any mount sees it.)

    // Standalone serves every path (as on origin/main); GET is 405 on all of them.
    const solo = new MCPMock();
    const soloUrl = await solo.start();
    cleanups.push(() => solo.stop());
    for (const url of [soloUrl, `${soloUrl}/other`, `${soloUrl}/a/b?x=1`]) {
      expect(await raw(url, "GET"), url).toEqual({ status: 405, allow: "POST, DELETE" });
    }
  });

  it("mounted root keeps origin/main routing: PUT/PATCH/HEAD fall through to the next route, not 405", async () => {
    const mounted = new MCPMock();
    const llm = await mountedLLM([["/mcp", mounted]]);
    for (const method of ["PUT", "PATCH", "HEAD"]) {
      // Same answer as a path no mount claims: the server's own fall-through.
      const unclaimed = await raw(`${llm.url}/unclaimed`, method);
      expect(unclaimed.status, method).not.toBe(405);
      expect(await raw(`${llm.url}/mcp`, method), method).toEqual(unclaimed);
    }
    expect(mounted.getRequests()).toEqual([]);
  });

  it("standalone keeps origin/main routing: every non-GET method is served on every path", async () => {
    const solo = new MCPMock();
    solo.addTool({ name: "echo", description: "e" });
    const soloUrl = await solo.start();
    cleanups.push(() => solo.stop());
    const rpc = `${soloUrl}/rpc`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect((await init.json()).result.serverInfo).toBeDefined();
    const session = { "mcp-session-id": sessionId as string };
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session);
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
    const del = await fetch(rpc, { method: "DELETE", headers: session });
    expect(del.status).toBe(200);
    await del.text();

    // PUT, PATCH, HEAD and OPTIONS reach the handler on every path, as on
    // origin/main: an empty body answers exactly like an empty POST.
    for (const url of [soloUrl, rpc]) {
      const emptyPost = await raw(url, "POST");
      for (const method of ["PUT", "PATCH", "HEAD", "OPTIONS"]) {
        expect(await raw(url, method), `${method} ${url}`).toEqual(emptyPost);
      }
    }
  });

  it("M6: a 405 on the mounted root is journaled", async () => {
    const mcp = new MCPMock();
    const llm = await mountedLLM([["/mcp", mcp]]);
    await raw(`${llm.url}/mcp`, "GET");
    const entry = mcp.getRequests().at(-1) as
      | { method: string; response: { status: number } }
      | undefined;
    expect(entry?.method).toBe("GET");
    expect(entry?.response.status).toBe(405);
  });
});

describe("M6/M10: a request that throws inside the mount", () => {
  async function failingCall(url: string, logger: CaptureLogger): Promise<number> {
    // A raw test id that does not decode makes the mount warn (L2); the
    // logger's warn throws, after the identity resolved.
    const init = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "x", version: "1" },
        },
      }),
    });
    await init.text();
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    expect(logger.lines).toEqual([]);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "X-Test-Id": "90% broken",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    await res.text();
    return res.status;
  }

  it("mounted: 500, logged on the mount logger with the identity, journaled with it", async () => {
    const logger = new ThrowingWarnLogger();
    const mcp = new MCPMock();
    mcp.loadFakes(ONE("t"));
    const llm = await mountedLLM([["/mcp", mcp]]);
    // After start: the server mount loop sets its own logger (W1).
    mcp.setLogger(logger);
    expect(await failingCall(`${llm.url}/mcp`, logger)).toBe(500);
    const errors = logger.lines.filter((l) => l.level === "error").map((l) => l.text);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("MCPMock request error");
    expect(errors[0]).toContain('testId "90% broken"');
    expect(errors[0]).toContain("logger warn exploded");
    const entry = mcp.getRequests().at(-1) as
      | { testId?: string; response: { status: number; error?: string } }
      | undefined;
    expect(entry?.response.status).toBe(500);
    expect(entry?.testId).toBe("90% broken");
    expect(entry?.response.error).toContain("logger warn exploded");
  });

  it("standalone: 500, printed to stderr with the identity even with a mount logger (W5)", async () => {
    const stderr = captureStderr();
    const logger = new ThrowingWarnLogger();
    const mcp = new MCPMock();
    mcp.setLogger(logger);
    mcp.loadFakes(ONE("t"));
    const url = await mcp.start();
    cleanups.push(() => mcp.stop());
    expect(await failingCall(url, logger)).toBe(500);
    const printed = stderr.lines().filter((l) => l.includes("MCPMock request error"));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('testId "90% broken"');
    expect(printed[0]).toContain("logger warn exploded");
    expect(logger.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("standalone, also mounted on a silent-logger LLMock (W1): the error still reaches stderr", async () => {
    const mcp = new MCPMock();
    // The server mount loop hands the mount its silent default logger (W1).
    await mountedLLM([["/mcp", mcp]]);
    Reflect.set(mcp, "requestHandler", async () => {
      throw new Error("standalone handler exploded");
    });
    const url = await mcp.start();
    cleanups.push(() => mcp.stop());
    const stderr = captureStderr();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    await res.text();
    expect(res.status).toBe(500);
    const printed = stderr.lines().filter((l) => l.includes("standalone handler exploded"));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("MCPMock request error");
  });
});

/**
 * Every `console.error` line (the process stderr) until the test ends. The
 * suite runs with `silent: true`, which swallows console output before it
 * reaches `process.stderr`, so the console call itself is captured.
 */
function captureStderr(): { lines(): string[] } {
  const spy = vi.spyOn(console, "error");
  return { lines: () => spy.mock.calls.map((args) => args.map(String).join(" ")) };
}
