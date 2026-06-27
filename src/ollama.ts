/**
 * Ollama API endpoint support.
 *
 * Translates incoming /api/chat, /api/generate, and /api/embeddings requests
 * into the ChatCompletionRequest format used by the fixture router, and converts
 * fixture responses back into Ollama's NDJSON streaming or non-streaming format.
 *
 * Key differences from OpenAI:
 * - Ollama defaults to stream: true (opposite of OpenAI)
 * - Streaming uses NDJSON, not SSE
 * - Tool call arguments are objects, not JSON strings
 * - Tool calls have no id field
 * - Embeddings return a single `embedding` array, not an array of objects
 */

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  FixtureBlock,
  HandlerDefaults,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  isEmbeddingResponse,
  resolveFixtureBlocks,
  serializeErrorResponse,
  generateDeterministicEmbedding,
  flattenHeaders,
  getTestId,
  resolveResponse,
  resolveStrictMode,
  resolveReasoningForModel,
  strictOverrideField,
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { matchFixtureDiagnostic, recordMatchOptions } from "./router.js";
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
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  images?: string[];
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
  system?: string;
  images?: string[];
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
    const chatMsg: ChatMessage = {
      role: msg.role as ChatMessage["role"],
      content: msg.content,
    };

    // Map inbound tool_calls on assistant messages to the internal format
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      chatMsg.tool_calls = msg.tool_calls.map((tc, i) => ({
        id: `call_${i}`,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments),
        },
      }));
    }

    messages.push(chatMsg);
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
    stream: req.stream ?? true,
    temperature: req.options?.temperature,
    max_tokens: req.options?.num_predict,
    tools,
  };
}

function ollamaGenerateToCompletionRequest(req: OllamaGenerateRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // Prepend system message if present
  if (req.system) {
    messages.push({ role: "system", content: req.system });
  }

  messages.push({ role: "user", content: req.prompt });

  return {
    model: req.model,
    messages,
    stream: req.stream ?? true,
    temperature: req.options?.temperature,
    max_tokens: req.options?.num_predict,
  };
}

// ─── Response builders: /api/chat ────────────────────────────────────────────

function buildOllamaChatTextChunks(
  content: string,
  model: string,
  chunkSize: number,
  reasoning?: string,
): object[] {
  const chunks: object[] = [];
  const createdAt = new Date().toISOString();

  // Reasoning chunks (before content)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        model,
        created_at: createdAt,
        message: { role: "assistant", content: "", reasoning_content: slice },
        done: false,
      });
    }
  }

  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    chunks.push({
      model,
      created_at: createdAt,
      message: { role: "assistant", content: slice },
      done: false,
    });
  }

  // Final chunk with done: true and all duration fields
  chunks.push({
    model,
    created_at: createdAt,
    message: { role: "assistant", content: "" },
    done: true,
    ...DURATION_FIELDS,
  });

  return chunks;
}

function buildOllamaChatTextResponse(content: string, model: string, reasoning?: string): object {
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: "assistant",
      content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    },
    done: true,
    ...DURATION_FIELDS,
  };
}

function buildOllamaChatToolCallChunks(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  logger: Logger,
  reasoning?: string,
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
  const createdAt = new Date().toISOString();

  // Reasoning chunks (before tool calls)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        model,
        created_at: createdAt,
        message: { role: "assistant", content: "", reasoning_content: slice },
        done: false,
      });
    }
  }

  chunks.push({
    model,
    created_at: createdAt,
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
    created_at: createdAt,
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
  reasoning?: string,
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
    created_at: new Date().toISOString(),
    message: {
      role: "assistant",
      content: "",
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      tool_calls: ollamaToolCalls,
    },
    done: true,
    ...DURATION_FIELDS,
  };
}

// ─── Response builders: /api/chat — content + tool calls ────────────────────

// Map a fixture tool call into Ollama's wire shape (object arguments, no id).
function toOllamaToolCall(
  tc: ToolCall,
  logger: Logger,
): { function: { name: string; arguments: unknown } } {
  let argsObj: unknown;
  try {
    argsObj = JSON.parse(tc.arguments || "{}");
  } catch {
    logger.warn(`Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`);
    argsObj = {};
  }
  return { function: { name: tc.name, arguments: argsObj } };
}

