/**
 * Model-family drift check — verify that each provider's LIVE `GET /models`
 * list contains no UNCLASSIFIED text-generation family.
 *
 * How it works (no source scraping — that path caused incident 5):
 *   1. Fetch the provider's live model list (`list*Models`).
 *   2. Normalize every id to its FAMILY key (`normalizeModelFamily`), so dated
 *      snapshots and build tags collapse onto their family
 *      (`gpt-4o-2024-08-06` → `gpt-4o`, `tts-1-1106` → `tts-1`).
 *   3. Subtract the already-classified space: `includeFamilies[provider] ∪
 *      excludeFamilies[provider]`, and drop the provider-agnostic
 *      `NON_MODEL_TOKENS` allowlist.
 *   4. Whatever remains is an UNCLASSIFIED family — the drift signal. It is
 *      surfaced as a FAILING assertion wrapped in a `formatDriftReport` block so
 *      the collector (`scripts/drift-report-collector.ts`) routes it: the
 *      `API DRIFT DETECTED` block parses into critical entries (exit-2 auto-fix
 *      lane); anything it cannot map falls to exit-5 quarantine.
 *
 * Comparing NORMALIZED families (not raw ids) is what makes this converge:
 * appending every new dated snapshot to a known-id set never stabilizes and
 * turns the daily job permanently red on false positives (incident 2). Only a
 * genuinely NEW family (e.g. `gpt-live`) is ever flagged.
 *
 * Because nothing is scraped from source, an aimock "provider mode" prose token
 * (e.g. `gemini-interactions`) can never enter the pipeline as a candidate id —
 * the only inputs are the provider's own `/models` payload.
 */

import { describe, it, expect } from "vitest";
import { listOpenAIModels, listAnthropicModels, listGeminiModels } from "./providers.js";
import { normalizeModelFamily } from "./model-family.js";
import { NON_MODEL_TOKENS, isClassifiedFamily } from "./model-registry.js";
import { formatDriftReport } from "./schema.js";

type Provider = "openai" | "anthropic" | "gemini";

/**
 * Reduce a live `/models` list to the UNCLASSIFIED families: normalize each id,
 * then drop everything already classified (`include ∪ exclude`, the
 * preview/gemma exclude-by-rule patterns — see `isClassifiedFamily` in
 * model-registry.ts) or on the non-model allowlist. The returned list (sorted,
 * de-duplicated) is the drift signal.
 *
 * Exported so the co-located regression suite can exercise the EXACT
 * enumerate→normalize→subtract pipeline the live check relies on, with an
 * injected payload — no reimplementation.
 */
export function unclassifiedFamilies(modelIds: string[], provider: Provider): string[] {
  const unclassified = new Set<string>();
  for (const id of modelIds) {
    const family = normalizeModelFamily(id, provider);
    if (isClassifiedFamily(family, provider)) continue;
    if (NON_MODEL_TOKENS.has(family) || NON_MODEL_TOKENS.has(id)) continue;
    unclassified.add(family);
  }
  return [...unclassified].sort();
}

/**
 * Assert that a live `/models` list has zero unclassified families. On failure,
 * emit one critical drift diff per unclassified family inside a
 * `formatDriftReport` block so the collector routes it to the exit-2 auto-fix
 * lane (provider names match `PROVIDER_MAP` keys in the collector).
 */
function assertNoUnclassifiedFamilies(
  modelIds: string[],
  provider: Provider,
  context: string,
): void {
  const unclassified = unclassifiedFamilies(modelIds, provider);
  const report =
    unclassified.length > 0
      ? formatDriftReport(
          context,
          unclassified.map((family) => ({
            path: `models/${family}`,
            severity: "critical" as const,
            issue:
              `Unclassified model family "${family}" in ${provider} /models — ` +
              `add it to includeFamilies (aimock mocks it) or excludeFamilies ` +
              `(non-text / retired / preview) in model-registry.ts`,
            expected: "(family in includeFamilies ∪ excludeFamilies)",
            real: family,
            mock: "<no mock leg — live /models family canary>",
          })),
        )
      : `No drift detected: ${context}`;
  expect(unclassified, report).toEqual([]);
}

