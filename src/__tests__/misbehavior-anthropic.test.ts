import Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "vitest";
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

async function read(client: Anthropic, stream: boolean) {
  const events: Anthropic.RawMessageStreamEvent[] = [];
  let message: Anthropic.Message | undefined;
  if (stream) {
    for await (const event of await client.messages.create({ ...request, stream: true }))
      events.push(event);
  } else message = await client.messages.create({ ...request, stream: false });
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
    stop:
      message?.stop_reason ??
      (terminal?.type === "message_delta" ? terminal.delta.stop_reason : undefined),
  };
}

test.each(cells)(
  "Claude $name $label stream=$stream",
  async ({ response, fault, stream, name }) => {
    await withClaudeFault(
      { faults: [fault] },
      async ({ client, mock, raw }) => {
        const result = await read(client, stream);
        const summary = mock.getLastRequest()?.response.misbehavior;
        console.log(JSON.stringify({ name, fault, stream, result, raw, summary }));
        expect(mock.getRequests()).toHaveLength(1);
        expect(summary).toMatchObject({
          applied: true,
          wire: "anthropic",
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
            expect(raw[0]).toContain(
              '"stop_details":{"type":"refusal","category":null,"explanation":"No."}',
            );
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
      response,
    );
  },
);

test.each(branches)("ordinary $name keeps authored usage and arguments", async ({ response }) => {
  await withClaudeFault(
    undefined,
    async ({ client, mock }) => {
      for (const stream of [false, true]) {
        const result = await read(client, stream);
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
});

test.each(styles)("high-level SDK reaction recorded for K1 %s", async (style) => {
  await withClaudeFault(
    { faults: [{ fault: "tool-args-invalid-json", style }] },
    async ({ client, mock, raw }) => {
      let message: Anthropic.Message | undefined;
      let error: unknown;
      try {
        message = await client.messages.stream(request).finalMessage();
      } catch (caught) {
        error = caught;
      }
      console.log(
        JSON.stringify({
          style,
          message,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
          raw,
        }),
      );
      expect(mock.getLastRequest()?.response.status).toBe(200);
      expect(mock.getLastRequest()?.response.misbehavior?.applied).toBe(true);
    },
  );
});

test.each([false, true])(
  "refusal category is preserved through the native wire stream=%s",
  async (stream) => {
    await withClaudeFault(undefined, async ({ url, mock }) => {
      const response = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-aimock-misbehavior": "refusal; message=No.; category=policy",
        },
        body: JSON.stringify({ ...request, stream }),
      });
      const raw = await response.text();
      console.log(
        JSON.stringify({
          stream,
          status: response.status,
          raw,
          summary: mock.getLastRequest()?.response.misbehavior,
        }),
      );
      expect(response.status).toBe(200);
      expect(raw).toContain(
        '"stop_details":{"type":"refusal","category":"policy","explanation":"No."}',
      );
      expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls).toEqual([]);
    });
  },
);

test.each([false, true])(
  "prepared IDs and usage match the selected wrapped pair stream=%s",
  async (stream) => {
    const response: FixtureFileResponse = {
      blocks: [
        { type: "toolCall", name: "lookup", arguments: { city: "Paris" } },
        { type: "text", text: "Between" },
        { type: "toolCall", name: "second", arguments: { city: "Rome" } },
      ],
      usage: { input_tokens: 321, output_tokens: 654 },
    };
    await withClaudeFault(
      { faults: [{ fault: "tool-call-id-duplicate", tool: "second" }] },
      async ({ client, mock }) => {
        const original = JSON.stringify(mock.getFixtures());
        const result = await read(client, stream);
        const summary = mock.getLastRequest()?.response.misbehavior;
        expect(result.tools.map((call) => call.name)).toEqual(["lookup", "second"]);
        expect(result.tools[0]?.id).toBe(result.tools[1]?.id);
        expect(summary?.servedToolCalls?.map((call) => call.id)).toEqual(
          result.tools.map((call) => call.id),
        );
        expect(summary?.target).toEqual({ tool: "second", index: 1 });
        expect(JSON.stringify(mock.getFixtures())).toBe(original);
        const start = result.events.find((event) => event.type === "message_start");
        const usage =
          result.message?.usage ??
          (start?.type === "message_start" ? start.message.usage : undefined);
        expect(usage?.input_tokens).toBe(2);
        expect(usage?.output_tokens).toBe(13);
        expect(usage?.output_tokens).not.toBe(654);
        expect(
          result.message?.content.map((block) => block.type) ??
            result.events.flatMap((event) =>
              event.type === "content_block_start" ? [event.content_block.type] : [],
            ),
        ).toEqual(["tool_use", "text", "tool_use"]);
      },
      response,
    );
  },
);

test("times budget changes only the served first turn and retains the fixture", async () => {
  await withClaudeFault(
    { faults: [{ fault: "tool-unknown-name", times: 1 }] },
    async ({ client, mock }) => {
      const original = JSON.stringify(mock.getFixtures());
      const first = await read(client, false);
      expect(first.tools[0]?.name).toBe("lookup_v2");
      expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
        applied: true,
        ordinal: 0,
      });
      const second = await read(client, false);
      expect(second.tools[0]?.name).toBe("lookup");
      expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
        applied: false,
        reason: "times-exhausted",
      });
      expect(mock.getRequests()).toHaveLength(2);
      expect(JSON.stringify(mock.getFixtures())).toBe(original);
    },
  );
});

