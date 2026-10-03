/**
 * MCP fakes through the control API (spec 5.2 W6, 5.3 R1-R3 and R7, 5.4 F10,
 * 5.6 B3 and B6, 6.5, I9).
 *
 * Real surface: `createServer(...)` on a real TCP port, driven with real HTTP
 * calls to `/__aimock/*`, and a real v1 MCP SDK client
 * (`@modelcontextprotocol/sdk`) talking Streamable HTTP to the mount. The
 * server is started the way the CLI starts it with no fakes and no AG-UI
 * (`mounts === undefined`, no `ServiceFixtures`), which is the guard for the
 * mounts-array rule: an MCP mount added after start must get the journal, the
 * metric registry and the logger. Log lines are read from the real `console`
 * streams the server `Logger` writes to (info on stdout, warn/error on stderr).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer, type ServerInstance } from "../server.js";
import { MCPMock } from "../mcp-mock.js";
import type { Mountable } from "../types.js";
import { connectV1, enc, expectMcpError } from "./mcp-fakes-harness.js";

const RETRY_ID = "tickets › retry on timeout";

/** The spec 6.4 retry example, as one `mcpFakes` block. */
function retryBlock(): Record<string, unknown> {
  return {
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
}

/** A shared block whose tool answers "one", then "two", whatever the arguments. */
function pingBlock(): Record<string, unknown> {
  return {
    scope: "shared",
    tools: [
      {
        name: "ping",
        calls: [
          { anyArgs: true, result: "one" },
          { anyArgs: true, result: "two" },
        ],
      },
    ],
  };
}

/** A block scoped to test id T2: it beats the shared tier for T2 (7.1). */
function t2Block(): Record<string, unknown> {
  return {
    scope: { testId: "T2" },
    tools: [{ name: "ping", calls: [{ anyArgs: true, result: "T2 only" }] }],
  };
}

const LLM_FIXTURE = {
  match: { userMessage: "hello" },
  response: { content: "hi" },
};

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

/** Started as the CLI starts it with no fakes and no AG-UI: no mounts, no ServiceFixtures. */
async function start(
  opts: { mounts?: Array<{ path: string; handler: Mountable }>; maxTestIds?: number } = {},
): Promise<ServerInstance> {
  const instance = await createServer(
    [],
    {
      logLevel: "info",
      metrics: true,
      ...(opts.maxTestIds !== undefined ? { fixtureCountsMaxTestIds: opts.maxTestIds } : {}),
    },
    opts.mounts,
  );
  servers.push(instance);
  return instance;
}

async function control(
  instance: ServerInstance,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${instance.url}/__aimock${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? null : JSON.parse(text) };
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

async function ping(c: Client): Promise<string> {
  return textOf(await c.callTool({ name: "ping", arguments: {} }));
}

interface FakesListing {
  testId: string | null;
  context: string | null;
  mounts: Array<{
    mount: string;
    blocks: Array<{
      blockId: string;
      mount: string;
      evicted: boolean;
      tools: Array<{ name: string; entries: Array<{ id: string; consumed: boolean }> }>;
    }>;
  }>;
}

async function listFakes(instance: ServerInstance, query = ""): Promise<FakesListing> {
  const r = await control(instance, "GET", `/mcp/fakes${query}`);
  expect(r.status).toBe(200);
  return r.json as FakesListing;
}

async function llmFixtureCount(instance: ServerInstance): Promise<number> {
  const r = await control(instance, "GET", "/fixtures");
  return (r.json as { count: number }).count;
}

/** A minimal JSON-RPC session over raw HTTP, so the test id is sent on `initialize` only (I3). */
async function rawSession(url: string): Promise<{
  call(tool: string): Promise<{ status: number; body: Record<string, unknown> }>;
}> {
  const post = async (target: string, body: unknown, session?: string) => {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      session: res.headers.get("mcp-session-id"),
      body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
    };
  };
  const init = await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "raw", version: "1.0.0" },
    },
  });
  expect(init.status).toBe(200);
  const session = init.session ?? "";
  expect(session).not.toBe("");
  const base = url.split("?")[0];
  await post(base, { jsonrpc: "2.0", method: "notifications/initialized" }, session);
  let id = 1;
  return {
    async call(tool: string) {
      id += 1;
      const r = await post(
        base,
        { jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: {} } },
        session,
      );
      return { status: r.status, body: r.body };
    },
  };
}

