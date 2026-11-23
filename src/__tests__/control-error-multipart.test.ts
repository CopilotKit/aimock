import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture, ChatCompletionRequest } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { LLMock } from "../llmock.js";
import { extractBoundary, extractFormField } from "../transcription.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpRequest(
  url: string,
  method: string,
  body?: object | RawBody,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    // A raw wrapper sends the string verbatim. `JSON.stringify(null)` would be
    // dropped by a truthiness check, so a literal `null` payload — the only
    // way to reach the top-level null guard over HTTP — needs this door.
    const data =
      body instanceof RawBody ? body.text : body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function postMultipart(
  url: string,
  contentType: string,
  rawBody: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": Buffer.byteLength(rawBody),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

function chatRequest(content: string): ChatCompletionRequest {
  return { model: "gpt-4", stream: false, messages: [{ role: "user", content }] };
}

function multipartBody(boundary: string, fields: Record<string, string>): string {
  let out = "";
  for (const [name, value] of Object.entries(fields)) {
    out += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  out += `--${boundary}--\r\n`;
  return out;
}

/** Marker wrapper: send this exact string as the request body. */
class RawBody {
  constructor(readonly text: string) {}
}

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

// ---------------------------------------------------------------------------
// extractBoundary — quoted-string handling
// ---------------------------------------------------------------------------

describe("extractBoundary", () => {
  it("returns undefined for missing/empty content types", () => {
    expect(extractBoundary(undefined)).toBeUndefined();
    expect(extractBoundary("multipart/form-data")).toBeUndefined();
    expect(extractBoundary("")).toBeUndefined();
  });

  it("extracts bare boundaries", () => {
    expect(extractBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
    expect(extractBoundary("multipart/form-data; boundary=----WebKitFormBoundaryXYZ")).toBe(
      "----WebKitFormBoundaryXYZ",
    );
  });

  it("strips double quotes (RFC 2046 quoted-string)", () => {
    expect(extractBoundary('multipart/form-data; boundary="abc123"')).toBe("abc123");
    expect(extractBoundary('multipart/form-data; boundary="----WebKitFormBoundaryXYZ"')).toBe(
      "----WebKitFormBoundaryXYZ",
    );
  });

  it("reads a quoted boundary containing a space (RFC 2046 bchars)", () => {
    // The case quoting is MANDATORY for: `bchars := bcharsnospace / " "`.
    expect(extractBoundary('multipart/form-data; boundary="gc0pJq0M 08jU534c0p"')).toBe(
      "gc0pJq0M 08jU534c0p",
    );
    expect(extractBoundary('multipart/form-data; boundary="a b c"; charset=utf-8')).toBe("a b c");
  });

  it("keeps apostrophes — a single quote is a legal token char, not a quote", () => {
    // RFC 2045 token / RFC 2046 bcharsnospace both admit "'". `boundary='abc'`
    // means the delimiter literally is `--'abc'`.
    expect(extractBoundary("multipart/form-data; boundary='abc123'")).toBe("'abc123'");
    expect(extractBoundary("multipart/form-data; boundary=a'b")).toBe("a'b");
  });

  it("tolerates LWSP and uppercase, and ignores a decoy 'myboundary=' parameter", () => {
    expect(extractBoundary("multipart/form-data; boundary = abc123")).toBe("abc123");
    expect(extractBoundary("multipart/form-data; BOUNDARY=abc123")).toBe("abc123");
    expect(extractBoundary("multipart/form-data; myboundary=WRONG; boundary=RIGHT")).toBe("RIGHT");
  });

  it("ignores trailing parameters after the boundary", () => {
    expect(extractBoundary("multipart/form-data; boundary=abc123; charset=utf-8")).toBe("abc123");
    expect(extractBoundary('multipart/form-data; boundary="abc123"; charset=utf-8')).toBe("abc123");
  });

  it("returns undefined for empty quoted boundaries", () => {
    expect(extractBoundary('multipart/form-data; boundary=""')).toBeUndefined();
  });

  it("round-trips through extractFormField", () => {
    const raw = multipartBody("abc123", { model: "gpt-4o-transcribe", stream: "true" });
    const quoted = extractBoundary('multipart/form-data; boundary="abc123"');
    expect(quoted).toBe("abc123");
    expect(extractFormField(raw, "model", quoted)).toBe("gpt-4o-transcribe");
    expect(extractFormField(raw, "stream", quoted)).toBe("true");
  });

  it("round-trips a space-bearing quoted boundary through extractFormField", () => {
    const raw = multipartBody("a b c", { model: "gpt-4o-transcribe" });
    const boundary = extractBoundary('multipart/form-data; boundary="a b c"');
    expect(boundary).toBe("a b c");
    expect(extractFormField(raw, "model", boundary)).toBe("gpt-4o-transcribe");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/audio/transcriptions with quoted boundaries (HTTP)
// ---------------------------------------------------------------------------

describe("transcription with quoted multipart boundary", () => {
  const fixtures: Fixture[] = [
    {
      match: { model: "gpt-4o-transcribe" },
      response: { transcription: { text: "quoted hello" } },
    },
  ];

  it("routes quoted-boundary requests to the right model fixture", async () => {
    instance = await createServer(fixtures);
    const raw = multipartBody("abc123", { model: "gpt-4o-transcribe" });
    const res = await postMultipart(
      `${instance.url}/v1/audio/transcriptions`,
      'multipart/form-data; boundary="abc123"',
      raw,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain("quoted hello");
  });

  it("keeps working with bare boundaries (no regression)", async () => {
    instance = await createServer(fixtures);
    const raw = multipartBody("abc123", { model: "gpt-4o-transcribe" });
    const res = await postMultipart(
      `${instance.url}/v1/audio/transcriptions`,
      "multipart/form-data; boundary=abc123",
      raw,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain("quoted hello");
  });

  it("routes a quoted boundary containing a space", async () => {
    instance = await createServer(fixtures);
    const raw = multipartBody("a b c", { model: "gpt-4o-transcribe" });
    const res = await postMultipart(
      `${instance.url}/v1/audio/transcriptions`,
      'multipart/form-data; boundary="a b c"',
      raw,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain("quoted hello");
  });

  it("routes a bare boundary wrapped in apostrophes (legal token chars)", async () => {
    instance = await createServer(fixtures);
    const raw = multipartBody("'abc123'", { model: "gpt-4o-transcribe" });
    const res = await postMultipart(
      `${instance.url}/v1/audio/transcriptions`,
      "multipart/form-data; boundary='abc123'",
      raw,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain("quoted hello");
  });

  it("journals the parsed model (not the whisper-1 fallback)", async () => {
    instance = await createServer(fixtures);
    const raw = multipartBody("abc123", { model: "gpt-4o-transcribe" });
    await postMultipart(
      `${instance.url}/v1/audio/transcriptions`,
      'multipart/form-data; boundary="abc123"',
      raw,
    );
    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect((entry!.body as ChatCompletionRequest).model).toBe("gpt-4o-transcribe");
  });
});

// ---------------------------------------------------------------------------
// POST /__aimock/error — status/body validation
// ---------------------------------------------------------------------------

describe("POST /__aimock/error validation", () => {
  // Fresh fixtures per test: queueing unshifts a one-shot entry into the
  // passed array, so sharing one array across tests would leak state.
  const makeFixtures = (): Fixture[] => [
    { match: { userMessage: "hello" }, response: { content: "Hi" } },
  ];

  async function chatHello(): Promise<{ status: number; body: string }> {
    return httpRequest(`${instance!.url}/v1/chat/completions`, "POST", chatRequest("hello"));
  }

  it("rejects out-of-range and non-integer statuses", async () => {
    instance = await createServer(makeFixtures());
    // 1xx is rejected because it HANGS the next request rather than throwing;
    // 404.5 is in range but fractional, so only Number.isInteger catches it.
    for (const status of [99, 0, -1, 100, 101, 199, 1000, 99.5, 404.5]) {
      const res = await httpRequest(`${instance.url}/__aimock/error`, "POST", { status });
      expect(res.status).toBe(400);
      expect(res.body).toContain("status");
    }
    // Nothing was queued — normal traffic still works
    const ok = await chatHello();
    expect(ok.status).toBe(200);
  });

  it("rejects non-numeric statuses", async () => {
    instance = await createServer(makeFixtures());
    for (const status of ["500", true, {}, [500]]) {
      const res = await httpRequest(`${instance.url}/__aimock/error`, "POST", { status });
      expect(res.status).toBe(400);
    }
    const ok = await chatHello();
    expect(ok.status).toBe(200);
  });

  it("rejects non-object bodies and non-string body fields", async () => {
    instance = await createServer(makeFixtures());
    const badBodies: unknown[] = ["oops", 42, [1], { message: 42 }, { type: 7 }, { code: {} }];
    for (const body of badBodies) {
      const res = await httpRequest(`${instance.url}/__aimock/error`, "POST", {
        status: 500,
        body,
      });
      expect(res.status).toBe(400);
    }
    const ok = await chatHello();
    expect(ok.status).toBe(200);
  });

  it("rejects non-object top-level JSON (literal null / array)", async () => {
    instance = await createServer([]);
    // The literal string "null" is sent raw: it parses to `null`, which is the
    // ONLY input that reaches the top-level null guard (an omitted body fails
    // earlier, in JSON.parse("")).
    const nullRes = await httpRequest(
      `${instance.url}/__aimock/error`,
      "POST",
      new RawBody("null"),
    );
    expect(nullRes.status).toBe(400);
    expect(nullRes.body).toContain("expected a JSON object");
    const arrayRes = await httpRequest(`${instance.url}/__aimock/error`, "POST", []);
    expect(arrayRes.status).toBe(400);
    expect(arrayRes.body).toContain("expected a JSON object");
  });

  it("accepts null for status and for body fields (an absent optional)", async () => {
    instance = await createServer(makeFixtures());
    // `status: null` keeps the historic `?? 500`.
    const queued = await httpRequest(`${instance.url}/__aimock/error`, "POST", { status: null });
    expect(queued.status).toBe(200);
    expect((await chatHello()).status).toBe(500);
  });

  it("accepts a null body — an absent body, not a malformed one", async () => {
    instance = await createServer(makeFixtures());
    const queued = await httpRequest(`${instance.url}/__aimock/error`, "POST", {
      status: 429,
      body: null,
    });
    expect(queued.status).toBe(200);
    const errRes = await chatHello();
    expect(errRes.status).toBe(429);
    expect(errRes.body).toContain("Injected error");
  });

  it("accepts aimock's own error envelope verbatim (code: null)", async () => {
    instance = await createServer(makeFixtures());
    // `serializeErrorResponse` emits `code: null` / `param: null`, and so does
    // a real OpenAI error — pasting a captured body back in must work.
    const queued = await httpRequest(`${instance.url}/__aimock/error`, "POST", {
      status: 429,
      body: { message: "Rate limit", type: "rate_limit_error", param: null, code: null },
    });
    expect(queued.status).toBe(200);
    const errRes = await chatHello();
    expect(errRes.status).toBe(429);
    const parsed = JSON.parse(errRes.body) as { error: { message: string; code: string | null } };
    expect(parsed.error.message).toBe("Rate limit");
    expect(parsed.error.code).toBeNull();
  });

  it("still queues valid errors incl. boundary statuses 200 and 999", async () => {
    // 600-999 is unassigned, not invalid: Node sends it and a client sees it,
    // and a mock server is the one place those codes are legitimate.
    for (const status of [200, 418, 599, 600, 999]) {
      instance = await createServer(makeFixtures());
      const queueRes = await httpRequest(`${instance.url}/__aimock/error`, "POST", {
        status,
        body: { message: "custom", type: "custom_type" },
      });
      expect(queueRes.status).toBe(200);
      const errRes = await chatHello();
      expect(errRes.status).toBe(status);
      await new Promise<void>((resolve) => {
        instance!.server.close(() => resolve());
      });
      instance = null;
    }
  });

  it("queues the default 500 error when status is omitted", async () => {
    instance = await createServer(makeFixtures());
    const queueRes = await httpRequest(`${instance.url}/__aimock/error`, "POST", {});
    expect(queueRes.status).toBe(200);
    const errRes = await chatHello();
    expect(errRes.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// The other two doors to the same res.writeHead(status)
// ---------------------------------------------------------------------------

describe("injected-status validation reaches every sink", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("LLMock.nextRequestError — the documented path — is guarded too", async () => {
    mock = new LLMock();
    mock.onMessage("hello", { content: "Hi!" });
    await mock.start();
    // Pre-fix: 99 silently produced a generic 500 (writeHead threw and the
    // injected error was lost) and 100 hung the request until client timeout.
    for (const status of [99, 0, 100, 199, 1000, 404.5]) {
      expect(() => mock!.nextRequestError(status, { message: "boom" })).toThrow(RangeError);
    }
    mock.nextRequestError(999, { message: "boom" });
    const res = await httpRequest(`${mock.url}/v1/chat/completions`, "POST", chatRequest("hello"));
    expect(res.status).toBe(999);
    expect(res.body).toContain("boom");
  });

  it("POST /__aimock/fixtures rejects a 1xx error status and accepts an unassigned one", async () => {
    instance = await createServer([]);
    const addFixture = (status: number) =>
      httpRequest(`${instance!.url}/__aimock/fixtures`, "POST", {
        fixtures: [
          { match: { userMessage: "hello" }, response: { error: { message: "boom" }, status } },
        ],
      });

    // 1xx used to pass fixture validation (its range was 100-599) and hang.
    const hangy = await addFixture(100);
    expect(hangy.status).toBe(400);
    expect(hangy.body).toContain("not a valid HTTP status code");

    const tooBig = await addFixture(1000);
    expect(tooBig.status).toBe(400);

    // 600-999 used to be rejected by fixture validation while the same value
    // worked over HTTP. Both doors now agree.
    const unassigned = await addFixture(742);
    expect(unassigned.status).toBe(200);
    const res = await httpRequest(
      `${instance.url}/v1/chat/completions`,
      "POST",
      chatRequest("hello"),
    );
    expect(res.status).toBe(742);
  });
});
