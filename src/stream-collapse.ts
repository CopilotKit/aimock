/**
 * Stream collapsing functions for record-and-replay.
 *
 * Each function takes a raw streaming response body (SSE, NDJSON, or binary
 * EventStream) and collapses it into a non-streaming fixture response
 * containing `{ content }`, `{ toolCalls }`, or both when the stream includes
 * text followed by tool calls.
 */

import { crc32 } from "node:zlib";
import type { RecordProviderKey, ToolCall } from "./types.js";
import type { Logger } from "./logger.js";
import { isHarmonyContent, parseHarmonyContent } from "./harmony.js";

// ---------------------------------------------------------------------------
// Result type shared by all collapse functions
// ---------------------------------------------------------------------------

export interface CollapseResult {
  content?: string;
  reasoning?: string;
  /**
   * The real cryptographic `signature` value captured from an Anthropic
   * `signature_delta`. Carried so a recorded real-provider thinking turn can
   * replay its ACTUAL signature instead of aimock's placeholder. Absent when the
   * stream carried no signature. Single-signature assumption: a turn with
   * MULTIPLE thinking blocks collapses to one merged `reasoning` string carrying
   * only the FINAL block's signature (last-signature-wins) — per-block fidelity
   * is not preserved.
   */
  reasoningSignature?: string;
  /**
   * The opaque `data` payload(s) of any Anthropic `redacted_thinking` blocks, in
   * stream order. Captured so a recorded redacted-thinking turn round-trips its
   * encrypted reasoning faithfully. Absent when none present.
   */
  redactedThinking?: string[];
  webSearches?: string[];
  toolCalls?: ToolCall[];
  droppedChunks?: number;
  firstDroppedSample?: string;
  truncated?: boolean;
  audioB64?: string;
  audioMimeType?: string;
  /**
   * Set when harmony channel tokens were present in the accumulated content but
   * could NOT be parsed into a complete, valid harmony structure. The content
   * is preserved VERBATIM, so this is NOT transport loss — it is distinct from
   * `droppedChunks` / `truncated`, which are reserved for genuine transport loss
   * (malformed SSE/NDJSON frames, CRC mismatch). The caller surfaces this as a
   * dedicated warning rather than a dropped/truncated-chunk warning.
   */
  harmonyUnparsed?: true;
  /** Short human-readable note accompanying {@link harmonyUnparsed}. */
  harmonyNote?: string;
}

/**
 * Slice the first `max` UTF-16 code units of `s` for a diagnostic sample,
 * trimming a trailing lone high-surrogate so the resulting sample never ends on
 * a lone high surrogate (i.e. never mid-surrogate-pair).
 */
function surrogateSafeSlice(s: string, max: number): string {
  let out = s.slice(0, max);
  if (out.length > 0) {
    const last = out.charCodeAt(out.length - 1);
    // A high surrogate (U+D800..U+DBFF) at the end is the lead of a split pair.
    if (last >= 0xd800 && last <= 0xdbff) {
      out = out.slice(0, -1);
    }
  }
  return out;
}

/**
 * Split a raw SSE body into per-event blocks.
 *
 * Events are delimited by a blank line. Real HTTP/SSE transports use CRLF
 * (`\r\n`) line endings, so the inter-event delimiter is `\r\n\r\n` (which
 * contains no `\n\n` substring) and each line ends with a trailing `\r`.
 * Splitting on `/\r?\n\r?\n/` handles LF, CRLF, and mixed streams; per-line
 * `\r` trimming happens in {@link splitSSELines}. Blank blocks are dropped.
 */
function splitSSEEvents(body: string): string[] {
  return body.split(/\r?\n\r?\n/).filter((block) => block.trim().length > 0);
}

/**
 * Split a single SSE event block into its lines, trimming a trailing `\r` so
 * CRLF streams parse identically to LF streams.
 */
function splitSSELines(block: string): string[] {
  return block.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Extract the SSE `data` field from a single event block's lines.
 *
 * Per the SSE spec a single event may carry MULTIPLE `data:` lines; the field
 * value is every data line's content joined with "\n". Collecting only the
 * first `data:` line (e.g. via `.find`) corrupts payloads that a server split
 * across lines. Callers MUST pass lines produced by {@link splitSSELines} so
 * any trailing `\r` is already stripped. Returns the joined payload (with the
 * leading "data:" prefix and one optional leading space stripped per line), or
 * `undefined` when the block contains no `data:` line.
 */
function extractSSEData(lines: string[]): string | undefined {
  const dataParts: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    // Strip "data:" then a single optional leading space, per the SSE spec.
    let part = line.slice(5);
    if (part.startsWith(" ")) part = part.slice(1);
    dataParts.push(part);
  }
  if (dataParts.length === 0) return undefined;
  return dataParts.join("\n");
}

// ---------------------------------------------------------------------------
// 1. OpenAI SSE
// ---------------------------------------------------------------------------

/**
 * Collapse OpenAI Chat Completions SSE stream into a single response.
 *
 * Format:
 *   data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"Hello"}}]}\n\n
 *   data: [DONE]\n\n
 */
