/**
 * Reranking API support for LLMock.
 *
 * Handles POST /v2/rerank requests (Cohere rerank-compatible). Matches
 * fixtures by comparing the request `query` field against registered
 * patterns. First match wins; no match returns empty results.
 */

import type * as http from "node:http";
import { flattenHeaders, generateId, matchesPattern } from "./helpers.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";

// ─── Rerank types ─────────────────────────────────────────────────────────

export interface RerankResult {
  index: number;
  relevance_score: number;
}

export interface RerankFixture {
  match: string | RegExp;
  results: RerankResult[];
}

// ─── Request handler ──────────────────────────────────────────────────────

export async function handleRerank(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: RerankFixture[],
  journal: Journal,
  defaults: { logger: Logger },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  let body: { query?: string; documents?: unknown[]; model?: string };
  try {
    body = JSON.parse(raw) as { query?: string; documents?: unknown[]; model?: string };
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v2/rerank",
      headers: flattenHeaders(req.headers),
      body: null,
      service: "rerank",
      response: { status: 400, fixture: null },
    });
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
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

  const query = body.query ?? "";
  const documents = body.documents ?? [];

  // Find first matching fixture
  let matchedResults: RerankResult[] = [];
  let matchedFixture: RerankFixture | null = null;

  for (const fixture of fixtures) {
    if (matchesPattern(query, fixture.match)) {
      matchedFixture = fixture;
      matchedResults = fixture.results;
      break;
    }
  }

  if (matchedFixture) {
    logger.debug(`Rerank fixture matched for query "${query.slice(0, 80)}"`);
  } else {
    logger.debug(`No rerank fixture matched for query "${query.slice(0, 80)}" — returning empty`);
  }

  // Build response with document text included (Cohere rerank v2 format)
  const results = matchedResults.map((r) => {
    const doc = documents[r.index];
    const text =
      typeof doc === "string"
        ? doc
        : typeof doc === "object" && doc !== null && "text" in doc
          ? (doc as { text: string }).text
          : "";
    return {
      index: r.index,
      relevance_score: r.relevance_score,
      document: { text },
    };
  });

  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/v2/rerank",
    headers: flattenHeaders(req.headers),
    body: null,
    service: "rerank",
    response: { status: 200, fixture: null },
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: generateId("rerank"),
      results,
      meta: {
        billed_units: { search_units: 0 },
      },
    }),
  );
}
