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
import { normalizeModelFamily } from "./model-family.js";
import {
  includeFamilies,
  excludeFamilies,
  NON_MODEL_TOKENS,
  isClassifiedFamily,
  PREVIEW_FAMILY,
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

  it("INCLUDE WINS: an included family ending in -preview is classified as included", () => {
    const included = normalizeModelFamily("gemini-x-chat-preview", "gemini");
    includeFamilies.gemini.add(included);
    try {
      expect(isClassifiedFamily(included, "gemini")).toBe(true);
      expect(includeFamilies.gemini.has(included)).toBe(true);
    } finally {
      includeFamilies.gemini.delete(included);
    }
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
      // (include ∪ exclude ∪ the PREVIEW_FAMILY rule, include-wins) so the two
      // classification surfaces cannot drift apart.
      if (!isClassifiedFamily(family, provider)) {
        failures.push(
          `${id} (${provider}): normalized to "${family}" which is classified by NEITHER includeFamilies, excludeFamilies, NOR the preview rule`,
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
