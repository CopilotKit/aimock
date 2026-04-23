import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  ChatCompletionRequest,
  Fixture,
  FixtureResponse,
  RecordConfig,
  RecordProviderKey,
  ToolCall,
} from "./types.js";
import { getLastMessageByRole, getTextContent } from "./router.js";
import type { Logger } from "./logger.js";
import { collapseStreamingResponse } from "./stream-collapse.js";
import { writeErrorResponse } from "./sse-writer.js";
import { resolveUpstreamUrl } from "./url.js";

/** Headers to strip when proxying — hop-by-hop (RFC 2616 §13.5.1) + client-set. */
const STRIP_HEADERS = new Set([
  // Hop-by-hop (RFC 2616 §13.5.1)
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  // Set by HTTP client from the target URL / body
  "host",
  "content-length",
  // Not relevant for LLM APIs; avoid leaking or mismatched encoding
  "cookie",
  "accept-encoding",
]);

/**
 * Captured upstream response, exposed to the `beforeWriteResponse` hook so
 * callers can decide whether to relay it or mutate it (e.g. chaos injection).
 */
export interface ProxyCapturedResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export interface ProxyOptions {
  /**
   * Called after the upstream response has been captured and recorded, but
   * before the relay to the client. Contract when the hook returns `true`:
   *   1. It wrote its own response body on `res`.
   *   2. It journaled the outcome (proxyAndRecord will NOT journal it).
   *   3. proxyAndRecord skips its default relay and returns `"handled_by_hook"`.
   *
   * Returning `false` (or omitting the hook) lets proxyAndRecord relay the
   * upstream response normally and leaves journaling to the caller via the
   * `"relayed"` outcome. Rejected promises propagate and leave the response
   * unwritten.
   *
   * NOT invoked when the upstream response was streamed progressively to the
   * client (SSE) — the bytes are already on the wire and can't be mutated.
   * Callers that need to observe the bypass should pass `onHookBypassed`.
   */
  beforeWriteResponse?: (response: ProxyCapturedResponse) => boolean | Promise<boolean>;
  /**
   * Called when `beforeWriteResponse` was provided but could not be invoked
   * because the upstream response was streamed to the client progressively.
   * The hook was rolled + wired but the bytes left before it could fire.
   * Intended for observability (log/metric/journal annotation) — proxyAndRecord
   * still returns `"relayed"`.
   */
  onHookBypassed?: (reason: "sse_streamed") => void;
}

/**
 * Outcome of a proxyAndRecord call, returned so the caller can decide whether
 * to journal, fall through, or stop — without sharing a mutable flag with the
 * `beforeWriteResponse` hook.
 *
 * - `"not_configured"` — no upstream URL for this provider; caller should fall
 *    through to its next branch (typically strict/404).
 * - `"relayed"` — the default code path wrote a response (upstream success or
 *    synthesized 502 error). Caller should journal the outcome.
 * - `"handled_by_hook"` — the hook wrote + journaled its own response. Caller
 *    should not double-journal.
 */
export type ProxyOutcome = "not_configured" | "relayed" | "handled_by_hook";

/**
 * Proxy an unmatched request to the real upstream provider, record the
 * response as a fixture on disk and in memory, then relay the response
 * back to the original client.
 */
