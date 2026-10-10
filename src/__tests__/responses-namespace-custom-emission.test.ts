/**
 * #505 — Responses API emission of namespaced `function_call` items and
 * `custom_tool_call` items.
 *
 * Real surfaces only: a real LLMock listens and assertions read the bytes a
 * client gets over HTTP (SSE and JSON) or the WebSocket transport, plus the
 * journal for interruption state.
 */
import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

type Ev = { type: string; [key: string]: unknown };
type Item = Record<string, unknown>;

const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n";

let mock: LLMock | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(
  fixtures: Fixture[],
  opts: { chunkSize?: number; responsesTools?: "legacy" | "extended" } = {},
): Promise<LLMock> {
  // Namespaces on toolCalls entries and toolCall blocks are emitted only with
  // responsesTools "extended", like customToolCalls / responsesBlocks.
  mock = new LLMock({ port: 0, responsesTools: "extended", ...opts });
  mock.addFixtures(fixtures);
  await mock.start();
  return mock;
}

function parseSSE(body: string): Ev[] {
  return body
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (data === undefined) throw new Error(`SSE block has no data line: ${block}`);
      try {
        return JSON.parse(data.slice(6)) as Ev;
      } catch (err) {
        throw new Error(`SSE data is not JSON (${String(err)}): ${data}`);
      }
    });
}

