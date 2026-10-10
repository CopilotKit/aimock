import type { ServerInstance } from "../server.js";
import type { Fixture, MisbehaviorConfig } from "../types.js";
import OpenAI from "openai";
import { LengthFinishReasonError, ContentFilterFinishReasonError } from "openai/error";
import { expect, test, vi } from "vitest";
import {
  prepareOpenAIChatMisbehavior,
  resolveOpenAIChatMisbehaviorUsage,
  extractOverrides,
  buildToolCallCompletion,
  buildOpenAIRefusalChunks,
  buildOpenAIReasoningChunks,
  buildOpenAIReasoningCompletion,
  buildOpenAIContentFilterChunks,
  buildOpenAIContentFilterCompletion,
  buildOpenAIRefusalCompletion,
  buildContentWithToolCallsChunks,
  buildContentWithToolCallsCompletion,
  buildUsageChunk,
  isContentWithToolCallsResponse,
  requireFunctionToolCalls,
  resolveFixtureBlocks,
} from "../helpers.js";
import {
  prepareDuplicateIdCandidate,
  prepareLengthCandidate,
  prepareRefusalCandidate,
  prepareContentFilterCandidate,
  prepareReasoningOnlyCandidate,
  type MisbehaviorPlan,
} from "../misbehavior.js";
import type { FixtureResponse, ChatCompletionRequest } from "../types.js";
import { withFaultFixture } from "./helpers/misbehavior-server.js";
import { LLMock, createServer } from "./helpers/misbehavior-enabled.js";

const cases = [
  { cell: "control", fault: undefined },
  { cell: "K1", fault: "tool-args-invalid-json" },
  { cell: "K3", fault: "tool-unknown-name" },
  { cell: "K6", fault: "empty-response" },
] as const;

const request = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "weather" }],
  tools: [
    {
      type: "function",
      function: {
        name: "weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ],
} satisfies OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

type ObservedCall = { id: string; name: string; arguments: string };

function assertOutput(
  fault: (typeof cases)[number]["fault"],
  calls: ObservedCall[],
  content: string | null,
  finish: string | null,
) {
  if (fault === "empty-response") {
    expect(calls).toEqual([]);
    expect(content ?? "").toBe("");
    expect(finish).toBe("stop");
    return;
  }
  expect(calls).toHaveLength(1);
  expect(calls[0].id).toBe("call_weather");
  expect(calls[0].name).toBe(fault === "tool-unknown-name" ? "weather_v2" : "weather");
  expect(content ?? "").toBe("");
  expect(finish).toBe("tool_calls");
  if (fault === "tool-args-invalid-json") {
    expect(calls[0].arguments).toBe('{"city":');
    expect(() => JSON.parse(calls[0].arguments)).toThrow(SyntaxError);
  } else {
    expect(calls[0].arguments).toBe('{"city":"Paris"}');
  }
}

test.each(cases)("real OpenAI $cell nonstream", async ({ cell, fault }) => {
  await withFaultFixture(fault, async ({ client, mock }) => {
    const { data, response } = await client.chat.completions.create(request).withResponse();
    console.log(JSON.stringify({ cell, mode: "nonstream", status: response.status, data }));
    expect(response.status).toBe(200);
    expect(mock.getRequests()).toHaveLength(1);
    expect(data.choices).toHaveLength(1);
    const choice = data.choices[0];
    expect(choice.message.role).toBe("assistant");
    const calls = (choice.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    }));
    assertOutput(fault, calls, choice.message.content, choice.finish_reason);
  });
});

