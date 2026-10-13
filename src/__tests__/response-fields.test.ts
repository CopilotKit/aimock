import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadFixtureFile, validateFixtures } from "../fixture-loader.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  startStubUpstream,
  type GoldenServer,
} from "./golden/harness.js";

function sourceFile(name: string): ts.SourceFile {
  const path = new URL(`../${name}`, import.meta.url);
  return ts.createSourceFile(name, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined,
  );
  expect(found, `${source.fileName} owns ${name}`).toBeDefined();
  return found!;
}

function calls(node: ts.Node, name: string): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  ) {
    return true;
  }
  return node.getChildren().some((child) => calls(child, name));
}

function importedReturn(
  statement: ts.Statement | undefined,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  name: string,
  module: string,
): ts.CallExpression {
  if (
    !statement ||
    !ts.isReturnStatement(statement) ||
    !statement.expression ||
    !ts.isCallExpression(statement.expression) ||
    !ts.isIdentifier(statement.expression.expression)
  )
    throw new Error(`Expected a return delegating to imported ${name}`);
  const binding = source.statements.flatMap((node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== module
    )
      return [];
    const named = node.importClause?.namedBindings;
    return named && ts.isNamedImports(named)
      ? named.elements.filter((element) => (element.propertyName ?? element.name).text === name)
      : [];
  });
  expect(binding).toHaveLength(1);
  const symbol = checker.getSymbolAtLocation(binding[0]!.name);
  expect(symbol).toBeDefined();
  expect(checker.getSymbolAtLocation(statement.expression.expression) === symbol).toBe(true);
  return statement.expression;
}

function evidence(caseId: string, value: unknown): void {
  const bytes = serializeGolden(value);
  const baselineDir = process.env.U0_BASELINE_DIR;
  if (baselineDir) expect(bytes).toBe(readFileSync(join(baselineDir, `${caseId}.json`), "utf8"));
  const captureDir = process.env.U0_CAPTURE_DIR;
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, `${caseId}.json`), bytes);
  }
}

// Overflow JSON numbers exercise nonfinite values through the real JSON loader
// and HTTP recorder, without converting them to null with JSON.stringify.
const RAW_USAGE = `{
  "prompt_tokens": 0, "completion_tokens": 7, "total_tokens": 7,
  "is_byok": false, "cost": 0, "future_number": 2, "toString": 5,
  "overflow": 1e999, "underflow": -1e999, "null_field": null,
  "unknown_object": {"value": 1}, "cache_creation": {"ephemeral_5m_input_tokens": 4},
  "cost_details": {"upstream_inference_cost": 0, "future_cost": 3, "label": "future", "overflow": 1e999},
  "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 4, "audio_tokens": 2},
  "completion_tokens_details": {"reasoning_tokens": 0, "future_tokens": 6, "null_member": null}
}`;

const SANITIZED_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 7,
  total_tokens: 7,
  is_byok: false,
  cost: 0,
  future_number: 2,
  toString: 5,
  cost_details: { upstream_inference_cost: 0, future_cost: 3 },
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4, audio_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 0, future_tokens: 6 },
};

function fixtureJson(usage: string): string {
  return `{"fixtures":[{"match":{},"response":{"content":"ok","usage":${usage}}}]}`;
}

function responseJson(body: string | undefined): unknown {
  if (body === undefined) throw new Error("Expected a JSON response body");
  return JSON.parse(body);
}

describe("usage field ownership", () => {
  it("validator uses the shared definitions without its own member table", () => {
    const source = sourceFile("fixture-loader.ts");
    const validate = namedFunction(source, "validateFixtures");
    expect(calls(validate, "getUsageFieldDefinition")).toBe(true);
    const declarations: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
        declarations.push(node.name.text);
      ts.forEachChild(node, visit);
    }
    visit(validate);
    expect(declarations).not.toContain("numericInnerFields");
    expect(declarations).not.toContain("objectUsageFields");
  });

  it("recorder keeps only its exported compatibility delegate", () => {
    const paths = ["recorder.ts", "response/usage/recording.ts"].map((name) =>
      fileURLToPath(new URL(`../${name}`, import.meta.url)),
    );
    const program = ts.createProgram(paths, { noResolve: true, noLib: true });
    const checker = program.getTypeChecker();
    const recorder = program.getSourceFile(paths[0]!)!;
    const recording = program.getSourceFile(paths[1]!)!;
    const sanitize = namedFunction(recorder, "sanitizeRecordedUsage");
    expect(sanitize.body?.statements).toHaveLength(1);
    const captureCall = importedReturn(
      sanitize.body?.statements[0],
      recorder,
      checker,
      "captureUsage",
      "./response/usage/recording.js",
    );
    expect(captureCall.arguments).toHaveLength(1);
    const context = captureCall.arguments[0]!;
    if (!ts.isObjectLiteralExpression(context)) throw new Error("Expected final capture context");
    expect(
      context.properties.map((property) =>
        ts.isPropertyAssignment(property)
          ? [property.name.getText(), property.initializer.getText()]
          : property.getText(),
      ),
    ).toEqual([
      ["family", '"final"'],
      ["stage", '"final"'],
      ["observation", sanitize.parameters[0]!.name.getText()],
    ]);
    const capture = namedFunction(recording, "captureUsage");
    const branch = capture.body?.statements
      .find(ts.isSwitchStatement)
      ?.caseBlock.clauses.find(
        (clause) =>
          ts.isCaseClause(clause) &&
          ts.isStringLiteral(clause.expression) &&
          clause.expression.text === "sanitize",
      );
    expect(branch?.statements).toHaveLength(1);
    const sanitizeCall = importedReturn(
      branch?.statements[0],
      recording,
      checker,
      "sanitizeUsage",
      "./fields.js",
    );
    expect(sanitizeCall.arguments.map((argument) => argument.getText())).toEqual(["raw"]);
  });
});

