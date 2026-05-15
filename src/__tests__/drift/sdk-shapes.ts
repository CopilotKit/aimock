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

/**
 * Non-streaming completion with reasoning_content on the message.
 * Models like o1/o3 emit reasoning_content alongside the assistant content.
 */
export function openaiChatCompletionReasoningShape(): ShapeNode {
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
          content: "The answer is 42.",
          refusal: null,
          reasoning_content: "Let me think step by step...",
        },
        logprobs: null,
        finish_reason: "stop",
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

/**
 * Streaming chunk with reasoning_content delta.
 * Reasoning chunks are emitted before the role/content chunks.
 */
export function openaiChatCompletionReasoningChunkShape(): ShapeNode {
  return extractShape({
    id: "chatcmpl-abc123",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        delta: {
          reasoning_content: "Let me think",
        },
        logprobs: null,
        finish_reason: null,
      },
    ],
    system_fingerprint: "fp_abc123",
  });
}

// ---------------------------------------------------------------------------
// OpenAI Moderations
// ---------------------------------------------------------------------------

export function openaiModerationResponseShape(): ShapeNode {
  return extractShape({
    id: "modr-abc123",
    model: "text-moderation-latest",
    results: [
      {
        flagged: false,
        categories: {
          sexual: false,
          hate: false,
          harassment: false,
          "self-harm": false,
          "sexual/minors": false,
          "hate/threatening": false,
          "violence/graphic": false,
          "self-harm/intent": false,
          "self-harm/instructions": false,
          "harassment/threatening": false,
          violence: false,
          illicit: false,
          "illicit/violent": false,
        },
        category_scores: {
          sexual: 0,
          hate: 0,
          harassment: 0,
          "self-harm": 0,
          "sexual/minors": 0,
          "hate/threatening": 0,
          "violence/graphic": 0,
          "self-harm/intent": 0,
          "self-harm/instructions": 0,
          "harassment/threatening": 0,
          violence: 0,
          illicit: 0,
          "illicit/violent": 0,
        },
      },
    ],
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
        item_id: "msg_abc123",
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
        item_id: "msg_abc123",
        output_index: 0,
        content_index: 0,
        text: "Hello!",
      }),
    },
    {
      type: "response.content_part.done",
      dataShape: extractShape({
        type: "response.content_part.done",
        item_id: "msg_abc123",
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
        item_id: "fc_abc123",
        output_index: 0,
        arguments: '{"city":"SF"}',
      }),
    },
  ];
}

