import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerInstance } from "../server.js";
import { createServer } from "./helpers/misbehavior-enabled.js";

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer(
    [
      {
        match: {},
        response: { content: "hello", toolCalls: [{ name: "get_weather", arguments: "{}" }] },
      },
    ],
    {
      port: 0,
    },
  );
});

function upgrade(path: string, values: string[]) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const req = request({
      port: new URL(instance.url).port,
      path,
      headers: [
        "Host",
        "localhost",
        "Connection",
        "Upgrade",
        "Upgrade",
        "websocket",
        "Sec-WebSocket-Version",
        "13",
        "Sec-WebSocket-Key",
        "dGhlIHNhbXBsZSBub25jZQ==",
        ...values.flatMap((value) => ["X-AIMock-Misbehavior", value]),
      ],
    });
    req.on("upgrade", (res, socket) => {
      console.log(JSON.stringify({ path, headers: values, status: res.statusCode }));
      socket.destroy();
      resolve({ status: res.statusCode, body: undefined });
    });
    req.on("response", (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        raw += chunk;
      });
      res.on("error", reject);
      res.on("end", () => {
        console.log(JSON.stringify({ path, headers: values, status: res.statusCode, raw }));
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("WebSocket handshake timed out")));
    req.end();
  });
}

describe.each([
  "/v1/responses",
  "/v1/realtime?model=gpt-realtime",
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
])("WebSocket misbehavior header boundary at %s", (path) => {
  it.each([
    ["tool-args-invalid-json"],
    ["unknown-fault"],
    [""],
    ["refusal; message=hello", "world"],
  ])("rejects present header %j before upgrading", async (...values) => {
    const response = await upgrade(path, values);
    expect(response.status).toBe(400);
    const guidance = "use the runtime scope: POST /__aimock/misbehavior with X-Test-Id";
    expect(response.body).toMatchObject({
      error: path.startsWith("/ws/")
        ? {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: `aimock_misbehavior_invalid: ${guidance}`,
          }
        : { type: "invalid_request_error", code: "aimock_misbehavior_invalid", message: guidance },
    });
  });

  it("connects without the semantic header", async () => {
    expect((await upgrade(path, [])).status).toBe(101);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => instance.server.close(() => resolve()));
});

function post(path: string, values: string[]) {
  const body = JSON.stringify({
    model: "test",
    messages: [
      { role: "user", content: path.includes("/converse") ? [{ text: "hello" }] : "hello" },
    ],
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    input: "hello",
    max_tokens: 20,
    stream: false,
  });
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const req = request(
      {
        port: new URL(instance.url).port,
        path,
        method: "POST",
        headers: [
          "Host",
          "localhost",
          "Content-Type",
          "application/json",
          "Content-Length",
          String(Buffer.byteLength(body)),
          ...values.flatMap((value) => ["X-AIMock-Misbehavior", value]),
        ],
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("error", reject);
        res.on("end", () => {
          console.log(JSON.stringify({ path, headers: values, status: res.statusCode, raw }));
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("HTTP misbehavior header boundary", () => {
  it.each([
    ["unknown-fault"],
    ["tool-args-invalid-json; rate=banana"],
    ["tool-args-invalid-json; times=2"],
    ["tool-args-invalid-json; style=unknown"],
    ["tool-args-invalid-json", "tool-args-invalid-json"],
    ["tool-name-unknown; name=first", "tool-name-unknown; name=second"],
  ])("rejects malformed raw header %j", async (...values) => {
    const response = await post("/v1/chat/completions", values);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "aimock_misbehavior_invalid" } });
  });

  it.each([
    [
      "/v1/messages",
      {
        type: "error",
        error: { type: "invalid_request_error", code: "aimock_misbehavior_invalid" },
      },
    ],
    [
      "/v1/responses",
      { error: { type: "invalid_request_error", code: "aimock_misbehavior_invalid" } },
    ],
    ["/v1beta/models/test:generateContent", { error: { code: 400, status: "INVALID_ARGUMENT" } }],
    [
      "/v1/projects/p/locations/l/publishers/google/models/test:generateContent",
      { error: { code: 400, status: "INVALID_ARGUMENT" } },
    ],
    ["/v1beta/interactions", { error: { code: "aimock_misbehavior_invalid" } }],
    ["/model/test/invoke", { __type: "ValidationException" }],
    ["/model/test/converse", { __type: "ValidationException" }],
    ["/api/chat", { error: expect.any(String) }],
    ["/v2/chat", { message: expect.any(String) }],
  ])("rejects before provider serving at %s", async (path, envelope) => {
    const response = await post(path, ["unknown-fault"]);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject(envelope);
    expect(JSON.stringify(response.body)).toContain("aimock_misbehavior_invalid");
    if (path.startsWith("/model/")) expect(response.body).not.toHaveProperty("code");
  });

  it("passes a valid scalar header through the HTTP boundary", async () => {
    const response = await post("/v1/chat/completions", ["tool-args-invalid-json; rate=0"]);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("choices");
  });

  it("passes the whole Node-normalized repeated value when it is one valid grammar", async () => {
    const response = await post("/v1/chat/completions", ["refusal; message=hello", "world"]);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("choices");
  });
});
