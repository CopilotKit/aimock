import type { AnthropicCatalogPage } from "./anthropic-page.js";
import type { GeminiCatalogPage } from "./gemini-page.js";

const DEFAULT_MODELS = [
  "gpt-4",
  "gpt-4o",
  "claude-3-5-sonnet-20241022",
  "gemini-2.0-flash",
  "text-embedding-3-small",
];

/** The core fallback is shared by list and detail visibility. */
export function coreModelIds(ids: readonly string[]): readonly string[] {
  return ids.length > 0 ? ids : DEFAULT_MODELS;
}

export function renderOpenAIModel(id: string) {
  return { id, object: "model" as const, created: 1686935002, owned_by: "aimock" };
}

export function renderAnthropicModel(id: string) {
  return {
    type: "model" as const,
    id,
    display_name: id,
    created_at: "1970-01-01T00:00:00Z",
    capabilities: null,
    lifecycle: "active" as const,
    line: null,
    max_input_tokens: null,
    max_tokens: null,
    deprecated_at: null,
    retires_at: null,
  };
}

export function renderAnthropicModels(page: AnthropicCatalogPage) {
  return {
    data: page.ids.map(renderAnthropicModel),
    has_more: page.hasMore,
    first_id: page.firstId,
    last_id: page.lastId,
  };
}

export function renderGeminiModel(id: string) {
  return {
    name: `models/${id}`,
    baseModelId: id,
    version: "1",
    displayName: id,
    inputTokenLimit: 128000,
    outputTokenLimit: 8192,
    supportedGenerationMethods: ["generateContent", "countTokens"],
  };
}

export function renderGeminiModels(page: GeminiCatalogPage) {
  return {
    models: page.ids.map(renderGeminiModel),
    ...(page.nextPageToken === undefined ? {} : { nextPageToken: page.nextPageToken }),
  };
}

const DEFAULT_OPENROUTER_MODELS = [
  "openai/gpt-4o",
  "anthropic/claude-3.5-sonnet",
  "google/gemini-2.0-flash-001",
];

export const DEFAULT_OPENROUTER_VIDEO_MODEL = "bytedance/seedance-2.0";
const DEFAULT_OPENROUTER_VIDEO_MODELS = [DEFAULT_OPENROUTER_VIDEO_MODEL];

/** Native OpenAI list metadata, including its fixed historical timestamp. */
export function renderOpenAIModels(ids: readonly string[]) {
  return {
    object: "list" as const,
    data: coreModelIds(ids).map(renderOpenAIModel),
  };
}

/** Call the supplied clock once per entry, as the existing tags route does. */
export function renderOllamaTags(ids: readonly string[], readModifiedTime: () => string) {
  return {
    models: (ids.length > 0 ? ids : DEFAULT_MODELS).map((name) => ({
      name,
      model: name,
      modified_at: readModifiedTime(),
      size: 0,
      digest: "",
      details: {},
    })),
  };
}

/**
 * Build one OpenRouter model-catalog object (deterministic static filler).
 * Field set mirrors real OpenRouter bytes (or-capture/models-first.json):
 * pricing values are STRINGS; the object also carries hugging_face_id,
 * knowledge_cutoff, supported_voices, links, default_parameters,
 * expiration_date, and a `reasoning` descriptor (SDKs tolerate extras).
 */
function openRouterModelObject(id: string) {
  return {
    id,
    canonical_slug: id,
    hugging_face_id: null,
    name: id,
    created: 0,
    description: `Mock OpenRouter model ${id} served by aimock.`,
    context_length: 128000,
    architecture: {
      modality: "text->text",
      input_modalities: ["text"],
      output_modalities: ["text"],
      tokenizer: "Other",
      instruct_type: null,
    },
    pricing: {
      prompt: "0",
      completion: "0",
      request: "0",
      image: "0",
      web_search: "0",
      internal_reasoning: "0",
      input_cache_read: "0",
      input_cache_write: "0",
    },
    top_provider: {
      context_length: 128000,
      max_completion_tokens: 16384,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: [
      "tools",
      "tool_choice",
      "max_tokens",
      "temperature",
      "top_p",
      "stop",
      "reasoning",
    ],
    default_parameters: null,
    supported_voices: null,
    knowledge_cutoff: null,
    expiration_date: null,
    links: { details: `/api/v1/models/${id}/endpoints` },
    reasoning: { mandatory: false, default_enabled: false },
  };
}

/** OpenRouter chat's native catalog body and unchanged fallback model set. */
export function renderOpenRouterChatModels(ids: readonly string[]) {
  return { data: (ids.length > 0 ? ids : DEFAULT_OPENROUTER_MODELS).map(openRouterModelObject) };
}

/** OpenRouter video's native model metadata and unchanged fallback model set. */
export function renderOpenRouterVideoModels(ids: readonly string[]) {
  return {
    data: (ids.length > 0 ? ids : DEFAULT_OPENROUTER_VIDEO_MODELS).map((id) => ({
      id,
      name: id,
      supported_durations: [4, 8],
      supported_resolutions: ["720p", "1080p"],
      supported_aspect_ratios: ["16:9", "9:16", "1:1"],
      supported_frame_images: [],
      supported_sizes: [],
      generate_audio: false,
      seed: true,
      pricing_skus: [],
    })),
  };
}
