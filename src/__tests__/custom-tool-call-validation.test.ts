/**
 * #505 — load-time validation and request-time guards for namespaced and
 * custom tool calls: the validating doors (`aimock validate`, the control API,
 * `addFixturesFromJSON`) reject a malformed call at load, and a fixture file
 * loaded without validation fails at request time with a coded 500 (or a
 * failed Realtime `response.done`). All of that needs responsesTools
 * "extended"; by default every door treats the new keys as 1.44.0 did (see
 * the last describe block).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  entryToFixture,
  markFixtureResponsesToolsExtended,
  validateFixtures,
} from "../fixture-loader.js";
import { LLMock } from "../llmock.js";
import { runValidateCli } from "../validate-cli.js";
import type { FixtureFileEntry } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

const entry = (response: Record<string, unknown>): FixtureFileEntry =>
  ({ match: { userMessage: "go" }, response }) as FixtureFileEntry;

/** A fixture loaded for a server with responsesTools "extended", which checks the new keys. */
function extended(e: FixtureFileEntry) {
  const fixture = entryToFixture(e);
  markFixtureResponsesToolsExtended(fixture);
  return fixture;
}

function issuesFor(response: Record<string, unknown>) {
  return validateFixtures([extended(entry(response))]).map((r) => [r.severity, r.message]);
}

/**
 * Fixtures 1.44.0 accepted: every one of them loads with NO finding at all
 * (not even a warning), so `aimock validate --strict` keeps passing. A
 * `toolCalls` entry is always a function call; a `type`, `input` or invalid
 * `namespace` on it is ignored, as 1.44.0 ignored it.
 */
const legacyClean: Array<{ id: string; response: Record<string, unknown> }> = [
  {
    id: 'legacy type "toolCall"',
    response: { toolCalls: [{ type: "toolCall", name: "f", arguments: "{}" }] },
  },
  {
    id: 'type "custom" with arguments',
    response: { toolCalls: [{ type: "custom", name: "f", arguments: "{}" }] },
  },
  {
    id: 'type "customToolCall" with arguments',
    response: { toolCalls: [{ type: "customToolCall", name: "f", arguments: "{}" }] },
  },
  {
    id: "empty namespace",
    response: { toolCalls: [{ name: "f", namespace: "", arguments: "{}" }] },
  },
  {
    id: "non-string namespace",
    response: { toolCalls: [{ name: "f", namespace: 3, arguments: "{}" }] },
  },
  { id: "numeric id", response: { toolCalls: [{ name: "f", id: 5, arguments: "{}" }] } },
  { id: "non-string name", response: { toolCalls: [{ name: 5, arguments: "{}" }] } },
  {
    id: "function with input",
    response: { toolCalls: [{ name: "f", arguments: "{}", input: "x" }] },
  },
  {
    id: "toolCall block with input",
    response: {
      blocks: [
        { type: "text", text: "a" },
        { type: "toolCall", name: "f", arguments: "{}", input: "x" },
      ],
    },
  },
  {
    id: "toolCall block with an empty namespace",
    response: {
      blocks: [
        { type: "text", text: "a" },
        { type: "toolCall", name: "f", arguments: "{}", namespace: "" },
      ],
    },
  },
];

