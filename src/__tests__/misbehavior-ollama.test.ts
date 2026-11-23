import { Ollama, type ChatResponse, type ChatRequest } from "ollama";
import { expect, test } from "vitest";
import type { LLMock } from "../llmock.js";
import type { FixtureFileResponse, MisbehaviorConfig } from "../types.js";
import { withFaultFixture } from "./helpers/misbehavior-server.js";

const schema = {
  type: "object",
  properties: { city: { type: "string", enum: ["Paris"] } },
  required: ["city"],
  additionalProperties: false,
};
const request = {
  model: "llama3.1",
  messages: [{ role: "user", content: "weather" }],
  tools: [
    { type: "function", function: { name: "weather", parameters: schema } },
    {
      type: "function",
      function: {
        name: "clock",
        parameters: { type: "object", properties: { zone: { type: "string" } } },
      },
    },
  ],
} satisfies ChatRequest;
const calls = [
  { id: "original-clock", name: "clock", arguments: '{ "zone": "UTC" }' },
  { id: "original-weather", name: "weather", arguments: '{ "city": "Paris" }' },
];
const shapes = [
  { name: "tools", response: { toolCalls: calls }, before: "", content: "" },
  {
    name: "mixed",
    response: { content: "Before.", toolCalls: calls },
    before: "Before.",
    content: "Before.",
  },
  {
    name: "blocks",
    response: {
      content: "STALE",
      toolCalls: [{ name: "stale", arguments: "{}" }],
      blocks: [
        { type: "text", text: "Before." },
        { type: "toolCall", ...calls[0] },
        { type: "toolCall", ...calls[1] },
        { type: "text", text: "After." },
      ],
    },
    before: "Before.",
    content: "Before.After.",
  },
] satisfies { name: string; response: FixtureFileResponse; before: string; content: string }[];
const modes = shapes.flatMap((shape) => [false, true].map((stream) => ({ ...shape, stream })));

async function observe(mock: LLMock, stream: boolean, headers: Record<string, string> = {}) {
  const wire: { status: number; contentType: string | null; body: string }[] = [];
  const pending: Promise<void>[] = [];
  const client = new Ollama({
    host: mock.url,
    fetch: async (input, init) => {
      const result = await fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers },
        signal: AbortSignal.timeout(5000),
      });
      pending.push(
        result
          .clone()
          .text()
          .then((body) => {
            wire.push({
              status: result.status,
              contentType: result.headers.get("content-type"),
              body,
            });
          }),
      );
      return result;
    },
  });
  const chunks: ChatResponse[] = [];
  let failure: unknown;
  const before = mock.getRequests().length;
  try {
    if (stream)
      for await (const chunk of await client.chat({ ...request, stream: true })) chunks.push(chunk);
    else chunks.push(await client.chat({ ...request, stream: false }));
  } catch (error) {
    failure = error;
  }
  await Promise.all(pending);
  const entry = mock.getLastRequest();
  console.log(
    JSON.stringify({
      stream,
      wire,
      chunks,
      failure:
        failure instanceof Error ? { name: failure.name, message: failure.message } : failure,
      entry,
    }),
  );
  expect(wire).toHaveLength(1);
  expect(mock.getRequests()).toHaveLength(before + 1);
  return { wire: wire[0], chunks, failure, entry };
}

function observedCalls(chunks: ChatResponse[]) {
  return chunks.flatMap((chunk) => chunk.message.tool_calls ?? []);
}
function expectPrepared(result: Awaited<ReturnType<typeof observe>>) {
  expect(result.failure).toBeUndefined();
  expect(result.wire.status).toBe(200);
  const served = observedCalls(result.chunks).map((call) => ({
    name: call.function.name,
    arguments: JSON.stringify(call.function.arguments),
  }));
  expect(result.entry?.response.misbehavior).toMatchObject({
    applied: true,
    servedToolCalls: served,
  });
  expect(result.entry?.response.misbehavior?.servedToolCalls).toEqual(served);
  for (const call of observedCalls(result.chunks)) expect(call).not.toHaveProperty("id");
  expect(result.entry?.response.misbehavior?.evaluations).toHaveLength(1);
  expect(result.entry?.response.misbehavior?.evaluations[0]).toMatchObject({
    outcome: "applied",
    ordinal: 0,
  });
  expect(result.chunks.at(-1)?.done).toBe(true);
}

