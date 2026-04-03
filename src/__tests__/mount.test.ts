import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";
import type { Mountable } from "../types.js";

// ---- Helpers ----

function get(url: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function post(url: string, path: string, body: object): Promise<{ status: number; data: string }> {
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
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, data }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---- Test Mountable implementations ----

class TestMount implements Mountable {
  requests: Array<{ pathname: string }> = [];
  journal: Journal | null = null;

  async handleRequest(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    this.requests.push({ pathname });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ mounted: true, pathname }));
    return true;
  }

  health() {
    return { status: "ok", requests: this.requests.length };
  }

  setJournal(j: Journal) {
    this.journal = j;
  }
}

class PassThroughMount implements Mountable {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    return false;
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
}

class NoHealthMount implements Mountable {
  async handleRequest(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ mounted: true, pathname }));
    return true;
  }
}

class BaseUrlMount implements Mountable {
  baseUrl: string | null = null;

  async handleRequest(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ mounted: true, pathname }));
    return true;
  }

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }
}

// ---- Tests ----

describe("Mountable interface", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      try {
        await mock.stop();
      } catch (err) {
        if (!(err instanceof Error && err.message === "Server not started")) {
          throw err;
        }
      }
      mock = null;
    }
  });

  describe("mount dispatch", () => {
    it("routes /test/foo to handler with /foo", async () => {
      const mount = new TestMount();
      mock = new LLMock();
      mock.mount("/test", mount);
      await mock.start();

      const res = await get(mock.url, "/test/foo");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ mounted: true, pathname: "/foo" });
      expect(mount.requests).toHaveLength(1);
      expect(mount.requests[0].pathname).toBe("/foo");
    });

    it("routes /test to handler with /", async () => {
      const mount = new TestMount();
      mock = new LLMock();
      mock.mount("/test", mount);
      await mock.start();

      const res = await get(mock.url, "/test");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ mounted: true, pathname: "/" });
      expect(mount.requests[0].pathname).toBe("/");
    });

    it("falls through to LLMock when handler returns false", async () => {
      const mount = new PassThroughMount();
      mock = new LLMock();
      mock.mount("/v1/chat", mount);
      mock.onMessage("hello", { content: "fixture response" });
      await mock.start();

      const res = await post(mock.url, "/v1/chat/completions", {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.data);
      expect(body.choices[0].message.content).toBe("fixture response");
    });

    it("does not intercept non-mount paths", async () => {
      const mount = new TestMount();
      mock = new LLMock();
      mock.mount("/test", mount);
      mock.onMessage("hello", { content: "normal response" });
      await mock.start();

      const res = await post(mock.url, "/v1/chat/completions", {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.data);
      expect(body.choices[0].message.content).toBe("normal response");
      expect(mount.requests).toHaveLength(0);
    });

    it("routes to correct mount with two mounts at /a and /b", async () => {
      const mountA = new TestMount();
      const mountB = new TestMount();
      mock = new LLMock();
      mock.mount("/a", mountA);
      mock.mount("/b", mountB);
      await mock.start();

      await get(mock.url, "/a/foo");
      await get(mock.url, "/b/bar");

      expect(mountA.requests).toHaveLength(1);
      expect(mountA.requests[0].pathname).toBe("/foo");
      expect(mountB.requests).toHaveLength(1);
      expect(mountB.requests[0].pathname).toBe("/bar");
    });

    it("does not match paths that share a prefix but not a segment boundary", async () => {
      const mount = new TestMount();
      mock = new LLMock();
      mock.mount("/app", mount);
      await mock.start();

      // /application should NOT be intercepted by mount at /app
      const res = await get(mock.url, "/application");
      expect(res.status).toBe(404);
      expect(mount.requests).toHaveLength(0);

      // But /app/foo should be intercepted
      const res2 = await get(mock.url, "/app/foo");
      expect(res2.status).toBe(200);
      expect(mount.requests).toHaveLength(1);
    });

    it("mount added after start() works immediately", async () => {
      const mount = new TestMount();
      mock = new LLMock();
      await mock.start();

      // Mount after server is already running
      mock.mount("/late", mount);

      const res = await get(mock.url, "/late/endpoint");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ mounted: true, pathname: "/endpoint" });
    });
  });

  describe("unified health", () => {
    it("returns services with llm and mounted service health", async () => {
      const mount = new TestMount();
      mock = new LLMock();
      mock.mount("/test", mount);
      mock.onMessage("x", { content: "y" });
      await mock.start();

      const res = await get(mock.url, "/health");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        status: "ok",
        services: {
          llm: { status: "ok", fixtures: 1 },
          test: { status: "ok", requests: 0 },
        },
      });
    });

    it("mount without health() is not in health response", async () => {
      const mount = new NoHealthMount();
      mock = new LLMock();
      mock.mount("/noh", mount);
      await mock.start();

      const res = await get(mock.url, "/health");
      const body = JSON.parse(res.body);
      expect(body.services).toBeDefined();
      expect(body.services.noh).toBeUndefined();
      expect(body.services.llm).toBeDefined();
    });
  });

  describe("shared journal", () => {
    it("setJournal is called with the shared journal", async () => {
      const mount = new TestMount();
      mock = new LLMock();
      mock.mount("/test", mount);
      await mock.start();

      expect(mount.journal).toBeInstanceOf(Journal);
      expect(mount.journal).toBe(mock.journal);
    });

    it("journal entry can include service field", async () => {
      // Create a mount that writes a journal entry with service field
      const serviceMount: Mountable = {
        journal: null as Journal | null,
        /* eslint-disable @typescript-eslint/no-unused-vars */
        async handleRequest(
          req: http.IncomingMessage,
          res: http.ServerResponse,
          pathname: string,
        ): Promise<boolean> {
          /* eslint-enable @typescript-eslint/no-unused-vars */
          if (this.journal) {
            this.journal.add({
              method: "GET",
              path: "/svc/test",
              headers: {},
              body: null,
              service: "my-service",
              response: { status: 200, fixture: null },
            });
          }
          res.writeHead(200);
          res.end("ok");
          return true;
        },
        setJournal(j: Journal) {
          this.journal = j;
        },
      };

      mock = new LLMock();
      mock.mount("/svc", serviceMount);
      await mock.start();

      await get(mock.url, "/svc/test");

      const entries = mock.getRequests();
      expect(entries).toHaveLength(1);
      expect(entries[0].service).toBe("my-service");
    });
  });

  describe("setBaseUrl", () => {
    it("calls setBaseUrl with the server URL + mount path on start", async () => {
      const mount = new BaseUrlMount();
      mock = new LLMock();
      mock.mount("/svc", mount);
      await mock.start();

      expect(mount.baseUrl).toBe(mock.url + "/svc");
    });

    it("does not call setBaseUrl on mounts that do not implement it", async () => {
      const mount = new TestMount();
      mock = new LLMock();
      mock.mount("/test", mount);
      // Should not throw even though TestMount has no setBaseUrl
      await mock.start();
      expect(mock.url).toBeDefined();
    });
  });

  describe("health without mounts", () => {
    it("returns simple status ok without services key", async () => {
      mock = new LLMock();
      await mock.start();

      const res = await get(mock.url, "/health");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ status: "ok" });
      expect(body.services).toBeUndefined();
    });
  });

  describe("mount() chaining", () => {
    it("returns this for chaining", () => {
      mock = new LLMock();
      const mount = new TestMount();
      const result = mock.mount("/test", mount);
      expect(result).toBe(mock);
    });
  });
});
