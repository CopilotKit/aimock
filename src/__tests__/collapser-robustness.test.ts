import { describe, it, expect } from "vitest";
import { crc32 } from "node:zlib";
import {
  collapseOpenAISSE,
  collapseGeminiSSE,
  collapseCohereSSE,
  collapseAnthropicSSE,
  collapseBedrockEventStream,
  collapseGeminiInteractionsSSE,
} from "../stream-collapse.js";
import { encodeEventStreamMessage } from "../aws-event-stream.js";

// ===========================================================================
// Robustness hardening for the per-provider stream collapsers.
//
// Each `describe` block targets one pre-existing defect found by review. The
// assertions encode the intended graceful behavior; they fail (RED) against
// the unfixed collapsers and pass (GREEN) once the fix lands.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Bedrock EventStream header bounds (decodeEventStreamFrames)
//
// `headersLength` / per-header `nameLen` / `valueLen` are read without
// bounds-checking. A frame with a VALID prelude CRC but a `headersLength`
// that overruns the payload throws an uncaught RangeError instead of the
// intended graceful `{ frames, truncated: true }`.
// ---------------------------------------------------------------------------

/**
 * Build a single AWS EventStream frame whose prelude CRC is VALID but whose
 * declared `headersLength` is `headersLength`, independent of the actual
 * payload. `totalLength` is sized so the whole frame fits inside the buffer
 * (so the existing total-length bounds check passes) and the message CRC is
 * computed correctly — the ONLY corruption is the oversized headers length,
 * which must be caught by header bounds validation.
 */
function buildFrameWithHeadersLength(headersLength: number, payload: Buffer): Buffer {
  // prelude (8) + prelude_crc (4) + payload + message_crc (4).
  // We intentionally allocate NO real header bytes — headersLength lies.
  const totalLength = 4 + 4 + 4 + payload.length + 4;
  const frame = Buffer.alloc(totalLength);
  let offset = 0;

  frame.writeUInt32BE(totalLength, offset);
  offset += 4;
  frame.writeUInt32BE(headersLength, offset); // bogus, oversized
  offset += 4;

  // Valid prelude CRC over the first 8 bytes (passes the prelude check).
  const preludeCrc = crc32(frame.subarray(0, 8));
  frame.writeUInt32BE(preludeCrc >>> 0, offset);
  offset += 4;

  payload.copy(frame, offset);
  offset += payload.length;

  // Valid message CRC over everything but the last 4 bytes.
  const messageCrc = crc32(frame.subarray(0, totalLength - 4));
  frame.writeUInt32BE(messageCrc >>> 0, offset);

  return frame;
}

