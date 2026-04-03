/**
 * Web Search API support for LLMock.
 *
 * Handles POST /search requests (Tavily-compatible). Matches fixtures by
 * comparing the request `query` field against registered patterns. First
 * match wins; no match returns empty results.
 */

import type * as http from "node:http";
import { flattenHeaders, matchesPattern } from "./helpers.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";

// ─── Search types ─────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface SearchFixture {
  match: string | RegExp;
  results: SearchResult[];
}

// ─── Request handler ──────────────────────────────────────────────────────

export async function handleSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: SearchFixture[],
  journal: Journal,
  defaults: { logger: Logger },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  let body: { query?: string; max_results?: number };
  try {
    body = JSON.parse(raw) as { query?: string; max_results?: number };
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/search",
      headers: flattenHeaders(req.headers),
      body: null,
      service: "search",
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
  const maxResults = body.max_results;

  // Find first matching fixture
  let matchedResults: SearchResult[] = [];
  let matchedFixture: SearchFixture | null = null;

  for (const fixture of fixtures) {
    if (matchesPattern(query, fixture.match)) {
      matchedFixture = fixture;
      matchedResults = fixture.results;
      break;
    }
  }

  if (matchedFixture) {
    logger.debug(`Search fixture matched for query "${query.slice(0, 80)}"`);
  } else {
    logger.debug(`No search fixture matched for query "${query.slice(0, 80)}" — returning empty`);
  }

  // Apply max_results limit
  if (maxResults !== undefined && maxResults > 0) {
    matchedResults = matchedResults.slice(0, maxResults);
  }

  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/search",
    headers: flattenHeaders(req.headers),
    body: null,
    service: "search",
    response: { status: 200, fixture: null },
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ results: matchedResults }));
}
