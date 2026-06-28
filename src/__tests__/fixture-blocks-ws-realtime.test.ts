import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

// --- helpers (mirror ws-realtime.test.ts harness) ---

interface WSEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

function parseEvents(raw: string[]): WSEvent[] {
  return raw.map((m) => JSON.parse(m) as WSEvent);
}

function conversationItemCreate(role: string, text: string): string {
  return JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role,
      content: [{ type: "input_text", text }],
    },
  });
}

function responseCreate(): string {
  return JSON.stringify({ type: "response.create" });
}

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

// ─── #274: blocks honored on the Realtime WS surface ────────────────────────

describe("WebSocket /v1/realtime — fixture blocks", () => {
  it("blocks-only fixture streams a NON-empty payload (tool-first order)", async () => {
    // A blocks-only fixture (no `content`, no `toolCalls`) — post-F0 this matches
    // isContentWithToolCallsResponse. BEFORE the fix, the WS content+toolCalls
    // branch reads only `response.content ?? ""` / `response.toolCalls ?? []`,
    // so it streams an empty text message and DROPS every block: a silent empty
    // payload. AFTER the fix, the branch iterates `blocks` in array order.
    const blocksOnlyFixture: Fixture = {
      match: { userMessage: "blocks-only-rt" },
      // Large chunkSize => each text/args body is a single delta, making the
      // event count deterministic regardless of the default chunk size.
      chunkSize: 100,
      response: {
        blocks: [
          { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}', id: "call_1" },
          { type: "text", text: "Here is the weather." },
        ],
      },
    };
    instance = await createServer([blocksOnlyFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1); // session.created

    ws.send(conversationItemCreate("user", "blocks-only-rt"));
    await ws.waitForMessages(2); // + conversation.item.added

    ws.send(responseCreate());

    // With chunkSize 100 (single-chunk bodies):
    //  tool block: added + arg.delta + arg.done + item.done + conv.done = 5
    //  text block: added + content_part.added + text.delta + text.done
    //              + content_part.done + item.done + conv.done = 7
    //  + response.created (first) + response.done (last) = 14 response events.
    // Total: 2 (session.created + conversation.item.added) + 14 = 16.
    const allRaw = await ws.waitForMessages(16);
    const responseEvents = parseEvents(allRaw.slice(2));
    const types = responseEvents.map((e) => e.type);

    // Payload is NON-empty: both a tool call and text were emitted.
    expect(types[0]).toBe("response.created");
    expect(types[types.length - 1]).toBe("response.done");
    expect(types).toContain("response.function_call_arguments.done");
    expect(types).toContain("response.output_text.done");

    // The dropped-payload bug: tool-call arguments must survive.
    const argDone = responseEvents.find((e) => e.type === "response.function_call_arguments.done");
    expect(argDone).toBeDefined();
    expect(argDone!.arguments).toBe('{"city":"NYC"}');

    // The dropped-payload bug: text must survive.
    const textDone = responseEvents.find((e) => e.type === "response.output_text.done");
    expect(textDone).toBeDefined();
    expect(textDone!.text).toBe("Here is the weather.");

    // Order IS wire-expressible on Realtime (output items are sequenced on the
    // wire with explicit output_index). tool-first means the function_call item
    // is added before the text message item.
    const added = responseEvents.filter((e) => e.type === "response.output_item.added");
    expect(added.length).toBe(2);
    expect((added[0].item as Record<string, unknown>).type).toBe("function_call");
    expect((added[0].item as Record<string, unknown>).name).toBe("get_weather");
    expect((added[1].item as Record<string, unknown>).type).toBe("message");
    expect(added[0].output_index).toBe(0);
    expect(added[1].output_index).toBe(1);

    // response.done carries both output items.
    const doneResp = responseEvents[responseEvents.length - 1].response as Record<string, unknown>;
    expect((doneResp.output as unknown[]).length).toBe(2);

    ws.close();
  });

  it("combined {content,toolCalls,blocks} honors block ordering (text-first)", async () => {
    const combinedFixture: Fixture = {
      match: { userMessage: "combined-blocks-rt" },
      chunkSize: 100,
      response: {
        content: "Checking now.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        blocks: [
          { type: "text", text: "Checking now." },
          { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}', id: "call_a" },
        ],
      },
    };
    instance = await createServer([combinedFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1);
    ws.send(conversationItemCreate("user", "combined-blocks-rt"));
    await ws.waitForMessages(2);
    ws.send(responseCreate());

    // text block (7) + tool block (5) + created + done = 14; +2 prefix = 16.
    const allRaw = await ws.waitForMessages(16);
    const responseEvents = parseEvents(allRaw.slice(2));

    const added = responseEvents.filter((e) => e.type === "response.output_item.added");
    expect(added.length).toBe(2);
    // blocks array order: text first, then tool.
    expect((added[0].item as Record<string, unknown>).type).toBe("message");
    expect((added[1].item as Record<string, unknown>).type).toBe("function_call");

    const textDone = responseEvents.find((e) => e.type === "response.output_text.done");
    expect(textDone!.text).toBe("Checking now.");
    const argDone = responseEvents.find((e) => e.type === "response.function_call_arguments.done");
    expect(argDone!.arguments).toBe('{"city":"NYC"}');

    ws.close();
  });

  it("back-compat: a no-blocks {content,toolCalls} fixture is unchanged (text-first)", async () => {
    const legacyFixture: Fixture = {
      match: { userMessage: "legacy-ctc-rt" },
      chunkSize: 100,
      response: {
        content: "Let me check the weather for you.",
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      },
    };
    instance = await createServer([legacyFixture]);
    const ws = await connectWebSocket(instance.url, "/v1/realtime");

    await ws.waitForMessages(1);
    ws.send(conversationItemCreate("user", "legacy-ctc-rt"));
    await ws.waitForMessages(2);
    ws.send(responseCreate());

    // Legacy text item (7) + tool item (5) + created + done = 14; +2 prefix = 16.
    const allRaw = await ws.waitForMessages(16);
    const responseEvents = parseEvents(allRaw.slice(2));
    const types = responseEvents.map((e) => e.type);

    // Legacy: text item at index 0 (phase "commentary"), tool item at index 1.
    const added = responseEvents.filter((e) => e.type === "response.output_item.added");
    expect(added.length).toBe(2);
    expect((added[0].item as Record<string, unknown>).type).toBe("message");
    expect((added[0].item as Record<string, unknown>).phase).toBe("commentary");
    expect((added[1].item as Record<string, unknown>).type).toBe("function_call");

    const textDone = responseEvents.find((e) => e.type === "response.output_text.done");
    expect(textDone!.text).toBe("Let me check the weather for you.");
    const argDone = responseEvents.find((e) => e.type === "response.function_call_arguments.done");
    expect(argDone!.arguments).toBe('{"city":"NYC"}');

    expect(types[0]).toBe("response.created");
    expect(types[types.length - 1]).toBe("response.done");

    ws.close();
  });
});
