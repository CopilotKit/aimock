import { describe, expect, test } from "vitest";
import type { FixtureFileResponse, MisbehaviorFault } from "../types.js";
import { withFaultFixture } from "./helpers/misbehavior-server.js";

/**
 * A fault that replaces, truncates or empties the reply text drops the
 * fixture's `citations` for that turn: their offsets index text that is no
 * longer served. A fault that keeps the text keeps its citations.
 */

const CITED_URL = "https://example.com/cited";

// Joined text: "Sunny skies today. More." (24 UTF-16 units). The citation
// covers the trailing text block, which stop-length-mid-tool cuts away.
const citedResponse: FixtureFileResponse = {
  blocks: [
    { type: "text", text: "Sunny skies today." },
    { type: "toolCall", id: "call_weather", name: "weather", arguments: { city: "Paris" } },
    { type: "text", text: " More." },
  ],
  citations: [{ url: CITED_URL, title: "Forecast", startIndex: 19, endIndex: 24 }],
};

type Wire = "openai-chat" | "anthropic" | "gemini";

async function send(url: string, wire: Wire, stream: boolean): Promise<Response> {
  switch (wire) {
    case "openai-chat":
      return fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          stream,
          messages: [{ role: "user", content: "weather" }],
        }),
      });
    case "anthropic":
      return fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          stream,
          messages: [{ role: "user", content: "weather" }],
        }),
      });
    case "gemini":
      return fetch(
        `${url}/v1beta/models/gemini-2.0-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Declared tools: without them Gemini answers tool-unknown-name
          // with a text-free UNEXPECTED_TOOL_CALL candidate.
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "weather" }] }],
            tools: [{ functionDeclarations: [{ name: "weather" }] }],
          }),
        },
      );
  }
}

const textAltering: Record<Wire, MisbehaviorFault[]> = {
  "openai-chat": [
    { fault: "empty-response" },
    { fault: "refusal" },
    { fault: "content-filter" },
    { fault: "reasoning-only", reasoning: "Hm." },
    { fault: "stop-length-mid-tool" },
  ],
  anthropic: [
    { fault: "empty-response" },
    { fault: "refusal" },
    { fault: "reasoning-only", reasoning: "Hm." },
    { fault: "stop-length-mid-tool" },
  ],
  gemini: [
    { fault: "empty-response" },
    { fault: "content-filter" },
    { fault: "reasoning-only", reasoning: "Hm." },
    { fault: "stop-length-mid-tool" },
  ],
};

const cells = (Object.keys(textAltering) as Wire[]).flatMap((wire) =>
  textAltering[wire].flatMap((fault) =>
    [false, true].map((stream) => ({ wire, fault, stream, name: fault.fault })),
  ),
);

describe("misbehavior faults that alter the reply text drop its citations", () => {
  test.each(cells)("$wire $name stream=$stream", async ({ wire, fault, stream }) => {
    await withFaultFixture(
      { faults: [fault] },
      async ({ url }) => {
        const res = await send(url, wire, stream);
        const body = await res.text();
        expect(body).not.toContain("aimock_invalid_fixture_citation");
        expect(res.status).toBe(200);
        expect(body).not.toContain(CITED_URL);
      },
      { response: citedResponse },
    );
  });
});

/**
 * Citations on a turn with no text are a fixture error (a coded 500). A fault
 * that leaves the turn with no text drops the citations first, so the fault
 * reply is served, not that 500.
 */
describe("misbehavior faults that empty the reply text do not answer the no-text 500", () => {
  // The only text block follows the tool call, so stop-length-mid-tool's cut
  // leaves no text at all.
  const trailingTextOnly: FixtureFileResponse = {
    blocks: [
      { type: "toolCall", id: "call_weather", name: "weather", arguments: { city: "Paris" } },
      { type: "text", text: "Sunny." },
    ],
    citations: [{ url: CITED_URL, title: "Forecast", startIndex: 0, endIndex: 6 }],
  };
  const emptying = (["openai-chat", "anthropic", "gemini"] as const).flatMap((wire) =>
    [
      { fault: { fault: "empty-response" } as MisbehaviorFault, response: citedResponse },
      { fault: { fault: "stop-length-mid-tool" } as MisbehaviorFault, response: trailingTextOnly },
    ].flatMap(({ fault, response }) =>
      [false, true].map((stream) => ({ wire, fault, response, stream, name: fault.fault })),
    ),
  );
  test.each(emptying)("$wire $name stream=$stream", async ({ wire, fault, response, stream }) => {
    await withFaultFixture(
      { faults: [fault] },
      async ({ url, mock }) => {
        const res = await send(url, wire, stream);
        const body = await res.text();
        expect(body).not.toContain("this turn has no text");
        expect(body).not.toContain("aimock_invalid_fixture_citation");
        expect(res.status, body).toBe(200);
        expect(body).not.toContain(CITED_URL);
        expect(mock.getRequests().at(-1)?.response.status).toBe(200);
      },
      { response },
    );
  });
});

describe("misbehavior faults that keep the reply text keep its citations", () => {
  const controls = (["openai-chat", "anthropic", "gemini"] as const).flatMap((wire) =>
    [false, true].map((stream) => ({ wire, stream })),
  );
  test.each(controls)("$wire tool-unknown-name stream=$stream", async ({ wire, stream }) => {
    await withFaultFixture(
      { faults: [{ fault: "tool-unknown-name" }] },
      async ({ url }) => {
        const res = await send(url, wire, stream);
        const body = await res.text();
        expect(res.status).toBe(200);
        expect(body).toContain("weather_v2");
        expect(body).toContain(CITED_URL);
      },
      { response: citedResponse },
    );
  });

  // Without a trailing text block, the cut keeps every text block whole.
  test.each(controls)(
    "$wire stop-length-mid-tool with untouched text stream=$stream",
    async ({ wire, stream }) => {
      await withFaultFixture(
        { faults: [{ fault: "stop-length-mid-tool" }] },
        async ({ url }) => {
          const res = await send(url, wire, stream);
          const body = await res.text();
          expect(res.status).toBe(200);
          expect(body).toContain(CITED_URL);
        },
        {
          response: {
            blocks: [
              { type: "text", text: "Sunny skies today." },
              {
                type: "toolCall",
                id: "call_weather",
                name: "weather",
                arguments: { city: "Paris" },
              },
            ],
            citations: [{ url: CITED_URL, title: "Forecast", startIndex: 6, endIndex: 18 }],
          },
        },
      );
    },
  );
});
