/**
 * Single source of truth for every first-class HTTP route aimock serves.
 *
 * Both the HTTP dispatcher (`server.ts`) and the machine-readable catalog
 * (`openapi.ts` → `GET /__aimock/openapi.json` + `GET /__aimock/routes`) import
 * from this module. Drift is prevented three ways, not one:
 *
 * 1. Shared bindings — the dispatcher matches against the exact `*_PATH`
 *    constants and `*_RE` patterns defined here (never inline literals), and
 *    `metrics.ts` path-label normalization imports the same patterns, so the
 *    three consumers cannot disagree on what a route looks like.
 * 2. Bidirectional tests (`openapi-catalog.test.ts`) — every catalog entry is
 *    probed against the live router (catalog → router) AND every dispatch
 *    literal/pattern imported from this module must have a catalog entry
 *    whose example path it matches (router → catalog).
 * 3. Runtime drift guard — the dispatcher's terminal 404 consults
 *    `matchRouteDefinition` and warns when the registry claims a route the
 *    dispatcher just missed.
 *
 * `path` is the OpenAPI path template (`{param}` for dynamic segments).
 * `examplePath` is a concrete path the drift test probes against the live
 * server (a templated path can never be fetched verbatim).
 *
 * Plugin mounts (`Mountable`: A2A/MCP/AG-UI/vector) are dynamic per-server and
 * intentionally excluded — this registry covers the built-in first-class
 * surfaces only. Likewise excluded from `ROUTE_DEFINITIONS` (their bindings
 * above are still shared so dispatch cannot typo them): the WebSocket upgrades
 * (`REALTIME_PATH`, `GEMINI_LIVE_PATH`, `LIVE_PATH` — same URL as an HTTP
 * route or no HTTP method at all, so they cannot appear in an HTTP catalog)
 * and the header-gated fal.ai proxy branch (`FAL_ROUTE_RE` +
 * `x-fal-target-host`, a dynamic upstream mirror rather than a fixed route).
 */

