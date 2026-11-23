import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import type { HandlerDefaults } from "../types.js";
import type { MisbehaviorCandidateContext } from "../misbehavior.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  resolveMisbehaviorSeed,
  planMisbehavior,
  prepareMisbehaviorCandidate,
  acceptsDirectType,
  directPropertyTypes,
  normalizeDirectToolSchema,
  prepareInvalidJsonCandidate,
  prepareMissingRequiredCandidate,
  prepareWrongTypeCandidate,
  prepareExtraPropertyCandidate,
  prepareEnumMismatchCandidate,
  prepareNotObjectCandidate,
  prepareUnknownNameCandidate,
  prepareDuplicateIdCandidate,
  prepareLengthCandidate,
  prepareEmptyCandidate,
  prepareRefusalCandidate,
  prepareContentFilterCandidate,
  prepareReasoningOnlyCandidate,
  validateFixtureMisbehavior,
  MISBEHAVIOR_CATALOG,
  WIRE_SUPPORT,
  parseMisbehavior,
  parseMisbehaviorHeader,
  supportsMisbehavior,
  setFixtureMisbehaviorPosition,
  getFixtureMisbehaviorPosition,
  copyFixtureMisbehaviorPosition,
  fixtureMisbehaviorSourceKey,
} from "../misbehavior.js";
import type {
  WireId,
  Fixture,
  FixtureResponse,
  FixtureMatch,
  FixtureFileEntry,
  MisbehaviorConfig,
  MisbehaviorFault,
  MockServerOptions,
} from "../types.js";

describe("bounded direct schema normalization", () => {
  function requestWithSchema(schema: object) {
    return {
      model: "gpt-4o",
      messages: [],
      tools: [
        { type: "function" as const, function: { name: "other", parameters: {} } },
        { type: "function" as const, function: { name: "weather", parameters: schema } },
      ],
    };
  }

  it("looks up the exact tool and preserves direct constraints and declaration order", () => {
    const schema = {
      type: "OBJECT",
      properties: { second: { type: "STRING" }, first: { enum: [1, 2] } },
      required: ["first", "second"],
      additionalProperties: false,
      patternProperties: { "^extra": { type: "boolean" } },
    };
    const request = requestWithSchema(schema);
    const before = structuredClone(request);
    const normalized = normalizeDirectToolSchema(request, "weather");
    expect(normalized).toEqual({
      properties: schema.properties,
      required: schema.required,
      additionalProperties: false,
      patternProperties: schema.patternProperties,
    });
    expect(Object.keys(normalized?.properties ?? {})).toEqual(["second", "first"]);
    expect(normalizeDirectToolSchema(request, "Weather")).toBeUndefined();
    expect(request).toEqual(before);
  });

  it("retains direct constraints without resolving refs or applicators", () => {
    expect(
      normalizeDirectToolSchema(
        requestWithSchema({
          $ref: "#/$defs/tool",
          allOf: [{ required: ["indirect"] }],
          required: ["direct"],
        }),
        "weather",
      ),
    ).toEqual({ properties: {}, required: ["direct"] });
    expect(directPropertyTypes({ $ref: "#/$defs/string", type: "STRING" })).toEqual(["string"]);
    expect(directPropertyTypes({ anyOf: [{ type: "string" }] })).toBeUndefined();
  });

  it.each([
    { properties: [] },
    { properties: null },
    { required: ["city", 1] },
    { patternProperties: [] },
  ])("does not infer constraints from malformed direct fields %j", (schema) => {
    expect(normalizeDirectToolSchema(requestWithSchema(schema), "weather")).toBeUndefined();
  });

  it("treats absent tools or absent schema as unavailable", () => {
    expect(normalizeDirectToolSchema({}, "weather")).toBeUndefined();
    expect(
      normalizeDirectToolSchema(
        { tools: [{ type: "function", function: { name: "weather" } }] },
        "weather",
      ),
    ).toBeUndefined();
  });

  it("normalizes Cohere parameters and required flags in declaration order", () => {
    const definitions = {
      second: { type: "STRING", required: false },
      first: { type: "INTEGER", required: true },
      third: { type: "boolean", required: true },
    };
    const request = { tools: [{ name: "weather", parameter_definitions: definitions }] };
    const before = structuredClone(request);
    const normalized = normalizeDirectToolSchema(request, "weather");
    expect(normalized).toEqual({ properties: definitions, required: ["first", "third"] });
    expect(Object.keys(normalized?.properties ?? {})).toEqual(["second", "first", "third"]);
    expect(request).toEqual(before);
  });

  it.each([
    null,
    { type: "custom", function: { name: "weather", parameters: {} } },
    { name: "weather", parameters: { properties: {} } },
    { name: "weather", input_schema: { properties: {} } },
    { name: "weather", parameter_definitions: [] },
    { name: "weather", parameter_definitions: { city: null } },
    { name: "weather", parameter_definitions: { city: { required: "true" } } },
  ])("does not guess unsupported or malformed tool shapes %j", (tool) => {
    expect(normalizeDirectToolSchema({ tools: [tool] }, "weather")).toBeUndefined();
  });

  it("does not resolve an indirect-only schema", () => {
    expect(
      normalizeDirectToolSchema(
        requestWithSchema({
          $ref: "#/$defs/tool",
          $defs: { tool: { properties: { city: { type: "string" } }, required: ["city"] } },
        }),
        "weather",
      ),
    ).toEqual({ properties: {}, required: [] });
  });

  it.each([
    ["STRING", ["string"]],
    [
      ["String", "NULL", "Integer"],
      ["string", "null", "integer"],
    ],
    [
      ["number", "NUMBER"],
      ["number", "number"],
    ],
  ])("normalizes recognized type %j", (type, expected) => {
    expect(directPropertyTypes({ type })).toEqual(expected);
  });

  it.each([undefined, null, [], ["string", "unknown"], ["string", 1], "unknown", " string "])(
    "does not guess an unsupported or malformed type %j",
    (type) => {
      expect(directPropertyTypes({ type })).toBeUndefined();
    },
  );

  it.each([
    ["string", "text", 1],
    ["number", 1.25, "1"],
    ["integer", 1, 1.25],
    ["boolean", false, "false"],
    ["array", [], {}],
    ["object", {}, []],
    ["null", null, {}],
  ] as const)("recognizes %s without coercion", (type, accepted, rejected) => {
    expect(acceptsDirectType(accepted, type)).toBe(true);
    expect(acceptsDirectType(rejected, type)).toBe(false);
  });

  it("keeps integer within number and excludes null from object", () => {
    expect(acceptsDirectType(1, "number")).toBe(true);
    expect(acceptsDirectType(null, "object")).toBe(false);
    expect(acceptsDirectType(Infinity, "number")).toBe(false);
    expect(acceptsDirectType(NaN, "number")).toBe(false);
  });
});

type InvalidJsonFault = Extract<MisbehaviorFault, { fault: "tool-args-invalid-json" }>;

function invalidJsonCandidate(
  response: FixtureResponse,
  options: Omit<InvalidJsonFault, "fault"> = {},
  stream = false,
) {
  return prepareInvalidJsonCandidate(
    { wire: "openai-chat", response, request: { model: "gpt-4o", messages: [] }, stream },
    { fault: "tool-args-invalid-json", ...options },
  );
}

function expectInvalidArguments(
  response: FixtureResponse,
  expected: string,
  options: Omit<InvalidJsonFault, "fault"> = {},
) {
  const before = structuredClone(response);
  for (const stream of [false, true]) {
    const result = invalidJsonCandidate(response, options, stream);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error(result.detail);
    expect(result.candidate.response).not.toBe(response);
    expect(result.candidate.response).toMatchObject({
      toolCalls: [{ arguments: expected }],
    });
    expect(result.candidate.stop).toBeUndefined();
    expect(() => JSON.parse(expected)).toThrow(SyntaxError);
  }
  expect(response).toEqual(before);
}

describe("pure invalid JSON candidate", () => {
  it.each([
    [undefined, '{"city":'],
    ["truncated", '{"city":'],
    ["trailing-comma", '{"city":"Paris",}'],
    ["single-quotes", "{'city':'Paris'}"],
  ] as const)(
    "prepares %s from canonical JSON without changing the original",
    (style, expected) => {
      expectInvalidArguments(
        {
          toolCalls: [{ name: "weather", id: "call_weather", arguments: ' { "city": "Paris" } ' }],
        },
        expected,
        { style },
      );
    },
  );

  it("retains escaped quotes, backslashes, and apostrophes inside string content", () => {
    const text = 'say "hello" \\ \\"quoted" it\'s';
    const canonical = JSON.stringify({ text });
    const quotedValue = JSON.stringify(text);
    expectInvalidArguments(
      { toolCalls: [{ name: "weather", arguments: canonical }] },
      `{'text':'${quotedValue.slice(1, -1)}'}`,
      { style: "single-quotes" },
    );
  });

  it.each(["", undefined])("uses object defaults for %s arguments", (args) => {
    const call = { name: "weather", arguments: args ?? "" };
    if (args === undefined) Reflect.deleteProperty(call, "arguments");
    expectInvalidArguments({ toolCalls: [call] }, "{");
  });

  it.each([
    ["{}", "single-quotes"],
    ["[]", "single-quotes"],
    ["[]", "trailing-comma"],
    ["1234", "truncated"],
    ["1", "truncated"],
  ] as const)("returns not-applicable for %s with %s", (args, style) => {
    const result = invalidJsonCandidate(
      { toolCalls: [{ name: "weather", arguments: args }] },
      { style, rate: 1, times: 1 },
    );
    expect(result).toEqual({ kind: "not-applicable", detail: expect.any(String) });
  });

  it("uses the first matching tool index and preserves other calls and overrides", () => {
    const response = {
      content: "before",
      finishReason: "length" as const,
      toolCalls: [
        { name: "other", arguments: "{}" },
        { name: "weather", id: "chosen", arguments: '{"city":"Paris"}' },
        { name: "weather", id: "later", arguments: '{"city":"Rome"}' },
      ],
    };
    const before = structuredClone(response);
    const result = invalidJsonCandidate(response, { tool: "weather" });
    expect(result).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 1 },
        response: {
          ...response,
          toolCalls: [
            response.toolCalls[0],
            { ...response.toolCalls[1], arguments: '{"city":' },
            response.toolCalls[2],
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });

  it("transforms authoritative blocks and aligns legacy fields with their output", () => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [{ name: "stale", arguments: "{}" }],
      blocks: [
        { type: "text", text: "before" },
        { type: "toolCall", name: "weather", id: "chosen", arguments: '{"city":"Paris"}' },
        { type: "text", text: "after" },
      ],
    };
    const before = structuredClone(response);
    const result = invalidJsonCandidate(response, { tool: "weather" });
    expect(result).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 0 },
        response: {
          content: "beforeafter",
          toolCalls: [{ name: "weather", id: "chosen", arguments: '{"city":' }],
          blocks: [
            response.blocks![0],
            { ...response.blocks![1], arguments: '{"city":' },
            response.blocks![2],
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });

  it("supports blocks-only output and empty-block legacy fallback", () => {
    for (const response of [
      { blocks: [{ type: "toolCall", name: "weather", arguments: "{}" }] },
      { content: "text", toolCalls: [{ name: "weather", arguments: "{}" }], blocks: [] },
    ] satisfies FixtureResponse[]) {
      expectInvalidArguments(response, "{");
    }
  });

  it.each([
    { content: "text" },
    { toolCalls: [{ name: "other", arguments: "{}" }] },
    {
      content: "stale",
      toolCalls: [{ name: "weather", arguments: "{}" }],
      blocks: [{ type: "text", text: "only text" }],
    },
    { error: { message: "failure" } },
  ] satisfies FixtureResponse[])("returns a genuine target miss %#", (response) => {
    expect(invalidJsonCandidate(response, { tool: "weather" })).toEqual({
      kind: "not-applicable",
      detail: expect.any(String),
    });
  });
});

function expectIssue(input: unknown, rule: string, path: string) {
  expect(parseMisbehavior(input, "fixtures[2].misbehavior")).toMatchObject({
    ok: false,
    issue: { rule: `misbehavior/${rule}`, path: `fixtures[2].misbehavior${path}` },
  });
}

