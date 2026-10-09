/**
 * MR1-MR17 on the real surface: a real `MCPMock` mounted on a real `LLMock`
 * port records a REAL upstream MCP server (server-everything, S0 harness)
 * through a real `@modelcontextprotocol/sdk` v1 client, and writes an
 * `mcpFakes` file. The last case (G2 consumer, plan Step 7) replays that file
 * offline through the built CLI with the upstream stopped.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
import { toCallToolResult, validateMcpFakes } from "../mcp-fakes.js";
import type { McpFakeCall } from "../types.js";
import {
  REPO_ROOT,
  connectV1,
  connectV2,
  enc,
  expectMcpError,
  startCli,
} from "./mcp-fakes-harness.js";
import { TEST_SECRET, startUpstream, type UpstreamHandle } from "./mcp-upstream-harness.js";

const TEST_ID = "mcp › record";
const LONG = "trigger-long-running-operation";
const LONG_ARGS = { duration: 2, steps: 2 };
const CLI_PATH = resolve(REPO_ROOT, "dist/cli.js");
const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as { version: string }
).version;

type RecordedCall = McpFakeCall & {
  args: Record<string, unknown>;
  notifications?: { atMs: number; method: string; params: Record<string, unknown> }[];
};
interface RecordedBlock {
  scope: { testId?: string; context?: string };
  mount: string;
  list?: { name: string }[];
  recorded?: {
    upstream: string;
    protocolVersion: string;
    serverInfo?: Record<string, unknown>;
    aimockVersion: string;
    at: string;
  };
  tools: { name: string; calls: RecordedCall[] }[];
}
interface RecordedFile {
  mcpFakes: RecordedBlock | RecordedBlock[];
  _warnings?: string[];
}

function readRecording(file: string): RecordedFile {
  return JSON.parse(readFileSync(file, "utf8")) as RecordedFile;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

let up: UpstreamHandle | null = null;
let upstreamOrigin = "";
let tmp = "";
let llm: LLMock | null = null;
let mcp: MCPMock;
let base = "";
const clients: Client[] = [];
/** Live results captured while recording (the B3 reference for secret-free tools). */
const live: Record<string, unknown> = {};
let liveTools: unknown[] = [];
const liveProgress: number[] = [];
let negotiatedVersion: string | undefined;
let liveServerInfo: unknown;
const logLines: string[] = [];

async function connect(testId: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = await connectV1(`${base}/mcp?testId=${enc(testId)}`, { headers });
  clients.push(client);
  return client;
}

function recordingFile(): string {
  return join(tmp, "mcp--record", "mcp.json");
}

