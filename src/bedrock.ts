/**
 * AWS Bedrock Claude endpoint support — invoke and invoke-with-response-stream.
 *
 * Handles four Bedrock endpoint families (split across two modules):
 *
 *   This file (bedrock.ts):
 *     - POST /model/{modelId}/invoke                  — non-streaming invoke
 *     - POST /model/{modelId}/invoke-with-response-stream — binary EventStream streaming
 *
 *   bedrock-converse.ts:
 *     - POST /model/{modelId}/converse                — Converse API (non-streaming)
 *     - POST /model/{modelId}/converse-stream         — Converse API (EventStream streaming)
 *
 * Translates incoming Bedrock Claude format into the ChatCompletionRequest
 * format used by the fixture router, and converts fixture responses back into
 * the appropriate Bedrock response format (JSON for invoke, AWS Event Stream
 * binary encoding for streaming).
 */

import type * as http from "node:http";
import type {
  ChatCompletionRequest,
  ChatMessage,
  Fixture,
  HandlerDefaults,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import {
  generateMessageId,
  generateToolUseId,
  isTextResponse,
  isToolCallResponse,
  isErrorResponse,
  flattenHeaders,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { writeEventStream } from "./aws-event-stream.js";
import { createInterruptionSignal } from "./interruption.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaos } from "./chaos.js";
import { proxyAndRecord } from "./recorder.js";

// ─── Bedrock Claude request types ────────────────────────────────────────────

interface BedrockContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image" | "document";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | BedrockContentBlock[];
  is_error?: boolean;
}

interface BedrockMessage {
  role: "user" | "assistant";
  content: string | BedrockContentBlock[];
}

interface BedrockToolDef {
  name: string;
  description?: string;
  input_schema?: object;
}

interface BedrockRequest {
  anthropic_version?: string;
  messages: BedrockMessage[];
  system?: string | BedrockContentBlock[];
  tools?: BedrockToolDef[];
  tool_choice?: unknown;
  max_tokens: number;
  temperature?: number;
  [key: string]: unknown;
}

// ─── Input conversion: Bedrock → ChatCompletionRequest ──────────────────────

function extractTextContent(content: string | BedrockContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

export function bedrockToCompletionRequest(
  req: BedrockRequest,
  modelId: string,
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // system field → system message
  if (req.system) {
    const systemText =
      typeof req.system === "string"
        ? req.system
        : req.system
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  for (const msg of req.messages) {
    if (msg.role === "user") {
      // Check for tool_result blocks
      if (typeof msg.content !== "string" && Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const textBlocks = msg.content.filter((b) => b.type === "text");

        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            const resultContent =
              typeof tr.content === "string"
                ? tr.content
                : Array.isArray(tr.content)
                  ? tr.content
                      .filter((b) => b.type === "text")
                      .map((b) => b.text ?? "")
                      .join("")
                  : "";
            messages.push({
              role: "tool",
              content: resultContent,
              tool_call_id: tr.tool_use_id,
            });
          }
          if (textBlocks.length > 0) {
            messages.push({
              role: "user",
              content: textBlocks.map((b) => b.text ?? "").join(""),
            });
          }
          continue;
        }
      }
      messages.push({
        role: "user",
        content: extractTextContent(msg.content),
      });
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        messages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
        const textContent = extractTextContent(msg.content);

        if (toolUseBlocks.length > 0) {
          messages.push({
            role: "assistant",
            content: textContent || null,
            tool_calls: toolUseBlocks.map((b) => ({
              id: b.id ?? generateToolUseId(),
              type: "function" as const,
              function: {
                name: b.name ?? "",
                arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}),
              },
            })),
          });
        } else {
          messages.push({ role: "assistant", content: textContent || null });
        }
      } else {
        messages.push({ role: "assistant", content: null });
      }
    }
  }

  // Convert tools
  let tools: ToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  return {
    model: modelId,
    messages,
    stream: false,
    temperature: req.temperature,
    tools,
  };
}

// ─── Response builders ──────────────────────────────────────────────────────