describe("strict misbehavior configuration", () => {
  it.each([
    [
      '{"faults":[{"fault":"empty-response","rate":{"toString":null}}]}',
      "bad-value",
      ".faults[0].rate",
    ],
    ['{"faults":[],"extra":{"toString":null}}', "unknown-key", ".extra"],
  ])("returns issues for malformed JSON values %#", (json, rule, path) => {
    expectIssue(JSON.parse(json), rule, path);
  });

  it("bounds error text and preserves the original value when serialization fails", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const value of ["x".repeat(1000), circular]) {
      const result = parseMisbehavior({ faults: [], extra: value });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected an issue");
      expect(result.issue.value).toBe(value);
      expect(result.issue.message.length).toBeLessThan(300);
    }
  });

  it("looks up the selected fault and honors stream-only support", () => {
    const faults = WIRE_SUPPORT["openai-chat"].faults;
    const original = Object.getOwnPropertyDescriptor(faults, "empty-response");
    if (!original) throw new Error("Missing catalog entry");
    try {
      Object.defineProperty(faults, "empty-response", { ...original, value: "stream-only" });
      expect(supportsMisbehavior("openai-chat", { fault: "empty-response" }, false)).toBe(false);
      expect(supportsMisbehavior("openai-chat", { fault: "empty-response" }, true)).toBe(true);
      expect(supportsMisbehavior("openai-chat", { fault: "content-filter" }, false)).toBe(true);
    } finally {
      Object.defineProperty(faults, "empty-response", original);
    }
  });

  it("declares base support for every fault on every wire", () => {
    for (const support of Object.values(WIRE_SUPPORT)) {
      expect(support).toHaveProperty("faults");
      expect(Object.keys(support.faults).sort()).toEqual(Object.keys(MISBEHAVIOR_CATALOG).sort());
    }
    expect(WIRE_SUPPORT["openai-chat"].faults["empty-response"]).toBe("yes");
    expect(WIRE_SUPPORT.anthropic.faults["content-filter"]).toBe("n/a");
  });

  it.each([
    "tool-args-invalid-json",
    "tool-args-schema-violation",
    "tool-unknown-name",
    "tool-call-id-duplicate",
    "stop-length-mid-tool",
    "empty-response",
    "refusal",
    "content-filter",
    "reasoning-only",
  ])("expands %s shorthand", (fault) => {
    expect(parseMisbehavior(fault)).toEqual({ ok: true, config: { faults: [{ fault }] } });
  });

  it("normalizes decimal rate grammar and rejects negative zero", () => {
    expect(parseMisbehavior({ faults: [{ fault: "empty-response", rate: " 0.5 " }] })).toEqual({
      ok: true,
      config: { faults: [{ fault: "empty-response", rate: 0.5 }] },
    });
    expectIssue(
      { faults: [{ fault: "empty-response", rate: -0 }] },
      "bad-value",
      ".faults[0].rate",
    );
    expectIssue(
      { faults: [{ fault: "empty-response", rate: "1e-1" }] },
      "bad-value",
      ".faults[0].rate",
    );
  });

  it("retains all declared variants without mutating input", () => {
    const config: MisbehaviorConfig = {
      seed: -12,
      faults: [
        {
          fault: "tool-args-invalid-json",
          style: "single-quotes",
          rate: 0,
          times: 2,
          tool: "weather",
          providers: ["openai-chat"],
        },
        { fault: "tool-args-schema-violation", violation: "not-object", property: "city" },
        { fault: "tool-unknown-name", name: "other" },
        { fault: "stop-length-mid-tool", at: 0.25 },
        { fault: "refusal", message: "", category: null },
        { fault: "reasoning-only", reasoning: "" },
      ],
    };
    const before = structuredClone(config);
    const parsed = parseMisbehavior(config);
    expect(parsed).toEqual({ ok: true, config: before });
    expect(config).toEqual(before);
    if (parsed.ok) {
      parsed.config.faults[0].providers?.push("anthropic");
    }
    expect(config).toEqual(before);
  });

  it.each([{ faults: [] }, { seed: "random", faults: [] }, { seed: 0, faults: [] }])(
    "accepts opt-out and seed %j",
    (config) => {
      expect(parseMisbehavior(config)).toEqual({ ok: true, config });
    },
  );

  it.each([
    [null, "bad-value", ""],
    [[], "bad-value", ""],
    [{}, "bad-value", ".faults"],
    ["unknown", "bad-value", ""],
    [{ faults: [], extra: true }, "unknown-key", ".extra"],
    [{ faults: "empty-response" }, "bad-value", ".faults"],
    [{ seed: 1.5, faults: [] }, "bad-value", ".seed"],
    [{ seed: Infinity, faults: [] }, "bad-value", ".seed"],
    [{ faults: [null] }, "bad-value", ".faults[0]"],
    [{ faults: [{ fault: "missing" }] }, "bad-value", ".faults[0].fault"],
    [
      { faults: [{ fault: "empty-response", style: "truncated" }] },
      "unknown-key",
      ".faults[0].style",
    ],
    [{ faults: [{ fault: "refusal", message: 3 }] }, "bad-value", ".faults[0].message"],
    [{ faults: [{ fault: "refusal", category: 3 }] }, "bad-value", ".faults[0].category"],
    [
      { faults: [{ fault: "tool-args-invalid-json", style: "no" }] },
      "bad-value",
      ".faults[0].style",
    ],
    [
      { faults: [{ fault: "tool-args-schema-violation", violation: "no" }] },
      "bad-value",
      ".faults[0].violation",
    ],
    [{ faults: [{ fault: "empty-response", rate: "0x1" }] }, "bad-value", ".faults[0].rate"],
    [{ faults: [{ fault: "empty-response", rate: NaN }] }, "bad-value", ".faults[0].rate"],
    [{ faults: [{ fault: "empty-response", rate: 1.1 }] }, "bad-value", ".faults[0].rate"],
    [{ faults: [{ fault: "empty-response", times: 0 }] }, "bad-value", ".faults[0].times"],
    [{ faults: [{ fault: "empty-response", times: 1.5 }] }, "bad-value", ".faults[0].times"],
    [{ faults: [{ fault: "stop-length-mid-tool", at: 1 }] }, "bad-value", ".faults[0].at"],
    [{ faults: [{ fault: "stop-length-mid-tool", at: 0 }] }, "bad-value", ".faults[0].at"],
    [
      { faults: [{ fault: "empty-response", providers: "openai-chat" }] },
      "bad-value",
      ".faults[0].providers",
    ],
    [
      { faults: [{ fault: "empty-response", providers: ["chat"] }] },
      "bad-value",
      ".faults[0].providers[0]",
    ],
  ])("rejects invalid configuration %#", (input, rule, path) =>
    expectIssue(input, String(rule), String(path)),
  );

  it("declares each wire and enables OpenAI Chat and Responses in both modes", () => {
    expect(Object.keys(WIRE_SUPPORT)).toHaveLength(11);
    expect(Object.keys(MISBEHAVIOR_CATALOG)).toHaveLength(9);
    for (const support of Object.values(WIRE_SUPPORT))
      expect(Object.keys(support.faults)).toEqual(Object.keys(MISBEHAVIOR_CATALOG));
    for (const wire of ["openai-chat", "openai-responses"]) {
      for (const fault of Object.keys(MISBEHAVIOR_CATALOG)) {
        const parsed = parseMisbehavior(fault);
        if (!parsed.ok) throw new Error(parsed.issue.message);
        for (const stream of [false, true]) {
          expect(supportsMisbehavior(wire, parsed.config.faults[0], stream)).toBe(true);
        }
      }
    }
    expect(
      supportsMisbehavior("openai-chat", { fault: "refusal", category: "safety" }, false),
    ).toBe(false);
    expect(supportsMisbehavior("openai-chat", { fault: "refusal", category: null }, true)).toBe(
      false,
    );
  });

  it("types public configuration slots and fault-specific parameters", () => {
    expectTypeOf<Fixture["misbehavior"]>().toEqualTypeOf<
      MisbehaviorConfig | MisbehaviorFault["fault"] | undefined
    >();
    expectTypeOf<FixtureFileEntry["misbehavior"]>().toEqualTypeOf<Fixture["misbehavior"]>();
    expectTypeOf<MockServerOptions["misbehavior"]>().toEqualTypeOf<Fixture["misbehavior"]>();
    const valid: MisbehaviorFault = { fault: "refusal", category: null };
    // @ts-expect-error Parameters must match the discriminant.
    const invalid: MisbehaviorFault = { fault: "empty-response", style: "truncated" };
    expect(valid.fault).not.toBe(invalid.fault);
  });
});

function identityFixture(match: FixtureMatch = {}, position?: string): Fixture {
  const fixture: Fixture = { match, response: { content: "ordinary" } };
  if (position !== undefined) setFixtureMisbehaviorPosition(fixture, position);
  return fixture;
}

