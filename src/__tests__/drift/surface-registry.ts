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
export interface SurfaceMapping {
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
    builderFile: "src/helpers.ts",
    builderFunctions: [
      "buildTextCompletion",
      "buildToolCallCompletion",
      "buildTextChunks",
      "buildToolCallChunks",
    ],
    typesFile: "src/types.ts",
  },
  "openai-responses": {
    provider: "OpenAI Responses",
    builderFile: "src/responses.ts",
    builderFunctions: [
      "buildTextResponse",
      "buildToolCallResponse",
      "buildTextStreamEvents",
      "buildToolCallStreamEvents",
    ],
    typesFile: null,
  },
  anthropic: {
    provider: "Anthropic Claude",
    builderFile: "src/messages.ts",
    builderFunctions: [
      "buildClaudeTextResponse",
      "buildClaudeToolCallResponse",
      "buildClaudeTextStreamEvents",
      "buildClaudeToolCallStreamEvents",
    ],
    typesFile: null,
  },
  gemini: {
    provider: "Google Gemini",
    builderFile: "src/gemini.ts",
    builderFunctions: [
      "buildGeminiTextResponse",
      "buildGeminiToolCallResponse",
      "buildGeminiTextStreamChunks",
      "buildGeminiToolCallStreamChunks",
    ],
    typesFile: null,
  },
  "openai-realtime": {
    provider: "OpenAI Realtime",
    builderFile: "src/ws-realtime.ts",
    builderFunctions: ["handleWebSocketRealtime", "realtimeItemsToMessages"],
    typesFile: null,
  },
  "openai-responses-ws": {
    provider: "OpenAI Responses WS",
    builderFile: "src/ws-responses.ts",
    builderFunctions: ["handleWebSocketResponses"],
    typesFile: null,
  },
  "gemini-live": {
    provider: "Gemini Live",
    builderFile: "src/ws-gemini-live.ts",
    builderFunctions: ["handleWebSocketGeminiLive"],
    typesFile: null,
  },
  "openai-embeddings": {
    provider: "OpenAI Embeddings",
    builderFile: "src/helpers.ts",
    builderFunctions: ["buildEmbeddingResponse", "generateDeterministicEmbedding"],
    typesFile: null,
    sdkShapesFile: SDK_SHAPES_FILE,
  },
  "gemini-interactions": {
    provider: "Gemini Interactions",
    builderFile: "src/gemini-interactions.ts",
    builderFunctions: [
      "buildInteractionsTextResponse",
      "buildInteractionsToolCallResponse",
      "buildInteractionsContentWithToolCallsResponse",
      "buildInteractionsTextSSEEvents",
      "buildInteractionsToolCallSSEEvents",
      "buildInteractionsContentWithToolCallsSSEEvents",
    ],
    typesFile: null,
  },

  // --- Previously unmapped surfaces (the hole) — now keyed. -------------------
  "cohere-chat": {
    provider: "Cohere Chat",
    builderFile: "src/cohere.ts",
    builderFunctions: ["handleCohere", "cohereToCompletionRequest"],
    typesFile: null,
  },
  rerank: {
    provider: "Cohere Rerank",
    builderFile: "src/rerank.ts",
    builderFunctions: ["handleRerank"],
    typesFile: null,
  },
  "bedrock-invoke": {
    provider: "Bedrock Invoke",
    builderFile: "src/bedrock.ts",
    builderFunctions: [
      "handleBedrock",
      "handleBedrockStream",
      "bedrockToCompletionRequest",
      "buildBedrockStreamTextEvents",
      "buildBedrockStreamToolCallEvents",
      "buildBedrockStreamContentWithToolCallsEvents",
    ],
    typesFile: null,
  },
  "bedrock-invoke-stream": {
    provider: "Bedrock InvokeStream",
    builderFile: "src/bedrock.ts",
    builderFunctions: [
      "handleBedrockStream",
      "buildBedrockStreamTextEvents",
      "buildBedrockStreamToolCallEvents",
      "buildBedrockStreamContentWithToolCallsEvents",
    ],
    typesFile: null,
  },
  "bedrock-converse": {
    provider: "Bedrock Converse",
    builderFile: "src/bedrock-converse.ts",
    builderFunctions: ["handleConverse", "converseToCompletionRequest"],
    typesFile: null,
  },
  "bedrock-converse-stream": {
    provider: "Bedrock ConverseStream",
    builderFile: "src/bedrock-converse.ts",
    builderFunctions: ["handleConverseStream", "converseToCompletionRequest"],
    typesFile: null,
  },
  ollama: {
    provider: "Ollama",
    builderFile: "src/ollama.ts",
    builderFunctions: ["handleOllama", "handleOllamaGenerate", "ollamaToCompletionRequest"],
    typesFile: null,
  },
  "fal-sync": {
    provider: "fal.ai sync-run",
    builderFile: "src/fal.ts",
    builderFunctions: ["handleFal", "imageResponseToFalJson", "videoResponseToFalJson"],
    typesFile: null,
  },
  "fal-queue": {
    provider: "fal.ai queue",
    builderFile: "src/fal.ts",
    builderFunctions: ["handleFal", "walkFalQueue", "resolveProgression"],
    typesFile: null,
  },
  elevenlabs: {
    provider: "ElevenLabs",
    builderFile: "src/elevenlabs-audio.ts",
    builderFunctions: ["handleElevenLabsTTS", "handleElevenLabsAudio"],
    typesFile: null,
  },
  images: {
    provider: "OpenAI Images",
    builderFile: "src/images.ts",
    builderFunctions: ["handleImages", "handleImageEdit", "handleImageVariations"],
    typesFile: null,
  },
  video: {
    provider: "OpenAI Video",
    builderFile: "src/video.ts",
    builderFunctions: ["handleVideoCreate", "handleVideoStatus"],
    typesFile: null,
  },
  moderation: {
    provider: "OpenAI Moderations",
    builderFile: "src/moderation.ts",
    builderFunctions: ["handleModeration"],
    typesFile: null,
  },
  transcription: {
    provider: "Transcription",
    builderFile: "src/transcription.ts",
    builderFunctions: ["handleTranscription", "extractFormField", "extractBoundary"],
    typesFile: null,
  },
  "vertex-ai": {
    provider: "Vertex AI",
    builderFile: "src/gemini.ts",
    builderFunctions: [
      "handleGemini",
      "buildGeminiTextResponse",
      "buildGeminiToolCallResponse",
      "buildGeminiTextStreamChunks",
      "buildGeminiToolCallStreamChunks",
    ],
    typesFile: null,
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
