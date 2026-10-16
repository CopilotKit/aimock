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
  normalize,
  serializeGolden,
  startGoldenServer,
  type GoldenServer,
} from "./golden/harness.js";
import { connectWebSocket } from "./ws-test-client.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    result.push(child, ...descendants(child));
  });
  return result;
}

function importedCalls(
  file: ts.SourceFile,
  checker: ts.TypeChecker,
  owner: string,
  exported: string,
) {
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
      .filter((binding) => (binding.propertyName ?? binding.name).text === exported)
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

describe("Responses source ownership", () => {
  it("every HTTP usage consumer delegates to its bound owner", () => {
    const path = join(sourceRoot, "responses.ts");
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const file = program.getSourceFile(path)!;
    const checker = program.getTypeChecker();
    const calls = importedCalls(file, checker, "response/usage/codecs/responses.ts", "render");
    const consumers = calls.map(
      (call) => ts.findAncestor(call, ts.isFunctionDeclaration)?.name?.text,
    );
    expect(consumers).toEqual([
      "buildTextStreamEvents",
      "toolCallStreamEvents",
      "buildResponseEnvelope",
      "contentWithToolCallsStreamEvents",
      "buildResponsesMisbehavior",
    ]);
    const localTokens = descendants(file).filter(
      (node) =>
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        ["input_tokens", "output_tokens", "total_tokens"].includes(node.name.text),
    );
    expect(localTokens).toHaveLength(0);
  });

  it("the distinct Responses finish table belongs to the shared mapper", () => {
    const path = join(sourceRoot, "responses.ts");
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const file = program.getSourceFile(path)!;
    const checker = program.getTypeChecker();
    const finish = importedCalls(file, checker, "response/finish.ts", "mapResponsesFinish");
    expect(finish).toHaveLength(1);
    expect(ts.findAncestor(finish[0], ts.isFunctionDeclaration)?.name?.text).toBe(
      "responsesStatus",
    );
    const status = file.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "responsesStatus",
    )!;
    expect(descendants(status).filter(ts.isStringLiteral)).toHaveLength(0);
  });

  it("WS keeps ordinary and applied handling on the shared HTTP builders", () => {
    const path = join(sourceRoot, "ws-responses.ts");
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const file = program.getSourceFile(path)!;
    for (const name of [
      "buildTextStreamEvents",
      "toolCallStreamEvents",
      "contentWithToolCallsStreamEvents",
      "buildResponsesMisbehavior",
    ]) {
      expect(importedCalls(file, program.getTypeChecker(), "responses.ts", name)).toHaveLength(1);
    }
    expect(
      descendants(file).filter(
        (node) => ts.isPropertyAccessExpression(node) && node.name.text === "usage",
      ),
    ).toHaveLength(0);
  });
});