describe("fixture misbehavior source identity", () => {
  const config: MisbehaviorConfig = { faults: [{ fault: "empty-response", times: 1 }] };
  const key = (match: FixtureMatch, position = "nested/suite.json#0", value = config) =>
    fixtureMisbehaviorSourceKey(identityFixture(match, position), value);

  it("stores positions outside the public fixture and preserves them through clones", () => {
    const fixture = identityFixture({ userMessage: "weather" }, "https://example.test/a.json#3");
    const clone: Fixture = { ...fixture, match: { ...fixture.match } };
    expect(getFixtureMisbehaviorPosition(clone)).toBeUndefined();
    copyFixtureMisbehaviorPosition(fixture, clone);
    expect(getFixtureMisbehaviorPosition(clone)).toBe("https://example.test/a.json#3");
    expect(Object.keys(fixture)).toEqual(["match", "response"]);
    expect(fixtureMisbehaviorSourceKey(clone, config)).toBe(
      fixtureMisbehaviorSourceKey(fixture, config),
    );
  });

  it("does not fabricate positions when copying an unpositioned fixture", () => {
    const fixture = identityFixture();
    const clone = identityFixture();
    copyFixtureMisbehaviorPosition(fixture, clone);
    expect(getFixtureMisbehaviorPosition(clone)).toBeUndefined();
    setFixtureMisbehaviorPosition(clone, "code#4");
    copyFixtureMisbehaviorPosition(fixture, clone);
    expect(getFixtureMisbehaviorPosition(clone)).toBe("code#4");
  });

  it.each([undefined, ""])("requires a nonempty assigned position (%s)", (position) => {
    expect(() => fixtureMisbehaviorSourceKey(identityFixture({}, position), config)).toThrow(
      /fixture misbehavior position/i,
    );
  });

  it("uses the prescribed UTF-8 FNV formula over complete canonical components", () => {
    const match: FixtureMatch = {
      userMessage: /weather/gi,
      systemMessage: ["a", "b"],
      predicate: () => true,
      model: "gpt-é",
    };
    const value: MisbehaviorConfig = {
      seed: 7,
      faults: [{ times: 2, rate: 0.5, message: "seed", fault: "refusal" }],
    };
    // Independent FNV-1a vector over sorted match JSON | seedless config JSON | position.
    expect(key(match, "nested/é.json#2", value)).toBe("fixture:831070208");
  });

  it("canonicalizes object order without changing inputs or filling defaults", () => {
    const first: FixtureMatch = { model: "gpt", userMessage: "weather" };
    const second: FixtureMatch = { userMessage: "weather", model: "gpt", context: undefined };
    const value: MisbehaviorConfig = { seed: 7, faults: [{ times: 1, fault: "empty-response" }] };
    const before = structuredClone(value);
    expect(key(first)).toBe(key(second, undefined, value));
    expect(key(first)).toBe(key(first));
    expect(value).toEqual(before);
    expect(first).toEqual({ model: "gpt", userMessage: "weather" });
  });

  it("omits only top-level seed and preserves other configuration values and array order", () => {
    const seeded: MisbehaviorConfig = { ...config, seed: 42 };
    expect(key({}, undefined, seeded)).toBe(key({}, undefined, { ...config, seed: "random" }));
    expect(key({}, undefined, seeded)).toBe(key({}));
    const variants: MisbehaviorConfig[] = [
      { faults: [{ fault: "empty-response", times: 2 }] },
      { faults: [{ fault: "empty-response", times: 1, rate: 1 }] },
      { faults: [{ fault: "empty-response", times: 1, tool: "seed" }] },
      { faults: [{ fault: "refusal", message: "seed" }] },
      { faults: [{ fault: "refusal", message: "other" }] },
      { faults: [{ fault: "empty-response", providers: ["openai-chat", "anthropic"] }] },
      { faults: [{ fault: "empty-response", providers: ["anthropic", "openai-chat"] }] },
      { faults: [{ fault: "empty-response" }, { fault: "refusal" }] },
      { faults: [{ fault: "refusal" }, { fault: "empty-response" }] },
    ];
    const keys = [key({}), ...variants.map((value) => key({}, undefined, value))];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("retains long strings, complete arrays, and RegExp source and flags", () => {
    const prefix = "same-prefix".repeat(200);
    const matches: FixtureMatch[] = [
      { userMessage: `${prefix}a` },
      { userMessage: `${prefix}b` },
      { systemMessage: [prefix, "a"] },
      { systemMessage: [prefix, "b"] },
      { systemMessage: ["b", prefix] },
      { userMessage: "/weather/i" },
      { userMessage: /weather/i },
      { userMessage: /weather/g },
      { userMessage: /weather2/i },
    ];
    expect(new Set(matches.map((match) => key(match))).size).toBe(matches.length);
  });

  it("uses literal fn for predicates and distinct assigned positions for their identity", () => {
    const first = { predicate: () => true };
    const second = { predicate: () => false };
    expect(key(first, "code#0")).toBe(key(second, "code#0"));
    expect(key(first, "code#0")).not.toBe(key(second, "code#1"));
  });

  it("retains exact logical source spelling and load index", () => {
    const positions = [
      "nested/suite.json#0",
      "./nested/suite.json#0",
      "nested/suite.json#1",
      "https://example.test/suite.json#0",
    ];
    expect(new Set(positions.map((position) => key({}, position))).size).toBe(positions.length);
  });
});

describe("scalar misbehavior HTTP header", () => {
  it("distinguishes an absent header from an invalid empty header", () => {
    expect(parseMisbehaviorHeader(undefined)).toBeUndefined();
    for (const value of ["", "   ", []]) {
      expect(parseMisbehaviorHeader(value)).toMatchObject({ ok: false });
    }
  });

  it("accepts each bare catalog fault and a single-value header array", () => {
    for (const fault of Object.keys(MISBEHAVIOR_CATALOG)) {
      expect(parseMisbehaviorHeader(` ${fault} `)).toEqual(parseMisbehavior(fault));
      expect(parseMisbehaviorHeader([fault])).toEqual(parseMisbehavior(fault));
    }
  });

  it("parses the documented scalar grammar and trims separator whitespace", () => {
    expect(
      parseMisbehaviorHeader(
        " tool-args-schema-violation ; violation = wrong-type ; tool = get_weather ; property=city ; rate=0.25 ",
      ),
    ).toEqual({
      ok: true,
      config: {
        faults: [
          {
            fault: "tool-args-schema-violation",
            violation: "wrong-type",
            tool: "get_weather",
            property: "city",
            rate: 0.25,
          },
        ],
      },
    });
    expect(parseMisbehaviorHeader("stop-length-mid-tool; at=0.25")).toEqual({
      ok: true,
      config: { faults: [{ fault: "stop-length-mid-tool", at: 0.25 }] },
    });
  });

  it.each([
    "empty-response; times=1",
    "empty-response; providers=openai-chat",
    "empty-response; providers=[openai-chat]",
    "empty-response; seed=42",
    "empty-response; fault=refusal",
    "empty-response; style=truncated",
    "empty-response; constructor=x",
    "empty-response; __proto__=x",
  ])("rejects forbidden or unknown parameter %s", (header) => {
    expect(parseMisbehaviorHeader(header)).toMatchObject({
      ok: false,
      issue: { rule: "misbehavior/unknown-key" },
    });
  });

  it.each([
    "unknown-fault",
    "empty-response;",
    "empty-response;;rate=1",
    "empty-response; rate",
    "empty-response; =1",
    "empty-response; rate=1; rate=0",
    "empty-response; rate=1; rate=1",
    "empty-response; rate=1e-1",
    "empty-response; rate=1.1",
    "stop-length-mid-tool; at=1",
    "stop-length-mid-tool; at=0x1",
    "tool-args-invalid-json; style=unknown",
  ])("rejects malformed grammar or invalid scalar %s", (header) => {
    expect(parseMisbehaviorHeader(header)).toMatchObject({
      ok: false,
      issue: { rule: "misbehavior/bad-value" },
    });
  });

  it("never selects the first of multiple fault headers", () => {
    for (const value of [
      ["empty-response", "refusal"],
      ["empty-response", "empty-response"],
      "empty-response, refusal",
      "empty-response, empty-response",
      "empty-response; rate=1, refusal",
    ]) {
      expect(parseMisbehaviorHeader(value)).toMatchObject({ ok: false });
    }
  });
});

describe("literal header scalar boundaries", () => {
  it.each([
    ["refusal; message=a=b, c", { fault: "refusal", message: "a=b, c" }],
    ["refusal; message=", { fault: "refusal", message: "" }],
    ["refusal; category=null", { fault: "refusal", category: "null" }],
    ['refusal; message="quoted"', { fault: "refusal", message: '"quoted"' }],
    [
      "reasoning-only; reasoning=step\\nnext",
      { fault: "reasoning-only", reasoning: "step\\nnext" },
    ],
  ])("preserves literal string semantics in %s", (header, fault) => {
    expect(parseMisbehaviorHeader(header)).toEqual({ ok: true, config: { faults: [fault] } });
  });

  it("normalizes repeated values as one complete grammar, retaining comma in a string", () => {
    const values = ["refusal; message=first", "second"];
    const expected = {
      ok: true,
      config: { faults: [{ fault: "refusal", message: "first, second" }] },
    };
    expect(parseMisbehaviorHeader(values)).toEqual(expected);
    expect(parseMisbehaviorHeader(values.join(", "))).toEqual(expected);
    expect(values).toEqual(["refusal; message=first", "second"]);
  });

  it("does not coerce missing or nondecimal numeric scalars", () => {
    for (const value of ["", " ", "-0", "+0.5", "1e-1", "NaN"]) {
      expect(parseMisbehaviorHeader(`stop-length-mid-tool; at=${value}`)).toMatchObject({
        ok: false,
      });
      expect(parseMisbehaviorHeader(`empty-response; rate=${value}`)).toMatchObject({ ok: false });
    }
  });
});

it("retains invalid numeric header text in its structured issue", () => {
  expect(parseMisbehaviorHeader("stop-length-mid-tool; at=bad")).toMatchObject({
    ok: false,
    issue: {
      rule: "misbehavior/bad-value",
      path: "headers.x-aimock-misbehavior.faults[0].at",
      value: "bad",
    },
  });
});

function staticFixture(
  response: Fixture["response"],
  faults: MisbehaviorConfig["faults"],
  endpoint?: FixtureMatch["endpoint"],
): Fixture {
  return { match: { endpoint }, response, misbehavior: { faults } };
}
const weatherCall = { name: "weather", arguments: '{"city":"Paris"}' };

describe("static fixture misbehavior applicability", () => {
  it("accepts absent config, opt-out, and returns parser issues with the supplied path", () => {
    expect(validateFixtureMisbehavior(identityFixture())).toBeUndefined();
    expect(
      validateFixtureMisbehavior(staticFixture({ error: { message: "bad" } }, [])),
    ).toBeUndefined();
    const fixture = identityFixture();
    Object.assign(fixture, { misbehavior: { faults: [], typo: true } });
    expect(validateFixtureMisbehavior(fixture, "fixtures[2].misbehavior")).toMatchObject({
      rule: "misbehavior/unknown-key",
      path: "fixtures[2].misbehavior.typo",
    });
  });

  it.each([
    [{ content: "plain" }, { fault: "tool-args-invalid-json" }],
    [{ error: { message: "bad" } }, { fault: "empty-response" }],
    [{ json: {} }, { fault: "empty-response" }],
    [{ toolCalls: [weatherCall] }, { fault: "empty-response", tool: "missing" }],
    [
      { content: "plain", toolCalls: [weatherCall], blocks: [{ type: "text", text: "only text" }] },
      { fault: "tool-unknown-name" },
    ],
  ] satisfies [Fixture["response"], MisbehaviorFault][])(
    "rejects statically inapplicable output %#",
    (response, fault) => {
      expect(
        validateFixtureMisbehavior(staticFixture(response, [fault]), "fixtures[2].misbehavior"),
      ).toMatchObject({
        rule: "misbehavior/not-applicable",
        path: "fixtures[2].misbehavior.faults[0]",
        value: fault,
      });
    },
  );

  it("uses authoritative nonempty blocks and falls back when blocks are empty", () => {
    for (const response of [
      { blocks: [{ type: "toolCall", ...weatherCall }] },
      { content: "", toolCalls: [weatherCall], blocks: [] },
    ] satisfies Fixture["response"][]) {
      expect(
        validateFixtureMisbehavior(
          staticFixture(response, [{ fault: "tool-call-id-duplicate", tool: "weather" }], "chat"),
        ),
      ).toBeUndefined();
    }
  });

  it("defers factory response inspection without invoking it but checks known unsupported wires", () => {
    const factory = () => {
      throw new Error("must not invoke");
    };
    expect(
      validateFixtureMisbehavior(staticFixture(factory, [{ fault: "tool-unknown-name" }])),
    ).toBeUndefined();
    expect(
      validateFixtureMisbehavior(staticFixture(factory, [{ fault: "reasoning-only" }], "realtime")),
    ).toMatchObject({ rule: "misbehavior/unsupported-on-wire" });
  });

  it("intersects family wires with providers before applicability", () => {
    const response = { content: "plain" };
    expect(
      validateFixtureMisbehavior(
        staticFixture(
          response,
          [{ fault: "tool-unknown-name", providers: ["openai-realtime"] }],
          "chat",
        ),
      ),
    ).toBeUndefined();
    expect(
      validateFixtureMisbehavior(
        staticFixture(response, [{ fault: "tool-unknown-name", providers: [] }]),
      ),
    ).toBeUndefined();
    expect(
      validateFixtureMisbehavior(
        staticFixture(response, [{ fault: "content-filter", providers: ["anthropic"] }], "chat"),
      ),
    ).toMatchObject({ rule: "misbehavior/unsupported-on-wire" });
    expect(
      validateFixtureMisbehavior(
        staticFixture(
          response,
          [{ fault: "content-filter", providers: ["openai-chat", "anthropic"] }],
          "chat",
        ),
      ),
    ).toBeUndefined();
    expect(
      validateFixtureMisbehavior(staticFixture(response, [{ fault: "empty-response" }])),
    ).toBeUndefined();
  });

  it("rejects selected nonchat families even when their response resembles text", () => {
    expect(
      validateFixtureMisbehavior(
        staticFixture({ content: "text" }, [{ fault: "empty-response" }], "speech"),
      ),
    ).toMatchObject({ rule: "misbehavior/not-applicable" });
  });

  it("checks all entries independent of rate and retains the first offending entry", () => {
    expect(
      validateFixtureMisbehavior(
        staticFixture({ content: "text" }, [
          { fault: "empty-response" },
          { fault: "tool-unknown-name", rate: 0 },
          { fault: "refusal", category: null },
        ]),
      ),
    ).toMatchObject({ rule: "misbehavior/not-applicable", path: "misbehavior.faults[1]" });
  });

  it.each([
    ["{}", { fault: "tool-args-invalid-json", style: "single-quotes" }],
    ["[]", { fault: "tool-args-invalid-json", style: "trailing-comma" }],
    ["1234", { fault: "tool-args-invalid-json" }],
    ["1", { fault: "stop-length-mid-tool" }],
    ["null", { fault: "tool-args-schema-violation", violation: "not-object" }],
    ["[]", { fault: "tool-args-schema-violation" }],
    ["broken", { fault: "tool-args-schema-violation" }],
  ] satisfies [string, MisbehaviorFault][])(
    "rejects decidable argument impossibility %#",
    (args, fault) => {
      expect(
        validateFixtureMisbehavior(
          staticFixture({ toolCalls: [{ ...weatherCall, arguments: args }] }, [fault]),
        ),
      ).toMatchObject({ rule: "misbehavior/not-applicable" });
    },
  );

  it("accepts canonical/default feasible cuts", () => {
    for (const fault of [
      { fault: "tool-args-invalid-json" },
      { fault: "stop-length-mid-tool" },
    ] satisfies MisbehaviorFault[]) {
      expect(
        validateFixtureMisbehavior(
          staticFixture({ toolCalls: [{ ...weatherCall, arguments: "" }] }, [fault]),
        ),
      ).toBeUndefined();
    }
  });

  it("rejects unsupported parameters but defers a supported streaming possibility", () => {
    expect(
      validateFixtureMisbehavior(
        staticFixture(
          { content: "text" },
          [{ fault: "refusal", category: null, providers: ["openai-responses"] }],
          "chat",
        ),
      ),
    ).toMatchObject({ rule: "misbehavior/unsupported-on-wire" });
    const faults = WIRE_SUPPORT["openai-chat"].faults;
    const original = Object.getOwnPropertyDescriptor(faults, "empty-response");
    if (!original) throw new Error("Missing catalog entry");
    try {
      Object.defineProperty(faults, "empty-response", { ...original, value: "stream-only" });
      expect(
        validateFixtureMisbehavior(
          staticFixture({ content: "text" }, [{ fault: "empty-response" }], "chat"),
        ),
      ).toBeUndefined();
    } finally {
      Object.defineProperty(faults, "empty-response", original);
    }
  });
});

describe("K2 static argument prerequisites", () => {
  function validateArgs(
    args: string,
    fault: Extract<MisbehaviorFault, { fault: "tool-args-schema-violation" }>,
  ) {
    return validateFixtureMisbehavior(
      staticFixture({ toolCalls: [{ ...weatherCall, arguments: args }] }, [fault]),
    );
  }

  it.each([undefined, "missing-required", "wrong-type", "enum-mismatch"] as const)(
    "rejects empty/default arguments or an absent explicit property for %s",
    (violation) => {
      const fault = {
        fault: "tool-args-schema-violation",
        ...(violation === undefined ? {} : { violation }),
      } as const;
      for (const args of ["{}", ""]) {
        expect(validateArgs(args, fault)).toMatchObject({ rule: "misbehavior/not-applicable" });
      }
      expect(validateArgs(weatherCall.arguments, { ...fault, property: "absent" })).toMatchObject({
        rule: "misbehavior/not-applicable",
      });
    },
  );

  it.each([
    ['{"__aimock_extra":false}', undefined],
    [weatherCall.arguments, "city"],
  ] as const)("rejects an already-present extra-property name %#", (args, property) => {
    expect(
      validateArgs(args, {
        fault: "tool-args-schema-violation",
        violation: "extra-property",
        ...(property === undefined ? {} : { property }),
      }),
    ).toMatchObject({ rule: "misbehavior/not-applicable" });
  });

  it("keeps argument-feasible schema proofs at request time", () => {
    for (const violation of ["missing-required", "wrong-type", "enum-mismatch"] as const) {
      for (const property of [undefined, "city"]) {
        expect(
          validateArgs(weatherCall.arguments, {
            fault: "tool-args-schema-violation",
            violation,
            ...(property === undefined ? {} : { property }),
          }),
        ).toBeUndefined();
      }
    }
    for (const violation of ["extra-property", "not-object"] as const) {
      expect(
        validateArgs("{}", { fault: "tool-args-schema-violation", violation }),
      ).toBeUndefined();
    }
  });
});

type SchemaViolationFault = Extract<MisbehaviorFault, { fault: "tool-args-schema-violation" }>;

function missingRequiredCandidate(
  response: FixtureResponse,
  schema: object = { required: ["city"] },
  options: Omit<SchemaViolationFault, "fault"> = {},
) {
  return prepareMissingRequiredCandidate(
    {
      wire: "openai-chat",
      response,
      stream: false,
      request: {
        model: "gpt-4o",
        messages: [],
        tools: [{ type: "function", function: { name: "weather", parameters: schema } }],
      },
    },
    { fault: "tool-args-schema-violation", ...options },
  );
}

describe("pure missing-required candidate", () => {
  it("removes exactly the first present required name in required order from a copy", () => {
    const response = {
      toolCalls: [
        {
          name: "weather",
          id: "chosen",
          arguments: ' { "city": "Paris", "units": "C", "nested": { "keep": true } } ',
        },
      ],
    };
    const before = structuredClone(response);
    expect(
      missingRequiredCandidate(response, {
        properties: { city: {}, units: {} },
        required: ["absent", "units", "city"],
      }),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 0 },
        response: {
          toolCalls: [
            { name: "weather", id: "chosen", arguments: '{"city":"Paris","nested":{"keep":true}}' },
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });

  it("honors an explicit required property and the first named call", () => {
    const response = {
      toolCalls: [
        { name: "other", arguments: "{}" },
        { name: "weather", arguments: '{"city":"Paris","units":"C"}' },
        { name: "weather", arguments: '{"city":"Rome"}' },
      ],
    };
    const before = structuredClone(response);
    expect(
      missingRequiredCandidate(
        response,
        { required: ["city", "units"] },
        { tool: "weather", property: "units" },
      ),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 1 },
        response: {
          toolCalls: [
            response.toolCalls[0],
            { ...response.toolCalls[1], arguments: '{"city":"Paris"}' },
            response.toolCalls[2],
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });

  it("uses authoritative ordered blocks and preserves the rest of the response", () => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [{ name: "stale", arguments: "{}" }],
      blocks: [
        { type: "text", text: "before" },
        { type: "toolCall", name: "weather", id: "chosen", arguments: '{"city":"Paris"}' },
        { type: "text", text: "after" },
      ],
    };
    const before = structuredClone(response);
    expect(missingRequiredCandidate(response)).toMatchObject({
      kind: "ready",
      candidate: {
        response: {
          content: "beforeafter",
          toolCalls: [{ name: "weather", id: "chosen", arguments: "{}" }],
          blocks: [
            response.blocks![0],
            { ...response.blocks![1], arguments: "{}" },
            response.blocks![2],
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });

  it.each([
    { schema: { required: ["city"] }, property: "optional" },
    { schema: { required: ["missing"] }, property: undefined },
    { schema: { required: ["city", "missing"] }, property: "missing" },
    { schema: { $ref: "#/$defs/tool" }, property: undefined },
  ])("rejects optional, absent or unproven deletion %j", ({ schema, property }) => {
    expect(
      missingRequiredCandidate(
        { toolCalls: [{ name: "weather", arguments: '{"city":"Paris","optional":true}' }] },
        schema,
        { property },
      ),
    ).toEqual({ kind: "not-applicable", detail: expect.any(String) });
  });

  it.each(["[]", "null", "123", "{", "{}"])("rejects non-object or no-op arguments %s", (args) => {
    expect(missingRequiredCandidate({ toolCalls: [{ name: "weather", arguments: args }] })).toEqual(
      { kind: "not-applicable", detail: expect.any(String) },
    );
  });

  it.each<FixtureResponse>([
    { content: "text" },
    { error: { message: "failed" } },
    { toolCalls: [] },
    { toolCalls: [{ name: "other", arguments: '{"city":"Paris"}' }] },
  ])("rejects an absent target or schema %j", (response) => {
    expect(missingRequiredCandidate(response)).toEqual({
      kind: "not-applicable",
      detail: expect.any(String),
    });
  });

  it("treats inherited-looking required names as ordinary own JSON properties", () => {
    expect(
      missingRequiredCandidate(
        { toolCalls: [{ name: "weather", arguments: '{"__proto__":1,"constructor":2}' }] },
        { required: ["__proto__", "constructor"] },
      ),
    ).toMatchObject({
      kind: "ready",
      candidate: { response: { toolCalls: [{ arguments: '{"constructor":2}' }] } },
    });
  });
});

function wrongTypeCandidate(
  response: FixtureResponse,
  schema: object = { properties: { city: { type: "string" } } },
  options: Omit<SchemaViolationFault, "fault"> = {},
) {
  return prepareWrongTypeCandidate(
    {
      wire: "openai-chat",
      response,
      stream: false,
      request: {
        model: "gpt-4o",
        messages: [],
        tools: [{ type: "function", function: { name: "weather", parameters: schema } }],
      },
    },
    { fault: "tool-args-schema-violation", violation: "wrong-type", ...options },
  );
}

describe("pure wrong-type candidate", () => {
  it.each([
    { type: "STRING", initial: "Paris", expected: 12345 },
    { type: "number", initial: 1.5, expected: "not-a-number" },
    { type: "integer", initial: 1, expected: "not-a-number" },
    { type: "boolean", initial: false, expected: "true" },
    { type: "array", initial: [], expected: {} },
    { type: "object", initial: {}, expected: "[object]" },
    { type: "null", initial: null, expected: 12345 },
    { type: ["boolean"], initial: false, expected: 12345 },
    { type: ["STRING", "INTEGER"], initial: "Paris", expected: {} },
    { type: ["number", "string", "object"], initial: "Paris", expected: null },
    { type: ["integer", "number"], initial: 1, expected: "not-a-number" },
  ])(
    "selects the specified replacement outside every accepted type: %j",
    ({ type, initial, expected }) => {
      const response = {
        toolCalls: [{ name: "weather", arguments: JSON.stringify({ city: initial }) }],
      };
      const before = structuredClone(response);
      const result = wrongTypeCandidate(response, { properties: { city: { type } } });
      expect(result).toMatchObject({
        kind: "ready",
        candidate: {
          target: { tool: "weather", index: 0 },
          detail: "wrong-type",
          response: { toolCalls: [{ arguments: JSON.stringify({ city: expected }) }] },
        },
      });
      for (const accepted of directPropertyTypes({ type }) ?? []) {
        expect(acceptsDirectType(expected, accepted)).toBe(false);
      }
      expect(response).toEqual(before);
    },
  );

  it("selects in declaration order, skipping absent and unresolved properties", () => {
    expect(
      wrongTypeCandidate(
        { toolCalls: [{ name: "weather", arguments: '{"last":true,"city":"Paris","unknown":1}' }] },
        {
          properties: {
            absent: { type: "string" },
            unknown: { $ref: "#/$defs/x" },
            city: { type: "string", anyOf: [{ type: "number" }] },
            last: { type: "boolean" },
          },
        },
      ),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        response: { toolCalls: [{ arguments: '{"last":true,"city":12345,"unknown":1}' }] },
      },
    });
  });

  it("uses explicit property and first matching effective block call without mutating", () => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [{ name: "stale", arguments: "{}" }],
      blocks: [
        { type: "text", text: "before" },
        { type: "toolCall", name: "other", arguments: "{}" },
        {
          type: "toolCall",
          name: "weather",
          id: "chosen",
          arguments: '{"city":"Paris","units":true}',
        },
        { type: "toolCall", name: "weather", arguments: '{"city":"Rome"}' },
      ],
    };
    const before = structuredClone(response);
    const result = wrongTypeCandidate(
      response,
      { properties: { city: { type: "string" }, units: { type: "boolean" } } },
      { tool: "weather", property: "units" },
    );
    expect(result).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 1 },
        response: {
          content: "before",
          toolCalls: [
            { name: "other", arguments: "{}" },
            { name: "weather", id: "chosen", arguments: '{"city":"Paris","units":"true"}' },
            { name: "weather", arguments: '{"city":"Rome"}' },
          ],
          blocks: [
            before.blocks![0],
            before.blocks![1],
            { ...before.blocks![2], arguments: '{"city":"Paris","units":"true"}' },
            before.blocks![3],
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });

  it.each([
    {},
    { $ref: "#/$defs/x" },
    { type: "unknown" },
    { type: ["string", "unknown"] },
    { type: [] },
    { type: ["number", "string", "object", "null"] },
  ])("rejects unresolved or candidate-covering types %j", (propertySchema) => {
    expect(
      wrongTypeCandidate(
        { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
        { properties: { city: propertySchema } },
      ),
    ).toMatchObject({ kind: "not-applicable" });
  });

  it.each(["missing", "constructor"])(
    "requires explicit property %s to be present and declared",
    (property) => {
      expect(
        wrongTypeCandidate(
          { toolCalls: [{ name: "weather", arguments: '{"city":"Paris","constructor":1}' }] },
          undefined,
          { property },
        ),
      ).toMatchObject({ kind: "not-applicable" });
    },
  );

  it.each(["[]", "null", "123", "{", "{}", '{"city":12345}'])(
    "rejects non-object, absent, or unchanged arguments %s",
    (args) => {
      expect(
        wrongTypeCandidate({ toolCalls: [{ name: "weather", arguments: args }] }),
      ).toMatchObject({ kind: "not-applicable" });
    },
  );

  it.each<FixtureResponse>([
    { content: "text" },
    { error: { message: "failed" } },
    { toolCalls: [] },
    { toolCalls: [{ name: "other", arguments: "{}" }] },
  ])("rejects absent target/schema %j", (response) => {
    expect(wrongTypeCandidate(response)).toMatchObject({ kind: "not-applicable" });
  });
});

function extraPropertyCandidate(
  response: FixtureResponse = { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
  schema: object = { properties: { city: { type: "string" } }, additionalProperties: false },
  options: Omit<SchemaViolationFault, "fault"> = {},
) {
  return prepareExtraPropertyCandidate(
    {
      wire: "openai-chat",
      response,
      stream: false,
      request: {
        model: "gpt-4o",
        messages: [],
        tools: [{ type: "function", function: { name: "weather", parameters: schema } }],
      },
    },
    { fault: "tool-args-schema-violation", violation: "extra-property", ...options },
  );
}

describe("pure extra-property candidate", () => {
  it.each([undefined, "custom", "__proto__", "constructor"])(
    "adds exactly the requested/default property %s as an own true value without mutation",
    (property) => {
      const response = {
        toolCalls: [{ name: "weather", id: "chosen", arguments: '{"city":"Paris"}' }],
      };
      const schema = { properties: { city: { type: "string" } }, additionalProperties: false };
      const before = structuredClone({ response, schema });
      expect(extraPropertyCandidate(response, schema, { property })).toMatchObject({
        kind: "ready",
        candidate: {
          target: { tool: "weather", index: 0 },
          detail: "extra-property",
          response: {
            toolCalls: [
              {
                name: "weather",
                id: "chosen",
                arguments: JSON.stringify({ city: "Paris", [property ?? "__aimock_extra"]: true }),
              },
            ],
          },
        },
      });
      expect({ response, schema }).toEqual(before);
    },
  );

  it.each([
    {},
    { additionalProperties: true },
    { additionalProperties: { type: "string" } },
    { $ref: "#/$defs/tool" },
    { additionalProperties: false, properties: { __aimock_extra: {} } },
    { additionalProperties: false, patternProperties: { aimock: {} } },
    {
      additionalProperties: false,
      patternProperties: { "^__aimock_extra$": { $ref: "#/$defs/x" } },
    },
    { additionalProperties: false, patternProperties: { "^__aimock_extra$": false, ".*": {} } },
    { additionalProperties: false, patternProperties: { "[": {} } },
    { additionalProperties: false, patternProperties: [] },
  ])("rejects permissive, colliding or unprovable schemas %j", (schema) => {
    expect(extraPropertyCandidate(undefined, schema)).toEqual({
      kind: "not-applicable",
      detail: expect.any(String),
    });
  });

  it.each([undefined, "custom"])(
    "does not replace a colliding argument name or choose a fallback: %s",
    (property) => {
      const response = {
        toolCalls: [
          { name: "weather", arguments: JSON.stringify({ [property ?? "__aimock_extra"]: false }) },
        ],
      };
      expect(extraPropertyCandidate(response, undefined, { property })).toMatchObject({
        kind: "not-applicable",
      });
    },
  );

  it("does not choose a fallback when the explicit name is declared", () => {
    expect(extraPropertyCandidate(undefined, undefined, { property: "city" })).toMatchObject({
      kind: "not-applicable",
    });
  });

  it("accepts a matching literal-false pattern as a direct invalidity proof", () => {
    expect(
      extraPropertyCandidate(undefined, {
        additionalProperties: false,
        patternProperties: { "^__aimock_extra$": false },
      }),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        response: { toolCalls: [{ arguments: '{"city":"Paris","__aimock_extra":true}' }] },
      },
    });
  });

  it("uses a direct false constraint despite unrelated applicators and nonmatching patterns", () => {
    expect(
      extraPropertyCandidate(undefined, {
        additionalProperties: false,
        allOf: [{ $ref: "#/$defs/other" }],
        patternProperties: { "^allowed_": {} },
      }),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        response: { toolCalls: [{ arguments: '{"city":"Paris","__aimock_extra":true}' }] },
      },
    });
  });

  it("uses the first named effective block call and preserves every other call and text block", () => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [{ name: "stale", arguments: "{}" }],
      blocks: [
        { type: "text", text: "before" },
        { type: "toolCall", name: "other", arguments: "{}" },
        { type: "toolCall", name: "weather", id: "chosen", arguments: '{"city":"Paris"}' },
        { type: "toolCall", name: "weather", arguments: '{"city":"Rome"}' },
        { type: "text", text: "after" },
      ],
    };
    const before = structuredClone(response);
    const changed = '{"city":"Paris","custom":true}';
    expect(
      extraPropertyCandidate(response, undefined, { tool: "weather", property: "custom" }),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 1 },
        response: {
          content: "beforeafter",
          toolCalls: [
            { name: "other", arguments: "{}" },
            { name: "weather", id: "chosen", arguments: changed },
            { name: "weather", arguments: '{"city":"Rome"}' },
          ],
          blocks: [
            before.blocks![0],
            before.blocks![1],
            { ...before.blocks![2], arguments: changed },
            before.blocks![3],
            before.blocks![4],
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });

  it.each(["[]", "null", "123", "{"])("rejects non-object arguments %s", (args) => {
    expect(
      extraPropertyCandidate({ toolCalls: [{ name: "weather", arguments: args }] }),
    ).toMatchObject({ kind: "not-applicable" });
  });

  it.each<FixtureResponse>([
    { content: "text" },
    { error: { message: "failed" } },
    { toolCalls: [] },
    { toolCalls: [{ name: "other", arguments: "{}" }] },
  ])("rejects absent target/schema %j", (response) => {
    expect(extraPropertyCandidate(response)).toMatchObject({ kind: "not-applicable" });
  });

  it("rejects an absent explicitly named tool without mutating a different call", () => {
    expect(extraPropertyCandidate(undefined, undefined, { tool: "absent" })).toMatchObject({
      kind: "not-applicable",
    });
  });
});

function enumMismatchCandidate(
  response: FixtureResponse = { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
  schema: object = { properties: { city: { enum: ["Paris"] } } },
  options: Omit<SchemaViolationFault, "fault"> = {},
) {
  return prepareEnumMismatchCandidate(
    {
      wire: "openai-chat",
      response,
      stream: false,
      request: {
        model: "gpt-4o",
        messages: [],
        tools: [{ type: "function", function: { name: "weather", parameters: schema } }],
      },
    },
    { fault: "tool-args-schema-violation", violation: "enum-mismatch", ...options },
  );
}

describe("pure enum-mismatch candidate", () => {
  it.each([
    { values: ["Paris"], expected: "__aimock_not_in_enum" },
    { values: ["Paris", "__aimock_not_in_enum"], expected: "__aimock_not_in_enum_2" },
    {
      values: ["Paris", "__aimock_not_in_enum", "__aimock_not_in_enum_2"],
      expected: "__aimock_not_in_enum_3",
    },
    { values: [null, 42, { city: "Paris" }], expected: "__aimock_not_in_enum" },
  ])("uses the first sentinel outside $values", ({ values, expected }) => {
    const response = {
      toolCalls: [{ name: "weather", id: "kept", arguments: '{"city":"Paris","keep":[1]}' }],
    };
    const schema = { properties: { city: { enum: values } } };
    const before = structuredClone({ response, schema });
    expect(enumMismatchCandidate(response, schema)).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 0 },
        detail: "enum-mismatch",
        response: {
          toolCalls: [
            {
              name: "weather",
              id: "kept",
              arguments: JSON.stringify({ city: expected, keep: [1] }),
            },
          ],
        },
      },
    });
    expect({ response, schema }).toEqual(before);
  });

  it("uses declaration order and skips missing or non-enum properties", () => {
    const response = {
      toolCalls: [{ name: "weather", arguments: '{"second":"b","first":"a","plain":1}' }],
    };
    const schema = {
      properties: {
        absent: { enum: ["x"] },
        plain: { type: "number" },
        first: { enum: ["a"] },
        second: { enum: ["b"] },
      },
    };
    expect(enumMismatchCandidate(response, schema)).toMatchObject({
      kind: "ready",
      candidate: {
        response: {
          toolCalls: [{ arguments: '{"second":"b","first":"__aimock_not_in_enum","plain":1}' }],
        },
      },
    });
    expect(enumMismatchCandidate(response, schema, { property: "second" })).toMatchObject({
      kind: "ready",
      candidate: {
        response: {
          toolCalls: [{ arguments: '{"second":"__aimock_not_in_enum","first":"a","plain":1}' }],
        },
      },
    });
  });

  it.each([undefined, {}, { type: "string" }, { enum: "Paris" }, { $ref: "#/defs/city" }])(
    "rejects a missing/malformed direct enum %j",
    (city) => {
      expect(enumMismatchCandidate(undefined, { properties: { city } })).toMatchObject({
        kind: "not-applicable",
      });
    },
  );

  it.each(["absent", "plain", "undeclared"])(
    "does not fall back from ineligible explicit property %s",
    (property) => {
      expect(
        enumMismatchCandidate(
          undefined,
          {
            properties: {
              city: { enum: ["Paris"] },
              absent: { enum: ["x"] },
              plain: { type: "string" },
            },
          },
          { property },
        ),
      ).toMatchObject({ kind: "not-applicable" });
    },
  );

  it.each(["{}", "[]", "null", "42", '"Paris"', "broken"])(
    "rejects missing/non-object arguments %s",
    (argumentsText) => {
      expect(
        enumMismatchCandidate({ toolCalls: [{ name: "weather", arguments: argumentsText }] }),
      ).toMatchObject({ kind: "not-applicable" });
    },
  );

  it("rejects an unchanged out-of-enum sentinel", () => {
    expect(
      enumMismatchCandidate({
        toolCalls: [{ name: "weather", arguments: '{"city":"__aimock_not_in_enum"}' }],
      }),
    ).toMatchObject({ kind: "not-applicable" });
  });

  it("uses a direct enum even alongside unresolved constraints", () => {
    expect(
      enumMismatchCandidate(undefined, {
        properties: { city: { enum: ["Paris"], $ref: "#/defs/city", anyOf: [{ type: "string" }] } },
      }),
    ).toMatchObject({ kind: "ready" });
  });

  it.each([
    { content: "text" },
    { error: { message: "failed", type: "server_error" } },
    { toolCalls: [] },
  ])("rejects responses with no usable call %j", (response) => {
    expect(enumMismatchCandidate(response)).toMatchObject({ kind: "not-applicable" });
  });

  it("does not search later calls when the first target is inapplicable", () => {
    const response = {
      toolCalls: [
        { name: "other", arguments: "{}" },
        { name: "weather", arguments: '{"city":"Paris"}' },
      ],
    };
    expect(enumMismatchCandidate(response)).toMatchObject({ kind: "not-applicable" });
    expect(enumMismatchCandidate(response, undefined, { tool: "missing" })).toMatchObject({
      kind: "not-applicable",
    });
    expect(enumMismatchCandidate(response, undefined, { tool: "weather" })).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 1 },
        response: {
          toolCalls: [
            response.toolCalls[0],
            { name: "weather", arguments: '{"city":"__aimock_not_in_enum"}' },
          ],
        },
      },
    });
  });

  it("rewrites the first matching effective ordered block and preserves other calls", () => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [{ name: "weather", arguments: "stale" }],
      blocks: [
        { type: "text", text: "before" },
        { type: "toolCall", name: "other", arguments: "{}", id: "first" },
        { type: "toolCall", name: "weather", arguments: '{"city":"Paris"}', id: "chosen" },
        { type: "text", text: "after" },
        { type: "toolCall", name: "weather", arguments: '{"city":"Paris"}', id: "last" },
      ],
    };
    const before = structuredClone(response);
    expect(enumMismatchCandidate(response, undefined, { tool: "weather" })).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 1 },
        response: {
          content: "beforeafter",
          toolCalls: [
            { name: "other", arguments: "{}", id: "first" },
            { name: "weather", arguments: '{"city":"__aimock_not_in_enum"}', id: "chosen" },
            { name: "weather", arguments: '{"city":"Paris"}', id: "last" },
          ],
          blocks: [
            before.blocks![0],
            before.blocks![1],
            { ...before.blocks![2], arguments: '{"city":"__aimock_not_in_enum"}' },
            before.blocks![3],
            before.blocks![4],
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });
});

