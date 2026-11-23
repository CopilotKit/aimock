import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { Fixture, JournalEntry } from "../types.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  startStubUpstream,
} from "./golden/harness.js";

const PATH = "/api/v1/videos/models?limit=1";
const DEFAULT_WARNING =
  "No video fixture contributes a string model — serving the default video model set";
const PROXY_BODY = '{ "data": [{ "id": "upstream/video-1", "custom": true }] }\n';
const videoFixture = (model: string | RegExp | undefined): Fixture => ({
  match: { endpoint: "video", ...(model === undefined ? {} : { model }) },
  response: { video: { id: "v1", status: "completed" } },
});
const mixedFixtures: Fixture[] = [
  { match: { model: "gpt-4o" }, response: { content: "chat" } },
  { match: { model: "chat-explicit", endpoint: "chat" }, response: { content: "chat" } },
  { match: { model: "embedding-model", endpoint: "embedding" }, response: { embedding: [0.1] } },
  videoFixture("acme/video-a"),
  videoFixture("openai/sora-2"),
  videoFixture(/^regex-video/),
  videoFixture("acme/video-a"),
  videoFixture(""),
];

function goldenBody(name: string): string {
  const path = fileURLToPath(
    new URL(`./golden/__snapshots__/models/${name}.json`, import.meta.url),
  );
  const golden: { exchange: { body: string } } = JSON.parse(readFileSync(path, "utf8"));
  return golden.exchange.body;
}

function retainEvidence(caseName: string, value: unknown): void {
  const directory = process.env.C2_EVIDENCE_DIR;
  if (!directory) return;
  const bytes = serializeGolden(value);
  const baseline = join(directory, `${caseName}.baseline.json`);
  if (process.env.C2_CAPTURE_PHASE === "baseline") {
    mkdirSync(directory, { recursive: true });
    writeFileSync(baseline, bytes, { flag: "wx" });
  } else {
    expect(bytes).toBe(readFileSync(baseline, "utf8"));
    writeFileSync(join(directory, `${caseName}.candidate.json`), bytes);
  }
}

describe("video catalog source ownership", () => {
  it("binds shared collection and rendering to the video model handler output", () => {
    const path = fileURLToPath(new URL("../openrouter-video.ts", import.meta.url));
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const source = program.getSourceFile(path);
    if (!source) throw new Error("OpenRouter video source is missing");
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
    const renderer = importedSymbol("./response/catalog/render.js", "renderOpenRouterVideoModels");
    const handler = source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "handleOpenRouterVideoModels",
    );
    if (!handler?.body) throw new Error("Video model handler is missing");
    const declarations = handler.body.statements.flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    );
    const collection = declarations.find(
      (declaration) =>
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        checker.getSymbolAtLocation(declaration.initializer.expression) === collector,
    );
    const collectCall = collection?.initializer;
    if (
      !collection ||
      !collectCall ||
      !ts.isCallExpression(collectCall) ||
      !ts.isIdentifier(collection.name)
    )
      throw new Error("Video handler must call the imported shared collector");
    expect(collectCall.arguments).toHaveLength(2);
    expect(checker.getSymbolAtLocation(collectCall.arguments[0])).toBe(
      checker.getSymbolAtLocation(handler.parameters[2].name),
    );
    expect(ts.isStringLiteral(collectCall.arguments[1]) && collectCall.arguments[1].text).toBe(
      "video-active",
    );
    const body = declarations.find(
      (declaration) =>
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        checker.getSymbolAtLocation(declaration.initializer.expression) === renderer,
    );
    const renderCall = body?.initializer;
    if (!body || !renderCall || !ts.isCallExpression(renderCall) || !ts.isIdentifier(body.name))
      throw new Error("Video handler must call the imported shared renderer");
    expect(renderCall.arguments).toHaveLength(1);
    const ids = renderCall.arguments[0];
    if (!ts.isPropertyAccessExpression(ids))
      throw new Error("Renderer must consume collection IDs");
    expect(ids.name.text).toBe("ids");
    expect(checker.getSymbolAtLocation(ids.expression)).toBe(
      checker.getSymbolAtLocation(collection.name),
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
        "Video handler must not construct a local catalog",
      ).toBe(false);
      if (ts.isObjectLiteralExpression(node)) {
        expect(
          node.properties.some(
            (property) =>
              property.name &&
              ["data", "supported_durations", "supported_resolutions", "pricing_skus"].includes(
                property.name.getText(source),
              ),
          ),
          "Catalog metadata must remain owned by the shared renderer",
        ).toBe(false);
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
    // The other end call is the deliberately verbatim upstream relay.
    expect(endCalls).toHaveLength(2);
    const serializations = endCalls.flatMap((call) => {
      const argument = call.arguments[0];
      return argument &&
        ts.isCallExpression(argument) &&
        ts.isPropertyAccessExpression(argument.expression) &&
        argument.expression.expression.getText(source) === "JSON" &&
        argument.expression.name.text === "stringify"
        ? [argument]
        : [];
    });
    expect(serializations).toHaveLength(1);
    expect(serializations[0].arguments).toHaveLength(1);
    expect(checker.getSymbolAtLocation(serializations[0].arguments[0])).toBe(
      checker.getSymbolAtLocation(body.name),
    );
  });
});

