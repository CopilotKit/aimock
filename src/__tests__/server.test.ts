import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// --- helpers ---

function post(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function options(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "OPTIONS",
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function postRaw(url: string, raw: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

function parseSSEEvents(body: string): unknown[] {
  const events: unknown[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ") && line !== "data: [DONE]") {
      events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [
      {
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      },
    ],
  },
};

const errorFixture: Fixture = {
  match: { userMessage: "fail" },
  response: {
    error: {
      message: "Rate limited",
      type: "rate_limit_error",
      code: "rate_limit",
    },
    status: 429,
  },
};

// Fixture whose response matches no known type guard — exercises the fallback path
const badResponseFixture: Fixture = {
  match: { userMessage: "badtype" },
  response: { content: 42 } as unknown as Fixture["response"],
};

const allFixtures: Fixture[] = [textFixture, toolFixture, errorFixture, badResponseFixture];

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

describe("createServer", () => {
  it("returns a listening server with a url", async () => {
    instance = await createServer(allFixtures);
    expect(instance.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(instance.server.listening).toBe(true);
  });

  it("respects custom host and port", async () => {
    instance = await createServer(allFixtures, {
      host: "127.0.0.1",
      port: 0,
    });
    expect(instance.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("POST /v1/chat/completions", () => {
  it("streams text response as SSE", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const events = parseSSEEvents(res.body);
    expect(events.length).toBeGreaterThanOrEqual(3);

    // First event should have role
    const first = events[0] as {
      choices: [{ delta: { role?: string } }];
    };
    expect(first.choices[0].delta.role).toBe("assistant");

    // Last event should have finish_reason
    const last = events[events.length - 1] as {
      choices: [{ finish_reason: string | null }];
    };
    expect(last.choices[0].finish_reason).toBe("stop");

    // Body ends with [DONE]
    expect(res.body).toContain("data: [DONE]");
  });

  it("streams tool call response as SSE", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "weather" }],
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Look for a tool_calls delta
    const toolEvent = events.find((e) => {
      const ev = e as {
        choices: [{ delta: { tool_calls?: unknown[] } }];
      };
      return ev.choices[0].delta.tool_calls?.length;
    });
    expect(toolEvent).toBeDefined();

    // Last event should have finish_reason "tool_calls"
    const last = events[events.length - 1] as {
      choices: [{ finish_reason: string | null }];
    };
    expect(last.choices[0].finish_reason).toBe("tool_calls");

    expect(res.body).toContain("data: [DONE]");
  });

  it("returns 404 when no fixture matches", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "unknown" }],
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
    expect(body.error.code).toBe("no_fixture_match");
  });

  it("returns error fixture with correct status", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "fail" }],
    });

    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Rate limited");
    expect(body.error.code).toBe("rate_limit");
  });

  it("returns 400 for malformed JSON", async () => {
    instance = await createServer(allFixtures);
    const res = await postRaw(`${instance.url}/v1/chat/completions`, "{not valid json");

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
    expect(body.error.code).toBe("invalid_json");
  });

  it("uses fixture-level chunkSize override", async () => {
    const bigChunkFixture: Fixture = {
      match: { userMessage: "bigchunk" },
      response: { content: "ABCDEFGHIJ" },
      chunkSize: 5,
    };
    instance = await createServer([bigChunkFixture], { chunkSize: 2 });
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "bigchunk" }],
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);
    // With chunkSize 5 and content "ABCDEFGHIJ" (10 chars):
    // 1 role chunk + 2 content chunks + 1 finish = 4
    expect(events.length).toBe(4);
  });

  it("returns 500 when fixture response matches no known type", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "badtype" }],
    });

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("did not match any known type");

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.status).toBe(500);
    expect(entry!.response.fixture).toBe(badResponseFixture);
  });

  it("uses server-level chunkSize default", async () => {
    const fixture: Fixture = {
      match: { userMessage: "small" },
      response: { content: "ABCD" },
      // no fixture-level chunkSize
    };
    instance = await createServer([fixture], { chunkSize: 2 });
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "small" }],
    });

    expect(res.status).toBe(200);
    const events = parseSSEEvents(res.body);
    // chunkSize 2, content "ABCD":
    // 1 role + 2 content + 1 finish = 4
    expect(events.length).toBe(4);
  });
});

