import { describe, it, expect } from "vitest";
import {
  collapseOpenAISSE,
  collapseAnthropicSSE,
  collapseGeminiSSE,
  collapseOllamaNDJSON,
  collapseCohereSSE,
  collapseBedrockEventStream,
  collapseStreamingResponse,
} from "../stream-collapse.js";
import { encodeEventStreamMessage, encodeEventStreamFrame } from "../aws-event-stream.js";
import { parseHarmonyContent } from "../harmony.js";

// ---------------------------------------------------------------------------
// 1. OpenAI SSE
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE", () => {
  it("collapses text content from SSE chunks", () => {
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-123", choices: [{ delta: { role: "assistant" } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-123", choices: [{ delta: { content: "Hello" } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-123", choices: [{ delta: { content: " world" } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-123", choices: [{ delta: { content: "!" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("Hello world!");
    expect(result.toolCalls).toBeUndefined();
  });

  it("collapses tool calls with merged arguments", () => {
    const body = [
      `data: ${JSON.stringify({
        id: "chatcmpl-456",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"ci' },
                },
              ],
            },
          },
        ],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-456",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'ty":"Pa' },
                },
              ],
            },
          },
        ],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-456",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'ris"}' },
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
    expect(result.toolCalls![0].arguments).toBe('{"city":"Paris"}');
    expect(result.toolCalls![0].id).toBe("call_abc");
    expect(result.content).toBeUndefined();
  });

  it("handles multiple tool calls", () => {
    const body = [
      `data: ${JSON.stringify({
        id: "chatcmpl-789",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "func_a", arguments: '{"x":1}' },
                },
                {
                  index: 1,
                  id: "call_2",
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
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].name).toBe("func_a");
    expect(result.toolCalls![1].name).toBe("func_b");
  });

  it("returns empty content for empty stream", () => {
    const body = "data: [DONE]\n\n";
    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("");
  });

  it("counts droppedChunks for malformed JSON mixed with valid chunks", () => {
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-d1", choices: [{ delta: { content: "A" } }] })}`,
      "",
      `data: {INVALID JSON!!!`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-d1", choices: [{ delta: { content: "B" } }] })}`,
      "",
      `data: also broken`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-d1", choices: [{ delta: { content: "C" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("ABC");
    expect(result.droppedChunks).toBe(2);
  });

  it("choices with no delta property are skipped (continue)", () => {
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-nd", choices: [{ finish_reason: "stop" }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-nd", choices: [{ delta: { content: "OK" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("OK");
  });

  it("captures both text deltas and tool call deltas in same stream", () => {
    const body = [
      `data: ${JSON.stringify({
        id: "chatcmpl-mix",
        choices: [{ delta: { content: "Calling tool..." } }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-mix",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_mix",
                  type: "function",
                  function: { name: "lookup", arguments: '{"q":"test"}' },
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
    // When tool calls exist, they win over content
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("lookup");
    expect(result.toolCalls![0].arguments).toBe('{"q":"test"}');
  });
});

// ---------------------------------------------------------------------------
// 2. Anthropic SSE
// ---------------------------------------------------------------------------

describe("collapseAnthropicSSE", () => {
  it("collapses text content from SSE chunks", () => {
    const body = [
      `event: message_start`,
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_123", role: "assistant" } })}`,
      "",
      `event: content_block_start`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } })}`,
      "",
      `event: content_block_stop`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      "",
      `event: message_stop`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.content).toBe("Hello world");
    expect(result.toolCalls).toBeUndefined();
  });

  it("collapses tool use with input_json_delta", () => {
    const body = [
      `event: message_start`,
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_456" } })}`,
      "",
      `event: content_block_start`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_abc", name: "get_weather", input: {} } })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"ci' } })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ty":"Paris"}' } })}`,
      "",
      `event: content_block_stop`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      "",
      `event: message_stop`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"Paris"}');
    expect(result.toolCalls![0].id).toBe("toolu_abc");
    expect(result.content).toBeUndefined();
  });
  it("counts droppedChunks for malformed JSON mixed with valid chunks", () => {
    const body = [
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}`,
      "",
      `event: content_block_delta`,
      `data: {BROKEN JSON`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.content).toBe("Hi there");
    expect(result.droppedChunks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Gemini SSE
// ---------------------------------------------------------------------------

describe("collapseGeminiSSE", () => {
  it("collapses text content from data-only SSE", () => {
    const body = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] })}`,
      "",
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: " world" }] } }] })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.content).toBe("Hello world");
  });

  it("handles empty candidates gracefully", () => {
    const body = `data: ${JSON.stringify({ candidates: [] })}\n\n`;
    const result = collapseGeminiSSE(body);
    expect(result.content).toBe("");
  });

  it("collapses functionCall parts into toolCalls", () => {
    const body = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "get_weather",
                    args: { city: "Paris" },
                  },
                },
              ],
            },
            finishReason: "FUNCTION_CALL",
          },
        ],
      })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(JSON.parse(result.toolCalls![0].arguments)).toEqual({ city: "Paris" });
    expect(result.content).toBeUndefined();
  });
  it("counts droppedChunks for malformed JSON mixed with valid chunks", () => {
    const body = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "X" }] } }] })}`,
      "",
      `data: NOT VALID JSON AT ALL`,
      "",
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Y" }] } }] })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.content).toBe("XY");
    expect(result.droppedChunks).toBe(1);
  });

  it("includes droppedChunks in functionCall return path (bug fix)", () => {
    const body = [
      `data: NOT VALID JSON`,
      "",
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "get_weather",
                    args: { city: "Paris" },
                  },
                },
              ],
            },
            finishReason: "FUNCTION_CALL",
          },
        ],
      })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.droppedChunks).toBe(1);
  });

  it("candidate with no content property is skipped (continue)", () => {
    const body = [
      `data: ${JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] })}`,
      "",
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.content).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// 4. Ollama NDJSON
// ---------------------------------------------------------------------------

describe("collapseOllamaNDJSON", () => {
  it("collapses /api/chat format (message.content)", () => {
    const body = [
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "Hello" },
        done: false,
      }),
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: " world" },
        done: false,
      }),
      JSON.stringify({ model: "llama3", message: { role: "assistant", content: "" }, done: true }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);
    expect(result.content).toBe("Hello world");
  });

  it("collapses /api/generate format (response field)", () => {
    const body = [
      JSON.stringify({ model: "llama3", response: "Hello", done: false }),
      JSON.stringify({ model: "llama3", response: " world", done: false }),
      JSON.stringify({ model: "llama3", response: "", done: true }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);
    expect(result.content).toBe("Hello world");
  });
});

// ---------------------------------------------------------------------------
// 5. Cohere SSE
// ---------------------------------------------------------------------------

describe("collapseCohereSSE", () => {
  it("collapses text content from content-delta events", () => {
    const body = [
      `event: message-start`,
      `data: ${JSON.stringify({ type: "message-start", delta: { message: { role: "assistant" } } })}`,
      "",
      `event: content-delta`,
      `data: ${JSON.stringify({ type: "content-delta", index: 0, delta: { message: { content: { type: "text", text: "Hello" } } } })}`,
      "",
      `event: content-delta`,
      `data: ${JSON.stringify({ type: "content-delta", index: 0, delta: { message: { content: { type: "text", text: " world" } } } })}`,
      "",
      `event: message-end`,
      `data: ${JSON.stringify({ type: "message-end", delta: { finish_reason: "COMPLETE" } })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.content).toBe("Hello world");
    expect(result.toolCalls).toBeUndefined();
  });

  it("collapses tool calls from tool-call events", () => {
    const body = [
      `event: message-start`,
      `data: ${JSON.stringify({ type: "message-start", delta: { message: { role: "assistant" } } })}`,
      "",
      `event: tool-call-start`,
      `data: ${JSON.stringify({
        type: "tool-call-start",
        index: 0,
        delta: {
          message: {
            tool_calls: {
              id: "call_xyz",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          },
        },
      })}`,
      "",
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        index: 0,
        delta: { message: { tool_calls: { function: { arguments: '{"city"' } } } },
      })}`,
      "",
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        index: 0,
        delta: { message: { tool_calls: { function: { arguments: ':"Paris"}' } } } },
      })}`,
      "",
      `event: message-end`,
      `data: ${JSON.stringify({ type: "message-end", delta: { finish_reason: "TOOL_CALL" } })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"Paris"}');
    expect(result.toolCalls![0].id).toBe("call_xyz");
    expect(result.content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Bedrock EventStream (binary)
// ---------------------------------------------------------------------------

describe("collapseBedrockEventStream", () => {
  it("collapses text content from binary event frames", () => {
    const frame1 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: {
        delta: { text: "Hello" },
      },
    });
    const frame2 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: {
        delta: { text: " world" },
      },
    });

    const buf = Buffer.concat([frame1, frame2]);
    const result = collapseBedrockEventStream(buf);
    expect(result.content).toBe("Hello world");
  });

  it("handles empty buffer", () => {
    const result = collapseBedrockEventStream(Buffer.alloc(0));
    expect(result.content).toBe("");
  });

  it("collapses tool call from contentBlockStart + contentBlockDelta with toolUse", () => {
    const startFrame = encodeEventStreamMessage("contentBlockStart", {
      contentBlockIndex: 0,
      contentBlockStart: {
        contentBlockIndex: 0,
        start: {
          toolUse: {
            toolUseId: "tool_123",
            name: "get_weather",
          },
        },
      },
    });
    const deltaFrame1 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 0,
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: {
          toolUse: { input: '{"ci' },
        },
      },
    });
    const deltaFrame2 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 0,
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: {
          toolUse: { input: 'ty":"Paris"}' },
        },
      },
    });

    const buf = Buffer.concat([startFrame, deltaFrame1, deltaFrame2]);
    const result = collapseBedrockEventStream(buf);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"Paris"}');
    expect(result.toolCalls![0].id).toBe("tool_123");
  });

  it("stops parsing gracefully on corrupted prelude CRC", () => {
    const goodFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: {
        delta: { text: "Good" },
      },
    });
    const badFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: {
        delta: { text: "Bad" },
      },
    });
    // Corrupt the prelude CRC (bytes 8-11) of the bad frame
    const badFrameBuf = Buffer.from(badFrame);
    badFrameBuf.writeUInt32BE(0xdeadbeef, 8);

    const buf = Buffer.concat([goodFrame, badFrameBuf]);
    const result = collapseBedrockEventStream(buf);
    // Should parse the good frame but stop at the corrupted one
    expect(result.content).toBe("Good");
  });
});

