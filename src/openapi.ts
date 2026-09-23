/**
 * Machine-readable route catalog for aimock.
 *
 * `GET /__aimock/openapi.json` returns an OpenAPI 3.1 document and
 * `GET /__aimock/routes` returns the same list as a flat JSON array for
 * shells that just need `method + path`. SDK codegen, docs checks, and
 * harness smoke tests can assert against this instead of hard-coding a
 * route list that drifts.
 *
 * The catalog is DERIVED from the router's single source of truth
 * (`route-registry.ts`, which `server.ts` also imports for dispatch and
 * `metrics.ts` imports for path labels), so it cannot drift from the mounted
 * routes. Every operation carries a real `requestBody` / `responses` schema
 * (or an explicit non-JSON media type for audio/binary bodies) — a client can
 * build requests from this document, not just read paths off it.
 */

import {
  ROUTE_DEFINITIONS,
  COMPLETIONS_PATH,
  RESPONSES_PATH,
  MESSAGES_PATH,
  EMBEDDINGS_PATH,
  COHERE_CHAT_PATH,
  COHERE_EMBED_PATH,
  SEARCH_PATH,
  RERANK_PATH,
  MODERATIONS_PATH,
  IMAGES_PATH,
  SPEECH_PATH,
  MODELS_PATH,
} from "./route-registry.js";

export interface CatalogRoute {
  method: string;
  path: string;
  service: string;
  description: string;
}

/** Flat `method + path` list, derived from the router registry. */
export const CATALOG_ROUTES: CatalogRoute[] = ROUTE_DEFINITIONS.map((r) => ({
  method: r.method,
  path: r.path,
  service: r.service,
  description: r.description,
}));

