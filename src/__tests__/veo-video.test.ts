import { describe, test, expect, afterEach, vi } from "vitest";
import { LLMock } from "../llmock.js";

// ─── Google Veo replay lifecycle ─────────────────────────────────────────────
// POST /v1beta/models/{model}:predictLongRunning → { name: "operations/..." }
// GET  /v1beta/operations/{name} → { name, done:false } ... { name, done:true,
//   response: { generateVideoResponse: { generatedSamples: [{ video: { uri }}]}}}
// The Files-API uri is served AS-IS — aimock never downloads bytes.

const VEO_MODEL = "veo-3.1-generate-preview";

function submitUrl(base: string, model = VEO_MODEL): string {
  return `${base}/v1beta/models/${model}:predictLongRunning`;
}

describe("POST /v1beta/models/{model}:predictLongRunning (Veo submit)", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("fixture match returns an operations envelope", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a sunset over the ocean", endpoint: "video" },
      response: {
        video: { id: "veo_1", status: "completed", url: "https://files.example/v.mp4" },
      },
    });
    await mock.start();

    const res = await fetch(submitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ instances: [{ prompt: "a sunset over the ocean" }] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.name).toBe("string");
    expect(data.name.startsWith("operations/")).toBe(true);
  });

  test("malformed JSON submit 400s with a Gemini error envelope", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(submitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(400);
    expect(typeof data.error.message).toBe("string");
    expect(data.error.status).toBe("INVALID_ARGUMENT");
  });

  test("missing prompt 400s", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const res = await fetch(submitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{}] }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toMatch(/prompt/);
  });

  test("strict no-match submit 503s; non-strict no-match 404s", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();
    const strictRes = await fetch(submitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: "no fixture here" }] }),
    });
    expect(strictRes.status).toBe(503);
    expect((await strictRes.json()).error.status).toBe("UNAVAILABLE");
    await mock.stop();

    mock = new LLMock({ port: 0 });
    await mock.start();
    const looseRes = await fetch(submitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: "no fixture here" }] }),
    });
    expect(looseRes.status).toBe(404);
    expect((await looseRes.json()).error.status).toBe("NOT_FOUND");
  });
});

