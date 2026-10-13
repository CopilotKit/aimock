/// <reference types="node" />

/**
 * Write (or rewrite) golden corpus files. This is the ONLY way goldens are
 * written: it runs vitest with `GOLDEN_WRITE=1` and `GOLDEN_CAPTURE_RUN=1`,
 * which make `expectGolden` (src/__tests__/golden/harness.ts) write each
 * case's file instead of comparing against it. A plain `pnpm test` never
 * writes, and a missing golden fails there. The script refuses to run when
 * `CI` is truthy.
 *
 *   pnpm golden:capture                                   # whole corpus
 *   pnpm golden:capture src/__tests__/golden/models.golden.test.ts
 *   pnpm golden:capture -t "chat stream"                  # whole corpus, filtered
 *
 * Path arguments (existing files or directories) replace the default targets.
 * The default targets are every test file under src/__tests__ that imports the
 * golden harness, found by reading the imports, and are printed before the run.
 * Flags (and their values) pass to `vitest run` unchanged.
 *
 * The harness appends each golden path it writes to the file named by
 * `GOLDEN_WRITE_LOG`. A path written twice in one run (two cases with the
 * same golden) fails the run. After a whole-corpus run (no path arguments, no
 * flags at all, and no `.only`/`.skip`-style modifiers in the targets), every
 * `<suite>/<case>.json` under src/__tests__/golden/__snapshots__ that was not
 * written is an orphan (a renamed or removed case); the script lists them and
 * exits non-zero. Any other run is partial and skips orphan detection. Review
 * every written file by eye (`git diff -- src/__tests__/golden/__snapshots__`)
 * before committing.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const TESTS_DIR = join("src", "__tests__");
const HARNESS = join(TESTS_DIR, "golden", "harness.ts");
const SNAPSHOT_ROOT = join(TESTS_DIR, "golden", "__snapshots__");

/** vitest flags whose value is the next argument (when not given as `--flag=value`). */
const VALUE_FLAGS = new Set([
  "-t",
  "--testNamePattern",
  "--reporter",
  "--outputFile",
  "--project",
  "-c",
  "--config",
  "-r",
  "--root",
  "--dir",
  "--exclude",
  "--shard",
  "--bail",
  "--retry",
  "--pool",
  "--maxWorkers",
  "--minWorkers",
  "--testTimeout",
  "--hookTimeout",
  "--environment",
  "--mode",
  "--sequence.seed",
]);

/** vitest flags with an optional value: the next argument, unless it is another flag. */
const OPTIONAL_VALUE_FLAGS = new Set(["--changed"]);

export interface SplitArgs {
  paths: string[];
  flags: string[];
}

/** CI-style truthiness: unset, "", "0" and "false" are false. */
export function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

/** `--test-name-pattern` -> `--testNamePattern`; vitest accepts both spellings. */
function canonicalFlag(flag: string): string {
  if (!flag.startsWith("--")) return flag;
  return "--" + flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Separate path arguments from vitest flags. A positional is a flag value when
 * it follows a value-taking flag; otherwise it must name an existing file or
 * directory, because a bare vitest filter would widen the default targets.
 */
export function splitArgs(
  args: string[],
  exists: (p: string) => boolean = (p) => existsSync(p),
): SplitArgs {
  const paths: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      flags.push(arg);
      if (arg.includes("=") || i + 1 >= args.length) continue;
      const name = canonicalFlag(arg);
      if (VALUE_FLAGS.has(name)) {
        flags.push(args[++i]);
      } else if (OPTIONAL_VALUE_FLAGS.has(name) && !args[i + 1].startsWith("-")) {
        flags.push(args[++i]);
      }
      continue;
    }
    if (!exists(arg)) {
      throw new Error(
        `"${arg}" is not an existing file or directory; pass test files or directories, ` +
          `and vitest options as flags (e.g. -t "name")`,
      );
    }
    paths.push(arg);
  }
  return { paths, flags };
}

