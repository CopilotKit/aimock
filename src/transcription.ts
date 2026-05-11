import type * as http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import {
  isTranscriptionResponse,
  isErrorResponse,
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

/**
 * Extract a text field from multipart form data using regex.
 * NOTE: This runs against the full body including binary audio data.
 * It works because text metadata fields (model, response_format, etc.)
 * appear before the binary audio part in standard multipart encoding.
 * A proper multipart parser would be more robust but is overkill for
 * the small set of fields we extract.
 */
function extractFormField(raw: string, fieldName: string): string | undefined {
  const pattern = new RegExp(
    `Content-Disposition:\\s*form-data;[^\\r\\n]*name="${fieldName}"[^\\r\\n]*\\r\\n\\r\\n([^\\r\\n]*)`,
    "i",
  );
  const match = raw.match(pattern);
  return match?.[1];
}

export async function handleTranscription(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? "/v1/audio/transcriptions";
  const method = req.method ?? "POST";

  const model = extractFormField(raw, "model") ?? "whisper-1";
  const responseFormat = extractFormField(raw, "response_format") ?? "json";

  const syntheticReq: ChatCompletionRequest = {
    model,
    messages: [],
    _endpointType: "transcription",
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
    defaults.logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    defaults.logger.debug(`No fixture matched for request`);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      fixture ? "fixture" : "proxy",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        "openai",
        req.url ?? "/v1/audio/transcriptions",
        fixtures,
        defaults,
        raw,
      );
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

    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const strictStatus = effectiveStrict ? 503 : 404;
    const strictMessage = effectiveStrict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: strictStatus,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      strictStatus,
      JSON.stringify({
        error: {
          message: strictMessage,
          type: "invalid_request_error",
          code: "no_fixture_match",
        },
      }),
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
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  if (!isTranscriptionResponse(response)) {
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
        error: {
          message: "Fixture response is not a transcription type",
          type: "server_error",
        },
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

  const t = response.transcription;
  const useVerbose = responseFormat === "verbose_json" || t.words != null || t.segments != null;

  if (useVerbose) {
    const verboseBody: Record<string, unknown> = {
      task: "transcribe",
      language: t.language ?? "english",
      duration: t.duration ?? 0,
      text: t.text,
    };
    if (t.words && t.words.length > 0) {
      verboseBody.words = t.words;
    }
    if (t.segments && t.segments.length > 0) {
      verboseBody.segments = t.segments;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(verboseBody));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: t.text }));
  }
}
