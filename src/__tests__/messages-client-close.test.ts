import { afterEach, expect, it } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function startReplay(latency: number) {
  mock = new LLMock({ port: 0, host: "127.0.0.1", strict: true, latency, chunkSize: 8 });
  mock.addFixture({
    match: { userMessage: "cancel this real stream" },
    response: { content: "A real streaming response that must stop when its client disconnects." },
  });
  await mock.start();
  return mock;
}

function request(server: LLMock, signal?: AbortSignal) {
  return fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "cancel this real stream" }],
    }),
  });
}

it("journals a real client socket abort promptly during a replay delay", async () => {
  const server = await startReplay(2000);
  const controller = new AbortController();
  const response = await request(server, controller.signal);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  controller.abort();
  await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  await expect
    .poll(() => server.getRequests()[0]?.response.interrupted, { timeout: 1000 })
    .toBe(true);
  expect(server.getRequests()[0].response.interruptReason).toBe("client aborted");
  expect(server.getRequests()[0].response.status).toBe(200);
}, 10000);

it("does not mark normal complete response socket closure as interrupted", async () => {
  const server = await startReplay(0);
  const response = await request(server);
  const body = await response.text();
  expect(body).toContain("event: message_stop");
  expect(server.getRequests()).toHaveLength(1);
  expect(server.getRequests()[0].response.interrupted).not.toBe(true);
  expect(server.getRequests()[0].response.interruptReason).toBeUndefined();
});
