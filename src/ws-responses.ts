/**
 * WebSocket handler for OpenAI Responses API.
 *
 * Accepts `{ type: "response.create", model: "...", input: [...] }` messages over
 * WebSocket and sends back the same Responses API SSE events as the HTTP
 * handler, but as individual WebSocket text frames.
 */

import type { Fixture, HandlerDefaults } from "./types.js";
import { planMisbehavior, recordMisbehaviorOutcome } from "./misbehavior.js";
import { matchFixtureDiagnostic } from "./router.js";
import {
  responsesToCompletionRequest,
  requestIncludesEncryptedReasoning,
  requestWantsEncryptedReasoning,
  buildTextStreamEvents,
  buildToolCallStreamEvents,
  buildContentWithToolCallsStreamEvents,
  prepareResponsesMisbehavior,
  buildResponsesMisbehavior,
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
  resolveReasoningForModel,
  strictOverrideField,
  flattenHeaders,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { createInterruptionSignal } from "./interruption.js";
import { delay, calculateDelay } from "./sse-writer.js";
import { DEFAULT_TEST_ID, type Journal } from "./journal.js";
import type { WebSocketConnection } from "./ws-framing.js";

type ResponsesWebSocketDefaults = Omit<HandlerDefaults, "replaySpeed"> & {
  replaySpeed?: number;
  model: string;
  testId?: string;
  upgradeHeaders?: import("node:http").IncomingHttpHeaders;
};

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
  defaults: ResponsesWebSocketDefaults,
  beforeProcessMessage?: () => void,
): void {
  const { logger } = defaults;
  // Serialize message processing to prevent event interleaving
  let pending = Promise.resolve();
  ws.on("message", (raw: string) => {
    pending = pending.then(async () => {
      try {
        beforeProcessMessage?.();
        await processMessage(raw, ws, fixtures, journal, defaults);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        logger.error(`WebSocket responses error: ${msg}`);
        try {
          ws.send(JSON.stringify(buildErrorEvent(msg, "server_error")));
        } catch (sendErr) {
          defaults.logger.debug(
            `Failed to send error to client: ${sendErr instanceof Error ? sendErr.message : "unknown"}`,
          );
        }
      }
    });
  });
}

