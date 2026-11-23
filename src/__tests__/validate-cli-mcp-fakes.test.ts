/**
 * `aimock validate` on files that carry `mcpFakes` (spec F6, F7, F8, 5.4,
 * I6, I8, L8). Every test runs the built CLI (`dist/aimock-cli.js`) as a real
 * process on real files and checks its exit code and output.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = resolve("dist/aimock-cli.js");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function validate(args: string[], cwd?: string): Run {
  const result = spawnSync(process.execPath, [CLI, "validate", ...args], {
    encoding: "utf8",
    timeout: 15000,
    cwd,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const answer = { content: [{ type: "text", text: "sunny" }] };

/** A clean shared block with one tool. */
function block(calls: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { scope: "shared", tools: [{ name: "get_weather", calls }], ...extra };
}

const llmFixture = { match: { userMessage: "hi" }, response: { content: "hello" } };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aimock-validate-fakes-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, doc: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

describe("aimock validate with mcpFakes", () => {
  it("F7/F8: a named fakes-only file is OK with its block count and exits 0", () => {
    const f = write("fakes.json", { mcpFakes: block([{ anyArgs: true, result: answer }]) });
    const run = validate([f]);
    expect(run.stderr).not.toContain("Missing or invalid");
    expect(run.stderr).not.toContain("No fixtures loaded from any input");
    expect(run.stdout).toContain(`${f}: OK (0 fixture(s), 1 mcpFakes block(s))`);
    expect(run.status).toBe(0);
  });

  it("F6: a walked fakes-only file is validated, not skipped", () => {
    mkdirSync(join(dir, "tree"));
    const f = join(dir, "tree", "fakes.json");
    writeFileSync(f, JSON.stringify({ mcpFakes: [block([{ anyArgs: true, result: answer }])] }));
    const run = validate([join(dir, "tree")]);
    expect(run.stdout).not.toContain("skipped");
    expect(run.stdout).toContain(`${f}: OK (0 fixture(s), 1 mcpFakes block(s))`);
    expect(run.status).toBe(0);
  });

  it("F7: a bad block in a file that also has fixtures is an error naming the case", () => {
    const f = write("mixed.json", {
      fixtures: [llmFixture],
      mcpFakes: block([{ anyArgs: true, result: answer }], { undeclaredTool: "deny" }),
    });
    const run = validate([f]);
    expect(run.stdout).not.toContain("OK");
    expect(run.stderr).toContain(`${f}: [error] `);
    expect(run.stderr).toContain("[mcp-fakes/bad-block:h]");
    expect(run.stderr).toContain("undeclaredTool");
    expect(run.stdout).toContain(`${f}: 1 fixture(s), 1 error(s), 0 warning(s)`);
    expect(run.status).toBe(1);
  });

  it("F7: --json carries the bad block as an error of the file", () => {
    const f = write("bad.json", {
      mcpFakes: block([{ anyArgs: true, result: answer }], { undeclaredTool: "deny" }),
    });
    const run = validate(["--json", f]);
    const doc = JSON.parse(run.stdout) as {
      failed: boolean;
      files: { errors: { message: string }[] }[];
    };
    expect(doc.failed).toBe(true);
    expect(doc.files[0].errors).toHaveLength(1);
    expect(doc.files[0].errors[0].message).toContain("[mcp-fakes/bad-block:h]");
    expect(run.status).toBe(1);
  });

  it("L8: an args entry after an anyArgs entry of the same tool is a warning", () => {
    const f = write("shadow.json", {
      mcpFakes: block([
        { anyArgs: true, result: answer },
        { args: { city: "Seattle" }, result: answer },
      ]),
    });
    const run = validate([f]);
    expect(run.stdout).toContain(`${f}: [warning] `);
    expect(run.stdout).toContain("is shadowed until the preceding anyArgs entry");
    expect(run.stdout).toContain(`${f}:get_weather#1`);
    expect(run.status).toBe(0);
  });

  it("F7 cross-file collision: a.json + id x:y and a.json:x + id y both give a.json:x:y", () => {
    write("a.json", { mcpFakes: block([{ id: "x:y", anyArgs: true, result: answer }]) });
    writeFileSync(
      join(dir, "a.json:x"),
      JSON.stringify({ mcpFakes: block([{ id: "y", anyArgs: true, result: answer }]) }),
    );
    // The walk of "." gives a.json the directory-relative source "a.json"; the
    // named "a.json:x" keeps its path as given (I6). The later one is bad (I8).
    const run = validate([".", "a.json:x"], dir);
    expect(run.stderr).toContain("a.json:x: [error] ");
    expect(run.stderr).toContain("[mcp-fakes/bad-block:f]");
    expect(run.stderr).toContain("a.json:x:y");
    const line = run.stderr.split("\n").find((l) => l.includes("[mcp-fakes/bad-block:f]"));
    expect(line).toMatch(/"a\.json".*"a\.json:x"|"a\.json:x".*"a\.json"/);
    expect(run.stdout).toContain("a.json: OK (0 fixture(s), 1 mcpFakes block(s))");
    expect(run.status).toBe(1);
  });

  it("I8 in-block: a user id equal to another entry's default local is an error", () => {
    const f = write("inblock.json", {
      mcpFakes: block([
        { args: { city: "Seattle" }, result: answer },
        { args: { city: "Paris" }, result: answer },
        { id: "get_weather#1", args: { city: "Rome" }, result: answer },
      ]),
    });
    const run = validate([f]);
    expect(run.stderr).toContain("[mcp-fakes/bad-block:f]");
    expect(run.stderr).toContain(`${f}:get_weather#1`);
    expect(run.status).toBe(1);
  });
});