export async function proxyAndRecord(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  request: ChatCompletionRequest,
  providerKey: RecordProviderKey,
  pathname: string,
  fixtures: Fixture[],
  defaults: {
    record?: RecordConfig;
    logger: Logger;
    requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest;
  },
  rawBody?: string,
  options?: ProxyOptions,
): Promise<ProxyOutcome> {
  const record = defaults.record;
  if (!record) return "not_configured";

  const providers = record.providers;
  const upstreamUrl = providers[providerKey];

  if (!upstreamUrl) {
    defaults.logger.warn(`No upstream URL configured for provider "${providerKey}" — cannot proxy`);
    return "not_configured";
  }

  const fixturePath = record.fixturePath ?? "./fixtures/recorded";
  let target: URL;
  try {
    target = resolveUpstreamUrl(upstreamUrl, pathname);
  } catch {
    defaults.logger.error(`Invalid upstream URL for provider "${providerKey}": ${upstreamUrl}`);
    writeErrorResponse(
      res,
      502,
      JSON.stringify({
        error: { message: `Invalid upstream URL: ${upstreamUrl}`, type: "proxy_error" },
      }),
    );
    return "relayed";
  }

  defaults.logger.warn(`NO FIXTURE MATCH — proxying to ${upstreamUrl}${pathname}`);

  // Forward all request headers except hop-by-hop and client-set ones.
  const forwardHeaders: Record<string, string> = {};
  for (const [name, val] of Object.entries(req.headers)) {
    if (val !== undefined && !STRIP_HEADERS.has(name)) {
      forwardHeaders[name] = Array.isArray(val) ? val.join(", ") : val;
    }
  }

  const requestBody = rawBody ?? JSON.stringify(request);

  // Make upstream request
  let upstreamStatus: number;
  let upstreamHeaders: http.IncomingHttpHeaders;
  let upstreamBody: string;
  let rawBuffer: Buffer;

  // Track whether we streamed SSE progressively to the client; if so,
  // skip the final res.writeHead/res.end relay at the bottom of this fn.
  let streamedToClient = false;
  try {
    const result = await makeUpstreamRequest(target, forwardHeaders, requestBody, res);
    upstreamStatus = result.status;
    upstreamHeaders = result.headers;
    upstreamBody = result.body;
    rawBuffer = result.rawBuffer;
    streamedToClient = result.streamedToClient;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown proxy error";
    defaults.logger.error(`Proxy request failed: ${msg}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `Proxy to upstream failed: ${msg}`, type: "proxy_error" },
      }),
    );
    return "relayed";
  }

  // Detect streaming response and collapse if necessary.
  // NOTE: collapse buffers the entire upstream body in memory. Fine for
  // current chat-completions traffic (responses are small), but revisit if
  // this path ever proxies long-lived or large streams — both the buffer
  // here and the hook below receive the full payload.
  const contentType = upstreamHeaders["content-type"];
  const ctString = Array.isArray(contentType) ? contentType.join(", ") : (contentType ?? "");
  const isBinaryStream = ctString.toLowerCase().includes("application/vnd.amazon.eventstream");
  const collapsed = collapseStreamingResponse(
    ctString,
    providerKey,
    isBinaryStream ? rawBuffer : upstreamBody,
    defaults.logger,
  );

  let fixtureResponse: FixtureResponse;

  // TTS response — binary audio, not JSON
  const isAudioResponse = ctString.toLowerCase().startsWith("audio/");
  if (isAudioResponse && rawBuffer.length > 0) {
    // Derive format from Content-Type (audio/mpeg→mp3, audio/opus→opus, etc.)
    const audioFormat = ctString
      .toLowerCase()
      .replace("audio/", "")
      .replace("mpeg", "mp3")
      .split(";")[0]
      .trim();
    fixtureResponse = {
      audio: rawBuffer.toString("base64"),
      ...(audioFormat && audioFormat !== "mp3" ? { format: audioFormat } : {}),
    };
  } else if (collapsed) {
    // Streaming response — use collapsed result
    defaults.logger.warn(`Streaming response detected (${ctString}) — collapsing to fixture`);
    if (collapsed.truncated) {
      defaults.logger.warn("Bedrock EventStream: CRC mismatch — response may be truncated");
    }
    if (collapsed.droppedChunks && collapsed.droppedChunks > 0) {
      defaults.logger.warn(`${collapsed.droppedChunks} chunk(s) dropped during stream collapse`);
    }
    if (collapsed.content === "" && (!collapsed.toolCalls || collapsed.toolCalls.length === 0)) {
      defaults.logger.warn("Stream collapse produced empty content — fixture may be incomplete");
    }
    if (collapsed.toolCalls && collapsed.toolCalls.length > 0) {
      if (collapsed.content) {
        defaults.logger.warn(
          "Collapsed response has both content and toolCalls — preferring toolCalls",
        );
      }
      fixtureResponse = { toolCalls: collapsed.toolCalls };
    } else {
      fixtureResponse = { content: collapsed.content ?? "" };
    }
  } else {
    // Non-streaming — try to parse as JSON
    let parsedResponse: unknown = null;
    try {
      parsedResponse = JSON.parse(upstreamBody);
    } catch {
      // Not JSON — could be an unknown format
      defaults.logger.warn("Upstream response is not valid JSON — saving as error fixture");
    }
    let encodingFormat: string | undefined;
    try {
      encodingFormat = rawBody ? JSON.parse(rawBody).encoding_format : undefined;
    } catch {
      /* not JSON */
    }
    fixtureResponse = buildFixtureResponse(parsedResponse, upstreamStatus, encodingFormat);
  }

  // Build the match criteria from the (optionally transformed) request
  const matchRequest = defaults.requestTransform ? defaults.requestTransform(request) : request;
  const fixtureMatch = buildFixtureMatch(matchRequest);

  // Build and save the fixture
  const fixture: Fixture = { match: fixtureMatch, response: fixtureResponse };

  // Check if the match is empty (all undefined values) — warn but still save to disk
  const matchValues = Object.values(fixtureMatch);
  const isEmptyMatch = matchValues.length === 0 || matchValues.every((v) => v === undefined);
  if (isEmptyMatch) {
    defaults.logger.warn(
      "Recorded fixture has empty match criteria — skipping in-memory registration",
    );
  }

  // In proxy-only mode, skip recording to disk and in-memory caching
  if (!defaults.record?.proxyOnly) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${providerKey}-${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`;
    const filepath = path.join(fixturePath, filename);

    let writtenToDisk = false;
    try {
      // Ensure fixture directory exists
      fs.mkdirSync(fixturePath, { recursive: true });

      // Collect warnings for the fixture file
      const warnings: string[] = [];
      if (isEmptyMatch) {
        warnings.push("Empty match criteria — this fixture will not match any request");
      }
      if (collapsed?.truncated) {
        warnings.push("Stream response was truncated — fixture may be incomplete");
      }

      // Auth headers are forwarded to upstream but excluded from saved fixtures for security.
      // NOTE: the persisted fixture is always the real upstream response, even when chaos
      // later mutates the relay (e.g. malformed via beforeWriteResponse). Chaos is a live-traffic
      // decoration; the recorded artifact must stay truthful so replay sees what upstream said.
      const fileContent: Record<string, unknown> = { fixtures: [fixture] };
      if (warnings.length > 0) {
        fileContent._warning = warnings.join("; ");
      }
      fs.writeFileSync(filepath, JSON.stringify(fileContent, null, 2), "utf-8");
      writtenToDisk = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown filesystem error";
      defaults.logger.error(`Failed to save fixture to disk: ${msg}`);
      res.setHeader("X-LLMock-Record-Error", msg);
    }

    if (writtenToDisk) {
      // Register in memory so subsequent identical requests match (skip if empty match)
      if (!isEmptyMatch) {
        fixtures.push(fixture);
      }
      defaults.logger.warn(`Response recorded → ${filepath}`);
    } else {
      defaults.logger.warn(`Response relayed but NOT saved to disk — see error above`);
    }
  } else {
    defaults.logger.info(`Proxied ${providerKey} request (proxy-only mode)`);
  }

  // Relay upstream response to client (skip when SSE was already streamed
  // progressively by makeUpstreamRequest — headers and body are already on
  // the wire).
  if (streamedToClient) {
    // SSE: the hook can't run because the body is already on the wire. Surface
    // the bypass so the caller (typically the chaos layer) can record it —
    // otherwise a configured chaos action silently no-ops on SSE traffic.
    if (options?.beforeWriteResponse && options.onHookBypassed) {
      options.onHookBypassed("sse_streamed");
    }
  } else {
    // Give the caller a chance to mutate or replace the response before relay.
    // Used by the chaos layer to turn a successful proxy into a malformed body.
    // `body` is the raw upstream bytes so binary payloads survive round-tripping.
    if (options?.beforeWriteResponse) {
      const handled = await options.beforeWriteResponse({
        status: upstreamStatus,
        contentType: ctString,
        body: rawBuffer,
      });
      if (handled) return "handled_by_hook";
    }

    const relayHeaders: Record<string, string> = {};
    if (ctString) {
      relayHeaders["Content-Type"] = ctString;
    }
    res.writeHead(upstreamStatus, relayHeaders);
    res.end(isBinaryStream ? rawBuffer : upstreamBody);
  }

  return "relayed";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeUpstreamRequest(
  target: URL,
  headers: Record<string, string>,
  body: string,
  clientRes?: http.ServerResponse,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  rawBuffer: Buffer;
  streamedToClient: boolean;
}> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const UPSTREAM_TIMEOUT_MS = 30_000;
    const BODY_TIMEOUT_MS = 30_000;
    const req = transport.request(
      target,
      {
        method: "POST",
        timeout: UPSTREAM_TIMEOUT_MS,
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        res.setTimeout(BODY_TIMEOUT_MS, () => {
          req.destroy(new Error(`Upstream response timed out after ${BODY_TIMEOUT_MS / 1000}s`));
        });
        // Detect Server-Sent Events so we can tee upstream chunks to the
        // client as they arrive rather than buffering the entire stream and
        // replaying it in a single res.end() at the bottom of proxyAndRecord.
        // Buffering collapses every SSE frame into one client-visible write,
        // which defeats progressive rendering in downstream consumers.
        const ct = res.headers["content-type"];
        const ctStr = Array.isArray(ct) ? ct.join(", ") : (ct ?? "");
        const isSSE = ctStr.toLowerCase().includes("text/event-stream");
        let streamedToClient = false;
        if (isSSE && clientRes && !clientRes.headersSent) {
          const relayHeaders: Record<string, string> = {};
          if (ctStr) relayHeaders["Content-Type"] = ctStr;
          clientRes.writeHead(res.statusCode ?? 200, relayHeaders);
          // Flush headers immediately so the client starts parsing frames
          // before the first data chunk arrives.
          if (typeof clientRes.flushHeaders === "function") clientRes.flushHeaders();
          streamedToClient = true;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          if (streamedToClient) clientRes!.write(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const rawBuffer = Buffer.concat(chunks);
          if (streamedToClient) clientRes!.end();
          resolve({
            status: res.statusCode ?? 500,
            headers: res.headers,
            body: rawBuffer.toString(),
            rawBuffer,
            streamedToClient,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(
        new Error(
          `Upstream request timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s: ${target.href}`,
        ),
      );
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Detect the response format from the parsed upstream JSON and convert
 * it into an aimock FixtureResponse.
 */
function buildFixtureResponse(
  parsed: unknown,
  status: number,
  encodingFormat?: string,
): FixtureResponse {
  if (parsed === null || parsed === undefined) {
    // Raw / unparseable response — save as error
    return {
      error: { message: "Upstream returned non-JSON response", type: "proxy_error" },
      status,
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Error response
  if (obj.error) {
    const err = obj.error as Record<string, unknown>;
    return {
      error: {
        message: String(err.message ?? "Unknown error"),
        type: String(err.type ?? "api_error"),
        code: err.code ? String(err.code) : undefined,
      },
      status,
    };
  }

  // OpenAI embeddings: { data: [{ embedding: [...] }] }
  if (Array.isArray(obj.data) && obj.data.length > 0) {
    const first = obj.data[0] as Record<string, unknown>;
    if (Array.isArray(first.embedding)) {
      return { embedding: first.embedding as number[] };
    }
    if (typeof first.embedding === "string" && encodingFormat === "base64") {
      try {
        const buf = Buffer.from(first.embedding, "base64");
        const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        return { embedding: Array.from(floats) };
      } catch {
        // Corrupted base64 or non-float32 data — fall through to error
      }
    }
    // OpenAI image generation: { created, data: [{ url, b64_json, revised_prompt }] }
    if (first.url || first.b64_json) {
      const images = (obj.data as Array<Record<string, unknown>>).map((item) => ({
        ...(item.url ? { url: String(item.url) } : {}),
        ...(item.b64_json ? { b64Json: String(item.b64_json) } : {}),
        ...(item.revised_prompt ? { revisedPrompt: String(item.revised_prompt) } : {}),
      }));
      if (images.length === 1) {
        return { image: images[0] };
      }
      return { images };
    }
  }

  // Gemini Imagen: { predictions: [...] }
  if (Array.isArray(obj.predictions)) {
    const images = (obj.predictions as Array<Record<string, unknown>>).map((p) => ({
      ...(p.bytesBase64Encoded ? { b64Json: String(p.bytesBase64Encoded) } : {}),
      ...(p.mimeType ? { mimeType: String(p.mimeType) } : {}),
    }));
    if (images.length === 1) {
      return { image: images[0] };
    }
    return { images };
  }

  // OpenAI transcription: { text: "...", ... }
  if (
    typeof obj.text === "string" &&
    (obj.task === "transcribe" || obj.language !== undefined || obj.duration !== undefined)
  ) {
    return {
      transcription: {
        text: obj.text as string,
        ...(obj.language ? { language: String(obj.language) } : {}),
        ...(obj.duration !== undefined ? { duration: Number(obj.duration) } : {}),
        ...(Array.isArray(obj.words) ? { words: obj.words } : {}),
        ...(Array.isArray(obj.segments) ? { segments: obj.segments } : {}),
      },
    };
  }

  // OpenAI video generation: { id, status, ... }
  if (
    typeof obj.id === "string" &&
    typeof obj.status === "string" &&
    (obj.status === "completed" || obj.status === "in_progress" || obj.status === "failed")
  ) {
    if (obj.status === "completed" && obj.url) {
      return {
        video: {
          id: String(obj.id),
          status: "completed" as const,
          url: String(obj.url),
        },
      };
    }
    return {
      video: {
        id: String(obj.id),
        status: obj.status === "failed" ? ("failed" as const) : ("processing" as const),
      },
    };
  }

  // Direct embedding: { embedding: [...] }
  if (Array.isArray(obj.embedding)) {
    return { embedding: obj.embedding as number[] };
  }

  // OpenAI chat completion: { choices: [{ message: { content, tool_calls } }] }
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    if (message) {
      // Tool calls
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const toolCalls: ToolCall[] = (message.tool_calls as Array<Record<string, unknown>>).map(
          (tc) => {
            const fn = tc.function as Record<string, unknown>;
            return {
              name: String(fn.name),
              arguments: String(fn.arguments),
            };
          },
        );
        return { toolCalls };
      }
      // Text content
      if (typeof message.content === "string") {
        return { content: message.content };
      }
    }
  }

  // Anthropic: { content: [{ type: "text", text: "..." }] } or tool_use
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const blocks = obj.content as Array<Record<string, unknown>>;
    // Check for tool_use blocks first
    const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
    if (toolUseBlocks.length > 0) {
      const toolCalls: ToolCall[] = toolUseBlocks.map((b) => ({
        name: String(b.name),
        arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
      }));
      return { toolCalls };
    }
    // Text blocks
    const textBlock = blocks.find((b) => b.type === "text");
    if (textBlock && typeof textBlock.text === "string") {
      return { content: textBlock.text };
    }
  }

  // Gemini: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const candidate = obj.candidates[0] as Record<string, unknown>;
    const content = candidate.content as Record<string, unknown> | undefined;
    if (content && Array.isArray(content.parts)) {
      const parts = content.parts as Array<Record<string, unknown>>;
      // Tool calls (functionCall)
      const fnCallParts = parts.filter((p) => p.functionCall);
      if (fnCallParts.length > 0) {
        const toolCalls: ToolCall[] = fnCallParts.map((p) => {
          const fc = p.functionCall as Record<string, unknown>;
          return {
            name: String(fc.name),
            arguments: typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args),
          };
        });
        return { toolCalls };
      }
      // Text
      const textPart = parts.find((p) => typeof p.text === "string");
      if (textPart && typeof textPart.text === "string") {
        return { content: textPart.text };
      }
    }
  }

  // Bedrock Converse: { output: { message: { role, content: [{ text }, { toolUse }] } } }
  if (obj.output && typeof obj.output === "object") {
    const output = obj.output as Record<string, unknown>;
    const msg = output.message as Record<string, unknown> | undefined;
    if (msg && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<Record<string, unknown>>;
      const toolUseBlocks = blocks.filter((b) => b.toolUse);
      if (toolUseBlocks.length > 0) {
        const toolCalls: ToolCall[] = toolUseBlocks.map((b) => {
          const tu = b.toolUse as Record<string, unknown>;
          return {
            name: String(tu.name ?? ""),
            arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input),
          };
        });
        return { toolCalls };
      }
      const textBlock = blocks.find((b) => typeof b.text === "string");
      if (textBlock && typeof textBlock.text === "string") {
        return { content: textBlock.text };
      }
    }
  }

  // Ollama: { message: { content: "...", tool_calls: [...] } }
  if (obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    // Tool calls (check before content — Ollama sends content: "" alongside tool_calls)
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const toolCalls: ToolCall[] = (msg.tool_calls as Array<Record<string, unknown>>)
        .filter((tc) => tc.function != null)
        .map((tc) => {
          const fn = tc.function as Record<string, unknown>;
          return {
            name: String(fn.name ?? ""),
            arguments:
              typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments),
          };
        });
      return { toolCalls };
    }
    if (typeof msg.content === "string" && msg.content.length > 0) {
      return { content: msg.content };
    }
    // Ollama message with content array (like Cohere)
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const first = msg.content[0] as Record<string, unknown>;
      if (typeof first.text === "string") {
        return { content: first.text };
      }
    }
  }

  // Fallback: unknown format — save as error
  return {
    error: {
      message: "Could not detect response format from upstream",
      type: "proxy_error",
    },
    status,
  };
}

/**
 * Derive fixture match criteria from the original request.
 */
type EndpointType = "chat" | "image" | "speech" | "transcription" | "video" | "embedding";

function buildFixtureMatch(request: ChatCompletionRequest): {
  userMessage?: string;
  inputText?: string;
  endpoint?: EndpointType;
} {
  const match: { userMessage?: string; inputText?: string; endpoint?: EndpointType } = {};

  // Include endpoint type for multimedia fixtures
  if (request._endpointType && request._endpointType !== "chat") {
    match.endpoint = request._endpointType as EndpointType;
  }

  // Embedding request
  if (request.embeddingInput) {
    match.inputText = request.embeddingInput;
    return match;
  }

  // Chat/multimedia request — match on the last user message
  const lastUser = getLastMessageByRole(request.messages ?? [], "user");
  if (lastUser) {
    const text = getTextContent(lastUser.content);
    if (text) {
      match.userMessage = text;
    }
  }

  return match;
}
