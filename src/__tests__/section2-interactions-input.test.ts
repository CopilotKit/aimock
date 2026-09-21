import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";
import type { ChatMessage } from "../types.js";

function observe(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start() {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.addFixture({ match: { sequenceIndex: 0 }, response: { content: "first-result" } });
  mock.addFixture({ match: {}, response: { content: "fallback-result" } });
  await mock.start();
  return mock;
}
async function post(server: LLMock, body: unknown) {
  const response = await fetch(server.url + "/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    text: await response.text(),
  };
}

// Existing numeric input is ignored; tightening this behavior is deferred.
test("deferred numeric input characterization", async () => {
  const server = await start();
  const result = await post(server, { input: 42, stream: false });
  observe({ cell: "C08-input-42", result, messages: server.getLastRequest()?.body });
  expect(result.status).toBe(200);
  expect(result.text).toContain("first-result");
  expect(server.getLastRequest()?.body).toMatchObject({ messages: [] });
});

const malformed = [
  { id: "C08-input-null-item", input: [null] },
  { id: "C08-input-turn-string", input: [{ role: "user", content: "bad" }] },
];
async function expectRejectedInput(id: string, input: unknown, stream: false | undefined) {
  const server = await start();
  const result = await post(server, { input, stream });
  const journals = server.getRequests();
  const next = await post(server, { input: "hello", stream: false });
  observe({ cell: id, stream: stream ?? "default", result, journals, next });
  expect(next.status).toBe(200);
  expect(next.text).toContain("first-result");
  expect(journals.every((entry) => entry.response.fixture === null)).toBe(true);
  expect(result.status).toBe(400);
  expect(result.contentType).toContain("application/json");
  expect(JSON.parse(result.text)).toMatchObject({
    error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("input") },
  });
}
test.each(malformed)(
  "candidate $id rejects consumed malformed container",
  async ({ id, input }) => {
    await expectRejectedInput(id, input, false);
  },
);
test.each(malformed)(
  "candidate $id rejects before default streaming headers",
  async ({ id, input }) => {
    await expectRejectedInput(id, input, undefined);
  },
);

const controls: { name: string; request: object; messages: ChatMessage[] }[] = [
  ...["", false, 0, [], { length: 0 }].map((content) => ({
    name: `Turn bypass ${JSON.stringify(content)}`,
    request: { input: [{ role: "user", content, parts: [{ type: "text", text: "ignored" }] }] },
    messages: [{ role: "user" as const, content: "" }],
  })),
  {
    name: "Turn null content falls back to parts",
    request: { input: [{ role: "user", content: null, parts: [{ type: "text", text: "hello" }] }] },
    messages: [{ role: "user", content: "hello" }],
  },
  {
    name: "Turn content wins over malformed parts",
    request: {
      input: [{ role: "user", content: [{ type: "text", text: "hello" }], parts: "bad" }],
    },
    messages: [{ role: "user", content: "hello" }],
  },
  { name: "string", request: { input: "hello" }, messages: [{ role: "user", content: "hello" }] },
  {
    name: "Turn content",
    request: { input: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
    messages: [{ role: "user", content: "hello" }],
  },
  {
    name: "Turn legacy parts",
    request: { input: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] },
    messages: [{ role: "user", content: "hello" }],
  },
  {
    name: "Step user and model",
    request: {
      input: [
        { type: "user_input", content: [{ type: "text", text: "hello" }] },
        { type: "model_output", content: [{ type: "text", text: "reply" }] },
      ],
    },
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply" },
    ],
  },
  {
    name: "Content",
    request: { input: [{ type: "text", text: "hello" }] },
    messages: [{ role: "user", content: "hello" }],
  },
  {
    name: "structured Step function_result output",
    request: {
      input: [{ type: "function_result", call_id: "call_1", output: { result: [1, 2] } }],
    },
    messages: [{ role: "tool", content: '{"result":[1,2]}', tool_call_id: "call_1" }],
  },
  {
    name: "structured Turn function_result output",
    request: {
      input: [
        {
          role: "user",
          content: [{ type: "function_result", call_id: "call_1", output: { result: [1, 2] } }],
        },
      ],
    },
    messages: [{ role: "tool", content: '{"result":[1,2]}', tool_call_id: "call_1" }],
  },
  {
    name: "continuation without input",
    request: { previous_interaction_id: "interaction_prior" },
    messages: [],
  },
  { name: "absent input", request: {}, messages: [] },
  {
    name: "empty Step content",
    request: { input: [{ type: "user_input" }, { type: "model_output" }] },
    messages: [
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ],
  },
];
for (const stream of [undefined, false]) {
  test.each(controls)(
    `control $name stream=${String(stream)}`,
    async ({ name, request, messages }) => {
      const server = await start();
      const result = await post(server, { ...request, stream });
      observe({
        control: name,
        stream: stream ?? "default",
        result,
        normalized: server.getLastRequest()?.body,
      });
      expect(result.status).toBe(200);
      expect(server.getLastRequest()?.body).toMatchObject({ messages, stream: stream !== false });
      if (stream === false) {
        expect(result.contentType).toContain("application/json");
        expect(JSON.parse(result.text)).toMatchObject({
          status: "completed",
          output_text: "first-result",
          steps: [{ type: "model_output", content: [{ type: "text", text: "first-result" }] }],
        });
      } else {
        expect(result.contentType).toContain("text/event-stream");
        const events: unknown[] = result.text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        expect(events).toContainEqual(
          expect.objectContaining({
            event_type: "interaction.completed",
            interaction: expect.objectContaining({ status: "completed" }),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            event_type: "step.delta",
            delta: { type: "text", text: "first-result" },
          }),
        );
      }
    },
  );
}