export const COMPLETIONS_PATH = "/v1/chat/completions";
export const RESPONSES_PATH = "/v1/responses";
export const REALTIME_PATH = "/v1/realtime";
export const LIVE_PATH = "/v1/live/sessions";
export const GEMINI_LIVE_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const MESSAGES_PATH = "/v1/messages";
export const EMBEDDINGS_PATH = "/v1/embeddings";
export const COHERE_CHAT_PATH = "/v2/chat";
export const COHERE_EMBED_PATH = "/v2/embed";
export const SEARCH_PATH = "/search";
export const RERANK_PATH = "/v2/rerank";
export const MODERATIONS_PATH = "/v1/moderations";
export const IMAGES_PATH = "/v1/images/generations";
export const IMAGES_EDIT_PATH = "/v1/images/edits";
export const IMAGES_VARIATIONS_PATH = "/v1/images/variations";
export const SPEECH_PATH = "/v1/audio/speech";
export const TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";
export const TRANSLATIONS_PATH = "/v1/audio/translations";
export const VIDEOS_PATH = "/v1/videos";
// Grok submit is an exact literal; Grok status reuses the OpenAI
// `/v1/videos/{id}` shape (dispatch guards `id !== "generations"` and the
// job-map lookup disambiguates Sora). Shared with metrics.ts normalization.
export const GROK_VIDEO_SUBMIT_PATH = "/v1/videos/generations";
export const GROK_VIDEO_STATUS_RE = /^\/v1\/videos\/([^/]+)$/;
export const OPENAI_VIDEO_STATUS_RE = /^\/v1\/videos\/([^/]+)$/;
export const GEMINI_PREDICT_RE = /^\/v1beta\/models\/([^:]+):predict$/;
// Veo submit (`:predictLongRunning`, anchored so it never collides with the
// bare Gemini `:predict` route) + Veo operation polling. The operation RE
// allows multi-segment names (`operations/.+`); the catalog template below
// uses the single-segment canonical form. Shared with metrics.ts.
export const VEO_PREDICT_LRO_RE = /^\/v1beta\/models\/([^:]+):predictLongRunning$/;
export const VEO_OPERATION_RE = /^\/v1beta\/(operations\/.+)$/;
// BytePlus Ark (Seedance) task lifecycle. The `/api/v3` prefix is ENUMERATED
// rather than wildcarded: a tolerant prefix would additionally claim
// `/fal/contents/generations/tasks`, which dispatches pre-rewrite ~1,100
// lines ahead of every fal branch. Shared with metrics.ts normalization.
export const BYTEPLUS_VIDEO_SUBMIT_RE = /^(?:\/api\/v3)?\/contents\/generations\/tasks$/;
export const BYTEPLUS_VIDEO_STATUS_RE = /^(?:\/api\/v3)?\/contents\/generations\/tasks\/([^/]+)$/;
export const ELEVENLABS_SOUND_GENERATION_PATH = "/v1/sound-generation";
export const ELEVENLABS_TTS_RE = /^\/v1\/text-to-speech\/([^/]+)$/;
export const ELEVENLABS_MUSIC_RE = /^\/v1\/music(?:\/(.+))?$/;
export const ELEVENLABS_VOICE_DESIGN_PATH = "/v1/text-to-voice/design";
export const ELEVENLABS_VOICE_CREATE_PATH = "/v1/text-to-voice";
export const ELEVENLABS_VOICE_RE = /^\/v1\/voices\/([^/]+)$/;
export const FAL_QUEUE_SUBMIT_RE = /^\/fal\/queue\/submit\/(.+)$/;
export const FAL_QUEUE_REQUESTS_RE = /^\/fal\/queue\/requests\/(.+)$/;
export const FAL_RUN_RE = /^\/fal\/run\/(.+)$/;
// The fal.ai route shape, shared with server.ts dispatch and metrics.ts path
// labels: a bare `/fal` is routed (header-gated upstream mirror), so one
// binding keeps the route rule and the label rule from drifting.
export const FAL_ROUTE_RE = /^\/fal(?:\/.*)?$/;
export const GEMINI_INTERACTIONS_PATH = "/v1beta/interactions";
export const GEMINI_PATH_RE = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/;
export const GEMINI_EMBED_RE = /^\/v1beta\/models\/([^:]+):embedContent$/;
export const AZURE_DEPLOYMENT_RE =
  /^\/openai\/deployments\/([^/]+)\/(chat\/completions|embeddings)$/;
export const BEDROCK_INVOKE_RE = /^\/model\/([^/]+)\/invoke$/;
export const BEDROCK_STREAM_RE = /^\/model\/([^/]+)\/invoke-with-response-stream$/;
export const BEDROCK_CONVERSE_RE = /^\/model\/([^/]+)\/converse$/;
export const BEDROCK_CONVERSE_STREAM_RE = /^\/model\/([^/]+)\/converse-stream$/;
export const VERTEX_AI_RE =
  /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

export const OLLAMA_CHAT_PATH = "/api/chat";
export const OLLAMA_GENERATE_PATH = "/api/generate";
export const OLLAMA_EMBEDDINGS_PATH = "/api/embeddings";
export const OLLAMA_EMBED_PATH = "/api/embed";
export const OLLAMA_TAGS_PATH = "/api/tags";

export const OPENROUTER_VIDEOS_PATH = "/api/v1/videos";
export const OPENROUTER_VIDEO_MODELS_PATH = "/api/v1/videos/models";
export const OPENROUTER_MODELS_PATH = "/api/v1/models";
export const OPENROUTER_KEY_PATH = "/api/v1/key";
export const OPENROUTER_CREDITS_PATH = "/api/v1/credits";
// Dispatched in server.ts (content RE → models exact → status RE → submit
// exact) and reused by metrics.ts path-label normalization — one binding so
// dispatch, catalog, and metric labels cannot disagree.
export const OPENROUTER_VIDEO_CONTENT_RE = /^\/api\/v1\/videos\/([^/]+)\/content$/;
export const OPENROUTER_VIDEO_STATUS_RE = /^\/api\/v1\/videos\/([^/]+)$/;

