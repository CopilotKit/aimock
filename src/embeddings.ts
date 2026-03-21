/**
 * OpenAI Embeddings API support for LLMock.
 *
 * Handles POST /v1/embeddings requests. Matches fixtures using the `inputText`
 * field, and falls back to generating a deterministic embedding from the input
 * text hash when no fixture matches.
 */

import type * as http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import {
  isEmbeddingResponse,
  isErrorResponse,
  generateDeterministicEmbedding,
  buildEmbeddingResponse,
  flattenHeaders,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Embeddings API request types ──────────────────────────────────────────

interface EmbeddingRequest {
  input: string | string[];
  model: string;
  encoding_format?: "float" | "base64";
  dimensions?: number;
  [key: string]: unknown;
}

// ─── Request handler ───────────────────────────────────────────────────────

export async function handleEmbeddings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  let embeddingReq: EmbeddingRequest;
  try {
    embeddingReq = JSON.parse(raw) as EmbeddingRequest;
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/embeddings",
      headers: flattenHeaders(req.headers),
      body: {} as ChatCompletionRequest,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
          code: "invalid_json",
        },
      }),
    );
    return;
  }

  // Normalize input to array of strings
  const inputs: string[] = Array.isArray(embeddingReq.input)
    ? embeddingReq.input
    : [embeddingReq.input];

  // Concatenate all inputs for matching purposes
  const combinedInput = inputs.join(" ");

  // Build a synthetic ChatCompletionRequest for the fixture router.
  // We attach `embeddingInput` so the router's inputText matching can use it.
  const syntheticReq: ChatCompletionRequest = {
    model: embeddingReq.model,
    messages: [],
    embeddingInput: combinedInput,
  };

  const fixture = matchFixture(fixtures, syntheticReq, journal.fixtureMatchCounts);

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      {
        method: req.method ?? "POST",
        path: req.url ?? "/v1/embeddings",
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
      },
      defaults.registry,
    )
  )
    return;

  if (fixture) {
    const response = fixture.response;

    // Error response
    if (isErrorResponse(response)) {
      const status = response.status ?? 500;
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/v1/embeddings",
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status, fixture },
      });
      writeErrorResponse(res, status, JSON.stringify(response));
      return;
    }

    // Embedding response — use the fixture's embedding for each input
    if (isEmbeddingResponse(response)) {
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/v1/embeddings",
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: 200, fixture },
      });
      const embeddings = inputs.map(() => [...response.embedding]);
      const body = buildEmbeddingResponse(embeddings, embeddingReq.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Fixture matched but response type is not compatible with embeddings
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/embeddings",
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    writeErrorResponse(
      res,
      500,
      JSON.stringify({
        error: {
          message:
            "Fixture response did not match any known embedding type (must have embedding or error)",
          type: "server_error",
        },
      }),
    );
    return;
  }

  // No fixture match — try record-and-replay proxy if configured
  if (defaults.record) {
    const proxied = await proxyAndRecord(
      req,
      res,
      syntheticReq,
      "openai",
      req.url ?? "/v1/embeddings",
      fixtures,
      defaults,
      raw,
    );
    if (proxied) {
      journal.add({
        method: req.method ?? "POST",
        path: req.url ?? "/v1/embeddings",
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: res.statusCode ?? 200, fixture: null },
      });
      return;
    }
  }

  if (defaults.strict) {
    logger.error(
      `STRICT: No fixture matched for ${req.method ?? "POST"} ${req.url ?? "/v1/embeddings"}`,
    );
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/embeddings",
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 503, fixture: null },
    });
    writeErrorResponse(
      res,
      503,
      JSON.stringify({
        error: {
          message: "Strict mode: no fixture matched",
          type: "invalid_request_error",
          code: "no_fixture_match",
        },
      }),
    );
    return;
  }

  // No fixture match — generate deterministic embeddings from input text
  logger.warn(
    `No embedding fixture matched for "${combinedInput.slice(0, 80)}" — returning deterministic fallback`,
  );
  const dimensions = embeddingReq.dimensions ?? 1536;
  const embeddings = inputs.map((input) => generateDeterministicEmbedding(input, dimensions));

  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/v1/embeddings",
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture: null },
  });

  const body = buildEmbeddingResponse(embeddings, embeddingReq.model);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
