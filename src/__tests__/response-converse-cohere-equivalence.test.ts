import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixtureFile } from "../fixture-loader.js";
import { isJsonObject } from "../helpers.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  type GoldenServer,
} from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    result.push(child, ...descendants(child));
  });
  return result;
}

function importedCalls(file: ts.SourceFile, checker: ts.TypeChecker, owner: string, name: string) {
  const bindings = file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return [];
    if (
      resolve(dirname(file.fileName), statement.moduleSpecifier.text.replace(/\.js$/, ".ts")) !==
      join(sourceRoot, owner)
    )
      return [];
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return [];
    return named.elements
      .filter((binding) => (binding.propertyName ?? binding.name).text === name)
      .flatMap((binding) => {
        const symbol = checker.getSymbolAtLocation(binding.name);
        return symbol ? [symbol] : [];
      });
  });
  return descendants(file).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.some((symbol) => symbol === checker.getSymbolAtLocation(node.expression)),
  );
}

describe("Converse and Cohere source ownership", () => {
  for (const [wire, owner, wrapper] of [
    ["bedrock-converse.ts", "converse", "converseUsage"],
    ["cohere.ts", "cohere", "cohereUsage"],
  ])
    it(`${wire} delegates native usage construction`, () => {
      const path = join(sourceRoot, wire);
      const program = ts.createProgram([path], { noResolve: true, noLib: true });
      const file = program.getSourceFile(path)!;
      const consumers = importedCalls(
        file,
        program.getTypeChecker(),
        `response/usage/codecs/${owner}.ts`,
        "render",
      ).map((call) => ts.findAncestor(call, ts.isFunctionDeclaration)?.name?.text);
      expect(consumers).toContain(wrapper);
      if (owner === "converse") expect(consumers).toContain("prepareConverseMisbehavior");
      const fields = ["inputTokens", "outputTokens", "totalTokens", "billed_units", "tokens"];
      expect(
        descendants(file).filter(
          (node) =>
            ts.isPropertyAssignment(node) &&
            (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
            fields.includes(node.name.text),
        ),
      ).toHaveLength(0);
      expect(
        descendants(file).filter(
          (node) => ts.isShorthandPropertyAssignment(node) && fields.includes(node.name.text),
        ),
      ).toHaveLength(0);
    });

  it("Cohere's distinct finish table delegates to its bound shared owner", () => {
    const path = join(sourceRoot, "cohere.ts");
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const file = program.getSourceFile(path)!;
    const calls = importedCalls(
      file,
      program.getTypeChecker(),
      "response/finish.ts",
      "mapCohereFinish",
    );
    expect(calls).toHaveLength(1);
    expect(ts.findAncestor(calls[0], ts.isFunctionDeclaration)?.name?.text).toBe(
      "cohereFinishReason",
    );
    const wrapper = file.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "cohereFinishReason",
    )!;
    expect(wrapper.body?.statements).toHaveLength(2);
  });
});

