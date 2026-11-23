import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { Fixture, FixtureResponse } from "../types.js";
import {
  captureHttp,
  expectGolden,
  startGoldenServer,
  type GoldenServer,
} from "./golden/harness.js";

const prompt = "test prompt";
const tool = { id: "call_fixed", name: "lookup", arguments: '{"q":"x"}' };
const shapes = {
  text: { content: "hello world!" },
  tools: { toolCalls: [tool] },
  combined: { content: "hello world!", toolCalls: [tool] },
  blocks: {
    blocks: [
      { type: "text", text: "hello world!" },
      { type: "toolCall", ...tool },
    ],
  },
} satisfies Record<string, FixtureResponse>;
const tokenKeys = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
] as const;
const usages: Array<{ name: string; value?: Record<string, unknown>; expected?: number[] }> = [
  { name: "absent", expected: [3, 3, 6] },
  {
    name: "cost-only",
    value: { cost: 0.25, cost_details: { upstream_inference_prompt_cost: 0.01 } },
    expected: [3, 3, 6],
  },
  ...tokenKeys.flatMap((key) => [
    { name: `${key.toLowerCase()}-zero`, value: { [key]: 0 }, expected: [0, 0, 0] },
    { name: `${key.toLowerCase()}-null`, value: { [key]: null }, expected: [0, 0, 0] },
  ]),
  {
    name: "conflicting-aliases",
    value: {
      prompt_tokens: 3,
      input_tokens: 9,
      promptTokenCount: 99,
      completion_tokens: 4,
      output_tokens: 8,
      candidatesTokenCount: 88,
      total_tokens: 20,
      totalTokenCount: 200,
    },
    expected: [3, 4, 20],
  },
  {
    name: "null-native-aliases",
    value: {
      prompt_tokens: null,
      input_tokens: 7,
      promptTokenCount: 99,
      completion_tokens: null,
      output_tokens: 8,
      candidatesTokenCount: 88,
      total_tokens: null,
      totalTokenCount: 23,
    },
    expected: [7, 8, 23],
  },
  {
    name: "ordered-extras",
    value: {
      last: 7,
      cost_details: { provider_detail: 1 },
      cost: null,
      prompt_tokens_details: {
        audio_tokens: 4,
        cached_tokens: null,
        cache_write_tokens: 0,
        unknown: null,
      },
      completion_tokens_details: { extra: 9, reasoning_tokens: null },
      is_byok: false,
      first: 0,
      nested_unknown: { z: null },
      ["__proto__"]: { polluted: true },
      constructor: 5,
      prototype: 6,
      native_tokens_prompt: 3,
    },
  },
  {
    name: "details-without-cost",
    value: {
      cost_details: { upstream_inference_cost: 9 },
      is_byok: true,
      native_tokens_completion: 0,
    },
  },
];
const servers: GoldenServer[] = [];
afterEach(async () => {
  const outcomes = await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  for (const result of outcomes) if (result.status === "rejected") throw result.reason;
});