describe("collapseBedrockEventStream malformed header bounds", () => {
  it("returns truncated (not a RangeError) when headersLength overruns the frame", () => {
    const payload = Buffer.from(JSON.stringify({ contentBlockDelta: { delta: { text: "Hi" } } }));
    // headersLength=1000 far exceeds the tiny payload region.
    const frame = buildFrameWithHeadersLength(1000, payload);

    let result: ReturnType<typeof collapseBedrockEventStream>;
    expect(() => {
      result = collapseBedrockEventStream(frame);
    }).not.toThrow();

    expect(result!.truncated).toBe(true);
  });

  it("processes valid earlier frames, then truncates on a malformed-header frame", () => {
    const goodFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "Good" } },
    });
    const payload = Buffer.from(JSON.stringify({ contentBlockDelta: { delta: { text: "Bad" } } }));
    const badFrame = buildFrameWithHeadersLength(5000, payload);
    const buf = Buffer.concat([goodFrame, badFrame]);

    let result: ReturnType<typeof collapseBedrockEventStream>;
    expect(() => {
      result = collapseBedrockEventStream(buf);
    }).not.toThrow();

    expect(result!.content).toBe("Good");
    expect(result!.truncated).toBe(true);
  });

  it("returns truncated when a per-header value length overruns the headers region", () => {
    // headersLength=4 leaves room for a 1-byte nameLen + 1-byte name + type
    // byte... but then the 2-byte valueLen read pushes past headersEnd, and the
    // declared value length itself overruns. Build the header bytes by hand.
    //
    // Layout inside the headers region (4 bytes): nameLen=1, name="x", type=7,
    // and then there is no room for the 2-byte valueLen → must be caught.
    const headerBytes = Buffer.from([
      0x01, // nameLen = 1
      0x78, // "x"
      0x07, // type = STRING
      0x00, // first byte of a valueLen that runs off the end of the region
    ]);
    const headersLength = headerBytes.length;
    const payload = Buffer.from(JSON.stringify({ contentBlockDelta: { delta: { text: "Z" } } }));
    const totalLength = 4 + 4 + 4 + headersLength + payload.length + 4;
    const frame = Buffer.alloc(totalLength);
    let offset = 0;
    frame.writeUInt32BE(totalLength, offset);
    offset += 4;
    frame.writeUInt32BE(headersLength, offset);
    offset += 4;
    const preludeCrc = crc32(frame.subarray(0, 8));
    frame.writeUInt32BE(preludeCrc >>> 0, offset);
    offset += 4;
    headerBytes.copy(frame, offset);
    offset += headersLength;
    payload.copy(frame, offset);
    offset += payload.length;
    const messageCrc = crc32(frame.subarray(0, totalLength - 4));
    frame.writeUInt32BE(messageCrc >>> 0, offset);

    let result: ReturnType<typeof collapseBedrockEventStream>;
    expect(() => {
      result = collapseBedrockEventStream(frame);
    }).not.toThrow();
    expect(result!.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Missing tool_call index — OpenAI SSE and Cohere SSE
//
// `const index = tc.index as number` assumes index present. If a delta omits
// `index`, every index-less delta collapses under a single map key, merging
// distinct tool calls and corrupting arguments. Distinct calls must stay
// distinct.
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE missing tool_call index", () => {
  it("keeps two index-less tool_call deltas as two distinct tool calls", () => {
    const body = [
      `data: ${JSON.stringify({
        id: "chatcmpl-noidx",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_a",
                  type: "function",
                  function: { name: "func_a", arguments: '{"x":1}' },
                },
              ],
            },
          },
        ],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-noidx",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_b",
                  type: "function",
                  function: { name: "func_b", arguments: '{"y":2}' },
                },
              ],
            },
          },
        ],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(2);
    const names = result.toolCalls!.map((tc) => tc.name).sort();
    expect(names).toEqual(["func_a", "func_b"]);
    // Arguments must not be cross-contaminated into one entry.
    const byName = Object.fromEntries(result.toolCalls!.map((tc) => [tc.name, tc.arguments]));
    expect(byName.func_a).toBe('{"x":1}');
    expect(byName.func_b).toBe('{"y":2}');
  });

  it("still merges streamed argument fragments that DO carry an index", () => {
    const body = [
      `data: ${JSON.stringify({
        id: "chatcmpl-idx",
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_x", function: { name: "fn", arguments: '{"a' } }],
            },
          },
        ],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-idx",
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] } }],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("fn");
    expect(result.toolCalls![0].arguments).toBe('{"a":1}');
  });
});

describe("collapseCohereSSE missing tool_call index", () => {
  it("keeps two index-less tool-call-start events as two distinct tool calls", () => {
    const body = [
      `event: tool-call-start`,
      `data: ${JSON.stringify({
        type: "tool-call-start",
        delta: {
          message: {
            tool_calls: {
              id: "call_a",
              type: "function",
              function: { name: "func_a", arguments: "" },
            },
          },
        },
      })}`,
      "",
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        delta: { message: { tool_calls: { function: { arguments: '{"x":1}' } } } },
      })}`,
      "",
      `event: tool-call-start`,
      `data: ${JSON.stringify({
        type: "tool-call-start",
        delta: {
          message: {
            tool_calls: {
              id: "call_b",
              type: "function",
              function: { name: "func_b", arguments: "" },
            },
          },
        },
      })}`,
      "",
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        delta: { message: { tool_calls: { function: { arguments: '{"y":2}' } } } },
      })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(2);
    const names = result.toolCalls!.map((tc) => tc.name).sort();
    expect(names).toEqual(["func_a", "func_b"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Gemini SSE tool args default — JSON.stringify(undefined) === undefined
//
// `JSON.stringify(fc.args)` returns the VALUE undefined when args is omitted,
// violating the ToolCall.arguments:string contract. Should be "{}".
// ---------------------------------------------------------------------------

describe("collapseGeminiSSE functionCall with no args", () => {
  it("defaults missing args to the JSON object string '{}'", () => {
    const body = [
      `data: ${JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "ping" } }] } }],
      })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].arguments).toBe("{}");
    expect(typeof result.toolCalls![0].arguments).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 4. Gemini SSE audio branch drops accumulated tool calls / content / reasoning
