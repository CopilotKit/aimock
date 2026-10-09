import { describe, expect, test } from "vitest";
import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses";
import { LLMock } from "../llmock.js";
import type { FixtureFileResponse, MisbehaviorFault } from "../types.js";
import { withFaultFixture } from "./helpers/misbehavior-server.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

const tools = [
  {
    type: "function",
    name: "weather",
    strict: false,
    parameters: {
      type: "object",
      properties: { city: { type: "string", enum: ["Paris"] } },
      required: ["city"],
      additionalProperties: false,
    },
  },
];
const tool = { name: "weather", arguments: { city: "Paris" } };
const later = { name: "later", arguments: { city: "Rome" } };
const shapes: { name: string; response: FixtureFileResponse }[] = [
  { name: "tool", response: { toolCalls: [tool, later] } },
  { name: "combined", response: { content: "Before", toolCalls: [tool, later] } },
  {
    name: "blocks",
    response: {
      blocks: [
        { type: "text", text: "Before" },
        { type: "toolCall", ...tool },
        { type: "text", text: "After" },
        { type: "toolCall", ...later },
      ],
    },
  },
];
const faults: MisbehaviorFault[] = [
  ...(["truncated", "trailing-comma", "single-quotes"] as const).map((style) => ({
    fault: "tool-args-invalid-json" as const,
    style,
  })),
  ...(
    ["missing-required", "wrong-type", "extra-property", "enum-mismatch", "not-object"] as const
  ).map((violation) => ({ fault: "tool-args-schema-violation" as const, violation })),
  { fault: "tool-unknown-name" },
  { fault: "tool-call-id-duplicate" },
  { fault: "stop-length-mid-tool" },
  { fault: "empty-response" },
  { fault: "refusal", message: "Cannot comply" },
  { fault: "content-filter" },
  { fault: "reasoning-only", reasoning: "Considering options" },
];

async function exchange(
  ws: WSTestClient,
  input = "weather",
  extra: { include?: string[]; stream?: boolean } = {},
) {
  const offset = ws.getMessages().length;
  const deadline = Date.now() + 5000;
  ws.send(JSON.stringify({ type: "response.create", model: "gpt-4o", input, tools, ...extra }));
  const events: ResponseStreamEvent[] = [];
  for (;;) {
    const messages = await ws.waitForMessages(
      offset + events.length + 1,
      Math.max(1, deadline - Date.now()),
    );
    const event: ResponseStreamEvent = JSON.parse(messages.at(-1)!);
    events.push(event);
    if (
      event.type === "error" ||
      event.type === "response.completed" ||
      event.type === "response.incomplete"
    )
      return events;
  }
}

function terminal(events: ResponseStreamEvent[]) {
  const last = events.at(-1);
  if (!last || (last.type !== "response.completed" && last.type !== "response.incomplete")) {
    throw new Error(`Expected terminal response, received ${JSON.stringify(last)}`);
  }
  return last.response;
}

async function withSocket(
  url: string,
  run: (ws: WSTestClient) => Promise<void>,
  path = "/v1/responses",
  headers = { "X-Test-Id": "s2-ws" },
) {
  const ws = await connectWebSocket(url, path, headers);
  try {
    await run(ws);
  } finally {
    ws.destroy();
  }
}

async function httpEvents(url: string) {
  const response = await fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", input: "weather", tools, stream: true }),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => {
      const event: ResponseStreamEvent = JSON.parse(line.slice(6));
      return event;
    });
}

// Canonicalize only volatile envelope/item IDs and timestamps. A single ID map
// preserves equality relationships across all frames, including duplicate call IDs.
function normalize(events: ResponseStreamEvent[]) {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(events, (key, value: unknown) => {
      if (key === "created_at") return 0;
      if (["id", "item_id", "response_id", "call_id"].includes(key) && typeof value === "string") {
        if (!ids.has(value)) ids.set(value, `id-${ids.size}`);
        return ids.get(value);
      }
      return value;
    }),
  );
}

