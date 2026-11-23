import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatResponse, GenerateResponse } from "ollama";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Fixture, FixtureResponse, MisbehaviorFault } from "../types.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  type CapturedExchange,
  type GoldenServer,
} from "./golden/harness.js";

const sourcePath = fileURLToPath(new URL("../ollama.ts", import.meta.url));

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    nodes.push(child, ...descendants(child));
  });
  return nodes;
}

describe("Ollama count source ownership", () => {
  it("uses the bound codec for ordinary counts and applied chat estimates", () => {
    const program = ts.createProgram([sourcePath], { noResolve: true, noLib: true });
    const file = program.getSourceFile(sourcePath);
    expect(file).toBeDefined();
    if (!file) throw new Error("Ollama source unavailable");
    const checker = program.getTypeChecker();
    const nodes = descendants(file);
    const localCounts = nodes.filter(
      (node) =>
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        ["prompt_eval_count", "eval_count"].includes(node.name.text),
    );
    expect(localCounts.map((node) => node.getText(file))).toEqual([]);
    const bindings = file.statements.flatMap((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "./response/usage/codecs/ollama.js"
      )
        return [];
      const named = statement.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) return [];
      return named.elements.filter(
        (binding) => (binding.propertyName ?? binding.name).text === "render",
      );
    });
    expect(bindings).toHaveLength(1);
    const calls = nodes.filter(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        Boolean(
          checker
            .getSymbolAtLocation(node.expression)
            ?.declarations?.some(
              (declaration) => ts.isImportSpecifier(declaration) && bindings.includes(declaration),
            ),
        ),
    );
    expect(calls).toHaveLength(3);
    const ordinaryCalls = calls.filter(
      (call) => call.arguments[0]?.getText(file) === '{ kind: "ordinary-zero" }',
    );
    expect(ordinaryCalls).toHaveLength(2);
    for (const call of ordinaryCalls) {
      expect(ts.findAncestor(call, ts.isVariableDeclaration)?.name.getText(file)).toBe(
        "DURATION_FIELDS",
      );
    }
    const applied = calls.find((call) =>
      call.arguments[0]?.getText(file).includes('"applied-chat-estimate"'),
    );
    expect(applied).toBeDefined();
    expect(applied && ts.findAncestor(applied, ts.isFunctionDeclaration)?.name?.text).toBe(
      "prepareOllamaMisbehavior",
    );
    expect(
      nodes.filter(
        (node) =>
          ts.isImportSpecifier(node) &&
          ["estimateTokens", "estimatePromptTokens"].includes(
            (node.propertyName ?? node.name).text,
          ),
      ),
    ).toEqual([]);
  });
});

const fixtureCounts = {
  prompt_tokens: 111,
  completion_tokens: 77,
  input_tokens: 333,
  output_tokens: 222,
};
const usages = { absent: undefined, empty: {}, supplied: fixtureCounts };
const tools = [{ name: "lookup", arguments: '{"city":"Paris"}', id: "call_fixed_ollama" }];
const responses = {
  text: { content: "A reply long enough for multiple chunks." },
  tools: { toolCalls: tools },
  combined: { content: "Before", toolCalls: tools },
  blocks: {
    content: "STALE",
    toolCalls: [{ name: "stale", arguments: "{}" }],
    blocks: [
      { type: "text", text: "Before" },
      { type: "toolCall", ...tools[0] },
      { type: "text", text: "After" },
    ],
  },
} satisfies Record<string, FixtureResponse>;
const faults = {
  empty: { fault: "empty-response", rate: 1 },
  reasoning: { fault: "reasoning-only", reasoning: "Thinking through this carefully.", rate: 1 },
  unknown: { fault: "tool-unknown-name", name: "missing_lookup", rate: 1 },
} satisfies Record<string, MisbehaviorFault>;

const ordinaryCases = Object.entries(usages).flatMap(([usageId, usage]) =>
  Object.entries(responses).map(([shape, response]) => ({
    id: `${shape}-${usageId}`,
    response: { ...response, ...(usage === undefined ? {} : { usage }) },
  })),
);
const appliedCases = Object.entries(faults).map(([id, fault]) => ({
  id: `applied-${id}`,
  response: { ...responses.combined, usage: fixtureCounts },
  fault,
}));
const fixtures: Fixture[] = [
  ...ordinaryCases.map(({ id, response }) => ({ match: { userMessage: id }, response })),
  ...appliedCases.map(({ id, response, fault }) => ({
    match: { userMessage: id },
    response,
    misbehavior: { seed: 0, faults: [fault] },
  })),
];

