import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { resolveProgression } from "../fal.js";
import type { VideoResponse } from "../types.js";
import { SKIPPED_BY_STATE_RE } from "./helpers/strict-matchers.js";

// ─── Task 1: shared progression resolver + extended video fixture fields ───

describe("resolveProgression (shared with fal queue)", () => {
  test("is exported and defaults to 0/0 (complete on first poll)", () => {
    expect(resolveProgression(undefined)).toEqual({
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 0,
    });
  });

  test("inProgress-only config defaults completed to one poll later", () => {
    expect(resolveProgression({ pollsBeforeInProgress: 2 })).toEqual({
      pollsBeforeInProgress: 2,
      pollsBeforeCompleted: 3,
    });
  });

  test("clamps completed >= inProgress", () => {
    expect(resolveProgression({ pollsBeforeInProgress: 3, pollsBeforeCompleted: 1 })).toEqual({
      pollsBeforeInProgress: 3,
      pollsBeforeCompleted: 3,
    });
  });
});

describe("VideoResponse extended fields", () => {
  test("accepts error, b64, and cost on the video object", () => {
    const failed: VideoResponse = {
      video: { id: "v1", status: "failed", error: "policy violation" },
    };
    const completed: VideoResponse = {
      video: { id: "v2", status: "completed", b64: "AAAA", cost: 0.05 },
    };
    expect(failed.video.error).toBe("policy violation");
    expect(completed.video.b64).toBe("AAAA");
    expect(completed.video.cost).toBe(0.05);
  });

  test("openRouterVideo progression config is accepted in server options", async () => {
    const mock = new LLMock({
      port: 0,
      openRouterVideo: { pollsBeforeInProgress: 1, pollsBeforeCompleted: 2 },
    });
    await mock.start();
    await mock.stop();
  });
});

// ─── Task 2: POST /api/v1/videos (submit) ───────────────────────────────────

describe("POST /api/v1/videos (OpenRouter submit)", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("fixture match returns {id, polling_url, status: pending}", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a sunset over the ocean", endpoint: "video" },
      response: {
        video: { id: "vid_or_1", status: "completed", url: "https://example.com/v.mp4" },
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "bytedance/seedance-2.0",
        prompt: "a sunset over the ocean",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.id).toBe("string");
    expect(data.id.length).toBeGreaterThan(0);
    expect(data.status).toBe("pending");
    expect(data.polling_url).toBe(`${mock.url}/api/v1/videos/${data.id}`);
  });

  test("matches on model when the fixture restricts it", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { model: "bytedance/seedance-2.0", endpoint: "video" },
      response: { video: { id: "vid_m", status: "completed" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "anything" }),
    });
    expect(res.status).toBe(200);
  });

  test("malformed JSON body returns 400 invalid_json", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("invalid_json");
  });

  test("missing prompt returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("prompt");
  });

  test("no fixture match returns OpenRouter-shaped 404 in non-strict mode", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "no such fixture" }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe(404);
    expect(typeof data.error.message).toBe("string");
  });

  test("no fixture match returns 503 in strict mode", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "no such fixture" }),
    });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error.code).toBe("no_fixture_match");
  });

  test("error fixture returns the configured status", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "rate me", endpoint: "video" },
      response: { error: { message: "rate limited", type: "rate_limit_error" }, status: 429 },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "rate me" }),
    });
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error.message).toBe("rate limited");
  });

  test("non-video fixture response returns 500", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "text only", endpoint: "video" },
      response: { content: "not a video" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "text only" }),
    });
    expect(res.status).toBe(500);
  });
});