function checkFault(response: Response, fault: MisbehaviorFault) {
  const calls = response.output.filter((item) => item.type === "function_call");
  if (fault.fault === "tool-args-invalid-json")
    expect(() => JSON.parse(calls[0].arguments)).toThrow();
  if (fault.fault === "tool-args-schema-violation") {
    const value = JSON.parse(calls[0].arguments);
    if (fault.violation === "missing-required") expect(value).not.toHaveProperty("city");
    if (fault.violation === "wrong-type") expect(value.city).toBe(12345);
    if (fault.violation === "extra-property") expect(value.__aimock_extra).toBe(true);
    if (fault.violation === "enum-mismatch") expect(value.city).toBe("__aimock_not_in_enum");
    if (fault.violation === "not-object") expect(typeof value).toBe("string");
  }
  if (fault.fault === "tool-unknown-name") expect(calls[0].name).toBe("weather_v2");
  if (fault.fault === "tool-call-id-duplicate") {
    expect(calls).toHaveLength(2);
    expect(calls[0].call_id).toBeTruthy();
    expect(calls[0].call_id).toBe(calls[1].call_id);
  }
  if (fault.fault === "stop-length-mid-tool") {
    expect(response).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ arguments: '{"city":', status: "incomplete" });
  }
  if (fault.fault === "empty-response")
    expect(response).toMatchObject({ status: "completed", output: [] });
  if (fault.fault === "refusal")
    expect(response.output).toEqual([
      expect.objectContaining({
        type: "message",
        content: [{ type: "refusal", refusal: "Cannot comply" }],
      }),
    ]);
  if (fault.fault === "content-filter")
    expect(response).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [],
    });
  if (fault.fault === "reasoning-only") {
    expect(response).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(response.output).toEqual([
      expect.objectContaining({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Considering options" }],
      }),
    ]);
  }
}

describe.each(shapes)("Responses WS $name", ({ name, response }) => {
  test.each(faults)("$fault $style $violation matches HTTP events and recovers", async (fault) => {
    await withFaultFixture(
      { faults: [fault] },
      async ({ mock, url }) => {
        mock.addFixture({ match: { userMessage: "next" }, response: { content: "Recovered" } });
        await withSocket(url, async (ws) => {
          const events = await exchange(ws, "weather", { stream: false });
          console.log(JSON.stringify({ shape: name, fault, events, entry: mock.getRequests()[0] }));
          const result = terminal(events);
          checkFault(result, fault);
          const calls = result.output.filter((item) => item.type === "function_call");
          expect(mock.getRequests()).toHaveLength(1);
          expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
            applied: true,
            fault: fault.fault,
            wire: "openai-responses",
            servedToolCalls: calls.map((call) => ({
              name: call.name,
              arguments: call.arguments,
              id: call.call_id,
            })),
          });
          if (fault.fault === "stop-length-mid-tool")
            expect(events.slice(-3)).toMatchObject([
              { type: "response.function_call_arguments.done", arguments: '{"city":' },
              { type: "response.output_item.done", item: { status: "incomplete" } },
              { type: "response.incomplete" },
            ]);
          if (fault.fault === "content-filter")
            expect(events.map((event) => event.type)).toEqual([
              "response.created",
              "response.in_progress",
              "response.incomplete",
            ]);
          if (fault.fault === "refusal")
            expect(events.some((event) => event.type === "response.refusal.delta")).toBe(true);
          if (fault.fault === "reasoning-only")
            expect(events.slice(-4).map((event) => event.type)).toEqual([
              "response.reasoning_summary_text.done",
              "response.reasoning_summary_part.done",
              "response.output_item.done",
              "response.incomplete",
            ]);
          expect(normalize(events)).toEqual(normalize(await httpEvents(url)));
          const recovered = terminal(await exchange(ws, "next"));
          expect(recovered).toMatchObject({
            status: "completed",
            output: [
              expect.objectContaining({
                type: "message",
                content: [expect.objectContaining({ text: "Recovered" })],
              }),
            ],
          });
          expect(mock.getRequests()).toHaveLength(3);
          expect(mock.getRequests()[2].response.misbehavior).toBeUndefined();
        });
      },
      { response },
    );
  });
});

test.each(["first", "middle", "last"])(
  "K4 selected %s generated ID is shared by events and metadata",
  async (target) => {
    await withFaultFixture(
      { faults: [{ fault: "tool-call-id-duplicate", tool: target }] },
      async ({ mock, url }) => {
        await withSocket(url, async (ws) => {
          const result = terminal(await exchange(ws));
          const calls = result.output.filter((item) => item.type === "function_call");
          const index = calls.findIndex((call) => call.name === target);
          expect(calls[index].call_id).toBe(calls[(index + 1) % 3].call_id);
          expect(result.output.map((item) => item.type)).toEqual([
            "function_call",
            "message",
            "function_call",
            "function_call",
          ]);
          expect(mock.getRequests()[0].response.misbehavior?.servedToolCalls).toEqual(
            calls.map((call) => ({ name: call.name, arguments: call.arguments, id: call.call_id })),
          );
        });
      },
      {
        response: {
          blocks: [
            { type: "toolCall", name: "first", arguments: { city: "Paris" } },
            { type: "text", text: "between" },
            { type: "toolCall", name: "middle", arguments: { city: "Rome" } },
            { type: "toolCall", name: "last", arguments: { city: "Oslo" } },
          ],
        },
      },
    );
  },
);

