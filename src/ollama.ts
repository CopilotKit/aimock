/**
 * Ollama API endpoint support.
 *
 * Translates incoming /api/chat and /api/generate requests into the
 * ChatCompletionRequest format used by the fixture router, and converts
 * fixture responses back into Ollama's NDJSON streaming or non-streaming format.
 *
 * Key differences from OpenAI:
 * - Ollama defaults to stream: true (opposite of OpenAI)
 * - Streaming uses NDJSON, not SSE
 * - Tool call arguments are objects, not JSON strings
 * - Tool calls have no id field
 */

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  HandlerDefaults,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { isTextResponse, isToolCallResponse, isErrorResponse, flattenHeaders } from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { writeNDJSONStream } from "./ndjson-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Ollama request types ────────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

interface OllamaToolDef {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean; // default true!
  options?: { temperature?: number; num_predict?: number };
  tools?: OllamaToolDef[];
}

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean; // default true!
  options?: { temperature?: number; num_predict?: number };
}

// ─── Duration fields (zeroed, required on final/non-streaming responses) ────

const DURATION_FIELDS = {
  done_reason: "stop" as const,
  total_duration: 0,
  load_duration: 0,
  prompt_eval_count: 0,
  prompt_eval_duration: 0,
  eval_count: 0,
  eval_duration: 0,
};

// ─── Input conversion: Ollama → ChatCompletionRequest ────────────────────────

export function ollamaToCompletionRequest(req: OllamaRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  for (const msg of req.messages) {
    messages.push({
      role: msg.role as ChatMessage["role"],
      content: msg.content,
    });
  }

  // Convert tools
  let tools: ToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
  }

  return {
    model: req.model,
    messages,
    stream: req.stream,
    temperature: req.options?.temperature,
    max_tokens: req.options?.num_predict,
    tools,
  };
}

function ollamaGenerateToCompletionRequest(req: OllamaGenerateRequest): ChatCompletionRequest {
  return {
    model: req.model,
    messages: [{ role: "user", content: req.prompt }],
    stream: req.stream,
    temperature: req.options?.temperature,
    max_tokens: req.options?.num_predict,
  };
}

// ─── Response builders: /api/chat ────────────────────────────────────────────

function buildOllamaChatTextChunks(content: string, model: string, chunkSize: number): object[] {
  const chunks: object[] = [];

  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    chunks.push({
      model,
      message: { role: "assistant", content: slice },
      done: false,
    });
  }

  // Final chunk with done: true and all duration fields
  chunks.push({
    model,
    message: { role: "assistant", content: "" },
    done: true,
    ...DURATION_FIELDS,
  });

  return chunks;
}

function buildOllamaChatTextResponse(content: string, model: string): object {
  return {
    model,
    message: { role: "assistant", content },
    done: true,
    ...DURATION_FIELDS,
  };
}

function buildOllamaChatToolCallChunks(
  toolCalls: ToolCall[],
  model: string,
  logger: Logger,
): object[] {
  const ollamaToolCalls = toolCalls.map((tc) => {
    let argsObj: unknown;
    try {
      argsObj = JSON.parse(tc.arguments || "{}");
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsObj = {};
    }
    return {
      function: {
        name: tc.name,
        arguments: argsObj,
      },
    };
  });

  // Tool calls are sent in a single chunk (no streaming of individual args)
  const chunks: object[] = [];
  chunks.push({
    model,
    message: {
      role: "assistant",
      content: "",
      tool_calls: ollamaToolCalls,
    },
    done: false,
  });

  // Final chunk
  chunks.push({
    model,
    message: { role: "assistant", content: "" },
    done: true,
    ...DURATION_FIELDS,
  });

  return chunks;
}

