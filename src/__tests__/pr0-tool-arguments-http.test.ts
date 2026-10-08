import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const paths = [
  {
    id: "anthropic-stream",
    path: "/v1/messages",
    request: {
      model: "claude-sonnet-4-20250514",
      max_tokens: 128,
      messages: [{ role: "user", content: "lookup" }],
      stream: true,
    },
  },
  {
    id: "cohere-string",
    path: "/v2/chat",
    request: {
      model: "command-r-plus",
      messages: [{ role: "user", content: "lookup" }],
      stream: false,
    },
  },
  {
    id: "gemini-object",
    path: "/v1beta/models/gemini-2.0-flash:generateContent",
    request: { contents: [{ role: "user", parts: [{ text: "lookup" }] }] },
  },
] as const;

async function requestWire(path: (typeof paths)[number], args: string) {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.addFixture({
    match: {},
    response: { toolCalls: [{ id: "call_pr0", name: "lookup", arguments: args }] },
  });
  await mock.start();
  const response = await fetch(mock.url + path.path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(path.request),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  const result = { status: response.status, body, journal: mock.getLastRequest() };
  console.log(JSON.stringify({ id: path.id, authoredArguments: args, ...result }));
  return result;
}

function wireArguments(id: string, body: string): unknown {
  if (id === "anthropic-stream") {
    return body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event.delta?.type === "input_json_delta")
      .map((event) => event.delta.partial_json)
      .join("");
  }
  const parsed = JSON.parse(body);
  return id === "cohere-string"
    ? parsed.message.tool_calls[0].function.arguments
    : parsed.candidates[0].content.parts[0].functionCall.args;
}

test.each(paths)("PR0 $id never replaces malformed fixture arguments with {}", async (path) => {
  const args = '{"city":';
  const result = await requestWire(path, args);
  if (path.id === "gemini-object") {
    expect(result.status).toBe(500);
    expect(result.body).toContain("invalid JSON arguments");
    expect(result.journal?.response.status).toBe(500);
  } else {
    expect(result.status).toBe(200);
    expect(wireArguments(path.id, result.body)).toBe(args);
  }
});

test.each(paths.flatMap((path) => ["", '{ "city": "Paris" }'].map((args) => ({ path, args }))))(
  "PR0 valid control $path.id arguments=$args",
  async ({ path, args }) => {
    const result = await requestWire(path, args);
    expect(result.status).toBe(200);
    const value = JSON.parse(args || "{}");
    const expected =
      path.id === "gemini-object"
        ? value
        : path.id === "cohere-string"
          ? args || "{}"
          : JSON.stringify(value);
    expect(wireArguments(path.id, result.body)).toEqual(expected);
  },
);