/** The new OpenAI Responses keys are validated; each row has exactly one defect. */
const rows: Array<{
  id: string;
  response: Record<string, unknown>;
  expected: [string, string];
}> = [
  {
    id: "function invalid JSON (content+toolCalls)",
    response: { content: "c", toolCalls: [{ type: "function", name: "f", arguments: "{" }] },
    expected: [
      "error",
      "toolCalls[0].arguments is not valid JSON: {; to send invalid JSON on purpose, use `misbehavior: tool-args-invalid-json`",
    ],
  },
  {
    id: "custom non-string namespace",
    response: { toolCalls: [], customToolCalls: [{ name: "f", namespace: 3, input: "x" }] },
    expected: ["error", "customToolCalls[0].namespace must be a non-empty string"],
  },
  {
    id: "custom empty name",
    response: { toolCalls: [], customToolCalls: [{ name: "", input: "x" }] },
    expected: ["error", "customToolCalls[0].name must be a non-empty string"],
  },
  {
    id: "custom missing input",
    response: { toolCalls: [], customToolCalls: [{ name: "apply_patch" }] },
    expected: ["error", "customToolCalls[0].input must be a string for a custom tool call"],
  },
  {
    id: "custom non-string input",
    response: { toolCalls: [], customToolCalls: [{ name: "apply_patch", input: { a: 1 } }] },
    expected: ["error", "customToolCalls[0].input must be a string for a custom tool call"],
  },
  {
    id: "custom with arguments",
    response: {
      toolCalls: [],
      customToolCalls: [{ name: "apply_patch", input: "x", arguments: "{}" }],
    },
    expected: [
      "error",
      "customToolCalls[0].arguments is not valid on a custom tool call; use input",
    ],
  },
  {
    id: "custom empty input",
    response: { toolCalls: [], customToolCalls: [{ name: "apply_patch", input: "" }] },
    expected: ["warning", "customToolCalls[0].input is empty"],
  },
  {
    id: "custom wrong type",
    response: {
      toolCalls: [],
      customToolCalls: [{ type: "function", name: "apply_patch", input: "x" }],
    },
    expected: ["error", 'customToolCalls[0].type must be "custom" when present'],
  },
  {
    id: "customToolCall block missing input",
    response: { responsesBlocks: [{ type: "customToolCall", name: "apply_patch" }] },
    expected: ["error", "responsesBlocks[0].input must be a string for a custom tool call"],
  },
  {
    id: "customToolCall block with arguments",
    response: {
      responsesBlocks: [
        { type: "customToolCall", name: "apply_patch", input: "x", arguments: "{}" },
      ],
    },
    expected: [
      "error",
      "responsesBlocks[0].arguments is not valid on a custom tool call; use input",
    ],
  },
  {
    id: "customToolCall block empty input",
    response: { responsesBlocks: [{ type: "customToolCall", name: "apply_patch", input: "" }] },
    expected: ["warning", "responsesBlocks[0].input is empty"],
  },
  {
    id: "customToolCall block empty namespace",
    response: {
      responsesBlocks: [{ type: "customToolCall", name: "run", namespace: "", input: "x" }],
    },
    expected: ["error", "responsesBlocks[0].namespace must be a non-empty string"],
  },
  {
    id: "customToolCall block empty name",
    response: { responsesBlocks: [{ type: "customToolCall", name: "", input: "x" }] },
    expected: ["error", "responsesBlocks[0].name must be a non-empty string"],
  },
  {
    id: "customToolCall block non-string id",
    response: {
      responsesBlocks: [{ type: "customToolCall", name: "apply_patch", input: "x", id: 7 }],
    },
    expected: ["error", "responsesBlocks[0].id must be a string, got number"],
  },
  {
    id: "toolCall responsesBlock non-string namespace",
    response: { responsesBlocks: [{ type: "toolCall", name: "f", namespace: 7, arguments: "{}" }] },
    expected: ["error", "responsesBlocks[0].namespace must be a non-empty string"],
  },
  {
    id: "toolCall responsesBlock with input",
    response: { responsesBlocks: [{ type: "toolCall", name: "f", arguments: "{}", input: "x" }] },
    expected: ["error", 'responsesBlocks[0].input is only valid on a "customToolCall" block'],
  },
  {
    id: "unknown responsesBlock type",
    response: { responsesBlocks: [{ type: "custom", name: "apply_patch", input: "x" }] },
    expected: [
      "error",
      'responsesBlocks[0].type must be "text", "toolCall" or "customToolCall", got "custom"',
    ],
  },
  {
    id: "blocks and responsesBlocks together",
    response: {
      blocks: [{ type: "text", text: "a" }],
      responsesBlocks: [{ type: "text", text: "a" }],
    },
    expected: ["error", "blocks and responsesBlocks cannot both be set; use responsesBlocks alone"],
  },
];

