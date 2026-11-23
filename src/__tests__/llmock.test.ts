import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LLMock } from "../llmock.js";
import { Journal, isChatCompletionBody } from "../journal.js";
import { createServer } from "../server.js";
import { loadFixtureFile } from "../fixture-loader.js";
import { fixtureMisbehaviorSourceKey, getFixtureMisbehaviorPosition } from "../misbehavior.js";
import type { ChatCompletionRequest, Fixture, JournalEntry, MisbehaviorConfig } from "../types.js";

// ---- Helpers ----

/**
 * The chat request a journal entry recorded.
 *
 * `JournalEntry.body` is a union — not every service journals a chat request —
 * so reading `messages` off one needs a narrowing step. Throwing here names the
 * problem ("this entry is not a chat request") at the point it exists, instead
 * of letting a non-chat entry surface as an undefined property inside an
 * expectation.
 */
function chatBodyOf(entry: JournalEntry | null | undefined): ChatCompletionRequest {
  const body = entry?.body;
  if (!isChatCompletionBody(body)) {
    throw new Error(`journal entry has no chat-completion body: ${JSON.stringify(body)}`);
  }
  return body;
}

const FIXTURES_DIR = resolve(import.meta.dirname, "../../fixtures");

function post(url: string, body: object): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, data }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function postTo(
  url: string,
  path: string,
  body: object,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, data }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function chatBody(userMessage: string, stream = true) {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: userMessage }],
    stream,
  };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aimock-test-"));
}

// ---- Tests ----

