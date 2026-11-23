/**
 * Web Search API support for LLMock.
 *
 * Handles POST /search requests (Tavily-compatible). Matches fixtures by
 * comparing the request `query` field against registered patterns. First
 * match wins; no match returns empty results.
 */

import type * as http from "node:http";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import { renderError } from "./response/errors.js";
import {
  flattenHeaders,
  isJsonObject,
  matchesPattern,
  normalizeTextInput,
  strictNoMatchLogLine,
  strictNoMatchMessage,
} from "./helpers.js";
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
  defaults: { logger: Logger; strict?: boolean },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  let body: { query?: unknown; max_results?: number };
  try {
    body = JSON.parse(raw) as { query?: unknown; max_results?: number };
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
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
      renderError("openai", "validation", {
        message: `Malformed JSON: ${detail}`,
        type: "invalid_request_error",
        code: "invalid_json",
      }).body,
    );
    return;
  }

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `body.query` throws a TypeError that surfaces
  // as a 500 instead of a 400.
  if (!isJsonObject(body)) {
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
      renderError("openai", "validation", {
        message: "Request body must be a JSON object",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  const rawQuery: unknown = body.query ?? "";
  const normalizedQuery = normalizeTextInput(rawQuery);
  if (normalizedQuery === null) {
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
      renderError("openai", "validation", {
        message: "Invalid parameter: 'query' must be a string or an array of strings",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }
  // `query` is the normalized string used for matching; the response echoes
  // `rawQuery` so an array payload round-trips exactly as it did before.
  const query = normalizedQuery;
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

  // Strict mode turns the lenient default (empty results) into a no-match
  // error, like every other fixture-matching handler. These fixtures carry no
  // sequence/turn state, so the skipped count is always 0.
  if (!matchedFixture && resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss) {
    const strictMessage = strictNoMatchMessage(0);
    logger.error(strictNoMatchLogLine(req.method ?? "POST", req.url ?? "/search", 0));
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/search",
      headers: flattenHeaders(req.headers),
      body: null,
      service: "search",
      response: {
        status: 503,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      renderError("openai", "strict-miss", {
        message: strictMessage,
        type: "invalid_request_error",
        code: "no_fixture_match",
      }).body,
    );
    return;
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
    response: {
      status: 200,
      fixture: null,
      ...strictOverrideField(defaults.strict, req.headers),
    },
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      query: rawQuery,
      results: matchedResults,
      images: [],
      response_time: 0,
      answer: null,
    }),
  );
}
