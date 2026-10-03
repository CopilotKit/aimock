import { describe, expect, it } from "vitest";
import {
  FixtureLoadError as FixtureLoadErrorFromLoader,
  MCP_FAKES_LOAD_RULES,
  type McpFakesLoadRule,
} from "../fixture-loader.js";
import { FixtureLoadError } from "../index.js";
import { MCP_FAKE_ERROR_CODES, type Fixture, type McpFakeOutcome } from "../types.js";
import { Journal } from "../journal.js";
import { MCP_FAKES_ECHO_LIMIT, McpFakeStore, validateMcpFakes } from "../mcp-fakes.js";

// Another feature registers its own prefix by declaration merging.
declare module "../fixture-loader.js" {
  interface FixtureLoadRuleRegistry {
    "other-spec": "other-spec/something";
  }
}

describe("FixtureLoadError", () => {
  it("is the same class through src/index.ts and src/fixture-loader.ts", () => {
    expect(FixtureLoadError).toBe(FixtureLoadErrorFromLoader);
  });

  it("lists every mcp-fakes rule, each namespaced under mcp-fakes/", () => {
    const letters = "abcdefghij".split("").map((l) => `mcp-fakes/bad-block:${l}`);
    expect([...MCP_FAKES_LOAD_RULES]).toEqual([
      ...letters,
      "mcp-fakes/mount-conflict",
      "mcp-fakes/loader-cannot-carry-fakes",
      "mcp-fakes/watch-reload-changed",
    ]);
  });

  it.each(MCP_FAKES_LOAD_RULES.map((r) => [r]))("constructs one for rule %s", (rule) => {
    const tiedToEntry =
      rule === "mcp-fakes/bad-block:d" ||
      rule === "mcp-fakes/bad-block:f" ||
      rule === "mcp-fakes/bad-block:j";
    const err = new FixtureLoadError({
      rule,
      file: "tickets/retry.json",
      blockId: "tickets/retry.json[1]",
      entryId: tiedToEntry ? "tickets/retry.json[1]:create_ticket#0" : null,
      detail: 'offending key "undeclaredTool"',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FixtureLoadError);
    expect(err.name).toBe("FixtureLoadError");
    expect(err.rule).toBe(rule);
    expect(err.rule.startsWith("mcp-fakes/")).toBe(true);
    expect(err.file).toBe("tickets/retry.json");
    expect(err.blockId).toBe("tickets/retry.json[1]");
    expect(err.entryId).toBe(tiedToEntry ? "tickets/retry.json[1]:create_ticket#0" : null);
    expect(err.message).toContain("tickets/retry.json");
    expect(err.message).toContain("tickets/retry.json[1]");
    expect(err.message).toContain(rule);
    expect(err.message).toContain('"undeclaredTool"');
    expect(err.message).not.toContain("\n");
    if (tiedToEntry) expect(err.message).toContain("tickets/retry.json[1]:create_ticket#0");

    expect(err.toJSON()).toEqual({
      name: "FixtureLoadError",
      rule,
      file: "tickets/retry.json",
      blockId: "tickets/retry.json[1]",
      entryId: tiedToEntry ? "tickets/retry.json[1]:create_ticket#0" : null,
      message: err.message,
    });
    expect(JSON.parse(JSON.stringify(err))).toEqual(err.toJSON());
  });

  it("leaves blockId and entryId absent when they are omitted", () => {
    const rule: McpFakesLoadRule = "mcp-fakes/loader-cannot-carry-fakes";
    const make = () =>
      new FixtureLoadError({
        rule,
        file: "fixtures/old.json",
        detail: 'top-level key "mcpFakes"; use loadFixtureFileWithServices',
      });
    expect(make).not.toThrow();
    const err = make();
    expect(err.blockId).toBeUndefined();
    expect(err.entryId).toBeUndefined();
    expect("blockId" in err).toBe(false);
    expect("entryId" in err).toBe(false);
    const json = err.toJSON();
    expect("blockId" in json).toBe(false);
    expect("entryId" in json).toBe(false);
    expect(json).toEqual({
      name: "FixtureLoadError",
      rule,
      file: "fixtures/old.json",
      message: err.message,
    });
    expect(err.message).toContain("fixtures/old.json");
    expect(err.message).toContain(rule);
    expect(err.message).toContain('"mcpFakes"');
  });

  it("accepts a null file and rules under another prefix", () => {
    const err = new FixtureLoadError({
      rule: "other-spec/something",
      file: null,
      detail: "multi\nline detail",
    });
    expect(err.file).toBeNull();
    expect(err.rule).toBe("other-spec/something");
    expect(err.message).toContain("other-spec/something");
    expect(err.message).not.toContain("\n");
    expect(err.toJSON().file).toBeNull();
  });
});

describe("FixtureLoadError message prefix is bounded", () => {
  const huge = "f".repeat(50_000);
  /** Each prefix part is at most one echo limit; the rest is rule and detail. */
  const bound = (rule: string, detail: string): number =>
    3 * MCP_FAKES_ECHO_LIMIT + rule.length + detail.length + 32;

  it("cuts file, blockId and entryId to the echo limit, keeping the full values as fields", () => {
    const rule = "mcp-fakes/bad-block:f";
    const err = new FixtureLoadError({
      rule,
      file: huge,
      blockId: huge,
      entryId: huge,
      detail: "x",
    });
    expect(err.message.length).toBeLessThanOrEqual(bound(rule, "x"));
    expect(err.message).toContain("… (");
    expect(err.message).toContain(`[${rule}] x`);
    expect(err.file).toBe(huge);
    expect(err.blockId).toBe(huge);
    expect(err.entryId).toBe(huge);
  });

  it("never ends a cut part on a high surrogate", () => {
    // Both parities, so one of them puts the cut right after a high surrogate.
    for (const lead of ["", "a"]) {
      const file = lead + "😀".repeat(30_000);
      const err = new FixtureLoadError({
        rule: "mcp-fakes/bad-block:i",
        file,
        blockId: null,
        detail: "d",
      });
      for (let i = 0; i < err.message.length; i++) {
        const code = err.message.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = err.message.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        }
      }
    }
  });

  it("keeps short parts as they are", () => {
    const err = new FixtureLoadError({
      rule: "mcp-fakes/bad-block:d",
      file: "a.json",
      blockId: "a.json[0]",
      entryId: "a.json[0]:t#0",
      detail: "d",
    });
    expect(err.message).toBe(
      '"a.json", block "a.json[0]", entry "a.json[0]:t#0": [mcp-fakes/bad-block:d] d',
    );
  });

  it("bounds the prefix of a real validation error from a huge source and user id", () => {
    const raw = {
      scope: "shared",
      tools: [{ name: "t", calls: [{ id: huge, anyArgs: true }] }],
    };
    const errors = validateMcpFakes(raw, huge).errors;
    expect(errors.map((e) => [e.rule, e.file, e.blockId, e.entryId])).toEqual([
      ["mcp-fakes/bad-block:d", huge, huge, `${huge}:${huge}`],
    ]);
    for (const err of errors) {
      expect(err.message.length).toBeLessThanOrEqual(3 * MCP_FAKES_ECHO_LIMIT + 1_500);
    }
  });
});

