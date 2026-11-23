/**
 * Moderation API support for LLMock.
 *
 * Handles POST /v1/moderations requests (OpenAI-compatible). Matches
 * fixtures by comparing the request `input` field against registered
 * patterns. First match wins; no match returns a default unflagged result.
 */

import type * as http from "node:http";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import { renderError } from "./response/errors.js";
import {
  flattenHeaders,
  generateId,
  isJsonObject,
  matchesPattern,
  normalizeTextInput,
  strictNoMatchLogLine,
  strictNoMatchMessage,
} from "./helpers.js";
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

/**
 * Model echoed when the caller sends no `model`.
 *
 * The real API echoes back the model the request asked for. `text-moderation-*`
 * was removed from the OpenAI API on 2025-10-27; `omni-moderation-latest` is
 * the current moderation model, so it stands in when the caller omits one.
 */
const DEFAULT_MODERATION_MODEL = "omni-moderation-latest";

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
    illicit: false,
    "illicit/violent": false,
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
    illicit: 0,
    "illicit/violent": 0,
  },
};

// ─── Request handler ──────────────────────────────────────────────────────

export async function handleModeration(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: ModerationFixture[],
  journal: Journal,
  defaults: { logger: Logger; strict?: boolean },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  let body: { input?: string | string[]; model?: unknown };
  try {
    body = JSON.parse(raw) as { input?: string | string[]; model?: unknown };
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
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
      renderError("openai", "validation", {
        message: `Malformed JSON: ${detail}`,
        type: "invalid_request_error",
        code: "invalid_json",
      }).body,
    );
    return;
  }

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `body.input` throws a TypeError that surfaces
  // as a 500 instead of a 400.
  if (!isJsonObject(body)) {
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
      renderError("openai", "validation", {
        message: "Request body must be a JSON object",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Normalize input to a single string for matching — reject non-string
  // inputs with 400 instead of crashing in matchesPattern()/slice() (500).
  const rawInput: unknown = body.input ?? "";
  const normalized = normalizeTextInput(rawInput);
  if (normalized === null) {
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
      renderError("openai", "validation", {
        message:
          "Invalid parameter: 'input' must be a string, an array of strings, or an array of multimodal parts",
        type: "invalid_request_error",
        param: null,
        code: null,
        includeParam: true,
      }).body,
    );
    return;
  }
  const inputText = normalized;

  // Echo the requested model, like the real API. A missing (or non-string)
  // `model` falls back to the current default rather than a removed id.
  const requestedModel =
    typeof body.model === "string" && body.model.length > 0 ? body.model : DEFAULT_MODERATION_MODEL;

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

  // Strict mode turns the lenient default (unflagged) into a no-match error,
  // like every other fixture-matching handler. These fixtures carry no
  // sequence/turn state, so the skipped count is always 0.
  if (!matchedFixture && resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss) {
    const strictMessage = strictNoMatchMessage(0);
    logger.error(strictNoMatchLogLine(req.method ?? "POST", req.url ?? "/v1/moderations", 0));
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? "/v1/moderations",
      headers: flattenHeaders(req.headers),
      body: null,
      service: "moderation",
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

  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/v1/moderations",
    headers: flattenHeaders(req.headers),
    body: null,
    service: "moderation",
    response: {
      status: 200,
      fixture: null,
      ...strictOverrideField(defaults.strict, req.headers),
    },
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: generateId("modr"),
      model: requestedModel,
      results: [matchedResult],
    }),
  );
}