export function collapseOpenAISSE(body: string): CollapseResult {
  const lines = splitSSEEvents(body);
  let content = "";
  let reasoning = "";
  const webSearchQueries: string[] = [];
  let droppedChunks = 0;
  let firstDroppedSample: string | undefined;
  let harmonyUnparsed = false;
  let harmonyNote: string | undefined;
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
  // Fallback keying for deltas that OMIT `index`. Without this, every
  // index-less delta collapses under one `undefined`/NaN key, merging distinct
  // tool calls and corrupting arguments. Index-less fragments that share an
  // `id` correlate via `idKeyMap`; otherwise each gets a fresh synthetic key
  // assigned from a counter kept above any real index so sort order is stable.
  // The 1_000_000 sentinel assumes real provider tool-call indices stay below
  // it (they are small per-stream counters), so synthetic keys never collide.
  let nextSyntheticIndex = 1_000_000;
  const idKeyMap = new Map<string, number>();

  for (const line of lines) {
    const data = extractSSEData(splitSSELines(line));
    if (data === undefined) continue;

    const payload = data.trim();
    if (payload === "[DONE]") continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch (err) {
      droppedChunks++;
      if (droppedChunks === 1) {
        const msg = err instanceof Error ? err.message : "unknown";
        firstDroppedSample = `parse failed (${msg}): ${surrogateSafeSlice(payload, 200)}`;
      }
      continue;
    }

    // Responses API reasoning events
    if (
      parsed.type === "response.reasoning_summary_text.delta" &&
      typeof parsed.delta === "string"
    ) {
      reasoning += parsed.delta;
      continue;
    }

    // Responses API web search events
    if (parsed.type === "response.output_item.done") {
      const item = parsed.item as Record<string, unknown> | undefined;
      if (item?.type === "web_search_call") {
        const action = item.action as Record<string, unknown> | undefined;
        if (action && typeof action.query === "string") {
          webSearchQueries.push(action.query);
          continue;
        }
      }
    }

    // Responses API text content events
    if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
      content += parsed.delta;
      continue;
    }

    // Skip other Responses API structural events
    if (typeof parsed.type === "string" && parsed.type.startsWith("response.")) {
      continue;
    }

    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) continue;

    const delta = choices[0].delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    // Reasoning content (OpenRouter / chat completions format)
    if (typeof delta.reasoning_content === "string") {
      reasoning += delta.reasoning_content;
    }

    // Text content
    if (typeof delta.content === "string") {
      content += delta.content;
    }

    // Tool calls
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        const rawId = typeof tc.id === "string" ? tc.id : undefined;

        // Resolve a stable map key. Prefer the streamed `index`; when it is
        // absent, correlate by `id` if present, else mint a fresh synthetic
        // key so distinct index-less calls never merge.
        let index: number;
        if (typeof tc.index === "number") {
          index = tc.index;
        } else if (rawId !== undefined) {
          const existing = idKeyMap.get(rawId);
          if (existing !== undefined) {
            index = existing;
          } else {
            index = nextSyntheticIndex++;
            idKeyMap.set(rawId, index);
          }
        } else {
          index = nextSyntheticIndex++;
        }

        if (!toolCallMap.has(index)) {
          toolCallMap.set(index, {
            id: rawId ?? "",
            name: (fn?.name as string) ?? "",
            arguments: "",
          });
        }

        const entry = toolCallMap.get(index)!;
        if (fn?.name && typeof fn.name === "string" && !entry.name) {
          entry.name = fn.name;
        }
        if (tc.id && typeof tc.id === "string" && !entry.id) {
          entry.id = tc.id;
        }
        if (fn?.arguments && typeof fn.arguments === "string") {
          entry.arguments += fn.arguments;
        }
      }
    }
  }

  // Open-weight gpt-oss models (Ollama / vLLM / OpenRouter) stream tool calls
  // as raw harmony channel tokens inside delta.content rather than structured
  // delta.tool_calls. Harmony parsing is FALLBACK-ONLY: attempt it ONLY when
  // there are NO structured delta.tool_calls. If structured tool calls exist,
  // any harmony-looking content is prose — never merged (no phantom tool call),
  // never stamped as truncated/dropped. When harmony IS the only source, a
  // successful parse routes channels (content/reasoning/toolCalls); a failure
  // preserves content VERBATIM and surfaces the distinct `harmonyUnparsed`
  // signal (NOT droppedChunks/truncated — the bytes are not lost).
  const harmonyToolCalls: ToolCall[] = [];
  if (toolCallMap.size === 0 && isHarmonyContent(content)) {
    const parsed = parseHarmonyContent(content);
    if (parsed.failed) {
      harmonyUnparsed = true;
      harmonyNote = `harmony tokens present but unparseable; content preserved verbatim: ${surrogateSafeSlice(content, 200)}`;
    } else {
      content = parsed.content;
      if (parsed.reasoning) {
        reasoning += parsed.reasoning;
      }
      harmonyToolCalls.push(...parsed.toolCalls);
    }
  }

  if (toolCallMap.size > 0 || harmonyToolCalls.length > 0) {
    const sorted = Array.from(toolCallMap.entries()).sort(([a], [b]) => a - b);
    return {
      ...(content ? { content } : {}),
      // Fallback-only: harmonyToolCalls are populated ONLY in the
      // no-structured-calls branch, so this is never a merge of both sources.
      toolCalls: [
        ...sorted.map(([, tc]) => ({
          name: tc.name,
          arguments: tc.arguments,
          ...(tc.id ? { id: tc.id } : {}),
        })),
        ...harmonyToolCalls,
      ],
      // Reasoning is preserved alongside tool calls for ALL structured streams
      // (DeepSeek/OpenRouter reasoning_content, harmony analysis channel), at
      // parity with every other collapser and the non-streaming path.
      ...(reasoning ? { reasoning } : {}),
      // webSearches parity with the text-only return branch.
      ...(webSearchQueries.length > 0 ? { webSearches: webSearchQueries } : {}),
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
      ...(firstDroppedSample ? { firstDroppedSample } : {}),
      ...(harmonyUnparsed ? { harmonyUnparsed: true } : {}),
      ...(harmonyNote ? { harmonyNote } : {}),
    };
  }

  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(webSearchQueries.length > 0 ? { webSearches: webSearchQueries } : {}),
    ...(droppedChunks > 0 ? { droppedChunks } : {}),
    ...(firstDroppedSample ? { firstDroppedSample } : {}),
    ...(harmonyUnparsed ? { harmonyUnparsed: true } : {}),
    ...(harmonyNote ? { harmonyNote } : {}),
  };
}

