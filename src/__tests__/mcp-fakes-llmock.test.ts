/**
 * MCP fakes through `LLMock` (spec F4, W2, W3 from LLMock, W4 + L6, W6, R4,
 * R5, R6) and the `aimock --config` path (W1).
 *
 * Real surface: an `LLMock` listening on a real TCP port and a real v1 MCP
 * SDK client (`@modelcontextprotocol/sdk`) over Streamable HTTP; the W1 tests
 * spawn the built `aimock` bin (`node dist/aimock-cli.js --config`). Log lines
 * are read from the real `console` streams the server `Logger` writes to
 * (info on stdout, warn/error on stderr).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
import { FixtureLoadError } from "../fixture-loader.js";
import type { JournalEntry, MockServerOptions, Mountable } from "../types.js";
import {
  type CliHandle,
  REPO_ROOT,
  connectV1,
  enc,
  expectMcpError,
  startCli,
} from "./mcp-fakes-harness.js";

const FIXTURE_DIR = resolve(__dirname, "fixtures/mcp-fakes");
const RETRY_FILE = resolve(FIXTURE_DIR, "tickets/retry.json");
const RETRY_ID = "tickets › retry on timeout";
const REFUND = { title: "Refund" };

const mocks: LLMock[] = [];
const standalone: MCPMock[] = [];
const clients: Client[] = [];
let tmpDir: string;
let logSpy: MockInstance<typeof console.log>;
let warnSpy: MockInstance<typeof console.warn>;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "aimock-mcp-fakes-llmock-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const m of mocks.splice(0)) await m.stop().catch(() => {});
  for (const m of standalone.splice(0)) await m.stop().catch(() => {});
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

function lines(spy: MockInstance<(...args: unknown[]) => void>): string[] {
  return spy.mock.calls.map((args) => args.map(String).join(" "));
}

function autoMountLines(): string[] {
  return lines(logSpy).filter((l) => l.includes("auto-mounted"));
}

function newMock(options: MockServerOptions = {}): LLMock {
  const llm = new LLMock({ port: 0, logLevel: "info", metrics: true, ...options });
  mocks.push(llm);
  return llm;
}

async function client(url: string, testId?: string): Promise<Client> {
  const c = await connectV1(
    url,
    testId === undefined ? {} : { headers: { "X-Test-Id": enc(testId) } },
  );
  clients.push(c);
  return c;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
}

function writeJson(name: string, value: unknown): string {
  const path = join(tmpDir, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** A shared block whose tool answers `results` in order, for any arguments. */
function sharedBlock(tool: string, results: string[], extra: Record<string, unknown> = {}) {
  return {
    scope: "shared",
    ...extra,
    tools: [{ name: tool, calls: results.map((r) => ({ anyArgs: true, result: r })) }],
  };
}

const LLM_FIXTURE = { match: { userMessage: "hello" }, response: { content: "Hi!" } };

