import type * as http from "node:http";
import type * as net from "node:net";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

// aimock type definitions — shared across all provider adapters and the fixture router.

export interface Mountable {
  handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean>;
  handleUpgrade?(socket: net.Socket, head: Buffer, pathname: string): Promise<boolean>;
  health?(): { status: string; [key: string]: unknown };
  setJournal?(journal: Journal): void;
  setBaseUrl?(url: string): void;
  setRegistry?(registry: MetricsRegistry): void;
}

export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
}

export interface ToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  /**
   * OpenRouter fallback model list. When present (and the request arrived on
   * the OpenRouter `/api/v1/...` base), the candidate list `[model, ...models]`
   * is attempted in order. A NON-error fixture match wins; an ERROR fixture
   * candidate falls through to the next candidate by default — UNLESS it is
   * terminal, in which case that error is served with no failover. An error is
   * terminal when its fixture sets `fallthrough: false` (per-error-class gate)
   * or when the request sets `provider.allow_fallbacks: false` (request-level
   * gate). A winning (non-error) slug is echoed back as the response `model`;
   * when the chain terminates on an error, the response is the OpenRouter error
   * envelope (`{ error: { code, message, metadata? } }`), which carries no
   * `model` field. Purely additive: a request without `models` behaves as a
   * single-model match. Every other
   * OpenRouter request extension (`route`, `reasoning`, `plugins`,
   * `prediction`, `usage`, and any unknown key) is accepted and journaled via
   * the index signature below — never required, never rejected. aimock does not
   * model those sub-shapes; unknown body keys pass straight through.
   */
  models?: string[];
  /**
   * OpenRouter provider-routing preferences. Accepted loosely and journaled
   * verbatim; the ONLY sub-field aimock reads behaviorally is
   * `allow_fallbacks`. When `allow_fallbacks === false` on an OpenRouter
   * request, the `models[]` fallback loop is suppressed — only the primary is
   * tried, and a primary error fixture is served as terminal instead of
   * falling through (the fail-CLOSED half of the feature). Absent/`true` keeps
   * the default fall-through behavior. Every other provider-prefs key
   * (`order`, `only`, `ignore`, `sort`, …) passes straight through unread.
   */
  provider?: { allow_fallbacks?: boolean; [key: string]: unknown };
  stream_options?: { include_usage?: boolean; [key: string]: unknown };
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  tool_choice?: string | object;
  response_format?: { type: string; [key: string]: unknown };
  /** Embedding input text, set by the embeddings handler for fixture matching. */
  embeddingInput?: string;
  /** Endpoint type, set by handlers for fixture endpoint filtering. */
  _endpointType?: string;
  /** Context identifier, set by handlers for fixture context routing. */
  _context?: string;
  /**
   * Video-provider discriminator, set by the async video handlers for journal
   * and dispatch clarity only. NOT a fixture match key — `buildFixtureMatch`
   * derives the endpoint from `_endpointType` and never reads this field; the
   * model string is the provider disambiguator (veo-* / grok-imagine-* /
   * openrouter ids do not overlap).
   */
  _videoProvider?: "openrouter" | "veo" | "grok";
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: object };
}

// Fixture matching

export interface FixtureMatch {
  userMessage?: string | RegExp;
  /**
   * Substring, regexp, or array of substrings matched against the concatenated
   * text content of every `system` role message in the request. Gates fixture
   * activation on values the host plumbs in via system messages (agent
   * context, persona, dynamic config) instead of the user-typed prompt — so
   * changing context state in the calling app causes stale fixtures to fall
   * through to a real upstream instead of silently returning a baked response
   * that no longer reflects reality.
   *
   * When given an array of strings, ALL substrings must be present (AND
   * semantics). Useful when the gate must combine multiple non-adjacent
   * tokens — e.g., a default name AND a default activity list whose JSON
   * positions vary across requests.
   */
  systemMessage?: string | string[] | RegExp;
  inputText?: string | RegExp;
  toolCallId?: string;
  /**
   * Substring matched against the text content of the LAST message when that
   * message is a `tool` result (same last-message rule as `toolCallId`).
   * Discriminates fixtures whose requests differ ONLY inside the tool-result
   * payload — e.g. a human-in-the-loop tool where approve and cancel resume
   * with the same toolCallId but different result JSON.
   */
  toolResultContains?: string;
  toolName?: string;
  model?: string | RegExp;
  responseFormat?: string;
  predicate?: (req: ChatCompletionRequest) => boolean;
  /** Which occurrence of this match to respond to (0-indexed). Undefined means match any. */
  sequenceIndex?: number;
  turnIndex?: number;
  /**
   * Turn-scoped tool-result presence gate: matches on whether the CURRENT turn
   * (the messages after the last `role: "user"` message) contains a `role: "tool"`
   * message. Scoping to the current turn — rather than the whole conversation —
   * lets a leg-1 (`false`) / leg-2 (`true`) fixture pair keep discriminating on
   * later turns whose history still carries earlier turns' tool results. If the
   * request has no user message, it falls back to scanning the whole conversation.
   */
  hasToolResult?: boolean;
  endpoint?:
    | "chat"
    | "image"
    | "speech"
    | "transcription"
    | "translation"
    | "video"
    | "embedding"
    | "audio-gen"
    | "elevenlabs-tts"
    | "fal-audio"
    | "fal"
    | "realtime"
    | "realtime-transcription"
    | "realtime-translation";
  context?: string;
}

