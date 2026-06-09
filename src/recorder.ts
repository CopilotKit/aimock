import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  ChatCompletionRequest,
  Fixture,
  FixtureMatch,
  FixtureResponse,
  RecordConfig,
  RecordedTimings,
  RecordProviderKey,
  ToolCall,
} from "./types.js";
import { getLastMessageByRole, getTextContent } from "./router.js";
import { normalizeModelName } from "./model-utils.js";
import type { Logger } from "./logger.js";
import { collapseStreamingResponse } from "./stream-collapse.js";
import { writeErrorResponse } from "./sse-writer.js";
import { resolveUpstreamUrl } from "./url.js";
import { getTestId, slugifyTestId } from "./helpers.js";
import { DEFAULT_TEST_ID } from "./constants.js";

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
   * client (SSE, NDJSON, or binary event streams) — the bytes are already on
   * the wire and can't be mutated.
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
  onHookBypassed?: (reason: "sse_streamed" | "ndjson_streamed" | "binary_streamed") => void;
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
 * Result of `persistFixture`:
 * - `"skipped"` — proxy-only mode; the caller has nothing else to do.
 * - `"written"` — fixture saved to `filepath` and (unless the match was empty)
 *    registered into the in-memory cache so the next identical request matches.
 * - `"failed"` — filesystem write failed. Caller decides how to surface it
 *    (e.g. setting `X-AIMock-Record-Error` on a relay response).
 */
export type PersistFixtureResult =
  | { kind: "skipped" }
  | { kind: "written"; filepath: string }
  | { kind: "failed"; error: string };

/**
 * Write a built fixture to disk (snapshot vs. timestamp file layout) and, when
 * the match is non-empty, register it in the in-memory cache so subsequent
 * identical requests match. Extracted from `proxyAndRecord` so the fal
 * queue-walk recorder (which makes multiple upstream calls before knowing the
 * final body) can share the same persistence behavior without re-implementing
 * snapshot-mode merging and warnings.
 */
