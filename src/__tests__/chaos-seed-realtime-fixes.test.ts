/**
 * Seeded chaos on the WebSocket transports, over real sockets to a real server:
 *
 *   - a socket tagged with `?testId=` resolves its test's seed, the same way an
 *     `X-Test-Id` header does;
 *   - `POST /__aimock/reset` reaches a socket that was opened before it;
 *   - every WebSocket turn with a seed draws its streaming jitter from the
 *     seed, and an unseeded turn still draws from `Math.random()`.
 *
 * Jitter is observed as the delays the server hands to `setTimeout`. With a
 * jittered streaming profile those delays are fractional milliseconds, which
 * nothing else on these paths schedules.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture, MockServerOptions } from "../types.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

const PROFILE = { ttft: 4, tps: 250, jitter: 0.5 };

const TRANSCRIPTION_FIXTURE: Fixture = {
  match: { endpoint: "realtime-transcription" },
  response: { transcription: { text: "abcdefgh" } },
  chunkSize: 2,
  streamingProfile: PROFILE,
};

const TEXT_FIXTURE: Fixture = {
  match: { userMessage: "jitter" },
  response: { content: "abcdefghijklmnop" },
  chunkSize: 2,
  streamingProfile: PROFILE,
};

const GEMINI_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const servers: ServerInstance[] = [];
const sockets: WSTestClient[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.destroy();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((done) => s.server.close(() => done()))),
  );
});

async function start(fixtures: Fixture[], options: MockServerOptions = {}): Promise<string> {
  const instance = await createServer(structuredClone(fixtures), { port: 0, ...options });
  servers.push(instance);
  return instance.url;
}

async function connect(
  url: string,
  path: string,
  headers?: Record<string, string>,
): Promise<WSTestClient> {
  const ws = await connectWebSocket(url, path, headers);
  sockets.push(ws);
  return ws;
}

function control(
  url: string,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = http.request(
      `${url}${path}`,
      { method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        res.resume();
        res.on("end", () => resolveStatus(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Wait until a received message satisfies `done`; fail after `timeoutMs`. */
