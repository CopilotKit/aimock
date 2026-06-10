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

  test("status poll after submit reaches completed with unsigned_urls and usage", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "poll me", endpoint: "video" },
      response: { video: { id: "vid_p", status: "completed", cost: 0.05 } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "poll me" }),
    });
    const { id } = await submit.json();

    const poll = await fetch(`${mock.url}/api/v1/videos/${id}`);
    expect(poll.status).toBe(200);
    const data = await poll.json();
    expect(data.id).toBe(id);
    expect(data.status).toBe("completed");
    expect(data.unsigned_urls).toEqual([`${mock.url}/api/v1/videos/${id}/content?index=0`]);
    expect(data.usage).toEqual({ cost: 0.05 });
  });

  test("usage.cost defaults to 0 when the fixture omits it", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "free", endpoint: "video" },
      response: { video: { id: "vid_f", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "free" }),
    });
    const { id } = await submit.json();
    const data = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(data.usage).toEqual({ cost: 0 });
  });

  test("failed fixture polls to failed with error message", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "doomed", endpoint: "video" },
      response: { video: { id: "vid_x", status: "failed", error: "content policy violation" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "doomed" }),
    });
    const { id } = await submit.json();

    const data = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(data.status).toBe("failed");
    expect(data.error).toBe("content policy violation");
    expect(data.unsigned_urls).toBeUndefined();
  });

  test("failed fixture without error message uses default", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "doomed quietly", endpoint: "video" },
      response: { video: { id: "vid_q", status: "failed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "doomed quietly" }),
    });
    const { id } = await submit.json();
    const data = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(data.status).toBe("failed");
    expect(data.error).toBe("Video generation failed");
  });

  test("status poll for unknown job returns 404", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos/nonexistent-job`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe(404);
  });

  test("configured progression advances pending → in_progress → completed", async () => {
    mock = new LLMock({
      port: 0,
      openRouterVideo: { pollsBeforeInProgress: 1, pollsBeforeCompleted: 2 },
    });
    mock.addFixture({
      match: { userMessage: "staged", endpoint: "video" },
      response: { video: { id: "vid_s", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "staged" }),
    });
    const { id, status } = await submit.json();
    expect(status).toBe("pending");

    const poll1 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll1.status).toBe("in_progress");
    const poll2 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll2.status).toBe("completed");
  });

  test("equal thresholds still pass through in_progress for one poll", async () => {
    mock = new LLMock({
      port: 0,
      openRouterVideo: { pollsBeforeInProgress: 2, pollsBeforeCompleted: 2 },
    });
    mock.addFixture({
      match: { userMessage: "equal", endpoint: "video" },
      response: { video: { id: "vid_e", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "equal" }),
    });
    const { id } = await submit.json();

    const poll1 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll1.status).toBe("pending");
    const poll2 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll2.status).toBe("in_progress");
    const poll3 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll3.status).toBe("completed");
  });

  test("progression applies to failed jobs too", async () => {
    mock = new LLMock({
      port: 0,
      openRouterVideo: { pollsBeforeInProgress: 1, pollsBeforeCompleted: 2 },
    });
    mock.addFixture({
      match: { userMessage: "staged fail", endpoint: "video" },
      response: { video: { id: "vid_sf", status: "failed", error: "boom" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "staged fail" }),
    });
    const { id } = await submit.json();

    const poll1 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll1.status).toBe("in_progress");
    const poll2 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll2.status).toBe("failed");
    expect(poll2.error).toBe("boom");
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

// ─── Task 4: GET /api/v1/videos/{jobId}/content — download ──────────────────

describe("GET /api/v1/videos/{jobId}/content (OpenRouter download)", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  async function submitJob(prompt: string): Promise<string> {
    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt }),
    });
    const { id } = (await submit.json()) as { id: string };
    return id;
  }

  test("requires Authorization header (401 OpenRouter shape)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "auth me", endpoint: "video" },
      response: { video: { id: "vid_a", status: "completed", b64: "AAAA" } },
    });
    await mock.start();
    const id = await submitJob("auth me");

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.message).toBe("No auth credentials found");
    expect(data.error.code).toBe(401);
  });

  test("404 for unknown job", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos/nope/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe(404);
  });

  test("non-completed job returns a JSON error", async () => {
    mock = new LLMock({
      port: 0,
      openRouterVideo: { pollsBeforeInProgress: 5, pollsBeforeCompleted: 10 },
    });
    mock.addFixture({
      match: { userMessage: "slow", endpoint: "video" },
      response: { video: { id: "vid_sl", status: "completed", b64: "AAAA" } },
    });
    await mock.start();
    const id = await submitJob("slow");

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const data = await res.json();
    expect(data.error.message).toContain("not completed");
  });

  test("serves base64 fixture bytes as video/mp4", async () => {
    const bytes = Buffer.from("mock video bytes");
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "bytes", endpoint: "video" },
      response: {
        video: { id: "vid_b", status: "completed", b64: bytes.toString("base64") },
      },
    });
    await mock.start();
    const id = await submitJob("bytes");
    // Reach completed via a status poll first (lifecycle order).
    await fetch(`${mock.url}/api/v1/videos/${id}`);

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  test("serves built-in mp4 placeholder when fixture has no b64", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "placeholder", endpoint: "video" },
      response: { video: { id: "vid_ph", status: "completed" } },
    });
    await mock.start();
    const id = await submitJob("placeholder");

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
    // ftyp box marker at byte offset 4
    expect(body.subarray(4, 8).toString("ascii")).toBe("ftyp");
  });

  test("replies video/mp4 even when the client sends Accept: application/octet-stream", async () => {
    // The @openrouter/sdk (Speakeasy-generated) sends Accept:
    // application/octet-stream but the real endpoint replies video/mp4.
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "accept octet", endpoint: "video" },
      response: { video: { id: "vid_ao", status: "completed", b64: "AAAA" } },
    });
    await mock.start();
    const id = await submitJob("accept octet");

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test", Accept: "application/octet-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
  });
});

// ─── Task 5: GET /api/v1/videos/models — model listing ──────────────────────

describe("GET /api/v1/videos/models (OpenRouter video model listing)", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("synthesizes the listing from video fixtures with string models", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { model: "bytedance/seedance-2.0", endpoint: "video" },
      response: { video: { id: "v1", status: "completed" } },
    });
    mock.addFixture({
      match: { model: "openai/sora-2", endpoint: "video" },
      response: { video: { id: "v2", status: "completed" } },
    });
    // Non-video fixture model must NOT appear
    mock.addFixture({
      match: { model: "gpt-4o", userMessage: "hi" },
      response: { content: "hello" },
    });
    // Regex-model video fixture must NOT appear (string models only)
    mock.addFixture({
      match: { model: /kling/, endpoint: "video" },
      response: { video: { id: "v3", status: "completed" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const ids = data.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(["bytedance/seedance-2.0", "openai/sora-2"]);
    for (const entry of data.data) {
      expect(typeof entry.name).toBe("string");
      expect(Array.isArray(entry.supported_durations)).toBe(true);
      expect(Array.isArray(entry.supported_resolutions)).toBe(true);
      expect(Array.isArray(entry.supported_aspect_ratios)).toBe(true);
    }
  });

  test("returns sensible defaults when no video fixtures are loaded", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
    expect(typeof data.data[0].id).toBe("string");
  });

  test("models path is not swallowed by the status handler", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    // If the status RE matched first, this would be a 404 "Video job models
    // not found" — it must instead return the model listing envelope.
    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toBeUndefined();
    expect(Array.isArray(data.data)).toBe(true);
  });
});
