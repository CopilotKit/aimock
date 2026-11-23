import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

/**
 * The `video` endpoint namespace is SHARED by five handlers with two mutually
 * incompatible fixture response shapes:
 *
 *   - Sora / Grok / Veo / OpenRouter consume a `VideoResponse` (`{ video: … }`);
 *   - BytePlus Ark consumes the raw task envelope as a `RawJSONResponse`
 *     (`{ json: … }`), because its whole contract is "replay what was recorded".
 *
 * Both are authored as `match: { endpoint: "video" }`, so before the router
 * partitioned the namespace a single BytePlus fixture became a candidate for
 * every other handler, each of which then failed its own `isVideoResponse`
 * guard and journalled a 500. These tests pin the partition in BOTH directions.
 */

const BYTEPLUS_MODEL = "seedance-1-0-pro-fast-251015";
const BYTEPLUS_SUBMIT = "/api/v3/contents/generations/tasks";
const PROMPT = "a cat playing";

/** The BytePlus fixture exactly as this surface's docs instruct authors to write it. */
function bytePlusFixtureBody(): Record<string, unknown> {
  return {
    model: BYTEPLUS_MODEL,
    status: "succeeded",
    created_at: 1785000000,
    updated_at: Math.floor(Date.now() / 1000),
    content: { video_url: "https://ark-content.example.com/out.mp4" },
  };
}

type Submit = { name: string; run: (base: string) => Promise<Response> };

const OTHER_PROVIDERS: Submit[] = [
  {
    name: "grok",
    run: (base) =>
      fetch(`${base}/v1/videos/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "grok-imagine-v0.9", prompt: PROMPT }),
      }),
  },
  {
    name: "openrouter",
    run: (base) =>
      fetch(`${base}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: PROMPT }),
      }),
  },
  {
    name: "sora",
    run: (base) =>
      fetch(`${base}/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sora-2", prompt: PROMPT }),
      }),
  },
  {
    name: "veo",
    run: (base) =>
      fetch(`${base}/v1beta/models/veo-3.1-generate-preview:predictLongRunning`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instances: [{ prompt: PROMPT }] }),
      }),
  },
];

describe("shared `video` fixture namespace", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("a BytePlus {json} fixture does not make Grok/OpenRouter/Sora/Veo submits 500", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a cat", endpoint: "video" },
      response: { json: bytePlusFixtureBody() },
    });
    await mock.start();

    const broken: string[] = [];
    for (const p of OTHER_PROVIDERS) {
      const res = await p.run(mock.url);
      const text = await res.text();
      if (res.status === 500) broken.push(`${p.name}=500 ${text}`);
    }
    expect(broken).toEqual([]);
  });

  test("each other provider still serves its OWN video fixture alongside a BytePlus one", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a cat", endpoint: "video" },
      response: { json: bytePlusFixtureBody() },
    });
    mock.addFixture({
      match: { userMessage: PROMPT, endpoint: "video" },
      response: {
        video: { id: "vid_own", status: "completed", url: "https://example.com/own.mp4" },
      },
    });
    await mock.start();

    const served: string[] = [];
    for (const p of OTHER_PROVIDERS) {
      const res = await p.run(mock.url);
      const text = await res.text();
      served.push(
        `${p.name}=${res.status}${text.includes("not a video type") ? " NOT-A-VIDEO-TYPE" : ""}`,
      );
    }
    expect(served).toEqual(["grok=200", "openrouter=202", "sora=200", "veo=200"]);
  });

  test("a VideoResponse fixture is not served to a BytePlus submit", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: PROMPT, endpoint: "video" },
      response: {
        video: { id: "vid_own", status: "completed", url: "https://example.com/own.mp4" },
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}${BYTEPLUS_SUBMIT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: BYTEPLUS_MODEL,
        content: [{ type: "text", text: PROMPT }],
      }),
    });
    const text = await res.text();
    expect(res.status).not.toBe(200);
    expect(text).not.toContain("https://example.com/own.mp4");
  });

  test("a BytePlus submit still replays its own {json} fixture", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: PROMPT, endpoint: "video", model: BYTEPLUS_MODEL },
      response: { json: bytePlusFixtureBody() },
    });
    await mock.start();

    const res = await fetch(`${mock.url}${BYTEPLUS_SUBMIT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: BYTEPLUS_MODEL,
        content: [{ type: "text", text: PROMPT }],
      }),
    });
    expect(res.status).toBe(200);
    const data: { id?: string } = await res.json();
    expect(typeof data.id).toBe("string");
  });
});
