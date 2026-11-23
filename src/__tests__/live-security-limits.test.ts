import { createServer } from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { computeAcceptKey } from "../ws-framing.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMock } from "../llmock.js";
import type { LiveOptions } from "../live-types.js";
import type { MockServerOptions } from "../types.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";
import { readLiveCase, runLiveScenario } from "./live-test-support.js";

const cleanup: (() => Promise<void>)[] = [];
const marker = "aimock-live-secret-test-7f3d";
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup(options: MockServerOptions = {}, pending = false, seed = false) {
  const mock = new LLMock(options);
  const { transcript } = readLiveCase("client");
  for (const entry of transcript.entries) entry.atMs = 0;
  if (seed) {
    transcript.configuration.instructions = marker;
    transcript.configuration.metadata = { [marker]: marker };
    for (const entry of transcript.entries) {
      const session = entry.event.session;
      if (session && typeof session === "object" && !Array.isArray(session)) {
        session.instructions = marker;
        session.metadata = { [marker]: marker };
      }
    }
  }
  if (pending) mock.on({ endpoint: "openai-live" }, () => new Promise(() => {}));
  else mock.on({ endpoint: "openai-live" }, { live: transcript, liveTiming: "immediate" });
  await mock.start();
  cleanup.push(() => mock.stop());
  return { mock, transcript, start: JSON.stringify(transcript.entries[0].event) };
}
async function connect(mock: LLMock, headers?: Record<string, string>) {
  const ws = await connectWebSocket(mock.url, "/v1/live/sessions", headers);
  cleanup.push(async () => ws.destroy());
  return ws;
}
async function failed(ws: WSTestClient, category: string, code = 1008) {
  expect((await ws.waitForCloseFrame(1500)).code).toBe(code);
  const messages = ws.getMessages();
  expect(JSON.parse(messages.at(-1)!)).toMatchObject({
    type: "aimock.error",
    error: { category },
  });
  expect(JSON.stringify(messages)).not.toContain(marker);
  await delay(20);
  expect(ws.getMessages()).toEqual(messages);
}
async function released(mock: LLMock) {
  await delay(120); // Framing closes allow 100 ms to flush the close frame.
  const next = await connect(mock);
  next.close();
  await next.waitForCloseFrame(1000);
}

describe("Live security and limit boundaries on public sockets", () => {
  it("keeps large replay deadlines pending without overflowing Node timers", async () => {
    const { mock, start } = await setup({
      live: {
        maxDurationMs: Number.MAX_SAFE_INTEGER,
        idleTimeoutMs: Number.MAX_SAFE_INTEGER,
        mismatchTimeoutMs: Number.MAX_SAFE_INTEGER,
      },
    });
    const ws = await connect(mock);
    ws.send(start);
    await ws.waitForMessages(1, 1000);
    await delay(50);
    expect(ws.getMessages().map((s) => JSON.parse(s).type)).toEqual(["session.started"]);
    mock.closeLiveSessions();
    expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
  });
  it.each([
    "maxSessions",
    "maxMessageBytes",
    "maxBufferedBytes",
    "maxWriteBytes",
    "maxDecodedAudioBytes",
    "maxDurationMs",
    "idleTimeoutMs",
    "mismatchTimeoutMs",
  ] as const)("rejects invalid %s overrides before listening", (key) => {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const live: LiveOptions = { [key]: value };
      expect(() => new LLMock({ live })).toThrow("positive safe integer");
    }
  });
  it.each([0, 1])("enforces exact message bytes plus %i", async (extra) => {
    const start = JSON.stringify(readLiveCase("client").transcript.entries[0].event);
    const { mock } = await setup(
      { live: { maxMessageBytes: Buffer.byteLength(start), maxSessions: 1 } },
      true,
    );
    const ws = await connect(mock);
    ws.send(start + " ".repeat(extra));
    if (extra) expect((await ws.waitForCloseFrame(1000)).code).toBe(1009);
    else {
      await delay(30);
      expect(ws.getMessages()).toEqual([]);
      mock.closeLiveSessions();
      expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
    }
    await released(mock);
  });
  it.each([
    '{"type":"session.start","__proto__":{"polluted":true}}',
    JSON.stringify({ type: "session.start", constructor: marker }),
    JSON.stringify({ type: "session.input_audio.append", audio: "AA==" }),
    JSON.stringify({ type: "session.input_audio.append", audio: "AB==" }),
    JSON.stringify({ type: "session.input_audio.append", audio: "@@@@" }),
    '{"type":"session.start","nested":' + "[".repeat(34) + "0" + "]".repeat(34) + "}",
  ])("rejects unsafe JSON/PCM case %# and releases capacity", async (input) => {
    const { mock } = await setup({ live: { maxSessions: 1 } });
    const ws = await connect(mock);
    ws.send(input);
    await failed(ws, "invalid-client");
    await released(mock);
  });
  it.each(["maxDurationMs", "idleTimeoutMs", "mismatchTimeoutMs"] as const)(
    "bounds %s with no late output",
    async (key) => {
      const { mock, start } = await setup({ live: { [key]: 60, maxSessions: 1 } });
      const ws = await connect(mock);
      ws.send(start);
      await failed(ws, key === "mismatchTimeoutMs" ? "fixture-mismatch" : "timeout");
      await released(mock);
    },
  );
  it("does not retain the configured secret from replay headers or startup metadata", async () => {
    const { mock, start } = await setup({ live: { secretValues: [marker] } }, false, true);
    const ws = await connect(mock, { Authorization: `Bearer ${marker}`, "X-Extra": marker });
    ws.send(start);
    await ws.waitForMessages(1, 1000);
    expect(JSON.parse(ws.getMessages()[0]).session.instructions).toBe(marker);
    expect(JSON.stringify(mock.getRequests()).includes(marker)).toBe(false);
    expect(mock.journal.findByFixture(mock.getFixtures()[0])).toHaveLength(1);
    expect((await (await fetch(`${mock.url}/__aimock/journal`)).text()).includes(marker)).toBe(
      false,
    );
  });
});

