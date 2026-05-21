import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AGUIFixture, AGUIRecordConfig, AGUIEvent, AGUIRunAgentInput } from "./agui-types.js";
import { extractLastUserMessage } from "./agui-handler.js";
import type { Logger } from "./logger.js";

/**
 * Sentinel `match.message` value written to disk when the request had no
 * extractable user text. Keeps the on-disk fixture serializable (predicate
 * matchers aren't) but won't match any real user input on replay.
 */
export const NO_USER_MESSAGE_SENTINEL = "__NO_USER_MESSAGE__";

/**
 * Proxy an unmatched AG-UI request to a real upstream agent, record the
 * SSE event stream as a fixture on disk and in memory, and relay the
 * response back to the original client in real time.
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
): Promise<number | false> {
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

  // Build upstream request headers
  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  // Forward auth headers if present
  const authorization = req.headers["authorization"];
  if (authorization) {
    forwardHeaders["Authorization"] = Array.isArray(authorization)
      ? authorization.join(", ")
      : authorization;
  }
  const apiKey = req.headers["x-api-key"];
  if (apiKey) {
    forwardHeaders["x-api-key"] = Array.isArray(apiKey) ? apiKey.join(", ") : apiKey;
  }

  const requestBody = JSON.stringify(input);

  let status: number;
  try {
    status = await teeUpstreamStream(
      target,
      forwardHeaders,
      requestBody,
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
          // Buffer for fixture construction
          chunks.push(chunk);
        });

        upstreamRes.on("error", (err) => {
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
          try {
            if (!clientRes.writableEnded) clientRes.end();
          } catch (writeErr) {
            logger.warn(
              "Failed to end client response:",
              writeErr instanceof Error ? writeErr.message : String(writeErr),
            );
          }

          // Parse buffered SSE events
          const buffered = Buffer.concat(chunks).toString();
          const events = parseSSEEvents(buffered, logger);

          // Build fixture
          const message = extractLastUserMessage(input);
          const fixture: AGUIFixture = {
            match: message
              ? { message }
              : {
                  predicate: (inp: AGUIRunAgentInput) =>
                    !inp.messages?.length || !inp.messages.some((m) => m.role === "user"),
                },
            events,
          };
          if (!message) {
            logger.warn(
              `Recorded AG-UI fixture has no user message — will use ${NO_USER_MESSAGE_SENTINEL} sentinel on disk`,
            );
          }

          if (!config.proxyOnly) {
            // Register in memory first (always available even if disk write fails)
            fixtures.push(fixture);

            // Write to disk — predicate functions are not serializable,
            // so replace with a sentinel string that won't match real user messages.
            const serializableFixture = {
              match: fixture.match.predicate
                ? { message: NO_USER_MESSAGE_SENTINEL }
                : fixture.match,
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
          if (logger) logger.warn(`Skipping unparseable SSE data line: ${payload.slice(0, 200)}`);
          else console.warn(`Skipping unparseable SSE data line: ${msg}`);
        }
      }
    }
  }
  return events;
}