test.each(cases)("real OpenAI $cell stream", async ({ cell, fault }) => {
  await withFaultFixture(fault, async ({ client, mock }) => {
    const { data, response } = await client.chat.completions
      .create({ ...request, stream: true })
      .withResponse();
    const rawBody = response.clone().text();
    const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
    const calls: ObservedCall[] = [];
    let content = "";
    for await (const chunk of data) {
      chunks.push(chunk);
      for (const choice of chunk.choices) {
        content += choice.delta.content ?? "";
        for (const delta of choice.delta.tool_calls ?? []) {
          const call = (calls[delta.index] ??= { id: "", name: "", arguments: "" });
          call.id += delta.id ?? "";
          call.name += delta.function?.name ?? "";
          call.arguments += delta.function?.arguments ?? "";
        }
      }
    }
    const wire = await rawBody;
    console.log(JSON.stringify({ cell, mode: "stream", status: response.status, wire, calls }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(mock.getRequests()).toHaveLength(1);
    const frames = wire.trim().split(/\r?\n\r?\n/);
    expect(frames.at(-1)).toBe("data: [DONE]");
    expect(frames.filter((frame) => frame === "data: [DONE]")).toHaveLength(1);
    expect(frames.slice(0, -1).map((frame) => JSON.parse(frame.slice(6)))).toEqual(chunks);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    const terminal = chunks
      .flatMap((chunk) => chunk.choices)
      .filter((choice) => choice.finish_reason);
    expect(terminal).toHaveLength(1);
    expect(chunks.at(-1)?.choices[0]).toEqual(terminal[0]);
    expect(terminal[0].delta).toEqual({});
    assertOutput(fault, calls, content, terminal[0].finish_reason);
  });
});

// Five K2 variants plus E5a normalization; these are six coverage cells, not six variants.
const schemaCases = [
  {
    cell: "missing-required",
    violation: "missing-required",
    schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    expected: {},
  },
  {
    cell: "wrong-type",
    violation: "wrong-type",
    schema: { type: "object", properties: { city: { type: "string" } } },
    expected: { city: 12345 },
  },
  {
    cell: "extra-property",
    violation: "extra-property",
    schema: {
      type: "object",
      properties: { city: { type: "string" } },
      additionalProperties: false,
    },
    expected: { city: "Paris", __aimock_extra: true },
  },
  {
    cell: "enum-mismatch",
    violation: "enum-mismatch",
    schema: {
      type: "object",
      properties: { city: { enum: ["Paris", "__aimock_not_in_enum", "__aimock_not_in_enum_2"] } },
    },
    expected: { city: "__aimock_not_in_enum_3" },
  },
  {
    cell: "not-object",
    violation: "not-object",
    schema: { type: "object", properties: { city: { type: "string" } } },
    expected: '{"city":"Paris"}',
  },
  {
    cell: "normalization-uppercase-union",
    violation: "wrong-type",
    schema: { type: "OBJECT", properties: { city: { type: ["STRING", "NUMBER"] } } },
    expected: { city: {} },
  },
];

type ToolSchema = NonNullable<OpenAI.Chat.Completions.ChatCompletionTool["function"]["parameters"]>;

function schemaRequest(schema: ToolSchema | undefined) {
  return {
    ...request,
    tools: [
      {
        type: "function",
        function: { name: "weather", ...(schema ? { parameters: schema } : {}) },
      },
    ],
  } satisfies OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}

async function readSchemaOutput(
  client: OpenAI,
  schema: ToolSchema | undefined,
  stream: boolean,
  headers?: { "X-AIMock-Misbehavior": string },
) {
  if (!stream) {
    const { data, response } = await client.chat.completions
      .create(schemaRequest(schema), { headers })
      .withResponse();
    console.log(JSON.stringify({ status: response.status, data }));
    expect(response.status).toBe(200);
    expect(data.choices).toHaveLength(1);
    const choice = data.choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.tool_calls).toHaveLength(1);
    const call = choice.message.tool_calls?.[0];
    if (!call) throw new Error("Missing schema-test tool call");
    expect(call.id).toBe("call_weather");
    expect(call.function.name).toBe("weather");
    return call.function.arguments;
  }
  const { data, response } = await client.chat.completions
    .create({ ...schemaRequest(schema), stream: true }, { headers })
    .withResponse();
  const raw = response.clone().text();
  const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
  let args = "";
  let name = "";
  let id = "";
  for await (const chunk of data) {
    chunks.push(chunk);
    for (const choice of chunk.choices) {
      for (const call of choice.delta.tool_calls ?? []) {
        expect(call.index).toBe(0);
        args += call.function?.arguments ?? "";
        name += call.function?.name ?? "";
        id += call.id ?? "";
      }
    }
  }
  const wire = await raw;
  console.log(JSON.stringify({ status: response.status, wire }));
  expect(response.status).toBe(200);
  expect(id).toBe("call_weather");
  expect(name).toBe("weather");
  const frames = wire.trim().split(/\r?\n\r?\n/);
  expect(frames.at(-1)).toBe("data: [DONE]");
  expect(frames.filter((frame) => frame === "data: [DONE]")).toHaveLength(1);
  expect(frames.slice(0, -1).map((frame) => JSON.parse(frame.slice(6)))).toEqual(chunks);
  expect(chunks[0].choices[0].delta.role).toBe("assistant");
  const terminals = chunks
    .flatMap((chunk) => chunk.choices)
    .filter((choice) => choice.finish_reason);
  expect(terminals).toHaveLength(1);
  expect(terminals[0]).toEqual({
    index: 0,
    delta: {},
    logprobs: null,
    finish_reason: "tool_calls",
  });
  expect(chunks.at(-1)?.choices[0]).toEqual(terminals[0]);
  return args;
}

for (const stream of [false, true]) {
  test.each(schemaCases)(
    `real OpenAI K2 $cell stream=${stream}`,
    async ({ violation, schema, expected }) => {
      await withFaultFixture(
        { faults: [{ fault: "tool-args-schema-violation", violation }] },
        async ({ client, mock }) => {
          const args = await readSchemaOutput(client, schema, stream);
          expect(mock.getRequests()).toHaveLength(1);
          expect(JSON.parse(args)).toEqual(expected);
        },
      );
    },
  );
  test.each(schemaCases)(`real OpenAI K2 control $cell stream=${stream}`, async ({ schema }) => {
    await withFaultFixture(undefined, async ({ client }) => {
      expect(await readSchemaOutput(client, schema, stream)).toBe('{"city":"Paris"}');
    });
  });
}

const inapplicableSchemaCases = [
  {
    cell: "missing-required-optional-property",
    violation: "missing-required",
    schema: { type: "object", properties: { city: { type: "string" } } },
    property: "city",
  },
  {
    cell: "wrong-type-unresolved-ref",
    violation: "wrong-type",
    schema: {
      type: "object",
      properties: { city: { $ref: "#/$defs/city" } },
      $defs: { city: { type: "string" } },
    },
  },
  {
    cell: "wrong-type-all-candidates-accepted",
    violation: "wrong-type",
    schema: {
      type: "object",
      properties: { city: { type: ["string", "number", "boolean", "array", "object", "null"] } },
    },
  },
  {
    cell: "extra-property-permissive",
    violation: "extra-property",
    schema: { type: "object", properties: { city: { type: "string" } } },
  },
  {
    cell: "extra-property-name-collision",
    violation: "extra-property",
    schema: {
      type: "object",
      properties: { city: { type: "string" } },
      additionalProperties: false,
    },
    property: "city",
  },
  {
    cell: "extra-property-pattern-admits",
    violation: "extra-property",
    schema: {
      type: "object",
      properties: { city: { type: "string" } },
      additionalProperties: false,
      patternProperties: { "^__aimock_": { type: "boolean" } },
    },
  },
  {
    cell: "enum-mismatch-no-enum",
    violation: "enum-mismatch",
    schema: { type: "object", properties: { city: { type: "string" } } },
  },
  { cell: "not-object-array", violation: "not-object", schema: undefined, arguments: '["Paris"]' },
  { cell: "not-object-null", violation: "not-object", schema: undefined, arguments: "null" },
  {
    cell: "not-object-primitive",
    violation: "not-object",
    schema: undefined,
    arguments: '"Paris"',
  },
];

for (const stream of [false, true]) {
  test.each(inapplicableSchemaCases)(
    `real OpenAI K2 applicability $cell stream=${stream}`,
    async ({ violation, schema, property, arguments: args }) => {
      await withFaultFixture(
        undefined,
        async ({ client, mock }) => {
          const header = `tool-args-schema-violation; violation=${violation}${property ? `; property=${property}` : ""}`;
          const outcome = await readSchemaOutput(client, schema, stream, {
            "X-AIMock-Misbehavior": header,
          }).then(
            (argumentsValue) => ({ kind: "success", arguments: argumentsValue }),
            (error: unknown) => ({ kind: "error", error }),
          );
          console.log(JSON.stringify({ violation, schema, outcome }));
          expect(mock.getRequests()).toHaveLength(1);
          expect(outcome).toMatchObject({
            kind: "error",
            error: { status: 501, code: "aimock_misbehavior_not_applicable" },
          });
        },
        { arguments: args },
      );
    },
  );
}

async function readToolOutput(client: OpenAI, stream: boolean, header?: string) {
  const options = header ? { headers: { "X-AIMock-Misbehavior": header } } : undefined;
  if (!stream) {
    const { data, response } = await client.chat.completions
      .create(request, options)
      .withResponse();
    console.log(JSON.stringify({ status: response.status, data }));
    expect(response.status).toBe(200);
    expect(data.choices).toHaveLength(1);
    const choice = data.choices[0];
    expect(choice.message.role).toBe("assistant");
    return {
      content: choice.message.content ?? "",
      finish: choice.finish_reason,
      calls: (choice.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    };
  }
  const { data, response } = await client.chat.completions
    .create({ ...request, stream: true }, options)
    .withResponse();
  const raw = response.clone().text();
  const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
  const calls: ObservedCall[] = [];
  let content = "";
  for await (const chunk of data) {
    chunks.push(chunk);
    for (const choice of chunk.choices) {
      content += choice.delta.content ?? "";
      for (const delta of choice.delta.tool_calls ?? []) {
        const call = (calls[delta.index] ??= { id: "", name: "", arguments: "" });
        call.id += delta.id ?? "";
        call.name += delta.function?.name ?? "";
        call.arguments += delta.function?.arguments ?? "";
      }
    }
  }
  const wire = await raw;
  console.log(JSON.stringify({ status: response.status, wire, calls }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const frames = wire.trim().split(/\r?\n\r?\n/);
  expect(frames.at(-1)).toBe("data: [DONE]");
  expect(frames.filter((frame) => frame === "data: [DONE]")).toHaveLength(1);
  expect(frames.slice(0, -1).map((frame) => JSON.parse(frame.slice(6)))).toEqual(chunks);
  expect(chunks[0].choices[0].delta.role).toBe("assistant");
  const terminals = chunks
    .flatMap((chunk) => chunk.choices)
    .filter((choice) => choice.finish_reason);
  expect(terminals).toHaveLength(1);
  expect(terminals[0].delta).toEqual({});
  expect(chunks.at(-1)?.choices[0]).toEqual(terminals[0]);
  return { content, finish: terminals[0].finish_reason, calls };
}

const weatherCall = { id: "call_weather", name: "weather", arguments: '{"city":"Paris"}' };
const backupCall = { id: "call_backup", name: "backup", arguments: '{"city":"Rome"}' };
const lastCall = { id: "call_last", name: "last", arguments: '{"city":"Oslo"}' };
const idlessCall = { name: "weather", arguments: '{"city":"Paris"}' };
const duplicateCases = [
  { cell: "first-to-next", calls: [weatherCall, backupCall], source: 0, destination: 1 },
  {
    cell: "named-middle-to-next",
    calls: [weatherCall, backupCall, lastCall],
    tool: "backup",
    source: 1,
    destination: 2,
  },
  {
    cell: "named-last-wraps",
    calls: [weatherCall, backupCall, lastCall],
    tool: "last",
    source: 2,
    destination: 0,
  },
  {
    cell: "first-repeated-name",
    calls: [weatherCall, { ...backupCall, name: "weather" }, lastCall],
    tool: "weather",
    source: 0,
    destination: 1,
  },
  { cell: "lone-clone", calls: [weatherCall], source: 0, destination: 1 },
  { cell: "idless-pair", calls: [idlessCall, backupCall], source: 0, destination: 1 },
  { cell: "idless-lone-clone", calls: [idlessCall], source: 0, destination: 1 },
];

function assertUnchangedCalls(actual: ObservedCall[], authored: (typeof idlessCall)[]) {
  expect(actual).toHaveLength(authored.length);
  for (const [index, call] of actual.entries()) {
    expect(call).toMatchObject(authored[index]);
    expect(call.id).toEqual(expect.any(String));
    expect(call.id.length).toBeGreaterThan(0);
  }
}

for (const stream of [false, true]) {
  test.each(duplicateCases)(
    `real OpenAI K4 $cell stream=${stream}`,
    async ({ calls, tool, source, destination }) => {
      await withFaultFixture(
        { faults: [{ fault: "tool-call-id-duplicate", ...(tool ? { tool } : {}) }] },
        async ({ client, mock }) => {
          const output = await readToolOutput(client, stream);
          expect(mock.getRequests()).toHaveLength(1);
          expect(output.finish).toBe("tool_calls");
          expect(output.content).toBe("");
          const expectedCalls = calls.length === 1 ? [calls[0], calls[0]] : calls;
          expect(
            output.calls.map(({ name, arguments: args }) => ({ name, arguments: args })),
          ).toEqual(expectedCalls.map(({ name, arguments: args }) => ({ name, arguments: args })));
          expect(output.calls[source].id.length).toBeGreaterThan(0);
          expect(output.calls[destination].id).toBe(output.calls[source].id);
          for (const [index, authored] of calls.entries()) {
            if (index !== destination && "id" in authored)
              expect(output.calls[index].id).toBe(authored.id);
          }
        },
        { response: { toolCalls: calls } },
      );
    },
  );
  test.each(duplicateCases)(`real OpenAI K4 control $cell stream=${stream}`, async ({ calls }) => {
    await withFaultFixture(
      undefined,
      async ({ client }) => {
        const output = await readToolOutput(client, stream);
        expect(output.finish).toBe("tool_calls");
        assertUnchangedCalls(output.calls, calls);
        expect(new Set(output.calls.map((call) => call.id)).size).toBe(calls.length);
      },
      { response: { toolCalls: calls } },
    );
  });
}

const lengthCases = [
  { cell: "default-half", calls: [weatherCall], content: "", target: 0, prefix: '{"city":' },
  {
    cell: "quarter-middle-keeps-prefix-drops-later",
    calls: [backupCall, weatherCall, lastCall],
    content: "Checking weather.",
    tool: "weather",
    at: 0.25,
    target: 1,
    prefix: '{"ci',
  },
];

for (const stream of [false, true]) {
  test.each(lengthCases)(
    `real OpenAI K5 $cell stream=${stream}`,
    async ({ calls, content, tool, at, target, prefix }) => {
      const fault = {
        fault: "stop-length-mid-tool",
        ...(tool ? { tool } : {}),
        ...(at ? { at } : {}),
      };
      await withFaultFixture(
        { faults: [fault] },
        async ({ client, mock }) => {
          const output = await readToolOutput(client, stream);
          console.log(JSON.stringify({ cell: "K5", expectedPrefix: prefix, output }));
          expect(mock.getRequests()).toHaveLength(1);
          expect.soft(output.finish).toBe("length");
          expect.soft(output.calls).toHaveLength(target + 1);
          expect(output.content).toBe(content);
          expect(output.calls.slice(0, target)).toEqual(calls.slice(0, target));
          expect(output.calls[target]).toEqual({ ...calls[target], arguments: prefix });
          expect(prefix.length).toBeGreaterThan(0);
          expect(prefix.length).toBeLessThan(calls[target].arguments.length);
          expect(calls[target].arguments.startsWith(output.calls[target].arguments)).toBe(true);
          expect(() => JSON.parse(output.calls[target].arguments)).toThrow(SyntaxError);
        },
        { response: { content, toolCalls: calls } },
      );
    },
  );
  test.each(lengthCases)(
    `real OpenAI K5 control $cell stream=${stream}`,
    async ({ calls, content }) => {
      await withFaultFixture(
        undefined,
        async ({ client }) => {
          const output = await readToolOutput(client, stream);
          expect(output.finish).toBe("tool_calls");
          expect(output.content).toBe(content);
          assertUnchangedCalls(output.calls, calls);
        },
        { response: { content, toolCalls: calls } },
      );
    },
  );
}

const toolApplicabilityCases = [
  {
    cell: "K4 missing-target",
    header: "tool-call-id-duplicate; tool=absent",
    response: { toolCalls: [weatherCall] },
  },
  {
    cell: "K4 text-only",
    header: "tool-call-id-duplicate",
    response: { content: "No tool needed." },
  },
  {
    cell: "K5 missing-target",
    header: "stop-length-mid-tool; tool=absent",
    response: { toolCalls: [weatherCall] },
  },
  {
    cell: "K5 text-only",
    header: "stop-length-mid-tool",
    response: { content: "No tool needed." },
  },
  {
    cell: "K5 one-character-no-proper-prefix",
    header: "stop-length-mid-tool",
    response: { toolCalls: [{ ...weatherCall, arguments: "1" }] },
  },
];
for (const stream of [false, true]) {
  test.each(toolApplicabilityCases)(
    `real OpenAI $cell applicability stream=${stream}`,
    async ({ header, response }) => {
      await withFaultFixture(
        undefined,
        async ({ client, mock }) => {
          const outcome = await readToolOutput(client, stream, header).then(
            (output) => ({ kind: "success", output }),
            (error: unknown) => ({ kind: "error", error }),
          );
          console.log(JSON.stringify({ header, outcome }));
          expect(mock.getRequests()).toHaveLength(1);
          expect(outcome).toMatchObject({
            kind: "error",
            error: { status: 501, code: "aimock_misbehavior_not_applicable" },
          });
        },
        { response },
      );
    },
  );
  test.each(toolApplicabilityCases)(
    `real OpenAI $cell applicability control stream=${stream}`,
    async ({ response }) => {
      await withFaultFixture(
        undefined,
        async ({ client }) => {
          const output = await readToolOutput(client, stream);
          expect(output.finish).toBe(response.toolCalls ? "tool_calls" : "stop");
          expect(output.content).toBe(response.content ?? "");
          expect(output.calls).toEqual(response.toolCalls ?? []);
        },
        { response },
      );
    },
  );
}

function exposedReasoning(value: object) {
  if (!("reasoning_content" in value)) return "";
  expect(typeof value.reasoning_content).toBe("string");
  return typeof value.reasoning_content === "string" ? value.reasoning_content : "";
}

async function readReplacementOutput(client: OpenAI, stream: boolean) {
  if (!stream) {
    const { data, response } = await client.chat.completions.create(request).withResponse();
    console.log(JSON.stringify({ status: response.status, data }));
    expect(response.status).toBe(200);
    expect(data.choices).toHaveLength(1);
    const choice = data.choices[0];
    expect(choice.message.role).toBe("assistant");
    return {
      content: choice.message.content,
      refusal: choice.message.refusal ?? "",
      reasoning: exposedReasoning(choice.message),
      calls: (choice.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      finish: choice.finish_reason,
    };
  }
  const { data, response } = await client.chat.completions
    .create({ ...request, stream: true })
    .withResponse();
  const raw = response.clone().text();
  const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
  const calls: ObservedCall[] = [];
  let content: string | null = null;
  let refusal = "";
  let reasoning = "";
  for await (const chunk of data) {
    chunks.push(chunk);
    for (const choice of chunk.choices) {
      if (typeof choice.delta.content === "string")
        content = (content ?? "") + choice.delta.content;
      refusal += choice.delta.refusal ?? "";
      reasoning += exposedReasoning(choice.delta);
      for (const delta of choice.delta.tool_calls ?? []) {
        const call = (calls[delta.index] ??= { id: "", name: "", arguments: "" });
        call.id += delta.id ?? "";
        call.name += delta.function?.name ?? "";
        call.arguments += delta.function?.arguments ?? "";
      }
    }
  }
  const wire = await raw;
  console.log(
    JSON.stringify({ status: response.status, wire, content, refusal, reasoning, calls }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const frames = wire.trim().split(/\r?\n\r?\n/);
  expect(frames.at(-1)).toBe("data: [DONE]");
  expect(frames.filter((frame) => frame === "data: [DONE]")).toHaveLength(1);
  expect(frames.slice(0, -1).map((frame) => JSON.parse(frame.slice(6)))).toEqual(chunks);
  expect(chunks[0].choices[0].delta.role).toBe("assistant");
  const terminals = chunks
    .flatMap((chunk) => chunk.choices)
    .filter((choice) => choice.finish_reason);
  expect(terminals).toHaveLength(1);
  expect(terminals[0].delta).toEqual({});
  expect(chunks.at(-1)?.choices[0]).toEqual(terminals[0]);
  return { content, refusal, reasoning, calls, finish: terminals[0].finish_reason };
}

const replacementCases = [
  {
    cell: "K7 default-refusal",
    fault: { fault: "refusal" },
    sourceReasoning: "Original reasoning.",
    expectedRefusal: "I can't help with that.",
    expectedReasoning: "",
    finish: "stop",
  },
  {
    cell: "K7 explicit-refusal",
    fault: { fault: "refusal", message: "Request refused." },
    sourceReasoning: "Original reasoning.",
    expectedRefusal: "Request refused.",
    expectedReasoning: "",
    finish: "stop",
  },
  {
    cell: "K8 content-filter",
    fault: { fault: "content-filter" },
    sourceReasoning: "Original reasoning.",
    expectedRefusal: "",
    expectedReasoning: "",
    finish: "content_filter",
  },
  {
    cell: "K9 explicit-reasoning",
    fault: { fault: "reasoning-only", reasoning: "Replacement reasoning." },
    sourceReasoning: "Original reasoning.",
    expectedRefusal: "",
    expectedReasoning: "",
    finish: "length",
  },
  {
    cell: "K9 fixture-reasoning",
    fault: { fault: "reasoning-only" },
    sourceReasoning: "Original reasoning.",
    expectedRefusal: "",
    expectedReasoning: "",
    finish: "length",
  },
  {
    cell: "K9 fallback-reasoning",
    fault: { fault: "reasoning-only" },
    sourceReasoning: undefined,
    expectedRefusal: "",
    expectedReasoning: "",
    finish: "length",
  },
];

function assertReplacement(
  output: Awaited<ReturnType<typeof readReplacementOutput>>,
  expected: (typeof replacementCases)[number],
) {
  expect.soft(output.content).toBeNull();
  expect.soft(output.calls).toEqual([]);
  expect.soft(output.refusal).toBe(expected.expectedRefusal);
  expect.soft(output.reasoning).toBe(expected.expectedReasoning);
  expect(output.finish).toBe(expected.finish);
}

for (const stream of [false, true]) {
  test.each(replacementCases)(`real OpenAI $cell stream=${stream}`, async (entry) => {
    await withFaultFixture(
      { faults: [entry.fault] },
      async ({ client, mock }) => {
        const output = await readReplacementOutput(client, stream);
        expect(mock.getRequests()).toHaveLength(1);
        assertReplacement(output, entry);
      },
      {
        response: {
          content: "Original answer.",
          toolCalls: [weatherCall],
          reasoning: entry.sourceReasoning,
        },
      },
    );
  });
  test.each(replacementCases)(`real OpenAI $cell control stream=${stream}`, async (entry) => {
    await withFaultFixture(
      undefined,
      async ({ client }) => {
        const output = await readReplacementOutput(client, stream);
        expect(output).toEqual({
          content: "Original answer.",
          calls: [weatherCall],
          refusal: "",
          reasoning: entry.sourceReasoning ?? "",
          finish: "tool_calls",
        });
      },
      {
        response: {
          content: "Original answer.",
          toolCalls: [weatherCall],
          reasoning: entry.sourceReasoning,
        },
      },
    );
  });
}

const authoritativeReplacementCases = [
  replacementCases[0],
  replacementCases[2],
  replacementCases[3],
];
const authoritativeResponse = {
  content: "Stale legacy content.",
  toolCalls: [backupCall],
  reasoning: "Original reasoning.",
  blocks: [
    { type: "text" as const, text: "Authoritative answer." },
    { type: "toolCall" as const, ...weatherCall },
  ],
};
for (const stream of [false, true]) {
  test.each(authoritativeReplacementCases)(
    `real OpenAI $cell clears authoritative blocks stream=${stream}`,
    async (entry) => {
      await withFaultFixture(
        { faults: [entry.fault] },
        async ({ client }) => {
          assertReplacement(await readReplacementOutput(client, stream), entry);
        },
        { response: authoritativeResponse },
      );
    },
  );
  test.each(authoritativeReplacementCases)(
    `real OpenAI $cell authoritative control stream=${stream}`,
    async () => {
      await withFaultFixture(
        undefined,
        async ({ client }) => {
          const output = await readReplacementOutput(client, stream);
          expect(output).toEqual({
            content: "Authoritative answer.",
            calls: [weatherCall],
            refusal: "",
            reasoning: "Original reasoning.",
            finish: "tool_calls",
          });
        },
        { response: authoritativeResponse },
      );
    },
  );
}

const replacementErrorResponse = {
  error: {
    message: "Fixture deliberately unavailable.",
    type: "server_error",
    code: "fixture_unavailable",
  },
  status: 503,
};
for (const stream of [false, true]) {
  test.each(authoritativeReplacementCases)(
    `real OpenAI $cell error-response applicability stream=${stream}`,
    async ({ fault }) => {
      await withFaultFixture(
        undefined,
        async ({ client, mock }) => {
          const outcome = await client.chat.completions
            .create({ ...request, stream }, { headers: { "X-AIMock-Misbehavior": fault.fault } })
            .then(
              (data) => ({ kind: "success", data }),
              (error: unknown) => ({ kind: "error", error }),
            );
          console.log(JSON.stringify({ fault, outcome }));
          expect(mock.getRequests()).toHaveLength(1);
          expect(outcome).toMatchObject({
            kind: "error",
            error: { status: 501, code: "aimock_misbehavior_not_applicable" },
          });
        },
        { response: replacementErrorResponse },
      );
    },
  );
  test.each(authoritativeReplacementCases)(
    `real OpenAI $cell error-response control stream=${stream}`,
    async () => {
      await withFaultFixture(
        undefined,
        async ({ client, mock }) => {
          await expect(
            client.chat.completions.create({ ...request, stream }),
          ).rejects.toMatchObject({ status: 503, code: "fixture_unavailable" });
          expect(mock.getRequests()).toHaveLength(1);
        },
        { response: replacementErrorResponse },
      );
    },
  );
  test(`real OpenAI K7 rejects Anthropic-only category stream=${stream}`, async () => {
    await withFaultFixture(undefined, async ({ client, mock }) => {
      const outcome = await client.chat.completions
        .create(
          { ...request, stream },
          { headers: { "X-AIMock-Misbehavior": "refusal; category=policy" } },
        )
        .then(
          () => ({ kind: "success" }),
          (error: unknown) => ({ kind: "error", error }),
        );
      console.log(JSON.stringify({ category: "policy", outcome }));
      expect(mock.getRequests()).toHaveLength(1);
      expect(outcome).toMatchObject({
        kind: "error",
        error: { status: 501, code: "aimock_misbehavior_unsupported" },
      });
    });
  });
}

for (const stream of [false, true]) {
  test.each(authoritativeReplacementCases)(
    `real OpenAI $cell missing-target applicability stream=${stream}`,
    async ({ fault }) => {
      await withFaultFixture(undefined, async ({ client, mock }) => {
        const outcome = await client.chat.completions
          .create(
            { ...request, stream },
            { headers: { "X-AIMock-Misbehavior": `${fault.fault}; tool=absent` } },
          )
          .then(
            () => ({ kind: "success" }),
            (error: unknown) => ({ kind: "error", error }),
          );
        console.log(JSON.stringify({ fault: fault.fault, missingTarget: "absent", outcome }));
        expect(mock.getRequests()).toHaveLength(1);
        expect(outcome).toMatchObject({
          kind: "error",
          error: { status: 501, code: "aimock_misbehavior_not_applicable" },
        });
      });
    },
  );
}

for (const blocks of [false, true]) {
  test.each(duplicateCases)(
    `OpenAI preparation K4 $cell blocks=${blocks}`,
    ({ calls, tool, source, destination }) => {
      const response = blocks
        ? {
            content: "stale",
            toolCalls: [lastCall],
            blocks: [
              { type: "text" as const, text: "before" },
              ...calls.map((call) => ({ type: "toolCall" as const, ...call })),
              { type: "text" as const, text: "after" },
            ],
          }
        : { toolCalls: calls };
      const candidate = prepareDuplicateIdCandidate(
        { wire: "openai-chat", response, request, stream: true, emitsToolCallIds: true },
        { fault: "tool-call-id-duplicate", ...(tool ? { tool } : {}) },
      );
      expect(candidate.kind).toBe("ready");
      if (candidate.kind !== "ready") throw new Error(candidate.detail);
      const plan: MisbehaviorPlan = {
        kind: "applied",
        ...candidate.candidate,
        summary: { applied: true, evaluations: [] },
      };
      const before = structuredClone(plan);
      const prepared = prepareOpenAIChatMisbehavior(plan);
      expect(plan).toEqual(before);
      const served = prepared.summary.servedToolCalls!;
      expect(served).toHaveLength(calls.length === 1 ? 2 : calls.length);
      expect(served[source].id).toMatch(/^call_/);
      expect(served[destination].id).toBe(served[source].id);
      expect(served.map(({ name, arguments: args }) => ({ name, arguments: args }))).toEqual(
        (calls.length === 1 ? [calls[0], calls[0]] : calls).map(({ name, arguments: args }) => ({
          name,
          arguments: args,
        })),
      );
      expect("toolCalls" in prepared.response && prepared.response.toolCalls).toEqual(served);
      const wireCalls = buildToolCallCompletion(
        served.map(({ name, arguments: args, id }) => ({ name, arguments: args, id })),
        "gpt-4o",
      ).choices[0].message.tool_calls;
      expect(wireCalls?.map(({ id, function: fn }) => ({ id, ...fn }))).toEqual(served);
      if (blocks) {
        expect("blocks" in prepared.response && prepared.response.blocks).toEqual([
          { type: "text", text: "before" },
          ...served.map((call) => ({ type: "toolCall", ...call })),
          { type: "text", text: "after" },
        ]);
        expect("content" in prepared.response && prepared.response.content).toBe("beforeafter");
      }
      expect(prepareOpenAIChatMisbehavior(prepared)).toEqual(prepared);
    },
  );
}

test.each<FixtureResponse>([
  { content: "" },
  { content: "stale", toolCalls: [weatherCall], blocks: [{ type: "text", text: "only" }] },
])("OpenAI preparation records empty effective calls: %j", (response) => {
  const prepared = prepareOpenAIChatMisbehavior({
    kind: "applied",
    response,
    summary: { applied: true, evaluations: [] },
  });
  expect(prepared.summary.servedToolCalls).toEqual([]);
});

test("OpenAI preparation allocates stable independent IDs and preserves authored arguments", () => {
  const calls = [
    { name: "first", arguments: '{ "x":' },
    { name: "last", arguments: "", id: "" },
    weatherCall,
  ];
  const plan: MisbehaviorPlan = {
    kind: "applied",
    response: { toolCalls: calls },
    summary: { applied: true, evaluations: [] },
  };
  const before = structuredClone(plan);
  const prepared = prepareOpenAIChatMisbehavior(plan);
  const served = prepared.summary.servedToolCalls!;
  expect(new Set(served.map((call) => call.id)).size).toBe(3);
  expect(served.every((call) => Boolean(call.id))).toBe(true);
  expect(served.map((call) => call.arguments)).toEqual(calls.map((call) => call.arguments));
  expect(served[2].id).toBe(weatherCall.id);
  expect(prepareOpenAIChatMisbehavior(prepared)).toEqual(prepared);
  expect(plan).toEqual(before);
});

const usageCases = [
  { cell: "K4", fault: "tool-call-id-duplicate", completion: 12 },
  { cell: "K5", fault: "stop-length-mid-tool", completion: 4 },
  { cell: "K6", fault: "empty-response", completion: 1 },
];
const authoredUsage = { prompt_tokens: 900, completion_tokens: 800, total_tokens: 1700 };
for (const stream of [false, true]) {
  for (const explicit of [false, true]) {
    for (const applied of [false, true]) {
      test.each(usageCases)(
        `real OpenAI usage $cell stream=${stream} explicit=${explicit} applied=${applied}`,
        async ({ fault, completion }) => {
          await withFaultFixture(
            applied ? { faults: [{ fault }] } : undefined,
            async ({ client }) => {
              let usage;
              if (stream) {
                const { data, response } = await client.chat.completions
                  .create({ ...request, stream: true, stream_options: { include_usage: true } })
                  .withResponse();
                const raw = response.clone().text();
                const usages = [];
                for await (const chunk of data) if (chunk.usage) usages.push(chunk.usage);
                console.log(
                  JSON.stringify({ fault, explicit, applied, stream, wire: await raw, usages }),
                );
                expect(usages).toHaveLength(1);
                usage = usages[0];
              } else {
                const data = await client.chat.completions.create(request);
                console.log(JSON.stringify({ fault, explicit, applied, stream, data }));
                usage = data.usage;
              }
              const expected =
                !applied && explicit
                  ? authoredUsage
                  : {
                      prompt_tokens: 2,
                      completion_tokens: applied ? completion : 6,
                      total_tokens: 2 + (applied ? completion : 6),
                    };
              expect(usage).toEqual(expected);
            },
            {
              response: { toolCalls: [weatherCall], ...(explicit ? { usage: authoredUsage } : {}) },
            },
          );
        },
      );
    }
  }
}

test("OpenAI applied usage ignores all stored usage fields without changing other overrides", () => {
  const response = {
    toolCalls: [weatherCall],
    usage: { ...authoredUsage, cost: 0.25 },
    model: "scripted",
    finishReason: "stop",
  };
  const plan: MisbehaviorPlan = {
    kind: "applied",
    response,
    summary: { applied: true, evaluations: [] },
  };
  const before = structuredClone(plan);
  const prepared = prepareOpenAIChatMisbehavior(plan);
  if (!("toolCalls" in prepared.response)) throw new Error("Expected prepared tool calls");
  expect(extractOverrides(prepared.response)).toEqual({ model: "scripted", finishReason: "stop" });
  expect(resolveOpenAIChatMisbehaviorUsage(prepared, request)).toEqual({
    prompt_tokens: 2,
    completion_tokens: 6,
    total_tokens: 8,
  });
  expect(
    buildToolCallCompletion([weatherCall], "gpt-4o", undefined, extractOverrides(response)).usage,
  ).toEqual(authoredUsage);
  expect(plan).toEqual(before);
});

test("OpenAI applied usage estimates full authoritative prepared output and original multimodal prompt", () => {
  const plan: MisbehaviorPlan = {
    kind: "applied",
    response: {
      content: "stale text to ignore",
      toolCalls: [lastCall],
      usage: authoredUsage,
      blocks: [
        { type: "text", text: "abcd" },
        { type: "toolCall", name: "tool", arguments: "{}" },
      ],
      reasoning: "1234",
    },
    summary: { applied: true, evaluations: [] },
  };
  const prepared = prepareOpenAIChatMisbehavior(plan);
  const input: ChatCompletionRequest = {
    ...request,
    messages: [
      { role: "system", content: "12345" },
      { role: "user", content: [{ type: "text", text: "67890" }] },
    ],
  };
  const before = structuredClone({ prepared, input });
  expect(resolveOpenAIChatMisbehaviorUsage(prepared, input)).toEqual({
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
  });
  expect({ prepared, input }).toEqual(before);
});

test.each([
  { response: { content: "" }, completion: 1 },
  { response: { content: "" }, refusal: "A refusal lasting twenty chars.", completion: 8 },
  {
    response: { content: "", reasoning: "older reasoning" },
    reasoning: "123456789",
    completion: 3,
  },
])("OpenAI applied usage counts replacement text once: %j", ({ completion, ...output }) => {
  const plan: MisbehaviorPlan = {
    kind: "applied",
    ...output,
    summary: { applied: true, evaluations: [] },
  };
  expect(resolveOpenAIChatMisbehaviorUsage(prepareOpenAIChatMisbehavior(plan), request)).toEqual({
    prompt_tokens: 2,
    completion_tokens: completion,
    total_tokens: 2 + completion,
  });
});

for (const stream of [false, true]) {
  test(`real OpenAI usage skipped override stream=${stream}`, async () => {
    await withFaultFixture(
      { faults: [{ fault: "empty-response", rate: 0 }] },
      async ({ client }) => {
        if (!stream) {
          expect((await client.chat.completions.create(request)).usage).toEqual(authoredUsage);
        } else {
          const chunks = await client.chat.completions.create({
            ...request,
            stream: true,
            stream_options: { include_usage: true },
          });
          const usages = [];
          for await (const chunk of chunks) if (chunk.usage) usages.push(chunk.usage);
          expect(usages).toEqual([authoredUsage]);
        }
      },
      { response: { toolCalls: [weatherCall], usage: authoredUsage } },
    );
  });
}

for (const stream of [false, true]) {
  test.each(lengthCases)(
    `real OpenAI K5 parser length $cell stream=${stream}`,
    async ({ calls, content, tool, at }) => {
      await withFaultFixture(
        {
          faults: [
            { fault: "stop-length-mid-tool", ...(tool ? { tool } : {}), ...(at ? { at } : {}) },
          ],
        },
        async ({ client }) => {
          const parserRequest = {
            ...request,
            tools: request.tools.map((tool) => ({
              ...tool,
              function: { ...tool.function, strict: true },
            })),
          };
          const result = await (
            stream
              ? client.beta.chat.completions.stream(parserRequest).finalChatCompletion()
              : client.beta.chat.completions.parse(parserRequest)
          ).then(
            (data) => ({ kind: "success", data }),
            (error: unknown) => ({ kind: "error", error }),
          );
          console.log(JSON.stringify({ stream, parser: "LengthFinishReasonError", result }));
          expect(result.kind).toBe("error");
          if (result.kind === "error" && "error" in result)
            expect(result.error).toBeInstanceOf(LengthFinishReasonError);
        },
        { response: { content, toolCalls: calls } },
      );
    },
  );
}

test("real OpenAI K5 raw length precedes requested usage and clean DONE", async () => {
  await withFaultFixture({ faults: [{ fault: "stop-length-mid-tool" }] }, async ({ client }) => {
    const { data, response } = await client.chat.completions
      .create({ ...request, stream: true, stream_options: { include_usage: true } })
      .withResponse();
    const raw = response.clone().text();
    const chunks = [];
    for await (const chunk of data) chunks.push(chunk);
    const wire = await raw;
    console.log(JSON.stringify({ wire, chunks }));
    expect(
      wire
        .trim()
        .split(/\r?\n\r?\n/)
        .at(-1),
    ).toBe("data: [DONE]");
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
    });
    expect(chunks.at(-2)?.choices[0]).toMatchObject({ delta: {}, finish_reason: "length" });
    expect(
      chunks.filter((chunk) => chunk.choices.some((choice) => choice.finish_reason)),
    ).toHaveLength(1);
  });
});

for (const blocks of [false, true]) {
  test.each(lengthCases)(
    `OpenAI K5 preparation length $cell blocks=${blocks}`,
    ({ calls, content, tool, at, target, prefix }) => {
      const response = {
        content,
        toolCalls: calls,
        finishReason: "stop",
        ...(blocks
          ? {
              blocks: [
                { type: "text" as const, text: content },
                ...calls.map((call) => ({ type: "toolCall" as const, ...call })),
                { type: "text" as const, text: "Must not survive target cut." },
              ],
            }
          : {}),
      };
      const candidate = prepareLengthCandidate(
        { wire: "openai-chat", response, request, stream: true },
        { fault: "stop-length-mid-tool", ...(tool ? { tool } : {}), ...(at ? { at } : {}) },
      );
      if (candidate.kind !== "ready") throw new Error(candidate.detail);
      const plan: MisbehaviorPlan = {
        kind: "applied",
        ...candidate.candidate,
        summary: { applied: true, evaluations: [] },
      };
      const before = structuredClone(plan);
      const prepared = prepareOpenAIChatMisbehavior(plan);
      const output = prepared.response;
      if (!isContentWithToolCallsResponse(output))
        throw new Error("Expected combined prepared output");
      const overrides = extractOverrides(output);
      const toolCalls = requireFunctionToolCalls(output.toolCalls ?? [], "OpenAI Chat Completions");
      const chunks = buildContentWithToolCallsChunks(
        output.content ?? "",
        toolCalls,
        "gpt-4o",
        2,
        undefined,
        overrides,
        output.blocks ? resolveFixtureBlocks(output.blocks) : undefined,
      );
      expect(chunks[0].choices[0].delta.role).toBe("assistant");
      expect(chunks.at(-1)?.choices[0]).toMatchObject({ delta: {}, finish_reason: "length" });
      expect(
        chunks.filter((chunk) => chunk.choices.some((choice) => choice.finish_reason)),
      ).toHaveLength(1);
      const observed: ObservedCall[] = [];
      for (const chunk of chunks)
        for (const delta of chunk.choices[0].delta.tool_calls ?? []) {
          const call = (observed[delta.index] ??= { id: "", name: "", arguments: "" });
          call.id += delta.id ?? "";
          call.name += delta.function?.name ?? "";
          call.arguments += delta.function?.arguments ?? "";
        }
      const expected = calls
        .slice(0, target + 1)
        .map((call, index) => ({ ...call, ...(index === target ? { arguments: prefix } : {}) }));
      expect(observed).toEqual(expected);
      expect(
        chunks
          .flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? ""))
          .join(""),
      ).toBe(content);
      const usage = resolveOpenAIChatMisbehaviorUsage(prepared, request);
      const finalChunk = chunks.at(-1)!;
      chunks.push(buildUsageChunk(finalChunk.id, finalChunk.model, finalChunk.created, usage));
      expect(chunks.at(-1)).toMatchObject({ choices: [], usage });
      expect(chunks.at(-2)?.choices[0].finish_reason).toBe("length");
      const completion = buildContentWithToolCallsCompletion(
        output.content ?? "",
        toolCalls,
        "gpt-4o",
        undefined,
        overrides,
        request.messages,
      );
      expect(completion.choices[0].finish_reason).toBe("length");
      expect(
        completion.choices[0].message.tool_calls?.map(({ id, function: fn }) => ({ id, ...fn })),
      ).toEqual(expected);
      expect(plan).toEqual(before);
      expect(response.finishReason).toBe("stop");
    },
  );
}

test("OpenAI K5 preparation leaves ordinary finishReason precedence unchanged", () => {
  const plan: MisbehaviorPlan = {
    kind: "applied",
    response: { toolCalls: [weatherCall], finishReason: "stop" },
    summary: { applied: true, evaluations: [] },
  };
  const prepared = prepareOpenAIChatMisbehavior(plan);
  expect(prepared.response).toMatchObject({ finishReason: "stop" });
  expect(
    buildToolCallCompletion([weatherCall], "gpt-4o", undefined, { finishReason: "stop" }).choices[0]
      .finish_reason,
  ).toBe("stop");
});

for (const stream of [false, true]) {
  test(`real OpenAI K7 Unicode refusal stream=${stream}`, async () => {
    const message = "Cannot comply. 拒否します。 " + "Please choose another request. ".repeat(8);
    await withFaultFixture(
      { faults: [{ fault: "refusal", message }] },
      async ({ client }) => {
        const output = await readReplacementOutput(client, stream);
        expect(output).toEqual({
          content: null,
          refusal: message,
          reasoning: "",
          calls: [],
          finish: "stop",
        });
      },
      { response: authoritativeResponse },
    );
  });
}

test.each([
  undefined,
  "Request refused.",
  "拒否します。 " + "Please choose another request. ".repeat(8),
])("OpenAI K7 refusal builders keep structured output: %j", (message) => {
  const candidate = prepareRefusalCandidate(
    {
      wire: "openai-chat",
      response: {
        ...authoritativeResponse,
        finishReason: "length",
        role: "user",
        usage: authoredUsage,
      },
      request,
      stream: true,
    },
    { fault: "refusal", ...(message === undefined ? {} : { message }) },
  );
  if (candidate.kind !== "ready") throw new Error(candidate.detail);
  const prepared = prepareOpenAIChatMisbehavior({
    kind: "applied",
    ...candidate.candidate,
    summary: { applied: true, evaluations: [] },
  });
  const before = structuredClone(prepared);
  const refusal = prepared.refusal!;
  expect(prepared.summary.servedToolCalls).toEqual([]);
  const overrides = {
    id: "chatcmpl_refusal",
    created: 123,
    model: "scripted-model",
    systemFingerprint: "fp_refusal",
    role: "user",
    finishReason: "length",
    usage: authoredUsage,
  };
  const chunks = buildOpenAIRefusalChunks(refusal, "gpt-4o", 3, overrides);
  expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: null });
  expect(
    chunks
      .slice(1, -1)
      .map((chunk) => chunk.choices[0].delta.refusal)
      .join(""),
  ).toBe(refusal);
  for (const chunk of chunks.slice(1, -1)) {
    expect(Object.keys(chunk.choices[0].delta)).toEqual(["refusal"]);
    expect(chunk.choices[0].delta.refusal?.length).toBeLessThanOrEqual(3);
    expect(chunk.choices[0].finish_reason).toBeNull();
  }
  expect(chunks.at(-1)?.choices[0]).toEqual({
    index: 0,
    delta: {},
    logprobs: null,
    finish_reason: "stop",
  });
  for (const chunk of chunks)
    expect(chunk).toMatchObject({
      id: "chatcmpl_refusal",
      created: 123,
      model: "scripted-model",
      system_fingerprint: "fp_refusal",
    });
  const completion = buildOpenAIRefusalCompletion(refusal, "gpt-4o", overrides, request.messages);
  expect(completion.choices[0].message).toEqual({ role: "assistant", content: null, refusal });
  expect(completion.choices[0].finish_reason).toBe("stop");
  expect(completion.usage).toEqual(resolveOpenAIChatMisbehaviorUsage(prepared, request));
  const finalChunk = chunks.at(-1)!;
  const withUsage = [
    ...chunks,
    buildUsageChunk(finalChunk.id, finalChunk.model, finalChunk.created, completion.usage),
  ];
  expect(withUsage.at(-1)).toMatchObject({ choices: [], usage: completion.usage });
  expect(prepared).toEqual(before);
  expect(overrides.usage).toEqual(authoredUsage);
});

const filterResponses = [
  { cell: "text", response: { content: "Original answer.", reasoning: "Original reasoning." } },
  { cell: "tools", response: { toolCalls: [weatherCall], reasoning: "Original reasoning." } },
  { cell: "blocks", response: authoritativeResponse },
];
for (const stream of [false, true]) {
  test.each(filterResponses)(
    `real OpenAI K8 parser $cell stream=${stream}`,
    async ({ response }) => {
      await withFaultFixture(
        { faults: [{ fault: "content-filter" }] },
        async ({ client }) => {
          const parserRequest = {
            ...request,
            tools: request.tools.map((tool) => ({
              ...tool,
              function: { ...tool.function, strict: true },
            })),
          };
          const result = await (
            stream
              ? client.beta.chat.completions.stream(parserRequest).finalChatCompletion()
              : client.beta.chat.completions.parse(parserRequest)
          ).then(
            (data) => ({ kind: "success", data }),
            (error: unknown) => ({ kind: "error", error }),
          );
          console.log(JSON.stringify({ stream, result }));
          expect(result.kind).toBe("error");
          if ("error" in result)
            expect(result.error).toBeInstanceOf(ContentFilterFinishReasonError);
        },
        { response },
      );
    },
  );
}

test("real OpenAI K8 raw role then content_filter then usage and clean DONE", async () => {
  await withFaultFixture(
    { faults: [{ fault: "content-filter" }] },
    async ({ client }) => {
      const { data, response } = await client.chat.completions
        .create({ ...request, stream: true, stream_options: { include_usage: true } })
        .withResponse();
      const raw = response.clone().text();
      const chunks = [];
      for await (const chunk of data) chunks.push(chunk);
      const wire = await raw;
      console.log(JSON.stringify({ wire, chunks }));
      const frames = wire.trim().split(/\r?\n\r?\n/);
      expect(frames.at(-1)).toBe("data: [DONE]");
      expect(frames.filter((frame) => frame === "data: [DONE]")).toHaveLength(1);
      expect(chunks).toHaveLength(3);
      expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: null });
      expect(chunks[1].choices[0]).toEqual({
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: "content_filter",
      });
      expect(chunks[2]).toMatchObject({
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    },
    { response: authoritativeResponse },
  );
});

test.each(filterResponses)("OpenAI K8 filter builders withhold $cell", ({ response }) => {
  const candidate = prepareContentFilterCandidate(
    {
      wire: "openai-chat",
      response,
      request,
      stream: true,
    },
    { fault: "content-filter" },
  );
  if (candidate.kind !== "ready") throw new Error(candidate.detail);
  const prepared = prepareOpenAIChatMisbehavior({
    kind: "applied",
    ...candidate.candidate,
    summary: { applied: true, evaluations: [] },
  });
  const before = structuredClone(prepared);
  expect(prepared.summary.servedToolCalls).toEqual([]);
  const overrides = {
    id: "chatcmpl_filter",
    created: 123,
    model: "scripted-model",
    systemFingerprint: "fp_filter",
    role: "user",
    finishReason: "stop",
    usage: authoredUsage,
  };
  const chunks = buildOpenAIContentFilterChunks("gpt-4o", overrides);
  expect(chunks).toHaveLength(2);
  expect(chunks[0].choices).toEqual([
    { index: 0, delta: { role: "assistant", content: null }, logprobs: null, finish_reason: null },
  ]);
  expect(chunks[1].choices).toEqual([
    { index: 0, delta: {}, logprobs: null, finish_reason: "content_filter" },
  ]);
  for (const chunk of chunks)
    expect(chunk).toMatchObject({
      id: "chatcmpl_filter",
      created: 123,
      model: "scripted-model",
      system_fingerprint: "fp_filter",
    });
  const completion = buildOpenAIContentFilterCompletion("gpt-4o", overrides, request.messages);
  expect(completion.choices[0].message).toEqual({
    role: "assistant",
    content: null,
    refusal: null,
  });
  expect(completion.choices[0].finish_reason).toBe("content_filter");
  expect(completion.usage).toEqual({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  expect(completion.usage).toEqual(resolveOpenAIChatMisbehaviorUsage(prepared, request));
  const withUsage = [
    ...chunks,
    buildUsageChunk(chunks[1].id, chunks[1].model, chunks[1].created, completion.usage),
  ];
  expect(withUsage.at(-1)).toMatchObject({ choices: [], usage: completion.usage });
  expect(prepared).toEqual(before);
  expect(overrides.usage).toEqual(authoredUsage);
});

/** K9 follows the captured OpenRouter fields; ordinary reasoning remains separate. */
function readK9Reasoning(value: object, expose: boolean): string {
  expect.soft(value).not.toHaveProperty("reasoning_content");
  if (!expose) {
    expect.soft(value).not.toHaveProperty("reasoning");
    expect.soft(value).not.toHaveProperty("reasoning_details");
    return "";
  }
  if (!("reasoning" in value)) {
    expect.soft(value).not.toHaveProperty("reasoning_details");
    return "";
  }
  expect.soft(typeof value.reasoning).toBe("string");
  expect.soft(value).toHaveProperty("reasoning_details", [
    {
      type: "reasoning.text",
      text: value.reasoning,
      format: "unknown",
      index: 0,
    },
  ]);
  return typeof value.reasoning === "string" ? value.reasoning : "";
}

const reasoningModes = [
  { provider: "native", path: "/v1", model: "o3", expose: false },
  { provider: "openrouter", path: "/api/v1", model: "deepseek/deepseek-r1", expose: true },
];
const reasoningVariants: { cell: string; reasoning: string | undefined; fallback?: boolean }[] = [
  { cell: "empty", reasoning: "" },
  { cell: "short", reasoning: "Thinking." },
  { cell: "long", reasoning: "Thinking through the requested answer. ".repeat(12) },
  { cell: "fixture", reasoning: undefined },
  { cell: "fallback", reasoning: undefined, fallback: true },
];
for (const stream of [false, true])
  for (const mode of reasoningModes) {
    test.each(reasoningVariants)(
      `real K9 ${mode.provider} $cell stream=${stream}`,
      async ({ reasoning, fallback }) => {
        await withFaultFixture(
          {
            faults: [
              { fault: "reasoning-only", ...(reasoning === undefined ? {} : { reasoning }) },
            ],
          },
          async ({ url }) => {
            const client = new OpenAI({
              apiKey: "local",
              baseURL: url + mode.path,
              maxRetries: 0,
              timeout: 5000,
            });
            const input = { ...request, model: mode.model };
            const selected = reasoning ?? (fallback ? "Thinking..." : "Fixture reasoning.");
            let content: string | null = null;
            let exposed = "";
            let finish: string | null = null;
            let usage;
            const calls: unknown[] = [];
            if (!stream) {
              const data = await client.chat.completions.create(input);
              console.log(JSON.stringify({ mode, reasoning, stream, data }));
              const choice = data.choices[0];
              if (mode.expose) expect.soft(choice.message).toHaveProperty("reasoning", selected);
              else expect.soft(choice.message).not.toHaveProperty("reasoning_content");
              content = choice.message.content;
              exposed = readK9Reasoning(choice.message, mode.expose);
              calls.push(...(choice.message.tool_calls ?? []));
              finish = choice.finish_reason;
              usage = data.usage;
            } else {
              const { data, response } = await client.chat.completions
                .create({ ...input, stream: true, stream_options: { include_usage: true } })
                .withResponse();
              const raw = response.clone().text();
              const chunks = [];
              for await (const chunk of data) {
                chunks.push(chunk);
                if (chunk.usage) usage = chunk.usage;
                for (const choice of chunk.choices) {
                  if (typeof choice.delta.content === "string")
                    content = (content ?? "") + choice.delta.content;
                  exposed += readK9Reasoning(choice.delta, mode.expose);
                  if ("reasoning" in choice.delta)
                    expect.soft(choice.delta).toMatchObject({ role: "assistant", content: "" });
                  calls.push(...(choice.delta.tool_calls ?? []));
                  if (choice.finish_reason) finish = choice.finish_reason;
                }
              }
              const wire = await raw;
              console.log(JSON.stringify({ mode, reasoning, stream, wire, chunks }));
              expect(
                wire
                  .trim()
                  .split(/\r?\n\r?\n/)
                  .at(-1),
              ).toBe("data: [DONE]");
              expect(chunks.at(-1)?.choices).toEqual([]);
              expect(chunks.at(-2)?.choices[0]).toMatchObject({
                delta: {},
                finish_reason: "length",
              });
            }
            expect.soft(content).toBe(stream && mode.expose && selected.length > 0 ? "" : null);
            expect.soft(calls).toEqual([]);
            expect.soft(exposed).toBe(mode.expose ? selected : "");
            expect.soft(finish).toBe("length");
            const completion = mode.expose ? Math.max(1, Math.ceil(selected.length / 4)) : 1;
            expect(usage).toMatchObject({
              prompt_tokens: 2,
              completion_tokens: completion,
              total_tokens: 2 + completion,
            });
          },
          {
            response: {
              ...authoritativeResponse,
              reasoning: fallback ? undefined : "Fixture reasoning.",
              usage: authoredUsage,
            },
          },
        );
      },
    );
  }

for (const mode of reasoningModes) {
  test.each(reasoningVariants)(
    `OpenAI K9 builders ${mode.provider} $cell`,
    ({ reasoning, fallback }) => {
      const candidate = prepareReasoningOnlyCandidate(
        {
          wire: "openai-chat",
          response: {
            ...authoritativeResponse,
            reasoning: fallback ? undefined : "Fixture reasoning.",
          },
          request,
          stream: true,
        },
        { fault: "reasoning-only", ...(reasoning === undefined ? {} : { reasoning }) },
      );
      if (candidate.kind !== "ready") throw new Error(candidate.detail);
      const prepared = prepareOpenAIChatMisbehavior({
        kind: "applied",
        ...candidate.candidate,
        summary: { applied: true, evaluations: [] },
      });
      const before = structuredClone(prepared);
      expect(prepared.summary.servedToolCalls).toEqual([]);
      const selected = prepared.reasoning!;
      const completionTokens = mode.expose ? Math.max(1, Math.ceil(selected.length / 4)) : 1;
      const usage = resolveOpenAIChatMisbehaviorUsage(prepared, request, mode.expose);
      expect(usage).toEqual({
        prompt_tokens: 2,
        completion_tokens: completionTokens,
        total_tokens: 2 + completionTokens,
      });
      const overrides = {
        id: "chatcmpl_reasoning",
        created: 123,
        model: "different-echoed-model",
        role: "user",
        finishReason: "stop",
        usage: authoredUsage,
      };
      const chunks = buildOpenAIReasoningChunks(selected, mode.model, 3, mode.expose, overrides);
      expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: null });
      expect(
        chunks
          .slice(1, -1)
          .map((chunk) => chunk.choices[0].delta.reasoning)
          .join(""),
      ).toBe(mode.expose ? selected : "");
      for (const chunk of chunks.slice(1, -1)) {
        const delta = chunk.choices[0].delta;
        expect(delta).toEqual({
          role: "assistant",
          content: "",
          reasoning: delta.reasoning,
          reasoning_details: [
            { type: "reasoning.text", text: delta.reasoning, format: "unknown", index: 0 },
          ],
        });
        expect(chunk.choices[0].finish_reason).toBeNull();
      }
      if (!mode.expose) expect(chunks).toHaveLength(2);
      expect(chunks.at(-1)?.choices[0]).toEqual({
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: "length",
      });
      for (const chunk of chunks)
        expect(chunk).toMatchObject({
          id: "chatcmpl_reasoning",
          created: 123,
          model: "different-echoed-model",
        });
      const completion = buildOpenAIReasoningCompletion(
        selected,
        mode.model,
        mode.expose,
        overrides,
        request.messages,
      );
      expect(completion.choices[0].message).toEqual({
        role: "assistant",
        content: null,
        refusal: null,
        ...(mode.expose
          ? {
              reasoning: selected,
              reasoning_details: [
                { type: "reasoning.text", text: selected, format: "unknown", index: 0 },
              ],
            }
          : {}),
      });
      expect(completion.choices[0].finish_reason).toBe("length");
      expect(completion.usage).toEqual(usage);
      expect(prepared).toEqual(before);
      expect(overrides.usage).toEqual(authoredUsage);
    },
  );
}

// A2 integration: real SDK requests exercise final selection and transport seams.
async function withRuntimeServer(
  fixtures: Fixture[],
  run: (instance: { url: string; mock: LLMock }) => Promise<void>,
) {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  for (const fixture of fixtures) mock.addFixture(fixture);
  const url = await mock.start();
  try {
    await run({ url, mock });
  } finally {
    await mock.stop();
  }
}

test("A2 real fallback plans only the final response and invokes each factory once", async () => {
  let rejectedCalls = 0;
  let selectedCalls = 0;
  const original = {
    toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }],
    usage: { promptTokens: 901, completionTokens: 902 },
  };
  const snapshot = structuredClone(original);
  await withRuntimeServer(
    [
      {
        match: { model: "primary/error" },
        misbehavior: "empty-response",
        response: () => {
          rejectedCalls++;
          return { error: { message: "retry" }, status: 503 };
        },
      },
      {
        match: { model: "fallback/good" },
        misbehavior: { faults: [{ fault: "tool-call-id-duplicate", times: 1 }] },
        response: () => {
          selectedCalls++;
          return original;
        },
      },
    ],
    async ({ url, mock }) => {
      const client = new OpenAI({ apiKey: "local", baseURL: `${url}/api/v1`, maxRetries: 0 });
      const params = { ...request, model: "primary/error", models: ["fallback/good"] };
      const first = await client.chat.completions.create(params);
      const second = await client.chat.completions.create(params);
      const entries = mock.getRequests();
      console.log(
        JSON.stringify({
          cell: "A2-fallback",
          first,
          second,
          entries,
          rejectedCalls,
          selectedCalls,
        }),
      );
      expect(first.model).toBe("fallback/good");
      const calls = first.choices[0].message.tool_calls ?? [];
      expect(calls).toHaveLength(2);
      expect(calls[0].id).toBe(calls[1].id);
      expect(second.choices[0].message.tool_calls).toHaveLength(1);
      expect(entries).toHaveLength(2);
      expect(entries[0].response.misbehavior?.servedToolCalls).toEqual(
        calls.map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
      );
      expect(entries[0].response.misbehavior?.evaluations).toHaveLength(1);
      expect(entries[1].response.misbehavior?.reason).toBe("times-exhausted");
      expect(rejectedCalls).toBe(2);
      expect(selectedCalls).toBe(2);
      expect(original).toEqual(snapshot);
    },
  );
});