describe("aimock validate reports each bad-block case (5.4 (a)-(j))", () => {
  const scoped = { testId: "T" };
  const tool = (name: string, calls: unknown[]) => ({ name, calls });
  const ok = [{ anyArgs: true, result: answer }];

  const cases: Array<{ letter: string; what: string; mcpFakes: unknown }> = [
    { letter: "a", what: "no scope", mcpFakes: { tools: [tool("t", ok)] } },
    {
      letter: "b",
      what: "malformed scope",
      mcpFakes: { scope: {}, tools: [tool("t", ok)] },
    },
    {
      letter: "c",
      what: "shared + deny",
      mcpFakes: { scope: "shared", undeclaredTools: "deny", tools: [tool("t", ok)] },
    },
    {
      letter: "d",
      what: "call entry with both result and error",
      mcpFakes: { scope: scoped, tools: [tool("t", [{ args: {}, result: "x", error: "y" }])] },
    },
    {
      letter: "e",
      what: "same tool twice",
      mcpFakes: { scope: scoped, tools: [tool("t", ok), tool("t", ok)] },
    },
    {
      letter: "f",
      what: "entry-id collision",
      mcpFakes: {
        scope: scoped,
        tools: [
          tool("t", [
            { id: "t#1", args: { a: 1 }, result: "a" },
            { args: { a: 2 }, result: "b" },
          ]),
        ],
      },
    },
    { letter: "g", what: "empty calls", mcpFakes: { scope: scoped, tools: [tool("t", [])] } },
    {
      letter: "h",
      what: "unknown key on a block",
      mcpFakes: { scope: scoped, undeclaredTool: "deny", tools: [tool("t", ok)] },
    },
    { letter: "i", what: "an empty mcpFakes array", mcpFakes: [] },
    {
      letter: "j",
      what: "anyArgs not true",
      mcpFakes: { scope: scoped, tools: [tool("t", [{ anyArgs: false, result: "x" }])] },
    },
  ];

  it.each(cases)("($letter) $what: an error naming the case, exit 1", ({ letter, mcpFakes }) => {
    const f = write(`bad-${letter}.json`, { mcpFakes });
    const run = validate([f]);
    expect(run.stdout).not.toContain(`${f}: OK`);
    const errors = run.stderr.split("\n").filter((l) => l.startsWith(`${f}: [error] `));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`[mcp-fakes/bad-block:${letter}]`);
    expect(run.status).toBe(1);
  });
});

