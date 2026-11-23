import { afterEach, expect, test } from "vitest";
import { Socket } from "node:net";
import type { ResponseCreateParamsBase } from "openai/resources/responses/responses";
import { createServer, type ServerInstance } from "../../server.js";
import { WebSocketConnection } from "../../ws-framing.js";
import { connectWebSocket, type WSTestClient } from "../ws-test-client.js";
import { buildResponsesCreateMessage } from "./ws-providers.js";

type RequestOptions = Pick<
  ResponseCreateParamsBase,
  "max_output_tokens" | "reasoning" | "tool_choice"
>;
let server: ServerInstance | undefined;
let client: WSTestClient | undefined;

afterEach(async () => {
  if (client) {
    client.close();
    await client.waitForClose();
    client.destroy();
  }
  client = undefined;
  if (server) {
    const instance = server;
    await new Promise<void>((resolve, reject) =>
      instance.server.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
});

const input = [{ role: "user", content: "hello" }];
const tools = [{ type: "function", name: "weather", parameters: { type: "object" } }];

async function send(options?: RequestOptions) {
  const received: unknown[] = [];
  server = await createServer([{ match: {}, response: { content: "hello" } }], { port: 0 });
  // Decode a copy of the actual incoming bytes. The isolated observer cannot
  // send a second close frame on aimock's serving socket.
  server.server.on("upgrade", (_request, socket) => {
    if (!(socket instanceof Socket)) throw new Error("Expected a TCP socket");
    const decodingSocket = new Socket();
    const observer = new WebSocketConnection(decodingSocket);
    const observeBytes = (bytes: Buffer) => decodingSocket.emit("data", bytes);
    socket.on("data", observeBytes);
    observer.on("message", (raw: string) => {
      received.push(JSON.parse(raw));
      socket.off("data", observeBytes);
      decodingSocket.destroy();
    });
  });
  client = await connectWebSocket(server.url, "/v1/responses");
  client.send(JSON.stringify(buildResponsesCreateMessage("gpt-4o", input, tools, options)));
  let count = 0;
  for (;;) {
    const messages = await client.waitForMessages(++count);
    const message: { type: string } = JSON.parse(messages.at(-1)!);
    if (message.type === "error") throw new Error(messages.at(-1));
    if (message.type === "response.completed") break;
  }
  expect(server.journal.getAll()).toHaveLength(1);
  expect(server.journal.getAll()[0].response.status).toBe(200);
  expect(received).toHaveLength(1);
  console.log("Responses helper native request", JSON.stringify({ options, received }));
  return received[0];
}

const cases: RequestOptions[] = [
  {
    max_output_tokens: 1,
    reasoning: { effort: "high", summary: "auto" },
    tool_choice: { type: "function", name: "weather" },
  },
  {
    max_output_tokens: 16,
    reasoning: { effort: "low", summary: "concise" },
    tool_choice: "required",
  },
  {
    max_output_tokens: 32,
    reasoning: { effort: "medium", summary: "detailed" },
    tool_choice: "auto",
  },
];

test.each(cases)(
  "forwards native options with max_output_tokens=$max_output_tokens",
  async (options) => {
    expect(await send(options)).toEqual({
      type: "response.create",
      model: "gpt-4o",
      input,
      tools,
      ...options,
    });
  },
);

test("ordinary calls retain the existing budget and flat request shape", async () => {
  expect(await send()).toEqual({
    type: "response.create",
    model: "gpt-4o",
    input,
    tools,
    max_output_tokens: 50,
  });
});

test("options cannot replace transport-required fields or add unrelated fields", async () => {
  const options = {
    max_output_tokens: 8,
    type: "response.cancel",
    model: "wrong",
    input: [],
    tools: [],
    stream: false,
    extra: "ignored",
  };
  expect(await send(options)).toEqual({
    type: "response.create",
    model: "gpt-4o",
    input,
    tools,
    max_output_tokens: 8,
  });
});