function buildOllamaChatContentWithToolCallsChunks(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  logger: Logger,
  reasoning?: string,
  blocks?: FixtureBlock[],
): object[] {
  const chunks: object[] = [];
  const createdAt = new Date().toISOString();

  // ── Ordered-blocks path ──────────────────────────────────────────────────
  // When the fixture declares explicit `blocks`, stream NDJSON message chunks
  // following the blocks' ARRAY ORDER: a text block emits a `message.content`
  // delta chunk; a toolCall block emits a chunk carrying `message.tool_calls`.
  // So [toolCall, text] puts the tool_call-bearing chunk before the content
  // chunk. Ollama tool-first ordering is PARTIALLY observable: the chunk order
  // on the wire is honored, but some Ollama clients reassemble content and
  // tool_calls positionally (text first regardless), so downstream order is
  // best-effort. Reasoning chunks (if any) still lead, matching legacy. The
  // legacy single-chunk-all-tools path stays untouched on the else branch.
  if (blocks && blocks.length > 0) {
    const ordered = resolveFixtureBlocks(blocks);

    // Reasoning chunks (before everything else), identical to legacy.
    if (reasoning) {
      for (let i = 0; i < reasoning.length; i += chunkSize) {
        const slice = reasoning.slice(i, i + chunkSize);
        chunks.push({
          model,
          created_at: createdAt,
          message: { role: "assistant", content: "", reasoning_content: slice },
          done: false,
        });
      }
    }

    for (const block of ordered) {
      if (block.type === "text") {
        for (let i = 0; i < block.text.length; i += chunkSize) {
          const slice = block.text.slice(i, i + chunkSize);
          chunks.push({
            model,
            created_at: createdAt,
            message: { role: "assistant", content: slice },
            done: false,
          });
        }
      } else {
        chunks.push({
          model,
          created_at: createdAt,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [toOllamaToolCall(block, logger)],
          },
          done: false,
        });
      }
    }

    // Final chunk — preserved exactly as legacy (done + timing fields).
    chunks.push({
      model,
      created_at: createdAt,
      message: { role: "assistant", content: "" },
      done: true,
      ...DURATION_FIELDS,
    });

    return chunks;
  }

  // ── Legacy path (UNCHANGED) ──────────────────────────────────────────────
  // Reasoning chunks (before content)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        model,
        created_at: createdAt,
        message: { role: "assistant", content: "", reasoning_content: slice },
        done: false,
      });
    }
  }

  // Content chunks first
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    chunks.push({
      model,
      created_at: createdAt,
      message: { role: "assistant", content: slice },
      done: false,
    });
  }

  // Tool calls in a single chunk (same as tool-call-only path)
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

  chunks.push({
    model,
    created_at: createdAt,
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
    created_at: createdAt,
    message: { role: "assistant", content: "" },
    done: true,
    ...DURATION_FIELDS,
  });

  return chunks;
}

// NOTE (#274): this NON-streaming Ollama builder is intentionally degenerate
// w.r.t. `blocks` ordering. Ollama's non-streaming chat response puts `content`
// and `tool_calls` in SEPARATE fields on a single `message` object — they are
// NOT a positionally-observable array, so a tool-first `blocks` fixture cannot
// be expressed in the wire shape. Honoring block order here would be a no-op,
// so we keep the legacy text+tool_calls fields unchanged. (Order-observable
// surfaces — Claude `content[]`, Gemini `parts[]`, Responses `output[]` — DO
// honor block order; see those builders.)
function buildOllamaChatContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  logger: Logger,
  reasoning?: string,
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
    created_at: new Date().toISOString(),
    message: {
      role: "assistant",
      content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
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
  reasoning?: string,
): object[] {
  const chunks: object[] = [];
  const createdAt = new Date().toISOString();

  // Reasoning chunks (before content)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        model,
        created_at: createdAt,
        response: "",
        reasoning_content: slice,
        done: false,
      });
    }
  }

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