// ---------------------------------------------------------------------------
// 2. Anthropic SSE
// ---------------------------------------------------------------------------

/**
 * Collapse Anthropic Claude Messages SSE stream into a single response.
 *
 * Format:
 *   event: message_start\ndata: {...}\n\n
 *   event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hello"}}\n\n
 */
export function collapseAnthropicSSE(body: string): CollapseResult {
  const blocks = splitSSEEvents(body);
  let content = "";
  let reasoning = "";
  // Real cryptographic signature captured from a `signature_delta`; stays
  // undefined when the stream carried none (e.g. aimock's own placeholder turns
  // or non-thinking turns). Carried so a recorded real-provider thinking turn
  // can replay its ACTUAL signature instead of aimock's placeholder.
  let reasoningSignature: string | undefined;
  // Opaque `data` payloads of any `redacted_thinking` content blocks, in stream
  // order. Stays empty when none present. Carried so a recorded redacted-thinking
  // turn round-trips its encrypted reasoning faithfully on replay.
  const redactedThinking: string[] = [];
  let droppedChunks = 0;
  let firstDroppedSample: string | undefined;
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
  // Fallback keying for content blocks that OMIT `index` (mirrors the OpenAI /
  // Cohere / Bedrock guards). Without it, every index-less block collapses
  // under one `undefined` key, merging distinct tool_use blocks. Index-less
  // starts mint a fresh synthetic key (kept above any real index so sort order
  // is stable). Despite its name, `lastSyntheticIndex` tracks whichever
  // tool_use start most recently opened REGARDLESS of whether its index was
  // real or synthetic (it is set on every tool_use start; thinking /
  // redacted_thinking starts do not touch it), so an index-less delta
  // correlates to the most-recent tool_use start — not just to the last
  // synthetic one. The 1_000_000 sentinel assumes real provider indices stay
  // below it.
  let nextSyntheticIndex = 1_000_000;
  let lastSyntheticIndex: number | undefined;

  for (const block of blocks) {
    const lines = splitSSELines(block);
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const data = extractSSEData(lines);
    if (data === undefined) continue;

    const eventType = eventLine ? eventLine.slice(6).trim() : "";
    const payload = data.trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch (err) {
      droppedChunks++;
      if (droppedChunks === 1) {
        const msg = err instanceof Error ? err.message : "unknown";
        firstDroppedSample = `parse failed (${msg}): ${surrogateSafeSlice(payload, 200)}`;
      }
      continue;
    }

    if (eventType === "content_block_start") {
      const contentBlock = parsed.content_block as Record<string, unknown> | undefined;
      // A `redacted_thinking` block carries its encrypted reasoning in an opaque
      // `data` string on the start event (no deltas follow). Capture it so the
      // recorded turn can replay the redacted block faithfully. Require NON-EMPTY
      // data: the replay-side validator rejects a leading empty-data
      // redacted_thinking block, so recording `data: ""` would yield a fixture
      // that 400s under strict replay. Drop empty entries to keep capture and
      // validation in agreement.
      if (
        contentBlock?.type === "redacted_thinking" &&
        typeof contentBlock.data === "string" &&
        contentBlock.data.length > 0
      ) {
        redactedThinking.push(contentBlock.data);
      }
      if (contentBlock?.type === "tool_use") {
        // Prefer the streamed `index`; when absent, mint a fresh synthetic key
        // so distinct index-less tool_use blocks never merge.
        let index: number;
        if (typeof parsed.index === "number") {
          index = parsed.index;
        } else {
          index = nextSyntheticIndex++;
        }
        lastSyntheticIndex = index;
        toolCallMap.set(index, {
          id: (contentBlock.id as string) ?? "",
          name: (contentBlock.name as string) ?? "",
          arguments: "",
        });
      }
    }

    if (eventType === "content_block_delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      if (delta.type === "text_delta" && typeof delta.text === "string") {
        content += delta.text;
      }

      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        reasoning += delta.thinking;
      }

      // The real cryptographic signature arrives via a trailing
      // `signature_delta` (the `content_block_start` carried ""). Capture the
      // last one seen so a recorded thinking turn replays its actual signature.
      // Last-signature-wins: a turn with MULTIPLE thinking blocks overwrites this
      // on each block, so the merged `reasoning` string ends up bound only to the
      // FINAL block's signature — per-block signatures are not preserved.
      if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        reasoningSignature = delta.signature;
      }

      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        // Use the streamed `index` when present; otherwise correlate to the
        // most recent tool_use start (mirrors the start-side fallback).
        const index = typeof parsed.index === "number" ? parsed.index : lastSyntheticIndex;
        // A delta that cannot correlate to any known start (no streamed index
        // AND no prior start, or a stale index with no entry) would otherwise
        // silently lose its args. Account for it as a dropped chunk instead of
        // vanishing (mirrors the Cohere uncorrelated-delta path).
        const entry = index !== undefined ? toolCallMap.get(index) : undefined;
        if (entry) {
          entry.arguments += delta.partial_json;
        } else {
          droppedChunks++;
          if (droppedChunks === 1) {
            firstDroppedSample = `input_json_delta with no correlating tool_use start: ${surrogateSafeSlice(
              payload,
              200,
            )}`;
          }
        }
      }
    }
  }

  if (toolCallMap.size > 0) {
    const sorted = Array.from(toolCallMap.entries()).sort(([a], [b]) => a - b);
    return {
      ...(content ? { content } : {}),
      toolCalls: sorted.map(([, tc]) => ({
        name: tc.name,
        arguments: tc.arguments,
        ...(tc.id ? { id: tc.id } : {}),
      })),
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningSignature ? { reasoningSignature } : {}),
      ...(redactedThinking.length > 0 ? { redactedThinking } : {}),
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
      ...(firstDroppedSample ? { firstDroppedSample } : {}),
    };
  }

  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningSignature ? { reasoningSignature } : {}),
    ...(redactedThinking.length > 0 ? { redactedThinking } : {}),
    ...(droppedChunks > 0 ? { droppedChunks } : {}),
    ...(firstDroppedSample ? { firstDroppedSample } : {}),
  };
}

