import { renderError } from "./response/errors.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  Fixture,
  HandlerDefaults,
  RecordProviderKey,
} from "./types.js";
import {
  isImageResponse,
  isErrorResponse,
  isJsonObject,
  flattenHeaders,
  getContext,
  getTestId,
  resolveResponse,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";
import { extractBoundary, extractFormField } from "./transcription.js";

/**
 * Model used for fixture matching when the caller sends no `model`.
 *
 * `dall-e-2`/`dall-e-3` were removed from the OpenAI API on 2026-05-12;
 * `gpt-image-1` is OpenAI's documented replacement for both. A request that
 * names a model still has that model echoed through unchanged.
 */
const DEFAULT_IMAGE_MODEL = "gpt-image-1";

interface OpenAIImageRequest {
  model?: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
  [key: string]: unknown;
}

interface GeminiPredictRequest {
  instances: Array<{ prompt: string }>;
  parameters?: { sampleCount?: number };
  [key: string]: unknown;
}

function buildSyntheticRequest(
  model: string,
  prompt: string,
  context?: string,
): ChatCompletionRequest {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    _endpointType: "image",
    ...(context !== undefined && { _context: context }),
  };
}

export async function handleImages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  format: "openai" | "gemini" = "openai",
  geminiModel?: string,
  /**
   * Provider key this request records under. Defaults to `"openai"` — the
   * value hardcoded here before BytePlus Ark needed images attribution — so the
   * Gemini `:predict` call site keeps today's behavior by omitting it. Only the
   * OpenAI-images call site passes it, and only with a non-default value behind
   * server.ts's configuration gate (a byteplus upstream must be configured AND
   * the request must carry the /api/v3 prefix).
   */
  recordProviderKey?: RecordProviderKey,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? "/v1/images/generations";
  const method = req.method ?? "POST";

  let model: string;
  let prompt: string;

  let body: unknown;
  try {
    body = JSON.parse(raw);
    // Reject bodies that parsed but are not a JSON object (e.g. `null`) before
    // touching fields — without this the TypeError below lands in the
    // malformed-JSON branch with a misleading message.
    if (!isJsonObject(body)) {
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
    if (format === "gemini") {
      const geminiReq = body as GeminiPredictRequest;
      prompt = geminiReq.instances?.[0]?.prompt ?? "";
      model = geminiModel ?? "imagen";
    } else {
      const openaiReq = body as OpenAIImageRequest;
      prompt = openaiReq.prompt ?? "";
      model = openaiReq.model ?? DEFAULT_IMAGE_MODEL;
    }
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

  const promptValue: unknown = prompt;
  if (
    !promptValue ||
    (typeof promptValue !== "string" &&
      !(
        Array.isArray(promptValue) &&
        promptValue.length > 0 &&
        promptValue.every(
          (part: unknown) =>
            isJsonObject(part) &&
            typeof part.type === "string" &&
            (part.text === undefined || typeof part.text === "string"),
        )
      ))
  ) {
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
        message: !prompt
          ? "Missing required parameter: 'prompt'"
          : "Invalid parameter: 'prompt' must be a string or non-empty content-parts array",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  const syntheticReq = buildSyntheticRequest(model, prompt, getContext(req));
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
        format === "gemini" ? "gemini" : (recordProviderKey ?? "openai"),
        req.url ?? "/v1/images/generations",
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

  if (!isImageResponse(response)) {
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
        message: "Fixture response is not an image type",
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

  // Normalize to array of image items
  const items = response.images ?? (response.image ? [response.image] : []);

  if (format === "gemini") {
    const predictions = items.map((item) => ({
      bytesBase64Encoded: item.b64Json ?? "",
      mimeType: "image/png" as const,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ predictions }));
  } else {
    serializeOpenAIImageResponse(res, items);
  }
}

/**
 * Write the standard OpenAI image response envelope (`{ created, data }`).
 * Shared by generations, edit, and variations endpoints.
 */
function serializeOpenAIImageResponse(
  res: http.ServerResponse,
  items: Array<{ url?: string; b64Json?: string; revisedPrompt?: string }>,
): void {
  const data = items.map((item) => {
    const entry: Record<string, string> = {};
    if (item.url) entry.url = item.url;
    if (item.b64Json) entry.b64_json = item.b64Json;
    if (item.revisedPrompt) entry.revised_prompt = item.revisedPrompt;
    return entry;
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data }));
}

/**
 * Handle POST /v1/images/edits — OpenAI Image Edit API.
 *
 * Request uses multipart/form-data. We extract text fields (`prompt`, `model`,
 * `n`, `size`, `response_format`) and ignore binary fields (`image`, `mask`)
 * since aimock doesn't process actual image data.
 *
 * The response envelope is identical to /v1/images/generations.
 */
export async function handleImageEdit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? "/v1/images/edits";
  const method = req.method ?? "POST";

  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  const boundary = extractBoundary(contentType);

  const prompt = extractFormField(raw, "prompt", boundary) ?? "";
  const model = extractFormField(raw, "model", boundary) ?? DEFAULT_IMAGE_MODEL;

  if (!prompt) {
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
        message: "Missing required parameter: 'prompt'",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  const syntheticReq = buildSyntheticRequest(model, prompt, getContext(req));
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
        req.url ?? "/v1/images/edits",
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

  if (!isImageResponse(response)) {
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
        message: "Fixture response is not an image type",
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

  const items = response.images ?? (response.image ? [response.image] : []);
  serializeOpenAIImageResponse(res, items);
}

/**
 * Handle POST /v1/images/variations — REMOVED upstream.
 *
 * `/v1/images/variations` only ever served `dall-e-2`. OpenAI removed
 * `dall-e-2` on 2026-05-12 and removed the endpoint with it: the path no
 * longer routes at all. Per aimock's deprecation policy
 * (https://aimock.copilotkit.dev/deprecation-policy/) a removed upstream
 * surface is mocked as REMOVED — aimock replays the rejection the real API
 * returns today, so the removal surfaces in the caller's tests instead of in
 * production. The route stays registered on purpose: it is the thing that
 * makes the removal explicit (and journaled) rather than silently falling
 * through to aimock's generic unknown-path 404, which carries a different body.
 *
 * Wire behaviour observed firsthand against `https://api.openai.com` on
 * 2026-09-15, both KEYLESS and with a live key, POST and OPTIONS:
 *
 *   HTTP/2 404
 *   server: cloudflare
 *   (zero-byte body, NO content-type, NO openai-version/x-request-id header)
 *
 * The 404 lands at the edge BEFORE authentication — a keyless request to
 * `/v1/images/variations` 404s while a keyless `/v1/images/generations` 401s —
 * and is byte-for-byte what a made-up path (`/v1/images/bogus`) returns. So
 * this is a removed ENDPOINT, not a live endpoint rejecting a dead model:
 * there is no JSON error envelope to replay, because the real API sends none.
 *
 * The `model` form field is irrelevant upstream (the request never reaches
 * model validation), so it is irrelevant here too.
 *
 * aimock's own CORS headers are still set — unlike the CDN 404, which carries
 * none — so a browser-based caller sees the 404 rather than a CORS failure
 * masking it. Status, empty body and absent `Content-Type` are the observed
 * values; the CORS headers are aimock's, and are the one deliberate departure.
 */
export function handleImageVariations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  void raw;
  void fixtures;
  setCorsHeaders(res);

  defaults.logger.warn(
    `POST /v1/images/variations is removed upstream (the endpoint 404s at api.openai.com; it only ever served dall-e-2, removed 2026-05-12) — replaying the real 404. See https://aimock.copilotkit.dev/deprecation-policy/`,
  );

  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? "/v1/images/variations",
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 404, fixture: null, source: "internal" },
  });

  // Written raw, NOT through writeErrorResponse(): the real API sends a
  // zero-byte body with no Content-Type, and writeErrorResponse() would
  // force `Content-Type: application/json` and a JSON envelope.
  res.writeHead(404);
  res.end();
  return Promise.resolve();
}
