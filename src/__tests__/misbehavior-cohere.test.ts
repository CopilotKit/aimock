import { CohereClientV2, type Cohere } from "cohere-ai";
import { expect, test } from "vitest";
import { withFaultFixture } from "./helpers/misbehavior-server.js";
import type { MisbehaviorFault } from "../types.js";

const cases: MisbehaviorFault[] = [
  { fault: "tool-args-invalid-json" },
  { fault: "tool-args-schema-violation", violation: "missing-required", property: "city" },
  { fault: "tool-args-schema-violation", violation: "wrong-type", property: "city" },
  { fault: "tool-args-schema-violation", violation: "enum-mismatch", property: "city" },
  { fault: "tool-args-schema-violation", violation: "not-object" },
  { fault: "tool-unknown-name", name: "missing_weather" },
  { fault: "tool-call-id-duplicate" },
  { fault: "tool-call-id-duplicate", tool: "other" },
  { fault: "empty-response" },
];
const response = {
  content: "Checking.",
  toolCalls: [
    { name: "weather", arguments: { city: "Paris" } },
    { name: "other", arguments: {} },
    { name: "last", arguments: {} },
  ],
  usage: { input_tokens: 9999, output_tokens: 9999 },
};

test.each([false, true].flatMap((stream) => cases.map((fault) => ({ stream, fault }))))(
  "Cohere native positive $fault.fault $fault.violation tool=$fault.tool stream=$stream",
  async ({ stream, fault }) => {
    await withFaultFixture(
      { faults: [fault] },
      async ({ mock, url }) => {
        const result = await fetch(`${url}/v2/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "command-r-plus",
            messages: [{ role: "user", content: "weather" }],
            stream,
            tools: [
              {
                name: "weather",
                parameter_definitions: {
                  city: { type: "string", required: true, enum: ["Paris"] },
                },
              },
            ],
          }),
        });
        const raw = await result.text();
        console.log(
          JSON.stringify({
            fault,
            stream,
            status: result.status,
            raw,
            journal: mock.getRequests(),
          }),
        );
        expect(result.status).toBe(200);
        const frames = stream
          ? raw
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice(6)))
          : [];
        const payload = stream ? undefined : JSON.parse(raw);
        const calls = stream
          ? frames
              .filter((frame) => frame.type === "tool-call-start")
              .map((frame) => ({
                id: frame.delta.message.tool_calls.id,
                name: frame.delta.message.tool_calls.function.name,
                arguments: frames
                  .filter((part) => part.type === "tool-call-delta" && part.index === frame.index)
                  .map((part) => part.delta.message.tool_calls.function.arguments)
                  .join(""),
              }))
          : payload.message.tool_calls.map(
              (call: { id: string; function: { name: string; arguments: string } }) => ({
                id: call.id,
                ...call.function,
              }),
            );
        const summary = mock.getLastRequest()?.response.misbehavior;
        expect(summary?.applied).toBe(true);
        expect(summary?.servedToolCalls).toEqual(calls);
        expect(summary?.evaluations).toHaveLength(1);
        expect(mock.getRequests()).toHaveLength(1);
        expect(stream ? frames.at(-1).delta.finish_reason : payload.finish_reason).toBe(
          fault.fault === "empty-response" ? "COMPLETE" : "TOOL_CALL",
        );
        if (fault.fault === "tool-args-invalid-json")
          expect(() => JSON.parse(calls[0].arguments)).toThrow();
        if (fault.fault === "tool-unknown-name") expect(calls[0].name).toBe("missing_weather");
        if (fault.fault === "tool-call-id-duplicate")
          expect(calls[fault.tool === "other" ? 1 : 0].id).toBe(
            calls[fault.tool === "other" ? 2 : 1].id,
          );
        if (fault.fault === "empty-response") {
          expect(calls).toEqual([]);
          expect(
            stream
              ? frames.filter((frame) => frame.type === "content-delta")
              : payload.message.content,
          ).toEqual([]);
        }
        if (fault.fault === "tool-args-schema-violation") {
          const args = JSON.parse(calls[0].arguments);
          if (fault.violation === "missing-required") expect(args).not.toHaveProperty("city");
          if (fault.violation === "wrong-type") expect(typeof args.city).not.toBe("string");
          if (fault.violation === "enum-mismatch") expect(args.city).not.toBe("Paris");
          if (fault.violation === "not-object") expect(typeof args).toBe("string");
        }
        expect(
          stream
            ? frames.at(-1).delta.usage.tokens.output_tokens
            : payload.usage.tokens.output_tokens,
        ).not.toBe(9999);
      },
      { response },
    );
  },
);

test.each([false, true])("Cohere no-fault actual HTTP control stream=%s", async (stream) => {
  await withFaultFixture(
    undefined,
    async ({ mock, url }) => {
      const result = await fetch(`${url}/v2/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "command-r-plus",
          messages: [{ role: "user", content: "weather" }],
          stream,
        }),
      });
      const raw = await result.text();
      console.log(JSON.stringify({ control: true, stream, status: result.status, raw }));
      expect(result.status).toBe(200);
      expect(raw).toContain("Paris");
      expect(mock.getLastRequest()?.response).not.toHaveProperty("misbehavior");
    },
    { response },
  );
});

