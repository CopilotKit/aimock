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
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import { renderError } from "./response/errors.js";
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
  MAX_EMBEDDING_DIMENSIONS,
  flattenHeaders,
  isJsonObject,
  getTestId,
  resolveResponse,
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";
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
      renderError("gemini", "validation", {
        message: `Malformed JSON body: ${detail}`,
        bodyCode: 400,
        status: "INVALID_ARGUMENT",
      }).body,
    );
    return;
  }

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `embedReq.content` throws a TypeError that
  // surfaces as a 500 instead of a 400.
  if (!isJsonObject(embedReq)) {
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
      renderError("gemini", "validation", {
        message: "Request body must be a JSON object",
        bodyCode: 400,
        status: "INVALID_ARGUMENT",
      }).body,
    );
    return;
  }

  // Extract text from content.parts
  const parts = embedReq.content?.parts ?? [];
  // Preserve nullish defaults and ignored non-null entries; guard only the
  // shapes that cannot be consumed by the text extraction below.
  const partsError = !Array.isArray(parts)
    ? "content.parts must be an array"
    : parts.some((part) => part === null)
      ? "content.parts must not contain null entries"
      : undefined;
  if (partsError) {
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
      renderError("gemini", "validation", {
        message: partsError,
        bodyCode: 400,
        status: "INVALID_ARGUMENT",
      }).body,
    );
    return;
  }
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
    _context: getContext(req),
  };

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
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
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
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
      const geminiError = renderError("gemini", "fixture", {
        bodyCode: status,
        message: response.error.message,
        status: response.error.type ?? "ERROR",
      }).body;
      writeErrorResponse(res, status, geminiError, {
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
      renderError("gemini", "unknown-response", {
        message:
          "Fixture response did not match any known embedding type (must have embedding or error)",
        bodyCode: 500,
        status: "INTERNAL",
      }).body,
    );
    return;
  }

  // No fixture match — check strict mode first, then try proxy
  const effectiveStrict = resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss;
  if (effectiveStrict) {
    const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
    logger.error(strictNoMatchLogLine(req.method ?? "POST", path, skippedBySequenceOrTurn));
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
      renderError("gemini", "strict-miss", {
        message: strictMessage,
        bodyCode: 503,
        status: "UNAVAILABLE",
      }).body,
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
  // Match the embedding loop's numeric coercion, including array dimensions.
  // Preserve supported coercion and zero within the local serialization budget.
  // Guard only the fallback allocation, not unused dimensions on earlier branches.
  // Replay, strict, chaos, and proxy paths above do not consume this field.
  const exceedsFallbackBudget = dimensions > MAX_EMBEDDING_DIMENSIONS;
  if (
    exceedsFallbackBudget ||
    (typeof dimensions === "number" && (!Number.isInteger(dimensions) || dimensions < 0)) ||
    (typeof dimensions === "string" && Number.isNaN(Number(dimensions)))
  ) {
    journal.add({
      method: req.method ?? "POST",
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError("gemini", "validation", {
        message: exceedsFallbackBudget
          ? `outputDimensionality exceeds the fallback serialization budget of ${MAX_EMBEDDING_DIMENSIONS}`
          : "outputDimensionality cannot produce a numeric embedding",
        bodyCode: 400,
        status: "INVALID_ARGUMENT",
      }).body,
    );
    return;
  }
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
