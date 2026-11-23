import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverGoldenTargets,
  findDuplicateWrites,
  findNarrowingModifiers,
  findOrphanGoldens,
  isFullCorpusRun,
  isMainModule,
  isTruthyEnv,
  outcomeOf,
  parseWriteLog,
  resolveVitestEntry,
  splitArgs,
  vitestInvocation,
} from "../../scripts/capture-golden.js";

let root: string;

function put(rel: string, text = ""): string {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "capture-golden-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isTruthyEnv", () => {
  it("treats unset, empty, 0 and false as not truthy", () => {
    for (const v of [undefined, "", "0", "false", "FALSE", " false "]) {
      expect(isTruthyEnv(v), String(v)).toBe(false);
    }
  });

  it("treats anything else as truthy", () => {
    for (const v of ["1", "true", "yes", "TRUE"]) expect(isTruthyEnv(v), v).toBe(true);
  });
});

describe("splitArgs", () => {
  it("keeps flag values with their flag instead of treating them as paths", () => {
    const exists = (p: string) => p === "foo";
    expect(splitArgs(["-t", "foo"], exists)).toEqual({ paths: [], flags: ["-t", "foo"] });
    expect(splitArgs(["--testNamePattern", "x y"], exists)).toEqual({
      paths: [],
      flags: ["--testNamePattern", "x y"],
    });
  });

  it("separates existing paths from flags", () => {
    const exists = (p: string) => p.startsWith("src/");
    expect(splitArgs(["src/a.test.ts", "--reporter=dot", "src/b"], exists)).toEqual({
      paths: ["src/a.test.ts", "src/b"],
      flags: ["--reporter=dot"],
    });
  });

  it("rejects a positional that is neither a flag value nor an existing path", () => {
    expect(() => splitArgs(["models"], () => false)).toThrow(/not an existing file or directory/);
  });

  it("returns no paths when given only flags", () => {
    expect(splitArgs(["--bail", "1"], () => false)).toEqual({ paths: [], flags: ["--bail", "1"] });
  });
});

describe("isFullCorpusRun", () => {
  it("is full only with no path args and no flags at all", () => {
    expect(isFullCorpusRun({ paths: [], flags: [] })).toBe(true);
    expect(isFullCorpusRun({ paths: ["src/x.test.ts"], flags: [] })).toBe(false);
  });

  it("treats every flag as partial, including narrowing flags it does not know", () => {
    for (const flags of [
      ["-t", "foo"],
      ["--testNamePattern=foo"],
      ["--test-name-pattern=foo"],
      ["--shard=1/2"],
      ["--exclude=src/__tests__/golden/models.golden.test.ts"],
      ["--config", "other.config.ts"],
      ["-c", "other.config.ts"],
      ["--changed"],
      ["--changed", "HEAD~1"],
      ["--related"],
      ["--project", "x"],
      ["--bail", "1"],
      ["--reporter=dot"],
    ]) {
      expect(isFullCorpusRun({ paths: [], flags }), flags.join(" ")).toBe(false);
    }
  });
});

describe("splitArgs (value-taking flags)", () => {
  it("keeps the value of --exclude, kebab-case flags and --changed [since]", () => {
    const none = () => false;
    expect(splitArgs(["--exclude", "x/**"], none)).toEqual({
      paths: [],
      flags: ["--exclude", "x/**"],
    });
    expect(splitArgs(["--test-name-pattern", "x y"], none)).toEqual({
      paths: [],
      flags: ["--test-name-pattern", "x y"],
    });
    expect(splitArgs(["--changed", "HEAD~1"], none)).toEqual({
      paths: [],
      flags: ["--changed", "HEAD~1"],
    });
  });

  it("leaves --changed without a value when the next argument is a flag or absent", () => {
    expect(splitArgs(["--changed", "--reporter=dot"], () => false).flags).toEqual([
      "--changed",
      "--reporter=dot",
    ]);
    expect(splitArgs(["--changed"], () => false).flags).toEqual(["--changed"]);
  });
});

