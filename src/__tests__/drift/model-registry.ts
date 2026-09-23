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
    // gpt-6 named variant (text chat), first listed 2026-08-27. Classified on a
    // DECLARED-CAPABILITY probe, not on the name — "astra" carries no modality
    // signal, and the /v1/models listing exposes none either (id / owned_by /
    // created only), so shape alone could not decide this. A minimal
    // /v1/chat/completions call returns 200 with `finish_reason: "stop"` and a
    // real assistant turn, byte-for-byte the same shape the already-included
    // `gpt-5.6-luna` returns; the negative control `whisper-1` is refused on the
    // same endpoint with "This is not a chat model". So it is plain text chat,
    // the surface aimock mocks.
    //
    // Decision: INCLUDE, recorded in
    // drift-proposals/openai-gpt-6-astra-new-family.md.
    "gpt-6-astra",
    // gpt-6 named variants (text chat), first listed 2026-09-23 (drift run
    // 35827604040). The gpt-6 generation of the already-included
    // `gpt-5.6-luna` / `gpt-5.6-sol`, and siblings of the probe-verified
    // `gpt-6-astra` above. No name token places them in an excluded cluster
    // (image / audio / realtime / transcribe / tts / search).
    //
    // EVIDENCE LIMIT: classified by lineage, not by a fresh probe — no OpenAI
    // key was available to repeat the /v1/chat/completions call that decided
    // `gpt-6-astra`, and /v1/models exposes no capability field. The live
    // canary is what catches it if that inference is wrong.
    //
    // Decision: INCLUDE, recorded in
    // drift-proposals/openai-gpt-6-luna-new-family.md and
    // drift-proposals/openai-gpt-6-sol-new-family.md.
    "gpt-6-luna",
    "gpt-6-sol",
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
    "claude-opus-5",
    "claude-sonnet-5",
    // claude-fable-5 is included ahead of a recorded fixture (intended — mirrors
    // the forward-looking rationale for the exclude-by-rule patterns below,
    // PREVIEW_FAMILY / GEMMA_FAMILY).
    "claude-fable-5",
    // Point release of the already-included `claude-fable-5`, exactly as
    // `claude-opus-4-1` is of `claude-opus-4` — `display_name: "Claude Fable
    // 5.1"`, `created_at: 2026-08-28`, against Fable 5's 2026-06-07.
    //
    // Classified on a DECLARED-CAPABILITY probe like the rest of this wave.
    // Anthropic's /v1/models carries no capability field (id / display_name /
    // created_at only), so there is no `supportedGenerationMethods` to compare
    // — but /v1/messages answers the same question directly: a minimal call
    // returns 200 with `stop_reason: "end_turn"` and a real assistant turn.
    // Corroborating: all 11 ids on the live listing are text-chat Claude
    // families, and the canary reported exactly ONE unclassified anthropic
    // family, so every other live id already normalized into this set.
    //
    // Decision: INCLUDE, recorded in
    // drift-proposals/anthropic-claude-fable-5-1-new-family.md.
    "claude-fable-5-1",
    // Claude Opus 5.5, first listed 2026-09-23 (drift run 35827604040). Point
    // release of the already-included `claude-opus-5`, exactly as
    // `claude-opus-4-5` is of `claude-opus-4`. Every Claude family on
    // Anthropic's listing is text chat on /v1/messages; the only anthropic
    // excludes are retired ids.
    //
    // EVIDENCE LIMIT: no /v1/messages probe was run (no Anthropic key was
    // available), and /v1/models carries no capability field. Same argument as
    // `claude-opus-5` (72f85f8): on the live listing, base family already
    // included, and the canary reported exactly ONE unclassified anthropic
    // family that run.
    //
    // Decision: INCLUDE, recorded in
    // drift-proposals/anthropic-claude-opus-5-5-new-family.md.
    "claude-opus-5-5",
  ]),
  gemini: familySet("gemini", [
    // Gemini 2.0 / 2.5 text families
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    // Additional stable flash/pro tiers (text)
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    // Stable GA text tier. Google's live /models entry declares
    // `supportedGenerationMethods: [generateContent, countTokens,
    // createCachedContent, batchGenerateContent]` — set-identical to the
    // already-included `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`
    // — with `displayName: "Gemini 3.8 Flash"` and no preview, experimental,
    // confidential or EAP marker. No `bidiGenerateContent` (not a Live /
    // native-audio surface), no `embedContent`, no `predict`. Next release in the
    // flash line aimock already mocks at 3.5 through 3.7.
    //
    // Decision: INCLUDE, recorded in
    // drift-proposals/gemini-gemini-3.8-flash-new-family.md.
    "gemini-3.8-flash",
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
    // 2026-09-10 image line. `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`
    // are image-generation models on the same lineage as the already-excluded
    // `gpt-image-2` — they serve /v1/images/generations, not
    // /v1/chat/completions, so they are wrong-modality here and are NOT
    // text-generation drift. Same treatment as every other gpt-image-* family.
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "chatgpt-image-latest",
    // Bare chat alias — a moving alias (not a stable mocked family); matches the
    // *-latest exclude policy (chatgpt-image-latest, omni-moderation-latest, etc.)
    "chat-latest",
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
    // Transcription line OpenAI shipped on 2026-07-28 and the daily drift run
    // first observed on 2026-07-29 (that later date is the `Detected:` stamp in
    // the notes under drift-proposals/ — two dates for two different events, not
    // a disagreement).
    //
    // On OpenAI's API both are audio→text transcription surfaces and neither
    // answers on /v1/chat/completions, so neither can ever be text-generation
    // drift. Membership here is a CLASSIFICATION for the `/models` listing check
    // in models.drift.ts and nothing more: it says the family is accounted for,
    // not which endpoints aimock implements for it. What aimock serves is
    // ws-realtime.ts's and the audio handlers' business and moves independently.
    //
    // Decision: EXCLUDE, recorded in
    // drift-proposals/openai-gpt-transcribe-new-family.md and
    // drift-proposals/openai-gpt-live-transcribe-new-family.md (PR #343).
    "gpt-transcribe",
    "gpt-live-transcribe",
    "gpt-realtime",
    "gpt-realtime-mini",
    "gpt-realtime-2",
    "gpt-realtime-2.1",
    "gpt-realtime-2.1-mini",
    "gpt-realtime-1.5",
    "gpt-realtime-translate",
    "gpt-realtime-whisper",
    // 2026-09-10 full-duplex voice line. `gpt-live-1` is OpenAI's GPT-Live-1,
    // a voice model on the NEW `/v1/live/sessions` endpoint — a SIBLING of the
    // Realtime API, not a successor (its model page marks Realtime "Not
    // supported"). It never answers on /v1/chat/completions, so it can never be
    // text-generation drift, and aimock implements no `/v1/live` surface at all.
    // Membership here is a CLASSIFICATION for the `/models` listing check only —
    // it says the family is accounted for, NOT that aimock mocks it (same
    // reading as the gpt-transcribe / gpt-live-transcribe block above).
    //
    // PAIRED ENTRY: `gpt-live-1` is ALSO in `knownVoiceModelFamilies`
    // (voice-models.ts). The two sets are deliberately DISJOINT surfaces — this
    // one silences the `/models` classification check in models.drift.ts, that
    // one silences the realtime canary in ws-realtime.drift.ts — so a VOICE
    // family needs the entry in BOTH or the half it is missing from stays red.
    // Same pairing as the gpt-transcribe / gpt-live-transcribe block above
    // (936b59c: "the two sets are deliberately disjoint surfaces, so both need
    // the entry").
    //
    // Decision: EXCLUDE, recorded in
    // drift-proposals/openai-gpt-live-1-new-family.md.
    "gpt-live-1",
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
    // Gemini 1.5 retired upstream 2026-07 (absent from the live /models listing)
    // but aimock still mocks it for clients pinned to older SDKs, and
    // `isReasoningModel()` must keep answering false for it (model-utils.ts's
    // NONREASONING_FAMILIES). Same treatment as gemini-pro above: still
    // referenced + still mocked, just not counted as text-generation drift.
    // Decision + rationale: commit a3dc250 (the drift-proposals/ notes it
    // resolved are gone — they carried no content beyond that commit message).
    "gemini-1.5-pro",
    "gemini-1.5-flash",
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
    // The Gemini 3.5 Transcribe line, GA 2026-08-26, first observed by the daily
    // /models canary on 2026-08-27 (that later date is the `Detected:` stamp in
    // the notes under drift-proposals/ — two dates for two events, not a
    // disagreement). Two ids ship as ONE model on TWO surfaces, and they are two
    // distinct normalized families, so both are enumerated.
    //
    // Classified on DECLARED CAPABILITY, not on the "transcribe" substring.
    // Google's model card gives both the same signature — input `Audio (up to
    // 1 hour)`, output `Text, Word annotations` — i.e. speech->text only. They
    // emit no chat completion of their own; the text they return is a
    // transcript of the caller's audio. That is the realtime/audio canary's
    // domain (voice-models.ts), exactly like `gemini-live` above, and it can
    // never be TEXT-GENERATION drift.
    //
    // `-live` carries a second, independently observed capability fact. The Live
    // leg's discovery filters SOLELY on declared `bidiGenerateContent` (no name
    // heuristic — see ws-gemini-live.drift.ts), and it selected this id, so the
    // model does declare that method. Google then refused the session out of
    // band: `code=1007 reason="The requested combination of response modalities
    // (AUDIO) is not supported by the model. models/gemini-3.5-transcribe-live"`
    // (run 33296393200). So it is a bidi Live surface that emits TEXT and cannot
    // emit AUDIO — a streaming transcriber, not a native-audio model.
    //
    // NOTE membership here is a CLASSIFICATION for the `/models` listing check
    // in models.drift.ts and nothing more: it says the family is accounted for,
    // not which endpoints aimock implements for it. Mirrors the OpenAI
    // `gpt-transcribe` / `gpt-live-transcribe` pair above.
    //
    // Decision: EXCLUDE, recorded in
    // drift-proposals/gemini-gemini-3.5-transcribe-new-family.md and
    // drift-proposals/gemini-gemini-3.5-transcribe-live-new-family.md.
    "gemini-3.5-transcribe",
    "gemini-3.5-transcribe-live",
    // Gemini Omni Flash, GA 2026-08-27. Non-text generative media, in the same
    // category as the veo-* / lyria-* / imagen-* entries.
    //
    // Classified on DECLARED CAPABILITY, not on the "omni" substring — "omni"
    // names OpenAI's TEXT-capable omni line, so the substring would have argued
    // the opposite. Google's release note calls it "our fast, conversational
    // video generation and editing model", and its model-card signature is
    // input `Video with audio` -> output `Video with audio` (extension,
    // keyframe interpolation, 360p-4K). It produces no text turn, so it cannot
    // be text-generation drift. Its `-preview` sibling `gemini-omni-flash-preview`
    // is already auto-excluded by PREVIEW_FAMILY; this GA id carries no
    // `-preview` token, so that rule cannot reach it and it must be enumerated.
    //
    // Decision: EXCLUDE, recorded in
    // drift-proposals/gemini-gemini-omni-1.1-flash-new-family.md.
    "gemini-omni-1.1-flash",
    // Restricted EARLY-ACCESS (EAP) surface, not a GA tier. Google's own live
    // /models entry declares `displayName` AND `description` as
    // "[Confidential] Gemini 3.7 Flash Video Understanding EAP" — the only one
    // of the 54 live entries carrying either marker. NOT excluded for being
    // "video" by name: it genuinely declares `generateContent` (same method set
    // as its GA sibling gemini-3.7-flash), so it IS text-capable. It is excluded
    // because it is a gated pre-GA surface, which is the same policy
    // PREVIEW_FAMILY applies to every `-preview` tier — aimock does not mock
    // pre-GA surfaces. It carries no trailing `-preview` token, so that rule
    // cannot reach it and it must be enumerated here (mirrors the
    // `-preview-tts` / `-preview-customtools` entries above).
    //
    // Decision: EXCLUDE, recorded in
    // drift-proposals/gemini-gemini-3.7-flash-video-understanding-eap-new-family.md.
    "gemini-3.7-flash-video-understanding-eap",
    // Lyria 3.5, the GA tier of Google's music-generation line. Non-text
    // generative media, same category as the imagen-* / veo-* /
    // gemini-omni-1.1-flash entries.
    //
    // This one is the sharpest case yet for classifying on the model card rather
    // than on `supportedGenerationMethods` ALONE: it declares
    // `[generateContent, countTokens]`, so a methods-only rule would have called
    // it text-capable and argued INCLUDE. Its own live entry settles it —
    // `displayName: "Lyria 3.5"`, `description: "Music Generation model"`. It
    // emits audio, not a text turn, so it can never be text-generation drift.
    // (Mirrors `gemini-omni-1.1-flash` above, where the name argued the wrong way
    // and the card decided.)
    //
    // Its `-preview` siblings `lyria-3-clip-preview` and `lyria-3-pro-preview`
    // are already auto-excluded by PREVIEW_FAMILY; this GA id carries no
    // `-preview` token, so that rule cannot reach it and it must be enumerated.
    //
    // Decision: EXCLUDE, recorded in
    // drift-proposals/gemini-lyria-3.5-new-family.md.
    "lyria-3.5",
    // Pre-GA moving alias, first listed 2026-09-22 (drift runs 35695604021 and
    // 35827604040). The id says both things itself: `-preview` (aimock does not
    // mock preview surfaces — the PREVIEW_FAMILY policy) and `-latest` (a
    // moving alias, not a stable family — the same policy as
    // `gemini-flash-latest` / `gemini-flash-lite-latest` / `gemini-pro-latest`
    // above). Its pinned sibling `antigravity-preview-05` is already
    // auto-excluded by PREVIEW_FAMILY; this id ends in `-latest`, not `-preview`
    // or `-preview-<digits>`, so that rule cannot reach it and it must be
    // enumerated. Not a voice family, so no knownVoiceModelFamilies pairing.
    //
    // Decision: EXCLUDE, recorded in
    // drift-proposals/gemini-antigravity-preview-latest-new-family.md.
    "antigravity-preview-latest",
    // NOTE: every `-preview` family (gemini-3.x preview tiers, deep-research
    // previews, antigravity-preview-05, computer-use-preview-10, image/tts/robotics
    // previews, lyria/veo/nano-banana previews, gemini-embedding-2-preview, …) is
    // auto-excluded by the PREVIEW_FAMILY rule (see isClassifiedFamily below).
  ]),
};