//
// When audioB64 is present the early return silently discards any tool calls,
// content, and reasoning accumulated earlier in the same stream.
// ---------------------------------------------------------------------------

describe("collapseGeminiSSE audio branch preserves accumulated data", () => {
  it("returns BOTH audio and a tool call when the stream has both", () => {
    const body = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } } }],
            },
          },
        ],
      })}`,
      "",
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ inlineData: { mimeType: "audio/pcm", data: "QUJD" } }],
            },
          },
        ],
      })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.audioB64).toBe("QUJD");
    expect(result.audioMimeType).toBe("audio/pcm");
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
  });

  it("returns BOTH audio and accumulated content + reasoning", () => {
    const body = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "thinking", thought: true }, { text: "visible answer" }],
            },
          },
        ],
      })}`,
      "",
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ inlineData: { mimeType: "audio/pcm", data: "WFla" } }],
            },
          },
        ],
      })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.audioB64).toBe("WFla");
    expect(result.content).toBe("visible answer");
    expect(result.reasoning).toBe("thinking");
  });
});

// ---------------------------------------------------------------------------
// 5. SSE multi-line `data:` fields — only the first data: line per event read
//
// Per the SSE spec a single event may carry multiple `data:` lines that are
// joined with "\n" to form one payload. The collapsers `.find` only the first.
// ---------------------------------------------------------------------------

/**
 * Emit a single SSE event whose JSON payload is spread across MULTIPLE
 * `data:` lines, the way a server splits a value at structural boundaries.
 *
 * Pretty-printing the object embeds newlines only between JSON tokens (where
 * whitespace is legal), so prefixing each resulting line with `data:` and
 * letting the collapser rejoin them with "\n" reconstructs valid JSON. This
 * is the realistic multi-`data:` case; a mid-token split would be malformed
 * SSE, not something a collapser should silently accept.
 */
function multiLineDataEvent(obj: unknown, eventLine?: string): string {
  const dataLines = JSON.stringify(obj, null, 2)
    .split("\n")
    .map((l) => `data: ${l}`);
  const parts = eventLine ? [eventLine, ...dataLines] : dataLines;
  return parts.join("\n");
}

describe("multi-line SSE data fields", () => {
  it("collapseOpenAISSE joins multiple data: lines into one JSON payload", () => {
    const event = multiLineDataEvent({ choices: [{ delta: { content: "Hello multiline" } }] });
    const body = [event, "", "data: [DONE]", ""].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("Hello multiline");
    expect(result.droppedChunks).toBeUndefined();
  });

  it("collapseAnthropicSSE joins multiple data: lines into one JSON payload", () => {
    const event = multiLineDataEvent(
      { index: 0, delta: { type: "text_delta", text: "Split text" } },
      "event: content_block_delta",
    );
    const body = [event, ""].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.content).toBe("Split text");
    expect(result.droppedChunks).toBeUndefined();
  });

  it("collapseGeminiSSE joins multiple data: lines into one JSON payload", () => {
    const event = multiLineDataEvent({
      candidates: [{ content: { parts: [{ text: "Gemini split" }] } }],
    });
    const body = [event, ""].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.content).toBe("Gemini split");
    expect(result.droppedChunks).toBeUndefined();
  });

  it("collapseGeminiInteractionsSSE joins multiple data: lines into one JSON payload", () => {
    const event = multiLineDataEvent({
      event_type: "content.delta",
      index: 0,
      delta: { type: "text", text: "Interactions split" },
    });
    const body = [event, ""].join("\n");

    const result = collapseGeminiInteractionsSSE(body);
    expect(result.content).toBe("Interactions split");
    expect(result.droppedChunks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. webSearches dropped from collapseOpenAISSE tool-call return branch
//
// The text-only return includes `webSearches`, but the tool-call return branch
// omits it. A Responses-API stream with both a web_search_call AND a tool_call
// loses the web searches.
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE webSearches with tool calls", () => {
  it("returns BOTH toolCalls and webSearches when the stream has both", () => {
    const body = [
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "web_search_call", status: "completed", action: { query: "weather paris" } },
      })}`,
      "",
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_ws",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              ],
            },
          },
        ],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.webSearches).toEqual(["weather paris"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Anthropic SSE missing content_block index
//
// `const index = parsed.index as number` is unguarded. When two tool_use
// content_block_start events both OMIT `index`, they collapse under the single
// `undefined` key and merge into one tool call. The OpenAI/Cohere/Bedrock
// collapsers already guard this; Anthropic must too.
// ---------------------------------------------------------------------------

describe("collapseAnthropicSSE missing content_block index", () => {
  it("keeps two index-less tool_use blocks as two distinct tool calls", () => {
    const body = [
      `event: content_block_start`,
      `data: ${JSON.stringify({
        type: "content_block_start",
        content_block: { type: "tool_use", id: "toolu_a", name: "func_a" },
      })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"x":1}' },
      })}`,
      "",
      `event: content_block_start`,
      `data: ${JSON.stringify({
        type: "content_block_start",
        content_block: { type: "tool_use", id: "toolu_b", name: "func_b" },
      })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"y":2}' },
      })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(2);
    const names = result.toolCalls!.map((tc) => tc.name).sort();
    expect(names).toEqual(["func_a", "func_b"]);
    // Arguments must land on the block they followed, not cross-contaminate.
    const byName = Object.fromEntries(result.toolCalls!.map((tc) => [tc.name, tc.arguments]));
    expect(byName.func_a).toBe('{"x":1}');
    expect(byName.func_b).toBe('{"y":2}');
  });
});

