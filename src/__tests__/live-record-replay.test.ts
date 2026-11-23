import { mkdtempSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { computeAcceptKey } from "../ws-framing.js";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { JournalEntry } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";
import { readLiveCase, runLiveScenario, normalizeCapturedScenario } from "./live-test-support.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function refusal(
  options: {
    caller?: string;
    key?: string;
    local?: string;
    suffix?: string;
    status?: number;
    scheme?: string;
  } = {},
) {
  const seen: { authorization?: string; path?: string }[] = [];
  const peer = createServer();
  peer.on("upgrade", (req, socket) => {
    seen.push({ authorization: req.headers.authorization, path: req.url });
    socket.end(
      `HTTP/1.1 ${options.status ?? 401} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => peer.close((err) => (err ? reject(err) : resolve()))),
  );
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const mock = new LLMock({
    auth: options.local ? { apiKeys: [options.local] } : undefined,
    record: {
      providers: { openai: `http://127.0.0.1:${address.port}${options.suffix ?? ""}` },
      providerKeys: options.key ? { openai: options.key } : undefined,
    },
  });
  await mock.start();
  cleanup.push(() => mock.stop());
  const ws = await connectWebSocket(
    mock.url,
    "/v1/live/sessions",
    options.caller
      ? { Authorization: `${options.scheme ?? "Bearer"} ${options.caller}` }
      : undefined,
  );
  cleanup.push(async () => ws.destroy());
  ws.send(JSON.stringify(readLiveCase("client").transcript.entries[0].event));
  const messages = await ws.waitForMessages(1, 1500);
  await ws.waitForCloseFrame(1500);
  return { seen, message: JSON.parse(messages[0]), journal: JSON.stringify(mock.getRequests()) };
}
describe("Live recording route", () => {
  it.each([
    { key: "configured-key", expected: "configured-key" },
    { caller: "sk-aimock-dummy", key: "configured-key", expected: "configured-key" },
    { caller: "real-caller", key: "configured-key", expected: "real-caller" },
    {
      caller: "local-only",
      local: "local-only",
      key: "configured-key",
      expected: "configured-key",
    },
    { caller: "local-only", local: "local-only", expected: undefined },
    {
      caller: "local-only",
      local: "local-only",
      key: "configured-key",
      scheme: "Key",
      expected: "configured-key",
    },
  ])("applies upstream auth precedence %#", async ({ expected, ...options }) => {
    const { seen, message, journal } = await refusal(options);
    for (const key of [options.key, options.caller]) if (key) expect(journal).not.toContain(key);
    expect(seen).toEqual([
      { authorization: expected ? `Bearer ${expected}` : undefined, path: "/v1/live/sessions" },
    ]);
    expect(message).toMatchObject({ type: "aimock.error", error: { category: "upstream-auth" } });
  });
  it.each([403, 404, 429])("classifies upstream refusal %i without a fixture", async (status) => {
    const { message } = await refusal({ status });
    expect(message).toMatchObject({ error: { category: "upstream-access" } });
  });
  it.each(["/?token=harmless-secret", "/#fragment"])(
    "rejects credential/query/fragment URL %s before connect",
    async (suffix) => {
      const { seen, message } = await refusal({ suffix });
      expect(seen).toEqual([]);
      expect(message).toMatchObject({ error: { category: "upstream-connect" } });
    },
  );

  it.each(["/v1", "/v1/", "/"])("normalizes provider URL %s", async (suffix) => {
    const { seen } = await refusal({ suffix });
    expect(seen[0]?.path).toBe("/v1/live/sessions");
  });
});

