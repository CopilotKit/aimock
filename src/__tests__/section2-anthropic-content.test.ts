import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start() {
  mock = new LLMock({ port: 0 });
  mock.addFixture({ match: { sequenceIndex: 0 }, response: { content: "FIRST" } });
  mock.addFixture({ match: { sequenceIndex: 1 }, response: { content: "SECOND" } });
  await mock.start();
  return mock;
}

async function post(server: LLMock, messages: object[], stream: boolean) {
  const response = await fetch(`${server.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 32, messages, stream }),
    signal: AbortSignal.timeout(5000),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
    journal: server.getLastRequest(),
  };
}

function expectReplay(result: Awaited<ReturnType<typeof post>>, stream: boolean) {
  expect(result.status).toBe(200);
  if (stream) {
    expect(result.contentType).toContain("text/event-stream");
    expect(result.body).toContain('"text":"FIRST"');
    expect(result.body).toContain("event: message_stop");
  } else {
    expect(JSON.parse(result.body)).toMatchObject({
      type: "message",
      content: [{ type: "text", text: "FIRST" }],
    });
  }
}

const modes = ["user", "assistant"].flatMap((role) =>
  [false, true].map((stream) => ({ role, stream })),
);

test.each(modes)(
  "rejects numeric $role content before matching (stream=$stream)",
  async ({ role, stream }) => {
    const server = await start();
    const invalid = await post(server, [{ role, content: 42 }], stream);
    const sentinel = await post(server, [{ role: "user", content: "hello" }], stream);
    console.log(JSON.stringify({ role, stream, invalid, sentinel }));
    expect(invalid.status).toBe(400);
    expect(invalid.contentType).toContain("application/json");
    expect(JSON.parse(invalid.body)).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "messages content must be a string or an array of content blocks",
      },
    });
    expect(invalid.journal?.response).toMatchObject({ status: 400, fixture: null });
    expectReplay(sentinel, stream);
  },
);

const supportedContent = [
  { id: "missing", fields: {} },
  { id: "null", fields: { content: null } },
  { id: "empty-array", fields: { content: [] } },
];

test.each(modes.flatMap((mode) => supportedContent.map((content) => ({ ...mode, ...content }))))(
  "preserves $id $role content normalization (stream=$stream)",
  async ({ role, stream, fields }) => {
    const server = await start();
    const result = await post(server, [{ role, ...fields }], stream);
    expectReplay(result, stream);
    expect(result.journal?.body?.messages).toEqual([
      { role, content: role === "user" ? "" : null },
    ]);
  },
);
