import type http from "node:http";
import type {
  ChatCompletionRequest,
  Fixture,
  HandlerDefaults,
  RawJSONResponse,
  VoiceDesignResponse,
} from "./types.js";
import {
  isErrorResponse,
  isJSONResponse,
  isJsonObject,
  serializeErrorResponse,
  flattenHeaders,
  getContext,
  getTestId,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { proxyAndRecord } from "./recorder.js";
import type { Journal } from "./journal.js";
import { applyChaos } from "./chaos.js";

const VOICE_STORE_MAX = 10_000;

/**
 * Voices created via POST /v1/text-to-voice, keyed by voice_id. Cleared on
 * full reset so GET/DELETE stay isolated across tests.
 */
const elevenLabsVoices = new Map<string, Record<string, unknown>>();

export function clearElevenLabsVoices(): void {
  elevenLabsVoices.clear();
}

export function rememberElevenLabsVoice(voice: Record<string, unknown>): void {
  const voiceId = typeof voice.voice_id === "string" ? voice.voice_id : undefined;
  if (!voiceId) return;
  elevenLabsVoices.set(voiceId, voice);
  if (elevenLabsVoices.size > VOICE_STORE_MAX) {
    const excess = elevenLabsVoices.size - VOICE_STORE_MAX;
    const iter = elevenLabsVoices.keys();
    for (let i = 0; i < excess; i++) {
      const next = iter.next();
      if (!next.done) elevenLabsVoices.delete(next.value);
    }
  }
}

export function voiceDesignToJson(response: VoiceDesignResponse): RawJSONResponse {
  const previews = response.previews.map((preview, index) => ({
    generated_voice_id: preview.generated_voice_id || `aimock-preview-${index}`,
    audio_base_64: preview.audio_base_64 ?? "",
    media_type: preview.media_type ?? "audio/mpeg",
    duration_secs: preview.duration_secs ?? 0,
    language: preview.language ?? null,
  }));
  return {
    json: {
      previews,
      text: response.text ?? "",
    },
  };
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function parseJsonObject(
  body: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  path: string,
  method: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
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
      JSON.stringify({
        error: {
          message: `Malformed JSON: ${detail}`,
          type: "invalid_request_error",
          code: "invalid_json",
        },
      }),
    );
    return null;
  }

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
      JSON.stringify({
        error: {
          message: "Request body must be a JSON object",
          type: "invalid_request_error",
        },
      }),
    );
    return null;
  }

  return parsed;
}

function buildSyntheticReq(
  parsed: Record<string, unknown>,
  matchText: string,
  endpoint: "elevenlabs-voice-design" | "elevenlabs-voice",
  modelFallback: string,
  req: http.IncomingMessage,
): ChatCompletionRequest {
  return {
    model: typeof parsed.model_id === "string" ? parsed.model_id : modelFallback,
    messages: [{ role: "user", content: matchText }],
    _endpointType: endpoint,
    _context: getContext(req),
  };
}

async function missPath(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  syntheticReq: ChatCompletionRequest,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
  path: string,
  method: string,
  body: string,
  skippedBySequenceOrTurn: number,
): Promise<"handled" | "miss"> {
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
    return "handled";
  }

  if (defaults.record) {
    const outcome = await proxyAndRecord(
      req,
      res,
      syntheticReq,
      "elevenlabs",
      req.url ?? path,
      fixtures,
      defaults,
      body,
    );
    if (outcome === "handled_by_hook") return "handled";
    if (outcome !== "not_configured") {
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
      });
      return "handled";
    }
  }

  return "miss";
}

function writeNoMatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  syntheticReq: ChatCompletionRequest,
  defaults: HandlerDefaults,
  journal: Journal,
  path: string,
  method: string,
): void {
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
}

function buildSyntheticVoice(parsed: Record<string, unknown>): Record<string, unknown> {
  const generatedVoiceId = String(parsed.generated_voice_id);
  const labels =
    parsed.labels && typeof parsed.labels === "object" && !Array.isArray(parsed.labels)
      ? (parsed.labels as Record<string, unknown>)
      : {};
  return {
    voice_id: generatedVoiceId,
    name: String(parsed.voice_name),
    category: "generated",
    description: String(parsed.voice_description),
    labels,
    preview_url: null,
    available_for_tiers: [],
    settings: null,
    sharing: null,
    high_quality_base_model_ids: [],
    samples: null,
    safety_control: null,
    voice_verification: {
      requires_verification: false,
      is_verified: false,
      verification_failures: [],
      verification_attempts_count: 0,
    },
    permission_on_resource: null,
    is_owner: true,
    is_legacy: false,
    is_mixed: false,
  };
}