describe("LLMock", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      try {
        await mock.stop();
      } catch (err) {
        // Expected when test already stopped the server
        if (!(err instanceof Error && err.message === "Server not started")) {
          throw err;
        }
      }
      mock = null;
    }
  });

  describe("constructor", () => {
    it("creates an instance with default options", () => {
      mock = new LLMock();
      expect(mock).toBeInstanceOf(LLMock);
    });

    it("accepts custom options", () => {
      mock = new LLMock({
        port: 0,
        host: "127.0.0.1",
        latency: 50,
      });
      expect(mock).toBeInstanceOf(LLMock);
    });
  });

  describe("fixture management", () => {
    it("addFixture adds a fixture and returns this", () => {
      mock = new LLMock();
      const result = mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });
      expect(result).toBe(mock);
    });

    it("addFixtures adds multiple fixtures and returns this", () => {
      mock = new LLMock();
      const result = mock.addFixtures([
        {
          match: { userMessage: "a" },
          response: { content: "A" },
        },
        {
          match: { userMessage: "b" },
          response: { content: "B" },
        },
      ]);
      expect(result).toBe(mock);
    });

    it("addFixturesFromJSON throws a contextful error on malformed JSON", () => {
      const m = new LLMock();
      mock = m;
      expect(() => m.addFixturesFromJSON("{ not valid json")).toThrow(/addFixturesFromJSON/);
    });

    it("chaining API works across multiple calls", () => {
      mock = new LLMock();
      const result = mock
        .addFixture({
          match: { userMessage: "hello" },
          response: { content: "Hi!" },
        })
        .addFixtures([
          {
            match: { userMessage: "bye" },
            response: { content: "Bye!" },
          },
        ]);
      expect(result).toBe(mock);
    });

    it("prependFixture inserts at the front and returns this", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "second" },
        response: { content: "Second" },
      });
      const result = mock.prependFixture({
        match: { userMessage: "first" },
        response: { content: "First" },
      });
      expect(result).toBe(mock);

      const fixtures = mock.getFixtures();
      expect(fixtures).toHaveLength(2);
      expect(fixtures[0].match.userMessage).toBe("first");
      expect(fixtures[1].match.userMessage).toBe("second");
    });

    it("prependFixture is visible to a running server", async () => {
      mock = new LLMock();
      // Add a catch-all that matches everything
      mock.addFixture({
        match: { predicate: () => true },
        response: { content: "catch-all" },
      });
      await mock.start();

      // Prepend a specific fixture — it should match first
      mock.prependFixture({
        match: { userMessage: "specific" },
        response: { content: "specific response" },
      });

      const res = await post(mock.url, chatBody("specific"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("specific response");
    });

    it("getFixtures returns a readonly view of all fixtures", () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "a" },
        response: { content: "A" },
      });
      mock.addFixture({
        match: { userMessage: "b" },
        response: { content: "B" },
      });

      const fixtures = mock.getFixtures();
      expect(fixtures).toHaveLength(2);
      expect(fixtures[0].match.userMessage).toBe("a");
      expect(fixtures[1].match.userMessage).toBe("b");
    });

    it("getFixtures returns empty array when no fixtures added", () => {
      mock = new LLMock();
      expect(mock.getFixtures()).toHaveLength(0);
    });

    it("getFixtures reflects mutations from clearFixtures", () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "a" },
        response: { content: "A" },
      });
      expect(mock.getFixtures()).toHaveLength(1);

      mock.clearFixtures();
      expect(mock.getFixtures()).toHaveLength(0);
    });

    it("clearFixtures empties all fixtures and returns this", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      const result = mock.clearFixtures();
      expect(result).toBe(mock);

      // Start server — with no fixtures, requests should get 404
      await mock.start();
      const res = await post(mock.url, chatBody("hello"));
      expect(res.status).toBe(404);
    });

    it("on() shorthand adds a fixture", async () => {
      mock = new LLMock();
      mock.on({ userMessage: "on-test" }, { content: "on response" });

      await mock.start();
      const res = await post(mock.url, chatBody("on-test"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("on response");
    });

    it("on() shorthand passes id and model overrides", async () => {
      mock = new LLMock();
      mock.on(
        { userMessage: "override-test" },
        { content: "overridden", id: "custom-id-123", model: "custom-model-456" },
      );

      await mock.start();
      const res = await post(mock.url, chatBody("override-test", false));
      expect(res.status).toBe(200);
      const json = JSON.parse(res.data);
      expect(json.id).toBe("custom-id-123");
      expect(json.model).toBe("custom-model-456");
    });

    it("on() shorthand passes latency and chunkSize opts", async () => {
      mock = new LLMock();
      mock.on({ userMessage: "opts-test" }, { content: "response" }, { latency: 0, chunkSize: 5 });

      await mock.start();
      const res = await post(mock.url, chatBody("opts-test"));
      expect(res.status).toBe(200);
    });
  });

  describe("loadFixtureFile", () => {
    it("loads fixtures from a JSON file", async () => {
      mock = new LLMock();
      mock.loadFixtureFile(join(FIXTURES_DIR, "example-greeting.json"));

      await mock.start();
      const res = await post(mock.url, chatBody("hello"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("Hello!");
    });

    it("returns this for chaining", () => {
      mock = new LLMock();
      const result = mock.loadFixtureFile(join(FIXTURES_DIR, "example-greeting.json"));
      expect(result).toBe(mock);
    });
  });

  describe("loadFixtureDir", () => {
    it("loads all JSON fixtures from a directory", async () => {
      mock = new LLMock();
      mock.loadFixtureDir(FIXTURES_DIR);

      await mock.start();

      // example-greeting.json has a "hello" fixture
      const res = await post(mock.url, chatBody("hello"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("Hello!");
    });

    it("returns this for chaining", () => {
      mock = new LLMock();
      const result = mock.loadFixtureDir(FIXTURES_DIR);
      expect(result).toBe(mock);
    });

    it("loads from a temp directory with custom fixtures", async () => {
      const tmpDir = makeTmpDir();
      try {
        writeFileSync(
          join(tmpDir, "custom.json"),
          JSON.stringify({
            fixtures: [
              {
                match: { userMessage: "custom" },
                response: { content: "custom response" },
              },
            ],
          }),
        );

        mock = new LLMock();
        mock.loadFixtureDir(tmpDir);

        await mock.start();
        const res = await post(mock.url, chatBody("custom"));
        expect(res.status).toBe(200);
        expect(res.data).toContain("custom response");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("server lifecycle", () => {
    it("start returns a URL", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      const url = await mock.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("start throws if server already started", async () => {
      mock = new LLMock();
      await mock.start();
      await expect(mock.start()).rejects.toThrow("Server already started");
    });

    it("stop closes the server", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      await mock.start();
      const url = mock.url;
      await mock.stop();
      mock = null; // prevent afterEach double-stop

      // Making a request to the stopped server should fail
      await expect(post(url, chatBody("hello"))).rejects.toThrow();
    });

    it("stop throws if server not started", async () => {
      mock = new LLMock();
      await expect(mock.stop()).rejects.toThrow("Server not started");
    });

    it("stop rejects when server.close() errors", async () => {
      mock = new LLMock();
      await mock.start();

      // Access the underlying http.Server via the private serverInstance field
      const internal = mock as unknown as { serverInstance: { server: http.Server } | null };
      const realClose = internal.serverInstance!.server.close.bind(internal.serverInstance!.server);

      // Monkey-patch close to invoke its callback with an Error
      internal.serverInstance!.server.close = ((cb?: (err?: Error) => void) => {
        // Still actually close the server so cleanup works
        return realClose(() => {
          if (cb) cb(new Error("close failed"));
        });
      }) as unknown as typeof realClose;

      await expect(mock.stop()).rejects.toThrow("close failed");

      // stop() rejected so serverInstance is still set — null it out manually
      // since the real server is already closed
      internal.serverInstance = null;
      mock = null; // prevent afterEach double-stop
    });

    it("can restart after stop", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      await mock.start();
      await mock.stop();
      mock = null; // clear for safety

      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi again!" },
      });
      await mock.start();

      const res = await post(mock.url, chatBody("hello"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("Hi again!");
    });
  });

  describe("url getter", () => {
    it("throws before server is started", () => {
      mock = new LLMock();
      expect(() => mock!.url).toThrow("Server not started");
    });

    it("returns url after server is started", async () => {
      mock = new LLMock();
      await mock.start();
      expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  describe("journal getter", () => {
    it("throws before server is started", () => {
      mock = new LLMock();
      expect(() => mock!.journal).toThrow("Server not started");
    });

    it("returns a Journal instance after start", async () => {
      mock = new LLMock();
      await mock.start();
      expect(mock.journal).toBeInstanceOf(Journal);
    });

    it("journal records requests", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "journal-test" },
        response: { content: "recorded" },
      });

      await mock.start();
      await post(mock.url, chatBody("journal-test"));

      expect(mock.journal.size).toBe(1);
      const entry = mock.journal.getLast();
      expect(entry).not.toBeNull();
      expect(chatBodyOf(entry).messages[0].content).toBe("journal-test");
    });
  });

  describe("request handling", () => {
    it("serves a streaming text response", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "stream" },
        response: { content: "streamed content" },
      });

      await mock.start();
      const res = await post(mock.url, chatBody("stream", true));
      expect(res.status).toBe(200);
      expect(res.data).toContain("streamed content");
      expect(res.data).toContain("[DONE]");
    });

    it("returns 404 when no fixture matches", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "hello" },
        response: { content: "Hi!" },
      });

      await mock.start();
      const res = await post(mock.url, chatBody("no-match-here"));
      expect(res.status).toBe(404);
    });

    it("fixtures added after start are visible", async () => {
      mock = new LLMock();
      await mock.start();

      // No fixtures yet — should 404
      const res1 = await post(mock.url, chatBody("late-add"));
      expect(res1.status).toBe(404);

      // Add a fixture after start
      mock.addFixture({
        match: { userMessage: "late-add" },
        response: { content: "late response" },
      });

      // Now it should match
      const res2 = await post(mock.url, chatBody("late-add"));
      expect(res2.status).toBe(200);
      expect(res2.data).toContain("late response");
    });
  });

  describe("onMessage convenience", () => {
    it("registers a fixture matching a string userMessage", async () => {
      mock = new LLMock();
      mock.onMessage("greet", { content: "Hi!" });
      await mock.start();

      const res = await post(mock.url, chatBody("greet"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("Hi!");
    });

    it("registers a fixture matching a regex userMessage", async () => {
      mock = new LLMock();
      mock.onMessage(/hel+o/, { content: "Matched!" });
      await mock.start();

      const res = await post(mock.url, chatBody("helllllo"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("Matched!");
    });

    it("returns this for chaining", () => {
      mock = new LLMock();
      expect(mock.onMessage("x", { content: "y" })).toBe(mock);
    });
  });

  describe("onEmbedding convenience", () => {
    it("registers a fixture matching an inputText string", async () => {
      mock = new LLMock();
      mock.onEmbedding("embed-test", { embedding: [0.1, 0.2, 0.3] });
      await mock.start();

      const res = await new Promise<{ status: number; data: string }>((resolve, reject) => {
        const parsed = new URL(mock!.url);
        const payload = JSON.stringify({
          model: "text-embedding-3-small",
          input: "embed-test input",
        });
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: "/v1/embeddings",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve({ status: res.statusCode!, data }));
          },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });

      expect(res.status).toBe(200);
      const json = JSON.parse(res.data);
      expect(json.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it("returns this for chaining", () => {
      mock = new LLMock();
      expect(mock.onEmbedding("x", { embedding: [0.1] })).toBe(mock);
    });
  });

  describe("onToolCall convenience", () => {
    it("onToolCall live server returns tool call response", async () => {
      mock = new LLMock();
      mock.onToolCall("get_weather", {
        toolCalls: [{ name: "get_weather", arguments: JSON.stringify({ city: "SF" }) }],
      });
      await mock.start();

      const res = await post(mock.url, {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        stream: false,
      });

      expect(res.status).toBe(200);
      const json = JSON.parse(res.data);
      expect(json.choices[0].message.tool_calls).toBeDefined();
      expect(json.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
      expect(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments)).toEqual({
        city: "SF",
      });
    });

    it("returns this for chaining", () => {
      mock = new LLMock();
      expect(mock.onToolCall("fn", { content: "r" })).toBe(mock);
    });
  });

  describe("programmatic API auto-stringification", () => {
    it("on() auto-stringifies object arguments in toolCalls", async () => {
      mock = new LLMock();
      mock.on(
        { userMessage: "weather" },
        {
          toolCalls: [{ name: "get_weather", arguments: { city: "SF" } }],
        },
      );
      await mock.start();

      const res = await post(mock.url, {
        model: "gpt-4",
        messages: [{ role: "user", content: "weather" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const json = JSON.parse(res.data);
      const args = json.choices[0].message.tool_calls[0].function.arguments;
      expect(typeof args).toBe("string");
      expect(JSON.parse(args)).toEqual({ city: "SF" });
    });

    it("onMessage() auto-stringifies object content", async () => {
      mock = new LLMock();
      mock.onMessage("structured", { content: { answer: 42, nested: { key: "val" } } });
      await mock.start();

      const res = await post(mock.url, chatBody("structured", false));

      expect(res.status).toBe(200);
      const json = JSON.parse(res.data);
      const content = json.choices[0].message.content;
      expect(typeof content).toBe("string");
      expect(JSON.parse(content)).toEqual({ answer: 42, nested: { key: "val" } });
    });

    it("on() preserves string arguments without double-stringifying", async () => {
      mock = new LLMock();
      mock.on(
        { userMessage: "already-string" },
        {
          toolCalls: [{ name: "fn", arguments: JSON.stringify({ key: "val" }) }],
        },
      );
      await mock.start();

      const res = await post(mock.url, {
        model: "gpt-4",
        messages: [{ role: "user", content: "already-string" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const json = JSON.parse(res.data);
      const args = json.choices[0].message.tool_calls[0].function.arguments;
      expect(JSON.parse(args)).toEqual({ key: "val" });
    });
  });

  describe("onJsonOutput convenience", () => {
    it("registers a fixture with responseFormat json_object and stringified content", () => {
      mock = new LLMock();
      mock.onJsonOutput("json-test", { name: "Alice", age: 30 });

      const fixtures = mock.getFixtures();
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].match.userMessage).toBe("json-test");
      expect(fixtures[0].match.responseFormat).toBe("json_object");
      expect((fixtures[0].response as { content: string }).content).toBe(
        JSON.stringify({ name: "Alice", age: 30 }),
      );
    });

    it("accepts a string as jsonContent and uses it directly", () => {
      mock = new LLMock();
      mock.onJsonOutput("json-str", '{"key":"value"}');

      const fixtures = mock.getFixtures();
      expect((fixtures[0].response as { content: string }).content).toBe('{"key":"value"}');
    });

    it("accepts a RegExp pattern", () => {
      mock = new LLMock();
      mock.onJsonOutput(/json-\d+/, { result: true });

      const fixtures = mock.getFixtures();
      expect(fixtures[0].match.userMessage).toEqual(/json-\d+/);
    });

    it("returns this for chaining", () => {
      mock = new LLMock();
      expect(mock.onJsonOutput("x", { a: 1 })).toBe(mock);
    });

    it("passes through opts like latency", () => {
      mock = new LLMock();
      mock.onJsonOutput("opts", { a: 1 }, { latency: 100 });

      const fixtures = mock.getFixtures();
      expect(fixtures[0].latency).toBe(100);
    });

    it("serves JSON content through the server", async () => {
      mock = new LLMock();
      mock.onJsonOutput("give-json", { answer: 42 });
      await mock.start();

      const res = await post(mock.url, {
        model: "gpt-4",
        messages: [{ role: "user", content: "give-json" }],
        stream: false,
        response_format: { type: "json_object" },
      });
      expect(res.status).toBe(200);
      const json = JSON.parse(res.data);
      const content = json.choices[0].message.content;
      expect(JSON.parse(content)).toEqual({ answer: 42 });
    });
  });

  describe("onToolResult convenience", () => {
    it("returns this for chaining", () => {
      mock = new LLMock();
      expect(mock.onToolResult("call_123", { content: "r" })).toBe(mock);
    });

    it("onToolResult matches tool result messages and returns fixture", async () => {
      mock = new LLMock();
      mock.onToolResult("call_abc", { content: "tool result response" });
      await mock.start();

      const res = await post(mock.url, {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_abc", type: "function", function: { name: "lookup", arguments: "{}" } },
            ],
          },
          { role: "tool", content: "42", tool_call_id: "call_abc" },
        ],
        stream: false,
      });

      expect(res.status).toBe(200);
      const json = JSON.parse(res.data);
      expect(json.choices[0].message.content).toBe("tool result response");
    });
  });

  describe("nextRequestError", () => {
    it("returns an error on the next request then removes itself", async () => {
      mock = new LLMock();
      mock.onMessage("hello", { content: "Hi!" });
      await mock.start();

      mock.nextRequestError(503, { message: "Overloaded", type: "server_error" });

      // First request should get the error
      const res1 = await post(mock.url, chatBody("hello"));
      expect(res1.status).toBe(503);
      const body1 = JSON.parse(res1.data);
      expect(body1.error.message).toBe("Overloaded");

      // Second request should get the normal fixture
      const res2 = await post(mock.url, chatBody("hello"));
      expect(res2.status).toBe(200);
      expect(res2.data).toContain("Hi!");
    });

    it("uses default error message when none provided", async () => {
      mock = new LLMock();
      mock.onMessage("hello", { content: "Hi!" });
      await mock.start();

      mock.nextRequestError(500);

      const res = await post(mock.url, chatBody("hello"));
      expect(res.status).toBe(500);
      const body = JSON.parse(res.data);
      expect(body.error.message).toBe("Injected error");
    });

    it("returns this for chaining", () => {
      mock = new LLMock();
      expect(mock.nextRequestError(500)).toBe(mock);
    });

    it("stacks multiple one-shot errors (last pushed fires first)", async () => {
      mock = new LLMock();
      mock.onMessage("hello", { content: "Normal response" });
      await mock.start();

      // Push two errors — unshift means the LAST call ends up at index 0
      mock.nextRequestError(429, { message: "Rate limited" });
      mock.nextRequestError(503, { message: "Unavailable" });

      // First request → 503 (last pushed = index 0)
      const res1 = await post(mock.url, chatBody("hello"));
      expect(res1.status).toBe(503);
      const body1 = JSON.parse(res1.data);
      expect(body1.error.message).toBe("Unavailable");

      // Second request → 429 (first pushed, now at index 0 after 503 removed)
      const res2 = await post(mock.url, chatBody("hello"));
      expect(res2.status).toBe(429);
      const body2 = JSON.parse(res2.data);
      expect(body2.error.message).toBe("Rate limited");

      // Third request → normal fixture matching
      const res3 = await post(mock.url, chatBody("hello"));
      expect(res3.status).toBe(200);
      expect(res3.data).toContain("Normal response");
    });

    it("does not let an incompatible (multimedia) endpoint consume a chat-bound one-shot error", async () => {
      mock = new LLMock();
      mock.onMessage("hello", { content: "Hi!" });
      mock.onImage("draw a cat", { image: { b64Json: "aW1n" } });
      await mock.start();

      // Queue a one-shot error. Conceptually intended for the chat endpoint;
      // an error response is incompatible with the image endpoint (mirrors the
      // router's endpoint-compat table, where only `fal` accepts errors).
      mock.nextRequestError(503, { message: "Overloaded", type: "server_error" });

      // Issue an INCOMPATIBLE image request FIRST. It must NOT consume the
      // error: the image fixture should serve normally and the error stays
      // pending for a compatible endpoint.
      const img = await postTo(mock.url, "/v1/images/generations", {
        model: "dall-e-3",
        prompt: "draw a cat",
      });
      expect(img.status).toBe(200);
      expect(img.data).toContain("aW1n");

      // The one-shot error must STILL be pending → the next chat request gets it.
      const chat = await post(mock.url, chatBody("hello"));
      expect(chat.status).toBe(503);
      const body = JSON.parse(chat.data);
      expect(body.error.message).toBe("Overloaded");
    });

    it("fires on an elevenlabs-voice-design request and is consumed by it", async () => {
      mock = new LLMock();
      mock.onElevenLabsVoiceDesign(/sea captain/, {
        previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==" }],
        text: "Ahoy",
      });
      await mock.start();

      // The router's endpoint-compat table marks the four elevenlabs-voice*
      // types as error-compatible; the one-shot gate must agree or the error
      // silently stays pending while the voice route answers normally.
      mock.nextRequestError(503, { message: "Voice outage", type: "server_error" });

      const design = {
        voice_description: "A gruff old sea captain with a gravelly voice and a thick accent",
      };
      const first = await postTo(mock.url, "/v1/text-to-voice/design", design);
      expect(first.status).toBe(503);
      expect(JSON.parse(first.data).error.message).toBe("Voice outage");

      // One-shot: the same request now reaches the voice fixture.
      const second = await postTo(mock.url, "/v1/text-to-voice/design", design);
      expect(second.status).toBe(200);
      expect(second.data).toContain("p1");
    });

    it("fires on an elevenlabs-voice-get request and is consumed by it", async () => {
      mock = new LLMock();
      await mock.start();

      mock.nextRequestError(503, { message: "Voice outage", type: "server_error" });

      const first = await new Promise<{ status: number; data: string }>((res, rej) => {
        http
          .get(`${mock!.url}/v1/voices/aimock-nonexistent-voice`, (r) => {
            let data = "";
            r.on("data", (c: Buffer) => (data += c.toString()));
            r.on("end", () => res({ status: r.statusCode ?? 0, data }));
          })
          .on("error", rej);
      });
      expect(first.status).toBe(503);
      expect(JSON.parse(first.data).error.message).toBe("Voice outage");

      // Consumed: a chat request no longer sees the pending error.
      mock.onMessage("hello", { content: "Hi!" });
      const chat = await post(mock.url, chatBody("hello"));
      expect(chat.status).toBe(200);
    });
  });

  describe("journal proxies", () => {
    it("getRequests returns journal entries", async () => {
      mock = new LLMock();
      mock.onMessage("hi", { content: "Hello" });
      await mock.start();

      await post(mock.url, chatBody("hi"));
      await post(mock.url, chatBody("hi"));

      const requests = mock.getRequests();
      expect(requests).toHaveLength(2);
    });

    it("getLastRequest returns last entry", async () => {
      mock = new LLMock();
      mock.onMessage("a", { content: "A" });
      mock.onMessage("b", { content: "B" });
      await mock.start();

      await post(mock.url, chatBody("a"));
      await post(mock.url, chatBody("b"));

      const last = mock.getLastRequest();
      expect(last).not.toBeNull();
      expect(chatBodyOf(last).messages[0].content).toBe("b");
    });

    it("getLastRequest returns null when no requests", async () => {
      mock = new LLMock();
      await mock.start();
      expect(mock.getLastRequest()).toBeNull();
    });

    it("clearRequests empties the journal", async () => {
      mock = new LLMock();
      mock.onMessage("hi", { content: "Hello" });
      await mock.start();

      await post(mock.url, chatBody("hi"));
      expect(mock.journal.size).toBe(1);

      mock.clearRequests();
      expect(mock.journal.size).toBe(0);
    });

    it("getRequests throws when server not started", () => {
      mock = new LLMock();
      expect(() => mock!.getRequests()).toThrow("Server not started");
    });
  });

  describe("resetMatchCounts", () => {
    it("clears match counts without clearing fixtures or journal", async () => {
      mock = new LLMock();
      mock.onMessage("hi", { content: "Hello" });
      await mock.start();

      // Make a request to populate journal and match counts
      await post(mock.url, chatBody("hi"));
      expect(mock.journal.size).toBe(1);
      expect(mock.journal.fixtureMatchCounts.size).toBeGreaterThan(0);

      // resetMatchCounts should clear counts but not journal or fixtures
      mock.resetMatchCounts();
      expect(mock.journal.fixtureMatchCounts.size).toBe(0);
      expect(mock.journal.size).toBe(1); // journal entries preserved
      expect(mock.getFixtures()).toHaveLength(1); // fixtures preserved

      // Fixture should still work
      const res = await post(mock.url, chatBody("hi"));
      expect(res.status).toBe(200);
    });
  });

  describe("reset", () => {
    it("clears fixtures and journal", async () => {
      mock = new LLMock();
      mock.onMessage("hi", { content: "Hello" });
      await mock.start();

      await post(mock.url, chatBody("hi"));
      expect(mock.journal.size).toBe(1);

      mock.reset();
      expect(mock.journal.size).toBe(0);

      // Fixture should be gone — request 404s
      const res = await post(mock.url, chatBody("hi"));
      expect(res.status).toBe(404);
    });

    it("returns this for chaining", async () => {
      mock = new LLMock();
      await mock.start();
      expect(mock.reset()).toBe(mock);
    });

    it("works even before server starts (just clears fixtures)", () => {
      mock = new LLMock();
      mock.onMessage("hi", { content: "Hello" });
      expect(mock.reset()).toBe(mock);
    });

    it("is idempotent — calling reset() twice causes no error", async () => {
      mock = new LLMock();
      mock.onMessage("hi", { content: "Hello" });
      await mock.start();

      // Make a request so journal has an entry
      await post(mock.url, chatBody("hi"));
      expect(mock.journal.size).toBe(1);

      // First reset clears everything
      mock.reset();
      expect(mock.journal.size).toBe(0);

      // Second reset immediately — no error, still empty
      mock.reset();
      expect(mock.journal.size).toBe(0);

      // All fixtures gone — should 404
      const res = await post(mock.url, chatBody("hi"));
      expect(res.status).toBe(404);
    });

    it("after reset, only newly added fixtures are active", async () => {
      mock = new LLMock();
      mock.onMessage("old", { content: "Old response" });
      mock.onMessage("new", { content: "New response" });
      await mock.start();

      // Both fixtures work before reset
      const res1 = await post(mock.url, chatBody("old"));
      expect(res1.status).toBe(200);

      mock.reset();

      // Add only one fixture back
      mock.onMessage("new", { content: "Fresh response" });

      // Old fixture is gone
      const res2 = await post(mock.url, chatBody("old"));
      expect(res2.status).toBe(404);

      // New fixture works
      const res3 = await post(mock.url, chatBody("new"));
      expect(res3.status).toBe(200);
      expect(res3.data).toContain("Fresh response");
    });

    it("clearFixtures works before server is started", () => {
      mock = new LLMock();
      mock.onMessage("hi", { content: "Hello" });
      // clearFixtures alone should not throw before start
      expect(mock.clearFixtures()).toBe(mock);
    });

    // reset() must be the in-process equivalent of POST /__aimock/reset. These
    // exercise the stores the in-process path used to leave behind.
    it("clears Veo and Grok video job state — pre-reset poll ids stop resolving", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "veo clip", endpoint: "video" },
        response: {
          video: { id: "veo_reset", status: "completed", url: "https://files.example/v.mp4" },
        },
      });
      mock.addFixture({
        match: { userMessage: "grok clip", endpoint: "video" },
        response: {
          video: { id: "vid_grok_reset", status: "completed", url: "https://cdn.x.ai/v.mp4" },
        },
      });
      await mock.start();

      const veoSubmit = (await (
        await fetch(`${mock.url}/v1beta/models/veo-3.1-generate-preview:predictLongRunning`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instances: [{ prompt: "veo clip" }] }),
        })
      ).json()) as { name: string };
      expect(typeof veoSubmit.name).toBe("string");

      const grokSubmit = (await (
        await fetch(`${mock.url}/v1/videos/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "grok-imagine-video", prompt: "grok clip" }),
        })
      ).json()) as { request_id: string };
      expect(typeof grokSubmit.request_id).toBe("string");

      // Both jobs resolve while they are still in the maps.
      expect((await fetch(`${mock.url}/v1beta/${veoSubmit.name}`)).status).toBe(200);
      expect((await fetch(`${mock.url}/v1/videos/${grokSubmit.request_id}`)).status).toBe(200);

      mock.reset();

      expect((await fetch(`${mock.url}/v1beta/${veoSubmit.name}`)).status).toBe(404);
      expect((await fetch(`${mock.url}/v1/videos/${grokSubmit.request_id}`)).status).toBe(404);
    });

    it("rewinds the Gemini interaction-id counter", async () => {
      mock = new LLMock();
      mock.onMessage("hello", { content: "Hi there!" });
      await mock.start();

      const first = JSON.parse(
        (
          await postTo(mock.url, "/v1beta/interactions", {
            model: "gemini-2.5-flash",
            input: "hello",
            stream: false,
          })
        ).data,
      ) as { id: string };
      const second = JSON.parse(
        (
          await postTo(mock.url, "/v1beta/interactions", {
            model: "gemini-2.5-flash",
            input: "hello",
            stream: false,
          })
        ).data,
      ) as { id: string };
      // The counter really did advance, so a rewind is observable.
      expect(first.id).not.toBe(second.id);

      mock.reset();
      mock.onMessage("hello", { content: "Hi there!" });

      const afterReset = JSON.parse(
        (
          await postTo(mock.url, "/v1beta/interactions", {
            model: "gemini-2.5-flash",
            input: "hello",
            stream: false,
          })
        ).data,
      ) as { id: string };
      expect(afterReset.id).toBe("aimock-int-0");
    });

    it("rewinds the Gemini interactions event-id counter", async () => {
      mock = new LLMock();
      mock.onMessage("hello", { content: "Hi there!" });
      await mock.start();

      // Burn some event ids on a streaming interaction.
      await postTo(mock.url, "/v1beta/interactions", {
        model: "gemini-2.5-flash",
        input: "hello",
        stream: true,
      });

      mock.reset();
      mock.onMessage("hello", { content: "Hi there!" });

      const res = await postTo(mock.url, "/v1beta/interactions", {
        model: "gemini-2.5-flash",
        input: "hello",
        stream: true,
      });
      const firstEventLine = res.data.split("\n").find((l) => l.startsWith("data: "));
      expect(firstEventLine).toBeDefined();
      const firstEvent = JSON.parse(firstEventLine!.slice(6)) as { event_id: string };
      expect(firstEvent.event_id).toBe("evt_1");
    });

    it("clears Sora video state — a pre-reset video id stops resolving", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "sora clip", endpoint: "video" },
        response: {
          video: { id: "video_sora_reset", status: "completed", url: "https://s/v.mp4" },
        },
      });
      await mock.start();

      const created = (await (
        await fetch(`${mock.url}/v1/videos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "sora-2", prompt: "sora clip" }),
        })
      ).json()) as { id: string };
      expect(typeof created.id).toBe("string");
      expect((await fetch(`${mock.url}/v1/videos/${created.id}`)).status).toBe(200);

      mock.reset();

      const after = await fetch(`${mock.url}/v1/videos/${created.id}`);
      expect(after.status).toBe(404);
      expect(((await after.json()) as { error: { type: string } }).error.type).toBe("not_found");
    });

    it("clears fal.ai audio queue jobs — a pre-reset request_id stops resolving", async () => {
      mock = new LLMock();
      mock.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
      await mock.start();

      const envelope = (await (
        await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "drum loop" }),
        })
      ).json()) as { request_id: string };
      expect(typeof envelope.request_id).toBe("string");
      expect(
        (await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}/status`)).status,
      ).toBe(200);

      mock.reset();

      expect(
        (await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}/status`)).status,
      ).toBe(404);
    });

    it("clears fal.ai general queue state — a pre-reset request_id stops resolving", async () => {
      mock = new LLMock();
      mock.onFalQueue(/flux/, { images: [{ url: "https://example.com/cat.png" }] });
      await mock.start();

      const falHeaders = { "x-fal-target-host": "queue.fal.run" };
      const envelope = (await (
        await fetch(`${mock.url}/fal/fal-ai/flux/dev`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...falHeaders },
          body: JSON.stringify({ input: { prompt: "a cat" } }),
        })
      ).json()) as { request_id: string };
      expect(typeof envelope.request_id).toBe("string");
      const statusUrl = `${mock.url}/fal/fal-ai/flux/dev/requests/${envelope.request_id}/status`;
      expect((await fetch(statusUrl, { headers: falHeaders })).status).toBe(200);

      mock.reset();

      expect((await fetch(statusUrl, { headers: falHeaders })).status).toBe(404);
    });

    // The full reset clears journal ENTRIES *and* per-test fixture
    // match-counts. Only the latter carries sequence position, so a reset that
    // used clearEntries() would leave sequenced fixtures parked mid-sequence.
    it("clears fixture match-counts, rewinding sequence position", async () => {
      const first = {
        match: { userMessage: "seq", sequenceIndex: 0 },
        response: { content: "FIRST" },
      };
      const second = {
        match: { userMessage: "seq", sequenceIndex: 1 },
        response: { content: "SECOND" },
      };
      mock = new LLMock();
      mock.addFixture(first).addFixture(second);
      await mock.start();

      // Counts are per-testId, so drive BOTH the default scope and a named
      // one — a reset that only clears the default sentinel would strand
      // every other tenant mid-sequence.
      const asTenant = (msg: string) =>
        fetch(`${mock!.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-test-id": "tenant-a" },
          body: JSON.stringify(chatBody(msg, false)),
        }).then((r) => r.text());

      expect((await post(mock.url, chatBody("seq"))).data).toContain("FIRST");
      expect((await post(mock.url, chatBody("seq"))).data).toContain("SECOND");
      expect(mock.journal.getFixtureMatchCount(first)).toBe(2);

      expect(await asTenant("seq")).toContain("FIRST");
      expect(await asTenant("seq")).toContain("SECOND");
      expect(mock.journal.getFixtureMatchCount(first, "tenant-a")).toBe(2);

      mock.reset();
      // Re-add the SAME fixture objects — counts are keyed by object identity,
      // so a surviving count would still be attached to them.
      mock.addFixture(first).addFixture(second);

      expect(mock.journal.getFixtureMatchCount(first)).toBe(0);
      expect(mock.journal.getFixtureMatchCount(first, "tenant-a")).toBe(0);
      expect((await post(mock.url, chatBody("seq"))).data).toContain("FIRST");
      expect(await asTenant("seq")).toContain("FIRST");
    });

    // The documented divergence from the HTTP reset: these three stores are
    // in-process only, so nothing but this test guards them.
    it("clears search, rerank and moderation fixtures", async () => {
      mock = new LLMock();
      mock.onSearch("weather", [
        { title: "Weather Report", url: "https://example.com/weather", content: "Sunny today" },
      ]);
      mock.onRerank("machine learning", [{ index: 0, relevance_score: 0.99 }]);
      mock.onModerate("violent", { flagged: true, categories: { violence: true } });
      await mock.start();

      const search = async () =>
        JSON.parse(
          (await postTo(mock!.url, "/search", { query: "What is the weather?" })).data,
        ) as {
          results: unknown[];
        };
      const rerank = async () =>
        JSON.parse(
          (
            await postTo(mock!.url, "/v2/rerank", {
              query: "What is machine learning?",
              documents: ["ML is a subset of AI"],
              model: "rerank-v3.5",
            })
          ).data,
        ) as { results: unknown[] };
      const moderate = async () =>
        JSON.parse(
          (await postTo(mock!.url, "/v1/moderations", { input: "This is violent content" })).data,
        ) as { results: Array<{ flagged: boolean }> };

      expect((await search()).results).toHaveLength(1);
      expect((await rerank()).results).toHaveLength(1);
      expect((await moderate()).results[0].flagged).toBe(true);

      mock.reset();

      // A cleared fixture store yields an empty/unflagged response, not an error.
      expect((await search()).results).toHaveLength(0);
      expect((await rerank()).results).toHaveLength(0);
      expect((await moderate()).results[0].flagged).toBe(false);
    });

    // performFullReset takes a null target before start(). The process-global
    // stores must still be cleared on that path.
    it("clears process-global state even when called before start()", async () => {
      // Seed the global fal stores and the Gemini counters through a first,
      // fully-started instance, then stop it.
      const seeder = new LLMock();
      seeder.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
      seeder.onMessage("hello", { content: "Hi there!" });
      await seeder.start();
      // The file-level afterEach only stops `mock`, so this handle is ours to
      // close on every path.
      let envelope: { request_id: string };
      try {
        envelope = (await (
          await fetch(`${seeder.url}/fal/queue/submit/fal-ai/stable-audio`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "drum loop" }),
          })
        ).json()) as { request_id: string };
        await postTo(seeder.url, "/v1beta/interactions", {
          model: "gemini-2.5-flash",
          input: "hello",
          stream: false,
        });
      } finally {
        await seeder.stop();
      }

      // A brand-new, NEVER-STARTED instance resets the process-global state.
      const unstarted = new LLMock();
      unstarted.onMessage("x", { content: "y" });
      unstarted.reset();
      expect(unstarted.getFixtures()).toHaveLength(0);

      // Observe through a fresh server: the seeded fal job is gone and the
      // Gemini interaction counter restarted.
      mock = new LLMock();
      mock.onMessage("hello", { content: "Hi there!" });
      await mock.start();
      expect(
        (await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}/status`)).status,
      ).toBe(404);
      const interaction = JSON.parse(
        (
          await postTo(mock.url, "/v1beta/interactions", {
            model: "gemini-2.5-flash",
            input: "hello",
            stream: false,
          })
        ).data,
      ) as { id: string };
      expect(interaction.id).toBe("aimock-int-0");
    });

    it("re-zeroes the aimock_fixtures_loaded gauge", async () => {
      mock = new LLMock({ metrics: true });
      mock.onMessage("a", { content: "1" });
      mock.onMessage("b", { content: "2" });
      await mock.start();

      const scrape = async () => (await fetch(`${mock!.url}/metrics`)).text();
      expect(await scrape()).toContain("aimock_fixtures_loaded{} 2");

      mock.reset();

      expect(await scrape()).toContain("aimock_fixtures_loaded{} 0");
    });
  });

  describe("baseUrl getter", () => {
    it("returns same value as url", async () => {
      mock = new LLMock();
      await mock.start();
      expect(mock.baseUrl).toBe(mock.url);
    });

    it("throws before server is started", () => {
      mock = new LLMock();
      expect(() => mock!.baseUrl).toThrow("Server not started");
    });
  });

  describe("port getter", () => {
    it("returns a number", async () => {
      mock = new LLMock();
      await mock.start();
      expect(typeof mock.port).toBe("number");
      expect(mock.port).toBeGreaterThan(0);
    });

    it("matches the port in the URL", async () => {
      mock = new LLMock();
      await mock.start();
      const urlPort = parseInt(new URL(mock.url).port, 10);
      expect(mock.port).toBe(urlPort);
    });

    it("throws before server is started", () => {
      mock = new LLMock();
      expect(() => mock!.port).toThrow("Server not started");
    });
  });

  describe("error status defaults", () => {
    it("error status defaults to 500 when omitted", async () => {
      mock = new LLMock();
      mock.addFixture({
        match: { userMessage: "err" },
        response: { error: { message: "boom", type: "server_error" } },
      });
      await mock.start();

      const res = await post(mock.url, chatBody("err", false));
      expect(res.status).toBe(500);
    });
  });

  describe("setChaos / clearChaos", () => {
    it("setChaos sets server-level chaos config", async () => {
      mock = new LLMock();
      mock.onMessage("hi", { content: "Hello" });
      mock.setChaos({ dropRate: 1.0 });
      await mock.start();

      const res = await post(mock.url, chatBody("hi"));
      expect(res.status).toBe(500);
      const body = JSON.parse(res.data);
      expect(body.error.code).toBe("chaos_drop");
    });

    it("clearChaos removes chaos config", async () => {
      mock = new LLMock();
      mock.onMessage("hi", { content: "Hello" });
      mock.setChaos({ dropRate: 1.0 });
      mock.clearChaos();
      await mock.start();

      const res = await post(mock.url, chatBody("hi"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("Hello");
    });

    it("setChaos returns this for chaining", () => {
      mock = new LLMock();
      expect(mock.setChaos({ dropRate: 0.5 })).toBe(mock);
    });
  });

  describe("static create()", () => {
    it("creates and starts a server", async () => {
      mock = await LLMock.create();
      expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(mock.journal).toBeInstanceOf(Journal);
    });

    it("accepts options", async () => {
      mock = await LLMock.create({
        host: "127.0.0.1",
        port: 0,
      });
      expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("allows adding fixtures after creation", async () => {
      mock = await LLMock.create();
      mock.addFixture({
        match: { userMessage: "factory-test" },
        response: { content: "factory response" },
      });

      const res = await post(mock.url, chatBody("factory-test"));
      expect(res.status).toBe(200);
      expect(res.data).toContain("factory response");
    });
  });

  describe("nextRequestError is consumed when SERVED, not when evaluated", () => {
    it("survives a request that a behind-the-count turnIndex fixture wins, then fires", async () => {
      mock = new LLMock();
      // turnIndex 0 is BEHIND a request carrying one assistant bubble
      // (assistantCount = 1), so selectByTurnIndex prefers it over the
      // unpositioned one-shot even though the one-shot's predicate matched.
      mock.onTurn(0, "hello", { content: "Scripted turn" });
      await mock.start();

      mock.nextRequestError(503, { message: "Overloaded", type: "server_error" });

      const behind = await post(mock.url, {
        model: "gpt-4",
        stream: false,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "Scripted turn" },
          { role: "user", content: "hello" },
        ],
      });
      expect(behind.status).toBe(200);
      expect(behind.data).toContain("Scripted turn");

      // The one-shot was NOT served above, so it must still be pending: at
      // assistantCount = 0 the exact-turn tie is broken by registration order
      // and the front-inserted one-shot wins.
      const next = await post(mock.url, chatBody("hello", false));
      expect(next.status).toBe(503);
      expect(JSON.parse(next.data).error.message).toBe("Overloaded");

      // …and it is gone once served.
      const after = await post(mock.url, chatBody("hello", false));
      expect(after.status).toBe(200);
    });
  });
});

