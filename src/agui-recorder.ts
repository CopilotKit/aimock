import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  AGUIFixture,
  AGUIFixtureMatch,
  AGUIRecordConfig,
  AGUIEvent,
  AGUIRunAgentInput,
} from "./agui-types.js";
import { extractLastUserMessage, getLastMessageIfToolResult } from "./agui-handler.js";
import type { Logger } from "./logger.js";
import { isAuthenticatedRequest } from "./api-key-auth.js";
import { buildForwardHeaders, removeForwardHeader, setForwardHeaderDefault } from "./recorder.js";

/**
 * Sentinel `match.message` value written to disk when the request had no
 * extractable user text. Keeps the on-disk fixture serializable (predicate
 * matchers aren't) but won't match any real user input on replay.
 */
export const NO_USER_MESSAGE_SENTINEL = "__NO_USER_MESSAGE__";

/**
 * Default ceiling (bytes) for the in-memory AG-UI record buffer. The recorder
 * tees every upstream SSE chunk straight to the client AND buffers a copy so it
 * can `Buffer.concat(chunks).toString()` + parse the SSE events into a fixture
 * once the stream ends. With no cap, a large upstream response (amplified since
 * the real-key fixture-miss passthrough landed) builds a string past V8's
 * ~512 MiB max string length and throws `RangeError: Invalid string length`.
 * 64 MiB mirrors the generic proxy path's `DEFAULT_MAX_PROXY_BUFFER_BYTES` and
 * is generous for any real agent turn. Overridable via
 * `AGUIRecordConfig.maxRecordBufferBytes`.
 */
export const DEFAULT_AGUI_RECORD_BUFFER_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Absolute hard ceiling (bytes) for the AG-UI record buffer, independent of the
 * configurable `maxRecordBufferBytes`, mirroring the generic proxy path's
 * `PROXY_BUFFER_HARD_CEILING`. 256 MiB of bytes can never decode to more than
 * 256 Mi UTF-16 code units, comfortably below V8's 2^29 - 1 string-length limit,
 * so the eventual `Buffer.concat(chunks).toString()` can never throw.
 */
export const AGUI_RECORD_BUFFER_HARD_CEILING = 256 * 1024 * 1024; // 256 MiB

/**
 * Test-only override of the effective AG-UI record-buffer ceiling. Lets the cap
 * suite exercise the over-cap truncation path with a small body instead of
 * streaming hundreds of MB. `undefined` (the default) uses the configured /
 * default cap. NEVER set from production code.
 */
let aguiRecordBufferCeilingOverride: number | undefined;

/** @internal test-only — see {@link aguiRecordBufferCeilingOverride}. */
export function setAGUIRecordBufferCeilingForTests(value: number | undefined): void {
  aguiRecordBufferCeilingOverride = value;
}

/**
 * Resolve the effective AG-UI record-buffer byte cap: honor a test-only
 * override, else the configured `maxRecordBufferBytes` (clamped to the hard
 * ceiling), else the default. Non-finite / non-positive configured values fall
 * back to the default.
 */
function resolveAGUIRecordBufferCap(configured: number | undefined): number {
  if (aguiRecordBufferCeilingOverride !== undefined) return aguiRecordBufferCeilingOverride;
  if (configured == null || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_AGUI_RECORD_BUFFER_BYTES;
  }
  return Math.min(configured, AGUI_RECORD_BUFFER_HARD_CEILING);
}

/**
 * Proxy an unmatched AG-UI request to a real upstream agent, record the
 * SSE event stream as a fixture on disk and in memory, and relay the
 * response back to the original client in real time.
 *
 * `rawBody` is the exact request payload as it arrived on the wire. It is
 * forwarded byte-for-byte rather than re-serialized from the parsed `input`,
 * because re-serialization changes key order and whitespace and therefore
 * invalidates any signature the caller computed over the body (AWS SigV4 signs
 * a hash of the payload). `input` remains the parsed view used for fixture
 * matching only. It is the LAST parameter so that a pre-existing JavaScript
 * caller omitting it fails loudly here rather than silently shifting an
 * earlier argument into the request body.
 *
 * Returns the HTTP status code written to the client if the request was proxied,
 * or `false` if no upstream is configured.
 */
