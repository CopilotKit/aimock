/**
 * T4: the fixture loaders and `mcpFakes` (spec F1, B13, I6, L3, 5.4).
 *
 * The public loader API is the surface under test:
 * - the old `loadFixtureFile` / `loadFixturesFromDir` throw a
 *   `FixtureLoadError` (rule `mcp-fakes/loader-cannot-carry-fakes`) on a file
 *   with a top-level `mcpFakes` key (B13), instead of dropping the key;
 * - the new `loadFixtureFileWithServices` / `loadFixturesFromDirWithServices`
 *   return the raw blocks with their I6 `source`, the L8 warnings, and the LLM
 *   fixtures; a bad block is a thrown `FixtureLoadError` (fail-loud, L3);
 * - the LLM-fixture behavior of main's cc200e69 (a non-object `match` is
 *   skipped with a warning; a non-object entry or a null `match` throws)
 *   holds in the old and the new loaders.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureLoadError, loadFixtureFile, loadFixturesFromDir } from "../fixture-loader.js";
import {
  loadFixtureFileWithServices,
  loadFixturesFromDirWithServices,
} from "../fixture-loader-services.js";
import { Logger } from "../logger.js";
import { McpFakesAddError } from "../mcp-fakes.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-fakes-loader-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: unknown): string {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

const LLM_FIXTURE = { match: { userMessage: "hi" }, response: { content: "hello" } };

function block(
  tools: unknown[] = [{ name: "get_weather", calls: [{ anyArgs: true, result: "sunny" }] }],
) {
  return { scope: "shared", tools };
}

/** Run `fn`, expect a `FixtureLoadError`, return it. */
function loadError(fn: () => unknown): FixtureLoadError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(FixtureLoadError);
  return thrown as FixtureLoadError;
}

// ---------------------------------------------------------------------------
// B13: the old loaders cannot carry fakes