describe("LLMock — journal reports the truth (F4)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      try {
        await mock.stop();
      } catch {
        // already stopped
      }
      mock = null;
    }
  });

  function rawRequest(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
      let buf = "";
      socket.on("data", (d) => (buf += d));
      socket.on("end", () => resolve(buf));
      socket.on("error", reject);
    });
  }

  it("clearRequests() empties the journal but keeps fixture match-counts", async () => {
    mock = new LLMock();
    const fixture = { match: { userMessage: "hi" }, response: { content: "Hello" } };
    mock.addFixture(fixture);
    await mock.start();

    await post(mock.url, chatBody("hi"));
    expect(mock.journal.size).toBe(1);
    expect(mock.journal.getFixtureMatchCount(fixture)).toBe(1);

    mock.clearRequests();
    expect(mock.journal.size).toBe(0);
    // Pre-fix: clearRequests() called journal.clear(), rewinding this to 0.
    expect(mock.journal.getFixtureMatchCount(fixture)).toBe(1);
  });

  it("GET /__aimock/journal?testId= matches the id the request was actually scoped under (repeated header)", async () => {
    mock = new LLMock();
    mock.onMessage("hi", { content: "Hello" });
    const url = await mock.start();
    const port = Number(new URL(url).port);

    // http.request() cannot send a duplicated header; write the wire bytes.
    const dupHeaders = `X-Test-Id: a\r\nX-Test-Id: a\r\n`;
    const chaos = JSON.stringify({ latencyMs: 1 });
    const installed = await rawRequest(
      port,
      `POST /__aimock/chaos HTTP/1.1\r\nHost: x\r\n${dupHeaders}` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(chaos)}\r\n` +
        `Connection: close\r\n\r\n${chaos}`,
    );
    expect(installed.startsWith("HTTP/1.1 200")).toBe(true);
    // Node folds the repeated header to "a, a"; that is the scope the override
    // landed under — visible to a caller that sends the folded string, and NOT
    // to one that sends the bare "a".
    const seenFolded = await fetch(`${url}/__aimock/chaos`, { headers: { "X-Test-Id": "a, a" } });
    expect(((await seenFolded.json()) as { chaos: { latencyMs?: number } }).chaos.latencyMs).toBe(
      1,
    );
    const seenBare = await fetch(`${url}/__aimock/chaos`, { headers: { "X-Test-Id": "a" } });
    expect(
      ((await seenBare.json()) as { chaos: { latencyMs?: number } }).chaos.latencyMs,
    ).toBeUndefined();

    const body = JSON.stringify(chatBody("hi", false));
    const reply = await rawRequest(
      port,
      `POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n${dupHeaders}` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`,
    );
    expect(reply.startsWith("HTTP/1.1 200")).toBe(true);
    expect(mock.getLastRequest()?.headers["x-test-id"]).toBe("a, a");

    // The journal filter agrees with the scope: the folded id finds the chat
    // request (the chaos control calls are not journaled), the bare id does not.
    const folded = await fetch(`${url}/__aimock/journal?testId=${encodeURIComponent("a, a")}`);
    expect(folded.status).toBe(200);
    const foldedEntries = (await folded.json()) as { path: string }[];
    expect(foldedEntries.map((e) => e.path)).toEqual(["/v1/chat/completions"]);
    // Pre-fix: the filter split on "," and reported this request under "a",
    // a scope it was never counted or chaos-evaluated in.
    const bare = await fetch(`${url}/__aimock/journal?testId=a`);
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual([]);
  });

  it("GET /__aimock/journal?testId= finds a request whose single X-Test-Id legitimately contains a comma", async () => {
    mock = new LLMock();
    mock.onMessage("hi", { content: "Hello" });
    const url = await mock.start();

    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "run-7,shard-2" },
      body: JSON.stringify(chatBody("hi", false)),
    });
    expect(res.status).toBe(200);

    // Pre-fix: the filter compared "run-7" (first comma token) against the
    // full id and returned [] — a regression for any harness with commas in ids.
    const found = await fetch(
      `${url}/__aimock/journal?testId=${encodeURIComponent("run-7,shard-2")}`,
    );
    expect(found.status).toBe(200);
    expect(((await found.json()) as unknown[]).length).toBe(1);
    const prefix = await fetch(`${url}/__aimock/journal?testId=run-7`);
    expect(await prefix.json()).toEqual([]);
  });

  it("the 'Fixture matched' debug line names a predicate fixture instead of printing {}", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      mock = new LLMock({ logLevel: "debug" });
      mock.addFixture({
        match: { predicate: (req) => /pred/.test(String(req.messages.at(-1)?.content)) },
        response: { content: "P" },
      });
      await mock.start();
      await post(mock.url, chatBody("hello pred", false));
    } finally {
      spy.mockRestore();
    }
    const matched = lines.find((l) => l.includes("Fixture matched"));
    expect(matched).toBeDefined();
    // Pre-fix: JSON.stringify drops the function → "Fixture matched: {}".
    expect(matched).not.toContain("Fixture matched: {}");
    expect(matched).toContain("[predicate]");
  });
});

