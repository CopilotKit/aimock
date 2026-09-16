/**
 * Machine-readable route catalog for aimock.
 *
 * `GET /__aimock/openapi.json` returns an OpenAPI 3.1 document and
 * `GET /__aimock/routes` returns the same list as a flat JSON array for
 * shells that just need `method + path`. SDK codegen, docs checks, and
 * harness smoke tests can assert against this instead of hard-coding a
 * route list that drifts.
 *
 * The catalog is DERIVED from the router's single source of truth
 * (`route-registry.ts`, which `server.ts` also imports for dispatch), so it
 * cannot drift from the mounted routes. OpenAI-shaped operations additionally
 * carry real `requestBody` / `responses` schemas; every other operation
 * carries a summary, tags, and path parameters.
 */

import { ROUTE_DEFINITIONS } from "./route-registry.js";

export interface CatalogRoute {
  method: string;
  path: string;
  service: string;
  description: string;
}

/** Flat `method + path` list, derived from the router registry. */
export const CATALOG_ROUTES: CatalogRoute[] = ROUTE_DEFINITIONS.map((r) => ({
  method: r.method,
  path: r.path,
  service: r.service,
  description: r.description,
}));

function pathParams(openApiPath: string): Record<string, unknown>[] {
  const params: Record<string, unknown>[] = [];
  for (const match of openApiPath.matchAll(/\{([^}]+)\}/g)) {
    params.push({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}

const COMPONENTS: Record<string, unknown> = {
  ChatCompletionRequest: {
    type: "object",
    required: ["model", "messages"],
    properties: {
      model: { type: "string", description: "Model ID" },
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
            content: {},
            name: { type: "string" },
            tool_calls: { type: "array", items: {} },
            tool_call_id: { type: "string" },
          },
        },
      },
      stream: { type: "boolean" },
      temperature: { type: "number" },
      max_tokens: { type: "integer" },
      tools: { type: "array", items: {} },
      tool_choice: {},
      response_format: { type: "object" },
    },
  },
  ChatCompletionResponse: {
    type: "object",
    required: ["id", "object", "created", "model", "choices"],
    properties: {
      id: { type: "string" },
      object: { type: "string" },
      created: { type: "integer" },
      model: { type: "string" },
      choices: { type: "array", items: {} },
      usage: { type: "object" },
    },
  },
  ResponsesRequest: {
    type: "object",
    required: ["model", "input"],
    properties: {
      model: { type: "string" },
      input: {},
      stream: { type: "boolean" },
      instructions: { type: "string" },
      tools: { type: "array", items: {} },
    },
  },
  ResponsesResponse: {
    type: "object",
    properties: {
      id: { type: "string" },
      object: { type: "string" },
      model: { type: "string" },
      output: { type: "array", items: {} },
      usage: { type: "object" },
    },
  },
  EmbeddingRequest: {
    type: "object",
    required: ["model", "input"],
    properties: {
      model: { type: "string" },
      input: {},
    },
  },
  EmbeddingResponse: {
    type: "object",
    properties: {
      object: { type: "string" },
      data: { type: "array", items: {} },
      model: { type: "string" },
      usage: { type: "object" },
    },
  },
  ImageGenerationRequest: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      model: { type: "string" },
      size: { type: "string" },
      n: { type: "integer" },
      response_format: { type: "string" },
    },
  },
  ImageResponse: {
    type: "object",
    properties: {
      created: { type: "integer" },
      data: { type: "array", items: {} },
    },
  },
  SpeechRequest: {
    type: "object",
    required: ["model", "input"],
    properties: {
      model: { type: "string" },
      input: { type: "string" },
      voice: { type: "string" },
      response_format: { type: "string" },
    },
  },
  ModerationRequest: {
    type: "object",
    required: ["input"],
    properties: {
      input: {},
      model: { type: "string" },
    },
  },
  ModerationResponse: {
    type: "object",
    properties: {
      id: { type: "string" },
      model: { type: "string" },
      results: { type: "array", items: {} },
    },
  },
  ModelsListResponse: {
    type: "object",
    properties: {
      object: { type: "string" },
      data: { type: "array", items: {} },
    },
  },
  ErrorResponse: {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          message: { type: "string" },
          type: { type: "string" },
          code: {},
        },
      },
    },
  },
};

/** `METHOD path` → `{ request, response }` schema refs for OpenAI-shaped routes. */
const SCHEMA_REFS: Record<string, { request?: string; response?: string }> = {
  "POST /v1/chat/completions": {
    request: "ChatCompletionRequest",
    response: "ChatCompletionResponse",
  },
  "POST /v1/responses": { request: "ResponsesRequest", response: "ResponsesResponse" },
  "POST /v1/embeddings": { request: "EmbeddingRequest", response: "EmbeddingResponse" },
  "POST /v1/images/generations": {
    request: "ImageGenerationRequest",
    response: "ImageResponse",
  },
  "POST /v1/audio/speech": { request: "SpeechRequest" },
  "POST /v1/moderations": { request: "ModerationRequest", response: "ModerationResponse" },
  "GET /v1/models": { response: "ModelsListResponse" },
  "POST /openai/deployments/{deploymentId}/chat/completions": {
    request: "ChatCompletionRequest",
    response: "ChatCompletionResponse",
  },
  "POST /openai/deployments/{deploymentId}/embeddings": {
    request: "EmbeddingRequest",
    response: "EmbeddingResponse",
  },
};

function operationFor(
  method: string,
  path: string,
  service: string,
  description: string,
): Record<string, unknown> {
  const params = pathParams(path);
  const refs = SCHEMA_REFS[`${method} ${path}`];
  const operation: Record<string, unknown> = {
    summary: description,
    tags: [service],
  };
  if (params.length > 0) operation.parameters = params;
  if (refs?.request) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${refs.request}` },
        },
      },
    };
  }
  const successSchema = refs?.response
    ? { $ref: `#/components/schemas/${refs.response}` }
    : undefined;
  operation.responses = {
    "200": {
      description: "OK",
      ...(successSchema
        ? { content: { "application/json": { schema: successSchema } } }
        : undefined),
    },
    "400": {
      description: "Invalid request",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
      },
    },
    "404": {
      description: "No fixture match",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
      },
    },
  };
  return operation;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTE_DEFINITIONS) {
    const item = (paths[r.path] ??= {});
    item[r.method.toLowerCase()] = operationFor(r.method, r.path, r.service, r.description);
  }
  return {
    openapi: "3.1.0",
    info: { title: "aimock", version: "1.0.0" },
    paths,
    components: { schemas: COMPONENTS },
  };
}
