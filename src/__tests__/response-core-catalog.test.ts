import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { Fixture } from "../types.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  startStubUpstream,
} from "./golden/harness.js";

const defaults = [
  "gpt-4",
  "gpt-4o",
  "claude-3-5-sonnet-20241022",
  "gemini-2.0-flash",
  "text-embedding-3-small",
];
const mixedFixtures: Fixture[] = [
  { match: { model: "gpt-4o" }, response: { content: "chat" } },
  { match: { model: "claude-sonnet-4-5", endpoint: "chat" }, response: { content: "chat" } },
  {
    match: { model: "text-embedding-3-small", endpoint: "embedding" },
    response: { embedding: [0.1] },
  },
  {
    match: { model: "acme/video", endpoint: "video" },
    response: { video: { id: "v", status: "completed" } },
  },
  {
    match: { model: "openai/sora-2", endpoint: "video" },
    response: { video: { id: "v2", status: "completed" } },
  },
  { match: { model: "gpt-4o" }, response: { content: "duplicate" } },
  { match: { model: /^regex/ }, response: { content: "nonstring" } },
  { match: { model: "" }, response: { content: "empty" } },
];
const mixedIds = [
  "gpt-4o",
  "claude-sonnet-4-5",
  "text-embedding-3-small",
  "acme/video",
  "openai/sora-2",
];

function retainEvidence(name: string, value: unknown, raw = false): void {
  const directory = process.env.C1_EVIDENCE_DIR;
  if (!directory) return;
  const bytes = raw ? JSON.stringify(value, null, 2) + "\n" : serializeGolden(value);
  const baseline = join(directory, `${name}.baseline.json`);
  if (process.env.C1_CAPTURE_PHASE === "baseline") {
    mkdirSync(directory, { recursive: true });
    writeFileSync(baseline, bytes, { flag: "wx" });
  } else {
    expect(bytes).toBe(readFileSync(baseline, "utf8"));
    writeFileSync(join(directory, `${name}.candidate.json`), bytes);
  }
}

describe("core catalog source ownership", () => {
  const path = fileURLToPath(new URL("../server.ts", import.meta.url));
  const program = ts.createProgram([path], { noResolve: true, noLib: true });
  const source = program.getSourceFile(path);
  if (!source) throw new Error("Server source is missing");
  const checker = program.getTypeChecker();
  const server = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "startServer",
  );
  if (!server?.body) throw new Error("Source server is missing");

  function importedSymbol(module: string, name: string) {
    for (const node of source!.statements) {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== module
      )
        continue;
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const binding = bindings.elements.find(
        (element) => (element.propertyName ?? element.name).text === name,
      );
      if (binding && !node.importClause?.isTypeOnly && !binding.isTypeOnly) {
        const symbol = checker.getSymbolAtLocation(binding.name);
        if (symbol) return symbol;
      }
    }
    throw new Error(`Missing runtime import ${name} from ${module}`);
  }

  it.each([
    { route: "MODELS_PATH", renderer: "renderOpenAIModels", arity: 1 },
    { route: "OLLAMA_TAGS_PATH", renderer: "renderOllamaTags", arity: 2 },
  ])(
    "$route delegates its served body to shared collection and rendering",
    ({ route, renderer, arity }) => {
      const collector = importedSymbol("./response/catalog/collect.js", "collect");
      const renderSymbol = importedSymbol("./response/catalog/render.js", renderer);
      const blocks: ts.Block[] = [];
      function findRoute(node: ts.Node): void {
        if (
          ts.isIfStatement(node) &&
          ts.isBlock(node.thenStatement) &&
          node.expression.getText(source) === `pathname === ${route} && req.method === "GET"`
        )
          blocks.push(node.thenStatement);
        ts.forEachChild(node, findRoute);
      }
      findRoute(server!.body!);
      expect(blocks).toHaveLength(1);
      const block = blocks[0];
      const declarations = block.statements.flatMap((statement) =>
        ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
      );
      expect(declarations).toHaveLength(1);
      const body = declarations[0];
      const renderCall = body.initializer;
      if (
        !renderCall ||
        !ts.isCallExpression(renderCall) ||
        !ts.isIdentifier(renderCall.expression)
      )
        throw new Error("Served catalog body must call the shared renderer");
      expect(checker.getSymbolAtLocation(renderCall.expression)).toBe(renderSymbol);
      expect(renderCall.arguments).toHaveLength(arity);
      const ids = renderCall.arguments[0];
      if (
        !ts.isPropertyAccessExpression(ids) ||
        ids.name.text !== "ids" ||
        !ts.isCallExpression(ids.expression) ||
        !ts.isIdentifier(ids.expression.expression)
      )
        throw new Error("Renderer must consume shared collection IDs");
      const collectCall = ids.expression;
      expect(checker.getSymbolAtLocation(collectCall.expression)).toBe(collector);
      expect(collectCall.arguments).toHaveLength(2);
      expect(checker.getSymbolAtLocation(collectCall.arguments[0])).toBe(
        checker.getSymbolAtLocation(server!.parameters[0].name),
      );
      expect(ts.isStringLiteral(collectCall.arguments[1]) && collectCall.arguments[1].text).toBe(
        "all",
      );
      if (arity === 2) {
        const clock = renderCall.arguments[1];
        if (!ts.isArrowFunction(clock))
          throw new Error("Ollama must supply a per-entry clock callback");
        expect(clock.parameters).toHaveLength(0);
        expect(clock.body.getText(source)).toBe("new Date().toISOString()");
      }
      const endCalls: ts.CallExpression[] = [];
      function inspect(node: ts.Node): void {
        expect(
          ts.isArrayLiteralExpression(node) ||
            ts.isForStatement(node) ||
            ts.isForOfStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isWhileStatement(node) ||
            ts.isDoStatement(node),
          "Catalog construction must remain shared",
        ).toBe(false);
        if (ts.isObjectLiteralExpression(node)) {
          const parent = node.parent;
          expect(
            ts.isCallExpression(parent) &&
              ts.isPropertyAccessExpression(parent.expression) &&
              parent.expression.name.text === "writeHead" &&
              parent.arguments[1] === node,
            "Only transport headers remain locally assembled",
          ).toBe(true);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "end" &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "res"
        )
          endCalls.push(node);
        ts.forEachChild(node, inspect);
      }
      inspect(block);
      expect(endCalls).toHaveLength(1);
      const serialized = endCalls[0].arguments[0];
      if (
        !serialized ||
        !ts.isCallExpression(serialized) ||
        !ts.isPropertyAccessExpression(serialized.expression)
      )
        throw new Error("Response must serialize the shared catalog body");
      expect(serialized.expression.expression.getText(source)).toBe("JSON");
      expect(serialized.expression.name.text).toBe("stringify");
      expect(serialized.arguments).toHaveLength(1);
      expect(checker.getSymbolAtLocation(serialized.arguments[0])).toBe(
        checker.getSymbolAtLocation(body.name),
      );
    },
  );
});