export async function proxyAndRecordAGUI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  input: AGUIRunAgentInput,
  fixtures: AGUIFixture[],
  config: AGUIRecordConfig,
  logger: Logger,
  rawBody: string,
): Promise<number | false> {
  // A caller that predates the raw-body parameter would otherwise proxy
  // `undefined` as the payload. Refuse before opening an upstream connection.
  if (typeof rawBody !== "string") {
    logger.error("proxyAndRecordAGUI called without the raw request body — cannot proxy");
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal proxy misconfiguration" }));
    return 500;
  }
  // AG-UI has no provider-specific static credential contract. An inbound
  // test key must never become an implicit upstream credential, so fail before
  // opening an upstream connection.
  if (isAuthenticatedRequest(req)) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No configured provider credential" }));
    return 502;
  }
  if (!config.upstream) {
    logger.warn("No upstream URL configured for AG-UI recording — cannot proxy");
    return false;
  }

  let target: URL;
  try {
    target = new URL(config.upstream);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(`Invalid upstream AG-UI URL: ${config.upstream} — ${detail}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid upstream AG-UI URL" }));
    return 502;
  }

  logger.warn(`NO AG-UI FIXTURE MATCH — proxying to ${config.upstream}`);

  // Forward the inbound headers to the upstream agent, minus hop-by-hop,
  // client-set, and mock-internal ones — the same egress rule the generic
  // proxy path applies. An agent runtime's contract frequently lives in
  // headers (session affinity, per-request agent configuration, request
  // signatures), so the proxy strips a known-unsafe set rather than keeping a
  // hand-picked allowlist that silently drops everything it has not heard of.
  const forwardHeaders = buildForwardHeaders(req);
  // `Content-Type` describes the bytes the CALLER sent, so the caller owns it
  // and this only fills in a default. Signed requests depend on that: replacing
  // a caller-sent Content-Type invalidates a SigV4 signature computed over it.
  setForwardHeaderDefault(forwardHeaders, "Content-Type", "application/json");
  // `Accept` is the opposite: it describes what AIMOCK needs back. AG-UI is an
  // SSE protocol and the recorder can only parse an event stream, so a caller's
  // generic `*/*` or `application/json, text/plain, */*` must not be forwarded
  // to an upstream that content-negotiates — it would answer with JSON, which
  // relays to the client mislabelled and records as a zero-event fixture.
  // Overriding is safe here where it is not for Content-Type: AWS signs `host`,
  // `content-type` and the `x-amz-*` family, and `accept` is not in
  // `SignedHeaders`.
  removeForwardHeader(forwardHeaders, "Accept");
  forwardHeaders["Accept"] = "text/event-stream";

  let status: number;
  try {
    status = await teeUpstreamStream(
      target,
      forwardHeaders,
      rawBody,
      res,
      input,
      fixtures,
      config,
      logger,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown proxy error";
    logger.error(`AG-UI proxy request failed: ${msg}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Upstream AG-UI agent unreachable" }));
    } else if (!res.writableEnded) {
      res.end();
    }
    status = 502;
  }

  return status;
}

// ---------------------------------------------------------------------------
// Internal: tee the upstream SSE stream to the client and buffer for recording
// ---------------------------------------------------------------------------

