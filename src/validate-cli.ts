/**
 * `aimock validate` subcommand — offline fixture lint.
 *
 * Usage: `aimock validate [--strict] [--json] [--] <path> [more paths ...]`
 *
 * Each path is a fixture file or a directory; directories are walked
 * recursively for `*.json` in the same order `--fixtures <dir>` loads them.
 * For each file: read bytes, JSON-parse, require a top-level
 * `{ "fixtures": [...] }` envelope, convert the entries (surfacing the
 * per-entry conversion warnings the server logs), then run the
 * `validateFixtures` rules over that file's entries alone, so its findings
 * are attributed to it.
 *
 * `validateFixtures` is then run a SECOND time over the union of every
 * successfully-parsed file's entries, in load order. Its rules are not all
 * per-fixture: `duplicate userMessage` and the catch-all ordering check look
 * at the other fixtures in the array they are given. Run per file those two
 * cannot see across files, so the findings the union pass adds — a
 * `userMessage` duplicated in two files, a catch-all that is last in its own
 * file but not last overall — are the cross-file ones. They are reported
 * against the file that owns the fixture, with the other file named in the
 * message; findings the per-file pass already made are not repeated.
 *
 * How this compares to the server's `--validate-on-load`, in both directions:
 *  - Stricter: there an unreadable, unparseable or wrong-shape file is
 *    non-fatal — it warns on stderr, contributes zero fixtures, and startup
 *    continues as long as the run loaded at least one fixture from somewhere.
 *    Here every such file fails the run — with one deliberate exception, for
 *    parity: a `*.json` file the WALK turned up that parses but carries no
 *    top-level `fixtures` array is not a fixture file (this package's own
 *    `fixtures/` tree holds aimock config files alongside fixtures), and is
 *    passed over with a note, exactly as the loader passes over it. A file
 *    the caller NAMES is still validated, wrong shape and all. Two walk
 *    hazards the server does not
 *    survive are refused outright rather than mirrored: a `*.json` path that
 *    is not a regular file (a FIFO, a socket, a device) is a per-file error
 *    here, where the server's `readFileSync` blocks on it forever; and a
 *    directory symlink that points back at a directory already being walked
 *    is reported once as a cycle, where the server recurses through it until
 *    the kernel returns ELOOP (~32 levels deep) and loads those levels'
 *    fixtures over and over. Malformed scalar or array matches are rejected
 *    before conversion, as they are by the server's fixture loader. The lint
 *    reports an entry error and continues validating valid siblings.
 *  - Equal: the `validateFixtures` rules themselves, because of the union
 *    pass above, and the zero-fixture rule — a run whose inputs yield no
 *    fixtures at all is an error here, matching the server's "No fixtures
 *    loaded and validation/strict mode is enabled — aborting." A single
 *    `{"fixtures": []}` file alongside files that do load fixtures is an
 *    error in neither place. Equal too in what the inputs expand to: a path
 *    named twice, and a directory reached both directly and through an
 *    acyclic symlink to it, are validated once per mention, exactly as the
 *    server loads one `--fixtures` source per mention — so the duplicate
 *    fixtures that produces are reported here as the server reports them,
 *    one finding per (fixture, rule), the same count the server logs.
 *
 * A path mentioned more than once in one run is therefore several DIFFERENT
 * loads that happen to share a name, and printing that bare name for each of
 * them made them indistinguishable: a warning read as if a fixture shadowed
 * itself. Each mention is numbered, and every rendering surface carries that
 * number — human lines and their summary, cross-file references, and a
 * `mention` field on each `--json` `files[]` entry. The `<path>[<n>]` suffix
 * is printed only for a path that IS mentioned more than once, because for
 * every other path the name alone already names one load; the `--json` field
 * is always present so a consumer never has to infer it.
 *  - Weaker: this is a static lint. It never starts a server, so it covers
 *    nothing about binding, remote `--fixtures <url>` sources (it reads local
 *    paths only), `--watch` reloads, or any runtime behaviour.
 *
 * Nothing the filesystem or a fixture entry can do is allowed to escape this
 * function: a malformed entry, an unreadable path, a stat failure or a symlink
 * cycle each becomes a per-file `[error]` in the report, and a crash inside
 * either `validateFixtures` pass becomes a file-level or run-level `[error]`,
 * so the run still emits a report (valid JSON under `--json`) and still exits
 * 1. Run-level errors print after the per-file output, and the "no fixtures
 * loaded" one is withheld when a file already reported why it loaded none.
 *
 * Prints human lines by default (`file: [error|warning] #i message`) or a
 * JSON document with `--json`. Everything that contributes to a non-zero exit
 * goes to stderr, so a CI log's stderr always shows the reason; `--json` keeps
 * stdout to the report alone and puts the reason on stderr. The two modes
 * report the same facts: a fatal file is one record that both the stdout
 * tally and `files[].errors` count, and `--json` emits a document for a usage
 * error too — stdout is never empty on a `--json` run, whatever failed it.
 * A path naming a remote source (`https://...`) is refused as unsupported
 * rather than read as a filename. Exit codes:
 * 0 = clean (warnings allowed unless `--strict`), 1 = everything that fails
 * the run — errors / unreadable / unparseable / wrong shape / unwalkable path
 * / no fixtures loaded at all, and a usage error (no paths or an unknown
 * option) too, because every other CLI surface in this package exits 1 on a
 * usage error and nothing here uses sysexits codes. `--help` is handled
 * separately and exits 0.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { format, parseArgs } from "node:util";
import {
  entryToFixture,
  FixtureLoadError,
  hasMcpFakesKey,
  renderValidationRef,
  validateFixtures,
} from "./fixture-loader.js";
import type { ValidationRef } from "./fixture-loader.js";
import { Logger } from "./logger.js";
import { McpFakesAddError, McpFakeStore, validateMcpFakes } from "./mcp-fakes.js";
import type { McpFakeIssue } from "./mcp-fakes.js";
import { build, msg, plainText } from "./message-text.js";
import type { Fixture, FixtureFile, McpFakeSource } from "./types.js";

export const VALIDATE_HELP = `
Usage: aimock validate [options] [--] <path> [more paths ...]

Validate aimock fixture files offline. Each path is a fixture file or a
directory of them (walked recursively for *.json, like --fixtures <dir>).
Files are checked one at a time and then as one combined set, so the rules
that span files -- a userMessage duplicated across two files, a catch-all
that is not last overall -- are reported here as the server reports them.

Where the server's --validate-on-load differs: there an unreadable,
unparseable or wrong-shape file only warns and startup continues, while here
every such file fails the run. The one exception, which matches the loader: a
*.json file found by WALKING a directory that has no top-level "fixtures"
array is not a fixture file (an aimock config, say) and is skipped with a
note -- a file you name on the command line is still validated. As on the
server, a run that loads no fixtures at all is an error. This is a static lint: it starts no server and reads
local paths only (no remote --fixtures URL).

A path given twice is validated twice, because the server loads one set of
fixtures per --fixtures it is given; the duplicate fixtures that produces are
reported as the server reports them, one finding per fixture and rule. Such a
path is printed as <path>[<n>], numbering its mentions from 1, so each load
and every reference to its fixtures names one of them (--json reports the
number as "mention" on every file). A directory symlink pointing back at a
directory already being walked is a symlink cycle and fails the run; one
pointing anywhere else is followed, as the server follows it.

Options:
      --strict          Treat warnings as errors (exit 1 on warnings)
      --json            Emit a JSON report instead of human lines
  -h, --help            Show this help message
      --                Stop option parsing; every later argument is a path
                        (use this for a path that begins with "-")

Exit codes:
  0  all files valid (warnings allowed unless --strict)
  1  anything that failed the run: validation errors; a malformed fixture
     entry; an unreadable or unparseable file; a named path of the wrong
     shape (a walked one is skipped instead); a path that
     cannot be stat'd, read or walked (including a symlink cycle, or a
     *.json path that is not a regular file); a directory holding no *.json;
     no fixtures loaded from any input; --strict warnings; or a usage error
     (no paths given, or an unknown option)
`.trim();

export interface ValidateCliDeps {
  argv?: string[];
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  exit?: (code: number) => void;
}

/**
 * One finding against a file. `index` is the fixture entry it belongs to and is
 * ABSENT when the finding is about the file as a whole (a crash inside the
 * validator, say) rather than an entry — attributing such a finding to entry #0
 * blames a fixture that may be perfectly valid. `detail` carries the raw
 * underlying text (a thrown error's message) for a finding whose `message` is a
 * human-facing rephrasing of it; the `--json` report carries it as its own
 * field and the human report prints it on an indented continuation line.
 */
