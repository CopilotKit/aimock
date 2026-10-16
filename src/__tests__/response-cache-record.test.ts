import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeEventStreamFrame } from "../aws-event-stream.js";
import { loadFixtureFile, validateFixtures } from "../fixture-loader.js";
import { collapseStreamingResponse } from "../stream-collapse.js";
import { sanitizeUsage } from "../response/usage/fields.js";
import { captureUsage } from "../response/usage/recording.js";
import type { FixtureFile } from "../types.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  startStubUpstream,
} from "./golden/harness.js";

const cases = ["messages-final", "messages-stream", "bedrock-final", "bedrock-stream"] as const;
const startUsage = {
  input_tokens: 10,
  output_tokens: 2,
  cache_read_input_tokens: 500,
  cache_creation_input_tokens: 40,
  cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
};
const deltaUsage = {
  output_tokens: 7,
  input_tokens: null,
  cache_read_input_tokens: 600,
  cache_creation_input_tokens: null,
};
const unknownMemberUsage = {
  ...startUsage,
  cache_creation: JSON.parse(
    '{"__proto__":1,"a":1,"future":90,"invalid":"drop","nested":{"invalid":1}}',
  ),
};
function recordingExchange(usage: typeof startUsage | typeof unknownMemberUsage) {
  const final = {
    type: "message",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage,
  };
  const events = [
    { type: "message_start", message: { ...final, content: [] } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: deltaUsage },
    { type: "message_stop" },
  ];
  const sse = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const aws = Buffer.concat(
    events.map((event) =>
      encodeEventStreamFrame(
        { ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" },
        Buffer.from(
          JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") }),
        ),
      ),
    ),
  );
  return { final, sse, aws };
}
const { final, sse } = recordingExchange(startUsage);
const recordCases = cases.flatMap((id) => [
  { id, unknownMembers: false },
  { id, unknownMembers: true },
]);

describe("Anthropic cache actual record-mode fixture files and replay", () => {
  it.each(recordCases)("record-$id unknownMembers=$unknownMembers", async (entry) => {
    const { id, unknownMembers } = entry;
    const { final, sse, aws } = recordingExchange(unknownMembers ? unknownMemberUsage : startUsage);
    const captureId = unknownMembers ? `${id}-unknown-members` : id;
    const stream = id.endsWith("stream");
    const messages = id.startsWith("messages");
    const fixturePath = mkdtempSync(join(tmpdir(), "aimock-cache-record-"));
    const upstream = await startStubUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": stream
          ? messages
            ? "text/event-stream"
            : "application/vnd.amazon.eventstream"
          : "application/json",
      });
      response.end(stream ? (messages ? sse : aws) : JSON.stringify(final));
    });
    const record = await startGoldenServer([], {
      record: { providers: { [messages ? "anthropic" : "bedrock"]: upstream.url }, fixturePath },
    });
    let replay: Awaited<ReturnType<typeof startGoldenServer>> | undefined;
    const route = messages
      ? "/v1/messages"
      : `/model/anthropic.claude-sonnet-4-5-v1/${stream ? "invoke-with-response-stream" : "invoke"}`;
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        ...(messages ? { stream } : { anthropic_version: "bedrock-2023-05-31" }),
        messages: [{ role: "user", content: id }],
      }),
      frames: stream ? (messages ? ("sse" as const) : ("aws" as const)) : undefined,
    };
    try {
      const got = await captureHttp(`${record.url}${route}`, request);
      expect(got.status).toBe(200);
      expect(upstream.requests).toHaveLength(1);
      await expect
        .poll(() => readdirSync(fixturePath).filter((name) => name.endsWith(".json")).length)
        .toBe(1);
      const path = join(
        fixturePath,
        readdirSync(fixturePath).find((name) => name.endsWith(".json"))!,
      );
      const raw = readFileSync(path, "utf8");
      const file: FixtureFile = JSON.parse(raw);
      const loaded = loadFixtureFile(path);
      replay = await startGoldenServer(loaded);
      const replayed = await captureHttp(`${replay.url}${route}`, request);
      if (process.env.F1_CAPTURE_DIR) {
        mkdirSync(process.env.F1_CAPTURE_DIR, { recursive: true });
        writeFileSync(join(process.env.F1_CAPTURE_DIR, `record-${captureId}-fixture.json`), raw);
        writeFileSync(
          join(process.env.F1_CAPTURE_DIR, `record-${captureId}-replay.json`),
          serializeGolden(replayed),
        );
      }
      expect(validateFixtures(loaded)).toEqual([]);
      const expected = {
        ...startUsage,
        ...(unknownMembers
          ? { cache_creation: JSON.parse('{"__proto__":1,"a":1,"future":90}') }
          : {}),
        ...(stream ? { output_tokens: 7, cache_read_input_tokens: 600 } : {}),
      };
      if (unknownMembers) {
        for (const response of [file.fixtures[0].response, loaded[0].response]) {
          if (!("usage" in response)) throw new Error("Expected recorded usage");
          const cache = response.usage?.cache_creation;
          expect(Object.getOwnPropertyDescriptor(cache, "__proto__")).toMatchObject({
            value: 1,
            enumerable: true,
          });
          expect(Object.getPrototypeOf(cache)).toBe(Object.prototype);
          expect(Object.keys(cache!)).toEqual(["__proto__", "a", "future"]);
        }
      }
      expect(file.fixtures[0].response).toMatchObject({ content: "Hello", usage: expected });
      expect(loaded[0].response).toEqual(file.fixtures[0].response);
      expect(replayed.status).toBe(200);
      const replayEvents = replayed.body
        ? [JSON.parse(replayed.body)]
        : (replayed.frames ?? []).map((frame) =>
            JSON.parse(
              typeof frame === "string"
                ? frame
                    .split("\n")
                    .find((line) => line.startsWith("data: "))!
                    .slice(6)
                : frame.decodedBytes!,
            ),
          );
      expect(
        stream
          ? replayEvents.find((event) => event.type === "message_start").message.usage
          : replayEvents[0].usage,
      ).toEqual({
        ...expected,
        ...(unknownMembers
          ? { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }
          : {}),
      });
      if (stream)
        expect(replayEvents.find((event) => event.type === "message_delta").usage).toEqual({
          output_tokens: messages ? 7 : 0,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 40,
        });
    } finally {
      await replay?.close();
      await record.close();
      await upstream.close();
      rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("capture sanitation and unchanged dispatch controls", () => {
  it("numeric delta wins, null keeps start and only finite scalar observations merge", () => {
    const body = `${sse}data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: null, cache_read_input_tokens: "drop", unknown: "drop" } })}\n\n`;
    expect(collapseStreamingResponse("text/event-stream", "anthropic", body)?.usage).toEqual({
      ...startUsage,
      output_tokens: 7,
      cache_read_input_tokens: 600,
    });
  });
  it("sanitizes finite numeric cache members and preserves numeric cache_creation", () => {
    expect(
      sanitizeUsage({
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: Infinity,
          future: 90,
          invalid: "drop",
          nested: { invalid: 1 },
        },
      }),
    ).toEqual({ cache_creation: { ephemeral_5m_input_tokens: 0, future: 90 } });
    expect(sanitizeUsage({ cache_creation: 40 })).toEqual({ cache_creation: 40 });
  });
  it.each(["gemini", "ollama", "cohere", "bedrock-converse", "interactions"] as const)(
    "%s keeps omitted usage",
    (family) => {
      expect(captureUsage({ family, stage: "nonstream", observation: final })).toBeUndefined();
    },
  );
  it("NDJSON content type keeps precedence over Anthropic provider", () => {
    const body =
      JSON.stringify({
        message: { content: "Hello" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 2,
      }) + "\n";
    expect(collapseStreamingResponse("application/x-ndjson", "anthropic", body)).toMatchObject({
      content: "Hello",
    });
    expect(
      collapseStreamingResponse("application/x-ndjson", "anthropic", body)?.usage,
    ).toBeUndefined();
  });
  it("mismatched SSE body keeps Anthropic content parsing", () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }], usage: startUsage })}\n\n`;
    const result = collapseStreamingResponse("text/event-stream", "anthropic", body);
    expect(result?.content).toBe("");
    expect(result?.usage).toBeUndefined();
  });
});
