/**
 * MCP record mode: the AM1 hook sites and the MR3-MR17 forwarding rules,
 * against a SYNTHETIC upstream (`http.createServer` speaking MCP JSON-RPC),
 * so every upstream answer (pagination, versions, errors, sizes) is chosen
 * by the test and every request the upstream receives is observed.
 *
 * aimock is a real `LLMock` (or a standalone `MCPMock`) on a real port,
 * driven by raw `fetch` so each wire byte is under test.
 */
import * as http from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
import type { McpRecorder } from "../mcp-recorder.js";
import { validateMcpFakes } from "../mcp-fakes.js";
import type { McpRecordConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Synthetic upstream

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

interface SyntheticOptions {
  /** `initialize` result protocolVersion. */
  version?: string;
  /** Answer JSON-RPC requests as SSE instead of JSON. */
  sse?: boolean;
  /** `tools/list` pages by cursor ("" = no cursor). */
  pages?: Record<string, { tools: unknown[]; nextCursor?: string }>;
  /** Sessions the upstream answers 404 for. */
  goneSessions?: string[];
}

interface Synthetic {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

const UPSTREAM_TOOLS = [
  { name: "echo", inputSchema: { type: "object" } },
  { name: "h", inputSchema: { type: "object" } },
];

function answer(message: Record<string, unknown>, opts: SyntheticOptions): unknown {
  const id = message.id;
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (message.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: opts.version ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic", version: "1.0.0" },
        },
      };
    case "tools/list": {
      const cursor = typeof params.cursor === "string" ? params.cursor : "";
      const page = opts.pages?.[cursor] ?? (cursor === "" ? { tools: UPSTREAM_TOOLS } : undefined);
      if (!page) return { jsonrpc: "2.0", id, error: { code: -32602, message: "bad cursor" } };
      return { jsonrpc: "2.0", id, result: page };
    }
    case "tools/call": {
      const name = params.name;
      if (name === "echo" || name === "h") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              { type: "text", text: `${String(name)} ${JSON.stringify(params.arguments ?? {})}` },
            ],
          },
        };
      }
      if (name === "big") {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "x".repeat(500) }] },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${String(name)}` },
      };
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    default:
      return { jsonrpc: "2.0", id, result: {} };
  }
}

async function startSynthetic(opts: SyntheticOptions = {}): Promise<Synthetic> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      const session = req.headers["mcp-session-id"];
      if (typeof session === "string" && opts.goneSessions?.includes(session)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("get-ok");
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deleted: true }));
        return;
      }
      const messages = Array.isArray(body) ? body : [body];
      const answers = messages
        .filter(
          (m): m is Record<string, unknown> => typeof m === "object" && m !== null && "id" in m,
        )
        .map((m) => answer(m, opts));
      if (answers.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }
      const isInit = !Array.isArray(body) && (body as { method?: unknown }).method === "initialize";
      const headers: Record<string, string> = isInit ? { "Mcp-Session-Id": "syn-session" } : {};
      const payload = Array.isArray(body) ? answers : answers[0];
      if (opts.sse) {
        res.writeHead(200, { ...headers, "Content-Type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      } else {
        res.writeHead(200, { ...headers, "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    seen,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// ---------------------------------------------------------------------------
// aimock side

const closers: (() => Promise<unknown>)[] = [];
const lines: string[] = [];
let tmp = "";

beforeEach(() => {
  lines.length = 0;
  tmp = mkdtempSync(join(tmpdir(), "aimock-mcp-hooks-"));
  for (const level of ["warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function synthetic(opts: SyntheticOptions = {}): Promise<Synthetic> {
  const up = await startSynthetic(opts);
  closers.push(() => up.close());
  return up;
}

/** An LLMock with an MCPMock at /mcp recording `upstream`. */
async function recording(
  upstream: string,
  extra: Partial<McpRecordConfig> = {},
  setup?: (mcp: MCPMock) => void,
): Promise<{ llm: LLMock; mcp: MCPMock; base: string }> {
  const llm = new LLMock({ port: 0, logLevel: "warn" });
  const mcp = new MCPMock();
  setup?.(mcp);
  mcp.enableRecording({ upstream, fixturePath: tmp, ...extra });
  llm.mount("/mcp", mcp);
  const base = await llm.start();
  closers.push(() => llm.stop());
  return { llm, mcp, base };
}

interface RawAnswer {
  status: number;
  headers: Headers;
  text: string;
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawAnswer> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function call(
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

const T = "hooks › case";
const TH = { "X-Test-Id": encodeURIComponent(T) };
const FILE = (): string => join(tmp, "hooks--case", "mcp.json");

function upstreamCalls(up: Synthetic): Seen[] {
  return up.seen.filter((s) => (s.body as { method?: unknown } | null)?.method === "tools/call");
}

function recordSkips(llm: LLMock): (string | undefined)[] {
  return llm
    .getRequests()
    .filter((e) => e.service === "mcp")
    .map((e) => e.response.recordSkipped);
}

function rl2(reason: string): string[] {
  return lines.filter((l) => l.includes(`MCP-RECORD: forwarded, not recorded (${reason})`));
}

function recorderOf(mcp: MCPMock): McpRecorder {
  const events = mcp.recorderEvents();
  if (!events) throw new Error("not recording");
  return events as McpRecorder;
}

// ---------------------------------------------------------------------------

describe("AM1: the record hook sites", () => {
  it("(a) mounted: a sub-path POST, a GET and a DELETE are all forwarded under the endpoint", async () => {
    const up = await synthetic();
    const { base } = await recording(up.url);
    const sub = await post(`${base}/mcp/sub/path?keep=1&testId=x`, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(sub.status).toBe(200);
    const get = await fetch(`${base}/mcp`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("get-ok");
    const del = await fetch(`${base}/mcp`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(up.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /mcp/sub/path?keep=1",
      "GET /mcp",
      "DELETE /mcp",
    ]);
  });

  it("(b) standalone: every path maps to the upstream endpoint itself, never /mcp/mcp (r2 N3)", async () => {
    const up = await synthetic();
    const mcp = new MCPMock();
    mcp.enableRecording({ upstream: up.url, fixturePath: tmp });
    const url = await mcp.start();
    closers.push(() => mcp.stop());
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(`${url}/mcp`, ping)).status).toBe(200);
    expect((await post(`${url}/`, ping)).status).toBe(200);
    expect((await fetch(`${url}/mcp`)).status).toBe(200);
    expect(up.seen.map((s) => s.path)).toEqual(["/mcp", "/mcp", "/mcp"]);
  });

  it("(b) standalone records a call to the scoped file", async () => {
    const up = await synthetic();
    const mcp = new MCPMock();
    mcp.enableRecording({ upstream: up.url, fixturePath: tmp });
    const url = await mcp.start();
    closers.push(() => mcp.stop());
    const res = await post(`${url}/mcp`, call(3, "echo", { m: 1 }), TH);
    expect(res.status).toBe(200);
    const doc = JSON.parse(readFileSync(FILE(), "utf8")) as { mcpFakes: { mount: string } };
    expect(doc.mcpFakes.mount).toBe("/");
    expect(validateMcpFakes(doc.mcpFakes, FILE()).errors).toEqual([]);
  });

  it("recording off: responses are byte-equal to a mount that never recorded", async () => {
    const up = await synthetic();
    const answers: string[][] = [];
    for (const enable of [true, false]) {
      const llm = new LLMock({ port: 0 });
      const mcp = new MCPMock();
      if (enable) mcp.enableRecording({ upstream: up.url, fixturePath: tmp }).disableRecording();
      llm.mount("/mcp", mcp);
      const base = await llm.start();
      closers.push(() => llm.stop());
      const get = await fetch(`${base}/mcp`);
      const sub = await post(`${base}/mcp/sub/path`, { jsonrpc: "2.0", id: 1, method: "ping" });
      answers.push([
        `${get.status} ${get.headers.get("allow")} ${await get.text()}`,
        `${sub.status} ${sub.text}`,
      ]);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0][0]).toMatch(/^405 POST, DELETE /);
    expect(up.seen).toEqual([]);
  });

  it("a standalone mount that stopped recording answers GET with 405 again", async () => {
    const up = await synthetic();
    const mcp = new MCPMock();
    mcp.enableRecording({ upstream: up.url, fixturePath: tmp }).disableRecording();
    const url = await mcp.start();
    closers.push(() => mcp.stop());
    expect((await fetch(`${url}/mcp`)).status).toBe(405);
    expect(up.seen).toEqual([]);
  });
});

describe("MR4 / MR5 / MR17: fakes and handlers in record mode", () => {
  it("MR5 deny: an undeclared tool gets MCP_FAKE_NOT_DECLARED and is never forwarded", async () => {
    const up = await synthetic();
    const { base } = await recording(up.url, {}, (mcp) =>
      mcp.loadFakes({
        scope: { testId: T },
        undeclaredTools: "deny",
        tools: [{ name: "known", calls: [{ args: {}, result: "k" }] }],
      }),
    );
    const res = await post(`${base}/mcp`, call(1, "other"), TH);
    const body = JSON.parse(res.text) as { error: { data: { aimock: { code: string } } } };
    expect(body.error.data.aimock.code).toBe("MCP_FAKE_NOT_DECLARED");
    expect(upstreamCalls(up)).toEqual([]);
    expect(existsSync(FILE())).toBe(false);
  });

  it("MR5 strict: a mismatch returns the replay error and nothing is forwarded; without strict it is forwarded and recorded", async () => {
    const up = await synthetic();
    const { base } = await recording(up.url, {}, (mcp) =>
      mcp.loadFakes({
        scope: { testId: T },
        tools: [{ name: "echo", calls: [{ args: { a: 1 }, result: "fake" }] }],
      }),
    );
    const strict = await post(`${base}/mcp`, call(1, "echo", { a: 2 }), {
      ...TH,
      "X-AIMock-Strict": "true",
    });
    const body = JSON.parse(strict.text) as {
      error: { code: number; data: { aimock: { code: string } } };
    };
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.aimock.code).toBe("MCP_FAKE_MISMATCH");
    expect(upstreamCalls(up)).toEqual([]);

    const loose = await post(`${base}/mcp`, call(2, "echo", { a: 2 }), TH);
    expect(JSON.parse(loose.text)).toMatchObject({
      result: { content: [{ text: 'echo {"a":2}' }] },
    });
    expect(upstreamCalls(up)).toHaveLength(1);
    expect(existsSync(FILE())).toBe(true);
  });

  it("MR4/AM2: a declared fake answers locally in record mode, with no upstream session", async () => {
    const up = await synthetic();
    const { base, llm } = await recording(up.url, {}, (mcp) =>
      mcp.loadFakes({
        scope: { testId: T },
        tools: [{ name: "echo", calls: [{ args: { a: 1 }, result: "from the fake" }] }],
      }),
    );
    const res = await post(`${base}/mcp`, call(9, "echo", { a: 1 }), TH);
    expect(JSON.parse(res.text)).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { content: [{ type: "text", text: "from the fake" }], isError: false },
    });
    expect(up.seen).toEqual([]);
    const entry = llm.getRequests().find((e) => e.service === "mcp");
    expect(entry?.response.mcpFake).toEqual({ id: expect.any(String), outcome: "answered" });
    expect(entry?.response.source).toBeUndefined();
  });

  it("MR17: a registered handler is bypassed, and the tools/list relay is unchanged", async () => {
    const up = await synthetic();
    const { base } = await recording(up.url, {}, (mcp) => {
      mcp.onToolCall("h", () => "local handler");
      mcp.loadFakes({
        scope: "shared",
        tools: [{ name: "fake-only", calls: [{ args: {}, result: "f" }] }],
      });
    });
    const res = await post(`${base}/mcp`, call(1, "h", { q: 1 }), TH);
    expect(JSON.parse(res.text)).toMatchObject({ result: { content: [{ text: 'h {"q":1}' }] } });
    expect(upstreamCalls(up)).toHaveLength(1);
    const list = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list" }, TH);
    expect(JSON.parse(list.text)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: UPSTREAM_TOOLS },
    });
  });
});

describe("MR8: forwarded, not recorded", () => {
  it("upstream-error: a JSON-RPC error answer", async () => {
    const up = await synthetic();
    const { base, llm } = await recording(up.url);
    const res = await post(`${base}/mcp`, call(1, "nonexistent"), TH);
    expect(JSON.parse(res.text)).toMatchObject({ error: { code: -32602 } });
    expect(upstreamCalls(up)).toHaveLength(1);
    expect(existsSync(FILE())).toBe(false);
    expect(recordSkips(llm)).toEqual(["upstream-error"]);
    expect(rl2("upstream-error")).toHaveLength(1);
    expect(rl2("upstream-error")[0]).toContain("tools/call on mount /mcp");
  });

  it("batch", async () => {
    const up = await synthetic();
    const { base, llm } = await recording(up.url);
    const res = await post(`${base}/mcp`, [call(1, "echo"), call(2, "echo")], TH);
    expect(JSON.parse(res.text)).toHaveLength(2);
    expect(up.seen).toHaveLength(1);
    expect(existsSync(FILE())).toBe(false);
    expect(recordSkips(llm)).toEqual(["batch"]);
    expect(rl2("batch")).toHaveLength(1);
  });

  it("not-tools: resources/list", async () => {
    const up = await synthetic();
    const { base, llm } = await recording(up.url);
    const res = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "resources/list" }, TH);
    expect(JSON.parse(res.text)).toMatchObject({ result: { resources: [] } });
    expect(up.seen).toHaveLength(1);
    expect(existsSync(FILE())).toBe(false);
    expect(recordSkips(llm)).toEqual(["not-tools"]);
    expect(rl2("not-tools")).toHaveLength(1);
  });

  for (const sse of [false, true]) {
    it(`buffer-cap: a ${sse ? "SSE" : "JSON"} response over maxRecordBufferBytes is relayed whole and not recorded`, async () => {
      const up = await synthetic({ sse });
      const { base, llm } = await recording(up.url, { maxRecordBufferBytes: 64 });
      const res = await post(`${base}/mcp`, call(1, "big"), TH);
      expect(res.text).toContain("x".repeat(500));
      expect(existsSync(FILE())).toBe(false);
      expect(recordSkips(llm)).toEqual(["buffer-cap"]);
      expect(rl2("buffer-cap")).toHaveLength(1);
    });
  }
});

describe("MR16: tools/list pagination", () => {
  const pages = {
    "": { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "c1" },
    c1: { tools: [{ name: "h", inputSchema: { type: "object" } }] },
  };

  it("a paginated list completes and is written as the block's list", async () => {
    const up = await synthetic({ pages });
    const { base } = await recording(up.url);
    await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, TH);
    await post(
      `${base}/mcp`,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "c1" } },
      TH,
    );
    await post(`${base}/mcp`, call(3, "echo", { a: 1 }), TH);
    const doc = JSON.parse(readFileSync(FILE(), "utf8")) as {
      mcpFakes: { list: { name: string }[] };
    };
    expect(doc.mcpFakes.list.map((t) => t.name)).toEqual(["echo", "h"]);
    expect(Object.keys(doc.mcpFakes)).toEqual(["scope", "mount", "list", "recorded", "tools"]);

    // A new complete list replaces the block's list (MR10 exception).
    await post(`${base}/mcp`, { jsonrpc: "2.0", id: 4, method: "tools/list" }, TH);
    await post(
      `${base}/mcp`,
      { jsonrpc: "2.0", id: 5, method: "tools/list", params: { cursor: "c1" } },
      TH,
    );
    const again = JSON.parse(readFileSync(FILE(), "utf8")) as {
      mcpFakes: { list: { name: string }[]; tools: unknown[] };
    };
    expect(again.mcpFakes.list.map((t) => t.name)).toEqual(["echo", "h"]);
    expect(again.mcpFakes.tools).toHaveLength(1);
  });

  it("an orphan cursor is forwarded and not recorded (list-orphan-page)", async () => {
    const up = await synthetic({ pages: { ...pages, zzz: { tools: [] } } });
    const { base, llm } = await recording(up.url);
    await post(
      `${base}/mcp`,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "zzz" } },
      TH,
    );
    expect(up.seen).toHaveLength(1);
    expect(recordSkips(llm)).toEqual(["list-orphan-page"]);
    expect(rl2("list-orphan-page")).toHaveLength(1);
  });

  it("an incomplete list is dropped at resetScenarioState() with list-incomplete", async () => {
    const up = await synthetic({ pages });
    const { base, mcp } = await recording(up.url);
    await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, TH);
    expect(rl2("list-incomplete")).toHaveLength(0);
    mcp.resetScenarioState();
    expect(rl2("list-incomplete")).toHaveLength(1);
    await post(`${base}/mcp`, call(2, "echo"), TH);
    const doc = JSON.parse(readFileSync(FILE(), "utf8")) as { mcpFakes: Record<string, unknown> };
    expect(doc.mcpFakes).not.toHaveProperty("list");
  });
});

describe("MR9, AM4, MR11: no write", () => {
  it("MR9: no test id and no context: forwarded, not written, RL3 logged once per mount", async () => {
    const up = await synthetic();
    const { base, llm } = await recording(up.url);
    await post(`${base}/mcp`, call(1, "echo"));
    await post(`${base}/mcp`, call(2, "echo"));
    expect(upstreamCalls(up)).toHaveLength(2);
    expect(existsSync(join(tmp))).toBe(true);
    expect(validateNoFiles(tmp)).toBe(true);
    expect(lines.filter((l) => l.includes("has no testId or context"))).toHaveLength(1);
    expect(recordSkips(llm)).toEqual(["no-scope", "no-scope"]);
  });

  it("AM4: an upstream that negotiates 2026-07-28: forwarded, not written, unsupported-version", async () => {
    const up = await synthetic({ version: "2026-07-28" });
    const { base } = await recording(up.url);
    const init = await post(
      `${base}/mcp`,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } },
      TH,
    );
    expect(init.headers.get("mcp-session-id")).toBe("syn-session");
    await post(`${base}/mcp`, call(2, "echo"), { ...TH, "Mcp-Session-Id": "syn-session" });
    expect(upstreamCalls(up)).toHaveLength(1);
    expect(existsSync(FILE())).toBe(false);
    expect(rl2("unsupported-version").length).toBeGreaterThanOrEqual(2);
  });

  it("AM4: a request header MCP-Protocol-Version: 2026-07-28: forwarded, not written", async () => {
    const up = await synthetic();
    const { base, llm } = await recording(up.url);
    await post(`${base}/mcp`, call(1, "echo"), { ...TH, "MCP-Protocol-Version": "2026-07-28" });
    expect(upstreamCalls(up)).toHaveLength(1);
    expect(existsSync(FILE())).toBe(false);
    expect(recordSkips(llm)).toEqual(["unsupported-version"]);
    expect(rl2("unsupported-version")).toHaveLength(1);
  });

  it("MR11: an invalid file at the target: nothing written, X-AIMock-Record-Error, RL1, invalid-merge", async () => {
    const up = await synthetic();
    const { base, llm } = await recording(up.url);
    mkdirSync(join(tmp, "hooks--case"), { recursive: true });
    const bad = JSON.stringify({
      mcpFakes: { scope: { testId: T }, mount: "/mcp", tools: [], bogus: 1 },
    });
    writeFileSync(FILE(), bad);
    const res = await post(`${base}/mcp`, call(1, "echo"), TH);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ result: { content: [{ text: "echo {}" }] } });
    expect(res.headers.get("x-aimock-record-error")).toMatch(/^invalid-merge: mcp-fakes\//);
    expect(readFileSync(FILE(), "utf8")).toBe(bad);
    expect(recordSkips(llm)).toEqual(["invalid-merge"]);
    expect(lines.some((l) => l.includes("MCP-RECORD: recording failed (invalid-merge)"))).toBe(
      true,
    );
  });

  it("MR11: a file that is not JSON is never overwritten", async () => {
    const up = await synthetic();
    const { base, llm } = await recording(up.url);
    mkdirSync(join(tmp, "hooks--case"), { recursive: true });
    writeFileSync(FILE(), "{ not json");
    const res = await post(`${base}/mcp`, call(1, "echo"), TH);
    expect(res.headers.get("x-aimock-record-error")).toMatch(/^invalid-merge: /);
    expect(readFileSync(FILE(), "utf8")).toBe("{ not json");
    expect(recordSkips(llm)).toEqual(["invalid-merge"]);
  });
});

describe("MR10-MR12: writes", () => {
  it("two concurrent calls to one target both land, and the file validates", async () => {
    const up = await synthetic();
    const { base } = await recording(up.url);
    await Promise.all([
      post(`${base}/mcp`, call(1, "echo", { n: 1 }), TH),
      post(`${base}/mcp`, call(2, "echo", { n: 2 }), TH),
    ]);
    const doc = JSON.parse(readFileSync(FILE(), "utf8")) as {
      mcpFakes: { tools: { calls: { args: unknown }[] }[] };
    };
    expect(validateMcpFakes(doc.mcpFakes, FILE()).errors).toEqual([]);
    expect(doc.mcpFakes.tools[0].calls.map((c) => c.args)).toEqual(
      expect.arrayContaining([{ n: 1 }, { n: 2 }]),
    );
  });

  it("MR13: each write's hash and listener are reported", async () => {
    const up = await synthetic();
    const { base, mcp } = await recording(up.url);
    const seen: string[] = [];
    mcp.recorderEvents()?.onWrite((file) => seen.push(file));
    await post(`${base}/mcp`, call(1, "echo"), TH);
    expect(seen).toEqual([FILE()]);
    const hash = mcp.recorderEvents()?.lastWrittenHash(FILE());
    expect(hash).toBe(createHash("sha256").update(readFileSync(FILE())).digest("hex"));
  });
});

describe("G2b advisories", () => {
  it("A1: a write listener that throws is logged (RL1), never crashes, and the call still answers", async () => {
    const up = await synthetic();
    const { base, mcp } = await recording(up.url);
    mcp.recorderEvents()?.onWrite(() => {
      throw new Error("listener boom");
    });
    const res = await post(`${base}/mcp`, call(1, "echo"), TH);
    expect(JSON.parse(res.text)).toMatchObject({ result: { content: [{ text: "echo {}" }] } });
    expect(existsSync(FILE())).toBe(true);
    expect(
      lines.some((l) => l.includes("a write listener failed") && l.includes("listener boom")),
    ).toBe(true);
  });

  it("A2: a completed list waiting for its block is written when the block appears meanwhile", async () => {
    const up = await synthetic();
    const { base } = await recording(up.url);
    await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, TH);
    // The block appears before this scope's first recorded call (another writer).
    mkdirSync(join(tmp, "hooks--case"), { recursive: true });
    writeFileSync(
      FILE(),
      JSON.stringify({
        mcpFakes: {
          scope: { testId: T },
          mount: "/mcp",
          tools: [{ name: "echo", calls: [{ args: { pre: 1 }, result: "pre" }] }],
        },
      }),
    );
    await post(`${base}/mcp`, call(2, "echo", { a: 1 }), TH);
    const doc = JSON.parse(readFileSync(FILE(), "utf8")) as {
      mcpFakes: { list?: { name: string }[]; tools: { calls: unknown[] }[] };
    };
    expect(doc.mcpFakes.list?.map((t) => t.name)).toEqual(UPSTREAM_TOOLS.map((t) => t.name));
    expect(doc.mcpFakes.tools[0].calls).toHaveLength(2);
    expect(validateMcpFakes(doc.mcpFakes, FILE()).errors).toEqual([]);
  });

  it("B1: a credential query parameter is forwarded upstream but never written", async () => {
    const up = await synthetic();
    const { base } = await recording(up.url);
    await post(
      `${base}/mcp?api_key=clientQuerySecret66`,
      call(1, "echo", { k: "clientQuerySecret66" }),
      TH,
    );
    expect(up.seen[0].path).toBe("/mcp?api_key=clientQuerySecret66");
    expect(readFileSync(FILE(), "utf8")).not.toContain("clientQuerySecret66");
  });
});

/**
 * An upstream that echoes, into its tools/call result and its tools/list
 * description, its raw request URL, every decoded query value, and every
 * string argument in each encoded form an upstream might use.
 */
async function echoingUpstream(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push(req.url ?? "");
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: number;
        method: string;
        params?: { arguments?: Record<string, unknown> };
      };
      const url = new URL(req.url ?? "/", "http://up.invalid");
      const forms: string[] = [req.url ?? "", `http://up.invalid${req.url ?? ""}`];
      for (const value of url.searchParams.values()) forms.push(value);
      for (const value of Object.values(msg.params?.arguments ?? {})) {
        if (typeof value !== "string") continue;
        forms.push(
          value,
          encodeURIComponent(value),
          encodeURI(value),
          new URLSearchParams([["v", value]]).toString().slice(2),
          `http://up.invalid/p?v=${encodeURIComponent(value)}`,
        );
      }
      const text = forms.join(" | ");
      const result =
        msg.method === "tools/list"
          ? { tools: [{ name: "echo", description: text, inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text }], _meta: { echoed: text } };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, seen };
}

