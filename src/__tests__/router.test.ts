import { describe, it, expect } from "vitest";
import {
  matchFixture,
  getLastMessageByRole,
  getSystemText,
  getTextContent,
  getLastUserText,
} from "../router.js";
import type { ChatCompletionRequest, ChatMessage, ContentPart, Fixture } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function makeFixture(
  match: Fixture["match"],
  response: Fixture["response"] = { content: "ok" },
): Fixture {
  return { match, response };
}

// ---------------------------------------------------------------------------
// getLastMessageByRole
// ---------------------------------------------------------------------------

describe("getLastMessageByRole", () => {
  it("returns the last message with the matching role", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const result = getLastMessageByRole(messages, "user");
    expect(result?.content).toBe("second");
  });

  it("returns null when no message has the given role", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(getLastMessageByRole(messages, "tool")).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(getLastMessageByRole([], "user")).toBeNull();
  });

  it("returns the only message when there is exactly one match", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "question" },
    ];
    expect(getLastMessageByRole(messages, "system")?.content).toBe("you are helpful");
  });
});

// ---------------------------------------------------------------------------
// getTextContent
// ---------------------------------------------------------------------------

describe("getTextContent", () => {
  it("returns the string as-is for string content", () => {
    expect(getTextContent("hello world")).toBe("hello world");
  });

  it("returns null for null content", () => {
    expect(getTextContent(null)).toBeNull();
  });

  it("extracts text from array-of-parts content", () => {
    const parts: ContentPart[] = [{ type: "text", text: "hello world" }];
    expect(getTextContent(parts)).toBe("hello world");
  });

  it("concatenates multiple text parts", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ];
    expect(getTextContent(parts)).toBe("hello world");
  });

  it("ignores non-text parts in array content", () => {
    const parts: ContentPart[] = [
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
      { type: "text", text: "describe this" },
    ];
    expect(getTextContent(parts)).toBe("describe this");
  });

  it("returns null for array with no text parts", () => {
    const parts: ContentPart[] = [
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    ];
    expect(getTextContent(parts)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(getTextContent([])).toBeNull();
  });

  it("returns the empty string (NOT null) for an array with a present-but-empty text part", () => {
    // Symmetric with the string path: getTextContent("") returns "", so an
    // array carrying a present-but-empty text part likewise returns "" — a
    // present-but-empty body, distinct from `null` (no text content at all).
    const parts: ContentPart[] = [{ type: "text", text: "" }];
    expect(getTextContent(parts)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// matchFixture — empty / null cases
// ---------------------------------------------------------------------------

describe("matchFixture — empty / null", () => {
  it("returns null for an empty fixtures array", () => {
    expect(matchFixture([], makeReq())).toBeNull();
  });

  it("returns null when no fixture matches", () => {
    const fixtures = [makeFixture({ userMessage: "goodbye" })];
    expect(matchFixture(fixtures, makeReq())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchFixture — userMessage
// ---------------------------------------------------------------------------

describe("matchFixture — userMessage (string)", () => {
  it("matches when the last user message includes the string", () => {
    const fixture = makeFixture({ userMessage: "hello" });
    const req = makeReq({ messages: [{ role: "user", content: "say hello world" }] });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when the last user message does not include the string", () => {
    const fixture = makeFixture({ userMessage: "goodbye" });
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches against the LAST user message, not an earlier one", () => {
    const fixture = makeFixture({ userMessage: "final" });
    const req = makeReq({
      messages: [
        { role: "user", content: "first message with final word" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second message" },
      ],
    });
    // "final" appears in the first user message but not the last
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match when there is no user message", () => {
    const fixture = makeFixture({ userMessage: "hello" });
    const req = makeReq({ messages: [{ role: "system", content: "hello system" }] });
    expect(matchFixture([fixture], req)).toBeNull();
  });
});

describe("matchFixture — userMessage (array content)", () => {
  it("matches when user content is array-of-parts with matching text", () => {
    const fixture = makeFixture({ userMessage: "hello" });
    const req = makeReq({
      messages: [{ role: "user", content: [{ type: "text", text: "say hello world" }] }],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when array-of-parts text does not include the string", () => {
    const fixture = makeFixture({ userMessage: "goodbye" });
    const req = makeReq({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches regexp against array-of-parts text", () => {
    const fixture = makeFixture({ userMessage: /^hello/i });
    const req = makeReq({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello world" }] }],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("concatenates multiple text parts for matching", () => {
    const fixture = makeFixture({ userMessage: "hello world" });
    const req = makeReq({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("skips array content with no text parts", () => {
    const fixture = makeFixture({ userMessage: "hello" });
    const req = makeReq({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com" } }],
        },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches the text prompt when a trailing user message is attachment-only (multimodal image split)", () => {
    // Some SDKs (e.g. Microsoft Agent Framework's agent_framework_openai image
    // path) serialise a single multimodal turn into a text-only user message
    // FOLLOWED by a separate attachment-only user message. The trailing
    // image-only message must not shadow the real prompt.
    const fixture = makeFixture({ userMessage: "describe this image" });
    const req = makeReq({
      messages: [
        { role: "user", content: "please describe this image" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
        },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("keeps matching a trailing user message that HAS text (does not skip a flattened attachment)", () => {
    // Contrast with the image split above: when the trailing user message
    // carries text (e.g. a pdf flattened to `[Attached document]\n…` by the
    // agent) it is NOT skipped — it is the match target. Fixtures for such a
    // turn therefore key on the flattened body, not the original prompt.
    const fixture = makeFixture({ userMessage: "CopilotKit Quickstart" });
    const req = makeReq({
      messages: [
        { role: "user", content: "can you tell me what is in this demo pdf I just attached" },
        {
          role: "user",
          content: "[Attached document]\nCopilotKit Quickstart\nAdd AI copilots to your app.",
        },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });
});

describe("matchFixture — userMessage (RegExp)", () => {
  it("matches when the last user message satisfies the regexp", () => {
    const fixture = makeFixture({ userMessage: /^hello/i });
    const req = makeReq({ messages: [{ role: "user", content: "Hello world" }] });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when the regexp does not match", () => {
    const fixture = makeFixture({ userMessage: /^goodbye/i });
    const req = makeReq({ messages: [{ role: "user", content: "Hello world" }] });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("uses regexp against the last user message only", () => {
    const fixture = makeFixture({ userMessage: /first/ });
    const req = makeReq({
      messages: [
        { role: "user", content: "first message" },
        { role: "user", content: "second message" },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSystemText
// ---------------------------------------------------------------------------

describe("getSystemText", () => {
  it("returns empty string when there are no system messages", () => {
    expect(getSystemText([{ role: "user", content: "hi" }])).toBe("");
  });

  it("returns the single system message text", () => {
    expect(
      getSystemText([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ]),
    ).toBe("You are helpful.");
  });

  it("joins multiple system messages with newlines in order", () => {
    expect(
      getSystemText([
        { role: "system", content: "first" },
        { role: "user", content: "ignored" },
        { role: "system", content: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("extracts text from array-of-parts system content", () => {
    expect(
      getSystemText([{ role: "system", content: [{ type: "text", text: "from parts" }] }]),
    ).toBe("from parts");
  });
});

// ---------------------------------------------------------------------------
// matchFixture — systemMessage
// ---------------------------------------------------------------------------

describe("matchFixture — systemMessage (string)", () => {
  it("matches when a system message contains the substring", () => {
    const fixture = makeFixture({ systemMessage: "Atai" });
    const req = makeReq({
      messages: [
        { role: "system", content: "User name is Atai. Timezone America/Los_Angeles." },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when no system message contains the substring", () => {
    const fixture = makeFixture({ systemMessage: "Atai" });
    const req = makeReq({
      messages: [
        { role: "system", content: "User name is Alem." },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match when there are no system messages", () => {
    const fixture = makeFixture({ systemMessage: "anything" });
    const req = makeReq({ messages: [{ role: "user", content: "hi" }] });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches across the joined text of multiple system messages", () => {
    const fixture = makeFixture({ systemMessage: "Atai" });
    const req = makeReq({
      messages: [
        { role: "system", content: "Persona: helpful." },
        { role: "system", content: "Context: name=Atai" },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("matches when system content is array-of-parts", () => {
    const fixture = makeFixture({ systemMessage: "Atai" });
    const req = makeReq({
      messages: [
        { role: "system", content: [{ type: "text", text: "name=Atai" }] },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("combines with userMessage — both must match", () => {
    const fixture = makeFixture({ userMessage: "Who am I", systemMessage: "Atai" });
    const matching = makeReq({
      messages: [
        { role: "system", content: "name=Atai" },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], matching)).toBe(fixture);

    const userOnly = makeReq({
      messages: [
        { role: "system", content: "name=Alem" },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], userOnly)).toBeNull();

    const systemOnly = makeReq({
      messages: [
        { role: "system", content: "name=Atai" },
        { role: "user", content: "Different prompt" },
      ],
    });
    expect(matchFixture([fixture], systemOnly)).toBeNull();
  });

  it("falls through to the next fixture on systemMessage miss", () => {
    const specific = makeFixture(
      { userMessage: "Who am I", systemMessage: "Atai" },
      { content: "Hi Atai" },
    );
    const fallback = makeFixture({ userMessage: "Who am I" }, { content: "Hi user" });
    const req = makeReq({
      messages: [
        { role: "system", content: "name=Alem" },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([specific, fallback], req)).toBe(fallback);
  });
});

describe("matchFixture — systemMessage (string[] AND)", () => {
  it("matches when every substring is present in the system text", () => {
    const fixture = makeFixture({ systemMessage: ["name=Atai", "tz=PST"] });
    const req = makeReq({
      messages: [
        { role: "system", content: "ctx: name=Atai\nctx: tz=PST\nctx: misc" },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when any substring is missing", () => {
    const fixture = makeFixture({ systemMessage: ["name=Atai", "tz=PST"] });
    const req = makeReq({
      messages: [
        { role: "system", content: "ctx: name=Atai\nctx: tz=EST" },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches across multiple system messages (any substring may live in any of them)", () => {
    const fixture = makeFixture({ systemMessage: ["name=Atai", "default-activities"] });
    const req = makeReq({
      messages: [
        { role: "system", content: "Persona: helpful." },
        { role: "system", content: "Context: name=Atai" },
        { role: "system", content: "Context: default-activities" },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when there are no system messages", () => {
    const fixture = makeFixture({ systemMessage: ["anything"] });
    const req = makeReq({ messages: [{ role: "user", content: "hi" }] });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("treats single-element array same as a string substring", () => {
    const fixture = makeFixture({ systemMessage: ["Atai"] });
    const req = makeReq({
      messages: [
        { role: "system", content: "name=Atai" },
        { role: "user", content: "hi" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("combines with userMessage — both gate plus all substrings must match", () => {
    const fixture = makeFixture({
      userMessage: "Plan my morning",
      systemMessage: ["name=Atai", "tz=PST"],
    });
    const matching = makeReq({
      messages: [
        { role: "system", content: "name=Atai\ntz=PST" },
        { role: "user", content: "Plan my morning please" },
      ],
    });
    expect(matchFixture([fixture], matching)).toBe(fixture);

    const partial = makeReq({
      messages: [
        { role: "system", content: "name=Atai" }, // tz missing
        { role: "user", content: "Plan my morning please" },
      ],
    });
    expect(matchFixture([fixture], partial)).toBeNull();
  });

  it("falls through to the next fixture when one substring is missing", () => {
    const specific = makeFixture(
      { userMessage: "hi", systemMessage: ["Atai", "PST"] },
      { content: "exact-defaults" },
    );
    const fallback = makeFixture({ userMessage: "hi" }, { content: "generic" });
    const req = makeReq({
      messages: [
        { role: "system", content: "name=Atai\ntz=EST" }, // tz mismatch
        { role: "user", content: "hi" },
      ],
    });
    expect(matchFixture([specific, fallback], req)).toBe(fallback);
  });
});

describe("matchFixture — systemMessage (RegExp)", () => {
  it("matches when the joined system text satisfies the regexp", () => {
    const fixture = makeFixture({ systemMessage: /name=Atai/ });
    const req = makeReq({
      messages: [
        { role: "system", content: "ctx: name=Atai, tz=PST" },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when the regexp misses", () => {
    const fixture = makeFixture({ systemMessage: /name=Atai/ });
    const req = makeReq({
      messages: [
        { role: "system", content: "ctx: name=Alem" },
        { role: "user", content: "Who am I?" },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchFixture — toolCallId
// ---------------------------------------------------------------------------

describe("matchFixture — toolCallId", () => {
  it("matches when the last tool message has the matching tool_call_id", () => {
    const fixture = makeFixture({ toolCallId: "call_abc123" });
    const req = makeReq({
      messages: [
        { role: "user", content: "use a tool" },
        { role: "tool", content: "result", tool_call_id: "call_abc123" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when the tool_call_id is different", () => {
    const fixture = makeFixture({ toolCallId: "call_abc123" });
    const req = makeReq({
      messages: [{ role: "tool", content: "result", tool_call_id: "call_other" }],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches against the LAST tool message", () => {
    const fixture = makeFixture({ toolCallId: "call_second" });
    const req = makeReq({
      messages: [
        { role: "tool", content: "first", tool_call_id: "call_first" },
        { role: "tool", content: "second", tool_call_id: "call_second" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when there is no tool message", () => {
    const fixture = makeFixture({ toolCallId: "call_abc123" });
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match when a new user turn follows the tool message", () => {
    // Regression: a toolCallId fixture is the response to a tool result, so it
    // must only fire when the tool message is the LAST message in the request.
    // If the user sends another turn after the tool result, the stale tool_call_id
    // in history must not shadow userMessage matchers for the new turn.
    const stale = makeFixture(
      { toolCallId: "call_pie_chart" },
      { content: "Pie chart rendered above" },
    );
    const fresh = makeFixture({ userMessage: "bar chart" }, { content: "bar chart response" });
    const req = makeReq({
      messages: [
        { role: "user", content: "show me a pie chart" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_pie_chart",
              type: "function",
              function: { name: "pieChart", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "{}", tool_call_id: "call_pie_chart" },
        { role: "assistant", content: "Pie chart rendered above" },
        { role: "user", content: "now show me a bar chart" },
      ],
    });
    expect(matchFixture([stale, fresh], req)).toBe(fresh);
  });

  it("does not match when an assistant content message follows the tool message", () => {
    // The assistant has already emitted its final content for the tool result;
    // any follow-up LLM call that arrives in this state should not re-fire the
    // toolCallId fixture (which would loop the same content back).
    const stale = makeFixture({ toolCallId: "call_abc" }, { content: "tool answered" });
    const req = makeReq({
      messages: [
        { role: "user", content: "do thing" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_abc", type: "function", function: { name: "thing", arguments: "{}" } },
          ],
        },
        { role: "tool", content: "{}", tool_call_id: "call_abc" },
        { role: "assistant", content: "tool answered" },
      ],
    });
    expect(matchFixture([stale], req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchFixture — toolResultContains
// ---------------------------------------------------------------------------

describe("matchFixture — toolResultContains", () => {
  it("discriminates approve vs cancel legs that share a toolCallId", () => {
    // The motivating case: a human-in-the-loop suspend tool resumes with the
    // SAME tool_call_id for both outcomes; only the tool-result JSON differs.
    const cancelled = makeFixture(
      { toolCallId: "call_schedule_001", toolResultContains: '"cancelled"' },
      { content: "No problem — nothing was booked." },
    );
    const confirmed = makeFixture(
      { toolCallId: "call_schedule_001", toolResultContains: '"chosen_' },
      { content: "Booked: Monday 9:00 AM confirmed." },
    );
    const base = [
      { role: "user" as const, content: "schedule a meeting" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call_schedule_001",
            type: "function" as const,
            function: { name: "schedule_meeting", arguments: "{}" },
          },
        ],
      },
    ];
    const cancelReq = makeReq({
      messages: [
        ...base,
        { role: "tool", content: '{"cancelled": true}', tool_call_id: "call_schedule_001" },
      ],
    });
    const pickReq = makeReq({
      messages: [
        ...base,
        {
          role: "tool",
          content: '{"chosen_time": "2026-07-20T09:00:00Z", "chosen_label": "Monday 9:00 AM"}',
          tool_call_id: "call_schedule_001",
        },
      ],
    });
    const fixtures = [cancelled, confirmed];
    expect(matchFixture(fixtures, cancelReq)).toBe(cancelled);
    expect(matchFixture(fixtures, pickReq)).toBe(confirmed);
  });

  it("matches when the last tool message contains the substring", () => {
    const fixture = makeFixture({ toolResultContains: "cancelled" });
    const req = makeReq({
      messages: [
        { role: "user", content: "do thing" },
        { role: "tool", content: '{"cancelled": true}', tool_call_id: "call_x" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when the substring is absent", () => {
    const fixture = makeFixture({ toolResultContains: "cancelled" });
    const req = makeReq({
      messages: [
        { role: "user", content: "do thing" },
        { role: "tool", content: '{"chosen_time": "9am"}', tool_call_id: "call_x" },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match a request with no tool message", () => {
    const fixture = makeFixture({ toolResultContains: "cancelled" });
    const req = makeReq({ messages: [{ role: "user", content: "cancelled my plans" }] });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match when a newer user turn follows the tool message", () => {
    // Same last-message rule as toolCallId: a stale tool result in history
    // must not shadow matchers for the new turn.
    const fixture = makeFixture({ toolResultContains: "cancelled" });
    const req = makeReq({
      messages: [
        { role: "user", content: "do thing" },
        { role: "tool", content: '{"cancelled": true}', tool_call_id: "call_x" },
        { role: "assistant", content: "Cancelled." },
        { role: "user", content: "something else" },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches array-of-parts tool content", () => {
    const fixture = makeFixture({ toolResultContains: "cancelled" });
    const req = makeReq({
      messages: [
        { role: "user", content: "do thing" },
        {
          role: "tool",
          content: [{ type: "text", text: '{"cancelled": true}' }],
          tool_call_id: "call_x",
        },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match tool content with no extractable text", () => {
    const fixture = makeFixture({ toolResultContains: "cancelled" });
    const req = makeReq({
      messages: [
        { role: "user", content: "do thing" },
        { role: "tool", content: null, tool_call_id: "call_x" },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchFixture — toolName
// ---------------------------------------------------------------------------

describe("matchFixture — toolName", () => {
  it("matches when any tool definition has the matching function name", () => {
    const fixture = makeFixture({ toolName: "get_weather" });
    const req = makeReq({
      tools: [
        { type: "function", function: { name: "get_time" } },
        { type: "function", function: { name: "get_weather" } },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when no tool has the function name", () => {
    const fixture = makeFixture({ toolName: "get_weather" });
    const req = makeReq({
      tools: [{ type: "function", function: { name: "get_time" } }],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match when tools is undefined", () => {
    const fixture = makeFixture({ toolName: "get_weather" });
    const req = makeReq({ tools: undefined });
    expect(matchFixture([fixture], req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchFixture — model
// ---------------------------------------------------------------------------

describe("matchFixture — model (string)", () => {
  it("matches when the model is an exact string match", () => {
    const fixture = makeFixture({ model: "gpt-4o" });
    const req = makeReq({ model: "gpt-4o" });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match gpt-4o fixture against gpt-4o-mini (dash + letter, not date suffix)", () => {
    const fixture = makeFixture({ model: "gpt-4o" });
    const req = makeReq({ model: "gpt-4o-mini" });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches when the request model has a date suffix (dash + digit)", () => {
    const fixture = makeFixture({ model: "gpt-4o" });
    const req = makeReq({ model: "gpt-4o-2024-08-06" });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when the request model does not start with the fixture model", () => {
    const fixture = makeFixture({ model: "gpt-4o" });
    const req = makeReq({ model: "gpt-3.5-turbo" });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match gpt-4 fixture against gpt-4o request (no dash boundary)", () => {
    const fixture = makeFixture({ model: "gpt-4" });
    const req = makeReq({ model: "gpt-4o" });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match when request model is undefined", () => {
    const fixture = makeFixture({ model: "gpt-4o" });
    const req = makeReq({ model: undefined });
    expect(matchFixture([fixture], req)).toBeNull();
  });
});

describe("matchFixture — model (startsWith)", () => {
  it("matches when request model starts with fixture model", () => {
    const fixture = makeFixture({ model: "claude-opus-4" });
    const req = makeReq({ model: "claude-opus-4-20250514" });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("matches exact model strings", () => {
    const fixture = makeFixture({ model: "gpt-4o" });
    const req = makeReq({ model: "gpt-4o" });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when models diverge", () => {
    const fixture = makeFixture({ model: "claude-opus-4" });
    const req = makeReq({ model: "claude-haiku-4" });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match when fixture model is longer than request model", () => {
    const fixture = makeFixture({ model: "claude-opus-4-20250514" });
    const req = makeReq({ model: "claude-opus-4" });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("still supports regexp model matching", () => {
    const fixture = makeFixture({ model: /^claude-opus/ });
    const req = makeReq({ model: "claude-opus-4-20250514" });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });
});

describe("matchFixture — model (RegExp)", () => {
  it("matches when the model satisfies the regexp", () => {
    const fixture = makeFixture({ model: /^gpt-4/ });
    const req = makeReq({ model: "gpt-4o-mini" });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when the regexp does not match the model", () => {
    const fixture = makeFixture({ model: /^claude/ });
    const req = makeReq({ model: "gpt-4o" });
    expect(matchFixture([fixture], req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchFixture — predicate
// ---------------------------------------------------------------------------

describe("matchFixture — predicate", () => {
  it("matches when the predicate returns true", () => {
    const fixture = makeFixture({ predicate: (req) => req.model === "special-model" });
    const req = makeReq({ model: "special-model" });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when the predicate returns false", () => {
    const fixture = makeFixture({ predicate: () => false });
    expect(matchFixture([fixture], makeReq())).toBeNull();
  });

  it("predicate receives the full request", () => {
    let capturedReq: ChatCompletionRequest | null = null;
    const req = makeReq({ model: "gpt-4o", temperature: 0.7 });
    const fixture = makeFixture({
      predicate: (r) => {
        capturedReq = r;
        return true;
      },
    });
    matchFixture([fixture], req);
    expect(capturedReq).toBe(req);
  });
});

// ---------------------------------------------------------------------------
// matchFixture — AND logic (combined fields)
// ---------------------------------------------------------------------------

describe("matchFixture — AND logic", () => {
  it("matches only when all specified fields are satisfied", () => {
    const fixture = makeFixture({ userMessage: "hello", model: "gpt-4o" });
    const matchingReq = makeReq({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello world" }],
    });
    const wrongModel = makeReq({
      model: "gpt-3.5",
      messages: [{ role: "user", content: "hello world" }],
    });
    const wrongMessage = makeReq({
      model: "gpt-4o",
      messages: [{ role: "user", content: "goodbye" }],
    });

    expect(matchFixture([fixture], matchingReq)).toBe(fixture);
    expect(matchFixture([fixture], wrongModel)).toBeNull();
    expect(matchFixture([fixture], wrongMessage)).toBeNull();
  });

  it("combines predicate with other fields using AND", () => {
    const fixture = makeFixture({
      model: "gpt-4o",
      predicate: (req) => (req.temperature ?? 0) > 0.5,
    });
    const both = makeReq({ model: "gpt-4o", temperature: 0.9 });
    const onlyModel = makeReq({ model: "gpt-4o", temperature: 0.1 });
    const onlyPredicate = makeReq({ model: "gpt-3.5", temperature: 0.9 });

    expect(matchFixture([fixture], both)).toBe(fixture);
    expect(matchFixture([fixture], onlyModel)).toBeNull();
    expect(matchFixture([fixture], onlyPredicate)).toBeNull();
  });

  it("empty match object matches any request", () => {
    const fixture = makeFixture({});
    expect(matchFixture([fixture], makeReq())).toBe(fixture);
  });
});

// ---------------------------------------------------------------------------
// matchFixture — inputText (embedding matching)
// ---------------------------------------------------------------------------

describe("matchFixture — inputText (string)", () => {
  it("matches when embeddingInput includes the string", () => {
    const fixture = makeFixture({ inputText: "hello" });
    const req = { ...makeReq(), embeddingInput: "say hello world" } as ChatCompletionRequest & {
      embeddingInput: string;
    };
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when embeddingInput does not include the string", () => {
    const fixture = makeFixture({ inputText: "goodbye" });
    const req = { ...makeReq(), embeddingInput: "hello" } as ChatCompletionRequest & {
      embeddingInput: string;
    };
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match when embeddingInput is not present", () => {
    const fixture = makeFixture({ inputText: "hello" });
    expect(matchFixture([fixture], makeReq())).toBeNull();
  });
});

describe("matchFixture — inputText (RegExp)", () => {
  it("matches when embeddingInput satisfies the regexp", () => {
    const fixture = makeFixture({ inputText: /^hello/i });
    const req = { ...makeReq(), embeddingInput: "Hello world" } as ChatCompletionRequest & {
      embeddingInput: string;
    };
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when the regexp does not match", () => {
    const fixture = makeFixture({ inputText: /^goodbye/i });
    const req = { ...makeReq(), embeddingInput: "hello world" } as ChatCompletionRequest & {
      embeddingInput: string;
    };
    expect(matchFixture([fixture], req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchFixture — responseFormat
// ---------------------------------------------------------------------------

describe("matchFixture — responseFormat", () => {
  it("matches when response_format.type equals the fixture responseFormat", () => {
    const fixture = makeFixture({ responseFormat: "json_object" });
    const req = makeReq({ response_format: { type: "json_object" } });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("does not match when response_format.type differs", () => {
    const fixture = makeFixture({ responseFormat: "json_object" });
    const req = makeReq({ response_format: { type: "text" } });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("does not match when response_format is not present in the request", () => {
    const fixture = makeFixture({ responseFormat: "json_object" });
    const req = makeReq();
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches json_schema type", () => {
    const fixture = makeFixture({ responseFormat: "json_schema" });
    const req = makeReq({
      response_format: { type: "json_schema", json_schema: { name: "test" } },
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("combines with userMessage using AND logic", () => {
    const fixture = makeFixture({ userMessage: "hello", responseFormat: "json_object" });
    const matchingReq = makeReq({
      messages: [{ role: "user", content: "hello world" }],
      response_format: { type: "json_object" },
    });
    const wrongFormat = makeReq({
      messages: [{ role: "user", content: "hello world" }],
    });
    const wrongMessage = makeReq({
      messages: [{ role: "user", content: "goodbye" }],
      response_format: { type: "json_object" },
    });

    expect(matchFixture([fixture], matchingReq)).toBe(fixture);
    expect(matchFixture([fixture], wrongFormat)).toBeNull();
    expect(matchFixture([fixture], wrongMessage)).toBeNull();
  });

  it("fixture without responseFormat matches requests with or without response_format", () => {
    const fixture = makeFixture({ userMessage: "hello" });
    const withFormat = makeReq({
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_object" },
    });
    const withoutFormat = makeReq({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(matchFixture([fixture], withFormat)).toBe(fixture);
    expect(matchFixture([fixture], withoutFormat)).toBe(fixture);
  });
});

// ---------------------------------------------------------------------------
// matchFixture — sequenceIndex
// ---------------------------------------------------------------------------

describe("matchFixture — sequenceIndex", () => {
  it("matches when matchCounts equals sequenceIndex", () => {
    const fixture = makeFixture({ userMessage: "hello", sequenceIndex: 0 });
    const counts = new Map<Fixture, number>();
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    expect(matchFixture([fixture], req, counts)).toBe(fixture);
  });

  it("skips when matchCounts does not equal sequenceIndex", () => {
    const fixture = makeFixture({ userMessage: "hello", sequenceIndex: 0 });
    const counts = new Map<Fixture, number>([[fixture, 1]]);
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    expect(matchFixture([fixture], req, counts)).toBeNull();
  });

  it("falls through to next fixture when sequenceIndex does not match", () => {
    const seq0 = makeFixture({ userMessage: "hello", sequenceIndex: 0 }, { content: "first" });
    const fallback = makeFixture({ userMessage: "hello" }, { content: "fallback" });
    const counts = new Map<Fixture, number>([[seq0, 1]]);
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    expect(matchFixture([seq0, fallback], req, counts)).toBe(fallback);
  });

  it("matches second fixture in sequence when count is 1", () => {
    const seq0 = makeFixture({ userMessage: "hello", sequenceIndex: 0 }, { content: "first" });
    const seq1 = makeFixture({ userMessage: "hello", sequenceIndex: 1 }, { content: "second" });
    // Both fixtures have count 1 (as they would after the first match increments the group)
    const counts = new Map<Fixture, number>([
      [seq0, 1],
      [seq1, 1],
    ]);
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    // seq0 skipped (count 1 != sequenceIndex 0), seq1 matches (count 1 == sequenceIndex 1)
    expect(matchFixture([seq0, seq1], req, counts)).toBe(seq1);
  });

  it("sequenceIndex is ignored when matchCounts is not provided", () => {
    const fixture = makeFixture({ userMessage: "hello", sequenceIndex: 5 });
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    // Without matchCounts, sequenceIndex check is skipped entirely
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("undefined sequenceIndex always matches regardless of matchCounts", () => {
    const fixture = makeFixture({ userMessage: "hello" });
    const counts = new Map<Fixture, number>([[fixture, 42]]);
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    expect(matchFixture([fixture], req, counts)).toBe(fixture);
  });
});

// ---------------------------------------------------------------------------
// matchFixture — turnIndex
// ---------------------------------------------------------------------------

describe("matchFixture — turnIndex", () => {
  it("matches when assistant message count equals turnIndex", () => {
    const fixture = makeFixture({ userMessage: "hello", turnIndex: 1 });
    const req = makeReq({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "hello" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("a uniquely content-matching fixture matches even when the assistant count differs from turnIndex (content-anchored)", () => {
    // turnIndex is a non-fatal disambiguator on replay: a fixture that is the
    // ONLY content match must not be rejected because the request has an extra
    // (or missing) assistant bubble vs the fixture's hardcoded turnIndex. This
    // is the false-red ("empty assistant response") this matcher fixes —
    // multi-step agents emit several assistant bubbles per logical turn.
    const fixture = makeFixture({ userMessage: "hello", turnIndex: 2 });
    const req = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "hello" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("turnIndex 0 matches when no assistant messages present", () => {
    const fixture = makeFixture({ userMessage: "hello", turnIndex: 0 });
    const req = makeReq({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("selects correct fixture from turnIndex sequence", () => {
    const turn0 = makeFixture({ userMessage: "hello", turnIndex: 0 }, { content: "turn-0" });
    const turn1 = makeFixture({ userMessage: "hello", turnIndex: 1 }, { content: "turn-1" });
    const turn2 = makeFixture({ userMessage: "hello", turnIndex: 2 }, { content: "turn-2" });

    const req0 = makeReq({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(matchFixture([turn0, turn1, turn2], req0)).toBe(turn0);

    const req1 = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "hello" },
      ],
    });
    expect(matchFixture([turn0, turn1, turn2], req1)).toBe(turn1);

    const req2 = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply1" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply2" },
        { role: "user", content: "hello" },
      ],
    });
    expect(matchFixture([turn0, turn1, turn2], req2)).toBe(turn2);
  });

  it("a scripted turn at/before the assistant count wins over an unpositioned fallback (closest-turn disambiguation)", () => {
    // Two content matches: a turnIndex:0 fixture and an unpositioned fallback.
    // With assistantCount = 2, turnIndex:0 is the closest scripted turn at or
    // before the conversation, so it disambiguates and wins. An overshooting
    // run lands on the nearest scripted turn rather than missing (the
    // content-anchored replacement for the old exact-equality fall-through).
    const turnOnly = makeFixture({ userMessage: "hello", turnIndex: 0 }, { content: "turn-0" });
    const fallback = makeFixture({ userMessage: "hello" }, { content: "fallback" });
    const req = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply1" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply2" },
        { role: "user", content: "hello" },
      ],
    });
    expect(matchFixture([turnOnly, fallback], req)).toBe(turnOnly);
  });

  it("an unpositioned fallback wins when every scripted turn is still AHEAD of the conversation", () => {
    // assistantCount = 0 but the only turnIndexed candidate is turnIndex:1.
    // A future scripted turn must not answer an earlier point in the
    // conversation, so the unpositioned fallback wins.
    const futureTurn = makeFixture({ userMessage: "hello", turnIndex: 1 }, { content: "turn-1" });
    const fallback = makeFixture({ userMessage: "hello" }, { content: "fallback" });
    const req = makeReq({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(matchFixture([futureTurn, fallback], req)).toBe(fallback);
  });
});

// ---------------------------------------------------------------------------
// matchFixture — hasToolResult
// ---------------------------------------------------------------------------

describe("matchFixture — hasToolResult", () => {
  // hasToolResult is TURN-SCOPED: it asks whether the CURRENT turn (messages
  // after the last user message) contains a tool result — not whether the whole
  // conversation ever did. This is what lets the leg-1 (tool call) / leg-2
  // (post-tool narration) fixture pair keep discriminating across MULTI-TURN
  // sessions: on the 2nd+ user turn the request still carries earlier turns'
  // tool results, and a whole-conversation check would pin hasToolResult=true
  // forever so the turn's leg-1 fixture (false) could never match again.

  it("matches hasToolResult: true when the current turn has a tool result", () => {
    const fixture = makeFixture({ userMessage: "hello", hasToolResult: true });
    // Real leg-2 shape: the tool result is the LAST message (no new user turn).
    const req = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "calling tool" },
        { role: "tool", content: "tool output" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("skips hasToolResult: true when no tool messages present", () => {
    const fixture = makeFixture({ userMessage: "hello", hasToolResult: true });
    const req = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "hello" },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches hasToolResult: false when no tool messages present", () => {
    const fixture = makeFixture({ userMessage: "hello", hasToolResult: false });
    const req = makeReq({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("skips hasToolResult: false when the current turn has a tool result", () => {
    const fixture = makeFixture({ userMessage: "hello", hasToolResult: false });
    // Real leg-2 shape: tool result is the last message in the current turn.
    const req = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "calling tool" },
        { role: "tool", content: "tool output" },
      ],
    });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches hasToolResult: false on a new turn even when an EARLIER turn had a tool result (multi-turn)", () => {
    // The regression this scoping fixes: a 2nd pill click in the same chat
    // thread. The request carries turn-1's tool result, but the CURRENT turn
    // (after the last user message) has none, so leg-1 (false) must still match.
    const fixture = makeFixture({ userMessage: "hello", hasToolResult: false });
    const req = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "calling tool" },
        { role: "tool", content: "prior-turn tool output" },
        { role: "user", content: "hello" },
      ],
    });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("discriminates 2-step HITL flow with hasToolResult across turns", () => {
    const beforeTool = makeFixture(
      { userMessage: "hello", hasToolResult: false },
      { content: "before-tool" },
    );
    const afterTool = makeFixture(
      { userMessage: "hello", hasToolResult: true },
      { content: "after-tool" },
    );

    // Turn 1, leg 1: fresh user message, no tool yet.
    const reqBefore = makeReq({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(matchFixture([beforeTool, afterTool], reqBefore)).toBe(beforeTool);

    // Turn 1, leg 2: the tool result is the last message in the current turn.
    const reqAfter = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "calling tool" },
        { role: "tool", content: "result" },
      ],
    });
    expect(matchFixture([beforeTool, afterTool], reqAfter)).toBe(afterTool);

    // Turn 2, leg 1: a new user message after turn-1's completed tool flow —
    // must fall back to the leg-1 fixture, not re-serve leg-2's narration.
    const reqNextTurn = makeReq({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "calling tool" },
        { role: "tool", content: "result" },
        { role: "assistant", content: "before-tool" },
        { role: "user", content: "hello" },
      ],
    });
    expect(matchFixture([beforeTool, afterTool], reqNextTurn)).toBe(beforeTool);
  });
});

// ---------------------------------------------------------------------------
// matchFixture — context matching
// ---------------------------------------------------------------------------

describe("matchFixture — context matching", () => {
  it("matches fixture with matching context", () => {
    const fixture = makeFixture({ context: "foo" });
    const req = makeReq({ _context: "foo" });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("skips fixture with non-matching context", () => {
    const fixture = makeFixture({ context: "foo" });
    const req = makeReq({ _context: "bar" });
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("matches fixture without context regardless of request context", () => {
    const fixture = makeFixture({});
    const req = makeReq({ _context: "bar" });
    expect(matchFixture([fixture], req)).toBe(fixture);
  });

  it("skips context fixture when request has no context", () => {
    const fixture = makeFixture({ context: "foo" });
    const req = makeReq();
    expect(matchFixture([fixture], req)).toBeNull();
  });

  it("context fixture wins over shared when listed first", () => {
    const contextual = makeFixture({ context: "foo" }, { content: "contextual" });
    const shared = makeFixture({}, { content: "shared" });
    const req = makeReq({ _context: "foo" });
    expect(matchFixture([contextual, shared], req)).toBe(contextual);
  });
});

// ---------------------------------------------------------------------------
// matchFixture — first-match-wins
// ---------------------------------------------------------------------------

describe("matchFixture — first-match-wins", () => {
  it("returns the first matching fixture when multiple could match", () => {
    const first = makeFixture({ userMessage: "hello" }, { content: "first" });
    const second = makeFixture({ userMessage: "hello" }, { content: "second" });
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    expect(matchFixture([first, second], req)).toBe(first);
  });

  it("skips non-matching fixtures to find the first match", () => {
    const noMatch = makeFixture({ userMessage: "goodbye" }, { content: "wrong" });
    const match = makeFixture({ userMessage: "hello" }, { content: "right" });
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    expect(matchFixture([noMatch, match], req)).toBe(match);
  });
});

// ---------------------------------------------------------------------------
// Item 1 — null-vs-"" empty-body matching
// ---------------------------------------------------------------------------

describe("getLastUserText — empty-string user message", () => {
  it("returns '' for an explicit empty-text user message", () => {
    expect(getLastUserText([{ role: "user", content: "" }])).toBe("");
  });
  it("still skips a trailing attachment-only (null-text) user message", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "describe this" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] as ContentPart[] },
    ];
    expect(getLastUserText(msgs)).toBe("describe this");
  });
  it("returns null when no user message has any text part", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] as ContentPart[] },
    ];
    expect(getLastUserText(msgs)).toBeNull();
  });
});

describe("matchFixture — empty userMessage", () => {
  it("matches userMessage:'' against an empty user message (exact)", () => {
    const fx = makeFixture({ userMessage: "" });
    const req = makeReq({ messages: [{ role: "user", content: "" }] });
    expect(matchFixture([fx], req, undefined, (r) => r)).toBe(fx);
  });
  it("matches userMessage:/^$/ against an empty user message", () => {
    const fx = makeFixture({ userMessage: /^$/ });
    const req = makeReq({ messages: [{ role: "user", content: "" }] });
    expect(matchFixture([fx], req)).toBe(fx);
  });
  it("does NOT match empty userMessage against a non-empty message", () => {
    const fx = makeFixture({ userMessage: "" });
    const req = makeReq({ messages: [{ role: "user", content: "hello" }] });
    expect(matchFixture([fx], req, undefined, (r) => r)).toBeNull();
  });
  it("truly-absent user text still skips (attachment-only turn, no fixture match)", () => {
    const fx = makeFixture({ userMessage: "" });
    const req = makeReq({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "x" } }] as ContentPart[],
        },
      ],
    });
    expect(matchFixture([fx], req, undefined, (r) => r)).toBeNull();
  });
});

describe("matchFixture — empty inputText", () => {
  it("matches inputText:'' against embeddingInput:'' (exact)", () => {
    const fx = makeFixture({ inputText: "" }, { embedding: [0.1] });
    const req = makeReq({ embeddingInput: "" });
    expect(matchFixture([fx], req, undefined, (r) => r)).toBe(fx);
  });
  it("matches inputText:/^$/ against embeddingInput:''", () => {
    const fx = makeFixture({ inputText: /^$/ }, { embedding: [0.1] });
    const req = makeReq({ embeddingInput: "" });
    expect(matchFixture([fx], req)).toBe(fx);
  });
  it("skips when embeddingInput is undefined (absent)", () => {
    const fx = makeFixture({ inputText: "" }, { embedding: [0.1] });
    const req = makeReq({});
    expect(matchFixture([fx], req, undefined, (r) => r)).toBeNull();
  });
});

describe("matchFixture — systemMessage empty behavior unchanged", () => {
  it("systemMessage:'' does NOT match a request with no system message (documented catch-all avoidance)", () => {
    const fx = makeFixture({ systemMessage: "" });
    const req = makeReq({ messages: [{ role: "user", content: "hi" }] });
    expect(matchFixture([fx], req, undefined, (r) => r)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 3 — matcher must not mutate caller-supplied RegExp lastIndex
// ---------------------------------------------------------------------------

describe("matchFixture — does not mutate caller's RegExp lastIndex", () => {
  it("leaves a /g userMessage regex lastIndex at 0 after a match", () => {
    const re = /hello/g;
    const fx = makeFixture({ userMessage: re });
    matchFixture([fx], makeReq({ messages: [{ role: "user", content: "hello" }] }));
    expect(re.lastIndex).toBe(0);
  });
  it("a /g regex reused across TWO match calls matches BOTH times (no leaked lastIndex)", () => {
    const re = /world/g;
    const fx = makeFixture({ userMessage: re });
    const req = makeReq({ messages: [{ role: "user", content: "world" }] });
    // Advance the caller's own lastIndex the way an external re.exec would:
    re.exec("world world"); // lastIndex now > 0
    expect(matchFixture([fx], req)).toBe(fx);
    re.exec("world world");
    expect(matchFixture([fx], req)).toBe(fx);
  });
  it("does not clobber the caller's mid-scan lastIndex (userMessage /g)", () => {
    const re = /a/g;
    re.exec("aaa"); // caller mid-scan, lastIndex === 1
    const fx = makeFixture({ userMessage: re });
    matchFixture([fx], makeReq({ messages: [{ role: "user", content: "a" }] }));
    expect(re.lastIndex).toBe(1);
  });
  it("systemMessage /g regex lastIndex preserved", () => {
    const re = /ctx/g;
    re.exec("ctx ctx");
    const before = re.lastIndex;
    matchFixture(
      [makeFixture({ systemMessage: re })],
      makeReq({
        messages: [
          { role: "system", content: "ctx" },
          { role: "user", content: "x" },
        ],
      }),
    );
    expect(re.lastIndex).toBe(before);
  });
  it("inputText /g regex lastIndex preserved", () => {
    const re = /q/g;
    re.exec("q q");
    const before = re.lastIndex;
    matchFixture(
      [makeFixture({ inputText: re }, { embedding: [0.1] })],
      makeReq({ embeddingInput: "q" }),
    );
    expect(re.lastIndex).toBe(before);
  });
  it("model /g regex lastIndex preserved", () => {
    const re = /gpt/g;
    re.exec("gpt gpt");
    const before = re.lastIndex;
    matchFixture([makeFixture({ model: re })], makeReq({ model: "gpt-4o" }));
    expect(re.lastIndex).toBe(before);
  });
});
