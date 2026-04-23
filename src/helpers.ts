import { createHash, randomBytes } from "node:crypto";
import type * as http from "node:http";
import type {
  FixtureResponse,
  TextResponse,
  ToolCallResponse,
  ContentWithToolCallsResponse,
  ErrorResponse,
  EmbeddingResponse,
  ImageResponse,
  AudioResponse,
  TranscriptionResponse,
  VideoResponse,
  SSEChunk,
  ToolCall,
  ChatCompletion,
  ResponseOverrides,
} from "./types.js";

const REDACTED_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);

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
    typeof (r as ErrorResponse).error === "object"
  );
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
  return "audio" in r && typeof (r as AudioResponse).audio === "string";
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
        choices: [{ index: 0, delta: { reasoning_content: slice }, finish_reason: null }],
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
      choices: [{ index: 0, delta: { content: slice }, finish_reason: null }],
      ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
    });
  }

  // Finish chunk
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: effectiveModel,
    choices: [{ index: 0, delta: {}, finish_reason: overrides?.finishReason ?? "stop" }],
    ...(fingerprint !== undefined && { system_fingerprint: fingerprint }),
  });

  return chunks;
}

export function buildToolCallChunks(
  toolCalls: ToolCall[],
  model: string,
  chunkSize: number,
  overrides?: ResponseOverrides,
): SSEChunk[] {
  const id = overrides?.id ?? generateId();
  const created = overrides?.created ?? Math.floor(Date.now() / 1000);
  const effectiveModel = overrides?.model ?? model;
  const chunks: SSEChunk[] = [];
  const fingerprint = overrides?.systemFingerprint;

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
    choices: [{ index: 0, delta: {}, finish_reason: overrides?.finishReason ?? "tool_calls" }],
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
): ChatCompletion {
  const defaultUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
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
        finish_reason: overrides?.finishReason ?? "stop",
      },
    ],
    usage: overrides?.usage
      ? {
          prompt_tokens: overrides.usage.prompt_tokens ?? defaultUsage.prompt_tokens,
          completion_tokens: overrides.usage.completion_tokens ?? defaultUsage.completion_tokens,
          total_tokens:
            overrides.usage.total_tokens ??
            (overrides.usage.prompt_tokens ?? 0) + (overrides.usage.completion_tokens ?? 0),
        }
      : defaultUsage,
    ...(overrides?.systemFingerprint !== undefined && {
      system_fingerprint: overrides.systemFingerprint,
    }),
  };
}

export function buildToolCallCompletion(
  toolCalls: ToolCall[],
  model: string,
  overrides?: ResponseOverrides,
): ChatCompletion {
  const defaultUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
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
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id || generateToolCallId(),
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    usage: overrides?.usage
      ? {
          prompt_tokens: overrides.usage.prompt_tokens ?? defaultUsage.prompt_tokens,
          completion_tokens: overrides.usage.completion_tokens ?? defaultUsage.completion_tokens,
          total_tokens:
            overrides.usage.total_tokens ??
            (overrides.usage.prompt_tokens ?? 0) + (overrides.usage.completion_tokens ?? 0),
        }
      : defaultUsage,
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
        choices: [{ index: 0, delta: { reasoning_content: slice }, finish_reason: null }],
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
      choices: [{ index: 0, delta: { content: slice }, finish_reason: null }],
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
    choices: [{ index: 0, delta: {}, finish_reason: overrides?.finishReason ?? "tool_calls" }],
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
): ChatCompletion {
  const defaultUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
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
        finish_reason: overrides?.finishReason ?? "tool_calls",
      },
    ],
    usage: overrides?.usage
      ? {
          prompt_tokens: overrides.usage.prompt_tokens ?? defaultUsage.prompt_tokens,
          completion_tokens: overrides.usage.completion_tokens ?? defaultUsage.completion_tokens,
          total_tokens:
            overrides.usage.total_tokens ??
            (overrides.usage.prompt_tokens ?? 0) + (overrides.usage.completion_tokens ?? 0),
        }
      : defaultUsage,
    ...(overrides?.systemFingerprint !== undefined && {
      system_fingerprint: overrides.systemFingerprint,
    }),
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
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

  // Duplicated from journal.ts DEFAULT_TEST_ID — importing it here would create
  // a circular dependency (journal.ts imports from helpers.ts).
  return "__default__";
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
): EmbeddingAPIResponse {
  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({
      object: "embedding" as const,
      index,
      embedding,
    })),
    model,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}
