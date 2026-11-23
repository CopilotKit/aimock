/**
 * Structural guards for `src/mcp-fakes.ts`: keys, echoes, ids and depth.
 *
 * - Own keys only: a key check on input data never sees the prototype chain,
 *   so `constructor`, `toString`, `__proto__` and friends are unknown keys on
 *   every closed object kind. A source scan bans the `in` operator, `for…in`
 *   and ad-hoc key listing outside the helpers named in KEY_ALLOW.
 * - One message builder: every message of the fakes foundation is built by
 *   the `msg` template and `build` (message-text.ts), which quote every user
 *   part and cut it once. A source scan finds any other message built by a
 *   template literal or `+` with a non-literal part.
 * - Unique ids: block ids and entry ids are unique on a mount after every add.
 * - Depth: the input snapshot has a stated depth limit.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  McpFakeStore,
  McpFakesAddError,
  MCP_FAKES_ECHO_LIMIT,
  MCP_FAKES_MAX_DEPTH,
  echo,
  validateMcpFakes,
  type McpFakeAddOrigin,
} from "../mcp-fakes.js";
import type { McpFakeSource } from "../types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_PATH = join(ROOT, "src", "mcp-fakes.ts");
const FILE = "g.json";
const OK_CALL = { anyArgs: true, result: "ok" };
const OK_TOOL = { name: "t", calls: [OK_CALL] };

function shared(tools: unknown[]): Record<string, unknown> {
  return { scope: "shared", tools };
}

/** A copy of `obj` with one more own, enumerable data key (works for `__proto__` too). */
function withKey(obj: Record<string, unknown>, key: string, value: unknown = 1): object {
  const out: Record<string, unknown> = { ...obj };
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  return out;
}

function withResult(result: unknown): Record<string, unknown> {
  return shared([{ name: "t", calls: [{ anyArgs: true, result }] }]);
}

/** Every error message `validateMcpFakes` produces for `raw`. */
function messages(raw: unknown): string[] {
  return validateMcpFakes(raw, FILE).errors.map((e) => e.message);
}