describe("MCP fake error codes", () => {
  it("pins MCP_FAKE_EXHAUSTED to -31010, MCP_FAKE_EVICTED to -31011 and the others to -32602", () => {
    expect(MCP_FAKE_ERROR_CODES).toEqual({
      MCP_FAKE_NOT_DECLARED: -32602,
      MCP_FAKE_MISMATCH: -32602,
      MCP_FAKE_EXHAUSTED: -31010,
      MCP_FAKE_EVICTED: -31011,
    });
  });

  it("the journal outcome type accepts each claim failure, including evicted (checked by typecheck)", () => {
    const outcomes: McpFakeOutcome[] = [
      "answered",
      "mismatch",
      "exhausted",
      "not_declared",
      "evicted",
    ];
    expect(outcomes).toHaveLength(5);
  });
});

describe("Journal.fixtureCountsMaxTestIdsCap", () => {
  // Every option value a programmatic caller can pass. The journal keeps its
  // existing handling of all of them: none throws.
  const ODD_CAPS = [
    undefined,
    0,
    -0,
    -1,
    -3,
    -2.5,
    0.5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 2,
    Number.MAX_VALUE,
  ];

  it("returns the cap the journal enforces, 0 meaning unbounded", () => {
    const cases: [number | undefined, number][] = [
      [undefined, 0],
      [0, 0],
      [-1, 0],
      [-2.5, 0],
      [Number.NEGATIVE_INFINITY, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [Number.MAX_SAFE_INTEGER + 2, 0],
      [0.5, 1],
      [1.5, 1],
      [7, 7],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ];
    for (const [option, cap] of cases) {
      expect(new Journal({ fixtureCountsMaxTestIds: option }).fixtureCountsMaxTestIdsCap).toBe(cap);
    }
  });

  it("keeps the existing option handling: no value throws, and retention is unchanged", () => {
    const fixture = { match: { userMessage: "x" }, response: { content: "y" } } as Fixture;
    // Ids retained after 5 distinct test ids, per the journal's
    // `cap > 0 ? cap : 0` and `size > cap` eviction.
    const retained = (option: number | undefined): number => {
      const journal = new Journal({ fixtureCountsMaxTestIds: option });
      for (let i = 0; i < 5; i++) journal.incrementFixtureMatchCount(fixture, undefined, `t${i}`);
      let n = 0;
      for (let i = 0; i < 5; i++) if (journal.getFixtureMatchCount(fixture, `t${i}`) > 0) n++;
      return n;
    };
    for (const option of ODD_CAPS)
      expect(() => new Journal({ fixtureCountsMaxTestIds: option })).not.toThrow();
    expect(retained(undefined)).toBe(5);
    expect(retained(-1)).toBe(5);
    expect(retained(-2.5)).toBe(5);
    expect(retained(Number.NEGATIVE_INFINITY)).toBe(5);
    expect(retained(Number.NaN)).toBe(5);
    expect(retained(Number.POSITIVE_INFINITY)).toBe(5);
    expect(retained(1.5)).toBe(1);
    expect(retained(3)).toBe(3);
  });

  it("McpFakeStore.setMaxTestIds never throws for the cap of any journal", () => {
    for (const option of ODD_CAPS) {
      const journal = new Journal({ fixtureCountsMaxTestIds: option });
      expect(() =>
        new McpFakeStore().setMaxTestIds(journal.fixtureCountsMaxTestIdsCap),
      ).not.toThrow();
    }
  });
});

describe("FixtureLoadError message and toJSON agree", () => {
  it("names an empty-string file, blockId and entryId in the message, as toJSON keeps them", () => {
    const err = new FixtureLoadError({
      rule: "mcp-fakes/bad-block:f",
      file: "",
      blockId: "",
      entryId: "",
      detail: "d",
    });
    expect(err.toJSON()).toMatchObject({ file: "", blockId: "", entryId: "" });
    expect(err.message).toBe('"", block "", entry "": [mcp-fakes/bad-block:f] d');
  });

  it("still leaves out a null blockId and entryId", () => {
    const err = new FixtureLoadError({
      rule: "mcp-fakes/bad-block:i",
      file: "a.json",
      blockId: null,
      entryId: null,
      detail: "d",
    });
    expect(err.message).toBe('"a.json": [mcp-fakes/bad-block:i] d');
  });
});

describe("FixtureLoadError message is one line", () => {
  // [name, line break, its escape in a quoted name]
  it.each([
    ["U+2028", "\u2028", "\\u2028"],
    ["U+2029", "\u2029", "\\u2029"],
    ["U+0085", "\u0085", "\\u0085"],
    ["VT", "\v", "\\u000b"],
    ["FF", "\f", "\\f"],
    ["CRLF", "\r\n", "\\r\\n"],
  ])("escapes %s in every name part and folds it in a text detail", (_name, sep, escaped) => {
    const err = new FixtureLoadError({
      rule: "mcp-fakes/bad-block:d",
      file: `a${sep}b`,
      blockId: `c${sep}d`,
      entryId: `e${sep}f`,
      detail: `g ${sep} h`,
    });
    expect(err.message).toBe(
      `"a${escaped}b", block "c${escaped}d", entry "e${escaped}f": [mcp-fakes/bad-block:d] g h`,
    );
    expect(err.message).not.toMatch(/[\r\n\v\f\u0085\u2028\u2029]/);
  });
});

describe("FixtureLoadError detail is bounded", () => {
  it("cuts a huge detail to the echo limit", () => {
    const rule = "mcp-fakes/bad-block:g";
    const err = new FixtureLoadError({ rule, file: "a.json", detail: "x".repeat(50_000) });
    const head = `"a.json": [${rule}] `;
    expect(err.message.startsWith(head)).toBe(true);
    const detail = err.message.slice(head.length);
    expect(detail.length).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
    expect(detail).toMatch(/… \(\d+ more chars\)$/);
  });

  it("keeps a short detail as it is", () => {
    const err = new FixtureLoadError({ rule: "mcp-fakes/bad-block:g", file: null, detail: "x" });
    expect(err.message).toBe("<no file>: [mcp-fakes/bad-block:g] x");
  });
});

describe("FixtureLoadError cause", () => {
  it("carries the standard ErrorOptions cause and leaves it out of toJSON", () => {
    const cause = new SyntaxError("Unexpected token");
    const err = new FixtureLoadError(
      { rule: "mcp-fakes/bad-block:i", file: "a.json", detail: "not JSON" },
      { cause },
    );
    expect(err.cause).toBe(cause);
    expect("cause" in err.toJSON()).toBe(false);
  });

  it("has no own cause when none is given", () => {
    const err = new FixtureLoadError({ rule: "mcp-fakes/bad-block:i", file: null, detail: "d" });
    expect(Object.hasOwn(err, "cause")).toBe(false);
  });
});

describe("FixtureLoadError rule is typed (checked by typecheck)", () => {
  it("rejects a misspelled mcp-fakes rule at compile time", () => {
    const make = () =>
      new FixtureLoadError({
        // @ts-expect-error -- "bad-blok" is not a known mcp-fakes rule.
        rule: "mcp-fakes/bad-blok:a",
        file: null,
        detail: "d",
      });
    expect(make).not.toThrow();
  });

  it("rejects a rule under an unknown prefix at compile time", () => {
    const make = () =>
      new FixtureLoadError({
        // @ts-expect-error -- "nope/" is not a registered prefix.
        rule: "nope/x",
        file: null,
        detail: "d",
      });
    expect(make).not.toThrow();
  });
});

describe("FixtureLoadError quotes the file, blockId and entryId it names", () => {
  it("escapes control chars and quotes, so a name cannot forge the message layout", () => {
    const file = "a\u001b[31mb\u0000\t\u009b";
    const blockId = "x, entry y: [mcp-fakes/bad-block:a] fake";
    const entryId = 'e"\u0007';
    const err = new FixtureLoadError({
      rule: "mcp-fakes/bad-block:d",
      file,
      blockId,
      entryId,
      detail: "d",
    });
    expect(err.message).toBe(
      `"a\\u001b[31mb\\u0000\\t\\u009b", block ${JSON.stringify(blockId)}, entry "e\\"\\u0007": [mcp-fakes/bad-block:d] d`,
    );
    expect(err.message).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
  });

  it("a real validation error names its source quoted", () => {
    const source = "dir/evil\u001b.json";
    const [err] = validateMcpFakes({ tools: [] }, source).errors;
    expect(err.message.startsWith(`${JSON.stringify("dir/evil\u001b.json")}, block `)).toBe(true);
    expect(err.message).not.toMatch(/\p{Cc}/u);
  });
});

describe("FixtureLoadError escapes control chars in a text detail", () => {
  it("ESC, NUL, TAB, BEL and DEL are escaped, as C1 controls are", () => {
    const err = new FixtureLoadError({
      rule: "mcp-fakes/bad-block:g",
      file: "a",
      detail: "x\u001b[31mred\u0000\ttab\u0007\u007fc1\u0090",
    });
    expect(err.message).toBe(
      '"a": [mcp-fakes/bad-block:g] x\\u001b[31mred\\u0000\\u0009tab\\u0007\\u007fc1\\u0090',
    );
    expect(err.message).not.toMatch(/\p{Cc}/u);
  });
});