describe("aimock validate mcpFakes: round-1 D1-D4", () => {
  it("D1: a store failure other than McpFakesAddError is a per-file error and --json stays valid", () => {
    // Fault injection into the real CLI process: a preload replaces
    // McpFakeStore.prototype.add (the same dist module the CLI imports) with
    // one that throws a plain TypeError, as an aimock defect would.
    const inject = join(dir, "inject.mjs");
    const storeUrl = pathToFileURL(resolve("dist/mcp-fakes.js")).href;
    writeFileSync(
      inject,
      `import { McpFakeStore } from ${JSON.stringify(storeUrl)};\n` +
        `McpFakeStore.prototype.add = function () { throw new TypeError("injected store defect"); };\n`,
    );
    const a = write("a.json", { mcpFakes: block([{ anyArgs: true, result: answer }]) });
    const b = write("b.json", { fixtures: [llmFixture] });
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(inject).href, CLI, "validate", "--json", a, b],
      { encoding: "utf8", timeout: 15000 },
    );
    expect(result.error).toBeUndefined();
    const doc = JSON.parse(result.stdout) as {
      failed: boolean;
      files: { file: string; errors: { message: string }[]; mcpFakeBlocks?: number }[];
    };
    expect(doc.failed).toBe(true);
    expect(doc.files.map((f) => f.file)).toEqual([a, b]);
    expect(doc.files[0].errors).toHaveLength(1);
    expect(doc.files[0].errors[0].message).toContain("mcpFakes check failed");
    expect(doc.files[0].errors[0].message).toContain("injected store defect");
    expect(doc.files[0].mcpFakeBlocks ?? 0).toBe(0);
    expect(doc.files[1].errors).toHaveLength(0);
    expect(result.stderr).toContain("injected store defect");
    expect(result.status).toBe(1);
  });

  it("D2: a walked config-shaped file with mcpFakes is validated, not skipped", () => {
    mkdirSync(join(dir, "tree"));
    const bad = join(dir, "tree", "bad.json");
    const good = join(dir, "tree", "good.json");
    writeFileSync(
      bad,
      JSON.stringify({
        mcp: { tools: [] },
        mcpFakes: block([{ anyArgs: true, result: answer }], { undeclaredTool: "deny" }),
      }),
    );
    writeFileSync(
      good,
      JSON.stringify({ llm: {}, mcpFakes: block([{ anyArgs: true, result: answer }]) }),
    );
    const run = validate([join(dir, "tree")]);
    expect(run.stdout).not.toContain("skipped");
    expect(run.stderr).toContain(`${bad}: [error] `);
    expect(run.stderr).toContain("[mcp-fakes/bad-block:h]");
    expect(run.stdout).toContain(`${good}: OK (0 fixture(s), 1 mcpFakes block(s))`);
    expect(run.status).toBe(1);
  });

  it("D3: mcpFakes with a non-array fixtures still has its fakes checked", () => {
    const f = write("shape.json", {
      fixtures: "not-an-array",
      mcpFakes: block([{ anyArgs: true, result: answer }], { undeclaredTool: "deny" }),
    });
    const run = validate([f]);
    expect(run.stderr).toContain('Missing or invalid "fixtures" array');
    expect(run.stderr).toContain("[mcp-fakes/bad-block:h]");
    expect(run.status).toBe(1);
  });

  it("D3: the clean fakes of a non-array-fixtures file are loaded into the run", () => {
    const f = write("shape-ok.json", {
      fixtures: {},
      mcpFakes: block([{ anyArgs: true, result: answer }]),
    });
    const run = validate(["--json", f]);
    const doc = JSON.parse(run.stdout) as {
      files: { errors: { message: string }[]; mcpFakeBlocks?: number }[];
    };
    expect(doc.files[0].errors).toHaveLength(1);
    expect(doc.files[0].errors[0].message).toContain('Missing or invalid "fixtures" array');
    expect(doc.files[0].mcpFakeBlocks).toBe(1);
    expect(run.status).toBe(1);
  });

  it("D4: the --json run summary counts mcpFakes blocks", () => {
    const f = write("only.json", {
      mcpFakes: [
        block([{ anyArgs: true, result: answer }]),
        { scope: "shared", tools: [{ name: "other", calls: [{ anyArgs: true, result: answer }] }] },
      ],
    });
    const run = validate(["--json", f]);
    const doc = JSON.parse(run.stdout) as {
      failed: boolean;
      run: { fixtures: number; mcpFakeBlocks?: number; errors: string[] };
    };
    expect(doc.failed).toBe(false);
    expect(doc.run.fixtures).toBe(0);
    expect(doc.run.mcpFakeBlocks).toBe(2);
    expect(run.status).toBe(0);
  });

  it("D4: a --json usage error carries the same run shape", () => {
    const run = validate(["--json"]);
    const doc = JSON.parse(run.stdout) as { run: { mcpFakeBlocks?: number } };
    expect(doc.run.mcpFakeBlocks).toBe(0);
    expect(run.status).toBe(1);
  });
});
