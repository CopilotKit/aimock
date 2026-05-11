import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { resolveStrictMode } from "../helpers.js";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture, ChatCompletionRequest } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: object,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function chatRequest(userContent: string): ChatCompletionRequest {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: userContent }],
  };
}

// ---------------------------------------------------------------------------
// Unit tests: resolveStrictMode
// ---------------------------------------------------------------------------

describe("resolveStrictMode", () => {
  it("returns server default when no header", () => {
    expect(resolveStrictMode(false)).toBe(false);
    expect(resolveStrictMode(true)).toBe(true);
    expect(resolveStrictMode(undefined)).toBe(false);
  });

  it("returns server default when headers are empty", () => {
    expect(resolveStrictMode(false, {})).toBe(false);
    expect(resolveStrictMode(true, {})).toBe(true);
  });

  it('header "true" overrides server default false', () => {
    expect(resolveStrictMode(false, { "x-aimock-strict": "true" })).toBe(true);
  });

  it('header "1" overrides server default false', () => {
    expect(resolveStrictMode(false, { "x-aimock-strict": "1" })).toBe(true);
  });

  it('header "false" overrides server default true', () => {
    expect(resolveStrictMode(true, { "x-aimock-strict": "false" })).toBe(false);
  });

  it('header "0" overrides server default true', () => {
    expect(resolveStrictMode(true, { "x-aimock-strict": "0" })).toBe(false);
  });

  it("ignores unrecognised header values and falls back to server default", () => {
    expect(resolveStrictMode(true, { "x-aimock-strict": "yes" })).toBe(true);
    expect(resolveStrictMode(false, { "x-aimock-strict": "maybe" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: per-request strict header
// ---------------------------------------------------------------------------

describe("X-AIMock-Strict header integration", () => {
  let server: ServerInstance;
  const helloFixture: Fixture = {
    match: { userMessage: "hello" },
    response: { content: "Hi there!" },
  };

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.server.close(() => resolve()));
    }
  });

  it("server with --strict + header false returns 404 not 503", async () => {
    server = await createServer([helloFixture], { port: 0, strict: true });
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("unmatched"), {
      "X-AIMock-Strict": "false",
    });
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
  });

  it("server without --strict + header true returns 503 not 404", async () => {
    server = await createServer([helloFixture], { port: 0 });
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("unmatched"), {
      "X-AIMock-Strict": "true",
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
  });

  it("header works on chat completions endpoint with matched fixture", async () => {
    server = await createServer([helloFixture], { port: 0 });
    // Header should not affect matched requests — fixture still serves
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("hello"), {
      "X-AIMock-Strict": "true",
    });
    expect(res.status).toBe(200);
  });

  it("header 1 enables strict mode", async () => {
    server = await createServer([helloFixture], { port: 0 });
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("unmatched"), {
      "X-AIMock-Strict": "1",
    });
    expect(res.status).toBe(503);
  });

  it("header 0 disables strict mode", async () => {
    server = await createServer([helloFixture], { port: 0, strict: true });
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("unmatched"), {
      "X-AIMock-Strict": "0",
    });
    expect(res.status).toBe(404);
  });

  it("absent header falls back to server default", async () => {
    // No header at all — server default (strict: true) applies
    server = await createServer([helloFixture], { port: 0, strict: true });
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("unmatched"));
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
  });

  it("absent header falls back to server default (non-strict)", async () => {
    // No header at all — server default (strict: false) applies
    server = await createServer([helloFixture], { port: 0 });
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("unmatched"));
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("No fixture matched");
  });
});
