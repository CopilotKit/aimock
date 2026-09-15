/**
 * Machine-readable route catalog for aimock.
 *
 * `GET /__aimock/openapi.json` returns a minimal OpenAPI 3.1 document
 * enumerating every first-class HTTP surface aimock mocks, and
 * `GET /__aimock/routes` returns the same list as a flat JSON array for
 * shells that just need `method + path`. SDK codegen, docs checks, and
 * harness smoke tests can assert against this instead of hard-coding a
 * route list that drifts.
 *
 * The list is curated (not scraped from the dispatcher) so the catalog
 * itself is the contract: adding a surface means adding it here AND wiring
 * it, and the test below fails if the two disagree on the core set.
 */

export interface CatalogRoute {
  method: string;
  path: string;
  service: string;
  description: string;
}

export const CATALOG_ROUTES: CatalogRoute[] = [
  {
    method: "POST",
    path: "/v1/chat/completions",
    service: "openai",
    description: "OpenAI chat completions",
  },
  { method: "POST", path: "/v1/responses", service: "openai", description: "OpenAI Responses API" },
  { method: "POST", path: "/v1/messages", service: "anthropic", description: "Anthropic messages" },
  {
    method: "POST",
    path: "/v1beta/models/{model}:generateContent",
    service: "gemini",
    description: "Gemini generateContent",
  },
  {
    method: "POST",
    path: "/v1beta/models/{model}:streamGenerateContent",
    service: "gemini",
    description: "Gemini streaming",
  },
  { method: "POST", path: "/v1/embeddings", service: "openai", description: "OpenAI embeddings" },
  {
    method: "POST",
    path: "/v1/images/generations",
    service: "images",
    description: "Image generation",
  },
  {
    method: "POST",
    path: "/v1/images/edits",
    service: "images",
    description: "Image edits (multipart)",
  },
  {
    method: "POST",
    path: "/v1/images/variations",
    service: "images",
    description: "Image variations (multipart)",
  },
  { method: "POST", path: "/v1/audio/speech", service: "speech", description: "Text-to-speech" },
  {
    method: "POST",
    path: "/v1/audio/transcriptions",
    service: "transcription",
    description: "Audio transcription (multipart)",
  },
  {
    method: "POST",
    path: "/v1/audio/translations",
    service: "transcription",
    description: "Audio translation (multipart)",
  },
  { method: "POST", path: "/v1/videos", service: "video", description: "Video generation submit" },
  { method: "POST", path: "/v2/chat", service: "cohere", description: "Cohere chat" },
  { method: "POST", path: "/v2/embed", service: "cohere", description: "Cohere embed" },
  { method: "POST", path: "/v2/rerank", service: "rerank", description: "Cohere rerank" },
  { method: "POST", path: "/v1/moderations", service: "moderation", description: "Moderation" },
  { method: "POST", path: "/search", service: "search", description: "Tavily search" },
  { method: "GET", path: "/v1/models", service: "openai", description: "Models listing" },
  { method: "POST", path: "/api/chat", service: "ollama", description: "Ollama chat" },
  { method: "POST", path: "/api/generate", service: "ollama", description: "Ollama generate" },
  { method: "POST", path: "/api/embeddings", service: "ollama", description: "Ollama embeddings" },
  { method: "GET", path: "/api/tags", service: "ollama", description: "Ollama tags" },
  { method: "GET", path: "/health", service: "ops", description: "Health probe (public)" },
  { method: "GET", path: "/ready", service: "ops", description: "Readiness probe (public)" },
  { method: "GET", path: "/metrics", service: "ops", description: "Prometheus metrics (public)" },
  { method: "GET", path: "/__aimock/health", service: "control", description: "Control health" },
  { method: "GET", path: "/__aimock/journal", service: "control", description: "Request journal" },
  { method: "GET", path: "/__aimock/fixtures", service: "control", description: "Fixture count" },
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
  { method: "POST", path: "/__aimock/error", service: "control", description: "One-shot error" },
  {
    method: "GET",
    path: "/__aimock/openapi.json",
    service: "control",
    description: "OpenAPI catalog",
  },
  { method: "GET", path: "/__aimock/routes", service: "control", description: "Flat route list" },
];

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of CATALOG_ROUTES) {
    const item = (paths[r.path] ??= {});
    item[r.method.toLowerCase()] = {
      summary: r.description,
      tags: [r.service],
      responses: { "200": { description: "OK" } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "aimock", version: "1.0.0" },
    paths,
  };
}
