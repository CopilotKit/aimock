import { describe, test, expect, afterEach, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { createServer } from "../server.js";
import { resolveProgression } from "../fal.js";
import { OpenRouterVideoJobMap, OPENROUTER_VIDEO_MAX_ENTRIES } from "../openrouter-video.js";
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

  test("treats non-finite thresholds as unset (NaN can never propagate)", () => {
    // A NaN threshold would make advanceJob's `pollCount >= NaN` comparison
    // permanently false — a polling client would never reach terminal.
    expect(resolveProgression({ pollsBeforeCompleted: NaN })).toEqual({
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 0,
    });
    expect(resolveProgression({ pollsBeforeInProgress: NaN })).toEqual({
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 0,
    });
    expect(resolveProgression({ pollsBeforeCompleted: Infinity })).toEqual({
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 0,
    });
  });

  test("clamps negative thresholds to 0 (explicit-0 progression contract)", () => {
    // {pollsBeforeInProgress: -1} must behave as an explicit 0 — progression
    // enabled — not resolve completed to 0 (seed-terminal).
    expect(resolveProgression({ pollsBeforeInProgress: -1 })).toEqual({
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 1,
    });
    expect(resolveProgression({ pollsBeforeInProgress: 2, pollsBeforeCompleted: -5 })).toEqual({
      pollsBeforeInProgress: 2,
      pollsBeforeCompleted: 2,
    });
  });

  test("floors fractional thresholds to integers", () => {
    expect(resolveProgression({ pollsBeforeInProgress: 1.9 })).toEqual({
      pollsBeforeInProgress: 1,
      pollsBeforeCompleted: 2,
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
    try {
      expect(mock.url).toMatch(/^http:/);
    } finally {
      await mock.stop();
    }
  });
});

// ─── Task 2: POST /api/v1/videos (submit) ───────────────────────────────────

describe("POST /api/v1/videos (OpenRouter submit)", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
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
    const data = await res.json();
    expect(data.error.type).toBe("server_error");
    expect(data.error.message).toBe("Fixture response is not a video type");
  });
});

// ─── Task 4: GET /api/v1/videos/{jobId}/content — download ──────────────────

describe("GET /api/v1/videos/{jobId}/content (OpenRouter download)", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  async function submitJob(prompt: string): Promise<string> {
    if (!mock) throw new Error("mock not started");
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

  test("content fetches never advance job state (no poll budget consumed)", async () => {
    mock = new LLMock({ port: 0, openRouterVideo: { pollsBeforeCompleted: 1 } });
    mock.addFixture({
      match: { userMessage: "no advance", endpoint: "video" },
      response: { video: { id: "vid_na", status: "completed", b64: "AAAA" } },
    });
    await mock.start();
    const id = await submitJob("no advance");

    // Two content fetches against the not-yet-completed job: both must 400
    // (API fidelity; diverges from fal's advance-on-result queue semantics).
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
        headers: { Authorization: "Bearer test" },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain("not completed");
    }

    // First real status poll: had the content fetches advanced the job, it
    // would already be past the pollsBeforeCompleted: 1 threshold. Instead
    // poll 1 reports in_progress — content fetches consumed no poll budget.
    const poll1 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll1.status).toBe("in_progress");
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
    // Status poll before download mirrors the real client flow. Under the
    // default 0/0 progression the job is already seeded terminal at submit,
    // so this poll is not what makes the job completed.
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer();

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
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
    expect(res.headers.get("content-length")).toBe(String(body.length));
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
  let mock: LLMock | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
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
    // Order-insensitive: ids come from Set iteration, not a documented order.
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining(["bytedance/seedance-2.0", "openai/sora-2"]));
    for (const entry of data.data) {
      expect(typeof entry.name).toBe("string");
      expect(Array.isArray(entry.supported_durations)).toBe(true);
      expect(Array.isArray(entry.supported_resolutions)).toBe(true);
      expect(Array.isArray(entry.supported_aspect_ratios)).toBe(true);
    }
  });

  test("falls back to built-in defaults and is not swallowed by the status handler", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    // If the status RE captured "models" as a jobId, this would be the status
    // handler's 404 shape: { error: { message: "Video job models not found",
    // code: 404 } }. Assert that exact shape is absent and that the built-in
    // default model listing comes back instead (no video fixtures loaded).
    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("Video job models not found");
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
    expect(typeof data.data[0].id).toBe("string");
  });

  test("debug-logs when video fixtures exist but none contribute a string model", async () => {
    mock = new LLMock({ port: 0, logLevel: "debug" });
    // RegExp-model video fixture: real video fixtures are loaded, yet the
    // listing silently falls back to the default model set.
    mock.addFixture({
      match: { model: /kling/, endpoint: "video" },
      response: { video: { id: "vid_rx", status: "completed" } },
    });
    await mock.start();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.length).toBeGreaterThan(0);
    expect(
      logSpy.mock.calls.some((c) =>
        c.join(" ").includes("No video fixture contributes a string model"),
      ),
    ).toBe(true);
  });
});

