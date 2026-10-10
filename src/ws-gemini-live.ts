/**
 * WebSocket handler for Gemini Live BidiGenerateContent API.
 *
 * Accepts setup, clientContent, and toolResponse messages over WebSocket
 * and responds with setupComplete, serverContent, toolCall, and error
 * messages in the Gemini Live streaming format.
 */

import type {
  Fixture,
  ChatMessage,
  ChatCompletionRequest,
  ToolDefinition,
  AudioResponse,
  ToolCall,
  FixtureFileBlock,
  JournalEntry,
  HandlerDefaults,
} from "./types.js";
import { planMisbehavior, recordMisbehaviorOutcome, type MisbehaviorPlan } from "./misbehavior.js";
import { matchFixtureDiagnostic } from "./router.js";
import {
  fixtureToolCallErrorCode,
  googleFixtureToolCallErrorDetails,
  isFixtureToolCallError,
  journalFixtureToolCallError,
  rejectResponsesOnlyToolCalls,
  requireServedFunctionToolCalls,
  toolArgsForWire,
  runWithToolArgumentsScope,
  servedToolArgs,
  strictToolArgumentsEnabled,
  isTextResponse,
  isToolCallResponse,
  isCombinedFixtureResponse,
  isErrorResponse,
  isAudioResponse,
  flattenHeaders,
  formatToMime,
  generateToolCallId,
  resolveFixtureBlocks,
  resolveFixtureBlockOutcome,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { createInterruptionSignal } from "./interruption.js";
import { delay, calculateDelay } from "./sse-writer.js";
import { DEFAULT_TEST_ID, type Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { WebSocketConnection } from "./ws-framing.js";

// ─── Gemini Live protocol types ─────────────────────────────────────────────

interface GeminiLivePart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown; id?: string };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiLiveTurn {
  role: string;
  parts: GeminiLivePart[];
}

interface GeminiLiveFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: object;
  parametersJsonSchema?: object;
}

interface GeminiLiveToolDef {
  functionDeclarations?: GeminiLiveFunctionDeclaration[];
}

interface GeminiLiveSetup {
  model?: string;
  generationConfig?: Record<string, unknown>;
  tools?: GeminiLiveToolDef[];
}

interface GeminiLiveClientContent {
  turns: GeminiLiveTurn[];
  turnComplete?: boolean;
}

interface GeminiLiveFunctionResponse {
  id?: string;
  name: string;
  response: unknown;
}

interface GeminiLiveToolResponse {
  functionResponses: GeminiLiveFunctionResponse[];
}

interface GeminiLiveMessage {
  setup?: GeminiLiveSetup;
  config?: GeminiLiveSetup;
  clientContent?: GeminiLiveClientContent;
  toolResponse?: GeminiLiveToolResponse;
}

// ─── Session state ──────────────────────────────────────────────────────────

interface SessionState {
  setupDone: boolean;
  model: string;
  tools: ToolDefinition[];
  conversationHistory: ChatMessage[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const WS_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Map HTTP status codes to gRPC error codes.
 * Gemini Live uses gRPC codes, not HTTP status codes.
 */
function httpToGrpc(httpCode: number): number {
  switch (httpCode) {
    case 400:
      return 3; // INVALID_ARGUMENT
    case 401:
      return 16; // UNAUTHENTICATED
    case 403:
      return 7; // PERMISSION_DENIED
    case 404:
      return 5; // NOT_FOUND
    case 409:
      return 10; // ABORTED
    case 429:
      return 8; // RESOURCE_EXHAUSTED
    case 501:
      return 12; // UNIMPLEMENTED
    case 503:
      return 14; // UNAVAILABLE
    default:
      return 13; // INTERNAL
  }
}

/**
 * Convert Gemini Live turns into ChatMessage[] for fixture matching.
 */
function geminiTurnsToMessages(turns: GeminiLiveTurn[], logger?: Logger): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const turn of turns) {
    const role = turn.role ?? "user";

    if (role === "user") {
      const funcResponses = turn.parts.filter((p) => p.functionResponse);
      // inlineData parts (e.g. client audio input) are silently skipped —
      // only text and functionResponse parts are relevant for fixture matching.
      const textParts = turn.parts.filter((p) => p.text !== undefined && !p.thought);

      if (funcResponses.length > 0) {
        for (let i = 0; i < funcResponses.length; i++) {
          const part = funcResponses[i];
          const fr = part.functionResponse!;
          messages.push({
            role: "tool",
            content: typeof fr.response === "string" ? fr.response : JSON.stringify(fr.response),
            tool_call_id: fr.id ?? generateToolCallId(),
          });
        }
        if (textParts.length > 0) {
          messages.push({
            role: "user",
            content: textParts.map((p) => p.text!).join(""),
          });
        }
      } else {
        const text = textParts.map((p) => p.text!).join("");
        messages.push({ role: "user", content: text });
      }
    } else if (role === "model") {
      const funcCalls = turn.parts.filter((p) => p.functionCall);
      const textParts = turn.parts.filter((p) => p.text !== undefined && !p.thought);

      if (funcCalls.length > 0) {
        const text = textParts.map((p) => p.text!).join("");
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: funcCalls.map((p) => ({
            id: generateToolCallId(),
            type: "function" as const,
            function: {
              name: p.functionCall!.name,
              arguments: JSON.stringify(p.functionCall!.args ?? {}),
            },
          })),
        });
      } else {
        const text = textParts.map((p) => p.text!).join("");
        messages.push({ role: "assistant", content: text });
      }
    } else {
      logger?.warn(`[gemini-live] skipping turn with unrecognized role: ${role}`);
    }
  }

  return messages;
}

