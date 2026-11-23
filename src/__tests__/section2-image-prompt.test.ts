import { afterEach, describe, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
let transformCalls = 0;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const routes = [
  { name: "openai", path: "/v1/images/generations", model: "gpt-image-1" },
  {
    name: "gemini",
    path: "/v1beta/models/imagen-3.0-generate-002:predict",
    model: "imagen-3.0-generate-002",
  },
] as const;
type Route = (typeof routes)[number];

async function start(route: Route, catchAll = false) {
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
      endpoint: "image",
      model: route.model,
      ...(catchAll ? {} : { userMessage: "a guitar" }),
      sequenceIndex: 0,
    },
    response: { image: { url: "first.png", b64Json: "RklSU1Q=" } },
  });
  await mock.start();
}

async function post(route: Route, prompt: unknown, model: unknown = undefined) {
  if (!mock) throw new Error("Server not started");
  const body = route.name === "openai" ? { prompt, model } : { instances: [{ prompt }], model };
  const response = await fetch(mock.url + route.path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const result = {
    status: response.status,
    text: await response.text(),
    cors: response.headers.get("access-control-allow-origin"),
  };
  console.log(JSON.stringify({ route: route.path, body, ...result }));
  return result;
}

function expectFirstImage(route: Route, result: Awaited<ReturnType<typeof post>>) {
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toMatchObject(
    route.name === "openai"
      ? { data: [{ url: "first.png", b64_json: "RklSU1Q=" }] }
      : { predictions: [{ bytesBase64Encoded: "RklSU1Q=", mimeType: "image/png" }] },
  );
}

describe.each(routes)("image prompt validation $name", (route) => {
  describe.each([false, true])("catch-all fixture %s", (catchAll) => {
    test.each(
      [42, {}, [], [null], [{ type: "text", text: 42 }], [{ text: "x" }]].map((prompt) => ({
        prompt,
      })),
    )("rejects malformed prompt %j without consuming the first image", async ({ prompt }) => {
      await start(route, catchAll);
      const result = await post(route, prompt);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.text)).toEqual({
        error: {
          message: "Invalid parameter: 'prompt' must be a string or non-empty content-parts array",
          type: "invalid_request_error",
        },
      });
      expect(result.cors).toBe("*");
      expect(mock?.journal.getLast()).toMatchObject({
        body: null,
        response: { status: 400, fixture: null },
      });
      expect(transformCalls).toBe(0);
      expectFirstImage(route, await post(route, "a guitar"));
      expect(transformCalls).toBe(1);
    });
  });

  test.each([undefined, null, "", false, 0])(
    "control missing prompt %j retains required-field error and first fixture",
    async (prompt) => {
      await start(route, true);
      const result = await post(route, prompt);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.text)).toEqual({
        error: { message: "Missing required parameter: 'prompt'", type: "invalid_request_error" },
      });
      expectFirstImage(route, await post(route, "a guitar"));
    },
  );

  test.each([undefined, null, route.model])(
    "control string prompt and model %j matches first fixture",
    async (model) => {
      await start(route);
      expectFirstImage(route, await post(route, "a guitar", model));
    },
  );

  test.each(
    [
      [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }],
      [{ type: "text", text: "", custom: true }],
      [{ type: "image_url" }, { type: "text", text: "a guitar" }],
    ].map((prompt) => ({ prompt })),
  )("preserves valid structured prompt $prompt verbatim", async ({ prompt }) => {
    await start(route, true);
    expectFirstImage(route, await post(route, prompt));
    expect(mock?.journal.getLast()).toMatchObject({
      body: { messages: [{ role: "user", content: prompt }] },
    });
  });

  test("control mixed content parts preserve text matching", async () => {
    await start(route);
    expectFirstImage(
      route,
      await post(route, [
        { type: "image_url", image_url: { url: "https://example.test/image.png" } },
        { type: "text", text: "a guitar" },
      ]),
    );
  });

  test("control existing content-parts normalization matches text fixture", async () => {
    await start(route);
    expectFirstImage(route, await post(route, [{ type: "text", text: "a guitar" }]));
  });
});
