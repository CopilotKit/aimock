/**
 * The MCP fakes input boundary and the `McpFakesAddError` contract: one
 * plain-data snapshot of the input at `add()` / `validateMcpFakes` entry,
 * errors collected across checks (no first-stop), bounded error text, and frozen data
 * handed out by the store and by `McpFakesAddError`.
 */
import { describe, expect, it } from "vitest";
import { FixtureLoadError } from "../fixture-loader.js";
import {
  McpFakeStore,
  McpFakesAddError,
  MCP_FAKES_ECHO_LIMIT,
  echo,
  echoText,
  firstDifference,
  validateMcpFakes,
  type McpFakeAddOrigin,
} from "../mcp-fakes.js";
import type { McpFakeIdentity, McpFakeScope, McpFakeSource } from "../types.js";

const FILE = "b.json";
const OK_CALL = { anyArgs: true, result: "ok" };
const OK_TOOL = { name: "t", calls: [OK_CALL] };

function ident(testId: string | null = null): McpFakeIdentity {
  return { testId, context: null, undeclared: null };
}

function shared(tools: unknown[]): Record<string, unknown> {
  return { scope: "shared", tools };
}

function rules(raw: unknown): string[] {
  return validateMcpFakes(raw, FILE).errors.map((e) => e.rule);
}

