/**
 * MCP fakes: server wiring in `createServerWithResolvedAuth` (spec 5.2 W1 and
 * W3, F2, the mounts-array rule, L4, L5, L8).
 *
 * Real surface: `createServer(...)` listening on a real TCP port, with blocks
 * from the real `loadFixtureFileWithServices`, and a real v1 MCP SDK client
 * (`@modelcontextprotocol/sdk`) talking Streamable HTTP to it. Log lines are
 * read from the real `console` streams the server `Logger` writes to (info on
 * stdout, warn/error on stderr).
 */
import * as net from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer, type ServerInstance } from "../server.js";
import { MCPMock } from "../mcp-mock.js";
import { FixtureLoadError } from "../fixture-loader.js";
import { McpFakesAddError } from "../mcp-fakes.js";
import { msg } from "../message-text.js";
import { loadFixtureFileWithServices } from "../fixture-loader-services.js";
import type { McpFakeSource, Mountable } from "../types.js";
import type { LogLevel } from "../logger.js";
import { connectV1, enc } from "./mcp-fakes-harness.js";

const RETRY_FILE = resolve(__dirname, "fixtures/mcp-fakes/tickets/retry.json");
const RETRY_ID = "tickets › retry on timeout";

function retryFakes(): McpFakeSource[] {
  return loadFixtureFileWithServices(RETRY_FILE).mcpFakes;
}

function sharedBlock(source: string, raw: Record<string, unknown>): McpFakeSource {
  return { source, blockIndex: null, raw: { scope: "shared", ...raw } };
}

const servers: ServerInstance[] = [];
const clients: Client[] = [];
let logSpy: MockInstance<typeof console.log>;
let warnSpy: MockInstance<typeof console.warn>;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) {
    await new Promise<void>((r) => s.server.close(() => r()));
  }
  vi.restoreAllMocks();
});

function lines(spy: MockInstance<(...args: unknown[]) => void>): string[] {
  return spy.mock.calls.map((args) => args.map(String).join(" "));
}

async function start(
  mounts: Array<{ path: string; handler: Mountable }> | undefined,
  mcpFakes: McpFakeSource[],
  logLevel: LogLevel = "info",
): Promise<ServerInstance> {
  const instance = await createServer([], { logLevel, metrics: true }, mounts, {
    search: [],
    rerank: [],
    moderation: [],
    mcpFakes,
  });
  servers.push(instance);
  return instance;
}

async function client(url: string, testId: string): Promise<Client> {
  const c = await connectV1(url, { headers: { "X-Test-Id": enc(testId) } });
  clients.push(c);
  return c;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
}