/** Every form a value can take on the wire or in text. */
function formsOf(value: string): string[] {
  const enc = encodeURIComponent(value);
  const form = new URLSearchParams([["v", value]]).toString().slice(2);
  return [
    ...new Set([
      value,
      enc,
      enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
      form,
      form.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
      encodeURI(value),
      enc.replace(/%20/g, "+"),
    ]),
  ];
}

function hitsOf(text: string, values: string[]): Record<string, number> {
  const hits: Record<string, number> = {};
  for (const value of values) {
    const forms = formsOf(value);
    // The file is JSON: a form with `"` or `\` is stored escaped.
    for (const f of new Set([...forms, ...forms.map((v) => JSON.stringify(v).slice(1, -1))])) {
      const n = text.split(f).length - 1;
      if (n > 0) hits[f] = n;
    }
  }
  return hits;
}

const TRICKY = [
  "abc+def/ghi=jkl01",
  "has space secret9",
  "plus+form+secret8",
  "pct%41literal-99",
  "ünïcødé-sekret-1",
  "amp&ersand-secret2",
  "hash#fragment-sec3",
  'quote"back\\slash4',
  "mixed +/=&#% é-5",
];

describe("G2b B1-r2: a known secret is redacted in every encoded form", () => {
  it("the reviewer's repro: base64, %20-space and plus-form query values (0 hits)", async () => {
    const up = await echoingUpstream();
    const { base } = await recording(up.url);
    const query = "b64=abc%2Bdef%2Fghi%3Djkl01&space=has%20space%20secret9&plus=plus+form+secret8";
    await post(`${base}/mcp?${query}`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, TH);
    await post(`${base}/mcp?${query}`, call(2, "echo"), TH);
    const text = readFileSync(FILE(), "utf8");
    const hits = hitsOf(text, ["abc+def/ghi=jkl01", "has space secret9", "plus form secret8"]);
    expect(hits).toEqual({});
    expect(text).toContain("[REDACTED]");
    // MR2 (c): the client's query is forwarded byte for byte.
    expect(up.seen[0]).toBe(`/mcp?${query}`);
  });

  for (const value of TRICKY) {
    it(`query value ${JSON.stringify(value)}: 0 hits in every form`, async () => {
      const up = await echoingUpstream();
      const { base } = await recording(up.url);
      const url = `${base}/mcp?token=${encodeURIComponent(value)}`;
      await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, TH);
      await post(url, call(2, "echo", { v: value }), TH);
      expect(hitsOf(readFileSync(FILE(), "utf8"), [value])).toEqual({});
    });

    it(`secretValues ${JSON.stringify(value)}: 0 hits in every form`, async () => {
      const up = await echoingUpstream();
      const { base } = await recording(up.url, { secretValues: [value] });
      await post(`${base}/mcp`, call(1, "echo", { v: value }), TH);
      expect(hitsOf(readFileSync(FILE(), "utf8"), [value])).toEqual({});
    });

    it(`Authorization Bearer ${JSON.stringify(value)}: 0 hits in every form`, async () => {
      const up = await echoingUpstream();
      const { base } = await recording(up.url);
      const token = value.replace(/[^\x21-\x7e]/g, "x");
      await post(`${base}/mcp`, call(1, "echo", { v: token }), {
        ...TH,
        Authorization: `Bearer ${token}`,
      });
      expect(hitsOf(readFileSync(FILE(), "utf8"), [token])).toEqual({});
    });
  }
});

