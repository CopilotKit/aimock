import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixtureFile } from "../fixture-loader.js";
import {
  resolve as resolveUsage,
  render as renderUsage,
  capture as captureUsage,
} from "../response/usage/codecs/anthropic.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  type GoldenServer,
} from "./golden/harness.js";

const root = fileURLToPath(new URL("../", import.meta.url));

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    result.push(child, ...descendants(child));
  });
  return result;
}

function source(name: string) {
  return ts.createSourceFile(
    name,
    readFileSync(join(root, name), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function importedCalls(file: ts.SourceFile, owner: string, exported: string) {
  const bindings = file.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      resolve(root, statement.moduleSpecifier.text.replace(/\.js$/, ".ts")) !== join(root, owner)
    )
      return [];
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return [];
    return named.elements
      .filter((binding) => (binding.propertyName ?? binding.name).text === exported)
      .map((binding) => binding.name.text);
  });
  return descendants(file).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.includes(node.expression.text),
  );
}

describe("Anthropic usage source ownership", () => {
  it.each(["messages.ts", "bedrock.ts"])(
    "%s renders every usage projection through the imported codec",
    (name) => {
      const file = source(name);
      const calls = importedCalls(file, "response/usage/codecs/anthropic.ts", "render");
      expect(calls.length).toBeGreaterThanOrEqual(name === "messages.ts" ? 13 : 5);
      const consumers = calls.map((call) => {
        const declaration = ts.findAncestor(call, ts.isFunctionDeclaration);
        return declaration?.name?.text;
      });
      const expectedConsumers =
        name === "messages.ts"
          ? [
              "buildClaudeTextStreamEvents",
              "buildClaudeToolCallStreamEvents",
              "buildClaudeTextResponse",
              "buildClaudeToolCallResponse",
              "buildClaudeContentWithToolCallsStreamEvents",
              "buildClaudeContentWithToolCallsResponse",
              "prepareClaudeMisbehavior",
            ]
          : [
              "buildBedrockTextResponse",
              "buildBedrockToolCallResponse",
              "buildBedrockBlocksResponse",
              "buildBedrockInvokeMessageStart",
              "buildBedrockInvokeMessageDelta",
            ];
      for (const consumer of expectedConsumers) expect(consumers).toContain(consumer);
      const localTokens = descendants(file).filter(
        (node) =>
          ts.isPropertyAssignment(node) &&
          (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
          ["input_tokens", "output_tokens"].includes(node.name.text),
      );
      expect(localTokens).toHaveLength(0);
      for (const call of calls) {
        expect(call.arguments[1] && ts.isStringLiteral(call.arguments[1])).toBe(true);
      }
      const resolverCalls = importedCalls(file, "response/usage/codecs/anthropic.ts", "resolve");
      expect(resolverCalls.length).toBeGreaterThan(0);
    },
  );
});

describe("Anthropic codec boundary", () => {
  it("retains native suppliedness and insertion order without rendering extra fields", () => {
    const usage = {
      completion_tokens: 8,
      input_tokens: 0,
      prompt_tokens: 4,
      output_tokens: 9,
      cache_read_input_tokens: 3,
    };
    const resolved = resolveUsage({ usage });
    expect(resolved.supplied).toBe(true);
    expect(resolved.native).toBe(usage);
    expect(Object.keys(resolved.native ?? {})).toEqual(Object.keys(usage));
    expect(renderUsage(resolved, "messages-final")).toEqual({ input_tokens: 0, output_tokens: 9 });
    expect(resolveUsage().supplied).toBe(false);
    expect(resolveUsage().native).toBeUndefined();
  });

  it("keeps ordinary delta quirks and applied estimates explicit", () => {
    const resolved = resolveUsage(
      { usage: { input_tokens: 111, output_tokens: 77 } },
      { inputTokens: 5, outputTokens: 6 },
    );
    expect(renderUsage(resolved, "messages-start", "applied-misbehavior")).toEqual({
      input_tokens: 5,
      output_tokens: 6,
    });
    expect(renderUsage(resolved, "messages-delta")).toEqual({ output_tokens: 6 });
    expect(renderUsage(resolved, "bedrock-delta")).toEqual({ output_tokens: 0 });
    expect(renderUsage(resolved, "bedrock-delta", "applied-misbehavior")).toEqual({
      output_tokens: 6,
    });
    expect(captureUsage(resolved.native, { input_tokens: 12 })).toBeUndefined();
  });
});

function evidence(id: string, value: unknown) {
  const bytes = serializeGolden(value);
  if (process.env.U1_BASELINE_DIR) {
    expect(bytes).toBe(readFileSync(join(process.env.U1_BASELINE_DIR, `${id}.json`), "utf8"));
  }
  if (process.env.U1_CAPTURE_DIR) {
    mkdirSync(process.env.U1_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.U1_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

const usages = {
  absent: undefined,
  null: "null",
  "null-members":
    '{"input_tokens":null,"output_tokens":null,"prompt_tokens":4,"completion_tokens":8}',
  zero: '{"input_tokens":0,"output_tokens":0,"prompt_tokens":4,"completion_tokens":8}',
  conflicts:
    '{"output_tokens":9,"completion_tokens":8,"input_tokens":6,"prompt_tokens":4,"cache_read_input_tokens":3,"cache_creation_input_tokens":2,"cache_creation":5}',
} as const;
const responseShapes = {
  text: { content: "A reply." },
  tool: { toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}', id: "toolu_fixed_1" }] },
  combined: {
    content: "Before",
    toolCalls: [{ name: "lookup", arguments: "{}", id: "toolu_fixed_1" }],
  },
  blocks: {
    blocks: [
      { type: "text", text: "Before" },
      { type: "toolCall", name: "lookup", arguments: "{}", id: "toolu_fixed_1" },
      { type: "text", text: "After" },
    ],
  },
} as const;
const finishes = [undefined, null, "", "stop", "tool_calls", "length", "future_reason"] as const;
const faults = ["empty-response", "refusal", "reasoning-only", "stop-length-mid-tool"] as const;
const wires = ["messages", "messages-stream", "bedrock", "bedrock-stream"] as const;
const finishWires = [...wires, "converse", "converse-stream"] as const;
type Wire = (typeof finishWires)[number];
let server: GoldenServer;

beforeAll(async () => {
  const fixtures: string[] = [];
  for (const [shape, response] of Object.entries(responseShapes)) {
    for (const [usage, raw] of Object.entries(usages)) {
      fixtures.push(
        `{"match":{"userMessage":"${shape}-${usage}"},"response":{${JSON.stringify(response).slice(1, -1)}${raw === undefined ? "" : `,"usage":${raw}`}}}`,
      );
    }
  }
  for (const [index, finishReason] of finishes.entries()) {
    for (const shape of ["text", "tool"] as const) {
      fixtures.push(
        JSON.stringify({
          match: { userMessage: `finish-${shape}-${index}` },
          response: { ...responseShapes[shape], finishReason },
        }),
      );
    }
  }
  for (const fault of faults) {
    fixtures.push(
      JSON.stringify({
        match: { userMessage: fault },
        response: {
          ...responseShapes.combined,
          usage: { input_tokens: 111, output_tokens: 77, cache_read_input_tokens: 3 },
        },
        misbehavior: { seed: 0, faults: [{ fault, rate: 1 }] },
      }),
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "aimock-anthropic-equivalence-"));
  try {
    const path = join(dir, "fixtures.json");
    writeFileSync(path, `{"fixtures":[${fixtures.join(",")}]}`);
    server = await startGoldenServer(loadFixtureFile(path), {
      enableMisbehavior: true,
      requestTransform: (request) => request,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
afterAll(async () => {
  await server?.close();
});

async function capture(wire: Wire, id: string) {
  const messages = wire.startsWith("messages");
  const converse = wire.startsWith("converse");
  const stream = wire.endsWith("-stream");
  return captureHttp(
    `${server.url}${messages ? "/v1/messages" : `/model/anthropic.claude-sonnet-4-20250514/${converse ? wire : stream ? "invoke-with-response-stream" : "invoke"}`}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 128,
        ...(messages ? { stream } : { anthropic_version: "bedrock-2023-05-31" }),
        messages: [{ role: "user", content: converse ? [{ text: id }] : id }],
        tools: [{ name: "lookup", input_schema: { type: "object" } }],
      }),
      frames: stream ? (messages ? "sse" : "aws") : undefined,
    },
  );
}

describe("actual Anthropic usage and finish equivalence", () => {
  for (const wire of wires) {
    for (const shape of Object.keys(responseShapes)) {
      for (const usage of Object.keys(usages)) {
        it(`${wire}-${shape}-${usage}`, async () => {
          const got = await capture(wire, `${shape}-${usage}`);
          expect(got.status).toBe(200);
          expect(got.tail).toBeUndefined();
          const input = usage === "conflicts" ? 6 : usage === "null-members" ? 4 : 0;
          const output = usage === "conflicts" ? 9 : usage === "null-members" ? 8 : 0;
          const bytes = serializeGolden(got);
          expect(bytes).toContain(
            `\\"usage\\":{\\"input_tokens\\":${input},\\"output_tokens\\":${output}}`,
          );
          expect(bytes).not.toContain("cache_read_input_tokens");
          if (wire.endsWith("-stream"))
            expect(bytes).toContain(
              `\\"usage\\":{\\"output_tokens\\":${wire === "bedrock-stream" ? 0 : output}}`,
            );
          evidence(`${wire}-${shape}-${usage}`, got);
        });
      }
    }
    for (const fault of faults) {
      it(`${wire}-${fault}`, async () => {
        const got = await capture(wire, fault);
        expect(got.status).toBe(200);
        const bytes = serializeGolden(got);
        expect(bytes).not.toContain("cache_read_input_tokens");
        const [input, output] = {
          "empty-response": [4, 1],
          refusal: [2, 6],
          "reasoning-only": [4, 3],
          "stop-length-mid-tool": [5, 4],
        }[fault];
        expect(bytes).toContain(
          `\\"usage\\":{\\"input_tokens\\":${input},\\"output_tokens\\":${output}}`,
        );
        if (wire.endsWith("-stream"))
          expect(bytes).toContain(`\\"usage\\":{\\"output_tokens\\":${output}}`);
        evidence(`${wire}-${fault}`, got);
      });
    }
  }
  for (const wire of finishWires) {
    for (const [index, finish] of finishes.entries()) {
      for (const shape of ["text", "tool"] as const) {
        it(`${wire}-${shape}-finish-${String(finish)}`, async () => {
          const got = await capture(wire, `finish-${shape}-${index}`);
          expect(got.status).toBe(200);
          const expected = !finish
            ? shape === "tool"
              ? "tool_use"
              : "end_turn"
            : finish === "stop"
              ? "end_turn"
              : finish === "tool_calls"
                ? "tool_use"
                : finish === "length"
                  ? "max_tokens"
                  : finish;
          expect(serializeGolden(got)).toContain(
            `\\"${wire.startsWith("converse") ? "stopReason" : "stop_reason"}\\":\\"${expected}\\"`,
          );
          evidence(`${wire}-${shape}-finish-${index}`, got);
        });
      }
    }
  }
});