export const HEALTH_PATH = "/health";
export const READY_PATH = "/ready";
export const METRICS_PATH = "/metrics";
export const MODELS_PATH = "/v1/models";
export const REQUESTS_PATH = "/v1/_requests";

export const FILES_PATH = "/v1/files";
// Shared with metrics.ts path-label normalization (file ids are random
// `file-…` values; labels collapse to `{id}`). Content reads before id: the
// id RE would otherwise swallow the content suffix.
export const FILES_CONTENT_RE = /^\/v1\/files\/([^/]+)\/content$/;
export const FILES_ID_RE = /^\/v1\/files\/([^/]+)$/;

// OpenAI Batches API. Cancel reads before id (the id RE would swallow
// `/cancel`). Shared with server.ts dispatch and metrics.ts normalization.
export const BATCHES_PATH = "/v1/batches";
export const BATCHES_CANCEL_RE = /^\/v1\/batches\/([^/]+)\/cancel$/;
export const BATCHES_ID_RE = /^\/v1\/batches\/([^/]+)$/;
export const FINE_TUNING_JOBS_PATH = "/v1/fine_tuning/jobs";
export const FINE_TUNING_ID_RE = /^\/v1\/fine_tuning\/jobs\/([^/]+)$/;
export const FINE_TUNING_CANCEL_RE = /^\/v1\/fine_tuning\/jobs\/([^/]+)\/cancel$/;
export const FINE_TUNING_EVENTS_RE = /^\/v1\/fine_tuning\/jobs\/([^/]+)\/events$/;

export const CONTROL_PREFIX = "/__aimock";

export interface RouteDefinition {
  method: string;
  /** OpenAPI path template, e.g. `/v1/text-to-speech/{voice_id}`. */
  path: string;
  /** Concrete path the live-router drift test probes. Defaults to `path`. */
  examplePath?: string;
  service: string;
  description: string;
}

/**
 * Every built-in route, in the same order the dispatcher checks them
 * (mounts → ollama → openrouter-video → byteplus → openrouter discovery →
 * azure/compat → ops → models/requests → provider handlers → fal → chat).
 * Regex branches are represented by their canonical OpenAPI template.
 */
