import { createHash } from "node:crypto";
import type http from "node:http";
import { renderError } from "./response/errors.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import type {
  ChatCompletionRequest,
  Fixture,
  HandlerDefaults,
  RecordProviderKey,
} from "./types.js";
import {
  FORMAT_TO_CONTENT_TYPE,
  flattenHeaders,
  getContext,
  getTestId,
  isAudioResponse,
  isErrorResponse,
  isJSONResponse,
  isJsonObject,
  resolveResponse,
  strictNoMatchLogLine,
  strictNoMatchMessage,
  wouldProxyMiss,
} from "./helpers.js";
import { releaseOneShotError } from "./fixture-loader.js";
import { selectFixtureForServing } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { proxyAndRecord } from "./recorder.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";
import { extractBoundary, extractFormField } from "./transcription.js";

/**
 * Record + replay for the three plain request/response audio routes a voice
 * pipeline chains together (issue #600):
 *
 *   - BytePlus Seed Speech `POST /api/v3/tts/create` (JSON in, JSON out with a
 *     base64 `audio`), provider key `byteplus-speech`.
 *   - ElevenLabs Scribe `POST /v1/speech-to-text` (multipart in, JSON out).
 *   - ElevenLabs Audio Isolation `POST /v1/audio-isolation` (multipart in,
 *     binary `audio/mpeg` out).
 *
 * MATCH KEYS. Each request becomes a synthetic one-message request whose user
 * text is the match key, so recorded fixtures carry `match.userMessage`:
 *   - Seed Speech: `text_prompt`, then one `[reference sha256:<16 hex>]` line
 *     per `references[].audio_data`. Matching is a substring test, so a
 *     hand-written fixture keyed on the prompt alone still matches a request
 *     with references; `X-Api-Request-Id` is never part of the key.
 *   - Scribe / Audio Isolation: `sha256:<hex>` of the uploaded audio bytes.
 *     On replay those bytes come from a replayed Seed take, so they are stable.
 *
 * Recorded responses are stored verbatim: JSON bodies as `{ json, status }`
 * (errors included, so a recorded 429 replays as a 429), isolation audio as an
 * audio fixture. Strict mode refuses a miss with 503 like the other ElevenLabs
 * routes.
 *
 * Multipart bodies arrive as a Buffer and are read as latin1, which maps each
 * byte to one char, so `extractFormField` works unchanged and
 * `Buffer.from(part, "latin1")` recovers the exact uploaded bytes.
 */

type AudioRoute = "byteplus-tts" | "elevenlabs-stt" | "elevenlabs-audio-isolation";

const ROUTES: Record<AudioRoute, { provider: RecordProviderKey; service: string }> = {
  "byteplus-tts": { provider: "byteplus-speech", service: "byteplus-speech" },
  "elevenlabs-stt": { provider: "elevenlabs", service: "elevenlabs-speech" },
  "elevenlabs-audio-isolation": { provider: "elevenlabs", service: "elevenlabs-speech" },
};

/** Body cap for these routes: Seed `references` can be several MB of base64. */
export const AUDIO_PIPELINE_MAX_BODY_BYTES = 64 * 1024 * 1024;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Pull the match key out of the request body, or a 400 message. */
function extractKey(
  route: AudioRoute,
  req: http.IncomingMessage,
  body: Buffer,
): { model: string; key: string } | { invalid: string } {
  if (route === "byteplus-tts") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch (err) {
      return { invalid: `Malformed JSON: ${err instanceof Error ? err.message : "unknown"}` };
    }
    if (!isJsonObject(parsed)) return { invalid: "Request body must be a JSON object" };
    if (typeof parsed.text_prompt !== "string") {
      return { invalid: "Missing required parameter: 'text_prompt'" };
    }
    const refs = Array.isArray(parsed.references) ? parsed.references : [];
    const refLines = refs.map((ref) => {
      const data =
        isJsonObject(ref) && typeof ref.audio_data === "string"
          ? ref.audio_data
          : JSON.stringify(ref);
      return `\n[reference sha256:${sha256(data).slice(0, 16)}]`;
    });
    return {
      model: typeof parsed.model === "string" ? parsed.model : "",
      key: parsed.text_prompt + refLines.join(""),
    };
  }

  const contentType = req.headers["content-type"];
  const boundary = extractBoundary(Array.isArray(contentType) ? contentType[0] : contentType);
  if (!boundary) return { invalid: "Request body must be multipart/form-data" };
  const raw = body.toString("latin1");
  const field = route === "elevenlabs-stt" ? "file" : "audio";
  const audio = extractFormField(raw, field, boundary);
  if (audio === undefined) return { invalid: `Missing required parameter: '${field}'` };
  return {
    model: route === "elevenlabs-stt" ? (extractFormField(raw, "model_id", boundary) ?? "") : "",
    key: `sha256:${sha256(Buffer.from(audio, "latin1"))}`,
  };
}