// ---------------------------------------------------------------------------
// collapseStreamingResponse dispatch
// ---------------------------------------------------------------------------

describe("collapseStreamingResponse", () => {
  it("returns null for application/json (not streaming)", () => {
    const result = collapseStreamingResponse("application/json", "openai", '{"choices":[]}');
    expect(result).toBeNull();
  });

  it("dispatches text/event-stream to OpenAI for openai provider", () => {
    const body = `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`;
    const result = collapseStreamingResponse("text/event-stream", "openai", body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("hi");
  });

  it("dispatches text/event-stream to Anthropic for anthropic provider", () => {
    const body = [
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}`,
      "",
    ].join("\n");
    const result = collapseStreamingResponse("text/event-stream", "anthropic", body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("hi");
  });

  it("dispatches text/event-stream to Gemini for gemini provider", () => {
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })}\n\n`;
    const result = collapseStreamingResponse("text/event-stream", "gemini", body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("hi");
  });

  it("dispatches application/x-ndjson to Ollama", () => {
    const body = JSON.stringify({
      model: "m",
      message: { role: "assistant", content: "hi" },
      done: true,
    });
    const result = collapseStreamingResponse("application/x-ndjson", "ollama", body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("hi");
  });

  it("dispatches text/event-stream to Cohere for cohere provider", () => {
    const body = [
      `event: content-delta`,
      `data: ${JSON.stringify({ type: "content-delta", index: 0, delta: { message: { content: { type: "text", text: "hi" } } } })}`,
      "",
    ].join("\n");
    const result = collapseStreamingResponse("text/event-stream", "cohere", body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("hi");
  });

  it("dispatches application/vnd.amazon.eventstream to Bedrock", () => {
    const frame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "hi" } },
    });
    const result = collapseStreamingResponse(
      "application/vnd.amazon.eventstream",
      "bedrock",
      frame,
    );
    expect(result).not.toBeNull();
    expect(result!.content).toBe("hi");
  });

  it('dispatches text/event-stream with "azure" to OpenAI collapse', () => {
    const body = `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "azure-hi" } }] })}\n\ndata: [DONE]\n\n`;
    const result = collapseStreamingResponse("text/event-stream", "azure", body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("azure-hi");
  });

  it('dispatches text/event-stream with "vertexai" to Gemini collapse', () => {
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "vertex-hi" }] } }] })}\n\n`;
    const result = collapseStreamingResponse("text/event-stream", "vertexai", body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("vertex-hi");
  });

  it('dispatches text/event-stream with "gemini-interactions" to Gemini Interactions collapse', () => {
    const body = [
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"gi-hi"},"event_id":"evt_1"}',
      "",
    ].join("\n");
    const result = collapseStreamingResponse("text/event-stream", "gemini-interactions", body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("gi-hi");
  });

  it('dispatches text/event-stream with "unknown-provider" to OpenAI collapse (fallback)', () => {
    const body = `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "fallback-hi" } }] })}\n\ndata: [DONE]\n\n`;
    const result = collapseStreamingResponse(
      "text/event-stream",
      "unknown-provider" as never,
      body,
    );
    expect(result).not.toBeNull();
    expect(result!.content).toBe("fallback-hi");
  });

  it("Bedrock: string body through collapseStreamingResponse (not Buffer)", () => {
    // Build a valid frame and convert to binary string
    const frame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "str-body" } },
    });
    const binaryStr = frame.toString("binary");
    const result = collapseStreamingResponse(
      "application/vnd.amazon.eventstream",
      "bedrock",
      binaryStr,
    );
    expect(result).not.toBeNull();
    expect(result!.content).toBe("str-body");
  });

  it("collapseStreamingResponse with Buffer input for non-Bedrock SSE provider", () => {
    const sseStr = `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "buf-hi" } }] })}\n\ndata: [DONE]\n\n`;
    const buf = Buffer.from(sseStr, "utf8");
    const result = collapseStreamingResponse("text/event-stream", "openai", buf);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("buf-hi");
  });

  it("unknown SSE provider key falls back to OpenAI SSE format", () => {
    const openaiSse = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
    // "unknown-provider" is not in RecordProviderKey; "as never" lets us test the runtime default branch
    const result = collapseStreamingResponse(
      "text/event-stream",
      "unknown-provider" as never,
      openaiSse,
    );
    expect(result).not.toBeNull();
    expect(result?.content).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// droppedChunks: Ollama, Cohere, Bedrock
// ---------------------------------------------------------------------------

describe("collapseOllamaNDJSON droppedChunks", () => {
  it("counts droppedChunks for malformed JSON lines mixed with valid ones", () => {
    const body = [
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "A" },
        done: false,
      }),
      "NOT VALID JSON",
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "B" },
        done: false,
      }),
      "{also broken",
      JSON.stringify({ model: "llama3", message: { role: "assistant", content: "" }, done: true }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);
    expect(result.content).toBe("AB");
    expect(result.droppedChunks).toBe(2);
  });
});

describe("collapseCohereSSE droppedChunks", () => {
  it("counts droppedChunks for malformed JSON events mixed with valid ones", () => {
    const body = [
      `event: content-delta`,
      `data: ${JSON.stringify({ type: "content-delta", index: 0, delta: { message: { content: { type: "text", text: "X" } } } })}`,
      "",
      `event: content-delta`,
      `data: {BROKEN`,
      "",
      `event: content-delta`,
      `data: ${JSON.stringify({ type: "content-delta", index: 0, delta: { message: { content: { type: "text", text: "Y" } } } })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.content).toBe("XY");
    expect(result.droppedChunks).toBe(1);
  });
});

describe("collapseBedrockEventStream droppedChunks", () => {
  it("counts droppedChunks for valid frame with malformed JSON payload", () => {
    const goodFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "Good" } },
    });

    // Build a frame with non-JSON payload
    const badPayload = Buffer.from("NOT JSON AT ALL", "utf8");
    const badFrame = encodeEventStreamFrame(
      {
        ":content-type": "application/json",
        ":event-type": "contentBlockDelta",
        ":message-type": "event",
      },
      badPayload,
    );

    const goodFrame2 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: " data" } },
    });

    const buf = Buffer.concat([goodFrame, badFrame, goodFrame2]);
    const result = collapseBedrockEventStream(buf);
    expect(result.content).toBe("Good data");
    expect(result.droppedChunks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Message CRC validation
// ---------------------------------------------------------------------------

describe("collapseBedrockEventStream message CRC validation", () => {
  it("stops parsing on corrupted message CRC", () => {
    const goodFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "Good" } },
    });
    const badFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "Bad" } },
    });
    // Corrupt the message CRC (last 4 bytes) of the bad frame
    const badFrameBuf = Buffer.from(badFrame);
    badFrameBuf.writeUInt32BE(0xdeadbeef, badFrameBuf.length - 4);

    const buf = Buffer.concat([goodFrame, badFrameBuf]);
    const result = collapseBedrockEventStream(buf);
    // Should parse the good frame but stop at the corrupted one
    expect(result.content).toBe("Good");
  });
});

// ---------------------------------------------------------------------------
// CRC mismatch truncation warnings
// ---------------------------------------------------------------------------

describe("decodeEventStreamFrames truncation warnings", () => {
  it("sets truncated when prelude CRC is bad", () => {
    const goodFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "Good" } },
    });
    const badFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "Bad" } },
    });
    // Corrupt the prelude CRC (bytes 8–11) of the bad frame
    const badFrameBuf = Buffer.from(badFrame);
    badFrameBuf.writeUInt32BE(0xdeadbeef, 8);

    const buf = Buffer.concat([goodFrame, badFrameBuf]);
    const result = collapseBedrockEventStream(buf);

    // Good frame still processed; bad frame causes truncation
    expect(result.content).toBe("Good");
    expect(result.truncated).toBe(true);
  });

  it("sets truncated when message CRC is bad", () => {
    const goodFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "Hello" } },
    });
    const badFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "World" } },
    });
    // Corrupt the message CRC (last 4 bytes) of the bad frame
    const badFrameBuf = Buffer.from(badFrame);
    badFrameBuf.writeUInt32BE(0xdeadbeef, badFrameBuf.length - 4);

    const buf = Buffer.concat([goodFrame, badFrameBuf]);
    const result = collapseBedrockEventStream(buf);

    // Good frame still processed; bad frame causes truncation
    expect(result.content).toBe("Hello");
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiple tool calls: Anthropic, Cohere, Bedrock
// ---------------------------------------------------------------------------

describe("collapseAnthropicSSE multiple tool calls", () => {
  it("collapses 2 tool_use blocks at different content_block indices", () => {
    const body = [
      `event: message_start`,
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_multi" } })}`,
      "",
      `event: content_block_start`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"NYC"}' } })}`,
      "",
      `event: content_block_stop`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      "",
      `event: content_block_start`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "get_time", input: {} } })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"tz":"EST"}' } })}`,
      "",
      `event: content_block_stop`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`,
      "",
      `event: message_stop`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"NYC"}');
    expect(result.toolCalls![0].id).toBe("toolu_1");
    expect(result.toolCalls![1].name).toBe("get_time");
    expect(result.toolCalls![1].arguments).toBe('{"tz":"EST"}');
    expect(result.toolCalls![1].id).toBe("toolu_2");
  });
});

describe("collapseCohereSSE multiple tool calls", () => {
  it("collapses 2 tool-call-start events at different indices", () => {
    const body = [
      `event: message-start`,
      `data: ${JSON.stringify({ type: "message-start", delta: { message: { role: "assistant" } } })}`,
      "",
      `event: tool-call-start`,
      `data: ${JSON.stringify({
        type: "tool-call-start",
        index: 0,
        delta: {
          message: {
            tool_calls: {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          },
        },
      })}`,
      "",
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        index: 0,
        delta: { message: { tool_calls: { function: { arguments: '{"city":"NYC"}' } } } },
      })}`,
      "",
      `event: tool-call-start`,
      `data: ${JSON.stringify({
        type: "tool-call-start",
        index: 1,
        delta: {
          message: {
            tool_calls: {
              id: "call_2",
              type: "function",
              function: { name: "get_time", arguments: "" },
            },
          },
        },
      })}`,
      "",
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        index: 1,
        delta: { message: { tool_calls: { function: { arguments: '{"tz":"EST"}' } } } },
      })}`,
      "",
      `event: message-end`,
      `data: ${JSON.stringify({ type: "message-end", delta: { finish_reason: "TOOL_CALL" } })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"NYC"}');
    expect(result.toolCalls![0].id).toBe("call_1");
    expect(result.toolCalls![1].name).toBe("get_time");
    expect(result.toolCalls![1].arguments).toBe('{"tz":"EST"}');
    expect(result.toolCalls![1].id).toBe("call_2");
  });
});