beforeAll(async () => {
  for (const level of ["warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  up = await startUpstream();
  upstreamOrigin = new URL(up.url).origin;
  tmp = mkdtempSync(join(tmpdir(), "aimock-mcp-record-"));
  llm = new LLMock({ port: 0, logLevel: "warn" });
  mcp = new MCPMock();
  mcp.enableRecording({ upstream: up.url, fixturePath: tmp, secretValues: [TEST_SECRET] });
  llm.mount("/mcp", mcp);
  base = await llm.start();

  const client = await connect(TEST_ID);
  negotiatedVersion = (client.transport as StreamableHTTPClientTransport | undefined)
    ?.protocolVersion;
  liveServerInfo = client.getServerVersion();
  liveTools = (await client.listTools()).tools;
  live.echo = await client.callTool({ name: "echo", arguments: { message: "hi" } });
  live["get-sum"] = await client.callTool({ name: "get-sum", arguments: { a: 1, b: 2 } });
  live["get-structured-content"] = await client.callTool({
    name: "get-structured-content",
    arguments: { location: "New York" },
  });
  live[LONG] = await client.callTool({ name: LONG, arguments: LONG_ARGS }, CallToolResultSchema, {
    onprogress: (p) => liveProgress.push(p.progress),
  });
  live["get-env"] = await client.callTool({ name: "get-env", arguments: {} });
}, 60_000);

afterAll(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await llm?.stop().catch(() => {});
  await up?.stop().catch(() => {});
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("MR1-MR12: recording a real upstream MCP server", () => {
  it("writes <fixturePath>/<slug>/mcp.json that validates, with the list and the five calls in order", () => {
    expect(existsSync(recordingFile())).toBe(true);
    const doc = readRecording(recordingFile());
    const validation = validateMcpFakes(doc.mcpFakes, recordingFile());
    expect(validation.errors.map((e) => e.message)).toEqual([]);
    const block = doc.mcpFakes as RecordedBlock;
    expect(Array.isArray(doc.mcpFakes)).toBe(false);
    expect(block.scope).toEqual({ testId: TEST_ID });
    expect(block.mount).toBe("/mcp");
    expect(block.list).toHaveLength(13);
    expect(block.list).toEqual(liveTools);
    expect(block.tools.map((t) => t.name)).toEqual([
      "echo",
      "get-sum",
      "get-structured-content",
      LONG,
      "get-env",
    ]);
    expect(block.tools.find((t) => t.name === "echo")?.calls[0].args).toEqual({ message: "hi" });
    expect(block.tools.find((t) => t.name === "get-sum")?.calls[0].args).toEqual({ a: 1, b: 2 });
    expect(block.tools.find((t) => t.name === "get-env")?.calls[0].args).toEqual({});
  });

  it("records the long-running call's two progress notifications and its duration (FA3, FA4)", () => {
    expect(liveProgress).toEqual([1, 2]);
    const block = readRecording(recordingFile()).mcpFakes as RecordedBlock;
    const entry = block.tools.find((t) => t.name === LONG)?.calls[0];
    expect(entry?.notifications?.map((n) => n.method)).toEqual([
      "notifications/progress",
      "notifications/progress",
    ]);
    expect(entry?.notifications?.map((n) => n.params.progress)).toEqual([1, 2]);
    expect(entry?.notifications?.every((n) => n.atMs >= 0)).toBe(true);
    expect(entry?.durationMs).toBeGreaterThanOrEqual(1900);
  });

  it("FA2: recorded = origin only, the negotiated version, the upstream serverInfo, the package version", () => {
    const block = readRecording(recordingFile()).mcpFakes as RecordedBlock;
    expect(block.recorded?.upstream).toBe(upstreamOrigin);
    expect(negotiatedVersion).toBeDefined();
    expect(block.recorded?.protocolVersion).toBe(negotiatedVersion);
    expect(block.recorded?.serverInfo).toEqual(liveServerInfo);
    expect(block.recorded?.serverInfo).toMatchObject({ name: "mcp-servers/everything" });
    expect(block.recorded?.aimockVersion).toBe(PKG_VERSION);
    expect(Number.isNaN(Date.parse(block.recorded?.at ?? ""))).toBe(false);
  });

  it("S2/S6: the configured secret never reaches the file, and _warnings names the pointer", () => {
    const text = readFileSync(recordingFile(), "utf8");
    expect(JSON.stringify(live["get-env"])).toContain(TEST_SECRET); // the live relay is verbatim
    expect(countOf(text, "s3cr3t")).toBe(0);
    const doc = readRecording(recordingFile());
    const block = doc.mcpFakes as RecordedBlock;
    const envIndex = block.tools.findIndex((t) => t.name === "get-env");
    expect(doc._warnings).toContain(
      `/mcpFakes/tools/${envIndex}/calls/0/result/content/0/text: redacted a known secret`,
    );
    expect(JSON.stringify(block.tools[envIndex].calls[0])).toContain("[REDACTED]");
  });

  it("MR12: the written entries are registered as record#<n> and consumed for the test id", async () => {
    const res = await fetch(`${base}/__aimock/mcp/fakes?testId=${enc(TEST_ID)}`);
    const body = (await res.json()) as {
      mounts: {
        mount: string;
        blocks: { blockId: string; tools: { entries: { id: string; consumed: boolean }[] }[] }[];
      }[];
    };
    const blocks = body.mounts.find((m) => m.mount === "/mcp")?.blocks ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    expect(blocks.every((b) => /^record#\d+$/.test(b.blockId))).toBe(true);
    const calls = blocks.flatMap((b) => b.tools.flatMap((t) => t.entries));
    expect(calls.every((c) => c.id.startsWith("record#") && c.consumed)).toBe(true);
  });

  it("MR12: a second identical call is forwarded and appended as the next entry", async () => {
    const client = await connect(TEST_ID);
    const again = await client.callTool({ name: "echo", arguments: { message: "hi" } });
    expect(again).toEqual(live.echo);
    const block = readRecording(recordingFile()).mcpFakes as RecordedBlock;
    const echo = block.tools.find((t) => t.name === "echo");
    expect(echo?.calls).toHaveLength(2);
    expect(echo?.calls[1].args).toEqual({ message: "hi" });
  });

  it("AM8: proxied journal entries carry source proxy and a body, and no mcp key", () => {
    const entries = llm!.getRequests().filter((e) => e.service === "mcp");
    const proxied = entries.filter((e) => e.response.source === "proxy");
    expect(proxied.length).toBeGreaterThan(5);
    const calls = proxied.filter(
      (e) => (e.body as { method?: string } | null)?.method === "tools/call",
    );
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const e of proxied) expect(e).not.toHaveProperty("mcp");
    expect(calls.every((e) => e.testId === TEST_ID)).toBe(true);
  });

  it("RP2: forwarded calls are logged as unfaked, answered by the upstream", () => {
    const part = mcp.fakesReportPart(TEST_ID, null, "/mcp");
    const upstream = part.unfaked.filter((u) => u.answeredBy === "upstream").map((u) => u.tool);
    expect(upstream).toEqual(
      expect.arrayContaining(["echo", "get-sum", "get-structured-content", LONG, "get-env"]),
    );
  });

  it("rr S1: no request header name or value is written, and a static Bearer is never stored", async () => {
    const id = "mcp › headers";
    const client = await connect(id, {
      Authorization: "Bearer abcdefgh12345",
      "X-Custom-Header": "hdr-value-77",
    });
    await client.callTool({ name: "echo", arguments: { message: "headers" } });
    const text = readFileSync(join(tmp, "mcp--headers", "mcp.json"), "utf8");
    expect(countOf(text, "abcdefgh12345")).toBe(0);
    expect(countOf(text, "hdr-value-77")).toBe(0);
    expect(text.toLowerCase()).not.toContain("authorization");
    expect(text.toLowerCase()).not.toContain("x-custom-header");
    expect(text.toLowerCase()).not.toContain("x-test-id");
    expect(text.toLowerCase()).not.toContain("mcp-session-id");
  });

  it("G2b B1: credentials in the client's query string are known secrets and never reach the file", async () => {
    const id = "mcp › query secrets";
    const apiKey = "clientQuerySecret66";
    const token = "clientTokenValue77";
    const client = await connectV1(
      `${base}/mcp?testId=${enc(id)}&api_key=${apiKey}&access_token=${token}`,
    );
    clients.push(client);
    const echoed = await client.callTool({
      name: "echo",
      arguments: { message: `api_key=${apiKey} access_token=${token}` },
    });
    expect(JSON.stringify(echoed)).toContain(apiKey); // the live relay is verbatim
    const file = join(tmp, "mcp--query-secrets", "mcp.json");
    const text = readFileSync(file, "utf8");
    expect(countOf(text, apiKey)).toBe(0);
    expect(countOf(text, token)).toBe(0);
    expect(text).toContain("[REDACTED]");
  });

  it("TI6: a Vitest-shaped id drops the file prefix in the path, keeps it in the scope, and appends a separate block per id", async () => {
    const foo = "src/foo.test.ts › suite › case";
    const bar = "src/bar.test.ts › suite › case";
    const c1 = await connect(foo);
    await c1.callTool({ name: "echo", arguments: { message: "foo" } });
    const file = join(tmp, "suite--case", "mcp.json");
    expect((readRecording(file).mcpFakes as RecordedBlock).scope).toEqual({ testId: foo });
    const c2 = await connect(bar);
    await c2.callTool({ name: "echo", arguments: { message: "bar" } });
    const doc = readRecording(file);
    expect(Array.isArray(doc.mcpFakes)).toBe(true);
    const blocks = doc.mcpFakes as RecordedBlock[];
    expect(blocks.map((b) => b.scope.testId)).toEqual([foo, bar]);
    expect(validateMcpFakes(doc.mcpFakes, file).errors).toEqual([]);
  });

  it.skipIf(!existsSync(CLI_PATH))(
    "G2 consumer (Step 7): the recording replays offline through the CLI, equal to the file",
    async () => {
      const fx = mkdtempSync(join(tmpdir(), "aimock-mcp-replay-"));
      try {
        mkdirSync(fx, { recursive: true });
        writeFileSync(join(fx, "mcp.json"), readFileSync(recordingFile()));
        // Offline: the upstream is gone for the whole replay. (`stop()` twice
        // would wait for a second exit, so the handle is dropped.)
        await up!.stop();
        up = null;
        const block = readRecording(recordingFile()).mcpFakes as RecordedBlock;
        const entryOf = (tool: string): RecordedCall =>
          block.tools.find((t) => t.name === tool)!.calls[0];

        for (const speed of ["1", "100"]) {
          const cli = await startCli(["--fixtures", fx, "--replay-speed", speed]);
          try {
            const client = await connectV1(`${cli.url}/mcp?testId=${enc(TEST_ID)}`);
            clients.push(client);
            expect((await client.listTools()).tools).toEqual(block.list);
            const calls: [string, Record<string, unknown>][] = [
              ["echo", { message: "hi" }],
              ["get-sum", { a: 1, b: 2 }],
              ["get-structured-content", { location: "New York" }],
            ];
            for (const [name, args] of calls) {
              const replayed = await client.callTool({ name, arguments: args });
              expect(replayed).toEqual(toCallToolResult(entryOf(name)));
              expect(replayed).toEqual(live[name]);
            }
            const progress: number[] = [];
            const t0 = performance.now();
            const long = await client.callTool(
              { name: LONG, arguments: LONG_ARGS },
              CallToolResultSchema,
              { onprogress: (p) => progress.push(p.progress) },
            );
            const ms = performance.now() - t0;
            expect(long).toEqual(toCallToolResult(entryOf(LONG)));
            expect(long).toEqual(live[LONG]);
            expect(progress).toEqual([1, 2]);
            if (speed === "1") {
              expect(ms).toBeGreaterThanOrEqual(0.8 * (entryOf(LONG).durationMs ?? 0));
            } else {
              expect(ms).toBeLessThan(1000);
            }
            const env = await client.callTool({ name: "get-env", arguments: {} });
            expect(env).toEqual(toCallToolResult(entryOf("get-env")));
            expect(JSON.stringify(env)).toContain("[REDACTED]");
            expect(JSON.stringify(env)).not.toContain("s3cr3t");
            await expectMcpError(client.callTool({ name: "echo", arguments: { message: "new" } }), {
              code: -32602,
              aimockCode: "MCP_FAKE_MISMATCH",
            });
            await client.close();
          } finally {
            await cli.stop();
          }
        }
      } finally {
        rmSync(fx, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("F3: an upstream that dies mid-body on the buffered JSON path", () => {
  let dying: http.Server;
  let dyingUrl = "";
  let fx = "";
  let mock: LLMock;
  let mockMcp: MCPMock;
  let mockBase = "";

  beforeAll(async () => {
    dying = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d: Buffer) => (raw += d.toString("utf8")));
      req.on("end", () => {
        const m = (raw ? JSON.parse(raw) : {}) as {
          id?: number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        const json = (body: unknown, extra: Record<string, string> = {}): void => {
          res.writeHead(200, { "content-type": "application/json", ...extra });
          res.end(JSON.stringify(body));
        };
        if (m.method === "initialize") {
          json(
            {
              jsonrpc: "2.0",
              id: m.id,
              result: {
                protocolVersion: m.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "dying", version: "1" },
              },
            },
            { "mcp-session-id": "s1" },
          );
          return;
        }
        if (!("id" in m)) {
          res.writeHead(202);
          res.end();
          return;
        }
        if (m.method === "tools/list") {
          json({
            jsonrpc: "2.0",
            id: m.id,
            result: { tools: [{ name: "boom", inputSchema: { type: "object" } }] },
          });
          return;
        }
        if (m.method === "tools/call") {
          // Headers and part of the body, then the socket dies.
          res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
          res.write(`{"jsonrpc":"2.0","id":${m.id},"result":{"content":[{"type":"te`);
          setTimeout(() => res.socket?.destroy(), 50);
          return;
        }
        json({ jsonrpc: "2.0", id: m.id, result: {} });
      });
    });
    await new Promise<void>((r) => dying.listen(0, "127.0.0.1", r));
    dyingUrl = `http://127.0.0.1:${(dying.address() as AddressInfo).port}/mcp`;
    fx = mkdtempSync(join(tmpdir(), "aimock-mcp-midbody-"));
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mockMcp = new MCPMock();
    mockMcp.enableRecording({ upstream: dyingUrl, fixturePath: fx });
    mock.mount("/mcp", mockMcp);
    mockBase = await mock.start();
  });

  afterAll(async () => {
    await mock?.stop().catch(() => {});
    await new Promise<void>((r) => dying?.close(() => r()));
    if (fx) rmSync(fx, { recursive: true, force: true });
  });

  it("answers 502 JSON, logs one MCP-RECORD line, journals upstream-aborted, and records nothing", async () => {
    const id = "mcp › midbody";
    const before = logLines.length;

    // A real MCP client gets an error that names the upstream, not a content-type complaint.
    const client = await connectV1(`${mockBase}/mcp?testId=${enc(id)}`);
    clients.push(client);
    await client.listTools();
    const err = await client.callTool({ name: "boom", arguments: {} }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("Unexpected content type");
    expect((err as Error).message).toContain("the upstream response failed");

    // The raw view: a 502 with a JSON body.
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const init = await fetch(`${mockBase}/mcp?testId=${enc(id)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "1" },
        },
      }),
    });
    const sid = init.headers.get("mcp-session-id") ?? "";
    await init.text();
    const res = await fetch(`${mockBase}/mcp?testId=${enc(id)}`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "boom", arguments: {} },
      }),
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      error: "aimock MCP recorder: the upstream response failed",
    });

    // One MCP-RECORD line per failed call, with its cause and no values.
    const lines = logLines.slice(before).filter((l) => l.includes("MCP-RECORD"));
    const line = "failed mid-body (upstream-aborted) for tools/call on mount /mcp: aborted";
    expect(lines).toEqual([expect.stringContaining(line), expect.stringContaining(line)]);

    // Journaled as a 502 with recordSkipped upstream-aborted, not the
    // upstream-error of an upstream that answered with an error.
    const calls = mock
      .getRequests()
      .filter((e) => (e.body as { method?: string } | null)?.method === "tools/call");
    expect(calls).toHaveLength(2);
    for (const e of calls) {
      expect(e.response.status).toBe(502);
      expect(e.response.recordSkipped).toBe("upstream-aborted");
    }

    // Nothing is recorded.
    expect(readdirSync(fx)).toEqual([]);
  });
});

describe("R1: an upstream that dies mid-body fails loudly on every relay path", () => {
  // Long enough that a client left hanging shows as a timeout, short enough for CI.
  const CLIENT_TIMEOUT = 4_000;
  let dying: http.Server;
  let fx = "";
  let mock: LLMock;
  let mockBase = "";
  /** Resolved when the upstream sees the client-disconnect probe's call close. */
  let slowClosed: Promise<void> = Promise.resolve();
  let markSlowClosed = (): void => {};
  let slowSeen: Promise<void> = Promise.resolve();
  let markSlowSeen = (): void => {};

  beforeAll(async () => {
    dying = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d: Buffer) => (raw += d.toString("utf8")));
      req.on("end", () => {
        const m = (raw ? JSON.parse(raw) : {}) as {
          id?: number;
          method?: string;
          params?: { protocolVersion?: string; name?: string };
        };
        const die = (): void => void setTimeout(() => res.socket?.destroy(), 50);
        const json = (body: unknown, extra: Record<string, string> = {}): void => {
          res.writeHead(200, { "content-type": "application/json", ...extra });
          res.end(JSON.stringify(body));
        };
        if (m.method === "initialize") {
          json(
            {
              jsonrpc: "2.0",
              id: m.id,
              result: {
                protocolVersion: m.params?.protocolVersion,
                capabilities: { tools: {}, resources: {} },
                serverInfo: { name: "dying", version: "1" },
              },
            },
            { "mcp-session-id": "s1" },
          );
          return;
        }
        if (!("id" in m)) {
          res.writeHead(202);
          res.end();
          return;
        }
        // SSE record path: one whole event and half of the response event, then the socket dies.
        if (m.method === "tools/call" && m.params?.name === "sse-die") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/message",
              params: { level: "info", data: "working" },
            })}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":${m.id},"result":{"con`,
          );
          die();
          return;
        }
        // Buffer-cap overflow: more than maxRecordBufferBytes, then the socket dies.
        if (m.method === "tools/call" && m.params?.name === "big-die") {
          res.writeHead(200, { "content-type": "application/json", "content-length": "100000" });
          res.write(
            `{"jsonrpc":"2.0","id":${m.id},"result":{"content":[{"type":"text","text":"${"x".repeat(3000)}`,
          );
          die();
          return;
        }
        // Client-disconnect probe: part of a body, then the upstream waits.
        if (m.method === "tools/call" && m.params?.name === "slow") {
          res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
          res.write(`{"jsonrpc":"2.0","id":${m.id},"result":{"content":[`);
          res.on("close", () => markSlowClosed());
          markSlowSeen();
          return;
        }
        // Pass-through JSON, chunked framing.
        if (m.method === "resources/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write(`{"jsonrpc":"2.0","id":${m.id},"result":{"resources":[{"uri":"a://b","na`);
          die();
          return;
        }
        // Pass-through JSON, content-length framing.
        if (m.method === "resources/templates/list") {
          res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
          res.write(`{"jsonrpc":"2.0","id":${m.id},"result":{"resourceTemplates":[{"uriTe`);
          die();
          return;
        }
        json({ jsonrpc: "2.0", id: m.id, result: {} });
      });
    });
    await new Promise<void>((r) => dying.listen(0, "127.0.0.1", r));
    const dyingUrl = `http://127.0.0.1:${(dying.address() as AddressInfo).port}/mcp`;
    fx = mkdtempSync(join(tmpdir(), "aimock-mcp-r1-"));
    mock = new LLMock({ port: 0, logLevel: "warn" });
    const mockMcp = new MCPMock();
    mockMcp.enableRecording({ upstream: dyingUrl, fixturePath: fx, maxRecordBufferBytes: 1024 });
    mock.mount("/mcp", mockMcp);
    mockBase = await mock.start();
  });

  afterAll(async () => {
    await mock?.stop().catch(() => {});
    await new Promise<void>((r) => dying?.close(() => r()));
    if (fx) rmSync(fx, { recursive: true, force: true });
  });

  /** How a client call settled: never "resolved", and never at the client's own timeout. */
  async function failure(p: Promise<unknown>): Promise<string> {
    const started = Date.now();
    const outcome = await p.then(
      (v) => ({ ok: true as const, text: JSON.stringify(v) }),
      (e: unknown) => ({ ok: false as const, text: e instanceof Error ? e.message : String(e) }),
    );
    expect(outcome.ok, `expected the call to fail, got ${outcome.text}`).toBe(false);
    expect(outcome.text).not.toMatch(/timed out|Unexpected content type|Unterminated|JSON/i);
    expect(Date.now() - started).toBeLessThan(CLIENT_TIMEOUT);
    return outcome.text;
  }

  type Call = "sse" | "overflow" | "chunked" | "length";
  const methodOf: Record<Call, string> = {
    sse: "tools/call",
    overflow: "tools/call",
    chunked: "resources/list",
    length: "resources/templates/list",
  };

  async function runBoth(call: Call, testId: string): Promise<void> {
    const url = `${mockBase}/mcp?testId=${enc(testId)}`;
    const opts = { timeout: CLIENT_TIMEOUT };
    const v1 = await connectV1(url);
    const v2 = await connectV2(url);
    try {
      if (call === "sse" || call === "overflow") {
        const name = call === "sse" ? "sse-die" : "big-die";
        await failure(v1.callTool({ name, arguments: {} }, CallToolResultSchema, opts));
        await failure(v2.callTool({ name, arguments: {} }, opts));
      } else if (call === "chunked") {
        await failure(v1.listResources({}, opts));
        await failure(v2.listResources({}, opts));
      } else {
        await failure(v1.listResourceTemplates({}, opts));
        await failure(v2.listResourceTemplates({}, opts));
      }
    } finally {
      await v1.close().catch(() => {});
      await v2.close().catch(() => {});
    }
  }

  function expectLoud(call: Call, testId: string, before: number): void {
    const method = methodOf[call];
    // One MCP-RECORD line per failed call, with the cause.
    const failed = logLines
      .slice(before)
      .filter((l) => l.includes("MCP-RECORD") && l.includes("failed mid-body"));
    expect(failed).toEqual([
      expect.stringContaining(`(upstream-aborted) for ${method} on mount /mcp: aborted`),
      expect.stringContaining(`(upstream-aborted) for ${method} on mount /mcp: aborted`),
    ]);
    // Journaled with a reason distinct from an upstream HTTP or JSON-RPC error
    // (only tools/call bodies are journaled, so match the skipped entries).
    const skipped = mock
      .getRequests()
      .filter((e) => e.testId === testId && e.response.recordSkipped !== undefined)
      .map((e) => e.response.recordSkipped);
    expect(skipped).toEqual(["upstream-aborted", "upstream-aborted"]);
    // Nothing is recorded.
    expect(readdirSync(fx)).toEqual([]);
  }

  it("SSE record path: the client gets an error at once, not a clean end of stream", async () => {
    const id = "mcp › r1 sse";
    const before = logLines.length;
    await runBoth("sse", id);
    expectLoud("sse", id, before);
  }, 30_000);

  it("buffered JSON after a buffer-cap overflow: the stream is terminated and the cause logged", async () => {
    const id = "mcp › r1 overflow";
    const before = logLines.length;
    await runBoth("overflow", id);
    expectLoud("overflow", id, before);
  }, 30_000);

  it("pass-through JSON, chunked: never relayed as a complete 200", async () => {
    const id = "mcp › r1 chunked";
    const before = logLines.length;
    await runBoth("chunked", id);
    expectLoud("chunked", id, before);
  }, 30_000);

  it("pass-through JSON, content-length: the client fails at once, never hangs", async () => {
    const id = "mcp › r1 length";
    const before = logLines.length;
    await runBoth("length", id);
    expectLoud("length", id, before);
  }, 30_000);

  it("a client that disconnects is not logged or journaled as an upstream failure", async () => {
    const id = "mcp › r1 disconnect";
    slowSeen = new Promise<void>((r) => (markSlowSeen = r));
    slowClosed = new Promise<void>((r) => (markSlowClosed = r));
    const url = `${mockBase}/mcp?testId=${enc(id)}`;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "1" },
        },
      }),
    });
    const sid = init.headers.get("mcp-session-id") ?? "";
    await init.text();
    const before = logLines.length;
    const abort = new AbortController();
    const pending = fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "slow", arguments: {} },
      }),
      signal: abort.signal,
    }).catch((e: unknown) => e);
    await slowSeen;
    abort.abort();
    expect(await pending).toBeInstanceOf(Error);
    // The disconnect reached the upstream (the failure path really ran)...
    await slowClosed;
    await new Promise((r) => setTimeout(r, 300));
    // ...and nothing calls it an upstream failure.
    const lines = logLines
      .slice(before)
      .filter((l) => /MCP-RECORD.*(upstream-error|upstream-aborted|failed mid-body)/.test(l));
    expect(lines).toEqual([]);
    const call = mock
      .getRequests()
      .filter(
        (e) => e.testId === id && (e.body as { method?: string } | null)?.method === "tools/call",
      );
    expect(call).toHaveLength(1);
    expect(call[0].response.recordSkipped).not.toBe("upstream-aborted");
    expect(call[0].response.recordSkipped).not.toBe("upstream-error");
    expect(readdirSync(fx)).toEqual([]);
  }, 30_000);
});