function teeUpstreamStream(
  target: URL,
  headers: Record<string, string>,
  body: string,
  clientRes: http.ServerResponse,
  input: AGUIRunAgentInput,
  fixtures: AGUIFixture[],
  config: AGUIRecordConfig,
  logger: Logger,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const UPSTREAM_TIMEOUT_MS = 30_000;

    const upstreamReq = transport.request(
      target,
      {
        method: "POST",
        timeout: UPSTREAM_TIMEOUT_MS,
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (upstreamRes) => {
        const upstreamStatus = upstreamRes.statusCode ?? 200;

        // Normalize status codes: aimock acts as a gateway, so upstream
        // provider details (429, 503, etc.) should not leak.
        // Successes → 200, errors → 502 (Bad Gateway).
        const clientStatus = upstreamStatus >= 200 && upstreamStatus < 300 ? 200 : 502;

        // Set appropriate headers on the client response.
        if (!clientRes.headersSent) {
          if (clientStatus === 200) {
            clientRes.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
          } else {
            const ct = upstreamRes.headers["content-type"] || "application/json";
            clientRes.writeHead(502, { "Content-Type": ct });
          }
        }

        const chunks: Buffer[] = [];
        let clientWriteFailed = false;
        // Bound the in-memory record buffer so a single huge upstream response
        // cannot build a string past V8's ~512 MiB limit
        // (RangeError: Invalid string length) when we `Buffer.concat`+stringify
        // it below. The client relay above is INDEPENDENT of this buffer, so
        // capping it never truncates what the client receives — the cap means
        // "don't journal", not "don't answer" (mirrors the generic proxy path).
        const recordBufferCap = resolveAGUIRecordBufferCap(config.maxRecordBufferBytes);
        let bufferedBytes = 0;
        let recordTruncated = false;

        upstreamRes.on("data", (chunk: Buffer) => {
          // Relay to client in real time
          try {
            clientRes.write(chunk);
          } catch (err) {
            if (!clientWriteFailed) {
              clientWriteFailed = true;
              logger?.warn(
                "Client write failed during proxy relay:",
                err instanceof Error ? err.message : String(err),
              );
            }
          }
          // Buffer for fixture construction, bounded by the record-buffer cap.
          // Once the cap is crossed we stop accumulating and free the buffer so
          // heap growth is bounded and the end-handler skips concat/stringify.
          if (recordTruncated) return;
          if (bufferedBytes + chunk.length > recordBufferCap) {
            recordTruncated = true;
            chunks.length = 0;
            bufferedBytes = 0;
            logger?.warn(
              `AG-UI upstream response exceeded the ${recordBufferCap}-byte record buffer cap — relaying full body to client, but skipping fixture recording to bound memory`,
            );
            return;
          }
          chunks.push(chunk);
          bufferedBytes += chunk.length;
        });

        let settled = false;

        upstreamRes.on("error", (err) => {
          if (settled) return;
          settled = true;
          try {
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { "Content-Type": "application/json" });
              clientRes.end(JSON.stringify({ error: "Upstream AG-UI agent unreachable" }));
            } else if (!clientRes.writableEnded) {
              clientRes.end();
            }
          } catch (writeErr) {
            logger.warn(
              "Failed to write error response to client:",
              writeErr instanceof Error ? writeErr.message : String(writeErr),
            );
          }
          reject(err);
        });

        upstreamRes.on("end", () => {
          if (settled) return;
          settled = true;

          // Don't record fixtures for non-2xx upstream responses
          if (clientStatus !== 200) {
            try {
              if (!clientRes.writableEnded) clientRes.end();
            } catch (writeErr) {
              logger.warn(
                "Failed to end client response:",
                writeErr instanceof Error ? writeErr.message : String(writeErr),
              );
            }
            resolve(clientStatus);
            return;
          }
          try {
            if (!clientRes.writableEnded) clientRes.end();
          } catch (writeErr) {
            logger.warn(
              "Failed to end client response:",
              writeErr instanceof Error ? writeErr.message : String(writeErr),
            );
          }

          // Record buffer cap tripped: the buffered copy is partial (and was
          // freed), so we cannot faithfully build a fixture. The client already
          // received every byte via the live tee above, so just skip recording
          // — never stringify the (now-empty) buffer, never persist a truncated
          // fixture. Mirrors the generic proxy path's over-cap "skip recording,
          // still answer the client" behavior.
          if (recordTruncated) {
            logger.warn(
              "AG-UI record buffer cap exceeded — response relayed to client, recording skipped",
            );
            resolve(clientStatus);
            return;
          }

          // A 2xx upstream that did not answer with an event stream cannot be
          // recorded. `parseSSEEvents` finds no `data:` lines in a JSON body and
          // returns [], which would persist a zero-event fixture — and that
          // fixture then MATCHES on replay and streams nothing, with no
          // "NO AG-UI FIXTURE MATCH" and no parse warning to chase. Refuse the
          // recording and say why, rather than writing a tape that looks valid.
          // The client has already received every byte via the live tee above.
          const upstreamContentType = upstreamRes.headers["content-type"] ?? "";
          if (!/text\/event-stream/i.test(upstreamContentType)) {
            logger.error(
              `Upstream answered ${upstreamStatus} with Content-Type "${upstreamContentType || "(none)"}", not text/event-stream — response relayed to the client, recording refused`,
            );
            resolve(clientStatus);
            return;
          }

          // Parse buffered SSE events
          const buffered = Buffer.concat(chunks).toString();
          const events = parseSSEEvents(buffered, logger);

          // Same reasoning as the Content-Type refusal: an event stream that
          // yielded nothing parseable must not become a fixture.
          if (events.length === 0) {
            logger.error(
              "Upstream event stream contained no parseable AG-UI events — response relayed to the client, recording refused",
            );
            resolve(clientStatus);
            return;
          }

          // Build fixture — three-way match priority:
          // 1. Tool-result continuation (HITL): match by toolCallId
          // 2. User message: match by last user message content
          // 3. Fallback predicate: no user message present
          let match: AGUIFixtureMatch;
          const lastToolResult = getLastMessageIfToolResult(input);
          if (lastToolResult?.toolCallId) {
            match = { toolCallId: lastToolResult.toolCallId };
            logger.info(`Recorded AG-UI fixture keyed on toolCallId=${lastToolResult.toolCallId}`);
          } else {
            const message = extractLastUserMessage(input);
            if (message) {
              match = { message };
            } else {
              match = {
                predicate: (inp: AGUIRunAgentInput) =>
                  !inp.messages?.length || !inp.messages.some((m) => m.role === "user"),
              };
              logger.warn(
                "Recorded AG-UI fixture has no user message — available in-memory only (predicate fixtures cannot be persisted to disk)",
              );
            }
          }
          const fixture: AGUIFixture = { match, events };

          if (!config.proxyOnly) {
            // Register in memory first (always available even if disk write fails)
            fixtures.push(fixture);

            // Predicate fixtures (no user message, no toolCallId) cannot be
            // meaningfully serialized — the sentinel becomes a literal string
            // match that never matches real requests. Keep in-memory only.
            if (fixture.match.predicate) {
              logger.warn(
                "Skipping disk write for predicate fixture — in-memory only (cannot be persisted)",
              );
            } else {
              const serializableFixture = {
                match: fixture.match,
                events: fixture.events,
                ...(fixture.delayMs !== undefined ? { delayMs: fixture.delayMs } : {}),
              };

              const fixturePath = config.fixturePath ?? "./fixtures/agui-recorded";
              const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
              const filename = `agui-${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`;
              const filepath = path.join(fixturePath, filename);

              try {
                fs.mkdirSync(fixturePath, { recursive: true });
                fs.writeFileSync(
                  filepath,
                  JSON.stringify({ fixtures: [serializableFixture] }, null, 2),
                  "utf-8",
                );
                logger.warn(`AG-UI response recorded → ${filepath}`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : "Unknown filesystem error";
                logger.error(
                  `Failed to save AG-UI fixture to disk: ${msg} (fixture retained in memory)`,
                );
              }
            }
          } else {
            logger.info("Proxied AG-UI request (proxy-only mode)");
          }

          resolve(clientStatus);
        });
      },
    );

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(
        new Error(`Upstream AG-UI request timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s`),
      );
    });

    upstreamReq.on("error", (err) => {
      try {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "Content-Type": "application/json" });
          clientRes.end(JSON.stringify({ error: "Upstream AG-UI agent unreachable" }));
        } else if (!clientRes.writableEnded) {
          clientRes.end();
        }
      } catch (writeErr) {
        logger.warn(
          "Failed to write error response to client:",
          writeErr instanceof Error ? writeErr.message : String(writeErr),
        );
      }
      reject(err);
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
}

/**
 * Parse SSE data lines from buffered stream text.
 */
function parseSSEEvents(text: string, logger?: Logger): AGUIEvent[] {
  const events: AGUIEvent[] = [];
  const blocks = text.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const payload = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
        try {
          const parsed = JSON.parse(payload) as AGUIEvent;
          events.push(parsed);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const warning = `Skipping unparseable SSE data line (${msg}): ${payload.slice(0, 200)}`;
          if (logger) logger.warn(warning);
          else console.warn(warning);
        }
      }
    }
  }
  return events;
}
