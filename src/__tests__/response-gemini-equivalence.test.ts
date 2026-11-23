import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixtureFile } from "../fixture-loader.js";
import { resetEventIdCounter, resetInteractionCounter } from "../gemini-interactions.js";
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

describe("Gemini source ownership", () => {
  for (const [wire, owner, ordinary, applied] of [
    ["gemini.ts", "gemini", "geminiUsageMetadata", "prepareGeminiMisbehavior"],
    ["gemini-interactions.ts", "interactions", "interactionsUsage", "handleGeminiInteractions"],
  ]) {
    it(`${wire} delegates ordinary and applied native usage`, () => {
      const path = join(sourceRoot, wire);
      const program = ts.createProgram([path], { noResolve: true, noLib: true });
      const file = program.getSourceFile(path)!;
      const calls = importedCalls(
        file,
        program.getTypeChecker(),
        `response/usage/codecs/${owner}.ts`,
        "render",
      );
      const consumers = calls.map(
        (call) => ts.findAncestor(call, ts.isFunctionDeclaration)?.name?.text,
      );
      expect(consumers).toContain(ordinary);
      expect(consumers).toContain(applied);
      const fields = [
        "promptTokenCount",
        "candidatesTokenCount",
        "totalTokenCount",
        "total_input_tokens",
        "total_output_tokens",
        "total_tokens",
        "total_thought_tokens",
      ];
      expect(
        descendants(file).filter(
          (node) =>
            ts.isPropertyAssignment(node) &&
            (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
            fields.includes(node.name.text),
        ),
      ).toHaveLength(0);
    });
  }
  it("Gemini's distinct finish table belongs to its bound shared owner", () => {
    const path = join(sourceRoot, "gemini.ts");
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const file = program.getSourceFile(path)!;
    const calls = importedCalls(
      file,
      program.getTypeChecker(),
      "response/finish.ts",
      "mapGeminiFinish",
    );
    expect(calls).toHaveLength(1);
    expect(ts.findAncestor(calls[0], ts.isFunctionDeclaration)?.name?.text).toBe(
      "geminiFinishReason",
    );
    const wrapper = file.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "geminiFinishReason",
    )!;
    expect(wrapper.body?.statements).toHaveLength(2);
  });
});

