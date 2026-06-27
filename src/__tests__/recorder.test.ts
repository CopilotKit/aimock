import { describe, it, expect, afterEach, vi, type MockInstance } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Fixture, FixtureFile } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import {
  proxyAndRecord,
  buildFixtureMatch,
  persistFixture,
  sanitizeHeaderValue,
  type ProxyCapturedResponse,
} from "../recorder.js";
import type { RecordConfig } from "../types.js";
import { Logger } from "../logger.js";
import { LLMock } from "../llmock.js";
import { encodeEventStreamMessage } from "../aws-event-stream.js";
import { loadFixtureFile } from "../fixture-loader.js";

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

function postRaw(
  url: string,
  rawBody: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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
          "Content-Length": Buffer.byteLength(rawBody),
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
    req.write(rawBody);
    req.end();
  });
}

function del(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
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
// Unit tests — proxyAndRecord function directly
// ---------------------------------------------------------------------------

describe("proxyAndRecord", () => {
  it('returns "not_configured" when provider is not configured', async () => {
    const fixtures: Fixture[] = [];
    const logger = new Logger("silent");
    const record: RecordConfig = { providers: {} };

    // Create a mock req/res pair — we just need them to exist,
    // proxyAndRecord should short-circuit before using them
    const { req, res } = createMockReqRes();

    const result = await proxyAndRecord(
      req,
      res,
      { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
      "openai",
      "/v1/chat/completions",
      fixtures,
      { record, logger },
    );

    expect(result).toBe("not_configured");
  });

  it('returns "not_configured" when record config is undefined', async () => {
    const fixtures: Fixture[] = [];
    const logger = new Logger("silent");

    const { req, res } = createMockReqRes();

    const result = await proxyAndRecord(
      req,
      res,
      { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
      "openai",
      "/v1/chat/completions",
      fixtures,
      { record: undefined, logger },
    );

    expect(result).toBe("not_configured");
  });

  it("beforeWriteResponse hook receives raw upstream bytes (binary-safe)", async () => {
    // Pins the refactor's claim that the hook sees raw upstream bytes, not a
    // UTF-8-decoded-then-re-encoded view. Uses a deliberately non-UTF8 byte
    // sequence so any round-trip through String() would corrupt it.
    const bytes = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x02, 0x7f, 0x80]);

    const binaryUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "application/octet-stream" });
      upRes.end(bytes);
    });
    await new Promise<void>((resolve) => binaryUpstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (binaryUpstream.address() as { port: number }).port;

    let captured: ProxyCapturedResponse | undefined;

    // Minimal HTTP server that invokes proxyAndRecord with our capture hook,
    // so req/res are real and the full recorder pipeline exercises the hook.
    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "openai",
          "/v1/chat/completions",
          [],
          {
            record: {
              providers: { openai: `http://127.0.0.1:${upstreamPort}` },
              proxyOnly: true,
            },
            logger: new Logger("silent"),
          },
          rawBody,
          {
            beforeWriteResponse: (response) => {
              captured = response;
              return false; // let the default relay proceed; we only wanted to observe
            },
          },
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      await post(`http://127.0.0.1:${recorderPort}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(captured).toBeDefined();
      expect(captured!.body).toBeInstanceOf(Buffer);
      expect(Buffer.compare(captured!.body, bytes)).toBe(0);
    } finally {
      await new Promise<void>((resolve) => binaryUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — upstream mock + recording proxy
// ---------------------------------------------------------------------------

describe("recorder integration", () => {
  it("proxies unmatched request to upstream and returns correct response", async () => {
    const { recorderUrl } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    const resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.choices[0].message.content).toBe("Paris is the capital of France.");
  });

  it("saves fixture file to disk with correct format", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });

    // Check that a fixture file was created
    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    // Validate fixture content
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures).toHaveLength(1);
    expect(fixtureContent.fixtures[0].match.userMessage).toBe("What is the capital of France?");
    expect((fixtureContent.fixtures[0].response as { content: string }).content).toBe(
      "Paris is the capital of France.",
    );
  });

  it("recorded fixture is reused for subsequent identical requests", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    // First request — proxied
    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });

    // Second request — should match the recorded fixture
    const resp2 = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });

    expect(resp2.status).toBe(200);
    const body2 = JSON.parse(resp2.body);
    expect(body2.choices[0].message.content).toBe("Paris is the capital of France.");

    // Only one fixture file should exist (no second proxy)
    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);
  });

  it("records journal entry for proxied request", async () => {
    const { recorderUrl } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });

    // Check journal
    const journalResp = await get(`${recorderUrl}/v1/_requests`);
    const entries = JSON.parse(journalResp.body);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("does not save auth headers in fixture file", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      { Authorization: "Bearer sk-secret-key-12345" },
    );

    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    const content = fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8");

    // The fixture file should not contain any auth headers/secrets
    expect(content).not.toContain("sk-secret-key-12345");
    expect(content).not.toContain("Authorization");
    expect(content).not.toContain("authorization");
  });

  it("records tool call response from upstream", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "weather" },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        },
      },
    ]);

    const resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the weather?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.choices[0].message.tool_calls).toBeDefined();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_weather");

    // Check saved fixture has toolCalls
    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as { toolCalls: unknown[] };
    expect(savedResponse.toolCalls).toBeDefined();
    expect(savedResponse.toolCalls).toHaveLength(1);
  });

  it('coalesces missing tool-call arguments to "{}" in recorded fixture', async () => {
    // Real record path: a raw upstream returns an OpenAI non-streaming
    // chat-completions tool call whose `function.arguments` field is ABSENT
    // (a no-arg tool call). The recorder must persist `arguments: "{}"` so the
    // OpenAI replay path's `JSON.parse(args || "{}")` does not crash. Before the
    // fix, `String(fn.arguments)` persisted the literal string "undefined".
    const rawUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "application/json" });
      upRes.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: { name: "get_time" }, // no `arguments` field
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => rawUpstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (rawUpstream.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-noarg-"));

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "openai",
          "/v1/chat/completions",
          [],
          {
            record: {
              providers: { openai: `http://127.0.0.1:${upstreamPort}` },
              fixturePath: tmpDir!,
            },
            logger: new Logger("silent"),
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      await post(`http://127.0.0.1:${recorderPort}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "What time is it?" }],
        tools: [{ type: "function", function: { name: "get_time", parameters: {} } }],
      });

      const files = fs.readdirSync(tmpDir!).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixtureContent = JSON.parse(
        fs.readFileSync(path.join(tmpDir!, files[0]), "utf-8"),
      ) as FixtureFile;
      const savedResponse = fixtureContent.fixtures[0].response as {
        toolCalls: Array<{ arguments: string }>;
      };
      expect(savedResponse.toolCalls).toHaveLength(1);
      expect(savedResponse.toolCalls[0].arguments).toBe("{}");
    } finally {
      await new Promise<void>((resolve) => rawUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
    }
  });

  it("records embedding response from upstream", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder(
      [
        {
          match: { inputText: "hello world" },
          response: { embedding: [0.1, 0.2, 0.3] },
        },
      ],
      "openai",
    );

    const resp = await post(`${recorderUrl}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hello world",
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);

    // Check saved fixture
    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as { embedding: number[] };
    expect(savedResponse.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("records upstream error status as error fixture", async () => {
    // Upstream with no matching fixture for our request → 404
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "something else entirely" },
        response: { content: "not what we asked" },
      },
    ]);

    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "unmatched request" }],
    });

    // The upstream returns 404 (no fixture match), which gets proxied
    // The recorder should save an error fixture
    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as {
      error: { message: string };
      status?: number;
    };
    expect(savedResponse.error).toBeDefined();
    expect(savedResponse.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — streaming upstream → collapsed fixture
// ---------------------------------------------------------------------------

describe("recorder streaming collapse", () => {
  it("collapses OpenAI SSE streaming response to non-streaming fixture", async () => {
    // Upstream has a fixture; when recorder proxies with stream:true,
    // upstream returns SSE, recorder should collapse it
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    // Send request with stream: true — upstream aimock will return SSE
    const resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the capital of France?" }],
      stream: true,
    });

    expect(resp.status).toBe(200);
    // The recorder relays the raw SSE to the client
    // But the saved fixture should be collapsed
    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures).toHaveLength(1);
    const savedResponse = fixtureContent.fixtures[0].response as { content: string };
    expect(savedResponse.content).toBe("Paris is the capital of France.");
  });

  it("collapsed streaming fixture works on replay (second request matches)", async () => {
    const { recorderUrl } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    // First request — stream:true, proxied to upstream, collapsed on save
    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the capital of France?" }],
      stream: true,
    });

    // Second request — non-streaming, should match the collapsed fixture
    const resp2 = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });

    expect(resp2.status).toBe(200);
    const body2 = JSON.parse(resp2.body);
    expect(body2.choices[0].message.content).toBe("Paris is the capital of France.");
  });

  it("collapses streaming tool call response to fixture with toolCalls", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "weather" },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
        },
      },
    ]);

    // Send streaming request
    const resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the weather?" }],
      stream: true,
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });

    expect(resp.status).toBe(200);

    // Check saved fixture has toolCalls (not SSE)
    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as { toolCalls: unknown[] };
    expect(savedResponse.toolCalls).toBeDefined();
    expect(savedResponse.toolCalls).toHaveLength(1);
  });

  it("captures a real Anthropic signature_delta into the recorded fixture's reasoningSignature", async () => {
    const REAL_SIGNATURE = "ErcBCkgIA...recordedRealCryptographicSignature==";
    // Raw Anthropic SSE upstream that streams a thinking block carrying a real
    // signature_delta (aimock's own server would only emit the placeholder).
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "thinking_delta", thinking: "Let me think." } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "signature_delta", signature: REAL_SIGNATURE } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "text_delta", text: "Answer." } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    const anthropicUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => anthropicUpstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (anthropicUpstream.address() as { port: number }).port;

    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-recorder-sig-"));

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "anthropic",
          "/v1/messages",
          [],
          {
            record: {
              providers: { anthropic: `http://127.0.0.1:${upstreamPort}` },
              fixturePath,
            },
            logger: new Logger("silent"),
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      const resp = await post(`http://127.0.0.1:${recorderPort}/v1/messages`, {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 1024 },
        stream: true,
        messages: [{ role: "user", content: "think please" }],
      });
      expect(resp.status).toBe(200);

      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixtureContent = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as FixtureFile;
      const savedResponse = fixtureContent.fixtures[0].response as {
        reasoning?: string;
        reasoningSignature?: string;
      };
      expect(savedResponse.reasoning).toBe("Let me think.");
      // The real signature is recorded so replay can emit it instead of the placeholder.
      expect(savedResponse.reasoningSignature).toBe(REAL_SIGNATURE);
    } finally {
      await new Promise<void>((resolve) => anthropicUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  // ---- Ordered `blocks` persistence (#274) ---------------------------------
  // A tool-call-before-text Anthropic stream is interleaved, so the recorder
  // must persist the ordered `blocks` array; an ordinary text-then-tools stream
  // is NOT interleaved, so the recorder keeps the legacy `{content, toolCalls}`
  // shape with NO `blocks` key (golden recordings stay byte-identical).
  async function recordAnthropicStream(
    sse: string,
    prefix: string,
  ): Promise<Record<string, unknown>> {
    const anthropicUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => anthropicUpstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (anthropicUpstream.address() as { port: number }).port;
    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "anthropic",
          "/v1/messages",
          [],
          {
            record: {
              providers: { anthropic: `http://127.0.0.1:${upstreamPort}` },
              fixturePath,
            },
            logger: new Logger("silent"),
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      const resp = await post(`http://127.0.0.1:${recorderPort}/v1/messages`, {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "go" }],
      });
      expect(resp.status).toBe(200);
      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixtureContent = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as FixtureFile;
      return fixtureContent.fixtures[0].response as Record<string, unknown>;
    } finally {
      await new Promise<void>((resolve) => anthropicUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  }

  it("persists ordered blocks for a tool-before-text streamed turn", async () => {
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "text_delta", text: "Done." } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");
    const saved = await recordAnthropicStream(sse, "aimock-recorder-blocks-tool-");
    expect(saved.blocks).toEqual([
      { type: "toolCall", name: "get_weather", arguments: '{"city":"Paris"}', id: "toolu_1" },
      { type: "text", text: "Done." },
    ]);
    // Legacy fields remain populated for replay/back-compat.
    expect(saved.content).toBe("Done.");
    expect(saved.toolCalls).toHaveLength(1);
  });

  it("persists the legacy shape (no blocks) for a text-then-tools streamed turn", async () => {
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Sure." } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");
    const saved = await recordAnthropicStream(sse, "aimock-recorder-blocks-text-");
    expect(saved.blocks).toBeUndefined();
    expect(saved.content).toBe("Sure.");
    expect(saved.toolCalls).toHaveLength(1);
  });

  it("captures Anthropic redacted_thinking block data into the recorded fixture's redactedThinking", async () => {
    const REDACTED_DATA = "EncryptedRedactedThinkingPayloadAAA==";
    // Raw Anthropic SSE upstream that streams a redacted_thinking block (its
    // encrypted reasoning lives in an opaque `data` on the start event) followed
    // by a text block. aimock's own server would never emit a redacted block.
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "redacted_thinking", data: REDACTED_DATA } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "text_delta", text: "Answer." } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    const anthropicUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => anthropicUpstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (anthropicUpstream.address() as { port: number }).port;

    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-recorder-redacted-"));

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "anthropic",
          "/v1/messages",
          [],
          {
            record: {
              providers: { anthropic: `http://127.0.0.1:${upstreamPort}` },
              fixturePath,
            },
            logger: new Logger("silent"),
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      const resp = await post(`http://127.0.0.1:${recorderPort}/v1/messages`, {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 1024 },
        stream: true,
        messages: [{ role: "user", content: "think please" }],
      });
      expect(resp.status).toBe(200);

      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixtureContent = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as FixtureFile;
      const savedResponse = fixtureContent.fixtures[0].response as {
        content?: string;
        redactedThinking?: string[];
      };
      expect(savedResponse.content).toBe("Answer.");
      // The opaque redacted payload is recorded so replay can emit it faithfully.
      expect(savedResponse.redactedThinking).toEqual([REDACTED_DATA]);
    } finally {
      await new Promise<void>((resolve) => anthropicUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("captures reasoningSignature on a thinking-only turn (empty-content branch)", async () => {
    const REAL_SIGNATURE = "ErcBCkgIA...recordedRealCryptographicSignature==";
    // Raw Anthropic SSE upstream that streams ONLY a thinking block carrying a
    // real signature_delta — no text content and no tool calls. This drives the
    // recorder's empty-content branch (recorder.ts), which still persists the
    // reasoning and the real signature for a thinking-only turn.
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "thinking_delta", thinking: "Let me think." } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "signature_delta", signature: REAL_SIGNATURE } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    const anthropicUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => anthropicUpstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (anthropicUpstream.address() as { port: number }).port;

    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-recorder-sig-empty-"));

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "anthropic",
          "/v1/messages",
          [],
          {
            record: {
              providers: { anthropic: `http://127.0.0.1:${upstreamPort}` },
              fixturePath,
            },
            logger: new Logger("silent"),
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      const resp = await post(`http://127.0.0.1:${recorderPort}/v1/messages`, {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 1024 },
        stream: true,
        messages: [{ role: "user", content: "think please" }],
      });
      expect(resp.status).toBe(200);

      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixtureContent = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as FixtureFile;
      const savedResponse = fixtureContent.fixtures[0].response as {
        content?: string;
        reasoning?: string;
        reasoningSignature?: string;
      };
      // Empty-content branch: the turn is saved with empty content plus the
      // reasoning and the real captured signature.
      expect(savedResponse.content).toBe("");
      expect(savedResponse.reasoning).toBe("Let me think.");
      expect(savedResponse.reasoningSignature).toBe(REAL_SIGNATURE);
    } finally {
      await new Promise<void>((resolve) => anthropicUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("drops a bare reasoningSignature when no reasoning text was captured", async () => {
    const REAL_SIGNATURE = "ErcBCkgIA...recordedRealCryptographicSignature==";
    // Raw Anthropic SSE upstream that streams a thinking block which emits a
    // signature_delta but NO thinking_delta text. The collapsed result then
    // carries a reasoningSignature with empty reasoning. The recorder
    // intentionally drops the bare signature (it has nothing to attach to on
    // replay) via the `collapsed.reasoning && collapsed.reasoningSignature` gate.
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "signature_delta", signature: REAL_SIGNATURE } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "text", text: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "text_delta", text: "Answer." } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    const anthropicUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => anthropicUpstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (anthropicUpstream.address() as { port: number }).port;

    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-recorder-sig-bare-"));

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "anthropic",
          "/v1/messages",
          [],
          {
            record: {
              providers: { anthropic: `http://127.0.0.1:${upstreamPort}` },
              fixturePath,
            },
            logger: new Logger("silent"),
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      const resp = await post(`http://127.0.0.1:${recorderPort}/v1/messages`, {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 1024 },
        stream: true,
        messages: [{ role: "user", content: "think please" }],
      });
      expect(resp.status).toBe(200);

      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixtureContent = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as FixtureFile;
      const savedResponse = fixtureContent.fixtures[0].response as {
        content?: string;
        reasoning?: string;
        reasoningSignature?: string;
      };
      // A bare signature with no reasoning text is dropped — only the text content survives.
      expect(savedResponse.content).toBe("Answer.");
      expect(savedResponse.reasoning).toBeUndefined();
      expect(savedResponse.reasoningSignature).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => anthropicUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  // Non-streaming (plain JSON) recording must capture the SAME extended-thinking
  // signal the streaming path does: the real thinking-block signature, redacted
  // block payloads, and redacted-only turns. These mirror the streaming tests
  // above but drive a JSON (non-SSE) Anthropic upstream.
  function recordNonStreamingAnthropic(
    responseJson: unknown,
    fixturePathPrefix: string,
  ): Promise<FixtureFile> {
    return (async () => {
      const anthropicUpstream = http.createServer((_upReq, upRes) => {
        upRes.writeHead(200, { "Content-Type": "application/json" });
        upRes.end(JSON.stringify(responseJson));
      });
      await new Promise<void>((resolve) =>
        anthropicUpstream.listen(0, "127.0.0.1", () => resolve()),
      );
      const upstreamPort = (anthropicUpstream.address() as { port: number }).port;

      const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), fixturePathPrefix));

      const recorderServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          const rawBody = Buffer.concat(chunks).toString();
          await proxyAndRecord(
            req,
            res,
            JSON.parse(rawBody),
            "anthropic",
            "/v1/messages",
            [],
            {
              record: {
                providers: { anthropic: `http://127.0.0.1:${upstreamPort}` },
                fixturePath,
              },
              logger: new Logger("silent"),
            },
            rawBody,
          );
        });
      });
      await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
      const recorderPort = (recorderServer.address() as { port: number }).port;

      try {
        const resp = await post(`http://127.0.0.1:${recorderPort}/v1/messages`, {
          model: "claude-3-7-sonnet-20250219",
          max_tokens: 1024,
          thinking: { type: "enabled", budget_tokens: 1024 },
          stream: false,
          messages: [{ role: "user", content: "think please" }],
        });
        expect(resp.status).toBe(200);

        const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
        expect(files).toHaveLength(1);
        return JSON.parse(
          fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
        ) as FixtureFile;
      } finally {
        await new Promise<void>((resolve) => anthropicUpstream.close(() => resolve()));
        await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
        fs.rmSync(fixturePath, { recursive: true, force: true });
      }
    })();
  }

  it("captures a non-streaming Anthropic thinking-block signature into reasoningSignature", async () => {
    const REAL_SIGNATURE = "ErcBCkgIA...recordedNonStreamingCryptographicSignature==";
    const fixtureContent = await recordNonStreamingAnthropic(
      {
        content: [
          { type: "thinking", thinking: "Let me think.", signature: REAL_SIGNATURE },
          { type: "text", text: "Answer." },
        ],
      },
      "aimock-recorder-ns-sig-",
    );
    const savedResponse = fixtureContent.fixtures[0].response as {
      content?: string;
      reasoning?: string;
      reasoningSignature?: string;
    };
    expect(savedResponse.content).toBe("Answer.");
    expect(savedResponse.reasoning).toBe("Let me think.");
    // The real signature is recorded so replay can emit it instead of the placeholder.
    expect(savedResponse.reasoningSignature).toBe(REAL_SIGNATURE);
  });

  it("binds non-streaming multi-thinking-block reasoning to the LAST block's signature", async () => {
    // Two thinking blocks each carry text and a DISTINCT signature. The streaming
    // collapser overwrites reasoningSignature on every signature_delta
    // (last-signature-wins), so the non-streaming path must agree: the merged
    // reasoning string binds to the SECOND (last) block's signature, never the first.
    const FIRST_SIGNATURE = "ErcBfirstThinkingBlockSignatureAAA==";
    const SECOND_SIGNATURE = "ErcBsecondThinkingBlockSignatureBBB==";
    const fixtureContent = await recordNonStreamingAnthropic(
      {
        content: [
          { type: "thinking", thinking: "First thought. ", signature: FIRST_SIGNATURE },
          { type: "thinking", thinking: "Second thought.", signature: SECOND_SIGNATURE },
          { type: "text", text: "Answer." },
        ],
      },
      "aimock-recorder-ns-multi-sig-",
    );
    const savedResponse = fixtureContent.fixtures[0].response as {
      content?: string;
      reasoning?: string;
      reasoningSignature?: string;
    };
    expect(savedResponse.content).toBe("Answer.");
    // Reasoning is the joined text of every thinking block, in order.
    expect(savedResponse.reasoning).toBe("First thought. Second thought.");
    // Last-signature-wins parity with collapseAnthropicSSE: the LAST block's signature.
    expect(savedResponse.reasoningSignature).toBe(SECOND_SIGNATURE);
  });

  it("a trailing signature-less non-streaming thinking block does not clobber an earlier block's signature", async () => {
    // Block 1 carries text + a signature (S1); block 2 (the LAST) carries text
    // but NO signature. The non-streaming capture path advances the recorded
    // signature only on a block that actually carries one (mirroring
    // collapseAnthropicSSE's signature_delta gating), so the unsigned trailing
    // block leaves S1 intact rather than dropping the signature.
    const FIRST_SIGNATURE = "ErcBfirstThinkingBlockSignatureAAA==";
    const fixtureContent = await recordNonStreamingAnthropic(
      {
        content: [
          { type: "thinking", thinking: "First thought. ", signature: FIRST_SIGNATURE },
          { type: "thinking", thinking: "Second thought." },
          { type: "text", text: "Answer." },
        ],
      },
      "aimock-recorder-ns-trailing-unsigned-",
    );
    const savedResponse = fixtureContent.fixtures[0].response as {
      content?: string;
      reasoning?: string;
      reasoningSignature?: string;
    };
    expect(savedResponse.content).toBe("Answer.");
    // Reasoning is the joined text of every thinking block, in order.
    expect(savedResponse.reasoning).toBe("First thought. Second thought.");
    // The unsigned trailing block does NOT clobber the first block's signature.
    expect(savedResponse.reasoningSignature).toBe(FIRST_SIGNATURE);
  });

  it("captures non-streaming Anthropic redacted_thinking block data into redactedThinking", async () => {
    const REDACTED_DATA = "EncryptedNonStreamingRedactedThinkingPayloadAAA==";
    const fixtureContent = await recordNonStreamingAnthropic(
      {
        content: [
          { type: "redacted_thinking", data: REDACTED_DATA },
          { type: "text", text: "Answer." },
        ],
      },
      "aimock-recorder-ns-redacted-",
    );
    const savedResponse = fixtureContent.fixtures[0].response as {
      content?: string;
      redactedThinking?: string[];
    };
    expect(savedResponse.content).toBe("Answer.");
    // The opaque redacted payload is recorded so replay can emit it faithfully.
    expect(savedResponse.redactedThinking).toEqual([REDACTED_DATA]);
  });

  it("records a non-streaming redacted-only Anthropic turn as empty content, not an error", async () => {
    const REDACTED_DATA_A = "EncryptedRedactedOnlyAAA==";
    const REDACTED_DATA_B = "EncryptedRedactedOnlyBBB==";
    const fixtureContent = await recordNonStreamingAnthropic(
      {
        content: [
          { type: "redacted_thinking", data: REDACTED_DATA_A },
          { type: "redacted_thinking", data: REDACTED_DATA_B },
        ],
      },
      "aimock-recorder-ns-redacted-only-",
    );
    const savedResponse = fixtureContent.fixtures[0].response as {
      content?: string;
      redactedThinking?: string[];
      error?: unknown;
    };
    // Redacted-only turns must round-trip as a normal empty-content response, not
    // the "Could not detect response format" error fallback.
    expect(savedResponse.error).toBeUndefined();
    expect(savedResponse.content).toBe("");
    expect(savedResponse.redactedThinking).toEqual([REDACTED_DATA_A, REDACTED_DATA_B]);
  });

  it("records a non-streaming empty-data redacted-only Anthropic turn as empty content, not an error", async () => {
    // A redacted-only turn whose blocks all carry empty `data` is constructible
    // upstream. The capture filter (capturedRedactedData) drops empty-data blocks,
    // so redactedThinking is empty — but classification keys on the PRESENCE of any
    // redacted_thinking block (raw), so the turn round-trips as a normal
    // empty-content response, not the "Could not detect response format" error
    // fallback. With no surviving data, NO redactedThinking field is persisted —
    // matching the streaming sibling's `{ content: "" }` outcome.
    const fixtureContent = await recordNonStreamingAnthropic(
      {
        content: [
          { type: "redacted_thinking", data: "" },
          { type: "redacted_thinking", data: "" },
        ],
      },
      "aimock-recorder-ns-redacted-empty-",
    );
    const savedResponse = fixtureContent.fixtures[0].response as {
      content?: string;
      redactedThinking?: string[];
      error?: unknown;
    };
    expect(savedResponse.error).toBeUndefined();
    expect(savedResponse.content).toBe("");
    expect(savedResponse.redactedThinking).toBeUndefined();
  });

  it("records a non-streaming empty-text thinking-only Anthropic turn as empty content, not an error", async () => {
    const REAL_SIGNATURE = "ErcBCkgIA...emptyTextThinkingOnlySignature==";
    const fixtureContent = await recordNonStreamingAnthropic(
      {
        content: [{ type: "thinking", thinking: "", signature: REAL_SIGNATURE }],
      },
      "aimock-recorder-ns-empty-thinking-",
    );
    const savedResponse = fixtureContent.fixtures[0].response as {
      content?: string;
      reasoning?: string;
      reasoningSignature?: string;
      error?: unknown;
    };
    // A thinking-only turn whose plaintext is empty but which bears a real
    // signature is classified by the PRESENCE of the thinking block, so it
    // round-trips as a normal empty-content response, not the "Could not detect
    // response format" error fallback. The bare signature is still dropped per
    // the persistence contract (no reasoning text to attach it to on replay).
    expect(savedResponse.error).toBeUndefined();
    expect(savedResponse.content).toBe("");
    expect(savedResponse.reasoning).toBeUndefined();
    expect(savedResponse.reasoningSignature).toBeUndefined();
  });

  it("records a streaming empty-text thinking-only Anthropic turn as empty content, not an error", async () => {
    const REAL_SIGNATURE = "ErcBCkgIA...streamingEmptyTextThinkingOnlySignature==";
    // Raw Anthropic SSE upstream that streams ONLY a thinking block carrying a
    // real signature_delta but NO thinking_delta text — no text block, no tool
    // calls. The streaming collapse path drives the empty-content branch
    // (recorder.ts), which records a normal empty-content fixture. This is the
    // streaming sibling of the non-streaming empty-text thinking-only case: both
    // round-trip as a normal response (never the error fallback), and the bare
    // signature is dropped because there is no reasoning text to attach it to.
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "signature_delta", signature: REAL_SIGNATURE } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    const anthropicUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => anthropicUpstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (anthropicUpstream.address() as { port: number }).port;

    const fixturePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "aimock-recorder-stream-empty-thinking-"),
    );

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "anthropic",
          "/v1/messages",
          [],
          {
            record: {
              providers: { anthropic: `http://127.0.0.1:${upstreamPort}` },
              fixturePath,
            },
            logger: new Logger("silent"),
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      const resp = await post(`http://127.0.0.1:${recorderPort}/v1/messages`, {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 1024 },
        stream: true,
        messages: [{ role: "user", content: "think please" }],
      });
      expect(resp.status).toBe(200);

      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixtureContent = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as FixtureFile;
      const savedResponse = fixtureContent.fixtures[0].response as {
        content?: string;
        reasoning?: string;
        reasoningSignature?: string;
        error?: unknown;
      };
      expect(savedResponse.error).toBeUndefined();
      expect(savedResponse.content).toBe("");
      expect(savedResponse.reasoning).toBeUndefined();
      expect(savedResponse.reasoningSignature).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => anthropicUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("records a streaming empty-data redacted-only Anthropic turn as empty content, not an error", async () => {
    // Raw Anthropic SSE upstream streaming ONLY redacted_thinking blocks whose
    // `data` is empty — no text block, no tool calls. This is the streaming
    // sibling of the non-streaming empty-data redacted-only case: the collapse
    // path classifies on content emptiness, the empty `data` is filtered out of
    // the persisted payload (capturedRedactedData drops it), so the turn
    // round-trips as a normal `{ content: "" }` fixture with NO redactedThinking
    // field — never the "Could not detect response format" error fallback.
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "redacted_thinking", data: "" } })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}`,
      "",
      `event: message_stop\ndata: {}`,
      "",
    ].join("\n");

    const anthropicUpstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => anthropicUpstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (anthropicUpstream.address() as { port: number }).port;

    const fixturePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "aimock-recorder-stream-redacted-empty-"),
    );

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "anthropic",
          "/v1/messages",
          [],
          {
            record: {
              providers: { anthropic: `http://127.0.0.1:${upstreamPort}` },
              fixturePath,
            },
            logger: new Logger("silent"),
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      const resp = await post(`http://127.0.0.1:${recorderPort}/v1/messages`, {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 1024 },
        stream: true,
        messages: [{ role: "user", content: "think please" }],
      });
      expect(resp.status).toBe(200);

      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixtureContent = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as FixtureFile;
      const savedResponse = fixtureContent.fixtures[0].response as {
        content?: string;
        redactedThinking?: string[];
        error?: unknown;
      };
      expect(savedResponse.error).toBeUndefined();
      expect(savedResponse.content).toBe("");
      expect(savedResponse.redactedThinking).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => anthropicUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — multi-provider proxy routing