async function stream(m: LLMock, input: string, model = "gpt-5"): Promise<Ev[]> {
  const res = await fetch(`${m.url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input, stream: true }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return parseSSE(text);
}

async function nonStream(m: LLMock, input: string, model = "gpt-5"): Promise<Item[]> {
  const res = await fetch(`${m.url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return (JSON.parse(text) as { output: Item[] }).output;
}

/** One response.create over WS; fails if neither response.completed nor an error arrives in 3s. */
async function ws(m: LLMock, input: string, model = "gpt-5"): Promise<Ev[]> {
  const client = await connectWebSocket(m.url, "/v1/responses");
  try {
    client.send(JSON.stringify({ type: "response.create", model, input }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msgs = client.getMessages();
      if (msgs.some((x) => /"response\.completed"|"type":"error"/.test(x))) {
        return msgs.map((x) => JSON.parse(x) as Ev);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const got = client.getMessages();
    throw new Error(
      `WS "${input}": no response.completed or error within 3s; got ${got.length} messages: ${got.join("\n")}`,
    );
  } finally {
    client.close();
  }
}

function completedOutput(events: Ev[]): Item[] {
  const done = events.find((e) => e.type === "response.completed");
  expect(done, JSON.stringify(events)).toBeDefined();
  return (done!.response as { output: Item[] }).output;
}

function itemsOf(events: Ev[], type: string, itemType: string): Item[] {
  return events
    .filter((e) => e.type === type && (e.item as Item | undefined)?.type === itemType)
    .map((e) => e.item as Item);
}

/**
 * Assert the custom_tool_call event sequence at output_index k:
 * output_item.added, custom_tool_call_input.delta x N, .done, output_item.done.
 */
function expectCustomSequence(
  events: Ev[],
  k: number,
  want: { name: string; input: string; callId?: string; namespace?: string; chunks?: string[] },
): void {
  const mine = events.filter((e) => e.output_index === k);
  expect(
    mine.length,
    `no custom_tool_call events at output_index ${k}; got output_index values ${JSON.stringify([
      ...new Set(events.map((e) => e.output_index).filter((i) => i !== undefined)),
    ])}`,
  ).toBeGreaterThan(0);
  const types = mine.map((e) => e.type);
  const deltas = mine.filter((e) => e.type === "response.custom_tool_call_input.delta");
  expect(types[0]).toBe("response.output_item.added");
  expect(types.at(-1)).toBe("response.output_item.done");
  expect(types.at(-2)).toBe("response.custom_tool_call_input.done");
  expect(types.slice(1, -2).every((t) => t === "response.custom_tool_call_input.delta")).toBe(true);
  const added = mine[0].item as Item;
  const done = mine.at(-1)!.item as Item;
  expect(added.type).toBe("custom_tool_call");
  expect(String(added.id)).toMatch(/^ctc_/);
  expect(added.input).toBe("");
  expect(added.status).toBe("in_progress");
  expect(added.name).toBe(want.name);
  expect(done).toEqual({
    type: "custom_tool_call",
    id: added.id,
    call_id: added.call_id,
    ...(want.namespace !== undefined ? { namespace: want.namespace } : {}),
    name: want.name,
    input: want.input,
    status: "completed",
  });
  if (want.namespace === undefined) expect("namespace" in added).toBe(false);
  else expect(added.namespace).toBe(want.namespace);
  if (want.callId) expect(done.call_id).toBe(want.callId);
  else expect(String(done.call_id)).toMatch(/^call_/);
  for (const d of deltas) {
    expect(d.item_id).toBe(added.id);
    expect(Object.keys(d).sort()).toEqual(["delta", "item_id", "output_index", "type"]);
  }
  expect(deltas.map((d) => d.delta).join("")).toBe(want.input);
  if (want.chunks) expect(deltas.map((d) => d.delta)).toEqual(want.chunks);
  const inputDone = mine.at(-2)!;
  expect(inputDone).toEqual({
    type: "response.custom_tool_call_input.done",
    item_id: added.id,
    output_index: k,
    input: want.input,
  });
}

describe("namespaced function_call", () => {
  const fixtures: Fixture[] = [
    {
      match: { userMessage: "ns tool-only" },
      response: {
        toolCalls: [
          {
            name: "spawn_agent",
            namespace: "collaboration",
            arguments: '{"message":"hi"}',
            id: "call_a",
          },
          { name: "plain", arguments: "{}" },
        ],
      },
    },
    {
      match: { userMessage: "ns content-tools" },
      response: {
        content: "Calling.",
        toolCalls: [{ name: "search", namespace: "mcp__docs__", arguments: '{"q":"x"}' }],
      },
    },
    {
      match: { userMessage: "ns blocks" },
      response: {
        blocks: [
          { type: "toolCall", name: "search", namespace: "mcp__docs__", arguments: '{"q":"x"}' },
          { type: "text", text: "Done." },
        ],
      },
    },
  ];

  it("emits namespace on added, done, completed output and non-streaming output; absent when unset", async () => {
    const m = await start(fixtures);
    for (const events of [await stream(m, "ns tool-only"), await ws(m, "ns tool-only")]) {
      const added = itemsOf(events, "response.output_item.added", "function_call");
      const done = itemsOf(events, "response.output_item.done", "function_call");
      expect(added.map((i) => i.namespace)).toEqual(["collaboration", undefined]);
      expect(done.map((i) => i.namespace)).toEqual(["collaboration", undefined]);
      expect("namespace" in added[1]).toBe(false);
      expect("namespace" in done[1]).toBe(false);
      expect(done[0].call_id).toBe("call_a");
      expect(completedOutput(events)).toEqual(done);
    }
    const out = await nonStream(m, "ns tool-only");
    expect(out.map((i) => i.namespace)).toEqual(["collaboration", undefined]);
    expect("namespace" in out[1]).toBe(false);
    expect(out[0]).toMatchObject({
      type: "function_call",
      call_id: "call_a",
      namespace: "collaboration",
      name: "spawn_agent",
      arguments: '{"message":"hi"}',
      status: "completed",
    });
  });

  it("emits namespace on the legacy content+toolCalls path and the blocks path", async () => {
    const m = await start(fixtures);
    for (const input of ["ns content-tools", "ns blocks"]) {
      for (const events of [await stream(m, input), await ws(m, input)]) {
        const fc = completedOutput(events).find((i) => i.type === "function_call")!;
        expect(fc.namespace).toBe("mcp__docs__");
        expect(itemsOf(events, "response.output_item.added", "function_call")[0].namespace).toBe(
          "mcp__docs__",
        );
      }
      const fc = (await nonStream(m, input)).find((i) => i.type === "function_call")!;
      expect(fc.namespace).toBe("mcp__docs__");
    }
    const blocksOut = await nonStream(m, "ns blocks");
    expect(blocksOut.map((i) => i.type)).toEqual(["function_call", "message"]);
  });

  it("does not emit a toolCalls / blocks namespace by default (responsesTools legacy), as 1.44.0", async () => {
    const m = await start(fixtures, { responsesTools: "legacy" });
    for (const input of ["ns tool-only", "ns content-tools", "ns blocks"]) {
      for (const events of [await stream(m, input), await ws(m, input)]) {
        for (const item of [
          ...itemsOf(events, "response.output_item.added", "function_call"),
          ...completedOutput(events).filter((i) => i.type === "function_call"),
        ]) {
          expect("namespace" in item, JSON.stringify(item)).toBe(false);
        }
      }
      for (const item of (await nonStream(m, input)).filter((i) => i.type === "function_call")) {
        expect("namespace" in item, JSON.stringify(item)).toBe(false);
      }
    }
  });
});

describe("custom_tool_call", () => {
  it("streams multi-chunk input with the custom_tool_call event sequence over HTTP SSE and WS; call_id = fixture id", async () => {
    const m = await start(
      [
        {
          match: { userMessage: "custom patch" },
          response: {
            toolCalls: [],
            customToolCalls: [
              { type: "custom", name: "apply_patch", input: PATCH, id: "call_patch" },
            ],
          },
        },
      ],
      { chunkSize: 10 },
    );
    const chunks: string[] = [];
    for (let i = 0; i < PATCH.length; i += 10) chunks.push(PATCH.slice(i, i + 10));
    for (const events of [await stream(m, "custom patch"), await ws(m, "custom patch")]) {
      expectCustomSequence(events, 0, {
        name: "apply_patch",
        input: PATCH,
        callId: "call_patch",
        chunks,
      });
      expect(events.some((e) => e.type.startsWith("response.function_call_arguments"))).toBe(false);
      expect(completedOutput(events)).toEqual([
        events.filter((e) => e.type === "response.output_item.done").at(-1)!.item,
      ]);
    }
    const out = await nonStream(m, "custom patch");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "custom_tool_call",
      id: out[0].id,
      call_id: "call_patch",
      name: "apply_patch",
      input: PATCH,
      status: "completed",
    });
    expect(String(out[0].id)).toMatch(/^ctc_/);
    expect("arguments" in out[0]).toBe(false);
  });

  it("emits no delta for empty input, and one delta when chunkSize exceeds the input", async () => {
    const m = await start(
      [
        {
          match: { userMessage: "custom empty" },
          response: {
            toolCalls: [],
            customToolCalls: [{ type: "custom", name: "noop", input: "" }],
          },
        },
        {
          match: { userMessage: "custom short" },
          response: {
            toolCalls: [],
            customToolCalls: [{ type: "custom", name: "run", input: "ls" }],
          },
        },
      ],
      { chunkSize: 50 },
    );
    for (const events of [await stream(m, "custom empty"), await ws(m, "custom empty")]) {
      expectCustomSequence(events, 0, { name: "noop", input: "", chunks: [] });
    }
    for (const events of [await stream(m, "custom short"), await ws(m, "custom short")]) {
      expectCustomSequence(events, 0, { name: "run", input: "ls", chunks: ["ls"] });
    }
  });

  it("carries namespace on a namespaced custom call (responsesTools extended)", async () => {
    const m = await start([
      {
        match: { userMessage: "custom ns" },
        response: {
          toolCalls: [],
          customToolCalls: [{ type: "custom", name: "run", namespace: "sandbox", input: "ls -la" }],
        },
      },
    ]);
    for (const events of [await stream(m, "custom ns"), await ws(m, "custom ns")]) {
      expectCustomSequence(events, 0, { name: "run", input: "ls -la", namespace: "sandbox" });
    }
    const out = await nonStream(m, "custom ns");
    expect(out[0]).toMatchObject({ type: "custom_tool_call", namespace: "sandbox", name: "run" });
  });

  it("ignores customToolCalls and responsesBlocks by default (responsesTools legacy), as 1.44.0", async () => {
    const m = await start(
      [
        {
          match: { userMessage: "custom ns" },
          response: {
            toolCalls: [],
            customToolCalls: [{ type: "custom", name: "run", namespace: "sandbox", input: "ls" }],
          },
        },
        {
          match: { userMessage: "combo" },
          response: {
            content: "before",
            toolCalls: [{ name: "top_fn", arguments: "{}" }],
            responsesBlocks: [
              { type: "text", text: "before" },
              { type: "customToolCall", name: "apply_patch", input: "x" },
              { type: "toolCall", name: "top_fn", arguments: "{}" },
            ],
          },
        },
      ],
      { responsesTools: "legacy" },
    );
    // 1.44.0 serves an empty tool turn for `toolCalls: []`.
    expect(await nonStream(m, "custom ns")).toEqual([]);
    for (const events of [await stream(m, "custom ns"), await ws(m, "custom ns")]) {
      expect(JSON.stringify(events)).not.toContain("custom_tool_call");
    }
    // 1.44.0 serves content + toolCalls and never reads responsesBlocks.
    const combo = await nonStream(m, "combo");
    expect(combo.map((o) => [o.type, o.name])).toEqual([
      ["message", undefined],
      ["function_call", "top_fn"],
    ]);
    for (const events of [await stream(m, "combo"), await ws(m, "combo")]) {
      expect(JSON.stringify(events)).not.toContain("custom_tool_call");
      expect(JSON.stringify(events)).toContain("top_fn");
    }
  });

  it("serves a type:custom toolCalls entry as a function call, as 1.44.0 (custom calls live in customToolCalls)", async () => {
    // An untyped JSON fixture, as a 1.44.0 user could write it; it validates clean.
    const m = await start([]);
    m.addFixturesFromJSON(
      JSON.stringify([
        {
          match: { userMessage: "legacy typed" },
          response: { toolCalls: [{ type: "custom", name: "apply_patch", arguments: "{}" }] },
        },
      ]),
    );
    for (const events of [await stream(m, "legacy typed"), await ws(m, "legacy typed")]) {
      expect(completedOutput(events).map((i) => i.type)).toEqual(["function_call"]);
    }
    expect((await nonStream(m, "legacy typed")).map((i) => i.type)).toEqual(["function_call"]);
  });

  it("keeps array order and output_index continuity for mixed calls after reasoning and/or web-search prefixes", async () => {
    const m = await start([
      {
        match: { userMessage: "mixed legacy" },
        response: {
          content: "Working.",
          // Function calls first, then custom calls (legacy text-first order).
          toolCalls: [
            { name: "f1", arguments: "{}" },
            { name: "f2", namespace: "ns", arguments: '{"a":1}' },
          ],
          customToolCalls: [{ type: "custom", name: "apply_patch", input: PATCH }],
          reasoning: "Plan.",
          webSearches: ["q1"],
        },
      },
      {
        match: { userMessage: "mixed tool-only" },
        response: {
          toolCalls: [{ name: "f1", arguments: "{}" }],
          customToolCalls: [{ type: "custom", name: "apply_patch", input: PATCH }],
          reasoning: "Plan.",
        },
      },
      {
        match: { userMessage: "mixed blocks" },
        response: {
          responsesBlocks: [
            { type: "customToolCall", name: "apply_patch", input: PATCH, id: "call_b1" },
            { type: "text", text: "Patched." },
            { type: "toolCall", name: "f1", arguments: "{}" },
            { type: "customToolCall", name: "run", namespace: "sandbox", input: "ls" },
          ],
          webSearches: ["q1"],
        },
      },
    ]);
    type CustomWant = Parameters<typeof expectCustomSequence>[2];
    // Item types and the fixture-defined custom calls (by output_index) per case.
    const expectations: Record<string, { types: string[]; custom: Record<number, CustomWant> }> = {
      "mixed legacy": {
        types: [
          "reasoning",
          "web_search_call",
          "message",
          "function_call",
          "function_call",
          "custom_tool_call",
        ],
        custom: { 5: { name: "apply_patch", input: PATCH } },
      },
      "mixed tool-only": {
        types: ["reasoning", "function_call", "custom_tool_call"],
        custom: { 2: { name: "apply_patch", input: PATCH } },
      },
      "mixed blocks": {
        types: [
          "web_search_call",
          "custom_tool_call",
          "message",
          "function_call",
          "custom_tool_call",
        ],
        custom: {
          1: { name: "apply_patch", input: PATCH, callId: "call_b1" },
          4: { name: "run", input: "ls", namespace: "sandbox" },
        },
      },
    };
    for (const [input, { types, custom }] of Object.entries(expectations)) {
      for (const events of [await stream(m, input, "o3"), await ws(m, input, "o3")]) {
        const output = completedOutput(events);
        expect(output.map((i) => i.type)).toEqual(types);
        output.forEach((item, k) => {
          const done = events.find(
            (e) => e.type === "response.output_item.done" && e.output_index === k,
          );
          expect(done?.item).toEqual(item);
        });
        const customIndexes = types.flatMap((t, k) => (t === "custom_tool_call" ? [k] : []));
        expect(customIndexes).toEqual(Object.keys(custom).map(Number));
        for (const k of customIndexes) expectCustomSequence(events, k, custom[k]);
      }
      const out = await nonStream(m, input, "o3");
      expect(out.map((i) => i.type)).toEqual(types);
    }
    const blocks = await nonStream(m, "mixed blocks", "o3");
    expect(blocks[1]).toMatchObject({ call_id: "call_b1", input: PATCH });
    expect(blocks[4]).toMatchObject({ namespace: "sandbox", input: "ls" });
  });

  it("interrupts mid custom input when truncateAfterChunks is set", async () => {
    // PATCH is 61 chars, so chunkSize 5 gives 13 input deltas. The 5 counted
    // chunks are created, in_progress, output_item.added and the first 2
    // deltas. `latency` paces the writes so each one reaches the client before
    // the next (with no latency the socket is destroyed before anything
    // flushes). The 5th chunk is written in the same tick as the cut, so Node
    // discards it with the socket: the client receives exactly the first 4
    // counted chunks, that is 1 delta. Cutting one chunk earlier or later
    // would deliver 0 or 2 deltas.
    expect(PATCH.length).toBe(61);
    mock = new LLMock({ port: 0, chunkSize: 5, responsesTools: "extended" });
    mock.addFixture({
      match: { userMessage: "custom truncate" },
      response: {
        toolCalls: [],
        customToolCalls: [{ type: "custom", name: "apply_patch", input: PATCH }],
      },
      truncateAfterChunks: 5,
      latency: 5,
    });
    await mock.start();
    const url = `${mock.url}/v1/responses`;
    // Read raw bytes until the server cuts the stream; fetch would reject.
    const { text, cut } = await new Promise<{ text: string; cut: string | undefined }>(
      (resolve, reject) => {
        let buf = "";
        let cut: string | undefined;
        const req = http.request(
          url,
          { method: "POST", headers: { "Content-Type": "application/json" } },
          (res) => {
            res.setEncoding("utf8");
            res.on("data", (c: string) => (buf += c));
            // The server destroying the socket mid-body surfaces here as "aborted".
            res.on("error", (err) => (cut = err.message));
            res.on("close", () => {
              clearTimeout(timer);
              resolve({ text: buf, cut });
            });
          },
        );
        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error(`truncated stream did not close within 3s; got: ${buf}`));
        }, 3000);
        req.on("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`request failed before a response arrived: ${err.message}`));
        });
        req.end(JSON.stringify({ model: "gpt-5", input: "custom truncate", stream: true }));
      },
    );
    expect(cut, text).toBe("aborted");
    const events = parseSSE(text);
    const deltas = events.filter((e) => e.type === "response.custom_tool_call_input.delta");
    expect(events.slice(0, 3).map((e) => e.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
    ]);
    expect((events[2].item as Item).type).toBe("custom_tool_call");
    // The cut lands inside the custom input: exactly one delta arrived, and it
    // is the first 5 characters of PATCH.
    expect(deltas.length, text).toBe(1);
    expect(events.slice(3).map((e) => e.type)).toEqual(["response.custom_tool_call_input.delta"]);
    expect(deltas[0].delta).toBe(PATCH.slice(0, 5));
    expect(text).not.toContain("response.completed");
    expect(text).not.toContain("response.custom_tool_call_input.done");
    const entry = mock.getLastRequest();
    expect(entry?.response.status).toBe(200);
    expect(entry?.response.interrupted).toBe(true);
    expect(entry?.response.interruptReason).toBe("truncateAfterChunks");
  });
});
