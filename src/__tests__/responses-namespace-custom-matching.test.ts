/**
 * #505 — Responses request-side matching for namespaced and custom tools
 *
 * Exercised through a real LLMock over HTTP and WebSocket, plus direct calls
 * into request conversion, fixture validation and the journal.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";
import { responsesToCompletionRequest } from "../responses.js";
import { getSystemText } from "../router.js";
import { entryToFixture, validateFixtures } from "../fixture-loader.js";
import type { ChatCompletionRequest, Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch";

type ResponsesRequest = Parameters<typeof responsesToCompletionRequest>[0];

function isResponsesRequest(value: unknown): value is ResponsesRequest {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.model === "string" && (typeof v.input === "string" || Array.isArray(v.input));
}

function loadLiteRequest(): ResponsesRequest {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("./fixtures/codex-responses-lite-request.json", import.meta.url), "utf8"),
  );
  if (!isResponsesRequest(parsed)) {
    throw new Error("codex-responses-lite-request.json is not a Responses request");
  }
  return parsed;
}

/** Real Codex 0.161.0 responses-lite request (model gpt-6-sol), texts trimmed. */
const LITE_REQUEST = loadLiteRequest();

/** getSystemText for LITE_REQUEST before #505 changed Responses request conversion. */
const LITE_SYSTEM_TEXT_ON_BASE =
  "\nYou are Codex, an agent based on GPT-6. You and the user share one workspace, and your job is to col…\n<skills_instructions>\n## Skills\nA skill is a set of local instructions to follow that is stored in a…<permissions instructions>\nFilesystem sandboxing defines which files can be read or written. `sandbo…<collaboration_mode># Collaboration Mode: Default\n\nYou are now in Default mode. Any previous instruc…\n<multi_agent_role>You are `/root`, the primary agent in a team of agents collaborating to fulfill th…\n<multi_agent_mode>Any earlier instruction enabling proactive multi-agent delegation no longer applie…";

const NS_GITHUB = {
  type: "namespace",
  name: "mcp__github",
  description: "GitHub MCP",
  tools: [
    { type: "function", name: "list_issues", parameters: { type: "object" } },
    { type: "custom", name: "raw_query", description: "free text" },
  ],
};
const NS_GITLAB = {
  type: "namespace",
  name: "mcp__gitlab",
  description: "GitLab MCP",
  tools: [{ type: "function", name: "list_merge_requests", parameters: { type: "object" } }],
};
const CUSTOM_PATCH = {
  type: "custom",
  name: "apply_patch",
  format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
};

let mock: LLMock | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

/**
 * Tool visibility for toolName / predicates and custom tool rounds are opt-in
 * (`responsesTools: "extended"`), like `toolNamespace`, which the default ignores.
 */
async function start(
  fixtures: Fixture[],
  responsesTools: "legacy" | "extended" = "extended",
): Promise<LLMock> {
  mock = new LLMock({ port: 0, responsesTools });
  mock.addFixtures(fixtures);
  await mock.start();
  return mock;
}

