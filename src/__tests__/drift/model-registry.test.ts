/**
 * Unit test for the per-provider model-family registry shape, plus the §6.1c
 * builder/fixture cross-check.
 *
 * Part 1 (registry shape): the minimal invariant probe for model-registry.ts:
 *   - seeded families are normalization-consistent (membership works),
 *   - the provider-mode allowlist carries `gemini-interactions`,
 *   - no family appears in BOTH include and exclude for any provider.
 *
 * Part 2 (builder/fixture cross-check — §6.1c): every model id that aimock's
 * builders and fixtures reference must resolve, via normalizeModelFamily, to a
 * family that is either in includeFamilies for its provider (aimock mocks it)
 * or in excludeFamilies (retired/non-text/preview). Non-model "provider mode"
 * tokens (e.g. `gemini-interactions`) must appear on NON_MODEL_TOKENS. A stray
 * builder model id or a misclassified prose token must fail this test — never a
 * live crash in the drift job.
 *
 * The cross-check table is derived from:
 *   - `DEFAULT_MODELS` in src/server.ts (aimock's advertised /v1/models list)
 *   - Dated/versioned ids used in conformance and fixture-blocks tests
 *   - The `gemini-interactions` provider-mode token documented in README
 *
 * The table is intentionally static (no source scraping) so it exercises the
 * EXACT normalizeModelFamily + registry membership path the live drift check
 * relies on, with no live-key dependency.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeModelFamily } from "./model-family.js";
import {
  includeFamilies,
  excludeFamilies,
  deprecatedFamilies,
  isRecordedDeprecation,
  NON_MODEL_TOKENS,
  isClassifiedFamily,
  PREVIEW_FAMILY,
  GEMMA_FAMILY,
} from "./model-registry.js";

// ─── Part 1: registry shape invariants ───────────────────────────────────────

describe("model-registry", () => {
  it("include contains the normalized family of a mocked model id", () => {
    expect(includeFamilies.gemini.has(normalizeModelFamily("gemini-2.5-flash", "gemini"))).toBe(
      true,
    );
  });

  it("allowlists the gemini-interactions provider-mode token", () => {
    expect(NON_MODEL_TOKENS.has("gemini-interactions")).toBe(true);
  });

  it("no family appears in both include and exclude for any provider", () => {
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      const inc = includeFamilies[provider];
      const exc = excludeFamilies[provider];
      const overlap = [...inc].filter((f) => exc.has(f));
      expect(
        overlap,
        `provider ${provider} has families on both lists: ${overlap.join(", ")}`,
      ).toEqual([]);
    }
  });

  // ── the recorded-deprecation ledger ───────────────────────────────────────
  //
  // `deprecatedFamilies` is the one registry set drift-sync WRITES unattended,
  // and the one deliberately left out of `logic-pin.test.ts`'s membership
  // freeze (pinning it would make every append revert itself at gate-2). These
  // are the invariants that stand in for that pin. See the set's own doc.

  it("a recorded deprecation is always a family aimock actually mocks", () => {
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      const stray = [...deprecatedFamilies[provider]].filter(
        (f) => !includeFamilies[provider].has(f),
      );
      expect(
        stray,
        `deprecatedFamilies.${provider} records ${stray.join(", ")}, which ${
          stray.length === 1 ? "is" : "are"
        } not in includeFamilies.${provider}. The ledger records the retirement of a family ` +
          `aimock MOCKS; an entry with no include-side counterpart is either a typo or the ` +
          `remains of a half-finished cleanup (dropping a family means deleting it from BOTH ` +
          `sets in the same reviewed commit as the logic-pin re-pin).`,
      ).toEqual([]);
    }
  });

  it("recording a deprecation NEVER unclassifies the family — the mock keeps serving", () => {
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      for (const family of deprecatedFamilies[provider]) {
        expect(
          isClassifiedFamily(family, provider),
          `${provider}/${family} is recorded as deprecated and stopped being classified. ` +
            `Recording what the PROVIDER retired must never change what aimock serves.`,
        ).toBe(true);
      }
    }
  });

  it("isRecordedDeprecation reads the ledger, and only the ledger", () => {
    // Non-vacuous while the ledger is empty: it pins the predicate's two
    // directions against a family that IS classified (so a body of `return
    // isClassifiedFamily(...)`, or `return true`, reddens here) and one that is
    // in neither set.
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      for (const family of deprecatedFamilies[provider]) {
        expect(isRecordedDeprecation(family, provider)).toBe(true);
      }
      const notRecorded = [...includeFamilies[provider]].filter(
        (f) => !deprecatedFamilies[provider].has(f),
      );
      expect(
        notRecorded.length,
        `every ${provider} family is recorded as deprecated — this assertion has nothing left ` +
          `to prove and must be rewritten`,
      ).toBeGreaterThan(0);
      for (const family of notRecorded) {
        expect(isRecordedDeprecation(family, provider)).toBe(false);
      }
      expect(isRecordedDeprecation("zzz-not-a-real-family", provider)).toBe(false);
    }
  });

  it("the deprecation ledger never reaches aimock's serving path", () => {
    // THE ARCHITECTURAL BOUNDARY, as a test. `deprecatedFamilies` records what
    // the PROVIDER retired; it must never become an input to what aimock
    // SERVES, or recording a deprecation silently breaks every user whose suite
    // still pins that model id. aimock's shipped product source is `src/`
    // outside `src/__tests__/` — server.ts's DEFAULT_MODELS, the per-provider
    // builders, the routers — so a reference to the ledger appearing anywhere
    // in it is that boundary being crossed.
    const srcRoot = fileURLToPath(new URL("../../", import.meta.url));
    const offenders: string[] = [];
    const stack = [srcRoot];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = full.slice(srcRoot.length).replace(/^[/\\]+/, "");
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          if (rel === "__tests__") continue;
          stack.push(full);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
          if (readFileSync(full, "utf8").includes("deprecatedFamilies")) offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      `aimock's product source now references deprecatedFamilies (${offenders.join(", ")}). ` +
        `The ledger is a record of provider behaviour, not a switch on aimock's own behaviour ` +
        `— a retired family must keep being mocked.`,
    ).toEqual([]);
  });

  it("seeds are idempotent under normalization (already family keys)", () => {
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      for (const family of includeFamilies[provider]) {
        expect(normalizeModelFamily(family, provider)).toBe(family);
      }
      for (const family of excludeFamilies[provider]) {
        expect(normalizeModelFamily(family, provider)).toBe(family);
      }
    }
  });
});

// ─── PREVIEW_FAMILY exclude-by-rule predicate ────────────────────────────────

describe("isClassifiedFamily / PREVIEW_FAMILY", () => {
  it("classifies a brand-new -preview family by rule (no registry entry)", () => {
    const family = normalizeModelFamily("gemini-9-pro-preview", "gemini");
    expect(includeFamilies.gemini.has(family)).toBe(false);
    expect(excludeFamilies.gemini.has(family)).toBe(false);
    expect(PREVIEW_FAMILY.test(family)).toBe(true);
    expect(isClassifiedFamily(family, "gemini")).toBe(true);
  });

  it("matches a trailing short numeric preview build tag (-preview-NN)", () => {
    expect(PREVIEW_FAMILY.test("antigravity-preview-05")).toBe(true);
    expect(isClassifiedFamily("deep-research-pro-preview-12", "gemini")).toBe(true);
  });

  it("classifies a future Gemma variant by rule (no literal registry entry)", () => {
    // A synthetic future Gemma id normalizes to itself (no numeric-only build
    // tag to strip) and is on NEITHER include nor exclude — it is classified
    // purely by the GEMMA_FAMILY rule. Red against the old literal-names-only
    // exclude set; green with the pattern.
    const family = normalizeModelFamily("gemma-9-foo", "gemini");
    expect(includeFamilies.gemini.has(family)).toBe(false);
    expect(excludeFamilies.gemini.has(family)).toBe(false);
    expect(GEMMA_FAMILY.test(family)).toBe(true);
    expect(isClassifiedFamily(family, "gemini")).toBe(true);
  });

  it("does NOT match interior -preview-<word> suffixes (stay enumerated)", () => {
    expect(PREVIEW_FAMILY.test("gemini-2.5-flash-preview-tts")).toBe(false);
    expect(PREVIEW_FAMILY.test("gemini-3.1-pro-preview-customtools")).toBe(false);
    // Those two ARE classified — but via explicit excludeFamilies enumeration.
    expect(isClassifiedFamily("gemini-2.5-flash-preview-tts", "gemini")).toBe(true);
    expect(isClassifiedFamily("gemini-3.1-pro-preview-customtools", "gemini")).toBe(true);
    // A NON-enumerated interior-suffix family stays unclassified (still drift).
    expect(isClassifiedFamily("gemini-x-flash-preview-widgets", "gemini")).toBe(false);
  });
});

// ─── Part 2: §6.1c builder/fixture cross-check ───────────────────────────────

type Provider = "openai" | "anthropic" | "gemini";

/**
 * The static cross-check table. Each entry is a model id that aimock's
 * builders, fixtures, or DEFAULT_MODELS reference, tagged with its provider.
 * Every entry MUST normalize to a family in includeFamilies[provider] or
 * excludeFamilies[provider]. Non-model tokens go in NON_MODEL_TOKENS_UNDER_TEST.
 *
 * Sources:
 *   - DEFAULT_MODELS (src/server.ts): the ids aimock advertises at /v1/models
 *   - Conformance / fixture-blocks tests: dated snapshots, family aliases
 *   - gemini-interactions: provider-mode token (NON_MODEL_TOKENS, not a real id)
 */
