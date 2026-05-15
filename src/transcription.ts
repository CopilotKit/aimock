import type * as http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import {
  isTranscriptionResponse,
  isErrorResponse,
  serializeErrorResponse,
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
 * Extract the multipart boundary string from a Content-Type header.
 */
function extractBoundary(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = contentType.match(/boundary=([^\s;]+)/i);
  return match?.[1];
}

/**
 * Extract a text field from multipart form data using boundary-based parsing.
 * Splits the body by the multipart boundary so each part is isolated, then
 * checks each part's Content-Disposition header for the target field name.
 * This avoids false matches from binary audio data that might contain
 * header-like byte sequences.
 */
function extractFormField(
  raw: string,
  fieldName: string,
  boundary: string | undefined,
): string | undefined {
  if (!boundary) {
    // Fallback: no boundary available, use simple regex (best-effort)
    const pattern = new RegExp(
      `Content-Disposition:\\s*form-data;[^\\r\\n]*name="${fieldName}"[^\\r\\n]*\\r\\n\\r\\n([^\\r\\n]*)`,
      "i",
    );
    const match = raw.match(pattern);
    return match?.[1];
  }

  // Split by boundary delimiter — each chunk is one part
  const delimiter = `--${boundary}`;
  const parts = raw.split(delimiter);

  for (const part of parts) {
    // Skip the preamble (before first boundary) and epilogue (after closing boundary)
    if (!part || part.trimStart().startsWith("--")) continue;

    // Split part into headers and body at the first blank line (\r\n\r\n)
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4);

    // Check if this part's Content-Disposition names the target field
    const cdMatch = headers.match(/Content-Disposition:\s*form-data;[^\r\n]*name="([^"]+)"/i);
    if (cdMatch && cdMatch[1] === fieldName) {
      // Return the body value, trimming trailing \r\n from the part boundary
      return body.replace(/\r\n$/, "");
    }
  }
  return undefined;
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

  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  const boundary = extractBoundary(contentType);

  const model = extractFormField(raw, "model", boundary) ?? "whisper-1";
  const responseFormat = extractFormField(raw, "response_format", boundary) ?? "json";

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
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    if (effectiveStrict) {
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
        JSON.stringify({
          error: {
            message: "Strict mode: no fixture matched",
            type: "invalid_request_error",
            code: "no_fixture_match",
          },
        }),
      );
      return;
    }
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
      JSON.stringify({
        error: {
          message: "No fixture matched",
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
    writeErrorResponse(res, status, serializeErrorResponse(response));
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