describe("LLMock — one-shot error is claimed at SELECTION, exactly once (G5/G8)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("G5: an OpenRouter models[] fallback request serves the one-shot instead of burning it", async () => {
    mock = new LLMock();
    mock.onMessage("route", { content: "plain ok" });
    await mock.start();
    mock.nextRequestError(503, { message: "Injected", type: "server_error" });

    // Pre-fix: the primary candidate resolved the one-shot (consuming it via
    // its factory), fell through to the fallback candidate and served a 200 —
    // the injected error was never served, and the next request was 200 too.
    const fallback = await postTo(mock.url, "/api/v1/chat/completions", {
      model: "primary/bad",
      models: ["primary/bad", "fallback/good"],
      messages: [{ role: "user", content: "route" }],
    });
    expect(fallback.status).toBe(503);
    expect(JSON.parse(fallback.data).error.message).toBe("Injected");

    const next = await post(mock.url, chatBody("route", false));
    expect(next.status).toBe(200);
  });

  it("G8: two concurrent requests under chaos latency — exactly one receives the one-shot", async () => {
    mock = new LLMock({ chaos: { latencyMs: 300 } });
    mock.onMessage("route", { content: "plain ok" });
    await mock.start();
    mock.nextRequestError(503, { message: "Injected", type: "server_error" });

    // Pre-fix: both requests selected the one-shot before the latency await
    // and both factories returned the error (the second's splice was a no-op).
    const body = chatBody("route", false);
    const [a, b] = await Promise.all([post(mock.url, body), post(mock.url, body)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 503]);

    const after = await post(mock.url, chatBody("route", false));
    expect(after.status).toBe(200);
  });
});