function notObjectCandidate(
  response: FixtureResponse = { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
  options: { wire?: WireId; stream?: boolean; tool?: string } = {},
) {
  return prepareNotObjectCandidate(
    {
      wire: options.wire ?? "openai-chat",
      response,
      stream: options.stream ?? false,
      request: { model: "gpt-4o", messages: [] },
    },
    { fault: "tool-args-schema-violation", violation: "not-object", tool: options.tool },
  );
}

describe("pure not-object candidate", () => {
  it.each([false, true])(
    "double encodes canonical object JSON without a schema, stream=%s",
    (stream) => {
      const response = {
        toolCalls: [
          {
            name: "weather",
            id: "kept",
            arguments: ' { "city": "Paris", "nested": [true, null] } ',
          },
        ],
      };
      const before = structuredClone(response);
      expect(notObjectCandidate(response, { stream })).toEqual({
        kind: "ready",
        candidate: {
          target: { tool: "weather", index: 0 },
          detail: "not-object",
          response: {
            toolCalls: [
              {
                name: "weather",
                id: "kept",
                arguments: JSON.stringify('{"city":"Paris","nested":[true,null]}'),
              },
            ],
          },
        },
      });
      expect(response).toEqual(before);
    },
  );

  it("accepts the empty object", () => {
    expect(notObjectCandidate({ toolCalls: [{ name: "weather", arguments: "{}" }] })).toMatchObject(
      {
        kind: "ready",
        candidate: { response: { toolCalls: [{ arguments: '"{}"' }] } },
      },
    );
  });

  it.each(["[]", "null", "42", "true", '"Paris"', "broken"])(
    "rejects non-object input %s",
    (argumentsText) => {
      const response = { toolCalls: [{ name: "weather", arguments: argumentsText }] };
      expect(notObjectCandidate(response)).toMatchObject({
        kind: "not-applicable",
        detail: "Arguments must parse to an object",
      });
      expect(response.toolCalls[0].arguments).toBe(argumentsText);
    },
  );

  it.each([
    { content: "text" },
    { error: { message: "failed", type: "server_error" } },
    { toolCalls: [] },
  ])("rejects responses with no target %j", (response) => {
    expect(notObjectCandidate(response)).toMatchObject({ kind: "not-applicable" });
  });

  it("does not search past an ineligible first call or absent named target", () => {
    const response = {
      toolCalls: [
        { name: "other", arguments: "null" },
        { name: "weather", arguments: "{}" },
      ],
    };
    expect(notObjectCandidate(response)).toMatchObject({ kind: "not-applicable" });
    expect(notObjectCandidate(response, { tool: "missing" })).toMatchObject({
      kind: "not-applicable",
    });
    expect(notObjectCandidate(response, { tool: "weather" })).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 1 },
        response: { toolCalls: [response.toolCalls[0], { name: "weather", arguments: '"{}"' }] },
      },
    });
  });

  it.each([false, true])("rejects an unavailable object wire, stream=%s", (stream) => {
    expect(notObjectCandidate(undefined, { wire: "gemini", stream })).toMatchObject({
      kind: "not-applicable",
      detail: "not-object is unsupported on this wire/output mode",
    });
  });

  it("honors a mode restriction from the shared capability contract", () => {
    const modes = WIRE_SUPPORT["openai-chat"].notObject;
    const original = Object.getOwnPropertyDescriptor(modes, "nonstream");
    if (!original) throw new Error("Missing not-object capability");
    try {
      Object.defineProperty(modes, "nonstream", { ...original, value: false });
      expect(notObjectCandidate()).toMatchObject({ kind: "not-applicable" });
      expect(notObjectCandidate(undefined, { stream: true })).toMatchObject({ kind: "ready" });
    } finally {
      Object.defineProperty(modes, "nonstream", original);
    }
  });

  it("rewrites the first matching effective block, preserving other calls and text", () => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [{ name: "weather", arguments: "stale" }],
      blocks: [
        { type: "text", text: "before" },
        { type: "toolCall", name: "other", arguments: "{}", id: "first" },
        { type: "toolCall", name: "weather", arguments: ' { "city": "Paris" } ', id: "chosen" },
        { type: "text", text: "after" },
        { type: "toolCall", name: "weather", arguments: "{}", id: "last" },
      ],
    };
    const before = structuredClone(response);
    const argumentsText = JSON.stringify('{"city":"Paris"}');
    expect(notObjectCandidate(response, { tool: "weather" })).toEqual({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 1 },
        detail: "not-object",
        response: {
          content: "beforeafter",
          toolCalls: [
            { name: "other", arguments: "{}", id: "first" },
            { name: "weather", arguments: argumentsText, id: "chosen" },
            { name: "weather", arguments: "{}", id: "last" },
          ],
          blocks: [
            before.blocks![0],
            before.blocks![1],
            { ...before.blocks![2], arguments: argumentsText },
            before.blocks![3],
            before.blocks![4],
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });
});

