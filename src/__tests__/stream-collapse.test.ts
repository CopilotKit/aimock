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

  it("returns toolCalls (not content) when both tool_calls and text are present", () => {
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
    // When toolCalls are present, they take priority over content
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("get_weather");
    expect(result.content).toBeUndefined();
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
        item: { type: "web_search_call", status: "completed", query: "test query" },
      })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "web_search_call", status: "completed", query: "another query" },
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
