import { afterEach, describe, expect, test, vi } from "vitest";
import { LLMock } from "../llmock.js";

// Fixture tool calls whose `arguments` are not valid JSON. By default every
// wire serves them exactly as 1.44.0 did: `{}` where arguments are an object,
// `"{}"` where they are a string (Cohere and the streamed Anthropic, Bedrock,
// Converse and Gemini Interactions deltas), with one warning per call. The
// `strictToolArguments` opt-in keeps the #501 behavior: object wires answer 500
// `aimock_invalid_tool_arguments` and string wires send the authored text.

const BAD = '{"city":';
const WARNING = `Malformed JSON in fixture tool call arguments for "lookup": ${BAD}`;

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  vi.restoreAllMocks();
});

const chat = [{ role: "user", content: "go" }];
const gemini = { contents: [{ role: "user", parts: [{ text: "go" }] }] };
const VERTEX = "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.0-flash";
const converse = { messages: [{ role: "user", content: [{ text: "go" }] }] };

function sseData(body: string): Record<string, unknown>[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

/** Decode an AWS event stream body into its JSON payloads (base64 `bytes` unwrapped). */
function eventStreamPayloads(buf: Buffer): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset + 12 <= buf.length) {
    const total = buf.readUInt32BE(offset);
    const headersLength = buf.readUInt32BE(offset + 4);
    const payload = JSON.parse(
      buf.subarray(offset + 12 + headersLength, offset + total - 4).toString(),
    ) as Record<string, unknown>;
    out.push(
      typeof payload.bytes === "string"
        ? (JSON.parse(Buffer.from(payload.bytes, "base64").toString()) as Record<string, unknown>)
        : payload,
    );
    offset += total;
  }
  return out;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Wire {
  id: string;
  path: string;
  body: object;
  /** "object": `{}` by default, 500 under strict. "string": `"{}"` by default, the authored text under strict. */
  carries: "object" | "string";
  /** The served arguments of the first tool call, from the raw response. */
  args: (raw: Buffer) => unknown;
}

const wires: Wire[] = [
  {
    id: "anthropic",
    path: "/v1/messages",
    body: { model: "claude", max_tokens: 64, messages: chat },
    carries: "object",
    args: (raw) => (JSON.parse(raw.toString()) as Json).content[0].input,
  },
  {
    id: "anthropic stream",
    path: "/v1/messages",
    body: { model: "claude", max_tokens: 64, stream: true, messages: chat },
    carries: "string",
    args: (raw) =>
      sseData(raw.toString())
        .map((event) => (event as Json).delta?.partial_json ?? "")
        .join(""),
  },
  {
    id: "gemini",
    path: "/v1beta/models/gemini-2.0-flash:generateContent",
    body: gemini,
    carries: "object",
    args: (raw) =>
      (JSON.parse(raw.toString()) as Json).candidates[0].content.parts[0].functionCall.args,
  },
  {
    id: "gemini stream",
    path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    body: gemini,
    carries: "object",
    args: (raw) =>
      (sseData(raw.toString())[0] as Json).candidates[0].content.parts[0].functionCall.args,
  },
  {
    id: "vertex",
    path: `${VERTEX}:generateContent`,
    body: gemini,
    carries: "object",
    args: (raw) =>
      (JSON.parse(raw.toString()) as Json).candidates[0].content.parts[0].functionCall.args,
  },
  {
    id: "bedrock invoke",
    path: "/model/claude/invoke",
    body: { max_tokens: 64, messages: chat },
    carries: "object",
    args: (raw) => (JSON.parse(raw.toString()) as Json).content[0].input,
  },
  {
    id: "bedrock invoke stream",
    path: "/model/claude/invoke-with-response-stream",
    body: { max_tokens: 64, messages: chat },
    carries: "string",
    args: (raw) =>
      eventStreamPayloads(raw)
        .map((event) => (event as Json).delta?.partial_json ?? "")
        .join(""),
  },
  {
    id: "converse",
    path: "/model/claude/converse",
    body: converse,
    carries: "object",
    args: (raw) => (JSON.parse(raw.toString()) as Json).output.message.content[0].toolUse.input,
  },
  {
    id: "converse stream",
    path: "/model/claude/converse-stream",
    body: converse,
    carries: "string",
    args: (raw) =>
      eventStreamPayloads(raw)
        .map((event) => (event as Json).delta?.toolUse?.input ?? "")
        .join(""),
  },
  {
    id: "ollama",
    path: "/api/chat",
    body: { model: "llama3", stream: false, messages: chat },
    carries: "object",
    args: (raw) => (JSON.parse(raw.toString()) as Json).message.tool_calls[0].function.arguments,
  },
  {
    id: "ollama stream",
    path: "/api/chat",
    body: { model: "llama3", stream: true, messages: chat },
    carries: "object",
    args: (raw) =>
      (JSON.parse(raw.toString().split("\n")[0]) as Json).message.tool_calls[0].function.arguments,
  },
  {
    id: "cohere",
    path: "/v2/chat",
    body: { model: "command-r", messages: chat },
    carries: "string",
    args: (raw) => (JSON.parse(raw.toString()) as Json).message.tool_calls[0].function.arguments,
  },
  {
    id: "cohere stream",
    path: "/v2/chat",
    body: { model: "command-r", stream: true, messages: chat },
    carries: "string",
    args: (raw) =>
      sseData(raw.toString())
        .map((event) => (event as Json).delta?.message?.tool_calls?.function?.arguments ?? "")
        .join(""),
  },
  {
    id: "gemini interactions",
    path: "/v1beta/interactions",
    body: { model: "gemini-2.5-flash", input: "go", stream: false },
    carries: "object",
    args: (raw) => (JSON.parse(raw.toString()) as Json).steps[0].arguments,
  },
  {
    id: "gemini interactions stream",
    path: "/v1beta/interactions",
    body: { model: "gemini-2.5-flash", input: "go", stream: true },
    carries: "string",
    args: (raw) =>
      sseData(raw.toString())
        .map((event: Json) =>
          event.delta?.type === "arguments_delta" ? event.delta.arguments : "",
        )
        .join(""),
  },
];

