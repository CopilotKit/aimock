import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { encodeEventStreamFrame } from "../aws-event-stream.js";
import {
  loadFixtureFile,
  markFixtureResponsesToolsExtended,
  validateFixtures,
} from "../fixture-loader.js";
import { collapseStreamingResponse } from "../stream-collapse.js";
import type { RecordProviderKey } from "../types.js";
import { serializeGolden, startGoldenServer, startStubUpstream } from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    result.push(child, ...descendants(child));
  });
  return result;
}

function ownedCalls(file: ts.SourceFile, checker: ts.TypeChecker, exported: string) {
  const bindings = file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return [];
    if (
      resolve(dirname(file.fileName), statement.moduleSpecifier.text.replace(/\.js$/, ".ts")) !==
      join(sourceRoot, "response/usage/recording.ts")
    )
      return [];
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return [];
    return named.elements
      .filter((binding) => (binding.propertyName ?? binding.name).text === exported)
      .map((binding) => checker.getSymbolAtLocation(binding.name));
  });
  return descendants(file).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.includes(checker.getSymbolAtLocation(node.expression)),
  );
}

describe("recording source ownership", () => {
  it.each([
    [
      "stream-collapse.ts",
      [
        "collapseOpenAISSEWithResponsesTools",
        "collapseAnthropicSSE",
        "collapseGeminiSSE",
        "collapseOllamaNDJSON",
        "collapseCohereSSE",
        "collapseBedrockEventStream",
        "collapseGeminiInteractionsSSE",
        "collapseStreamingResponseWithResponsesTools",
      ],
    ],
    ["recorder.ts", ["proxyAndRecord", "buildFixtureResponse", "sanitizeRecordedUsage"]],
  ] as const)("%s delegates capture from every consumer", (name, consumers) => {
    const program = ts.createProgram([join(sourceRoot, name)], { noResolve: true, noLib: true });
    const file = program.getSourceFile(join(sourceRoot, name))!;
    const calls = ownedCalls(file, program.getTypeChecker(), "captureUsage");
    const owners = calls.map((call) => ts.findAncestor(call, ts.isFunctionDeclaration)?.name?.text);
    for (const consumer of consumers) expect(owners, consumer).toContain(consumer);
    const localReaders = descendants(file).filter(
      (node) =>
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "usage" &&
        ts.isIdentifier(node.expression) &&
        ["parsed", "obj"].includes(node.expression.text),
    );
    expect(localReaders).toHaveLength(0);
  });
});

