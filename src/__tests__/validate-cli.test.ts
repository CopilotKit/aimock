import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { format } from "node:util";
import { CollectingLogger, runValidateCli } from "../validate-cli.js";
import { Logger } from "../logger.js";
import { runAimockCli } from "../aimock-cli.js";

// macOS/APFS happens to hand back already-sorted directory entries, which would
// let the walk's `.sort()` calls rot undetected. This toggle reverses whatever
// the real filesystem returns so the sorting contract can be pinned on any host.
const readdirControl = vi.hoisted(() => ({ reverse: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // Every argument is forwarded: taking `path` alone silently discarded
    // options such as `{ withFileTypes: true }`, handing the caller a shape
    // the real `fs` would never return for that call.
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      const entries = actual.readdirSync(...args);
      return readdirControl.reverse ? [...entries].reverse() : entries;
    }) as typeof actual.readdirSync,
  };
});

function harness(argv: string[]): { logs: string[]; errors: string[]; code: number | null } {
  const logs: string[] = [];
  const errors: string[] = [];
  let code: number | null = null;
  runValidateCli({
    argv,
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
    exit: (c) => {
      code = c;
    },
  });
  return { logs, errors, code };
}

/**
 * The whole `--json` document, mirroring what `runValidateCli` emits: `index`
 * is optional (a file-level finding names no entry), `detail` carries the raw
 * thrown text, and `run` holds the run-level totals and errors. Typing the
 * document in full is what lets a test read `doc.run` — or a finding's
 * `detail` — without re-declaring a narrower shape at the cast, which is how
 * `run` went undocumented here while three tests asserted against it.
 */
interface JsonReport {
  strict: boolean;
  failed: boolean;
  files: {
    file: string;
    /**
     * Which load of `file` this entry is, 1-based. Two entries for one path
     * differ only here, so a consumer keying the report by file needs it.
     */
    mention: number;
    fixtures: number;
    errors: { index?: number; message: string; detail?: string }[];
    warnings: { index?: number; message: string; detail?: string }[];
    fatal?: string;
    /** Present on a *.json file the walk passed over as not fixture-shaped. */
    skipped?: string;
  }[];
  run: { fixtures: number; errors: string[] };
}