describe("POST /v1/chat/completions (non-streaming)", () => {
  it("returns text response as JSON when stream=false", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-4");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hi there!");
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  it("returns tool call response as JSON when stream=false", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "weather" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].finish_reason).toBe("tool_calls");

    const tc = body.choices[0].message.tool_calls;
    expect(tc).toHaveLength(1);
    expect(tc[0].function.name).toBe("get_weather");
    expect(tc[0].function.arguments).toBe('{"city":"NYC"}');
  });
});

describe("routing", () => {
  it("returns 404 for GET /v1/chat/completions", async () => {
    instance = await createServer(allFixtures);
    const res = await get(`${instance.url}/v1/chat/completions`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for POST to unknown path", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/other/path`, { model: "gpt-4", messages: [] });
    expect(res.status).toBe(404);
  });

  it("routes POST /v1/messages to Claude handler", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 for GET /v1/messages", async () => {
    instance = await createServer(allFixtures);
    const res = await get(`${instance.url}/v1/messages`);
    expect(res.status).toBe(404);
  });

  it("routes POST to Gemini generateContent", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    expect(res.status).toBe(200);
  });

  it("routes POST to Gemini streamGenerateContent", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown Gemini-like path", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1beta/models/gemini-2.0-flash:unknownAction`, {
      contents: [],
    });
    expect(res.status).toBe(404);
  });
});