interface Finding {
  index?: number;
  message: string;
  detail?: string;
}

interface FileReport {
  file: string;
  /**
   * Which mention of `file` this report is, 1-based, in the order the run
   * expanded its paths. It is the only thing that tells two reports of the
   * same path apart — they are separate loads with separate findings.
   */
  mention: number;
  fixtures: number;
  /**
   * `mcpFakes` blocks this file loaded (F8); set only for a file that has a
   * top-level `mcpFakes` key.
   */
  mcpFakeBlocks?: number;
  errors: Finding[];
  warnings: Finding[];
  fatal?: string;
  /** Set when the walk passed the file over; see `nonFixtureSkipReason`. */
  skipped?: string;
}

/**
 * A rule finding the per-file pass made, with what the cross-file pass needs
 * to recognise its own restatement of it.
 *
 * Both passes run the same rules, and each rule fires at most once per fixture
 * — which is why the server, whose single pass IS the union pass, logs exactly
 * one line per (fixture, rule). So the SITE identifies the finding: the file
 * (supplied by the caller, the only thing that knows the file id), the entry
 * index, the severity and the rule. Two findings at one site can differ only
 * in which other fixtures they name, and the union pass's answer to that is
 * the authoritative one — it sees every file — so its wording REPLACES the
 * per-file wording rather than printing beside it, which is what made a
 * repeated path report one duplicate twice.
 *
 * `refs` holds the entry indices this finding names, so a restatement that
 * names the same fixtures can be recognised as adding nothing and leave the
 * per-file wording alone. Matching on the rendered message with its digits
 * masked (a previous scheme) both collapsed distinct findings that happened to
 * mask alike and hid genuine cross-file ones, because a union index and a
 * file-local index mask to the same "#".
 *
 * `finding` is the very object in the report, so an upgrade is an in-place
 * rewrite that keeps the finding in the position it was reported at.
 */
interface FindingIdentity {
  severity: "error" | "warning";
  index: number;
  /** The rule id for a ref-carrying finding, else its verbatim message. */
  kind: string;
  /** Entry indices this finding names, within the SAME file. */
  refs: number[];
  /** The finding as it sits in the file's report, for an in-place upgrade. */
  finding: Finding;
}

/** The indices a ref names, in a fixed order, for identity purposes. */
function refIndices(ref: ValidationRef): number[] {
  return ref.rule === "duplicate-user-message"
    ? [ref.shadows]
    : [ref.shadowsFrom, ref.shadowsThrough];
}

/**
 * A path argument that names a remote source rather than a local file: any
 * `scheme://` prefix, not just http(s), so `ftp://` and friends get the same
 * explanation instead of a filesystem error. A Windows drive letter ("C:\\x")
 * has no `//` and is not matched.
 */
const REMOTE_SOURCE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Render an unknown thrown value as a one-line message. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record why a file produced no report at all. A fatal is ONE fact, so it is
 * written once, here, into both shapes that report it: `fatal`, which names
 * the reason, and `errors`, which is what every tally — the human summary
 * line, the `--json` consumer counting `files[].errors` — actually counts.
 * Set on `fatal` alone, the two modes disagreed: stdout said "1 error(s)"
 * while the same run's JSON said `"errors": []`, so a CI script adding up the
 * JSON saw a clean run that had exited 1.
 *
 * The finding carries no `index`: a fatal is about the file, not an entry
 * (see `Finding.index`).
 */
function setFatal(report: FileReport, message: string): void {
  report.fatal = message;
  report.errors.push({ message });
}

/** A file that never got as far as a report, with its fatal already recorded. */
function fatalReport(file: string, mention: number, message: string): FileReport {
  const report: FileReport = { file, mention, fixtures: 0, errors: [], warnings: [] };
  setFatal(report, message);
  return report;
}

/**
 * Logger that routes `warn` AND `error` into caller-supplied sinks instead of
 * the console, so the per-entry conversion diagnostics `entryToFixture` emits
 * land in the report rather than being dropped on the floor — and, under
 * `--json`, never interleave with the JSON document on stdout/stderr.
 * Exported for tests only; it is not part of the package's public API.
 * `info`/`debug` are inert: they are already below this logger's "warn" level,
 * and silencing them explicitly keeps future call sites off stdout too.
 */
export class CollectingLogger extends Logger {
  private readonly warnSink: (msg: string) => void;
  private readonly errorSink: (msg: string) => void;

  constructor(warnSink: (msg: string) => void, errorSink: (msg: string) => void) {
    super("warn");
    this.warnSink = warnSink;
    this.errorSink = errorSink;
  }

  /**
   * Serialise exactly as the sink this logger replaces does — byte for byte.
   * `Logger` writes `console.warn("[aimock]", ...args)`, and console's
   * formatting IS `util.format`, so the call it makes is
   * `format("[aimock]", ...args)`: `"[aimock]"` is the FORMAT STRING and holds
   * no specifiers, which is what makes a caller's own `%s`/`%d` inert and its
   * arguments plain trailing values. Calling `format(...args)` instead
   * promoted the caller's message into the format slot — so a message that
   * happened to contain `%s` (a fixture path, say) swallowed the next
   * argument — and dropped the `[aimock]` prefix, leaving the report and the
   * server's own stderr disagreeing about the same diagnostic.
   * `util.inspect` still renders object arguments readably, which is what
   * `String(a)` could not do.
   */
  private static format(args: unknown[]): string {
    return format("[aimock]", ...args);
  }

  override warn(...args: unknown[]): void {
    this.warnSink(CollectingLogger.format(args));
  }

  override error(...args: unknown[]): void {
    this.errorSink(CollectingLogger.format(args));
  }