async function post(m: LLMock, body: Record<string, unknown>) {
  const res = await fetch(`${m.url}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5", ...body }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** One response.create over WS; fails if neither response.completed nor an error arrives in 3s. */
async function wsPost(m: LLMock, body: Record<string, unknown>): Promise<string> {
  const client = await connectWebSocket(m.url, "/v1/responses");
  try {
    client.send(JSON.stringify({ type: "response.create", model: "gpt-5", ...body }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msgs = client.getMessages();
      if (msgs.some((x) => /"response\.completed"|"type":"error"/.test(x))) return msgs.join("\n");
      await new Promise((r) => setTimeout(r, 10));
    }
    const got = client.getMessages();
    throw new Error(
      `WS request: no response.completed or error within 3s; got ${got.length} messages: ${got.join("\n")}`,
    );
  } finally {
    client.close();
  }
}

describe("tool flattening: toolName sees namespace, custom and additional_tools tools", () => {
  const fixtures: Fixture[] = [
    { match: { toolName: "list_issues" }, response: { content: "hit list_issues" } },
    { match: { toolName: "raw_query" }, response: { content: "hit raw_query" } },
    { match: { toolName: "apply_patch" }, response: { content: "hit apply_patch" } },
    { match: { toolName: "spawn_agent" }, response: { content: "hit spawn_agent" } },
  ];

  it("matches a function tool inside a namespace over HTTP and WS", async () => {
    const m = await start(fixtures);
    const r = await post(m, { input: "x", tools: [NS_GITHUB] });
    expect(r.status).toBe(200);
    expect(r.text).toContain("hit list_issues");
    expect(await wsPost(m, { input: "x", tools: [NS_GITHUB] })).toContain("hit list_issues");
  });

  it("matches a top-level custom tool and a custom tool inside a namespace", async () => {
    const m = await start(fixtures);
    expect((await post(m, { input: "x", tools: [CUSTOM_PATCH] })).text).toContain(
      "hit apply_patch",
    );
    const nsCustomOnly = { ...NS_GITHUB, tools: [NS_GITHUB.tools[1]] };
    expect((await post(m, { input: "x", tools: [nsCustomOnly] })).text).toContain("hit raw_query");
    expect(await wsPost(m, { input: "x", tools: [CUSTOM_PATCH] })).toContain("hit apply_patch");
  });

  it("matches tools carried in an additional_tools input item (captured Codex responses-lite request)", async () => {
    const m = await start(fixtures);
    const r = await post(m, LITE_REQUEST);
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain("hit spawn_agent");
    expect(await wsPost(m, LITE_REQUEST)).toContain("hit spawn_agent");
  });

  it("normalizes namespace/custom tools into tools (with namespace) and customTools (with format)", () => {
    const body: ResponsesRequest = {
      model: "gpt-5",
      input: "x",
      tools: [
        { type: "function", name: "top", parameters: { type: "object" } },
        CUSTOM_PATCH,
        NS_GITHUB,
        { type: "web_search" },
      ],
    };
    const req = responsesToCompletionRequest(body, { extended: true });
    expect(req.tools).toEqual([
      {
        type: "function",
        function: { name: "top", description: undefined, parameters: { type: "object" } },
      },
      {
        type: "function",
        namespace: "mcp__github",
        function: { name: "list_issues", description: undefined, parameters: { type: "object" } },
      },
    ]);
    expect(req.customTools).toEqual([
      { type: "custom", name: "apply_patch", format: CUSTOM_PATCH.format },
      { type: "custom", name: "raw_query", description: "free text", namespace: "mcp__github" },
    ]);
    // Default (legacy): only top-level function tools, as 1.44.0; no customTools key.
    const legacy = responsesToCompletionRequest(body);
    expect(legacy.tools).toEqual([
      {
        type: "function",
        function: { name: "top", description: undefined, parameters: { type: "object" } },
      },
    ]);
    expect("customTools" in legacy).toBe(false);
  });

  it("by default (legacy) toolName sees only top-level function tools, as 1.44.0", async () => {
    const m = await start(fixtures, "legacy");
    for (const body of [
      { input: "x", tools: [NS_GITHUB] },
      { input: "x", tools: [CUSTOM_PATCH] },
      LITE_REQUEST,
    ]) {
      expect((await post(m, body)).status).toBe(404);
    }
    // A fixture naming a namespaced tool does not shadow a later fixture.
    const m2 = await start(
      [
        { match: { toolName: "list_issues" }, response: { content: "A-inner" } },
        { match: { userMessage: "go" }, response: { content: "B-user" } },
      ],
      "legacy",
    );
    expect((await post(m2, { input: "go", tools: [NS_GITHUB] })).text).toContain("B-user");
    expect(await wsPost(m2, { input: "go", tools: [NS_GITHUB] })).toContain("B-user");
    // The journaled request and predicates see the 1.44.0 tools (top-level functions only).
    await post(m2, { input: "go", tools: [NS_GITHUB, CUSTOM_PATCH] });
    expect(m2.getLastRequest()?.body).toMatchObject({ tools: [] });
  });

  it("drops a malformed namespace or additional_tools item instead of failing the request", async () => {
    for (const mode of ["legacy", "extended"] as const) {
      const m = await start([{ match: { userMessage: "go" }, response: { content: "ok" } }], mode);
      for (const extra of [
        { tools: [{ type: "namespace", name: "", tools: [] }] },
        { tools: [{ type: "namespace", tools: [{ type: "function", name: "a" }] }] },
        { tools: [{ type: "namespace", name: "ns", tools: [null] }] },
        { tools: [{ type: "namespace", name: "ns", tools: { a: 1 } }] },
        {
          input: [
            { role: "user", content: "go" },
            { type: "additional_tools", tools: [null] },
          ],
        },
        {
          input: [
            { role: "user", content: "go" },
            { type: "tool_search_output", tools: "x" },
          ],
        },
      ]) {
        const r = await post(m, { input: "go", ...extra });
        expect(r.status, `${mode} ${JSON.stringify(extra)}: ${r.text}`).toBe(200);
      }
      expect(
        await wsPost(m, { input: "go", tools: [{ type: "namespace", name: "", tools: [] }] }),
      ).toContain('"response.completed"');
      await m.stop();
      mock = null;
    }
  });

  it("keeps the empty additional_tools system message, so system text is unchanged from before #505", async () => {
    const req = responsesToCompletionRequest(LITE_REQUEST);
    expect(getSystemText(req.messages)).toBe(LITE_SYSTEM_TEXT_ON_BASE);
    const m = await start([
      { match: { systemMessage: LITE_SYSTEM_TEXT_ON_BASE }, response: { content: "exact system" } },
    ]);
    expect((await post(m, LITE_REQUEST)).text).toContain("exact system");
  });
});

describe("toolNamespace match key", () => {
  it("is ignored in the default (legacy) mode, as 1.44.0 ignored it", async () => {
    const m = await start(
      [
        { match: { userMessage: "tns", toolNamespace: "nsX" }, response: { content: "TNS_MATCH" } },
        { match: { userMessage: "tns" }, response: { content: "TNS_FALLBACK" } },
      ],
      "legacy",
    );
    const TOP_FN = { type: "function", name: "top_fn", parameters: { type: "object" } };
    // The only offered tool is outside the namespace: the key is ignored, so
    // the first fixture still matches (HTTP, SSE and WS).
    for (const stream of [false, true]) {
      const r = await post(m, { input: "tns", tools: [TOP_FN], stream });
      expect(r.text).toContain("TNS_MATCH");
      expect(r.text).not.toContain("TNS_FALLBACK");
    }
    expect(await wsPost(m, { input: "tns", tools: [TOP_FN] })).toContain("TNS_MATCH");
    expect((await post(m, { input: "tns", tools: [NS_GITLAB] })).text).toContain("TNS_MATCH");
    // Chat Completions too.
    const chat = await fetch(`${m.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "tns" }] }),
    });
    expect(await chat.text()).toContain("TNS_MATCH");
  });

  it("filters in extended mode when no offered tool sits in the namespace", async () => {
    const m = await start([
      { match: { userMessage: "tns", toolNamespace: "nsX" }, response: { content: "TNS_MATCH" } },
      { match: { userMessage: "tns" }, response: { content: "TNS_FALLBACK" } },
    ]);
    const TOP_FN = { type: "function", name: "top_fn", parameters: { type: "object" } };
    for (const stream of [false, true]) {
      expect((await post(m, { input: "tns", tools: [TOP_FN], stream })).text).toContain(
        "TNS_FALLBACK",
      );
    }
    expect(await wsPost(m, { input: "tns", tools: [TOP_FN] })).toContain("TNS_FALLBACK");
  });

  it("alone: matches when any offered tool sits in that namespace", async () => {
    const m = await start([
      { match: { toolNamespace: "mcp__gitlab" }, response: { content: "gitlab fixture" } },
      { match: { toolNamespace: "mcp__github" }, response: { content: "github fixture" } },
    ]);
    expect((await post(m, { input: "x", tools: [NS_GITHUB] })).text).toContain("github fixture");
    expect((await post(m, { input: "x", tools: [NS_GITLAB, NS_GITHUB] })).text).toContain(
      "gitlab fixture",
    );
    // The namespaced tool is not the first offered tool: every offered tool is checked.
    expect((await post(m, { input: "x", tools: [CUSTOM_PATCH, NS_GITHUB] })).text).toContain(
      "github fixture",
    );
    expect((await post(m, { input: "x", tools: [NS_GITHUB, NS_GITLAB] })).text).toContain(
      "gitlab fixture",
    );
    expect((await post(m, { input: "x", tools: [CUSTOM_PATCH] })).status).toBe(404);
  });

  it("with toolName: requires ONE entry carrying both (exact pair), never folds a default namespace", async () => {
    const m = await start([
      {
        match: { toolName: "list_issues", toolNamespace: "mcp__gitlab" },
        response: { content: "WRONG pair" },
      },
      {
        match: { toolName: "list_issues", toolNamespace: "mcp__github" },
        response: { content: "RIGHT pair" },
      },
      {
        match: { toolName: "apply_patch", toolNamespace: "functions" },
        response: { content: "functions-ns apply_patch" },
      },
    ]);
    expect((await post(m, { input: "x", tools: [NS_GITHUB] })).text).toContain("RIGHT pair");
    // name on a top-level entry, namespace on a different entry: no single entry carries both
    const split = await post(m, {
      input: "x",
      tools: [{ type: "function", name: "list_issues", parameters: {} }, { ...NS_GITLAB }],
    });
    expect(split.status).toBe(404);
    // top-level tools have no namespace: "functions" is not folded in
    expect((await post(m, { input: "x", tools: [CUSTOM_PATCH] })).status).toBe(404);
    expect(await wsPost(m, { input: "x", tools: [NS_GITHUB] })).toContain("RIGHT pair");
  });

  it("matches the collaboration namespace in the captured responses-lite request", async () => {
    const m = await start([
      {
        match: { toolName: "spawn_agent", toolNamespace: "collaboration" },
        response: { content: "collaboration spawn_agent" },
      },
    ]);
    expect((await post(m, LITE_REQUEST)).text).toContain("collaboration spawn_agent");
  });

  it("is plumbed through file fixtures and the control API", async () => {
    const fx = entryToFixture({
      match: { toolName: "list_issues", toolNamespace: "mcp__github" },
      response: { content: "from file" },
    });
    expect(fx.match.toolNamespace).toBe("mcp__github");
    const m = await start([]);
    const added = await fetch(`${m.url}/__aimock/fixtures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fixtures: [
          {
            match: { toolName: "list_issues", toolNamespace: "mcp__gitlab" },
            response: { content: "control WRONG" },
          },
          {
            match: { toolName: "list_issues", toolNamespace: "mcp__github" },
            response: { content: "control RIGHT" },
          },
        ],
      }),
    });
    expect(added.status).toBe(200);
    expect((await post(m, { input: "x", tools: [NS_GITHUB] })).text).toContain("control RIGHT");
    const bad = await fetch(`${m.url}/__aimock/fixtures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fixtures: [{ match: { toolNamespace: "" }, response: { content: "x" } }],
      }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("match.toolNamespace must be a non-empty string");
  });

  it("validates type and emptiness, keys the duplicate check and the catch-all list on it", () => {
    const mk = (match: Record<string, unknown>): Fixture => ({
      match: match as Fixture["match"],
      response: { content: "x" },
    });
    const nonString = validateFixtures([mk({ toolNamespace: 7 })]);
    expect(
      nonString.some(
        (r) => r.severity === "error" && /toolNamespace must be a string/.test(r.message),
      ),
    ).toBe(true);
    const empty = validateFixtures([mk({ toolNamespace: "" })]);
    expect(
      empty.some(
        (r) =>
          r.severity === "error" && r.message === "match.toolNamespace must be a non-empty string",
      ),
    ).toBe(true);
    // Positive control: the same toolNamespace on both IS a duplicate.
    const sameNs = validateFixtures([
      mk({ userMessage: "u", toolNamespace: "a" }),
      mk({ userMessage: "u", toolNamespace: "a" }),
    ]);
    expect(sameNs.filter((r) => r.ref?.rule === "duplicate-user-message")).toHaveLength(1);
    // two fixtures differing only by toolNamespace are not duplicates
    const dup = validateFixtures([
      mk({ userMessage: "u", toolNamespace: "a" }),
      mk({ userMessage: "u", toolNamespace: "b" }),
    ]);
    expect(dup.some((r) => r.ref?.rule === "duplicate-user-message")).toBe(false);
    // Positive control: a fixture with no discriminator IS a catch-all.
    const bare = validateFixtures([mk({}), mk({ userMessage: "u" })]);
    expect(bare.filter((r) => r.ref?.rule === "catch-all-not-last")).toHaveLength(1);
    // a toolNamespace-only fixture is not a catch-all
    const catchAll = validateFixtures([mk({ toolNamespace: "a" }), mk({ userMessage: "u" })]);
    expect(catchAll.some((r) => r.ref?.rule === "catch-all-not-last")).toBe(false);
  });

  it("journal: sequenced siblings differing only in toolNamespace do not share a count", () => {
    const a: Fixture = {
      match: { toolName: "t", toolNamespace: "a", sequenceIndex: 0 },
      response: { content: "a" },
    };
    const b: Fixture = {
      match: { toolName: "t", toolNamespace: "b", sequenceIndex: 0 },
      response: { content: "b" },
    };
    // Positive control: a sibling with the same toolNamespace shares the count.
    const a1: Fixture = {
      match: { toolName: "t", toolNamespace: "a", sequenceIndex: 1 },
      response: { content: "a1" },
    };
    const journal = new Journal();
    journal.incrementFixtureMatchCount(a, [a, b, a1]);
    expect(journal.getFixtureMatchCount(a)).toBe(1);
    expect(journal.getFixtureMatchCount(a1)).toBe(1);
    expect(journal.getFixtureMatchCount(b)).toBe(0);
  });
});

