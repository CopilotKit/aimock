/**
 * Google Gemini embedContent API support.
 *
 * Handles POST /v1beta/models/{model}:embedContent requests. Translates
 * incoming Gemini embedding requests into the ChatCompletionRequest format
 * used by the fixture router (with _endpointType: "embedding"), and converts
 * fixture responses back into the Gemini embedContent response format.
 *
 * Falls back to generating a deterministic embedding from the input text hash
 * when no fixture matches — same strategy as the OpenAI embeddings handler.
 */

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  Fixture,
  HandlerDefaults,
  RecordProviderKey,
} from "./types.js";
import {
  isEmbeddingResponse,
  isErrorResponse,
  generateDeterministicEmbedding,
  flattenHeaders,
  getTestId,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Gemini embedContent request types ────────────────────────────────────

interface GeminiEmbedContentPart {
  text?: string;
}

interface GeminiEmbedContentRequest {
  content?: { parts?: GeminiEmbedContentPart[] };
  model?: string;
  taskType?: string;
  title?: string;
  outputDimensionality?: number;
  [key: string]: unknown;
}

// ─── Gemini embedContent response type ────────────────────────────────────

interface GeminiEmbedContentResponse {
  embedding: {
    values: number[];
  };
}

// ─── Default embedding dimensions for Gemini ──────────────────────────────

const DEFAULT_GEMINI_EMBEDDING_DIMENSIONS = 768;

// ─── Request handler ───────────────────────────────────────────────────────

export async function handleGeminiEmbedContent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  model: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  providerKey: RecordProviderKey = "gemini",
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  let embedReq: GeminiEmbedContentRequest;
  try {
    embedReq = JSON.parse(raw) as GeminiEmbedContentRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? `/v1beta/models/${model}:embedContent`,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: `Malformed JSON body: ${detail}`,
          code: 400,
          status: "INVALID_ARGUMENT",
        },
      }),
    );
    return;
  }

  // Extract text from content.parts
  const parts = embedReq.content?.parts ?? [];
  const inputText = parts
    .filter((p) => p.text !== undefined)
    .map((p) => p.text!)
    .join(" ");

  // Build a synthetic ChatCompletionRequest for the fixture router.
  // Uses _endpointType: "embedding" and embeddingInput to share fixtures
  // with OpenAI embeddings.
  const syntheticReq: ChatCompletionRequest = {
    model: embedReq.model ?? model,
    messages: [],
    embeddingInput: inputText,
    _endpointType: "embedding",
  };

  const testId = getTestId(req);
  const fixture = matchFixture(
    fixtures,
    syntheticReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );
  const path = req.url ?? `/v1beta/models/${model}:embedContent`;

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
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
        path,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
      },
      fixture ? "fixture" : "proxy",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (fixture) {
    const response = await resolveResponse(fixture, syntheticReq);

    // Error response
    if (isErrorResponse(response)) {
      const status = response.status ?? 500;
      journal.add({
        method: req.method ?? "POST",
        path,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status, fixture },
      });
      const geminiError = {
        error: {
          code: status,
          message: response.error.message,
          status: response.error.type ?? "ERROR",
        },
      };
      writeErrorResponse(res, status, JSON.stringify(geminiError), {
        retryAfter: response.retryAfter,
      });
      return;
    }

    // Embedding response — use the fixture's embedding values
    if (isEmbeddingResponse(response)) {
      journal.add({
        method: req.method ?? "POST",
        path,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: 200, fixture },
      });
      const body: GeminiEmbedContentResponse = {
        embedding: {
          values: [...response.embedding],
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Fixture matched but response type is not compatible with embeddings
    journal.add({
      method: req.method ?? "POST",
      path,
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
          code: 500,
          status: "INTERNAL",
        },
      }),
    );
    return;
  }

  // No fixture match — check strict mode first, then try proxy
  const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
  if (effectiveStrict) {
    logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${path}`);
    journal.add({
      method: req.method ?? "POST",
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: 503,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      503,
      JSON.stringify({
        error: {
          message: "Strict mode: no fixture matched",
          code: 503,
          status: "UNAVAILABLE",
        },
      }),
    );
    return;
  }

  if (defaults.record) {
    const outcome = await proxyAndRecord(
      req,
      res,
      syntheticReq,
      providerKey,
      path,
      fixtures,
      defaults,
      raw,
    );
    if (outcome === "handled_by_hook") return;
    if (outcome !== "not_configured") {
      journal.add({
        method: req.method ?? "POST",
        path,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
      });
      return;
    }
  }

  // No fixture match — generate deterministic embedding from input text
  const dimensions = embedReq.outputDimensionality ?? DEFAULT_GEMINI_EMBEDDING_DIMENSIONS;
  const embedding = generateDeterministicEmbedding(inputText, dimensions);

  logger.warn(
    `No embedding fixture matched for "${inputText.slice(0, 80)}" — returning deterministic fallback`,
  );

  journal.add({
    method: req.method ?? "POST",
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture: null },
  });

  const body: GeminiEmbedContentResponse = {
    embedding: {
      values: embedding,
    },
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
