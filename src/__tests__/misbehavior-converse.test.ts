import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
  type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { expect, test } from "vitest";
import { withFaultFixture } from "./helpers/misbehavior-server.js";
import type { FixtureFileResponse, MisbehaviorFault } from "../types.js";

const request: ConverseCommandInput = {
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  messages: [{ role: "user", content: [{ text: "weather" }] }],
  toolConfig: {
    tools: [
      {
        toolSpec: {
          name: "weather",
          inputSchema: {
            json: {
              type: "object",
              properties: { city: { type: "string", enum: ["Paris", "London"] } },
              required: ["city"],
              additionalProperties: false,
            },
          },
        },
      },
    ],
  },
};
const tool = { name: "weather", arguments: { city: "Paris" } };
const shapes: { shape: string; response: FixtureFileResponse }[] = [
  { shape: "tool", response: { toolCalls: [tool] } },
  { shape: "combined", response: { content: "Before", toolCalls: [tool] } },
  {
    shape: "blocks",
    response: {
      blocks: [
        { type: "text", text: "Before" },
        { type: "toolCall", ...tool },
        { type: "text", text: "After" },
      ],
    },
  },
];
const faults: MisbehaviorFault[] = [
  { fault: "tool-args-invalid-json", style: "truncated" },
  { fault: "tool-args-invalid-json", style: "trailing-comma" },
  { fault: "tool-args-invalid-json", style: "single-quotes" },
  { fault: "tool-args-schema-violation", violation: "missing-required", property: "city" },
  { fault: "tool-args-schema-violation", violation: "wrong-type", property: "city" },
  { fault: "tool-args-schema-violation", violation: "extra-property", property: "extra" },
  { fault: "tool-args-schema-violation", violation: "enum-mismatch", property: "city" },
  { fault: "tool-unknown-name" },
  { fault: "tool-call-id-duplicate" },
  { fault: "empty-response" },
  { fault: "content-filter" },
  { fault: "reasoning-only", reasoning: "Thinking carefully" },
];

function clientFor(url: string) {
  return new BedrockRuntimeClient({
    endpoint: url,
    region: "us-east-1",
    maxAttempts: 1,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    requestHandler: new NodeHttpHandler(),
  });
}
async function sdkRead(client: BedrockRuntimeClient, stream: boolean) {
  const calls: { id?: string; name?: string; arguments: string }[] = [];
  const order: string[] = [];
  let text = "";
  let reasoning = "";
  if (!stream) {
    const output = await client.send(new ConverseCommand(request), {
      abortSignal: AbortSignal.timeout(5000),
    });
    for (const block of output.output?.message?.content ?? []) {
      if (block.toolUse) {
        calls.push({
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          arguments: JSON.stringify(block.toolUse.input),
        });
        order.push("tool");
      }
      if (block.text !== undefined) {
        text += block.text;
        order.push("text");
      }
      if (block.reasoningContent?.reasoningText) {
        reasoning += block.reasoningContent.reasoningText.text;
        order.push("reasoning");
      }
    }
    return {
      calls,
      order,
      text,
      reasoning,
      stop: output.stopReason,
      usage: output.usage,
      events: [],
      status: output.$metadata.httpStatusCode,
    };
  }
  const output = await client.send(new ConverseStreamCommand(request), {
    abortSignal: AbortSignal.timeout(5000),
  });
  const events: ConverseStreamOutput[] = [];
  const indices = new Map<number, number>();
  for await (const event of output.stream ?? []) {
    events.push(event);
    if (event.contentBlockStart?.start?.toolUse) {
      const start = event.contentBlockStart;
      indices.set(start.contentBlockIndex!, calls.length);
      calls.push({
        id: start.start!.toolUse!.toolUseId,
        name: start.start!.toolUse!.name,
        arguments: "",
      });
      order.push("tool");
    }
    if (event.contentBlockDelta) {
      const { contentBlockIndex, delta } = event.contentBlockDelta;
      if (delta?.toolUse) calls[indices.get(contentBlockIndex!)!].arguments += delta.toolUse.input;
      if (delta?.text !== undefined) {
        text += delta.text;
        order.push("text");
      }
      if (delta?.reasoningContent?.text !== undefined) {
        reasoning += delta.reasoningContent.text;
        order.push("reasoning");
      }
    }
  }
  return {
    calls,
    order,
    text,
    reasoning,
    stop: events.find((event) => event.messageStop)?.messageStop?.stopReason,
    usage: events.at(-1)?.metadata?.usage,
    events,
    status: output.$metadata.httpStatusCode,
  };
}

