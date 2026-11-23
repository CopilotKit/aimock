/**
 * The validator for the MCP `CallToolResult` a fake's `result` produces, and
 * for the tool definition a fake lists. Content items follow the
 * `@modelcontextprotocol/sdk` ContentBlock union (text, image, audio,
 * resource_link, resource). Each bad shape below is a bad block, and each
 * good shape loads and is served unchanged by the SDK client schema. The
 * full comparison with the SDK schemas is mcp-fakes-sdk-differential.test.ts.
 */
import { describe, expect, it } from "vitest";
import { McpFakeStore, toCallToolResult, validateMcpFakes } from "../mcp-fakes.js";
import type { McpFakeResult } from "../types.js";
import { CallToolResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";

const FILE = "r.json";
const B64 = "aGVsbG8="; // "hello"

function withResult(result: unknown): unknown {
  return { scope: "shared", tools: [{ name: "t", calls: [{ anyArgs: true, result }] }] };
}

function withTool(extra: Record<string, unknown>): unknown {
  return {
    scope: "shared",
    tools: [{ name: "t", calls: [{ anyArgs: true, result: "x" }], ...extra }],
  };
}

function errorsOf(raw: unknown) {
  return validateMcpFakes(raw, FILE).errors;
}

const text = { type: "text" as const, text: "a" };

// [label, result, message pattern]
const BAD_RESULTS: Array<[string, unknown, RegExp]> = [
  // full CallToolResult form: content is required and must be an array
  ["non-array content", { content: "hello" }, /result\.content must be an array/],
  [
    "non-array content with isError",
    { content: "hello", isError: true },
    /result\.content must be an array/,
  ],
  ["isError without content", { isError: true }, /result\.content must be an array/],
  [
    "structuredContent without content",
    { structuredContent: { a: 1 } },
    /result\.content must be an array/,
  ],
  ["_meta without content", { _meta: { m: 1 } }, /result\.content must be an array/],
  // isError / structuredContent / _meta types
  ["string isError", { content: [], isError: "yes" }, /result\.isError must be a boolean/],
  ["null isError", { content: [], isError: null }, /result\.isError must be a boolean/],
  [
    "string structuredContent",
    { content: [], structuredContent: "str" },
    /result\.structuredContent must be a JSON object/,
  ],
  [
    "array structuredContent",
    { content: [], structuredContent: [1] },
    /result\.structuredContent must be a JSON object/,
  ],
  ["string _meta", { content: [], _meta: "m" }, /result\._meta must be a JSON object/],
  ["unknown key", { content: [], iserror: true }, /result has unknown key "iserror"/],
  // content items, checked by type
  ["item that is a string", ["x"], /result\[0\] must be a content object/],
  ["item without type", [{ text: "a" }], /result\[0\]\.type must be one of/],
  ["item of unknown type", [{ type: "video", data: B64 }], /result\[0\]\.type must be one of/],
  ["text without text", [{ type: "text" }], /result\[0\]\.text must be a string/],
  ["text with numeric text", [{ type: "text", text: 5 }], /result\[0\]\.text must be a string/],
  [
    "image without data",
    [{ type: "image", mimeType: "image/png" }],
    /result\[0\]\.data must be a base64 string/,
  ],
  [
    "image with non-base64 data",
    [{ type: "image", data: "!!not base64!!", mimeType: "image/png" }],
    /result\[0\]\.data must be a base64 string/,
  ],
  [
    "image without mimeType",
    [{ type: "image", data: B64 }],
    /result\[0\]\.mimeType must be a string/,
  ],
  [
    "audio without mimeType",
    [{ type: "audio", data: B64 }],
    /result\[0\]\.mimeType must be a string/,
  ],
  [
    "audio with numeric data",
    [{ type: "audio", data: 1, mimeType: "audio/wav" }],
    /result\[0\]\.data must be a base64 string/,
  ],
  [
    "resource_link without uri",
    [{ type: "resource_link", name: "n" }],
    /result\[0\]\.uri must be a string/,
  ],
  [
    "resource_link without name",
    [{ type: "resource_link", uri: "file:///a" }],
    /result\[0\]\.name must be a string/,
  ],
  [
    "resource_link with string size",
    [{ type: "resource_link", uri: "file:///a", name: "n", size: "1" }],
    /result\[0\]\.size must be a number/,
  ],
  [
    "resource_link with non-array icons",
    [{ type: "resource_link", uri: "file:///a", name: "n", icons: "i" }],
    /result\[0\]\.icons must be an array/,
  ],
  [
    "resource_link icon without src",
    [{ type: "resource_link", uri: "file:///a", name: "n", icons: [{ mimeType: "image/png" }] }],
    /result\[0\]\.icons\[0\]\.src must be a string/,
  ],
  ["resource without resource", [{ type: "resource" }], /result\[0\]\.resource must be/],
  [
    "resource with neither text nor blob",
    [{ type: "resource", resource: { uri: "file:///a" } }],
    /result\[0\]\.resource needs exactly one of text \/ blob/,
  ],
  [
    "resource with both text and blob",
    [{ type: "resource", resource: { uri: "file:///a", text: "t", blob: B64 } }],
    /result\[0\]\.resource needs exactly one of text \/ blob/,
  ],
  [
    "resource without uri",
    [{ type: "resource", resource: { text: "t" } }],
    /result\[0\]\.resource\.uri must be a string/,
  ],
  [
    "resource with non-base64 blob",
    [{ type: "resource", resource: { uri: "file:///a", blob: "%%%" } }],
    /result\[0\]\.resource\.blob must be a base64 string/,
  ],
  [
    "string annotations",
    [{ ...text, annotations: "a" }],
    /result\[0\]\.annotations must be a JSON object/,
  ],
  [
    "annotations priority out of range",
    [{ ...text, annotations: { priority: 2 } }],
    /result\[0\]\.annotations\.priority must be a number from 0 to 1/,
  ],
  [
    "annotations audience with an unknown role",
    [{ ...text, annotations: { audience: ["bot"] } }],
    /result\[0\]\.annotations\.audience\[0\] must be one of "user", "assistant"/,
  ],
  [
    "annotations lastModified without seconds",
    [{ ...text, annotations: { lastModified: "2025-01-01T00:00Z" } }],
    /result\[0\]\.annotations\.lastModified must be an ISO 8601 date-time/,
  ],
  [
    "annotations lastModified in month 13",
    [{ ...text, annotations: { lastModified: "2025-13-01T00:00:00Z" } }],
    /result\[0\]\.annotations\.lastModified must be an ISO 8601 date-time/,
  ],
  [
    "non-integer _meta.progressToken",
    { content: [], _meta: { progressToken: 1.5 } },
    /result\._meta\.progressToken must be a string or an integer/,
  ],
  ["item with string _meta", [{ ...text, _meta: "m" }], /result\[0\]\._meta must be a JSON object/],
  // the same item checks apply inside a full CallToolResult
  [
    "full result with a bad item",
    { content: [text, { type: "image", data: B64 }] },
    /result\.content\[1\]\.mimeType must be a string/,
  ],
];

const GOOD_RESULTS: Array<[string, unknown]> = [
  ["string", "hello"],
  ["empty content array", []],
  ["text", [text]],
  [
    "text with annotations and _meta",
    [
      {
        ...text,
        annotations: { audience: ["user"], priority: 0.5, lastModified: "2025-01-01T00:00:00Z" },
        _meta: { k: 1 },
      },
    ],
  ],
  ["image", [{ type: "image", data: B64, mimeType: "image/png" }]],
  ["audio", [{ type: "audio", data: B64, mimeType: "audio/wav" }]],
  ["resource_link (minimal)", [{ type: "resource_link", uri: "file:///a", name: "a" }]],
  [
    "resource_link (all fields)",
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
        annotations: { priority: 1 },
        _meta: {},
      },
    ],
  ],
  [
    "resource (text)",
    [{ type: "resource", resource: { uri: "file:///a", mimeType: "text/plain", text: "t" } }],
  ],
  ["resource (blob)", [{ type: "resource", resource: { uri: "file:///a", blob: B64, _meta: {} } }]],
  ["full result", { content: [text] }],
  ["full result, empty content", { content: [] }],
  [
    "full result with every field",
    { content: [text], isError: false, structuredContent: { a: 1 }, _meta: { m: 1 } },
  ],
  ["full error result", { content: [text], isError: true }],
  ["structured data object", { tempF: 60, conditions: "rain" }],
  ["empty data object", {}],
];

