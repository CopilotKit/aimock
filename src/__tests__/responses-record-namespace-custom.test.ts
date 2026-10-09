import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { collapseOpenAISSE } from "../stream-collapse.js";
import { validateFixtures } from "../fixture-loader.js";
import type { Fixture, FixtureFileEntry } from "../types.js";

// #505: record mode keeps Responses `function_call.namespace` and
// `custom_tool_call` items, so a recorded fixture replays what upstream sent.

const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n";

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function customCallEvents(opts: {
  outputIndex: number;
  callId: string;
  name: string;
  input: string;
  namespace?: string;
  namespaceOnDoneOnly?: boolean;
  deltas?: string[];
}): Record<string, unknown>[] {
  const ns = opts.namespace ? { namespace: opts.namespace } : {};
  const id = `ctc_${opts.callId}`;
  const deltas = opts.deltas ?? [opts.input];
  return [
    {
      type: "response.output_item.added",
      output_index: opts.outputIndex,
      item: {
        type: "custom_tool_call",
        id,
        call_id: opts.callId,
        ...(opts.namespaceOnDoneOnly ? {} : ns),
        name: opts.name,
        input: "",
        status: "in_progress",
      },
    },
    ...deltas.map((delta) => ({
      type: "response.custom_tool_call_input.delta",
      item_id: id,
      output_index: opts.outputIndex,
      delta,
    })),
    {
      type: "response.custom_tool_call_input.done",
      item_id: id,
      output_index: opts.outputIndex,
      input: opts.input,
    },
    {
      type: "response.output_item.done",
      output_index: opts.outputIndex,
      item: {
        type: "custom_tool_call",
        id,
        call_id: opts.callId,
        ...ns,
        name: opts.name,
        input: opts.input,
        status: "completed",
      },
    },
  ];
}

