/**
 * Opt-in non-streaming timing (`nonStreamingTimingAllProviders: true`) on the
 * OpenAI Responses and Ollama wires, over real HTTP with real timing.
 *
 * 1. The Responses JSON wait is sized from what the Responses wire serves
 *    (custom tool calls, `responsesBlocks` over `blocks`, citations and
 *    generated files), so it tracks the
 *    timed stream of the same fixture within a few frames of overhead.
 * 2. A misbehavior-applied JSON reply is built after the wait, so its
 *    `created_at` is not earlier than the request time plus the delay.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "./helpers/misbehavior-enabled.js";
import type { Fixture } from "../types.js";

let mock: LLMock | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(fixtures: Fixture[]): Promise<string> {
  mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
  mock.addFixtures(fixtures);
  return mock.start();
}

/** Milliseconds from sending the request to reading the whole body. */
async function timedResponses(url: string, input: string, stream: boolean): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5", input, stream }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return performance.now() - t0;
}

// 40 frames per second: 25 ms per frame (chunk 0 included, no ttft).
const timing = {
  streamingProfile: { tps: 40 },
  nonStreamingTimingAllProviders: true,
  chunkSize: 20,
};
const INPUT = "p".repeat(400);

describe("Responses non-streaming wait matches the timed stream", () => {
  const cases: Array<[string, Fixture["response"]]> = [
    [
      "customToolCalls",
      { toolCalls: [], customToolCalls: [{ type: "custom", name: "apply_patch", input: INPUT }] },
    ],
    [
      "responsesBlocks with a custom call",
      { responsesBlocks: [{ type: "customToolCall", name: "apply_patch", input: INPUT }] },
    ],
    [
      "blocks plus responsesBlocks",
      {
        blocks: [{ type: "text", text: "x" }],
        responsesBlocks: [{ type: "text", text: INPUT }],
      },
    ],
  ];

  // One text chunk, then frames with no text: 10 annotation.added frames and
  // 2 image_generation_call items of 5 frames each. The JSON wait counts those
  // 20 frames as chunks; without them it counted one chunk (about 25 ms) and
  // trailed the stream by about 750 ms.
  it("citations and generated files", async () => {
    const name = "cited";
    const text = "Cited text.";
    const response: Fixture["response"] = {
      content: text,
      citations: Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/${i}`,
        startIndex: 0,
        endIndex: text.length,
      })),
      files: Array.from({ length: 2 }, () => ({ mimeType: "image/png", data: "iVBORw0KGgo=" })),
    };
    const url = await start([{ match: { userMessage: name }, response, ...timing }]);
    const streamMs = await timedResponses(url, name, true);
    const jsonMs = await timedResponses(url, name, false);
    expect(streamMs).toBeGreaterThan(500);
    expect(jsonMs).toBeGreaterThan(450);
    expect(streamMs - jsonMs).toBeLessThanOrEqual(350);
    expect(jsonMs).toBeLessThanOrEqual(streamMs + 100);
  });

  it.each(cases)("%s", async (name, response) => {
    const url = await start([{ match: { userMessage: name }, response, ...timing }]);
    const streamMs = await timedResponses(url, name, true);
    const jsonMs = await timedResponses(url, name, false);
    // The stream sends 20 delta frames plus 6 to 8 envelope frames (650 to
    // 700 ms). The JSON wait counts only the served payload chunks (about
    // 500 to 525 ms), so it trails the stream by the envelope frames plus
    // HTTP overhead: at most 350 ms. Before the fix it counted one chunk
    // (about 25 ms), so it trailed by about 700 ms.
    expect(streamMs).toBeGreaterThan(500);
    expect(streamMs - jsonMs).toBeLessThanOrEqual(350);
    expect(jsonMs).toBeLessThanOrEqual(streamMs + 100);
  });
});

describe("misbehavior JSON reply is built after the wait", () => {
  it("Responses: created_at is at or after the request time plus the delay", async () => {
    const url = await start([
      {
        match: { userMessage: "late" },
        response: { content: "hi" },
        misbehavior: "empty-response",
        recordedTimings: { ttftMs: 1500, interChunkDelaysMs: [], totalDurationMs: 1500 },
        nonStreamingTimingAllProviders: true,
      },
    ]);
    const t0 = Date.now();
    const res = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: "late" }),
    });
    const body = (await res.json()) as { created_at: number };
    expect(res.status).toBe(200);
    expect(body.created_at).toBeGreaterThanOrEqual(Math.floor((t0 + 1500) / 1000));
  });

  it("Ollama: created_at is at or after the request time plus the delay", async () => {
    const url = await start([
      {
        match: { userMessage: "late" },
        response: { content: "hi" },
        misbehavior: "empty-response",
        recordedTimings: { ttftMs: 400, interChunkDelaysMs: [], totalDurationMs: 400 },
        nonStreamingTimingAllProviders: true,
      },
    ]);
    const t0 = Date.now();
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        stream: false,
        messages: [{ role: "user", content: "late" }],
      }),
    });
    const body = (await res.json()) as { created_at: string };
    expect(res.status).toBe(200);
    // Timer slack: a 400 ms timer can fire a millisecond early.
    expect(Date.parse(body.created_at)).toBeGreaterThanOrEqual(t0 + 400 - 5);
  });
});
