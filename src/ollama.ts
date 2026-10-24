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
 * - Legacy embeddings return `embedding`; /api/embed returns `embeddings`
 */

import type * as http from "node:http";
import { setEmbeddingRequest } from "./embedding-request.js";
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
  requireEmittedFunctionToolCalls,
  isTextResponse,
  isToolCallResponse,
  isCombinedFixtureResponse,
  isErrorResponse,
  isRawResponse,
  isEmbeddingResponse,
  isJSONResponse,
  validateChatMessages,
  validateToolsField,
  normalizeEmbeddingInput,
  validateEmbeddingDimensions,
  MAX_EMBEDDING_DIMENSIONS,
  resolveFixtureBlocks,
  resolveFixtureBlockOutcome,
  generateDeterministicEmbedding,
  flattenHeaders,
  isJsonObject,
  getTestId,
  resolveResponse,
  resolveReasoningForModel,
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
  toolArgsForWire,
  InvalidToolArgumentsError,
  servedToolArgs,
} from "./helpers.js";
import { matchFixtureDiagnostic, recordMatchOptions } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { ndjsonCodec } from "./ndjson-writer.js";
import { deliverJson, deliverStream } from "./response/deliver.js";
import { proxyInterruption, withHangUpDetection } from "./response/proxy.js";
import {
  misbehaviorPayloadLength,
  nonStreamingTimingEnabled,
  servedPayloadLength,
} from "./response/timing.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";
import { planMisbehavior, recordMisbehaviorOutcome, type MisbehaviorPlan } from "./misbehavior.js";
import { proxyAndRecord } from "./recorder.js";
import { render as renderUsage } from "./response/usage/codecs/ollama.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import { renderError } from "./response/errors.js";
import { serveRawResponse } from "./response/raw.js";

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
  ...renderUsage({ kind: "ordinary-zero" }, "prompt"),
  prompt_eval_duration: 0,
  ...renderUsage({ kind: "ordinary-zero" }, "completion"),
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
  reasoning?: string,
): object[] {
  const ollamaToolCalls = toolCalls.map(toOllamaToolCall);

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
  reasoning?: string,
): object {
  const ollamaToolCalls = toolCalls.map(toOllamaToolCall);

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
function toOllamaToolCall(tc: Pick<ToolCall, "name" | "arguments">): {
  function: { name: string; arguments: unknown };
} {
  return { function: { name: tc.name, arguments: servedToolArgs(tc, "object").value } };
}

function buildOllamaChatContentWithToolCallsChunks(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
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
            tool_calls: [toOllamaToolCall(block)],
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
  const ollamaToolCalls = toolCalls.map(toOllamaToolCall);

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
// w.r.t. `blocks` ORDERING. Ollama's non-streaming chat response puts `content`
// and `tool_calls` in SEPARATE fields on a single `message` object — they are
// NOT a positionally-observable array, so a tool-first `blocks` fixture cannot
// be expressed in the wire shape. Block ORDER is therefore a no-op here.
// The PAYLOAD, however, is still derived from `blocks` when present (the body
// backfills `content`/`tool_calls` from the blocks — see the comment at the
// top of the function body); only the relative ordering of those fields is
// unobservable. (Order-observable surfaces — Claude `content[]`, Gemini
// `parts[]`, Responses `output[]` — DO honor block order; see those builders.)
function buildOllamaChatContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  reasoning?: string,
  blocks?: FixtureBlock[],
): object {
  // Blocks-only / blocks-present fixtures: the non-streaming wire shape has no
  // positional array, so order is a no-op here (see NOTE above). But the PAYLOAD
  // must not be dropped: backfill `content` from text blocks (concatenated) and
  // `tool_calls` from toolCall blocks, mirroring what the streaming path derives.
  // Legacy (no-blocks) callers keep byte-identical output.
  if (blocks && blocks.length > 0) {
    const ordered = resolveFixtureBlocks(blocks);
    content = ordered
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    toolCalls = ordered
      .filter(
        (b): b is { type: "toolCall"; name: string; arguments: string; id?: string } =>
          b.type === "toolCall",
      )
      .map((b) => ({ name: b.name, arguments: b.arguments }));
  }

  const ollamaToolCalls = toolCalls.map(toOllamaToolCall);

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

/** Prepare fault output and its observations together before sending any bytes. */
function prepareOllamaMisbehavior(
  plan: MisbehaviorPlan,
  request: ChatCompletionRequest,
  stream: boolean,
  chunkSize: number,
  effectiveStrict: boolean,
  logger: HandlerDefaults["logger"],
) {
  const response = plan.response;
  const combined = isCombinedFixtureResponse(response);
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  // The planner skips a custom-call fixture on this wire, so this narrowing
  // never throws; the normal path's guard rejects it instead.
  const calls =
    outcome?.toolCalls ??
    (combined || isToolCallResponse(response) ? (response.toolCalls ?? []) : []);
  const content = outcome?.content ?? ("content" in response ? (response.content ?? "") : "");
  const model = request.model;

  if (plan.summary.fault === "tool-args-invalid-json") {
    const target = calls[plan.target?.index ?? 0];
    if (!target || toolArgsForWire(target).kind !== "verbatim") {
      throw new Error("Ollama invalid-JSON fault requires an invalid prepared target");
    }
    const diagnostic = new InvalidToolArgumentsError(target).parseDiagnostic;
    const error = `error parsing tool call: raw='${target.arguments}', err=${diagnostic}`;
    let priorContent = content;
    if (outcome) {
      priorContent = "";
      let index = 0;
      for (const block of outcome.ordered) {
        if (block.type === "text") priorContent += block.text;
        else if (index++ === plan.target?.index) break;
      }
    }
    // A configured parser failure is a modeled error line, not an ordinary
    // malformed fixture. Suppress all tool objects and any success terminal.
    const chunks = stream
      ? [...buildOllamaChatTextChunks(priorContent, model, chunkSize).slice(0, -1), { error }]
      : [{ error }];
    return {
      build: () => chunks,
      reasoning: undefined,
      status: stream ? 200 : 500,
      summary: { ...plan.summary, servedToolCalls: [] },
    };
  }

  // Object wires record the canonical values that their builders emit, with
  // no fabricated tool IDs. The stored fixture and original plan stay intact.
  const servedToolCalls = calls.map((call) => {
    const parsed = toolArgsForWire(call);
    if (parsed.kind === "verbatim") throw new InvalidToolArgumentsError(call);
    return { name: call.name, arguments: parsed.text };
  });
  const reasoning =
    plan.summary.fault === "reasoning-only"
      ? (plan.reasoning ?? "")
      : (resolveReasoningForModel(
          "reasoning" in response ? response.reasoning : undefined,
          model,
          effectiveStrict,
          logger,
        ) ?? "");
  const completion =
    content + reasoning + servedToolCalls.map((call) => call.name + call.arguments).join("");
  // Built on demand, so a timed non-streaming reply is built after its wait
  // and its `created_at` is the write time.
  const build = (): object[] => {
    let chunks: object[];
    if (plan.summary.fault === "reasoning-only") {
      const createdAt = new Date().toISOString();
      const base = { model, created_at: createdAt };
      if (stream) {
        chunks = [];
        for (let i = 0; i < reasoning.length; i += chunkSize) {
          chunks.push({
            ...base,
            message: {
              role: "assistant",
              content: "",
              thinking: reasoning.slice(i, i + chunkSize),
            },
            done: false,
          });
        }
        chunks.push({
          ...base,
          message: { role: "assistant", content: "" },
          done: true,
          ...DURATION_FIELDS,
          done_reason: "length",
        });
      } else {
        chunks = [
          {
            ...base,
            message: { role: "assistant", content: "", thinking: reasoning },
            done: true,
            ...DURATION_FIELDS,
            done_reason: "length",
          },
        ];
      }
    } else if (combined) {
      chunks = stream
        ? buildOllamaChatContentWithToolCallsChunks(
            content,
            calls,
            model,
            chunkSize,
            reasoning,
            response.blocks,
          )
        : [
            buildOllamaChatContentWithToolCallsResponse(
              content,
              calls,
              model,
              reasoning,
              response.blocks,
            ),
          ];
    } else if (isToolCallResponse(response)) {
      chunks = stream
        ? buildOllamaChatToolCallChunks(calls, model, chunkSize, reasoning)
        : [buildOllamaChatToolCallResponse(calls, model, reasoning)];
    } else {
      chunks = stream
        ? buildOllamaChatTextChunks(content, model, chunkSize, reasoning)
        : [buildOllamaChatTextResponse(content, model, reasoning)];
    }
    const terminal = chunks.length - 1;
    chunks[terminal] = {
      ...chunks[terminal],
      ...renderUsage({ kind: "applied-chat-estimate", messages: request.messages, completion }),
    };
    return chunks;
  };
  return { build, reasoning, status: 200, summary: { ...plan.summary, servedToolCalls } };
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
      renderError("ollama", "validation", {
        message: `Malformed JSON body: ${detail}`,
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Reject non-object bodies (e.g. `null`) before touching fields —
  // otherwise `ollamaReq.messages` throws a TypeError that surfaces as a 500
  // instead of a 400.
  if (!isJsonObject(ollamaReq)) {
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
      renderError("ollama", "validation", {
        message: "Request body must be a JSON object",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Reject wrong-typed message/tool fields before the converter dereferences
  // them. A missing/non-array `messages` keeps the historic message below.
  let chatShapeError =
    validateChatMessages(ollamaReq.messages) ?? validateToolsField(ollamaReq.tools);
  if (!chatShapeError && Array.isArray(ollamaReq.tools)) {
    const missingFunctionIndex = ollamaReq.tools.findIndex(
      (tool) => tool.function === null || tool.function === undefined,
    );
    if (missingFunctionIndex !== -1) {
      chatShapeError = `tools[${missingFunctionIndex}].function must be an object`;
    }
  }
  if (chatShapeError) {
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
      renderError("ollama", "validation", {
        message: `Invalid request: ${chatShapeError}`,
        type: "invalid_request_error",
      }).body,
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
    { ...recordMatchOptions(!!defaults.record, defaults.logger), wire: "ollama" },
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
  }

  if (
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
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
    const effectiveStrict = resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss;
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
        renderError("ollama", "strict-miss", {
          message: strictMessage,
          type: "invalid_request_error",
        }).body,
      );
      return;
    }
    if (defaults.record) {
      const { outcome, clientHungUp } = await withHangUpDetection(req, res, () =>
        proxyAndRecord(req, res, completionReq, "ollama", urlPath, fixtures, defaults, raw),
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: {
            status: res.statusCode ?? 200,
            fixture: null,
            source: "proxy",
            ...proxyInterruption(res, clientHungUp),
          },
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
      renderError("ollama", "fixture-miss", {
        message: "No fixture matched",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  const response = await resolveResponse(fixture, completionReq);
  const misbehavior = planMisbehavior({
    wire: "ollama",
    fixture,
    response,
    request: completionReq,
    stream: ollamaReq.stream !== false,
    defaults,
    rawHeaders: req.headers,
    url: req.url,
  });
  if (misbehavior.kind === "error") {
    const entry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: misbehavior.status, fixture },
    });
    recordMisbehaviorOutcome({ entry, summary: misbehavior.summary, defaults, testId });
    const message = `${misbehavior.code}: ${misbehavior.message}`;
    if (!misbehavior.summary?.evaluations.length) defaults.logger.error(message);
    writeErrorResponse(
      res,
      misbehavior.status,
      renderError("ollama", "misbehavior", {
        message: misbehavior.message,
        code: misbehavior.code,
      }).body,
    );
    return;
  }

  // Raw passthrough (#549): the authored events or JSON, framed for this wire.
  if (isRawResponse(response)) {
    await serveRawResponse({
      wire: "ollama",
      stream: ollamaReq.stream !== false,
      req,
      res,
      fixture,
      response,
      body: completionReq,
      journal,
      defaults,
      testId,
      misbehaviorSummary: misbehavior.summary,
      errorWire: "ollama",
    });
    return;
  }

  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);
  const replaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;
  const streamTiming = {
    latency,
    streamingProfile: fixture.streamingProfile,
    recordedTimings: fixture.recordedTimings,
    replaySpeed,
  };
  const jsonOpts = (payloadLength: number, duplicateId = false) => ({
    surface: "other" as const,
    payloadLength,
    chunkSize,
    recordedTimings: fixture.recordedTimings,
    duplicateId,
    replaySpeed,
  });

  // Ollama defaults to streaming when stream is absent or true
  const streaming = ollamaReq.stream !== false;

  if (misbehavior.kind === "applied") {
    const prepared = prepareOllamaMisbehavior(
      misbehavior,
      completionReq,
      streaming,
      chunkSize,
      resolveRequestDecisions(defaults.strict, req.headers).reasoningSuppression,
      logger,
    );
    // A timed non-streaming reply is built after the wait (inside deliverJson,
    // still before writeHead), so `created_at` is the write time. Every other
    // reply is built here, before journaling, as before.
    const timedBody =
      !streaming && prepared.status === 200 && nonStreamingTimingEnabled(fixture, "other");
    const chunks = timedBody ? undefined : prepared.build();
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: prepared.status, fixture },
    });
    recordMisbehaviorOutcome({ entry: journalEntry, summary: prepared.summary, defaults, testId });
    if (!streaming && prepared.status !== 200) {
      // A modeled error reply (plan n1): written as before, never delayed.
      res.writeHead(prepared.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify((chunks ?? prepared.build())[0]));
    } else if (!streaming) {
      await deliverJson(res, journalEntry, fixture, () => (chunks ?? prepared.build())[0], {
        ...jsonOpts(
          misbehaviorPayloadLength(
            misbehavior,
            misbehavior.reasoning === undefined ? prepared.reasoning : undefined,
          ),
          !!misbehavior.duplicateId,
        ),
        status: prepared.status,
      });
    } else {
      const frames = chunks ?? prepared.build();
      await deliverStream(res, journalEntry, fixture, ndjsonCodec(), frames, streamTiming);
    }
    return;
  }

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    writeErrorResponse(res, status, renderError("openai", "fixture", response.error).body, {
      retryAfter: response.retryAfter,
    });
    return;
  }

  // Content + tool calls response (must be checked before text/tool-only branches)
  if (isCombinedFixtureResponse(response)) {
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
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    const functionToolCalls = requireEmittedFunctionToolCalls(response, "Ollama");
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveRequestDecisions(
      defaults.strict,
      req.headers,
    ).reasoningSuppression;
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      logger,
    );
    if (!streaming) {
      await deliverJson(
        res,
        journalEntry,
        fixture,
        () =>
          buildOllamaChatContentWithToolCallsResponse(
            response.content ?? "",
            functionToolCalls,
            completionReq.model,
            effReasoning,
            response.blocks,
          ),
        jsonOpts(servedPayloadLength(response, effReasoning)),
      );
    } else {
      const chunks = buildOllamaChatContentWithToolCallsChunks(
        response.content ?? "",
        functionToolCalls,
        completionReq.model,
        chunkSize,
        effReasoning,
        response.blocks,
      );
      await deliverStream(res, journalEntry, fixture, ndjsonCodec(), chunks, streamTiming);
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
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveRequestDecisions(
      defaults.strict,
      req.headers,
    ).reasoningSuppression;
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      logger,
    );
    if (!streaming) {
      await deliverJson(
        res,
        journalEntry,
        fixture,
        () => buildOllamaChatTextResponse(response.content, completionReq.model, effReasoning),
        jsonOpts(servedPayloadLength(response, effReasoning)),
      );
    } else {
      const chunks = buildOllamaChatTextChunks(
        response.content,
        completionReq.model,
        chunkSize,
        effReasoning,
      );
      await deliverStream(res, journalEntry, fixture, ndjsonCodec(), chunks, streamTiming);
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
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    const functionToolCalls = requireEmittedFunctionToolCalls(response, "Ollama");
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveRequestDecisions(
      defaults.strict,
      req.headers,
    ).reasoningSuppression;
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      logger,
    );
    if (!streaming) {
      await deliverJson(
        res,
        journalEntry,
        fixture,
        () => buildOllamaChatToolCallResponse(functionToolCalls, completionReq.model, effReasoning),
        jsonOpts(servedPayloadLength(response, effReasoning)),
      );
    } else {
      const chunks = buildOllamaChatToolCallChunks(
        functionToolCalls,
        completionReq.model,
        chunkSize,
        effReasoning,
      );
      await deliverStream(res, journalEntry, fixture, ndjsonCodec(), chunks, streamTiming);
    }
    return;
  }

  // Unknown response type
  const journalEntry = journal.add({
    method: req.method ?? "POST",
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: completionReq,
    response: { status: 500, fixture },
  });
  recordMisbehaviorOutcome({ entry: journalEntry, summary: misbehavior.summary, defaults, testId });
  writeErrorResponse(
    res,
    500,
    renderError("ollama", "unknown-response", {
      message: "Fixture response did not match any known type",
      type: "server_error",
    }).body,
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
      renderError("ollama", "validation", {
        message: `Malformed JSON body: ${detail}`,
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Reject non-object bodies (e.g. `null`) before touching fields —
  // otherwise `generateReq.prompt` throws a TypeError that surfaces as a 500
  // instead of a 400.
  if (!isJsonObject(generateReq)) {
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
      renderError("ollama", "validation", {
        message: "Request body must be a JSON object",
        type: "invalid_request_error",
      }).body,
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
      renderError("ollama", "validation", {
        message: "Invalid request: prompt field is required",
        type: "invalid_request_error",
      }).body,
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
    { ...recordMatchOptions(!!defaults.record, defaults.logger), wire: "ollama-generate" },
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    defaults.logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    defaults.logger.debug(`No fixture matched for request`);
  }

  if (
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
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
    const effectiveStrict = resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss;
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
        renderError("ollama", "strict-miss", {
          message: strictMessage,
          type: "invalid_request_error",
        }).body,
      );
      return;
    }
    if (defaults.record) {
      const { outcome, clientHungUp } = await withHangUpDetection(req, res, () =>
        proxyAndRecord(req, res, completionReq, "ollama", urlPath, fixtures, defaults, raw),
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: {
            status: res.statusCode ?? 200,
            fixture: null,
            source: "proxy",
            ...proxyInterruption(res, clientHungUp),
          },
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
      renderError("ollama", "fixture-miss", {
        message: "No fixture matched",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  const response = await resolveResponse(fixture, completionReq);
  const misbehavior = planMisbehavior({
    wire: "ollama",
    faultRenderingAvailable: false,
    fixture,
    response,
    request: completionReq,
    stream: generateReq.stream !== false,
    defaults,
    rawHeaders: req.headers,
    url: req.url,
  });
  if (misbehavior.kind === "error") {
    const entry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: misbehavior.status, fixture },
    });
    recordMisbehaviorOutcome({ entry, summary: misbehavior.summary, defaults, testId });
    const message = `${misbehavior.code}: ${misbehavior.message}`;
    if (!misbehavior.summary?.evaluations.length) defaults.logger.error(message);
    writeErrorResponse(
      res,
      misbehavior.status,
      renderError("ollama", "misbehavior", {
        message: misbehavior.message,
        code: misbehavior.code,
      }).body,
    );
    return;
  }

  // Raw passthrough (#549): the authored events or JSON, framed for this wire.
  if (isRawResponse(response)) {
    await serveRawResponse({
      wire: "ollama-generate",
      stream: generateReq.stream !== false,
      req,
      res,
      fixture,
      response,
      body: completionReq,
      journal,
      defaults,
      testId,
      misbehaviorSummary: misbehavior.summary,
      errorWire: "ollama",
    });
    return;
  }

  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);
  const replaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;
  const streamTiming = {
    latency,
    streamingProfile: fixture.streamingProfile,
    recordedTimings: fixture.recordedTimings,
    replaySpeed,
  };
  const jsonOpts = (payloadLength: number, duplicateId = false) => ({
    surface: "other" as const,
    payloadLength,
    chunkSize,
    recordedTimings: fixture.recordedTimings,
    duplicateId,
    replaySpeed,
  });

  // Ollama defaults to streaming when stream is absent or true
  const streaming = generateReq.stream !== false;

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    writeErrorResponse(res, status, renderError("openai", "fixture", response.error).body, {
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
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    // Gate reasoning emission on the requested model's capability (aimock#254).
    const effectiveStrict = resolveRequestDecisions(
      defaults.strict,
      req.headers,
    ).reasoningSuppression;
    const effReasoning = resolveReasoningForModel(
      response.reasoning,
      completionReq.model,
      effectiveStrict,
      defaults.logger,
    );
    if (!streaming) {
      await deliverJson(
        res,
        journalEntry,
        fixture,
        () => buildOllamaGenerateTextResponse(response.content, completionReq.model, effReasoning),
        // /api/generate serves only the text content and never reads blocks,
        // so the wait is sized from that text, not from the fixture's blocks.
        jsonOpts(servedPayloadLength({ content: response.content }, effReasoning)),
      );
    } else {
      const chunks = buildOllamaGenerateTextChunks(
        response.content,
        completionReq.model,
        chunkSize,
        effReasoning,
      );
      await deliverStream(res, journalEntry, fixture, ndjsonCodec(), chunks, streamTiming);
    }
    return;
  }

  // Tool call fixtures matched but not supported on /api/generate
  if (isToolCallResponse(response) || isCombinedFixtureResponse(response)) {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 400, fixture },
    });
    recordMisbehaviorOutcome({
      entry: journalEntry,
      summary: misbehavior.summary,
      defaults,
      testId,
    });
    writeErrorResponse(
      res,
      400,
      renderError("ollama", "validation", {
        message: "Tool call fixtures are not supported on /api/generate — use /api/chat instead",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Unknown response type
  const journalEntry = journal.add({
    method: req.method ?? "POST",
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: completionReq,
    response: { status: 500, fixture },
  });
  recordMisbehaviorOutcome({ entry: journalEntry, summary: misbehavior.summary, defaults, testId });
  writeErrorResponse(
    res,
    500,
    renderError("ollama", "unknown-response", {
      message: "Fixture response did not match any known type",
      type: "server_error",
    }).body,
  );
}

// ─── Ollama embeddings request type ─────────────────────────────────────────

interface OllamaEmbeddingsRequest {
  model: string;
  prompt?: string;
  input?: string | string[];
  dimensions?: number;
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
  const currentEndpoint = urlPath.split("?")[0] === "/api/embed";

  const errorWire = currentEndpoint ? "ollama-embed" : "ollama";

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
      renderError(errorWire, "validation", {
        message: `Malformed JSON body: ${detail}`,
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Reject non-object bodies (e.g. `null`) before touching fields —
  // otherwise `embReq.prompt` throws a TypeError that surfaces as a 500
  // instead of a 400.
  if (!isJsonObject(embReq)) {
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
      renderError(errorWire, "validation", {
        message: "Request body must be a JSON object",
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Reject wrong-typed prompt/input before `.slice()` / `.join()` below read
  // them — a number passes the presence checks and then throws a TypeError.
  // `null` means "absent" on both fields, matching the `??` fall-through below.
  // Keep the accepted token-array extension on both endpoints.
  const promptShapeError =
    embReq.prompt !== undefined && embReq.prompt !== null && typeof embReq.prompt !== "string"
      ? "prompt field must be a string"
      : embReq.input !== undefined &&
          embReq.input !== null &&
          normalizeEmbeddingInput(embReq.input) === null
        ? "input field must be a string or an array of strings"
        : null;
  if (promptShapeError) {
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
      renderError(errorWire, "validation", {
        message: `Invalid request: ${promptShapeError}`,
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // Prefer input on the current endpoint, with the existing prompt fallback.
  // The legacy endpoint keeps prompt precedence.
  const inputs = normalizeEmbeddingInput(
    currentEndpoint ? (embReq.input ?? embReq.prompt) : (embReq.prompt ?? embReq.input),
  );
  const inputText = currentEndpoint
    ? inputs?.join(" ")
    : (embReq.prompt ??
      (typeof embReq.input === "string" ? embReq.input : undefined) ??
      (Array.isArray(embReq.input) ? embReq.input.join(" ") : undefined));

  if (!embReq.model || (currentEndpoint && typeof embReq.model !== "string")) {
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
      renderError(errorWire, "validation", {
        message: "Invalid request: model field is required",
        type: "invalid_request_error",
      }).body,
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
      renderError(errorWire, "validation", {
        message: "Invalid request: prompt or input field is required",
        type: "invalid_request_error",
      }).body,
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
  setEmbeddingRequest(syntheticReq, {
    operation: currentEndpoint ? "/api/embed" : "/api/embeddings",
    input: currentEndpoint
      ? (embReq.input ?? embReq.prompt ?? "")
      : (embReq.prompt ?? embReq.input ?? ""),
    ...(embReq.dimensions !== undefined && { dimensions: embReq.dimensions }),
  });

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
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
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
      writeErrorResponse(
        res,
        status,
        renderError(currentEndpoint ? "ollama-embed" : "openai", "fixture", response.error).body,
        {
          retryAfter: response.retryAfter,
        },
      );
      return;
    }

    // Recorded current-endpoint batches retain every vector and provider metadata.
    if (currentEndpoint && isJSONResponse(response)) {
      const status = response.status ?? 200;
      journal.add({
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: { status, fixture },
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response.json));
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
      const body = currentEndpoint
        ? { model: embReq.model, embeddings: (inputs ?? []).map(() => [...response.embedding]) }
        : { model: embReq.model, embedding: [...response.embedding] };
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
      renderError(errorWire, "unknown-response", {
        message:
          "Fixture response did not match any known embedding type (must have embedding or error)",
        type: "server_error",
      }).body,
    );
    return;
  }

  // No fixture match — check strict mode first, then try proxy
  const effectiveStrict = resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss;
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
      renderError(errorWire, "strict-miss", {
        message: strictMessage,
        type: "invalid_request_error",
      }).body,
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

  const dimensions = currentEndpoint ? validateEmbeddingDimensions(embReq.dimensions) : 1536;
  if (dimensions === null) {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      renderError(errorWire, "validation", {
        message: `Invalid request: dimensions must be an integer between 1 and ${MAX_EMBEDDING_DIMENSIONS}`,
        type: "invalid_request_error",
      }).body,
    );
    return;
  }

  // No fixture match — generate deterministic embedding from input text
  logger.warn(
    `No embedding fixture matched for "${inputText.slice(0, 80)}" — returning deterministic fallback`,
  );

  journal.add({
    method: req.method ?? "POST",
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture: null },
  });

  const body = currentEndpoint
    ? {
        model: embReq.model,
        embeddings: (inputs ?? []).map((input) =>
          generateDeterministicEmbedding(input, dimensions),
        ),
      }
    : { model: embReq.model, embedding: generateDeterministicEmbedding(inputText) };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
