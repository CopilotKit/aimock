import * as http from "node:http";
import type { Fixture, ChatCompletionRequest, ChaosConfig, MockServerOptions } from "./types.js";
import { Journal } from "./journal.js";
import { matchFixture } from "./router.js";
import { writeSSEStream, writeErrorResponse } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import {
  buildTextChunks,
  buildToolCallChunks,
  buildTextCompletion,
  buildToolCallCompletion,
  isTextResponse,
  isToolCallResponse,
  isErrorResponse,
  flattenHeaders,
} from "./helpers.js";
import { handleResponses } from "./responses.js";
import { handleMessages } from "./messages.js";
import { handleGemini } from "./gemini.js";
import { handleBedrock } from "./bedrock.js";
import { handleEmbeddings } from "./embeddings.js";
import { upgradeToWebSocket, type WebSocketConnection } from "./ws-framing.js";
import { handleWebSocketResponses } from "./ws-responses.js";
import { handleWebSocketRealtime } from "./ws-realtime.js";
import { handleWebSocketGeminiLive } from "./ws-gemini-live.js";
import { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";

export interface ServerInstance {
  server: http.Server;
  journal: Journal;
  url: string;
  defaults: { latency: number; chunkSize: number; logger: Logger; chaos?: ChaosConfig };
}

const COMPLETIONS_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";
const REALTIME_PATH = "/v1/realtime";
const GEMINI_LIVE_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MESSAGES_PATH = "/v1/messages";
const EMBEDDINGS_PATH = "/v1/embeddings";
const DEFAULT_CHUNK_SIZE = 20;

const GEMINI_PATH_RE = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/;
const AZURE_DEPLOYMENT_RE = /^\/openai\/deployments\/([^/]+)\/(chat\/completions|embeddings)$/;
const BEDROCK_INVOKE_RE = /^\/model\/([^/]+)\/invoke$/;

const HEALTH_PATH = "/health";
const READY_PATH = "/ready";
const MODELS_PATH = "/v1/models";
const REQUESTS_PATH = "/v1/_requests";

const DEFAULT_MODELS = [
  "gpt-4",
  "gpt-4o",
  "claude-3-5-sonnet-20241022",
  "gemini-2.0-flash",
  "text-embedding-3-small",
];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function setCorsHeaders(res: http.ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const buffers: Buffer[] = [];
  for await (const chunk of req) buffers.push(chunk as Buffer);
  return Buffer.concat(buffers).toString();
}

function handleOptions(res: http.ServerResponse): void {
  setCorsHeaders(res);
  res.writeHead(204);
  res.end();
}

function handleNotFound(res: http.ServerResponse, message: string): void {
  setCorsHeaders(res);
  writeErrorResponse(res, 404, JSON.stringify({ error: { message, type: "not_found" } }));
}

async function handleCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fixtures: Fixture[],
  journal: Journal,
  defaults: { latency: number; chunkSize: number; logger: Logger; chaos?: ChaosConfig },
  modelFallback?: string,
): Promise<void> {
  setCorsHeaders(res);

  // Read request body
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to read request body";
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body: {} as ChatCompletionRequest,
      response: { status: 500, fixture: null },
    });
    writeErrorResponse(
      res,
      500,
      JSON.stringify({
        error: {
          message: `Request body read failed: ${msg}`,
          type: "server_error",
        },
      }),
    );
    return;
  }

  // Parse JSON body
  let body: ChatCompletionRequest;
  try {
    body = JSON.parse(raw) as ChatCompletionRequest;
    // Azure deployments may omit model from body — use deployment ID as fallback
    if (modelFallback && !body.model) {
      body.model = modelFallback;
    }
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body: {} as ChatCompletionRequest,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
          code: "invalid_json",
        },
      }),
    );
    return;
  }

  // Match fixture
  const fixture = matchFixture(fixtures, body, journal.fixtureMatchCounts);

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures);
  }

  const method = req.method ?? "POST";
  const path = req.url ?? COMPLETIONS_PATH;
  const flatHeaders = flattenHeaders(req.headers);

  // Apply chaos before normal response handling
  if (
    applyChaos(res, fixture, defaults.chaos, req.headers, journal, {
      method,
      path,
      headers: flatHeaders,
      body,
    })
  )
    return;

  if (!fixture) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 404, fixture: null },
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
    return;
  }

  const response = fixture.response;
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    if (body.stream !== true) {
      const completion = buildTextCompletion(response.content, body.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(completion));
    } else {
      const chunks = buildTextChunks(response.content, body.model, chunkSize);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeSSEStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
      });
      if (!completed) {
        if (!res.writableEnded) res.destroy();
        journalEntry.response.interrupted = true;
        journalEntry.response.interruptReason = interruption?.reason();
      }
      interruption?.cleanup();
    }
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    if (body.stream !== true) {
      const completion = buildToolCallCompletion(response.toolCalls, body.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(completion));
    } else {
      const chunks = buildToolCallChunks(response.toolCalls, body.model, chunkSize);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeSSEStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        signal: interruption?.signal,
        onChunkSent: interruption?.tick,
      });
      if (!completed) {
        if (!res.writableEnded) res.destroy();
        journalEntry.response.interrupted = true;
        journalEntry.response.interruptReason = interruption?.reason();
      }
      interruption?.cleanup();
    }
    return;
  }

  // Fixture response matched no known type — guard against silent hang
  journal.add({
    method: req.method ?? "POST",
    path: req.url ?? COMPLETIONS_PATH,
    headers: flattenHeaders(req.headers),
    body,
    response: { status: 500, fixture },
  });
  writeErrorResponse(
    res,
    500,
    JSON.stringify({
      error: {
        message: "Fixture response did not match any known type",
        type: "server_error",
      },
    }),
  );
}