async function recordedCase(
  mode: "client" | "managed",
  proxyOnly = false,
  delayedUpgrade = false,
  replayIdleTimeoutMs?: number,
  hugeLimits = false,
  auth?: { scheme: "Bearer" | "Key"; token: string; includeInSemantics: boolean },
  ownership?: {
    testId: string;
    query: boolean;
    secretValues?: string[];
    onJournalAdd?: (entry: JournalEntry) => void;
  },
) {
  const { transcript } = readLiveCase(mode);
  if (auth?.includeInSemantics) {
    transcript.configuration.instructions = auth.token;
    for (const entry of transcript.entries) {
      const session = entry.event.session;
      if (session && typeof session === "object" && !Array.isArray(session))
        session.instructions = auth.token;
    }
  }
  for (const entry of transcript.entries) entry.atMs = Math.floor(entry.atMs / 100);
  const upstream = new LLMock();
  upstream.onLive({}, transcript);
  await upstream.start();
  cleanup.push(() => upstream.stop());
  const dir = mkdtempSync(join(tmpdir(), "live-record-route-"));
  cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
  let upstreamUrl = upstream.url;
  if (delayedUpgrade) {
    const proxy = createTcpServer((socket) => {
      socket.pause();
      const timer = setTimeout(() => {
        const remote = connectTcp(upstream.port, "127.0.0.1");
        socket.pipe(remote).pipe(socket);
        socket.resume();
        socket.on("end", () => socket.destroy());
        socket.on("error", () => remote.destroy());
        remote.on("error", () => socket.destroy());
        socket.on("close", () => remote.destroy());
        remote.on("close", () => socket.destroy());
      }, 150);
      socket.on("close", () => clearTimeout(timer));
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    upstreamUrl = `http://127.0.0.1:${address.port}`;
  }
  const mock = new LLMock({
    record: {
      providers: { openai: upstreamUrl },
      fixturePath: dir,
      proxyOnly,
      ...(hugeLimits
        ? { upstreamTimeoutMs: Number.MAX_SAFE_INTEGER, bodyTimeoutMs: Number.MAX_SAFE_INTEGER }
        : {}),
    },
    live: ownership?.secretValues
      ? { secretValues: ownership.secretValues }
      : hugeLimits
        ? { maxDurationMs: Number.MAX_SAFE_INTEGER, idleTimeoutMs: Number.MAX_SAFE_INTEGER }
        : replayIdleTimeoutMs === undefined
          ? undefined
          : { idleTimeoutMs: replayIdleTimeoutMs },
  });
  await mock.start();
  cleanup.push(() => mock.stop());
  if (ownership?.onJournalAdd)
    Object.defineProperty(mock.journal, "onAdd", { value: ownership.onJournalAdd });
  const ws = await connectWebSocket(
    mock.url,
    `/v1/live/sessions${ownership?.query ? `?testId=${encodeURIComponent(ownership.testId)}` : ""}`,
    {
      ...(auth ? { Authorization: `${auth.scheme} ${auth.token}` } : {}),
      ...(ownership && !ownership.query ? { "X-Test-Id": ownership.testId } : {}),
    },
  );
  cleanup.push(async () => ws.destroy());
  const result = await runLiveScenario(ws, transcript, {
    clientIdPrefix: `record-${mode}`,
    timeoutMs: 45000,
  }).catch((error: unknown) => {
    // A rejected terminal export adds one error after the complete provider lifecycle.
    if (
      auth?.includeInSemantics &&
      error instanceof Error &&
      error.message === "unexpected server events"
    )
      return undefined;
    throw error;
  });
  if (result) expect(result.normalized).toEqual(normalizeCapturedScenario(transcript));
  await ws.waitForCloseFrame(1500);
  return { dir, mock, messages: ws.getMessages() };
}
describe("Live journal test ownership", () => {
  it.each([
    { source: "configured", query: false },
    { source: "configured", query: true },
    { source: "selected", query: false },
    { source: "selected", query: true },
  ])(
    "redacts $source recording owner secrets with query=$query before publication",
    async ({ source, query }) => {
      const secret = "synthetic-owner-private-7f3d";
      const published: string[] = [];
      const { mock } = await recordedCase(
        "client",
        false,
        false,
        undefined,
        false,
        {
          scheme: "Bearer",
          token: source === "selected" ? secret : "ordinary-test-credential",
          includeInSemantics: false,
        },
        {
          testId: `run-${secret}`,
          query,
          secretValues: source === "configured" ? [secret] : undefined,
          onJournalAdd: (entry) => published.push(JSON.stringify(entry)),
        },
      );
      const response = await fetch(`${mock.url}/__aimock/journal`);
      expect(response.status).toBe(200);
      expect.soft((await response.text()).includes(secret)).toBe(false);
      expect.soft(published.some((entry) => entry.includes(secret))).toBe(false);
      expect(published).toHaveLength(1);
      expect(mock.getRequests()[0].headers["x-test-id"]).toBe("[REDACTED]");
    },
    10000,
  );
  it.each([
    { mode: "record", query: false },
    { mode: "record", query: true },
    { mode: "replay", query: false },
    { mode: "replay", query: true },
  ])(
    "filters $mode journal ownership with query=$query",
    async ({ mode, query }) => {
      const owner = "live-owner-one";
      const credential = "synthetic-private-live-owner-token";
      let mock: LLMock;
      if (mode === "record") {
        ({ mock } = await recordedCase(
          "client",
          false,
          false,
          undefined,
          false,
          { scheme: "Bearer", token: credential, includeInSemantics: false },
          { testId: owner, query },
        ));
      } else {
        const { transcript } = readLiveCase("client");
        mock = new LLMock({ live: { secretValues: [credential] } });
        mock.onLive({}, transcript);
        await mock.start();
        cleanup.push(() => mock.stop());
        const ws = await connectWebSocket(
          mock.url,
          `/v1/live/sessions${query ? `?testId=${owner}` : ""}`,
          {
            Authorization: `Bearer ${credential}`,
            "X-Extra": credential,
            ...(!query ? { "X-Test-Id": owner } : {}),
          },
        );
        cleanup.push(async () => ws.destroy());
        ws.send(JSON.stringify(transcript.entries[0].event));
        expect(JSON.parse((await ws.waitForMessages(1, 1500))[0]).type).toBe("session.started");
      }
      const response = await fetch(`${mock.url}/__aimock/journal?testId=${owner}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([{ headers: { "x-test-id": owner } }]);
      for (const other of ["another-live-owner", "__default__"]) {
        const filtered = await fetch(`${mock.url}/__aimock/journal?testId=${other}`);
        expect(await filtered.json()).toEqual([]);
      }
      expect(JSON.stringify(mock.getRequests())).not.toContain(credential);
    },
    10000,
  );
});

describe("Live recording persistence", () => {
  it.each(["Key", "Bearer"] as const)(
    "does not persist a bare %s credential embedded in semantic capture",
    async (scheme) => {
      const token = "synthetic-live-credential-7f3d";
      const { dir, mock, messages } = await recordedCase("client", false, false, undefined, false, {
        scheme,
        token,
        includeInSemantics: true,
      });
      const files = readdirSync(dir);
      const leaked = files.some((file) => readFileSync(join(dir, file), "utf8").includes(token));
      expect(leaked).toBe(false);
      expect(files).toEqual([]);
      expect(mock.getFixtures()).toHaveLength(0);
      expect(JSON.parse(messages.at(-2)!)).toMatchObject({ type: "session.closed" });
      expect(JSON.parse(messages.at(-1)!)).toMatchObject({
        type: "aimock.error",
        error: { category: "unsafe-export" },
      });
      expect(mock.getRequests()[0].response.error).toBe("unsafe-export");
    },
    10000,
  );
  it("still records an ordinary Bearer credential without semantic leakage", async () => {
    const { dir } = await recordedCase("client", false, false, undefined, false, {
      scheme: "Bearer",
      token: "synthetic-live-credential-7f3d",
      includeInSemantics: false,
    });
    expect(readdirSync(dir)).toHaveLength(1);
  }, 10000);
  it.each(["client", "managed"] as const)(
    "records %s through real public sockets and restarts offline",
    async (mode) => {
      const { dir, mock } = await recordedCase(mode);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(mock.getRequests()).toHaveLength(1);
      const filepath = join(dir, files[0]);
      const data = JSON.parse(readFileSync(filepath, "utf8"));
      const replay = new LLMock();
      replay.loadFixtureFile(filepath);
      await replay.start();
      cleanup.push(() => replay.stop());
      const ws = await connectWebSocket(replay.url, "/v1/live/sessions");
      cleanup.push(async () => ws.destroy());
      const result = await runLiveScenario(ws, data.fixtures[0].response.live, {
        clientIdPrefix: `offline-${mode}`,
        timeoutMs: 45000,
      });
      expect(result.normalized).toEqual(normalizeCapturedScenario(data.fixtures[0].response.live));
    },
    95000,
  );
  it("anchors exported time to accepted startup rather than upgrade latency", async () => {
    const { dir } = await recordedCase("client", false, true);
    const exported = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    expect(exported.fixtures[0].response.live.entries[0].atMs).toBe(0);
  }, 10000);
  it("honors recording startup budget independently of replay idle", async () => {
    const { dir } = await recordedCase("client", false, true, 40);
    expect(readdirSync(dir)).toHaveLength(1);
  }, 10000);
  it("does not overflow accepted large recording and session deadlines", async () => {
    const { dir } = await recordedCase("client", false, true, undefined, true);
    expect(readdirSync(dir)).toHaveLength(1);
  }, 10000);
  it("proxyOnly forwards without a persisted fixture or memory cache", async () => {
    const { dir, mock } = await recordedCase("client", true);
    expect(readdirSync(dir)).toEqual([]);
    expect(mock.getFixtures()).toHaveLength(0);
  }, 45000);
});

describe("Live recording startup cleanup", () => {
  async function stalled(
    limits: {
      upstreamTimeoutMs?: number;
      maxBufferedBytes?: number;
      maxWriteBytes?: number;
      maxProxyBufferBytes?: number;
    } = {},
  ) {
    const upstream = new LLMock();
    upstream.on({ endpoint: "openai-live" }, () => new Promise(() => {}));
    await upstream.start();
    cleanup.push(() => upstream.stop());
    const dir = mkdtempSync(join(tmpdir(), "live-incomplete-"));
    cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
    const mock = new LLMock({
      record: {
        providers: { openai: upstream.url },
        fixturePath: dir,
        upstreamTimeoutMs: limits.upstreamTimeoutMs ?? 1000,
        maxProxyBufferBytes: limits.maxProxyBufferBytes,
      },
      live: { maxBufferedBytes: limits.maxBufferedBytes, maxWriteBytes: limits.maxWriteBytes },
    });
    await mock.start();
    cleanup.push(() => mock.stop());
    const ws = await connectWebSocket(mock.url, "/v1/live/sessions");
    cleanup.push(async () => ws.destroy());
    ws.send(JSON.stringify(readLiveCase("client").transcript.entries[0].event));
    return { mock, ws, dir };
  }
  it("aborts a stalled startup without exporting", async () => {
    const { ws, dir, mock } = await stalled({ upstreamTimeoutMs: 40 });
    const messages = await ws.waitForMessages(1, 1000);
    expect(JSON.parse(messages[0])).toMatchObject({ error: { category: "timeout" } });
    await ws.waitForCloseFrame(1000);
    expect(readdirSync(dir)).toEqual([]);
    expect(mock.getFixtures()).toHaveLength(0);
  });
  it("bounds pipelined input while waiting for session.started", async () => {
    const { ws, dir } = await stalled({ maxBufferedBytes: 4096 });
    for (let i = 0; i < 8; i++)
      ws.send(
        JSON.stringify({
          type: "session.input_audio.append",
          audio: Buffer.alloc(768).toString("base64"),
        }),
      );
    const messages = await ws.waitForMessages(1, 1000);
    expect(JSON.parse(messages[0])).toMatchObject({ error: { category: "resource-limit" } });
    expect((await ws.waitForCloseFrame(1000)).code).toBe(1009);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("applies capture byte cap to the pending startup queue", async () => {
    const { ws, dir } = await stalled({ maxBufferedBytes: 16384, maxProxyBufferBytes: 2048 });
    for (let i = 0; i < 3; i++)
      ws.send(
        JSON.stringify({
          type: "session.input_audio.append",
          audio: Buffer.alloc(768).toString("base64"),
        }),
      );
    const messages = await ws.waitForMessages(1, 1500);
    expect(JSON.parse(messages[0])).toMatchObject({ error: { category: "resource-limit" } });
    expect((await ws.waitForCloseFrame(1000)).code).toBe(1009);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("classifies an upstream write cap without exporting", async () => {
    const { ws, dir, mock } = await stalled({ maxWriteBytes: 32 });
    expect((await ws.waitForCloseFrame(1000)).code).toBe(1009);
    expect(mock.getRequests()[0]?.response.error).toBe("resource-limit");
    expect(readdirSync(dir)).toEqual([]);
  });
  it("disposes a pending provider and leaves no fixture", async () => {
    const { ws, dir, mock } = await stalled();
    mock.closeLiveSessions();
    expect((await ws.waitForCloseFrame(1000)).code).toBe(1001);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("Live upstream byte idle", () => {
  it("keeps fragmented traffic alive until bytes stop arriving", async () => {
    const peer = createServer();
    let stop: (() => void) | undefined;
    peer.on("upgrade", (request, socket) => {
      socket.resume();
      socket.on("end", () => socket.destroy());
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${computeAcceptKey(String(request.headers["sec-websocket-key"]))}\r\n\r\n`,
      );
      // Deliberately incomplete frame: a negative transport peer, never an LLM response.
      socket.write(Buffer.from([0x01, 126, 0, 255]));
      const timer = setInterval(() => socket.write(Buffer.from([32])), 10);
      stop = () => clearInterval(timer);
      socket.on("close", () => clearInterval(timer));
      socket.on("error", () => {
        clearInterval(timer);
        socket.destroy();
      });
    });
    peer.listen(0, "127.0.0.1");
    await once(peer, "listening");
    cleanup.push(async () => {
      stop?.();
      await new Promise<void>((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const mock = new LLMock({
      record: {
        providers: { openai: `http://127.0.0.1:${address.port}` },
        bodyTimeoutMs: 40,
        upstreamTimeoutMs: 1000,
      },
    });
    await mock.start();
    cleanup.push(() => mock.stop());
    const ws = await connectWebSocket(mock.url, "/v1/live/sessions");
    cleanup.push(async () => ws.destroy());
    ws.send(JSON.stringify(readLiveCase("client").transcript.entries[0].event));
    await delay(120);
    expect(ws.getMessages()).toEqual([]);
    stop?.();
    const messages = await ws.waitForMessages(1, 1000);
    expect(JSON.parse(messages[0])).toMatchObject({ error: { category: "timeout" } });
    await ws.waitForCloseFrame(1000);
    expect(mock.getFixtures()).toHaveLength(0);
  });
});

async function strictRoute(options: { strict: boolean; header?: string; matched?: boolean }) {
  let attempts = 0;
  const peer = createServer();
  peer.on("upgrade", (_req, socket) => {
    attempts++;
    socket.end("HTTP/1.1 503 Transport Counter\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const dir = mkdtempSync(join(tmpdir(), "live-strict-route-"));
  cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
  const mock = new LLMock({
    strict: options.strict,
    record: { providers: { openai: `http://127.0.0.1:${address.port}` }, fixturePath: dir },
  });
  const { transcript } = readLiveCase("client");
  if (options.matched)
    mock.on({ endpoint: "openai-live" }, { live: transcript, liveTiming: "immediate" });
  await mock.start();
  cleanup.push(() => mock.stop());
  const ws = await connectWebSocket(mock.url, "/v1/live/sessions", {
    "X-Test-Id": "strict-owner",
    Authorization: "Bearer caller-private-value",
    ...(options.header === undefined ? {} : { "X-AIMock-Strict": options.header }),
  });
  cleanup.push(async () => ws.destroy());
  ws.send(JSON.stringify(transcript.entries[0].event));
  const messages = await ws.waitForMessages(1, 1000);
  const close = options.matched ? undefined : await ws.waitForCloseFrame(1000);
  return {
    attempts,
    message: JSON.parse(messages[0]),
    close,
    journal: mock.getRequests(),
    files: readdirSync(dir),
  };
}

describe("Live strict record policy", () => {
  it.each([
    { strict: true, header: undefined, override: undefined },
    { strict: false, header: "true", override: true },
    { strict: true, header: "invalid", override: undefined },
  ])("rejects effective strict miss locally %#", async ({ override, ...options }) => {
    const result = await strictRoute(options);
    expect(result.attempts).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.close?.code).toBe(1008);
    expect(result.message).toMatchObject({
      type: "aimock.error",
      error: { category: "fixture-mismatch" },
    });
    expect(result.journal).toHaveLength(1);
    expect(result.journal[0].response).toMatchObject({ status: 503, fixture: null });
    expect(result.journal[0].response.strictOverride).toBe(override);
    expect(JSON.stringify(result.journal)).not.toContain("caller-private-value");
  });
  it.each([
    { strict: true, header: "false", override: false },
    { strict: false, header: "invalid", override: undefined },
  ])(
    "permits effective non-strict miss to reach configured transport %#",
    async ({ override, ...options }) => {
      const result = await strictRoute(options);
      expect(result.attempts).toBe(1);
      expect(result.files).toEqual([]);
      expect(result.close?.code).toBe(1008);
      expect(result.message).toMatchObject({ error: { category: "upstream-connect" } });
      expect(result.journal[0].response.strictOverride).toBe(override);
    },
  );
  it("still replays a matching fixture under strict mode", async () => {
    const result = await strictRoute({ strict: true, matched: true });
    expect(result.attempts).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.message).toMatchObject({ type: "session.started" });
    expect(result.journal[0].response.status).toBe(200);
  });
});
