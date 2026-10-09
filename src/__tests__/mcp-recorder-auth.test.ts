/**
 * MR14 / S2 (a, b) / AM6: upstream auth in MCP record mode, against a
 * synthetic upstream (`http.createServer`) whose auth answers the test picks.
 * aimock is a real `LLMock` on a real port, driven by raw `fetch`.
 */
import * as http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
import { mcpRecordEnv, parseUpstreamAuth } from "../mcp-recorder.js";
import { TEST_SECRET, startUpstream } from "./mcp-upstream-harness.js";
import type { McpRecordConfig } from "../types.js";

const AUTH_ERROR =
  "aimock MCP recording got an upstream auth failure; OAuth discovery is not supported through the recorder; record with a pre-acquired token via upstreamAuth or the client's Authorization header";

interface Upstream {
  url: string;
  seen: http.IncomingHttpHeaders[];
}

const closers: (() => Promise<unknown>)[] = [];
const lines: string[] = [];
let tmp = "";

beforeEach(() => {
  lines.length = 0;
  tmp = mkdtempSync(join(tmpdir(), "aimock-mcp-auth-"));
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
  delete process.env.AIMOCK_MCP_UPSTREAM_AUTH;
  delete process.env.AIMOCK_RECORD_SECRET_VALUES;
});

/** An upstream answering every request with `status` and `headers`, or an echo of tools/call. */
async function upstream(status = 200, headers: Record<string, string> = {}): Promise<Upstream> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push(req.headers);
      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify({ error: `status ${status}` }));
        return;
      }
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: number;
        params: { arguments?: unknown };
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: `args ${JSON.stringify(msg.params.arguments ?? {})}` }],
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

async function recording(
  url: string,
  extra: Partial<McpRecordConfig> = {},
  llmOptions: ConstructorParameters<typeof LLMock>[0] = {},
): Promise<{ llm: LLMock; base: string }> {
  const llm = new LLMock({ port: 0, logLevel: "warn", ...llmOptions });
  const mcp = new MCPMock();
  mcp.enableRecording({ upstream: url, fixturePath: tmp, ...extra });
  llm.mount("/mcp", mcp);
  const base = await llm.start();
  closers.push(() => llm.stop());
  return { llm, base };
}

const T = "auth › case";
const FILE = (): string => join(tmp, "auth--case", "mcp.json");

async function callEcho(
  base: string,
  headers: Record<string, string> = {},
  args: Record<string, unknown> = { a: 1 },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Test-Id": encodeURIComponent(T),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: args },
    }),
  });
  return { status: res.status, body: JSON.parse(await res.text()) as unknown };
}