describe("result validator: bad shapes are bad block (d)", () => {
  it.each(BAD_RESULTS)("rejects %s", (_label, result, detail) => {
    const errors = errorsOf(withResult(result));
    expect(errors.map((e) => [e.rule, e.blockId, e.entryId])).toEqual([
      ["mcp-fakes/bad-block:d", FILE, `${FILE}:t#0`],
    ]);
    const [only] = errors;
    expect(only.message).toContain(`[mcp-fakes/bad-block:d] tool "t" calls[0] result`);
    expect(only.message).toMatch(detail);
  });
});

describe("result validator: valid shapes load and are served", () => {
  it.each(GOOD_RESULTS)("accepts %s", (_label, result) => {
    const v = validateMcpFakes(withResult(result), FILE);
    expect(v.errors).toEqual([]);
    const served = toCallToolResult({ result: result as McpFakeResult });
    expect(Array.isArray(served.content)).toBe(true);
    if (served.isError !== undefined) expect(typeof served.isError).toBe("boolean");
    // The real SDK client schema accepts it and drops nothing.
    expect(CallToolResultSchema.parse(served)).toEqual(served);
  });

  it("a full CallToolResult is served with its own fields, and no isError added", () => {
    const full = { content: [text], structuredContent: { a: 1 }, _meta: { m: 1 } };
    expect(toCallToolResult({ result: full })).toEqual(full);
  });

  it("a data object becomes text plus structuredContent", () => {
    expect(toCallToolResult({ result: { a: 1 } })).toEqual({
      content: [{ type: "text", text: '{"a":1}' }],
      structuredContent: { a: 1 },
      isError: false,
    });
  });
});