describe("aimock validate CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimock-validate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  function writeFixtureFile(name: string, userMessage: string): string {
    return write(
      name,
      JSON.stringify({
        fixtures: [{ match: { userMessage }, response: { content: "hello" } }],
      }),
    );
  }

  function writeBadRateFile(name: string): string {
    return write(
      name,
      JSON.stringify({
        fixtures: [
          { match: { userMessage: "hi" }, response: { content: "x" }, chaos: { dropRate: 9 } },
        ],
      }),
    );
  }

  it("accepts a clean file with exit 0, reporting the fixture count", () => {
    const f = write(
      "ok.json",
      JSON.stringify({
        fixtures: [
          { match: { userMessage: "hi" }, response: { content: "hello" } },
          { match: { userMessage: "yo" }, response: { content: "sup" } },
        ],
      }),
    );
    const r = harness([f]);
    expect(r.code).toBe(0);
    expect(r.logs.join("\n")).toContain(`${f}: OK (2 fixture(s))`);
  });

  it("fails unreadable, unparseable, and wrong-shape files with exit 1", () => {
    const missing = harness([join(dir, "nope.json")]);
    expect(missing.code).toBe(1);
    expect(missing.errors.join("\n")).toContain("Could not read");

    const badJson = harness([write("bad.json", "{not json")]);
    expect(badJson.code).toBe(1);
    expect(badJson.errors.join("\n")).toContain("Invalid JSON");

    const wrongShape = harness([write("shape.json", JSON.stringify({ hello: 1 }))]);
    expect(wrongShape.code).toBe(1);
    expect(wrongShape.errors.join("\n")).toContain("fixtures");
  });

  it("reports fixture errors with exit 1 and a counted summary line", () => {
    const badRate = writeBadRateFile("rate.json");
    const r = harness([badRate]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("dropRate");
    expect(r.logs.join("\n")).toContain(`${badRate}: 1 fixture(s), 1 error(s), 0 warning(s)`);
  });

  it("reports fixture errors in --json mode with strict, counts and error detail", () => {
    const badRate = writeBadRateFile("rate.json");
    const j = harness(["--json", badRate]);
    expect(j.code).toBe(1);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    expect(doc.strict).toBe(false);
    expect(doc.failed).toBe(true);
    expect(doc.files).toHaveLength(1);
    expect(doc.files[0].file).toBe(badRate);
    expect(doc.files[0].fixtures).toBe(1);
    expect(doc.files[0].warnings).toEqual([]);
    expect(doc.files[0].errors).toHaveLength(1);
    expect(doc.files[0].errors[0].index).toBe(0);
    expect(doc.files[0].errors[0].message).toContain("dropRate");
  });

  it("reports a fatal file in --json mode with strict true and its reason counted", () => {
    const broken = write("fatal.json", "{not json");
    const j = harness(["--json", "--strict", broken]);
    expect(j.code).toBe(1);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    expect(doc.strict).toBe(true);
    expect(doc.failed).toBe(true);
    expect(doc.files).toHaveLength(1);
    expect(doc.files[0].file).toBe(broken);
    expect(doc.files[0].fatal).toContain("Invalid JSON");
    expect(doc.files[0].fixtures).toBe(0);
    // The fatal reason is ALSO a countable error, so a consumer tallying
    // `files[].errors` sees the failure the human summary line counts.
    expect(doc.files[0].errors).toEqual([{ message: doc.files[0].fatal }]);
    expect(doc.files[0].warnings).toEqual([]);
    // stdout carries the JSON document alone; the reason for the non-zero exit
    // is on stderr, and a fatal file never becomes a JSON-polluting log line.
    expect(j.logs.join("\n")).toBe(JSON.stringify(doc, null, 2));
    expect(j.errors.join("\n")).toContain("fixture validation failed");
    expect(j.errors.join("\n")).toContain(`${broken}: Invalid JSON`);
    expect(j.errors.join("\n")).toContain("1 unreadable/invalid file(s)");
  });

  it("exits 1 when no paths are given, like every other CLI in the package", () => {
    const usage = harness([]);
    expect(usage.code).toBe(1);
    expect(usage.errors.join("\n")).toContain("no fixture paths given");
  });

  it("exits 1 on an unknown option", () => {
    const unknown = harness(["--nope", writeBadRateFile("rate.json")]);
    expect(unknown.code).toBe(1);
    // parseArgs owns the wording; assert the option is named and the help
    // follows it, not the exact sentence.
    expect(unknown.errors.join("\n")).toContain("Unknown option '--nope'");
    expect(unknown.errors.join("\n")).toContain("Usage: aimock validate");
  });

  it("validates a directory recursively, including nested subdirectories", () => {
    mkdirSync(join(dir, "pack"));
    mkdirSync(join(dir, "pack", "nested"));
    writeFileSync(
      join(dir, "pack", "a.json"),
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
      }),
    );
    writeFileSync(
      join(dir, "pack", "nested", "b.json"),
      JSON.stringify({
        fixtures: [{ match: { userMessage: "yo" }, response: { content: "sup" } }],
      }),
    );
    writeFileSync(join(dir, "pack", "notes.txt"), "ignored");

    const r = harness([join(dir, "pack")]);
    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toContain(join(dir, "pack", "a.json") + ": OK (1 fixture(s))");
    expect(out).toContain(join(dir, "pack", "nested", "b.json") + ": OK (1 fixture(s))");
    expect(out).not.toContain("notes.txt");
  });

  it("walks a directory files-first then subdirectories, each sorted", () => {
    const root = join(dir, "order");
    mkdirSync(root);
    // Created in an order that is the reverse of the documented walk order, so
    // an unsorted or subdirs-first walk cannot pass by accident.
    mkdirSync(join(root, "zsub"));
    mkdirSync(join(root, "msub"));
    const body = (m: string): string =>
      JSON.stringify({ fixtures: [{ match: { userMessage: m }, response: { content: "x" } }] });
    writeFileSync(join(root, "zsub", "zfile.json"), body("z"));
    writeFileSync(join(root, "msub", "mfile.json"), body("m"));
    writeFileSync(join(root, "b.json"), body("b"));
    writeFileSync(join(root, "a.json"), body("a"));

    const r = harness([root]);
    expect(r.code).toBe(0);
    expect(r.logs).toEqual([
      join(root, "a.json") + ": OK (1 fixture(s))",
      join(root, "b.json") + ": OK (1 fixture(s))",
      join(root, "msub", "mfile.json") + ": OK (1 fixture(s))",
      join(root, "zsub", "zfile.json") + ": OK (1 fixture(s))",
    ]);
  });

  it("sorts files and subdirectories even when the filesystem lists them unsorted", () => {
    const root = join(dir, "unsorted");
    mkdirSync(root);
    mkdirSync(join(root, "asub"));
    mkdirSync(join(root, "bsub"));
    const body = (m: string): string =>
      JSON.stringify({ fixtures: [{ match: { userMessage: m }, response: { content: "x" } }] });
    writeFileSync(join(root, "one.json"), body("one"));
    writeFileSync(join(root, "two.json"), body("two"));
    writeFileSync(join(root, "asub", "x.json"), body("x"));
    writeFileSync(join(root, "bsub", "y.json"), body("y"));

    readdirControl.reverse = true;
    try {
      const r = harness([root]);
      expect(r.code).toBe(0);
      expect(r.logs).toEqual([
        join(root, "one.json") + ": OK (1 fixture(s))",
        join(root, "two.json") + ": OK (1 fixture(s))",
        join(root, "asub", "x.json") + ": OK (1 fixture(s))",
        join(root, "bsub", "y.json") + ": OK (1 fixture(s))",
      ]);
    } finally {
      readdirControl.reverse = false;
    }
  });

  it("fails a directory that contains a broken file, naming the file not the directory", () => {
    mkdirSync(join(dir, "mixed"));
    writeFileSync(
      join(dir, "mixed", "good.json"),
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
      }),
    );
    writeFileSync(join(dir, "mixed", "broken.json"), "{not json");

    const r = harness([join(dir, "mixed")]);
    expect(r.code).toBe(1);
    expect(r.logs.join("\n")).toContain(join(dir, "mixed", "good.json") + ": OK (1 fixture(s))");
    const errs = r.errors.join("\n");
    expect(errs).toContain(join(dir, "mixed", "broken.json") + ": [error] Invalid JSON");
    expect(errs).not.toContain("EISDIR");
  });

  it("fails a directory with no .json files", () => {
    mkdirSync(join(dir, "empty"));
    const r = harness([join(dir, "empty")]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("No .json fixture files found in directory");
  });

  it("validates every path of a multi-path invocation, in argv order", () => {
    const good = writeFixtureFile("multi-good.json", "hi");
    const broken = write("multi-bad.json", "{not json");
    const alsoGood = writeFixtureFile("multi-also-good.json", "yo");

    const r = harness([good, broken, alsoGood]);
    expect(r.code).toBe(1);
    // Every file gets a summary line, the broken one included, in argv order.
    expect(r.logs).toEqual([
      `${good}: OK (1 fixture(s))`,
      `${broken}: 0 fixture(s), 1 error(s), 0 warning(s)`,
      `${alsoGood}: OK (1 fixture(s))`,
    ]);
    expect(r.errors.join("\n")).toContain(`${broken}: [error] Invalid JSON`);
  });

  it("surfaces per-entry conversion warnings instead of dropping them", () => {
    const f = write(
      "speed.json",
      JSON.stringify({
        fixtures: [
          { match: { userMessage: "hi" }, response: { content: "hello" } },
          { match: { userMessage: "yo" }, response: { content: "sup" }, replaySpeed: 0 },
        ],
      }),
    );

    const r = harness([f]);
    expect(r.code).toBe(0);
    // The collected diagnostic keeps the `[aimock]` prefix the server's own
    // stderr carries for the same warning.
    expect(r.logs.join("\n")).toContain(
      "[warning] #1 [aimock] Fixture replaySpeed must be positive",
    );
    expect(r.logs.join("\n")).toContain(`${f}: 2 fixture(s), 0 error(s), 1 warning(s)`);

    const j = harness(["--json", f]);
    expect(j.code).toBe(0);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    expect(doc.strict).toBe(false);
    expect(doc.failed).toBe(false);
    expect(doc.files[0].fixtures).toBe(2);
    expect(doc.files[0].errors).toEqual([]);
    expect(doc.files[0].warnings).toHaveLength(1);
    expect(doc.files[0].warnings[0].index).toBe(1);

    // --strict must promote the recovered warning to a failure.
    expect(harness(["--strict", f]).code).toBe(1);
  });

  it("catches cross-file duplicate userMessage the server's --validate-on-load catches", () => {
    mkdirSync(join(dir, "dup"));
    const a = join(dir, "dup", "a.json");
    const b = join(dir, "dup", "b.json");
    writeFileSync(
      a,
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "from a" } }],
      }),
    );
    writeFileSync(
      b,
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "from b" } }],
      }),
    );

    // Validated per file, neither file has a duplicate: the finding only
    // exists over the union, which is what the server validates.
    const r = harness([join(dir, "dup")]);
    // Exact: a substring assertion cannot see a mangled index (a trailing
    // "+" read as part of it) or a path spliced into the quoted userMessage.
    expect(r.logs.concat(r.errors)).toContain(
      `${b}: [warning] #0 cross-file: duplicate userMessage 'hi' — shadows fixture ${a} #0`,
    );
    // A warning, as on the server — only --strict turns it into a failure.
    expect(r.code).toBe(0);
    expect(harness(["--strict", join(dir, "dup")]).code).toBe(1);
  });

  it("catches a catch-all that is last in its file but not last overall", () => {
    mkdirSync(join(dir, "order"));
    const a = join(dir, "order", "a.json");
    const b = join(dir, "order", "b.json");
    writeFileSync(a, JSON.stringify({ fixtures: [{ match: {}, response: { content: "any" } }] }));
    writeFileSync(
      b,
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "from b" } }],
      }),
    );

    const r = harness([join(dir, "order")]);
    const out = r.logs.join("\n");
    expect(out).toContain(a + ": [warning] #0 cross-file: empty match acts as catch-all");
    expect(out).toContain(b + " #0");
    expect(harness(["--strict", join(dir, "order")]).code).toBe(1);
  });

  it("reports a within-file duplicate once, with its own file-local index", () => {
    const f = write(
      "within.json",
      JSON.stringify({
        fixtures: [
          { match: { userMessage: "hi" }, response: { content: "1" } },
          { match: { userMessage: "hi" }, response: { content: "2" } },
        ],
      }),
    );

    const j = harness(["--json", f]);
    const doc = JSON.parse(j.logs.join("\n")) as {
      files: { warnings: { index: number; message: string }[] }[];
    };
    const dupes = doc.files[0].warnings.filter((w) => w.message.includes("duplicate userMessage"));
    expect(dupes).toHaveLength(1);
    expect(dupes[0].index).toBe(1);
    // The per-file pass already reported it, so the union pass must not
    // re-report it as a cross-file finding.
    expect(dupes[0].message).not.toContain("cross-file");
  });

  it("fails a run that loads no fixtures at all, like the server's abort", () => {
    const empty = write("empty.json", JSON.stringify({ fixtures: [] }));
    const r = harness([empty]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("No fixtures loaded from any input");

    const j = harness(["--json", empty]);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    expect(doc.run.fixtures).toBe(0);
    expect(doc.run.errors).toHaveLength(1);

    // An empty file alongside one that loads fixtures is an error in neither
    // place — the server only aborts when the whole run loaded nothing.
    mkdirSync(join(dir, "mix"));
    writeFileSync(join(dir, "mix", "empty.json"), JSON.stringify({ fixtures: [] }));
    writeFileSync(
      join(dir, "mix", "ok.json"),
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
      }),
    );
    expect(harness(["--strict", join(dir, "mix")]).code).toBe(0);
  });

  it("hands readdirSync's options through to the real implementation", () => {
    // The `node:fs` mock above exists only to reverse directory order; it must
    // otherwise be transparent. A wrapper that takes `(path)` alone silently
    // drops every option a caller passes, so `{ withFileTypes: true }` would
    // come back as plain strings and any code under test that relies on it
    // would be exercised against a shape the real fs never returns.
    writeFileSync(join(dir, "a.json"), "{}");
    const entries = readdirSync(dir, { withFileTypes: true });
    expect(entries).toHaveLength(1);
    expect(typeof entries[0]).toBe("object");
    expect(entries[0].name).toBe("a.json");
    expect(entries[0].isFile()).toBe(true);
    // And the bare form still returns names, so the reversal toggle keeps working.
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it("validates a path beginning with '-' after the -- terminator", () => {
    const f = write(
      "-weird.json",
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
      }),
    );

    // Without the terminator a leading-dash path is parsed as an option, and an
    // unknown option is a usage error (exit 1) — the file is never reached.
    const asOption = harness(["-weird.json"]);
    expect(asOption.code).toBe(1);
    // parseArgs reads a leading-dash argument as a short-option cluster, so the
    // option it names is "-w", not the whole path.
    expect(asOption.errors.join("\n")).toContain("Unknown option '-w'");

    // After the terminator the SAME argument is a path: it is now resolved
    // against the cwd, not rejected as an option. The name carries a unique
    // suffix rather than pinning the cwd — run from a directory that happens
    // to hold a readable "-weird.json" (the repo root after a stray write,
    // say) a bare relative path would validate cleanly and the assertion would
    // silently stop testing the terminator at all. `process.chdir` did that
    // job before, and it throws under vitest's `threads` pool, which made this
    // whole file unrunnable there.
    const absentRelative = `-weird-${process.pid}-${Date.now()}-absent.json`;
    const afterTerminator = harness(["--", absentRelative]);
    expect(afterTerminator.code).toBe(1);
    expect(afterTerminator.errors.join("\n")).toContain("Could not read");
    // Positive control for the pair: the same name WITHOUT the terminator is
    // still read as an option cluster, so the exit above is the terminator
    // doing its job and not merely a missing file by another route.
    expect(harness([absentRelative]).errors.join("\n")).toContain("Unknown option '-w'");

    const terminated = harness(["--", f]);
    expect(terminated.code).toBe(0);
    expect(terminated.logs.join("\n")).toContain(f + ": OK");

    // The terminator must not swallow options that precede it.
    const withOptions = harness(["--json", "--", f]);
    expect(withOptions.code).toBe(0);
    const doc = JSON.parse(withOptions.logs.join("\n")) as { files: { file: string }[] };
    expect(doc.files).toHaveLength(1);
  });

  it("validates a repeated path once per mention, like a repeated --fixtures", () => {
    // The server loads one set of fixtures per `--fixtures` it is given, so
    // `-f a.json -f a.json` loads a.json twice and `--validate-on-load` warns
    // "duplicate userMessage". De-duplicating the paths here would report a
    // clean run for inputs the server flags.
    const f = write(
      "dupe.json",
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
      }),
    );

    // Pinned to the last character, including the "— shadows ..." clause the
    // previous version of this test stopped short of: it asserted only that
    // SOME cross-file duplicate line was printed, which a line naming the
    // file as shadowing itself satisfies just as well as a correct one.
    const twice = harness([f, f]);
    expect(twice.code).toBe(0);
    expect(twice.logs).toEqual([
      `${f}[1]: OK (1 fixture(s))`,
      `${f}[2]: [warning] #0 cross-file: duplicate userMessage 'hi' — shadows fixture ${f}[1] #0`,
      `${f}[2]: 1 fixture(s), 0 error(s), 1 warning(s)`,
    ]);
    // No surface may name the path without saying WHICH load it means.
    expect(twice.logs.join("\n")).not.toContain(`${f}:`);
    expect(twice.logs.join("\n")).not.toContain(`shadows fixture ${f} #`);

    // A file named both directly and via its parent directory is two loads on
    // the server too, so it is two here.
    mkdirSync(join(dir, "pack2"));
    const inner = join(dir, "pack2", "c.json");
    writeFileSync(
      inner,
      JSON.stringify({
        fixtures: [{ match: { userMessage: "yo" }, response: { content: "hello" } }],
      }),
    );
    const both = harness([join(dir, "pack2"), inner]);
    expect(both.code).toBe(0);
    expect(both.logs).toEqual([
      `${inner}[1]: OK (1 fixture(s))`,
      `${inner}[2]: [warning] #0 cross-file: duplicate userMessage 'yo' — shadows fixture ${inner}[1] #0`,
      `${inner}[2]: 1 fixture(s), 0 error(s), 1 warning(s)`,
    ]);
  });

  it("routes the cause of a non-zero exit to stderr, keeping --json stdout pristine", () => {
    const f = write(
      "warnings.json",
      JSON.stringify({
        fixtures: [{ match: { userMessage: "yo" }, response: { content: "sup" }, replaySpeed: 0 }],
      }),
    );

    // Without --strict a warning is informational and exits 0, so it stays on stdout.
    const lenient = harness([f]);
    expect(lenient.code).toBe(0);
    expect(lenient.logs.join("\n")).toContain("[warning] #0");
    expect(lenient.errors).toHaveLength(0);

    // With --strict the SAME warning causes exit 1, so it must reach stderr.
    const strict = harness(["--strict", f]);
    expect(strict.code).toBe(1);
    expect(strict.errors.join("\n")).toContain("[warning] #0");
    expect(strict.logs.join("\n")).not.toContain("[warning] #0");

    // --json keeps stdout to the report alone and puts the reason on stderr.
    const asJson = harness(["--json", "--strict", f]);
    expect(asJson.code).toBe(1);
    const doc = JSON.parse(asJson.logs.join("\n")) as { failed: boolean };
    expect(doc.failed).toBe(true);
    expect(asJson.errors.join("\n")).toContain("fixture validation failed");
  });

  it("documents the unknown-option exit code in the help table", () => {
    const h = harness(["--help"]);
    expect(h.code).toBe(0);
    const help = h.logs.join("\n");
    // Usage errors share exit 1 with every other failure, so the help must not
    // advertise a code the binary never returns.
    expect(help).toMatch(/usage error\s*\n?\s*\(no paths given, or an unknown option\)/);
    expect(help).not.toMatch(/^\s*2\s{2}/m);
    expect(help).toContain("--                Stop option parsing");
  });

  it("dispatches via aimock validate and documents help", () => {
    const f = write(
      "ok2.json",
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
      }),
    );
    const logs: string[] = [];
    let code: number | null = null;
    runAimockCli({
      argv: ["validate", f],
      log: (m) => logs.push(m),
      logError: () => {},
      exit: (c) => {
        code = c;
      },
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("OK");

    const helpLogs: string[] = [];
    let helpCode: number | null = null;
    runAimockCli({
      argv: ["validate", "--help"],
      log: (m) => helpLogs.push(m),
      logError: () => {},
      exit: (c) => {
        helpCode = c;
      },
    });
    expect(helpCode).toBe(0);
    expect(helpLogs.join("\n")).toContain("aimock validate");
  });

  it("accepts -h as an alias for --help, exiting 0 without validating", () => {
    const f = writeFixtureFile("unused.json", "hi");
    const r = harness(["-h", f]);
    expect(r.code).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.logs.join("\n")).toContain("Usage: aimock validate");
    expect(r.logs.join("\n")).not.toContain("OK (");
  });
});