const BUILDER_FIXTURE_MODEL_IDS: Array<{ id: string; provider: Provider }> = [
  // ── DEFAULT_MODELS (src/server.ts) ─────────────────────────────────────────
  { id: "gpt-4", provider: "openai" },
  { id: "gpt-4o", provider: "openai" },
  { id: "claude-3-5-sonnet-20241022", provider: "anthropic" }, // dated snapshot
  { id: "gemini-2.0-flash", provider: "gemini" },
  // text-embedding-3-small is in excludeFamilies (non-text-generation) — see below

  // ── OpenAI: additional families referenced in conformance/fixture tests ────
  { id: "gpt-3.5-turbo", provider: "openai" },
  { id: "gpt-4-turbo", provider: "openai" },
  { id: "gpt-4-turbo-2024-04-09", provider: "openai" }, // dated → gpt-4-turbo
  { id: "gpt-4o-2024-08-06", provider: "openai" }, // dated → gpt-4o
  { id: "gpt-4o-mini", provider: "openai" },
  { id: "gpt-4.1", provider: "openai" },
  { id: "gpt-4.1-mini", provider: "openai" },
  { id: "gpt-4.1-nano", provider: "openai" },
  { id: "gpt-5", provider: "openai" },
  { id: "gpt-5-mini", provider: "openai" },

  // ── OpenAI: excluded families (embeddings, image, voice/audio) ────────────
  { id: "text-embedding-3-small", provider: "openai" }, // exclude: embeddings
  { id: "gpt-image-1", provider: "openai" }, // exclude: image
  { id: "gpt-audio", provider: "openai" }, // exclude: voice canary
  { id: "gpt-audio-mini", provider: "openai" }, // exclude: voice canary
  { id: "gpt-audio-2025-08-28", provider: "openai" }, // dated → gpt-audio (exclude)
  { id: "tts-1", provider: "openai" }, // exclude: tts
  { id: "gpt-4o-mini-tts", provider: "openai" }, // exclude: tts
  { id: "gpt-4o-mini-tts-2025-12-15", provider: "openai" }, // dated → gpt-4o-mini-tts (exclude)
  { id: "gpt-4o-transcribe", provider: "openai" }, // exclude: transcribe
  { id: "gpt-4o-mini-transcribe", provider: "openai" }, // exclude: transcribe
  { id: "gpt-realtime", provider: "openai" }, // exclude: realtime canary
  { id: "gpt-realtime-mini", provider: "openai" }, // exclude: realtime canary
  { id: "gpt-4o-realtime-preview", provider: "openai" }, // exclude: preview realtime
  { id: "gpt-4o-mini-realtime-preview", provider: "openai" }, // exclude: preview realtime

  // ── Anthropic ─────────────────────────────────────────────────────────────
  { id: "claude-3-opus", provider: "anthropic" },
  { id: "claude-3-opus-20240229", provider: "anthropic" }, // dated → claude-3-opus
  { id: "claude-3-sonnet", provider: "anthropic" },
  { id: "claude-3-haiku", provider: "anthropic" },
  { id: "claude-3-5-sonnet", provider: "anthropic" },
  { id: "claude-3-5-haiku", provider: "anthropic" },
  { id: "claude-3-5-haiku-20241022", provider: "anthropic" }, // dated → claude-3-5-haiku
  { id: "claude-3-7-sonnet", provider: "anthropic" },
  { id: "claude-3-7-sonnet-20250219", provider: "anthropic" }, // dated → claude-3-7-sonnet
  { id: "claude-opus-4", provider: "anthropic" },
  { id: "claude-opus-4-20250514", provider: "anthropic" }, // dated → claude-opus-4
  { id: "claude-sonnet-4", provider: "anthropic" },
  { id: "claude-haiku-4", provider: "anthropic" },

  // ── Gemini ────────────────────────────────────────────────────────────────
  { id: "gemini-1.5-pro", provider: "gemini" },
  { id: "gemini-1.5-pro-2024-05-14", provider: "gemini" }, // dated → gemini-1.5-pro
  { id: "gemini-1.5-flash", provider: "gemini" },
  { id: "gemini-2.5-flash", provider: "gemini" },
  { id: "gemini-2.5-pro", provider: "gemini" },
  { id: "gemini-2.0-flash-exp", provider: "gemini" }, // exclude: experimental
  { id: "gemini-2.0-flash-thinking-exp", provider: "gemini" }, // exclude: experimental
];

