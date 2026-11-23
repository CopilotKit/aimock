/**
 * Byte-identity guard for #505 (namespaced and custom tool calls).
 *
 * Fixtures WITHOUT `type`, `namespace` or `input` must keep producing the
 * Responses output they produced before #505. This suite drives a real aimock
 * over HTTP (streaming and non-streaming) and WebSocket for four fixtures:
 * tool-only, tool-only with a reasoning + web-search prefix, content+toolCalls,
 * and ordered blocks with a reasoning prefix. It records the HTTP status and
 * the parsed JSON of the non-streaming body, of every SSE `data:` payload and
 * of every WebSocket message, in order; replaces the random ids and
 * `created_at` timestamps with stable placeholders; and compares the result to
 * a golden file. Key order and values are compared exactly; SSE `event:` lines
 * and JSON whitespace are not.
 *
 * The golden is read-only here. It is never written or updated by the test
 * run (`vitest -u` cannot rebaseline it), and a missing golden fails the test.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

const GOLDEN = fileURLToPath(
  new URL("./__snapshots__/responses-tool-call-byte-identity.json", import.meta.url),
);

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
  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`${input} (stream=${stream}): not JSON (${String(err)}): ${raw}`);
    }
  };
  if (!stream) return { status: res.status, body: parse(text) };
  const events = text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (data === undefined) throw new Error(`${input}: SSE block has no data line: ${block}`);
      return parse(data.slice(6));
    });
  return { status: res.status, events };
}

async function wsResponses(input: string): Promise<unknown> {
  const ws = await connectWebSocket(mock.url, "/v1/responses");
  try {
    ws.send(JSON.stringify({ type: "response.create", model: MODEL, input }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msgs = ws.getMessages();
      const error = msgs.find((m) => m.includes('"type":"error"'));
      if (error !== undefined) throw new Error(`WS "${input}": error event: ${error}`);
      if (msgs.some((m) => m.includes('"type":"response.completed"'))) {
        return msgs.map((m) => JSON.parse(m) as unknown);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const got = ws.getMessages();
    throw new Error(
      `WS "${input}": no response.completed or error within 3s; got ${got.length} messages: ${got.join("\n")}`,
    );
  } finally {
    ws.close();
  }
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
    expect(existsSync(GOLDEN), `golden file missing: ${GOLDEN}`).toBe(true);
    expect(JSON.stringify(capture, null, 2) + "\n").toBe(readFileSync(GOLDEN, "utf8"));
  });
});
