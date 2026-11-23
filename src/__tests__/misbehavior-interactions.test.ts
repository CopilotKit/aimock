import { GoogleGenAI } from "@google/genai";
import { expect, test } from "vitest";
import { withFaultFixture } from "./helpers/misbehavior-server.js";
import type { FixtureFileResponse, MisbehaviorFault } from "../types.js";
import { LLMock } from "./helpers/misbehavior-enabled.js";

const calls = [{ name: "weather", arguments: { city: "Paris", unit: "C" } }];
const shapes: { shape: string; response: FixtureFileResponse }[] = [
  { shape: "tool", response: { toolCalls: calls } },
  { shape: "mixed", response: { content: "Before.", toolCalls: calls } },
  {
    shape: "blocks",
    response: {
      content: "ignored",
      toolCalls: [],
      blocks: [
        { type: "text", text: "Before." },
        { type: "toolCall", name: "weather", arguments: { city: "Paris", unit: "C" } },
        { type: "text", text: "After." },
      ],
    },
  },
];
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
async function runFault(
  fault: MisbehaviorFault | undefined,
  stream: boolean,
  response: FixtureFileResponse,
  verify: (result: {
    events: Record<string, unknown>[];
    body: Record<string, unknown>;
    raw: string;
    tools: { name: unknown; id: unknown; arguments: string }[];
    summary: unknown;
    status: unknown;
    usage: Record<string, unknown>;
  }) => void,
) {
  await withFaultFixture(
    fault ? { faults: [fault] } : undefined,
    async ({ url, mock }) => {
      const client = new GoogleGenAI({ apiKey: "local-proof", httpOptions: { baseUrl: url } });
      const request = {
        model: "gemini-2.5-flash",
        input: "weather",
        tools: [
          {
            type: "function" as const,
            name: "weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" }, unit: { type: "string", enum: ["C", "F"] } },
              required: ["city"],
              additionalProperties: false,
            },
          },
        ],
        stream,
      };
      const events: Record<string, unknown>[] = [];
      let body: Record<string, unknown> = {};
      let raw = "";
      let httpStatus: number | undefined;
      let error: unknown;
      try {
        const pending = client.interactions.create(request, { maxRetries: 0, timeout: 5000 });
        const http = await pending.asResponse();
        httpStatus = http.status;
        const rawBody = http.clone().text();
        if (stream) {
          // Use the official stream iterator as well as retaining its raw transport.
          const decoded = await pending;
          if (!(Symbol.asyncIterator in decoded)) throw new Error("SDK did not return a stream");
          for await (const event of decoded) events.push(object(event));
        } else body = object(await pending);
        raw = await rawBody;
      } catch (caught) {
        error = caught;
      }
      const journal = mock.getRequests();
      console.log(JSON.stringify({ fault, stream, httpStatus, raw, events, body, error, journal }));
      expect(error).toBeUndefined();
      expect(httpStatus).toBe(200);
      expect(journal).toHaveLength(1);
      const tools: { name: unknown; id: unknown; arguments: string }[] = [];
      if (stream) {
        for (const event of events) {
          if (event.event_type !== "step.start") continue;
          const step = object(event.step);
          if (step.type !== "function_call") continue;
          const args = events
            .filter((delta) => delta.event_type === "step.delta" && delta.index === event.index)
            .map((delta) => object(delta.delta))
            .filter((delta) => delta.type === "arguments_delta")
            .map((delta) => delta.arguments)
            .join("");
          tools.push({ name: step.name, id: step.id, arguments: args });
        }
      } else {
        expect(Array.isArray(body.steps)).toBe(true);
        if (Array.isArray(body.steps))
          for (const value of body.steps) {
            const step = object(value);
            if (step.type === "function_call")
              tools.push({
                name: step.name,
                id: step.id,
                arguments: JSON.stringify(step.arguments),
              });
          }
      }
      const terminal = stream ? object(events.at(-1)?.interaction) : body;
      const summary = journal[0].response.misbehavior;
      if (fault) {
        expect(summary).toMatchObject({
          applied: true,
          fault: fault.fault,
          servedToolCalls: tools,
        });
        expect(summary?.evaluations).toHaveLength(1);
      } else expect(summary).toBeUndefined();
      verify({
        events,
        body,
        raw,
        tools,
        summary,
        status: terminal.status,
        usage: object(terminal.usage),
      });
    },
    { response },
  );
}