describe("collapseBedrockEventStream multiple tool calls", () => {
  it("collapses 2 contentBlockStart+contentBlockDelta pairs at different indices", () => {
    const startFrame0 = encodeEventStreamMessage("contentBlockStart", {
      contentBlockIndex: 0,
      contentBlockStart: {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: "tool_1", name: "get_weather" } },
      },
    });
    const deltaFrame0 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 0,
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { toolUse: { input: '{"city":"NYC"}' } },
      },
    });
    const startFrame1 = encodeEventStreamMessage("contentBlockStart", {
      contentBlockIndex: 1,
      contentBlockStart: {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: "tool_2", name: "get_time" } },
      },
    });
    const deltaFrame1 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 1,
      contentBlockDelta: {
        contentBlockIndex: 1,
        delta: { toolUse: { input: '{"tz":"EST"}' } },
      },
    });

    const buf = Buffer.concat([startFrame0, deltaFrame0, startFrame1, deltaFrame1]);
    const result = collapseBedrockEventStream(buf);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"NYC"}');
    expect(result.toolCalls![0].id).toBe("tool_1");
    expect(result.toolCalls![1].name).toBe("get_time");
    expect(result.toolCalls![1].arguments).toBe('{"tz":"EST"}');
    expect(result.toolCalls![1].id).toBe("tool_2");
  });
});

// ---------------------------------------------------------------------------
// Empty input: Ollama, Anthropic, Cohere
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Defensive branch coverage — OpenAI
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE defensive branches", () => {
  it("SSE block with no data: line is skipped", () => {
    const body = ["event: something", "", "data: [DONE]", ""].join("\n");
    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("");
  });

  it("empty choices array is skipped", () => {
    const body = [
      `data: ${JSON.stringify({ id: "c1", choices: [] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("");
  });

  it("tool call delta with no id — result toolCall has no id field", () => {
    const body = [
      `data: ${JSON.stringify({
        id: "c1",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: "function",
                  function: { name: "fn", arguments: '{"x":1}' },
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
    expect(result.toolCalls![0].name).toBe("fn");
    expect(result.toolCalls![0]).not.toHaveProperty("id");
  });

  it("droppedChunks returned alongside toolCalls", () => {
    const body = [
      `data: {BROKEN JSON`,
      "",
      `data: ${JSON.stringify({
        id: "c1",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "fn", arguments: '{"x":1}' },
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
    expect(result.droppedChunks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defensive branch coverage — Anthropic
// ---------------------------------------------------------------------------

describe("collapseAnthropicSSE defensive branches", () => {
  it("SSE block with no data: line is skipped", () => {
    const body = ["event: content_block_delta", ""].join("\n");
    const result = collapseAnthropicSSE(body);
    expect(result.content).toBe("");
  });

  it("tool_use content_block_start with no id — result has no id field", () => {
    const body = [
      `event: content_block_start`,
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "fn", input: {} },
      })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"x":1}' },
      })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("fn");
    expect(result.toolCalls![0]).not.toHaveProperty("id");
  });

  it("orphaned input_json_delta for unknown index — no crash, data ignored", () => {
    const body = [
      `event: content_block_delta`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 5,
        delta: { type: "input_json_delta", partial_json: '{"orphan":true}' },
      })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    // No tool calls created, no crash
    expect(result.content).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("droppedChunks returned alongside toolCalls", () => {
    const body = [
      `event: content_block_start`,
      `data: {BROKEN`,
      "",
      `event: content_block_start`,
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "fn", input: {} },
      })}`,
      "",
      `event: content_block_delta`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"x":1}' },
      })}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.droppedChunks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defensive branch coverage — Gemini
// ---------------------------------------------------------------------------

describe("collapseGeminiSSE defensive branches", () => {
  it("empty parts array is skipped", () => {
    const body = [`data: ${JSON.stringify({ candidates: [{ content: { parts: [] } }] })}`, ""].join(
      "\n",
    );

    const result = collapseGeminiSSE(body);
    expect(result.content).toBe("");
  });

  it("functionCall args as string — preserved as string", () => {
    const body = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "fn", args: "already-a-string" } }],
            },
            finishReason: "FUNCTION_CALL",
          },
        ],
      })}`,
      "",
    ].join("\n");

    const result = collapseGeminiSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].arguments).toBe("already-a-string");
  });
});

// ---------------------------------------------------------------------------
// Defensive branch coverage — Cohere
// ---------------------------------------------------------------------------

describe("collapseCohereSSE defensive branches", () => {
  it("SSE block with no data: line is skipped", () => {
    const body = ["event: content-delta", ""].join("\n");
    const result = collapseCohereSSE(body);
    expect(result.content).toBe("");
  });

  it("tool-call-start with no id — result has no id field", () => {
    const body = [
      `event: tool-call-start`,
      `data: ${JSON.stringify({
        type: "tool-call-start",
        index: 0,
        delta: {
          message: {
            tool_calls: {
              type: "function",
              function: { name: "fn", arguments: "" },
            },
          },
        },
      })}`,
      "",
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        index: 0,
        delta: { message: { tool_calls: { function: { arguments: '{"x":1}' } } } },
      })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("fn");
    expect(result.toolCalls![0]).not.toHaveProperty("id");
  });

  it("orphaned tool-call-delta for unknown index — no crash", () => {
    const body = [
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        index: 5,
        delta: { message: { tool_calls: { function: { arguments: '{"orphan":true}' } } } },
      })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.content).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("droppedChunks returned alongside toolCalls", () => {
    const body = [
      `event: tool-call-start`,
      `data: {BROKEN`,
      "",
      `event: tool-call-start`,
      `data: ${JSON.stringify({
        type: "tool-call-start",
        index: 0,
        delta: {
          message: {
            tool_calls: {
              id: "call_1",
              type: "function",
              function: { name: "fn", arguments: "" },
            },
          },
        },
      })}`,
      "",
      `event: tool-call-delta`,
      `data: ${JSON.stringify({
        type: "tool-call-delta",
        index: 0,
        delta: { message: { tool_calls: { function: { arguments: '{"x":1}' } } } },
      })}`,
      "",
    ].join("\n");

    const result = collapseCohereSSE(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.droppedChunks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defensive branch coverage — Bedrock
// ---------------------------------------------------------------------------

describe("collapseBedrockEventStream defensive branches", () => {
  it("contentBlockStart without toolUse — no tool entry created", () => {
    const startFrame = encodeEventStreamMessage("contentBlockStart", {
      contentBlockIndex: 0,
      contentBlockStart: {
        contentBlockIndex: 0,
        start: {},
      },
    });
    const deltaFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: { delta: { text: "Hello" } },
    });

    const buf = Buffer.concat([startFrame, deltaFrame]);
    const result = collapseBedrockEventStream(buf);
    expect(result.content).toBe("Hello");
    expect(result.toolCalls).toBeUndefined();
  });

  it("contentBlockDelta without delta — skipped", () => {
    const frame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 0,
      contentBlockDelta: {
        contentBlockIndex: 0,
      },
    });

    const buf = Buffer.from(frame);
    const result = collapseBedrockEventStream(buf);
    expect(result.content).toBe("");
  });

  it("tool call with no toolUseId — result has no id field", () => {
    const startFrame = encodeEventStreamMessage("contentBlockStart", {
      contentBlockIndex: 0,
      contentBlockStart: {
        contentBlockIndex: 0,
        start: {
          toolUse: { name: "fn" },
        },
      },
    });
    const deltaFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 0,
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { toolUse: { input: '{"x":1}' } },
      },
    });

    const buf = Buffer.concat([startFrame, deltaFrame]);
    const result = collapseBedrockEventStream(buf);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("fn");
    expect(result.toolCalls![0]).not.toHaveProperty("id");
  });

  it("orphaned toolUse delta for unknown index — no crash", () => {
    const deltaFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 5,
      contentBlockDelta: {
        contentBlockIndex: 5,
        delta: { toolUse: { input: '{"orphan":true}' } },
      },
    });

    const buf = Buffer.from(deltaFrame);
    const result = collapseBedrockEventStream(buf);
    // No tool entry for index 5, so delta is silently ignored
    expect(result.content).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("droppedChunks returned alongside toolCalls", () => {
    const startFrame = encodeEventStreamMessage("contentBlockStart", {
      contentBlockIndex: 0,
      contentBlockStart: {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: "tool_1", name: "fn" } },
      },
    });
    const deltaFrame = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 0,
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { toolUse: { input: '{"x":1}' } },
      },
    });

    // Build a frame with non-JSON payload for droppedChunks
    const badPayload = Buffer.from("NOT JSON", "utf8");
    const badFrame = encodeEventStreamFrame(
      {
        ":content-type": "application/json",
        ":event-type": "contentBlockDelta",
        ":message-type": "event",
      },
      badPayload,
    );

    const buf = Buffer.concat([badFrame, startFrame, deltaFrame]);
    const result = collapseBedrockEventStream(buf);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.droppedChunks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// collapseBedrockEventStream — Anthropic Messages format (invoke-with-response-stream)
// ---------------------------------------------------------------------------

describe("collapseBedrockEventStream — Anthropic Messages format", () => {
  it("collapses text from flat content_block_delta events", () => {
    const frame1 = encodeEventStreamMessage("chunk", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
    const frame2 = encodeEventStreamMessage("chunk", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    });
    const buf = Buffer.concat([frame1, frame2]);
    const result = collapseBedrockEventStream(buf);
    expect(result.content).toBe("Hello world");
  });

  it("collapses tool calls from flat content_block_start + input_json_delta", () => {
    const startFrame = encodeEventStreamMessage("chunk", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_123", name: "get_weather" },
    });
    const deltaFrame = encodeEventStreamMessage("chunk", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"city":"NYC"}' },
    });
    const buf = Buffer.concat([startFrame, deltaFrame]);
    const result = collapseBedrockEventStream(buf);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].id).toBe("toolu_123");
    expect(result.toolCalls![0].arguments).toBe('{"city":"NYC"}');
  });
});

// ---------------------------------------------------------------------------
// Defensive branch coverage — Ollama
// ---------------------------------------------------------------------------

describe("collapseOllamaNDJSON defensive branches", () => {
  it("line with neither message.content nor response — no content added", () => {
    const body = [JSON.stringify({ model: "x", done: true })].join("\n");

    const result = collapseOllamaNDJSON(body);
    expect(result.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Original empty input tests
// ---------------------------------------------------------------------------

describe("empty input collapse", () => {
  it('collapseOllamaNDJSON("") returns { content: "" }', () => {
    const result = collapseOllamaNDJSON("");
    expect(result.content).toBe("");
  });

  it('collapseAnthropicSSE("") returns { content: "" }', () => {
    const result = collapseAnthropicSSE("");
    expect(result.content).toBe("");
  });

  it('collapseCohereSSE("") returns { content: "" }', () => {
    const result = collapseCohereSSE("");
    expect(result.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// collapseOllamaNDJSON with tool_calls in stream chunks
// ---------------------------------------------------------------------------

describe("collapseOllamaNDJSON with tool_calls", () => {
  it("extracts tool_calls from /api/chat chunks", () => {
    const body = [
      JSON.stringify({
        model: "llama3",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "get_weather",
                arguments: { city: "SF" },
              },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "" },
        done: true,
      }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);
    // toolCalls takes priority over content when present
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"SF"}');
    expect(result.content).toBeUndefined();
  });

  it("preserves both content and toolCalls when both tool_calls and text are present", () => {
    const body = [
      JSON.stringify({
        model: "llama3",
        message: {
          role: "assistant",
          content: "Let me check ",
          tool_calls: [
            {
              function: {
                name: "get_weather",
                arguments: { city: "SF" },
              },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "the weather." },
        done: true,
      }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);
    // When toolCalls are present alongside content, both are preserved
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.content).toBe("Let me check the weather.");
  });

  it("extracts multiple tool_calls across chunks", () => {
    const body = [
      JSON.stringify({
        model: "llama3",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "get_weather",
                arguments: '{"city":"SF"}',
              },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({
        model: "llama3",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "get_time",
                arguments: '{"tz":"PST"}',
              },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "" },
        done: true,
      }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"SF"}');
    expect(result.toolCalls![1].name).toBe("get_time");
    expect(result.toolCalls![1].arguments).toBe('{"tz":"PST"}');
  });
});

// ---------------------------------------------------------------------------
// decodeEventStreamFrames bounds check (totalLength > buf.length)
// ---------------------------------------------------------------------------

describe("decodeEventStreamFrames bounds check", () => {
  it("returns truncated when totalLength exceeds buffer size", () => {
    // Build a 20-byte buffer where totalLength field is set to 9999
    const buf = Buffer.alloc(20, 0);
    buf.writeUInt32BE(9999, 0); // totalLength = 9999 (far beyond buffer size)
    buf.writeUInt32BE(0, 4); // headersLength = 0
    // Leave CRC bytes as 0 — bounds check fires before CRC check
    const result = collapseBedrockEventStream(buf);
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collapseStreamingResponse: bedrock SSE case
// ---------------------------------------------------------------------------

describe("collapseStreamingResponse bedrock SSE", () => {
  it('dispatches text/event-stream with "bedrock" to Anthropic SSE collapse', () => {
    const body = [
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bedrock-sse" } })}`,
      "",
    ].join("\n");
    const result = collapseStreamingResponse("text/event-stream", "bedrock", body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("bedrock-sse");
  });
});

