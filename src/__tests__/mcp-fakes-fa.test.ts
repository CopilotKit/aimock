/**
 * S2: the recorded `mcpFakes` keys FA1-FA5 (record-replay spec 6.9), the
 * `record` add origin, and `markConsumed` / `recordedList` / `replayOf`.
 *
 * Validation is checked through the store (`McpFakeStore.add`), which is what
 * the fixture loader, `--fixtures` and the control API use, and through
 * `validateMcpFakes`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpFakeStore, McpFakesAddError, validateMcpFakes } from "../mcp-fakes.js";
import type { McpFakeIdentity } from "../types.js";

const FIXTURES = join(__dirname, "fixtures", "mcp-record");

function readBlock(rel: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as {
    mcpFakes: Record<string, unknown>;
  };
  return parsed.mcpFakes;
}

const contract = (): Record<string, unknown> => readBlock("contract/mcp.json");

function addFails(raw: unknown, source = "mcp.json"): McpFakesAddError {
  const store = new McpFakeStore();
  try {
    store.add([{ source, blockIndex: null, raw }], { kind: "file" });
  } catch (err) {
    expect(err).toBeInstanceOf(McpFakesAddError);
    return err as McpFakesAddError;
  }
  throw new Error("expected add to throw");
}

function loaded(raw: unknown = contract(), source = "mcp.json"): McpFakeStore {
  const store = new McpFakeStore();
  store.add([{ source, blockIndex: null, raw }], { kind: "file" });
  return store;
}

const id = (testId: string | null, context: string | null = null): McpFakeIdentity => ({
  testId,
  context,
  undeclared: null,
});

/** `value` and everything under it is frozen. */
function deepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(deepFrozen);
}

describe("FA bad-block files throw the record-replay rule", () => {
  const cases: Array<[string, string, string | null]> = [
    ["fa-list", "record-replay/fa-list", null],
    ["fa-recorded", "record-replay/fa-recorded", null],
    [
      "fa-notifications",
      "record-replay/fa-notifications",
      "fa-notifications.json:trigger-long-running-operation#0",
    ],
    ["fa-duration", "record-replay/fa-duration", "fa-duration.json:echo#0"],
    ["fa-timing", "record-replay/fa-timing", null],
  ];
  it.each(cases)("bad/%s.json", (name, rule, entryId) => {
    const source = `${name}.json`;
    const err = addFails(readBlock(`bad/${name}.json`), source);
    expect(err.errors.map((e) => [e.rule, e.file, e.blockId, e.entryId])).toEqual([
      [rule, source, source, entryId],
    ]);
  });

  it("validateMcpFakes reports the same rule", () => {
    const result = validateMcpFakes(readBlock("bad/fa-timing.json"), "x.json");
    expect(result.blocks).toEqual([]);
    expect(result.errors.map((e) => e.rule)).toEqual(["record-replay/fa-timing"]);
  });
});

