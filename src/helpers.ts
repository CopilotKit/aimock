import { createHash, randomBytes } from "node:crypto";
import type * as http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { DEFAULT_TEST_ID } from "./constants.js";
import type { Logger } from "./logger.js";
import { isReasoningModel } from "./model-utils.js";
import type {
  ChatCompletionRequest,
  Fixture,
  FixtureResponse,
  ResponseFactory,
  TextResponse,
  ToolCallResponse,
  ContentWithToolCallsResponse,
  ErrorResponse,
  EmbeddingResponse,
  ImageResponse,
  AudioResponse,
  TranscriptionResponse,
  VideoResponse,
  RawJSONResponse,
  SSEChunk,
  ToolCall,
  ChatCompletion,
  ResponseOverrides,
} from "./types.js";

const REDACTED_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);

/**
 * Resolve effective strict mode from per-request header and server default.
 * Header values override the server default — same precedence pattern as chaos
 * config headers (see resolveChaosConfig in chaos.ts).
 *
 * Header: `X-AIMock-Strict` — "true"/"1" → strict on, "false"/"0" → strict off.
 * When absent or unrecognised, falls back to the server-level default.
 */
export function resolveStrictMode(
  serverDefault: boolean | undefined,
  rawHeaders?: IncomingHttpHeaders,
): boolean {
  if (rawHeaders) {
    const header = rawHeaders["x-aimock-strict"];
    const val = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
    if (val === "true" || val === "1") return true;
    if (val === "false" || val === "0") return false;
  }
  return serverDefault ?? false;
}

/**
 * Returns `true` or `false` when the X-AIMock-Strict header overrides the
 * server default, or `undefined` when it doesn't. Designed to be spread
 * directly into a journal entry's `response` object:
 *
 *   response: { status, fixture, ...strictOverrideField(defaults.strict, req.headers) }
 */
export function strictOverrideField(
  serverDefault: boolean | undefined,
  rawHeaders?: IncomingHttpHeaders,
): { strictOverride?: boolean } {
  const effective = resolveStrictMode(serverDefault, rawHeaders);
  if (effective !== (serverDefault ?? false)) {
    return { strictOverride: effective };
  }
  return {};
}

/**
 * Resolve the reasoning string to actually emit for a given model.
 *
 * aimock synthesizes a reasoning channel whenever a fixture carries a
 * `reasoning` string, regardless of the requested model. But a non-reasoning
 * model (e.g. `gpt-4.1`) would emit no reasoning against the real provider, so
 * replaying it is a false green (see aimock#254). This gates the emission on
 * the requested model's capability:
 *
 *   - no fixture reasoning            → undefined (no-op, short-circuit)
 *   - reasoning-capable model         → emit unchanged, no log
 *   - non-reasoning model, strict OFF → `logger.warn`, still emit (preserves
 *                                       current behavior)
 *   - non-reasoning model, strict ON  → `logger.error`, suppress (return undefined)
 *
 * Capability is decided from the REQUESTED model id (what the backend was wired
 * to), not any `overrides.model` echoed in the payload.
 */
export function resolveReasoningForModel(
  reasoning: string | undefined,
  model: string | undefined,
  strict: boolean,
  logger: Logger,
): string | undefined {
  if (!reasoning) return undefined;
  if (isReasoningModel(model)) return reasoning;
  if (strict) {
    logger.error(
      `Strict mode: fixture has a reasoning channel but model "${model}" is not reasoning-capable — suppressing reasoning emission`,
    );
    return undefined;
  }
  logger.warn(
    `Fixture has a reasoning channel but model "${model}" is not reasoning-capable — the real provider would emit no reasoning. Emitting anyway (set X-AIMock-Strict: true to suppress).`,
  );
  return reasoning;
}

/**
 * Resolve the encrypted reasoning artifacts (`reasoningSignature` and
 * `redactedThinking`) to actually emit for a given model.
 *
 * `redacted_thinking` blocks and a thinking `signature` ARE part of the
 * reasoning channel — they are just the encrypted form of it — so they must be
 * gated on the same model-capability resolution as the plaintext `reasoning`
 * string (see resolveReasoningForModel). Gating only the plaintext channel
 * leaves a half-gated reasoning path: replaying a fixture recorded from a
 * reasoning model against a non-reasoning model would strip the `thinking`
 * block but still emit `redacted_thinking` blocks, which the real provider for
 * that model would never produce.
 *
 * Capability is decided from the REQUESTED model id, independently of whether a
 * plaintext `reasoning` string is present — a fixture may carry only
 * `redactedThinking` with no plaintext reasoning.
 *
 *   - reasoning-capable model         → emit both unchanged, no log
 *   - non-reasoning model, no artifacts → no-op, nothing to suppress
 *   - non-reasoning model, strict OFF → `logger.warn`, still emit (preserves
 *                                       current behavior)
 *   - non-reasoning model, strict ON  → `logger.error`, suppress both
 *
 * Must be invoked alongside resolveReasoningForModel with identical model/strict
 * inputs so the plaintext and encrypted channels stay suppressed together.
 */
