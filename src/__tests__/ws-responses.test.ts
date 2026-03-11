import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";

// --- WebSocket test client ---

interface WSTestClient {
  send(data: string): void;
  close(): void;
  waitForMessages(count: number, timeoutMs?: number): Promise<string[]>;
  waitForClose(): Promise<void>;
}

function connectWebSocket(url: string, path: string): Promise<WSTestClient> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const socket = net.connect(parseInt(parsed.port), parsed.hostname, () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${parsed.host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`,
      );

      let handshakeDone = false;
      let buffer = Buffer.alloc(0);
      const messages: string[] = [];
      const messageResolvers: Array<() => void> = [];
      const closeResolvers: Array<() => void> = [];

      socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        if (!handshakeDone) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const headerStr = buffer.subarray(0, headerEnd).toString();
          if (!headerStr.includes("101")) {
            reject(new Error(`Upgrade failed: ${headerStr.split("\r\n")[0]}`));
            return;
          }
          handshakeDone = true;
          buffer = buffer.subarray(headerEnd + 4);

          resolve({
            send(data: string) {
              // Send a masked text frame
              const payload = Buffer.from(data, "utf-8");
              const maskKey = randomBytes(4);
              const masked = Buffer.from(payload);
              for (let i = 0; i < masked.length; i++) {
                masked[i] ^= maskKey[i % 4];
              }
              let header: Buffer;
              if (payload.length < 126) {
                header = Buffer.alloc(2);
                header[0] = 0x81; // FIN + TEXT
                header[1] = 0x80 | payload.length;
              } else {
                header = Buffer.alloc(4);
                header[0] = 0x81;
                header[1] = 0x80 | 126;
                header.writeUInt16BE(payload.length, 2);
              }
              socket.write(Buffer.concat([header, maskKey, masked]));
            },
            close() {
              // Send close frame
              const maskKey = randomBytes(4);
              const payload = Buffer.alloc(2);
              payload.writeUInt16BE(1000, 0);
              const masked = Buffer.from(payload);
              for (let i = 0; i < masked.length; i++) {
                masked[i] ^= maskKey[i % 4];
              }
              const header = Buffer.alloc(2);
              header[0] = 0x88; // FIN + CLOSE
              header[1] = 0x82; // MASK + 2 bytes
              socket.write(Buffer.concat([header, maskKey, masked]));
            },
            waitForMessages(count: number, timeoutMs = 5000): Promise<string[]> {
              return new Promise((resolve, reject) => {
                const check = () => {
                  if (messages.length >= count) {
                    resolve(messages.slice(0, count));
                  }
                };
                check();
                messageResolvers.push(check);
                setTimeout(
                  () =>
                    reject(
                      new Error(`Timeout waiting for ${count} messages, got ${messages.length}`),
                    ),
                  timeoutMs,
                );
              });
            },
            waitForClose(): Promise<void> {
              return new Promise((resolve) => {
                if (socket.destroyed) {
                  resolve();
                  return;
                }
                closeResolvers.push(resolve);
              });
            },
          });
        }

        // Parse WebSocket frames from buffer
        while (buffer.length >= 2) {
          const byte0 = buffer[0];
          const byte1 = buffer[1];
          const opcode = byte0 & 0x0f;
          let payloadLength = byte1 & 0x7f;
          let offset = 2;

          if (payloadLength === 126) {
            if (buffer.length < 4) return;
            payloadLength = buffer.readUInt16BE(2);
            offset = 4;
          }

          // Server frames are NOT masked
          if (buffer.length < offset + payloadLength) return;

          const payload = buffer.subarray(offset, offset + payloadLength);
          buffer = buffer.subarray(offset + payloadLength);

          if (opcode === 0x1) {
            // text
            messages.push(payload.toString("utf-8"));
            for (const r of messageResolvers) r();
          } else if (opcode === 0x8) {
            // close
            socket.end();
            for (const r of closeResolvers) r();
          }
        }
      });

      socket.on("close", () => {
        for (const r of closeResolvers) r();
      });

      socket.on("error", reject);
    });
  });
}

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
  },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: { message: "Rate limited", type: "rate_limit_error", code: "rate_limit" },
    status: 429,
  },
};

const allFixtures: Fixture[] = [textFixture, toolFixture, errorFixture];

// --- tests ---

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

function responseCreateMsg(userContent: string, model = "gpt-4"): string {
  return JSON.stringify({
    type: "response.create",
    response: {
      model,
      input: [{ role: "user", content: userContent }],
    },
  });
}

interface WSEvent {
  type: string;
  [key: string]: unknown;
}

function parseEvents(raw: string[]): WSEvent[] {
  return raw.map((m) => JSON.parse(m) as WSEvent);
}

// ─── Integration tests: WebSocket /v1/responses ──────────────────────────────

describe("WebSocket /v1/responses", () => {
  it("streams text response with correct event types", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("hello"));

    // response.created + in_progress + output_item.added + content_part.added
    // + delta(s) + output_text.done + content_part.done + output_item.done + response.completed
    // At minimum 9 events (1 delta for small text with default chunk size)
    const raw = await ws.waitForMessages(9);
    const events = parseEvents(raw);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types[1]).toBe("response.in_progress");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.completed");

    // Verify text deltas reconstruct to "Hi there!"
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    const fullText = deltas.map((d) => d.delta).join("");
    expect(fullText).toBe("Hi there!");

    ws.close();
  });

  it("streams tool call response with correct event types", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("weather"));

    // response.created + in_progress + output_item.added + delta(s)
    // + function_call_arguments.done + output_item.done + response.completed
    // At minimum 7 events
    const raw = await ws.waitForMessages(7);
    const events = parseEvents(raw);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.completed");

    // Verify argument deltas reconstruct to '{"city":"NYC"}'
    const argDeltas = events.filter((e) => e.type === "response.function_call_arguments.delta");
    const fullArgs = argDeltas.map((d) => d.delta).join("");
    expect(fullArgs).toBe('{"city":"NYC"}');

    ws.close();
  });

  it("returns error event when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("unknown-message-that-matches-nothing"));

    const raw = await ws.waitForMessages(1);
    const event = JSON.parse(raw[0]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as { message: string }).message).toBe("No fixture matched");

    ws.close();
  });

  it("returns error event for error fixture", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("fail"));

    const raw = await ws.waitForMessages(1);
    const event = JSON.parse(raw[0]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as { message: string }).message).toBe("Rate limited");

    ws.close();
  });

  it("returns error event for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send("{not valid json");

    const raw = await ws.waitForMessages(1);
    const event = JSON.parse(raw[0]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as { message: string }).message).toBe("Malformed JSON");

    ws.close();
  });

  it("returns error event for wrong message type", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(JSON.stringify({ type: "unknown" }));

    const raw = await ws.waitForMessages(1);
    const event = JSON.parse(raw[0]) as WSEvent;
    expect(event.type).toBe("error");
    expect((event.error as { message: string }).message).toContain(
      'Expected message type "response.create"',
    );

    ws.close();
  });

  it("records journal entries with method WS", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    ws.send(responseCreateMsg("hello"));

    // Wait for all events to be delivered
    await ws.waitForMessages(9);
    // Small pause to ensure the journal write has completed
    await new Promise((r) => setTimeout(r, 50));

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.method).toBe("WS");
    expect(entry!.path).toBe("/v1/responses");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);

    ws.close();
  });

  it("handles multiple requests on same connection", async () => {
    instance = await createServer(allFixtures);
    const ws = await connectWebSocket(instance.url, "/v1/responses");

    // Send first request
    ws.send(responseCreateMsg("hello"));

    // Wait for the full text response sequence (at least 9 events)
    const firstBatch = await ws.waitForMessages(9);
    const firstEvents = parseEvents(firstBatch);
    expect(firstEvents[firstEvents.length - 1].type).toBe("response.completed");

    // Send second request on same connection
    ws.send(responseCreateMsg("weather"));

    // Wait for both batches of events total
    // The first 9 are text response, then 7+ for tool call
    const allRaw = await ws.waitForMessages(9 + 7);
    const secondBatch = allRaw.slice(9);
    const secondEvents = parseEvents(secondBatch);

    const secondTypes = secondEvents.map((e) => e.type);
    expect(secondTypes[0]).toBe("response.created");
    expect(secondTypes).toContain("response.function_call_arguments.delta");
    expect(secondTypes[secondTypes.length - 1]).toBe("response.completed");

    ws.close();
  });

  it("rejects WebSocket upgrade on non-responses path", async () => {
    instance = await createServer(allFixtures);

    await expect(connectWebSocket(instance.url, "/v1/chat/completions")).rejects.toThrow(
      "Upgrade failed",
    );
  });
});