  override info(...args: unknown[]): void {
    void args; /* suppressed: never write to stdout from inside a --json run */
  }

  override debug(...args: unknown[]): void {
    void args; /* suppressed: never write to stdout from inside a --json run */
  }
}

/**
 * One product of the walk: a `*.json` file to validate, or — with `fatal`
 * set — a path that could not be walked, reported as its own per-file error,
 * or — with `skipped` set — a `*.json` file the walk found that is not a
 * fixture file at all and is passed over (see `nonFixtureSkipReason`).
 */
interface CollectEntry {
  file: string;
  fatal?: string;
  skipped?: string;
  /**
   * The entry-id `source` (I6) of the file's `mcpFakes` blocks: its path
   * relative to the walked directory, with `/` separators, as
   * `loadFixturesFromDirWithServices` derives it. Absent for a named file,
   * whose source is its path as given.
   */
  source?: string;
}

/**
 * Why a `*.json` file the WALK turned up is not a fixture file, or
 * `undefined` if it is one (or if the question cannot be answered cheaply).
 *
 * A directory is not a fixture directory: this package ships `fixtures/`
 * holding both fixture files and eight aimock CONFIG files — the six
 * `fixtures/examples/**\/*-config.json`, `full-suite.json`, and
 * `agui/agui-text-response.json`, whose AG-UI fixtures sit NESTED under
 * `agui` where `--fixtures` cannot see them — which is why the documented
 * `aimock validate ./fixtures/` exited 1 on the package's own tree. The
 * server has the same mixture to deal with and passes over it:
 * `loadFixtureFile` warns "Missing or invalid \"fixtures\" array", returns no
 * fixtures, and startup continues. This mirrors that skip, so a walked
 * directory reports on the fixture files in it and says what it passed over.
 *
 * Non-fixture means the file carries no top-level `fixtures` key at all (or
 * is an aimock config). A `fixtures` key that is present but not an array is
 * a MALFORMED fixture file and still fails the run, as the loader would refuse
 * it. The skip applies ONLY to files the walk discovered — a path the caller named explicitly is still validated, and a
 * wrong-shape file there still fails the run, because naming a file is
 * asking about that file.
 *
 * A file carrying an aimock config section (`configSections`) is named as
 * what it is rather than by what it lacks, because "not a fixture file" on
 * its own is read as "holds no fixtures" — false of `agui`-sectioned configs,
 * which hold AG-UI fixtures that `aimock --config`, not `--fixtures`, serves.
 *
 * Unreadable and unparseable are deliberately NOT skips. Returning
 * `undefined` for them hands the file to `validateOneFile`, which reports the
 * real read error or JSON syntax error — a defect in any `*.json` file, and
 * one no config file has an excuse for either.
 */
function nonFixtureSkipReason(file: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
  // F6: a top-level `mcpFakes` key makes it a fixture file (fakes-only or not).
  // D2: checked before the config sections, because the loader loads the
  // fakes of any file with the key, config-shaped or not.
  if (hasMcpFakesKey(parsed)) return undefined;
  const asConfig = aimockConfigDescription(parsed);
  if (asConfig !== undefined) return `not a fixture file — ${asConfig}`;
  // A present `fixtures` key of the wrong shape is a MALFORMED fixture file,
  // not a non-fixture file: hand it to `validateOneFile`, which fails it the
  // way the same file fails when named.
  if (typeof parsed === "object" && parsed !== null && "fixtures" in parsed) return undefined;
  return 'not a fixture file — no top-level "fixtures" key';
}

/**
 * The mock sections of `AimockConfig` (config-loader.ts). An object carrying
 * any of them is an aimock config file: `aimock --config <path>` starts a
 * server from it, while `--fixtures <path>` loads nothing from it.
 */
const CONFIG_SECTIONS = ["llm", "mcp", "a2a", "agui", "vector", "services"] as const;

/**
 * What a parsed-but-not-fixture-shaped JSON document IS, when it is an aimock
 * config file, or `undefined` when it is not one. Used by both the walk's skip
 * note and the fatal a NAMED file of that shape gets, so the two surfaces
 * describe the same file the same way. The sections found are listed, so an
 * `agui` config is never described as a file holding no fixtures — it holds
 * AG-UI ones, nested where the fixture loader does not look.
 */
function aimockConfigDescription(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const doc = parsed as Record<string, unknown>;
  const sections = CONFIG_SECTIONS.filter((key) => typeof doc[key] === "object" && doc[key]);
  if (sections.length === 0) return undefined;
  return `an aimock config file (${sections.join(", ")}), which "aimock --config" serves and "--fixtures" does not load`;
}

/**
 * Collect `*.json` files under `dirPath`, recursing into subdirectories.
 * Mirrors `loadFixturesFromDir`: within a directory the `*.json` files come
 * first in sorted order, then its subdirectories in sorted order, so the
 * reported order matches the server's load order, and the same stat-error
 * handling — a vanished entry (ENOENT) is skipped silently, every other
 * failure is surfaced. Unlike the loader, which only warns, each surfaced
 * failure becomes a `fatal` entry that fails the run, and it is emitted in
 * walk position (an unreadable subdirectory is reported where that
 * subdirectory was reached, not after every file in the tree) so the report
 * reads in encounter order. Entries that are neither directories nor
 * `*.json` files are ignored, as they are by the loader.
 *
 * `ancestors` holds the real paths of the directories this call is nested
 * inside. A directory whose real path is one of them closes a symlink cycle
 * and is reported instead of walked; the server has no such guard and
 * recurses through the cycle until the kernel returns ELOOP. A repeat visit
 * that is NOT an ancestor — `root/link -> root/sub` alongside `root/sub` — is
 * no cycle: it is walked again, because the server walks it again and loads
 * those fixtures twice.
 *
 * A `*.json` entry that is not a regular file (a FIFO, a socket, a device)
 * is a `fatal` entry rather than a target, because reading it is what the
 * containment promise above cannot keep: `readFileSync` on a FIFO with no
 * writer blocks forever, as it does on the server.
 */
function collectJsonFiles(
  dirPath: string,
  ancestors: string[],
  out: CollectEntry[] = [],
): CollectEntry[] {
  let realPath: string;
  try {
    realPath = realpathSync(dirPath);
  } catch (err) {
    out.push({ file: dirPath, fatal: `Could not resolve directory: ${errText(err)}` });
    return out;
  }
  if (ancestors.includes(realPath)) {
    out.push({
      file: dirPath,
      fatal: `Symlink cycle detected: already walking ${realPath}`,
    });
    return out;
  }

  let names: string[];
  try {
    names = readdirSync(dirPath);
  } catch (err) {
    out.push({ file: dirPath, fatal: `Could not read directory: ${errText(err)}` });
    return out;
  }

  // Sort the whole entry list, not just the `*.json` names, so a stat failure
  // or a non-regular `*.json` lands at a deterministic place in the report
  // whatever order the filesystem hands entries back in.
  const subdirs: string[] = [];
  for (const name of [...names].sort()) {
    const fullPath = join(dirPath, name);
    let stats: Stats;
    try {
      stats = statSync(fullPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        out.push({ file: fullPath, fatal: `Could not stat: ${errText(err)}` });
      }
      continue;
    }
    if (stats.isDirectory()) subdirs.push(name);
    else if (!name.endsWith(".json")) continue;
    else if (stats.isFile()) {
      const skipped = nonFixtureSkipReason(fullPath);
      out.push(skipped === undefined ? { file: fullPath } : { file: fullPath, skipped });
    } else out.push({ file: fullPath, fatal: "Not a regular file" });
  }

  const chain = [...ancestors, realPath];
  for (const sub of subdirs) collectJsonFiles(join(dirPath, sub), chain, out);
  return out;
}