async function stalledRecording(
  record: Omit<NonNullable<MockServerOptions["record"]>, "providers"> = {},
  live: LiveOptions = {},
) {
  const upstream = await setup({}, true);
  const dir = mkdtempSync(join(tmpdir(), "live-security-"));
  cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
  const mock = new LLMock({
    record: {
      providers: { openai: upstream.mock.url },
      fixturePath: dir,
      upstreamTimeoutMs: 1000,
      ...record,
    },
    live: { maxSessions: 1, ...live },
  });
  await mock.start();
  cleanup.push(() => mock.stop());
  const ws = await connect(mock);
  ws.send(upstream.start);
  return { mock, ws, dir, upstream: upstream.mock };
}
async function noExport(mock: LLMock, dir: string) {
  expect(readdirSync(dir)).toEqual([]);
  expect(mock.getFixtures()).toEqual([]);
  expect(JSON.stringify(mock.getRequests()).includes(marker)).toBe(false);
  await released(mock);
}
describe("failed Live captures never become fixtures", () => {
  it.each([0, 1])("bounds pending capture frames at exact plus %i", async (extra) => {
    const { mock, ws, dir } = await stalledRecording({ maxProxyBufferFrames: 2 });
    // Startup is already captured; the two queued frames have their own queue cap.
    for (let i = 0; i < 2 + extra; i++)
      ws.send(JSON.stringify({ type: "session.input_audio.append", audio: "AAA=" }));
    if (extra) await failed(ws, "resource-limit", 1009);
    else {
      await delay(40);
      expect(ws.getMessages()).toEqual([]);
      mock.closeLiveSessions();
      expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
    }
    await noExport(mock, dir);
  });
  it("does not export an upstream that closes without a terminal event", async () => {
    const { mock, ws, dir, upstream } = await stalledRecording();
    await delay(30);
    upstream.closeLiveSessions();
    await failed(ws, "incomplete-capture");
    await noExport(mock, dir);
  });
});