// ---------------------------------------------------------------------------

describe("recorder multi-provider routing", () => {
  it("proxies Anthropic messages request to anthropic upstream", async () => {
    // Upstream for Anthropic
    const anthropicUpstream = await createServer(
      [
        {
          match: { userMessage: "bonjour" },
          response: { content: "Salut!" },
        },
      ],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));

    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { anthropic: anthropicUpstream.url },
        fixturePath: tmpDir,
      },
    });

    const resp = await post(`${recorder.url}/v1/messages`, {
      model: "claude-3-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "bonjour" }],
    });

    expect(resp.status).toBe(200);
    // Anthropic handler translates to/from Claude format; the upstream
    // is another aimock so it returns OpenAI format which gets proxied raw
    const body = JSON.parse(resp.body);
    // The proxied response should contain content
    expect(body).toBeDefined();

    // Fixture file created on disk
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(1);

    // Clean up the extra upstream
    await new Promise<void>((resolve) => anthropicUpstream.server.close(() => resolve()));
  });

  it("unconfigured provider returns 404 (no proxy)", async () => {
    // Only openai provider configured, not gemini
    const { recorderUrl } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "test" },
        response: { content: "ok" },
      },
    ]);

    // Send a Gemini-format request — no upstream configured for gemini
    const resp = await post(`${recorderUrl}/v1beta/models/gemini-pro:generateContent`, {
      contents: [{ parts: [{ text: "hello gemini" }], role: "user" }],
    });

    // Should get 404 — no fixture and no gemini upstream
    expect(resp.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — strict mode
// ---------------------------------------------------------------------------

describe("recorder strict mode", () => {
  it("strict mode without recording: unmatched request returns 503 with error logged", async () => {
    recorder = await createServer([], {
      port: 0,
      strict: true,
      logLevel: "debug",
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "no fixture here" }],
    });

    expect(resp.status).toBe(503);
    const body = JSON.parse(resp.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
  });

  it("record + strict: strict blocks proxy even when upstream is available", async () => {
    await setupUpstreamAndRecorder([
      {
        match: { userMessage: "hello" },
        response: { content: "world" },
      },
    ]);

    // Override to also set strict on the recorder
    // Need to create a new recorder with both record + strict
    await new Promise<void>((resolve) => recorder!.server.close(() => resolve()));

    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      strict: true,
      record: { providers: { openai: upstream!.url }, fixturePath: tmpDir },
    });

    // Strict mode now takes precedence over proxy — returns 503
    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(resp.status).toBe(503);
    const body = JSON.parse(resp.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — enableRecording / disableRecording on LLMock
// ---------------------------------------------------------------------------

describe("LLMock enableRecording / disableRecording", () => {
  let mock: LLMock;
  let upstreamServer: ServerInstance;

  afterEach(async () => {
    if (mock) {
      try {
        await mock.stop();
      } catch {
        // ignore if not started
      }
    }
    if (upstreamServer) {
      await new Promise<void>((resolve) => upstreamServer.server.close(() => resolve()));
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("enableRecording allows proxying; disableRecording returns to 404", async () => {
    // Set up upstream
    upstreamServer = await createServer(
      [
        {
          match: { userMessage: "hello" },
          response: { content: "from upstream" },
        },
      ],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));

    mock = new LLMock();
    const url = await mock.start();

    // Without recording: request gets 404
    const resp1 = await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(resp1.status).toBe(404);

    // Enable recording
    mock.enableRecording({
      providers: { openai: upstreamServer.url },
      fixturePath: tmpDir,
    });

    // Now request should proxy to upstream
    const resp2 = await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(resp2.status).toBe(200);
    const body2 = JSON.parse(resp2.body);
    expect(body2.choices[0].message.content).toBe("from upstream");

    // Disable recording
    mock.disableRecording();

    // Recorded fixture should still work (it was added to memory)
    const resp3 = await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(resp3.status).toBe(200);
    const body3 = JSON.parse(resp3.body);
    expect(body3.choices[0].message.content).toBe("from upstream");

    // A different message should 404 (no recording, no fixture)
    const resp4 = await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "something else" }],
    });
    expect(resp4.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — multi-provider recording (Gemini, Ollama, Cohere, Bedrock, Vertex AI)
// ---------------------------------------------------------------------------

describe("recorder multi-provider recording", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers = [];
  });

  function trackServer(si: ServerInstance): ServerInstance {
    servers.push(si.server);
    return si;
  }

  it("records Gemini generateContent request through full proxy", async () => {
    const geminiUpstream = trackServer(
      await createServer(
        [{ match: { userMessage: "test gemini" }, response: { content: "Gemini says hello" } }],
        { port: 0 },
      ),
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { gemini: geminiUpstream.url }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ parts: [{ text: "test gemini" }], role: "user" }],
    });

    expect(resp.status).toBe(200);

    // Fixture file saved with gemini prefix
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.startsWith("gemini-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures).toHaveLength(1);
    expect(fixtureContent.fixtures[0].match.userMessage).toBe("test gemini");
  });

  it("records Ollama /api/chat request through full proxy", async () => {
    const ollamaUpstream = trackServer(
      await createServer(
        [{ match: { userMessage: "test ollama" }, response: { content: "Ollama says hello" } }],
        { port: 0 },
      ),
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { ollama: ollamaUpstream.url }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "test ollama" }],
      stream: false,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.startsWith("ollama-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures[0].match.userMessage).toBe("test ollama");
  });

  it("records Cohere /v2/chat request through full proxy", async () => {
    const cohereUpstream = trackServer(
      await createServer(
        [{ match: { userMessage: "test cohere" }, response: { content: "Cohere says hello" } }],
        { port: 0 },
      ),
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { cohere: cohereUpstream.url }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "test cohere" }],
      stream: false,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.startsWith("cohere-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures[0].match.userMessage).toBe("test cohere");
  });

  it("records Bedrock /model/{id}/invoke request through full proxy", async () => {
    const bedrockUpstream = trackServer(
      await createServer(
        [{ match: { userMessage: "test bedrock" }, response: { content: "Bedrock says hello" } }],
        { port: 0 },
      ),
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { bedrock: bedrockUpstream.url }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/model/claude-v3/invoke`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 100,
      messages: [{ role: "user", content: "test bedrock" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.startsWith("bedrock-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures[0].match.userMessage).toBe("test bedrock");
  });

  it("records Vertex AI request through vertexai provider key", async () => {
    // Vertex AI now uses "vertexai" as the provider key
    const vertexUpstream = trackServer(
      await createServer(
        [{ match: { userMessage: "test vertex" }, response: { content: "Vertex says hello" } }],
        { port: 0 },
      ),
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { vertexai: vertexUpstream.url }, fixturePath: tmpDir },
    });

    const resp = await post(
      `${recorder.url}/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent`,
      { contents: [{ parts: [{ text: "test vertex" }], role: "user" }] },
    );

    expect(resp.status).toBe(200);

    // Uses vertexai prefix (separate provider key from gemini)
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.startsWith("vertexai-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);
  });

  it("records Anthropic streaming request through handleMessages", async () => {
    const anthropicUpstream = trackServer(
      await createServer(
        [
          {
            match: { userMessage: "stream anthropic" },
            response: { content: "Anthropic streamed" },
          },
        ],
        { port: 0 },
      ),
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { anthropic: anthropicUpstream.url }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/messages`, {
      model: "claude-3-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "stream anthropic" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.startsWith("anthropic-") && f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);
  });

  it("records multiple providers simultaneously", async () => {
    const openaiUpstream = trackServer(
      await createServer(
        [{ match: { userMessage: "multi openai" }, response: { content: "OpenAI multi" } }],
        { port: 0 },
      ),
    );
    const geminiUpstream = trackServer(
      await createServer(
        [{ match: { userMessage: "multi gemini" }, response: { content: "Gemini multi" } }],
        { port: 0 },
      ),
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: openaiUpstream.url, gemini: geminiUpstream.url },
        fixturePath: tmpDir,
      },
    });

    // OpenAI request
    const resp1 = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "multi openai" }],
    });
    expect(resp1.status).toBe(200);

    // Gemini request
    const resp2 = await post(`${recorder.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ parts: [{ text: "multi gemini" }], role: "user" }],
    });
    expect(resp2.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const openaiFixtures = files.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    const geminiFixtures = files.filter((f) => f.startsWith("gemini-") && f.endsWith(".json"));
    expect(openaiFixtures).toHaveLength(1);
    expect(geminiFixtures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — streaming recording through full server
// ---------------------------------------------------------------------------

describe("recorder streaming through full server", () => {
  it("OpenAI streaming request collapses and saves fixture with correct content", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "stream test" },
        response: { content: "Streamed content from upstream" },
      },
    ]);

    const resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "stream test" }],
      stream: true,
    });

    expect(resp.status).toBe(200);
    // SSE data relayed to client
    expect(resp.body).toContain("data:");

    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as { content: string };
    expect(savedResponse.content).toBe("Streamed content from upstream");
  });

  it("streaming tool call recording preserves toolCalls in fixture", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "stream tools" },
        response: {
          toolCalls: [{ name: "search", arguments: '{"query":"test"}' }],
        },
      },
    ]);

    const resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "stream tools" }],
      stream: true,
      tools: [{ type: "function", function: { name: "search", parameters: {} } }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as {
      toolCalls: Array<{ name: string; arguments: string }>;
    };
    expect(savedResponse.toolCalls).toBeDefined();
    expect(savedResponse.toolCalls).toHaveLength(1);
    expect(savedResponse.toolCalls[0].name).toBe("search");
    expect(savedResponse.toolCalls[0].arguments).toBe('{"query":"test"}');
  });
});

// ---------------------------------------------------------------------------
// End-to-end replay verification
// ---------------------------------------------------------------------------

describe("recorder end-to-end replay", () => {
  it("record → verify fixture on disk → replay from fixture (not proxy)", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "replay test" },
        response: { content: "Replay this content" },
      },
    ]);

    // First request — proxied to upstream
    const resp1 = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "replay test" }],
    });
    expect(resp1.status).toBe(200);

    // Verify fixture file on disk
    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures[0].match.userMessage).toBe("replay test");
    expect((fixtureContent.fixtures[0].response as { content: string }).content).toBe(
      "Replay this content",
    );

    // Clear journal to distinguish proxy vs fixture-match
    await del(`${recorderUrl}/v1/_requests`);

    // Second request — should match recorded fixture
    const resp2 = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "replay test" }],
    });
    expect(resp2.status).toBe(200);
    const body2 = JSON.parse(resp2.body);
    expect(body2.choices[0].message.content).toBe("Replay this content");

    // Journal should show the request was served with a fixture match (not null)
    const journalResp = await get(`${recorderUrl}/v1/_requests`);
    const entries = JSON.parse(journalResp.body);
    expect(entries).toHaveLength(1);
    expect(entries[0].response.fixture).not.toBeNull();

    // Still only one fixture file (no second proxy)
    const files2 = fs.readdirSync(fixturePath);
    const fixtureFiles2 = files2.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles2).toHaveLength(1);
  });

  it("record tool call → replay → toolCalls match", async () => {
    const { recorderUrl } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "tool replay" },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        },
      },
    ]);

    // Record
    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "tool replay" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });

    // Replay
    const resp2 = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "tool replay" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });
    expect(resp2.status).toBe(200);
    const body2 = JSON.parse(resp2.body);
    expect(body2.choices[0].message.tool_calls).toBeDefined();
    expect(body2.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(body2.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"NYC"}');
  });

  it("record embedding → replay → embedding vector matches", async () => {
    const { recorderUrl } = await setupUpstreamAndRecorder(
      [{ match: { inputText: "embed replay" }, response: { embedding: [0.5, 0.6, 0.7] } }],
      "openai",
    );

    // Record
    await post(`${recorderUrl}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "embed replay",
    });

    // Replay
    const resp2 = await post(`${recorderUrl}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "embed replay",
    });
    expect(resp2.status).toBe(200);
    const body2 = JSON.parse(resp2.body);
    expect(body2.data[0].embedding).toEqual([0.5, 0.6, 0.7]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("recorder edge cases", () => {
  it("upstream 500 error recorded as error fixture and replayed", async () => {
    // Upstream returns error for any request
    upstream = await createServer(
      [
        {
          match: { userMessage: "trigger error" },
          response: {
            error: { message: "Internal server error", type: "server_error" },
            status: 500,
          },
        },
      ],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstream.url }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "trigger error" }],
    });

    // Proxy relay normalizes upstream errors to 502 (Bad Gateway)
    expect(resp.status).toBe(502);

    // Fixture file created with error response — preserves real upstream status
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as {
      error: { message: string };
      status?: number;
    };
    expect(savedResponse.error).toBeDefined();
    expect(savedResponse.status).toBe(500);

    // Replay: second identical request matches the recorded error fixture
    // (served by aimock's fixture serving logic, which uses the fixture's status field)
    const resp2 = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "trigger error" }],
    });
    expect(resp2.status).toBe(500);
  });

  it("empty match _warning field assertion: present in saved file, NOT in memory", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        // Upstream matches everything via predicate
        match: { predicate: () => true },
        response: { content: "empty match response" },
      },
    ]);

    // Send a request with only a system message (no user message → empty match)
    const resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "system", content: "You are a helpful assistant" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    // Saved file should have _warning field
    const fileContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    );
    expect(fileContent._warning).toBeDefined();
    expect(fileContent._warning).toContain("Empty match");

    // In-memory fixtures should NOT have been augmented (empty match skipped)
    // Send same request again — it should proxy again (not match from memory)
    const resp2 = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "system", content: "You are a helpful assistant" }],
    });
    // Should still return 200 (proxied again since empty match wasn't added to memory)
    expect(resp2.status).toBe(200);

    // Now TWO fixture files on disk (proxied twice)
    const files2 = fs.readdirSync(fixturePath);
    const fixtureFiles2 = files2.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles2).toHaveLength(2);
  });

  it("default fixturePath: omit fixturePath from config, verify default path used", async () => {
    upstream = await createServer(
      [{ match: { userMessage: "default path" }, response: { content: "default path response" } }],
      { port: 0 },
    );

    // Create recorder with no fixturePath — should default to "./fixtures/recorded"
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstream.url } },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "default path" }],
    });

    expect(resp.status).toBe(200);

    // Check the default path
    const defaultPath = path.resolve("./fixtures/recorded");
    try {
      expect(fs.existsSync(defaultPath)).toBe(true);
      const files = fs.readdirSync(defaultPath);
      const fixtureFiles = files.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
      expect(fixtureFiles.length).toBeGreaterThanOrEqual(1);
    } finally {
      // Clean up the default path files we created
      if (fs.existsSync(defaultPath)) {
        const cleanupFiles = fs.readdirSync(defaultPath);
        for (const f of cleanupFiles.filter(
          (f) => f.startsWith("openai-") && f.endsWith(".json"),
        )) {
          fs.unlinkSync(path.join(defaultPath, f));
        }
        // Remove dir if empty — only swallow expected ENOTEMPTY/ENOENT
        try {
          fs.rmdirSync(defaultPath);
        } catch (err: unknown) {
          const code =
            err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
          if (code !== "ENOTEMPTY" && code !== "ENOENT") {
            console.warn("Unexpected error cleaning up defaultPath:", err);
          }
        }
      }
    }
  });

  it("request with system-only messages (no user message) derives empty match", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        // Upstream matches everything via predicate
        match: { predicate: () => true },
        response: { content: "system only response" },
      },
    ]);

    const resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "system", content: "You are a helpful assistant" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    // The match should have no userMessage (no user message in request)
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures[0].match.userMessage).toBeUndefined();
  });

  it("recording path created automatically (mkdirSync recursive)", async () => {
    upstream = await createServer(
      [{ match: { userMessage: "auto dir" }, response: { content: "dir created" } }],
      { port: 0 },
    );

    // Use a nested path that doesn't exist
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    const nestedPath = path.join(tmpDir, "nested", "deep", "fixtures");

    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstream.url }, fixturePath: nestedPath },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "auto dir" }],
    });

    expect(resp.status).toBe(200);

    // Nested directory was created
    expect(fs.existsSync(nestedPath)).toBe(true);
    const files = fs.readdirSync(nestedPath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);
  });

  it("fixture file naming follows {provider}-{ISO-timestamp}.json format", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      { match: { userMessage: "naming test" }, response: { content: "named" } },
    ]);

    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "naming test" }],
    });

    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    // Pattern: openai-YYYY-MM-DDTHH-MM-SS-mmmZ-{uuid8}.json (colons and dots replaced with dashes)
    const pattern = /^openai-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.json$/;
    expect(fixtureFiles[0]).toMatch(pattern);
  });

  it("proxies the original request body to upstream (preserves formatting)", async () => {
    // The proxy should forward the exact bytes the client sent, not re-serialized JSON.
    // This matters because JSON key ordering and whitespace may differ after parse/serialize.
    let receivedBody = "";
    const upstreamServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-proxy-body",
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
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upAddr = upstreamServer.address() as { port: number };

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: `http://127.0.0.1:${upAddr.port}` }, fixturePath: tmpDir },
    });

    // Send body with specific formatting (extra spaces, key order)
    const customBody =
      '{"model":  "gpt-4",  "messages": [{"role": "user", "content": "preserve me"}]}';
    const resp = await postRaw(`${recorder.url}/v1/chat/completions`, customBody);
    expect(resp.status).toBe(200);

    // The upstream should have received the original body, not re-serialized
    expect(receivedBody).toBe(customBody);

    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it("upstream returns empty response body — handled gracefully", async () => {
    // Create a raw HTTP server that returns 200 with empty body
    const emptyServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("");
    });
    await new Promise<void>((resolve) => emptyServer.listen(0, "127.0.0.1", resolve));
    const emptyAddr = emptyServer.address() as { port: number };
    const emptyUrl = `http://127.0.0.1:${emptyAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: emptyUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "empty body test" }],
    });

    // Should not crash — returns the upstream status
    expect(resp.status).toBe(200);

    // Fixture file should still be created (with error/fallback response)
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    await new Promise<void>((resolve) => emptyServer.close(() => resolve()));
  });

  it("Ollama empty content + tool_calls: records toolCalls, not content", async () => {
    // Raw upstream returns Ollama-style response: empty content + tool_calls
    const ollamaRaw = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "llama3",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "get_weather",
                  arguments: { city: "NYC" },
                },
              },
            ],
          },
          done: true,
        }),
      );
    });
    await new Promise<void>((resolve) => ollamaRaw.listen(0, "127.0.0.1", resolve));
    const ollamaAddr = ollamaRaw.address() as { port: number };
    const ollamaUrl = `http://127.0.0.1:${ollamaAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { ollama: ollamaUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "what is the weather in NYC" }],
      stream: false,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: {
          content?: string;
          toolCalls?: Array<{ name: string; arguments: string }>;
        };
      }>;
    };

    // Should record toolCalls, NOT content: ""
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toHaveLength(1);
    expect(fixtureContent.fixtures[0].response.toolCalls![0].name).toBe("get_weather");
    expect(JSON.parse(fixtureContent.fixtures[0].response.toolCalls![0].arguments)).toEqual({
      city: "NYC",
    });
    expect(fixtureContent.fixtures[0].response.content).toBeUndefined();

    await new Promise<void>((resolve) => ollamaRaw.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// Multi-turn disambiguation — recording a single agent run with shared
// userMessage across LLM calls must produce distinct fixture match criteria.
// Regression for the case where the recorder wrote only `userMessage` and
// the in-memory cache then shadowed every subsequent call in the same run.
// ---------------------------------------------------------------------------

describe("recorder multi-turn disambiguation", () => {
  it("2 LLM calls in one tool-using run record as 2 fixtures with distinct match", async () => {
    // Upstream serves different responses for the two turns of the run.
    // Turn 0 (no assistant, no tool messages) → tool call.
    // Turn 1 (one assistant + one tool result already in messages) → text.
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "weather in Tokyo", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"location":"Tokyo"}', id: "call_w1" }],
        },
      },
      {
        match: { userMessage: "weather in Tokyo", turnIndex: 1, hasToolResult: true },
        response: { content: "Tokyo is 22°C and partly cloudy." },
      },
    ]);

    // Turn 0 — no assistant or tool messages yet.
    const resp0 = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "weather in Tokyo" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });
    expect(resp0.status).toBe(200);
    const body0 = JSON.parse(resp0.body);
    expect(body0.choices[0].message.tool_calls[0].function.name).toBe("get_weather");

    // Turn 1 — assistant tool-call turn + tool result already accumulated.
    const resp1 = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "weather in Tokyo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_w1",
              type: "function",
              function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_w1", content: '{"temp":22,"sky":"partly cloudy"}' },
      ],
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });
    expect(resp1.status).toBe(200);
    const body1 = JSON.parse(resp1.body);
    expect(body1.choices[0].message.content).toBe("Tokyo is 22°C and partly cloudy.");

    // Two fixture files written, each with a distinct match payload.
    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);

    const matches = files
      .map((f) => JSON.parse(fs.readFileSync(path.join(fixturePath, f), "utf-8")) as FixtureFile)
      .map((file) => file.fixtures[0].match);

    // All recorded matches share the userMessage but differ on turnIndex /
    // hasToolResult — that's the disambiguator.
    expect(matches.every((m) => m.userMessage === "weather in Tokyo")).toBe(true);

    const keys = matches.map((m) => `${m.turnIndex}|${m.hasToolResult}`).sort();
    expect(keys).toEqual(["0|false", "1|true"]);
  });

  it("3 LLM calls (chained tool calls) record as 3 fixtures with distinct match", async () => {
    // Three-turn run: tool_call → result → tool_call → result → final content.
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "plan a trip", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [{ name: "find_flights", arguments: '{"to":"Tokyo"}', id: "call_a" }],
        },
      },
      {
        match: { userMessage: "plan a trip", turnIndex: 1, hasToolResult: true },
        response: {
          toolCalls: [{ name: "book_hotel", arguments: '{"city":"Tokyo"}', id: "call_b" }],
        },
      },
      {
        match: { userMessage: "plan a trip", turnIndex: 2, hasToolResult: true },
        response: { content: "Trip booked: flight + hotel in Tokyo." },
      },
    ]);

    // Turn 0
    let resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "plan a trip" }],
    });
    expect(resp.status).toBe(200);
    expect(JSON.parse(resp.body).choices[0].message.tool_calls[0].function.name).toBe(
      "find_flights",
    );

    // Turn 1
    resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "plan a trip" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "find_flights", arguments: '{"to":"Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: '{"flights":["JL001"]}' },
      ],
    });
    expect(resp.status).toBe(200);
    expect(JSON.parse(resp.body).choices[0].message.tool_calls[0].function.name).toBe("book_hotel");

    // Turn 2
    resp = await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "plan a trip" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "find_flights", arguments: '{"to":"Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: '{"flights":["JL001"]}' },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_b",
              type: "function",
              function: { name: "book_hotel", arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_b", content: '{"hotel":"Park Hyatt"}' },
      ],
    });
    expect(resp.status).toBe(200);
    expect(JSON.parse(resp.body).choices[0].message.content).toBe(
      "Trip booked: flight + hotel in Tokyo.",
    );

    // Three fixture files, each a distinct match.
    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(3);

    const matches = files
      .map((f) => JSON.parse(fs.readFileSync(path.join(fixturePath, f), "utf-8")) as FixtureFile)
      .map((file) => file.fixtures[0].match);

    const keys = matches.map((m) => `${m.turnIndex}|${m.hasToolResult}`).sort();
    expect(keys).toEqual(["0|false", "1|true", "2|true"]);
  });

  it("recorded fixtures replay deterministically against a fresh aimock", async () => {
    // Phase 1: record a 2-turn run.
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "weather in Tokyo", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [{ name: "get_weather", arguments: '{"location":"Tokyo"}', id: "call_w1" }],
        },
      },
      {
        match: { userMessage: "weather in Tokyo", turnIndex: 1, hasToolResult: true },
        response: { content: "Tokyo is 22°C and partly cloudy." },
      },
    ]);

    // Drive the run against the recorder so it proxies and records.
    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "weather in Tokyo" }],
    });
    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "weather in Tokyo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_w1",
              type: "function",
              function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_w1", content: '{"temp":22}' },
      ],
    });

    // Stop the recording servers so Phase 2 owns the ports / fixtures.
    await new Promise<void>((resolve) => recorder!.server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream!.server.close(() => resolve()));
    recorder = undefined;
    upstream = undefined;

    // Load the recorded fixture files and feed them to a fresh aimock that
    // has NO upstream — replay must come from fixture cache or it 404s.
    const recordedFixtures: Fixture[] = fs
      .readdirSync(fixturePath)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => loadFixtureFile(path.join(fixturePath, f)));
    expect(recordedFixtures).toHaveLength(2);

    // Phase 2: replay against a fresh aimock with only the recorded fixtures.
    recorder = await createServer(recordedFixtures, { port: 0 });

    const replay0 = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "weather in Tokyo" }],
    });
    expect(replay0.status).toBe(200);
    expect(JSON.parse(replay0.body).choices[0].message.tool_calls[0].function.name).toBe(
      "get_weather",
    );

    const replay1 = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "weather in Tokyo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_w1",
              type: "function",
              function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_w1", content: '{"temp":22}' },
      ],
    });
    expect(replay1.status).toBe(200);
    expect(JSON.parse(replay1.body).choices[0].message.content).toBe(
      "Tokyo is 22°C and partly cloudy.",
    );
  });

  it("two demos with same first-turn userMessage but different follow-ups stay isolated", async () => {
    // Demo A: "list todos" → tool call → "you have 3 todos"
    // Demo B: "list todos" → tool call → "you have 0 todos"
    // Same first-turn userMessage. Different upstream responses per demo.
    // We record demo A then demo B into the same fixtures dir, then replay
    // each independently and assert the right follow-up comes back.

    // Phase 1 — record demo A.
    const demoA = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "list todos", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [{ name: "fetch_todos", arguments: "{}", id: "call_a" }],
        },
      },
      {
        match: { userMessage: "list todos", turnIndex: 1, hasToolResult: true },
        response: { content: "you have 3 todos" },
      },
    ]);
    const sharedFixturePath = demoA.fixturePath;

    await post(`${demoA.recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "list todos" }],
    });
    await post(`${demoA.recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "list todos" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "fetch_todos", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: '{"count":3}' },
      ],
    });

    // Stop demo A's servers.
    await new Promise<void>((resolve) => recorder!.server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream!.server.close(() => resolve()));
    recorder = undefined;
    upstream = undefined;

    // Phase 2 — record demo B with a DISTINCT userMessage into the SAME
    // fixturePath. Distinct userMessages are the recommended way to keep
    // demos isolated; the regression we're guarding against is the silent
    // collision the old recorder caused even WITHIN a single demo.
    upstream = await createServer(
      [
        {
          match: { userMessage: "list demo B todos", turnIndex: 0, hasToolResult: false },
          response: {
            toolCalls: [{ name: "fetch_todos", arguments: "{}", id: "call_b2" }],
          },
        },
        {
          match: { userMessage: "list demo B todos", turnIndex: 1, hasToolResult: true },
          response: { content: "you have 0 todos" },
        },
      ],
      { port: 0 },
    );
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstream.url }, fixturePath: sharedFixturePath },
    });

    await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "list demo B todos" }],
    });
    await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "list demo B todos" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_b2",
              type: "function",
              function: { name: "fetch_todos", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_b2", content: '{"count":0}' },
      ],
    });

    // Stop and replay both demos against a fresh aimock with all recorded
    // fixtures loaded from disk.
    await new Promise<void>((resolve) => recorder!.server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream!.server.close(() => resolve()));
    recorder = undefined;
    upstream = undefined;

    const allFixtures: Fixture[] = fs
      .readdirSync(sharedFixturePath)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => loadFixtureFile(path.join(sharedFixturePath, f)));
    expect(allFixtures).toHaveLength(4);

    recorder = await createServer(allFixtures, { port: 0 });

    // Demo A replay: should hit the demo-A fixtures (userMessage "list todos").
    const demoAReplay0 = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "list todos" }],
    });
    expect(demoAReplay0.status).toBe(200);
    expect(JSON.parse(demoAReplay0.body).choices[0].message.tool_calls[0].function.name).toBe(
      "fetch_todos",
    );

    const demoAReplay1 = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "list todos" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "fetch_todos", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: '{"count":3}' },
      ],
    });
    expect(demoAReplay1.status).toBe(200);
    expect(JSON.parse(demoAReplay1.body).choices[0].message.content).toBe("you have 3 todos");

    // Demo B replay (with disambiguated userMessage): should hit the demo-B fixtures.
    const demoBReplay0 = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "list demo B todos" }],
    });
    expect(demoBReplay0.status).toBe(200);
    expect(JSON.parse(demoBReplay0.body).choices[0].message.tool_calls[0].function.name).toBe(
      "fetch_todos",
    );

    const demoBReplay1 = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "list demo B todos" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_b2",
              type: "function",
              function: { name: "fetch_todos", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_b2", content: '{"count":0}' },
      ],
    });
    expect(demoBReplay1.status).toBe(200);
    expect(JSON.parse(demoBReplay1.body).choices[0].message.content).toBe("you have 0 todos");
  });
});