// Fixture response types

/**
 * Fields that override auto-generated envelope values in the built response.
 * Scalar fields (finishReason, role) use OpenAI-canonical values — provider
 * handlers translate automatically. For usage, provide field names native to
 * your target provider (OpenAI Chat: prompt_tokens, completion_tokens;
 * Responses API: input_tokens, output_tokens; Anthropic: input_tokens,
 * output_tokens; Gemini: promptTokenCount, candidatesTokenCount).
 *
 * When total_tokens (or provider equivalent) is omitted, it is auto-computed
 * from the component fields.
 *
 * Provider support: OpenAI Chat (all 7), Responses API (5: no role,
 * systemFingerprint), Claude (5: no created, systemFingerprint),
 * Gemini (2: only finishReason, usage).
 */
export interface ResponseOverrides {
  id?: string;
  created?: number;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    /**
     * OpenRouter per-request cost (USD/credits). Fixture-scriptable — powers
     * budget-guard demos ("assert the guard trips at $5 without spending $5").
     * Emitted on OpenRouter-shaped responses only, and ONLY when supplied —
     * `cost`/`cost_details` are nullable and omitted by default (never 0).
     */
    cost?: number;
    /**
     * OpenRouter cost breakdown. When the response emits `cost_details` at all
     * it MUST carry all three upstream fields (the canonical `@openrouter/sdk`
     * throws on a partial object); a fixture may supply any subset and the rest
     * default to 0. Only emitted when the fixture supplies a `cost`.
     */
    cost_details?: {
      upstream_inference_cost?: number;
      upstream_inference_prompt_cost?: number;
      upstream_inference_completions_cost?: number;
      [key: string]: unknown;
    };
    /**
     * OpenRouter prompt-token breakdown. Emitted ONLY when overridden — the
     * default response never asserts a fake cache state.
     */
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
      audio_tokens?: number;
      [key: string]: unknown;
    };
    /**
     * OpenRouter completion-token breakdown. Emitted ONLY when overridden.
     */
    completion_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
    /**
     * OpenRouter bring-your-own-key flag on the usage object. Emitted ONLY when
     * overridden (avoids asserting a fake BYOK state by default).
     */
    is_byok?: boolean;
  };
  systemFingerprint?: string;
  finishReason?: string;
  role?: string;
  /**
   * OpenRouter top-level `provider` override. When omitted, OpenRouter-shaped
   * responses default it to the author segment of the winning model slug
   * (`openai/gpt-4o` → `"openai"`). Ignored for OpenAI (`/v1/...`) responses.
   */
  provider?: string;
  /**
   * OpenRouter `native_finish_reason` override (the raw upstream finish reason).
   * When omitted, OpenRouter-shaped responses mirror `finish_reason`. Ignored
   * for OpenAI responses.
   */
  nativeFinishReason?: string;
}

export interface TextResponse extends ResponseOverrides {
  content: string;
  reasoning?: string;
  /**
   * The real cryptographic `signature` captured from a recorded Anthropic
   * thinking turn. When present it is emitted on the replayed thinking block;
   * otherwise replay falls back to aimock's round-trip-safe placeholder.
   * Persisted only alongside a non-empty `reasoning`: a signature captured
   * without plaintext reasoning (e.g. whitespace-only thinking) is intentionally
   * discarded at the persistence layer, since replay attaches signatures only to
   * plaintext thinking blocks.
   */
  reasoningSignature?: string;
  /**
   * Opaque `data` payload(s) of any Anthropic `redacted_thinking` blocks
   * captured from a recorded thinking turn, in stream order. When present they
   * are replayed as faithful `redacted_thinking` content blocks so the encrypted
   * reasoning round-trips; absent for non-Anthropic providers and turns without
   * redacted thinking. Recorded redacted blocks replay as a leading group: the
   * original interleaving of `thinking` and `redacted_thinking` blocks is not
   * preserved (see the CHANGELOG fidelity caveat).
   */
  redactedThinking?: string[];
  webSearches?: string[];
}

export interface ToolCall {
  name: string;
  arguments: string;
  id?: string;
}

/**
 * A single ordered streaming block for a {@link ContentWithToolCallsResponse}.
 *
 * When a combined content+toolCalls fixture sets the optional `blocks` field,
 * builders stream the blocks in array order — enabling tool-call-before-text
 * and interleaved orderings that the legacy `{ content, toolCalls }` shape
 * (always text-first) cannot express. A `text` block carries a text segment; a
 * `toolCall` block mirrors {@link ToolCall} (`name` + JSON-string `arguments`,
 * optional `id`).
 */
export type FixtureBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; arguments: string; id?: string };

export interface ToolCallResponse extends ResponseOverrides {
  toolCalls: ToolCall[];
  reasoning?: string;
  /** Real Anthropic thinking-block signature; see {@link TextResponse.reasoningSignature}. */
  reasoningSignature?: string;
  /** Anthropic redacted_thinking block data; see {@link TextResponse.redactedThinking}. */
  redactedThinking?: string[];
  webSearches?: string[];
}

