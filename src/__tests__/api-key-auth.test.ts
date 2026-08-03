import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { createServer, type ServerInstance } from "../server.js";
import { resolveInboundAuth } from "../api-key-auth.js";

let instance: ServerInstance | undefined;

afterEach(async () => {
  if (instance) await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
  instance = undefined;
});

function request(
  url: string,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(
      method === "POST"
        ? JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] })
        : undefined,
    );
  });
}

function rawUpgrade(url: string, headers: string[]): Promise<string> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port), target.hostname);
    let wire = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      wire += chunk.toString();
      if (wire.includes("\r\n\r\n")) socket.destroy();
    });
    socket.on("close", () => resolve(wire));
    socket.write(
      [
        "GET /v1/realtime HTTP/1.1",
        `Host: ${target.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...headers,
        "",
        "",
      ].join("\r\n"),
    );
  });
}

describe("API key configuration and policy", () => {
  it("rejects unsafe runtime shapes without exposing key values", () => {
    for (const value of [
      null,
      "key",
      [],
      { apiKeys: ["ok", 1] },
      { apiKeys: [" secret ", "secret"] },
    ]) {
      expect(() => resolveInboundAuth({ value, label: "options.auth" })).toThrow();
    }
    expect(() =>
      resolveInboundAuth({ value: { apiKeys: ["super-secret", 1] }, label: "options.auth" }),
    ).toThrow("options.auth.apiKeys[1]");
    expect(() =>
      resolveInboundAuth({ value: { apiKeys: ["bad\nkey"] }, label: "options.auth" }),
    ).toThrow("control");
  });

  it("normalizes a valid public configuration", () => {
    expect(
      resolveInboundAuth({ value: { apiKeys: [" one ", "two"] }, label: "options.auth" })
        .publicConfig,
    ).toEqual({ apiKeys: ["one", "two"] });
  });
});

describe("API key HTTP boundary", () => {
  it("rejects missing, wrong and duplicate-conflicting credentials before fixtures", async () => {
    instance = await createServer(
      [{ match: { userMessage: "hello" }, response: { content: "ok" } }],
      { auth: { apiKeys: ["primary", "rotated"] } },
    );
    for (const headers of [
      {},
      { Authorization: "Bearer wrong" },
      { Authorization: "Bearer primary", "X-Api-Key": "rotated" },
    ]) {
      const result = await request(`${instance.url}/v1/chat/completions`, headers);
      expect(result.status).toBe(401);
      expect(result.body).toBe(
        '{"error":{"message":"Invalid API key","type":"authentication_error","code":"invalid_api_key"}}',
      );
      expect(result.headers["www-authenticate"]).toBe('Bearer realm="aimock"');
    }
  });

  it("accepts every supported raw credential form and public probes", async () => {
    instance = await createServer(
      [{ match: { userMessage: "hello" }, response: { content: "ok" } }],
      { auth: { apiKeys: ["primary"] } },
    );
    for (const headers of [
      { Authorization: "Bearer primary" },
      { Authorization: "Key primary" },
      { "X-Api-Key": "primary" },
      { "X-Goog-Api-Key": "primary" },
      { "Api-Key": "primary" },
      { "Xi-Api-Key": "primary" },
    ])
      expect((await request(`${instance.url}/v1/chat/completions`, headers)).status).toBe(200);
    expect((await request(`${instance.url}/health`, {}, "GET")).status).toBe(200);
  });

  it("allows only genuine CORS preflights without a key", async () => {
    instance = await createServer([], { auth: { apiKeys: ["primary"] } });
    expect(
      (
        await request(
          `${instance.url}/v1/chat/completions`,
          { Origin: "https://example.test", "Access-Control-Request-Method": "POST" },
          "OPTIONS",
        )
      ).status,
    ).toBe(204);
    expect((await request(`${instance.url}/v1/chat/completions`, {}, "OPTIONS")).status).toBe(401);
  });
});

describe("API key WebSocket upgrade", () => {
  it("uses a literal 401 rejection before websocket handshake", async () => {
    instance = await createServer([], { auth: { apiKeys: ["primary", "rotated"] } });
    const rejected = await rawUpgrade(instance.url, ["Authorization: Bearer wrong"]);
    expect(rejected).toContain("HTTP/1.1 401 Unauthorized");
    expect(rejected).toContain("Content-Type: application/json");
    expect(rejected).toContain("Connection: close");
    const accepted = await rawUpgrade(instance.url, ["Authorization: Bearer primary"]);
    expect(accepted).toContain("HTTP/1.1 101 Switching Protocols");
  });
});

describe("API key proxy isolation", () => {
  it("scrubs the test key and injects the configured provider key before real egress", async () => {
    let upstreamHeaders: http.IncomingHttpHeaders | undefined;
    const upstream = http.createServer((req, res) => {
      upstreamHeaders = req.headers;
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "gpt-4",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as net.AddressInfo;
    instance = await createServer([], {
      auth: { apiKeys: ["test-key"] },
      record: {
        providers: { openai: `http://127.0.0.1:${address.port}` },
        providerKeys: { openai: "provider-key" },
        proxyOnly: true,
      },
    });
    const result = await request(`${instance.url}/v1/chat/completions`, {
      Authorization: "Bearer test-key",
      "X-Api-Key": "test-key",
    });
    expect(result.status).toBe(200);
    expect(upstreamHeaders?.authorization).toBe("Bearer provider-key");
    expect(upstreamHeaders?.["x-api-key"]).toBeUndefined();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("does not connect upstream when an auth-enabled proxy has no provider key", async () => {
    let connections = 0;
    const upstream = http.createServer((req, res) => {
      connections += 1;
      req.resume();
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as net.AddressInfo;
    instance = await createServer([], {
      auth: { apiKeys: ["test-key"] },
      record: {
        providers: { openai: `http://127.0.0.1:${address.port}` },
        proxyOnly: true,
      },
    });
    const result = await request(`${instance.url}/v1/chat/completions`, {
      Authorization: "Bearer test-key",
    });
    expect(result.status).toBe(502);
    expect(connections).toBe(0);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});
