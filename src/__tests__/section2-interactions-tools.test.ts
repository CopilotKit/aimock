import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

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

async function post(server: LLMock, tools: unknown, stream: false | undefined) {
  const response = await fetch(server.url + "/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "hello", tools, stream }),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    text: await response.text(),
  };
}

const malformed = [
  { id: "C08-tools-string", tools: "bad" },
  { id: "C08-tools-null-entry", tools: [null] },
];
const native = {
  type: "function",
  name: "weather",
  description: "Weather",
  parameters: { type: "object" },
};
const controls = [
  { name: "absent", tools: undefined },
  { name: "null", tools: null },
  { name: "empty", tools: [] },
  { name: "empty string bypass", tools: "" },
  { name: "object bypass", tools: {} },
  { name: "primitive entries ignored", tools: [0, false, "bad"] },
  { name: "native function", tools: [native] },
  { name: "native google search", tools: [{ type: "google_search" }] },
  { name: "mixed native", tools: [{ type: "google_search" }, native] },
];

for (const stream of [undefined, false] as const) {
  test.each(malformed)(`candidate $id stream=${String(stream)}`, async ({ id, tools }) => {
    const server = await start();
    const result = await post(server, tools, stream);
    const journals = server.getRequests();
    const next = await post(server, undefined, false);
    process.stdout.write(
      JSON.stringify({ cell: id, stream: stream ?? "default", result, journals, next }) + "\n",
    );
    expect(next.status).toBe(200);
    expect(JSON.parse(next.text).output_text).toBe("first-result");
    expect(journals.every((entry) => entry.response.fixture === null)).toBe(true);
    expect(result.status).toBe(400);
    expect(result.contentType).toContain("application/json");
    expect(JSON.parse(result.text)).toMatchObject({
      error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("tools") },
    });
  });

  test.each(controls)(`control $name stream=${String(stream)}`, async ({ name, tools }) => {
    const server = await start();
    const result = await post(server, tools, stream);
    const normalized = server.getLastRequest()?.body;
    process.stdout.write(
      JSON.stringify({ control: name, stream: stream ?? "default", result, normalized }) + "\n",
    );
    expect(result.status).toBe(200);
    expect(normalized).toMatchObject({
      messages: [{ role: "user", content: "hello" }],
      stream: stream !== false,
    });
    if (name === "native function" || name === "mixed native") {
      expect(normalized?.tools).toEqual([
        {
          type: "function",
          function: {
            name: native.name,
            description: native.description,
            parameters: native.parameters,
          },
        },
      ]);
    } else {
      expect(normalized?.tools).toBeUndefined();
    }
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
  });
}
