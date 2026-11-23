import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Fixture, FixtureResponse, MisbehaviorFault } from "../types.js";
import { render as renderRealtimeUsage } from "../response/usage/codecs/realtime.js";
import { serializeGolden, startGoldenServer } from "./golden/harness.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

const sourcePath = fileURLToPath(new URL("../ws-realtime.ts", import.meta.url));

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    nodes.push(child, ...descendants(child));
  });
  return nodes;
}

describe("Realtime chat usage ownership", () => {
  it("binds every chat envelope to the codec while keeping transcription local", () => {
    const program = ts.createProgram([sourcePath], { noResolve: true });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(sourcePath);
    if (!source) throw new Error("Missing Realtime source");
    const bindings = source.statements.flatMap((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "./response/usage/codecs/realtime.js"
      )
        return [];
      const named = statement.importClause?.namedBindings;
      return named && ts.isNamedImports(named)
        ? named.elements.filter(
            (element) => (element.propertyName ?? element.name).text === "render",
          )
        : [];
    });
    const symbols = bindings.map((binding) => checker.getSymbolAtLocation(binding.name));
    const calls = descendants(source).filter(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        symbols.some((symbol) => symbol && symbol === checker.getSymbolAtLocation(node.expression)),
    );
    expect(calls).toHaveLength(8);
    const consumers = calls.map(
      (call) => ts.findAncestor(call, ts.isFunctionDeclaration)?.name?.text,
    );
    expect(consumers.filter((name) => name === "checkRealtimeFixtureToolCalls")).toHaveLength(1);
    expect(consumers.filter((name) => name === "handleResponseCreate")).toHaveLength(6);
    expect(consumers.filter((name) => name === "streamRealtimeBlocks")).toHaveLength(1);
    const kinds = calls.map((call) => {
      const state = call.arguments[0];
      if (!state || !ts.isObjectLiteralExpression(state)) return undefined;
      const kind = state.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "kind",
      );
      return kind && ts.isStringLiteral(kind.initializer) ? kind.initializer.text : undefined;
    });
    expect(kinds.filter((kind) => kind === "ordinary-zero")).toHaveLength(7);
    expect(kinds.filter((kind) => kind === "applied-misbehavior")).toHaveLength(1);
    const tokenFields = descendants(source).filter(
      (node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        ["total_tokens", "input_tokens", "output_tokens"].includes(node.name.text),
    );
    expect(tokenFields).toHaveLength(3);
    for (const field of tokenFields) {
      expect(ts.findAncestor(field, ts.isFunctionDeclaration)?.name?.text).toBe(
        "defaultTranscriptionUsage",
      );
    }
  });
});

describe("Realtime chat codec", () => {
  it("keeps zero and applied projections separate with their original key order", () => {
    expect(JSON.stringify(renderRealtimeUsage({ kind: "ordinary-zero" }))).toBe(
      '{"total_tokens":0,"input_tokens":0,"output_tokens":0}',
    );
    expect(
      JSON.stringify(
        renderRealtimeUsage({
          kind: "applied-misbehavior",
          usage: { prompt_tokens: 0, completion_tokens: 8, total_tokens: 111 },
        }),
      ),
    ).toBe('{"input_tokens":0,"output_tokens":8,"total_tokens":111}');
  });
});

interface RealtimeEvent {
  type: string;
  response?: {
    status: string;
    usage: { total_tokens: number; input_tokens: number; output_tokens: number } | null;
    output: unknown[];
    status_details?: { type: string; reason?: string } | null;
  };
  usage?: {
    type: string;
    seconds?: number;
    input_token_details?: { text_tokens: number; audio_tokens: number };
  };
}

