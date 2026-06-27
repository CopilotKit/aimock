import { describe, it, expect } from "vitest";
import { entryToFixture } from "../fixture-loader.js";
import type { FixtureFileEntry, ContentWithToolCallsResponse, FixtureBlock } from "../types.js";

/* ------------------------------------------------------------------ *
 * #274 slot T1f — JSON fixture loader carries `blocks`.              *
 *                                                                    *
 * T0 added the optional `blocks?: FixtureBlock[]` to the IN-MEMORY   *
 * ContentWithToolCallsResponse. These tests pin that an ON-DISK JSON *
 * fixture carrying `blocks` survives the loader normalization, that  *
 * a toolCall block's object `arguments` is auto-stringified just     *
 * like the sibling top-level `toolCalls[].arguments`, and that a     *
 * fixture with no `blocks` key loads byte-identically to before.    *
 * ------------------------------------------------------------------ */

describe("#274 fixture loader carries blocks", () => {
  it("carries a tool-first blocks array through into the in-memory response, in order", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "do it" },
      response: {
        content: "Done.",
        toolCalls: [{ name: "search", arguments: '{"q":"weather"}' }],
        // tool-first ordering that the legacy text-first shape cannot express
        blocks: [
          { type: "toolCall", name: "search", arguments: '{"q":"weather"}' },
          { type: "text", text: "Done." },
        ],
      } as FixtureFileEntry["response"],
    };

    const fixture = entryToFixture(entry);
    const resp = fixture.response as ContentWithToolCallsResponse;

    expect(resp.blocks).toBeDefined();
    expect(resp.blocks).toHaveLength(2);
    expect(resp.blocks?.[0]).toEqual({
      type: "toolCall",
      name: "search",
      arguments: '{"q":"weather"}',
    });
    expect(resp.blocks?.[1]).toEqual({ type: "text", text: "Done." });
    // Order preserved exactly as authored.
    expect((resp.blocks as FixtureBlock[]).map((b) => b.type)).toEqual(["toolCall", "text"]);
  });

  it("auto-stringifies object arguments inside a toolCall block (mirrors toolCalls[].arguments)", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "do it" },
      response: {
        content: "ok",
        toolCalls: [{ name: "save", arguments: { id: 1 } }],
        blocks: [
          { type: "toolCall", name: "save", arguments: { id: 1, nested: { a: [1, 2] } } },
          { type: "text", text: "ok" },
        ],
      } as unknown as FixtureFileEntry["response"],
    };

    const fixture = entryToFixture(entry);
    const resp = fixture.response as ContentWithToolCallsResponse;
    const block = resp.blocks?.[0] as { type: "toolCall"; arguments: string };

    expect(typeof block.arguments).toBe("string");
    expect(block.arguments).toBe('{"id":1,"nested":{"a":[1,2]}}');
  });

  it("leaves string arguments inside a toolCall block unchanged", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "do it" },
      response: {
        content: "ok",
        toolCalls: [{ name: "save", arguments: '{"id":1}' }],
        blocks: [{ type: "toolCall", name: "save", arguments: '{"id":1}' }],
      } as FixtureFileEntry["response"],
    };

    const fixture = entryToFixture(entry);
    const resp = fixture.response as ContentWithToolCallsResponse;
    const block = resp.blocks?.[0] as { type: "toolCall"; arguments: string };
    expect(block.arguments).toBe('{"id":1}');
  });

  it("leaves text blocks unchanged", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "do it" },
      response: {
        content: "Hello",
        toolCalls: [{ name: "noop", arguments: "{}" }],
        blocks: [{ type: "text", text: "Hello" }],
      } as FixtureFileEntry["response"],
    };

    const fixture = entryToFixture(entry);
    const resp = fixture.response as ContentWithToolCallsResponse;
    expect(resp.blocks?.[0]).toEqual({ type: "text", text: "Hello" });
  });

  it("back-compat: a fixture WITHOUT blocks loads identically (blocks stays undefined)", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "legacy" },
      response: {
        content: "Legacy answer.",
        toolCalls: [{ name: "search", arguments: '{"q":"x"}' }],
      },
    };

    const fixture = entryToFixture(entry);
    const resp = fixture.response as ContentWithToolCallsResponse;

    expect(resp.blocks).toBeUndefined();
    expect("blocks" in resp).toBe(false);
    expect(resp.content).toBe("Legacy answer.");
    expect(resp.toolCalls).toEqual([{ name: "search", arguments: '{"q":"x"}' }]);
  });

  it("ignores a non-array blocks value rather than corrupting the response", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "bad" },
      response: {
        content: "ok",
        toolCalls: [{ name: "noop", arguments: "{}" }],
        // malformed: blocks is not an array — loader leaves it as-is (no normalization),
        // mirroring how toolCalls normalization is gated on Array.isArray.
        blocks: "not-an-array",
      } as unknown as FixtureFileEntry["response"],
    };

    const fixture = entryToFixture(entry);
    const resp = fixture.response as ContentWithToolCallsResponse & { blocks?: unknown };
    // Non-array blocks pass through untouched (no stringify attempt, no crash);
    // downstream validation/builders own shape rejection.
    expect(resp.blocks).toBe("not-an-array");
  });
});