/**
 * Error containment: no filesystem condition and no malformed entry may crash
 * the run, abandon the remaining files, corrupt `--json` stdout, or exit 0.
 */
describe("aimock validate CLI — error containment", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimock-validate-err-"));
  });
  afterEach(() => {
    // Restore any 0o000 directory so the cleanup can descend into it.
    for (const name of ["unreadable", join("withbad", "locked")]) {
      try {
        chmodSync(join(dir, name), 0o755);
      } catch {
        /* not every test creates these */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  const GOOD = JSON.stringify({
    fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
  });

  // Running as root defeats the 0o000 permission cases entirely.
  const canTestPermissions = typeof process.getuid === "function" && process.getuid() !== 0;

  it("reports a malformed entry as a per-entry error instead of crashing", () => {
    for (const [name, body] of [
      ["empty-entry.json", JSON.stringify({ fixtures: [{}] })],
      ["null-entry.json", JSON.stringify({ fixtures: [null] })],
      ["no-match.json", JSON.stringify({ fixtures: [{ response: { content: "x" } }] })],
    ] as const) {
      const f = write(name, body);
      const r = harness([f]);
      expect(r.code).toBe(1);
      expect(r.errors.join("\n")).toContain(`${f}: [error] #0 Invalid fixture entry #0:`);
    }
  });

  it("keeps --json valid and entry indices honest when one entry is malformed", () => {
    const f = write(
      "mixed-entries.json",
      JSON.stringify({
        fixtures: [
          { match: { userMessage: "hi" }, response: { content: "hello" } },
          {},
          { match: { userMessage: "yo" }, response: { content: "sup" }, replaySpeed: 0 },
        ],
      }),
    );
    const r = harness(["--json", f]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.logs.join("\n")) as {
      failed: boolean;
      files: {
        fixtures: number;
        errors: { index: number; message: string }[];
        warnings: { index: number; message: string }[];
      }[];
    };
    expect(doc.failed).toBe(true);
    expect(doc.files[0].fixtures).toBe(2);
    expect(doc.files[0].errors).toHaveLength(1);
    expect(doc.files[0].errors[0].index).toBe(1);
    expect(doc.files[0].errors[0].message).toContain("Invalid fixture entry #1:");
    // Entry #2's warning must still be attributed to entry 2, not to the
    // converted-fixture slot 1 it occupies after the bad entry was dropped.
    expect(doc.files[0].warnings.map((w) => w.index)).toEqual([2]);
  });

  it("reports a stat failure on a top-level path instead of crashing", () => {
    // A symlink pointing at itself makes statSync throw ELOOP, which
    // `throwIfNoEntry: false` does not suppress.
    symlinkSync(join(dir, "loop"), join(dir, "loop"));
    const r = harness([join(dir, "loop")]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain(`${join(dir, "loop")}: [error] Could not stat:`);
  });

  it("breaks a symlink cycle inside a directory and reports it", () => {
    mkdirSync(join(dir, "cyc"));
    writeFileSync(join(dir, "cyc", "a.json"), GOOD);
    symlinkSync(join(dir, "cyc"), join(dir, "cyc", "self"));

    const r = harness([join(dir, "cyc")]);
    expect(r.code).toBe(1);
    expect(r.logs.join("\n")).toContain(join(dir, "cyc", "a.json") + ": OK");
    expect(r.errors.join("\n")).toContain("Symlink cycle detected");
    // The cycle must be reported once, not walked repeatedly until ELOOP.
    expect(r.errors.filter((e) => e.includes("Symlink cycle detected"))).toHaveLength(1);
  });

  it.skipIf(!canTestPermissions)(
    "fails instead of exiting 0 when a subdirectory is unreadable",
    () => {
      mkdirSync(join(dir, "withbad"));
      writeFileSync(join(dir, "withbad", "ok.json"), GOOD);
      mkdirSync(join(dir, "withbad", "locked"));
      writeFileSync(join(dir, "withbad", "locked", "a.json"), GOOD);
      chmodSync(join(dir, "withbad", "locked"), 0o000);

      const r = harness([join(dir, "withbad")]);
      expect(r.code).toBe(1);
      expect(r.logs.join("\n")).toContain(join(dir, "withbad", "ok.json") + ": OK");
      expect(r.errors.join("\n")).toContain(
        `${join(dir, "withbad", "locked")}: [error] Could not read directory:`,
      );
    },
  );

  it.skipIf(!canTestPermissions)("reports why a top-level directory is unreadable", () => {
    mkdirSync(join(dir, "unreadable"));
    writeFileSync(join(dir, "unreadable", "a.json"), GOOD);
    chmodSync(join(dir, "unreadable"), 0o000);

    const r = harness([join(dir, "unreadable")]);
    expect(r.code).toBe(1);
    const errs = r.errors.join("\n");
    expect(errs).toContain(`${join(dir, "unreadable")}: [error] Could not read directory:`);
    expect(errs).not.toContain("No .json fixture files found");

    const j = harness(["--json", join(dir, "unreadable")]);
    const doc = JSON.parse(j.logs.join("\n")) as {
      failed: boolean;
      files: { fatal?: string }[];
    };
    expect(doc.failed).toBe(true);
    expect(doc.files[0].fatal).toContain("Could not read directory:");
  });

  it("still exits 0 on a clean directory and names only the broken file", () => {
    mkdirSync(join(dir, "clean"));
    writeFileSync(join(dir, "clean", "a.json"), GOOD);
    expect(harness([join(dir, "clean")]).code).toBe(0);

    const good = write("good.json", GOOD);
    const bad = write("bad-entry.json", JSON.stringify({ fixtures: [{}] }));
    const r = harness([good, bad]);
    expect(r.code).toBe(1);
    const errs = r.errors.join("\n");
    expect(errs).toContain(bad);
    expect(errs).not.toContain(`${good}: [error]`);
  });

  it("routes logger.error into the report instead of the console", () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const logger = new CollectingLogger(
      (m) => warnings.push(m),
      (m) => errors.push(m),
    );
    logger.warn("a", 1);
    logger.error("b", 2);
    logger.info("c");
    logger.debug("d");
    // The `[aimock]` prefix is part of what the replaced sink writes, so it is
    // part of what the collecting one collects (see the byte-identity test at
    // the end of this file).
    expect(warnings).toEqual(["[aimock] a 1"]);
    expect(errors).toEqual(["[aimock] b 2"]);
  });
  // --- cross-file finding rendering and de-duplication (regression) ---

  it("keeps a fixture's own userMessage verbatim when it reads like an index", () => {
    mkdirSync(join(dir, "quote"));
    const a = join(dir, "quote", "a.json");
    const b = join(dir, "quote", "b.json");
    const um = "see fixture 3 below";
    writeFileSync(
      a,
      JSON.stringify({
        fixtures: [
          { match: { userMessage: "m0" }, response: { content: "x" } },
          { match: { userMessage: "m1" }, response: { content: "x" } },
          { match: { userMessage: "m2" }, response: { content: "x" } },
          { match: { userMessage: um }, response: { content: "x" } },
        ],
      }),
    );
    writeFileSync(
      b,
      JSON.stringify({ fixtures: [{ match: { userMessage: um }, response: { content: "y" } }] }),
    );

    const r = harness([join(dir, "quote")]);
    // The quoted text is the fixture's, not a rewritten index: grepping the
    // fixtures for the reported string has to find it.
    expect(r.logs.concat(r.errors)).toContain(
      `${b}: [warning] #0 cross-file: duplicate userMessage '${um}' — shadows fixture ${a} #3`,
    );
    expect(r.logs.join("\n")).not.toContain(`'see fixture ${a} #3 below'`);
  });

  it("remaps an index NAMED in a message past a dropped malformed entry", () => {
    const f = write(
      "skew.json",
      JSON.stringify({
        fixtures: [
          {},
          { match: { userMessage: "hi" }, response: { content: "1" } },
          { match: { userMessage: "hi" }, response: { content: "2" } },
        ],
      }),
    );

    const r = harness([f]);
    // Entry 0 is the malformed one, so the shadowed fixture is entry 1 — the
    // compacted-array index 0 would point at the entry that did not convert.
    expect(r.logs.concat(r.errors)).toContain(
      `${f}: [warning] #2 duplicate userMessage 'hi' — shadows fixture 1`,
    );
    expect(r.errors.join("\n")).toContain(`${f}: [error] #0 Invalid fixture entry #0:`);

    const doc = JSON.parse(harness(["--json", f]).logs.join("\n")) as JsonReport;
    const dupe = doc.files[0].warnings.find((w) => w.message.includes("duplicate userMessage"));
    expect(dupe?.message).toBe("duplicate userMessage 'hi' — shadows fixture 1");
  });

  it("names both ends of a cross-file catch-all instead of a dangling '+'", () => {
    mkdirSync(join(dir, "plus"));
    const a = join(dir, "plus", "a.json");
    const b = join(dir, "plus", "b.json");
    // The catch-all IS last in its own file, so only the union pass sees it.
    writeFileSync(a, JSON.stringify({ fixtures: [{ match: {}, response: { content: "any" } }] }));
    writeFileSync(
      b,
      JSON.stringify({ fixtures: [{ match: { userMessage: "hi" }, response: { content: "b" } }] }),
    );

    const r = harness([join(dir, "plus")]);
    expect(r.logs.concat(r.errors)).toContain(
      `${a}: [warning] #0 cross-file: empty match acts as catch-all but is not the last fixture — shadows ${b} #0`,
    );
    // "<file> #0+" reads as if the "+" belonged to the index.
    expect(r.logs.join("\n")).not.toContain(`${b} #0+`);
  });

  it("upgrades a per-file catch-all in place when its shadow reaches another file", () => {
    mkdirSync(join(dir, "both"));
    const a = join(dir, "both", "a.json");
    const b = join(dir, "both", "b.json");
    writeFileSync(
      a,
      JSON.stringify({
        fixtures: [
          { match: {}, response: { content: "any" } },
          { match: { userMessage: "z" }, response: { content: "1" } },
        ],
      }),
    );
    writeFileSync(
      b,
      JSON.stringify({ fixtures: [{ match: { userMessage: "hi" }, response: { content: "2" } }] }),
    );

    const doc = JSON.parse(harness(["--json", join(dir, "both")]).logs.join("\n")) as JsonReport;
    const aReport = doc.files.find((f) => f.file === a);
    // The per-file finding says "shadows fixtures 1+" — a.json-local, and it
    // understates the truth: the shadow reaches into b.json. The union pass
    // states that, so it REPLACES the wording. What it must not do is print a
    // second line about the same fixture and the same rule: the server logs
    // "Fixture 0: ... shadows fixtures 1+" exactly once for this tree, and
    // masking the digits (a previous scheme) dropped the fuller wording
    // instead of the weaker one.
    expect(aReport?.warnings.map((w) => w.message)).toEqual([
      `cross-file: empty match acts as catch-all but is not the last fixture — shadows every later fixture, from ${a} #1 through ${b} #0`,
    ]);
  });

  it("does not repeat a cross-file catch-all that adds nothing to the per-file one", () => {
    mkdirSync(join(dir, "tail"));
    const a = join(dir, "tail", "a.json");
    const b = join(dir, "tail", "b.json");
    const pair = (um: string): string =>
      JSON.stringify({
        fixtures: [
          { match: {}, response: { content: "any" } },
          { match: { userMessage: um }, response: { content: "1" } },
        ],
      });
    writeFileSync(a, pair("x"));
    writeFileSync(b, pair("y"));

    const doc = JSON.parse(harness(["--json", join(dir, "tail")]).logs.join("\n")) as JsonReport;
    // b.json is the LAST file: its catch-all shadows exactly what the
    // per-file pass already said, so the union adds nothing.
    expect(doc.files.find((f) => f.file === b)?.warnings.map((w) => w.message)).toEqual([
      "empty match acts as catch-all but is not the last fixture — shadows fixtures 1+",
    ]);
    // a.json's does reach into b.json, so its wording says so — still as one
    // finding, because one fixture breaking one rule is one finding.
    expect(doc.files.find((f) => f.file === a)?.warnings.map((w) => w.message)).toEqual([
      `cross-file: empty match acts as catch-all but is not the last fixture — shadows every later fixture, from ${a} #1 through ${b} #1`,
    ]);
  });
});
/**
 * The directory walk and what a path argument means. Every case here is a
 * shape the server's `loadFixturesFromDir` also meets, so each test pins the
 * CLI's verdict against what `--fixtures <same tree> --validate-on-load`
 * does with it — either mirroring it, or diverging in the one direction the
 * module docstring documents as stricter.
 */
describe("aimock validate CLI — directory walk and path identity", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimock-validate-walk-"));
  });
  afterEach(() => {
    // Restore any 0o000 directory so the cleanup can descend into it.
    try {
      chmodSync(join(dir, "ordered", "b-locked"), 0o755);
    } catch {
      /* not every test creates it */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const GOOD = JSON.stringify({
    fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
  });

  // `mkfifo` is POSIX-only; there is no node:fs call for it.
  const canTestFifo = process.platform !== "win32";

  it("follows an acyclic directory symlink instead of calling it a cycle", () => {
    // root/link -> root/sub is a DAG, not a cycle: the server walks both
    // spellings, loads x.json twice and warns about the duplicate. Reporting
    // "Symlink cycle detected" here failed the run on a tree that starts fine.
    mkdirSync(join(dir, "root", "sub"), { recursive: true });
    writeFileSync(join(dir, "root", "sub", "x.json"), GOOD);
    symlinkSync("sub", join(dir, "root", "link"));

    const r = harness([join(dir, "root")]);
    expect(r.code).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.logs.join("\n")).not.toContain("Symlink cycle");
    // Both spellings are validated, in walk order, and the duplicate the
    // server warns about is reported.
    expect(r.logs[0]).toBe(`${join(dir, "root", "link", "x.json")}: OK (1 fixture(s))`);
    expect(r.logs.join("\n")).toContain(join(dir, "root", "sub", "x.json"));
    expect(r.logs.join("\n")).toContain("cross-file: duplicate userMessage 'hi'");
  });

  it("still reports a directory symlink that closes a cycle, once", () => {
    // root/loop -> root IS a cycle. The server recurses through it until the
    // kernel returns ELOOP ~32 levels down; the docstring documents refusing
    // it as the stricter divergence.
    mkdirSync(join(dir, "cyc"));
    writeFileSync(join(dir, "cyc", "a.json"), GOOD);
    symlinkSync(join(dir, "cyc"), join(dir, "cyc", "loop"));

    const r = harness([join(dir, "cyc")]);
    expect(r.code).toBe(1);
    expect(r.logs.join("\n")).toContain(`${join(dir, "cyc", "a.json")}: OK`);
    expect(r.errors.filter((e) => e.includes("Symlink cycle detected"))).toHaveLength(1);
    expect(r.errors.join("\n")).toContain(`${join(dir, "cyc", "loop")}: [error] Symlink cycle`);
  });

  it("walks two sibling directories that symlink to one shared directory", () => {
    // Neither visit is an ancestor of the other, so neither is a cycle: a
    // visited-set guard would have failed the second one.
    mkdirSync(join(dir, "shared"));
    writeFileSync(join(dir, "shared", "s.json"), GOOD);
    mkdirSync(join(dir, "tree", "one"), { recursive: true });
    mkdirSync(join(dir, "tree", "two"), { recursive: true });
    symlinkSync(join(dir, "shared"), join(dir, "tree", "one", "l"));
    symlinkSync(join(dir, "shared"), join(dir, "tree", "two", "l"));

    const r = harness([join(dir, "tree")]);
    expect(r.errors.filter((e) => e.includes("Symlink cycle"))).toEqual([]);
    const all = r.logs.join("\n");
    expect(all).toContain(join(dir, "tree", "one", "l", "s.json"));
    expect(all).toContain(join(dir, "tree", "two", "l", "s.json"));
  });

  it.skipIf(!canTestFifo)("refuses a *.json FIFO instead of blocking on it forever", () => {
    // readFileSync on a writer-less FIFO never returns — on the server it
    // hangs startup, and here it hung the lint the docstring promises will
    // always emit a report. The stat guard turns it into a per-file error.
    mkdirSync(join(dir, "pipes"));
    writeFileSync(join(dir, "pipes", "a.json"), GOOD);
    execFileSync("mkfifo", [join(dir, "pipes", "pipe.json")]);

    const r = harness([join(dir, "pipes")]);
    expect(r.code).toBe(1);
    expect(r.logs.join("\n")).toContain(`${join(dir, "pipes", "a.json")}: OK`);
    expect(r.errors.join("\n")).toContain(
      `${join(dir, "pipes", "pipe.json")}: [error] Not a regular file`,
    );
  });

  it.skipIf(!canTestFifo)("refuses a FIFO named directly as a path argument", () => {
    execFileSync("mkfifo", [join(dir, "top.json")]);
    const r = harness([join(dir, "top.json")]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain(`${join(dir, "top.json")}: [error] Not a regular file`);
  });

  it.skipIf(!(typeof process.getuid === "function" && process.getuid() !== 0))(
    "reports a walk problem where it was reached, not after every file",
    () => {
      // b-locked sits between a-first and c-last, so appending walk problems
      // after all files put its error past c-last's report.
      mkdirSync(join(dir, "ordered", "a-first"), { recursive: true });
      writeFileSync(join(dir, "ordered", "a-first", "a.json"), GOOD);
      mkdirSync(join(dir, "ordered", "b-locked"));
      writeFileSync(join(dir, "ordered", "b-locked", "b.json"), GOOD);
      mkdirSync(join(dir, "ordered", "c-last"));
      writeFileSync(
        join(dir, "ordered", "c-last", "c.json"),
        JSON.stringify({
          fixtures: [{ match: { userMessage: "yo" }, response: { content: "x" } }],
        }),
      );
      chmodSync(join(dir, "ordered", "b-locked"), 0o000);

      const r = harness([join(dir, "ordered"), "--json"]);
      expect(r.code).toBe(1);
      const doc = JSON.parse(r.logs.join("\n")) as JsonReport;
      expect(doc.files.map((f) => f.file)).toEqual([
        join(dir, "ordered", "a-first", "a.json"),
        join(dir, "ordered", "b-locked"),
        join(dir, "ordered", "c-last", "c.json"),
      ]);
    },
  );

  it("reports a *.json path that vanished as unreadable, not as a duplicate", () => {
    // A path that cannot be realpath'd used to fall back to `resolve` for its
    // de-dup identity; nothing may swallow the real reason it failed.
    const missing = join(dir, "gone.json");
    const r = harness([missing]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain(`${missing}: [error] Could not read`);
  });
});

/**
 * Run-level containment and reporting: the cross-file union pass is contained
 * exactly like the per-file pass, findings name the entry they are about (and
 * only when they are about one), the run-level line neither duplicates nor
 * precedes a per-file cause, and every file gets its stdout summary line.
 */
describe("aimock validate CLI — run-level containment and reporting", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimock-validate-run-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  const GOOD = JSON.stringify({
    fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
  });

  // Converts cleanly (entryToFixture copies `streamingProfile` through
  // untouched) but makes validateFixtures dereference `null.ttft`, so it trips
  // BOTH validateFixtures passes — the per-file one and the union one.
  const CRASHER = JSON.stringify({
    fixtures: [
      {
        match: { userMessage: "hi" },
        response: { content: "hello" },
        streamingProfile: null,
      },
    ],
  });

  it("contains a crash in the cross-file pass as a run-level error, keeping --json valid", () => {
    const f = write("crasher.json", CRASHER);

    const r = harness([f]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("Cross-file validation failed:");

    const j = harness(["--json", f]);
    expect(j.code).toBe(1);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    expect(doc.failed).toBe(true);
    expect(doc.run.errors.some((e) => e.includes("Cross-file validation failed:"))).toBe(true);
  });

  it("files a validator crash at file level, not against entry #0", () => {
    const f = write("crasher.json", CRASHER);
    const j = harness(["--json", f]);
    const doc = JSON.parse(j.logs.join("\n")) as {
      files: { errors: { index?: number; message: string }[] }[];
    };
    const crash = doc.files[0].errors.find((e) => e.message.includes("Validation failed for this"));
    expect(crash).toBeDefined();
    expect(crash?.index).toBeUndefined();
    // ... and the human line carries no entry index either.
    const r = harness([f]);
    expect(r.errors.join("\n")).toContain(`${f}: [error] Validation failed for this file:`);
    expect(r.errors.join("\n")).not.toContain("[error] #0 ");
  });

  it("prints run-level errors after the per-file output they follow from", () => {
    const f = write("crasher.json", CRASHER);
    const r = harness([f]);
    const perFile = r.errors.findIndex((e) => e.startsWith(`${f}: [error]`));
    const runLevel = r.errors.findIndex((e) => e.startsWith("[error] Cross-file validation"));
    expect(perFile).toBeGreaterThanOrEqual(0);
    expect(runLevel).toBeGreaterThan(perFile);
  });

  it("explains a malformed entry instead of echoing the raw TypeError", () => {
    const f = write("bad-entry.json", JSON.stringify({ fixtures: [{}] }));
    const j = harness(["--json", f]);
    expect(j.code).toBe(1);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    const err = doc.files[0].errors[0];
    expect(err.index).toBe(0);
    expect(err.message).toContain("Invalid fixture entry #0:");
    expect(err.message).toContain('missing or non-object "match" and "response"');
    // The entry's shape is classified BEFORE the conversion runs, so there is
    // no raw TypeError to demote in the first place: the finding describes the
    // entry, and `detail` (which only ever carried that text) is absent.
    expect(err.message).not.toContain("Cannot read properties of");
    expect(err.detail).toBeUndefined();
  });

  it("names the actual shape problem for a non-object entry", () => {
    const f = write("scalar-entry.json", JSON.stringify({ fixtures: [42] }));
    const j = harness(["--json", f]);
    const doc = JSON.parse(j.logs.join("\n")) as {
      files: { errors: { message: string }[] }[];
    };
    expect(doc.files[0].errors[0].message).toContain("entry is a number, expected an object");
  });

  it("does not repeat a per-file cause as a run-level 'no fixtures loaded' error", () => {
    const f = write("broken.json", "{not json");
    const r = harness([f]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("Invalid JSON:");
    expect(r.errors.join("\n")).not.toContain("No fixtures loaded");

    const j = harness(["--json", f]);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    expect(doc.run.errors).toEqual([]);
  });

  it("still reports 'no fixtures loaded' when no file explained the emptiness", () => {
    const f = write("empty.json", JSON.stringify({ fixtures: [] }));
    const r = harness([f]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("No fixtures loaded from any input");
  });

  it("gives a fatal file a stdout summary line like every other file", () => {
    const bad = write("broken.json", "{not json");
    const good = write("good.json", GOOD);
    const r = harness([good, bad]);
    expect(r.code).toBe(1);
    expect(r.logs).toEqual([
      `${good}: OK (1 fixture(s))`,
      `${bad}: 0 fixture(s), 1 error(s), 0 warning(s)`,
    ]);
  });

  it("serialises object log arguments the way the server's logger does", () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const logger = new CollectingLogger(
      (m) => warnings.push(m),
      (m) => errors.push(m),
    );
    logger.warn("entry:", { a: 1, b: [2, 3] });
    logger.error("nested:", { outer: { inner: "v" } });
    expect(warnings[0]).not.toContain("[object Object]");
    expect(warnings[0]).toContain("a: 1");
    expect(warnings[0]).toContain("b: [ 2, 3 ]");
    expect(errors[0]).not.toContain("[object Object]");
    expect(errors[0]).toContain("inner: 'v'");
  });

  // Known malformed matches are rejected before conversion; valid siblings
  // still participate in rules using their original source indices.
  it.each([
    ["string", "nope", "a string"],
    ["number", 42, "a number"],
    ["array", [], "an array"],
    ["boolean", true, "a boolean"],
  ])("rejects a %s match without losing siblings or source indices", (_label, match, got) => {
    for (const invalidIndex of [0, 1, 2]) {
      const fixtures: { match: unknown; response: { content: string } }[] = [
        { match: { userMessage: "hi" }, response: { content: "a" } },
        { match: { userMessage: "hi" }, response: { content: "b" } },
      ];
      fixtures.splice(invalidIndex, 0, { match, response: { content: "bad" } });
      const f = write("malformed-match.json", JSON.stringify({ fixtures }));
      const validIndices = [0, 1, 2].filter((index) => index !== invalidIndex);
      const duplicate = `duplicate userMessage 'hi' — shadows fixture ${validIndices[0]}`;
      const expectedError = `Invalid fixture entry #${invalidIndex}: "match" is ${got}, expected an object`;

      // Exercise the installed entry point and real files, with no dist skip.
      for (const strict of [false, true]) {
        for (const json of [false, true]) {
          const args = [
            resolve("dist/aimock-cli.js"),
            "validate",
            ...(strict ? ["--strict"] : []),
            ...(json ? ["--json"] : []),
            f,
          ];
          const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15000 });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(1);
          const output = result.stdout + result.stderr;
          expect(output).toContain(expectedError.replaceAll('"', json ? '\\"' : '"'));
          expect(output).not.toContain("CATCH-ALL");
          expect(output).not.toContain("could not be converted");
          if (json) {
            const doc = JSON.parse(result.stdout) as JsonReport;
            expect(doc.files[0].fixtures).toBe(2);
            expect(doc.run.fixtures).toBe(2);
            expect(doc.files[0].errors).toEqual([
              { index: invalidIndex, message: expect.stringContaining(expectedError) },
            ]);
            expect(doc.files[0].warnings).toEqual([{ index: validIndices[1], message: duplicate }]);
          } else {
            expect(result.stdout).toContain("2 fixture(s), 1 error(s), 1 warning(s)");
            expect(output).toContain(`#${validIndices[1]} ${duplicate}`);
          }
        }
      }
    }
  });

  it("classifies every unconvertible entry shape by the entry, not by the throw", () => {
    const f = write(
      "shapes.json",
      '{"fixtures":[{}, null, 42, [], {"response":5}, {"match":null,"response":{"content":"c"}}]}',
    );
    const r = harness(["--json", f]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.logs.join("\n")) as JsonReport;
    expect(doc.files[0].errors.map((e) => e.message)).toEqual([
      expect.stringContaining('#0: missing or non-object "match" and "response"'),
      expect.stringContaining("#1: entry is null, expected an object"),
      expect.stringContaining("#2: entry is a number, expected an object"),
      expect.stringContaining("#3: entry is an array, expected an object"),
      expect.stringContaining('#4: missing or non-object "match" and "response"'),
      expect.stringContaining('#5: missing or non-object "match"'),
    ]);
    // `#5` has a good `response`, so the key list before the "—" names `match`
    // alone (the shape reminder after it always mentions both keys).
    expect(doc.files[0].errors[5].message.split("—")[0]).not.toContain('"response"');
    // None of them converted.
    expect(doc.files[0].fixtures).toBe(0);
  });

  it("leaves a bad `response` to the rules rather than reporting it twice", () => {
    const f = write(
      "bad-response.json",
      '{"fixtures":[{"match":{"userMessage":"x"},"response":"hi"}]}',
    );
    const r = harness(["--json", f]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.logs.join("\n")) as JsonReport;
    expect(doc.files[0].errors).toHaveLength(1);
    expect(doc.files[0].errors[0].message).toContain("response is not a recognized type");
  });

  it("prints the cause of an unexpected conversion failure in human mode too", () => {
    // Passes the shape classifier (object entry, object match, object
    // response) and still throws inside `normalizeResponse`.
    const f = write(
      "throwy.json",
      '{"fixtures":[{"match":{"userMessage":"x"},"response":{"content":"c","toolCalls":[null]}}]}',
    );

    const r = harness([f]);
    expect(r.code).toBe(1);
    const stderr = r.errors.join("\n");
    expect(stderr).toContain("could not be converted to a fixture");
    // The old message pointed at a field only `--json` has.
    expect(stderr).not.toContain('see "detail"');
    expect(stderr).toContain("    Cannot read properties of null (reading 'arguments')");

    // `--json` still carries it as structured `detail`, not folded into the
    // message, and the document still parses.
    const j = harness(["--json", f]);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    expect(doc.files[0].errors[0].detail).toContain("Cannot read properties of null");
    expect(doc.files[0].errors[0].message).not.toContain("Cannot read properties");
  });

  // --- Containment: an unresolvable index is raised, never dropped ---------
  //
  // `provenance` and `union` are pushed in lockstep, so an out-of-range
  // `fixtureIndex` from `validateFixtures` cannot happen today. It was handled
  // with a bare `continue`, which DROPPED the finding: an ERROR finding could
  // vanish and the run would exit 0, reporting a clean bill of health. The
  // only way to exercise that path is to make `validateFixtures` return such
  // an index, which is what the mock below is for.

  it("raises a cross-file finding whose fixture index resolves to nothing", () => {
    const a = write("a.json", GOOD);
    const b = write(
      "b.json",
      JSON.stringify({ fixtures: [{ match: { userMessage: "yo" }, response: { content: "y" } }] }),
    );
    validateFixturesControl.override = (fixtures, call) =>
      // Calls 1 and 2 are the per-file passes; call 3 is the union pass.
      call < 3
        ? []
        : [{ severity: "error" as const, fixtureIndex: fixtures.length + 7, message: "phantom" }];

    const r = harness(["--json", a, b]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.logs.join("\n")) as JsonReport;
    expect(doc.run.errors.join("\n")).toContain("Cross-file finding for an unknown fixture index");
    expect(doc.run.errors.join("\n")).toContain("phantom");
    expect(doc.failed).toBe(true);
  });

  it("raises a per-file finding whose fixture index maps to no entry", () => {
    const f = write("a.json", GOOD);
    validateFixturesControl.override = (_fixtures, call) =>
      call === 1
        ? [{ severity: "error" as const, fixtureIndex: 99, message: "phantom per-file" }]
        : [];

    const r = harness(["--json", f]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.logs.join("\n")) as JsonReport;
    expect(doc.run.errors.join("\n")).toContain("maps to no entry in this file");
    expect(doc.run.errors.join("\n")).toContain("99");
  });
});

/**
 * `validateFixtures` stand-in. `vi.mock` and `vi.hoisted` are hoisted above
 * every import by the vitest transform, so registering them here — at the end,
 * next to the only tests that use them — behaves exactly as it would at the
 * top of the file, and keeps this block self-contained.
 *
 * With `override` left null every call delegates to the real implementation,
 * so the rest of the suite is untouched. `call` is 1-based over the whole
 * process: `aimock validate` runs the rules once per file and then once over
 * the union, and the tests above select a pass by that number.
 */
const validateFixturesControl = vi.hoisted(() => ({
  calls: 0,
  override: null as
    | null
    | ((
        fixtures: unknown[],
        call: number,
      ) => { severity: "error" | "warning"; fixtureIndex: number; message: string }[]),
}));

vi.mock("../fixture-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fixture-loader.js")>();
  return {
    ...actual,
    validateFixtures: ((fixtures: Parameters<typeof actual.validateFixtures>[0]) => {
      validateFixturesControl.calls += 1;
      return (
        validateFixturesControl.override?.(fixtures, validateFixturesControl.calls) ??
        actual.validateFixtures(fixtures)
      );
    }) as typeof actual.validateFixtures,
  };
});

