import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let upstream: ServerInstance | undefined;
let recorder: ServerInstance | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (recorder) {
    await new Promise<void>((resolve) => recorder!.server.close(() => resolve()));
    recorder = undefined;
  }
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.server.close(() => resolve()));
    upstream = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spin up an upstream llmock + a recording proxy pointed at it. */
async function setupProxyOnly(
  upstreamFixtures: Fixture[],
  proxyOnly: boolean,
): Promise<{ upstreamUrl: string; recorderUrl: string; fixturePath: string }> {
  upstream = await createServer(upstreamFixtures, { port: 0 });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-proxy-only-"));

  recorder = await createServer([], {
    port: 0,
    record: {
      providers: { openai: upstream.url },
      fixturePath: tmpDir,
      proxyOnly,
    },
  });

  return {
    upstreamUrl: upstream.url,
    recorderUrl: recorder.url,
    fixturePath: tmpDir,
  };
}

/**
 * Spin up a counting HTTP server that tracks how many requests it receives
 * and always returns the same OpenAI-shaped chat completion response.
 */
function createCountingUpstream(
  responseContent: string,
): Promise<{ server: http.Server; url: string; getCount: () => number }> {
  return new Promise((resolve) => {
    let count = 0;
    const server = http.createServer((_req, res) => {
      count++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-counting",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: responseContent },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        getCount: () => count,
      });
    });
  });
}

const CHAT_REQUEST = {
  model: "gpt-4",
  messages: [{ role: "user", content: "What is the capital of France?" }],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proxy-only mode", () => {
  it("proxies and returns upstream response", async () => {
    const { recorderUrl } = await setupProxyOnly(
      [
        {
          match: { userMessage: "capital of France" },
          response: { content: "Paris is the capital of France." },
        },
      ],
      true,
    );

    const resp = await post(`${recorderUrl}/v1/chat/completions`, CHAT_REQUEST);

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.choices[0].message.content).toBe("Paris is the capital of France.");
  });

  it("does NOT write fixture files to disk", async () => {
    const { recorderUrl, fixturePath } = await setupProxyOnly(
      [
        {
          match: { userMessage: "capital of France" },
          response: { content: "Paris is the capital of France." },
        },
      ],
      true,
    );

    await post(`${recorderUrl}/v1/chat/completions`, CHAT_REQUEST);

    // The fixture directory might not even be created, or if it exists it should be empty
    if (fs.existsSync(fixturePath)) {
      const files = fs.readdirSync(fixturePath);
      const fixtureFiles = files.filter((f) => f.endsWith(".json"));
      expect(fixtureFiles).toHaveLength(0);
    }
    // If the directory doesn't exist, that's also correct — no writes happened
  });

  it("does NOT cache in memory — every request hits upstream", async () => {
    // Use a counting upstream to verify both requests are proxied
    const countingUpstream = await createCountingUpstream("counted response");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-proxy-only-cache-"));

    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: countingUpstream.url },
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });

    // First request
    const resp1 = await post(`${recorder.url}/v1/chat/completions`, CHAT_REQUEST);
    expect(resp1.status).toBe(200);
    expect(countingUpstream.getCount()).toBe(1);

    // Second identical request — should ALSO hit upstream (not served from cache)
    const resp2 = await post(`${recorder.url}/v1/chat/completions`, CHAT_REQUEST);
    expect(resp2.status).toBe(200);
    expect(countingUpstream.getCount()).toBe(2);

    // Both responses should have the upstream content
    const body1 = JSON.parse(resp1.body);
    const body2 = JSON.parse(resp2.body);
    expect(body1.choices[0].message.content).toBe("counted response");
    expect(body2.choices[0].message.content).toBe("counted response");

    // Clean up counting upstream
    await new Promise<void>((resolve) => countingUpstream.server.close(() => resolve()));
  });

  it("regular record mode DOES cache in memory — second request served from cache", async () => {
    // Use a counting upstream to verify only the first request is proxied
    const countingUpstream = await createCountingUpstream("cached response");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-cache-"));

    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: countingUpstream.url },
        fixturePath: tmpDir,
        proxyOnly: false,
      },
    });

    // First request — proxied to upstream, recorded
    const resp1 = await post(`${recorder.url}/v1/chat/completions`, CHAT_REQUEST);
    expect(resp1.status).toBe(200);
    expect(countingUpstream.getCount()).toBe(1);

    // Second identical request — should be served from in-memory cache, NOT hitting upstream
    const resp2 = await post(`${recorder.url}/v1/chat/completions`, CHAT_REQUEST);
    expect(resp2.status).toBe(200);
    expect(countingUpstream.getCount()).toBe(1); // still 1 — no second proxy

    // Both responses should have the same content
    const body1 = JSON.parse(resp1.body);
    const body2 = JSON.parse(resp2.body);
    expect(body1.choices[0].message.content).toBe("cached response");
    expect(body2.choices[0].message.content).toBe("cached response");

    // Clean up counting upstream
    await new Promise<void>((resolve) => countingUpstream.server.close(() => resolve()));
  });

  it("regular record mode DOES write fixture files to disk", async () => {
    const { recorderUrl, fixturePath } = await setupProxyOnly(
      [
        {
          match: { userMessage: "capital of France" },
          response: { content: "Paris is the capital of France." },
        },
      ],
      false, // proxyOnly = false → normal record mode
    );

    await post(`${recorderUrl}/v1/chat/completions`, CHAT_REQUEST);

    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);
  });

  it("matched fixtures still work in proxy-only mode", async () => {
    // Set up an upstream, but pre-register a fixture on the recorder itself
    upstream = await createServer(
      [
        {
          match: { userMessage: "capital of France" },
          response: { content: "Upstream says Paris." },
        },
      ],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-proxy-only-matched-"));

    // Recorder has its own fixture that should match BEFORE proxying
    const localFixture: Fixture = {
      match: { userMessage: "capital of France" },
      response: { content: "Local fixture says Paris." },
    };

    recorder = await createServer([localFixture], {
      port: 0,
      record: {
        providers: { openai: upstream.url },
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, CHAT_REQUEST);

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body);
    // Should get the LOCAL fixture response, not the upstream one
    expect(body.choices[0].message.content).toBe("Local fixture says Paris.");

    // No files written to disk (the fixture matched locally, no proxy needed)
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      const fixtureFiles = files.filter((f) => f.endsWith(".json"));
      expect(fixtureFiles).toHaveLength(0);
    }
  });

  it("returns 503 in strict mode when provider is not configured", async () => {
    // Set up recorder with proxy-only mode but no anthropic provider configured
    upstream = await createServer([], { port: 0 });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-proxy-only-noprovider-"));

    recorder = await createServer([], {
      port: 0,
      strict: true,
      record: {
        providers: { openai: upstream.url }, // only openai configured
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });

    // Send to Anthropic endpoint — no provider configured for anthropic
    const resp = await post(`${recorder.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    });

    // Should get 503 (strict mode) since no fixture matches and no anthropic upstream
    expect(resp.status).toBe(503);
  });

  it("returns 404 in non-strict mode when provider is not configured", async () => {
    upstream = await createServer([], { port: 0 });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-proxy-only-404-"));

    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: upstream.url }, // only openai configured
        fixturePath: tmpDir,
        proxyOnly: true,
      },
    });

    // Send to Anthropic endpoint — no provider configured for anthropic
    const resp = await post(`${recorder.url}/v1/messages`, {
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    });

    // Should get 404 (non-strict default) since no fixture matches and no anthropic upstream
    expect(resp.status).toBe(404);
  });
});