test.each(modes)("no fault control $name stream=$stream", async ({ response, stream, content }) => {
  await withFaultFixture(
    undefined,
    async ({ mock }) => {
      const result = await observe(mock, stream);
      expect(result.failure).toBeUndefined();
      expect(result.wire.status).toBe(200);
      expect(observedCalls(result.chunks).map((call) => call.function)).toEqual([
        { name: "clock", arguments: { zone: "UTC" } },
        { name: "weather", arguments: { city: "Paris" } },
      ]);
      expect(result.chunks.map((chunk) => chunk.message.content).join("")).toBe(content);
      expect(result.entry?.response).not.toHaveProperty("misbehavior");
    },
    { response },
  );
});

for (const style of ["truncated", "trailing-comma", "single-quotes"] as const) {
  test.each(modes)(`K1 ${style} $name stream=$stream`, async ({ response, stream, before }) => {
    await withFaultFixture(
      { faults: [{ fault: "tool-args-invalid-json", style, tool: "weather" }] },
      async ({ mock }) => {
        const result = await observe(mock, stream);
        expect(result.failure).toBeInstanceOf(Error);
        expect(result.failure instanceof Error && result.failure.message).toMatch(
          /error parsing tool call: raw='.+', err=.+/,
        );
        expect(result.wire.status).toBe(stream ? 200 : 500);
        const lines = result.wire.body
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(lines.filter((line) => "error" in line)).toHaveLength(1);
        expect(lines.at(-1)?.error).toBe(
          result.failure instanceof Error ? result.failure.message : undefined,
        );
        expect(lines.some((line) => line.done === true)).toBe(false);
        expect(observedCalls(result.chunks)).toEqual([]);
        expect(result.chunks.map((chunk) => chunk.message.content).join("")).toBe(
          stream ? before : "",
        );
        expect(result.wire.body).not.toContain("STALE");
        expect(result.wire.body).not.toContain("After.");
        const canonical = '{"city":"Paris"}';
        const invalid =
          style === "truncated"
            ? canonical.slice(0, Math.floor(canonical.length / 2))
            : style === "trailing-comma"
              ? '{"city":"Paris",}'
              : "{'city':'Paris'}";
        expect(lines.at(-1)?.error).toContain(`raw='${invalid}', err=`);
        expect(result.entry?.response).toMatchObject({
          status: stream ? 200 : 500,
          misbehavior: {
            applied: true,
            servedToolCalls: [],
            target: { tool: "weather", index: 1 },
          },
        });
        expect(result.entry?.response).not.toHaveProperty("interrupted");
      },
      { response },
    );
  });
}

for (const violation of [
  "missing-required",
  "wrong-type",
  "extra-property",
  "enum-mismatch",
] as const) {
  test.each(modes)(
    `K2 ${violation} $name stream=$stream`,
    async ({ response, stream, content }) => {
      await withFaultFixture(
        {
          faults: [
            {
              fault: "tool-args-schema-violation",
              violation,
              tool: "weather",
              ...(violation === "extra-property" ? { property: "extra" } : { property: "city" }),
            },
          ],
        },
        async ({ mock }) => {
          const result = await observe(mock, stream);
          expectPrepared(result);
          const functions = observedCalls(result.chunks).map((call) => call.function);
          expect(functions[0]).toEqual({ name: "clock", arguments: { zone: "UTC" } });
          expect(functions[1]?.name).toBe("weather");
          const args = functions[1]?.arguments;
          if (violation === "missing-required") expect(args).not.toHaveProperty("city");
          if (violation === "wrong-type") expect(typeof args?.city).not.toBe("string");
          if (violation === "extra-property") expect(args).toHaveProperty("extra");
          if (violation === "enum-mismatch") expect(args?.city).not.toBe("Paris");
          expect(result.chunks.map((chunk) => chunk.message.content).join("")).toBe(content);
        },
        { response },
      );
    },
  );
}

test.each(modes)("K3 selected name $name stream=$stream", async ({ response, stream }) => {
  await withFaultFixture(
    { faults: [{ fault: "tool-unknown-name", tool: "weather", name: "missing_weather" }] },
    async ({ mock }) => {
      const result = await observe(mock, stream);
      expectPrepared(result);
      expect(observedCalls(result.chunks).map((call) => call.function)).toEqual([
        { name: "clock", arguments: { zone: "UTC" } },
        { name: "missing_weather", arguments: { city: "Paris" } },
      ]);
    },
    { response },
  );
});

