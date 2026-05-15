/**
 * WebSocket handler for OpenAI Realtime API.
 *
 * Accepts Realtime API messages (session.update, conversation.item.create,
 * response.create) over WebSocket and sends back Realtime API events as
 * individual WebSocket text frames.
 */

import { randomBytes } from "node:crypto";
import type { ChatCompletionRequest, ChatMessage, Fixture } from "./types.js";
import { matchFixture } from "./router.js";
import {
  generateToolCallId,
  flattenHeaders,
  isTextResponse,
  isToolCallResponse,
  isContentWithToolCallsResponse,
  isErrorResponse,
  resolveResponse,
  resolveStrictMode,
  strictOverrideField,
} from "./helpers.js";
import { createInterruptionSignal } from "./interruption.js";
import { delay } from "./sse-writer.js";
import { DEFAULT_TEST_ID, type Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { WebSocketConnection } from "./ws-framing.js";

/** Generate a Realtime-API-style ID with underscore separator (e.g. event_xxx, item_xxx). */
function realtimeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

// ─── Realtime protocol types ────────────────────────────────────────────────

interface RealtimeItem {
  type: "message" | "function_call" | "function_call_output";
  id?: string;
  role?: "user" | "assistant" | "system";
  content?: Array<{ type: string; text?: string; url?: string; transcript?: string | null }>;
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
  input_audio_noise_reduction: { type: string } | null;
  input_audio_transcription: { model: string } | null;
  turn_detection: unknown | null;
  temperature: number;
  type: "conversation" | "transcription" | "translation";
  reasoning: { effort: string } | null;
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
  logger?: Logger,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  for (const item of items) {
    if (item.type === "message") {
      const role =
        item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";

      // Check if content contains multimodal input types (input_text, input_image, input_audio)
      const hasMultimodal = item.content?.some(
        (p) => p.type === "input_text" || p.type === "input_image" || p.type === "input_audio",
      );

      if (hasMultimodal && item.content) {
        // Map realtime input content types to ChatMessage content parts
        const mappedContent = item.content.map((part) => {
          if (part.type === "input_text") {
            return { type: "text" as const, text: part.text ?? "" };
          }
          if (part.type === "input_image") {
            return {
              type: "image_url" as const,
              image_url: { url: part.url ?? "" },
            };
          }
          if (part.type === "input_audio") {
            return { type: "text" as const, text: "[audio input]" };
          }
          // Pass through unknown content types as-is
          return part;
        });
        messages.push({ role, content: mappedContent });
      } else {
        // Existing behavior: extract text from first content element
        const text = item.content?.[0]?.text ?? "";
        messages.push({ role, content: text });
      }
    } else if (item.type === "function_call") {
      if (!item.name) {
        logger?.warn("Realtime function_call item missing 'name'");
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
        logger?.warn("Realtime function_call_output item missing 'output'");
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

// ─── GA -> Beta translation ─────────────────────────────────────────────────

/** GA -> Beta event name mapping */
const GA_TO_BETA_EVENT: Record<string, string> = {
  "response.output_text.delta": "response.text.delta",
  "response.output_text.done": "response.text.done",
  "response.output_audio.delta": "response.audio.delta",
  "response.output_audio.done": "response.audio.done",
  "response.output_audio_transcript.delta": "response.audio_transcript.delta",
  "response.output_audio_transcript.done": "response.audio_transcript.done",
  "conversation.item.added": "conversation.item.created",
};

/** GA -> Beta content type mapping */
const GA_TO_BETA_CONTENT_TYPE: Record<string, string> = {
  output_text: "text",
  output_audio: "audio",
};

/** Events suppressed in Beta mode (GA-only events) */
const BETA_SUPPRESSED_EVENTS = new Set(["conversation.item.done"]);

function translateGAToBeta(event: Record<string, unknown>): Record<string, unknown> | null {
  const type = event.type as string;
  if (BETA_SUPPRESSED_EVENTS.has(type)) return null;

  const translated = { ...event };
  if (GA_TO_BETA_EVENT[type]) {
    translated.type = GA_TO_BETA_EVENT[type];
  }

  // Translate content types in nested structures
  if (translated.part && typeof translated.part === "object") {
    const part = { ...(translated.part as Record<string, unknown>) };
    if (typeof part.type === "string" && GA_TO_BETA_CONTENT_TYPE[part.type]) {
      part.type = GA_TO_BETA_CONTENT_TYPE[part.type];
    }
    translated.part = part;
  }
  if (translated.content_part && typeof translated.content_part === "object") {
    const cp = { ...(translated.content_part as Record<string, unknown>) };
    if (typeof cp.type === "string" && GA_TO_BETA_CONTENT_TYPE[cp.type]) {
      cp.type = GA_TO_BETA_CONTENT_TYPE[cp.type];
    }
    translated.content_part = cp;
  }
  // Translate content arrays
  if (Array.isArray(translated.content)) {
    translated.content = (translated.content as Record<string, unknown>[]).map((c) => {
      if (typeof c.type === "string" && GA_TO_BETA_CONTENT_TYPE[c.type]) {
        return { ...c, type: GA_TO_BETA_CONTENT_TYPE[c.type] };
      }
      return c;
    });
  }
  // Translate item.content arrays (response.output_item.added/done, conversation.item.added)
  if (translated.item && typeof translated.item === "object") {
    const item = { ...(translated.item as Record<string, unknown>) };
    delete item.phase; // GA-only field
    if (Array.isArray(item.content)) {
      item.content = (item.content as Record<string, unknown>[]).map((c) => {
        if (typeof c.type === "string" && GA_TO_BETA_CONTENT_TYPE[c.type]) {
          return { ...c, type: GA_TO_BETA_CONTENT_TYPE[c.type] };
        }
        return c;
      });
    }
    translated.item = item;
  }
  // Translate response.output[].content arrays (response.done)
  if (translated.response && typeof translated.response === "object") {
    const resp = { ...(translated.response as Record<string, unknown>) };
    if (Array.isArray(resp.output)) {
      resp.output = (resp.output as Record<string, unknown>[]).map((outItem) => {
        const o = { ...(outItem as Record<string, unknown>) };
        if (Array.isArray(o.content)) {
          o.content = (o.content as Record<string, unknown>[]).map((c) =>
            typeof c.type === "string" && GA_TO_BETA_CONTENT_TYPE[c.type]
              ? { ...c, type: GA_TO_BETA_CONTENT_TYPE[c.type] }
              : c,
          );
        }
        return o;
      });
    }
    translated.response = resp;
  }

  // Flatten GA session config for Beta (session.created / session.updated)
  if (type === "session.created" || type === "session.updated") {
    if (translated.session && typeof translated.session === "object") {
      const session = { ...(translated.session as Record<string, unknown>) };
      if (session.audio && typeof session.audio === "object") {
        const audio = session.audio as Record<string, unknown>;
        session.voice = audio.voice;
        session.input_audio_format = audio.input_audio_format;
        session.output_audio_format = audio.output_audio_format;
        session.input_audio_transcription = audio.input_audio_transcription;
        delete session.audio;
      }
      delete session.type;
      delete session.reasoning;
      translated.session = session;
    }
  }

  return translated;
}

// ─── Event sending ──────────────────────────────────────────────────────────

function sendEvent(ws: WebSocketConnection, event: Record<string, unknown>, isBeta: boolean): void {
  const out = { ...event, event_id: event.event_id ?? realtimeId("event") };
  if (isBeta) {
    const translated = translateGAToBeta(out);
    if (translated === null) return; // suppressed in Beta mode
    ws.send(JSON.stringify(translated));
  } else {
    ws.send(JSON.stringify(out));
  }
}

function buildErrorRealtimeEvent(
  ws: WebSocketConnection,
  message: string,
  isBeta: boolean,
  type = "invalid_request_error",
  code?: string,
): void {
  sendEvent(ws, { type: "error", error: { message, type, code } }, isBeta);
}

// ─── Main handler ───────────────────────────────────────────────────────────

export function handleWebSocketRealtime(
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
  const sessionId = realtimeId("sess");

  const isBeta = defaults.upgradeHeaders?.["openai-beta"]
    ? String(defaults.upgradeHeaders["openai-beta"]).includes("realtime=v1")
    : false;

  const session: SessionConfig = {
    model: defaults.model,
    modalities: ["text"],
    instructions: "",
    tools: [],
    voice: null,
    input_audio_format: null,
    output_audio_format: null,
    input_audio_noise_reduction: null,
    input_audio_transcription: null,
    turn_detection: null,
    temperature: 0.8,
    type: "conversation",
    reasoning: null,
  };

  const conversationItems: RealtimeItem[] = [];

  // Send session.created immediately on connect (GA format — shim flattens for Beta)
  sendEvent(
    ws,
    {
      type: "session.created",
      session: {
        id: sessionId,
        object: "realtime.session",
        model: session.model,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        modalities: session.modalities,
        instructions: session.instructions,
        tools: session.tools,
        tool_choice: "auto",
        temperature: session.temperature,
        max_response_output_tokens: "inf",
        audio: {
          voice: session.voice,
          input_audio_format: session.input_audio_format,
          output_audio_format: session.output_audio_format,
          input_audio_noise_reduction: session.input_audio_noise_reduction,
          input_audio_transcription: session.input_audio_transcription,
        },
        turn_detection: session.turn_detection,
        type: session.type,
        reasoning: session.reasoning,
      },
    },
    isBeta,
  );

  // Serialize message processing to prevent event interleaving
  let pending = Promise.resolve();
  ws.on("message", (raw: string) => {
    pending = pending.then(() =>
      processMessage(
        raw,
        ws,
        fixtures,
        journal,
        defaults,
        session,
        conversationItems,
        isBeta,
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Internal error";
        logger.error(`WebSocket realtime error: ${msg}`);
        try {
          buildErrorRealtimeEvent(ws, msg, isBeta, "server_error");
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
  session: SessionConfig,
  conversationItems: RealtimeItem[],
  isBeta: boolean,
): Promise<void> {
  let parsed: RealtimeMessage;
  try {
    parsed = JSON.parse(raw) as RealtimeMessage;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    buildErrorRealtimeEvent(
      ws,
      `Malformed JSON: ${detail}`,
      isBeta,
      "invalid_request_error",
      "invalid_json",
    );
    return;
  }

  const msgType = parsed.type;

  // ── session.update ────────────────────────────────────────────────────
  if (msgType === "session.update") {
    if (parsed.session) {
      const s = parsed.session;

      // Validate session.type value before applying any mutations
      const validTypes = new Set(["conversation", "transcription", "translation"]);
      if ((s as Record<string, unknown>).type !== undefined) {
        if (!validTypes.has((s as Record<string, unknown>).type as string)) {
          sendEvent(
            ws,
            {
              type: "error",
              error: {
                message: `Invalid session type: ${(s as Record<string, unknown>).type}`,
                type: "invalid_request_error",
                code: "invalid_session_config",
              },
            },
            isBeta,
          );
          return;
        }
      }

      // Capture pre-mutation values for rollback on validation failure
      const prevModel = session.model;
      const prevType = session.type;

      if (s.instructions !== undefined) session.instructions = s.instructions;
      if (s.tools !== undefined) session.tools = s.tools;
      if (s.modalities !== undefined) session.modalities = s.modalities;
      if (s.model !== undefined) session.model = s.model;
      if (s.temperature !== undefined) session.temperature = s.temperature;
      if ((s as Record<string, unknown>).type !== undefined)
        session.type = (s as Record<string, unknown>).type as SessionConfig["type"];
      // GA nested audio config
      if ((s as Record<string, unknown>).audio) {
        const audio = (s as Record<string, unknown>).audio as Record<string, unknown>;
        if (audio.voice !== undefined) session.voice = audio.voice as string | null;
        if (audio.input_audio_format !== undefined)
          session.input_audio_format = audio.input_audio_format as string | null;
        if (audio.output_audio_format !== undefined)
          session.output_audio_format = audio.output_audio_format as string | null;
        if (audio.input_audio_noise_reduction !== undefined)
          session.input_audio_noise_reduction = audio.input_audio_noise_reduction as {
            type: string;
          } | null;
        if (audio.input_audio_transcription !== undefined)
          session.input_audio_transcription = audio.input_audio_transcription as {
            model: string;
          } | null;
      }
      // Beta flat fields (backward compat)
      if (s.voice !== undefined) session.voice = s.voice;
      if (s.input_audio_format !== undefined) session.input_audio_format = s.input_audio_format;
      if (s.output_audio_format !== undefined) session.output_audio_format = s.output_audio_format;
      // reasoning config
      if ((s as Record<string, unknown>).reasoning !== undefined)
        session.reasoning = (s as Record<string, unknown>).reasoning as {
          effort: string;
        } | null;

      // Validate model+type combinations (rollback on failure)
      const transcriptionModels = new Set([
        "gpt-4o-transcribe",
        "gpt-4o-mini-transcribe",
        "gpt-realtime-whisper",
        "whisper-1",
      ]);
      const translationModels = new Set([
        "gpt-4o-transcribe",
        "gpt-4o-mini-transcribe",
        "gpt-realtime-translate",
      ]);

      if (session.type === "transcription" && !transcriptionModels.has(session.model)) {
        session.model = prevModel;
        session.type = prevType;
        sendEvent(
          ws,
          {
            type: "error",
            error: {
              message: `Model ${s.model ?? prevModel} does not support session type transcription`,
              type: "invalid_request_error",
              code: "invalid_session_config",
            },
          },
          isBeta,
        );
        return;
      }
      if (session.type === "translation" && !translationModels.has(session.model)) {
        session.model = prevModel;
        session.type = prevType;
        sendEvent(
          ws,
          {
            type: "error",
            error: {
              message: `Model ${s.model ?? prevModel} does not support session type translation`,
              type: "invalid_request_error",
              code: "invalid_session_config",
            },
          },
          isBeta,
        );
        return;
      }
    }

    sendEvent(
      ws,
      {
        type: "session.updated",
        session: {
          object: "realtime.session",
          model: session.model,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          modalities: session.modalities,
          instructions: session.instructions,
          tools: session.tools,
          tool_choice: "auto",
          temperature: session.temperature,
          max_response_output_tokens: "inf",
          audio: {
            voice: session.voice,
            input_audio_format: session.input_audio_format,
            output_audio_format: session.output_audio_format,
            input_audio_noise_reduction: session.input_audio_noise_reduction,
            input_audio_transcription: session.input_audio_transcription,
          },
          turn_detection: session.turn_detection,
          type: session.type,
          reasoning: session.reasoning,
        },
      },
      isBeta,
    );
    return;
  }

  // ── conversation.item.create ──────────────────────────────────────────
  if (msgType === "conversation.item.create") {
    if (!parsed.item) {
      buildErrorRealtimeEvent(
        ws,
        "Missing 'item' in conversation.item.create",
        isBeta,
        "invalid_request_error",
      );
      return;
    }
    const item = parsed.item;
    if (!item.id) {
      item.id = realtimeId("item");
    }
    const previousId =
      conversationItems.length > 0
        ? (conversationItems[conversationItems.length - 1].id ?? null)
        : null;
    conversationItems.push(item);
    sendEvent(ws, { type: "conversation.item.added", previous_item_id: previousId, item }, isBeta);
    return;
  }

  // ── response.create ───────────────────────────────────────────────────
  if (msgType === "response.create") {
    await handleResponseCreate(
      ws,
      fixtures,
      journal,
      defaults,
      session,
      conversationItems,
      isBeta,
      parsed.response,
    );
    return;
  }

  // ── input_audio_buffer.append ────────────────────────────────────────
  if (msgType === "input_audio_buffer.append") {
    // Accept silently — aimock doesn't process actual audio
    return;
  }

  // ── input_audio_buffer.commit ──────────────────────────────────────
  if (msgType === "input_audio_buffer.commit") {
    sendEvent(ws, { type: "input_audio_buffer.committed" }, isBeta);
    // In transcription/translation mode, add a placeholder user item
    if (session.type === "transcription" || session.type === "translation") {
      const audioItem: RealtimeItem = {
        type: "message",
        id: realtimeId("item"),
        role: "user",
        content: [{ type: "input_audio", transcript: null }],
      };
      conversationItems.push(audioItem);
      sendEvent(
        ws,
        {
          type: "conversation.item.added",
          item: audioItem,
        },
        isBeta,
      );
    }
    return;
  }

  // ── input_audio_buffer.clear ───────────────────────────────────────
  if (msgType === "input_audio_buffer.clear") {
    sendEvent(ws, { type: "input_audio_buffer.cleared" }, isBeta);
    return;
  }

  // ── response.cancel ────────────────────────────────────────────────
  if (msgType === "response.cancel") {
    sendEvent(ws, { type: "response.cancelled" }, isBeta);
    return;
  }

  // Unknown message type — ignore silently (matches OpenAI behavior)
}

async function handleResponseCreate(
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
  session: SessionConfig,
  conversationItems: RealtimeItem[],
  isBeta: boolean,
  responseOverrides?: { instructions?: string; [key: string]: unknown },
): Promise<void> {
  const instructions = (responseOverrides?.instructions ?? session.instructions) || undefined;
  const messages = realtimeItemsToMessages(conversationItems, instructions, defaults.logger);

  const endpointTypeMap: Record<string, string> = {
    conversation: "realtime",
    transcription: "realtime-transcription",
    translation: "realtime-translation",
  };
  const endpointType = endpointTypeMap[session.type] ?? "realtime";

  const completionReq: ChatCompletionRequest = {
    model: session.model,
    messages,
    _endpointType: endpointType,
  };

  const testId = defaults.testId ?? DEFAULT_TEST_ID;
  const fixture = matchFixture(
    fixtures,
    completionReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );
  const responseId = realtimeId("resp");

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (!fixture) {
    if (resolveStrictMode(defaults.strict, defaults.upgradeHeaders)) {
      defaults.logger.warn(`STRICT: No fixture matched for WebSocket message`);
      journal.add({
        method: "WS",
        path: "/v1/realtime",
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
      path: "/v1/realtime",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, defaults.upgradeHeaders),
      },
    });
    // Send response.created with failed status then response.done with error
    sendEvent(
      ws,
      {
        type: "response.created",
        response: {
          id: responseId,
          object: "realtime.response",
          status: "failed",
          status_details: null,
          output: [],
          usage: null,
        },
      },
      isBeta,
    );
    sendEvent(
      ws,
      {
        type: "response.done",
        response: {
          id: responseId,
          object: "realtime.response",
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
          usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
        },
      },
      isBeta,
    );
    return;
  }

  const response = await resolveResponse(fixture, completionReq);
  const latency = fixture.latency ?? defaults.latency;
  const chunkSize = Math.max(1, fixture.chunkSize ?? defaults.chunkSize);

  // ── Error fixture ───────────────────────────────────────────────────
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    journal.add({
      method: "WS",
      path: "/v1/realtime",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status, fixture },
    });
    sendEvent(
      ws,
      {
        type: "response.created",
        response: {
          id: responseId,
          object: "realtime.response",
          status: "failed",
          status_details: null,
          output: [],
          usage: null,
        },
      },
      isBeta,
    );
    sendEvent(
      ws,
      {
        type: "response.done",
        response: {
          id: responseId,
          object: "realtime.response",
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
          usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
        },
      },
      isBeta,
    );
    return;
  }

  // ── Content + tool calls response ──────────────────────────────────
  if (isContentWithToolCallsResponse(response)) {
    const journalEntry = journal.add({
      method: "WS",
      path: "/v1/realtime",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: 200, fixture },
    });

    // response.created
    sendEvent(
      ws,
      {
        type: "response.created",
        response: {
          id: responseId,
          object: "realtime.response",
          status: "in_progress",
          status_details: null,
          output: [],
          usage: null,
        },
      },
      isBeta,
    );

    const interruption = createInterruptionSignal(fixture);
    let interrupted = false;
    const allOutputItems: unknown[] = [];

    // ── Text content part ──────────────────────────────────────────
    const textItemId = realtimeId("item");
    const contentIndex = 0;
    const textOutputIndex = 0;

    const textOutputItem = {
      id: textItemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: response.content }],
    };

    // Determine phase: text is "commentary" when tool calls are also present
    const hasToolCalls = response.toolCalls && response.toolCalls.length > 0;
    const textPhase = hasToolCalls ? "commentary" : "final_answer";

    // response.output_item.added (text)
    sendEvent(
      ws,
      {
        type: "response.output_item.added",
        response_id: responseId,
        output_index: textOutputIndex,
        item: {
          id: textItemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
          phase: textPhase,
        },
      },
      isBeta,
    );

    // response.content_part.added
    sendEvent(
      ws,
      {
        type: "response.content_part.added",
        response_id: responseId,
        item_id: textItemId,
        output_index: textOutputIndex,
        content_index: contentIndex,
        part: { type: "output_text", text: "" },
      },
      isBeta,
    );

    // response.output_text.delta (chunked) — GA name
    const content = response.content;
    for (let i = 0; i < content.length; i += chunkSize) {
      if (ws.isClosed) break;
      if (latency > 0) await delay(latency, interruption?.signal);
      if (interruption?.signal.aborted) {
        interrupted = true;
        break;
      }
      if (ws.isClosed) break;
      const chunk = content.slice(i, i + chunkSize);
      sendEvent(
        ws,
        {
          type: "response.output_text.delta",
          response_id: responseId,
          item_id: textItemId,
          output_index: textOutputIndex,
          content_index: contentIndex,
          delta: chunk,
        },
        isBeta,
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

    if (ws.isClosed) {
      interruption?.cleanup();
      return;
    }

    // response.output_text.done
    sendEvent(
      ws,
      {
        type: "response.output_text.done",
        response_id: responseId,
        item_id: textItemId,
        output_index: textOutputIndex,
        content_index: contentIndex,
        text: content,
      },
      isBeta,
    );

    if (ws.isClosed) {
      interruption?.cleanup();
      return;
    }

    // response.content_part.done
    sendEvent(
      ws,
      {
        type: "response.content_part.done",
        response_id: responseId,
        item_id: textItemId,
        output_index: textOutputIndex,
        content_index: contentIndex,
        part: { type: "output_text", text: content },
      },
      isBeta,
    );

    if (ws.isClosed) {
      interruption?.cleanup();
      return;
    }

    // response.output_item.done (text)
    sendEvent(
      ws,
      {
        type: "response.output_item.done",
        response_id: responseId,
        output_index: textOutputIndex,
        item: { ...textOutputItem, phase: textPhase },
      },
      isBeta,
    );

    // conversation.item.done (text message)
    sendEvent(
      ws,
      {
        type: "conversation.item.done",
        item: {
          id: textItemId,
          object: "realtime.item",
          type: "message",
          role: "assistant",
          status: "completed",
          content: textOutputItem.content,
        },
      },
      isBeta,
    );

    if (ws.isClosed) {
      interruption?.cleanup();
      return;
    }

    allOutputItems.push(textOutputItem);

    // ── Tool call parts ────────────────────────────────────────────
    for (let tcIdx = 0; tcIdx < response.toolCalls.length; tcIdx++) {
      const tc = response.toolCalls[tcIdx];
      const callId = tc.id ?? generateToolCallId();
      const itemId = realtimeId("item");
      const outputIndex = tcIdx + 1; // offset by 1 for the text item

      const toolOutputItem = {
        id: itemId,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: tc.name,
        arguments: tc.arguments,
      };

      // response.output_item.added
      sendEvent(
        ws,
        {
          type: "response.output_item.added",
          response_id: responseId,
          output_index: outputIndex,
          item: {
            id: itemId,
            type: "function_call",
            status: "in_progress",
            call_id: callId,
            name: tc.name,
            arguments: "",
            phase: "final_answer",
          },
        },
        isBeta,
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
        sendEvent(
          ws,
          {
            type: "response.function_call_arguments.delta",
            response_id: responseId,
            item_id: itemId,
            output_index: outputIndex,
            call_id: callId,
            delta: chunk,
          },
          isBeta,
        );
        interruption?.tick();
        if (interruption?.signal.aborted) {
          interrupted = true;
          break;
        }
      }

      if (interrupted) break;

      if (ws.isClosed) break;

      // response.function_call_arguments.done
      sendEvent(
        ws,
        {
          type: "response.function_call_arguments.done",
          response_id: responseId,
          item_id: itemId,
          output_index: outputIndex,
          call_id: callId,
          arguments: args,
        },
        isBeta,
      );

      if (ws.isClosed) break;

      // response.output_item.done
      sendEvent(
        ws,
        {
          type: "response.output_item.done",
          response_id: responseId,
          output_index: outputIndex,
          item: { ...toolOutputItem, phase: "final_answer" },
        },
        isBeta,
      );

      // conversation.item.done (tool call)
      sendEvent(
        ws,
        {
          type: "conversation.item.done",
          item: {
            id: itemId,
            object: "realtime.item",
            type: "function_call",
            status: "completed",
            call_id: callId,
            name: tc.name,
            arguments: args,
          },
        },
        isBeta,
      );

      if (ws.isClosed) break;

      allOutputItems.push(toolOutputItem);
    }

    if (interrupted) {
      ws.destroy();
      journalEntry.response.interrupted = true;
      journalEntry.response.interruptReason = interruption?.reason();
      interruption?.cleanup();
      return;
    }

    interruption?.cleanup();

    if (ws.isClosed) return;

    // response.done
    sendEvent(
      ws,
      {
        type: "response.done",
        response: {
          id: responseId,
          object: "realtime.response",
          status: "completed",
          output: allOutputItems,
          usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
        },
      },
      isBeta,
    );

    // Accumulate into conversation for multi-turn
    conversationItems.push({
      type: "message",
      id: textItemId,
      role: "assistant",
      content: [{ type: "text", text: content }],
    });
    for (const item of allOutputItems.slice(1)) {
      conversationItems.push(item as RealtimeItem);
    }
    return;
  }

  // ── Text response ───────────────────────────────────────────────────
  if (isTextResponse(response)) {
    const journalEntry = journal.add({
      method: "WS",
      path: "/v1/realtime",
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: 200, fixture },
    });

    const itemId = realtimeId("item");
    const contentIndex = 0;
    const outputIndex = 0;

    const outputItem = {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: response.content }],
    };

    // response.created
    sendEvent(
      ws,
      {
        type: "response.created",
        response: {
          id: responseId,
          object: "realtime.response",
          status: "in_progress",
          status_details: null,
          output: [],
          usage: null,
        },
      },
      isBeta,
    );

    // response.output_item.added
    sendEvent(
      ws,
      {
        type: "response.output_item.added",
        response_id: responseId,
        output_index: outputIndex,
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
          phase: "final_answer",
        },
      },
      isBeta,
    );

    // response.content_part.added
    sendEvent(
      ws,
      {
        type: "response.content_part.added",
        response_id: responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: { type: "output_text", text: "" },
      },
      isBeta,
    );

    // response.output_text.delta (chunked) — GA name
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
      sendEvent(
        ws,
        {
          type: "response.output_text.delta",
          response_id: responseId,
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: chunk,
        },
        isBeta,
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

    if (ws.isClosed) return;

    // response.output_text.done
    sendEvent(
      ws,
      {
        type: "response.output_text.done",
        response_id: responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        text: content,
      },
      isBeta,
    );

    // response.content_part.done
    sendEvent(
      ws,
      {
        type: "response.content_part.done",
        response_id: responseId,
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: { type: "output_text", text: content },
      },
      isBeta,
    );

    // response.output_item.done
    sendEvent(
      ws,
      {
        type: "response.output_item.done",
        response_id: responseId,
        output_index: outputIndex,
        item: { ...outputItem, phase: "final_answer" },
      },
      isBeta,
    );

    // conversation.item.done (text message)
    sendEvent(
      ws,
      {
        type: "conversation.item.done",
        item: {
          id: itemId,
          object: "realtime.item",
          type: "message",
          role: "assistant",
          status: "completed",
          content: outputItem.content,
        },
      },
      isBeta,
    );

    // response.done
    sendEvent(
      ws,
      {
        type: "response.done",
        response: {
          id: responseId,
          object: "realtime.response",
          status: "completed",
          output: [outputItem],
          usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
        },
      },
      isBeta,
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
      headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
      body: completionReq,
      response: { status: 200, fixture },
    });

    // response.created
    sendEvent(
      ws,
      {
        type: "response.created",
        response: {
          id: responseId,
          object: "realtime.response",
          status: "in_progress",
          status_details: null,
          output: [],
          usage: null,
        },
      },
      isBeta,
    );

    const outputItems: unknown[] = [];
    const interruption = createInterruptionSignal(fixture);
    let interrupted = false;

    for (let tcIdx = 0; tcIdx < response.toolCalls.length; tcIdx++) {
      const tc = response.toolCalls[tcIdx];
      const callId = tc.id ?? generateToolCallId();
      const itemId = realtimeId("item");

      const outputItem = {
        id: itemId,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: tc.name,
        arguments: tc.arguments,
      };

      // response.output_item.added
      sendEvent(
        ws,
        {
          type: "response.output_item.added",
          response_id: responseId,
          output_index: tcIdx,
          item: {
            id: itemId,
            type: "function_call",
            status: "in_progress",
            call_id: callId,
            name: tc.name,
            arguments: "",
            phase: "final_answer",
          },
        },
        isBeta,
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
        sendEvent(
          ws,
          {
            type: "response.function_call_arguments.delta",
            response_id: responseId,
            item_id: itemId,
            output_index: tcIdx,
            call_id: callId,
            delta: chunk,
          },
          isBeta,
        );
        interruption?.tick();
        if (interruption?.signal.aborted) {
          interrupted = true;
          break;
        }
      }

      if (interrupted) break;

      if (ws.isClosed) break;

      // response.function_call_arguments.done
      sendEvent(
        ws,
        {
          type: "response.function_call_arguments.done",
          response_id: responseId,
          item_id: itemId,
          output_index: tcIdx,
          call_id: callId,
          arguments: args,
        },
        isBeta,
      );

      // response.output_item.done
      sendEvent(
        ws,
        {
          type: "response.output_item.done",
          response_id: responseId,
          output_index: tcIdx,
          item: { ...outputItem, phase: "final_answer" },
        },
        isBeta,
      );

      // conversation.item.done (tool call)
      sendEvent(
        ws,
        {
          type: "conversation.item.done",
          item: {
            id: itemId,
            object: "realtime.item",
            type: "function_call",
            status: "completed",
            call_id: callId,
            name: tc.name,
            arguments: args,
          },
        },
        isBeta,
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

    if (ws.isClosed) return;

    // response.done
    sendEvent(
      ws,
      {
        type: "response.done",
        response: {
          id: responseId,
          object: "realtime.response",
          status: "completed",
          output: outputItems,
          usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
        },
      },
      isBeta,
    );

    // Accumulate assistant tool calls into conversation for multi-turn
    // Reuse outputItems (which already have the correct call_id) to avoid generating divergent IDs
    for (const item of outputItems) {
      conversationItems.push(item as RealtimeItem);
    }
    return;
  }

  // Unknown response type
  journal.add({
    method: "WS",
    path: "/v1/realtime",
    headers: flattenHeaders(defaults.upgradeHeaders ?? {}),
    body: completionReq,
    response: { status: 500, fixture },
  });
  buildErrorRealtimeEvent(
    ws,
    "Fixture response did not match any known type",
    isBeta,
    "server_error",
  );
}