// ---------------------------------------------------------------------------
// 8. Cohere SSE mixed-key delta correlation + uncorrelated-delta accounting
//
// `lastSyntheticIndex` was only set for index-LESS starts, so a real-indexed
// start followed by an index-less delta fell back to a stale/undefined key and
// silently dropped the args. The most-recent start key must be tracked
// regardless of how it was keyed. And a delta that cannot correlate to any
// known start must increment droppedChunks rather than vanish.
// ---------------------------------------------------------------------------

describe("collapseCohereSSE mixed-key delta correlation", () => {
  it("lands an index-less delta on the most recent REAL-indexed start", () => {
    const body = [
      `event: tool-call-start`,
      `data: ${JSON.stringify({
        type: "tool-call-start",
        index: 0,
        delta: {
          message: {
            tool_calls: {
              id: "call_a",
              type: "function",
              function: { name: "func_a", arguments: "" },
            },
          },
        },
      })}`,
      "",
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        delta: { message: { tool_calls: { function: { arguments: '{"x":1}' } } } },
      })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("func_a");
    expect(result.toolCalls![0].arguments).toBe('{"x":1}');
  });

  it("counts an index-less delta with no prior start as a dropped chunk", () => {
    const body = [
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        delta: { message: { tool_calls: { function: { arguments: '{"orphan":true}' } } } },
      })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.toolCalls).toBeUndefined();
    expect(result.droppedChunks).toBe(1);
    expect(result.firstDroppedSample).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. CRLF-delimited SSE streams
//
// Real HTTP/SSE streams use CRLF (`\r\n`) line endings and `\r\n\r\n` between
// events. Splitting events on `\n\n` and data lines on `\n` leaves a trailing
// `\r` on each data line, so the final `data: [DONE]\r` mis-parses and earlier
// payloads carry a stray `\r`, corrupting JSON.parse.
// ---------------------------------------------------------------------------

describe("CRLF-delimited SSE streams", () => {
  it("collapseOpenAISSE parses a CRLF stream (content + [DONE])", () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello CRLF" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\r\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("Hello CRLF");
    expect(result.droppedChunks).toBeUndefined();
  });

  it("collapseAnthropicSSE parses a multi-event CRLF stream", () => {
    const body = [
      "event: content_block_delta",
      `data: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "CRLF " } })}`,
      "",
      "event: content_block_delta",
      `data: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "text" } })}`,
      "",
    ].join("\r\n");

    const result = collapseAnthropicSSE(body);
    expect(result.content).toBe("CRLF text");
    expect(result.droppedChunks).toBeUndefined();
  });

  it("collapseGeminiSSE parses a multi-event CRLF stream", () => {
    const body = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Gemini " }] } }] })}`,
      "",
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "CRLF" }] } }] })}`,
      "",
    ].join("\r\n");

    const result = collapseGeminiSSE(body);
    expect(result.content).toBe("Gemini CRLF");
    expect(result.droppedChunks).toBeUndefined();
  });

  it("collapseGeminiInteractionsSSE parses a multi-event CRLF stream", () => {
    const body = [
      `data: ${JSON.stringify({
        event_type: "content.delta",
        index: 0,
        delta: { type: "text", text: "Interactions " },
      })}`,
      "",
      `data: ${JSON.stringify({
        event_type: "content.delta",
        index: 0,
        delta: { type: "text", text: "CRLF" },
      })}`,
      "",
    ].join("\r\n");

    const result = collapseGeminiInteractionsSSE(body);
    expect(result.content).toBe("Interactions CRLF");
    expect(result.droppedChunks).toBeUndefined();
  });

  it("collapseCohereSSE parses a multi-event CRLF stream", () => {
    const body = [
      "event: content-delta",
      `data: ${JSON.stringify({
        type: "content-delta",
        delta: { message: { content: { text: "Cohere " } } },
      })}`,
      "",
      "event: content-delta",
      `data: ${JSON.stringify({
        type: "content-delta",
        delta: { message: { content: { text: "CRLF" } } },
      })}`,
      "",
    ].join("\r\n");

    const result = collapseCohereSSE(body);
    expect(result.content).toBe("Cohere CRLF");
    expect(result.droppedChunks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Uncorrelated tool-arg deltas — Anthropic SSE + Bedrock EventStream
//
// The Cohere collapser already accounts for a tool-call-delta that has no
// correlating start as a dropped chunk (droppedChunks++ / firstDroppedSample).
// The Anthropic `input_json_delta` path and both Bedrock arg-delta paths
// (Messages `input_json_delta` and Converse `toolUse.input`) silently dropped
// the analogous uncorrelated delta. They must mirror Cohere. AND the Anthropic
// `lastSyntheticIndex` fallback must still let a real-indexed start correlate
// to a following index-less delta (positive coverage).
// ---------------------------------------------------------------------------

describe("collapseAnthropicSSE uncorrelated input_json_delta", () => {
  it("counts an input_json_delta with no correlating tool_use start as a dropped chunk", () => {
    const body = [
      `event: content_block_delta`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"orphan":true}' },
      })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.toolCalls).toBeUndefined();
    expect(result.droppedChunks).toBe(1);
    // The sample carries the raw SSE payload (the orphan partial_json is
    // JSON-escaped inside it), so assert the orphan token survives — stronger
    // than the bare `.toBeDefined()` it would otherwise be.
    expect(result.firstDroppedSample).toContain("no correlating tool_use start");
    expect(result.firstDroppedSample).toContain('orphan\\":true');
  });

  it("lands an index-less delta on the most recent REAL-indexed tool_use start", () => {
    const body = [
      `event: content_block_start`,
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 3,
        content_block: { type: "tool_use", id: "toolu_real", name: "func_real" },
      })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"k":9}' },
      })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("func_real");
    expect(result.toolCalls![0].arguments).toBe('{"k":9}');
    expect(result.droppedChunks).toBeUndefined();
  });
});

describe("collapseBedrockEventStream uncorrelated tool-arg deltas", () => {
  it("counts a Messages input_json_delta with no correlating start as a dropped chunk", () => {
    const frame = encodeEventStreamMessage("contentBlockDelta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"orphanMsg":1}' },
    });

    const result = collapseBedrockEventStream(frame);
    expect(result.toolCalls).toBeUndefined();
    expect(result.droppedChunks).toBe(1);
    expect(result.firstDroppedSample).toContain("no correlating tool_use start");
    expect(result.firstDroppedSample).toContain('orphanMsg\\":1');
  });

  it("counts a Converse toolUse.input with no correlating start as a dropped chunk", () => {
    const frame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 0,
      contentBlockDelta: {
        delta: { toolUse: { input: '{"orphanConverse":2}' } },
      },
    });

    const result = collapseBedrockEventStream(frame);
    expect(result.toolCalls).toBeUndefined();
    expect(result.droppedChunks).toBe(1);
    expect(result.firstDroppedSample).toContain("no correlating tool_use start");
    expect(result.firstDroppedSample).toContain('orphanConverse\\":2');
  });
});