/** The entry shape the loader and the server both assume, quoted verbatim. */
const ENTRY_SHAPE = 'every entry needs { "match": { ... }, "response": { ... } }';

/** Name a value the way a fixture author would read it back in their JSON. */
function gotText(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "absent";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * A shape defect in a raw fixture entry, classified BEFORE conversion.
 *
 * Classifying before conversion gives known malformed shapes an actionable
 * explanation while leaving unexpected conversion failures to the backstop.
 */
type EntryDefect =
  /** `entryToFixture` would throw: report it and skip the entry. */
  | { severity: "error"; convertible: false; why: string }
  /** Converts, but not into the fixture the author meant: report and convert. */
  | { severity: "warning"; convertible: true; why: string };

/**
 * Classify a raw entry's shape, or return `undefined` when nothing about it is
 * worth saying. Runs before `entryToFixture`, so every branch below is driven
 * by the entry itself rather than by whichever exception the conversion
 * happened to throw.
 *
 * A missing or non-object `response` is deliberately NOT classified here: the
 * conversion accepts it (`{ ...undefined }` is `{}`), the server accepts it,
 * and the `validateFixtures` rules already reject it by name — "response is
 * not a recognized type (must have content, toolCalls, ...)" — which is the
 * more actionable message of the two. Saying it here as well would report one
 * defect twice. It is still named alongside `match` when `match` is fatal,
 * because then the rules never run on the entry at all and an author fixing
 * `{}` would otherwise need one round trip per missing key.
 */
function classifyEntry(entry: unknown): EntryDefect | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      severity: "error",
      convertible: false,
      why: `entry is ${gotText(entry)}, expected an object — ${ENTRY_SHAPE}`,
    };
  }
  const match = (entry as Record<string, unknown>).match;
  if (match === null || match === undefined) {
    const missing = (["match", "response"] as const).filter((key) => {
      const value = (entry as Record<string, unknown>)[key];
      return value === null || typeof value !== "object" || Array.isArray(value);
    });
    return {
      severity: "error",
      convertible: false,
      why: `missing or non-object ${missing.map((k) => `"${k}"`).join(" and ")} — ${ENTRY_SHAPE}`,
    };
  }
  if (typeof match !== "object" || Array.isArray(match)) {
    return {
      severity: "error",
      convertible: false,
      why: `"match" is ${gotText(match)}, expected an object — ${ENTRY_SHAPE}`,
    };
  }
  return undefined;
}

/**
 * The backstop for an entry `classifyEntry` passed and `entryToFixture` threw
 * on anyway (a `toolCalls: [null]`, say, which `normalizeResponse` walks).
 * Which entry it was is the actionable half, so that leads; the raw thrown
 * text follows as `detail`, which `--json` carries as its own field and the
 * human report prints on an indented continuation line. It used to say
 * `see "detail"`, naming a field only the `--json` report has — in human mode
 * that pointed at nothing at all.
 */
function unexpectedEntryFailure(index: number, err: unknown): Finding {
  return {
    index,
    message: `Invalid fixture entry #${index}: could not be converted to a fixture`,
    detail: errText(err),
  };
}

/**
 * Validate one fixture file into a report. Every failure mode — unreadable,
 * unparseable, wrong shape, or a single malformed entry — is recorded in the
 * returned report rather than thrown.
 *
 * The converted fixtures are handed back alongside the report, with
 * `indices[i]` giving the entry index `fixtures[i]` was converted from, so the
 * cross-file union pass can append them and map its findings back to a file
 * and an entry index.
 */