describe("predicate sees namespace on tools and on history tool calls", () => {
  it("exposes ToolDefinition.namespace, ToolCallMessage.namespace and custom_tool_calls (extended)", async () => {
    let seen: ChatCompletionRequest | undefined;
    const m = await start([
      {
        match: {
          predicate: (req) => {
            seen = req;
            return true;
          },
        },
        response: { content: "seen" },
      },
    ]);
    const r = await post(m, {
      input: [
        { role: "user", content: "go" },
        {
          type: "function_call",
          call_id: "call_a",
          namespace: "mcp__github",
          name: "list_issues",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_a", output: "[]" },
        { type: "custom_tool_call", call_id: "call_b", name: "apply_patch", input: PATCH },
        { type: "custom_tool_call_output", call_id: "call_b", output: "Done!" },
        {
          type: "custom_tool_call",
          call_id: "call_c",
          namespace: "sandbox",
          name: "run",
          input: "ls -la",
        },
        { type: "custom_tool_call_output", call_id: "call_c", output: "total 0" },
      ],
      tools: [NS_GITHUB],
    });
    expect(r.status).toBe(200);
    expect(seen!.tools?.[0]).toMatchObject({ namespace: "mcp__github" });
    const toolCalls = seen!.messages.flatMap((msg) => msg.tool_calls ?? []);
    expect(toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        namespace: "mcp__github",
        function: { name: "list_issues", arguments: "{}" },
      },
    ]);
    const customCalls = seen!.messages.flatMap((msg) => msg.custom_tool_calls ?? []);
    expect(customCalls).toEqual([
      { id: "call_b", type: "custom", name: "apply_patch", input: PATCH },
      { id: "call_c", type: "custom", name: "run", input: "ls -la", namespace: "sandbox" },
    ]);
    const tools = seen!.messages.filter((msg) => msg.role === "tool");
    expect(tools.map((t) => [t.tool_call_id, t.content])).toEqual([
      ["call_a", "[]"],
      ["call_b", "Done!"],
      ["call_c", "total 0"],
    ]);
  });
});

