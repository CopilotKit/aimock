import { connect as connectSocket } from "node:net";
import { OpenAIRealtimeWS } from "openai/beta/realtime/ws";
import { OpenAIRealtimeWS as OpenAIRealtimeGAWS } from "openai-current-sdk/realtime/ws";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type {
  ChatCompletionRequest,
  Fixture,
  FixtureResponse,
  MisbehaviorFault,
} from "../types.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

interface Item {
  type: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  status?: string;
  content?: { type: string; text?: string }[];
}
interface Event {
  type: string;
  delta?: string;
  arguments?: string;
  item?: Item;
  response?: {
    status: string;
    status_details?: { type: string; reason: string } | null;
    output: Item[];
    usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  };
}

let server: ServerInstance | undefined;
let ws: WSTestClient | undefined;
afterEach(async () => {
  ws?.destroy();
  ws = undefined;
  if (server) await new Promise<void>((resolve) => server!.server.close(() => resolve()));
  server = undefined;
});

const tool = { name: "weather", arguments: '{"city":"Paris","unit":"c"}' };
const nativeTools = ["weather", "search", "finish"].map((name) => ({
  type: "function",
  name,
  parameters: {
    type: "object",
    properties: { city: { type: "string" }, unit: { type: "string", enum: ["c", "f"] } },
    required: ["city"],
    additionalProperties: false,
  },
}));
const shapes: [string, FixtureResponse][] = [
  ["tool", { toolCalls: [tool] }],
  ["combined", { content: "Checking", toolCalls: [tool] }],
  [
    "blocks",
    {
      content: "ignored",
      toolCalls: [{ name: "ignored", arguments: "{}" }],
      blocks: [
        { type: "text", text: "Checking" },
        { type: "toolCall", ...tool },
      ],
    },
  ],
];

async function connect() {
  if (!server) throw new Error("missing server");
  ws = await connectWebSocket(server.url, "/v1/realtime?testId=realtime-stage2");
  await ws.waitForMessages(1);
  ws.send(JSON.stringify({ type: "session.update", session: { tools: nativeTools } }));
  await ws.waitForMessages(2);
  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "weather" }] },
    }),
  );
  await ws.waitForMessages(3);
  return ws;
}

async function turn(client: WSTestClient, response?: Record<string, unknown>) {
  const start = client.getMessages().length;
  client.send(JSON.stringify({ type: "response.create", ...(response ? { response } : {}) }));
  const events: Event[] = [];
  const deadline = Date.now() + 5000;
  for (let count = start + 1; Date.now() < deadline; count++) {
    const raw = await client.waitForMessages(count, Math.max(1, deadline - Date.now()));
    const event: Event = JSON.parse(raw[count - 1]);
    events.push(event);
    if (event.type === "error" || event.type === "response.done") return events;
  }
  throw new Error("missing terminal");
}

async function sdkTurn(sdk: OpenAIRealtimeGAWS): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const events: Event[] = [];
    const listener = (event: { type: string }) => {
      events.push(event as Event);
      if (event.type === "error" || event.type === "response.done") {
        clearTimeout(timeout);
        sdk.off("event", listener);
        resolve(events);
      }
    };
    const timeout = setTimeout(() => {
      sdk.off("event", listener);
      reject(new Error("missing official GA SDK terminal"));
    }, 5000);
    sdk.on("event", listener);
    sdk.send({ type: "response.create" });
  });
}

function completed(events: Event[], status = "completed") {
  const terminal = events.at(-1);
  expect(terminal, JSON.stringify(terminal)).toMatchObject({
    type: "response.done",
    response: { status },
  });
  if (!terminal?.response) throw new Error(JSON.stringify(terminal));
  return terminal.response;
}