function evidence(id: string, value: unknown) {
  const bytes = serializeGolden(value);
  if (process.env.W3_BASELINE_DIR)
    expect(bytes).toBe(readFileSync(join(process.env.W3_BASELINE_DIR, `${id}.json`), "utf8"));
  if (process.env.W3_CAPTURE_DIR) {
    mkdirSync(process.env.W3_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.W3_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

const usages = {
  absent: { raw: undefined, gemini: [0, 0, 0], interactions: [0, 0, 0] },
  null: { raw: "null", gemini: [0, 0, 0], interactions: [0, 0, 0] },
  empty: { raw: "{}", gemini: [0, 0, 0], interactions: [0, 0, 0] },
  aliases: {
    raw: '{"prompt_tokens":4,"completion_tokens":8}',
    gemini: [4, 8, 12],
    interactions: [4, 8, 12],
  },
  native: {
    raw: '{"promptTokenCount":5,"candidatesTokenCount":7,"totalTokenCount":55}',
    gemini: [5, 7, 55],
    interactions: [5, 7, 55],
  },
  "cross-total": {
    raw: '{"input_tokens":6,"output_tokens":9,"total_tokens":99}',
    gemini: [6, 9, 15],
    interactions: [6, 9, 99],
  },
  "null-members": {
    raw: '{"promptTokenCount":null,"candidatesTokenCount":null,"totalTokenCount":null,"input_tokens":null,"output_tokens":null,"total_tokens":null,"prompt_tokens":4,"completion_tokens":8}',
    gemini: [4, 8, 12],
    interactions: [4, 8, 12],
  },
  zero: {
    raw: '{"promptTokenCount":0,"candidatesTokenCount":0,"totalTokenCount":0,"input_tokens":0,"output_tokens":0,"total_tokens":0,"prompt_tokens":4,"completion_tokens":8}',
    gemini: [0, 0, 0],
    interactions: [0, 0, 0],
  },
  conflicts: {
    raw: '{"promptTokenCount":5,"candidatesTokenCount":7,"totalTokenCount":55,"input_tokens":6,"output_tokens":9,"total_tokens":99,"prompt_tokens":4,"completion_tokens":8,"cache_read_input_tokens":3}',
    gemini: [5, 7, 55],
    interactions: [6, 9, 99],
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
const wires = ["gemini", "vertex", "interactions"] as const;
const faultCounts = {
  "empty-response": [4, 1, 5],
  "content-filter": [4, 1, 5],
  "reasoning-only": [4, 3, 7],
  "stop-length-mid-tool": [5, 2, 7],
} as const;
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
  const dir = mkdtempSync(join(tmpdir(), "aimock-gemini-equivalence-"));
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
  resetInteractionCounter();
  resetEventIdCounter();
  const path =
    wire === "interactions"
      ? "/v1beta/interactions"
      : `${wire === "vertex" ? "/v1/projects/test/locations/us-central1/publishers/google" : "/v1beta"}/models/gemini-2.5-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const body =
    wire === "interactions"
      ? {
          model: "gemini-2.5-flash",
          input: id,
          stream,
          tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        }
      : {
          contents: [{ role: "user", parts: [{ text: id }] }],
          tools: [{ functionDeclarations: [{ name: "lookup", parameters: { type: "object" } }] }],
        };
  const got = await captureHttp(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    frames: stream ? "sse" : undefined,
  });
  expect(got.status).toBe(200);
  expect(got.tail).toBeUndefined();
  evidence(`${wire}-${stream ? "sse" : "http"}-${id}`, got);
  if (got.body) return parsedObject(got.body);
  const last = got.frames?.at(-1);
  if (typeof last !== "string") throw new Error("Missing SSE final frame");
  const event = parsedObject(last.slice(last.indexOf("data: ") + 6));
  if (wire !== "interactions") return event;
  expect(event.event_type).toMatch(/^interaction\.(complete|completed)$/);
  if (!isJsonObject(event.interaction)) throw new Error("Missing terminal interaction");
  return event.interaction;
}

describe("actual Gemini Vertex and Interactions equivalence", () => {
  for (const wire of wires) {
    for (const stream of [false, true]) {
      for (const shape of Object.keys(shapes)) {
        for (const [usage, values] of Object.entries(usages)) {
          it(`${wire}-${stream}-${shape}-${usage}`, async () => {
            const response = await capture(wire, stream, `${shape}-${usage}`);
            const expected = wire === "interactions" ? values.interactions : values.gemini;
            expect(wire === "interactions" ? response.usage : response.usageMetadata).toEqual(
              wire === "interactions"
                ? {
                    total_input_tokens: expected[0],
                    total_output_tokens: expected[1],
                    total_tokens: expected[2],
                  }
                : {
                    promptTokenCount: expected[0],
                    candidatesTokenCount: expected[1],
                    totalTokenCount: expected[2],
                  },
            );
          });
        }
        if (wire !== "interactions")
          for (const [index, finish] of finishes.entries()) {
            it(`${wire}-${stream}-finish-${shape}-${index}`, async () => {
              const response = await capture(wire, stream, `finish-${shape}-${index}`);
              const candidates = response.candidates;
              if (!Array.isArray(candidates) || !isJsonObject(candidates[0]))
                throw new Error("Missing candidate");
              const mapped =
                finish === "stop"
                  ? "STOP"
                  : finish === "tool_calls"
                    ? "FUNCTION_CALL"
                    : finish === "length"
                      ? "MAX_TOKENS"
                      : finish === "content_filter"
                        ? "SAFETY"
                        : finish;
              const fallback = shape === "text" ? "STOP" : "FUNCTION_CALL";
              expect(candidates[0].finishReason).toBe(mapped || fallback);
            });
          }
      }
      for (const fault of faults.filter(
        (fault) => wire !== "interactions" || fault !== "content-filter",
      ))
        it(`${wire}-${stream}-${fault}`, async () => {
          const response = await capture(wire, stream, fault);
          const usage = wire === "interactions" ? response.usage : response.usageMetadata;
          expect(usage).toBeDefined();
          if (!isJsonObject(usage)) throw new Error("Missing applied usage");
          expect(wire === "interactions" ? usage.total_tokens : usage.totalTokenCount).not.toBe(
            999,
          );
          const counts =
            wire === "interactions" && stream && fault === "stop-length-mid-tool"
              ? [5, 4, 9]
              : faultCounts[fault];
          expect(usage).toEqual(
            wire === "interactions"
              ? {
                  total_input_tokens: counts[0],
                  total_output_tokens: fault === "reasoning-only" ? 0 : counts[1],
                  total_tokens: counts[2],
                  ...(fault === "reasoning-only" ? { total_thought_tokens: counts[1] } : {}),
                }
              : {
                  promptTokenCount: counts[0],
                  candidatesTokenCount: counts[1],
                  totalTokenCount: counts[2],
                },
          );
          if (wire === "interactions" && fault === "reasoning-only") {
            expect(usage.total_output_tokens).toBe(0);
            expect(usage.total_thought_tokens).toBeGreaterThan(0);
          }
        });
    }
  }
});