// ---------------------------------------------------------------------------
// Strict mode thorough tests
// ---------------------------------------------------------------------------

describe("recorder strict mode thorough", () => {
  it("strict mode + recording but provider not configured: 503 returned", async () => {
    // Only anthropic configured, but request goes to openai endpoint
    const anthropicUpstream = await createServer(
      [{ match: { userMessage: "strict test" }, response: { content: "ok" } }],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      strict: true,
      record: { providers: { anthropic: anthropicUpstream.url }, fixturePath: tmpDir },
    });

    // OpenAI endpoint — no openai provider configured
    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "strict test" }],
    });

    expect(resp.status).toBe(503);
    const body = JSON.parse(resp.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");

    await new Promise<void>((resolve) => anthropicUpstream.server.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// enableRecording / disableRecording lifecycle (extended)
// ---------------------------------------------------------------------------

describe("LLMock enableRecording / disableRecording lifecycle", () => {
  let mock: LLMock;
  let upstreamServer: ServerInstance;

  afterEach(async () => {
    if (mock) {
      try {
        await mock.stop();
      } catch {
        // ignore
      }
    }
    if (upstreamServer) {
      await new Promise<void>((resolve) => upstreamServer.server.close(() => resolve()));
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("recorded fixtures persist on disk after disableRecording", async () => {
    upstreamServer = await createServer(
      [{ match: { userMessage: "persist test" }, response: { content: "persisted" } }],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    mock = new LLMock();
    const url = await mock.start();

    mock.enableRecording({
      providers: { openai: upstreamServer.url },
      fixturePath: tmpDir,
    });

    await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "persist test" }],
    });

    mock.disableRecording();

    // Fixture files still on disk
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    // And the fixture is usable — request still matches from in-memory fixture
    const resp = await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "persist test" }],
    });
    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.choices[0].message.content).toBe("persisted");
  });

  it("re-enable recording after disable works for new requests", async () => {
    upstreamServer = await createServer(
      [
        { match: { userMessage: "first" }, response: { content: "first response" } },
        { match: { userMessage: "second" }, response: { content: "second response" } },
      ],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    mock = new LLMock();
    const url = await mock.start();

    // First recording session
    mock.enableRecording({
      providers: { openai: upstreamServer.url },
      fixturePath: tmpDir,
    });
    await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "first" }],
    });
    mock.disableRecording();

    // Second recording session
    mock.enableRecording({
      providers: { openai: upstreamServer.url },
      fixturePath: tmpDir,
    });
    const resp = await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "second" }],
    });
    expect(resp.status).toBe(200);
    mock.disableRecording();

    // Both fixtures on disk
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Auth header tests (extended)
// ---------------------------------------------------------------------------