/**
 * True when the run captures the whole corpus, so orphan detection is valid.
 * That is only the case with no path arguments and no flags at all: many
 * vitest flags (`--exclude`, `--config`, `--changed`, `-t`, ...) narrow the
 * run, so any flag makes it partial rather than guessing which ones do.
 */
export function isFullCorpusRun({ paths, flags }: SplitArgs): boolean {
  return paths.length === 0 && flags.length === 0;
}

/** `it.only(`, `describe.skip(`, `test.skipIf(`, ...: modifiers that narrow a file's cases. */
const MODIFIER_RE =
  /\b(?:it|test|describe|suite|bench)(?:\.(?:concurrent|sequential|each))*\.(?:only|skip|skipIf|runIf|todo)\b/;

/** Root-relative targets whose source uses a test modifier that skips or focuses cases. */
export function findNarrowingModifiers(root: string, targets: string[]): string[] {
  return targets.filter((t) => {
    const file = resolve(root, t);
    if (!existsSync(file) || !statSync(file).isFile()) return false;
    return MODIFIER_RE.test(readFileSync(file, "utf8"));
  });
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Static `import ... from` / `export ... from` statements that start a line. */
const IMPORT_RE = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm;

/**
 * Every `*.test.ts` under `<root>/src/__tests__` that imports the golden
 * harness, as sorted root-relative paths with forward slashes.
 */
export function discoverGoldenTargets(root: string): string[] {
  const harness = resolve(root, HARNESS);
  const targets: string[] = [];
  for (const file of walk(join(root, TESTS_DIR))) {
    if (!file.endsWith(".test.ts")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      if (resolve(dirname(file), spec.replace(/\.js$/, ".ts")) === harness) {
        targets.push(relative(root, file).split(sep).join("/"));
        break;
      }
    }
  }
  return targets.sort();
}

function writeLogLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((p) => p !== "")
    .map((p) => resolve(p));
}

/** The set of absolute paths in a write log (one per line). */
export function parseWriteLog(text: string): Set<string> {
  return new Set(writeLogLines(text));
}

/**
 * Sorted absolute paths that appear more than once in a write log: two cases
 * that resolve to the same golden, so the last writer silently won.
 */
export function findDuplicateWrites(text: string): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const p of writeLogLines(text)) {
    if (seen.has(p)) dups.add(p);
    seen.add(p);
  }
  return [...dups].sort();
}

/**
 * Sorted absolute paths of goldens under `snapshotRoot` that are not in
 * `written`. Only `<suite>/.../<case>.json` files count as goldens, so files
 * such as `.DS_Store` or `.gitkeep` are never reported.
 */
export function findOrphanGoldens(snapshotRoot: string, written: Set<string>): string[] {
  const rootDir = resolve(snapshotRoot);
  return walk(rootDir)
    .filter((f) => {
      const parts = relative(rootDir, f).split(sep);
      const name = parts[parts.length - 1];
      return parts.length >= 2 && name.endsWith(".json") && !name.startsWith(".");
    })
    .filter((f) => !written.has(f))
    .sort();
}

export interface Outcome {
  code: number;
  message?: string;
}

/** Map a spawnSync result to the script's exit code and an optional error message. */
export function outcomeOf(result: {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}): Outcome {
  if (result.error) return { code: 1, message: `could not run vitest: ${result.error.message}` };
  if (result.signal) return { code: 1, message: `vitest was killed by signal ${result.signal}` };
  if (result.status === null) return { code: 1, message: "vitest exited with no status" };
  if (result.status !== 0) {
    return { code: result.status, message: `vitest exited with status ${result.status}` };
  }
  return { code: 0 };
}

/** Absolute path of vitest's JS entry (its `bin`) in `<root>/node_modules`. */
export function resolveVitestEntry(root: string): string {
  const pkgDir = join(root, "node_modules", "vitest");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
  if (!bin) throw new Error(`no vitest bin in ${join(pkgDir, "package.json")}`);
  return resolve(pkgDir, bin);
}

/**
 * How to spawn vitest: run its JS entry with the current Node binary. No shell
 * is involved on any platform (on win32, `pnpm` is a `.cmd` shim that only a
 * shell can run, and cmd.exe quoting cannot pass every argument through
 * intact), so each argument reaches vitest exactly as given.
 */