async function fakesListing(
  url: string,
  testId?: string,
): Promise<Array<{ mount: string; blocks: Array<{ blockId: string }> }>> {
  const query = testId === undefined ? "" : `?testId=${enc(testId)}`;
  const res = await fetch(`${url}/__aimock/mcp/fakes${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    mounts: Array<{ mount: string; blocks: Array<{ blockId: string }> }>;
  };
  return body.mounts;
}

async function expectRetrySequence(c: Client): Promise<void> {
  const first = await c.callTool({ name: "create_ticket", arguments: REFUND });
  expect(first.isError).toBe(true);
  expect(textOf(first)).toContain("upstream timeout");
  const second = await c.callTool({ name: "create_ticket", arguments: REFUND });
  expect(textOf(second)).toBe("TICKET-42");
}

function captureLoadError(load: () => unknown): FixtureLoadError {
  let caught: unknown;
  try {
    load();
  } catch (err) {
    caught = err;
  }
  expect(caught, "the load must throw").toBeInstanceOf(FixtureLoadError);
  return caught as FixtureLoadError;
}

describe("W2 + W3 from LLMock: fakes loaded before start", () => {
  it("loadFixtureFile buffers the fakes; start auto-mounts them at /mcp; resetMatchCounts restarts the sequence", async () => {
    const llm = newMock();
    llm.loadFixtureFile(RETRY_FILE);
    expect(llm.getFixtures()).toHaveLength(1);
    const url = await llm.start();

    const c = await client(`${url}/mcp`, RETRY_ID);
    await expectRetrySequence(c);
    await expectMcpError(c.callTool({ name: "create_ticket", arguments: REFUND }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });

    llm.resetMatchCounts();
    await expectRetrySequence(c);

    // L4 at info on stdout: the auto-mount at start.
    expect(autoMountLines().some((l) => l.includes('"/mcp"'))).toBe(true);
    // Journal (W3 wiring): the entry id carries the file path as given (I6).
    const ids = llm
      .getRequests()
      .map((e: JournalEntry) => e.response.mcpFake?.id)
      .filter((id): id is string => typeof id === "string");
    expect(ids).toContain(`${RETRY_FILE}:first-try`);
  });

  it("loadFixtureDir carries the fakes with sources relative to the directory", async () => {
    const llm = newMock();
    llm.loadFixtureDir(FIXTURE_DIR);
    const url = await llm.start();
    // The directory also holds the docs-sample files, whose blocks go to other
    // test ids and other mounts (multi/travel.json); only retry.json applies.
    const listing = (await fakesListing(url, RETRY_ID)).filter((m) => m.blocks.length > 0);
    expect(listing).toHaveLength(1);
    expect(listing[0].mount).toBe("/mcp");
    expect(listing[0].blocks.map((b) => b.blockId)).toEqual(["tickets/retry.json"]);

    const c = await client(`${url}/mcp`, RETRY_ID);
    await expectRetrySequence(c);
  });

  it("W2: a mount added before start receives the fakes; nothing is auto-mounted", async () => {
    const llm = newMock();
    const mcp = new MCPMock();
    llm.mount("/mcp", mcp);
    llm.loadFixtureFile(RETRY_FILE);
    const url = await llm.start();

    expect(mcp.fakesSnapshot(RETRY_ID).map((b) => b.blockId)).toEqual([RETRY_FILE]);
    const c = await client(`${url}/mcp`, RETRY_ID);
    await expectRetrySequence(c);
    expect(autoMountLines()).toEqual([]);
  });

  it("a fakes-only file is accepted and adds no LLM fixture", async () => {
    const file = writeJson("only.json", { mcpFakes: sharedBlock("ping", ["pong"]) });
    const llm = newMock();
    llm.loadFixtureFile(file);
    expect(llm.getFixtures()).toHaveLength(0);
    const url = await llm.start();
    const c = await client(`${url}/mcp`);
    expect(textOf(await c.callTool({ name: "ping", arguments: {} }))).toBe("pong");
  });
});

describe("F4: a bad block fails the load and adds nothing", () => {
  it("before start: a block-level case throws with rule, file and blockId; nothing is buffered", async () => {
    const file = writeJson("bad.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: { tools: [{ name: "t", calls: [{ result: "x" }] }] },
    });
    const llm = newMock();
    const err = captureLoadError(() => llm.loadFixtureFile(file));
    expect(err.rule).toBe("mcp-fakes/bad-block:a");
    expect(err.file).toBe(file);
    expect(err.blockId).toBe(file);
    expect(err.entryId ?? null).toBeNull();
    expect(llm.getFixtures()).toHaveLength(0);

    const url = await llm.start();
    expect(await fakesListing(url)).toEqual([]);
    expect(autoMountLines()).toEqual([]);
  });

  it("before start: an entry-level case names the entry", () => {
    writeJson("bad-entry.json", {
      mcpFakes: { scope: "shared", tools: [{ name: "t", calls: [{ anyArgs: false }] }] },
    });
    const llm = newMock();
    const err = captureLoadError(() => llm.loadFixtureDir(tmpDir));
    expect(err.rule).toBe("mcp-fakes/bad-block:j");
    expect(err.file).toBe("bad-entry.json");
    expect(err.blockId).toBe("bad-entry.json");
    expect(err.entryId).toBe("bad-entry.json:t#0");
    expect(llm.getFixtures()).toHaveLength(0);
  });

  it("5.4 fail-loud under logLevel silent: loadFixtureFile still throws, before and after start", async () => {
    const bad = {
      fixtures: [LLM_FIXTURE],
      mcpFakes: {
        scope: "shared",
        undeclaredTools: "deny",
        tools: [{ name: "t", calls: [{ anyArgs: true, result: "x" }] }],
      },
    };
    const llm = newMock({ logLevel: "silent" });
    const before = captureLoadError(() => llm.loadFixtureFile(writeJson("before.json", bad)));
    expect(before.rule).toBe("mcp-fakes/bad-block:c");
    expect(llm.getFixtures()).toHaveLength(0);

    const url = await llm.start();
    const after = captureLoadError(() => llm.loadFixtureFile(writeJson("after.json", bad)));
    expect(after.rule).toBe("mcp-fakes/bad-block:c");
    expect(llm.getFixtures()).toHaveLength(0);
    expect(await fakesListing(url)).toEqual([]);
  });

  it("after start: a bad block throws and adds neither fakes nor LLM fixtures", async () => {
    const llm = newMock();
    const url = await llm.start();
    const file = writeJson("bad.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: { scope: "shared", tools: [] },
    });
    const err = captureLoadError(() => llm.loadFixtureFile(file));
    expect(err.rule).toBe("mcp-fakes/bad-block:g");
    expect(err.file).toBe(file);
    expect(err.blockId).toBe(file);
    expect(llm.getFixtures()).toHaveLength(0);
    expect(await fakesListing(url)).toEqual([]);
    expect(autoMountLines()).toEqual([]);
  });

  it("after start: an entry-id collision with a loaded block throws (f) and adds nothing", async () => {
    const first = writeJson("a.json", {
      mcpFakes: {
        scope: "shared",
        tools: [{ name: "t", calls: [{ id: "x:y", anyArgs: true, result: "one" }] }],
      },
    });
    const second = writeJson("a.json:x", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: {
        scope: "shared",
        tools: [{ name: "u", calls: [{ id: "y", anyArgs: true, result: "two" }] }],
      },
    });
    const llm = newMock();
    const url = await llm.start();
    llm.loadFixtureFile(first);
    const err = captureLoadError(() => llm.loadFixtureFile(second));
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(err.file).toBe(second);
    expect(err.blockId).toBe(second);
    expect(err.entryId).toBe(`${first}:x:y`);
    expect(llm.getFixtures()).toHaveLength(0);
    const listing = await fakesListing(url);
    expect(listing.flatMap((m) => m.blocks.map((b) => b.blockId))).toEqual([first]);
  });

  it("after start: a block whose mount path is held by a non-MCP mount is a mount conflict", async () => {
    const plain: Mountable = { handleRequest: async () => false };
    const llm = newMock();
    const url = await llm.start();
    llm.mount("/plain", plain);
    const file = writeJson("conflict.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: sharedBlock("t", ["x"], { mount: "/plain" }),
    });
    const err = captureLoadError(() => llm.loadFixtureFile(file));
    expect(err.rule).toBe("mcp-fakes/mount-conflict");
    expect(err.file).toBe(file);
    expect(err.blockId).toBe(file);
    expect(llm.getFixtures()).toHaveLength(0);
    expect(await fakesListing(url)).toEqual([]);
  });

  it("a cross-file collision with buffered fakes fails the later load, before start (F2, F4)", async () => {
    const first = writeJson("a.json", {
      mcpFakes: {
        scope: "shared",
        tools: [{ name: "t", calls: [{ id: "x:y", anyArgs: true, result: "one" }] }],
      },
    });
    const second = writeJson("a.json:x", {
      mcpFakes: {
        scope: "shared",
        tools: [{ name: "u", calls: [{ id: "y", anyArgs: true, result: "two" }] }],
      },
    });
    const llm = newMock();
    llm.loadFixtureFile(first);
    const err = captureLoadError(() => llm.loadFixtureFile(second));
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
  });

  it("start rejects when a mount added after the load conflicts with buffered fakes (F2)", async () => {
    const file = writeJson("late.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: sharedBlock("t", ["x"], { mount: "/plain" }),
    });
    const llm = newMock();
    llm.loadFixtureFile(file);
    llm.mount("/plain", { handleRequest: async () => false });
    const rejected = await llm.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect(rejected).toBeInstanceOf(FixtureLoadError);
    expect((rejected as FixtureLoadError).rule).toBe("mcp-fakes/mount-conflict");
  });
});

describe("W6: fakes loaded after start", () => {
  it("auto-mounts at /mcp with journal, metric and the L1 log", async () => {
    const llm = newMock();
    const url = await llm.start();
    expect(autoMountLines()).toEqual([]);
    llm.loadFixtureFile(RETRY_FILE);
    expect(autoMountLines().some((l) => l.includes('"/mcp"'))).toBe(true);
    expect(llm.getFixtures()).toHaveLength(1);

    const c = await client(`${url}/mcp`, RETRY_ID);
    await expectRetrySequence(c);
    await expectMcpError(c.callTool({ name: "create_ticket", arguments: { title: "Other" } }), {
      code: -32602,
      aimockCode: "MCP_FAKE_MISMATCH",
    });

    const outcomes = llm.getRequests().map((e) => e.response.mcpFake?.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(["answered", "mismatch"]));
    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_MISMATCH"\} 1/);
    expect(lines(errorSpy).some((l) => l.includes("MCP-FAKE: mismatch"))).toBe(true);
  });

  it("adds to the MCPMock already mounted at the path; the L8 warning is logged", async () => {
    const mcp = new MCPMock();
    const llm = newMock();
    llm.mount("/mcp", mcp);
    const url = await llm.start();
    const file = writeJson("shadowed.json", {
      mcpFakes: {
        scope: "shared",
        tools: [
          {
            name: "t",
            calls: [
              { anyArgs: true, result: "any" },
              { args: { a: 1 }, result: "exact" },
            ],
          },
        ],
      },
    });
    llm.loadFixtureFile(file);
    expect(mcp.fakesSnapshot().map((b) => b.blockId)).toEqual([file]);
    expect(autoMountLines()).toEqual([]);
    expect(lines(warnSpy).some((l) => l.includes("is shadowed until"))).toBe(true);
    const c = await client(`${url}/mcp`);
    expect(textOf(await c.callTool({ name: "t", arguments: { a: 1 } }))).toBe("any");
  });
});

describe("W4: LLMock.mount() after start", () => {
  it("wires the server logger (L1 from a late mount)", async () => {
    const llm = newMock();
    const url = await llm.start();
    const late = new MCPMock();
    llm.mount("/late", late);
    late.loadFakes(sharedBlock("t", ["one"]));
    const c = await client(`${url}/late`);
    expect(textOf(await c.callTool({ name: "t", arguments: {} }))).toBe("one");
    await expectMcpError(c.callTool({ name: "t", arguments: {} }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });
    expect(
      lines(errorSpy).some((l) => l.includes("MCP-FAKE: exhausted") && l.includes("/late")),
    ).toBe(true);
  });

  it("wires the metric registry (a late mount's fake failure is counted on /metrics)", async () => {
    const llm = newMock();
    const url = await llm.start();
    const late = new MCPMock();
    llm.mount("/late", late);
    late.loadFakes({
      scope: "shared",
      tools: [{ name: "t", calls: [{ args: { a: 1 }, result: "one" }] }],
    });
    const c = await client(`${url}/late`);
    await expectMcpError(c.callTool({ name: "t", arguments: { a: 2 } }), {
      code: -32602,
      aimockCode: "MCP_FAKE_MISMATCH",
    });
    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_MISMATCH"\} 1/);
  });

  it("logs L6 when an auto-mounted MCPMock already serves the path; the auto-mount keeps answering", async () => {
    const llm = newMock();
    llm.loadFixtureFile(RETRY_FILE);
    const url = await llm.start();
    llm.mount("/elsewhere", new MCPMock());
    const l6 = () => lines(warnSpy).filter((l) => l.includes("shadowed by"));
    expect(l6()).toEqual([]);

    const late = new MCPMock();
    late.loadFakes(sharedBlock("create_ticket", ["from-late-mount"]));
    llm.mount("/mcp", late);
    expect(l6()).toHaveLength(1);
    expect(l6()[0]).toContain('"/mcp"');

    const c = await client(`${url}/mcp`, RETRY_ID);
    await expectRetrySequence(c);
  });
});

describe("R4 / R5: reset() and clearFixtures() unload fakes", () => {
  for (const door of ["reset", "clearFixtures"] as const) {
    it(`${door}() before start clears the buffer and each mount's fakes; counters are kept`, async () => {
      const llm = newMock();
      const mcp = new MCPMock();
      llm.mount("/code", mcp);
      mcp.loadFakes(sharedBlock("t", ["x"]));
      llm.loadFixtureFile(RETRY_FILE);

      llm[door]();
      expect(llm.getFixtures()).toHaveLength(0);
      expect(mcp.fakesSnapshot()).toEqual([]);

      // Counters kept: the next run-time addition is code#2, not code#1.
      mcp.loadFakes(sharedBlock("t", ["y"]));
      expect(mcp.fakesSnapshot().map((b) => b.blockId)).toEqual(["code#2"]);

      const url = await llm.start();
      // Buffer cleared: no auto-mount at /mcp at start.
      expect(autoMountLines()).toEqual([]);
      expect((await fakesListing(url)).map((m) => m.mount)).toEqual(["/code"]);
    });

    it(`${door}() after start clears fakes on every mount, including the auto-mount; sessions are kept`, async () => {
      const llm = newMock({ fixtureCountsMaxTestIds: 2 });
      const file = writeJson("shared.json", { mcpFakes: sharedBlock("t", ["one", "two"]) });
      llm.loadFixtureFile(file);
      const url = await llm.start();

      // Evict T1 (cap 2): T1, T2, T3, then T1 again is evicted.
      const byId = new Map<string, Client>();
      for (const id of ["T1", "T2", "T3"]) {
        const c = await client(`${url}/mcp`, id);
        byId.set(id, c);
        expect(textOf(await c.callTool({ name: "t", arguments: {} }))).toBe("one");
      }
      const t1 = byId.get("T1")!;
      await expectMcpError(t1.callTool({ name: "t", arguments: {} }), {
        code: -31011,
        aimockCode: "MCP_FAKE_EVICTED",
      });

      llm[door]();
      expect(llm.getFixtures()).toHaveLength(0);
      const listing = await fakesListing(url);
      expect(listing.flatMap((m) => m.blocks)).toEqual([]);

      // The session survived the reset: the same client keeps working, and
      // with the fakes gone the tool is no longer declared.
      const after = await t1.callTool({ name: "t", arguments: {} }).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      expect(String(after.ok ? textOf(after.r) : after.e)).not.toMatch(/session/i);

      // Reload: the evicted mark was cleared, so T1 is answered from entry 0.
      llm.loadFixtureFile(file);
      expect(textOf(await t1.callTool({ name: "t", arguments: {} }))).toBe("one");
    });
  }
});

