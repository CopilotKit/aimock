/**
 * S2: the per-test fake event log of `McpFakeStore` (record-replay RP2-RP4,
 * RP9, plan decision C9) and `hasRecordedLogs` (C7).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MCP_FAKES_DEFAULT_TEST_ID,
  MCP_FAKES_MAX_EVENT_ARGS_BYTES,
  MCP_FAKES_MAX_EVENTS_PER_LOG,
  McpFakeStore,
  type McpFakeReportEventInput,
} from "../mcp-fakes.js";
import type { McpFakeIdentity } from "../types.js";

const FIXTURES = join(__dirname, "fixtures", "mcp-record");

function readBlock(rel: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as {
    mcpFakes: Record<string, unknown>;
  };
  return parsed.mcpFakes;
}

const id = (testId: string | null, context: string | null = null): McpFakeIdentity => ({
  testId,
  context,
  undeclared: null,
});

const answered = (
  entryId: string,
  context: string | null = null,
  args: unknown = {},
): McpFakeReportEventInput => ({
  outcome: "answered",
  entryId,
  tool: "echo",
  args,
  context,
  mount: "/mcp",
});

const T = "mcp › contract";

function contractStore(options?: { maxTestIds?: number }): McpFakeStore {
  const store = new McpFakeStore(options);
  store.add([{ source: "mcp.json", blockIndex: null, raw: readBlock("contract/mcp.json") }], {
    kind: "file",
  });
  return store;
}

describe("logEvent and reportPart", () => {
  it("cover every outcome", () => {
    const store = contractStore();
    const events: McpFakeReportEventInput[] = [
      answered("mcp.json:echo#0", null, { message: "hi" }),
      ...(["mismatch", "exhausted", "not_declared", "evicted", "internal_error"] as const).map(
        (outcome, i): McpFakeReportEventInput => ({
          outcome,
          code: `CODE_${i}`,
          tool: "echo",
          args: { n: i },
          context: null,
          mount: "/mcp",
        }),
      ),
      ...(["handler", "config", "empty", "unknown-tool", "upstream"] as const).map(
        (answeredBy): McpFakeReportEventInput => ({
          outcome: "unfaked",
          answeredBy,
          tool: "real",
          args: { by: answeredBy },
          context: null,
          mount: "/mcp",
        }),
      ),
    ];
    for (const event of events) store.logEvent(id(T), event);
    const part = store.reportPart(T, null, "/mcp");
    expect(part.evicted).toBe(false);
    const noSeq = (row: { seq: number }): unknown => ({ ...row, seq: "any" });
    expect(part.served.map(noSeq)).toEqual([
      {
        entryId: "mcp.json:echo#0",
        mount: "/mcp",
        tool: "echo",
        args: { message: "hi" },
        seq: "any",
      },
    ]);
    expect(part.failures.map(noSeq)).toEqual(
      [0, 1, 2, 3, 4].map((i) => ({
        seq: "any",
        code: `CODE_${i}`,
        mount: "/mcp",
        tool: "echo",
        args: { n: i },
      })),
    );
    expect(part.unfaked).toEqual(
      ["handler", "config", "empty", "unknown-tool", "upstream"].map((by) => ({
        mount: "/mcp",
        tool: "real",
        args: { by },
        answeredBy: by,
      })),
    );
    // seq orders served and failures rows.
    const seqs = [...part.served, ...part.failures].map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("caps stored args at 4 KiB of JSON, as the journal capBody marker", () => {
    const store = contractStore();
    const big = { blob: "x".repeat(10_000) };
    const size = Buffer.byteLength(JSON.stringify(big), "utf8");
    expect(size).toBeGreaterThan(MCP_FAKES_MAX_EVENT_ARGS_BYTES);
    store.logEvent(id(T), answered("mcp.json:echo#0", null, big));
    const small = { message: "é" };
    store.logEvent(id(T), answered("mcp.json:echo#0", null, small));
    const part = store.reportPart(T, null, "/mcp");
    expect(part.served[0].args).toEqual({ __aimock_truncated: true, originalByteSize: size });
    expect(part.served[1].args).toEqual(small);
    // A copy: changing the caller's object later does not change the log.
    small.message = "changed";
    expect(store.reportPart(T, null, "/mcp").served[1].args).toEqual({ message: "é" });
  });

  it("is cleared by resetState(testId), resetState() and clear()", () => {
    const store = contractStore();
    const fill = (): void => {
      store.logEvent(id(T), answered("mcp.json:echo#0"));
      store.logEvent(id("other"), answered("mcp.json:echo#0"));
      store.logEvent(id(null), answered("mcp.json:echo#0"));
    };
    const count = (t: string | null): number => store.reportPart(t, null, "/mcp").served.length;
    fill();
    store.resetState(T);
    expect([count(T), count("other"), count(null)]).toEqual([0, 1, 1]);
    store.resetState(MCP_FAKES_DEFAULT_TEST_ID);
    expect([count(T), count("other"), count(null)]).toEqual([0, 1, 0]);
    fill();
    store.resetState();
    expect([count(T), count("other"), count(null)]).toEqual([0, 0, 0]);
    fill();
    store.clear();
    expect([count(T), count("other"), count(null)]).toEqual([0, 0, 0]);
  });

  it("matches context exactly", () => {
    const store = contractStore();
    store.logEvent(id(T, "X"), answered("mcp.json:echo#0", "X"));
    store.logEvent(id(T), answered("mcp.json:echo#0", null));
    expect(store.reportPart(T, null, "/mcp").served.map((r) => r.seq)).toHaveLength(1);
    expect(store.reportPart(T, "X", "/mcp").served).toHaveLength(1);
    const nullSeq = store.reportPart(T, null, "/mcp").served[0].seq;
    const xSeq = store.reportPart(T, "X", "/mcp").served[0].seq;
    expect(nullSeq).toBeGreaterThan(xSeq);
    expect(store.reportPart(T, "Y", "/mcp").served).toEqual([]);
  });

  it("orders events across two stores (two mounts) by seq", () => {
    const a = contractStore();
    const b = contractStore();
    a.logEvent(id(T), answered("mcp.json:echo#0"));
    b.logEvent(id(T), answered("mcp.json:echo#0"));
    a.logEvent(id(T), answered("mcp.json:echo#0"));
    const [a1, a2] = a.reportPart(T, null, "/mcp").served.map((r) => r.seq);
    const [b1] = b.reportPart(T, null, "/mcp").served.map((r) => r.seq);
    expect(a1).toBeLessThan(b1);
    expect(b1).toBeLessThan(a2);
  });
});

describe("bounds (C9)", () => {
  it("the 1001st event of one test id overflows the report only", () => {
    const store = contractStore();
    for (let i = 0; i < MCP_FAKES_MAX_EVENTS_PER_LOG; i++) {
      store.logEvent(id(T), answered("mcp.json:echo#0", null, { i }));
    }
    expect(store.reportPart(T, null, "/mcp").evicted).toBe(false);
    store.logEvent(id(T), answered("mcp.json:echo#0", null, { i: 1000 }));
    const part = store.reportPart(T, null, "/mcp");
    expect(part.evicted).toBe(true);
    expect(part.served).toHaveLength(MCP_FAKES_MAX_EVENTS_PER_LOG);
    expect(part.served[0].args).toEqual({ i: 1 });
    expect(part.served.at(-1)?.args).toEqual({ i: 1000 });
    // Report-only: the fakes engine is unchanged.
    expect(store.claim("echo", { message: "hi" }, id(T)).kind).toBe("answer");
    expect(store.snapshot(T, null).every((b) => !b.evicted)).toBe(true);
    // resetState clears the overflow.
    store.resetState(T);
    expect(store.reportPart(T, null, "/mcp").evicted).toBe(false);
  });

  it("the untagged log keeps the newest 1000 and sets the untagged overflow", () => {
    const store = contractStore();
    for (let i = 0; i <= MCP_FAKES_MAX_EVENTS_PER_LOG; i++) {
      store.logEvent(id(null), answered("mcp.json:echo#0", null, { i }));
    }
    const part = store.reportPart(null, null, "/mcp");
    expect(part.evicted).toBe(true);
    expect(part.served).toHaveLength(MCP_FAKES_MAX_EVENTS_PER_LOG);
    expect(part.served[0].args).toEqual({ i: 1 });
    expect(store.reportPart("t", null, "/mcp").evicted).toBe(false);
    store.resetState(MCP_FAKES_DEFAULT_TEST_ID);
    expect(store.reportPart(null, null, "/mcp")).toMatchObject({ evicted: false, served: [] });
  });

  it("the test-id FIFO cap evicts event logs, and consumption eviction drops the log", () => {
    const store = contractStore({ maxTestIds: 2 });
    store.logEvent(id("a"), answered("mcp.json:echo#0"));
    store.logEvent(id("b"), answered("mcp.json:echo#0"));
    store.logEvent(id("c"), answered("mcp.json:echo#0"));
    expect(store.reportPart("a", null, "/mcp")).toMatchObject({ evicted: true, served: [] });
    expect(store.reportPart("b", null, "/mcp").evicted).toBe(false);
    // Event-log eviction is report-only: a's claims still answer.
    store.add(
      [
        {
          source: "s.json",
          blockIndex: null,
          raw: { ...readBlock("contract/mcp.json"), scope: "shared" },
        },
      ],
      { kind: "file" },
    );
    expect(store.claim("echo", { message: "hi" }, id("a")).kind).toBe("answer");

    // Consumption eviction also drops that id's event log.
    const s2 = contractStore({ maxTestIds: 1 });
    s2.add(
      [
        {
          source: "s.json",
          blockIndex: null,
          raw: { ...readBlock("contract/mcp.json"), scope: "shared" },
        },
      ],
      { kind: "file" },
    );
    s2.logEvent(id("x"), answered("s.json:echo#0"));
    expect(s2.claim("echo", { message: "hi" }, id("x")).kind).toBe("answer");
    expect(s2.claim("echo", { message: "hi" }, id("y")).kind).toBe("answer");
    expect(s2.reportPart("x", null, "/mcp")).toMatchObject({ evicted: true, served: [] });
  });
});

describe("unconsumed tiers (RP4) and RP9", () => {
  function tieredStore(): McpFakeStore {
    const store = new McpFakeStore();
    const block = (scope: unknown, tool: string, mount = "/mcp"): Record<string, unknown> => ({
      scope,
      mount,
      tools: [
        {
          name: tool,
          calls: [
            { args: { v: 1 }, result: "r" },
            { anyArgs: true, result: "r" },
          ],
        },
      ],
    });
    store.add(
      [
        { source: "tc", blockIndex: null, raw: block({ testId: "T", context: "C" }, "tc") },
        { source: "t", blockIndex: null, raw: block({ testId: "T" }, "t") },
        { source: "c", blockIndex: null, raw: block({ context: "C" }, "c") },
        { source: "s", blockIndex: null, raw: block("shared", "s") },
        { source: "other", blockIndex: null, raw: block({ testId: "T" }, "o", "/other") },
      ],
      { kind: "file" },
    );
    return store;
  }

  it("splits unconsumed by tier and filters by mount", () => {
    const store = tieredStore();
    store.claim("t", { v: 1 }, id("T", "C"));
    const part = store.reportPart("T", "C", "/mcp");
    expect(part.unconsumed).toEqual([
      { entryId: "tc:tc#0", mount: "/mcp", tool: "tc", args: { v: 1 } },
      { entryId: "tc:tc#1", mount: "/mcp", tool: "tc", anyArgs: true },
      { entryId: "t:t#1", mount: "/mcp", tool: "t", anyArgs: true },
    ]);
    expect(part.sharedUnconsumed).toEqual([
      { entryId: "c:c#0", mount: "/mcp", tool: "c" },
      { entryId: "c:c#1", mount: "/mcp", tool: "c" },
      { entryId: "s:s#0", mount: "/mcp", tool: "s" },
      { entryId: "s:s#1", mount: "/mcp", tool: "s" },
    ]);
    expect(store.reportPart("T", "C", "/other").unconsumed.map((u) => u.entryId)).toEqual([
      "other:o#0",
      "other:o#1",
    ]);
  });

  it("building a report does not change snapshot()", () => {
    const store = tieredStore();
    store.claim("t", { v: 1 }, id("T"));
    store.logEvent(id("T"), answered("t:t#0"));
    const before = JSON.parse(JSON.stringify(store.snapshot("T", "C"))) as unknown;
    store.reportPart("T", "C", "/mcp");
    store.reportPart("never-seen", null, "/mcp");
    store.reportPart(null, null, "/mcp");
    expect(store.snapshot("T", "C")).toEqual(before);
    expect(store.snapshot("never-seen", null).every((b) => !b.evicted)).toBe(true);
  });
});

describe("hasRecordedLogs (C7)", () => {
  it("is true only when a loaded call entry has a notifications/message", () => {
    const store = contractStore();
    expect(store.hasRecordedLogs()).toBe(false);
    store.add(
      [
        {
          source: "logs.json",
          blockIndex: null,
          raw: readBlock("contract-logs/mcp.json"),
        },
      ],
      { kind: "file" },
    );
    expect(store.hasRecordedLogs()).toBe(true);
    store.clear();
    expect(store.hasRecordedLogs()).toBe(false);
  });
});
