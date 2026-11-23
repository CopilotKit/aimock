import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMock } from "../llmock.js";
import type { RawWireId } from "../types.js";

// Every LLM handler tells the router its wire (#549 T7), so a raw fixture
// reaches its own wire's handler and no other. Until the HTTP raw branches
// land (T8-T13) the handler answers a matched raw fixture with its existing
// "did not match any known type" 500; the served-body assertions come then.

const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

interface Site {
  label: string;
  wire: RawWireId;
  path: string;
  body: (text: string) => unknown;
}

/** One request per handler that gains a wire (11 HTTP handler sites, 9 wires). */
const SITES: Site[] = [
  {
    label: "openai-responses (handleResponses)",
    wire: "openai-responses",
    path: "/v1/responses",
    body: (text) => ({ model: "gpt-4.1", input: text, stream: false }),
  },
  {
    label: "openai-chat (handleCompletions)",
    wire: "openai-chat",
    path: "/v1/chat/completions",
    body: (text) => ({ model: "gpt-4.1", messages: [{ role: "user", content: text }] }),
  },
  {
    label: "anthropic (handleMessages)",
    wire: "anthropic",
    path: "/v1/messages",
    body: (text) => ({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
    }),
  },
  {
    label: "gemini (handleGemini)",
    wire: "gemini",
    path: "/v1beta/models/gemini-2.5-flash:generateContent",
    body: (text) => ({ contents: [{ role: "user", parts: [{ text }] }] }),
  },
  {
    label: "gemini-interactions (handleGeminiInteractions)",
    wire: "gemini-interactions",
    path: "/v1beta/interactions",
    body: (text) => ({ model: "gemini-2.5-flash", input: text, stream: false }),
  },
  {
    label: "cohere (handleCohere)",
    wire: "cohere",
    path: "/v2/chat",
    body: (text) => ({ model: "command-r-plus", messages: [{ role: "user", content: text }] }),
  },
  {
    label: "ollama (handleOllama)",
    wire: "ollama",
    path: "/api/chat",
    body: (text) => ({
      model: "llama3.1",
      messages: [{ role: "user", content: text }],
      stream: false,
    }),
  },
  {
    label: "ollama (handleOllamaGenerate)",
    wire: "ollama-generate",
    path: "/api/generate",
    body: (text) => ({ model: "llama3.1", prompt: text, stream: false }),
  },
  {
    label: "bedrock-invoke (handleBedrock)",
    wire: "bedrock-invoke",
    path: `/model/${MODEL}/invoke`,
    body: (text) => ({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
    }),
  },
  {
    label: "bedrock-invoke (handleBedrockStream)",
    wire: "bedrock-invoke",
    path: `/model/${MODEL}/invoke-with-response-stream`,
    body: (text) => ({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
    }),
  },
  {
    label: "bedrock-converse (handleConverse)",
    wire: "bedrock-converse",
    path: `/model/${MODEL}/converse`,
    body: (text) => ({ messages: [{ role: "user", content: [{ text }] }] }),
  },
  {
    label: "bedrock-converse (handleConverseStream)",
    wire: "bedrock-converse",
    path: `/model/${MODEL}/converse-stream`,
    body: (text) => ({ messages: [{ role: "user", content: [{ text }] }] }),
  },
];

/** A wire other than `wire`, for the cross-wire case. */
function otherWire(wire: RawWireId): RawWireId {
  return wire === "openai-responses" ? "anthropic" : "openai-responses";
}

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  vi.restoreAllMocks();
});

async function serve(rawWire: RawWireId, site: Site) {
  mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
  mock.addFixture({
    match: { userMessage: "plumbing" },
    response: { raw: { wire: rawWire, events: [{ type: "x" }], json: { raw: true } } },
  });
  mock.addFixture({ match: { userMessage: "plumbing" }, response: { content: "typed fallback" } });
  await mock.start();
  const [raw, typed] = mock.getFixtures();
  const res = await fetch(`${mock.url}${site.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(site.body("plumbing")),
  });
  const text = Buffer.from(await res.arrayBuffer()).toString("latin1");
  const entries = mock.getRequests();
  return {
    status: res.status,
    text,
    entries,
    rawCount: mock.journal.getFixtureMatchCount(raw),
    typedCount: mock.journal.getFixtureMatchCount(typed),
    raw,
    typed,
  };
}

describe("same wire: the raw fixture reaches its own wire's handler", () => {
  it.each(SITES)("$label", async (site) => {
    const result = await serve(site.wire, site);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].response.fixture).toBe(result.raw);
    expect(result.rawCount).toBe(1);
    expect(result.typedCount).toBe(0);
    expect(result.text).not.toContain("typed fallback");
  });
});

describe("cross wire: a raw fixture for another wire never matches", () => {
  it.each(SITES)("$label", async (site) => {
    const result = await serve(otherWire(site.wire), site);
    expect(result.status).toBe(200);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].response.fixture).toBe(result.typed);
    expect(result.rawCount).toBe(0);
    expect(result.typedCount).toBe(1);
    expect(result.entries[0].response.status).toBe(200);
  });
});

describe("gemini-interactions passes only the wire (no record match options)", () => {
  it("a turnIndex fixture matches exactly as before, with record configured and no relaxed-turnIndex warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimock-raw-turn-"));
    const warn = vi.spyOn(console, "warn");
    try {
      mock = new LLMock({
        port: 0,
        host: "127.0.0.1",
        logLevel: "warn",
        record: { providers: { "gemini-interactions": "http://127.0.0.1:9" }, fixturePath: dir },
      });
      mock.addFixture({
        match: { userMessage: "turn", turnIndex: 3 },
        response: { content: "turn reply" },
      });
      await mock.start();
      const res = await fetch(`${mock.url}/v1beta/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-2.5-flash", input: "turn", stream: false }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("turn reply");
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/turnIndex/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