async function processMessage(
  raw: string,
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  defaults: ResponsesWebSocketDefaults,
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
    include: (parsed as { include?: string[] }).include,
    store: (parsed as { store?: boolean }).store,
  };

  // Gate encrypted-reasoning emission identically to the HTTP transport so the
  // agent-framework#7233 stateless-replay path works over WebSocket too.
  const emitEncryptedReasoning = requestWantsEncryptedReasoning(responsesReq);
  // Synthesizing a reasoning item the fixture never declared takes the NARROWER
  // explicit-`include` gate, transport-identically to HTTP — a `store: false`
  // request with a summary-less fixture still gets no reasoning item.
  const synthesizeSummarylessReasoning = requestIncludesEncryptedReasoning(responsesReq);

  const completionReq = responsesToCompletionRequest(responsesReq);
  completionReq._endpointType = "chat";
  const contextHeader = defaults.upgradeHeaders?.["x-aimock-context"];
  completionReq._context =
    typeof contextHeader === "string"
      ? contextHeader
      : Array.isArray(contextHeader) && contextHeader.length > 0
        ? contextHeader[0]
        : undefined;
  const testId = defaults.testId ?? DEFAULT_TEST_ID;
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
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
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      defaults.logger.error(strictNoMatchLogLine("WS", "/v1/responses", skippedBySequenceOrTurn));
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
      ws.close(1008, strictMessage);
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
  const misbehaviorDefaults: HandlerDefaults = {
    ...defaults,
    replaySpeed: defaults.replaySpeed ?? 1,
  };
  const misbehavior = planMisbehavior({
    wire: "openai-responses",
    fixture,
    response,
    request: completionReq,
    // Responses WebSocket always emits streaming events, even with stream:false.
    stream: true,
    emitsToolCallIds: true,
    defaults: misbehaviorDefaults,
    // The server has already resolved the upgrade's header/query test ID.
    rawHeaders: { ...defaults.upgradeHeaders, "x-test-id": testId },
    url: "/v1/responses",
  });
  const recordOutcome = (entry: ReturnType<Journal["add"]>) =>
    recordMisbehaviorOutcome({
      entry,
      summary: misbehavior.summary,
      defaults: misbehaviorDefaults,
      testId,
    });
  if (misbehavior.kind === "error") {
    const entry = journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: misbehavior.status, fixture },
    });
    recordOutcome(entry);
    if (!misbehavior.summary?.evaluations.length) {
      defaults.logger.error(
        `[misbehavior] ${misbehavior.code}: ${misbehavior.message} (testId=${testId})`,
      );
    }
    ws.send(
      JSON.stringify(
        buildErrorEvent(misbehavior.message, "invalid_request_error", misbehavior.code),
      ),
    );
    return;
  }
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  if (misbehavior.kind === "applied") {
    const prepared = prepareResponsesMisbehavior(misbehavior);
    const output = buildResponsesMisbehavior(
      prepared,
      completionReq,
      chunkSize,
      emitEncryptedReasoning,
    );
    const entry = journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: 200, fixture },
    });
    recordMisbehaviorOutcome({
      entry,
      summary: prepared.summary,
      defaults: misbehaviorDefaults,
      testId,
    });
    const timings = fixture.recordedTimings;
    const gaps = timings?.interChunkDelaysMs;
    // K4 can add events; extend only its replay using the last recorded gap.
    const appliedTimings =
      prepared.duplicateId && timings && gaps
        ? {
            ...timings,
            interChunkDelaysMs: Array.from(
              { length: Math.max(gaps.length, output.events.length - 1) },
              (_, index) => gaps[index] ?? gaps.at(-1) ?? 0,
            ),
          }
        : timings;
    const interruption = createInterruptionSignal(fixture);
    const completed = await sendEvents(
      ws,
      output.events,
      latency,
      interruption?.signal,
      interruption?.tick,
      appliedTimings,
      fixture.replaySpeed ?? defaults.replaySpeed,
    );
    if (!completed) {
      ws.destroy();
      entry.response.interrupted = true;
      entry.response.interruptReason = interruption?.reason();
    }
    interruption?.cleanup();
    return;
  }

  // The WS path has no per-request `req.headers`; strict is resolved from the
  // connection's upgrade headers (see the `!fixture` branch above). Used below
  // to gate the synthesized reasoning channel on the requested model's capability.
  const effectiveStrict = resolveStrictMode(defaults.strict, defaults.upgradeHeaders);

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    const entry = journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status, fixture },
    });
    recordOutcome(entry);
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
    recordOutcome(journalEntry);

    let events: ResponsesSSEEvent[];
    try {
      events = buildContentWithToolCallsStreamEvents(
        response.content ?? "",
        response.toolCalls ?? [],
        completionReq.model,
        chunkSize,
        resolveReasoningForModel(
          response.reasoning,
          completionReq.model,
          effectiveStrict,
          defaults.logger,
        ),
        response.webSearches,
        extractOverrides(response),
        response.blocks,
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
    } catch (error) {
      journalEntry.response.status = 500;
      throw error;
    }

    const interruption = createInterruptionSignal(fixture);
    const completed = await sendEvents(
      ws,
      events,
      latency,
      interruption?.signal,
      interruption?.tick,
      fixture.recordedTimings,
      fixture.replaySpeed ?? defaults.replaySpeed,
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
    recordOutcome(journalEntry);

    const events = buildTextStreamEvents(
      response.content,
      completionReq.model,
      chunkSize,
      resolveReasoningForModel(
        response.reasoning,
        completionReq.model,
        effectiveStrict,
        defaults.logger,
      ),
      response.webSearches,
      extractOverrides(response),
      emitEncryptedReasoning,
      synthesizeSummarylessReasoning,
    );
    const interruption = createInterruptionSignal(fixture);
    const completed = await sendEvents(
      ws,
      events,
      latency,
      interruption?.signal,
      interruption?.tick,
      fixture.recordedTimings,
      fixture.replaySpeed ?? defaults.replaySpeed,
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
    recordOutcome(journalEntry);
    let events: ResponsesSSEEvent[];
    try {
      events = buildToolCallStreamEvents(
        response.toolCalls,
        completionReq.model,
        chunkSize,
        // Gate the synthesized reasoning channel on the requested model's
        // capability, matching the WS text / content+tool branches and the HTTP
        // tool-only path so reasoning emission is transport-independent.
        resolveReasoningForModel(
          response.reasoning,
          completionReq.model,
          effectiveStrict,
          defaults.logger,
        ),
        response.webSearches,
        extractOverrides(response),
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
    } catch (error) {
      journalEntry.response.status = 500;
      throw error;
    }
    const interruption = createInterruptionSignal(fixture);
    const completed = await sendEvents(
      ws,
      events,
      latency,
      interruption?.signal,
      interruption?.tick,
      fixture.recordedTimings,
      fixture.replaySpeed ?? defaults.replaySpeed,
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
  const entry = journal.add({
    method: "WS",
    path: "/v1/responses",
    headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
    body: completionReq,
    response: { status: 500, fixture },
  });
  recordOutcome(entry);
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
  recordedTimings?: import("./types.js").RecordedTimings,
  replaySpeed?: number,
): Promise<boolean> {
  let eventIndex = 0;
  for (const event of events) {
    if (ws.isClosed) return false;
    const chunkDelay = calculateDelay(eventIndex, undefined, latency, recordedTimings, replaySpeed);
    if (chunkDelay > 0) await delay(chunkDelay, signal);
    if (signal?.aborted) return false;
    if (ws.isClosed) return false;
    ws.send(JSON.stringify(event));
    eventIndex++;
    onChunkSent?.();
    if (signal?.aborted) return false;
  }
  return true;
}
