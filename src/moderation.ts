/**
 * Moderation API support for LLMock.
 *
 * Handles POST /v1/moderations requests (OpenAI-compatible). Matches
 * fixtures by comparing the request `input` field against registered
 * patterns. First match wins; no match returns a default unflagged result.
 */

import type * as http from "node:http";
import { flattenHeaders, generateId, matchesPattern } from "./helpers.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";

// ─── Moderation types ─────────────────────────────────────────────────────

export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  category_scores?: Record<string, number>;
}

export interface ModerationFixture {
  match: string | RegExp;
  result: ModerationResult;
}

// ─── Default unflagged result ─────────────────────────────────────────────

const DEFAULT_RESULT: ModerationResult = {
  flagged: false,
  categories: {
    sexual: false,
    hate: false,
    harassment: false,
    "self-harm": false,
    "sexual/minors": false,
    "hate/threatening": false,
    "violence/graphic": false,
    "self-harm/intent": false,
    "self-harm/instructions": false,
    "harassment/threatening": false,
    violence: false,
  },
  category_scores: {
    sexual: 0,
    hate: 0,
    harassment: 0,
    "self-harm": 0,
    "sexual/minors": 0,
    "hate/threatening": 0,
    "violence/graphic": 0,
    "self-harm/intent": 0,
    "self-harm/instructions": 0,
    "harassment/threatening": 0,
    violence: 0,
  },
};

// ─── Request handler ──────────────────────────────────────────────────────

export async function handleModeration(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: ModerationFixture[],
  journal: Journal,
  defaults: { logger: Logger },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  let body: { input?: string | string[] };
  try {
    body = JSON.parse(raw) as { input?: string | string[] };
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/moderations",
      headers: flattenHeaders(req.headers),
      body: null,
      service: "moderation",
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

  // Normalize input to a single string for matching
  const rawInput = body.input ?? "";
  const inputText = Array.isArray(rawInput) ? rawInput.join(" ") : rawInput;

  // Find first matching fixture
  let matchedResult: ModerationResult = DEFAULT_RESULT;
  let matchedFixture: ModerationFixture | null = null;

  for (const fixture of fixtures) {
    if (matchesPattern(inputText, fixture.match)) {
      matchedFixture = fixture;
      matchedResult = fixture.result;
      break;
    }
  }

  if (matchedFixture) {
    logger.debug(`Moderation fixture matched for input "${inputText.slice(0, 80)}"`);
  } else {
    logger.debug(
      `No moderation fixture matched for input "${inputText.slice(0, 80)}" — returning unflagged`,
    );
  }

  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/v1/moderations",
    headers: flattenHeaders(req.headers),
    body: null,
    service: "moderation",
    response: { status: 200, fixture: null },
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: generateId("modr"),
      model: "text-moderation-latest",
      results: [matchedResult],
    }),
  );
}
