import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";
import type { ResponsesSSEEvent } from "../responses.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

let mock: LLMock;
let directory: string;
let ws: WSTestClient | undefined;
beforeEach(() => {
  mock = new LLMock({ port: 0, chunkSize: 100 });
  directory = mkdtempSync(join(tmpdir(), "section2-responses-ws-arguments-"));
});
afterEach(async () => {
  ws?.destroy();
  ws = undefined;
  await mock.stop();
  rmSync(directory, { recursive: true, force: true });
});

function responseCreate(input: string) {
  return JSON.stringify({ type: "response.create", model: "gpt-4o", input });
}
async function exchange(client: WSTestClient, input: string) {
  const offset = client.getMessages().length;
  client.send(responseCreate(input));
  const events: ResponsesSSEEvent[] = [];
  for (;;) {
    const messages = await client.waitForMessages(offset + events.length + 1);
    const event: ResponsesSSEEvent = JSON.parse(messages.at(-1)!);
    events.push(event);
    if (event.type === "error" || event.type === "response.completed") return events;
  }
}
function expectSupported(events: ResponsesSSEEvent[]) {
  expect(events[0].type).toBe("response.created");
  expect(events.at(-1)).toMatchObject({
    type: "response.completed",
    response: {
      status: "completed",
      output: expect.arrayContaining([
        expect.objectContaining({ type: "function_call", name: "f", arguments: '{"x":1}' }),
      ]),
    },
  });
  expect(
    events
      .filter((event) => event.type === "response.function_call_arguments.delta")
      .map((event) => event.delta)
      .join(""),
  ).toBe('{"x":1}');
  expect(events.some((event) => event.type === "error")).toBe(false);
}

describe.each(["tool-only", "combined"] as const)("%s WebSocket arguments", (path) => {
  test.each([42, false])("journals rejected %s against its own request", async (value) => {
    const file = join(directory, "fixtures.json");
    writeFileSync(
      file,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "before" },
            response: {
              ...(path === "combined" ? { content: "hello" } : {}),
              toolCalls: [{ name: "f", arguments: '{"x":1}' }],
            },
          },
          {
            match: { userMessage: "hello" },
            response: {
              ...(path === "combined" ? { content: "hello" } : {}),
              toolCalls: [{ name: "f", arguments: value }],
            },
          },
          {
            match: { userMessage: "after" },
            response: {
              ...(path === "combined" ? { content: "hello" } : {}),
              toolCalls: [{ name: "f", arguments: { x: 1 } }],
            },
          },
        ],
      }),
    );
    mock.loadFixtureFile(file);
    await mock.start();
    ws = await connectWebSocket(mock.url, "/v1/responses");
    expectSupported(await exchange(ws, "before"));
    const failedEvents = await exchange(ws, "hello");
    expect(failedEvents).toEqual([
      {
        type: "error",
        error: {
          type: "server_error",
          message: expect.stringMatching(
            /Invalid fixture tool call.*arguments.*string after normalization/,
          ),
        },
      },
    ]);
    expect(mock.getRequests()).toHaveLength(2);
    const failedEntry = mock.getRequests()[1];
    expect.soft(failedEntry.response.status).toBe(500);
    expectSupported(await exchange(ws, "after"));
    const entries = mock.getRequests();
    const fixtures = mock.getFixtures();
    console.log(
      JSON.stringify({
        path,
        arguments: value,
        failedEvents,
        entries,
        matchCounts: fixtures.map((fixture) => mock.journal.getFixtureMatchCount(fixture)),
      }),
    );
    expect(entries).toHaveLength(3);
    expect(entries[1]).toBe(failedEntry);
    expect.soft(entries.map((entry) => entry.response.status)).toEqual([200, 500, 200]);
    for (const [index, input] of ["before", "hello", "after"].entries()) {
      expect(entries[index]).toMatchObject({
        method: "WS",
        path: "/v1/responses",
        body: { model: "gpt-4o", messages: [{ role: "user", content: input }] },
      });
      expect(entries[index].response.fixture).toBe(fixtures[index]);
    }
    expect(fixtures.map((fixture) => mock.journal.getFixtureMatchCount(fixture))).toEqual([
      1, 1, 1,
    ]);
  });
});