describe("B13: old loaders throw on a top-level mcpFakes key", () => {
  it("loadFixtureFile throws loader-cannot-carry-fakes naming the file and the new loaders", () => {
    const path = write("both.json", { fixtures: [LLM_FIXTURE], mcpFakes: block() });
    const err = loadError(() => loadFixtureFile(path));
    expect(err.rule).toBe("mcp-fakes/loader-cannot-carry-fakes");
    expect(err.file).toBe(path);
    expect(err.blockId ?? null).toBeNull();
    expect(err.entryId ?? null).toBeNull();
    expect(err.message).toContain(path);
    expect(err.message).toContain("loadFixtureFileWithServices");
    expect(err.message).toContain("loadFixturesFromDirWithServices");
    expect(err.message).toContain("LLMock.loadFixtureFile");
  });

  it("loadFixtureFile throws on a fakes-only file and on any mcpFakes value", () => {
    for (const value of [block(), [block()], null, "x", []]) {
      const path = write("only.json", { mcpFakes: value });
      const err = loadError(() => loadFixtureFile(path));
      expect(err.rule).toBe("mcp-fakes/loader-cannot-carry-fakes");
      expect(err.file).toBe(path);
    }
  });

  it("loadFixturesFromDir throws for a nested file with mcpFakes", () => {
    write("a.json", { fixtures: [LLM_FIXTURE] });
    const nested = write("sub/fakes.json", { fixtures: [], mcpFakes: block() });
    const err = loadError(() => loadFixturesFromDir(dir));
    expect(err.rule).toBe("mcp-fakes/loader-cannot-carry-fakes");
    expect(err.file).toBe(nested);
    expect(err.blockId ?? null).toBeNull();
    expect(err.entryId ?? null).toBeNull();
  });

  it("files without mcpFakes load as before", () => {
    const path = write("plain.json", { fixtures: [LLM_FIXTURE] });
    expect(loadFixtureFile(path)).toHaveLength(1);
    expect(loadFixturesFromDir(dir)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F1 / I6: the new loaders

describe("F1: loadFixtureFileWithServices", () => {
  it("returns LLM fixtures and the single-object block with the path as given (I6)", () => {
    const raw = block();
    const path = write("both.json", { fixtures: [LLM_FIXTURE], mcpFakes: raw });
    const out = loadFixtureFileWithServices(path);
    expect(out.fixtures).toHaveLength(1);
    expect(out.fixtures[0].match.userMessage).toBe("hi");
    expect(out.mcpFakes).toEqual([{ source: path, blockIndex: null, raw }]);
    expect(out.mcpFakeWarnings).toEqual([]);
  });

  it("array form: one source per block, numbered by position (I6)", () => {
    const a = block();
    const b = { scope: { testId: "t1" }, undeclaredTools: "deny", tools: [] };
    const path = write("multi.json", { mcpFakes: [a, b] });
    const out = loadFixtureFileWithServices(path);
    expect(out.fixtures).toEqual([]);
    expect(out.mcpFakes).toEqual([
      { source: path, blockIndex: 0, raw: a },
      { source: path, blockIndex: 1, raw: b },
    ]);
  });

  it("a caller-supplied source label (remote URL) replaces the path (I6)", () => {
    const path = write("remote.json", { mcpFakes: block() });
    const url = "https://example.test/fixtures/remote.json";
    const out = loadFixtureFileWithServices(path, undefined, undefined, url);
    expect(out.mcpFakes.map((s) => s.source)).toEqual([url]);
  });

  it("a fakes-only file is accepted without the missing-fixtures warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = write("only.json", { mcpFakes: block() });
    const out = loadFixtureFileWithServices(path);
    expect(out.fixtures).toEqual([]);
    expect(out.mcpFakes).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a file with neither key keeps today's missing-fixtures warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = write("none.json", { other: 1 });
    const out = loadFixtureFileWithServices(path);
    expect(out).toEqual({ fixtures: [], mcpFakes: [], mcpFakeWarnings: [], unreadable: [] });
    expect(warn).toHaveBeenCalledWith(
      `[fixture-loader] Missing or invalid "fixtures" array in ${path}`,
    );
  });

  it("a file without mcpFakes returns the same LLM fixtures as the old loader", () => {
    const path = write("plain.json", { fixtures: [LLM_FIXTURE, LLM_FIXTURE] });
    const out = loadFixtureFileWithServices(path);
    expect(out.fixtures).toEqual(loadFixtureFile(path));
    expect(out.mcpFakes).toEqual([]);
  });

  it("passes the L8 shadowed-entry warning through with its entry ids", () => {
    const path = write("shadow.json", {
      mcpFakes: block([
        {
          name: "t",
          calls: [
            { anyArgs: true, result: "any" },
            { args: { a: 1 }, result: "specific" },
          ],
        },
      ]),
    });
    const out = loadFixtureFileWithServices(path);
    expect(out.mcpFakes).toHaveLength(1);
    expect(out.mcpFakeWarnings).toHaveLength(1);
    const [w] = out.mcpFakeWarnings;
    expect(w.file).toBe(path);
    expect(w.blockId).toBe(path);
    expect(w.entryId).toBe(`${path}:t#1`);
    expect(w.message).toContain(`${path}:t#0`);
  });

  it("an unreadable file or invalid JSON warns and returns nothing, as today", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = join(dir, "missing.json");
    expect(loadFixtureFileWithServices(missing)).toEqual({
      fixtures: [],
      mcpFakes: [],
      mcpFakeWarnings: [],
      unreadable: [missing],
    });
    const bad = write("bad.json", "{ not json");
    expect(loadFixtureFileWithServices(bad)).toEqual({
      fixtures: [],
      mcpFakes: [],
      mcpFakeWarnings: [],
      unreadable: [bad],
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("F1: loadFixturesFromDirWithServices", () => {
  it("sources are relative to the directory, nested files included, in load order (I6)", () => {
    const top = block();
    const nested = block([{ name: "lookup", calls: [{ anyArgs: true, result: "x" }] }]);
    const deep0 = block();
    const deep1 = {
      scope: { context: "c" },
      tools: [{ name: "t", calls: [{ anyArgs: true, error: "e" }] }],
    };
    write("b.json", { fixtures: [LLM_FIXTURE], mcpFakes: top });
    write("a.json", { fixtures: [LLM_FIXTURE] });
    write("weather/seattle.json", { mcpFakes: nested });
    write("weather/deep/multi.json", { mcpFakes: [deep0, deep1] });
    write("notes.txt", "ignored");
    const out = loadFixturesFromDirWithServices(dir);
    expect(out.fixtures).toHaveLength(2);
    expect(out.mcpFakes).toEqual([
      { source: "b.json", blockIndex: null, raw: top },
      { source: "weather/seattle.json", blockIndex: null, raw: nested },
      { source: "weather/deep/multi.json", blockIndex: 0, raw: deep0 },
      { source: "weather/deep/multi.json", blockIndex: 1, raw: deep1 },
    ]);
    expect(out.mcpFakeWarnings).toEqual([]);
  });

  it("returns the same LLM fixtures as the old loader for a directory without fakes", () => {
    write("a.json", { fixtures: [LLM_FIXTURE] });
    write("sub/b.json", { fixtures: [LLM_FIXTURE, LLM_FIXTURE] });
    const out = loadFixturesFromDirWithServices(dir);
    expect(out.fixtures).toEqual(loadFixturesFromDir(dir));
    expect(out.mcpFakes).toEqual([]);
  });

  it("a bad block in a nested file names the relative source", () => {
    write("ok.json", { mcpFakes: block() });
    write("sub/bad.json", { mcpFakes: { tools: [] } });
    const err = loadError(() => loadFixturesFromDirWithServices(dir));
    expect(err.rule).toBe("mcp-fakes/bad-block:a");
    expect(err.file).toBe("sub/bad.json");
    expect(err.blockId).toBe("sub/bad.json");
    expect(err.entryId ?? null).toBeNull();
  });

  it("an unreadable directory warns and returns nothing, as today", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadFixturesFromDirWithServices(join(dir, "nope"))).toEqual({
      fixtures: [],
      mcpFakes: [],
      mcpFakeWarnings: [],
      unreadable: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5.4 / L3: every bad block is a thrown FixtureLoadError

const F = "bad.json";
const T = (calls: unknown[], extra: Record<string, unknown> = {}) => ({
  name: "t",
  calls,
  ...extra,
});
const OK = { anyArgs: true, result: "ok" };

const BAD_CASES: Array<{
  name: string;
  mcpFakes: unknown;
  rule: string;
  blockId: string | null;
  entryId: string | null;
}> = [
  { name: "(a) no scope", mcpFakes: { tools: [T([OK])] }, rule: "a", blockId: F, entryId: null },
  {
    name: "(b) malformed scope",
    mcpFakes: { scope: { testId: "" }, tools: [T([OK])] },
    rule: "b",
    blockId: F,
    entryId: null,
  },
  {
    name: "(c) shared + deny",
    mcpFakes: { scope: "shared", undeclaredTools: "deny", tools: [T([OK])] },
    rule: "c",
    blockId: F,
    entryId: null,
  },
  {
    name: "(d) call entry with result and error",
    mcpFakes: block([T([{ anyArgs: true, result: "r", error: "e" }])]),
    rule: "d",
    blockId: F,
    entryId: `${F}:t#0`,
  },
  {
    name: "(e) same tool twice",
    mcpFakes: block([T([OK]), T([OK])]),
    rule: "e",
    blockId: F,
    entryId: null,
  },
  {
    name: "(f) entry-id collision in one block",
    mcpFakes: block([T([OK, { ...OK, id: "t#0" }])]),
    rule: "f",
    blockId: F,
    entryId: `${F}:t#0`,
  },
  {
    name: "(g) calls empty",
    mcpFakes: block([T([])]),
    rule: "g",
    blockId: F,
    entryId: null,
  },
  {
    name: "(h) unknown block key",
    mcpFakes: { ...block([T([OK])]), undeclaredTool: "deny" },
    rule: "h",
    blockId: F,
    entryId: null,
  },
  {
    name: "(h) unknown call key, array form",
    mcpFakes: [block(), block([T([{ ...OK, extra: 1 }])])],
    rule: "h",
    blockId: `${F}[1]`,
    entryId: `${F}[1]:t#0`,
  },
  {
    name: "(i) mcpFakes is a string",
    mcpFakes: "nope",
    rule: "i",
    blockId: null,
    entryId: null,
  },
  { name: "(i) empty array", mcpFakes: [], rule: "i", blockId: null, entryId: null },
  {
    name: "(i) array element not an object",
    mcpFakes: [block(), 7],
    rule: "i",
    blockId: `${F}[1]`,
    entryId: null,
  },
  {
    name: "(j) anyArgs not true",
    mcpFakes: block([T([{ anyArgs: false, result: "r" }])]),
    rule: "j",
    blockId: F,
    entryId: `${F}:t#0`,
  },
];

describe("5.4: every bad-block case throws FixtureLoadError from both new loaders", () => {
  for (const c of BAD_CASES) {
    it(`file loader: ${c.name}`, () => {
      write(F, { fixtures: [LLM_FIXTURE], mcpFakes: c.mcpFakes });
      // `F` relative to the cwd is not the I6 source of a single file: use the
      // path as given, which here is the absolute path.
      const path = join(dir, F);
      const err = loadError(() => loadFixtureFileWithServices(path));
      const abs = (id: string | null) => (id === null ? null : path + id.slice(F.length));
      expect(err.rule).toBe(`mcp-fakes/bad-block:${c.rule}`);
      expect(err.file).toBe(path);
      expect(err.blockId ?? null).toBe(abs(c.blockId));
      expect(err.entryId ?? null).toBe(abs(c.entryId));
      expect(err.message).toContain(`[mcp-fakes/bad-block:${c.rule}]`);
    });

    it(`dir loader: ${c.name}`, () => {
      write(F, { mcpFakes: c.mcpFakes });
      const err = loadError(() => loadFixturesFromDirWithServices(dir));
      expect(err.rule).toBe(`mcp-fakes/bad-block:${c.rule}`);
      expect(err.file).toBe(F);
      expect(err.blockId ?? null).toBe(c.blockId);
      expect(err.entryId ?? null).toBe(c.entryId);
    });
  }

  it("two bad blocks in one file: the error describes the first and keeps both", () => {
    const path = write(F, { mcpFakes: [{ tools: [T([OK])] }, block([T([])])] });
    const err = loadError(() => loadFixtureFileWithServices(path));
    expect(err.rule).toBe("mcp-fakes/bad-block:a");
    expect(err.blockId).toBe(`${path}[0]`);
    const all = (err as FixtureLoadError & { errors?: readonly FixtureLoadError[] }).errors;
    expect(all?.map((e) => [e.rule, e.blockId])).toEqual([
      ["mcp-fakes/bad-block:a", `${path}[0]`],
      ["mcp-fakes/bad-block:g", `${path}[1]`],
    ]);
  });

  it("a bad block fails the load whatever the log level (L3)", () => {
    const path = write(F, { mcpFakes: { tools: [T([OK])] } });
    const silent = new Logger("silent");
    expect(() => loadFixtureFileWithServices(path, silent)).toThrow(FixtureLoadError);
    expect(() => loadFixturesFromDirWithServices(dir, silent)).toThrow(FixtureLoadError);
  });
});

// ---------------------------------------------------------------------------
// L3 across files (C4), warnings kept with errors (C5), unreadable sources (C1)

describe("L3: every error of every file, with the warnings", () => {
  const SHADOW = block([
    {
      name: "pick",
      calls: [
        { anyArgs: true, result: "any" },
        { args: { x: 1 }, result: "one" },
      ],
    },
  ]);

  it("C4: a directory with a bad block in each of two files reports both", () => {
    write("a.json", { mcpFakes: { tools: block().tools } });
    write("b.json", { mcpFakes: block([]) });
    write("sub/c.json", { mcpFakes: block() });
    const err = loadError(() => loadFixturesFromDirWithServices(dir));
    expect(err).toBeInstanceOf(McpFakesAddError);
    const all = (err as McpFakesAddError).errors;
    expect(all.map((e) => [e.rule, e.file])).toEqual([
      ["mcp-fakes/bad-block:a", "a.json"],
      ["mcp-fakes/bad-block:g", "b.json"],
    ]);
  });

  it("C5: a file with exactly one error keeps its L8 warnings on the thrown error", () => {
    const path = write(F, { mcpFakes: [SHADOW, block([])] });
    const err = loadError(() => loadFixtureFileWithServices(path));
    expect(err).toBeInstanceOf(McpFakesAddError);
    const add = err as McpFakesAddError;
    expect(add.errors.map((e) => e.rule)).toEqual(["mcp-fakes/bad-block:g"]);
    expect(add.message).toBe(add.errors[0]!.message);
    expect(add.warnings.map((w) => w.entryId)).toEqual([`${path}[0]:pick#1`]);
  });

  it("C5: warnings of a good file ride along with an error in another file", () => {
    write("a.json", { mcpFakes: SHADOW });
    write("b.json", { mcpFakes: block([]) });
    const err = loadError(() => loadFixturesFromDirWithServices(dir));
    expect(err).toBeInstanceOf(McpFakesAddError);
    expect((err as McpFakesAddError).warnings.map((w) => w.entryId)).toEqual(["a.json:pick#1"]);
  });

  it("one error and no warnings is still the bare FixtureLoadError", () => {
    const path = write(F, { mcpFakes: block([]) });
    const err = loadError(() => loadFixtureFileWithServices(path));
    expect(err).not.toBeInstanceOf(McpFakesAddError);
  });

  it("C1: a file that cannot be read or parsed is listed by its source", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    write("good.json", { mcpFakes: block() });
    write("sub/broken.json", "{ not json");
    expect(loadFixturesFromDirWithServices(dir).unreadable).toEqual(["sub/broken.json"]);
    const bad = write("bad.json", "{ not json");
    expect(loadFixtureFileWithServices(bad, undefined, undefined, "label").unreadable).toEqual([
      "label",
    ]);
  });
});

// ---------------------------------------------------------------------------
// cc200e69: LLM-fixture match handling, unchanged in the new loaders

describe("cc200e69: malformed LLM fixture entries", () => {
  const goodBefore = { match: { userMessage: "before" }, response: { content: "B" } };
  const goodAfter = { match: { userMessage: "after" }, response: { content: "A" } };

  for (const match of ["nope", 42, []]) {
    it(`skips a ${JSON.stringify(match)} match with a warning, keeping fakes`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const path = write("m.json", {
        fixtures: [goodBefore, { match, response: { content: "BAD" } }, goodAfter],
        mcpFakes: block(),
      });
      const out = loadFixtureFileWithServices(path);
      expect(out.fixtures.map((f) => f.match.userMessage)).toEqual(["before", "after"]);
      expect(out.mcpFakes).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        `[fixture-loader] Skipping fixture at index 1 in ${path}: Fixture match must be an object`,
      );

      warn.mockClear();
      const dirOut = loadFixturesFromDirWithServices(dir);
      expect(dirOut.fixtures.map((f) => f.match.userMessage)).toEqual(["before", "after"]);
      expect(warn).toHaveBeenCalledWith(
        `[fixture-loader] Skipping fixture at index 1 in ${path}: Fixture match must be an object`,
      );
    });
  }

  for (const [name, entry] of [
    ["missing match", { response: { content: "BAD" } }],
    ["null match", { match: null, response: { content: "BAD" } }],
    ["null entry", null],
    ["array entry", []],
    ["scalar entry", 42],
  ] as const) {
    it(`throws TypeError for ${name}, in the old and the new loaders`, () => {
      write("m.json", { fixtures: [goodBefore, entry, goodAfter] });
      const path = join(dir, "m.json");
      // The message pins the cc200e69 error, not any TypeError (calling a
      // missing loader is a TypeError too).
      const why = /^Fixture (entry|match) must be an object$/;
      expect(() => loadFixtureFile(path)).toThrow(TypeError);
      expect(() => loadFixtureFile(path)).toThrow(why);
      expect(() => loadFixtureFileWithServices(path)).toThrow(TypeError);
      expect(() => loadFixtureFileWithServices(path)).toThrow(why);
      expect(() => loadFixturesFromDirWithServices(dir)).toThrow(TypeError);
      expect(() => loadFixturesFromDirWithServices(dir)).toThrow(why);
    });
  }
});

describe("exports", () => {
  it("the package entry exports the loaders, the MCP fake error class and codes", async () => {
    const entry = await import("../index.js");
    expect(entry.loadFixtureFileWithServices).toBe(loadFixtureFileWithServices);
    expect(entry.loadFixturesFromDirWithServices).toBe(loadFixturesFromDirWithServices);
    expect(entry.FixtureLoadError).toBe(FixtureLoadError);
    expect(typeof entry.McpFakesAddError).toBe("function");
    expect(entry.McpFakesAddError.prototype).toBeInstanceOf(FixtureLoadError);
    expect(entry.MCP_FAKE_ERROR_CODES).toEqual({
      MCP_FAKE_NOT_DECLARED: -32602,
      MCP_FAKE_MISMATCH: -32602,
      MCP_FAKE_EXHAUSTED: -31010,
      MCP_FAKE_EVICTED: -31011,
    });
  });

  it("the ./mcp subpath exports the same MCP fake error class and codes as the package entry", async () => {
    const entry = await import("../index.js");
    const stub = await import("../mcp-stub.js");
    expect(stub.McpFakesAddError).toBe(entry.McpFakesAddError);
    expect(stub.MCP_FAKE_ERROR_CODES).toBe(entry.MCP_FAKE_ERROR_CODES);
  });

  it("the package entry loader reads a file with mcpFakes", () => {
    const file = join(dir, "fakes.json");
    writeFileSync(
      file,
      JSON.stringify({
        mcpFakes: {
          scope: "shared",
          tools: [{ name: "get_weather", calls: [{ anyArgs: true, result: { ok: true } }] }],
        },
      }),
    );
    return import("../index.js").then((entry) => {
      const loaded: import("../index.js").FixturesWithServices =
        entry.loadFixtureFileWithServices(file);
      expect(loaded.mcpFakes).toHaveLength(1);
    });
  });

  it("the package entry and the ./mcp subpath export the McpFake* types", () => {
    // Compile-time check (tsc -p tsconfig.test.json): each import resolves.
    const block: import("../index.js").McpFakeBlock = { scope: "shared", tools: [] };
    const stubBlock: import("../mcp-stub.js").McpFakeBlock = block;
    const code: import("../index.js").McpFakeErrorCode = "MCP_FAKE_EXHAUSTED";
    const stubCode: import("../mcp-stub.js").McpFakeErrorCode = code;
    expect(stubBlock.scope).toBe("shared");
    expect(stubCode).toBe("MCP_FAKE_EXHAUSTED");
  });
});
