import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, startFromConfig } from "../config-loader.js";
import type { AimockConfig } from "../config-loader.js";
import type { RecordedTimings } from "../types.js";
import { Logger } from "../logger.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "config-loader-test-"));
}

function writeConfig(dir: string, config: AimockConfig, name = "aimock.json"): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, JSON.stringify(config), "utf-8");
  return filePath;
}

function writeFixtureFile(dir: string, name = "fixtures.json"): string {
  const filePath = join(dir, name);
  writeFileSync(
    filePath,
    JSON.stringify({
      fixtures: [
        {
          match: { userMessage: "hello" },
          response: { content: "Hello from config test!" },
        },
      ],
    }),
    "utf-8",
  );
  return filePath;
}

// Content is long enough to split into several chunks so per-chunk delays are observable
function writeStreamFixtureFile(
  dir: string,
  recordedTimings?: RecordedTimings,
  name = "stream-fixtures.json",
): string {
  const filePath = join(dir, name);
  writeFileSync(
    filePath,
    JSON.stringify({
      fixtures: [
        {
          match: { userMessage: "hello" },
          response: { content: "Hello world from the streaming config test!" },
          ...(recordedTimings ? { recordedTimings } : {}),
        },
      ],
    }),
    "utf-8",
  );
  return filePath;
}

// Streams a completion and counts SSE frames. Without stream: true there is no SSE and no
// chunk delays, so the timing assertions below would pass whether or not the options are wired.
async function streamChunkCount(url: string): Promise<number> {
  const resp = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const body = await resp.text();
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && !frame.includes("[DONE]")).length;
}

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads valid JSON config", () => {
    const config: AimockConfig = { port: 5000, host: "0.0.0.0", metrics: true };
    const filePath = writeConfig(tmpDir, config);
    const result = loadConfig(filePath);
    expect(result.port).toBe(5000);
    expect(result.host).toBe("0.0.0.0");
    expect(result.metrics).toBe(true);
  });

  it("throws on invalid JSON", () => {
    const filePath = join(tmpDir, "bad.json");
    writeFileSync(filePath, "{ not valid json", "utf-8");
    expect(() => loadConfig(filePath)).toThrow();
  });

  it("throws on missing file", () => {
    expect(() => loadConfig(join(tmpDir, "nonexistent.json"))).toThrow();
  });
});

