/**
 * Differential test of the MCP fakes result and tool validator against the
 * `@modelcontextprotocol/sdk` 1.31 client schemas (`CallToolResultSchema`,
 * `ToolSchema`). A corpus of seed results and tool definitions is mutated at
 * every path; each case goes through both aimock's validator and the SDK.
 *
 * - Whatever aimock accepts, the SDK accepts in the form aimock serves it.
 * - Where aimock rejects and the SDK accepts, the rejection must be one of
 *   aimock's deliberate strictness rules (`DELIBERATE`); any other rejection
 *   fails.
 * - An object field set to `undefined` gets the same answer as the field left
 *   out, at every level.
 */
import { describe, expect, it } from "vitest";
import { CallToolResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpFakeStore, toCallToolResult, validateMcpFakes } from "../mcp-fakes.js";

const FILE = "d.json";
const B64 = "aGVsbG8=";
const RELATED_TASK = "io.modelcontextprotocol/related-task";

type Path = ReadonlyArray<string | number>;
const DELETE: unique symbol = Symbol("delete");

// ---------------------------------------------------------------------------
// Corpus

/** Valid seed results; every one loads and the SDK accepts it. */
const RESULT_SEEDS: ReadonlyArray<[string, unknown]> = [
  ["string", "hello"],
  [
    "text with annotations and _meta",
    [
      {
        type: "text",
        text: "a",
        annotations: { audience: ["user"], priority: 0.5, lastModified: "2025-01-01T00:00:00Z" },
        _meta: { k: 1 },
      },
    ],
  ],
  ["image", [{ type: "image", data: B64, mimeType: "image/png" }]],
  ["audio", [{ type: "audio", data: B64, mimeType: "audio/wav", annotations: { priority: 1 } }]],
  [
    "resource_link",
    [
      {
        type: "resource_link",
        uri: "file:///a",
        name: "a",
        title: "A",
        description: "d",
        mimeType: "text/plain",
        size: 3,
        icons: [{ src: "https://x/i.png", mimeType: "image/png", sizes: ["48x48"], theme: "dark" }],
        _meta: {},
      },
    ],
  ],
  [
    "resource (text)",
    [{ type: "resource", resource: { uri: "file:///a", mimeType: "text/plain", text: "t" } }],
  ],
  ["resource (blob)", [{ type: "resource", resource: { uri: "file:///a", blob: B64, _meta: {} } }]],
  [
    "full result",
    {
      content: [{ type: "text", text: "a" }],
      isError: false,
      structuredContent: { a: 1 },
      _meta: { progressToken: "p", [RELATED_TASK]: { taskId: "t1" } },
    },
  ],
  ["structured data", { tempF: 60, conditions: "rain" }],
];

const DATETIMES = [
  "2025-01-01T00:00:00Z",
  "2025-01-01T00:00Z", // no seconds
  "2025-13-01T00:00:00Z", // month 13
  "2025-01-01T00:00:60Z", // second 60
  "2025-01-45T00:00:00Z",
  "2025-02-29T00:00:00Z",
  "2024-02-29T00:00:00Z",
  "1900-02-29T00:00:00Z",
  "2000-02-29T00:00:00Z",
  "2025-04-31T00:00:00Z",
  "2025-01-01T24:00:00Z",
  "2025-01-01T00:00:00+99:99",
  "2025-01-01T00:00:00+05:30",
  "2025-01-01T00:00:00-00:00",
  "2025-01-01T00:00:00+0530",
  "2025-01-01t00:00:00z",
  "2025-01-01T00:00:00.123456Z",
  "2025-01-01T00:00:00.Z",
  "2025-01-01T00:00:00",
  "2025-01-01 00:00:00Z",
  "25-01-01T00:00:00Z",
  "2025-01-01T00:00:00Z\n",
];

const BASE64 = [B64, "", "%%%", "aGVsbG8", "a", "aGVs bG8=", "aGVsbG8==", "\n", "!!not base64!!"];

/** Values put at every path: type swaps, edge numbers, and the string tables. */
const REPLACEMENTS: readonly unknown[] = [
  "x",
  "",
  0,
  -1,
  0.5,
  1,
  1.5,
  2,
  true,
  false,
  null,
  [],
  ["x"],
  [1],
  ["user"],
  ["assistant", "user"],
  {},
  { a: 1 },
  { taskId: "t" },
  { taskId: 1 },
  "object",
  "text",
  "image",
  "audio",
  "resource",
  "resource_link",
  "light",
  "dark",
  "user",
  ...DATETIMES,
  ...BASE64,
];

/** Keys added to every object of a case. */
const EXTRA_KEYS = [
  "extra",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "x".repeat(5000),
];