/**
 * Families a healthy live `/models` listing NO LONGER CONTAINS — the provider
 * retired them. Appended MECHANICALLY by `scripts/drift-sync.ts` on the morning
 * it first observes the absence, one entry per family, comment-marked with the
 * date and whether aimock's own source still references it.
 *
 * WHY THIS EXISTS. A provider-confirmed deprecation is a FACT, not a decision:
 * the provider's own listing already says the family is gone, so there is
 * nothing for a human to decide and no reason to page one. But the detector is
 * a pure `includeFamilies − live` diff, so without somewhere to WRITE the fact
 * down it re-derives the same ten deprecations every single morning, forever.
 * This set is that ledger, and `isRecordedDeprecation` is what takes a recorded
 * family out of the candidate set (see `detectDeprecatedFamiliesForSync` in
 * `scripts/drift-sync.ts` — the same shape as the `isForwardLookingFamily`
 * filter beside it).
 *
 * RECORDING IS NOT REMOVING, DELIBERATELY. A family recorded here STAYS in
 * `includeFamilies` and aimock KEEPS MOCKING IT. Users' tests pin retired model
 * ids for years, and dropping a mocked family would break them; the upstream
 * catalog shrinking is not a reason for aimock's to. So this set records what
 * the PROVIDER did, never what aimock serves — nothing on the serving path may
 * read it (asserted in `model-registry.test.ts`).
 *
 * IT IS NOT A CLASSIFICATION SET. `isClassifiedFamily` does not consult it, so
 * an entry here can neither classify a family nor silence a new-family alert.
 * Its only effect is to stop re-recording a deprecation already recorded.
 *
 * DELIBERATELY NOT MEMBERSHIP-PINNED in `logic-pin.test.ts`, unlike
 * `includeFamilies`/`excludeFamilies`/`FORWARD_LOOKING_FAMILIES`. Pinning it
 * would make every mechanical append fail drift-sync's own gate-2 (the pin
 * re-assert) and revert itself — the pin and the ledger are mutually exclusive
 * by construction. That costs nothing, because the one-line silencing edit a
 * pin defends against has no target here: this set gates no alert a human ever
 * sees. The invariant that DOES matter is enforced as a test instead —
 * `deprecatedFamilies[p] ⊆ includeFamilies[p]`, i.e. only a family aimock
 * actually mocks can be recorded as retired.
 *
 * CLEANING UP (optional, human, never automatic). Once nothing references a
 * recorded family, it may be dropped from aimock entirely: delete it from BOTH
 * `includeFamilies[provider]` and this set, then re-pin
 * `DATA_FROZEN["includeFamilies.<provider>"]` in `logic-pin.test.ts`. All three
 * edits belong in ONE reviewed commit — the re-pin is exactly the deliberate
 * human decision the pin exists to force, which is why drift-sync never makes
 * it. Nothing breaks if it is never done; the family just keeps being mocked.
 */