describe("Live parser and capture budgets", () => {
  it.each([0, 1])("bounds the parser buffer at exact plus %i", async (extra) => {
    const { mock } = await setup(
      { live: { maxBufferedBytes: 256, maxMessageBytes: 4096, maxSessions: 1 } },
      true,
    );
    const ws = await connect(mock);
    // Declared masked frame size is checked before its body is allocated.
    const frame = Buffer.alloc(8);
    frame[0] = 0x81;
    frame[1] = 0xfe;
    frame.writeUInt16BE(248 + extra, 2);
    ws.sendRawFrame(frame);
    if (extra) expect((await ws.waitForCloseFrame(1000)).code).toBe(1009);
    else {
      await delay(30);
      expect(ws.getMessages()).toEqual([]);
      mock.closeLiveSessions();
      expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
    }
    await released(mock);
  });
  it("rejects an unmasked frame and releases the sole session", async () => {
    const { mock } = await setup({ live: { maxSessions: 1 } });
    const ws = await connect(mock);
    ws.sendRawFrame(Buffer.from([0x81, 2, 123, 125]));
    expect((await ws.waitForCloseFrame(1000)).code).toBe(1002);
    await released(mock);
  });
  it.each([0, 1])("bounds startup capture bytes at exact plus %i", async (extra) => {
    const size = Buffer.byteLength(
      JSON.stringify(readLiveCase("client").transcript.entries[0].event),
    );
    const { mock, ws, dir } = await stalledRecording({ maxProxyBufferBytes: size - extra });
    if (extra) await failed(ws, "resource-limit", 1009);
    else {
      await delay(30);
      expect(ws.getMessages()).toEqual([]);
      mock.closeLiveSessions();
      expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
    }
    await noExport(mock, dir);
  });
  it.each([0, 2])("bounds cumulative recorded PCM at exact plus %i", async (extra) => {
    const upstream = await setup();
    const dir = mkdtempSync(join(tmpdir(), "live-audio-bound-"));
    cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
    const mock = new LLMock({
      record: { providers: { openai: upstream.mock.url }, fixturePath: dir },
      live: { maxDecodedAudioBytes: 16, maxSessions: 1 },
    });
    await mock.start();
    cleanup.push(() => mock.stop());
    const ws = await connect(mock);
    ws.send(upstream.start);
    await ws.waitForMessages(1, 1000);
    const audio = upstream.transcript.entries.find(
      (entry) => entry.event.type === "session.input_audio.append",
    )?.event.audio;
    if (typeof audio !== "string") throw new Error("Missing observed PCM");
    const bytes = Buffer.from(audio, "base64");
    ws.send(
      JSON.stringify({
        type: "session.input_audio.append",
        audio: bytes.subarray(0, 16).toString("base64"),
      }),
    );
    if (extra) {
      ws.send(
        JSON.stringify({
          type: "session.input_audio.append",
          audio: bytes.subarray(16, 18).toString("base64"),
        }),
      );
      await failed(ws, "resource-limit", 1009);
    } else {
      await delay(30);
      expect(ws.getMessages()).toHaveLength(1);
      mock.closeLiveSessions();
      expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
    }
    await noExport(mock, dir);
  });
});

describe("Live export and transport protection", () => {
  it.each([0, 1])("bounds upstream startup write bytes at exact plus %i", async (extra) => {
    const size = Buffer.byteLength(
      JSON.stringify(readLiveCase("client").transcript.entries[0].event),
    );
    const { mock, ws, dir } = await stalledRecording({}, { maxWriteBytes: size + 8 - extra });
    if (extra) await failed(ws, "resource-limit", 1009);
    else {
      await delay(30);
      expect(ws.getMessages()).toEqual([]);
      mock.closeLiveSessions();
      expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
    }
    await noExport(mock, dir);
  });
  it("rejects a semantic configured secret at export without mutating replay", async () => {
    const { transcript } = readLiveCase("client");
    transcript.configuration.instructions = marker;
    for (const entry of transcript.entries) {
      entry.atMs = 0;
      const session = entry.event.session;
      if (session && typeof session === "object" && !Array.isArray(session))
        session.instructions = marker;
    }
    const upstream = new LLMock();
    upstream.on({ endpoint: "openai-live" }, { live: transcript, liveTiming: "immediate" });
    await upstream.start();
    cleanup.push(() => upstream.stop());
    const dir = mkdtempSync(join(tmpdir(), "live-secret-export-"));
    cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
    const mock = new LLMock({
      record: { providers: { openai: upstream.url }, fixturePath: dir },
      live: { secretValues: [marker] },
    });
    await mock.start();
    cleanup.push(() => mock.stop());
    const ws = await connect(mock);
    // The independent oracle may reject the additional safe aimock.error after session.closed.
    await runLiveScenario(ws, transcript, { clientIdPrefix: "security", timeoutMs: 10000 }).catch(
      (error: unknown) => {
        if (!(error instanceof Error) || error.message !== "unexpected server events") throw error;
      },
    );
    expect((await ws.waitForCloseFrame(1500)).code).toBe(1008);
    expect(JSON.parse(ws.getMessages().at(-1)!)).toMatchObject({
      error: { category: "unsafe-export" },
    });
    await noExport(mock, dir);
  }, 15000);
});

