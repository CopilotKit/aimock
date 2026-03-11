/**
 * WebSocket handler for OpenAI Realtime API.
 *
 * Accepts Realtime API messages (session.update, conversation.item.create,
 * response.create) over WebSocket and sends back Realtime API events as
 * individual WebSocket text frames.
 */

import type { ChatCompletionRequest, ChatMessage, Fixture } from "./types.js";
import { matchFixture } from "./router.js";
import {
  generateId,
  generateToolCallId,
  isTextResponse,
  isToolCallResponse,
  isErrorResponse,
} from "./helpers.js";
import { createInterruptionSignal } from "./interruption.js";
import { delay } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import type { WebSocketConnection } from "./ws-framing.js";

// ─── Realtime protocol types ────────────────────────────────────────────────

interface RealtimeItem {
  type: "message" | "function_call" | "function_call_output";
  id?: string;
  role?: "user" | "assistant" | "system";
  content?: Array<{ type: string; text?: string }>;
  name?: string;
  call_id?: string;
  arguments?: string;
  output?: string;
}

interface SessionConfig {
  model: string;
  modalities: string[];
  instructions: string;
  tools: unknown[];
  voice: string | null;
  input_audio_format: string | null;
  output_audio_format: string | null;
  turn_detection: unknown | null;
  temperature: number;
}

interface RealtimeMessage {
  type: string;
  event_id?: string;
  session?: Partial<SessionConfig>;
  item?: RealtimeItem;
  response?: {
    modalities?: string[];
    instructions?: string;
    [key: string]: unknown;
  };
}

// ─── Conversion helpers ─────────────────────────────────────────────────────

export function realtimeItemsToMessages(
  items: RealtimeItem[],
  instructions?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  for (const item of items) {
    if (item.type === "message") {
      const text = item.content?.[0]?.text ?? "";
      const role =
        item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
      messages.push({ role, content: text });
    } else if (item.type === "function_call") {
      if (!item.name) {
        console.warn("[LLMock] Realtime function_call item missing 'name'");
      }
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? generateToolCallId(),
            type: "function",
            function: {
              name: item.name ?? "",
              arguments: item.arguments ?? "",
            },
          },
        ],
      });
    } else if (item.type === "function_call_output") {
      if (!item.output) {
        console.warn("[LLMock] Realtime function_call_output item missing 'output'");
      }
      messages.push({
        role: "tool",
        content: item.output ?? "",
        tool_call_id: item.call_id,
      });
    }
  }

  return messages;
}

// ─── Event builders ─────────────────────────────────────────────────────────

function evt(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, event_id: generateId("evt"), ...extra });
}

function buildErrorRealtimeEvent(
  message: string,
  type = "invalid_request_error",
  code?: string,
): string {
  return evt("error", { error: { message, type, code } });
}

// ─── Main handler ───────────────────────────────────────────────────────────

export function handleWebSocketRealtime(
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  defaults: { latency: number; chunkSize: number; model: string },
): void {
  const sessionId = generateId("sess");

  const session: SessionConfig = {
    model: defaults.model,
    modalities: ["text"],
    instructions: "",
    tools: [],
    voice: null,
    input_audio_format: null,
    output_audio_format: null,
    turn_detection: null,
    temperature: 0.8,
  };

  const conversationItems: RealtimeItem[] = [];

  // Send session.created immediately on connect
  ws.send(evt("session.created", { session: { id: sessionId, ...session } }));

  // Serialize message processing to prevent event interleaving
  let pending = Promise.resolve();
  ws.on("message", (raw: string) => {
    pending = pending.then(() =>
      processMessage(raw, ws, fixtures, journal, defaults, session, conversationItems).catch(
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : "Internal error";
          console.error(`[LLMock] WebSocket realtime error: ${msg}`);
          try {
            ws.send(buildErrorRealtimeEvent(msg, "server_error"));
          } catch {
            // Connection already gone — original error already logged above
          }
        },
      ),
    );
  });
}