beforeEach(() => {
  validateFixturesControl.calls = 0;
  validateFixturesControl.override = null;
});

/**
 * A path mentioned more than once in one run. Each mention is a separate load
 * with its own findings, so each has to be NAMEABLE: without a mention number
 * every surface printed the same bare path, and a warning read as a fixture
 * shadowing itself. The counts here are pinned against the server, which is
 * the oracle this lint exists to predict: started with the same repeated
 * `--fixtures` and `--validate-on-load`, it logs one line per (fixture, rule)
 * — three duplicate-userMessage lines for a two-entry file loaded twice, not
 * four.
 */
describe("aimock validate CLI — repeated-path mention identity", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimock-validate-mention-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Two entries, the second shadowing the first: one finding per load in the
  // per-file pass, and one more once both loads are in the same array.
  const SELF_DUPE = JSON.stringify({
    fixtures: [
      { match: { userMessage: "hi" }, response: { content: "one" } },
      { match: { userMessage: "hi" }, response: { content: "two" } },
    ],
  });

  function writeSelfDupe(name: string): string {
    const p = join(dir, name);
    writeFileSync(p, SELF_DUPE);
    return p;
  }

  it("names every mention of a repeated file, in every human line", () => {
    const f = writeSelfDupe("f.json");
    const r = harness([f, f]);

    expect(r.code).toBe(0);
    expect(r.logs).toEqual([
      `${f}[1]: [warning] #1 duplicate userMessage 'hi' — shadows fixture 0`,
      `${f}[1]: 2 fixture(s), 0 error(s), 1 warning(s)`,
      `${f}[2]: [warning] #1 cross-file: duplicate userMessage 'hi' — shadows fixture ${f}[1] #0`,
      `${f}[2]: [warning] #0 cross-file: duplicate userMessage 'hi' — shadows fixture ${f}[1] #0`,
      `${f}[2]: 2 fixture(s), 0 error(s), 2 warning(s)`,
    ]);
    // Nothing — a finding, a summary line or a reference — may fall back to
    // the bare path, which names both loads at once.
    expect(r.logs.join("\n")).not.toContain(`${f}:`);
    expect(r.logs.join("\n")).not.toContain(`shadows fixture ${f} #`);
  });

  it("reports one duplicate per fixture, the count the server logs", () => {
    // `aimock --fixtures f.json --fixtures f.json --validate-on-load` logs
    // "Fixture 1/2/3: duplicate userMessage 'hi' — shadows fixture 0": three
    // lines, one per shadowed fixture in the four-fixture union. Reporting
    // the per-file pass and the union pass side by side gave four.
    const f = writeSelfDupe("f.json");
    const r = harness([f, f]);
    expect(r.logs.filter((l) => l.includes("[warning]"))).toHaveLength(3);

    // The same file reached twice through a directory argument is the same
    // three findings: what is repeated is the LOAD, not the spelling.
    mkdirSync(join(dir, "pack"));
    const inner = join(dir, "pack", "g.json");
    writeFileSync(inner, SELF_DUPE);
    const viaDir = harness([join(dir, "pack"), inner]);
    expect(viaDir.logs.filter((l) => l.includes("[warning]"))).toHaveLength(3);
    expect(viaDir.logs).toContain(
      `${inner}[2]: [warning] #0 cross-file: duplicate userMessage 'hi' — shadows fixture ${inner}[1] #0`,
    );
  });

  it("gives each --json files[] entry its own mention number", () => {
    const f = writeSelfDupe("f.json");
    const doc = JSON.parse(harness(["--json", f, f]).logs.join("\n")) as JsonReport;

    // Two entries for one path: identical but for `mention`, which is what a
    // consumer keying the report by file has to key on instead.
    expect(doc.files.map((e) => [e.file, e.mention])).toEqual([
      [f, 1],
      [f, 2],
    ]);
    expect(doc.files[0].warnings.map((w) => w.message)).toEqual([
      "duplicate userMessage 'hi' — shadows fixture 0",
    ]);
    expect(doc.files[1].warnings.map((w) => w.message)).toEqual([
      `cross-file: duplicate userMessage 'hi' — shadows fixture ${f}[1] #0`,
      `cross-file: duplicate userMessage 'hi' — shadows fixture ${f}[1] #0`,
    ]);
  });

  it("leaves a path loaded once unadorned, but still numbers it in --json", () => {
    // The suffix marks an ambiguity; a run with no repeated path has none, so
    // the human output is exactly what it always was. `mention` is reported
    // regardless, so a consumer never has to infer whether it was omitted.
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(
      a,
      JSON.stringify({ fixtures: [{ match: { userMessage: "hi" }, response: { content: "x" } }] }),
    );
    writeFileSync(
      b,
      JSON.stringify({ fixtures: [{ match: { userMessage: "yo" }, response: { content: "y" } }] }),
    );

    const r = harness([a, b]);
    expect(r.code).toBe(0);
    expect(r.logs).toEqual([`${a}: OK (1 fixture(s))`, `${b}: OK (1 fixture(s))`]);

    const doc = JSON.parse(harness(["--json", a, b]).logs.join("\n")) as JsonReport;
    expect(doc.files.map((e) => e.mention)).toEqual([1, 1]);
  });

  it("numbers the mentions of an unreadable repeated path too", () => {
    // A fatal file is reported through the same surfaces, so it needs the same
    // identity: two lines reading "<path>: [error] Invalid JSON" say nothing
    // about there being two loads of it.
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");

    const r = harness([bad, bad]);
    expect(r.code).toBe(1);
    expect(r.errors).toEqual([
      expect.stringContaining(`${bad}[1]: [error] Invalid JSON:`) as unknown as string,
      expect.stringContaining(`${bad}[2]: [error] Invalid JSON:`) as unknown as string,
    ]);
    expect(r.logs).toEqual([
      `${bad}[1]: 0 fixture(s), 1 error(s), 0 warning(s)`,
      `${bad}[2]: 0 fixture(s), 1 error(s), 0 warning(s)`,
    ]);

    const doc = JSON.parse(harness(["--json", bad, bad]).logs.join("\n")) as JsonReport;
    expect(doc.files.map((e) => e.mention)).toEqual([1, 2]);
  });

  it("numbers a repeated file whose two mentions are spelled differently", () => {
    // The walk hands back a `join`-normalised path while a named argument is
    // kept as typed, so `validate ./d ./d/a.json` used to be two spellings of
    // one load with no `[n]` on either. Identity is the resolved path; the
    // DISPLAYED path stays as the user spelled it.
    mkdirSync(join(dir, "pack"));
    const inner = join(dir, "pack", "a.json");
    writeFileSync(inner, SELF_DUPE);
    const spelled = `${dir}/pack/./a.json`;

    const r = harness([join(dir, "pack"), spelled]);
    expect(r.code).toBe(0);
    expect(r.logs).toEqual([
      `${inner}[1]: [warning] #1 duplicate userMessage 'hi' — shadows fixture 0`,
      `${inner}[1]: 2 fixture(s), 0 error(s), 1 warning(s)`,
      `${spelled}[2]: [warning] #1 cross-file: duplicate userMessage 'hi' — shadows fixture ${inner}[1] #0`,
      `${spelled}[2]: [warning] #0 cross-file: duplicate userMessage 'hi' — shadows fixture ${inner}[1] #0`,
      `${spelled}[2]: 2 fixture(s), 0 error(s), 2 warning(s)`,
    ]);

    const doc = JSON.parse(
      harness(["--json", join(dir, "pack"), spelled]).logs.join("\n"),
    ) as JsonReport;
    expect(doc.files.map((e) => [e.file, e.mention])).toEqual([
      [inner, 1],
      [spelled, 2],
    ]);
  });

  it("does not treat two different files that share a basename as one mention", () => {
    // Identity is the resolved path, not the basename: `pack/a.json` and
    // `other/a.json` are two loads of two files, each mentioned once.
    mkdirSync(join(dir, "pack"));
    mkdirSync(join(dir, "other"));
    const one = join(dir, "pack", "a.json");
    const two = join(dir, "other", "a.json");
    writeFileSync(one, SELF_DUPE);
    writeFileSync(two, SELF_DUPE);

    const r = harness([one, two]);
    expect(r.logs.join("\n")).not.toMatch(/\[\d+\]/);
    const doc = JSON.parse(harness(["--json", one, two]).logs.join("\n")) as JsonReport;
    expect(doc.files.map((e) => [e.file, e.mention])).toEqual([
      [one, 1],
      [two, 1],
    ]);
  });
});

