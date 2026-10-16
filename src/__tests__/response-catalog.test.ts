import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Fixture } from "../types.js";
import { captureHttp, serializeGolden, startGoldenServer } from "./golden/harness.js";
import { collect, OPENROUTER_VIDEO_SUNSET_MODELS } from "../response/catalog/collect.js";
import {
  renderOpenAIModels,
  renderOllamaTags,
  renderOpenRouterChatModels,
  renderOpenRouterVideoModels,
} from "../response/catalog/render.js";

const mixedFixtures: Fixture[] = [
  { match: { model: "gpt-4o" }, response: { content: "chat a" } },
  { match: { model: "chat-explicit", endpoint: "chat" }, response: { content: "chat b" } },
  {
    match: { model: "text-embedding-3-small", endpoint: "embedding" },
    response: { embedding: [0.1, 0.2] },
  },
  {
    match: { model: "acme/video-a", endpoint: "video" },
    response: { video: { id: "v1", status: "completed" } },
  },
  {
    match: { model: "openai/sora-2", endpoint: "video" },
    response: { video: { id: "v2", status: "completed" } },
  },
  {
    match: { model: /^regex-video/, endpoint: "video" },
    response: { video: { id: "v3", status: "completed" } },
  },
  { match: { model: "gpt-4o" }, response: { content: "duplicate" } },
  { match: { model: /^regex-chat/ }, response: { content: "regex" } },
  { match: { model: "" }, response: { content: "empty model" } },
];

function expectedBody(caseName: string): string {
  const path = fileURLToPath(
    new URL(`./golden/__snapshots__/models/${caseName}.json`, import.meta.url),
  );
  const golden: { exchange: { body: string } } = JSON.parse(readFileSync(path, "utf8"));
  return golden.exchange.body;
}

function retainEvidence(caseName: string, value: unknown): void {
  const directory = process.env.C0_EVIDENCE_DIR;
  if (!directory) return;
  const bytes = serializeGolden(value);
  const baseline = join(directory, `${caseName}.baseline.json`);
  if (process.env.C0_CAPTURE_PHASE === "baseline") {
    mkdirSync(directory, { recursive: true });
    writeFileSync(baseline, bytes, { flag: "wx" });
  } else {
    expect(bytes).toBe(readFileSync(baseline, "utf8"));
    writeFileSync(join(directory, `${caseName}.candidate.json`), bytes);
  }
}