async function serve(
  response: FixtureResponse,
  fault?: MisbehaviorFault,
  extra: Partial<Fixture> = {},
) {
  let calls = 0;
  const requests: ChatCompletionRequest[] = [];
  const original = JSON.stringify(response);
  const fixture: Fixture = {
    match: {},
    response: (request) => {
      calls++;
      requests.push(request);
      return response;
    },
    ...(fault ? { misbehavior: { faults: [fault] } } : {}),
    ...extra,
  };
  server = await createServer([fixture], { logLevel: "silent", metrics: true });
  const client = await connect();
  const events = await turn(client);
  expect(calls).toBe(1);
  expect(JSON.stringify(response)).toBe(original);
  expect(server.journal.getAll()).toHaveLength(1);
  return { events, fixture, client, requests, server };
}

function assertMetadata(instance: ServerInstance, output: Item[]) {
  const calls = output.filter((item) => item.type === "function_call");
  expect(instance.journal.getAll()[0].response).toMatchObject({
    status: 200,
    misbehavior: {
      applied: true,
      wire: "openai-realtime",
      servedToolCalls: calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
        id: call.call_id,
      })),
    },
  });
  expect(instance.journal.getAll()[0].response.misbehavior?.evaluations).toHaveLength(1);
}

describe("Realtime GA supported fault rendering", () => {
  it("keeps the ordinary no-config wire and factory response intact", async () => {
    const { events, server } = await serve(shapes[0][1]);
    expect(completed(events).output).toMatchObject([{ type: "function_call", ...tool }]);
    expect(server.journal.getAll()[0].response).not.toHaveProperty("misbehavior");
  });

  describe.each(shapes)("%s", (_shape, response) => {
    it.each(["truncated", "trailing-comma", "single-quotes"] as const)(
      "K1 %s preserves malformed strings across delta, done and metadata",
      async (style) => {
        const { events, server } = await serve(response, {
          fault: "tool-args-invalid-json",
          style,
        });
        const result = completed(events);
        const call = result.output.find((item) => item.type === "function_call");
        expect(call).toBeDefined();
        expect(() => JSON.parse(call!.arguments!)).toThrow();
        expect(
          events
            .filter((event) => event.type === "response.function_call_arguments.delta")
            .map((event) => event.delta)
            .join(""),
        ).toBe(call!.arguments);
        expect(
          events.find((event) => event.type === "response.function_call_arguments.done")?.arguments,
        ).toBe(call!.arguments);
        assertMetadata(server, result.output);
      },
    );

    it.each([
      "missing-required",
      "wrong-type",
      "extra-property",
      "enum-mismatch",
      "not-object",
    ] as const)("K2 %s uses native session schemas", async (violation) => {
      const { events, server } = await serve(response, {
        fault: "tool-args-schema-violation",
        violation,
        ...(violation === "enum-mismatch" ? { property: "unit" } : {}),
      });
      const result = completed(events);
      const call = result.output.find((item) => item.type === "function_call");
      const args = JSON.parse(call!.arguments!);
      if (violation === "missing-required") expect(args).not.toHaveProperty("city");
      if (violation === "wrong-type") expect(typeof args.city).not.toBe("string");
      if (violation === "extra-property")
        expect(Object.keys(args).some((key) => key !== "city" && key !== "unit")).toBe(true);
      if (violation === "enum-mismatch") expect(["c", "f"]).not.toContain(args.unit);
      if (violation === "not-object")
        expect(Array.isArray(args) || args === null || typeof args !== "object").toBe(true);
      assertMetadata(server, result.output);
    });

    it("K3 emits an undeclared name", async () => {
      const { events, server } = await serve(response, { fault: "tool-unknown-name" });
      const result = completed(events);
      const call = result.output.find((item) => item.type === "function_call");
      expect(nativeTools.map((item) => item.name)).not.toContain(call?.name);
      assertMetadata(server, result.output);
    });

    it("K5 ends incomplete and retains the cut call in next-turn history", async () => {
      const { events, server, fixture, client, requests } = await serve(response, {
        fault: "stop-length-mid-tool",
        at: 0.5,
      });
      const result = completed(events, "incomplete");
      expect(result.status_details).toEqual({ type: "incomplete", reason: "max_output_tokens" });
      const call = result.output.find((item) => item.type === "function_call");
      expect(call?.arguments).toBe(tool.arguments.slice(0, Math.floor(tool.arguments.length / 2)));
      expect(
        events
          .filter((event) => event.type === "response.function_call_arguments.delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe(call?.arguments);
      assertMetadata(server, result.output);
      fixture.misbehavior = { faults: [] };
      completed(await turn(client));
      expect(requests[1].messages.flatMap((message) => message.tool_calls ?? [])).toMatchObject([
        { id: call?.call_id, function: { name: "weather", arguments: call?.arguments } },
      ]);
    });
  });

  it.each(["weather", "search", "finish"])(
    "K4 prepares shared IDs once when target is %s",
    async (name) => {
      const response: FixtureResponse = {
        blocks: [
          { type: "toolCall", ...tool },
          { type: "text", text: "between" },
          { type: "toolCall", name: "search", arguments: "{}", id: "authored_search" },
          { type: "toolCall", name: "finish", arguments: "{}" },
        ],
      };
      const { events, server } = await serve(response, {
        fault: "tool-call-id-duplicate",
        tool: name,
      });
      const result = completed(events);
      const calls = result.output.filter((item) => item.type === "function_call");
      const index = calls.findIndex((item) => item.name === name);
      const destination = (index + 1) % calls.length;
      expect(calls[index].call_id).toBeTruthy();
      expect(calls[destination].call_id).toBe(calls[index].call_id);
      assertMetadata(server, result.output);
    },
  );

  it("K5 drops later calls and ordered text from wire, metadata and history", async () => {
    const response: FixtureResponse = {
      blocks: [
        { type: "toolCall", name: "search", arguments: "{}" },
        { type: "text", text: "before" },
        { type: "toolCall", ...tool },
        { type: "text", text: "DROP" },
        { type: "toolCall", name: "finish", arguments: "{}" },
      ],
    };
    const { events, server, fixture, client, requests } = await serve(response, {
      fault: "stop-length-mid-tool",
      tool: "weather",
    });
    const result = completed(events, "incomplete");
    expect(result.output.map((item) => item.name ?? item.content?.[0].text)).toEqual([
      "search",
      "before",
      "weather",
    ]);
    expect(JSON.stringify(events)).not.toContain("DROP");
    assertMetadata(server, result.output);
    fixture.misbehavior = { faults: [] };
    completed(await turn(client));
    expect(
      requests[1].messages
        .flatMap((message) => message.tool_calls ?? [])
        .map((call) => call.function.name),
    ).toEqual(["search", "weather"]);
  });

  describe.each([...shapes, ["text", { content: "hello" }] as [string, FixtureResponse]])(
    "empty %s",
    (_shape, response) => {
      it.each(["empty-response", "content-filter"] as const)(
        "%s emits only created and terminal with prepared usage",
        async (fault) => {
          const { events, server } = await serve(
            {
              ...response,
              usage: { prompt_tokens: 900, completion_tokens: 800, total_tokens: 1700 },
            },
            { fault },
          );
          const result = completed(events, fault === "content-filter" ? "incomplete" : "completed");
          expect(events.map((event) => event.type)).toEqual(["response.created", "response.done"]);
          expect(result.output).toEqual([]);
          if (fault === "content-filter")
            expect(result.status_details).toEqual({ type: "incomplete", reason: "content_filter" });
          expect(result.usage).not.toMatchObject({ input_tokens: 900 });
          expect(result.usage.total_tokens).toBe(
            result.usage.input_tokens + result.usage.output_tokens,
          );
          assertMetadata(server, result.output);
        },
      );
    },
  );

  it("runtime times1 applies once with next-turn recovery and one observation", async () => {
    server = await createServer([{ match: {}, response: shapes[0][1] }], {
      logLevel: "silent",
      metrics: true,
      misbehavior: { faults: [{ fault: "tool-args-invalid-json", times: 1 }] },
    });
    const client = await connect();
    const first = completed(await turn(client));
    expect(() => JSON.parse(first.output[0].arguments!)).toThrow();
    const second = completed(await turn(client));
    expect(JSON.parse(second.output[0].arguments!)).toEqual({ city: "Paris", unit: "c" });
    expect(server.journal.getAll()).toHaveLength(2);
    expect(server.journal.getAll()[1].response.misbehavior).toMatchObject({
      reason: "times-exhausted",
    });
    const metrics = await (await fetch(`${server.url}/metrics`)).text();
    expect(metrics).toContain('outcome="applied",wire="openai-realtime"} 1');
  });
  it("K2 consumes response-level tools overriding the session schema", async () => {
    server = await createServer(
      [
        {
          match: {},
          response: shapes[0][1],
          misbehavior: {
            faults: [
              { fault: "tool-args-schema-violation", violation: "enum-mismatch", property: "city" },
            ],
          },
        },
      ],
      { logLevel: "silent" },
    );
    const client = await connect();
    const events = await turn(client, {
      tools: [
        {
          type: "function",
          name: "weather",
          parameters: { type: "object", properties: { city: { type: "string", enum: ["Paris"] } } },
        },
      ],
    });
    const result = completed(events);
    expect(JSON.parse(result.output[0].arguments!).city).not.toBe("Paris");
  });

  it("rejects a K3 authored name declared by native session tools and recovers", async () => {
    const { events, fixture, client } = await serve(shapes[0][1], {
      fault: "tool-unknown-name",
      name: "weather",
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "aimock_misbehavior_not_applicable" },
    });
    fixture.misbehavior = { faults: [] };
    completed(await turn(client));
  });

  it("preserves permanent K9 explicit error and baseline skip", async () => {
    const { events, fixture, client, server } = await serve(shapes[0][1], {
      fault: "reasoning-only",
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "aimock_misbehavior_unsupported" },
    });
    fixture.misbehavior = undefined;
    const installed = await fetch(`${server.url}/__aimock/misbehavior`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-id": "realtime-stage2" },
      body: JSON.stringify({ faults: [{ fault: "reasoning-only" }] }),
    });
    expect(installed.status).toBe(200);
    completed(await turn(client));
    expect(server.journal.getAll()[1].response.misbehavior).toMatchObject({
      applied: false,
      reason: "unsupported-on-wire",
    });
  });

  it("retains complete prepared IDs and arguments after delivery interruption", async () => {
    server = await createServer(
      [
        {
          match: {},
          response: shapes[0][1],
          misbehavior: { faults: [{ fault: "tool-call-id-duplicate" }] },
          truncateAfterChunks: 1,
          chunkSize: 1,
        },
      ],
      { logLevel: "silent" },
    );
    const client = await connect();
    const start = client.getMessages().length;
    client.send(JSON.stringify({ type: "response.create" }));
    const raw = await client.waitForMessages(start + 1);
    expect(JSON.parse(raw[start])).toMatchObject({ type: "response.created" });
    await client.waitForClose();
    const entries = server.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response).toMatchObject({
      interrupted: true,
      interruptReason: "truncateAfterChunks",
      misbehavior: {
        applied: true,
        servedToolCalls: [
          { name: "weather", arguments: tool.arguments },
          { name: "weather", arguments: tool.arguments },
        ],
      },
    });
    const calls = entries[0].response.misbehavior?.servedToolCalls;
    expect(calls?.[0].id).toBeTruthy();
    expect(calls?.[0].id).toBe(calls?.[1].id);
    expect(client.getMessages().map((value) => JSON.parse(value).type)).not.toContain(
      "response.done",
    );
  });
  it("K1 skips a text turn without spending the next tool turn's budget", async () => {
    let calls = 0;
    server = await createServer(
      [{ match: {}, response: () => (++calls === 1 ? { content: "thinking" } : shapes[0][1]) }],
      {
        logLevel: "silent",
        misbehavior: { faults: [{ fault: "tool-args-invalid-json", times: 1 }] },
      },
    );
    const client = await connect();
    completed(await turn(client));
    expect(server.journal.getAll()[0].response.misbehavior).toMatchObject({
      applied: false,
      reason: "not-applicable",
    });
    const second = completed(await turn(client));
    expect(() => JSON.parse(second.output[0].arguments!)).toThrow();
    expect(server.journal.getAll()[1].response.misbehavior).toMatchObject({
      applied: true,
      ordinal: 0,
    });
    expect(calls).toBe(2);
  });

  it.each(["tool-args-invalid-json", "stop-length-mid-tool", "content-filter"] as const)(
    "official GA SDK delivers %s and same-session recovery",
    async (fault) => {
      const fixture: Fixture = {
        match: {},
        response: shapes[0][1],
        misbehavior: { faults: [{ fault }] },
      };
      server = await createServer([fixture], { logLevel: "silent" });
      let betaHeader: string | string[] | undefined;
      server.server.on("upgrade", (request) => {
        betaHeader = request.headers["openai-beta"];
      });
      const local = new URL(server.url);
      const sdk = new OpenAIRealtimeGAWS(
        {
          model: "gpt-realtime",
          options: { createConnection: () => connectSocket(Number(local.port), local.hostname) },
        },
        { apiKey: "local-stage2", baseURL: `${server.url}/v1` },
      );
      sdk.on("error", () => {
        /* Native errors are asserted through the official event stream. */
      });
      try {
        await new Promise<void>((resolve, reject) => {
          sdk.socket.once("open", () => resolve());
          sdk.socket.once("error", reject);
        });
        sdk.send({
          type: "session.update",
          session: { type: "realtime", output_modalities: ["text"] },
        });
        sdk.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "weather" }],
          },
        });
        const events = await sdkTurn(sdk);
        expect(betaHeader).toBeUndefined();
        console.log(
          "Official GA SDK real fault proof",
          JSON.stringify({ fault, terminal: events.at(-1), betaHeader: betaHeader ?? null }),
        );
        const result = completed(
          events,
          fault === "tool-args-invalid-json" ? "completed" : "incomplete",
        );
        if (fault === "tool-args-invalid-json") {
          const call = result.output[0];
          expect(() => JSON.parse(call.arguments!)).toThrow();
          expect(
            events
              .filter((event) => event.type === "response.function_call_arguments.delta")
              .map((event) => event.delta)
              .join(""),
          ).toBe(call.arguments);
          expect(
            events.find((event) => event.type === "response.function_call_arguments.done")
              ?.arguments,
          ).toBe(call.arguments);
        } else {
          expect(result.status_details).toEqual({
            type: "incomplete",
            reason: fault === "content-filter" ? "content_filter" : "max_output_tokens",
          });
          if (fault === "content-filter") expect(result.output).toEqual([]);
          else
            expect(result.output[0].arguments).toBe(
              tool.arguments.slice(0, Math.floor(tool.arguments.length / 2)),
            );
        }
        assertMetadata(server, result.output);
        fixture.misbehavior = { faults: [] };
        const recovery = completed(await sdkTurn(sdk));
        expect(recovery.output[0].arguments).toBe(tool.arguments);
        expect(server.journal.getAll()).toHaveLength(2);
      } finally {
        const closed = new Promise<void>((resolve) => sdk.socket.once("close", () => resolve()));
        sdk.close();
        await closed;
      }
    },
  );

  it("official SDK observes beta retirement, not GA supported-fault compatibility", async () => {
    server = await createServer([], { logLevel: "silent" });
    const local = new URL(server.url);
    // The installed SDK forces wss. Its public ws ClientOptions transport hook
    // connects real localhost TCP; headers, parser and error handling stay intact.
    const sdk = new OpenAIRealtimeWS(
      {
        model: "gpt-realtime-2",
        options: { createConnection: () => connectSocket(Number(local.port), local.hostname) },
      },
      { apiKey: "local-stage2", baseURL: `${server.url}/v1` },
    );
    try {
      const closed = new Promise<number>((resolve) =>
        sdk.socket.once("close", (code: number) => resolve(code)),
      );
      const error = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("missing official SDK retirement error")),
          3000,
        );
        sdk.on("error", (event) => {
          clearTimeout(timeout);
          resolve(event.error);
        });
      });
      console.log("OpenAI 4.104.0 official Realtime SDK native retirement", error);
      expect(error).toMatchObject({ code: "beta_api_shape_disabled" });
      expect(await closed).toBe(4000);
      expect(server.journal.getAll()).toHaveLength(0);
    } finally {
      sdk.close();
    }
  });
});