export function persistFixture(opts: {
  record: RecordConfig;
  providerKey: RecordProviderKey;
  testId: string;
  fixture: Fixture;
  fixtures: Fixture[];
  warnings?: string[];
  logger: Logger;
}): PersistFixtureResult {
  const { record, providerKey, testId, fixture, fixtures, warnings = [], logger } = opts;

  // Match criteria with no userMessage / inputText / endpoint will not match
  // any future request — warn, then save to disk for inspection but skip the
  // in-memory registration so a defective fixture doesn't shadow real ones.
  // turnIndex/hasToolResult are pure multi-turn disambiguators on their own.
  const m = fixture.match;
  const isEmptyMatch =
    m.userMessage === undefined && m.inputText === undefined && m.endpoint === undefined;
  if (isEmptyMatch) {
    logger.warn("Recorded fixture has empty match criteria — skipping in-memory registration");
  }

  if (record.proxyOnly) {
    logger.info(`Proxied ${providerKey} request (proxy-only mode)`);
    return { kind: "skipped" };
  }

  const fixturePath = record.fixturePath ?? "./fixtures/recorded";
  let isSnapshotMode = testId !== DEFAULT_TEST_ID;
  let filepath: string;
  let mergeExisting = false;

  if (isSnapshotMode) {
    const slug = slugifyTestId(testId);
    if (!slug) {
      // Slug resolved to empty (e.g. testId was all punctuation) — fall back
      // to timestamp-based recording so we still capture the fixture.
      isSnapshotMode = false;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      filepath = path.join(
        fixturePath,
        `${providerKey}-${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`,
      );
    } else {
      filepath = path.join(fixturePath, slug, `${providerKey}.json`);
      mergeExisting = true;
    }
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const timestampFile = `${providerKey}-${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`;
    filepath = fixture.match.context
      ? path.join(fixturePath, fixture.match.context, timestampFile)
      : path.join(fixturePath, timestampFile);
  }

  const fileWarnings = [
    ...(isEmptyMatch ? ["Empty match criteria — this fixture will not match any request"] : []),
    ...warnings,
  ];

  try {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });

    // Auth headers are forwarded to upstream but excluded from saved fixtures.
    // The persisted fixture is always the real upstream response, even when
    // chaos later mutates the relay; replay must see what upstream said.
    let fileContent: { fixtures: unknown[]; _warning?: string };
    if (mergeExisting && fs.existsSync(filepath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filepath, "utf-8"));
        fileContent = { fixtures: [...(existing.fixtures ?? []), fixture] };
      } catch (mergeErr) {
        const msg = mergeErr instanceof Error ? mergeErr.message : "unknown";
        logger.warn(`Could not read existing fixture file ${filepath} (${msg}) — overwriting`);
        fileContent = { fixtures: [fixture] };
      }
    } else {
      fileContent = { fixtures: [fixture] };
    }
    if (fileWarnings.length > 0) {
      fileContent._warning = fileWarnings.join("; ");
    }
    // Atomic write: write to temp file then rename to avoid read-modify-write
    // races. Keep synchronous — for streamed responses the HTTP reply is
    // already on the wire, so async writes would race with callers checking
    // the filesystem before the fixture has landed.
    const tmpPath = filepath + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(fileContent, null, 2), "utf-8");
    fs.renameSync(tmpPath, filepath);

    if (!isEmptyMatch) {
      fixtures.push(fixture);
    }
    logger.warn(`Response recorded → ${filepath}`);
    return { kind: "written", filepath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown filesystem error";
    logger.error(`Failed to save fixture to disk: ${msg}`);
    return { kind: "failed", error: msg };
  }
}

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
  // Gemini Interactions uses the same upstream API as Gemini (identical base URL
  // and auth), so we remap the provider key to reuse the configured Gemini URL.
  const lookupKey = providerKey === "gemini-interactions" ? "gemini" : providerKey;
  const upstreamUrl = providers[lookupKey];

  if (!upstreamUrl) {
    defaults.logger.warn(`No upstream URL configured for provider "${providerKey}" — cannot proxy`);
    return "not_configured";
  }

  let target: URL;
  try {
    target = resolveUpstreamUrl(upstreamUrl, pathname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    defaults.logger.error(
      `Invalid upstream URL for provider "${providerKey}": ${upstreamUrl} (${msg})`,
    );
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
  let clientDisconnected = false;
  let frameTimestamps: number[] = [];
  let streamStartTime = 0;
  try {
    const result = await makeUpstreamRequest(
      target,
      forwardHeaders,
      requestBody,
      res,
      req.method,
      defaults.logger,
      { upstreamTimeoutMs: record.upstreamTimeoutMs, bodyTimeoutMs: record.bodyTimeoutMs },
    );
    upstreamStatus = result.status;
    upstreamHeaders = result.headers;
    upstreamBody = result.body;
    rawBuffer = result.rawBuffer;
    streamedToClient = result.streamedToClient;
    clientDisconnected = result.clientDisconnected;
    frameTimestamps = result.frameTimestamps;
    streamStartTime = result.streamStartTime;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown proxy error";
    defaults.logger.error(`Proxy request failed: ${msg}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `Proxy to upstream failed: ${msg}`, type: "proxy_error" },
        }),
      );
    } else {
      // SSE headers already sent — gracefully close the connection
      res.end();
    }
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
      defaults.logger.warn(
        `${collapsed.droppedChunks} chunk(s) dropped during stream collapse${collapsed.firstDroppedSample ? ` — first: ${collapsed.firstDroppedSample}` : ""}`,
      );
    }
    if (collapsed.harmonyUnparsed) {
      defaults.logger.warn(
        `Harmony tokens present but unparseable — content preserved verbatim${collapsed.harmonyNote ? ` (${collapsed.harmonyNote})` : ""}`,
      );
    }
    // Audio from streamed inlineData (e.g. Gemini SSE with audio parts).
    // A single Gemini turn can interleave audio with a functionCall and/or
    // text/thought parts; preserve those companion modalities so the tool call
    // / content / reasoning are not silently dropped when audio is present.
    if (collapsed.audioB64) {
      const audioToolCallsSpread =
        collapsed.toolCalls && collapsed.toolCalls.length > 0
          ? {
              toolCalls: collapsed.toolCalls.map((tc) => ({
                ...tc,
                name: tc.name ?? "",
                arguments: tc.arguments ?? "{}",
              })),
            }
          : {};
      const audioContentSpread = collapsed.content ? { content: collapsed.content } : {};
      const audioReasoningSpread = collapsed.reasoning ? { reasoning: collapsed.reasoning } : {};
      fixtureResponse = {
        audio: {
          b64Json: collapsed.audioB64,
          contentType: collapsed.audioMimeType ?? "audio/mpeg",
        },
        ...audioToolCallsSpread,
        ...audioContentSpread,
        ...audioReasoningSpread,
      };
    } else if (
      collapsed.content === "" &&
      (!collapsed.toolCalls || collapsed.toolCalls.length === 0)
    ) {
      defaults.logger.warn("Stream collapse produced empty content — fixture may be incomplete");
      const reasoningSpread = collapsed.reasoning ? { reasoning: collapsed.reasoning } : {};
      // Carry the real Anthropic thinking-block signature only when reasoning is
      // also present (a bare signature has nothing to attach to on replay), so a
      // recorded thinking turn replays its actual signature instead of the
      // round-trip-safe placeholder.
      const reasoningSignatureSpread =
        collapsed.reasoning && collapsed.reasoningSignature
          ? { reasoningSignature: collapsed.reasoningSignature }
          : {};
      const webSearchesSpread = collapsed.webSearches?.length
        ? { webSearches: collapsed.webSearches }
        : {};
      fixtureResponse = {
        content: collapsed.content ?? "",
        ...reasoningSpread,
        ...reasoningSignatureSpread,
        ...webSearchesSpread,
      };
    } else {
      const reasoningSpread = collapsed.reasoning ? { reasoning: collapsed.reasoning } : {};
      // Carry the real Anthropic thinking-block signature only when reasoning is
      // also present; see the empty-content branch above.
      const reasoningSignatureSpread =
        collapsed.reasoning && collapsed.reasoningSignature
          ? { reasoningSignature: collapsed.reasoningSignature }
          : {};
      const webSearchesSpread = collapsed.webSearches?.length
        ? { webSearches: collapsed.webSearches }
        : {};
      if (collapsed.toolCalls && collapsed.toolCalls.length > 0) {
        const sanitizedToolCalls = collapsed.toolCalls.map((tc) => ({
          ...tc,
          name: tc.name ?? "",
          arguments: tc.arguments ?? "{}",
        }));
        if (collapsed.content) {
          // Both content and toolCalls present — save as ContentWithToolCallsResponse
          fixtureResponse = {
            content: collapsed.content,
            toolCalls: sanitizedToolCalls,
            ...reasoningSpread,
            ...reasoningSignatureSpread,
            ...webSearchesSpread,
          };
        } else {
          fixtureResponse = {
            toolCalls: sanitizedToolCalls,
            ...reasoningSpread,
            ...reasoningSignatureSpread,
            ...webSearchesSpread,
          };
        }
      } else {
        fixtureResponse = {
          content: collapsed.content ?? "",
          ...reasoningSpread,
          ...reasoningSignatureSpread,
          ...webSearchesSpread,
        };
      }
    }
  } else {
    // Non-streaming — try to parse as JSON
    let parsedResponse: unknown = null;
    try {
      parsedResponse = JSON.parse(upstreamBody);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : "unknown";
      defaults.logger.warn(
        `Upstream response is not valid JSON (${msg}) — saving as error fixture`,
      );
    }
    // fal.ai returns arbitrary, model-specific JSON shapes (images, video URLs,
    // audio file objects, etc.). Round-trip the payload verbatim instead of
    // letting buildFixtureResponse mis-classify it as ImageResponse / VideoResponse.
    if (request._endpointType === "fal" && parsedResponse !== null) {
      const obj = parsedResponse as Record<string, unknown>;
      const isErrorShape =
        typeof obj.error === "object" &&
        obj.error !== null &&
        typeof (obj.error as Record<string, unknown>).message === "string";
      if (isErrorShape) {
        const err = obj.error as Record<string, unknown>;
        fixtureResponse = {
          error: {
            message: String(err.message ?? "Unknown error"),
            type: String(err.type ?? "api_error"),
            code: err.code ? String(err.code) : undefined,
          },
          status: upstreamStatus,
        };
      } else {
        fixtureResponse = { json: parsedResponse, status: upstreamStatus };
      }
    } else {
      let encodingFormat: string | undefined;
      try {
        encodingFormat = rawBody ? JSON.parse(rawBody).encoding_format : undefined;
      } catch (err) {
        defaults.logger.debug(
          `Could not parse encoding_format from raw body: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }
      fixtureResponse = buildFixtureResponse(parsedResponse, upstreamStatus, encodingFormat);
    }
  }

  // If the client disconnected mid-stream, the collected data is likely
  // truncated.  Saving a partial fixture is worse than saving none — skip
  // fixture persistence entirely.
  if (clientDisconnected) {
    defaults.logger.warn(
      "Client disconnected mid-stream — skipping fixture save to avoid truncated data",
    );
    return "relayed";
  }

  // Build RecordedTimings from frame timestamps captured during streaming.
  // Requires at least 2 timestamps (first frame + at least one more) to
  // produce meaningful timing data.
  let recordedTimings: RecordedTimings | undefined;
  if (frameTimestamps.length > 1) {
    const ts = frameTimestamps;
    recordedTimings = {
      ttftMs: ts[0] - streamStartTime,
      interChunkDelaysMs: ts.slice(1).map((t, i) => t - ts[i]),
      totalDurationMs: ts[ts.length - 1] - streamStartTime,
    };
  }

  const matchRequest = defaults.requestTransform ? defaults.requestTransform(request) : request;
  const metadata = buildFixtureMetadata(request);
  const fixture: Fixture = {
    match: buildFixtureMatch(matchRequest, defaults.record),
    response: fixtureResponse,
    ...(recordedTimings && { recordedTimings }),
    ...(metadata && { metadata }),
  };

  const persistWarnings: string[] = [];
  if (collapsed?.truncated) {
    persistWarnings.push("Stream response was truncated — fixture may be incomplete");
  }
  const persistResult = persistFixture({
    record,
    providerKey,
    testId: getTestId(req),
    fixture,
    fixtures,
    warnings: persistWarnings,
    logger: defaults.logger,
  });
  if (persistResult.kind === "failed") {
    if (!res.headersSent) {
      res.setHeader("X-AIMock-Record-Error", persistResult.error);
    } else {
      defaults.logger.warn(`Cannot set X-AIMock-Record-Error header — headers already sent`);
    }
    defaults.logger.warn(`Response relayed but NOT saved to disk — see error above`);
  }

  // Relay upstream response to client (skip when the response was already
  // streamed progressively by makeUpstreamRequest — headers and body are
  // already on the wire).
  if (streamedToClient) {
    // The hook can't run because the body is already on the wire. Surface
    // the bypass so the caller (typically the chaos layer) can record it —
    // otherwise a configured chaos action silently no-ops on streamed traffic.
    if (options?.beforeWriteResponse && options.onHookBypassed) {
      const bypassReason: "sse_streamed" | "ndjson_streamed" | "binary_streamed" = isBinaryStream
        ? "binary_streamed"
        : ctString.toLowerCase().includes("application/x-ndjson")
          ? "ndjson_streamed"
          : "sse_streamed";
      try {
        options.onHookBypassed(bypassReason);
      } catch (err) {
        defaults.logger.warn(
          `onHookBypassed callback threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    // Give the caller a chance to mutate or replace the response before relay.
    // Used by the chaos layer to turn a successful proxy into a malformed body.
    // `body` is the raw upstream bytes so binary payloads survive round-tripping.
    if (options?.beforeWriteResponse) {
      let handled: boolean | undefined;
      try {
        handled = await options.beforeWriteResponse({
          status: upstreamStatus,
          contentType: ctString,
          body: rawBuffer,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`beforeWriteResponse hook failed for ${providerKey}: ${msg}`);
      }
      if (handled) return "handled_by_hook";
    }

    // Normalize status codes for the client: aimock acts as a gateway, so
    // upstream provider details (429 rate-limits, 503 outages, etc.) should
    // not leak. Successes → 200, errors → 502 (Bad Gateway).
    const clientStatus = upstreamStatus >= 200 && upstreamStatus < 300 ? 200 : 502;
    const isAudioRelay = ctString.toLowerCase().startsWith("audio/");
    // When an upstream error (non-2xx) is relayed for an audio endpoint, the
    // body is typically a JSON error object — override the content-type so
    // clients don't try to decode JSON as audio.
    const relayHeaders: Record<string, string> = {};
    const clientCt =
      (clientStatus >= 200 && clientStatus < 300) || !isAudioRelay
        ? ctString || "application/json"
        : "application/json";
    if (clientCt) {
      relayHeaders["Content-Type"] = clientCt;
    }
    res.writeHead(clientStatus, relayHeaders);
    res.end(isBinaryStream || isAudioRelay ? rawBuffer : upstreamBody);
  }

  return "relayed";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Decodes a sequence of byte chunks to UTF-8 text for SSE/NDJSON frame
 * splitting on the streamed-capture path. Wraps Node's StringDecoder so a
 * multibyte UTF-8 character (CJK, emoji, ...) whose bytes are split across a
 * TCP chunk boundary buffers across chunks instead of decoding to U+FFFD
 * replacement characters — decoding each chunk independently with
 * Buffer#toString() would corrupt the recorded frame text.
 */
export class StreamingFrameDecoder {
  private decoder = new StringDecoder("utf8");
  /** Decode a chunk, holding back any trailing partial multibyte sequence. */
  write(chunk: Buffer): string {
    return this.decoder.write(chunk);
  }
  /** Flush any buffered bytes once the stream has ended. */
  end(): string {
    return this.decoder.end();
  }
}

function clampTimeout(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function makeUpstreamRequest(
  target: URL,
  headers: Record<string, string>,
  body: string,
  clientRes?: http.ServerResponse,
  method: string = "POST",
  logger?: Logger,
  timeouts?: Pick<RecordConfig, "upstreamTimeoutMs" | "bodyTimeoutMs">,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  rawBuffer: Buffer;
  streamedToClient: boolean;
  clientDisconnected: boolean;
  frameTimestamps: number[];
  streamStartTime: number;
}> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const UPSTREAM_TIMEOUT_MS = clampTimeout(timeouts?.upstreamTimeoutMs, 30_000);
    const BODY_TIMEOUT_MS = clampTimeout(timeouts?.bodyTimeoutMs, 30_000);
    const req = transport.request(
      target,
      {
        method,
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
        // Detect streaming content types so we can tee upstream chunks to the
        // client as they arrive rather than buffering the entire stream and
        // replaying it in a single res.end() at the bottom of proxyAndRecord.
        // Buffering collapses every frame into one client-visible write,
        // which defeats progressive rendering in downstream consumers and
        // can trip HTTP idle timeouts on slow calls.
        const ct = res.headers["content-type"];
        const ctStr = Array.isArray(ct) ? ct.join(", ") : (ct ?? "");
        const ctLower = ctStr.toLowerCase();
        const isSSE = ctLower.includes("text/event-stream");
        const isNDJSON = ctLower.includes("application/x-ndjson");
        const isBinaryEventStream = ctLower.includes("application/vnd.amazon.eventstream");
        const isProgressiveStream = isSSE || isNDJSON || isBinaryEventStream;
        // SSE/NDJSON frame timing capture — timestamps each complete frame
        // so proxyAndRecord can build RecordedTimings for the fixture.
        const frameTimestamps: number[] = [];
        const streamStartTime = Date.now();
        let frameBuffer = "";
        // Decode chunks through a streaming-aware decoder so a multibyte UTF-8
        // character split across a TCP chunk boundary buffers across chunks
        // instead of decoding to U+FFFD replacement characters.
        const frameDecoder = new StreamingFrameDecoder();
        let binaryFrameBuffer = Buffer.alloc(0);

        let streamedToClient = false;
        let clientDisconnected = false;
        if (isProgressiveStream && clientRes && !clientRes.headersSent) {
          const relayHeaders: Record<string, string> = {
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          };
          if (ctStr) relayHeaders["Content-Type"] = ctStr;
          // Normalize status codes for the client: aimock acts as a gateway,
          // so upstream provider details should not leak.
          // Successes → 200, errors → 502 (Bad Gateway).
          const rawStatus = res.statusCode ?? 200;
          const clientStatus = rawStatus >= 200 && rawStatus < 300 ? 200 : 502;
          clientRes.writeHead(clientStatus, relayHeaders);
          // Flush headers immediately so the client starts parsing frames
          // before the first data chunk arrives.
          if (typeof clientRes.flushHeaders === "function") clientRes.flushHeaders();
          streamedToClient = true;
          // Stop relaying if the client disconnects mid-stream.
          // Check writableFinished to distinguish normal completion (where
          // "close" also fires) from premature client disconnects.
          clientRes.on("close", () => {
            if (!clientRes.writableFinished) {
              clientDisconnected = true;
              req.destroy();
            }
          });
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);

          // Capture per-frame timestamps for SSE/NDJSON streams.
          // TCP data events don't align with SSE frames — buffer and
          // split on the protocol delimiter to timestamp each complete frame.
          if (isSSE || isNDJSON) {
            frameBuffer += frameDecoder.write(chunk);
            // Split on the protocol delimiter, tolerating CRLF line endings.
            // The SSE spec permits CRLF, and some upstreams/proxies emit
            // \r\n\r\n (SSE) or \r\n (NDJSON) frame boundaries. An LF-only
            // split would see the whole CRLF stream as a single frame and
            // lose per-frame timing. The last split element (a partial frame
            // tail) stays buffered, exactly as with a string delimiter.
            const delimiter = isNDJSON ? /\r?\n/ : /\r?\n\r?\n/;
            const parts = frameBuffer.split(delimiter);
            // All complete frames (everything except the last part which
            // may be incomplete).
            for (let fi = 0; fi < parts.length - 1; fi++) {
              if (parts[fi].trim().length > 0) {
                frameTimestamps.push(Date.now());
              }
            }
            // Last part stays in buffer (may be incomplete)
            frameBuffer = parts[parts.length - 1];
          }

          // Binary EventStream frame boundary detection — parse the 4-byte
          // total-length prefix to detect complete frames without decoding
          // frame contents (CRC validation happens in stream-collapse).
          if (isBinaryEventStream) {
            binaryFrameBuffer = Buffer.concat([binaryFrameBuffer, chunk]);
            while (binaryFrameBuffer.length >= 4) {
              const totalLen = binaryFrameBuffer.readUInt32BE(0);
              if (totalLen < 12 || binaryFrameBuffer.length < totalLen) break;
              frameTimestamps.push(Date.now());
              binaryFrameBuffer = binaryFrameBuffer.subarray(totalLen);
            }
          }

          if (
            streamedToClient &&
            clientRes &&
            !clientDisconnected &&
            !clientRes.destroyed &&
            !clientRes.writableEnded
          ) {
            try {
              clientRes.write(chunk);
            } catch (writeErr) {
              logger?.debug(
                `Failed to relay chunk to client: ${writeErr instanceof Error ? writeErr.message : "unknown"}`,
              );
              clientDisconnected = true;
            }
          }
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.socket) res.setTimeout(0);
          // Flush remaining text frame buffer — captures the last frame if
          // the stream ended without a trailing delimiter. Binary EventStream
          // frames are length-prefixed so partial frames at end-of-stream are
          // genuinely incomplete and should not be timestamped.
          if (isSSE || isNDJSON) {
            // Drain any bytes the decoder buffered for an incomplete multibyte
            // sequence so the final frame text is complete before we test it.
            frameBuffer += frameDecoder.end();
            if (frameBuffer.trim().length > 0) {
              frameTimestamps.push(Date.now());
            }
          }
          const rawBuffer = Buffer.concat(chunks);
          if (
            streamedToClient &&
            clientRes &&
            !clientDisconnected &&
            !clientRes.destroyed &&
            !clientRes.writableEnded
          ) {
            try {
              clientRes.end();
            } catch (endErr) {
              logger?.debug(
                `Failed to end client response: ${endErr instanceof Error ? endErr.message : "unknown"}`,
              );
            }
          }
          resolve({
            status: res.statusCode ?? 500,
            headers: res.headers,
            body: rawBuffer.toString(),
            rawBuffer,
            streamedToClient,
            clientDisconnected,
            frameTimestamps,
            streamStartTime,
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

  // Error response — only match the actual { error: { message: "..." } } shape
  // used by OpenAI/Anthropic/etc., not arbitrary truthy `.error` fields.
  if (
    typeof obj.error === "object" &&
    obj.error !== null &&
    typeof (obj.error as Record<string, unknown>).message === "string"
  ) {
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
      const buf = Buffer.from(first.embedding, "base64");
      if (buf.byteLength % 4 !== 0) {
        // Malformed embedding — return a zero-dimension embedding fixture
        return { embedding: [] };
      }
      // Uint8Array constructor copies Buffer data to a fresh ArrayBuffer at offset 0,
      // guaranteeing the alignment Float32Array requires.
      const copied = new Uint8Array(buf);
      const floats = new Float32Array(copied.buffer, 0, buf.byteLength / 4);
      return { embedding: Array.from(floats) };
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

  // Gemini Interactions: { id, status, outputs: [{ type: "text", text }, { type: "function_call", name, arguments }] }
  if (
    Array.isArray(obj.outputs) &&
    obj.outputs.length > 0 &&
    !("choices" in obj) &&
    !("content" in obj) &&
    !("candidates" in obj)
  ) {
    const outputs = obj.outputs as Array<Record<string, unknown>>;
    const fnCallOutputs = outputs.filter((o) => o.type === "function_call");
    const textOutputs = outputs.filter((o) => o.type === "text" && typeof o.text === "string");
    const hasToolCalls = fnCallOutputs.length > 0;
    const joinedText = textOutputs.map((o) => String(o.text ?? "")).join("");
    const hasContent = joinedText.length > 0;

    if (hasToolCalls) {
      const toolCalls: ToolCall[] = fnCallOutputs.map((o) => ({
        name: String(o.name),
        arguments: typeof o.arguments === "string" ? o.arguments : JSON.stringify(o.arguments),
        ...(o.id ? { id: String(o.id) } : {}),
      }));
      if (hasContent) {
        return { content: joinedText, toolCalls };
      }
      return { toolCalls };
    }
    if (hasContent) {
      return { content: joinedText };
    }
    // Recognized Gemini Interactions shape but empty content
    return { content: "" };
  }

  // OpenAI video generation: { id, status, ... }
  // Guard against false positives: many API responses have `id` + `status` fields
  // (e.g. chat completions, Anthropic messages). Reject if the response has fields
  // that indicate a known non-video format.
  if (
    typeof obj.id === "string" &&
    typeof obj.status === "string" &&
    (obj.status === "completed" || obj.status === "in_progress" || obj.status === "failed") &&
    !("choices" in obj) &&
    !("content" in obj) &&
    !("candidates" in obj) &&
    !("message" in obj) &&
    !("data" in obj) &&
    !("object" in obj) &&
    !("outputs" in obj) &&
    !("model" in obj) &&
    !("response" in obj) &&
    !("done" in obj) &&
    !("usage" in obj) &&
    !("error" in obj)
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
      const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      const hasContent = typeof message.content === "string" && message.content.length > 0;

      const openaiReasoning =
        typeof message.reasoning_content === "string" && message.reasoning_content.length > 0
          ? message.reasoning_content
          : undefined;

      if (hasToolCalls) {
        const toolCalls: ToolCall[] = (message.tool_calls as Array<Record<string, unknown>>).map(
          (tc) => {
            const fn = tc.function as Record<string, unknown>;
            return {
              name: String(fn.name),
              arguments: String(fn.arguments),
              ...(tc.id ? { id: String(tc.id) } : {}),
            };
          },
        );
        if (hasContent) {
          return {
            content: message.content as string,
            toolCalls,
            ...(openaiReasoning ? { reasoning: openaiReasoning } : {}),
          };
        }
        return { toolCalls, ...(openaiReasoning ? { reasoning: openaiReasoning } : {}) };
      }
      // Text content only
      if (hasContent) {
        return {
          content: message.content as string,
          ...(openaiReasoning ? { reasoning: openaiReasoning } : {}),
        };
      }
      // Recognized OpenAI shape but empty content (e.g. content filtering, zero max_tokens)
      return { content: "", ...(openaiReasoning ? { reasoning: openaiReasoning } : {}) };
    }
  }

  // Anthropic: { content: [{ type: "text", text: "..." }] } or tool_use
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const blocks = obj.content as Array<Record<string, unknown>>;
    const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
    const textBlocks = blocks.filter((b) => b.type === "text" && typeof b.text === "string");
    const thinkingBlocks = blocks.filter((b) => b.type === "thinking");
    const hasToolCalls = toolUseBlocks.length > 0;
    const joinedText = textBlocks.map((b) => String(b.text ?? "")).join("");
    const hasContent = joinedText.length > 0;
    const anthropicReasoning =
      thinkingBlocks.length > 0
        ? thinkingBlocks.map((b) => String(b.thinking ?? "")).join("")
        : undefined;

    if (hasToolCalls) {
      const toolCalls: ToolCall[] = toolUseBlocks.map((b) => ({
        name: String(b.name),
        arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
        ...(b.id ? { id: String(b.id) } : {}),
      }));
      if (hasContent) {
        return {
          content: joinedText,
          toolCalls,
          ...(anthropicReasoning ? { reasoning: anthropicReasoning } : {}),
        };
      }
      return { toolCalls, ...(anthropicReasoning ? { reasoning: anthropicReasoning } : {}) };
    }
    if (hasContent) {
      return {
        content: joinedText,
        ...(anthropicReasoning ? { reasoning: anthropicReasoning } : {}),
      };
    }
    // Thinking-only response (no text, no tool calls)
    if (anthropicReasoning) {
      return { content: "", reasoning: anthropicReasoning };
    }
  }

  // Gemini: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const candidate = obj.candidates[0] as Record<string, unknown>;
    const content = candidate.content as Record<string, unknown> | undefined;
    if (content && Array.isArray(content.parts)) {
      const parts = content.parts as Array<Record<string, unknown>>;

      // Audio inlineData parts take priority over text
      const audioParts = parts.filter(
        (p: Record<string, unknown>) =>
          p.inlineData &&
          typeof (p.inlineData as Record<string, unknown>).mimeType === "string" &&
          ((p.inlineData as Record<string, unknown>).mimeType as string).startsWith("audio/"),
      );
      if (audioParts.length > 0) {
        const inlineData = audioParts[0].inlineData as Record<string, unknown>;
        return {
          audio: {
            b64Json: String(inlineData.data ?? ""),
            contentType: String(inlineData.mimeType),
          },
        };
      }

      const fnCallParts = parts.filter((p) => p.functionCall);
      const textParts = parts.filter((p) => typeof p.text === "string" && !p.thought);
      const thoughtParts = parts.filter((p) => p.thought === true && typeof p.text === "string");
      const hasToolCalls = fnCallParts.length > 0;
      const joinedText = textParts.map((p) => String(p.text ?? "")).join("");
      const hasContent = joinedText.length > 0;
      const geminiReasoning =
        thoughtParts.length > 0
          ? thoughtParts.map((p) => String(p.text ?? "")).join("")
          : undefined;

      if (hasToolCalls) {
        const toolCalls: ToolCall[] = fnCallParts.map((p) => {
          const fc = p.functionCall as Record<string, unknown>;
          return {
            name: String(fc.name),
            arguments: typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args),
          };
        });
        if (hasContent) {
          return {
            content: joinedText,
            toolCalls,
            ...(geminiReasoning ? { reasoning: geminiReasoning } : {}),
          };
        }
        return { toolCalls, ...(geminiReasoning ? { reasoning: geminiReasoning } : {}) };
      }
      if (hasContent) {
        return {
          content: joinedText,
          ...(geminiReasoning ? { reasoning: geminiReasoning } : {}),
        };
      }
      // Recognized Gemini shape but empty content
      return { content: "", ...(geminiReasoning ? { reasoning: geminiReasoning } : {}) };
    }
  }

  // Bedrock Converse: { output: { message: { role, content: [{ text }, { toolUse }] } } }
  if (obj.output && typeof obj.output === "object") {
    const output = obj.output as Record<string, unknown>;
    const msg = output.message as Record<string, unknown> | undefined;
    if (msg && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<Record<string, unknown>>;
      const toolUseBlocks = blocks.filter((b) => b.toolUse);
      const textBlocks = blocks.filter((b) => typeof b.text === "string");
      const reasoningBlocks = blocks.filter((b) => b.reasoningContent);
      const hasToolCalls = toolUseBlocks.length > 0;
      const joinedText = textBlocks.map((b) => String(b.text ?? "")).join("");
      const hasContent = joinedText.length > 0;
      const bedrockReasoning =
        reasoningBlocks.length > 0
          ? reasoningBlocks
              .map((b) => {
                const rc = b.reasoningContent as Record<string, unknown>;
                const rt = rc?.reasoningText as Record<string, unknown> | undefined;
                return String(rt?.text ?? "");
              })
              .join("")
          : undefined;

      if (hasToolCalls) {
        const toolCalls: ToolCall[] = toolUseBlocks.map((b) => {
          const tu = b.toolUse as Record<string, unknown>;
          return {
            name: String(tu.name ?? ""),
            arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input),
            ...(tu.toolUseId ? { id: String(tu.toolUseId) } : {}),
          };
        });
        if (hasContent) {
          return {
            content: joinedText,
            toolCalls,
            ...(bedrockReasoning ? { reasoning: bedrockReasoning } : {}),
          };
        }
        return { toolCalls, ...(bedrockReasoning ? { reasoning: bedrockReasoning } : {}) };
      }
      if (hasContent) {
        return {
          content: joinedText,
          ...(bedrockReasoning ? { reasoning: bedrockReasoning } : {}),
        };
      }
      // Recognized Bedrock Converse shape but empty content
      return { content: "", ...(bedrockReasoning ? { reasoning: bedrockReasoning } : {}) };
    }
  }

  // Cohere v2 chat: { finish_reason: "...", message: { content: [{ type: "text", text: "..." }] } }
  // Must come before Ollama since both have `message`, but Cohere has `finish_reason` at top level
  // (not nested in `choices`) and `message.content` as an array of typed objects.
  if (
    typeof obj.finish_reason === "string" &&
    obj.message &&
    typeof obj.message === "object" &&
    Array.isArray((obj.message as Record<string, unknown>).content)
  ) {
    const msg = obj.message as Record<string, unknown>;
    const contentBlocks = msg.content as Array<Record<string, unknown>>;
    const textBlock = contentBlocks.find((b) => b.type === "text" && typeof b.text === "string");
    const hasContent = textBlock && typeof textBlock.text === "string" && textBlock.text.length > 0;
    const toolCallBlocks = contentBlocks.filter((b) => b.type === "tool_call");

    // Also check message-level tool_calls (Cohere v2 puts tool calls here, not in content blocks)
    const msgToolCalls = Array.isArray(msg.tool_calls)
      ? (msg.tool_calls as Array<Record<string, unknown>>)
      : [];

    if (toolCallBlocks.length > 0) {
      const toolCalls: ToolCall[] = toolCallBlocks.map((b) => ({
        name: String(b.name ?? (b.function as Record<string, unknown>)?.name ?? ""),
        arguments:
          typeof b.parameters === "string"
            ? b.parameters
            : typeof b.parameters === "object"
              ? JSON.stringify(b.parameters)
              : typeof (b.function as Record<string, unknown>)?.arguments === "string"
                ? String((b.function as Record<string, unknown>).arguments)
                : JSON.stringify((b.function as Record<string, unknown>)?.arguments),
        ...(b.id ? { id: String(b.id) } : {}),
      }));
      if (hasContent) {
        return { content: textBlock.text as string, toolCalls };
      }
      return { toolCalls };
    }
    if (msgToolCalls.length > 0) {
      const toolCalls: ToolCall[] = msgToolCalls.map((tc) => {
        const fn = tc.function as Record<string, unknown> | undefined;
        return {
          name: String(tc.name ?? fn?.name ?? ""),
          arguments:
            typeof tc.parameters === "string"
              ? tc.parameters
              : typeof tc.parameters === "object"
                ? JSON.stringify(tc.parameters)
                : typeof fn?.arguments === "string"
                  ? String(fn.arguments)
                  : JSON.stringify(fn?.arguments),
          ...(tc.id ? { id: String(tc.id) } : {}),
        };
      });
      if (hasContent) {
        return { content: textBlock.text as string, toolCalls };
      }
      return { toolCalls };
    }
    if (hasContent) {
      return { content: textBlock.text as string };
    }
  }

  // Ollama: { message: { content: "...", tool_calls: [...] } }
  if (obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    const hasOllamaToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const hasOllamaContent = typeof msg.content === "string" && msg.content.length > 0;

    if (hasOllamaToolCalls) {
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
      if (hasOllamaContent) {
        return { content: msg.content as string, toolCalls };
      }
      return { toolCalls };
    }
    if (hasOllamaContent) {
      return { content: msg.content as string };
    }
    // Ollama message with content array (like Cohere)
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const first = msg.content[0] as Record<string, unknown>;
      if (typeof first.text === "string") {
        return { content: first.text };
      }
    }
  }

  // Ollama /api/generate: { response: "...", done: true/false }
  if (typeof obj.response === "string" && "done" in obj) {
    return { content: obj.response };
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
type EndpointType = NonNullable<FixtureMatch["endpoint"]>;

export function buildFixtureMatch(
  request: ChatCompletionRequest,
  recordConfig?: RecordConfig,
): {
  userMessage?: string;
  inputText?: string;
  model?: string;
  endpoint?: EndpointType;
  turnIndex?: number;
  hasToolResult?: boolean;
  context?: string;
} {
  const match: {
    userMessage?: string;
    inputText?: string;
    model?: string;
    endpoint?: EndpointType;
    turnIndex?: number;
    hasToolResult?: boolean;
    context?: string;
  } = {};

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

  // Record normalized model for all requests so fixtures disambiguate
  // calls that share the same userMessage but target different models.
  if (request.model) {
    match.model =
      normalizeModelName(request.model, recordConfig?.recordFullModelVersion) ?? request.model;
  }

  // Multi-turn disambiguation: writing only `userMessage` lets the recorder's
  // in-memory cache shadow follow-up turns that share it (initial tool call
  // vs. text reply after the tool result). turnIndex + hasToolResult give
  // each call a distinct, matcher-aware key. Skip for non-chat (no messages).
  const messages = request.messages ?? [];
  if (
    messages.length > 0 &&
    (request._endpointType === "chat" || request._endpointType === undefined)
  ) {
    match.turnIndex = messages.filter((m) => m.role === "assistant").length;
    match.hasToolResult = messages.some((m) => m.role === "tool");
  }

  if (request._context) {
    match.context = request._context;
  }

  return match;
}

/**
 * Build optional metadata for drift detection. Contains 8-char SHA-256
 * hashes of the system prompt and tool definitions present in the request.
 * Returns undefined when neither is present.
 */
function buildFixtureMetadata(
  request: ChatCompletionRequest,
): { systemHash?: string; toolsHash?: string } | undefined {
  const meta: { systemHash?: string; toolsHash?: string } = {};

  const messages = request.messages ?? [];
  const systemTexts = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  if (systemTexts) {
    meta.systemHash = crypto.createHash("sha256").update(systemTexts).digest("hex").slice(0, 8);
  }

  if (request.tools && request.tools.length > 0) {
    meta.toolsHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(request.tools))
      .digest("hex")
      .slice(0, 8);
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}