/**
 * Convert toolResponse messages into ChatMessage[] for fixture matching.
 */
function toolResponseToMessages(toolResponse: GeminiLiveToolResponse): ChatMessage[] {
  return toolResponse.functionResponses.map((fr) => ({
    role: "tool" as const,
    content: typeof fr.response === "string" ? fr.response : JSON.stringify(fr.response),
    tool_call_id: fr.id ?? generateToolCallId(),
  }));
}

/**
 * Convert Gemini tool definitions to ChatCompletion ToolDefinition[].
 */
function convertTools(geminiTools?: GeminiLiveToolDef[]): ToolDefinition[] {
  if (!geminiTools || geminiTools.length === 0) return [];
  const decls = geminiTools.flatMap((t) => t.functionDeclarations ?? []);
  return decls.map((d) => ({
    type: "function" as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters ?? d.parametersJsonSchema,
    },
  }));
}

function liveToolArguments(tc: Pick<ToolCall, "name" | "arguments">) {
  return servedToolArgs(tc, "object").value;
}

const GEMINI_LIVE_WIRE = "Gemini Live";

/** Prepare native object arguments and IDs once for both output and the journal. */
function prepareLiveMisbehavior(plan: MisbehaviorPlan): MisbehaviorPlan {
  if (plan.summary.fault === "tool-args-invalid-json" || plan.summary.fault === "empty-response") {
    return { ...plan, summary: { ...plan.summary, servedToolCalls: [] } };
  }
  const response = plan.response;
  const combined = isCombinedFixtureResponse(response);
  const outcome =
    combined && response.blocks?.length ? resolveFixtureBlockOutcome(response.blocks) : undefined;
  const calls =
    outcome?.toolCalls ??
    (combined || isToolCallResponse(response) ? (response.toolCalls ?? []) : []);
  const duplicate = plan.duplicateId;
  const toolCalls = calls.map((call, index) => {
    const args = toolArgsForWire(call);
    // Preserve authored-invalid arguments for the existing journaled preflight error.
    return {
      ...call,
      arguments: args.kind === "parsed" ? args.text : args.raw,
      ...(index === duplicate?.destinationIndex ? {} : { id: call.id ?? generateToolCallId() }),
    };
  });
  if (duplicate) toolCalls[duplicate.destinationIndex].id = toolCalls[duplicate.sourceIndex].id;
  let preparedResponse = { ...response };
  if ("usage" in preparedResponse) delete preparedResponse.usage;
  if (outcome) {
    let index = 0;
    const blocks = outcome.ordered.map((block) =>
      block.type === "text" ? { ...block } : { ...block, ...toolCalls[index++] },
    );
    preparedResponse = { ...preparedResponse, content: outcome.content, toolCalls, blocks };
  } else if (combined || isToolCallResponse(response)) {
    preparedResponse = { ...preparedResponse, toolCalls };
  }
  return {
    ...plan,
    response: preparedResponse,
    summary: {
      ...plan.summary,
      servedToolCalls: toolCalls.map(({ name, arguments: args, id }) => ({
        name,
        arguments: args,
        id,
      })),
    },
  };
}

