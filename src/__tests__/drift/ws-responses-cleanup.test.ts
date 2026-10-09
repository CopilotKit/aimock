import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { LLMock } from "../../llmock.js";
import { extractWSErrorBody, openaiResponsesWS } from "./ws-providers.js";

// Routing instrumentation only: all handshake and response bytes come from
// LLMock. The TLS proxy adds encryption, without manufacturing provider frames.
async function withLocalRoute(run: (mock: LLMock, clients: tls.TLSSocket[]) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "aimock-responses-cleanup-"));
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
  const peers: net.Socket[] = [];
  const clients: tls.TLSSocket[] = [];
  const proxy = tls.createServer({ key: readFileSync(keyPath), cert }, (socket) => {
    const upstream = net.connect(Number(address.port), address.hostname);
    peers.push(socket, upstream);
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
    await run(mock, clients);
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

test("closes the actual socket after the unchanged 30s wait rejects", async () => {
  await withLocalRoute(async (mock, clients) => {
    mock.addFixture({
      match: { userMessage: "slow" },
      response: { content: "Delayed" },
      recordedTimings: { ttftMs: 0, interChunkDelaysMs: [60000], totalDurationMs: 60000 },
    });
    let failure: unknown;
    try {
      await openaiResponsesWS({ apiKey: "local" }, [{ role: "user", content: "slow" }]);
    } catch (error) {
      failure = error;
    }
    // Observe resource release before the fixture/proxy/server teardown. The
    // existing close() fallback destroys an uncooperative peer after 3 seconds.
    const client = clients[0];
    await Promise.race([client.destroyed ? Promise.resolve() : once(client, "close"), delay(3500)]);
    console.log(
      JSON.stringify({
        case: "timeout",
        failure:
          failure instanceof Error ? { name: failure.name, message: failure.message } : failure,
        closedBeforeTeardown: client.destroyed,
        journal: mock.getRequests(),
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "waitUntil timeout after 30000ms. Collected 1 messages: [response.created]",
    );
    expect(mock.getRequests()).toHaveLength(1);
    expect(client.destroyed).toBe(true);
  });
}, 40000);

test("keeps real success events and native error classification while closing each socket", async () => {
  await withLocalRoute(async (mock, clients) => {
    mock.addFixture({ match: { userMessage: "normal" }, response: { content: "Hello" } });
    const success = await openaiResponsesWS({ apiKey: "local" }, [
      { role: "user", content: "normal" },
    ]);
    expect(success.events.at(-1)?.type).toBe("response.completed");
    expect(success.rawMessages).toContainEqual(
      expect.objectContaining({ type: "response.output_text.done", text: "Hello" }),
    );
    expect(extractWSErrorBody(success.rawMessages)).toBeNull();
    const error = await openaiResponsesWS({ apiKey: "local" }, [
      { role: "user", content: "unmatched" },
    ]);
    expect(error.events).toHaveLength(1);
    expect(error.events[0].type).toBe("error");
    expect(extractWSErrorBody(error.rawMessages)).toContain("No fixture matched");
    await Promise.all(
      clients.map((client) =>
        Promise.race([client.destroyed ? Promise.resolve() : once(client, "close"), delay(3500)]),
      ),
    );
    console.log(
      JSON.stringify({
        case: "success-and-error",
        success,
        error,
        closedBeforeTeardown: clients.map((client) => client.destroyed),
        journal: mock.getRequests(),
      }),
    );
    expect(clients).toHaveLength(2);
    expect(clients.every((client) => client.destroyed)).toBe(true);
  });
});
