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

// ─── Task 6: cross-cutting conformance ──────────────────────────────────────

describe("OpenRouter video — strict mode diagnostics", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("strict 503 reports sequence/turn skip via shared matcher", async () => {
    mock = new LLMock({ port: 0, strict: true });
    mock.addFixture({
      match: { userMessage: "once only", endpoint: "video", sequenceIndex: 0 },
      response: { video: { id: "vid_seq", status: "completed" } },
    });
    await mock.start();

    const first = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "once only" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "once only" }),
    });
    expect(second.status).toBe(503);
    const data = await second.json();
    expect(data.error.message).toMatch(SKIPPED_BY_STATE_RE);
  });
});

describe("OpenRouter video — journal coverage", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("every lifecycle path journals an entry", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "journal me", endpoint: "video" },
      response: { video: { id: "vid_j", status: "completed", b64: "AAAA" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "journal me" }),
    });
    const { id } = (await submit.json()) as { id: string };
    await fetch(`${mock.url}/api/v1/videos/${id}`);
    await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`); // 401
    await fetch(`${mock.url}/api/v1/videos/unknown-job`); // 404
    await fetch(`${mock.url}/api/v1/videos/models`);
    await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "no match here" }),
    }); // 404 no-match
    await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    }); // 400 malformed

    const entries = mock.journal.getAll();
    const byPathStatus = entries.map((e) => `${e.method} ${e.path} ${e.response.status}`);
    expect(byPathStatus).toContain(`POST /api/v1/videos 200`);
    expect(byPathStatus).toContain(`GET /api/v1/videos/${id} 200`);
    expect(byPathStatus).toContain(`GET /api/v1/videos/${id}/content?index=0 200`);
    expect(byPathStatus).toContain(`GET /api/v1/videos/${id}/content?index=0 401`);
    expect(byPathStatus).toContain(`GET /api/v1/videos/unknown-job 404`);
    expect(byPathStatus).toContain(`GET /api/v1/videos/models 200`);
    expect(byPathStatus).toContain(`POST /api/v1/videos 404`);
    expect(byPathStatus).toContain(`POST /api/v1/videos 400`);
  });
});

describe("OpenRouter video — chaos injection", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("chaos drop header applies to submit, status, and content", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "chaotic", endpoint: "video" },
      response: { video: { id: "vid_c", status: "completed", b64: "AAAA" } },
    });
    await mock.start();

    // Establish a real job first (no chaos)
    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "chaotic" }),
    });
    const { id } = (await submit.json()) as { id: string };

    const chaosHeaders = { "x-aimock-chaos-drop": "1" };
    const droppedSubmit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...chaosHeaders },
      body: JSON.stringify({ model: "m/v", prompt: "chaotic" }),
    });
    expect(droppedSubmit.status).toBe(500);
    expect((await droppedSubmit.json()).error.code).toBe("chaos_drop");

    const droppedStatus = await fetch(`${mock.url}/api/v1/videos/${id}`, {
      headers: chaosHeaders,
    });
    expect(droppedStatus.status).toBe(500);
    expect((await droppedStatus.json()).error.code).toBe("chaos_drop");

    const droppedContent = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test", ...chaosHeaders },
    });
    expect(droppedContent.status).toBe(500);
    expect((await droppedContent.json()).error.code).toBe("chaos_drop");
  });
});

describe("OpenRouter video — full lifecycle integration", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("submit → pending → in_progress → completed → download", async () => {
    const bytes = Buffer.from("the generated video");
    mock = new LLMock({
      port: 0,
      openRouterVideo: { pollsBeforeInProgress: 2, pollsBeforeCompleted: 3 },
    });
    mock.addFixture({
      match: { userMessage: "full lifecycle", endpoint: "video" },
      response: {
        video: {
          id: "vid_fl",
          status: "completed",
          b64: bytes.toString("base64"),
          cost: 0.12,
        },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model: "bytedance/seedance-2.0", prompt: "full lifecycle" }),
    });
    expect(submit.status).toBe(200);
    const envelope = await submit.json();
    expect(envelope.status).toBe("pending");

    const poll1 = await (await fetch(envelope.polling_url)).json();
    expect(poll1.status).toBe("pending");
    const poll2 = await (await fetch(envelope.polling_url)).json();
    expect(poll2.status).toBe("in_progress");
    const poll3 = await (await fetch(envelope.polling_url)).json();
    expect(poll3.status).toBe("completed");
    expect(poll3.usage).toEqual({ cost: 0.12 });
    expect(poll3.unsigned_urls).toHaveLength(1);

    const download = await fetch(poll3.unsigned_urls[0], {
      headers: { Authorization: "Bearer test" },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("video/mp4");
    const body = Buffer.from(await download.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  test("failed lifecycle: submit → poll failed → download rejected", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "fail lifecycle", endpoint: "video" },
      response: { video: { id: "vid_flf", status: "failed", error: "nsfw content" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "fail lifecycle" }),
    });
    const envelope = await submit.json();
    expect(envelope.status).toBe("pending");

    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.status).toBe("failed");
    expect(poll.error).toBe("nsfw content");
    expect(poll.unsigned_urls).toBeUndefined();

    const download = await fetch(`${mock.url}/api/v1/videos/${envelope.id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(download.status).toBe(400);
  });

  test("download without auth is rejected even for a completed job", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "auth lifecycle", endpoint: "video" },
      response: { video: { id: "vid_al", status: "completed", b64: "AAAA" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "auth lifecycle" }),
    });
    const { id } = (await submit.json()) as { id: string };
    await fetch(`${mock.url}/api/v1/videos/${id}`); // completed

    const unauthorized = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`);
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()).error.message).toBe("No auth credentials found");

    const authorized = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(authorized.status).toBe(200);
  });
});

// ─── CR findings: input validation (400, not 500/mismatch) ─────────────────

describe("OpenRouter video — request body validation", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("JSON body `null` returns 400 invalid_request_error (not a raw 500)", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.type).toBe("invalid_request_error");
  });

  test("JSON array body returns 400 invalid_request_error", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[1,2]",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.type).toBe("invalid_request_error");
  });

  test("non-string prompt returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: 123 }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.message).toContain("prompt");
  });

  test("non-string model returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: 123, prompt: "a sunset" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.message).toContain("model");
  });
});

// ─── CR findings: testId embedded in generated URLs ────────────────────────

describe("OpenRouter video — testId scoping of generated URLs", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  function addFixtureFor(prompt: string): void {
    mock.addFixture({
      match: { userMessage: prompt, endpoint: "video" },
      response: { video: { id: "vid_tid", status: "completed", b64: "AAAA" } },
    });
  }

  test("polling_url carries testId and resolves the job without the header", async () => {
    mock = new LLMock({ port: 0 });
    addFixtureFor("scoped poll");
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "test-a" },
      body: JSON.stringify({ model: "m/v", prompt: "scoped poll" }),
    });
    const envelope = await submit.json();
    expect(envelope.polling_url).toContain("testId=test-a");

    // Bare fetch — no X-Test-Id header — must still find the job via the URL.
    const poll = await fetch(envelope.polling_url);
    expect(poll.status).toBe(200);
    const data = await poll.json();
    expect(data.id).toBe(envelope.id);
  });

  test("unsigned_urls carry testId and resolve content without the header", async () => {
    mock = new LLMock({ port: 0 });
    addFixtureFor("scoped content");
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "test-a" },
      body: JSON.stringify({ model: "m/v", prompt: "scoped content" }),
    });
    const envelope = await submit.json();

    const poll = await fetch(envelope.polling_url);
    const data = await poll.json();
    expect(data.status).toBe("completed");
    expect(data.unsigned_urls[0]).toContain("testId=test-a");

    // The @openrouter/sdk fetches unsigned URLs directly without custom
    // headers — only Authorization. The testId in the URL must scope it.
    const download = await fetch(data.unsigned_urls[0], {
      headers: { Authorization: "Bearer test" },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("video/mp4");
  });

  test("job submitted under one testId is invisible to another", async () => {
    mock = new LLMock({ port: 0 });
    addFixtureFor("isolated");
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "test-a" },
      body: JSON.stringify({ model: "m/v", prompt: "isolated" }),
    });
    const { id } = (await submit.json()) as { id: string };

    const crossPoll = await fetch(`${mock.url}/api/v1/videos/${id}`, {
      headers: { "X-Test-Id": "test-b" },
    });
    expect(crossPoll.status).toBe(404);
  });

  test("default testId leaves URLs clean (no testId param)", async () => {
    mock = new LLMock({ port: 0 });
    addFixtureFor("clean urls");
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "clean urls" }),
    });
    const envelope = await submit.json();
    expect(envelope.polling_url).not.toContain("testId=");

    const data = await (await fetch(envelope.polling_url)).json();
    expect(data.unsigned_urls[0]).not.toContain("testId=");
  });
});

// ─── CR findings: x-forwarded-proto in generated URLs ──────────────────────

describe("OpenRouter video — x-forwarded-proto scheme", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("generated URLs use https when x-forwarded-proto says so", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "behind proxy", endpoint: "video" },
      response: { video: { id: "vid_xp", status: "completed", b64: "AAAA" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ model: "m/v", prompt: "behind proxy" }),
    });
    const envelope = await submit.json();
    expect(envelope.polling_url.startsWith("https://")).toBe(true);

    // Poll over plain http (the mock listens on http) with the header set —
    // unsigned_urls must come back https too.
    const httpPollUrl = envelope.polling_url.replace(/^https:/, "http:");
    const data = await (
      await fetch(httpPollUrl, { headers: { "X-Forwarded-Proto": "https" } })
    ).json();
    expect(data.unsigned_urls[0].startsWith("https://")).toBe(true);
  });

  test("URLs stay http without the header", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "direct", endpoint: "video" },
      response: { video: { id: "vid_dh", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "direct" }),
    });
    const envelope = await submit.json();
    expect(envelope.polling_url.startsWith("http://")).toBe(true);
  });
});

// ─── CR findings: Bearer scheme validation on /content ─────────────────────

describe("OpenRouter video — Bearer scheme validation", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  async function completedJob(prompt: string): Promise<string> {
    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt }),
    });
    const { id } = (await submit.json()) as { id: string };
    await fetch(`${mock.url}/api/v1/videos/${id}`); // advance to completed
    return id;
  }

  test("non-Bearer Authorization scheme is rejected with 401", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "scheme check", endpoint: "video" },
      response: { video: { id: "vid_sc", status: "completed", b64: "AAAA" } },
    });
    await mock.start();
    const id = await completedJob("scheme check");

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Basic xyz" },
    });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.message).toBe("No auth credentials found");
    expect(data.error.code).toBe(401);
  });

  test("minimal Bearer credential is accepted", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "bearer ok", endpoint: "video" },
      response: { video: { id: "vid_bk", status: "completed", b64: "AAAA" } },
    });
    await mock.start();
    const id = await completedJob("bearer ok");

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer k" },
    });
    expect(res.status).toBe(200);
  });
});

describe("OpenRouter video — routing collision regression", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("Ollama /api/chat still routes to the Ollama handler", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "ollama hello" },
      response: { content: "hello from ollama" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        messages: [{ role: "user", content: "ollama hello" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message.content).toBe("hello from ollama");
  });

  test("Ollama /api/embeddings still routes to the Ollama handler", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", prompt: "embed me" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.embedding)).toBe(true);
  });

  test("OpenAI /v1/videos lifecycle is unaffected", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "openai video", endpoint: "video" },
      response: {
        video: { id: "vid_oa", status: "completed", url: "https://example.com/oa.mp4" },
      },
    });
    await mock.start();

    const create = await fetch(`${mock.url}/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "sora-2", prompt: "openai video" }),
    });
    expect(create.status).toBe(200);
    const created = await create.json();
    // OpenAI-shaped response: status/url on the video object, no polling_url
    expect(created.id).toBe("vid_oa");
    expect(created.polling_url).toBeUndefined();
    expect(created.url).toBe("https://example.com/oa.mp4");

    const status = await fetch(`${mock.url}/v1/videos/vid_oa`);
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.status).toBe("completed");
  });
});