describe("Live fault peers contain diagnostics and release sockets", () => {
  it.each([
    { fault: "auth", category: "upstream-auth" },
    { fault: "access", category: "upstream-access" },
    { fault: "abrupt", category: "upstream-connect" },
    { fault: "silent", category: "timeout" },
    { fault: "malformed", category: "protocol-divergence" },
  ])(
    "handles $fault without caching, exporting, or leaking a marker",
    async ({ fault, category }) => {
      const sockets = new Set<Duplex>();
      const peer = createServer();
      peer.on("upgrade", (request, socket) => {
        sockets.add(socket);
        socket.resume();
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        socket.on("end", () => socket.destroy());
        if (fault === "auth" || fault === "access") {
          socket.end(
            `HTTP/1.1 ${fault === "auth" ? 401 : 403} ${marker}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
          );
        } else if (fault === "abrupt") socket.destroy();
        else if (fault === "malformed") {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${computeAcceptKey(String(request.headers["sec-websocket-key"]))}\r\n\r\n`,
          );
          socket.write(Buffer.from([0x81, 1, 123])); // Invalid JSON, no fabricated LLM success.
        }
      });
      peer.listen(0, "127.0.0.1");
      await once(peer, "listening");
      cleanup.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          peer.close((error) => (error ? reject(error) : resolve())),
        );
      });
      const address = peer.address();
      if (!address || typeof address === "string") throw new Error("Missing fault peer port");
      const dir = mkdtempSync(join(tmpdir(), "live-fault-"));
      cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
      const mock = new LLMock({
        record: {
          providers: { openai: `http://127.0.0.1:${address.port}` },
          fixturePath: dir,
          providerKeys: { openai: marker },
          upstreamTimeoutMs: 100,
          bodyTimeoutMs: 100,
        },
        live: { maxSessions: 1, secretValues: [marker] },
      });
      await mock.start();
      cleanup.push(() => mock.stop());
      const ws = await connect(mock, { "Sec-WebSocket-Protocol": marker });
      ws.send(JSON.stringify(readLiveCase("client").transcript.entries[0].event));
      await failed(ws, category);
      await noExport(mock, dir);
      expect(sockets.size).toBe(0);
    },
  );
  it("accepts one session, rejects the next, and reuses the released reservation", async () => {
    const { mock } = await setup({ live: { maxSessions: 1 } });
    const ws = await connect(mock);
    await expect(connect(mock)).rejects.toThrow("429");
    mock.closeLiveSessions();
    expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
    await released(mock);
  });
});

describe("complete Live capture secret boundary", () => {
  it.each([false, true])(
    "keeps auth markers out of complete artifacts with proxyOnly=%s",
    async (proxyOnly) => {
      const logs: unknown[][] = [];
      for (const method of ["log", "warn", "error"] as const)
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logs.push(args);
        });
      const upstream = await setup();
      const dir = mkdtempSync(join(tmpdir(), "live-safe-capture-"));
      cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
      const mock = new LLMock({
        logLevel: "debug",
        record: {
          providers: { openai: upstream.mock.url },
          providerKeys: { openai: marker },
          fixturePath: dir,
          proxyOnly,
        },
        live: { secretValues: [marker] },
      });
      await mock.start();
      cleanup.push(() => mock.stop());
      const ws = await connect(mock, {
        Authorization: `Bearer ${marker}`,
        "X-Extra": marker,
        "Sec-WebSocket-Protocol": marker,
      });
      await runLiveScenario(ws, upstream.transcript, {
        clientIdPrefix: "safe-capture",
        timeoutMs: 10000,
      });
      expect((await ws.waitForCloseFrame(1500)).code).toBe(1000);
      const files = readdirSync(dir);
      expect(files).toHaveLength(proxyOnly ? 0 : 1);
      expect(mock.getFixtures()).toHaveLength(proxyOnly ? 0 : 1);
      const artifacts = {
        files: files.map((file) => readFileSync(join(dir, file), "utf8")),
        journal: mock.getRequests(),
        logs,
      };
      expect(JSON.stringify(artifacts).includes(marker)).toBe(false);
    },
    15000,
  );
});

describe("Live downstream pressure", () => {
  it("closes oversized output while reads are paused and releases the session", async () => {
    const { mock, start } = await setup({ live: { maxWriteBytes: 256, maxSessions: 1 } });
    const ws = await connect(mock);
    ws.pauseReads();
    ws.send(start);
    await delay(50);
    ws.resumeReads();
    await failed(ws, "resource-limit", 1009);
    await released(mock);
  });
});