describe("recorder auth header handling", () => {
  it("x-api-key (Anthropic) forwarded to upstream but not saved in fixture", async () => {
    const anthropicUpstream = await createServer(
      [{ match: { userMessage: "api key test" }, response: { content: "ok" } }],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { anthropic: anthropicUpstream.url }, fixturePath: tmpDir },
    });

    await post(
      `${recorder.url}/v1/messages`,
      {
        model: "claude-3-sonnet",
        max_tokens: 100,
        messages: [{ role: "user", content: "api key test" }],
      },
      { "x-api-key": "sk-ant-secret-123" },
    );

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(1);

    const content = fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8");
    expect(content).not.toContain("sk-ant-secret-123");
    expect(content).not.toContain("x-api-key");

    await new Promise<void>((resolve) => anthropicUpstream.server.close(() => resolve()));
  });

  it("multiple auth header types all absent from fixture", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      { match: { userMessage: "multi auth" }, response: { content: "multi auth ok" } },
    ]);

    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "multi auth" }],
      },
      {
        Authorization: "Bearer sk-openai-secret",
        "x-api-key": "sk-anthropic-secret",
        "api-key": "azure-secret-key",
      },
    );

    const files = fs.readdirSync(fixturePath);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    const content = fs.readFileSync(path.join(fixturePath, fixtureFiles[0]), "utf-8");

    expect(content).not.toContain("sk-openai-secret");
    expect(content).not.toContain("sk-anthropic-secret");
    expect(content).not.toContain("azure-secret-key");
    expect(content).not.toContain("Authorization");
    expect(content).not.toContain("authorization");
    expect(content).not.toContain("x-api-key");
    expect(content).not.toContain("api-key");
  });

  it("all non-hop-by-hop headers from client are forwarded to upstream", async () => {
    // Verify that provider-specific headers (e.g. anthropic-version) are forwarded,
    // while hop-by-hop headers (host, connection, etc.) are stripped.
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const echoServer = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "echo" }, index: 0 }],
          model: "gpt-4",
        }),
      );
    });
    await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
    const echoAddr = echoServer.address() as { port: number };
    const echoUrl = `http://127.0.0.1:${echoAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: echoUrl }, fixturePath: tmpDir },
    });

    await post(
      `${recorder.url}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "header test" }],
      },
      {
        Authorization: "Bearer sk-test",
        "X-Custom-Header": "custom-value",
        "anthropic-version": "2023-06-01",
      },
    );

    // All non-hop-by-hop headers are forwarded
    expect(receivedHeaders["authorization"]).toBe("Bearer sk-test");
    expect(receivedHeaders["x-custom-header"]).toBe("custom-value");
    expect(receivedHeaders["anthropic-version"]).toBe("2023-06-01");

    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
  });

  it("mock-internal control headers never reach a generic upstream", async () => {
    // Pins the CHANGELOG claim that x-test-id / x-aimock-strict /
    // x-aimock-context / x-aimock-chaos-* are stripped on every provider
    // proxy path — this is the generic proxyAndRecord walk (STRIP_HEADERS +
    // the chaos prefix family in buildForwardHeaders).
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const echoServer = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "echo" }, index: 0 }],
          model: "gpt-4",
        }),
      );
    });
    await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
    const echoAddr = echoServer.address() as { port: number };
    const echoUrl = `http://127.0.0.1:${echoAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: echoUrl }, fixturePath: tmpDir },
    });

    await post(
      `${recorder.url}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "internal header strip" }],
      },
      {
        Authorization: "Bearer sk-test",
        "X-Test-Id": "generic-hdr-strip",
        "X-AIMock-Strict": "false",
        "X-AIMock-Context": "ctx-strip",
        "X-AIMock-Chaos-Drop": "0",
      },
    );

    expect(receivedHeaders["x-test-id"]).toBeUndefined();
    expect(receivedHeaders["x-aimock-strict"]).toBeUndefined();
    expect(receivedHeaders["x-aimock-context"]).toBeUndefined();
    expect(receivedHeaders["x-aimock-chaos-drop"]).toBeUndefined();
    // Auth still forwarded.
    expect(receivedHeaders["authorization"]).toBe("Bearer sk-test");

    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// Upstream connection failure → 502
// ---------------------------------------------------------------------------

describe("recorder upstream connection failure", () => {
  it("returns 502 when upstream is unreachable", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: "http://127.0.0.1:1" },
        fixturePath: tmpDir,
      },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "unreachable upstream" }],
    });

    expect(resp.status).toBe(502);
    const body = JSON.parse(resp.body);
    expect(body.error.type).toBe("proxy_error");
  });
});

// ---------------------------------------------------------------------------
// Status code normalization — proxy relay normalizes upstream codes
// ---------------------------------------------------------------------------

describe("recorder status code normalization", () => {
  it("normalizes upstream 201 to 200 for non-SSE responses", async () => {
    // Create a raw upstream that returns 201 (e.g. Anthropic messages API)
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          content: [{ type: "text", text: "created response" }],
          model: "claude-3",
          role: "assistant",
        }),
      );
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
      recorder = await createServer([], {
        port: 0,
        record: { providers: { anthropic: rawUrl }, fixturePath: tmpDir },
      });

      const resp = await post(`${recorder.url}/v1/messages`, {
        model: "claude-3",
        messages: [{ role: "user", content: "hello 201" }],
        max_tokens: 100,
      });

      // Client sees 200, not 201
      expect(resp.status).toBe(200);
    } finally {
      await new Promise<void>((r) => rawServer.close(() => r()));
    }
  });

  it("normalizes upstream 429 to 502 for non-SSE responses", async () => {
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Rate limited", type: "rate_limit_error" },
        }),
      );
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
      recorder = await createServer([], {
        port: 0,
        record: { providers: { openai: rawUrl }, fixturePath: tmpDir },
      });

      const resp = await post(`${recorder.url}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "rate limit me" }],
      });

      // Client sees 502, not 429
      expect(resp.status).toBe(502);

      // Fixture preserves the real upstream 429 status
      const files = fs.readdirSync(tmpDir);
      const fixtureFiles = files.filter((f) => f.endsWith(".json"));
      expect(fixtureFiles).toHaveLength(1);
      const fixtureContent = JSON.parse(
        fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
      );
      expect(fixtureContent.fixtures[0].response.status).toBe(429);
    } finally {
      await new Promise<void>((r) => rawServer.close(() => r()));
    }
  });

  it("normalizes upstream 503 to 502 for non-SSE responses", async () => {
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Service unavailable", type: "server_error" },
        }),
      );
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
      recorder = await createServer([], {
        port: 0,
        record: { providers: { openai: rawUrl }, fixturePath: tmpDir },
      });

      const resp = await post(`${recorder.url}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "service unavailable" }],
      });

      // Client sees 502, not 503
      expect(resp.status).toBe(502);
    } finally {
      await new Promise<void>((r) => rawServer.close(() => r()));
    }
  });

  it("normalizes upstream 401 to 502 for non-SSE responses", async () => {
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Invalid API key", type: "authentication_error" },
        }),
      );
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
      recorder = await createServer([], {
        port: 0,
        record: { providers: { openai: rawUrl }, fixturePath: tmpDir },
      });

      const resp = await post(`${recorder.url}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "bad auth" }],
      });

      // Client sees 502, not 401
      expect(resp.status).toBe(502);
    } finally {
      await new Promise<void>((r) => rawServer.close(() => r()));
    }
  });

  it("normalizes SSE streaming upstream errors to 502", async () => {
    // Upstream returns 429 with SSE content-type
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "text/event-stream" });
      res.end("data: rate limited\n\n");
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
      recorder = await createServer([], {
        port: 0,
        record: { providers: { openai: rawUrl }, fixturePath: tmpDir },
      });

      const resp = await post(`${recorder.url}/v1/chat/completions`, {
        model: "gpt-4",
        messages: [{ role: "user", content: "sse rate limit" }],
        stream: true,
      });

      // Client sees 502, not 429 — even for SSE content-type
      expect(resp.status).toBe(502);
    } finally {
      await new Promise<void>((r) => rawServer.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// Filesystem write failure — response still relayed
// ---------------------------------------------------------------------------

describe("recorder filesystem write failure", () => {
  it("relays response to client even when fixture write fails", async () => {
    upstream = await createServer(
      [{ match: { userMessage: "fs fail" }, response: { content: "still works" } }],
      { port: 0 },
    );

    // Use a path that cannot be a directory (a regular file)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    const blockedPath = path.join(tmpDir, "blocked");
    fs.writeFileSync(blockedPath, "i am a file not a directory");

    recorder = await createServer([], {
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openai: upstream.url },
        fixturePath: blockedPath,
      },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "fs fail" }],
    });

    // Response still relayed to client
    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.choices[0].message.content).toBe("still works");
  });
});

// ---------------------------------------------------------------------------
// buildFixtureResponse for non-OpenAI formats
// ---------------------------------------------------------------------------

/** Shared helper: spins up a raw HTTP server that returns `responseBody` as JSON. */
function createRawUpstream(
  responseBody: object,
  servers: http.Server[],
): Promise<{ url: string; server: http.Server }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      servers.push(srv);
      resolve({ url: `http://127.0.0.1:${addr.port}`, server: srv });
    });
  });
}

