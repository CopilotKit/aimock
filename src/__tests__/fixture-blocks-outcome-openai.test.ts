import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";
import type { ChatCompletion, FixtureFileResponse, FixtureResponse, SSEChunk } from "../types.js";

let mock: LLMock | undefined;
let directory: string | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function request(
  response: FixtureResponse,
  stream: boolean,
  fileResponse?: FixtureFileResponse,
) {
  mock = new LLMock({ port: 0, latency: 0, chunkSize: 3 });
  const fixture = { match: { userMessage: "blocks outcome" }, response };
  if (fileResponse) {
    directory = mkdtempSync(join(tmpdir(), "blocks-outcome-"));
    const path = join(directory, "fixture.json");
    writeFileSync(path, JSON.stringify({ fixtures: [{ ...fixture, response: fileResponse }] }));
    mock.loadFixtureFile(path);
  } else mock.addFixture(fixture);
  await mock.start();
  return fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "blocks outcome" }],
      stream,
      stream_options: { include_usage: true },
    }),
  });
}

const text = { type: "text", text: "hello blocks" } as const;
const tool = {
  type: "toolCall",
  name: "weather",
  arguments: '{"city":"SF"}',
  id: "call_authored",
} as const;
const expectedTool = {
  id: tool.id,
  type: "function",
  function: { name: tool.name, arguments: tool.arguments },
};
const cases: {
  name: string;
  response: FixtureResponse;
  content: string;
  tools: boolean;
  terminal: string;
}[] = [
  {
    name: "text only",
    response: { blocks: [text] },
    content: text.text,
    tools: false,
    terminal: "stop",
  },
  {
    name: "tool only",
    response: { blocks: [tool] },
    content: "",
    tools: true,
    terminal: "tool_calls",
  },
  {
    name: "tool first",
    response: { blocks: [tool, text] },
    content: text.text,
    tools: true,
    terminal: "tool_calls",
  },
  {
    name: "text first",
    response: { blocks: [text, tool, text] },
    content: text.text.repeat(2),
    tools: true,
    terminal: "tool_calls",
  },
  {
    name: "trailing empty text",
    response: { blocks: [tool, { type: "text", text: "" }] },
    content: "",
    tools: true,
    terminal: "tool_calls",
  },
  {
    name: "empty text only",
    response: { blocks: [{ type: "text", text: "" }] },
    content: "",
    tools: false,
    terminal: "stop",
  },
  {
    name: "authoritative blocks",
    response: { content: "legacy", toolCalls: [tool], blocks: [text] },
    content: text.text,
    tools: false,
    terminal: "stop",
  },
  {
    name: "explicit finish",
    response: { blocks: [text], finishReason: "length" },
    content: text.text,
    tools: false,
    terminal: "length",
  },
  {
    name: "empty blocks legacy",
    response: { content: text.text, toolCalls: [tool], blocks: [] },
    content: text.text,
    tools: true,
    terminal: "tool_calls",
  },
  {
    name: "legacy empty tools",
    response: { content: text.text, toolCalls: [], blocks: [] },
    content: text.text,
    tools: false,
    terminal: "tool_calls",
  },
];

for (const stream of [false, true]) {
  describe(`OpenAI block outcomes stream=${stream}`, () => {
    it.each(cases)(
      "$name retains payload and terminal",
      async ({ response, content, tools, terminal }) => {
        const snapshot = structuredClone(response);
        const res = await request(response, stream);
        expect(res.status).toBe(200);
        if (!stream) {
          const body: ChatCompletion = await res.json();
          expect(body.choices[0].message.content).toBe(content);
          expect(body.choices[0].message.tool_calls ?? []).toEqual(tools ? [expectedTool] : []);
          expect(body.choices[0].finish_reason).toBe(terminal);
          expect(body.usage.completion_tokens).toBe(
            Math.max(
              1,
              Math.ceil((content + (tools ? tool.name + tool.arguments : "")).length / 4),
            ),
          );
        } else {
          const chunks: SSEChunk[] = (await res.text())
            .split("\n\n")
            .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
            .map((line) => JSON.parse(line.slice(6)));
          expect(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("")).toBe(
            content,
          );
          expect(
            chunks
              .flatMap((chunk) => chunk.choices)
              .filter((choice) => choice.finish_reason !== null)
              .map((choice) => choice.finish_reason),
          ).toEqual([terminal]);
          const deltas = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
          expect(deltas.filter((delta) => delta.id).map((delta) => delta.id)).toEqual(
            tools ? [tool.id] : [],
          );
          expect(deltas.map((delta) => delta.function?.name ?? "").join("")).toBe(
            tools ? tool.name : "",
          );
          expect(deltas.map((delta) => delta.function?.arguments ?? "").join("")).toBe(
            tools ? tool.arguments : "",
          );
        }
        expect(response).toEqual(snapshot);
      },
    );

    it("loads object arguments and preserves metadata overrides", async () => {
      const response = {
        blocks: [tool, text],
        reasoning: "think",
        id: "fixed",
        model: "custom",
        role: "assistant",
        usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 },
      };
      // JSON fixtures permit object arguments; exercise the loader's normalization.
      const res = await request(response, stream, {
        ...response,
        blocks: [{ ...tool, arguments: { city: "SF" } }, text],
      });
      const wire = await res.text();
      expect(res.status).toBe(200);
      expect(wire).toContain('"id":"fixed"');
      expect(wire).toContain('"model":"custom"');
      expect(wire).toContain('"completion_tokens":9');
      expect(wire).toContain("weather");
    });

    it("rejects malformed blocks before journaling success", async () => {
      const malformed = { ...text };
      Object.assign(malformed, { text: 42 });
      const res = await request({ blocks: [malformed] }, stream);
      expect(res.status).toBe(500);
      await res.text();
      expect(mock?.journal.getAll().some((entry) => entry.response.status === 200)).toBe(false);
    });
  });
}