async function exercise(
  fault: MisbehaviorFault | undefined,
  response: FixtureFileResponse,
  stream: boolean,
) {
  await withFaultFixture(
    fault ? { faults: [fault] } : undefined,
    async ({ mock, url }) => {
      const client = clientFor(url);
      try {
        const raw = await fetch(
          `${url}/model/${encodeURIComponent(request.modelId!)}/converse${stream ? "-stream" : ""}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(5000),
          },
        );
        const bytes = Buffer.from(await raw.arrayBuffer());
        console.log(
          JSON.stringify({
            fault,
            stream,
            response,
            rawStatus: raw.status,
            rawBody: bytes.toString(stream && raw.status === 200 ? "base64" : "utf8"),
            rawJournal: mock.getLastRequest(),
          }),
        );
        expect.soft(raw.status).toBe(200);
        const result = await sdkRead(client, stream);
        const summary = mock.getLastRequest()?.response.misbehavior;
        console.log(JSON.stringify({ fault, stream, result, summary }));
        expect(result.status).toBe(200);
        expect(mock.getRequests()).toHaveLength(2);
        if (fault) {
          expect(summary).toMatchObject({
            applied: true,
            wire: "bedrock-converse",
            evaluations: [{ outcome: "applied", ordinal: 1 }],
          });
          expect(summary?.servedToolCalls).toEqual(
            result.calls.map((call) => ({
              name: call.name,
              arguments: call.arguments,
              id: call.id,
            })),
          );
          expect(result.usage?.inputTokens).toBeGreaterThan(0);
          if (stream) {
            expect(result.events[0].messageStart).toBeDefined();
            expect(result.events.at(-1)?.metadata).toBeDefined();
          }
        } else {
          expect(summary).toBeUndefined();
          expect(result.usage?.inputTokens).toBe(0);
        }
        switch (fault?.fault) {
          case "tool-args-invalid-json":
            if (stream) {
              expect(result.calls).toHaveLength(1);
              expect(() => JSON.parse(result.calls[0].arguments)).toThrow();
              expect(result.stop).toBe("tool_use");
            } else {
              expect(result.calls).toEqual([]);
              expect(result.stop).toBe("malformed_tool_use");
            }
            break;
          case "tool-args-schema-violation": {
            const args = JSON.parse(result.calls[0].arguments);
            if (fault.violation === "missing-required") expect(args).not.toHaveProperty("city");
            if (fault.violation === "wrong-type") expect(typeof args.city).not.toBe("string");
            if (fault.violation === "extra-property") expect(args).toHaveProperty("extra");
            if (fault.violation === "enum-mismatch")
              expect(["Paris", "London"]).not.toContain(args.city);
            if (fault.violation === "not-object") expect(typeof args).toBe("string");
            expect(result.stop).toBe("tool_use");
            break;
          }
          case "tool-unknown-name":
            expect(result.calls[0].name).toBe("weather_v2");
            break;
          case "tool-call-id-duplicate":
            expect(result.calls).toHaveLength(2);
            expect(result.calls[0].id).toBeTruthy();
            expect(result.calls[1].id).toBe(result.calls[0].id);
            break;
          case "empty-response":
            expect(result.calls).toEqual([]);
            expect(result.text).toBe("");
            expect(result.reasoning).toBe("");
            expect(result.order).toEqual([]);
            expect(result.stop).toBe("end_turn");
            break;
          case "content-filter":
            expect(result.calls).toEqual([]);
            expect(result.order).toEqual([]);
            expect(result.stop).toBe("content_filtered");
            break;
          case "reasoning-only": {
            expect(result.calls).toEqual([]);
            expect(result.text).toBe("");
            const expectedReasoning =
              fault.reasoning ??
              ("reasoning" in response ? response.reasoning : undefined) ??
              "Thinking...";
            expect(result.reasoning).toBe(expectedReasoning);
            if (stream) {
              expect(bytes.includes(Buffer.from('"start":{"reasoningContent":{}}'))).toBe(true);
              expect(result.events.filter((event) => event.contentBlockStart)).toHaveLength(1);
              expect(result.events.filter((event) => event.contentBlockStop)).toEqual([
                { contentBlockStop: { contentBlockIndex: 0 } },
              ]);
            } else {
              expect(JSON.parse(bytes.toString())).toMatchObject({
                output: {
                  message: {
                    content: [{ reasoningContent: { reasoningText: { text: expectedReasoning } } }],
                  },
                },
              });
              expect(result.order).toEqual(["reasoning"]);
            }
            expect(result.order.every((part) => part === "reasoning")).toBe(true);
            expect(result.stop).toBe("max_tokens");
            break;
          }
          case "stop-length-mid-tool":
            expect(result.calls[0].arguments).toBe(stream ? '{"city":' : "{}");
            expect(result.stop).toBe("max_tokens");
            expect(result.text).not.toContain("After");
            break;
          default:
            expect(JSON.parse(result.calls[0].arguments)).toEqual({ city: "Paris" });
            expect(result.stop).toBe("tool_use");
        }
      } finally {
        client.destroy();
      }
    },
    { response },
  );
}
const cells = shapes.flatMap(({ shape, response }) =>
  [false, true].flatMap((stream) =>
    faults.map((fault) => ({ shape, response, stream, fault, label: JSON.stringify(fault) })),
  ),
);
test.each(cells)(
  "Converse fault $label $shape stream=$stream",
  async ({ fault, response, stream }) => exercise(fault, response, stream),
);
test.each(shapes.flatMap((shape) => [false, true].map((stream) => ({ ...shape, stream }))))(
  "Converse no-config $shape stream=$stream",
  async ({ response, stream }) => exercise(undefined, response, stream),
);
test.each(shapes)("ConverseStream K1 value cell $shape", async ({ response }) =>
  exercise({ fault: "tool-args-invalid-json" }, response, true),
);
test.each(shapes)("ConverseStream K5 partial input $shape", async ({ response }) =>
  exercise({ fault: "stop-length-mid-tool" }, response, true),
);
test("ConverseStream K2 not-object", async () =>
  exercise(
    { fault: "tool-args-schema-violation", violation: "not-object" },
    shapes[0].response,
    true,
  ));

test.each([false, true])("Converse times/usage/immutability stream=%s", async (stream) => {
  await withFaultFixture(
    { faults: [{ fault: "tool-unknown-name", times: 1 }] },
    async ({ mock, url }) => {
      const client = clientFor(url);
      const original = JSON.stringify(mock.getFixtures());
      try {
        const first = await sdkRead(client, stream);
        expect(first.calls[0].name).toBe("weather_v2");
        expect(first.usage?.inputTokens).toBe(2);
        expect(first.usage?.outputTokens).toBe(
          Math.ceil(("weather_v2" + '{"city":"Paris"}').length / 4),
        );
        expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
          applied: true,
          ordinal: 0,
        });
        const second = await sdkRead(client, stream);
        expect(second.calls[0].name).toBe("weather");
        expect(second.usage).toMatchObject({ inputTokens: 99, outputTokens: 77, totalTokens: 176 });
        expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
          applied: false,
          reason: "times-exhausted",
        });
        expect(mock.getLastRequest()?.response.misbehavior).not.toHaveProperty("ordinal");
        expect(mock.getRequests()).toHaveLength(2);
        expect(JSON.stringify(mock.getFixtures())).toBe(original);
        console.log(
          JSON.stringify({
            cell: "times/usage/immutability",
            stream,
            first,
            second,
            journal: mock.getRequests(),
          }),
        );
      } finally {
        client.destroy();
      }
    },
    { response: { toolCalls: [tool], usage: { input_tokens: 99, output_tokens: 77 } } },
  );
});

test.each([false, true])("Converse K4 non-first selector stream=%s", async (stream) => {
  await withFaultFixture(
    { faults: [{ fault: "tool-call-id-duplicate", tool: "second" }] },
    async ({ mock, url }) => {
      const client = clientFor(url);
      try {
        const result = await sdkRead(client, stream);
        expect(result.calls.map((call) => call.name)).toEqual(["weather", "second", "third"]);
        expect(result.calls[0].id).toBe("first_id");
        expect(result.calls[1].id).toBeTruthy();
        expect(result.calls[2].id).toBe(result.calls[1].id);
        expect(result.calls[1].id).not.toBe(result.calls[0].id);
        expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls).toEqual(result.calls);
        console.log(
          JSON.stringify({ cell: "K4 non-first", stream, result, journal: mock.getRequests() }),
        );
      } finally {
        client.destroy();
      }
    },
    {
      response: {
        blocks: [
          { type: "toolCall", ...tool, id: "first_id" },
          { type: "text", text: "middle" },
          { type: "toolCall", name: "second", arguments: {} },
          { type: "toolCall", name: "third", arguments: {}, id: "third_id" },
        ],
      },
    },
  );
});

test.each([false, true])(
  "Converse K2 not-object permanent mode limit stream=%s",
  async (stream) => {
    if (stream)
      return exercise(
        { fault: "tool-args-schema-violation", violation: "not-object" },
        shapes[0].response,
        true,
      );
    await withFaultFixture(
      { faults: [{ fault: "tool-args-schema-violation", violation: "not-object" }] },
      async ({ mock, url }) => {
        const client = clientFor(url);
        try {
          await expect(sdkRead(client, false)).rejects.toMatchObject({
            name: "InternalServerException",
            $metadata: { httpStatusCode: 501 },
          });
          expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
            applied: false,
            reason: "unsupported-on-wire",
          });
          expect(mock.getRequests()).toHaveLength(1);
        } finally {
          client.destroy();
        }
      },
    );
  },
);

test.each([false, true])("Converse scoped inapplicable skip stream=%s", async (stream) => {
  await withFaultFixture(undefined, async ({ mock, url }) => {
    mock.setMisbehavior({ faults: [{ fault: "tool-unknown-name", tool: "absent", times: 1 }] });
    const client = clientFor(url);
    try {
      const result = await sdkRead(client, stream);
      expect(result.calls[0].name).toBe("weather");
      expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
        applied: false,
        reason: "not-applicable",
      });
      expect(mock.getLastRequest()?.response.misbehavior).not.toHaveProperty("ordinal");
      expect(mock.getRequests()).toHaveLength(1);
    } finally {
      client.destroy();
    }
  });
});

// Live Sonnet 4.5 Converse capture (slots/S5-converse/live-k5-nonstream-*)
// carries the unfinished tool as input:{} with max_tokens, never invalid JSON.
test.each(shapes)("Converse K5 captured empty input $shape", async ({ response }) =>
  exercise({ fault: "stop-length-mid-tool" }, response, false),
);

const reasoningCases = [
  { label: "explicit empty", reasoning: "", fixtureReasoning: "Fixture reasoning" },
  { label: "fixture empty", reasoning: undefined, fixtureReasoning: "" },
  {
    label: "explicit override",
    reasoning: "Configured reasoning",
    fixtureReasoning: "Fixture reasoning",
  },
  { label: "fixture fallback", reasoning: undefined, fixtureReasoning: "Fixture reasoning" },
  { label: "default", reasoning: undefined, fixtureReasoning: undefined },
];
test.each(reasoningCases.flatMap((value) => [false, true].map((stream) => ({ ...value, stream }))))(
  "Converse reasoning-only precedence $label stream=$stream",
  async ({ reasoning, fixtureReasoning, stream }) =>
    exercise(
      { fault: "reasoning-only", reasoning },
      { content: "Must not answer", toolCalls: [tool], reasoning: fixtureReasoning },
      stream,
    ),
);