function evidence(id: string, value: unknown) {
  const bytes = serializeGolden(value);
  if (process.env.W4_BASELINE_DIR)
    expect(bytes).toBe(readFileSync(join(process.env.W4_BASELINE_DIR, `${id}.json`), "utf8"));
  if (process.env.W4_CAPTURE_DIR) {
    mkdirSync(process.env.W4_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.W4_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

const usages = {
  absent: { raw: undefined, counts: [0, 0] },
  null: { raw: "null", counts: [0, 0] },
  empty: { raw: "{}", counts: [0, 0] },
  aliases: { raw: '{"prompt_tokens":4,"completion_tokens":8}', counts: [4, 8] },
  native: { raw: '{"input_tokens":6,"output_tokens":9}', counts: [6, 9] },
  "ignored-native": {
    raw: '{"promptTokenCount":5,"candidatesTokenCount":7,"totalTokenCount":55,"total_tokens":99}',
    counts: [0, 0],
  },
  "null-members": {
    raw: '{"input_tokens":null,"output_tokens":null,"total_tokens":null,"prompt_tokens":4,"completion_tokens":8}',
    counts: [4, 8],
  },
  zero: {
    raw: '{"input_tokens":0,"output_tokens":0,"total_tokens":99,"prompt_tokens":4,"completion_tokens":8}',
    counts: [0, 0],
  },
  conflicts: {
    raw: '{"input_tokens":6,"output_tokens":9,"total_tokens":99,"prompt_tokens":4,"completion_tokens":8,"cache_read_input_tokens":3,"cost":1,"search_units":8,"classifications":7,"future_extra":12}',
    counts: [6, 9],
  },
} as const;
const shapes = {
  text: { content: "A reply." },
  tool: { toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}', id: "call_fixed_1" }] },
  combined: {
    content: "Before",
    toolCalls: [{ name: "lookup", arguments: "{}", id: "call_fixed_1" }],
  },
  blocks: {
    blocks: [
      { type: "toolCall", name: "lookup", arguments: "{}", id: "call_fixed_1" },
      { type: "text", text: "After" },
    ],
  },
} as const;
const finishes = [
  undefined,
  null,
  "",
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "future_reason",
] as const;
const faults = [
  "empty-response",
  "content-filter",
  "reasoning-only",
  "stop-length-mid-tool",
] as const;
const faultCounts = {
  "empty-response": [4, 1],
  "content-filter": [4, 1],
  "reasoning-only": [4, 3],
  "stop-length-mid-tool": [5, 4],
} as const;
const wires = ["converse", "cohere"] as const;
type Wire = (typeof wires)[number];
let server: GoldenServer;

beforeAll(async () => {
  const fixtures: string[] = [];
  for (const [shape, response] of Object.entries(shapes)) {
    for (const [usage, { raw }] of Object.entries(usages))
      fixtures.push(
        `{"match":{"userMessage":"${shape}-${usage}"},"response":{${JSON.stringify(response).slice(1, -1)}${raw === undefined ? "" : `,"usage":${raw}`}}}`,
      );
    for (const [index, finishReason] of finishes.entries())
      fixtures.push(
        JSON.stringify({
          match: { userMessage: `finish-${shape}-${index}` },
          response: { ...response, finishReason },
        }),
      );
  }
  for (const fault of faults)
    fixtures.push(
      JSON.stringify({
        match: { userMessage: fault },
        response: {
          ...shapes.combined,
          usage: { input_tokens: 111, output_tokens: 77, total_tokens: 999 },
        },
        misbehavior: { seed: 0, faults: [{ fault, rate: 1 }] },
      }),
    );
  const dir = mkdtempSync(join(tmpdir(), "aimock-converse-cohere-equivalence-"));
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
afterAll(async () => server?.close());

function parsedObject(text: string) {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) throw new Error(`Expected JSON object: ${text}`);
  return parsed;
}

async function capture(wire: Wire, stream: boolean, id: string) {
  const path =
    wire === "cohere"
      ? "/v2/chat"
      : `/model/anthropic.claude-3-haiku-20240307-v1:0/converse${stream ? "-stream" : ""}`;
  const body =
    wire === "cohere"
      ? {
          model: "command-r-plus",
          stream,
          messages: [{ role: "user", content: id }],
          tools: [
            { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
          ],
        }
      : {
          messages: [{ role: "user", content: [{ text: id }] }],
          toolConfig: {
            tools: [{ toolSpec: { name: "lookup", inputSchema: { json: { type: "object" } } } }],
          },
        };
  const got = await captureHttp(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    frames: stream ? (wire === "cohere" ? "sse" : "aws") : undefined,
  });
  const unsupported = wire === "cohere" && (id === "content-filter" || id === "reasoning-only");
  expect(got.status).toBe(unsupported ? 501 : 200);
  evidence(`${wire}-${stream ? "stream" : "http"}-${id}`, got);
  if (unsupported) return parsedObject(got.body ?? got.tail!);
  expect(got.tail).toBeUndefined();
  if (got.body) return parsedObject(got.body);
  if (wire === "cohere") {
    const last = got.frames
      ?.filter((frame) => typeof frame === "string" && frame.startsWith("event: message-end\n"))
      .at(-1);
    if (typeof last !== "string") throw new Error("Missing SSE final frame");
    const event = parsedObject(last.slice(last.indexOf("data: ") + 6));
    expect(event.type).toBe("message-end");
    if (!isJsonObject(event.delta)) throw new Error("Missing message-end delta");
    return event.delta;
  }
  const metadata = got.frames?.at(-1);
  const stop = got.frames?.at(-2);
  if (typeof metadata !== "object" || typeof stop !== "object")
    throw new Error("Missing AWS final frames");
  expect(metadata.headers[":event-type"]).toBe("metadata");
  expect(stop.headers[":event-type"]).toBe("messageStop");
  return { ...parsedObject(metadata.payload!), ...parsedObject(stop.payload!) };
}

function expectedUsage(wire: Wire, counts: readonly number[]) {
  const [input, output] = counts;
  return wire === "converse"
    ? {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
      }
    : {
        billed_units: {
          input_tokens: input,
          output_tokens: output,
          search_units: 0,
          classifications: 0,
        },
        tokens: { input_tokens: input, output_tokens: output },
      };
}

describe("actual Converse and Cohere equivalence", () => {
  for (const wire of wires)
    for (const stream of [false, true]) {
      for (const shape of Object.keys(shapes)) {
        for (const [usage, values] of Object.entries(usages))
          it(`${wire}-${stream}-${shape}-${usage}`, async () => {
            const response = await capture(wire, stream, `${shape}-${usage}`);
            expect(response.usage).toEqual(expectedUsage(wire, values.counts));
            if (wire === "converse") expect(response.metrics).toEqual({ latencyMs: 0 });
          });
        for (const [index, finish] of finishes.entries())
          it(`${wire}-${stream}-finish-${shape}-${index}`, async () => {
            const response = await capture(wire, stream, `finish-${shape}-${index}`);
            const mapped =
              finish === "stop"
                ? wire === "cohere"
                  ? "COMPLETE"
                  : "end_turn"
                : finish === "tool_calls"
                  ? wire === "cohere"
                    ? "TOOL_CALL"
                    : "tool_use"
                  : finish === "length"
                    ? wire === "cohere"
                      ? "MAX_TOKENS"
                      : "max_tokens"
                    : finish;
            const fallback =
              wire === "cohere"
                ? shape === "text"
                  ? "COMPLETE"
                  : "TOOL_CALL"
                : shape === "text"
                  ? "end_turn"
                  : "tool_use";
            expect(wire === "cohere" ? response.finish_reason : response.stopReason).toBe(
              mapped || fallback,
            );
          });
      }
      for (const fault of faults)
        it(`${wire}-${stream}-${fault}`, async () => {
          const response = await capture(wire, stream, fault);
          if (wire === "cohere" && (fault === "content-filter" || fault === "reasoning-only")) {
            expect(response.message).toBe(
              `${fault} on cohere: unsupported-on-wire: Fault or authored parameter is unsupported in this wire/output mode`,
            );
            expect(response.code).toBe("aimock_misbehavior_unsupported");
            return;
          }
          expect(response.usage).toEqual(expectedUsage(wire, faultCounts[fault]));
        });
    }
});
