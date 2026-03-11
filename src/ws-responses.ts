/**
 * WebSocket handler for OpenAI Responses API.
 *
 * Accepts `{ type: "response.create", response: { ... } }` messages over
 * WebSocket and sends back the same Responses API SSE events as the HTTP
 * handler, but as individual WebSocket text frames.
 */

import type { Fixture } from "./types.js";
import { matchFixture } from "./router.js";
import {
  responsesToCompletionRequest,
  buildTextStreamEvents,
  buildToolCallStreamEvents,
  type ResponsesSSEEvent,
} from "./responses.js";
import { isTextResponse, isToolCallResponse, isErrorResponse } from "./helpers.js";
import type { Journal } from "./journal.js";
import type { WebSocketConnection } from "./ws-framing.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ResponseCreateMessage {
  type: "response.create";
  response: {
    model?: string;
    input?: unknown[];
    instructions?: string;
    tools?: unknown[];
    tool_choice?: string | object;
    stream?: boolean;
    temperature?: number;
    max_output_tokens?: number;
    [key: string]: unknown;
  };
}

function isResponseCreateMessage(msg: unknown): msg is ResponseCreateMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as ResponseCreateMessage).type === "response.create" &&
    typeof (msg as ResponseCreateMessage).response === "object"
  );
}

function buildErrorEvent(
  message: string,
  type = "invalid_request_error",
  code?: string,
): ResponsesSSEEvent {
  return {
    type: "error",
    error: { message, type, code },
  };
}

export function handleWebSocketResponses(
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  defaults: { latency: number; chunkSize: number; model: string },
): void {
  // Serialize message processing to prevent event interleaving
  let pending = Promise.resolve();
  ws.on("message", (raw: string) => {
    pending = pending.then(() =>
      processMessage(raw, ws, fixtures, journal, defaults).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Internal error";
        try {
          ws.send(JSON.stringify(buildErrorEvent(msg, "server_error")));
        } catch {
          // Connection already gone
        }
      }),
    );
  });
}

async function processMessage(
  raw: string,
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  defaults: { latency: number; chunkSize: number; model: string },
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ws.send(
      JSON.stringify(buildErrorEvent("Malformed JSON", "invalid_request_error", "invalid_json")),
    );
    return;
  }

  if (!isResponseCreateMessage(parsed)) {
    ws.send(
      JSON.stringify(
        buildErrorEvent(
          'Expected message type "response.create"',
          "invalid_request_error",
          "invalid_message_type",
        ),
      ),
    );
    return;
  }

  // The response body inside response.create maps to a ResponsesRequest
  const responsesReq = {
    model: parsed.response.model ?? defaults.model,
    input: (parsed.response.input ?? []) as {
      role?: string;
      type?: string;
      content?: string | { type: string; text?: string }[];
      call_id?: string;
      name?: string;
      arguments?: string;
      output?: string;
      id?: string;
    }[],
    instructions: parsed.response.instructions,
    tools: parsed.response.tools as
      | {
          type: "function";
          name: string;
          description?: string;
          parameters?: object;
          strict?: boolean;
        }[]
      | undefined,
    tool_choice: parsed.response.tool_choice,
    stream: parsed.response.stream,
    temperature: parsed.response.temperature,
    max_output_tokens: parsed.response.max_output_tokens,
  };

  const completionReq = responsesToCompletionRequest(responsesReq);
  const fixture = matchFixture(fixtures, completionReq);

  if (!fixture) {
    journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: {},
      body: completionReq,
      response: { status: 404, fixture: null },
    });
    ws.send(
      JSON.stringify(
        buildErrorEvent("No fixture matched", "invalid_request_error", "no_fixture_match"),
      ),
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
      method: "WS",
      path: "/v1/responses",
      headers: {},
      body: completionReq,
      response: { status, fixture },
    });
    ws.send(
      JSON.stringify(
        buildErrorEvent(response.error.message, response.error.type, response.error.code),
      ),
    );
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });
    const events = buildTextStreamEvents(response.content, completionReq.model, chunkSize);
    await sendEvents(ws, events, latency);
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });
    const events = buildToolCallStreamEvents(response.toolCalls, completionReq.model, chunkSize);
    await sendEvents(ws, events, latency);
    return;
  }

  // Unknown response type
  journal.add({
    method: "WS",
    path: "/v1/responses",
    headers: {},
    body: completionReq,
    response: { status: 500, fixture },
  });
  ws.send(
    JSON.stringify(
      buildErrorEvent("Fixture response did not match any known type", "server_error"),
    ),
  );
}

async function sendEvents(
  ws: WebSocketConnection,
  events: ResponsesSSEEvent[],
  latency: number,
): Promise<void> {
  for (const event of events) {
    if (ws.isClosed) return;
    if (latency > 0) await delay(latency);
    if (ws.isClosed) return;
    ws.send(JSON.stringify(event));
  }
}