const usage = {
  prompt_tokens: 12,
  completion_tokens: 5,
  total_tokens: 17,
  cost: 0.002,
  is_byok: false,
  prompt_tokens_details: { cached_tokens: 0, invalid: "drop" },
  unknown: "drop",
};
function sse(events: Record<string, unknown>[]) {
  return events
    .map(
      (event) => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}
function aws(events: Record<string, unknown>[], invoke: boolean) {
  return Buffer.concat(
    events.map((event) =>
      encodeEventStreamFrame(
        {
          ":event-type": invoke ? "chunk" : String(Object.keys(event)[0]),
          ":content-type": "application/json",
          ":message-type": "event",
        },
        Buffer.from(
          JSON.stringify(
            invoke ? { bytes: Buffer.from(JSON.stringify(event)).toString("base64") } : event,
          ),
        ),
      ),
    ),
  );
}
const anthropic = [
  { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  {
    type: "message_delta",
    usage: { input_tokens: null, output_tokens: 5 },
    delta: { stop_reason: "end_turn" },
  },
];
const openai = [
  { choices: [{ delta: { content: "Hello" } }], usage: { prompt_tokens: 1 } },
  { choices: [], usage },
  { choices: [], usage: {} },
  { choices: [], usage: null },
  { choices: [], usage: [] },
];
const gemini = {
  candidates: [{ content: { parts: [{ text: "Hello" }] } }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
};
const interactions = [
  { event_type: "content.delta", delta: { type: "text", text: "Hello" } },
  { event_type: "interaction.completed", interaction: { usage } },
];
const ollama = { message: { content: "Hello" }, done: true, prompt_eval_count: 12, eval_count: 5 };
const cohere = {
  finish_reason: "COMPLETE",
  message: { content: [{ type: "text", text: "Hello" }] },
  usage: { tokens: { input_tokens: 12, output_tokens: 5 } },
};
const converse = [
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
  { metadata: { usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } } },
];

interface Case {
  id: string;
  provider: RecordProviderKey;
  contentType: string;
  body: string | Buffer;
  path?: string;
  request?: Record<string, unknown>;
  transcription?: boolean;
}
const streamCases: Case[] = [
  {
    id: "openai-last-nonempty",
    provider: "openai",
    contentType: "text/event-stream",
    body: sse(openai),
  },
  {
    id: "anthropic-omit",
    provider: "anthropic",
    contentType: "text/event-stream",
    body: sse(anthropic),
  },
  { id: "gemini-omit", provider: "gemini", contentType: "text/event-stream", body: sse([gemini]) },
  {
    id: "ollama-omit",
    provider: "ollama",
    contentType: "application/x-ndjson",
    body: JSON.stringify(ollama) + "\n",
  },
  {
    id: "cohere-omit",
    provider: "cohere",
    contentType: "text/event-stream",
    body: sse([
      { type: "content-delta", delta: { message: { content: { text: "Hello" } } } },
      { type: "message-end", delta: cohere },
    ]),
  },
  {
    id: "invoke-omit",
    provider: "bedrock",
    contentType: "application/vnd.amazon.eventstream",
    body: aws(anthropic, true),
  },
  {
    id: "converse-omit",
    provider: "bedrock",
    contentType: "application/vnd.amazon.eventstream",
    body: aws(converse, false),
  },
  {
    id: "interactions-omit",
    provider: "gemini-interactions",
    contentType: "text/event-stream",
    body: sse(interactions),
  },
  {
    id: "transcription-separate",
    provider: "openai",
    contentType: "text/event-stream",
    body: sse([
      { type: "transcript.text.done", text: "Hello", usage: { type: "tokens", total_tokens: 17 } },
    ]),
  },
  {
    id: "ndjson-before-provider",
    provider: "anthropic",
    contentType: "application/x-ndjson",
    body: JSON.stringify(ollama) + "\n",
  },
  {
    id: "aws-before-provider",
    provider: "openai",
    contentType: "APPLICATION/VND.AMAZON.EVENTSTREAM",
    body: aws(converse, false),
  },
  {
    id: "sse-unknown-fallback",
    provider: "ollama",
    contentType: "text/event-stream",
    body: sse(openai),
  },
  {
    id: "sse-mismatched-body",
    provider: "anthropic",
    contentType: "text/event-stream",
    body: sse(openai),
  },
  {
    id: "nonstream-contenttype",
    provider: "openai",
    contentType: "application/json",
    body: sse(openai),
  },
  {
    id: "bedrock-sse-invoke",
    provider: "bedrock",
    contentType: "text/event-stream",
    body: sse(anthropic),
  },
];
const finalBodies: Array<[string, Record<string, unknown>]> = [
  ["openai", { choices: [{ message: { content: "Hello" } }], usage }],
  ["anthropic", { content: [{ type: "text", text: "Hello" }], usage }],
  ["gemini", gemini],
  ["ollama", ollama],
  ["ollama-generate", { response: "Hello", done: true, eval_count: 5 }],
  ["cohere", cohere],
  ["converse", { output: { message: { content: [{ text: "Hello" }] } }, usage }],
  ["interactions", { outputs: [{ type: "text", text: "Hello" }], usage }],
  [
    "ambiguous-openai-first",
    {
      choices: [{ message: { content: "OpenAI" } }],
      content: [{ type: "text", text: "Anthropic" }],
      ...gemini,
      usage,
    },
  ],
  [
    "transcription-markers",
    { text: "Hello", task: "transcribe", usage: { type: "tokens", total_tokens: 17 } },
  ],
  ["transcription-array-legacy", { text: "Hello", task: "transcribe", usage: [1, 2] }],
  ["transcription-wrong-operation", { text: "Hello", usage: { total_tokens: 17 } }],
  ["unknown", { strange: "Hello", usage }],
];

function nativeRoute(c: Case): Case {
  const messages = [{ role: "user", content: c.id }];
  switch (c.provider) {
    case "anthropic":
      return {
        ...c,
        path: "/v1/messages",
        request: { model: "claude-sonnet-4-5", max_tokens: 64, stream: true, messages },
      };
    case "bedrock":
      return {
        ...c,
        path: `/model/anthropic.claude-sonnet-4-5-v1/${c.id === "converse-omit" ? "converse-stream" : "invoke-with-response-stream"}`,
        request: {
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 64,
          messages:
            c.id === "converse-omit" ? [{ role: "user", content: [{ text: c.id }] }] : messages,
        },
      };
    case "gemini":
      return {
        ...c,
        path: "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
        request: { contents: [{ role: "user", parts: [{ text: c.id }] }] },
      };
    case "gemini-interactions":
      return {
        ...c,
        path: "/v1beta/interactions",
        request: { model: "gemini-2.5-flash", input: c.id, stream: true },
      };
    case "ollama":
      return { ...c, path: "/api/chat", request: { model: "llama3", messages, stream: true } };
    case "cohere":
      return {
        ...c,
        path: "/v2/chat",
        request: { model: "command-r-plus", messages, stream: true },
      };
    default:
      return c;
  }
}

function assertCapture<T>(id: string, value: T): T {
  const bytes = serializeGolden(value);
  const directory = process.env.U2_CAPTURE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${id}.json`);
    if (process.env.U2_CAPTURE_WRITE === "1") writeFileSync(file, bytes);
    else expect(bytes, id).toBe(readFileSync(file, "utf8"));
  }
  return value;
}

async function record(c: Case, inspectFile?: (path: string) => void) {
  const fixturePath = mkdtempSync(join(tmpdir(), "aimock-u2-"));
  const upstream = await startStubUpstream((_req, res) => {
    res.writeHead(200, { "content-type": c.contentType });
    res.end(c.body);
  });
  let server: Awaited<ReturnType<typeof startGoldenServer>> | undefined;
  try {
    server = await startGoldenServer([], {
      record: {
        providers: { [c.provider === "gemini-interactions" ? "gemini" : c.provider]: upstream.url },
        fixturePath,
      },
    });
    const form = new FormData();
    if (c.transcription) {
      form.set("model", "gpt-4o-transcribe");
      form.set("file", new Blob(["audio"]), "u2.wav");
    }
    const response = await fetch(`${server.url}${c.path ?? "/v1/chat/completions"}`, {
      method: "POST",
      headers: c.transcription ? {} : { "content-type": "application/json" },
      body: c.transcription
        ? form
        : JSON.stringify(
            c.request ?? { model: "gpt-4o-mini", messages: [{ role: "user", content: c.id }] },
          ),
    });
    expect(response.status, await response.text()).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    let files: string[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      files = readdirSync(fixturePath).filter((name) => name.endsWith(".json"));
      if (files.length) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(files).toHaveLength(1);
    inspectFile?.(join(fixturePath, files[0]!));
    const file = JSON.parse(readFileSync(join(fixturePath, files[0]!), "utf8")) as {
      fixtures: Array<Record<string, unknown>>;
    };
    for (const fixture of file.fixtures) {
      const timings = fixture.recordedTimings as
        | { ttftMs: number; interChunkDelaysMs: number[]; totalDurationMs: number }
        | undefined;
      if (timings) {
        for (const value of [
          timings.ttftMs,
          ...timings.interChunkDelaysMs,
          timings.totalDurationMs,
        ])
          expect(Number.isInteger(value) && value >= 0).toBe(true);
        fixture.recordedTimings = {
          ttftMs: "<ms>",
          interChunkDelaysMs: timings.interChunkDelaysMs.map(() => "<ms>"),
          totalDurationMs: "<ms>",
        };
      }
    }
    return assertCapture(`record-${c.id}`, file);
  } finally {
    try {
      await server?.close();
    } finally {
      await upstream.close();
      rmSync(fixturePath, { recursive: true, force: true });
    }
  }
}

describe("actual collapse preservation matrix", () => {
  // These outcomes match the pre-refactor U2 captures, including null and empty content.
  const expected = new Map<string, ReturnType<typeof collapseStreamingResponse>>([
    ["openai-last-nonempty", { content: "Hello", usage }],
    ["anthropic-omit", { content: "Hello" }],
    ["gemini-omit", { content: "Hello" }],
    ["ollama-omit", { content: "Hello" }],
    ["cohere-omit", { content: "Hello" }],
    ["invoke-omit", { content: "Hello" }],
    ["converse-omit", { content: "Hello" }],
    ["interactions-omit", { content: "Hello" }],
    [
      "transcription-separate",
      {
        transcription: { text: "Hello", usage: { type: "tokens", total_tokens: 17 } },
        content: "",
      },
    ],
    ["ndjson-before-provider", { content: "Hello" }],
    ["aws-before-provider", { content: "Hello" }],
    ["sse-unknown-fallback", { content: "Hello", usage }],
    ["sse-mismatched-body", { content: "" }],
    ["nonstream-contenttype", null],
    ["bedrock-sse-invoke", { content: "Hello" }],
  ]);
  it.each(streamCases)("$id", (c) => {
    const result = assertCapture(
      `collapse-${c.id}`,
      collapseStreamingResponse(c.contentType, c.provider, c.body),
    );
    expect(expected.has(c.id)).toBe(true);
    expect(result).toEqual(expected.get(c.id));
  });
});

describe("actual record-mode preservation matrix", () => {
  it.each(finalBodies)("nonstream %s", async (id, body) => {
    const file = await record({
      id,
      provider: "openai",
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    const response = file.fixtures[0]!.response as Record<string, unknown>;
    if (["openai", "ambiguous-openai-first"].includes(id)) {
      expect(response.usage).toEqual({
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        cost: 0.002,
        is_byok: false,
        prompt_tokens_details: { cached_tokens: 0 },
      });
    } else expect(response.usage).toBeUndefined();
    if (id === "transcription-markers" || id === "transcription-array-legacy") {
      expect(response.transcription).toEqual({
        text: "Hello",
        usage: id === "transcription-array-legacy" ? [1, 2] : { type: "tokens", total_tokens: 17 },
      });
    }
  });
  it.each(streamCases.filter((c) => c.id !== "nonstream-contenttype"))("stream $id", async (c) => {
    // The OpenAI request route intentionally sends the selected upstream wire through
    // content-type precedence; matching provider routes are covered by recorder goldens.
    const inspectFile = [
      "anthropic-omit",
      "bedrock-sse-invoke",
      "cohere-omit",
      "gemini-omit",
      "interactions-omit",
    ].includes(c.id)
      ? (path: string) => {
          // The pre-refactor artifacts reject these deliberate OpenAI-route mismatches.
          for (const extended of [false, true]) {
            const fixtures = loadFixtureFile(path);
            if (extended) fixtures.forEach(markFixtureResponsesToolsExtended);
            expect(validateFixtures(fixtures)).toEqual([
              { severity: "error", fixtureIndex: 0, message: "content is empty string" },
            ]);
          }
        }
      : undefined;
    const file = await record({ ...c, id: `stream-${c.id}`, provider: "openai" }, inspectFile);
    if (c.id === "openai-last-nonempty") {
      const response = file.fixtures[0]!.response as Record<string, unknown>;
      expect(response.usage).toEqual({
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        cost: 0.002,
        is_byok: false,
        prompt_tokens_details: { cached_tokens: 0 },
      });
    }
  });
  it.each(streamCases.slice(0, 8))("native stream $id", async (c) => {
    const file = await record(nativeRoute(c));
    const response = file.fixtures[0]!.response as Record<string, unknown>;
    if (c.id === "openai-last-nonempty") {
      expect(response.usage).toEqual({
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        cost: 0.002,
        is_byok: false,
        prompt_tokens_details: { cached_tokens: 0 },
      });
    } else expect(response.usage).toBeUndefined();
    expect(response.content).toBe("Hello");
  });
  it.each(["transcriptions", "translations"])("transcription operation %s", async (operation) => {
    const file = await record({
      id: `operation-${operation}`,
      provider: "openai",
      path: `/v1/audio/${operation}`,
      transcription: true,
      contentType: "application/json",
      body: JSON.stringify({ text: "Hello", usage: { type: "tokens", total_tokens: 17 } }),
    });
    expect(file.fixtures[0]!.response).toEqual({
      transcription: { text: "Hello", usage: { type: "tokens", total_tokens: 17 } },
    });
  });
});