// ---------------------------------------------------------------------------
// 3. Gemini SSE
// ---------------------------------------------------------------------------

/**
 * Collapse Gemini SSE stream into a single response.
 *
 * Format (data-only, no event prefix, no [DONE]):
 *   data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n
 */
export function collapseGeminiSSE(body: string): CollapseResult {
  const lines = splitSSEEvents(body);
  let content = "";
  let reasoning = "";
  let droppedChunks = 0;
  let firstDroppedSample: string | undefined;
  let audioB64 = "";
  let audioMimeType: string | undefined;
  const toolCalls: ToolCall[] = [];

  for (const line of lines) {
    const data = extractSSEData(splitSSELines(line));
    if (data === undefined) continue;

    const payload = data.trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch (err) {
      droppedChunks++;
      if (droppedChunks === 1) {
        const msg = err instanceof Error ? err.message : "unknown";
        firstDroppedSample = `parse failed (${msg}): ${surrogateSafeSlice(payload, 200)}`;
      }
      continue;
    }

    const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
    if (!candidates || candidates.length === 0) continue;

    const candidateContent = candidates[0].content as Record<string, unknown> | undefined;
    if (!candidateContent) continue;

    const parts = candidateContent.parts as Array<Record<string, unknown>> | undefined;
    if (!parts || parts.length === 0) continue;

    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        toolCalls.push({
          name: String(fc.name ?? ""),
          // Default undefined/object args to a JSON object string (matches
          // collapseGeminiInteractionsSSE / Ollama). JSON.stringify(undefined)
          // would otherwise yield the VALUE undefined, violating the
          // ToolCall.arguments:string contract.
          arguments:
            typeof fc.args === "string" ? (fc.args as string) : JSON.stringify(fc.args ?? {}),
        });
      } else if (
        part.inlineData &&
        typeof (part.inlineData as Record<string, unknown>).mimeType === "string" &&
        ((part.inlineData as Record<string, unknown>).mimeType as string).startsWith("audio/")
      ) {
        const inlineData = part.inlineData as Record<string, unknown>;
        if (!audioMimeType) {
          audioMimeType = inlineData.mimeType as string;
        }
        if (typeof inlineData.data === "string") {
          audioB64 += inlineData.data;
        }
      } else if (typeof part.text === "string") {
        if (part.thought) {
          reasoning += part.text;
        } else {
          content += part.text;
        }
      }
    }
  }

  if (audioB64) {
    // Preserve any content / reasoning / tool calls accumulated in the same
    // stream — a Gemini turn can interleave audio with text and functionCall
    // parts, and the early return must not silently drop them.
    return {
      audioB64,
      audioMimeType,
      ...(content ? { content } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
      ...(firstDroppedSample ? { firstDroppedSample } : {}),
    };
  }

  if (toolCalls.length > 0) {
    return {
      ...(content ? { content } : {}),
      toolCalls,
      ...(reasoning ? { reasoning } : {}),
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
      ...(firstDroppedSample ? { firstDroppedSample } : {}),
    };
  }

  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(droppedChunks > 0 ? { droppedChunks } : {}),
    ...(firstDroppedSample ? { firstDroppedSample } : {}),
  };
}

// ---------------------------------------------------------------------------
// 4. Ollama NDJSON
// ---------------------------------------------------------------------------

/**
 * Collapse Ollama NDJSON stream into a single response.
 *
 * /api/chat format:
 *   {"model":"llama3","message":{"role":"assistant","content":"Hello"},"done":false}\n
 *
 * /api/generate format:
 *   {"model":"llama3","response":"Hello","done":false}\n
 *
 * Open-weight gpt-oss served via Ollama streams harmony channel tokens inside
 * `message.content` (just like the OpenAI SSE path), so after accumulation the
 * content is run through the same fail-safe {@link parseHarmonyContent} gate to
 * capture structured tool calls / reasoning instead of leaking raw tokens.
 */