test("A2 real interrupted K4 retains full prepared calls and counts fault chunks", async () => {
  const fixture: Fixture = {
    match: {},
    misbehavior: "tool-call-id-duplicate",
    response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
    chunkSize: 2,
    latency: 5,
    truncateAfterChunks: 3,
  };
  await withRuntimeServer([fixture], async ({ url, mock }) => {
    const client = new OpenAI({ apiKey: "local", baseURL: `${url}/v1`, maxRetries: 0 });
    const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
    let error: unknown;
    try {
      const stream = await client.chat.completions.create({
        ...request,
        stream: true,
        stream_options: { include_usage: true },
      });
      for await (const chunk of stream) chunks.push(chunk);
    } catch (caught) {
      error = caught;
    }
    const entries = mock.getRequests();
    console.log(JSON.stringify({ cell: "A2-interrupted", chunks, error: String(error), entries }));
    expect(error).toBeDefined();
    // Socket destruction may discard the final local write before delivery.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(chunks.some((chunk) => chunk.usage)).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0].response).toMatchObject({
      interrupted: true,
      interruptReason: "truncateAfterChunks",
    });
    const calls = entries[0].response.misbehavior?.servedToolCalls;
    expect(calls).toHaveLength(2);
    expect(calls?.map((call) => call.arguments)).toEqual(['{"city":"Paris"}', '{"city":"Paris"}']);
    expect(calls?.[0].id).toBe(calls?.[1].id);
    expect(chunks[1].choices[0].delta.tool_calls?.[0].id).toBe(calls?.[0].id);
  });
});

