/**
 * Google Gemini GenerateContent API support.
 *
 * Translates incoming Gemini requests into the ChatCompletionRequest format
 * used by the fixture router, and converts fixture responses back into the
 * Gemini GenerateContent streaming (or non-streaming) format.
 */

import type * as http from "node:http";
import type {
  AudioResponse,
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  HandlerDefaults,
  RecordProviderKey,
  ResponseOverrides,
  StreamingProfile,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  isAudioResponse,
  extractOverrides,
  formatToMime,
  flattenHeaders,
  getTestId,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse, delay, calculateDelay } from "./sse-writer.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Gemini request types ───────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: unknown; id?: string };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role?: string;
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: object;
}

interface GeminiToolDef {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

interface GeminiRequest {
  contents?: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: GeminiToolDef[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Input conversion: Gemini → ChatCompletions messages ────────────────────

export function geminiToCompletionRequest(
  req: GeminiRequest,
  model: string,
  stream: boolean,
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // systemInstruction → system message
  if (req.systemInstruction) {
    const text = req.systemInstruction.parts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text!)
      .join("");
    if (text) {
      messages.push({ role: "system", content: text });
    }
  }

  if (req.contents) {
    let callCounter = 0;
    for (const content of req.contents) {
      const role = content.role ?? "user";

      if (role === "user") {
        // Check for functionResponse parts
        const funcResponses = content.parts.filter((p) => p.functionResponse);
        const textParts = content.parts.filter((p) => p.text !== undefined && !p.thought);

        if (funcResponses.length > 0) {
          // functionResponse → tool message; match IDs from the preceding assistant's tool_calls
          const lastAssistant = [...messages]
            .reverse()
            .find((m) => m.role === "assistant" && m.tool_calls);
          const matchedToolCallIds = new Set<string>();
          for (const part of funcResponses) {
            const matchingCall = lastAssistant?.tool_calls?.find(
              (tc) =>
                tc.function.name === part.functionResponse!.name && !matchedToolCallIds.has(tc.id),
            );
            if (matchingCall) matchedToolCallIds.add(matchingCall.id);
            const toolCallId =
              matchingCall?.id ?? `call_gemini_${part.functionResponse!.name}_${callCounter++}`;
            messages.push({
              role: "tool",
              content:
                typeof part.functionResponse!.response === "string"
                  ? part.functionResponse!.response
                  : JSON.stringify(part.functionResponse!.response),
              tool_call_id: toolCallId,
            });
          }
          // Any text parts alongside → user message
          if (textParts.length > 0) {
            messages.push({
              role: "user",
              content: textParts.map((p) => p.text!).join(""),
            });
          }
        } else {
          // Regular user text
          const text = textParts.map((p) => p.text!).join("");
          messages.push({ role: "user", content: text });
        }
      } else if (role === "model") {
        // Check for functionCall parts
        const funcCalls = content.parts.filter((p) => p.functionCall);
        const textParts = content.parts.filter((p) => p.text !== undefined && !p.thought);

        if (funcCalls.length > 0) {
          const text = textParts.map((p) => p.text!).join("");
          messages.push({
            role: "assistant",
            content: text || null,
            tool_calls: funcCalls.map((fc, i) => ({
              id: fc.functionCall!.id ?? `call_gemini_${fc.functionCall!.name}_${i}`,
              type: "function" as const,
              function: {
                name: fc.functionCall!.name,
                arguments: JSON.stringify(fc.functionCall!.args ?? {}),
              },
            })),
          });
        } else {
          const text = textParts.map((p) => p.text!).join("");
          messages.push({ role: "assistant", content: text });
        }
      }
      // Unrecognized roles (not "user" or "model") are silently dropped.
      // Gemini only defines "user" and "model"; any other value indicates
      // a malformed request or an unsupported future role.
    }
  }

  // Convert tools
  let tools: ToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    const decls = req.tools.flatMap((t) => t.functionDeclarations ?? []);
    if (decls.length > 0) {
      tools = decls.map((d) => ({
        type: "function" as const,
        function: {
          name: d.name,
          description: d.description,
          parameters: d.parameters,
        },
      }));
    }
  }

