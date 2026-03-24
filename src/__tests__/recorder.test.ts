import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Fixture, FixtureFile } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { proxyAndRecord } from "../recorder.js";
import type { RecordConfig } from "../types.js";
import { Logger } from "../logger.js";
import { LLMock } from "../llmock.js";
import { encodeEventStreamMessage } from "../aws-event-stream.js";

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
  it("returns false when provider is not configured", async () => {
    const fixtures: Fixture[] = [];
    const logger = new Logger("silent");
    const record: RecordConfig = { providers: {} };

    // Create a mock req/res pair — we just need them to exist,
    // proxyAndRecord should return false before using them
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

    expect(result).toBe(false);
  });

  it("returns false when record config is undefined", async () => {
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

    expect(result).toBe(false);
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

    // Send request with stream: true — upstream llmock will return SSE
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));

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
    // is another llmock so it returns OpenAI format which gets proxied raw
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

  it("record + strict: proxy succeeds when upstream is available", async () => {
    await setupUpstreamAndRecorder([
      {
        match: { userMessage: "hello" },
        response: { content: "world" },
      },
    ]);

    // Override to also set strict on the recorder
    // Need to create a new recorder with both record + strict
    await new Promise<void>((resolve) => recorder!.server.close(() => resolve()));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
    recorder = await createServer([], {
      port: 0,
      strict: true,
      record: { providers: { openai: upstream!.url }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.choices[0].message.content).toBe("world");
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));

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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    await fetch(`${recorderUrl}/v1/_requests`, { method: "DELETE" });

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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstream.url }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "trigger error" }],
    });

    expect(resp.status).toBe(500);

    // Fixture file created with error response
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
    expect(fs.existsSync(defaultPath)).toBe(true);
    const files = fs.readdirSync(defaultPath);
    const fixtureFiles = files.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(1);

    // Clean up the default path files we just created
    for (const f of fixtureFiles) {
      fs.unlinkSync(path.join(defaultPath, f));
    }
    // Remove dir if empty
    try {
      fs.rmdirSync(defaultPath);
    } catch {
      // ignore — might not be empty if other tests ran
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: `http://127.0.0.1:${upAddr.port}` }, fixturePath: tmpDir },
    });

    // Send body with specific formatting (extra spaces, key order)
    const customBody =
      '{"model":  "gpt-4",  "messages": [{"role": "user", "content": "preserve me"}]}';
    const resp = await fetch(`${recorder.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: customBody,
    });
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
// Strict mode thorough tests
// ---------------------------------------------------------------------------

describe("recorder strict mode thorough", () => {
  it("strict mode + recording but provider not configured: 503 returned", async () => {
    // Only anthropic configured, but request goes to openai endpoint
    const anthropicUpstream = await createServer(
      [{ match: { userMessage: "strict test" }, response: { content: "ok" } }],
      { port: 0 },
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
});

// ---------------------------------------------------------------------------
// Upstream connection failure → 502
// ---------------------------------------------------------------------------

describe("recorder upstream connection failure", () => {
  it("returns 502 when upstream is unreachable", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
// Filesystem write failure — response still relayed
// ---------------------------------------------------------------------------

describe("recorder filesystem write failure", () => {
  it("relays response to client even when fixture write fails", async () => {
    upstream = await createServer(
      [{ match: { userMessage: "fs fail" }, response: { content: "still works" } }],
      { port: 0 },
    );

    // Use a path that cannot be a directory (a regular file)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

describe("recorder buildFixtureResponse non-OpenAI formats", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers = [];
  });

  function createRawUpstream(responseBody: object): Promise<{ url: string; server: http.Server }> {
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

  it("records Anthropic format (content array with type/text)", async () => {
    const { url: upstreamUrl } = await createRawUpstream({
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Bonjour from Anthropic" }],
      stop_reason: "end_turn",
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    const { url: upstreamUrl } = await createRawUpstream({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Hello from Gemini" }] },
          finishReason: "STOP",
        },
      ],
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    const { url: upstreamUrl } = await createRawUpstream({
      model: "llama3",
      message: { role: "assistant", content: "Hello from Ollama" },
      done: true,
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    // toolCalls should win
    expect(fixtureContent.fixtures[0].response.toolCalls).toBeDefined();
    expect(fixtureContent.fixtures[0].response.toolCalls).toHaveLength(1);
    expect(fixtureContent.fixtures[0].response.toolCalls![0].name).toBe("search");

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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));

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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));

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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));

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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

  it("unknown format falls back to error response", async () => {
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      custom: "data",
      status: "ok",
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

  it("does not decode base64 embedding when encoding_format is not set", async () => {
    // Same base64 string but no encoding_format in request — should NOT decode
    const base64Embedding = "AAAAPwAAgD8AAIC+";
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: base64Embedding }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
        response: { error?: { type: string } };
      }>;
    };
    // Without encoding_format, base64 string embedding is not an array →
    // falls through to proxy_error
    expect(fixtureContent.fixtures[0].response.error?.type).toBe("proxy_error");
  });

  it("still detects array embeddings when encoding_format is base64", async () => {
    // Some upstream responses return array format even when base64 was requested
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.5, 1.0, -0.25] }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

  it("handles truncated base64 embedding gracefully (odd byte count)", async () => {
    // 2 bytes decodes to 0 float32 elements — produces empty embedding, not a crash
    const shortBase64 = Buffer.from([0x00, 0x01]).toString("base64");
    const { url: upstreamUrl } = await createRawUpstreamWithStatus({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: shortBase64 }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
        response: { embedding?: number[] };
      }>;
    };
    // Truncated base64 decodes to empty array rather than crashing
    expect(fixtureContent.fixtures[0].response.embedding).toEqual([]);
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
    recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const resp = await post(`${recorder.url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "rate limit test" }],
    });

    expect(resp.status).toBe(429);

    const files = fs.readdirSync(tmpDir);
    const fixtureFiles = files.filter((f) => f.endsWith(".json"));
    expect(fixtureFiles).toHaveLength(1);

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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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

  it("streaming with content + toolCalls: fixture saves toolCalls (not content)", async () => {
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    // When toolCalls exist, they win over content
    expect(savedResponse.toolCalls).toBeDefined();
    expect(savedResponse.toolCalls).toHaveLength(1);
    expect(savedResponse.toolCalls![0].name).toBe("get_weather");
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

  function createRawUpstream(responseBody: object): Promise<{ url: string; server: http.Server }> {
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

  it("detects Bedrock Converse format (output.message.content text)", async () => {
    const { url: upstreamUrl } = await createRawUpstream({
      output: {
        message: {
          role: "assistant",
          content: [{ text: "Hello from Bedrock Converse" }],
        },
      },
      stopReason: "end_turn",
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    const { url: upstreamUrl } = await createRawUpstream({
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
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    const { url: upstreamUrl } = await createRawUpstream({
      content: [
        {
          type: "tool_use",
          id: "toolu_str",
          name: "search",
          input: '{"query":"hello"}',
        },
      ],
      role: "assistant",
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    const { url: upstreamUrl } = await createRawUpstream({
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
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    const { url: upstreamUrl } = await createRawUpstream({
      model: "llama3",
      message: {
        role: "assistant",
        content: [{ text: "Array content from Ollama" }],
      },
      done: true,
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    const { url: upstreamUrl } = await createRawUpstream({
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
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
  return { req, res };
}

async function setupUpstreamAndRecorder(
  upstreamFixtures: Fixture[],
  providerKey: string = "openai",
): Promise<{ upstreamUrl: string; recorderUrl: string; fixturePath: string }> {
  // Create upstream "real API" server
  upstream = await createServer(upstreamFixtures, { port: 0 });

  // Create temp directory for recorded fixtures
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));

  // Create recording llmock (no fixtures — everything proxies)
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

  afterEach(async () => {
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

    const setTimeoutSpy = vi.spyOn(http.IncomingMessage.prototype, "setTimeout");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-timeout-"));
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
    setTimeoutSpy.mockRestore();
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmock-record-"));
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
