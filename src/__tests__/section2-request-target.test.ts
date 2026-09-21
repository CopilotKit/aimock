import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { connectWebSocket } from "./ws-test-client.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  vi.restoreAllMocks();
});

async function start() {
  mock = new LLMock({ port: 0, logLevel: "debug" });
  mock.addFixture({
    match: { userMessage: "sentinel", sequenceIndex: 0 },
    response: { content: "PRESERVED" },
  });
  await mock.start();
  return mock;
}

function raw(
  server: LLMock,
  path: string,
  upgrade = false,
  headers: OutgoingHttpHeaders = {},
  body?: string,
) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: new URL(server.url).port,
        path,
        method: body === undefined ? "GET" : "POST",
        agent: false,
        headers: upgrade
          ? {
              Connection: "Upgrade",
              Upgrade: "websocket",
              "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
              "Sec-WebSocket-Version": "13",
            }
          : headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          }),
        );
        res.on("error", (error: Error) => resolve({ status: 0, body: error.message, headers: {} }));
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error("request timed out")));
    req.on("error", (error: Error) => resolve({ status: 0, body: error.message, headers: {} }));
    req.end(body);
  });
}

function log(id: string, result: { status: number; body: string }) {
  process.stdout.write(JSON.stringify({ id, ...result }) + "\n");
}

async function healthy(server: LLMock) {
  const health = await raw(server, "/v1/_requests");
  log("healthy-follow-up", health);
  expect(health.status).toBe(200);
  const response = await fetch(server.url + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: false,
      messages: [{ role: "user", content: "sentinel" }],
    }),
  });
  const body = await response.text();
  log("sequence-preserved", { status: response.status, body });
  expect(response.status).toBe(200);
  expect(body).toContain("PRESERVED");
}

test.each([
  { path: "/v1/chat/completions", host: "[", body: "{}", method: "POST" },
  { path: "//[", host: "localhost", body: undefined, method: "GET" },
])(
  "C25 malformed HTTP request preserves rejection bookkeeping ($path)",
  async ({ path, host, body, method }) => {
    const server = await start();
    const errors = vi.spyOn(console, "error");
    const debug = vi.spyOn(console, "log");
    const result = await raw(
      server,
      path,
      false,
      {
        Host: host,
        Origin: "http://localhost:3000",
        "X-Request-Id": "cr-a1-invalid-host",
        "Content-Type": "application/json",
      },
      body,
    );
    const journal = server.getRequests();
    process.stdout.write(
      JSON.stringify({
        id: "malformed-http",
        ...result,
        journal,
        errors: errors.mock.calls,
        debug: debug.mock.calls,
      }) + "\n",
    );
    await healthy(server);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: { message: "Invalid request target", type: "invalid_request_error" },
    });
    expect(result.headers).toMatchObject({
      "x-request-id": "cr-a1-invalid-host",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": expect.stringContaining("POST"),
      "access-control-allow-headers": "*",
      "access-control-expose-headers": expect.stringContaining("X-Request-Id"),
    });
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      method,
      path,
      body: null,
      headers: {
        host,
        origin: "http://localhost:3000",
        "x-request-id": "cr-a1-invalid-host",
        "content-type": "application/json",
      },
      response: { status: 400, fixture: null, source: "internal" },
    });
    expect(errors).toHaveBeenCalledWith("[aimock]", `${method} ${path}: Invalid URL`);
    expect(
      debug.mock.calls.some(
        (call) => typeof call[1] === "string" && call[1].includes("TypeError: Invalid URL"),
      ),
    ).toBe(true);
  },
);

test("C25 malformed upgrade preserves warning and socket completion", async () => {
  const server = await start();
  const warnings = vi.spyOn(console, "warn");
  const result = await raw(server, "//[", true);
  process.stdout.write(
    JSON.stringify({
      id: "malformed-upgrade",
      ...result,
      warnings: warnings.mock.calls,
      journal: server.getRequests(),
    }) + "\n",
  );
  await healthy(server);
  expect(result.status).toBe(400);
  expect(warnings).toHaveBeenCalledWith("[aimock]", "Unhandled upgrade error: Invalid URL");
});

test("C25 supported relative, query, absolute, compatibility and WebSocket targets", async () => {
  const server = await start();
  for (const path of [
    "/v1/_requests",
    "/v1/_requests?limit=10",
    `${server.url}/v1/_requests`,
    "/openai/v1/models",
  ]) {
    const result = await raw(server, path);
    log(path, result);
    expect(result.status).toBe(200);
    expect(() => JSON.parse(result.body)).not.toThrow();
  }
  const ws = await connectWebSocket(server.url, "/v1/responses");
  process.stdout.write("valid-websocket-handshake=101\n");
  ws.close();
  await ws.waitForClose();
  await healthy(server);
});
