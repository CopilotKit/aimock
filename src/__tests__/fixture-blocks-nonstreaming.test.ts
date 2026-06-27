/**
 * F2 (#274) — NON-streaming `blocks` ordering for order-observable surfaces.
 *
 * When a combined content+toolCalls fixture sets the optional `blocks` field,
 * the non-streaming builders for the three surfaces whose response body is a
 * positionally-observable ORDERED array MUST emit that array in block order:
 *
 *   - Claude  /v1/messages          → `content[]`            (text / tool_use)
 *   - Gemini  :generateContent      → `candidates[0].content.parts[]`
 *   - Responses /v1/responses       → `output[]`             (message / function_call)
 *
 * A `[toolCall, text]` fixture must therefore put the tool entry BEFORE the
 * text entry in each non-streaming array (the opposite of the legacy
 * text-first hardcoding). A fixture WITHOUT `blocks` must stay legacy
 * text-first (back-compat).
 *
 * Real mock-server surface (mirrors the streaming per-provider tests): an
 * actual `LLMock` listens, a real non-streaming HTTP request is made, and
 * assertions read the wire JSON body.
 */
import { describe, it, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import type { FixtureBlock } from "../types.js";

const TOOL_FIRST_BLOCKS: FixtureBlock[] = [
  { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
  { type: "text", text: "Here you go." },
];

describe("Non-streaming fixture block ordering (#274)", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  // ── Claude /v1/messages — content[] is order-observable ───────────────────
  describe("Claude /v1/messages", () => {
    async function postClaude(userMessage: string): Promise<{
      content: Array<{ type: string; text?: string; name?: string }>;
    }> {
      const res = await fetch(`${mock!.url}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          messages: [{ role: "user", content: userMessage }],
          stream: false,
        }),
      });
      return res.json() as Promise<{
        content: Array<{ type: string; text?: string; name?: string }>;
      }>;
    }

    it("tool-first blocks: content[] leads with tool_use, then text", async () => {
      mock = new LLMock({ port: 0 });
      mock.addFixture({
        match: { userMessage: "claude nonstream tool-first" },
        response: {
          content: "Here you go.",
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          blocks: TOOL_FIRST_BLOCKS,
        },
      });
      await mock.start();

      const body = await postClaude("claude nonstream tool-first");
      const types = body.content.map((b) => b.type);
      expect(types.indexOf("tool_use")).toBeLessThan(types.indexOf("text"));
      expect(types[0]).toBe("tool_use");
      expect(body.content[0].name).toBe("get_weather");
      expect(body.content[1].text).toBe("Here you go.");
    });

    it("back-compat: no blocks keeps legacy text-first content[]", async () => {
      mock = new LLMock({ port: 0 });
      mock.addFixture({
        match: { userMessage: "claude nonstream no-blocks" },
        response: {
          content: "Sure.",
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        },
      });
      await mock.start();

      const body = await postClaude("claude nonstream no-blocks");
      const types = body.content.map((b) => b.type);
      expect(types.indexOf("text")).toBeLessThan(types.indexOf("tool_use"));
      expect(types[0]).toBe("text");
    });
  });

  // ── Gemini :generateContent — parts[] is order-observable ─────────────────
  describe("Gemini :generateContent", () => {
    async function postGemini(userMessage: string): Promise<{
      candidates: Array<{
        content: { parts: Array<{ text?: string; functionCall?: { name: string } }> };
      }>;
    }> {
      const res = await fetch(`${mock!.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
        }),
      });
      return res.json() as Promise<{
        candidates: Array<{
          content: { parts: Array<{ text?: string; functionCall?: { name: string } }> };
        }>;
      }>;
    }

    it("tool-first blocks: parts[] leads with functionCall, then text", async () => {
      mock = new LLMock({ port: 0 });
      mock.addFixture({
        match: { userMessage: "gemini nonstream tool-first" },
        response: {
          content: "Here you go.",
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          blocks: TOOL_FIRST_BLOCKS,
        },
      });
      await mock.start();

      const body = await postGemini("gemini nonstream tool-first");
      const parts = body.candidates[0].content.parts;
      const fcIdx = parts.findIndex((p) => p.functionCall);
      const textIdx = parts.findIndex((p) => typeof p.text === "string" && !("thought" in p));
      expect(fcIdx).toBeGreaterThanOrEqual(0);
      expect(textIdx).toBeGreaterThanOrEqual(0);
      expect(fcIdx).toBeLessThan(textIdx);
      expect(parts[0].functionCall?.name).toBe("get_weather");
    });

    it("back-compat: no blocks keeps legacy text-first parts[]", async () => {
      mock = new LLMock({ port: 0 });
      mock.addFixture({
        match: { userMessage: "gemini nonstream no-blocks" },
        response: {
          content: "Sure.",
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        },
      });
      await mock.start();

      const body = await postGemini("gemini nonstream no-blocks");
      const parts = body.candidates[0].content.parts;
      const fcIdx = parts.findIndex((p) => p.functionCall);
      const textIdx = parts.findIndex((p) => typeof p.text === "string");
      expect(textIdx).toBeLessThan(fcIdx);
      expect(parts[0].text).toBe("Sure.");
    });
  });

  // ── OpenAI Responses /v1/responses — output[] is order-observable ─────────
  describe("OpenAI Responses /v1/responses", () => {
    async function postResponses(userMessage: string): Promise<{
      output: Array<{ type: string; name?: string }>;
    }> {
      const res = await fetch(`${mock!.url}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({
          model: "gpt-4o",
          input: [{ role: "user", content: userMessage }],
          stream: false,
        }),
      });
      return res.json() as Promise<{ output: Array<{ type: string; name?: string }> }>;
    }

    it("tool-first blocks: output[] leads with function_call, then message", async () => {
      mock = new LLMock({ port: 0 });
      mock.addFixture({
        match: { userMessage: "responses nonstream tool-first" },
        response: {
          content: "Here you go.",
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          blocks: TOOL_FIRST_BLOCKS,
        },
      });
      await mock.start();

      const body = await postResponses("responses nonstream tool-first");
      const types = body.output.map((o) => o.type);
      expect(types.indexOf("function_call")).toBeLessThan(types.indexOf("message"));
      expect(types[0]).toBe("function_call");
      expect(body.output[0].name).toBe("get_weather");
    });

    it("back-compat: no blocks keeps legacy message-first output[]", async () => {
      mock = new LLMock({ port: 0 });
      mock.addFixture({
        match: { userMessage: "responses nonstream no-blocks" },
        response: {
          content: "Sure.",
          toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
        },
      });
      await mock.start();

      const body = await postResponses("responses nonstream no-blocks");
      const types = body.output.map((o) => o.type);
      expect(types.indexOf("message")).toBeLessThan(types.indexOf("function_call"));
      expect(types[0]).toBe("message");
    });
  });
});
