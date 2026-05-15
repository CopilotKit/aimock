/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEXT_FIXTURE: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const TOOL_FIXTURE: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
  },
};

const ERROR_FIXTURE: Fixture = {
  match: { userMessage: "error-test" },
  response: {
    error: { message: "Rate limited", type: "RESOURCE_EXHAUSTED" },
    status: 429,
  },
};

// ---------------------------------------------------------------------------
// Shared server instance
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer([TEXT_FIXTURE, TOOL_FIXTURE, ERROR_FIXTURE], {
    port: 0,
    chunkSize: 100,
  });
});

afterAll(async () => {
  await new Promise<void>((r) => instance.server.close(() => r()));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GEMINI_WS_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

interface WSFrame {
  type?: string;
  [key: string]: unknown;
}

function parseFrames(raw: string[]): WSFrame[] {
  return raw.map((m) => JSON.parse(m) as WSFrame);
}

/** Send a response.create message for the WS Responses endpoint. */
function responsesCreateMsg(userContent: string): string {
  return JSON.stringify({
    type: "response.create",
    model: "gpt-4",
    input: [{ role: "user", content: userContent }],
  });
}

/** Build a conversation.item.create message for the Realtime endpoint. */
function realtimeItemCreate(text: string): string {
  return JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

/** Build a response.create message for the Realtime endpoint. */
function realtimeResponseCreate(): string {
  return JSON.stringify({ type: "response.create" });
}

/** Build a Gemini setup message. */
function geminiSetup(model = "gemini-2.0-flash-exp"): string {
  return JSON.stringify({ setup: { model } });
}

/** Build a Gemini clientContent message. */
function geminiClientContent(text: string): string {
  return JSON.stringify({
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    },
  });
}

// ---------------------------------------------------------------------------
// 6. WS Responses API conformance
// ---------------------------------------------------------------------------

describe("WS Responses API conformance", () => {
  describe("text response", () => {
    it("every event frame is valid JSON with type string field", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      for (const msg of raw) {
        const parsed = JSON.parse(msg) as any;
        expect(typeof parsed.type).toBe("string");
      }
    });

    it("response.created has response with resp- id, status in_progress, empty output", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      const frames = parseFrames(raw);
      const created = frames.find((f) => f.type === "response.created")!;
      expect(created).toBeDefined();
      const resp = created.response as any;
      expect(resp.id).toMatch(/^resp-/);
      expect(resp.status).toBe("in_progress");
      expect(resp.output).toEqual([]);
    });

    it("response.in_progress event is present", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      const frames = parseFrames(raw);
      const inProgress = frames.find((f) => f.type === "response.in_progress");
      expect(inProgress).toBeDefined();
    });

    it("response.output_item.added has item with id, type message, role assistant", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      const frames = parseFrames(raw);
      const itemAdded = frames.find((f) => f.type === "response.output_item.added")!;
      expect(itemAdded).toBeDefined();
      const item = itemAdded.item as any;
      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.type).toBe("message");
      expect(item.role).toBe("assistant");
    });

    it("response.content_part.added has part with type output_text", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      const frames = parseFrames(raw);
      const partAdded = frames.find((f) => f.type === "response.content_part.added")!;
      expect(partAdded).toBeDefined();
      const part = partAdded.part as any;
      expect(part.type).toBe("output_text");
    });

    it("response.output_text.delta events have delta as string", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      const frames = parseFrames(raw);
      const deltas = frames.filter((f) => f.type === "response.output_text.delta");
      expect(deltas.length).toBeGreaterThan(0);
      for (const d of deltas) {
        expect(typeof d.delta).toBe("string");
      }
    });

    it("response.output_text.done has text field with full content", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      const frames = parseFrames(raw);
      const textDone = frames.find((f) => f.type === "response.output_text.done")!;
      expect(textDone).toBeDefined();
      // The text field contains the complete accumulated text
      expect(typeof (textDone as any).text).toBe("string");
      expect((textDone as any).text).toBe("Hi there!");
    });

    it("response.completed has response with status completed and output array", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      const frames = parseFrames(raw);
      const completed = frames.find((f) => f.type === "response.completed")!;
      expect(completed).toBeDefined();
      const resp = completed.response as any;
      expect(resp.status).toBe("completed");
      expect(Array.isArray(resp.output)).toBe(true);
      expect(resp.output.length).toBeGreaterThan(0);
    });

    it("response.completed response id matches response.created id", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      const frames = parseFrames(raw);
      const created = frames.find((f) => f.type === "response.created")!;
      const completed = frames.find((f) => f.type === "response.completed")!;
      expect((created.response as any).id).toBe((completed.response as any).id);
    });

    it("event sequence follows correct order", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("hello"));
      const raw = await ws.waitForMessages(9);
      ws.close();
      const types = parseFrames(raw).map((f) => f.type);
      expect(types[0]).toBe("response.created");
      expect(types[1]).toBe("response.in_progress");
      expect(types).toContain("response.output_item.added");
      expect(types).toContain("response.content_part.added");
      expect(types).toContain("response.output_text.delta");
      expect(types).toContain("response.output_text.done");
      expect(types).toContain("response.content_part.done");
      expect(types).toContain("response.output_item.done");
      expect(types[types.length - 1]).toBe("response.completed");
    });
  });

  describe("tool call response", () => {
    it("response.output_item.added has item type function_call with call_id and name", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("weather"));
      const raw = await ws.waitForMessages(7);
      ws.close();
      const frames = parseFrames(raw);
      const itemAdded = frames.find(
        (f) => f.type === "response.output_item.added" && (f.item as any)?.type === "function_call",
      )!;
      expect(itemAdded).toBeDefined();
      const item = itemAdded.item as any;
      expect(item.type).toBe("function_call");
      expect(item.call_id).toMatch(/^call_/);
      expect(typeof item.name).toBe("string");
      expect(item.name).toBe("get_weather");
    });

    it("response.output_item.added function_call item has empty arguments initially", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("weather"));
      const raw = await ws.waitForMessages(7);
      ws.close();
      const frames = parseFrames(raw);
      const itemAdded = frames.find(
        (f) => f.type === "response.output_item.added" && (f.item as any)?.type === "function_call",
      )!;
      expect((itemAdded.item as any).arguments).toBe("");
    });

    it("response.function_call_arguments.delta has delta as string", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("weather"));
      const raw = await ws.waitForMessages(7);
      ws.close();
      const frames = parseFrames(raw);
      const argDeltas = frames.filter((f) => f.type === "response.function_call_arguments.delta");
      expect(argDeltas.length).toBeGreaterThan(0);
      for (const d of argDeltas) {
        expect(typeof d.delta).toBe("string");
      }
    });

    it("response.function_call_arguments.done has full arguments string", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("weather"));
      const raw = await ws.waitForMessages(7);
      ws.close();
      const frames = parseFrames(raw);
      const argsDone = frames.find((f) => f.type === "response.function_call_arguments.done")!;
      expect(argsDone).toBeDefined();
      expect(typeof (argsDone as any).arguments).toBe("string");
      expect((argsDone as any).arguments).toBe('{"city":"SF"}');
    });

    it("tool call event sequence includes response.in_progress and response.output_item.done", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("weather"));
      const raw = await ws.waitForMessages(7);
      ws.close();
      const types = parseFrames(raw).map((f) => f.type);
      expect(types[0]).toBe("response.created");
      expect(types).toContain("response.in_progress");
      expect(types).toContain("response.output_item.added");
      expect(types).toContain("response.output_item.done");
      expect(types[types.length - 1]).toBe("response.completed");
    });
  });

  describe("error response", () => {
    it("error event has type error with error.message and error.type", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("error-test"));
      const raw = await ws.waitForMessages(1);
      ws.close();
      const frame = JSON.parse(raw[0]) as any;
      expect(frame.type).toBe("error");
      expect(typeof frame.error.message).toBe("string");
      expect(frame.error.message).toBe("Rate limited");
      expect(typeof frame.error.type).toBe("string");
    });

    it("no-match error: type is error with message No fixture matched", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send(responsesCreateMsg("no-match-xyz-9999"));
      const raw = await ws.waitForMessages(1);
      ws.close();
      const frame = JSON.parse(raw[0]) as any;
      expect(frame.type).toBe("error");
      expect(frame.error.message).toBe("No fixture matched");
    });

    it("malformed JSON: error event has type error", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/responses");
      ws.send("{not valid json");
      const raw = await ws.waitForMessages(1);
      ws.close();
      const frame = JSON.parse(raw[0]) as any;
      expect(frame.type).toBe("error");
      expect(frame.error.message).toMatch(/^Malformed JSON:/);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. WS Realtime API conformance
// ---------------------------------------------------------------------------

describe("WS Realtime API conformance", () => {
  describe("session.created on connect", () => {
    it("session.created is sent immediately on connect with event_id event_ prefix", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/realtime");
      const raw = await ws.waitForMessages(1);
      ws.close();
      const frame = JSON.parse(raw[0]) as any;
      expect(frame.type).toBe("session.created");
      expect(typeof frame.event_id).toBe("string");
      expect(frame.event_id).toMatch(/^event_/);
    });

    it("session.created has session with id (sess_ prefix), modalities, tools", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/realtime");
      const raw = await ws.waitForMessages(1);
      ws.close();
      const frame = JSON.parse(raw[0]) as any;
      const session = frame.session;
      expect(session.id).toMatch(/^sess_/);
      expect(Array.isArray(session.modalities)).toBe(true);
      expect(session.modalities).toContain("text");
      expect(Array.isArray(session.tools)).toBe(true);
    });
  });

  describe("session.updated", () => {
    it("session.updated reflects session changes with event_id event_ prefix", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/realtime");
      await ws.waitForMessages(1); // session.created
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: { instructions: "Be concise." },
        }),
      );
      const raw = await ws.waitForMessages(2);
      ws.close();
      const frame = JSON.parse(raw[1]) as any;
      expect(frame.type).toBe("session.updated");
      expect(frame.event_id).toMatch(/^event_/);
      expect(frame.session.instructions).toBe("Be concise.");
    });
  });

  describe("conversation.item.added", () => {
    it("conversation.item.added has item with id", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/realtime");
      await ws.waitForMessages(1); // session.created
      ws.send(realtimeItemCreate("hello"));
      const raw = await ws.waitForMessages(2);
      ws.close();
      const frame = JSON.parse(raw[1]) as any;
      expect(frame.type).toBe("conversation.item.added");
      expect(typeof frame.item.id).toBe("string");
      expect(frame.item.id.length).toBeGreaterThan(0);
    });
  });

  describe("text response events", () => {
    async function getTextResponseFrames() {
      const ws = await connectWebSocket(instance.url, "/v1/realtime");
      await ws.waitForMessages(1); // session.created
      ws.send(realtimeItemCreate("hello"));
      await ws.waitForMessages(2); // + conversation.item.added
      ws.send(realtimeResponseCreate());
      // session.created + item.added + response.created + output_item.added
      // + content_part.added + output_text.delta(s) + output_text.done + content_part.done
      // + output_item.done + conversation.item.done + response.done = 11 min
      const raw = await ws.waitForMessages(11);
      ws.close();
      return raw.slice(2).map((m) => JSON.parse(m) as any);
    }

    it("all response events have event_id starting with event_", async () => {
      const frames = await getTextResponseFrames();
      for (const f of frames) {
        expect(f.event_id).toMatch(/^event_/);
      }
    });

    it("response.created has response.id (resp_ prefix), status in_progress", async () => {
      const frames = await getTextResponseFrames();
      const created = frames.find((f: any) => f.type === "response.created")!;
      expect(created).toBeDefined();
      expect((created.response as any).id).toMatch(/^resp_/);
      expect((created.response as any).status).toBe("in_progress");
    });

    it("response.output_item.added for text has item type message, role assistant", async () => {
      const frames = await getTextResponseFrames();
      const itemAdded = frames.find(
        (f: any) => f.type === "response.output_item.added" && f.item?.type === "message",
      )!;
      expect(itemAdded).toBeDefined();
      expect((itemAdded.item as any).type).toBe("message");
      expect((itemAdded.item as any).role).toBe("assistant");
    });

    it("response.content_part.added has part with type output_text", async () => {
      const frames = await getTextResponseFrames();
      const partAdded = frames.find((f: any) => f.type === "response.content_part.added")!;
      expect(partAdded).toBeDefined();
      const part = (partAdded as any).part;
      expect(part.type).toBe("output_text");
      expect(part.text).toBe("");
    });

    it("response.output_text.delta has response_id, item_id, output_index, content_index, delta as string", async () => {
      const frames = await getTextResponseFrames();
      const deltas = frames.filter((f: any) => f.type === "response.output_text.delta");
      expect(deltas.length).toBeGreaterThan(0);
      for (const d of deltas) {
        expect(typeof (d as any).response_id).toBe("string");
        expect(typeof (d as any).item_id).toBe("string");
        expect(typeof (d as any).output_index).toBe("number");
        expect(typeof (d as any).content_index).toBe("number");
        expect(typeof (d as any).delta).toBe("string");
      }
    });

    it("response.output_text.done has full text", async () => {
      const frames = await getTextResponseFrames();
      const textDone = frames.find((f: any) => f.type === "response.output_text.done")!;
      expect(textDone).toBeDefined();
      expect((textDone as any).text).toBe("Hi there!");
    });

    it("response.content_part.done has part with type output_text and text content", async () => {
      const frames = await getTextResponseFrames();
      const partDone = frames.find((f: any) => f.type === "response.content_part.done")!;
      expect(partDone).toBeDefined();
      const part = (partDone as any).part;
      expect(part.type).toBe("output_text");
      expect(typeof part.text).toBe("string");
      expect(part.text).toBe("Hi there!");
    });

    it("response.output_item.done has complete item", async () => {
      const frames = await getTextResponseFrames();
      const itemDone = frames.find((f: any) => f.type === "response.output_item.done")!;
      expect(itemDone).toBeDefined();
      const item = (itemDone as any).item;
      expect(item.type).toBe("message");
      expect(item.role).toBe("assistant");
      expect(Array.isArray(item.content)).toBe(true);
    });

    it("response.done has response with status completed and output array", async () => {
      const frames = await getTextResponseFrames();
      const done = frames.find((f: any) => f.type === "response.done")!;
      expect(done).toBeDefined();
      const resp = (done as any).response;
      expect(resp.status).toBe("completed");
      expect(Array.isArray(resp.output)).toBe(true);
      expect(resp.output.length).toBeGreaterThan(0);
    });
  });

  describe("tool call response events", () => {
    async function getToolCallFrames() {
      const ws = await connectWebSocket(instance.url, "/v1/realtime");
      await ws.waitForMessages(1); // session.created
      ws.send(realtimeItemCreate("weather"));
      await ws.waitForMessages(2); // + conversation.item.added
      ws.send(realtimeResponseCreate());
      // session.created + item.added + response.created + output_item.added
      // + args.delta(s) + args.done + output_item.done + conversation.item.done + response.done = 9 min
      const raw = await ws.waitForMessages(9);
      ws.close();
      return raw.slice(2).map((m) => JSON.parse(m) as any);
    }

    it("response.output_item.added has type function_call, call_id (call- prefix), name, empty arguments", async () => {
      const frames = await getToolCallFrames();
      const itemAdded = frames.find(
        (f: any) => f.type === "response.output_item.added" && f.item?.type === "function_call",
      )!;
      expect(itemAdded).toBeDefined();
      const item = (itemAdded as any).item;
      expect(item.type).toBe("function_call");
      expect(item.call_id).toMatch(/^call_/);
      expect(typeof item.name).toBe("string");
      expect(item.name).toBe("get_weather");
      expect(item.arguments).toBe("");
    });

    it("response.function_call_arguments.delta has delta, call_id, item_id, output_index", async () => {
      const frames = await getToolCallFrames();
      const argDeltas = frames.filter(
        (f: any) => f.type === "response.function_call_arguments.delta",
      );
      expect(argDeltas.length).toBeGreaterThan(0);
      for (const d of argDeltas) {
        expect(typeof (d as any).delta).toBe("string");
        expect(typeof (d as any).call_id).toBe("string");
        expect(typeof (d as any).item_id).toBe("string");
        expect(typeof (d as any).output_index).toBe("number");
      }
    });

    it("response.function_call_arguments.done has full arguments", async () => {
      const frames = await getToolCallFrames();
      const argsDone = frames.find((f: any) => f.type === "response.function_call_arguments.done")!;
      expect(argsDone).toBeDefined();
      expect((argsDone as any).arguments).toBe('{"city":"SF"}');
    });
  });

  describe("error / failed response", () => {
    it("no-match: response.done has status failed with status_details.error", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/realtime");
      await ws.waitForMessages(1); // session.created
      ws.send(realtimeItemCreate("no-match-xyz-9999"));
      await ws.waitForMessages(2); // + conversation.item.added
      ws.send(realtimeResponseCreate());
      const raw = await ws.waitForMessages(4); // + response.created + response.done
      ws.close();
      const responseEvents = raw.slice(2).map((m) => JSON.parse(m) as any);
      const done = responseEvents.find((f: any) => f.type === "response.done")!;
      expect(done).toBeDefined();
      const resp = done.response as any;
      expect(resp.status).toBe("failed");
      expect(resp.status_details.type).toBe("error");
      expect(typeof resp.status_details.error.message).toBe("string");
    });

    it("error fixture: response.done has status failed with fixture error message", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/realtime");
      await ws.waitForMessages(1); // session.created
      ws.send(realtimeItemCreate("error-test"));
      await ws.waitForMessages(2); // + conversation.item.added
      ws.send(realtimeResponseCreate());
      const raw = await ws.waitForMessages(4); // + response.created + response.done
      ws.close();
      const responseEvents = raw.slice(2).map((m) => JSON.parse(m) as any);
      const done = responseEvents.find((f: any) => f.type === "response.done")!;
      const resp = done.response as any;
      expect(resp.status).toBe("failed");
      expect(resp.status_details.error.message).toBe("Rate limited");
    });

    it("malformed JSON: error event has type error with event_ event_id", async () => {
      const ws = await connectWebSocket(instance.url, "/v1/realtime");
      await ws.waitForMessages(1); // session.created
      ws.send("{not valid json");
      const raw = await ws.waitForMessages(2);
      ws.close();
      const frame = JSON.parse(raw[1]) as any;
      expect(frame.type).toBe("error");
      expect(frame.event_id).toMatch(/^event_/);
      expect(frame.error.message).toMatch(/^Malformed JSON:/);
    });
  });
});