for (const fault of ["empty-response", "reasoning-only"] as const) {
  test.each(modes)(`${fault} clears output $name stream=$stream`, async ({ response, stream }) => {
    await withFaultFixture(
      {
        faults: [{ fault, ...(fault === "reasoning-only" ? { reasoning: "Let me think." } : {}) }],
      },
      async ({ mock }) => {
        const result = await observe(mock, stream);
        expectPrepared(result);
        expect(observedCalls(result.chunks)).toEqual([]);
        expect(result.chunks.map((chunk) => chunk.message.content).join("")).toBe("");
        expect(result.chunks.map((chunk) => chunk.message.thinking ?? "").join("")).toBe(
          fault === "reasoning-only" ? "Let me think." : "",
        );
        expect(result.chunks.at(-1)?.done_reason).toBe(
          fault === "reasoning-only" ? "length" : "stop",
        );
        expect(result.wire.body).not.toContain("reasoning_content");
        expect(result.chunks.at(-1)?.prompt_eval_count).toBe(2);
        expect(result.chunks.at(-1)?.eval_count).toBe(fault === "reasoning-only" ? 4 : 1);
        expect(mock.getFixtures()[0]?.response).toMatchObject({
          usage: { prompt_tokens: 901, completion_tokens: 902 },
        });
      },
      {
        response: {
          ...response,
          reasoning: "Old thought",
          usage: { prompt_tokens: 901, completion_tokens: 902 },
        },
      },
    );
  });
}

test.each([false, true])(
  "times1 has one applied ordinal then ordinary output stream=%s",
  async (stream) => {
    await withFaultFixture(
      {
        faults: [
          { fault: "tool-unknown-name", tool: "weather", name: "missing_weather", times: 1 },
        ],
      },
      async ({ mock }) => {
        const first = await observe(mock, stream);
        expectPrepared(first);
        const second = await observe(mock, stream);
        expect(second.failure).toBeUndefined();
        expect(observedCalls(second.chunks)[1]?.function.name).toBe("weather");
        expect(second.entry?.response.misbehavior).toMatchObject({
          applied: false,
          reason: "times-exhausted",
        });
        expect(mock.getRequests()).toHaveLength(2);
      },
      { response: shapes[0].response },
    );
  },
);