function buildOllamaGenerateTextResponse(
  content: string,
  model: string,
  reasoning?: string,
): object {
  return {
    model,
    created_at: new Date().toISOString(),
    response: content,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
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
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
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
          message: `Malformed JSON body: ${detail}`,
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
  completionReq._endpointType = "chat";
  completionReq._context = getContext(req);

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
    // Record mode proxies on a miss to capture a fresh turn (see record gate
    // below), so keep turnIndex strict to prevent an earlier-turn fixture from
    // shadowing a longer request and skipping the new turn's recording.
    recordMatchOptions(!!defaults.record, defaults.logger),
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
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
      fixture ? "fixture" : "proxy",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    if (effectiveStrict) {
      const strictStatus = 503;
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      logger.error(strictNoMatchLogLine(req.method ?? "POST", urlPath, skippedBySequenceOrTurn));
      journal.add({
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: completionReq,
        response: {
          status: strictStatus,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
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
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        completionReq,
        "ollama",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      404,
      JSON.stringify({
        error: {
          message: "No fixture matched",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const response = await resolveResponse(fixture, completionReq);
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
    writeErrorResponse(res, status, serializeErrorResponse(response), {
      retryAfter: response.retryAfter,
    });
    return;
  }

  // Content + tool calls response (must be checked before text/tool-only branches)
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Ollama API -- ignoring");
    }
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      logger,
    );
    if (!streaming) {
      const body = buildOllamaChatContentWithToolCallsResponse(
        response.content,
        response.toolCalls,
        completionReq.model,
        logger,
        effReasoning,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildOllamaChatContentWithToolCallsChunks(
        response.content,
        response.toolCalls,
        completionReq.model,
        chunkSize,
        logger,
        effReasoning,
        response.blocks,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeNDJSONStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
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

  // Text response
  if (isTextResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Ollama API -- ignoring");
    }
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      logger,
    );
    if (!streaming) {
      const body = buildOllamaChatTextResponse(response.content, completionReq.model, effReasoning);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildOllamaChatTextChunks(
        response.content,
        completionReq.model,
        chunkSize,
        effReasoning,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeNDJSONStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
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
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Ollama API — ignoring");
    }
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      logger,
    );
    if (!streaming) {
      const body = buildOllamaChatToolCallResponse(
        response.toolCalls,
        completionReq.model,
        logger,
        effReasoning,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildOllamaChatToolCallChunks(
        response.toolCalls,
        completionReq.model,
        chunkSize,
        logger,
        effReasoning,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeNDJSONStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
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
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
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
          message: `Malformed JSON body: ${detail}`,
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
  completionReq._endpointType = "chat";
  completionReq._context = getContext(req);

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
    // Record mode proxies on a miss to capture a fresh turn (see record gate
    // below), so keep turnIndex strict to prevent an earlier-turn fixture from
    // shadowing a longer request and skipping the new turn's recording.
    recordMatchOptions(!!defaults.record, defaults.logger),
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    defaults.logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    defaults.logger.debug(`No fixture matched for request`);
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
      fixture ? "fixture" : "proxy",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    if (effectiveStrict) {
      const strictStatus = 503;
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      defaults.logger.error(
        strictNoMatchLogLine(req.method ?? "POST", urlPath, skippedBySequenceOrTurn),
      );
      journal.add({
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: completionReq,
        response: {
          status: strictStatus,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
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
    if (defaults.record) {
      const outcome = await proxyAndRecord(
        req,
        res,
        completionReq,
        "ollama",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(
      res,
      404,
      JSON.stringify({
        error: {
          message: "No fixture matched",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const response = await resolveResponse(fixture, completionReq);
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
    writeErrorResponse(res, status, serializeErrorResponse(response), {
      retryAfter: response.retryAfter,
    });
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
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      defaults.logger,
    );
    if (!streaming) {
      const body = buildOllamaGenerateTextResponse(
        response.content,
        completionReq.model,
        effReasoning,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildOllamaGenerateTextChunks(
        response.content,
        completionReq.model,
        chunkSize,
        effReasoning,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeNDJSONStream(res, chunks, {
        latency,
        streamingProfile: fixture.streamingProfile,
        recordedTimings: fixture.recordedTimings,
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
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

  // Tool call fixtures matched but not supported on /api/generate
  if (isToolCallResponse(response) || isContentWithToolCallsResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 400, fixture },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Tool call fixtures are not supported on /api/generate — use /api/chat instead",
          type: "invalid_request_error",
        },
      }),
    );
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

// ─── Ollama embeddings request type ─────────────────────────────────────────

interface OllamaEmbeddingsRequest {
  model: string;
  prompt?: string;
  input?: string | string[];
}

// ─── Request handler: /api/embeddings ───────────────────────────────────────

export async function handleOllamaEmbeddings(
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

  const urlPath = req.url ?? "/api/embeddings";

  let embReq: OllamaEmbeddingsRequest;
  try {
    embReq = JSON.parse(raw) as OllamaEmbeddingsRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
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
          message: `Malformed JSON body: ${detail}`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Ollama accepts either "prompt" or "input" for the text to embed
  const inputText =
    embReq.prompt ??
    (typeof embReq.input === "string" ? embReq.input : undefined) ??
    (Array.isArray(embReq.input) ? embReq.input.join(" ") : undefined);

  if (!embReq.model) {
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
          message: "Invalid request: model field is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!inputText) {
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
          message: "Invalid request: prompt or input field is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Build synthetic ChatCompletionRequest for the fixture router
  const syntheticReq: ChatCompletionRequest = {
    model: embReq.model,
    messages: [],
    embeddingInput: inputText,
    _endpointType: "embedding",
    _context: getContext(req),
  };

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    syntheticReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
    // Record mode proxies on a miss to capture a fresh turn (see record gate
    // below), so keep turnIndex strict to prevent an earlier-turn fixture from
    // shadowing a longer request and skipping the new turn's recording.
    recordMatchOptions(!!defaults.record, defaults.logger),
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
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
        body: syntheticReq,
      },
      fixture ? "fixture" : "proxy",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (fixture) {
    const response = await resolveResponse(fixture, syntheticReq);

    // Error response
    if (isErrorResponse(response)) {
      const status = response.status ?? 500;
      journal.add({
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status, fixture },
      });
      writeErrorResponse(res, status, serializeErrorResponse(response), {
        retryAfter: response.retryAfter,
      });
      return;
    }

    // Embedding response — use the fixture's embedding
    if (isEmbeddingResponse(response)) {
      journal.add({
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: 200, fixture },
      });
      const body = {
        model: embReq.model,
        embedding: [...response.embedding],
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Fixture matched but response type is not compatible with embeddings
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    writeErrorResponse(
      res,
      500,
      JSON.stringify({
        error: {
          message:
            "Fixture response did not match any known embedding type (must have embedding or error)",
          type: "server_error",
        },
      }),
    );
    return;
  }

  // No fixture match — check strict mode first, then try proxy
  const effectiveStrict = resolveStrictMode(defaults.strict, req.headers);
  if (effectiveStrict) {
    const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
    logger.error(strictNoMatchLogLine(req.method ?? "POST", urlPath, skippedBySequenceOrTurn));
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
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
      JSON.stringify({
        error: {
          message: strictMessage,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (defaults.record) {
    const outcome = await proxyAndRecord(
      req,
      res,
      syntheticReq,
      "ollama",
      urlPath,
      fixtures,
      defaults,
      raw,
    );
    if (outcome === "handled_by_hook") return;
    if (outcome !== "not_configured") {
      journal.add({
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
      });
      return;
    }
  }

  // No fixture match — generate deterministic embedding from input text
  logger.warn(
    `No embedding fixture matched for "${inputText.slice(0, 80)}" — returning deterministic fallback`,
  );
  const embedding = generateDeterministicEmbedding(inputText);

  journal.add({
    method: req.method ?? "POST",
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture: null },
  });

  const body = {
    model: embReq.model,
    embedding,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
