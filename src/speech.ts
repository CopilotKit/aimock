import type * as http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import { isAudioResponse, isErrorResponse, flattenHeaders, getTestId } from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

interface SpeechRequest {
  model?: string;
  input: string;
  voice?: string;
  response_format?: string;
  speed?: number;
  [key: string]: unknown;
}

const FORMAT_TO_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

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
  } catch {
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
      JSON.stringify({
        error: { message: "Malformed JSON", type: "invalid_request_error", code: "invalid_json" },
      }),
    );
    return;
  }

  if (!speechReq.input) {
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
      JSON.stringify({
        error: { message: "Missing required parameter: 'input'", type: "invalid_request_error" },
      }),
    );
    return;
  }

  const syntheticReq: ChatCompletionRequest = {
    model: speechReq.model ?? "tts-1",
    messages: [{ role: "user", content: speechReq.input }],
    _endpointType: "speech",
  };

  const testId = getTestId(req);
  const fixture = matchFixture(
    fixtures,
    syntheticReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      const proxied = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        "openai",
        req.url ?? "/v1/audio/speech",
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
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

    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: strictStatus, fixture: null },
    });
    writeErrorResponse(
      res,
      strictStatus,
      JSON.stringify({
        error: { message: strictMessage, type: "invalid_request_error", code: "no_fixture_match" },
      }),
    );
    return;
  }

  const response = fixture.response;

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
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
      JSON.stringify({
        error: { message: "Fixture response is not an audio type", type: "server_error" },
      }),
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