// ---------------------------------------------------------------------------
// Reasoning and web search collapse
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE with reasoning", () => {
  it("extracts reasoning from Responses API reasoning_summary_text.delta events", () => {
    const body = [
      `data: ${JSON.stringify({ type: "response.created", response: {} })}`,
      "",
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "Let me " })}`,
      "",
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "think." })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Answer" })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: {} })}`,
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("Answer");
    expect(result.reasoning).toBe("Let me think.");
  });

  it("extracts web searches from Responses API output_item.done events", () => {
    const body = [
      `data: ${JSON.stringify({ type: "response.created", response: {} })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "web_search_call", status: "completed", action: { query: "test query" } },
      })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "web_search_call", status: "completed", action: { query: "another query" } },
      })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Result" })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: {} })}`,
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("Result");
    expect(result.webSearches).toEqual(["test query", "another query"]);
  });

  it("returns undefined reasoning and webSearches when not present", () => {
    const body = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Plain" })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: {} })}`,
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("Plain");
    expect(result.reasoning).toBeUndefined();
    expect(result.webSearches).toBeUndefined();
  });
});

describe("collapseAnthropicSSE with thinking", () => {
  it("extracts reasoning from thinking_delta events", () => {
    const body = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "thinking" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "thinking_delta", thinking: "Hmm " } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "thinking_delta", thinking: "interesting" } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "text_delta", text: "Answer" } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.content).toBe("Answer");
    expect(result.reasoning).toBe("Hmm interesting");
  });

  it("returns undefined reasoning when no thinking blocks", () => {
    const body = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Plain" } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    const result = collapseAnthropicSSE(body);
    expect(result.content).toBe("Plain");
    expect(result.reasoning).toBeUndefined();
  });
});