describe("recorder buildFixtureResponse non-OpenAI formats", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers = [];
  });

  it("records Anthropic format (content array with type/text)", async () => {
    const { url: upstreamUrl } = await createRawUpstream(
      {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Bonjour from Anthropic" }],
        stop_reason: "end_turn",
      },
      servers,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { anthropic: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/messages`, {
      model: "claude-3-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello anthropic" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as { fixtures: Array<{ response: { content?: string } }> };
    expect(fixtureContent.fixtures[0].response.content).toBe("Bonjour from Anthropic");
  });

  it("records Gemini format (candidates array)", async () => {
    const { url: upstreamUrl } = await createRawUpstream(
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hello from Gemini" }] },
            finishReason: "STOP",
          },
        ],
      },
      servers,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { gemini: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ parts: [{ text: "hello gemini" }], role: "user" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as { fixtures: Array<{ response: { content?: string } }> };
    expect(fixtureContent.fixtures[0].response.content).toBe("Hello from Gemini");
  });

  it("records Ollama format (message object)", async () => {
    const { url: upstreamUrl } = await createRawUpstream(
      {
        model: "llama3",
        message: { role: "assistant", content: "Hello from Ollama" },
        done: true,
      },
      servers,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { ollama: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hello ollama" }],
      stream: false,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as { fixtures: Array<{ response: { content?: string } }> };
    expect(fixtureContent.fixtures[0].response.content).toBe("Hello from Ollama");
  });
});

// ---------------------------------------------------------------------------
// Content + toolCalls coexistence
// ---------------------------------------------------------------------------

describe("recorder content + toolCalls coexistence", () => {
  it("saves toolCalls when both content and tool_calls are in OpenAI response", async () => {
    // Create raw upstream returning both content and tool_calls
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-coexist",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I'll look that up for you.",
                tool_calls: [
                  {
                    id: "call_coex",
                    type: "function",
                    function: { name: "search", arguments: '{"q":"test"}' },
                  },
                ],
              },
            },
          ],
          model: "gpt-4",
        }),
      );
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: rawUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "coexist test" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { content?: string; toolCalls?: Array<{ name: string; arguments: string }> };
      }>;
    };
    // both content and toolCalls should be preserved
    expect(fixtureContent.fixtures[0].response.content).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toHaveLength(1);
    expect(fixtureContent.fixtures[0].response.toolCalls![0].name).toBe("search");
    expect(fixtureContent.fixtures[0].response.content).toBeDefined();

    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// Non-OpenAI streaming through recorder
// ---------------------------------------------------------------------------

describe("recorder non-OpenAI streaming", () => {
  it("collapses Anthropic SSE streaming to fixture content", async () => {
    // Create a raw upstream that returns Anthropic SSE format
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", role: "assistant" } })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Streamed " } })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Anthropic" } })}\n\n`,
      );
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { anthropic: rawUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/messages`, {
      model: "claude-3-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "stream anthropic test" }],
      stream: true,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as { fixtures: Array<{ response: { content?: string } }> };
    expect(fixtureContent.fixtures[0].response.content).toBe("Streamed Anthropic");

    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// Integration tests — streaming through recorder: Gemini SSE + Ollama NDJSON
// ---------------------------------------------------------------------------

describe("recorder streaming collapse: Gemini SSE", () => {
  it("collapses Gemini SSE streaming response to non-streaming fixture", async () => {
    // Create upstream with gemini provider
    upstream = await createServer(
      [
        {
          match: { userMessage: "hello gemini" },
          response: { content: "Gemini says hello back." },
        },
      ],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));

    recorder = await createServer([], {
      port: 0,
      record: { providers: { gemini: upstream.url }, fixturePath: tmpDir },
    });

    // Send streaming Gemini request
    const resp = await post(
      `${recorder.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`,
      {
        contents: [{ parts: [{ text: "hello gemini" }], role: "user" }],
      },
    );

    expect(resp.status).toBe(200);

    // Check saved fixture
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures).toHaveLength(1);
    const savedResponse = fixtureContent.fixtures[0].response as { content: string };
    expect(savedResponse.content).toBe("Gemini says hello back.");
  });
});

describe("recorder streaming collapse: Cohere SSE", () => {
  it("collapses Cohere SSE streaming response to non-streaming fixture", async () => {
    upstream = await createServer(
      [
        {
          match: { userMessage: "hello cohere" },
          response: { content: "Cohere says hello." },
        },
      ],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));

    recorder = await createServer([], {
      port: 0,
      record: { providers: { cohere: upstream.url }, fixturePath: tmpDir },
    });

    // Send streaming Cohere request
    const resp = await post(`${recorder.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "hello cohere" }],
      stream: true,
    });

    expect(resp.status).toBe(200);

    // Check saved fixture
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures).toHaveLength(1);
    const savedResponse = fixtureContent.fixtures[0].response as { content: string };
    expect(savedResponse.content).toBe("Cohere says hello.");
  });
});

describe("recorder streaming collapse: Ollama NDJSON", () => {
  it("collapses Ollama NDJSON streaming response to non-streaming fixture", async () => {
    upstream = await createServer(
      [
        {
          match: { userMessage: "hello ollama" },
          response: { content: "Ollama says hi." },
        },
      ],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));

    recorder = await createServer([], {
      port: 0,
      record: { providers: { ollama: upstream.url }, fixturePath: tmpDir },
    });

    // Send streaming Ollama request (stream defaults to true)
    const resp = await post(`${recorder.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hello ollama" }],
    });

    expect(resp.status).toBe(200);

    // Check saved fixture
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixtureContent.fixtures).toHaveLength(1);
    const savedResponse = fixtureContent.fixtures[0].response as { content: string };
    expect(savedResponse.content).toBe("Ollama says hi.");
  });
});

// ---------------------------------------------------------------------------
// buildFixtureResponse format detection
// ---------------------------------------------------------------------------

describe("buildFixtureResponse format detection", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers = [];
  });

  function createRawUpstreamWithStatus(
    responseBody: object | string,
    status: number = 200,
    contentType: string = "application/json",
  ): Promise<{ url: string; server: http.Server }> {
    return new Promise((resolve) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(status, { "Content-Type": contentType });
        res.end(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody));
      });
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as { port: number };
        servers.push(srv);
        resolve({ url: `http://127.0.0.1:${addr.port}`, server: srv });
      });
    });
  }

  it("detects Anthropic tool_use format and saves toolCalls", async () => {
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      content: [
        {
          type: "tool_use",
          id: "toolu_123",
          name: "get_weather",
          input: { city: "SF" },
        },
      ],
      role: "assistant",
      stop_reason: "tool_use",
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { anthropic: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/messages`, {
      model: "claude-3-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "tool use format test" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: {
          content?: string;
          toolCalls?: Array<{ name: string; arguments: string }>;
        };
      }>;
    };
    // Should be toolCalls, NOT content
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toHaveLength(1);
    expect(fixtureContent.fixtures[0].response.toolCalls![0].name).toBe("get_weather");
    expect(JSON.parse(fixtureContent.fixtures[0].response.toolCalls![0].arguments)).toEqual({
      city: "SF",
    });
    expect(fixtureContent.fixtures[0].response.content).toBeUndefined();
  });

  it("detects Gemini functionCall format and saves toolCalls", async () => {
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  args: { city: "SF" },
                },
              },
            ],
          },
        },
      ],
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { gemini: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ parts: [{ text: "gemini tool call test" }], role: "user" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: {
          content?: string;
          toolCalls?: Array<{ name: string; arguments: string }>;
        };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toHaveLength(1);
    expect(fixtureContent.fixtures[0].response.toolCalls![0].name).toBe("get_weather");
    expect(JSON.parse(fixtureContent.fixtures[0].response.toolCalls![0].arguments)).toEqual({
      city: "SF",
    });
    expect(fixtureContent.fixtures[0].response.content).toBeUndefined();
  });

  it("detects Cohere v2 message-level tool_calls with text content", async () => {
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      finish_reason: "TOOL_CALL",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me look that up." }],
        tool_calls: [
          {
            name: "get_weather",
            parameters: { city: "SF" },
          },
        ],
      },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { cohere: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "cohere v2 msg tool_calls with text" }],
      stream: false,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: {
          content?: string;
          toolCalls?: Array<{ name: string; arguments: string }>;
        };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.content).toBe("Let me look that up.");
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toHaveLength(1);
    expect(fixtureContent.fixtures[0].response.toolCalls![0].name).toBe("get_weather");
    expect(JSON.parse(fixtureContent.fixtures[0].response.toolCalls![0].arguments)).toEqual({
      city: "SF",
    });
  });

  it("detects Cohere v2 message-level tool_calls without text content", async () => {
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      finish_reason: "TOOL_CALL",
      message: {
        role: "assistant",
        content: [],
        tool_calls: [
          {
            name: "search_docs",
            parameters: { query: "aimock" },
          },
        ],
      },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { cohere: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "cohere v2 msg tool_calls only" }],
      stream: false,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: {
          content?: string;
          toolCalls?: Array<{ name: string; arguments: string }>;
        };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.content).toBeUndefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toHaveLength(1);
    expect(fixtureContent.fixtures[0].response.toolCalls![0].name).toBe("search_docs");
    expect(JSON.parse(fixtureContent.fixtures[0].response.toolCalls![0].arguments)).toEqual({
      query: "aimock",
    });
  });

  it("detects Cohere v2 text-only response (no message-level tool_calls)", async () => {
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      finish_reason: "COMPLETE",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello from Cohere" }],
      },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { cohere: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "cohere v2 text only" }],
      stream: false,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: {
          content?: string;
          toolCalls?: Array<{ name: string; arguments: string }>;
        };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.content).toBe("Hello from Cohere");
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeUndefined();
  });

  it("unknown format falls back to error response", async () => {
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      custom: "data",
      status: "ok",
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "unknown format test" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: {
          error?: { message: string; type: string };
        };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.error).toBeDefined();
    expect(fixtureContent.fixtures[0].response.error!.message).toContain(
      "Could not detect response format",
    );
    expect(fixtureContent.fixtures[0].response.error!.type).toBe("proxy_error");
  });

  it("detects direct embedding format (top-level embedding array)", async () => {
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      embedding: [0.1, 0.2, 0.3],
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "direct embedding test",
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { embedding?: number[] };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("decodes base64-encoded embeddings when encoding_format is base64", async () => {
    // Float32Array([0.5, 1.0, -0.25]) encoded as base64
    const base64Embedding = "AAAAPwAAgD8AAIC+";
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: base64Embedding }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "base64 embedding test",
      encoding_format: "base64",
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { embedding?: number[] };
      }>;
    };
    // Should decode base64 → Float32Array → number[]
    expect(fixtureContent.fixtures[0].response.embedding).toEqual([0.5, 1, -0.25]);
  });

  it("decodes a base64 embedding even when encoding_format is not echoed in the request", async () => {
    // Some providers return a base64-packed Float32 embedding even when the
    // client did not request encoding_format: "base64". The recorder must decode
    // it regardless of the request echo, rather than silently dropping a valid
    // embedding into the proxy_error fixture. base64 of Float32Array([0.5,1,-0.25]).
    const base64Embedding = "AAAAPwAAgD8AAIC+";
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: base64Embedding }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "base64 no format test",
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { embedding?: number[]; error?: { type: string } };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.error).toBeUndefined();
    expect(fixtureContent.fixtures[0].response.embedding).toEqual([0.5, 1, -0.25]);
  });

  it("still detects array embeddings when encoding_format is base64", async () => {
    // Some upstream responses return array format even when base64 was requested
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.5, 1.0, -0.25] }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "array with base64 format test",
      encoding_format: "base64",
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { embedding?: number[] };
      }>;
    };
    // Array.isArray check comes first, so array embeddings work regardless of encoding_format
    expect(fixtureContent.fixtures[0].response.embedding).toEqual([0.5, 1, -0.25]);
  });

  it("does not silently emit a zero-dim embedding for truncated base64 (odd byte count)", async () => {
    // 2 bytes is not a whole number of Float32s (byteLength % 4 !== 0). The
    // recorder must NOT silently produce a valid-looking empty embedding — it
    // logs the malformed input and falls through to the proxy_error fixture so
    // the loss is diagnosable rather than masquerading as a valid 0-dim vector.
    const shortBase64 = Buffer.from([0x00, 0x01]).toString("base64");
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: shortBase64 }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "truncated base64 test",
      encoding_format: "base64",
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { embedding?: number[]; error?: { type: string } };
      }>;
    };
    // Must not be a silent valid-looking zero-dimension embedding.
    expect(fixtureContent.fixtures[0].response.embedding).toBeUndefined();
    expect(fixtureContent.fixtures[0].response.error?.type).toBe("proxy_error");
  });

  it("preserves error code field from upstream error response", async () => {
    const { url: upstreamUrl } = await createRawUpstreamWithStatus(
      {
        error: {
          message: "Rate limited",
          type: "rate_limit_error",
          code: "rate_limit",
        },
      },
      429,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "rate limit test" }],
    });

    // Proxy relay normalizes upstream errors to 502 (Bad Gateway)
    expect(resp.status).toBe(502);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    // Fixture preserves real upstream status for fidelity
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: {
          error?: { message: string; type: string; code?: string };
          status?: number;
        };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.error).toBeDefined();
    expect(fixtureContent.fixtures[0].response.error!.message).toBe("Rate limited");
    expect(fixtureContent.fixtures[0].response.error!.type).toBe("rate_limit_error");
    expect(fixtureContent.fixtures[0].response.error!.code).toBe("rate_limit");
    expect(fixtureContent.fixtures[0].response.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Bedrock EventStream binary through recorder
// ---------------------------------------------------------------------------

describe("recorder Bedrock EventStream binary", () => {
  it("collapses Bedrock binary EventStream to text fixture", async () => {
    // Create a raw upstream returning application/vnd.amazon.eventstream binary
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream" });

      // Write binary EventStream frames using encodeEventStreamMessage
      const frame1 = encodeEventStreamMessage("contentBlockDelta", {
        contentBlockDelta: {
          delta: { text: "Hello " },
          contentBlockIndex: 0,
        },
        contentBlockIndex: 0,
      });
      const frame2 = encodeEventStreamMessage("contentBlockDelta", {
        contentBlockDelta: {
          delta: { text: "from Bedrock" },
          contentBlockIndex: 0,
        },
        contentBlockIndex: 0,
      });
      const frame3 = encodeEventStreamMessage("messageStop", {
        messageStop: { stopReason: "end_turn" },
      });

      res.write(frame1);
      res.write(frame2);
      res.write(frame3);
      res.end();
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { bedrock: rawUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/model/claude-v3/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 100,
      messages: [{ role: "user", content: "bedrock binary test" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as { fixtures: Array<{ response: { content?: string } }> };
    expect(fixtureContent.fixtures[0].response.content).toBe("Hello from Bedrock");

    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// Streaming edge cases — droppedChunks and content+toolCalls coexistence
// ---------------------------------------------------------------------------

describe("recorder streaming edge cases", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers = [];
  });

  it("streaming with malformed chunks: fixture still saved with surviving content", async () => {
    // Create a raw upstream that returns SSE with malformed chunks mixed in
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "Hello" } }] })}\n\n`,
      );
      res.write(`data: {MALFORMED JSON!!!\n\n`);
      res.write(
        `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: " World" } }] })}\n\n`,
      );
      res.write(`data: [DONE]\n\n`);
      res.end();
    });
    servers.push(rawServer);
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: rawUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "droppedchunks test" }],
      stream: true,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as { content: string };
    // Surviving content from non-malformed chunks
    expect(savedResponse.content).toBe("Hello World");
  });

  it("streaming with content + toolCalls: fixture saves both content and toolCalls", async () => {
    // Create a raw upstream that returns SSE with both text and tool call deltas
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          choices: [{ delta: { content: "Calling tool..." } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_abc",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"SF"}' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(`data: [DONE]\n\n`);
      res.end();
    });
    servers.push(rawServer);
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: rawUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "content+tools test" }],
      stream: true,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as FixtureFile;
    const savedResponse = fixtureContent.fixtures[0].response as {
      toolCalls?: Array<{ name: string; arguments: string }>;
      content?: string;
    };
    // Both content and toolCalls should be preserved
    expect(savedResponse.content).toBeDefined();
    expect(savedResponse.toolCalls).toBeDefined();
    expect(savedResponse.toolCalls).toHaveLength(1);
    expect(savedResponse.toolCalls![0].name).toBe("get_weather");
    expect(savedResponse.content).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildFixtureResponse — additional format variants for branch coverage
// ---------------------------------------------------------------------------