describe("R6: resetMatchCounts(testId?) resets fake consumption only", () => {
  it("before start: resets the consumption state of each mount; fakes and buffer are kept", async () => {
    const mcp = new MCPMock();
    standalone.push(mcp);
    mcp.loadFakes(sharedBlock("t", ["one", "two"]));
    const standaloneUrl = await mcp.start();
    const direct = await client(standaloneUrl);
    expect(textOf(await direct.callTool({ name: "t", arguments: {} }))).toBe("one");

    const llm = newMock();
    llm.mount("/code", mcp);
    llm.loadFixtureFile(RETRY_FILE);
    llm.resetMatchCounts();
    expect(llm.getFixtures()).toHaveLength(1);
    expect(mcp.fakesSnapshot().map((b) => b.blockId)).toEqual(["code#1"]);
    // Consumption rewound: entry 0 again.
    expect(textOf(await direct.callTool({ name: "t", arguments: {} }))).toBe("one");

    // Buffer kept: the file's fakes are auto-mounted at start.
    const url = await llm.start();
    const c = await client(`${url}/mcp`, RETRY_ID);
    await expectRetrySequence(c);
  });

  it("after start with a test id: only that id restarts; without one, all restart", async () => {
    const llm = newMock();
    const file = writeJson("shared.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: sharedBlock("t", ["one", "two", "three"]),
    });
    llm.loadFixtureFile(file);
    const url = await llm.start();
    const a = await client(`${url}/mcp`, "A");
    const b = await client(`${url}/mcp`, "B");
    expect(textOf(await a.callTool({ name: "t", arguments: {} }))).toBe("one");
    expect(textOf(await b.callTool({ name: "t", arguments: {} }))).toBe("one");

    llm.resetMatchCounts("A");
    expect(textOf(await a.callTool({ name: "t", arguments: {} }))).toBe("one");
    expect(textOf(await b.callTool({ name: "t", arguments: {} }))).toBe("two");

    llm.resetMatchCounts();
    expect(textOf(await a.callTool({ name: "t", arguments: {} }))).toBe("one");
    expect(textOf(await b.callTool({ name: "t", arguments: {} }))).toBe("one");

    // LLM fixtures and fakes are kept.
    expect(llm.getFixtures()).toHaveLength(1);
    expect((await fakesListing(url)).flatMap((m) => m.blocks.map((x) => x.blockId))).toEqual([
      file,
    ]);
  });

  it("after start: the evicted mark clears only for the reset test id", async () => {
    const llm = newMock({ fixtureCountsMaxTestIds: 2 });
    llm.loadFixtureFile(writeJson("shared.json", { mcpFakes: sharedBlock("t", ["one", "two"]) }));
    const url = await llm.start();
    const byId = new Map<string, Client>();
    for (const id of ["T1", "T2", "T3", "T4"]) {
      const c = await client(`${url}/mcp`, id);
      byId.set(id, c);
      expect(textOf(await c.callTool({ name: "t", arguments: {} }))).toBe("one");
    }
    const evicted = { code: -31011, aimockCode: "MCP_FAKE_EVICTED" };
    await expectMcpError(byId.get("T1")!.callTool({ name: "t", arguments: {} }), evicted);
    await expectMcpError(byId.get("T2")!.callTool({ name: "t", arguments: {} }), evicted);

    llm.resetMatchCounts("T1");
    expect(textOf(await byId.get("T1")!.callTool({ name: "t", arguments: {} }))).toBe("one");
    await expectMcpError(byId.get("T2")!.callTool({ name: "t", arguments: {} }), evicted);
  });
});