describe("validateFixtures: namespace and custom tool call rules", () => {
  it.each(legacyClean)("1.44.0 shape, no finding: $id", ({ response }) => {
    expect(issuesFor(response)).toEqual([]);
  });

  // Each row has exactly one defect, so it yields exactly one issue.
  it.each(rows)("$id", ({ response, expected }) => {
    expect(issuesFor(response)).toEqual([expected]);
  });

  it("accepts valid namespaced and custom calls with no issues, and never parses or stringifies input", () => {
    const input = '{"looks":"like json"} but is free text';
    const fixture = extended(
      entry({
        toolCalls: [{ name: "f", namespace: "ns", arguments: { a: 1 } }],
        customToolCalls: [{ name: "apply_patch", namespace: "sandbox", input }],
      }),
    );
    expect(validateFixtures([fixture])).toEqual([]);
    const response = fixture.response as {
      toolCalls: Array<Record<string, unknown>>;
      customToolCalls: Array<Record<string, unknown>>;
    };
    expect(response.toolCalls[0].arguments).toBe('{"a":1}');
    expect(response.customToolCalls[0]).toEqual({
      type: "custom",
      name: "apply_patch",
      namespace: "sandbox",
      input,
    });
    const blocksFixture = extended(
      entry({
        responsesBlocks: [
          { type: "toolCall", name: "f", namespace: "ns", arguments: { a: 1 } },
          { type: "customToolCall", name: "apply_patch", input },
        ],
      }),
    );
    expect(validateFixtures([blocksFixture])).toEqual([]);
    const blocks = (blocksFixture.response as { responsesBlocks: Array<Record<string, unknown>> })
      .responsesBlocks;
    expect(blocks[0].arguments).toBe('{"a":1}');
    expect(blocks[1].input).toBe(input);
  });
});