// ---------------------------------------------------------------------------
// Regression suite (no live keys) — exercises the REAL pipeline with injected
// `/models` payloads. Runs unconditionally so the drift job proves the
// enumerate→normalize→subtract behavior even when live keys are absent.
// ---------------------------------------------------------------------------

describe("model-family pipeline (injected /models)", () => {
  it("incident 2: dated snapshots of included families produce ZERO drift", () => {
    // Payload of dated/build-tag snapshots whose FAMILIES are all in
    // includeFamilies/excludeFamilies. The old scrape+substring path would have
    // flagged these dated ids as unknown; the normalize+subtract path collapses
    // each onto its known family, so the unclassified delta must be empty.
    const openaiPayload = [
      "gpt-4o-2024-08-06", // → gpt-4o (include)
      "gpt-4o-mini-2024-07-18", // → gpt-4o-mini (include)
      "gpt-4.1-2025-04-14", // → gpt-4.1 (include)
      "gpt-audio-2025-08-28", // → gpt-audio (exclude)
      "tts-1-1106", // → tts-1 (exclude)
      "gpt-4o-mini-tts-2025-12-15", // → gpt-4o-mini-tts (exclude)
    ];
    expect(unclassifiedFamilies(openaiPayload, "openai")).toEqual([]);

    // Gemini dated variants collapse via the same dated-snapshot strip.
    const geminiPayload = [
      "gemini-2.5-flash", // include
      "gemini-2.0-flash", // include
      "gemini-1.5-pro-2024-05-14", // → gemini-1.5-pro (include)
    ];
    expect(unclassifiedFamilies(geminiPayload, "gemini")).toEqual([]);

    // Anthropic uses a CONTIGUOUS 8-digit snapshot suffix (`-YYYYMMDD`), not the
    // dashed `-YYYY-MM-DD` form. These must collapse onto their included family
    // via the anthropic-specific strip, or every dated Claude id false-positives
    // as drift (the incident-2 class, for Anthropic).
    const anthropicPayload = [
      "claude-3-5-sonnet-20241022", // → claude-3-5-sonnet (include)
      "claude-3-7-sonnet-20250219", // → claude-3-7-sonnet (include)
      "claude-3-5-haiku-20241022", // → claude-3-5-haiku (include)
    ];
    expect(unclassifiedFamilies(anthropicPayload, "anthropic")).toEqual([]);
  });

  it("a prose provider-mode token can never enter as a candidate", () => {
    // Nothing is scraped from source, so a `gemini-interactions`-style token can
    // only appear if a provider's own /models returned it — and even then it is
    // on NON_MODEL_TOKENS and never becomes drift.
    expect(unclassifiedFamilies(["gemini-interactions"], "gemini")).toEqual([]);
  });

  it("a genuinely new family IS flagged as unclassified drift", () => {
    // Guard the other side: the canary must still fire for a real new family.
    expect(unclassifiedFamilies(["gpt-live"], "openai")).toEqual(["gpt-live"]);
    // Single-digit trailing suffix is NOT a build tag, so it stays unknown.
    expect(unclassifiedFamilies(["gpt-live-1"], "openai")).toEqual(["gpt-live-1"]);
  });
});

// ---------------------------------------------------------------------------
// PREVIEW_FAMILY exclude-by-rule predicate (the durable hardening).
// ---------------------------------------------------------------------------