describe("RED-GREEN: POST /__aimock/fixtures with only mcpFakes (F10, W6, B3)", () => {
  it("adds the block, auto-mounts /mcp after start, serves the v1 client, and journals under the test id", async () => {
    const instance = await start();

    const added = await control(instance, "POST", "/fixtures", { mcpFakes: retryBlock() });
    expect(added).toEqual({ status: 200, json: { added: 0, mcpFakesAdded: 1 } });

    const c = await client(`${instance.url}/mcp`, RETRY_ID);
    const first = await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain("upstream timeout");
    const second = await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    expect(textOf(second)).toBe("TICKET-42");
    await expectMcpError(c.callTool({ name: "create_ticket", arguments: { title: "Refund" } }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });

    // B3 / I9: the MCP calls are listed under the decoded test id (the header
    // carried it percent-encoded, H3).
    const journal = await control(instance, "GET", `/journal?testId=${enc(RETRY_ID)}`);
    const entries = journal.json as Array<{
      path: string;
      testId?: string;
      response: { mcpFake?: { id: string | null; outcome: string } };
    }>;
    const fakeOutcomes = entries
      .filter((e) => e.response.mcpFake)
      .map((e) => [e.response.mcpFake?.id, e.response.mcpFake?.outcome]);
    expect(fakeOutcomes).toEqual([
      ["control-api#1:first-try", "answered"],
      ["control-api#1:retry", "answered"],
      [null, "exhausted"],
    ]);
    expect(entries.every((e) => e.path.startsWith("/mcp") && e.testId === RETRY_ID)).toBe(true);
  });
});

describe("W6 after-start auto-mount on a server started with no mounts (mounts-array rule guard)", () => {
  it("wires journal, metric registry and logger, and logs L4 on stdout", async () => {
    const instance = await start();
    await control(instance, "POST", "/fixtures", { mcpFakes: retryBlock() });

    expect(lines(logSpy).some((l) => l.includes("auto-mounted") && l.includes('"/mcp"'))).toBe(
      true,
    );

    const c = await client(`${instance.url}/mcp`, RETRY_ID);
    await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    await expectMcpError(c.callTool({ name: "create_ticket", arguments: { title: "Refund" } }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });

    // Journal (setJournal).
    expect(instance.journal.getAll().some((e) => e.path === "/mcp")).toBe(true);
    // Metric (setRegistry): the fake failure counter and the route label.
    const metrics = await (await fetch(`${instance.url}/metrics`)).text();
    expect(metrics).toMatch(/aimock_mcp_fake_failures_total\{code="MCP_FAKE_EXHAUSTED"\} 1/);
    expect(metrics).toMatch(/aimock_requests_total\{[^}]*path="\/mcp"/);
    // Logger (setLogger): L1 on stderr.
    expect(lines(errorSpy).some((l) => l.includes("MCP-FAKE") && l.includes("create_ticket"))).toBe(
      true,
    );
  });

  it("a block for an existing MCPMock mount goes to that mount, with no auto-mount and no L4", async () => {
    const mcp = new MCPMock();
    const instance = await start({ mounts: [{ path: "/mcp", handler: mcp }] });

    const added = await control(instance, "POST", "/fixtures", { mcpFakes: retryBlock() });
    expect(added.status).toBe(200);
    expect(lines(logSpy).some((l) => l.includes("auto-mounted"))).toBe(false);

    const c = await client(`${instance.url}/mcp`, RETRY_ID);
    const first = await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    expect(textOf(first)).toContain("upstream timeout");
  });

  it("a block whose path is held by a mount that is not an MCPMock is rejected with 400, nothing added", async () => {
    const other: Mountable = { handleRequest: async () => false };
    const instance = await start({ mounts: [{ path: "/mcp", handler: other }] });

    const r = await control(instance, "POST", "/fixtures", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: retryBlock(),
    });
    expect(r.status).toBe(400);
    const body = r.json as { error: string; details: Array<{ rule: string; name: string }> };
    expect(body.error).toBe("Validation failed");
    expect(body.details[0].rule).toBe("mcp-fakes/mount-conflict");
    expect(body.details[0].name).toBe("FixtureLoadError");
    expect(await llmFixtureCount(instance)).toBe(0);
    expect((await listFakes(instance)).mounts).toEqual([]);
  });
});