describe("CORS", () => {
  it("includes CORS headers on POST responses", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("handles OPTIONS preflight", async () => {
    instance = await createServer(allFixtures);
    const res = await options(`${instance.url}/v1/chat/completions`);

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("includes CORS headers on 404 responses", async () => {
    instance = await createServer(allFixtures);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "unknown" }],
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("GET /v1/_requests", () => {
  it("returns journal entries as JSON", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });

    const res = await get(`${instance.url}/v1/_requests`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const entries = JSON.parse(res.body);
    expect(entries).toHaveLength(1);
    expect(entries[0].body.messages[0].content).toBe("hello");
  });

  it("returns empty array when no requests recorded", async () => {
    instance = await createServer(allFixtures);
    const res = await get(`${instance.url}/v1/_requests`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("supports ?limit=N query parameter", async () => {
    instance = await createServer(allFixtures);
    const url = `${instance.url}/v1/chat/completions`;
    await post(url, { model: "gpt-4", messages: [{ role: "user", content: "hello" }] });
    await post(url, { model: "gpt-4", messages: [{ role: "user", content: "hello" }] });
    await post(url, { model: "gpt-4", messages: [{ role: "user", content: "hello" }] });

    const res = await get(`${instance.url}/v1/_requests?limit=2`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(2);
  });

  it("returns 400 for invalid limit parameter", async () => {
    instance = await createServer(allFixtures);
    const res = await get(`${instance.url}/v1/_requests?limit=abc`);
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("Invalid limit");
  });

  it("returns 400 for limit=0", async () => {
    instance = await createServer(allFixtures);
    const res = await get(`${instance.url}/v1/_requests?limit=0`);
    expect(res.status).toBe(400);
  });

  it("includes CORS headers", async () => {
    instance = await createServer(allFixtures);
    const res = await get(`${instance.url}/v1/_requests`);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("DELETE /v1/_requests", () => {
  it("clears the journal and returns 204", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(instance.journal.size).toBe(1);

    const delRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const parsed = new URL(`${instance!.url}/v1/_requests`);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "DELETE",
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(delRes.status).toBe(204);
    expect(instance.journal.size).toBe(0);
  });
});

describe("journal", () => {
  it("records successful requests", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.method).toBe("POST");
    expect(entry!.path).toBe("/v1/chat/completions");
    expect(entry!.body.model).toBe("gpt-4");
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.fixture).toBe(textFixture);
  });

  it("records unmatched requests with null fixture", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "nomatch" }],
    });

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(404);
    expect(entry!.response.fixture).toBeNull();
  });

  it("records error fixture requests", async () => {
    instance = await createServer(allFixtures);
    await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "fail" }],
    });

    const entry = instance.journal.getLast();
    expect(entry!.response.status).toBe(429);
    expect(entry!.response.fixture).toBe(errorFixture);
  });

  it("records multiple requests in order", async () => {
    instance = await createServer(allFixtures);
    const url = `${instance.url}/v1/chat/completions`;

    await post(url, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });
    await post(url, {
      model: "gpt-4",
      messages: [{ role: "user", content: "weather" }],
    });

    expect(instance.journal.size).toBe(2);
    const entries = instance.journal.getAll();
    expect(entries[0].response.fixture).toBe(textFixture);
    expect(entries[1].response.fixture).toBe(toolFixture);
  });

  it("captures request headers", async () => {
    instance = await createServer(allFixtures);
    await post(
      `${instance.url}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      },
      { Authorization: "Bearer sk-test" },
    );

    const entry = instance.journal.getLast();
    expect(entry!.headers["authorization"]).toBe("Bearer sk-test");
  });
});

describe("readBody error path", () => {
  it("returns 500 when the request body stream is destroyed mid-read", async () => {
    instance = await createServer(allFixtures);
    const parsed = new URL(instance.url);
    const port = parseInt(parsed.port, 10);

    // Open a raw TCP connection so we can control exactly what gets sent and
    // when the socket is destroyed. We advertise a Content-Length far larger
    // than the data we actually send, then destroy the socket. This causes
    // the async iterator in readBody() to emit an error (premature close).
    await new Promise<{ status: number; body: string }>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        const partialBody = '{"model":"gpt-4","mess';
        const headers = [
          "POST /v1/chat/completions HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Content-Type: application/json",
          `Content-Length: 1000`,
          "",
          "",
        ].join("\r\n");

        socket.write(headers);
        socket.write(partialBody);

        // Destroy after a brief delay so the server has started reading
        setTimeout(() => socket.destroy(), 20);
      });

      // The server should still send a response before the socket dies, but
      // since we destroyed the socket, we may or may not get the response
      // data. Collect what we can.
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("close", () => {
        // Parse the HTTP status from the raw response if we got one
        const statusMatch = data.match(/HTTP\/1\.1 (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        const bodyStart = data.indexOf("\r\n\r\n");
        const body = bodyStart >= 0 ? data.slice(bodyStart + 4) : "";
        resolve({ status, body });
      });
      socket.on("error", () => {
        // Socket errors are expected — we destroyed it intentionally
        resolve({ status: 0, body: "" });
      });
    });

    // The journal should have recorded the failed request regardless of
    // whether we received the response on the destroyed socket.
    // Give the server a moment to finish processing the error path.
    await new Promise((r) => setTimeout(r, 50));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.response.status).toBe(500);
    expect(entry!.response.fixture).toBeNull();
  });
});

describe("handleCompletions catch handler", () => {
  it("returns 500 JSON when predicate throws before headers are sent", async () => {
    const throwingFixture: Fixture = {
      match: {
        predicate: () => {
          throw new Error("boom");
        },
      },
      response: { content: "never reached" },
    };
    instance = await createServer([throwingFixture]);
    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "anything" }],
    });

    // The predicate throw is not caught inside matchFixture — it propagates
    // to handleCompletions and is caught by the .catch() handler. Since
    // headers haven't been sent yet, we get a 500 JSON response.
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("boom");
    expect(body.error.type).toBe("server_error");
  });

  it("server stays alive after client disconnects mid-SSE-stream", async () => {
    const slowFixture: Fixture = {
      match: { userMessage: "slow" },
      response: { content: "A".repeat(200) },
      latency: 30,
      chunkSize: 10,
    };
    const quickFixture: Fixture = {
      match: { userMessage: "quick" },
      response: { content: "done" },
    };
    instance = await createServer([slowFixture, quickFixture]);
    const parsed = new URL(instance.url);

    // Start a request that will take a while to stream, then abort it
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(
              JSON.stringify({
                model: "gpt-4",
                messages: [{ role: "user", content: "slow" }],
              }),
            ),
          },
        },
        (res) => {
          // Read a bit then destroy
          res.once("data", () => {
            req.destroy();
            // Give the server a moment to handle the disconnect
            setTimeout(resolve, 100);
          });
        },
      );
      req.on("error", () => {
        // Expected — we destroyed the request
      });
      req.write(
        JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "slow" }],
        }),
      );
      req.end();
    });

    // The server should still be alive and functional
    expect(instance.server.listening).toBe(true);

    const res = await post(`${instance.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "quick" }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("data: [DONE]");
  });
});