export const ROUTE_DEFINITIONS: RouteDefinition[] = [
  // Ollama (pre-rewrite band)
  { method: "POST", path: OLLAMA_CHAT_PATH, service: "ollama", description: "Ollama chat" },
  {
    method: "POST",
    path: OLLAMA_GENERATE_PATH,
    service: "ollama",
    description: "Ollama generate",
  },
  {
    method: "POST",
    path: OLLAMA_EMBEDDINGS_PATH,
    service: "ollama",
    description: "Ollama embeddings (legacy path)",
  },
  {
    method: "POST",
    path: OLLAMA_EMBED_PATH,
    service: "ollama",
    description: "Ollama embed (current path)",
  },
  { method: "GET", path: OLLAMA_TAGS_PATH, service: "ollama", description: "Ollama tags" },
  // OpenRouter async video lifecycle
  {
    method: "GET",
    path: "/api/v1/videos/{jobId}/content",
    examplePath: "/api/v1/videos/test-job/content",
    service: "video",
    description: "OpenRouter video content download",
  },
  {
    method: "GET",
    path: OPENROUTER_VIDEO_MODELS_PATH,
    service: "video",
    description: "OpenRouter video model listing",
  },
  {
    method: "GET",
    path: "/api/v1/videos/{jobId}",
    examplePath: "/api/v1/videos/test-job",
    service: "video",
    description: "OpenRouter video job status",
  },
  {
    method: "POST",
    path: OPENROUTER_VIDEOS_PATH,
    service: "video",
    description: "OpenRouter video job submit",
  },
  // BytePlus Ark (Seedance) — canonical + /api/v3-prefixed aliases
  {
    method: "GET",
    path: "/contents/generations/tasks/{id}",
    examplePath: "/contents/generations/tasks/test-id",
    service: "video",
    description: "BytePlus video task status",
  },
  {
    method: "GET",
    path: "/api/v3/contents/generations/tasks/{id}",
    examplePath: "/api/v3/contents/generations/tasks/test-id",
    service: "video",
    description: "BytePlus video task status (api/v3 prefix)",
  },
  {
    method: "POST",
    path: "/contents/generations/tasks",
    service: "video",
    description: "BytePlus video task submit",
  },
  {
    method: "POST",
    path: "/api/v3/contents/generations/tasks",
    service: "video",
    description: "BytePlus video task submit (api/v3 prefix)",
  },
  // OpenRouter discovery
  {
    method: "GET",
    path: OPENROUTER_MODELS_PATH,
    service: "openrouter",
    description: "OpenRouter models",
  },
  {
    method: "GET",
    path: OPENROUTER_KEY_PATH,
    service: "openrouter",
    description: "OpenRouter key info",
  },
  {
    method: "GET",
    path: OPENROUTER_CREDITS_PATH,
    service: "openrouter",
    description: "OpenRouter credits",
  },
  // Azure OpenAI deployments (rewritten to /v1/* downstream)
  {
    method: "POST",
    path: "/openai/deployments/{deploymentId}/chat/completions",
    examplePath: "/openai/deployments/test-deployment/chat/completions",
    service: "azure",
    description: "Azure OpenAI chat completions",
  },
  {
    method: "POST",
    path: "/openai/deployments/{deploymentId}/embeddings",
    examplePath: "/openai/deployments/test-deployment/embeddings",
    service: "azure",
    description: "Azure OpenAI embeddings",
  },
  // Ops
  { method: "GET", path: HEALTH_PATH, service: "ops", description: "Health probe (public)" },
  { method: "GET", path: READY_PATH, service: "ops", description: "Readiness probe (public)" },
  { method: "GET", path: METRICS_PATH, service: "ops", description: "Prometheus metrics (public)" },
  // Models + legacy journal
  { method: "GET", path: MODELS_PATH, service: "openai", description: "Models listing" },
  { method: "GET", path: REQUESTS_PATH, service: "control", description: "Legacy journal listing" },
  {
    method: "DELETE",
    path: REQUESTS_PATH,
    service: "control",
    description: "Legacy journal clear",
  },
  // OpenAI Responses + Anthropic + Cohere + core OpenAI
  { method: "POST", path: RESPONSES_PATH, service: "openai", description: "OpenAI Responses API" },
  { method: "POST", path: MESSAGES_PATH, service: "anthropic", description: "Anthropic messages" },
  { method: "POST", path: COHERE_CHAT_PATH, service: "cohere", description: "Cohere chat" },
  { method: "POST", path: COHERE_EMBED_PATH, service: "cohere", description: "Cohere embed" },
  { method: "POST", path: EMBEDDINGS_PATH, service: "openai", description: "OpenAI embeddings" },
  {
    method: "POST",
    path: IMAGES_PATH,
    service: "images",
    description: "Image generation",
  },
  {
    method: "POST",
    path: IMAGES_EDIT_PATH,
    service: "images",
    description: "Image edits (multipart)",
  },
  {
    method: "POST",
    path: "/v1/images/variations",
    service: "images",
    description: "Image variations (removed upstream 2026-05-12 — replays the real 404)",
  },
  { method: "POST", path: SPEECH_PATH, service: "speech", description: "Text-to-speech" },
  {
    method: "POST",
    path: TRANSCRIPTIONS_PATH,
    service: "transcription",
    description: "Audio transcription (multipart)",
  },
  {
    method: "POST",
    path: TRANSLATIONS_PATH,
    service: "transcription",
    description: "Audio translation (multipart)",
  },
  // Video: Sora submit, Grok submit, shared status
  {
    method: "POST",
    path: VIDEOS_PATH,
    service: "video",
    description: "Video generation submit (Sora)",
  },
  {
    method: "POST",
    path: "/v1/videos/generations",
    service: "video",
    description: "Grok video generation submit",
  },
  {
    method: "GET",
    path: "/v1/videos/{id}",
    examplePath: "/v1/videos/test-id",
    service: "video",
    description: "Video job status (Sora/Grok)",
  },
  // Veo
  {
    method: "POST",
    path: "/v1beta/models/{model}:predictLongRunning",
    examplePath: "/v1beta/models/veo-3:predictLongRunning",
    service: "video",
    description: "Veo video submit",
  },
  {
    method: "GET",
    path: "/v1beta/operations/{name}",
    examplePath: "/v1beta/operations/test-op",
    service: "video",
    description: "Veo operation status",
  },
  // Gemini Imagen + interactions + embeddings + generate
  {
    method: "POST",
    path: "/v1beta/models/{model}:predict",
    examplePath: "/v1beta/models/imagen-3:predict",
    service: "gemini",
    description: "Gemini Imagen predict",
  },
  {
    method: "POST",
    path: GEMINI_INTERACTIONS_PATH,
    service: "gemini",
    description: "Gemini interactions",
  },
  {
    method: "POST",
    path: "/v1beta/models/{model}:embedContent",
    examplePath: "/v1beta/models/text-embedding-004:embedContent",
    service: "gemini",
    description: "Gemini embedContent",
  },
  {
    method: "POST",
    path: "/v1beta/models/{model}:generateContent",
    examplePath: "/v1beta/models/gemini-2.0-flash:generateContent",
    service: "gemini",
    description: "Gemini generateContent",
  },
  {
    method: "POST",
    path: "/v1beta/models/{model}:streamGenerateContent",
    examplePath: "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
    service: "gemini",
    description: "Gemini streaming",
  },
  // Vertex AI (same shapes, full resource path)
  {
    method: "POST",
    path: "/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent",
    examplePath:
      "/v1/projects/test-proj/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent",
    service: "vertex",
    description: "Vertex AI generateContent",
  },
  {
    method: "POST",
    path: "/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent",
    examplePath:
      "/v1/projects/test-proj/locations/us-central1/publishers/google/models/gemini-2.0-flash:streamGenerateContent",
    service: "vertex",
    description: "Vertex AI streaming",
  },
  // Bedrock
  {
    method: "POST",
    path: "/model/{modelId}/invoke",
    examplePath: "/model/anthropic.claude-3/invoke",
    service: "bedrock",
    description: "Bedrock invoke",
  },
  {
    method: "POST",
    path: "/model/{modelId}/invoke-with-response-stream",
    examplePath: "/model/anthropic.claude-3/invoke-with-response-stream",
    service: "bedrock",
    description: "Bedrock streaming invoke",
  },
  {
    method: "POST",
    path: "/model/{modelId}/converse",
    examplePath: "/model/anthropic.claude-3/converse",
    service: "bedrock",
    description: "Bedrock converse",
  },
  {
    method: "POST",
    path: "/model/{modelId}/converse-stream",
    examplePath: "/model/anthropic.claude-3/converse-stream",
    service: "bedrock",
    description: "Bedrock converse streaming",
  },
  // Search / rerank / moderation
  { method: "POST", path: SEARCH_PATH, service: "search", description: "Tavily search" },
  { method: "POST", path: RERANK_PATH, service: "rerank", description: "Cohere rerank" },
  { method: "POST", path: MODERATIONS_PATH, service: "moderation", description: "Moderation" },
  // ElevenLabs
  {
    method: "POST",
    path: ELEVENLABS_SOUND_GENERATION_PATH,
    service: "elevenlabs",
    description: "ElevenLabs sound generation",
  },
  {
    method: "POST",
    path: "/v1/text-to-voice/design",
    service: "elevenlabs",
    description: "ElevenLabs voice design preview",
  },
  {
    method: "POST",
    path: "/v1/text-to-voice",
    service: "elevenlabs",
    description: "ElevenLabs save designed voice",
  },
  {
    method: "GET",
    path: "/v1/voices/{voice_id}",
    examplePath: "/v1/voices/test-voice",
    service: "elevenlabs",
    description: "ElevenLabs voice slot get",
  },
  {
    method: "DELETE",
    path: "/v1/voices/{voice_id}",
    examplePath: "/v1/voices/test-voice",
    service: "elevenlabs",
    description: "ElevenLabs voice slot delete",
  },
  {
    method: "POST",
    path: "/v1/text-to-speech/{voice_id}",
    examplePath: "/v1/text-to-speech/test-voice",
    service: "elevenlabs",
    description: "ElevenLabs text-to-speech",
  },
  {
    method: "POST",
    path: "/v1/music",
    service: "elevenlabs",
    description: "ElevenLabs music",
  },
  {
    method: "POST",
    path: "/v1/music/{subtype}",
    examplePath: "/v1/music/generation",
    service: "elevenlabs",
    description: "ElevenLabs music sub-operation",
  },
  // fal.ai
  {
    method: "POST",
    path: "/fal/queue/submit/{model}",
    examplePath: "/fal/queue/submit/fal-ai-test",
    service: "fal",
    description: "fal.ai queue submit",
  },
  {
    method: "GET",
    path: "/fal/queue/requests/{requestId}",
    examplePath: "/fal/queue/requests/test-id",
    service: "fal",
    description: "fal.ai queue status/result",
  },
  {
    method: "POST",
    path: "/fal/queue/requests/{requestId}",
    examplePath: "/fal/queue/requests/test-id",
    service: "fal",
    description: "fal.ai queue status/result (POST)",
  },
  {
    method: "PUT",
    path: "/fal/queue/requests/{requestId}",
    examplePath: "/fal/queue/requests/test-id",
    service: "fal",
    description: "fal.ai queue status/result (PUT)",
  },
  {
    method: "POST",
    path: "/fal/run/{model}",
    examplePath: "/fal/run/fal-ai-test",
    service: "fal",
    description: "fal.ai synchronous run",
  },
  // OpenAI Batches API (cancel before id: the id RE would swallow /cancel)
  {
    method: "POST",
    path: "/v1/batches/{batch_id}/cancel",
    examplePath: "/v1/batches/batch-test123/cancel",
    service: "batches",
    description: "Batch cancel",
  },
  {
    method: "GET",
    path: "/v1/batches/{batch_id}",
    examplePath: "/v1/batches/batch-test123",
    service: "batches",
    description: "Batch retrieve",
  },
  { method: "GET", path: BATCHES_PATH, service: "batches", description: "Batch list" },
  {
    method: "POST",
    path: BATCHES_PATH,
    service: "batches",
    description: "Batch create",
  },
  // OpenAI Files API
  {
    method: "GET",
    path: "/v1/files/{file_id}/content",
    examplePath: "/v1/files/file-test123/content",
    service: "files",
    description: "File content download",
  },
  {
    method: "GET",
    path: "/v1/files/{file_id}",
    examplePath: "/v1/files/file-test123",
    service: "files",
    description: "File retrieve",
  },
  {
    method: "DELETE",
    path: "/v1/files/{file_id}",
    examplePath: "/v1/files/file-test123",
    service: "files",
    description: "File delete",
  },
  { method: "GET", path: "/v1/files", service: "files", description: "File list" },
  {
    method: "POST",
    path: "/v1/files",
    service: "files",
    description: "File upload (JSON or multipart)",
  },
  // OpenAI fine-tuning jobs
  {
    method: "POST",
    path: "/v1/fine_tuning/jobs/{job_id}/cancel",
    examplePath: "/v1/fine_tuning/jobs/ftjob-test123/cancel",
    service: "fine-tuning",
    description: "Fine-tuning job cancel",
  },
  {
    method: "GET",
    path: "/v1/fine_tuning/jobs/{job_id}/events",
    examplePath: "/v1/fine_tuning/jobs/ftjob-test123/events",
    service: "fine-tuning",
    description: "Fine-tuning job events",
  },
  {
    method: "GET",
    path: "/v1/fine_tuning/jobs/{job_id}",
    examplePath: "/v1/fine_tuning/jobs/ftjob-test123",
    service: "fine-tuning",
    description: "Fine-tuning job retrieve",
  },
  {
    method: "GET",
    path: "/v1/fine_tuning/jobs",
    service: "fine-tuning",
    description: "Fine-tuning job list",
  },
  {
    method: "POST",
    path: "/v1/fine_tuning/jobs",
    service: "fine-tuning",
    description: "Fine-tuning job create",
  },
  // Chat completions (terminal dispatcher branch)
  {
    method: "POST",
    path: COMPLETIONS_PATH,
    service: "openai",
    description: "OpenAI chat completions",
  },
  // Control API
  { method: "GET", path: "/__aimock/health", service: "control", description: "Control health" },
  { method: "GET", path: "/__aimock/journal", service: "control", description: "Request journal" },
  {
    method: "GET",
    path: "/__aimock/fixtures",
    service: "control",
    description: "Fixture count",
  },
  { method: "POST", path: "/__aimock/fixtures", service: "control", description: "Add fixtures" },
  {
    method: "DELETE",
    path: "/__aimock/fixtures",
    service: "control",
    description: "Clear fixtures",
  },
  { method: "GET", path: "/__aimock/chaos", service: "control", description: "Read chaos config" },
  { method: "POST", path: "/__aimock/chaos", service: "control", description: "Set chaos config" },
  {
    method: "DELETE",
    path: "/__aimock/chaos",
    service: "control",
    description: "Clear chaos override",
  },
  { method: "POST", path: "/__aimock/reset", service: "control", description: "Full reset" },
  {
    method: "POST",
    path: "/__aimock/reset/journal",
    service: "control",
    description: "Journal-only reset",
  },
  {
    method: "POST",
    path: "/__aimock/reset/fixtures",
    service: "control",
    description: "Full reset (deprecated alias)",
  },
  { method: "POST", path: "/__aimock/error", service: "control", description: "One-shot error" },
  {
    method: "GET",
    path: "/__aimock/openapi.json",
    service: "control",
    description: "OpenAPI catalog",
  },
  { method: "GET", path: "/__aimock/routes", service: "control", description: "Flat route list" },
];

