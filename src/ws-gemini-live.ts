/**
 * WebSocket handler for Gemini Live BidiGenerateContent API.
 *
 * Accepts setup, clientContent, and toolResponse messages over WebSocket
 * and responds with setupComplete, serverContent, toolCall, and error
 * messages in the Gemini Live streaming format.
 */

import type { Fixture, ChatMessage, ChatCompletionRequest, ToolDefinition } from "./types.js";
import { matchFixture } from "./router.js";
import { isTextResponse, isToolCallResponse, isErrorResponse } from "./helpers.js";
import { createInterruptionSignal } from "./interruption.js";
import { delay } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { WebSocketConnection } from "./ws-framing.js";

// ─── Gemini Live protocol types ─────────────────────────────────────────────

interface GeminiLivePart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown; id?: string };
}

interface GeminiLiveTurn {
  role: string;
  parts: GeminiLivePart[];
}

interface GeminiLiveFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: object;
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
 * Convert Gemini Live turns into ChatMessage[] for fixture matching.
 */
function geminiTurnsToMessages(turns: GeminiLiveTurn[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const turn of turns) {
    const role = turn.role ?? "user";

    if (role === "user") {
      const funcResponses = turn.parts.filter((p) => p.functionResponse);
      const textParts = turn.parts.filter((p) => p.text !== undefined);

      if (funcResponses.length > 0) {
        for (let i = 0; i < funcResponses.length; i++) {
          const part = funcResponses[i];
          const fr = part.functionResponse!;
          messages.push({
            role: "tool",
            content: typeof fr.response === "string" ? fr.response : JSON.stringify(fr.response),
            tool_call_id: fr.id ?? `call_gemini_${fr.name}_${i}`,
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
      const textParts = turn.parts.filter((p) => p.text !== undefined);

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

  return messages;
}

/**
 * Convert toolResponse messages into ChatMessage[] for fixture matching.
 */
function toolResponseToMessages(toolResponse: GeminiLiveToolResponse): ChatMessage[] {
  return toolResponse.functionResponses.map((fr, i) => ({
    role: "tool" as const,
    content: typeof fr.response === "string" ? fr.response : JSON.stringify(fr.response),
    tool_call_id: fr.id ?? `call_gemini_${fr.name}_${i}`,
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
      parameters: d.parameters,
    },
  }));
}

// ─── Main handler ───────────────────────────────────────────────────────────

export function handleWebSocketGeminiLive(
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  defaults: { latency: number; chunkSize: number; model: string; logger: Logger },
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
    pending = pending.then(() =>
      processMessage(raw, ws, fixtures, journal, defaults, session).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Internal error";
        logger.error(`WebSocket Gemini Live error: ${msg}`);
        try {
          ws.send(
            JSON.stringify({
              error: { code: 500, message: msg, status: "INTERNAL" },
            }),
          );
        } catch {
          // Connection already gone — original error already logged above
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
  defaults: { latency: number; chunkSize: number; model: string; logger: Logger },
  session: SessionState,
): Promise<void> {
  let parsed: GeminiLiveMessage;
  try {
    parsed = JSON.parse(raw) as GeminiLiveMessage;
  } catch {
    ws.send(
      JSON.stringify({
        error: { code: 400, message: "Malformed JSON", status: "INVALID_ARGUMENT" },
      }),
    );
    return;
  }

  // Handle setup message
  if (parsed.setup) {
    session.setupDone = true;
    session.model = parsed.setup.model ?? defaults.model;
    session.tools = convertTools(parsed.setup.tools);
    ws.send(JSON.stringify({ setupComplete: {} }));
    return;
  }

  // Reject messages before setup
  if (!session.setupDone) {
    ws.send(
      JSON.stringify({
        error: { code: 400, message: "Setup required", status: "FAILED_PRECONDITION" },
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
            code: 400,
            message: "Missing 'turns' in clientContent",
            status: "INVALID_ARGUMENT",
          },
        }),
      );
      return;
    }
    newMessages = geminiTurnsToMessages(parsed.clientContent.turns);
  } else if (parsed.toolResponse) {
    if (
      !parsed.toolResponse.functionResponses ||
      !Array.isArray(parsed.toolResponse.functionResponses)
    ) {
      ws.send(
        JSON.stringify({
          error: {
            code: 400,
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
          code: 400,
          message: "Expected clientContent or toolResponse",
          status: "INVALID_ARGUMENT",
        },
      }),
    );
    return;
  }

  // Build completion request for fixture matching (include new messages speculatively)
  const completionReq: ChatCompletionRequest = {
    model: session.model,
    messages: [...session.conversationHistory, ...newMessages],
    stream: true,
    tools: session.tools.length > 0 ? session.tools : undefined,
  };

  const fixture = matchFixture(fixtures, completionReq, journal.fixtureMatchCounts);
  const path = WS_PATH;

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures);
  }

  if (!fixture) {
    journal.add({
      method: "WS",
      path,
      headers: {},
      body: completionReq,
      response: { status: 404, fixture: null },
    });
    ws.send(
      JSON.stringify({
        error: { code: 404, message: "No fixture matched", status: "NOT_FOUND" },
      }),
    );
    return;
  }

  // Commit messages to conversation history only after successful fixture match
  session.conversationHistory.push(...newMessages);

  const response = fixture.response;
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // Error response
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: "WS",
      path,
      headers: {},
      body: completionReq,
      response: { status, fixture },
    });
    ws.send(
      JSON.stringify({
        error: { code: status, message: response.error.message, status: "ERROR" },
      }),
    );
    return;
  }

  // Text response — stream chunks with serverContent
  if (isTextResponse(response)) {
    const journalEntry = journal.add({
      method: "WS",
      path,
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });

    const content = response.content;

    if (content.length === 0) {
      if (ws.isClosed) return;
      ws.send(
        JSON.stringify({
          serverContent: {
            modelTurn: { parts: [{ text: "" }] },
            turnComplete: true,
          },
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
    let interrupted = false;

    for (let i = 0; i < chunks.length; i++) {
      if (ws.isClosed) break;
      if (latency > 0) await delay(latency, interruption?.signal);
      if (interruption?.signal.aborted) {
        interrupted = true;
        break;
      }
      if (ws.isClosed) break;

      const isLast = i === chunks.length - 1;
      ws.send(
        JSON.stringify({
          serverContent: {
            modelTurn: { parts: [{ text: chunks[i] }] },
            turnComplete: isLast,
          },
        }),
      );
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

    // Add assistant response to conversation history
    session.conversationHistory.push({ role: "assistant", content });
    return;
  }

  // Tool call response
  if (isToolCallResponse(response)) {
    const journalEntry = journal.add({
      method: "WS",
      path,
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });

    const interruption = createInterruptionSignal(fixture);

    if (ws.isClosed) {
      interruption?.cleanup();
      return;
    }
    if (latency > 0) await delay(latency, interruption?.signal);
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

    const functionCalls = response.toolCalls.map((tc, i) => {
      let argsObj: Record<string, unknown>;
      try {
        argsObj = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
      } catch {
        defaults.logger.warn(
          `Malformed JSON in fixture tool call arguments for "${tc.name}": ${tc.arguments}`,
        );
        argsObj = {};
      }
      return {
        name: tc.name,
        args: argsObj,
        id: tc.id ?? `call_gemini_${tc.name}_${i}`,
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

    // Add assistant tool_calls to conversation history
    session.conversationHistory.push({
      role: "assistant",
      content: null,
      tool_calls: response.toolCalls.map((tc, i) => ({
        id: tc.id ?? `call_gemini_${tc.name}_${i}`,
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
  journal.add({
    method: "WS",
    path,
    headers: {},
    body: completionReq,
    response: { status: 500, fixture },
  });
  ws.send(
    JSON.stringify({
      error: {
        code: 500,
        message: "Fixture response did not match any known type",
        status: "INTERNAL",
      },
    }),
  );
}