function buildBedrockTextResponse(content: string, model: string): object {
  return {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: content }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function buildBedrockToolCallResponse(
  toolCalls: ToolCall[],
  model: string,
  logger: Logger,
): object {
  return {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    content: toolCalls.map((tc) => {
      let argsObj: unknown;
      try {
        argsObj = JSON.parse(tc.arguments || "{}");
      } catch {
        logger.warn(
          `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
        );
        argsObj = {};
      }
      return {
        type: "tool_use",
        id: tc.id || generateToolUseId(),
        name: tc.name,
        input: argsObj,
      };
    }),
    model,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ─── Request handler ────────────────────────────────────────────────────────

export async function handleBedrock(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  modelId: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  const urlPath = req.url ?? `/model/${modelId}/invoke`;

  let bedrockReq: BedrockRequest;
  try {
    bedrockReq = JSON.parse(raw) as BedrockRequest;
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!bedrockReq.messages || !Array.isArray(bedrockReq.messages)) {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Invalid request: messages array is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Convert to ChatCompletionRequest for fixture matching
  const completionReq = bedrockToCompletionRequest(bedrockReq, modelId);

  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.fixtureMatchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      {
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: completionReq,
      },
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      const proxied = await proxyAndRecord(
        req,
        res,
        completionReq,
        "bedrock",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null },
        });
        return;
      }
    }
    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (defaults.strict) {
      logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${urlPath}`);
    }
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: strictStatus, fixture: null },
    });
    writeErrorResponse(
      res,
      strictStatus,
      JSON.stringify({
        error: {
          message: strictMessage,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const response = fixture.response;

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    // Anthropic-style error format (Bedrock uses Claude): { type: "error", error: { type, message } }
    const anthropicError = {
      type: "error",
      error: {
        type: response.error.type ?? "api_error",
        message: response.error.message,
      },
    };
    writeErrorResponse(res, status, JSON.stringify(anthropicError));
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const body = buildBedrockTextResponse(response.content, completionReq.model);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const body = buildBedrockToolCallResponse(response.toolCalls, completionReq.model, logger);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Unknown response type
  journal.add({
    method: req.method ?? "POST",
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: completionReq,
    response: { status: 500, fixture },
  });
  writeErrorResponse(
    res,
    500,
    JSON.stringify({
      error: {
        message: "Fixture response did not match any known type",
        type: "server_error",
      },
    }),
  );
}

// ─── Streaming event builders ───────────────────────────────────────────────

export function buildBedrockStreamTextEvents(
  content: string,
  chunkSize: number,
): Array<{ eventType: string; payload: object }> {
  const events: Array<{ eventType: string; payload: object }> = [];

  events.push({
    eventType: "messageStart",
    payload: { role: "assistant" },
  });

  events.push({
    eventType: "contentBlockStart",
    payload: { contentBlockIndex: 0, start: {} },
  });

  for (let i = 0; i < content.length; i += chunkSize) {
    const slice = content.slice(i, i + chunkSize);
    events.push({
      eventType: "contentBlockDelta",
      payload: {
        contentBlockIndex: 0,
        delta: { type: "text_delta", text: slice },
      },
    });
  }

  events.push({
    eventType: "contentBlockStop",
    payload: { contentBlockIndex: 0 },
  });

  events.push({
    eventType: "messageStop",
    payload: { stopReason: "end_turn" },
  });

  return events;
}

export function buildBedrockStreamToolCallEvents(
  toolCalls: ToolCall[],
  chunkSize: number,
  logger: Logger,
): Array<{ eventType: string; payload: object }> {
  const events: Array<{ eventType: string; payload: object }> = [];

  events.push({
    eventType: "messageStart",
    payload: { role: "assistant" },
  });

  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    const toolUseId = tc.id || generateToolUseId();

    events.push({
      eventType: "contentBlockStart",
      payload: {
        contentBlockIndex: tcIdx,
        start: {
          toolUse: { toolUseId, name: tc.name },
        },
      },
    });

    let argsStr: string;
    try {
      const parsed = JSON.parse(tc.arguments || "{}");
      argsStr = JSON.stringify(parsed);
    } catch {
      logger.warn(
        `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
      );
      argsStr = "{}";
    }

    for (let i = 0; i < argsStr.length; i += chunkSize) {
      const slice = argsStr.slice(i, i + chunkSize);
      events.push({
        eventType: "contentBlockDelta",
        payload: {
          contentBlockIndex: tcIdx,
          delta: { type: "input_json_delta", inputJSON: slice },
        },
      });
    }

    events.push({
      eventType: "contentBlockStop",
      payload: { contentBlockIndex: tcIdx },
    });
  }

  events.push({
    eventType: "messageStop",
    payload: { stopReason: "tool_use" },
  });

  return events;
}

// ─── Streaming request handler ──────────────────────────────────────────────

export async function handleBedrockStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  modelId: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const { logger } = defaults;
  setCorsHeaders(res);

  const urlPath = req.url ?? `/model/${modelId}/invoke-with-response-stream`;

  let bedrockReq: BedrockRequest;
  try {
    bedrockReq = JSON.parse(raw) as BedrockRequest;
  } catch {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Malformed JSON",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  if (!bedrockReq.messages || !Array.isArray(bedrockReq.messages)) {
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 400, fixture: null },
    });
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: "Invalid request: messages array is required",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const completionReq = bedrockToCompletionRequest(bedrockReq, modelId);

  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.fixtureMatchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures);
  }

  if (
    applyChaos(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      journal,
      {
        method: req.method ?? "POST",
        path: urlPath,
        headers: flattenHeaders(req.headers),
        body: completionReq,
      },
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    if (defaults.record) {
      const proxied = await proxyAndRecord(
        req,
        res,
        completionReq,
        "bedrock",
        urlPath,
        fixtures,
        defaults,
        raw,
      );
      if (proxied) {
        journal.add({
          method: req.method ?? "POST",
          path: urlPath,
          headers: flattenHeaders(req.headers),
          body: completionReq,
          response: { status: res.statusCode ?? 200, fixture: null },
        });
        return;
      }
    }
    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    if (defaults.strict) {
      logger.error(`STRICT: No fixture matched for ${req.method ?? "POST"} ${urlPath}`);
    }
    journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: strictStatus, fixture: null },
    });
    writeErrorResponse(
      res,
      strictStatus,
      JSON.stringify({
        error: {
          message: strictMessage,
          type: "invalid_request_error",
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
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  // Text response — stream as Event Stream
  if (isTextResponse(response)) {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const events = buildBedrockStreamTextEvents(response.content, chunkSize);
    const interruption = createInterruptionSignal(fixture);
    const completed = await writeEventStream(res, events, {
      latency,
      streamingProfile: fixture.streamingProfile,
      signal: interruption?.signal,
      onChunkSent: interruption?.tick,
    });
    if (!completed) {
      if (!res.writableEnded) res.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
    }
    interruption?.cleanup();
    return;
  }

  // Tool call response — stream as Event Stream
  if (isToolCallResponse(response)) {
    const journalEntry = journal.add({
      method: req.method ?? "POST",
      path: urlPath,
      headers: flattenHeaders(req.headers),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const events = buildBedrockStreamToolCallEvents(response.toolCalls, chunkSize, logger);
    const interruption = createInterruptionSignal(fixture);
    const completed = await writeEventStream(res, events, {
      latency,
      streamingProfile: fixture.streamingProfile,
      signal: interruption?.signal,
      onChunkSent: interruption?.tick,
    });
    if (!completed) {
      if (!res.writableEnded) res.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
    }
    interruption?.cleanup();
    return;
  }

  // Unknown response type
  journal.add({
    method: req.method ?? "POST",
    path: urlPath,
    headers: flattenHeaders(req.headers),
    body: completionReq,
    response: { status: 500, fixture },
  });
  writeErrorResponse(
    res,
    500,
    JSON.stringify({
      error: {
        message: "Fixture response did not match any known type",
        type: "server_error",
      },
    }),
  );
}
