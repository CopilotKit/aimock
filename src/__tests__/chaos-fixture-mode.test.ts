import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { createServer, type ServerInstance } from "../server.js";

// minimal helpers duplicated to keep this test isolated
import * as http from "node:http";

function post(url: string, body: unknown): Promise<{ status: number; body: string }> {
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
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

let server: ServerInstance | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.server.close(() => resolve()));
    server = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

const CHAT_REQUEST = {
  model: "gpt-4",
  messages: [{ role: "user", content: "What is the capital of France?" }],
};

describe("chaos (fixture mode)", () => {
  it("chaos short-circuits even when fixture would match", async () => {
    const fixture = {
      match: { userMessage: "capital of France" },
      response: { content: "Paris" },
    };

    server = await createServer([fixture], {
      port: 0,
      chaos: { dropRate: 1.0 },
    });

    const resp = await post(`${server.url}/v1/chat/completions`, CHAT_REQUEST);

    expect(resp.status).toBe(500);
    const body = JSON.parse(resp.body);
    expect(body).toMatchObject({ error: { code: "chaos_drop" } });
  });

  it("rolls chaos once per request: drop journals the matched fixture, not null", async () => {
    // Pins the single-roll behavior: chaos evaluation happens AFTER fixture
    // matching, so when drop fires on a request that matches a fixture, the
    // journal entry reflects the match (not null, as the old double-roll
    // pre-flight path would have recorded).
    const fixture = {
      match: { userMessage: "capital of France" },
      response: { content: "Paris" },
    };

    server = await createServer([fixture], {
      port: 0,
      chaos: { dropRate: 1.0 },
    });

    const resp = await post(`${server.url}/v1/chat/completions`, CHAT_REQUEST);
    expect(resp.status).toBe(500);

    const last = server.journal.getLast();
    expect(last?.response.chaosAction).toBe("drop");
    expect(last?.response.fixture).toBe(fixture);
    // Match count reflects that the fixture did participate in the decision
    expect(server.journal.getFixtureMatchCount(fixture)).toBe(1);
  });

  it("disconnect journals the matched fixture with status 0", async () => {
    // Symmetric to the drop test above. Disconnect's status is 0 (no response
    // ever written before res.destroy()) which is a slightly unusual shape;
    // pin it so future refactors don't silently change it to e.g. 500.
    const fixture = {
      match: { userMessage: "capital of France" },
      response: { content: "Paris" },
    };

    server = await createServer([fixture], {
      port: 0,
      chaos: { disconnectRate: 1.0 },
    });

    // Client sees a socket destroy mid-request → post() rejects
    await expect(post(`${server.url}/v1/chat/completions`, CHAT_REQUEST)).rejects.toThrow();

    const last = server.journal.getLast();
    expect(last?.response.chaosAction).toBe("disconnect");
    expect(last?.response.status).toBe(0);
    expect(last?.response.fixture).toBe(fixture);
    expect(server.journal.getFixtureMatchCount(fixture)).toBe(1);
  });
});