describe("LLMock — a claimed one-shot error is RELEASED when it is never served (H2/H3)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  /** `post` above cannot send headers, and the chaos gate is header-driven. */
  function chat(url: string, headers: Record<string, string> = {}, signal?: AbortSignal) {
    return fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(chatBody("route", false)),
      signal,
    });
  }

  it("a terminal chaos action does not burn the one-shot — the next clean request gets it", async () => {
    mock = new LLMock();
    mock.onMessage("route", { content: "plain ok" });
    await mock.start();
    mock.nextRequestError(503, { message: "Injected", type: "server_error" });

    // Pre-fix: the one-shot was claimed at SELECTION, then the chaos roll
    // answered the request instead — the injection was consumed unserved and
    // this second request came back 200.
    await chat(mock.url, { "x-aimock-chaos-drop": "1" });
    const next = await chat(mock.url);
    expect(next.status).toBe(503);
    expect((await next.json()).error.message).toBe("Injected");

    // Still exactly one-shot: the release re-arms, it does not duplicate.
    const after = await chat(mock.url);
    expect(after.status).toBe(200);
  });

  it("a client that leaves during the chaos-latency delay does not burn the one-shot", async () => {
    mock = new LLMock();
    mock.onMessage("route", { content: "plain ok" });
    await mock.start();
    mock.nextRequestError(503, { message: "Injected", type: "server_error" });

    const ac = new AbortController();
    const inflight = chat(mock.url, { "x-aimock-chaos-latency": "400" }, ac.signal).catch(
      () => null,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    ac.abort();
    await inflight;
    await new Promise((resolve) => setTimeout(resolve, 400));

    const next = await chat(mock.url);
    expect(next.status).toBe(503);
  });

  it("a queued one-shot reports responseKind 'error', not 'factory', in the fixture listing", async () => {
    mock = new LLMock();
    await mock.start();
    mock.nextRequestError(503);

    const listing = await (await fetch(`${mock.url}/__aimock/fixtures?include=fixtures`)).json();
    expect(listing.fixtures[0].responseKind).toBe("error");
  });
});

