/**
 * Single source of truth for drift *surfaces*.
 *
 * A "surface" is one provider-endpoint shape that emits an `API DRIFT
 * DETECTED:` block (e.g. Cohere /v2/chat, Bedrock Invoke, OpenAI Images). Each
 * surface is identified by a stable machine slug (e.g. `"cohere-chat"`) that the
 * emitter declares via `formatDriftReport(context, diffs, surface)` and the
 * drift-report collector resolves back to the source file(s) that must be fixed.
 *
 * WHY a registry (not title-substring matching): the collector historically
 * keyed a drift block by `text.includes(<PROVIDER_MAP key>)` against ~9
 * hardcoded provider names. ~15 additional surfaces emit valid, fully-parseable
 * drift blocks whose PROSE titles are not keys, so they resolved to `null` →
 * quarantine (exit 5) → the auto-fix workflow (which gates on exit 2) never ran
 * for them. A slug-keyed registry shared by BOTH the emitter (schema.ts) and the
 * collector makes adding a surface a single edit that both consumers see, and
 * lets an unkeyed-but-emitting surface fail LOUDLY instead of silently
 * quarantining.
 *
 * This module is imported by:
 *   - `schema.ts` — validates a passed `surface` slug at emit time.
 *   - `scripts/drift-report-collector.ts` — resolves a slug to a source file.
 *   - `scripts/drift-report-collector.ts` legacy fallback — matches a no-marker
 *     block against the `provider` labels below (back-compat).
 */

/**
 * How a surface slug maps onto the source file(s) an auto-fixer must edit.
 *
 * Mirrors the fields the collector needs to build a `DriftEntry`. `fix-drift.ts`
 * hard-requires `builderFile` (non-empty string), `builderFunctions` (non-empty
 * string array), and `sdkShapesFile` (non-empty string) — so every entry here
 * must resolve to a real file with real, non-invented function names.
 */
export interface SurfaceMappingBase {
  /** Human-readable label used in the report/prompt and the legacy fallback. */
  provider: string;
  /** Source file the fixer edits, e.g. `"src/cohere.ts"`. */
  builderFile: string;
  /**
   * Builder/handler function names in `builderFile` (or across the surface's
   * source files) — non-empty. Steer the fixer's Read/Grep; NEVER invented.
   */
  builderFunctions: string[];
  /** Types file for the surface, or null if shapes are inline. */
  typesFile: string | null;
  /**
   * Optional override for the SDK-shapes reference file. Defaults to the
   * collector's `SDK_SHAPES_FILE` when omitted.
   */
  sdkShapesFile?: string;
}

/**
 * Whether a drift run ever puts this surface in front of the REAL provider.
 *
 * `"live"` — at least one emitting `*.drift.ts` leg issues a request to the
 * vendor (directly, or through `providers.ts` / `ws-providers.ts`), so a
 * vendor-side change can turn that leg red.
 *
 * `"none"` — every emitting leg only drives the LOCAL aimock server and grades
 * its output against a hand-written SDK-shape fixture in this repo. That is a
 * useful offline CONFORMANCE check (it reds when aimock's own builder changes
 * shape) but it is NOT drift detection: nothing in the loop can observe the
 * vendor, so the surface can silently rot and the drift run stays green.
 *
 * There is deliberately NO default. Omission used to mean "covered" by
 * implication, which is how four Bedrock surfaces and Vertex AI reported as
 * verified while no AWS or Google call has ever been made from this repo.
 * Every entry must state which it is, and `drift-collector.test.ts` re-derives
 * the answer from the emitting sources so a wrong declaration fails CI.
 */
export type SurfaceLiveCoverage = "live" | "none";

export type SurfaceMapping = SurfaceMappingBase &
  (
    | { liveCoverage: "live"; coverageNote?: string }
    /** `"none"` must say WHY there is no live leg and what it would take. */
    | { liveCoverage: "none"; coverageNote: string }
  );

const SDK_SHAPES_FILE = "src/__tests__/drift/sdk-shapes.ts";

/**
 * Slug → surface mapping. ONE table, two consumers. Adding a new provider
 * surface is a single edit here plus passing the slug at the emit site.
 *
 * Keys are stable machine slugs. Open-ended prose title suffixes (e.g.
 * `Bedrock ConverseStream:<eventType>`) do NOT affect the slug — the emitter
 * passes the stable slug and keeps the suffix in the prose `context`.
 */