describe("MR3: the record-session map", () => {
  async function initialized(base: string): Promise<void> {
    const init = await post(
      `${base}/mcp`,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      TH,
    );
    expect(init.headers.get("mcp-session-id")).toBe("syn-session");
  }

  it("is removed after a forwarded DELETE answers 2xx", async () => {
    const up = await synthetic();
    const { base, mcp } = await recording(up.url);
    await initialized(base);
    expect(recorderOf(mcp).hasRecordSession("syn-session")).toBe(true);
    await fetch(`${base}/mcp`, { method: "DELETE", headers: { "Mcp-Session-Id": "syn-session" } });
    expect(recorderOf(mcp).hasRecordSession("syn-session")).toBe(false);
  });

  it("is removed after an upstream 404 for the session", async () => {
    const up = await synthetic({ goneSessions: ["syn-session"] });
    const { base, mcp } = await recording(up.url);
    // initialize itself carries no session id, so the upstream answers it.
    await initialized(base);
    expect(recorderOf(mcp).hasRecordSession("syn-session")).toBe(true);
    const res = await post(`${base}/mcp`, call(2, "echo"), { "Mcp-Session-Id": "syn-session" });
    expect(res.status).toBe(404);
    expect(recorderOf(mcp).hasRecordSession("syn-session")).toBe(false);
  });

  it("is removed at resetScenarioState()", async () => {
    const up = await synthetic();
    const { base, mcp } = await recording(up.url);
    await initialized(base);
    mcp.resetScenarioState();
    expect(recorderOf(mcp).hasRecordSession("syn-session")).toBe(false);
  });

  it("binds the initialize test id to the session (MR3 scope)", async () => {
    const up = await synthetic();
    const { base } = await recording(up.url);
    await initialized(base);
    await post(`${base}/mcp`, call(2, "echo"), { "Mcp-Session-Id": "syn-session" });
    const doc = JSON.parse(readFileSync(FILE(), "utf8")) as {
      mcpFakes: { scope: unknown; recorded: { protocolVersion: string; serverInfo: unknown } };
    };
    expect(doc.mcpFakes.scope).toEqual({ testId: T });
    expect(doc.mcpFakes.recorded.protocolVersion).toBe("2025-06-18");
    expect(doc.mcpFakes.recorded.serverInfo).toEqual({ name: "synthetic", version: "1.0.0" });
  });
});

/** True when `dir` holds no file at any depth. */
function validateNoFiles(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory() || !validateNoFiles(full)) return false;
  }
  return true;
}