describe("FA rule values", () => {
  const withBlock = (patch: Record<string, unknown>): Record<string, unknown> => ({
    ...contract(),
    ...patch,
  });
  const rulesOf = (raw: unknown): string[] => addFails(raw).errors.map((e) => e.rule);

  it("FA1 list: not an array, element without a string name, repeated name, not JSON", () => {
    expect(rulesOf(withBlock({ list: { name: "echo" } }))).toEqual(["record-replay/fa-list"]);
    expect(rulesOf(withBlock({ list: ["echo"] }))).toEqual(["record-replay/fa-list"]);
    expect(rulesOf(withBlock({ list: [{ name: 3 }] }))).toEqual(["record-replay/fa-list"]);
    expect(rulesOf(withBlock({ list: [{ name: "a" }, { name: "a" }] }))).toEqual([
      "record-replay/fa-list",
    ]);
    expect(rulesOf(withBlock({ list: [{ name: "a", x: new Date() }] }))).toEqual([
      "record-replay/fa-list",
    ]);
    // An empty list is a valid recording of an upstream with no tools.
    expect(() => loaded(withBlock({ list: [] }))).not.toThrow();
  });

  it("FA2 recorded: not an object, or a field of the wrong type", () => {
    const rec = (contract().recorded ?? {}) as Record<string, unknown>;
    const bad: unknown[] = [
      "x",
      [],
      { ...rec, upstream: 1 },
      { ...rec, protocolVersion: undefined },
      { ...rec, serverInfo: "everything" },
      { ...rec, aimockVersion: null },
      { ...rec, at: "2026-10-08" },
    ];
    for (const recorded of bad) {
      expect(rulesOf(withBlock({ recorded }))).toEqual(["record-replay/fa-recorded"]);
    }
    const { serverInfo: _drop, ...noServerInfo } = rec;
    void _drop;
    expect(() => loaded(withBlock({ recorded: noServerInfo }))).not.toThrow();
  });

  it("FA3 notifications: not an array, or an element without atMs >= 0, method, params", () => {
    const call = (notifications: unknown): Record<string, unknown> =>
      withBlock({
        tools: [{ name: "echo", calls: [{ args: {}, result: "ok", notifications }] }],
      });
    const ok = { atMs: 0, method: "notifications/progress", params: {} };
    for (const n of [
      {},
      [null],
      [{ ...ok, atMs: -1 }],
      [{ ...ok, atMs: "1" }],
      [{ ...ok, atMs: Infinity }],
      [{ ...ok, method: 1 }],
      [{ ...ok, params: [] }],
      [{ ...ok, params: undefined }],
    ]) {
      const err = addFails(call(n));
      expect(err.errors.map((e) => [e.rule, e.entryId])).toEqual([
        ["record-replay/fa-notifications", "mcp.json:echo#0"],
      ]);
    }
    expect(() => loaded(call([ok]))).not.toThrow();
  });

  it("FA4 durationMs: not a number >= 0", () => {
    for (const durationMs of [-1, "5", null, Infinity, NaN]) {
      const raw = withBlock({
        tools: [{ name: "echo", calls: [{ args: {}, error: "boom", durationMs }] }],
      });
      expect(addFails(raw).errors.map((e) => [e.rule, e.entryId])).toEqual([
        ["record-replay/fa-duration", "mcp.json:echo#0"],
      ]);
    }
    const zero = withBlock({
      tools: [{ name: "echo", calls: [{ args: {}, result: "ok", durationMs: 0 }] }],
    });
    expect(() => loaded(zero)).not.toThrow();
  });

  it("FA5 timing: only recorded or immediate", () => {
    for (const timing of ["fast", 1, null, "Recorded"]) {
      expect(rulesOf(withBlock({ timing }))).toEqual(["record-replay/fa-timing"]);
    }
    expect(() => loaded(withBlock({ timing: "immediate" }))).not.toThrow();
    expect(() => loaded(withBlock({ timing: "recorded" }))).not.toThrow();
  });

  it("a recorded file that breaks a fakes rule throws the mcp-fakes value, never record-replay", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [withBlock({ extra: 1 }), "mcp-fakes/bad-block:h"],
      [withBlock({ tools: [] }), "mcp-fakes/bad-block:g"],
      [withBlock({ scope: undefined }), "mcp-fakes/bad-block:a"],
      [
        withBlock({
          tools: [{ name: "echo", calls: [{ args: {}, result: "ok", durationMs: 1, latency: 2 }] }],
        }),
        "mcp-fakes/bad-block:h",
      ],
    ];
    for (const [raw, rule] of cases) {
      const rules = addFails(raw).errors.map((e) => e.rule);
      expect(rules).toEqual([rule]);
      expect(rules.some((r) => r.startsWith("record-replay/"))).toBe(false);
    }
  });
});

describe("the contract file", () => {
  it("validates, through validateMcpFakes and the store", () => {
    const result = validateMcpFakes(contract(), "mcp.json");
    expect(result.errors).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    expect(() => loaded()).not.toThrow();
    expect(() => loaded(readBlock("contract-logs/mcp.json"))).not.toThrow();
  });

  it("round-trips list, recorded, timing, notifications and durationMs as frozen copies", () => {
    const raw = contract();
    const [block] = validateMcpFakes(raw, "mcp.json").blocks;
    expect(block.list).toEqual(raw.list);
    expect(block.recorded).toEqual(raw.recorded);
    expect(block.timing).toBe("recorded");
    const tools = raw.tools as Array<{ calls: Array<Record<string, unknown>> }>;
    expect(block.tools[0].calls[0].durationMs).toBe(12);
    expect(block.tools[0].calls[0].notifications).toBeUndefined();
    expect(block.tools[1].calls[0].notifications).toEqual(tools[1].calls[0].notifications);
    expect(block.tools[1].calls[0].durationMs).toBe(2010);
    for (const part of [block.list, block.recorded, block.tools[1].calls[0].notifications]) {
      expect(deepFrozen(part)).toBe(true);
    }
    // Copies, not the caller's objects.
    expect(block.list).not.toBe(raw.list);
    (raw.list as Array<Record<string, unknown>>)[0].name = "changed";
    expect(block.list?.[0].name).toBe("echo");
    expect(validateMcpFakes({ ...contract(), timing: "immediate" }, "m").blocks[0].timing).toBe(
      "immediate",
    );
  });

  it("a plain fakes block has no list or recorded and the default timing", () => {
    const [block] = validateMcpFakes(
      { scope: "shared", tools: [{ name: "t", calls: [{ args: {}, result: "x" }] }] },
      "plain.json",
    ).blocks;
    expect(block.list).toBeUndefined();
    expect(block.recorded).toBeUndefined();
    expect(block.timing).toBe("recorded");
    expect(Object.keys(block.tools[0].calls[0]).sort()).toEqual(["args", "id", "index", "result"]);
  });
});

