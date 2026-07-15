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
  ]),
  gemini: familySet("gemini", [
    // Gemini 1.5 / 2.0 / 2.5 text families
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
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
    // Retired / legacy chat
    "gpt-3",
    "gpt-3.5",
    // Embeddings (non-text-generation)
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-embedding-ada-002",
    // Image models
    "dall-e-2",
    "dall-e-3",
    "gpt-image-1",
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
    // Preview-only realtime
    "gpt-4o-realtime-preview",
    "gpt-4o-mini-realtime-preview",
  ]),
  anthropic: familySet("anthropic", [
    // Retired / legacy Claude ids
    "claude-v3",
    "claude-2",
    "claude-instant-1",
  ]),
  gemini: familySet("gemini", [
    // Retired / legacy
    "gemini-pro",
    // Embeddings (non-text-generation)
    "text-embedding-004",
    // Experimental / preview / thinking-preview
    "gemini-2.0-flash-exp",
    "gemini-2.0-flash-thinking-exp",
    // Live/full-duplex voice — owned by the realtime canary, not this text check
    "gemini-live",
  ]),
};

/**
 * aimock "provider mode" names: internal routing names that reuse a real
 * upstream provider key but are NOT model ids any provider's `/models` endpoint
 * exposes. Provider-agnostic allowlist so both the drift check and the builder
 * cross-check exclude the exact same tokens (never false-positive drift).
 */
export const NON_MODEL_TOKENS: Set<string> = new Set(["gemini-interactions"]);
