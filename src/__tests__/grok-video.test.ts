import { describe, test, expect, afterEach, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { GrokVideoJobMap, GROK_VIDEO_MAX_ENTRIES } from "../grok-video.js";
import type { VideoResponse } from "../types.js";

// ─── GrokVideoJobMap unit surface ────────────────────────────────────────────

describe("GrokVideoJobMap", () => {
  test("is exported with the bounded-entries constant", () => {
    expect(GROK_VIDEO_MAX_ENTRIES).toBe(10_000);
    const map = new GrokVideoJobMap();
    expect(map.size).toBe(0);
    expect(map.generation).toBe(0);
    map.clear();
    expect(map.generation).toBe(1);
  });
});

// ─── POST /v1/videos/generations (Grok submit) ───────────────────────────────

describe("POST /v1/videos/generations (Grok submit)", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("fixture match returns {request_id}", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a sunset over the ocean", endpoint: "video" },
      response: {
        video: { id: "vid_grok_1", status: "completed", url: "https://example.com/v.mp4" },
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "grok-imagine-video",
        prompt: "a sunset over the ocean",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.request_id).toBe("string");
    expect(data.request_id.length).toBeGreaterThan(0);
  });

  test("poll synthesizes climbing progress then done with video.url/duration and usage.cost_in_usd_ticks", async () => {
    mock = new LLMock({
      port: 0,
      grokVideo: { pollsBeforeInProgress: 1, pollsBeforeCompleted: 2 },
    });
    mock.addFixture({
      match: { userMessage: "poll me", endpoint: "video" },
      response: {
        video: {
          id: "vid_grok_p",
          status: "completed",
          url: "https://cdn.x.ai/v.mp4",
          duration: 6,
          cost: 0.05,
        },
      },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "poll me" }),
    });
    const { request_id } = await submit.json();

    // pollsBeforeInProgress:1, pollsBeforeCompleted:2 → poll1 = in_progress
    // (wire "pending", climbing progress), poll2 = completed (wire "done").
    const poll1 = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(poll1.request_id).toBe(request_id);
    expect(poll1.status).toBe("pending");
    expect(typeof poll1.progress).toBe("number");
    expect(poll1.progress).toBeLessThan(100);

    const done = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(done.status).toBe("done");
    expect(done.progress).toBe(100);
    expect(done.video).toEqual({ url: "https://cdn.x.ai/v.mp4", duration: 6 });
    // cost_in_usd_ticks = round(cost * 1e10) = round(0.05 * 1e10) = 500000000
    expect(done.usage).toEqual({ cost_in_usd_ticks: 500_000_000 });
  });

  test("0/0 progression seeds done immediately; default url placeholder when fixture omits it", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "seeded done", endpoint: "video" },
      response: { video: { id: "vid_seed", status: "completed" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "seeded done" }),
    });
    const { request_id } = await submit.json();
    const data = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(data.status).toBe("done");
    expect(data.progress).toBe(100);
    // Fixture omitted url → documented placeholder served.
    expect(typeof data.video.url).toBe("string");
    expect(data.video.url.length).toBeGreaterThan(0);
    expect(data.video.duration).toBe(0);
    expect(data.usage).toEqual({ cost_in_usd_ticks: 0 });
  });

  test("multipart submit 400s BEFORE body parse", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "ignored", endpoint: "video" },
      response: { video: { id: "vid_mp", status: "completed" } },
    });
    await mock.start();

    // Deliberately invalid (non-JSON) body: a multipart reject must fire BEFORE
    // any body parse, so a body that would otherwise 400-as-malformed-JSON
    // still yields the multipart 400 shape.
    const res = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=xyz" },
      body: "--xyz\r\nContent-Disposition: form-data; name=prompt\r\n\r\nhi\r\n--xyz--",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.code).toBe("string");
    expect(typeof data.error).toBe("string");
    expect(data.error.toLowerCase()).toContain("multipart");
  });

  test("malformed JSON submit 400s with {code,error}", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.code).toBe("string");
    expect(typeof data.error).toBe("string");
  });

  test("missing prompt 400s with {code,error}", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("invalid_request");
    expect(data.error).toContain("prompt");
  });

  test("failed fixture polls to {code,error}", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "doomed", endpoint: "video" },
      response: { video: { id: "vid_x", status: "failed", error: "content policy violation" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "doomed" }),
    });
    const { request_id } = await submit.json();

    const data = await (await fetch(`${mock.url}/v1/videos/${request_id}`)).json();
    expect(data.status).toBe("failed");
    expect(typeof data.code).toBe("string");
    expect(data.error).toBe("content policy violation");
    // Seed-terminal (default 0/0 progression) FAILED job: zero polls toward the
    // never-reached completion target → progress-at-failure is 0. A failed job
    // must NOT report 100 (100 is the wire signal for a completed/"done" job).
    expect(data.progress).toBe(0);
  });

  test("strict 503; non-strict 404", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    const strictRes = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "no such fixture" }),
    });
    expect(strictRes.status).toBe(503);
    const strictData = await strictRes.json();
    expect(strictData.code).toBe("no_fixture_match");
    await mock.stop();

    mock = new LLMock({ port: 0 });
    await mock.start();
    const looseRes = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "no such fixture" }),
    });
    expect(looseRes.status).toBe(404);
    const looseData = await looseRes.json();
    expect(typeof looseData.code).toBe("string");
    expect(typeof looseData.error).toBe("string");
  });

  test("unknown request_id 404s with {code,error}", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    // A Grok job map miss for an id that is NOT a Sora video falls through to
    // Sora handleVideoStatus, which 404s. The id must not be "generations".
    const res = await fetch(`${mock.url}/v1/videos/no-such-grok-id`);
    expect(res.status).toBe(404);
  });

  test("GET /v1/videos/generations is NOT parsed as status id=generations", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    // The status RE guard excludes id === "generations"; a GET here must not be
    // routed to the Grok/Sora status handler. It falls through to the global
    // 404 (no such route for GET on that literal).
    const res = await fetch(`${mock.url}/v1/videos/generations`);
    expect(res.status).toBe(404);
    await res.arrayBuffer();
  });
});