describe("F10 / B6: POST /__aimock/fixtures body forms", () => {
  it("fixtures only: today's { added } with no mcpFakesAdded key", async () => {
    const instance = await start();
    const r = await control(instance, "POST", "/fixtures", { fixtures: [LLM_FIXTURE] });
    expect(r).toEqual({ status: 200, json: { added: 1 } });
  });

  it("neither fixtures nor mcpFakes: 400 as today", async () => {
    const instance = await start();
    const r = await control(instance, "POST", "/fixtures", {});
    expect(r).toEqual({ status: 400, json: { error: 'Missing or invalid "fixtures" array' } });
  });

  it("both: { added, mcpFakesAdded } counts each half; an array counts every block", async () => {
    const instance = await start();
    const r = await control(instance, "POST", "/fixtures", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: [retryBlock(), pingBlock()],
    });
    expect(r).toEqual({ status: 200, json: { added: 1, mcpFakesAdded: 2 } });
    expect(await llmFixtureCount(instance)).toBe(1);
    const listing = await listFakes(instance, `?testId=${enc(RETRY_ID)}`);
    expect(listing.mounts[0].blocks.map((b) => b.blockId)).toEqual([
      "control-api#1[0]",
      "control-api#1[1]",
    ]);
  });

  it("a missing LLM match is still a 400 (cc200e69) and the fakes in the same body are not added", async () => {
    const instance = await start();
    const r = await control(instance, "POST", "/fixtures", {
      fixtures: [{ response: { content: "x" } }],
      mcpFakes: pingBlock(),
    });
    expect(r).toEqual({ status: 400, json: { error: "Fixture at index 0 is missing match" } });
    expect((await listFakes(instance)).mounts).toEqual([]);
  });

  it("a bad block: 400 Validation failed, details carry rule, file, blockId and entryId", async () => {
    const instance = await start();
    const bad = {
      scope: "shared",
      tools: [{ name: "t", calls: [{ anyArgs: false, result: "x" }] }],
    };
    const r = await control(instance, "POST", "/fixtures", { mcpFakes: bad });
    expect(r.status).toBe(400);
    const body = r.json as {
      error: string;
      details: Array<Record<string, unknown>>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatchObject({
      name: "FixtureLoadError",
      rule: "mcp-fakes/bad-block:j",
      file: "control-api#1",
      blockId: "control-api#1",
      entryId: "control-api#1:t#0",
    });
    expect(typeof body.details[0].message).toBe("string");
  });

  it("a bad add after two good ones names the mount's next <n> (I7), and consumes it not", async () => {
    const instance = await start();
    for (const n of [1, 2]) {
      const ok = await control(instance, "POST", "/fixtures", { mcpFakes: pingBlock() });
      expect(ok.status, `good add ${n}`).toBe(200);
    }
    const bad = {
      scope: "shared",
      tools: [{ name: "t", calls: [{ anyArgs: false, result: "x" }] }],
    };
    const r = await control(instance, "POST", "/fixtures", { mcpFakes: bad });
    expect(r.status).toBe(400);
    const details = (r.json as { details: Array<Record<string, unknown>> }).details;
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      rule: "mcp-fakes/bad-block:j",
      file: "control-api#3",
      blockId: "control-api#3",
      entryId: "control-api#3:t#0",
    });

    // The failed add did not advance <n>: the next good add is control-api#3.
    const ok = await control(instance, "POST", "/fixtures", { mcpFakes: pingBlock() });
    expect(ok.status).toBe(200);
    expect((await listFakes(instance)).mounts[0].blocks.map((b) => b.blockId)).toEqual([
      "control-api#1",
      "control-api#2",
      "control-api#3",
    ]);
  });

  it("two bad blocks: both reported in input order, nothing added (no LLM fixture, no fake, no counter)", async () => {
    const instance = await start();
    const noScope = { tools: [{ name: "a", calls: [{ anyArgs: true, result: "x" }] }] };
    const badAnyArgs = {
      scope: "shared",
      tools: [{ name: "b", calls: [{ anyArgs: false, result: "x" }] }],
    };
    const r = await control(instance, "POST", "/fixtures", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: [noScope, pingBlock(), badAnyArgs],
    });
    expect(r.status).toBe(400);
    const details = (r.json as { details: Array<Record<string, unknown>> }).details;
    expect(details).toHaveLength(2);
    expect(details[0]).toMatchObject({
      rule: "mcp-fakes/bad-block:a",
      file: "control-api#1",
      blockId: "control-api#1[0]",
    });
    expect(details[1]).toMatchObject({
      rule: "mcp-fakes/bad-block:j",
      file: "control-api#1",
      blockId: "control-api#1[2]",
      entryId: "control-api#1[2]:b#0",
    });

    expect(await llmFixtureCount(instance)).toBe(0);
    expect((await listFakes(instance)).mounts).toEqual([]);
    // Nothing mounted: /mcp is not served (the request falls through to the LLM routes).
    expect(lines(logSpy).some((l) => l.includes("auto-mounted"))).toBe(false);

    // The failed add consumed no `<n>`: the next good add is control-api#1.
    const ok = await control(instance, "POST", "/fixtures", { mcpFakes: pingBlock() });
    expect(ok.status).toBe(200);
    expect((await listFakes(instance)).mounts[0].blocks[0].blockId).toBe("control-api#1");
  });

  it("5.4 fail-loud under logLevel silent: a bad block is still a 400 and nothing is added", async () => {
    const instance = await createServer([], { logLevel: "silent" });
    servers.push(instance);
    const r = await control(instance, "POST", "/fixtures", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: { tools: [{ name: "t", calls: [{ anyArgs: true, result: "x" }] }] },
    });
    expect(r.status).toBe(400);
    const body = r.json as { error: string; details: Array<Record<string, unknown>> };
    expect(body.error).toBe("Validation failed");
    expect(body.details.map((d) => d.rule)).toEqual(["mcp-fakes/bad-block:a"]);
    expect(await llmFixtureCount(instance)).toBe(0);
    expect((await listFakes(instance)).mounts).toEqual([]);
  });

  it("an L8 block (args after anyArgs) is accepted with 200 and the warning is logged at warn", async () => {
    const instance = await start();
    const shadowed = {
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
    };
    const r = await control(instance, "POST", "/fixtures", { mcpFakes: shadowed });
    expect(r).toEqual({ status: 200, json: { added: 0, mcpFakesAdded: 1 } });
    expect(
      lines(warnSpy).some((l) => l.includes("shadowed") && l.includes("control-api#1:t#1")),
    ).toBe(true);
  });
});