export function collapseOllamaNDJSON(body: string): CollapseResult {
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  let content = "";
  let reasoning = "";
  let droppedChunks = 0;
  let firstDroppedSample: string | undefined;
  let harmonyUnparsed = false;
  let harmonyNote: string | undefined;
  const toolCalls: ToolCall[] = [];

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    } catch (err) {
      droppedChunks++;
      if (droppedChunks === 1) {
        const msg = err instanceof Error ? err.message : "unknown";
        firstDroppedSample = `parse failed (${msg}): ${surrogateSafeSlice(line.trim(), 200)}`;
      }
      continue;
    }

    // /api/chat format
    const message = parsed.message as Record<string, unknown> | undefined;
    if (message) {
      if (typeof message.content === "string") {
        content += message.content;
      }

      // Tool calls
      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn) {
            toolCalls.push({
              name: String(fn.name ?? ""),
              // Default undefined/object args to a JSON object (matching
              // collapseGeminiInteractionsSSE) — JSON.stringify(undefined)
              // would otherwise yield the literal string "undefined".
              arguments:
                typeof fn.arguments === "string"
                  ? fn.arguments
                  : JSON.stringify(fn.arguments ?? {}),
            });
          }
        }
      }
    }

    // /api/generate format
    else if (typeof parsed.response === "string") {
      content += parsed.response;
    }
  }

  // Open-weight gpt-oss served via Ollama streams harmony channel tokens inside
  // message.content (same as the OpenAI SSE path). Harmony parsing is
  // FALLBACK-ONLY: attempt it ONLY when there are NO structured message
  // tool_calls. If structured tool calls exist, harmony-looking content is
  // prose — never merged (no phantom), never stamped truncated/dropped. On a
  // harmony failure the content is preserved VERBATIM and surfaced via the
  // distinct `harmonyUnparsed` signal (NOT droppedChunks/truncated).
  if (toolCalls.length === 0 && isHarmonyContent(content)) {
    const parsedHarmony = parseHarmonyContent(content);
    if (parsedHarmony.failed) {
      harmonyUnparsed = true;
      harmonyNote = `harmony tokens present but unparseable; content preserved verbatim: ${surrogateSafeSlice(content, 200)}`;
    } else {
      content = parsedHarmony.content;
      if (parsedHarmony.reasoning) {
        reasoning += parsedHarmony.reasoning;
      }
      toolCalls.push(...parsedHarmony.toolCalls);
    }
  }

  if (toolCalls.length > 0) {
    return {
      ...(content ? { content } : {}),
      toolCalls,
      ...(reasoning ? { reasoning } : {}),
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
      ...(firstDroppedSample ? { firstDroppedSample } : {}),
      ...(harmonyUnparsed ? { harmonyUnparsed: true } : {}),
      ...(harmonyNote ? { harmonyNote } : {}),
    };
  }

  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(droppedChunks > 0 ? { droppedChunks } : {}),
    ...(firstDroppedSample ? { firstDroppedSample } : {}),
    ...(harmonyUnparsed ? { harmonyUnparsed: true } : {}),
    ...(harmonyNote ? { harmonyNote } : {}),
  };
}

// ---------------------------------------------------------------------------
// 5. Cohere SSE
// ---------------------------------------------------------------------------

/**
 * Collapse Cohere SSE stream into a single response.
 *
 * Format:
 *   event: content-delta\ndata: {"type":"content-delta","delta":{"message":{"content":{"text":"Hello"}}}}\n\n
 */
export function collapseCohereSSE(body: string): CollapseResult {
  const blocks = splitSSEEvents(body);
  let content = "";
  // Reasoning text assembled from `thinking` content-delta blocks. Cohere's
  // reasoning models stream a `content.type === "thinking"` block carrying a
  // `thinking` string before the `text` block; capture it so a recorded
  // reasoning turn round-trips its reasoning instead of dropping it.
  let reasoning = "";
  let droppedChunks = 0;
  let firstDroppedSample: string | undefined;
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
  // Fallback keying for tool-call events that OMIT `index` (mirrors the
  // OpenAI guard). Without it, every index-less tool-call-start collapses
  // under one `undefined`/NaN key, merging distinct calls. Index-less starts
  // mint a fresh synthetic key. `lastStartKey` tracks the most-recent
  // tool-call-start key REGARDLESS of whether it was real or synthetic, so an
  // index-less tool-call-delta correlates to whichever start most recently
  // opened — not just to the last synthetic one. The 1_000_000 sentinel
  // assumes real provider indices stay below it.
  let nextSyntheticIndex = 1_000_000;
  let lastStartKey: number | undefined;

  for (const block of blocks) {
    const lines = splitSSELines(block);
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const data = extractSSEData(lines);
    if (data === undefined) continue;

    const eventType = eventLine ? eventLine.slice(6).trim() : "";
    const payload = data.trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch (err) {
      droppedChunks++;
      if (droppedChunks === 1) {
        const msg = err instanceof Error ? err.message : "unknown";
        firstDroppedSample = `parse failed (${msg}): ${surrogateSafeSlice(payload, 200)}`;
      }
      continue;
    }

    if (eventType === "content-delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      const message = delta?.message as Record<string, unknown> | undefined;
      const contentObj = message?.content as Record<string, unknown> | undefined;
      if (contentObj && contentObj.type === "thinking" && typeof contentObj.thinking === "string") {
        reasoning += contentObj.thinking;
      } else if (contentObj && typeof contentObj.text === "string") {
        content += contentObj.text;
      }
    }

    if (eventType === "tool-call-start") {
      let index: number;
      if (typeof parsed.index === "number") {
        index = parsed.index;
      } else {
        index = nextSyntheticIndex++;
      }
      // Track the most-recent start key (real OR synthetic) so a following
      // index-less delta correlates to whichever call just opened.
      lastStartKey = index;
      const delta = parsed.delta as Record<string, unknown> | undefined;
      const message = delta?.message as Record<string, unknown> | undefined;
      const toolCalls = message?.tool_calls as Record<string, unknown> | undefined;
      if (toolCalls) {
        const fn = toolCalls.function as Record<string, unknown> | undefined;
        toolCallMap.set(index, {
          id: (toolCalls.id as string) ?? "",
          name: (fn?.name as string) ?? "",
          arguments: "",
        });
      }
    }

    if (eventType === "tool-call-delta") {
      // Use the streamed `index` when present; otherwise correlate to the most
      // recent tool-call-start (real or synthetic key).
      const index = typeof parsed.index === "number" ? parsed.index : lastStartKey;
      const delta = parsed.delta as Record<string, unknown> | undefined;
      const message = delta?.message as Record<string, unknown> | undefined;
      const toolCalls = message?.tool_calls as Record<string, unknown> | undefined;
      if (toolCalls) {
        const fn = toolCalls.function as Record<string, unknown> | undefined;
        if (fn && typeof fn.arguments === "string") {
          // A delta that cannot correlate to any known start (no streamed
          // index AND no prior start) would otherwise silently lose its args.
          // Account for it as a dropped chunk instead of vanishing.
          const entry = index !== undefined ? toolCallMap.get(index) : undefined;
          if (entry) {
            entry.arguments += fn.arguments;
          } else {
            droppedChunks++;
            if (droppedChunks === 1) {
              firstDroppedSample = `tool-call-delta with no correlating start: ${surrogateSafeSlice(
                payload,
                200,
              )}`;
            }
          }
        }
      }
    }
  }

  if (toolCallMap.size > 0) {
    const sorted = Array.from(toolCallMap.entries()).sort(([a], [b]) => a - b);
    return {
      ...(content ? { content } : {}),
      toolCalls: sorted.map(([, tc]) => ({
        name: tc.name,
        arguments: tc.arguments,
        ...(tc.id ? { id: tc.id } : {}),
      })),
      ...(reasoning ? { reasoning } : {}),
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
      ...(firstDroppedSample ? { firstDroppedSample } : {}),
    };
  }

  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(droppedChunks > 0 ? { droppedChunks } : {}),
    ...(firstDroppedSample ? { firstDroppedSample } : {}),
  };
}