async function processMessage(
  raw: string,
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  defaults: { latency: number; chunkSize: number; model: string },
  session: SessionConfig,
  conversationItems: RealtimeItem[],
): Promise<void> {
  let parsed: RealtimeMessage;
  try {
    parsed = JSON.parse(raw) as RealtimeMessage;
  } catch {
    ws.send(buildErrorRealtimeEvent("Malformed JSON", "invalid_request_error", "invalid_json"));
    return;
  }

  const msgType = parsed.type;

  // ── session.update ────────────────────────────────────────────────────
  if (msgType === "session.update") {
    if (parsed.session) {
      if (parsed.session.instructions !== undefined) {
        session.instructions = parsed.session.instructions;
      }
      if (parsed.session.tools !== undefined) {
        session.tools = parsed.session.tools;
      }
      if (parsed.session.modalities !== undefined) {
        session.modalities = parsed.session.modalities;
      }
      if (parsed.session.model !== undefined) {
        session.model = parsed.session.model;
      }
      if (parsed.session.temperature !== undefined) {
        session.temperature = parsed.session.temperature;
      }
    }
    ws.send(evt("session.updated", { session: { ...session } }));
    return;
  }

  // ── conversation.item.create ──────────────────────────────────────────
  if (msgType === "conversation.item.create") {
    if (!parsed.item) {
      ws.send(
        buildErrorRealtimeEvent(
          "Missing 'item' in conversation.item.create",
          "invalid_request_error",
        ),
      );
      return;
    }
    const item = parsed.item;
    if (!item.id) {
      item.id = generateId("item");
    }
    conversationItems.push(item);
    ws.send(evt("conversation.item.created", { item }));
    return;
  }

  // ── response.create ───────────────────────────────────────────────────
  if (msgType === "response.create") {
    await handleResponseCreate(ws, fixtures, journal, defaults, session, conversationItems);
    return;
  }

  // Unknown message type — ignore silently (matches OpenAI behavior)
}

