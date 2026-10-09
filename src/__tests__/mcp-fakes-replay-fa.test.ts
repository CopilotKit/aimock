/**
 * ◆ Gate G2: the recorded-fixture contract (FA1-FA5) replays through the real
 * CLI and a real `@modelcontextprotocol/sdk` v1 client over a real TCP port.
 *
 * `src/__tests__/fixtures/mcp-record/contract/mcp.json` is the shape the MCP
 * recorder writes. This suite proves that a recording in that shape replays:
 * the recorded `tools/list` order (AM7), the recorded results, the recorded
 * progress notifications on an SSE answer (FA3, MR15), the recorded timing at
 * the server's `--replay-speed` (FA4, T1), `"timing": "immediate"` (FA5), and
 * the B2 journal entry of an SSE-framed answer.
 *
 * The CLI is `dist/cli.js` (`pnpm build` first), or `$AIMOCK_CLI` (the RED
 * run points it at the base build). Without either, the suite is skipped.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
import {
  type CliHandle,
  REPO_ROOT,
  connectV1,
  enc,
  expectMcpError,
  startCli,
} from "./mcp-fakes-harness.js";

const CLI = process.env.AIMOCK_CLI ?? "dist/cli.js";
const CLI_PATH = resolve(REPO_ROOT, CLI);
const CLI_AVAILABLE = existsSync(CLI_PATH);

const CONTRACT_DIR = "src/__tests__/fixtures/mcp-record/contract";
const CONTRACT_FILE = resolve(REPO_ROOT, CONTRACT_DIR, "mcp.json");
const TEST_ID = "mcp › contract";
const HEADERS = { "X-Test-Id": enc(TEST_ID) };

const LONG = "trigger-long-running-operation";
const LONG_ARGS = { duration: 2, steps: 2 };
const LONG_RESULT = {
  content: [
    { type: "text", text: "Long running operation completed. Duration: 2 seconds, Steps: 2." },
  ],
};
const ECHO_RESULT = { content: [{ type: "text", text: "Echo: hi" }] };

/** The contract block (`mcpFakes`), as the file holds it. */
function contractBlock(): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(CONTRACT_FILE, "utf8")) as {
    mcpFakes: Record<string, unknown>;
  };
  return doc.mcpFakes;
}

function assertBuiltCliIsCurrent(): void {
  if (process.env.AIMOCK_CLI) return;
  const built = statSync(CLI_PATH).mtimeMs;
  for (const src of ["src/mcp-handler.ts", "src/mcp-mock.ts", "src/mcp-fakes.ts"]) {
    if (built < statSync(resolve(REPO_ROOT, src)).mtimeMs) {
      throw new Error(`${CLI} was built before ${src} was last edited — run \`pnpm build\`.`);
    }
  }
}

/** A raw MCP session over fetch: initialize, then notifications/initialized. */
async function rawSession(mcpUrl: string): Promise<string> {
  const init = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...HEADERS,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "raw", version: "1.0.0" },
      },
    }),
  });
  expect(init.status).toBe(200);
  await init.text();
  const sessionId = init.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("initialize returned no mcp-session-id");
  const ack = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId, ...HEADERS },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await ack.text();
  return sessionId;
}

/** A raw `tools/call` of the long-running tool with a progress token. */
function rawLongCall(mcpUrl: string, sessionId: string, accept: string): Promise<Response> {
  return fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: accept,
      "Mcp-Session-Id": sessionId,
      ...HEADERS,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: LONG, arguments: LONG_ARGS, _meta: { progressToken: "client-tok" } },
    }),
  });
}

/** Call the long-running tool through the SDK; resolve with its progress and elapsed ms. */
async function sdkLongCall(
  client: Client,
): Promise<{ result: unknown; progress: { progress: number; total?: number }[]; ms: number }> {
  const progress: { progress: number; total?: number }[] = [];
  const t0 = performance.now();
  const result = await client.callTool({ name: LONG, arguments: LONG_ARGS }, CallToolResultSchema, {
    onprogress: (p) => progress.push({ progress: p.progress, total: p.total }),
  });
  return { result, progress, ms: performance.now() - t0 };
}