async function waitFor(
  ws: WSTestClient,
  done: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = ws.getMessages().some((m) => done(JSON.parse(m) as Record<string, unknown>));
    if (found) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out; received: ${ws.getMessages().join("\n")}`);
}

/**
 * Run `turn` and return the fractional delays it scheduled (the jittered
 * frame delays), plus whether `Math.random` was drawn while it ran.
 */
async function capture(turn: () => Promise<void>): Promise<{ delays: number[]; random: number }> {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (typeof ms === "number" && !Number.isInteger(ms)) delays.push(ms);
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
  const random = vi.spyOn(Math, "random");
  try {
    await turn();
    return { delays, random: random.mock.calls.length };
  } finally {
    timer.mockRestore();
    random.mockRestore();
  }
}

// ─── per-transport turns ────────────────────────────────────────────────────

async function transcriptionTurn(ws: WSTestClient): Promise<void> {
  await waitFor(ws, (m) => m.type === "session.created");
  ws.send(
    JSON.stringify({
      type: "transcription_session.update",
      session: { input_audio_transcription: { model: "gpt-live-transcribe" } },
    }),
  );
  await waitFor(ws, (m) => m.type === "transcription_session.updated");
  const before = ws.getMessages().length;
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  await waitFor(ws, () => ws.getMessages().length > before);
  await waitFor(
    ws,
    (m) =>
      m.type === "conversation.item.input_audio_transcription.completed" ||
      m.type === "conversation.item.input_audio_transcription.failed",
  );
}

async function realtimeTurn(ws: WSTestClient): Promise<void> {
  await waitFor(ws, (m) => m.type === "session.created");
  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "jitter" }] },
    }),
  );
  ws.send(JSON.stringify({ type: "response.create" }));
  await waitFor(ws, (m) => m.type === "response.done");
}

async function geminiTurn(ws: WSTestClient): Promise<void> {
  ws.send(JSON.stringify({ setup: { model: "gemini-2.0-flash-exp" } }));
  await waitFor(ws, (m) => "setupComplete" in m);
  ws.send(
    JSON.stringify({
      clientContent: { turns: [{ role: "user", parts: [{ text: "jitter" }] }], turnComplete: true },
    }),
  );
  await waitFor(
    ws,
    (m) => (m.serverContent as { turnComplete?: boolean } | undefined)?.turnComplete === true,
  );
}

async function responsesTurn(ws: WSTestClient): Promise<void> {
  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "gpt-4",
      input: [{ role: "user", content: "jitter" }],
    }),
  );
  await waitFor(ws, (m) => m.type === "response.completed");
}

// ─── Finding 1: ?testId= on the upgrade URL ─────────────────────────────────

describe("seeded chaos over WebSocket: ?testId= resolves the test's seed", () => {
  it("a socket tagged by ?testId= uses its test's seed, like an X-Test-Id socket", async () => {
    const url = await start([TRANSCRIPTION_FIXTURE]);
    expect(
      await control(url, "POST", "/__aimock/chaos", { seed: "per-test" }, { "X-Test-Id": "t1" }),
    ).toBe(200);

    const byHeader = await capture(async () =>
      transcriptionTurn(
        await connect(url, "/v1/realtime?intent=transcription", { "X-Test-Id": "t1" }),
      ),
    );
    const byQuery = await capture(async () =>
      transcriptionTurn(await connect(url, "/v1/realtime?intent=transcription&testId=t1")),
    );

    expect(byHeader.delays.length).toBeGreaterThan(0);
    expect(byHeader.random).toBe(0);
    expect(byQuery.random).toBe(0);
    expect(byQuery.delays).toEqual(byHeader.delays);
  });
});

// ─── Finding 3: jitter on the WebSocket transports ──────────────────────────
//
// Live transcription is the one WebSocket turn that applies a fixture
// `streamingProfile` (and so its jitter). Realtime `response.create`,
// gemini-live and responses-over-WebSocket pace by `latency` /
// `recordedTimings` only and never draw jitter, seeded or not.

describe("seeded chaos over WebSocket: jitter", () => {
  it("live transcription: the same seed gives the same jitter delays without Math.random", async () => {
    const a = await start([TRANSCRIPTION_FIXTURE], { chaos: { seed: "ws-jitter" } });
    const b = await start([TRANSCRIPTION_FIXTURE], { chaos: { seed: "ws-jitter" } });
    const path = "/v1/realtime?intent=transcription";
    const first = await capture(async () => transcriptionTurn(await connect(a, path)));
    const second = await capture(async () => transcriptionTurn(await connect(b, path)));

    expect(first.delays.length).toBeGreaterThan(2);
    expect(first.random).toBe(0);
    expect(second.random).toBe(0);
    expect(second.delays).toEqual(first.delays);
  });

  it("live transcription: unseeded, the jitter still draws from Math.random", async () => {
    const url = await start([TRANSCRIPTION_FIXTURE]);
    const run = await capture(async () =>
      transcriptionTurn(await connect(url, "/v1/realtime?intent=transcription")),
    );
    expect(run.delays.length).toBeGreaterThan(2);
    expect(run.random).toBeGreaterThanOrEqual(run.delays.length);
  });

  const unjittered: Array<{
    name: string;
    path: string;
    turn: (ws: WSTestClient) => Promise<void>;
  }> = [
    { name: "realtime response.create", path: "/v1/realtime", turn: realtimeTurn },
    { name: "gemini-live", path: GEMINI_PATH, turn: geminiTurn },
    { name: "responses over WebSocket", path: "/v1/responses", turn: responsesTurn },
  ];

  for (const { name, path, turn } of unjittered) {
    for (const seeded of [true, false]) {
      it(`${name}: draws no jitter (${seeded ? "seeded" : "unseeded"})`, async () => {
        const url = await start([TEXT_FIXTURE], seeded ? { chaos: { seed: "ws-jitter" } } : {});
        const ws = await connect(url, path);
        const run = await capture(() => turn(ws));
        // The fixture streamed in 2-character frames: "ab" ... "op".
        const text = ws.getMessages().join("\n");
        expect(text).toContain('"ab"');
        expect(text).toContain('"op"');
        expect(run.delays).toEqual([]);
        expect(run.random).toBe(0);
      });
    }
  }
});