describe("real usage loading and recording equivalence", () => {
  it.each([
    [
      "mixed-fields",
      RAW_USAGE,
      [
        'override "usage.null_field" must be a number, got object',
        'override "usage.unknown_object" must be a number, got object',
        'override "usage.cache_creation" must be a number, got object',
      ],
    ],
    [
      "invalid-documented-members",
      '{"is_byok":0,"cost_details":{"upstream_inference_cost":"bad"},"prompt_tokens_details":[],"completion_tokens_details":{"reasoning_tokens":null}}',
      [
        'override "usage.is_byok" must be a boolean, got number',
        'override "usage.cost_details.upstream_inference_cost" must be a number, got string',
        'override "usage.prompt_tokens_details" must be an object, got array',
        'override "usage.completion_tokens_details.reasoning_tokens" must be a number, got object',
      ],
    ],
    [
      "invalid-documented-prompt-cost",
      '{"cost_details":{"upstream_inference_prompt_cost":"bad"}}',
      ['override "usage.cost_details.upstream_inference_prompt_cost" must be a number, got string'],
    ],
    ["null-usage", "null", ['override "usage" must be an object']],
    [
      "zero-and-unknown-inner",
      '{"future":0,"is_byok":true,"cost_details":{"future":"accepted"},"cache_creation":0}',
      [],
    ],
    [
      "nonfinite-documented-members",
      '{"prompt_tokens":1e999,"cost_details":{"upstream_inference_cost":-1e999}}',
      [],
    ],
  ])(
    "loads and validates %s without changing acceptance or finding order",
    (caseId, usage, errors) => {
      const dir = mkdtempSync(join(tmpdir(), "aimock-u0-load-"));
      try {
        const path = join(dir, "fixture.json");
        writeFileSync(path, fixtureJson(usage));
        const fixtures = loadFixtureFile(path);
        expect(fixtures).toHaveLength(1);
        const findings = validateFixtures(fixtures);
        expect(
          findings
            .filter((finding) => finding.severity === "error")
            .map((finding) => finding.message),
        ).toEqual(errors);
        evidence(`load-${caseId}`, findings);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "estimates unchanged usage on the real completion route (stream=%s)",
    async (stream) => {
      const server = await startGoldenServer([{ match: {}, response: { content: "hello" } }]);
      try {
        const wire = await captureHttp(`${server.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "abcdefghi" }],
            stream,
            stream_options: { include_usage: true },
          }),
          ...(stream ? { frames: "sse" as const } : {}),
        });
        expect(wire.status).toBe(200);
        let response: unknown;
        if (stream) {
          expect(wire.frames?.at(-1)).toBe("data: [DONE]");
          const terminal = wire.frames?.at(-2);
          if (typeof terminal !== "string" || !terminal.startsWith("data: "))
            throw new Error("Expected a terminal SSE data frame");
          response = responseJson(terminal.slice(6));
          expect(response).toHaveProperty("choices", []);
        } else {
          response = responseJson(wire.body);
        }
        expect(response).toHaveProperty("usage", {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
        });
        evidence(`estimate-${stream ? "stream" : "nonstream"}`, wire);
      } finally {
        await server.close();
      }
    },
  );

  it("records real upstream usage, then reloads and replays the written fixture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimock-u0-record-"));
    const body = `{"id":"chatcmpl-u0-fixed","object":"chat.completion","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":${RAW_USAGE}}`;
    const upstream = await startStubUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    let server: GoldenServer | undefined;
    let replay: GoldenServer | undefined;
    try {
      server = await startGoldenServer([], {
        record: { providers: { openai: upstream.url }, fixturePath: dir },
      });
      const request = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "u0 record" }],
        }),
      };
      const wire = await captureHttp(`${server.url}/v1/chat/completions`, request);
      expect(wire.status).toBe(200);
      evidence("record-relay", wire);
      const deadline = Date.now() + 2000;
      let files = readdirSync(dir).filter((name) => name.endsWith(".json"));
      while (files.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        files = readdirSync(dir).filter((name) => name.endsWith(".json"));
      }
      expect(files).toHaveLength(1);
      const recorded: unknown = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
      evidence("record-fixture", recorded);
      const loaded = loadFixtureFile(join(dir, files[0]!));
      expect(validateFixtures(loaded).filter((finding) => finding.severity === "error")).toEqual(
        [],
      );
      expect(loaded[0]?.response).toMatchObject({ usage: SANITIZED_USAGE });
      replay = await startGoldenServer(loaded);
      const replayed = await captureHttp(`${replay.url}/v1/chat/completions`, request);
      expect(replayed.status).toBe(200);
      expect(responseJson(replayed.body)).toHaveProperty("usage", {
        prompt_tokens: 0,
        completion_tokens: 7,
        total_tokens: 7,
      });
      evidence("record-replay", replayed);
    } finally {
      await Promise.allSettled([server?.close(), replay?.close(), upstream.close()]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