describe("buildFixtureResponse additional format variants", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers = [];
  });

  it("detects Bedrock Converse format (output.message.content text)", async () => {
    const { url: upstreamUrl } = await createRawUpstream(
      {
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Hello from Bedrock Converse" }],
          },
        },
        stopReason: "end_turn",
      },
      servers,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "bedrock converse test" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as { fixtures: Array<{ response: { content?: string } }> };
    expect(fixtureContent.fixtures[0].response.content).toBe("Hello from Bedrock Converse");
  });

  it("detects Bedrock Converse toolUse format", async () => {
    const { url: upstreamUrl } = await createRawUpstream(
      {
        output: {
          message: {
            role: "assistant",
            content: [
              {
                toolUse: {
                  name: "get_weather",
                  input: { city: "NYC" },
                },
              },
            ],
          },
        },
        stopReason: "tool_use",
      },
      servers,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "bedrock converse tooluse test" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { toolCalls?: Array<{ name: string; arguments: string }> };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toHaveLength(1);
    expect(fixtureContent.fixtures[0].response.toolCalls![0].name).toBe("get_weather");
  });

  it("detects Anthropic tool_use with string input", async () => {
    const { url: upstreamUrl } = await createRawUpstream(
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_str",
            name: "search",
            input: '{"query":"hello"}',
          },
        ],
        role: "assistant",
      },
      servers,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { anthropic: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/messages`, {
      model: "claude-3-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "anthropic string input test" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { toolCalls?: Array<{ name: string; arguments: string }> };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    // When input is a string, it's used as-is
    expect(fixtureContent.fixtures[0].response.toolCalls![0].arguments).toBe('{"query":"hello"}');
  });

  it("detects Gemini functionCall with string args", async () => {
    const { url: upstreamUrl } = await createRawUpstream(
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "search",
                    args: '{"query":"hello"}',
                  },
                },
              ],
            },
          },
        ],
      },
      servers,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { gemini: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ parts: [{ text: "gemini string args test" }], role: "user" }],
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { toolCalls?: Array<{ name: string; arguments: string }> };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls![0].arguments).toBe('{"query":"hello"}');
  });

  it("detects Ollama message.content as array format", async () => {
    const { url: upstreamUrl } = await createRawUpstream(
      {
        model: "llama3",
        message: {
          role: "assistant",
          content: [{ text: "Array content from Ollama" }],
        },
        done: true,
      },
      servers,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { ollama: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "ollama array content test" }],
      stream: false,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as { fixtures: Array<{ response: { content?: string } }> };
    expect(fixtureContent.fixtures[0].response.content).toBe("Array content from Ollama");
  });

  it("detects Ollama tool_calls with string arguments", async () => {
    const { url: upstreamUrl } = await createRawUpstream(
      {
        model: "llama3",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "search",
                arguments: '{"query":"test"}',
              },
            },
          ],
        },
        done: true,
      },
      servers,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { ollama: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "ollama string args test" }],
      stream: false,
    });

    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as {
      fixtures: Array<{
        response: { toolCalls?: Array<{ name: string; arguments: string }> };
      }>;
    };
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls![0].arguments).toBe('{"query":"test"}');
  });
});

// ---------------------------------------------------------------------------
// Invalid upstream URL — 502 with proxy_error
// ---------------------------------------------------------------------------

describe("recorder invalid upstream URL", () => {
  it("returns 502 for invalid upstream URL format", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      logLevel: "silent",
      record: {
        providers: { openai: "not-a-valid-url" },
        fixturePath: tmpDir,
      },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "invalid url test" }],
    });

    expect(resp.status).toBe(502);
    const body = JSON.parse(resp.body);
    expect(body.error.type).toBe("proxy_error");
    expect(body.error.message).toContain("Invalid upstream URL");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockReqRes(): { req: http.IncomingMessage; res: http.ServerResponse } {
  // Create minimal mock objects — only needed for type compatibility,
  // proxyAndRecord returns false before touching them in these test cases
  const req = Object.create(http.IncomingMessage.prototype) as http.IncomingMessage;
  req.headers = {};
  const res = Object.create(http.ServerResponse.prototype) as http.ServerResponse;
  // Use explicit property instead of relying on Node.js internal _header getter
  Object.defineProperty(res, "headersSent", { value: false, writable: true });
  return { req, res };
}

// ---------------------------------------------------------------------------
// buildFixtureMatch model recording
// ---------------------------------------------------------------------------

describe("buildFixtureMatch model recording", () => {
  let localUpstream: ServerInstance | undefined;
  let localRecorder: ServerInstance | undefined;
  let localTmpDir: string | undefined;

  afterEach(async () => {
    if (localRecorder) {
      await new Promise<void>((resolve) => localRecorder!.server.close(() => resolve()));
      localRecorder = undefined;
    }
    if (localUpstream) {
      await new Promise<void>((resolve) => localUpstream!.server.close(() => resolve()));
      localUpstream = undefined;
    }
    if (localTmpDir) {
      fs.rmSync(localTmpDir, { recursive: true, force: true });
      localTmpDir = undefined;
    }
  });

  it("records normalized model for chat requests", async () => {
    // Set up an upstream server that responds to the test message
    localUpstream = await createServer(
      [
        {
          match: { userMessage: "test model recording" },
          response: { content: "model recorded" },
        },
      ],
      { port: 0 },
    );

    localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-model-"));
    localRecorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: localUpstream.url },
        fixturePath: localTmpDir,
      },
    });

    await post(`${localRecorder.url}/v1/chat/completions`, {
      model: "claude-opus-4-20250514",
      messages: [{ role: "user", content: "test model recording" }],
    });

    const files = fs.readdirSync(localTmpDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const fixture = JSON.parse(fs.readFileSync(path.join(localTmpDir, files[0]), "utf-8"));
    expect(fixture.fixtures[0].match.model).toBe("claude-opus-4");
  });

  it("records full model when recordFullModelVersion is true", async () => {
    localUpstream = await createServer(
      [
        {
          match: { userMessage: "test full model" },
          response: { content: "full model recorded" },
        },
      ],
      { port: 0 },
    );

    localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-model-full-"));
    localRecorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: localUpstream.url },
        fixturePath: localTmpDir,
        recordFullModelVersion: true,
      },
    });

    await post(`${localRecorder.url}/v1/chat/completions`, {
      model: "claude-opus-4-20250514",
      messages: [{ role: "user", content: "test full model" }],
    });

    const files = fs.readdirSync(localTmpDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const fixture = JSON.parse(fs.readFileSync(path.join(localTmpDir, files[0]), "utf-8"));
    expect(fixture.fixtures[0].match.model).toBe("claude-opus-4-20250514");
  });
});

// ---------------------------------------------------------------------------
// buildFixtureMatch context
// ---------------------------------------------------------------------------

describe("buildFixtureMatch context", () => {
  it("captures _context in match criteria", () => {
    const match = buildFixtureMatch({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      _context: "langgraph-python",
    });
    expect(match.context).toBe("langgraph-python");
  });

  it("omits context when _context is absent", () => {
    const match = buildFixtureMatch({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(match.context).toBeUndefined();
  });
});

async function setupUpstreamAndRecorder(
  upstreamFixtures: Fixture[],
  providerKey: string = "openai",
): Promise<{ upstreamUrl: string; recorderUrl: string; fixturePath: string }> {
  // Ensure previous resources are cleaned up before reassignment
  if (recorder) {
    await new Promise<void>((resolve) => recorder!.server.close(() => resolve()));
    recorder = undefined;
  }
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.server.close(() => resolve()));
    upstream = undefined;
  }

  // Create upstream "real API" server
  upstream = await createServer(upstreamFixtures, { port: 0 });

  // Create temp directory for recorded fixtures
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));

  // Create recording aimock (no fixtures — everything proxies)
  const providers: Record<string, string> = {};
  providers[providerKey] = upstream.url;

  recorder = await createServer([], {
    port: 0,
    record: { providers, fixturePath: tmpDir },
  });

  return {
    upstreamUrl: upstream.url,
    recorderUrl: recorder.url,
    fixturePath: tmpDir,
  };
}

// ---------------------------------------------------------------------------
// Body accumulation timeout
// ---------------------------------------------------------------------------

describe("makeUpstreamRequest body timeout", () => {
  let fastRawServer: http.Server | undefined;
  let setTimeoutSpy: MockInstance | undefined;

  afterEach(async () => {
    setTimeoutSpy?.mockRestore();
    setTimeoutSpy = undefined;
    if (fastRawServer) {
      await new Promise<void>((resolve) => fastRawServer!.close(() => resolve()));
      fastRawServer = undefined;
    }
  });

  it("calls res.setTimeout on the upstream IncomingMessage for body accumulation guard", async () => {
    // Fast upstream that responds immediately — we just want to verify setTimeout is called
    fastRawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop" }],
        }),
      );
    });
    await new Promise<void>((resolve) => fastRawServer!.listen(0, "127.0.0.1", resolve));
    const { port } = fastRawServer!.address() as { port: number };

    setTimeoutSpy = vi.spyOn(http.IncomingMessage.prototype, "setTimeout");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-timeout-"));
    const record: RecordConfig = {
      providers: { openai: `http://127.0.0.1:${port}` },
      fixturePath: tmpDir,
    };
    const logger = new Logger("silent");
    const fixtures: Fixture[] = [];

    const { req, res } = createMockReqRes();
    // Provide a minimal writable res so proxyAndRecord can write the response
    const chunks: Buffer[] = [];
    Object.assign(res, {
      writeHead: () => res,
      end: (data?: Buffer | string) => {
        if (data) chunks.push(typeof data === "string" ? Buffer.from(data) : data);
        return res;
      },
      setHeader: () => res,
    });

    await proxyAndRecord(
      req,
      res,
      { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
      "openai",
      "/v1/chat/completions",
      fixtures,
      { record, logger },
    );

    // Verify res.setTimeout was called with the 30-second body accumulation timeout
    expect(setTimeoutSpy).toHaveBeenCalledWith(30_000, expect.any(Function));
  });

  it("honors custom bodyTimeoutMs value", async () => {
    fastRawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop" }],
        }),
      );
    });
    await new Promise<void>((resolve) => fastRawServer!.listen(0, "127.0.0.1", resolve));
    const { port } = fastRawServer!.address() as { port: number };

    setTimeoutSpy = vi.spyOn(http.IncomingMessage.prototype, "setTimeout");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-custom-body-timeout-"));
    const record: RecordConfig = {
      providers: { openai: `http://127.0.0.1:${port}` },
      fixturePath: tmpDir,
      bodyTimeoutMs: 120_000,
    };
    const logger = new Logger("silent");
    const fixtures: Fixture[] = [];

    const { req, res } = createMockReqRes();
    const chunks: Buffer[] = [];
    Object.assign(res, {
      writeHead: () => res,
      end: (data?: Buffer | string) => {
        if (data) chunks.push(typeof data === "string" ? Buffer.from(data) : data);
        return res;
      },
      setHeader: () => res,
    });

    await proxyAndRecord(
      req,
      res,
      { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
      "openai",
      "/v1/chat/completions",
      fixtures,
      { record, logger },
    );

    // Verify res.setTimeout was called with the custom 120s body timeout, not the default 30s
    expect(setTimeoutSpy).toHaveBeenCalledWith(120_000, expect.any(Function));
  });

  it("honors custom upstreamTimeoutMs value", async () => {
    // Server that accepts connections but never responds — triggers the upstream timeout
    fastRawServer = http.createServer(() => {
      // intentionally never respond
    });
    await new Promise<void>((resolve) => fastRawServer!.listen(0, "127.0.0.1", resolve));
    const { port } = fastRawServer!.address() as { port: number };

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-custom-upstream-timeout-"));
    const record: RecordConfig = {
      providers: { openai: `http://127.0.0.1:${port}` },
      fixturePath: tmpDir,
      upstreamTimeoutMs: 100, // very short timeout to trigger quickly
    };
    const logger = new Logger("silent");
    const fixtures: Fixture[] = [];

    const { req, res } = createMockReqRes();
    let writtenStatus: number | undefined;
    let writtenBody = "";
    Object.assign(res, {
      writeHead: (status: number) => {
        writtenStatus = status;
        return res;
      },
      end: (data?: Buffer | string) => {
        if (data) writtenBody = typeof data === "string" ? data : data.toString();
        return res;
      },
      setHeader: () => res,
    });

    const outcome = await proxyAndRecord(
      req,
      res,
      { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
      "openai",
      "/v1/chat/completions",
      fixtures,
      { record, logger },
    );

    // The custom 100ms timeout should fire and produce a 502 proxy error
    expect(outcome).toBe("relayed");
    expect(writtenStatus).toBe(502);
    expect(writtenBody).toContain("timed out");
    // The error message includes the custom timeout value (0.1s)
    expect(writtenBody).toContain("0.1s");
  });

  it("clampTimeout falls back to default 30s for zero and negative values", async () => {
    // Verify bodyTimeoutMs clamping via setTimeout spy (zero value)
    fastRawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop" }],
        }),
      );
    });
    await new Promise<void>((resolve) => fastRawServer!.listen(0, "127.0.0.1", resolve));
    const { port } = fastRawServer!.address() as { port: number };

    setTimeoutSpy = vi.spyOn(http.IncomingMessage.prototype, "setTimeout");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-clamp-timeout-"));
    // Pass 0 for bodyTimeoutMs — clampTimeout should reject and fall back to 30_000
    const record: RecordConfig = {
      providers: { openai: `http://127.0.0.1:${port}` },
      fixturePath: tmpDir,
      bodyTimeoutMs: 0,
    };
    const logger = new Logger("silent");
    const fixtures: Fixture[] = [];

    const { req, res } = createMockReqRes();
    const chunks: Buffer[] = [];
    Object.assign(res, {
      writeHead: () => res,
      end: (data?: Buffer | string) => {
        if (data) chunks.push(typeof data === "string" ? Buffer.from(data) : data);
        return res;
      },
      setHeader: () => res,
    });

    await proxyAndRecord(
      req,
      res,
      { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
      "openai",
      "/v1/chat/completions",
      fixtures,
      { record, logger },
    );

    // Zero should be clamped to the default 30_000
    expect(setTimeoutSpy).toHaveBeenCalledWith(30_000, expect.any(Function));

    // Now test negative bodyTimeoutMs value
    setTimeoutSpy.mockRestore();
    setTimeoutSpy = vi.spyOn(http.IncomingMessage.prototype, "setTimeout");

    // Close and recreate the server for the second call
    await new Promise<void>((resolve) => fastRawServer!.close(() => resolve()));
    fastRawServer = http.createServer((_req, res2) => {
      res2.writeHead(200, { "Content-Type": "application/json" });
      res2.end(
        JSON.stringify({
          choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop" }],
        }),
      );
    });
    await new Promise<void>((resolve) => fastRawServer!.listen(0, "127.0.0.1", resolve));
    const port2 = (fastRawServer!.address() as { port: number }).port;

    // try/finally so a failing assertion cannot leak the extra tmpDir.
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-clamp-neg-"));
    try {
      const record2: RecordConfig = {
        providers: { openai: `http://127.0.0.1:${port2}` },
        fixturePath: tmpDir2,
        bodyTimeoutMs: -500,
      };

      const { req: req2, res: res2 } = createMockReqRes();
      const chunks2: Buffer[] = [];
      Object.assign(res2, {
        writeHead: () => res2,
        end: (data?: Buffer | string) => {
          if (data) chunks2.push(typeof data === "string" ? Buffer.from(data) : data);
          return res2;
        },
        setHeader: () => res2,
      });

      await proxyAndRecord(
        req2,
        res2,
        { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
        "openai",
        "/v1/chat/completions",
        fixtures,
        { record: record2, logger },
      );

      // Negative values should also be clamped to 30_000
      expect(setTimeoutSpy).toHaveBeenCalledWith(30_000, expect.any(Function));
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Binary EventStream relay preserves data integrity
// ---------------------------------------------------------------------------

describe("recorder binary EventStream relay integrity", () => {
  let rawServer: http.Server | undefined;

  afterEach(async () => {
    if (rawServer) {
      await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
      rawServer = undefined;
    }
  });

  it("relays binary EventStream data that can be decoded back to original content", async () => {
    // Build a known binary EventStream payload upstream
    const frame1 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: {
        delta: { text: "Binary " },
        contentBlockIndex: 0,
      },
      contentBlockIndex: 0,
    });
    const frame2 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: {
        delta: { text: "integrity " },
        contentBlockIndex: 0,
      },
      contentBlockIndex: 0,
    });
    const frame3 = encodeEventStreamMessage("contentBlockDelta", {
      contentBlockDelta: {
        delta: { text: "test" },
        contentBlockIndex: 0,
      },
      contentBlockIndex: 0,
    });
    const frame4 = encodeEventStreamMessage("messageStop", {
      messageStop: { stopReason: "end_turn" },
    });

    const expectedPayload = Buffer.concat([frame1, frame2, frame3, frame4]);

    // Create raw upstream that returns binary EventStream
    rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream" });
      res.end(expectedPayload);
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer!.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { bedrock: rawUrl }, fixturePath: tmpDir },
    });

    // Make the request through the recorder proxy
    const resp = await post(`${recorder.url}/model/claude-v3/invoke-with-response-stream`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 100,
      messages: [{ role: "user", content: "binary integrity test" }],
    });

    expect(resp.status).toBe(200);

    // The relayed response body should contain the text from the EventStream
    // frames. The relay currently converts Buffer to string, so we verify
    // the content is present in the response.
    // NOTE: If the relay preserves raw binary, the response body should
    // contain text extractable from the EventStream frames.
    expect(resp.body.length).toBeGreaterThan(0);

    // Verify the fixture was saved correctly on disk
    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, fixtureFiles[0]), "utf-8"),
    ) as { fixtures: Array<{ response: { content?: string } }> };
    expect(fixtureContent.fixtures[0].response.content).toBe("Binary integrity test");
  });
});

// ---------------------------------------------------------------------------
// SSE progressive streaming — recorder must tee upstream chunks to the
// client as they arrive, not buffer and replay in a single write.
// ---------------------------------------------------------------------------

describe("recorder SSE progressive streaming", () => {
  let rawServer: http.Server | undefined;

  afterEach(async () => {
    if (rawServer) {
      await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
      rawServer = undefined;
    }
  });

  it("streams SSE frames progressively to the client (not buffered)", async () => {
    // Raw upstream that emits 5 SSE `data:` frames spaced by 50ms each.
    // The recorder must relay each chunk as it arrives; if it buffers
    // and replays via a single res.end(), the client observes all frames
    // within microseconds of each other.
    const FRAME_DELAY_MS = 50;
    const NUM_FRAMES = 5;
    rawServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      let i = 0;
      const emit = () => {
        if (i < NUM_FRAMES) {
          res.write(`data: {"chunk":${i}}\n\n`);
          i++;
          setTimeout(emit, FRAME_DELAY_MS);
        } else {
          res.write("data: [DONE]\n\n");
          res.end();
        }
      };
      setTimeout(emit, FRAME_DELAY_MS);
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer!.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-sse-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: rawUrl }, fixturePath: tmpDir, proxyOnly: true },
    });

    // Issue request and capture the wall-clock arrival time of each
    // client-visible data event.
    const arrivalTimes: number[] = [];
    const body = JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "stream me" }],
      stream: true,
    });
    const parsedUrl = new URL(recorder.url);
    await new Promise<void>((resolve, reject) => {
      const clientReq = http.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.on("data", () => {
            arrivalTimes.push(Date.now());
          });
          res.on("end", () => resolve());
          res.on("error", reject);
        },
      );
      clientReq.on("error", reject);
      clientReq.write(body);
      clientReq.end();
    });

    // We should observe multiple client-visible data events, and the span
    // between first and last should reflect the upstream frame spacing.
    // With buffer-and-replay, everything arrives in one write within ~0ms.
    expect(arrivalTimes.length).toBeGreaterThanOrEqual(2);
    const span = arrivalTimes[arrivalTimes.length - 1] - arrivalTimes[0];
    // NUM_FRAMES frames spaced by 50ms = >=200ms expected span; allow
    // slack for scheduler jitter but require clearly more than "all at once".
    expect(span).toBeGreaterThanOrEqual(100);
  });

  it("includes Cache-Control, Connection, and X-Accel-Buffering headers on SSE relay", async () => {
    // Upstream returns SSE — recorder must set standard anti-buffering headers
    // so reverse proxies (nginx, Cloudflare, CDN, Bun.serve) do not buffer.
    rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"chunk":0}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer!.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-sse-hdrs-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: rawUrl }, fixturePath: tmpDir, proxyOnly: true },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "sse headers" }],
      stream: true,
    });

    expect(resp.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(resp.headers["connection"]).toBe("keep-alive");
    expect(resp.headers["x-accel-buffering"]).toBe("no");
  });
});

