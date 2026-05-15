/**
 * WebSocket handler for OpenAI Responses API.
 *
 * Accepts `{ type: "response.create", model: "...", input: [...] }` messages over
 * WebSocket and sends back the same Responses API SSE events as the HTTP
 * handler, but as individual WebSocket text frames.
 */

import type { ChatCompletionRequest, Fixture } from "./types.js";
import { matchFixture } from "./router.js";
import {
  responsesToCompletionRequest,
  buildTextStreamEvents,
  buildToolCallStreamEvents,
  buildContentWithToolCallsStreamEvents,
  type ResponsesSSEEvent,
} from "./responses.js";
import {
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  extractOverrides,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
  flattenHeaders,
} from "./helpers.js";
import { createInterruptionSignal } from "./interruption.js";
import { delay } from "./sse-writer.js";
import { DEFAULT_TEST_ID, type Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { WebSocketConnection } from "./ws-framing.js";

interface ResponseCreateMessage {
  type: "response.create";
  model?: string;
  input?: unknown[];
  instructions?: string;
  tools?: unknown[];
  tool_choice?: string | object;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  [key: string]: unknown;
}

function isResponseCreateMessage(msg: unknown): msg is ResponseCreateMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as ResponseCreateMessage).type === "response.create"
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
  defaults: {
    latency: number;
    chunkSize: number;
    model: string;
    logger: Logger;
    strict?: boolean;
    requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest;
    testId?: string;
    upgradeHeaders?: import("node:http").IncomingHttpHeaders;
  },
): void {
  const { logger } = defaults;
  // Serialize message processing to prevent event interleaving
  let pending = Promise.resolve();
  ws.on("message", (raw: string) => {
    pending = pending.then(() =>
      processMessage(raw, ws, fixtures, journal, defaults).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Internal error";
        logger.error(`WebSocket responses error: ${msg}`);
        try {
          ws.send(JSON.stringify(buildErrorEvent(msg, "server_error")));
        } catch (sendErr) {
          defaults.logger.debug(
            `Failed to send error to client: ${sendErr instanceof Error ? sendErr.message : "unknown"}`,
          );
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
  defaults: {
    latency: number;
    chunkSize: number;
    model: string;
    logger: Logger;
    strict?: boolean;
    requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest;
    testId?: string;
    upgradeHeaders?: import("node:http").IncomingHttpHeaders;
  },
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    ws.send(
      JSON.stringify(
        buildErrorEvent(`Malformed JSON: ${detail}`, "invalid_request_error", "invalid_json"),
      ),
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

  const responsesReq = {
    model: parsed.model ?? defaults.model,
    input: (parsed.input ?? []) as {
      role?: string;
      type?: string;
      content?: string | { type: string; text?: string }[];
      call_id?: string;
      name?: string;
      arguments?: string;
      output?: string;
      id?: string;
    }[],
    instructions: parsed.instructions,
    tools: parsed.tools as
      | {
          type: "function";
          name: string;
          description?: string;
          parameters?: object;
          strict?: boolean;
        }[]
      | undefined,
    tool_choice: parsed.tool_choice,
    stream: parsed.stream,
    temperature: parsed.temperature,
    max_output_tokens: parsed.max_output_tokens,
  };

  const completionReq = responsesToCompletionRequest(responsesReq);
  completionReq._endpointType = "chat";
  const testId = defaults.testId ?? DEFAULT_TEST_ID;
  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (!fixture) {
    if (resolveStrictMode(defaults.strict, defaults.upgradeHeaders)) {
      defaults.logger.warn(`STRICT: No fixture matched for WebSocket message`);
      journal.add({
        method: "WS",
        path: "/v1/responses",
        headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
        body: completionReq,
        response: {
          status: 503,
          fixture: null,
          ...strictOverrideField(defaults.strict, defaults.upgradeHeaders),
        },
      });
      ws.close(1008, "Strict mode: no fixture matched");
      return;
    }
    journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, defaults.upgradeHeaders),
      },
    });
    ws.send(
      JSON.stringify(
        buildErrorEvent("No fixture matched", "invalid_request_error", "no_fixture_match"),
      ),
    );
    return;
  }

  const response = await resolveResponse(fixture, completionReq);
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
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

  // Content + tool calls response (must be checked before isTextResponse / isToolCallResponse)
  if (isContentWithToolCallsResponse(response)) {
    const journalEntry = journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: 200, fixture },
    });

    const events = buildContentWithToolCallsStreamEvents(
      response.content,
      response.toolCalls,
      completionReq.model,
      chunkSize,
      response.reasoning,
      response.webSearches,
      extractOverrides(response),
    );

    const interruption = createInterruptionSignal(fixture);
    const completed = await sendEvents(
      ws,
      events,
      latency,
      interruption?.signal,
      interruption?.tick,
    );
    if (!completed) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
    }
    interruption?.cleanup();
    return;
  }

  // Text response
  if (isTextResponse(response)) {
    const journalEntry = journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: 200, fixture },
    });

    const events = buildTextStreamEvents(
      response.content,
      completionReq.model,
      chunkSize,
      response.reasoning,
      response.webSearches,
      extractOverrides(response),
    );
    const interruption = createInterruptionSignal(fixture);
    const completed = await sendEvents(
      ws,
      events,
      latency,
      interruption?.signal,
      interruption?.tick,
    );
    if (!completed) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
    }
    interruption?.cleanup();
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    const journalEntry = journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const events = buildToolCallStreamEvents(
      response.toolCalls,
      completionReq.model,
      chunkSize,
      response.webSearches,
      extractOverrides(response),
    );
    const interruption = createInterruptionSignal(fixture);
    const completed = await sendEvents(
      ws,
      events,
      latency,
      interruption?.signal,
      interruption?.tick,
    );
    if (!completed) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
    }
    interruption?.cleanup();
    return;
  }

  // Unknown response type
  journal.add({
    method: "WS",
    path: "/v1/responses",
    headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
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
  signal?: AbortSignal,
  onChunkSent?: () => void,
): Promise<boolean> {
  for (const event of events) {
    if (ws.isClosed) return false;
    if (latency > 0) await delay(latency, signal);
    if (signal?.aborted) return false;
    if (ws.isClosed) return false;
    ws.send(JSON.stringify(event));
    onChunkSent?.();
    if (signal?.aborted) return false;
  }
  return true;
}
