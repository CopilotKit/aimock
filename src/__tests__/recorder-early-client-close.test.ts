import { describe, it, expect } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FixtureFile } from "../types.js";
import { proxyAndRecord } from "../recorder.js";
import { Logger } from "../logger.js";

// ===========================================================================
// Regression: record mode must persist the fixture when the client closes its
// socket immediately after consuming `data: [DONE]`, before upstream has fired
// `res.end`. Some SDKs (notably the OpenAI Python SDK) close the response the
// instant they read `[DONE]`; if the recorder destroyed the upstream request
// and discarded buffered chunks on that client-close signal, record mode would
// silently produce NO fixture even though the full response body was received.
//
// This exercises the REAL recorder path (proxyAndRecord -> collapse ->
// persistFixture) against a live upstream and a real client that disconnects
// on `[DONE]` — not a stub of the recorder.
// ===========================================================================
describe("recorder — early client socket close after [DONE]", () => {
  it("persists the full fixture when the client closes right after data: [DONE], before upstream end", async () => {
    // Upstream streams a complete OpenAI chat-completions SSE turn ending with
    // `data: [DONE]`, then holds the connection open briefly before calling
    // `res.end()`. This reproduces the real race: the client sees `[DONE]` and
    // closes its socket while upstream has NOT yet emitted `end`.
    const UPSTREAM_END_DELAY_MS = 150;
    const upstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
      );
      upRes.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`);
      upRes.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      upRes.write("data: [DONE]\n\n");
      // Deliberately defer `end` so it fires AFTER the client has closed.
      setTimeout(() => {
        if (!upRes.writableEnded) upRes.end();
      }, UPSTREAM_END_DELAY_MS);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-early-close-"));
    const logger = new Logger("silent");

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
            record: { providers: { openai: `http://127.0.0.1:${upstreamPort}` }, fixturePath },
            logger,
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      // Client that closes its socket the instant it observes `data: [DONE]`,
      // mimicking the OpenAI Python SDK's behavior.
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: recorderPort,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            let seen = "";
            res.on("data", (c: Buffer) => {
              seen += c.toString();
              if (seen.includes("data: [DONE]")) {
                // Close immediately, before upstream has fired `end`.
                req.destroy();
                resolve();
              }
            });
            res.on("error", () => resolve());
            res.on("end", () => resolve());
          },
        );
        req.on("error", () => resolve());
        req.end(
          JSON.stringify({
            model: "gpt-4",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        );
      });

      // Allow upstream `end` to fire and the recorder to persist the fixture.
      await new Promise<void>((resolve) => setTimeout(resolve, UPSTREAM_END_DELAY_MS + 150));

      // The completed response must be recorded despite the early client close.
      const all = fs.existsSync(fixturePath) ? fs.readdirSync(fixturePath) : [];
      const jsons = all.filter((f) => f.endsWith(".json"));
      const tmps = all.filter((f) => f.includes(".tmp."));
      expect(jsons).toHaveLength(1);
      expect(tmps).toHaveLength(0);

      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturePath, jsons[0]), "utf-8"),
      ) as FixtureFile;
      const saved = fixture.fixtures[0].response as { content?: string };
      // The full streamed content must be captured, not a truncated fragment.
      expect(saved.content).toBe("Hello world");
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});