const objectWireUnsupported: MisbehaviorFault[] = [
  { fault: "tool-args-invalid-json" },
  { fault: "tool-args-schema-violation", violation: "not-object" },
];
test.each(objectWireUnsupported)("permanent nonstream guard for $fault", async (fault) => {
  await withClaudeFault({ faults: [fault] }, async ({ client, mock }) => {
    await expect(client.messages.create(request)).rejects.toMatchObject({ status: 501 });
    expect(mock.getRequests()).toHaveLength(1);
    expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
      applied: false,
      reason: "unsupported-on-wire",
    });
  });
});
test.each(objectWireUnsupported)("permanent nonstream scope skip for $fault", async (fault) => {
  await withClaudeFault(undefined, async ({ client, mock }) => {
    mock.setMisbehavior({ faults: [fault] });
    const result = await read(client, false);
    expect(result.tools[0]?.input).toEqual({ city: "Paris" });
    expect(mock.getRequests()).toHaveLength(1);
    expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
      applied: false,
      reason: "unsupported-on-wire",
    });
  });
});

// Capture: evidence/anthropic/k5-object-raw.txt (Sonnet4.5, 2026-10-08).
test("K5 object uses captured empty input and max_tokens", async () => {
  await withClaudeFault("stop-length-mid-tool", async ({ client, mock }) => {
    const result = await read(client, false);
    expect(result.stop).toBe("max_tokens");
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.input).toEqual({});
    expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls).toEqual([
      { name: "lookup", id: result.tools[0]?.id, arguments: "{}" },
    ]);
  });
});

test.each([false, true])(
  "applied factory resolves once and observes once stream=%s",
  async (stream) => {
    await withClaudeFault(undefined, async ({ client, mock, url }) => {
      const fixture = mock.getFixtures()[0];
      if (!fixture || typeof fixture.response === "function")
        throw new Error("Expected static test fixture");
      const response = fixture.response;
      let calls = 0;
      mock.clearFixtures();
      mock.addFixture({
        match: {},
        response: () => {
          calls++;
          return response;
        },
        misbehavior: "tool-unknown-name",
      });
      const result = await read(client, stream);
      expect(result.tools[0]?.name).toBe("lookup_v2");
      expect(calls).toBe(1);
      expect(mock.getRequests()).toHaveLength(1);
      expect(mock.getLastRequest()?.response.misbehavior?.evaluations).toEqual([
        { entryIndex: 0, fault: "tool-unknown-name", outcome: "applied", ordinal: 0 },
      ]);
      const metrics = await (await fetch(`${url}/metrics`)).text();
      expect(metrics).toContain('fault="tool-unknown-name",outcome="applied",wire="anthropic"} 1');
    });
  },
);

test.each([false, true])("explicit empty refusal fields remain empty stream=%s", async (stream) => {
  await withClaudeFault(undefined, async ({ url }) => {
    const result = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aimock-misbehavior": "refusal; message=; category=",
      },
      body: JSON.stringify({ ...request, stream }),
    });
    const raw = await result.text();
    expect(result.status).toBe(200);
    expect(raw).toContain('"stop_details":{"type":"refusal","category":"","explanation":""}');
  });
});

// Live captures establish omission of content_block_stop for a max_tokens-cut
// tool. The nonempty proper prefix is the modeled catalog fault (§5.1).
test.each(branches)(
  "K5 stream $name has a proper prefix and captured terminal sequence",
  async ({ response }) => {
    await withClaudeFault(
      "stop-length-mid-tool",
      async ({ client, mock, raw }) => {
        const result = await read(client, true);
        expect(result.argumentsText.length).toBeGreaterThan(0);
        expect(JSON.stringify(tool.arguments).startsWith(result.argumentsText)).toBe(true);
        expect(result.argumentsText.length).toBeLessThan(JSON.stringify(tool.arguments).length);
        expect(result.stop).toBe("max_tokens");
        const start = result.events.find(
          (event) =>
            event.type === "content_block_start" && event.content_block.type === "tool_use",
        );
        expect(start?.type).toBe("content_block_start");
        expect(
          result.events.filter(
            (event) =>
              event.type === "content_block_stop" &&
              event.index === (start?.type === "content_block_start" ? start.index : -1),
          ),
        ).toEqual([]);
        expect(result.events.at(-1)?.type).toBe("message_stop");
        expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls?.[0]?.arguments).toBe(
          result.argumentsText,
        );
        console.log(JSON.stringify({ fault: "K5-stream", result, raw }));
      },
      response,
    );
  },
);