/**
 * Validate the whole selected response before audio, text, or any tool is
 * sent: every entry is validated, custom tool calls are rejected, and every
 * argument string must parse. Returns the calls narrowed to function calls. On
 * failure the journal entry becomes a 500, and the outer message handler sends
 * code 13 with `google.rpc.ErrorInfo` details carrying the aimock code, drops
 * this turn from the history, and leaves the socket open.
 */
function preflightToolArguments(
  response: { toolCalls?: ToolCall[] },
  journalEntry: JournalEntry,
): ToolCall[] {
  return journalFixtureToolCallError(journalEntry, () => {
    const functionCalls = requireServedFunctionToolCalls(response, GEMINI_LIVE_WIRE);
    if (strictToolArgumentsEnabled()) for (const tc of functionCalls) liveToolArguments(tc);
    return functionCalls;
  });
}

/** Resolve ordered blocks (rejecting custom tool calls) and preflight their arguments. */
function preflightBlocks(
  response: { blocks?: FixtureFileBlock[]; customToolCalls?: unknown },
  journalEntry: JournalEntry,
) {
  return journalFixtureToolCallError(journalEntry, () => {
    rejectResponsesOnlyToolCalls(response, GEMINI_LIVE_WIRE);
    const resolved = resolveFixtureBlocks(response.blocks ?? []);
    if (strictToolArgumentsEnabled())
      for (const block of resolved) if (block.type === "toolCall") liveToolArguments(block);
    return resolved;
  });
}

// ─── Main handler ───────────────────────────────────────────────────────────