test.each(["tool", "mixed", "blocks"] as const)(
  "Cohere K1 branches %s keep prepared bytes across JSON/SSE",
  async (shape) => {
    const call = { name: "weather", arguments: ' { "city" : "Paris", "z": 1 } ' };
    const shaped =
      shape === "blocks"
        ? {
            blocks: [
              { type: "text" as const, text: "Before." },
              { type: "toolCall" as const, ...call },
              { type: "text" as const, text: "After." },
            ],
          }
        : { toolCalls: [call], ...(shape === "mixed" ? { content: "Before.After." } : {}) };
    for (const stream of [false, true]) {
      for (const style of ["truncated", "trailing-comma", "single-quotes"] as const) {
        await withFaultFixture(
          { faults: [{ fault: "tool-args-invalid-json", style }] },
          async ({ mock, url }) => {
            const result = await fetch(`${url}/v2/chat`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: "command-r-plus",
                messages: [{ role: "user", content: "weather" }],
                stream,
              }),
            });
            const raw = await result.text();
            console.log(
              JSON.stringify({
                shape,
                style,
                stream,
                status: result.status,
                raw,
                journal: mock.getRequests(),
              }),
            );
            expect(result.status).toBe(200);
            const events = stream
              ? raw
                  .split("\n")
                  .filter((line) => line.startsWith("data: "))
                  .map((line) => JSON.parse(line.slice(6)))
              : [];
            const args = stream
              ? events
                  .filter((event) => event.type === "tool-call-delta")
                  .map((event) => event.delta.message.tool_calls.function.arguments)
                  .join("")
              : JSON.parse(raw).message.tool_calls[0].function.arguments;
            expect(() => JSON.parse(args)).toThrow();
            expect(
              mock.getLastRequest()?.response.misbehavior?.servedToolCalls?.[0].arguments,
            ).toBe(args);
            if (stream) {
              expect(events.filter((event) => event.type === "tool-call-start")).toHaveLength(1);
              expect(events.filter((event) => event.type === "tool-call-end")).toHaveLength(1);
              expect(events.at(-1).delta.finish_reason).toBe("TOOL_CALL");
              const text = events
                .filter((event) => event.type === "content-delta")
                .map((event) => event.delta.message.content.text)
                .join("");
              expect(text).toBe(shape === "tool" ? "" : "Before.After.");
            }
          },
          { response: shaped },
        );
      }
    }
  },
);