function unknownNameCandidate(
  response: FixtureResponse = {
    toolCalls: [{ name: "weather", arguments: ' { "city": "Paris" } ' }],
  },
  options: { tool?: string; name?: string; declared?: string[]; stream?: boolean } = {},
) {
  return prepareUnknownNameCandidate(
    {
      wire: "openai-chat",
      response,
      stream: options.stream ?? false,
      request: {
        model: "gpt-4o",
        messages: [],
        tools: (options.declared ?? ["weather"]).map((name) => ({
          type: "function",
          function: { name },
        })),
      },
    },
    { fault: "tool-unknown-name", tool: options.tool, name: options.name },
  );
}

describe("pure unknown-name candidate", () => {
  it.each([false, true])(
    "renames only the first call and preserves raw arguments, stream=%s",
    (stream) => {
      const response = {
        toolCalls: [
          { name: "weather", arguments: ' { "city": "Paris" } ', id: "first" },
          { name: "weather", arguments: "broken", id: "second" },
        ],
      };
      const before = structuredClone(response);
      expect(unknownNameCandidate(response, { stream })).toMatchObject({
        kind: "ready",
        candidate: {
          target: { tool: "weather", index: 0 },
          response: {
            toolCalls: [{ ...before.toolCalls[0], name: "weather_v2" }, before.toolCalls[1]],
          },
        },
      });
      expect(response).toEqual(before);
    },
  );

  it("chooses the first undeclared default suffix deterministically", () => {
    const options = { declared: ["weather", "weather_v2", "weather_v2_2", "weather_v2_4"] };
    const result = unknownNameCandidate(undefined, options);
    expect(result).toMatchObject({
      kind: "ready",
      candidate: { response: { toolCalls: [{ name: "weather_v2_3" }] } },
    });
    expect(unknownNameCandidate(undefined, options)).toEqual(result);
  });

  it("accepts an explicit undeclared name without parsing arguments", () => {
    expect(
      unknownNameCandidate(
        { toolCalls: [{ name: "weather", arguments: "broken" }] },
        { name: "new_name" },
      ),
    ).toMatchObject({
      kind: "ready",
      candidate: { response: { toolCalls: [{ name: "new_name", arguments: "broken" }] } },
    });
  });

  it("rejects an explicitly declared name instead of choosing a suffix", () => {
    expect(unknownNameCandidate(undefined, { name: "taken", declared: ["taken"] })).toMatchObject({
      kind: "not-applicable",
      detail: expect.stringContaining("declared"),
    });
  });

  it("rejects an explicit unchanged name even when the original is undeclared", () => {
    expect(unknownNameCandidate(undefined, { name: "weather", declared: [] })).toMatchObject({
      kind: "not-applicable",
    });
  });

  it.each([
    { content: "text" },
    { toolCalls: [] },
    { error: { message: "failed", type: "server_error" } },
  ])("rejects a missing target %j", (response) => {
    expect(unknownNameCandidate(response)).toMatchObject({ kind: "not-applicable" });
  });

  it("does not fall back when the named target is missing", () => {
    expect(unknownNameCandidate(undefined, { tool: "absent" })).toMatchObject({
      kind: "not-applicable",
    });
  });

  it("uses authoritative blocks and the first named target, preserving text, IDs and argument values", () => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [{ name: "weather", arguments: "stale" }],
      blocks: [
        { type: "text", text: "before" },
        { type: "toolCall", name: "other", arguments: "{}", id: "first" },
        { type: "toolCall", name: "weather", arguments: ' { "city": "Paris" } ', id: "target" },
        { type: "text", text: "after" },
        { type: "toolCall", name: "weather", arguments: "null", id: "last" },
      ],
    };
    const before = structuredClone(response);
    expect(unknownNameCandidate(response, { tool: "weather" })).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "weather", index: 1 },
        response: {
          content: "beforeafter",
          toolCalls: [
            { name: "other", arguments: "{}", id: "first" },
            { name: "weather_v2", arguments: ' { "city": "Paris" } ', id: "target" },
            { name: "weather", arguments: "null", id: "last" },
          ],
          blocks: [
            before.blocks![0],
            before.blocks![1],
            { ...before.blocks![2], name: "weather_v2" },
            before.blocks![3],
            before.blocks![4],
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });
});

function duplicateIdCandidate(
  response: FixtureResponse,
  options: { tool?: string; stream?: boolean; emitsToolCallIds?: boolean; wire?: WireId } = {},
) {
  return prepareDuplicateIdCandidate(
    {
      wire: options.wire ?? "openai-chat",
      response,
      request: { model: "gpt-4o", messages: [] },
      stream: options.stream ?? false,
      emitsToolCallIds: options.emitsToolCallIds ?? true,
    },
    { fault: "tool-call-id-duplicate", tool: options.tool },
  );
}

describe("pure duplicate-ID candidate", () => {
  const calls = [
    { name: "first", arguments: ' { "a": 1 } ', id: "a" },
    { name: "middle", arguments: "broken", id: "b" },
    { name: "last", arguments: "null", id: "c" },
  ];

  it.each([
    { tool: undefined, sourceIndex: 0, destinationIndex: 1 },
    { tool: "middle", sourceIndex: 1, destinationIndex: 2 },
    { tool: "last", sourceIndex: 2, destinationIndex: 0 },
  ])(
    "copies the source ID to its next/wrapped destination: $tool",
    ({ tool, sourceIndex, destinationIndex }) => {
      const response = { toolCalls: structuredClone(calls) };
      const before = structuredClone(response);
      expect(duplicateIdCandidate(response, { tool })).toEqual({
        kind: "ready",
        candidate: {
          target: { tool: calls[sourceIndex].name, index: sourceIndex },
          duplicateId: { sourceIndex, destinationIndex },
          response: {
            toolCalls: calls.map((call, index) => ({
              ...call,
              id: index === destinationIndex ? calls[sourceIndex].id : call.id,
            })),
          },
        },
      });
      expect(response).toEqual(before);
    },
  );

  it("selects the first repeated name", () => {
    expect(
      duplicateIdCandidate(
        { toolCalls: [calls[0], { ...calls[1], name: "last" }, calls[2]] },
        { tool: "last" },
      ),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        target: { tool: "last", index: 1 },
        duplicateId: { sourceIndex: 1, destinationIndex: 2 },
      },
    });
  });

  it.each([false, true])("clones a lone call without changing its payload, stream=%s", (stream) => {
    const response = { toolCalls: [structuredClone(calls[0])] };
    const before = structuredClone(response);
    expect(duplicateIdCandidate(response, { stream })).toEqual({
      kind: "ready",
      candidate: {
        target: { tool: "first", index: 0 },
        duplicateId: { sourceIndex: 0, destinationIndex: 1 },
        response: { toolCalls: [calls[0], calls[0]] },
      },
    });
    expect(response).toEqual(before);
  });

  it.each([false, true])("defers allocation of a missing source ID, lone=%s", (lone) => {
    const source = { name: "first", arguments: "broken" };
    const response = { toolCalls: lone ? [source] : [source, calls[1], calls[2]] };
    const before = structuredClone(response);
    expect(duplicateIdCandidate(response)).toEqual({
      kind: "ready",
      candidate: {
        target: { tool: "first", index: 0 },
        duplicateId: { sourceIndex: 0, destinationIndex: 1 },
        response: {
          toolCalls: lone
            ? [source, source]
            : [source, { name: "middle", arguments: "broken" }, calls[2]],
        },
      },
    });
    expect(response).toEqual(before);
  });

  it.each([
    { content: "text" },
    { toolCalls: [] },
    { error: { message: "failed", type: "server_error" } },
  ])("rejects outputs with no calls: %j", (response) => {
    expect(duplicateIdCandidate(response)).toMatchObject({ kind: "not-applicable" });
  });

  it("rejects an absent named target", () => {
    expect(duplicateIdCandidate({ toolCalls: calls }, { tool: "missing" })).toMatchObject({
      kind: "not-applicable",
    });
  });

  it("uses authoritative blocks and retains text/call order when wrapping", () => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [calls[0]],
      blocks: [
        { type: "text", text: "before" },
        { type: "toolCall", ...calls[0] },
        { type: "text", text: "between" },
        { type: "toolCall", ...calls[1] },
        { type: "text", text: "after" },
      ],
    };
    const before = structuredClone(response);
    expect(duplicateIdCandidate(response, { tool: "middle" })).toMatchObject({
      kind: "ready",
      candidate: {
        duplicateId: { sourceIndex: 1, destinationIndex: 0 },
        response: {
          content: "beforebetweenafter",
          toolCalls: [{ ...calls[0], id: "b" }, calls[1]],
          blocks: [
            before.blocks![0],
            { ...before.blocks![1], id: "b" },
            ...before.blocks!.slice(2),
          ],
        },
      },
    });
    expect(response).toEqual(before);
  });

  it("inserts a lone clone beside its block, preserving surrounding text", () => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: calls,
      blocks: [
        { type: "text", text: "before" },
        { type: "toolCall", ...calls[0] },
        { type: "text", text: "after" },
      ],
    };
    const before = structuredClone(response);
    expect(duplicateIdCandidate(response)).toMatchObject({
      kind: "ready",
      candidate: {
        response: {
          content: "beforeafter",
          toolCalls: [calls[0], calls[0]],
          blocks: [before.blocks![0], before.blocks![1], before.blocks![1], before.blocks![2]],
        },
      },
    });
    expect(response).toEqual(before);
  });
});