function pathParams(openApiPath: string): Record<string, unknown>[] {
  const params: Record<string, unknown>[] = [];
  for (const match of openApiPath.matchAll(/\{([^}]+)\}/g)) {
    params.push({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}

const COMPONENTS: Record<string, unknown> = {
  ChatCompletionRequest: {
    type: "object",
    required: ["model", "messages"],
    properties: {
      model: { type: "string", description: "Model ID" },
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
            content: {
              oneOf: [
                { type: "string" },
                {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type"],
                    properties: {
                      type: {
                        type: "string",
                        enum: ["text", "image_url", "input_audio", "file"],
                      },
                      text: { type: "string" },
                      image_url: {
                        type: "object",
                        properties: {
                          url: { type: "string" },
                          detail: { type: "string" },
                        },
                      },
                    },
                  },
                },
              ],
            },
            name: { type: "string" },
            tool_calls: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "type", "function"],
                properties: {
                  id: { type: "string" },
                  type: { type: "string", enum: ["function"] },
                  function: {
                    type: "object",
                    required: ["name", "arguments"],
                    properties: {
                      name: { type: "string" },
                      arguments: { type: "string" },
                    },
                  },
                },
              },
            },
            tool_call_id: { type: "string" },
          },
        },
      },
      stream: { type: "boolean" },
      temperature: { type: "number" },
      top_p: { type: "number" },
      max_tokens: { type: "integer" },
      max_completion_tokens: { type: "integer" },
      tools: {
        type: "array",
        items: {
          type: "object",
          required: ["type", "function"],
          properties: {
            type: { type: "string", enum: ["function"] },
            function: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                parameters: { type: "object" },
              },
            },
          },
        },
      },
      tool_choice: {
        oneOf: [
          { type: "string", enum: ["none", "auto", "required"] },
          {
            type: "object",
            required: ["type", "function"],
            properties: {
              type: { type: "string", enum: ["function"] },
              function: { type: "object", properties: { name: { type: "string" } } },
            },
          },
        ],
      },
      response_format: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["text", "json_object", "json_schema"] },
          json_schema: { type: "object" },
        },
      },
      seed: { type: "integer" },
      stop: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    },
  },
  ChatCompletionResponse: {
    type: "object",
    required: ["id", "object", "created", "model", "choices"],
    properties: {
      id: { type: "string" },
      object: { type: "string", enum: ["chat.completion", "chat.completion.chunk"] },
      created: { type: "integer" },
      model: { type: "string" },
      choices: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "message", "finish_reason"],
          properties: {
            index: { type: "integer" },
            message: {
              type: "object",
              required: ["role", "content"],
              properties: {
                role: { type: "string" },
                content: { type: ["string", "null"] },
                tool_calls: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      type: { type: "string" },
                      function: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          arguments: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
            finish_reason: {
              type: ["string", "null"],
              enum: ["stop", "length", "tool_calls", "content_filter", null],
            },
          },
        },
      },
      usage: {
        type: "object",
        properties: {
          prompt_tokens: { type: "integer" },
          completion_tokens: { type: "integer" },
          total_tokens: { type: "integer" },
        },
      },
    },
  },
  ResponsesRequest: {
    type: "object",
    required: ["model", "input"],
    properties: {
      model: { type: "string", description: "Model ID" },
      input: {
        oneOf: [
          { type: "string" },
          {
            type: "array",
            items: {
              type: "object",
              required: ["role", "content"],
              properties: {
                role: { type: "string" },
                content: { type: "string" },
              },
            },
          },
        ],
      },
      stream: { type: "boolean" },
      instructions: { type: "string" },
      max_output_tokens: { type: "integer" },
      temperature: { type: "number" },
      tools: {
        type: "array",
        items: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string" },
            name: { type: "string" },
          },
        },
      },
      tool_choice: { type: "string" },
    },
  },
  ResponsesResponse: {
    type: "object",
    properties: {
      id: { type: "string" },
      object: { type: "string", enum: ["response"] },
      created_at: { type: "integer" },
      model: { type: "string" },
      status: { type: "string" },
      output: {
        type: "array",
        items: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string" },
            id: { type: "string" },
            status: { type: "string" },
            role: { type: "string" },
            content: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  text: { type: "string" },
                },
              },
            },
          },
        },
      },
      usage: {
        type: "object",
        properties: {
          input_tokens: { type: "integer" },
          output_tokens: { type: "integer" },
          total_tokens: { type: "integer" },
        },
      },
    },
  },
  MessagesRequest: {
    type: "object",
    required: ["model", "messages", "max_tokens"],
    properties: {
      model: { type: "string", description: "Model ID" },
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["user", "assistant"] },
            content: {
              oneOf: [
                { type: "string" },
                {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type"],
                    properties: {
                      type: {
                        type: "string",
                        enum: ["text", "image", "tool_use", "tool_result", "thinking"],
                      },
                      text: { type: "string" },
                      id: { type: "string" },
                      name: { type: "string" },
                      input: { type: "object" },
                    },
                  },
                },
              ],
            },
          },
        },
      },
      max_tokens: { type: "integer" },
      system: { type: "string" },
      temperature: { type: "number" },
      top_p: { type: "number" },
      stream: { type: "boolean" },
      stop_sequences: { type: "array", items: { type: "string" } },
      tools: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "input_schema"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            input_schema: { type: "object" },
          },
        },
      },
      tool_choice: { type: "object" },
    },
  },
  MessagesResponse: {
    type: "object",
    required: ["id", "type", "role", "content", "model", "stop_reason", "usage"],
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: ["message"] },
      role: { type: "string", enum: ["assistant"] },
      content: {
        type: "array",
        items: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["text", "tool_use"] },
            text: { type: "string" },
            id: { type: "string" },
            name: { type: "string" },
            input: { type: "object" },
          },
        },
      },
      model: { type: "string" },
      stop_reason: {
        type: ["string", "null"],
        enum: ["end_turn", "max_tokens", "stop_sequence", "tool_use", null],
      },
      usage: {
        type: "object",
        required: ["input_tokens", "output_tokens"],
        properties: {
          input_tokens: { type: "integer" },
          output_tokens: { type: "integer" },
        },
      },
    },
  },
  EmbeddingRequest: {
    type: "object",
    required: ["model", "input"],
    properties: {
      model: { type: "string", description: "Model ID" },
      input: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
          { type: "array", items: { type: "integer" } },
          { type: "array", items: { type: "array", items: { type: "integer" } } },
        ],
      },
      encoding_format: { type: "string", enum: ["float", "base64"] },
      dimensions: { type: "integer" },
    },
  },
  EmbeddingResponse: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      data: {
        type: "array",
        items: {
          type: "object",
          required: ["object", "index", "embedding"],
          properties: {
            object: { type: "string", enum: ["embedding"] },
            index: { type: "integer" },
            embedding: { type: "array", items: { type: "number" } },
          },
        },
      },
      model: { type: "string" },
      usage: {
        type: "object",
        properties: {
          prompt_tokens: { type: "integer" },
          total_tokens: { type: "integer" },
        },
      },
    },
  },
  CohereChatRequest: {
    type: "object",
    required: ["model", "messages"],
    properties: {
      model: { type: "string", description: "Model ID" },
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
            content: { type: "string" },
            tool_calls: { type: "array", items: { type: "object" } },
            tool_plan: { type: "string" },
          },
        },
      },
      temperature: { type: "number" },
      max_tokens: { type: "integer" },
      stream: { type: "boolean" },
      tools: { type: "array", items: { type: "object" } },
      documents: { type: "array", items: { type: "object" } },
    },
  },
  CohereChatResponse: {
    type: "object",
    properties: {
      id: { type: "string" },
      finish_reason: { type: "string" },
      message: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["assistant"] },
          content: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                text: { type: "string" },
              },
            },
          },
          tool_calls: { type: "array", items: { type: "object" } },
        },
      },
      usage: {
        type: "object",
        properties: {
          billed_units: {
            type: "object",
            properties: {
              input_tokens: { type: "integer" },
              output_tokens: { type: "integer" },
            },
          },
        },
      },
    },
  },
  CohereEmbedRequest: {
    type: "object",
    required: ["model", "texts"],
    properties: {
      model: { type: "string", description: "Model ID" },
      texts: { type: "array", items: { type: "string" } },
      input_type: {
        type: "string",
        enum: ["search_document", "search_query", "classification", "clustering"],
      },
      embedding_types: { type: "array", items: { type: "string" } },
    },
  },
  CohereEmbedResponse: {
    type: "object",
    properties: {
      id: { type: "string" },
      embeddings: { type: "array", items: { type: "array", items: { type: "number" } } },
      texts: { type: "array", items: { type: "string" } },
      meta: {
        type: "object",
        properties: {
          billed_units: {
            type: "object",
            properties: {
              input_tokens: { type: "integer" },
              output_tokens: { type: "integer" },
            },
          },
        },
      },
    },
  },
  OllamaChatRequest: {
    type: "object",
    required: ["model", "messages"],
    properties: {
      model: { type: "string" },
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string" },
            content: { type: "string" },
            images: { type: "array", items: { type: "string" } },
            tool_calls: { type: "array", items: { type: "object" } },
          },
        },
      },
      stream: { type: "boolean" },
      format: { type: "string" },
      options: { type: "object" },
      tools: { type: "array", items: { type: "object" } },
    },
  },
  OllamaChatResponse: {
    type: "object",
    properties: {
      model: { type: "string" },
      created_at: { type: "string" },
      message: {
        type: "object",
        properties: {
          role: { type: "string" },
          content: { type: "string" },
          tool_calls: { type: "array", items: { type: "object" } },
        },
      },
      done: { type: "boolean" },
      done_reason: { type: "string" },
    },
  },
  OllamaGenerateRequest: {
    type: "object",
    required: ["model", "prompt"],
    properties: {
      model: { type: "string" },
      prompt: { type: "string" },
      suffix: { type: "string" },
      system: { type: "string" },
      stream: { type: "boolean" },
      format: { type: "string" },
      options: { type: "object" },
    },
  },
  OllamaGenerateResponse: {
    type: "object",
    properties: {
      model: { type: "string" },
      created_at: { type: "string" },
      response: { type: "string" },
      done: { type: "boolean" },
      done_reason: { type: "string" },
    },
  },
  OllamaEmbedRequest: {
    type: "object",
    required: ["model", "input"],
    properties: {
      model: { type: "string" },
      input: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    },
  },
  OllamaEmbedResponse: {
    type: "object",
    properties: {
      model: { type: "string" },
      embeddings: { type: "array", items: { type: "array", items: { type: "number" } } },
    },
  },
  OllamaTagsResponse: {
    type: "object",
    properties: {
      models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            model: { type: "string" },
            modified_at: { type: "string" },
            size: { type: "integer" },
            digest: { type: "string" },
            details: { type: "object" },
          },
        },
      },
    },
  },
  ImageGenerationRequest: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      model: { type: "string" },
      size: { type: "string" },
      quality: { type: "string" },
      style: { type: "string", enum: ["vivid", "natural"] },
      n: { type: "integer" },
      response_format: { type: "string", enum: ["url", "b64_json"] },
    },
  },
  ImageEditRequest: {
    type: "object",
    required: ["image", "prompt"],
    properties: {
      image: { type: "string", format: "binary", description: "Image to edit (multipart file)" },
      prompt: { type: "string" },
      mask: { type: "string", format: "binary", description: "Edit mask (multipart file)" },
      model: { type: "string" },
      size: { type: "string" },
      n: { type: "integer" },
      response_format: { type: "string", enum: ["url", "b64_json"] },
    },
  },
  ImageResponse: {
    type: "object",
    properties: {
      created: { type: "integer" },
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            b64_json: { type: "string" },
            revised_prompt: { type: "string" },
          },
        },
      },
    },
  },
  SpeechRequest: {
    type: "object",
    required: ["model", "input"],
    properties: {
      model: { type: "string", description: "Model ID" },
      input: { type: "string", description: "Text to synthesize" },
      voice: { type: "string" },
      speed: { type: "number" },
      response_format: { type: "string", enum: ["mp3", "opus", "aac", "flac", "wav", "pcm"] },
      instructions: { type: "string" },
    },
  },
  TranscriptionRequest: {
    type: "object",
    required: ["file", "model"],
    properties: {
      file: { type: "string", format: "binary", description: "Audio file (multipart)" },
      model: { type: "string" },
      language: { type: "string" },
      response_format: { type: "string", enum: ["json", "text", "srt", "vtt"] },
      temperature: { type: "number" },
    },
  },
  TranscriptionResponse: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string" },
      language: { type: "string" },
      duration: { type: "number" },
    },
  },
  ModerationRequest: {
    type: "object",
    required: ["input"],
    properties: {
      input: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      model: { type: "string" },
    },
  },
  ModerationResponse: {
    type: "object",
    properties: {
      id: { type: "string" },
      model: { type: "string" },
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["flagged", "categories", "category_scores"],
          properties: {
            flagged: { type: "boolean" },
            categories: {
              type: "object",
              properties: {
                sexual: { type: "boolean" },
                hate: { type: "boolean" },
                harassment: { type: "boolean" },
                "self-harm": { type: "boolean" },
                "sexual/minors": { type: "boolean" },
                "hate/threatening": { type: "boolean" },
                "violence/graphic": { type: "boolean" },
                "self-harm/intent": { type: "boolean" },
                "self-harm/instructions": { type: "boolean" },
                harassment_threatening: { type: "boolean" },
                violence: { type: "boolean" },
              },
            },
            category_scores: {
              type: "object",
              properties: {
                sexual: { type: "number" },
                hate: { type: "number" },
                harassment: { type: "number" },
                "self-harm": { type: "number" },
                "sexual/minors": { type: "number" },
                "hate/threatening": { type: "number" },
                "violence/graphic": { type: "number" },
                "self-harm/intent": { type: "number" },
                "self-harm/instructions": { type: "number" },
                harassment_threatening: { type: "number" },
                violence: { type: "number" },
              },
            },
          },
        },
      },
    },
  },
  SearchRequest: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      max_results: { type: "integer" },
      search_depth: { type: "string" },
      include_answer: { type: "boolean" },
    },
  },
  SearchResponse: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "url", "content"],
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            content: { type: "string" },
            score: { type: "number" },
          },
        },
      },
      answer: { type: "string" },
    },
  },
  RerankRequest: {
    type: "object",
    required: ["query", "documents"],
    properties: {
      model: { type: "string" },
      query: { type: "string" },
      documents: {
        type: "array",
        items: { oneOf: [{ type: "string" }, { type: "object" }] },
      },
      top_n: { type: "integer" },
      return_documents: { type: "boolean" },
    },
  },
  RerankResponse: {
    type: "object",
    properties: {
      id: { type: "string" },
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "relevance_score"],
          properties: {
            index: { type: "integer" },
            relevance_score: { type: "number" },
            document: { type: "object" },
          },
        },
      },
    },
  },
  GeminiGenerateRequest: {
    type: "object",
    required: ["contents"],
    properties: {
      contents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["user", "model"] },
            parts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  inlineData: {
                    type: "object",
                    properties: {
                      mimeType: { type: "string" },
                      data: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      generationConfig: {
        type: "object",
        properties: {
          temperature: { type: "number" },
          topP: { type: "number" },
          maxOutputTokens: { type: "integer" },
          stopSequences: { type: "array", items: { type: "string" } },
        },
      },
      safetySettings: { type: "array", items: { type: "object" } },
      tools: { type: "array", items: { type: "object" } },
    },
  },
  GeminiGenerateResponse: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            content: {
              type: "object",
              properties: {
                role: { type: "string" },
                parts: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      functionCall: { type: "object" },
                    },
                  },
                },
              },
            },
            finishReason: { type: "string" },
          },
        },
      },
      usageMetadata: {
        type: "object",
        properties: {
          promptTokenCount: { type: "integer" },
          candidatesTokenCount: { type: "integer" },
          totalTokenCount: { type: "integer" },
        },
      },
      modelVersion: { type: "string" },
    },
  },
  GeminiEmbedRequest: {
    type: "object",
    required: ["content"],
    properties: {
      content: {
        type: "object",
        properties: {
          parts: {
            type: "array",
            items: { type: "object", properties: { text: { type: "string" } } },
          },
        },
      },
    },
  },
  GeminiEmbedResponse: {
    type: "object",
    properties: {
      embedding: {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
        },
      },
    },
  },
  GeminiPredictRequest: {
    type: "object",
    required: ["instances"],
    properties: {
      instances: {
        type: "array",
        items: {
          type: "object",
          properties: {
            prompt: { type: "string" },
          },
        },
      },
      parameters: {
        type: "object",
        properties: {
          sampleCount: { type: "integer" },
          aspectRatio: { type: "string" },
          safetyFilterLevel: { type: "string" },
        },
      },
    },
  },
  GeminiPredictResponse: {
    type: "object",
    properties: {
      predictions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            bytesBase64Encoded: { type: "string" },
            mimeType: { type: "string" },
          },
        },
      },
    },
  },
  InteractionsRequest: {
    type: "object",
    description:
      "Gemini interaction payload (contents + generationConfig), recorded and replayed verbatim.",
    properties: {
      contents: { type: "array", items: { type: "object" } },
      generationConfig: { type: "object" },
    },
  },
  InteractionsResponse: {
    type: "object",
    description: "Recorded interaction replay envelope.",
    properties: {
      candidates: { type: "array", items: { type: "object" } },
      usageMetadata: { type: "object" },
    },
  },
  BedrockInvokeRequest: {
    type: "object",
    description:
      "Model-dependent Bedrock invoke body (e.g. Anthropic Claude messages shape or Llama prompt shape); passed through to fixture matching.",
  },
  BedrockInvokeResponse: {
    type: "object",
    description: "Model-dependent Bedrock invoke result, replayed from the matched fixture.",
  },
  BedrockConverseRequest: {
    type: "object",
    required: ["messages"],
    properties: {
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["user", "assistant"] },
            content: { type: "array", items: { type: "object" } },
          },
        },
      },
      system: { type: "array", items: { type: "object" } },
      inferenceConfig: {
        type: "object",
        properties: {
          maxTokens: { type: "integer" },
          temperature: { type: "number" },
          topP: { type: "number" },
          stopSequences: { type: "array", items: { type: "string" } },
        },
      },
      toolConfig: { type: "object" },
    },
  },
  BedrockConverseResponse: {
    type: "object",
    properties: {
      output: {
        type: "object",
        properties: {
          message: {
            type: "object",
            properties: {
              role: { type: "string" },
              content: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
      stopReason: { type: "string" },
      usage: {
        type: "object",
        properties: {
          inputTokens: { type: "integer" },
          outputTokens: { type: "integer" },
          totalTokens: { type: "integer" },
        },
      },
    },
  },
  VideoSubmitRequest: {
    type: "object",
    required: ["prompt"],
    properties: {
      model: { type: "string" },
      prompt: { type: "string" },
      size: { type: "string" },
      seconds: { type: "string" },
      n: { type: "integer" },
    },
  },
  VideoJob: {
    type: "object",
    required: ["id", "status"],
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["queued", "in_progress", "completed", "failed"] },
      created_at: { type: "integer" },
      url: { type: "string" },
      progress: { type: "number" },
    },
  },
  OpenRouterVideoSubmitRequest: {
    type: "object",
    required: ["model", "prompt"],
    properties: {
      model: { type: "string" },
      prompt: { type: "string" },
      aspect_ratio: { type: "string" },
      duration: { type: "number" },
    },
  },
  OpenRouterVideoJob: {
    type: "object",
    required: ["id", "status"],
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["queued", "in_progress", "completed", "failed"] },
      created_at: { type: "integer" },
    },
  },
  OpenRouterVideoModelsResponse: {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            canonical_slug: { type: "string" },
            name: { type: "string" },
            created: { type: "integer" },
            description: { type: "string" },
            context_length: { type: "integer" },
          },
        },
      },
    },
  },
  OpenRouterKeyResponse: {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          label: { type: "string" },
          usage: { type: "number" },
          limit: { type: ["number", "null"] },
          limit_remaining: { type: ["number", "null"] },
          is_free_tier: { type: "boolean" },
          rate_limit: {
            type: "object",
            properties: {
              requests: { type: "integer" },
              interval: { type: "string" },
            },
          },
        },
      },
    },
  },
  OpenRouterCreditsResponse: {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          total_credits: { type: "number" },
          total_usage: { type: "number" },
        },
      },
    },
  },
  BytePlusSubmitRequest: {
    type: "object",
    required: ["model", "content"],
    properties: {
      model: { type: "string" },
      content: { type: "array", items: { type: "object" } },
    },
  },
  BytePlusTaskStatus: {
    type: "object",
    required: ["id", "status"],
    properties: {
      id: { type: "string" },
      model: { type: "string" },
      status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
      created_at: { type: "integer" },
    },
  },
  VeoSubmitRequest: {
    type: "object",
    description: "Veo `:predictLongRunning` body (instances + parameters), recorded and replayed.",
    properties: {
      instances: { type: "array", items: { type: "object" } },
      parameters: { type: "object" },
    },
  },
  VeoOperation: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      done: { type: "boolean" },
      metadata: { type: "object" },
      response: { type: "object" },
      error: { $ref: "#/components/schemas/ErrorResponse" },
    },
  },
  ElevenLabsTTSRequest: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string" },
      model_id: { type: "string" },
      voice_settings: {
        type: "object",
        properties: {
          stability: { type: "number" },
          similarity_boost: { type: "number" },
          style: { type: "number" },
        },
      },
      output_format: { type: "string" },
    },
  },
  ElevenLabsVoice: {
    type: "object",
    required: ["voice_id"],
    properties: {
      voice_id: { type: "string" },
      name: { type: "string" },
      category: { type: "string" },
      description: { type: "string" },
    },
  },
  ElevenLabsMusicRequest: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      text: { type: "string" },
      model_id: { type: "string" },
      duration_seconds: { type: "number" },
      output_format: { type: "string" },
    },
  },
  SoundGenerationRequest: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string" },
      duration_seconds: { type: "number" },
      prompt_influence: { type: "number" },
      model_id: { type: "string" },
      output_format: { type: "string" },
    },
  },
  VoiceDesignRequest: {
    type: "object",
    required: ["voice_description"],
    properties: {
      voice_description: {
        type: "string",
        minLength: 20,
        description: "At least 20 code points; shorter values 400.",
      },
      model_id: { type: "string" },
      text: { type: "string" },
      auto_generate_text: { type: "boolean" },
      loudness: { type: "number" },
      quality: { type: "string" },
      seed: { type: "integer" },
      guidance_scale: { type: "number" },
    },
  },
  VoiceDesignPreviewResponse: {
    type: "object",
    properties: {
      previews: {
        type: "array",
        items: {
          type: "object",
          required: ["generated_voice_id"],
          properties: {
            generated_voice_id: { type: "string" },
            audio_base_64: { type: "string" },
            media_type: { type: "string" },
            duration_secs: { type: "number" },
            language: { type: "string" },
          },
        },
      },
      text: { type: "string" },
    },
  },
  VoiceCreateRequest: {
    type: "object",
    required: ["voice_name", "generated_voice_id"],
    properties: {
      voice_name: { type: "string" },
      generated_voice_id: { type: "string" },
      voice_description: { type: "string" },
      labels: { type: "object" },
    },
  },
  VoiceCreateResponse: {
    type: "object",
    required: ["voice_id"],
    properties: {
      voice_id: { type: "string" },
    },
  },
  FalQueueSubmitResponse: {
    type: "object",
    required: ["request_id"],
    properties: {
      request_id: { type: "string" },
      response_url: { type: "string" },
      status_url: { type: "string" },
    },
  },
  FalQueueStatusResponse: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"] },
      request_id: { type: "string" },
      response: { type: "object" },
      queue_position: { type: "integer" },
    },
  },
  FalRunRequest: {
    type: "object",
    description: "Model-dependent synchronous run input, matched against fixtures.",
  },
  FalRunResponse: {
    type: "object",
    description: "Synchronous fal.ai result, replayed from the matched fixture.",
  },
  FalQueueSubmitRequest: {
    type: "object",
    description: "Model-dependent queue input, matched against fixtures.",
  },
  FileUploadRequest: {
    type: "object",
    required: ["file"],
    description: "Multipart form (file + optional purpose/filename) or a JSON body.",
    properties: {
      file: { type: "string", format: "binary", description: "File bytes (multipart)" },
      purpose: { type: "string" },
      filename: { type: "string" },
    },
  },
  FileObject: {
    type: "object",
    required: ["id", "object", "bytes", "created_at", "filename", "purpose", "status"],
    properties: {
      id: { type: "string" },
      object: { type: "string", enum: ["file"] },
      bytes: { type: "integer" },
      created_at: { type: "integer" },
      filename: { type: "string" },
      purpose: { type: "string" },
      status: { type: "string", enum: ["uploaded", "processed", "pending", "error"] },
      status_details: { type: "string" },
    },
  },
  FileListResponse: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: { $ref: "#/components/schemas/FileObject" } },
    },
  },
  FileDeleteResponse: {
    type: "object",
    required: ["id", "object", "deleted"],
    properties: {
      id: { type: "string" },
      object: { type: "string", enum: ["file"] },
      deleted: { type: "boolean" },
    },
  },
  FineTuningJobCreateRequest: {
    type: "object",
    required: ["training_file", "model"],
    properties: {
      training_file: { type: "string" },
      model: { type: "string" },
      validation_file: { type: ["string", "null"] },
      suffix: { type: ["string", "null"] },
      hyperparameters: {
        type: "object",
        properties: {
          n_epochs: { oneOf: [{ type: "integer" }, { type: "string", enum: ["auto"] }] },
          batch_size: { oneOf: [{ type: "integer" }, { type: "string", enum: ["auto"] }] },
          learning_rate_multiplier: {
            oneOf: [{ type: "number" }, { type: "string", enum: ["auto"] }],
          },
        },
      },
      seed: { type: ["integer", "null"] },
      integrations: { type: ["array", "null"], items: { type: "object" } },
      method: { type: ["object", "null"] },
      metadata: { type: ["object", "null"] },
    },
  },
  FineTuningJob: {
    type: "object",
    required: ["id", "object", "model", "training_file", "status", "created_at"],
    properties: {
      id: { type: "string" },
      object: { type: "string", enum: ["fine_tuning.job"] },
      model: { type: "string" },
      training_file: { type: "string" },
      validation_file: { type: ["string", "null"] },
      status: {
        type: "string",
        enum: ["validating_files", "queued", "running", "succeeded", "cancelled", "failed"],
      },
      created_at: { type: "integer" },
      finished_at: { type: ["integer", "null"] },
      fine_tuned_model: { type: ["string", "null"] },
      hyperparameters: { type: "object" },
      error: { type: ["object", "null"] },
      organization_id: { type: "string" },
      result_files: { type: "array", items: { type: "string" } },
      seed: { type: "integer" },
      trained_tokens: { type: ["integer", "null"] },
    },
  },
  FineTuningJobListResponse: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: { $ref: "#/components/schemas/FineTuningJob" } },
      has_more: { type: "boolean" },
    },
  },
  FineTuningJobEvent: {
    type: "object",
    required: ["id", "object", "created_at", "level", "message", "type"],
    properties: {
      id: { type: "string" },
      object: { type: "string", enum: ["fine_tuning.job.event"] },
      created_at: { type: "integer" },
      level: { type: "string", enum: ["info", "warn", "error"] },
      message: { type: "string" },
      type: { type: "string", enum: ["message"] },
    },
  },
  FineTuningJobEventListResponse: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: { $ref: "#/components/schemas/FineTuningJobEvent" } },
      has_more: { type: "boolean" },
    },
  },
  BatchCreateRequest: {
    type: "object",
    required: ["input_file_id", "endpoint", "completion_window"],
    properties: {
      input_file_id: { type: "string" },
      endpoint: {
        type: "string",
        enum: ["/v1/responses", "/v1/chat/completions", "/v1/embeddings", "/v1/completions"],
      },
      completion_window: { type: "string", enum: ["24h"] },
      metadata: { type: "object" },
    },
  },
  BatchObject: {
    type: "object",
    required: [
      "id",
      "object",
      "endpoint",
      "input_file_id",
      "completion_window",
      "status",
      "created_at",
    ],
    properties: {
      id: { type: "string" },
      object: { type: "string", enum: ["batch"] },
      endpoint: { type: "string" },
      input_file_id: { type: "string" },
      completion_window: { type: "string" },
      status: {
        type: "string",
        enum: [
          "validating",
          "in_progress",
          "completed",
          "failed",
          "expired",
          "cancelling",
          "cancelled",
        ],
      },
      created_at: { type: "integer" },
      metadata: { type: "object" },
      in_progress_at: { type: "integer" },
      completed_at: { type: "integer" },
      failed_at: { type: "integer" },
      expired_at: { type: "integer" },
      cancelling_at: { type: "integer" },
      cancelled_at: { type: "integer" },
      output_file_id: { type: "string" },
      error_file_id: { type: "string" },
      errors: {
        type: "object",
        properties: {
          object: { type: "string", enum: ["list"] },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                param: { type: ["string", "null"] },
                line: { type: ["integer", "null"] },
              },
            },
          },
        },
      },
      request_counts: {
        type: "object",
        properties: {
          total: { type: "integer" },
          completed: { type: "integer" },
          failed: { type: "integer" },
        },
      },
    },
  },
  BatchListResponse: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: { $ref: "#/components/schemas/BatchObject" } },
      has_more: { type: "boolean" },
      first_id: { type: ["string", "null"] },
      last_id: { type: ["string", "null"] },
    },
  },
  ModelsListResponse: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      data: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "object"],
          properties: {
            id: { type: "string" },
            object: { type: "string", enum: ["model"] },
            created: { type: "integer" },
            owned_by: { type: "string" },
          },
        },
      },
    },
  },
  HealthResponse: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      services: { type: "object" },
    },
  },
  JournalEntry: {
    type: "object",
    required: ["method", "path", "headers", "response"],
    properties: {
      method: { type: "string" },
      path: { type: "string" },
      headers: { type: "object" },
      body: { type: ["object", "null"] },
      response: {
        type: "object",
        properties: {
          status: { type: "integer" },
          fixture: { type: ["integer", "null"] },
        },
      },
      service: { type: "string" },
    },
  },
  ChaosConfig: {
    type: "object",
    description: "Install REPLACES the scope config wholesale; `{}` means explicitly no chaos.",
    properties: {
      dropRate: { type: "number", minimum: 0, maximum: 1 },
      malformedRate: { type: "number", minimum: 0, maximum: 1 },
      disconnectRate: { type: "number", minimum: 0, maximum: 1 },
      rateLimitRate: { type: "number", minimum: 0, maximum: 1 },
      latencyMs: { type: "integer", minimum: 0, maximum: 30000 },
    },
  },
  ChaosEnvelope: {
    type: "object",
    properties: {
      chaos: { $ref: "#/components/schemas/ChaosConfig" },
    },
  },
  FixturesAddRequest: {
    type: "object",
    required: ["fixtures"],
    properties: {
      fixtures: { type: "array", items: { type: "object" } },
    },
  },
  FixturesAddResponse: {
    type: "object",
    properties: {
      added: { type: "integer" },
    },
  },
  FixturesInspectResponse: {
    type: "object",
    properties: {
      count: { type: "integer" },
      fixtures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            match: { type: "object" },
            responseKind: { type: "string" },
          },
        },
      },
    },
  },
  FixturesClearResponse: {
    type: "object",
    properties: {
      cleared: { type: "boolean" },
    },
  },
  ResetResponse: {
    type: "object",
    properties: {
      reset: { type: "boolean" },
      deprecated: { type: "boolean" },
      deprecation: { type: "string" },
    },
  },
  ErrorInjectRequest: {
    type: "object",
    properties: {
      status: { type: "integer" },
      body: {
        type: "object",
        properties: {
          message: { type: "string" },
          type: { type: "string" },
          code: { type: "string" },
        },
      },
    },
  },
  ErrorInjectResponse: {
    type: "object",
    properties: {
      queued: { type: "boolean" },
    },
  },
  RoutesListResponse: {
    type: "object",
    properties: {
      count: { type: "integer" },
      routes: {
        type: "array",
        items: {
          type: "object",
          required: ["method", "path", "service", "description"],
          properties: {
            method: { type: "string" },
            path: { type: "string" },
            service: { type: "string" },
            description: { type: "string" },
          },
        },
      },
    },
  },
  OpenApiDocument: {
    type: "object",
    description: "The OpenAPI 3.1 document served by GET /__aimock/openapi.json.",
  },
  ErrorResponse: {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          message: { type: "string" },
          type: { type: "string" },
          code: {},
        },
      },
    },
  },
};