test.each([false, true])("Cohere canonical schema extra-property stream=%s", async (stream) => {
  await withFaultFixture(
    {
      faults: [
        { fault: "tool-args-schema-violation", violation: "extra-property", property: "surprise" },
      ],
    },
    async ({ mock, url }) => {
      const result = await fetch(`${url}/v2/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "command-r-plus",
          messages: [{ role: "user", content: "weather" }],
          stream,
          tools: [
            {
              type: "function",
              function: {
                name: "weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                  additionalProperties: false,
                },
              },
            },
          ],
        }),
      });
      const raw = await result.text();
      console.log(
        JSON.stringify({
          stream,
          canonical: true,
          status: result.status,
          raw,
          journal: mock.getRequests(),
        }),
      );
      expect(result.status).toBe(200);
      const calls = mock.getLastRequest()?.response.misbehavior?.servedToolCalls;
      expect(JSON.parse(calls?.[0].arguments ?? "null")).toHaveProperty("surprise");
      const servedArgs = stream
        ? raw
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)))
            .filter((event) => event.type === "tool-call-delta")
            .map((event) => event.delta.message.tool_calls.function.arguments)
            .join("")
        : JSON.parse(raw).message.tool_calls[0].function.arguments;
      expect(servedArgs).toBe(calls?.[0].arguments);
      expect(JSON.parse(servedArgs)).toHaveProperty("surprise");
    },
  );
});

test.each([false, true].flatMap((stream) => [false, true].map((faulted) => ({ stream, faulted }))))(
  "Cohere official SDK K1 stream=$stream faulted=$faulted",
  async ({ stream, faulted }) => {
    await withFaultFixture(
      faulted ? "tool-args-invalid-json" : undefined,
      async ({ mock, url }) => {
        const wire: { status: number; body: string }[] = [];
        const client = new CohereClientV2({
          token: "local",
          baseUrl: url,
          maxRetries: 0,
          timeoutInSeconds: 5,
          fetch: async (input, init) => {
            const result = await fetch(input, init);
            wire.push({ status: result.status, body: await result.clone().text() });
            return result;
          },
        });
        const request = {
          model: "command-r-plus",
          messages: [{ role: "user", content: "weather" }],
        } satisfies Cohere.V2ChatRequest;
        const events: Cohere.V2ChatStreamResponse[] = [];
        let args: string | undefined;
        let finish: string | undefined;
        try {
          if (stream) {
            for await (const event of await client.chatStream(request)) events.push(event);
            args = events
              .filter((event) => event.type === "tool-call-delta")
              .map((event) => event.delta?.message?.toolCalls?.function?.arguments ?? "")
              .join("");
            expect(events.filter((event) => event.type === "tool-call-start")).toHaveLength(1);
            expect(events.filter((event) => event.type === "tool-call-end")).toHaveLength(1);
            finish = events.find((event) => event.type === "message-end")?.delta?.finishReason;
          } else {
            const result = await client.chat(request);
            args = result.message.toolCalls?.[0].function?.arguments;
            finish = result.finishReason;
          }
        } finally {
          console.log(
            JSON.stringify({
              sdk: true,
              stream,
              faulted,
              wire,
              args,
              finish,
              events,
              journal: mock.getRequests(),
            }),
          );
        }
        expect(wire).toHaveLength(1);
        expect(mock.getRequests()).toHaveLength(1);
        if (stream) expect(wire[0].body).not.toContain("data: [DONE]");
        expect(finish).toBe("TOOL_CALL");
        expect(typeof args).toBe("string");
        if (faulted) {
          expect(args?.length).toBeGreaterThan(0);
          expect(() => JSON.parse(args ?? "null")).toThrow();
          expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls?.[0].arguments).toBe(
            args,
          );
        } else {
          expect(JSON.parse(args ?? "null")).toEqual({ city: "Paris" });
          expect(mock.getLastRequest()?.response).not.toHaveProperty("misbehavior");
        }
      },
    );
  },
);

test.each([false, true])(
  "Cohere SDK K5 strict prefix and mode-specific terminal stream=%s",
  async (stream) => {
    await withFaultFixture(
      { faults: [{ fault: "stop-length-mid-tool", at: 0.5 }] },
      async ({ mock, url }) => {
        const wire: { status: number; body: string }[] = [];
        const client = new CohereClientV2({
          token: "local",
          baseUrl: url,
          maxRetries: 0,
          timeoutInSeconds: 5,
          fetch: async (input, init) => {
            const result = await fetch(input, init);
            wire.push({ status: result.status, body: await result.clone().text() });
            return result;
          },
        });
        const request = {
          model: "command-r-plus",
          messages: [{ role: "user", content: "weather" }],
        } satisfies Cohere.V2ChatRequest;
        const events: Cohere.V2ChatStreamResponse[] = [];
        let args: string | undefined;
        let finish: string | undefined;
        try {
          if (stream) {
            for await (const event of await client.chatStream(request)) events.push(event);
            args = events
              .filter((event) => event.type === "tool-call-delta")
              .map((event) => event.delta?.message?.toolCalls?.function?.arguments ?? "")
              .join("");
            finish = events.find((event) => event.type === "message-end")?.delta?.finishReason;
          } else {
            const result = await client.chat(request);
            args = result.message.toolCalls?.[0].function?.arguments;
            finish = result.finishReason;
          }
        } finally {
          console.log(
            JSON.stringify({
              k5: true,
              stream,
              wire,
              args,
              finish,
              events,
              journal: mock.getRequests(),
            }),
          );
        }
        const canonical = '{"city":"Paris"}';
        expect(args).toBe(canonical.slice(0, Math.floor(canonical.length * 0.5)));
        expect(finish).toBe(stream ? "TOOL_CALL" : "MAX_TOKENS");
        expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls?.[0].arguments).toBe(
          args,
        );
        expect(wire).toHaveLength(1);
      },
    );
  },
);

test.each(
  [false, true].flatMap((stream) =>
    cases
      .filter((fault) => fault.fault !== "tool-args-invalid-json")
      .map((fault) => ({ stream, fault })),
  ),
)(
  "Cohere official SDK supported $fault.fault $fault.violation tool=$fault.tool stream=$stream",
  async ({ stream, fault }) => {
    await withFaultFixture(
      { faults: [fault] },
      async ({ mock, url }) => {
        const client = new CohereClientV2({
          token: "local",
          baseUrl: url,
          maxRetries: 0,
          timeoutInSeconds: 5,
        });
        const request = {
          model: "command-r-plus",
          messages: [{ role: "user", content: "weather" }],
          tools: [
            {
              type: "function",
              function: {
                name: "weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string", enum: ["Paris"] } },
                  required: ["city"],
                },
              },
            },
          ],
        } satisfies Cohere.V2ChatRequest;
        const calls: { id: string | undefined; name: string | undefined; arguments: string }[] = [];
        const events: Cohere.V2ChatStreamResponse[] = [];
        let finish: string | undefined;
        if (stream) {
          for await (const event of await client.chatStream(request)) events.push(event);
          for (const event of events) {
            if (event.type === "tool-call-start")
              calls.push({
                id: event.delta?.message?.toolCalls?.id,
                name: event.delta?.message?.toolCalls?.function?.name,
                arguments: "",
              });
            if (event.type === "tool-call-delta")
              calls[event.index ?? 0].arguments +=
                event.delta?.message?.toolCalls?.function?.arguments ?? "";
          }
          finish = events.find((event) => event.type === "message-end")?.delta?.finishReason;
        } else {
          const result = await client.chat(request);
          calls.push(
            ...(result.message.toolCalls ?? []).map((call) => ({
              id: call.id,
              name: call.function?.name,
              arguments: call.function?.arguments ?? "",
            })),
          );
          finish = result.finishReason;
          if (fault.fault === "empty-response") expect(result.message.content).toEqual([]);
        }
        console.log(
          JSON.stringify({
            sdk: true,
            stream,
            fault,
            calls,
            finish,
            events,
            journal: mock.getRequests(),
          }),
        );
        expect(mock.getRequests()).toHaveLength(1);
        expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls).toEqual(calls);
        expect(finish).toBe(fault.fault === "empty-response" ? "COMPLETE" : "TOOL_CALL");
        if (fault.fault === "tool-unknown-name") expect(calls[0].name).toBe("missing_weather");
        if (fault.fault === "tool-call-id-duplicate")
          expect(calls[fault.tool === "other" ? 1 : 0].id).toBe(
            calls[fault.tool === "other" ? 2 : 1].id,
          );
        if (fault.fault === "empty-response") expect(calls).toEqual([]);
        if (fault.fault === "tool-args-schema-violation") {
          const args = JSON.parse(calls[0].arguments);
          if (fault.violation === "missing-required") expect(args).not.toHaveProperty("city");
          if (fault.violation === "wrong-type") expect(typeof args.city).not.toBe("string");
          if (fault.violation === "enum-mismatch") expect(args.city).not.toBe("Paris");
          if (fault.violation === "not-object") expect(typeof args).toBe("string");
        }
      },
      { response },
    );
  },
);

test.each([false, true])(
  "Cohere K5 ordered blocks preserves prefix and suppresses suffix stream=%s",
  async (stream) => {
    const blocks = [
      { type: "text" as const, text: "Before." },
      { type: "toolCall" as const, name: "first", arguments: "{}" },
      { type: "text" as const, text: "Between." },
      { type: "toolCall" as const, name: "weather", arguments: '{"city":"Paris"}' },
      { type: "text" as const, text: "After." },
      { type: "toolCall" as const, name: "last", arguments: "{}" },
    ];
    await withFaultFixture(
      { faults: [{ fault: "stop-length-mid-tool", tool: "weather", at: 0.5 }] },
      async ({ mock, url }) => {
        const result = await fetch(`${url}/v2/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "command-r-plus",
            messages: [{ role: "user", content: "weather" }],
            stream,
          }),
        });
        const raw = await result.text();
        console.log(
          JSON.stringify({
            k5Blocks: true,
            stream,
            status: result.status,
            raw,
            journal: mock.getRequests(),
          }),
        );
        expect(result.status).toBe(200);
        if (stream) expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);
        const events = stream
          ? raw
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .filter((line) => line !== "data: [DONE]")
              .map((line) => JSON.parse(line.slice(6)))
          : [];
        const payload = stream ? undefined : JSON.parse(raw);
        const calls = stream
          ? events
              .filter((event) => event.type === "tool-call-start")
              .map((event) => ({
                id: event.delta.message.tool_calls.id,
                name: event.delta.message.tool_calls.function.name,
                arguments: events
                  .filter((part) => part.type === "tool-call-delta" && part.index === event.index)
                  .map((part) => part.delta.message.tool_calls.function.arguments)
                  .join(""),
              }))
          : payload.message.tool_calls.map(
              (call: { id: string; function: { name: string; arguments: string } }) => ({
                id: call.id,
                ...call.function,
              }),
            );
        expect(calls.map((call: { name: string }) => call.name)).toEqual(["first", "weather"]);
        expect(calls[1].arguments).toBe('{"city":');
        const text = stream
          ? events
              .filter((event) => event.type === "content-delta")
              .map((event) => event.delta.message.content.text)
              .join("")
          : payload.message.content.map((block: { text: string }) => block.text).join("");
        expect(text).toBe("Before.Between.");
        expect(stream ? events.at(-1).delta.finish_reason : payload.finish_reason).toBe(
          stream ? "TOOL_CALL" : "MAX_TOKENS",
        );
        expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls).toEqual(calls);
      },
      { response: { blocks } },
    );
  },
);