describe("tool definition: inputSchema is an object schema (bad block (g))", () => {
  const BAD: Array<[string, unknown, RegExp]> = [
    ["empty inputSchema", {}, /inputSchema\.type must be "object"/],
    ["string-typed inputSchema", { type: "string" }, /inputSchema\.type must be "object"/],
    [
      "non-object properties",
      { type: "object", properties: [] },
      /inputSchema\.properties must be a JSON object/,
    ],
    [
      "a property that is not a schema object",
      { type: "object", properties: { a: 1 } },
      /inputSchema\.properties\.a must be a JSON object/,
    ],
    [
      "non-string required",
      { type: "object", required: [1] },
      /inputSchema\.required\[0\] must be a string/,
    ],
  ];

  it.each(BAD)("rejects %s", (_label, inputSchema, detail) => {
    const errors = errorsOf(withTool({ inputSchema }));
    expect(errors.map((e) => [e.rule, e.blockId, e.entryId])).toEqual([
      ["mcp-fakes/bad-block:g", FILE, null],
    ]);
    const [only] = errors;
    expect(only.message).toContain(`[mcp-fakes/bad-block:g] tool "t" inputSchema`);
    expect(only.message).toMatch(detail);
  });

  it("accepts an object schema with properties and required", () => {
    const inputSchema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    };
    expect(errorsOf(withTool({ inputSchema }))).toEqual([]);
    expect(ToolSchema.safeParse({ name: "t", inputSchema }).success).toBe(true);
  });

  it("outputSchema is not part of the fake tool shape: unknown key (h)", () => {
    expect(errorsOf(withTool({ outputSchema: { type: "object" } })).map((e) => e.toJSON())).toEqual(
      [
        {
          name: "FixtureLoadError",
          rule: "mcp-fakes/bad-block:h",
          file: FILE,
          blockId: FILE,
          entryId: null,
          message: `"${FILE}", block "${FILE}": [mcp-fakes/bad-block:h] tools[0] has unknown key "outputSchema"`,
        },
      ],
    );
  });
});

