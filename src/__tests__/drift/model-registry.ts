/**
 * Per-provider model-family REGISTRY for text-generation drift detection.
 *
 * Side-effect-free data module (no `describe`/`beforeAll`, like `voice-models.ts`)
 * so both the live drift check (`models.drift.ts`) and its unit test can import
 * the same seed data without transitively registering a drift suite.
 *
 * The drift check works by NORMALIZED FAMILY, not raw id: a provider's live
 * `GET /models` list is normalized through `normalizeModelFamily(id, provider)`
 * and each resulting family is subtracted against `include ∪ exclude`. Anything
 * left over is an UNCLASSIFIED family — the drift signal. (The subtract/delta
 * itself is `models.drift.ts`'s job; this module only owns the seed sets.)
 *
 * Two curated sets per provider, both keyed by the NORMALIZED family:
 *
 *   - `include` — families aimock actually MOCKS. Derived from the model ids
 *     aimock's conformance tests, README, and fixtures reference (chat / text
 *     completion families). A live family that normalizes into this set is known
 *     and generates no drift. Seeds are already family keys, so dated snapshots
 *     of an included family (`gpt-4o-2024-08-06` → `gpt-4o`) collapse onto them.
 *
 *   - `exclude` — families we deliberately DO NOT treat as text-generation drift:
 *     retired/legacy ids, preview-only ids, and non-text families (embeddings,
 *     image, tts/audio/transcribe voice families — the last are the realtime
 *     canary's responsibility in `voice-models.ts`, not this text check). A live
 *     family in this set is expected and generates no drift.
 *
 * A family MUST NOT appear in both `include` and `exclude` for the same provider
 * (asserted in the unit test) — the two sets partition the "already classified"
 * space; their union is what the drift check subtracts.
 *
 * `NON_MODEL_TOKENS` is a provider-agnostic allowlist of aimock "provider mode"
 * names — internal routing names that reuse a real upstream API key but are NOT
 * model ids any provider's `/models` endpoint exposes (e.g. `gemini-interactions`
 * reuses the Gemini upstream key). The README documents them, so a greedy source
 * scrape or a builder cross-check would otherwise treat them as unknown model
 * ids and flag guaranteed false positives. They live here so both the drift
 * check and the builder cross-check (B4.3) exclude the exact same tokens.
 *
 * Every set is built THROUGH `normalizeModelFamily` so membership tests are
 * normalization-consistent and the seeds are provably idempotent (a seed carrying
 * a stray dated/build suffix would silently normalize to a different key — the
 * `.map(normalize)` makes that impossible).
 */

import { normalizeModelFamily } from "./model-family.js";

type Provider = "openai" | "anthropic" | "gemini";

/** Build a family Set for a provider, seeding each entry through the normalizer. */
function familySet(provider: Provider, families: string[]): Set<string> {
  return new Set(families.map((f) => normalizeModelFamily(f, provider)));
}

/**
 * Families aimock MOCKS, per provider. These are the canonical text-generation
 * family keys referenced by aimock's conformance tests, README, and fixtures.
 * Dated/versioned variants normalize onto these (e.g. `gpt-4o-2024-08-06` →
 * `gpt-4o`, `claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`).
 */
export const includeFamilies: Record<Provider, Set<string>> = {
  openai: familySet("openai", [
    // Chat / completion families
    "gpt-3.5-turbo",
    "gpt-4",
    "gpt-4-turbo",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-5",
    "gpt-5-mini",
    // gpt-5 tier: additional sizes + chat surfaces
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-5-chat-latest",
    // gpt-5.x point releases (text chat)
    "gpt-5.1",
    "gpt-5.1-chat-latest",
    "gpt-5.2",
    "gpt-5.2-pro",
    "gpt-5.2-chat-latest",
    "gpt-5.3-chat-latest",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.4-pro",
    "gpt-5.5",
    "gpt-5.5-pro",
    // gpt-5.6 named variants (text chat)
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    // Codex line (coding chat; text output)
    "gpt-5-codex",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    // o-series reasoning (text)
    "o1",
    "o1-pro",
    "o3",
    "o3-mini",
    "o3-pro",
    "o4-mini",
  ]),
  anthropic: familySet("anthropic", [
    // Claude 3 / 3.5 / 3.7 families
    "claude-3-opus",
    "claude-3-sonnet",
    "claude-3-haiku",
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
    "claude-3-7-sonnet",
    // Claude 4 families
    "claude-opus-4",
    "claude-sonnet-4",
    "claude-haiku-4",
    // Claude 4.x point releases (text chat)
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    // Claude 5 families (text chat)
    "claude-sonnet-5",
    // claude-fable-5 is included ahead of a recorded fixture (intended — mirrors
    // the forward-looking rationale for the exclude-by-rule patterns above).
    "claude-fable-5",
  ]),
  gemini: familySet("gemini", [
    // Gemini 1.5 / 2.0 / 2.5 text families
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    // Additional stable flash/pro tiers (text)
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
  ]),
};