const malformedStyles = ["truncated", "trailing-comma", "single-quotes"] as const;
test.each(shapes.flatMap((shape) => malformedStyles.map((style) => ({ ...shape, style }))))(
  "K1 $shape $style streams exact malformed arguments through official SDK",
  async ({ response, style }) => {
    await runFault(
      { fault: "tool-args-invalid-json", style },
      true,
      response,
      ({ tools, status }) => {
        const expected =
          style === "truncated"
            ? '{"city":"Pari'
            : style === "trailing-comma"
              ? '{"city":"Paris","unit":"C",}'
              : "{'city':'Paris','unit':'C'}";
        expect(tools[0].arguments).toBe(expected);
        expect(() => JSON.parse(tools[0].arguments)).toThrow();
        expect(status).toBe("requires_action");
      },
    );
  },
);
const modes = [false, true];
const violations = [
  "missing-required",
  "wrong-type",
  "extra-property",
  "enum-mismatch",
  "not-object",
] as const;
test.each(
  modes.flatMap((stream) =>
    violations
      .filter((violation) => stream || violation !== "not-object")
      .map((violation) => ({ stream, violation })),
  ),
)("K2 $violation stream=$stream", async ({ stream, violation }) => {
  await runFault(
    {
      fault: "tool-args-schema-violation",
      violation,
      ...(violation === "enum-mismatch" ? { property: "unit" } : {}),
    },
    stream,
    shapes[0].response,
    ({ tools }) => {
      const args: unknown = JSON.parse(tools[0].arguments);
      if (violation === "not-object") expect(typeof args).toBe("string");
      else if (violation === "missing-required") expect(object(args)).not.toHaveProperty("city");
      else if (violation === "wrong-type") expect(typeof object(args).city).not.toBe("string");
      else if (violation === "enum-mismatch") expect(["C", "F"]).not.toContain(object(args).unit);
      else expect(Object.keys(object(args)).length).toBeGreaterThan(2);
    },
  );
});
test.each(modes)("K3 unknown name stream=%s", async (stream) => {
  await runFault(
    { fault: "tool-unknown-name", name: "missing_tool" },
    stream,
    shapes[0].response,
    ({ tools }) => expect(tools[0].name).toBe("missing_tool"),
  );
});
test.each(shapes.flatMap((shape) => modes.map((stream) => ({ ...shape, stream }))))(
  "K4 generated shared IDs $shape stream=$stream",
  async ({ response, stream }) => {
    await runFault({ fault: "tool-call-id-duplicate" }, stream, response, ({ tools }) => {
      expect(tools).toHaveLength(2);
      expect(typeof tools[0].id).toBe("string");
      expect(tools[0].id).toBeTruthy();
      expect(tools[1].id).toBe(tools[0].id);
    });
  },
);
test.each(shapes.flatMap((shape) => modes.map((stream) => ({ ...shape, stream }))))(
  "K6 empty $shape stream=$stream",
  async ({ response, stream }) => {
    await runFault({ fault: "empty-response" }, stream, response, ({ tools, status, raw }) => {
      expect(tools).toHaveLength(0);
      expect(status).toBe("completed");
      expect(raw).not.toContain("Before.");
      expect(raw).not.toContain("After.");
    });
  },
);
test.each(shapes.flatMap((shape) => modes.map((stream) => ({ ...shape, stream }))))(
  "ordinary SDK control $shape stream=$stream",
  async ({ response, stream }) => {
    await runFault(undefined, stream, response, ({ tools, status }) => {
      expect(tools).toHaveLength(1);
      expect(JSON.parse(tools[0].arguments)).toEqual({ city: "Paris", unit: "C" });
      expect(status).toBe("requires_action");
    });
  },
);