function functionCallEvents(opts: {
  outputIndex: number;
  callId: string;
  name: string;
  args: string;
  namespace?: string;
  namespaceOnDoneOnly?: boolean;
}): Record<string, unknown>[] {
  const ns = opts.namespace ? { namespace: opts.namespace } : {};
  const id = `fc_${opts.callId}`;
  return [
    {
      type: "response.output_item.added",
      output_index: opts.outputIndex,
      item: {
        type: "function_call",
        id,
        call_id: opts.callId,
        ...(opts.namespaceOnDoneOnly ? {} : ns),
        name: opts.name,
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: id,
      output_index: opts.outputIndex,
      delta: opts.args,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: id,
      output_index: opts.outputIndex,
      arguments: opts.args,
    },
    {
      type: "response.output_item.done",
      output_index: opts.outputIndex,
      item: {
        type: "function_call",
        id,
        call_id: opts.callId,
        ...ns,
        name: opts.name,
        arguments: opts.args,
        status: "completed",
      },
    },
  ];
}

function textEvents(outputIndex: number, text: string): Record<string, unknown>[] {
  const id = `msg_${outputIndex}`;
  return [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { type: "message", id, status: "in_progress", role: "assistant", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: id,
      output_index: outputIndex,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "message",
        id,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
  ];
}

const created = { type: "response.created", response: { id: "resp_1", status: "in_progress" } };
const completed = { type: "response.completed", response: { id: "resp_1", status: "completed" } };

describe("collapseOpenAISSE: Responses namespace and custom tool calls (#505)", () => {
  it("collapses a streamed custom_tool_call into a custom tool call with its full input", () => {
    const body = sse([
      created,
      ...customCallEvents({
        outputIndex: 0,
        callId: "call_patch",
        name: "apply_patch",
        input: PATCH,
        deltas: [PATCH.slice(0, 10), PATCH.slice(10, 30), PATCH.slice(30)],
      }),
      completed,
    ]);
    const result = collapseOpenAISSE(body);
    expect(result.content).toBeUndefined();
    expect(result.toolCalls).toEqual([
      { type: "custom", name: "apply_patch", input: PATCH, id: "call_patch" },
    ]);
    expect(result.toolCalls![0]).not.toHaveProperty("arguments");
  });

  it("keeps namespace on a custom call, from .added or (when absent there) from output_item.done", () => {
    const fromAdded = collapseOpenAISSE(
      sse(
        customCallEvents({
          outputIndex: 0,
          callId: "c1",
          name: "run",
          input: "ls -la",
          namespace: "sandbox",
        }),
      ),
    );
    expect(fromAdded.toolCalls).toEqual([
      { type: "custom", name: "run", input: "ls -la", id: "c1", namespace: "sandbox" },
    ]);
    const fromDone = collapseOpenAISSE(
      sse(
        customCallEvents({
          outputIndex: 0,
          callId: "c2",
          name: "run",
          input: "pwd",
          namespace: "sandbox",
          namespaceOnDoneOnly: true,
        }),
      ),
    );
    expect(fromDone.toolCalls).toEqual([
      { type: "custom", name: "run", input: "pwd", id: "c2", namespace: "sandbox" },
    ]);
  });

  it("adopts the full input from custom_tool_call_input.done or output_item.done when no delta arrived", () => {
    const noDeltas = customCallEvents({
      outputIndex: 0,
      callId: "c_nd",
      name: "apply_patch",
      input: PATCH,
      deltas: [],
    });
    expect(collapseOpenAISSE(sse(noDeltas)).toolCalls).toEqual([
      { type: "custom", name: "apply_patch", input: PATCH, id: "c_nd" },
    ]);
    // Only the closing output_item.done: the item alone is a complete call.
    const doneOnly = noDeltas.filter((e) => e.type === "response.output_item.done") as Record<
      string,
      unknown
    >[];
    expect(collapseOpenAISSE(sse(doneOnly)).toolCalls).toEqual([
      { type: "custom", name: "apply_patch", input: PATCH, id: "c_nd" },
    ]);
  });

  it("does not double the input when deltas are followed by the .done events", () => {
    const result = collapseOpenAISSE(
      sse(
        customCallEvents({
          outputIndex: 0,
          callId: "c_dd",
          name: "apply_patch",
          input: "abc",
          deltas: ["a", "b", "c"],
        }),
      ),
    );
    expect(result.toolCalls).toEqual([
      { type: "custom", name: "apply_patch", input: "abc", id: "c_dd" },
    ]);
  });

  it("keeps namespace on a function_call, from .added or (when absent there) from output_item.done", () => {
    const result = collapseOpenAISSE(
      sse([
        created,
        ...functionCallEvents({
          outputIndex: 0,
          callId: "call_a",
          name: "lookup_doc",
          args: '{"id":"505"}',
          namespace: "mcp__docs",
        }),
        ...functionCallEvents({
          outputIndex: 1,
          callId: "call_b",
          name: "spawn_agent",
          args: '{"message":"hi"}',
          namespace: "collaboration",
          namespaceOnDoneOnly: true,
        }),
        ...functionCallEvents({ outputIndex: 2, callId: "call_c", name: "plain", args: "" }),
        completed,
      ]),
    );
    expect(result.toolCalls).toEqual([
      { name: "lookup_doc", arguments: '{"id":"505"}', id: "call_a", namespace: "mcp__docs" },
      {
        name: "spawn_agent",
        arguments: '{"message":"hi"}',
        id: "call_b",
        namespace: "collaboration",
      },
      // No namespace key at all on a plain call (legacy shape stays key-for-key).
      { name: "plain", arguments: "{}", id: "call_c" },
    ]);
  });

  it("ignores an empty-string namespace", () => {
    const result = collapseOpenAISSE(
      sse([
        ...functionCallEvents({ outputIndex: 0, callId: "f", name: "fn", args: "{}" }).map((e) =>
          e.item ? { ...e, item: { ...(e.item as object), namespace: "" } } : e,
        ),
        ...customCallEvents({ outputIndex: 1, callId: "c", name: "cu", input: "x" }).map((e) =>
          e.item ? { ...e, item: { ...(e.item as object), namespace: "" } } : e,
        ),
      ]),
    );
    expect(result.toolCalls).toEqual([
      { name: "fn", arguments: "{}", id: "f" },
      { type: "custom", name: "cu", input: "x", id: "c" },
    ]);
  });

  it("keeps a mixed function + custom turn in output_index order", () => {
    const result = collapseOpenAISSE(
      sse([
        created,
        ...functionCallEvents({
          outputIndex: 0,
          callId: "call_mcp",
          name: "lookup_doc",
          args: '{"id":"7"}',
          namespace: "mcp__docs",
        }),
        ...customCallEvents({
          outputIndex: 1,
          callId: "call_run",
          name: "run",
          input: "ls -la",
          namespace: "sandbox",
        }),
        completed,
      ]),
    );
    expect(result.blocks).toBeUndefined();
    expect(result.toolCalls).toEqual([
      { name: "lookup_doc", arguments: '{"id":"7"}', id: "call_mcp", namespace: "mcp__docs" },
      { type: "custom", name: "run", input: "ls -la", id: "call_run", namespace: "sandbox" },
    ]);
  });

  it("projects an interleaved custom / text / namespaced function turn into ordered blocks", () => {
    const result = collapseOpenAISSE(
      sse([
        created,
        ...customCallEvents({
          outputIndex: 0,
          callId: "call_p",
          name: "apply_patch",
          input: PATCH,
        }),
        ...textEvents(1, "Patched."),
        ...functionCallEvents({
          outputIndex: 2,
          callId: "call_l",
          name: "lookup_doc",
          args: '{"id":"4"}',
          namespace: "mcp__docs",
        }),
        completed,
      ]),
    );
    expect(result.content).toBe("Patched.");
    expect(result.blocks).toEqual([
      { type: "customToolCall", name: "apply_patch", input: PATCH, id: "call_p" },
      { type: "text", text: "Patched." },
      {
        type: "toolCall",
        name: "lookup_doc",
        arguments: '{"id":"4"}',
        id: "call_l",
        namespace: "mcp__docs",
      },
    ]);
    expect(result.toolCalls).toEqual([
      { type: "custom", name: "apply_patch", input: PATCH, id: "call_p" },
      { name: "lookup_doc", arguments: '{"id":"4"}', id: "call_l", namespace: "mcp__docs" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Record -> replay round trip over real HTTP: upstream aimock (PR #511
// emission) -> aimock in record mode -> fixture on disk -> replay aimock.
// ---------------------------------------------------------------------------

type Item = Record<string, unknown>;

/** The output items a client sees, minus the per-run random item ids. */
function project(items: Item[]): unknown[] {
  return items.map((i) => {
    if (i.type === "message") {
      return { type: "message", text: ((i.content as Item[]) ?? []).map((c) => c.text).join("") };
    }
    const rest = { ...i };
    delete rest.id;
    return rest;
  });
}

async function streamedItems(baseUrl: string, userMessage: string): Promise<unknown[]> {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
    body: JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      input: [{ role: "user", content: userMessage }],
    }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  for (const block of text.split("\n\n")) {
    const data = block.split("\n").find((l) => l.startsWith("data:"));
    if (!data) continue;
    const parsed = JSON.parse(data.slice(5).trim()) as Item;
    if (parsed.type === "response.completed") {
      return project(((parsed.response as Item).output as Item[]) ?? []);
    }
  }
  throw new Error(`no response.completed in stream for ${userMessage}`);
}

const upstreamFixtures: FixtureFileEntry[] = [
  {
    match: { userMessage: "custom only" },
    response: {
      toolCalls: [{ type: "custom", name: "apply_patch", id: "call_patch_1", input: PATCH }],
    },
  },
  {
    match: { userMessage: "namespaced function" },
    response: {
      toolCalls: [
        {
          name: "lookup_doc",
          namespace: "mcp__stdiodocs",
          id: "call_mcp_1",
          arguments: { id: "505" },
        },
      ],
    },
  },
  {
    match: { userMessage: "mixed" },
    response: {
      toolCalls: [
        { name: "lookup_doc", namespace: "mcp__stdiodocs", id: "call_mcp_2", arguments: "{}" },
        { type: "custom", name: "run", namespace: "sandbox", id: "call_run_1", input: "ls -la" },
      ],
    },
  },
  {
    match: { userMessage: "interleaved" },
    response: {
      blocks: [
        { type: "customToolCall", name: "apply_patch", id: "call_patch_4", input: PATCH },
        { type: "text", text: "Patched; now looking it up." },
        {
          type: "toolCall",
          name: "lookup_doc",
          namespace: "mcp__stdiodocs",
          id: "call_mcp_4",
          arguments: '{"id":"4"}',
        },
      ],
    },
  },
];

describe("record -> replay round trip keeps Responses namespace and custom tool calls (#505)", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it("records the calls with namespace and input intact, and the replay serves the same items", async () => {
    const upstream = new LLMock({ port: 0, logLevel: "silent" });
    upstream.addFixturesFromJSON(upstreamFixtures);
    await upstream.start();
    cleanups.push(() => upstream.stop());

    const dir = mkdtempSync(join(tmpdir(), "aimock-505-record-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const recorder = new LLMock({
      port: 0,
      logLevel: "silent",
      record: { providers: { openai: upstream.url }, fixturePath: dir },
    });
    await recorder.start();
    cleanups.push(() => recorder.stop());

    const upstreamItems: Record<string, unknown[]> = {};
    for (const f of upstreamFixtures) {
      const msg = f.match.userMessage as string;
      upstreamItems[msg] = await streamedItems(upstream.url, msg);
      // The proxied (recording) response is the upstream's own stream.
      expect(await streamedItems(recorder.url, msg)).toEqual(upstreamItems[msg]);
    }

    // The fixtures on disk carry namespace and the custom input.
    const recorded = new Map<string, Fixture["response"]>();
    for (const file of readdirSync(dir)) {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        fixtures: { match: { userMessage: string }; response: Fixture["response"] }[];
      };
      for (const fx of parsed.fixtures) recorded.set(fx.match.userMessage, fx.response);
    }
    expect(recorded.get("custom only")).toEqual({
      toolCalls: [{ type: "custom", name: "apply_patch", input: PATCH, id: "call_patch_1" }],
    });
    expect(recorded.get("namespaced function")).toEqual({
      toolCalls: [
        {
          name: "lookup_doc",
          arguments: '{"id":"505"}',
          id: "call_mcp_1",
          namespace: "mcp__stdiodocs",
        },
      ],
    });
    expect(recorded.get("mixed")).toEqual({
      toolCalls: [
        { name: "lookup_doc", arguments: "{}", id: "call_mcp_2", namespace: "mcp__stdiodocs" },
        { type: "custom", name: "run", input: "ls -la", id: "call_run_1", namespace: "sandbox" },
      ],
    });
    expect(recorded.get("interleaved")).toEqual({
      content: "Patched; now looking it up.",
      toolCalls: [
        { type: "custom", name: "apply_patch", input: PATCH, id: "call_patch_4" },
        {
          name: "lookup_doc",
          arguments: '{"id":"4"}',
          id: "call_mcp_4",
          namespace: "mcp__stdiodocs",
        },
      ],
      blocks: [
        { type: "customToolCall", name: "apply_patch", input: PATCH, id: "call_patch_4" },
        { type: "text", text: "Patched; now looking it up." },
        {
          type: "toolCall",
          name: "lookup_doc",
          arguments: '{"id":"4"}',
          id: "call_mcp_4",
          namespace: "mcp__stdiodocs",
        },
      ],
    });

    // Recorded fixtures pass load-time validation with no errors or warnings.
    const replay = new LLMock({ port: 0, logLevel: "silent" });
    replay.loadFixtureDir(dir);
    expect(validateFixtures([...replay.getFixtures()])).toEqual([]);

    // Replaying with no upstream serves the same items the upstream sent.
    await replay.start();
    cleanups.push(() => replay.stop());
    for (const f of upstreamFixtures) {
      const msg = f.match.userMessage as string;
      expect(await streamedItems(replay.url, msg)).toEqual(upstreamItems[msg]);
    }
  });
});
