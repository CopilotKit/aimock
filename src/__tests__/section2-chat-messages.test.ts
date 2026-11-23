import { afterEach, describe, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start() {
  mock = new LLMock({ port: 0 });
  await mock.start();
  return mock;
}

async function post(path: string, body: unknown) {
  if (!mock) await start();
  const response = await fetch(`${mock!.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  process.stdout.write(
    `${JSON.stringify({ path, request: body, status: response.status, body: text })}\n`,
  );
  return { status: response.status, text };
}

const chat = "/v1/chat/completions";
const valid = { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] };

describe("C01 candidate", () => {
  test("null message is a client error before routing", async () => {
    const result = await post(chat, { model: "gpt-4o", messages: [null] });
    expect(result.status).toBe(400);
    expect(result.text).toContain("messages[0]");
    expect(result.text).not.toContain("TypeError");
  });
});

describe("C01 controls", () => {
  test.each([
    ["text", [{ role: "user", content: "hello" }]],
    [
      "assistant null with tool call",
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
      ],
    ],
    ["empty content", [{ role: "user", content: "" }]],
    ["absent content", [{ role: "assistant" }]],
  ])("preserves %s", async (_label, messages) => {
    const server = await start();
    server.on({ model: "gpt-4o" }, { content: "supported-control" });
    const result = await post(chat, { model: "gpt-4o", messages });
    expect(result.status).toBe(200);
    expect(result.text).toContain('"content":"supported-control"');
  });

  test("Azure deployment supplies omitted model", async () => {
    const server = await start();
    server.on({ model: "deployment-a" }, { content: "azure-control" });
    const result = await post(
      "/openai/deployments/deployment-a/chat/completions?api-version=2024-10-21",
      { messages: valid.messages },
    );
    expect(result.status).toBe(200);
    expect(result.text).toContain('"content":"azure-control"');
    expect(result.text).toContain('"model":"deployment-a"');
  });

  test.each([undefined, "bad"])(
    "preserves missing/non-array messages error (%s)",
    async (messages) => {
      const result = await post(chat, { model: "gpt-4o", messages });
      expect(result.status).toBe(400);
      expect(JSON.parse(result.text)).toEqual({
        error: {
          message: "Missing required parameter: 'messages'",
          type: "invalid_request_error",
          param: null,
          code: null,
        },
      });
    },
  );

  test("preserves OpenRouter error envelope", async () => {
    const result = await post("/api/v1/chat/completions", { model: "gpt-4o" });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toEqual({
      error: { code: 400, message: "Missing required parameter: 'messages'" },
    });
  });

  test("malformed request leaves first sequence fixture available", async () => {
    const server = await start();
    server.on({ model: "gpt-4o", sequenceIndex: 0 }, { content: "first-control" });
    server.on({ model: "gpt-4o", sequenceIndex: 1 }, { content: "second-control" });
    await post(chat, { model: "gpt-4o", messages: [null] });
    const first = await post(chat, valid);
    const second = await post(chat, valid);
    expect(first.status).toBe(200);
    expect(first.text).toContain('"content":"first-control"');
    expect(second.status).toBe(200);
    expect(second.text).toContain('"content":"second-control"');
  });
});
