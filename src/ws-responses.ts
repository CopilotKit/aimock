/**
 * WebSocket handler for OpenAI Responses API.
 *
 * Accepts `{ type: "response.create", model: "...", input: [...] }` messages over
 * WebSocket and sends back the same Responses API SSE events as the HTTP
 * handler, but as individual WebSocket text frames.
 */

import type { Fixture, HandlerDefaults, JournalEntry, RecordedTimings } from "./types.js";
import { planMisbehavior, recordMisbehaviorOutcome } from "./misbehavior.js";
import { matchFixtureDiagnostic } from "./router.js";
import {
  responsesToCompletionRequest,
  requestIncludesEncryptedReasoning,
  requestWantsEncryptedReasoning,
  buildTextStreamEvents,
  toolCallStreamEvents,
  contentWithToolCallsStreamEvents,
  prepareResponsesMisbehavior,
  buildResponsesMisbehavior,
  type ResponsesSSEEvent,
  type ResponsesInputItem,
  type ResponsesToolDef,
} from "./responses.js";
import {
  fixtureToolCallErrorCode,
  isFixtureToolCallError,
  journalFixtureToolCallError,
  isTextResponse,
  isToolCallResponse,
  isCombinedFixtureResponse,
  isErrorResponse,
  isRawResponse,
  extractOverrides,
  resolveResponse,
  resolveReasoningForModel,
  flattenHeaders,
  strictNoMatchMessage,
  strictNoMatchLogLine,
  assertCustomToolCalls,
  resolveServedBlockOutcome,
  servedToolCalls,
  withoutLegacyNamespaces,
} from "./helpers.js";
import { DEFAULT_TEST_ID, type Journal } from "./journal.js";
import type { WebSocketConnection } from "./ws-framing.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import { buildOpenAIError } from "./response/errors.js";
import { markWsTurnStopped, watchWsClose, wsLifecycle } from "./response/lifecycle.js";
import { runFrameLoop, wsSink, type FrameCodec } from "./response/frame-loop.js";
import { extendRecordedTimings } from "./response/timing.js";
import { RAW_MODE_UNAVAILABLE } from "./response/raw.js";

type ResponsesWebSocketDefaults = Omit<HandlerDefaults, "replaySpeed"> & {
  replaySpeed?: number;
  model: string;
  testId?: string;
  upgradeHeaders?: import("node:http").IncomingHttpHeaders;
  /** @internal Called before each message is processed (the server assigns fixture positions). */
  beforeProcessMessage?: () => void;
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
    error: buildOpenAIError({ message, type, code }),
  };
}