describe("validating doors reject at load; unvalidated loads fail at request time", () => {
  let dir: string | undefined;
  let mock: LLMock | undefined;
  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const bad = { toolCalls: [], customToolCalls: [{ name: "apply_patch", arguments: { a: 1 } }] };
  const legacy = { toolCalls: [{ type: "custom", name: "apply_patch", arguments: { a: 1 } }] };

  it("1.44.0 shapes pass every validating door (validate --strict, control API, addFixturesFromJSON)", async () => {
    dir = mkdtempSync(join(tmpdir(), "aimock-505-validate-legacy-"));
    const file = join(dir, "legacy.json");
    writeFileSync(
      file,
      JSON.stringify({
        fixtures: legacyClean.map((row) => ({
          match: { userMessage: row.id },
          response: row.response,
        })),
      }),
    );
    let code: number | null = null;
    runValidateCli({
      argv: ["--strict", file],
      log: () => {},
      logError: () => {},
      exit: (c) => {
        code = c;
      },
    });
    expect(code ?? 0).toBe(0);
    mock = new LLMock({ port: 0, logLevel: "silent" });
    await mock.start();
    const res = await fetch(`${mock.url}/__aimock/fixtures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures: [entry(legacy)] }),
    });
    expect(res.status, await res.text()).toBe(200);
    expect(() => new LLMock({ port: 0 }).addFixturesFromJSON([entry(legacy)])).not.toThrow();
  });

  it("aimock validate --responses-tools extended", () => {
    dir = mkdtempSync(join(tmpdir(), "aimock-505-validate-"));
    const file = join(dir, "custom.json");
    writeFileSync(file, JSON.stringify({ fixtures: [entry(bad)] }));
    const logs: string[] = [];
    let code: number | null = null;
    runValidateCli({
      argv: ["--responses-tools", "extended", file],
      log: (m) => logs.push(m),
      logError: (m) => logs.push(m),
      exit: (c) => {
        code = c;
      },
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain(
      "customToolCalls[0].input must be a string for a custom tool call",
    );
  });

  it("control API (responsesTools extended)", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    await mock.start();
    const res = await fetch(`${mock.url}/__aimock/fixtures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures: [entry(bad)] }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "customToolCalls[0].arguments is not valid on a custom tool call; use input",
    );
  });

  it("addFixturesFromJSON (responsesTools extended)", () => {
    const unstarted = new LLMock({ port: 0, responsesTools: "extended" });
    expect(() => unstarted.addFixturesFromJSON([entry(bad)])).toThrow(
      /customToolCalls\[0\]\.input must be a string for a custom tool call/,
    );
  });

  /** Load `response` through the unvalidated file door and start the server. */
  async function startUnvalidated(response: Record<string, unknown>): Promise<LLMock> {
    dir = mkdtempSync(join(tmpdir(), "aimock-505-unvalidated-"));
    const file = join(dir, "custom.json");
    writeFileSync(file, JSON.stringify({ fixtures: [entry(response)] }));
    // Serving customToolCalls / responsesBlocks needs responsesTools "extended".
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    mock.loadFixtureFile(file);
    await mock.start();
    return mock;
  }

  async function hit(m: LLMock, path: string, body: Record<string, unknown>) {
    const res = await fetch(`${m.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, text: await res.text() };
  }

  it("an unvalidated file load fails at request time with an explicit 500 on /v1/responses", async () => {
    const m = await startUnvalidated(bad);
    const r = await hit(m, "/v1/responses", { model: "gpt-5", input: "go" });
    expect(r.status, r.text).toBe(500);
    const message =
      'Invalid fixture tool call: "input" must be a string for a custom tool call (customToolCalls[0])';
    expect((JSON.parse(r.text) as { error: unknown }).error).toEqual({
      message,
      type: "server_error",
      code: "aimock_invalid_fixture_tool_call",
    });
    expect(m.getLastRequest()?.response).toMatchObject({ status: 500, error: message });
  });

  const UNSUPPORTED =
    'aimock: fixture tool call "apply_patch" is a custom tool call, which only the OpenAI Responses API supports';

  it.each([
    {
      wire: "Chat Completions",
      path: "/v1/chat/completions",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "go" }] },
    },
    {
      wire: "Anthropic Messages",
      path: "/v1/messages",
      body: { model: "claude", max_tokens: 64, messages: [{ role: "user", content: "go" }] },
    },
  ])(
    "an unvalidated file load on $wire answers 500 aimock_unsupported_tool_call and journals the error",
    async ({ path, body }) => {
      const m = await startUnvalidated(bad);
      const r = await hit(m, path, body);
      expect(r.status, r.text).toBe(500);
      // Both wires carry `error.code` and `error.message` in their envelope.
      const json = JSON.parse(r.text) as { error?: { code?: unknown; message?: unknown } };
      expect(json.error?.code, r.text).toBe("aimock_unsupported_tool_call");
      expect(String(json.error?.message)).toContain(UNSUPPORTED);
      const journaled = m.getLastRequest()?.response;
      expect(journaled?.status).toBe(500);
      expect(journaled?.error).toContain(UNSUPPORTED);
    },
  );

  it.each([
    {
      id: "non-string id on a customToolCall block",
      block: { type: "customToolCall", name: "apply_patch", input: "x", id: 7 },
      message: '"customToolCall" block "id" must be a string when present',
    },
    {
      id: "empty namespace on a toolCall responsesBlock",
      block: { type: "toolCall", name: "f", namespace: "", arguments: "{}" },
      message: '"namespace" must be a non-empty string when present',
    },
    {
      id: "non-string namespace on a customToolCall block",
      block: { type: "customToolCall", name: "run", namespace: 7, input: "x" },
      message: '"namespace" must be a non-empty string when present',
    },
  ])(
    "an unvalidated block with $id fails at request time on /v1/responses",
    async ({ block, message }) => {
      const m = await startUnvalidated({ responsesBlocks: [{ type: "text", text: "hi" }, block] });
      const r = await hit(m, "/v1/responses", { model: "gpt-5", input: "go", stream: true });
      expect(r.status, r.text).toBe(500);
      const json = JSON.parse(r.text) as { error?: { code?: unknown; message?: unknown } };
      expect(json.error?.message).toBe(`Invalid fixture block at index 1: ${message}`);
      expect(json.error?.code, r.text).toBe("aimock_invalid_fixture_tool_call");
      expect(m.getLastRequest()?.response.error).toBe(
        `Invalid fixture block at index 1: ${message}`,
      );
    },
  );

  it("an unvalidated file load on the Realtime WebSocket fails the response and journals the error", async () => {
    const m = await startUnvalidated(bad);
    const ws = await connectWebSocket(m.url, "/v1/realtime");
    let done: { response: { status: string; status_details: { error: unknown } } } | undefined;
    try {
      await ws.waitForMessages(1); // session.created
      ws.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        }),
      );
      await ws.waitForMessages(2);
      ws.send(JSON.stringify({ type: "response.create" }));
      // Realtime reports the rejection as a failed response.done, not an `error` event.
      const deadline = Date.now() + 5000;
      while (done === undefined) {
        done = ws
          .getMessages()
          .map((x) => JSON.parse(x) as { type: string } & NonNullable<typeof done>)
          .find((e) => e.type === "response.done");
        if (done !== undefined) break;
        if (Date.now() > deadline) {
          throw new Error(`no response.done within 5s; got: ${ws.getMessages().join("\n")}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      ws.close();
    }
    expect(done.response.status).toBe("failed");
    expect(done.response.status_details.error).toEqual({
      message: expect.stringContaining(UNSUPPORTED),
      type: "server_error",
      code: "aimock_unsupported_tool_call",
    });
    const journaled = m.getLastRequest()?.response;
    expect(journaled?.status).toBe(500);
    expect(journaled?.error).toContain(UNSUPPORTED);
  });
});

