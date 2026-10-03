import { describe, expect, it, vi } from "vitest";
import { FixtureLoadError } from "../fixture-loader.js";
import {
  McpFakeStore,
  McpFakesAddError,
  entryIds,
  firstDifference,
  mcpArgsEqual,
  toCallToolResult,
  validateMcpFakes,
  type McpFakeAddOrigin,
  type McpFakeAddResult,
  type McpFakeClaim,
} from "../mcp-fakes.js";
import type { McpFakeIdentity, McpFakeSource, Mountable } from "../types.js";

// ---------------------------------------------------------------------------
// helpers

function id(
  testId: string | null = null,
  context: string | null = null,
  undeclared: "allow" | "deny" | null = null,
): McpFakeIdentity {
  return { testId, context, undeclared };
}

function src(source: string, raw: unknown, blockIndex: number | null = null): McpFakeSource {
  return { source, blockIndex, raw };
}

function block(
  scope: unknown,
  tools: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { scope, tools, ...extra };
}

function tool(name: string, calls: unknown[], extra: Record<string, unknown> = {}) {
  return { name, calls, ...extra };
}

function storeWith(...sources: McpFakeSource[]): McpFakeStore {
  const store = new McpFakeStore();
  store.add(sources, { kind: "file" });
  return store;
}

function addError(store: McpFakeStore, sources: McpFakeSource[]): FixtureLoadError {
  try {
    store.add(sources, { kind: "file" });
  } catch (err) {
    expect(err).toBeInstanceOf(FixtureLoadError);
    return err as FixtureLoadError;
  }
  throw new Error("expected add() to throw FixtureLoadError");
}

/** Every error an add reported, each a FixtureLoadError. */
function allErrors(err: FixtureLoadError): FixtureLoadError[] {
  expect(err).toBeInstanceOf(McpFakesAddError);
  return [...(err as McpFakesAddError).errors];
}

function answerText(claim: McpFakeClaim): string {
  if (claim.kind !== "answer") throw new Error(`expected answer, got ${claim.kind}`);
  const first = claim.result.content[0] as { text?: string } | undefined;
  return first?.text ?? "";
}

const SHARED_OK = block("shared", [tool("t", [{ anyArgs: true, result: "ok" }])]);

// ---------------------------------------------------------------------------
// bad block (a)-(j)

