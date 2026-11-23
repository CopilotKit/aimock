import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { LiveMode, LiveObject, LiveTranscript } from "../live-types.js";
import type { MockServerOptions } from "../types.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";
import {
  readLiveCase,
  runLiveScenario,
  normalizeCapturedScenario,
  identifier,
  replaceIdentifier,
} from "./live-test-support.js";

const mocks: LLMock[] = [];
const clients: WSTestClient[] = [];
const recordingDirs: string[] = [];
afterEach(async () => {
  for (const ws of clients.splice(0)) ws.destroy();
  for (const mock of mocks.splice(0)) await mock.stop();
  for (const dir of recordingDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup(options: MockServerOptions = {}) {
  const mock = new LLMock(options);
  const { transcript } = readLiveCase("client");
  mock.on(
    { endpoint: "openai-live", model: transcript.model },
    { live: transcript, liveTiming: "immediate" },
  );
  await mock.start();
  mocks.push(mock);
  return { mock, transcript };
}
async function connect(mock: LLMock, path = "/v1/live/sessions", headers?: Record<string, string>) {
  const ws = await connectWebSocket(mock.url, path, headers);
  clients.push(ws);
  return ws;
}
async function errorCategory(ws: WSTestClient) {
  const messages = await ws.waitForMessages(1, 1000);
  const error: unknown = JSON.parse(messages.at(-1)!);
  expect(error).toMatchObject({ type: "aimock.error" });
  expect((await ws.waitForCloseFrame(1000)).code).toBe(1008);
  return error;
}

describe("public Live sessions", () => {
  it.each([1500.5, NaN, -1])(
    "records and restarts with HTTP-compatible timeout configuration %s",
    async (timeoutMs) => {
      const { transcript } = readLiveCase("client");
      for (const entry of transcript.entries) entry.atMs = Math.floor(entry.atMs / 100);
      const upstream = new LLMock();
      upstream.onLive({}, transcript);
      await upstream.start();
      mocks.push(upstream);
      const dir = mkdtempSync(join(tmpdir(), "live-timeout-record-"));
      recordingDirs.push(dir);
      const recorder = new LLMock({
        record: {
          providers: { openai: upstream.url },
          fixturePath: dir,
          upstreamTimeoutMs: timeoutMs,
          bodyTimeoutMs: timeoutMs,
        },
      });
      await recorder.start();
      mocks.push(recorder);
      const expected = normalizeCapturedScenario(transcript);
      const recorded = await runLiveScenario(await connect(recorder), transcript, {
        clientIdPrefix: "fractional-record",
        timeoutMs: 5000,
      });
      expect(recorded.normalized).toEqual(expected);
      expect(upstream.getRequests()).toHaveLength(1);
      expect(recorder.getRequests()[0].response.status).toBe(200);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      await recorder.stop();
      mocks.splice(mocks.indexOf(recorder), 1);
      await upstream.stop();
      mocks.splice(mocks.indexOf(upstream), 1);
      const replay = new LLMock();
      replay.loadFixtureFile(join(dir, files[0]));
      await replay.start();
      mocks.push(replay);
      const restarted = await runLiveScenario(await connect(replay), transcript, {
        clientIdPrefix: "fractional-restart",
        timeoutMs: 5000,
      });
      expect(restarted.normalized).toEqual(expected);
    },
    10000,
  );
  it.each(["client", "managed"] as const)(
    "replays %s on two independent real sockets",
    async (mode) => {
      const mock = new LLMock();
      const { transcript } = readLiveCase(mode);
      mock.on({ endpoint: "openai-live" }, { live: transcript, liveTiming: "immediate" });
      await mock.start();
      mocks.push(mock);
      const sockets = await Promise.all([connect(mock), connect(mock)]);
      const results = await Promise.all(
        sockets.map((ws, i) => runLiveScenario(ws, transcript, { clientIdPrefix: `socket-${i}` })),
      );
      expect(results[0].normalized).toEqual(normalizeCapturedScenario(transcript));
      expect(results[1].normalized).toEqual(results[0].normalized);
      for (const binding of transcript.bindings.filter(
        (b) => b.owner === "server" && b.action === "define",
      ))
        expect(results[0].bindings.get(binding.name)).not.toBe(
          results[1].bindings.get(binding.name),
        );
    },
    60000,
  );
  it.each([
    "{",
    JSON.stringify({ type: "constructor" }),
    JSON.stringify({ type: "invented" }),
    JSON.stringify({ type: "session.close" }),
    JSON.stringify({ type: "session.start", session: { model: "gpt-realtime" } }),
  ])("rejects invalid startup %s", async (message) => {
    const { mock } = await setup();
    const ws = await connect(mock);
    ws.send(message);
    expect(await errorCategory(ws)).toMatchObject({ error: { category: "invalid-client" } });
  });
  it.each(["audio", "delegation", "codec"])(
    "requires explicit supported startup %s",
    async (field) => {
      const { mock, transcript } = await setup();
      const ws = await connect(mock);
      const event = structuredClone(transcript.entries[0].event);
      const session = event.session;
      if (!session || typeof session !== "object" || Array.isArray(session))
        throw new Error("missing session");
      if (field === "codec") session.audio = { format: { type: "audio/opus", rate: 48000 } };
      else delete session[field];
      ws.send(JSON.stringify(event));
      expect(await errorCategory(ws)).toMatchObject({ error: { category: "invalid-client" } });
    },
  );
  it("expires a socket that never starts", async () => {
    const { mock } = await setup({ live: { idleTimeoutMs: 30 } });
    expect(await errorCategory(await connect(mock))).toMatchObject({
      error: { category: "timeout" },
    });
  });
  it("reserves slots until close and releases them", async () => {
    const { mock } = await setup({ live: { maxSessions: 1 } });
    const ws = await connect(mock);
    await expect(connect(mock)).rejects.toThrow("429");
    ws.close();
    await ws.waitForClose();
    await connect(mock);
  });
  it("closes only explicit test ownership and leaves match-count reset inert", async () => {
    const { mock } = await setup();
    const a = await connect(mock, undefined, { "X-Test-Id": "a" });
    const b = await connect(mock, undefined, { "X-Test-Id": "b" });
    mock.resetMatchCounts("a");
    mock.closeLiveSessions("a");
    expect((await a.waitForCloseFrame(1000)).code).toBe(1001);
    b.send("{}");
    expect(await errorCategory(b)).toMatchObject({ error: { category: "invalid-client" } });
  });
  it.each(["api", "control"])("full %s reset closes pending sessions", async (how) => {
    const { mock } = await setup();
    const ws = await connect(mock);
    if (how === "api") mock.reset();
    else await fetch(`${mock.url}/__aimock/reset`, { method: "POST" });
    expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
  });
  it("accepts the OpenAI compatibility prefix", async () => {
    const { mock } = await setup();
    await connect(mock, "/openai/v1/live/sessions");
  });
  it("excludes HTTP POST, precreate paths and model-query startup", async () => {
    const { mock } = await setup();
    expect((await fetch(`${mock.url}/v1/live/sessions`, { method: "POST" })).status).toBe(404);
    await expect(connect(mock, "/v1/live/sessions/new")).rejects.toThrow("404");
    await expect(connect(mock, "/v1/live/sessions?model=gpt-live-1")).rejects.toThrow("400");
  });
});

describe("Live isolation and failures", () => {
  it("authenticates before route lookup and permits configured credentials", async () => {
    const { mock } = await setup({ auth: { apiKeys: ["local-test-key"] } });
    await expect(connect(mock)).rejects.toThrow("401");
    await expect(connect(mock, "/missing-live-route")).rejects.toThrow("401");
    await connect(mock, undefined, { Authorization: "Bearer local-test-key" });
  });
  it.each(["repeat", "unknown", "immutable", "wrong-audio", "wrong-command"])(
    "rejects active %s",
    async (fault) => {
      const { mock, transcript } = await setup();
      const ws = await connect(mock);
      ws.send(JSON.stringify(transcript.entries[0].event));
      await ws.waitForMessages(1, 1000);
      const command =
        fault === "repeat"
          ? transcript.entries[0].event
          : fault === "unknown"
            ? { type: "constructor" }
            : fault === "immutable"
              ? { type: "session.update", session: { model: "gpt-live-1" } }
              : fault === "wrong-audio"
                ? { type: "session.input_audio.append", audio: "////" }
                : { type: "response.create" };
      ws.send(JSON.stringify(command));
      await ws.waitForCloseFrame(1000);
      expect(
        ws
          .getMessages()
          .map((text) => JSON.parse(text))
          .at(-1),
      ).toMatchObject({
        type: "aimock.error",
        error: {
          category:
            fault === "wrong-audio"
              ? "invalid-client"
              : fault === "wrong-command"
                ? "fixture-mismatch"
                : "invalid-client",
        },
      });
    },
  );
  it("rejects different PCM samples at the actual audio cursor", async () => {
    const { mock, transcript } = await setup();
    const ws = await connect(mock);
    ws.send(JSON.stringify(transcript.entries[0].event));
    await ws.waitForMessages(1, 1000);
    const audio = structuredClone(
      transcript.entries.find(
        (entry) =>
          entry.direction === "client" && entry.event.type === "session.input_audio.append",
      )!.event,
    );
    if (typeof audio.audio !== "string") throw new Error("missing audio");
    const bytes = Buffer.from(audio.audio, "base64");
    bytes[0] ^= 1;
    audio.audio = bytes.toString("base64");
    ws.send(JSON.stringify(audio));
    await ws.waitForCloseFrame(1000);
    expect(JSON.parse(ws.getMessages().at(-1)!)).toMatchObject({
      type: "aimock.error",
      error: { category: "fixture-mismatch" },
    });
  });
  it("times out missing input without acknowledging audio or synthesizing closure", async () => {
    const { mock, transcript } = await setup({ live: { mismatchTimeoutMs: 50 } });
    const ws = await connect(mock);
    ws.send(JSON.stringify(transcript.entries[0].event));
    await ws.waitForMessages(1, 1000);
    const next = transcript.entries.find(
      (entry) => entry.direction === "client" && entry.event.type === "session.input_audio.append",
    )!;
    ws.send(JSON.stringify(next.event));
    await ws.waitForCloseFrame(1000);
    const output = ws.getMessages().map((text) => JSON.parse(text));
    expect(output.map((event) => event.type)).toEqual(["session.started", "aimock.error"]);
    expect(output.at(-1)).toMatchObject({ error: { category: "fixture-mismatch" } });
  });
  it("cancels recorded pending output on reset", async () => {
    const mock = new LLMock();
    const { transcript } = readLiveCase("client");
    mock.onLive({}, transcript);
    await mock.start();
    mocks.push(mock);
    const ws = await connect(mock);
    ws.send(JSON.stringify(transcript.entries[0].event));
    mock.reset();
    await ws.waitForCloseFrame(1000);
    await delay(150);
    expect(ws.getMessages()).toEqual([]);
  });
  it("stops an instance with an open client and does not affect another server", async () => {
    const { mock: a } = await setup();
    const { mock: b, transcript } = await setup();
    await connect(a);
    const survivor = await connect(b);
    await a.stop();
    mocks.splice(mocks.indexOf(a), 1);
    survivor.send(JSON.stringify(transcript.entries[0].event));
    expect(JSON.parse((await survivor.waitForMessages(1, 1000))[0])).toMatchObject({
      type: "session.started",
    });
  });
  it("enforces framing byte bounds before startup", async () => {
    const mock = new LLMock({ live: { maxMessageBytes: 64, maxBufferedBytes: 128 } });
    await mock.start();
    mocks.push(mock);
    const ws = await connect(mock);
    ws.send("x".repeat(65));
    expect((await ws.waitForCloseFrame(1000)).code).toBe(1009);
  });
  it("retains a single released slot after protocol rejection", async () => {
    const { mock } = await setup({ live: { maxSessions: 1 } });
    const ws = await connect(mock);
    ws.send("{}");
    await errorCategory(ws);
    await connect(mock);
  });
});

describe("Live response factories", () => {
  it("replays a public asynchronous factory with pipelined startup/audio", async () => {
    const mock = new LLMock();
    const { transcript } = readLiveCase("client");
    mock.on({ endpoint: "openai-live" }, async () => {
      await delay(10);
      return { live: transcript, liveTiming: "immediate" };
    });
    await mock.start();
    mocks.push(mock);
    const ws = await connect(mock);
    ws.send(JSON.stringify(transcript.entries[0].event));
    ws.send(
      JSON.stringify(
        transcript.entries.find(
          (entry) =>
            entry.direction === "client" && entry.event.type === "session.input_audio.append",
        )!.event,
      ),
    );
    expect(JSON.parse((await ws.waitForMessages(1, 1000))[0])).toMatchObject({
      type: "session.started",
    });
  });
  it("rejects repeated startup even while its factory is pending", async () => {
    const mock = new LLMock();
    const { transcript } = readLiveCase("client");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.on({ endpoint: "openai-live" }, async () => {
      await pending;
      return { live: transcript };
    });
    await mock.start();
    mocks.push(mock);
    const ws = await connect(mock);
    try {
      ws.send(JSON.stringify(transcript.entries[0].event));
      ws.send(JSON.stringify(transcript.entries[0].event));
      expect(await errorCategory(ws)).toMatchObject({ error: { category: "invalid-client" } });
    } finally {
      release();
    }
  });
  it("bounds queued input while a response factory is pending", async () => {
    const mock = new LLMock({ live: { maxBufferedBytes: 4096 } });
    const { transcript } = readLiveCase("client");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.on({ endpoint: "openai-live" }, async () => {
      await pending;
      return { live: transcript };
    });
    await mock.start();
    mocks.push(mock);
    const ws = await connect(mock);
    try {
      ws.send(JSON.stringify(transcript.entries[0].event));
      for (let i = 0; i < 200; i++) ws.send(JSON.stringify({ type: "response.create" }));
      expect((await ws.waitForCloseFrame(1000)).code).toBe(1009);
      expect(JSON.parse(ws.getMessages().at(-1)!)).toMatchObject({
        type: "aimock.error",
        error: { category: "resource-limit" },
      });
    } finally {
      release();
    }
  });
  it("rejects a non-Live factory result", async () => {
    const mock = new LLMock();
    const { transcript } = readLiveCase("client");
    mock.on({ endpoint: "openai-live" }, async () => ({ content: "not a Live transcript" }));
    await mock.start();
    mocks.push(mock);
    const ws = await connect(mock);
    ws.send(JSON.stringify(transcript.entries[0].event));
    expect(await errorCategory(ws)).toMatchObject({ error: { category: "protocol-divergence" } });
  });
  it("contains factory rejection without exposing its error payload", async () => {
    const mock = new LLMock();
    const { transcript } = readLiveCase("client");
    mock.on({ endpoint: "openai-live" }, async () => {
      throw new Error("private-factory-secret");
    });
    await mock.start();
    mocks.push(mock);
    const ws = await connect(mock);
    ws.send(JSON.stringify(transcript.entries[0].event));
    expect(await errorCategory(ws)).toMatchObject({ error: { category: "protocol-divergence" } });
    expect(ws.getMessages().join()).not.toContain("private-factory-secret");
  });
  it("stops without awaiting a pending factory and ignores its late settlement", async () => {
    const mock = new LLMock();
    const { transcript } = readLiveCase("client");
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mock.on({ endpoint: "openai-live" }, async () => {
      entered();
      await waiting;
      return { live: transcript };
    });
    await mock.start();
    mocks.push(mock);
    const ws = await connect(mock);
    try {
      ws.send(JSON.stringify(transcript.entries[0].event));
      await Promise.race([
        started,
        delay(1000).then(() => {
          throw new Error("factory was not called");
        }),
      ]);
      await mock.stop();
      mocks.splice(mocks.indexOf(mock), 1);
      release();
      await delay(20);
      expect(ws.getMessages()).toEqual([]);
    } finally {
      release();
    }
  });
});

// Drive the reviewed tape one causal step at a time, independently of recorded
// wall time. A paused client lets tests inspect what the real socket withholds.
async function delegationSocket(mode: LiveMode, authored?: LiveTranscript) {
  const transcript = authored ?? readLiveCase(mode).transcript;
  const mock = new LLMock();
  mock.on({ endpoint: "openai-live" }, { live: transcript, liveTiming: "immediate" });
  await mock.start();
  mocks.push(mock);
  const ws = await connect(mock);
  const bindings = new Map<string, string>();
  const output: LiveObject[] = [];
  let cursor = 0;
  function command(index: number) {
    const event = structuredClone(transcript.entries[index].event);
    for (const b of transcript.bindings.filter((b) => b.entry === index)) {
      if (b.action === "define") bindings.set(b.name, `delegation-test-${index}`);
      const value = bindings.get(b.name);
      if (value === undefined) throw new Error(`missing binding ${b.name}`);
      replaceIdentifier(event, b.pointer, value);
    }
    return event;
  }
  async function through(end: number) {
    while (cursor <= end) {
      const entry = transcript.entries[cursor];
      if (entry.direction === "client") ws.send(JSON.stringify(command(cursor)));
      else {
        const messages = await ws.waitForMessages(output.length + 1, 1000);
        const event: LiveObject = JSON.parse(messages[output.length]);
        expect(event.type).toBe(entry.event.type);
        for (const b of transcript.bindings.filter((b) => b.entry === cursor)) {
          const value = identifier(event, b.pointer);
          if (b.action === "define") bindings.set(b.name, value);
          else expect(value).toBe(bindings.get(b.name));
        }
        output.push(event);
      }
      cursor++;
    }
  }
  async function remainsPaused() {
    const count = ws.getMessages().length;
    await delay(30);
    expect(ws.getMessages()).toHaveLength(count);
    expect(output.some((event) => event.type === "session.closed")).toBe(false);
  }
  return { transcript, ws, output, command, through, remainsPaused };
}
function nested(event: LiveObject) {
  const value = event.event;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

describe("delegation causal public wire regression", () => {
  it("keeps the interrupted managed backend pending until both results and explicit continuation", async () => {
    const d = await delegationSocket("managed");
    const results = d.transcript.entries.flatMap((e, i) =>
      e.event.type === "response.item.create" ? [i] : [],
    );
    expect(results).toHaveLength(2);
    await d.through(results[0] - 1);
    // This is replay of the separately measured interruption capture. No
    // synthetic interruption event or acoustic-stop claim is inferred here.
    const delegation = d.output.find((e) => e.type === "session.delegation.created");
    expect(delegation).toBeDefined();
    expect(d.output.filter((e) => nested(e)?.type === "response.created")).toHaveLength(1);
    expect(
      d.output.some(
        (e) => e.type === "session.input_transcript.delta" && String(e.delta).includes("Stop"),
      ),
    ).toBe(true);
    const tools = d.output
      .filter((e) => nested(e)?.type === "response.output_item.done")
      .map((e) => nested(e)?.item);
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", name: "read_red" }),
        expect.objectContaining({ type: "function_call", name: "read_blue" }),
      ]),
    );
    await d.remainsPaused();
    await d.through(results[0]);
    await d.remainsPaused();
    await d.through(results[1]);
    await d.remainsPaused();
    expect(d.output.filter((e) => nested(e)?.type === "response.created")).toHaveLength(1);
    await d.through(d.transcript.entries.length - 1);
    const created = d.output.filter((e) => nested(e)?.type === "response.created");
    expect(created).toHaveLength(2);
    expect(created[1].delegation_id).toBe(created[0].delegation_id);
    const first = nested(created[0])?.response;
    const second = nested(created[1])?.response;
    expect(second).toMatchObject({
      previous_response_id:
        first && typeof first === "object" && !Array.isArray(first) ? first.id : undefined,
    });
    expect(d.output.filter((e) => nested(e)?.type === "response.completed")).toHaveLength(2);
    expect(d.output.at(-1)).toMatchObject({ type: "session.closed", usage: { seconds: 12 } });
    expect((await d.ws.waitForCloseFrame(1000)).code).toBe(1000);
  });

  it.each(["early-continuation", "missing-second-result", "wrong-call", "duplicate-result"])(
    "rejects managed %s before backend continuation",
    async (fault) => {
      const d = await delegationSocket("managed");
      const results = d.transcript.entries.flatMap((e, i) =>
        e.event.type === "response.item.create" ? [i] : [],
      );
      const continuation = d.transcript.entries.findIndex(
        (e) => e.event.type === "response.create",
      );
      await d.through(results[0] - 1);
      const first = d.command(results[0]);
      if (fault === "missing-second-result" || fault === "duplicate-result")
        await d.through(results[0]);
      const invalid =
        fault === "duplicate-result"
          ? first
          : fault === "wrong-call"
            ? first
            : d.command(continuation);
      if (fault === "wrong-call") replaceIdentifier(invalid, "/item/call_id", "unknown-call");
      d.ws.send(JSON.stringify(invalid));
      expect((await d.ws.waitForCloseFrame(1000)).code).toBe(1008);
      expect(JSON.parse(d.ws.getMessages().at(-1)!)).toMatchObject({
        type: "aimock.error",
        error: { category: "fixture-mismatch" },
      });
      expect(d.ws.getMessages()).toHaveLength(d.output.length + 1);
      expect(d.output.filter((e) => nested(e)?.type === "response.created")).toHaveLength(1);
      expect(
        d.ws.getMessages().some((message) => JSON.parse(message).type === "session.closed"),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    "preserves repeated client commentary with authored null delegation=%s",
    async (nullable) => {
      const transcript = readLiveCase("client").transcript;
      const commentary = transcript.entries.flatMap((e, i) =>
        e.event.type === "session.commentary.append" ? [i] : [],
      );
      expect(commentary).toHaveLength(2);
      // Null is documented, but not a successful original provider observation:
      // explicitly label this variation authored and remove its identity operands.
      if (nullable) {
        transcript.capture = {
          source: "authored",
          complete: true,
          terminalEntry: transcript.capture.terminalEntry,
        };
        for (const index of commentary) transcript.entries[index].event.delegation_id = null;
        transcript.bindings = transcript.bindings.filter(
          (b) => !(commentary.includes(b.entry) && b.pointer === "/delegation_id"),
        );
      }
      const d = await delegationSocket("client", transcript);
      await d.through(commentary[1] - 1);
      expect(d.output.filter((e) => e.type === "session.commentary.appended")).toHaveLength(1);
      await d.remainsPaused();
      await d.through(transcript.entries.length - 1);
      const acknowledgments = d.output.filter((e) => e.type === "session.commentary.appended");
      expect(acknowledgments).toHaveLength(2);
      expect(acknowledgments[0].client_event_id).not.toBe(acknowledgments[1].client_event_id);
      expect(
        d.output.filter((e) => e.type === "session.usage.updated").map((e) => e.usage),
      ).toEqual([{ seconds: 13 }, { seconds: 13 }]);
      expect(d.output.at(-1)).toMatchObject({ type: "session.closed", usage: { seconds: 13 } });
      expect((await d.ws.waitForCloseFrame(1000)).code).toBe(1000);
    },
  );
});