export async function handleAudioPipeline(
  route: AudioRoute,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<void> {
  const { provider, service } = ROUTES[route];
  const path = req.url ?? "";
  const method = req.method ?? "POST";
  const journalBase = () => ({ method, path, headers: flattenHeaders(req.headers), service });

  const extracted = extractKey(route, req, body);
  if ("invalid" in extracted) {
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: extracted.invalid,
        type: "invalid_request_error",
      }).body,
    );
    journal.add({ ...journalBase(), body: null, response: { status: 400, fixture: null } });
    return;
  }

  const syntheticReq: ChatCompletionRequest = {
    model: extracted.model,
    messages: [{ role: "user", content: extracted.key }],
    _endpointType: route,
    _context: getContext(req),
  };

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = selectFixtureForServing(
    fixtures,
    syntheticReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );
  if (fixture) journal.incrementFixtureMatchCount(fixture, fixtures, testId);

  const decisions = resolveRequestDecisions(defaults.strict, req.headers);
  if (
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { ...journalBase(), body: syntheticReq },
      fixture
        ? "fixture"
        : wouldProxyMiss(!decisions.upstream, defaults.record, provider)
          ? "proxy"
          : "internal",
      defaults.registry,
      defaults.logger,
    )
  ) {
    releaseOneShotError(fixtures, fixture);
    return;
  }

  if (!fixture) {
    if (decisions.fixtureMiss) {
      defaults.logger.error(strictNoMatchLogLine(method, path, skippedBySequenceOrTurn));
      writeErrorResponse(
        res,
        503,
        renderError("openai", "strict-miss", {
          message: strictNoMatchMessage(skippedBySequenceOrTurn),
          type: "invalid_request_error",
          code: "no_fixture_match",
        }).body,
      );
      journal.add({
        ...journalBase(),
        body: syntheticReq,
        response: {
          status: 503,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
      });
      return;
    }
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        provider,
        path,
        fixtures,
        defaults,
        body,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          ...journalBase(),
          body: syntheticReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }
    writeErrorResponse(
      res,
      404,
      renderError("openai", "fixture-miss", {
        message: "No fixture matched",
        type: "invalid_request_error",
        code: "no_fixture_match",
      }).body,
    );
    journal.add({
      ...journalBase(),
      body: syntheticReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    return;
  }

  const response = await resolveResponse(fixture, syntheticReq);
  let status: number;
  if (isErrorResponse(response)) {
    status = response.status ?? 500;
    writeErrorResponse(res, status, renderError("openai", "fixture", response.error).body, {
      retryAfter: response.retryAfter,
    });
  } else if (isJSONResponse(response)) {
    status = response.status ?? 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response.json));
  } else if (route === "elevenlabs-audio-isolation" && isAudioResponse(response)) {
    status = 200;
    const { audio } = response;
    const bytes = Buffer.from(typeof audio === "string" ? audio : audio.b64Json, "base64");
    const contentType =
      typeof audio === "string"
        ? (FORMAT_TO_CONTENT_TYPE[response.format ?? "mp3"] ?? "audio/mpeg")
        : (audio.contentType ?? "audio/mpeg");
    res.writeHead(status, { "Content-Type": contentType });
    res.end(bytes);
  } else {
    status = 500;
    writeErrorResponse(
      res,
      status,
      renderError("openai", "unknown-response", {
        message: `Fixture response type is not supported on ${route}`,
        type: "server_error",
      }).body,
    );
  }
  journal.add({ ...journalBase(), body: syntheticReq, response: { status, fixture } });
}