describe("startFromConfig", () => {
  let tmpDir: string;
  let cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates server with LLM fixtures from a file", async () => {
    const fixturePath = writeFixtureFile(tmpDir);
    const config: AimockConfig = { llm: { fixtures: fixturePath } };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(llmock.getFixtures()).toHaveLength(1);

    // Verify server responds
    const resp = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(resp.ok).toBe(true);
  });

  it("creates server with LLM fixtures from a directory", async () => {
    const fixtureDir = join(tmpDir, "fixtures");
    mkdirSync(fixtureDir);
    writeFixtureFile(fixtureDir, "test.json");

    const config: AimockConfig = { llm: { fixtures: fixtureDir } };
    const { llmock } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    expect(llmock.getFixtures()).toHaveLength(1);
  });

  it("with metrics: true, /metrics returns 200", async () => {
    const config: AimockConfig = { metrics: true };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const resp = await fetch(`${url}/metrics`);
    expect(resp.status).toBe(200);
  });

  it("with strict: true, unmatched request returns 503", async () => {
    const config: AimockConfig = { strict: true };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const resp = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "no match" }],
      }),
    });
    expect(resp.status).toBe(503);
  });

  it("with chaos config, chaos applies", async () => {
    const fixturePath = writeFixtureFile(tmpDir);
    const config: AimockConfig = {
      llm: { fixtures: fixturePath, chaos: { dropRate: 1.0 } },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const resp = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(resp.status).toBe(500);
  });

  it("with llm.chunkSize, the response is split into more chunks", async () => {
    const fixturePath = writeStreamFixtureFile(tmpDir);

    const small = await startFromConfig({ llm: { fixtures: fixturePath, chunkSize: 5 } });
    cleanups.push(() => small.llmock.stop());
    const smallChunks = await streamChunkCount(small.url);

    const large = await startFromConfig({ llm: { fixtures: fixturePath, chunkSize: 1000 } });
    cleanups.push(() => large.llmock.stop());
    const largeChunks = await streamChunkCount(large.url);

    expect(smallChunks).toBeGreaterThan(largeChunks);
  });

  it("with llm.latency, streamed chunks are delayed", async () => {
    const fixturePath = writeStreamFixtureFile(tmpDir);
    const config: AimockConfig = {
      llm: { fixtures: fixturePath, chunkSize: 5, latency: 100 },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const start = Date.now();
    const chunks = await streamChunkCount(url);
    const elapsed = Date.now() - start;

    // 100ms per chunk across >= 5 chunks. Asserted as a lower bound so a slow
    // machine can never fail it; without the passthrough latency is 0.
    expect(chunks).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  it("with llm.replaySpeed, recorded timings replay faster", async () => {
    // 500ms TTFT + 4 x 500ms inter-chunk = ~2500ms at 1x speed
    const fixturePath = writeStreamFixtureFile(tmpDir, {
      ttftMs: 500,
      interChunkDelaysMs: [500, 500, 500, 500],
      totalDurationMs: 2500,
    });
    const config: AimockConfig = {
      llm: { fixtures: fixturePath, chunkSize: 5, replaySpeed: 100 },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const start = Date.now();
    await streamChunkCount(url);
    const elapsed = Date.now() - start;

    // At 100x this lands in ~25ms; the bound is deliberately generous so only a
    // dropped passthrough (which costs the full ~2500ms) can fail it.
    expect(elapsed).toBeLessThan(1000);
  });

  it("with non-positive llm.replaySpeed, warns and ignores it", async () => {
    const fixturePath = writeStreamFixtureFile(tmpDir);
    // Spy on the logger the code path actually uses rather than console, so the
    // assertion verifies the intended warn call without coupling to the
    // "[aimock]" prefix or the console transport.
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    // 0 looks like "no delay" but hits the `speed > 0` guard in calculateDelay,
    // which would replay at full recorded speed.
    const { llmock } = await startFromConfig({
      llm: { fixtures: fixturePath, replaySpeed: 0 },
    });
    cleanups.push(() => llmock.stop());

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("llm.replaySpeed must be a positive number"),
    );
    warn.mockRestore();
  });

  it("with llm.logLevel debug, the server logs debug output that silent suppresses", async () => {
    const fixturePath = writeFixtureFile(tmpDir);
    // The server logger writes debug/info lines via console.log; capture them so
    // we can assert the configured level actually reaches the running server.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // A matched request emits a "Fixture matched" debug line, but only when the
    // configured logLevel is high enough — so it is a direct probe of the passthrough.
    async function debugLineCount(logLevel: "debug" | "silent"): Promise<number> {
      log.mockClear();
      const { llmock, url } = await startFromConfig({
        llm: { fixtures: fixturePath, logLevel },
      });
      cleanups.push(() => llmock.stop());
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
      });
      return log.mock.calls.filter((args) => String(args[1]).startsWith("Fixture matched")).length;
    }

    expect(await debugLineCount("debug")).toBeGreaterThan(0);
    expect(await debugLineCount("silent")).toBe(0);

    log.mockRestore();
  });

  it("with mcp tools config, MCPMock created and tools/list works", async () => {
    const config: AimockConfig = {
      mcp: {
        tools: [
          { name: "search", description: "Search the web" },
          { name: "calc", description: "Calculator", result: "42" },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Initialize MCP session
    const initRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // Send initialized notification
    await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });

    // List tools
    const listRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 }),
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.result.tools).toHaveLength(2);
    expect(listData.result.tools[0].name).toBe("search");
    expect(listData.result.tools[1].name).toBe("calc");

    // Call tool with result
    const callRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calc", arguments: {} },
        id: 3,
      }),
    });
    const callData = await callRes.json();
    expect(callData.result.content).toEqual([{ type: "text", text: "42" }]);
  });

  it("with mcp resources config, resources are served", async () => {
    const config: AimockConfig = {
      mcp: {
        resources: [
          { uri: "file:///readme.md", name: "README", mimeType: "text/markdown", text: "# Hello" },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Initialize
    const initRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;
    await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });

    // Read resource
    const readRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "resources/read",
        params: { uri: "file:///readme.md" },
        id: 2,
      }),
    });
    const readData = await readRes.json();
    expect(readData.result.contents[0].text).toBe("# Hello");
  });

  it("with mcp custom path, mounts at specified path", async () => {
    const config: AimockConfig = {
      mcp: {
        path: "/custom-mcp",
        tools: [{ name: "test-tool" }],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const initRes = await fetch(`${url}/custom-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    expect(initRes.status).toBe(200);
  });

  it("with a2a agents config, A2AMock created and agent card served", async () => {
    const config: AimockConfig = {
      a2a: {
        agents: [
          {
            name: "test-agent",
            description: "A test agent",
            skills: [{ id: "s1", name: "greet" }],
            messages: [{ pattern: "hello", parts: [{ text: "Hi there!" }] }],
          },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Get agent card
    const cardRes = await fetch(`${url}/a2a/.well-known/agent-card.json`);
    expect(cardRes.status).toBe(200);
    const card = await cardRes.json();
    expect(card.name).toBe("test-agent");
    expect(card.skills).toHaveLength(1);

    // Send message
    const msgRes = await fetch(`${url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "SendMessage",
        params: { message: { parts: [{ text: "hello world" }] } },
        id: 1,
      }),
    });
    expect(msgRes.status).toBe(200);
    const msgData = await msgRes.json();
    expect(msgData.result.message.parts[0].text).toBe("Hi there!");
  });

  it("with a2a custom path, mounts at specified path", async () => {
    const config: AimockConfig = {
      a2a: {
        path: "/agents",
        agents: [{ name: "custom-agent" }],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const cardRes = await fetch(`${url}/agents/.well-known/agent-card.json`);
    expect(cardRes.status).toBe(200);
    const card = await cardRes.json();
    expect(card.name).toBe("custom-agent");
  });

  it("port/host overrides work", async () => {
    const config: AimockConfig = { port: 9999, host: "0.0.0.0" };
    const { llmock, url } = await startFromConfig(config, { port: 0, host: "127.0.0.1" });
    cleanups.push(() => llmock.stop());

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("starts with no config sections at all", async () => {
    const config: AimockConfig = {};
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("with vector collections config, VectorMock created and collections work", async () => {
    const config: AimockConfig = {
      vector: {
        collections: [
          {
            name: "docs",
            dimension: 3,
            vectors: [
              { id: "v1", values: [1, 0, 0], metadata: { title: "doc1" } },
              { id: "v2", values: [0, 1, 0], metadata: { title: "doc2" } },
            ],
            queryResults: [{ id: "v1", score: 0.95, metadata: { title: "doc1" } }],
          },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Query the vector collection via Pinecone-compatible endpoint
    const resp = await fetch(`${url}/vector/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace: "docs",
        vector: [1, 0, 0],
        topK: 1,
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].id).toBe("v1");
  });

  it("with vector custom path, mounts at specified path", async () => {
    const config: AimockConfig = {
      vector: {
        path: "/my-vector",
        collections: [{ name: "test", dimension: 2 }],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Upsert to the custom path (Pinecone-compatible)
    const resp = await fetch(`${url}/my-vector/vectors/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace: "test",
        vectors: [{ id: "a", values: [1, 0] }],
      }),
    });
    expect(resp.status).toBe(200);
  });

  it("with vector collections without vectors or queryResults", async () => {
    const config: AimockConfig = {
      vector: {
        collections: [{ name: "empty", dimension: 4 }],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Upsert to the collection to verify it was created (Pinecone-compatible)
    const resp = await fetch(`${url}/vector/vectors/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace: "empty",
        vectors: [{ id: "x", values: [1, 0, 0, 0] }],
      }),
    });
    expect(resp.status).toBe(200);
  });

  it("with vector config but no collections array", async () => {
    const config: AimockConfig = { vector: {} };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("with services.search enabled, /v1/search returns empty results", async () => {
    const config: AimockConfig = { services: { search: true } };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const resp = await fetch(`${url}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test query" }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.results).toEqual([]);
  });

  it("with services.rerank enabled, /v1/rerank returns empty results", async () => {
    const config: AimockConfig = { services: { rerank: true } };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const resp = await fetch(`${url}/v2/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", documents: ["a", "b"] }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.results).toEqual([]);
  });

  it("with services.moderate enabled, /v1/moderations returns unflagged", async () => {
    const config: AimockConfig = { services: { moderate: true } };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const resp = await fetch(`${url}/v1/moderations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "some text" }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.results[0].flagged).toBe(false);
  });

  it("with mcp prompts config, prompts are served", async () => {
    const config: AimockConfig = {
      mcp: {
        prompts: [
          {
            name: "greeting",
            description: "A greeting prompt",
            result: {
              messages: [{ role: "assistant", content: { type: "text", text: "Hello!" } }],
            },
          },
          {
            name: "no-result-prompt",
            description: "A prompt without a result handler",
          },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Initialize MCP session
    const initRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;
    await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });

    // List prompts
    const listRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "prompts/list", params: {}, id: 2 }),
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.result.prompts).toHaveLength(2);

    // Get prompt with result handler
    const getRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "prompts/get",
        params: { name: "greeting" },
        id: 3,
      }),
    });
    const getData = await getRes.json();
    expect(getData.result.messages[0].content.text).toBe("Hello!");
  });

  it("with mcp serverInfo config, serverInfo is set", async () => {
    const config: AimockConfig = {
      mcp: {
        serverInfo: { name: "test-server", version: "1.0.0" },
        tools: [{ name: "t1" }],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const initRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    expect(initRes.status).toBe(200);
    const initData = await initRes.json();
    expect(initData.result.serverInfo.name).toBe("test-server");
    expect(initData.result.serverInfo.version).toBe("1.0.0");
  });

  it("with mcp resource without content, addResource called with undefined content", async () => {
    const config: AimockConfig = {
      mcp: {
        resources: [{ uri: "file:///empty.txt", name: "empty" }],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Initialize MCP session
    const initRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;
    await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });

    // List resources — resource should be registered
    const listRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "resources/list", params: {}, id: 2 }),
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.result.resources).toHaveLength(1);
    expect(listData.result.resources[0].uri).toBe("file:///empty.txt");
  });

  it("with a2a tasks config, tasks are handled", async () => {
    const config: AimockConfig = {
      a2a: {
        agents: [
          {
            name: "task-agent",
            description: "An agent with tasks",
            skills: [{ id: "s1", name: "do-work" }],
            tasks: [
              {
                pattern: "work",
                artifacts: [
                  {
                    artifactId: "a1",
                    parts: [{ text: "result of work" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Send message that matches a task pattern
    const resp = await fetch(`${url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "SendMessage",
        params: {
          message: { parts: [{ text: "do some work" }] },
        },
        id: 1,
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.result.task.artifacts[0].parts[0].text).toBe("result of work");
  });

  it("with a2a streamingTasks config, streamingTasks are handled", async () => {
    const config: AimockConfig = {
      a2a: {
        agents: [
          {
            name: "stream-agent",
            description: "An agent with streaming tasks",
            skills: [{ id: "s1", name: "stream" }],
            streamingTasks: [
              {
                pattern: "stream",
                events: [
                  {
                    kind: "status-update",
                    taskId: "t1",
                    status: { state: "working", message: { parts: [{ text: "streaming..." }] } },
                  },
                ],
                delayMs: 0,
              },
            ],
          },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Verify agent card is available (streaming tasks also need agent registered)
    const cardRes = await fetch(`${url}/a2a/.well-known/agent-card.json`);
    expect(cardRes.status).toBe(200);
    const card = await cardRes.json();
    expect(card.name).toBe("stream-agent");
  });

  it("with a2a custom path, mounts at specified path for tasks", async () => {
    // Already tested for messages in existing test; verify the a2a path default as well
    const config: AimockConfig = {
      a2a: {
        agents: [
          {
            name: "default-path-agent",
            messages: [{ pattern: "hi", parts: [{ text: "hey" }] }],
          },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Default A2A path is /a2a
    const cardRes = await fetch(`${url}/a2a/.well-known/agent-card.json`);
    expect(cardRes.status).toBe(200);
  });

  it("with a2a message pattern without parts, uses default empty text part", async () => {
    const config: AimockConfig = {
      a2a: {
        agents: [
          {
            name: "fallback-agent",
            messages: [{ pattern: "anything" }],
          },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Send message matching pattern — default parts [{ text: "" }] should be used
    const resp = await fetch(`${url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "SendMessage",
        params: { message: { parts: [{ text: "anything at all" }] } },
        id: 1,
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.result.message.parts[0].text).toBe("");
  });

  it("with a2a task pattern without artifacts, uses default empty array", async () => {
    const config: AimockConfig = {
      a2a: {
        agents: [
          {
            name: "no-artifact-agent",
            tasks: [{ pattern: "work" }],
          },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    const resp = await fetch(`${url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "SendMessage",
        params: { message: { parts: [{ text: "do work" }] } },
        id: 1,
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.result.task.artifacts).toEqual([]);
  });

  it("with a2a streamingTask pattern without events, uses default empty array", async () => {
    const config: AimockConfig = {
      a2a: {
        agents: [
          {
            name: "no-events-agent",
            streamingTasks: [{ pattern: "stream" }],
          },
        ],
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Verify agent card is available (confirms registration works)
    const cardRes = await fetch(`${url}/a2a/.well-known/agent-card.json`);
    expect(cardRes.status).toBe(200);
    const card = await cardRes.json();
    expect(card.name).toBe("no-events-agent");
  });

  it("with record config, aimock receives record settings", async () => {
    const config: AimockConfig = {
      llm: {
        record: {
          providers: { openai: "sk-test-key" },
          fixturePath: "/tmp/recorded-fixtures",
        },
      },
    };
    const { llmock, url } = await startFromConfig(config);
    cleanups.push(() => llmock.stop());

    // Server should start successfully with record config
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
