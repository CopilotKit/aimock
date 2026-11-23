import { renderError } from "./response/errors.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import type * as http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import {
  isAudioResponse,
  isErrorResponse,
  isJsonObject,
  flattenHeaders,
  getTestId,
  FORMAT_TO_CONTENT_TYPE,
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

interface SpeechRequest {
  model?: string;
  input: string;
  voice?: string;
  response_format?: string;
  speed?: number;
  [key: string]: unknown;
}

export async function handleSpeech(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? "/v1/audio/speech";
  const method = req.method ?? "POST";

  let speechReq: SpeechRequest;
  try {
    speechReq = JSON.parse(raw) as SpeechRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: `Malformed JSON: ${detail}`,
        type: "invalid_request_error",
        code: "invalid_json",
      }).body,
    );
    return;
  }

  // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
  // touching fields — otherwise `speechReq.input` throws a TypeError that
  // surfaces as a 500 instead of a 400.
  if (!isJsonObject(speechReq)) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: "Request body must be a JSON object",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  const input: unknown = speechReq.input;
  const validInput =
    typeof input === "string" ||
    (Array.isArray(input) &&
      input.length > 0 &&
      input.every(
        (part: unknown) =>
          isJsonObject(part) &&
          typeof part.type === "string" &&
          (!("text" in part) || typeof part.text === "string"),
      ));
  if (!input || !validInput) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: !input
          ? "Missing required parameter: 'input'"
          : "Invalid parameter: 'input' must be a string or a nonempty array of content parts",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  const syntheticReq: ChatCompletionRequest = {
    model: speechReq.model ?? "tts-1",
    messages: [{ role: "user", content: speechReq.input }],
    _endpointType: "speech",
    _context: getContext(req),
  };

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    syntheticReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    defaults.logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    defaults.logger.debug(`No fixture matched for request`);
  }

  if (
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      fixture ? "fixture" : "proxy",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    const effectiveStrict = resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss;
    if (effectiveStrict) {
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      defaults.logger.error(strictNoMatchLogLine(method, path, skippedBySequenceOrTurn));
      journal.add({
        method,
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
        renderError("openai", "strict-miss", {
          message: strictMessage,
          type: "invalid_request_error",
          code: "no_fixture_match",
        }).body,
      );
      return;
    }
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        "openai",
        req.url ?? "/v1/audio/speech",
        fixtures,
        defaults,
        raw,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method,
          path,
          headers: flattenHeaders(req.headers),
          body: syntheticReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }

    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      404,
      renderError("openai", "fixture-miss", {
        message: "No fixture matched",
        type: "invalid_request_error",
        code: "no_fixture_match",
      }).body,
    );
    return;
  }

  const response = await resolveResponse(fixture, syntheticReq);

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, renderError("openai", "fixture", response.error).body, {
      retryAfter: response.retryAfter,
    });
    return;
  }

  if (!isAudioResponse(response)) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    writeErrorResponse(
      res,
      500,
      renderError("openai", "unknown-response", {
        message: "Fixture response is not an audio type",
        type: "server_error",
      }).body,
    );
    return;
  }

  // Object-form audio is not supported for the speech endpoint — reject early
  if (typeof response.audio !== "string") {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    writeErrorResponse(
      res,
      500,
      renderError("openai", "unknown-response", {
        message:
          "Object-form audio not supported for speech endpoint. Use string-form: { audio: '<base64>' }",
        type: "server_error",
      }).body,
    );
    return;
  }

  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture },
  });

  const format = response.format ?? "mp3";
  const contentType = FORMAT_TO_CONTENT_TYPE[format] ?? "audio/mpeg";
  const audioBytes = Buffer.from(response.audio, "base64");

  res.writeHead(200, { "Content-Type": contentType });
  res.end(audioBytes);
}