// ---------------------------------------------------------------------------
// 7a. GA Realtime conformance
// ---------------------------------------------------------------------------

describe("GA Realtime conformance", () => {
  it("session.created includes nested audio config, type field, and reasoning field", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2");
    const raw = await ws.waitForMessages(1);
    ws.close();
    const frame = JSON.parse(raw[0]) as any;
    expect(frame.type).toBe("session.created");
    const session = frame.session;
    expect(session).toHaveProperty("audio");
    expect(session).toHaveProperty("type", "conversation");
    expect(session).toHaveProperty("reasoning");
    expect(session.audio).toMatchObject({
      voice: null,
      input_audio_format: null,
      output_audio_format: null,
      input_audio_noise_reduction: null,
      input_audio_transcription: null,
    });
  });

  it("emits conversation.item.added (not .created) and conversation.item.done", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2");
    await ws.waitForMessages(1); // session.created
    ws.send(realtimeItemCreate("hello"));
    await ws.waitForMessages(2); // + conversation.item.added
    ws.send(realtimeResponseCreate());
    const raw = await ws.waitForMessages(11);
    ws.close();
    const types = raw.map((m) => (JSON.parse(m) as any).type);
    expect(types).toContain("conversation.item.added");
    expect(types).not.toContain("conversation.item.created");
    expect(types).toContain("conversation.item.done");
  });

  it("output_item events include phase field", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2");
    await ws.waitForMessages(1); // session.created
    ws.send(realtimeItemCreate("hello"));
    await ws.waitForMessages(2); // + conversation.item.added
    ws.send(realtimeResponseCreate());
    const raw = await ws.waitForMessages(11);
    ws.close();
    const frames = raw.map((m) => JSON.parse(m) as any);
    const outputItemAdded = frames.find((f: any) => f.type === "response.output_item.added");
    expect(outputItemAdded).toBeDefined();
    expect(outputItemAdded.item).toHaveProperty("phase");
    expect(outputItemAdded.item.phase).toBe("final_answer");

    const outputItemDone = frames.find((f: any) => f.type === "response.output_item.done");
    expect(outputItemDone).toBeDefined();
    expect(outputItemDone.item).toHaveProperty("phase");
  });

  it("response.cancel emits response.cancelled", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2");
    await ws.waitForMessages(1); // session.created
    ws.send(JSON.stringify({ type: "response.cancel" }));
    const raw = await ws.waitForMessages(2);
    ws.close();
    const frame = JSON.parse(raw[1]) as any;
    expect(frame.type).toBe("response.cancelled");
  });

  it("content types use GA names (output_text, not text)", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2");
    await ws.waitForMessages(1); // session.created
    ws.send(realtimeItemCreate("hello"));
    await ws.waitForMessages(2); // + conversation.item.added
    ws.send(realtimeResponseCreate());
    const raw = await ws.waitForMessages(11);
    ws.close();
    const frames = raw.map((m) => JSON.parse(m) as any);
    const contentPartAdded = frames.find((f: any) => f.type === "response.content_part.added");
    expect(contentPartAdded).toBeDefined();
    expect(contentPartAdded.part.type).toBe("output_text");

    const contentPartDone = frames.find((f: any) => f.type === "response.content_part.done");
    expect(contentPartDone).toBeDefined();
    expect(contentPartDone.part.type).toBe("output_text");
  });
});

