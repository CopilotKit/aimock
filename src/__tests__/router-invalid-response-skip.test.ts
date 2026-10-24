import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { matchFixture } from "../router.js";
import type { ChatCompletionRequest, Fixture } from "../types.js";

// A fixture added in code can carry a response that is not an object (null, a
// string). Fixture-file loading validates it, but addFixture() does not. When
// such a fixture does not match the request, the router must skip it and serve
// the next fixture, as it always has. Evaluating `"key" in response` on it
// throws a TypeError and fails every request that reaches it.

function req(text: string): ChatCompletionRequest {
  return { model: "m", messages: [{ role: "user", content: text }], _endpointType: "chat" };
}

/** A fixture whose response is not an object, built from JSON (no casts on the value). */
function invalidFixture(responseJson: string): Fixture {
  return JSON.parse(`{"match":{"userMessage":"other"},"response":${responseJson}}`) as Fixture;
}

const valid: Fixture = { match: { userMessage: "q" }, response: { content: "typed" } };

describe("router skips a non-matching fixture whose response is not an object", () => {
  for (const json of ["null", '"a string"', "42"]) {
    it(`response ${json}`, () => {
      expect(matchFixture([invalidFixture(json), valid], req("q"))).toBe(valid);
    });
  }
});

describe("LLMock over HTTP serves the next fixture after a null-response fixture", () => {
  let mock: LLMock | undefined;
  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  const wires = [
    {
      path: "/v1/chat/completions",
      body: { model: "gpt-4.1", messages: [{ role: "user", content: "q" }] },
    },
    {
      path: "/v1/messages",
      body: {
        model: "claude-sonnet-4-20250514",
        max_tokens: 64,
        messages: [{ role: "user", content: "q" }],
      },
    },
  ] as const;

  for (const wire of wires) {
    it(wire.path, async () => {
      mock = new LLMock({ port: 0, logLevel: "silent" });
      mock.addFixture(invalidFixture("null"));
      mock.addFixture(valid);
      await mock.start();
      const res = await fetch(`${mock.url}${wire.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wire.body),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("typed");
    });
  }
});
