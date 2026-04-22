import { describe, it, expect, afterEach } from "vitest";
import { Journal, DEFAULT_TEST_ID } from "../journal.js";
import type { Fixture } from "../types.js";
import { LLMock } from "../llmock.js";

describe("Journal per-testId match counting", () => {
  it("returns independent counts for different testIds", () => {
    const journal = new Journal();
    const f: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "Hi" },
    };

    journal.incrementFixtureMatchCount(f, [f], "test-A");
    journal.incrementFixtureMatchCount(f, [f], "test-A");

    // Reads are non-mutating: fetch the maps AFTER writes so we observe
    // the live backing maps for known testIds. Unknown testIds return
    // a transient empty map (does not insert into the cache).
    const mapA = journal.getFixtureMatchCountsForTest("test-A");
    const mapB = journal.getFixtureMatchCountsForTest("test-B");

    expect(mapA.get(f)).toBe(2);
    expect(mapB.get(f)).toBeUndefined();
  });

  it("defaults to __default__ testId", () => {
    const journal = new Journal();
    const f: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "Hi" },
    };

    journal.incrementFixtureMatchCount(f, [f]);
    const defaultMap = journal.getFixtureMatchCountsForTest(DEFAULT_TEST_ID);

    expect(defaultMap.get(f)).toBe(1);
  });

  it("clearMatchCounts with testId clears only that testId", () => {
    const journal = new Journal();
    const f: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "Hi" },
    };

    journal.incrementFixtureMatchCount(f, [f], "A");
    journal.incrementFixtureMatchCount(f, [f], "B");

    journal.clearMatchCounts("A");

    expect(journal.getFixtureMatchCountsForTest("A").get(f)).toBeUndefined();
    expect(journal.getFixtureMatchCountsForTest("B").get(f)).toBe(1);
  });

  it("clearMatchCounts without testId clears all", () => {
    const journal = new Journal();
    const f: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "Hi" },
    };

    journal.incrementFixtureMatchCount(f, [f], "A");
    journal.incrementFixtureMatchCount(f, [f], "B");

    journal.clearMatchCounts();

    expect(journal.getFixtureMatchCountsForTest("A").get(f)).toBeUndefined();
    expect(journal.getFixtureMatchCountsForTest("B").get(f)).toBeUndefined();
  });
});

describe("X-Test-Id integration", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("parallel test IDs have independent sequence counters", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { toolCalls: [{ name: "greet", arguments: "{}" }] },
    });
    mock.addFixture({
      match: { userMessage: "hello", sequenceIndex: 1 },
      response: { content: "Done greeting." },
    });
    await mock.start();

    const makeRequest = (testId: string) =>
      fetch(`${mock!.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test",
          "X-Test-Id": testId,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      });

    const [r1a, r1b] = await Promise.all([makeRequest("test-A"), makeRequest("test-B")]);
    const d1a = await r1a.json();
    const d1b = await r1b.json();
    expect(d1a.choices[0].message.tool_calls).toBeDefined();
    expect(d1b.choices[0].message.tool_calls).toBeDefined();

    const [r2a, r2b] = await Promise.all([makeRequest("test-A"), makeRequest("test-B")]);
    const d2a = await r2a.json();
    const d2b = await r2b.json();
    expect(d2a.choices[0].message.content).toContain("Done");
    expect(d2b.choices[0].message.content).toContain("Done");
  });

  it("no X-Test-Id header uses global counter (backwards compatible)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "hi", sequenceIndex: 0 },
      response: { content: "first" },
    });
    mock.addFixture({
      match: { userMessage: "hi", sequenceIndex: 1 },
      response: { content: "second" },
    });
    await mock.start();

    const r1 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect((await r1.json()).choices[0].message.content).toBe("first");

    const r2 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect((await r2.json()).choices[0].message.content).toBe("second");
  });

  it("testId query param works as fallback", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "q", sequenceIndex: 0 },
      response: { content: "zero" },
    });
    mock.addFixture({
      match: { userMessage: "q", sequenceIndex: 1 },
      response: { content: "one" },
    });
    await mock.start();

    const r1 = await fetch(`${mock.url}/v1/chat/completions?testId=qtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "q" }],
        stream: false,
      }),
    });
    expect((await r1.json()).choices[0].message.content).toBe("zero");

    const r2 = await fetch(`${mock.url}/v1/chat/completions?testId=qtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "q" }],
        stream: false,
      }),
    });
    expect((await r2.json()).choices[0].message.content).toBe("one");
  });

  it("X-Test-Id works for Anthropic endpoint", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "a", sequenceIndex: 0 },
      response: { content: "anthropic-first" },
    });
    mock.addFixture({
      match: { userMessage: "a", sequenceIndex: 1 },
      response: { content: "anthropic-second" },
    });
    await mock.start();

    const req = (testId: string) =>
      fetch(`${mock!.url}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test",
          "anthropic-version": "2023-06-01",
          "X-Test-Id": testId,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          messages: [{ role: "user", content: "a" }],
        }),
      }).then((r) => r.json());

    const [da, db] = await Promise.all([req("ant-A"), req("ant-B")]);
    expect(da.content[0].text).toBe("anthropic-first");
    expect(db.content[0].text).toBe("anthropic-first");
  });
});

describe("resetMatchCounts with testId", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it("resetMatchCounts(testId) only clears specified test", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "x", sequenceIndex: 0 },
      response: { content: "first" },
    });
    mock.addFixture({
      match: { userMessage: "x", sequenceIndex: 1 },
      response: { content: "second" },
    });
    await mock.start();

    const req = (testId: string) =>
      fetch(`${mock!.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer t",
          "X-Test-Id": testId,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "x" }],
          stream: false,
        }),
      }).then((r) => r.json());

    await req("A");
    await req("B");

    mock.resetMatchCounts("A");

    const ra = await req("A");
    expect(ra.choices[0].message.content).toBe("first");

    const rb = await req("B");
    expect(rb.choices[0].message.content).toBe("second");
  });

  it("header takes precedence over query param when both are present", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "hi", sequenceIndex: 0 },
      response: { content: "first" },
    });
    mock.addFixture({
      match: { userMessage: "hi", sequenceIndex: 1 },
      response: { content: "second" },
    });
    await mock.start();

    const url = mock.url!;

    // Advance "header-id" to sequenceIndex 1
    await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "header-id" },
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
    });

    // Send with BOTH header and query param — header should win
    const res = await fetch(`${url}/v1/chat/completions?testId=query-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "header-id" },
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
    }).then((r) => r.json());

    // Should be "second" (header-id at sequenceIndex 1), not "first" (query-id at 0)
    expect(res.choices[0].message.content).toBe("second");
  });

  it("resetMatchCounts without testId clears all counters", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "hi", sequenceIndex: 0 },
      response: { content: "first" },
    });
    mock.addFixture({
      match: { userMessage: "hi", sequenceIndex: 1 },
      response: { content: "second" },
    });
    await mock.start();

    const url = mock.url!;
    const req = (testId: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-Id": testId },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
      }).then((r) => r.json());

    // Advance both A and B
    await req("A");
    await req("B");

    // Reset ALL
    mock.resetMatchCounts();

    // Both should restart at sequenceIndex 0
    const ra = await req("A");
    const rb = await req("B");
    expect(ra.choices[0].message.content).toBe("first");
    expect(rb.choices[0].message.content).toBe("first");
  });
});
