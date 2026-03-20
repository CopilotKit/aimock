import { describe, it, expect } from "vitest";
import { matchFixture, getLastMessageByRole, getTextContent } from "../router.js";
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

  it("returns null for array with only empty-string text parts", () => {
    const parts: ContentPart[] = [{ type: "text", text: "" }];
    expect(getTextContent(parts)).toBeNull();
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

  it("does not match when the model string differs", () => {
    const fixture = makeFixture({ model: "gpt-4o" });
    const req = makeReq({ model: "gpt-4o-mini" });
    expect(matchFixture([fixture], req)).toBeNull();
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
