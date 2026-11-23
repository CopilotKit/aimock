/**
 * The PACKED package's type declarations compile in a strict consumer.
 *
 * `npm pack` the built package, unpack it into a temporary consumer project,
 * and type-check a consumer that imports every `exports` entry point (ESM and
 * CJS) under `"strict": true, "skipLibCheck": false`. This catches what only
 * the emitted `.d.ts` / `.d.cts` show, such as a module augmentation that the
 * bundler turns into a statement (`sideEffect();`, TS1036/TS2304).
 *
 * The consumer also holds 1.44.0 usage patterns that must keep compiling (no
 * breaking changes, type-only ones included): an exhaustive `switch` on
 * `McpFakeAddOrigin["kind"]` (a user `Mountable.addMcpFakes`), object
 * literals typed as the test plugins' `AimockHandle`, and a `Mountable` with its
 * own `setReplaySpeed` member of another type. It also holds a 1.45.1 pattern:
 * `ResponseOverrides.usage` with a provider key whose value is `unknown`.
 * The policy consumer checks the optional policy contract through both ESM
 * and CJS declarations, including direct handler and config overrides.
 *
 * Needs a current build (`pnpm build`; CI builds before `pnpm test`). The build
 * counts as current when every `dist/` file that `exports` and `typesVersions`
 * name exists, and the oldest of them is newer than every build input: the
 * non-test TypeScript sources under `src/`, package.json, the tsdown config and
 * the tsconfig files. Locally the packed-package suite is skipped, with a
 * printed reason, when the build is missing, partial or stale. Under CI it fails.
 *
 * The check that the hand-kept entry-point list matches package.json needs no
 * build and always runs.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./mcp-fakes-harness.js";

const PKG = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, unknown>;
  typesVersions?: Record<string, Record<string, string[]>>;
};
const TSC = resolve(REPO_ROOT, "node_modules/typescript/bin/tsc");

/** `CI` set to anything but empty, `0` or `false` (some tools set `CI=false`). */
const CI_VALUE = (process.env.CI ?? "").trim().toLowerCase();
const IN_CI = CI_VALUE !== "" && CI_VALUE !== "0" && CI_VALUE !== "false";

/** Newest mtime of the non-test sources the build reads. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") newest = Math.max(newest, newestSourceMtime(path));
    } else if (/\.[cm]?ts$/.test(entry.name) && !/\.test\.[cm]?ts$/.test(entry.name)) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

/** Every file path an `exports` value names, through nested conditions. */
function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(exportTargets);
}

/** Every `typesVersions` target as `[label, file]`, the label naming its map entry. */
function typesVersionsTargets(): Array<[string, string]> {
  return Object.entries(PKG.typesVersions ?? {}).flatMap(([range, paths]) =>
    Object.entries(paths).flatMap(([key, files]) =>
      files.map((file): [string, string] => [`${range} ${key}`, file]),
    ),
  );
}

