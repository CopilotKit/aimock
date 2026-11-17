import { describe, it, expect } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { proxyAndRecord } from "../recorder.js";
import { loadFixturesFromDir } from "../fixture-loader.js";
import { Logger } from "../logger.js";
import type { RecordProviderKey } from "../types.js";

type Json = Record<string, unknown>;

interface Upstream {
  provider: RecordProviderKey;
  pathname: string;
  body: string;
  contentType: string;
}

const sse = (events: Json[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const ndjson = (lines: Json[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");

async function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return server;
}

const urlOf = (server: http.Server) =>
  `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function record({ provider, pathname, body, contentType }: Upstream) {
  const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-empty-turns-"));
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  });
  const recorder = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void proxyAndRecord(
        req,
        res,
        { model: "m", messages: [{ role: "user", content: "Say hi" }] },
        provider,
        pathname,
        [],
        {
          record: { providers: { [provider]: urlOf(upstream) }, fixturePath },
          logger: new Logger("silent"),
        },
        Buffer.concat(chunks).toString(),
      );
    });
  });
  try {
    const relayed = await fetch(`${urlOf(recorder)}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Say hi" }] }),
    });
    expect(relayed.status).toBe(200);
    await relayed.text();
    const fixtures = loadFixturesFromDir(fixturePath);
    expect(fixtures).toHaveLength(1);
    return fixtures[0].response as Json;
  } finally {
    fs.rmSync(fixturePath, { recursive: true, force: true });
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await new Promise<void>((resolve) => recorder.close(() => resolve()));
  }
}

async function expectParity(json: Upstream, stream: Upstream) {
  const fromJson = await record(json);
  const fromStream = await record(stream);
  expect(fromJson).not.toHaveProperty("error");
  expect(fromJson.content).toBe("");
  expect(fromJson).toEqual(fromStream);
  return fromJson;
}

const anthropicUsage = { input_tokens: 5, output_tokens: 0 };
const anthropic = (content: Json[]): Upstream => ({
  provider: "anthropic",
  pathname: "/v1/messages",
  contentType: "application/json",
  body: JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude",
    content,
    stop_reason: "end_turn",
    usage: anthropicUsage,
  }),
});
const anthropicStream = (blocks: Json[]): Upstream => ({
  provider: "anthropic",
  pathname: "/v1/messages",
  contentType: "text/event-stream",
  body: sse([
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", usage: anthropicUsage },
    },
    ...blocks,
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ]),
});

const geminiUsage = { promptTokenCount: 5, totalTokenCount: 5 };
const gemini = (frame: Json, contentType: string): Upstream => ({
  provider: "gemini",
  pathname: "/v1beta/models/gemini-pro:generateContent",
  contentType,
  body:
    contentType === "application/json"
      ? JSON.stringify({ ...frame, usageMetadata: geminiUsage })
      : sse([{ ...frame, usageMetadata: geminiUsage }]),
});

const ollamaReply = {
  model: "llama3",
  message: { role: "assistant", content: "" },
  done: true,
  done_reason: "length",
  prompt_eval_count: 5,
  eval_count: 0,
};
const ollama = (contentType: string): Upstream => ({
  provider: "ollama",
  pathname: "/api/chat",
  contentType,
  body: contentType === "application/json" ? JSON.stringify(ollamaReply) : ndjson([ollamaReply]),
});

describe("recorder: empty non-streamed turns record like their streamed twin", () => {
  it("Anthropic reply with no content blocks", async () => {
    const recorded = await expectParity(anthropic([]), anthropicStream([]));
    expect(recorded.usage).toEqual({ input_tokens: 5, output_tokens: 0 });
  });

  it("Anthropic reply with one empty text block", async () => {
    await expectParity(
      anthropic([{ type: "text", text: "" }]),
      anthropicStream([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_stop", index: 0 },
      ]),
    );
  });

  it("Gemini candidate cut at MAX_TOKENS with no parts", async () => {
    const frame = { candidates: [{ content: { role: "model" }, finishReason: "MAX_TOKENS" }] };
    await expectParity(gemini(frame, "application/json"), gemini(frame, "text/event-stream"));
  });

  it("Gemini candidate blocked for SAFETY with no content", async () => {
    const frame = { candidates: [{ finishReason: "SAFETY", safetyRatings: [] }] };
    await expectParity(gemini(frame, "application/json"), gemini(frame, "text/event-stream"));
  });

  it("Gemini prompt blocked before any candidate", async () => {
    const frame = { promptFeedback: { blockReason: "SAFETY", safetyRatings: [] } };
    await expectParity(gemini(frame, "application/json"), gemini(frame, "text/event-stream"));
  });

  it("Ollama chat reply cut at the length limit with empty content", async () => {
    await expectParity(ollama("application/json"), ollama("application/x-ndjson"));
  });
});
