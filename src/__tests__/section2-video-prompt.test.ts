import { describe, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

const invalidMessage =
  "Invalid parameter: 'prompt' must be a string or a non-empty array of content parts";

async function withVideo(run: (mock: LLMock, transforms: () => number) => Promise<void>) {
  let transformed = 0;
  const mock = new LLMock({
    port: 0,
    requestTransform: (request) => {
      transformed++;
      return request;
    },
  });
  for (const sequenceIndex of [0, 1]) {
    mock.addFixture({
      match: { model: "sora-2", endpoint: "video", sequenceIndex },
      response: {
        video: {
          id: `video-${sequenceIndex}`,
          status: "completed",
          url: "https://example.com/video.mp4",
        },
      },
    });
  }
  await mock.start();
  try {
    await run(mock, () => transformed);
  } finally {
    await mock.stop();
  }
}

async function post(mock: LLMock, prompt: unknown, model: string | null | undefined = undefined) {
  const response = await fetch(`${mock.url}/v1/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
    signal: AbortSignal.timeout(5000),
  });
  return { response, body: await response.json() };
}

async function status(mock: LLMock) {
  const response = await fetch(`${mock.url}/v1/videos/video-0`, {
    signal: AbortSignal.timeout(5000),
  });
  return { response, body: await response.json() };
}

async function assertRejected(prompt: unknown, message = invalidMessage) {
  await withVideo(async (mock, transforms) => {
    const result = await post(mock, prompt);
    expect(result.response.status).toBe(400);
    expect(result.body).toEqual({ error: { message, type: "invalid_request_error" } });
    expect(result.response.headers.get("access-control-allow-origin")).toBe("*");
    expect(mock.getRequests()).toHaveLength(1);
    expect(mock.getRequests()[0]).toMatchObject({
      body: null,
      response: { status: 400, fixture: null },
    });
    expect(transforms()).toBe(0);
    expect((await status(mock)).response.status).toBe(404);
    const valid = await post(mock, "a guitar");
    expect(valid.response.status).toBe(200);
    expect(valid.body.id).toBe("video-0");
    expect((await status(mock)).body).toEqual(valid.body);
  });
}

describe("video prompt validation", () => {
  test.each([
    { label: "number", prompt: 42 },
    { label: "object", prompt: {} },
    { label: "empty array", prompt: [] },
  ])("rejects $label before consuming a fixture or creating video state", async ({ prompt }) => {
    await assertRejected(prompt);
  });

  test.each([[null], [[]], [{}], [{ type: 1 }], [{ type: "text", text: 42 }]])(
    "rejects malformed part %#",
    async (...parts) => {
      await assertRejected(parts);
    },
  );

  test.each([undefined, null, "", 0, false])(
    "preserves existing required error for %s",
    async (prompt) => {
      await assertRejected(prompt, "Missing required parameter: 'prompt'");
    },
  );

  test.each([
    { label: "string", prompt: "a guitar" },
    { label: "text parts", prompt: [{ type: "text", text: "a guitar" }] },
    {
      label: "mixed parts",
      prompt: [
        { type: "image_url", image_url: { url: "x" } },
        { type: "text", text: "" },
      ],
    },
    { label: "nontext parts", prompt: [{ type: "image_url" }] },
  ])("preserves $label and lifecycle", async ({ prompt }) => {
    await withVideo(async (mock) => {
      const result = await post(mock, prompt);
      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({
        id: "video-0",
        status: "completed",
        url: "https://example.com/video.mp4",
        created_at: expect.any(Number),
      });
      expect((await status(mock)).body).toEqual(result.body);
      expect((await post(mock, "next")).body.id).toBe("video-1");
    });
  });

  test("preserves text-part matching and null model default", async () => {
    const mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { model: "sora-2", endpoint: "video", userMessage: "a guitar" },
      response: { video: { id: "video-0", status: "completed" } },
    });
    await mock.start();
    try {
      expect(
        (
          await post(
            mock,
            [
              { type: "text", text: "a " },
              { type: "text", text: "guitar" },
            ],
            null,
          )
        ).body.id,
      ).toBe("video-0");
    } finally {
      await mock.stop();
    }
  });

  test("preserves multipart string prompts", async () => {
    await withVideo(async (mock) => {
      const form = new FormData();
      form.set("prompt", "a guitar");
      form.set("seconds", "8");
      const response = await fetch(`${mock.url}/v1/videos`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect((await status(mock)).body).toEqual(await response.json());
    });
  });

  test("does not proxy invalid input on fixture miss", async () => {
    await withVideo(async (upstream) => {
      const mock = new LLMock({
        port: 0,
        record: { providers: { openai: upstream.url }, proxyOnly: true },
      });
      await mock.start();
      try {
        expect((await post(mock, 42)).response.status).toBe(400);
        expect(upstream.getRequests()).toHaveLength(0);
      } finally {
        await mock.stop();
      }
    });
  });
});
