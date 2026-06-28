/**
 * #274 F0 — BLOCKS-ONLY fixtures are FIRST-CLASS.
 *
 * A fixture written as `{ blocks: [...] }` with NO `content` and NO `toolCalls`
 * must be recognized, matched, and streamed in block order — exactly like a
 * combined `{content, toolCalls, blocks}` fixture, but without the redundant
 * legacy fields. Before F0, the recognizer required content+toolCalls, so a
 * blocks-only fixture fell through every guard and the server answered 500
 * ("no recognized response type" / no-match).
 *
 * This suite mirrors the `fixture-blocks-e2e.test.ts` harness: a REAL on-disk
 * JSON fixture is loaded THROUGH THE REAL LOADER (`mock.loadFixtureFile(...)`),
 * served by a live `LLMock` HTTP server, and the wire bytes are asserted. It
 * covers the two providers whose wire format can FULLY express tool-first
 * ordering: Anthropic typed content blocks and OpenAI Responses output_index
 * sequencing. A blocks-only `[toolCall, text]` fixture must (a) NOT 500 and
 * (b) stream the tool BEFORE the text.
 *
 * Back-compat for the existing content+toolCalls / text-only / tool-only shapes
 * is covered by the rest of the suite (notably fixture-blocks-e2e.test.ts's
 * legacy guard) and is intentionally not duplicated here.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";

function parseSSEEvents(body: string): Array<{ type: string; [key: string]: unknown }> {
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

let tmpDir: string;
let mock: LLMock | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fixture-blocks-only-"));
});

afterEach(async () => {
  if (mock) {
    await mock.stop();
    mock = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixtureFile(name: string, content: unknown): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, JSON.stringify(content), "utf-8");
  return filePath;
}

describe("#274 F0 e2e: blocks-only fixtures (no content/toolCalls) are first-class", () => {
  it("Anthropic recognizes a blocks-only fixture and streams tool_use BEFORE text", async () => {
    // BLOCKS-ONLY: no `content`, no `toolCalls` — only `blocks`.
    const filePath = writeFixtureFile("anthropic-blocks-only.json", {
      fixtures: [
        {
          match: { userMessage: "blocks-only anthropic tool-first" },
          response: {
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
        messages: [{ role: "user", content: "blocks-only anthropic tool-first" }],
        stream: true,
      }),
    });

    // RED before F0: the blocks-only fixture is unrecognized → no match → 500.
    expect(res.status).toBe(200);

    const events = parseSSEEvents(await res.text());

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

  it("Responses recognizes a blocks-only fixture and assigns function_call output_index 0", async () => {
    const filePath = writeFixtureFile("responses-blocks-only.json", {
      fixtures: [
        {
          match: { userMessage: "blocks-only responses tool-first" },
          response: {
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
        input: [{ role: "user", content: "blocks-only responses tool-first" }],
        stream: true,
      }),
    });

    // RED before F0: blocks-only is unrecognized → no match → 500.
    expect(res.status).toBe(200);

    const events = parseSSEEvents(await res.text());

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
});
