import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAgUiDriftEntries } from "../../scripts/drift-report-collector.js";
import { discoverAgUiSources, parseGeneratedAgUi } from "../../scripts/drift-agui-canonical.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function checkout(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "agui-canonical-"));
  roots.push(root);
  const core = join(root, "sdks/typescript/packages/core/src");
  mkdirSync(join(core, "generated"), { recursive: true });
  for (const file of files) writeFileSync(join(core, file), "// canonical source\n");
  return root;
}
const types = 'export enum EventType { RUN_STARTED = "RUN_STARTED" }';
describe("AG-UI canonical source discovery", () => {
  it("requires both generated sources", () => {
    const root = checkout(["generated/types.ts"]);
    expect(discoverAgUiSources(root)).toBeNull();
    writeFileSync(join(root, "sdks/typescript/packages/core/src/generated/schemas.ts"), "");
    expect(discoverAgUiSources(root)?.layout).toBe("generated");
  });
  it("requires actual legacy events and types, rather than one misleading sentinel", () => {
    expect(discoverAgUiSources(checkout(["types.ts"]))).toBeNull();
    expect(discoverAgUiSources(checkout(["types.ts", "events.ts"]))?.layout).toBe("legacy");
  });
});
describe("generated AG-UI schema parsing", () => {
  it("reads flat required, optional and aliased fields without nested false optionality", () => {
    const parsed = parseGeneratedAgUi(
      types,
      `
      export const OptionalName = z.string().optional();
      export const AliasName = OptionalName;
      export const RunStartedEventSchema = z.looseObject({
        type: z.literal(EventType.RUN_STARTED),
        threadId: z.string(),
        metadata: z.looseObject({ child: z.string().optional() }),
        requiredArray: z.array(z.string().optional()),
        aliased: AliasName,
        defaulted: z.string().default("x").transform(x => x),
        nullable: z.string().nullable(),
        optional: z.string().nullable().optional(),
      });`,
    );
    expect(parsed.types).toEqual(["RUN_STARTED"]);
    expect(parsed.schemas.get("RUN_STARTED")?.fields).toEqual([
      { name: "type", optional: false },
      { name: "threadId", optional: false },
      { name: "metadata", optional: false },
      { name: "requiredArray", optional: false },
      { name: "aliased", optional: true },
      { name: "defaulted", optional: true },
      { name: "nullable", optional: false },
      { name: "optional", optional: true },
    ]);
  });
  it("refuses missing validators, unsupported composition and cycles rather than losing fields", () => {
    expect(() => parseGeneratedAgUi(types, "")).toThrow(/RUN_STARTED/);
    expect(() =>
      parseGeneratedAgUi(types, "export const RunStartedEventSchema = z.intersection(a,b);"),
    ).toThrow(/Unsupported/);
    expect(() =>
      parseGeneratedAgUi(
        types,
        `const A = B; const B = A; export const RunStartedEventSchema = z.looseObject({type: z.literal(EventType.RUN_STARTED), value: A});`,
      ),
    ).toThrow(/cycle/);
  });
});

it("standalone canonical comparison fails when the explicit checkout is incomplete", () => {
  const root = checkout([]);
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      join(cwd, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/__tests__/drift/agui-",
      "--config",
      "vitest.config.drift.ts",
      "--maxWorkers=1",
      "--minWorkers=1",
    ],
    { cwd, env: { ...process.env, AGUI_REPO_PATH: root }, encoding: "utf8", timeout: 15000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("AG-UI canonical comparison unavailable");
});

it("unsupported generated schemas remain failed assertions visible to the collector", () => {
  const root = checkout(["generated/types.ts", "generated/schemas.ts"]);
  writeFileSync(join(root, "sdks/typescript/packages/core/src/generated/types.ts"), types);
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      join(cwd, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/__tests__/drift/agui-",
      "--config",
      "vitest.config.drift.ts",
      "--reporter=json",
      "--maxWorkers=1",
      "--minWorkers=1",
    ],
    {
      cwd,
      env: { ...process.env, AGUI_REPO_PATH: root },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.numFailedTests).toBeGreaterThan(0);
  expect(collectAgUiDriftEntries(report).quarantine.length).toBeGreaterThan(0);
});