test("A2 real K4 extra chunks repeat the last recorded gap without mutating timings", async () => {
  const timings = { ttftMs: 0, interChunkDelaysMs: [0, 0, 90], totalDurationMs: 90 };
  const snapshot = structuredClone(timings);
  await withRuntimeServer(
    [
      {
        match: {},
        misbehavior: "tool-call-id-duplicate",
        response: { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] },
        recordedTimings: timings,
        chunkSize: 100,
      },
    ],
    async ({ url }) => {
      const client = new OpenAI({ apiKey: "local", baseURL: `${url}/v1`, maxRetries: 0 });
      const arrivals: number[] = [];
      const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
      const stream = await client.chat.completions.create({ ...request, stream: true });
      for await (const chunk of stream) {
        arrivals.push(performance.now());
        chunks.push(chunk);
      }
      const gaps = arrivals.slice(1).map((arrival, index) => arrival - arrivals[index]);
      console.log(JSON.stringify({ cell: "A2-K4-timing", gaps, chunks }));
      expect(chunks).toHaveLength(6);
      // Ordinary extrapolation averages 30 ms; K4 must repeat the 90 ms last gap.
      expect(gaps.slice(3).every((gap) => gap >= 65)).toBe(true);
      expect(timings).toEqual(snapshot);
    },
  );
});