describe("findNarrowingModifiers", () => {
  it("lists targets that use .only/.skip/.todo-style modifiers", () => {
    put("a.test.ts", 'it("x", () => {});');
    put("b.test.ts", 'it.only("x", () => {});');
    put("c.test.ts", 'describe.skip("x", () => {});');
    put("d.test.ts", 'it.skipIf(process.platform === "win32")("x", () => {});');
    put("e.test.ts", 'test.concurrent.only("x", () => {});');
    put("f.test.ts", 'it.todo("x");');
    put("g.test.ts", 'const skipped = 1; it.each([1])("x", () => {});');
    const targets = ["a", "b", "c", "d", "e", "f", "g"].map((n) => `${n}.test.ts`);
    expect(findNarrowingModifiers(root, targets)).toEqual([
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
      "e.test.ts",
      "f.test.ts",
    ]);
  });

  it("finds none in the real golden corpus, so a bare capture checks orphans", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    expect(findNarrowingModifiers(repoRoot, discoverGoldenTargets(repoRoot))).toEqual([]);
  });
});

describe("discoverGoldenTargets", () => {
  it("finds every test file importing the golden harness, wherever it lives", () => {
    put("src/__tests__/golden/harness.ts", "export function expectGolden() {}");
    put("src/__tests__/golden/a.golden.test.ts", 'import { expectGolden } from "./harness.js";');
    put(
      "src/__tests__/direct.test.ts",
      'import {\n  captureHttp,\n  expectGolden,\n} from "./golden/harness.js";',
    );
    put("src/__tests__/nested/deep.test.ts", 'import { x } from "../golden/harness.js";');
    put("src/__tests__/plain.test.ts", 'import { it } from "vitest";');
    put("src/__tests__/mentions.test.ts", `const s = 'import { a } from "./golden/harness.js";';`);
    put("src/__tests__/other/harness.test.ts", 'import { y } from "./harness.js";');
    put("src/__tests__/golden/not-a-test.ts", 'import { z } from "./harness.js";');

    expect(discoverGoldenTargets(root)).toEqual([
      "src/__tests__/direct.test.ts",
      "src/__tests__/golden/a.golden.test.ts",
      "src/__tests__/nested/deep.test.ts",
    ]);
  });

  it("includes handlers-direct-call.test.ts in the real repo", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const targets = discoverGoldenTargets(repoRoot);
    expect(targets).toContain("src/__tests__/handlers-direct-call.test.ts");
    expect(targets).toContain("src/__tests__/golden/models.golden.test.ts");
    expect(targets).not.toContain("src/__tests__/capture-golden.test.ts");
  });
});

describe("parseWriteLog / findOrphanGoldens", () => {
  it("lists snapshot files that the run did not write", () => {
    const snap = join(root, "__snapshots__");
    const a = put("__snapshots__/models/a.json");
    put("__snapshots__/models/stale.json");
    const c = put("__snapshots__/direct-call/c.json");
    put("__snapshots__/direct-call/removed.json");

    const written = parseWriteLog(`${a}\n\n  ${c}  \n${a}\n`);
    expect(findOrphanGoldens(snap, written)).toEqual([
      join(snap, "direct-call", "removed.json"),
      join(snap, "models", "stale.json"),
    ]);
  });

  it("returns nothing when every file was written", () => {
    const snap = join(root, "__snapshots__");
    const a = put("__snapshots__/x/a.json");
    expect(findOrphanGoldens(snap, parseWriteLog(a))).toEqual([]);
  });

  it("returns nothing when the snapshot root does not exist", () => {
    expect(findOrphanGoldens(join(root, "missing"), new Set())).toEqual([]);
  });
});

describe("outcomeOf", () => {
  it("reports a signal kill as a failure naming the signal", () => {
    const o = outcomeOf({ status: null, signal: "SIGTERM" });
    expect(o.code).not.toBe(0);
    expect(o.message).toMatch(/SIGTERM/);
  });

  it("reports a spawn error", () => {
    const o = outcomeOf({ status: null, signal: null, error: new Error("ENOENT") });
    expect(o.code).toBe(1);
    expect(o.message).toMatch(/ENOENT/);
  });

  it("passes through a vitest exit status", () => {
    expect(outcomeOf({ status: 0, signal: null })).toEqual({ code: 0 });
    expect(outcomeOf({ status: 3, signal: null }).code).toBe(3);
  });

  it("treats no status and no signal as a failure", () => {
    expect(outcomeOf({ status: null, signal: null }).code).toBe(1);
  });
});

