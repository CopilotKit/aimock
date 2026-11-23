import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

describe("image edit endpoint", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("multipart image edit request returns fixture", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "add sunglasses", endpoint: "image" },
      response: {
        image: { url: "https://example.com/edited.png", revisedPrompt: "added sunglasses" },
      },
    });
    await mock.start();

    const formData = new FormData();
    formData.append("image", new Blob(["fake image data"], { type: "image/png" }), "image.png");
    formData.append("prompt", "add sunglasses");
    formData.append("model", "dall-e-2");
    formData.append("n", "1");
    formData.append("size", "1024x1024");

    const res = await fetch(`${mock.url}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data[0].url).toBe("https://example.com/edited.png");
    expect(data.data[0].revised_prompt).toBe("added sunglasses");
    expect(typeof data.created).toBe("number");
  });

  test("image edit returns 400 when prompt is missing", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const formData = new FormData();
    formData.append("image", new Blob(["fake"]), "image.png");
    formData.append("model", "dall-e-2");

    const res = await fetch(`${mock.url}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("prompt");
  });

  test("image edit with mask field (binary ignored)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "remove background", endpoint: "image" },
      response: { image: { url: "https://example.com/masked.png" } },
    });
    await mock.start();

    const formData = new FormData();
    formData.append("image", new Blob(["fake image"]), "image.png");
    formData.append("mask", new Blob(["fake mask"]), "mask.png");
    formData.append("prompt", "remove background");
    formData.append("model", "dall-e-2");

    const res = await fetch(`${mock.url}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data[0].url).toBe("https://example.com/masked.png");
  });

  test("image edit fixture matching works with model default", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { endpoint: "image" },
      response: { image: { b64Json: "iVBORw0KGgo=" } },
    });
    await mock.start();

    const formData = new FormData();
    formData.append("image", new Blob(["fake"]), "image.png");
    formData.append("prompt", "enhance");

    const res = await fetch(`${mock.url}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data[0].b64_json).toBe("iVBORw0KGgo=");
  });

  test("image edit response shape matches generations format", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "test prompt", endpoint: "image" },
      response: {
        images: [
          { url: "https://example.com/1.png" },
          { url: "https://example.com/2.png", revisedPrompt: "revised" },
        ],
      },
    });
    await mock.start();

    // Test edit endpoint
    const formData = new FormData();
    formData.append("image", new Blob(["fake"]), "image.png");
    formData.append("prompt", "test prompt");

    const editRes = await fetch(`${mock.url}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });
    const editData = await editRes.json();

    expect(editData).toHaveProperty("created");
    expect(editData).toHaveProperty("data");
    expect(editData.data).toHaveLength(2);
    expect(editData.data[0].url).toBe("https://example.com/1.png");
    expect(editData.data[1].revised_prompt).toBe("revised");
  });

  test("image edit returns 404 when no fixture matches", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const formData = new FormData();
    formData.append("image", new Blob(["fake"]), "image.png");
    formData.append("prompt", "no match");

    const res = await fetch(`${mock.url}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("no_fixture_match");
  });

  test("route path matches OpenAI: /v1/images/edits responds, /v1/images/edit is 404 (#221)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "path check", endpoint: "image" },
      response: { image: { url: "https://example.com/ok.png" } },
    });
    await mock.start();

    const makeForm = () => {
      const fd = new FormData();
      fd.append("image", new Blob(["fake"]), "image.png");
      fd.append("prompt", "path check");
      return fd;
    };

    // Correct OpenAI path (plural) must succeed
    const okRes = await fetch(`${mock.url}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: makeForm(),
    });
    expect(okRes.status).toBe(200);

    // Legacy singular path must NOT be registered
    const badRes = await fetch(`${mock.url}/v1/images/edit`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: makeForm(),
    });
    expect(badRes.status).toBe(404);
    const badData = await badRes.json();
    expect(badData.error?.type).toBe("not_found");
  });
});

describe("image variations endpoint — REMOVED upstream", () => {
  // `/v1/images/variations` only ever served `dall-e-2`, which OpenAI removed on
  // 2026-05-12; the endpoint went with it. Observed against api.openai.com on
  // 2026-09-15, keyless AND with a live key: HTTP 404, zero-byte body, no
  // `content-type`, no `openai-version`/`x-request-id` — identical to a made-up
  // path, and the 404 lands BEFORE auth (a keyless /v1/images/generations 401s).
  // Per the deprecation policy aimock mocks the removal, not a success.
  // These tests were CONVERTED from ones that graded a 200 image envelope.
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  /** The fixture that USED to make this endpoint answer 200. */
  const startWithMatchingImageFixture = async (): Promise<LLMock> => {
    const m = new LLMock({ port: 0 });
    m.addFixture({
      match: { endpoint: "image" },
      response: { image: { url: "https://example.com/variation.png" } },
    });
    await m.start();
    return m;
  };

  test("multipart variations request returns the removed-endpoint 404, not a fixture", async () => {
    mock = await startWithMatchingImageFixture();

    const formData = new FormData();
    formData.append("image", new Blob(["fake image data"], { type: "image/png" }), "image.png");
    formData.append("model", "dall-e-2");
    formData.append("n", "1");
    formData.append("size", "1024x1024");

    const res = await fetch(`${mock.url}/v1/images/variations`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });

    expect(res.status).toBe(404);
    // The real API sends a zero-byte body with NO content-type — not a JSON
    // error envelope. A mock that answered `{"error":{...}}` would be inventing
    // a shape the upstream does not send.
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe("");
  });

  test("a matching fixture cannot resurrect the endpoint, with or without a model", async () => {
    mock = await startWithMatchingImageFixture();

    // No `model`, no `prompt` — the shape that used to be accepted. Upstream
    // never reaches model validation, so neither does aimock.
    const formData = new FormData();
    formData.append("image", new Blob(["fake"]), "image.png");

    const res = await fetch(`${mock.url}/v1/images/variations`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  test("the removal is journaled, so a caller can see the call was made", async () => {
    mock = await startWithMatchingImageFixture();

    const formData = new FormData();
    formData.append("image", new Blob(["fake"]), "image.png");
    await fetch(`${mock.url}/v1/images/variations`, { method: "POST", body: formData });

    const entries = mock.journal.getAll().filter((e) => e.path.includes("/v1/images/variations"));
    expect(entries).toHaveLength(1);
    expect(entries[0].response.status).toBe(404);
    expect(entries[0].response.fixture).toBeNull();
  });

  // GUARD: the sibling image endpoints are ALIVE upstream (verified in the same
  // 2026-09-15 session — both reach the OpenAI app and answer with
  // `openai-version`/`x-request-id` headers). The sunset must not leak onto them.
  test("GUARD: /v1/images/generations and /v1/images/edits still serve fixtures", async () => {
    mock = await startWithMatchingImageFixture();

    const gen = await fetch(`${mock.url}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt: "a cat" }),
    });
    expect(gen.status).toBe(200);
    expect((await gen.json()).data[0].url).toBe("https://example.com/variation.png");

    const editForm = new FormData();
    editForm.append("image", new Blob(["fake"]), "image.png");
    editForm.append("prompt", "a cat");
    const edit = await fetch(`${mock.url}/v1/images/edits`, { method: "POST", body: editForm });
    expect(edit.status).toBe(200);
    expect((await edit.json()).data[0].url).toBe("https://example.com/variation.png");
  });
});
