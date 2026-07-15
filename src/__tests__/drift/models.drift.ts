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
import { includeFamilies, excludeFamilies, NON_MODEL_TOKENS } from "./model-registry.js";
import { formatDriftReport } from "./schema.js";

type Provider = "openai" | "anthropic" | "gemini";

/**
 * Reduce a live `/models` list to the UNCLASSIFIED families: normalize each id,
 * then drop everything already in `include ∪ exclude` or on the non-model
 * allowlist. The returned list (sorted, de-duplicated) is the drift signal.
 *
 * Exported so the co-located regression suite can exercise the EXACT
 * enumerate→normalize→subtract pipeline the live check relies on, with an
 * injected payload — no reimplementation.
 */
export function unclassifiedFamilies(modelIds: string[], provider: Provider): string[] {
  const known = new Set<string>([...includeFamilies[provider], ...excludeFamilies[provider]]);
  const unclassified = new Set<string>();
  for (const id of modelIds) {
    const family = normalizeModelFamily(id, provider);
    if (known.has(family)) continue;
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
