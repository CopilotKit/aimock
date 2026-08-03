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
 * Both renames left the collector's prose pointing at the old name/location.
 *
 * So this test makes the audit trail STRUCTURAL rather than a matter of
 * remembering to grep. Rename a frozen surface without updating its remediation
 * prose and this goes red.
 *
 * WHAT IS AND IS NOT REQUIRED TO CARRY A CITATION
 * -----------------------------------------------
 * `scripts/drift-report-collector.ts` is HAND-WRITTEN and stable: its alert
 * strings are the pipeline's permanent remediation prose, so it MUST keep
 * yielding "<symbol> in <file>" pairs, and a citation that stops being
 * extractable is itself a failure (see the vacuity guards).
 *
 * `drift-proposals/*.md` are the OPPOSITE: drift-sync WRITES them mechanically,
 * a human may hand-annotate them, and `fb9d9c5`-style cleanups legitimately
 * DELETE them once resolved — the directory is routinely empty and is not even
 * tracked when it holds no notes. A freshly generated note cites no symbol at
 * all (see `renderProposalNote`), so requiring one to yield a pair turns the very
 * next needs-human PR red with a false "prose was removed" message, and pinning
 * the pair-count floor to note-borne pairs makes deleting a resolved note fail.
 * They are therefore scanned OPPORTUNISTICALLY: whatever citation a note does
 * carry must resolve, and no note may name a retired symbol, but a note is never
 * required to carry a citation and an absent/empty directory is not an error.
 *
 * The "accepts valid input" describe block at the bottom is the standing proof of
 * that: it runs this guard's own predicates against a REAL drift-sync-generated
 * note, an empty notes directory, and an absent one, and requires all three to
 * be accepted.
 *
 * Scope note: only camelCase / dotted / SCREAMING identifiers are treated as
 * symbol references. A lowercase English word before "in <file>" ("single source
 * of truth in surface-registry.ts") is prose, not a symbol reference.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renderProposalNote, DRIFT_PROPOSALS_DIR } from "../../scripts/drift-sync.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** A file whose prose is scanned. `label` is what failure messages name. */
interface Surface {
  label: string;
  abs: string;
}

/**
 * Hand-written surfaces that instruct a human to edit a named symbol in a named
 * file. These MUST yield at least one pair — add a surface here when it starts
 * carrying that kind of instruction. Auto-generated or deletable files do NOT
 * belong here; see the module docstring.
 */
const COLLECTOR_SURFACE = "scripts/drift-report-collector.ts";

const REQUIRED_SURFACES: Surface[] = [
  { label: COLLECTOR_SURFACE, abs: join(repoRoot, COLLECTOR_SURFACE) },
];

/**
 * List the needs-human note directory, tolerating both an EMPTY directory and an
 * ABSENT one. Git tracks no empty directories, so once the last resolved note is
 * deleted the directory itself disappears — a bare `readdirSync` there throws
 * ENOENT at module scope and takes every test in this file down with it as a
 * collection error, which is a false red AND a total loss of coverage.
 */
function listNoteSurfaces(dirAbs: string, label: string): Surface[] {
  let names: string[];
  try {
    names = readdirSync(dirAbs);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ label: `${label}/${f}`, abs: join(dirAbs, f) }));
}

/** Opportunistically-scanned surfaces: never required to carry a citation. */
const OPTIONAL_SURFACES: Surface[] = listNoteSurfaces(
  join(repoRoot, DRIFT_PROPOSALS_DIR),
  DRIFT_PROPOSALS_DIR,
);

const ALL_SURFACES: Surface[] = [...REQUIRED_SURFACES, ...OPTIONAL_SURFACES];

/** Must this surface yield at least one "<symbol> in <file>" pair? */
function requiresPair(surface: Surface): boolean {
  return REQUIRED_SURFACES.some((r) => r.label === surface.label);
}

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