export interface ContentWithToolCallsResponse extends ResponseOverrides {
  /**
   * Combined-turn text. Required for the legacy `{ content, toolCalls }` shape
   * and the combined `{ content, toolCalls, blocks }` shape. OPTIONAL only for a
   * BLOCKS-ONLY fixture (`{ blocks: [...] }` with no `content`/`toolCalls`),
   * where the ordered `blocks` array is the sole source of streamed output and
   * the legacy text-first builder branch is never taken. The runtime guard
   * `isContentWithToolCallsResponse` enforces this: it matches when BOTH
   * `content` + `toolCalls` are present (legacy/combined) OR when a non-empty
   * `blocks` array is present (blocks-only).
   */
  content?: string;
  /** See {@link ContentWithToolCallsResponse.content} — optional only for the blocks-only shape. */
  toolCalls?: ToolCall[];
  /**
   * Optional ordered streaming blocks. When present, builders stream these in
   * array order (tool-first / interleaved); when absent, the legacy
   * `{ content, toolCalls }` text-first path runs unchanged. Purely additive.
   * A non-empty `blocks` array also makes this a FIRST-CLASS blocks-only
   * response even without `content`/`toolCalls` (see those fields above).
   */
  blocks?: FixtureBlock[];
  reasoning?: string;
  /** Real Anthropic thinking-block signature; see {@link TextResponse.reasoningSignature}. */
  reasoningSignature?: string;
  /** Anthropic redacted_thinking block data; see {@link TextResponse.redactedThinking}. */
  redactedThinking?: string[];
  webSearches?: string[];
}

export interface ErrorResponse {
  error: {
    message: string;
    type?: string;
    param?: string | null;
    code?: string;
    /**
     * OpenRouter error metadata. Emitted verbatim inside the OpenRouter error
     * envelope (`{ error: { code, message, metadata } }`) when the request
     * arrived on the OpenRouter base. Moderation blocks carry
     * `{ reasons, flagged_input, provider_name, model_slug }` on a 403.
     * Ignored for OpenAI-shaped error responses.
     */
    metadata?: Record<string, unknown>;
  };
  status?: number;
  /** Override the Retry-After header value on 429 responses. Default: 1. */
  retryAfter?: number;
  /**
   * OpenRouter `models[]` failover eligibility for THIS error class. Real
   * OpenRouter fails over INCONSISTENTLY by error class — a `403 budget-exceeded`
   * or a generic "provider returned error" is served as terminal (it does NOT
   * advance to the next `models[]` candidate), while 429/503 usually do fail
   * over (openclaw #60191). This flag lets a fixture reproduce that:
   * - absent / `true` (default) — the error candidate FALLS THROUGH to the next
   *   `models[]` candidate (backward-compatible; existing fixtures unchanged).
   * - `false` — the error is TERMINAL: the fallback loop stops and serves this
   *   error with no failover, even if a later candidate would match.
   *
   * Composes with the request-level `provider.allow_fallbacks`: fall-through
   * happens only when BOTH allow it (if EITHER says don't, don't). Only
   * consulted for OpenRouter `models[]` fallback; ignored elsewhere.
   */
  fallthrough?: boolean;
}

export interface EmbeddingResponse {
  embedding: number[];
}

export interface ImageItem {
  url?: string;
  b64Json?: string;
  revisedPrompt?: string;
}

export interface ImageResponse {
  image?: ImageItem;
  images?: ImageItem[];
}

// ORDERING CONTRACT: audio fixtures MUST be discriminated by `isAudioResponse`
// BEFORE the `isContentWithToolCallsResponse` / `isToolCallResponse` / text
// guards, because the optional companion fields below make these shapes
// structurally overlap (an AudioResponse with `toolCalls`/`content` would also
// satisfy those guards otherwise).
export interface AudioResponse {
  audio: string | { b64Json: string; contentType?: string };
  format?: string;
  /**
   * Companion modalities that can accompany streamed audio. A single Gemini turn
   * may interleave inlineData audio with a functionCall and/or text/thought
   * parts; the recorder preserves them here so the tool call / content / reasoning
   * are not silently discarded when audio is also present.
   */
  toolCalls?: ToolCall[];
  content?: string;
  reasoning?: string;
}

export interface TranscriptionResponse {
  transcription: {
    text: string;
    language?: string;
    languages?: Array<{ code: string }>;
    duration?: number;
    usage?: Record<string, unknown>;
    words?: Array<{ word: string; start: number; end: number }>;
    segments?: Array<{ id: number; text: string; start: number; end: number }>;
  };
}

export interface VideoResponse {
  video: {
    id: string;
    status: "processing" | "completed" | "failed";
    url?: string;
    /** Failure message surfaced by async video jobs (e.g. OpenRouter `error`). */
    error?: string;
    /** Base64-encoded video bytes served by content-download endpoints. */
    b64?: string;
    /** Generation cost surfaced in usage envelopes (e.g. OpenRouter `usage.cost`). */
    cost?: number;
    /** Clip duration in seconds surfaced by some providers (e.g. Grok `video.duration`). */
    duration?: number;
  };
}

/**
 * Pass-through JSON response. Used by handlers (e.g. fal.ai) that record
 * arbitrary upstream JSON payloads and replay them verbatim, without the
 * provider-specific shape coercion the other response types impose.
 */