/**
 * Families we deliberately DO NOT count as text-generation drift, per provider:
 * retired/legacy ids, preview-only ids, and non-text families (embeddings,
 * image, and the voice/audio/tts/transcribe families the realtime canary in
 * `voice-models.ts` owns). A live family here is expected, not drift.
 */
export const excludeFamilies: Record<Provider, Set<string>> = {
  openai: familySet("openai", [
    // Retired / legacy chat + base-completion
    "gpt-3",
    "gpt-3.5",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-instruct",
    "babbage",
    "davinci",
    // Embeddings (non-text-generation)
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-embedding-ada-002",
    // Image models
    "dall-e-2",
    "dall-e-3",
    "gpt-image-1",
    "gpt-image-1-mini",
    "gpt-image-1.5",
    "gpt-image-2",
    "chatgpt-image-latest",
    // Video generation (non-text)
    "sora-2",
    "sora-2-pro",
    // Moderation classifier (non-text-generation)
    "omni-moderation",
    "omni-moderation-latest",
    // Deep-research / search specialty surfaces (text output, not plain chat).
    // Enumerated because they carry no trailing `-preview` (see PREVIEW_FAMILY).
    "o3-deep-research",
    "o4-mini-deep-research",
    "gpt-5-search-api",
    // Voice / audio / tts / transcribe — owned by the realtime canary
    "tts-1",
    "tts-1-hd",
    "whisper-1",
    "gpt-audio",
    "gpt-audio-mini",
    "gpt-audio-1.5",
    "gpt-4o-mini-tts",
    "gpt-4o-transcribe",
    "gpt-4o-mini-transcribe",
    "gpt-4o-transcribe-diarize",
    "gpt-realtime",
    "gpt-realtime-mini",
    "gpt-realtime-2",
    "gpt-realtime-2.1",
    "gpt-realtime-2.1-mini",
    "gpt-realtime-1.5",
    "gpt-realtime-translate",
    "gpt-realtime-whisper",
    // NOTE: `-preview` families (gpt-4o-realtime-preview,
    // gpt-4o-mini-realtime-preview, gpt-4o-search-preview,
    // gpt-4o-mini-search-preview, computer-use-preview, …) are auto-excluded by
    // the PREVIEW_FAMILY rule (see isClassifiedFamily below) — no enumeration.
  ]),
  anthropic: familySet("anthropic", [
    // Retired / legacy Claude ids
    "claude-v3",
    "claude-2",
    "claude-instant-1",
  ]),
  gemini: familySet("gemini", [
    // Retired / legacy specialty
    "gemini-pro",
    "aqa",
    // Embeddings (non-text-generation)
    "text-embedding-004",
    "gemini-embedding",
    "gemini-embedding-2",
    // Image models (non-text)
    "gemini-2.5-flash-image",
    "gemini-3-pro-image",
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-lite-image",
    "imagen-4.0-fast-generate",
    "imagen-4.0-generate",
    "imagen-4.0-ultra-generate",
    // Audio / native-audio (realtime canary domain)
    "gemini-2.5-flash-native-audio-latest",
    // NOTE: the open-weight Gemma line (`gemma-4-26b-a4b-it`, `gemma-4-31b-it`,
    // and any future variant) is auto-excluded by the GEMMA_FAMILY rule (see
    // isClassifiedFamily below) — no enumeration. Gemma is open-weight, not
    // mocked on the Gemini surface, so it is out of scope; reversible by future
    // explicit handling if a Gemma fixture is ever added.
    // Moving aliases (not families aimock commits to as stable text surfaces)
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-pro-latest",
    // Interior `-preview-<word>` specialty suffixes the PREVIEW_FAMILY rule does
    // NOT match (it only matches trailing `-preview` / `-preview-<digits>`).
    // Enumerated so their category (tts / custom-tools) stays documented.
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-pro-preview-tts",
    "gemini-3.1-pro-preview-customtools",
    // Experimental / thinking (kept explicit — historic `-exp`, not `-preview`)
    "gemini-2.0-flash-exp",
    "gemini-2.0-flash-thinking-exp",
    // Live/full-duplex voice — owned by the realtime canary, not this text check
    "gemini-live",
    // NOTE: every `-preview` family (gemini-3.x preview tiers, deep-research
    // previews, antigravity-preview-05, computer-use-preview-10, image/tts/robotics
    // previews, lyria/veo/nano-banana previews, gemini-embedding-2-preview, …) is
    // auto-excluded by the PREVIEW_FAMILY rule (see isClassifiedFamily below).
  ]),
};

