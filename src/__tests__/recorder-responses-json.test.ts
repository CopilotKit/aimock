import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { proxyAndRecord } from "../recorder.js";
import { createServer } from "../server.js";
import { loadFixturesFromDir } from "../fixture-loader.js";
import { Logger } from "../logger.js";

type Json = Record<string, unknown>;

const message = (text: string): Json => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});
const call: Json = {
  type: "function_call",
  call_id: "call_1",
  name: "get_weather",
  arguments: '{"city":"SF"}',
};
const reasoning: Json = { type: "reasoning", summary: [{ type: "summary_text", text: "Think." }] };

function streamOf(output: Json[]): string {
  const events = output.flatMap((item, output_index): Json[] => {
    if (item.type === "message") {
      const [part] = item.content as Json[];
      return [
        { type: "response.output_item.added", output_index, item: { type: "message" } },
        {
          type: "response.output_text.delta",
          output_index,
          content_index: 0,
          delta: part.text,
        },
      ];
    }
    if (item.type === "reasoning") {
      const [part] = item.summary as Json[];
      return [
        { type: "response.reasoning_summary_text.delta", delta: part.text },
        { type: "response.output_item.done", output_index, item },
      ];
    }
    return [{ type: "response.output_item.done", output_index, item }];
  });
  return [...events, { type: "response.completed", response: { status: "completed" } }]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

async function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return server;
}

const urlOf = (server: http.Server) =>
  `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function record(body: string, contentType: string, proxyOnly = false) {
  const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-responses-json-"));
  const logger = new Logger("warn");
  const warn = vi.spyOn(logger, "warn");
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  });
  const recorder = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      void proxyAndRecord(
        req,
        res,
        { model: "gpt-4o", messages: [{ role: "user", content: "Say hi" }] },
        "openai",
        "/v1/responses",
        [],
        { record: { providers: { openai: urlOf(upstream) }, fixturePath, proxyOnly }, logger },
        raw,
      );
    });
  });
  try {
    const relayed = await fetch(`${urlOf(recorder)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "Say hi" }),
    });
    expect(relayed.status).toBe(200);
    await relayed.text();
    return {
      fixturePath,
      fixtures: loadFixturesFromDir(fixturePath),
      warnings: warn.mock.calls.flat().join("\n"),
    };
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await new Promise<void>((resolve) => recorder.close(() => resolve()));
  }
}

describe("recorder: non-streamed OpenAI Responses bodies", () => {
  it("records a successful uncited reply as a fixture that replays the reply", async () => {
    const body = {
      id: "resp_1",
      object: "response",
      created_at: 1763000000,
      status: "completed",
      background: false,
      billing: { payer: "developer" },
      completed_at: 1763000001,
      error: null,
      incomplete_details: null,
      model: "gpt-4o",
      output: [message("Hi there!")],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
    const { fixturePath, fixtures, warnings } = await record(
      JSON.stringify(body),
      "application/json",
    );
    try {
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].response).toMatchObject({ content: "Hi there!" });
      expect(fixtures[0].response).not.toHaveProperty("error");
      expect(warnings).not.toContain("Could not detect response format");

      const replay = await createServer(fixtures, { port: 0 });
      try {
        const res = await fetch(`${replay.url}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", input: "Say hi", stream: false }),
        });
        expect(res.status).toBe(200);
        const replayed = (await res.json()) as { output: Json[] };
        expect(replayed.output.at(-1)).toMatchObject({
          type: "message",
          content: [{ type: "output_text", text: "Hi there!" }],
        });
      } finally {
        await new Promise<void>((resolve) => replay.server.close(() => resolve()));
      }
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  const turns: Array<[string, Json[]]> = [
    ["text", [message("Hello")]],
    ["a tool call", [call]],
    ["text then a tool call", [message("Checking."), call]],
    ["reasoning then text", [reasoning, message("Done.")]],
    ["an empty output", []],
  ];
  for (const [name, output] of turns) {
    it(`records ${name} as the stream of the same turn records it`, async () => {
      const json = await record(JSON.stringify({ object: "response", output }), "application/json");
      const sse = await record(streamOf(output), "text/event-stream");
      try {
        expect(json.fixtures.map((f) => f.response)).toEqual(sse.fixtures.map((f) => f.response));
        expect(json.fixtures[0].response).not.toHaveProperty("error");
      } finally {
        fs.rmSync(json.fixturePath, { recursive: true, force: true });
        fs.rmSync(sse.fixturePath, { recursive: true, force: true });
      }
    });
  }

  it("does not claim to save anything in proxy-only mode", async () => {
    const { fixturePath, fixtures, warnings } = await record(
      JSON.stringify({ unknown: true }),
      "application/json",
      true,
    );
    try {
      expect(fixtures).toEqual([]);
      expect(warnings).toContain("Could not detect response format");
      expect(warnings).not.toMatch(/saving/i);
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});
