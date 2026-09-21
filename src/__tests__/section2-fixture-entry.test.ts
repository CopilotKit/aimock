import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";

let mock: LLMock;
let directory: string;
beforeEach(() => {
  mock = new LLMock({ port: 0 });
  directory = mkdtempSync(join(tmpdir(), "section2-fixture-entry-"));
});
afterEach(async () => {
  await mock.stop();
  rmSync(directory, { recursive: true, force: true });
});

function fixtureFile(entries: unknown[]) {
  const path = join(directory, "fixtures.json");
  writeFileSync(path, JSON.stringify({ fixtures: entries }));
  return path;
}

async function post(path: string, body: unknown) {
  const response = await fetch(mock.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function chat(prompt: string) {
  return post("/v1/chat/completions", {
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    stream: false,
  });
}

const valid = { match: { userMessage: "valid prompt" }, response: { content: "VALID_RESPONSE" } };
describe("supported controls", () => {
  test("preserves the public pre-parsed array fixture format", async () => {
    mock.addFixturesFromJSON([valid]);
    await mock.start();
    expect((await chat("valid prompt")).text).toContain("VALID_RESPONSE");
  });
  test.each(["disk", "json", "control"] as const)(
    "%s preserves scoped and explicit catch-all fixtures",
    async (surface) => {
      const entries = [valid, { match: {}, response: { content: "CATCH_ALL" } }];
      await mock.start();
      if (surface === "disk") mock.loadFixtureFile(fixtureFile(entries));
      else if (surface === "json") mock.addFixturesFromJSON(JSON.stringify(entries));
      else expect((await post("/__aimock/fixtures", { fixtures: entries })).status).toBe(200);
      const scoped = await chat("valid prompt");
      const catchAll = await chat("unrelated prompt");
      expect(scoped.status).toBe(200);
      expect(scoped.text).toContain("VALID_RESPONSE");
      expect(catchAll.status).toBe(200);
      expect(catchAll.text).toContain("CATCH_ALL");
    },
  );

  test("preserves file object response and tool arguments normalization", async () => {
    mock.loadFixtureFile(
      fixtureFile([
        { match: { userMessage: "structured" }, response: { content: { answer: 42 } } },
        {
          match: { userMessage: "tool" },
          response: { toolCalls: [{ name: "lookup", arguments: { id: 42 } }] },
        },
      ]),
    );
    expect(mock.getFixtures()[0].response).toEqual({ content: '{"answer":42}' });
    expect(mock.getFixtures()[1].response).toEqual({
      toolCalls: [{ name: "lookup", arguments: '{"id":42}' }],
    });
    await mock.start();
    expect((await chat("structured")).text).toContain("answer");
    expect((await chat("tool")).text).toContain("lookup");
  });

  test("preserves public programmatic RegExp and predicate fixtures", async () => {
    mock.addFixture({
      match: { userMessage: /^regex$/ },
      response: { content: "REGEXP_RESPONSE" },
    });
    mock.addFixture({
      match: { predicate: (request) => request.model === "gpt-4o" },
      response: { content: "PREDICATE_RESPONSE" },
    });
    await mock.start();
    expect((await chat("regex")).text).toContain("REGEXP_RESPONSE");
    expect((await chat("predicate")).text).toContain("PREDICATE_RESPONSE");
  });
});
