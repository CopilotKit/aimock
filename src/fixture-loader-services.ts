/**
 * Fixture loaders that carry MCP fakes (spec F1): the `…WithServices`
 * variants of `loadFixtureFile` / `loadFixturesFromDir`. They return the LLM
 * fixtures and the raw `mcpFakes` blocks with their entry-id `source` (I6).
 *
 * They live outside fixture-loader.ts because they validate blocks with
 * `validateMcpFakes`, and mcp-fakes.ts imports `FixtureLoadError` from
 * fixture-loader.ts at module load (`McpFakesAddError extends
 * FixtureLoadError`): a value import of mcp-fakes.ts from fixture-loader.ts
 * is an import cycle that leaves `FixtureLoadError` uninitialized whenever
 * fixture-loader.ts is loaded first.
 */
import { join } from "node:path";
import type { LiveOptions } from "./live-types.js";
import type { Logger } from "./logger.js";
import {
  fixturesOf,
  hasMcpFakesKey,
  listFixtureDir,
  readFixtureJson,
  type FixtureLoadError,
} from "./fixture-loader.js";
import { McpFakesAddError, validateMcpFakes, type McpFakeIssue } from "./mcp-fakes.js";
import type { Fixture, McpFakeSource } from "./types.js";

/** What {@link loadFixtureFileWithServices} and {@link loadFixturesFromDirWithServices} return. */
export interface FixturesWithServices {
  /** LLM fixtures, as the old loaders return them. */
  fixtures: Fixture[];
  /**
   * The raw `mcpFakes` blocks, one per block, in load order, each with its
   * entry-id `source` (spec I6) and `blockIndex` (`null` for the
   * single-object form). Validated per file; checks across files and loads
   * (entry-id collisions) happen when a mount adds them.
   */
  mcpFakes: McpFakeSource[];
  /** Shadowed-entry warnings (L8) of those blocks, for the caller to print. */
  mcpFakeWarnings: McpFakeIssue[];
  /**
   * The entry-id `source` (I6) of each file that could not be read or was
   * not valid JSON. Such a file is warned and skipped, as before, so it adds
   * no fixtures and no blocks; a `--watch` reload uses this list to tell a
   * file it could not parse from a file whose `mcpFakes` were removed.
   */
  unreadable: string[];
}

/** A load in progress: the result, plus every bad-block error of every file. */
interface ServicesLoad {
  out: FixturesWithServices;
  errors: FixtureLoadError[];
}

/**
 * Load one parsed file into `load.out`: its `mcpFakes` blocks under
 * `source`, then its LLM fixtures. A file with a bad block adds nothing; its
 * errors go to `load.errors`, and the load goes on so every bad block of
 * every file is reported (fail-loud rule, spec 5.4; L3). Its L8 warnings are
 * kept either way.
 */
function loadServicesFile(
  filePath: string,
  source: string,
  load: ServicesLoad,
  logger: Logger | undefined,
  liveOptions: LiveOptions | undefined,
): void {
  const { out } = load;
  const read = readFixtureJson(filePath, logger);
  if (read === null) {
    out.unreadable.push(source);
    return;
  }
  const parsed = read.value;
  const withFakes = hasMcpFakesKey(parsed);
  if (withFakes) {
    const raw = parsed.mcpFakes;
    const validation = validateMcpFakes(raw, source);
    out.mcpFakeWarnings.push(...validation.warnings);
    if (validation.errors.length > 0) {
      load.errors.push(...validation.errors);
      return;
    }
    if (Array.isArray(raw)) {
      raw.forEach((block: unknown, blockIndex: number) => {
        out.mcpFakes.push({ source, blockIndex, raw: block });
      });
    } else {
      out.mcpFakes.push({ source, blockIndex: null, raw });
    }
  }
  out.fixtures.push(...fixturesOf(parsed, filePath, logger, liveOptions, withFakes));
}

/**
 * The result of a finished load, or its errors thrown: the one
 * `FixtureLoadError` alone, else a `McpFakesAddError` holding every error and
 * the L8 warnings, so no warning is lost when the load fails.
 */
function finish(load: ServicesLoad): FixturesWithServices {
  const { out, errors } = load;
  const [first] = errors;
  if (first === undefined) return out;
  if (errors.length === 1 && out.mcpFakeWarnings.length === 0) throw first;
  throw new McpFakesAddError(errors, out.mcpFakeWarnings);
}

function newLoad(): ServicesLoad {
  return { out: { fixtures: [], mcpFakes: [], mcpFakeWarnings: [], unreadable: [] }, errors: [] };
}

/**
 * Load one fixture file: its LLM fixtures and its `mcpFakes` blocks. A
 * fakes-only file is accepted. The blocks' `source` (spec I6) is `filePath`
 * as given, or `sourceLabel` when set (the URL of a remote fixture file).
 * A bad block throws a `FixtureLoadError` (a `McpFakesAddError` when there
 * is more than one error, or L8 warnings to keep with it).
 */
export function loadFixtureFileWithServices(
  filePath: string,
  logger?: Logger,
  liveOptions?: LiveOptions,
  sourceLabel?: string,
): FixturesWithServices {
  const load = newLoad();
  loadServicesFile(filePath, sourceLabel ?? filePath, load, logger, liveOptions);
  return finish(load);
}

function loadServicesDir(
  dirPath: string,
  relDir: string,
  load: ServicesLoad,
  logger: Logger | undefined,
  liveOptions: LiveOptions | undefined,
): void {
  const listing = listFixtureDir(dirPath, logger);
  if (listing === null) return;
  for (const name of listing.jsonFiles) {
    loadServicesFile(join(dirPath, name), relDir + name, load, logger, liveOptions);
  }
  for (const sub of listing.subdirs) {
    loadServicesDir(join(dirPath, sub), `${relDir}${sub}/`, load, logger, liveOptions);
  }
}

/**
 * Load every `.json` file under `dirPath` (sorted, then subdirectories, at
 * full depth, as {@link loadFixturesFromDir}): LLM fixtures and `mcpFakes`
 * blocks. Each block's `source` (spec I6) is its file's path relative to
 * `dirPath`, with `/` separators. Every file is checked before anything is
 * thrown: the bad blocks of all files are reported together, as in
 * {@link loadFixtureFileWithServices}.
 */
export function loadFixturesFromDirWithServices(
  dirPath: string,
  logger?: Logger,
  liveOptions?: LiveOptions,
): FixturesWithServices {
  const load = newLoad();
  loadServicesDir(dirPath, "", load, logger, liveOptions);
  return finish(load);
}