describe("collapseOpenAISSE with chat completions reasoning_content", () => {
  it("extracts reasoning from reasoning_content delta fields", () => {
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { reasoning_content: "Let me " } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { reasoning_content: "think." } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "Answer" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("Answer");
    expect(result.reasoning).toBe("Let me think.");
  });

  it("handles reasoning_content without regular content", () => {
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-2", choices: [{ delta: { reasoning_content: "Thinking only" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.reasoning).toBe("Thinking only");
    expect(result.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// collapseOpenAISSE — OpenAI harmony channel tokens (open-weight gpt-oss)
//
// Open-weight gpt-oss models served via Ollama / vLLM / OpenRouter stream
// tool calls as RAW harmony channel tokens inside `delta.content`, not in
// `delta.tool_calls`. aimock must parse those channels so the recorded
// fixture captures a structured tool call instead of leaking the raw
// `to=functions...` marker as plain text content.
//
// Harmony grammar (authoritative, from OpenAI's harmony spec):
//   <|channel|>analysis<|message|>...<|end|>            -> reasoning
//   <|start|>assistant<|channel|>commentary to=functions.NAME
//     <|constrain|>json<|message|>{...args...}<|call|>  -> tool call
//   <|channel|>final<|message|>...<|return|>            -> content
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE harmony channel tokens", () => {
  it("parses a harmony tool call streamed as raw tokens inside delta.content", () => {
    // The canonical harmony sequence, chunked across SSE deltas like a real
    // open-weight stream would emit it (token boundaries fall mid-marker).
    const harmonyChunks = [
      "<|channel|>analysis<|message|>Need to call the ",
      "tool to render the card.<|end|>",
      "<|start|>assistant<|channel|>commentary to=functions.generate_a2ui ",
      '<|constrain|>json<|message|>{"component":"card",',
      '"props":{"title":"Hi"}}<|call|>',
    ];

    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-harm", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    // Desired end state: a structured tool call is emitted...
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("generate_a2ui");
    expect(result.toolCalls![0].arguments).toBe('{"component":"card","props":{"title":"Hi"}}');

    // ...the analysis channel becomes reasoning...
    expect(result.reasoning).toBe("Need to call the tool to render the card.");

    // ...and NO harmony control tokens or routing markers leak into content.
    const leak = result.content ?? "";
    expect(leak).not.toContain("<|channel|>");
    expect(leak).not.toContain("<|message|>");
    expect(leak).not.toContain("<|constrain|>");
    expect(leak).not.toContain("<|call|>");
    expect(leak).not.toContain("to=generate_a2ui");
    expect(leak).not.toContain("to=functions.generate_a2ui");
    expect(leak).not.toContain("functions.generate_a2ui");
  });

  it("captures the final channel as content and analysis as reasoning", () => {
    const harmonyChunks = [
      "<|channel|>analysis<|message|>The user said hello.<|end|>",
      "<|start|>assistant<|channel|>final<|message|>Hello! How can ",
      "I help you today?<|return|>",
    ];

    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-harm2", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.content).toBe("Hello! How can I help you today?");
    expect(result.reasoning).toBe("The user said hello.");
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).not.toContain("<|channel|>");
    expect(result.content).not.toContain("<|return|>");
  });

  it("parses multiple interleaved harmony tool calls", () => {
    const harmonyChunks = [
      "<|channel|>analysis<|message|>Call two tools.<|end|>",
      "<|start|>assistant<|channel|>commentary to=functions.first ",
      '<|constrain|>json<|message|>{"a":1}<|call|>',
      "<|start|>assistant<|channel|>commentary to=functions.second ",
      '<|constrain|>json<|message|>{"b":2}<|call|>',
    ];

    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-harm3", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].name).toBe("first");
    expect(result.toolCalls![0].arguments).toBe('{"a":1}');
    expect(result.toolCalls![1].name).toBe("second");
    expect(result.toolCalls![1].arguments).toBe('{"b":2}');
    expect(result.content ?? "").not.toContain("functions.first");
  });

  it("is a no-op for normal (non-harmony) structured streams", () => {
    // A plain text stream with no harmony control tokens must be untouched.
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-plain", choices: [{ delta: { content: "Just " } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-plain", choices: [{ delta: { content: "text." } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("Just text.");
    expect(result.toolCalls).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collapseOpenAISSE harmony channel — fail-safe, token-aware, observable
//
// Regression coverage for the CR findings on the harmony parser. The shared
// root cause was a naive indexOf-scan over detokenized text that could
// DESTROY valid hosted-OpenAI answers (mere prose mention of a token),
// TRUNCATE tool-call JSON containing a literal token substring, DROP
// pre-channel / trailing-message text, and MISROUTE analysis-channel
// recipients into tool calls — all silently. The fix makes parsing fail-safe
// (return original content on any incomplete/invalid structure), terminate
// json bodies at their spec terminator with JSON validation, anchor
// pre/trailing text, gate recipient routing to the commentary channel, and
// surface drops/truncations via droppedChunks/truncated.
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE harmony fail-safe + token-aware", () => {
  // A1 — content destruction: a hosted/structured answer that merely MENTIONS
  // the token must NOT be mangled into empty content.
  it("preserves a final answer that merely mentions <|channel|> as prose (no destruction)", () => {
    const prose = "The special token is <|channel|> and it routes model output to channels.";
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-prose", choices: [{ delta: { content: prose } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    // The whole answer must survive verbatim — never collapsed to "".
    expect(result.content).toBe(prose);
    expect(result.toolCalls).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
  });

  // A1 — explicit no-op guard: a genuinely structured tool_calls stream whose
  // text content happens to mention the token must keep its content verbatim
  // and fabricate NO harmony tool calls / reasoning.
  it("is a no-op for a structured tool_calls stream whose content mentions <|channel|> as prose", () => {
    const prose = "I will call a tool. Note: <|channel|> is a harmony marker.";
    const body = [
      `data: ${JSON.stringify({
        id: "chatcmpl-struct",
        choices: [
          {
            delta: {
              content: prose,
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "get_weather", arguments: '{"city":"SF"}' },
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

    // Content preserved verbatim; only the genuine structured tool call present.
    expect(result.content).toBe(prose);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"SF"}');
  });

  // A2 — body termination: tool-call args JSON containing a literal token
  // substring must NOT be truncated to invalid JSON.
  it("does not truncate tool-call args JSON containing a literal token substring", () => {
    // The args contain the text "<|call|>" inside a JSON string value — the
    // body must run to the REAL <|call|> terminator, not the embedded one.
    const harmonyChunks = [
      "<|start|>assistant<|channel|>commentary to=functions.say ",
      '<|constrain|>json<|message|>{"text":"say <|call|> now"}<|call|>',
    ];
    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-emb", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("say");
    // Args must be the COMPLETE, valid JSON — not cut at the embedded token.
    expect(result.toolCalls![0].arguments).toBe('{"text":"say <|call|> now"}');
    expect(() => JSON.parse(result.toolCalls![0].arguments)).not.toThrow();
  });

  // A2 — channel/start must not truncate an open json body.
  it("does not let <|channel|> inside tool-call args truncate the JSON body", () => {
    const harmonyChunks = [
      "<|start|>assistant<|channel|>commentary to=functions.render ",
      '<|constrain|>json<|message|>{"markup":"<|channel|> tag in a2ui"}<|call|>',
    ];
    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-emb2", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].arguments).toBe('{"markup":"<|channel|> tag in a2ui"}');
    expect(() => JSON.parse(result.toolCalls![0].arguments)).not.toThrow();
  });

  // A3 — anchoring: text BEFORE the first <|channel|> must be captured.
  it("captures pre-channel text as content", () => {
    const harmonyChunks = [
      "Here is a preamble. ",
      "<|channel|>final<|message|>The answer.<|return|>",
    ];
    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-pre", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.content).toBe("Here is a preamble. The answer.");
    expect(result.content).not.toContain("<|channel|>");
  });

  // A3 — anchoring: a trailing <|start|>assistant<|message|> message that has
  // NO <|channel|> (final-answer-after-tool-call) must be captured.
  it("captures a trailing <|start|>...<|message|> final message that lacks <|channel|>", () => {
    const harmonyChunks = [
      "<|start|>assistant<|channel|>commentary to=functions.lookup ",
      '<|constrain|>json<|message|>{"q":"weather"}<|call|>',
      "<|start|>assistant<|message|>The weather is sunny.<|return|>",
    ];
    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-trail", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("lookup");
    expect(result.content).toBe("The weather is sunny.");
    expect(result.content).not.toContain("<|start|>");
    expect(result.content).not.toContain("<|message|>");
  });

  // A5 — recipient routing: recipient on the ROLE line (before <|channel|>)
  // must be recognized as a commentary tool call.
  it("recognizes a recipient placed on the role segment before <|channel|>", () => {
    const harmonyChunks = [
      "<|start|>assistant to=functions.role_placed<|channel|>commentary ",
      '<|constrain|>json<|message|>{"x":1}<|call|>',
    ];
    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-role", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("role_placed");
    expect(result.toolCalls![0].arguments).toBe('{"x":1}');
  });

  // A5 — recipient routing: an analysis-channel header carrying a recipient
  // must NOT be misrouted into a tool call (only commentary routes).
  it("does not route an analysis-channel recipient into a tool call", () => {
    const harmonyChunks = [
      "<|channel|>analysis to=functions.should_not_fire<|message|>Thinking about it.<|end|>",
      "<|start|>assistant<|channel|>final<|message|>Done.<|return|>",
    ];
    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-an", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    // No tool call fabricated from the analysis channel.
    expect(result.toolCalls).toBeUndefined();
    expect(result.reasoning).toBe("Thinking about it.");
    expect(result.content).toBe("Done.");
  });

  // A2/A5 edge: a <|constrain|>json marker on a NON-tool channel (no
  // commentary recipient) must NOT trigger <|call|>-terminated parsing and
  // swallow the following final message — it ends at its own <|end|>.
  it("does not let a non-tool-call <|constrain|>json body swallow the next message", () => {
    const harmonyChunks = [
      "<|channel|>analysis<|constrain|>json<|message|>Thinking.<|end|>",
      "<|start|>assistant<|channel|>final<|message|>The final answer.<|return|>",
    ];
    const body = [
      ...harmonyChunks.flatMap((chunk) => [
        `data: ${JSON.stringify({ id: "chatcmpl-cj", choices: [{ delta: { content: chunk } }] })}`,
        "",
      ]),
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.reasoning).toBe("Thinking.");
    expect(result.content).toBe("The final answer.");
    expect(result.toolCalls).toBeUndefined();
  });

  // A6 — observability: a malformed harmony structure must fail SAFE (content
  // preserved VERBATIM). Because the bytes are NOT lost, this is NOT transport
  // loss: it surfaces via the distinct `harmonyUnparsed` signal, NOT
  // droppedChunks/truncated (those are reserved for genuine transport loss).
  it("surfaces a malformed harmony structure via harmonyUnparsed (not droppedChunks/truncated)", () => {
    // A <|channel|> + <|message|> opener whose tool-call body never yields
    // valid JSON (no terminator, no closing brace) — unparseable.
    const broken =
      "<|start|>assistant<|channel|>commentary to=functions.broken<|constrain|>json<|message|>{not valid json";
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-broken", choices: [{ delta: { content: broken } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    // Fail-safe: original content preserved verbatim, no fabricated/empty loss.
    expect(result.content).toBe(broken);
    expect(result.toolCalls).toBeUndefined();
    // Distinct signal — NOT a dropped/truncated chunk.
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collapseOpenAISSE — A4: reasoning + webSearches parity on the tool-call
// return branch (non-harmony structured streams).
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE reasoning/webSearches parity with tool calls", () => {
  // A4 — a NON-harmony structured stream with delta.reasoning_content +
  // tool_calls must preserve reasoning (DeepSeek / OpenRouter shape).
  it("preserves reasoning_content alongside structured tool_calls (no harmony)", () => {
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-r", choices: [{ delta: { reasoning_content: "Let me think. " } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-r", choices: [{ delta: { reasoning_content: "I will call a tool." } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-r", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    // reasoning must survive even though this is NOT a harmony stream.
    expect(result.reasoning).toBe("Let me think. I will call a tool.");
  });

  // A4 — webSearches parity: a Responses-API web_search_call followed by a
  // tool call must surface webSearches on the tool-call return branch too.
  it("preserves webSearches alongside tool calls", () => {
    const body = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "web_search_call", action: { query: "weather SF" } } })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-ws", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_w", function: { name: "get_weather", arguments: "{}" } }] } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.webSearches).toEqual(["weather SF"]);
  });
});

// ---------------------------------------------------------------------------
// collapseOllamaNDJSON — A7: harmony parsing parity for gpt-oss over Ollama
// (NDJSON). gpt-oss served via Ollama streams harmony tokens inside
// message.content; without parsing they leak as raw text.
// ---------------------------------------------------------------------------

describe("collapseOllamaNDJSON harmony channel tokens", () => {
  it("parses a harmony tool call streamed as raw tokens inside message.content", () => {
    const harmonyChunks = [
      "<|channel|>analysis<|message|>Need to render a card.<|end|>",
      "<|start|>assistant<|channel|>commentary to=functions.generate_a2ui ",
      '<|constrain|>json<|message|>{"component":"card","props":{"title":"Hi"}}<|call|>',
    ];
    const body = [
      ...harmonyChunks.map((chunk) =>
        JSON.stringify({
          model: "gpt-oss",
          message: { role: "assistant", content: chunk },
          done: false,
        }),
      ),
      JSON.stringify({ model: "gpt-oss", message: { role: "assistant", content: "" }, done: true }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("generate_a2ui");
    expect(result.toolCalls![0].arguments).toBe('{"component":"card","props":{"title":"Hi"}}');
    expect(result.reasoning).toBe("Need to render a card.");
    const leak = result.content ?? "";
    expect(leak).not.toContain("<|channel|>");
    expect(leak).not.toContain("to=functions.generate_a2ui");
  });

  it("is a no-op for normal (non-harmony) Ollama content", () => {
    const body = [
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "Just " },
        done: false,
      }),
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "text." },
        done: true,
      }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);
    expect(result.content).toBe("Just text.");
    expect(result.toolCalls).toBeUndefined();
  });

  // A7 — pre-existing bug: JSON.stringify(undefined arguments) yields the
  // literal string "undefined". Must default to "{}".
  it("defaults arguments to {} when a structured tool_call omits arguments", () => {
    const body = [
      JSON.stringify({
        model: "llama3",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "no_args" } }],
        },
        done: false,
      }),
      JSON.stringify({ model: "llama3", message: { role: "assistant", content: "" }, done: true }),
    ].join("\n");

    const result = collapseOllamaNDJSON(body);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("no_args");
    expect(result.toolCalls![0].arguments).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// collapseOpenAISSE — multibyte content across SSE event boundaries
//
// collapseOpenAISSE receives the FULL concatenated response body (decoded
// once from the complete buffer at the recorder layer), so multibyte UTF-8
// in delta.content is already safe regardless of how deltas were chunked.
// This test pins that guarantee: CJK + emoji split across deltas must
// round-trip with no U+FFFD replacement characters.
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE multibyte content", () => {
  it("preserves CJK and emoji content chunked across SSE events", () => {
    const body = [
      `data: ${JSON.stringify({ id: "chatcmpl-mb", choices: [{ delta: { content: "访问 " } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-mb", choices: [{ delta: { content: "官网群" } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "chatcmpl-mb", choices: [{ delta: { content: " 🎉" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.content).toBe("访问 官网群 🎉");
    expect(result.content).not.toContain("�");
  });
});

// ===========================================================================
// Harmony lexer + state-machine rewrite — STRUCTURAL acceptance matrix
//
// The harmony parser is a two-phase lexer + state machine (src/harmony.ts):
//   Phase 1 lexes the accumulated content into an ordered CONTROL/TEXT token
//   stream (bytes consumed into a TEXT span are never re-scanned for control
//   tokens); Phase 2 walks the stream against the harmony grammar with UNIFORM
//   all-or-nothing fail-safe semantics.
//
// Contract under test:
//   - GATE / FAIL-SAFE: any grammar deviation returns the ORIGINAL raw input
//     verbatim with no toolCalls/reasoning.
//   - OBSERVABILITY: a harmony failure preserves bytes verbatim, so it is NOT
//     transport loss — it sets `harmonyUnparsed`, never droppedChunks/truncated.
//   - WHITESPACE: inter-message / trailing whitespace-only TEXT is absorbed.
//   - NON-TOOL EMBEDDED TOKENS: literal token substrings inside a body do not
//     truncate it; the body runs to its real terminator.
//   - FALLBACK-ONLY wiring: harmony is attempted ONLY when there are no
//     structured delta.tool_calls; structured calls always win and harmony
//     content is then treated as prose (no phantom, no truncated stamp).
//   - ROUTING: analysis->reasoning, final->content, commentary+recipient->tool,
//     commentary-without-recipient->content. Recipient identifiers only.
// ===========================================================================

/** Build an OpenAI SSE body from a list of delta objects (matches idioms). */
function openAISSEBody(deltas: Array<Record<string, unknown>>, id = "chatcmpl-mtx"): string {
  return [
    ...deltas.flatMap((delta) => [`data: ${JSON.stringify({ id, choices: [{ delta }] })}`, ""]),
    "data: [DONE]",
    "",
  ].join("\n");
}

/** Build an OpenAI SSE body whose content chunks carry harmony tokens. */
function openAIHarmonyBody(chunks: string[], id = "chatcmpl-mtx"): string {
  return openAISSEBody(
    chunks.map((content) => ({ content })),
    id,
  );
}

/** Build an Ollama /api/chat NDJSON body whose message.content carries chunks. */
function ollamaHarmonyBody(chunks: string[], model = "gpt-oss"): string {
  return [
    ...chunks.map((content) =>
      JSON.stringify({ model, message: { role: "assistant", content }, done: false }),
    ),
    JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true }),
  ].join("\n");
}

describe("harmony rewrite — GATE / FAIL-SAFE (verbatim no-op on non-structure)", () => {
  // (1)* prose mentioning <|channel|>/<|message|> as inline code -> content
  // VERBATIM, no toolCalls/reasoning, no truncated/droppedChunks.
  it("(1) prose mentioning the tokens is content verbatim (no destruction)", () => {
    const prose =
      "Harmony uses `<|channel|>` to pick a channel and `<|message|>` to start the body";
    const result = collapseOpenAISSE(openAIHarmonyBody([prose]));
    expect(result.content).toBe(prose);
    expect(result.toolCalls).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(result.droppedChunks ?? 0).toBe(0);

    // Direct parser unit check: a prose-only mention has no Message -> failed.
    const direct = parseHarmonyContent(prose);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(prose);
    expect(direct.toolCalls).toEqual([]);
    expect(direct.reasoning).toBe("");
  });

  // (2) tokens in reverse order -> verbatim no-op. The cheap `isHarmonyContent`
  // gate requires channel-then-message (or start-then-message) ordering, so a
  // reversed stream does not even trip the gate: the collapse path leaves the
  // content verbatim and never sets harmonyUnparsed. The parser itself, when
  // called directly, still fails-safe on the reversed structure.
  it("(2) reversed token order is a verbatim no-op", () => {
    const reversed = "<|message|>body<|channel|>analysis";
    const result = collapseOpenAISSE(openAIHarmonyBody([reversed]));
    expect(result.content).toBe(reversed);
    expect(result.toolCalls).toBeUndefined();
    expect(result.harmonyUnparsed).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(result.droppedChunks ?? 0).toBe(0);

    const direct = parseHarmonyContent(reversed);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(reversed);
  });

  // (3) prose containing every literal token but no valid Message -> verbatim,
  // accurate harmonyUnparsed signal.
  it("(3) every literal token but no valid message -> verbatim + harmonyUnparsed", () => {
    const prose =
      "tokens: <|start|> <|end|> <|return|> <|call|> <|channel|> <|message|> <|constrain|> (all as prose)";
    const result = collapseOpenAISSE(openAIHarmonyBody([prose]));
    expect(result.content).toBe(prose);
    expect(result.toolCalls).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  // (4) empty / whitespace-only -> unchanged no-op.
  it("(4) empty and whitespace-only inputs are unchanged no-ops", () => {
    const empty = collapseOpenAISSE(openAIHarmonyBody([""]));
    expect(empty.content).toBe("");
    expect(empty.toolCalls).toBeUndefined();
    expect(empty.harmonyUnparsed).toBeUndefined();

    const ws = collapseOpenAISSE(openAIHarmonyBody(["   \n  "]));
    expect(ws.content).toBe("   \n  ");
    expect(ws.toolCalls).toBeUndefined();
    expect(ws.harmonyUnparsed).toBeUndefined();

    // Direct: empty/whitespace are not harmony at all; parser returns failed
    // (no message) with content preserved.
    expect(parseHarmonyContent("").content).toBe("");
    expect(parseHarmonyContent("   ").content).toBe("   ");
  });
});

describe("harmony rewrite — WHITESPACE (the masked class)", () => {
  // (5)* analysis<|end|> + "\n" + <|start|>...final<|return|> -> reasoning +
  // content parsed, no leak of the inter-message newline.
  it("(5) newline between analysis<|end|> and the next <|start|> is absorbed", () => {
    const chunks = [
      "<|channel|>analysis<|message|>Thinking it through.<|end|>",
      "\n",
      "<|start|>assistant<|channel|>final<|message|>The answer.<|return|>",
    ];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.reasoning).toBe("Thinking it through.");
    expect(result.content).toBe("The answer.");
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).not.toContain("\n");
    expect(result.content).not.toContain("<|");
  });

  // (6) single space between two commentary tool calls -> 2 toolCalls.
  it("(6) a single space between two commentary tool calls yields 2 tool calls", () => {
    const chunks = [
      '<|start|>assistant<|channel|>commentary to=functions.first <|constrain|>json<|message|>{"a":1}<|call|>',
      " ",
      '<|start|>assistant<|channel|>commentary to=functions.second <|constrain|>json<|message|>{"b":2}<|call|>',
    ];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0]).toEqual({ name: "first", arguments: '{"a":1}' });
    expect(result.toolCalls![1]).toEqual({ name: "second", arguments: '{"b":2}' });
  });

  // (7)* trailing "\n" after the final <|return|> -> parsed, newline absorbed.
  it("(7) trailing newline after the final <|return|> is absorbed, not leaked", () => {
    const chunks = ["<|channel|>final<|message|>All done.<|return|>", "\n"];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.content).toBe("All done.");
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).not.toContain("\n");

    const direct = parseHarmonyContent("<|channel|>final<|message|>All done.<|return|>\n");
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe("All done.");
  });

  // (8) leading whitespace before the first <|channel|> -> absorbed (blank
  // leading text is not content).
  it("(8) leading whitespace before the first <|channel|> is absorbed", () => {
    const direct = parseHarmonyContent("  \n <|channel|>final<|message|>Hi.<|return|>");
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe("Hi.");
    expect(direct.reasoning).toBe("");
  });

  // (9) mixed " \n " between three messages -> all parsed.
  it("(9) mixed whitespace between three messages is absorbed; all parse", () => {
    const chunks = [
      "<|channel|>analysis<|message|>Reason.<|end|>",
      " \n ",
      '<|start|>assistant<|channel|>commentary to=functions.tool <|constrain|>json<|message|>{"k":1}<|call|>',
      "  ",
      "<|start|>assistant<|channel|>final<|message|>Answer.<|return|>",
    ];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.reasoning).toBe("Reason.");
    expect(result.content).toBe("Answer.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({ name: "tool", arguments: '{"k":1}' });
  });
});

describe("harmony rewrite — NON-TOOL EMBEDDED TOKENS", () => {
  // (10)* final body quoting <|end|>/<|return|> as prose, terminated by a real
  // <|return|> -> content = full sentence (NOT truncated to "See ").
  it("(10) final body quoting <|end|>/<|return|> keeps the full sentence", () => {
    const body = "See `<|end|>` for the end token and `<|return|>` too.";
    const raw = `<|channel|>final<|message|>${body}<|return|>`;
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe(body);
    expect(direct.toolCalls).toEqual([]);

    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(body);
    expect(result.toolCalls).toBeUndefined();
  });

  // (11) analysis body quoting <|call|>/<|start|> as prose, terminated by
  // <|end|> -> reasoning = full body.
  it("(11) analysis body quoting <|call|>/<|start|> keeps the full body", () => {
    const body = "Consider the `<|call|>` and `<|start|>` markers carefully.";
    const raw = `<|channel|>analysis<|message|>${body}<|end|><|start|>assistant<|channel|>final<|message|>Done.<|return|>`;
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.reasoning).toBe(body);
    expect(direct.content).toBe("Done.");
  });

  // (12) commentary-preamble (no recipient) body quoting <|end|> -> content,
  // full body.
  it("(12) commentary preamble (no recipient) quoting <|end|> keeps full content", () => {
    const body = "Let me explain `<|end|>` before answering.";
    const raw = `<|channel|>commentary<|message|>${body}<|end|><|start|>assistant<|channel|>final<|message|>Answer.<|return|>`;
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe(`${body}Answer.`);
    expect(direct.toolCalls).toEqual([]);
  });
});

describe("harmony rewrite — TOOL BODY (keep green)", () => {
  // (13) args {"text":"say <|call|> now"}<|call|> -> 1 toolCall, exact args.
  it("(13) embedded <|call|> inside tool args does not truncate the JSON", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.say<|constrain|>json<|message|>{"text":"say <|call|> now"}<|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toHaveLength(1);
    expect(direct.toolCalls[0]).toEqual({
      name: "say",
      arguments: '{"text":"say <|call|> now"}',
    });
    expect(() => JSON.parse(direct.toolCalls[0].arguments)).not.toThrow();
  });

  // (14) args containing <|channel|>/<|message|> substrings -> exact args.
  it("(14) embedded <|channel|>/<|message|> inside tool args are preserved exactly", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.render<|constrain|>json<|message|>{"markup":"<|channel|> and <|message|> tags"}<|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toHaveLength(1);
    expect(direct.toolCalls[0].arguments).toBe('{"markup":"<|channel|> and <|message|> tags"}');
    expect(() => JSON.parse(direct.toolCalls[0].arguments)).not.toThrow();
  });

  // (15) args invalid JSON, no terminator -> fail-safe verbatim + signal.
  it("(15) invalid-JSON tool body with no terminator fails safe", () => {
    const raw =
      "<|start|>assistant<|channel|>commentary to=functions.broken<|constrain|>json<|message|>{not valid json";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.toolCalls).toEqual([]);

    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  // (16) args valid JSON but terminated by <|end|> not <|call|> -> fail-safe.
  it("(16) valid-JSON tool body terminated by <|end|> (not <|call|>) fails safe", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.x<|constrain|>json<|message|>{"a":1}<|end|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.toolCalls).toEqual([]);
  });
});

describe("harmony rewrite — DUAL-SOURCE (fallback-only wiring)", () => {
  // (17)* structured delta.tool_calls + content prose mentioning tokens ->
  // content verbatim, exactly the structured toolCall(s), NO phantom, NO
  // truncated/droppedChunks.
  it("(17) structured tool_calls + prose mentioning tokens: only structured call, content verbatim", () => {
    const prose = "I will call a tool. Note `<|channel|>` and `<|message|>` are harmony markers.";
    const body = openAISSEBody([
      {
        content: prose,
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
        ],
      },
    ]);
    const result = collapseOpenAISSE(body);
    expect(result.content).toBe(prose);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.toolCalls![0].arguments).toBe('{"city":"SF"}');
    expect(result.truncated).toBeUndefined();
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.harmonyUnparsed).toBeUndefined();
  });

  // (18) structured tool_calls + content that IS well-formed harmony tool
  // tokens -> only structured calls win (fallback-only), count == structured.
  it("(18) structured tool_calls win over well-formed harmony content (fallback-only)", () => {
    const harmony =
      '<|start|>assistant<|channel|>commentary to=functions.harmony_tool<|constrain|>json<|message|>{"z":9}<|call|>';
    const body = openAISSEBody([
      {
        content: harmony,
        tool_calls: [
          { index: 0, id: "call_s", function: { name: "structured_tool", arguments: '{"s":1}' } },
        ],
      },
    ]);
    const result = collapseOpenAISSE(body);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("structured_tool");
    // The harmony content is treated as prose (never parsed into a 2nd call).
    expect(result.toolCalls!.some((tc) => tc.name === "harmony_tool")).toBe(false);
  });

  // (19) structured tool_calls + harmony-looking content that would FAIL to
  // parse -> no truncated stamp (content is prose, not a harmony failure).
  it("(19) structured tool_calls + unparseable harmony content: no truncated stamp", () => {
    const broken =
      "<|start|>assistant<|channel|>commentary to=functions.broken<|message|>{not valid";
    const body = openAISSEBody([
      {
        content: broken,
        tool_calls: [
          { index: 0, id: "call_s", function: { name: "structured_tool", arguments: "{}" } },
        ],
      },
    ]);
    const result = collapseOpenAISSE(body);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("structured_tool");
    expect(result.truncated).toBeUndefined();
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.harmonyUnparsed).toBeUndefined();
    // Content is preserved as-is (prose), never collapsed.
    expect(result.content).toBe(broken);
  });
});