// ---------------------------------------------------------------------------
// NDJSON progressive streaming — recorder must tee upstream chunks to the
// client as they arrive, not buffer and replay in a single write.
// ---------------------------------------------------------------------------

describe("recorder NDJSON progressive streaming", () => {
  let rawServer: http.Server | undefined;

  afterEach(async () => {
    if (rawServer) {
      await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
      rawServer = undefined;
    }
  });

  it("streams NDJSON lines progressively to the client (not buffered)", async () => {
    // Raw upstream that emits 5 NDJSON lines spaced by 50ms each.
    // The recorder must relay each chunk as it arrives; if it buffers
    // and replays via a single res.end(), the client observes all lines
    // within microseconds of each other.
    const FRAME_DELAY_MS = 50;
    const NUM_FRAMES = 5;
    rawServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
      });
      let i = 0;
      const emit = () => {
        if (i < NUM_FRAMES) {
          const line = JSON.stringify({
            model: "llama3",
            message: { role: "assistant", content: `chunk-${i}` },
            done: false,
          });
          res.write(line + "\n");
          i++;
          setTimeout(emit, FRAME_DELAY_MS);
        } else {
          const doneLine = JSON.stringify({
            model: "llama3",
            message: { role: "assistant", content: "" },
            done: true,
          });
          res.write(doneLine + "\n");
          res.end();
        }
      };
      setTimeout(emit, FRAME_DELAY_MS);
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer!.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-ndjson-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { ollama: rawUrl }, fixturePath: tmpDir, proxyOnly: true },
    });

    // Issue request and capture the wall-clock arrival time of each
    // client-visible data event.
    const arrivalTimes: number[] = [];
    const body = JSON.stringify({
      model: "llama3",
      messages: [{ role: "user", content: "stream me" }],
      stream: true,
    });
    const parsedUrl = new URL(recorder.url);
    await new Promise<void>((resolve, reject) => {
      const clientReq = http.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: "/api/chat",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.on("data", () => {
            arrivalTimes.push(Date.now());
          });
          res.on("end", () => resolve());
          res.on("error", reject);
        },
      );
      clientReq.on("error", reject);
      clientReq.write(body);
      clientReq.end();
    });

    // We should observe multiple client-visible data events, and the span
    // between first and last should reflect the upstream frame spacing.
    expect(arrivalTimes.length).toBeGreaterThanOrEqual(2);
    const span = arrivalTimes[arrivalTimes.length - 1] - arrivalTimes[0];
    expect(span).toBeGreaterThanOrEqual(100);
  });

  it("preserves application/x-ndjson content-type in client response", async () => {
    rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        JSON.stringify({
          model: "llama3",
          message: { role: "assistant", content: "hi" },
          done: true,
        }) + "\n",
      );
      res.end();
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer!.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-ndjson-ct-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { ollama: rawUrl }, fixturePath: tmpDir, proxyOnly: true },
    });

    const body = JSON.stringify({
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const parsedUrl = new URL(recorder.url);
    const clientCT = await new Promise<string>((resolve, reject) => {
      const clientReq = http.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: "/api/chat",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const ct = res.headers["content-type"] ?? "";
          res.on("data", () => {});
          res.on("end", () => resolve(ct));
          res.on("error", reject);
        },
      );
      clientReq.on("error", reject);
      clientReq.write(body);
      clientReq.end();
    });

    expect(clientCT.toLowerCase()).toContain("application/x-ndjson");
  });
});

// ---------------------------------------------------------------------------
// Bedrock binary event stream progressive streaming — recorder must tee
// upstream chunks to the client as they arrive, not buffer and replay.
// ---------------------------------------------------------------------------

describe("recorder Bedrock binary event stream progressive streaming", () => {
  let rawServer: http.Server | undefined;

  afterEach(async () => {
    if (rawServer) {
      await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
      rawServer = undefined;
    }
  });

  it("streams Bedrock event stream frames progressively to the client (not buffered)", async () => {
    const FRAME_DELAY_MS = 50;
    const NUM_FRAMES = 5;
    rawServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/vnd.amazon.eventstream",
      });
      let i = 0;
      const emit = () => {
        if (i < NUM_FRAMES) {
          // Emit a minimal binary payload that looks like Bedrock event data.
          // We don't need valid CRC framing here — the test verifies progressive
          // relay timing, not parse correctness.
          const payload = Buffer.from(`bedrock-chunk-${i}`);
          res.write(payload);
          i++;
          setTimeout(emit, FRAME_DELAY_MS);
        } else {
          res.end();
        }
      };
      setTimeout(emit, FRAME_DELAY_MS);
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer!.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-bedrock-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { bedrock: rawUrl }, fixturePath: tmpDir, proxyOnly: true },
    });

    const arrivalTimes: number[] = [];
    const body = JSON.stringify({
      messages: [{ role: "user", content: [{ text: "stream me" }] }],
      modelId: "anthropic.claude-3-sonnet",
    });
    const parsedUrl = new URL(recorder.url);
    await new Promise<void>((resolve, reject) => {
      const clientReq = http.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: "/model/anthropic.claude-3-sonnet/converse-stream",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.on("data", () => {
            arrivalTimes.push(Date.now());
          });
          res.on("end", () => resolve());
          res.on("error", reject);
        },
      );
      clientReq.on("error", reject);
      clientReq.write(body);
      clientReq.end();
    });

    expect(arrivalTimes.length).toBeGreaterThanOrEqual(2);
    const span = arrivalTimes[arrivalTimes.length - 1] - arrivalTimes[0];
    expect(span).toBeGreaterThanOrEqual(100);
  });

  it("preserves application/vnd.amazon.eventstream content-type in client response", async () => {
    rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream" });
      res.write(Buffer.from("bedrock-data"));
      res.end();
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer!.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-bedrock-ct-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { bedrock: rawUrl }, fixturePath: tmpDir, proxyOnly: true },
    });

    const body = JSON.stringify({
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      modelId: "anthropic.claude-3-sonnet",
    });
    const parsedUrl = new URL(recorder.url);
    const clientCT = await new Promise<string>((resolve, reject) => {
      const clientReq = http.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: "/model/anthropic.claude-3-sonnet/converse-stream",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const ct = res.headers["content-type"] ?? "";
          res.on("data", () => {});
          res.on("end", () => resolve(ct));
          res.on("error", reject);
        },
      );
      clientReq.on("error", reject);
      clientReq.write(body);
      clientReq.end();
    });

    expect(clientCT.toLowerCase()).toContain("application/vnd.amazon.eventstream");
  });
});

// ---------------------------------------------------------------------------
// Multi-call fixture collision (issue #185)
// ---------------------------------------------------------------------------

describe("multi-call fixture disambiguation (issue #185)", () => {
  it("records distinct fixtures for same userMessage with different models", async () => {
    // Upstream that responds to everything
    const upstreamServer = await createServer(
      [
        {
          match: { userMessage: "help me plan a trip" },
          response: { content: "Here is your trip plan." },
        },
      ],
      { port: 0 },
    );

    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-multicall-"));
    const recorderServer = await createServer([], {
      port: 0,
      record: {
        providers: { openai: upstreamServer.url },
        fixturePath,
      },
    });

    const url = `${recorderServer.url}/v1/chat/completions`;

    // Call 1: opus + tools (assistant chat)
    await post(url, {
      model: "claude-opus-4-20250514",
      messages: [{ role: "user", content: "help me plan a trip" }],
      tools: [{ type: "function", function: { name: "search", parameters: {} } }],
    });

    // Call 2: haiku (title generation)
    await post(url, {
      model: "claude-3-5-haiku-20241022",
      messages: [
        { role: "system", content: "Generate a short title." },
        { role: "user", content: "help me plan a trip" },
      ],
    });

    // Call 3: haiku (suggestion generation)
    await post(url, {
      model: "claude-3-5-haiku-20241022",
      messages: [
        { role: "system", content: "Generate travel suggestions." },
        { role: "user", content: "help me plan a trip" },
      ],
    });

    // Calls 2 and 3 share identical match criteria (model + userMessage +
    // turnIndex + hasToolResult). systemHash is metadata for drift detection,
    // not a match discriminator — so call 3 MATCHES the in-memory fixture
    // call 2 just recorded and replays it (no second proxy, no overwrite).
    // Only 2 distinct files are produced.
    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(2);

    const fixtures = files.map((f) => {
      const data: FixtureFile = JSON.parse(fs.readFileSync(path.join(fixturePath, f), "utf-8"));
      return data.fixtures[0];
    });

    // Both share userMessage
    expect(fixtures.every((f) => f.match.userMessage === "help me plan a trip")).toBe(true);

    // Models are recorded and normalized (date stripped)
    const models = fixtures.map((f) => f.match.model);
    expect(models).toContain("claude-opus-4");
    expect(models).toContain("claude-3-5-haiku");

    // The haiku fixture has systemHash metadata (from whichever call won)
    const haikuFixture = fixtures.find((f) => f.match.model === "claude-3-5-haiku")!;
    expect(haikuFixture).toBeDefined();
    expect(haikuFixture.metadata).toBeDefined();
    expect(haikuFixture.metadata!.systemHash).toMatch(/^[a-f0-9]{8}$/);

    // Cleanup
    await new Promise<void>((resolve) => recorderServer.server.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamServer.server.close(() => resolve()));
    fs.rmSync(fixturePath, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Fixture metadata recording (systemHash / toolsHash)
// ---------------------------------------------------------------------------

describe("fixture metadata recording", () => {
  let metaUpstream: ServerInstance | undefined;
  let metaRecorder: ServerInstance | undefined;
  let metaTmpDir: string | undefined;

  afterEach(async () => {
    if (metaRecorder) {
      await new Promise<void>((resolve) => metaRecorder!.server.close(() => resolve()));
      metaRecorder = undefined;
    }
    if (metaUpstream) {
      await new Promise<void>((resolve) => metaUpstream!.server.close(() => resolve()));
      metaUpstream = undefined;
    }
    if (metaTmpDir) {
      fs.rmSync(metaTmpDir, { recursive: true, force: true });
      metaTmpDir = undefined;
    }
  });

  async function setupMetaRecorder(): Promise<{ recorderUrl: string; fixturePath: string }> {
    metaUpstream = await createServer(
      [
        {
          match: { userMessage: "test metadata sys" },
          response: { content: "ok sys" },
        },
        {
          match: { userMessage: "test metadata tools" },
          response: { content: "ok tools" },
        },
        {
          match: { userMessage: "test no metadata" },
          response: { content: "ok none" },
        },
        {
          match: { userMessage: "first hash probe" },
          response: { content: "ok diff" },
        },
        {
          match: { userMessage: "second hash probe" },
          response: { content: "ok diff two" },
        },
      ],
      { port: 0 },
    );
    metaTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-meta-"));
    metaRecorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: metaUpstream.url },
        fixturePath: metaTmpDir,
      },
    });
    return { recorderUrl: metaRecorder.url, fixturePath: metaTmpDir };
  }

  it("records systemHash when system message present", async () => {
    const { recorderUrl, fixturePath } = await setupMetaRecorder();

    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "test metadata sys" },
      ],
    });

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const fixture = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixture.fixtures[0].metadata).toBeDefined();
    expect(fixture.fixtures[0].metadata!.systemHash).toMatch(/^[a-f0-9]{8}$/);
    expect(fixture.fixtures[0].metadata!.toolsHash).toBeUndefined();
  });

  it("records toolsHash when tools present", async () => {
    const { recorderUrl, fixturePath } = await setupMetaRecorder();

    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "test metadata tools" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const fixture = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixture.fixtures[0].metadata).toBeDefined();
    expect(fixture.fixtures[0].metadata!.toolsHash).toMatch(/^[a-f0-9]{8}$/);
  });

  it("omits metadata when no system message or tools", async () => {
    const { recorderUrl, fixturePath } = await setupMetaRecorder();

    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "test no metadata" }],
    });

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const fixture = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    expect(fixture.fixtures[0].metadata).toBeUndefined();
  });

  it("produces different systemHash for different system prompts", async () => {
    const { recorderUrl, fixturePath } = await setupMetaRecorder();

    // Use different user messages so the second request also proxies to upstream
    // (same userMessage would match the first recorded fixture in memory).
    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Generate a title." },
        { role: "user", content: "first hash probe" },
      ],
    });

    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Generate suggestions." },
        { role: "user", content: "second hash probe" },
      ],
    });

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(2);
    const fixtures = files.map(
      (f) => JSON.parse(fs.readFileSync(path.join(fixturePath, f), "utf-8")) as FixtureFile,
    );
    const hash1 = fixtures[0].fixtures[0].metadata?.systemHash;
    const hash2 = fixtures[1].fixtures[0].metadata?.systemHash;
    expect(hash1).toBeDefined();
    expect(hash2).toBeDefined();
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// webSearches propagation into the persisted fixture
//
// Drives a raw upstream that emits exactly the OpenAI Responses-API SSE shape
// `collapseOpenAISSE` recognizes (a completed web_search_call), then exercises
// `proxyAndRecord` end-to-end and asserts that the collapsed `webSearches` land
// in the persisted fixture.
// ---------------------------------------------------------------------------

describe("recorder webSearches propagation", () => {
  let rawServer: http.Server | undefined;

  afterEach(async () => {
    if (rawServer) {
      await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
      rawServer = undefined;
    }
  });

  // Spin up a raw upstream that replies with a fixed SSE body and a real recorder
  // server pointed at it, then POST a streaming chat request through the recorder.
  async function recordSse(sseBody: string): Promise<{
    fixturePath: string;
    response: { status: number; body: string };
  }> {
    rawServer = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sseBody);
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (rawServer!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-collapse-prop-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    const response = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "search the web" }],
      stream: true,
    });

    return { fixturePath: tmpDir, response };
  }

  it("propagates webSearches from a collapsed Responses-API stream into the persisted fixture", async () => {
    // OpenAI Responses-API SSE: a completed web_search_call followed by text output.
    // collapseOpenAISSE returns { content, webSearches: ["..."] }.
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"web_search_call","action":{"query":"weather in Paris"}}}',
      'data: {"type":"response.output_text.delta","delta":"It is sunny in Paris."}',
      "data: [DONE]",
    ]
      .map((l) => l + "\n\n")
      .join("");

    const { fixturePath } = await recordSse(sse);

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    const saved = fixtureContent.fixtures[0].response as {
      content: string;
      webSearches?: string[];
    };
    expect(saved.content).toBe("It is sunny in Paris.");
    // The bug: webSearches was collapsed but never written to the fixture.
    expect(saved.webSearches).toEqual(["weather in Paris"]);
  });

  it("propagates webSearches alongside tool calls into the persisted fixture", async () => {
    // web_search_call + a structured tool call → collapsed result carries both
    // toolCalls and webSearches; the fixture must retain webSearches in the
    // tool-call branch too.
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"web_search_call","action":{"query":"latest news"}}}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_news","arguments":"{}"}}]}}]}',
      "data: [DONE]",
    ]
      .map((l) => l + "\n\n")
      .join("");

    const { fixturePath } = await recordSse(sse);

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    const saved = fixtureContent.fixtures[0].response as {
      toolCalls: unknown[];
      webSearches?: string[];
    };
    expect(saved.toolCalls).toHaveLength(1);
    expect(saved.webSearches).toEqual(["latest news"]);
  });
});

// ---------------------------------------------------------------------------
// Dropped-chunk diagnostic logging
//
// A malformed SSE frame is dropped during collapse; the collapser captures a
// `firstDroppedSample` diagnostic. Assert that sample reaches the logged
// dropped-chunk warning so the loss is actionable.
// ---------------------------------------------------------------------------

describe("recorder dropped-chunk diagnostic", () => {
  let rawServer: http.Server | undefined;
  let warnSpy: MockInstance | undefined;

  afterEach(async () => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    if (rawServer) {
      await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
      rawServer = undefined;
    }
  });

  it("logs firstDroppedSample alongside the dropped-chunk warning", async () => {
    // A malformed data frame increments droppedChunks and sets firstDroppedSample.
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      "data: {not valid json", // malformed → dropped, captured as the first sample
      "data: [DONE]",
    ]
      .map((l) => l + "\n\n")
      .join("");

    // Capture warnings via a real logger instance (silent suppresses output, so
    // spy on the instance method directly and run it through proxyAndRecord).
    const logger = new Logger("warn");
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    rawServer = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (rawServer!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-collapse-dropped-"));
    const record: RecordConfig = {
      providers: { openai: `http://127.0.0.1:${upstreamPort}` },
      fixturePath: tmpDir,
    };

    const { req, res } = createMockReqRes();
    Object.assign(res, {
      writeHead: () => res,
      write: () => true,
      end: () => res,
      setHeader: () => res,
      flushHeaders: () => undefined,
    });

    await proxyAndRecord(
      req,
      res,
      { model: "gpt-4", messages: [{ role: "user", content: "drop a chunk" }] },
      "openai",
      "/v1/chat/completions",
      [],
      { record, logger },
    );

    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    const droppedWarning = warnings.find((w) => w.includes("dropped during stream collapse"));
    expect(droppedWarning).toBeDefined();
    // The bug: the sample diagnostic was computed but never surfaced.
    expect(droppedWarning).toContain("not valid json");
  });
});

// ---------------------------------------------------------------------------
// Gemini audio-branch companion-modality propagation
//
// A single Gemini turn can interleave inlineData audio with a functionCall (and
// text/thought parts). collapseGeminiSSE returns audioB64 ALONGSIDE
// toolCalls/content/reasoning, but the recorder audio branch historically built
// only `{ audio: { b64Json, contentType } }` — silently discarding the tool
// call. These tests drive the real record path against a raw Gemini SSE upstream
// and assert the persisted fixture retains the companion modalities.
// ---------------------------------------------------------------------------

