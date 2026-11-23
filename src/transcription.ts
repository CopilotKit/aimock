import { renderError } from "./response/errors.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import type * as http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import {
  isTranscriptionResponse,
  isErrorResponse,
  flattenHeaders,
  getTestId,
  resolveResponse,
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { matchFixtureDiagnostic } from "./router.js";
import { sseCodec, writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";
import { proxyInterruption, withHangUpDetection } from "./response/proxy.js";
import { deliverStream } from "./response/deliver.js";
import type { FrameCodec } from "./response/frame-loop.js";

/** One `transcript.text.delta` frame of a streamed transcription. */
interface TranscriptDelta {
  type: "transcript.text.delta";
  delta: string;
}

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
      const { outcome, clientHungUp } = await withHangUpDetection(req, res, () =>
        proxyAndRecord(
          req,
          res,
          syntheticReq,
          "openai",
          req.url ?? defaultPath,
          fixtures,
          defaults,
          raw,
        ),
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method,
          path,
          headers: flattenHeaders(req.headers),
          body: syntheticReq,
          response: {
            status: res.statusCode ?? 200,
            fixture: null,
            source: "proxy",
            ...proxyInterruption(res, clientHungUp),
          },
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
      renderError("openai", "unknown-response", {
        message: "Fixture response is not a transcription type",
        type: "server_error",
      }).body,
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
    const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);
    const frames: TranscriptDelta[] = [];
    for (let index = 0; index < t.text.length; index += chunkSize) {
      frames.push({ type: "transcript.text.delta", delta: t.text.slice(index, index + chunkSize) });
    }
    // The live `gpt-transcribe&stream=true` stream ends with the `[DONE]`
    // sentinel after `transcript.text.done`. Omitting it leaves clients that
    // loop until the sentinel waiting on a stream that never terminates.
    const codec: FrameCodec<TranscriptDelta> = {
      ...sseCodec<TranscriptDelta>({ done: false }),
      writeHeadImmediately: true,
      trailer: () => [`data: ${JSON.stringify(done)}\n\n`, "data: [DONE]\n\n"],
    };
    await deliverStream(res, journalEntry, fixture, codec, frames, {
      latency: fixture.latency ?? defaults.latency,
      streamingProfile: fixture.streamingProfile,
      recordedTimings: fixture.recordedTimings,
      replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
    });
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
