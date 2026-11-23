/// <reference types="node" />

/**
 * Regenerate the committed public API reports under etc/ with Microsoft API
 * Extractor. Run after `pnpm build`:
 *
 *   pnpm build && pnpm api:report
 *
 * One report per package.json#exports subpath x condition (for example
 * `etc/aimock-index.import.api.md` for `"."` / `import`), each extracted from
 * that condition's `types` file in dist/. Shared settings live in
 * api-extractor.json. Reports for entries that no longer exist are deleted.
 *
 * The script always writes the reports (API Extractor's local-build mode). CI
 * runs it and then diffs etc/ against the commit, so a public type change
 * fails until the updated reports are committed. Exits non-zero when API
 * Extractor reports an error or an export entry has no `types` file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
  type IConfigFile,
} from "@microsoft/api-extractor";

const ROOT = resolve(import.meta.dirname, "..");
const BASE_CONFIG = join(ROOT, "api-extractor.json");
const PACKAGE_JSON = join(ROOT, "package.json");
const REPORT_DIR = join(ROOT, "etc");
const REPORT_SUFFIX = ".api.md";

interface Entry {
  name: string;
  types: string;
}

function entries(): Entry[] {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { exports?: unknown };
  if (typeof pkg.exports !== "object" || pkg.exports === null) {
    throw new Error("package.json#exports must be an object of subpaths");
  }
  const out: Entry[] = [];
  for (const [subpath, conditions] of Object.entries(pkg.exports)) {
    if (typeof conditions !== "object" || conditions === null) {
      throw new Error(`package.json#exports["${subpath}"] must be an object of conditions`);
    }
    const slug = subpath === "." ? "index" : subpath.replace(/^\.\//, "").replace(/\//g, "-");
    for (const [condition, target] of Object.entries(conditions)) {
      const types = (target as { types?: unknown } | null)?.types;
      if (typeof types !== "string") {
        throw new Error(`package.json#exports["${subpath}"].${condition} has no "types" file`);
      }
      out.push({ name: `aimock-${slug}.${condition}`, types });
    }
  }
  return out;
}

function main(): number {
  const list = entries();
  // Read as plain JSON: ExtractorConfig.loadFile() validates the file on its
  // own and rejects it for lacking mainEntryPointFilePath, which is set per
  // entry below. prepare() validates each completed config.
  const base = JSON.parse(readFileSync(BASE_CONFIG, "utf8")) as IConfigFile;
  let failed = 0;
  mkdirSync(REPORT_DIR, { recursive: true });

  for (const entry of list) {
    const typesPath = join(ROOT, entry.types);
    if (!existsSync(typesPath)) {
      console.error(`api:report: ${entry.name}: ${entry.types} not found (run pnpm build first)`);
      failed++;
      continue;
    }
    const config = ExtractorConfig.prepare({
      configObject: {
        ...base,
        // prepare() does not resolve relative paths the way loadFile() does.
        projectFolder: ROOT,
        mainEntryPointFilePath: typesPath,
        apiReport: { ...base.apiReport, enabled: true, reportFileName: entry.name },
      },
      configObjectFullPath: BASE_CONFIG,
      packageJsonFullPath: PACKAGE_JSON,
    });
    const result = Extractor.invoke(config, {
      localBuild: true,
      messageCallback: (message) => {
        // Keep the output to warnings and errors; API Extractor's info lines
        // (analysis banners, "report is unchanged") repeat once per entry.
        if (
          message.logLevel === ExtractorLogLevel.Info ||
          message.logLevel === ExtractorLogLevel.Verbose
        ) {
          message.handled = true;
        }
      },
    });
    const state = result.errorCount > 0 ? "FAIL" : result.apiReportChanged ? "changed" : "ok";
    console.log(
      `api:report: ${entry.name}: ${state}` +
        ` (errors ${result.errorCount}, warnings ${result.warningCount})`,
    );
    if (result.errorCount > 0 || !result.succeeded) failed++;
  }

  const expected = new Set(list.map((e) => e.name + REPORT_SUFFIX));
  if (existsSync(REPORT_DIR)) {
    for (const file of readdirSync(REPORT_DIR)) {
      if (file.endsWith(REPORT_SUFFIX) && !expected.has(file)) {
        rmSync(join(REPORT_DIR, file));
        console.log(`api:report: removed stale etc/${file}`);
      }
    }
  }

  console.log(
    `api:report: ${list.length} entries, ${failed} failed; reports in etc/` +
      " (commit any change)",
  );
  return failed > 0 ? 1 : 0;
}

process.exit(main());
