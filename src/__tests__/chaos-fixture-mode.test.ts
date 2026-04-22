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
  it("pre-flight chaos short-circuits even when fixture would match", async () => {
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
});