async function handleResponseCreate(
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  defaults: { latency: number; chunkSize: number; model: string },
  session: SessionConfig,
  conversationItems: RealtimeItem[],
): Promise<void> {
  const instructions = session.instructions || undefined;
  const messages = realtimeItemsToMessages(conversationItems, instructions);

  const completionReq: ChatCompletionRequest = {
    model: session.model,
    messages,
  };

  const fixture = matchFixture(fixtures, completionReq);
  const responseId = generateId("resp");

  if (!fixture) {
    journal.add({
      method: "WS",
      path: "/v1/realtime",
      headers: {},
      body: completionReq,
      response: { status: 404, fixture: null },
    });
    // Send response.created with failed status then response.done with error
    ws.send(
      evt("response.created", {
        response: { id: responseId, status: "failed", output: [] },
      }),
    );
    ws.send(
      evt("response.done", {
        response: {
          id: responseId,
          status: "failed",
          output: [],
          status_details: {
            type: "error",
            error: {
              message: "No fixture matched",
              type: "invalid_request_error",
              code: "no_fixture_match",
            },
          },
        },
      }),
    );
    return;
  }

  const response = fixture.response;
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // ── Error fixture ───────────────────────────────────────────────────
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: "WS",
      path: "/v1/realtime",
      headers: {},
      body: completionReq,
      response: { status, fixture },
    });
    ws.send(
      evt("response.created", {
        response: { id: responseId, status: "failed", output: [] },
      }),
    );
    ws.send(
      evt("response.done", {
        response: {
          id: responseId,
          status: "failed",
          output: [],
          status_details: {
            type: "error",
            error: {
              message: response.error.message,
              type: response.error.type,
              code: response.error.code,
            },
          },
        },
      }),
    );
    return;
  }

  // ── Text response ───────────────────────────────────────────────────
  if (isTextResponse(response)) {
    const journalEntry = journal.add({
      method: "WS",
      path: "/v1/realtime",
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });

    const itemId = generateId("item");
    const contentIndex = 0;
    const outputIndex = 0;

    const outputItem = {
      id: itemId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: response.content }],
    };

    // response.created
    ws.send(
      evt("response.created", {
        response: { id: responseId, status: "in_progress", output: [] },
      }),
    );

    // response.output_item.added
    ws.send(
      evt("response.output_item.added", {
        response_id: responseId,
        output_index: outputIndex,
        item: { id: itemId, type: "message", role: "assistant", content: [] },
      }),
    );

    // response.content_part.added
    ws.send(
      evt("response.content_part.added", {
        response_id: responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: { type: "text", text: "" },
      }),
    );

    // response.text.delta (chunked)
    const content = response.content;
    const interruption = createInterruptionSignal(fixture);
    let interrupted = false;

    for (let i = 0; i < content.length; i += chunkSize) {
      if (ws.isClosed) break;
      if (latency > 0) await delay(latency, interruption?.signal);
      if (interruption?.signal.aborted) {
        interrupted = true;
        break;
      }
      if (ws.isClosed) break;
      const chunk = content.slice(i, i + chunkSize);
      ws.send(
        evt("response.text.delta", {
          response_id: responseId,
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: chunk,
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

    // response.text.done
    ws.send(
      evt("response.text.done", {
        response_id: responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        text: content,
      }),
    );

    // response.content_part.done
    ws.send(
      evt("response.content_part.done", {
        response_id: responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: { type: "text", text: content },
      }),
    );

    // response.output_item.done
    ws.send(
      evt("response.output_item.done", {
        response_id: responseId,
        output_index: outputIndex,
        item: outputItem,
      }),
    );

    // response.done
    ws.send(
      evt("response.done", {
        response: { id: responseId, status: "completed", output: [outputItem] },
      }),
    );

    // Accumulate assistant response into conversation for multi-turn
    conversationItems.push({
      type: "message",
      id: itemId,
      role: "assistant",
      content: [{ type: "text", text: content }],
    });
    return;
  }

  // ── Tool call response ──────────────────────────────────────────────
  if (isToolCallResponse(response)) {
    const journalEntry = journal.add({
      method: "WS",
      path: "/v1/realtime",
      headers: {},
      body: completionReq,
      response: { status: 200, fixture },
    });

    // response.created
    ws.send(
      evt("response.created", {
        response: { id: responseId, status: "in_progress", output: [] },
      }),
    );

    const outputItems: unknown[] = [];
    const interruption = createInterruptionSignal(fixture);
    let interrupted = false;

    for (let tcIdx = 0; tcIdx < response.toolCalls.length; tcIdx++) {
      const tc = response.toolCalls[tcIdx];
      const callId = tc.id ?? generateToolCallId();
      const itemId = generateId("item");

      const outputItem = {
        id: itemId,
        type: "function_call",
        call_id: callId,
        name: tc.name,
        arguments: tc.arguments,
      };

      // response.output_item.added
      ws.send(
        evt("response.output_item.added", {
          response_id: responseId,
          output_index: tcIdx,
          item: {
            id: itemId,
            type: "function_call",
            call_id: callId,
            name: tc.name,
            arguments: "",
          },
        }),
      );

      // response.function_call_arguments.delta (chunked)
      const args = tc.arguments;
      for (let i = 0; i < args.length; i += chunkSize) {
        if (ws.isClosed) break;
        if (latency > 0) await delay(latency, interruption?.signal);
        if (interruption?.signal.aborted) {
          interrupted = true;
          break;
        }
        if (ws.isClosed) break;
        const chunk = args.slice(i, i + chunkSize);
        ws.send(
          evt("response.function_call_arguments.delta", {
            response_id: responseId,
            item_id: itemId,
            output_index: tcIdx,
            call_id: callId,
            delta: chunk,
          }),
        );
        interruption?.tick();
        if (interruption?.signal.aborted) {
          interrupted = true;
          break;
        }
      }

      if (interrupted) break;

      // response.function_call_arguments.done
      ws.send(
        evt("response.function_call_arguments.done", {
          response_id: responseId,
          item_id: itemId,
          output_index: tcIdx,
          call_id: callId,
          arguments: args,
        }),
      );

      // response.output_item.done
      ws.send(
        evt("response.output_item.done", {
          response_id: responseId,
          output_index: tcIdx,
          item: outputItem,
        }),
      );

      outputItems.push(outputItem);
    }

    if (interrupted) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
      interruption?.cleanup();
      return;
    }

    interruption?.cleanup();

    // response.done
    ws.send(
      evt("response.done", {
        response: { id: responseId, status: "completed", output: outputItems },
      }),
    );

    // Accumulate assistant tool calls into conversation for multi-turn
    for (let tcIdx = 0; tcIdx < response.toolCalls.length; tcIdx++) {
      const tc = response.toolCalls[tcIdx];
      const callId = tc.id ?? generateToolCallId();
      conversationItems.push({
        type: "function_call",
        id: generateId("item"),
        call_id: callId,
        name: tc.name,
        arguments: tc.arguments,
      });
    }
    return;
  }

  // Unknown response type
  journal.add({
    method: "WS",
    path: "/v1/realtime",
    headers: {},
    body: completionReq,
    response: { status: 500, fixture },
  });
  ws.send(buildErrorRealtimeEvent("Fixture response did not match any known type", "server_error"));
}