const fixtures = {
  toolCalls: { toolCalls: [{ name: "lookup", arguments: BAD }] },
  blocks: {
    // Tool first, so each extractor reads the tool call at the first position.
    blocks: [
      { type: "toolCall" as const, name: "lookup", arguments: BAD },
      { type: "text" as const, text: "a" },
    ],
  },
};

async function serve(
  wire: Wire,
  response: object,
  options: { strictToolArguments?: boolean } = {},
): Promise<{ status: number; raw: Buffer; warnings: string[] }> {
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...parts: unknown[]) => {
    warnings.push(parts.join(" "));
  });
  mock = new LLMock({ port: 0, logLevel: "warn", ...options });
  mock.on({ userMessage: "go" }, response);
  await mock.start();
  const res = await fetch(mock.url + wire.path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wire.body),
    signal: AbortSignal.timeout(5000),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    raw,
    warnings: warnings.filter((line) => line.includes("Malformed JSON")),
  };
}

describe.each(Object.entries(fixtures))("invalid JSON tool arguments in %s", (_name, response) => {
  test.each(wires)("$id: served as {} with one warning by default (1.44.0)", async (wire) => {
    const { status, raw, warnings } = await serve(wire, response);
    expect(status).toBe(200);
    expect(wire.args(raw)).toEqual(wire.carries === "object" ? {} : "{}");
    expect(warnings).toEqual([`[aimock] ${WARNING}`]);
    expect(mock!.getLastRequest()?.response.status).toBe(200);
  });

  test.each(wires)("$id: strictToolArguments keeps the #501 behavior", async (wire) => {
    const { status, raw } = await serve(wire, response, { strictToolArguments: true });
    if (wire.carries === "string") {
      expect(status).toBe(200);
      expect(wire.args(raw)).toBe(BAD);
      return;
    }
    expect(status).toBe(500);
    expect(raw.toString()).toContain('fixture tool call \\"lookup\\" has invalid JSON arguments');
    expect(mock!.getLastRequest()?.response).toMatchObject({
      status: 500,
      error: expect.stringContaining("invalid JSON arguments"),
    });
  });
});

describe("misbehavior with invalid JSON tool arguments", () => {
  const anthropicStream = wires.find((wire) => wire.id === "anthropic stream")!;

  test("by default a fault is not applied to the fixture and {} is served", async () => {
    const { status, raw } = await serve(anthropicStream, {
      toolCalls: [{ name: "lookup", arguments: BAD }],
    });
    expect(status).toBe(200);
    mock!.clearFixtures();
    mock!.addFixture({
      match: { userMessage: "go" },
      response: { toolCalls: [{ name: "lookup", arguments: BAD }] },
      misbehavior: { faults: [{ fault: "tool-unknown-name", name: "undeclared" }] },
    });
    const res = await fetch(mock!.url + anthropicStream.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(anthropicStream.body),
    });
    const faulted = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(faulted.toString()).toContain('"name":"lookup"');
    expect(faulted.toString()).not.toContain("undeclared");
    expect(anthropicStream.args(faulted)).toBe("{}");
    expect(anthropicStream.args(raw)).toBe("{}");
  });

  test("tool-args-invalid-json still sends malformed arguments by default", async () => {
    const { status, raw } = await serve(anthropicStream, {
      toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}' }],
    });
    expect(status).toBe(200);
    expect(anthropicStream.args(raw)).toBe('{"city":"Paris"}');
    mock!.clearFixtures();
    mock!.addFixture({
      match: { userMessage: "go" },
      response: { toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}' }] },
      misbehavior: { faults: [{ fault: "tool-args-invalid-json", style: "truncated" }] },
    });
    const res = await fetch(mock!.url + anthropicStream.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(anthropicStream.body),
    });
    const served = anthropicStream.args(Buffer.from(await res.arrayBuffer())) as string;
    expect(res.status).toBe(200);
    expect(() => JSON.parse(served)).toThrow();
    expect(served).not.toBe("{}");
  });
});