describe("custom_tool_call / custom_tool_call_output history counts as a tool round", () => {
  const history = (output: unknown) => [
    { role: "user", content: [{ type: "input_text", text: "apply it" }] },
    { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: PATCH },
    { type: "custom_tool_call_output", call_id: "call_p", output },
  ];

  it("drives hasToolResult, toolCallId and toolResultContains (string and array output) over HTTP and WS", async () => {
    const m = await start([
      {
        match: { userMessage: "apply it", toolResultContains: "Updated files" },
        response: { content: "contains matched" },
      },
      {
        match: { userMessage: "apply it", toolCallId: "call_p", hasToolResult: true },
        response: { content: "tool round matched" },
      },
      {
        match: { userMessage: "apply it", hasToolResult: false },
        response: { content: "turn 0 again" },
      },
    ]);
    expect((await post(m, { input: history("Done!") })).text).toContain("tool round matched");
    expect((await post(m, { input: history("Success. Updated files: a") })).text).toContain(
      "contains matched",
    );
    // The needle spans both parts, so they must be joined with nothing between them.
    expect(
      (
        await post(m, {
          input: history([
            { type: "input_text", text: "Success. Updated " },
            { type: "input_text", text: "files: a" },
          ]),
        })
      ).text,
    ).toContain("contains matched");
    // Only input_text parts are tool output text: a stray `text` on another
    // part type does not reach toolResultContains.
    expect(
      (
        await post(m, {
          input: history([
            { type: "input_text", text: "Success. " },
            { type: "input_file", text: "Updated files: a" },
          ]),
        })
      ).text,
    ).toContain("tool round matched");
    expect(await wsPost(m, { input: history("Done!") })).toContain("tool round matched");
  });

  it("counts the custom call in turnIndex", async () => {
    const m = await start([
      { match: { userMessage: "apply it", turnIndex: 1 }, response: { content: "turn one" } },
      { match: { userMessage: "apply it", turnIndex: 0 }, response: { content: "turn zero" } },
    ]);
    expect((await post(m, { input: history("Done!") })).text).toContain("turn one");
  });

  it("synthesizes the assistant tool call for a bare custom_tool_call_output", async () => {
    let seen: ChatCompletionRequest | undefined;
    const m = await start([
      // turnIndex counts assistant messages, so only the synthesized
      // assistant tool call can make this a turn-1 request.
      {
        match: {
          toolCallId: "call_orphan",
          turnIndex: 1,
          predicate: (req) => {
            seen = req;
            return true;
          },
        },
        response: { content: "orphan output matched" },
      },
      { match: { toolCallId: "call_orphan" }, response: { content: "no synthesis" } },
    ]);
    const r = await post(m, {
      input: [
        { role: "user", content: "x" },
        { type: "custom_tool_call_output", call_id: "call_orphan", output: "ok" },
      ],
    });
    expect(r.text).toContain("orphan output matched");
    expect(seen?.messages.map((msg) => msg.role)).toEqual(["user", "assistant", "tool"]);
    expect(seen?.messages[1].custom_tool_calls?.map((tc) => tc.id)).toEqual(["call_orphan"]);
  });

  it("by default (legacy) custom tool call history is not counted, as 1.44.0", async () => {
    const m = await start(
      [
        { match: { userMessage: "apply it", hasToolResult: true }, response: { content: "R" } },
        { match: { userMessage: "apply it", toolCallId: "call_p" }, response: { content: "I" } },
        { match: { userMessage: "apply it", turnIndex: 1 }, response: { content: "T1" } },
        { match: { userMessage: "apply it" }, response: { content: "plain" } },
      ],
      "legacy",
    );
    expect((await post(m, { input: history("Done!") })).text).toContain("plain");
    expect(await wsPost(m, { input: history("Done!") })).toContain("plain");
  });

  // Deliberately asymmetric with custom_tool_call_output (whose array output
  // is flattened to text above): function_call_output keeps its older
  // behaviour so existing fixtures match the same requests as before.
  it("leaves an array function_call_output out of toolResultContains, as before #505", async () => {
    const m = await start([
      { match: { toolResultContains: "Updated files" }, response: { content: "contains matched" } },
      { match: { hasToolResult: true }, response: { content: "plain tool round" } },
    ]);
    const r = await post(m, {
      input: [
        { role: "user", content: "x" },
        { type: "function_call", call_id: "call_f", name: "f", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_f",
          output: [{ type: "input_text", text: "Updated files: a" }],
        },
      ],
    });
    expect(r.text).toContain("plain tool round");
  });
});

describe("responsesTools option", () => {
  it("rejects a value other than legacy / extended at start", async () => {
    const bad = new LLMock({
      port: 0,
      responsesTools: "Extended" as unknown as "extended",
    });
    await expect(bad.start()).rejects.toThrow(
      'responsesTools must be "legacy" or "extended", got "Extended"',
    );
  });
});
