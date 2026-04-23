import type * as http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import { isImageResponse, isErrorResponse, flattenHeaders, getTestId } from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

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

function buildSyntheticRequest(model: string, prompt: string): ChatCompletionRequest {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    _endpointType: "image",
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
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? "/v1/images/generations";
  const method = req.method ?? "POST";

  let model: string;
  let prompt: string;

  try {
    const body = JSON.parse(raw);
    if (format === "gemini") {
      const geminiReq = body as GeminiPredictRequest;
      prompt = geminiReq.instances?.[0]?.prompt ?? "";
      model = geminiModel ?? "imagen";
    } else {
      const openaiReq = body as OpenAIImageRequest;
      prompt = openaiReq.prompt ?? "";
      model = openaiReq.model ?? "dall-e-3";
    }
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
      JSON.stringify({
        error: { message: "Missing required parameter: 'prompt'", type: "invalid_request_error" },
      }),
    );
    return;
  }

  const syntheticReq = buildSyntheticRequest(model, prompt);
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
        format === "gemini" ? "gemini" : "openai",
        req.url ?? "/v1/images/generations",
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
      JSON.stringify({
        error: { message: "Fixture response is not an image type", type: "server_error" },
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
}