test("runtime query scope applies once, materializes once per turn, and next turn retains original usage", async () => {
  const mock = new LLMock({ port: 0, metrics: true });
  let calls = 0;
  const materialized = {
    toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }],
    usage: { input_tokens: 111, output_tokens: 222, total_tokens: 333 },
  };
  mock.addFixture({
    match: {},
    response: (request) => {
      calls++;
      expect(request.messages).toEqual([{ role: "user", content: "weather" }]);
      return materialized;
    },
  });
  try {
    const url = await mock.start();
    const installed = await fetch(`${url}/__aimock/misbehavior`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "query-ws" },
      body: JSON.stringify({ faults: [{ fault: "empty-response", times: 1 }] }),
    });
    expect(installed.status).toBe(200);
    await withSocket(
      url,
      async (ws) => {
        const first = terminal(await exchange(ws));
        expect(first.output).toEqual([]);
        // The accepted shared estimator uses a minimum of one token, even for empty output.
        expect(first.usage?.output_tokens).toBe(1);
        expect(first.usage?.input_tokens).not.toBe(111);
        const second = terminal(await exchange(ws));
        expect(second.output[0]).toMatchObject({
          type: "function_call",
          arguments: '{"city":"Paris"}',
        });
        expect(second.usage).toMatchObject({
          input_tokens: 111,
          output_tokens: 222,
          total_tokens: 333,
        });
        expect(calls).toBe(2);
        expect(materialized).toEqual({
          toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }],
          usage: { input_tokens: 111, output_tokens: 222, total_tokens: 333 },
        });
        expect(mock.getRequests()).toHaveLength(2);
        expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
          applied: true,
          source: "scope",
          ordinal: 0,
        });
        expect(mock.getRequests()[1].response.misbehavior).toMatchObject({
          applied: false,
          reason: "times-exhausted",
        });
        const metrics = await (await fetch(`${url}/metrics`)).text();
        expect(metrics).toMatch(/aimock_misbehavior_total\{[^\n]*outcome="applied"[^\n]*\} 1/);
        expect(metrics).toMatch(
          /aimock_misbehavior_total\{[^\n]*outcome="skipped:times-exhausted"[^\n]*\} 1/,
        );
      },
      "/v1/responses?testId=query-ws",
      { "X-Test-Id": "" },
    );
  } finally {
    await mock.stop();
  }
});

test.each([false, true])(
  "reasoning fault follows requested encrypted-reasoning flag include=%s",
  async (include) => {
    await withFaultFixture(
      { faults: [{ fault: "reasoning-only", reasoning: "Considering options" }] },
      async ({ url }) => {
        await withSocket(url, async (ws) => {
          const result = terminal(
            await exchange(
              ws,
              "weather",
              include ? { include: ["reasoning.encrypted_content"] } : {},
            ),
          );
          const item = result.output[0];
          expect(item.type).toBe("reasoning");
          if (include) expect(item).toHaveProperty("encrypted_content", expect.any(String));
          else expect(item).not.toHaveProperty("encrypted_content");
        });
      },
    );
  },
);

test("K5 named cut preserves preceding ordered blocks and drops every later output", async () => {
  await withFaultFixture(
    { faults: [{ fault: "stop-length-mid-tool", tool: "later", at: 0.3 }] },
    async ({ url }) => {
      await withSocket(url, async (ws) => {
        const result = terminal(await exchange(ws));
        expect(result.output.map((item) => item.type)).toEqual([
          "function_call",
          "message",
          "function_call",
        ]);
        expect(result.output[0]).toMatchObject({
          name: "weather",
          arguments: '{"city":"Paris"}',
          status: "completed",
        });
        expect(result.output[2]).toMatchObject({
          name: "later",
          arguments: '{"ci',
          status: "incomplete",
        });
        expect(result.incomplete_details?.reason).toBe("max_output_tokens");
      });
    },
    {
      response: {
        blocks: [
          { type: "toolCall", ...tool },
          { type: "text", text: "between" },
          { type: "toolCall", ...later },
          { type: "text", text: "must disappear" },
          { type: "toolCall", name: "dropped", arguments: {} },
        ],
      },
    },
  );
});

