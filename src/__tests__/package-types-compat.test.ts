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
 * own `setReplaySpeed` member of another type.
 *
 * Needs the build (`pnpm build`; CI builds before `pnpm test`). Skipped
 * locally when `dist/` is missing; under CI a missing `dist/` fails.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
};
const BUILT = existsSync(resolve(REPO_ROOT, "dist/index.d.ts"));
const TSC = resolve(REPO_ROOT, "node_modules/typescript/bin/tsc");

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

// B11: a user Mountable with its own \`setReplaySpeed\` member of another type.
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

describe.skipIf(!BUILT && !process.env.CI)("packed package types (strict consumer)", () => {
  let tmp = "";
  let consumer = "";

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aimock-pack-types-"));
    const packed = run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", tmp],
      REPO_ROOT,
    );
    expect(packed.code, packed.out).toBe(0);
    const jsonStart = packed.stdout.indexOf("[");
    const [{ filename }] = JSON.parse(packed.stdout.slice(jsonStart)) as { filename: string }[];

    consumer = join(tmp, "consumer");
    const pkgDir = join(consumer, "node_modules", ...PKG.name.split("/"));
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
    writeFileSync(join(consumer, "fakes-handle.ts"), FAKES_HANDLE);
  }, 120_000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("covers every exports entry point", () => {
    expect(SPECIFIERS).toContain(PKG.name);
    expect(SPECIFIERS.length).toBe(Object.keys(PKG.exports).length);
  });

  it("type-checks with strict and skipLibCheck: false", () => {
    const tsc = run(process.execPath, [TSC, "-p", consumer], consumer);
    expect(tsc.out).toBe("");
    expect(tsc.code).toBe(0);
  }, 120_000);
});