// ---------------------------------------------------------------------------
// Generator

function clone(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every path under `value`, root excluded. */
function pathsOf(value: unknown, prefix: Path = []): Path[] {
  const out: Path[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      out.push([...prefix, i], ...pathsOf(item, [...prefix, i]));
    });
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      out.push([...prefix, key], ...pathsOf(value[key], [...prefix, key]));
    }
  }
  return out;
}

/** A copy of `root` with `path` set to `value` (or removed for `DELETE`). */
function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const copy = clone(root);
  let node: unknown = copy;
  for (const step of path.slice(0, -1)) {
    node = (node as Record<string | number, unknown>)[step];
  }
  const last = path[path.length - 1];
  if (Array.isArray(node) && typeof last === "number") {
    if (value === DELETE) node.splice(last, 1);
    else node[last] = value;
  } else if (isObject(node)) {
    if (value === DELETE) delete node[last];
    else
      Object.defineProperty(node, last, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return copy;
}

/** A copy of `root` with an own key `key` added to the object at `path`. */
function addKey(root: unknown, path: Path, key: string): unknown {
  const copy = clone(root);
  let node: unknown = copy;
  for (const step of path) node = (node as Record<string | number, unknown>)[step];
  if (!isObject(node)) return copy;
  Object.defineProperty(node, key, {
    value: 1,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return copy;
}

interface Case {
  label: string;
  value: unknown;
}

function variants(seedLabel: string, seed: unknown): Case[] {
  const cases: Case[] = [{ label: `${seedLabel}: seed`, value: seed }];
  const objectPaths: Path[] = isObject(seed) ? [[]] : [];
  for (const path of pathsOf(seed)) {
    const at = `${seedLabel}: ${path.join(".")}`;
    cases.push({ label: `${at} deleted`, value: setAt(seed, path, DELETE) });
    for (const value of REPLACEMENTS) {
      cases.push({
        label: `${at} = ${JSON.stringify(value).slice(0, 40)}`,
        value: setAt(seed, path, value),
      });
    }
    let node: unknown = seed;
    for (const step of path) node = (node as Record<string | number, unknown>)[step];
    if (isObject(node)) objectPaths.push(path);
  }
  for (const path of objectPaths) {
    for (const key of EXTRA_KEYS) {
      cases.push({
        label: `${seedLabel}: ${path.join(".") || "<root>"} + key ${key.slice(0, 20)}`,
        value: addKey(seed, path, key),
      });
    }
    // `__proto__` as an own key, as `JSON.parse` makes it.
    cases.push({
      label: `${seedLabel}: ${path.join(".") || "<root>"} + own __proto__`,
      value: setAt(seed, [...path, "__proto__"], { polluted: true }),
    });
  }
  for (const value of REPLACEMENTS) {
    cases.push({ label: `${seedLabel}: root = ${JSON.stringify(value).slice(0, 40)}`, value });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// The two oracles

function withResult(result: unknown): unknown {
  return { scope: "shared", tools: [{ name: "t", calls: [{ anyArgs: true, result }] }] };
}

/** aimock's verdict on a `result`, and on acceptance the value it serves. */
function aimockResult(result: unknown): {
  accepted: boolean;
  messages: string[];
  served?: unknown;
} {
  const v = validateMcpFakes(withResult(result), FILE);
  if (v.errors.length > 0) return { accepted: false, messages: v.errors.map((e) => e.message) };
  const call = v.blocks[0].tools[0].calls[0];
  return { accepted: true, messages: [], served: toCallToolResult(call) };
}

/** The SDK's verdict on the JSON wire form of a served `tools/call` result. */
function sdkServed(served: unknown): boolean {
  return CallToolResultSchema.safeParse(JSON.parse(JSON.stringify(served))).success;
}

const FULL_RESULT_KEYS = ["content", "isError", "structuredContent", "_meta"];

/**
 * The SDK's verdict on what a `result` means, used where aimock serves
 * nothing: a string is text, an array is the content, an object with a
 * CallToolResult key is that result, any other object is structured data.
 */
function sdkIntent(result: unknown): boolean {
  if (typeof result === "string") return true;
  let wire: unknown;
  if (Array.isArray(result)) wire = { content: result };
  else if (isObject(result) && FULL_RESULT_KEYS.some((k) => Object.hasOwn(result, k)))
    wire = result;
  else if (isObject(result)) wire = { content: [], structuredContent: result };
  else return false;
  return CallToolResultSchema.safeParse(JSON.parse(JSON.stringify(wire))).success;
}

/**
 * aimock's deliberate strictness: rejections the SDK would not make. Any
 * other "aimock rejects, SDK accepts" case fails the test.
 */
const DELIBERATE: ReadonlyArray<[string, RegExp]> = [
  ["a full CallToolResult is a closed format", /calls\[\d+\] result has unknown key/],
  [
    "an object with a CallToolResult key must have a content array",
    /result\.content must be an array of content blocks, got undefined/,
  ],
  [
    "embedded resource contents carry exactly one of text / blob",
    /needs exactly one of text \/ blob/,
  ],
  ["a tool definition is a closed format", /tools\[\d+\] has unknown key/],
  ["a tool needs a non-empty name", /needs a string name, got ""/],
  [
    "inputSchema.properties values are schema objects (the SDK also takes arrays)",
    /inputSchema\.properties.* must be a JSON object, got \[/,
  ],
];

function deliberate(messages: readonly string[]): boolean {
  return messages.every((m) => DELIBERATE.some(([, re]) => re.test(m)));
}

const RESULT_CASES: Case[] = [
  ...RESULT_SEEDS.flatMap(([label, seed]) => variants(label, seed)),
  {
    label: "resource with both text and blob",
    value: [{ type: "resource", resource: { uri: "file:///a", text: "t", blob: B64 } }],
  },
  { label: "full result without content", value: { isError: true } },
  { label: "full result unknown key", value: { content: [], iserror: true } },
];

describe("SDK differential: CallToolResult", () => {
  it("the corpus is large and every seed is accepted by both", () => {
    expect(RESULT_CASES.length).toBeGreaterThan(2000);
    for (const [label, seed] of RESULT_SEEDS) {
      const a = aimockResult(seed);
      expect({ label, messages: a.messages }).toEqual({ label, messages: [] });
      expect({ label, sdk: sdkServed(a.served) }).toEqual({ label, sdk: true });
    }
  });

  it("whatever aimock accepts, the SDK accepts as served", () => {
    const wrong: string[] = [];
    for (const c of RESULT_CASES) {
      const a = aimockResult(c.value);
      if (a.accepted && !sdkServed(a.served)) wrong.push(c.label);
    }
    expect(wrong).toEqual([]);
  });

  it("where the SDK accepts and aimock rejects, the rule is deliberate", () => {
    const wrong: string[] = [];
    for (const c of RESULT_CASES) {
      const a = aimockResult(c.value);
      if (!a.accepted && sdkIntent(c.value) && !deliberate(a.messages)) {
        wrong.push(`${c.label} -> ${a.messages.join(" | ").slice(0, 200)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every deliberate rule is used by the corpus", () => {
    const used = new Set<string>();
    const all: Case[] = [...RESULT_CASES, ...TOOL_CASES];
    for (const c of all) {
      const messages = verdictMessages(c);
      for (const [name, re] of DELIBERATE) if (messages.some((m) => re.test(m))) used.add(name);
    }
    expect([...used].sort()).toEqual(DELIBERATE.map(([name]) => name).sort());
  });

  it("an object field set to undefined is the same as the field left out", () => {
    const wrong: string[] = [];
    for (const [label, seed] of RESULT_SEEDS) {
      for (const path of pathsOf(seed)) {
        if (typeof path[path.length - 1] === "number") continue;
        const undef = aimockResult(setAt(seed, path, undefined));
        const absent = aimockResult(setAt(seed, path, DELETE));
        if (undef.accepted !== absent.accepted) {
          wrong.push(`${label}: ${path.join(".")} -> ${undef.messages.join(" | ")}`);
        } else if (undef.accepted) {
          // toStrictEqual: a key served with the value undefined is not a key left out.
          expect(undef.served).toStrictEqual(absent.served);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tool definitions

const TOOL_SEED = {
  name: "t",
  description: "d",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

const TOOL_CASES: Case[] = [
  ...variants("tool", TOOL_SEED),
  {
    label: "property schema that is an array",
    value: { ...TOOL_SEED, inputSchema: { type: "object", properties: { a: [] } } },
  },
];

const CALLS = [{ anyArgs: true, result: "x" }];

function toolBlock(tool: unknown): unknown {
  return { scope: "shared", tools: [isObject(tool) ? { ...tool, calls: CALLS } : tool] };
}

type ToolVerdict =
  | { accepted: false; messages: string[] }
  | { accepted: true; messages: []; served: unknown };

/**
 * aimock's verdict on a tool definition, and on acceptance the one listing
 * `tools/list` serves for it. An accepted tool that is not listed exactly once
 * throws: there would be nothing to give the SDK.
 */
function aimockTool(tool: unknown): ToolVerdict {
  const v = validateMcpFakes(toolBlock(tool), FILE);
  if (v.errors.length > 0) return { accepted: false, messages: v.errors.map((e) => e.message) };
  const store = new McpFakeStore();
  store.add([{ source: FILE, blockIndex: null, raw: toolBlock(tool) }], { kind: "file" });
  const listing = store.listTools({ testId: null, context: null, undeclared: null });
  if (listing.length !== 1) {
    throw new Error(`an accepted tool is listed ${listing.length} times: ${JSON.stringify(tool)}`);
  }
  return { accepted: true, messages: [], served: listing[0] };
}

/** The SDK's verdict on the JSON wire form of a tool definition. */
function sdkTool(wire: unknown): boolean {
  return ToolSchema.safeParse(JSON.parse(JSON.stringify(wire ?? null))).success;
}

function verdictMessages(c: Case): string[] {
  return TOOL_CASES.includes(c) ? aimockTool(c.value).messages : aimockResult(c.value).messages;
}

describe("SDK differential: tool definitions", () => {
  it("whatever aimock accepts, the SDK accepts as listed", () => {
    const wrong: string[] = [];
    for (const c of TOOL_CASES) {
      const a = aimockTool(c.value);
      if (a.accepted && !sdkTool(a.served)) wrong.push(c.label);
    }
    expect(wrong).toEqual([]);
  });

  it("where the SDK accepts and aimock rejects, the rule is deliberate", () => {
    const wrong: string[] = [];
    for (const c of TOOL_CASES) {
      const a = aimockTool(c.value);
      if (!a.accepted && sdkTool(c.value) && !deliberate(a.messages)) {
        wrong.push(`${c.label} -> ${a.messages.join(" | ").slice(0, 200)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a tool-definition field set to undefined is the same as the field left out", () => {
    const wrong: string[] = [];
    for (const path of pathsOf(TOOL_SEED)) {
      if (typeof path[path.length - 1] === "number") continue;
      const undef = aimockTool(setAt(TOOL_SEED, path, undefined));
      const absent = aimockTool(setAt(TOOL_SEED, path, DELETE));
      if (undef.accepted !== absent.accepted)
        wrong.push(`${path.join(".")} -> ${undef.messages.join(" | ")}`);
      // toStrictEqual: a key listed with the value undefined is not a key left out.
      else if (undef.accepted && absent.accepted)
        expect(undef.served, path.join(".")).toStrictEqual(absent.served);
    }
    expect(wrong).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Named regression cases

describe("SDK differential: named cases", () => {
  const annotated = (lastModified: string): unknown => [
    { type: "text", text: "a", annotations: { lastModified } },
  ];
  it.each([
    ["lastModified with no seconds", annotated("2025-01-01T00:00Z")],
    ["lastModified in month 13", annotated("2025-13-01T00:00:00Z")],
    ["lastModified at second 60", annotated("2025-01-01T00:00:60Z")],
    ["lastModified with offset +99:99", annotated("2025-01-01T00:00:00+99:99")],
    ['isError: "yes"', { content: [], isError: "yes" }],
    ["non-array content", { content: "hello" }],
    ["priority above 1", [{ type: "text", text: "a", annotations: { priority: 1.5 } }]],
    ["non-base64 image data", [{ type: "image", data: "%%%", mimeType: "image/png" }]],
    ["array structuredContent", { content: [], structuredContent: [1] }],
    ["non-integer progressToken", { content: [], _meta: { progressToken: 1.5 } }],
  ])("both reject %s", (_label, result) => {
    expect(sdkIntent(result)).toBe(false);
    expect(aimockResult(result).accepted).toBe(false);
  });

  it.each([
    ["an unknown key on a content item", [{ type: "text", text: "a", extra: 1 }]],
    ["an unknown key in annotations", [{ type: "text", text: "a", annotations: { prio: 1 } }]],
    [
      "an unknown key on an icon",
      [{ type: "resource_link", uri: "file:///a", name: "a", icons: [{ src: "i", x: 1 }] }],
    ],
    [
      "an unknown key in resource contents",
      [{ type: "resource", resource: { uri: "file:///a", text: "t", x: 1 } }],
    ],
    [
      "any value inside a content item's _meta",
      [{ type: "text", text: "a", _meta: { k: [null] } }],
    ],
    ["isError: undefined", { content: [], isError: undefined }],
  ])("both accept %s", (_label, result) => {
    const a = aimockResult(result);
    expect(a.messages).toEqual([]);
    expect(sdkServed(a.served)).toBe(true);
  });

  it('an inputSchema without type: "object" is rejected by both', () => {
    const tool = { name: "t", inputSchema: { type: "string" } };
    expect(sdkTool(tool)).toBe(false);
    expect(aimockTool(tool).accepted).toBe(false);
  });
});