// ---- W1: the real `aimock --config` process ----

const AIMOCK_CLI = resolve(REPO_ROOT, "dist/aimock-cli.js");
const AIMOCK_CLI_AVAILABLE = existsSync(AIMOCK_CLI);

describe.skipIf(!AIMOCK_CLI_AVAILABLE)("W1: aimock --config with an mcp section", () => {
  let cli: CliHandle | undefined;

  beforeEach(() => {
    for (const src of ["src/llmock.ts", "src/config-loader.ts", "src/aimock-cli.ts"]) {
      if (statSync(AIMOCK_CLI).mtimeMs < statSync(resolve(REPO_ROOT, src)).mtimeMs) {
        throw new Error(
          `dist/aimock-cli.js was built before ${src} was last edited — run \`pnpm build\`.`,
        );
      }
    }
  });

  afterEach(async () => {
    await cli?.stop();
    cli = undefined;
  });

  function writeConfig(withMcp: boolean): string {
    return writeJson("cfg.json", {
      llm: { fixtures: RETRY_FILE, logLevel: "info" },
      metrics: true,
      ...(withMcp
        ? {
            mcp: {
              path: "/mcp",
              tools: [{ name: "lookup", description: "config tool", result: "from-config" }],
            },
          }
        : {}),
    });
  }

  it("the config's MCPMock serves the fakes: no auto-mount, mismatch journaled, counted and logged", async () => {
    cli = await startCli(["--config", writeConfig(true)], "dist/aimock-cli.js");
    const c = await client(`${cli.url}/mcp`, RETRY_ID);
    await expectRetrySequence(c);
    // The config tool is still served by the same MCPMock.
    expect(textOf(await c.callTool({ name: "lookup", arguments: {} }))).toBe("from-config");
    await expectMcpError(c.callTool({ name: "create_ticket", arguments: { title: "Other" } }), {
      code: -32602,
      aimockCode: "MCP_FAKE_MISMATCH",
    });

    expect(cli.stdout()).not.toContain("auto-mounted");

    const journal = (await (
      await fetch(`${cli.url}/__aimock/journal?testId=${enc(RETRY_ID)}`)
    ).json()) as JournalEntry[];
    const outcomes = journal.map((e) => e.response.mcpFake?.outcome).filter(Boolean);
    expect(outcomes).toEqual(["answered", "answered", "mismatch"]);

    const metrics = await (await fetch(`${cli.url}/metrics`)).text();
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_MISMATCH"\} 1/);
    expect(cli.stderr()).toContain("MCP-FAKE: mismatch for tools/call create_ticket");
  });

  it("positive control: without an mcp section the fakes are auto-mounted and L4 is on stdout", async () => {
    cli = await startCli(["--config", writeConfig(false)], "dist/aimock-cli.js");
    const c = await client(`${cli.url}/mcp`, RETRY_ID);
    await expectRetrySequence(c);
    expect(cli.stdout()).toContain('auto-mounted an MCP mock at "/mcp"');
  });
});