export function vitestInvocation(
  execPath: string,
  vitestEntry: string,
  args: string[],
): { command: string; args: string[]; shell: false } {
  return { command: execPath, args: [vitestEntry, ...args], shell: false };
}

/** True when `argv1` names `moduleUrl`'s file, after resolving symlinks on both. */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

function fail(message: string): number {
  console.error(`capture-golden: ${message}`);
  return 1;
}

function main(): number {
  if (isTruthyEnv(process.env.CI)) {
    return fail("refusing to write goldens with CI set; capture locally and commit the files");
  }
  process.chdir(REPO_ROOT);

  let split: SplitArgs;
  try {
    split = splitArgs(process.argv.slice(2));
  } catch (err) {
    return fail((err as Error).message);
  }
  const targets = split.paths.length > 0 ? split.paths : discoverGoldenTargets(REPO_ROOT);
  if (targets.length === 0) return fail(`no test file imports ${HARNESS}`);
  console.log(`capture-golden: targets:\n${targets.map((t) => `  ${t}`).join("\n")}`);

  let partialReason: string | undefined;
  if (!isFullCorpusRun(split)) {
    partialReason = "path arguments or vitest flags were given";
  } else {
    const narrowed = findNarrowingModifiers(REPO_ROOT, targets);
    if (narrowed.length > 0) {
      partialReason = `.only/.skip/.todo-style modifiers in ${narrowed.join(", ")}`;
    }
  }

  let vitestEntry: string;
  try {
    vitestEntry = resolveVitestEntry(REPO_ROOT);
  } catch (err) {
    return fail(`could not find vitest: ${(err as Error).message}`);
  }

  const logDir = mkdtempSync(join(tmpdir(), "capture-golden-"));
  const logFile = join(logDir, "writes.log");
  writeFileSync(logFile, "");
  try {
    const inv = vitestInvocation(process.execPath, vitestEntry, [
      "run",
      ...split.flags,
      ...targets,
    ]);
    const result = spawnSync(inv.command, inv.args, {
      stdio: "inherit",
      shell: inv.shell,
      env: {
        ...process.env,
        GOLDEN_WRITE: "1",
        GOLDEN_CAPTURE_RUN: "1",
        GOLDEN_WRITE_LOG: logFile,
      },
    });
    const outcome = outcomeOf(result);
    if (outcome.message) console.error(`capture-golden: ${outcome.message}`);
    if (outcome.code !== 0) return outcome.code;

    const logText = readFileSync(logFile, "utf8");
    const written = parseWriteLog(logText);
    console.log(`capture-golden: wrote ${written.size} golden file(s)`);
    const dups = findDuplicateWrites(logText);
    if (dups.length > 0) {
      return fail(
        `${dups.length} golden file(s) were written by more than one case in this run ` +
          `(case-name collision; the last writer won); give each case its own name:\n` +
          dups.map((d) => `  ${relative(REPO_ROOT, d)}`).join("\n"),
      );
    }
    if (partialReason) {
      console.log(`capture-golden: partial run (${partialReason}); skipped orphan detection`);
      return 0;
    }
    if (written.size === 0) {
      return fail(`the harness recorded no writes in GOLDEN_WRITE_LOG (${logFile})`);
    }
    const orphans = findOrphanGoldens(join(REPO_ROOT, SNAPSHOT_ROOT), written);
    if (orphans.length > 0) {
      return fail(
        `${orphans.length} golden file(s) were not written by this run. Review each one: ` +
          `delete it if its case was removed or renamed, otherwise restore the case:\n` +
          orphans.map((o) => `  ${relative(REPO_ROOT, o)}`).join("\n"),
      );
    }
    return 0;
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

// Run only when executed directly, so tests can import the helpers above.
// Compare realpaths: `argv[1]` keeps the path as typed (maybe via a symlink),
// while `import.meta.url` is already resolved.
if (isMainModule(process.argv[1], import.meta.url)) {
  process.exit(main());
}