describe("catalog source ownership", () => {
  it("OpenRouter chat delegates collection and native rendering", () => {
    const path = fileURLToPath(new URL("../openrouter-chat.ts", import.meta.url));
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const source = program.getSourceFile(path);
    if (!source) throw new Error("OpenRouter source is missing");
    const checker = program.getTypeChecker();
    function importedSymbol(module: string, name: string) {
      for (const statement of source!.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        if (statement.moduleSpecifier.text !== module) continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        const binding = bindings.elements.find(
          (element) => (element.propertyName ?? element.name).text === name,
        );
        if (binding && !statement.importClause?.isTypeOnly && !binding.isTypeOnly) {
          const symbol = checker.getSymbolAtLocation(binding.name);
          if (symbol) return symbol;
        }
      }
      throw new Error(`Missing runtime import ${name} from ${module}`);
    }
    const collector = importedSymbol("./response/catalog/collect.js", "collect");
    const renderer = importedSymbol("./response/catalog/render.js", "renderOpenRouterChatModels");
    const handler = source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "handleOpenRouterModels",
    );
    if (!handler?.body) throw new Error("OpenRouter model handler is missing");
    const body = handler.body.statements
      .flatMap((statement) =>
        ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
      )
      .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "body");
    const renderCall = body?.initializer;
    if (
      !body ||
      !renderCall ||
      !ts.isCallExpression(renderCall) ||
      !ts.isIdentifier(renderCall.expression)
    )
      throw new Error("Catalog body must call the imported shared renderer");
    expect(checker.getSymbolAtLocation(renderCall.expression)).toBe(renderer);
    expect(renderCall.arguments).toHaveLength(1);
    const ids = renderCall.arguments[0];
    if (
      !ts.isPropertyAccessExpression(ids) ||
      ids.name.text !== "ids" ||
      !ts.isCallExpression(ids.expression) ||
      !ts.isIdentifier(ids.expression.expression)
    )
      throw new Error("Shared renderer must consume shared collection IDs");
    const collectCall = ids.expression;
    expect(checker.getSymbolAtLocation(collectCall.expression)).toBe(collector);
    expect(collectCall.arguments).toHaveLength(2);
    expect(checker.getSymbolAtLocation(collectCall.arguments[0])).toBe(
      checker.getSymbolAtLocation(handler.parameters[2].name),
    );
    expect(ts.isStringLiteral(collectCall.arguments[1]) && collectCall.arguments[1].text).toBe(
      "chat",
    );

    const endCalls: ts.CallExpression[] = [];
    function inspect(node: ts.Node): void {
      expect(
        ts.isArrayLiteralExpression(node) ||
          ts.isForStatement(node) ||
          ts.isForOfStatement(node) ||
          ts.isForInStatement(node) ||
          ts.isWhileStatement(node) ||
          ts.isDoStatement(node),
        "Handler must not construct a local catalog",
      ).toBe(false);
      if (ts.isObjectLiteralExpression(node)) {
        const parent = node.parent;
        expect(
          ts.isCallExpression(parent) &&
            ts.isPropertyAccessExpression(parent.expression) &&
            parent.expression.name.text === "writeHead" &&
            parent.arguments[1] === node,
          "Only transport headers remain locally constructed",
        ).toBe(true);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "end" &&
        checker.getSymbolAtLocation(node.expression.expression) ===
          checker.getSymbolAtLocation(handler!.parameters[1].name)
      )
        endCalls.push(node);
      ts.forEachChild(node, inspect);
    }
    inspect(handler.body);
    expect(endCalls).toHaveLength(1);
    const serialized = endCalls[0].arguments[0];
    if (
      !serialized ||
      !ts.isCallExpression(serialized) ||
      !ts.isPropertyAccessExpression(serialized.expression)
    )
      throw new Error("Handler must serialize the shared catalog body");
    expect(serialized.expression.expression.getText(source)).toBe("JSON");
    expect(serialized.expression.name.text).toBe("stringify");
    expect(serialized.arguments).toHaveLength(1);
    expect(checker.getSymbolAtLocation(serialized.arguments[0])).toBe(
      checker.getSymbolAtLocation(body.name),
    );
  });
});

describe("real OpenRouter catalog equivalence", () => {
  const cases: Array<{ name: string; fixtures: Fixture[]; golden: string }> = [
    { name: "empty-defaults", fixtures: [], golden: "openrouter-models-defaults-empty-fixtures" },
    {
      name: "mixed-duplicates-nonstring",
      fixtures: mixedFixtures,
      golden: "openrouter-models-mixed-endpoints",
    },
    {
      name: "nonstring-empty-defaults",
      fixtures: mixedFixtures.slice(7),
      golden: "openrouter-models-defaults-empty-fixtures",
    },
  ];
  it.each(cases)("$name preserves bytes and journal", async ({ name, fixtures, golden }) => {
    const server = await startGoldenServer(fixtures);
    try {
      const exchange = await captureHttp(`${server.url}/api/v1/models?limit=1`, { method: "GET" });
      expect(exchange.status).toBe(200);
      expect(exchange.body).toBe(expectedBody(golden));
      const journal = server.instance.journal
        .getAll()
        .map(({ method, path, body, response }) => ({ method, path, body, response }));
      expect(journal).toEqual([
        {
          method: "GET",
          path: "/api/v1/models?limit=1",
          body: null,
          response: { status: 200, fixture: null },
        },
      ]);
      retainEvidence(name, { exchange, journal });
    } finally {
      await server.close();
    }
  });
});