export function handleWebSocketGeminiLive(
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  defaults: {
    latency: number;
    chunkSize: number;
    replaySpeed?: number;
    model: string;
    logger: Logger;
    strict?: boolean;
    strictToolArguments?: boolean;
    requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest;
    testId?: string;
    upgradeHeaders?: import("node:http").IncomingHttpHeaders;
    misbehavior?: HandlerDefaults["misbehavior"];
    misbehaviorCounters?: HandlerDefaults["misbehaviorCounters"];
    registry?: HandlerDefaults["registry"];
    /** @internal Called before each message is processed (the server assigns fixture positions). */
    beforeProcessMessage?: () => void;
  },
): void {
  const { logger } = defaults;
  const session: SessionState = {
    setupDone: false,
    model: defaults.model,
    tools: [],
    conversationHistory: [],
  };

  let pending = Promise.resolve();
  ws.on("message", (raw: string) => {
    pending = pending.then(async () => {
      // Messages are processed one at a time, so this marks where this
      // message's turn begins in the history.
      const historyMark = session.conversationHistory.length;
      try {
        defaults.beforeProcessMessage?.();
        await runWithToolArgumentsScope(
          { strict: defaults.strictToolArguments === true, logger },
          () => processMessage(raw, ws, fixtures, journal, defaults, session),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        logger.error(`WebSocket Gemini Live error: ${msg}`);
        const fixtureToolCallError = isFixtureToolCallError(err);
        // A fixture rejected by a tool-call check serves nothing, so its turn
        // must not stay in the history as a user turn with no reply. Only
        // fixture tool-call errors roll back: any other error (for example a
        // malformed text block) leaves the user turn in the history.
        if (fixtureToolCallError) session.conversationHistory.length = historyMark;
        try {
          ws.send(
            JSON.stringify({
              error: {
                code: 13,
                message: msg,
                status: "INTERNAL",
                ...(fixtureToolCallError
                  ? { details: googleFixtureToolCallErrorDetails(fixtureToolCallErrorCode(err)) }
                  : {}),
              },
            }),
          );
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
  defaults: {
    latency: number;
    chunkSize: number;
    replaySpeed?: number;
    model: string;
    logger: Logger;
    strict?: boolean;
    requestTransform?: (req: ChatCompletionRequest) => ChatCompletionRequest;
    testId?: string;
    upgradeHeaders?: import("node:http").IncomingHttpHeaders;
    misbehavior?: HandlerDefaults["misbehavior"];
    misbehaviorCounters?: HandlerDefaults["misbehaviorCounters"];
    registry?: HandlerDefaults["registry"];
  },
  session: SessionState,
): Promise<void> {
  let parsed: GeminiLiveMessage;
  try {
    parsed = JSON.parse(raw) as GeminiLiveMessage;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    ws.send(
      JSON.stringify({
        error: { code: 3, message: `Malformed JSON: ${detail}`, status: "INVALID_ARGUMENT" },
      }),
    );
    return;
  }

  // Handle setup message (accept both `setup` and `config` as aliases)
  const setupMsg = parsed.setup ?? parsed.config;
  if (setupMsg) {
    session.setupDone = true;
    session.model = setupMsg.model ?? defaults.model;
    session.tools = convertTools(setupMsg.tools);
    ws.send(JSON.stringify({ setupComplete: {} }));
    return;
  }

  // Reject messages before setup
  if (!session.setupDone) {
    ws.send(
      JSON.stringify({
        error: { code: 9, message: "Setup required", status: "FAILED_PRECONDITION" },
      }),
    );
    return;
  }

  // Build messages from this interaction
  let newMessages: ChatMessage[];

  if (parsed.clientContent) {
    if (!parsed.clientContent.turns || !Array.isArray(parsed.clientContent.turns)) {
      ws.send(
        JSON.stringify({
          error: {
            code: 3,
            message: "Missing 'turns' in clientContent",
            status: "INVALID_ARGUMENT",
          },
        }),
      );
      return;
    }
    newMessages = geminiTurnsToMessages(parsed.clientContent.turns, defaults.logger);
  } else if (parsed.toolResponse) {
    if (
      !parsed.toolResponse.functionResponses ||
      !Array.isArray(parsed.toolResponse.functionResponses)
    ) {
      ws.send(
        JSON.stringify({
          error: {
            code: 3,
            message: "Missing 'functionResponses' in toolResponse",
            status: "INVALID_ARGUMENT",
          },
        }),
      );
      return;
    }
    newMessages = toolResponseToMessages(parsed.toolResponse);
  } else {
    ws.send(
      JSON.stringify({
        error: {
          code: 3,
          message: "Expected clientContent or toolResponse",
          status: "INVALID_ARGUMENT",
        },
      }),
    );
    return;
  }

  // Build completion request for fixture matching (include new messages speculatively)
  const geminiContextHeader = defaults.upgradeHeaders?.["x-aimock-context"];
  const geminiContext =
    typeof geminiContextHeader === "string"
      ? geminiContextHeader
      : Array.isArray(geminiContextHeader) && geminiContextHeader.length > 0
        ? geminiContextHeader[0]
        : undefined;

  const completionReq: ChatCompletionRequest = {
    model: session.model,
    messages: [...session.conversationHistory, ...newMessages],
    stream: true,
    tools: session.tools.length > 0 ? session.tools : undefined,
    _endpointType: "chat",
    _context: geminiContext,
  };

  const testId = defaults.testId ?? DEFAULT_TEST_ID;
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );
  const path = WS_PATH;

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (!fixture) {
    if (resolveStrictMode(defaults.strict, defaults.upgradeHeaders)) {
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      defaults.logger.error(strictNoMatchLogLine("WS", path, skippedBySequenceOrTurn));
      journal.add({
        method: "WS",
        path,
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
      path,
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, defaults.upgradeHeaders),
      },
    });
    ws.send(
      JSON.stringify({
        error: { code: 5, message: "No fixture matched", status: "NOT_FOUND" },
      }),
    );
    return;
  }

  // Commit messages to conversation history only after successful fixture match
  session.conversationHistory.push(...newMessages);

  let response = await resolveResponse(fixture, completionReq);
  const plannerDefaults = { ...defaults, replaySpeed: defaults.replaySpeed ?? 1 };
  let misbehavior = planMisbehavior({
    wire: "gemini-live",
    emitsToolCallIds: true,
    fixture,
    response,
    request: completionReq,
    stream: true,
    defaults: plannerDefaults,
    rawHeaders: defaults.upgradeHeaders ?? {},
    // The server resolves both header and query-string session scopes.
    url: `${path}?testId=${encodeURIComponent(testId)}`,
  });
  if (misbehavior.kind === "applied") {
    misbehavior = prepareLiveMisbehavior(misbehavior);
    response = misbehavior.response;
  }
  const addResponseEntry = (status: number) => {
    const entry = journal.add({
      method: "WS",
      path,
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status, fixture },
    });
    recordMisbehaviorOutcome({
      entry,
      summary: misbehavior.summary,
      defaults: plannerDefaults,
      testId,
    });
    return entry;
  };
  if (misbehavior.kind === "error") {
    addResponseEntry(misbehavior.status);
    if (!misbehavior.summary?.evaluations.length) {
      defaults.logger.error(`[misbehavior] ${misbehavior.message} (testId=${testId})`);
    }
    ws.send(
      JSON.stringify({
        error: {
          code: httpToGrpc(misbehavior.status),
          message: misbehavior.message,
          status: misbehavior.status === 400 ? "INVALID_ARGUMENT" : "UNIMPLEMENTED",
        },
      }),
    );
    return;
  }
  const latency = fixture.latency ?? defaults.latency;
  if (
    misbehavior.kind === "applied" &&
    (misbehavior.summary.fault === "tool-args-invalid-json" ||
      misbehavior.summary.fault === "empty-response")
  ) {
    const journalEntry = addResponseEntry(200);
    const interruption = createInterruptionSignal(fixture);
    const markInterrupted = () => {
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
      ws.destroy();
    };
    try {
      if (ws.isClosed) return;
      const chunkDelay = calculateDelay(
        0,
        undefined,
        latency,
        fixture.recordedTimings,
        fixture.replaySpeed ?? defaults.replaySpeed,
      );
      if (chunkDelay > 0) await delay(chunkDelay, interruption?.signal);
      if (interruption?.signal.aborted) {
        markInterrupted();
        return;
      }
      if (ws.isClosed) return;
      const malformed = misbehavior.summary.fault === "tool-args-invalid-json";
      ws.send(
        JSON.stringify({
          serverContent: malformed
            ? { turnComplete: true, turnCompleteReason: "MALFORMED_FUNCTION_CALL" }
            : { modelTurn: { parts: [{ text: "" }] } },
        }),
      );
      interruption?.tick();
      if (interruption?.signal.aborted) {
        markInterrupted();
        return;
      }
      // Like ordinary text streaming, completion follows the counted content chunk.
      if (!malformed && !ws.isClosed) {
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
        session.conversationHistory.push({ role: "assistant", content: "" });
      }
    } finally {
      interruption?.cleanup();
    }
    return;
  }
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    addResponseEntry(status);
    ws.send(
      JSON.stringify({
        error: {
          code: httpToGrpc(status),
          message: response.error.message,
          status: response.error.type ?? "INTERNAL",
        },
      }),
    );
    return;
  }

  // Audio response — an AUDIO-modality model turn, plus the companion
  // modalities `AudioResponse` documents (types.ts) as preserved alongside it.
  //
  // COMPANION PLACEMENT is protocol-specific, and the Live protocol does NOT
  // place a tool call where the HTTP protocol does. On `generateContent` a
  // functionCall is a PART, so gemini.ts's `buildGeminiAudioParts` appends it to
  // the same `content.parts` array as the audio. On Live, `serverContent` and
  // `toolCall` are alternatives of ONE union: `@google/genai`'s
  // `LiveServerMessage` declares them as sibling optional fields and the
  // BidiGenerateContent reference states the response's `messageType` union
  // "can be only one of the following". A turn that both speaks and calls a
  // function is therefore TWO messages, not one part list —
  //
  //   serverContent{modelTurn.parts} → toolCall{functionCalls} → serverContent{turnComplete}
  //
  // — which is also the order every other branch of this handler already emits
  // and the order the live provider was observed to use (its tool turn sent a
  // `serverContent` strictly before the `toolCall`).
  //
  // Emitting only the audio and returning — the previous behavior — silently
  // discarded the tool call and the text content of a recorded audio turn, the
  // exact loss types.ts's AudioResponse companions exist to prevent.
  //
  // NOT handled here: `AudioResponse.reasoning`. This handler has no thought
  // channel in ANY branch (nothing in it emits `thought: true`), so replaying
  // reasoning from the audio branch alone would invent a Live-wide capability
  // out of one fixture field. That gap is real but separate.
  if (isAudioResponse(response)) {
    const journalEntry = addResponseEntry(200);

    const audioResp = response as AudioResponse;
    const audioToolCalls = preflightToolArguments(audioResp, journalEntry);
    let mimeType: string;
    let data: string;

    if (typeof audioResp.audio === "string") {
      mimeType = formatToMime(audioResp.format ?? "mp3");
      data = audioResp.audio;
    } else {
      mimeType = audioResp.audio.contentType ?? "audio/mpeg";
      data = audioResp.audio.b64Json;
    }

    // Part order mirrors gemini.ts's `buildGeminiAudioParts`: audio first, then
    // the text companion.
    const parts: GeminiLivePart[] = [{ inlineData: { mimeType, data } }];
    if (audioResp.content) {
      parts.push({ text: audioResp.content });
    }

    // Stable IDs resolved once, so the wire message and conversation history
    // agree (same contract as the tool-call branches below).
    const resolvedToolCalls = audioToolCalls.map((tc) => ({
      ...tc,
      resolvedId: tc.id ?? generateToolCallId(),
    }));

    if (resolvedToolCalls.length === 0) {
      ws.send(
        JSON.stringify({
          serverContent: { modelTurn: { parts }, turnComplete: true },
        }),
      );
    } else {
      ws.send(JSON.stringify({ serverContent: { modelTurn: { parts } } }));

      if (!ws.isClosed) {
        const functionCalls = resolvedToolCalls.map((tc) => {
          const argsObj = liveToolArguments(tc);
          return { name: tc.name, args: argsObj, id: tc.resolvedId };
        });
        ws.send(JSON.stringify({ toolCall: { functionCalls } }));
      }

      if (!ws.isClosed) {
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
      }
    }

    session.conversationHistory.push({
      role: "assistant",
      content: audioResp.content ?? "[audio]",
      ...(resolvedToolCalls.length > 0
        ? {
            tool_calls: resolvedToolCalls.map((tc) => ({
              id: tc.resolvedId,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    });
    return;
  }

  // Content + tool calls response (must be checked before isTextResponse / isToolCallResponse)
  if (isCombinedFixtureResponse(response)) {
    const journalEntry = addResponseEntry(200);

    // BLOCKS path (#274): when the fixture carries an ordered `blocks` array,
    // honor it instead of the legacy `content ?? ""` / `toolCalls ?? []` path.
    // The Gemini Live WS protocol expresses ordering via SEQUENTIAL messages —
    // a text block becomes one-or-more `serverContent.modelTurn.parts[{text}]`
    // messages and a toolCall block becomes a `toolCall.functionCalls` message,
    // so emitting in array order faithfully reproduces tool-before-text (or any
    // interleaving), matching the HTTP gemini.ts blocks branch. Without this, a
    // blocks-only fixture (post-F0 it matches this guard) would stream an EMPTY
    // payload — a silent drop. Legacy fixtures (no `blocks`) skip this entirely.
    if (response.blocks && response.blocks.length > 0) {
      const resolvedBlocks = preflightBlocks(response, journalEntry);
      const interruption = createInterruptionSignal(fixture);
      const replaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;
      const { recordedTimings } = fixture;
      let chunkIndex = 0;
      let interrupted = false;

      // Accumulate the equivalent assistant turn for conversation history, so a
      // follow-up turn sees the same content + tool_calls as the legacy path.
      let historyContent = "";
      const historyToolCalls: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[] = [];

      outer: for (const block of resolvedBlocks) {
        if (block.type === "toolCall") {
          if (ws.isClosed) break;
          const tcDelay = calculateDelay(
            chunkIndex,
            undefined,
            latency,
            recordedTimings,
            replaySpeed,
          );
          if (tcDelay > 0) await delay(tcDelay, interruption?.signal);
          if (interruption?.signal.aborted) {
            interrupted = true;
            break;
          }
          if (ws.isClosed) break;

          const resolvedId = block.id ?? generateToolCallId();
          const argsObj = liveToolArguments(block);

          try {
            ws.send(
              JSON.stringify({
                toolCall: { functionCalls: [{ name: block.name, args: argsObj, id: resolvedId }] },
              }),
            );
          } catch (err) {
            defaults.logger.debug(
              "[gemini-live] send failed during blocks streaming, closing",
              err,
            );
            break;
          }
          chunkIndex++;
          historyToolCalls.push({
            id: resolvedId,
            type: "function" as const,
            function: { name: block.name, arguments: block.arguments },
          });
          interruption?.tick();
          if (interruption?.signal.aborted) {
            interrupted = true;
            break;
          }
        } else {
          const text = block.text;
          historyContent += text;
          if (text.length === 0) {
            // An empty text block carries no wire content, so emit nothing and
            // spend no chunk: the old guard sent a useless empty `modelTurn`
            // message and `continue`d WITHOUT `chunkIndex++`/`interruption.tick()`,
            // which leaked the next block past `truncateAfterChunks` and shifted
            // `recordedTimings` indexing for every following block. Skipping
            // keeps non-empty-block output byte-identical and the chunk/timing
            // accounting correct.
            continue;
          }
          for (let i = 0; i < text.length; i += chunkSize) {
            if (ws.isClosed) break outer;
            const chunkDelay = calculateDelay(
              chunkIndex,
              undefined,
              latency,
              recordedTimings,
              replaySpeed,
            );
            if (chunkDelay > 0) await delay(chunkDelay, interruption?.signal);
            if (interruption?.signal.aborted) {
              interrupted = true;
              break outer;
            }
            if (ws.isClosed) break outer;
            try {
              ws.send(
                JSON.stringify({
                  serverContent: { modelTurn: { parts: [{ text: text.slice(i, i + chunkSize) }] } },
                }),
              );
            } catch (err) {
              defaults.logger.debug(
                "[gemini-live] send failed during blocks streaming, closing",
                err,
              );
              break outer;
            }
            chunkIndex++;
            interruption?.tick();
            if (interruption?.signal.aborted) {
              interrupted = true;
              break outer;
            }
          }
        }
      }

      if (interrupted) {
        ws.destroy();
        journalEntry.response.interrupted = true;
        journalEntry.response.interruptReason = interruption?.reason();
        interruption?.cleanup();
        return;
      }

      interruption?.cleanup();

      // Send turnComplete
      if (!ws.isClosed) {
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
      }

      session.conversationHistory.push({
        role: "assistant",
        content: historyContent || null,
        ...(historyToolCalls.length > 0 ? { tool_calls: historyToolCalls } : {}),
      });
      return;
    }

    const functionToolCalls = preflightToolArguments(response, journalEntry);
    const content = response.content ?? "";
    const chunkList: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      chunkList.push(content.slice(i, i + chunkSize));
    }

    const interruption = createInterruptionSignal(fixture);
    const replaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;
    const { recordedTimings } = fixture;
    let interrupted = false;

    // Stream text content chunks (turnComplete omitted — sent as a separate message later)
    if (content.length === 0) {
      if (!ws.isClosed) {
        ws.send(
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ text: "" }] },
            },
          }),
        );
      }
    } else {
      for (let i = 0; i < chunkList.length; i++) {
        if (ws.isClosed) break;
        const chunkDelay = calculateDelay(i, undefined, latency, recordedTimings, replaySpeed);
        if (chunkDelay > 0) await delay(chunkDelay, interruption?.signal);
        if (interruption?.signal.aborted) {
          interrupted = true;
          break;
        }
        if (ws.isClosed) break;

        try {
          ws.send(
            JSON.stringify({
              serverContent: {
                modelTurn: { parts: [{ text: chunkList[i] }] },
              },
            }),
          );
        } catch (err) {
          defaults.logger.debug("[gemini-live] send failed during text streaming, closing", err);
          break;
        }
        interruption?.tick();
        if (interruption?.signal.aborted) {
          interrupted = true;
          break;
        }
      }
    }

    if (interrupted) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
      interruption?.cleanup();
      return;
    }

    // Pre-compute tool calls with stable IDs so wire message and history match
    const resolvedToolCalls = functionToolCalls.map((tc) => ({
      ...tc,
      resolvedId: tc.id ?? generateToolCallId(),
    }));

    // Send tool calls
    if (!ws.isClosed) {
      const tcDelay = calculateDelay(
        chunkList.length,
        undefined,
        latency,
        recordedTimings,
        replaySpeed,
      );
      if (tcDelay > 0) await delay(tcDelay, interruption?.signal);
      if (interruption?.signal.aborted) {
        ws.destroy();
        journalEntry.response.interrupted = true;
        journalEntry.response.interruptReason = interruption?.reason();
        interruption?.cleanup();
        return;
      }

      const functionCalls = resolvedToolCalls.map((tc) => {
        const argsObj = liveToolArguments(tc);
        return {
          name: tc.name,
          args: argsObj,
          id: tc.resolvedId,
        };
      });

      ws.send(JSON.stringify({ toolCall: { functionCalls } }));
      interruption?.tick();
    }

    if (interruption?.signal.aborted) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
      interruption?.cleanup();
      return;
    }

    interruption?.cleanup();

    // Send turnComplete
    if (!ws.isClosed) {
      ws.send(
        JSON.stringify({
          serverContent: { turnComplete: true },
        }),
      );
    }

    // Add to conversation history using the same resolved IDs from the wire message
    session.conversationHistory.push({
      role: "assistant",
      content: content || null,
      tool_calls: resolvedToolCalls.map((tc) => ({
        id: tc.resolvedId,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      })),
    });
    return;
  }

  // Text response — stream chunks with serverContent
  if (isTextResponse(response)) {
    const journalEntry = addResponseEntry(200);

    const content = response.content;

    if (content.length === 0) {
      if (ws.isClosed) return;
      // Empty content: send empty modelTurn, then separate turnComplete
      ws.send(
        JSON.stringify({
          serverContent: {
            modelTurn: { parts: [{ text: "" }] },
          },
        }),
      );
      ws.send(
        JSON.stringify({
          serverContent: { turnComplete: true },
        }),
      );
      return;
    }

    // Chunk the content
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize));
    }

    const interruption = createInterruptionSignal(fixture);
    const replaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;
    const { recordedTimings } = fixture;
    let interrupted = false;

    // Stream content chunks without turnComplete (sent separately after)
    for (let i = 0; i < chunks.length; i++) {
      if (ws.isClosed) break;
      const chunkDelay = calculateDelay(i, undefined, latency, recordedTimings, replaySpeed);
      if (chunkDelay > 0) await delay(chunkDelay, interruption?.signal);
      if (interruption?.signal.aborted) {
        interrupted = true;
        break;
      }
      if (ws.isClosed) break;

      try {
        ws.send(
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ text: chunks[i] }] },
            },
          }),
        );
      } catch (err) {
        defaults.logger.debug("[gemini-live] send failed during text streaming, closing", err);
        break;
      }
      interruption?.tick();
      if (interruption?.signal.aborted) {
        interrupted = true;
        break;
      }
    }

    if (interrupted) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
      interruption?.cleanup();
      return;
    }

    interruption?.cleanup();

    // Send separate turnComplete message
    if (!ws.isClosed) {
      ws.send(
        JSON.stringify({
          serverContent: { turnComplete: true },
        }),
      );
    }

    // Add assistant response to conversation history
    session.conversationHistory.push({ role: "assistant", content });
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    const journalEntry = addResponseEntry(200);

    const functionToolCalls = preflightToolArguments(response, journalEntry);

    const interruption = createInterruptionSignal(fixture);
    const replaySpeed = fixture.replaySpeed ?? defaults.replaySpeed;
    const { recordedTimings } = fixture;

    if (ws.isClosed) {
      interruption?.cleanup();
      return;
    }
    const tcDelay = calculateDelay(0, undefined, latency, recordedTimings, replaySpeed);
    if (tcDelay > 0) await delay(tcDelay, interruption?.signal);
    if (interruption?.signal.aborted) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
      interruption?.cleanup();
      return;
    }
    if (ws.isClosed) {
      interruption?.cleanup();
      return;
    }

    // Pre-compute tool calls with stable IDs so wire message and history match
    const resolvedToolCalls = functionToolCalls.map((tc) => ({
      ...tc,
      resolvedId: tc.id ?? generateToolCallId(),
    }));

    const functionCalls = resolvedToolCalls.map((tc) => {
      const argsObj = liveToolArguments(tc);
      return {
        name: tc.name,
        args: argsObj,
        id: tc.resolvedId,
      };
    });

    ws.send(JSON.stringify({ toolCall: { functionCalls } }));
    interruption?.tick();

    if (interruption?.signal.aborted) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
      interruption?.cleanup();
      return;
    }

    interruption?.cleanup();

    // Send turnComplete after tool call
    if (!ws.isClosed) {
      ws.send(
        JSON.stringify({
          serverContent: { turnComplete: true },
        }),
      );
    }

    // Add assistant tool_calls to conversation history using the same resolved IDs
    session.conversationHistory.push({
      role: "assistant",
      content: null,
      tool_calls: resolvedToolCalls.map((tc) => ({
        id: tc.resolvedId,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      })),
    });
    return;
  }

  // Unknown response type
  addResponseEntry(500);
  ws.send(
    JSON.stringify({
      error: {
        code: 13,
        message: "Fixture response did not match any known type",
        status: "INTERNAL",
      },
    }),
  );
}
