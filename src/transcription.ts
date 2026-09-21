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
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { matchFixtureDiagnostic } from "./router.js";
import { calculateDelay, delay, writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";
import { createInterruptionSignal } from "./interruption.js";

/**
 * Extract the multipart boundary string from a Content-Type header.
 *
 * RFC 2046 §5.1.1 defines the boundary parameter as either a bare token
 * (`boundary=abc123`) or a quoted-string (`boundary="abc123"`), and its
 * `bchars` production INCLUDES a space — which is exactly the case the quoted
 * form exists for, and the one a capture that stops at whitespace can never
 * read. So the quotes are consumed BY the match rather than stripped after it:
 * a post-strip runs on an already-truncated value and leaves `boundary="a b c"`
 * as the useless `"a`, and the delimiter then never matches, so every form
 * field silently falls back to its default (`whisper-1`, `gpt-image-1`, …).
 *
 * Only DQUOTE quotes. An apostrophe is a legal RFC 2045 token character and a
 * legal RFC 2046 `bchar`, so `boundary='abc'` is a BARE token whose value
 * literally includes the quotes, and stripping them would break a working
 * request.
 *
 * The `(?:^|[;\s])` prefix keeps a decoy parameter such as `myboundary=` from
 * matching, and `\s*=\s*` tolerates the LWSP some clients put around the `=`.
 */
export function extractBoundary(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = contentType.match(/(?:^|[;\s])boundary\s*=\s*(?:"([^"]*)"|([^\s;]+))/i);
  if (!match) return undefined;
  // Group 1 is the quoted form (possibly the empty string), group 2 the bare
  // token; an empty boundary is meaningless, so it reads as absent.
  const boundary = match[1] !== undefined ? match[1] : match[2];
  return boundary || undefined;
}

/**
 * Extract a text field from multipart form data using boundary-based parsing.
 * Splits the body by the multipart boundary so each part is isolated, then
 * checks each part's Content-Disposition header for the target field name.
 * This avoids false matches from binary audio data that might contain
 * header-like byte sequences.
 */
export function extractFormField(
  raw: string,
  fieldName: string,
  boundary: string | undefined,
): string | undefined {
  if (!boundary) {
    // Fallback: no boundary available, use simple regex (best-effort)
    console.warn("extractFormField: no multipart boundary found, using best-effort regex fallback");
    const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `Content-Disposition:\\s*form-data;(?:[^\\r\\n]*;)?\\s*name="${escaped}"[^\\r\\n]*\\r\\n\\r\\n([^\\r\\n]*)`,
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
    const cdMatch = headers.match(
      /Content-Disposition:\s*form-data;(?:[^\r\n]*;)?\s*name="([^"]+)"/i,
    );
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
  endpointType: "transcription" | "translation" = "transcription",
): Promise<void> {
  setCorsHeaders(res);
  const defaultPath =
    endpointType === "translation" ? "/v1/audio/translations" : "/v1/audio/transcriptions";
  const path = req.url ?? defaultPath;
  const method = req.method ?? "POST";

  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  const boundary = extractBoundary(contentType);

  const model = extractFormField(raw, "model", boundary) ?? "whisper-1";
  const responseFormat = extractFormField(raw, "response_format", boundary) ?? "json";
  const stream = extractFormField(raw, "stream", boundary) === "true";

  const syntheticReq: ChatCompletionRequest = {
    model,
    messages: [],
    _endpointType: endpointType,
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
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
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
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        "openai",
        req.url ?? defaultPath,
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
    writeErrorResponse(res, status, serializeErrorResponse(response), {
      retryAfter: response.retryAfter,
    });
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

  const journalEntry = journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture },
  });

  const t = response.transcription;

  // Only the transcription endpoint streams modern models. Whisper-1 ignores
  // `stream=true`, and translations continue to return their JSON response.
  if (endpointType === "transcription" && stream && model !== "whisper-1") {
    const done = {
      type: "transcript.text.done",
      text: t.text,
      ...(t.languages !== undefined ? { languages: t.languages } : {}),
      ...(t.usage !== undefined ? { usage: t.usage } : {}),
    };
    const latency = fixture.latency ?? defaults.latency;
    const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);
    const replaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let chunkIndex = 0;
    const interruption = createInterruptionSignal(fixture);
    for (let index = 0; index < t.text.length; index += chunkSize) {
      const chunkDelay = calculateDelay(
        chunkIndex,
        fixture.streamingProfile,
        latency,
        fixture.recordedTimings,
        replaySpeed,
      );
      if (chunkDelay > 0) await delay(chunkDelay, interruption?.signal);
      if (interruption?.signal.aborted) break;
      res.write(
        `data: ${JSON.stringify({ type: "transcript.text.delta", delta: t.text.slice(index, index + chunkSize) })}\n\n`,
      );
      interruption?.tick();
      chunkIndex++;
    }
    if (interruption?.signal.aborted) {
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption.reason();
      interruption.cleanup();
      res.destroy();
      return;
    }
    res.write(`data: ${JSON.stringify(done)}\n\n`);
    // The live `gpt-transcribe&stream=true` stream ends with the `[DONE]`
    // sentinel after `transcript.text.done`. Omitting it leaves clients that
    // loop until the sentinel waiting on a stream that never terminates.
    res.write("data: [DONE]\n\n");
    res.end();
    interruption?.cleanup();
    return;
  }

  const useVerbose = responseFormat === "verbose_json" || t.words != null || t.segments != null;

  if (useVerbose) {
    const verboseBody: Record<string, unknown> = {
      task: endpointType === "translation" ? "translate" : "transcribe",
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
    res.end(
      JSON.stringify({
        text: t.text,
        ...(t.languages !== undefined ? { languages: t.languages } : {}),
        ...(t.usage !== undefined ? { usage: t.usage } : {}),
      }),
    );
  }
}