// ---------------------------------------------------------------------------
// 6. Bedrock EventStream (binary)
// ---------------------------------------------------------------------------

/**
 * Decode AWS Event Stream binary frames and extract JSON payloads.
 *
 * Binary frame layout:
 *   [total_length: 4B uint32-BE]
 *   [headers_length: 4B uint32-BE]
 *   [prelude_crc32: 4B]
 *   [headers: variable]
 *   [payload: variable]
 *   [message_crc32: 4B]
 */
function decodeEventStreamFrames(buf: Buffer): {
  frames: Array<{ headers: Record<string, string>; payload: Buffer }>;
  truncated: boolean;
} {
  const frames: Array<{ headers: Record<string, string>; payload: Buffer }> = [];
  let offset = 0;

  while (offset < buf.length) {
    if (offset + 12 > buf.length) break;

    const totalLength = buf.readUInt32BE(offset);
    const headersLength = buf.readUInt32BE(offset + 4);

    // Validate bounds: ensure the full frame is within the buffer
    if (totalLength < 12 || offset + totalLength > buf.length) {
      return { frames, truncated: true };
    }

    // Validate prelude CRC
    const preludeCrc = buf.readUInt32BE(offset + 8);
    const computedPreludeCrc = crc32(buf.subarray(offset, offset + 8));
    if (preludeCrc >>> 0 !== computedPreludeCrc >>> 0) {
      return { frames, truncated: true }; // Prelude CRC mismatch — stop parsing
    }

    // Parse headers
    const headersStart = offset + 12;
    const headersEnd = headersStart + headersLength;
    const payloadEnd = offset + totalLength - 4; // minus message CRC

    // Validate the headers region fits inside the frame. A frame can carry a
    // valid prelude CRC yet declare a `headersLength` that overruns the payload
    // region (the prelude CRC only covers total/headers length, not the body).
    // Without this guard a per-header read walks off the buffer and throws an
    // uncaught RangeError; treat it as truncation instead.
    if (headersEnd > payloadEnd || headersEnd > buf.length) {
      return { frames, truncated: true };
    }

    const headers: Record<string, string> = {};
    let hOffset = headersStart;
    let headerOverrun = false;

    while (hOffset < headersEnd) {
      // Each read must stay within the declared headers region. Bail out
      // (truncated) on any overrun rather than reading past the boundary.
      if (hOffset + 1 > headersEnd) {
        headerOverrun = true;
        break;
      }
      const nameLen = buf.readUInt8(hOffset);
      hOffset += 1;
      if (hOffset + nameLen + 1 + 2 > headersEnd) {
        headerOverrun = true;
        break;
      }
      const name = buf.subarray(hOffset, hOffset + nameLen).toString("utf8");
      hOffset += nameLen;
      // Skip header type byte (type 7 = STRING)
      hOffset += 1;
      const valueLen = buf.readUInt16BE(hOffset);
      hOffset += 2;
      if (hOffset + valueLen > headersEnd) {
        headerOverrun = true;
        break;
      }
      const value = buf.subarray(hOffset, hOffset + valueLen).toString("utf8");
      hOffset += valueLen;
      headers[name] = value;
    }

    if (headerOverrun) {
      return { frames, truncated: true };
    }

    // Extract payload
    const payloadStart = headersEnd;
    const payload = buf.subarray(payloadStart, payloadEnd);

    // Validate message CRC (covers entire frame minus last 4 bytes)
    const messageCrc = buf.readUInt32BE(offset + totalLength - 4);
    const computedMessageCrc = crc32(buf.subarray(offset, offset + totalLength - 4));
    if (messageCrc >>> 0 !== computedMessageCrc >>> 0) {
      return { frames, truncated: true }; // Message CRC mismatch — stop parsing
    }

    frames.push({ headers, payload });
    offset += totalLength;
  }

  return { frames, truncated: false };
}

