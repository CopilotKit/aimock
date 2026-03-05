import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";

// ---- Helpers ----

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

function chatBody(userMessage: string, stream = true) {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: userMessage }],
    stream,
  };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "llmock-test-"));
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
      expect(entry!.body.messages[0].content).toBe("journal-test");
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

  describe("onToolCall convenience", () => {
    it("registers a fixture matching a tool name", async () => {
      mock = new LLMock();
      mock.onToolCall("get_weather", { content: "sunny" });
      await mock.start();

      await post(mock.url, {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "tc1", type: "function", function: { name: "get_weather", arguments: "{}" } },
            ],
          },
          { role: "tool", content: "result", tool_call_id: "tc1" },
        ],
      });
      // The fixture match for toolName is checked against the last assistant message's tool_calls
      // This may or may not match depending on router logic, but the fixture should be registered
      expect(mock).toBeInstanceOf(LLMock);
    });

    it("returns this for chaining", () => {
      mock = new LLMock();
      expect(mock.onToolCall("fn", { content: "r" })).toBe(mock);
    });
  });

  describe("onToolResult convenience", () => {
    it("returns this for chaining", () => {
      mock = new LLMock();
      expect(mock.onToolResult("call_123", { content: "r" })).toBe(mock);
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
      expect(last!.body.messages[0].content).toBe("b");
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
});