test("K5 high-level finalMessage observes a clean max_tokens terminal", async () => {
  await withClaudeFault("stop-length-mid-tool", async ({ client, mock, raw }) => {
    const message = await client.messages.stream(request).finalMessage();
    expect(message.stop_reason).toBe("max_tokens");
    expect(mock.getLastRequest()?.response.misbehavior?.applied).toBe(true);
    console.log(JSON.stringify({ fault: "K5-finalMessage", message, raw }));
  });
});

test.each([false, true])(
  "K5 cuts selected later block, drops later output, preserves earlier blocks stream=%s",
  async (stream) => {
    await withClaudeFault(
      { faults: [{ fault: "stop-length-mid-tool", tool: "lookup" }] },
      async ({ client, mock }) => {
        const result = await read(client, stream);
        expect(result.tools.map((call) => call.name)).toEqual(["prior", "lookup"]);
        expect(result.stop).toBe("max_tokens");
        const summary = mock.getLastRequest()?.response.misbehavior;
        expect(summary?.target).toEqual({ tool: "lookup", index: 1 });
        expect(summary?.servedToolCalls).toHaveLength(2);
        if (stream) {
          expect(
            result.events
              .filter((event) => event.type === "content_block_stop")
              .map((event) => (event.type === "content_block_stop" ? event.index : -1)),
          ).toEqual([0, 1, 2]);
          const text = result.events
            .flatMap((event) =>
              event.type === "content_block_delta" && event.delta.type === "text_delta"
                ? [event.delta.text]
                : [],
            )
            .join("");
          expect(text).toBe("BeforeBetween");
        } else {
          expect(result.tools[1]?.input).toEqual({});
          expect(summary?.servedToolCalls?.[1]?.arguments).toBe("{}");
          expect(result.message?.content.map((block) => block.type)).toEqual([
            "text",
            "tool_use",
            "text",
            "tool_use",
          ]);
        }
      },
      {
        blocks: [
          { type: "text", text: "Before" },
          { type: "toolCall", name: "prior", arguments: { x: 1 } },
          { type: "text", text: "Between" },
          { type: "toolCall", ...tool },
          { type: "toolCall", name: "tail", arguments: { x: 2 } },
          { type: "text", text: "After" },
        ],
      },
    );
  },
);

// M: approved deterministic modeled K9, not a captured native no-answer response.
const k9Cases = [
  { name: "fixture empty", authored: undefined, fixture: "", expected: "" },
  {
    name: "fault precedence",
    authored: "Fault thinking",
    fixture: "Fixture thinking",
    expected: "Fault thinking",
  },
  {
    name: "fixture fallback",
    authored: undefined,
    fixture: "Fixture thinking",
    expected: "Fixture thinking",
  },
  { name: "default fallback", authored: undefined, fixture: undefined, expected: "Thinking..." },
  { name: "explicit empty", authored: "", fixture: "Fixture thinking", expected: "" },
];
const k9Cells = k9Cases.flatMap((cell) => [false, true].map((stream) => ({ ...cell, stream })));
test.each(k9Cells)(
  "modeled K9 $name stream=$stream",
  async ({ authored, fixture, expected, stream }) => {
    await withClaudeFault(
      {
        faults: [
          { fault: "reasoning-only", ...(authored === undefined ? {} : { reasoning: authored }) },
        ],
      },
      async ({ client, mock, raw }) => {
        const original = JSON.stringify(mock.getFixtures());
        const result = await read(client, stream);
        console.log(
          JSON.stringify({
            modeled: true,
            fault: "K9",
            stream,
            expected,
            result,
            raw,
            entry: mock.getLastRequest(),
          }),
        );
        expect(result.stop).toBe("max_tokens");
        expect(result.tools).toEqual([]);
        const expectedUsage = {
          input_tokens: 2,
          output_tokens: Math.max(1, Math.ceil(expected.length / 4)),
        };
        if (!stream) {
          expect(result.message?.content).toEqual([
            { type: "thinking", thinking: expected, signature: "aimock-placeholder-signature" },
          ]);
          expect(result.message?.usage).toMatchObject(expectedUsage);
        } else {
          const starts = result.events.filter((event) => event.type === "content_block_start");
          expect(starts).toEqual([
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            },
          ]);
          expect(
            result.events
              .flatMap((event) =>
                event.type === "content_block_delta" && event.delta.type === "thinking_delta"
                  ? [event.delta.thinking]
                  : [],
              )
              .join(""),
          ).toBe(expected);
          expect(
            result.events
              .flatMap((event) =>
                event.type === "content_block_delta" && event.delta.type === "signature_delta"
                  ? [event.delta.signature]
                  : [],
              )
              .join(""),
          ).toBe("aimock-placeholder-signature");
          expect(
            result.events.some(
              (event) =>
                event.type === "content_block_delta" &&
                (event.delta.type === "text_delta" || event.delta.type === "input_json_delta"),
            ),
          ).toBe(false);
          expect(result.events.map((event) => event.type)).toEqual([
            "message_start",
            "content_block_start",
            ...Array.from({ length: Math.ceil(expected.length / 2) }, () => "content_block_delta"),
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
          ]);
          const first = result.events[0];
          expect(first?.type === "message_start" ? first.message.usage : undefined).toMatchObject(
            expectedUsage,
          );
          const terminal = result.events.at(-2);
          expect(terminal).toMatchObject({
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
            usage: { output_tokens: expectedUsage.output_tokens },
          });
        }
        expect(mock.getRequests()).toHaveLength(1);
        expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
          applied: true,
          servedToolCalls: [],
          evaluations: [{ entryIndex: 0, fault: "reasoning-only", outcome: "applied", ordinal: 0 }],
        });
        expect(JSON.stringify(mock.getFixtures())).toBe(original);
      },
      {
        content: "Visible answer",
        toolCalls: [tool],
        blocks: [
          { type: "text", text: "Visible block" },
          { type: "toolCall", ...tool },
        ],
        reasoning: fixture,
        redactedThinking: ["Opaque old reasoning"],
        usage: { input_tokens: 900, output_tokens: 901 },
      },
    );
  },
);

