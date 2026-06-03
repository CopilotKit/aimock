import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture, ChatCompletionRequest } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpRequest(
  url: string,
  method: string,
  body?: object,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function httpRaw(
  url: string,
  method: string,
  rawBody: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

function chatRequest(userContent: string): ChatCompletionRequest {
  return {
    model: "gpt-4",
    stream: false,
    messages: [{ role: "user", content: userContent }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/__aimock control API", () => {
  let instance: ServerInstance | undefined;

  afterEach(async () => {
    if (instance) {
      await new Promise<void>((resolve, reject) =>
        instance!.server.close((err) => (err ? reject(err) : resolve())),
      );
      instance = undefined;
    }
  });

  describe("GET /__aimock/health", () => {
    it("returns 200 with status ok", async () => {
      instance = await createServer([]);
      const res = await httpRequest(`${instance.url}/__aimock/health`, "GET");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: "ok" });
    });
  });

  describe("POST /__aimock/fixtures", () => {
    it("adds fixtures and they match requests", async () => {
      const fixtures: Fixture[] = [];
      instance = await createServer(fixtures);

      // Add a fixture via control API
      const addRes = await httpRequest(`${instance.url}/__aimock/fixtures`, "POST", {
        fixtures: [{ match: { userMessage: "hello" }, response: { content: "Hi there!" } }],
      });
      expect(addRes.status).toBe(200);
      expect(JSON.parse(addRes.body)).toEqual({ added: 1 });

      // Verify the fixture works by sending a chat request
      const chatRes = await httpRequest(
        `${instance.url}/v1/chat/completions`,
        "POST",
        chatRequest("hello"),
      );
      expect(chatRes.status).toBe(200);
      const chatBody = JSON.parse(chatRes.body);
      expect(chatBody.choices[0].message.content).toBe("Hi there!");
    });

    it("adds multiple fixtures at once", async () => {
      const fixtures: Fixture[] = [];
      instance = await createServer(fixtures);

      const addRes = await httpRequest(`${instance.url}/__aimock/fixtures`, "POST", {
        fixtures: [
          { match: { userMessage: "a" }, response: { content: "A" } },
          { match: { userMessage: "b" }, response: { content: "B" } },
        ],
      });
      expect(addRes.status).toBe(200);
      expect(JSON.parse(addRes.body)).toEqual({ added: 2 });
    });

    it("returns 400 for invalid JSON", async () => {
      instance = await createServer([]);
      const res = await httpRaw(`${instance.url}/__aimock/fixtures`, "POST", "not json{{{");
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/^Invalid JSON:/);
    });

    it("returns 400 when fixtures array is missing", async () => {
      instance = await createServer([]);
      const res = await httpRequest(`${instance.url}/__aimock/fixtures`, "POST", {
        notFixtures: [],
      });
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("fixtures");
    });

    it("returns 400 with details for validation errors", async () => {
      instance = await createServer([]);
      // A fixture with no recognized response type triggers a validation error
      const res = await httpRequest(`${instance.url}/__aimock/fixtures`, "POST", {
        fixtures: [{ match: { userMessage: "x" }, response: {} }],
      });
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Validation failed");
      expect(body.details).toBeInstanceOf(Array);
      expect(body.details.length).toBeGreaterThan(0);
      expect(body.details[0].severity).toBe("error");
    });
  });

  describe("DELETE /__aimock/fixtures", () => {
    it("clears all fixtures", async () => {
      const fixtures: Fixture[] = [
        { match: { userMessage: "hello" }, response: { content: "Hi" } },
      ];
      instance = await createServer(fixtures);

      // Verify fixture exists
      expect(fixtures.length).toBe(1);

      const res = await httpRequest(`${instance.url}/__aimock/fixtures`, "DELETE");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ cleared: true });
      expect(fixtures.length).toBe(0);
    });
  });

  describe("POST /__aimock/reset", () => {
    it("clears fixtures, journal, and match counts", async () => {
      const fixtures: Fixture[] = [
        { match: { userMessage: "hello" }, response: { content: "Hi" } },
      ];
      instance = await createServer(fixtures);

      // Make a request to populate journal
      await httpRequest(`${instance.url}/v1/chat/completions`, "POST", chatRequest("hello"));
      expect(instance.journal.size).toBeGreaterThan(0);

      const res = await httpRequest(`${instance.url}/__aimock/reset`, "POST");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ reset: true });
      expect(fixtures.length).toBe(0);
      expect(instance.journal.size).toBe(0);
    });
  });

  describe("POST /__aimock/reset routes", () => {
    it("POST /__aimock/reset/fixtures clears fixtures and journal", async () => {
      const fixtures: Fixture[] = [
        { match: { userMessage: "hello" }, response: { content: "Hi" } },
      ];
      instance = await createServer(fixtures);

      // Make a request to populate journal
      await httpRequest(`${instance.url}/v1/chat/completions`, "POST", chatRequest("hello"));
      expect(instance.journal.size).toBeGreaterThan(0);

      const res = await httpRequest(`${instance.url}/__aimock/reset/fixtures`, "POST");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ reset: true });
      expect(fixtures.length).toBe(0);
      expect(instance.journal.size).toBe(0);
    });

    it("POST /__aimock/reset/journal clears journal but preserves fixtures", async () => {
      const fixtures: Fixture[] = [
        { match: { userMessage: "hello" }, response: { content: "Hi" } },
      ];
      instance = await createServer(fixtures);

      // Make a request to populate journal
      await httpRequest(`${instance.url}/v1/chat/completions`, "POST", chatRequest("hello"));
      expect(instance.journal.size).toBeGreaterThan(0);

      const before = fixtures.length;
      expect(before).toBeGreaterThan(0);
      const res = await httpRequest(`${instance.url}/__aimock/reset/journal`, "POST");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ reset: true });
      expect(fixtures.length).toBe(before); // fixtures preserved
      expect(instance.journal.size).toBe(0); // journal cleared
    });

    it("POST /__aimock/reset/journal preserves fixture match-counts while clearing entries", async () => {
      const fixtures: Fixture[] = [
        { match: { userMessage: "hello" }, response: { content: "Hi" } },
      ];
      instance = await createServer(fixtures);

      // Make a request so the journal records an entry AND the fixture's
      // match-count is incremented to a non-zero value.
      await httpRequest(`${instance.url}/v1/chat/completions`, "POST", chatRequest("hello"));
      expect(instance.journal.size).toBeGreaterThan(0);
      const countBefore = instance.journal.getFixtureMatchCount(fixtures[0]);
      expect(countBefore).toBeGreaterThan(0);

      // Reset ONLY the journal.
      const res = await httpRequest(`${instance.url}/__aimock/reset/journal`, "POST");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ reset: true });

      // Journal entries cleared, but the fixture match-count must survive —
      // clearing the journal must not rewind sequenced fixtures to index 0.
      expect(instance.journal.size).toBe(0);
      expect(instance.journal.getFixtureMatchCount(fixtures[0])).toBe(countBefore);
    });

    it("POST /__aimock/reset is a deprecated alias that still performs a full reset", async () => {
      const fixtures: Fixture[] = [
        { match: { userMessage: "hello" }, response: { content: "Hi" } },
      ];
      instance = await createServer(fixtures);

      const res = await httpRequest(`${instance.url}/__aimock/reset`, "POST");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ reset: true, deprecated: true });
      expect(typeof body.deprecation).toBe("string");
      expect(fixtures.length).toBe(0);
    });
  });

  describe("GET /__aimock/journal", () => {
    it("returns journal entries", async () => {
      const fixtures: Fixture[] = [
        { match: { userMessage: "hello" }, response: { content: "Hi" } },
      ];
      instance = await createServer(fixtures);

      // Make a request to populate journal
      await httpRequest(`${instance.url}/v1/chat/completions`, "POST", chatRequest("hello"));

      const res = await httpRequest(`${instance.url}/__aimock/journal`, "GET");
      expect(res.status).toBe(200);
      const entries = JSON.parse(res.body);
      expect(entries).toBeInstanceOf(Array);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].method).toBe("POST");
      expect(entries[0].path).toBe("/v1/chat/completions");
    });

    it("returns empty array when no requests made", async () => {
      instance = await createServer([]);
      const res = await httpRequest(`${instance.url}/__aimock/journal`, "GET");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });
  });

  describe("POST /__aimock/error", () => {
    it("queues a one-shot error", async () => {
      const fixtures: Fixture[] = [
        { match: { userMessage: "hello" }, response: { content: "Hi" } },
      ];
      instance = await createServer(fixtures);

      // Queue an error
      const queueRes = await httpRequest(`${instance.url}/__aimock/error`, "POST", {
        status: 429,
        body: { message: "Rate limited", type: "rate_limit_error" },
      });
      expect(queueRes.status).toBe(200);
      expect(JSON.parse(queueRes.body)).toEqual({ queued: true });

      // First request should get the error
      const errRes = await httpRequest(
        `${instance.url}/v1/chat/completions`,
        "POST",
        chatRequest("hello"),
      );
      expect(errRes.status).toBe(429);

      // Second request should succeed normally
      const okRes = await httpRequest(
        `${instance.url}/v1/chat/completions`,
        "POST",
        chatRequest("hello"),
      );
      expect(okRes.status).toBe(200);
      const body = JSON.parse(okRes.body);
      expect(body.choices[0].message.content).toBe("Hi");
    });
  });

  describe("unknown control path", () => {
    it("returns 404 for unknown /__aimock/ paths", async () => {
      instance = await createServer([]);
      const res = await httpRequest(`${instance.url}/__aimock/unknown`, "GET");
      expect(res.status).toBe(404);
    });
  });
});
