/**
 * The per-test MCP fake report (record-replay RP1-RP9): the control route
 * `GET /__aimock/mcp/fakes/report`, and `assertFakesReport` /
 * `formatFakesReport`.
 *
 * Real surface: the built CLI (`dist/cli.js`) as a child process on a real
 * TCP port, a real v1 MCP SDK client over Streamable HTTP with `X-Test-Id`,
 * and real HTTP reads of the control API. Run `pnpm build` first.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpFakeReportPart } from "../mcp-fakes.js";
import type { MountList } from "../mcp-fakes-mount.js";
import { MCPMock } from "../mcp-mock.js";
import {
  AimockFakesReportError,
  assertFakesReport,
  buildFakesReport,
  formatFakesReport,
  type McpFakesReport,
} from "../mcp-fakes-report.js";
import { connectV1, enc, expectMcpError, startCli, type CliHandle } from "./mcp-fakes-harness.js";

const T = "tickets › retry on timeout";
const TICKETS = "src/__tests__/fixtures/mcp-fakes/tickets";
const RP3_KEYS = [
  "testId",
  "context",
  "ok",
  "evicted",
  "served",
  "unconsumed",
  "unfaked",
  "failures",
  "sharedUnconsumed",
];

const clis: CliHandle[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const c of clis.splice(0)) await c.stop();
});

async function start(fixtures: string): Promise<CliHandle> {
  const cli = await startCli(["--fixtures", fixtures]);
  clis.push(cli);
  return cli;
}

async function connect(url: string, testId: string): Promise<Client> {
  const client = await connectV1(url, { headers: { "X-Test-Id": enc(testId) } });
  clients.push(client);
  return client;
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as unknown };
}

async function report(base: string, query: string): Promise<McpFakesReport> {
  const { status, body } = await getJson(`${base}/__aimock/mcp/fakes/report?${query}`);
  expect(status).toBe(200);
  return body as McpFakesReport;
}

describe("GET /__aimock/mcp/fakes/report (RP6) on the tickets fixture", () => {
  it("reports unused entries, then served rows in call order, then a failure", async () => {
    const cli = await start(TICKETS);
    const q = `testId=${enc(T)}`;

    // Unused: before any call.
    const before = await report(cli.url, q);
    expect(Object.keys(before)).toEqual(RP3_KEYS);
    expect(before).toMatchObject({ testId: T, context: null, ok: false, evicted: false });
    expect(before.unconsumed.map((u) => u.entryId)).toEqual([
      "retry.json:first-try",
      "retry.json:retry",
    ]);
    expect(before.unconsumed[0]).toEqual({
      entryId: "retry.json:first-try",
      mount: "/mcp",
      tool: "create_ticket",
      args: { title: "Refund" },
    });

    // Served: both entries consumed, in call order.
    const client = await connect(cli.url + "/mcp", T);
    await client.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    await client.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    const served = await report(cli.url, q);
    expect(served.ok).toBe(true);
    expect(served.unconsumed).toEqual([]);
    expect(served.served).toEqual([
      {
        entryId: "retry.json:first-try",
        mount: "/mcp",
        tool: "create_ticket",
        args: { title: "Refund" },
      },
      {
        entryId: "retry.json:retry",
        mount: "/mcp",
        tool: "create_ticket",
        args: { title: "Refund" },
      },
    ]);

    // Failure: a third call is exhausted.
    await expectMcpError(
      client.callTool({ name: "create_ticket", arguments: { title: "Refund" } }),
      { code: -31010, aimockCode: "MCP_FAKE_EXHAUSTED" },
    );
    const failed = await report(cli.url, q);
    expect(failed.ok).toBe(false);
    expect(failed.failures).toEqual([
      {
        code: "MCP_FAKE_EXHAUSTED",
        mount: "/mcp",
        tool: "create_ticket",
        args: { title: "Refund" },
      },
    ]);
    expect(Object.keys(failed)).toEqual(RP3_KEYS);
    // RP3: no internal `seq` in the served JSON.
    expect(JSON.stringify(failed)).not.toContain('"seq"');
  });

  it("rejects an unknown query parameter with 400", async () => {
    const cli = await start(TICKETS);
    const { status, body } = await getJson(`${cli.url}/__aimock/mcp/fakes/report?bogus=1`);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "Unknown query parameter: 'bogus'. Supported: testId, context" });
  });

  it("treats an empty testId as not supplied (the untagged report)", async () => {
    const cli = await start(TICKETS);
    const r = await report(cli.url, "testId=&context=");
    expect(r).toMatchObject({ testId: null, context: null, ok: true, unconsumed: [] });
  });

  it("RP9: reading the report leaves GET /__aimock/mcp/fakes unchanged", async () => {
    const cli = await start(TICKETS);
    const client = await connect(cli.url + "/mcp", T);
    await client.callTool({ name: "create_ticket", arguments: { title: "Refund" } });
    const listUrl = `${cli.url}/__aimock/mcp/fakes?testId=${enc(T)}`;
    const before = await getJson(listUrl);
    expect(before.status).toBe(200);
    await report(cli.url, `testId=${enc(T)}`);
    await report(cli.url, `testId=${enc(T)}&context=c`);
    await report(cli.url, "");
    expect(await getJson(listUrl)).toEqual(before);
  });
});

describe("RP1: one report across every mount", () => {
  const TWO = "report › two mounts";
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aimock-s4-report-"));
    const block = (mount: string, tool: string): Record<string, unknown> => ({
      scope: { testId: TWO },
      mount,
      tools: [{ name: tool, calls: [{ id: `${tool}-call`, args: { n: 1 }, result: tool }] }],
    });
    writeFileSync(
      join(dir, "two.json"),
      JSON.stringify({ mcpFakes: [block("/mcp", "alpha"), block("/mcp2", "beta")] }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges the mounts into one report, and every row carries its mount", async () => {
    const cli = await start(dir);
    const q = `testId=${enc(TWO)}`;

    const unused = await report(cli.url, q);
    expect(unused.ok).toBe(false);
    expect(unused.unconsumed.map((u) => [u.entryId, u.mount])).toEqual([
      ["two.json[0]:alpha-call", "/mcp"],
      ["two.json[1]:beta-call", "/mcp2"],
    ]);

    // Call /mcp2 first, then /mcp: `served` follows call order across mounts.
    const c2 = await connect(cli.url + "/mcp2", TWO);
    const c1 = await connect(cli.url + "/mcp", TWO);
    await c2.callTool({ name: "beta", arguments: { n: 1 } });
    await c1.callTool({ name: "alpha", arguments: { n: 1 } });
    const used = await report(cli.url, q);
    expect(used.ok).toBe(true);
    expect(used.served.map((s) => [s.entryId, s.mount])).toEqual([
      ["two.json[1]:beta-call", "/mcp2"],
      ["two.json[0]:alpha-call", "/mcp"],
    ]);
  });
});

describe("formatFakesReport and assertFakesReport (RP7, RP8)", () => {
  const base = (over: Partial<McpFakesReport> = {}): McpFakesReport => ({
    testId: "suite › case",
    context: null,
    ok: true,
    evicted: false,
    served: [],
    unconsumed: [],
    unfaked: [],
    failures: [],
    sharedUnconsumed: [],
    ...over,
  });
  const failing = (): McpFakesReport =>
    base({
      ok: false,
      evicted: true,
      context: "ctx",
      unconsumed: [{ entryId: "f.json:a", mount: "/mcp", tool: "lookup", anyArgs: true }],
      failures: [{ code: "MCP_FAKE_MISMATCH", mount: "/mcp", tool: "lookup", args: { q: 2 } }],
      unfaked: [{ mount: "/mcp", tool: "plain", args: {}, answeredBy: "empty" }],
    });

  it("lists failures, then unconsumed entry ids, then evicted", () => {
    expect(formatFakesReport(failing())).toBe(
      [
        'aimock MCP fakes report failed (testId "suite › case", context "ctx"):',
        '  failure MCP_FAKE_MISMATCH: tools/call lookup on /mcp with {"q":2}',
        "  unconsumed: f.json:a (/mcp lookup)",
        "  evicted: this test id's fake state was evicted by the per-mount test-id cap, or its event log overflowed (1000 events); the report is incomplete",
      ].join("\n"),
    );
  });

  it("adds unfaked lines only with failOnUnfaked", () => {
    expect(formatFakesReport(failing(), { failOnUnfaked: true }).split("\n").at(-1)).toBe(
      "  unfaked: tools/call plain on /mcp answered by empty",
    );
  });

  it("passes an ok report, and throws AimockFakesReportError for each ok cause", () => {
    expect(() => assertFakesReport(base())).not.toThrow();
    const causes: McpFakesReport[] = [
      base({ ok: false, failures: failing().failures }),
      base({ ok: false, evicted: true }),
      base({ ok: false, unconsumed: failing().unconsumed }),
    ];
    for (const r of causes) {
      let caught: unknown;
      try {
        assertFakesReport(r);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AimockFakesReportError);
      if (caught instanceof AimockFakesReportError) {
        expect(caught.report).toBe(r);
        expect(caught.message).toBe(formatFakesReport(r));
      }
    }
  });

  it("fails on unfaked calls only with failOnUnfaked", () => {
    const r = base({ unfaked: failing().unfaked });
    expect(() => assertFakesReport(r)).not.toThrow();
    expect(() => assertFakesReport(r, { failOnUnfaked: true })).toThrow(
      /unfaked: tools\/call plain on \/mcp answered by empty/,
    );
  });

  it("names a missing test id in the header", () => {
    expect(formatFakesReport(base({ testId: null })).split("\n")[0]).toBe(
      "aimock MCP fakes report failed (no test id):",
    );
  });
});

describe("buildFakesReport: ok (RP5), merge order and evicted", () => {
  const empty = (): McpFakeReportPart => ({
    evicted: false,
    served: [],
    unconsumed: [],
    unfaked: [],
    failures: [],
    sharedUnconsumed: [],
  });
  /** A real MCPMock mount whose report part is fixed by the test. */
  const mount = (path: string, part: McpFakeReportPart): MountList[number] => {
    const handler = new MCPMock();
    handler.fakesReportPart = () => part;
    return { path, handler };
  };

  it("is ok with nothing to report, and not ok when any mount is evicted", () => {
    expect(buildFakesReport([mount("/a", empty())], "T", null).ok).toBe(true);
    const r = buildFakesReport(
      [mount("/a", empty()), mount("/b", { ...empty(), evicted: true })],
      "T",
      null,
    );
    expect(r).toMatchObject({ ok: false, evicted: true });
  });

  it("is not ok when any mount has an unconsumed entry", () => {
    const part = {
      ...empty(),
      unconsumed: [{ entryId: "f.json:a", mount: "/b", tool: "t", anyArgs: true as const }],
    };
    const r = buildFakesReport([mount("/a", empty()), mount("/b", part)], "T", null);
    expect(r).toMatchObject({ ok: false, evicted: false, failures: [] });
    expect(r.unconsumed).toEqual(part.unconsumed);
  });

  it("sorts served and failures by call order across mounts and strips seq", () => {
    const a = {
      ...empty(),
      served: [{ entryId: "a2", mount: "/a", tool: "t", args: {}, seq: 4 }],
      failures: [{ code: "MCP_FAKE_MISMATCH", mount: "/a", tool: "t", args: {}, seq: 3 }],
    };
    const b = {
      ...empty(),
      served: [{ entryId: "b1", mount: "/b", tool: "t", args: {}, seq: 1 }],
      failures: [{ code: "MCP_FAKE_EXHAUSTED", mount: "/b", tool: "t", args: {}, seq: 2 }],
    };
    const r = buildFakesReport([mount("/a", a), mount("/b", b)], "T", null);
    expect(r.served).toEqual([
      { entryId: "b1", mount: "/b", tool: "t", args: {} },
      { entryId: "a2", mount: "/a", tool: "t", args: {} },
    ]);
    expect(r.failures.map((f) => f.code)).toEqual(["MCP_FAKE_EXHAUSTED", "MCP_FAKE_MISMATCH"]);
    expect(r.ok).toBe(false);
  });
});
