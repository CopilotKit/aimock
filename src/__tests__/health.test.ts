import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// --- helpers ---

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

// --- tests ---

describe("health endpoints", () => {
  let instance: ServerInstance | undefined;

  afterEach(async () => {
    if (instance) {
      await new Promise<void>((resolve, reject) =>
        instance!.server.close((err) => (err ? reject(err) : resolve())),
      );
      instance = undefined;
    }
  });

  describe("GET /health", () => {
    it("returns 200 with status ok", async () => {
      instance = await createServer([]);
      const res = await get(`${instance.url}/health`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ status: "ok" });
    });

    it("sets CORS headers", async () => {
      instance = await createServer([]);
      const res = await get(`${instance.url}/health`);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  describe("GET /ready", () => {
    it("returns 200 with status ready", async () => {
      instance = await createServer([]);
      const res = await get(`${instance.url}/ready`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ status: "ready" });
    });

    it("sets CORS headers", async () => {
      instance = await createServer([]);
      const res = await get(`${instance.url}/ready`);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  describe("GET /v1/models", () => {
    it("returns default models when no fixtures have model specified", async () => {
      instance = await createServer([]);
      const res = await get(`${instance.url}/v1/models`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.object).toBe("list");
      expect(body.data).toBeInstanceOf(Array);
      const ids = body.data.map((m: { id: string }) => m.id);
      expect(ids).toContain("gpt-4");
      expect(ids).toContain("gpt-4o");
      expect(ids).toContain("claude-3-5-sonnet-20241022");
      expect(ids).toContain("gemini-2.0-flash");
      expect(ids).toContain("text-embedding-3-small");
      for (const model of body.data) {
        expect(model.object).toBe("model");
        expect(model.owned_by).toBe("llmock");
        expect(typeof model.created).toBe("number");
      }
    });

    it("returns models from fixture match criteria", async () => {
      const fixtures: Fixture[] = [
        {
          match: { model: "gpt-4-turbo" },
          response: { content: "hello" },
        },
        {
          match: { model: "claude-3-opus" },
          response: { content: "world" },
        },
      ];
      instance = await createServer(fixtures);
      const res = await get(`${instance.url}/v1/models`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      const ids = body.data.map((m: { id: string }) => m.id);
      expect(ids).toContain("gpt-4-turbo");
      expect(ids).toContain("claude-3-opus");
      expect(ids).toHaveLength(2);
    });

    it("deduplicates models from fixtures", async () => {
      const fixtures: Fixture[] = [
        {
          match: { model: "gpt-4" },
          response: { content: "a" },
        },
        {
          match: { model: "gpt-4" },
          response: { content: "b" },
        },
      ];
      instance = await createServer(fixtures);
      const res = await get(`${instance.url}/v1/models`);
      const body = JSON.parse(res.body);
      const ids = body.data.map((m: { id: string }) => m.id);
      expect(ids.filter((id: string) => id === "gpt-4")).toHaveLength(1);
    });

    it("skips RegExp model matchers", async () => {
      const fixtures: Fixture[] = [
        {
          match: { model: /gpt-.*/ },
          response: { content: "a" },
        },
        {
          match: { model: "claude-3-opus" },
          response: { content: "b" },
        },
      ];
      instance = await createServer(fixtures);
      const res = await get(`${instance.url}/v1/models`);
      const body = JSON.parse(res.body);
      const ids = body.data.map((m: { id: string }) => m.id);
      expect(ids).toContain("claude-3-opus");
      expect(ids).toHaveLength(1);
    });

    it("falls back to defaults when all fixtures use RegExp models", async () => {
      const fixtures: Fixture[] = [
        {
          match: { model: /gpt-.*/ },
          response: { content: "a" },
        },
      ];
      instance = await createServer(fixtures);
      const res = await get(`${instance.url}/v1/models`);
      const body = JSON.parse(res.body);
      const ids = body.data.map((m: { id: string }) => m.id);
      expect(ids).toContain("gpt-4");
      expect(ids).toContain("gpt-4o");
    });

    it("sets CORS headers", async () => {
      instance = await createServer([]);
      const res = await get(`${instance.url}/v1/models`);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });
});