export const deprecatedFamilies: Record<Provider, Set<string>> = {
  openai: familySet("openai", [
    // drift-sync appends recorded deprecations here.
  ]),
  anthropic: familySet("anthropic", [
    // drift-sync appends recorded deprecations here.
    "claude-3-5-haiku", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
    "claude-3-5-sonnet", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
    "claude-3-7-sonnet", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
    "claude-3-haiku", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
    "claude-3-opus", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
    "claude-3-sonnet", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
    "claude-haiku-4", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
    "claude-opus-4", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
    "claude-opus-4-1", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; no remaining aimock reference — droppable from includeFamilies in a reviewed re-pin
    "claude-sonnet-4", // DEPRECATED 2026-08-07 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
  ]),
  gemini: familySet("gemini", [
    // drift-sync appends recorded deprecations here.
    "gemini-2.0-flash", // DEPRECATED 2026-08-12 (drift-sync): absent from live /models; still referenced in aimock source — mock retained
    "gemini-2.0-flash-lite", // DEPRECATED 2026-08-12 (drift-sync): absent from live /models; no remaining aimock reference — droppable from includeFamilies in a reviewed re-pin
  ]),
};

/**
 * True when `family`'s retirement has already been recorded in
 * {@link deprecatedFamilies} — i.e. the provider's listing dropped it, the fact
 * is written down, and re-detecting it is noise rather than news.
 *
 * Deliberately separate from {@link isClassifiedFamily}: classification decides
 * whether a LIVE family is drift, this decides whether a MISSING family is news.
 */
export function isRecordedDeprecation(family: string, provider: Provider): boolean {
  return deprecatedFamilies[provider].has(family);
}

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