function evidence(id: string, frames: string[]) {
  const bytes = serializeGolden(frames);
  if (process.env.W6_BASELINE_DIR) {
    expect(bytes).toBe(readFileSync(join(process.env.W6_BASELINE_DIR, `${id}.json`), "utf8"));
  }
  if (process.env.W6_CAPTURE_DIR) {
    mkdirSync(process.env.W6_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.W6_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

async function until(client: WSTestClient, terminal: string, start = client.getMessages().length) {
  const raw: string[] = [];
  for (let count = start + 1; count < start + 100; count++) {
    const messages = await client.waitForMessages(count);
    const frame = messages[count - 1];
    raw.push(frame);
    const event: RealtimeEvent = JSON.parse(frame);
    if (event.type === terminal) return raw;
  }
  throw new Error(`Missing ${terminal}`);
}

async function withClient(
  fixtures: Fixture[],
  run: (client: WSTestClient) => Promise<void>,
  path = "/v1/realtime",
) {
  const server = await startGoldenServer(fixtures, { enableMisbehavior: true, chunkSize: 100 });
  const client = await connectWebSocket(server.url, path);
  try {
    await client.waitForMessages(1);
    await run(client);
  } finally {
    client.destroy();
    await client.waitForClose();
    await server.close();
  }
}

const tool = { name: "lookup", arguments: '{"city":"Paris"}', id: "call_fixed" };
const shapes: ReadonlyArray<readonly [string, FixtureResponse]> = [
  ["text", { content: "Hello." }],
  ["tool", { toolCalls: [tool] }],
  ["combined", { content: "Before", toolCalls: [tool] }],
  [
    "blocks",
    {
      blocks: [
        { type: "toolCall", ...tool },
        { type: "text", text: "After" },
      ],
    },
  ],
  [
    "error",
    { error: { message: "Rate limited", type: "rate_limit_error", code: "limited" }, status: 429 },
  ],
  [
    "rejected-tool",
    { toolCalls: [], customToolCalls: [{ type: "custom", name: "code", input: "print(1)" }] },
  ],
];
const usageVariants = [
  ["absent", undefined],
  ["null", null],
  [
    "zero",
    { input_tokens: 0, output_tokens: 0, prompt_tokens: 9, completion_tokens: 8, total_tokens: 0 },
  ],
  [
    "conflicts",
    {
      input_tokens: 7,
      output_tokens: 6,
      prompt_tokens: 9,
      completion_tokens: 8,
      total_tokens: 111,
    },
  ],
] as const;
const faults: MisbehaviorFault[] = [
  { fault: "empty-response" },
  { fault: "content-filter" },
  { fault: "stop-length-mid-tool" },
  { fault: "tool-args-invalid-json", style: "truncated" },
];

const textEvents = [
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.delta",
  "response.output_text.done",
  "response.content_part.done",
  "response.output_item.done",
  "conversation.item.done",
];
const toolEvents = [
  "response.output_item.added",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.output_item.done",
  "conversation.item.done",
];

function expectedEvents(shape: string) {
  const output =
    shape === "text"
      ? textEvents
      : shape === "tool"
        ? toolEvents
        : shape === "combined"
          ? [...textEvents, ...toolEvents]
          : shape === "blocks"
            ? [...toolEvents, ...textEvents]
            : [];
  return ["response.created", ...output, "response.done"];
}

function fixtureFor(
  response: FixtureResponse,
  usage: (typeof usageVariants)[number][1],
  fault?: MisbehaviorFault,
): Fixture {
  // JSON preserves deliberately null usage from the actual wire fixture boundary.
  const resolved: FixtureResponse = JSON.parse(
    JSON.stringify({ ...response, ...(usage !== undefined ? { usage } : {}) }),
  );
  return {
    match: { userMessage: "weather" },
    response: resolved,
    ...(fault ? { misbehavior: { faults: [fault] } } : {}),
  };
}

async function chatTurn(client: WSTestClient) {
  client.send(
    JSON.stringify({
      type: "session.update",
      session: {
        tools: [
          {
            type: "function",
            name: "lookup",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
    }),
  );
  await client.waitForMessages(2);
  client.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "weather" }] },
    }),
  );
  await client.waitForMessages(3);
  client.send(JSON.stringify({ type: "response.create" }));
  return until(client, "response.done", 3);
}

