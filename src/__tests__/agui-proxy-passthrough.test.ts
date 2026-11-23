import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGUIMock } from "../agui-mock.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// AG-UI proxy/record passthrough fidelity.
//
// The recorder used to rebuild the upstream request from scratch: it copied a
// hand-picked allowlist of two auth headers and re-serialized the parsed body.
// Any runtime whose contract lives in headers (session affinity, per-request
// agent configuration) lost it on the hop, and any caller that signed the
// payload (AWS SigV4 hashes the body) had its signature invalidated by the
// re-serialization. These tests pin the fixed behavior: inbound headers reach
// the upstream, and the body arrives byte-for-byte.
// ---------------------------------------------------------------------------

let upstream: http.Server | undefined;
let agui: AGUIMock | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (agui) {
    try {
      await agui.stop();
    } catch {
      /* already stopped */
    }
    agui = undefined;
  }
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  vi.restoreAllMocks();
});

interface Captured {
  headers: http.IncomingHttpHeaders;
  rawBody: string;
}

/** An upstream that captures exactly what it received, then answers with SSE. */
function createEchoUpstream(captured: Captured[]): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString() });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "ok" })}\n\n`,
        );
        res.end();
      });
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** POST a raw body with arbitrary headers and drain the response. */
function post(
  url: string,
  rawBody: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: { "Content-Length": Buffer.byteLength(rawBody), ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

async function startProxy(upstreamUrl: string): Promise<AGUIMock> {
  const mock = new AGUIMock({ port: 0, logLevel: "error" });
  mock.enableRecording({ upstream: upstreamUrl, proxyOnly: true });
  await mock.start();
  return mock;
}

describe("AG-UI proxy passthrough", () => {
  it("forwards arbitrary inbound headers to the upstream agent", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    const body = JSON.stringify({
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "u1", role: "user", content: "hello" }],
    });

    const resp = await post(agui.url, body, {
      "Content-Type": "application/json",
      Authorization: "Bearer token-123",
      "x-api-key": "key-123",
      "x-runtime-session-id": "session-abc",
      "x-runtime-agent-config": "cfg-xyz",
      "x-custom-tenant": "acme",
    });

    expect(resp.status).toBe(200);
    expect(captured).toHaveLength(1);

    const received = captured[0].headers;
    expect(received["authorization"]).toBe("Bearer token-123");
    expect(received["x-api-key"]).toBe("key-123");
    expect(received["x-runtime-session-id"]).toBe("session-abc");
    expect(received["x-runtime-agent-config"]).toBe("cfg-xyz");
    expect(received["x-custom-tenant"]).toBe("acme");
  });

  it("forwards the request body byte-for-byte", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    // Deliberately non-canonical JSON: unusual key order, extra whitespace, and
    // an unrecognized top-level field. Re-serializing from the parsed object
    // would normalize all three and change the payload hash.
    const body =
      '{\n  "runId":   "r1",\n  "threadId": "t1",\n  "vendorExtension": {"nested": [1, 2, 3]},\n  "messages": [{"id": "u1", "role": "user", "content": "hello"}]\n}';

    const resp = await post(agui.url, body, { "Content-Type": "application/json" });

    expect(resp.status).toBe(200);
    expect(captured[0].rawBody).toBe(body);
    expect(captured[0].headers["content-length"]).toBe(String(Buffer.byteLength(body)));
  });

  it("does not override the Content-Type the caller set", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    const body = JSON.stringify({ threadId: "t1", runId: "r1", messages: [] });
    await post(agui.url, body, { "Content-Type": "application/json; charset=utf-8" });

    expect(captured[0].headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("forces Accept to text/event-stream even when the caller sent a generic one", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    const body = JSON.stringify({ threadId: "t1", runId: "r1", messages: [] });
    // curl's and axios's defaults. Forwarding either lets a content-negotiating
    // upstream answer with JSON, which relays mislabelled and records empty.
    await post(agui.url, body, {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    });

    expect(captured[0].headers["accept"]).toBe("text/event-stream");
  });

  it("supplies content negotiation defaults when the caller omits them", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    const body = JSON.stringify({ threadId: "t1", runId: "r1", messages: [] });
    await post(agui.url, body, {});

    expect(captured[0].headers["content-type"]).toBe("application/json");
    expect(captured[0].headers["accept"]).toBe("text/event-stream");
  });

  it("strips hop-by-hop and proxy-owned headers", async () => {
    const captured: Captured[] = [];
    const upstreamUrl = await createEchoUpstream(captured);
    agui = await startProxy(upstreamUrl);

    const body = JSON.stringify({ threadId: "t1", runId: "r1", messages: [] });
    await post(agui.url, body, {
      "Content-Type": "application/json",
      "x-test-id": "internal-only",
      "x-aimock-strict": "1",
      "x-aimock-context": "suite-a",
      "x-aimock-chaos-latency-ms": "250",
      "accept-encoding": "gzip",
      cookie: "session=nope",
    });

    const received = captured[0].headers;
    expect(received["x-test-id"]).toBeUndefined();
    expect(received["x-aimock-strict"]).toBeUndefined();
    expect(received["x-aimock-context"]).toBeUndefined();
    expect(received["x-aimock-chaos-latency-ms"]).toBeUndefined();
    expect(received["accept-encoding"]).toBeUndefined();
    expect(received["cookie"]).toBeUndefined();
    // The upstream host is the proxy target's, never the inbound one.
    expect(received["host"]).toBe(new URL(upstreamUrl).host);
  });
});

// ---------------------------------------------------------------------------
// Recording refusal.
//
// The recorder can only build a fixture from an event stream. A 2xx upstream
// that answered with something else — or with a stream holding no parseable
// AG-UI events — used to be written to disk as `"events": []`. That fixture
// MATCHES on replay and streams nothing, with no fixture-miss log and no parse
// warning, so the failure surfaces as a silently empty agent turn. Both cases
// must relay to the client and refuse the recording, loudly.
// ---------------------------------------------------------------------------

/** An upstream that answers 200 with the given content type and body. */
function createNonSSEUpstream(contentType: string, body: string): Promise<string> {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": contentType });
        res.end(body);
      });
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("AG-UI proxy recording refusal", () => {
  async function runAgainst(upstreamUrl: string): Promise<{ errors: string[]; files: string[] }> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agui-refusal-"));
    const errors: string[] = [];
    vi.spyOn(Logger.prototype, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    agui = new AGUIMock({ port: 0, logLevel: "error" });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const body = JSON.stringify({
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "u1", role: "user", content: "hi" }],
    });
    const resp = await post(agui.url, body, { "Content-Type": "application/json" });
    expect(resp.status).toBe(200);

    return { errors, files: fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json")) };
  }

  it("refuses to record a 2xx upstream that did not answer with an event stream", async () => {
    const upstreamUrl = await createNonSSEUpstream(
      "application/json",
      JSON.stringify({ message: "negotiated down to JSON" }),
    );

    const { errors, files } = await runAgainst(upstreamUrl);

    expect(files).toHaveLength(0);
    expect(errors.some((e) => /not text\/event-stream/i.test(e))).toBe(true);
  });

  it("refuses to record an event stream that yielded no parseable events", async () => {
    // Correct content type, but nothing the SSE parser can turn into an event.
    const upstreamUrl = await createNonSSEUpstream("text/event-stream", ": keep-alive\n\n");

    const { errors, files } = await runAgainst(upstreamUrl);

    expect(files).toHaveLength(0);
    expect(errors.some((e) => /no parseable AG-UI events/i.test(e))).toBe(true);
  });
});
