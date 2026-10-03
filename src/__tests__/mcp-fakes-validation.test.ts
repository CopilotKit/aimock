/**
 * Validation and result shaping of MCP fakes:
 * content items of a full CallToolResult, entries with no answer, plain-JSON
 * payloads, `undefined` fields as absent, and isolation of stored fakes from
 * the caller's objects and from the objects the store hands out.
 */
import { describe, expect, it } from "vitest";
import {
  McpFakeStore,
  toCallToolResult,
  validateMcpFakes,
  type McpFakeCallToolResult,
  type McpFakeClaim,
} from "../mcp-fakes.js";
import type { McpFakeCall, McpFakeCallAnswer, McpFakeIdentity } from "../types.js";

const FILE = "v.json";

function ident(testId: string | null = null): McpFakeIdentity {
  return { testId, context: null, undeclared: null };
}

function oneCall(call: unknown, toolExtra: Record<string, unknown> = {}): unknown {
  return { scope: "shared", tools: [{ name: "t", calls: [call], ...toolExtra }] };
}

function errorsOf(raw: unknown) {
  return validateMcpFakes(raw, FILE).errors;
}

/**
 * `raw` has exactly one error: bad block `letter` in block `${FILE}`, on
 * `entryId`, with the message `detail` after the prefix.
 */
function expectBad(
  raw: unknown,
  letter: string,
  detail: string,
  entryId: string | null = `${FILE}:t#0`,
): void {
  const rule = `mcp-fakes/bad-block:${letter}`;
  const q = (text: string): string => JSON.stringify(text);
  const where =
    entryId === null
      ? `${q(FILE)}, block ${q(FILE)}`
      : `${q(FILE)}, block ${q(FILE)}, entry ${q(entryId)}`;
  expect(errorsOf(raw).map((e) => e.toJSON())).toEqual([
    {
      name: "FixtureLoadError",
      rule,
      file: FILE,
      blockId: FILE,
      entryId,
      message: `${where}: [${rule}] ${detail}`,
    },
  ]);
}

function answer(claim: McpFakeClaim): McpFakeCallToolResult {
  if (claim.kind !== "answer") throw new Error(`expected answer, got ${claim.kind}`);
  return claim.result;
}

function firstText(result: McpFakeCallToolResult): unknown {
  const first = result.content[0] as { text?: unknown } | undefined;
  return first?.text;
}

function codeStore(raw: unknown): McpFakeStore {
  const store = new McpFakeStore();
  store.add([{ source: "ignored", blockIndex: null, raw }], { kind: "code" });
  return store;
}

// ---------------------------------------------------------------------------
// content items of an object result

