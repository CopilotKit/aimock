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
import { collapseStreamingResponse, capturedRedactedData } from "./stream-collapse.js";
import { writeErrorResponse } from "./sse-writer.js";
import { resolveUpstreamUrl } from "./url.js";
import { getTestId, slugifyTestId, slugifyContext } from "./helpers.js";
import { DEFAULT_TEST_ID } from "./constants.js";

/** Headers to strip when proxying — hop-by-hop (RFC 2616 §13.5.1) + client-set. */
/**
 * Default ceiling (bytes) for the in-memory proxy-path buffer. Chosen well
 * under V8's ~512 MiB max string length so `rawBuffer.toString()` /
 * stream-collapse never throws `RangeError: Invalid string length`, and so a
 * single huge proxied response cannot spike the heap unbounded. Overridable
 * via `RecordConfig.maxProxyBufferBytes` / `--max-proxy-buffer-bytes`.
 */
export const DEFAULT_MAX_PROXY_BUFFER_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Default ceiling for the number of SSE/NDJSON/EventStream frames whose
 * per-frame state (`frameTimestamps`, parse buffers) aimock retains for a
 * single proxied response. Frame state is count-indexed, not byte-sized, so a
 * long-lived / never-ending stream accumulates `frameTimestamps` entries (and,
 * if a frame never completes, parse-buffer bytes) UNBOUNDED even when the byte
 * cap is generous — observed as multi-GB heap growth over many hours from a few
 * long nested-sub-agent streams. Tripping truncation on EITHER bytes OR frame
 * count bounds both. 5M frames is generous for any real response (a normal
 * completion is hundreds-to-thousands of frames) while still bounding a runaway
 * stream to ~tens of MB of frame state. Overridable via
 * `RecordConfig.maxProxyBufferFrames` / `--max-proxy-buffer-frames`.
 */
export const DEFAULT_MAX_PROXY_BUFFER_FRAMES = 5_000_000;

/**
 * Absolute hard ceiling (bytes) for any in-memory proxy buffer, independent of
 * the configurable `maxProxyBufferBytes`. V8's maximum STRING length on 64-bit
 * is 2^29 - 1 (~512 MiB of UTF-16 code units), and the proxy buffer is
 * eventually stringified via `rawBuffer.toString()` for collapse/relay — so the
 * BYTE buffer must stay safely under that string limit or the toString throws
 * `RangeError: Invalid string length`. 256 MiB of bytes is well under the
 * ~512 MiB string-length boundary (these are different units — bytes vs UTF-16
 * code units — but 256 MiB of bytes can never decode to more than 256 Mi code
 * units, comfortably below 2^29 - 1). Used to clamp the configurable cap AND to
 * bound the non-progressive relay buffer that must be retained past a cap trip.
 */
export const PROXY_BUFFER_HARD_CEILING = 256 * 1024 * 1024; // 256 MiB

/**
 * Test-only override of the effective hard ceiling. Lets the proxy-buffer
 * enforcement suite exercise the >hard-ceiling fail-loud path with a small
 * body instead of streaming 256 MiB. `undefined` (the default) uses the real
 * `PROXY_BUFFER_HARD_CEILING`. NEVER set from production code.
 */
let proxyBufferHardCeilingOverride: number | undefined;

/** @internal test-only — see `proxyBufferHardCeilingOverride`. */
export function setProxyBufferHardCeilingForTests(value: number | undefined): void {
  proxyBufferHardCeilingOverride = value;
}

/** Effective hard ceiling, honoring any active test-only override. */
function effectiveHardCeiling(): number {
  return proxyBufferHardCeilingOverride ?? PROXY_BUFFER_HARD_CEILING;
}

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
  // Mock-internal control headers — meaningless (and potentially confusing
  // or leaky) on a real provider's wire. x-aimock-chaos-* is stripped by
  // prefix in buildForwardHeaders below.
  "x-test-id",
  "x-aimock-strict",
  "x-aimock-context",
]);

/**
 * Build the header set forwarded to an upstream provider from an incoming
 * request: everything except hop-by-hop, client-set, and mock-internal
 * headers (STRIP_HEADERS, plus the x-aimock-chaos-* prefix family). Shared
 * by the generic recorder proxy and the OpenRouter-video live lifecycle
 * proxy.
 */
export function buildForwardHeaders(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, val] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (val === undefined || STRIP_HEADERS.has(lower) || lower.startsWith("x-aimock-chaos-")) {
      continue;
    }
    out[name] = Array.isArray(val) ? val.join(", ") : val;
  }
  return out;
}

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
 * Make an arbitrary string safe to set as an HTTP header value. Node's
 * `res.setHeader` throws ERR_INVALID_CHAR on anything outside Latin-1 (plus
 * control characters) — and persist errors embed filesystem paths verbatim,
 * so a Unicode fixture path would turn a recoverable record failure into a
 * 500. Out-of-range characters are replaced with `?` rather than stripped so
 * the value's shape stays legible.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\t\x20-\x7e\x80-\xff]/g, "?");
}

/**
 * Resolve a `content-type` header value to a single string. Node's
 * `http.IncomingHttpHeaders` types `content-type` as `string | string[]`, and
 * a constructed/proxied header object CAN carry an array (e.g. duplicated
 * header lines surfaced by some HTTP stacks). `join(", ")`-ing such an array
 * produces a malformed `Content-Type: application/json, text/html` value — pick
 * the FIRST element instead, which is the value the client should act on.
 * Returns `""` when the header is absent or an empty array.
 */