interface QueryParam {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  required?: boolean;
}

/** `METHOD path` → schemas + media types + query params for the operation. */
interface OperationSchemas {
  request?: string;
  response?: string;
  /** Request media type. Defaults to `application/json`. */
  reqContent?: string;
  /** Success response media type. Defaults to `application/json`. */
  respContent?: string;
  /** Success status + description override (e.g. replayed removals). */
  successStatus?: string;
  successDescription?: string;
  query?: QueryParam[];
}

const JSON = "application/json";
const MULTIPART = "multipart/form-data";
const AUDIO = "audio/mpeg";
const OCTET = "application/octet-stream";

const JOURNAL_QUERY: QueryParam[] = [
  { name: "limit", description: "Max entries (integer >= 0)", schema: { type: "integer" } },
  { name: "offset", description: "Entries to skip (integer >= 0)", schema: { type: "integer" } },
  { name: "path", description: "Substring filter on the request path", schema: { type: "string" } },
  {
    name: "method",
    description: "Exact method filter (case-insensitive)",
    schema: { type: "string" },
  },
  { name: "status", description: "Exact response status filter", schema: { type: "integer" } },
  { name: "service", description: "Exact service filter", schema: { type: "string" } },
  { name: "testId", description: "Test-id scope filter", schema: { type: "string" } },
  { name: "requestId", description: "Request-id filter", schema: { type: "string" } },
];