// ─── Task 6: cross-cutting conformance ──────────────────────────────────────

describe("OpenRouter video — strict mode diagnostics", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
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
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
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
    // Consume every response body so no connection is left dangling.
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer();
    await (
      await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
        headers: { Authorization: "Bearer test" },
      })
    ).arrayBuffer();
    await (await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`)).arrayBuffer(); // 401
    await (await fetch(`${mock.url}/api/v1/videos/unknown-job`)).arrayBuffer(); // 404
    await (await fetch(`${mock.url}/api/v1/videos/models`)).arrayBuffer();
    await (
      await fetch(`${mock.url}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m/v", prompt: "no match here" }),
      })
    ).arrayBuffer(); // 404 no-match
    await (
      await fetch(`${mock.url}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{nope",
      })
    ).arrayBuffer(); // 400 malformed

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

  test("a handler throw on submit journals a 500 entry", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "factory boom", endpoint: "video" },
      response: () => {
        throw new Error("factory boom");
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "factory boom" }),
    });
    expect(res.status).toBe(500);
    await res.arrayBuffer();

    // Without catch-block journaling the request is invisible — and the
    // throwing fixture's sequence slot was already consumed with no trace.
    const entries = mock.journal.getAll();
    expect(
      entries.some(
        (e) => e.method === "POST" && e.path === "/api/v1/videos" && e.response.status === 500,
      ),
    ).toBe(true);
  });
});

describe("OpenRouter video — chaos injection", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
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

describe("OpenRouter video — chaos source label and models route", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("submit chaos with no fixture journals source internal (surface never proxies)", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const dropped = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aimock-chaos-drop": "1" },
      body: JSON.stringify({ model: "m/v", prompt: "no fixture here" }),
    });
    expect(dropped.status).toBe(500);
    expect((await dropped.json()).error.code).toBe("chaos_drop");

    const entry = mock.journal
      .getAll()
      .find((e) => e.path === "/api/v1/videos" && e.response.chaosAction === "drop");
    expect(entry).toBeDefined();
    expect(entry!.response.source).toBe("internal");
  });

  test("chaos drop header applies to the models route", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const dropped = await fetch(`${mock.url}/api/v1/videos/models`, {
      headers: { "x-aimock-chaos-drop": "1" },
    });
    expect(dropped.status).toBe(500);
    expect((await dropped.json()).error.code).toBe("chaos_drop");

    // Without the header the route still serves the listing.
    const ok = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(ok.status).toBe(200);
  });
});

// ─── CR findings: logger observability ──────────────────────────────────────

describe("OpenRouter video — logger observability", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
  });

  test("warns when a processing fixture is coerced to completed", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "still processing", endpoint: "video" },
      response: { video: { id: "vid_pr", status: "processing" } },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "still processing" }),
    });
    expect(res.status).toBe(200);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("processing"))).toBe(true);
  });

  test("warns about the record-mode gap on no-match when record is configured", async () => {
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      record: { providers: { openai: "http://127.0.0.1:9" } },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "unrecorded prompt" }),
    });
    expect(res.status).toBe(404);
    expect(
      warnSpy.mock.calls.some((c) => c.join(" ").includes("record mode is not supported")),
    ).toBe(true);
  });

  test("no record warn fires when record is not configured", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "no fixture" }),
    });
    expect(
      warnSpy.mock.calls.some((c) => c.join(" ").includes("record mode is not supported")),
    ).toBe(false);
  });

  test("no-match debug log includes model and prompt snippet", async () => {
    mock = new LLMock({ port: 0, logLevel: "debug" });
    await mock.start();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "acme/video-x", prompt: "a very specific prompt" }),
    });
    expect(
      logSpy.mock.calls.some((c) => {
        const line = c.join(" ");
        return (
          line.includes("No fixture matched") &&
          line.includes("acme/video-x") &&
          line.includes("a very specific prompt")
        );
      }),
    ).toBe(true);
  });

  test("warns when fixture b64 decodes to zero bytes but still serves the decode", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "corrupt bytes", endpoint: "video" },
      // "!!!!" is non-empty but contains no valid base64 characters — the
      // decode yields a 0-byte buffer.
      response: { video: { id: "vid_cb", status: "completed", b64: "!!!!" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "corrupt bytes" }),
    });
    const { id } = (await submit.json()) as { id: string };
    // Status poll mirrors the client flow; under default 0/0 the job is
    // already seeded terminal at submit, so this poll doesn't complete it.
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(0); // the decode is served as-is, just warned about
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("base64"))).toBe(true);
  });

  test("warns when b64 contains invalid characters even if the decode is non-empty", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "partial corrupt", endpoint: "video" },
      // Node's lenient decoder skips the "!!!" run and still yields bytes —
      // a zero-byte-only guard misses this silently-truncating corruption.
      response: { video: { id: "vid_pc", status: "completed", b64: "AAAA!!!tail" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "partial corrupt" }),
    });
    const { id } = (await submit.json()) as { id: string };
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer(); // completed

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBeGreaterThan(0); // the lossy decode is still served
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("base64"))).toBe(true);
  });

  test("does not warn on valid non-canonical base64 (nonzero trailing bits)", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "non canonical", endpoint: "video" },
      // "QR" is valid base64 for the single byte 0x41, but non-canonical: its
      // final character carries nonzero discarded trailing bits, so it
      // re-encodes as "QQ". A byte-exact round-trip comparison would falsely
      // flag it as corrupt.
      response: { video: { id: "vid_nc", status: "completed", b64: "QR" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "non canonical" }),
    });
    const { id } = (await submit.json()) as { id: string };
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer(); // completed

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(Buffer.from([0x41]))).toBe(true);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("base64"))).toBe(false);
  });

  test("does not warn on concatenated base64 with interior padding", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "interior padding", endpoint: "video" },
      // "QQ==QQ==" is two valid padded groups concatenated. Node's decoder
      // treats the first "=" as a terminator and decodes only "QQ==" (one
      // byte) — counting the post-padding characters as data chars would
      // falsely flag the payload as corrupt.
      response: { video: { id: "vid_ip", status: "completed", b64: "QQ==QQ==" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "interior padding" }),
    });
    const { id } = (await submit.json()) as { id: string };
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer(); // completed

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(Buffer.from([0x41]))).toBe(true);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("base64"))).toBe(false);
  });

  test("warns when sanitized b64 length is congruent to 1 mod 4", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "mod4 one", endpoint: "video" },
      // "QQQQQ" is malformed base64: Node silently drops the trailing "Q"
      // and the floor formula agrees with the truncated decode, so the
      // length-mismatch check alone never fires.
      response: { video: { id: "vid_m1", status: "completed", b64: "QQQQQ" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "mod4 one" }),
    });
    const { id } = (await submit.json()) as { id: string };
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer(); // completed

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200); // the truncated decode is still served
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(3);
    expect(
      warnSpy.mock.calls.some((c) =>
        c.join(" ").includes("payload is malformed or contains invalid characters"),
      ),
    ).toBe(true);
  });

  test("warns when fixture sets video.url but no b64 (placeholder served)", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "url only", endpoint: "video" },
      // The author set a url expecting it to control the bytes — the
      // OpenRouter content endpoint ignores it and serves the placeholder.
      response: {
        video: { id: "vid_uo", status: "completed", url: "https://example.com/v.mp4" },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "url only" }),
    });
    const { id } = (await submit.json()) as { id: string };
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer(); // completed

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(4, 8).toString("ascii")).toBe("ftyp"); // placeholder
    expect(
      warnSpy.mock.calls.some((c) => {
        const line = c.join(" ");
        return line.includes("url is ignored") && line.includes("b64");
      }),
    ).toBe(true);
  });

  test("warns when fixture b64 is the empty string (placeholder served)", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "empty b64", endpoint: "video" },
      // b64: "" is falsy — without a dedicated warn the handler silently
      // serves the placeholder as if b64 were absent entirely.
      response: { video: { id: "vid_e64", status: "completed", b64: "" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "empty b64" }),
    });
    const { id } = (await submit.json()) as { id: string };
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer(); // completed

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(4, 8).toString("ascii")).toBe("ftyp"); // placeholder
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("empty b64"))).toBe(true);
  });

  test("warns when a rejected x-forwarded-host falls back to the Host header", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "rejected host", endpoint: "video" },
      response: { video: { id: "vid_rj", status: "completed" } },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Host": "evil.com/path" },
      body: JSON.stringify({ model: "m/v", prompt: "rejected host" }),
    });
    const envelope = await submit.json();
    // Still falls back to the Host header (pre-existing junk-host behavior).
    expect(envelope.polling_url.startsWith(`${mock.url}/api/v1/videos/`)).toBe(true);
    expect(
      warnSpy.mock.calls.some((c) => c.join(" ").includes("x-forwarded-host value rejected")),
    ).toBe(true);
  });

  test("warns on an unknown fixture status and treats the job as completed", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "typo status", endpoint: "video" },
      response: {
        // JSON-authored fixtures bypass the compile-time union — simulate a typo.
        video: { id: "vid_ts", status: "FAILED" as VideoResponse["video"]["status"] },
      },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "typo status" }),
    });
    expect(submit.status).toBe(200);
    const { id } = (await submit.json()) as { id: string };
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes('"FAILED"'))).toBe(true);

    const poll = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll.status).toBe("completed");
  });

  test("submit handler throw is logged via logger.error and returns 500", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "boom", endpoint: "video" },
      response: () => {
        throw new Error("factory boom");
      },
    });
    await mock.start();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "boom" }),
    });
    expect(res.status).toBe(500);
    expect(errorSpy.mock.calls.some((c) => c.join(" ").includes("openrouter-video submit"))).toBe(
      true,
    );
  });
});

describe("OpenRouter video — full lifecycle integration", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
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
    // Status poll mirrors the client flow; under default 0/0 the job is
    // already seeded terminal (completed) at submit.
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer();

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
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
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
    // Present-but-invalid prompt: "Missing required parameter" would be
    // wrong — the parameter is there. Mirrors the model path's message style.
    expect(data.error.message).toBe(
      "Invalid type for parameter: 'prompt' must be a non-empty string",
    );
  });

  test("empty-string prompt returns 400 with a non-empty-string message", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.message).toBe(
      "Invalid type for parameter: 'prompt' must be a non-empty string",
    );
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

  test("empty-string model returns 400 invalid_request_error", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "", prompt: "a sunset" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.message).toContain("model");
  });

  test("validation 400s journal the parsed request body (malformed JSON stays null)", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    await (
      await fetch(`${mock.url}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: 123, prompt: "a sunset" }),
      })
    ).arrayBuffer(); // non-string model
    await (
      await fetch(`${mock.url}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m/v" }),
      })
    ).arrayBuffer(); // missing prompt
    await (
      await fetch(`${mock.url}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{nope",
      })
    ).arrayBuffer(); // malformed JSON

    const entries = mock.journal.getAll().filter((e) => e.response.status === 400);
    expect(entries).toHaveLength(3);
    // Field-validation 400s journal a structurally valid synthetic body
    // (JournalEntry.body is ChatCompletionRequest | null): raw fields ride
    // along, messages is always an array, and a non-string model is
    // JSON-encoded so the field stays a string.
    expect(entries[0].body).toMatchObject({ model: "123", prompt: "a sunset", messages: [] });
    expect(entries[1].body).toMatchObject({ model: "m/v", messages: [] });
    expect(entries[2].body).toBeNull();
  });
});