export function handleWebSocketResponses(
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  defaults: ResponsesWebSocketDefaults,
): void {
  const { logger } = defaults;
  watchWsClose(ws);
  // Serialize message processing to prevent event interleaving
  let pending = Promise.resolve();
  ws.on("message", (raw: string) => {
    pending = pending.then(async () => {
      try {
        defaults.beforeProcessMessage?.();
        await processMessage(raw, ws, fixtures, journal, defaults);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        logger.error(`WebSocket responses error: ${msg}`);
        try {
          const code = isFixtureToolCallError(err) ? fixtureToolCallErrorCode(err) : undefined;
          ws.send(JSON.stringify(buildErrorEvent(msg, "server_error", code)));
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
    // Same shapes as HTTP: namespace / custom tools, additional_tools items
    // and custom tool call items reach responsesToCompletionRequest unchanged.
    input: (parsed.input ?? []) as ResponsesInputItem[],
    instructions: parsed.instructions,
    tools: parsed.tools as ResponsesToolDef[] | undefined,
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

  const extendedTools = defaults.responsesTools === "extended";
  const completionReq = responsesToCompletionRequest(responsesReq, {
    extended: extendedTools,
    logger: defaults.logger,
  });
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
    // Wire only: recordMatchOptions here would turn on strict turnIndex and the
    // relaxed-turnIndex warning, which this transport has never had.
    { wire: "openai-responses" },
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (!fixture) {
    if (resolveRequestDecisions(defaults.strict, defaults.upgradeHeaders).fixtureMiss) {
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

  // Without responsesTools "extended", a namespace on a toolCalls entry or a
  // toolCall block is not emitted, as in earlier releases.
  const resolvedResponse = await resolveResponse(fixture, completionReq);
  const response = extendedTools ? resolvedResponse : withoutLegacyNamespaces(resolvedResponse);
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
    // Journal first, as HTTP /v1/responses does, so a fixture error thrown
    // while building leaves a 500 entry that keeps the fixture. Record the
    // fault only once the reply is built: a thrown error was not served.
    const entry = journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: 200, fixture },
    });
    const prepared = prepareResponsesMisbehavior(misbehavior);
    const output = journalFixtureToolCallError(entry, () =>
      buildResponsesMisbehavior(prepared, completionReq, chunkSize, emitEncryptedReasoning),
    );
    recordMisbehaviorOutcome({
      entry,
      summary: prepared.summary,
      defaults: misbehaviorDefaults,
      testId,
    });
    // K4 can add events; extend only its replay using the last recorded gap.
    const appliedTimings = extendRecordedTimings(
      fixture.recordedTimings,
      output.events.length,
      !!prepared.duplicateId,
    );
    await deliverTurn(ws, entry, fixture, output.events, {
      latency,
      recordedTimings: appliedTimings,
      replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
    });
    return;
  }

  // The WS path has no per-request `req.headers`; strict is resolved from the
  // connection's upgrade headers (see the `!fixture` branch above). Used below
  // to gate the synthesized reasoning channel on the requested model's capability.
  const effectiveStrict = resolveRequestDecisions(
    defaults.strict,
    defaults.upgradeHeaders,
  ).reasoningSuppression;

  // Raw passthrough fixtures are served over HTTP only for now. Fail loudly
  // instead of the generic unknown-type error so the author sees why.
  if (isRawResponse(response)) {
    const message = "raw fixtures are not yet supported on the WebSocket transport";
    const entry = journal.add({
      method: "WS",
      path: "/v1/responses",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: 500, fixture },
    });
    entry.response.error = message;
    recordOutcome(entry);
    defaults.logger.error(`WebSocket responses error: ${RAW_MODE_UNAVAILABLE}: ${message}`);
    ws.send(JSON.stringify(buildErrorEvent(message, "server_error", RAW_MODE_UNAVAILABLE)));
    return;
  }

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
  if (isCombinedFixtureResponse(response)) {
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
      const ordered = resolveServedBlockOutcome(response)?.ordered;
      if (!ordered) assertCustomToolCalls(response);
      events = contentWithToolCallsStreamEvents(
        response.content ?? "",
        servedToolCalls(response),
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
        ordered,
        emitEncryptedReasoning,
        synthesizeSummarylessReasoning,
      );
    } catch (error) {
      journalEntry.response.status = 500;
      if (isFixtureToolCallError(error)) journalEntry.response.error = error.message;
      throw error;
    }

    await deliverTurn(ws, journalEntry, fixture, events, {
      latency,
      recordedTimings: fixture.recordedTimings,
      replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
    });
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

    // A fixture error (malformed citations, a non-image file) marks the entry
    // a 500 carrying the message before the error event goes out.
    const events = journalFixtureToolCallError(journalEntry, () =>
      buildTextStreamEvents(
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
      ),
    );
    await deliverTurn(ws, journalEntry, fixture, events, {
      latency,
      recordedTimings: fixture.recordedTimings,
      replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
    });
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
      assertCustomToolCalls(response);
      events = toolCallStreamEvents(
        servedToolCalls(response),
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
      if (isFixtureToolCallError(error)) journalEntry.response.error = error.message;
      throw error;
    }
    await deliverTurn(ws, journalEntry, fixture, events, {
      latency,
      recordedTimings: fixture.recordedTimings,
      replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
    });
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

/** WS Responses frames: one JSON text message per event, no head, no trailer. */
const wsEventCodec: FrameCodec<ResponsesSSEEvent> = {
  headers: {},
  encode: (event) => JSON.stringify(event),
  checkGoneBeforeDelay: true,
};

/**
 * Send one turn's events under a WS lifecycle. The lifecycle owns the fixture
 * interruption and also stops the turn when the client closes, so a pending
 * delay ends at once. A stopped turn marks the entry by the shared WS rule
 * ({@link markWsTurnStopped}) and destroys the socket.
 * `streamingProfile` is not applied on this transport, as before.
 */
async function deliverTurn(
  ws: WebSocketConnection,
  entry: JournalEntry,
  fixture: Fixture,
  events: ResponsesSSEEvent[],
  timing: { latency: number; recordedTimings?: RecordedTimings; replaySpeed?: number },
): Promise<void> {
  const lifecycle = wsLifecycle(ws, fixture);
  try {
    const completed = await runFrameLoop(wsSink(ws), events, wsEventCodec, timing, {
      lifecycle,
      onChunkSent: lifecycle.tick,
    });
    if (!completed) {
      markWsTurnStopped(entry, ws, lifecycle);
      ws.destroy();
    }
  } finally {
    lifecycle.dispose();
  }
}
