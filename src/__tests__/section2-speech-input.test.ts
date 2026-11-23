import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
let transformCalls = 0;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start(selective = false) {
  transformCalls = 0;
  mock = new LLMock({
    port: 0,
    requestTransform: (request) => {
      transformCalls++;
      return request;
    },
  });
  mock.addFixture({
    match: {
      endpoint: "speech",
      model: "tts-1",
      sequenceIndex: 0,
      ...(selective ? { userMessage: "hello" } : {}),
    },
    response: { audio: "SGVsbG8=" },
  });
  await mock.start();
}

async function post(body: unknown) {
  if (!mock) throw new Error("Server not started");
  const response = await fetch(`${mock.url}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const result = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cors: response.headers.get("access-control-allow-origin"),
    text: bytes.toString("utf8"),
    base64: bytes.toString("base64"),
  };
  console.log(JSON.stringify({ request: body, response: result }));
  return result;
}

test.each(
  [
    42,
    {},
    [],
    [null],
    [{}],
    [{ type: 1 }],
    [{ type: "text", text: 42 }],
    [{ type: "text", text: "hello" }, null],
    [[]],
  ].map((input) => ({ input })),
)("reject malformed input $input before sequence matching", async ({ input }) => {
  await start();
  const result = await post({ model: "tts-1", voice: "alloy", input });
  const observed = {
    journal: mock?.journal.getAll(),
    counts: [...(mock?.journal.fixtureMatchCounts.values() ?? [])],
    transformCalls,
  };
  const next = await post({ input: "hello" });
  console.log(JSON.stringify({ input, observed, next }));
  expect(result.status).toBe(400);
  expect(result.cors).toBe("*");
  expect(observed.transformCalls).toBe(0);
  expect(observed.counts).toEqual([]);
  expect(JSON.parse(result.text)).toEqual({
    error: {
      message: "Invalid parameter: 'input' must be a string or a nonempty array of content parts",
      type: "invalid_request_error",
    },
  });
  expect(observed.journal).toMatchObject([{ response: { status: 400, fixture: null } }]);
  expect(next).toMatchObject({
    status: 200,
    contentType: "audio/mpeg",
    base64: "SGVsbG8=",
  });
});

test.each([undefined, "", null, 0, false])("preserves required input=%j", async (input) => {
  await start();
  const result = await post({ model: "tts-1", voice: "alloy", input });
  expect(result.status).toBe(400);
  expect(JSON.parse(result.text)).toEqual({
    error: { message: "Missing required parameter: 'input'", type: "invalid_request_error" },
  });
  expect(await post({ input: "hello" })).toMatchObject({
    status: 200,
    contentType: "audio/mpeg",
    base64: "SGVsbG8=",
  });
});

test("preserves valid string and existing optional field defaults", async () => {
  await start(true);
  expect(
    await post({ input: "hello", model: null, voice: 42, response_format: "opus", speed: {} }),
  ).toMatchObject({ status: 200, contentType: "audio/mpeg", base64: "SGVsbG8=" });
});

test("preserves fixture determines opus content type", async () => {
  transformCalls = 0;
  mock = new LLMock({
    port: 0,
    requestTransform: (request) => {
      transformCalls++;
      return request;
    },
  });
  mock.onSpeech("hello", { audio: "SGVsbG8=", format: "opus" });
  await mock.start();
  expect(await post({ input: "hello", voice: "alloy" })).toMatchObject({
    status: 200,
    contentType: "audio/opus",
    base64: "SGVsbG8=",
  });
});

test.each(
  [
    [{ type: "text", text: "hello" }],
    [
      { type: "text", text: "hel" },
      { type: "image_url", image_url: { url: "local" } },
      { type: "text", text: "lo" },
    ],
  ].map((input) => ({ input })),
)("matches supported content parts %j", async ({ input }) => {
  await start(true);
  expect(await post({ input })).toMatchObject({
    status: 200,
    contentType: "audio/mpeg",
    base64: "SGVsbG8=",
  });
});
test.each(
  [[{ type: "text", text: "" }], [{ type: "image_url" }], [{ type: "text" }]].map((input) => ({
    input,
  })),
)("preserves structural content parts %j", async ({ input }) => {
  await start();
  expect(await post({ input })).toMatchObject({
    status: 200,
    contentType: "audio/mpeg",
    base64: "SGVsbG8=",
  });
});