describe("harmony rewrite — MULTI-MESSAGE REALISTIC", () => {
  // (20) analysis->reasoning, "\n", commentary toolCall, "\n", final->content.
  it("(20) analysis + commentary tool + final with separators: all correct, zero leak", () => {
    const chunks = [
      "<|channel|>analysis<|message|>Plan the call.<|end|>",
      "\n",
      '<|start|>assistant<|channel|>commentary to=functions.lookup<|constrain|>json<|message|>{"q":"x"}<|call|>',
      "\n",
      "<|start|>assistant<|channel|>final<|message|>Here is the result.<|return|>",
    ];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.reasoning).toBe("Plan the call.");
    expect(result.content).toBe("Here is the result.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({ name: "lookup", arguments: '{"q":"x"}' });
    expect(result.content).not.toContain("<|");
    expect(result.content).not.toContain("\n");
  });

  // (21) analysis + final only with separators (no tool) -> reasoning+content.
  it("(21) analysis + final only (no tool) -> reasoning + content, no toolCalls", () => {
    const chunks = [
      "<|channel|>analysis<|message|>Just reasoning.<|end|>",
      " \n ",
      "<|start|>assistant<|channel|>final<|message|>Just the answer.<|return|>",
    ];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.reasoning).toBe("Just reasoning.");
    expect(result.content).toBe("Just the answer.");
    expect(result.toolCalls).toBeUndefined();
  });

  // (22) commentary preamble + commentary toolCall -> preamble->content, 1 call.
  it("(22) commentary preamble + commentary tool call: preamble is content, 1 tool call", () => {
    const chunks = [
      "<|channel|>commentary<|message|>Let me look that up for you.<|end|>",
      '<|start|>assistant<|channel|>commentary to=functions.lookup<|constrain|>json<|message|>{"q":"y"}<|call|>',
    ];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.content).toBe("Let me look that up for you.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({ name: "lookup", arguments: '{"q":"y"}' });
  });
});