test.each(modes)("K4 nonfirst authored ID shared stream=%s", async (stream) => {
  await runFault(
    { fault: "tool-call-id-duplicate", tool: "target" },
    stream,
    {
      toolCalls: [
        { name: "weather", id: "call_before", arguments: { city: "Paris" } },
        { name: "target", id: "call_target", arguments: { city: "London" } },
        { name: "later", id: "call_later", arguments: { city: "Tokyo" } },
      ],
    },
    ({ tools }) => {
      expect(tools.map((tool) => tool.id)).toEqual(["call_before", "call_target", "call_target"]);
    },
  );
});
test.each(modes)("applied usage ignores overrides stream=%s", async (stream) => {
  await runFault(
    { fault: "empty-response" },
    stream,
    {
      content: "fixture output",
      usage: { input_tokens: 9000, output_tokens: 8000, total_tokens: 17000 },
    },
    ({ usage }) => {
      expect(usage).toEqual({ total_input_tokens: 2, total_output_tokens: 1, total_tokens: 3 });
    },
  );
});
test.each(modes)("ordinary usage preserves overrides stream=%s", async (stream) => {
  await runFault(
    undefined,
    stream,
    {
      content: "fixture output",
      usage: { input_tokens: 9000, output_tokens: 8000, total_tokens: 17000 },
    },
    ({ usage }) => {
      expect(usage).toEqual({
        total_input_tokens: 9000,
        total_output_tokens: 8000,
        total_tokens: 17000,
      });
    },
  );
});

// K5 stream closure is an approved modeled contract, not a native capture.
// K5 object and K9 object/stream retain their independently accepted captures.
test.each(shapes.flatMap((shape) => modes.map((stream) => ({ ...shape, stream }))))(
  "K5 incomplete $shape stream=$stream",
  async ({ response, stream }) => {
    await runFault(
      { fault: "stop-length-mid-tool", at: 0.5 },
      stream,
      response,
      ({ tools, status, raw, events, usage }) => {
        expect(status).toBe("incomplete");
        expect(tools).toHaveLength(stream ? 1 : 0);
        if (stream) {
          expect(tools[0].arguments).toBe('{"city":"Pari');
          expect(() => JSON.parse(tools[0].arguments)).toThrow();
          const start = events.findIndex(
            (event) =>
              event.event_type === "step.start" && object(event.step).type === "function_call",
          );
          const toolEvents = events.slice(start);
          expect(toolEvents.map((event) => event.event_type)).toEqual([
            "step.start",
            "step.delta",
            "step.stop",
            "interaction.completed",
          ]);
          expect(toolEvents[1]).toMatchObject({
            index: toolEvents[0].index,
            delta: { type: "arguments_delta", arguments: tools[0].arguments },
          });
          expect(toolEvents[2].index).toBe(toolEvents[0].index);
          expect(raw.endsWith("\n\n")).toBe(true);
          expect(usage.total_input_tokens).toBe(2);
          expect(usage.total_output_tokens).toBeGreaterThan(0);
          expect(usage.total_tokens).toBe(2 + Number(usage.total_output_tokens));
        }
        expect(raw).not.toContain("After.");
      },
    );
  },
);
test.each(modes)("K9 reasoning only incomplete stream=%s", async (stream) => {
  await runFault(
    { fault: "reasoning-only", reasoning: "Considering options." },
    stream,
    shapes[1].response,
    ({ tools, status, raw, events, usage, body }) => {
      expect(status).toBe("incomplete");
      expect(tools).toHaveLength(0);
      expect(raw).toContain("Considering options.");
      expect(raw).not.toContain("Before.");
      expect(usage).toEqual({
        total_input_tokens: 2,
        total_output_tokens: 0,
        total_thought_tokens: 5,
        total_tokens: 7,
      });
      if (stream) {
        expect(events.map((event) => event.event_type)).toEqual([
          "interaction.created",
          "step.start",
          "step.delta",
          "step.stop",
          "interaction.completed",
        ]);
        expect(events[1]).toMatchObject({ index: 0, step: { type: "thought" } });
        expect(events[2]).toMatchObject({
          index: 0,
          delta: {
            type: "thought_summary",
            content: { type: "text", text: "Considering options." },
          },
        });
      } else {
        expect(body.steps).toEqual([
          {
            type: "thought",
            signature: "",
            summary: [{ type: "text", text: "Considering options." }],
          },
        ]);
        expect(body).not.toHaveProperty("output_text");
      }
    },
  );
});