export function pickContentType(contentType: string | string[] | undefined): string {
  if (Array.isArray(contentType)) {
    return contentType.length > 0 ? contentType[0] : "";
  }
  return contentType ?? "";
}

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

  if (record.proxyOnly) {
    logger.info(`Proxied ${providerKey} request (proxy-only mode)`);
    return { kind: "skipped" };
  }

  // Warned only past the proxy-only early-return: under proxy-only nothing is
  // persisted or registered, so an empty match has no consequence there.
  if (isEmptyMatch) {
    logger.warn("Recorded fixture has empty match criteria — skipping in-memory registration");
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
    // The context becomes a directory segment, but it originates from the
    // attacker-controllable `X-AIMock-Context` header — slugify it (mirroring
    // testId above) so `../`, separators, and absolute prefixes can't escape
    // the fixtures base dir. An empty slug → no context segment.
    const contextSegment = fixture.match.context
      ? slugifyContext(fixture.match.context)
      : undefined;
    filepath = contextSegment
      ? path.join(fixturePath, contextSegment, timestampFile)
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
    // Warnings are persisted as a `_warnings` JSON array (authoritative,
    // non-fragmenting) AND a legacy "; "-joined `_warning` string (kept for
    // backward-compatible readers). The array is the source of truth on a
    // snapshot merge: a single warning that itself contains "; " (e.g.
    // "captured A; then B") would be fragmented into two bogus entries if the
    // joined string were split back apart on merge. Carrying the array forward
    // avoids that round-trip fragmentation entirely.
    let fileContent: { fixtures: unknown[]; _warning?: string; _warnings?: string[] };
    if (mergeExisting && fs.existsSync(filepath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filepath, "utf-8"));
        // Guard the spread: a non-array `fixtures` (e.g. a string from a
        // hand-edited file) would silently spread into single characters and
        // mangle the merged file. Treat it like the corrupt-JSON case below.
        const existingFixtures = Array.isArray(existing.fixtures)
          ? (existing.fixtures as unknown[])
          : undefined;
        if (existingFixtures === undefined && existing.fixtures !== undefined) {
          logger.warn(
            `Existing fixture file ${filepath} has a non-array "fixtures" — discarding it and starting fresh`,
          );
        }
        fileContent = { fixtures: [...(existingFixtures ?? []), fixture] };
        // Carry existing warnings forward — a later clean capture merging into
        // the same snapshot file must not erase an earlier capture's warning
        // (e.g. an over-cap b64 omission). Prefer the new `_warnings` array;
        // fall back to the legacy "; "-joined `_warning` string for files
        // written before this format change. The legacy split can still
        // fragment an embedded-"; " warning in a pre-existing file, but new
        // captures no longer create that hazard.
        if (Array.isArray(existing._warnings)) {
          fileWarnings.unshift(
            ...(existing._warnings as unknown[]).filter((w): w is string => typeof w === "string"),
          );
        } else if (typeof existing._warning === "string" && existing._warning) {
          fileWarnings.unshift(...existing._warning.split("; "));
        }
      } catch (mergeErr) {
        const msg = mergeErr instanceof Error ? mergeErr.message : "unknown";
        logger.warn(`Could not read existing fixture file ${filepath} (${msg}) — overwriting`);
        fileContent = { fixtures: [fixture] };
      }
    } else {
      fileContent = { fixtures: [fixture] };
    }
    if (fileWarnings.length > 0) {
      // Exact-duplicate warnings (e.g. repeated over-cap captures merging into
      // the same snapshot file) collapse to one entry. Emit BOTH the
      // authoritative array and the legacy joined string.
      const dedupedWarnings = [...new Set(fileWarnings)];
      fileContent._warnings = dedupedWarnings;
      fileContent._warning = dedupedWarnings.join("; ");
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
  const forwardHeaders = buildForwardHeaders(req);

  const requestBody = rawBody ?? JSON.stringify(request);

  // Make upstream request
  let upstreamStatus: number;
  let upstreamHeaders: http.IncomingHttpHeaders;
  let upstreamBody: string;
  let rawBuffer: Buffer;
  let bufferTruncated = false;
  let truncationCap: "byte" | "frame" | undefined;
  let totalBytes = 0;
  let hardCeilingExceeded = false;

  // Track whether we streamed SSE progressively to the client; if so,
  // skip the final res.writeHead/res.end relay at the bottom of this fn.
  let streamedToClient = false;
  let clientDisconnected = false;
  let frameTimestamps: number[] = [];
  let streamStartTime = 0;
  const maxProxyBufferBytes = clampMaxBufferBytes(record.maxProxyBufferBytes);
  const maxProxyBufferFrames = clampMaxBufferFrames(record.maxProxyBufferFrames);
  try {
    const result = await makeUpstreamRequest(
      target,
      forwardHeaders,
      requestBody,
      res,
      req.method,
      defaults.logger,
      { upstreamTimeoutMs: record.upstreamTimeoutMs, bodyTimeoutMs: record.bodyTimeoutMs },
      maxProxyBufferBytes,
      maxProxyBufferFrames,
    );
    upstreamStatus = result.status;
    upstreamHeaders = result.headers;
    upstreamBody = result.body;
    rawBuffer = result.rawBuffer;
    streamedToClient = result.streamedToClient;
    clientDisconnected = result.clientDisconnected;
    frameTimestamps = result.frameTimestamps;
    streamStartTime = result.streamStartTime;
    bufferTruncated = result.bufferTruncated;
    truncationCap = result.truncationCap;
    totalBytes = result.totalBytes;
    hardCeilingExceeded = result.hardCeilingExceeded;
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
      // Streaming headers (200) are already on the wire, so we cannot change the
      // status — but we MUST NOT call res.end(), which the client reads as a
      // clean EOF and treats as a complete (silently truncated) response.
      // Destroy the connection instead so the client sees an aborted stream and
      // can surface the upstream failure rather than acting on partial data.
      res.destroy();
    }
    return "relayed";
  }

  // Buffer cap tripped: skip collapse + recording (the in-memory buffer can't
  // be safely/faithfully journaled), but ALWAYS deliver a faithful response to
  // the client. The cap means "don't journal", not "don't answer".
  //  - PROGRESSIVE stream: the bytes were already teed to the client live, so
  //    nothing more to write — just end if still open.
  //  - NON-progressive response, UNDER the hard ceiling: makeUpstreamRequest
  //    kept the FULL body (bounded by PROXY_BUFFER_HARD_CEILING) precisely so we
  //    can relay it here. Relay the real body so a large single-shot JSON
  //    (embeddings / fal / image-b64) reaches the client intact — but NORMALIZE
  //    the status (success→200 / error→502) exactly like every other relay path
  //    so upstream provider details don't leak through this branch alone.
  //  - NON-progressive response, OVER the hard ceiling: the retained buffer is
  //    PARTIAL (we stopped buffering at the ceiling and there is no live tee),
  //    so relaying it would present a truncated body as success. FAIL LOUD with
  //    a 502 instead — never deliver a silently-truncated body as 2xx.
  if (bufferTruncated) {
    const capDetail =
      truncationCap === "frame"
        ? `the ${maxProxyBufferFrames}-frame cap`
        : `the ${maxProxyBufferBytes}-byte cap`;
    if (!streamedToClient && hardCeilingExceeded && !res.headersSent) {
      const ceilingMiB = Math.round(PROXY_BUFFER_HARD_CEILING / (1024 * 1024));
      defaults.logger.error(
        `Upstream response exceeded the ${ceilingMiB} MiB proxy hard ceiling (saw ${totalBytes} bytes) on a non-progressive body — cannot relay the full body and refusing to relay a truncated one; returning 502`,
      );
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Upstream response exceeds ${ceilingMiB}MiB proxy ceiling`,
            type: "proxy_error",
          },
        }),
      );
      return "relayed";
    }
    defaults.logger.warn(
      `Upstream response exceeded ${capDetail} (saw ${totalBytes} bytes) — relayed to client, recording skipped`,
    );
    if (!streamedToClient && !res.headersSent) {
      // Normalize the relayed status like the under-cap relay paths
      // (success→200, error→502) so this branch does not leak a raw upstream
      // 429/503/etc. The full real body (under the hard ceiling) is relayed.
      const clientStatus = upstreamStatus >= 200 && upstreamStatus < 300 ? 200 : 502;
      const relayHeaders: Record<string, string> = {};
      const ct = upstreamHeaders["content-type"];
      const ctStr = Array.isArray(ct) ? ct.join(", ") : (ct ?? "");
      relayHeaders["Content-Type"] = ctStr || "application/json";
      res.writeHead(clientStatus, relayHeaders);
      res.end(rawBuffer);
    } else if (!res.writableEnded) {
      res.end();
    }
    return "relayed";
  }

  // Detect streaming response and collapse if necessary.
  // NOTE: collapse buffers the upstream body in memory up to maxProxyBufferBytes
  // (see makeUpstreamRequest). Over-cap responses short-circuit above, so the
  // buffer reaching here is bounded and safe to stringify/collapse.
  const contentType = upstreamHeaders["content-type"];
  const ctString = pickContentType(contentType);
  const isBinaryStream = ctString.toLowerCase().includes("application/vnd.amazon.eventstream");
  const collapsed = collapseStreamingResponse(
    ctString,
    providerKey,
    isBinaryStream ? rawBuffer : upstreamBody,
    defaults.logger,
  );

  let fixtureResponse: FixtureResponse;

  // TTS response — binary audio, not JSON. Classify on the audio content-type
  // when upstream succeeded (2xx), regardless of body length: a zero-length
  // audio body is still an audio response (empty audio), NOT an opaque
  // proxy_error — letting it fall through to the JSON path would mis-record it.
  // A non-2xx audio response (error JSON in the body) is left to the JSON/error
  // path below.
  const isAudioResponse = ctString.toLowerCase().startsWith("audio/");
  const isAudioSuccess = upstreamStatus >= 200 && upstreamStatus < 300;
  if (isAudioResponse && isAudioSuccess) {
    // Derive format from Content-Type (audio/mpeg→mp3, audio/opus→opus, etc.)
    const audioFormat = ctString
      .toLowerCase()
      .replace("audio/", "")
      .replace("mpeg", "mp3")
      .split(";")[0]
      .trim();
    if (rawBuffer.length === 0) {
      defaults.logger.warn(
        "Audio response had a zero-length body — recording an empty audio fixture",
      );
    }
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
      logDroppedReasoningSignature(
        defaults.logger,
        collapsed.reasoning,
        collapsed.reasoningSignature,
      );
      // Redacted-thinking blocks carry their OWN encrypted reasoning, so they are
      // carried independently of any plaintext `reasoning` (a turn can have only
      // redacted thinking) so the recorded turn round-trips its redacted blocks.
      const redactedThinkingSpread = collapsed.redactedThinking?.length
        ? { redactedThinking: collapsed.redactedThinking }
        : {};
      const webSearchesSpread = collapsed.webSearches?.length
        ? { webSearches: collapsed.webSearches }
        : {};
      fixtureResponse = {
        content: collapsed.content ?? "",
        ...reasoningSpread,
        ...reasoningSignatureSpread,
        ...redactedThinkingSpread,
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
      logDroppedReasoningSignature(
        defaults.logger,
        collapsed.reasoning,
        collapsed.reasoningSignature,
      );
      // Redacted-thinking blocks carry their OWN encrypted reasoning, so they are
      // carried independently of any plaintext `reasoning`; see the empty-content
      // branch above.
      const redactedThinkingSpread = collapsed.redactedThinking?.length
        ? { redactedThinking: collapsed.redactedThinking }
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
          // Both content and toolCalls present — save as ContentWithToolCallsResponse.
          //
          // Ordered `blocks` (#274) is persisted ONLY when the collapser
          // classified the stream as interleaved — a tool-call delta appeared
          // strictly before the first content delta, OR a content delta
          // appeared after any tool-call delta. The collapser encodes exactly
          // that rule: it sets `collapsed.blocks` only in those cases and
          // leaves it undefined otherwise. So the recorder simply spreads it
          // when present; an ordinary text-then-tools (or text-only) stream has
          // no `blocks` and persists the legacy shape byte-identically.
          const blocksSpread = collapsed.blocks?.length ? { blocks: collapsed.blocks } : {};
          fixtureResponse = {
            content: collapsed.content,
            toolCalls: sanitizedToolCalls,
            ...blocksSpread,
            ...reasoningSpread,
            ...reasoningSignatureSpread,
            ...redactedThinkingSpread,
            ...webSearchesSpread,
          };
        } else {
          fixtureResponse = {
            toolCalls: sanitizedToolCalls,
            ...reasoningSpread,
            ...reasoningSignatureSpread,
            ...redactedThinkingSpread,
            ...webSearchesSpread,
          };
        }
      } else {
        fixtureResponse = {
          content: collapsed.content ?? "",
          ...reasoningSpread,
          ...reasoningSignatureSpread,
          ...redactedThinkingSpread,
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
      // NOTE: base64 embeddings are decoded unconditionally inside
      // buildFixtureResponse regardless of the request's `encoding_format`, so
      // there is no need to re-parse it here — it was a dead param.
      fixtureResponse = buildFixtureResponse(parsedResponse, upstreamStatus, defaults.logger);
    }
  }

  // Client may have closed its socket before upstream fired `end`
  // (e.g. the OpenAI Python SDK closes the response immediately after
  // consuming `data: [DONE]`). Because we no longer destroy the upstream
  // request on client close (see the `clientRes.on("close")` handler
  // below), reaching this point means upstream still ran to completion
  // and the buffered body is intact — so recording the fixture is safe.
  if (clientDisconnected) {
    defaults.logger.warn(
      "Client closed connection before upstream end — upstream response completed, recording full fixture",
    );
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
      res.setHeader("X-AIMock-Record-Error", sanitizeHeaderValue(persistResult.error));
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

/**
 * Sanitize a configured timeout: non-finite or non-positive values fall back
 * to the default. Shared with the OpenRouter-video live lifecycle proxy so
 * `record.upstreamTimeoutMs` is clamped identically on every proxy path.
 */
export function clampTimeout(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/**
 * Sanitize the configured proxy-buffer cap: non-finite or non-positive values
 * fall back to the default. Also hard-clamps to just under V8's max string
 * length so a misconfigured large value can never permit an over-string-limit
 * buffer to reach `.toString()`.
 */
export function clampMaxBufferBytes(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_PROXY_BUFFER_BYTES;
  }
  return Math.min(value, PROXY_BUFFER_HARD_CEILING);
}

/**
 * Sanitize the configured proxy-buffer frame cap: non-finite or non-positive
 * values fall back to the default. Bounds the count-indexed per-frame state
 * (`frameTimestamps` + parse buffers) that the byte cap cannot bound on its own.
 */
export function clampMaxBufferFrames(value: number | undefined): number {
  // INTENTIONAL DIVERGENCE from journal-max's `0 = unbounded` convention: here
  // 0 (and any non-positive / non-finite value) maps to the DEFAULT cap, never
  // "unbounded". The frame cap exists as leak-safety for never-ending proxy
  // streams; allowing 0 to disable it would reintroduce the exact unbounded
  // per-frame-state growth this cap guards against. Do NOT make 0 mean
  // unbounded.
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_PROXY_BUFFER_FRAMES;
  }
  return Math.floor(value);
}

function makeUpstreamRequest(
  target: URL,
  headers: Record<string, string>,
  body: string,
  clientRes?: http.ServerResponse,
  method: string = "POST",
  logger?: Logger,
  timeouts?: Pick<RecordConfig, "upstreamTimeoutMs" | "bodyTimeoutMs">,
  maxBufferBytes: number = DEFAULT_MAX_PROXY_BUFFER_BYTES,
  maxBufferFrames: number = DEFAULT_MAX_PROXY_BUFFER_FRAMES,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  rawBuffer: Buffer;
  streamedToClient: boolean;
  clientDisconnected: boolean;
  frameTimestamps: number[];
  streamStartTime: number;
  /**
   * True when the upstream response exceeded `maxBufferBytes`. The client still
   * received every byte (the relay is independent of this buffer), but the
   * in-memory buffer was capped, so `body`/`rawBuffer` are partial and the
   * caller MUST skip collapse/recording.
   */
  bufferTruncated: boolean;
  /**
   * Which cap tripped truncation (`"byte"` or `"frame"`), or `undefined` when
   * not truncated. Lets the caller log accurately which budget was exceeded
   * rather than conflating the two.
   */
  truncationCap?: "byte" | "frame";
  /** Total bytes seen from upstream (may exceed the buffered amount when capped). */
  totalBytes: number;
  /**
   * True when a NON-progressive (non-teed) upstream body exceeded the proxy
   * hard ceiling, so the retained `rawBuffer` is PARTIAL. The caller MUST fail
   * loud (502) rather than relay this truncated body as a success status.
   */
  hardCeilingExceeded: boolean;
}> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const UPSTREAM_TIMEOUT_MS = clampTimeout(timeouts?.upstreamTimeoutMs, 30_000);
    const BODY_TIMEOUT_MS = clampTimeout(timeouts?.bodyTimeoutMs, 30_000);
    // Capture the moment the request is dispatched (set just before
    // `req.write` below). ttft/total durations are measured from request SEND,
    // not from when upstream HEADERS arrive — basing them on headers-received
    // time would exclude the upstream's time-to-first-byte and understate the
    // recorded time-to-first-token.
    let requestSendTime = 0;
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
        const ctStr = pickContentType(ct);
        const ctLower = ctStr.toLowerCase();
        const isSSE = ctLower.includes("text/event-stream");
        const isNDJSON = ctLower.includes("application/x-ndjson");
        const isBinaryEventStream = ctLower.includes("application/vnd.amazon.eventstream");
        const isProgressiveStream = isSSE || isNDJSON || isBinaryEventStream;
        // SSE/NDJSON frame timing capture — timestamps each complete frame
        // so proxyAndRecord can build RecordedTimings for the fixture.
        const frameTimestamps: number[] = [];
        // Measure from request send (see requestSendTime above), falling back to
        // now only if it was somehow not set before the response callback fired.
        const streamStartTime = requestSendTime || Date.now();
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
          // Track client disconnects but do NOT destroy the upstream
          // request. Some SDKs (notably the OpenAI Python SDK) close
          // their socket the instant they consume `data: [DONE]`, before
          // upstream has fired `res.end`. If we destroyed upstream on
          // that signal we would lose the tail of the response — or the
          // whole response, when the SDK closes right after `[DONE]` —
          // and record mode would silently produce no fixture. Letting
          // upstream finish means we still capture a complete body; the
          // `!clientDisconnected` guard inside `onUpstreamData` already
          // prevents further writes to the now-closed client socket, so
          // no data is written to a dead peer.
          clientRes.on("close", () => {
            if (!clientRes.writableFinished) {
              clientDisconnected = true;
            }
          });
        }
        const chunks: Buffer[] = [];
        // Bound the in-memory buffer used to collapse/journal the response so a
        // single huge proxied stream can neither spike the heap nor build a
        // string past V8's ~512 MiB limit (RangeError: Invalid string length).
        // The client relay below is independent of this buffer, so capping it
        // does NOT truncate what the client receives.
        let bufferedBytes = 0;
        let totalBytes = 0;
        let bufferTruncated = false;
        /** Which cap tripped truncation — surfaced to the caller for an accurate warning. */
        let truncationCap: "byte" | "frame" | undefined;
        // Snapshot the effective hard ceiling once for this request (honors the
        // test-only override). Bounds the non-progressive relay buffer; when the
        // body would exceed it we can neither buffer the full copy nor safely
        // relay the partial one, so the caller fails loud instead of truncating.
        const hardCeiling = effectiveHardCeiling();
        /**
         * True when a NON-progressive upstream body exceeded `hardCeiling`, so
         * the buffered `rawBuffer` is a PARTIAL copy that must NOT be relayed as
         * success. Distinct from `bufferTruncated` (which also covers the
         * under-ceiling over-soft-cap case where the full body IS retained).
         */
        let hardCeilingExceeded = false;
        // Trip truncation: mark the response over-cap so the caller skips
        // collapse/recording, and eagerly drop the accumulated PARSE state
        // (frameTimestamps + frame/binary parse buffers) which only ever feeds
        // recording. Reused by the top-of-callback byte guard AND the per-frame
        // guards inside the SSE/NDJSON and binary splitter loops, so a single
        // coalesced chunk carrying many complete frames cannot overshoot the
        // frame cap before the next data event re-checks.
        //
        // The raw `chunks` array is handled differently by stream shape:
        //  - progressive streams (SSE/NDJSON/binary) are teed to the client
        //    live, so the bytes are already on the wire — `chunks` is freed
        //    immediately and the partial buffer is never relayed.
        //  - non-progressive responses (a single non-stream body) are NOT teed;
        //    the only copy the client can receive is `chunks`, so we KEEP
        //    accumulating it (bounded by HARD_CEILING below) and relay it in
        //    full. We still skip recording — the cap means "don't journal", not
        //    "don't answer the client".
        const tripTruncation = (cap: "byte" | "frame") => {
          bufferTruncated = true;
          truncationCap = cap;
          frameTimestamps.length = 0;
          frameBuffer = "";
          // Intentional: the returned flush string is discarded (frameBuffer was
          // just cleared and recording is skipped), but `.end()` releases any
          // partial-multibyte bytes the StringDecoder is internally holding — so
          // this frees decoder state rather than being dead cleanup.
          frameDecoder.end();
          binaryFrameBuffer = Buffer.alloc(0);
          if (isProgressiveStream) {
            chunks.length = 0;
            bufferedBytes = 0;
          }
          // State which cap tripped accurately (do not conflate the two caps),
          // and report the relay truthfully — the client received every byte on
          // the streamed path and, post-fix, on the non-streamed path too.
          const detail =
            cap === "byte"
              ? `byte cap (${maxBufferBytes} bytes)`
              : `frame cap (${maxBufferFrames} frames)`;
          logger?.warn(
            `Upstream response exceeded the proxy buffer ${detail} — relaying full body to client, but skipping in-memory collapse/recording to bound memory`,
          );
        };
        const onUpstreamData = (chunk: Buffer) => {
          totalBytes += chunk.length;
          // Trip truncation on EITHER bytes OR frame count. The byte cap alone
          // never bounds `frameTimestamps` (count-indexed, not byte-sized) nor a
          // never-completing parse buffer, so a long-lived / never-ending stream
          // would otherwise grow per-frame state forever. `frameTimestamps.length`
          // is the running complete-frame count. `>=` (not `>`) so we never
          // retain MORE than `maxBufferFrames` frames — see the "maximum N
          // frames retained" contract on DEFAULT_MAX_PROXY_BUFFER_FRAMES.
          if (!bufferTruncated && bufferedBytes + chunk.length > maxBufferBytes) {
            tripTruncation("byte");
          } else if (!bufferTruncated && frameTimestamps.length >= maxBufferFrames) {
            tripTruncation("frame");
          }
          // Buffer the raw bytes. Under cap: always. Over cap on a progressive
          // stream: never (bytes are already teed live; chunks was freed). Over
          // cap on a NON-progressive response: keep buffering for the relay —
          // it has no live tee, so `chunks` is the only copy the client can get
          // — but hard-cap it at HARD_CEILING (well under V8's max string
          // length) so the eventual rawBuffer.toString() relay can never throw
          // RangeError: Invalid string length.
          if (!bufferTruncated) {
            chunks.push(chunk);
            bufferedBytes += chunk.length;
          } else if (!isProgressiveStream) {
            if (bufferedBytes + chunk.length <= hardCeiling) {
              chunks.push(chunk);
              bufferedBytes += chunk.length;
            } else {
              // The non-progressive relay copy would exceed the hard ceiling.
              // We CANNOT relay the full body (it can't be buffered safely) and
              // MUST NOT relay the partial buffer as a success — flag it so the
              // caller fails loud (502) instead of presenting a truncated 2xx.
              hardCeilingExceeded = true;
            }
          }

          // Capture per-frame timestamps for SSE/NDJSON streams. Gated on
          // !bufferTruncated so per-frame parse/timing state stops growing once
          // the cap trips (the byte/frame guard above already freed it).
          // TCP data events don't align with SSE frames — buffer and
          // split on the protocol delimiter to timestamp each complete frame.
          if (!bufferTruncated && (isSSE || isNDJSON)) {
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
            // may be incomplete). Enforce the frame cap PER-FRAME: a single
            // coalesced chunk can carry many complete frames, so checking only
            // at the top of the callback would let one event push them all and
            // overshoot the cap unbounded. Trip + bail mid-loop instead.
            for (let fi = 0; fi < parts.length - 1; fi++) {
              if (frameTimestamps.length >= maxBufferFrames) {
                tripTruncation("frame");
                break;
              }
              if (parts[fi].trim().length > 0) {
                frameTimestamps.push(Date.now());
              }
            }
            // Last part stays in buffer (may be incomplete). Skip when the
            // per-frame guard just tripped — tripTruncation already cleared it.
            if (!bufferTruncated) {
              frameBuffer = parts[parts.length - 1];
            }
          }

          // Binary EventStream frame boundary detection — parse the 4-byte
          // total-length prefix to detect complete frames without decoding
          // frame contents (CRC validation happens in stream-collapse).
          // Also gated on !bufferTruncated so binaryFrameBuffer stops growing
          // once the cap trips.
          if (!bufferTruncated && isBinaryEventStream) {
            // Count the binary parse buffer's growth toward the byte cap.
            // binaryFrameBuffer is a SECOND, parallel copy of the bytes (the
            // raw `chunks` array also holds them), so without this a
            // never-completing / malformed (`totalLen<12`) frame — which pushes
            // no frameTimestamps — would let a full second copy accumulate up
            // to the byte cap, peaking at ~2× the configured cap. Trip on the
            // COMBINED footprint so the byte cap bounds both copies together.
            // NOTE: `bufferedBytes` ALREADY includes the current `chunk.length`
            // (added in the raw-buffer accumulation above), so the combined
            // footprint is `bufferedBytes + binaryFrameBuffer.length`. Adding
            // `chunk.length` again would double-count it and trip the cap one
            // chunk early (matching the L<byte-guard> accounting at the top).
            if (bufferedBytes + binaryFrameBuffer.length > maxBufferBytes) {
              tripTruncation("byte");
            } else {
              binaryFrameBuffer = Buffer.concat([binaryFrameBuffer, chunk]);
              while (binaryFrameBuffer.length >= 4) {
                if (frameTimestamps.length >= maxBufferFrames) {
                  // Per-frame cap: a single chunk can complete many binary
                  // frames; trip mid-loop rather than overshoot.
                  tripTruncation("frame");
                  break;
                }
                const totalLen = binaryFrameBuffer.readUInt32BE(0);
                if (totalLen < 12 || binaryFrameBuffer.length < totalLen) break;
                frameTimestamps.push(Date.now());
                binaryFrameBuffer = binaryFrameBuffer.subarray(totalLen);
              }
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
        };
        res.on("data", onUpstreamData);
        res.on("error", reject);
        res.on("end", () => {
          if (res.socket) res.setTimeout(0);
          // Flush remaining text frame buffer — captures the last frame if
          // the stream ended without a trailing delimiter. Binary EventStream
          // frames are length-prefixed so partial frames at end-of-stream are
          // genuinely incomplete and should not be timestamped. Skipped when
          // truncated: the decoder/parse buffer were already drained+cleared on
          // the trip, and recording is skipped, so there is nothing to flush.
          if (!bufferTruncated && (isSSE || isNDJSON)) {
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
          // Decide the string `body`:
          //  - not truncated: stringify the full buffer as usual.
          //  - truncated PROGRESSIVE stream: `chunks` was freed on the trip, so
          //    rawBuffer is empty; skip toString to keep the path allocation-free
          //    (the client already got every byte via the live tee).
          //  - truncated NON-progressive response: we deliberately kept the full
          //    bytes (bounded by HARD_CEILING) so they can be relayed — stringify
          //    them so proxyAndRecord can `res.end(body)` the real response.
          const bodyString =
            !bufferTruncated || (bufferTruncated && !streamedToClient) ? rawBuffer.toString() : "";
          resolve({
            status: res.statusCode ?? 500,
            headers: res.headers,
            body: bodyString,
            rawBuffer,
            streamedToClient,
            clientDisconnected,
            frameTimestamps,
            streamStartTime,
            bufferTruncated,
            truncationCap,
            totalBytes,
            hardCeilingExceeded,
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
    // Stamp the send time immediately before dispatching the body so ttft and
    // total-duration are measured from request send, not headers-received.
    requestSendTime = Date.now();
    req.write(body);
    req.end();
  });
}

/**
 * A captured Anthropic thinking-block signature is only persisted alongside
 * non-empty plaintext `reasoning` (a bare signature has nothing to attach to on
 * replay). When that gate drops a present signature, warn so the loss is
 * observable (matching the recording-side anomaly convention in this file).
 */
function logDroppedReasoningSignature(
  logger: Logger | undefined,
  reasoning: string | undefined,
  reasoningSignature: string | undefined,
): void {
  if (reasoningSignature && !reasoning) {
    logger?.warn("Dropping captured reasoningSignature — no plaintext reasoning to attach it to");
  }
}

/**
 * Coerce a tool call's `arguments` field into the string the fixture contract
 * requires (types.ts `ToolCall.arguments: string`). When the upstream omits the
 * arguments field entirely, `JSON.stringify(undefined)` yields the JS value
 * `undefined` (not a string), which then gets dropped on disk-write and breaks
 * cross-provider replay through the OpenAI streaming path. Coalesce to "{}" so
 * `arguments` is ALWAYS a string, matching the streaming recorder's behavior.
 */
function toToolCallArguments(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === undefined || raw === null) return "{}";
  return JSON.stringify(raw);
}

/**
 * Detect the response format from the parsed upstream JSON and convert
 * it into an aimock FixtureResponse.
 */
function buildFixtureResponse(parsed: unknown, status: number, logger?: Logger): FixtureResponse {
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
    // A string embedding is a base64-packed Float32 array. Decode it regardless
    // of whether the request echoed `encoding_format: "base64"` — some providers
    // return base64 without the client having asked for it, and gating on the
    // request echo silently drops a valid embedding into the error fixture.
    if (typeof first.embedding === "string") {
      const buf = Buffer.from(first.embedding, "base64");
      if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) {
        // Malformed base64 (not a whole number of Float32s). Don't silently
        // return a valid-looking zero-dimension embedding — log it and fall
        // through to the generic error fixture so the loss is diagnosable.
        logger?.warn(
          `Could not decode base64 embedding (byteLength=${buf.byteLength} is not a positive multiple of 4) — saving as error fixture`,
        );
      } else {
        // Uint8Array constructor copies Buffer data to a fresh ArrayBuffer at offset 0,
        // guaranteeing the alignment Float32Array requires.
        const copied = new Uint8Array(buf);
        const floats = new Float32Array(copied.buffer, 0, buf.byteLength / 4);
        return { embedding: Array.from(floats) };
      }
    }
    // OpenAI image generation: { created, data: [{ url, b64_json, revised_prompt }] }
    // Enter the branch when ANY item carries media — not just data[0]. A batch
    // whose first element lacks both url and b64_json (e.g. a partial/placeholder
    // entry) but whose later element HAS one would otherwise skip the branch and
    // fall through to the error fixture, silently dropping every captured image.
    if ((obj.data as Array<Record<string, unknown>>).some((item) => item.url || item.b64_json)) {
      // Map only items that actually carry media (url or b64_json). A later item
      // lacking both — including one whose `b64_json` is an empty string — would
      // otherwise produce an empty {} image entry (all the conditional spreads
      // are skipped) — silent fidelity loss.
      const dataItems = obj.data as Array<Record<string, unknown>>;
      const images = dataItems
        .filter((item) => item.url || item.b64_json)
        .map((item) => ({
          ...(item.url ? { url: String(item.url) } : {}),
          ...(item.b64_json ? { b64Json: String(item.b64_json) } : {}),
          ...(item.revised_prompt ? { revisedPrompt: String(item.revised_prompt) } : {}),
        }));
      // Surface any dropped items (e.g. empty-string b64_json placeholders) so
      // the fidelity loss is diagnosable rather than silent.
      const droppedCount = dataItems.length - images.length;
      if (droppedCount > 0) {
        logger?.warn(
          `Dropped ${droppedCount} image item(s) from batch lacking a non-empty url or b64_json`,
        );
      }
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
  // Tightened: a bare `text` string alongside a single incidental `language` or
  // `duration` field is too weak — many non-transcription payloads carry a
  // `text` plus a `duration`-like number. Require an explicit
  // `task: "transcribe"`, OR BOTH `language` and `duration` (the verbose
  // transcription shape). Also reject anything carrying clear non-transcription
  // markers (chat completions, events, etc.) so they route to their own branch.
  const looksLikeTranscription =
    typeof obj.text === "string" &&
    (obj.task === "transcribe" || (obj.language !== undefined && obj.duration !== undefined)) &&
    !("choices" in obj) &&
    !("candidates" in obj) &&
    !("object" in obj) &&
    !("message" in obj) &&
    !("outputs" in obj);
  if (looksLikeTranscription) {
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
        arguments: toToolCallArguments(o.arguments),
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

      // Reasoning is exposed under different keys across OpenAI-compatible
      // providers: OpenAI/vLLM use `reasoning_content`, while DeepSeek and
      // OpenRouter use `reasoning`. Read both (preferring `reasoning_content`)
      // so a reasoning turn is not silently dropped on the latter providers.
      const openaiReasoning =
        typeof message.reasoning_content === "string" && message.reasoning_content.length > 0
          ? message.reasoning_content
          : typeof message.reasoning === "string" && message.reasoning.length > 0
            ? message.reasoning
            : undefined;

      if (hasToolCalls) {
        const toolCalls: ToolCall[] = (message.tool_calls as Array<Record<string, unknown>>).map(
          (tc) => {
            const fn = tc.function as Record<string, unknown>;
            return {
              name: String(fn.name),
              arguments: toToolCallArguments(fn.arguments),
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
    // Raw `redacted_thinking` block presence drives reasoning-bearing
    // classification below (mirrors how `thinkingBlocks` keys on PRESENCE, not
    // surviving payload). A turn whose redacted blocks all carry empty `data`
    // is constructible upstream and must NOT fall through to the error fallback.
    const redactedBlocks = blocks.filter((b) => b.type === "redacted_thinking");
    // A `redacted_thinking` block carries its encrypted reasoning in an opaque
    // `data` string; collect the SURVIVING (non-empty) payloads in content-array
    // order for the persisted fixture so the recorded turn round-trips its
    // redacted blocks (mirrors the streaming collapse path; see
    // capturedRedactedData for the non-empty rule — empty-data blocks are dropped
    // from the payload, but still count toward classification via redactedBlocks).
    const redactedThinking = blocks
      .map((b) => capturedRedactedData(b))
      .filter((data): data is string => data !== undefined);
    const hasToolCalls = toolUseBlocks.length > 0;
    const joinedText = textBlocks.map((b) => String(b.text ?? "")).join("");
    const hasContent = joinedText.length > 0;
    const anthropicReasoning =
      thinkingBlocks.length > 0
        ? thinkingBlocks.map((b) => String(b.thinking ?? "")).join("")
        : undefined;
    // The real cryptographic signature is carried only when reasoning is also
    // present (a bare signature has nothing to attach to on replay), matching the
    // streaming recorder's gating. Multi-thinking-block parity: collapseAnthropicSSE
    // overwrites reasoningSignature on every signature_delta (last-signature-wins),
    // and a thinking block that streams NO signature_delta leaves the prior value
    // intact. Mirror both: take the LAST block that actually carries a signature, so
    // a block missing one does not clobber an earlier signature.
    const anthropicReasoningSignature = (() => {
      let sig: string | undefined;
      for (const b of thinkingBlocks) {
        if (typeof b.signature === "string") sig = String(b.signature);
      }
      return sig;
    })();
    // Carry the real Anthropic thinking-block signature only when reasoning is
    // also present; redacted blocks carry their OWN encrypted reasoning so they
    // are carried independently of any plaintext `reasoning`. Both mirror the
    // streaming spread gating in proxyAndRecord.
    const reasoningSignatureSpread =
      anthropicReasoning && anthropicReasoningSignature
        ? { reasoningSignature: anthropicReasoningSignature }
        : {};
    logDroppedReasoningSignature(logger, anthropicReasoning, anthropicReasoningSignature);
    const redactedThinkingSpread = redactedThinking.length > 0 ? { redactedThinking } : {};

    if (hasToolCalls) {
      const toolCalls: ToolCall[] = toolUseBlocks.map((b) => ({
        name: String(b.name),
        arguments: toToolCallArguments(b.input),
        ...(b.id ? { id: String(b.id) } : {}),
      }));
      if (hasContent) {
        return {
          content: joinedText,
          toolCalls,
          ...(anthropicReasoning ? { reasoning: anthropicReasoning } : {}),
          ...reasoningSignatureSpread,
          ...redactedThinkingSpread,
        };
      }
      return {
        toolCalls,
        ...(anthropicReasoning ? { reasoning: anthropicReasoning } : {}),
        ...reasoningSignatureSpread,
        ...redactedThinkingSpread,
      };
    }
    if (hasContent) {
      return {
        content: joinedText,
        ...(anthropicReasoning ? { reasoning: anthropicReasoning } : {}),
        ...reasoningSignatureSpread,
        ...redactedThinkingSpread,
      };
    }
    // Thinking-only / redacted-only response (no text, no tool calls). A turn can
    // carry only thinking blocks (even ones whose plaintext is empty but which
    // bear a real signature) or only redacted_thinking blocks (even ones whose
    // `data` is empty and thus dropped from the persisted payload), so key on the
    // PRESENCE of those RAW blocks — not the truthiness of the joined thinking text
    // nor the post-filter `redactedThinking` array — and produce a normal
    // empty-content fixture rather than falling through to the error fallback
    // below. This matches the streaming path, which classifies on content
    // emptiness for the same logical turn. (Per the persistence contract, a bare
    // signature with empty reasoning is still dropped via
    // logDroppedReasoningSignature, and empty-data redacted blocks yield NO
    // redactedThinking field.)
    if (thinkingBlocks.length > 0 || redactedBlocks.length > 0) {
      return {
        content: "",
        ...(anthropicReasoning ? { reasoning: anthropicReasoning } : {}),
        ...reasoningSignatureSpread,
        ...redactedThinkingSpread,
      };
    }
  }

  // Gemini: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const candidate = obj.candidates[0] as Record<string, unknown>;
    const content = candidate.content as Record<string, unknown> | undefined;
    if (content && Array.isArray(content.parts)) {
      const parts = content.parts as Array<Record<string, unknown>>;

      // Audio inlineData parts take priority over text. Key on the PRESENCE of
      // `inlineData.data` rather than solely on the mimeType: an audio part can
      // arrive with a missing or unexpected mimeType, and filtering strictly on
      // an `audio/` prefix would then drop a part that genuinely carries audio
      // bytes, producing an empty b64Json. A NON-audio mimeType (e.g. `image/`)
      // still routes elsewhere, so image inlineData is not misclassified — only
      // an explicit `audio/` prefix OR a missing/blank mimeType counts as audio.
      const audioParts = parts.filter((p: Record<string, unknown>) => {
        const inline = p.inlineData as Record<string, unknown> | undefined;
        if (
          inline === undefined ||
          inline === null ||
          typeof inline.data !== "string" ||
          inline.data.length === 0
        ) {
          return false;
        }
        const mt = inline.mimeType;
        if (typeof mt === "string" && mt.length > 0) {
          return mt.startsWith("audio/");
        }
        // Missing/blank mimeType but data present → treat as audio.
        return true;
      });
      if (audioParts.length > 0) {
        const inlineData = audioParts[0].inlineData as Record<string, unknown>;
        return {
          audio: {
            b64Json: String(inlineData.data ?? ""),
            contentType:
              typeof inlineData.mimeType === "string" && inlineData.mimeType.length > 0
                ? inlineData.mimeType
                : "audio/mpeg",
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
            arguments: toToolCallArguments(fc.args),
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
            arguments: toToolCallArguments(tu.input),
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
    // Join ALL text blocks, not just the first — a multi-block Cohere response
    // would otherwise be truncated to its leading segment.
    const joinedText = contentBlocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => String(b.text ?? ""))
      .join("");
    const hasContent = joinedText.length > 0;
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
                : toToolCallArguments((b.function as Record<string, unknown>)?.arguments),
        ...(b.id ? { id: String(b.id) } : {}),
      }));
      if (hasContent) {
        return { content: joinedText, toolCalls };
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
                  : toToolCallArguments(fn?.arguments),
          ...(tc.id ? { id: String(tc.id) } : {}),
        };
      });
      if (hasContent) {
        return { content: joinedText, toolCalls };
      }
      return { toolCalls };
    }
    if (hasContent) {
      return { content: joinedText };
    }
    // Recognized Cohere v2 shape (finish_reason + message.content array) with
    // no text and no tool calls. Own the empty turn here and return an
    // empty-content fixture rather than falling through to the Ollama branch
    // below, which would re-handle `message.content` and mis-route it.
    return { content: "" };
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
            arguments: toToolCallArguments(fn.arguments),
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
  // Narrowed: require `done` to be a boolean — Ollama always sends a boolean
  // here, and gating merely on `"done" in obj` would capture unrelated payloads
  // that happen to carry a `response` string and some other `done`-keyed value.
  if (typeof obj.response === "string" && typeof obj.done === "boolean") {
    return { content: obj.response };
  }

  // Fallback: unknown format — save as error. Log the observed top-level shape
  // so an unrecognized/new provider response is diagnosable instead of silently
  // becoming an opaque error fixture.
  logger?.warn(
    `Could not detect response format from upstream (status=${status}) — saving as error fixture; top-level keys: [${Object.keys(
      obj,
    ).join(", ")}]`,
  );
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