export interface RawJSONResponse extends ResponseOverrides {
  json: unknown;
  status?: number;
  /**
   * Billed quantity surfaced on the completed fal `queue-result` response via
   * the `x-fal-billable-units` header (emitted alongside `x-fal-request-id` on
   * the completed result). Real fal sets this header on its queue responses;
   * recent versions of `@tanstack/ai-fal` read it to populate a consumer-side
   * billed-units field (e.g. `usage.unitsBilled`). Omit it to preserve the
   * header-less default — present only to let a fixture opt into exercising a
   * consumer's cost/billing accounting path on replay.
   */
  billableUnits?: number;
}

export type FixtureResponse =
  | TextResponse
  | ToolCallResponse
  | ContentWithToolCallsResponse
  | ErrorResponse
  | EmbeddingResponse
  | ImageResponse
  | AudioResponse
  | TranscriptionResponse
  | VideoResponse
  | RawJSONResponse;

// GA Realtime session types

export type RealtimePhase = "final_answer" | "commentary";

export interface GASessionAudioConfig {
  voice: string | null;
  input_audio_format: { type: string; rate?: number; [key: string]: unknown } | null;
  output_audio_format: { type: string; rate?: number; [key: string]: unknown } | null;
  input_audio_noise_reduction: { type: string } | null;
  input_audio_transcription: { model: string } | null;
}

export interface GASessionConfig {
  model: string;
  modalities: string[];
  instructions: string;
  tools: unknown[];
  temperature: number;
  max_response_output_tokens: number | "inf";
  audio: GASessionAudioConfig;
  turn_detection: unknown | null;
  input_audio_transcription: { model: string } | null;
  type: "conversation" | "transcription" | "translation";
  reasoning: { effort: string } | null;
}

// Streaming physics

export interface StreamingProfile {
  ttft?: number; // Time to first token (ms)
  tps?: number; // Tokens per second
  jitter?: number; // Random variance factor (0-1), default 0
}

/**
 * Per-frame arrival timestamps captured during proxy recording.
 * Used during replay to reproduce real-world streaming timing instead of
 * the synthetic model (StreamingProfile / flat latency).
 */
export interface RecordedTimings {
  ttftMs: number;
  interChunkDelaysMs: number[];
  totalDurationMs: number;
}

/**
 * Probabilistic chaos injection rates.
 *
 * Rates are evaluated sequentially per request — drop → malformed → disconnect
 * — and the first hit wins. Consequently malformedRate is conditional on drop
 * not firing, and disconnectRate is conditional on neither drop nor malformed
 * firing. A config of `{ dropRate: 0.5, malformedRate: 0.5 }` yields a ~25 %
 * effective malformed rate, not 50 %.
 */
export interface ChaosConfig {
  dropRate?: number;
  malformedRate?: number;
  disconnectRate?: number;
}

export type ChaosAction = "drop" | "malformed" | "disconnect";

// Response factory — allows dynamic fixture responses based on the incoming request

export type ResponseFactory = (
  req: ChatCompletionRequest,
) => FixtureResponse | Promise<FixtureResponse>;

// Fixture

export interface Fixture {
  match: FixtureMatch;
  response: FixtureResponse | ResponseFactory;
  latency?: number;
  chunkSize?: number;
  truncateAfterChunks?: number;
  disconnectAfterMs?: number;
  streamingProfile?: StreamingProfile;
  recordedTimings?: RecordedTimings;
  replaySpeed?: number;
  chaos?: ChaosConfig;
  /**
   * Opt into OpenRouter's `: OPENROUTER PROCESSING` SSE keepalive comment
   * lines on this fixture's streamed OpenRouter responses (default OFF).
   * A faithful client skips `:`-prefixed lines before JSON-parsing; enabling
   * this exercises that path. No effect on non-streaming or OpenAI responses.
   */
  openRouterProcessing?: boolean;
  metadata?: {
    systemHash?: string;
    toolsHash?: string;
  };
}

export type FixtureOpts = Omit<Fixture, "match" | "response">;
export type EmbeddingFixtureOpts = Pick<FixtureOpts, "latency" | "chaos">;
/**
 * Options for the fal queue/run fixture builders. Adds `billableUnits`, which
 * is emitted as the `x-fal-billable-units` header on the completed
 * `queue-result` response (see {@link RawJSONResponse.billableUnits}).
 */
export type FalQueueOpts = FixtureOpts & { billableUnits?: number };

// Fixture file format (JSON on disk)
//
// File-entry types are intentionally relaxed compared to their runtime
// counterparts so that fixture authors can write JSON objects where the
// API ultimately expects a JSON *string*.  The fixture loader auto-
// stringifies these before building the runtime Fixture.

export interface FixtureFileToolCall {
  name: string;
  /** Accepts a JSON object or array for convenience — the loader will JSON.stringify it. */
  arguments: string | Record<string, unknown> | unknown[];
  id?: string;
}

/**
 * On-disk counterpart of {@link FixtureBlock}. A `toolCall` block's
 * `arguments` is relaxed exactly like {@link FixtureFileToolCall} so authors
 * may write a JSON object/array; the loader JSON.stringifies it into the
 * runtime string form. Normalizes to a {@link FixtureBlock}.
 */
export type FixtureFileBlock =
  | { type: "text"; text: string }
  | {
      type: "toolCall";
      name: string;
      /** Accepts a JSON object or array for convenience — the loader will JSON.stringify it. */
      arguments: string | Record<string, unknown> | unknown[];
      id?: string;
    };