export function openaiResponsesReasoningEventShapes(): SSEEventShape[] {
  return [
    {
      type: "response.output_item.added",
      dataShape: extractShape({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_abc123",
          summary: [],
        },
      }),
    },
    {
      type: "response.reasoning_summary_part.added",
      dataShape: extractShape({
        type: "response.reasoning_summary_part.added",
        item_id: "rs_abc123",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    },
    {
      type: "response.reasoning_summary_text.delta",
      dataShape: extractShape({
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_abc123",
        output_index: 0,
        summary_index: 0,
        delta: "Step by step",
      }),
    },
    {
      type: "response.reasoning_summary_text.done",
      dataShape: extractShape({
        type: "response.reasoning_summary_text.done",
        item_id: "rs_abc123",
        output_index: 0,
        summary_index: 0,
        text: "Step by step...",
      }),
    },
    {
      type: "response.reasoning_summary_part.done",
      dataShape: extractShape({
        type: "response.reasoning_summary_part.done",
        item_id: "rs_abc123",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "Step by step..." },
      }),
    },
    {
      type: "response.output_item.done",
      dataShape: extractShape({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_abc123",
          summary: [{ type: "summary_text", text: "Step by step..." }],
        },
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

export function anthropicThinkingMessageShape(): ShapeNode {
  return extractShape({
    id: "msg_abc123",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I need to consider...", signature: "" },
      { type: "text", text: "Hello!" },
    ],
    model: "claude-3-haiku-20240307",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
  });
}

export function anthropicThinkingStreamEventShapes(): SSEEventShape[] {
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
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
    },
    {
      type: "content_block_delta",
      dataShape: extractShape({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "I need to consider..." },
      }),
    },
    {
      type: "content_block_delta",
      dataShape: extractShape({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "" },
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
        event_id: "event_abc123",
        session: {
          id: "sess_abc123",
          object: "realtime.session",
          model: "gpt-realtime-2",
          modalities: ["text"],
          instructions: "",
          tools: [],
          audio: {
            voice: null,
            input_audio_format: null,
            output_audio_format: null,
            input_audio_noise_reduction: null,
            input_audio_transcription: null,
          },
          turn_detection: null,
          temperature: 0.8,
          expires_at: 1700000000,
          max_response_output_tokens: "inf",
          input_audio_transcription: null,
          tool_choice: "auto",
          type: "conversation",
          reasoning: null,
        },
      }),
    },
    {
      type: "session.updated",
      dataShape: extractShape({
        type: "session.updated",
        event_id: "event_abc123",
        session: {
          object: "realtime.session",
          model: "gpt-realtime-2",
          modalities: ["text"],
          instructions: "",
          tools: [],
          audio: {
            voice: null,
            input_audio_format: null,
            output_audio_format: null,
            input_audio_noise_reduction: null,
            input_audio_transcription: null,
          },
          turn_detection: null,
          temperature: 0.8,
          expires_at: 1700000000,
          max_response_output_tokens: "inf",
          input_audio_transcription: null,
          tool_choice: "auto",
          type: "conversation",
          reasoning: null,
        },
      }),
    },
    {
      type: "conversation.item.added",
      dataShape: extractShape({
        type: "conversation.item.added",
        event_id: "event_abc123",
        previous_item_id: null,
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
        event_id: "event_abc123",
        response: {
          id: "resp_abc123",
          object: "realtime.response",
          status: "in_progress",
          status_details: null,
          output: [],
          usage: null,
        },
      }),
    },
    {
      type: "response.output_item.added",
      dataShape: extractShape({
        type: "response.output_item.added",
        event_id: "event_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
          phase: "final_answer",
        },
      }),
    },
    {
      type: "response.content_part.added",
      dataShape: extractShape({
        type: "response.content_part.added",
        event_id: "event_abc123",
        response_id: "resp_abc123",
        item_id: "item_abc123",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      }),
    },
    {
      type: "response.output_text.delta",
      dataShape: extractShape({
        type: "response.output_text.delta",
        event_id: "event_abc123",
        response_id: "resp_abc123",
        item_id: "item_abc123",
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      }),
    },
    {
      type: "response.output_text.done",
      dataShape: extractShape({
        type: "response.output_text.done",
        event_id: "event_abc123",
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
        event_id: "event_abc123",
        response_id: "resp_abc123",
        item_id: "item_abc123",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "Hello!" },
      }),
    },
    {
      type: "response.output_item.done",
      dataShape: extractShape({
        type: "response.output_item.done",
        event_id: "event_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello!" }],
          phase: "final_answer",
        },
      }),
    },
    {
      type: "conversation.item.done",
      dataShape: extractShape({
        type: "conversation.item.done",
        event_id: "event_abc123",
        item: {
          id: "item_abc123",
          object: "realtime.item",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello!" }],
        },
      }),
    },
    {
      type: "response.done",
      dataShape: extractShape({
        type: "response.done",
        event_id: "event_abc123",
        response: {
          id: "resp_abc123",
          object: "realtime.response",
          status: "completed",
          output: [
            {
              id: "item_abc123",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Hello!" }],
            },
          ],
          usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
        },
      }),
    },
  ];
}

/**
 * Beta Realtime event shapes — uses legacy Beta event names.
 * Useful for three-way comparison when testing Beta compatibility shim.
 */