test.each([false, true])(
  "provider exclusion preserves ordinary output stream=%s",
  async (stream) => {
    await withFaultFixture(
      { faults: [{ fault: "empty-response", providers: ["openai-chat"] }] },
      async ({ mock }) => {
        const result = await observe(mock, stream);
        expect(result.failure).toBeUndefined();
        expect(observedCalls(result.chunks)).toHaveLength(2);
        expect(result.entry?.response.misbehavior).toMatchObject({
          applied: false,
          reason: "provider-excluded",
        });
        expect(result.entry?.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
      },
      { response: shapes[0].response },
    );
  },
);

test("runtime absent tool is skipped without a roll, explicit header errors natively", async () => {
  await withFaultFixture(
    undefined,
    async ({ mock }) => {
      const fault: MisbehaviorConfig = { faults: [{ fault: "tool-unknown-name", tool: "absent" }] };
      mock.setMisbehavior(fault);
      const scoped = await observe(mock, false);
      expect(scoped.failure).toBeUndefined();
      expect(scoped.entry?.response.misbehavior).toMatchObject({
        applied: false,
        reason: "not-applicable",
      });
      expect(scoped.entry?.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
      const explicit = await observe(mock, false, {
        "x-aimock-misbehavior": "tool-unknown-name; tool=absent",
      });
      expect(explicit.wire.status).toBe(501);
      expect(explicit.failure instanceof Error && explicit.failure.message).toContain(
        "aimock_misbehavior_not_applicable",
      );
    },
    { response: shapes[0].response },
  );
});

const permanent = [
  { fault: "tool-args-schema-violation", violation: "not-object" },
  { fault: "tool-call-id-duplicate" },
  { fault: "stop-length-mid-tool" },
  { fault: "refusal" },
  { fault: "content-filter" },
] satisfies MisbehaviorConfig["faults"];
for (const fault of permanent) {
  test.each([false, true])(
    `permanent ${fault.fault} ${"violation" in fault ? fault.violation : ""} explicit/scoped stream=%s`,
    async (stream) => {
      await withFaultFixture(
        { faults: [fault] },
        async ({ mock }) => {
          const result = await observe(mock, stream);
          expect(result.wire.status).toBe(501);
          expect(result.failure instanceof Error && result.failure.message).toContain(
            "aimock_misbehavior_unsupported",
          );
          expect(result.chunks).toEqual([]);
          expect(result.entry?.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
        },
        { response: shapes[0].response },
      );
      await withFaultFixture(
        undefined,
        async ({ mock }) => {
          mock.setMisbehavior({ faults: [fault] });
          const result = await observe(mock, stream);
          expect(result.failure).toBeUndefined();
          expect(result.wire.status).toBe(200);
          expect(observedCalls(result.chunks)).toHaveLength(2);
          expect(result.entry?.response.misbehavior).toMatchObject({
            applied: false,
            reason: "unsupported-on-wire",
          });
          expect(result.entry?.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
        },
        { response: shapes[0].response },
      );
    },
  );
}

test.each([false, true])(
  "applied object calls canonicalize metadata and recompute usage stream=%s",
  async (stream) => {
    await withFaultFixture(
      { faults: [{ fault: "tool-unknown-name", tool: "weather", name: "missing_weather" }] },
      async ({ mock }) => {
        const result = await observe(mock, stream);
        expectPrepared(result);
        const completion = "Before." + 'clock{"zone":"UTC"}' + 'missing_weather{"city":"Paris"}';
        expect(result.chunks.at(-1)?.prompt_eval_count).toBe(2);
        expect(result.chunks.at(-1)?.eval_count).toBe(Math.ceil(completion.length / 4));
        expect(mock.getFixtures()[0]?.response).toMatchObject({
          usage: { prompt_tokens: 777, completion_tokens: 888 },
        });
      },
      {
        response: { ...shapes[1].response, usage: { prompt_tokens: 777, completion_tokens: 888 } },
      },
    );
  },
);

test("K3 preserves empty args as object", async () => {
  await withFaultFixture(
    "tool-unknown-name",
    async ({ mock }) => {
      const result = await observe(mock, false);
      expectPrepared(result);
      expect(observedCalls(result.chunks)[0]?.function.arguments).toEqual({});
      expect(result.entry?.response.misbehavior?.servedToolCalls?.[0]?.arguments).toBe("{}");
    },
    {
      response: {
        toolCalls: [{ name: "weather", arguments: "" }],
      },
    },
  );
});

test.each([false, true])(
  "applied factory resolves exactly once without mutating its response stream=%s",
  async (stream) => {
    await withFaultFixture(undefined, async ({ mock }) => {
      mock.clearFixtures();
      let calls = 0;
      const response = { content: "original", usage: { completion_tokens: 900 } };
      mock.addFixture({
        match: {},
        response: () => {
          calls++;
          return response;
        },
        misbehavior: "empty-response",
      });
      const result = await observe(mock, stream);
      expectPrepared(result);
      expect(calls).toBe(1);
      expect(response).toEqual({ content: "original", usage: { completion_tokens: 900 } });
    });
  },
);

test("transport interruption retains full prepared fault metadata", async () => {
  await withFaultFixture(undefined, async ({ mock }) => {
    mock.clearFixtures();
    mock.addFixture({
      match: {},
      truncateAfterChunks: 1,
      chunkSize: 2,
      response: { content: "Before.", toolCalls: calls },
      misbehavior: {
        faults: [{ fault: "tool-unknown-name", tool: "weather", name: "missing_weather" }],
      },
    });
    const client = new Ollama({
      host: mock.url,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
    });
    let failure: unknown;
    try {
      for await (const chunk of await client.chat({ ...request, stream: true }))
        expect(chunk.done).toBe(false);
    } catch (error) {
      failure = error;
    }
    console.log(
      JSON.stringify({
        phase: "interrupted",
        failure: failure instanceof Error ? failure.message : failure,
        entries: mock.getRequests(),
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(mock.getRequests()).toHaveLength(1);
    expect(mock.getLastRequest()?.response).toMatchObject({
      interrupted: true,
      interruptReason: "truncateAfterChunks",
      misbehavior: {
        applied: true,
        servedToolCalls: [
          { name: "clock", arguments: '{"zone":"UTC"}' },
          { name: "missing_weather", arguments: '{"city":"Paris"}' },
        ],
      },
    });
  });
});

for (const source of ["fixture", "header", "scope", "server"] as const) {
  test.each([false, true])(
    `generate-preservation ${source} stream=%s keeps unsupported guard and chat budget`,
    async (stream) => {
      await withFaultFixture(undefined, async ({ mock }) => {
        mock.clearFixtures();
        let calls = 0;
        const config: MisbehaviorConfig = { faults: [{ fault: "empty-response", times: 1 }] };
        mock.addFixture({
          match: {},
          response: () => {
            calls++;
            return { content: "Original" };
          },
          ...(source === "fixture" ? { misbehavior: config } : {}),
        });
        const headers = {
          "content-type": "application/json",
          "x-test-id": "generate-guard",
          ...(source === "header" ? { "x-aimock-misbehavior": "empty-response" } : {}),
        };
        if (source === "server") mock.setMisbehavior(config);
        if (source === "scope")
          expect(
            (
              await fetch(`${mock.url}/__aimock/misbehavior`, {
                method: "POST",
                headers,
                body: JSON.stringify(config),
              })
            ).status,
          ).toBe(200);
        const result = await fetch(`${mock.url}/api/generate`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "llama3.1", prompt: "weather", stream }),
        });
        const body = await result.text();
        const generate = mock.getLastRequest();
        console.log(
          JSON.stringify({
            phase: "generate-preservation",
            source,
            stream,
            status: result.status,
            body,
            calls,
            entry: generate,
          }),
        );
        expect.soft(result.status).toBe(source === "fixture" || source === "header" ? 501 : 200);
        expect.soft(mock.getRequests()).toHaveLength(1);
        expect.soft(calls).toBe(1);
        expect
          .soft(generate?.response.misbehavior)
          .toMatchObject({ applied: false, source, reason: "unsupported-on-wire" });
        expect.soft(generate?.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
        if (source === "fixture" || source === "header")
          expect.soft(body).toContain("aimock_misbehavior_unsupported");
        else expect.soft(body).toContain('"response":"Original"');
        const chat = await observe(mock, false, headers);
        expect.soft(chat.failure).toBeUndefined();
        expect
          .soft(chat.entry?.response.misbehavior)
          .toMatchObject({ applied: true, ordinal: 0, servedToolCalls: [] });
        expect.soft(chat.chunks[0]?.message.content).toBe("");
        expect.soft(calls).toBe(2);
      });
    },
  );
}

for (const mode of ["none", "excluded", "empty", "malformed", "error"] as const) {
  test.each([false, true])(`generate-preservation control ${mode} stream=%s`, async (stream) => {
    await withFaultFixture(undefined, async ({ mock }) => {
      mock.clearFixtures();
      const fault: MisbehaviorConfig | undefined =
        mode === "empty"
          ? { faults: [] }
          : mode === "excluded"
            ? { faults: [{ fault: "empty-response", providers: ["openai-chat"] }] }
            : mode === "error"
              ? { faults: [{ fault: "empty-response" }] }
              : undefined;
      mock.addFixture({
        match: {},
        response: () =>
          mode === "error"
            ? { error: { message: "native failure" }, status: 429 }
            : { content: "Original" },
        ...(fault ? { misbehavior: fault } : {}),
      });
      const result = await fetch(`${mock.url}/api/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(mode === "malformed" ? { "x-aimock-misbehavior": "invalid-fault" } : {}),
        },
        body: JSON.stringify({ model: "llama3.1", prompt: "weather", stream }),
      });
      const body = await result.text();
      const entry = mock.getLastRequest();
      console.log(
        JSON.stringify({
          phase: "generate-preservation-control",
          mode,
          stream,
          status: result.status,
          body,
          entry,
        }),
      );
      expect(result.status).toBe(mode === "malformed" ? 400 : mode === "error" ? 501 : 200);
      expect(mock.getRequests()).toHaveLength(1);
      if (mode === "excluded")
        expect(entry?.response.misbehavior?.reason).toBe("provider-excluded");
      if (mode === "empty")
        expect(entry?.response.misbehavior).toMatchObject({ applied: false, evaluations: [] });
      if (mode === "none") expect(entry?.response).not.toHaveProperty("misbehavior");
      if (mode === "error") expect(entry?.response.misbehavior?.reason).toBe("not-applicable");
      if (mode === "malformed") expect(body).toContain("aimock_misbehavior_invalid");
    });
  });
}