describe("A1: LLMock.start() that fails after the hand-off", () => {
  it("listen EADDRINUSE, then a retry: each block loads once and the auto-mount is tracked (L6)", async () => {
    const net = await import("node:net");
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", () => r()));
    const address = holder.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const llm = newMock({ port: address.port });
    llm.loadFixtureFile(RETRY_FILE);
    const err = await llm.start().catch((e: unknown) => e);
    expect(String(err)).toContain("EADDRINUSE");

    await new Promise<void>((r) => holder.close(() => r()));
    const url = await llm.start();
    const listing = await fakesListing(url, RETRY_ID);
    expect(listing.map((m) => [m.mount, m.blocks.map((b) => b.blockId)])).toEqual([
      ["/mcp", [RETRY_FILE]],
    ]);

    llm.mount("/mcp", new MCPMock());
    expect(lines(warnSpy).filter((l) => l.includes("shadowed by"))).toHaveLength(1);
    const c = await client(`${url}/mcp`, RETRY_ID);
    await expectRetrySequence(c);
  });
});

describe("A3: before start, a file whose fakes are rejected adds no LLM fixture", () => {
  it("a mount conflict with a mount added before the load", () => {
    const llm = newMock();
    llm.mount("/plain", { handleRequest: async () => false });
    const file = writeJson("conflict.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: sharedBlock("t", ["x"], { mount: "/plain" }),
    });
    const err = captureLoadError(() => llm.loadFixtureFile(file));
    expect(err.rule).toBe("mcp-fakes/mount-conflict");
    expect(llm.getFixtures()).toHaveLength(0);
  });

  it("an entry-id collision with a file loaded earlier: the later file adds nothing", async () => {
    const first = writeJson("a.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: {
        scope: "shared",
        tools: [{ name: "t", calls: [{ id: "x:y", anyArgs: true, result: "one" }] }],
      },
    });
    const second = writeJson("a.json:x", {
      fixtures: [{ match: { userMessage: "second" }, response: { content: "2" } }],
      mcpFakes: {
        scope: "shared",
        tools: [{ name: "u", calls: [{ id: "y", anyArgs: true, result: "two" }] }],
      },
    });
    const llm = newMock();
    llm.loadFixtureFile(first);
    const err = captureLoadError(() => llm.loadFixtureFile(second));
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(llm.getFixtures()).toHaveLength(1);

    // The first file is intact: start serves its one block.
    const url = await llm.start();
    expect((await fakesListing(url)).map((m) => m.blocks.map((b) => b.blockId))).toEqual([[first]]);
  });
});