export function resolveReasoningArtifactsForModel(
  reasoningSignature: string | undefined,
  redactedThinking: string[] | undefined,
  model: string | undefined,
  strict: boolean,
  logger: Logger,
): { reasoningSignature?: string; redactedThinking?: string[] } {
  const hasArtifacts = reasoningSignature !== undefined || (redactedThinking?.length ?? 0) > 0;
  if (!hasArtifacts || isReasoningModel(model)) {
    return { reasoningSignature, redactedThinking };
  }
  if (strict) {
    logger.error(
      `Strict mode: fixture has encrypted reasoning artifacts (redacted_thinking/signature) but model "${model}" is not reasoning-capable — suppressing reasoning emission`,
    );
    return {};
  }
  logger.warn(
    `Fixture has encrypted reasoning artifacts (redacted_thinking/signature) but model "${model}" is not reasoning-capable — the real provider would emit no reasoning. Emitting anyway (set X-AIMock-Strict: true to suppress).`,
  );
  return { reasoningSignature, redactedThinking };
}

export function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (REDACTED_HEADERS.has(key.toLowerCase())) {
      flat[key] = "[REDACTED]";
    } else {
      flat[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return flat;
}

export function isResponseFactory(r: FixtureResponse | ResponseFactory): r is ResponseFactory {
  return typeof r === "function";
}

export async function resolveResponse(
  fixture: Fixture,
  request: ChatCompletionRequest,
): Promise<FixtureResponse> {
  if (typeof fixture.response === "function") {
    try {
      const raw = await fixture.response(request);
      return normalizeFactoryResponse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Response factory threw: ${msg}`, { cause: err });
    }
  }
  return fixture.response;
}

function normalizeFactoryResponse(raw: FixtureResponse): FixtureResponse {
  const r = { ...raw } as Record<string, unknown>;
  if (typeof r.content === "object" && r.content !== null) {
    r.content = JSON.stringify(r.content);
  }
  if (Array.isArray(r.toolCalls)) {
    r.toolCalls = (r.toolCalls as Array<Record<string, unknown>>).map((tc) => {
      if (typeof tc.arguments === "object" && tc.arguments !== null) {
        return { ...tc, arguments: JSON.stringify(tc.arguments) };
      }
      return { ...tc };
    });
  }
  return r as unknown as FixtureResponse;
}

export function generateId(prefix = "chatcmpl"): string {
  return `${prefix}-${randomBytes(12).toString("base64url")}`;
}

export function generateToolCallId(): string {
  return `call_${randomBytes(12).toString("base64url")}`;
}

export function generateMessageId(): string {
  return `msg_${randomBytes(12).toString("base64url")}`;
}

export function generateToolUseId(): string {
  return `toolu_${randomBytes(12).toString("base64url")}`;
}

export function isTextResponse(r: FixtureResponse): r is TextResponse {
  return "content" in r && typeof (r as TextResponse).content === "string" && !("toolCalls" in r);
}

export function isToolCallResponse(r: FixtureResponse): r is ToolCallResponse {
  return (
    "toolCalls" in r &&
    Array.isArray((r as ToolCallResponse).toolCalls) &&
    !("content" in r && typeof (r as unknown as Record<string, unknown>).content === "string")
  );
}

export function isContentWithToolCallsResponse(
  r: FixtureResponse,
): r is ContentWithToolCallsResponse {
  return (
    "content" in r &&
    typeof (r as ContentWithToolCallsResponse).content === "string" &&
    "toolCalls" in r &&
    Array.isArray((r as ContentWithToolCallsResponse).toolCalls)
  );
}

export function isErrorResponse(r: FixtureResponse): r is ErrorResponse {
  return (
    "error" in r &&
    (r as ErrorResponse).error !== null &&
    typeof (r as ErrorResponse).error === "object" &&
    "message" in ((r as ErrorResponse).error as Record<string, unknown>) &&
    typeof ((r as ErrorResponse).error as Record<string, unknown>).message === "string"
  );
}

/**
 * Serialize an ErrorResponse to JSON, stripping the internal-only `status`
 * field that controls the HTTP status code but should never appear in the
 * response body.  Real LLM APIs don't include it.
 */
export function serializeErrorResponse(response: ErrorResponse): string {
  return JSON.stringify({
    error: {
      message: response.error.message,
      type: response.error.type ?? "server_error",
      param: response.error.param ?? null,
      code: response.error.code ?? null,
    },
  });
}

export function isEmbeddingResponse(r: FixtureResponse): r is EmbeddingResponse {
  return "embedding" in r && Array.isArray((r as EmbeddingResponse).embedding);
}

export function isImageResponse(r: FixtureResponse): r is ImageResponse {
  return (
    ("image" in r && r.image != null) ||
    ("images" in r && Array.isArray((r as ImageResponse).images))
  );
}

export function isAudioResponse(r: FixtureResponse): r is AudioResponse {
  if (!("audio" in r)) return false;
  const a = (r as AudioResponse).audio;
  return typeof a === "string" || (typeof a === "object" && a !== null && "b64Json" in a);
}

/**
 * Map audio format shorthand to MIME content types.
 * Shared between speech, ElevenLabs, and fal audio handlers.
 */
export const FORMAT_TO_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

/**
 * Resolve a format string (e.g. "mp3", "opus") to its MIME content type.
 * Falls back to "application/octet-stream" for unknown formats.
 */
export function formatToMime(format: string): string {
  return FORMAT_TO_CONTENT_TYPE[format] ?? "application/octet-stream";
}

export function isTranscriptionResponse(r: FixtureResponse): r is TranscriptionResponse {
  return (
    "transcription" in r &&
    (r as TranscriptionResponse).transcription != null &&
    typeof (r as TranscriptionResponse).transcription === "object"
  );
}

export function isVideoResponse(r: FixtureResponse): r is VideoResponse {
  return (
    "video" in r &&
    (r as VideoResponse).video != null &&
    typeof (r as VideoResponse).video === "object"
  );
}

export function isJSONResponse(r: FixtureResponse): r is RawJSONResponse {
  return "json" in r && (r as RawJSONResponse).json !== undefined;
}

export function extractOverrides(
  response: TextResponse | ToolCallResponse | ContentWithToolCallsResponse,
): ResponseOverrides {
  const r = response;
  return {
    ...(r.id !== undefined && { id: r.id }),
    ...(r.created !== undefined && { created: r.created }),
    ...(r.model !== undefined && { model: r.model }),
    ...(r.usage !== undefined && { usage: r.usage }),
    ...(r.systemFingerprint !== undefined && { systemFingerprint: r.systemFingerprint }),
    ...(r.finishReason !== undefined && { finishReason: r.finishReason }),
    ...(r.role !== undefined && { role: r.role }),
  };
}

// ─── Token estimation ────────────────────────────────────────────────────

/**
 * Rough token count estimation based on character length.
 * Uses the ~4 characters per token heuristic common for English text.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Estimate prompt tokens from a request's messages array.
 */
export function estimatePromptTokens(messages: ChatCompletionRequest["messages"]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.text) totalChars += part.text.length;
      }
    }
  }
  return Math.max(1, Math.ceil(totalChars / 4));
}

/**
 * Build usage object: use explicit overrides if provided, otherwise estimate.
 */
function resolveUsage(
  overrides: ResponseOverrides | undefined,
  promptText: string,
  completionText: string,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  if (overrides?.usage) {
    const u = overrides.usage;
    const prompt = u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? 0;
    const completion = u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? 0;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: u.total_tokens ?? u.totalTokenCount ?? prompt + completion,
    };
  }
  const prompt = estimateTokens(promptText || "x");
  const completion = estimateTokens(completionText || "x");
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/**
 * Build an SSE usage chunk for streaming responses.
 * OpenAI emits this as the final chunk before [DONE] when
 * stream_options.include_usage is true. It has an empty choices array.
 */
export function buildUsageChunk(
  id: string,
  model: string,
  created: number,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  fingerprint?: string,
): SSEChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage,
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  };
}

export function buildTextChunks(
  content: string,
  model: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
): SSEChunk[] {
  const id = overrides?.id ?? generateId();
  const created = overrides?.created ?? Math.floor(Date.now() / 1000);
  const effectiveModel = overrides?.model ?? model;
  const chunks: SSEChunk[] = [];
  const fingerprint = overrides?.systemFingerprint;

  // Reasoning chunks (emitted before content, OpenRouter format)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          { index: 0, delta: { reasoning_content: slice }, logprobs: null, finish_reason: null },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Role chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: { role: overrides?.role ?? "assistant", content: "" },
        logprobs: null,
        finish_reason: null,
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  // Content chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [{ index: 0, delta: { content: slice }, logprobs: null, finish_reason: null }],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });
  }

  // Finish chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      { index: 0, delta: {}, logprobs: null, finish_reason: overrides?.finishReason ?? "stop" },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  return chunks;
}

export function buildToolCallChunks(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
): SSEChunk[] {
  const id = overrides?.id ?? generateId();
  const created = overrides?.created ?? Math.floor(Date.now() / 1000);
  const effectiveModel = overrides?.model ?? model;
  const chunks: SSEChunk[] = [];
  const fingerprint = overrides?.systemFingerprint;

  // Reasoning chunks (emitted before tool calls, OpenRouter format)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          { index: 0, delta: { reasoning_content: slice }, logprobs: null, finish_reason: null },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Role chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: { role: overrides?.role ?? "assistant", content: null },
        logprobs: null,
        finish_reason: null,
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  // Tool call chunks — one initial chunk per tool call, then argument chunks
  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    const tcId = tc.id || generateToolCallId();

    // Initial tool call chunk (id + function name)
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: tcIdx,
                id: tcId,
                type: "function",
                function: { name: tc.name, arguments: "" },
              },
            ],
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });

    // Argument streaming chunks
    const args = tc.arguments;
    for (let i = 0; i < args.length; i += chunkSize) {
      const slice = args.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: tcIdx, function: { arguments: slice } }],
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Finish chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  return chunks;
}

// Non-streaming response builders

export function buildTextCompletion(
  content: string,
  model: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
  requestMessages?: ChatCompletionRequest["messages"],
): ChatCompletion {
  const promptText = requestMessages
    ? requestMessages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => p.text ?? "").join("")
              : "",
        )
        .join("")
    : "";
  return {
    id: overrides?.id ?? generateId(),
    object: "chat.completion",
    created: overrides?.created ?? Math.floor(Date.now() / 1000),
    model: overrides?.model ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: overrides?.role ?? "assistant",
          content,
          refusal: null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "stop",
      },
    ],
    usage: resolveUsage(overrides, promptText, content),
    ...(overrides?.systemFingerprint !== undefined && {
      system_fingerprint: overrides.systemFingerprint,
    }),
  };
}

export function buildToolCallCompletion(
  toolCalls: ToolCall[],
  model: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
  requestMessages?: ChatCompletionRequest["messages"],
): ChatCompletion {
  const promptText = requestMessages
    ? requestMessages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => p.text ?? "").join("")
              : "",
        )
        .join("")
    : "";
  const completionText = toolCalls.map((tc) => tc.name + tc.arguments).join("");
  return {
    id: overrides?.id ?? generateId(),
    object: "chat.completion",
    created: overrides?.created ?? Math.floor(Date.now() / 1000),
    model: overrides?.model ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: overrides?.role ?? "assistant",
          content: null,
          refusal: null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id || generateToolCallId(),
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    usage: resolveUsage(overrides, promptText, completionText),
    ...(overrides?.systemFingerprint !== undefined && {
      system_fingerprint: overrides.systemFingerprint,
    }),
  };
}

export function buildContentWithToolCallsChunks(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  reasoning?: string,
  overrides?: ResponseOverrides,
): SSEChunk[] {
  const id = overrides?.id ?? generateId();
  const created = overrides?.created ?? Math.floor(Date.now() / 1000);
  const effectiveModel = overrides?.model ?? model;
  const chunks: SSEChunk[] = [];
  const fingerprint = overrides?.systemFingerprint;

  // Reasoning chunks (emitted before content, OpenRouter format)
  if (reasoning) {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      const slice = reasoning.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          { index: 0, delta: { reasoning_content: slice }, logprobs: null, finish_reason: null },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Role chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: { role: overrides?.role ?? "assistant", content: "" },
        logprobs: null,
        finish_reason: null,
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  // Content chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [{ index: 0, delta: { content: slice }, logprobs: null, finish_reason: null }],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });
  }

  // Tool call chunks — one initial chunk per tool call, then argument chunks
  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    const tcId = tc.id || generateToolCallId();

    // Initial tool call chunk (id + function name)
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: tcIdx,
                id: tcId,
                type: "function",
                function: { name: tc.name, arguments: "" },
              },
            ],
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });

    // Argument streaming chunks
    const args = tc.arguments;
    for (let i = 0; i < args.length; i += chunkSize) {
      const slice = args.slice(i, i + chunkSize);
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: tcIdx, function: { arguments: slice } }],
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
        ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
      });
    }
  }

  // Finish chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  return chunks;
}

export function buildContentWithToolCallsCompletion(
  content: string,
  toolCalls: ToolCall[],
  model: string,
  reasoning?: string,
  overrides?: ResponseOverrides,
  requestMessages?: ChatCompletionRequest["messages"],
): ChatCompletion {
  const promptText = requestMessages
    ? requestMessages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => p.text ?? "").join("")
              : "",
        )
        .join("")
    : "";
  const completionText = content + toolCalls.map((tc) => tc.name + tc.arguments).join("");
  return {
    id: overrides?.id ?? generateId(),
    object: "chat.completion",
    created: overrides?.created ?? Math.floor(Date.now() / 1000),
    model: overrides?.model ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: overrides?.role ?? "assistant",
          content,
          refusal: null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id || generateToolCallId(),
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        logprobs: null,
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    usage: resolveUsage(overrides, promptText, completionText),
    ...(overrides?.systemFingerprint !== undefined && {
      system_fingerprint: overrides.systemFingerprint,
    }),
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export function readBody(
  req: http.IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        req.destroy();
        reject(new Error(`Request body exceeded size limit of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString());
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

// ─── Pattern matching ─────────────────────────────────────────────────────

/**
 * Case-insensitive substring/regex match used for search, rerank, and
 * moderation endpoints where exact casing rarely matters. String patterns
 * are lowercased on both sides before comparison.
 *
 * Note: This intentionally differs from the case-sensitive matching in
 * {@link matchFixture} (router.ts), where fixture authors expect exact
 * string matching against chat completion user messages.
 */
export function matchesPattern(text: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
  pattern.lastIndex = 0;
  return pattern.test(text);
}

export function getTestId(req: http.IncomingMessage): string {
  const headerValue = req.headers["x-test-id"];
  if (Array.isArray(headerValue)) {
    if (headerValue.length > 0 && headerValue[0]) return headerValue[0];
  } else if (typeof headerValue === "string" && headerValue) {
    return headerValue;
  }

  const url = req.url ?? "/";
  const qIdx = url.indexOf("?");
  if (qIdx !== -1) {
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const queryValue = params.get("testId");
    if (queryValue) return queryValue;
  }

  return DEFAULT_TEST_ID;
}

export function getContext(req: http.IncomingMessage): string | undefined {
  const headerValue = req.headers["x-aimock-context"];
  if (Array.isArray(headerValue)) {
    if (headerValue.length > 0 && headerValue[0]) return headerValue[0];
  } else if (typeof headerValue === "string" && headerValue) {
    return headerValue;
  }
  return undefined;
}

// ─── Snapshot recording helpers ──────────────────────────────────────────────

/**
 * Convert a test ID (e.g. Playwright titlePath) into a filesystem-safe slug
 * suitable for use as a directory name in snapshot-style recording.
 */
export function slugifyTestId(testId: string): string {
  return testId
    .replace(/^.*?\.(?:spec|test|e2e)\.(?:tsx|ts|jsx|js|mjs|cjs)(?=\s|›|$)\s*›?\s*/i, "") // strip test file extension prefix
    .replace(/\s*[›>]\s*/g, "--") // Playwright titlePath separator → double dash
    .replace(/[^\w-]/g, "-") // non-word chars → dash
    .replace(/-{3,}/g, "--") // collapse 3+ dashes to double
    .replace(/^-+|-+$/g, "") // trim leading/trailing dashes
    .toLowerCase();
}

// ─── Embedding helpers ─────────────────────────────────────────────────────

const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/**
 * Generate a deterministic embedding vector from input text.
 * Hashes the input with SHA-256 and spreads the hash bytes across
 * the requested number of dimensions, producing values in [-1, 1].
 */
export function generateDeterministicEmbedding(
  input: string,
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
): number[] {
  let currentHash = createHash("sha256").update(input).digest();
  const embedding: number[] = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    if (i > 0 && i % 32 === 0) {
      currentHash = createHash("sha256").update(currentHash).digest();
    }
    // Map 0-255 → -1.0 to 1.0
    embedding[i] = currentHash[i % 32] / 127.5 - 1;
  }
  return embedding;
}

export interface EmbeddingAPIResponse {
  object: "list";
  data: { object: "embedding"; index: number; embedding: number[] }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Build an OpenAI-format embeddings API response for one or more inputs.
 */
export function buildEmbeddingResponse(
  embeddings: number[][],
  model: string,
  usage?: { prompt_tokens?: number; total_tokens?: number },
): EmbeddingAPIResponse {
  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({
      object: "embedding" as const,
      index,
      embedding,
    })),
    model,
    usage: { prompt_tokens: usage?.prompt_tokens ?? 0, total_tokens: usage?.total_tokens ?? 0 },
  };
}