// ─── Sora /v1/videos/{id} pinned byte-for-byte by the Grok-first dispatch ─────

describe("Sora status unaffected by the Grok route", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("Sora POST /v1/videos then GET /v1/videos/{soraId} returns the Sora envelope; unknown id 404s Sora-style", async () => {
    mock = new LLMock({ port: 0 });
    // A Sora video fixture (NOT a Grok job): Sora's POST /v1/videos seeds the
    // VideoStateMap, and GET /v1/videos/{id} must serve the Sora envelope
    // byte-for-byte (id/status/created_at[/url]) — proving the Grok-first
    // dispatch falls through to the UNCHANGED handleVideoStatus on a miss.
    mock.addFixture({
      match: { userMessage: "sora clip", endpoint: "video" },
      response: { video: { id: "video_sora_1", status: "completed", url: "https://s/v.mp4" } },
    });
    await mock.start();

    const create = await fetch(`${mock.url}/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "sora-2", prompt: "sora clip" }),
    });
    expect(create.status).toBe(200);
    const created = await create.json();
    const soraId: string = created.id;
    expect(typeof soraId).toBe("string");

    const status = await fetch(`${mock.url}/v1/videos/${soraId}`);
    expect(status.status).toBe(200);
    const body = await status.json();
    // Exact Sora envelope shape — NO Grok fields (no request_id, no progress).
    expect(body.id).toBe(soraId);
    expect(body.status).toBe("completed");
    expect(typeof body.created_at).toBe("number");
    expect(body.url).toBe("https://s/v.mp4");
    expect(body.request_id).toBeUndefined();
    expect(body.progress).toBeUndefined();

    // Unknown id → Sora 404 shape (type: not_found), NOT a Grok {code,error}.
    const missing = await fetch(`${mock.url}/v1/videos/totally-unknown-id`);
    expect(missing.status).toBe(404);
    const missData = await missing.json();
    expect(missData.error.type).toBe("not_found");
  });
});

// ─── Dispatch error journaling (GET /v1/videos/{id} Grok-first) ──────────────
//
// The GET /v1/videos/{id} dispatch fronts BOTH Grok status and Sora's
// fall-through. A throw from handleGrokVideoStatus must be journaled as a 500
// and answered with the server_error envelope, mirroring the sibling video
// dispatches (POST /v1/videos, Grok submit, Veo create/status). We force the
// handler to throw mid-poll by making its replay journal.add (status:200) throw
// AFTER a real Grok job exists — the narrowest seam at the real failure surface
// (a poll that blows up before it can respond). The dispatch wrapper's own
// status:500 journal write must still land so the failed poll is visible.
describe("GET /v1/videos/{id} dispatch journals handler errors as 500 (Grok-first)", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
  });

  test("a throw from handleGrokVideoStatus returns a journaled 500", async () => {
    mock = new LLMock({ port: 0 });
    // Seed a completed Grok fixture and submit so a real replay job exists; the
    // subsequent poll is a genuine Grok hit (not a Sora fall-through).
    mock.addFixture({
      match: { userMessage: "boom clip", endpoint: "video" },
      response: { video: { id: "vid_boom", status: "completed", url: "https://x/v.mp4" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "boom clip" }),
    });
    expect(submit.status).toBe(200);
    const { request_id } = await submit.json();
    expect(typeof request_id).toBe("string");

    // Seam: the handler's replay path journals { status: 200 } BEFORE it writes
    // the response; force THAT add to throw so the throw escapes the handler
    // with headers unsent. The dispatch wrapper's own { status: 500 } add (and
    // every prior/other add) passes through untouched.
    const journal = mock.journal;
    const realAdd = journal.add.bind(journal);
    vi.spyOn(journal, "add").mockImplementation((entry) => {
      if (entry.response.status === 200) {
        throw new Error("forced handler explosion");
      }
      return realAdd(entry);
    });

    const poll = await fetch(`${mock.url}/v1/videos/${request_id}`);

    // GREEN expectation: dispatch caught the throw, returned a 500 server_error
    // envelope, and journaled the failed poll. (RED on un-wrapped code: the
    // throw is unhandled — the socket resets / no 500 body — and no status:500
    // journal entry exists.)
    expect(poll.status).toBe(500);
    const body = await poll.json();
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toBe("forced handler explosion");

    const failed = mock
      .getRequests()
      .filter((e) => e.response.status === 500 && e.path === `/v1/videos/${request_id}`);
    expect(failed.length).toBe(1);
    expect(failed[0].method).toBe("GET");
  });
});

// ─── Multi-tenant poll isolation (#278) ──────────────────────────────────────
// Submit stores the job keyed `${testId}:${requestId}`, but the returned
// request_id is opaque. A multi-tenant client polls the returned id WITHOUT an
// x-test-id header, so the testId must travel in the returned id (via
// testIdSuffix) for getTestId's `?testId=` fallback to resolve the scope —
// mirroring OpenRouter's polling_url treatment.

describe("Grok video — testId scoping of returned request_id", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("returned request_id carries testId and resolves the poll without the header", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "scoped poll", endpoint: "video" },
      response: { video: { id: "vid_scoped", status: "completed", url: "https://cdn.x.ai/s.mp4" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "test-a" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "scoped poll" }),
    });
    const { request_id } = (await submit.json()) as { request_id: string };
    // Exact query param, not just a substring: `{uuid}?testId=test-a`.
    expect(request_id).toMatch(/^[^?]+\?testId=test-a$/);

    // Bare poll of the returned id — no X-Test-Id header — must still resolve
    // via the embedded query parameter.
    const poll = await fetch(`${mock.url}/v1/videos/${request_id}`);
    expect(poll.status).toBe(200);
    const data = await poll.json();
    expect(data.status).toBe("done");
  });

  // DECISIVE multi-tenant routing (#278). Two tenants submit DISTINCT jobs
  // concurrently — both live in the map at once — then each polls ONLY its own
  // RETURNED suffix-bearing request_id, sending NO x-test-id header. The
  // header-less poll must resolve via the embedded `?testId=` suffix to that
  // tenant's own job (not the other tenant's, not a Sora 404 fall-through).
  // This FAILS on pre-fix code: a bare returned request_id carries no testId, so
  // a header-less poll falls to the default testId, the `${testId}:${requestId}`
  // key misses, and the Grok-first dispatch falls through to Sora → 404. The
  // earlier header-stripping "isolation" test was tautological (it 404s pre- AND
  // post-fix); this one is the real cross-tenant routing proof.
  test("concurrent tenants each resolve their OWN job via the header-less suffix", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "tenant A clip", endpoint: "video" },
      response: { video: { id: "vid_A", status: "completed", url: "https://cdn.x.ai/a.mp4" } },
    });
    mock.addFixture({
      match: { userMessage: "tenant B clip", endpoint: "video" },
      response: { video: { id: "vid_B", status: "completed", url: "https://cdn.x.ai/b.mp4" } },
    });
    await mock.start();

    // Both tenants submit concurrently → both jobs coexist in the map.
    const [resA, resB] = await Promise.all([
      fetch(`${mock.url}/v1/videos/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-Id": "tenant-a" },
        body: JSON.stringify({ model: "grok-imagine-video", prompt: "tenant A clip" }),
      }),
      fetch(`${mock.url}/v1/videos/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-Id": "tenant-b" },
        body: JSON.stringify({ model: "grok-imagine-video", prompt: "tenant B clip" }),
      }),
    ]);
    const { request_id: idA } = (await resA.json()) as { request_id: string };
    const { request_id: idB } = (await resB.json()) as { request_id: string };
    expect(idA).toMatch(/^[^?]+\?testId=tenant-a$/);
    expect(idB).toMatch(/^[^?]+\?testId=tenant-b$/);
    // Distinct underlying request ids (no accidental collision).
    expect(idA.split("?")[0]).not.toBe(idB.split("?")[0]);

    // Header-less poll of A's returned id → resolves A's job (a.mp4), not B's.
    const pollA = await fetch(`${mock.url}/v1/videos/${idA}`);
    expect(pollA.status).toBe(200);
    const dataA = await pollA.json();
    expect(dataA.status).toBe("done");
    expect(dataA.video.url).toBe("https://cdn.x.ai/a.mp4");

    // Header-less poll of B's returned id → resolves B's job (b.mp4), not A's.
    const pollB = await fetch(`${mock.url}/v1/videos/${idB}`);
    expect(pollB.status).toBe(200);
    const dataB = await pollB.json();
    expect(dataB.status).toBe("done");
    expect(dataB.video.url).toBe("https://cdn.x.ai/b.mp4");
  });

  test("default testId returns the bare request_id (no testId param)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "clean id", endpoint: "video" },
      response: { video: { id: "vid_clean", status: "completed", url: "https://cdn.x.ai/c.mp4" } },
    });
    await mock.start();

    const submit = await fetch(`${mock.url}/v1/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-imagine-video", prompt: "clean id" }),
    });
    const { request_id } = (await submit.json()) as { request_id: string };
    // Byte-identical to pre-fix behaviour: bare uuid, no query.
    expect(request_id).not.toContain("testId=");
    expect(request_id).not.toContain("?");
  });
});

// Type-only smoke: the stored video status union remains the 3-value set
// (no "done"); the Grok wire "done" is derived at serialization.
describe("VideoResponse stored status", () => {
  test("duration is part of the video object", () => {
    const v: VideoResponse = { video: { id: "v", status: "completed", duration: 4 } };
    expect(v.video.duration).toBe(4);
  });
});
