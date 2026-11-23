/**
 * S6 (HC3): MCP recording wired into the CLIs, on the real surface.
 *
 * - `llmock` (dist/cli.js): `--mcp-record` / `--mcp-proxy-only` (C1, C11, AM6).
 * - `aimock --config` (dist/aimock-cli.js): `llm.record.mcp` (MR1, C10).
 * - `--watch` with a recorder (MR13) and `aimock validate` (S7 `_warnings`).
 *
 * Every case spawns the built CLI as a child process. The upstream is the real
 * server-everything (scrubbed env) or a small synthetic HTTP upstream.
 * `AIMOCK_S6_DIST=<dir>` runs the same cases against another build (the base
 * release for the RED run).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { toCallToolResult } from "../mcp-fakes.js";
import type { McpFakeCall } from "../types.js";
import { REPO_ROOT, connectV1, enc, expectMcpError, startCli } from "./mcp-fakes-harness.js";
import type { CliHandle } from "./mcp-fakes-harness.js";
import { TEST_SECRET, startUpstream, type UpstreamHandle } from "./mcp-upstream-harness.js";

const DIST = resolve(process.env.AIMOCK_S6_DIST ?? join(REPO_ROOT, "dist"));
const LLMOCK = join(DIST, "cli.js");
const AIMOCK = join(DIST, "aimock-cli.js");
const BUILT = existsSync(LLMOCK) && existsSync(AIMOCK);

/** Mode bits are not enforced for root, so the EACCES cases cannot fail there. */
const IS_ROOT = process.getuid?.() === 0;

const TEST_ID = "mcp › record";
const SLUG = "mcp--record";
const SECRET_ENV = { AIMOCK_RECORD_SECRET_VALUES: TEST_SECRET };

type RecordedCall = McpFakeCall & { args: Record<string, unknown> };
interface RecordedBlock {
  list?: unknown[];
  tools: { name: string; calls: RecordedCall[] }[];
}