function addFails(sources: unknown, origin: unknown, store = new McpFakeStore()): McpFakesAddError {
  let thrown: unknown;
  try {
    store.add(sources as McpFakeSource[], origin as McpFakeAddOrigin);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(McpFakesAddError);
  return thrown as McpFakesAddError;
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Own keys only

const PROTO_KEYS = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "__proto__",
];

/** Each closed object kind, as a function of one extra key. */
const CLOSED_KINDS: Array<[string, (key: string) => unknown]> = [
  ["block", (k) => withKey(shared([OK_TOOL]), k)],
  ["scope", (k) => ({ scope: withKey({ testId: "T" }, k), tools: [OK_TOOL] })],
  ["tool", (k) => shared([withKey(OK_TOOL, k)])],
  ["call", (k) => shared([{ name: "t", calls: [withKey(OK_CALL, k)] }])],
  ["full result", (k) => withResult(withKey({ content: [] }, k))],
];

/**
 * Each open object kind (content items and what they hold): the SDK client
 * strips unknown keys there, so the validator lets them through, and a
 * prototype-member name must not be read as one of the kind's fields.
 */
const OPEN_KINDS: Array<[string, (key: string) => unknown]> = [
  ["text content", (k) => withResult([withKey({ type: "text", text: "x" }, k)])],
  [
    "image content",
    (k) => withResult([withKey({ type: "image", data: "", mimeType: "image/png" }, k)]),
  ],
  [
    "resource_link content",
    (k) => withResult([withKey({ type: "resource_link", uri: "u", name: "n" }, k)]),
  ],
  [
    "resource contents",
    (k) => withResult([{ type: "resource", resource: withKey({ uri: "u", text: "t" }, k) }]),
  ],
  [
    "annotations",
    (k) => withResult([{ type: "text", text: "x", annotations: withKey({ priority: 0.5 }, k) }]),
  ],
  [
    "icon",
    (k) =>
      withResult([
        { type: "resource_link", uri: "u", name: "n", icons: [withKey({ src: "s" }, k)] },
      ]),
  ],
];

describe("prototype-member names: the open kinds pass them through, the closed kinds reject them", () => {
  /** What the closed kinds say about an extra key `k`: [rule, message detail]. */
  const CLOSED_ERROR = new Map<string, (k: string) => [string, string]>([
    ["block", (k) => ["mcp-fakes/bad-block:h", `block has unknown key "${k}"`]],
    ["scope", (k) => ["mcp-fakes/bad-block:b", `scope has unknown key "${k}"`]],
    ["tool", (k) => ["mcp-fakes/bad-block:h", `tools[0] has unknown key "${k}"`]],
    ["call", (k) => ["mcp-fakes/bad-block:h", `tool "t" calls[0] has unknown key "${k}"`]],
    [
      "full result",
      (k) => ["mcp-fakes/bad-block:d", `tool "t" calls[0] result has unknown key "${k}"`],
    ],
  ]);

  it("content items, annotations, icons and resource contents accept them, as the SDK client does; block, scope, tool, call and full result reject them", () => {
    const outcome = (raw: unknown): Array<[string, string]> =>
      validateMcpFakes(raw, FILE).errors.map((e) => [
        e.rule,
        e.message.slice(e.message.indexOf("] ") + 2),
      ]);
    const kinds = [...OPEN_KINDS, ...CLOSED_KINDS];
    const actual = kinds.flatMap(([kind, build]) =>
      PROTO_KEYS.map((key) => [kind, key, outcome(build(key))]),
    );
    const expected = kinds.flatMap(([kind]) =>
      PROTO_KEYS.map((key) => {
        const closed = CLOSED_ERROR.get(kind);
        return [kind, key, closed ? [closed(key)] : []];
      }),
    );
    expect(OPEN_KINDS.map(([kind]) => kind)).toEqual([
      "text content",
      "image content",
      "resource_link content",
      "resource contents",
      "annotations",
      "icon",
    ]);
    expect(CLOSED_KINDS.map(([kind]) => kind)).toEqual([...CLOSED_ERROR.keys()]);
    expect(actual).toEqual(expected);
  });

  it("a __proto__ key from JSON.parse is rejected on a full result", () => {
    const raw: unknown = JSON.parse(
      '{"scope":"shared","tools":[{"name":"t","calls":[{"anyArgs":true,"result":{"content":[],"__proto__":1}}]}]}',
    );
    expect(validateMcpFakes(raw, FILE).errors.map((e) => e.toJSON())).toEqual([
      {
        name: "FixtureLoadError",
        rule: "mcp-fakes/bad-block:d",
        file: FILE,
        blockId: FILE,
        entryId: `${FILE}:t#0`,
        message: `"${FILE}", block "${FILE}", entry "${FILE}:t#0": [mcp-fakes/bad-block:d] tool "t" calls[0] result has unknown key "__proto__"`,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Bounded, quoted echoes

describe("echo()", () => {
  it("is exported", () => {
    expect(typeof echo).toBe("function");
  });

  it("keeps the whole text, ellipsis included, within MCP_FAKES_ECHO_LIMIT", () => {
    for (const n of [MCP_FAKES_ECHO_LIMIT - 2, MCP_FAKES_ECHO_LIMIT, 1_000, 100_000]) {
      const out = echo("x".repeat(n));
      expect(out.length).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
    }
    expect(echo("x".repeat(1_000))).toMatch(/…/);
  });

  it("never splits a surrogate pair", () => {
    for (let pad = 150; pad < 220; pad++) {
      const out = echo("x".repeat(pad) + "😀".repeat(100));
      expect(hasLoneSurrogate(out)).toBe(false);
      expect(out.length).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
    }
  });

  it("quotes a string and escapes the quotes in it", () => {
    expect(echo('a"b')).toBe('"a\\"b"');
  });

  it("renders values that JSON cannot", () => {
    expect(echo(undefined)).toBe("undefined");
    expect(echo(Number.NaN)).toBe("NaN");
    expect(echo(10n)).toBe("10n");
  });
});

describe("every echo of user data in a message is bounded", () => {
  const huge = "k".repeat(50_000);
  const BOUND = 1_500;

  const sites: Array<[string, string, () => unknown]> = [
    [
      "full-result unknown key",
      "mcp-fakes/bad-block:d",
      () => withResult({ content: [], [huge]: 1 }),
    ],
    [
      "content key holding a non-JSON value",
      "mcp-fakes/bad-block:d",
      () => withResult([{ type: "text", text: "x", [huge]: Number.NaN }]),
    ],
    [
      "resource-contents key holding a non-JSON value",
      "mcp-fakes/bad-block:d",
      () =>
        withResult([{ type: "resource", resource: { uri: "u", text: "t", [huge]: Number.NaN } }]),
    ],
    [
      "inputSchema property name",
      "mcp-fakes/bad-block:g",
      () => shared([{ ...OK_TOOL, inputSchema: { type: "object", properties: { [huge]: 5 } } }]),
    ],
    [
      "a long path of short keys",
      "mcp-fakes/bad-block:d",
      () => {
        let args: Record<string, unknown> = { leaf: Number.NaN };
        for (let i = 0; i < 50; i++) args = { ["p".repeat(200)]: args };
        return shared([{ name: "t", calls: [{ args, result: "x" }] }]);
      },
    ],
    [
      "a huge description",
      "mcp-fakes/bad-block:g",
      () => shared([{ ...OK_TOOL, description: { [huge]: 1 } }]),
    ],
  ];

  it.each(sites)("%s", (_name, rule, build) => {
    const errors = validateMcpFakes(build(), FILE).errors;
    expect(errors.map((e) => e.rule)).toEqual([rule]);
    for (const { message } of errors) {
      expect(message.length).toBeLessThanOrEqual(BOUND);
      expect(hasLoneSurrogate(message)).toBe(false);
    }
  });

  it("the description error echoes the bad value", () => {
    expect(messages(shared([{ ...OK_TOOL, description: 5 }])).join("\n")).toMatch(
      /description must be a string, got 5/,
    );
  });

  it("the inputSchema error keeps the snapshot's reason", () => {
    expect(messages(shared([{ ...OK_TOOL, inputSchema: new Date(0) }])).join("\n")).toMatch(
      /inputSchema must be a JSON object, got <not a plain JSON object/,
    );
  });

  it("src/mcp-fakes.ts has no `(spec N` citation, in messages or comments", () => {
    const text = readFileSync(SOURCE_PATH, "utf8");
    expect(text).not.toMatch(/\(spec \d/);
  });
});

// ---------------------------------------------------------------------------
// 3. Unique block ids and entry ids on a mount

describe("block ids and entry ids stay unique on a mount", () => {
  const denyT = { scope: { testId: "T" }, undeclaredTools: "deny", tools: [] };

  it('source "a@2" and the second load of "a" cannot share a block id', () => {
    const store = new McpFakeStore();
    store.add([{ source: "a", blockIndex: null, raw: denyT }], { kind: "file" });
    store.add([{ source: "a", blockIndex: null, raw: denyT }], { kind: "file" });
    const err = addFails(
      [{ source: "a@2", blockIndex: null, raw: denyT }],
      { kind: "file" },
      store,
    );
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(err.message).toMatch(/block "a@2":/);
    expect(err.message).toMatch(/by source "a"$/);
    const ids = store.snapshot("T", null).map((b) => b.blockId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("two blocks of one input with one block id are rejected", () => {
    const err = addFails(
      [
        { source: "a", blockIndex: 0, raw: denyT },
        { source: "a", blockIndex: 0, raw: denyT },
        { source: "a@2", blockIndex: 0, raw: denyT },
      ],
      { kind: "file" },
    );
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(err.message).toMatch(/block "a@2\[0\]":/);
  });

  it("an entry-id collision names the block that owns the id", () => {
    const store = new McpFakeStore();
    store.add([{ source: "a:b", blockIndex: null, raw: shared([OK_TOOL]) }], { kind: "file" });
    const raw = shared([{ name: "t", calls: [{ ...OK_CALL, id: "b:t#0" }] }]);
    const err = addFails([{ source: "a", blockIndex: null, raw }], { kind: "file" }, store);
    expect(err.rule).toBe("mcp-fakes/bad-block:f");
    expect(err.message).toMatch(/entry id "a:b:t#0" is already loaded on this mount/);
    expect(err.message).toMatch(/block "a:b"/);
  });

  describe("seeded sequences of adds", () => {
    /** mulberry32: a 32-bit PRNG whose arithmetic stays exact (`Math.imul`, `>>>`). */
    const mulberry32 = (seed: number): ((n: number) => number) => {
      let a = seed >>> 0;
      return (n) => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * n);
      };
    };
    // "a@2" and "a[0]" spell block ids that other loads of "a" produce.
    const sources = ["a", "a@2", "a@3", "a[0]", "b", "a:b"];
    const blockIndexes = [null, 0, 1];
    const kinds = ["code", "file"] as const;
    const raws = [
      denyT,
      shared([OK_TOOL]),
      // Under source "a", its entry id `a:b:t#0` is OK_TOOL's entry id under source "a:b".
      shared([{ name: "t", calls: [{ ...OK_CALL, id: "b:t#0" }] }]),
      { scope: { testId: "T" }, tools: [{ name: "u", calls: [OK_CALL] }] },
    ];
    interface Step {
      source: number;
      blockIndex: number;
      raw: number;
      kind: number;
    }
    // Short sequences on fresh stores: a collision needs an early load of a
    // source, and one long sequence uses those up in its first steps.
    const SEQUENCES = 2_000;
    const STEPS = 8;
    const rand = mulberry32(7);
    const corpus: Step[][] = Array.from({ length: SEQUENCES }, () =>
      Array.from({ length: STEPS }, () => ({
        source: rand(sources.length),
        blockIndex: rand(blockIndexes.length),
        raw: rand(raws.length),
        kind: rand(kinds.length),
      })),
    );

    it("the corpus uses every source, block index, raw and origin kind often", () => {
      const steps = corpus.flat();
      const axes: Array<[keyof Step, number]> = [
        ["source", sources.length],
        ["blockIndex", blockIndexes.length],
        ["raw", raws.length],
        ["kind", kinds.length],
      ];
      for (const [axis, n] of axes) {
        const counts = Array<number>(n).fill(0);
        for (const s of steps) counts[s[axis]] += 1;
        // Each value is expected steps.length / n times; half of that catches a
        // generator that collapses onto a few values.
        for (const c of counts) expect(c).toBeGreaterThanOrEqual(steps.length / n / 2);
      }
      // The two halves of the entry-id collision, each as a file load with no block index.
      const fileLoad = (source: string, raw: number): number =>
        steps.filter(
          (s) =>
            sources[s.source] === source &&
            blockIndexes[s.blockIndex] === null &&
            s.raw === raw &&
            kinds[s.kind] === "file",
        ).length;
      expect(fileLoad("a:b", 1)).toBeGreaterThanOrEqual(50);
      expect(fileLoad("a", 2)).toBeGreaterThanOrEqual(50);
    });

    it("keep every block id and entry id unique, and provoke both kinds of collision", () => {
      const outcomes = { accepted: 0, blockIdTaken: 0, entryIdTaken: 0 };
      for (const sequence of corpus) {
        const store = new McpFakeStore();
        for (const s of sequence) {
          const before = store.snapshot("T", null).map((b) => b.blockId);
          const beforeEntries = store.allEntryIds();
          const item = {
            source: sources[s.source],
            blockIndex: blockIndexes[s.blockIndex],
            raw: raws[s.raw],
          };
          try {
            store.add([item], { kind: kinds[s.kind] });
            outcomes.accepted += 1;
          } catch (err) {
            expect(err).toBeInstanceOf(McpFakesAddError);
            const message = err instanceof McpFakesAddError ? err.message : "";
            if (/block id .* is already loaded on this mount/.test(message)) {
              outcomes.blockIdTaken += 1;
            }
            if (/entry id .* is already loaded on this mount/.test(message)) {
              outcomes.entryIdTaken += 1;
            }
            expect(store.snapshot("T", null).map((b) => b.blockId)).toEqual(before);
            expect(store.allEntryIds()).toEqual(beforeEntries);
          }
          const blockIds = store.snapshot("T", null).map((b) => b.blockId);
          expect(new Set(blockIds).size).toBe(blockIds.length);
          const entryIds = store.allEntryIds();
          expect(new Set(entryIds).size).toBe(entryIds.length);
        }
      }
      // The corpus reaches acceptance and both collision checks, not only one path.
      expect(outcomes.accepted).toBeGreaterThanOrEqual(SEQUENCES);
      expect(outcomes.blockIdTaken).toBeGreaterThanOrEqual(50);
      expect(outcomes.entryIdTaken).toBeGreaterThanOrEqual(3);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Depth limit at the snapshot boundary

/** `n` nested objects: `nest(1)` is `{}`, `nest(2)` is `{ a: {} }`. */
function nest(n: number): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (let i = 1; i < n; i++) out = { a: out };
  return out;
}

/** A single-object block whose deepest container sits at level `level` (the block is level 1). */
function blockAtDepth(level: number): Record<string, unknown> {
  // block(1) > tools(2) > tool(3) > calls(4) > call(5) > args(6)
  return shared([{ name: "t", calls: [{ args: nest(level - 5), result: "x" }] }]);
}

describe("input nesting has a stated depth limit", () => {
  it("exports the limit", () => {
    expect(MCP_FAKES_MAX_DEPTH).toBe(64);
  });

  it("64 levels load; 65 levels are a bad block with the depth message", () => {
    expect(validateMcpFakes(blockAtDepth(64), FILE).errors).toEqual([]);
    const errors = validateMcpFakes(blockAtDepth(65), FILE).errors;
    expect(errors.map((e) => [e.rule, e.entryId])).toEqual([
      ["mcp-fakes/bad-block:d", `${FILE}:t#0`],
    ]);
    const [only] = errors;
    expect(only.message).toMatch(/ args(\.a){59} is nested deeper than 64 levels$/);
  });

  it("the limit is the same through McpFakeStore.add", () => {
    const store = new McpFakeStore();
    store.add([{ source: "x", blockIndex: null, raw: blockAtDepth(64) }], { kind: "code" });
    const err = addFails([{ source: "x", blockIndex: null, raw: blockAtDepth(65) }], {
      kind: "code",
    });
    expect(err.errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:d"]);
    expect(err.message).toMatch(/ args(\.a){59} is nested deeper than 64 levels$/);
  });

  it("5000 levels are reported as too deep, not as an unreadable value", () => {
    const messagesText = messages(blockAtDepth(5_000));
    expect(messagesText).toHaveLength(1);
    expect(messagesText[0]).toMatch(/nested deeper than 64 levels/);
    expect(messagesText[0]).not.toMatch(/unreadable/);
    expect(messagesText[0].length).toBeLessThanOrEqual(1_000);
  });
});

// ---------------------------------------------------------------------------
// 5. Source scans
//
// Both scans parse the source with the TypeScript compiler (no regex lexing).
// They are heuristics with known limits:
// - Key scan (`src/mcp-fakes.ts`): it flags syntax (`in`, `for…in`, key-listing
//   calls, descriptor reads, and `hasOwnProperty` / `propertyIsEnumerable`
//   calls, as methods or through `.call` / `.apply` on any receiver). It
//   cannot tell input data from aimock's own objects, so every exception is
//   named in KEY_ALLOW with a reason.
// - Message scan (the fakes foundation, MESSAGE_SCOPE): any untagged template
//   literal with a span that is not a number, a boolean or a string literal
//   type, any string `+` / `+=` with such an operand, and any built-in error
//   (`new TypeError(...)`) whose message is not a `build(...)` call, is text
//   built outside the message builder. The builder module itself
//   (`src/message-text.ts`) is not scanned. A template tagged `msg` is the
//   builder; its spans are typed (a user part, a message, a number). Text
//   that is not a message (an id, a JSON path, the rendering of a value, the
//   cut routine) is named in MESSAGE_ALLOW with a reason. Text built by
//   `.join`, `.concat` or `String.raw` is not traced.

interface Allow {
  fn: string;
  expr: string;
  reason: string;
  /** When set, the whole template the span is in must be this text too. */
  template?: string;
}

/** Named exceptions to the key scan. Keep this narrow. */
const KEY_ALLOW: Allow[] = [
  { fn: "ownKeys", expr: "Object.keys(obj)", reason: "the key-listing helper itself" },
  {
    fn: "hasOwnKey",
    expr: "Object.prototype.hasOwnProperty.call(obj, key)",
    reason: "the key-check helper itself",
  },
  {
    fn: "readShape",
    expr: "Reflect.ownKeys(value)",
    reason: "the snapshot boundary reads every own key, symbols included, to reject them",
  },
  {
    fn: "readShape",
    expr: "Reflect.getOwnPropertyDescriptor(value, key)",
    reason: "reads the descriptor of a key Reflect.ownKeys just listed",
  },
  {
    fn: "readShape",
    expr: 'Reflect.getOwnPropertyDescriptor(value, "length")',
    reason: "reads an array's own length",
  },
];

/** Named exceptions to the message scan. Keep this narrow. */
const MESSAGE_ALLOW: Allow[] = [
  // Id building: these templates make ids, not messages; a message quotes the id.
  { fn: "blockIdOf", expr: "source", reason: "builds a block id" },
  { fn: "blockIdOf", expr: "loadSuffix", reason: "builds a block id" },
  {
    fn: "blockIdOf",
    expr: 'blockIndex === null ? "" : `[${blockIndex}]`',
    reason: "builds a block id",
  },
  { fn: "entryIds", expr: "prefix", reason: "builds an entry id" },
  { fn: "entryIds", expr: "localOf(tool.name, index, call.id)", reason: "builds an entry id" },
  { fn: "localOf", expr: "toolName", reason: "builds an entry id" },
  { fn: "validateCall", expr: "ctx.blockId", reason: "builds an entry id" },
  { fn: "validateCall", expr: "localOf(toolName, index, idRaw)", reason: "builds an entry id" },
  // Path building: a JSON path is one user part where a message shows it
  // (`pathPart`). Each site that extends a path is named here by its whole
  // template, so no other template that starts with a path passes.
  {
    fn: "jsonProblem",
    expr: "path",
    template: "`${path}[${i}]`",
    reason: "extends a JSON path by an array index (two sites, one template)",
  },
  {
    fn: "arrayOf",
    expr: "p",
    template: "`${p}[${i}]`",
    reason: "extends a JSON path by an array index",
  },
  {
    fn: "pathKey",
    expr: "path",
    template: "`${path}.${key}`",
    reason: "extends a JSON path by an identifier key",
  },
  {
    fn: "pathKey",
    expr: "path",
    template: "`${path}[${quoteJson(key)}]`",
    reason: "extends a JSON path by a JSON-quoted key",
  },
  {
    fn: "diffAt",
    expr: "path",
    template: "`${path}[${i}]`",
    reason: "extends a JSON path by an array index",
  },
  { fn: "pathKey", expr: "key", reason: "a key checked here to be a short identifier" },
  { fn: "pathKey", expr: "quoteJson(key)", reason: "a key, JSON-quoted whole" },
  // The rendering of a value as JSON text (one user part of a message, cut once).
  { fn: "placeholder", expr: "fullText(reason)", reason: "a placeholder reason, rendered whole" },
  {
    fn: "renderJson",
    expr: 'items.join(",")',
    reason: "array items: each is renderJson output or `null`",
  },
  {
    fn: "renderJson",
    expr: "JSON.stringify(k)",
    reason: "an object key, JSON-quoted by JSON.stringify",
  },
  { fn: "renderJson", expr: "item", reason: "a member value: renderJson output" },
  {
    fn: "renderJson",
    expr: 'members.join(",")',
    reason: "object members: each is a quoted key and renderJson output",
  },
  // The cut routine itself (echo-text.ts): it joins a kept part and its count.
  {
    fn: "cutText",
    expr: 'new RangeError("cutText limit must be a number, got NaN")',
    reason: "echo-text.ts is the leaf the builder imports, so it cannot use it; fixed text only",
  },
  {
    fn: "cutText",
    expr: 'text.slice(0, safeEnd(text, limit - 1, units)) + "…"',
    reason: "the cut routine: the kept part and a bare `…`",
  },
  {
    fn: "cutText",
    expr: "text.slice(0, keep) + `… (${text.length - keep} more chars)`",
    reason: "the cut routine: the kept part and its count",
  },
];

/** The name of the function (or top-level variable) that holds `node`. */
function ownerName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return n.name.getText();
    }
    if (ts.isClassDeclaration(n) && n.name) return n.name.getText();
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
    if (ts.isVariableDeclaration(n) && ts.isSourceFile(n.parent.parent.parent)) {
      return n.name.getText();
    }
  }
  return "<module>";
}

/**
 * The allowlist entries one scan used, so a stale entry fails that scan. Each
 * scan gets its own set: no test sees the entries another test's scan used.
 */
type Used = Set<Allow>;

function allowed(list: Allow[], fn: string, expr: string, used: Used, template?: string): boolean {
  const hit = list.find(
    (a) => a.fn === fn && a.expr === expr && (a.template === undefined || a.template === template),
  );
  if (hit) used.add(hit);
  return hit !== undefined;
}

function unused(list: Allow[], used: Used): string[] {
  return list.filter((a) => !used.has(a)).map((a) => `${a.fn}: ${a.expr}`);
}

const KEY_CALLS = new Set([
  "Object.keys",
  "Object.entries",
  "Object.values",
  "Object.getOwnPropertyNames",
  "Object.hasOwn",
  "Reflect.ownKeys",
  "Reflect.has",
  "Object.prototype.hasOwnProperty.call",
  "Object.getOwnPropertyDescriptor",
  "Object.getOwnPropertyDescriptors",
  "Object.getOwnPropertySymbols",
  "Reflect.getOwnPropertyDescriptor",
]);

/** A method call by this name checks a key whatever the receiver (`obj.hasOwnProperty(k)`). */
const KEY_METHODS = new Set(["hasOwnProperty", "propertyIsEnumerable"]);

/** A function called through `.call` / `.apply` is still that function. */
const INDIRECT = new Set(["call", "apply"]);

function isKeyCall(node: ts.CallExpression): boolean {
  let callee: ts.Expression = node.expression;
  if (KEY_CALLS.has(callee.getText())) return true;
  if (ts.isPropertyAccessExpression(callee) && INDIRECT.has(callee.name.text)) {
    callee = callee.expression;
    if (KEY_CALLS.has(callee.getText())) return true;
  }
  return ts.isPropertyAccessExpression(callee) && KEY_METHODS.has(callee.name.text);
}

/** Key checks and key listings outside the helpers (`fn: text`). */
function keyViolations(sf: ts.SourceFile, used: Used = new Set()): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      text = node.getText();
    } else if (ts.isForInStatement(node)) {
      text = `for (${node.initializer.getText()} in ${node.expression.getText()})`;
    } else if (ts.isCallExpression(node) && isKeyCall(node)) {
      text = node.getText();
    }
    if (text !== null) {
      const fn = ownerName(node);
      if (!allowed(KEY_ALLOW, fn, text, used)) out.push(`${fn}: ${text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Builder calls whose argument text is user text that the call quotes or cuts as one part. */
const PART_CALLS = new Set(["quote", "jsonText", "plainText"]);

/** Is `node` an argument, at any depth of expressions, of a builder part call? */
function insidePart(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && PART_CALLS.has(n.expression.getText())) return true;
    if (ts.isStatement(n) || ts.isFunctionLike(n)) return false;
  }
  return false;
}

/** A type that cannot hold user text: numbers, booleans, and string literals. */
function safeType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(safeType);
  const flags = type.getFlags();
  return (
    (flags &
      (ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.StringLiteral |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined)) !==
    0
  );
}

/** A string `+` / `+=`. */
function isStringPlus(node: ts.Node, checker: ts.TypeChecker): node is ts.BinaryExpression {
  if (!ts.isBinaryExpression(node)) return false;
  const op = node.operatorToken.kind;
  if (op !== ts.SyntaxKind.PlusToken && op !== ts.SyntaxKind.PlusEqualsToken) return false;
  return (checker.getTypeAtLocation(node).getFlags() & ts.TypeFlags.StringLike) !== 0;
}

/** Each operand of a chain of string `+` (`a + b + c`), in order. */
function plusOperands(node: ts.BinaryExpression, checker: ts.TypeChecker): ts.Expression[] {
  const left = node.left;
  return [...(isStringPlus(left, checker) ? plusOperands(left, checker) : [left]), node.right];
}

/** Is `expr` text that cannot hold user data: a literal, `typeof`, or a safe type? */
function safeOperand(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return true;
  if (ts.isTypeOfExpression(expr)) return true;
  return safeType(checker.getTypeAtLocation(expr));
}

/**
 * Text built outside the message builder (`fn: expr`): template spans and
 * string `+` operands that may hold user text.
 */
function messageViolations(
  program: ts.Program,
  sf: ts.SourceFile,
  inScope: (statement: ts.Statement) => boolean,
  used: Used,
): string[] {
  const checker = program.getTypeChecker();
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) && !insidePart(node)) {
      const tagged = ts.isTaggedTemplateExpression(node.parent) ? node.parent : null;
      if (tagged === null || tagged.tag.getText() !== "msg") {
        const fn = ownerName(node);
        for (const span of node.templateSpans) {
          const expr = span.expression;
          if (safeOperand(expr, checker)) continue;
          if (allowed(MESSAGE_ALLOW, fn, expr.getText(), used, node.getText())) continue;
          out.push(`${fn}: ${expr.getText()}`);
        }
      }
    } else if (
      isStringPlus(node, checker) &&
      !isStringPlus(node.parent, checker) &&
      !insidePart(node)
    ) {
      const operands = plusOperands(node, checker);
      if (!operands.every((o) => safeOperand(o, checker))) {
        const fn = ownerName(node);
        if (!allowed(MESSAGE_ALLOW, fn, node.getText(), used)) {
          out.push(`${fn}: ${node.getText()}`);
        }
      }
    } else if (ts.isNewExpression(node) && isBuiltinErrorRawMessage(node)) {
      const fn = ownerName(node);
      const text = `new ${node.expression.getText()}(${node.arguments?.[0]?.getText() ?? ""})`;
      if (!allowed(MESSAGE_ALLOW, fn, text, used)) out.push(`${fn}: ${text}`);
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of sf.statements) if (inScope(statement)) visit(statement);
  return out;
}

/** The built-in error classes: a message passed to one must be built by `build`. */
const BUILTIN_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
]);

/**
 * `new <built-in error>(message)` where `message` is not a `build(...)` call
 * (a literal too: a fixed message is built as `build(msg\`...\`)`, so every
 * message has one way in).
 */
function isBuiltinErrorRawMessage(node: ts.NewExpression): boolean {
  if (!ts.isIdentifier(node.expression) || !BUILTIN_ERRORS.has(node.expression.text)) {
    return false;
  }
  const message = node.arguments?.[0];
  return !(
    message !== undefined &&
    ts.isCallExpression(message) &&
    message.expression.getText() === "build"
  );
}

/** The name a top-level statement declares, or `""`. */
function statementName(statement: ts.Statement): string {
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.text;
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((d) => d.name.getText()).join(",");
  }
  return "";
}

/**
 * The fakes foundation, file by file, and the top-level statements of each
 * that the message scan reads (`null`: all of them). The shared files hold
 * other features too; their MCP fakes statements are the ones named here.
 */
const MESSAGE_SCOPE: ReadonlyArray<{ file: string; statements: RegExp | null }> = [
  { file: "src/mcp-fakes.ts", statements: null },
  { file: "src/echo-text.ts", statements: null },
  {
    file: "src/fixture-loader.ts",
    statements: /^(?:FixtureLoadError|FixtureLoadErrorInit|capPart|namePart|oneLine)$/,
  },
  {
    file: "src/helpers.ts",
    statements: /mcp|^(?:headerValues|queryPairs|echoIdentityValue)$/i,
  },
];

const SCOPE_PATHS = MESSAGE_SCOPE.map((entry) => join(ROOT, entry.file));

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  return { ...parsed.options, noEmit: true };
}

/**
 * A program over the fakes foundation, optionally with the text of one file
 * replaced (for mutation tests), and that file's source.
 */
function programFor(
  replace?: { path: string; text: string },
  path: string = replace?.path ?? SOURCE_PATH,
): { program: ts.Program; sf: ts.SourceFile } {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);
  if (replace !== undefined) {
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, version, onError, create) =>
      name === replace.path
        ? ts.createSourceFile(name, replace.text, version, true)
        : getSourceFile(name, version, onError, create);
  }
  const program = ts.createProgram(SCOPE_PATHS, options, host);
  const sf = program.getSourceFile(path);
  if (!sf) throw new Error(`cannot parse ${path}`);
  return { program, sf };
}

/** Message-scan violations of every file in MESSAGE_SCOPE, from one program. */
function scopeViolations(program: ts.Program, used: Used = new Set()): string[] {
  return MESSAGE_SCOPE.flatMap(({ file, statements }) => {
    const sf = program.getSourceFile(join(ROOT, file));
    if (!sf) throw new Error(`cannot parse ${file}`);
    return messageViolations(
      program,
      sf,
      (st) => {
        if (statements === null) return true;
        const name = statementName(st);
        return name !== "" && statements.test(name);
      },
      used,
    ).map((v) => `${file}: ${v}`);
  });
}

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile(SOURCE_PATH, text, ts.ScriptTarget.Latest, true);
}

describe("source scans of the fakes foundation", () => {
  const text = readFileSync(SOURCE_PATH, "utf8");

  it("has no key check or key listing outside the own-key helpers", () => {
    const used: Used = new Set();
    expect(keyViolations(parse(text), used)).toEqual([]);
    expect(unused(KEY_ALLOW, used)).toEqual([]);
  });

  it("the key scan finds a planted `in` check, `for…in` and Object.keys", () => {
    const planted = `${text}\nfunction planted(o: object, k: string) { for (const x in o) void x; return k in o || Object.keys(o).length > 0; }\n`;
    expect(keyViolations(parse(planted))).toEqual([
      "planted: for (const x in o)",
      "planted: k in o",
      "planted: Object.keys(o)",
    ]);
  });

  it("the key scan finds a planted descriptor read and a direct hasOwnProperty call", () => {
    const planted = `${text}\nfunction planted(o: Record<string, unknown>, k: string) { return Object.getOwnPropertyDescriptor(o, k) !== undefined || o.hasOwnProperty(k); }\n`;
    expect(keyViolations(parse(planted))).toEqual([
      "planted: Object.getOwnPropertyDescriptor(o, k)",
      "planted: o.hasOwnProperty(k)",
    ]);
  });

  it("the key scan finds key checks called through .call and .apply on any receiver", () => {
    const calls = [
      "Object.prototype.propertyIsEnumerable.call(o, k)",
      "({}).hasOwnProperty.call(o, k)",
      "Object.prototype.hasOwnProperty.apply(o, [k])",
      "({}).propertyIsEnumerable.apply(o, [k])",
      "Object.hasOwn.call(null, o, k)",
    ];
    const planted = `${text}\nfunction planted(o: object, k: string) { return [${calls.join(", ")}]; }\n`;
    expect(keyViolations(parse(planted))).toEqual(calls.map((c) => `planted: ${c}`));
  });

  it("builds every message with the one message builder", () => {
    const { program } = programFor();
    const used: Used = new Set();
    expect(scopeViolations(program, used)).toEqual([]);
    expect(unused(MESSAGE_ALLOW, used)).toEqual([]);
  }, 60_000);

  it("the message scan finds a planted template message, and lets numbers through", () => {
    const planted = `${text}\nexport function plantedMessage(name: string, n: number): string { return \`tool \${name} has \${n} calls\`; }\n`;
    const { program } = programFor({ path: SOURCE_PATH, text: planted });
    const found = scopeViolations(program);
    expect(found).toEqual(["src/mcp-fakes.ts: plantedMessage: name"]);
  }, 60_000);

  it("the message scan finds a planted + message and a += message", () => {
    const planted = `${text}\nexport function plantedPlus(name: string, n: number): string { let m = "tool " + name + " has " + n; m += name; return m + " calls"; }\n`;
    const { program } = programFor({ path: SOURCE_PATH, text: planted });
    expect(scopeViolations(program)).toEqual([
      'src/mcp-fakes.ts: plantedPlus: "tool " + name + " has " + n',
      "src/mcp-fakes.ts: plantedPlus: m += name",
      'src/mcp-fakes.ts: plantedPlus: m + " calls"',
    ]);
  }, 60_000);

  it("the message scan finds a planted message that starts with a path variable", () => {
    const planted = `${text}\nexport function plantedPath(path: string, p: string): string[] { return [\`\${path}.x is bad\`, \`\${p}[0] is bad\`]; }\n`;
    const { program } = programFor({ path: SOURCE_PATH, text: planted });
    expect(scopeViolations(program)).toEqual([
      "src/mcp-fakes.ts: plantedPath: path",
      "src/mcp-fakes.ts: plantedPath: p",
    ]);
  }, 60_000);

  it("the message scan finds a planted error thrown with a message not built by the builder", () => {
    const planted = `${text}\nexport function plantedThrow(n: number): never { if (n > 0) throw new TypeError("raw text"); throw new Error(\`n is \${n}\`); }\n`;
    const { program } = programFor({ path: SOURCE_PATH, text: planted });
    expect(scopeViolations(program)).toEqual([
      'src/mcp-fakes.ts: plantedThrow: new TypeError("raw text")',
      "src/mcp-fakes.ts: plantedThrow: new Error(`n is ${n}`)",
    ]);
  }, 60_000);

  it("the stale-entry check counts only the scan it is given, whatever ran before", () => {
    const fresh: Used = new Set();
    expect(unused(MESSAGE_ALLOW, fresh)).toEqual(MESSAGE_ALLOW.map((a) => `${a.fn}: ${a.expr}`));
    expect(unused(KEY_ALLOW, fresh)).toEqual(KEY_ALLOW.map((a) => `${a.fn}: ${a.expr}`));
  });

  it("the message scan reads the MCP statements of the shared files", () => {
    const helpers = join(ROOT, "src", "helpers.ts");
    const loader = join(ROOT, "src", "fixture-loader.ts");
    const helpersText = `${readFileSync(helpers, "utf8")}\nexport function mcpPlanted(id: string): string { return \`bad id \${id}\`; }\nexport function otherPlanted(id: string): string { return \`not fakes \${id}\`; }\n`;
    expect(scopeViolations(programFor({ path: helpers, text: helpersText }).program)).toEqual([
      "src/helpers.ts: mcpPlanted: id",
    ]);
    const loaderText = readFileSync(loader, "utf8").replace(
      "function oneLine(text: string): string {",
      'function oneLine(text: string): string {\n  if (text.length > 1e9) return "<" + text + ">";',
    );
    expect(loaderText).toContain('"<" + text');
    expect(scopeViolations(programFor({ path: loader, text: loaderText }).program)).toEqual([
      'src/fixture-loader.ts: oneLine: "<" + text + ">"',
    ]);
  }, 60_000);
});