test.each(shapes.flatMap((shape) => [false, true].map((interrupt) => ({ ...shape, interrupt }))))(
  "modeled K5 timing/interruption $shape interrupt=$interrupt",
  async ({ interrupt, shape }) => {
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixture({
      match: {},
      response:
        shape === "blocks"
          ? {
              content: "ignored",
              toolCalls: [],
              blocks: [
                { type: "text", text: "Before." },
                {
                  type: "toolCall",
                  name: "weather",
                  arguments: JSON.stringify({ city: "Paris", unit: "C" }),
                },
                { type: "text", text: "After." },
              ],
            }
          : {
              toolCalls: [
                {
                  name: "weather",
                  arguments: JSON.stringify({ city: "Paris", unit: "C" }),
                },
              ],
              ...(shape === "mixed" ? { content: "Before." } : {}),
            },
      misbehavior: { faults: [{ fault: "stop-length-mid-tool", at: 0.5 }] },
      streamingProfile: { ttft: 50, tps: 100 },
      chunkSize: 64,
      ...(interrupt ? { truncateAfterChunks: shape === "tool" ? 1 : 2 } : {}),
    });
    await mock.start();
    try {
      const client = new GoogleGenAI({ apiKey: "local-proof", httpOptions: { baseUrl: mock.url } });
      const events: Record<string, unknown>[] = [];
      let error: unknown;
      let firstEventMs: number | undefined;
      const started = Date.now();
      try {
        const stream = await client.interactions.create(
          {
            model: "gemini-2.5-flash",
            input: "weather",
            stream: true,
            tools: [
              {
                type: "function",
                name: "weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            ],
          },
          { maxRetries: 0, timeout: 5000 },
        );
        for await (const event of stream) {
          firstEventMs ??= Date.now() - started;
          events.push(object(event));
        }
      } catch (caught) {
        error = caught;
      }
      const journal = mock.getRequests();
      console.log(
        JSON.stringify({ interrupt, events, firstEventMs, error: String(error), journal }),
      );
      expect(journal).toHaveLength(1);
      expect(journal[0].response.misbehavior).toMatchObject({
        applied: true,
        fault: "stop-length-mid-tool",
      });
      expect(journal[0].response.misbehavior?.evaluations).toHaveLength(1);
      expect(firstEventMs).toBeGreaterThanOrEqual(35);
      if (interrupt) {
        // The SDK may end iteration cleanly on socket EOF; journal and missing
        // terminal distinguish interruption from successful fault completion.
        expect(events.some((event) => event.event_type === "interaction.completed")).toBe(false);
        expect(journal[0].response).toMatchObject({
          interrupted: true,
          interruptReason: "truncateAfterChunks",
        });
      } else {
        expect(error).toBeUndefined();
        expect(object(events.at(-1)?.interaction).status).toBe("incomplete");
        expect(journal[0].response.interrupted).toBeUndefined();
      }
    } finally {
      await mock.stop();
    }
  },
);

test("runtime times budget, factory once and immutable resolved response", async () => {
  const response = {
    content: "ordinary factory output",
    usage: { input_tokens: 9000, output_tokens: 8000 },
  };
  const snapshot = structuredClone(response);
  let factories = 0;
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.addFixture({
    match: {},
    response: () => {
      factories++;
      return response;
    },
  });
  await mock.start();
  try {
    const headers = { "X-Test-Id": "interactions-runtime" };
    expect(
      (
        await fetch(`${mock.url}/__aimock/misbehavior`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ faults: [{ fault: "empty-response", times: 1 }] }),
        })
      ).status,
    ).toBe(200);
    const client = new GoogleGenAI({ apiKey: "local-proof", httpOptions: { baseUrl: mock.url } });
    const outputs: unknown[] = [];
    for (let turn = 0; turn < 2; turn++)
      outputs.push(
        await client.interactions.create(
          { model: "gemini-2.5-flash", input: "weather", stream: false },
          { maxRetries: 0, timeout: 5000, headers },
        ),
      );
    const journal = mock.getRequests();
    console.log(JSON.stringify({ outputs, journal, factories, response }));
    expect(outputs.map((value) => object(value).output_text)).toEqual([
      "",
      "ordinary factory output",
    ]);
    expect(journal).toHaveLength(2);
    expect(journal[0].response.misbehavior).toMatchObject({
      source: "scope",
      applied: true,
      ordinal: 0,
      servedToolCalls: [],
    });
    expect(journal[1].response.misbehavior).toMatchObject({
      source: "scope",
      applied: false,
      reason: "times-exhausted",
    });
    expect(factories).toBe(2);
    expect(response).toEqual(snapshot);
  } finally {
    await mock.stop();
  }
});