const SCHEMA_REFS: Record<string, OperationSchemas> = {
  [`POST ${COMPLETIONS_PATH}`]: {
    request: "ChatCompletionRequest",
    response: "ChatCompletionResponse",
  },
  [`POST ${RESPONSES_PATH}`]: { request: "ResponsesRequest", response: "ResponsesResponse" },
  [`POST ${MESSAGES_PATH}`]: { request: "MessagesRequest", response: "MessagesResponse" },
  [`POST ${EMBEDDINGS_PATH}`]: { request: "EmbeddingRequest", response: "EmbeddingResponse" },
  [`POST ${COHERE_CHAT_PATH}`]: { request: "CohereChatRequest", response: "CohereChatResponse" },
  [`POST ${COHERE_EMBED_PATH}`]: { request: "CohereEmbedRequest", response: "CohereEmbedResponse" },
  [`POST ${IMAGES_PATH}`]: {
    request: "ImageGenerationRequest",
    response: "ImageResponse",
  },
  "POST /v1/images/edits": {
    request: "ImageEditRequest",
    reqContent: MULTIPART,
    response: "ImageResponse",
  },
  "POST /v1/images/variations": {
    successStatus: "404",
    successDescription:
      "Removed upstream 2026-05-12 — aimock replays the removal with a 404 and an empty body.",
  },
  [`POST ${SPEECH_PATH}`]: { request: "SpeechRequest", respContent: AUDIO },
  "POST /v1/audio/transcriptions": {
    request: "TranscriptionRequest",
    reqContent: MULTIPART,
    response: "TranscriptionResponse",
  },
  "POST /v1/audio/translations": {
    request: "TranscriptionRequest",
    reqContent: MULTIPART,
    response: "TranscriptionResponse",
  },
  [`POST ${MODERATIONS_PATH}`]: {
    request: "ModerationRequest",
    response: "ModerationResponse",
  },
  [`GET ${MODELS_PATH}`]: { response: "ModelsListResponse" },
  [`POST ${SEARCH_PATH}`]: { request: "SearchRequest", response: "SearchResponse" },
  [`POST ${RERANK_PATH}`]: { request: "RerankRequest", response: "RerankResponse" },
  "POST /openai/deployments/{deploymentId}/chat/completions": {
    request: "ChatCompletionRequest",
    response: "ChatCompletionResponse",
  },
  "POST /openai/deployments/{deploymentId}/embeddings": {
    request: "EmbeddingRequest",
    response: "EmbeddingResponse",
  },
  // Ollama
  "POST /api/chat": { request: "OllamaChatRequest", response: "OllamaChatResponse" },
  "POST /api/generate": { request: "OllamaGenerateRequest", response: "OllamaGenerateResponse" },
  "POST /api/embeddings": { request: "OllamaEmbedRequest", response: "OllamaEmbedResponse" },
  "POST /api/embed": { request: "OllamaEmbedRequest", response: "OllamaEmbedResponse" },
  "GET /api/tags": { response: "OllamaTagsResponse" },
  // OpenAI Batches API
  "POST /v1/batches/{batch_id}/cancel": { response: "BatchObject" },
  "GET /v1/batches/{batch_id}": { response: "BatchObject" },
  "GET /v1/batches": {
    response: "BatchListResponse",
    query: [
      { name: "limit", description: "Max batches", schema: { type: "integer" } },
      { name: "after", description: "Pagination cursor", schema: { type: "string" } },
    ],
  },
  "POST /v1/batches": { request: "BatchCreateRequest", response: "BatchObject" },
  // OpenAI Files API
  "GET /v1/files/{file_id}/content": { respContent: OCTET },
  "GET /v1/files/{file_id}": { response: "FileObject" },
  "DELETE /v1/files/{file_id}": { response: "FileDeleteResponse" },
  "GET /v1/files": {
    response: "FileListResponse",
    query: [
      { name: "purpose", description: "Filter by purpose", schema: { type: "string" } },
      {
        name: "order",
        description: "Sort order",
        schema: { type: "string", enum: ["asc", "desc"] },
      },
      { name: "limit", description: "Max files", schema: { type: "integer" } },
      { name: "after", description: "Pagination cursor", schema: { type: "string" } },
    ],
  },
  "POST /v1/files": {
    request: "FileUploadRequest",
    reqContent: MULTIPART,
    response: "FileObject",
  },
  // OpenAI fine-tuning jobs
  "POST /v1/fine_tuning/jobs/{job_id}/cancel": { response: "FineTuningJob" },
  "GET /v1/fine_tuning/jobs/{job_id}/events": { response: "FineTuningJobEventListResponse" },
  "GET /v1/fine_tuning/jobs/{job_id}": { response: "FineTuningJob" },
  "GET /v1/fine_tuning/jobs": {
    response: "FineTuningJobListResponse",
    query: [
      { name: "limit", description: "Max jobs", schema: { type: "integer" } },
      { name: "after", description: "Pagination cursor", schema: { type: "string" } },
    ],
  },
  "POST /v1/fine_tuning/jobs": {
    request: "FineTuningJobCreateRequest",
    response: "FineTuningJob",
  },
  // Gemini
  "POST /v1beta/models/{model}:predict": {
    request: "GeminiPredictRequest",
    response: "GeminiPredictResponse",
  },
  "POST /v1beta/interactions": {
    request: "InteractionsRequest",
    response: "InteractionsResponse",
  },
  "POST /v1beta/models/{model}:embedContent": {
    request: "GeminiEmbedRequest",
    response: "GeminiEmbedResponse",
  },
  "POST /v1beta/models/{model}:generateContent": {
    request: "GeminiGenerateRequest",
    response: "GeminiGenerateResponse",
  },
  "POST /v1beta/models/{model}:streamGenerateContent": {
    request: "GeminiGenerateRequest",
    response: "GeminiGenerateResponse",
  },
  // Vertex AI (same shapes over the full resource path)
  "POST /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent":
    {
      request: "GeminiGenerateRequest",
      response: "GeminiGenerateResponse",
    },
  "POST /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent":
    {
      request: "GeminiGenerateRequest",
      response: "GeminiGenerateResponse",
    },
  // Bedrock
  "POST /model/{modelId}/invoke": {
    request: "BedrockInvokeRequest",
    response: "BedrockInvokeResponse",
  },
  "POST /model/{modelId}/invoke-with-response-stream": {
    request: "BedrockInvokeRequest",
    response: "BedrockInvokeResponse",
  },
  "POST /model/{modelId}/converse": {
    request: "BedrockConverseRequest",
    response: "BedrockConverseResponse",
  },
  "POST /model/{modelId}/converse-stream": {
    request: "BedrockConverseRequest",
    response: "BedrockConverseResponse",
  },
  // Video
  "POST /v1/videos": { request: "VideoSubmitRequest", response: "VideoJob" },
  "POST /v1/videos/generations": { request: "VideoSubmitRequest", response: "VideoJob" },
  "GET /v1/videos/{id}": { response: "VideoJob" },
  "POST /api/v1/videos": {
    request: "OpenRouterVideoSubmitRequest",
    response: "OpenRouterVideoJob",
  },
  "GET /api/v1/videos/models": { response: "OpenRouterVideoModelsResponse" },
  "GET /api/v1/videos/{jobId}": { response: "OpenRouterVideoJob" },
  "GET /api/v1/videos/{jobId}/content": { respContent: OCTET },
  "POST /contents/generations/tasks": {
    request: "BytePlusSubmitRequest",
    response: "BytePlusTaskStatus",
  },
  "POST /api/v3/contents/generations/tasks": {
    request: "BytePlusSubmitRequest",
    response: "BytePlusTaskStatus",
  },
  "GET /contents/generations/tasks/{id}": { response: "BytePlusTaskStatus" },
  "GET /api/v3/contents/generations/tasks/{id}": { response: "BytePlusTaskStatus" },
  "POST /v1beta/models/{model}:predictLongRunning": {
    request: "VeoSubmitRequest",
    response: "VeoOperation",
  },
  "GET /v1beta/operations/{name}": { response: "VeoOperation" },
  // OpenRouter discovery
  "GET /api/v1/models": { response: "OpenRouterVideoModelsResponse" },
  "GET /api/v1/key": { response: "OpenRouterKeyResponse" },
  "GET /api/v1/credits": { response: "OpenRouterCreditsResponse" },
  // ElevenLabs
  "POST /v1/sound-generation": { request: "SoundGenerationRequest", respContent: AUDIO },
  "POST /v1/text-to-voice/design": {
    request: "VoiceDesignRequest",
    response: "VoiceDesignPreviewResponse",
  },
  "POST /v1/text-to-voice": { request: "VoiceCreateRequest", response: "VoiceCreateResponse" },
  "GET /v1/voices/{voice_id}": { response: "ElevenLabsVoice" },
  "DELETE /v1/voices/{voice_id}": { response: "ElevenLabsVoice" },
  "POST /v1/text-to-speech/{voice_id}": { request: "ElevenLabsTTSRequest", respContent: AUDIO },
  "POST /v1/music": { request: "ElevenLabsMusicRequest", respContent: AUDIO },
  "POST /v1/music/{subtype}": { request: "ElevenLabsMusicRequest", respContent: AUDIO },
  // fal.ai
  "POST /fal/queue/submit/{model}": {
    request: "FalQueueSubmitRequest",
    response: "FalQueueSubmitResponse",
  },
  "GET /fal/queue/requests/{requestId}": { response: "FalQueueStatusResponse" },
  "POST /fal/queue/requests/{requestId}": { response: "FalQueueStatusResponse" },
  "PUT /fal/queue/requests/{requestId}": { response: "FalQueueStatusResponse" },
  "POST /fal/run/{model}": { request: "FalRunRequest", response: "FalRunResponse" },
  // Ops
  "GET /health": { response: "HealthResponse" },
  "GET /ready": { response: "HealthResponse" },
  "GET /metrics": { respContent: "text/plain; version=0.0.4" },
  // Legacy journal
  "GET /v1/_requests": {
    response: "JournalEntry",
    query: [{ name: "limit", description: "Max entries", schema: { type: "integer" } }],
  },
  "DELETE /v1/_requests": {
    successStatus: "204",
    successDescription: "Journal entries cleared (fixture sequencing preserved).",
  },
  // Control API
  "GET /__aimock/health": { response: "HealthResponse" },
  "GET /__aimock/journal": { response: "JournalEntry", query: JOURNAL_QUERY },
  "GET /__aimock/fixtures": {
    response: "FixturesInspectResponse",
    query: [
      {
        name: "include",
        description: "Set to 'fixtures' for the full redacted dump",
        schema: { type: "string", enum: ["fixtures"] },
      },
    ],
  },
  "POST /__aimock/fixtures": {
    request: "FixturesAddRequest",
    response: "FixturesAddResponse",
  },
  "DELETE /__aimock/fixtures": { response: "FixturesClearResponse" },
  "GET /__aimock/chaos": { response: "ChaosEnvelope" },
  "POST /__aimock/chaos": { request: "ChaosConfig", response: "ChaosEnvelope" },
  "DELETE /__aimock/chaos": { response: "ChaosEnvelope" },
  "POST /__aimock/reset": { response: "ResetResponse" },
  "POST /__aimock/reset/journal": { response: "ResetResponse" },
  "POST /__aimock/reset/fixtures": { response: "ResetResponse" },
  "POST /__aimock/error": { request: "ErrorInjectRequest", response: "ErrorInjectResponse" },
  "GET /__aimock/openapi.json": { response: "OpenApiDocument" },
  "GET /__aimock/routes": { response: "RoutesListResponse" },
};