describe("harmony rewrite — ROUTING EDGES (keep green)", () => {
  // (23) analysis header carrying to=functions.x -> NOT a tool call.
  it("(23) analysis-channel recipient is NOT a tool call (reasoning only)", () => {
    const chunks = [
      "<|channel|>analysis to=functions.should_not_fire<|message|>Thinking.<|end|>",
      "<|start|>assistant<|channel|>final<|message|>Done.<|return|>",
    ];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.toolCalls).toBeUndefined();
    expect(result.reasoning).toBe("Thinking.");
    expect(result.content).toBe("Done.");
  });

  // (24) recipient on the role segment before <|channel|>commentary -> toolCall.
  it("(24) recipient on the role segment before <|channel|>commentary -> tool call", () => {
    const raw =
      '<|start|>assistant to=functions.role_placed<|channel|>commentary<|constrain|>json<|message|>{"x":1}<|call|>';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toHaveLength(1);
    expect(direct.toolCalls[0]).toEqual({ name: "role_placed", arguments: '{"x":1}' });
  });

  // (25) <|constrain|>json on analysis does NOT trigger <|call|>-termination;
  // body ends at <|end|>.
  it("(25) <|constrain|>json on analysis does not trigger call-termination", () => {
    const chunks = [
      "<|channel|>analysis<|constrain|>json<|message|>Thinking.<|end|>",
      "<|start|>assistant<|channel|>final<|message|>The final answer.<|return|>",
    ];
    const result = collapseOpenAISSE(openAIHarmonyBody(chunks));
    expect(result.reasoning).toBe("Thinking.");
    expect(result.content).toBe("The final answer.");
    expect(result.toolCalls).toBeUndefined();
  });

  // (26) RECIPIENT_RE: to=functions.- or to=functions. -> NOT a recipient ->
  // non-tool body (no {name:"-"} call). A commentary message without a valid
  // recipient is a preamble -> content.
  it("(26) to=functions.- / to=functions. are not recipients (no bogus tool call)", () => {
    const dash =
      "<|start|>assistant<|channel|>commentary to=functions.-<|message|>preamble dash<|end|>";
    const directDash = parseHarmonyContent(dash);
    expect(directDash.failed).toBe(false);
    expect(directDash.toolCalls).toEqual([]);
    expect(directDash.content).toBe("preamble dash");

    const empty =
      "<|start|>assistant<|channel|>commentary to=functions.<|message|>preamble empty<|end|>";
    const directEmpty = parseHarmonyContent(empty);
    expect(directEmpty.failed).toBe(false);
    expect(directEmpty.toolCalls).toEqual([]);
    expect(directEmpty.content).toBe("preamble empty");
  });
});

describe("harmony rewrite — UNTERMINATED / MALFORMED", () => {
  // (27) commentary to=functions.x message {"a":1} with NO <|call|> -> fail-safe
  // verbatim + signal.
  it("(27) commentary tool body with valid JSON but no <|call|> fails safe", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.x<|constrain|>json<|message|>{"a":1}';
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.toolCalls).toEqual([]);

    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
  });

  // (28) <|channel|> with no following <|message|> -> fail-safe verbatim.
  it("(28) <|channel|> with no following <|message|> fails safe", () => {
    const raw = "<|channel|>analysis no message here";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
  });

  // (29) <|start|>assistant with no channel/message -> fail-safe verbatim.
  it("(29) <|start|>assistant with no channel/message fails safe", () => {
    const raw = "<|start|>assistant";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
  });
});