/**
 * Compile an OpenAPI path template (`{param}` segments) to the equivalent
 * single-segment matcher. Every `{param}` becomes `[^/]+`; everything else
 * matches literally (including `:action` suffixes like `:predict`).
 *
 * This is intentionally the CANONICAL matcher, not a copy of each
 * dispatcher's regex: a couple of dispatch regexes are deliberately wider
 * (e.g. `VEO_OPERATION_RE` allows multi-segment operation names), so the
 * registry matcher may miss exotic paths the dispatcher serves — but it must
 * never CLAIM a path the dispatcher does not serve, which is the direction
 * the runtime drift guard relies on.
 */
export function templateToRegExp(template: string): RegExp {
  const pattern = template
    .split(/(\{[^}]+\})/g)
    .map((part) =>
      /^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}$`);
}

/**
 * Find the registry entry serving `METHOD pathname`, in dispatcher order
 * (first match wins — `ROUTE_DEFINITIONS` is kept in dispatch order for
 * exactly this reason). Returns `undefined` when no catalog entry covers the
 * request. Method comparison is case-insensitive, like the dispatcher.
 */
export function matchRouteDefinition(
  method: string,
  pathname: string,
): RouteDefinition | undefined {
  const want = method.toUpperCase();
  for (const def of ROUTE_DEFINITIONS) {
    if (def.method.toUpperCase() !== want) continue;
    if (def.path === pathname) return def;
    if (def.path.includes("{") && templateToRegExp(def.path).test(pathname)) return def;
  }
  return undefined;
}