test("modeled K9 high-level SDK preserves timing and final thinking-only output", async () => {
  await withClaudeFault(
    { faults: [{ fault: "reasoning-only", reasoning: "Thought" }] },
    async ({ url, mock }) => {
      const fixture = mock.getFixtures()[0];
      if (!fixture) throw new Error("Missing fixture");
      fixture.streamingProfile = { ttft: 60, tps: 100 };
      const client = new Anthropic({ baseURL: url, apiKey: "local", maxRetries: 0, timeout: 5000 });
      const started = performance.now();
      const stream = client.messages.stream(request);
      const times: number[] = [];
      stream.on("streamEvent", () => times.push(performance.now() - started));
      const message = await stream.finalMessage();
      console.log(JSON.stringify({ modeled: true, fault: "K9-timing", times, message }));
      expect(times[0]).toBeGreaterThanOrEqual(45);
      expect(times.at(-1)! - times[0]).toBeGreaterThanOrEqual(60);
      expect(message.stop_reason).toBe("max_tokens");
      expect(message.content).toEqual([
        { type: "thinking", thinking: "Thought", signature: "aimock-placeholder-signature" },
      ]);
    },
  );
});

test.each(["truncateAfterChunks", "disconnectAfterMs"] as const)(
  "modeled K9 %s retains prepared metadata",
  async (mode) => {
    const reasoning = "Long modeled private reasoning. ".repeat(20);
    await withClaudeFault(
      { faults: [{ fault: "reasoning-only", reasoning }] },
      async ({ url, mock }) => {
        const fixture = mock.getFixtures()[0];
        if (!fixture) throw new Error("Missing fixture");
        fixture.streamingProfile = { ttft: 10, tps: 100 };
        if (mode === "truncateAfterChunks") fixture.truncateAfterChunks = 5;
        else fixture.disconnectAfterMs = 70;
        const client = new Anthropic({
          baseURL: url,
          apiKey: "local",
          maxRetries: 0,
          timeout: 5000,
        });
        const events: Anthropic.RawMessageStreamEvent[] = [];
        await expect(
          (async () => {
            for await (const event of await client.messages.create({ ...request, stream: true }))
              events.push(event);
          })(),
        ).rejects.toThrow();
        console.log(
          JSON.stringify({
            modeled: true,
            fault: "K9-interruption",
            mode,
            events,
            entry: mock.getLastRequest(),
          }),
        );
        expect(events).toContainEqual({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        });
        expect(events.some((event) => event.type === "message_stop")).toBe(false);
        const first = events[0];
        expect(
          first?.type === "message_start" ? first.message.usage.output_tokens : undefined,
        ).toBe(Math.ceil(reasoning.length / 4));
        expect(mock.getRequests()).toHaveLength(1);
        expect(mock.getLastRequest()?.response).toMatchObject({
          status: 200,
          interrupted: true,
          interruptReason: mode,
          misbehavior: {
            applied: true,
            servedToolCalls: [],
            evaluations: [
              { entryIndex: 0, fault: "reasoning-only", outcome: "applied", ordinal: 0 },
            ],
          },
        });
      },
    );
  },
);
