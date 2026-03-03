/**
 * Google Gemini GenerateContent API support.
 *
 * Translates incoming Gemini requests into the ChatCompletionRequest format
 * used by the fixture router, and converts fixture responses back into the
 * Gemini GenerateContent streaming (or non-streaming) format.
 */

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { isTextResponse, isToolCallResponse, isErrorResponse } from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";

// ─── Gemini request types ───────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role?: string;
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: object;
}

interface GeminiToolDef {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

interface GeminiRequest {
  contents?: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: GeminiToolDef[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Input conversion: Gemini → ChatCompletions messages ────────────────────

export function geminiToCompletionRequest(
  req: GeminiRequest,
  model: string,
  stream: boolean,
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // systemInstruction → system message
  if (req.systemInstruction) {
    const text = req.systemInstruction.parts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text!)
      .join("");
    if (text) {
      messages.push({ role: "system", content: text });
    }
  }

  if (req.contents) {
    for (const content of req.contents) {
      const role = content.role ?? "user";

      if (role === "user") {
        // Check for functionResponse parts
        const funcResponses = content.parts.filter((p) => p.functionResponse);
        const textParts = content.parts.filter((p) => p.text !== undefined);

        if (funcResponses.length > 0) {
          // functionResponse → tool message
          for (let i = 0; i < funcResponses.length; i++) {
            const part = funcResponses[i];
            messages.push({
              role: "tool",
              content:
                typeof part.functionResponse!.response === "string"
                  ? part.functionResponse!.response
                  : JSON.stringify(part.functionResponse!.response),
              tool_call_id: `call_gemini_${part.functionResponse!.name}_${i}`,
            });
          }
          // Any text parts alongside → user message
          if (textParts.length > 0) {
            messages.push({
              role: "user",
              content: textParts.map((p) => p.text!).join(""),
            });
          }
        } else {
          // Regular user text
          const text = textParts.map((p) => p.text!).join("");
          messages.push({ role: "user", content: text });
        }
      } else if (role === "model") {
        // Check for functionCall parts
        const funcCalls = content.parts.filter((p) => p.functionCall);
        const textParts = content.parts.filter((p) => p.text !== undefined);

        if (funcCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: funcCalls.map((p, i) => ({
              id: `call_gemini_${p.functionCall!.name}_${i}`,
              type: "function" as const,
              function: {
                name: p.functionCall!.name,
                arguments: JSON.stringify(p.functionCall!.args),
              },
            })),
          });
        } else {
          const text = textParts.map((p) => p.text!).join("");
          messages.push({ role: "assistant", content: text });
        }
      }
    }
  }

  // Convert tools
  let tools: ToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    const decls = req.tools.flatMap((t) => t.functionDeclarations ?? []);
    if (decls.length > 0) {
      tools = decls.map((d) => ({
        type: "function" as const,
        function: {
          name: d.name,
          description: d.description,
          parameters: d.parameters,
        },
      }));
    }
  }

  return {
    model,
    messages,
    stream,
    temperature: req.generationConfig?.temperature,
    tools,
  };
}

// ─── Response building: fixture → Gemini format ─────────────────────────────

interface GeminiResponseChunk {
  candidates: {
    content: { role: string; parts: GeminiPart[] };
    finishReason?: string;
    index: number;
  }[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

function buildGeminiTextStreamChunks(content: string, chunkSize: number): GeminiResponseChunk[] {
  const chunks: GeminiResponseChunk[] = [];

  // Content chunks
  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= content.length;
    const chunk: GeminiResponseChunk = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: slice }] },
          index: 0,
          ...(isLast ? { finishReason: "STOP" } : {}),
        },
      ],
      ...(isLast
        ? {
            usageMetadata: {
              promptTokenCount: 0,
              candidatesTokenCount: 0,
              totalTokenCount: 0,
            },
          }
        : {}),
    };
    chunks.push(chunk);
  }

  // Handle empty content
  if (content.length === 0) {
    chunks.push({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
      },
    });
  }

  return chunks;
}

function buildGeminiToolCallStreamChunks(toolCalls: ToolCall[]): GeminiResponseChunk[] {
  const parts: GeminiPart[] = toolCalls.map((tc) => {
    let argsObj: Record<string, unknown>;
    try {
      argsObj = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
    } catch {
      argsObj = {};
    }
    return {
      functionCall: { name: tc.name, args: argsObj },
    };
  });

  // Gemini sends all tool calls in a single response chunk
  return [
    {
      candidates: [
        {
          content: { role: "model", parts },
          finishReason: "FUNCTION_CALL",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
      },
    },
  ];
}

// Non-streaming response builders

function buildGeminiTextResponse(content: string): GeminiResponseChunk {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text: content }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    },
  };
}

function buildGeminiToolCallResponse(toolCalls: ToolCall[]): GeminiResponseChunk {
  const parts: GeminiPart[] = toolCalls.map((tc) => {
    let argsObj: Record<string, unknown>;
    try {
      argsObj = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
    } catch {
      argsObj = {};
    }
    return {
      functionCall: { name: tc.name, args: argsObj },
    };
  });

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: "FUNCTION_CALL",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    },
  };
}

// ─── SSE writer for Gemini streaming ────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeGeminiSSEStream(
  res: http.ServerResponse,
  chunks: GeminiResponseChunk[],
  latency = 0,
): Promise<void> {
  if (res.writableEnded) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  for (const chunk of chunks) {
    if (latency > 0) await delay(latency);
    if (res.writableEnded) return;
    // Gemini uses data-only SSE (no event: prefix, no [DONE])
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  if (!res.writableEnded) {
    res.end();
  }
}

// ─── Request handler ────────────────────────────────────────────────────────

export async function handleGemini(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  model: string,
  streaming: boolean,
  fixtures: Fixture[],
  journal: Journal,
  defaults: { latency: number; chunkSize: number },
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  setCorsHeaders(res);

  let geminiReq: GeminiRequest;
  try {
    geminiReq = JSON.parse(raw) as GeminiRequest;
  } catch {
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          code: 400,
          status: "INVALID_ARGUMENT",
        },
      }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = geminiToCompletionRequest(geminiReq, model, streaming);

  const fixture = matchFixture(fixtures, completionReq);
  const path = req.url ?? `/v1beta/models/${model}:generateContent`;

  if (!fixture) {
    journal.add({
      method: req.method ?? "POST",
      path,
      headers: {},
      body: completionReq,
      response: { status: 404, fixture: null },
    });
    writeErrorResponse(
      res,
      404,
      JSON.stringify({
        error: {
          message: "No fixture matched",
          code: 404,
          status: "NOT_FOUND",
        },
      }),
    );
    return;
  }

  const response = fixture.response;
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path,
      headers: {},
      body: completionReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path,
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildGeminiTextResponse(response.content);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildGeminiTextStreamChunks(response.content, chunkSize);
      await writeGeminiSSEStream(res, chunks, latency);
    }
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path,
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });
    if (!streaming) {
      const body = buildGeminiToolCallResponse(response.toolCalls);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      const chunks = buildGeminiToolCallStreamChunks(response.toolCalls);
      await writeGeminiSSEStream(res, chunks, latency);
    }
    return;
  }

  // Unknown response type
  journal.add({
    method: req.method ?? "POST",
    path,
    headers: {},
    body: completionReq,
    response: { status: 500, fixture },
  });
  writeErrorResponse(
    res,
    500,
    JSON.stringify({
      error: {
        message: "Fixture response did not match any known type",
        code: 500,
        status: "INTERNAL",
      },
    }),
  );
}