it.each(["gemini", "gemini-live", "gemini-interactions", "openai-chat"] as const)(
  "requires the current %s output mode to emit IDs",
  (wire) => {
    const response = { toolCalls: [{ name: "tool", arguments: "{}", id: "existing" }] };
    expect(duplicateIdCandidate(response, { wire, emitsToolCallIds: false })).toMatchObject({
      kind: "not-applicable",
    });
    expect(duplicateIdCandidate(response, { wire, emitsToolCallIds: true })).toMatchObject({
      kind: "ready",
      candidate: { duplicateId: { sourceIndex: 0, destinationIndex: 1 } },
    });
  },
);

it("rejects a missing ID-mode capability as a caller contract error", () => {
  expect(() =>
    Reflect.apply(prepareDuplicateIdCandidate, undefined, [
      {
        wire: "openai-chat",
        response: { toolCalls: [{ name: "tool", arguments: "{}" }] },
        request: { model: "gpt-4o", messages: [] },
        stream: false,
      },
      { fault: "tool-call-id-duplicate" },
    ]),
  ).toThrow(TypeError);
});

function lengthCandidate(
  response: FixtureResponse,
  options: { tool?: string; at?: number; stream?: boolean } = {},
) {
  const context = {
    wire: "openai-chat" as const,
    response,
    request: { model: "gpt-4o", messages: [] },
    stream: options.stream ?? false,
  };
  const fault = { fault: "stop-length-mid-tool" as const, tool: options.tool, at: options.at };
  return prepareLengthCandidate(context, fault);
}

describe("pure length candidate", () => {
  it.each([
    { arguments: ' { "city": "Paris" } ', at: undefined, prefix: '{"city":' },
    { arguments: ' { "city": "Paris" } ', at: 0.25, prefix: '{"ci' },
    { arguments: "1234", at: 0.5, prefix: "12" },
    { arguments: "broken", at: 0.5, prefix: "bro" },
    { arguments: "", at: undefined, prefix: "{" },
    { arguments: "{}", at: 0.01, prefix: "{" },
    { arguments: "{}", at: 0.999, prefix: "{" },
  ])(
    "cuts canonical arguments to a strict proper prefix: %j",
    ({ arguments: args, at, prefix }) => {
      const response = { toolCalls: [{ name: "weather", arguments: args, id: "target" }] };
      const before = structuredClone(response);
      expect(lengthCandidate(response, { at })).toMatchObject({
        kind: "ready",
        candidate: {
          stop: "length",
          target: { tool: "weather", index: 0 },
          response: { toolCalls: [{ name: "weather", arguments: prefix, id: "target" }] },
        },
      });
      expect(response).toEqual(before);
    },
  );

  it.each([false, true])(
    "retains earlier calls and content and drops later calls, stream=%s",
    (stream) => {
      const first = { name: "first", arguments: ' { "x": 1 } ', id: "first" };
      const response = {
        content: "before",
        toolCalls: [
          first,
          { name: "weather", arguments: "1234", id: "target" },
          { name: "weather", arguments: "5678", id: "last" },
        ],
      };
      const before = structuredClone(response);
      expect(lengthCandidate(response, { tool: "weather", stream })).toMatchObject({
        kind: "ready",
        candidate: {
          stop: "length",
          target: { tool: "weather", index: 1 },
          response: {
            content: "before",
            toolCalls: [first, { name: "weather", arguments: "12", id: "target" }],
          },
        },
      });
      expect(response).toEqual(before);
    },
  );

  it.each(["1", "x", " 1 "])("rejects one-character canonical arguments: %s", (args) => {
    expect(lengthCandidate({ toolCalls: [{ name: "tool", arguments: args }] })).toMatchObject({
      kind: "not-applicable",
    });
  });

  it.each([
    { content: "text" },
    { toolCalls: [] },
    { error: { message: "failed", type: "server_error" } },
  ])("rejects responses without calls: %j", (response) => {
    expect(lengthCandidate(response)).toMatchObject({ kind: "not-applicable" });
  });

  it("does not fall back when the named target is missing or ineligible", () => {
    const response = {
      toolCalls: [
        { name: "first", arguments: "{}" },
        { name: "target", arguments: "1" },
      ],
    };
    expect(lengthCandidate(response, { tool: "missing" })).toMatchObject({
      kind: "not-applicable",
    });
    expect(lengthCandidate(response, { tool: "target" })).toMatchObject({ kind: "not-applicable" });
  });
});

it("cuts authoritative ordered blocks at the target, including later text", () => {
  const response: FixtureResponse = {
    content: "stale",
    toolCalls: [{ name: "stale", arguments: "{}" }],
    blocks: [
      { type: "text", text: "before" },
      { type: "toolCall", name: "first", arguments: ' { "x": 1 } ', id: "a" },
      { type: "text", text: "between" },
      { type: "toolCall", name: "target", arguments: "1234", id: "b" },
      { type: "text", text: "after" },
      { type: "toolCall", name: "last", arguments: "{}" },
    ],
  };
  const before = structuredClone(response);
  expect(lengthCandidate(response, { tool: "target" })).toMatchObject({
    kind: "ready",
    candidate: {
      stop: "length",
      target: { tool: "target", index: 1 },
      response: {
        content: "beforebetween",
        toolCalls: [
          { name: "first", arguments: ' { "x": 1 } ', id: "a" },
          { name: "target", arguments: "12", id: "b" },
        ],
        blocks: [
          ...before.blocks!.slice(0, 3),
          { type: "toolCall", name: "target", arguments: "12", id: "b" },
        ],
      },
    },
  });
  expect(response).toEqual(before);
});

function emptyCandidate(response: FixtureResponse, stream = false, tool?: string) {
  const context = {
    wire: "openai-chat" as const,
    response,
    request: { model: "gpt-4o", messages: [] },
    stream,
  };
  return prepareEmptyCandidate(context, { fault: "empty-response", tool });
}

describe("pure empty candidate", () => {
  const responses: FixtureResponse[] = [
    { content: "answer", reasoning: "thinking" },
    { toolCalls: [{ name: "weather", arguments: "{}", id: "original" }] },
    {
      content: "stale answer",
      toolCalls: [{ name: "stale", arguments: "{}" }],
      blocks: [
        { type: "text", text: "authoritative answer" },
        { type: "toolCall", name: "actual", arguments: "{}" },
      ],
      reasoning: "thinking",
      reasoningSignature: "signature",
      redactedThinking: ["encrypted"],
      webSearches: ["search"],
      finishReason: "length",
      nativeFinishReason: "tool_calls",
    },
    { blocks: [{ type: "text", text: "blocks only" }] },
    { content: "fallback", toolCalls: [], blocks: [] },
    { content: "" },
  ];

  it.each([false, true])("clears every output shape with normal stop, stream=%s", (stream) => {
    for (const response of responses) {
      const before = structuredClone(response);
      Object.freeze(response);
      const result = emptyCandidate(response, stream);
      expect(result).toEqual({
        kind: "ready",
        candidate: { response: { content: "" }, stop: "stop" },
      });
      if (result.kind !== "ready") throw new Error(result.detail);
      expect(result.candidate.response).not.toBe(response);
      expect(response).toEqual(before);
    }
  });

  it("preserves response metadata from a resolved factory result", () => {
    const resolved = {
      ...responses[2],
      id: "fixture",
      model: "fixture-model",
      usage: { total_tokens: 9 },
    };
    const before = structuredClone(resolved);
    expect(emptyCandidate(resolved)).toEqual({
      kind: "ready",
      candidate: {
        response: {
          content: "",
          id: "fixture",
          model: "fixture-model",
          usage: { total_tokens: 9 },
        },
        stop: "stop",
      },
    });
    expect(resolved).toEqual(before);
  });

  it("rejects an error response without replacing it", () => {
    const response = { error: { message: "failed", type: "server_error" }, status: 503 };
    const before = structuredClone(response);
    expect(emptyCandidate(response)).toEqual({
      kind: "not-applicable",
      detail: "Response is not a chat response",
    });
    expect(response).toEqual(before);
  });
});

describe("empty candidate explicit tool selector", () => {
  const cases: { response: FixtureResponse; tool: string; applicable: boolean }[] = [
    { response: { content: "answer" }, tool: "missing", applicable: false },
    {
      response: { toolCalls: [{ name: "weather", arguments: "{}" }] },
      tool: "missing",
      applicable: false,
    },
    {
      response: { toolCalls: [{ name: "weather", arguments: "{}" }] },
      tool: "weather",
      applicable: true,
    },
    {
      response: {
        content: "stale text",
        toolCalls: [{ name: "stale", arguments: "{}" }],
        blocks: [{ type: "toolCall", name: "actual", arguments: "{}" }],
      },
      tool: "stale",
      applicable: false,
    },
    {
      response: {
        content: "stale text",
        toolCalls: [{ name: "stale", arguments: "{}" }],
        blocks: [{ type: "toolCall", name: "actual", arguments: "{}" }],
      },
      tool: "actual",
      applicable: true,
    },
    {
      response: {
        content: "answer",
        toolCalls: [{ name: "weather", arguments: "{}" }],
        blocks: [],
      },
      tool: "weather",
      applicable: true,
    },
  ];
  it.each(cases)("checks the effective target: %j", ({ response, tool, applicable }) => {
    const before = structuredClone(response);
    for (const stream of [false, true]) {
      expect(emptyCandidate(response, stream, tool)).toEqual(
        applicable
          ? { kind: "ready", candidate: { response: { content: "" }, stop: "stop" } }
          : { kind: "not-applicable", detail: "Target tool call is absent" },
      );
    }
    expect(response).toEqual(before);
  });
});

function refusalCandidate(
  response: FixtureResponse,
  options: Omit<Extract<MisbehaviorFault, { fault: "refusal" }>, "fault"> = {},
  stream = false,
  wire: WireId = "openai-chat",
) {
  const context: MisbehaviorCandidateContext = {
    wire,
    response,
    request: { model: "gpt-4o", messages: [] },
    stream,
  };
  return prepareRefusalCandidate(context, { fault: "refusal", ...options });
}

describe("pure refusal candidate", () => {
  it.each([false, true])("replaces all output with structured refusal, stream=%s", (stream) => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [{ name: "stale", arguments: "{}" }],
      blocks: [
        { type: "text", text: "answer" },
        { type: "toolCall", name: "actual", arguments: "{}" },
      ],
      reasoning: "thinking",
      reasoningSignature: "signature",
      redactedThinking: ["encrypted"],
      webSearches: ["search"],
      finishReason: "length",
      nativeFinishReason: "tool_calls",
      id: "fixture",
      model: "fixture-model",
      usage: { total_tokens: 9 },
    };
    const before = structuredClone(response);
    Object.freeze(response);
    expect(refusalCandidate(response, { tool: "actual" }, stream)).toEqual({
      kind: "ready",
      candidate: {
        response: {
          content: "",
          id: "fixture",
          model: "fixture-model",
          usage: { total_tokens: 9 },
        },
        stop: "refusal",
        refusal: "I can't help with that.",
        refusalCategory: null,
      },
    });
    expect(response).toEqual(before);
  });

  it.each(["Custom refusal", ""])("preserves explicit message %j", (message) => {
    expect(refusalCandidate({ content: "answer" }, { message })).toEqual({
      kind: "ready",
      candidate: {
        response: { content: "" },
        stop: "refusal",
        refusal: message,
        refusalCategory: null,
      },
    });
  });

  it("rejects errors and absent effective tool selectors", () => {
    expect(
      refusalCandidate({ error: { message: "failed", type: "server_error" }, status: 503 }),
    ).toEqual({
      kind: "not-applicable",
      detail: "Response is not a chat response",
    });
    const response: FixtureResponse = {
      toolCalls: [{ name: "stale", arguments: "{}" }],
      blocks: [{ type: "toolCall", name: "actual", arguments: "{}" }],
    };
    const before = structuredClone(response);
    expect(refusalCandidate(response, { tool: "stale" })).toEqual({
      kind: "not-applicable",
      detail: "Target tool call is absent",
    });
    expect(refusalCandidate({ content: "answer" }, { tool: "absent" })).toEqual({
      kind: "not-applicable",
      detail: "Target tool call is absent",
    });
    expect(response).toEqual(before);
  });

  it("accepts empty blocks fallback and already empty output", () => {
    for (const response of [
      { toolCalls: [{ name: "actual", arguments: "{}" }], blocks: [] },
      { content: "" },
    ]) {
      expect(refusalCandidate(response, "toolCalls" in response ? { tool: "actual" } : {})).toEqual(
        {
          kind: "ready",
          candidate: {
            response: { content: "" },
            stop: "refusal",
            refusal: "I can't help with that.",
            refusalCategory: null,
          },
        },
      );
    }
  });
});

it.each(["anthropic", "bedrock-invoke"] as const)(
  "retains supported refusal category for %s",
  (wire) => {
    for (const category of [undefined, null, "", "safety"]) {
      const fault = { message: "explanation", category };
      const response = { content: "answer" };
      const before = structuredClone({ fault, response });
      expect(refusalCandidate(response, fault, false, wire)).toEqual({
        kind: "ready",
        candidate: {
          response: { content: "" },
          stop: "refusal",
          refusal: "explanation",
          refusalCategory: category ?? null,
        },
      });
      expect({ fault, response }).toEqual(before);
      expect(supportsMisbehavior(wire, { fault: "refusal", ...fault }, false)).toBe(true);
    }
  },
);

