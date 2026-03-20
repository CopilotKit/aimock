/**
 * Extract expected shapes from SDK types by constructing minimal conformant
 * objects and running extractShape() on them.
 *
 * This gives us the "expected" shape layer without needing the TypeScript
 * compiler API. Each function creates a minimal valid instance with all
 * required fields populated with representative values.
 */

import { extractShape, type ShapeNode, type SSEEventShape } from "./schema.js";

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

export function openaiChatCompletionShape(): ShapeNode {
  return extractShape({
    id: "chatcmpl-abc123",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello!",
          refusal: null,
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      completion_tokens_details: {
        reasoning_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
      prompt_tokens_details: {
        cached_tokens: 0,
      },
    },
    system_fingerprint: "fp_abc123",
    service_tier: "default",
  });
}

export function openaiChatCompletionToolCallShape(): ShapeNode {
  return extractShape({
    id: "chatcmpl-abc123",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"SF"}',
              },
            },
          ],
          refusal: null,
        },
        logprobs: null,
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    system_fingerprint: "fp_abc123",
  });
}

export function openaiChatCompletionChunkShape(): ShapeNode {
  return extractShape({
    id: "chatcmpl-abc123",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: "",
        },
        logprobs: null,
        finish_reason: null,
      },
    ],
    system_fingerprint: "fp_abc123",
  });
}

// ---------------------------------------------------------------------------
// OpenAI Embeddings
// ---------------------------------------------------------------------------

export function openaiEmbeddingResponseShape(): ShapeNode {
  return extractShape({
    object: "list",
    data: [
      {
        object: "embedding",
        index: 0,
        embedding: [0.1, -0.2, 0.3],
      },
    ],
    model: "text-embedding-3-small",
    usage: {
      prompt_tokens: 2,
      total_tokens: 2,
    },
  });
}

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

export function openaiResponsesTextEventShapes(): SSEEventShape[] {
  return [
    {
      type: "response.created",
      dataShape: extractShape({
        type: "response.created",
        response: {
          id: "resp_abc123",
          object: "response",
          created_at: 1700000000,
          model: "gpt-4o-mini",
          status: "in_progress",
          output: [],
        },
      }),
    },
    {
      type: "response.in_progress",
      dataShape: extractShape({
        type: "response.in_progress",
        response: {
          id: "resp_abc123",
          object: "response",
          created_at: 1700000000,
          model: "gpt-4o-mini",
          status: "in_progress",
          output: [],
        },
      }),
    },
    {
      type: "response.output_item.added",
      dataShape: extractShape({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_abc123",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }),
    },
    {
      type: "response.content_part.added",
      dataShape: extractShape({
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      }),
    },
    {
      type: "response.output_text.delta",
      dataShape: extractShape({
        type: "response.output_text.delta",
        item_id: "msg_abc123",
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      }),
    },
    {
      type: "response.output_text.done",
      dataShape: extractShape({
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        text: "Hello!",
      }),
    },
    {
      type: "response.content_part.done",
      dataShape: extractShape({
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "Hello!" },
      }),
    },
    {
      type: "response.output_item.done",
      dataShape: extractShape({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_abc123",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello!" }],
        },
      }),
    },
    {
      type: "response.completed",
      dataShape: extractShape({
        type: "response.completed",
        response: {
          id: "resp_abc123",
          object: "response",
          created_at: 1700000000,
          model: "gpt-4o-mini",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_abc123",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello!" }],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
          },
        },
      }),
    },
  ];
}

export function openaiResponsesToolCallEventShapes(): SSEEventShape[] {
  return [
    {
      type: "response.output_item.added",
      dataShape: extractShape({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_abc123",
          call_id: "call_abc123",
          name: "get_weather",
          arguments: "",
          status: "in_progress",
        },
      }),
    },
    {
      type: "response.function_call_arguments.delta",
      dataShape: extractShape({
        type: "response.function_call_arguments.delta",
        item_id: "fc_abc123",
        output_index: 0,
        delta: '{"city":',
      }),
    },
    {
      type: "response.function_call_arguments.done",
      dataShape: extractShape({
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: '{"city":"SF"}',
      }),
    },
  ];
}

