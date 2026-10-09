import type Anthropic from "@anthropic-ai/sdk";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { expect, test } from "vitest";
import { LLMock } from "../llmock.js";
import { withClaudeFault } from "./helpers/misbehavior-claude-stage3.js";
import type { FixtureFileResponse, MisbehaviorFault } from "../types.js";

const request: Anthropic.MessageCreateParamsNonStreaming = {
  model: "claude-sonnet-4-20250514",
  max_tokens: 128,
  messages: [{ role: "user", content: "lookup" }],
  tools: [
    {
      name: "lookup",
      input_schema: {
        type: "object",
        properties: { city: { type: "string", enum: ["Paris"] } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  ],
};
const tool = { name: "lookup", arguments: { city: "Paris" } };
const branches: { name: string; response: FixtureFileResponse }[] = [
  { name: "tools", response: { toolCalls: [tool] } },
  { name: "mixed", response: { content: "Before", toolCalls: [tool] } },
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
const styles = ["truncated", "trailing-comma", "single-quotes"] as const;
const violations = [
  "missing-required",
  "wrong-type",
  "extra-property",
  "enum-mismatch",
  "not-object",
] as const;
const faults: MisbehaviorFault[] = [
  ...styles.map((style) => ({ fault: "tool-args-invalid-json" as const, style })),
  ...violations.map((violation) => ({ fault: "tool-args-schema-violation" as const, violation })),
  { fault: "tool-unknown-name" },
  { fault: "tool-call-id-duplicate" },
  { fault: "stop-length-mid-tool", at: 0.4 },
  { fault: "empty-response" },
  { fault: "refusal", message: "No." },
];
const cells = branches.flatMap(({ name, response }) =>
  faults.flatMap((fault) =>
    [false, true]
      .filter(
        (stream) =>
          stream ||
          !(
            fault.fault === "tool-args-invalid-json" ||
            (fault.fault === "tool-args-schema-violation" && fault.violation === "not-object")
          ),
      )
      .map((stream) => ({ name, response, fault, label: JSON.stringify(fault), stream })),
  ),
);

const modelId = "anthropic.claude-3-sonnet-20240229-v1:0";
const input = {
  modelId,
  contentType: "application/json",
  accept: "application/json",
  body: JSON.stringify({ ...request, model: undefined, anthropic_version: "bedrock-2023-05-31" }),
};
function awsClient(url: string) {
  return new BedrockRuntimeClient({
    endpoint: url,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler(),
  });
}
async function read(url: string, stream: boolean) {
  const events: Anthropic.RawMessageStreamEvent[] = [];
  let message: Anthropic.Message | undefined;
  let wire = "";
  if (stream) {
    const client = awsClient(url);
    try {
      const result = await client.send(new InvokeModelWithResponseStreamCommand(input), {
        abortSignal: AbortSignal.timeout(5000),
      });
      const sdkEvents = [];
      if (result.body) {
        for await (const event of result.body) {
          sdkEvents.push(event);
          expect(event.chunk?.bytes).toBeInstanceOf(Uint8Array);
          const payload = new TextDecoder().decode(event.chunk?.bytes);
          wire += payload + "\n";
          events.push(JSON.parse(payload));
        }
      }
      console.log(
        JSON.stringify({
          transport: "aws-sdk-invoke-stream",
          status: result.$metadata.httpStatusCode,
          sdkEvents,
          wire,
        }),
      );
      expect(result.$metadata.httpStatusCode).toBe(200);
    } catch (error) {
      console.log(JSON.stringify({ transport: "aws-sdk-invoke-stream", error }));
      throw error;
    } finally {
      client.destroy();
    }
  } else {
    const client = awsClient(url);
    try {
      const result = await client.send(new InvokeModelCommand(input), {
        abortSignal: AbortSignal.timeout(5000),
      });
      wire = new TextDecoder().decode(result.body);
      console.log(
        JSON.stringify({
          transport: "aws-sdk-invoke",
          status: result.$metadata.httpStatusCode,
          wire,
        }),
      );
      message = JSON.parse(wire);
    } catch (error) {
      console.log(JSON.stringify({ transport: "aws-sdk-invoke", error }));
      throw error;
    } finally {
      client.destroy();
    }
  }
  const argumentsText = events
    .flatMap((event) =>
      event.type === "content_block_delta" && event.delta.type === "input_json_delta"
        ? [event.delta.partial_json]
        : [],
    )
    .join("");
  const tools =
    message?.content.filter((block) => block.type === "tool_use") ??
    events.flatMap((event) =>
      event.type === "content_block_start" && event.content_block.type === "tool_use"
        ? [event.content_block]
        : [],
    );
  const terminal = events.find((event) => event.type === "message_delta");
  return {
    events,
    message,
    argumentsText,
    tools,
    wire,
    stop:
      message?.stop_reason ??
      (terminal?.type === "message_delta" ? terminal.delta.stop_reason : undefined),
  };
}

test.each(cells)(
  "Invoke $name $label stream=$stream",
  async ({ response, fault, stream, name }) => {
    await withClaudeFault(
      { faults: [fault] },
      async ({ url, mock }) => {
        const result = await read(url, stream);
        const summary = mock.getLastRequest()?.response.misbehavior;
        const start = result.events.find((event) => event.type === "message_start");
        const usage =
          result.message?.usage ??
          (start?.type === "message_start" ? start.message.usage : undefined);
        expect(usage?.input_tokens).not.toBe(9999);
        expect(usage?.output_tokens).not.toBe(9999);
        expect(typeof usage?.input_tokens).toBe("number");
        expect(typeof usage?.output_tokens).toBe("number");
        console.log(JSON.stringify({ name, fault, stream, result, summary }));
        expect(mock.getRequests()).toHaveLength(1);
        expect(summary).toMatchObject({
          applied: true,
          wire: "bedrock-invoke",
          evaluations: [{ outcome: "applied", ordinal: 0 }],
        });
        if (fault.fault === "empty-response" || fault.fault === "refusal") {
          expect(result.tools).toHaveLength(0);
          expect(summary?.servedToolCalls).toEqual([]);
          expect(
            result.message?.content ??
              result.events.filter((event) => event.type === "content_block_start"),
          ).toEqual([]);
          expect(result.stop).toBe(fault.fault === "refusal" ? "refusal" : "end_turn");
          if (fault.fault === "refusal")
            expect(result.wire).toContain(
              '"stop_details":{"type":"refusal","category":null,"explanation":"No."}',
            );
          return;
        }
        if (fault.fault === "stop-length-mid-tool") {
          expect(result.stop).toBe("max_tokens");
          expect(result.tools).toHaveLength(1);
          if (stream) {
            expect(JSON.stringify(tool.arguments).startsWith(result.argumentsText)).toBe(true);
            expect(result.argumentsText.length).toBeGreaterThan(0);
            expect(() => JSON.parse(result.argumentsText)).toThrow();
            expect(result.events).not.toContainEqual(
              expect.objectContaining({
                type: "content_block_stop",
                index: name === "mixed" ? 1 : 0,
              }),
            );
            expect(summary?.servedToolCalls?.[0]?.arguments).toBe(result.argumentsText);
          } else {
            expect(result.tools[0]?.input).toEqual({});
            expect(summary?.servedToolCalls?.[0]?.arguments).toBe("{}");
          }
          return;
        }
        expect(result.stop).toBe("tool_use");
        expect(result.tools.length).toBe(fault.fault === "tool-call-id-duplicate" ? 2 : 1);
        expect(summary?.servedToolCalls?.map((call) => call.id)).toEqual(
          result.tools.map((call) => call.id),
        );
        expect(result.tools[0]?.name).toBe(
          fault.fault === "tool-unknown-name" ? "lookup_v2" : "lookup",
        );
        if (fault.fault === "tool-call-id-duplicate") {
          expect(result.tools[0]?.id).toBeTruthy();
          expect(result.tools[0]?.id).toBe(result.tools[1]?.id);
        }
        if (fault.fault === "tool-args-invalid-json") {
          expect(result.argumentsText.length).toBeGreaterThan(0);
          expect(() => JSON.parse(result.argumentsText)).toThrow();
          expect(summary?.servedToolCalls?.[0]?.arguments).toBe(result.argumentsText);
        }
        if (fault.fault === "tool-args-schema-violation") {
          const value = stream ? JSON.parse(result.argumentsText) : result.tools[0]?.input;
          switch (fault.violation) {
            case "missing-required":
              expect(value).not.toHaveProperty("city");
              break;
            case "wrong-type":
              expect(typeof value.city).not.toBe("string");
              break;
            case "extra-property":
              expect(Object.keys(value).length).toBeGreaterThan(1);
              break;
            case "enum-mismatch":
              expect(value.city).not.toBe("Paris");
              break;
            case "not-object":
              expect(Array.isArray(value) || value === null || typeof value !== "object").toBe(
                true,
              );
              break;
          }
          expect(summary?.servedToolCalls?.[0]?.arguments).toBe(JSON.stringify(value));
        }
      },
      { ...response, usage: { input_tokens: 9999, output_tokens: 9999 } },
    );
  },
);

test.each(branches)(
  "Invoke ordinary $name keeps authored usage and arguments",
  async ({ response }) => {
    await withClaudeFault(
      undefined,
      async ({ url, mock }) => {
        for (const stream of [false, true]) {
          const result = await read(url, stream);
          expect(result.tools[0]?.name).toBe("lookup");
          expect(stream ? JSON.parse(result.argumentsText) : result.tools[0]?.input).toEqual({
            city: "Paris",
          });
          expect(mock.getLastRequest()?.response).not.toHaveProperty("misbehavior");
          const start = result.events.find((event) => event.type === "message_start");
          expect(
            result.message?.usage ??
              (start?.type === "message_start" ? start.message.usage : undefined),
          ).toMatchObject({ input_tokens: 321, output_tokens: 654 });
        }
      },
      { ...response, usage: { input_tokens: 321, output_tokens: 654 } },
    );
  },
);

test("Invoke ordinary official AWS streaming SDK exposes PayloadPart bytes", async () => {
  await withClaudeFault(undefined, async ({ url }) => {
    const client = awsClient(url);
    try {
      const result = await client.send(new InvokeModelWithResponseStreamCommand(input), {
        abortSignal: AbortSignal.timeout(5000),
      });
      const events = [];
      if (result.body) for await (const event of result.body) events.push(event);
      console.log(
        JSON.stringify({
          blocker: "AWS-PayloadPart-envelope",
          status: result.$metadata.httpStatusCode,
          events,
        }),
      );
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((event) => event.chunk?.bytes?.length)).toBe(true);
    } finally {
      client.destroy();
    }
  });
});

for (const stream of [false, true]) {
  test(`Invoke K4 named wrapped source preserves ordered blocks and prepared metadata stream=${stream}`, async () => {
    const response: FixtureFileResponse = {
      blocks: [
        { type: "text", text: "Before" },
        { type: "toolCall", name: "first", arguments: { city: "Paris" } },
        { type: "text", text: "Middle" },
        { type: "toolCall", name: "lookup", arguments: { city: "Paris" } },
        { type: "toolCall", name: "last", arguments: { city: "Paris" } },
      ],
    };
    await withClaudeFault(
      { faults: [{ fault: "tool-call-id-duplicate", tool: "last" }] },
      async ({ url, mock }) => {
        const original = JSON.stringify(mock.getFixtures());
        const result = await read(url, stream);
        expect(result.tools.map((tool) => tool.name)).toEqual(["first", "lookup", "last"]);
        expect(result.tools[0].id).toBeTruthy();
        expect(result.tools[0].id).toBe(result.tools[2].id);
        expect(result.tools[1].id).not.toBe(result.tools[0].id);
        expect(
          mock.getLastRequest()?.response.misbehavior?.servedToolCalls?.map((call) => call.id),
        ).toEqual(result.tools.map((tool) => tool.id));
        expect(JSON.stringify(mock.getFixtures())).toBe(original);
      },
      response,
    );
  });

  test(`Invoke applied factory resolves once and times-limited retry preserves fixture stream=${stream}`, async () => {
    let calls = 0;
    const response = { toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}' }] };
    const original = JSON.stringify(response);
    const mock = new LLMock({ port: 0, chunkSize: 2, metrics: true });
    mock.addFixture({
      match: {},
      misbehavior: { faults: [{ fault: "tool-unknown-name", times: 1 }] },
      response: () => {
        calls++;
        return response;
      },
    });
    try {
      await mock.start();
      const first = await read(mock.url, stream);
      expect(first.tools[0]?.name).toBe("lookup_v2");
      expect(calls).toBe(1);
      const second = await read(mock.url, stream);
      expect(second.tools[0]?.name).toBe("lookup");
      expect(calls).toBe(2);
      expect(mock.getRequests()).toHaveLength(2);
      expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
        applied: false,
        reason: "times-exhausted",
      });
      expect(JSON.stringify(response)).toBe(original);
      const metrics = await (await fetch(`${mock.url}/metrics`)).text();
      expect(metrics).toContain(
        'aimock_misbehavior_total{fault="tool-unknown-name",outcome="applied",wire="bedrock-invoke"} 1',
      );
      expect(metrics).toContain(
        'aimock_misbehavior_total{fault="tool-unknown-name",outcome="skipped:times-exhausted",wire="bedrock-invoke"} 1',
      );
    } finally {
      await mock.stop();
    }
  });
}

test.each<MisbehaviorFault>([
  { fault: "tool-args-invalid-json" },
  { fault: "tool-args-schema-violation", violation: "not-object" },
])("Invoke permanent object-mode limit %j fails explicitly and scoped skips", async (fault) => {
  await withClaudeFault(undefined, async ({ url, mock }) => {
    const client = awsClient(url);
    try {
      mock.setMisbehavior({ faults: [fault] });
      const normal = await read(url, false);
      expect(normal.tools[0]?.input).toEqual({ city: "Paris" });
      expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
        applied: false,
        reason: "unsupported-on-wire",
        evaluations: [{ outcome: "skipped", reason: "unsupported-on-wire" }],
      });
      expect(mock.getLastRequest()?.response.misbehavior?.ordinal).toBeUndefined();
    } finally {
      client.destroy();
    }
  });
  await withClaudeFault({ faults: [fault] }, async ({ url }) => {
    const client = awsClient(url);
    try {
      await expect(client.send(new InvokeModelCommand(input))).rejects.toMatchObject({
        name: "NotImplementedException",
        $metadata: { httpStatusCode: 501 },
      });
    } finally {
      client.destroy();
    }
  });
});