async function exchange(
  name: string,
  response: FixtureResponse,
  usage: Record<string, unknown> | undefined,
  openRouter: boolean,
  stream: boolean,
  options: {
    fault?: "refusal" | "stop-length-mid-tool";
    includeUsage?: boolean;
    user?: string;
  } = {},
) {
  const scripted = { ...response };
  if (openRouter) Reflect.set(scripted, "id", "w1-fixed");
  // Direct fixture serving already accepts runtime null/native-extra values.
  if (usage !== undefined) Reflect.set(scripted, "usage", usage);
  const fixture: Fixture = {
    match: { userMessage: options.user ?? prompt },
    response: scripted,
    ...(options.fault
      ? { misbehavior: { seed: 0, faults: [{ fault: options.fault, rate: 1 }] } }
      : {}),
  };
  const server = await startGoldenServer([fixture], {
    enableMisbehavior: options.fault !== undefined,
  });
  servers.push(server);
  const result = await captureHttp(
    `${server.url}${openRouter ? "/api/v1" : "/v1"}/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: options.user ?? prompt }],
        stream,
        stream_options: { include_usage: options.includeUsage ?? true },
      }),
      ...(stream ? { frames: "sse" as const } : {}),
    },
  );
  expect(result.status).toBe(200);
  if (stream) expect(result.frames?.at(-1)).toBe("data: [DONE]");
  expectGolden("response-w1", name, result);
  const frames = stream ? result.frames : [result.body];
  const bodies = (frames ?? []).flatMap((frame) => {
    if (typeof frame !== "string") throw new Error("Expected HTTP/SSE text");
    const text = stream
      ? frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6)
      : frame;
    if (!text || text === "[DONE]") return [];
    return [JSON.parse(text)];
  });
  const wireUsage = bodies.filter((body) => body.usage !== undefined).map((body) => body.usage);
  console.log(
    JSON.stringify({
      case: name,
      status: result.status,
      usage: wireUsage,
      frameCount: result.frames?.length,
    }),
  );
  return wireUsage;
}

describe("W1 real HTTP and complete SSE baseline", () => {
  for (const openRouter of [false, true]) {
    for (const stream of [false, true]) {
      const wire = `${openRouter ? "openrouter" : "openai"}-${stream ? "sse" : "http"}`;
      for (const usage of usages) {
        it(`${wire}-text-${usage.name}`, async () => {
          const wireUsage = await exchange(
            `${wire}-text-${usage.name}`,
            shapes.text,
            usage.value,
            openRouter,
            stream,
          );
          expect(wireUsage).toHaveLength(1);
          if (usage.expected)
            expect([
              wireUsage[0].prompt_tokens,
              wireUsage[0].completion_tokens,
              wireUsage[0].total_tokens,
            ]).toEqual(usage.expected);
          if (openRouter && usage.name === "ordered-extras") {
            expect(Object.keys(wireUsage[0])).toEqual([
              "prompt_tokens",
              "completion_tokens",
              "total_tokens",
              "cost",
              "cost_details",
              "prompt_tokens_details",
              "completion_tokens_details",
              "is_byok",
              "last",
              "first",
              "nested_unknown",
              "native_tokens_prompt",
            ]);
            expect(wireUsage[0].is_byok).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(wireUsage[0], "__proto__")).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(wireUsage[0], "constructor")).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(wireUsage[0], "prototype")).toBe(false);
          }
        });
      }
      for (const shape of ["tools", "combined", "blocks"] as const) {
        for (const usage of usages.filter((entry) =>
          ["absent", "cost-only", "conflicting-aliases", "ordered-extras"].includes(entry.name),
        )) {
          it(`${wire}-${shape}-${usage.name}`, async () => {
            expect(
              await exchange(
                `${wire}-${shape}-${usage.name}`,
                shapes[shape],
                usage.value,
                openRouter,
                stream,
              ),
            ).toHaveLength(1);
          });
        }
      }
      for (const fault of ["refusal", "stop-length-mid-tool"] as const) {
        it(`${wire}-applied-${fault}`, async () => {
          const usage = await exchange(
            `${wire}-applied-${fault}`,
            shapes.combined,
            {
              prompt_tokens: 111,
              completion_tokens: 77,
              total_tokens: 999,
              cost: 0,
              is_byok: false,
            },
            openRouter,
            stream,
            { fault },
          );
          expect(usage).toHaveLength(1);
          expect(usage[0].prompt_tokens).not.toBe(111);
          expect(usage[0].total_tokens).not.toBe(999);
        });
      }
      it(`${wire}-empty-text-estimation`, async () => {
        const usage = await exchange(
          `${wire}-empty-text-estimation`,
          { content: "" },
          undefined,
          openRouter,
          stream,
          { user: "" },
        );
        expect([usage[0].prompt_tokens, usage[0].completion_tokens, usage[0].total_tokens]).toEqual(
          [1, 1, 2],
        );
      });
    }
    it(`${openRouter ? "openrouter" : "openai"}-sse-usage-gate`, async () => {
      const usage = await exchange(
        `${openRouter ? "openrouter" : "openai"}-sse-usage-gate`,
        shapes.text,
        { cost: 0.5 },
        openRouter,
        true,
        { includeUsage: false },
      );
      expect(usage).toHaveLength(openRouter ? 1 : 0);
    });
  }
});

function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(process.cwd(), path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}
function namedFunction(file: ts.SourceFile, name: string) {
  const functions: Array<ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction> = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) functions.push(node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      functions.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(functions).toHaveLength(1);
  return functions[0];
}
function calls(node: ts.Node) {
  const result: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) result.push(child.expression.getText());
    ts.forEachChild(child, visit);
  };
  visit(node);
  return result;
}
describe("W1 adoption ownership", () => {
  it("helpers retain a delegating OpenAI resolve/render wrapper", () => {
    const file = source("src/helpers.ts");
    const wrapper = namedFunction(file, "resolveUsage");
    expect(calls(wrapper)).toEqual(["renderOpenAIUsage", "resolveOpenAIUsage"]);
    expect(wrapper.getText()).not.toContain("hasExplicitTokens");
    const imported = file.statements
      .filter(ts.isImportDeclaration)
      .find(
        (entry) =>
          ts.isStringLiteral(entry.moduleSpecifier) &&
          entry.moduleSpecifier.text === "./response/usage/codecs/openai.js",
      );
    expect(imported).toBeDefined();
    const server = source("src/server.ts");
    expect(calls(namedFunction(server, "resolveStreamingUsageTokens"))).toEqual(["resolveUsage"]);
  });
  it("OpenRouter delegates selection and rendering without local usage tables", () => {
    const file = source("src/openrouter-chat.ts");
    expect(calls(namedFunction(file, "resolveOpenRouterShaping"))).toContain(
      "resolveOpenRouterUsage",
    );
    expect(calls(namedFunction(file, "augmentUsage"))).toEqual(["renderOpenRouterUsage"]);
    for (const name of ["SHAPED_OR_CANONICAL_USAGE_KEYS", "UNSAFE_PROTO_KEYS"])
      expect(
        file.statements.some(
          (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
              (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
            ),
        ),
      ).toBe(false);
    expect(namedFunction(file, "resolveOpenRouterShaping").getText()).not.toContain(
      "Object.entries",
    );
  });
});
