import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { entryToFixture, validateFixtures } from "../fixture-loader.js";
import type { FixtureFileEntry, FixtureFileResponse } from "../types.js";

// No-regression guard for raw passthrough fixtures (#549). Every test here is
// GREEN on main and must stay GREEN: the feature is opt-in, so a fixture that
// already has a type marker plus a stray `raw` key, an unscoped `{ json }`
// fixture and every typed request's journal body behave exactly as before.

const WIRES = [
  "openai-responses",
  "openai-chat",
  "anthropic",
  "gemini",
  "gemini-interactions",
  "cohere",
  "ollama",
  "bedrock-invoke",
  "bedrock-converse",
] as const;
type Wire = (typeof WIRES)[number];

const BEDROCK_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

/** One non-streaming request on `wire` whose last user message is `text`. */
function request(wire: Wire, text: string): { path: string; body: unknown } {
  switch (wire) {
    case "openai-responses":
      return { path: "/v1/responses", body: { model: "gpt-4.1", input: text, stream: false } };
    case "openai-chat":
      return {
        path: "/v1/chat/completions",
        body: { model: "gpt-4.1", messages: [{ role: "user", content: text }] },
      };
    case "anthropic":
      return {
        path: "/v1/messages",
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          messages: [{ role: "user", content: text }],
        },
      };
    case "gemini":
      return {
        path: "/v1beta/models/gemini-2.5-flash:generateContent",
        body: { contents: [{ role: "user", parts: [{ text }] }] },
      };
    case "gemini-interactions":
      return {
        path: "/v1beta/interactions",
        body: { model: "gemini-2.5-flash", input: text, stream: false },
      };
    case "cohere":
      return {
        path: "/v2/chat",
        body: { model: "command-r-plus", messages: [{ role: "user", content: text }] },
      };
    case "ollama":
      return {
        path: "/api/chat",
        body: { model: "llama3.1", messages: [{ role: "user", content: text }], stream: false },
      };
    case "bedrock-invoke":
      return {
        path: `/model/${BEDROCK_MODEL}/invoke`,
        body: {
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 64,
          messages: [{ role: "user", content: text }],
        },
      };
    case "bedrock-converse":
      return {
        path: `/model/${BEDROCK_MODEL}/converse`,
        body: { messages: [{ role: "user", content: [{ text }] }] },
      };
  }
}

async function send(mock: LLMock, wire: Wire, text: string) {
  const { path, body } = request(wire, text);
  const res = await fetch(`${mock.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// Ids and timestamps are generated per request; everything else must match.
const VOLATILE = /^(id|created|created_at|createdAt|responseId|call_id|toolUseId|event_id)$/;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, VOLATILE.test(k) ? "<volatile>" : stable(v)]),
    );
  }
  return value;
}
function stableBody(text: string): unknown {
  try {
    return stable(JSON.parse(text));
  } catch {
    return text;
  }
}

const strayRaw = { wire: "openai-chat", events: [{ stray: true }], json: { stray: true } };
const typed: { kind: string; response: FixtureFileResponse }[] = [
  { kind: "text", response: { content: "hi" } },
  {
    kind: "toolCalls",
    response: { toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}' }] },
  },
  { kind: "error", response: { error: { message: "typed boom", type: "server_error" } } },
];
/** The same typed response with a stray `raw` key, built from JSON (the file-load shape). */
function withStrayRaw(response: FixtureFileResponse): FixtureFileResponse {
  return JSON.parse(JSON.stringify({ ...response, raw: strayRaw }));
}

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

describe("raw no-regression: typed fixtures with a stray raw key", () => {
  for (const { kind, response } of typed) {
    it(`${kind} + raw: zero load findings`, () => {
      const entry: FixtureFileEntry = {
        match: { userMessage: "x" },
        response: withStrayRaw(response),
      };
      expect(validateFixtures([entryToFixture(entry)])).toEqual([]);
    });

    it(`${kind} + raw: /__aimock/fixtures reports kind "${kind}"`, async () => {
      mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
      mock.addFixturesFromJSON([{ match: { userMessage: "x" }, response: withStrayRaw(response) }]);
      await mock.start();
      const res = await fetch(`${mock.url}/__aimock/fixtures?include=fixtures`);
      const body = (await res.json()) as { fixtures: { responseKind: string }[] };
      expect(body.fixtures.map((f) => f.responseKind)).toEqual([kind]);
    });

    it(`${kind} + raw: matched on all 9 wires and served exactly like the plain fixture`, async () => {
      mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
      mock.addFixturesFromJSON([
        { match: { userMessage: "stray" }, response: withStrayRaw(response) },
        { match: { userMessage: "plain" }, response },
      ]);
      await mock.start();
      const [strayFixture] = mock.getFixtures();
      for (const wire of WIRES) {
        mock.clearRequests();
        const stray = await send(mock, wire, "stray");
        const entry = mock.getLastRequest();
        expect(entry?.response.fixture, wire).toBe(strayFixture);
        const plain = await send(mock, wire, "plain");
        expect(stray.status, wire).toBe(plain.status);
        expect(stableBody(stray.text), wire).toEqual(stableBody(plain.text));
      }
    });
  }
});

describe("raw no-regression: unscoped json and journal bodies", () => {
  it("an unscoped { json } (fal-style) fixture still returns 500 on every LLM wire", async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    mock.addFixturesFromJSON([{ match: { userMessage: "fal" }, response: { json: { ok: 1 } } }]);
    await mock.start();
    for (const wire of WIRES) {
      const reply = await send(mock, wire, "fal");
      expect(reply.status, wire).toBe(500);
      expect(reply.text, wire).not.toContain('"ok"');
    }
  });

  it("the journaled request body of a typed fixture is unchanged on every wire", async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    mock.addFixturesFromJSON([{ match: { userMessage: "journal" }, response: { content: "hi" } }]);
    await mock.start();
    const bodies: Record<string, unknown> = {};
    for (const wire of WIRES) {
      mock.clearRequests();
      expect((await send(mock, wire, "journal")).status, wire).toBe(200);
      bodies[wire] = mock.getLastRequest()?.body;
    }
    for (const body of Object.values(bodies)) expect(JSON.stringify(body)).not.toContain("_wire");
    expect(bodies).toMatchSnapshot();
  });

  it("on() with an invalid raw object does not throw", () => {
    const local = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    const invalid: FixtureFileResponse = JSON.parse(
      '{"raw":{"wire":"not-a-wire","status":99,"headers":{"content-length":"5"}}}',
    );
    expect(() => local.on({ userMessage: "bad" }, invalid)).not.toThrow();
  });
});