describe("GET /__aimock/mcp/fakes (6.5, I9)", () => {
  it("groups by mount, lists entry ids and the consumed state for the requested test id", async () => {
    const instance = await start();
    await control(instance, "POST", "/fixtures", { mcpFakes: [retryBlock(), pingBlock()] });

    const c = await client(`${instance.url}/mcp`, RETRY_ID);
    await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });

    const listing = await listFakes(instance, `?testId=${enc(RETRY_ID)}`);
    expect(listing.testId).toBe(RETRY_ID);
    expect(listing.context).toBeNull();
    expect(listing.mounts.map((m) => m.mount)).toEqual(["/mcp"]);
    const [retry, shared] = listing.mounts[0].blocks;
    expect(retry.blockId).toBe("control-api#1[0]");
    expect(retry.mount).toBe("/mcp");
    expect(retry.evicted).toBe(false);
    expect(retry.tools[0].entries.map((e) => [e.id, e.consumed])).toEqual([
      ["control-api#1[0]:first-try", true],
      ["control-api#1[0]:retry", false],
    ]);
    expect(shared.blockId).toBe("control-api#1[1]");

    // Another test id sees only the shared block, nothing consumed.
    const other = await listFakes(instance, "?testId=someone-else");
    expect(other.mounts[0].blocks.map((b) => b.blockId)).toEqual(["control-api#1[1]"]);
    // No test id: only "shared" blocks apply.
    const untagged = await listFakes(instance);
    expect(untagged.testId).toBeNull();
    expect(untagged.mounts[0].blocks.map((b) => b.blockId)).toEqual(["control-api#1[1]"]);
  });

  it("filters by context and by mount; an unknown mount is 404 and an unknown parameter 400", async () => {
    const instance = await start();
    await control(instance, "POST", "/fixtures", {
      mcpFakes: [
        { ...pingBlock(), scope: { context: "ctx-a" } },
        { ...pingBlock(), scope: "shared", mount: "/tools" },
      ],
    });

    const ctx = await listFakes(instance, "?context=ctx-a&mount=%2Fmcp");
    expect(ctx.context).toBe("ctx-a");
    expect(ctx.mounts.map((m) => [m.mount, m.blocks.map((b) => b.blockId)])).toEqual([
      ["/mcp", ["control-api#1[0]"]],
    ]);
    const all = await listFakes(instance, "?context=ctx-a");
    expect(all.mounts.map((m) => m.mount)).toEqual(["/mcp", "/tools"]);

    const unknownMount = await control(instance, "GET", "/mcp/fakes?mount=%2Fnope");
    expect(unknownMount.status).toBe(404);
    const unknownParam = await control(instance, "GET", "/mcp/fakes?testid=x");
    expect(unknownParam.status).toBe(400);
  });

  it("returns the same blocks as MCPMock.fakesSnapshot for the same test id and context", async () => {
    const mock = new MCPMock();
    mock.loadFakes([retryBlock(), pingBlock()]);
    const instance = await start({ mounts: [{ path: "/mcp", handler: mock }] });

    const c = await client(`${instance.url}/mcp`, RETRY_ID);
    await c.callTool({ name: "create_ticket", arguments: { title: "Refund" } });

    const listing = await listFakes(instance, `?testId=${enc(RETRY_ID)}`);
    const snapshot = mock.fakesSnapshot(RETRY_ID, null);
    expect(snapshot[0].tools[0].entries.map((e) => e.consumed)).toEqual([true, false]);
    expect(listing.mounts).toEqual([
      { mount: "/mcp", blocks: JSON.parse(JSON.stringify(snapshot)) },
    ]);
    expect((await listFakes(instance)).mounts[0].blocks.map((b) => b.blockId)).toEqual(
      mock.fakesSnapshot().map((b) => b.blockId),
    );
  });
});