export async function handleElevenLabsVoiceDesign(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<void> {
  const path = req.url ?? "/v1/text-to-voice/design";
  const method = req.method ?? "POST";

  const parsed = parseJsonObject(body, req, res, journal, path, method);
  if (!parsed) return;

  const description =
    typeof parsed.voice_description === "string" && parsed.voice_description
      ? parsed.voice_description
      : undefined;

  const syntheticReq = buildSyntheticReq(
    parsed,
    description ?? "",
    "elevenlabs-voice-design",
    "eleven_multilingual_ttv_v2",
    req,
  );

  if (!description) {
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
      JSON.stringify({
        error: {
          message: "Missing required parameter: 'voice_description'",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

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
    applyChaos(
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
  ) {
    return;
  }

  if (!fixture) {
    const outcome = await missPath(
      req,
      res,
      syntheticReq,
      fixtures,
      defaults,
      journal,
      path,
      method,
      body,
      skippedBySequenceOrTurn,
    );
    if (outcome === "handled") return;
    writeNoMatch(req, res, syntheticReq, defaults, journal, path, method);
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

  if (!isJSONResponse(response)) {
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
          message: "Fixture response is not a JSON type for voice design",
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
  writeJson(res, 200, response.json);
}

export async function handleElevenLabsVoiceCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<void> {
  const path = req.url ?? "/v1/text-to-voice";
  const method = req.method ?? "POST";

  const parsed = parseJsonObject(body, req, res, journal, path, method);
  if (!parsed) return;

  const missing =
    typeof parsed.voice_name !== "string" || !parsed.voice_name
      ? "voice_name"
      : typeof parsed.voice_description !== "string" || !parsed.voice_description
        ? "voice_description"
        : typeof parsed.generated_voice_id !== "string" || !parsed.generated_voice_id
          ? "generated_voice_id"
          : null;

  const syntheticReq = buildSyntheticReq(
    parsed,
    typeof parsed.generated_voice_id === "string" ? parsed.generated_voice_id : "",
    "elevenlabs-voice",
    "eleven_multilingual_ttv_v2",
    req,
  );

  if (missing) {
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
      JSON.stringify({
        error: {
          message: `Missing required parameter: '${missing}'`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

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
    applyChaos(
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
  ) {
    return;
  }

  if (!fixture) {
    const outcome = await missPath(
      req,
      res,
      syntheticReq,
      fixtures,
      defaults,
      journal,
      path,
      method,
      body,
      skippedBySequenceOrTurn,
    );
    if (outcome === "handled") return;

    const voice = buildSyntheticVoice(parsed);
    rememberElevenLabsVoice(voice);
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 200, fixture: null },
    });
    writeJson(res, 200, voice);
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

  if (!isJSONResponse(response)) {
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
          message: "Fixture response is not a JSON type for voice create",
          type: "server_error",
        },
      }),
    );
    return;
  }

  if (isJsonObject(response.json)) {
    rememberElevenLabsVoice(response.json);
  }

  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture },
  });
  writeJson(res, 200, response.json);
}

export async function handleElevenLabsVoiceGet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  voiceId: string,
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<void> {
  const path = req.url ?? `/v1/voices/${voiceId}`;
  const method = req.method ?? "GET";
  const syntheticReq: ChatCompletionRequest = {
    model: "eleven_multilingual_ttv_v2",
    messages: [{ role: "user", content: voiceId }],
    _endpointType: "elevenlabs-voice",
    _context: getContext(req),
  };

  const stored = elevenLabsVoices.get(voiceId);
  if (stored) {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 200, fixture: null },
    });
    writeJson(res, 200, stored);
    return;
  }

  if (defaults.record) {
    const outcome = await proxyAndRecord(
      req,
      res,
      syntheticReq,
      "elevenlabs",
      req.url ?? path,
      [],
      defaults,
      "",
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
          message: `Voice '${voiceId}' not found`,
          type: "invalid_request_error",
          code: "no_fixture_match",
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
    response: { status: 404, fixture: null },
  });
  writeErrorResponse(
    res,
    404,
    JSON.stringify({
      error: {
        message: `Voice '${voiceId}' not found`,
        type: "invalid_request_error",
        code: "voice_not_found",
      },
    }),
  );
}

export async function handleElevenLabsVoiceDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  voiceId: string,
  journal: Journal,
): Promise<void> {
  const path = req.url ?? `/v1/voices/${voiceId}`;
  const method = req.method ?? "DELETE";
  elevenLabsVoices.delete(voiceId);
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null },
  });
  writeJson(res, 200, { status: "ok" });
}