describe("object result with a content array: items are checked like an array result", () => {
  it("rejects non-object items as bad block (d)", () => {
    expectBad(
      oneCall({ anyArgs: true, result: { content: ["x", 1] } }),
      "d",
      'tool "t" calls[0] result.content[0] must be a content object, got "x"',
    );
  });

  it("rejects an item without a string type as bad block (d)", () => {
    expectBad(
      oneCall({ anyArgs: true, result: { content: [{ type: "text", text: "a" }, { text: "b" }] } }),
      "d",
      'tool "t" calls[0] result.content[1].type must be one of "text", "image", "audio", "resource_link", "resource", got undefined',
    );
  });

  it("names the entry id", () => {
    const [err] = errorsOf(oneCall({ anyArgs: true, result: { content: [{}] } }));
    expect(err.entryId).toBe(`${FILE}:t#0`);
  });

  it("still accepts a well-formed full CallToolResult", () => {
    const full = { content: [{ type: "text", text: "x" }], isError: true, _meta: { m: 1 } };
    expect(errorsOf(oneCall({ anyArgs: true, result: full }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// neither result nor error

describe("an entry with no answer never becomes a success", () => {
  it("toCallToolResult throws when neither result nor error is set", () => {
    const empty = {} as unknown as McpFakeCallAnswer;
    expect(() => toCallToolResult(empty)).toThrow(/neither result nor error/);
  });

  it("result: undefined with no error is bad block (d) 'exactly one of result / error'", () => {
    expectBad(
      oneCall({ anyArgs: true, result: undefined }),
      "d",
      'tool "t" calls[0] needs exactly one of result / error',
    );
  });

  it("an entry with only args is bad block (d)", () => {
    expectBad(oneCall({ args: {} }), "d", 'tool "t" calls[0] needs exactly one of result / error');
  });
});

// ---------------------------------------------------------------------------
// payloads must be plain JSON

describe("args / result / inputSchema must be plain JSON (code origin)", () => {
  it("rejects a Date in args as bad block (d), naming the path", () => {
    expectBad(
      oneCall({ args: { when: new Date(0) }, result: "x" }),
      "d",
      'tool "t" calls[0] args.when is not a plain JSON object (got [object Date])',
    );
  });

  it("rejects an undefined array item in args as bad block (d)", () => {
    expectBad(
      oneCall({ args: { a: [undefined] }, result: "x" }),
      "d",
      'tool "t" calls[0] args.a[0] is not a JSON value (got undefined)',
    );
  });

  it("rejects NaN, functions, class instances and Maps in args", () => {
    class Point {
      x = 1;
    }
    const bad: Array<[unknown, string]> = [
      [NaN, "must be a finite number, got NaN"],
      [Infinity, "must be a finite number, got Infinity"],
      [() => 1, "is not a JSON value (got function)"],
      [new Point(), "is not a plain JSON object (got [object Object])"],
      [new Map(), "is not a plain JSON object (got [object Map])"],
      [Symbol("s"), "is not a JSON value (got symbol)"],
      [1n, "is not a JSON value (got bigint)"],
    ];
    for (const [value, why] of bad) {
      expectBad(
        oneCall({ args: { nested: [value] }, result: "x" }),
        "d",
        `tool "t" calls[0] args.nested[0] ${why}`,
      );
    }
  });

  it("rejects args that are a Date or a class instance at the top level", () => {
    class Point {
      x = 1;
    }
    expectBad(
      oneCall({ args: new Date(0), result: "x" }),
      "d",
      'tool "t" calls[0] args must be a JSON object, got <not a plain JSON object (got [object Date])>',
    );
    expectBad(
      oneCall({ args: new Point(), result: "x" }),
      "d",
      'tool "t" calls[0] args must be a JSON object, got <not a plain JSON object (got [object Object])>',
    );
  });

  it("rejects a sparse array in args", () => {
    expectBad(
      // eslint-disable-next-line no-sparse-arrays
      oneCall({ args: { a: [1, , 3] }, result: "x" }),
      "d",
      'tool "t" calls[0] args.a[1] is a hole in a sparse array',
    );
  });

  it("rejects a circular args object instead of looping", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expectBad(
      oneCall({ args: cyclic, result: "x" }),
      "d",
      'tool "t" calls[0] args.self is a circular reference',
    );
  });

  it("rejects a Date inside an object result", () => {
    expectBad(
      oneCall({ anyArgs: true, result: { at: new Date(0) } }),
      "d",
      'tool "t" calls[0] result.at is not a plain JSON object (got [object Date])',
    );
  });

  it("rejects a non-JSON inputSchema as bad block (g)", () => {
    expectBad(
      oneCall({ anyArgs: true, result: "x" }, { inputSchema: { default: new Date(0) } }),
      "g",
      'tool "t" inputSchema.default is not a plain JSON object (got [object Date])',
      null,
    );
  });

  it("a code-origin add with a Date arg throws instead of loading a fake that never matches", () => {
    const store = new McpFakeStore();
    expect(() =>
      store.add(
        [
          {
            source: "x",
            blockIndex: null,
            raw: oneCall({ args: { when: new Date(0) }, result: "x" }),
          },
        ],
        { kind: "code" },
      ),
    ).toThrow(/args\.when/);
  });

  it("accepts plain JSON with null, nested arrays, -0 and a null-prototype object", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = "v";
    const args = { a: null, b: [1, [2, { c: true }]], d: -0, e: bare };
    expect(errorsOf(oneCall({ args, result: "x" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// undefined fields are absent

describe("keys set to undefined are treated as absent", () => {
  it("accepts a call entry with undefined args / error / id beside anyArgs + result", () => {
    const call = { anyArgs: true, args: undefined, result: "ok", error: undefined, id: undefined };
    const v = validateMcpFakes(oneCall(call), FILE);
    expect(v.errors).toEqual([]);
    expect(v.blocks[0].tools[0].calls[0].id).toBe(`${FILE}:t#0`);
  });

  it("accepts args + error with anyArgs and result undefined", () => {
    const call = { args: { a: 1 }, anyArgs: undefined, result: undefined, error: "boom" };
    expect(errorsOf(oneCall(call))).toEqual([]);
  });

  it("accepts undefined block, tool and scope fields", () => {
    const raw = {
      scope: { testId: "T", context: undefined },
      mount: undefined,
      undeclaredTools: undefined,
      tools: [
        {
          name: "t",
          description: undefined,
          inputSchema: undefined,
          calls: [{ anyArgs: true, result: "ok" }],
        },
      ],
    };
    const v = validateMcpFakes(raw, FILE);
    expect(v.errors).toEqual([]);
    const b = v.blocks[0];
    expect(b.scope).toEqual({ testId: "T" });
    expect(b.tier).toBe("testId");
    expect(b.mount).toBe("/mcp");
    expect(b.undeclaredTools).toBeUndefined();
    expect("description" in b.tools[0]).toBe(false);
  });

  it("an unknown key set to undefined is absent, not an unknown key", () => {
    expect(
      errorsOf({ ...(oneCall({ anyArgs: true, result: "x" }) as object), x: undefined }),
    ).toEqual([]);
  });

  it("an undefined field in args is absent: the entry matches arguments without it", () => {
    const store = codeStore(oneCall({ args: { a: 1, u: undefined }, result: "ok" }));
    const claim = store.claim("t", { a: 1 }, ident());
    expect(claim.kind).toBe("answer");
    if (claim.kind === "answer") expect(Object.keys(claim.entry.args ?? {})).toEqual(["a"]);
  });

  it("an undefined field inside a result or inputSchema is left out of what is served", () => {
    const store = codeStore(
      oneCall(
        {
          anyArgs: true,
          result: { content: [{ type: "text", text: "x", extra: undefined }], isError: undefined },
        },
        { inputSchema: { type: "object", properties: undefined } },
      ),
    );
    expect(answer(store.claim("t", {}, ident()))).toStrictEqual({
      content: [{ type: "text", text: "x" }],
    });
    expect(store.listTools(ident())[0].inputSchema).toStrictEqual({ type: "object" });
  });

  it("a scope with both keys undefined still has neither testId nor context (b)", () => {
    expectBad(
      {
        scope: { testId: undefined, context: undefined },
        tools: [{ name: "t", calls: [{ anyArgs: true, result: "x" }] }],
      },
      "b",
      "scope object has neither testId nor context",
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// stored fakes are isolated from caller objects and handed-out objects

describe("stored fakes are isolated (copied at load, copies handed out)", () => {
  it("changing the caller's args after add does not change matching", () => {
    const args = { city: "SF" };
    const store = codeStore(oneCall({ args, result: "ok" }));
    args.city = "LA";
    expect(store.claim("t", { city: "SF" }, ident()).kind).toBe("answer");
  });

  it("changing the caller's result after add does not change the answer", () => {
    const result = [{ type: "text", text: "orig" }];
    const store = codeStore(oneCall({ anyArgs: true, result }));
    result[0].text = "CHANGED";
    expect(firstText(answer(store.claim("t", {}, ident())))).toBe("orig");
  });

  it("changing the caller's raw after validateMcpFakes does not change the validated block", () => {
    const raw = {
      scope: { testId: "T" },
      tools: [
        { name: "t", inputSchema: { type: "object" }, calls: [{ args: { a: 1 }, result: "x" }] },
      ],
    };
    const v = validateMcpFakes(raw, FILE);
    raw.scope.testId = "HIJACK";
    raw.tools[0].inputSchema.type = "string";
    raw.tools[0].calls[0].args.a = 2;
    const b = v.blocks[0];
    expect(b.scope).toEqual({ testId: "T" });
    expect(b.tools[0].inputSchema).toEqual({ type: "object" });
    expect(b.tools[0].calls[0].args).toEqual({ a: 1 });
  });

  for (const [label, result] of [
    ["array", [{ type: "text", text: "orig" }]],
    ["full object", { content: [{ type: "text", text: "orig" }], _meta: { m: 1 } }],
  ] as const) {
    it(`a claimed ${label} result is a mutable copy: changing it does not change the next answer`, () => {
      const store = codeStore(oneCall({ anyArgs: true, result }));
      const first = answer(store.claim("t", {}, ident()));
      (first.content[0] as { text: string }).text = "MUTATED";
      first.content.push({ type: "text", text: "extra" });
      first._meta = { hijacked: true };
      expect(firstText(first)).toBe("MUTATED");
      store.resetState();
      const second = answer(store.claim("t", {}, ident()));
      expect(firstText(second)).toBe("orig");
      expect(second.content).toHaveLength(1);
    });
  }

  it("the declared args of a mismatch are frozen: changing them throws and changes nothing", () => {
    const store = codeStore(oneCall({ args: { a: 1 }, result: "x" }));
    const miss = store.claim("t", { a: 2 }, ident());
    if (miss.kind !== "mismatch") throw new Error(`expected mismatch, got ${miss.kind}`);
    expect(() => {
      (miss.declared[0].args as Record<string, unknown>).a = 3;
    }).toThrow(TypeError);
    expect(store.claim("t", { a: 1 }, ident()).kind).toBe("answer");
  });

  it("toCallToolResult returns copies of a structured result", () => {
    const obj = { nested: { n: 1 } };
    const out = toCallToolResult({ result: obj });
    (out.structuredContent as { nested: { n: number } }).nested.n = 2;
    expect(obj.nested.n).toBe(1);
  });

  it("a snapshot's scope is frozen: changing it throws and does not move the block", () => {
    const store = codeStore({
      scope: { testId: "T" },
      tools: [{ name: "t", calls: [{ anyArgs: true, result: "x" }] }],
    });
    const snap = store.snapshot("T", null);
    expect(() => {
      (snap[0].scope as { testId?: string }).testId = "HIJACK";
    }).toThrow(TypeError);
    expect(store.snapshot("T", null)).toHaveLength(1);
    expect(store.snapshot("HIJACK", null)).toHaveLength(0);
  });

  it("a snapshot entry's args are frozen: changing them throws and changes nothing", () => {
    const store = codeStore(oneCall({ args: { a: 1 }, result: "x" }));
    const snap = store.snapshot(null, null);
    expect(() => {
      (snap[0].tools[0].entries[0].args as Record<string, unknown>).a = 2;
    }).toThrow(TypeError);
    expect(store.snapshot(null, null)[0].tools[0].entries[0].args).toEqual({ a: 1 });
  });

  it("a listed inputSchema is a mutable copy: changing it does not change the next listing", () => {
    const store = codeStore(
      oneCall({ anyArgs: true, result: "x" }, { inputSchema: { type: "object" } }),
    );
    const listed = store.listTools(ident());
    listed[0].inputSchema.type = "string";
    expect(store.listTools(ident())[0].inputSchema).toEqual({ type: "object" });
  });
});

// ---------------------------------------------------------------------------
// exactly-one invariants at the type level (checked by `pnpm typecheck`)

describe("McpFakeCall exactly-one invariants (type level)", () => {
  it("rejects both or neither of args / anyArgs and result / error at compile time", () => {
    // @ts-expect-error -- args and anyArgs together
    const both: McpFakeCall = { args: {}, anyArgs: true, result: "x" };
    // @ts-expect-error -- neither args nor anyArgs
    const noMatch: McpFakeCall = { result: "x" };
    // @ts-expect-error -- result and error together
    const twoAnswers: McpFakeCall = { anyArgs: true, result: "x", error: "y" };
    // @ts-expect-error -- neither result nor error
    const noAnswer: McpFakeCall = { anyArgs: true };
    const ok: McpFakeCall[] = [
      { args: { a: 1 }, result: "x" },
      { anyArgs: true, error: "boom", id: "e" },
    ];
    expect([both, noMatch, twoAnswers, noAnswer, ok].length).toBe(5);
  });
});
