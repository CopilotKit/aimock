import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";
import type { ResponsesSSEEvent } from "../responses.js";

let mock: LLMock;
let directory: string;
beforeEach(() => {
  mock = new LLMock({ port: 0, chunkSize: 2 });
  directory = mkdtempSync(join(tmpdir(), "section2-responses-arguments-"));
});
afterEach(async () => {
  await mock.stop();
  rmSync(directory, { recursive: true, force: true });
});

const paths = ["tool-only", "combined", "blocks"] as const;
type Path = (typeof paths)[number];
function fixtureResponse(path: Path, args: unknown, invalidSecond = false) {
  const tool = { name: "f", ...(args === undefined ? {} : { arguments: args }) };
  if (path === "blocks") {
    return {
      blocks: [
        { type: "toolCall", ...tool },
        { type: "text", text: "TEXT" },
      ],
    };
  }
  const toolCalls = invalidSecond ? [{ name: "first", arguments: '{"ok":true}' }, tool] : [tool];
  return { ...(path === "combined" ? { content: "TEXT" } : {}), toolCalls };
}
async function request(stream: boolean) {
  await mock.start();
  const response = await fetch(`${mock.url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", input: "hello", stream }),
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.text();
  return {
    status: response.status,
    body,
    contentType: response.headers.get("content-type"),
    journalStatuses: mock.getRequests().map((entry) => entry.response.status),
    fixtureCount: mock.getFixtures().length,
    matchCounts: mock.getFixtures().map((fixture) => mock.journal.getFixtureMatchCount(fixture)),
  };
}
function load(path: Path, args: unknown, invalidSecond = false) {
  const file = join(directory, "fixtures.json");
  writeFileSync(
    file,
    JSON.stringify({
      fixtures: [
        { match: { userMessage: "hello" }, response: fixtureResponse(path, args, invalidSecond) },
      ],
    }),
  );
  mock.loadFixtureFile(file);
}
function parseEvents(body: string): ResponsesSSEEvent[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}
function expectComplete(
  result: Awaited<ReturnType<typeof request>>,
  args: string,
  stream: boolean,
) {
  expect(result.status).toBe(200);
  const output = expect.arrayContaining([
    expect.objectContaining({ type: "function_call", name: "f", arguments: args }),
  ]);
  if (!stream) {
    expect(result.contentType).toBe("application/json");
    expect(JSON.parse(result.body)).toMatchObject({ status: "completed", output });
    return;
  }
  expect(result.contentType).toContain("text/event-stream");
  const events = parseEvents(result.body);
  const deltas = events.filter((event) => event.type === "response.function_call_arguments.delta");
  for (const event of deltas) expect(typeof event.delta).toBe("string");
  expect(deltas.map((event) => event.delta).join("")).toBe(args);
  expect(events.filter((event) => event.type === "response.function_call_arguments.done")).toEqual([
    expect.objectContaining({ arguments: args }),
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "response.completed",
    response: { status: "completed", output },
  });
}
function expectFixtureError(result: Awaited<ReturnType<typeof request>>, path: Path) {
  expect(result.status).toBe(500);
  expect(result.contentType).toBe("application/json");
  expect(JSON.parse(result.body)).toEqual({
    error: {
      type: "server_error",
      message: expect.stringMatching(
        path === "blocks"
          ? /Invalid fixture block.*arguments/
          : /Invalid fixture tool call.*arguments.*string after normalization/,
      ),
    },
  });
  expect(result.body).not.toContain("reading 'length'");
  expect(result.journalStatuses).toEqual([500]);
  expect(result.fixtureCount).toBe(1);
  expect(result.matchCounts).toEqual([1]);
}
const supported = [
  { name: "string", value: '{"x":1}', expected: '{"x":1}' },
  { name: "object", value: { x: 1 }, expected: '{"x":1}' },
  { name: "array", value: [1, "x"], expected: '[1,"x"]' },
  { name: "scalar JSON string", value: "42", expected: "42" },
  { name: "empty string", value: "", expected: "" },
];
const invalid = [
  { name: "omitted", value: undefined },
  { name: "null", value: null },
  { name: "number", value: 42 },
  { name: "boolean", value: true },
];
describe.each([true, false])("stream=%s", (stream) => {
  describe.each(paths)("%s arguments", (path) => {
    test.each(supported)("preserves loaded $name", async ({ value, expected }) => {
      load(path, value);
      expectComplete(await request(stream), expected, stream);
    });
    test("preserves programmatic string", async () => {
      const tool = { name: "f", arguments: '{"x":1}' };
      mock.addFixture({
        match: { userMessage: "hello" },
        response:
          path === "blocks"
            ? {
                blocks: [
                  { type: "toolCall", ...tool },
                  { type: "text", text: "TEXT" },
                ],
              }
            : { ...(path === "combined" ? { content: "TEXT" } : {}), toolCalls: [tool] },
      });
      expectComplete(await request(stream), tool.arguments, stream);
    });
    test.each(invalid)("reports loaded $name as fixture error", async ({ name, value }) => {
      load(path, value);
      const result = await request(stream);
      console.log(JSON.stringify({ path, stream, argumentsCase: name, ...result }));
      expectFixtureError(result, path);
    });
  });
});
describe.each(["tool-only", "combined"] as const)("%s pre-header validation", (path) => {
  test("rejects an invalid second tool without sending partial SSE", async () => {
    load(path, null, true);
    expectFixtureError(await request(true), path);
  });
});