it("validates authored category presence without rejecting the internal default", () => {
  for (const stream of [false, true]) {
    expect(supportsMisbehavior("openai-chat", { fault: "refusal" }, stream)).toBe(true);
    for (const category of [null, "", "safety"]) {
      expect(supportsMisbehavior("openai-chat", { fault: "refusal", category }, stream)).toBe(
        false,
      );
    }
  }
  expect(MISBEHAVIOR_CATALOG.refusal.defaults).toEqual({
    message: "I can't help with that.",
    category: null,
  });
});

function contentFilterCandidate(response: FixtureResponse, stream = false, tool?: string) {
  const context: MisbehaviorCandidateContext = {
    wire: "openai-chat",
    response,
    request: { model: "gpt-4o", messages: [] },
    stream,
  };
  return prepareContentFilterCandidate(context, { fault: "content-filter", tool });
}

describe("pure content-filter candidate", () => {
  it.each([false, true])("withholds all output and preserves metadata, stream=%s", (stream) => {
    const response: FixtureResponse = {
      content: "stale",
      toolCalls: [{ name: "stale", arguments: "{}" }],
      blocks: [
        { type: "text", text: "answer" },
        { type: "toolCall", name: "actual", arguments: "{}" },
      ],
      reasoning: "thinking",
      reasoningSignature: "signature",
      redactedThinking: ["encrypted"],
      webSearches: ["search"],
      finishReason: "length",
      nativeFinishReason: "tool_calls",
      id: "fixture",
      model: "fixture-model",
      usage: { total_tokens: 9 },
    };
    const before = structuredClone(response);
    Object.freeze(response);
    const result = contentFilterCandidate(response, stream, "actual");
    expect(result).toEqual({
      kind: "ready",
      candidate: {
        response: {
          content: "",
          id: "fixture",
          model: "fixture-model",
          usage: { total_tokens: 9 },
        },
        stop: "content_filter",
      },
    });
    if (result.kind !== "ready") throw new Error(result.detail);
    expect(result.candidate.response).not.toBe(response);
    expect(response).toEqual(before);
  });

  it.each([false, true])("filters text, tools, blocks and empty output, stream=%s", (stream) => {
    const responses: FixtureResponse[] = [
      { content: "answer" },
      { toolCalls: [{ name: "actual", arguments: "{}" }] },
      { blocks: [{ type: "text", text: "answer" }] },
      { toolCalls: [{ name: "actual", arguments: "{}" }], blocks: [] },
      { content: "" },
    ];
    for (const response of responses) {
      const before = structuredClone(response);
      expect(
        contentFilterCandidate(response, stream, "toolCalls" in response ? "actual" : undefined),
      ).toEqual({
        kind: "ready",
        candidate: { response: { content: "" }, stop: "content_filter" },
      });
      expect(response).toEqual(before);
    }
  });

  it.each([false, true])("rejects errors and absent effective targets, stream=%s", (stream) => {
    expect(
      contentFilterCandidate(
        { error: { message: "failed", type: "server_error" }, status: 503 },
        stream,
      ),
    ).toEqual({
      kind: "not-applicable",
      detail: "Response is not a chat response",
    });
    for (const response of [
      { content: "answer" },
      {
        toolCalls: [{ name: "stale", arguments: "{}" }],
        blocks: [{ type: "toolCall" as const, name: "actual", arguments: "{}" }],
      },
    ]) {
      const before = structuredClone(response);
      expect(contentFilterCandidate(response, stream, "stale")).toEqual({
        kind: "not-applicable",
        detail: "Target tool call is absent",
      });
      expect(response).toEqual(before);
    }
  });
});

function reasoningOnlyCandidate(
  response: FixtureResponse,
  stream = false,
  options: { reasoning?: string; tool?: string } = {},
) {
  const context: MisbehaviorCandidateContext = {
    wire: "openai-chat",
    response,
    request: { model: "gpt-4o", messages: [] },
    stream,
  };
  return prepareReasoningOnlyCandidate(context, { fault: "reasoning-only", ...options });
}

describe("pure reasoning-only candidate", () => {
  it.each([false, true])("selects explicit, fixture or fallback reasoning, stream=%s", (stream) => {
    for (const [fixture, explicit, expected] of [
      ["fixture", "explicit", "explicit"],
      ["fixture", undefined, "fixture"],
      [undefined, undefined, "Thinking..."],
      ["fixture", "", ""],
      ["", undefined, ""],
    ]) {
      expect(
        reasoningOnlyCandidate({ content: "answer", reasoning: fixture }, stream, {
          reasoning: explicit,
        }),
      ).toEqual({
        kind: "ready",
        candidate: { response: { content: "" }, stop: "length", reasoning: expected },
      });
    }
  });

  it.each([false, true])(
    "clears all output channels and preserves metadata immutably, stream=%s",
    (stream) => {
      const response: FixtureResponse = {
        content: "stale",
        toolCalls: [{ name: "stale", arguments: "{}" }],
        blocks: [
          { type: "text", text: "answer" },
          { type: "toolCall", name: "actual", arguments: "{}" },
        ],
        reasoning: "fixture reasoning",
        reasoningSignature: "signature",
        redactedThinking: ["encrypted"],
        webSearches: ["search"],
        finishReason: "stop",
        nativeFinishReason: "tool_calls",
        id: "fixture",
        model: "fixture-model",
        usage: { total_tokens: 9 },
      };
      const before = structuredClone(response);
      for (const block of response.blocks ?? []) Object.freeze(block);
      Object.freeze(response.blocks);
      Object.freeze(response);
      const result = reasoningOnlyCandidate(response, stream, { tool: "actual" });
      expect(result).toEqual({
        kind: "ready",
        candidate: {
          response: {
            content: "",
            id: "fixture",
            model: "fixture-model",
            usage: { total_tokens: 9 },
          },
          stop: "length",
          reasoning: "fixture reasoning",
        },
      });
      if (result.kind !== "ready") throw new Error(result.detail);
      expect(result.candidate.response).not.toBe(response);
      expect(response).toEqual(before);
    },
  );

  it.each([false, true])("accepts chat shapes including empty output, stream=%s", (stream) => {
    const responses: FixtureResponse[] = [
      { content: "answer" },
      { toolCalls: [{ name: "actual", arguments: "{}" }] },
      { blocks: [{ type: "text", text: "answer" }] },
      { toolCalls: [{ name: "actual", arguments: "{}" }], blocks: [] },
      { content: "" },
    ];
    for (const response of responses) {
      expect(
        reasoningOnlyCandidate(response, stream, {
          tool: "toolCalls" in response ? "actual" : undefined,
        }),
      ).toEqual({
        kind: "ready",
        candidate: { response: { content: "" }, stop: "length", reasoning: "Thinking..." },
      });
    }
  });

  it.each([false, true])(
    "rejects errors and absent effective tool targets, stream=%s",
    (stream) => {
      expect(
        reasoningOnlyCandidate(
          { error: { message: "failed", type: "server_error" }, status: 503 },
          stream,
        ),
      ).toEqual({
        kind: "not-applicable",
        detail: "Response is not a chat response",
      });
      for (const response of [
        { content: "answer" },
        {
          toolCalls: [{ name: "stale", arguments: "{}" }],
          blocks: [{ type: "toolCall" as const, name: "actual", arguments: "{}" }],
        },
      ]) {
        const before = structuredClone(response);
        expect(reasoningOnlyCandidate(response, stream, { tool: "stale" })).toEqual({
          kind: "not-applicable",
          detail: "Target tool call is absent",
        });
        expect(response).toEqual(before);
      }
    },
  );
});