// NOTE: The fixtures array is read by reference on each request. Callers
// (e.g. LLMock) may mutate it after the server starts and changes will
// be visible immediately. This is intentional — do not copy the array.
export async function createServer(
  fixtures: Fixture[],
  options?: MockServerOptions,
): Promise<ServerInstance> {
  const host = options?.host ?? "127.0.0.1";
  const port = options?.port ?? 0;
  const logger = new Logger(options?.logLevel ?? "silent");
  const defaults = {
    latency: options?.latency ?? 0,
    chunkSize: Math.max(1, options?.chunkSize ?? DEFAULT_CHUNK_SIZE),
    logger,
    chaos: options?.chaos,
  };

  const journal = new Journal();

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    // OPTIONS preflight
    if (req.method === "OPTIONS") {
      handleOptions(res);
      return;
    }

    // Parse the URL pathname (strip query string)
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let pathname = parsedUrl.pathname;

    // Azure OpenAI: /openai/deployments/{id}/{operation} → /v1/{operation} (chat/completions, embeddings)
    // Must be checked BEFORE the generic /openai/ prefix strip
    let azureDeploymentId: string | undefined;
    const azureMatch = pathname.match(AZURE_DEPLOYMENT_RE);
    if (azureMatch && req.method === "POST") {
      azureDeploymentId = azureMatch[1];
      const operation = azureMatch[2];
      pathname = `/v1/${operation}`;
    }

    // Groq/OpenAI-compatible alias: strip /openai prefix so that
    // /openai/v1/chat/completions → /v1/chat/completions, etc.
    if (!azureDeploymentId && pathname.startsWith("/openai/")) {
      pathname = pathname.slice(7); // remove "/openai" prefix, keep the rest
    }

    // Health / readiness probes
    if (pathname === HEALTH_PATH && req.method === "GET") {
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (pathname === READY_PATH && req.method === "GET") {
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ready" }));
      return;
    }

    // Models listing
    if (pathname === MODELS_PATH && req.method === "GET") {
      setCorsHeaders(res);
      const modelIds = new Set<string>();
      for (const f of fixtures) {
        if (f.match.model && typeof f.match.model === "string") {
          modelIds.add(f.match.model);
        }
      }
      const ids = modelIds.size > 0 ? [...modelIds] : DEFAULT_MODELS;
      const data = ids.map((id) => ({
        id,
        object: "model" as const,
        created: 1686935002,
        owned_by: "llmock",
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
      return;
    }

    // Journal inspection endpoints
    if (pathname === REQUESTS_PATH) {
      setCorsHeaders(res);
      if (req.method === "GET") {
        const limitParam = parsedUrl.searchParams.get("limit");
        let opts: { limit: number } | undefined;
        if (limitParam) {
          const limit = parseInt(limitParam, 10);
          if (Number.isNaN(limit) || limit <= 0) {
            writeErrorResponse(
              res,
              400,
              JSON.stringify({
                error: {
                  message: `Invalid limit parameter: "${limitParam}"`,
                  type: "invalid_request_error",
                },
              }),
            );
            return;
          }
          opts = { limit };
        }
        const entries = journal.getAll(opts);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(entries));
        return;
      }
      if (req.method === "DELETE") {
        journal.clear();
        res.writeHead(204);
        res.end();
        return;
      }
      handleNotFound(res, "Not found");
      return;
    }

    // POST /v1/responses — OpenAI Responses API
    if (pathname === RESPONSES_PATH && req.method === "POST") {
      readBody(req)
        .then((raw) => handleResponses(req, res, raw, fixtures, journal, defaults, setCorsHeaders))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Internal error";
          if (!res.headersSent) {
            writeErrorResponse(
              res,
              500,
              JSON.stringify({ error: { message: msg, type: "server_error" } }),
            );
          } else if (!res.writableEnded) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ error: { message: msg } })}\n\n`);
            } catch {
              /* */
            }
            res.end();
          }
        });
      return;
    }

    // POST /v1/messages — Anthropic Claude Messages API
    if (pathname === MESSAGES_PATH && req.method === "POST") {
      readBody(req)
        .then((raw) => handleMessages(req, res, raw, fixtures, journal, defaults, setCorsHeaders))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Internal error";
          if (!res.headersSent) {
            writeErrorResponse(
              res,
              500,
              JSON.stringify({ error: { message: msg, type: "server_error" } }),
            );
          } else if (!res.writableEnded) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ error: { message: msg } })}\n\n`);
            } catch {
              /* */
            }
            res.end();
          }
        });
      return;
    }

    // POST /v1/embeddings — OpenAI Embeddings API
    if (pathname === EMBEDDINGS_PATH && req.method === "POST") {
      const deploymentId = azureDeploymentId;
      readBody(req)
        .then((raw) => {
          // Azure deployments may omit model from body — use deployment ID as fallback
          if (deploymentId) {
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              if (!parsed.model) {
                parsed.model = deploymentId;
                return handleEmbeddings(
                  req,
                  res,
                  JSON.stringify(parsed),
                  fixtures,
                  journal,
                  defaults,
                  setCorsHeaders,
                );
              }
            } catch {
              // Fall through — let handleEmbeddings report the parse error
            }
          }
          return handleEmbeddings(req, res, raw, fixtures, journal, defaults, setCorsHeaders);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Internal error";
          if (!res.headersSent) {
            writeErrorResponse(
              res,
              500,
              JSON.stringify({ error: { message: msg, type: "server_error" } }),
            );
          } else if (!res.writableEnded) {
            res.destroy();
          }
        });
      return;
    }

    // POST /v1beta/models/{model}:(generateContent|streamGenerateContent) — Google Gemini
    const geminiMatch = pathname.match(GEMINI_PATH_RE);
    if (geminiMatch && req.method === "POST") {
      const geminiModel = geminiMatch[1];
      const streaming = geminiMatch[2] === "streamGenerateContent";
      readBody(req)
        .then((raw) =>
          handleGemini(
            req,
            res,
            raw,
            geminiModel,
            streaming,
            fixtures,
            journal,
            defaults,
            setCorsHeaders,
          ),
        )
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Internal error";
          if (!res.headersSent) {
            writeErrorResponse(
              res,
              500,
              JSON.stringify({ error: { message: msg, type: "server_error" } }),
            );
          } else if (!res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
            } catch {
              /* */
            }
            res.end();
          }
        });
      return;
    }

    // POST /model/{modelId}/invoke — AWS Bedrock Claude API
    const bedrockMatch = pathname.match(BEDROCK_INVOKE_RE);
    if (bedrockMatch && req.method === "POST") {
      const bedrockModelId = bedrockMatch[1];
      readBody(req)
        .then((raw) =>
          handleBedrock(req, res, raw, bedrockModelId, fixtures, journal, defaults, setCorsHeaders),
        )
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Internal error";
          if (!res.headersSent) {
            writeErrorResponse(
              res,
              500,
              JSON.stringify({ error: { message: msg, type: "server_error" } }),
            );
          } else if (!res.writableEnded) {
            res.destroy();
          }
        });
      return;
    }

    // POST /v1/chat/completions — Chat Completions API
    if (pathname !== COMPLETIONS_PATH) {
      handleNotFound(res, "Not found");
      return;
    }
    if (req.method !== "POST") {
      handleNotFound(res, "Not found");
      return;
    }

    handleCompletions(req, res, fixtures, journal, defaults, azureDeploymentId).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Internal error";
        if (!res.headersSent) {
          writeErrorResponse(
            res,
            500,
            JSON.stringify({
              error: {
                message: msg,
                type: "server_error",
              },
            }),
          );
        } else if (!res.writableEnded) {
          // Headers already sent (SSE stream in progress) — write error event then close
          try {
            res.write(
              `data: ${JSON.stringify({ error: { message: msg, type: "server_error" } })}\n\n`,
            );
          } catch {
            // write itself failed, nothing more we can do
          }
          res.end();
        }
      },
    );
  });

  // ─── WebSocket upgrade handling ──────────────────────────────────────────

  const activeConnections = new Set<WebSocketConnection>();

  server.on(
    "upgrade",
    (req: http.IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = parsedUrl.pathname;

      if (
        pathname !== RESPONSES_PATH &&
        pathname !== REALTIME_PATH &&
        pathname !== GEMINI_LIVE_PATH
      ) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      // Push any buffered data back before upgrading
      if (head.length > 0) {
        socket.unshift(head);
      }

      let ws: WebSocketConnection;
      try {
        ws = upgradeToWebSocket(req, socket);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "WebSocket upgrade failed";
        logger.error(`WebSocket upgrade error: ${msg}`);
        if (!socket.destroyed) socket.destroy();
        return;
      }

      activeConnections.add(ws);

      ws.on("error", (err: Error) => {
        logger.error(`WebSocket error: ${err.message}`);
        activeConnections.delete(ws);
      });

      ws.on("close", () => {
        activeConnections.delete(ws);
      });

      // Route to handler
      if (pathname === RESPONSES_PATH) {
        handleWebSocketResponses(ws, fixtures, journal, {
          ...defaults,
          model: "gpt-4",
        });
      } else if (pathname === REALTIME_PATH) {
        const model = parsedUrl.searchParams.get("model") ?? "gpt-4o-realtime";
        handleWebSocketRealtime(ws, fixtures, journal, {
          ...defaults,
          model,
        });
      } else if (pathname === GEMINI_LIVE_PATH) {
        handleWebSocketGeminiLive(ws, fixtures, journal, {
          ...defaults,
          model: "gemini-2.0-flash",
        });
      }
    },
  );

  // Close active WS connections when server shuts down
  const originalClose = server.close.bind(server);
  server.close = function (this: http.Server, callback?: (err?: Error) => void) {
    for (const ws of activeConnections) {
      ws.close(1001, "Server shutting down");
    }
    activeConnections.clear();
    originalClose(callback);
    return this;
  } as typeof server.close;

  return new Promise<ServerInstance>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected address format"));
        return;
      }
      const url = `http://${addr.address}:${addr.port}`;
      resolve({ server, journal, url, defaults });
    });
  });
}
