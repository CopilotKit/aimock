import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

/**
 * Moderation, rerank, and search never honored strict mode: with no fixture
 * match they always answered the lenient default (unflagged / empty
 * results), even under `X-AIMock-Strict: true` or a strict server. They now
 * return the standard 503 no-fixture-match, like every other handler.
 */

let mock: LLMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
});

interface ErrorEnvelope {
  error?: { message?: unknown; code?: unknown };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; message: unknown; code: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ErrorEnvelope;
  return { status: res.status, json, message: json?.error?.message, code: json?.error?.code };
}

/** The journal entry for the last request to `path`. */
function lastEntry(path: string) {
  const entries = mock!.journal.getAll().filter((e) => e.path === path);
  return entries[entries.length - 1];
}

const STRICT = { "X-AIMock-Strict": "true" };
const NOT_STRICT = { "X-AIMock-Strict": "false" };

describe("POST /v1/moderations strict mode", () => {
  test("miss without strict still returns unflagged 200", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const res = await fetch(`${mock.url}/v1/moderations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello world" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: { flagged: boolean }[] };
    expect(json.results[0].flagged).toBe(false);
  });

  test("miss with X-AIMock-Strict returns 503", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const { status, message, code } = await postJson(
      `${mock.url}/v1/moderations`,
      { input: "hello world" },
      STRICT,
    );
    expect(status).toBe(503);
    expect(message).toBe("Strict mode: no fixture matched");
    expect(code).toBe("no_fixture_match");
    expect(lastEntry("/v1/moderations").response.strictOverride).toBe(true);
  });

  test("miss on a strict server returns 503", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();
    const { status } = await postJson(`${mock.url}/v1/moderations`, { input: "hello" });
    expect(status).toBe(503);
  });

  test("header opt-out on a strict server restores the lenient 200", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();
    const res = await fetch(`${mock.url}/v1/moderations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...NOT_STRICT },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(lastEntry("/v1/moderations").response.strictOverride).toBe(false);
  });

  test("hit under strict still returns the fixture 200", async () => {
    mock = new LLMock({ port: 0, strict: true });
    mock.onModerate("kill", {
      flagged: true,
      categories: { violence: true },
    });
    await mock.start();
    const res = await fetch(`${mock.url}/v1/moderations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "kill them all" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: { flagged: boolean }[] };
    expect(json.results[0].flagged).toBe(true);
  });
});

describe("POST /search strict mode", () => {
  test("miss without strict still returns empty 200", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const res = await fetch(`${mock.url}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "something unregistered" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: unknown[] };
    expect(json.results).toEqual([]);
  });

  test("miss with X-AIMock-Strict returns 503", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const { status, message, code } = await postJson(
      `${mock.url}/search`,
      { query: "something unregistered" },
      STRICT,
    );
    expect(status).toBe(503);
    expect(message).toBe("Strict mode: no fixture matched");
    expect(code).toBe("no_fixture_match");
    expect(lastEntry("/search").response.strictOverride).toBe(true);
  });

  test("miss on a strict server returns 503", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();
    const { status } = await postJson(`${mock.url}/search`, { query: "nope" });
    expect(status).toBe(503);
  });

  test("header opt-out on a strict server restores the lenient 200", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();
    const { status } = await postJson(`${mock.url}/search`, { query: "nope" }, NOT_STRICT);
    expect(status).toBe(200);
    expect(lastEntry("/search").response.strictOverride).toBe(false);
  });

  test("hit under strict still returns the fixture 200", async () => {
    mock = new LLMock({ port: 0, strict: true });
    mock.onSearch("aimock", [{ title: "t", url: "https://x.test", content: "c" }]);
    await mock.start();
    const res = await fetch(`${mock.url}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is aimock" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: { title: string }[] };
    expect(json.results).toHaveLength(1);
    expect(json.results[0].title).toBe("t");
  });
});

describe("POST /v2/rerank strict mode", () => {
  test("miss without strict still returns empty 200", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const res = await fetch(`${mock.url}/v2/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "something unregistered" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: unknown[] };
    expect(json.results).toEqual([]);
  });

  test("miss with X-AIMock-Strict returns 503", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const { status, message, code } = await postJson(
      `${mock.url}/v2/rerank`,
      { query: "something unregistered" },
      STRICT,
    );
    expect(status).toBe(503);
    expect(message).toBe("Strict mode: no fixture matched");
    expect(code).toBe("no_fixture_match");
    expect(lastEntry("/v2/rerank").response.strictOverride).toBe(true);
  });

  test("miss on a strict server returns 503", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();
    const { status } = await postJson(`${mock.url}/v2/rerank`, { query: "nope" });
    expect(status).toBe(503);
  });

  test("header opt-out on a strict server restores the lenient 200", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();
    const { status } = await postJson(`${mock.url}/v2/rerank`, { query: "nope" }, NOT_STRICT);
    expect(status).toBe(200);
    expect(lastEntry("/v2/rerank").response.strictOverride).toBe(false);
  });

  test("hit under strict still returns the fixture 200", async () => {
    mock = new LLMock({ port: 0, strict: true });
    mock.onRerank("aimock", [{ index: 0, relevance_score: 0.99 }]);
    await mock.start();
    const res = await fetch(`${mock.url}/v2/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "what is aimock" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: { relevance_score: number }[] };
    expect(json.results).toHaveLength(1);
    expect(json.results[0].relevance_score).toBe(0.99);
  });
});