function buildOllamaChatToolCallResponse(
  toolCalls: ToolCall[],
  model: string,
  logger: Logger,
): object {
  const ollamaToolCalls = toolCalls.map((tc) => {
    let argsObj: unknown;
    try {
      argsObj = JSON.parse(tc.arguments || "{}");
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsObj = {};
    }
    return {
      function: {
        name: tc.name,
        arguments: argsObj,
      },
    };
  });

  return {
    model,
    message: {
      role: "assistant",
      content: "",
      tool_calls: ollamaToolCalls,
    },
    done: true,
    ...DURATION_FIELDS,
  };
}

// ─── Response builders: /api/generate ────────────────────────────────────────

function buildOllamaGenerateTextChunks(
  content: string,
  model: string,
  chunkSize: number,
): object[] {
  const chunks: object[] = [];
  const createdAt = new Date().toISOString();

  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    chunks.push({
      model,
      created_at: createdAt,
      response: slice,
      done: false,
    });
  }

  // Final chunk
  chunks.push({
    model,
    created_at: createdAt,
    response: "",
    done: true,
    ...DURATION_FIELDS,
    context: [],
  });

  return chunks;
}

function buildOllamaGenerateTextResponse(content: string, model: string): object {
  return {
    model,
    created_at: new Date().toISOString(),
    response: content,
    done: true,
    ...DURATION_FIELDS,
    context: [],
  };
}

// ─── Request handler: /api/chat ──────────────────────────────────────────────

export async function handleOllama(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  const urlPath = req.url ?? "/api/chat";

  let ollamaReq: OllamaRequest;
  try {
    ollamaReq = JSON.parse(raw) as OllamaRequest;
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!ollamaReq.messages || !Array.isArray(ollamaReq.messages)) {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Invalid request: messages array is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = ollamaToCompletionRequest(ollamaReq);

  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.fixtureMatchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      {
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: completionReq,
      },
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
        completionReq,
        "ollama",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null },
        });
        return;
      }
    }
    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (defaults.strict) {
      logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${urlPath}`);
    }
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: strictStatus, fixture: null },
    });
    writeErrorResponse(
      res,
      strictStatus,
      JSON.stringify({
        error: {
          message: strictMessage,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const response = fixture.response;
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Ollama defaults to streaming when stream is absent or true
  const streaming = ollamaReq.stream !== false;

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildOllamaChatTextResponse(response.content, completionReq.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildOllamaChatTextChunks(response.content, completionReq.model, chunkSize);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeNDJSONStream(res, chunks, {
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
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildOllamaChatToolCallResponse(response.toolCalls, completionReq.model, logger);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildOllamaChatToolCallChunks(response.toolCalls, completionReq.model, logger);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeNDJSONStream(res, chunks, {
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

  // Unknown response type
  journal.add({
    method: req.method ?? "POST",
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: completionReq,
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

// ─── Request handler: /api/generate ──────────────────────────────────────────

export async function handleOllamaGenerate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  setCorsHeaders(res);

  const urlPath = req.url ?? "/api/generate";

  let generateReq: OllamaGenerateRequest;
  try {
    generateReq = JSON.parse(raw) as OllamaGenerateRequest;
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!generateReq.prompt || typeof generateReq.prompt !== "string") {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Invalid request: prompt field is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = ollamaGenerateToCompletionRequest(generateReq);

  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.fixtureMatchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      {
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: completionReq,
      },
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
        completionReq,
        "ollama",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null },
        });
        return;
      }
    }
    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (defaults.strict) {
      defaults.logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${urlPath}`);
    }
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: strictStatus, fixture: null },
    });
    writeErrorResponse(
      res,
      strictStatus,
      JSON.stringify({
        error: {
          message: strictMessage,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const response = fixture.response;
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Ollama defaults to streaming when stream is absent or true
  const streaming = generateReq.stream !== false;

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  // Text response (only type supported for /api/generate)
  if (isTextResponse(response)) {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildOllamaGenerateTextResponse(response.content, completionReq.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildOllamaGenerateTextChunks(
        response.content,
        completionReq.model,
        chunkSize,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeNDJSONStream(res, chunks, {
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

  // Tool call responses not supported for /api/generate — fall through to error
  journal.add({
    method: req.method ?? "POST",
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: completionReq,
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