async function withDirectRuntime(
  fixture: Fixture,
  run: (instance: ServerInstance) => Promise<void>,
  runtimeFault = false,
) {
  const instance = await createServer([fixture], {
    port: 0,
    logLevel: "silent",
    metrics: true,
    ...(runtimeFault
      ? { misbehavior: { faults: [{ fault: "tool-args-invalid-json" as const, times: 1 }] } }
      : {}),
  });
  try {
    await run(instance);
  } finally {
    await new Promise<void>((resolve, reject) =>
      instance.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("A2 review A1 real malformed fixture config logs once without phantom evaluation", async () => {
  const invalidConfig = JSON.parse('{"faults":"invalid"}');
  await withDirectRuntime(
    { match: {}, response: { content: "hello" }, misbehavior: invalidConfig },
    async ({ url, journal, defaults }) => {
      const diagnostic = vi.spyOn(defaults.logger, "error");
      try {
        const response = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        const body = await response.json();
        const entries = journal.getAll();
        const metrics = defaults.registry?.serialize() ?? "";
        console.log(
          JSON.stringify({
            cell: "A2-A1",
            status: response.status,
            body,
            entries,
            diagnostics: diagnostic.mock.calls,
            metrics,
          }),
        );
        expect(response.status).toBe(501);
        expect(body.error.code).toBe("aimock_misbehavior_not_applicable");
        expect(entries).toHaveLength(1);
        expect(entries[0].response.misbehavior?.evaluations).toEqual([]);
        expect(
          metrics.split("\n").filter((line) => line.startsWith("aimock_misbehavior_total{")),
        ).toEqual([]);
        expect(diagnostic).toHaveBeenCalledTimes(1);
        expect(String(diagnostic.mock.calls[0][0])).toContain("aimock_misbehavior_not_applicable");
      } finally {
        diagnostic.mockRestore();
      }
    },
  );
});

const nonchatCases: Array<{ cell: string; response: FixtureResponse; status: number }> = [
  {
    cell: "factory-error",
    response: { error: { message: "authored failure" }, status: 409 },
    status: 409,
  },
  { cell: "audio", response: { audio: { b64Json: "AA==" } }, status: 422 },
  { cell: "unknown", response: { json: { hello: "world" } }, status: 500 },
];

test.each(nonchatCases)(
  "A2 review A2 real scoped $cell keeps one observation",
  async ({ cell, response: result, status }) => {
    let factoryCalls = 0;
    const fixture: Fixture = {
      match: {},
      response: () => {
        factoryCalls++;
        return result;
      },
    };
    await withDirectRuntime(
      fixture,
      async ({ url, journal, defaults }) => {
        const diagnostic = vi.spyOn(defaults.logger, "debug");
        try {
          const response = await fetch(`${url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
          });
          const body = await response.json();
          const entries = journal.getAll();
          const metrics = defaults.registry?.serialize() ?? "";
          console.log(
            JSON.stringify({
              cell: `A2-A2-${cell}`,
              status: response.status,
              body,
              entries,
              metrics,
              diagnostics: diagnostic.mock.calls,
              factoryCalls,
            }),
          );
          expect(response.status).toBe(status);
          expect(entries).toHaveLength(1);
          expect(factoryCalls).toBe(1);
          expect(entries[0].response.misbehavior).toMatchObject({
            applied: false,
            reason: "not-applicable",
            evaluations: [
              {
                entryIndex: 0,
                fault: "tool-args-invalid-json",
                outcome: "skipped",
                reason: "not-applicable",
              },
            ],
          });
          expect(entries[0].response.misbehavior?.evaluations[0].ordinal).toBeUndefined();
          expect(
            metrics.split("\n").filter((line) => line.startsWith("aimock_misbehavior_total{")),
          ).toHaveLength(1);
          expect(metrics).toContain(
            'aimock_misbehavior_total{fault="tool-args-invalid-json",outcome="skipped:not-applicable",wire="openai-chat"} 1',
          );
          expect(
            diagnostic.mock.calls.filter((args) => String(args[0]).startsWith("[misbehavior]")),
          ).toHaveLength(1);
          // The skipped non-chat response must not spend the scoped firing budget.
          fixture.response = { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] };
          const followup = await fetch(`${url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
          });
          expect(followup.status).toBe(200);
          const selected = journal.getAll()[1].response.misbehavior;
          expect(selected).toMatchObject({ applied: true, ordinal: 0 });
        } finally {
          diagnostic.mockRestore();
        }
      },
      true,
    );
  },
);

for (const stream of [false, true]) {
  test.each([true, false])(
    `A2 review A3 real reasoning usage strict=%s stream=${stream}`,
    async (strict) => {
      const usages: number[] = [];
      const expectedUsages: number[] = [];
      for (const reasoning of ["Short.", "Long reasoning. ".repeat(60)]) {
        const stored = {
          toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }],
          reasoning,
          usage: { prompt_tokens: 901, completion_tokens: 902, total_tokens: 1803 },
        };
        const snapshot = structuredClone(stored);
        await withDirectRuntime(
          { match: {}, response: stored },
          async ({ url, defaults }) => {
            const diagnostic = vi.spyOn(defaults.logger, strict ? "error" : "warn");
            try {
              const client = new OpenAI({
                apiKey: "local",
                baseURL: `${url}/v1`,
                maxRetries: 0,
                defaultHeaders: { "X-AIMock-Strict": String(strict) },
              });
              let reasoningOutput = "";
              let usage: OpenAI.Completions.CompletionUsage | undefined;
              if (stream) {
                const response = await client.chat.completions.create({
                  ...request,
                  stream: true,
                  stream_options: { include_usage: true },
                });
                for await (const chunk of response) {
                  usage = chunk.usage ?? usage;
                  for (const choice of chunk.choices) {
                    if (
                      "reasoning_content" in choice.delta &&
                      typeof choice.delta.reasoning_content === "string"
                    )
                      reasoningOutput += choice.delta.reasoning_content;
                  }
                }
              } else {
                const response = await client.chat.completions.create(request);
                usage = response.usage;
                const message = response.choices[0].message;
                if ("reasoning_content" in message && typeof message.reasoning_content === "string")
                  reasoningOutput = message.reasoning_content;
              }
              console.log(
                JSON.stringify({
                  cell: "A2-A3",
                  strict,
                  stream,
                  reasoning,
                  reasoningOutput,
                  usage,
                  diagnostics: diagnostic.mock.calls,
                }),
              );
              expect(reasoningOutput).toBe(strict ? "" : reasoning);
              expect(usage?.prompt_tokens).toBe(2);
              const emitted = 'weather{"city":' + (strict ? "" : reasoning);
              expectedUsages.push(Math.max(1, Math.ceil(emitted.length / 4)));
              expect(diagnostic).toHaveBeenCalledTimes(1);
              expect(stored).toEqual(snapshot);
              usages.push(usage?.completion_tokens ?? -1);
            } finally {
              diagnostic.mockRestore();
            }
          },
          true,
        );
      }
      expect(usages).toEqual(expectedUsages);
      if (strict) expect(usages[0]).toBe(usages[1]);
      else expect(usages[1]).toBeGreaterThan(usages[0]);
    },
  );
}

async function installV1Runtime(url: string, config: MisbehaviorConfig) {
  const response = await fetch(`${url}/__aimock/misbehavior`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const body: unknown = await response.json();
  console.log(JSON.stringify({ cell: "V1 runtime install", status: response.status, body }));
  expect(response.status).toBe(200);
}

async function assertV1NativeError(operation: Promise<unknown>) {
  const result = await operation.then(
    (value) => ({ kind: "success", value }),
    (error: unknown) => ({ kind: "error", error }),
  );
  console.log(JSON.stringify({ cell: "V1 E-MB1", result }));
  expect(result).toMatchObject({
    kind: "error",
    error: {
      status: 501,
      code: "aimock_misbehavior_not_applicable",
      type: "invalid_request_error",
    },
  });
}

const v1InapplicableK1 = [
  { cell: "empty-object-single-quotes", args: "{}", style: "single-quotes" },
  { cell: "empty-array-single-quotes", args: "[]", style: "single-quotes" },
  { cell: "numeric-valid-prefix", args: "1234", style: "truncated" },
] as const;
for (const stream of [false, true]) {
  test.each(v1InapplicableK1)(
    `V1 real K1 $cell explicit/runtime budget stream=${stream}`,
    async ({ args, style }) => {
      let currentArgs: string = args;
      await withRuntimeServer(
        [
          {
            match: {},
            response: () => ({ toolCalls: [{ ...weatherCall, arguments: currentArgs }] }),
          },
        ],
        async ({ url, mock }) => {
          const client = new OpenAI({ apiKey: "local", baseURL: `${url}/v1`, maxRetries: 0 });
          await assertV1NativeError(
            client.chat.completions.create(
              { ...request, stream },
              { headers: { "X-AIMock-Misbehavior": `tool-args-invalid-json; style=${style}` } },
            ),
          );
          await installV1Runtime(url, {
            faults: [{ fault: "tool-args-invalid-json", style, times: 1 }],
          });
          const skipped = await readToolOutput(client, stream);
          expect(skipped.calls[0].arguments).toBe(args);
          expect(mock.getRequests().at(-1)?.response?.misbehavior).toMatchObject({
            applied: false,
            evaluations: [{ outcome: "skipped", reason: "not-applicable" }],
          });
          currentArgs = weatherCall.arguments;
          const applied = await readToolOutput(client, stream);
          expect(() => JSON.parse(applied.calls[0].arguments)).toThrow(SyntaxError);
          expect(mock.getRequests().at(-1)?.response?.misbehavior).toMatchObject({
            applied: true,
            ordinal: 0,
          });
          const exhausted = await readToolOutput(client, stream);
          expect(exhausted.calls[0].arguments).toBe(weatherCall.arguments);
          expect(mock.getRequests().at(-1)?.response?.misbehavior).toMatchObject({
            applied: false,
            evaluations: [{ outcome: "skipped", reason: "times-exhausted" }],
          });
          console.log(
            JSON.stringify({
              cell: "V1 K1 budget",
              stream,
              style,
              args,
              journal: mock.getRequests(),
            }),
          );
        },
      );
    },
  );
  test.each(["empty", "missing"] as const)(
    `V1 real K1 %s arguments default stream=${stream}`,
    async (kind) => {
      await withRuntimeServer(
        [
          {
            match: {},
            misbehavior: "tool-args-invalid-json",
            response: () => {
              const call = { ...weatherCall, arguments: "" };
              if (kind === "missing") Reflect.deleteProperty(call, "arguments");
              return { toolCalls: [call] };
            },
          },
        ],
        async ({ url }) => {
          const client = new OpenAI({ apiKey: "local", baseURL: `${url}/v1`, maxRetries: 0 });
          const output = await readToolOutput(client, stream);
          expect(output.calls[0].arguments).toBe("{");
          expect(() => JSON.parse(output.calls[0].arguments)).toThrow(SyntaxError);
        },
      );
    },
  );
  test(`V1 real mixed K2 missing schema then K1 fixture error/runtime skip stream=${stream}`, async () => {
    const config: MisbehaviorConfig = {
      faults: [
        { fault: "tool-args-schema-violation", violation: "missing-required", times: 1 },
        { fault: "tool-args-invalid-json", times: 1 },
      ],
    };
    await withFaultFixture(config, async ({ client }) => {
      await assertV1NativeError(
        client.chat.completions.create({ ...schemaRequest(undefined), stream }),
      );
    });
    await withFaultFixture(undefined, async ({ client, url, mock }) => {
      await installV1Runtime(url, config);
      expect(await readSchemaOutput(client, undefined, stream)).toBe('{"city":');
      expect(mock.getRequests().at(-1)?.response?.misbehavior).toMatchObject({
        applied: true,
        evaluations: [
          { entryIndex: 0, outcome: "skipped", reason: "not-applicable" },
          { entryIndex: 1, outcome: "applied", ordinal: 0 },
        ],
      });
      expect(await readSchemaOutput(client, request.tools[0].function.parameters, stream)).toBe(
        "{}",
      );
      expect(mock.getRequests().at(-1)?.response?.misbehavior).toMatchObject({
        applied: true,
        fault: "tool-args-schema-violation",
        ordinal: 0,
      });
      console.log(JSON.stringify({ cell: "V1 mixed budget", stream, journal: mock.getRequests() }));
    });
  });
}

async function readV1K3Name(client: OpenAI, stream: boolean, declared: boolean) {
  const input = { ...request, tools: declared ? request.tools : [] };
  if (!stream) {
    const { data, response } = await client.chat.completions.create(input).withResponse();
    console.log(JSON.stringify({ cell: "V1 K3", stream, declared, status: response.status, data }));
    expect(data.choices[0].finish_reason).toBe("tool_calls");
    return data.choices[0].message.tool_calls?.[0].function.name;
  }
  const { data, response } = await client.chat.completions
    .create({ ...input, stream: true })
    .withResponse();
  const raw = response.clone().text();
  let name = "";
  let finish: string | null = null;
  for await (const chunk of data)
    for (const choice of chunk.choices) {
      name += choice.delta.tool_calls?.[0].function?.name ?? "";
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  const wire = await raw;
  console.log(JSON.stringify({ cell: "V1 K3", stream, declared, status: response.status, wire }));
  expect(
    wire
      .trim()
      .split(/\r?\n\r?\n/)
      .at(-1),
  ).toBe("data: [DONE]");
  expect(finish).toBe("tool_calls");
  return name;
}

for (const stream of [false, true]) {
  test(`V1 real K3 declared explicit name fixture error/runtime budget stream=${stream}`, async () => {
    const config: MisbehaviorConfig = {
      faults: [{ fault: "tool-unknown-name", name: "weather", times: 1 }],
    };
    await withFaultFixture(
      config,
      async ({ client }) => {
        await assertV1NativeError(client.chat.completions.create({ ...request, stream }));
      },
      { response: { toolCalls: [backupCall] } },
    );
    await withFaultFixture(
      undefined,
      async ({ client, url, mock }) => {
        await installV1Runtime(url, config);
        expect(await readV1K3Name(client, stream, true)).toBe("backup");
        expect(mock.getRequests().at(-1)?.response?.misbehavior).toMatchObject({
          applied: false,
          evaluations: [{ outcome: "skipped", reason: "not-applicable" }],
        });
        expect(await readV1K3Name(client, stream, false)).toBe("weather");
        expect(mock.getRequests().at(-1)?.response?.misbehavior).toMatchObject({
          applied: true,
          ordinal: 0,
        });
        expect(await readV1K3Name(client, stream, false)).toBe("backup");
        expect(mock.getRequests().at(-1)?.response?.misbehavior).toMatchObject({
          applied: false,
          evaluations: [{ outcome: "skipped", reason: "times-exhausted" }],
        });
        console.log(JSON.stringify({ cell: "V1 K3 budget", stream, journal: mock.getRequests() }));
      },
      { response: { toolCalls: [backupCall] } },
    );
  });
}