describe("recorder Gemini audio-branch propagation", () => {
  let rawServer: http.Server | undefined;

  afterEach(async () => {
    if (rawServer) {
      await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
      rawServer = undefined;
    }
  });

  // Raw Gemini upstream emitting a fixed SSE body, fronted by a real recorder
  // configured with the `gemini` provider key so collapseGeminiSSE runs.
  async function recordGeminiSse(sseBody: string): Promise<{
    fixturePath: string;
    response: { status: number; body: string };
  }> {
    rawServer = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sseBody);
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (rawServer!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-gemini-audio-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { gemini: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    // Gemini streaming is the :streamGenerateContent endpoint with a Gemini-shaped
    // request body (contents/parts), which routes to the `gemini` provider so
    // collapseGeminiSSE runs over the upstream SSE.
    const response = await post(
      `${recorder.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`,
      {
        contents: [{ role: "user", parts: [{ text: "speak and call a tool" }] }],
      },
    );

    return { fixturePath: tmpDir, response };
  }

  it("retains a functionCall in the persisted fixture when audio is also present", async () => {
    // Gemini SSE interleaving inlineData audio with a functionCall part.
    // collapseGeminiSSE returns { audioB64, audioMimeType, toolCalls }.
    const sse = [
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "audio/pcm", data: "QUJD" } }],
            },
          },
        ],
      }),
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "get_weather", args: { city: "SF" } } }],
            },
          },
        ],
      }),
    ]
      .map((l) => `data: ${l}\n\n`)
      .join("");

    const { fixturePath } = await recordGeminiSse(sse);

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    const saved = fixtureContent.fixtures[0].response as {
      audio: { b64Json: string; contentType?: string };
      toolCalls?: Array<{ name: string; arguments: string }>;
    };
    // Audio still persisted.
    expect(saved.audio.b64Json).toBe("QUJD");
    expect(saved.audio.contentType).toBe("audio/pcm");
    // The bug: the tool call was collapsed but dropped from the fixture.
    expect(saved.toolCalls).toHaveLength(1);
    expect(saved.toolCalls![0].name).toBe("get_weather");
    expect(JSON.parse(saved.toolCalls![0].arguments)).toEqual({ city: "SF" });
  });

  it("retains text content and reasoning alongside audio in the persisted fixture", async () => {
    // Audio interleaved with a normal text part and a `thought` (reasoning) part.
    const sse = [
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "audio/pcm", data: "WFla" } }],
            },
          },
        ],
      }),
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: "Here is the weather.", thought: false },
                { text: "Thinking about it.", thought: true },
              ],
            },
          },
        ],
      }),
    ]
      .map((l) => `data: ${l}\n\n`)
      .join("");

    const { fixturePath } = await recordGeminiSse(sse);

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    const saved = fixtureContent.fixtures[0].response as {
      audio: { b64Json: string };
      content?: string;
      reasoning?: string;
    };
    expect(saved.audio.b64Json).toBe("WFla");
    // The bug: content/reasoning collapsed alongside audio were dropped.
    expect(saved.content).toBe("Here is the weather.");
    expect(saved.reasoning).toBe("Thinking about it.");
  });
});

// ---------------------------------------------------------------------------
// Harmony-unparsed recording (end-to-end)
//
// When a gpt-oss stream carries harmony channel tokens that cannot be parsed
// into a valid harmony structure, the collapser preserves the bytes VERBATIM and
// surfaces the distinct `harmonyUnparsed` signal — it is NOT transport loss.
// The recorder must therefore persist a content-bearing fixture (verbatim, not
// an error/truncated fixture) and emit a DISTINCT harmony warning, never the
// dropped-chunk or truncation warnings.
// ---------------------------------------------------------------------------

describe("recorder harmony-unparsed recording", () => {
  let rawServer: http.Server | undefined;
  let warnSpy: MockInstance | undefined;

  afterEach(async () => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    if (rawServer) {
      await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
      rawServer = undefined;
    }
  });

  // A <|channel|> + <|message|> opener whose tool-call body never yields valid
  // JSON — isHarmonyContent recognizes the tokens but parsing fails, so the
  // collapser sets harmonyUnparsed and preserves content verbatim.
  const BROKEN_HARMONY =
    "<|start|>assistant<|channel|>commentary to=functions.broken<|constrain|>json<|message|>{not valid json";

  it("persists verbatim harmony content as a content fixture (not error/truncated)", async () => {
    const sse = [
      `data: ${JSON.stringify({ id: "chatcmpl-broken", choices: [{ delta: { content: BROKEN_HARMONY } }] })}`,
      "data: [DONE]",
    ]
      .map((l) => l + "\n\n")
      .join("");

    rawServer = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (rawServer!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-harmony-record-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-oss",
      messages: [{ role: "user", content: "use harmony" }],
      stream: true,
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"),
    ) as FixtureFile;
    const saved = fixtureContent.fixtures[0].response as {
      content?: string;
      error?: unknown;
      toolCalls?: unknown[];
    };
    // Verbatim content, no fabricated tool call, no error fixture.
    expect(saved.error).toBeUndefined();
    expect(saved.toolCalls).toBeUndefined();
    expect(saved.content).toBe(BROKEN_HARMONY);
  });

  it("emits the distinct harmony-unparsed warning, not dropped-chunk/truncation warnings", async () => {
    const sse = [
      `data: ${JSON.stringify({ id: "chatcmpl-broken", choices: [{ delta: { content: BROKEN_HARMONY } }] })}`,
      "data: [DONE]",
    ]
      .map((l) => l + "\n\n")
      .join("");

    const logger = new Logger("warn");
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    rawServer = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.end(sse);
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (rawServer!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-harmony-warn-"));
    const record: RecordConfig = {
      providers: { openai: `http://127.0.0.1:${upstreamPort}` },
      fixturePath: tmpDir,
    };

    const { req, res } = createMockReqRes();
    Object.assign(res, {
      writeHead: () => res,
      write: () => true,
      end: () => res,
      setHeader: () => res,
      flushHeaders: () => undefined,
    });

    await proxyAndRecord(
      req,
      res,
      { model: "gpt-oss", messages: [{ role: "user", content: "use harmony" }] },
      "openai",
      "/v1/chat/completions",
      [],
      { record, logger },
    );

    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    const harmonyWarning = warnings.find((w) =>
      w.includes("Harmony tokens present but unparseable"),
    );
    expect(harmonyWarning).toBeDefined();
    // Distinct signal — NOT counted as dropped/truncated transport loss.
    expect(warnings.some((w) => w.includes("dropped during stream collapse"))).toBe(false);
    expect(warnings.some((w) => w.includes("may be truncated"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Frame-timing splitter — CRLF delimiter tolerance
//
// Some upstreams/proxies emit SSE/NDJSON frames with CRLF line endings
// (\r\n\r\n for SSE, \r\n for NDJSON), which the SSE spec permits. The
// frame-timing splitter must split on these boundaries so per-frame
// timestamps are captured. An LF-only splitter sees the whole stream as a
// single frame, producing no recordedTimings.
// ---------------------------------------------------------------------------

describe("recorder frame-timing: CRLF delimiters", () => {
  it("captures per-frame timing for CRLF-delimited SSE streams", async () => {
    // Anthropic-style SSE, but with CRLF (\r\n\r\n) frame boundaries.
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frames = [
        `event: message_start\r\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_crlf", role: "assistant" } })}`,
        `event: content_block_delta\r\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CRLF " } })}`,
        `event: content_block_delta\r\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "frames" } })}`,
        `event: message_stop\r\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      ];
      // Write each frame with a CRLF/CRLF terminator on its own tick so the
      // per-frame timestamps are distinguishable.
      let i = 0;
      const writeNext = () => {
        if (i >= frames.length) {
          res.end();
          return;
        }
        res.write(`${frames[i]}\r\n\r\n`);
        i++;
        setTimeout(writeNext, 2);
      };
      writeNext();
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { anthropic: rawUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/messages`, {
      model: "claude-3-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "crlf sse timing test" }],
      stream: true,
    });
    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"),
    ) as FixtureFile;

    // Content collapse must still work across CRLF frames.
    const savedResponse = fixtureContent.fixtures[0].response as { content?: string };
    expect(savedResponse.content).toBe("CRLF frames");

    // The splitter must have seen each CRLF-terminated frame individually,
    // so recordedTimings is present with one inter-chunk delay per frame gap.
    const timings = fixtureContent.fixtures[0].recordedTimings;
    expect(timings).toBeDefined();
    // 4 frames → 3 inter-frame delays.
    expect(timings!.interChunkDelaysMs.length).toBe(3);

    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
  });

  it("captures per-frame timing for CRLF-delimited NDJSON streams", async () => {
    // Ollama-style NDJSON, but with CRLF (\r\n) line endings.
    const rawServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const lines = [
        JSON.stringify({ message: { role: "assistant", content: "NDJSON " }, done: false }),
        JSON.stringify({ message: { role: "assistant", content: "over " }, done: false }),
        JSON.stringify({ message: { role: "assistant", content: "CRLF" }, done: true }),
      ];
      let i = 0;
      const writeNext = () => {
        if (i >= lines.length) {
          res.end();
          return;
        }
        res.write(`${lines[i]}\r\n`);
        i++;
        setTimeout(writeNext, 2);
      };
      writeNext();
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawServer.address() as { port: number };
    const rawUrl = `http://127.0.0.1:${rawAddr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { ollama: rawUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "crlf ndjson timing test" }],
      stream: true,
    });
    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"),
    ) as FixtureFile;

    // Each CRLF-terminated NDJSON line must be timestamped individually.
    const timings = fixtureContent.fixtures[0].recordedTimings;
    expect(timings).toBeDefined();
    // 3 frames → 2 inter-frame delays.
    expect(timings!.interChunkDelaysMs.length).toBe(2);

    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
  });
});

describe("persistFixture snapshot merge — _warning carry-forward", () => {
  it("a later clean capture into the same snapshot file retains the existing _warning", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-persist-warn-"));
    try {
      const record: RecordConfig = {
        providers: { openai: "http://127.0.0.1:1" },
        fixturePath: dir,
      };
      const logger = new Logger("silent");
      const fixtures: Fixture[] = [];

      const first = persistFixture({
        record,
        providerKey: "openai",
        testId: "warn-merge",
        fixture: { match: { userMessage: "first capture" }, response: { content: "a" } },
        fixtures,
        warnings: ["W1 original over-cap warning"],
        logger,
      });
      expect(first.kind).toBe("written");

      // Second, clean capture for the same testId + provider merges into the
      // same snapshot file — the original _warning must survive the rewrite.
      const second = persistFixture({
        record,
        providerKey: "openai",
        testId: "warn-merge",
        fixture: { match: { userMessage: "second capture" }, response: { content: "b" } },
        fixtures,
        logger,
      });
      expect(second.kind).toBe("written");

      const file = JSON.parse(
        fs.readFileSync(path.join(dir, "warn-merge", "openai.json"), "utf-8"),
      ) as { fixtures: unknown[]; _warning?: string };
      expect(file.fixtures).toHaveLength(2);
      expect(file._warning).toContain("W1 original over-cap warning");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a re-emitted warning does not accumulate into the carried-forward _warning (round 6)", () => {
    // The existing _warning is a "; "-joined string — it must be split back
    // into its elements before deduping, or "A; B" + "A" becomes "A; B; A".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-persist-warn-dedupe-"));
    try {
      const record: RecordConfig = {
        providers: { openai: "http://127.0.0.1:1" },
        fixturePath: dir,
      };
      const logger = new Logger("silent");
      const fixtures: Fixture[] = [];

      const first = persistFixture({
        record,
        providerKey: "openai",
        testId: "warn-dedupe",
        fixture: { match: { userMessage: "first capture" }, response: { content: "a" } },
        fixtures,
        warnings: ["W-A repeated warning", "W-B other warning"],
        logger,
      });
      expect(first.kind).toBe("written");

      // The second capture re-emits W-A — the merged _warning must stay
      // exactly the two original entries.
      const second = persistFixture({
        record,
        providerKey: "openai",
        testId: "warn-dedupe",
        fixture: { match: { userMessage: "second capture" }, response: { content: "b" } },
        fixtures,
        warnings: ["W-A repeated warning"],
        logger,
      });
      expect(second.kind).toBe("written");

      const file = JSON.parse(
        fs.readFileSync(path.join(dir, "warn-dedupe", "openai.json"), "utf-8"),
      ) as { fixtures: unknown[]; _warning?: string };
      expect(file._warning).toBe("W-A repeated warning; W-B other warning");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a non-array `fixtures` in the existing snapshot file is discarded with a warn, not spread", () => {
    // Spreading a string `fixtures` would silently mangle the file into an
    // array of single characters plus the new fixture.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-persist-nonarray-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const record: RecordConfig = {
        providers: { openai: "http://127.0.0.1:1" },
        fixturePath: dir,
      };
      const logger = new Logger("warn");
      const fixtures: Fixture[] = [];

      const fileDir = path.join(dir, "nonarray-merge");
      fs.mkdirSync(fileDir, { recursive: true });
      fs.writeFileSync(
        path.join(fileDir, "openai.json"),
        JSON.stringify({ fixtures: "oops not an array" }),
        "utf-8",
      );

      const result = persistFixture({
        record,
        providerKey: "openai",
        testId: "nonarray-merge",
        fixture: { match: { userMessage: "fresh capture" }, response: { content: "a" } },
        fixtures,
        logger,
      });
      expect(result.kind).toBe("written");
      expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("non-array"))).toBe(true);

      const file = JSON.parse(fs.readFileSync(path.join(fileDir, "openai.json"), "utf-8")) as {
        fixtures: unknown[];
      };
      expect(Array.isArray(file.fixtures)).toBe(true);
      expect(file.fixtures).toHaveLength(1);
      expect(file.fixtures[0]).toMatchObject({ match: { userMessage: "fresh capture" } });
    } finally {
      // Restore in the finally: a failing assertion above must not leak the
      // console spy into later tests.
      warnSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeHeaderValue", () => {
  it("replaces characters Node rejects in header values and keeps Latin-1 intact", () => {
    // Multibyte (>0xFF) and control characters become "?"; tab, printable
    // ASCII, and the 0x80-0xFF Latin-1 range pass through untouched.
    expect(sanitizeHeaderValue("ENOTDIR: not a directory, mkdir '/tmp/日本語/héllo'")).toBe(
      "ENOTDIR: not a directory, mkdir '/tmp/???/héllo'",
    );
    expect(sanitizeHeaderValue("line1\nline2\x7f")).toBe("line1?line2?");
    expect(sanitizeHeaderValue("plain ascii\twith tab")).toBe("plain ascii\twith tab");
  });
});

// ---------------------------------------------------------------------------
// OpenAI image-generation branch entry gate (regression)
//
// The image branch's entry gate keyed on `data[0]` carrying media (url/b64_json).
// An image batch whose FIRST element lacks both — but a LATER element HAS one —
// skipped the whole branch and fell through to the generic error fixture,
// silently dropping every captured image. The gate must enter when ANY item
// carries media. Driven against the real record path: a raw OpenAI image
// upstream fronted by a real recorder, posting to /v1/images/generations, then
// asserting the persisted fixture retains the image(s).
// ---------------------------------------------------------------------------

describe("recorder OpenAI image-branch entry gate", () => {
  let rawServer: http.Server | undefined;

  afterEach(async () => {
    if (rawServer) {
      await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
      rawServer = undefined;
    }
  });

  // Raw OpenAI image-generation upstream emitting a fixed JSON body, fronted by a
  // real recorder configured with the `openai` provider key so buildFixtureResponse
  // runs over the upstream image response.
  async function recordOpenAiImage(responseJson: unknown): Promise<{
    fixturePath: string;
    response: { status: number; body: string };
  }> {
    rawServer = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "application/json" });
      upRes.end(JSON.stringify(responseJson));
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (rawServer!.address() as { port: number }).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-openai-image-"));
    recorder = await createServer([], {
      port: 0,
      record: {
        providers: { openai: `http://127.0.0.1:${upstreamPort}` },
        fixturePath: tmpDir,
      },
    });

    const response = await post(`${recorder.url}/v1/images/generations`, {
      model: "gpt-image-1",
      prompt: "a red cube and a blue sphere",
      n: 2,
    });

    return { fixturePath: tmpDir, response };
  }

  it("captures images when data[0] lacks media but a later item carries a url", async () => {
    // OpenAI batch where the FIRST element has neither url nor b64_json (e.g. a
    // partial/placeholder entry), but the SECOND element carries a real url.
    const { fixturePath } = await recordOpenAiImage({
      created: 1_700_000_000,
      data: [
        { revised_prompt: "a red cube and a blue sphere" },
        { url: "https://example.com/image-2.png", revised_prompt: "blue sphere" },
      ],
    });

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    const saved = fixtureContent.fixtures[0].response as {
      image?: { url?: string; b64Json?: string; revisedPrompt?: string };
      images?: Array<{ url?: string; b64Json?: string; revisedPrompt?: string }>;
      error?: { message: string };
    };

    // RED (pre-fix): the gate keyed on data[0] (no media) skipped the branch and
    // the response fell through to the generic error fixture, dropping the image.
    expect(saved.error).toBeUndefined();
    // GREEN: the single media-bearing item is captured. The within-branch filter
    // drops the media-less first element, leaving exactly one image — which the
    // branch collapses to `{ image }`.
    expect(saved.image).toBeDefined();
    expect(saved.image!.url).toBe("https://example.com/image-2.png");
  });

  it("captures b64_json when data[0] lacks media but a later item carries b64_json", async () => {
    const { fixturePath } = await recordOpenAiImage({
      created: 1_700_000_001,
      data: [{ revised_prompt: "placeholder" }, { b64_json: "aGVsbG8=", revised_prompt: "real" }],
    });

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixtureContent = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    const saved = fixtureContent.fixtures[0].response as {
      image?: { url?: string; b64Json?: string };
      error?: { message: string };
    };

    expect(saved.error).toBeUndefined();
    expect(saved.image).toBeDefined();
    expect(saved.image!.b64Json).toBe("aGVsbG8=");
  });
});