test.each([0.25, 0.5, 0.75])("Cohere SDK K5 observed streaming lifecycle at=%s", async (at) => {
  const canonical = '{"city":"Paris"}';
  await withFaultFixture(
    { faults: [{ fault: "stop-length-mid-tool", at }] },
    async ({ mock, url }) => {
      const wire: { status: number; body: string; request: string | undefined }[] = [];
      const client = new CohereClientV2({
        token: "local",
        baseUrl: url,
        maxRetries: 0,
        timeoutInSeconds: 5,
        fetch: async (input, init) => {
          const result = await fetch(input, init);
          wire.push({
            status: result.status,
            body: await result.clone().text(),
            request: typeof init?.body === "string" ? init.body : undefined,
          });
          return result;
        },
      });
      const events: Cohere.V2ChatStreamResponse[] = [];
      try {
        for await (const event of await client.chatStream({
          model: "command-r-plus",
          messages: [{ role: "user", content: "weather" }],
        }))
          events.push(event);
      } finally {
        console.log(
          JSON.stringify({ k5Observed: true, at, wire, events, journal: mock.getRequests() }),
        );
      }
      expect(wire).toHaveLength(1);
      expect(wire[0].status).toBe(200);
      const starts = events.filter((event) => event.type === "tool-call-start");
      expect(starts).toHaveLength(1);
      expect(starts[0].index).toBe(0);
      expect(starts[0].delta?.message?.toolCalls?.id).toBe("call_weather");
      expect(starts[0].delta?.message?.toolCalls?.function?.name).toBe("weather");
      const args = events
        .filter((event) => event.type === "tool-call-delta")
        .map((event) => event.delta?.message?.toolCalls?.function?.arguments ?? "")
        .join("");
      expect(args).toBe(canonical.slice(0, Math.floor(canonical.length * at)));
      expect(() => JSON.parse(args)).toThrow();
      expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls).toEqual([
        { id: "call_weather", name: "weather", arguments: args },
      ]);
      const closure = events.filter((event) => event.type === "tool-call-end");
      expect(closure).toHaveLength(1);
      expect(closure[0].index).toBe(0);
      expect(events.at(-2)?.type).toBe("tool-call-end");
      expect(events.at(-1)?.type).toBe("message-end");
      expect(events.filter((event) => event.type === "message-start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "message-end")).toHaveLength(1);
      expect(events.some((event) => event.type === "content-delta")).toBe(false);
      expect(events.find((event) => event.type === "message-end")?.delta?.finishReason).toBe(
        "TOOL_CALL",
      );
      const frames = wire[0].body.split("\n\n");
      expect(frames.pop()).toBe("");
      expect(frames.pop()).toBe("data: [DONE]");
      expect(frames.some((frame) => frame.includes("[DONE]"))).toBe(false);
      const rawEvents = frames.map((frame) => {
        const lines = frame.split("\n");
        expect(lines).toHaveLength(2);
        const event = JSON.parse(lines[1].slice(6));
        expect(lines[0]).toBe(`event: ${event.type}`);
        return event;
      });
      expect(rawEvents.map((event) => event.type)).toEqual(events.map((event) => event.type));
      expect(rawEvents.at(-1).delta.finish_reason).toBe("TOOL_CALL");
      expect(mock.getRequests()).toHaveLength(1);
    },
    {
      response: {
        toolCalls: [
          { id: "call_weather", name: "weather", arguments: canonical },
          { id: "call_later", name: "later", arguments: "{}" },
        ],
      },
    },
  );
});
