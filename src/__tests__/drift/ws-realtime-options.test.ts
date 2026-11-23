import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import type { RealtimeResponseCreateParams } from "openai-current-sdk/resources/realtime/realtime";
import { WebSocketConnection } from "../../ws-framing.js";
import { expect, test, vi } from "vitest";
import { LLMock } from "../../llmock.js";
import { openaiRealtimeWS } from "./ws-providers.js";

// Routing instrumentation only: all handshake and response bytes come from
// LLMock. The TLS proxy adds encryption, without manufacturing provider frames.
async function withLocalRoute(
  run: (
    mock: LLMock,
    received: unknown[],
    clients: tls.TLSSocket[],
    closeCodes: number[],
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "aimock-realtime-options-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath);
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  const address = new URL(await mock.start());
  const received: unknown[] = [];
  const closeCodes: number[] = [];
  const peers: net.Socket[] = [];
  const clients: tls.TLSSocket[] = [];
  const proxy = tls.createServer({ key: readFileSync(keyPath), cert }, (socket) => {
    const upstream = net.connect(Number(address.port), address.hostname);
    const decodingSocket = new net.Socket();
    // The observer has no peer: discard its automatic close echo locally.
    const ignoreObserverEcho = (error: NodeJS.ErrnoException) => {
      if (error.code !== "ERR_SOCKET_CLOSED") throw error;
    };
    const observer = new WebSocketConnection(decodingSocket);
    observer.on("error", ignoreObserverEcho);
    let handshake = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (bytes: Buffer) => {
      if (upgraded) {
        decodingSocket.emit("data", bytes);
        return;
      }
      handshake = Buffer.concat([handshake, bytes]);
      const end = handshake.indexOf("\r\n\r\n");
      if (end < 0) return;
      expect(handshake.subarray(0, end).toString()).not.toContain("OpenAI-Beta");
      upgraded = true;
      const remainder = handshake.subarray(end + 4);
      if (remainder.length) decodingSocket.emit("data", remainder);
    });
    observer.on("close", (code: number) => closeCodes.push(code));
    observer.on("message", (raw: string) => received.push(JSON.parse(raw)));
    peers.push(socket, upstream, decodingSocket);
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing TLS port");
  const realConnect = tls.connect;
  const routing = vi.spyOn(tls, "connect").mockImplementation((...args: unknown[]) => {
    const [options, callback] = args;
    if (
      !options ||
      typeof options !== "object" ||
      !("host" in options) ||
      typeof callback !== "function"
    ) {
      throw new Error("Unexpected TLS connect signature");
    }
    expect(options.host).toBe("api.openai.com");
    const client = realConnect(
      {
        ...options,
        host: "127.0.0.1",
        port: proxyAddress.port,
        servername: "localhost",
        ca: cert,
      },
      () => callback(),
    );
    clients.push(client);
    return client;
  });
  syncBuiltinESMExports();
  try {
    await run(mock, received, clients, closeCodes);
  } finally {
    routing.mockRestore();
    syncBuiltinESMExports();
    for (const socket of [...clients, ...peers]) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
    await mock.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

type RequestOptions = Pick<RealtimeResponseCreateParams, "max_output_tokens" | "tool_choice">;
// An optional extra argument is assignable before the seam exists, allowing the
// same real helper invocation to demonstrate RED and GREEN without type escapes.
const request: (
  config: { apiKey: string },
  text: string,
  tools?: object[],
  options?: RequestOptions,
) => ReturnType<typeof openaiRealtimeWS> = openaiRealtimeWS;
const tools = [{ type: "function", name: "weather", parameters: { type: "object" } }];
async function send(options?: RequestOptions) {
  let response: unknown;
  await withLocalRoute(async (mock, received) => {
    mock.addFixture({ match: { userMessage: "hello" }, response: { content: "Hello" } });
    const result = await request({ apiKey: "local" }, "hello", tools, options);
    expect(result.events.at(-1)?.type).toBe("response.done");
    expect(mock.getRequests()).toHaveLength(1);
    expect(received).toHaveLength(3);
    expect(received[0]).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-mini",
        output_modalities: ["text"],
        tools,
      },
    });
    expect(received[1]).toEqual({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    });
    response = received[2];
    console.log(
      "Realtime helper native request",
      JSON.stringify({
        options,
        received,
        terminal: result.rawMessages.at(-1),
        journal: mock.getRequests(),
      }),
    );
  });
  return response;
}
const cases: RequestOptions[] = [
  { max_output_tokens: 1, tool_choice: { type: "function", name: "weather" } },
  { max_output_tokens: 16, tool_choice: "required" },
  { max_output_tokens: 32, tool_choice: "auto" },
];
test.each(cases)(
  "forwards native options with max_output_tokens=$max_output_tokens",
  async (options) => {
    expect(await send(options)).toEqual({ type: "response.create", response: options });
  },
);
test("ordinary calls preserve bare response.create", async () => {
  expect(await send()).toEqual({ type: "response.create" });
});
test("only allowlisted fields reach the native response request", async () => {
  const extra = {
    max_output_tokens: 32,
    tool_choice: "required" as const,
    model: "injected",
    instructions: "injected",
    output_modalities: ["audio"],
  };
  expect(await send(extra)).toEqual({
    type: "response.create",
    response: {
      max_output_tokens: 32,
      tool_choice: "required",
    },
  });
});

test("closes the acquired socket after the original real wait timeout before teardown", async () => {
  await withLocalRoute(async (mock, received, clients, closeCodes) => {
    mock.addFixture({
      match: { userMessage: "slow" },
      response: { content: "Delayed" },
      recordedTimings: { ttftMs: 60000, interChunkDelaysMs: [60000], totalDurationMs: 60000 },
    });
    let failure: unknown;
    try {
      await openaiRealtimeWS({ apiKey: "local" }, "slow");
    } catch (error) {
      failure = error;
    }
    const client = clients[0];
    // This observation happens inside the callback, before the harness finally
    // destroys anything, and before the helper's 3s fallback can fire.
    await Promise.race([client.destroyed ? Promise.resolve() : once(client, "close"), delay(1000)]);
    const observation = {
      error: failure instanceof Error ? { name: failure.name, message: failure.message } : failure,
      closedBeforeTeardown: client.destroyed,
      receivedCloseCodes: closeCodes,
      received,
      journal: mock.getRequests(),
    };
    console.log("Realtime actual timeout lifecycle", JSON.stringify(observation));
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected original timeout error");
    expect(failure.name).toBe("Error");
    expect(failure.message).toContain("waitUntil timeout after 30000ms.");
    expect(failure.message).toContain("step=response.done");
    expect(received).toHaveLength(3);
    expect(closeCodes).toEqual([1000]);
    expect(client.destroyed).toBe(true);
  });
}, 35000);