describe("preview families are excluded by rule", () => {
  it("a brand-new -preview family auto-excludes with zero registry edits", () => {
    // Not in include or exclude — classified purely by the trailing-preview rule.
    expect(unclassifiedFamilies(["gemini-9-pro-preview"], "gemini")).toEqual([]);
    expect(unclassifiedFamilies(["gpt-9-search-preview"], "openai")).toEqual([]);
  });

  it("matches a trailing short numeric preview build tag (-preview-NN)", () => {
    // The normalizer leaves 2-digit tails intact, so the rule must cover them.
    expect(unclassifiedFamilies(["antigravity-preview-05"], "gemini")).toEqual([]);
    expect(unclassifiedFamilies(["deep-research-pro-preview-12"], "gemini")).toEqual([]);
  });

  it("does NOT match interior -preview-<word> suffixes (they stay enumerated)", () => {
    // `-preview-tts` / `-preview-customtools` are non-text specialty surfaces
    // enumerated explicitly; a hypothetical UNLISTED interior-suffix family must
    // still fire as drift so its category is not silently swallowed.
    expect(unclassifiedFamilies(["gemini-x-flash-preview-widgets"], "gemini")).toEqual([
      "gemini-x-flash-preview-widgets",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GEMMA_FAMILY exclude-by-rule predicate (open-weight, out of scope).
// ---------------------------------------------------------------------------

describe("gemma families are excluded by rule", () => {
  it("a future Gemma variant auto-excludes with zero registry edits", () => {
    // `gemma-9-foo` has no numeric-only build tag to strip, so it normalizes to
    // itself and is on NEITHER include nor exclude — classified purely by the
    // gemma rule. Red against the old literal-names-only exclude set; green with
    // the pattern.
    expect(unclassifiedFamilies(["gemma-9-foo"], "gemini")).toEqual([]);
    // The two originally-enumerated literals still classify (now via the rule).
    expect(unclassifiedFamilies(["gemma-4-26b-a4b-it", "gemma-4-31b-it"], "gemini")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression: the FULL live /models family wave (run 29478043559, 2026-07-16).
// These are the exact families the drift job flagged as UNCLASSIFIED (OpenAI 48
// / Anthropic 10 / Gemini 45). This suite injects representative raw ids for
// every one of them into the REAL enumerate→normalize→subtract pipeline and
// asserts the registry now classifies all of them — zero drift. It exercises
// the same `unclassifiedFamilies` surface the live canary uses, so it is a true
// regression against the classification (not a fake against a private copy).
// ---------------------------------------------------------------------------

describe("full live /models wave is fully classified (2026-07-16 drift)", () => {
  it("OpenAI: every live family is classified (zero unclassified)", () => {
    const openaiLive = [
      // Existing include families (dated snapshots collapse onto them)
      "gpt-3.5-turbo",
      "gpt-4",
      "gpt-4-turbo",
      "gpt-4o-2024-08-06",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-5",
      "gpt-5-mini",
      // Newly-classified INCLUDE: gpt-5.x tiers + chat surfaces
      "gpt-5-chat-latest",
      "gpt-5.1-chat-latest",
      "gpt-5.2-chat-latest",
      "gpt-5.3-chat-latest",
      "gpt-5-nano",
      "gpt-5-pro",
      "gpt-5.1",
      "gpt-5.2",
      "gpt-5.2-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4-pro",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      // o-series reasoning
      "o1",
      "o1-pro",
      "o3",
      "o3-mini",
      "o3-pro",
      "o4-mini",
      // Codex line
      "gpt-5-codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      // Newly-classified EXCLUDE: retired base
      "babbage-002",
      "davinci-002",
      "gpt-3.5-turbo-16k",
      "gpt-3.5-turbo-instruct",
      // deep-research / search / computer-use surfaces
      "o3-deep-research",
      "o4-mini-deep-research",
      "gpt-5-search-api",
      "gpt-4o-search-preview", // preview pattern
      "gpt-4o-mini-search-preview", // preview pattern
      "computer-use-preview", // preview pattern
      // image / video / moderation
      "chatgpt-image-latest",
      "gpt-image-1-mini",
      "gpt-image-1.5",
      "gpt-image-2",
      "sora-2",
      "sora-2-pro",
      "omni-moderation",
      "omni-moderation-latest",
    ];
    expect(unclassifiedFamilies(openaiLive, "openai")).toEqual([]);
  });

  it("Anthropic: every live family is classified (zero unclassified)", () => {
    const anthropicLive = [
      // Existing include (dated snapshots collapse)
      "claude-3-opus-20240229",
      "claude-3-5-sonnet-20241022",
      "claude-3-7-sonnet-20250219",
      "claude-opus-4-20250514",
      "claude-sonnet-4",
      "claude-haiku-4",
      // Newly-classified INCLUDE: 4.x/5 point releases + fable
      "claude-haiku-4-5",
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
    ];
    expect(unclassifiedFamilies(anthropicLive, "anthropic")).toEqual([]);
  });

  it("Gemini: every live family is classified (zero unclassified)", () => {
    const geminiLive = [
      // Existing include
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "gemini-2.0-flash",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      // Newly-classified INCLUDE: stable flash/pro tiers
      "gemini-2.0-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
      // Preview text tiers — auto-excluded by the -preview pattern rule
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview",
      // Preview specialty surfaces (pattern OR explicit)
      "gemini-3.1-pro-preview-customtools", // explicit exclude (not -preview$)
      "antigravity-preview-05", // pattern
      "aqa", // explicit exclude (retired specialty)
      "deep-research-max-preview-04", // pattern
      "deep-research-preview-04", // pattern
      "deep-research-pro-preview-12", // pattern
      "gemini-2.5-computer-use-preview-10", // pattern
      "gemini-omni-flash-preview", // pattern
      // image / audio / tts / video / music / robotics / embeddings
      "gemini-2.5-flash-image",
      "gemini-2.5-flash-native-audio-latest",
      "gemini-2.5-flash-preview-tts", // explicit exclude (-preview-tts)
      "gemini-2.5-pro-preview-tts", // explicit exclude (-preview-tts)
      "gemini-3-pro-image",
      "gemini-3-pro-image-preview", // pattern
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-image-preview", // pattern
      "gemini-3.1-flash-lite-image",
      "gemini-3.1-flash-tts-preview", // pattern
      "gemini-embedding",
      "gemini-embedding-2",
      "gemini-embedding-2-preview", // pattern
      "gemini-robotics-er-1.5-preview", // pattern
      "gemini-robotics-er-1.6-preview", // pattern
      "imagen-4.0-fast-generate",
      "imagen-4.0-generate",
      "imagen-4.0-ultra-generate",
      "lyria-3-clip-preview", // pattern
      "lyria-3-pro-preview", // pattern
      "nano-banana-pro-preview", // pattern
      "veo-3.1-fast-generate-preview", // pattern
      "veo-3.1-generate-preview", // pattern
      "veo-3.1-lite-generate-preview", // pattern
      // Gemma open-weight — aimock does NOT mock; auto-excluded by GEMMA_FAMILY rule
      "gemma-4-26b-a4b-it",
      "gemma-4-31b-it",
      // Moving aliases
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
      "gemini-pro-latest",
    ];
    expect(unclassifiedFamilies(geminiLive, "gemini")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Chat model-family availability", () => {
  it("live /models contains no unclassified family", async () => {
    const models = await listOpenAIModels(process.env.OPENAI_API_KEY!);
    assertNoUnclassifiedFamilies(models, "openai", "OpenAI Chat (live /models family canary)");
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "Anthropic Claude model-family availability",
  () => {
    it("live /models contains no unclassified family", async () => {
      const models = await listAnthropicModels(process.env.ANTHROPIC_API_KEY!);
      assertNoUnclassifiedFamilies(
        models,
        "anthropic",
        "Anthropic Claude (live /models family canary)",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.GOOGLE_API_KEY)("Google Gemini model-family availability", () => {
  it("live /models contains no unclassified family", async () => {
    const models = await listGeminiModels(process.env.GOOGLE_API_KEY!);
    assertNoUnclassifiedFamilies(models, "gemini", "Google Gemini (live /models family canary)");
  });
});
