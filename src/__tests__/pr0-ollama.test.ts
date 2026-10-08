import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama, type ChatResponse } from "ollama";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

const modes = [
  { id: "tool-stream", site: "ollama.ts:246", stream: true, shape: "tool" },
  { id: "tool-nonstream", site: "ollama.ts:310", stream: false, shape: "tool" },
  { id: "blocks-stream", site: "ollama.ts:348", stream: true, shape: "blocks" },
  { id: "legacy-stream", site: "ollama.ts:460", stream: true, shape: "legacy" },
  { id: "legacy-nonstream", site: "ollama.ts:538", stream: false, shape: "legacy" },
  { id: "blocks-nonstream", site: "ollama.ts:538", stream: false, shape: "blocks" },
] as const;

let mock: LLMock | undefined;
let fixtureDirectory: string | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
  fixtureDirectory = undefined;
});

async function requestOllama(mode: (typeof modes)[number], args: string | undefined) {
  const tool = { name: "lookup", ...(args === undefined ? {} : { arguments: args }) };
  const response =
    mode.shape === "blocks"
      ? {
          blocks: [
            { type: "toolCall", ...tool },
            { type: "text", text: "After tool." },
          ],
        }
      : mode.shape === "legacy"
        ? { content: "Before tool.", toolCalls: [tool] }
        : { toolCalls: [tool] };
  fixtureDirectory = mkdtempSync(join(tmpdir(), "aimock-pr0-ollama-"));
  const fixturePath = join(fixtureDirectory, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ fixtures: [{ match: {}, response }] }));
  mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.loadFixtureFile(fixturePath);
  expect(mock.getFixtures()).toHaveLength(1);
  await mock.start();

  const wire: Array<{ status: number; contentType: string | null; body: string }> = [];
  const receipts: Promise<void>[] = [];
  // Observe the real HTTP response without replacing it. Ollama 0.6.4 has no
  // retry loop/configuration; the one-request assertion below guards that fact.
  const client = new Ollama({
    host: mock.url,
    fetch: async (input, init) => {
      const result = await fetch(input, { ...init, signal: AbortSignal.timeout(5000) });
      receipts.push(
        result
          .clone()
          .text()
          .then((body) => {
            wire.push({
              status: result.status,
              contentType: result.headers.get("content-type"),
              body,
            });
          }),
      );
      return result;
    },
  });
  const chunks: ChatResponse[] = [];
  let failure: unknown;
  try {
    const request = { model: "llama3.1", messages: [{ role: "user", content: "lookup" }] };
    if (mode.stream) {
      for await (const chunk of await client.chat({ ...request, stream: true })) chunks.push(chunk);
    } else {
      chunks.push(await client.chat({ ...request, stream: false }));
    }
  } catch (error) {
    failure = error;
  }
  await Promise.all(receipts);
  const journal = mock.getLastRequest();
  console.log(
    JSON.stringify({
      mode,
      authoredArguments: args ?? "<missing>",
      wire,
      chunks,
      failure:
        failure instanceof Error ? { name: failure.name, message: failure.message } : failure,
      journal,
    }),
  );
  expect(wire).toHaveLength(1);
  expect(mock.getRequests()).toHaveLength(1);
  return { wire: wire[0], chunks, failure, journal };
}

test.each(modes)(
  "PR0 Ollama $id rejects malformed JSON before response content ($site)",
  async (mode) => {
    const result = await requestOllama(mode, '{"city":');
    expect.soft(result.wire.status).toBe(500);
    expect.soft(result.wire.contentType).toContain("application/json");
    expect.soft(result.wire.body).toContain("invalid JSON arguments");
    expect
      .soft(result.wire.body)
      .toContain("Use a wire that carries tool arguments as a string to test malformed JSON.");
    expect.soft(result.failure).toBeInstanceOf(Error);
    expect.soft(result.chunks).toEqual([]);
    expect.soft(result.journal?.response.status).toBe(500);
  },
);

const controls = [
  { label: "object", args: '{ "city": "Paris" }', expected: { city: "Paris" } },
  { label: "array", args: '[1,"two"]', expected: [1, "two"] },
  { label: "null", args: "null", expected: null },
  { label: "number", args: "42", expected: 42 },
  { label: "boolean", args: "false", expected: false },
  { label: "string", args: '"Paris"', expected: "Paris" },
  { label: "empty", args: "", expected: {} },
  { label: "missing", args: undefined, expected: {} },
];

test.each(modes.flatMap((mode) => controls.map((control) => ({ ...control, mode }))))(
  "PR0 Ollama control $mode.id $label",
  async ({ mode, args, expected }) => {
    const result = await requestOllama(mode, args);
    // Existing block validation requires arguments before reaching the parse
    // site. Missing legacy tool arguments, unlike blocks, default to {}.
    if (mode.shape === "blocks" && args === undefined) {
      expect(result.wire.status).toBe(500);
      expect(result.wire.body).toContain("requires a string or object");
      expect(result.failure).toBeInstanceOf(Error);
      expect(result.chunks).toEqual([]);
      return;
    }
    expect(result.failure).toBeUndefined();
    expect(result.wire.status).toBe(200);
    expect(result.journal?.response.status).toBe(200);
    const calls = result.chunks.flatMap((chunk) => chunk.message.tool_calls ?? []);
    expect(calls).toHaveLength(1);
    expect(calls[0].function).toEqual({ name: "lookup", arguments: expected });
    expect(result.chunks.map((chunk) => chunk.message.content).join("")).toBe(
      mode.shape === "blocks" ? "After tool." : mode.shape === "legacy" ? "Before tool." : "",
    );
    expect(result.chunks.at(-1)?.done).toBe(true);
    if (mode.stream && mode.shape !== "tool") {
      const toolIndex = result.chunks.findIndex((chunk) => chunk.message.tool_calls?.length);
      const textIndex = result.chunks.findIndex((chunk) => chunk.message.content);
      expect(mode.shape === "blocks" ? toolIndex < textIndex : textIndex < toolIndex).toBe(true);
    }
  },
);