describe("Realtime actual WS equivalence", () => {
  const wire = "ga";
  it.each(
    shapes.flatMap(([shape, response]) =>
      usageVariants.map(([name, usage]) => ({ shape, response, name, usage })),
    ),
  )("ordinary $shape with $name usage", async ({ shape, response, name, usage }) => {
    await withClient([fixtureFor(response, usage)], async (client) => {
      const frames = await chatTurn(client);
      evidence(`${wire}-${shape}-${name}`, frames);
      const events: RealtimeEvent[] = frames.map((frame) => JSON.parse(frame));
      expect(events.map((event) => event.type)).toEqual(expectedEvents(shape));
      expect(events[0]).toMatchObject({ type: "response.created", response: { usage: null } });
      expect(events.at(-1)?.response?.usage).toEqual({
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      });
      expect(Object.keys(events.at(-1)?.response?.usage ?? {})).toEqual([
        "total_tokens",
        "input_tokens",
        "output_tokens",
      ]);
    });
  });

  it("retains the unmatched response envelope", async () => {
    await withClient([], async (client) => {
      const frames = await chatTurn(client);
      evidence(`${wire}-miss`, frames);
      const events: RealtimeEvent[] = frames.map((frame) => JSON.parse(frame));
      expect(events.map((event) => event.type)).toEqual(["response.created", "response.done"]);
      expect(events[0].response?.usage).toBeNull();
      expect(events[1].response).toMatchObject({
        status: "failed",
        usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
      });
    });
  });

  it.each(
    faults.flatMap((fault) => usageVariants.map(([name, usage]) => ({ fault, name, usage }))),
  )("applied $fault.fault with $name usage", async ({ fault, name, usage }) => {
    await withClient(
      [fixtureFor({ content: "Before", toolCalls: [tool] }, usage, fault)],
      async (client) => {
        const frames = await chatTurn(client);
        evidence(`${wire}-${fault.fault}-${name}`, frames);
        const events: RealtimeEvent[] = frames.map((frame) => JSON.parse(frame));
        expect(events[0].response?.usage).toBeNull();
        expect(events.map((event) => event.type)).toEqual(
          expectedEvents(
            ["empty-response", "content-filter"].includes(fault.fault) ? "empty" : "combined",
          ),
        );
        const final = events.at(-1)?.response;
        expect(final?.usage).not.toBeNull();
        expect(Object.keys(final?.usage ?? {})).toEqual([
          "input_tokens",
          "output_tokens",
          "total_tokens",
        ]);
        expect(final?.usage?.total_tokens).toBe(
          (final?.usage?.input_tokens ?? 0) + (final?.usage?.output_tokens ?? 0),
        );
        expect(final?.status).toBe(
          ["content-filter", "stop-length-mid-tool"].includes(fault.fault)
            ? "incomplete"
            : "completed",
        );
      },
    );
  });

  it("preserves cancellation and interrupted initial null usage", async () => {
    await withClient(
      [{ match: {}, response: { content: "Long text" }, chunkSize: 1, truncateAfterChunks: 1 }],
      async (client) => {
        client.send(JSON.stringify({ type: "response.cancel" }));
        const cancel = await until(client, "response.cancelled", 1);
        evidence(`${wire}-cancel`, cancel);
        expect(JSON.parse(cancel[0])).not.toHaveProperty("usage");
        client.send(JSON.stringify({ type: "response.create" }));
        await client.waitForClose();
        const frames = client.getMessages().slice(2);
        evidence(`${wire}-interrupted`, frames);
        const events: RealtimeEvent[] = frames.map((frame) => JSON.parse(frame));
        expect(events[0]).toMatchObject({ type: "response.created", response: { usage: null } });
        expect(events.some((event) => event.type === "response.done")).toBe(false);
      },
    );
  });

  it.each(["whisper-1", "gpt-4o-mini-transcribe"])(
    "preserves transcription discriminator for %s",
    async (model) => {
      await withClient(
        [
          {
            match: { endpoint: "realtime-transcription" },
            response: { transcription: { text: "Caption" } },
          },
        ],
        async (client) => {
          client.send(
            JSON.stringify({
              type: "transcription_session.update",
              session: { input_audio_transcription: { model } },
            }),
          );
          await client.waitForMessages(2);
          client.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          const frames = await until(
            client,
            "conversation.item.input_audio_transcription.completed",
            2,
          );
          evidence(`${wire}-transcription-${model}`, frames);
          const event: RealtimeEvent = JSON.parse(frames.at(-1)!);
          expect(event.usage).toEqual(
            model === "whisper-1"
              ? { type: "duration", seconds: 0 }
              : {
                  type: "tokens",
                  total_tokens: 0,
                  input_tokens: 0,
                  input_token_details: { text_tokens: 0, audio_tokens: 0 },
                  output_tokens: 0,
                },
          );
        },
        "/v1/realtime?intent=transcription",
      );
    },
  );
});