describe("the record origin", () => {
  it("gives record#<n> ids, numbered like the other run-time origins", () => {
    const store = new McpFakeStore();
    store.add([{ source: "ignored", blockIndex: null, raw: contract() }], { kind: "record" });
    store.add(
      [
        { source: "ignored", blockIndex: 0, raw: { ...contract(), scope: { testId: "b" } } },
        { source: "ignored", blockIndex: 1, raw: { ...contract(), scope: { testId: "c" } } },
      ],
      { kind: "record" },
    );
    expect(store.allEntryIds()).toEqual([
      "record#1:echo#0",
      "record#1:trigger-long-running-operation#0",
      "record#2[0]:echo#0",
      "record#2[0]:trigger-long-running-operation#0",
      "record#2[1]:echo#0",
      "record#2[1]:trigger-long-running-operation#0",
    ]);
  });

  it("an unknown origin kind still fails as bad block (i)", () => {
    const store = new McpFakeStore();
    expect(() =>
      store.add([{ source: "a", blockIndex: null, raw: contract() }], {
        kind: "replay" as "record",
      }),
    ).toThrow(/origin.kind must be "file", "code", "control-api" or "record"/);
  });
});

describe("markConsumed", () => {
  it("makes the next claim of those ids exhausted, per test id", () => {
    const store = loaded();
    const T = "mcp › contract";
    store.markConsumed(T, ["mcp.json:echo#0"]);
    const claim = store.claim("echo", { message: "hi" }, id(T));
    expect(claim.kind).toBe("exhausted");
    // Another test id is untouched.
    store.add(
      [{ source: "other.json", blockIndex: null, raw: { ...contract(), scope: "shared" } }],
      { kind: "file" },
    );
    expect(store.claim("echo", { message: "hi" }, id("other")).kind).toBe("answer");
  });

  it("marks untagged state for a null test id", () => {
    const store = loaded({ ...contract(), scope: "shared" });
    store.markConsumed(null, ["mcp.json:echo#0"]);
    expect(store.claim("echo", { message: "hi" }, id(null)).kind).toBe("exhausted");
    expect(store.claim("echo", { message: "hi" }, id("t")).kind).toBe("answer");
  });

  it("ignores ids not loaded on this mount", () => {
    const store = loaded({ ...contract(), scope: "shared" });
    store.markConsumed("t", ["nope.json:echo#0"]);
    expect(store.snapshot("t", null)[0].tools[0].entries[0].consumed).toBe(false);
    expect(store.claim("echo", { message: "hi" }, id("t")).kind).toBe("answer");
  });
});

describe("recordedList and replayOf", () => {
  it("recordedList takes the list of the most specific applicable tier that has one", () => {
    const store = new McpFakeStore();
    const sharedList = [{ name: "shared-tool" }];
    const testList = [{ name: "test-tool" }];
    store.add(
      [
        {
          source: "s",
          blockIndex: null,
          raw: { ...contract(), scope: "shared", list: sharedList },
        },
        {
          source: "t",
          blockIndex: null,
          raw: { ...contract(), scope: { testId: "T" }, list: testList },
        },
        {
          source: "tc",
          blockIndex: null,
          raw: { ...contract(), scope: { testId: "T", context: "C" }, list: undefined },
        },
      ],
      { kind: "file" },
    );
    expect(store.recordedList(id("T", "C"))).toEqual(testList);
    expect(store.recordedList(id("T"))).toEqual(testList);
    expect(store.recordedList(id("other"))).toEqual(sharedList);
    expect(deepFrozen(store.recordedList(id("T")))).toBe(true);
    expect(new McpFakeStore().recordedList(id("T"))).toBeNull();
  });

  it("replayOf returns timing, notifications and durationMs of an entry", () => {
    const store = loaded({ ...contract(), timing: "immediate" });
    const long = store.replayOf("mcp.json:trigger-long-running-operation#0");
    expect(long?.timing).toBe("immediate");
    expect(long?.durationMs).toBe(2010);
    expect(long?.notifications.map((n) => n.atMs)).toEqual([1000, 2000]);
    const echo = store.replayOf("mcp.json:echo#0");
    expect(echo).toEqual({ timing: "immediate", notifications: [], durationMs: 12 });
    expect(store.replayOf("missing")).toBeNull();
  });
});