/**
 * Without responsesTools "extended" (the default), `match.toolNamespace`,
 * `customToolCalls` and `responsesBlocks` are unused data, as in 1.44.0, so
 * every validating door gives the result 1.44.0 gave for the same input. The
 * expected findings are what 1.44.0's `validateFixtures` returned.
 */
describe("default responsesTools: validating doors treat the new keys as 1.44.0 did", () => {
  const EMPTY_TOOL_CALLS = "toolCalls array is empty — fixture will never produce tool calls";
  const accepted: Array<{ id: string; entries: FixtureFileEntry[]; findings: string[][] }> = [
    {
      id: "a custom call with arguments",
      entries: [entry({ toolCalls: [], customToolCalls: [{ name: "p", arguments: "{}" }] })],
      findings: [["warning", EMPTY_TOOL_CALLS]],
    },
    {
      id: "a malformed responsesBlocks entry",
      entries: [entry({ content: "x", responsesBlocks: [{ type: "customToolCall" }] })],
      findings: [],
    },
    {
      id: "a non-string toolNamespace",
      entries: [{ match: { userMessage: "go", toolNamespace: 5 }, response: { content: "x" } }],
      findings: [],
    },
    {
      id: "an empty toolNamespace",
      entries: [{ match: { userMessage: "go", toolNamespace: "" }, response: { content: "x" } }],
      findings: [],
    },
    {
      id: "a valid custom call beside empty toolCalls",
      entries: [entry({ toolCalls: [], customToolCalls: [{ name: "p", input: "x" }] })],
      findings: [["warning", EMPTY_TOOL_CALLS]],
    },
    {
      id: "a string customToolCalls",
      entries: [entry({ content: "x", customToolCalls: "nope" })],
      findings: [],
    },
    {
      id: "blocks beside responsesBlocks",
      entries: [
        entry({
          content: "x",
          blocks: [{ type: "text", text: "x" }],
          responsesBlocks: [{ type: "text", text: "x" }],
        }),
      ],
      findings: [],
    },
    {
      id: "toolNamespace on a non-chat endpoint",
      entries: [
        {
          match: { userMessage: "go", toolNamespace: "ns", endpoint: "image" },
          response: { image: { url: "http://x/y.png" } },
        },
      ],
      findings: [],
    },
    {
      id: "a custom call on a non-chat endpoint",
      entries: [
        {
          match: { userMessage: "go", endpoint: "image" },
          response: {
            image: { url: "http://x/y.png" },
            customToolCalls: [{ name: "p", input: "x" }],
          },
        },
      ],
      findings: [],
    },
    {
      id: "two fixtures that differ only in toolNamespace",
      entries: [
        { match: { userMessage: "go", toolNamespace: "n1" }, response: { content: "1" } },
        { match: { userMessage: "go" }, response: { content: "2" } },
      ],
      findings: [["warning", "duplicate userMessage 'go' — shadows fixture 0"]],
    },
  ] as Array<{ id: string; entries: FixtureFileEntry[]; findings: string[][] }>;

  // 1.44.0 rejected these; it still rejects them for the same reason.
  const rejected: Array<{ id: string; entries: FixtureFileEntry[]; findings: string[][] }> = [
    {
      id: "empty content beside responsesBlocks",
      entries: [entry({ content: "", responsesBlocks: [{ type: "text", text: "hi" }] })],
      findings: [["error", "content is empty string"]],
    },
    {
      id: "responsesBlocks alone",
      entries: [entry({ responsesBlocks: [{ type: "text", text: "x" }] })],
      findings: [
        [
          "error",
          "response is not a recognized type (must have content, toolCalls, error, embedding, image, audio, transcription, video, json, or live)",
        ],
      ],
    },
  ] as Array<{ id: string; entries: FixtureFileEntry[]; findings: string[][] }>;

  let dir: string | undefined;
  let mock: LLMock | undefined;
  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeFixtureFile(entries: FixtureFileEntry[]): string {
    dir = mkdtempSync(join(tmpdir(), "aimock-505-default-validate-"));
    const file = join(dir, "fixtures.json");
    writeFileSync(file, JSON.stringify({ fixtures: entries }));
    return file;
  }

  function validateCli(argv: string[]): number {
    let code: number | null = null;
    runValidateCli({ argv, log: () => {}, logError: () => {}, exit: (c) => (code = c) });
    return code ?? 0;
  }

  describe.each([...accepted, ...rejected])("$id", ({ entries, findings }) => {
    const fails = findings.some(([severity]) => severity === "error");

    it("validateFixtures gives the 1.44.0 findings", () => {
      const fixtures = entries.map((e) => entryToFixture(e));
      expect(validateFixtures(fixtures).map((r) => [r.severity, r.message])).toEqual(findings);
    });

    it("addFixturesFromJSON, the control API and aimock validate agree with 1.44.0", async () => {
      const add = () => new LLMock({ port: 0, logLevel: "silent" }).addFixturesFromJSON(entries);
      if (fails) expect(add).toThrow(/Fixture validation failed/);
      else expect(add).not.toThrow();

      mock = new LLMock({ port: 0, logLevel: "silent" });
      await mock.start();
      const res = await fetch(`${mock.url}/__aimock/fixtures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixtures: entries }),
      });
      const text = await res.text();
      expect(res.status, text).toBe(fails ? 400 : 200);

      expect(validateCli([writeFixtureFile(entries)])).toBe(fails ? 1 : 0);
    });
  });

  /** Start `llmock --validate-on-load`; resolve with its exit code, or "listening". */
  function validateOnLoad(file: string, extra: string[] = []) {
    return new Promise<{ result: number | "listening"; output: string }>((done, fail) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          resolve("src/cli.ts"),
          "--validate-on-load",
          "--port",
          "0",
          "--fixtures",
          file,
          ...extra,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        fail(new Error(`llmock neither listened nor exited within 20s:\n${output}`));
      }, 20_000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (/listening on/.test(output)) {
          clearTimeout(timer);
          child.kill();
          done({ result: "listening", output });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (code) => {
        clearTimeout(timer);
        done({ result: code ?? -1, output });
      });
    });
  }

  it("llmock --validate-on-load starts with every 1.44.0-accepted shape, and extended rejects them", async () => {
    // Distinct userMessages, so the files hold no cross-fixture warning.
    const all = accepted.flatMap(({ entries }, i) =>
      entries.map((e) => ({ ...e, match: { ...e.match, userMessage: `case-${i}` } })),
    );
    const file = writeFixtureFile(all);
    const legacy = await validateOnLoad(file);
    expect(legacy.result, legacy.output).toBe("listening");
    expect(legacy.output).not.toMatch(/customToolCalls\[|responsesBlocks\[|match\.toolNamespace/);

    const ext = await validateOnLoad(file, ["--responses-tools", "extended"]);
    expect(ext.result, ext.output).toBe(1);
    expect(ext.output).toContain(
      "customToolCalls[0].input must be a string for a custom tool call",
    );
    expect(ext.output).toContain("match.toolNamespace must be a string, got number");
  }, 60_000);
});