export interface FixtureFileToolCallResponse extends ResponseOverrides {
  toolCalls: FixtureFileToolCall[];
  reasoning?: string;
  /** Real Anthropic thinking-block signature; see {@link TextResponse.reasoningSignature}. */
  reasoningSignature?: string;
  /** Anthropic redacted_thinking block data; see {@link TextResponse.redactedThinking}. */
  redactedThinking?: string[];
  webSearches?: string[];
}

export interface FixtureFileTextResponse extends ResponseOverrides {
  /** Accepts a JSON object or array (structured output) — the loader will JSON.stringify it. */
  content: string | Record<string, unknown> | unknown[];
  reasoning?: string;
  /** Real Anthropic thinking-block signature; see {@link TextResponse.reasoningSignature}. */
  reasoningSignature?: string;
  /** Anthropic redacted_thinking block data; see {@link TextResponse.redactedThinking}. */
  redactedThinking?: string[];
  webSearches?: string[];
}

export interface FixtureFileContentWithToolCallsResponse extends ResponseOverrides {
  /**
   * Accepts a JSON object or array (structured output) — the loader will
   * JSON.stringify it. OPTIONAL only for a BLOCKS-ONLY fixture (mirrors
   * {@link ContentWithToolCallsResponse.content}); required for the
   * legacy/combined shapes.
   */
  content?: string | Record<string, unknown> | unknown[];
  /** See {@link FixtureFileContentWithToolCallsResponse.content} — optional only for the blocks-only shape. */
  toolCalls?: FixtureFileToolCall[];
  /**
   * Optional ordered streaming blocks (mirrors the in-memory
   * {@link ContentWithToolCallsResponse.blocks}). When present, builders stream
   * these in array order (tool-first / interleaved); a `toolCall` block's
   * object `arguments` is auto-stringified just like `toolCalls[].arguments`.
   * Absent → legacy text-first path runs unchanged. Purely additive. Uses the
   * on-disk {@link FixtureFileBlock} shape with relaxed `arguments`. A non-empty
   * `blocks` array alone makes this a first-class blocks-only fixture.
   */
  blocks?: FixtureFileBlock[];
  reasoning?: string;
  /** Real Anthropic thinking-block signature; see {@link TextResponse.reasoningSignature}. */
  reasoningSignature?: string;
  /** Anthropic redacted_thinking block data; see {@link TextResponse.redactedThinking}. */
  redactedThinking?: string[];
  webSearches?: string[];
}

export type FixtureFileResponse =
  | FixtureFileTextResponse
  | FixtureFileToolCallResponse
  | FixtureFileContentWithToolCallsResponse
  | ErrorResponse
  | EmbeddingResponse
  | ImageResponse
  | AudioResponse
  | TranscriptionResponse
  | VideoResponse
  | RawJSONResponse;

export interface FixtureFile {
  fixtures: FixtureFileEntry[];
}

export interface FixtureFileEntry {
  match: {
    userMessage?: string;
    /**
     * String (single substring) or array of strings (all must be present).
     * Mirrors the runtime FixtureMatch.systemMessage but without the RegExp
     * form, which JSON cannot express.
     */
    systemMessage?: string | string[];
    inputText?: string;
    toolCallId?: string;
    /**
     * Substring matched against the last tool-result message's text content.
     * Mirrors the runtime FixtureMatch.toolResultContains.
     */
    toolResultContains?: string;
    toolName?: string;
    model?: string;
    responseFormat?: string;
    sequenceIndex?: number;
    turnIndex?: number;
    /**
     * Turn-scoped tool-result presence gate: matches on whether the CURRENT turn
     * (the messages after the last `role: "user"` message) contains a `role: "tool"`
     * message, not the whole conversation. Falls back to scanning the whole
     * conversation when the request has no user message. Mirrors the runtime
     * `FixtureMatch.hasToolResult`.
     */
    hasToolResult?: boolean;
    endpoint?:
      | "chat"
      | "image"
      | "speech"
      | "transcription"
      | "translation"
      | "video"
      | "embedding"
      | "audio-gen"
      | "elevenlabs-tts"
      | "fal-audio"
      | "fal"
      | "realtime"
      | "realtime-transcription"
      | "realtime-translation";
    context?: string;
    // predicate not supported in JSON files
  };
  response: FixtureFileResponse;
  latency?: number;
  chunkSize?: number;
  truncateAfterChunks?: number;
  disconnectAfterMs?: number;
  streamingProfile?: StreamingProfile;
  recordedTimings?: RecordedTimings;
  replaySpeed?: number;
  chaos?: ChaosConfig;
  /** See {@link Fixture.openRouterProcessing}. */
  openRouterProcessing?: boolean;
  metadata?: {
    systemHash?: string;
    toolsHash?: string;
  };
}

// Request journal