function saveEvidence(id: string, got: CapturedExchange) {
  const bytes = serializeGolden(got);
  if (process.env.W5_BASELINE_DIR) {
    expect(bytes, id).toBe(readFileSync(join(process.env.W5_BASELINE_DIR, `${id}.json`), "utf8"));
  }
  if (process.env.W5_CAPTURE_DIR) {
    mkdirSync(process.env.W5_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.W5_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

function wireRows(got: CapturedExchange): Array<ChatResponse | GenerateResponse> {
  const lines = got.frames ?? [got.body];
  return lines.map((line) => {
    if (typeof line !== "string") throw new Error("Expected Ollama JSON text");
    return JSON.parse(line);
  });
}

let server: GoldenServer;
beforeAll(async () => {
  server = await startGoldenServer(fixtures, { enableMisbehavior: true });
});
afterAll(async () => {
  await server?.close();
});

async function observe(id: string, path: "chat" | "generate", stream: boolean, applied = false) {
  const got = await captureHttp(`${server.url}/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3",
      ...(path === "chat"
        ? {
            messages: [{ role: "user", content: id }],
            tools: [
              {
                type: "function",
                function: {
                  name: "lookup",
                  parameters: { type: "object", properties: { city: { type: "string" } } },
                },
              },
            ],
          }
        : { prompt: id }),
      stream,
    }),
    ...(stream ? { frames: "ndjson" } : {}),
  });
  expect(got.status).toBe(200);
  expect(got.tail).toBeUndefined();
  expect(got.headers["content-type"]).toBe(stream ? "application/x-ndjson" : "application/json");
  const rows = wireRows(got);
  const final = rows.at(-1);
  expect(final?.done).toBe(true);
  for (const row of rows.slice(0, -1)) {
    expect(row.done).toBe(false);
    expect(row).not.toHaveProperty("prompt_eval_count");
    expect(row).not.toHaveProperty("eval_count");
  }
  expect(final).toMatchObject({
    total_duration: 0,
    load_duration: 0,
    prompt_eval_duration: 0,
    eval_duration: 0,
  });
  if (applied) {
    expect(final?.prompt_eval_count).toBe(Math.max(1, Math.ceil(id.length / 4)));
    expect(final?.eval_count).toBeGreaterThan(0);
    expect(final?.eval_count).not.toBe(fixtureCounts.completion_tokens);
  } else {
    expect(final).toMatchObject({ prompt_eval_count: 0, eval_count: 0 });
  }
  const keys = Object.keys(final ?? {});
  expect(keys.slice(keys.indexOf("total_duration"), keys.indexOf("eval_duration") + 1)).toEqual([
    "total_duration",
    "load_duration",
    "prompt_eval_count",
    "prompt_eval_duration",
    "eval_count",
    "eval_duration",
  ]);
  if (path === "generate") expect(final).toHaveProperty("context", []);
  if (applied) expect(server.instance.journal.getLast()?.response.misbehavior?.applied).toBe(true);
  saveEvidence(`${path}-${stream ? "ndjson" : "nonstream"}-${id}`, got);
  return final;
}

describe("Ollama real HTTP equivalence", () => {
  for (const stream of [false, true]) {
    it.each(ordinaryCases)(`chat stream=${stream} $id ignores fixture counts`, async ({ id }) => {
      await observe(id, "chat", stream);
    });
    it.each(Object.keys(usages))(
      `generate stream=${stream} text-%s ignores fixture counts`,
      async (usageId) => {
        await observe(`text-${usageId}`, "generate", stream);
      },
    );
    it.each(appliedCases)(
      `chat stream=${stream} $id estimates applied response`,
      async ({ id }) => {
        const final = await observe(id, "chat", stream, true);
        const completion =
          id === "applied-empty"
            ? ""
            : id === "applied-reasoning"
              ? faults.reasoning.reasoning
              : 'Beforemissing_lookup{"city":"Paris"}';
        expect(final?.eval_count).toBe(Math.max(1, Math.ceil(completion.length / 4)));
      },
    );
  }
});
