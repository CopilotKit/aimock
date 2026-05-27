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

describe("image variations endpoint", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("multipart image variations request returns fixture", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { endpoint: "image" },
      response: { image: { url: "https://example.com/variation.png" } },
    });
    await mock.start();

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

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data[0].url).toBe("https://example.com/variation.png");
    expect(typeof data.created).toBe("number");
  });

  test("image variations does not require prompt", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { endpoint: "image" },
      response: { image: { url: "https://example.com/var.png" } },
    });
    await mock.start();

    // No prompt field — should still work
    const formData = new FormData();
    formData.append("image", new Blob(["fake"]), "image.png");

    const res = await fetch(`${mock.url}/v1/images/variations`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data[0].url).toBe("https://example.com/var.png");
  });

  test("image variations response shape matches generations format", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { endpoint: "image" },
      response: {
        images: [{ url: "https://example.com/v1.png" }, { b64Json: "iVBORw0KGgo=" }],
      },
    });
    await mock.start();

    const formData = new FormData();
    formData.append("image", new Blob(["fake"]), "image.png");

    const res = await fetch(`${mock.url}/v1/images/variations`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: formData,
    });

    const data = await res.json();
    expect(data).toHaveProperty("created");
    expect(data).toHaveProperty("data");
    expect(data.data).toHaveLength(2);
    expect(data.data[0].url).toBe("https://example.com/v1.png");
    expect(data.data[1].b64_json).toBe("iVBORw0KGgo=");
  });
});
