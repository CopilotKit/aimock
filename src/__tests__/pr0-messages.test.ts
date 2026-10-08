import Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
let fixtureDir: string | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

// Original E1 sites: tool-only stream 651 / object 798; ordered-block stream
// 936; legacy mixed stream 1026; shared mixed object helper 1111 (both callers).
const paths = ["tool-only", "legacy-mixed", "ordered-blocks"] as const;
type Path = (typeof paths)[number];
const cells = paths.flatMap((path) => [true, false].map((stream) => ({ path, stream })));

async function requestArguments(path: Path, stream: boolean, args: string | undefined) {
  fixtureDir = await mkdtemp(join(tmpdir(), "pr0-messages-"));
  const tool = { id: "toolu_pr0", name: "lookup", arguments: args };
  const response =
    path === "ordered-blocks"
      ? {
          blocks: [
            { type: "toolCall", ...tool },
            { type: "text", text: "after tool" },
          ],
        }
      : path === "legacy-mixed"
        ? { content: "before tool", toolCalls: [tool] }
        : { toolCalls: [tool] };
  const fixturePath = join(fixtureDir, "fixture.json");
  await writeFile(fixturePath, JSON.stringify({ fixtures: [{ match: {}, response }] }));
  mock = new LLMock({ port: 0, logLevel: "silent", chunkSize: 2 });
  mock.loadFixtureFile(fixturePath);
  await mock.start();

  let status: number | undefined;
  let contentType: string | null = null;
  let rawBody: Promise<string> | undefined;
  const client = new Anthropic({
    apiKey: "local-pr0",
    baseURL: mock.url,
    maxRetries: 0,
    timeout: 5000,
    fetch: async (input, init) => {
      const result = await fetch(input, init);
      status = result.status;
      contentType = result.headers.get("content-type");
      rawBody = result.clone().text();
      return result;
    },
  });
  const request = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 64,
    messages: [{ role: "user", content: "lookup" }] as const,
  };
  // Keep the SDK's raw event API: its higher-level message accumulator parses
  // incomplete argument strings itself, obscuring the exact malformed bytes.
  const events: Anthropic.RawMessageStreamEvent[] = [];
  let message: Anthropic.Message | undefined;
  let sdkError: unknown;
  try {
    if (stream) {
      const result = await client.messages.create({
        ...request,
        messages: [...request.messages],
        stream: true,
      });
      for await (const event of result) events.push(event);
    } else {
      message = await client.messages.create({
        ...request,
        messages: [...request.messages],
        stream: false,
      });
    }
  } catch (error) {
    sdkError = error;
  }
  const result = {
    status,
    contentType,
    body: await rawBody,
    events,
    message,
    sdkError,
    journal: mock.getLastRequest(),
  };
  console.log(JSON.stringify({ path, stream, authoredArguments: args ?? "<missing>", ...result }));
  return result;
}

function expectArguments(
  result: Awaited<ReturnType<typeof requestArguments>>,
  path: Path,
  stream: boolean,
  expected: unknown,
) {
  expect(result.sdkError).toBeUndefined();
  expect(result.status).toBe(200);
  expect(result.journal?.response.status).toBe(200);
  const expectedOrder =
    path === "tool-only"
      ? ["tool_use"]
      : path === "legacy-mixed"
        ? ["text", "tool_use"]
        : ["tool_use", "text"];
  if (stream) {
    expect(result.contentType).toContain("text/event-stream");
    const partials = result.events.flatMap((event) =>
      event.type === "content_block_delta" && event.delta.type === "input_json_delta"
        ? [event.delta.partial_json]
        : [],
    );
    expect(partials.join("")).toBe(expected);
    expect(
      result.events.flatMap((event) =>
        event.type === "content_block_start" ? [event.content_block.type] : [],
      ),
    ).toEqual(expectedOrder);
    expect(result.events.at(-1)?.type).toBe("message_stop");
  } else {
    expect(result.message?.content.map((block) => block.type)).toEqual(expectedOrder);
    const tool = result.message?.content.find((block) => block.type === "tool_use");
    expect(tool?.input).toEqual(expected);
  }
}

test.each(cells)("PR0 malformed $path stream=$stream", async ({ path, stream }) => {
  const args = '{"city":';
  const result = await requestArguments(path, stream, args);
  if (stream) {
    expectArguments(result, path, stream, args);
  } else {
    expect.soft(result.status).toBe(500);
    expect.soft(result.contentType).toContain("application/json");
    expect.soft(result.sdkError).toBeInstanceOf(Anthropic.APIError);
    expect.soft(result.message).toBeUndefined();
    expect.soft(result.body).toContain("invalid JSON arguments");
    expect
      .soft(result.body)
      .toContain("Use a wire that carries tool arguments as a string to test malformed JSON.");
    expect.soft(result.journal?.response.status).toBe(500);
    expect.soft(result.journal?.response.error).toContain("invalid JSON arguments");
  }
});

const controls = [
  { name: "valid object whitespace", args: '{ "city": "Paris" }', value: { city: "Paris" } },
  { name: "empty", args: "", value: {} },
  { name: "missing", args: undefined, value: {} },
  { name: "array", args: '[ 1, "x" ]', value: [1, "x"] },
  { name: "primitive", args: "42", value: 42 },
  { name: "null", args: "null", value: null },
];
// Missing ordered-block arguments are rejected by existing block validation
// before these parse sites; preserve that contract outside this proof matrix.
test.each(
  cells.flatMap((cell) =>
    controls
      .filter((control) => cell.path !== "ordered-blocks" || control.args !== undefined)
      .map((control) => ({ ...cell, ...control })),
  ),
)("PR0 control $name $path stream=$stream", async ({ path, stream, args, value }) => {
  const result = await requestArguments(path, stream, args);
  expectArguments(result, path, stream, stream ? JSON.stringify(value) : value);
});