test("Invoke interrupted raw stream retains full prepared metadata", async () => {
  const mock = new LLMock({ port: 0, chunkSize: 2 });
  mock.addFixture({
    match: {},
    response: { toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}' }] },
    misbehavior: { faults: [{ fault: "tool-unknown-name" }] },
    truncateAfterChunks: 1,
  });
  try {
    await mock.start();
    let deliveryError: unknown;
    try {
      const result = await fetch(`${mock.url}/model/${modelId}/invoke-with-response-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: input.body,
        signal: AbortSignal.timeout(5000),
      });
      await result.arrayBuffer();
    } catch (error) {
      deliveryError = error;
    }
    console.log(
      JSON.stringify({ deliveryError: String(deliveryError), journal: mock.getRequests() }),
    );
    expect(mock.getRequests()).toHaveLength(1);
    expect(mock.getLastRequest()?.response).toMatchObject({
      interrupted: true,
      interruptReason: "truncateAfterChunks",
      misbehavior: {
        applied: true,
        servedToolCalls: [
          { name: "lookup_v2", arguments: '{"city":"Paris"}', id: expect.any(String) },
        ],
      },
    });
  } finally {
    await mock.stop();
  }
});

test.each<MisbehaviorFault>([
  { fault: "tool-args-invalid-json" },
  { fault: "tool-call-id-duplicate" },
  { fault: "stop-length-mid-tool", at: 0.4 },
])("Invoke PayloadPart SDK paired transport proof %j", async (fault) => {
  await withClaudeFault({ faults: [fault] }, async ({ url, mock }) => {
    const client = awsClient(url);
    try {
      const result = await client.send(new InvokeModelWithResponseStreamCommand(input), {
        abortSignal: AbortSignal.timeout(5000),
      });
      const sdkEvents = [];
      const events: Anthropic.RawMessageStreamEvent[] = [];
      if (result.body)
        for await (const event of result.body) {
          sdkEvents.push(event);
          if (event.chunk?.bytes)
            events.push(JSON.parse(new TextDecoder().decode(event.chunk.bytes)));
        }
      console.log(
        JSON.stringify({
          pairedPayloadPart: fault.fault,
          status: result.$metadata.httpStatusCode,
          sdkEvents,
          events,
          journal: mock.getRequests(),
        }),
      );
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect(sdkEvents.length).toBeGreaterThan(0);
      expect(sdkEvents.every((event) => event.chunk?.bytes?.length)).toBe(true);
      const tools = events.flatMap((event) =>
        event.type === "content_block_start" && event.content_block.type === "tool_use"
          ? [event.content_block]
          : [],
      );
      const argumentsText = events
        .flatMap((event) =>
          event.type === "content_block_delta" && event.delta.type === "input_json_delta"
            ? [event.delta.partial_json]
            : [],
        )
        .join("");
      const terminal = events.find((event) => event.type === "message_delta");
      expect(terminal?.type === "message_delta" ? terminal.delta.stop_reason : undefined).toBe(
        fault.fault === "stop-length-mid-tool" ? "max_tokens" : "tool_use",
      );
      expect(events.at(-1)?.type).toBe("message_stop");
      expect(mock.getRequests()).toHaveLength(1);
      if (fault.fault === "tool-call-id-duplicate") {
        expect(tools).toHaveLength(2);
        expect(tools[0].id).toBeTruthy();
        expect(tools[0].id).toBe(tools[1].id);
        expect(
          mock.getLastRequest()?.response.misbehavior?.servedToolCalls?.map((call) => call.id),
        ).toEqual(tools.map((call) => call.id));
      } else {
        expect(tools).toHaveLength(1);
        expect(argumentsText.length).toBeGreaterThan(0);
        expect(() => JSON.parse(argumentsText)).toThrow();
        expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls?.[0]?.arguments).toBe(
          argumentsText,
        );
      }
    } finally {
      client.destroy();
    }
  });
});

const reasoningCases: {
  name: string;
  configured?: string;
  fixture?: string;
  expected: string;
}[] = [
  {
    name: "configured precedence",
    configured: "Configured thought",
    fixture: "Fixture thought",
    expected: "Configured thought",
  },
  { name: "fixture fallback", fixture: "Fixture thought", expected: "Fixture thought" },
  { name: "default fallback", expected: "Thinking..." },
  { name: "configured empty", configured: "", fixture: "Fixture thought", expected: "" },
  { name: "fixture empty", fixture: "", expected: "" },
];

// Approved modeled contract: native Invoke K9 probes returned visible text in both modes.
// These official SDK requests exercise localhost aimock, not native AWS generation.
test.each(reasoningCases.flatMap((cell) => [false, true].map((stream) => ({ ...cell, stream }))))(
  "Invoke modeled K9 $name stream=$stream",
  async ({ name, configured, fixture, expected, stream }) => {
    const response: FixtureFileResponse = {
      content: "Forbidden answer",
      toolCalls: [tool],
      ...(fixture === undefined ? {} : { reasoning: fixture }),
      reasoningSignature: "recorded-local-signature",
      redactedThinking: ["Forbidden redacted thought"],
      usage: { input_tokens: 9999, output_tokens: 9999 },
    };
    const fault: MisbehaviorFault = {
      fault: "reasoning-only",
      ...(configured === undefined ? {} : { reasoning: configured }),
    };
    await withClaudeFault(
      { faults: [fault] },
      async ({ url, mock }) => {
        const original = JSON.stringify(mock.getFixtures());
        console.log(
          JSON.stringify({
            cell: name,
            stream,
            fault,
            response,
            expected,
            provenance: "modeled-user-approved; native-NOT_TRIGGERED",
          }),
        );
        let result: Awaited<ReturnType<typeof read>>;
        try {
          result = await read(url, stream);
        } finally {
          console.log(JSON.stringify({ cell: name, stream, journal: mock.getRequests() }));
        }
        expect(result.stop).toBe("max_tokens");
        expect(result.tools).toEqual([]);
        expect(result.wire).not.toContain("Forbidden");
        expect(result.wire).not.toContain(
          "Fixture thought" === expected ? "Configured thought" : "Fixture thought",
        );
        if (stream) {
          const blocks = result.events.flatMap((event) =>
            event.type === "content_block_start" ? [event.content_block] : [],
          );
          expect(blocks.map((block) => block.type)).toEqual(["thinking"]);
          const text = result.events
            .flatMap((event) =>
              event.type === "content_block_delta" && event.delta.type === "thinking_delta"
                ? [event.delta.thinking]
                : [],
            )
            .join("");
          expect(text).toBe(expected);
          const signatures = result.events.flatMap((event) =>
            event.type === "content_block_delta" && event.delta.type === "signature_delta"
              ? [event.delta.signature]
              : [],
          );
          expect(signatures).toHaveLength(1);
          expect(signatures[0].length).toBeGreaterThan(0);
          expect(result.events.filter((event) => event.type === "content_block_stop")).toEqual([
            { type: "content_block_stop", index: 0 },
          ]);
          expect(result.events.at(-1)).toEqual({ type: "message_stop" });
          expect(result.events.filter((event) => event.type === "message_delta")).toHaveLength(1);
        } else {
          expect(result.message?.content).toHaveLength(1);
          expect(result.message?.content[0]).toMatchObject({
            type: "thinking",
            thinking: expected,
            signature: expect.any(String),
          });
        }
        const start = result.events.find((event) => event.type === "message_start");
        const usage =
          result.message?.usage ??
          (start?.type === "message_start" ? start.message.usage : undefined);
        expect(usage?.input_tokens).toBeGreaterThan(0);
        expect(usage?.input_tokens).not.toBe(9999);
        expect(usage?.output_tokens).not.toBe(9999);
        const terminal = result.events.find((event) => event.type === "message_delta");
        const outputTokens =
          result.message?.usage.output_tokens ??
          (terminal?.type === "message_delta" ? terminal.usage.output_tokens : undefined);
        expect(outputTokens).toBe(Math.max(1, Math.ceil(expected.length / 4)));
        expect(mock.getRequests()).toHaveLength(1);
        expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
          applied: true,
          wire: "bedrock-invoke",
          fault: "reasoning-only",
          servedToolCalls: [],
          evaluations: [{ outcome: "applied", ordinal: 0 }],
        });
        expect(JSON.stringify(mock.getFixtures())).toBe(original);
        const metrics = await (await fetch(`${url}/metrics`)).text();
        expect(metrics).toContain(
          'aimock_misbehavior_total{fault="reasoning-only",outcome="applied",wire="bedrock-invoke"} 1',
        );
      },
      response,
    );
  },
);

for (const stream of [false, true]) {
  test(`Invoke modeled K9 retains latency and resolves factory once with recovery stream=${stream}`, async () => {
    const mock = new LLMock({ port: 0, chunkSize: 2, metrics: true });
    const response = {
      content: "Recovered answer",
      reasoning: "Fixture thought",
      usage: { input_tokens: 321, output_tokens: 654 },
    };
    let calls = 0;
    mock.addFixture({
      match: {},
      latency: 60,
      misbehavior: { faults: [{ fault: "reasoning-only", reasoning: "Only thought", times: 1 }] },
      response: () => {
        calls++;
        return response;
      },
    });
    try {
      await mock.start();
      const started = performance.now();
      const first = await read(mock.url, stream);
      if (stream) expect(performance.now() - started).toBeGreaterThanOrEqual(45);
      expect(first.stop).toBe("max_tokens");
      expect(first.wire).not.toContain("Recovered answer");
      expect(calls).toBe(1);
      expect(mock.getRequests()).toHaveLength(1);
      const second = await read(mock.url, stream);
      expect(second.stop).toBe("end_turn");
      const text =
        second.message?.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("") ??
        second.events
          .flatMap((event) =>
            event.type === "content_block_delta" && event.delta.type === "text_delta"
              ? [event.delta.text]
              : [],
          )
          .join("");
      expect(text).toBe("Recovered answer");
      expect(calls).toBe(2);
      expect(mock.getRequests()).toHaveLength(2);
      expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
        applied: false,
        reason: "times-exhausted",
      });
      expect(response).toEqual({
        content: "Recovered answer",
        reasoning: "Fixture thought",
        usage: { input_tokens: 321, output_tokens: 654 },
      });
    } finally {
      await mock.stop();
    }
  });
}
