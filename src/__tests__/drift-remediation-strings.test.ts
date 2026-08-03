/**
 * The remediation strings in the drift pipeline are the ONLY instruction a human
 * gets when the daily drift job goes red: they arrive in a Slack alert (or the
 * auto-fix prompt) saying "add X to <symbol> in <file>". If the symbol was
 * renamed or the file moved, the reader chases a ghost — and nothing in CI
 * notices, because a string literal is never type-checked.
 *
 * That has now happened twice on the same string:
 *   - `knownModels` was renamed `knownVoiceModelFamilies` and moved out of
 *     `ws-realtime.drift.ts` into `src/__tests__/drift/voice-models.ts`;
 *   - `gaModels` was renamed `gaRealtimeModels` and moved to the same place.
 * Both renames left the collector's prose pointing at the old name/location, and
 * the hand-written EXCLUDE notes under `drift-proposals/` cite test paths in the
 * same shape.
 *
 * So this test makes the audit trail STRUCTURAL rather than a matter of
 * remembering to grep: every "<symbol> in <file>" pair that appears in the
 * scanned surfaces must resolve to a real file that really declares that symbol.
 * Rename a frozen surface without updating its remediation prose and this goes
 * red.
 *
 * Scope note: only camelCase / dotted / SCREAMING identifiers are treated as
 * symbol references. A lowercase English word before "in <file>" ("single source
 * of truth in surface-registry.ts") is prose, not a symbol reference.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Surfaces whose prose instructs a human to edit a named symbol in a named file.
 * Add a surface here when it starts carrying that kind of instruction.
 */
const SCANNED_SURFACES: string[] = [
  "scripts/drift-report-collector.ts",
  ...readdirSync(join(repoRoot, "drift-proposals"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join("drift-proposals", f)),
];

/**
 * Directories a bare filename (`ws-realtime.drift.ts`, with no directory part)
 * is resolved against, in order.
 */
const BARE_FILENAME_ROOTS = ["src/__tests__/drift", "src/__tests__", "scripts", "src"];

/** `<symbol> in <file>.ts`, allowing an optional "list"/"set" noun and backticks. */
const SYMBOL_IN_FILE =
  /([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*)\s+(?:list\s+|set\s+)?in\s+`?((?:[A-Za-z0-9_./-]*\/)?[A-Za-z0-9_.-]+\.ts)`?/g;

/**
 * Flatten a source file for prose scanning: join adjacent concatenated string
 * literals (`"… in " + "src/…"`) and unwrap hard-wrapped lines, so a pair split
 * across a line break is still seen as one pair.
 */
function flatten(src: string): string {
  return src.replace(/"\s*\+\s*\n?\s*"/g, "").replace(/\n\s*/g, " ");
}

/** A symbol reference is code-shaped if it is camelCase, dotted, or SCREAMING. */
function isSymbolShaped(token: string): boolean {
  return /[A-Z]/.test(token) || token.includes(".");
}

interface Pair {
  surface: string;
  symbol: string;
  file: string;
}

function collectPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const surface of SCANNED_SURFACES) {
    const src = flatten(readFileSync(join(repoRoot, surface), "utf8"));
    for (const m of src.matchAll(SYMBOL_IN_FILE)) {
      if (!isSymbolShaped(m[1])) continue;
      pairs.push({ surface, symbol: m[1], file: m[2] });
    }
  }
  return pairs;
}