function validateOneFile(
  file: string,
  mention: number,
  source: string,
): {
  report: FileReport;
  fixtures: Fixture[];
  indices: number[];
  identities: FindingIdentity[];
  runErrors: string[];
  mcpFakes: McpFakeSource[];
} {
  const report: FileReport = { file, mention, fixtures: 0, errors: [], warnings: [] };
  const fixtures: Fixture[] = [];
  const sourceIndex: number[] = [];
  // Findings that belong to no entry because an index could not be resolved.
  // They are raised at run level rather than filed against a guessed entry.
  const runErrors: string[] = [];
  // Identities of the findings the RULES produced (not the conversion
  // diagnostics, which the union pass cannot produce and so cannot repeat).
  const identities: FindingIdentity[] = [];
  // The file's `mcpFakes` blocks, when they pass `validateMcpFakes`, for the
  // run's entry-id check across files (I8).
  const mcpFakes: McpFakeSource[] = [];

  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    setFatal(report, `Could not read file: ${errText(err)}`);
    return { report, fixtures, indices: sourceIndex, identities, runErrors, mcpFakes };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    setFatal(report, `Invalid JSON: ${errText(err)}`);
    return { report, fixtures, indices: sourceIndex, identities, runErrors, mcpFakes };
  }
  // F7: a file with a top-level `mcpFakes` key may leave `fixtures` out
  // (spec 5.4), as the loader allows; a `fixtures` key it does have must
  // still be an array.
  const fakesDoc = hasMcpFakesKey(parsed) ? parsed : undefined;
  const fixturesLeftOut =
    fakesDoc !== undefined && !Object.prototype.hasOwnProperty.call(fakesDoc, "fixtures");
  const badShape =
    !fixturesLeftOut &&
    (typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { fixtures?: unknown }).fixtures));
  if (badShape) {
    // Naming a file is asking about that file, so the wrong shape is still
    // fatal — the loader refuses it too. Say WHICH wrong shape when the file
    // is an aimock config, so the answer names the file for what it is rather
    // than implying it holds nothing.
    const asConfig = aimockConfigDescription(parsed);
    setFatal(
      report,
      asConfig === undefined
        ? 'Missing or invalid "fixtures" array (expected { "fixtures": [...] })'
        : `Missing or invalid "fixtures" array (expected { "fixtures": [...] }) — this is ${asConfig}`,
    );
    // D3: the loader still loads the fakes of such a file (it only warns
    // about `fixtures`), so they are checked below before returning.
  }

  if (fakesDoc !== undefined) {
    // F7: validate the blocks under the file's entry-id source (I6). A bad
    // block is an error of this file; L8 shadowed entries are warnings.
    const fakes = fakesDoc.mcpFakes;
    const validation = validateMcpFakes(fakes, source);
    report.errors.push(...validation.errors.map(loadErrorFinding));
    report.mcpFakeBlocks = 0;
    if (validation.errors.length > 0) {
      report.warnings.push(...validation.warnings.map(issueFinding));
    } else if (Array.isArray(fakes)) {
      // The warnings of clean blocks come from the run's store, which gives
      // each block its real entry ids (a repeated load is `@<k>`, I7).
      fakes.forEach((block: unknown, blockIndex: number) => {
        mcpFakes.push({ source, blockIndex, raw: block });
      });
    } else {
      mcpFakes.push({ source, blockIndex: null, raw: fakes });
    }
  }
  if (fixturesLeftOut || badShape) {
    return { report, fixtures, indices: sourceIndex, identities, runErrors, mcpFakes };
  }

  // Convert the entries we already parsed rather than re-reading the file,
  // and give the conversion a logger so its per-entry diagnostics are
  // attributed to the entry that produced them instead of being discarded.
  let entryIndex = 0;
  const entryLogger = new CollectingLogger(
    (message) => report.warnings.push({ index: entryIndex, message }),
    (message) => report.errors.push({ index: entryIndex, message }),
  );

  // Classify known malformed shapes before conversion and skip those entries.
  // Keep the catch as a backstop for unexpected conversion failures. Remember
  // each converted fixture's source index so findings retain entry indices.
  const entries = (parsed as FixtureFile).fixtures;
  for (let index = 0; index < entries.length; index++) {
    entryIndex = index;
    const defect = classifyEntry(entries[index]);
    if (defect !== undefined) {
      const label = defect.severity === "error" ? "Invalid fixture entry" : "Fixture entry";
      const finding: Finding = { index, message: `${label} #${index}: ${defect.why}` };
      if (!defect.convertible) {
        report.errors.push(finding);
        continue;
      }
      report.warnings.push(finding);
    }
    try {
      const fixture = entryToFixture(entries[index], entryLogger, undefined, {
        file: source,
        index,
      });
      fixtures.push(fixture);
      sourceIndex.push(index);
    } catch (err) {
      report.errors.push(
        err instanceof FixtureLoadError && err.rule.startsWith("misbehavior/")
          ? { index, message: err.message }
          : unexpectedEntryFailure(index, err),
      );
    }
  }

  report.fixtures = fixtures.length;
  // `validateFixtures` reports against the COMPACTED array, which skips the
  // entries that failed to convert. The finding's own index is mapped back to
  // an entry index — and so are the indices its message NAMES, or one line
  // would print two different index spaces: "#2 ... shadows fixture 0" where
  // "#2" is an entry and "0" is a compacted slot.
  // `?? fixtureIndex` here USED to mask an unresolvable index by printing a
  // compacted slot as if it were an entry index — two different index spaces
  // in one line, with nothing to say so. It is unreachable while `sourceIndex`
  // is pushed in lockstep with `fixtures`, so if it ever fires the run is
  // wrong, not merely imprecise: raise it at run level (which fails the run)
  // instead of quietly printing a number that means something else.
  const unresolved = new Set<number>();
  const toEntryIndex = (fixtureIndex: number): number => {
    const entry = sourceIndex[fixtureIndex];
    if (entry !== undefined) return entry;
    if (!unresolved.has(fixtureIndex)) {
      unresolved.add(fixtureIndex);
      runErrors.push(
        `finding for fixture index ${fixtureIndex}, which maps to no entry in this file`,
      );
    }
    return fixtureIndex;
  };
  try {
    for (const r of validateFixtures(fixtures)) {
      const index = toEntryIndex(r.fixtureIndex);
      const refs = r.ref === undefined ? [] : refIndices(r.ref).map(toEntryIndex);
      const message =
        r.ref === undefined
          ? r.message
          : renderValidationRef(r.ref, (i) => String(toEntryIndex(i)));
      const finding: Finding = { index, message };
      identities.push({
        severity: r.severity,
        index,
        kind: r.ref === undefined ? `message:${r.message}` : r.ref.rule,
        refs,
        finding,
      });
      if (r.severity === "error") report.errors.push(finding);
      else report.warnings.push(finding);
    }
  } catch (err) {
    // File-level: the validator walks every entry, so which one tripped it is
    // unknown. Filing it at #0 would accuse the file's first fixture, which is
    // very likely innocent, so this finding carries no entry index at all.
    report.errors.push({ message: `Validation failed for this file: ${errText(err)}` });
  }
  return { report, fixtures, indices: sourceIndex, identities, runErrors, mcpFakes };
}

/**
 * A `FixtureLoadError` from an `mcpFakes` block as a file-level finding (no
 * fixture entry index): its message names the rule, file, block and entry.
 */
function loadErrorFinding(err: FixtureLoadError): Finding {
  return { message: err.message };
}

/** An L8 shadowed-entry warning as a file-level finding. */
function issueFinding(issue: McpFakeIssue): Finding {
  return { message: issue.message };
}

/**
 * `#<index> ` for a finding that belongs to one entry; empty for a file-level
 * finding, which names no entry (see Finding.index). Shared by the human lines
 * and the failure summary so a reader of either can locate the same entry.
 */
const findingAt = (f: Finding): string => (f.index === undefined ? "" : `#${f.index} `);

/**
 * One-line reason a run failed, for the stderr side of `--json` output.
 *
 * It NAMES the failure first — the file and the finding that caused the
 * non-zero exit — and only then totals what else failed, because the line is
 * often the single line a CI log shows. Leading with a fixed list of counts
 * put two zeros ("0 unreadable/invalid file(s), 0 file(s) with errors") in
 * front of every strict-warning failure, where the reader has to get past the
 * things that did NOT happen to reach the one that did. Counts that are zero
 * are omitted for the same reason, and a file whose fatal is already the lead
 * is counted as unreadable/invalid only, not a second time under "with
 * errors" — its fatal now rides in `errors` as well (see `setFatal`).
 */
function summarizeFailure(
  reports: FileReport[],
  strict: boolean,
  runErrors: string[],
  name: (r: FileReport) => string,
): string {
  const fatalFiles = reports.filter((r) => r.fatal !== undefined);
  const erroredFiles = reports.filter((r) => r.fatal === undefined && r.errors.length > 0);
  const warnedFiles = reports.filter((r) => r.warnings.length > 0);

  // First failure in report order: a fatal file, else a file with errors, else
  // a run-level error, else (under --strict) the warning that failed the run.
  let lead: string;
  if (fatalFiles[0] !== undefined) lead = `${name(fatalFiles[0])}: ${fatalFiles[0].fatal}`;
  else if (erroredFiles[0] !== undefined)
    lead = `${name(erroredFiles[0])}: ${findingAt(erroredFiles[0].errors[0])}${erroredFiles[0].errors[0].message}`;
  else if (runErrors[0] !== undefined) lead = runErrors[0];
  else if (warnedFiles[0] !== undefined)
    lead = `${name(warnedFiles[0])}: ${findingAt(warnedFiles[0].warnings[0])}${warnedFiles[0].warnings[0].message} (--strict)`;
  /* v8 ignore next -- a failed run always has one of the four above */ else
    lead = "the run failed";

  const counts: string[] = [];
  if (fatalFiles.length > 0) counts.push(`${fatalFiles.length} unreadable/invalid file(s)`);
  if (erroredFiles.length > 0) counts.push(`${erroredFiles.length} file(s) with errors`);
  // A run-level error (no fixtures loaded from any input) belongs to no single
  // file, so it is counted on its own.
  if (runErrors.length > 0) counts.push(`${runErrors.length} run-level error(s)`);
  if (strict && warnedFiles.length > 0)
    counts.push(`${warnedFiles.length} file(s) with warnings (--strict)`);

  return `Error: fixture validation failed — ${lead} [${counts.join(", ")}].`;
}