/** The built files consumers resolve: every `exports` and `typesVersions` target. */
const BUILT_FILES = [
  ...new Set(
    [...exportTargets(PKG.exports), ...typesVersionsTargets().map(([, file]) => file)].map((f) =>
      f.replace(/^\.\//, ""),
    ),
  ),
].sort();

/** Build inputs outside `src/` that change the emitted files. */
const BUILD_CONFIG_FILES = readdirSync(REPO_ROOT).filter(
  (name) =>
    name === "package.json" || /^tsdown\.config\./.test(name) || /^tsconfig.*\.json$/.test(name),
);

/** Why the build under `dist/` cannot be checked, or undefined when it is current. */
function buildProblem(): string | undefined {
  if (!existsSync(resolve(REPO_ROOT, "dist"))) return "dist/ is missing; run `pnpm build`";
  const missing = BUILT_FILES.filter((f) => !existsSync(resolve(REPO_ROOT, f)));
  if (missing.length > 0) {
    return `the build is partial (missing ${missing.join(", ")}); run \`pnpm build\``;
  }
  const oldestBuilt = Math.min(...BUILT_FILES.map((f) => statSync(resolve(REPO_ROOT, f)).mtimeMs));
  if (newestSourceMtime(resolve(REPO_ROOT, "src")) > oldestBuilt) {
    return "dist/ is older than src/; run `pnpm build`";
  }
  const newerConfig = BUILD_CONFIG_FILES.filter(
    (name) => statSync(resolve(REPO_ROOT, name)).mtimeMs > oldestBuilt,
  );
  if (newerConfig.length > 0) {
    return `dist/ is older than ${newerConfig.join(", ")}; run \`pnpm build\``;
  }
  return undefined;
}
const BUILD_PROBLEM = buildProblem();
if (BUILD_PROBLEM && !IN_CI) {
  // Written to stderr directly: the suite config sets `silent`, which hides console.
  process.stderr.write(`package-types-compat: skipped, ${BUILD_PROBLEM}\n`);
}

/**
 * The `exports` entry points, maintained by hand so that adding, removing or
 * renaming one in package.json has to be reflected here.
 */
const EXPECTED_ENTRY_POINTS = [".", "./a2a", "./agui", "./jest", "./mcp", "./vector", "./vitest"];

describe("package.json entry points", () => {
  it("match the hand-kept list (no build needed)", () => {
    expect(Object.keys(PKG.exports).sort()).toEqual(EXPECTED_ENTRY_POINTS);
  });
});

/** Every `exports` entry point as an import specifier. */
const SPECIFIERS = Object.keys(PKG.exports).map((key) =>
  key === "." ? PKG.name : `${PKG.name}/${key.replace(/^\.\//, "")}`,
);

const TSCONFIG = {
  compilerOptions: {
    target: "es2022",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: ["node"],
    noFallthroughCasesInSwitch: true,
  },
  include: ["*.ts", "*.cts"],
};

/** Imports every entry point through the `import` condition (`.d.ts`). */
const ENTRY_ESM = SPECIFIERS.map((s, i) => `import * as e${i} from ${JSON.stringify(s)};`)
  .concat(`export const entries = [${SPECIFIERS.map((_, i) => `e${i}`).join(", ")}];`)
  .join("\n");

/** Imports every entry point through the `require` condition (`.d.cts`). */
const ENTRY_CJS = SPECIFIERS.map((s, i) => `import e${i} = require(${JSON.stringify(s)});`)
  .concat(`export const entries = [${SPECIFIERS.map((_, i) => `e${i}`).join(", ")}];`)
  .join("\n");

/** Usage that compiles against the published 1.44.0 and must keep compiling. */
const COMPAT_1_44 = `
import type * as http from "node:http";
import {
  LLMock,
  type McpFakeAddOrigin,
  type McpFakeAddResult,
  type McpFakeSource,
  type Mountable,
} from "${PKG.name}";
import type { AimockHandle as VitestHandle } from "${PKG.name}/vitest";
import type { AimockHandle as JestHandle } from "${PKG.name}/jest";

function assertNever(x: never): never {
  throw new Error(String(x));
}

// A user Mountable switches exhaustively on the origin kind it receives.
export function originLabel(origin: McpFakeAddOrigin): string {
  switch (origin.kind) {
    case "file":
      return "file";
    case "code":
      return "code";
    case "control-api":
      return "control-api";
    default:
      return assertNever(origin.kind);
  }
}

export class MyMount implements Mountable {
  async handleRequest(
    _req: http.IncomingMessage,
    _res: http.ServerResponse,
    _p: string,
  ): Promise<boolean> {
    return false;
  }
  addMcpFakes(_blocks: McpFakeSource[], origin: McpFakeAddOrigin): McpFakeAddResult {
    originLabel(origin);
    return { warnings: [] };
  }
}

// A user Mountable with its own \`setReplaySpeed\` member of another type.
export class SpeedMount {
  setReplaySpeed = "fast";
  async handleRequest(
    _req: http.IncomingMessage,
    _res: http.ServerResponse,
    _p: string,
  ): Promise<boolean> {
    return false;
  }
}
export const speedMount: Mountable = new SpeedMount();

// A wrapper builds its own test-plugin handle.
const llm = new LLMock();
export const vitestHandle: VitestHandle = { llm, url: "http://127.0.0.1:0" };
export const jestHandle = { llm, url: "http://127.0.0.1:0" } satisfies JestHandle;
`;

/**
 * Usage that compiles against the published 1.45.1 and must keep compiling:
 * fixture usage carries provider keys the type does not name (for example
 * Anthropic cache counters) through its index signature, with values of any
 * type.
 */
const COMPAT_1_45_1 = `
import type { ResponseOverrides } from "${PKG.name}";

const u: unknown = 1;
export const o: ResponseOverrides = { usage: { cache_read_input_tokens: u } };
`;

/** The approved optional policy contract, compiled in ESM and CJS consumers. */
const POLICY_CONSUMER = `
import {
  LLMock,
  createServer,
  handleMessages,
  startFromConfig,
  type AimockConfig,
  type AimockPolicy,
  type MockServerOptions,
} from "${PKG.name}";

export const policy: AimockPolicy = { requiredHeaders: "enforce" };
export const off: AimockPolicy = { requiredHeaders: "off" };
export const omitted: AimockPolicy = {};
export const options: MockServerOptions = { policy };
export const mock = new LLMock(options);
export const oldMock = new LLMock({});
export const server = createServer([], options);
export const oldServer = createServer([], {});
export const config: AimockConfig = { llm: { policy } };
export const oldConfig: AimockConfig = {};
export const override: NonNullable<Parameters<typeof startFromConfig>[1]> = { policy };
export const oldOverride: NonNullable<Parameters<typeof startFromConfig>[1]> = {};
export const fromConfig = startFromConfig(config, override);
export const oldFromConfig = startFromConfig(oldConfig, oldOverride);
export function handlerDefaults(
  defaults: Parameters<typeof handleMessages>[5],
): Parameters<typeof handleMessages>[5] {
  return { ...defaults, policy };
}
`;

/** The additive MCP fakes handle of the test plugins. */
const FAKES_HANDLE = `
import {
  useAimock as useVitest,
  type AimockFakesHandle as VitestFakes,
  type AimockHandle as VitestHandle,
} from "${PKG.name}/vitest";
import {
  useAimock as useJest,
  type AimockFakesHandle as JestFakes,
  type AimockHandle as JestHandle,
} from "${PKG.name}/jest";

export function vitestGetter(): () => VitestFakes {
  return useVitest();
}
export function jestGetter(): () => JestFakes {
  return useJest();
}
export function asVitestHandle(h: VitestFakes): VitestHandle {
  void h.fakesFor("t");
  void h.fakesReport("t");
  return h;
}
export function asJestHandle(h: JestFakes): JestHandle {
  void h.fakesFor("t");
  void h.fakesReport("t");
  return h;
}
`;

function run(
  cmd: string,
  args: string[],
  cwd: string,
): { code: number | null; stdout: string; out: string } {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/** The tarball name from `npm pack --json`; a failure to read it shows npm's output. */
function packedFilename(stdout: string, out: string): string {
  const jsonStart = stdout.indexOf("[");
  let parsed: unknown;
  try {
    if (jsonStart < 0) throw new Error("no JSON array on stdout");
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch (err) {
    throw new Error(
      `could not parse the npm pack --json result (${(err as Error).message}); npm output:\n${out}`,
    );
  }
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  const filename =
    typeof first === "object" && first !== null && "filename" in first ? first.filename : undefined;
  if (typeof filename !== "string") {
    throw new Error(`the npm pack --json result names no filename; npm output:\n${out}`);
  }
  return filename;
}

describe.skipIf(BUILD_PROBLEM !== undefined && !IN_CI)(
  "packed package types (strict consumer)",
  () => {
    let tmp = "";
    let consumer = "";

    let pkgDir = "";

    beforeAll(() => {
      // Under CI the suite runs even when the build is missing or stale; fail clearly.
      expect(BUILD_PROBLEM, BUILD_PROBLEM).toBeUndefined();
      tmp = mkdtempSync(join(tmpdir(), "aimock-pack-types-"));
      const packed = run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", tmp],
        REPO_ROOT,
      );
      expect(packed.code, packed.out).toBe(0);
      const filename = packedFilename(packed.stdout, packed.out);

      consumer = join(tmp, "consumer");
      pkgDir = join(consumer, "node_modules", ...PKG.name.split("/"));
      mkdirSync(pkgDir, { recursive: true });
      const untar = run(
        "tar",
        ["-xzf", join(tmp, filename), "-C", pkgDir, "--strip-components=1"],
        tmp,
      );
      expect(untar.code, untar.out).toBe(0);

      // The declarations import only node: builtins; give the consumer @types/node.
      mkdirSync(join(consumer, "node_modules", "@types"), { recursive: true });
      symlinkSync(
        realpathSync(resolve(REPO_ROOT, "node_modules/@types/node")),
        join(consumer, "node_modules", "@types", "node"),
        "dir",
      );

      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ name: "aimock-types-consumer", private: true, type: "module" }),
      );
      writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2));
      writeFileSync(join(consumer, "entries.ts"), ENTRY_ESM);
      writeFileSync(join(consumer, "entries-cjs.cts"), ENTRY_CJS);
      writeFileSync(join(consumer, "compat-1.44.ts"), COMPAT_1_44);
      writeFileSync(join(consumer, "compat-1.45.1.ts"), COMPAT_1_45_1);
      writeFileSync(join(consumer, "policy.ts"), POLICY_CONSUMER);
      writeFileSync(join(consumer, "policy.cts"), POLICY_CONSUMER);
      writeFileSync(join(consumer, "fakes-handle.ts"), FAKES_HANDLE);
    }, 120_000);

    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    it("packs every file that exports and typesVersions name", () => {
      const missing: string[] = [];
      for (const [key, conditions] of Object.entries(PKG.exports)) {
        for (const file of exportTargets(conditions)) {
          if (!existsSync(join(pkgDir, file))) missing.push(`exports ${key} -> ${file}`);
        }
      }
      for (const [label, file] of typesVersionsTargets()) {
        if (!existsSync(join(pkgDir, file))) missing.push(`typesVersions ${label} -> ${file}`);
      }
      expect(missing).toEqual([]);
    });

    it("type-checks with strict and skipLibCheck: false", () => {
      const tsc = run(process.execPath, [TSC, "-p", consumer], consumer);
      expect(tsc.out).toBe("");
      expect(tsc.code).toBe(0);
    }, 120_000);
  },
);