export interface JournalEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: ChatCompletionRequest | null;
  service?: string;
  response: {
    status: number;
    fixture: Fixture | null;
    /**
     * What was going to serve this request. "fixture" = a fixture matched (or
     * would have, before chaos intervened). "proxy" = no fixture matched and
     * proxy was configured. "internal" = entries where the request was served
     * by aimock's own synthetic logic — neither a matched fixture nor a
     * configured proxy: chaos-path entries (e.g. chaos on the OpenRouter
     * video lifecycle endpoints; in REPLAY mode their normal 200/400/401/404
     * entries omit source, while record-mode 200s on those endpoints carry
     * source:"proxy") AND the OpenRouter video models listing synthesized as
     * the fallback after a FAILED proxy attempt. Absent when the distinction
     * doesn't apply (e.g. 404/503 fallback where nothing was going to serve).
     */
    source?: "fixture" | "proxy" | "internal";
    interrupted?: boolean;
    interruptReason?: string;
    chaosAction?: ChaosAction;
    /** When the X-AIMock-Strict header overrode the server default. */
    strictOverride?: boolean;
  };
}

// SSE chunk types (OpenAI format)

/**
 * OpenRouter-only additions layered onto a `usage` object when a response is
 * shaped for the OpenRouter `/api/v1/...` base. `cost`/`cost_details` are
 * NULLABLE and emitted only when a fixture supplies a cost (default: omitted).
 * When `cost_details` is emitted it carries all three upstream fields (partial
 * objects break the canonical SDK). The detail breakdowns and `is_byok` appear
 * only when a fixture overrides them; an emitted `prompt_tokens_details` always
 * carries `cached_tokens` and an emitted `completion_tokens_details` always
 * carries `reasoning_tokens` (required-if-present in the AI SDK provider).
 */
export interface OpenRouterUsageExtras {
  cost?: number;
  cost_details?: {
    upstream_inference_cost: number;
    upstream_inference_prompt_cost: number;
    upstream_inference_completions_cost: number;
    [key: string]: unknown;
  };
  prompt_tokens_details?: {
    cached_tokens: number;
    cache_write_tokens?: number;
    audio_tokens?: number;
    [key: string]: unknown;
  };
  completion_tokens_details?: { reasoning_tokens: number; [key: string]: unknown };
  is_byok?: boolean;
}

export interface SSEChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: SSEChoice[];
  /** Nullable: OpenRouter shaping emits this on every chunk (null when unset). */
  system_fingerprint?: string | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } & OpenRouterUsageExtras;
  /** OpenRouter top-level provider that served the chunk. OpenRouter shaping only. */
  provider?: string;
  /** OpenRouter emits `service_tier: null` on the final (usage-bearing) chunk. Shaping only. */
  service_tier?: string | null;
}

export interface SSEChoice {
  index: number;
  delta: SSEDelta;
  logprobs: null;
  finish_reason: string | null;
  /** OpenRouter raw upstream finish reason, alongside the normalized one. */
  native_finish_reason?: string | null;
}

export interface SSEDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: SSEToolCallDelta[];
}

export interface SSEToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

// Non-streaming completion response types (OpenAI format)

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } & OpenRouterUsageExtras;
  /**
   * Nullable: OpenRouter shaping always emits this on the non-streaming
   * response (null when no override) because the canonical `@openrouter/sdk`
   * requires the field. OpenAI responses omit it unless overridden.
   */
  system_fingerprint?: string | null;
  /** OpenRouter top-level provider that served the request. OpenRouter shaping only. */
  provider?: string;
  /** OpenRouter emits `service_tier: null` on the non-streaming response. Shaping only. */
  service_tier?: string | null;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  logprobs: null;
  finish_reason: string;
  /** OpenRouter raw upstream finish reason, alongside the normalized one. */
  native_finish_reason?: string;
}

export interface ChatCompletionMessage {
  role: string;
  content: string | null;
  refusal: string | null;
  reasoning_content?: string;
  /**
   * OpenRouter emits `reasoning` (null when absent) on the response message.
   * OpenRouter shaping mirrors `reasoning_content` here (or null). Omitted for
   * OpenAI responses.
   */
  reasoning?: string | null;
  tool_calls?: ToolCallMessage[];
}

// Server options

export type RecordProviderKey =
  | "openai"
  | "anthropic"
  | "gemini"
  | "gemini-interactions"
  | "vertexai"
  | "bedrock"
  | "azure"
  | "ollama"
  | "cohere"
  | "elevenlabs"
  | "fal"
  | "openrouter"
  | "veo"
  | "grok";