describe("A4: the L6 shadow warning", () => {
  it("is not logged for a sub-path of an auto-mount, which the auto-mount lets through", async () => {
    const llm = newMock();
    llm.loadFixtureFile(RETRY_FILE);
    const url = await llm.start();
    const sub = new MCPMock();
    sub.loadFakes(sharedBlock("ping", ["from-sub"]));
    llm.mount("/mcp/sub", sub);
    expect(lines(warnSpy).filter((l) => l.includes("shadowed by"))).toEqual([]);
    const c = await client(`${url}/mcp/sub`);
    expect(textOf(await c.callTool({ name: "ping", arguments: {} }))).toBe("from-sub");
  });

  it("is logged for a mount shadowed by an auto-mount the control API created", async () => {
    const llm = newMock();
    const url = await llm.start();
    const res = await fetch(`${url}/__aimock/fixtures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpFakes: sharedBlock("ping", ["from-auto"]) }),
    });
    expect(res.status).toBe(200);
    llm.mount("/mcp", new MCPMock());
    const l6 = lines(warnSpy).filter((l) => l.includes("shadowed by"));
    expect(l6).toHaveLength(1);
    expect(l6[0]).toContain('"/mcp"');
  });
});

describe("A5: LLMock rejects a block mount path no request can reach", () => {
  it.each([
    ["before start", false],
    ["after start", true],
  ])("%s: a path under /__aimock throws mount-conflict and adds nothing", async (_, started) => {
    const llm = newMock();
    const url = started ? await llm.start() : null;
    const file = writeJson("ctl.json", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: sharedBlock("t", ["x"], { mount: "/__aimock/mcp" }),
    });
    const err = captureLoadError(() => llm.loadFixtureFile(file));
    expect(err.rule).toBe("mcp-fakes/mount-conflict");
    expect(llm.getFixtures()).toHaveLength(0);
    if (url) expect(await fakesListing(url)).toEqual([]);
  });
});
