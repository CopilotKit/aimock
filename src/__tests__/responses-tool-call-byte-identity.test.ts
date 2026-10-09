/**
 * Byte-identity guard for #505 (namespaced and custom tool calls).
 *
 * Fixtures WITHOUT `type`, `namespace` or `input` must keep producing exactly
 * the Responses wire output they produced before #505. This suite drives a real
 * aimock over HTTP (streaming and non-streaming) and WebSocket for the
 * tool-only, content+toolCalls and ordered-blocks shapes (with and without the
 * reasoning / web-search prefix), normalizes only the random ids and
 * timestamps, and compares the result to a golden file captured on the
 * pre-#505 base (7062bdce).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

const fixtures: Fixture[] = [
  {
    match: { userMessage: "bi tool-only" },
    response: {
      toolCalls: [
        { name: "get_weather", arguments: '{"city":"NYC"}', id: "call_fixed_1" },
        { name: "get_time", arguments: "{}" },
      ],
    },
  },
  {
    match: { userMessage: "bi tool-prefix" },
    response: {
      toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      reasoning: "Thinking about weather.",
      webSearches: ["weather nyc"],
    },
  },
  {
    match: { userMessage: "bi content-tools" },
    response: {
      content: "Checking now.",
      toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}', id: "call_fixed_2" }],
    },
  },
  {
    match: { userMessage: "bi blocks" },
    response: {
      content: "Here you go.",
      toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
      blocks: [
        { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}', id: "call_fixed_3" },
        { type: "text", text: "Here you go." },
      ],
      reasoning: "Plan first.",
    },
  },
];

const CASES = ["bi tool-only", "bi tool-prefix", "bi content-tools", "bi blocks"];
const MODEL = "o3-mini";

let mock: LLMock;
beforeAll(async () => {
  mock = new LLMock({ port: 0, chunkSize: 7 });
  mock.addFixtures(fixtures);
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
});

/** Replace random ids and timestamps with stable placeholders, keeping keys and order. */
function normalize(value: unknown): unknown {
  const seen = new Map<string, string>();
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k);
      return out;
    }
    if (key === "created_at" && typeof v === "number") return "<created_at>";
    if (
      typeof v === "string" &&
      (key === "id" || key === "call_id" || key === "item_id") &&
      !v.startsWith("call_fixed_")
    ) {
      if (!seen.has(v)) seen.set(v, `<${/^[a-z]+/.exec(v)?.[0] ?? "id"}#${seen.size}>`);
      return seen.get(v);
    }
    return v;
  };
  return walk(value);
}

async function postResponses(input: string, stream: boolean): Promise<unknown> {
  const res = await fetch(`${mock.url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input, stream }),
  });
  const text = await res.text();
  if (!stream) return { status: res.status, body: JSON.parse(text) };
  const events = text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) =>
      JSON.parse(
        b
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      ),
    );
  return { status: res.status, events };
}

async function wsResponses(input: string): Promise<unknown> {
  const ws = await connectWebSocket(mock.url, "/v1/responses");
  ws.send(JSON.stringify({ type: "response.create", model: MODEL, input }));
  const deadline = Date.now() + 5000;
  let msgs: string[] = [];
  while (Date.now() < deadline) {
    msgs = ws.getMessages();
    if (msgs.some((m) => m.includes('"response.completed"'))) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  ws.close();
  return msgs.map((m) => JSON.parse(m));
}

describe("Responses tool-call output is byte-identical for fixtures without #505 fields", () => {
  it("matches the pre-#505 golden capture over HTTP and WebSocket", async () => {
    const capture: Record<string, unknown> = {};
    for (const c of CASES) {
      capture[c] = normalize({
        nonStreaming: await postResponses(c, false),
        streaming: await postResponses(c, true),
        websocket: await wsResponses(c),
      });
    }
    await expect(JSON.stringify(capture, null, 2) + "\n").toMatchFileSnapshot(
      "./__snapshots__/responses-tool-call-byte-identity.json",
    );
  });
});
