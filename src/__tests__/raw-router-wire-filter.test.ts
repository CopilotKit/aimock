import { describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { matchFixture, matchFixtureDiagnostic } from "../router.js";
import type { ChatCompletionRequest, Fixture, FixtureResponse } from "../types.js";

// The router's raw wire filter (#549 T3): a raw fixture is offered only to the
// handler whose MatchOptions.wire equals raw.wire.

function req(text: string): ChatCompletionRequest {
  return { model: "m", messages: [{ role: "user", content: text }], _endpointType: "chat" };
}

const rawFixture: Fixture = {
  match: { userMessage: "q" },
  response: { raw: { wire: "openai-responses", events: [{ type: "x" }] } },
};
const typedFallback: Fixture = { match: { userMessage: "q" }, response: { content: "typed" } };

describe("raw wire filter", () => {
  it("offers a raw fixture to the matching wire", () => {
    const result = matchFixtureDiagnostic(
      [rawFixture, typedFallback],
      req("q"),
      undefined,
      undefined,
      {
        wire: "openai-responses",
      },
    );
    expect(result.fixture).toBe(rawFixture);
  });

  it("skips a raw fixture for another wire, so the typed fallback wins", () => {
    const result = matchFixtureDiagnostic(
      [rawFixture, typedFallback],
      req("q"),
      undefined,
      undefined,
      {
        wire: "openai-chat",
      },
    );
    expect(result.fixture).toBe(typedFallback);
  });

  it("a raw fixture skipped for its wire is a plain miss, not a sequence/turn near-miss", () => {
    const result = matchFixtureDiagnostic([rawFixture], req("q"), undefined, undefined, {
      wire: "openai-chat",
    });
    expect(result.fixture).toBeNull();
    expect(result.skippedBySequenceOrTurn).toBe(0);
    expect(result.matchedBy).toBeUndefined();
    expect(result.turnIndexRelaxed).toBeUndefined();
  });

  it("skips a raw fixture when no wire is given", () => {
    expect(matchFixture([rawFixture, typedFallback], req("q"))).toBe(typedFallback);
    expect(matchFixture([rawFixture], req("q"))).toBeNull();
  });

  it("never filters a typed fixture with a stray raw key", () => {
    const stray: Fixture = {
      match: { userMessage: "q" },
      response: JSON.parse(
        '{"content":"hi","raw":{"wire":"openai-responses","events":[]}}',
      ) as FixtureResponse,
    };
    for (const wire of [undefined, "openai-chat", "anthropic"] as const) {
      const result = matchFixtureDiagnostic([stray], req("q"), undefined, undefined, { wire });
      expect(result.fixture).toBe(stray);
    }
  });

  it("never filters a factory", () => {
    const factory: Fixture = {
      match: { userMessage: "q" },
      response: () => ({ raw: { wire: "openai-responses", json: {} } }),
    };
    for (const wire of [undefined, "openai-chat", "openai-responses"] as const) {
      expect(
        matchFixtureDiagnostic([factory], req("q"), undefined, undefined, { wire }).fixture,
      ).toBe(factory);
    }
  });

  it("returns identical results for non-raw fixtures with and without a wire", () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "a" }, response: { content: "A" } },
      { match: { userMessage: "b" }, response: { toolCalls: [{ name: "t", arguments: "{}" }] } },
      { match: { userMessage: "c", sequenceIndex: 1 }, response: { content: "C" } },
    ];
    for (const text of ["a", "b", "c", "none"]) {
      const without = matchFixtureDiagnostic(fixtures, req(text), new Map());
      const withWire = matchFixtureDiagnostic(fixtures, req(text), new Map(), undefined, {
        wire: "anthropic",
      });
      expect(withWire).toEqual(without);
    }
  });
});

describe("raw wire mismatch diagnostic", () => {
  function sink() {
    const messages: string[] = [];
    return { messages, logger: { warn: (...args: unknown[]) => messages.push(args.join(" ")) } };
  }

  it("warns with both wires when a raw fixture matched everything but its wire", () => {
    const { messages, logger } = sink();
    const result = matchFixtureDiagnostic([rawFixture], req("q"), undefined, undefined, {
      wire: "openai-chat",
      logger,
    });
    expect(result.fixture).toBeNull();
    expect(result.skippedBySequenceOrTurn).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('raw.wire="openai-responses"');
    expect(messages[0]).toContain('request wire "openai-chat"');
  });

  it("names a missing raw.wire", () => {
    const { messages, logger } = sink();
    const noWire: Fixture = {
      match: { userMessage: "q" },
      response: JSON.parse('{"raw":{"events":[]}}') as FixtureResponse,
    };
    const result = matchFixtureDiagnostic([noWire], req("q"), undefined, undefined, {
      wire: "anthropic",
      logger,
    });
    expect(result.fixture).toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("raw.wire is missing");
    expect(messages[0]).toContain('request wire "anthropic"');
  });

  it("stays silent when another fixture matched", () => {
    const { messages, logger } = sink();
    const result = matchFixtureDiagnostic(
      [rawFixture, typedFallback],
      req("q"),
      undefined,
      undefined,
      { wire: "openai-chat", logger },
    );
    expect(result.fixture).toBe(typedFallback);
    expect(messages).toHaveLength(0);
  });

  it("stays silent when the raw fixture's content does not match either", () => {
    const { messages, logger } = sink();
    const result = matchFixtureDiagnostic([rawFixture], req("other"), undefined, undefined, {
      wire: "openai-chat",
      logger,
    });
    expect(result.fixture).toBeNull();
    expect(messages).toHaveLength(0);
  });

  it("leaves the HTTP 404 status and body unchanged, and logs the warning", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    const mock = new LLMock({ port: 0, logLevel: "warn" });
    try {
      mock.addFixture(rawFixture);
      await mock.start();
      const res = await fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "q" }] }),
      });
      expect(res.status).toBe(404);
      const body: unknown = await res.json();
      expect(body).toEqual({
        error: {
          message: "No fixture matched",
          type: "invalid_request_error",
          code: "no_fixture_match",
          param: null,
        },
      });
    } finally {
      console.warn = original;
      await mock.stop();
    }
    const hits = warnings.filter((w) => w.includes("raw.wire"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('raw.wire="openai-responses"');
    expect(hits[0]).toContain('request wire "openai-chat"');
  });
});