describe("bad block: one FixtureLoadError per case", () => {
  const FILE = "cases.json";

  const cases: Array<{
    letter: string;
    what: string;
    raw: unknown;
    blockIndex?: number | null;
    entryId: string | null;
    sources?: McpFakeSource[];
  }> = [
    {
      letter: "a",
      what: "no scope",
      raw: { tools: [tool("t", [{ anyArgs: true, result: "x" }])] },
      entryId: null,
    },
    {
      letter: "b",
      what: "malformed scope (object with neither key)",
      raw: block({}, [tool("t", [{ anyArgs: true, result: "x" }])]),
      entryId: null,
    },
    {
      letter: "c",
      what: "shared + deny",
      raw: block("shared", [tool("t", [{ anyArgs: true, result: "x" }])], {
        undeclaredTools: "deny",
      }),
      entryId: null,
    },
    {
      letter: "d",
      what: "call entry with both result and error",
      raw: block({ testId: "T" }, [tool("t", [{ args: {}, result: "x", error: "y" }])]),
      entryId: "cases.json:t#0",
    },
    {
      letter: "e",
      what: "same tool twice",
      raw: block({ testId: "T" }, [
        tool("t", [{ anyArgs: true, result: "x" }]),
        tool("t", [{ anyArgs: true, result: "y" }]),
      ]),
      entryId: null,
    },
    {
      letter: "f",
      what: "entry-id collision inside one block",
      raw: block({ testId: "T" }, [
        tool("get_weather", [
          { id: "get_weather#1", args: { city: "A" }, result: "a" },
          { args: { city: "B" }, result: "b" },
        ]),
      ]),
      entryId: "cases.json:get_weather#1",
    },
    {
      letter: "g",
      what: "empty calls",
      raw: block({ testId: "T" }, [tool("t", [])]),
      entryId: null,
    },
    {
      letter: "h",
      what: "misspelled undeclaredTool",
      raw: block({ testId: "T" }, [tool("t", [{ anyArgs: true, result: "x" }])], {
        undeclaredTool: "deny",
      }),
      entryId: null,
    },
    {
      letter: "i",
      what: "array element that is not an object",
      raw: 42,
      blockIndex: 1,
      entryId: null,
    },
    {
      letter: "j",
      what: "anyArgs not true",
      raw: block({ testId: "T" }, [tool("t", [{ id: "e1", anyArgs: false, result: "x" }])]),
      entryId: "cases.json:e1",
    },
  ];

  it.each(cases)("($letter) $what", ({ letter, raw, blockIndex = null, entryId }) => {
    const store = new McpFakeStore();
    const err = addError(store, [src(FILE, raw, blockIndex)]);
    expect(err.rule).toBe(`mcp-fakes/bad-block:${letter}`);
    expect(err.file).toBe(FILE);
    expect(err.blockId).toBe(blockIndex === null ? FILE : `${FILE}[${blockIndex}]`);
    expect(err.entryId ?? null).toBe(entryId);
    const blockId = blockIndex === null ? FILE : `${FILE}[${blockIndex}]`;
    const q = (text: string): string => JSON.stringify(text);
    const where = [
      q(FILE),
      `block ${q(blockId)}`,
      ...(entryId === null ? [] : [`entry ${q(entryId)}`]),
    ];
    const prefix = `${where.join(", ")}: [mcp-fakes/bad-block:${letter}] `;
    expect(err.message.slice(0, prefix.length)).toBe(prefix);
    // every error found is reported, and this input has exactly one
    expect(allErrors(err).map((e) => e.rule)).toEqual([`mcp-fakes/bad-block:${letter}`]);
    // nothing added (allEntryIds is not filtered by scope; snapshot(null, null) is)
    expect(store.allEntryIds()).toEqual([]);
  });

  it("validateMcpFakes returns one FixtureLoadError per bad block", () => {
    const { blocks, errors } = validateMcpFakes(
      [
        block("shared", [tool("t", [{ anyArgs: true, result: "x" }])], {
          undeclaredTools: "deny",
        }),
        block({ testId: "T" }, [tool("u", [{ args: { a: 1 } }])]),
        "nope",
      ],
      "v.json",
    );
    expect(blocks).toEqual([]);
    expect(errors.map((e) => [e.rule, e.blockId, e.entryId ?? null])).toEqual([
      ["mcp-fakes/bad-block:c", "v.json[0]", null],
      ["mcp-fakes/bad-block:d", "v.json[1]", "v.json[1]:u#0"],
      ["mcp-fakes/bad-block:i", "v.json[2]", null],
    ]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(FixtureLoadError);
      expect(e.file).toBe("v.json");
    }
  });

  it("(i) mcpFakes that is neither object nor array is not tied to a block", () => {
    const { errors } = validateMcpFakes("bad", "s.json");
    expect(errors.map((e) => e.toJSON())).toEqual([
      {
        name: "FixtureLoadError",
        rule: "mcp-fakes/bad-block:i",
        file: "s.json",
        blockId: null,
        entryId: null,
        message:
          '"s.json": [mcp-fakes/bad-block:i] mcpFakes must be an object or an array, got "bad"',
      },
    ]);
  });

  it.each([
    ["scope a number", 7],
    ["scope null", null],
    ["scope an array", []],
    ["scope unknown key", { testId: "T", tid: "x" }],
    ["scope empty testId", { testId: "" }],
    ["scope non-string context", { context: 3 }],
    ["scope string other than shared", "global"],
  ])("(b) %s", (_what, scope) => {
    const { errors } = validateMcpFakes(
      block(scope, [tool("t", [{ anyArgs: true, result: "x" }])]),
      "b.json",
    );
    expect(errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:b"]);
  });

  it.each([
    ["tools missing", { scope: "shared" }],
    ["tools not an array", { scope: "shared", tools: {} }],
    ["tool without string name", block("shared", [{ calls: [{ anyArgs: true, result: "x" }] }])],
    ["tool not an object", block("shared", ["t"])],
    ["calls missing", block("shared", [{ name: "t" }])],
    ["calls not an array", block("shared", [{ name: "t", calls: {} }])],
    [
      "undeclaredTools invalid",
      block("shared", [tool("t", [{ anyArgs: true, result: "x" }])], { undeclaredTools: "Deny" }),
    ],
    [
      "mount without leading slash",
      block("shared", [tool("t", [{ anyArgs: true, result: "x" }])], { mount: "mcp" }),
    ],
    [
      "mount not a string",
      block("shared", [tool("t", [{ anyArgs: true, result: "x" }])], { mount: 1 }),
    ],
    [
      "description not a string",
      block("shared", [tool("t", [{ anyArgs: true, result: "x" }], { description: 1 })]),
    ],
    [
      "inputSchema not an object",
      block("shared", [tool("t", [{ anyArgs: true, result: "x" }], { inputSchema: [] })]),
    ],
  ])("(g) %s", (_what, raw) => {
    const { errors } = validateMcpFakes(raw, "g.json");
    expect(errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:g"]);
    expect(errors[0].entryId ?? null).toBeNull();
  });

  it.each([
    ["neither args nor anyArgs", { result: "x" }],
    ["both args and anyArgs", { args: {}, anyArgs: true, result: "x" }],
    ["neither result nor error", { args: {} }],
    ["args an array", { args: [1], result: "x" }],
    ["args null", { args: null, result: "x" }],
    ["error not a string", { args: {}, error: 1 }],
    ["result a number", { args: {}, result: 1 }],
    ["result null", { args: {}, result: null }],
    ["result array element not a content object", { args: {}, result: ["x"] }],
    ["id empty", { id: "", args: {}, result: "x" }],
    ["id not a string", { id: 3, args: {}, result: "x" }],
    ["entry not an object", "x"],
  ])("(d) %s", (_what, entry) => {
    const { errors } = validateMcpFakes(block("shared", [tool("t", [entry])]), "d.json");
    expect(errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:d"]);
    expect(errors[0].entryId).toBe("d.json:t#0");
  });

  it.each([
    [
      "unknown key on a tool",
      block("shared", [tool("t", [{ anyArgs: true, result: "x" }], { x: 1 })]),
    ],
    [
      "unknown key on a call",
      block("shared", [tool("t", [{ anyArgs: true, result: "x", why: 1 }])]),
    ],
  ])("(h) %s", (_what, raw) => {
    const { errors } = validateMcpFakes(raw, "h.json");
    expect(errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:h"]);
  });

  it.each([
    ["string 'true'", "true"],
    ["1", 1],
    ["null", null],
  ])("(j) anyArgs %s", (_w, v) => {
    const { errors } = validateMcpFakes(
      block("shared", [tool("t", [{ anyArgs: v, result: "x" }])]),
      "j.json",
    );
    expect(errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:j"]);
    expect(errors[0].entryId).toBe("j.json:t#0");
  });

  it("accepts shared + allow and shared with no undeclaredTools", () => {
    expect(validateMcpFakes(SHARED_OK, "ok.json").errors).toEqual([]);
    const allow = { ...SHARED_OK, undeclaredTools: "allow" };
    expect(validateMcpFakes(allow, "ok.json").errors).toEqual([]);
  });

  it("an invalid input adds nothing, not even its valid blocks", () => {
    const store = new McpFakeStore();
    addError(store, [
      src("m.json", SHARED_OK, 0),
      src("m.json", block({}, [tool("t", [{ anyArgs: true, result: "x" }])]), 1),
    ]);
    expect(store.allEntryIds()).toEqual([]);
    expect(store.claim("t", {}, id())).toEqual({ kind: "none" });
  });
});

// ---------------------------------------------------------------------------
// entry ids and counters

describe("entry id grammar and counters", () => {
  const weather = block({ testId: "weather › seattle" }, [
    tool("get_weather", [{ args: { city: "Seattle" }, result: "rain" }]),
  ]);

  it("entry id examples", () => {
    const store = new McpFakeStore();
    store.add([src("weather/seattle.json", weather)], { kind: "file" });
    store.add(
      [
        src(
          "tickets/retry.json",
          block({ testId: "tickets › retry on timeout" }, [
            tool("create_ticket", [
              { id: "first-try", args: { title: "Refund" }, error: "upstream timeout" },
              { id: "retry", args: { title: "Refund" }, result: "TICKET-42" },
            ]),
          ]),
        ),
      ],
      { kind: "file" },
    );
    store.add(
      [
        src("multi.json", block("shared", [tool("other", [{ anyArgs: true, result: "o" }])]), 0),
        src(
          "multi.json",
          block("shared", [tool("get_weather", [{ anyArgs: true, result: "m" }])]),
          1,
        ),
      ],
      { kind: "file" },
    );
    expect(store.allEntryIds()).toEqual([
      "weather/seattle.json:get_weather#0",
      "tickets/retry.json:first-try",
      "tickets/retry.json:retry",
      "multi.json[0]:other#0",
      "multi.json[1]:get_weather#0",
    ]);
  });

  it("code#<n> counts run-time additions; control-api shares the counter", () => {
    const store = new McpFakeStore();
    const b = (name: string) => [
      src("ignored", block("shared", [tool(name, [{ anyArgs: true, result: "x" }])])),
    ];
    store.add(b("a"), { kind: "code" });
    store.add(b("b"), { kind: "control-api" });
    store.add(b("get_weather"), { kind: "code" });
    expect(store.allEntryIds()).toEqual([
      "code#1:a#0",
      "control-api#2:b#0",
      "code#3:get_weather#0",
    ]);
  });

  it("@<k> marks the k-th load of the same source string; never rewound by clear()", () => {
    const store = new McpFakeStore();
    store.add([src("weather/seattle.json", weather)], { kind: "file" });
    store.add([src("weather/seattle.json", weather)], { kind: "file" });
    expect(store.allEntryIds()).toEqual([
      "weather/seattle.json:get_weather#0",
      "weather/seattle.json@2:get_weather#0",
    ]);
    store.clear();
    expect(store.allEntryIds()).toEqual([]);
    store.add([src("weather/seattle.json", weather)], { kind: "file" });
    store.add([src("x", SHARED_OK)], { kind: "code" });
    store.clear();
    store.add([src("x", SHARED_OK)], { kind: "code" });
    expect(store.allEntryIds()).toEqual(["code#2:t#0"]);
    store.clear();
    store.add([src("weather/seattle.json", weather)], { kind: "file" });
    expect(store.allEntryIds()).toEqual(["weather/seattle.json@4:get_weather#0"]);
  });

  it("an array load with block index keeps one load suffix for the whole load", () => {
    const store = new McpFakeStore();
    const two = [
      src("m.json", block("shared", [tool("a", [{ anyArgs: true, result: "x" }])]), 0),
      src("m.json", block("shared", [tool("b", [{ anyArgs: true, result: "x" }])]), 1),
    ];
    store.add(two, { kind: "file" });
    store.add(two, { kind: "file" });
    expect(store.allEntryIds()).toEqual([
      "m.json[0]:a#0",
      "m.json[1]:b#0",
      "m.json@2[0]:a#0",
      "m.json@2[1]:b#0",
    ]);
  });

  it("entryIds() derives ids for a block", () => {
    expect(
      entryIds(
        { blockIndex: 1, tools: [{ name: "w", calls: [{}, { id: "named" }] }] },
        "multi.json",
        "@2",
      ),
    ).toEqual(["multi.json@2[1]:w#0", "multi.json@2[1]:named"]);
  });

  it("a failed add does not consume a counter", () => {
    const store = new McpFakeStore();
    addError(store, [src("w.json", { tools: [] })]);
    store.add([src("w.json", weather)], { kind: "file" });
    expect(store.allEntryIds()).toEqual(["w.json:get_weather#0"]);
  });
});

// ---------------------------------------------------------------------------
// entry-id uniqueness

describe("entry-id uniqueness: the later block fails, the earlier is unaffected", () => {
  it("across loads: a.json id 'x:y' vs a.json:x id 'y'", () => {
    const store = new McpFakeStore();
    store.add(
      [
        src(
          "a.json",
          block("shared", [tool("t", [{ id: "x:y", anyArgs: true, result: "first" }])]),
        ),
      ],
      { kind: "file" },
    );
    const err = addError(store, [
      src("a.json:x", block("shared", [tool("u", [{ id: "y", anyArgs: true, result: "second" }])])),
    ]);
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(err.file).toBe("a.json:x");
    expect(err.blockId).toBe("a.json:x");
    expect(err.entryId).toBe("a.json:x:y");
    expect(store.allEntryIds()).toEqual(["a.json:x:y"]);
    expect(answerText(store.claim("t", {}, id()))).toBe("first");
    expect(store.claim("u", {}, id())).toEqual({ kind: "none" });
  });

  it("inside one input: the later block is named, nothing is added", () => {
    const store = new McpFakeStore();
    const err = addError(store, [
      src("a.json", block("shared", [tool("t", [{ id: "x:y", anyArgs: true, result: "1" }])])),
      src("a.json:x", block("shared", [tool("u", [{ id: "y", anyArgs: true, result: "2" }])])),
    ]);
    expect(err.blockId).toBe("a.json:x");
    expect(store.allEntryIds()).toEqual([]);
  });

  it("inside one block: user id equal to another entry's default local", () => {
    const { errors } = validateMcpFakes(
      block("shared", [
        tool("get_weather", [
          { anyArgs: true, result: "a" },
          { id: "get_weather#0", anyArgs: true, result: "b" },
        ]),
      ]),
      "b.json",
    );
    expect(errors.map((e) => [e.rule, e.entryId])).toEqual([
      ["mcp-fakes/bad-block:f", "b.json:get_weather#0"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// store add: run-time block ids, error aggregation, counters, empty input

describe("store add: ids, counters, uniqueness, errors, warnings", () => {
  const T = (name: string, scope: unknown = "shared") =>
    block(scope, [tool(name, [{ anyArgs: true, result: name }])]);

  function runtimeError(
    store: McpFakeStore,
    sources: McpFakeSource[],
    kind: "code" | "control-api" = "code",
  ): FixtureLoadError {
    try {
      store.add(sources, { kind });
    } catch (err) {
      expect(err).toBeInstanceOf(FixtureLoadError);
      return err as FixtureLoadError;
    }
    throw new Error("expected add() to throw FixtureLoadError");
  }

  it("a run-time add of several single-object blocks numbers them by position", () => {
    const store = new McpFakeStore();
    store.add([src("a.ts", T("t")), src("b.ts", T("t"))], { kind: "code" });
    expect(store.allEntryIds()).toEqual(["code#1[0]:t#0", "code#1[1]:t#0"]);
  });

  it("a run-time add of blocks with equal indexes from different sources does not collide", () => {
    const store = new McpFakeStore();
    store.add([src("a.json", T("t"), 0), src("b.json", T("t"), 0)], { kind: "control-api" });
    expect(store.allEntryIds()).toEqual(["control-api#1[0]:t#0", "control-api#1[1]:t#0"]);
  });

  it("a run-time add keeps the single-object and one-element-array forms apart", () => {
    const store = new McpFakeStore();
    store.add([src("x", T("a"))], { kind: "code" });
    store.add([src("x", T("b"), 0)], { kind: "code" });
    expect(store.allEntryIds()).toEqual(["code#1:a#0", "code#2[0]:b#0"]);
  });

  it("a collision inside one input is not called 'already loaded on this mount'", () => {
    const store = new McpFakeStore();
    const err = addError(store, [
      src("a.json", block("shared", [tool("t", [{ id: "x:y", anyArgs: true, result: "1" }])])),
      src("a.json:x", block("shared", [tool("u", [{ id: "y", anyArgs: true, result: "2" }])])),
    ]);
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(err.message).toBe(
      '"a.json:x", block "a.json:x", entry "a.json:x:y": [mcp-fakes/bad-block:f] entry id "a.json:x:y" collides with an entry of block "a.json" earlier in the same input',
    );
  });

  it("a collision with an earlier load says 'already loaded on this mount'", () => {
    const store = new McpFakeStore();
    store.add(
      [src("a.json", block("shared", [tool("t", [{ id: "x:y", anyArgs: true, result: "1" }])]))],
      {
        kind: "file",
      },
    );
    const err = addError(store, [
      src("a.json:x", block("shared", [tool("u", [{ id: "y", anyArgs: true, result: "2" }])])),
    ]);
    expect(err.message).toBe(
      '"a.json:x", block "a.json:x", entry "a.json:x:y": [mcp-fakes/bad-block:f] entry id "a.json:x:y" is already loaded on this mount, in block "a.json"',
    );
  });

  it("add() reports every error found, in order, and the passing blocks' warnings", () => {
    const store = new McpFakeStore();
    store.add(
      [src("a.json", block("shared", [tool("t", [{ id: "x:y", anyArgs: true, result: "1" }])]))],
      {
        kind: "file",
      },
    );
    const shadowing = block({ testId: "T" }, [
      tool("w", [
        { anyArgs: true, result: "any" },
        { args: { a: 1 }, result: "specific" },
      ]),
    ]);
    const err = addError(store, [
      src("m.json", shadowing, 0),
      src("m.json", { tools: [tool("t", [{ anyArgs: true, result: "x" }])] }, 1),
      src("m.json", block("shared", [tool("t", [{ id: "x", anyArgs: "yes", result: "x" }])]), 2),
      src("a.json:x", block("shared", [tool("u", [{ id: "y", anyArgs: true, result: "2" }])])),
    ]);
    // the thrown error carries the first error's rule, file and block id
    expect(err.rule).toBe("mcp-fakes/bad-block:a");
    expect(err.file).toBe("m.json");
    expect(err.blockId).toBe("m.json[1]");
    const errors = allErrors(err);
    expect(err.message).toBe(`${errors[0].message} (and 2 more errors)`);
    expect(errors.map((e) => [e.rule, e.file, e.blockId, e.entryId ?? null])).toEqual([
      ["mcp-fakes/bad-block:a", "m.json", "m.json[1]", null],
      ["mcp-fakes/bad-block:j", "m.json", "m.json[2]", "m.json[2]:x"],
      ["mcp-fakes/bad-block:f", "a.json:x", "a.json:x", "a.json:x:y"],
    ]);
    for (const e of errors) expect(e).toBeInstanceOf(FixtureLoadError);
    expect((err as McpFakesAddError).warnings.map((w) => w.entryId)).toEqual(["m.json[0]:w#1"]);
    const json = (err as McpFakesAddError).toJSON();
    expect(json.name).toBe("McpFakesAddError");
    expect(json.errors.map((e) => e.rule)).toEqual(errors.map((e) => e.rule));
    expect(store.allEntryIds()).toEqual(["a.json:x:y"]);
  });

  it("a file add groups loads by source and rising blockIndex, and reports every block's errors in input order", () => {
    const store = new McpFakeStore();
    const noScope = { tools: [tool("t", [{ anyArgs: true, result: "x" }])] };
    const err = addError(store, [
      src("a.json", T("ok"), 0), // a.json, load 1
      src("a.json", noScope, 1), // index rises: same load, a.json[1]
      src("a.json", noScope, 0), // index does not rise: load 2, a.json@2[0]
      src("a.json", T("ok2"), 2), // index rises: still load 2
      src("b.json", noScope, 0), // another source: b.json, load 1
      src("a.json", noScope, 3), // back to a.json after another source: load 3
    ]);
    const errors = allErrors(err);
    expect(errors.map((e) => [e.rule, e.file, e.blockId])).toEqual([
      ["mcp-fakes/bad-block:a", "a.json", "a.json[1]"],
      ["mcp-fakes/bad-block:a", "a.json", "a.json@2[0]"],
      ["mcp-fakes/bad-block:a", "b.json", "b.json[0]"],
      ["mcp-fakes/bad-block:a", "a.json", "a.json@3[3]"],
    ]);
    expect(err.message).toBe(
      '"a.json", block "a.json[1]": [mcp-fakes/bad-block:a] block has no scope (and 3 more errors)',
    );
    // Nothing was added and no load counter was used: the same input, fixed, loads the same ids.
    expect(store.allEntryIds()).toEqual([]);
    store.add(
      [
        src("a.json", T("ok"), 0),
        src("a.json", T("x1"), 1),
        src("a.json", T("x2"), 0),
        src("a.json", T("ok2"), 2),
        src("b.json", T("x3"), 0),
        src("a.json", T("x4"), 3),
      ],
      { kind: "file" },
    );
    expect(store.allEntryIds()).toEqual([
      "a.json[0]:ok#0",
      "a.json[1]:x1#0",
      "a.json@2[0]:x2#0",
      "a.json@2[2]:ok2#0",
      "b.json[0]:x3#0",
      "a.json@3[3]:x4#0",
    ]);
  });

  it("collisions after a bad block in the same input are still found", () => {
    const store = new McpFakeStore();
    const err = addError(store, [
      src("m.json", { tools: [] }, 0),
      src("p.json", block("shared", [tool("t", [{ id: "q:r", anyArgs: true, result: "1" }])])),
      src("p.json:q", block("shared", [tool("u", [{ id: "r", anyArgs: true, result: "2" }])])),
    ]);
    expect(allErrors(err).map((e) => [e.rule, e.entryId ?? null])).toEqual([
      ["mcp-fakes/bad-block:a", null],
      ["mcp-fakes/bad-block:g", null],
      ["mcp-fakes/bad-block:f", "p.json:q:r"],
    ]);
  });

  it("an empty add is rejected and does not consume a code#<n> counter", () => {
    const store = new McpFakeStore();
    const err = runtimeError(store, []);
    expect(err.rule).toBe("mcp-fakes/bad-block:i");
    expect(err.blockId ?? null).toBeNull();
    store.add([src("x", T("t"))], { kind: "code" });
    expect(store.allEntryIds()).toEqual(["code#1:t#0"]);
  });

  it("an empty file add is rejected and adds nothing", () => {
    const store = new McpFakeStore();
    const err = addError(store, []);
    expect(err.rule).toBe("mcp-fakes/bad-block:i");
    expect(err.file).toBeNull();
    expect(store.allEntryIds()).toEqual([]);
  });

  it("a failed run-time add does not consume a code#<n> counter", () => {
    const store = new McpFakeStore();
    const err = runtimeError(store, [src("x", { tools: [] })], "control-api");
    expect(err.file).toBe("control-api#1");
    store.add([src("x", T("t"))], { kind: "code" });
    expect(store.allEntryIds()).toEqual(["code#1:t#0"]);
  });

  it("an empty mcpFakes array is a bad block (i)", () => {
    const { blocks, errors } = validateMcpFakes([], "e.json");
    expect(blocks).toEqual([]);
    expect(errors.map((e) => [e.rule, e.file, e.blockId])).toEqual([
      ["mcp-fakes/bad-block:i", "e.json", null],
    ]);
  });

  it.each([
    ["shared", "shared", {}],
    ["scoped, no undeclaredTools", { testId: "T" }, {}],
    ["scoped, allow", { testId: "T" }, { undeclaredTools: "allow" }],
  ])(
    "an empty tools array on a block that does nothing is a bad block (g): %s",
    (_w, scope, extra) => {
      const { errors } = validateMcpFakes(block(scope, [], extra), "g.json");
      expect(errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:g"]);
      const store = new McpFakeStore();
      expect(addError(store, [src("g.json", block(scope, [], extra))]).rule).toBe(
        "mcp-fakes/bad-block:g",
      );
      expect(store.allEntryIds()).toEqual([]);
    },
  );

  it("an empty tools array on a scoped deny block is accepted (closes the world)", () => {
    const store = new McpFakeStore();
    store.add([src("d.json", block({ testId: "T" }, [], { undeclaredTools: "deny" }))], {
      kind: "file",
    });
    expect(store.policy(id("T"))).toBe("deny");
  });

  it("Mountable.addMcpFakes takes an origin and returns the shadowed-entry warnings", () => {
    const store = new McpFakeStore();
    const mount: Pick<Mountable, "addMcpFakes"> = {
      addMcpFakes: (sources: McpFakeSource[], origin: McpFakeAddOrigin): McpFakeAddResult =>
        store.add(sources, origin),
    };
    const raw = block({ testId: "T" }, [
      tool("w", [
        { anyArgs: true, result: "any" },
        { args: { a: 1 }, result: "specific" },
      ]),
    ]);
    const result = mount.addMcpFakes?.([src("ignored", raw)], { kind: "code" });
    expect(result?.warnings.map((w) => w.message)).toEqual([
      'entry "code#1:w#1" is shadowed until the preceding anyArgs entry "code#1:w#0" is consumed',
    ]);
  });
});

// ---------------------------------------------------------------------------
// scope matching

describe("exact scope matching, no slug", () => {
  const store = storeWith(
    src(
      "a.json",
      block({ testId: "a.spec.ts › login" }, [tool("t", [{ anyArgs: true, result: "A" }])]),
    ),
    src(
      "b.json",
      block({ testId: "b.spec.ts › login" }, [tool("t", [{ anyArgs: true, result: "B" }])]),
    ),
    src("c.json", block({ context: "Refund: v1" }, [tool("c", [{ anyArgs: true, result: "C" }])])),
    src("s.json", block({ testId: "login" }, [tool("slug", [{ anyArgs: true, result: "S" }])])),
  );

  it("a.spec vs b.spec stay separate", () => {
    expect(store.applicable(id("a.spec.ts › login")).map((b) => b.blockId)).toEqual(["a.json"]);
    expect(store.applicable(id("b.spec.ts › login")).map((b) => b.blockId)).toEqual(["b.json"]);
  });

  it("context is case- and punctuation-sensitive", () => {
    expect(store.applicable(id(null, "Refund: v1")).map((b) => b.blockId)).toEqual(["c.json"]);
    expect(store.applicable(id(null, "refund v1"))).toEqual([]);
  });

  it("a slug-form scope does not match the full id, and vice versa", () => {
    expect(store.applicable(id("a.spec.ts › login")).map((b) => b.blockId)).not.toContain("s.json");
    expect(store.applicable(id("login")).map((b) => b.blockId)).toEqual(["s.json"]);
  });

  it("a request with neither sees only shared blocks; both-keys scope needs both", () => {
    const s = storeWith(
      src("sh.json", SHARED_OK),
      src(
        "both.json",
        block({ testId: "T", context: "C" }, [tool("t", [{ anyArgs: true, result: "both" }])]),
      ),
    );
    expect(s.applicable(id()).map((b) => b.blockId)).toEqual(["sh.json"]);
    expect(s.applicable(id("T")).map((b) => b.blockId)).toEqual(["sh.json"]);
    expect(s.applicable(id(null, "C")).map((b) => b.blockId)).toEqual(["sh.json"]);
    expect(s.applicable(id("T", "C")).map((b) => b.blockId)).toEqual(["sh.json", "both.json"]);
  });
});

// ---------------------------------------------------------------------------
// tiers

describe("tier replacement", () => {
  const store = storeWith(
    src(
      "shared.json",
      block("shared", [
        tool("get_weather", [{ anyArgs: true, result: "shared" }]),
        tool("only_shared", [{ anyArgs: true, result: "s2" }]),
      ]),
    ),
    src(
      "ctx.json",
      block({ context: "C" }, [tool("get_weather", [{ anyArgs: true, result: "context" }])]),
    ),
    src(
      "tid.json",
      block({ testId: "T" }, [tool("get_weather", [{ anyArgs: true, result: "testId" }])]),
    ),
    src(
      "both.json",
      block({ testId: "T", context: "C" }, [
        tool("get_weather", [{ anyArgs: true, result: "both" }]),
      ]),
    ),
  );

  it("most specific tier that declares the tool wins", () => {
    expect(store.selectTier("get_weather", id("T", "C"))?.tier).toBe("testId+context");
    expect(store.selectTier("get_weather", id("T"))?.tier).toBe("testId");
    expect(store.selectTier("get_weather", id(null, "C"))?.tier).toBe("context");
    expect(store.selectTier("get_weather", id())?.tier).toBe("shared");
    expect(store.selectTier("only_shared", id("T", "C"))?.tier).toBe("shared");
    expect(store.selectTier("nope", id("T"))).toBeNull();
  });

  it("lower tiers are ignored for that tool: scoped entry used up → exhausted, not shared", () => {
    const s = storeWith(
      src("shared.json", block("shared", [tool("w", [{ anyArgs: true, result: "shared" }])])),
      src("tid.json", block({ testId: "T" }, [tool("w", [{ anyArgs: true, result: "scoped" }])])),
    );
    expect(answerText(s.claim("w", {}, id("T")))).toBe("scoped");
    expect(s.claim("w", {}, id("T")).kind).toBe("exhausted");
    expect(answerText(s.claim("w", {}, id("U")))).toBe("shared");
  });
});

// ---------------------------------------------------------------------------
// selection

describe("ordered consumption", () => {
  it("same tool and arguments: declaration order, then exhausted", () => {
    const store = storeWith(
      src(
        "tickets/retry.json",
        block({ testId: "tickets › retry on timeout" }, [
          tool("create_ticket", [
            { id: "first-try", args: { title: "Refund" }, error: "upstream timeout" },
            { id: "retry", args: { title: "Refund" }, result: "TICKET-42" },
          ]),
        ]),
      ),
    );
    const who = id("tickets › retry on timeout");
    const c1 = store.claim("create_ticket", { title: "Refund" }, who);
    expect(c1.kind).toBe("answer");
    if (c1.kind === "answer") {
      expect(c1.entry.id).toBe("tickets/retry.json:first-try");
      expect(c1.result).toEqual({
        content: [{ type: "text", text: "upstream timeout" }],
        isError: true,
      });
    }
    expect(answerText(store.claim("create_ticket", { title: "Refund" }, who))).toBe("TICKET-42");
    expect(store.claim("create_ticket", { title: "Refund" }, who)).toEqual({
      kind: "exhausted",
      tool: "create_ticket",
      received: { title: "Refund" },
      matchingDeclared: 2,
      matchingConsumed: 2,
      matchingIds: ["tickets/retry.json:first-try", "tickets/retry.json:retry"],
    });
  });

  it("cross-argument independence: each call finds its own entry in any order", () => {
    const store = storeWith(
      src(
        "w.json",
        block({ testId: "T" }, [
          tool("get_weather", [
            { args: { city: "Seattle" }, result: "rain" },
            { args: { city: "Paris" }, result: "sun" },
          ]),
        ]),
      ),
    );
    expect(answerText(store.claim("get_weather", { city: "Paris" }, id("T")))).toBe("sun");
    expect(answerText(store.claim("get_weather", { city: "Seattle" }, id("T")))).toBe("rain");
  });

  it("mixed args/anyArgs: first unconsumed match in declaration order", () => {
    const store = storeWith(
      src(
        "m.json",
        block({ testId: "T" }, [
          tool("w", [
            { args: { city: "Seattle" }, result: "S" },
            { anyArgs: true, result: "any" },
          ]),
        ]),
      ),
    );
    expect(answerText(store.claim("w", { city: "Paris" }, id("T")))).toBe("any");
    expect(answerText(store.claim("w", { city: "Seattle" }, id("T")))).toBe("S");
    const c = store.claim("w", { city: "Seattle" }, id("T"));
    expect(c.kind).toBe("exhausted");
    if (c.kind === "exhausted") {
      expect(c.matchingIds).toEqual(["m.json:w#0", "m.json:w#1"]);
    }
  });

  it("mismatch names every declared entry and the first difference against the closest", () => {
    const store = storeWith(
      src(
        "weather/seattle.json",
        block({ testId: "weather › seattle" }, [
          tool("get_weather", [
            { args: { city: "Portland", units: "C" }, result: "x" },
            { args: { city: "Seattle", units: "F" }, result: "rain" },
          ]),
        ]),
      ),
    );
    const c = store.claim("get_weather", { city: "seattle", units: "F" }, id("weather › seattle"));
    expect(c).toEqual({
      kind: "mismatch",
      tool: "get_weather",
      received: { city: "seattle", units: "F" },
      declared: [
        {
          id: "weather/seattle.json:get_weather#0",
          args: { city: "Portland", units: "C" },
          consumed: false,
        },
        {
          id: "weather/seattle.json:get_weather#1",
          args: { city: "Seattle", units: "F" },
          consumed: false,
        },
      ],
      firstDifference: '$.city: expected "Seattle", received "seattle"',
    });
  });

  it("absent arguments are {}; non-object arguments only match anyArgs", () => {
    const store = storeWith(
      src(
        "e.json",
        block({ testId: "T" }, [
          tool("e", [
            { args: {}, result: "empty" },
            { args: {}, result: "again" },
          ]),
        ]),
      ),
      src(
        "n.json",
        block({ testId: "N" }, [
          tool("n", [
            { args: {}, result: "x" },
            { anyArgs: true, result: "any" },
          ]),
        ]),
      ),
    );
    expect(answerText(store.claim("e", undefined, id("T")))).toBe("empty");
    expect(answerText(store.claim("n", "a string", id("N")))).toBe("any");
    // anyArgs is used up, so a non-object now finds its match consumed
    expect(store.claim("n", [1], id("N")).kind).toBe("exhausted");
    // only args entries declared: a non-object never matches
    const c = store.claim("e", [1], id("T"));
    expect(c.kind).toBe("mismatch");
    if (c.kind === "mismatch")
      expect(c.firstDifference).toBe("$: expected an object, received [1]");
  });

  it("a tool no applicable block declares → none", () => {
    const store = storeWith(src("s.json", SHARED_OK));
    expect(store.claim("other", {}, id())).toEqual({ kind: "none" });
  });

  it("claim is synchronous", () => {
    const store = storeWith(src("s.json", SHARED_OK));
    const result: unknown = store.claim("t", {}, id());
    expect(result instanceof Promise).toBe(false);
  });

  it("a non-JSON result is rejected at load, before any claim", () => {
    const store = new McpFakeStore();
    const err = addError(store, [
      src(
        "big.json",
        block({ testId: "T" }, [tool("t", [{ anyArgs: true, result: { n: BigInt(1) } }])]),
      ),
    ]);
    expect(allErrors(err).map((e) => e.toJSON())).toEqual([
      {
        name: "FixtureLoadError",
        rule: "mcp-fakes/bad-block:d",
        file: "big.json",
        blockId: "big.json",
        entryId: "big.json:t#0",
        message:
          '"big.json", block "big.json", entry "big.json:t#0": [mcp-fakes/bad-block:d] tool "t" calls[0] result.n is not a JSON value (got bigint)',
      },
    ]);
    expect(store.allEntryIds()).toEqual([]);
  });

  it("a result that cannot serialize throws and leaves the entry unconsumed", () => {
    // Load-time validation keeps non-JSON results out of the store, so the
    // claim-time guard is defense in depth. Force its serialization check to
    // fail once to prove the entry is consumed only after the result is built
    // and serializes.
    const store = storeWith(
      src("big.json", block({ testId: "T" }, [tool("t", [{ anyArgs: true, result: "ok" }])])),
    );
    const spy = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => {
      throw new TypeError("Do not know how to serialize a BigInt");
    });
    try {
      expect(() => store.claim("t", {}, id("T"))).toThrow(
        new Error(
          'MCP fake entry "big.json:t#0": result cannot be serialized as JSON: "TypeError: Do not know how to serialize a BigInt"',
        ),
      );
    } finally {
      spy.mockRestore();
    }
    // not burned: the entry is still unconsumed and answers the next call
    expect(store.snapshot("T", null)[0].tools[0].entries[0].consumed).toBe(false);
    const next = store.claim("t", {}, id("T"));
    expect(next.kind).toBe("answer");
  });

  it("ties for the closest mismatched entry go to the first in declaration order", () => {
    const tie = (first: Record<string, unknown>, second: Record<string, unknown>) =>
      storeWith(
        src(
          "tie.json",
          block({ testId: "T" }, [
            tool("t", [
              { args: first, result: "1" },
              { args: second, result: "2" },
            ]),
          ]),
        ),
      );
    const onA = { a: 1, b: 0 };
    const onB = { a: 0, b: 1 };
    const received = { a: 0, b: 0 };
    const c1 = tie(onA, onB).claim("t", received, id("T"));
    const c2 = tie(onB, onA).claim("t", received, id("T"));
    if (c1.kind !== "mismatch" || c2.kind !== "mismatch") throw new Error("expected mismatch");
    expect(c1.firstDifference).toBe("$.a: expected 1, received 0");
    expect(c2.firstDifference).toBe("$.b: expected 1, received 0");
  });
});

// ---------------------------------------------------------------------------
// consumption-state key and FIFO cap

describe("default sharing, FIFO, cap 0 unbounded", () => {
  const one = () =>
    src("s.json", block("shared", [tool("t", [{ anyArgs: true, result: "once" }])]));

  it("requests with only a context, or nothing, share the untagged (__default__) state", () => {
    const store = storeWith(one());
    expect(store.claim("t", {}, id(null, "C1")).kind).toBe("answer");
    expect(store.claim("t", {}, id(null, "C2")).kind).toBe("exhausted");
    expect(store.claim("t", {}, id()).kind).toBe("exhausted");
    expect(store.claim("t", {}, id("T1")).kind).toBe("answer");
    expect(store.claim("t", {}, id("T2")).kind).toBe("answer");
  });

  it("FIFO evicts the oldest test id past the cap; an evicted test id fails loud until reset", () => {
    const store = new McpFakeStore({ maxTestIds: 2 });
    store.add([one()], { kind: "file" });
    expect(store.claim("t", {}, id("T1")).kind).toBe("answer");
    expect(store.claim("t", {}, id("T2")).kind).toBe("answer");
    expect(store.claim("t", {}, id("T3")).kind).toBe("answer");
    // T1's state is gone: never replay its entries, say so instead
    const evicted = { kind: "evicted", tool: "t", testId: "T1", maxTestIds: 2 };
    expect(store.claim("t", {}, id("T1"))).toEqual(evicted);
    expect(store.claim("t", {}, id("T1"))).toEqual(evicted);
    expect(store.claim("t", {}, id("T2")).kind).toBe("exhausted");
    expect(store.claim("t", {}, id("T3")).kind).toBe("exhausted");
    // a tool no block declares is still "none" for an evicted test id
    expect(store.claim("other", {}, id("T1"))).toEqual({ kind: "none" });
    store.resetState("T1");
    expect(store.claim("t", {}, id("T1")).kind).toBe("answer");
  });

  it("default cap is exactly 500", () => {
    const store = storeWith(one());
    for (let i = 0; i <= 500; i++) store.claim("t", {}, id(`T${i}`));
    // 500 kept (T1..T500), the 501st insert evicted only T0
    expect(store.claim("t", {}, id("T1")).kind).toBe("exhausted");
    expect(store.claim("t", {}, id("T500")).kind).toBe("exhausted");
    expect(store.claim("t", {}, id("T0")).kind).toBe("evicted");
  });

  it("lowering the cap trims at once, oldest first", () => {
    const store = storeWith(one());
    for (let i = 0; i < 10; i++) store.claim("t", {}, id(`T${i}`));
    store.setMaxTestIds(2);
    // only T8 and T9 keep state; every one of T0..T7 is marked evicted
    expect(store.claim("t", {}, id("T8")).kind).toBe("exhausted");
    expect(store.claim("t", {}, id("T9")).kind).toBe("exhausted");
    for (let i = 0; i < 8; i++) expect(store.claim("t", {}, id(`T${i}`)).kind).toBe("evicted");
  });

  it("an evicted mark never ages out, however many later test ids are evicted", () => {
    const store = new McpFakeStore({ maxTestIds: 1 });
    store.add([one()], { kind: "file" });
    expect(store.claim("t", {}, id("T1")).kind).toBe("answer");
    for (let i = 2; i <= 50; i++) expect(store.claim("t", {}, id(`T${i}`)).kind).toBe("answer");
    // T1 already consumed its only entry: it must fail loud, never replay
    expect(store.claim("t", {}, id("T1")).kind).toBe("evicted");
    expect(store.claim("t", {}, id("T2")).kind).toBe("evicted");
    expect(store.claim("t", {}, id("T49")).kind).toBe("evicted");
    expect(store.claim("t", {}, id("T50")).kind).toBe("exhausted");
  });

  it("only a reset clears an evicted mark", () => {
    const store = new McpFakeStore({ maxTestIds: 1 });
    store.add([one()], { kind: "file" });
    for (let i = 1; i <= 5; i++) store.claim("t", {}, id(`T${i}`));
    store.resetState("T2");
    expect(store.claim("t", {}, id("T2")).kind).toBe("answer");
    expect(store.claim("t", {}, id("T1")).kind).toBe("evicted");
    store.resetState();
    expect(store.claim("t", {}, id("T1")).kind).toBe("answer");
  });

  it("snapshot reports an evicted test id as evicted, not as unconsumed", () => {
    const store = new McpFakeStore({ maxTestIds: 1 });
    store.add([one()], { kind: "file" });
    store.claim("t", {}, id("T1"));
    store.claim("t", {}, id("T2"));
    expect(store.claim("t", {}, id("T1")).kind).toBe("evicted");
    const evicted = store.snapshot("T1", null);
    expect(evicted).toHaveLength(1);
    expect(evicted[0].evicted).toBe(true);
    const live = store.snapshot("T2", null);
    expect(live[0].evicted).toBe(false);
    expect(live[0].tools[0].entries[0].consumed).toBe(true);
    // untagged state is never evicted
    expect(store.snapshot(null, null)[0].evicted).toBe(false);
    store.resetState("T1");
    expect(store.snapshot("T1", null)[0].evicted).toBe(false);
  });

  it("snapshot reports evicted after a lowered cap trims a test id", () => {
    const store = storeWith(one());
    store.claim("t", {}, id("A"));
    store.claim("t", {}, id("B"));
    expect(store.snapshot("A", null)[0].evicted).toBe(false);
    store.setMaxTestIds(1);
    expect(store.snapshot("A", null)[0].evicted).toBe(true);
    expect(store.snapshot("B", null)[0].evicted).toBe(false);
  });

  it("an invalid cap is rejected loudly and leaves the cap unchanged", () => {
    const capError = (bad: number) =>
      new RangeError(
        `MCP fakes maxTestIds must be a non-negative integer (0 = unbounded), got ${bad}`,
      );
    for (const bad of [Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY]) {
      expect(() => new McpFakeStore({ maxTestIds: bad })).toThrow(capError(bad));
    }
    const store = new McpFakeStore({ maxTestIds: 1 });
    store.add([one()], { kind: "file" });
    for (const bad of [Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY]) {
      expect(() => store.setMaxTestIds(bad)).toThrow(capError(bad));
    }
    store.claim("t", {}, id("T1"));
    store.claim("t", {}, id("T2"));
    expect(store.claim("t", {}, id("T1")).kind).toBe("evicted"); // cap is still 1
  });

  it('an explicit test id "__default__" does not share state with untagged requests', () => {
    const store = storeWith(one());
    expect(store.claim("t", {}, id("__default__")).kind).toBe("answer");
    expect(store.claim("t", {}, id()).kind).toBe("answer");
    expect(store.claim("t", {}, id("__default__")).kind).toBe("exhausted");
    expect(store.claim("t", {}, id()).kind).toBe("exhausted");
    // resetState("__default__") resets both, like Journal.clearMatchCounts
    store.resetState("__default__");
    expect(store.claim("t", {}, id("__default__")).kind).toBe("answer");
    expect(store.claim("t", {}, id()).kind).toBe("answer");
  });

  it("untagged state is not a test id: the cap never evicts it", () => {
    const store = new McpFakeStore({ maxTestIds: 1 });
    store.add([one()], { kind: "file" });
    expect(store.claim("t", {}, id()).kind).toBe("answer");
    expect(store.claim("t", {}, id("T1")).kind).toBe("answer");
    expect(store.claim("t", {}, id("T2")).kind).toBe("answer");
    expect(store.claim("t", {}, id()).kind).toBe("exhausted");
  });

  it("cap 0 is unbounded; setMaxTestIds changes the cap", () => {
    const store = storeWith(one());
    store.setMaxTestIds(0);
    for (let i = 0; i <= 600; i++) store.claim("t", {}, id(`T${i}`));
    expect(store.claim("t", {}, id("T0")).kind).toBe("exhausted");
  });

  it("resetState(testId) resets one test id; resetState() resets all; fakes are kept", () => {
    const store = storeWith(one());
    store.claim("t", {}, id("T1"));
    store.claim("t", {}, id("T2"));
    store.resetState("T1");
    expect(store.claim("t", {}, id("T1")).kind).toBe("answer");
    expect(store.claim("t", {}, id("T2")).kind).toBe("exhausted");
    store.resetState();
    expect(store.claim("t", {}, id("T2")).kind).toBe("answer");
  });

  it("clear() unloads fakes and state", () => {
    const store = storeWith(one());
    store.claim("t", {}, id());
    store.clear();
    expect(store.claim("t", {}, id())).toEqual({ kind: "none" });
    store.add([one()], { kind: "file" });
    expect(store.claim("t", {}, id()).kind).toBe("answer");
  });
});

// ---------------------------------------------------------------------------
// undeclared policy

describe("undeclared policy", () => {
  it("scoped deny wins; override first; default allow", () => {
    const store = storeWith(
      src(
        "sh.json",
        block("shared", [tool("s", [{ anyArgs: true, result: "x" }])], {
          undeclaredTools: "allow",
        }),
      ),
      src(
        "d.json",
        block({ testId: "T" }, [tool("a", [{ anyArgs: true, result: "x" }])], {
          undeclaredTools: "deny",
        }),
      ),
      src(
        "al.json",
        block({ testId: "T" }, [tool("b", [{ anyArgs: true, result: "x" }])], {
          undeclaredTools: "allow",
        }),
      ),
      src(
        "c.json",
        block({ context: "closed" }, [tool("c", [{ anyArgs: true, result: "x" }])], {
          undeclaredTools: "deny",
        }),
      ),
    );
    expect(store.policy(id("T"))).toBe("deny");
    expect(store.policy(id("T"), "allow")).toBe("allow");
    expect(store.policy(id("T", null, "allow"))).toBe("allow");
    expect(store.policy(id("U"))).toBe("allow");
    expect(store.policy(id("U"), "deny")).toBe("deny");
    expect(store.policy(id("U", "closed"))).toBe("deny");
    expect(store.policy(id())).toBe("allow");
    // an explicit null override falls back to the identity's own override
    expect(store.policy(id("T", null, "allow"), null)).toBe("allow");
    expect(store.policy(id("U", null, "deny"), null)).toBe("deny");
  });

  it("shared deny is rejected at validation", () => {
    const { errors } = validateMcpFakes(
      block("shared", [tool("t", [{ anyArgs: true, result: "x" }])], { undeclaredTools: "deny" }),
      "x.json",
    );
    expect(errors[0].rule).toBe("mcp-fakes/bad-block:c");
  });

  it("declaredTools covers every applicable tier", () => {
    const store = storeWith(
      src("sh.json", block("shared", [tool("shared_t", [{ anyArgs: true, result: "x" }])])),
      src("c.json", block({ context: "C" }, [tool("ctx_t", [{ anyArgs: true, result: "x" }])])),
      src(
        "d.json",
        block(
          { testId: "T" },
          [
            tool("tid_t", [{ anyArgs: true, result: "x" }]),
            tool("shared_t", [{ anyArgs: true, result: "y" }]),
          ],
          { undeclaredTools: "deny" },
        ),
      ),
    );
    expect(store.declaredTools(id("T", "C")).sort()).toEqual(["ctx_t", "shared_t", "tid_t"]);
    expect(store.declaredTools(id("U"))).toEqual(["shared_t"]);
  });
});

// ---------------------------------------------------------------------------
// tools/list and snapshot

describe("listTools and snapshot", () => {
  it("listTools returns fake tools with description/inputSchema or the default schema", () => {
    const store = storeWith(
      src("sh.json", block("shared", [tool("plain", [{ anyArgs: true, result: "x" }])])),
      src(
        "t.json",
        block({ testId: "T" }, [
          tool("plain", [{ anyArgs: true, result: "x" }], {
            description: "scoped",
            inputSchema: { type: "object", properties: {} },
          }),
        ]),
      ),
    );
    expect(store.listTools(id())).toEqual([{ name: "plain", inputSchema: { type: "object" } }]);
    expect(store.listTools(id("T"))).toEqual([
      { name: "plain", description: "scoped", inputSchema: { type: "object", properties: {} } },
    ]);
  });

  it("listTools passes description and the whole inputSchema through, and adds no other field", () => {
    const schema = {
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { city: { type: "string", enum: ["a", "b"] } },
      required: ["city"],
      additionalProperties: false,
      "x-custom": { nested: [1, { deep: true }, null] },
    };
    const store = storeWith(
      src(
        "l.json",
        block("shared", [
          tool("described", [{ anyArgs: true, result: "x" }], {
            description: "Look up a city",
            inputSchema: schema,
          }),
          tool("empty", [{ anyArgs: true, result: "x" }], { description: "" }),
          tool("bare", [{ anyArgs: true, result: "x" }]),
        ]),
      ),
    );
    expect(store.listTools(id())).toStrictEqual([
      { name: "described", description: "Look up a city", inputSchema: schema },
      { name: "empty", description: "", inputSchema: { type: "object" } },
      { name: "bare", inputSchema: { type: "object" } },
    ]);
  });

  it("snapshot lists applicable blocks with entry ids and consumed state for the test id", () => {
    const store = storeWith(
      src(
        "t.json",
        block({ testId: "T" }, [
          tool("w", [
            { args: { a: 1 }, result: "x" },
            { anyArgs: true, result: "y" },
          ]),
        ]),
      ),
      src("u.json", block({ testId: "U" }, [tool("w", [{ anyArgs: true, result: "z" }])])),
    );
    store.claim("w", { a: 1 }, id("T"));
    expect(store.snapshot("T", null)).toEqual([
      {
        blockId: "t.json",
        source: "t.json",
        mount: "/mcp",
        scope: { testId: "T" },
        undeclaredTools: "allow",
        evicted: false,
        tools: [
          {
            name: "w",
            entries: [
              { id: "t.json:w#0", args: { a: 1 }, consumed: true },
              { id: "t.json:w#1", anyArgs: true, consumed: false },
            ],
          },
        ],
      },
    ]);
    expect(store.snapshot("U", null)[0].tools[0].entries[0].consumed).toBe(false);
  });

  it("blocks keep their mount path (default /mcp)", () => {
    const store = storeWith(
      src(
        "a.json",
        block("shared", [tool("a", [{ anyArgs: true, result: "x" }])], { mount: "/tools" }),
      ),
    );
    expect(store.snapshot(null, null)[0].mount).toBe("/tools");
  });
});

// ---------------------------------------------------------------------------
// result shapes

describe("toCallToolResult", () => {
  it("string → one text block", () => {
    expect(toCallToolResult({ result: "hi" })).toEqual({
      content: [{ type: "text", text: "hi" }],
      isError: false,
    });
  });
  it("array → equal content, isError false", () => {
    const content = [{ type: "text" as const, text: "Doc A" }];
    expect(toCallToolResult({ result: content })).toEqual({ content, isError: false });
  });
  it("object with a content array → full CallToolResult", () => {
    const full = {
      content: [{ type: "text" as const, text: "x" }],
      structuredContent: { a: 1 },
      isError: true,
      _meta: { m: 1 },
    };
    expect(toCallToolResult({ result: full })).toEqual(full);
  });
  it("other object → serialized text plus structuredContent", () => {
    const obj = { tempF: 60, conditions: "rain" };
    expect(toCallToolResult({ result: obj })).toEqual({
      content: [{ type: "text", text: JSON.stringify(obj) }],
      structuredContent: obj,
      isError: false,
    });
  });
  it("error → isError text", () => {
    expect(toCallToolResult({ error: "upstream timeout" })).toEqual({
      content: [{ type: "text", text: "upstream timeout" }],
      isError: true,
    });
  });
});

// ---------------------------------------------------------------------------
// shadowed-entry warning

describe("shadowed-entry warning", () => {
  it("flags an args entry after an anyArgs entry of the same tool", () => {
    const { errors, warnings } = validateMcpFakes(
      block({ testId: "T" }, [
        tool("w", [
          { anyArgs: true, result: "any" },
          { args: { a: 1 }, result: "specific" },
        ]),
        tool("ok", [
          { args: { a: 1 }, result: "specific" },
          { anyArgs: true, result: "any" },
        ]),
      ]),
      "l8.json",
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      {
        file: "l8.json",
        blockId: "l8.json",
        entryId: "l8.json:w#1",
        message:
          'entry "l8.json:w#1" is shadowed until the preceding anyArgs entry "l8.json:w#0" is consumed',
      },
    ]);
  });

  it("the warning quotes both entry ids, so a user id cannot split or forge the line", () => {
    const anyId = 'any\nWARN fake" is fine; entry "z';
    const { errors, warnings } = validateMcpFakes(
      block("shared", [
        tool("w", [
          { id: anyId, anyArgs: true, result: "any" },
          { id: "esc\u001b", args: {}, result: "specific" },
        ]),
      ]),
      "l8.json",
    );
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.message)).toEqual([
      `entry ${JSON.stringify("l8.json:esc\u001b")} is shadowed until the preceding anyArgs entry ${JSON.stringify(`l8.json:${anyId}`)} is consumed`,
    ]);
    expect(warnings[0].message).not.toMatch(/\p{Cc}/u);
  });

  it("store.add returns the warnings with the real load ids", () => {
    const store = new McpFakeStore();
    const raw = block({ testId: "T" }, [
      tool("w", [
        { anyArgs: true, result: "any" },
        { args: { a: 1 }, result: "specific" },
      ]),
    ]);
    store.add([src("l8.json", raw)], { kind: "file" });
    const { warnings } = store.add([src("l8.json", raw)], { kind: "file" });
    expect(warnings.map((w) => w.message)).toEqual([
      'entry "l8.json@2:w#1" is shadowed until the preceding anyArgs entry "l8.json@2:w#0" is consumed',
    ]);
  });
});

// ---------------------------------------------------------------------------
// argument equality

describe("mcpArgsEqual", () => {
  it.each<[string, Record<string, unknown>, unknown, boolean]>([
    ["key order ignored", { a: 1, b: 2 }, { b: 2, a: 1 }, true],
    ["extra key", { a: 1 }, { a: 1, b: 2 }, false],
    ["missing key", { a: 1, b: 2 }, { a: 1 }, false],
    ["array order matters", { l: [1, 2] }, { l: [2, 1] }, false],
    ["array same order", { l: [1, { x: [true] }] }, { l: [1, { x: [true] }] }, true],
    ["array length", { l: [1] }, { l: [1, 1] }, false],
    ["string vs number", { a: "1" }, { a: 1 }, false],
    ["string vs boolean", { a: "true" }, { a: true }, false],
    ["null vs missing", { a: null }, {}, false],
    ["null equals null", { a: null }, { a: null }, true],
    ["1 equals 1.0", { a: 1 }, JSON.parse('{"a":1.0}'), true],
    ["nested objects", { a: { b: { c: "x" } } }, { a: { b: { c: "x" } } }, true],
    ["object vs array", { a: {} }, { a: [] }, false],
    ["absent arguments are {}", {}, undefined, true],
    ["absent arguments vs non-empty", { a: 1 }, undefined, false],
    ["non-object string", {}, "x", false],
    ["non-object array", {}, [], false],
    ["non-object null", {}, null, false],
  ])("%s", (_name, expected, received, equal) => {
    expect(mcpArgsEqual(expected, received)).toBe(equal);
  });
});

describe("firstDifference", () => {
  it.each<[string, Record<string, unknown>, unknown, string]>([
    [
      "value",
      { city: "Seattle" },
      { city: "seattle" },
      '$.city: expected "Seattle", received "seattle"',
    ],
    [
      "missing key",
      { city: "Seattle", u: "F" },
      { city: "Seattle" },
      '$.u: expected "F", received nothing (key missing)',
    ],
    [
      "extra key",
      { city: "Seattle" },
      { city: "Seattle", u: "F" },
      '$.u: unexpected key, received "F"',
    ],
    [
      "nested path",
      { a: { b: [1, { c: 2 }] } },
      { a: { b: [1, { c: 3 }] } },
      "$.a.b[1].c: expected 2, received 3",
    ],
    [
      "array length",
      { l: [1, 2] },
      { l: [1] },
      "$.l: expected an array of length 2, received length 1",
    ],
    ["type", { a: "1" }, { a: 1 }, '$.a: expected "1", received 1'],
    ["non-identifier key", { "a b": 1 }, { "a b": 2 }, '$["a b"]: expected 1, received 2'],
    ["non-object arguments", {}, "x", '$: expected an object, received "x"'],
    ["equal", { a: 1 }, { a: 1 }, ""],
  ])("%s", (_name, expected, received, diff) => {
    expect(firstDifference(expected, received)).toBe(diff);
  });
});

describe("McpFakesAddError name", () => {
  const first = new FixtureLoadError({
    rule: "mcp-fakes/bad-block:a",
    file: "m.json",
    blockId: "m.json[0]",
    detail: "bad",
  });

  it("is named McpFakesAddError and is still a FixtureLoadError", () => {
    const err = new McpFakesAddError([first], []);
    expect(err.name).toBe("McpFakesAddError");
    expect(err).toBeInstanceOf(McpFakesAddError);
    expect(err).toBeInstanceOf(FixtureLoadError);
    expect(err).toBeInstanceOf(Error);
    expect(err.toJSON().name).toBe("McpFakesAddError");
    expect(err.toJSON().errors.map((e) => e.name)).toEqual(["FixtureLoadError"]);
    expect(String(err.stack).split("\n")[0]).toBe(`McpFakesAddError: ${err.message}`);
  });

  it("leaves a plain FixtureLoadError named FixtureLoadError", () => {
    expect(first.name).toBe("FixtureLoadError");
    expect(first).not.toBeInstanceOf(McpFakesAddError);
    expect(first.toJSON().name).toBe("FixtureLoadError");
    expect(String(first.stack).split("\n")[0]).toBe(`FixtureLoadError: ${first.message}`);
  });
});

// ---------------------------------------------------------------------------
// round 4: run-time ids, depth, stand-in ids, anyArgs, same-tier blocks

describe("run-time block ids never collide with a file source spelled code#<n>", () => {
  const T = (name: string) => block("shared", [tool(name, [{ anyArgs: true, result: name }])]);

  it("a file source 'code#1' does not wedge later code adds", () => {
    const store = new McpFakeStore();
    store.add([src("code#1", T("f"))], { kind: "file" });
    store.add([src("x", T("a"))], { kind: "code" });
    store.add([src("x", T("b"))], { kind: "code" });
    expect(store.allEntryIds()).toEqual(["code#1:f#0", "code#2:a#0", "code#3:b#0"]);
  });

  it("a file source 'control-api#1[0]' or 'code#2:a' is skipped as a prefix", () => {
    const store = new McpFakeStore();
    store.add([src("control-api#1[0]", T("f"))], { kind: "file" });
    store.add([src("code#2:a", T("g"))], { kind: "file" });
    store.add([src("x", T("a")), src("x", T("b"))], { kind: "control-api" });
    store.add([src("x", T("c"))], { kind: "code" });
    expect(store.allEntryIds()).toEqual([
      "control-api#1[0]:f#0",
      "code#2:a:g#0",
      "control-api#2[0]:a#0",
      "control-api#2[1]:b#0",
      "code#3:c#0",
    ]);
  });

  it("'code#10' does not make code#1 taken", () => {
    const store = new McpFakeStore();
    store.add([src("code#10", T("f"))], { kind: "file" });
    store.add([src("x", T("a"))], { kind: "code" });
    expect(store.allEntryIds()).toEqual(["code#10:f#0", "code#1:a#0"]);
  });

  it("a file loaded after a run-time add with the same id is still the bad block (f)", () => {
    const store = new McpFakeStore();
    store.add([src("x", T("a"))], { kind: "code" });
    const err = addError(store, [src("code#1", T("a"))]);
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(err.blockId).toBe("code#1");
  });
});

describe("the block-id collision message names the owning block", () => {
  const T = (name: string) => block("shared", [tool(name, [{ anyArgs: true, result: name }])]);

  it("the block-id collision message names the block that owns the id", () => {
    const store = new McpFakeStore();
    store.add([src("a", T("a"))], { kind: "file" });
    store.add([src("a", T("a"))], { kind: "file" });
    const err = addError(store, [src("a@2", T("b"))]);
    expect(err.message).toBe(
      '"a@2", block "a@2": [mcp-fakes/bad-block:f] block id (this block\'s source: "a@2") is already loaded on this mount by source "a"',
    );
  });

  it("a collision inside one input names both sources", () => {
    const err = addError(new McpFakeStore(), [
      src("a", T("a")),
      src("a", T("a")),
      src("a@2", T("b")),
    ]);
    // The second "a" is a new load (no block index), so it takes "a@2" first.
    expect(err.message).toBe(
      '"a@2", block "a@2": [mcp-fakes/bad-block:f] block id (this block\'s source: "a@2") collides with a block earlier in the same input, from source "a"',
    );
  });

  it("with long sources, the cap on the message keeps both sources", () => {
    const owner = `${"dir/".repeat(40)}fixture.json`;
    const store = new McpFakeStore();
    store.add([src(owner, T("a"))], { kind: "file" });
    store.add([src(owner, T("a"))], { kind: "file" });
    const err = addError(store, [src(`${owner}@2`, T("b"))]);
    expect(err.message).toMatch(/this block's source: "dir\/dir\/[^"]*… \(\d+ more chars\)\)/);
    expect(err.message).toMatch(/ by source "dir\/dir\/[^"]*… \(\d+ more chars\)$/);
  });
});

describe("a file source that spells a load suffix never locks out later loads", () => {
  const T = (name: string) => block("shared", [tool(name, [{ anyArgs: true, result: name }])]);

  it('after a file "a@2" loads, the second and later loads of "a" skip the taken suffix', () => {
    const store = new McpFakeStore();
    store.add([src("a@2", T("x"))], { kind: "file" });
    store.add([src("a", T("y"))], { kind: "file" });
    store.add([src("a", T("y"))], { kind: "file" });
    store.add([src("a", T("y"))], { kind: "file" });
    expect(store.applicable(id()).map((b) => b.blockId)).toEqual(["a@2", "a", "a@3", "a@4"]);
  });

  it("an array-form block id that spells the suffix is skipped too", () => {
    const store = new McpFakeStore();
    store.add([src("a@2", T("x"), 0)], { kind: "file" });
    store.add([src("a", T("y"))], { kind: "file" });
    store.add([src("a", T("y"))], { kind: "file" });
    expect(store.applicable(id()).map((b) => b.blockId)).toEqual(["a@2[0]", "a", "a@3"]);
  });

  it("a source with a longer number after the suffix does not take it", () => {
    const store = new McpFakeStore();
    store.add([src("a@23", T("x"))], { kind: "file" });
    store.add([src("a", T("y"))], { kind: "file" });
    store.add([src("a", T("y"))], { kind: "file" });
    expect(store.applicable(id()).map((b) => b.blockId)).toEqual(["a@23", "a", "a@2"]);
  });

  it("the skip also sees blocks earlier in the same input", () => {
    const store = new McpFakeStore();
    store.add([src("a@2", T("x")), src("a", T("y")), src("a", T("y"))], { kind: "file" });
    expect(store.applicable(id()).map((b) => b.blockId)).toEqual(["a@2", "a", "a@3"]);
  });

  it('after a file "a[0]" loads, an array-form first load of "a" skips to "@2", and retries are not locked out', () => {
    const store = new McpFakeStore();
    store.add([src("a[0]", T("x"))], { kind: "file" });
    store.add([src("a", T("y"), 0), src("a", T("y"), 1)], { kind: "file" });
    store.add([src("a", T("y"), 0)], { kind: "file" });
    expect(store.applicable(id()).map((b) => b.blockId)).toEqual([
      "a[0]",
      "a@2[0]",
      "a@2[1]",
      "a@3[0]",
    ]);
  });

  it('a file "a[1]" also takes the first load when that load has a block 1', () => {
    const store = new McpFakeStore();
    store.add([src("a[1]", T("x"))], { kind: "file" });
    store.add([src("a", T("y"), 0), src("a", T("y"), 1)], { kind: "file" });
    expect(store.applicable(id()).map((b) => b.blockId)).toEqual(["a[1]", "a@2[0]", "a@2[1]"]);
  });

  it('a file "a[0]" does not take a single-object first load of "a"', () => {
    const store = new McpFakeStore();
    store.add([src("a[0]", T("x"))], { kind: "file" });
    store.add([src("a", T("y"))], { kind: "file" });
    expect(store.applicable(id()).map((b) => b.blockId)).toEqual(["a[0]", "a"]);
  });

  it("both derived forms together: the skip passes a taken `[i]` and a taken `@<k>[i]`", () => {
    const store = new McpFakeStore();
    store.add([src("a[0]", T("x")), src("a@2[0]", T("x"))], { kind: "file" });
    store.add([src("a", T("y"), 0)], { kind: "file" });
    expect(store.applicable(id()).map((b) => b.blockId)).toEqual(["a[0]", "a@2[0]", "a@3[0]"]);
  });

  it("the [i] skip also sees blocks earlier in the same input", () => {
    const store = new McpFakeStore();
    store.add([src("a[0]", T("x")), src("a", T("y"), 0)], { kind: "file" });
    expect(store.applicable(id()).map((b) => b.blockId)).toEqual(["a[0]", "a@2[0]"]);
  });

  it('a file "a[0]" loaded after the array-form load of "a" is still the bad block (f)', () => {
    const store = new McpFakeStore();
    store.add([src("a", T("y"), 0)], { kind: "file" });
    const err = addError(store, [src("a[0]", T("x"))]);
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(err.blockId).toBe("a[0]");
  });

  it("a file loaded later whose name spells a used suffix is still the bad block (f)", () => {
    const store = new McpFakeStore();
    store.add([src("a", T("y"))], { kind: "file" });
    store.add([src("a", T("y"))], { kind: "file" });
    const err = addError(store, [src("a@2", T("x"))]);
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(err.blockId).toBe("a@2");
  });
});

describe("the depth limit counts the mcpFakes value as level 1 on every path", () => {
  function nest(levels: number): unknown {
    let v: unknown = 1;
    for (let i = 0; i < levels; i++) v = { a: v };
    return v;
  }
  /** A block whose deepest container sits at `level`, counting the block as level 1. */
  function blockAtDepth(level: number): Record<string, unknown> {
    return block("shared", [tool("t", [{ args: nest(level - 5), result: "x" }])]);
  }

  it("array form: a block at block-level 64 is level 65 and fails both validate and add", () => {
    expect(validateMcpFakes([blockAtDepth(63)], "d.json").errors).toEqual([]);
    expect(validateMcpFakes([blockAtDepth(64)], "d.json").errors.map((e) => e.rule)).toEqual([
      "mcp-fakes/bad-block:d",
    ]);
    new McpFakeStore().add([src("d.json", blockAtDepth(63), 0)], { kind: "file" });
    expect(
      allErrors(addError(new McpFakeStore(), [src("d.json", blockAtDepth(64), 0)])).map(
        (e) => e.rule,
      ),
    ).toEqual(["mcp-fakes/bad-block:d"]);
  });

  it("run-time array form (two blocks) counts the array too; single-object form does not", () => {
    const store = new McpFakeStore();
    expect(() =>
      store.add([src("x", blockAtDepth(64), 0), src("x", blockAtDepth(1 + 5), 1)], {
        kind: "code",
      }),
    ).toThrow(/nested deeper than 64 levels/);
    store.add([src("x", blockAtDepth(64))], { kind: "code" });
  });

  it("run-time: several single-object blocks (null block index) keep the single-object limit", () => {
    for (const kind of ["code", "control-api"] as const) {
      const store = new McpFakeStore();
      store.add([src("x", blockAtDepth(64)), src("x", blockAtDepth(64))], { kind });
      expect(store.allEntryIds()).toEqual([`${kind}#1[0]:t#0`, `${kind}#1[1]:t#0`]);
      expect(() =>
        store.add([src("x", blockAtDepth(65)), src("x", blockAtDepth(6))], { kind }),
      ).toThrow(/nested deeper than 64 levels/);
    }
  });
});

describe("stand-in ids of a tool with an invalid name never clash with a user id", () => {
  it("reports only the (g) for the bad name, not a false (f)", () => {
    const { errors } = validateMcpFakes(
      block("shared", [
        { name: 5, calls: [{ anyArgs: true, result: "x" }] },
        tool("u", [{ id: "tools[0]#0", anyArgs: true, result: "y" }]),
      ]),
      "s.json",
    );
    expect(errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:g"]);
  });

  it("a user id on the badly named tool is still checked", () => {
    const { errors } = validateMcpFakes(
      block("shared", [
        { name: 5, calls: [{ id: "dup", anyArgs: true, result: "x" }] },
        tool("u", [{ id: "dup", anyArgs: true, result: "y" }]),
      ]),
      "s.json",
    );
    expect(errors.map((e) => [e.rule, e.entryId])).toEqual([
      ["mcp-fakes/bad-block:g", null],
      ["mcp-fakes/bad-block:f", "s.json:dup"],
    ]);
  });
});

describe("non-object arguments (spec 7.2: only anyArgs matches them)", () => {
  const store = storeWith(
    src(
      "n.json",
      block("shared", [
        tool("any", [{ anyArgs: true, result: "any" }]),
        tool("exact", [{ args: {}, result: "exact" }]),
      ]),
    ),
  );

  it.each([
    ["a string", "x"],
    ["an array", []],
    ["null", null],
    ["a number", 3],
  ])("%s: an anyArgs entry answers, an args entry is a mismatch", (_name, args) => {
    expect(answerText(store.claim("any", args, id()))).toBe("any");
    store.resetState();
    expect(store.claim("exact", args, id()).kind).toBe("mismatch");
  });
});

describe("several blocks of the same tier", () => {
  const a = src(
    "a.json",
    block({ testId: "T" }, [
      tool("w", [{ anyArgs: true, result: "A" }], { description: "from A" }),
    ]),
  );
  const b = src(
    "b.json",
    block({ testId: "T" }, [
      tool("w", [{ anyArgs: true, result: "B" }], {
        description: "from B",
        inputSchema: { type: "object", properties: { b: {} } },
      }),
      tool("x", [{ args: { k: 1 }, result: "X" }]),
    ]),
  );
  const c = src("c.json", block({ testId: "T" }, [tool("x", [{ args: { k: 2 }, result: "X2" }])]));

  it("claims run in load order across blocks, then report every block's entries", () => {
    const store = storeWith(a);
    store.add([b], { kind: "file" });
    expect(answerText(store.claim("w", {}, id("T")))).toBe("A");
    expect(answerText(store.claim("w", {}, id("T")))).toBe("B");
    expect(store.claim("w", {}, id("T"))).toEqual({
      kind: "exhausted",
      tool: "w",
      received: {},
      matchingDeclared: 2,
      matchingConsumed: 2,
      matchingIds: ["a.json:w#0", "b.json:w#0"],
    });
  });

  it("a mismatch lists the declared entries of every same-tier block", () => {
    const store = storeWith(b);
    store.add([c], { kind: "file" });
    const miss = store.claim("x", { k: 3 }, id("T"));
    if (miss.kind !== "mismatch") throw new Error(`expected mismatch, got ${miss.kind}`);
    expect(miss.declared).toEqual([
      { id: "b.json:x#0", args: { k: 1 }, consumed: false },
      { id: "c.json:x#0", args: { k: 2 }, consumed: false },
    ]);
    expect(answerText(store.claim("x", { k: 2 }, id("T")))).toBe("X2");
  });

  it("listTools takes metadata from the first same-tier block in load order", () => {
    const store = storeWith(a);
    store.add([b], { kind: "file" });
    expect(store.listTools(id("T"))).toEqual([
      { name: "w", description: "from A", inputSchema: { type: "object" } },
      { name: "x", inputSchema: { type: "object" } },
    ]);
    const reversed = storeWith(b);
    reversed.add([a], { kind: "file" });
    expect(reversed.listTools(id("T"))[0]).toEqual({
      name: "w",
      description: "from B",
      inputSchema: { type: "object", properties: { b: {} } },
    });
  });
});

describe("McpFakesAddError needs at least one error", () => {
  it("throws a TypeError for an empty errors array", () => {
    expect(() => new McpFakesAddError([], [])).toThrow(
      new TypeError("McpFakesAddError needs at least one error"),
    );
  });
});