/**
 * Collapse Bedrock binary Event Stream into a single response.
 *
 * Each frame contains a JSON payload with event types like:
 *   contentBlockDelta, contentBlockStart, etc.
 */
export function collapseBedrockEventStream(body: Buffer): CollapseResult {
  const { frames, truncated } = decodeEventStreamFrames(body);
  let content = "";
  // Reasoning text assembled from Converse `reasoningContent.text` deltas. The
  // Bedrock Converse stream interleaves a `delta.reasoningContent` block carrying
  // the model's reasoning; capture it so a recorded reasoning turn round-trips
  // its reasoning instead of dropping it.
  let reasoning = "";
  // Anthropic-native extended-thinking fields (invoke-with-response-stream).
  // The native binary branch carries the same thinking/signature/redacted
  // channel as the Anthropic SSE collapser; mirror its capture rules so a
  // recorded reasoning turn round-trips instead of silently dropping it.
  let reasoningSignature: string | undefined;
  const redactedThinking: string[] = [];
  let droppedChunks = 0;
  let firstDroppedSample: string | undefined;
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

  for (const frame of frames) {
    const frameStr = frame.payload.toString("utf8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frameStr) as Record<string, unknown>;
    } catch (err) {
      droppedChunks++;
      if (droppedChunks === 1) {
        const msg = err instanceof Error ? err.message : "unknown";
        firstDroppedSample = `parse failed (${msg}): ${surrogateSafeSlice(frameStr, 200)}`;
      }
      continue;
    }

    // Anthropic Messages format (invoke-with-response-stream): flat payload with "type" field
    if (parsed.type === "content_block_delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        content += delta.text;
      }
      if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        reasoning += delta.thinking;
      }
      // Last-signature-wins: a turn with MULTIPLE thinking blocks overwrites
      // this on each block, so the merged `reasoning` ends up bound only to the
      // FINAL block's signature (mirrors collapseAnthropicSSE).
      if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
        reasoningSignature = delta.signature;
      }
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const index = parsed.index as number | undefined;
        // An arg delta that cannot correlate to a known tool_use start would
        // otherwise silently lose its args. Account for it as a dropped chunk
        // instead of vanishing (mirrors the Cohere uncorrelated-delta path).
        const entry = index !== undefined ? toolCallMap.get(index) : undefined;
        if (entry) {
          entry.arguments += delta.partial_json;
        } else {
          droppedChunks++;
          if (droppedChunks === 1) {
            firstDroppedSample = `input_json_delta with no correlating tool_use start: ${surrogateSafeSlice(
              frameStr,
              200,
            )}`;
          }
        }
      }
      continue;
    }
    if (parsed.type === "content_block_start") {
      const block = parsed.content_block as Record<string, unknown> | undefined;
      const index = parsed.index as number | undefined;
      // A `redacted_thinking` block carries its encrypted reasoning in an
      // opaque `data` string on the start event (no deltas follow). Capture it
      // (non-empty only — the validator rejects empty data) so the recorded
      // turn replays the redacted block faithfully (mirrors collapseAnthropicSSE).
      if (block?.type === "redacted_thinking" && typeof block.data === "string" && block.data) {
        redactedThinking.push(block.data);
      }
      if (block?.type === "tool_use" && index !== undefined) {
        toolCallMap.set(index, {
          id: (block.id as string) ?? "",
          name: (block.name as string) ?? "",
          arguments: "",
        });
      }
      continue;
    }

    // Converse format (converse-stream): camelCase wrapper keys
    // contentBlockStart — may initiate a tool_use block
    if (parsed.contentBlockStart) {
      const blockStart = parsed.contentBlockStart as Record<string, unknown>;
      const index = (parsed.contentBlockIndex ?? blockStart.contentBlockIndex) as
        | number
        | undefined;
      const start = blockStart.start as Record<string, unknown> | undefined;
      if (start?.toolUse && index !== undefined) {
        const toolUse = start.toolUse as Record<string, unknown>;
        toolCallMap.set(index, {
          id: (toolUse.toolUseId as string) ?? "",
          name: (toolUse.name as string) ?? "",
          arguments: "",
        });
      }
    }

    // contentBlockDelta
    if (parsed.contentBlockDelta) {
      const blockDelta = parsed.contentBlockDelta as Record<string, unknown>;
      const index = (parsed.contentBlockIndex ?? blockDelta.contentBlockIndex) as
        | number
        | undefined;
      const delta = blockDelta.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      // Text delta
      if (typeof delta.text === "string") {
        content += delta.text;
      }

      // Reasoning delta — Converse carries reasoning in `reasoningContent.text`.
      if (typeof delta.reasoningContent === "object" && delta.reasoningContent !== null) {
        const reasoningDelta = delta.reasoningContent as Record<string, unknown>;
        if (typeof reasoningDelta.text === "string") {
          reasoning += reasoningDelta.text;
        }
      }

      // Tool use input JSON delta
      if (typeof delta.toolUse === "object" && delta.toolUse !== null) {
        const toolUseDelta = delta.toolUse as Record<string, unknown>;
        if (typeof toolUseDelta.input === "string") {
          // An arg delta that cannot correlate to a known tool_use start would
          // otherwise silently lose its args. Account for it as a dropped chunk
          // instead of vanishing (mirrors the Cohere uncorrelated-delta path).
          const entry = index !== undefined ? toolCallMap.get(index) : undefined;
          if (entry) {
            entry.arguments += toolUseDelta.input;
          } else {
            droppedChunks++;
            if (droppedChunks === 1) {
              firstDroppedSample = `toolUse.input delta with no correlating tool_use start: ${surrogateSafeSlice(
                frameStr,
                200,
              )}`;
            }
          }
        }
      }
    }
  }

  if (toolCallMap.size > 0) {
    const sorted = Array.from(toolCallMap.entries()).sort(([a], [b]) => a - b);
    return {
      toolCalls: sorted.map(([, tc]) => ({
        name: tc.name,
        arguments: tc.arguments,
        ...(tc.id ? { id: tc.id } : {}),
      })),
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningSignature ? { reasoningSignature } : {}),
      ...(redactedThinking.length > 0 ? { redactedThinking } : {}),
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
      ...(firstDroppedSample ? { firstDroppedSample } : {}),
      ...(truncated ? { truncated } : {}),
    };
  }

  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningSignature ? { reasoningSignature } : {}),
    ...(redactedThinking.length > 0 ? { redactedThinking } : {}),
    ...(droppedChunks > 0 ? { droppedChunks } : {}),
    ...(firstDroppedSample ? { firstDroppedSample } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// 7. Gemini Interactions SSE
// ---------------------------------------------------------------------------

/**
 * Collapse Gemini Interactions SSE stream into a single response.
 *
 * Format (data-only, event_type inside JSON):
 *   data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"Hello"}}\n\n
 *   data: {"event_type":"interaction.complete","interaction":{"id":"...","usage":{...}}}\n\n
 */
export function collapseGeminiInteractionsSSE(body: string): CollapseResult {
  const lines = splitSSEEvents(body);
  let content = "";
  let reasoning = "";
  let droppedChunks = 0;
  let firstDroppedSample: string | undefined;
  const toolCalls: ToolCall[] = [];

  for (const line of lines) {
    const data = extractSSEData(splitSSELines(line));
    if (data === undefined) continue;

    const payload = data.trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch (err) {
      droppedChunks++;
      if (droppedChunks === 1) {
        const msg = err instanceof Error ? err.message : "unknown";
        firstDroppedSample = `parse failed (${msg}): ${surrogateSafeSlice(payload, 200)}`;
      }
      continue;
    }

    const eventType = parsed.event_type as string | undefined;
    if (!eventType) continue;

    if (eventType === "content.delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      if (delta.type === "text" && typeof delta.text === "string") {
        content += delta.text;
      } else if (delta.type === "function_call") {
        toolCalls.push({
          name: String(delta.name ?? ""),
          arguments:
            typeof delta.arguments === "string"
              ? delta.arguments
              : JSON.stringify(delta.arguments ?? {}),
          ...(delta.id ? { id: String(delta.id) } : {}),
        });
      } else if (delta.type === "thought_summary" && typeof delta.text === "string") {
        reasoning += delta.text;
      }
    }
  }

  if (toolCalls.length > 0) {
    return {
      ...(content ? { content } : {}),
      toolCalls,
      ...(reasoning ? { reasoning } : {}),
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
      ...(firstDroppedSample ? { firstDroppedSample } : {}),
    };
  }

  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(droppedChunks > 0 ? { droppedChunks } : {}),
    ...(firstDroppedSample ? { firstDroppedSample } : {}),
  };
}