describe("harmony rewrite — OBSERVABILITY / ENCODING", () => {
  // (30) a firstDroppedSample-style 200-unit sample whose boundary splits a
  // surrogate pair must be valid UTF-16 (no lone surrogate). This pins the
  // surrogate-safe slicing of diagnostic samples.
  it("(30) a 200-unit diagnostic sample never ends on a lone surrogate", () => {
    // The diagnostic note slices the FULL content (which begins with the
    // harmony prefix), not just the filler — so the emoji must be positioned
    // relative to the prefix length to land its HIGH surrogate exactly at the
    // 200-unit slice boundary (UTF-16 index 199). Otherwise the slice boundary
    // never splits the pair and the surrogate-trim branch is never exercised.
    const prefix = "<|start|>assistant<|channel|>commentary to=functions.s<|message|>{bad ";
    // filler length = 199 - prefix.length puts the emoji's high surrogate at
    // UTF-16 index 199 and its low surrogate at index 200.
    const filler = "x".repeat(199 - prefix.length);
    const content = `${prefix}${filler}😀 trailing`;

    // Sanity: the raw (un-trimmed) 200-unit slice MUST end on a lone high
    // surrogate, proving this test actually exercises the trim branch and is
    // not trivially green.
    const rawSlice = content.slice(0, 200);
    const rawLast = rawSlice.charCodeAt(rawSlice.length - 1);
    expect(rawLast >= 0xd800 && rawLast <= 0xdbff).toBe(true);

    const result = collapseOpenAISSE(openAIHarmonyBody([content]));
    // Harmony failed -> content preserved verbatim, signal set.
    expect(result.content).toBe(content);
    expect(result.harmonyUnparsed).toBe(true);

    // The diagnostic note is always present alongside harmonyUnparsed, and its
    // surrogate-safe slice must contain NO lone surrogate code unit anywhere.
    expect(result.harmonyNote).toBeDefined();
    const note = result.harmonyNote!;
    for (let k = 0; k < note.length; k++) {
      const unit = note.charCodeAt(k);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        // High surrogate: the next unit MUST be a low surrogate.
        const next = note.charCodeAt(k + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        k++; // skip the paired low surrogate
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        // A low surrogate not preceded by a high surrogate is unpaired.
        throw new Error(`lone low surrogate at index ${k} in harmonyNote`);
      }
    }
  });
});

describe("harmony rewrite — Ollama NDJSON parity", () => {
  // Fallback-only + fail-safe + whitespace parity for the Ollama path.
  it("parses analysis + commentary tool + final over Ollama with separators", () => {
    const chunks = [
      "<|channel|>analysis<|message|>Plan.<|end|>",
      "\n",
      '<|start|>assistant<|channel|>commentary to=functions.lookup<|constrain|>json<|message|>{"q":"x"}<|call|>',
      "\n",
      "<|start|>assistant<|channel|>final<|message|>Result.<|return|>",
    ];
    const result = collapseOllamaNDJSON(ollamaHarmonyBody(chunks));
    expect(result.reasoning).toBe("Plan.");
    expect(result.content).toBe("Result.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({ name: "lookup", arguments: '{"q":"x"}' });
  });

  it("prose mention over Ollama is content verbatim (no destruction)", () => {
    const prose = "Harmony uses `<|channel|>` then `<|message|>` for the body";
    const result = collapseOllamaNDJSON(ollamaHarmonyBody([prose]));
    expect(result.content).toBe(prose);
    expect(result.toolCalls).toBeUndefined();
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  it("structured Ollama tool_calls win over harmony content (fallback-only)", () => {
    const harmony =
      '<|start|>assistant<|channel|>commentary to=functions.harmony_tool<|constrain|>json<|message|>{"z":9}<|call|>';
    const body = [
      JSON.stringify({
        model: "gpt-oss",
        message: {
          role: "assistant",
          content: harmony,
          tool_calls: [{ function: { name: "structured_tool", arguments: '{"s":1}' } }],
        },
        done: false,
      }),
      JSON.stringify({ model: "gpt-oss", message: { role: "assistant", content: "" }, done: true }),
    ].join("\n");
    const result = collapseOllamaNDJSON(body);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("structured_tool");
    expect(result.toolCalls!.some((tc) => tc.name === "harmony_tool")).toBe(false);
    expect(result.truncated).toBeUndefined();
  });

  it("unparseable harmony over Ollama fails safe via harmonyUnparsed", () => {
    const raw =
      "<|start|>assistant<|channel|>commentary to=functions.broken<|constrain|>json<|message|>{not valid";
    const result = collapseOllamaNDJSON(ollamaHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });
});

// ===========================================================================
// Harmony fail-safe UNIFORMITY at body boundaries — regressions for the three
// holes a 7-agent review found in the documented all-or-nothing contract:
// "any grammar deviation -> return ORIGINAL content verbatim, failed:true,
// never silently strip/mangle; never leak a control token into content/
// reasoning." Each test below pins a boundary case where the old code accepted
// (failed:false) while leaking a control token or dropping data.
// ===========================================================================

describe("harmony fail-safe — body terminator followed by trailing junk (B-A1)", () => {
  // A real terminator followed by NON-whitespace text that is NOT a real
  // message start is a grammar deviation: the stream neither cleanly ends nor
  // continues with another message. The OLD code absorbed the terminator
  // literal into the body and kept scanning to EOF, leaking "<|return|> junk"
  // into content. Correct behavior: uniform fail-safe (verbatim + failed:true).
  it("final<|return|> followed by trailing junk fails safe (no token leak)", () => {
    const raw = "<|channel|>final<|message|>Answer.<|return|> junk";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.toolCalls).toEqual([]);
    expect(direct.reasoning).toBe("");

    const result = collapseOpenAISSE(openAIHarmonyBody([raw]));
    expect(result.content).toBe(raw);
    expect(result.harmonyUnparsed).toBe(true);
    expect(result.droppedChunks ?? 0).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  it("analysis<|end|> followed by trailing junk fails safe (no token leak)", () => {
    const raw = "<|channel|>analysis<|message|>thinking<|end|>junk";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);
  });
});

describe("harmony fail-safe — unterminated NON-final body at EOF (B-A3)", () => {
  // The grammar says "EOF terminates the FINAL message only." An unterminated
  // analysis (reasoning) body at EOF is a grammar deviation — analysis bodies
  // are terminator-expecting (<|end|>). The OLD code accepted it (failed:false)
  // and surfaced dangling reasoning. Correct behavior: fail-safe verbatim.
  it("unterminated analysis body at EOF fails safe", () => {
    const raw = "<|channel|>analysis<|message|>dangling reasoning";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.reasoning).toBe("");
    expect(direct.toolCalls).toEqual([]);
  });

  // A final body at EOF (no terminator) is still legitimately accepted — EOF
  // terminates the final message. This guards against over-failing B-A3.
  it("unterminated FINAL body at EOF is still accepted (EOF terminates final)", () => {
    const raw = "<|channel|>final<|message|>the answer with no terminator";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe("the answer with no terminator");
    expect(direct.reasoning).toBe("");
  });

  // A legitimate analysis-followed-by-final stream where the analysis body IS
  // terminated (by <|end|>) and only the final trails to EOF must still parse —
  // the analysis terminator is present, so B-A3 must not fire on it.
  it("analysis<|end|> + final-to-EOF still parses (analysis is terminated)", () => {
    const raw =
      "<|channel|>analysis<|message|>reasoning here<|end|><|start|>assistant<|channel|>final<|message|>final answer";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.reasoning).toBe("reasoning here");
    expect(direct.content).toBe("final answer");
  });
});

describe("harmony fail-safe — commentary tool body vs message boundary (B-A2)", () => {
  // (a) A tool arg that is a CLOSED JSON string which legitimately CONTAINS
  // literal harmony tokens (<|start|>...<|message|>...) is valid data: the
  // correct parse is ONE tool call whose argument is that string. This is the
  // SAME mechanism that preserves embedded <|call|>/<|channel|> substrings in
  // JSON args (matrix 13/14). PIN this as correct — guards against a wrong fix.
  it("(a) closed JSON arg containing literal harmony tokens -> one tool call", () => {
    const arg = JSON.stringify({
      instruction:
        "emit <|start|>assistant<|channel|>commentary to=functions.x<|message|>nested<|call|>",
    });
    const raw = `<|start|>assistant<|channel|>commentary to=functions.outer<|constrain|>json<|message|>${arg}<|call|>`;
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(false);
    expect(direct.toolCalls).toHaveLength(1);
    expect(direct.toolCalls[0].name).toBe("outer");
    expect(direct.toolCalls[0].arguments).toBe(arg);
    expect(() => JSON.parse(direct.toolCalls[0].arguments)).not.toThrow();
  });

  // (b) An UNTERMINATED tool call: a valid-JSON tool body followed by a real
  // next message but with NO closing <|call|> for the first tool call. This
  // must NOT silently merge/drop — it must fail safe verbatim.
  it("(b) tool body with no <|call|> before a real next message fails safe", () => {
    const raw =
      '<|start|>assistant<|channel|>commentary to=functions.first<|constrain|>json<|message|>{"a":1}' +
      "<|start|>assistant<|channel|>final<|message|>answer<|return|>";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.toolCalls).toEqual([]);
  });
});

describe("harmony fail-safe — quoted whole-message ambiguity (known limitation)", () => {
  // A body that QUOTES a complete well-formed harmony message is structurally
  // indistinguishable from two real messages in detokenized TEXT. When the
  // resulting split yields cleanly well-formed messages, the parser accepts it
  // (the quoted tokens are stripped) — this is the irreducible, documented
  // KNOWN LIMITATION. We PIN the acknowledged-imperfect behavior here so it is
  // a conscious choice, not a silent regression target.
  it("quoting a clean complete message splits into well-formed messages (documented)", () => {
    const raw =
      "<|channel|>final<|message|>To emit write " +
      "<|start|>assistant<|channel|>final<|message|>hello<|return|>";
    const direct = parseHarmonyContent(raw);
    // Acknowledged-imperfect: parsed as two final messages; quoted tokens gone.
    expect(direct.failed).toBe(false);
    expect(direct.content).toBe("To emit write hello");
    // Whatever the outcome, no control token ever leaks into the output.
    expect(direct.content).not.toContain("<|");
    expect(direct.reasoning).not.toContain("<|");
  });

  // The fail-safe edge of the same ambiguity: when the quoted message is
  // followed by trailing junk, the split would yield a MALFORMED message, so
  // the WHOLE input fails safe verbatim rather than emitting a mangled middle.
  // This guarantees the behavior is always verbatim-or-clean, never mangled.
  it("quoting a message followed by trailing junk fails safe verbatim (no mangle)", () => {
    const raw =
      "<|channel|>final<|message|>To emit write " +
      "<|start|>assistant<|channel|>final<|message|>hello<|return|> and then stop";
    const direct = parseHarmonyContent(raw);
    expect(direct.failed).toBe(true);
    expect(direct.content).toBe(raw);
    expect(direct.content).not.toBe("To emit write hello<|return|> and then stop");
  });
});