describe("shared catalog collection", () => {
  it.each([
    {
      selection: "all",
      ids: ["gpt-4o", "chat-explicit", "text-embedding-3-small", "acme/video-a", "openai/sora-2"],
    },
    { selection: "chat", ids: ["gpt-4o", "chat-explicit"] },
    { selection: "video-active", ids: ["acme/video-a"] },
  ] as const)("$selection preserves first-seen selection", ({ selection, ids }) => {
    const result = collect(mixedFixtures, selection);
    expect(result.ids).toEqual(ids);
    expect(result.diagnostics.sawVideoFixture).toBe(selection === "video-active");
  });

  it("reports video fixtures even when sunset or non-string IDs leave no active models", () => {
    expect(collect(mixedFixtures.slice(4, 6), "video-active")).toEqual({
      ids: [],
      diagnostics: { sawVideoFixture: true },
    });
    expect(OPENROUTER_VIDEO_SUNSET_MODELS.has("openai/sora-2")).toBe(true);
    expect(collect([], "video-active")).toEqual({
      ids: [],
      diagnostics: { sawVideoFixture: false },
    });
  });

  it("does not exclude a sunset video ID from all or chat selection", () => {
    const fixtures: Fixture[] = [
      { match: { model: "openai/sora-2" }, response: { content: "hello" } },
    ];
    expect(collect(fixtures, "all").ids).toEqual(["openai/sora-2"]);
    expect(collect(fixtures, "chat").ids).toEqual(["openai/sora-2"]);
  });

  it("does not mutate fixtures or share result arrays", () => {
    const before = mixedFixtures.map((fixture) => ({ ...fixture, match: { ...fixture.match } }));
    const first = collect(mixedFixtures, "chat");
    first.ids.push("caller-only");
    expect(collect(mixedFixtures, "chat").ids).toEqual(["gpt-4o", "chat-explicit"]);
    expect(mixedFixtures).toEqual(before);
  });
});

describe("native catalog rendering", () => {
  it("OpenAI preserves metadata and order", () => {
    expect(JSON.stringify(renderOpenAIModels(["second", "first"]))).toBe(
      '{"object":"list","data":[{"id":"second","object":"model","created":1686935002,"owned_by":"aimock"},{"id":"first","object":"model","created":1686935002,"owned_by":"aimock"}]}',
    );
    const defaults = renderOpenAIModels([]).data.map(({ id }) => id);
    expect(defaults).toEqual([
      "gpt-4",
      "gpt-4o",
      "claude-3-5-sonnet-20241022",
      "gemini-2.0-flash",
      "text-embedding-3-small",
    ]);
  });

  it("Ollama uses the caller's timestamp for each model", () => {
    let count = 0;
    expect(JSON.stringify(renderOllamaTags(["second", "first"], () => `time-${count++}`))).toBe(
      '{"models":[{"name":"second","model":"second","modified_at":"time-0","size":0,"digest":"","details":{}},{"name":"first","model":"first","modified_at":"time-1","size":0,"digest":"","details":{}}]}',
    );
    expect(renderOllamaTags([], () => "fixed").models.map(({ name }) => name)).toEqual(
      renderOpenAIModels([]).data.map(({ id }) => id),
    );
  });

  it("OpenRouter chat preserves default and supplied raw bytes", () => {
    expect(JSON.stringify(renderOpenRouterChatModels([]))).toBe(
      expectedBody("openrouter-models-defaults-empty-fixtures"),
    );
    expect(JSON.stringify(renderOpenRouterChatModels(["gpt-4o", "chat-explicit"]))).toBe(
      expectedBody("openrouter-models-mixed-endpoints"),
    );
  });

  it("OpenRouter video preserves metadata order and default", () => {
    expect(JSON.stringify(renderOpenRouterVideoModels([]))).toBe(
      expectedBody("openrouter-video-models-defaults-empty-fixtures"),
    );
    expect(JSON.stringify(renderOpenRouterVideoModels(["acme/video-a"]))).toBe(
      expectedBody("openrouter-video-models-mixed-endpoints"),
    );
  });
});