describe("McpFakeResult type matches the validator", () => {
  it("accepts every content type and the full CallToolResult form at compile time", () => {
    const ok: McpFakeResult[] = [
      "s",
      [{ type: "text", text: "a" }],
      [{ type: "audio", data: B64, mimeType: "audio/wav" }],
      [{ type: "resource_link", uri: "file:///a", name: "a", size: 1 }],
      [{ type: "resource", resource: { uri: "file:///a", blob: B64 } }],
      { content: [], isError: true, structuredContent: { a: 1 }, _meta: {} },
      { tempF: 60 },
    ];
    expect(ok).toHaveLength(7);
  });

  it("rejects shapes the validator rejects at compile time", () => {
    // @ts-expect-error content must be an array
    const a: McpFakeResult = { content: "hello" };
    // @ts-expect-error isError must be a boolean
    const b: McpFakeResult = { content: [], isError: "yes" };
    // @ts-expect-error isError needs a content array
    const c: McpFakeResult = { isError: true };
    // @ts-expect-error unknown content type
    const d: McpFakeResult = [{ type: "video" }];
    expect([a, b, c, d]).toHaveLength(4);
  });
});

describe("what the store hands out is deeply frozen, and read-only in its type", () => {
  const ident = { testId: null, context: null, undeclared: null };

  /** `Array.isArray` narrows a read-only array to `any[]`; this keeps it read-only. */
  function isList(value: unknown): value is readonly unknown[] {
    return Array.isArray(value);
  }

  function isDeepFrozen(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return true;
    return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
  }

  function loaded(): McpFakeStore {
    const store = new McpFakeStore();
    store.add(
      [
        {
          source: FILE,
          blockIndex: null,
          raw: {
            scope: "shared",
            tools: [
              {
                name: "t",
                inputSchema: { type: "object", properties: { a: { type: "object" } } },
                calls: [{ args: { a: { b: [1] } }, result: [{ ...text, _meta: { k: [1] } }] }],
              },
            ],
          },
        },
      ],
      { kind: "file" },
    );
    return store;
  }

  it("an answer's entry, block and tool are deeply frozen; mutating them fails to compile", () => {
    const claim = loaded().claim("t", { a: { b: [1] } }, ident);
    if (claim.kind !== "answer") throw new Error(`expected answer, got ${claim.kind}`);
    expect(isDeepFrozen(claim.entry)).toBe(true);
    expect(isDeepFrozen(claim.block)).toBe(true);
    const { args, result } = claim.entry;
    const tool = claim.block.tools[0];
    if (!args || !isList(result) || !tool.inputSchema) throw new Error("unexpected shape");
    const schema = tool.inputSchema;
    expect(() => {
      // @ts-expect-error args is read-only
      args.a = 2;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error a content array result is read-only
      result.push(text);
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error inputSchema is read-only
      schema.type = "string";
    }).toThrow(TypeError);
  });

  it("evicted and none claims are frozen and read-only", () => {
    const store = loaded();
    const none = store.claim("other", {}, ident);
    if (none.kind !== "none") throw new Error(`expected none, got ${none.kind}`);
    expect(Object.isFrozen(none)).toBe(true);
    expect(() => {
      // @ts-expect-error a claim is read-only
      none.kind = "none";
    }).toThrow(TypeError);

    store.setMaxTestIds(1);
    const t1 = { ...ident, testId: "t1" };
    store.claim("t", { a: { b: [1] } }, t1);
    store.claim("t", { a: { b: [1] } }, { ...ident, testId: "t2" });
    const evicted = store.claim("t", { a: { b: [1] } }, t1);
    if (evicted.kind !== "evicted") throw new Error(`expected evicted, got ${evicted.kind}`);
    expect(Object.isFrozen(evicted)).toBe(true);
    expect(() => {
      // @ts-expect-error a claim is read-only
      evicted.testId = "x";
    }).toThrow(TypeError);
  });

  it("mismatch declared entries and snapshots are deeply frozen", () => {
    const store = loaded();
    const claim = store.claim("t", { a: 1 }, ident);
    if (claim.kind !== "mismatch") throw new Error(`expected mismatch, got ${claim.kind}`);
    expect(isDeepFrozen(claim.declared)).toBe(true);
    const declaredArgs = claim.declared[0].args;
    if (!declaredArgs) throw new Error("expected args");
    expect(() => {
      // @ts-expect-error declared args are read-only
      declaredArgs.a = 2;
    }).toThrow(TypeError);
    expect(isDeepFrozen(store.snapshot(null, null))).toBe(true);
  });
});