/**
 * Report-mode consistency: the human lines and the `--json` document describe
 * the SAME run. Each test below pins a place where they disagreed — a fatal
 * file counted on stdout but absent from `files[].errors`, an `OK` line on a
 * run that exited 1, a failure summary that led with counts of things that did
 * not happen, an empty `--json` stdout, a collected diagnostic that did not
 * match what the server prints, and a remote path reported as a missing file.
 */
describe("aimock validate CLI — report-mode consistency", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimock-validate-modes-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  const DUPES = JSON.stringify({
    fixtures: [
      { match: { userMessage: "hi" }, response: { content: "a" } },
      { match: { userMessage: "hi" }, response: { content: "b" } },
    ],
  });

  it("counts a fatal file's reason in --json errors, exactly as stdout tallies it", () => {
    const f = write("broken.json", "{not json");

    const r = harness([f]);
    expect(r.code).toBe(1);
    expect(r.logs).toEqual([`${f}: 0 fixture(s), 1 error(s), 0 warning(s)`]);

    const j = harness(["--json", f]);
    expect(j.code).toBe(1);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    // One record, two renderings: the JSON error count must equal the count
    // the human summary line printed, and say the same thing `fatal` says.
    expect(doc.files[0].errors).toHaveLength(1);
    expect(doc.files[0].errors[0].message).toBe(doc.files[0].fatal);
    // A file-level finding still names no entry.
    expect(doc.files[0].errors[0].index).toBeUndefined();
    // ... and the stderr line is unchanged.
    expect(r.errors.join("\n")).toContain(`${f}: [error] Invalid JSON:`);
  });

  it("does not print OK for a file on a run that failed for loading no fixtures", () => {
    const f = write("empty-OK.json", JSON.stringify({ fixtures: [] }));
    const r = harness([f]);
    expect(r.code).toBe(1);
    expect(r.logs.join("\n")).not.toContain(`${f}: OK`);
    expect(r.logs).toEqual([`${f}: 0 fixture(s), loaded nothing — see the run-level error`]);
    expect(r.errors.join("\n")).toContain("No fixtures loaded from any input");
  });

  it("still prints OK for a clean file when another file failed the run", () => {
    const good = write(
      "good.json",
      JSON.stringify({ fixtures: [{ match: { userMessage: "hi" }, response: { content: "x" } }] }),
    );
    const bad = write("broken.json", "{not json");
    const r = harness([good, bad]);
    expect(r.code).toBe(1);
    expect(r.logs[0]).toBe(`${good}: OK (1 fixture(s))`);
  });

  it("leads the failure summary with the failing thing, not with zero counts", () => {
    const f = write("dupes.json", DUPES);
    const j = harness(["--json", "--strict", f]);
    expect(j.code).toBe(1);
    const summary = j.errors.join("\n");
    expect(summary).toContain(
      "Error: fixture validation failed — " + f + ": #1 duplicate userMessage",
    );
    expect(summary).not.toContain("0 unreadable/invalid file(s)");
    expect(summary).not.toContain("0 file(s) with errors");
    expect(summary).toContain("[1 file(s) with warnings (--strict)]");
  });

  it("names the fatal file first when one failed fatally", () => {
    const bad = write("broken.json", "{not json");
    const j = harness(["--json", bad]);
    expect(j.errors.join("\n")).toContain(
      `Error: fixture validation failed — ${bad}: Invalid JSON:`,
    );
  });

  it("names the repeated file by its mention in the failure summary, not bare", () => {
    const f = write("dupes.json", DUPES);
    const j = harness(["--json", "--strict", f, f]);
    expect(j.code).toBe(1);
    const summary = j.errors.join("\n");
    // The bare path names BOTH loads at once, so the lead would read as the
    // file shadowing itself — the exact misreading the mention numbers exist
    // to prevent.
    expect(summary).toContain(`Error: fixture validation failed — ${f}[1]: #1 duplicate`);
    expect(summary).not.toContain(`failed — ${f}: `);
  });

  it("names the repeated file by its mention when the lead is a fatal one", () => {
    const bad = write("broken.json", "{not json");
    const j = harness(["--json", bad, bad]);
    expect(j.code).toBe(1);
    const summary = j.errors.join("\n");
    expect(summary).toContain(`Error: fixture validation failed — ${bad}[1]: Invalid JSON:`);
    expect(summary).not.toContain(`failed — ${bad}: `);
  });

  it("does not print OK for a zero-fixture file when another file failed the run", () => {
    const empty = write("empty-OK.json", JSON.stringify({ fixtures: [] }));
    const bad = write("broken.json", "{not json");
    const r = harness([empty, bad]);
    expect(r.code).toBe(1);
    expect(r.logs[0]).toBe(`${empty}: 0 fixture(s), loaded nothing — the run failed elsewhere`);
    expect(r.logs.join("\n")).not.toContain(`${empty}: OK`);
  });

  it("emits a JSON document on stdout for a usage error, not an empty buffer", () => {
    const noPaths = harness(["--json"]);
    expect(noPaths.code).toBe(1);
    expect(noPaths.logs.join("\n").length).toBeGreaterThan(0);
    const doc = JSON.parse(noPaths.logs.join("\n")) as JsonReport;
    expect(doc.failed).toBe(true);
    expect(doc.files).toEqual([]);
    expect(doc.run.fixtures).toBe(0);
    expect(doc.run.errors.join(" ")).toContain("no fixture paths given");
    // The human-readable reason and the help text stay on stderr, so stdout is
    // still the document alone.
    expect(noPaths.errors.join("\n")).toContain("Error: no fixture paths given.");
    expect(noPaths.logs.join("\n")).not.toContain("Usage: aimock validate");
  });

  it("emits the usage document for an unknown option too, echoing --strict", () => {
    const f = write("dupes.json", DUPES);
    const r = harness(["--json", "--strict", "--bogus", f]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.logs.join("\n")) as JsonReport;
    expect(doc.strict).toBe(true);
    expect(doc.run.errors.join(" ")).toContain("Unknown option '--bogus'");
  });

  it("emits the usage document for --json=true, whose value IS the usage error", () => {
    // `--json` is a boolean option, so `--json=true` is a parseArgs throw — and
    // the argv that most obviously asked for JSON must not be the one that
    // hands a stdout-parsing consumer an empty buffer.
    const f = write("dupes.json", DUPES);
    const r = harness([`--json=true`, f]);
    expect(r.code).toBe(1);
    expect(r.logs.join("\n").length).toBeGreaterThan(0);
    const doc = JSON.parse(r.logs.join("\n")) as JsonReport;
    expect(doc.failed).toBe(true);
    expect(doc.files).toEqual([]);
    expect(doc.run.errors.join(" ")).toContain("Option '--json' does not take an argument");
    expect(r.logs.join("\n")).not.toContain("Usage: aimock validate");
  });

  it("keeps --json --help to one JSON document on stdout", () => {
    const r = harness(["--json", "--help"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.logs.join("\n")) as { help: string };
    expect(Object.keys(doc)).toEqual(["help"]);
    expect(doc.help).toContain("Usage: aimock validate");
    expect(doc.help).toContain("--json            Emit a JSON report");
    // Without --json the same request still prints the plain help text.
    const plain = harness(["--help"]);
    expect(plain.code).toBe(0);
    expect(plain.logs.join("\n")).toBe(doc.help);
  });

  it("keeps a usage error human-only when --json was not asked for", () => {
    expect(harness([]).logs).toEqual([]);
    // `--json` AFTER the terminator is a path, not a flag, so it selects no
    // JSON output — and is itself the (missing) path the run then reports.
    const afterTerminator = harness(["--", "--json"]);
    expect(afterTerminator.logs.join("\n")).not.toContain('"failed"');
  });

  it("collects a diagnostic byte-for-byte as the console sink would print it", () => {
    const collected: string[] = [];
    const logger = new CollectingLogger(
      (m) => collected.push(m),
      (m) => collected.push(m),
    );
    // A message carrying a printf specifier is the case that separates the two
    // serialisations: the real sink passes "[aimock]" as console's format
    // string, so the caller's own "%s" is inert and its arguments are appended.
    const args = ["Could not read file %s.json:", "detail"];

    const printed: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      printed.push(format(...a));
    });
    new Logger("warn").warn(...args);
    spy.mockRestore();

    logger.warn(...args);
    expect(collected[0]).toBe(printed[0]);
    expect(collected[0]).toBe("[aimock] Could not read file %s.json: detail");
    // The argument was NOT consumed by a substitution, and the prefix is there.
    expect(collected[0]).toContain("%s");
    expect(collected[0].startsWith("[aimock] ")).toBe(true);
  });

  it("refuses a remote path as unsupported instead of reporting a missing file", () => {
    const url = "https://example.com/fixtures.json";
    const r = harness([url]);
    expect(r.code).toBe(1);
    const errs = r.errors.join("\n");
    expect(errs).toContain("local paths only");
    expect(errs).not.toContain("ENOENT");
    const j = harness(["--json", url]);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    expect(doc.files[0].fatal).toContain("Remote fixture source");
    expect(doc.files[0].errors[0].message).toBe(doc.files[0].fatal);
  });

  it("reads a path with a colon in it as a path, not as a remote source", () => {
    const f = write("odd:name.json", JSON.stringify({ fixtures: [] }));
    const j = harness(["--json", f]);
    const doc = JSON.parse(j.logs.join("\n")) as JsonReport;
    expect(doc.files[0].fatal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A walked directory is not a fixture directory.
// ---------------------------------------------------------------------------

describe("aimock validate: non-fixture JSON found by the walk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimock-validate-skip-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  const fixtureDoc = JSON.stringify({
    fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
  });
  // An aimock CONFIG file, the shape that sits beside fixtures in this
  // package's own `fixtures/` tree.
  const configDoc = JSON.stringify({ port: 4010, llm: { fixtures: "./fixtures" } });

  it("skips it with a note instead of failing the run", () => {
    write("good.json", fixtureDoc);
    write("aimock-config.json", configDoc);

    const r = harness([dir]);
    expect(r.code).toBe(0);
    expect(r.errors).toEqual([]);
    const out = r.logs.join("\n");
    expect(out).toContain("aimock-config.json: skipped (not a fixture file");
    expect(out).toContain("good.json: OK (1 fixture(s))");
  });

  it("still validates a non-fixture file the caller NAMES", () => {
    // Naming a file is asking about that file, so the skip does not apply and
    // the wrong-shape error the lint exists to give is still given.
    const cfg = write("aimock-config.json", configDoc);
    const r = harness([cfg]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain('Missing or invalid "fixtures" array');
  });

  it("reports the skip in the --json document, with no findings against it", () => {
    write("good.json", fixtureDoc);
    const cfg = write("aimock-config.json", configDoc);

    const r = harness(["--json", dir]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.logs.join("\n")) as JsonReport;
    const skipped = doc.files.find((f) => f.file === cfg);
    expect(skipped).toBeDefined();
    expect(skipped!.skipped).toContain("an aimock config file (llm)");
    expect(skipped!.errors).toEqual([]);
    expect(skipped!.warnings).toEqual([]);
    expect(skipped!.fixtures).toBe(0);
    expect(doc.run.fixtures).toBe(1);
  });

  it("does NOT skip a walked file that is unparseable — that is a real defect", () => {
    write("good.json", fixtureDoc);
    write("broken.json", "{ not json");

    const r = harness([dir]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("Invalid JSON");
    expect(r.logs.join("\n")).not.toContain("broken.json: skipped");
  });

  it("does not let a skip hide a directory that yields no fixtures at all", () => {
    write("aimock-config.json", configDoc);
    const r = harness([dir]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("No fixtures loaded from any input");
  });

  it("validates this package's own shipped fixtures/ directory, as the README documents", () => {
    // `aimock validate ./fixtures/` is a documented example and exited 1 on the
    // package's own tree, because `fixtures/examples/` ships eight aimock
    // config files alongside the fixtures.
    const shipped = resolve(__dirname, "../../fixtures");
    const r = harness([shipped]);
    expect(r.code).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.logs.join("\n")).toContain("full-suite.json: skipped (not a fixture file");
  });

  it("names an AG-UI config for what it is rather than saying it holds no fixtures", () => {
    // `fixtures/examples/agui/agui-text-response.json` is an aimock config
    // whose AG-UI fixtures nest under `agui`, where the fixture loader does
    // not look: `llmock --fixtures <it> --validate-on-load` warns "Missing or
    // invalid \"fixtures\" array" and loads nothing, while `aimock --config
    // <it>` starts a server and mounts AGUIMock. The walk skips it for parity
    // with the first, and must not describe it as a file with no fixtures.
    write("good.json", fixtureDoc);
    const agui = write(
      "agui-text-response.json",
      JSON.stringify({ agui: { fixtures: [{ match: { message: "hello" }, text: "hi" }] } }),
    );

    const r = harness([dir]);
    expect(r.code).toBe(0);
    const line = r.logs
      .join("\n")
      .split("\n")
      .find((l) => l.includes("agui-text-response.json"))!;
    expect(line).toContain("skipped (not a fixture file — an aimock config file (agui)");
    expect(line).not.toContain('no top-level "fixtures" key');
    expect(harness([agui]).code).toBe(1);
  });

  it("tells a caller who NAMES an aimock config which shape it actually has", () => {
    const agui = write(
      "agui-text-response.json",
      JSON.stringify({ agui: { fixtures: [{ match: { message: "hello" }, text: "hi" }] } }),
    );
    const r = harness([agui]);
    // Still fatal — `--fixtures` loads nothing from it either — but the reason
    // now says what the file is instead of only what it lacks.
    expect(r.code).toBe(1);
    const errs = r.errors.join("\n");
    expect(errs).toContain('Missing or invalid "fixtures" array');
    expect(errs).toContain('this is an aimock config file (agui), which "aimock --config" serves');
  });

  it("does NOT skip a walked file whose `fixtures` key is present but not an array", () => {
    // `{"fixtures": {}}` is a fixture file that is malformed, not a non-fixture
    // file: the key is there, so the skip does not apply and the walk fails it
    // the way the same file fails when named.
    write("good.json", fixtureDoc);
    const obj = write("obj.json", JSON.stringify({ fixtures: {} }));
    const nul = write("nul.json", JSON.stringify({ fixtures: null }));
    write("plain.json", JSON.stringify({ a: 1 }));

    const r = harness([dir]);
    expect(r.code).toBe(1);
    const logs = r.logs.join("\n");
    expect(logs).not.toContain("obj.json: skipped");
    expect(logs).not.toContain("nul.json: skipped");
    expect(logs).toContain('plain.json: skipped (not a fixture file — no top-level "fixtures" key');
    const errs = r.errors.join("\n");
    for (const p of [obj, nul]) {
      expect(errs).toContain(`${p}: [error] Missing or invalid "fixtures" array`);
      // Same failure the named form prints.
      expect(harness([p]).errors.join("\n")).toContain(
        `${p}: [error] Missing or invalid "fixtures" array`,
      );
    }
    expect(harness(["--strict", dir]).code).toBe(1);
  });

  it("lists a walked present-but-non-array `fixtures` file under files in --json", () => {
    write("good.json", fixtureDoc);
    const obj = write("obj.json", JSON.stringify({ fixtures: {} }));
    const nul = write("nul.json", JSON.stringify({ fixtures: null }));

    const r = harness(["--json", dir]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.logs.join("\n")) as JsonReport;
    for (const p of [obj, nul]) {
      const entry = doc.files.find((f) => f.file === p);
      expect(entry).toBeDefined();
      expect(entry!.skipped).toBeUndefined();
      expect(entry!.fatal).toContain('Missing or invalid "fixtures" array');
    }
  });
});