// ─── CR findings: testId embedded in generated URLs ────────────────────────

describe("OpenRouter video — testId scoping of generated URLs", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  function addFixtureFor(prompt: string): void {
    if (!mock) throw new Error("mock not started");
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

// ─── CR findings: x-forwarded-proto/host in generated URLs ─────────────────

describe("OpenRouter video — x-forwarded-proto/host", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
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

  test("non-http(s) x-forwarded-proto values fall back to http", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "weird proto", endpoint: "video" },
      response: { video: { id: "vid_wp", status: "completed", b64: "AAAA" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "ws" },
      body: JSON.stringify({ model: "m/v", prompt: "weird proto" }),
    });
    const envelope = await submit.json();
    expect(envelope.polling_url.startsWith("http://")).toBe(true);
  });

  test("polling_url uses x-forwarded-host when present (first value wins)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "forwarded host", endpoint: "video" },
      response: { video: { id: "vid_fh", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Host": "mock.example.com, inner.proxy.local",
      },
      body: JSON.stringify({ model: "m/v", prompt: "forwarded host" }),
    });
    const envelope = await submit.json();
    expect(envelope.polling_url.startsWith("http://mock.example.com/")).toBe(true);
  });

  test("x-forwarded-proto and x-forwarded-host combine in generated URLs", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "proxied host and proto", endpoint: "video" },
      response: { video: { id: "vid_fhp", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "mock.example.com",
      },
      body: JSON.stringify({ model: "m/v", prompt: "proxied host and proto" }),
    });
    const envelope = await submit.json();
    expect(envelope.polling_url.startsWith("https://mock.example.com/")).toBe(true);
  });

  test("bracketed IPv6 x-forwarded-host literals are honored", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "v6 host", endpoint: "video" },
      response: { video: { id: "vid_v6", status: "completed" } },
    });
    await mock.start();

    for (const host of ["[::1]", "[::1]:8080"]) {
      const submit = await fetch(`${mock.url}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-Host": host },
        body: JSON.stringify({ model: "m/v", prompt: "v6 host" }),
      });
      const envelope = await submit.json();
      expect(envelope.polling_url.startsWith(`http://${host}/api/v1/videos/`)).toBe(true);
    }
  });

  test("junk x-forwarded-host values fall back to the Host header", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "junk host", endpoint: "video" },
      response: { video: { id: "vid_jh", status: "completed" } },
    });
    await mock.start();

    // Spaces, slashes (path smuggling), and userinfo are not valid in a bare
    // host[:port] — each must be rejected in favor of the Host header.
    for (const junk of ["mock example com", "evil.com/path", "user@evil.com"]) {
      const submit = await fetch(`${mock.url}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-Host": junk },
        body: JSON.stringify({ model: "m/v", prompt: "junk host" }),
      });
      const envelope = await submit.json();
      expect(envelope.polling_url.startsWith(`${mock.url}/api/v1/videos/`)).toBe(true);
    }
  });
});

// ─── CR findings: Bearer scheme validation on /content ─────────────────────

describe("OpenRouter video — Bearer scheme validation", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  async function completedJob(prompt: string): Promise<string> {
    if (!mock) throw new Error("mock not started");
    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt }),
    });
    const { id } = (await submit.json()) as { id: string };
    // Status poll mirrors the client flow; under default 0/0 the job is
    // already seeded terminal (completed) at submit.
    await (await fetch(`${mock.url}/api/v1/videos/${id}`)).arrayBuffer();
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

  test("lowercase bearer scheme is accepted (RFC 7235 schemes are case-insensitive)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "lower bearer", endpoint: "video" },
      response: { video: { id: "vid_lb", status: "completed", b64: "AAAA" } },
    });
    await mock.start();
    const id = await completedJob("lower bearer");

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "bearer sk-x" },
    });
    expect(res.status).toBe(200);
  });

  test("Bearer with an empty credential is rejected with 401", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "empty bearer", endpoint: "video" },
      response: { video: { id: "vid_eb", status: "completed", b64: "AAAA" } },
    });
    await mock.start();
    const id = await completedJob("empty bearer");

    // fetch trims header whitespace, so "Bearer " arrives as "Bearer" — a
    // scheme with no credential either way.
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("No auth credentials found");
  });
});

// ─── CR findings: server close clears per-instance video state ─────────────

describe("server close clears video job state", () => {
  test("close() empties both videoStates and openRouterVideoJobs", async () => {
    const fixtures = [
      {
        match: { userMessage: "openai close", endpoint: "video" as const },
        response: { video: { id: "vid_close_oa", status: "completed" as const } },
      },
      {
        match: { userMessage: "openrouter close", endpoint: "video" as const },
        response: { video: { id: "vid_close_or", status: "completed" as const } },
      },
    ];
    const instance = await createServer(fixtures, { port: 0 });
    // Idempotent close so the finally block can't double-close (which would
    // reject with ERR_SERVER_NOT_RUNNING) after a successful in-test close.
    let closed = false;
    const closeServer = (): Promise<void> => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) => {
        instance.server.close((err) => (err ? reject(err) : resolve()));
      });
    };

    try {
      // Populate both per-instance maps (consume both bodies so no
      // connection is left dangling across the close below).
      await (
        await fetch(`${instance.url}/v1/videos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "sora-2", prompt: "openai close" }),
        })
      ).arrayBuffer();
      await (
        await fetch(`${instance.url}/api/v1/videos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "m/v", prompt: "openrouter close" }),
        })
      ).arrayBuffer();
      expect(instance.videoStates.size).toBeGreaterThan(0);
      expect(instance.openRouterVideoJobs.size).toBeGreaterThan(0);

      await closeServer();
      expect(instance.openRouterVideoJobs.size).toBe(0);
      expect(instance.videoStates.size).toBe(0);
    } finally {
      // No-op when the test already closed; prevents a leaked server when a
      // mid-test assertion fails.
      await closeServer();
    }
  });
});

describe("OpenRouter video — routing collision regression", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
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

// ─── Review coverage: job-map internals, reset plumbing, config + headers ───

describe("OpenRouterVideoJobMap (unit)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeJob(id: string) {
    return {
      jobId: id,
      status: "pending" as const,
      pollCount: 0,
      pollsBeforeInProgress: 0,
      pollsBeforeCompleted: 0,
      video: { id, status: "completed" as const },
    };
  }

  test("entries expire after the 1h TTL (lazy eviction on get)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const map = new OpenRouterVideoJobMap();
    map.set("t:job1", makeJob("job1"));
    expect(map.get("t:job1")).toBeDefined();

    // At exactly the TTL boundary the entry is still alive (strict >).
    vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
    expect(map.get("t:job1")).toBeDefined();
    expect(map.size).toBe(1);

    // One tick past the TTL: get() lazily evicts and returns undefined.
    vi.setSystemTime(new Date("2026-01-01T01:00:00.001Z"));
    expect(map.get("t:job1")).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test("evicts the oldest entries FIFO beyond the 10k capacity", () => {
    const map = new OpenRouterVideoJobMap();
    const CAP = OPENROUTER_VIDEO_MAX_ENTRIES;
    const job = makeJob("shared"); // entries may share one job object — keeps this fast
    for (let i = 0; i <= CAP; i++) {
      map.set(`t:job${i}`, job);
    }
    expect(map.size).toBe(CAP);
    expect(map.get("t:job0")).toBeUndefined(); // oldest entry evicted FIFO
    expect(map.get("t:job1")).toBeDefined();
    expect(map.get(`t:job${CAP}`)).toBeDefined(); // newest entry retained
  });
});

describe("OpenRouter video — reset plumbing", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  async function submitJob(prompt: string): Promise<string> {
    if (!mock) throw new Error("mock not started");
    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt }),
    });
    const { id } = (await submit.json()) as { id: string };
    return id;
  }

  test("POST /__aimock/reset/fixtures clears job state (old jobId polls 404)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "reset http", endpoint: "video" },
      response: { video: { id: "vid_rh", status: "completed" } },
    });
    await mock.start();
    const id = await submitJob("reset http");

    const before = await fetch(`${mock.url}/api/v1/videos/${id}`);
    expect(before.status).toBe(200);
    await before.arrayBuffer();

    const reset = await fetch(`${mock.url}/__aimock/reset/fixtures`, { method: "POST" });
    expect(reset.status).toBe(200);
    await reset.arrayBuffer();

    const after = await fetch(`${mock.url}/api/v1/videos/${id}`);
    expect(after.status).toBe(404);
    expect((await after.json()).error.code).toBe(404);
  });

  test("LLMock.reset() clears job state (old jobId polls 404)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "reset api", endpoint: "video" },
      response: { video: { id: "vid_ra", status: "completed" } },
    });
    await mock.start();
    const id = await submitJob("reset api");

    const before = await fetch(`${mock.url}/api/v1/videos/${id}`);
    expect(before.status).toBe(200);
    await before.arrayBuffer();

    mock.reset();

    const after = await fetch(`${mock.url}/api/v1/videos/${id}`);
    expect(after.status).toBe(404);
    expect((await after.json()).error.code).toBe(404);
  });
});

describe("OpenRouter video — config and header overrides", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("completed-only config ({pollsBeforeCompleted}) passes through in_progress", async () => {
    mock = new LLMock({ port: 0, openRouterVideo: { pollsBeforeCompleted: 2 } });
    mock.addFixture({
      match: { userMessage: "completed only", endpoint: "video" },
      response: { video: { id: "vid_co", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "completed only" }),
    });
    const { id, status } = (await submit.json()) as { id: string; status: string };
    expect(status).toBe("pending");

    // pollsBeforeInProgress defaults to 0, so the first poll is already
    // in_progress; the second crosses the explicit completed threshold.
    const poll1 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll1.status).toBe("in_progress");
    const poll2 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll2.status).toBe("completed");
  });

  test("{pollsBeforeCompleted: 1} lands terminal on poll 2 (in_progress consumes poll 1)", async () => {
    mock = new LLMock({ port: 0, openRouterVideo: { pollsBeforeCompleted: 1 } });
    mock.addFixture({
      match: { userMessage: "late by one", endpoint: "video" },
      response: { video: { id: "vid_lbo", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "late by one" }),
    });
    const { id } = (await submit.json()) as { id: string };

    // pollsBeforeInProgress is unset (0), so the in_progress branch consumes
    // poll 1 even though the configured completed threshold is 1 — the
    // terminal status lands one poll later than configured.
    const poll1 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll1.status).toBe("in_progress");
    const poll2 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll2.status).toBe("completed");
  });

  test("X-AIMock-Strict header turns a no-match 404 into a 503 on a strict-off server", async () => {
    mock = new LLMock({ port: 0 }); // strict defaults off
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIMock-Strict": "true" },
      body: JSON.stringify({ model: "m/v", prompt: "nothing matches this" }),
    });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error.code).toBe("no_fixture_match");
  });
});

// ─── Round-2 polish: pins of existing behavior ──────────────────────────────

describe("OpenRouter video — pinned existing behavior", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("X-Test-Id header wins over the ?testId= query param (getTestId precedence)", async () => {
    // getTestId (helpers.ts) checks the x-test-id header before falling back
    // to the ?testId= query param — the header wins when both are present.
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "precedence", endpoint: "video" },
      response: { video: { id: "vid_prec", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "test-a" },
      body: JSON.stringify({ model: "m/v", prompt: "precedence" }),
    });
    const { id } = (await submit.json()) as { id: string };

    // Header test-b beats query test-a → the job (scoped to test-a) is not
    // visible → 404.
    const headerWins = await fetch(`${mock.url}/api/v1/videos/${id}?testId=test-a`, {
      headers: { "X-Test-Id": "test-b" },
    });
    expect(headerWins.status).toBe(404);
    await headerWins.arrayBuffer();

    // Header test-a beats query test-b → the job resolves despite the
    // mismatched query param.
    const headerMatches = await fetch(`${mock.url}/api/v1/videos/${id}?testId=test-b`, {
      headers: { "X-Test-Id": "test-a" },
    });
    expect(headerMatches.status).toBe(200);
    await headerMatches.arrayBuffer();
  });

  test("X-AIMock-Strict: false downgrades a strict server's no-match 503 to 404", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIMock-Strict": "false" },
      body: JSON.stringify({ model: "m/v", prompt: "nothing matches this" }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe(404);
  });

  test("multipart/form-data submit returns 400 invalid_json (no multipart parsing)", async () => {
    // Unlike the OpenAI-shaped /v1/videos handler (which parses multipart
    // bodies for openai SDK >= 6.28.0), this surface only parses JSON — the
    // @openrouter/sdk sends JSON today. Watch-item: if the SDK ever shifts to
    // multipart video-create requests, this pin will flag the gap.
    mock = new LLMock({ port: 0 });
    await mock.start();

    const form = new FormData();
    form.set("model", "m/v");
    form.set("prompt", "a sunset over the ocean");
    const res = await fetch(`${mock.url}/api/v1/videos`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("invalid_json");
  });

  test("'processing'-status fixture runs the full lifecycle to completed + download", async () => {
    // terminalStatus coerces a non-failed fixture status — including
    // "processing" — to completed, so the lifecycle still terminates.
    const bytes = Buffer.from("processing fixture bytes");
    mock = new LLMock({ port: 0, logLevel: "silent" }); // silence the coercion warn
    mock.addFixture({
      match: { userMessage: "processing lifecycle", endpoint: "video" },
      response: {
        video: { id: "vid_prl", status: "processing", b64: bytes.toString("base64") },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "processing lifecycle" }),
    });
    expect(submit.status).toBe(200);
    const envelope = await submit.json();
    expect(envelope.status).toBe("pending");

    const poll = await (await fetch(envelope.polling_url)).json();
    expect(poll.status).toBe("completed");
    expect(poll.unsigned_urls).toHaveLength(1);

    const download = await fetch(poll.unsigned_urls[0], {
      headers: { Authorization: "Bearer test" },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("video/mp4");
    const body = Buffer.from(await download.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  test("post-terminal polls of a completed job are idempotent (urls + usage persist)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "idempotent done", endpoint: "video" },
      response: { video: { id: "vid_idc", status: "completed", cost: 0.07 } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "idempotent done" }),
    });
    const { id } = (await submit.json()) as { id: string };

    const bodies: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const poll = await fetch(`${mock.url}/api/v1/videos/${id}`);
      expect(poll.status).toBe(200);
      bodies.push(await poll.json());
    }
    expect(bodies[0]).toEqual({
      id,
      status: "completed",
      unsigned_urls: [`${mock.url}/api/v1/videos/${id}/content?index=0`],
      usage: { cost: 0.07 },
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  test("post-terminal polls of a failed job are idempotent (error persists)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "idempotent fail", endpoint: "video" },
      response: { video: { id: "vid_idf", status: "failed", error: "quota exceeded" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "idempotent fail" }),
    });
    const { id } = (await submit.json()) as { id: string };

    const bodies: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const poll = await fetch(`${mock.url}/api/v1/videos/${id}`);
      expect(poll.status).toBe(200);
      bodies.push(await poll.json());
    }
    expect(bodies[0]).toEqual({ id, status: "failed", error: "quota exceeded" });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  test("content fetch with Bearer immediately after submit succeeds under default 0/0", async () => {
    // Under the default 0/0 progression the job is seeded terminal at submit,
    // so content is downloadable without any status poll ever happening. Pins
    // the documented divergence from fal's advance-on-result semantics: the
    // content endpoint never advances job state, and with 0/0 it doesn't
    // need to.
    const bytes = Buffer.from("no poll needed");
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "no poll", endpoint: "video" },
      response: { video: { id: "vid_np", status: "completed", b64: bytes.toString("base64") } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "no poll" }),
    });
    const { id } = (await submit.json()) as { id: string };

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });
});

// ─── CR round 8: journal sanitization, threshold validation, header edge cases ─

describe("OpenRouter video — validation journal body sanitization", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("validation-400 journal body strips underscore-prefixed client keys", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    // A client body carrying _endpointType/_context must not be able to
    // plant values journal consumers treat as trusted handler-set
    // discriminators.
    const res = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: 1, model: "m/v", _endpointType: "chat", _context: "x" }),
    });
    expect(res.status).toBe(400);
    await res.arrayBuffer();

    const entry = mock.journal
      .getAll()
      .find((e) => e.path === "/api/v1/videos" && e.response.status === 400);
    expect(entry).toBeDefined();
    const body = entry!.body as unknown as Record<string, unknown>;
    expect(body._endpointType).toBeUndefined();
    expect(body._context).toBeUndefined();
    // The raw prompt field and the normalized model are still preserved.
    expect(body.prompt).toBe(1);
    expect(body.model).toBe("m/v");
  });
});

describe("OpenRouter video — progression threshold sanitization (e2e)", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
  });

  test("NaN pollsBeforeCompleted cannot strand a job short of terminal", async () => {
    mock = new LLMock({ port: 0, openRouterVideo: { pollsBeforeCompleted: NaN } });
    mock.addFixture({
      match: { userMessage: "nan threshold", endpoint: "video" },
      response: { video: { id: "vid_nan", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "nan threshold" }),
    });
    const { id } = (await submit.json()) as { id: string };

    // Without sanitization `pollCount >= NaN` is always false — the job
    // never terminates and a polling client hangs forever. The job must
    // reach a terminal status within a bounded number of polls.
    let status = "";
    for (let i = 0; i < 5; i++) {
      const poll = (await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json()) as {
        status: string;
      };
      status = poll.status;
      if (status === "completed" || status === "failed") break;
    }
    expect(status).toBe("completed");
  });

  test("negative pollsBeforeInProgress behaves as explicit 0 (progression enabled)", async () => {
    mock = new LLMock({ port: 0, openRouterVideo: { pollsBeforeInProgress: -1 } });
    mock.addFixture({
      match: { userMessage: "negative threshold", endpoint: "video" },
      response: { video: { id: "vid_neg", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "negative threshold" }),
    });
    const { id } = (await submit.json()) as { id: string };

    // -1 clamps to an explicit 0: progression is enabled (poll 1 is
    // in_progress, poll 2 completed) instead of seed-terminal at submit.
    const poll1 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll1.status).toBe("in_progress");
    const poll2 = await (await fetch(`${mock.url}/api/v1/videos/${id}`)).json();
    expect(poll2.status).toBe("completed");
  });

  test("createServer warns on non-finite/negative poll thresholds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock = new LLMock({
      port: 0,
      logLevel: "warn",
      openRouterVideo: { pollsBeforeCompleted: NaN },
      falQueue: { pollsBeforeInProgress: -1 },
    });
    await mock.start();

    expect(
      warnSpy.mock.calls.some((c) => {
        const line = c.join(" ");
        return (
          line.includes("openRouterVideo.pollsBeforeCompleted") &&
          line.includes("not a non-negative integer")
        );
      }),
    ).toBe(true);
    expect(
      warnSpy.mock.calls.some((c) => {
        const line = c.join(" ");
        return (
          line.includes("falQueue.pollsBeforeInProgress") &&
          line.includes("not a non-negative integer")
        );
      }),
    ).toBe(true);
  });
});

describe("OpenRouter video — CR round 8 content/header polish", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
  });

  test("warns when a padding-only b64 decodes to zero bytes", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "padding only", endpoint: "video" },
      // "=" is truthy, sanitizes to "" (everything from the first "=" is
      // dropped), and decodes to 0 bytes — dodging both the empty-string
      // warn and the length-mismatch warn.
      response: { video: { id: "vid_pad", status: "completed", b64: "=" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "padding only" }),
    });
    const { id } = (await submit.json()) as { id: string };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(0); // the zero-byte decode is still served
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("zero bytes"))).toBe(true);
  });

  test("empty x-forwarded-host header is ignored without a rejection warn", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "empty fwd host", endpoint: "video" },
      response: { video: { id: "vid_efh", status: "completed" } },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Host": "" },
      body: JSON.stringify({ model: "m/v", prompt: "empty fwd host" }),
    });
    const envelope = await submit.json();
    // An empty value is treated as absent: Host is used, no spurious warn.
    expect(envelope.polling_url.startsWith(`${mock.url}/api/v1/videos/`)).toBe(true);
    expect(
      warnSpy.mock.calls.some((c) => c.join(" ").includes("x-forwarded-host value rejected")),
    ).toBe(false);
  });

  test("leading-comma x-forwarded-host list honors the first non-empty entry", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "comma fwd host", endpoint: "video" },
      response: { video: { id: "vid_cfh", status: "completed" } },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Host": ", real.example.com:8080",
      },
      body: JSON.stringify({ model: "m/v", prompt: "comma fwd host" }),
    });
    const envelope = await submit.json();
    expect(envelope.polling_url.startsWith("http://real.example.com:8080/api/v1/videos/")).toBe(
      true,
    );
    expect(
      warnSpy.mock.calls.some((c) => c.join(" ").includes("x-forwarded-host value rejected")),
    ).toBe(false);
  });

  test("rejected x-forwarded-host warn includes the offending value", async () => {
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "named bad host", endpoint: "video" },
      response: { video: { id: "vid_nbh", status: "completed" } },
    });
    await mock.start();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await (
      await fetch(`${mock.url}/api/v1/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-Host": "evil.com/path" },
        body: JSON.stringify({ model: "m/v", prompt: "named bad host" }),
      })
    ).arrayBuffer();

    expect(
      warnSpy.mock.calls.some((c) => {
        const line = c.join(" ");
        return line.includes("x-forwarded-host value rejected") && line.includes('"evil.com/path"');
      }),
    ).toBe(true);
  });

  test("warns when a non-zero content index is requested (still serves index 0)", async () => {
    const bytes = Buffer.from("only video");
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "indexed", endpoint: "video" },
      response: { video: { id: "vid_idx", status: "completed", b64: bytes.toString("base64") } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "indexed" }),
    });
    const { id } = (await submit.json()) as { id: string };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=3`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200); // behavior unchanged — index-0 bytes served
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("index"))).toBe(true);

    // index=0 (the canonical generated URL) must stay warn-free.
    warnSpy.mockClear();
    await (
      await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
        headers: { Authorization: "Bearer test" },
      })
    ).arrayBuffer();
    expect(warnSpy.mock.calls.some((c) => c.join(" ").includes("index"))).toBe(false);
  });

  test("mutating the fixture's video object after submit does not affect the job", async () => {
    const original = Buffer.from("original bytes");
    const video: VideoResponse["video"] = {
      id: "vid_mut",
      status: "completed",
      b64: original.toString("base64"),
    };
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "mutate me", endpoint: "video" },
      // A factory returning a shared object — later mutation must not
      // retroactively change an in-flight job's stored video.
      response: () => ({ video }),
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/api/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m/v", prompt: "mutate me" }),
    });
    const { id } = (await submit.json()) as { id: string };

    video.b64 = Buffer.from("tampered bytes").toString("base64");

    const res = await fetch(`${mock.url}/api/v1/videos/${id}/content?index=0`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(original)).toBe(true);
  });

  test("models listing excludes an empty-string match.model", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { model: "", endpoint: "video" },
      response: { video: { id: "vid_em", status: "completed" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/api/v1/videos/models`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.data.some((m) => m.id === "")).toBe(false);
    // With no usable string model the listing falls back to the default set.
    expect(data.data.length).toBeGreaterThan(0);
  });
});