describe("MR14: upstream auth failures fail loud", () => {
  const cases: [string, number, Record<string, string>][] = [
    [
      "a 401 with resource_metadata",
      401,
      {
        "WWW-Authenticate":
          'Bearer resource_metadata="https://up.example/.well-known/oauth-protected-resource"',
      },
    ],
    ["a 401 with a plain Bearer", 401, { "WWW-Authenticate": 'Bearer realm="up"' }],
    ["a 401 with no WWW-Authenticate", 401, {}],
    [
      'a 403 with error="insufficient_scope"',
      403,
      { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="tools"' },
    ],
  ];
  for (const [label, status, headers] of cases) {
    it(`${label} gets aimock's 502, writes nothing, journals upstream-auth, logs RL1`, async () => {
      const up = await upstream(status, headers);
      const { base, llm } = await recording(up.url);
      const res = await callEcho(base);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: AUTH_ERROR, upstreamStatus: status });
      expect(existsSync(FILE())).toBe(false);
      const entry = llm.getRequests().find((e) => e.service === "mcp");
      expect(entry?.response.recordSkipped).toBe("upstream-auth");
      expect(entry?.response.status).toBe(502);
      expect(lines.some((l) => l.includes("MCP-RECORD: recording refused (upstream-auth)"))).toBe(
        true,
      );
    });
  }

  it("a GET or DELETE that gets a 401 is also answered 502", async () => {
    const up = await upstream(401);
    const { base } = await recording(up.url);
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${base}/mcp`, { method });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: AUTH_ERROR, upstreamStatus: 401 });
    }
  });

  it("a plain 403 is relayed", async () => {
    const up = await upstream(403, { "WWW-Authenticate": 'Bearer realm="up"' });
    const { base, llm } = await recording(up.url);
    const res = await callEcho(base);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "status 403" });
    expect(existsSync(FILE())).toBe(false);
    expect(llm.getRequests()[0]?.response.recordSkipped).toBe("upstream-status");
  });
});

describe("MR14 / S2: credentials", () => {
  it("S2a: a static Authorization header is forwarded, and the token never reaches the file", async () => {
    const up = await upstream();
    const { base } = await recording(up.url);
    // The upstream echoes the token back in its result: it must be redacted.
    const res = await callEcho(
      base,
      { Authorization: "Bearer abcdefgh12345" },
      { token: "abcdefgh12345" },
    );
    expect(res.status).toBe(200);
    expect(up.seen[0].authorization).toBe("Bearer abcdefgh12345");
    const text = readFileSync(FILE(), "utf8");
    expect(text).not.toContain("abcdefgh12345");
    expect(text).toContain("[REDACTED]");
  });

  it("upstreamAuth replaces the client header, and its value never reaches the file (S2b)", async () => {
    const up = await upstream();
    const { base } = await recording(up.url, { upstreamAuth: "X-Key: sekret-value-99" });
    const res = await callEcho(base, { "X-Key": "client-value-1" }, { k: "sekret-value-99" });
    expect(res.status).toBe(200);
    expect(up.seen[0]["x-key"]).toBe("sekret-value-99");
    const text = readFileSync(FILE(), "utf8");
    expect(text).not.toContain("sekret-value-99");
    expect(text).not.toContain("client-value-1");
  });

  it("AM6: upstreamAuth from AIMOCK_MCP_UPSTREAM_AUTH (parseUpstreamAuth)", async () => {
    process.env.AIMOCK_MCP_UPSTREAM_AUTH = "Authorization: Bearer env-token-123456";
    const parsed = parseUpstreamAuth(process.env.AIMOCK_MCP_UPSTREAM_AUTH);
    expect(parsed).toEqual({ name: "Authorization", value: "Bearer env-token-123456" });
    const up = await upstream();
    const { base } = await recording(up.url, {
      upstreamAuth: `${parsed!.name}: ${parsed!.value}`,
    });
    await callEcho(base, { Authorization: "Bearer client-token-777" });
    expect(up.seen[0].authorization).toBe("Bearer env-token-123456");
  });

  it("AM6: a value without ':' is a start error naming the variable, never the value", () => {
    expect(() => parseUpstreamAuth("no-colon-secret-value")).toThrow(/AIMOCK_MCP_UPSTREAM_AUTH/);
    try {
      parseUpstreamAuth("no-colon-secret-value");
    } catch (err) {
      expect((err as Error).message).not.toContain("no-colon-secret-value");
    }
    expect(parseUpstreamAuth(undefined)).toBeUndefined();
    expect(parseUpstreamAuth("")).toBeUndefined();
    expect(() =>
      new MCPMock().enableRecording({ upstream: "http://x/mcp", upstreamAuth: "bad" }),
    ).toThrow(/upstreamAuth/);
  });

  it("inbound auth on and no upstreamAuth: 502 No configured upstream credential, nothing forwarded", async () => {
    const up = await upstream();
    const { base } = await recording(up.url, {}, { auth: { apiKeys: ["inbound-key-1234"] } });
    const res = await callEcho(base, { Authorization: "Bearer inbound-key-1234" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "No configured upstream credential" });
    expect(up.seen).toEqual([]);
  });

  it("inbound auth on with upstreamAuth: the inbound key is stripped and upstreamAuth is sent", async () => {
    const up = await upstream();
    const { base } = await recording(
      up.url,
      { upstreamAuth: "Authorization: Bearer upstream-cred-999" },
      { auth: { apiKeys: ["inbound-key-1234"] } },
    );
    const res = await callEcho(base, { Authorization: "Bearer inbound-key-1234" });
    expect(res.status).toBe(200);
    expect(up.seen[0].authorization).toBe("Bearer upstream-cred-999");
    expect(readFileSync(FILE(), "utf8")).not.toContain("inbound-key-1234");
  });

  it("a short secretValues entry is a start error", () => {
    expect(() =>
      new MCPMock().enableRecording({ upstream: "http://x/mcp", secretValues: ["short"] }),
    ).toThrow("record.secretValues entry shorter than 8 characters");
  });
});

describe("P01 / P02: the environment on the programmatic path", () => {
  it("mcpRecordEnv splits AIMOCK_RECORD_SECRET_VALUES on LF and CRLF, drops empties, keeps spaces", () => {
    expect(
      mcpRecordEnv({
        AIMOCK_RECORD_SECRET_VALUES: "first-secret-1\r\n\r\n  spaced secret 2 \nthird-secret-3\r\n",
      }).secretValues,
    ).toEqual(["first-secret-1", "  spaced secret 2 ", "third-secret-3"]);
    expect(mcpRecordEnv({}).secretValues).toEqual([]);
  });

  it("enableRecording redacts AIMOCK_RECORD_SECRET_VALUES against the real upstream", async () => {
    process.env.AIMOCK_RECORD_SECRET_VALUES = TEST_SECRET;
    const up = await startUpstream();
    closers.push(() => up.stop());
    const { base } = await recording(up.url);
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Test-Id": encodeURIComponent(T),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "p02", version: "1.0.0" },
        },
      }),
    });
    await res.text();
    const session = res.headers.get("mcp-session-id") ?? "";
    const call = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Test-Id": encodeURIComponent(T),
        "Mcp-Session-Id": session,
        "Mcp-Protocol-Version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get-env", arguments: {} },
      }),
    });
    expect(await call.text()).toContain(TEST_SECRET);
    const text = readFileSync(FILE(), "utf8");
    expect(text.split(TEST_SECRET).length - 1).toBe(0);
    expect(text).toContain("[REDACTED]");
  }, 60_000);

  it("enableRecording sends AIMOCK_MCP_UPSTREAM_AUTH upstream and never writes it", async () => {
    process.env.AIMOCK_MCP_UPSTREAM_AUTH = "X-Key: env-upstream-key-42";
    const up = await upstream();
    const { base } = await recording(up.url);
    const res = await callEcho(base, {}, { k: "env-upstream-key-42" });
    expect(res.status).toBe(200);
    expect(up.seen[0]["x-key"]).toBe("env-upstream-key-42");
    expect(readFileSync(FILE(), "utf8")).not.toContain("env-upstream-key-42");
  });

  it("an explicit config value wins over the environment", async () => {
    process.env.AIMOCK_MCP_UPSTREAM_AUTH = "X-Key: env-upstream-key-42";
    process.env.AIMOCK_RECORD_SECRET_VALUES = "env-only-secret-1";
    const up = await upstream();
    const { base } = await recording(up.url, {
      upstreamAuth: "X-Key: config-key-777",
      secretValues: [],
    });
    await callEcho(base, {}, { s: "env-only-secret-1" });
    expect(up.seen[0]["x-key"]).toBe("config-key-777");
    expect(readFileSync(FILE(), "utf8")).toContain("env-only-secret-1");
  });

  it("a malformed AIMOCK_MCP_UPSTREAM_AUTH is a start error naming the variable", () => {
    process.env.AIMOCK_MCP_UPSTREAM_AUTH = "no-colon-secret-value";
    expect(() => new MCPMock().enableRecording({ upstream: "http://x/mcp" })).toThrow(
      /AIMOCK_MCP_UPSTREAM_AUTH/,
    );
  });
});
