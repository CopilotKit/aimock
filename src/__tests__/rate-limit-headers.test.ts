import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LLMock } from "../llmock.js";
import { writeErrorResponse } from "../sse-writer.js";
import { PassThrough } from "node:stream";
import type * as http from "node:http";

// ---------------------------------------------------------------------------
// Unit tests for writeErrorResponse rate limit headers
// ---------------------------------------------------------------------------

function makeMockResponse(): {
  res: http.ServerResponse;
  headers: () => Record<string, string | string[] | number | undefined>;
  status: () => number | undefined;
  output: () => string;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  const writtenHeaders: Record<string, string | string[] | number | undefined> = {};
  let writtenStatus: number | undefined;

  const res = {
    writeHead(statusCode: number, headers?: Record<string, string>) {
      writtenStatus = statusCode;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          writtenHeaders[k] = v;
        }
      }
    },
    write(data: string) {
      stream.write(data);
    },
    end(data?: string) {
      if (data !== undefined) {
        stream.write(data);
      }
      stream.end();
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    headers: () => writtenHeaders,
    status: () => writtenStatus,
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("writeErrorResponse rate limit headers (unit)", () => {
  it("adds rate limit headers on 429 responses", () => {
    const { res, headers } = makeMockResponse();
    writeErrorResponse(res, 429, JSON.stringify({ error: { message: "Rate limited" } }));

    const h = headers();
    expect(h["Retry-After"]).toBe("1");
    expect(h["x-ratelimit-limit-requests"]).toBe("60");
    expect(h["x-ratelimit-limit-tokens"]).toBe("150000");
    expect(h["x-ratelimit-remaining-requests"]).toBe("0");
    expect(h["x-ratelimit-remaining-tokens"]).toBe("0");
    expect(h["x-ratelimit-reset-requests"]).toBe("1s");
    expect(h["x-ratelimit-reset-tokens"]).toBe("6m0s");
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("uses custom retryAfter value when provided", () => {
    const { res, headers } = makeMockResponse();
    writeErrorResponse(res, 429, JSON.stringify({ error: { message: "Rate limited" } }), {
      retryAfter: 5,
    });

    expect(headers()["Retry-After"]).toBe("5");
  });

  it("does NOT add rate limit headers on non-429 errors", () => {
    const { res, headers } = makeMockResponse();
    writeErrorResponse(res, 500, JSON.stringify({ error: { message: "Server error" } }));

    const h = headers();
    expect(h["Retry-After"]).toBeUndefined();
    expect(h["x-ratelimit-limit-requests"]).toBeUndefined();
    expect(h["x-ratelimit-remaining-requests"]).toBeUndefined();
  });

  it("does NOT add rate limit headers on 400 errors", () => {
    const { res, headers } = makeMockResponse();
    writeErrorResponse(res, 400, JSON.stringify({ error: { message: "Bad request" } }));

    const h = headers();
    expect(h["Retry-After"]).toBeUndefined();
    expect(h["x-ratelimit-limit-requests"]).toBeUndefined();
  });

  it("does NOT add rate limit headers on 404 errors", () => {
    const { res, headers } = makeMockResponse();
    writeErrorResponse(res, 404, JSON.stringify({ error: { message: "Not found" } }));

    const h = headers();
    expect(h["Retry-After"]).toBeUndefined();
    expect(h["x-ratelimit-limit-requests"]).toBeUndefined();
  });

  it("still writes the body correctly on 429", () => {
    const { res, output } = makeMockResponse();
    const body = JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } });
    writeErrorResponse(res, 429, body);
    expect(output()).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Integration tests via LLMock
// ---------------------------------------------------------------------------

describe("rate limit headers via LLMock (integration)", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("429 error fixture includes rate limit headers", async () => {
    mock.reset();
    mock.on(
      { userMessage: "rate-limit-test" },
      {
        error: { message: "Rate limited", type: "rate_limit_error", code: "rate_limit" },
        status: 429,
      },
    );

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "rate-limit-test" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.headers.get("x-ratelimit-limit-requests")).toBe("60");
    expect(res.headers.get("x-ratelimit-limit-tokens")).toBe("150000");
    expect(res.headers.get("x-ratelimit-remaining-requests")).toBe("0");
    expect(res.headers.get("x-ratelimit-remaining-tokens")).toBe("0");
    expect(res.headers.get("x-ratelimit-reset-requests")).toBe("1s");
    expect(res.headers.get("x-ratelimit-reset-tokens")).toBe("6m0s");

    // Body should still have the error
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.message).toBe("Rate limited");
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("429 with custom retryAfter uses override value", async () => {
    mock.reset();
    mock.on(
      { userMessage: "retry-after-override" },
      {
        error: { message: "Rate limited", type: "rate_limit_error" },
        status: 429,
        retryAfter: 30,
      },
    );

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "retry-after-override" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    // Other rate limit headers should still be present
    expect(res.headers.get("x-ratelimit-limit-requests")).toBe("60");
  });

  it("non-429 error does NOT include rate limit headers", async () => {
    mock.reset();
    mock.on(
      { userMessage: "server-error-test" },
      {
        error: { message: "Internal error", type: "server_error" },
        status: 500,
      },
    );

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "server-error-test" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.headers.get("x-ratelimit-limit-requests")).toBeNull();
    expect(res.headers.get("x-ratelimit-remaining-requests")).toBeNull();
  });

  it("429 on Anthropic messages endpoint includes rate limit headers", async () => {
    mock.reset();
    mock.on(
      { userMessage: "anthropic-rate-limit" },
      {
        error: { message: "Rate limited", type: "rate_limit_error" },
        status: 429,
      },
    );

    const res = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 100,
        messages: [{ role: "user", content: "anthropic-rate-limit" }],
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.headers.get("x-ratelimit-limit-requests")).toBe("60");
  });

  it("retryAfter field is not included in response body", async () => {
    mock.reset();
    mock.on(
      { userMessage: "no-retry-in-body" },
      {
        error: { message: "Rate limited", type: "rate_limit_error" },
        status: 429,
        retryAfter: 10,
      },
    );

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "no-retry-in-body" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).not.toContain("retryAfter");
    expect(text).not.toContain("retry_after");
  });
});