  return {
    model,
    messages,
    stream,
    temperature: req.generationConfig?.temperature,
    max_tokens: req.generationConfig?.maxOutputTokens,
    top_p: req.generationConfig?.topP as number | undefined,
    top_k: req.generationConfig?.topK as number | undefined,
    tools,
  };
}

// ─── Response building: fixture → Gemini format ─────────────────────────────

function geminiFinishReason(finishReason: string | undefined, defaultReason: string): string {
  if (!finishReason) return defaultReason;
  if (finishReason === "stop") return "STOP";
  if (finishReason === "tool_calls") return "FUNCTION_CALL";
  if (finishReason === "length") return "MAX_TOKENS";
  if (finishReason === "content_filter") return "SAFETY";
  // Pass through unrecognized values as-is
  return finishReason;
}

function geminiUsageMetadata(overrides?: ResponseOverrides): {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
} {
  if (!overrides?.usage)
    return { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
  const prompt =
    overrides.usage.promptTokenCount ??
    overrides.usage.prompt_tokens ??
    overrides.usage.input_tokens ??
    0;
  const candidates =
    overrides.usage.candidatesTokenCount ??
    overrides.usage.completion_tokens ??
    overrides.usage.output_tokens ??
    0;
  const total = overrides.usage.totalTokenCount ?? prompt + candidates;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    totalTokenCount: total,
  };
}

interface GeminiResponseChunk {
  candidates: {
    content: { role: string; parts: GeminiPart[] };
    finishReason?: string;
    index: number;
  }[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

function buildGeminiTextStreamChunks(
  content: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
): GeminiResponseChunk[] {
  const chunks: GeminiResponseChunk[] = [];
  const effectiveFinish = geminiFinishReason(overrides?.finishReason, "STOP");
  const usage = geminiUsageMetadata(overrides);

  // Reasoning chunks (thought: true)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        candidates: [
          {
            content: { role: "model", parts: [{ text: slice, thought: true }] },
            index: 0,
          },
        ],
      });
    }
  }

  // Content chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= content.length;
    const chunk: GeminiResponseChunk = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: slice }] },
          index: 0,
          ...(isLast ? { finishReason: effectiveFinish } : {}),
        },
      ],
      ...(isLast ? { usageMetadata: usage } : {}),
    };
    chunks.push(chunk);
  }

  // Handle empty content
  if (content.length === 0) {
    chunks.push({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "" }] },
          finishReason: effectiveFinish,
          index: 0,
        },
      ],
      usageMetadata: usage,
    });
  }

  return chunks;
}

function parseToolCallPart(tc: ToolCall, logger: Logger): GeminiPart {
  let argsObj: Record<string, unknown>;
  try {
    argsObj = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
  } catch {
    logger.warn(`Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`);
    argsObj = {};
  }
  return { functionCall: { name: tc.name, args: argsObj } };
}

function buildGeminiToolCallStreamChunks(
  toolCalls: ToolCall[],
  logger: Logger,
  overrides?: ResponseOverrides,
): GeminiResponseChunk[] {
  const parts: GeminiPart[] = toolCalls.map((tc) => parseToolCallPart(tc, logger));

  // Gemini sends all tool calls in a single response chunk
  return [
    {
      candidates: [
        {
          content: { role: "model", parts },
          finishReason: geminiFinishReason(overrides?.finishReason, "FUNCTION_CALL"),
          index: 0,
        },
      ],
      usageMetadata: geminiUsageMetadata(overrides),
    },
  ];
}

// Non-streaming response builders

function buildGeminiTextResponse(
  content: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
): GeminiResponseChunk {
  const parts: GeminiPart[] = [];
  if (reasoning) {
    parts.push({ text: reasoning, thought: true });
  }
  parts.push({ text: content });

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: geminiFinishReason(overrides?.finishReason, "STOP"),
        index: 0,
      },
    ],
    usageMetadata: geminiUsageMetadata(overrides),
  };
}