export const SURFACE_REGISTRY: Record<string, SurfaceMapping> = {
  // --- Existing PROVIDER_MAP surfaces, migrated to slugs (unchanged mappings) ---
  "openai-chat": {
    provider: "OpenAI Chat",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/openai.ts",
    builderFunctions: ["resolve", "render"],
    typesFile: "src/types.ts",
  },
  "openai-responses": {
    provider: "OpenAI Responses",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/responses.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },
  anthropic: {
    provider: "Anthropic Claude",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/anthropic.ts",
    builderFunctions: ["resolve", "render"],
    typesFile: null,
  },
  "anthropic-catalog": {
    provider: "Anthropic native catalog",
    liveCoverage: "live",
    coverageNote:
      "Local catalog validation/cursor/lifecycle contracts run always. Bounded vendor comparisons require AIMOCK_NATIVE_PROVIDER_DRIFT=1 and ANTHROPIC_API_KEY; skipped comparisons establish no vendor conformance. Exact unknown-cursor behavior is undocumented.",
    builderFile: "src/response/catalog/anthropic-page.ts",
    builderFunctions: ["anthropicPage", "renderAnthropicModels"],
    typesFile: null,
  },
  "gemini-catalog": {
    provider: "Gemini native catalog",
    liveCoverage: "live",
    coverageNote:
      "Local page validation contracts run always. Bounded vendor comparisons require AIMOCK_NATIVE_PROVIDER_DRIFT=1 and GOOGLE_API_KEY; skipped comparisons establish no vendor conformance. Mock offset tokens are an implementation contract, not documented vendor tokens.",
    builderFile: "src/response/catalog/gemini-page.ts",
    builderFunctions: ["geminiPage", "renderGeminiModels"],
    typesFile: null,
  },
  "anthropic-native-errors": {
    provider: "Anthropic native authentication and version",
    liveCoverage: "live",
    coverageNote:
      "Local auth and permissive missing-version behavior run always. Bounded vendor auth/version observations require AIMOCK_NATIVE_PROVIDER_DRIFT=1; missing-version also requires ANTHROPIC_API_KEY. This records intentional default-policy divergence; it does not enforce headers.",
    builderFile: "src/response/errors.ts",
    builderFunctions: ["renderError"],
    typesFile: null,
  },
  "gemini-native-auth": {
    provider: "Gemini native authentication",
    liveCoverage: "live",
    coverageNote:
      "Local mock HTTP auth401 runs always. Bounded unauthenticated Developer API observations require AIMOCK_NATIVE_PROVIDER_DRIFT=1. Google API-key rejection may differ from the mock's configured inbound auth; no 401 vendor equivalence is assumed.",
    builderFile: "src/response/errors.ts",
    builderFunctions: ["renderError"],
    typesFile: null,
  },
  gemini: {
    provider: "Google Gemini",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/gemini.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },
  "openai-live": {
    provider: "OpenAI Live",
    liveCoverage: "live",
    coverageNote:
      "Both delegation modes exercise the primary provider WebSocket and actual aimock replay. Shapes use reviewed raw-wire descriptors; the installed OpenAI SDK has no Live types. Missing OPENAI_API_KEY skips the live legs.",
    builderFile: "src/ws-live.ts",
    builderFunctions: ["handleLiveSession"],
    typesFile: "src/live-types.ts",
    sdkShapesFile: "src/__tests__/drift/live-scenarios.ts",
  },
  "openai-realtime": {
    provider: "OpenAI Realtime",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/realtime.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },
  "openai-responses-ws": {
    provider: "OpenAI Responses WS",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/responses.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },
  "gemini-live": {
    provider: "Gemini Live",
    liveCoverage: "live",
    builderFile: "src/ws-gemini-live.ts",
    builderFunctions: ["handleWebSocketGeminiLive"],
    typesFile: null,
  },
  "openai-embeddings": {
    provider: "OpenAI Embeddings",
    liveCoverage: "live",
    builderFile: "src/helpers.ts",
    builderFunctions: ["buildEmbeddingResponse", "generateDeterministicEmbedding"],
    typesFile: null,
    sdkShapesFile: SDK_SHAPES_FILE,
  },
  "gemini-interactions": {
    provider: "Gemini Interactions",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/interactions.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },

  // --- Previously unmapped surfaces (the hole) — now keyed. -------------------
  "cohere-chat": {
    provider: "Cohere Chat",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/cohere.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },
  rerank: {
    provider: "Cohere Rerank",
    liveCoverage: "live",
    builderFile: "src/rerank.ts",
    builderFunctions: ["handleRerank"],
    typesFile: null,
  },
  "bedrock-invoke": {
    provider: "Bedrock Invoke",
    liveCoverage: "none",
    coverageNote:
      "No live AWS leg: nothing in this repo implements SigV4 request signing (no @aws-sdk dependency, no HMAC signer), so the Bedrock legs only drive the local mock. Offline conformance only.",
    builderFile: "src/response/usage/codecs/anthropic.ts",
    builderFunctions: ["resolve", "render"],
    typesFile: null,
  },
  "bedrock-invoke-stream": {
    provider: "Bedrock InvokeStream",
    liveCoverage: "none",
    coverageNote:
      "No live AWS leg — see `bedrock-invoke`. The binary event-stream frames are graded against a hand-written fixture, never against Bedrock.",
    builderFile: "src/response/usage/codecs/anthropic.ts",
    builderFunctions: ["resolve", "render"],
    typesFile: null,
  },
  "bedrock-converse": {
    provider: "Bedrock Converse",
    liveCoverage: "none",
    coverageNote: "No live AWS leg — see `bedrock-invoke`. Offline conformance only.",
    builderFile: "src/response/usage/codecs/converse.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },
  "bedrock-converse-stream": {
    provider: "Bedrock ConverseStream",
    liveCoverage: "none",
    coverageNote: "No live AWS leg — see `bedrock-invoke`. Offline conformance only.",
    builderFile: "src/response/usage/codecs/converse.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },
  ollama: {
    provider: "Ollama",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/ollama.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },
  "fal-sync": {
    provider: "fal.ai sync-run",
    liveCoverage: "none",
    coverageNote:
      "No live fal.ai leg: `fal.drift.ts` only drives the local mock's sync-run passthrough. The QUEUE surface (`fal-queue`) does have a live canary; this one does not.",
    builderFile: "src/fal.ts",
    builderFunctions: ["handleFal", "imageResponseToFalJson", "videoResponseToFalJson"],
    typesFile: null,
  },
  "fal-queue": {
    provider: "fal.ai queue",
    liveCoverage: "live",
    builderFile: "src/fal.ts",
    builderFunctions: ["handleFal", "walkFalQueue", "resolveProgression"],
    typesFile: null,
  },
  elevenlabs: {
    provider: "ElevenLabs",
    liveCoverage: "live",
    coverageNote:
      "Live credit rests on ONE block: the `/v1/sound-generation` case fetches `api.elevenlabs.io` and grades " +
      "aimock's response envelope (status, Content-Type, body presence) against the vendor's. The body is " +
      "opaque audio, so no vendor-observed JSON shape exists for any route here. `/v1/music`, " +
      "`/v1/music/stream` and the 400 cases are offline conformance; `/v1/music/plan` is passthrough " +
      "conformance against a test-authored fixture graded against the SDK's `MusicPrompt.Raw`, with no " +
      "vendor observation.",
    builderFile: "src/elevenlabs-audio.ts",
    builderFunctions: ["handleElevenLabsTTS", "handleElevenLabsAudio"],
    typesFile: null,
  },
  "elevenlabs-voice": {
    provider: "ElevenLabs Voice Design",
    liveCoverage: "none",
    coverageNote:
      "No live ElevenLabs Voice Design leg: `elevenlabs-voice.drift.ts` only drives the local mock. A key " +
      "is provided in CI (test-drift.yml and fix-drift.yml pass `secrets.ELEVENLABS_API_KEY`), but no case in that " +
      "file fetches the vendor with it — these routes have no vendor leg and are offline-only — so no " +
      "SUCCESSFUL response from any of these routes has ever been observed here — the shapes " +
      "come from `@elevenlabs/elevenlabs-js@2.68.0` serialization types, a secondary source. Offline " +
      "conformance only: it reds when aimock's own serializer changes shape, never when the vendor does. " +
      "Retiring this needs a funded key and one recorded design + create round-trip; the `elevenlabs` " +
      "surface's live `/v1/sound-generation` leg does NOT cover these routes.",
    builderFile: "src/elevenlabs-voice.ts",
    builderFunctions: [
      "voiceDesignToJson",
      "handleElevenLabsVoiceDesign",
      "handleElevenLabsVoiceCreate",
      "buildSyntheticVoice",
    ],
    typesFile: "src/types.ts",
  },
  images: {
    provider: "OpenAI Images",
    liveCoverage: "none",
    coverageNote:
      "No live OpenAI Images leg: `images.drift.ts` only drives the local mock. Offline conformance only. " +
      "`/v1/images/variations` is out of scope entirely — the endpoint is REMOVED upstream (404, zero-byte " +
      "body, observed 2026-09-15) and `handleImageVariations` now replays that removal, so it is not a " +
      "response builder and must not be steered at as one; it is pinned by `image-edits.test.ts`.",
    builderFile: "src/images.ts",
    builderFunctions: ["handleImages", "handleImageEdit"],
    typesFile: null,
  },
  video: {
    provider: "OpenAI Video",
    liveCoverage: "none",
    coverageNote:
      "No live OpenAI Video leg: `video.drift.ts` only drives the local mock. Offline conformance only.",
    builderFile: "src/video.ts",
    builderFunctions: ["handleVideoCreate", "handleVideoStatus"],
    typesFile: null,
  },
  moderation: {
    provider: "OpenAI Moderations",
    liveCoverage: "none",
    coverageNote:
      "No live OpenAI Moderations leg: `moderation.drift.ts` only drives the local mock. Offline conformance only.",
    builderFile: "src/moderation.ts",
    builderFunctions: ["handleModeration"],
    typesFile: null,
  },
  transcription: {
    provider: "Transcription",
    liveCoverage: "live",
    builderFile: "src/transcription.ts",
    builderFunctions: ["handleTranscription", "extractFormField", "extractBoundary"],
    typesFile: null,
  },
  "vertex-ai": {
    provider: "Vertex AI",
    liveCoverage: "none",
    coverageNote:
      "No live Vertex leg: `vertex-ai.drift.ts` only drives the local mock's Vertex-style path. A live leg needs a GCP service account and an OAuth2 token exchange, neither of which this repo does.",
    builderFile: "src/response/usage/codecs/gemini.ts",
    builderFunctions: ["render"],
    typesFile: null,
  },
  // Covered by ONE real vendor-facing check: the FREE, KEYLESS auth-layer
  // error-envelope canary in `byteplus-video.drift.ts`, which runs on every
  // drift run and reds when Ark restructures `{ error: { code, message, param,
  // type } }` or its `x-error-code` header. The SUCCESS/poll shapes of this
  // surface are NOT covered (they need a funded key or a compile-time
  // assignability check) — see that file's header. `sdkShapesFile` points at
  // the drift leg rather than the shared `sdk-shapes.ts`, which holds nothing
  // for this surface: the observed vendor truth lives in its OBSERVED_*
  // constants, and that is what a fixer must re-observe and edit.
  "byteplus-video": {
    provider: "BytePlus Video",
    liveCoverage: "live",
    builderFile: "src/byteplus-video.ts",
    builderFunctions: [
      "handleBytePlusVideoCreate",
      "handleBytePlusVideoStatus",
      "proxyBytePlusVideoSubmit",
      "serializeBytePlusVideoTask",
    ],
    typesFile: null,
    sdkShapesFile: "src/__tests__/drift/byteplus-video.drift.ts",
  },
  "openrouter-video": {
    provider: "OpenRouter Video",
    liveCoverage: "live",
    builderFile: "src/openrouter-video.ts",
    builderFunctions: [
      "handleOpenRouterVideoCreate",
      "handleOpenRouterVideoStatus",
      "handleOpenRouterVideoModels",
      "handleOpenRouterVideoContent",
    ],
    typesFile: null,
  },
  "openrouter-chat": {
    provider: "OpenRouter Chat",
    liveCoverage: "live",
    builderFile: "src/response/usage/codecs/openrouter.ts",
    builderFunctions: ["resolve", "render"],
    typesFile: "src/types.ts",
  },
};

/**
 * Every slug the emitter (`schema.ts` call sites) may pass. Exported so the
 * registry-coverage test can assert each is a key of `SURFACE_REGISTRY` — a new
 * surface either has an entry or fails the drift run loudly (belt-and-braces
 * with the collector's runtime throw on an unknown marker slug).
 */
export const KNOWN_SURFACE_SLUGS: readonly string[] = Object.keys(SURFACE_REGISTRY);

/** True when `slug` is a registered surface. */
export function isKnownSurface(slug: string): slug is keyof typeof SURFACE_REGISTRY {
  return Object.prototype.hasOwnProperty.call(SURFACE_REGISTRY, slug);
}