function collectPairs(surfaces: Surface[]): Pair[] {
  const pairs: Pair[] = [];
  for (const surface of surfaces) {
    const src = flatten(readFileSync(surface.abs, "utf8"));
    for (const m of src.matchAll(SYMBOL_IN_FILE)) {
      if (!isSymbolShaped(m[1])) continue;
      pairs.push({ surface: surface.label, symbol: m[1], file: m[2] });
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

/** `<line-number>: <text>` for every line of `surface` naming `symbol`. */
function symbolHits(surface: Surface, symbol: string): string[] {
  const re = new RegExp(`\\b${symbol}\\b`);
  return readFileSync(surface.abs, "utf8")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => re.test(line))
    .map(({ n, line }) => `${n}: ${line.trim()}`);
}

/** `<line-number>: <text>` for every line carrying a Prettier-bolded `__tests__`. */
function mangledTestPathLines(surface: Surface): string[] {
  return readFileSync(surface.abs, "utf8")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\*\*tests\*\*/.test(line))
    .map(({ n, line }) => `${n}: ${line.trim()}`);
}

const pairs = collectPairs(ALL_SURFACES);
const requiredPairs = pairs.filter((p) => REQUIRED_SURFACES.some((r) => r.label === p.surface));

describe("drift remediation strings point at symbols that exist", () => {
  // Vacuity guards. Every per-pair case below is generated FROM the extraction,
  // so an extraction that quietly matched nothing would report a green suite with
  // no cases at all. These assertions are what make the generated cases mean
  // something — and they are pinned to the REQUIRED surfaces only, so deleting a
  // resolved needs-human note can never trip them.
  it("has at least one required surface to scan", () => {
    expect(REQUIRED_SURFACES.map((s) => s.label)).not.toHaveLength(0);
  });

  it("finds the symbol-and-file pairs it is meant to guard", () => {
    expect(
      requiredPairs.map((p) => `${p.surface}: ${p.symbol} in ${p.file}`),
      `The hand-written remediation surfaces yielded fewer than 3 "<symbol> in ` +
        `<file>" pairs. Either the prose was removed, or a citation was reshaped ` +
        `into something the extraction no longer recognises — which silently ` +
        `drops it from this guard instead of failing it.`,
    ).toHaveLength(requiredPairs.length);
    expect(requiredPairs.length).toBeGreaterThanOrEqual(3);
  });

  for (const surface of REQUIRED_SURFACES) {
    it(`${surface.label} still contributes at least one pair`, () => {
      expect(
        pairs.filter((p) => p.surface === surface.label).map((p) => `${p.symbol} in ${p.file}`),
        `No "<symbol> in <file>" pair was extracted from ${surface.label}. Either ` +
          `its remediation prose was removed, or the citation was reshaped into ` +
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
  for (const surface of ALL_SURFACES) {
    it(`${surface.label} spells __tests__ literally`, () => {
      expect(
        mangledTestPathLines(surface),
        `${surface.label} contains \`**tests**\` — a Prettier-bolded \`__tests__\`. ` +
          `The cited path does not exist. Restore the underscores (backtick the ` +
          `path) and keep the file out of Prettier's reach.`,
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
 * would still rot silently. Listing the retired names closes that gap for every
 * surface scanned by this file — hand-written AND opportunistic.
 *
 * Scanning the notes for retired names cannot produce a false positive: a
 * drift-sync-generated note never contains one (proved below), so a hit is always
 * a human who hand-wrote a symbol that no longer exists.
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
    for (const surface of ALL_SURFACES) {
      it(`${surface.label} no longer references ${retired}`, () => {
        expect(
          symbolHits(surface, retired),
          `"${retired}" no longer exists — it is now ${replacement}. Any drift ` +
            `report field or alert string still using the old name sends the ` +
            `reader after a symbol that is not in the codebase.`,
        ).toEqual([]);
      });
    }
  }
});

/**
 * KNOWN-NEGATIVE CONTROLS — the guard must ACCEPT the input it is supposed to
 * accept, not merely reject bad input.
 *
 * The version of this guard that shipped in `6614bb2` was only ever run against
 * a tree whose two notes happened to be hand-annotated with citations. It was
 * never shown to accept a note as drift-sync actually writes them, nor an empty
 * notes directory, nor an absent one — and it in fact rejected all three. These
 * cases are standing assertions so that regression cannot recur.
 */
describe("the guard accepts the input it is supposed to accept", () => {
  /** A note exactly as drift-sync writes it — the REAL renderer, not a mock. */
  function freshGeneratedNote(dirAbs: string): Surface {
    const abs = join(dirAbs, "openai-gpt-nova-new-family.md");
    writeFileSync(
      abs,
      renderProposalNote(
        "openai",
        "gpt-nova",
        "new-family",
        "This model family appeared in a live /models listing but matches no " +
          "classification rule (include, exclude, -preview, gemma). drift-sync never " +
          "silently classifies a new family.",
        "2026-08-03",
      ),
      "utf-8",
    );
    return { label: `${DRIFT_PROPOSALS_DIR}/openai-gpt-nova-new-family.md`, abs };
  }

  it("accepts a note exactly as drift-sync generates it", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-remediation-note-"));
    try {
      const note = freshGeneratedNote(dir);

      // A generated note cites no symbol — that is CORRECT, not a removed
      // citation, so it must not be required to yield a pair.
      expect(
        collectPairs([note]),
        `drift-sync's generated note template now yields a "<symbol> in <file>" ` +
          `pair. That is fine, but it means the template changed — re-read the ` +
          `module docstring before assuming notes are still citation-free.`,
      ).toEqual([]);
      expect(
        requiresPair(note),
        `A drift-proposals note is being REQUIRED to carry a citation. Generated ` +
          `notes carry none, so the next needs-human PR would go red with a false ` +
          `"prose was removed" message.`,
      ).toBe(false);

      // And it must clear every check that IS applied to it.
      expect(mangledTestPathLines(note)).toEqual([]);
      for (const retired of Object.keys(RETIRED_SYMBOLS)) {
        expect(symbolHits(note, retired)).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an EMPTY notes directory (every note was resolved and deleted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-remediation-empty-"));
    try {
      expect(listNoteSurfaces(dir, DRIFT_PROPOSALS_DIR)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an ABSENT notes directory (git tracks no empty directory)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-remediation-absent-"));
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
    // Must not throw: at module scope a throw here is a COLLECTION error that
    // takes every test in this file with it.
    expect(listNoteSurfaces(dir, DRIFT_PROPOSALS_DIR)).toEqual([]);
  });

  it("still has required coverage when there are no notes at all", () => {
    // The floor and the per-surface pair requirement must be satisfiable with the
    // notes directory contributing nothing.
    expect(collectPairs(REQUIRED_SURFACES).length).toBeGreaterThanOrEqual(3);
  });
});
