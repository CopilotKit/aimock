import CurrentOpenAI from "openai-current-sdk";
import { describe, expect, test } from "vitest";
import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses";
import { withFaultFixture } from "./helpers/misbehavior-server.js";
import type { FixtureFileResponse, MisbehaviorFault } from "../types.js";

const tool = { name: "weather", arguments: { city: "Paris" } };
const tools = [
  {
    type: "function" as const,
    strict: false,
    name: "weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string", enum: ["Paris"] } },
      required: ["city"],
      additionalProperties: false,
    },
  },
];
const shapes: { name: string; response: FixtureFileResponse }[] = [
  { name: "tool", response: { toolCalls: [tool] } },
  { name: "combined", response: { content: "First", toolCalls: [tool] } },
  {
    name: "blocks",
    response: {
      blocks: [
        { type: "toolCall", ...tool },
        { type: "text", text: "After" },
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
function check(response: Response, fault: MisbehaviorFault) {
  const calls = response.output.filter((item) => item.type === "function_call");
  if (fault.fault === "tool-args-invalid-json")
    expect(() => JSON.parse(calls[0].arguments)).toThrow();
  if (fault.fault === "tool-args-schema-violation") {
    const value = JSON.parse(calls[0].arguments);
    if (fault.violation === "missing-required") expect(value).not.toHaveProperty("city");
    if (fault.violation === "wrong-type") expect(typeof value.city).not.toBe("string");
    if (fault.violation === "extra-property") expect(value).toHaveProperty("__aimock_extra", true);
    if (fault.violation === "enum-mismatch") expect(value.city).not.toBe("Paris");
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
  if (fault.fault === "empty-response") {
    expect(response.status).toBe("completed");
    expect(response.output).toEqual([]);
  }
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
describe.each([false, true])("Responses actual SDK stream=%s", (stream) => {
  describe.each(shapes)("$name", ({ response }) => {
    test.each(faults)("$fault $style $violation", async (fault) => {
      await withFaultFixture(
        { faults: [fault] },
        async ({ client, mock }) => {
          let result: Response;
          const events: ResponseStreamEvent[] = [];
          if (stream) {
            for await (const event of await client.responses.create({
              model: "gpt-4o",
              input: "weather",
              tools,
              stream: true,
            }))
              events.push(event);
            const terminal = events.find(
              (event) =>
                event.type === "response.completed" || event.type === "response.incomplete",
            );
            if (
              !terminal ||
              (terminal.type !== "response.completed" && terminal.type !== "response.incomplete")
            )
              throw new Error("Missing terminal");
            result = terminal.response;
            if (fault.fault === "stop-length-mid-tool") {
              expect(events.slice(-3)).toMatchObject([
                { type: "response.function_call_arguments.done", arguments: '{"city":' },
                {
                  type: "response.output_item.done",
                  item: { type: "function_call", status: "incomplete" },
                },
                { type: "response.incomplete" },
              ]);
            }
            if (fault.fault === "reasoning-only") {
              expect(events.slice(-4).map((event) => event.type)).toEqual([
                "response.reasoning_summary_text.done",
                "response.reasoning_summary_part.done",
                "response.output_item.done",
                "response.incomplete",
              ]);
            }

            if (result.status === "incomplete")
              expect(events.some((event) => event.type === "response.completed")).toBe(false);
          } else
            result = await client.responses.create({ model: "gpt-4o", input: "weather", tools });
          console.log("S2 HTTP", JSON.stringify({ fault, stream, events, result }));
          check(result, fault);
          const calls = result.output
            .filter((item) => item.type === "function_call")
            .map((item) => ({ name: item.name, arguments: item.arguments, id: item.call_id }));
          expect(mock.getRequests()).toHaveLength(1);
          expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
            applied: true,
            servedToolCalls: calls,
          });
        },
        { response },
      );
    });
  });
});
test("Responses high-level finalResponse preserves incomplete K5 status", async () => {
  await withFaultFixture("stop-length-mid-tool", async ({ url }) => {
    const client = new CurrentOpenAI({
      apiKey: "local",
      baseURL: `${url}/v1`,
      maxRetries: 0,
      timeout: 5000,
    });
    const stream = client.responses.stream({ model: "gpt-4o", input: "weather" });
    const incompleteEvents: unknown[] = [];
    stream.on("response.incomplete", (event) => incompleteEvents.push(event));
    try {
      const result = await stream.finalResponse();
      console.log("S2 high-level SDK", JSON.stringify({ incompleteEvents, result }));
      expect(incompleteEvents).toHaveLength(1);
      expect(result.status).toBe("incomplete");
      expect(result.incomplete_details).toMatchObject({ reason: "max_output_tokens" });
    } catch (error) {
      console.log("S2 high-level SDK error", String(error), JSON.stringify(incompleteEvents));
      throw error;
    }
  });
});
test("no-config official SDK control retains valid arguments", async () => {
  await withFaultFixture(undefined, async ({ client }) => {
    const result = await client.responses.create({ model: "gpt-4o", input: "weather", tools });
    console.log("S2 no-fault control", JSON.stringify(result));
    expect(result.output.find((item) => item.type === "function_call")).toMatchObject({
      arguments: '{"city":"Paris"}',
    });
  });
});

test.each(["first", "middle", "last"])(
  "K4 shares generated ID from selected %s call in ordered blocks",
  async (target) => {
    await withFaultFixture(
      { faults: [{ fault: "tool-call-id-duplicate", tool: target }] },
      async ({ client, mock }) => {
        const result = await client.responses.create({ model: "gpt-4o", input: "weather" });
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

test("K5 drops blocks and calls after its nonfirst target", async () => {
  await withFaultFixture(
    { faults: [{ fault: "stop-length-mid-tool", tool: "middle" }] },
    async ({ client, mock }) => {
      const result = await client.responses.create({ model: "gpt-4o", input: "weather" });
      const calls = result.output.filter((item) => item.type === "function_call");
      expect(calls.map((call) => call.name)).toEqual(["first", "middle"]);
      expect(calls.map((call) => call.status)).toEqual(["completed", "incomplete"]);
      expect(result.output.map((item) => item.type)).toEqual([
        "function_call",
        "message",
        "function_call",
      ]);
      expect(mock.getRequests()[0].response.misbehavior?.servedToolCalls).toHaveLength(2);
    },
    {
      response: {
        blocks: [
          { type: "toolCall", name: "first", arguments: { city: "Paris" } },
          { type: "text", text: "between" },
          { type: "toolCall", name: "middle", arguments: { city: "Rome" } },
          { type: "text", text: "dropped" },
          { type: "toolCall", name: "last", arguments: { city: "Oslo" } },
        ],
      },
    },
  );
});

test.each([false, true])(
  "applied output ignores stored usage override while preserving envelope stream=%s",
  async (stream) => {
    const response = {
      ...shapes[0].response,
      id: "resp_fixed",
      created: 123,
      model: "fixture-model",
      usage: { input_tokens: 9000, output_tokens: 8000, total_tokens: 17000 },
    };
    await withFaultFixture(
      "tool-unknown-name",
      async ({ client, mock }) => {
        let result: Response | undefined;
        if (stream) {
          for await (const event of await client.responses.create({
            model: "gpt-4o",
            input: "weather",
            stream: true,
          })) {
            if (event.type === "response.completed") result = event.response;
          }
        } else result = await client.responses.create({ model: "gpt-4o", input: "weather" });
        expect(result).toMatchObject({
          id: "resp_fixed",
          created_at: 123,
          model: "fixture-model",
          usage: { input_tokens: 2, output_tokens: 7, total_tokens: 9 },
        });
        expect(mock.getFixtures()[0].response).toMatchObject({ usage: response.usage });
      },
      { response },
    );
    await withFaultFixture(
      undefined,
      async ({ client }) => {
        const result = await client.responses.create({ model: "gpt-4o", input: "weather" });
        expect(result.usage).toMatchObject(response.usage);
      },
      { response },
    );
  },
);

test("K9 empty authored reasoning still emits a reasoning item", async () => {
  await withFaultFixture(
    { faults: [{ fault: "reasoning-only", reasoning: "" }] },
    async ({ client }) => {
      const result = await client.responses.create({ model: "gpt-4o", input: "weather" });
      expect(result.output).toEqual([
        expect.objectContaining({
          type: "reasoning",
          summary: [{ type: "summary_text", text: "" }],
        }),
      ]);
      expect(result.status).toBe("incomplete");
    },
  );
});

test("official Responses strict tool parser exposes malformed JSON", async () => {
  await withFaultFixture("tool-args-invalid-json", async ({ client }) => {
    await expect(
      client.responses.parse({
        model: "gpt-4o",
        input: "weather",
        tools: tools.map((tool) => ({ ...tool, strict: true })),
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});

test("interrupted delivery retains the full prepared call metadata", async () => {
  await withFaultFixture("tool-call-id-duplicate", async ({ client, mock }) => {
    mock.getFixtures()[0].truncateAfterChunks = 1;
    await expect(
      (async () => {
        for await (const event of await client.responses.create({
          model: "gpt-4o",
          input: "weather",
          stream: true,
        }))
          console.log("interrupted event", event.type);
      })(),
    ).rejects.toThrow();
    expect(mock.getRequests()).toHaveLength(1);
    const journal = mock.getRequests()[0].response;
    expect(journal.interrupted).toBe(true);
    expect(journal.misbehavior?.applied).toBe(true);
    expect(journal.misbehavior?.servedToolCalls).toHaveLength(2);
    expect(journal.misbehavior?.servedToolCalls?.[0].id).toBe(
      journal.misbehavior?.servedToolCalls?.[1].id,
    );
  });
});

describe("recorded HTTP SSE timing", () => {
  test.each(shapes)(
    "K4 extra events use the last recorded gap: $name",
    async ({ name, response }) => {
      await withFaultFixture(
        "tool-call-id-duplicate",
        async ({ client, mock }) => {
          const timings = { ttftMs: 0, interChunkDelaysMs: [300, 20], totalDurationMs: 320 };
          mock.getFixtures()[0].recordedTimings = timings;
          const observed: number[] = [];
          for await (const event of await client.responses.create({
            model: "gpt-4o",
            input: "weather",
            stream: true,
          })) {
            observed.push(performance.now());
            expect(event.type).toMatch(/^response\./);
          }
          const extraGaps = observed.slice(3).map((time, index) => time - observed[index + 2]);
          const averageExtraGap = extraGaps.reduce((sum, gap) => sum + gap, 0) / extraGaps.length;
          console.log(
            "HTTP K4 real timing",
            JSON.stringify({ name, timings, extraGaps, averageExtraGap }),
          );
          expect(extraGaps.length).toBeGreaterThan(3);
          expect(averageExtraGap).toBeLessThan(80);
          expect(mock.getFixtures()[0].recordedTimings).toEqual(timings);
        },
        { response },
      );
    },
  );

  test("ordinary SSE keeps the existing average-gap fallback", async () => {
    await withFaultFixture(undefined, async ({ client, mock }) => {
      mock.getFixtures()[0].recordedTimings = {
        ttftMs: 0,
        interChunkDelaysMs: [300, 20],
        totalDurationMs: 320,
      };
      const observed: number[] = [];
      for await (const event of await client.responses.create({
        model: "gpt-4o",
        input: "weather",
        stream: true,
      })) {
        observed.push(performance.now());
        expect(event.type).toMatch(/^response\./);
      }
      const extraGaps = observed.slice(3).map((time, index) => time - observed[index + 2]);
      const averageExtraGap = extraGaps.reduce((sum, gap) => sum + gap, 0) / extraGaps.length;
      console.log("HTTP ordinary real timing", JSON.stringify({ extraGaps, averageExtraGap }));
      expect(averageExtraGap).toBeGreaterThan(100);
    });
  });
});