async function rawUpgrade(url: string, path: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise<string>((res, rej) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\n` +
          "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => (data += d));
    socket.on("close", () => res(data));
    socket.on("error", rej);
  });
}

describe("W3: auto-mount at start, mounts === undefined", () => {
  it("serves the file's fakes at /mcp to a real v1 client", async () => {
    const instance = await start(undefined, retryFakes());
    const c = await client(`${instance.url}/mcp`, RETRY_ID);

    const first = await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain("upstream timeout");
    const second = await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    expect(textOf(second)).toBe("TICKET-42");

    // Journal: the auto-mount was handed the server journal in the mount loop.
    const mcpEntries = instance.journal.getAll().filter((e) => e.path === "/mcp");
    expect(mcpEntries.length).toBeGreaterThan(0);

    // L4 at info, on stdout.
    expect(lines(logSpy).some((l) => l.includes("auto-mounted") && l.includes('"/mcp"'))).toBe(
      true,
    );
  });

  it("mounts-array rule: metric label, /health, setBaseUrl, upgrade", async () => {
    const baseUrls: string[] = [];
    Object.defineProperty(MCPMock.prototype, "setBaseUrl", {
      configurable: true,
      value(url: string) {
        baseUrls.push(url);
      },
    });
    try {
      const instance = await start(undefined, retryFakes());
      // setBaseUrl loop reads the server-owned array.
      expect(baseUrls).toEqual([`${instance.url}/mcp`]);

      const c = await client(`${instance.url}/mcp`, RETRY_ID);
      await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });

      // Metric route label reads the server-owned array.
      const metrics = await (await fetch(`${instance.url}/metrics`)).text();
      expect(metrics).toMatch(/aimock_requests_total\{[^}]*path="\/mcp"/);

      // /health lists the auto-mounted mcp service.
      const health = (await (await fetch(`${instance.url}/health`)).json()) as {
        services?: Record<string, unknown>;
      };
      expect(health.services?.mcp).toMatchObject({ status: "ok" });

      // Upgrade to an unknown path behaves as on a server with no mounts.
      const plain = await createServer([], {});
      servers.push(plain);
      const want = await rawUpgrade(plain.url, "/nope");
      expect(want).toContain("404");
      expect(await rawUpgrade(instance.url, "/nope")).toBe(want);
    } finally {
      delete (MCPMock.prototype as { setBaseUrl?: unknown }).setBaseUrl;
    }
  });

  it("L4 is silent at logLevel silent", async () => {
    const instance = await start(undefined, retryFakes(), "silent");
    const c = await client(`${instance.url}/mcp`, RETRY_ID);
    await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    expect(lines(logSpy).filter((l) => l.includes("auto-mounted"))).toEqual([]);
    expect(lines(warnSpy)).toEqual([]);
  });
});

describe("W1: hand-off to a caller's MCPMock", () => {
  it("delivers the fakes to the mounted MCPMock, no auto-mount, logger set", async () => {
    const mock = new MCPMock();
    const mounts: Array<{ path: string; handler: Mountable }> = [{ path: "/mcp", handler: mock }];
    const instance = await start(mounts, retryFakes());
    expect(mounts).toHaveLength(1);
    expect(mounts[0].handler).toBe(mock);
    expect(lines(logSpy).some((l) => l.includes("auto-mounted"))).toBe(false);

    const c = await client(`${instance.url}/mcp`, RETRY_ID);
    await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    const second = await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    expect(textOf(second)).toBe("TICKET-42");

    // setLogger in the mount loop: an L1 fake failure is logged at error.
    await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } }).catch(() => {});
    expect(lines(errorSpy).some((l) => l.includes("MCP-FAKE"))).toBe(true);
  });

  it("L5: auto-mount at /mcp while an MCPMock is mounted at another path", async () => {
    const other = new MCPMock();
    const mounts: Array<{ path: string; handler: Mountable }> = [
      { path: "/tools", handler: other },
    ];
    const instance = await start(mounts, retryFakes());
    expect(mounts.map((m) => m.path)).toEqual(["/tools", "/mcp"]);
    expect(lines(warnSpy).some((l) => l.includes('"/mcp"') && l.includes('"/tools"'))).toBe(true);
    const c = await client(`${instance.url}/mcp`, RETRY_ID);
    await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    const second = await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    expect(textOf(second)).toBe("TICKET-42");
  });
});

describe("F2: fail-loud hand-off", () => {
  it("a non-MCPMock mount at /mcp rejects start() with mount-conflict", async () => {
    const notMcp: Mountable = { handleRequest: async () => false };
    const err = await start([{ path: "/mcp", handler: notMcp }], retryFakes()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FixtureLoadError);
    const fle = err as FixtureLoadError;
    expect(fle.rule).toBe("mcp-fakes/mount-conflict");
    expect(fle.file).toBe(RETRY_FILE);
    expect(fle.blockId).toBe(RETRY_FILE);
  });

  it("a cross-load entry-id collision rejects start() with bad-block:f", async () => {
    const tool = (id: string) => ({
      tools: [{ name: "t", calls: [{ id, anyArgs: true, result: "r" }] }],
    });
    const err = await start(undefined, [
      sharedBlock("a.json", tool("x:y")),
      sharedBlock("a.json:x", tool("y")),
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FixtureLoadError);
    const fle = err as FixtureLoadError;
    expect(fle.rule).toBe("mcp-fakes/bad-block:f");
    expect(fle.entryId).toBe("a.json:x:y");
  });

  it("two bad blocks reject with one McpFakesAddError holding both", async () => {
    const err = await start(undefined, [
      sharedBlock("one.json", { tools: [{ name: "t", calls: [] }] }),
      sharedBlock("two.json", { tools: [{ name: "t", calls: [] }] }),
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpFakesAddError);
    expect((err as McpFakesAddError).errors).toHaveLength(2);
  });

  it("L8: an add warning is logged at warn on stderr", async () => {
    await start(undefined, [
      sharedBlock("warn.json", {
        tools: [
          {
            name: "t",
            calls: [
              { anyArgs: true, result: "a" },
              { args: { x: 1 }, result: "b" },
            ],
          },
        ],
      }),
    ]);
    expect(lines(warnSpy).some((l) => l.includes("shadowed") && l.includes("warn.json"))).toBe(
      true,
    );
  });
});

/** A TCP port held by another listener, so `listen` on it fails with EADDRINUSE. */
async function heldPort(): Promise<{ port: number; release(): Promise<void> }> {
  const holder = net.createServer();
  await new Promise<void>((r) => holder.listen(0, "127.0.0.1", () => r()));
  const address = holder.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    release: () => new Promise<void>((r) => holder.close(() => r())),
  };
}

describe("A1: a start that fails after the hand-off undoes it", () => {
  it("listen EADDRINUSE: no auto-mount is left on the caller's array; a retry serves each block once", async () => {
    const held = await heldPort();
    const mounts: Array<{ path: string; handler: Mountable }> = [];
    const fakes = retryFakes();
    const options = { logLevel: "silent" as const, port: held.port };
    const service = { search: [], rerank: [], moderation: [], mcpFakes: fakes };
    const err = await createServer([], options, mounts, service).catch((e: unknown) => e);
    expect(String(err)).toContain("EADDRINUSE");
    expect(mounts.map((m) => m.path)).toEqual([]);

    await held.release();
    const instance = await createServer([], options, mounts, service);
    servers.push(instance);
    expect(mounts.map((m) => m.path)).toEqual(["/mcp"]);
    const query = `?testId=${enc(RETRY_ID)}`;
    const listing = (await (await fetch(`${instance.url}/__aimock/mcp/fakes${query}`)).json()) as {
      mounts: Array<{ mount: string; blocks: Array<{ blockId: string }> }>;
    };
    expect(listing.mounts.map((m) => [m.mount, m.blocks.map((b) => b.blockId)])).toEqual([
      ["/mcp", [RETRY_FILE]],
    ]);
  });

  it("listen EADDRINUSE: a caller's MCPMock keeps none of the blocks; a retry loads them once", async () => {
    const held = await heldPort();
    const mock = new MCPMock();
    const mounts: Array<{ path: string; handler: Mountable }> = [{ path: "/mcp", handler: mock }];
    const options = { logLevel: "silent" as const, port: held.port };
    const service = { search: [], rerank: [], moderation: [], mcpFakes: retryFakes() };
    const err = await createServer([], options, mounts, service).catch((e: unknown) => e);
    expect(String(err)).toContain("EADDRINUSE");
    expect(mock.fakesSnapshot(RETRY_ID, null)).toEqual([]);

    await held.release();
    servers.push(await createServer([], options, mounts, service));
    expect(mock.fakesSnapshot(RETRY_ID, null).map((b) => b.blockId)).toEqual([RETRY_FILE]);
  });

  it("a config guard throw after the hand-off leaves the caller's array and MCPMock unchanged", async () => {
    const mock = new MCPMock();
    const mounts: Array<{ path: string; handler: Mountable }> = [{ path: "/tools", handler: mock }];
    const both: McpFakeSource[] = [
      ...retryFakes(),
      sharedBlock("tools.json", {
        mount: "/tools",
        tools: [{ name: "t", calls: [{ anyArgs: true, result: "r" }] }],
      }),
    ];
    const err = await createServer(
      [],
      {
        logLevel: "silent",
        record: { providers: { byteplus: "https://ark.example.com/api/v3" } },
      },
      mounts,
      { search: [], rerank: [], moderation: [], mcpFakes: both },
    ).catch((e: unknown) => e);
    expect(String(err)).toContain("/api/v3");
    expect(mounts.map((m) => m.path)).toEqual(["/tools"]);
    expect(mock.fakesSnapshot(null, null)).toEqual([]);
  });
});

describe("A1: an add to an existing mount that fails once the server listens", () => {
  it("rejects start(), closes the server and takes the auto-mounts back", async () => {
    const refusal = new McpFakesAddError(
      [
        new FixtureLoadError({
          rule: "mcp-fakes/bad-block:f",
          file: "strict.json",
          blockId: "strict.json",
          entryId: null,
          detail: msg`refused by the mount`,
        }),
      ],
      [],
    );
    const strict: Mountable = {
      handleRequest: async () => false,
      addMcpFakes: () => {
        throw refusal;
      },
    };
    const mounts: Array<{ path: string; handler: Mountable }> = [
      { path: "/strict", handler: strict },
    ];
    const held = await heldPort();
    await held.release();
    const err = await createServer([], { logLevel: "silent", port: held.port }, mounts, {
      search: [],
      rerank: [],
      moderation: [],
      mcpFakes: [
        ...retryFakes(),
        sharedBlock("strict.json", {
          mount: "/strict",
          tools: [{ name: "t", calls: [{ anyArgs: true, result: "r" }] }],
        }),
      ],
    }).catch((e: unknown) => e);
    expect(err).toBe(refusal);
    expect(mounts.map((m) => m.path)).toEqual(["/strict"]);
    // The server was closed: its port can be listened on again.
    const again = net.createServer();
    await new Promise<void>((r, j) => {
      again.once("error", j);
      again.listen(held.port, "127.0.0.1", () => r());
    });
    await new Promise<void>((r) => again.close(() => r()));
  });
});

describe("A5: a block mount path no request can reach is rejected", () => {
  const block = (mount: string): McpFakeSource =>
    sharedBlock("unreachable.json", {
      mount,
      tools: [{ name: "t", calls: [{ anyArgs: true, result: "r" }] }],
    });

  it("a trailing-slash variant of a mounted MCPMock path rejects start() with mount-conflict", async () => {
    const mock = new MCPMock();
    const mounts: Array<{ path: string; handler: Mountable }> = [{ path: "/mcp", handler: mock }];
    const err = await start(mounts, [block("/mcp/")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FixtureLoadError);
    expect((err as FixtureLoadError).rule).toBe("mcp-fakes/mount-conflict");
    expect(mounts.map((m) => m.path)).toEqual(["/mcp"]);
    expect(mock.fakesSnapshot(null, null)).toEqual([]);
  });

  it("a trailing-slash variant of a path auto-mounted by the same load is rejected", async () => {
    const err = await start(undefined, [block("/mcp"), block("/mcp/")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FixtureLoadError);
    expect((err as FixtureLoadError).rule).toBe("mcp-fakes/mount-conflict");
  });

  it.each(["/__aimock", "/__aimock/mcp", "/__aimockx"])(
    "a path under the control prefix (%s) rejects start() with mount-conflict",
    async (mount) => {
      const mounts: Array<{ path: string; handler: Mountable }> = [];
      const err = await start(mounts, [block(mount)]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FixtureLoadError);
      expect((err as FixtureLoadError).rule).toBe("mcp-fakes/mount-conflict");
      expect(mounts).toEqual([]);
    },
  );

  it("positive control: a sub-path of a mounted MCPMock is reachable and auto-mounted", async () => {
    const mounts: Array<{ path: string; handler: Mountable }> = [
      { path: "/mcp", handler: new MCPMock() },
    ];
    await start(mounts, [block("/mcp/sub")]);
    expect(mounts.map((m) => m.path)).toEqual(["/mcp", "/mcp/sub"]);
  });
});