function operationFor(
  method: string,
  path: string,
  service: string,
  description: string,
): Record<string, unknown> {
  const params = pathParams(path);
  const refs = SCHEMA_REFS[`${method} ${path}`];
  const operation: Record<string, unknown> = {
    summary: description,
    tags: [service],
  };
  if (refs?.query) {
    for (const q of refs.query) {
      params.push({
        name: q.name,
        in: "query",
        required: q.required ?? false,
        description: q.description,
        schema: q.schema,
      });
    }
  }
  if (params.length > 0) operation.parameters = params;
  const reqContent = refs?.reqContent ?? JSON;
  if (refs?.request) {
    operation.requestBody = {
      required: true,
      content: {
        [reqContent]: {
          schema: { $ref: `#/components/schemas/${refs.request}` },
        },
      },
    };
  }
  const respContent = refs?.respContent ?? JSON;
  const successStatus = refs?.successStatus ?? "200";
  const successDescription = refs?.successDescription ?? "OK";
  const successSchema = refs?.response
    ? { $ref: `#/components/schemas/${refs.response}` }
    : respContent !== JSON
      ? { type: "string", format: "binary" }
      : undefined;
  // Array envelopes (journal listing) are bare arrays, not objects.
  const successContent =
    refs?.response === "JournalEntry"
      ? {
          [respContent]: {
            schema: { type: "array", items: { $ref: "#/components/schemas/JournalEntry" } },
          },
        }
      : successSchema
        ? { [respContent]: { schema: successSchema } }
        : undefined;
  operation.responses = {
    [successStatus]: {
      description: successDescription,
      ...(successContent ? { content: successContent } : undefined),
    },
    ...(successStatus === "200"
      ? {
          "400": {
            description: "Invalid request",
            content: {
              [JSON]: { schema: { $ref: "#/components/schemas/ErrorResponse" } },
            },
          },
          "404": {
            description: "No fixture match",
            content: {
              [JSON]: { schema: { $ref: "#/components/schemas/ErrorResponse" } },
            },
          },
        }
      : undefined),
  };
  return operation;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTE_DEFINITIONS) {
    const item = (paths[r.path] ??= {});
    item[r.method.toLowerCase()] = operationFor(r.method, r.path, r.service, r.description);
  }
  return {
    openapi: "3.1.0",
    info: { title: "aimock", version: "1.0.0" },
    paths,
    components: { schemas: COMPONENTS },
  };
}