/**
 * Provider-mode tokens that aimock uses internally to route to a real upstream
 * provider but that are NOT model ids any provider's /models endpoint exposes.
 * These MUST be on NON_MODEL_TOKENS — they must never be mistaken for real ids.
 */
const NON_MODEL_TOKENS_UNDER_TEST: string[] = ["gemini-interactions"];

describe("§6.1c builder/fixture cross-check (no live keys)", () => {
  it("every referenced builder/fixture model id resolves to a classified family", () => {
    const failures: string[] = [];

    for (const { id, provider } of BUILDER_FIXTURE_MODEL_IDS) {
      const family = normalizeModelFamily(id, provider);
      // Use the SAME classification predicate the live drift check uses
      // (include ∪ exclude ∪ the PREVIEW_FAMILY / GEMMA_FAMILY exclude-by-rule
      // patterns) so the two classification surfaces cannot drift apart.
      if (!isClassifiedFamily(family, provider)) {
        failures.push(
          `${id} (${provider}): normalized to "${family}" which is classified by NEITHER includeFamilies, excludeFamilies, NOR the preview/gemma rules`,
        );
      }
    }

    expect(
      failures,
      `Stray builder/fixture model ids not in registry:\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("every non-model provider-mode token is on NON_MODEL_TOKENS", () => {
    const failures: string[] = [];

    for (const token of NON_MODEL_TOKENS_UNDER_TEST) {
      if (!NON_MODEL_TOKENS.has(token)) {
        failures.push(
          `"${token}" is not on NON_MODEL_TOKENS — a greedy scrape would false-positive`,
        );
      }
    }

    expect(
      failures,
      `Provider-mode tokens missing from NON_MODEL_TOKENS:\n${failures.join("\n")}`,
    ).toEqual([]);
  });
});