describe("LLMock caller fixture count identity", () => {
  it.each(["addFixture", "addFixtures", "prependFixture"] as const)(
    "%s retains one public caller entry through clear and reset",
    async (method) => {
      const fixture = { match: { userMessage: "identity" }, response: { content: "IDENTITY" } };
      const mock = new LLMock({ port: 0, logLevel: "silent" });
      const add = () => {
        if (method === "addFixtures") mock.addFixtures([fixture]);
        else mock[method](fixture);
      };
      add();
      await mock.start();
      try {
        const journal = mock.journal;
        const response = await post(mock.url, chatBody("identity"));
        const counts = journal.fixtureMatchCounts;
        const stored = mock.getFixtures()[0];
        console.log(
          JSON.stringify({
            cell: method,
            response,
            original: counts.get(fixture) ?? 0,
            stored: counts.get(stored),
            hasOriginal: counts.has(fixture),
            size: counts.size,
            callerKeys: [...counts.keys()].map((key) => key === fixture),
            values: [...counts.values()],
          }),
        );
        expect(response.data).toContain("IDENTITY");
        expect(journal.getFixtureMatchCount(fixture)).toBe(1);
        expect(counts.get(fixture)).toBe(1);
        expect(counts.has(fixture)).toBe(true);
        expect(counts.get(stored)).toBe(1);
        expect(counts.has(stored)).toBe(true);
        expect(counts.size).toBe(1);
        expect([...counts.keys()][0]).toBe(fixture);
        expect([...counts.values()]).toEqual([1]);
        expect([...counts.entries()]).toEqual([[fixture, 1]]);
        expect([...counts]).toEqual([[fixture, 1]]);
        counts.forEach((value, key, map) => {
          expect(value).toBe(1);
          expect(key).toBe(fixture);
          expect(map).toBe(counts);
        });
        expect(mock.journal).toBe(journal);
        expect(journal.fixtureMatchCounts).toBe(counts);
        counts.set(stored, 3);
        expect(counts.get(fixture)).toBe(3);
        expect(counts.size).toBe(1);
        expect(counts.delete(stored)).toBe(true);
        expect(counts.has(fixture)).toBe(false);
        counts.set(fixture, 1);
        const tenant = await fetch(`${mock.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-test-id": "identity-tenant" },
          body: JSON.stringify(chatBody("identity", false)),
        });
        expect(await tenant.text()).toContain("IDENTITY");
        expect(journal.getFixtureMatchCount(fixture, "identity-tenant")).toBe(1);
        const tenantCounts = journal.getFixtureMatchCountsForTest("identity-tenant");
        expect(tenantCounts.get(fixture)).toBe(1);
        expect([...tenantCounts.keys()][0]).toBe(fixture);
        expect(tenantCounts.size).toBe(1);
        expect(journal.getFixtureMatchCountsForTest("untouched").size).toBe(0);
        expect(journal.getFixtureMatchCountsForTest("untouched")).not.toBe(
          journal.getFixtureMatchCountsForTest("untouched"),
        );
        mock.clearRequests();
        expect(journal.size).toBe(0);
        expect(journal.fixtureMatchCounts).toBe(counts);
        expect(journal.getFixtureMatchCount(fixture)).toBe(1);
        mock.reset();
        add();
        expect(journal.getFixtureMatchCount(fixture)).toBe(0);
        expect(journal.getFixtureMatchCount(fixture, "identity-tenant")).toBe(0);
        expect((await post(mock.url, chatBody("identity"))).data).toContain("IDENTITY");
        expect(journal.getFixtureMatchCount(fixture)).toBe(1);
      } finally {
        await mock.stop();
      }
    },
  );

  it("counts repeated matched identity once without adding a sequence turn", async () => {
    const fixture = {
      match: { userMessage: "repeat", sequenceIndex: 0 },
      response: { content: "ONCE" },
    };
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixtures([fixture, fixture]);
    await mock.start();
    try {
      expect((await post(mock.url, chatBody("repeat"))).data).toContain("ONCE");
      const counts = mock.journal.fixtureMatchCounts;
      console.log(
        JSON.stringify({
          cell: "repeated matched",
          original: counts.get(fixture) ?? 0,
          size: counts.size,
          values: [...counts.values()],
        }),
      );
      expect(counts.get(fixture)).toBe(1);
      expect(counts.size).toBe(1);
      expect([...counts.keys()][0]).toBe(fixture);
      for (const stored of mock.getFixtures()) expect(counts.get(stored)).toBe(1);
      expect((await post(mock.url, chatBody("repeat"))).status).toBe(404);
    } finally {
      await mock.stop();
    }
  });

  it("preserves duplicate other-sibling increments from the original sequence loop", async () => {
    const first = {
      match: { userMessage: "siblings", sequenceIndex: 0 },
      response: { content: "FIRST" },
    };
    const second = {
      match: { userMessage: "siblings", sequenceIndex: 1 },
      response: { content: "SECOND" },
    };
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixtures([first, second, second]);
    await mock.start();
    try {
      expect((await post(mock.url, chatBody("siblings"))).data).toContain("FIRST");
      const counts = mock.journal.fixtureMatchCounts;
      console.log(
        JSON.stringify({
          cell: "duplicate sibling",
          first: counts.get(first) ?? 0,
          second: counts.get(second) ?? 0,
          size: counts.size,
          values: [...counts.values()],
        }),
      );
      expect(counts.get(first)).toBe(1);
      expect(counts.get(second)).toBe(2);
      expect(counts.size).toBe(2);
      expect([...counts.keys()][0]).toBe(first);
      expect([...counts.keys()][1]).toBe(second);
      expect((await post(mock.url, chatBody("siblings"))).status).toBe(404);
    } finally {
      await mock.stop();
    }
  });

  it("keeps a shared caller's counts separate across instances", async () => {
    const fixture = { match: { userMessage: "shared" }, response: { content: "SHARED" } };
    const left = new LLMock({ port: 0, logLevel: "silent" }).addFixture(fixture);
    const right = new LLMock({ port: 0, logLevel: "silent" }).addFixture(fixture);
    await left.start();
    await right.start();
    try {
      expect((await post(left.url, chatBody("shared"))).data).toContain("SHARED");
      expect(left.journal.getFixtureMatchCount(fixture)).toBe(1);
      expect(right.journal.getFixtureMatchCount(fixture)).toBe(0);
      expect((await post(right.url, chatBody("shared"))).data).toContain("SHARED");
      expect(left.journal.getFixtureMatchCount(fixture)).toBe(1);
      expect(right.journal.getFixtureMatchCount(fixture)).toBe(1);
    } finally {
      await left.stop();
      await right.stop();
    }
  });
});

/**
 * #518 R4 — without enableMisbehavior, every identity API names the fixture
 * object the caller passed in, as 1.44.0 did: getFixtures(), findByFixture,
 * getFixtureMatchCount, the count-map keys and JournalEntry.response.fixture.
 * Expected values are what published 1.44.0 returns for the same calls.
 */
describe("the caller's fixture objects are the identity, with misbehavior off or on (1.44.0)", () => {
  const literal = (): Fixture[] => [
    { match: { userMessage: "a" }, response: { content: "A" } },
    { match: { userMessage: "s", sequenceIndex: 0 }, response: { content: "S0" } },
    { match: { userMessage: "s", sequenceIndex: 1 }, response: { content: "S1" } },
  ];
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const fixtureFile = (): string => {
    tmp = makeTmpDir();
    const file = join(tmp, "fx.json");
    writeFileSync(file, JSON.stringify({ fixtures: literal() }));
    return file;
  };

  /** Five requests (two under test id t1), then every identity API against `caller`. */
  async function expectCallerIdentity(url: string, journal: Journal, caller: readonly Fixture[]) {
    const send = (message: string, testId?: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(testId && { "x-test-id": testId }) },
        body: JSON.stringify(chatBody(message, false)),
      }).then((r) => r.status);
    expect([await send("a"), await send("s"), await send("s"), await send("a", "t1")]).toEqual([
      200, 200, 200, 200,
    ]);
    expect(await send("s", "t1")).toBe(200);
    expect(caller.map((f) => journal.getFixtureMatchCount(f))).toEqual([1, 2, 2]);
    expect(caller.map((f) => journal.getFixtureMatchCount(f, "t1"))).toEqual([1, 1, 1]);
    expect(caller.map((f) => journal.findByFixture(f).length)).toEqual([2, 2, 1]);
    expect([...journal.fixtureMatchCounts.keys()]).toEqual([...caller]);
    expect([...journal.getFixtureMatchCountsForTest("t1").keys()]).toEqual([...caller]);
    const refs = journal.getAll().map((e) => caller.indexOf(e.response.fixture as Fixture));
    expect(refs).toEqual([0, 1, 2, 0, 1]);
    // toEqual compares structure; the identity checks above are what fail on a copy.
    for (const key of journal.fixtureMatchCounts.keys()) expect(caller).toContain(key);
  }

  it.each([
    ["addFixture", (m: LLMock, c: Fixture[]) => c.forEach((f) => m.addFixture(f))],
    ["addFixtures", (m: LLMock, c: Fixture[]) => m.addFixtures(c)],
    [
      "prependFixture",
      (m: LLMock, c: Fixture[]) => [...c].reverse().forEach((f) => m.prependFixture(f)),
    ],
  ] as const)("LLMock.%s", async (_label, add) => {
    const caller = literal();
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    add(mock, caller);
    await mock.start();
    try {
      mock.getFixtures().forEach((f, i) => expect(f).toBe(caller[i]));
      await expectCallerIdentity(mock.url, mock.journal, caller);
    } finally {
      await mock.stop();
    }
  });

  it("LLMock.addFixtures(loadFixtureFile())", async () => {
    const caller = loadFixtureFile(fixtureFile());
    const mock = new LLMock({ port: 0, logLevel: "silent" }).addFixtures(caller);
    await mock.start();
    try {
      mock.getFixtures().forEach((f, i) => expect(f).toBe(caller[i]));
      await expectCallerIdentity(mock.url, mock.journal, caller);
    } finally {
      await mock.stop();
    }
  });

  it.each(["on()", "loadFixtureFile"] as const)("LLMock %s: getFixtures() objects", async (via) => {
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    if (via === "on()") for (const f of literal()) mock.on(f.match, f.response);
    else mock.loadFixtureFile(fixtureFile());
    await mock.start();
    try {
      await expectCallerIdentity(mock.url, mock.journal, [...mock.getFixtures()]);
    } finally {
      await mock.stop();
    }
  });

  it.each([
    ["a literal array", literal],
    ["loadFixtureFile output", () => loadFixtureFile(fixtureFile())],
  ] as const)("createServer with %s", async (_label, make) => {
    const caller = make();
    const s = await createServer(caller, { port: 0, logLevel: "silent" });
    try {
      await expectCallerIdentity(s.url, s.journal, caller);
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });

  // With misbehavior enabled LLMock stores a copy per addition (each its own
  // fault source), and the journal names the caller's object behind it.
  it.each([
    ["addFixture", (m: LLMock, c: Fixture[]) => c.forEach((f) => m.addFixture(f))],
    ["addFixtures", (m: LLMock, c: Fixture[]) => m.addFixtures(c)],
    [
      "prependFixture",
      (m: LLMock, c: Fixture[]) => [...c].reverse().forEach((f) => m.prependFixture(f)),
    ],
    ["addFixtures(loadFixtureFile())", (m: LLMock, c: Fixture[]) => m.addFixtures(c)],
  ] as const)("enableMisbehavior, LLMock.%s", async (label, add) => {
    const caller = label.includes("loadFixtureFile") ? loadFixtureFile(fixtureFile()) : literal();
    const mock = new LLMock({ port: 0, logLevel: "silent", enableMisbehavior: true });
    add(mock, caller);
    await mock.start();
    try {
      await expectCallerIdentity(mock.url, mock.journal, caller);
      // The stored copies resolve to the same caller fixtures.
      const stored = mock.getFixtures();
      expect(stored.map((f) => mock.journal.getFixtureMatchCount(f))).toEqual([1, 2, 2]);
      expect(stored.map((f) => mock.journal.findByFixture(f).length)).toEqual([2, 2, 1]);
    } finally {
      await mock.stop();
    }
  });

  it("enableMisbehavior, LLMock on(): getFixtures() objects", async () => {
    const mock = new LLMock({ port: 0, logLevel: "silent", enableMisbehavior: true });
    for (const f of literal()) mock.on(f.match, f.response);
    await mock.start();
    try {
      await expectCallerIdentity(mock.url, mock.journal, [...mock.getFixtures()]);
    } finally {
      await mock.stop();
    }
  });

  it.each([false, true])(
    "an object added twice is one caller fixture (1.44.0), enableMisbehavior=%s",
    async (enableMisbehavior) => {
      const fixture: Fixture = {
        match: { userMessage: "twice" },
        response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
        ...(enableMisbehavior && {
          misbehavior: { faults: [{ fault: "tool-args-invalid-json", rate: 0 }] },
        }),
      };
      const mock = new LLMock({ port: 0, logLevel: "silent", enableMisbehavior });
      mock.addFixture(fixture).addFixture(fixture);
      await mock.start();
      try {
        expect((await post(mock.url, chatBody("twice", false))).status).toBe(200);
        expect((await post(mock.url, chatBody("twice", false))).status).toBe(200);
        // 1.44.0 stored the object twice; the first slot matched both requests.
        const journal = mock.journal;
        expect(journal.getFixtureMatchCount(fixture)).toBe(2);
        expect(journal.findByFixture(fixture)).toHaveLength(2);
        expect([...journal.fixtureMatchCounts.keys()]).toEqual([fixture]);
        expect(journal.getAll().map((e) => e.response.fixture)).toEqual([fixture, fixture]);
        for (const e of journal.getAll()) expect(e.response.fixture).toBe(fixture);
        const [first, second] = mock.getFixtures();
        if (!enableMisbehavior) {
          expect(first).toBe(fixture);
          expect(second).toBe(fixture);
          return;
        }
        // Each addition stays its own fault source.
        expect(first).not.toBe(second);
        expect(getFixtureMisbehaviorPosition(first)).toBe("code#0");
        expect(getFixtureMisbehaviorPosition(second)).toBe("code#1");
        const config: MisbehaviorConfig = {
          faults: [{ fault: "tool-args-invalid-json", rate: 0 }],
        };
        expect(first.misbehavior).toEqual(config);
        expect(fixtureMisbehaviorSourceKey(first, config)).not.toBe(
          fixtureMisbehaviorSourceKey(second, config),
        );
        for (const stored of [first, second]) {
          expect(journal.getFixtureMatchCount(stored)).toBe(2);
          expect(journal.findByFixture(stored)).toHaveLength(2);
        }
      } finally {
        await mock.stop();
      }
    },
  );

  it("the journal JSON shows the copy each request was served from", async () => {
    const fixture: Fixture = {
      match: { userMessage: "json" },
      response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
      misbehavior: { faults: [{ fault: "tool-args-invalid-json", rate: 0 }] },
    };
    const mock = new LLMock({ port: 0, logLevel: "silent", enableMisbehavior: true });
    mock.addFixture(fixture);
    await mock.start();
    try {
      await post(mock.url, chatBody("json", false));
      const served = mock.getFixtures()[0];
      const body = (await (await fetch(`${mock.url}/__aimock/journal`)).json()) as {
        response: { fixture: unknown };
      }[];
      expect(body[0].response.fixture).toEqual(JSON.parse(JSON.stringify(served)));
      expect(mock.journal.getAll()[0].response.fixture).toBe(fixture);
    } finally {
      await mock.stop();
    }
  });
});