function buildGeminiToolCallResponse(
  toolCalls: ToolCall[],
  logger: Logger,
  overrides?: ResponseOverrides,
): GeminiResponseChunk {
  const parts: GeminiPart[] = toolCalls.map((tc) => parseToolCallPart(tc, logger));

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: geminiFinishReason(overrides?.finishReason, "FUNCTION_CALL"),
        index: 0,
      },
    ],
    usageMetadata: geminiUsageMetadata(overrides),
  };
}

function buildGeminiContentWithToolCallsStreamChunks(
  content: string,
  toolCalls: ToolCall[],
  chunkSize: number,
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
): GeminiResponseChunk[] {
  const chunks: GeminiResponseChunk[] = [];

  // Reasoning chunks (thought: true)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        candidates: [
          {
            content: { role: "model", parts: [{ text: slice, thought: true }] },
            index: 0,
          },
        ],
      });
    }
  }

  if (content.length === 0) {
    chunks.push({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "" }] },
          index: 0,
        },
      ],
    });
  } else {
    for (let i = 0; i < content.length; i += chunkSize) {
      const slice = content.slice(i, i + chunkSize);
      chunks.push({
        candidates: [
          {
            content: { role: "model", parts: [{ text: slice }] },
            index: 0,
          },
        ],
      });
    }
  }

  const parts: GeminiPart[] = toolCalls.map((tc) => parseToolCallPart(tc, logger));

  chunks.push({
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: geminiFinishReason(overrides?.finishReason, "FUNCTION_CALL"),
        index: 0,
      },
    ],
    usageMetadata: geminiUsageMetadata(overrides),
  });

  return chunks;
}

function buildGeminiContentWithToolCallsResponse(
  content: string,
  toolCalls: ToolCall[],
  logger: Logger,
  reasoning?: string,
  overrides?: ResponseOverrides,
): GeminiResponseChunk {
  const parts: GeminiPart[] = [];
  if (reasoning) {
    parts.push({ text: reasoning, thought: true });
  }
  parts.push({ text: content });
  parts.push(...toolCalls.map((tc) => parseToolCallPart(tc, logger)));

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: geminiFinishReason(overrides?.finishReason, "FUNCTION_CALL"),
        index: 0,
      },
    ],
    usageMetadata: geminiUsageMetadata(overrides),
  };
}

// ─── Audio response builders ────────────────────────────────────────────────

function resolveAudioInlineData(audio: AudioResponse): { mimeType: string; data: string } {
  if (typeof audio.audio === "string") {
    return { mimeType: formatToMime(audio.format ?? "mp3"), data: audio.audio };
  }
  return {
    mimeType: audio.audio.contentType ?? "audio/mpeg",
    data: audio.audio.b64Json,
  };
}

function buildGeminiAudioResponse(audio: AudioResponse): GeminiResponseChunk {
  const inlineData = resolveAudioInlineData(audio);
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ inlineData }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
  };
}