// ---------------------------------------------------------------------------
// 7b. Beta Realtime conformance (OpenAI-Beta: realtime=v1)
// ---------------------------------------------------------------------------

describe("Beta Realtime conformance (OpenAI-Beta: realtime=v1)", () => {
  it("session.created uses flat config (no nested audio, no type, no reasoning)", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2", {
      "OpenAI-Beta": "realtime=v1",
    });
    const raw = await ws.waitForMessages(1);
    ws.close();
    const frame = JSON.parse(raw[0]) as any;
    expect(frame.type).toBe("session.created");
    const session = frame.session;
    // Beta: flat config — voice at top level, no nested audio object
    expect(session).toHaveProperty("voice");
    expect(session).not.toHaveProperty("audio");
    expect(session).not.toHaveProperty("type");
    expect(session).not.toHaveProperty("reasoning");
  });

  it("emits Beta event names (response.text.delta, conversation.item.created)", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2", {
      "OpenAI-Beta": "realtime=v1",
    });
    await ws.waitForMessages(1); // session.created
    ws.send(realtimeItemCreate("hello"));
    await ws.waitForMessages(2); // + conversation.item.created (Beta name)
    ws.send(realtimeResponseCreate());
    // Beta: no conversation.item.done, so fewer events than GA
    const raw = await ws.waitForMessages(10);
    ws.close();
    const types = raw.map((m) => (JSON.parse(m) as any).type);
    expect(types).toContain("conversation.item.created");
    expect(types).not.toContain("conversation.item.added");
    expect(types).toContain("response.text.delta");
    expect(types).not.toContain("response.output_text.delta");
    expect(types).toContain("response.text.done");
    expect(types).not.toContain("response.output_text.done");
  });

  it("does NOT emit conversation.item.done (suppressed in Beta)", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2", {
      "OpenAI-Beta": "realtime=v1",
    });
    await ws.waitForMessages(1); // session.created
    ws.send(realtimeItemCreate("hello"));
    await ws.waitForMessages(2); // + conversation.item.created
    ws.send(realtimeResponseCreate());
    const raw = await ws.waitForMessages(10);
    ws.close();
    const types = raw.map((m) => (JSON.parse(m) as any).type);
    expect(types).not.toContain("conversation.item.done");
  });

  it("uses Beta content type names (text, not output_text)", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime?model=gpt-realtime-2", {
      "OpenAI-Beta": "realtime=v1",
    });
    await ws.waitForMessages(1); // session.created
    ws.send(realtimeItemCreate("hello"));
    await ws.waitForMessages(2); // + conversation.item.created
    ws.send(realtimeResponseCreate());
    const raw = await ws.waitForMessages(10);
    ws.close();
    const frames = raw.map((m) => JSON.parse(m) as any);
    const contentPartAdded = frames.find((f: any) => f.type === "response.content_part.added");
    expect(contentPartAdded).toBeDefined();
    expect(contentPartAdded.part.type).toBe("text");

    const contentPartDone = frames.find((f: any) => f.type === "response.content_part.done");
    expect(contentPartDone).toBeDefined();
    expect(contentPartDone.part.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// 8. WS Gemini Live BidiGenerateContent conformance
// ---------------------------------------------------------------------------

describe("WS Gemini Live BidiGenerateContent conformance", () => {
  describe("setupComplete", () => {
    it("setupComplete is exactly {setupComplete: {}}", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      const raw = await ws.waitForMessages(1);
      ws.close();
      const msg = JSON.parse(raw[0]);
      expect(msg).toEqual({ setupComplete: {} });
    });
  });

  describe("text serverContent", () => {
    it("serverContent has modelTurn with parts array", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send(geminiClientContent("hello"));
      const raw = await ws.waitForMessages(2);
      ws.close();
      const msg = JSON.parse(raw[1]) as any;
      expect(msg.serverContent).toBeDefined();
      expect(msg.serverContent.modelTurn).toBeDefined();
      expect(Array.isArray(msg.serverContent.modelTurn.parts)).toBe(true);
      expect(msg.serverContent.modelTurn.parts.length).toBeGreaterThan(0);
    });

    it("each part has text as string", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send(geminiClientContent("hello"));
      const raw = await ws.waitForMessages(2);
      ws.close();
      const msg = JSON.parse(raw[1]) as any;
      for (const part of msg.serverContent.modelTurn.parts) {
        expect(typeof part.text).toBe("string");
      }
    });

    it("turnComplete is sent as separate message after content (single-chunk)", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send(geminiClientContent("hello"));
      const raw = await ws.waitForMessages(3); // setupComplete + content + turnComplete
      ws.close();
      // Content chunk should NOT have turnComplete
      const contentMsg = JSON.parse(raw[1]) as any;
      expect(contentMsg.serverContent.turnComplete).toBeUndefined();
      // Separate turnComplete message
      const turnCompleteMsg = JSON.parse(raw[2]) as any;
      expect(typeof turnCompleteMsg.serverContent.turnComplete).toBe("boolean");
      expect(turnCompleteMsg.serverContent.turnComplete).toBe(true);
    });

    it("content chunks omit turnComplete; separate turnComplete sent after last chunk", async () => {
      // Use a fixture-level chunkSize override to force multiple chunks
      const longFixture: Fixture = {
        match: { userMessage: "long-conformance" },
        response: { content: "ABCDEFGHIJKLMNOPQRST" },
        chunkSize: 3,
      };
      const smallInstance = await createServer([longFixture], { port: 0 });
      try {
        const ws = await connectWebSocket(smallInstance.url, GEMINI_WS_PATH);
        ws.send(geminiSetup());
        await ws.waitForMessages(1);
        ws.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "long-conformance" }] }],
              turnComplete: true,
            },
          }),
        );
        // 20 chars / 3 = 7 chunks + 1 turnComplete
        const raw = await ws.waitForMessages(9); // 1 setupComplete + 7 chunks + 1 turnComplete
        ws.close();
        const contentChunks = raw.slice(1, 8).map((r) => JSON.parse(r) as any);
        // Content chunks should NOT have turnComplete
        for (const chunk of contentChunks) {
          expect(chunk.serverContent.turnComplete).toBeUndefined();
          expect(chunk.serverContent.modelTurn).toBeDefined();
        }
        // Last message is separate turnComplete
        const turnCompleteMsg = JSON.parse(raw[8]) as any;
        expect(turnCompleteMsg.serverContent.turnComplete).toBe(true);
        expect(turnCompleteMsg.serverContent.modelTurn).toBeUndefined();
      } finally {
        await new Promise<void>((r) => smallInstance.server.close(() => r()));
      }
    });

    it("empty text: content frame + separate turnComplete", async () => {
      const emptyFixture: Fixture = {
        match: { userMessage: "empty-conformance" },
        response: { content: "" },
      };
      const emptyInstance = await createServer([emptyFixture], { port: 0 });
      try {
        const ws = await connectWebSocket(emptyInstance.url, GEMINI_WS_PATH);
        ws.send(geminiSetup());
        await ws.waitForMessages(1);
        ws.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "empty-conformance" }] }],
              turnComplete: true,
            },
          }),
        );
        const raw = await ws.waitForMessages(3); // setupComplete + content + turnComplete
        ws.close();
        const contentMsg = JSON.parse(raw[1]) as any;
        expect(contentMsg.serverContent.modelTurn.parts[0].text).toBe("");
        expect(contentMsg.serverContent.turnComplete).toBeUndefined();
        const turnCompleteMsg = JSON.parse(raw[2]) as any;
        expect(turnCompleteMsg.serverContent.turnComplete).toBe(true);
      } finally {
        await new Promise<void>((r) => emptyInstance.server.close(() => r()));
      }
    });
  });

  describe("toolCall", () => {
    it("toolCall has functionCalls array", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send(geminiClientContent("weather"));
      const raw = await ws.waitForMessages(2);
      ws.close();
      const msg = JSON.parse(raw[1]) as any;
      expect(msg.toolCall).toBeDefined();
      expect(Array.isArray(msg.toolCall.functionCalls)).toBe(true);
      expect(msg.toolCall.functionCalls.length).toBeGreaterThan(0);
    });

    it("each functionCall has name (string), args (object, NOT string), id (string)", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send(geminiClientContent("weather"));
      const raw = await ws.waitForMessages(2);
      ws.close();
      const msg = JSON.parse(raw[1]) as any;
      for (const fc of msg.toolCall.functionCalls) {
        expect(typeof fc.name).toBe("string");
        // args must be an object, not a JSON string
        expect(typeof fc.args).toBe("object");
        expect(fc.args).not.toBeNull();
        expect(typeof fc.args).not.toBe("string");
        expect(typeof fc.id).toBe("string");
        expect(fc.id.length).toBeGreaterThan(0);
      }
    });

    it("functionCall args are parsed from fixture arguments JSON", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send(geminiClientContent("weather"));
      const raw = await ws.waitForMessages(2);
      ws.close();
      const msg = JSON.parse(raw[1]) as any;
      const fc = msg.toolCall.functionCalls[0];
      expect(fc.name).toBe("get_weather");
      expect(fc.args).toEqual({ city: "SF" });
    });
  });

  describe("error responses", () => {
    it("error has code (number), message (string), status (string)", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send(geminiClientContent("no-match-xyz-9999"));
      const raw = await ws.waitForMessages(2);
      ws.close();
      const msg = JSON.parse(raw[1]) as any;
      expect(msg.error).toBeDefined();
      expect(typeof msg.error.code).toBe("number");
      expect(typeof msg.error.message).toBe("string");
      expect(typeof msg.error.status).toBe("string");
    });

    it("error fixture: gRPC code mapped from HTTP status, message matches fixture", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send(geminiClientContent("error-test"));
      const raw = await ws.waitForMessages(2);
      ws.close();
      const msg = JSON.parse(raw[1]) as any;
      expect(msg.error).toBeDefined();
      expect(msg.error.code).toBe(8); // gRPC RESOURCE_EXHAUSTED (mapped from HTTP 429)
      expect(msg.error.message).toBe("Rate limited");
      expect(msg.error.status).toBe("RESOURCE_EXHAUSTED");
    });

    it("no-match error: gRPC code 5 (NOT_FOUND)", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send(geminiClientContent("no-match-xyz-9999"));
      const raw = await ws.waitForMessages(2);
      ws.close();
      const msg = JSON.parse(raw[1]) as any;
      expect(msg.error.code).toBe(5); // gRPC NOT_FOUND
      expect(msg.error.status).toBe("NOT_FOUND");
    });

    it("error before setup: gRPC code 9 (FAILED_PRECONDITION)", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      // Send clientContent without setup first
      ws.send(geminiClientContent("hello"));
      const raw = await ws.waitForMessages(1);
      ws.close();
      const msg = JSON.parse(raw[0]) as any;
      expect(msg.error).toBeDefined();
      expect(msg.error.code).toBe(9); // gRPC FAILED_PRECONDITION
      expect(msg.error.status).toBe("FAILED_PRECONDITION");
    });

    it("malformed JSON: gRPC code 3 (INVALID_ARGUMENT)", async () => {
      const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
      ws.send(geminiSetup());
      await ws.waitForMessages(1);
      ws.send("{not valid json");
      const raw = await ws.waitForMessages(2);
      ws.close();
      const msg = JSON.parse(raw[1]) as any;
      expect(msg.error).toBeDefined();
      expect(msg.error.code).toBe(3); // gRPC INVALID_ARGUMENT
      expect(msg.error.status).toBe("INVALID_ARGUMENT");
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Cross-protocol WS invariants
// ---------------------------------------------------------------------------

describe("Cross-protocol WS invariants", () => {
  it("all 3 WS paths accept WebSocket upgrade (101 Switching Protocols)", async () => {
    const [wsResp, wsRealtime, wsGemini] = await Promise.all([
      connectWebSocket(instance.url, "/v1/responses"),
      connectWebSocket(instance.url, "/v1/realtime"),
      connectWebSocket(instance.url, GEMINI_WS_PATH),
    ]);
    // If connectWebSocket resolves without throwing, the upgrade was accepted (101)
    wsResp.close();
    wsRealtime.close();
    wsGemini.close();
  });

  it("non-WS HTTP path /v1/chat/completions rejects WebSocket upgrade", async () => {
    await expect(connectWebSocket(instance.url, "/v1/chat/completions")).rejects.toThrow(
      "Upgrade failed",
    );
  });

  it("nonexistent path rejects WebSocket upgrade", async () => {
    await expect(connectWebSocket(instance.url, "/nonexistent-path")).rejects.toThrow(
      "Upgrade failed",
    );
  });

  it("WS Responses: returns error for malformed JSON", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/responses");
    ws.send("{bad json");
    const raw = await ws.waitForMessages(1);
    ws.close();
    const frame = JSON.parse(raw[0]) as any;
    expect(frame.type).toBe("error");
  });

  it("WS Realtime: returns error for malformed JSON", async () => {
    const ws = await connectWebSocket(instance.url, "/v1/realtime");
    await ws.waitForMessages(1); // session.created
    ws.send("{bad json");
    const raw = await ws.waitForMessages(2);
    ws.close();
    const frame = JSON.parse(raw[1]) as any;
    expect(frame.type).toBe("error");
  });

  it("WS Gemini Live: returns error for malformed JSON after setup", async () => {
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);
    ws.send(geminiSetup());
    await ws.waitForMessages(1);
    ws.send("{bad json");
    const raw = await ws.waitForMessages(2);
    ws.close();
    const frame = JSON.parse(raw[1]) as any;
    expect(frame.error).toBeDefined();
  });
});
