import { renderError } from "./response/errors.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import type http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import {
  isAudioResponse,
  isTextResponse,
  isErrorResponse,
  isJsonObject,
  flattenHeaders,
  FORMAT_TO_CONTENT_TYPE,
  getContext,
  getTestId,
  resolveResponse,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { proxyAndRecord } from "./recorder.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";

export async function handleElevenLabsTTS(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
  voiceId: string,
): Promise<void> {
  const path = req.url ?? `/v1/text-to-speech/${voiceId}`;
  const method = req.method ?? "POST";

  // Parse JSON body
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
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
  // touching fields — otherwise `parsed.text` throws a TypeError that surfaces
  // as a 500 instead of a 400.
  if (!isJsonObject(parsed)) {
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

  // Extract text from request body
  const promptText = typeof parsed.text === "string" && parsed.text ? parsed.text : undefined;

  // Build synthetic ChatCompletionRequest for fixture matching
  const syntheticReq: ChatCompletionRequest = {
    model: (parsed.model_id as string) ?? "eleven_multilingual_v2",
    messages: [{ role: "user", content: promptText ?? "" }],
    _endpointType: "elevenlabs-tts",
    _context: getContext(req),
  };

  // Validate required field
  if (!promptText) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: "Missing required parameter: 'text'",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Match fixture
  const testId = getTestId(req);
  const matchCounts = journal.getFixtureMatchCountsForTest(testId);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    syntheticReq,
    matchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
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

  // No fixture match
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
        "elevenlabs",
        req.url ?? `/v1/text-to-speech/${voiceId}`,
        fixtures,
        defaults,
        body,
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

  // Error fixture
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

  // Expect audio response
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

  // Decode audio bytes and determine content type
  let audioBytes: Buffer;
  let contentType: string;

  if (typeof response.audio === "string") {
    audioBytes = Buffer.from(response.audio, "base64");
    const format = response.format ?? "mp3";
    contentType = FORMAT_TO_CONTENT_TYPE[format] ?? "audio/mpeg";
  } else {
    audioBytes = Buffer.from(response.audio.b64Json, "base64");
    contentType = response.audio.contentType ?? "audio/mpeg";
  }

  // Standard binary response
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture },
  });
  res.writeHead(200, { "Content-Type": contentType });
  res.end(audioBytes);
}

export async function handleElevenLabsAudio(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
  subType: string, // "sound-generation" | "music" | "stream" | "plan"
): Promise<void> {
  const path = req.url ?? "/v1/sound-generation";
  const method = req.method ?? "POST";

  // Parse JSON body
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
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
  // touching fields — otherwise `parsed.text` throws a TypeError that surfaces
  // as a 500 instead of a 400.
  if (!isJsonObject(parsed)) {
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

  // Extract prompt text based on subType
  let promptText: string | undefined;
  if (subType === "sound-generation") {
    if (typeof parsed.text === "string" && parsed.text) {
      promptText = parsed.text;
    }
  } else {
    // music, music-stream, music-plan all use "prompt" (or composition_plan fallback)
    if (typeof parsed.prompt === "string" && parsed.prompt) {
      promptText = parsed.prompt;
    } else if (parsed.composition_plan != null) {
      promptText =
        typeof parsed.composition_plan === "string"
          ? parsed.composition_plan
          : JSON.stringify(parsed.composition_plan);
    }
  }

  // Build synthetic ChatCompletionRequest for fixture matching (needed for journal even on validation failure)
  const syntheticReq: ChatCompletionRequest = {
    model:
      (parsed.model_id as string) ??
      (subType === "sound-generation" ? "eleven_text_to_sound_v2" : "music_v1"),
    messages: [{ role: "user", content: promptText ?? "" }],
    _endpointType: "audio-gen",
    _context: getContext(req),
  };

  // Validate required field
  if (!promptText) {
    const field = subType === "sound-generation" ? "text" : "prompt";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: `Missing required parameter: '${field}'`,
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Match fixture
  const testId = getTestId(req);
  const matchCounts = journal.getFixtureMatchCountsForTest(testId);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    syntheticReq,
    matchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
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

  // No fixture match
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
        "elevenlabs",
        req.url ?? "/v1/sound-generation",
        fixtures,
        defaults,
        body,
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

  // Error fixture
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

  // plan returns JSON text, not audio
  if (subType === "plan") {
    if (!isTextResponse(response)) {
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
          message: "Fixture response is not a text type for plan endpoint",
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(response.content);
    return;
  }

  // All other subTypes expect audio
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

  // Decode audio bytes and determine content type
  let audioBytes: Buffer;
  let contentType: string;

  if (typeof response.audio === "string") {
    audioBytes = Buffer.from(response.audio, "base64");
    const format = response.format ?? "mp3";
    contentType = FORMAT_TO_CONTENT_TYPE[format] ?? "audio/mpeg";
  } else {
    audioBytes = Buffer.from(response.audio.b64Json, "base64");
    contentType = response.audio.contentType ?? "audio/mpeg";
  }

  // Music endpoints get a song-id header
  if (subType === "music" || subType === "stream") {
    res.setHeader("song-id", "mock-song-" + Date.now());
  }

  // Stream uses chunked transfer encoding
  if (subType === "stream") {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 200, fixture },
    });
    res.writeHead(200, {
      "Content-Type": contentType,
      "Transfer-Encoding": "chunked",
    });
    res.end(audioBytes);
    return;
  }

  // Standard binary response for sound-generation and music
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture },
  });
  res.writeHead(200, { "Content-Type": contentType });
  res.end(audioBytes);
}
