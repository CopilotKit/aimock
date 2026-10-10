import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LLMock } from "../llmock.js";
import type { ResponsesSSEEvent } from "../responses.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

// A programmatic toolCalls entry is always a function call, whatever its
// `type` (custom calls live in `customToolCalls`). Without a string
// `arguments` it cannot be emitted on the Responses API, so it fails exactly
// as in 1.44.0: an uncoded 500 and no journal `error`. With a string
// `arguments` it is served as a function call.

const ARGS_ERROR = 'Invalid fixture tool call: "arguments" must be a string after normalization';

let mock: LLMock;
let ws: WSTestClient | undefined;
beforeEach(() => {
  mock = new LLMock({ port: 0, chunkSize: 100 });
});
afterEach(async () => {
  ws?.destroy();
  ws = undefined;
  await mock.stop();
});

const mistypes = ["custom_tool_call", "customtoolcall", "Custom"] as const;

function addFixture(toolCall: Record<string, unknown>) {
  mock.addFixture({
    match: { userMessage: "hello" },
    response: { toolCalls: [toolCall] },
  } as never);
}

async function post(path: string, body: unknown) {
  await mock.start();
  const response = await fetch(`${mock.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  return { status: response.status, text: await response.text() };
}

describe.each(mistypes)('toolCalls entry with type "%s"', (type) => {
  test.each([false, true])(
    "without arguments keeps the 1.44.0 uncoded error on Responses HTTP (stream=%s)",
    async (stream) => {
      addFixture({ type, name: "f", input: "x" });
      const result = await post("/v1/responses", { model: "gpt-4o", input: "hello", stream });
      expect(result.status).toBe(500);
      const error = JSON.parse(result.text).error;
      expect(error).toEqual({ type: "server_error", message: ARGS_ERROR });
      const entries = mock.getRequests();
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(500);
      expect(entries[0].response.error).toBeUndefined();
    },
  );

  test("without arguments keeps the 1.44.0 uncoded error on Responses WebSocket", async () => {
    addFixture({ type, name: "f", input: "x" });
    await mock.start();
    ws = await connectWebSocket(mock.url, "/v1/responses");
    ws.send(JSON.stringify({ type: "response.create", model: "gpt-4o", input: "hello" }));
    const messages = await ws.waitForMessages(1);
    const event: ResponsesSSEEvent = JSON.parse(messages[0]);
    expect(event).toMatchObject({ type: "error", error: { message: ARGS_ERROR } });
    expect((event.error as { code?: unknown }).code).toBeUndefined();
    expect(mock.getRequests()[0].response.error).toBeUndefined();
  });

  test("without arguments is still a function call on Chat Completions", async () => {
    addFixture({ type, name: "f", input: "x" });
    const result = await post("/v1/chat/completions", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text).choices[0].message.tool_calls[0]).toMatchObject({
      type: "function",
      function: { name: "f" },
    });
  });

  test("with string arguments is still served as a function call on Responses", async () => {
    addFixture({ type, name: "f", arguments: '{"a":1}' });
    const result = await post("/v1/responses", { model: "gpt-4o", input: "hello" });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text).output).toEqual([
      expect.objectContaining({ type: "function_call", name: "f", arguments: '{"a":1}' }),
    ]);
    expect(mock.getRequests()[0].response.error).toBeUndefined();
  });
});