/** Resolve a cited path to an on-disk file, or null when it resolves nowhere. */
function resolveCitedFile(cited: string): string | null {
  if (cited.includes("/")) {
    return existsSync(join(repoRoot, cited)) ? join(repoRoot, cited) : null;
  }
  for (const root of BARE_FILENAME_ROOTS) {
    const candidate = join(repoRoot, root, cited);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Does `file` DECLARE `symbol` (not merely mention it in a comment)? */
function declaresSymbol(file: string, symbol: string): boolean {
  // A dotted reference (`excludeFamilies.openai`) is satisfied by its head.
  const head = symbol.split(".")[0];
  const src = readFileSync(file, "utf8");
  const decl = new RegExp(
    `(?:export\\s+)?(?:declare\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${head}\\b`,
  );
  return decl.test(src);
}

const pairs = collectPairs();

describe("drift remediation strings point at symbols that exist", () => {
  // Vacuity guards. Every case below is generated FROM the extraction, so an
  // extraction that quietly matches nothing would report a green suite with no
  // cases at all. These two assertions are what make the generated cases mean
  // something.
  it("finds the symbol-and-file pairs it is meant to guard", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(5);
  });

  for (const surface of SCANNED_SURFACES) {
    it(`${surface} still contributes at least one pair`, () => {
      expect(
        pairs.filter((p) => p.surface === surface).map((p) => `${p.symbol} in ${p.file}`),
        `No "<symbol> in <file>" pair was extracted from ${surface}. Either its ` +
          `remediation prose was removed, or the citation was reshaped into ` +
          `something the extraction no longer recognises — which silently drops ` +
          `it from this guard.`,
      ).not.toHaveLength(0);
    });
  }
});

/**
 * The specific reshaping that already bit us: Prettier's markdown formatter
 * reads `__tests__` in prose as bold emphasis and rewrites it to a bolded
 * `tests`, so `src/__tests__/drift/voice-models.ts` turns into a path that does
 * not exist AND no longer matches the extraction above — so it would vanish from
 * the guard instead of failing it. `drift-proposals/` is in
 * `.prettierignore` to stop the rewrite at source; this asserts the outcome.
 */
describe("no scanned surface carries a Prettier-mangled test path", () => {
  for (const surface of SCANNED_SURFACES) {
    it(`${surface} spells __tests__ literally`, () => {
      const lines = readFileSync(join(repoRoot, surface), "utf8")
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\*\*tests\*\*/.test(line));
      expect(
        lines.map(({ n, line }) => `${n}: ${line.trim()}`),
        `${surface} contains \`**tests**\` — a Prettier-bolded \`__tests__\`. The ` +
          `cited path does not exist. Restore the underscores (backtick the path) ` +
          `and keep the file out of Prettier's reach.`,
      ).toEqual([]);
    });
  }
});

describe("every cited symbol-and-file pair resolves on disk", () => {
  for (const { surface, symbol, file } of pairs) {
    it(`${surface}: "${symbol} in ${file}" resolves`, () => {
      const resolved = resolveCitedFile(file);
      expect(
        resolved,
        `${surface} tells a human to edit "${symbol}" in "${file}", but that file ` +
          `does not exist. Remediation prose is the only instruction the drift ` +
          `alert carries — fix the path.`,
      ).not.toBeNull();

      expect(
        declaresSymbol(resolved as string, symbol),
        `${surface} tells a human to edit "${symbol}" in "${file}", but that file ` +
          `declares no such symbol — it was renamed or moved. Point the prose at ` +
          `the real symbol.`,
      ).toBe(true);
    });
  }
});

/**
 * Symbols that USED to name a drift-classification surface and no longer exist.
 * The pair check above only sees a symbol when the prose also names a file, so a
 * bare mention (`expected: "(not in knownModels set)"`, `path: "knownModels"`)
 * would still rot silently. Listing the retired names closes that gap.
 *
 * When you rename one of these surfaces again: add the OLD name here and update
 * every string that used it. The list is the record of what must no longer be
 * referenced.
 */
const RETIRED_SYMBOLS: Record<string, string> = {
  knownModels: "knownVoiceModelFamilies (src/__tests__/drift/voice-models.ts)",
  gaModels: "gaRealtimeModels (src/__tests__/drift/voice-models.ts)",
};

describe("drift remediation strings never name a retired symbol", () => {
  for (const [retired, replacement] of Object.entries(RETIRED_SYMBOLS)) {
    it(`scripts/drift-report-collector.ts no longer references ${retired}`, () => {
      const src = readFileSync(join(repoRoot, "scripts/drift-report-collector.ts"), "utf8");
      const hits = src
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => new RegExp(`\\b${retired}\\b`).test(line));
      expect(
        hits.map(({ n, line }) => `${n}: ${line.trim()}`),
        `"${retired}" no longer exists — it is now ${replacement}. Any drift ` +
          `report field or alert string still using the old name sends the reader ` +
          `after a symbol that is not in the codebase.`,
      ).toEqual([]);
    });
  }
});
