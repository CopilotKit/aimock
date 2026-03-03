import { describe, it, expect } from "vitest";
import {
  generateId,
  generateToolCallId,
  isTextResponse,
  isToolCallResponse,
  isErrorResponse,
  buildTextChunks,
  buildToolCallChunks,
} from "../helpers.js";

describe("generateId", () => {
  it("generates IDs with default prefix", () => {
    const id = generateId();
    expect(id).toMatch(/^chatcmpl-/);
    expect(id.length).toBeGreaterThan(10);
  });

  it("generates IDs with custom prefix", () => {
    const id = generateId("test");
    expect(id).toMatch(/^test-/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateToolCallId", () => {
  it("generates tool call IDs with call_ prefix", () => {
    const id = generateToolCallId();
    expect(id).toMatch(/^call_/);
  });
});

describe("type guards", () => {
  it("isTextResponse identifies text responses", () => {
    expect(isTextResponse({ content: "hello" })).toBe(true);
    expect(isTextResponse({ toolCalls: [] })).toBe(false);
    expect(isTextResponse({ error: { message: "fail" } })).toBe(false);
  });

  it("isToolCallResponse identifies tool call responses", () => {
    expect(isToolCallResponse({ toolCalls: [{ name: "x", arguments: "{}" }] })).toBe(true);
    expect(isToolCallResponse({ content: "hello" })).toBe(false);
  });

  it("isErrorResponse identifies error responses", () => {
    expect(isErrorResponse({ error: { message: "fail" } })).toBe(true);
    expect(isErrorResponse({ content: "hello" })).toBe(false);
  });
});

describe("buildTextChunks", () => {
  it("produces role + content + finish chunks", () => {
    const chunks = buildTextChunks("Hi", "gpt-4", 10);
    expect(chunks.length).toBe(3); // role + "Hi" + finish

    // Role chunk
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[0].choices[0].delta.content).toBe("");
    expect(chunks[0].choices[0].finish_reason).toBeNull();

    // Content chunk
    expect(chunks[1].choices[0].delta.content).toBe("Hi");
    expect(chunks[1].choices[0].finish_reason).toBeNull();

    // Finish chunk
    expect(chunks[2].choices[0].delta).toEqual({});
    expect(chunks[2].choices[0].finish_reason).toBe("stop");
  });

  it("chunks content according to chunkSize", () => {
    const chunks = buildTextChunks("Hello World!", "gpt-4", 5);
    // role + "Hello" + " Worl" + "d!" + finish = 5 chunks
    expect(chunks.length).toBe(5);
    expect(chunks[1].choices[0].delta.content).toBe("Hello");
    expect(chunks[2].choices[0].delta.content).toBe(" Worl");
    expect(chunks[3].choices[0].delta.content).toBe("d!");
  });

  it("all chunks share the same id", () => {
    const chunks = buildTextChunks("test", "gpt-4", 2);
    const ids = new Set(chunks.map((c) => c.id));
    expect(ids.size).toBe(1);
  });

  it("sets model on all chunks", () => {
    const chunks = buildTextChunks("x", "gpt-4o-mini", 10);
    for (const chunk of chunks) {
      expect(chunk.model).toBe("gpt-4o-mini");
    }
  });

  it("produces role + finish with no content chunks for empty string", () => {
    const chunks = buildTextChunks("", "gpt-4", 20);
    expect(chunks.length).toBe(2); // role + finish only

    // Role chunk
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[0].choices[0].delta.content).toBe("");
    expect(chunks[0].choices[0].finish_reason).toBeNull();

    // Finish chunk
    expect(chunks[1].choices[0].delta).toEqual({});
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
  });

  it("produces a single content chunk for a single character", () => {
    const chunks = buildTextChunks("a", "gpt-4", 20);
    expect(chunks.length).toBe(3); // role + "a" + finish

    expect(chunks[1].choices[0].delta.content).toBe("a");
  });

  it("preserves unicode multibyte content through chunking and reassembly", () => {
    const chunks = buildTextChunks("Hello 🌍🎉", "gpt-4", 3);

    // Reassemble all content chunks — slice() splits on UTF-16 code units,
    // so individual chunks may contain lone surrogates, but concatenation
    // must reproduce the original string.
    const contentChunks = chunks.slice(1, -1); // skip role and finish
    const reassembled = contentChunks.map((c) => c.choices[0].delta.content).join("");
    expect(reassembled).toBe("Hello 🌍🎉");

    // "Hello 🌍🎉" is 10 UTF-16 code units, so ceil(10/3) = 4 content chunks
    expect(contentChunks.length).toBe(4);
  });

  it("produces a single content chunk when content is shorter than chunkSize", () => {
    const chunks = buildTextChunks("hi", "gpt-4", 100);
    expect(chunks.length).toBe(3); // role + "hi" + finish

    expect(chunks[1].choices[0].delta.content).toBe("hi");
  });
});

describe("buildToolCallChunks", () => {
  it("produces role + tool call + args + finish chunks", () => {
    const chunks = buildToolCallChunks(
      [{ name: "get_weather", arguments: '{"loc":"SF"}' }],
      "gpt-4",
      50,
    );
    // role + initial tool call + args (fits in one chunk) + finish = 4
    expect(chunks.length).toBe(4);

    // Role chunk
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[0].choices[0].delta.content).toBeNull();

    // Tool call initial
    const tc = chunks[1].choices[0].delta.tool_calls;
    expect(tc).toBeDefined();
    expect(tc![0].id).toMatch(/^call_/);
    expect(tc![0].type).toBe("function");
    expect(tc![0].function?.name).toBe("get_weather");

    // Args chunk
    const args = chunks[2].choices[0].delta.tool_calls;
    expect(args![0].function?.arguments).toBe('{"loc":"SF"}');

    // Finish
    expect(chunks[3].choices[0].finish_reason).toBe("tool_calls");
  });

  it("streams arguments in chunks", () => {
    const chunks = buildToolCallChunks(
      [{ name: "fn", arguments: '{"a":"1234567890"}' }],
      "gpt-4",
      5,
    );
    // role + initial + 4 arg chunks (18 chars / 5 = 4) + finish = 7
    const argChunks = chunks.filter(
      (c) =>
        c.choices[0].delta.tool_calls?.[0].function?.arguments !== undefined &&
        c.choices[0].delta.tool_calls?.[0].function?.arguments !== "",
    );
    expect(argChunks.length).toBe(4);
    const reassembled = argChunks
      .map((c) => c.choices[0].delta.tool_calls![0].function!.arguments)
      .join("");
    expect(reassembled).toBe('{"a":"1234567890"}');
  });

  it("handles multiple tool calls", () => {
    const chunks = buildToolCallChunks(
      [
        { name: "fn1", arguments: "{}" },
        { name: "fn2", arguments: "{}" },
      ],
      "gpt-4",
      50,
    );
    // role + (initial1 + args1) + (initial2 + args2) + finish = 6
    // (each tool call: 1 initial chunk + 1 args chunk = 2, so 2*2 + role + finish = 6)
    expect(chunks.length).toBe(6);

    const initials = chunks.filter((c) => c.choices[0].delta.tool_calls?.[0]?.type === "function");
    expect(initials.length).toBe(2);
    expect(initials[0].choices[0].delta.tool_calls![0].index).toBe(0);
    expect(initials[1].choices[0].delta.tool_calls![0].index).toBe(1);
  });

  it("uses provided tool call IDs when given", () => {
    const chunks = buildToolCallChunks(
      [{ name: "fn", arguments: "{}", id: "call_custom123" }],
      "gpt-4",
      50,
    );
    const initial = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.id);
    expect(initial!.choices[0].delta.tool_calls![0].id).toBe("call_custom123");
  });

  it("handles empty arguments string with role + initial + finish", () => {
    const chunks = buildToolCallChunks(
      [{ name: "fn", arguments: "" }],
      "gpt-4",
      20,
    );
    // role + initial tool call chunk + finish = 3 (no arg chunks since args is empty)
    expect(chunks.length).toBe(3);

    // Role chunk
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[0].choices[0].delta.content).toBeNull();

    // Initial tool call chunk
    const tc = chunks[1].choices[0].delta.tool_calls;
    expect(tc).toBeDefined();
    expect(tc![0].function?.name).toBe("fn");
    expect(tc![0].function?.arguments).toBe("");

    // Finish chunk
    expect(chunks[2].choices[0].delta).toEqual({});
    expect(chunks[2].choices[0].finish_reason).toBe("tool_calls");
  });

  it("handles empty toolCalls array with role + finish only", () => {
    const chunks = buildToolCallChunks([], "gpt-4", 20);
    expect(chunks.length).toBe(2); // role + finish

    // Role chunk
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[0].choices[0].delta.content).toBeNull();
    expect(chunks[0].choices[0].finish_reason).toBeNull();

    // Finish chunk
    expect(chunks[1].choices[0].delta).toEqual({});
    expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
  });

  it("produces a single arg chunk when arguments are shorter than chunkSize", () => {
    const chunks = buildToolCallChunks(
      [{ name: "fn", arguments: '{"x":1}' }],
      "gpt-4",
      100,
    );
    // role + initial + 1 arg chunk + finish = 4
    expect(chunks.length).toBe(4);

    const argChunks = chunks.filter(
      (c) =>
        c.choices[0].delta.tool_calls?.[0].function?.arguments !== undefined &&
        c.choices[0].delta.tool_calls?.[0].function?.arguments !== "",
    );
    expect(argChunks.length).toBe(1);
    expect(argChunks[0].choices[0].delta.tool_calls![0].function!.arguments).toBe('{"x":1}');
  });
});