describe("concurrent request handling", () => {
  it("handles 10 parallel requests correctly", async () => {
    const concurrentFixture: Fixture = {
      match: { userMessage: "concurrent" },
      response: { content: "Hello from concurrent!" },
      latency: 50,
    };
    instance = await createServer([concurrentFixture]);
    const url = `${instance.url}/v1/chat/completions`;
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "concurrent" }],
    };

    // Fire 10 requests in parallel
    const results = await Promise.all(Array.from({ length: 10 }, () => post(url, body)));

    // All 10 should succeed as valid SSE streams
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/event-stream");
      expect(res.body).toContain("data: [DONE]");

      const events = parseSSEEvents(res.body);
      expect(events.length).toBeGreaterThanOrEqual(3);

      // First event has role
      const first = events[0] as {
        choices: [{ delta: { role?: string } }];
      };
      expect(first.choices[0].delta.role).toBe("assistant");

      // Last event has finish_reason
      const last = events[events.length - 1] as {
        choices: [{ finish_reason: string | null }];
      };
      expect(last.choices[0].finish_reason).toBe("stop");
    }

    // Journal should have exactly 10 entries
    expect(instance.journal.size).toBe(10);
    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(10);
    for (const entry of entries) {
      expect(entry.response.status).toBe(200);
      expect(entry.response.fixture).toBe(concurrentFixture);
    }
  });
});

describe("header forwarding in journal", () => {
  it("captures custom headers in journal entries", async () => {
    instance = await createServer(allFixtures);
    await post(
      `${instance.url}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      },
      {
        Authorization: "Bearer test-key",
        "X-Custom-Header": "custom-value",
      },
    );

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.headers["authorization"]).toBe("Bearer test-key");
    expect(entry!.headers["x-custom-header"]).toBe("custom-value");
    expect(entry!.headers["content-type"]).toBe("application/json");
  });

  it("captures standard headers (host, content-length) in journal entries", async () => {
    instance = await createServer(allFixtures);
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    };
    await post(`${instance.url}/v1/chat/completions`, body);

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.headers["host"]).toBeDefined();
    expect(entry!.headers["content-length"]).toBe(String(Buffer.byteLength(JSON.stringify(body))));
    expect(entry!.headers["content-type"]).toBe("application/json");
  });

  it("headers are visible through the GET /v1/_requests endpoint", async () => {
    instance = await createServer(allFixtures);
    await post(
      `${instance.url}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      },
      {
        Authorization: "Bearer api-key-123",
        "X-Request-Id": "req-abc-def",
      },
    );

    const res = await get(`${instance.url}/v1/_requests`);
    expect(res.status).toBe(200);

    const entries = JSON.parse(res.body);
    expect(entries).toHaveLength(1);
    expect(entries[0].headers["authorization"]).toBe("Bearer api-key-123");
    expect(entries[0].headers["x-request-id"]).toBe("req-abc-def");
    expect(entries[0].headers["content-type"]).toBe("application/json");
    expect(entries[0].headers["host"]).toBeDefined();
    expect(entries[0].headers["content-length"]).toBeDefined();
  });

  it("records headers from multiple sequential requests independently", async () => {
    instance = await createServer(allFixtures);
    const url = `${instance.url}/v1/chat/completions`;
    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    };

    await post(url, body, { Authorization: "Bearer key-one" });
    await post(url, body, { Authorization: "Bearer key-two" });

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].headers["authorization"]).toBe("Bearer key-one");
    expect(entries[1].headers["authorization"]).toBe("Bearer key-two");
  });
});