/** Run `add` and return the `McpFakesAddError` it must throw (never another error). */
function addFails(
  sources: unknown,
  origin: unknown = { kind: "code" },
  store = new McpFakeStore(),
): McpFakesAddError {
  let thrown: unknown;
  try {
    store.add(sources as McpFakeSource[], origin as McpFakeAddOrigin);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(McpFakesAddError);
  return thrown as McpFakesAddError;
}

function one(raw: unknown): McpFakeSource[] {
  return [{ source: "x.json", blockIndex: null, raw }];
}

function codeStore(raw: unknown): McpFakeStore {
  const store = new McpFakeStore();
  store.add(one(raw), { kind: "code" });
  return store;
}

/** Assigning to a frozen object throws a TypeError in strict mode (ES modules). */
function expectFrozenWrite(fn: () => void): void {
  expect(fn).toThrow(TypeError);
}

// ---------------------------------------------------------------------------
// 1. Holes

describe("sparse-array holes are rejected, never skipped or crashed on", () => {
  /** A block with no scope: bad block (a), so a test can see that it was checked. */
  const NO_SCOPE = { tools: [OK_TOOL] };

  it("a hole in the top-level mcpFakes array is bad block (i) for that element; the others are still checked", () => {
    // eslint-disable-next-line no-sparse-arrays
    const raw = [, NO_SCOPE];
    expect(validateMcpFakes(raw, FILE).errors.map((e) => e.toJSON())).toEqual([
      {
        name: "FixtureLoadError",
        rule: "mcp-fakes/bad-block:i",
        file: "b.json",
        blockId: "b.json[0]",
        entryId: null,
        message:
          '"b.json", block "b.json[0]": [mcp-fakes/bad-block:i] mcpFakes block must be an object, got <a hole in a sparse array>',
      },
      {
        name: "FixtureLoadError",
        rule: "mcp-fakes/bad-block:a",
        file: "b.json",
        blockId: "b.json[1]",
        entryId: null,
        message: '"b.json", block "b.json[1]": [mcp-fakes/bad-block:a] block has no scope',
      },
    ]);
  });

  it("a hole in tools is bad block (g) for that tool; the other tools are still checked", () => {
    const badTool = { name: "u", calls: [] };
    // eslint-disable-next-line no-sparse-arrays
    expect(validateMcpFakes(shared([, badTool]), FILE).errors.map((e) => e.toJSON())).toEqual([
      {
        name: "FixtureLoadError",
        rule: "mcp-fakes/bad-block:g",
        file: "b.json",
        blockId: "b.json",
        entryId: null,
        message:
          '"b.json", block "b.json": [mcp-fakes/bad-block:g] tools[0] must be an object, got <a hole in a sparse array>',
      },
      {
        name: "FixtureLoadError",
        rule: "mcp-fakes/bad-block:g",
        file: "b.json",
        blockId: "b.json",
        entryId: null,
        message:
          '"b.json", block "b.json": [mcp-fakes/bad-block:g] tool "u" calls must be a non-empty array, got []',
      },
    ]);
  });

  it("a hole in calls is bad block (d) for that entry; the other entries are still checked", () => {
    const v = validateMcpFakes(
      // eslint-disable-next-line no-sparse-arrays
      shared([{ name: "t", calls: [, { anyArgs: true }] }]),
      FILE,
    );
    expect(v.errors.map((e) => [e.rule, e.entryId, e.message])).toEqual([
      [
        "mcp-fakes/bad-block:d",
        "b.json:t#0",
        '"b.json", block "b.json", entry "b.json:t#0": [mcp-fakes/bad-block:d] tool "t" calls[0] must be an object, got <a hole in a sparse array>',
      ],
      [
        "mcp-fakes/bad-block:d",
        "b.json:t#1",
        '"b.json", block "b.json", entry "b.json:t#1": [mcp-fakes/bad-block:d] tool "t" calls[1] needs exactly one of result / error',
      ],
    ]);
    expect(v.blocks).toEqual([]);
  });

  it("a hole inside args names the hole's path", () => {
    // eslint-disable-next-line no-sparse-arrays
    const a = [1, , 3];
    const v = validateMcpFakes(
      shared([{ name: "t", calls: [{ args: { a }, result: "x" }] }]),
      FILE,
    );
    expect(v.errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:d"]);
    expect(v.errors[0].message).toMatch(/args\.a\[1\] is a hole in a sparse array$/);
  });

  it("a hole in the sources passed to add() is McpFakesAddError (i) for that item; the others are still checked", () => {
    const err = addFails(
      // eslint-disable-next-line no-sparse-arrays
      [, { source: "x", blockIndex: 1, raw: NO_SCOPE }],
    );
    expect(err.errors.map((e) => e.toJSON())).toEqual([
      {
        name: "FixtureLoadError",
        rule: "mcp-fakes/bad-block:i",
        file: "code#1",
        blockId: null,
        entryId: null,
        message:
          '"code#1": [mcp-fakes/bad-block:i] blocks[0] must be an object { source, blockIndex, raw }, got <a hole in a sparse array>',
      },
      {
        name: "FixtureLoadError",
        rule: "mcp-fakes/bad-block:a",
        file: "code#1",
        blockId: "code#1[1]",
        entryId: null,
        message: '"code#1", block "code#1[1]": [mcp-fakes/bad-block:a] block has no scope',
      },
    ]);
  });

  it("a sparse array too long to check element by element is one bad value, read in bounded time", () => {
    const raw: unknown[] = [];
    raw.length = 2 ** 32 - 1;
    raw[5] = NO_SCOPE;
    const started = performance.now();
    const v = validateMcpFakes(raw, FILE);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(v.errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:i"]);
    expect(v.errors[0].message).toMatch(/a sparse array with \d+ holes \(the first at \[0\]\)/);
  });
});

// ---------------------------------------------------------------------------
// 1b. Shared references

describe("a value reached through shared references is read once, not once per path", () => {
  /**
   * `depth` objects, each `{ x: next, y: next }` over the next, ending in `1`:
   * 2^depth paths reach the last one. `onRead` runs each time the snapshot
   * lists one object's keys.
   */
  function sharedChain(depth: number, onRead: () => void = () => {}): Record<string, unknown> {
    let next: unknown = 1;
    for (let i = 0; i < depth; i++) {
      next = new Proxy(
        { x: next, y: next },
        {
          ownKeys(target) {
            onRead();
            return Reflect.ownKeys(target);
          },
        },
      );
    }
    return next as Record<string, unknown>;
  }

  const withArgs = (args: unknown) => shared([{ name: "t", calls: [{ args, result: "x" }] }]);

  it("each object of a shared chain is read once per snapshot", () => {
    let reads = 0;
    const v = validateMcpFakes(withArgs(sharedChain(20, () => (reads += 1))), FILE);
    expect(v.errors).toEqual([]);
    expect(reads).toBe(20);
  });

  it("a shared chain validates and loads in bounded time, on every path", () => {
    const DEPTH = 24;
    const args = sharedChain(DEPTH);
    const started = performance.now();
    expect(validateMcpFakes(withArgs(args), FILE).errors).toEqual([]);
    const store = new McpFakeStore();
    store.add(one(withArgs(args)), { kind: "code" });
    store.add([{ source: "y.json", blockIndex: 0, raw: withArgs(args) }], { kind: "file" });
    expect(performance.now() - started).toBeLessThan(2_000);
    // The copy keeps the shape: the deepest value is still reached on both branches.
    const stored = store.applicable(ident())[1].tools[0].calls[0].args;
    let node: unknown = stored;
    for (let i = 0; i < DEPTH; i++) node = (node as Record<string, unknown>)[i % 2 ? "x" : "y"];
    expect(node).toBe(1);
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it("a cycle reached through shared references is still bad block (d)", () => {
    const top: Record<string, unknown> = {};
    let next: Record<string, unknown> = top;
    for (let i = 0; i < 10; i++) {
      const child: Record<string, unknown> = {};
      next.x = child;
      next.y = child;
      next = child;
    }
    next.back = top;
    const v = validateMcpFakes(withArgs(top), FILE);
    expect(v.errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:d"]);
    expect(v.errors[0].message).toMatch(/is a circular reference$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Symbol keys

describe("symbol keys are rejected, never silently dropped", () => {
  it("a symbol key in args is bad block (d)", () => {
    const args = { a: 1, [Symbol("k")]: 2 };
    expect(rules(shared([{ name: "t", calls: [{ args, result: "x" }] }]))).toEqual([
      "mcp-fakes/bad-block:d",
    ]);
  });

  it("a symbol key on a block is bad block (i)", () => {
    const raw = { ...shared([OK_TOOL]), [Symbol("s")]: 1 };
    expect(rules(raw)).toEqual(["mcp-fakes/bad-block:i"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Getters and proxies

describe("getters are never run, proxies never escape as raw errors", () => {
  it("a throwing getter on a call entry gives McpFakesAddError (d), and is not called", () => {
    let calls = 0;
    const entry = {
      get args(): Record<string, unknown> {
        calls += 1;
        throw new Error("boom");
      },
      result: "x",
    };
    const err = addFails(one(shared([{ name: "t", calls: [entry] }])));
    expect(err.errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:d"]);
    expect(err.message).toMatch(/accessor/);
    expect(calls).toBe(0);
  });

  it("a throwing getter inside args gives McpFakesAddError, not the getter's error", () => {
    const args = {
      get a(): number {
        throw new Error("boom");
      },
    };
    const err = addFails(one(shared([{ name: "t", calls: [{ args, result: "x" }] }])));
    expect(err.rule).toBe("mcp-fakes/bad-block:d");
  });

  it("a proxy whose traps throw gives McpFakesAddError (i)", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    const err = addFails(one(hostile));
    expect(err.rule).toBe("mcp-fakes/bad-block:i");
    expect(err.message).toMatch(/trap/);
  });

  it("an unreadable value deep in a block names the file, block, entry, path and what was thrown", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    const raw = [
      shared([OK_TOOL]),
      shared([{ name: "t", calls: [OK_CALL, { args: { x: { y: hostile } }, result: "x" }] }]),
    ];
    const expected = (file: string, blockId: string) => ({
      name: "FixtureLoadError",
      rule: "mcp-fakes/bad-block:d",
      file,
      blockId,
      entryId: `${blockId}:t#1`,
      message: `"${file}", block "${blockId}", entry "${blockId}:t#1": [mcp-fakes/bad-block:d] tool "t" calls[1] args.x.y is an unreadable value (reading it threw "Error: boom")`,
    });
    expect(validateMcpFakes(raw, FILE).errors.map((e) => e.toJSON())).toEqual([
      expected(FILE, `${FILE}[1]`),
    ]);
    const err = addFails(
      raw.map((r, i) => ({ source: FILE, blockIndex: i, raw: r })),
      { kind: "file" },
    );
    expect(err.errors.map((e) => e.toJSON())).toEqual([expected(FILE, `${FILE}[1]`)]);
  });

  it("a revoked proxy as a tool gives bad block (g)", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(rules(shared([proxy]))).toEqual(["mcp-fakes/bad-block:g"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Inherited fields

describe("inherited fields are never read", () => {
  it("a block whose fields are only inherited is rejected (i)", () => {
    const raw = Object.create(shared([OK_TOOL])) as unknown;
    expect(rules(raw)).toEqual(["mcp-fakes/bad-block:i"]);
    expect(addFails(one(raw)).rule).toBe("mcp-fakes/bad-block:i");
  });

  it("an inherited calls on a tool is rejected (g)", () => {
    const toolObj = Object.create({ calls: [OK_CALL] }) as Record<string, unknown>;
    toolObj.name = "t";
    expect(rules(shared([toolObj]))).toEqual(["mcp-fakes/bad-block:g"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Non-plain objects

describe("non-plain objects (Date, class instances, Map) are rejected at every level", () => {
  class Point {
    x = 1;
  }

  it("a Date block is (i), a Date scope is (b), a Date tool is (g), a Date call is (d)", () => {
    expect(rules(new Date(0))).toEqual(["mcp-fakes/bad-block:i"]);
    expect(rules({ scope: new Date(0), tools: [OK_TOOL] })).toEqual(["mcp-fakes/bad-block:b"]);
    expect(rules(shared([new Date(0)]))).toEqual(["mcp-fakes/bad-block:g"]);
    expect(rules(shared([{ name: "t", calls: [new Date(0)] }]))).toEqual(["mcp-fakes/bad-block:d"]);
  });

  it("args that are a class instance at the top level are (d)", () => {
    expect(rules(shared([{ name: "t", calls: [{ args: new Point(), result: "x" }] }]))).toEqual([
      "mcp-fakes/bad-block:d",
    ]);
  });

  it("a Map tools value is (g)", () => {
    expect(rules({ scope: "shared", tools: new Map() })).toEqual(["mcp-fakes/bad-block:g"]);
  });

  it("an array with an extra non-index key is rejected", () => {
    const calls = [OK_CALL] as unknown[] & { extra?: number };
    calls.extra = 1;
    expect(rules(shared([{ name: "t", calls }]))).toEqual(["mcp-fakes/bad-block:g"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Aggregation

describe("errors are collected, not stopped at the first", () => {
  it("reports every unknown key and every bad field of a block, tool, scope and call", () => {
    const raw = {
      scope: { testId: "", bogusScope: 1 },
      undeclared: "deny",
      typo: 1,
      tools: [
        {
          name: "t",
          description: 5,
          extraTool: 1,
          calls: [{ anyArgs: false, id: 7, extraCall: 1, result: "x" }],
        },
      ],
    };
    const entry = `${FILE}:t#0`;
    const block = `"${FILE}", block "${FILE}"`;
    expect(validateMcpFakes(raw, FILE).errors.map((e) => [e.rule, e.entryId, e.message])).toEqual([
      [
        "mcp-fakes/bad-block:h",
        null,
        `${block}: [mcp-fakes/bad-block:h] block has unknown key "undeclared"`,
      ],
      [
        "mcp-fakes/bad-block:h",
        null,
        `${block}: [mcp-fakes/bad-block:h] block has unknown key "typo"`,
      ],
      [
        "mcp-fakes/bad-block:b",
        null,
        `${block}: [mcp-fakes/bad-block:b] scope has unknown key "bogusScope"`,
      ],
      [
        "mcp-fakes/bad-block:b",
        null,
        `${block}: [mcp-fakes/bad-block:b] scope.testId must be a non-empty string, got ""`,
      ],
      [
        "mcp-fakes/bad-block:h",
        null,
        `${block}: [mcp-fakes/bad-block:h] tools[0] has unknown key "extraTool"`,
      ],
      [
        "mcp-fakes/bad-block:g",
        null,
        `${block}: [mcp-fakes/bad-block:g] tool "t" description must be a string, got 5`,
      ],
      [
        "mcp-fakes/bad-block:h",
        entry,
        `${block}, entry "${entry}": [mcp-fakes/bad-block:h] tool "t" calls[0] has unknown key "extraCall"`,
      ],
      [
        "mcp-fakes/bad-block:d",
        entry,
        `${block}, entry "${entry}": [mcp-fakes/bad-block:d] tool "t" calls[0] id must be a non-empty string, got 7`,
      ],
      [
        "mcp-fakes/bad-block:j",
        entry,
        `${block}, entry "${entry}": [mcp-fakes/bad-block:j] tool "t" calls[0] anyArgs must be true, got false`,
      ],
    ]);
  });

  it("reports a bad tool name and still checks its calls", () => {
    const raw = shared([{ name: 3, calls: [{ args: 1, result: "x" }] }]);
    expect(rules(raw)).toEqual(["mcp-fakes/bad-block:g", "mcp-fakes/bad-block:d"]);
  });

  it("reports every in-block duplicate entry id, not only the first", () => {
    const raw = shared([
      {
        name: "t",
        calls: [
          { id: "a", ...OK_CALL },
          { id: "a", ...OK_CALL },
          { id: "b", ...OK_CALL },
          { id: "b", ...OK_CALL },
        ],
      },
    ]);
    expect(rules(raw)).toEqual(["mcp-fakes/bad-block:f", "mcp-fakes/bad-block:f"]);
  });

  it("a duplicate entry id whose first declaration is invalid is still reported (f)", () => {
    const raw = shared([
      {
        name: "t",
        calls: [
          { id: "x", args: 5, result: "a" },
          { id: "x", anyArgs: true, result: "b" },
        ],
      },
    ]);
    expect(rules(raw)).toEqual(["mcp-fakes/bad-block:d", "mcp-fakes/bad-block:f"]);
  });

  it("a duplicate tool whose first declaration is invalid is still reported (e)", () => {
    const raw = shared([
      { name: "x", calls: [] },
      { name: "x", calls: [OK_CALL] },
    ]);
    expect(rules(raw)).toEqual(["mcp-fakes/bad-block:g", "mcp-fakes/bad-block:e"]);
  });

  it("an invalid block is still checked for cross-input id collisions (f)", () => {
    const store = new McpFakeStore();
    // Two loads of "a" take the block ids "a" and "a@2"; a file named "a@2" then collides.
    store.add([{ source: "a", blockIndex: null, raw: shared([OK_TOOL]) }], { kind: "file" });
    store.add([{ source: "a", blockIndex: null, raw: shared([OK_TOOL]) }], { kind: "file" });
    const bad = { scope: "shared", typo: 1, tools: [OK_TOOL] };
    const err = addFails([{ source: "a@2", blockIndex: null, raw: bad }], { kind: "file" }, store);
    expect(err.errors.map((e) => e.rule)).toEqual([
      "mcp-fakes/bad-block:h",
      "mcp-fakes/bad-block:f",
    ]);
  });

  it("warnings of a block rejected for a collision are not reported", () => {
    const store = new McpFakeStore();
    // Two loads of "a" take the block ids "a" and "a@2"; a file named "a@2" then collides.
    store.add([{ source: "a", blockIndex: null, raw: shared([OK_TOOL]) }], { kind: "file" });
    store.add([{ source: "a", blockIndex: null, raw: shared([OK_TOOL]) }], { kind: "file" });
    const shadowed = shared([{ name: "t", calls: [OK_CALL, { args: { a: 1 }, result: "y" }] }]);
    const err = addFails(
      [{ source: "a@2", blockIndex: null, raw: shadowed }],
      { kind: "file" },
      store,
    );
    expect(err.errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:f"]);
    expect(err.warnings).toEqual([]);
  });

  it("add() rejects a bad blockIndex, a bad source and a bad origin with McpFakesAddError (i)", () => {
    const raw = shared([OK_TOOL]);
    expect(addFails([{ source: "x", blockIndex: -1, raw }], { kind: "file" }).rule).toBe(
      "mcp-fakes/bad-block:i",
    );
    expect(addFails([{ source: "", blockIndex: null, raw }], { kind: "file" }).rule).toBe(
      "mcp-fakes/bad-block:i",
    );
    expect(addFails([{ source: "x", blockIndex: null, raw }], { kind: "File" }).rule).toBe(
      "mcp-fakes/bad-block:i",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Bounded error text

describe("error text is bounded", () => {
  const huge = "x".repeat(100_000);

  it(`a value echoed into a bad-block message is cut at ${MCP_FAKES_ECHO_LIMIT} chars`, () => {
    const [err] = validateMcpFakes(
      shared([{ name: "t", calls: [{ args: huge, result: "x" }] }]),
      FILE,
    ).errors;
    expect(err.message.length).toBeLessThan(MCP_FAKES_ECHO_LIMIT + 300);
    expect(err.message).toMatch(/…/);
  });

  it("an unknown key echoed into a message is cut", () => {
    const [err] = validateMcpFakes({ ...shared([OK_TOOL]), [huge]: 1 }, FILE).errors;
    expect(err.message.length).toBeLessThan(MCP_FAKES_ECHO_LIMIT + 300);
  });

  it("firstDifference of an oversized argument is bounded", () => {
    expect(firstDifference({ a: "y" }, { a: huge }).length).toBeLessThan(1_100);
    const store = codeStore(shared([{ name: "t", calls: [{ args: { a: "y" }, result: "x" }] }]));
    const miss = store.claim("t", { a: huge }, ident());
    if (miss.kind !== "mismatch") throw new Error(`expected mismatch, got ${miss.kind}`);
    expect(miss.firstDifference.length).toBeLessThan(1_100);
  });

  it("the empty-tools message names the one allowed form", () => {
    const [err] = validateMcpFakes({ scope: { testId: "T" }, tools: [] }, FILE).errors;
    expect(err.message).toMatch(/tools: \[\]/);
    expect(err.message).toMatch(/scoped/);
    expect(err.message).not.toMatch(/may omit tools/);
  });
});

// ---------------------------------------------------------------------------
// 8. Immutability of handed-out data

describe("the store hands out frozen data", () => {
  const scoped = { scope: { testId: "T" }, tools: [OK_TOOL] };

  it("a claimed block is frozen: reassigning its scope or tier throws and changes nothing", () => {
    const store = codeStore(scoped);
    const claim = store.claim("t", {}, ident("T"));
    if (claim.kind !== "answer") throw new Error("expected answer");
    expect(Object.isFrozen(claim)).toBe(true);
    expectFrozenWrite(() => {
      (claim.block as { scope: McpFakeScope }).scope = "shared";
    });
    expectFrozenWrite(() => {
      (claim.block as { tier: string }).tier = "shared";
    });
    expect(store.applicable(ident()).length).toBe(0);
  });

  it("applicable() returns a frozen list of frozen blocks", () => {
    const store = codeStore(scoped);
    const list = store.applicable(ident("T"));
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    expectFrozenWrite(() => {
      (list[0] as { mount: string }).mount = "/other";
    });
  });

  it("validateMcpFakes blocks are deeply frozen", () => {
    const [block] = validateMcpFakes(scoped, FILE).blocks;
    expect(Object.isFrozen(block)).toBe(true);
    expect(Object.isFrozen(block.scope)).toBe(true);
    expect(Object.isFrozen(block.tools[0].calls[0])).toBe(true);
  });
});

describe("McpFakesAddError hands out frozen arrays and JSON copies", () => {
  function shadowedErr(): McpFakesAddError {
    const shadowed = shared([{ name: "t", calls: [OK_CALL, { args: { a: 1 }, result: "y" }] }]);
    return addFails(
      [
        { source: "f.json", blockIndex: 0, raw: shadowed },
        { source: "f.json", blockIndex: 1, raw: { scope: "shared", tools: "nope" } },
      ],
      { kind: "file" },
    );
  }

  it("errors and warnings are frozen", () => {
    const err = shadowedErr();
    expect(err.warnings).toHaveLength(1);
    expect(Object.isFrozen(err.errors)).toBe(true);
    expect(Object.isFrozen(err.warnings)).toBe(true);
    expect(Object.isFrozen(err.warnings[0])).toBe(true);
    expectFrozenWrite(() => {
      (err.errors as FixtureLoadError[]).push(err);
    });
  });

  it("toJSON() returns copies of the warnings", () => {
    const err = shadowedErr();
    const json = err.toJSON();
    json.warnings[0].message = "CHANGED";
    expect(err.warnings[0].message).not.toBe("CHANGED");
    expect(json.warnings[0]).not.toBe(err.warnings[0]);
  });
});

// ---------------------------------------------------------------------------
// 9. McpFakeScope type (checked by `pnpm typecheck`)

describe("McpFakeScope (type level)", () => {
  it("is readonly and needs testId or context", () => {
    // @ts-expect-error -- an empty scope object is not a scope
    const empty: McpFakeScope = {};
    const writeTestId = (scope: Exclude<McpFakeScope, "shared">): void => {
      // @ts-expect-error -- scopes are readonly
      scope.testId = "U";
    };
    expect(empty).toEqual({});
    expect(typeof writeTestId).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 10. Round 4: placeholders inside echoed containers, escapes, small limits,
// bare-string origin, cap type errors

describe("a placeholder nested in an echoed value prints as <reason>", () => {
  it("an accessor inside tools", () => {
    const tools = Object.defineProperty({}, "a", { get: () => 1, enumerable: true });
    const [err] = validateMcpFakes({ scope: "shared", tools }, FILE).errors;
    expect(err.message).toContain(
      'tools must be an array, got {"a":<an accessor property (getters are not read)>}',
    );
  });

  it("a Date inside an array scope, with a hole shown in its place", () => {
    const [err] = validateMcpFakes(
      // eslint-disable-next-line no-sparse-arrays
      { scope: ["x", new Date(0), [1, , 2]], tools: [OK_TOOL] },
      FILE,
    ).errors;
    expect(err.message).toContain(
      'scope must be "shared" or an object, got ["x",<not a plain JSON object (got [object Date])>,[1,<a hole in a sparse array>,2]]',
    );
    expect(err.message).not.toMatch(/"reason"|"at"/);
  });

  it("echo of a top-level placeholder is unchanged", () => {
    const [err] = validateMcpFakes({ scope: "shared", tools: new Date(0) }, FILE).errors;
    expect(err.message).toContain("tools must be an array, got <not a plain JSON object");
  });
});

describe("echo never cuts inside an escape; echoText never exceeds a small limit", () => {
  it("150 newlines are cut between escapes", () => {
    const text = echo("\n".repeat(150));
    expect(text.length).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
    const kept = text.slice(0, text.indexOf("…"));
    expect(kept).toMatch(/^"(\\n)+$/);
  });

  it("a \\u escape is never split", () => {
    for (let pad = 0; pad < 8; pad++) {
      const text = echo("a".repeat(pad) + "\u0001".repeat(100), 60);
      const kept = text.slice(0, text.indexOf("…"));
      expect(kept).toMatch(/^"a*(\\u0001)*$/);
      expect(text.length).toBeLessThanOrEqual(60);
    }
  });

  it.each([0, 1, 2, 5, 10, 17])("echoText of 500 chars fits limit %i", (limit) => {
    expect(echoText("x".repeat(500), limit).length).toBeLessThanOrEqual(limit);
    expect(echo("x".repeat(500), limit).length).toBeLessThanOrEqual(limit);
  });

  it("a NaN limit is a RangeError", () => {
    expect(() => echoText("x", Number.NaN)).toThrow(RangeError);
    expect(() => echo("x", Number.NaN)).toThrow(RangeError);
  });
});

/**
 * True when `kept` ends inside a JSON escape (`\\x` or `\\uXXXX`). Reads
 * `kept` as text where a backslash only ever starts an escape.
 */
function endsInsideEscape(kept: string): boolean {
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] !== "\\") continue;
    const end = i + (kept[i + 1] === "u" ? 6 : 2);
    if (end > kept.length) return true;
    i = end - 1;
  }
  return false;
}

/** Every cut (`…`) in `text` keeps whole JSON escapes before it. */
function expectNoSplitEscape(text: string, label: string): void {
  for (let at = text.indexOf("…"); at !== -1; at = text.indexOf("…", at + 1)) {
    expect(endsInsideEscape(text.slice(0, at)), `${label}: ${text}`).toBe(false);
  }
}

describe("user text in a placeholder reason is JSON-quoted", () => {
  const messages = (raw: unknown): string[] =>
    validateMcpFakes(raw, FILE).errors.map((e) => e.message);

  it("a Symbol.toStringTag cannot forge JSON structure", () => {
    const tag = 'x"},"injected":"y';
    class Tag {
      get [Symbol.toStringTag](): string {
        return tag;
      }
    }
    const [message] = messages(
      shared([{ name: "t", calls: [{ args: { x: new Tag() }, result: "x" }] }]),
    );
    expect(message).toContain(
      `args.x is not a plain JSON object (got ${JSON.stringify(`[object ${tag}]`)})`,
    );
    expect(message).not.toContain(`[object ${tag}]`);
  });

  it("a Symbol.toStringTag cannot forge a placeholder boundary", () => {
    const tag = "x)>, <a circular reference";
    class Tag {
      get [Symbol.toStringTag](): string {
        return tag;
      }
    }
    const [message] = messages({ scope: [new Tag()], tools: [OK_TOOL] });
    expect(message).toContain(
      `got [<not a plain JSON object (got ${JSON.stringify(`[object ${tag}]`)})>]`,
    );
  });

  it("a built-in tag stays as it was", () => {
    const [message] = messages({ scope: [new Date(0)], tools: [OK_TOOL] });
    expect(message).toContain("got [<not a plain JSON object (got [object Date])>]");
  });

  it("a thrown message with quotes, backslashes and <> is quoted", () => {
    const thrown = 'q"uote\\ >, <fake \\u12';
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(thrown);
        },
      },
    );
    const [message] = messages(
      shared([{ name: "t", calls: [{ args: { x: hostile }, result: "x" }] }]),
    );
    expect(message).toContain(
      `args.x is an unreadable value (reading it threw ${JSON.stringify(`Error: ${thrown}`)})`,
    );
  });
});

describe("a path that holds a JSON-quoted key is never cut inside an escape", () => {
  const keys = (pad: number): string[] => [
    "k".repeat(pad) + "\u0001".repeat(20),
    "k".repeat(pad) + "\n".repeat(40),
  ];

  /**
   * The key pads swept: from 0 to past the whole detail cap, so a path cut
   * falls at every offset of the escapes, whatever share of the cap the path
   * gets (with a short or a long tool name). Each case also counts the
   * messages whose path was cut with an escape in its kept part, so the sweep
   * cannot pass without reaching the cut.
   */
  const PADS = Array.from({ length: MCP_FAKES_ECHO_LIMIT + 41 }, (_, pad) => pad);
  const NAMES = ["t", "n".repeat(1_000)];

  /** The path of `message`, from `start`, when it was cut: its kept part. */
  const cutPath = (message: string, start: string): string | null => {
    const at = message.indexOf(start);
    if (at === -1) return null;
    const end = message.indexOf("…", at);
    const next = message.indexOf(" ", at);
    return end !== -1 && (next === -1 || end < next) ? message.slice(at, end) : null;
  };

  const sweep = (
    raw: (name: string, key: string) => unknown,
    start: string,
  ): { checked: number; reached: number } => {
    let checked = 0;
    let reached = 0;
    for (const name of NAMES) {
      for (const pad of PADS) {
        for (const key of keys(pad)) {
          const errors = validateMcpFakes(raw(name, key), FILE).errors;
          expect(errors).toHaveLength(1);
          const message = errors[0].message;
          expectNoSplitEscape(message, `name ${name.length}, pad ${pad}`);
          checked += 1;
          const kept = cutPath(message, start);
          if (kept?.includes("\\")) reached += 1;
        }
      }
    }
    return { checked, reached };
  };

  it("in an args problem (jsonProblem)", () => {
    const { checked, reached } = sweep(
      (name, key) => shared([{ name, calls: [{ args: { [key]: NaN }, result: "x" }] }]),
      'args["',
    );
    expect(checked).toBe(NAMES.length * PADS.length * 2);
    expect(reached).toBeGreaterThan(10);
  });

  it("in a field check (inputSchema.properties)", () => {
    const { checked, reached } = sweep(
      (name, key) =>
        shared([
          {
            name,
            inputSchema: { type: "object", properties: { [key]: 5 } },
            calls: [OK_CALL],
          },
        ]),
      'inputSchema.properties["',
    );
    expect(checked).toBe(NAMES.length * PADS.length * 2);
    expect(reached).toBeGreaterThan(10);
  });

  it("in firstDifference (diffAt)", () => {
    for (let pad = 120; pad < MCP_FAKES_ECHO_LIMIT; pad++) {
      for (const key of keys(pad)) {
        for (const [expected, received] of [
          [{ [key]: 1 }, { [key]: 2 }],
          [{ [key]: 1 }, {}],
          [{}, { [key]: 1 }],
          [{ [key]: [1] }, { [key]: 1 }],
          [{ [key]: { a: 1 } }, { [key]: 1 }],
          [{ [key]: [1] }, { [key]: [1, 2] }],
        ] as const) {
          const diff = firstDifference(expected, received);
          expect(diff).not.toBe("");
          expectNoSplitEscape(diff, `pad ${pad}`);
        }
      }
    }
  });
});

describe("a long tool name never cuts the problem out of a bad-block detail", () => {
  const problemOf = (tool: Record<string, unknown>): string[] =>
    validateMcpFakes(shared([{ ...tool, name: "t" }]), FILE).errors.map((e) =>
      e.message.slice(e.message.indexOf('tool "t" ') + 'tool "t" '.length),
    );

  it.each([
    ["a call result (validateCall)", { calls: [{ args: {}, result: 5 }] }],
    ["an inputSchema problem", { inputSchema: { type: "array" }, calls: [OK_CALL] }],
    ["a description problem", { description: 5, calls: [OK_CALL] }],
    ["a calls problem", { calls: 5 }],
  ])("%s", (_label, tool) => {
    const problems = problemOf(tool);
    expect(problems).toHaveLength(1);
    for (const length of [150, 190, 1_000]) {
      const errors = validateMcpFakes(shared([{ ...tool, name: "n".repeat(length) }]), FILE).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0].message.endsWith(` ${problems[0]}`), errors[0].message).toBe(true);
    }
  });
});

describe("a long JSON path never cuts the problem out of a bad-block detail", () => {
  const problemsFor = (tool: Record<string, unknown>): string[] =>
    validateMcpFakes(shared([tool]), FILE).errors.map((e) => e.message);

  it.each([
    [
      "an args problem (jsonProblem)",
      (k: string) => ({ calls: [{ args: { [k]: NaN }, result: "x" }] }),
      "must be a finite number, got NaN",
    ],
    [
      "a result problem (jsonProblem)",
      (k: string) => ({ calls: [{ args: {}, result: { [k]: Infinity } }] }),
      "must be a finite number, got Infinity",
    ],
    [
      "an inputSchema.properties problem",
      (k: string) => ({
        inputSchema: { type: "object", properties: { [k]: 5 } },
        calls: [OK_CALL],
      }),
      "must be a JSON object, got 5",
    ],
  ])("%s", (_label, toolOf, problem) => {
    for (const name of ["t", "n".repeat(1_000)]) {
      for (const length of [1, 150, 200, 1_000]) {
        const errors = problemsFor({ name, ...toolOf("k".repeat(length)) });
        expect(errors).toHaveLength(1);
        expect(errors[0].endsWith(` ${problem}`), errors[0]).toBe(true);
      }
    }
  });
});

describe("origin must be an object", () => {
  it.each([["file"], ["code"], ["control-api"]])("a bare %j is bad block (i)", (kind) => {
    const store = new McpFakeStore();
    const err = addFails(one(shared([OK_TOOL])), kind, store);
    expect(err.rule).toBe("mcp-fakes/bad-block:i");
    expect(err.message).toContain(`origin must be an object { kind }, got ${JSON.stringify(kind)}`);
    expect(store.allEntryIds()).toEqual([]);
  });
});

describe("an invalid test-id cap is always a RangeError", () => {
  const hostile = {
    toString(): string {
      throw new Error("no");
    },
  };
  it.each([
    ["a symbol", Symbol("s")],
    ["an object whose toString throws", hostile],
    ["a bigint", 5n],
  ])("%s", (_name, cap) => {
    expect(() => new McpFakeStore({ maxTestIds: cap as unknown as number })).toThrow(RangeError);
    expect(() => new McpFakeStore().setMaxTestIds(cap as unknown as number)).toThrow(
      /must be a non-negative integer \(0 = unbounded\), got /,
    );
  });
});

describe("a cut part counts the chars it left out of that part", () => {
  /** `kept… (N more chars)` found by `re` (kept in group 1, N in group 2): kept length + N. */
  const shownPlusCut = (message: string, re: RegExp): number => {
    const m = re.exec(message);
    if (!m) throw new Error(`no cut part in: ${message}`);
    return m[1].length + Number(m[2]);
  };
  const LONG_NAME = "n".repeat(1_000);

  it("a long value in a field check (annotations.lastModified)", () => {
    const value = "z".repeat(300);
    for (const name of ["t", LONG_NAME]) {
      const [err] = validateMcpFakes(
        shared([
          {
            name,
            calls: [
              {
                args: {},
                result: [{ type: "text", text: "x", annotations: { lastModified: value } }],
              },
            ],
          },
        ]),
        FILE,
      ).errors;
      expect(err.message).toContain("must be an ISO 8601 date-time with seconds and an offset");
      expect(shownPlusCut(err.message, /got ("z*)… \((\d+) more chars\)/)).toBe(
        JSON.stringify(value).length,
      );
    }
  });

  it("a long key in a JSON path", () => {
    const key = "k".repeat(1_000);
    for (const name of ["t", LONG_NAME]) {
      const [err] = validateMcpFakes(
        shared([{ name, calls: [{ args: { [key]: NaN }, result: "x" }] }]),
        FILE,
      ).errors;
      expect(err.message.endsWith(" must be a finite number, got NaN")).toBe(true);
      expect(shownPlusCut(err.message, /(args\["k*)… \((\d+) more chars\)/)).toBe(
        `args[${JSON.stringify(key)}]`.length,
      );
    }
  });

  it("a long tool name", () => {
    const [err] = validateMcpFakes(shared([{ name: LONG_NAME, calls: 5 }]), FILE).errors;
    expect(shownPlusCut(err.message, /tool ("n*)… \((\d+) more chars\)/)).toBe(
      JSON.stringify(LONG_NAME).length,
    );
  });
});

describe("a long name or id never cuts the problem out of an (e) or (f) detail", () => {
  const LONG = "s".repeat(190);

  it("(e) a tool declared twice, with a long name", () => {
    for (const length of [1, 150, 195, 1_000]) {
      const name = "n".repeat(length);
      const errors = validateMcpFakes(
        shared([OK_TOOL, { ...OK_TOOL, name }, { ...OK_TOOL, name }]),
        FILE,
      ).errors;
      expect(errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:e"]);
      expect(errors[0].message.endsWith(" is declared twice in one block"), errors[0].message).toBe(
        true,
      );
    }
  });

  it("(f) an entry id that is not unique in one block, from a long source", () => {
    const errors = validateMcpFakes(
      shared([
        {
          name: "t",
          calls: [
            { id: "dup", anyArgs: true, result: "a" },
            { id: "dup", anyArgs: true, result: "b" },
          ],
        },
      ]),
      LONG,
    ).errors;
    expect(errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:f"]);
    expect(errors[0].message.endsWith(" is not unique"), errors[0].message).toBe(true);
  });

  // Source `S` with user id `x:y` and source `S:x` with user id `y` both have
  // the entry id `S:x:y`.
  const first = {
    source: LONG,
    blockIndex: null,
    raw: shared([{ name: "t", calls: [{ id: "x:y", anyArgs: true, result: "a" }] }]),
  };
  const second = {
    source: `${LONG}:x`,
    blockIndex: null,
    raw: shared([{ name: "t", calls: [{ id: "y", anyArgs: true, result: "b" }] }]),
  };

  it("(f) an entry id already loaded on the mount, with a long id and block id", () => {
    const store = new McpFakeStore();
    store.add([first], { kind: "file" });
    const err = addFails([second], { kind: "file" }, store);
    expect(err.errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:f"]);
    const { message } = err.errors[0];
    expect(message).toContain(" is already loaded on this mount, in block ");
    expect(message).toMatch(
      / is already loaded on this mount, in block "s+(?:… \(\d+ more chars\))?"?$/,
    );
  });

  it("(f) an entry id that collides earlier in the same input, with a long id and block id", () => {
    const err = addFails([first, second], { kind: "file" });
    expect(err.errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:f"]);
    const { message } = err.errors[0];
    expect(message.endsWith(" earlier in the same input"), message).toBe(true);
    expect(message).toContain(" collides with an entry of block ");
  });
});

describe("a value that is not JSON data renders quoted and escape-safe", () => {
  it("a nested string keeps its quotes and escapes; a nested bigint is a placeholder", () => {
    expect(firstDifference({ a: 1 }, { a: ["q\n", 2n] })).toBe(
      '$.a: expected 1, received ["q\\n",<a bigint (2n)>]',
    );
  });

  it("a cycle is a placeholder, and the rest of the value is kept", () => {
    const cyc: Record<string, unknown> = { k: "v\n" };
    cyc.self = cyc;
    expect(firstDifference({ a: 1 }, { a: cyc })).toBe(
      '$.a: expected 1, received {"k":"v\\n","self":<a circular reference>}',
    );
  });

  it("a throwing toJSON is a placeholder with the thrown text quoted, never the user toString", () => {
    const bad = {
      toString: () => "u\nv",
      toJSON: () => {
        throw new Error("boom\nx");
      },
    };
    expect(firstDifference({ a: 1 }, { a: { b: bad, c: 3 } })).toBe(
      '$.a: expected 1, received {"b":<an unreadable value (reading it threw "Error: boom\\nx")>,"c":3}',
    );
  });

  it("a throwing getter is a placeholder for that member only", () => {
    const obj = Object.defineProperty({ c: 3 }, "b", {
      enumerable: true,
      get: () => {
        throw new TypeError("no\u0000read");
      },
    });
    expect(echo(obj)).toBe(
      '{"c":3,"b":<an unreadable value (reading it threw "TypeError: no\\u0000read")>}',
    );
  });

  it("a symbol or a function is a placeholder with its text quoted", () => {
    expect(echo(Symbol("x\ny"))).toBe('<not a JSON value (got symbol): "Symbol(x\\ny)">');
    const fn = Object.assign(() => 1, { toString: () => 'f"\n' });
    expect(echo(fn)).toBe('<not a JSON value (got function): "f\\"\\n">');
  });

  it("a deep value renders to a bounded depth, with a placeholder below it", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const out = echo(deep, Infinity);
    expect(out).toBe(`${"[".repeat(64)}<nested deeper than 64 levels>${"]".repeat(64)}`);
  });

  it("no rendering has a raw control char", () => {
    const values: unknown[] = [["q\n", 2n], Symbol("\u001b"), { a: { b: [1n, "\t"] } }];
    for (const v of values) expect(echo(v, Infinity)).not.toMatch(/\p{Cc}/u);
  });
});