const cases = [
  { name: "empty-defaults", fixtures: [], ids: defaults },
  { name: "mixed-endpoints", fixtures: mixedFixtures, ids: mixedIds },
  { name: "nonstring-defaults", fixtures: mixedFixtures.slice(6), ids: defaults },
];

describe.each([
  { mode: "ordinary", strict: false, record: false },
  { mode: "strict", strict: true, record: false },
  { mode: "record", strict: false, record: true },
  { mode: "strict-record", strict: true, record: true },
])("real core catalog equivalence in $mode", ({ mode, strict, record }) => {
  it.each(cases)(
    "$name preserves bytes, ignored queries, and no journal/proxy activity",
    async ({ name, fixtures, ids }) => {
      const upstream = await startStubUpstream((_req, res) => {
        res.writeHead(502);
        res.end("unexpected catalog proxy");
      });
      const fixturePath = mkdtempSync(join(tmpdir(), "aimock-core-catalog-"));
      const server = await startGoldenServer(fixtures, {
        strict,
        ...(record
          ? { record: { providers: { openai: upstream.url, ollama: upstream.url }, fixturePath } }
          : {}),
      });
      try {
        for (const route of ["/v1/models", "/api/tags"]) {
          const exchange = await captureHttp(`${server.url}${route}?limit=1&after_id=gpt-4o`, {
            method: "GET",
            headers: { authorization: "Bearer k", "x-aimock-strict": strict ? "false" : "true" },
          });
          expect(exchange.status).toBe(200);
          expect(exchange.headers["content-type"]).toBe("application/json");
          expect(exchange.headers["access-control-allow-origin"]).toBe("*");
          if (route === "/v1/models") {
            expect(exchange.body).toBe(
              JSON.stringify({
                object: "list",
                data: ids.map((id) => ({
                  id,
                  object: "model",
                  created: 1686935002,
                  owned_by: "aimock",
                })),
              }),
            );
          } else {
            expect(exchange.body).toBe(
              JSON.stringify({
                models: ids.map((id) => ({
                  name: id,
                  model: id,
                  modified_at: "<iso-date>",
                  size: 0,
                  digest: "",
                  details: {},
                })),
              }),
            );
          }
          const journal = server.instance.journal.getAll();
          expect(journal).toEqual([]);
          expect(upstream.requests).toEqual([]);
          retainEvidence(`${mode}-${name}-${route === "/v1/models" ? "openai" : "ollama"}`, {
            exchange,
            journal,
            upstreamHits: upstream.requests,
          });
        }
      } finally {
        try {
          await server.close();
        } finally {
          try {
            await upstream.close();
          } finally {
            rmSync(fixturePath, { recursive: true, force: true });
          }
        }
      }
    },
  );
});

it("real Ollama route reads a new ISO timestamp for each entry", async () => {
  const server = await startGoldenServer(mixedFixtures);
  const toISOString = Date.prototype.toISOString;
  const times = mixedIds.map((_, index) => toISOString.call(new Date(1700000000000 + index)));
  let entry = 0;
  const clock = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => times[entry++]);
  try {
    const response = await fetch(`${server.url}/api/tags`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toBe(
      JSON.stringify({
        models: mixedIds.map((id, index) => ({
          name: id,
          model: id,
          modified_at: times[index],
          size: 0,
          digest: "",
          details: {},
        })),
      }),
    );
    expect(clock).toHaveBeenCalledTimes(mixedIds.length);
    retainEvidence("ollama-per-entry-clock-raw", { status: response.status, body }, true);
  } finally {
    clock.mockRestore();
    await server.close();
  }
});