describe("Reset doors after start (5.3 R1, R2, R3, R7)", () => {
  /** LLM fixture + shared ping block; T1 evicted by the cap of 2; one raw session bound to T2. */
  async function scenario() {
    const instance = await start({ maxTestIds: 2 });
    const added = await control(instance, "POST", "/fixtures", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: pingBlock(),
    });
    expect(added.status).toBe(200);

    const t1 = await client(`${instance.url}/mcp`, "T1");
    expect(await ping(t1)).toBe("one");
    // Bound on initialize only (I3): later calls carry no test id.
    const bound = await rawSession(`${instance.url}/mcp?testId=T2`);
    expect(JSON.stringify((await bound.call("ping")).body)).toContain('"one"');
    const t3 = await client(`${instance.url}/mcp`, "T3");
    expect(await ping(t3)).toBe("one");
    // The cap (2) evicted T1's consumption state: I5.
    await expectMcpError(t1.callTool({ name: "ping", arguments: {} }), {
      code: -31011,
      aimockCode: "MCP_FAKE_EVICTED",
    });
    return { instance, t1, bound };
  }

  it.each([
    ["R1", "POST", "/reset"],
    ["R2", "POST", "/reset/fixtures"],
    ["R3", "DELETE", "/fixtures"],
  ] as const)(
    "%s %s %s: LLM fixtures and fakes cleared, evicted mark cleared, counters and sessions kept",
    async (_id, method, path) => {
      const { instance, t1, bound } = await scenario();

      const r = await control(instance, method, path);
      expect(r.status).toBe(200);

      // LLM fixtures: cleared.
      expect(await llmFixtureCount(instance)).toBe(0);
      // Fakes: cleared (the mount stays; it holds no block).
      const listing = await listFakes(instance);
      expect(listing.mounts.map((m) => [m.mount, m.blocks.length])).toEqual([["/mcp", 0]]);

      // Counters kept: the next add is control-api#2, not #1 again.
      await control(instance, "POST", "/fixtures", { mcpFakes: [pingBlock(), t2Block()] });
      expect(
        (await listFakes(instance, "?testId=T2")).mounts[0].blocks.map((b) => b.blockId),
      ).toEqual(["control-api#2[0]", "control-api#2[1]"]);

      // Evicted mark cleared: T1 is answered from entry 0.
      expect(await ping(t1)).toBe("one");
      // Sessions kept, with their I3 binding: the raw session, which sent T2 on
      // initialize only, is answered from the T2-scoped block.
      expect(JSON.stringify((await bound.call("ping")).body)).toContain('"T2 only"');
    },
  );

  it("R7 POST /reset/journal: only the journal is cleared; fakes, state, evicted mark, counters and sessions kept", async () => {
    const { instance, t1, bound } = await scenario();
    expect(instance.journal.getAll().length).toBeGreaterThan(0);

    const r = await control(instance, "POST", "/reset/journal");
    expect(r.status).toBe(200);
    expect(instance.journal.getAll().filter((e) => !e.path.startsWith("/__aimock"))).toEqual([]);

    expect(await llmFixtureCount(instance)).toBe(1);
    const listing = await listFakes(instance, "?testId=T2");
    expect(listing.mounts[0].blocks.map((b) => b.blockId)).toEqual(["control-api#1"]);
    expect(listing.mounts[0].blocks[0].tools[0].entries.map((e) => e.consumed)).toEqual([
      true,
      false,
    ]);

    // Evicted mark kept: T1 still fails.
    await expectMcpError(t1.callTool({ name: "ping", arguments: {} }), {
      code: -31011,
      aimockCode: "MCP_FAKE_EVICTED",
    });
    // Consumption state and session binding kept: the bound T2 session goes on to entry 1.
    expect(JSON.stringify((await bound.call("ping")).body)).toContain('"two"');

    await control(instance, "POST", "/fixtures", { mcpFakes: { ...pingBlock(), mount: "/x" } });
    // Counters are per mount: /mcp's next add would be #2, /x starts at #1.
    expect((await listFakes(instance, "?mount=%2Fx")).mounts[0].blocks[0].blockId).toBe(
      "control-api#1",
    );
    await control(instance, "POST", "/fixtures", { mcpFakes: pingBlock() });
    expect(
      (await listFakes(instance, "?mount=%2Fmcp")).mounts[0].blocks.map((b) => b.blockId),
    ).toEqual(["control-api#1", "control-api#2"]);
  });
});

