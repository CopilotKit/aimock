import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { CATALOG_ROUTES, buildOpenApiDocument } from "../openapi.js";
import { ROUTE_DEFINITIONS } from "../route-registry.js";

describe("OpenAPI route catalog", () => {
  let mock: LLMock;
  beforeEach(async () => {
    // metrics:true so GET /metrics is served (otherwise it 404s by design).
    mock = new LLMock({ port: 0, metrics: true });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
  });

  it("derives the catalog from the router registry (no hand-maintained copy)", () => {
    expect(CATALOG_ROUTES.length).toBe(ROUTE_DEFINITIONS.length);
    const registryKeys = new Set(ROUTE_DEFINITIONS.map((r) => `${r.method} ${r.path}`));
    for (const r of CATALOG_ROUTES) {
      expect(registryKeys.has(`${r.method} ${r.path}`)).toBe(true);
    }
  });

  it("covers the previously-missing surfaces", () => {
    const paths = new Set(CATALOG_ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const required of [
      // Core OpenAI-shaped routes carry real schemas (asserted below).
      "POST /v1/chat/completions",
      "POST /v1/responses",
      "POST /v1/messages",
      "POST /v1/embeddings",
      "GET /v1/models",
      // Previously missing (review): ollama current path, legacy journal,
      // azure, gemini predict/embed/interactions, vertex, bedrock x4,
      // grok/veo/openrouter/byteplus video, openrouter discovery, elevenlabs,
      // fal families, control reset aliases.
      "POST /api/embed",
      "GET /v1/_requests",
      "DELETE /v1/_requests",
      "POST /openai/deployments/{deploymentId}/chat/completions",
      "POST /openai/deployments/{deploymentId}/embeddings",
      "POST /v1beta/models/{model}:predict",
      "POST /v1beta/models/{model}:embedContent",
      "POST /v1beta/interactions",
      "POST /v1beta/models/{model}:predictLongRunning",
      "GET /v1beta/operations/{name}",
      "POST /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent",
      "POST /model/{modelId}/invoke",
      "POST /model/{modelId}/invoke-with-response-stream",
      "POST /model/{modelId}/converse",
      "POST /model/{modelId}/converse-stream",
      "POST /v1/videos/generations",
      "GET /v1/videos/{id}",
      "POST /api/v1/videos",
      "GET /api/v1/videos/models",
      "GET /api/v1/videos/{jobId}",
      "GET /api/v1/videos/{jobId}/content",
      "GET /api/v1/models",
      "GET /api/v1/key",
      "GET /api/v1/credits",
      "POST /v1/sound-generation",
      "POST /v1/text-to-speech/{voice_id}",
      "POST /fal/queue/submit/{model}",
      "GET /fal/queue/requests/{requestId}",
      "POST /fal/run/{model}",
      // New on main after the PR opened: Files API, fine-tuning jobs,
      // ElevenLabs Voice Design slots.
      "GET /v1/files",
      "POST /v1/files",
      "GET /v1/files/{file_id}",
      "DELETE /v1/files/{file_id}",
      "GET /v1/files/{file_id}/content",
      "POST /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs/{job_id}",
      "POST /v1/fine_tuning/jobs/{job_id}/cancel",
      "GET /v1/fine_tuning/jobs/{job_id}/events",
      "POST /v1/text-to-voice/design",
      "POST /v1/text-to-voice",
      "GET /v1/voices/{voice_id}",
      "DELETE /v1/voices/{voice_id}",
      "POST /__aimock/reset/journal",
      "GET /__aimock/journal",
      "GET /__aimock/openapi.json",
      "GET /__aimock/routes",
    ]) {
      expect(paths.has(required)).toBe(true);
    }
    const doc = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
  });

  it("emits real request/response schemas for OpenAI-shaped routes", async () => {
    const res = await fetch(`${mock.url}/__aimock/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    const chat = doc.paths["/v1/chat/completions"]?.post as Record<string, unknown>;
    expect(chat).toBeDefined();
    const requestBody = chat.requestBody as {
      content: { "application/json": { schema: { $ref: string } } };
    };
    expect(requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/ChatCompletionRequest",
    );
    const ok = (chat.responses as Record<string, { content?: Record<string, unknown> }>)["200"];
    expect(ok.content?.["application/json"]).toBeDefined();
    expect(doc.components.schemas.ChatCompletionRequest).toBeDefined();
    expect(doc.components.schemas.ChatCompletionResponse).toBeDefined();
    expect(doc.components.schemas.EmbeddingRequest).toBeDefined();
  });

  it("serves /__aimock/openapi.json and /__aimock/routes consistently", async () => {
    const openapi = await fetch(`${mock.url}/__aimock/openapi.json`);
    expect(openapi.status).toBe(200);
    const doc = (await openapi.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/chat/completions"]).toBeDefined();
    expect(doc.paths["/__aimock/journal"]).toBeDefined();

    const routes = await fetch(`${mock.url}/__aimock/routes`);
    expect(routes.status).toBe(200);
    const body = (await routes.json()) as {
      count: number;
      routes: { method: string; path: string }[];
    };
    // Served catalog matches the derived registry (not a second copy).
    expect(body.count).toBe(ROUTE_DEFINITIONS.length);
    expect(body.routes.length).toBe(ROUTE_DEFINITIONS.length);
    const servedKeys = new Set(body.routes.map((r) => `${r.method} ${r.path}`));
    for (const r of ROUTE_DEFINITIONS) {
      expect(servedKeys.has(`${r.method} ${r.path}`)).toBe(true);
    }
    // Every openapi path is backed by a routes entry.
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        expect(servedKeys.has(`${method.toUpperCase()} ${path}`)).toBe(true);
      }
    }
  });

  it("every catalog entry is mounted on the live router (no drift)", async () => {
    for (const r of ROUTE_DEFINITIONS) {
      const probePath = r.examplePath ?? r.path;
      const url = `${mock.url}${probePath}`;
      const res =
        r.method === "GET" || r.method === "DELETE"
          ? await fetch(url, { method: r.method })
          : await fetch(url, {
              method: r.method,
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
      // Drain the body so the socket can be reused.
      const text = await res.text();
      // POST /v1/images/variations was removed upstream (dall-e-2,
      // 2026-05-12) and aimock replays the removal: a 404 with a zero-byte
      // body and no JSON envelope (see images.ts + the deprecation policy).
      // The route is still registered and journaled — assert the replay
      // itself instead of the generic routed check below.
      if (r.method === "POST" && r.path === "/v1/images/variations") {
        expect(res.status).toBe(404);
        expect(text).toBe("");
        continue;
      }
      // A routed-but-empty result (e.g. unknown video job id) still proves the
      // route is mounted; only the dispatcher's generic miss means drift.
      let message: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof parsed?.error?.message === "string") message = parsed.error.message;
      } catch {
        // Non-JSON (204/200-text) is always a routed response.
      }
      const genericMiss =
        res.status === 404 &&
        (message === "Not found" ||
          (typeof message === "string" && message.startsWith("Unknown control endpoint")));
      expect(
        genericMiss,
        `${r.method} ${probePath} hit the generic 404 — catalog drifted from router`,
      ).toBe(false);
    }
  }, 60000);
});