export interface RecordConfig {
  providers: Partial<Record<RecordProviderKey, string>>;
  /**
   * aimock's own built-in upstream API keys, keyed by provider. Opt-in and
   * backward-compatible: when set for a provider, aimock injects the key on a
   * fixture-miss passthrough IF the caller sent no credential or a dummy
   * placeholder (see `applyProviderAuth`); a real caller key always overrides.
   * Only static-key providers are eligible: OpenAI/OpenRouter/Cohere/Grok/Ollama
   * (bearer), Anthropic (x-api-key), Gemini/Gemini-Interactions/Veo
   * (x-goog-api-key), Azure OpenAI (api-key), ElevenLabs (xi-api-key), and fal
   * (Authorization: Key). Signed/OAuth providers (Bedrock SigV4, Vertex AI
   * OAuth) are never rewritten. Sourced from AIMOCK_PROVIDER_*_KEY env vars by
   * the CLI (secrets stay out of `ps`).
   */
  providerKeys?: Partial<Record<RecordProviderKey, string>>;
  fixturePath?: string;
  /** Proxy unmatched requests without saving fixtures or caching in memory. */
  proxyOnly?: boolean;
  /**
   * When true, record the exact model version string returned by the provider
   * (e.g. "gpt-4o-2024-08-06") instead of stripping the date suffix to a
   * canonical alias (e.g. "gpt-4o"). Default: false.
   */
  recordFullModelVersion?: boolean;
  /**
   * fal-specific recording knobs for the queue-walk recorder. During recording
   * the queue handler POSTs submit, polls `status_url` until COMPLETED, then
   * GETs `response_url` for the final job body — saved as the fixture. Tune
   * the poll cadence and timeout here if upstream is unusually slow or fast.
   */
  fal?: FalRecordConfig;
  /**
   * OpenRouter-video-specific recording knobs for the live lifecycle proxy on
   * `/api/v1/videos` (submit/poll proxied 1:1; completed jobs are captured
   * eagerly as fixtures).
   */
  openRouterVideo?: OpenRouterVideoRecordConfig;
  /**
   * Connection idle timeout (ms) on the upstream request socket — fires if the
   * socket is inactive for this duration at any point before the response body
   * begins. Default: 30_000 (30s). Increase for upstreams with slow initial
   * responses (reasoning models, queue-backed providers).
   *
   * Nuance on the OpenRouter video surface: the small-JSON lifecycle fetches
   * (submit, status poll, models listing) apply this value as a TOTAL
   * deadline on the whole fetch — indistinguishable from an idle timeout for
   * envelope-sized bodies. The byte-bearing content fetches (eager capture,
   * proxy-only content relay) gate only the response HEADERS on this value;
   * their body progress is governed by `bodyTimeoutMs` idle semantics.
   *
   * Ceiling note: the fetch-based OpenRouter proxy paths run on Node's
   * built-in undici dispatcher, which carries its own ~300s
   * headers/body-timeout defaults — values above that ceiling do not take
   * effect on those paths without installing a custom undici dispatcher
   * (out of aimock's scope).
   */
  upstreamTimeoutMs?: number;
  /**
   * Idle timeout (ms) on the upstream response body — fires if the upstream
   * goes silent (no bytes) for this long after the response has started.
   * Default: 30_000 (30s). Reasoning models under concurrent load can leave
   * 30s+ gaps between streaming chunks while the model is thinking; lift this
   * to e.g. 180_000 in those setups. The OpenRouter video content fetches use
   * the same idle semantics: the timer re-arms on every chunk, so a steadily
   * downloading multi-minute video never times out — only a silent stall does.
   */
  bodyTimeoutMs?: number;
  /**
   * Maximum number of bytes aimock will accumulate in memory from a single
   * proxied upstream response on the record/proxy path. The full response is
   * still relayed to the client byte-for-byte; this cap only bounds the
   * in-memory buffer used to collapse/journal the response. Once the cap is
   * exceeded aimock stops appending to the buffer, marks the response as
   * truncated, and skips collapse/recording — preventing both unbounded heap
   * growth and the `RangeError: Invalid string length` that a >512MB string
   * would otherwise throw. Default: 64 MiB.
   */
  maxProxyBufferBytes?: number;
  /**
   * Maximum number of SSE/NDJSON/EventStream frames whose per-frame state
   * (`frameTimestamps`, parse buffers) aimock retains for a single proxied
   * response. Frame state is count-indexed, not byte-sized, so a long-lived or
   * never-ending stream accumulates it unbounded even when `maxProxyBufferBytes`
   * is generous. Tripping truncation on EITHER bytes OR frame count bounds both;
   * on the trip the accumulated frame state is freed and collapse/recording is
   * skipped (the full response is still relayed to the client byte-for-byte).
   * Default: 5,000,000 frames.
   */
  maxProxyBufferFrames?: number;
}

export interface OpenRouterVideoRecordConfig {
  /**
   * Maximum decoded video size (bytes) embedded as `b64` in a recorded
   * fixture. Captures larger than the cap are persisted WITHOUT `b64` (with a
   * `_warning` in the fixture file) so a multi-hundred-MB video cannot bloat
   * the fixture directory. The cap is also a memory guard: an upstream
   * response that DECLARES an over-cap Content-Length is skipped without
   * downloading, and a response with no declared length is streamed with the
   * byte count enforced during the read — on exceed the download is aborted
   * and nothing oversized is retained in memory. In both cases the
   * same-session job serves the placeholder MP4. Default: 33554432 (32 MB
   * decoded). Set 0 for unlimited. Negative or non-integer values are treated
   * as the default (createServer warns at startup).
   */
  maxContentBytes?: number;
}

export interface FalRecordConfig {
  /** Interval between status polls upstream during recording. Default: 1000ms. */
  pollIntervalMs?: number;
  /** Total budget for an upstream queue walk before aborting. Default: 900000ms (15 min) to accommodate video generation. */
  timeoutMs?: number;
}