// ---------------------------------------------------------------------------
// Dispatch helper — pick the right collapse function by provider
// ---------------------------------------------------------------------------

/**
 * Collapse a streaming response body into a non-streaming fixture response.
 * Returns null if the content type is not a known streaming format.
 * Falls back to OpenAI SSE parsing for unrecognized provider keys with text/event-stream.
 */
export function collapseStreamingResponse(
  contentType: string,
  providerKey: RecordProviderKey,
  body: string | Buffer,
  logger?: Logger,
): CollapseResult | null {
  const ct = contentType.toLowerCase();

  if (ct.includes("application/vnd.amazon.eventstream")) {
    const buf = typeof body === "string" ? Buffer.from(body, "binary") : body;
    return collapseBedrockEventStream(buf);
  }

  if (ct.includes("application/x-ndjson")) {
    const str = typeof body === "string" ? body : body.toString("utf8");
    return collapseOllamaNDJSON(str);
  }

  if (ct.includes("text/event-stream")) {
    const str = typeof body === "string" ? body : body.toString("utf8");
    switch (providerKey) {
      case "openai":
      case "azure":
        return collapseOpenAISSE(str);
      case "anthropic":
        return collapseAnthropicSSE(str);
      case "gemini":
      case "vertexai":
        return collapseGeminiSSE(str);
      case "gemini-interactions":
        return collapseGeminiInteractionsSSE(str);
      case "cohere":
        return collapseCohereSSE(str);
      case "bedrock":
        return collapseAnthropicSSE(str);
      default:
        logger?.warn(
          `[stream-collapse] unknown SSE provider "${providerKey}", falling back to OpenAI SSE format`,
        );
        return collapseOpenAISSE(str);
    }
  }

  return null;
}
