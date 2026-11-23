import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adaptLegacyCollector,
  readerDiffers,
  overlayReader,
  READER_FILES,
} from "../../scripts/drift-agui-baseline.js";

const LEGACY_CLASSIFIER =
  'export function classifyAgUiCheckout(agUiPath: string): AgUiCheckoutStatus {\n  let isDir = false;\n  try {\n    isDir = existsSync(agUiPath) && statSync(agUiPath).isDirectory();\n  } catch (statErr: unknown) {\n    const msg = statErr instanceof Error ? statErr.message : String(statErr);\n    return {\n      kind: "incomplete",\n      reason: `could not stat AG-UI repo path ${agUiPath}: ${msg}`,\n    };\n  }\n  if (!isDir) return { kind: "absent" };\n  if (!existsSync(resolve(agUiPath, AGUI_CANONICAL_TYPES_RELPATH))) {\n    return {\n      kind: "incomplete",\n      reason:\n        `${agUiPath} exists but ${AGUI_CANONICAL_TYPES_RELPATH} is missing \u2014 the canonical ` +\n        `AG-UI checkout is STALE or INCOMPLETE. This is not a git/network failure: remove the ` +\n        `directory and re-clone (git clone --depth 1 https://github.com/ag-ui-protocol/ag-ui.git).`,\n    };\n  }\n  return { kind: "ok" };\n}';
const COLLECTOR =
  'import { execSync } from "node:child_process";\n' +
  LEGACY_CLASSIFIER +
  "\nconst unrelatedBasePolicy = 42;\n";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "agui-baseline-"));
  roots.push(path);
  return path;
}
function put(root: string, file: string, source: string): void {
  const path = join(root, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source);
}

describe("AG-UI migration baseline bootstrap", () => {
  it("changes only the known classifier and one import, not unrelated HEAD collector code", () => {
    const result = adaptLegacyCollector(COLLECTOR);
    expect(result).toContain("discoverAgUiSources(agUiPath)");
    expect(result).toContain("resolveAgUiRepo(agUiPath)");
    const oldTail = COLLECTOR.slice(COLLECTOR.indexOf("\nconst unrelatedBasePolicy"));
    expect(result.endsWith(oldTail)).toBe(true);
    expect(result).not.toContain("unrelatedHeadPolicy");
  });
  it.each(["missing", "duplicate", "changed"])("fails closed for %s classifier", (mode) => {
    const input =
      mode === "missing"
        ? "nothing"
        : mode === "duplicate"
          ? COLLECTOR + LEGACY_CLASSIFIER
          : COLLECTOR.replace("let isDir = false", "let isDir = true");
    expect(() => adaptLegacyCollector(input)).toThrow(/unsupported|ambiguous/);
  });
  it("detects missing or different tooling so cached old-reader results cannot be reused", () => {
    const head = root(),
      base = root();
    for (const file of READER_FILES) put(head, file, "candidate tooling");
    expect(readerDiffers(head, base)).toBe(true);
    for (const file of READER_FILES) put(base, file, "candidate tooling");
    expect(readerDiffers(head, base)).toBe(false);
    put(base, READER_FILES[1], "old suite");
    expect(readerDiffers(head, base)).toBe(true);
  });
  it("copies exactly reader tooling and preserves BASE product and all unrelated collector bytes", () => {
    const head = root(),
      base = root();
    for (const file of READER_FILES) put(head, file, "candidate tooling " + file);
    put(head, "scripts/drift-report-collector.ts", "unrelatedHeadPolicy");
    put(base, "scripts/drift-report-collector.ts", COLLECTOR);
    put(base, "src/agui-types.ts", "BASE product types");
    put(base, "src/providers.ts", "BASE provider");
    overlayReader(head, base);
    for (const file of READER_FILES)
      expect(readFileSync(join(base, file), "utf8")).toBe(readFileSync(join(head, file), "utf8"));
    expect(readFileSync(join(base, "src/agui-types.ts"), "utf8")).toBe("BASE product types");
    expect(readFileSync(join(base, "src/providers.ts"), "utf8")).toBe("BASE provider");
    expect(readFileSync(join(base, "scripts/drift-report-collector.ts"), "utf8")).toBe(
      adaptLegacyCollector(COLLECTOR),
    );
  });
  it("does not write any tooling when BASE classifier is unsupported", () => {
    const head = root(),
      base = root();
    for (const file of READER_FILES) {
      put(head, file, "head");
      put(base, file, "base");
    }
    put(base, "scripts/drift-report-collector.ts", "unsupported collector");
    expect(() => overlayReader(head, base)).toThrow();
    for (const file of READER_FILES) expect(readFileSync(join(base, file), "utf8")).toBe("base");
  });
});