const tmps: string[] = [];
const clis: CliHandle[] = [];
const clients: Client[] = [];
const closers: (() => Promise<void>)[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aimock-s6-${prefix}-`));
  tmps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const c of clis.splice(0)) await c.stop();
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
});

afterAll(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function cli(
  bin: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<CliHandle> {
  const handle = await startCli(args, bin, { env: { ...process.env, ...env } });
  clis.push(handle);
  return handle;
}

/** Run a CLI that must exit before it listens: its exit code and both streams. */
function runToExit(
  bin: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [bin, "--port", "0", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function blockOf(file: string): RecordedBlock {
  const doc = JSON.parse(readFileSync(file, "utf8")) as { mcpFakes: unknown };
  return (Array.isArray(doc.mcpFakes) ? doc.mcpFakes[0] : doc.mcpFakes) as RecordedBlock;
}

function entryOf(block: RecordedBlock, tool: string): RecordedCall {
  const t = block.tools.find((x) => x.name === tool);
  if (!t) throw new Error(`no recorded tool ${tool}`);
  return t.calls[0];
}

/** A synthetic upstream that echoes tools/call arguments as JSON and records request headers. */
async function syntheticUpstream(): Promise<{ url: string; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push(req.headers);
      const body = Buffer.concat(chunks).toString("utf8");
      const message = (body ? JSON.parse(body) : {}) as {
        id?: number;
        params?: { arguments?: unknown };
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            content: [
              { type: "text", text: `args ${JSON.stringify(message.params?.arguments ?? {})}` },
            ],
          },
        }),
      );
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

/** One raw `tools/call` of `echo` with the test id in a header (no MCP session). */
async function callEcho(base: string, args: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Test-Id": enc(TEST_ID),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: args },
    }),
  });
  await res.text();
  return res.status;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred()` holds, or fail after `ms`. */
async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const CHAT_FIXTURE = {
  fixtures: [{ match: { userMessage: "hello" }, response: { content: "hi there" } }],
};

describe.skipIf(!BUILT)("S6: MCP recording through the CLIs", () => {
  describe("llmock --mcp-record against the real upstream", () => {
    let up: UpstreamHandle | null = null;
    let fx = "";
    let file = "";
    const live: Record<string, unknown> = {};

    beforeAll(async () => {
      up = await startUpstream();
      fx = tmp("rec");
      file = join(fx, "recorded", SLUG, "mcp.json");
      const rec = await cli(
        LLMOCK,
        ["--fixtures", fx, "--mcp-record", `/mcp=${up.url}`],
        SECRET_ENV,
      );
      const client = await connectV1(`${rec.url}/mcp?testId=${enc(TEST_ID)}`);
      await client.listTools();
      live.echo = await client.callTool({ name: "echo", arguments: { message: "hi" } });
      live["get-sum"] = await client.callTool({ name: "get-sum", arguments: { a: 1, b: 2 } });
      live["get-env"] = await client.callTool({ name: "get-env", arguments: {} });
      await client.close();
      await rec.stop();
      clis.splice(clis.indexOf(rec), 1);
      // Offline from here on (stop() twice would wait for a second exit).
      await up.stop();
      up = null;
    }, 60_000);

    afterAll(async () => {
      await up?.stop();
    });

    it("records with AIMOCK_RECORD_SECRET_VALUES: the secret is redacted and the pointer warned", () => {
      expect(JSON.stringify(live["get-env"])).toContain(TEST_SECRET);
      const text = readFileSync(file, "utf8");
      expect(countOf(text, "s3cr3t")).toBe(0);
      const doc = JSON.parse(text) as { _warnings?: string[] };
      expect(doc._warnings).toEqual([
        "/mcpFakes/tools/2/calls/0/result/content/0/text: redacted a known secret",
      ]);
    });

    it("replays offline from the file, equal to it; an unrecorded call is a reported mismatch", async () => {
      const block = blockOf(file);
      const rep = await cli(LLMOCK, ["--fixtures", fx, "--replay-speed", "100"]);
      const client = await connectV1(`${rep.url}/mcp?testId=${enc(TEST_ID)}`);
      clients.push(client);
      expect((await client.listTools()).tools).toEqual(block.list);
      const echo = await client.callTool({ name: "echo", arguments: { message: "hi" } });
      expect(echo).toEqual(toCallToolResult(entryOf(block, "echo")));
      expect(echo).toEqual(live.echo);
      const sum = await client.callTool({ name: "get-sum", arguments: { a: 1, b: 2 } });
      expect(sum).toEqual(toCallToolResult(entryOf(block, "get-sum")));
      expect(sum).toEqual(live["get-sum"]);
      const env = await client.callTool({ name: "get-env", arguments: {} });
      expect(env).toEqual(toCallToolResult(entryOf(block, "get-env")));
      expect(JSON.stringify(env)).toContain("[REDACTED]");
      expect(JSON.stringify(env)).not.toContain("s3cr3t");
      await expectMcpError(
        client.callTool({ name: "echo", arguments: { message: "never recorded" } }),
        { code: -32602, aimockCode: "MCP_FAKE_MISMATCH" },
      );
    });

    it("aimock validate prints the recording's _warnings", () => {
      const r = spawnSync(process.execPath, [AIMOCK, "validate", fx], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 15_000,
      });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain(
        "/mcpFakes/tools/2/calls/0/result/content/0/text: redacted a known secret",
      );
    });
  });

  describe("llmock --mcp-record with a CRLF AIMOCK_RECORD_SECRET_VALUES (P01)", () => {
    it("the CRLF-terminated secret is redacted and the get-env pointer warned", async () => {
      const up = await startUpstream();
      closers.push(() => up.stop());
      const fx = tmp("crlf");
      const rec = await cli(LLMOCK, ["--fixtures", fx, "--mcp-record", `/mcp=${up.url}`], {
        AIMOCK_RECORD_SECRET_VALUES: `${TEST_SECRET}\r\n`,
      });
      const client = await connectV1(`${rec.url}/mcp?testId=${enc(TEST_ID)}`);
      clients.push(client);
      const live = await client.callTool({ name: "get-env", arguments: {} });
      expect(JSON.stringify(live)).toContain(TEST_SECRET);
      const file = join(fx, "recorded", SLUG, "mcp.json");
      await until(() => existsSync(file), 10_000, "the recording");
      const text = readFileSync(file, "utf8");
      expect(countOf(text, TEST_SECRET)).toBe(0);
      const doc = JSON.parse(text) as { _warnings?: string[] };
      expect(doc._warnings).toEqual([
        "/mcpFakes/tools/0/calls/0/result/content/0/text: redacted a known secret",
      ]);
    }, 60_000);
  });

  describe("llmock flag errors (C11, AM6, S2 d)", () => {
    it("--mcp-record with no --fixtures exits 1", () => {
      const r = runToExit(LLMOCK, ["--mcp-record", "/mcp=http://127.0.0.1:9/mcp"]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        "Error: --mcp-record requires --fixtures <local path> for the recording destination",
      );
    });

    it("--mcp-record with a URL --fixtures exits 1", () => {
      const url = "https://example.invalid/fx.json";
      const r = runToExit(LLMOCK, [
        "--fixtures",
        url,
        "--mcp-record",
        "/mcp=http://127.0.0.1:9/mcp",
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        `Error: --mcp-record requires a local --fixtures path for the recording destination; got URL ${url}`,
      );
    });

    it("a malformed --mcp-record value exits 1, naming the flag", () => {
      const r = runToExit(LLMOCK, ["--fixtures", tmp("bad"), "--mcp-record", "mcp=http://x/mcp"]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("--mcp-record must be <mount>=<url>");
    });

    it("F2: --mcp-record with a file --fixtures exits 1: the destination is not a directory", () => {
      const fx = join(tmp("fxfile"), "fx.json");
      writeFileSync(fx, JSON.stringify({ fixtures: [] }));
      const r = runToExit(LLMOCK, [
        "--fixtures",
        fx,
        "--mcp-record",
        "/mcp=http://127.0.0.1:9/mcp",
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        `Error: MCP record destination ${join(fx, "recorded")} is not a directory`,
      );
    });

    it("an AIMOCK_RECORD_SECRET_VALUES entry under 8 characters exits 1", () => {
      const r = runToExit(
        LLMOCK,
        ["--fixtures", tmp("short"), "--mcp-record", "/mcp=http://127.0.0.1:9/mcp"],
        { AIMOCK_RECORD_SECRET_VALUES: "abc" },
      );
      expect(r.status).toBe(1);
      expect(r.out).toContain("record.secretValues entry shorter than 8 characters");
    });

    it("a malformed AIMOCK_MCP_UPSTREAM_AUTH exits 1, naming the variable and not the value", () => {
      const r = runToExit(
        LLMOCK,
        ["--fixtures", tmp("auth"), "--mcp-record", "/mcp=http://127.0.0.1:9/mcp"],
        { AIMOCK_MCP_UPSTREAM_AUTH: "novalue" },
      );
      expect(r.status).toBe(1);
      expect(r.out).toContain("AIMOCK_MCP_UPSTREAM_AUTH must be");
    });

    it("--mcp-record on the --agui-record mount exits 1", () => {
      const r = runToExit(LLMOCK, [
        "--fixtures",
        tmp("agui"),
        "--agui-record",
        "--agui-upstream",
        "http://127.0.0.1:9/agui",
        "--mcp-record",
        "/agui=http://127.0.0.1:9/mcp",
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        "Error: --mcp-record mount /agui is held by a mount that is not an MCP mock",
      );
    });

    it.each<[string, string, string]>([
      ["a trailing /", "/mcp/", 'mount "/mcp/" can never be reached: it must not end with "/"'],
      ["a query", "/mcp?x", 'mount "/mcp?x" can never be reached: it must be a plain URL path'],
      ["whitespace", "/a b", 'mount "/a b" can never be reached: it must be a plain URL path'],
      ["a //", "//", 'mount "//" can never be reached: it must not start with "//"'],
    ])("R2: a --mcp-record mount with %s exits 1, naming the mount", (_name, mount, message) => {
      const r = runToExit(LLMOCK, [
        "--fixtures",
        tmp("unreach"),
        "--mcp-record",
        `${mount}=http://127.0.0.1:9/mcp`,
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(`Error: --mcp-record ${message}`);
    });

    it("R2: a --mcp-record upstream that is not http(s) exits 1, naming the mount", () => {
      const r = runToExit(LLMOCK, [
        "--fixtures",
        tmp("ftp"),
        "--mcp-record",
        "/mcp=ftp://user:tok3n-secret@host/mcp",
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        "Error: --mcp-record /mcp: the upstream must be an http: or https: URL",
      );
      expect(r.out).not.toContain("tok3n-secret");
    });

    it("R2: a --fixtures/recorded that is a broken symbolic link exits 1, naming it", () => {
      const fx = tmp("dangling");
      const recorded = join(fx, "recorded");
      symlinkSync(join(fx, "nowhere"), recorded);
      const r = runToExit(LLMOCK, [
        "--fixtures",
        fx,
        "--mcp-record",
        "/mcp=http://127.0.0.1:9/mcp",
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        `Error: MCP record destination ${recorded} goes through a broken symbolic link at ${recorded}`,
      );
    });

    it.skipIf(IS_ROOT)("R2: a --fixtures/recorded that is not writable exits 1, naming it", () => {
      const fx = tmp("eacces");
      const recorded = join(fx, "recorded");
      mkdirSync(recorded);
      chmodSync(recorded, 0o500);
      try {
        const r = runToExit(LLMOCK, [
          "--fixtures",
          fx,
          "--mcp-record",
          "/mcp=http://127.0.0.1:9/mcp",
        ]);
        expect(r.status).toBe(1);
        expect(r.out).toContain(
          `Error: MCP record destination ${recorded} is not writable (EACCES at ${recorded})`,
        );
      } finally {
        chmodSync(recorded, 0o700);
      }
    });
  });

  describe("llmock against a synthetic upstream", () => {
    it("AIMOCK_MCP_UPSTREAM_AUTH is sent upstream and never written", async () => {
      const up = await syntheticUpstream();
      const fx = tmp("hdr");
      const c = await cli(LLMOCK, ["--fixtures", fx, "--mcp-record", `/mcp=${up.url}`], {
        AIMOCK_MCP_UPSTREAM_AUTH: "X-Key: sekret-value-99",
      });
      expect(await callEcho(c.url, { a: 1 })).toBe(200);
      expect(up.seen.map((h) => h["x-key"])).toContain("sekret-value-99");
      const text = readFileSync(join(fx, "recorded", SLUG, "mcp.json"), "utf8");
      expect(countOf(text, "sekret-value-99")).toBe(0);
    });

    it("--mcp-proxy-only forwards and writes nothing, with no --fixtures", async () => {
      const up = await syntheticUpstream();
      const recorded = join(REPO_ROOT, "fixtures", "recorded");
      const before = existsSync(recorded);
      const c = await cli(LLMOCK, ["--mcp-proxy-only", `/mcp=${up.url}`]);
      expect(await callEcho(c.url, { a: 2 })).toBe(200);
      expect(up.seen.length).toBe(1);
      expect(existsSync(recorded)).toBe(before);
    });
  });

  describe("aimock --config llm.record.mcp", () => {
    function config(fx: string, cfg: Record<string, unknown>): string {
      const path = join(fx, "..", `cfg-${createHash("sha1").update(fx).digest("hex")}.json`);
      // llm.record.mcp is read only with llm.enableMcpRecording: true.
      const llm = { enableMcpRecording: true, ...(cfg.llm as Record<string, unknown>) };
      writeFileSync(path, JSON.stringify({ ...cfg, llm }));
      return path;
    }

    it("records into <llm.fixtures>/recorded", async () => {
      const up = await syntheticUpstream();
      const fx = join(tmp("cfg"), "fx");
      mkdirSync(fx);
      const c = await cli(AIMOCK, [
        "--config",
        config(fx, { llm: { fixtures: fx, record: { mcp: { "/mcp": up.url } } } }),
      ]);
      expect(await callEcho(c.url, { via: "config" })).toBe(200);
      const block = blockOf(join(fx, "recorded", SLUG, "mcp.json"));
      expect(entryOf(block, "echo").args).toEqual({ via: "config" });
    });

    it("records through the configured MCP mount at the same path (no second mount)", async () => {
      const up = await syntheticUpstream();
      const fx = join(tmp("cfgmcp"), "fx");
      mkdirSync(fx);
      const c = await cli(AIMOCK, [
        "--config",
        config(fx, {
          llm: { fixtures: fx, record: { mcp: { "/mcp": up.url } } },
          mcp: { path: "/mcp", tools: [{ name: "local", inputSchema: { type: "object" } }] },
        }),
      ]);
      expect(await callEcho(c.url, { via: "configured mount" })).toBe(200);
      expect(up.seen.length).toBe(1);
      expect(countOf(c.stdout(), "MCPMock mounted at /mcp")).toBe(1);
      const block = blockOf(join(fx, "recorded", SLUG, "mcp.json"));
      expect(entryOf(block, "echo").args).toEqual({ via: "configured mount" });
    });

    it("a record path held by an A2A mount fails at start", () => {
      const fx = join(tmp("cfga2a"), "fx");
      mkdirSync(fx);
      const r = runToExit(AIMOCK, [
        "--config",
        config(fx, {
          llm: { fixtures: fx, record: { mcp: { "/a2a": "http://127.0.0.1:9/mcp" } } },
          a2a: { path: "/a2a" },
        }),
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        "llm.record.mcp mount /a2a is held by a mount that is not an MCP mock",
      );
    });

    const UP = "http://127.0.0.1:9/mcp";
    const AUTH = "X-Key: never-echo-this-value";
    it.each<[string, unknown, string]>([
      ["a record that is not an object", UP, "llm.record.mcp must be an object of <mount>"],
      [
        "a mount with no leading /",
        { mcp: { upstream: UP } },
        'llm.record.mcp must be <mount>: <url or object>, with a mount that starts with "/"; got "mcp"',
      ],
      [
        "a null mount value",
        { "/mcp": null },
        'llm.record.mcp mount "/mcp" must be an upstream URL string or an object',
      ],
      [
        "a numeric mount value",
        { "/mcp": 42 },
        'llm.record.mcp mount "/mcp" must be an upstream URL string or an object',
      ],
      [
        "a string proxyOnly",
        { "/mcp": { upstream: UP, proxyOnly: "false" } },
        'llm.record.mcp mount "/mcp" key proxyOnly must be a boolean',
      ],
      [
        "a string strict",
        { "/mcp": { upstream: UP, strict: "false" } },
        'llm.record.mcp mount "/mcp" key strict must be a boolean',
      ],
      [
        "a bad key beside an upstreamAuth",
        { "/mcp": { upstream: UP, upstreamAuth: AUTH, strict: 1 } },
        'llm.record.mcp mount "/mcp" key strict must be a boolean',
      ],
      [
        "a numeric upstreamAuth",
        { "/mcp": { upstream: UP, upstreamAuth: 42 } },
        'llm.record.mcp mount "/mcp" key upstreamAuth must be a string',
      ],
      [
        "a string maxRecordBufferBytes",
        { "/mcp": { upstream: UP, maxRecordBufferBytes: "1024" } },
        'llm.record.mcp mount "/mcp" key maxRecordBufferBytes must be a finite number',
      ],
      [
        "a non-string secretValues entry",
        { "/mcp": { upstream: UP, secretValues: [12345678] } },
        'llm.record.mcp mount "/mcp" key secretValues must be an array of strings',
      ],
      [
        "an unknown key",
        { "/mcp": { upstream: UP, fixturPath: "/nonexistent-typo" } },
        'llm.record.mcp mount "/mcp" has an unknown key "fixturPath"',
      ],
      [
        "no upstream",
        { "/mcp": { proxyOnly: true } },
        'llm.record.mcp mount "/mcp" key upstream is required',
      ],
      ...[null, false, 0, ""].map((mcp): [string, unknown, string] => [
        `a record of ${JSON.stringify(mcp)}`,
        mcp,
        "llm.record.mcp must be an object of <mount>",
      ]),
      [
        "a mount with a trailing /",
        { "/mcp/": UP },
        'llm.record.mcp mount "/mcp/" can never be reached: it must not end with "/"',
      ],
      [
        "a mount with a query",
        { "/mcp?x=1": UP },
        'llm.record.mcp mount "/mcp?x=1" can never be reached: it must be a plain URL path',
      ],
      [
        "a mount with whitespace",
        { "/a b": UP },
        'llm.record.mcp mount "/a b" can never be reached: it must be a plain URL path',
      ],
      [
        "a // mount",
        { "//": UP },
        'llm.record.mcp mount "//" can never be reached: it must not start with "//"',
      ],
      [
        "a string upstream that is not a URL",
        { "/mcp": "not a url" },
        'llm.record.mcp mount "/mcp": the upstream is not a valid URL',
      ],
      [
        "a string upstream that is not http(s)",
        { "/mcp": "ftp://host/mcp" },
        'llm.record.mcp mount "/mcp": the upstream must be an http: or https: URL',
      ],
      [
        "an object upstream that is not a URL",
        { "/mcp": { upstream: "" } },
        'llm.record.mcp mount "/mcp": the upstream is not a valid URL',
      ],
      [
        "a numeric fixturePath",
        { "/mcp": { upstream: UP, fixturePath: 42 } },
        'llm.record.mcp mount "/mcp" key fixturePath must be a non-empty string',
      ],
      [
        "an empty fixturePath",
        { "/mcp": { upstream: UP, fixturePath: "" } },
        'llm.record.mcp mount "/mcp" key fixturePath must be a non-empty string',
      ],
      ...[0, -5, 300 * 1024 * 1024].map((max): [string, unknown, string] => [
        `a maxRecordBufferBytes of ${max}`,
        { "/mcp": { upstream: UP, maxRecordBufferBytes: max } },
        'llm.record.mcp mount "/mcp" key maxRecordBufferBytes must be a finite number greater than 0 and at most 268435456',
      ]),
    ])("F1: %s fails at start, naming the mount and key", (_name, mcp, message) => {
      const fx = join(tmp("cfgbad"), "fx");
      mkdirSync(fx);
      const r = runToExit(AIMOCK, [
        "--config",
        config(fx, { llm: { fixtures: fx, record: { mcp } } }),
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(message);
      expect(r.out).not.toContain("TypeError");
      // S2 (c): never the upstream or its credential.
      expect(r.out).not.toContain(UP);
      expect(r.out).not.toContain(AUTH);
    });

    it.each([42, ""])(
      "R2: an llm.record.fixturePath of %j fails at start, naming the key",
      (fixturePath) => {
        const fx = join(tmp("cfgfp"), "fx");
        mkdirSync(fx);
        const r = runToExit(AIMOCK, [
          "--config",
          config(fx, { llm: { fixtures: fx, record: { fixturePath, mcp: { "/mcp": UP } } } }),
        ]);
        expect(r.status).toBe(1);
        expect(r.out).toContain("llm.record.fixturePath must be a non-empty string");
        expect(r.out).not.toContain("TypeError");
        expect(r.out).not.toContain("paths[0]");
      },
    );

    it.each<[string, Record<string, unknown>, string]>([
      [
        "a credentialed URL as the mount",
        { "http://user:tok3n-secret@host/mcp": "/mcp" },
        'with a mount that starts with "/"; got "http://host/mcp" (credentials removed)',
      ],
      [
        "a credential query in the mount",
        { "/mcp?token=tok3n-secret": UP },
        'llm.record.mcp mount "/mcp" (credentials removed) can never be reached',
      ],
    ])("R2: %s fails at start without printing the credential", (_name, mcp, message) => {
      const fx = join(tmp("cfgcred"), "fx");
      mkdirSync(fx);
      const r = runToExit(AIMOCK, [
        "--config",
        config(fx, { llm: { fixtures: fx, record: { mcp } } }),
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(message);
      expect(r.out).not.toContain("tok3n-secret");
    });

    it("R2: a fixturePath that is a broken symbolic link fails at start, naming the mount and it", () => {
      const dir = tmp("cfgdangling");
      const fx = join(dir, "fx");
      mkdirSync(fx);
      const link = join(dir, "broken");
      symlinkSync(join(dir, "nowhere"), link);
      const r = runToExit(AIMOCK, [
        "--config",
        config(fx, {
          llm: { fixtures: fx, record: { mcp: { "/mcp": { upstream: UP, fixturePath: link } } } },
        }),
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        `llm.record.mcp mount "/mcp": MCP record destination ${link} goes through a broken symbolic link at ${link}`,
      );
    });

    it.skipIf(IS_ROOT)(
      "R2: a fixturePath under a directory it cannot enter fails at start, naming the mount and it",
      () => {
        const dir = tmp("cfgeacces");
        const fx = join(dir, "fx");
        mkdirSync(fx);
        const locked = join(dir, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0);
        const destination = join(locked, "rec");
        try {
          const r = runToExit(AIMOCK, [
            "--config",
            config(fx, {
              llm: {
                fixtures: fx,
                record: { mcp: { "/mcp": { upstream: UP, fixturePath: destination } } },
              },
            }),
          ]);
          expect(r.status).toBe(1);
          expect(r.out).toContain(
            `llm.record.mcp mount "/mcp": MCP record destination ${destination} cannot be checked (EACCES at ${destination})`,
          );
        } finally {
          chmodSync(locked, 0o700);
        }
      },
    );

    it("F2: llm.fixtures that is a file fails at start: the destination is not a directory", () => {
      const dir = tmp("cfgfxfile");
      const fx = join(dir, "fx.json");
      writeFileSync(fx, JSON.stringify({ fixtures: [] }));
      const r = runToExit(AIMOCK, [
        "--config",
        config(fx, { llm: { fixtures: fx, record: { mcp: { "/mcp": UP } } } }),
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(`MCP record destination ${join(fx, "recorded")} is not a directory`);
    });

    it("C10: llm.record with only mcp leaves LLM requests exactly as without record", async () => {
      const fx = join(tmp("c10"), "fx");
      mkdirSync(fx);
      writeFileSync(join(fx, "chat.json"), JSON.stringify(CHAT_FIXTURE));
      const withRecord = await cli(AIMOCK, [
        "--config",
        config(fx, {
          llm: { fixtures: fx, record: { mcp: { "/mcp": "http://127.0.0.1:9/mcp" } } },
        }),
      ]);
      const plainFx = join(tmp("c10plain"), "fx");
      mkdirSync(plainFx);
      writeFileSync(join(plainFx, "chat.json"), JSON.stringify(CHAT_FIXTURE));
      const plain = await cli(AIMOCK, [
        "--config",
        config(plainFx, { llm: { fixtures: plainFx } }),
      ]);

      const chat = (base: string, text: string): Promise<Response> =>
        fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: text }] }),
        });
      const hit = await chat(withRecord.url, "hello");
      expect(hit.status).toBe(200);
      expect(await hit.text()).toContain("hi there");

      const miss = await chat(withRecord.url, "nothing matches this");
      const plainMiss = await chat(plain.url, "nothing matches this");
      expect(miss.status).toBe(plainMiss.status);
      expect(await miss.text()).toBe(await plainMiss.text());

      const ark = await fetch(`${withRecord.url}/api/v3/anything`);
      const plainArk = await fetch(`${plain.url}/api/v3/anything`);
      expect(ark.status).toBe(plainArk.status);
      expect(await ark.text()).toBe(await plainArk.text());
      expect(withRecord.stderr()).not.toContain("byteplus");
      expect(withRecord.stderr()).not.toContain("TypeError");
    });
  });

  // Explicit, not the 5 s default: a CLI start plus a `until` deadline must
  // fit inside the test, or vitest times out before `until` can report.
  describe("--watch with a recorder (MR13)", { timeout: 30_000 }, () => {
    /** A fixture dir with two LLM fixture files under llm/. */
    function watchDir(): string {
      const fx = tmp("watch");
      mkdirSync(join(fx, "llm"));
      writeFileSync(join(fx, "llm", "a.json"), JSON.stringify(CHAT_FIXTURE));
      writeFileSync(
        join(fx, "llm", "b.json"),
        JSON.stringify({
          fixtures: [{ match: { userMessage: "bye" }, response: { content: "see you" } }],
        }),
      );
      return fx;
    }

    /**
     * The CLI prints "listening on" before it arms `fs.watch`; "Watching ..."
     * is printed once the watcher is armed. A file change in between can be
     * lost (no event, no reload), so wait for the armed line first.
     */
    async function watchCli(args: string[]): Promise<CliHandle> {
      const c = await cli(LLMOCK, ["--fixtures", ...args, "--watch"]);
      await until(() => c.stdout().includes("Watching "), 10_000, "the watcher to arm");
      return c;
    }

    async function recorderCli(fx: string): Promise<CliHandle> {
      const up = await syntheticUpstream();
      return watchCli([fx, "--mcp-record", `/mcp=${up.url}`]);
    }

    const RELOADING = "File changed — reloading";
    const REJECTED = "mcp-fakes/watch-reload-changed";

    it("a recording write is not a rejected reload; a second write into the file does not reload", async () => {
      const fx = watchDir();
      const c = await recorderCli(fx);
      const file = join(fx, "recorded", SLUG, "mcp.json");
      expect(await callEcho(c.url, { n: 1 })).toBe(200);
      expect(existsSync(file)).toBe(true);
      await sleep(1500); // the first write may reload once (new directory)
      const mark = c.stdout().length;
      expect(await callEcho(c.url, { n: 2 })).toBe(200);
      expect(blockOf(file).tools[0].calls.length).toBe(2);
      await sleep(2000);
      expect(c.stdout().slice(mark)).not.toContain(RELOADING);
      expect(c.stderr()).not.toContain(REJECTED);
      expect(await callEcho(c.url, { n: 3 })).toBe(200); // still serving
    });

    it("a stray temp file written and deleted at once neither crashes nor logs a stack", async () => {
      const fx = watchDir();
      const c = await recorderCli(fx);
      mkdirSync(join(fx, "recorded"), { recursive: true });
      const stray = join(fx, "recorded", "x.tmp.0a1b-2c3d");
      writeFileSync(stray, "{}");
      unlinkSync(stray);
      await sleep(1500);
      expect(c.stderr()).not.toMatch(/\n\s+at /);
      expect(await callEcho(c.url, { n: 1 })).toBe(200);
    });

    for (const recording of [true, false]) {
      it(`deleting an LLM fixture reloads (${recording ? "with" : "without"} --mcp-record)`, async () => {
        const fx = watchDir();
        const c = recording ? await recorderCli(fx) : await watchCli([fx]);
        unlinkSync(join(fx, "llm", "a.json"));
        await until(() => c.stdout().includes("Reloaded 1 fixture(s)"), 10_000, "the reload");
        expect(c.stdout()).toContain(RELOADING);
      });
    }

    it("after a recording, an LLM fixture edit reloads and is accepted", async () => {
      const fx = watchDir();
      const c = await recorderCli(fx);
      expect(await callEcho(c.url, { n: 1 })).toBe(200);
      await sleep(1500);
      const mark = c.stdout().length;
      writeFileSync(
        join(fx, "llm", "a.json"),
        JSON.stringify({
          fixtures: [
            ...CHAT_FIXTURE.fixtures,
            { match: { userMessage: "again" }, response: { content: "and again" } },
          ],
        }),
      );
      await until(() => c.stdout().slice(mark).includes("Reloaded 3 fixture(s)"), 5000, "reload");
      expect(c.stderr()).not.toContain(REJECTED);
    });

    it("a user edit to the recorded mcpFakes is a rejected reload", async () => {
      const fx = watchDir();
      const c = await recorderCli(fx);
      const file = join(fx, "recorded", SLUG, "mcp.json");
      expect(await callEcho(c.url, { n: 1 })).toBe(200);
      await sleep(1500);
      const text = readFileSync(file, "utf8");
      const edited = text.replace('args {\\"n\\":1}', "edited");
      expect(edited).not.toBe(text);
      writeFileSync(file, edited);
      await until(() => c.stderr().includes(REJECTED), 5000, "the rejection");
    });
  });
});
