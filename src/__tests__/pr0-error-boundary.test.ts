import type { IncomingMessage } from "node:http";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";
import { createServer, type ServerInstance } from "../server.js";
import { InvalidToolArgumentsError } from "../helpers.js";
import type { Journal } from "../journal.js";

const tool = { id: "call_boundary", name: "lookup", arguments: '{"city":' };
let mock: LLMock | undefined;
let server: ServerInstance | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  if (server) await new Promise<void>((resolve) => server!.server.close(() => resolve()));
  server = undefined;
});

const routes = [
  {
    path: "/v1/messages",
    body: { model: "claude", max_tokens: 128, messages: [{ role: "user", content: "lookup" }] },
    shape: "anthropic",
  },
  {
    path: "/v1beta/models/gemini-2.0-flash:generateContent",
    body: { contents: [{ role: "user", parts: [{ text: "lookup" }] }] },
    shape: "gemini",
  },
  {
    path: "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.0-flash:streamGenerateContent",
    body: { contents: [{ role: "user", parts: [{ text: "lookup" }] }] },
    shape: "gemini",
  },
  {
    path: "/model/claude/invoke",
    body: { max_tokens: 128, messages: [{ role: "user", content: "lookup" }] },
    shape: "bedrock",
  },
  {
    path: "/api/chat",
    body: { model: "llama3", messages: [{ role: "user", content: "lookup" }], stream: true },
    shape: "ollama",
  },
  {
    path: "/v1beta/interactions",
    body: { model: "gemini-2.5-flash", input: "lookup", stream: false },
    shape: "interactions",
  },
];

test.each(routes)(
  "invalid object arguments return only the provider error: $path",
  async ({ path, body, shape }) => {
    mock = new LLMock({ port: 0, logLevel: "silent", strictToolArguments: true });
    mock.addFixture({ match: {}, response: { content: "must not be emitted", toolCalls: [tool] } });
    await mock.start();
    const response = await fetch(mock.url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    console.log(
      JSON.stringify({ path, status: response.status, body: text, journal: mock.getLastRequest() }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(text).not.toContain("must not be emitted");
    const message = new InvalidToolArgumentsError(tool).message;
    const error = JSON.parse(text);
    if (shape === "ollama")
      expect(error).toEqual({ error: message, code: "aimock_invalid_tool_arguments" });
    else if (shape === "gemini")
      expect(error).toEqual({
        error: {
          code: 500,
          message,
          status: "INTERNAL",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "AIMOCK_INVALID_TOOL_ARGUMENTS",
              domain: "aimock",
              metadata: { code: "aimock_invalid_tool_arguments" },
            },
          ],
        },
      });
    else if (shape === "bedrock")
      expect(error).toEqual({
        __type: "InternalServerException",
        message,
        reason: "aimock_invalid_tool_arguments",
      });
    else if (shape === "interactions")
      expect(error).toEqual({ error: { code: "aimock_invalid_tool_arguments", message } });
    else
      expect(error).toEqual({
        type: "error",
        error: { type: "api_error", code: "aimock_invalid_tool_arguments", message },
      });
    expect(mock.getRequests()).toHaveLength(1);
    expect(mock.getLastRequest()?.response).toMatchObject({ status: 500, error: message });
  },
);

test.each([false, true])(
  "typed boundary error journals once; existing entry=%s",
  async (existing) => {
    let journal: Journal | undefined;
    const error = new InvalidToolArgumentsError(tool);
    server = await createServer([], { logLevel: "silent" }, [
      {
        path: "/boundary",
        handler: {
          setJournal(value: Journal) {
            journal = value;
          },
          async handleRequest(req: IncomingMessage): Promise<boolean> {
            if (existing)
              journal!.add({
                method: req.method ?? "GET",
                path: "/boundary",
                headers: {},
                body: null,
                response: { status: 200, fixture: null, source: "internal" },
              });
            throw error;
          },
        },
      },
    ]);
    const response = await fetch(server.url + "/boundary");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        message: error.message,
        type: "server_error",
        code: "aimock_invalid_tool_arguments",
      },
    });
    expect(server.journal.getAll()).toHaveLength(1);
    expect(server.journal.getLast()?.response).toEqual({
      status: 500,
      fixture: null,
      source: "internal",
      error: error.message,
    });
  },
);

test("an unrelated provider failure retains its envelope and journal fields", async () => {
  mock = new LLMock({ port: 0, logLevel: "silent", strictToolArguments: true });
  mock.addFixture({
    match: {},
    response: () => {
      throw new Error("unrelated failure");
    },
  });
  await mock.start();
  const response = await fetch(mock.url + "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "claude",
      max_tokens: 128,
      messages: [{ role: "user", content: "lookup" }],
    }),
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: { message: "Response factory threw: unrelated failure", type: "server_error" },
  });
  expect(mock.getLastRequest()?.response).toEqual({
    status: 500,
    fixture: null,
    source: "internal",
  });
});