export function openaiResponsesNonStreamingShape(): ShapeNode {
  return extractShape({
    id: "resp_abc123",
    object: "response",
    created_at: 1700000000,
    model: "gpt-4o-mini",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_abc123",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello!" }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
  });
}

// ---------------------------------------------------------------------------
// Anthropic Claude Messages
// ---------------------------------------------------------------------------

export function anthropicMessageShape(): ShapeNode {
  return extractShape({
    id: "msg_abc123",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    model: "claude-3-haiku-20240307",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
  });
}

export function anthropicMessageToolCallShape(): ShapeNode {
  return extractShape({
    id: "msg_abc123",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_abc123",
        name: "get_weather",
        input: { city: "SF" },
      },
    ],
    model: "claude-3-haiku-20240307",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
  });
}

export function anthropicStreamEventShapes(): SSEEventShape[] {
  return [
    {
      type: "message_start",
      dataShape: extractShape({
        type: "message_start",
        message: {
          id: "msg_abc123",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-haiku-20240307",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
    },
    {
      type: "content_block_start",
      dataShape: extractShape({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    },
    {
      type: "content_block_delta",
      dataShape: extractShape({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
    },
    {
      type: "content_block_stop",
      dataShape: extractShape({
        type: "content_block_stop",
        index: 0,
      }),
    },
    {
      type: "message_delta",
      dataShape: extractShape({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
    },
    {
      type: "message_stop",
      dataShape: extractShape({
        type: "message_stop",
      }),
    },
  ];
}

export function anthropicToolStreamEventShapes(): SSEEventShape[] {
  return [
    {
      type: "content_block_start",
      dataShape: extractShape({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_abc123",
          name: "get_weather",
          input: {},
        },
      }),
    },
    {
      type: "content_block_delta",
      dataShape: extractShape({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// OpenAI Realtime API
// ---------------------------------------------------------------------------

export function openaiRealtimeTextEventShapes(): SSEEventShape[] {
  return [
    {
      type: "session.created",
      dataShape: extractShape({
        type: "session.created",
        event_id: "evt_abc123",
        session: {
          id: "sess_abc123",
          model: "gpt-4o-mini",
          modalities: ["text"],
          instructions: "",
          tools: [],
          voice: null,
          input_audio_format: null,
          output_audio_format: null,
          turn_detection: null,
          temperature: 0.8,
        },
      }),
    },
    {
      type: "session.updated",
      dataShape: extractShape({
        type: "session.updated",
        event_id: "evt_abc123",
        session: {
          model: "gpt-4o-mini",
          modalities: ["text"],
          instructions: "",
          tools: [],
          voice: null,
          input_audio_format: null,
          output_audio_format: null,
          turn_detection: null,
          temperature: 0.8,
        },
      }),
    },
    {
      type: "conversation.item.created",
      dataShape: extractShape({
        type: "conversation.item.created",
        event_id: "evt_abc123",
        item: {
          type: "message",
          id: "item_abc123",
          role: "user",
          content: [{ type: "input_text", text: "Say hello" }],
        },
      }),
    },
    {
      type: "response.created",
      dataShape: extractShape({
        type: "response.created",
        event_id: "evt_abc123",
        response: {
          id: "resp_abc123",
          status: "in_progress",
          output: [],
        },
      }),
    },
    {
      type: "response.output_item.added",
      dataShape: extractShape({
        type: "response.output_item.added",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "message",
          role: "assistant",
          content: [],
        },
      }),
    },
    {
      type: "response.content_part.added",
      dataShape: extractShape({
        type: "response.content_part.added",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        item_id: "item_abc123",
        output_index: 0,
        content_index: 0,
        part: { type: "text", text: "" },
      }),
    },
    {
      type: "response.text.delta",
      dataShape: extractShape({
        type: "response.text.delta",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        item_id: "item_abc123",
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      }),
    },
    {
      type: "response.text.done",
      dataShape: extractShape({
        type: "response.text.done",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        item_id: "item_abc123",
        output_index: 0,
        content_index: 0,
        text: "Hello!",
      }),
    },
    {
      type: "response.content_part.done",
      dataShape: extractShape({
        type: "response.content_part.done",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        item_id: "item_abc123",
        output_index: 0,
        content_index: 0,
        part: { type: "text", text: "Hello!" },
      }),
    },
    {
      type: "response.output_item.done",
      dataShape: extractShape({
        type: "response.output_item.done",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello!" }],
        },
      }),
    },
    {
      type: "response.done",
      dataShape: extractShape({
        type: "response.done",
        event_id: "evt_abc123",
        response: {
          id: "resp_abc123",
          status: "completed",
          output: [
            {
              id: "item_abc123",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Hello!" }],
            },
          ],
        },
      }),
    },
  ];
}

export function openaiRealtimeToolCallEventShapes(): SSEEventShape[] {
  return [
    {
      type: "response.output_item.added",
      dataShape: extractShape({
        type: "response.output_item.added",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "function_call",
          call_id: "call_abc123",
          name: "get_weather",
          arguments: "",
        },
      }),
    },
    {
      type: "response.function_call_arguments.delta",
      dataShape: extractShape({
        type: "response.function_call_arguments.delta",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        item_id: "item_abc123",
        output_index: 0,
        call_id: "call_abc123",
        delta: '{"city":',
      }),
    },
    {
      type: "response.function_call_arguments.done",
      dataShape: extractShape({
        type: "response.function_call_arguments.done",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        item_id: "item_abc123",
        output_index: 0,
        call_id: "call_abc123",
        arguments: '{"city":"Paris"}',
      }),
    },
    {
      type: "response.output_item.done",
      dataShape: extractShape({
        type: "response.output_item.done",
        event_id: "evt_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "function_call",
          call_id: "call_abc123",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        },
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Gemini Live BidiGenerateContent
// ---------------------------------------------------------------------------

export function geminiLiveSetupCompleteShape(): SSEEventShape {
  return {
    type: "setupComplete",
    dataShape: extractShape({ setupComplete: {} }),
  };
}

export function geminiLiveTextEventShapes(): SSEEventShape[] {
  return [
    {
      type: "serverContent",
      dataShape: extractShape({
        serverContent: {
          modelTurn: { parts: [{ text: "Hello!" }] },
          turnComplete: true,
        },
      }),
    },
  ];
}

export function geminiLiveToolCallEventShapes(): SSEEventShape[] {
  return [
    {
      type: "toolCall",
      dataShape: extractShape({
        toolCall: {
          functionCalls: [
            {
              name: "get_weather",
              args: { city: "Paris" },
              id: "call_gemini_get_weather_0",
            },
          ],
        },
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Google Gemini (HTTP)
// ---------------------------------------------------------------------------

export function geminiContentResponseShape(): ShapeNode {
  return extractShape({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "Hello!" }],
        },
        finishReason: "STOP",
        index: 0,
        safetyRatings: [
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            probability: "NEGLIGIBLE",
          },
        ],
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
    modelVersion: "gemini-1.5-flash",
  });
}

export function geminiToolCallResponseShape(): ShapeNode {
  return extractShape({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "get_weather",
                args: { city: "SF" },
              },
            },
          ],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
  });
}

export function geminiStreamChunkShape(): ShapeNode {
  return extractShape({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "Hello" }],
        },
        index: 0,
      },
    ],
  });
}

export function geminiStreamLastChunkShape(): ShapeNode {
  return extractShape({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "!" }],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
  });
}
