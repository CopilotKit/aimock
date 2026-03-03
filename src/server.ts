import * as http from "node:http";
import type { Fixture, ChatCompletionRequest, MockServerOptions } from "./types.js";
import { Journal } from "./journal.js";
import { matchFixture } from "./router.js";
import { writeSSEStream, writeErrorResponse } from "./sse-writer.js";
import {
  buildTextChunks,
  buildToolCallChunks,
  buildTextCompletion,
  buildToolCallCompletion,
  isTextResponse,
  isToolCallResponse,
  isErrorResponse,
} from "./helpers.js";
import { handleResponses } from "./responses.js";
import { handleMessages } from "./messages.js";
import { handleGemini } from "./gemini.js";

export interface ServerInstance {
  server: http.Server;
  journal: Journal;
  url: string;
}

const COMPLETIONS_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";
const MESSAGES_PATH = "/v1/messages";
const DEFAULT_CHUNK_SIZE = 20;

const GEMINI_PATH_RE = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/;

const REQUESTS_PATH = "/v1/_requests";

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
  defaults: { latency: number; chunkSize: number },
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
  const fixture = matchFixture(fixtures, body);

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
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    if (body.stream === false) {
      const completion = buildTextCompletion(response.content, body.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(completion));
    } else {
      const chunks = buildTextChunks(response.content, body.model, chunkSize);
      await writeSSEStream(res, chunks, latency);
    }
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? COMPLETIONS_PATH,
      headers: flattenHeaders(req.headers),
      body,
      response: { status: 200, fixture },
    });
    if (body.stream === false) {
      const completion = buildToolCallCompletion(response.toolCalls, body.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(completion));
    } else {
      const chunks = buildToolCallChunks(response.toolCalls, body.model, chunkSize);
      await writeSSEStream(res, chunks, latency);
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

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
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
  const defaults = {
    latency: options?.latency ?? 0,
    chunkSize: Math.max(1, options?.chunkSize ?? DEFAULT_CHUNK_SIZE),
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
    const pathname = parsedUrl.pathname;

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

    // POST /v1/chat/completions — Chat Completions API
    if (pathname !== COMPLETIONS_PATH) {
      handleNotFound(res, "Not found");
      return;
    }
    if (req.method !== "POST") {
      handleNotFound(res, "Not found");
      return;
    }

    handleCompletions(req, res, fixtures, journal, defaults).catch((err: unknown) => {
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
    });
  });

  return new Promise<ServerInstance>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected address format"));
        return;
      }
      const url = `http://${addr.address}:${addr.port}`;
      resolve({ server, journal, url });
    });
  });
}
