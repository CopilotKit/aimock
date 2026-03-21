/**
 * Stream collapsing functions for record-and-replay.
 *
 * Each function takes a raw streaming response body (SSE, NDJSON, or binary
 * EventStream) and collapses it into a non-streaming fixture response
 * containing either `{ content }` or `{ toolCalls }`.
 */

import { crc32 } from "node:zlib";
import type { RecordProviderKey, ToolCall } from "./types.js";

// ---------------------------------------------------------------------------
// Result type shared by all collapse functions
// ---------------------------------------------------------------------------

// TODO: Consider making this a discriminated union ({ type: "text"; content: string }
// | { type: "toolCalls"; toolCalls: ToolCall[] } | { type: "empty" }) to prevent
// ambiguous results and simplify downstream consumers.
export interface CollapseResult {
  content?: string;
  toolCalls?: ToolCall[];
  droppedChunks?: number;
  truncated?: boolean;
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
  const lines = body.split("\n\n").filter((l) => l.trim().length > 0);
  let content = "";
  let droppedChunks = 0;
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

  for (const line of lines) {
    const dataLine = line.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;

    const payload = dataLine.slice(5).trim();
    if (payload === "[DONE]") continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      droppedChunks++;
      continue;
    }

    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) continue;

    const delta = choices[0].delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    // Text content
    if (typeof delta.content === "string") {
      content += delta.content;
    }

    // Tool calls
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const index = tc.index as number;
        const fn = tc.function as Record<string, unknown> | undefined;

        if (!toolCallMap.has(index)) {
          toolCallMap.set(index, {
            id: (tc.id as string) ?? "",
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

  if (toolCallMap.size > 0) {
    const sorted = Array.from(toolCallMap.entries()).sort(([a], [b]) => a - b);
    return {
      toolCalls: sorted.map(([, tc]) => ({
        name: tc.name,
        arguments: tc.arguments,
        ...(tc.id ? { id: tc.id } : {}),
      })),
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
    };
  }

  return { content, ...(droppedChunks > 0 ? { droppedChunks } : {}) };
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
  const blocks = body.split("\n\n").filter((b) => b.trim().length > 0);
  let content = "";
  let droppedChunks = 0;
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

  for (const block of blocks) {
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!dataLine) continue;

    const eventType = eventLine ? eventLine.slice(6).trim() : "";
    const payload = dataLine.slice(5).trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      droppedChunks++;
      continue;
    }

    if (eventType === "content_block_start") {
      const index = parsed.index as number;
      const contentBlock = parsed.content_block as Record<string, unknown> | undefined;
      if (contentBlock?.type === "tool_use") {
        toolCallMap.set(index, {
          id: (contentBlock.id as string) ?? "",
          name: (contentBlock.name as string) ?? "",
          arguments: "",
        });
      }
    }

    if (eventType === "content_block_delta") {
      const index = parsed.index as number;
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      if (delta.type === "text_delta" && typeof delta.text === "string") {
        content += delta.text;
      }

      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const entry = toolCallMap.get(index);
        if (entry) {
          entry.arguments += delta.partial_json;
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
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
    };
  }

  return { content, ...(droppedChunks > 0 ? { droppedChunks } : {}) };
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
  const lines = body.split("\n\n").filter((l) => l.trim().length > 0);
  let content = "";
  let droppedChunks = 0;

  for (const line of lines) {
    const dataLine = line.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;

    const payload = dataLine.slice(5).trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      droppedChunks++;
      continue;
    }

    const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
    if (!candidates || candidates.length === 0) continue;

    const candidateContent = candidates[0].content as Record<string, unknown> | undefined;
    if (!candidateContent) continue;

    const parts = candidateContent.parts as Array<Record<string, unknown>> | undefined;
    if (!parts || parts.length === 0) continue;

    // Handle functionCall parts
    const fnCallParts = parts.filter((p) => p.functionCall);
    if (fnCallParts.length > 0) {
      const toolCallMap = new Map<number, { name: string; arguments: string }>();
      for (let i = 0; i < fnCallParts.length; i++) {
        const fc = fnCallParts[i].functionCall as Record<string, unknown>;
        toolCallMap.set(i, {
          name: String(fc.name ?? ""),
          arguments: typeof fc.args === "string" ? (fc.args as string) : JSON.stringify(fc.args),
        });
      }
      if (toolCallMap.size > 0) {
        const sorted = Array.from(toolCallMap.entries()).sort(([a], [b]) => a - b);
        return {
          toolCalls: sorted.map(([, tc]) => ({
            name: tc.name,
            arguments: tc.arguments,
          })),
          ...(droppedChunks > 0 ? { droppedChunks } : {}),
        };
      }
    }

    if (typeof parts[0].text === "string") {
      content += parts[0].text;
    }
  }

  return { content, ...(droppedChunks > 0 ? { droppedChunks } : {}) };
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
 */
export function collapseOllamaNDJSON(body: string): CollapseResult {
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  let content = "";
  let droppedChunks = 0;
  const toolCalls: ToolCall[] = [];

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    } catch {
      droppedChunks++;
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
              arguments:
                typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments),
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

  if (toolCalls.length > 0) {
    return { toolCalls, ...(droppedChunks > 0 ? { droppedChunks } : {}) };
  }

  return { content, ...(droppedChunks > 0 ? { droppedChunks } : {}) };
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
  const blocks = body.split("\n\n").filter((b) => b.trim().length > 0);
  let content = "";
  let droppedChunks = 0;
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

  for (const block of blocks) {
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!dataLine) continue;

    const eventType = eventLine ? eventLine.slice(6).trim() : "";
    const payload = dataLine.slice(5).trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      droppedChunks++;
      continue;
    }

    if (eventType === "content-delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      const message = delta?.message as Record<string, unknown> | undefined;
      const contentObj = message?.content as Record<string, unknown> | undefined;
      if (contentObj && typeof contentObj.text === "string") {
        content += contentObj.text;
      }
    }

    if (eventType === "tool-call-start") {
      const index = parsed.index as number;
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
      const index = parsed.index as number;
      const delta = parsed.delta as Record<string, unknown> | undefined;
      const message = delta?.message as Record<string, unknown> | undefined;
      const toolCalls = message?.tool_calls as Record<string, unknown> | undefined;
      if (toolCalls) {
        const fn = toolCalls.function as Record<string, unknown> | undefined;
        if (fn && typeof fn.arguments === "string") {
          const entry = toolCallMap.get(index);
          if (entry) {
            entry.arguments += fn.arguments;
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
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
    };
  }

  return { content, ...(droppedChunks > 0 ? { droppedChunks } : {}) };
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

    // Validate prelude CRC
    const preludeCrc = buf.readUInt32BE(offset + 8);
    const computedPreludeCrc = crc32(buf.subarray(offset, offset + 8));
    if (preludeCrc >>> 0 !== computedPreludeCrc >>> 0) {
      return { frames, truncated: true }; // Prelude CRC mismatch — stop parsing
    }

    // Parse headers
    const headersStart = offset + 12;
    const headersEnd = headersStart + headersLength;
    const headers: Record<string, string> = {};
    let hOffset = headersStart;

    while (hOffset < headersEnd) {
      const nameLen = buf.readUInt8(hOffset);
      hOffset += 1;
      const name = buf.subarray(hOffset, hOffset + nameLen).toString("utf8");
      hOffset += nameLen;
      // Skip header type byte (type 7 = STRING)
      hOffset += 1;
      const valueLen = buf.readUInt16BE(hOffset);
      hOffset += 2;
      const value = buf.subarray(hOffset, hOffset + valueLen).toString("utf8");
      hOffset += valueLen;
      headers[name] = value;
    }

    // Extract payload
    const payloadStart = headersEnd;
    const payloadEnd = offset + totalLength - 4; // minus message CRC
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
  let droppedChunks = 0;
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

  for (const frame of frames) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
    } catch {
      droppedChunks++;
      continue;
    }

    // Anthropic Messages format (invoke-with-response-stream): flat payload with "type" field
    if (parsed.type === "content_block_delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        content += delta.text;
      }
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const index = parsed.index as number | undefined;
        if (index !== undefined) {
          const entry = toolCallMap.get(index);
          if (entry) entry.arguments += delta.partial_json;
        }
      }
      continue;
    }
    if (parsed.type === "content_block_start") {
      const block = parsed.content_block as Record<string, unknown> | undefined;
      const index = parsed.index as number | undefined;
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

      // Tool use input JSON delta
      if (typeof delta.toolUse === "object" && delta.toolUse !== null) {
        const toolUseDelta = delta.toolUse as Record<string, unknown>;
        if (typeof toolUseDelta.input === "string" && index !== undefined) {
          const entry = toolCallMap.get(index);
          if (entry) {
            entry.arguments += toolUseDelta.input;
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
      ...(droppedChunks > 0 ? { droppedChunks } : {}),
      ...(truncated ? { truncated } : {}),
    };
  }

  return {
    content,
    ...(droppedChunks > 0 ? { droppedChunks } : {}),
    ...(truncated ? { truncated } : {}),
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
      case "cohere":
        return collapseCohereSSE(str);
      default:
        console.warn(
          `[stream-collapse] unknown SSE provider "${providerKey}", falling back to OpenAI SSE format`,
        );
        return collapseOpenAISSE(str);
    }
  }

  return null;
}