describe("B3: journal attribution", () => {
  it("an MCP call whose test id came only from initialize is listed under it, not __default__", async () => {
    const instance = await start();
    await control(instance, "POST", "/fixtures", { mcpFakes: pingBlock() });
    const bound = await rawSession(`${instance.url}/mcp?testId=${enc("bound › id")}`);
    await bound.call("ping");

    const byId = (await control(instance, "GET", `/journal?testId=${enc("bound › id")}`))
      .json as Array<{ body: { method?: string } | null }>;
    expect(byId.some((e) => e.body?.method === "tools/call")).toBe(true);
    const byDefault = (await control(instance, "GET", "/journal?testId=__default__"))
      .json as Array<{ path: string; body: { method?: string } | null }>;
    expect(byDefault.some((e) => e.body?.method === "tools/call")).toBe(false);
  });

  it("LLM entries are attributed exactly as before (header, then ?testId=)", async () => {
    const instance = await start();
    await control(instance, "POST", "/fixtures", { fixtures: [LLM_FIXTURE] });
    const chat = (headers: Record<string, string>, query = "") =>
      fetch(`${instance.url}/v1/chat/completions${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] }),
      });
    await chat({ "X-Test-Id": "llm-a" });
    await chat({}, "?testId=llm-b");

    const a = (await control(instance, "GET", "/journal?testId=llm-a")).json as unknown[];
    const b = (await control(instance, "GET", "/journal?testId=llm-b")).json as unknown[];
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

/**
 * A fake-capable mount that is not an `MCPMock` instance (a custom
 * `Mountable`, or an `MCPMock` from a second copy of the module), delegating
 * to a real MCPMock. `adds` records every `addMcpFakes` call it gets.
 */
function delegatingMount(inner: MCPMock): Mountable & {
  adds: unknown[];
  fakesSnapshot: MCPMock["fakesSnapshot"];
} {
  const adds: unknown[] = [];
  return {
    adds,
    handleRequest: (req, res, pathname) => inner.handleRequest(req, res, pathname),
    addMcpFakes(blocks, origin) {
      adds.push(blocks);
      return inner.addMcpFakes(blocks, origin);
    },
    clearMcpFakes: () => inner.clearMcpFakes(),
    fakesSnapshot: (testId, context) => inner.fakesSnapshot(testId, context),
  };
}

describe("A2: the control-API plan never adds to a real mount", () => {
  it("a bad block for a mount whose own add is lenient: 400, and the mount's add is never called", async () => {
    const adds: unknown[] = [];
    const lenient: Mountable = {
      handleRequest: async () => false,
      addMcpFakes(blocks) {
        adds.push(blocks);
        return { warnings: [] };
      },
    };
    const instance = await start({ mounts: [{ path: "/lenient", handler: lenient }] });
    const r = await control(instance, "POST", "/fixtures", {
      fixtures: [LLM_FIXTURE],
      mcpFakes: { scope: "shared", mount: "/lenient", tools: [{ name: "t", calls: [] }] },
    });
    expect(r.status).toBe(400);
    expect(adds).toEqual([]);
    expect(await llmFixtureCount(instance)).toBe(0);
  });

  it("a valid block still reaches that mount once, with 200", async () => {
    const mount = delegatingMount(new MCPMock());
    const instance = await start({ mounts: [{ path: "/dual", handler: mount }] });
    const r = await control(instance, "POST", "/fixtures", {
      mcpFakes: { ...pingBlock(), mount: "/dual" },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ added: 0, mcpFakesAdded: 1 });
    expect(mount.adds).toHaveLength(1);
  });
});

describe("A5: a control-API block mount path no request can reach is a 400", () => {
  it.each(["/__aimock/mcp", "/__aimockx"])(
    "%s (under the control prefix): 400 mount-conflict, nothing added or auto-mounted",
    async (mount) => {
      const mounts: Array<{ path: string; handler: Mountable }> = [];
      const instance = await start({ mounts });
      const r = await control(instance, "POST", "/fixtures", {
        fixtures: [LLM_FIXTURE],
        mcpFakes: { ...pingBlock(), mount },
      });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toContain("mcp-fakes/mount-conflict");
      expect(mounts).toEqual([]);
      expect(await llmFixtureCount(instance)).toBe(0);
    },
  );

  it("a trailing-slash variant of a mounted MCPMock path: 400 mount-conflict, nothing added", async () => {
    const mock = new MCPMock();
    const mounts: Array<{ path: string; handler: Mountable }> = [{ path: "/mcp", handler: mock }];
    const instance = await start({ mounts });
    const r = await control(instance, "POST", "/fixtures", {
      mcpFakes: { ...pingBlock(), mount: "/mcp/" },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain("mcp-fakes/mount-conflict");
    expect(mounts.map((m) => m.path)).toEqual(["/mcp"]);
    expect(mock.fakesSnapshot(null, null)).toEqual([]);
  });
});

describe("A6: GET /__aimock/mcp/fakes lists every fake-capable mount", () => {
  it("a mount with addMcpFakes that is not an MCPMock instance is listed, and ?mount= finds it", async () => {
    const mount = delegatingMount(new MCPMock());
    const instance = await start({ mounts: [{ path: "/dual", handler: mount }] });
    const added = await control(instance, "POST", "/fixtures", {
      mcpFakes: { ...pingBlock(), mount: "/dual" },
    });
    expect(added.status).toBe(200);

    const all = await listFakes(instance);
    expect(all.mounts.map((m) => [m.mount, m.blocks.map((b) => b.blockId)])).toEqual([
      ["/dual", ["control-api#1"]],
    ]);
    const one = await control(instance, "GET", "/mcp/fakes?mount=%2Fdual");
    expect(one.status).toBe(200);
  });
});