export interface MockServerOptions {
  port?: number;
  host?: string;
  latency?: number;
  chunkSize?: number;
  replaySpeed?: number;
  /** Log verbosity. CLI default is "info"; programmatic default (when omitted) is "silent". */
  logLevel?: "silent" | "warn" | "info" | "debug";
  chaos?: ChaosConfig;
  /** Enable Prometheus-compatible /metrics endpoint. */
  metrics?: boolean;
  /** Strict mode: return 503 instead of 404 when no fixture matches. */
  strict?: boolean;
  /** Record-and-replay: proxy unmatched requests to upstream and save fixtures. */
  record?: RecordConfig;
  /**
   * Maximum number of request/response entries to retain in the in-memory
   * journal. Oldest entries are dropped FIFO when the cap is exceeded.
   * Set to 0 (or omit) for unbounded retention. Negative values are
   * rejected at the CLI parse layer; programmatically they are treated
   * as 0 (unbounded) for back-compat.
   *
   * Default: 1000 (applied by `createServer` when omitted). The CLI passes
   * through its own default. Short-lived test harnesses that want every
   * request recorded can opt in to unbounded retention by passing 0.
   */
  journalMaxEntries?: number;
  /**
   * Maximum number of unique testIds retained in the journal's fixture
   * match-count map. Oldest testIds are dropped FIFO when the cap is
   * exceeded. Set to 0 (or omit) for unbounded retention. Negative values
   * are rejected at the CLI parse layer; programmatically they are treated
   * as 0 (unbounded) for back-compat.
   *
   * Default: 500 (applied by `createServer` when omitted). Without a cap
   * this map can grow over time in long-running servers that see many
   * unique testIds.
   */
  fixtureCountsMaxTestIds?: number;
  /**
   * Normalize requests before matching and recording. Useful for stripping
   * dynamic data (timestamps, UUIDs, session IDs) that would cause fixture
   * mismatches on replay.
   *
   * When set, string matching for `userMessage` and `inputText` uses exact
   * equality (`===`) instead of substring (`includes`) to prevent false
   * positives from shortened keys.
   */
  requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest;
  /**
   * Configure fal.ai queue polling progression. By default a job completes
   * on submit (preserves the legacy `COMPLETED`-on-submit shape). Opt into a
   * realistic `IN_QUEUE → IN_PROGRESS → COMPLETED` progression by setting
   * positive poll thresholds — useful for exercising client code that polls
   * `/status` and reacts to intermediate states.
   *
   * Applies to the general fal handler (`x-fal-target-host`-routed); the
   * legacy `/fal/queue/...` audio handler is unaffected.
   */
  falQueue?: FalQueueConfig;
  /**
   * Configure OpenRouter async video job polling progression
   * (`pending → in_progress → completed | failed` on `GET /api/v1/videos/{id}`).
   * Same threshold semantics as `falQueue`. By default (0/0) the job is
   * seeded terminal at submit — content is downloadable with zero polls, and
   * the first status poll merely reports the already-terminal status.
   */
  openRouterVideo?: FalQueueConfig;
  /**
   * Configure Google Veo async video job polling progression
   * (`done:false → done:true` on `GET /v1beta/operations/{name}`). Same
   * threshold semantics as `openRouterVideo`; the internal
   * `pending → in_progress → completed | failed` model is serialized to the
   * two-state Veo wire.
   */
  veoVideo?: FalQueueConfig;
  /**
   * Configure xAI Grok Imagine async video job polling progression
   * (`pending → done | failed` on `GET /v1/videos/{request_id}`). Same
   * threshold semantics as `openRouterVideo`; progress is synthesized from the
   * poll count.
   */
  grokVideo?: FalQueueConfig;
}

/**
 * Poll-progression thresholds, documented below in fal queue terms; when used
 * as `openRouterVideo` the states map to `pending` / `in_progress` /
 * `completed | failed`.
 */
export interface FalQueueConfig {
  /**
   * Status polls before transitioning `IN_QUEUE → IN_PROGRESS`. Unset and an
   * explicit `0` differ: when BOTH fields are unset the job completes
   * synchronously on submit (no IN_QUEUE / IN_PROGRESS polls emitted), but
   * explicitly setting this field — even to `0` — enables progression when
   * `pollsBeforeCompleted` is unset, with `pollsBeforeCompleted` defaulting
   * to `pollsBeforeInProgress + 1` so the job passes through IN_PROGRESS
   * (an explicit `pollsBeforeCompleted: 0` completes on submit only when
   * `pollsBeforeInProgress` is `0` or unset — otherwise the clamp below
   * lifts it to `pollsBeforeInProgress`).
   */
  pollsBeforeInProgress?: number;
  /**
   * Status polls before transitioning to `COMPLETED`. Default: 0 when
   * `pollsBeforeInProgress` is also unset (no progression), otherwise
   * `pollsBeforeInProgress + 1` so the job spends one poll in IN_PROGRESS.
   * An explicit value lower than `pollsBeforeInProgress` is clamped up so
   * IN_PROGRESS is never skipped. When equal to a nonzero
   * `pollsBeforeInProgress` — or when `pollsBeforeInProgress` is unset or 0
   * and this field is 1 (the IN_PROGRESS branch consumes the first poll) —
   * the job still spends one poll in IN_PROGRESS, so the terminal status
   * lands one poll later than configured.
   */
  pollsBeforeCompleted?: number;
}

// Handler defaults — the common shape passed from server.ts to every handler

export interface HandlerDefaults {
  latency: number;
  chunkSize: number;
  replaySpeed: number;
  logger: Logger;
  chaos?: ChaosConfig;
  registry?: MetricsRegistry;
  record?: RecordConfig;
  strict?: boolean;
  requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest;
  falQueue?: FalQueueConfig;
  openRouterVideo?: FalQueueConfig;
  veoVideo?: FalQueueConfig;
  grokVideo?: FalQueueConfig;
}
