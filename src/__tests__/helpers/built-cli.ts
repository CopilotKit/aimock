/**
 * Guard for tests that exercise a BUILT CLI in `dist/`. `pnpm test` does not
 * build (CI runs `pnpm build` first), so a missing or stale dist is reported as
 * a failure rather than skipped: a test cannot pass by not running, and its
 * result cannot describe an old build.
 *
 * "Stale" is measured against the newest `.ts` file anywhere under `src/`
 * (tests excluded), not against the CLI's own entry file: the CLI bundles the
 * whole library, so an edit to `chaos.ts` or `server.ts` after the last build
 * leaves `dist/cli.js` just as out of date as an edit to `cli.ts`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SRC_DIR = resolve(__dirname, "../..");
const TESTS_DIR = resolve(__dirname, "..");

/** The most recently edited library source file under `src/` (tests excluded). */
export function newestSourceFile(): { path: string; mtimeMs: number } {
  let newest = { path: "", mtimeMs: -Infinity };
  for (const entry of readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(entry.parentPath, entry.name);
    if (path === TESTS_DIR || path.startsWith(TESTS_DIR + sep)) continue;
    const { mtimeMs } = statSync(path);
    if (mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest;
}

/** Throw unless `cliPath` exists and was built after the last edit to any library source. */
export function assertBuiltCliIsCurrent(cliPath: string): void {
  const name = relative(resolve(SRC_DIR, ".."), cliPath);
  if (!existsSync(cliPath)) {
    throw new Error(`${name} is missing — run \`pnpm build\` before this test.`);
  }
  const source = newestSourceFile();
  if (statSync(cliPath).mtimeMs < source.mtimeMs) {
    throw new Error(
      `${name} was built before ${relative(resolve(SRC_DIR, ".."), source.path)} was last ` +
        `edited — run \`pnpm build\`. This test exercises the built artifact, so its result ` +
        `would describe the stale build rather than the current source.`,
    );
  }
}