function evidence(id: string, value: unknown) {
  const bytes = serializeGolden(value);
  if (process.env.W2_BASELINE_DIR)
    expect(bytes).toBe(readFileSync(join(process.env.W2_BASELINE_DIR, `${id}.json`), "utf8"));
  if (process.env.W2_CAPTURE_DIR) {
    mkdirSync(process.env.W2_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.W2_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

const usages = {
  absent: { raw: undefined, expected: [0, 0, 0] },
  null: { raw: "null", expected: [0, 0, 0] },
  empty: { raw: "{}", expected: [0, 0, 0] },
  aliases: { raw: '{"prompt_tokens":4,"completion_tokens":8}', expected: [4, 8, 12] },
  "null-members": {
    raw: '{"input_tokens":null,"output_tokens":null,"total_tokens":null,"prompt_tokens":4,"completion_tokens":8}',
    expected: [4, 8, 12],
  },
  zero: {
    raw: '{"input_tokens":0,"output_tokens":0,"total_tokens":0,"prompt_tokens":4,"completion_tokens":8}',
    expected: [0, 0, 0],
  },
  conflicts: {
    raw: '{"output_tokens":9,"completion_tokens":8,"input_tokens":6,"prompt_tokens":4,"total_tokens":55,"cache_read_input_tokens":3}',
    expected: [6, 9, 55],
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
const faults = ["empty-response", "refusal", "reasoning-only", "stop-length-mid-tool"] as const;
const faultUsage = {
  "empty-response": [4, 1, 5],
  refusal: [2, 6, 8],
  "reasoning-only": [4, 3, 7],
  "stop-length-mid-tool": [5, 4, 9],
} as const;
const wires = ["http", "http-stream", "ws"] as const;
type Wire = (typeof wires)[number];
let server: GoldenServer;

beforeAll(async () => {
  const fixtures: string[] = [];
  for (const [shape, response] of Object.entries(shapes)) {
    for (const [usage, { raw }] of Object.entries(usages))
      fixtures.push(
        `{"match":{"userMessage":"${shape}-${usage}"},"response":{${JSON.stringify(response).slice(1, -1)}${raw === undefined ? "" : `,"usage":${raw}`}}}`,
      );
  }
  for (const [index, finishReason] of finishes.entries()) {
    for (const [shape, response] of Object.entries(shapes))
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
  const dir = mkdtempSync(join(tmpdir(), "aimock-responses-equivalence-"));
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

async function capture(wire: Wire, id: string) {
  const body = {
    model: "gpt-4",
    input: [{ role: "user", content: id }],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
  };
  if (wire !== "ws") {
    const got = await captureHttp(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: wire === "http-stream" }),
      frames: wire === "http-stream" ? "sse" : undefined,
    });
    expect(got.status).toBe(200);
    expect(got.tail).toBeUndefined();
    evidence(`${wire}-${id}`, got);
    if (got.body) return parsedObject(got.body);
    const frames = got.frames ?? [];
    const last = frames[frames.length - 1];
    if (typeof last !== "string") throw new Error("Missing SSE final frame");
    const event = parsedObject(last.slice(last.indexOf("data: ") + 6));
    expect(event.type).toMatch(/^response\.(completed|incomplete)$/);
    if (!isJsonObject(event.response)) throw new Error("Missing final response");
    return event.response;
  }
  const ws = await connectWebSocket(server.url, "/v1/responses");
  try {
    ws.send(JSON.stringify({ type: "response.create", ...body }));
    for (let count = 1; count <= 100; count++) {
      const frames = await ws.waitForMessages(count);
      const last = parsedObject(frames[frames.length - 1]);
      if (last.type === "response.completed" || last.type === "response.incomplete") {
        // Normalize the entire ordered sequence together to retain cross-frame IDs.
        evidence(`${wire}-${id}`, normalize(JSON.stringify(frames)));
        if (!isJsonObject(last.response)) throw new Error("Missing WS final response");
        return last.response;
      }
    }
    throw new Error("No final response within 100 WS frames");
  } finally {
    ws.close();
    await ws.waitForClose();
  }
}

describe("actual Responses HTTP and WS equivalence", () => {
  for (const wire of wires) {
    for (const shape of Object.keys(shapes)) {
      for (const [usage, { expected }] of Object.entries(usages)) {
        it(`${wire}-${shape}-${usage}`, async () => {
          const response = await capture(wire, `${shape}-${usage}`);
          expect(response.usage).toEqual({
            input_tokens: expected[0],
            output_tokens: expected[1],
            total_tokens: expected[2],
          });
          expect(Object.keys(response.usage ?? {})).toEqual([
            "input_tokens",
            "output_tokens",
            "total_tokens",
          ]);
          expect(response.status).toBe("completed");
        });
      }
      for (const [index, finish] of finishes.entries()) {
        it(`${wire}-finish-${shape}-${index}`, async () => {
          const response = await capture(wire, `finish-${shape}-${index}`);
          const expected =
            finish === "length"
              ? "incomplete"
              : finish === "content_filter"
                ? "failed"
                : finish === "future_reason"
                  ? finish
                  : "completed";
          expect(response.status).toBe(expected);
        });
      }
    }
    for (const fault of faults) {
      it(`${wire}-${fault}`, async () => {
        const response = await capture(wire, fault);
        expect(response.status).toBe(
          fault === "stop-length-mid-tool" || fault === "reasoning-only"
            ? "incomplete"
            : "completed",
        );
        expect(Object.keys(response.usage ?? {})).toEqual([
          "input_tokens",
          "output_tokens",
          "total_tokens",
        ]);
        expect(response.usage).toEqual({
          input_tokens: faultUsage[fault][0],
          output_tokens: faultUsage[fault][1],
          total_tokens: faultUsage[fault][2],
        });
      });
    }
  }
});