// E3c planner contract: real candidate preparation and real journal state.
describe("scoped misbehavior planner", () => {
  function setup(config?: MisbehaviorConfig) {
    const response = { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] };
    const fixture: Fixture = { match: {}, response };
    setFixtureMisbehaviorPosition(fixture, "code#0");
    const journal = new Journal();
    const defaults: HandlerDefaults = {
      latency: 0,
      chunkSize: 10,
      replaySpeed: 1,
      logger: new Logger(),
      misbehavior: { baseline: config, byTestId: new Map() },
      misbehaviorCounters: journal,
    };
    return {
      journal,
      input: {
        wire: "openai-chat" as WireId,
        fixture,
        response,
        request: {
          model: "gpt",
          messages: [],
          tools: [
            {
              type: "function" as const,
              function: {
                name: "weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string", enum: ["Paris"] } },
                  required: ["city"],
                  additionalProperties: false,
                },
              },
            },
          ],
        },
        stream: false,
        defaults,
        rawHeaders: { "x-test-id": "case" },
        url: undefined as string | undefined,
      },
    };
  }
  const k1: MisbehaviorFault = { fault: "tool-args-invalid-json" };
  const k2: MisbehaviorFault = { fault: "tool-args-schema-violation" };

  describe("endpoint fault rendering availability", () => {
    it.each(["server", "scope", "fixture", "header"] as const)(
      "preserves unsupported semantics for %s and spends no budget",
      (source) => {
        const config = { faults: [{ fault: "empty-response" as const, times: 1 }] };
        const { input } = setup(source === "server" ? config : undefined);
        if (source === "scope") input.defaults.misbehavior!.byTestId.set("case", config);
        if (source === "fixture") input.fixture.misbehavior = config;
        const rawHeaders =
          source === "header"
            ? { ...input.rawHeaders, "x-aimock-misbehavior": "empty-response" }
            : input.rawHeaders;
        const unavailable = { ...input, rawHeaders, faultRenderingAvailable: false };
        expect(planMisbehavior(unavailable)).toMatchObject({
          kind: source === "fixture" || source === "header" ? "error" : "skipped",
          summary: {
            source,
            applied: false,
            evaluations: [{ entryIndex: 0, reason: "unsupported-on-wire" }],
          },
        });
        expect(planMisbehavior({ ...unavailable, faultRenderingAvailable: true })).toMatchObject({
          kind: "applied",
          summary: { source, ordinal: 0 },
        });
      },
    );
    it("preserves parsing, provider exclusion, and empty opt-out before rendering support", () => {
      const { input } = setup({ faults: [{ fault: "empty-response", providers: ["gemini"] }] });
      const unavailable = { ...input, faultRenderingAvailable: false };
      expect(planMisbehavior(unavailable)).toMatchObject({
        kind: "skipped",
        summary: { evaluations: [{ reason: "provider-excluded" }] },
      });
      expect(
        planMisbehavior({
          ...unavailable,
          rawHeaders: {
            "x-aimock-misbehavior": "typo",
          },
        }),
      ).toMatchObject({ kind: "error", status: 400, code: "aimock_misbehavior_invalid" });
      input.fixture.misbehavior = { faults: [] };
      expect(planMisbehavior(unavailable)).toMatchObject({
        kind: "skipped",
        summary: { reason: "disabled", evaluations: [] },
      });
    });
    it("preserves original non-chat classification before rendering support", () => {
      const { input } = setup({ faults: [{ fault: "empty-response" }] });
      expect(
        planMisbehavior({
          ...input,
          faultRenderingAvailable: false,
          response: { error: { message: "original", type: "server_error" }, status: 503 },
        }),
      ).toMatchObject({
        kind: "skipped",
        summary: {
          evaluations: [{ reason: "not-applicable" }],
        },
      });
    });
  });
  it("has no marker without config and disables with an empty whole-level override", () => {
    const { input } = setup();
    expect(planMisbehavior(input)).toEqual({ kind: "skipped" });
    input.defaults.misbehavior!.baseline = { faults: [k1] };
    input.fixture.misbehavior = { faults: [] };
    expect(planMisbehavior(input)).toMatchObject({
      kind: "skipped",
      summary: { applied: false, reason: "disabled", evaluations: [] },
    });
  });
  it("uses header then fixture then test scope then baseline without merging", () => {
    const { input } = setup({ faults: [{ fault: "empty-response" }] });
    input.defaults.misbehavior!.byTestId.set("case", { faults: [{ fault: "reasoning-only" }] });
    expect(planMisbehavior(input)).toMatchObject({
      kind: "applied",
      summary: { source: "scope", fault: "reasoning-only" },
    });
    input.fixture.misbehavior = "refusal";
    expect(planMisbehavior(input)).toMatchObject({
      kind: "applied",
      refusalCategory: null,
      summary: { source: "fixture", fault: "refusal" },
    });
    expect(
      planMisbehavior({
        ...input,
        rawHeaders: { ...input.rawHeaders, "x-aimock-misbehavior": "content-filter" },
      }),
    ).toMatchObject({ kind: "applied", summary: { source: "header", fault: "content-filter" } });
    delete input.fixture.misbehavior;
    input.defaults.misbehavior!.byTestId.clear();
    expect(planMisbehavior(input)).toMatchObject({
      kind: "applied",
      summary: { source: "server", fault: "empty-response" },
    });
  });
  it("distinguishes malformed header from direct config with no fallback or counters", () => {
    const { input, journal } = setup({ faults: [k1] });
    const header = planMisbehavior({ ...input, rawHeaders: { "x-aimock-misbehavior": "typo" } });
    expect(header).toMatchObject({
      kind: "error",
      status: 400,
      code: "aimock_misbehavior_invalid",
      summary: { evaluations: [] },
    });
    Object.assign(input.fixture, { misbehavior: { faults: [{ fault: "typo" }] } });
    const fixture = planMisbehavior(input);
    expect(fixture).toMatchObject({
      kind: "error",
      status: 501,
      code: "aimock_misbehavior_not_applicable",
      summary: { evaluations: [] },
    });
    if (fixture.kind === "error") {
      expect(fixture.message).toContain("openai-chat");
      expect(fixture.message).toContain("misbehavior/bad-value");
      expect(fixture.message).toContain("misbehavior.faults[0].fault");
      expect(fixture.message).toContain("typo");
      expect(fixture.summary?.fault).toBeUndefined();
    }
    expect(journal.nextOrdinal({ testId: "case", sourceKey: "server", entryIndex: 0 })).toBe(0);
    expect(journal.getFiringCount({ testId: "case", sourceKey: "server", entryIndex: 0 })).toBe(0);
    expect(
      planMisbehavior({ ...input, rawHeaders: { "x-aimock-misbehavior": "empty-response" } }),
    ).toMatchObject({ kind: "applied", summary: { source: "header" } });
  });
  it("fails malformed scoped/baseline config bypassing validation without skipping or fallback", () => {
    const { input, journal } = setup({ faults: [k1] });
    const malformed: MisbehaviorConfig = { faults: [] };
    Object.assign(malformed, { faults: [{ fault: "typo" }] });
    input.defaults.misbehavior!.byTestId.set("case", malformed);
    expect(planMisbehavior(input)).toMatchObject({
      kind: "error",
      status: 501,
      code: "aimock_misbehavior_not_applicable",
      summary: { source: "scope", evaluations: [] },
    });
    input.defaults.misbehavior!.byTestId.clear();
    input.defaults.misbehavior!.baseline = malformed;
    expect(planMisbehavior(input)).toMatchObject({
      kind: "error",
      status: 501,
      code: "aimock_misbehavior_not_applicable",
      summary: { source: "server", evaluations: [] },
    });
    expect(journal.nextOrdinal({ testId: "case", sourceKey: "server", entryIndex: 0 })).toBe(0);
    input.fixture.misbehavior = { faults: [] };
    expect(planMisbehavior(input)).toMatchObject({
      kind: "skipped",
      summary: { reason: "disabled" },
    });
  });
  it("checks later explicit schema failure even after an earlier eligible candidate", () => {
    const { input, journal } = setup();
    input.fixture.misbehavior = {
      faults: [k1, { ...k2, property: "absent" }, { fault: "empty-response" }],
    };
    const result = planMisbehavior(input);
    expect(result).toMatchObject({
      kind: "error",
      status: 501,
      summary: {
        fault: k2.fault,
        evaluations: [
          { entryIndex: 1, fault: k2.fault, outcome: "error", reason: "not-applicable" },
        ],
      },
    });
    const sourceKey = fixtureMisbehaviorSourceKey(input.fixture, input.fixture.misbehavior);
    expect(journal.nextOrdinal({ testId: "case", sourceKey, entryIndex: 0 })).toBe(0);
    expect(journal.getFiringCount({ testId: "case", sourceKey, entryIndex: 0 })).toBe(0);
  });
  it("prepares later candidates from original arguments and retains later scoped skips", () => {
    const { input } = setup({ faults: [{ ...k1, rate: 0 }, k2, { ...k2, property: "absent" }] });
    const before = structuredClone(input.response);
    expect(planMisbehavior(input)).toMatchObject({
      kind: "applied",
      response: { toolCalls: [{ name: "weather", arguments: "{}" }] },
      summary: {
        evaluations: [
          { entryIndex: 0, outcome: "skipped", reason: "not-rolled", ordinal: 0 },
          { entryIndex: 1, outcome: "applied", ordinal: 0 },
          { entryIndex: 2, outcome: "skipped", reason: "not-applicable" },
        ],
      },
    });
    expect(input.response).toEqual(before);
  });
  it("filters providers before support and never rolls filtered/exhausted/unreached entries", () => {
    const { input, journal } = setup({
      faults: [
        { ...k1, providers: ["anthropic"] },
        { ...k1, times: 1 },
        k1,
        { fault: "empty-response" },
      ],
    });
    journal.recordFiring({ testId: "case", sourceKey: "server", entryIndex: 1 });
    expect(planMisbehavior(input)).toMatchObject({
      kind: "applied",
      summary: {
        evaluations: [
          { entryIndex: 0, outcome: "skipped", reason: "provider-excluded" },
          { entryIndex: 1, outcome: "skipped", reason: "times-exhausted" },
          { entryIndex: 2, outcome: "applied", ordinal: 0 },
        ],
      },
    });
    for (const entryIndex of [0, 1, 3])
      expect(journal.nextOrdinal({ testId: "case", sourceKey: "server", entryIndex })).toBe(0);
    expect(journal.getFiringCount({ testId: "case", sourceKey: "server", entryIndex: 2 })).toBe(1);
  });
  it("retains ordered provider rows and summarizes the last evaluation when none wins", () => {
    const { input } = setup({
      faults: [
        { ...k1, rate: 0 },
        { fault: "refusal", providers: ["anthropic"] },
      ],
    });
    expect(planMisbehavior(input)).toMatchObject({
      kind: "skipped",
      summary: {
        fault: "refusal",
        reason: "provider-excluded",
        evaluations: [
          { entryIndex: 0, ordinal: 0, reason: "not-rolled" },
          { entryIndex: 1, reason: "provider-excluded" },
        ],
      },
    });
  });
  it("gates authored category before defaults, while carrying omitted category as null", () => {
    const { input, journal } = setup();
    input.fixture.misbehavior = { faults: [k1, { fault: "refusal", category: null }] };
    expect(planMisbehavior(input)).toMatchObject({
      kind: "error",
      code: "aimock_misbehavior_unsupported",
      summary: { fault: "refusal" },
    });
    expect(
      journal.nextOrdinal({
        testId: "case",
        sourceKey: fixtureMisbehaviorSourceKey(input.fixture, input.fixture.misbehavior),
        entryIndex: 0,
      }),
    ).toBe(0);
    input.fixture.misbehavior = "refusal";
    expect(planMisbehavior(input)).toMatchObject({ kind: "applied", refusalCategory: null });
  });
  it("threads the true OpenAI ID mode without inventing IDs or served metadata", () => {
    const { input } = setup({ faults: [{ fault: "tool-call-id-duplicate" }] });
    const result = planMisbehavior(input);
    expect(result).toMatchObject({
      kind: "applied",
      duplicateId: { sourceIndex: 0, destinationIndex: 1 },
      response: { toolCalls: [input.response.toolCalls[0], input.response.toolCalls[0]] },
    });
    if (result.kind === "applied") expect(result.summary.servedToolCalls).toBeUndefined();
  });
  it("matches independent FNV/mulberry vectors and spends times only on firing", () => {
    const { input, journal } = setup({ seed: 17, faults: [{ ...k1, rate: 0.2, times: 1 }] });
    // Independent vectors: 0.2736005567, 0.7356906293, 0.0178680744.
    expect(planMisbehavior(input)).toMatchObject({
      kind: "skipped",
      summary: { reason: "not-rolled", ordinal: 0 },
    });
    expect(planMisbehavior(input)).toMatchObject({
      kind: "skipped",
      summary: { reason: "not-rolled", ordinal: 1 },
    });
    expect(journal.getFiringCount({ testId: "case", sourceKey: "server", entryIndex: 0 })).toBe(0);
    expect(planMisbehavior(input)).toMatchObject({ kind: "applied", summary: { ordinal: 2 } });
    expect(planMisbehavior(input)).toMatchObject({
      kind: "skipped",
      summary: { reason: "times-exhausted" },
    });
    expect(journal.nextOrdinal({ testId: "case", sourceKey: "server", entryIndex: 0 })).toBe(3);
    journal.clearMisbehaviorCounters("case");
    expect(planMisbehavior(input)).toMatchObject({ kind: "skipped", summary: { ordinal: 0 } });
  });
  it("advances rate zero and one ordinals and isolates query/header test IDs and sources", () => {
    const { input, journal } = setup({
      faults: [
        { ...k1, rate: 0 },
        { fault: "empty-response", rate: 1 },
      ],
    });
    for (const ordinal of [0, 1])
      expect(planMisbehavior(input)).toMatchObject({
        kind: "applied",
        summary: { evaluations: [{ ordinal }, { ordinal }] },
      });
    expect(
      planMisbehavior({ ...input, rawHeaders: {}, url: "/v1/chat?testId=other" }),
    ).toMatchObject({ kind: "applied", summary: { ordinal: 0 } });
    input.defaults.misbehavior!.byTestId.set("case", { faults: [k1] });
    expect(planMisbehavior({ ...input, url: "/v1/chat?testId=other" })).toMatchObject({
      kind: "applied",
      summary: { source: "scope", ordinal: 0 },
    });
    expect(journal.getFiringCount({ testId: "case", sourceKey: "scope:case", entryIndex: 0 })).toBe(
      1,
    );
  });
  it("replays one process random seed numerically at the same fixture identity", () => {
    const { input, journal } = setup();
    const seed = resolveMisbehaviorSeed("random", input.defaults.logger);
    expect(resolveMisbehaviorSeed("random", input.defaults.logger)).toBe(seed);
    expect(Number.isInteger(seed)).toBe(true);
    input.fixture.misbehavior = { seed: "random", faults: [{ ...k1, rate: 0.5 }] };
    const randomSource = fixtureMisbehaviorSourceKey(input.fixture, input.fixture.misbehavior);
    const first = Array.from({ length: 12 }, () => planMisbehavior(input));
    journal.clearMisbehaviorCounters();
    input.fixture.misbehavior = { seed, faults: [{ ...k1, rate: 0.5 }] };
    expect(fixtureMisbehaviorSourceKey(input.fixture, input.fixture.misbehavior)).toBe(
      randomSource,
    );
    expect(Array.from({ length: 12 }, () => planMisbehavior(input))).toEqual(first);
  });
  it("does not invoke response factories or mutate authoritative blocks", () => {
    const { input } = setup({
      faults: [
        { fault: "tool-args-invalid-json", rate: 0 },
        { fault: "tool-args-schema-violation" },
      ],
    });
    input.fixture.response = () => {
      throw new Error("Already resolved factory must not run");
    };
    const response = {
      ...input.response,
      blocks: [{ type: "toolCall" as const, name: "weather", arguments: '{"city":"Rome"}' }],
    };
    const before = structuredClone(response);
    expect(planMisbehavior({ ...input, response })).toMatchObject({
      kind: "applied",
      response: { toolCalls: [{ arguments: "{}" }], blocks: [{ arguments: "{}" }] },
    });
    expect(response).toEqual(before);
  });
  it("returns real applicability failures on nonchat/error responses without rolls", () => {
    const { input, journal } = setup({ faults: [k1] });
    const response: FixtureResponse = { error: { message: "bad" }, status: 503 };
    expect(planMisbehavior({ ...input, response })).toMatchObject({
      kind: "skipped",
      summary: { reason: "not-applicable" },
    });
    input.fixture.misbehavior = "empty-response";
    expect(planMisbehavior({ ...input, response })).toMatchObject({
      kind: "error",
      code: "aimock_misbehavior_not_applicable",
    });
    expect(journal.nextOrdinal({ testId: "case", sourceKey: "server", entryIndex: 0 })).toBe(0);
  });
  it.each([
    ["anthropic", { fault: "content-filter" }],
    ["openai-responses", { fault: "refusal", category: "safety" }],
  ] as const)("keeps unavailable %s honest", (wire, fault) => {
    const { input } = setup({ faults: [fault] });
    input.wire = wire;
    expect(planMisbehavior(input)).toMatchObject({
      kind: "skipped",
      summary: { reason: "unsupported-on-wire" },
    });
    input.fixture.misbehavior = { faults: [fault] };
    expect(planMisbehavior(input)).toMatchObject({
      kind: "error",
      status: 501,
      code: "aimock_misbehavior_unsupported",
    });
  });
  it.each([
    k1,
    k2,
    { fault: "tool-args-schema-violation", violation: "wrong-type" },
    { fault: "tool-args-schema-violation", violation: "extra-property" },
    { fault: "tool-args-schema-violation", violation: "enum-mismatch" },
    { fault: "tool-args-schema-violation", violation: "not-object" },
    { fault: "tool-unknown-name" },
    { fault: "empty-response" },
    { fault: "refusal" },
    { fault: "content-filter" },
    { fault: "reasoning-only" },
    { fault: "stop-length-mid-tool" },
  ] as const)("adopts actual prepared output for %j", (fault) => {
    const { input } = setup({ faults: [fault] });
    input.stream = true;
    const prepared = prepareMisbehaviorCandidate(input, fault);
    expect(prepared.kind).toBe("ready");
    if (prepared.kind === "ready")
      expect(planMisbehavior(input)).toMatchObject({ kind: "applied", ...prepared.candidate });
  });
});

describe("authored-ID mode K4 handoff", () => {
  const context = {
    wire: "gemini" as const,
    request: { model: "gemini", messages: [] },
    stream: false,
    toolCallIdMode: "authored-nonempty" as const,
  };
  const calls = [
    { name: "absent", arguments: "{}" },
    { name: "named", arguments: "{}", id: "selected" },
    { name: "empty", arguments: "{}", id: "" },
    { name: "named", arguments: "{}", id: "later" },
  ];
  it.each([
    [undefined, "not-applicable"],
    ["absent", "not-applicable"],
    ["empty", "not-applicable"],
    ["missing", "not-applicable"],
    ["named", "ready"],
  ] as const)("uses selected original call for %s", (tool, kind) => {
    const response = { toolCalls: structuredClone(calls) };
    const before = structuredClone(response);
    const result = prepareMisbehaviorCandidate(
      { ...context, response },
      { fault: "tool-call-id-duplicate", tool },
    );
    expect(result.kind).toBe(kind);
    if (result.kind === "ready") {
      expect(result.candidate.duplicateId).toEqual({ sourceIndex: 1, destinationIndex: 2 });
      expect(result.candidate.response).toMatchObject({
        toolCalls: [calls[0], calls[1], { ...calls[2], id: "selected" }, calls[3]],
      });
    }
    expect(response).toEqual(before);
  });
  it("uses ordered blocks before shadow tool calls and clones an authored lone call", () => {
    const response: FixtureResponse = {
      content: "shadow",
      toolCalls: calls,
      blocks: [{ type: "toolCall", name: "only", arguments: "{}", id: "block-id" }],
    };
    expect(
      prepareMisbehaviorCandidate({ ...context, response }, { fault: "tool-call-id-duplicate" }),
    ).toMatchObject({
      kind: "ready",
      candidate: {
        duplicateId: { sourceIndex: 0, destinationIndex: 1 },
        response: {
          toolCalls: [
            { name: "only", id: "block-id" },
            { name: "only", id: "block-id" },
          ],
        },
      },
    });
  });
  it("rejects conflicting mode and constant facts", () => {
    expect(() =>
      prepareMisbehaviorCandidate(
        { ...context, emitsToolCallIds: false, response: { toolCalls: calls } },
        { fault: "tool-call-id-duplicate", tool: "named" },
      ),
    ).toThrow(/conflicting/i);
  });
  it("rejects claiming emitted IDs for an empty authored target", () => {
    expect(() =>
      prepareMisbehaviorCandidate(
        { ...context, emitsToolCallIds: true, response: { toolCalls: calls } },
        { fault: "tool-call-id-duplicate", tool: "empty" },
      ),
    ).toThrow(/conflicting/i);
  });
  it("accepts agreeing authored and constant capability facts", () => {
    expect(
      prepareMisbehaviorCandidate(
        { ...context, emitsToolCallIds: true, response: { toolCalls: calls } },
        { fault: "tool-call-id-duplicate", tool: "named" },
      ),
    ).toMatchObject({ kind: "ready" });
  });
  it("preserves missing-fact invariant on other ID wires", () => {
    expect(() =>
      prepareMisbehaviorCandidate(
        {
          wire: "openai-realtime",
          request: context.request,
          stream: true,
          response: { toolCalls: calls },
        },
        { fault: "tool-call-id-duplicate" },
      ),
    ).toThrow(/Missing current output ID capability/);
  });
});