describe("findOrphanGoldens (non-golden files)", () => {
  it("ignores dotfiles, non-json files and files outside a suite directory", () => {
    const snap = join(root, "__snapshots__");
    put("__snapshots__/models/.DS_Store");
    put("__snapshots__/models/.gitkeep");
    put("__snapshots__/models/notes.txt");
    put("__snapshots__/.DS_Store");
    put("__snapshots__/top.json");
    const stale = put("__snapshots__/models/stale.json");
    expect(findOrphanGoldens(snap, new Set())).toEqual([stale]);
  });
});

describe("findDuplicateWrites", () => {
  it("lists each path the log names more than once", () => {
    const log = [
      "/s/a.json",
      "/s/b.json",
      " /s/a.json ",
      "",
      "/s/c.json",
      "/s/b.json",
      "/s/a.json",
    ];
    expect(findDuplicateWrites(log.join("\n"))).toEqual([
      resolve("/s/a.json"),
      resolve("/s/b.json"),
    ]);
  });

  it("returns nothing when every path is written once", () => {
    expect(findDuplicateWrites("/s/a.json\r\n/s/b.json\n")).toEqual([]);
  });
});

describe("vitestInvocation", () => {
  it("runs vitest's JS entry with Node and no shell, passing args verbatim", () => {
    const args = ["run", "-t", 'a "b" 100% & c^', "src\\__tests__\\golden\\"];
    expect(vitestInvocation("/bin/node", "/r/vitest.mjs", args)).toEqual({
      command: "/bin/node",
      args: ["/r/vitest.mjs", ...args],
      shell: false,
    });
  });

  it("delivers awkward arguments to the child unchanged", () => {
    const tricky = ['a "b"', "100%PATH%", "x & y ^ z", "trail\\", ""];
    const probe = put("probe.mjs", "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const inv = vitestInvocation(process.execPath, probe, tricky);
    const r = spawnSync(inv.command, inv.args, { shell: inv.shell, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(tricky);
  });

  it("resolves the real vitest entry in this repo", () => {
    const entry = resolveVitestEntry(join(import.meta.dirname, "..", ".."));
    expect(entry).toMatch(/vitest\.mjs$/);
    expect(existsSync(entry)).toBe(true);
  });
});

describe("isMainModule", () => {
  it("matches a symlinked argv[1] against the resolved module URL", () => {
    const real = put("real/s.ts");
    symlinkSync(join(root, "real"), join(root, "link"), "dir");
    expect(isMainModule(join(root, "link", "s.ts"), pathToFileURL(real).href)).toBe(true);
    expect(isMainModule(real, pathToFileURL(real).href)).toBe(true);
  });

  it("is false for another file, a missing file, or no argv[1]", () => {
    const real = put("real/s.ts");
    const other = put("real/o.ts");
    expect(isMainModule(other, pathToFileURL(real).href)).toBe(false);
    expect(isMainModule(join(root, "missing.ts"), pathToFileURL(real).href)).toBe(false);
    expect(isMainModule(undefined, pathToFileURL(real).href)).toBe(false);
  });

  it("runs main when the script is invoked through a symlinked path", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const link = join(root, "repo-link");
    symlinkSync(repoRoot, link, "dir");
    // CI=1 makes main refuse at once, so nothing is written; a skipped main exits 0 silently.
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", join(link, "scripts", "capture-golden.ts")],
      { cwd: repoRoot, env: { ...process.env, CI: "1" }, encoding: "utf8" },
    );
    expect(r.stderr).toMatch(/refusing to write goldens with CI set/);
    expect(r.status).toBe(1);
  }, 30_000);
});