interface CatalogCase {
  name: string;
  fixtures: Fixture[];
  golden?: string;
  record?: "success" | "error";
  strict?: boolean;
  override?: "true" | "false";
  warning?: string;
  response?: Partial<JournalEntry["response"]>;
  proxy?: boolean;
}

const cases: CatalogCase[] = [
  { name: "empty-defaults", fixtures: [] },
  { name: "no-video-defaults", fixtures: mixedFixtures.slice(0, 3) },
  {
    name: "video-only-ordered-duplicates",
    fixtures: mixedFixtures,
    golden: "openrouter-video-models-mixed-endpoints",
  },
  {
    name: "sunset-only-diagnostic",
    fixtures: [videoFixture("openai/sora-2")],
    warning: DEFAULT_WARNING,
  },
  {
    name: "nonstring-only-diagnostic",
    fixtures: [videoFixture(/^video/)],
    warning: DEFAULT_WARNING,
  },
  {
    name: "missing-empty-model-diagnostic",
    fixtures: [videoFixture(undefined), videoFixture("")],
    warning: DEFAULT_WARNING,
  },
  {
    name: "upstream-verbatim-success",
    fixtures: mixedFixtures,
    record: "success",
    proxy: true,
    response: { source: "proxy" },
  },
  {
    name: "strict-suppresses-proxy",
    fixtures: mixedFixtures,
    record: "success",
    strict: true,
    golden: "openrouter-video-models-mixed-endpoints",
  },
  {
    name: "header-on-suppresses-proxy",
    fixtures: mixedFixtures,
    record: "success",
    override: "true",
    golden: "openrouter-video-models-mixed-endpoints",
    response: { strictOverride: true },
  },
  {
    name: "header-off-enables-proxy",
    fixtures: mixedFixtures,
    record: "success",
    strict: true,
    override: "false",
    proxy: true,
    response: { source: "proxy", strictOverride: false },
  },
  {
    name: "upstream-error-fallback",
    fixtures: mixedFixtures,
    record: "error",
    golden: "openrouter-video-models-mixed-endpoints",
    response: { source: "internal" },
    warning:
      'OpenRouter video models proxy failed (Models 503: {"error":"stub: unavailable"}) — falling back to the synthesized listing',
  },
];

async function captureCase(testCase: CatalogCase) {
  const upstream = await startStubUpstream((_req, res) => {
    const failure = testCase.record === "error";
    res.writeHead(failure ? 503 : 200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(failure ? '{"error":"stub: unavailable"}' : PROXY_BODY);
  });
  const fixturePath = mkdtempSync(join(tmpdir(), "aimock-video-catalog-"));
  try {
    const server = await startGoldenServer(testCase.fixtures, {
      strict: testCase.strict,
      ...(testCase.record
        ? { record: { providers: { openrouter: upstream.url }, fixturePath } }
        : {}),
    });
    const warn = vi.spyOn(server.instance.defaults.logger, "warn");
    try {
      const exchange = await captureHttp(`${server.url}${PATH}`, {
        method: "GET",
        headers: {
          authorization: "Bearer k",
          ...(testCase.override ? { "x-aimock-strict": testCase.override } : {}),
        },
      });
      const journal = server.instance.journal
        .getAll()
        .map(({ method, path, body, response }) => ({ method, path, body, response }));
      const upstreamHits = upstream.requests.map(({ method, url, headers, body }) => ({
        method,
        url,
        authorization: headers.authorization ?? null,
        body,
      }));
      return {
        exchange,
        journal,
        upstreamHits,
        warnings: warn.mock.calls,
        recordedFiles: readdirSync(fixturePath),
      };
    } finally {
      warn.mockRestore();
      await server.close();
    }
  } finally {
    try {
      await upstream.close();
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
    }
  }
}

describe("real video catalog equivalence", () => {
  it.each(cases)("$name preserves HTTP bytes, diagnostics and journal", async (testCase) => {
    const got = await captureCase(testCase);
    expect(got.exchange.status).toBe(200);
    expect(got.exchange.body).toBe(
      testCase.proxy
        ? PROXY_BODY
        : goldenBody(testCase.golden ?? "openrouter-video-models-defaults-empty-fixtures"),
    );
    expect(got.exchange.headers["content-type"]).toBe(
      testCase.proxy ? "application/json; charset=utf-8" : "application/json",
    );
    expect(got.journal).toEqual([
      {
        method: "GET",
        path: PATH,
        body: null,
        response: { status: 200, fixture: null, ...testCase.response },
      },
    ]);
    expect(got.warnings).toEqual(testCase.warning ? [[testCase.warning]] : []);
    const hits = testCase.proxy || testCase.record === "error";
    expect(got.upstreamHits).toEqual(
      hits
        ? [{ method: "GET", url: "/api/v1/videos/models", authorization: "Bearer k", body: "" }]
        : [],
    );
    expect(got.recordedFiles).toEqual([]);
    retainEvidence(testCase.name, got);
  });
});
