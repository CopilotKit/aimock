/**
 * `aimock validate` subcommand — offline fixture lint.
 *
 * Usage: `aimock validate [--strict] [--json] <file.json> [more.json ...]`
 *
 * For each file: read bytes, JSON-parse, require a top-level
 * `{ "fixtures": [...] }` envelope, convert entries, then run the same
 * `validateFixtures` gate the server uses with `--validate-on-load`.
 * Prints human lines by default (`file: [error|warning] #i message`) or a
 * JSON document with `--json`. Exit codes: 0 = clean (warnings allowed
 * unless `--strict`), 1 = errors / unreadable / unparseable / wrong shape,
 * 2 = usage error (no files, `--help` handled separately with 0).
 */

import { readFileSync } from "node:fs";
import { loadFixtureFile, validateFixtures } from "./fixture-loader.js";

export const VALIDATE_HELP = `
Usage: aimock validate [options] <file.json> [more.json ...]

Validate aimock fixture files offline with the same gate the server uses
for --validate-on-load.

Options:
      --strict          Treat warnings as errors (exit 1 on warnings)
      --json            Emit a JSON report instead of human lines
  -h, --help            Show this help message

Exit codes:
  0  all files valid (warnings allowed unless --strict)
  1  validation errors, unreadable/unparseable files, or --strict warnings
  2  usage error (no files)
`.trim();

export interface ValidateCliDeps {
  argv?: string[];
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  exit?: (code: number) => void;
}

interface FileReport {
  file: string;
  fixtures: number;
  errors: { index: number; message: string }[];
  warnings: { index: number; message: string }[];
  fatal?: string;
}

export function runValidateCli(deps: ValidateCliDeps = {}): void {
  const argv = deps.argv ?? process.argv.slice(2);
  const log = deps.log ?? console.log.bind(console);
  const logError = deps.logError ?? console.error.bind(console);
  const exit = deps.exit ?? process.exit.bind(process);

  let strict = false;
  let json = false;
  const files: string[] = [];
  for (const arg of argv) {
    if (arg === "--strict") strict = true;
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      log(VALIDATE_HELP);
      exit(0);
      return;
    } else if (arg.startsWith("-")) {
      logError(`Unknown option: '${arg}'\n\n${VALIDATE_HELP}`);
      exit(2);
      return;
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    logError(`Error: no fixture files given.\n\n${VALIDATE_HELP}`);
    exit(2);
    return;
  }

  const reports: FileReport[] = [];
  for (const file of files) {
    const report: FileReport = { file, fixtures: 0, errors: [], warnings: [] };
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch (err) {
      report.fatal = `Could not read file: ${err instanceof Error ? err.message : String(err)}`;
      reports.push(report);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      report.fatal = `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      reports.push(report);
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { fixtures?: unknown }).fixtures)
    ) {
      report.fatal = 'Missing or invalid "fixtures" array (expected { "fixtures": [...] })';
      reports.push(report);
      continue;
    }
    const fixtures = loadFixtureFile(file);
    report.fixtures = fixtures.length;
    for (const r of validateFixtures(fixtures)) {
      if (r.severity === "error") report.errors.push({ index: r.fixtureIndex, message: r.message });
      else report.warnings.push({ index: r.fixtureIndex, message: r.message });
    }
    reports.push(report);
  }

  const hasFatal = reports.some((r) => r.fatal !== undefined);
  const hasErrors = reports.some((r) => r.errors.length > 0);
  const hasWarnings = reports.some((r) => r.warnings.length > 0);
  const failed = hasFatal || hasErrors || (strict && hasWarnings);

  if (json) {
    log(JSON.stringify({ strict, failed, files: reports }, null, 2));
  } else {
    for (const r of reports) {
      if (r.fatal !== undefined) {
        logError(`${r.file}: [error] ${r.fatal}`);
        continue;
      }
      for (const e of r.errors) logError(`${r.file}: [error] #${e.index} ${e.message}`);
      for (const w of r.warnings) log(`${r.file}: [warning] #${w.index} ${w.message}`);
      if (r.errors.length === 0 && r.warnings.length === 0) {
        log(`${r.file}: OK (${r.fixtures} fixture(s))`);
      } else {
        log(
          `${r.file}: ${r.fixtures} fixture(s), ${r.errors.length} error(s), ${r.warnings.length} warning(s)`,
        );
      }
    }
  }

  exit(failed ? 1 : 0);
}