export function openaiRealtimeBetaTextEventShapes(): SSEEventShape[] {
  return [
    {
      type: "session.created",
      dataShape: extractShape({
        type: "session.created",
        event_id: "event_abc123",
        session: {
          id: "sess_abc123",
          object: "realtime.session",
          model: "gpt-realtime-2",
          modalities: ["text"],
          instructions: "",
          tools: [],
          voice: null,
          input_audio_format: null,
          output_audio_format: null,
          turn_detection: null,
          temperature: 0.8,
          expires_at: 1700000000,
          max_response_output_tokens: "inf",
          input_audio_transcription: null,
          tool_choice: "auto",
        },
      }),
    },
    {
      type: "session.updated",
      dataShape: extractShape({
        type: "session.updated",
        event_id: "event_abc123",
        session: {
          object: "realtime.session",
          model: "gpt-realtime-2",
          modalities: ["text"],
          instructions: "",
          tools: [],
          voice: null,
          input_audio_format: null,
          output_audio_format: null,
          turn_detection: null,
          temperature: 0.8,
          expires_at: 1700000000,
          max_response_output_tokens: "inf",
          input_audio_transcription: null,
          tool_choice: "auto",
        },
      }),
    },
    {
      type: "conversation.item.created",
      dataShape: extractShape({
        type: "conversation.item.created",
        event_id: "event_abc123",
        previous_item_id: null,
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
        event_id: "event_abc123",
        response: {
          id: "resp_abc123",
          object: "realtime.response",
          status: "in_progress",
          status_details: null,
          output: [],
          usage: null,
        },
      }),
    },
    {
      type: "response.output_item.added",
      dataShape: extractShape({
        type: "response.output_item.added",
        event_id: "event_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      }),
    },
    {
      type: "response.content_part.added",
      dataShape: extractShape({
        type: "response.content_part.added",
        event_id: "event_abc123",
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
        event_id: "event_abc123",
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
        event_id: "event_abc123",
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
        event_id: "event_abc123",
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
        event_id: "event_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "text", text: "Hello!" }],
        },
      }),
    },
    {
      type: "response.done",
      dataShape: extractShape({
        type: "response.done",
        event_id: "event_abc123",
        response: {
          id: "resp_abc123",
          object: "realtime.response",
          status: "completed",
          output: [
            {
              id: "item_abc123",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "text", text: "Hello!" }],
            },
          ],
          usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
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
        event_id: "event_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "function_call",
          status: "in_progress",
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
        event_id: "event_abc123",
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
        event_id: "event_abc123",
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
        event_id: "event_abc123",
        response_id: "resp_abc123",
        output_index: 0,
        item: {
          id: "item_abc123",
          type: "function_call",
          status: "completed",
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
// AWS Bedrock Converse Stream
// ---------------------------------------------------------------------------

/**
 * Expected event shapes for Bedrock ConverseStream responses.
 *
 * ConverseStream uses AWS binary Event Stream framing where the event type is
 * carried in the `:event-type` header and the payload is a flat JSON object
 * (NOT wrapped with the event type name as a key).
 */
export function bedrockConverseStreamEventShapes(): SSEEventShape[] {
  return [
    {
      type: "messageStart",
      dataShape: extractShape({
        role: "assistant",
      }),
    },
    {
      type: "contentBlockStart",
      dataShape: extractShape({
        contentBlockIndex: 0,
        start: {},
      }),
    },
    {
      type: "contentBlockDelta",
      dataShape: extractShape({
        contentBlockIndex: 0,
        delta: { text: "Hello" },
      }),
    },
    {
      type: "contentBlockStop",
      dataShape: extractShape({
        contentBlockIndex: 0,
      }),
    },
    {
      type: "messageStop",
      dataShape: extractShape({
        stopReason: "end_turn",
      }),
    },
    {
      type: "metadata",
      dataShape: extractShape({
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        metrics: { latencyMs: 0 },
      }),
    },
  ];
}

/**
 * Expected event shapes for Bedrock ConverseStream tool call responses.
 *
 * Tool calls use `contentBlockStart` with a `toolUse` start descriptor
 * and `contentBlockDelta` with `toolUse.input` string chunks.
 */
export function bedrockConverseStreamToolShapes(): SSEEventShape[] {
  return [
    {
      type: "messageStart",
      dataShape: extractShape({
        role: "assistant",
      }),
    },
    {
      type: "contentBlockStart",
      dataShape: extractShape({
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: "toolu_test", name: "get_weather" } },
      }),
    },
    {
      type: "contentBlockDelta",
      dataShape: extractShape({
        contentBlockIndex: 0,
        delta: { toolUse: { input: '{"city":' } },
      }),
    },
    {
      type: "contentBlockStop",
      dataShape: extractShape({
        contentBlockIndex: 0,
      }),
    },
    {
      type: "messageStop",
      dataShape: extractShape({
        stopReason: "tool_use",
      }),
    },
    {
      type: "metadata",
      dataShape: extractShape({
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        metrics: { latencyMs: 0 },
      }),
    },
  ];
}

/**
 * Expected event shapes for Bedrock ConverseStream reasoning responses.
 *
 * Reasoning content uses `contentBlockStart` with a `reasoningContent`
 * start descriptor and `contentBlockDelta` with `reasoningContent.text`
 * string chunks, followed by the regular text content block.
 */
export function bedrockConverseStreamReasoningShapes(): SSEEventShape[] {
  return [
    {
      type: "messageStart",
      dataShape: extractShape({
        role: "assistant",
      }),
    },
    {
      type: "contentBlockStart",
      dataShape: extractShape({
        contentBlockIndex: 0,
        start: { reasoningContent: {} },
      }),
    },
    {
      type: "contentBlockDelta",
      dataShape: extractShape({
        contentBlockIndex: 0,
        delta: { reasoningContent: { text: "Let me think..." } },
      }),
    },
    {
      type: "contentBlockStop",
      dataShape: extractShape({
        contentBlockIndex: 0,
      }),
    },
    {
      type: "messageStop",
      dataShape: extractShape({
        stopReason: "end_turn",
      }),
    },
    {
      type: "metadata",
      dataShape: extractShape({
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        metrics: { latencyMs: 0 },
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// AWS Bedrock Invoke-with-Response-Stream (Anthropic native inside EventStream)
// ---------------------------------------------------------------------------

/**
 * Expected event shapes for Bedrock invoke-with-response-stream responses.
 *
 * Unlike ConverseStream (which uses Bedrock-native camelCase payloads),
 * invoke-with-response-stream wraps Anthropic-native streaming events inside
 * AWS binary Event Stream frames. Every frame has `:event-type` = "chunk"
 * and the JSON payload is the raw Anthropic SSE event object.
 */
export function bedrockInvokeStreamEventShapes(): SSEEventShape[] {
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
          model: "anthropic.claude-3-haiku",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
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
        usage: { output_tokens: 0 },
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

/**
 * Expected shape for a Gemini 2.5+ non-streaming response that includes
 * thinking/reasoning tokens. Thinking parts carry `thought: true`.
 */
export function geminiThinkingContentResponseShape(): ShapeNode {
  return extractShape({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "Let me think...", thought: true }, { text: "Hello!" }],
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

/**
 * Expected shape for a Gemini 2.5+ streaming thinking chunk.
 * Intermediate thinking chunks have `thought: true` on the text part
 * and no finishReason.
 */
export function geminiThinkingStreamChunkShape(): ShapeNode {
  return extractShape({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "Let me think...", thought: true }],
        },
        index: 0,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Google Gemini Interactions API (Beta)
// ---------------------------------------------------------------------------

export function geminiInteractionsResponseShape(): ShapeNode {
  return extractShape({
    id: "int_abc123",
    status: "completed",
    model: "gemini-2.5-flash",
    role: "model",
    outputs: [{ type: "text", text: "Hello!" }],
    usage: { total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0 },
  });
}

export function geminiInteractionsToolCallResponseShape(): ShapeNode {
  return extractShape({
    id: "int_abc123",
    status: "requires_action",
    model: "gemini-2.5-flash",
    role: "model",
    outputs: [
      {
        type: "function_call",
        id: "call_abc123",
        name: "get_weather",
        arguments: { city: "Paris" },
      },
    ],
    usage: { total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0 },
  });
}

export function geminiInteractionsStreamEventShapes(): SSEEventShape[] {
  return [
    {
      type: "interaction.start",
      dataShape: extractShape({
        event_type: "interaction.start",
        interaction: { id: "int_abc123", status: "in_progress" },
        event_id: "evt_1",
      }),
    },
    {
      type: "content.start",
      dataShape: extractShape({
        event_type: "content.start",
        index: 0,
        content: { type: "text" },
        event_id: "evt_2",
      }),
    },
    {
      type: "content.delta",
      dataShape: extractShape({
        event_type: "content.delta",
        index: 0,
        delta: { type: "text", text: "Hello" },
        event_id: "evt_3",
      }),
    },
    {
      type: "content.stop",
      dataShape: extractShape({
        event_type: "content.stop",
        index: 0,
        event_id: "evt_4",
      }),
    },
    {
      type: "interaction.complete",
      dataShape: extractShape({
        event_type: "interaction.complete",
        interaction: {
          id: "int_abc123",
          status: "completed",
          usage: { total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0 },
        },
        event_id: "evt_5",
      }),
    },
  ];
}

export function geminiInteractionsToolCallStreamEventShapes(): SSEEventShape[] {
  return [
    {
      type: "interaction.start",
      dataShape: extractShape({
        event_type: "interaction.start",
        interaction: { id: "int_abc123", status: "in_progress" },
        event_id: "evt_1",
      }),
    },
    {
      type: "content.start",
      dataShape: extractShape({
        event_type: "content.start",
        index: 0,
        content: { type: "function_call" },
        event_id: "evt_2",
      }),
    },
    {
      type: "content.delta",
      dataShape: extractShape({
        event_type: "content.delta",
        index: 0,
        delta: {
          type: "function_call",
          id: "call_abc123",
          name: "get_weather",
          arguments: { city: "Paris" },
        },
        event_id: "evt_3",
      }),
    },
    {
      type: "content.stop",
      dataShape: extractShape({
        event_type: "content.stop",
        index: 0,
        event_id: "evt_4",
      }),
    },
    {
      type: "interaction.complete",
      dataShape: extractShape({
        event_type: "interaction.complete",
        interaction: {
          id: "int_abc123",
          status: "requires_action",
          usage: { total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0 },
        },
        event_id: "evt_5",
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// OpenAI Transcription / Whisper (STT)
// ---------------------------------------------------------------------------

/**
 * Basic transcription response shape per OpenAI Whisper API spec.
 * Returned when response_format is "json" (default).
 * Ref: https://platform.openai.com/docs/api-reference/audio/createTranscription
 */
export function openaiTranscriptionBasicShape(): ShapeNode {
  return extractShape({
    text: "Hello, world.",
  });
}

/**
 * Verbose transcription response shape per OpenAI Whisper API spec.
 * Returned when response_format is "verbose_json".
 * Ref: https://platform.openai.com/docs/api-reference/audio/verbose-json-object
 */
export function openaiTranscriptionVerboseShape(): ShapeNode {
  return extractShape({
    task: "transcribe",
    language: "english",
    duration: 2.5,
    text: "Hello, world.",
    words: [{ word: "Hello,", start: 0.0, end: 0.4 }],
    segments: [
      {
        id: 0,
        text: "Hello, world.",
        start: 0.0,
        end: 2.5,
      },
    ],
  });
}