function buildGeminiAudioStreamChunks(audio: AudioResponse): GeminiResponseChunk[] {
  const inlineData = resolveAudioInlineData(audio);
  return [
    {
      candidates: [
        {
          content: { role: "model", parts: [{ inlineData }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
    },
  ];
}

// ─── SSE writer for Gemini streaming ────────────────────────────────────────

interface GeminiStreamOptions {
  latency?: number;
  streamingProfile?: StreamingProfile;
  signal?: AbortSignal;
  onChunkSent?: () => void;
}

async function writeGeminiSSEStream(
  res: http.ServerResponse,
  chunks: GeminiResponseChunk[],
  optionsOrLatency?: number | GeminiStreamOptions,
): Promise<boolean> {
  const opts: GeminiStreamOptions =
    typeof optionsOrLatency === "number" ? { latency: optionsOrLatency } : (optionsOrLatency ?? {});
  const latency = opts.latency ?? 0;
  const profile = opts.streamingProfile;
  const signal = opts.signal;
  const onChunkSent = opts.onChunkSent;

  if (res.writableEnded) return true;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let chunkIndex = 0;
  for (const chunk of chunks) {
    const chunkDelay = calculateDelay(chunkIndex, profile, latency);
    if (chunkDelay > 0) await delay(chunkDelay, signal);
    if (signal?.aborted) return false;
    if (res.writableEnded) return true;
    // Gemini uses data-only SSE (no event: prefix, no [DONE])
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    onChunkSent?.();
    if (signal?.aborted) return false;
    chunkIndex++;
  }

  if (!res.writableEnded) {
    res.end();
  }
  return true;
}

// ─── Request handler ────────────────────────────────────────────────────────

export async function handleGemini(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  model: string,
  streaming: boolean,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  providerKey: RecordProviderKey = "gemini",
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  let geminiReq: GeminiRequest;
  try {
    geminiReq = JSON.parse(raw) as GeminiRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    journal.add({
      method: req.method ?? "POST",
      path: req.url ?? `/v1beta/models/${model}:generateContent`,
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
          code: 400,
          status: "INVALID_ARGUMENT",
        },
      }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = geminiToCompletionRequest(geminiReq, model, streaming);
  completionReq._endpointType = "chat";

  const testId = getTestId(req);
  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );
  const path = req.url ?? `/v1beta/models/${model}:generateContent`;

  if (fixture) {
    logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  } else {
    logger.debug(`No fixture matched for request`);
  }

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
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
        path,
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
      logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${path}`);
      journal.add({
        method: req.method ?? "POST",
        path,
        headers: flattenHeaders(req.headers),
        body: completionReq,
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
            message: "Strict mode: no fixture matched",
            code: 503,
            status: "UNAVAILABLE",
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
        providerKey,
        path,
        fixtures,
        defaults,
        raw,
      );
      if (outcome === "handled_by_hook") return;
      if (outcome !== "not_configured") {
        journal.add({
          method: req.method ?? "POST",
          path,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
        });
        return;
      }
    }
    journal.add({
      method: req.method ?? "POST",
      path,
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
          code: 404,
          status: "NOT_FOUND",
        },
      }),
    );
    return;
  }

  const response = await resolveResponse(fixture, completionReq);
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    // Gemini-style error format: { error: { code, message, status } }
    const geminiError = {
      error: {
        code: status,
        message: response.error.message,
        status: response.error.type ?? "ERROR",
      },
    };
    writeErrorResponse(res, status, JSON.stringify(geminiError));
    return;
  }

  // Audio response
  if (isAudioResponse(response)) {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildGeminiAudioResponse(response);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildGeminiAudioStreamChunks(response);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeGeminiSSEStream(res, chunks, {
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

  // Content + tool calls response (must be checked before isTextResponse / isToolCallResponse)
  if (isContentWithToolCallsResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Gemini API — ignoring");
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildGeminiContentWithToolCallsResponse(
        response.content,
        response.toolCalls,
        logger,
        response.reasoning,
        overrides,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildGeminiContentWithToolCallsStreamChunks(
        response.content,
        response.toolCalls,
        chunkSize,
        logger,
        response.reasoning,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeGeminiSSEStream(res, chunks, {
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

  // Text response
  if (isTextResponse(response)) {
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Gemini API — ignoring");
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildGeminiTextResponse(response.content, response.reasoning, overrides);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildGeminiTextStreamChunks(
        response.content,
        chunkSize,
        response.reasoning,
        overrides,
      );
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeGeminiSSEStream(res, chunks, {
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
    if (response.webSearches?.length) {
      logger.warn("webSearches in fixture response are not supported for Gemini API — ignoring");
    }
    const overrides = extractOverrides(response);
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildGeminiToolCallResponse(response.toolCalls, logger, overrides);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildGeminiToolCallStreamChunks(response.toolCalls, logger, overrides);
      const interruption = createInterruptionSignal(fixture);
      const completed = await writeGeminiSSEStream(res, chunks, {
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
    path,
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
        code: 500,
        status: "INTERNAL",
      },
    }),
  );
}