/**
 * aimock "provider mode" names: internal routing names that reuse a real
 * upstream provider key but are NOT model ids any provider's `/models` endpoint
 * exposes. Provider-agnostic allowlist so both the drift check and the builder
 * cross-check exclude the exact same tokens (never false-positive drift).
 */
export const NON_MODEL_TOKENS: Set<string> = new Set(["gemini-interactions"]);

/**
 * Durable EXCLUDE-BY-RULE predicate for preview/experimental families.
 *
 * Preview tiers (`gemini-3-pro-preview`, `gpt-4o-search-preview`,
 * `antigravity-preview-05`, …) are unstable and short-lived: providers ship a
 * new one on nearly every release wave, and each one that lands would otherwise
 * re-fire the daily drift canary as a brand-new UNCLASSIFIED family, forcing a
 * registry edit per preview forever (that is exactly how the Gemini-3.x wave
 * surfaced — the exclude set was a hand-maintained list with no preview rule).
 * A pattern rule auto-excludes every current AND future `-preview` family with
 * zero registry churn, and re-alerting on each new preview tier is precisely the
 * whack-a-mole this hardening removes.
 *
 * The pattern intentionally matches ONLY a trailing `-preview` token, optionally
 * followed by a short numeric build tag the normalizer does not strip
 * (`-preview-04`, `-preview-05`, `-preview-10`, `-preview-12`). The `-\d+` tail
 * is unbounded on purpose — a 1-2 digit build tag survives the normalizer
 * (`BUILD_TAG_SUFFIX` only strips 3-4 digit tails), and a longer numeric tail on
 * a `-preview` token is still unambiguously a preview surface, so there is no
 * upper bound to enforce. It deliberately does NOT match interior
 * `-preview-<word>` suffixes like `-preview-tts` / `-preview-customtools`; those
 * are non-text specialty surfaces enumerated explicitly in `excludeFamilies` so
 * their category (tts / custom-tools) stays documented rather than swept under a
 * blanket rule.
 *
 * TRADEOFF — previews are BLANKET-excluded until GA, per policy. This
 * intentionally SILENCES the canary on new text previews (e.g. `o1-preview`,
 * `gpt-4.5-preview`, a `gemini-3` chat preview) until they drop the `-preview`
 * suffix and go GA. There is no include-side escape hatch: aimock does not mock
 * preview surfaces, so re-alerting on each new preview tier is precisely the
 * whack-a-mole this rule removes. If aimock ever needs to mock a specific
 * preview surface, add explicit handling then.
 *
 * IMPORTANT — this lives at the CLASSIFICATION layer, NOT the normalizer. The
 * normalizer is left untouched so preview family keys stay DISTINCT: a genuinely
 * new preview family is still visible as its own key (never collapsed onto its GA
 * sibling), which preserves the canary's ability to surface new families while
 * making previews self-excluding.
 */
export const PREVIEW_FAMILY = /-preview(-\d+)?$/;

/**
 * Durable EXCLUDE-BY-RULE predicate for the open-weight Gemma line.
 *
 * Gemma is open-weight and NOT mocked on aimock's Gemini surface (no code /
 * fixtures); it only rides the shared Gemini `/models` listing. Every current
 * AND future Gemma variant (`gemma-4-26b-a4b-it`, `gemma-4-31b-it`, …) is
 * out of scope, so a pattern rule auto-excludes them with zero registry churn —
 * mirroring the PREVIEW_FAMILY rationale. Reversible by future explicit handling
 * if a Gemma fixture is ever added.
 */
export const GEMMA_FAMILY = /^gemma(-|$)/;

/**
 * A NORMALIZED family key is already classified if it is in `include ∪ exclude`,
 * OR it matches an exclude-by-rule pattern (preview, gemma). Both the live drift
 * check (`unclassifiedFamilies`) and the builder/fixture cross-check use this
 * single predicate so their classification surfaces cannot drift apart.
 *
 * There is deliberately NO include-side escape hatch: previews and Gemma are
 * blanket-excluded (aimock does not mock either surface), so an include entry
 * could never legitimately collide with an exclude rule. The intersection
 * `include ∩ (preview ∪ gemma)` is empty by construction.
 */
export function isClassifiedFamily(family: string, provider: Provider): boolean {
  if (includeFamilies[provider].has(family)) return true;
  if (excludeFamilies[provider].has(family)) return true;
  if (PREVIEW_FAMILY.test(family)) return true; // exclude-by-rule
  if (GEMMA_FAMILY.test(family)) return true; // exclude-by-rule
  return false;
}
