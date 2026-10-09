/**
 * C12 (r2 N1, r3 N4): `aimockVersion()` reads the nearest @copilotkit/aimock
 * package.json lazily, never at import, and never throws. Without one it
 * returns "unknown" and warns once.
 *
 * (b)-(d) run the BUILT `dist/` from script files in a temp directory (not
 * `node -e`, review r3 R3-1); they are skipped when `dist/` is missing or
 * older than `src/version.ts` (run `pnpm build`).
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aimockVersion } from "../version.js";
import { REPO_ROOT } from "./mcp-fakes-harness.js";

const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as { version: string }
).version;
const DIST = resolve(REPO_ROOT, "dist");
const DIST_CURRENT =
  existsSync(join(DIST, "version.js")) &&
  existsSync(join(DIST, "version.cjs")) &&
  statSync(join(DIST, "version.js")).mtimeMs >=
    statSync(resolve(REPO_ROOT, "src/version.ts")).mtimeMs;

function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const cp = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    cp.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    cp.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    cp.on("error", rej);
    cp.on("close", (code) => res({ code, stdout, stderr }));
  });
}

describe("C12: aimockVersion", () => {
  it("(a) from src/ it is package.json's version", () => {
    expect(aimockVersion()).toBe(PKG_VERSION);
  });

  describe.skipIf(!DIST_CURRENT)("the built dist/", () => {
    let tmp = "";
    let app = "";

    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), "aimock-version-"));
      // r4 advisory: the WHOLE dist/ (not one file), with no package.json above it.
      app = join(tmp, "app");
      mkdirSync(app, { recursive: true });
      cpSync(DIST, join(app, "dist"), { recursive: true });
    });

    afterAll(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it("(b) ESM import and CJS require of the repo's dist/ print the version from another cwd", async () => {
      const cwd = mkdtempSync(join(tmp, "cwd-"));
      writeFileSync(
        join(cwd, "t.mjs"),
        `import { aimockVersion } from ${JSON.stringify(join(DIST, "version.js"))};\nconsole.log("VERSION=" + aimockVersion());\n`,
      );
      writeFileSync(
        join(cwd, "t.cjs"),
        `const { aimockVersion } = require(${JSON.stringify(join(DIST, "version.cjs"))});\nconsole.log("VERSION=" + aimockVersion());\n`,
      );
      for (const script of ["t.mjs", "t.cjs"]) {
        const out = await run([script], cwd);
        expect(out.code, out.stderr).toBe(0);
        expect(out.stdout.trim()).toBe(`VERSION=${PKG_VERSION}`);
        expect(out.stderr).toBe("");
      }
    });

    it('(c) without a package.json: no throw, "unknown", and one warning for two calls', async () => {
      writeFileSync(
        join(tmp, "c.mjs"),
        `import { aimockVersion } from "./app/dist/version.js";\nconsole.log("A=" + aimockVersion());\nconsole.log("B=" + aimockVersion());\n`,
      );
      writeFileSync(
        join(tmp, "c.cjs"),
        `const { aimockVersion } = require("./app/dist/version.cjs");\nconsole.log("A=" + aimockVersion());\nconsole.log("B=" + aimockVersion());\n`,
      );
      for (const script of ["c.mjs", "c.cjs"]) {
        const out = await run([script], tmp);
        expect(out.code, out.stderr).toBe(0);
        expect(out.stdout.trim().split("\n")).toEqual(["A=unknown", "B=unknown"]);
        const warnings = out.stderr.trim().split("\n").filter(Boolean);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('aimockVersion "unknown"');
      }
    });

    it("(d) importing dist/mcp-mock.js (cli → server → mcp-mock → mcp-recorder → version) does not throw", async () => {
      writeFileSync(
        join(tmp, "d.mjs"),
        `const m = await import("./app/dist/mcp-mock.js");\nconsole.log("LOADED=" + typeof m.MCPMock);\n`,
      );
      writeFileSync(
        join(tmp, "d.cjs"),
        `const m = require("./app/dist/mcp-mock.cjs");\nconsole.log("LOADED=" + typeof m.MCPMock);\n`,
      );
      for (const script of ["d.mjs", "d.cjs"]) {
        const out = await run([script], tmp);
        expect(out.code, out.stderr).toBe(0);
        expect(out.stdout.trim()).toBe("LOADED=function");
        // Import never reads the version, so it never warns.
        expect(out.stderr).toBe("");
      }
    });
  });

  it("(e) a child Vitest run through the plugin-bad config still loads (r2 N1)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aimock-version-e-"));
    try {
      const good = join(tmp, "good.json");
      writeFileSync(good, JSON.stringify({ fixtures: [] }));
      const out = await run(
        [
          resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          resolve(REPO_ROOT, "src/__tests__/fixtures/mcp-fakes/plugin-bad/vitest.config.ts"),
          "vitest-plugin.case.ts",
        ],
        REPO_ROOT,
        { ...process.env, AIMOCK_PLUGIN_BAD_FIXTURE: good, CI: "1", NO_COLOR: "1" },
      );
      expect(out.code, out.stdout + out.stderr).toBe(0);
      expect(out.stdout).toMatch(/Tests\s+1 passed \(1\)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