describe("GET /v1beta/operations/{name} (Veo status)", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  async function submit(m: LLMock, prompt: string): Promise<string> {
    const res = await fetch(submitUrl(m.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt }] }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).name as string;
  }

  test("poll with 0/0 progression returns done:true with the Files-API uri served as-is", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "served as-is", endpoint: "video" },
      response: {
        video: { id: "veo_uri", status: "completed", url: "https://files.example/asis.mp4" },
      },
    });
    await mock.start();
    const name = await submit(mock, "served as-is");

    const res = await fetch(`${mock.url}/v1beta/${name}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe(name);
    expect(data.done).toBe(true);
    expect(data.response.generateVideoResponse.generatedSamples[0].video.uri).toBe(
      "https://files.example/asis.mp4",
    );
  });

  test("progression: done:false then done:true", async () => {
    mock = new LLMock({ port: 0, veoVideo: { pollsBeforeInProgress: 1, pollsBeforeCompleted: 2 } });
    mock.addFixture({
      match: { userMessage: "slow render", endpoint: "video" },
      response: {
        video: { id: "veo_slow", status: "completed", url: "https://files.example/slow.mp4" },
      },
    });
    await mock.start();
    const name = await submit(mock, "slow render");

    const poll1 = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(poll1.done).toBe(false);
    const poll2 = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(poll2.done).toBe(true);
    expect(poll2.response.generateVideoResponse.generatedSamples[0].video.uri).toBe(
      "https://files.example/slow.mp4",
    );
  });

  test("unknown operation 404s with a Gemini error envelope", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const res = await fetch(`${mock.url}/v1beta/operations/does-not-exist`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe(404);
    expect(data.error.status).toBe("NOT_FOUND");
  });

  test("failed fixture polls to done:true with a Gemini error body", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "policy violation", endpoint: "video" },
      response: { video: { id: "veo_fail", status: "failed", error: "blocked by policy" } },
    });
    await mock.start();
    const name = await submit(mock, "policy violation");

    const data = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(data.done).toBe(true);
    expect(data.error.message).toBe("blocked by policy");
  });

  test("completed fixture without a url serves the documented placeholder uri", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "no url", endpoint: "video" },
      response: { video: { id: "veo_nourl", status: "completed" } },
    });
    await mock.start();
    const name = await submit(mock, "no url");
    const data = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(data.done).toBe(true);
    expect(data.response.generateVideoResponse.generatedSamples[0].video.uri).toMatch(
      /generativelanguage\.googleapis\.com\/v1beta\/files\//,
    );
  });

  test("completed fixture with an empty url serves the documented placeholder uri", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "empty url", endpoint: "video" },
      response: { video: { id: "veo_emptyurl", status: "completed", url: "" } },
    });
    await mock.start();
    const name = await submit(mock, "empty url");
    const data = await (await fetch(`${mock.url}/v1beta/${name}`)).json();
    expect(data.done).toBe(true);
    const uri = data.response.generateVideoResponse.generatedSamples[0].video.uri;
    expect(uri).not.toBe("");
    expect(uri).toMatch(/generativelanguage\.googleapis\.com\/v1beta\/files\//);
  });
});

// ─── Dispatch error journaling (GET /v1beta/operations/{name} Veo status) ─────
//
// A throw from handleVeoVideoStatus must be journaled as a 500 and answered with
// the server_error envelope, mirroring the sibling video dispatches (Grok status,
// Veo create). We force the handler to throw mid-poll by making its replay
// journal.add (status:200) throw AFTER a real Veo job exists — the narrowest seam
// at the real failure surface (a poll that blows up before it can respond). The
// dispatch wrapper's own status:500 journal write must still land so the failed
// poll is visible in /__aimock/journal.
describe("GET /v1beta/operations/{name} dispatch journals handler errors as 500 (Veo)", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.stop();
    mock = undefined;
  });

  test("a throw from handleVeoVideoStatus returns a journaled 500", async () => {
    mock = new LLMock({ port: 0 });
    // Seed a completed Veo fixture and submit so a real replay job exists; the
    // subsequent poll is a genuine Veo hit (not an unknown-operation 404).
    mock.addFixture({
      match: { userMessage: "boom render", endpoint: "video" },
      response: {
        video: { id: "veo_boom", status: "completed", url: "https://files.example/boom.mp4" },
      },
    });
    await mock.start();

    const submit = await fetch(submitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: "boom render" }] }),
    });
    expect(submit.status).toBe(200);
    const { name } = await submit.json();
    expect(typeof name).toBe("string");

    // Seam: the handler's replay path journals { status: 200 } BEFORE it writes
    // the response; force THAT add to throw so the throw escapes the handler with
    // headers unsent. The dispatch wrapper's own { status: 500 } add (and every
    // prior/other add) passes through untouched.
    const journal = mock.journal;
    const realAdd = journal.add.bind(journal);
    vi.spyOn(journal, "add").mockImplementation((entry) => {
      if (entry.response.status === 200) {
        throw new Error("forced handler explosion");
      }
      return realAdd(entry);
    });

    const poll = await fetch(`${mock.url}/v1beta/${name}`);

    // GREEN expectation: dispatch caught the throw, returned a 500 server_error
    // envelope, and journaled the failed poll. (RED on un-wrapped code: the throw
    // is caught but NO status:500 journal entry is written → count 0.)
    expect(poll.status).toBe(500);
    const body = await poll.json();
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toBe("forced handler explosion");

    const failed = mock
      .getRequests()
      .filter((e) => e.response.status === 500 && e.path === `/v1beta/${name}`);
    expect(failed.length).toBe(1);
    expect(failed[0].method).toBe("GET");
  });
});

// ─── Multi-tenant poll isolation (#278) ──────────────────────────────────────
// Submit stores the job keyed `${testId}:${operationName}`, but the returned
// operation name is opaque. A multi-tenant client polls the returned name
// WITHOUT an x-test-id header, so the testId must travel in the returned name
// (via testIdSuffix) for getTestId's `?testId=` fallback to resolve the scope —
// mirroring OpenRouter's polling_url treatment.

describe("Veo video — testId scoping of returned operation name", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("returned name carries testId and resolves the poll without the header", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "scoped poll", endpoint: "video" },
      response: {
        video: { id: "veo_scoped", status: "completed", url: "https://files.example/s.mp4" },
      },
    });
    await mock.start();

    const submit = await fetch(submitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "test-a" },
      body: JSON.stringify({ instances: [{ prompt: "scoped poll" }] }),
    });
    const { name } = (await submit.json()) as { name: string };
    // Exact query param, not just a substring: `operations/{uuid}?testId=test-a`.
    expect(name).toMatch(/^operations\/[^?]+\?testId=test-a$/);

    // Bare poll of the returned name — no X-Test-Id header — must still resolve
    // via the embedded query parameter.
    const poll = await fetch(`${mock.url}/v1beta/${name}`);
    expect(poll.status).toBe(200);
    const data = await poll.json();
    expect(data.done).toBe(true);
  });

  // DECISIVE multi-tenant routing (#278). Two tenants submit DISTINCT jobs
  // concurrently — both live in the map at once — then each polls ONLY its own
  // RETURNED suffix-bearing id, sending NO x-test-id header. The header-less
  // poll must resolve via the embedded `?testId=` suffix to that tenant's own
  // job (not the other tenant's, not 404). This FAILS on pre-fix code: a bare
  // returned name carries no testId, so a header-less poll falls to the default
  // testId and the `${testId}:${operationName}` key misses → 404. The earlier
  // header-stripping "isolation" test was tautological (it 404s pre- AND
  // post-fix); this one is the real cross-tenant routing proof.
  test("concurrent tenants each resolve their OWN job via the header-less suffix", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "tenant A clip", endpoint: "video" },
      response: {
        video: { id: "veo_A", status: "completed", url: "https://files.example/a.mp4" },
      },
    });
    mock.addFixture({
      match: { userMessage: "tenant B clip", endpoint: "video" },
      response: {
        video: { id: "veo_B", status: "completed", url: "https://files.example/b.mp4" },
      },
    });
    await mock.start();

    // Both tenants submit concurrently → both jobs coexist in the map.
    const [resA, resB] = await Promise.all([
      fetch(submitUrl(mock.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-Id": "tenant-a" },
        body: JSON.stringify({ instances: [{ prompt: "tenant A clip" }] }),
      }),
      fetch(submitUrl(mock.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-Id": "tenant-b" },
        body: JSON.stringify({ instances: [{ prompt: "tenant B clip" }] }),
      }),
    ]);
    const { name: nameA } = (await resA.json()) as { name: string };
    const { name: nameB } = (await resB.json()) as { name: string };
    expect(nameA).toMatch(/^operations\/[^?]+\?testId=tenant-a$/);
    expect(nameB).toMatch(/^operations\/[^?]+\?testId=tenant-b$/);
    // Distinct underlying operation names (no accidental collision).
    expect(nameA.split("?")[0]).not.toBe(nameB.split("?")[0]);

    // Header-less poll of A's returned name → resolves A's job (a.mp4), not B's.
    const pollA = await fetch(`${mock.url}/v1beta/${nameA}`);
    expect(pollA.status).toBe(200);
    const dataA = await pollA.json();
    expect(dataA.done).toBe(true);
    expect(dataA.response.generateVideoResponse.generatedSamples[0].video.uri).toBe(
      "https://files.example/a.mp4",
    );

    // Header-less poll of B's returned name → resolves B's job (b.mp4), not A's.
    const pollB = await fetch(`${mock.url}/v1beta/${nameB}`);
    expect(pollB.status).toBe(200);
    const dataB = await pollB.json();
    expect(dataB.done).toBe(true);
    expect(dataB.response.generateVideoResponse.generatedSamples[0].video.uri).toBe(
      "https://files.example/b.mp4",
    );
  });

  test("default testId returns the bare operation name (no testId param)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "clean name", endpoint: "video" },
      response: {
        video: { id: "veo_clean", status: "completed", url: "https://files.example/c.mp4" },
      },
    });
    await mock.start();

    const submit = await fetch(submitUrl(mock.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: "clean name" }] }),
    });
    const { name } = (await submit.json()) as { name: string };
    // Byte-identical to pre-fix behaviour: bare `operations/{uuid}`, no query.
    expect(name).not.toContain("testId=");
    expect(name).not.toContain("?");
    expect(name.startsWith("operations/")).toBe(true);
  });
});
