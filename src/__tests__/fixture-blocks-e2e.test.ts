/**
 * #274 slot T3 — END-TO-END integration for ordered `blocks`.
 *
 * Unlike the per-provider builder tests (which construct an in-memory fixture
 * and call `mock.addFixture(...)`), this suite proves the FULL pipeline works
 * for a REAL on-disk JSON fixture: a `.json` file is written to a temp dir,
 * loaded THROUGH THE REAL LOADER via `mock.loadFixtureFile(...)`, served by a
 * live `LLMock` HTTP server, and the wire bytes are asserted.
 *
 * This closes the loader→builder→dispatch loop for the two providers whose
 * wire format can FULLY express tool-first ordering (Anthropic typed content
 * blocks; OpenAI Responses output_index sequencing). A blocks-bearing fixture
 * with `[toolCall, text]` must stream the tool BEFORE the text on both.
 *
 * A back-compat guard rounds out the suite: a legacy `{content, toolCalls}`
 * fixture (no `blocks`) must still stream message/text FIRST — confirming the
 * branch-not-replace design leaves the legacy path untouched end-to-end.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";

// ─── SSE parsers (mirror content-with-toolcalls.test.ts) ─────────────────────

function parseAnthropicSSEEvents(body: string): Array<{ type: string; [key: string]: unknown }> {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      return JSON.parse(dataLine.slice(6)) as { type: string; [key: string]: unknown };
    })
    .filter(Boolean) as Array<{ type: string; [key: string]: unknown }>;
}

function parseResponsesSSEEvents(body: string): Array<{ type: string; [key: string]: unknown }> {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      return JSON.parse(dataLine.slice(6)) as { type: string; [key: string]: unknown };
    })
    .filter(Boolean) as Array<{ type: string; [key: string]: unknown }>;
}

// ─── Tmp dir + real-loader fixture file ──────────────────────────────────────

let tmpDir: string;
let mock: LLMock | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fixture-blocks-e2e-"));
});

afterEach(async () => {
  if (mock) {
    await mock.stop();
    mock = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a fixtures JSON file to the temp dir and return its path. */
function writeFixtureFile(name: string, content: unknown): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, JSON.stringify(content), "utf-8");
  return filePath;
}

describe("#274 e2e: ordered blocks loaded through the REAL JSON loader", () => {
  it("Anthropic streams tool_use BEFORE text for a tool-first blocks .json fixture", async () => {
    // A real on-disk JSON fixture with tool-first `blocks`. The legacy
    // text-first {content, toolCalls} shape cannot express this ordering.
    const filePath = writeFixtureFile("anthropic-tool-first.json", {
      fixtures: [
        {
          match: { userMessage: "e2e anthropic tool-first" },
          response: {
            content: "Here you go.",
            toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
            blocks: [
              { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
              { type: "text", text: "Here you go." },
            ],
          },
        },
      ],
    });

    mock = new LLMock({ port: 0 });
    // THE REAL LOADER: reads + parses + normalizes the .json from disk.
    mock.loadFixtureFile(filePath);
    await mock.start();

    const res = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "e2e anthropic tool-first" }],
        stream: true,
      }),
    });

    const events = parseAnthropicSSEEvents(await res.text());

    const textBlockStart = events.find(
      (e) =>
        e.type === "content_block_start" && (e.content_block as { type: string })?.type === "text",
    );
    const toolBlockStart = events.find(
      (e) =>
        e.type === "content_block_start" &&
        (e.content_block as { type: string })?.type === "tool_use",
    );
    expect(textBlockStart).toBeDefined();
    expect(toolBlockStart).toBeDefined();

    // Tool-first: the tool_use content block precedes the text content block.
    const toolIdx = events.indexOf(toolBlockStart!);
    const textIdx = events.indexOf(textBlockStart!);
    expect(toolIdx).toBeLessThan(textIdx);

    const messageDelta = events.find((e) => e.type === "message_delta");
    expect((messageDelta!.delta as { stop_reason: string }).stop_reason).toBe("tool_use");
  });

  it("Responses assigns function_call output_index 0 for a tool-first blocks .json fixture", async () => {
    const filePath = writeFixtureFile("responses-tool-first.json", {
      fixtures: [
        {
          match: { userMessage: "e2e responses tool-first" },
          response: {
            content: "Here you go.",
            toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
            blocks: [
              { type: "toolCall", name: "get_weather", arguments: '{"city":"NYC"}' },
              { type: "text", text: "Here you go." },
            ],
          },
        },
      ],
    });

    mock = new LLMock({ port: 0 });
    mock.loadFixtureFile(filePath);
    await mock.start();

    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [{ role: "user", content: "e2e responses tool-first" }],
        stream: true,
      }),
    });

    const events = parseResponsesSSEEvents(await res.text());

    const fcAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "function_call",
    );
    const msgAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" && (e.item as { type: string })?.type === "message",
    );
    expect(fcAdded).toBeDefined();
    expect(msgAdded).toBeDefined();
    expect((fcAdded as unknown as { output_index: number }).output_index).toBe(0);
    expect((msgAdded as unknown as { output_index: number }).output_index).toBe(1);

    const completed = events.find((e) => e.type === "response.completed");
    const output = (completed!.response as { output: Array<{ type: string }> }).output;
    const types = output.map((o) => o.type);
    expect(types[0]).toBe("function_call");
    expect(types.indexOf("function_call")).toBeLessThan(types.indexOf("message"));
  });

  // ── BACK-COMPAT guard: a legacy {content, toolCalls} fixture (NO blocks)
  //    loaded through the real loader must still stream message/text FIRST.
  //    Proves branch-not-replace leaves the legacy path untouched end-to-end. ──
  it("legacy .json fixture WITHOUT blocks keeps message-first ordering on Responses", async () => {
    const filePath = writeFixtureFile("responses-legacy.json", {
      fixtures: [
        {
          match: { userMessage: "e2e responses legacy" },
          response: {
            content: "Sure.",
            toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}' }],
          },
        },
      ],
    });

    mock = new LLMock({ port: 0 });
    mock.loadFixtureFile(filePath);
    await mock.start();

    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [{ role: "user", content: "e2e responses legacy" }],
        stream: true,
      }),
    });

    const events = parseResponsesSSEEvents(await res.text());

    const msgAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" && (e.item as { type: string })?.type === "message",
    );
    const fcAdded = events.find(
      (e) =>
        e.type === "response.output_item.added" &&
        (e.item as { type: string })?.type === "function_call",
    );
    // Legacy hardcoding: message at index 0, function_call at index 1.
    expect((msgAdded as unknown as { output_index: number }).output_index).toBe(0);
    expect((fcAdded as unknown as { output_index: number }).output_index).toBe(1);

    const completed = events.find((e) => e.type === "response.completed");
    const output = (completed!.response as { output: Array<{ type: string }> }).output;
    const types = output.map((o) => o.type);
    expect(types.indexOf("message")).toBeLessThan(types.indexOf("function_call"));
  });
});
