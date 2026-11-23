/**
 * #505 — `response.custom_tool_call_input.delta` chunking must never split a
 * surrogate pair. A cut between the two halves of an astral char puts a lone
 * surrogate in each of two frames: a consumer that decodes each delta on its
 * own (UTF-8 encode, a strict JSON parser, a terminal) gets U+FFFD in place
 * of the char.
 *
 * Real surfaces only: a real LLMock listens and assertions read the bytes a
 * client gets over HTTP SSE and the WebSocket transport.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

type Ev = { type: string; [key: string]: unknown };

let mock: LLMock | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(fixtures: Fixture[], chunkSize: number): Promise<LLMock> {
  // custom_tool_call output needs responsesTools "extended".
  mock = new LLMock({ port: 0, chunkSize, responsesTools: "extended" });
  mock.addFixtures(fixtures);
  await mock.start();
  return mock;
}

async function sse(m: LLMock, input: string): Promise<Ev[]> {
  const res = await fetch(`${m.url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5", input, stream: true }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Ev);
}

/** One response.create over WS; fails if no response.completed arrives in 3s. */
async function ws(m: LLMock, input: string): Promise<Ev[]> {
  const client = await connectWebSocket(m.url, "/v1/responses");
  try {
    client.send(JSON.stringify({ type: "response.create", model: "gpt-5", input }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msgs = client.getMessages();
      if (msgs.some((x) => /"response\.completed"|"type":"error"/.test(x))) {
        return msgs.map((x) => JSON.parse(x) as Ev);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`WS "${input}": no response.completed within 3s`);
  } finally {
    client.close();
  }
}

/** True when `s` holds a high surrogate with no low after it, or a low with no high before it. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const CASES: { name: string; input: string; chunkSize: number }[] = [
  // "patch " is 6 units, so a cut at 7 lands between the halves of 😀.
  { name: "cut inside the first pair", input: "patch 😀🚀 ok", chunkSize: 7 },
  // Every other cut at 1 is inside a pair.
  { name: "chunkSize 1", input: "😀🚀𝄞", chunkSize: 1 },
  // Odd chunkSize over back-to-back pairs: cuts fall inside pairs repeatedly.
  { name: "odd chunkSize over a run of pairs", input: "a😀😀😀😀😀😀b", chunkSize: 3 },
  { name: "pair at the very end", input: "abcdef😀", chunkSize: 7 },
];

describe("custom_tool_call_input.delta chunking keeps surrogate pairs whole", () => {
  for (const c of CASES) {
    it(`${c.name}: SSE and WS deltas are well-formed and rejoin to the input`, async () => {
      const m = await start(
        [
          {
            match: { userMessage: "astral" },
            response: {
              toolCalls: [],
              customToolCalls: [{ type: "custom", name: "apply_patch", input: c.input }],
            },
          },
        ],
        c.chunkSize,
      );
      for (const [wire, events] of [
        ["sse", await sse(m, "astral")],
        ["ws", await ws(m, "astral")],
      ] as const) {
        const deltas = events
          .filter((e) => e.type === "response.custom_tool_call_input.delta")
          .map((e) => e.delta as string);
        expect(deltas.length, wire).toBeGreaterThan(0);
        for (const d of deltas) {
          expect(hasLoneSurrogate(d), `${wire} delta ${JSON.stringify(d)}`).toBe(false);
          expect(d.length, `${wire} delta ${JSON.stringify(d)}`).toBeGreaterThan(0);
          // A delta is at most chunkSize units, or one whole pair when chunkSize is 1.
          expect(d.length, `${wire} delta ${JSON.stringify(d)}`).toBeLessThanOrEqual(
            Math.max(c.chunkSize, 2),
          );
        }
        expect(deltas.join(""), wire).toBe(c.input);
        // Per-delta UTF-8 round trip must not lose a char.
        expect(deltas.map((d) => Buffer.from(d, "utf8").toString("utf8")).join(""), wire).toBe(
          c.input,
        );
        const done = events.find((e) => e.type === "response.custom_tool_call_input.done");
        expect(done?.input, wire).toBe(c.input);
      }
    });
  }

  it("BMP-only input keeps the exact chunkSize slicing", async () => {
    const input = "*** Begin Patch\n";
    const m = await start(
      [
        {
          match: { userMessage: "astral" },
          response: {
            toolCalls: [],
            customToolCalls: [{ type: "custom", name: "apply_patch", input }],
          },
        },
      ],
      5,
    );
    const deltas = (await sse(m, "astral"))
      .filter((e) => e.type === "response.custom_tool_call_input.delta")
      .map((e) => e.delta as string);
    expect(deltas).toEqual(["*** B", "egin ", "Patch", "\n"]);
  });
});