test("interrupted delivery keeps complete prepared metadata on the original journal entry", async () => {
  const mock = new LLMock({ port: 0 });
  mock.addFixture({
    match: {},
    response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
    misbehavior: "tool-args-invalid-json",
    truncateAfterChunks: 1,
  });
  try {
    const url = await mock.start();
    await withSocket(url, async (ws) => {
      ws.send(
        JSON.stringify({ type: "response.create", model: "gpt-4o", input: "weather", tools }),
      );
      await ws.waitForMessages(1);
      await Promise.race([
        ws.waitForClose(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("interruption did not close socket")),
            1000,
          );
          timer.unref();
        }),
      ]);
      expect(ws.getMessages()).toHaveLength(1);
      expect(mock.getRequests()).toHaveLength(1);
      const entry = mock.getRequests()[0];
      expect(entry.response).toMatchObject({
        status: 200,
        interrupted: true,
        interruptReason: "truncateAfterChunks",
        misbehavior: {
          applied: true,
          servedToolCalls: [{ name: "weather", arguments: '{"city":', id: expect.any(String) }],
        },
      });
    });
  } finally {
    await mock.stop();
  }
});

test("no-config control retains valid arguments and has no misbehavior summary", async () => {
  await withFaultFixture(undefined, async ({ mock, url }) => {
    await withSocket(url, async (ws) => {
      const result = terminal(await exchange(ws));
      expect(result.output[0]).toMatchObject({
        type: "function_call",
        arguments: '{"city":"Paris"}',
      });
      expect(mock.getRequests()[0].response.misbehavior).toBeUndefined();
    });
  });
});

describe("real WebSocket K4 recorded timing", () => {
  const timingShapes = [
    { name: "tool", response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] } },
    {
      name: "combined",
      response: {
        content: "Before",
        toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }],
      },
    },
    {
      name: "blocks",
      response: {
        blocks: [
          { type: "text" as const, text: "Before" },
          { type: "toolCall" as const, name: "weather", arguments: '{"city":"Paris"}' },
        ],
      },
    },
  ];

  async function measure(response: (typeof timingShapes)[number]["response"], applied: boolean) {
    const mock = new LLMock({ port: 0, chunkSize: 100 });
    const recordedTimings = { ttftMs: 0, interChunkDelaysMs: [300, 20], totalDurationMs: 320 };
    mock.addFixture({
      match: {},
      response,
      recordedTimings,
      ...(applied ? { misbehavior: "tool-call-id-duplicate" as const } : {}),
    });
    try {
      const url = await mock.start();
      await withSocket(url, async (ws) => {
        const times: number[] = [];
        const events: ResponseStreamEvent[] = [];
        ws.send(JSON.stringify({ type: "response.create", model: "gpt-4o", input: "weather" }));
        for (;;) {
          const messages = await ws.waitForMessages(events.length + 1);
          times.push(performance.now());
          const event: ResponseStreamEvent = JSON.parse(messages.at(-1)!);
          events.push(event);
          if (event.type === "error" || event.type === "response.completed") break;
        }
        const result = terminal(events);
        const calls = result.output.filter((item) => item.type === "function_call");
        expect(calls).toHaveLength(applied ? 2 : 1);
        const gaps = times.slice(1).map((time, index) => time - times[index]);
        const extraGaps = gaps.slice(recordedTimings.interChunkDelaysMs.length);
        expect(extraGaps.length).toBeGreaterThan(3);
        const sorted = [...extraGaps].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        console.log(
          "WS recorded timing",
          JSON.stringify({
            applied,
            response,
            recordedTimings,
            types: events.map((event) => event.type),
            gaps,
            extraMedianMs: median,
          }),
        );
        expect(recordedTimings.interChunkDelaysMs).toEqual([300, 20]);
        if (applied) {
          expect(calls[0].call_id).toBe(calls[1].call_id);
          expect(median).toBeGreaterThan(10);
          expect(median).toBeLessThan(80);
        } else {
          // Existing unfaulted delivery intentionally retains its average fallback.
          expect(median).toBeGreaterThan(100);
          expect(median).toBeLessThan(400);
        }
      });
    } finally {
      await mock.stop();
    }
  }

  test.each(timingShapes)(
    "$name extra K4 events reuse the last recorded gap",
    async ({ response }) => {
      await measure(response, true);
    },
    15000,
  );
  test("ordinary events preserve the existing average gap fallback", async () => {
    await measure(timingShapes[0].response, false);
  }, 15000);
});