describe.skipIf(!CLI_AVAILABLE)("G2: a recorded mcpFakes contract replays through the CLI", () => {
  const servers: CliHandle[] = [];
  const clients: Client[] = [];
  const tmpDirs: string[] = [];

  async function server(args: string[]): Promise<CliHandle> {
    const cli = await startCli(args, CLI);
    servers.push(cli);
    return cli;
  }
  async function client(url: string): Promise<Client> {
    const c = await connectV1(url, { headers: HEADERS });
    clients.push(c);
    return c;
  }

  beforeAll(() => {
    assertBuiltCliIsCurrent();
  });

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    for (const s of servers) await s.stop();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  describe("at --replay-speed 1", () => {
    let cli: CliHandle;
    let mcp: Client;
    beforeAll(async () => {
      cli = await server(["--fixtures", CONTRACT_DIR]);
      mcp = await client(cli.url + "/mcp");
    });

    it("(a) tools/list is the recorded list, in recorded order (AM7)", async () => {
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name)).toEqual(["echo", LONG]);
      expect(tools[0]).toMatchObject({ description: "Echoes back the input" });
    });

    it("(b) a recorded call answers with the recorded result", async () => {
      const result = await mcp.callTool({ name: "echo", arguments: { message: "hi" } });
      expect(result).toEqual(ECHO_RESULT);
    });

    it("(c, d, h) progress notifications replay with the client token, at recorded timing, journaled", async () => {
      const { result, progress, ms } = await sdkLongCall(mcp);
      expect(result).toEqual(LONG_RESULT);
      expect(progress).toEqual([
        { progress: 1, total: 2 },
        { progress: 2, total: 2 },
      ]);
      // (d) speed 1: the recorded 2010 ms plays (allowing for timer slack).
      expect(ms).toBeGreaterThanOrEqual(0.8 * 2010);

      // (h) B2: the SSE-framed answer is journaled as answered, with its entry id.
      const res = await fetch(`${cli.url}/__aimock/journal?service=mcp`);
      const entries = (await res.json()) as Array<{
        body: { method?: string; params?: { name?: string } } | null;
        response: { mcpFake?: { id: string | null; outcome: string } };
      }>;
      const calls = entries.filter(
        (e) => e.body?.method === "tools/call" && e.body.params?.name === LONG,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].response.mcpFake).toEqual({
        id: `mcp.json:${LONG}#0`,
        outcome: "answered",
      });
    });

    it("(g) arguments that match no recorded call get MCP_FAKE_MISMATCH", async () => {
      await expectMcpError(mcp.callTool({ name: "echo", arguments: { message: "bye" } }), {
        code: -32602,
        aimockCode: "MCP_FAKE_MISMATCH",
      });
    });
  });

  describe("at --replay-speed 100", () => {
    let cli: CliHandle;
    beforeAll(async () => {
      cli = await server(["--fixtures", CONTRACT_DIR, "--replay-speed", "100"]);
    });

    it("(d) recorded timing plays at value / speed", async () => {
      const mcp = await client(cli.url + "/mcp");
      const { result, progress, ms } = await sdkLongCall(mcp);
      expect(result).toEqual(LONG_RESULT);
      expect(progress.map((p) => p.progress)).toEqual([1, 2]);
      expect(ms).toBeLessThan(1000);
    });

    it("(i) a block added after start through the control API plays at the server speed (T1, W4/W6)", async () => {
      const add = await fetch(`${cli.url}/__aimock/fixtures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcpFakes: { ...contractBlock(), mount: "/mcp2" } }),
      });
      expect(add.status).toBe(200);
      const mcp2 = await client(cli.url + "/mcp2");
      const { result, progress, ms } = await sdkLongCall(mcp2);
      expect(result).toEqual(LONG_RESULT);
      expect(progress.map((p) => p.progress)).toEqual([1, 2]);
      expect(ms).toBeLessThan(1000);
    });
  });

  it("(c) on the wire: the answer is text/event-stream with two notifications and the result", async () => {
    const cli = await server(["--fixtures", CONTRACT_DIR, "--replay-speed", "100"]);
    const mcpUrl = cli.url + "/mcp";
    const sessionId = await rawSession(mcpUrl);
    const res = await rawLongCall(mcpUrl, sessionId, "application/json, text/event-stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/^text\/event-stream/);
    const body = await res.text();
    const data = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice("data:".length)) as Record<string, unknown>);
    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "client-tok", progress: 1, total: 2 },
    });
    expect(data[1]).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "client-tok", progress: 2, total: 2 },
    });
    expect(data[2]).toEqual({ jsonrpc: "2.0", id: 7, result: LONG_RESULT });
  });

  it("(e) without text/event-stream in Accept, the same call is answered as application/json (MR15)", async () => {
    const cli = await server(["--fixtures", CONTRACT_DIR, "--replay-speed", "100"]);
    const mcpUrl = cli.url + "/mcp";
    const sessionId = await rawSession(mcpUrl);
    const res = await rawLongCall(mcpUrl, sessionId, "application/json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 7, result: LONG_RESULT });
  });

  it('(f) a block with "timing": "immediate" ignores the recorded timing (FA5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimock-fa5-"));
    tmpDirs.push(dir);
    mkdirSync(join(dir, "fx"));
    writeFileSync(
      join(dir, "fx", "mcp.json"),
      JSON.stringify({ mcpFakes: { ...contractBlock(), timing: "immediate" } }),
    );
    const cli = await server(["--fixtures", join(dir, "fx")]);
    const mcp = await client(cli.url + "/mcp");
    const { result, progress, ms } = await sdkLongCall(mcp);
    expect(result).toEqual(LONG_RESULT);
    expect(progress.map((p) => p.progress)).toEqual([1, 2]);
    expect(ms).toBeLessThan(200);
  });
});

describe("AM7: tools/list with a recorded list, registered tools and other fakes", () => {
  it("is the recorded list, then registered tools missing from it, then other fake tools", async () => {
    const llm = new LLMock({ port: 0 });
    const mcp = new MCPMock();
    const schema = { type: "object" as const, properties: {} };
    mcp.addTool({ name: "registered-only", description: "registered", inputSchema: schema });
    mcp.addTool({ name: "echo", description: "registered echo", inputSchema: schema });
    mcp.loadFakes([
      contractBlock(),
      {
        scope: { testId: TEST_ID },
        tools: [{ name: "fake-only", calls: [{ anyArgs: true, result: "x" }] }],
      },
    ]);
    llm.mount("/mcp", mcp);
    const url = await llm.start();
    const mcpClient = await connectV1(url + "/mcp", { headers: HEADERS });
    try {
      const { tools } = await mcpClient.listTools();
      expect(tools.map((t) => t.name)).toEqual(["echo", LONG, "registered-only", "fake-only"]);
      // The recorded definition wins for a tool that is also registered.
      expect(tools[0].description).toBe("Echoes back the input");
    } finally {
      await mcpClient.close();
      await llm.stop();
    }
  });
});