export function runValidateCli(deps: ValidateCliDeps = {}): void {
  const argv = deps.argv ?? process.argv.slice(2);
  const log = deps.log ?? console.log.bind(console);
  const logError = deps.logError ?? console.error.bind(console);
  const exit = deps.exit ?? process.exit.bind(process);

  /**
   * Is `flag` present as an OPTION in argv — i.e. before the `--` terminator,
   * after which every argument is a path? Needed because a usage error can be
   * a `parseArgs` throw, which leaves no parsed `values` to consult, and the
   * output mode still has to be honoured. `--flag=value` counts: these are all
   * boolean options, so giving one a value IS the usage error being reported,
   * and matching the bare token alone answered "no `--json` here" for the one
   * argv that most obviously asked for JSON — leaving stdout empty.
   */
  const flagInArgv = (flag: string): boolean => {
    for (const arg of argv) {
      if (arg === "--") return false;
      if (arg === flag || arg.startsWith(`${flag}=`)) return true;
    }
    return false;
  };

  /**
   * A usage error, in whichever mode the argv asked for. `--json` promises
   * "one document on stdout" (README), and a run that fails on its own argv is
   * still a run: emitting nothing there handed a CI job parsing stdout an
   * empty buffer — a JSON parse error standing in for a perfectly ordinary
   * "no paths given". The document reports the usage error the same way a
   * run-level error is reported, so one consumer shape reads both. The
   * human-readable reason plus the help text stay on stderr in both modes, so
   * `--json` stdout is still the document alone.
   */
  const usageError = (message: string): void => {
    logError(`Error: ${message}\n\n${VALIDATE_HELP}`);
    if (flagInArgv("--json")) {
      log(
        JSON.stringify(
          {
            strict: flagInArgv("--strict"),
            failed: true,
            files: [],
            run: { fixtures: 0, mcpFakeBlocks: 0, errors: [message] },
          },
          null,
          2,
        ),
      );
    }
    exit(1);
  };

  // Parse with node:util parseArgs, like the main CLI (src/cli.ts) and the
  // server path in src/aimock-cli.ts: strict mode rejects unknown options and
  // the "--" terminator falls out for free, so a fixture path that begins with
  // "-" is still reachable.
  let values: { strict?: boolean; json?: boolean; help?: boolean };
  let paths: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        strict: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    paths = parsed.positionals;
  } catch (err) {
    /* v8 ignore next -- parseArgs always throws Error subclasses */
    const msg = err instanceof Error ? err.message : String(err);
    usageError(msg);
    return;
  }

  if (values.help === true) {
    // `--json --help` still has to leave one JSON document on stdout and
    // nothing else (README, docs): a consumer that forwards its own argv to
    // `validate --json "$@"` and pipes stdout to `jq` gets a parse error the
    // moment a user asks for help. The help text is the document's one field.
    log(values.json === true ? JSON.stringify({ help: VALIDATE_HELP }, null, 2) : VALIDATE_HELP);
    exit(0);
    return;
  }
  const strict = values.strict === true;
  const json = values.json === true;

  if (paths.length === 0) {
    usageError("no fixture paths given.");
    return;
  }

  // Expand directory arguments into their `*.json` members. A missing path is
  // passed through untouched so the read below reports the real per-file
  // error; any other stat failure (ELOOP, EACCES, ...) is its own error, and
  // a path that exists but is neither a directory nor a regular file is
  // refused rather than read (see `collectJsonFiles`).
  //
  // Targets are NOT de-duplicated: the server loads one set of fixtures per
  // `--fixtures` it is given, so a path named twice — or a file named both
  // directly and via its parent directory — is loaded twice there, and the
  // duplicate-`userMessage` findings that produces are exactly what this lint
  // exists to surface. Validating it twice here is what makes the union pass
  // see what the server sees.
  const targets: CollectEntry[] = [];
  for (const path of paths) {
    // A remote source is refused by NAME. `--fixtures <url>` is a runtime
    // feature of the server; this lint reads local paths only, and handing a
    // URL to `statSync` produced a bare ENOENT quoting the URL back — which
    // reads as "you typed the path wrong", not "this input is unsupported".
    if (REMOTE_SOURCE.test(path)) {
      targets.push({
        file: path,
        fatal:
          "Remote fixture source: this lint reads local paths only (the server's --fixtures accepts a URL; validate does not) — download the file and validate the local copy",
      });
      continue;
    }
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") targets.push({ file: path });
      else targets.push({ file: path, fatal: `Could not stat: ${errText(err)}` });
      continue;
    }
    if (!stats.isDirectory()) {
      if (stats.isFile()) targets.push({ file: path });
      else targets.push({ file: path, fatal: "Not a regular file" });
      continue;
    }
    const entries = collectJsonFiles(path, []);
    // Only an actually-walkable, actually-empty directory is "no fixtures
    // found" — an unreadable one reports why it could not be read.
    if (entries.length === 0) {
      targets.push({ file: path, fatal: "No .json fixture files found in directory" });
      continue;
    }
    // I6: a walked file's `mcpFakes` source is its path relative to the
    // directory named on the command line, with `/` separators.
    for (const entry of entries) {
      targets.push({ ...entry, source: relative(path, entry.file).split(sep).join("/") });
    }
  }

  // How many times each path is mentioned by the expanded target list, and a
  // running count that hands each target its own 1-based mention number. Both
  // are needed before the first report is printed: whether a name is ambiguous
  // is a property of the whole run, not of the file being reported. Both key
  // on the resolved path, not its spelling: a walked entry is `join`-normalised
  // while a named one is verbatim, and `./d/a.json` named beside the walk of
  // `./d` is the same load twice. The spelling is still what gets displayed.
  const mentionKey = (file: string): string => resolve(file);
  const mentionCount = new Map<string, number>();
  for (const target of targets)
    mentionCount.set(mentionKey(target.file), (mentionCount.get(mentionKey(target.file)) ?? 0) + 1);
  const mentionsSoFar = new Map<string, number>();
  const nextMention = (file: string): number => {
    const mention = (mentionsSoFar.get(mentionKey(file)) ?? 0) + 1;
    mentionsSoFar.set(mentionKey(file), mention);
    return mention;
  };
  /**
   * How a file is NAMED in human output and in cross-file references. A path
   * this run loads more than once gets its mention number, because the bare
   * path names all of those loads at once: without it a second load's findings
   * read as a file shadowing itself. A path loaded once is printed unadorned —
   * there is nothing to tell it apart from, and "[1]" on every line of an
   * ordinary run is noise. The `--json` report carries `mention` regardless.
   */
  const displayName = (report: FileReport): string =>
    (mentionCount.get(mentionKey(report.file)) ?? 1) > 1
      ? `${report.file}[${report.mention}]`
      : report.file;

  const reports: FileReport[] = [];
  // Every successfully-parsed entry, in load order, plus the file and local
  // index each one came from. `validateFixtures` reports by array index, so
  // the union pass below needs this to map its findings back to a file.
  const union: Fixture[] = [];
  const provenance: { report: FileReport; index: number }[] = [];
  // The rule findings the per-file pass already reported, by SITE — the file
  // (by id, so two mentions of one path are two sites), the entry index, the
  // severity and the rule. Each rule fires at most once per fixture in either
  // pass, so a union finding that lands on an occupied site is that same
  // finding seen with every file in view: it never prints a second line, and
  // it rewrites the first one only when it names different fixtures. Keying on
  // the rendered text with digits masked (a previous scheme) instead made every
  // "shadows fixtures <n>+" look alike, which both collapsed distinct findings
  // and silently swallowed genuine cross-file ones.
  const reportedBySite = new Map<string, { finding: Finding; refs: string[] }[]>();
  const fileIds = new Map<FileReport, number>();
  // Declared before the per-file loop because that loop contributes to it: an
  // index a file could not resolve belongs to no entry and no file section.
  const runErrors: string[] = [];
  // One throwaway store for the run: adding each file's `mcpFakes` blocks to
  // it, in load order, applies the entry-id uniqueness check across files
  // (I8, bad block (f)). A mount conflict needs the running server's mounts
  // and cannot be found here (spec 5.4, known limitation).
  const fakeStore = new McpFakeStore();
  let mcpFakeBlocks = 0;
  const siteKey = (fileId: number, index: number, severity: string, kind: string): string =>
    [fileId, index, severity, kind].join("\u0000");

  for (const target of targets) {
    // Passed over by the walk: it appears in the report so nothing the walk
    // touched vanishes, but it contributes no fixtures and no findings.
    if (target.skipped !== undefined) {
      reports.push({
        file: target.file,
        mention: nextMention(target.file),
        fixtures: 0,
        errors: [],
        warnings: [],
        skipped: target.skipped,
      });
      continue;
    }
    if (target.fatal !== undefined) {
      reports.push(fatalReport(target.file, nextMention(target.file), target.fatal));
      continue;
    }

    let report: FileReport;
    let fixtures: Fixture[] = [];
    let indices: number[] = [];
    let identities: FindingIdentity[] = [];
    let fileRunErrors: string[] = [];
    let mcpFakes: McpFakeSource[] = [];
    const mention = nextMention(target.file);
    try {
      ({
        report,
        fixtures,
        indices,
        identities,
        runErrors: fileRunErrors,
        mcpFakes,
      } = validateOneFile(target.file, mention, target.source ?? target.file));
    } catch (err) {
      // Backstop: nothing unexpected gets to abandon the remaining files.
      report = fatalReport(target.file, mention, `Validation failed: ${errText(err)}`);
    }
    if (mcpFakes.length > 0) {
      try {
        const added = fakeStore.add(mcpFakes, { kind: "file" });
        report.mcpFakeBlocks = mcpFakes.length;
        mcpFakeBlocks += mcpFakes.length;
        report.warnings.push(...added.warnings.map(issueFinding));
      } catch (err) {
        if (err instanceof McpFakesAddError) {
          report.errors.push(...err.errors.map(loadErrorFinding));
          report.warnings.push(...err.warnings.map(issueFinding));
        } else {
          // D1: nothing may escape this function (see the module comment):
          // any other throw is a finding of this file, so the run still
          // reports every file and `--json` stays one valid document.
          report.errors.push({
            message: build(msg`mcpFakes check failed: ${plainText(errText(err), Infinity)}`),
          });
        }
      }
    }
    reports.push(report);
    // These are raised inside `validateOneFile`, which knows the path but not
    // how many times this run loads it, so they are named here instead.
    runErrors.push(...fileRunErrors.map((e) => `${displayName(report)}: ${e}`));
    const fileId = fileIds.size;
    fileIds.set(report, fileId);

    // Only RULE findings are registered: a conversion diagnostic or a
    // file-level finding (no entry index) can never be restated by the union
    // pass, so it has no identity here.
    for (const identity of identities) {
      const key = siteKey(fileId, identity.index, identity.severity, identity.kind);
      const atSite = reportedBySite.get(key) ?? [];
      atSite.push({
        finding: identity.finding,
        refs: identity.refs.map((ref) => `${fileId}:${ref}`),
      });
      reportedBySite.set(key, atSite);
    }
    for (let i = 0; i < fixtures.length; i++) {
      // Same masking as `toEntryIndex` above, one level out: `?? i` silently
      // relabelled a union fixture with a compacted slot number. Keep the
      // union aligned with what the server loads (so the cross-file rules see
      // the same array), but fail the run rather than print a wrong index.
      const index = indices[i];
      if (index === undefined) {
        runErrors.push(
          `${displayName(report)}: converted fixture ${i} has no source entry index; ` +
            `cross-file findings against it are reported at its array position`,
        );
      }
      union.push(fixtures[i]);
      provenance.push({ report, index: index ?? i });
    }
  }

  // Cross-file pass. The server validates every loaded fixture as one array,
  // so its duplicate-userMessage and catch-all-ordering rules see across
  // files; run per file they never can. Validate the union and keep only the
  // findings the per-file pass did not already make.
  // Set when the run failed because it loaded nothing at all, so the human
  // printer can withhold "OK" from the files that loaded nothing — see below.
  let noFixturesLoaded = false;
  // When a file already said WHY it produced no fixtures (unreadable, invalid
  // JSON, wrong shape, a bad entry), the run-level line below would repeat that
  // same cause as a second, causeless error. Report it only when nothing else
  // has; the run still fails either way, on the per-file finding.
  const causeAlreadyReported = reports.some((r) => r.fatal !== undefined || r.errors.length > 0);
  if (union.length === 0) {
    // F8: loaded `mcpFakes` blocks count as loaded.
    // The server aborts startup on this exact condition
    // ("No fixtures loaded and validation/strict mode is enabled"), so a run
    // whose inputs yield nothing — `{"fixtures": []}` and nothing else —
    // fails here too. Parsed-but-empty files alongside files that do load
    // fixtures are fine in both places.
    if (!causeAlreadyReported && mcpFakeBlocks === 0) {
      runErrors.push(
        "No fixtures loaded from any input — the server aborts startup on this under --validate-on-load/--strict",
      );
      noFixturesLoaded = true;
    }
  } else {
    // A union index as the reader sees it: the load that owns the fixture —
    // named by path, plus its mention number when that path is loaded more
    // than once — and its index inside that load.
    const describe = (unionIndex: number): string => {
      const origin = provenance[unionIndex];
      return origin === undefined
        ? String(unionIndex)
        : `${displayName(origin.report)} #${origin.index}`;
    };
    // The same index as an identity for de-duplication. An unresolvable one
    // gets its own namespace rather than aliasing onto a real file.
    const targetOf = (unionIndex: number): string => {
      const origin = provenance[unionIndex];
      if (origin === undefined) return `union:${unionIndex}`;
      const fileId = fileIds.get(origin.report);
      return fileId === undefined ? `union:${unionIndex}` : `${fileId}:${origin.index}`;
    };
    // Cross-file wording is rendered from the finding's REF DATA, never by
    // rewriting its prose: `duplicate userMessage` quotes the fixture's own
    // text, and text that itself reads "fixture 3" is not an index.
    const renderCrossFile = (ref: ValidationRef): string => {
      if (ref.rule === "duplicate-user-message") {
        return `duplicate userMessage '${ref.userMessage}' — shadows fixture ${describe(ref.shadows)}`;
      }
      // Both ends are named because the point of the cross-file pass is that
      // the shadowed range reaches past the catch-all's own file; a bare
      // "<file> #0+" would read as if "+" were part of the index.
      const head = "empty match acts as catch-all but is not the last fixture";
      return ref.shadowsFrom === ref.shadowsThrough
        ? `${head} — shadows ${describe(ref.shadowsFrom)}`
        : `${head} — shadows every later fixture, from ${describe(ref.shadowsFrom)} through ${describe(ref.shadowsThrough)}`;
    };
    // The per-file pass above is wrapped per file; this one is the run's only
    // other call into `validateFixtures`, and an uncontained throw here killed
    // the process with no report at all and a truncated (invalid) `--json`
    // stdout. Contain it as a run-level error so the report is still emitted,
    // is still valid JSON, and the run still exits 1.
    try {
      for (const r of validateFixtures(union)) {
        const origin = provenance[r.fixtureIndex];
        if (origin === undefined) {
          // Unreachable while `provenance` is pushed in lockstep with `union`.
          // A bare `continue` here DROPPED the finding: an error finding could
          // vanish and leave the run exiting 0, reporting a clean bill of
          // health for fixtures the server would refuse. Raise it at run level,
          // as the adjacent unrecognised-file case already does.
          runErrors.push(
            `Cross-file finding for an unknown fixture index ${r.fixtureIndex}: ${r.message}`,
          );
          continue;
        }
        const fileId = fileIds.get(origin.report);
        if (fileId === undefined) {
          // Unreachable while provenance is built from reported files; recorded
          // as a run-level error rather than defaulted onto file 0, which would
          // attribute the finding to an unrelated file.
          runErrors.push(`Cross-file finding for an unrecognised file: ${r.message}`);
          continue;
        }
        const kind = r.ref === undefined ? `message:${r.message}` : r.ref.rule;
        const refTargets = r.ref === undefined ? [] : refIndices(r.ref).map(targetOf);
        const message = `cross-file: ${r.ref === undefined ? r.message : renderCrossFile(r.ref)}`;
        const already = reportedBySite
          .get(siteKey(fileId, origin.index, r.severity, kind))
          ?.shift();
        if (already !== undefined) {
          // The per-file pass already reported this rule against this fixture,
          // and the server would log it once. If the union names the same
          // fixtures it adds nothing and the file-local wording stands; if it
          // names others — a shadow that reaches into another load — that is
          // the fuller truth, so it replaces the wording in place rather than
          // printing a second line about the same fixture.
          const same =
            already.refs.length === refTargets.length &&
            already.refs.every((target, i) => target === refTargets[i]);
          if (!same) already.finding.message = message;
          continue;
        }
        if (r.severity === "error") origin.report.errors.push({ index: origin.index, message });
        else origin.report.warnings.push({ index: origin.index, message });
      }
    } catch (err) {
      runErrors.push(`Cross-file validation failed: ${errText(err)}`);
    }
  }

  const hasFatal = reports.some((r) => r.fatal !== undefined);
  const hasErrors = reports.some((r) => r.errors.length > 0) || runErrors.length > 0;
  const hasWarnings = reports.some((r) => r.warnings.length > 0);
  const failed = hasFatal || hasErrors || (strict && hasWarnings);

  // Anything that CAUSES the non-zero exit must reach stderr, or a CI log shows
  // a failure with no reason. Warnings are informational by default and are the
  // cause under --strict, so they follow the exit they produce.
  const logWarning = strict ? logError : log;

  if (json) {
    log(
      JSON.stringify(
        {
          strict,
          failed,
          files: reports,
          // D4: the blocks count as loaded, so a fakes-only run is not read
          // as one that loaded nothing.
          run: { fixtures: union.length, mcpFakeBlocks, errors: runErrors },
        },
        null,
        2,
      ),
    );
    // Keep stdout to the JSON document alone, but still say on stderr why the
    // run failed.
    if (failed) logError(summarizeFailure(reports, strict, runErrors, displayName));
  } else {
    const at = findingAt;
    // `detail` (the raw thrown text behind a rephrased message) is a field of
    // the `--json` document, so human mode used to lose it entirely. Print it
    // on an indented continuation line under its own finding, where it reads
    // as belonging to that line rather than as another finding.
    const emitDetail = (f: Finding, sink: (msg: string) => void): void => {
      if (f.detail !== undefined) sink(`    ${f.detail}`);
    };
    for (const r of reports) {
      const name = displayName(r);
      // A file the WALK turned up that is not fixture-shaped is passed over,
      // exactly as the server passes over it, and says so on its one line.
      if (r.skipped !== undefined) {
        log(`${name}: skipped (${r.skipped})`);
        continue;
      }
      // A fatal file needs no branch of its own: its reason rides in `errors`
      // (see `setFatal`), so the loop below prints the same `[error]` line and
      // the counting summary below tallies it — the stdout count and the
      // `--json` `errors` array can no longer drift apart. Every file still
      // gets exactly one summary line on stdout (README), including this one:
      // a reader tallying stdout must not silently lose a file.
      for (const e of r.errors) {
        logError(`${name}: [error] ${at(e)}${e.message}`);
        emitDetail(e, logError);
      }
      for (const w of r.warnings) {
        logWarning(`${name}: [warning] ${at(w)}${w.message}`);
        emitDetail(w, logWarning);
      }
      if (r.errors.length === 0 && r.warnings.length === 0) {
        // "OK" is a claim about the RUN as well as the file: a reader tallying
        // stdout on a run that failed would otherwise read "OK" against the very
        // file that loaded none, on an exit of 1. Keying this on the RUN-level
        // "no fixtures loaded" error was not enough — that error is withheld as
        // soon as another file reports a cause, which is exactly when a failed
        // run still has a zero-fixture file to print.
        const blocks = r.mcpFakeBlocks ?? 0;
        if (r.fixtures === 0 && blocks === 0 && failed) {
          const why = noFixturesLoaded ? "see the run-level error" : "the run failed elsewhere";
          log(`${name}: ${r.fixtures} fixture(s), loaded nothing — ${why}`);
        } else if (blocks > 0) {
          log(
            build(
              msg`${plainText(name, Infinity)}: OK (${r.fixtures} fixture(s), ${blocks} mcpFakes block(s))`,
            ),
          );
        } else {
          log(`${name}: OK (${r.fixtures} fixture(s))`);
        }
      } else {
        log(
          `${name}: ${r.fixtures} fixture(s), ${r.errors.length} error(s), ${r.warnings.length} warning(s)`,
        );
      }
    }
    // Run-level errors last: they are consequences of (or additions to) the
    // per-file output above, and printing them first put the summary before
    // the detail it summarises.
    for (const e of runErrors) logError(`[error] ${e}`);
  }

  exit(failed ? 1 : 0);
}
