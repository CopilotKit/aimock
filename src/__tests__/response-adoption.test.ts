import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SURFACE_REGISTRY } from "./drift/surface-registry.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = resolve(root, "tsconfig.test.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

function relativeSource(node: ts.Node): string {
  return relative(root, node.getSourceFile().fileName).split("\\").join("/");
}

function source(path: string): ts.SourceFile {
  const file = program.getSourceFile(resolve(root, path));
  if (!file) throw new Error(`Missing adoption source: ${path}`);
  return file;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

function unalias(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function exported(path: string, name: string): ts.Symbol {
  const module = checker.getSymbolAtLocation(source(path));
  const symbol = module && checker.getExportsOfModule(module).find((entry) => entry.name === name);
  const target = unalias(symbol);
  if (!target) throw new Error(`Missing shared export: ${path}#${name}`);
  expect(
    target.declarations?.some(
      (declaration) => resolve(declaration.getSourceFile().fileName) === resolve(root, path),
    ),
    `${path}#${name} must be declared by its allocated owner`,
  ).toBe(true);
  return target;
}

function calls(node: ts.Node, target: ts.Symbol): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  walk(node, (child) => {
    if (
      ts.isCallExpression(child) &&
      unalias(checker.getSymbolAtLocation(child.expression)) === target
    )
      found.push(child);
  });
  return found;
}

function named(path: string, name: string): ts.Node {
  const found: ts.Node[] = [];
  walk(source(path), (node) => {
    if (
      ((ts.isFunctionDeclaration(node) && node.body) || ts.isVariableDeclaration(node)) &&
      node.name?.getText() === name
    )
      found.push(node);
  });
  expect(found, `${path}#${name} declaration`).toHaveLength(1);
  return found[0];
}

function declaredSymbol(node: ts.Node): ts.Symbol {
  if (!ts.isFunctionDeclaration(node) && !ts.isVariableDeclaration(node))
    throw new Error("Expected a named adoption scope");
  const symbol = node.name && checker.getSymbolAtLocation(node.name);
  if (!symbol) throw new Error(`Missing declaration symbol: ${node.getText().slice(0, 80)}`);
  return symbol;
}

function literal(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function objectFields(node: ts.Node): Map<string, ts.Expression> {
  const fields = new Map<string, ts.Expression>();
  if (!ts.isObjectLiteralExpression(node)) return fields;
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property))
      fields.set(property.name.getText().replace(/^['"]|['"]$/g, ""), property.initializer);
  }
  return fields;
}

function adoptionScope(node: ts.Node): string {
  const names: string[] = [];
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) names.unshift(parent.name.text);
    if (ts.isMethodDeclaration(parent)) names.unshift(parent.name.getText());
    if (
      (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
      ts.isVariableDeclaration(parent.parent)
    )
      names.unshift(parent.parent.name.getText());
  }
  return names.join("/") || "<module>";
}

function enclosingProperty(node: ts.Node, name: string): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (
      ts.isPropertyAssignment(parent) &&
      parent.name.getText().replace(/^['"]|['"]$/g, "") === name
    )
      return true;
  }
  return false;
}

function enclosingVariable(node: ts.Node, name: string): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent) && parent.name.getText() === name) return true;
  }
  return false;
}

function jsonStringifySymbol(): ts.Symbol {
  const context = source("src/helpers.ts");
  const json = checker
    .getSymbolsInScope(context, ts.SymbolFlags.Value)
    .find((symbol) => symbol.name === "JSON");
  const stringify =
    json && checker.getTypeOfSymbolAtLocation(json, context).getProperty("stringify");
  if (!stringify) throw new Error("Missing actual global JSON.stringify declaration");
  return stringify;
}

function callTarget(expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.Symbol | undefined {
  const symbol = unalias(checker.getSymbolAtLocation(expression));
  if (!symbol || seen.has(symbol)) return symbol;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = declaration.initializer;
    if (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer))
      return callTarget(initializer, seen);
  }
  return symbol;
}

function errorObjectClass(
  node: ts.ObjectLiteralExpression,
  inner: ts.ObjectLiteralExpression,
): string | undefined {
  const path = relativeSource(node);
  const scope = adoptionScope(node);
  const outer = adoptionFields(node);
  const fields = adoptionFields(inner);
  const keys = [...fields.keys()].sort().join(",");
  const type = literal(fields.get("type"));
  const message = fields.get("message")?.getText();
  if (
    path === "src/fixture-loader.ts" &&
    scope === "queueOneShotError" &&
    enclosingVariable(node, "errorResponse") &&
    outer.has("status") &&
    keys === "code,message,type"
  )
    return "fixture injection data";
  if (
    path === "src/helpers.ts" &&
    scope === "resolveMcpIdentity" &&
    outer.get("ok")?.kind === ts.SyntaxKind.FalseKeyword &&
    fields.has("status") &&
    fields.has("source") &&
    fields.has("field")
  )
    return "typed MCP identity result";
  if (
    path === "src/recorder.ts" &&
    scope === "buildFixtureResponse" &&
    outer.has("status") &&
    ["message,type", "code,message,type"].includes(keys)
  )
    return "upstream-to-fixture data";
  if (
    path === "src/recorder.ts" &&
    scope === "proxyAndRecord" &&
    ts.isBinaryExpression(node.parent) &&
    node.parent.left.getText() === "fixtureResponse" &&
    outer.has("status") &&
    keys === "code,message,type"
  )
    return "upstream-to-fixture assignment";
  if (
    path === "src/batches.ts" &&
    scope === "finish" &&
    outer.has("custom_id") &&
    outer.get("response")?.kind === ts.SyntaxKind.NullKeyword &&
    literal(fields.get("code")) === "mock_failure"
  )
    return "batch JSONL result data";
  if (
    path === "src/jsonrpc.ts" &&
    scope === "errorResponse" &&
    literal(outer.get("jsonrpc")) === "2.0" &&
    outer.has("id") &&
    keys === "code,message"
  )
    return "JSON-RPC protocol";
  if (
    path === "src/a2a-handler.ts" &&
    scope === "createA2AMethods" &&
    keys === "code,message" &&
    fields.get("code")?.getText().startsWith("-32")
  )
    return "A2A protocol";
  if (
    path === "src/a2a-mock.ts" &&
    ["handleRequest", "handleStreamingMessage"].includes(scope) &&
    keys === "code,message" &&
    literal(outer.get("jsonrpc")) === "2.0"
  )
    return "A2A JSON-RPC envelope";
  if (
    path === "src/mcp-recorder.ts" &&
    scope === "answerByFake" &&
    keys === "code,data,message" &&
    literal(outer.get("jsonrpc")) === "2.0"
  )
    return "MCP JSON-RPC envelope";
  if (
    path === "src/fal-audio.ts" &&
    scope === "handleQueueResult" &&
    keys === "message,type" &&
    type === "not_ready" &&
    message === '"Job result not yet available"'
  )
    return "native pending audio lifecycle";
  if (
    path === "src/openrouter-video.ts" &&
    [
      "handleOpenRouterVideoStatus",
      "handleOpenRouterVideoContent",
      "handleOpenRouterVideoCreate",
    ].includes(scope) &&
    keys === "code,message" &&
    ["400", "401", "404"].includes(fields.get("code")?.getText() ?? "")
  )
    return "native OpenRouter video numeric-code lifecycle";
  if (
    path === "src/veo-video.ts" &&
    scope === "geminiError" &&
    [...fields.keys()].join(",") === "code,message,status"
  )
    return "native Veo operation serializer";
  if (
    path === "src/veo-video.ts" &&
    scope === "handleVeoVideoStatus" &&
    keys === "code,message" &&
    fields.get("code")?.getText() === "3"
  )
    return "native Veo failed operation";
  if (path === "src/byteplus-video.ts" && scope === "arkErrorBody" && keys === "message")
    return "native Ark protocol";
  if (
    path === "src/ws-live.ts" &&
    scope === "handleLiveSession/fail" &&
    keys === "category,message" &&
    literal(outer.get("type")) === "aimock.error"
  )
    return "native OpenAI Live event";
  if (
    path === "src/ws-realtime.ts" &&
    scope === "rejectRetiredBetaShape" &&
    keys === "code,event_id,message,param,type" &&
    outer.has("event_id") &&
    literal(outer.get("type")) === "error"
  )
    return "native retired Realtime beta event";
  if (
    path === "src/ws-realtime.ts" &&
    ["checkRealtimeFixtureToolCalls", "handleResponseCreate"].includes(scope) &&
    keys === "code,message,type" &&
    enclosingProperty(node, "status_details") &&
    enclosingProperty(node, "response")
  )
    return "native Realtime response status details";
  if (
    path === "src/ws-gemini-live.ts" &&
    ["handleWebSocketGeminiLive", "processMessage"].includes(scope) &&
    keys === "code,message,status"
  )
    return "native Gemini Live event";
  if (
    path === "src/vector-handler.ts" &&
    scope === "handlePinecone" &&
    keys === "message" &&
    message === "`Collection '${namespace}' not found`"
  )
    return "native Pinecone collection error";
  return undefined;
}

function nonObjectErrorClass(
  node: ts.ObjectLiteralExpression,
  inner: ts.Expression,
): string | undefined {
  const path = relativeSource(node);
  const scope = adoptionScope(node);
  const firstScope = scope.split("/")[0];
  const fields = adoptionFields(node);
  const keys = [...fields.keys()].sort().join(",");
  if (
    ts.isCallExpression(inner) &&
    unalias(checker.getSymbolAtLocation(inner.expression)) ===
      exported("src/response/errors.ts", "buildOpenAIError")
  )
    return "shared typed inner builder";
  if (
    path === "src/recorder.ts" &&
    ["persistFixture", "persistServiceFakes"].includes(scope) &&
    fields.has("kind")
  )
    return "typed persistence outcome";
  if (path === "src/config-loader.ts" && scope === "parsePolicyFlags" && keys === "error,ok")
    return "CLI validation result";
  if (
    path === "src/files.ts" &&
    [
      "parseJsonUpload",
      "parseHeaderParams",
      "parsePart",
      "parseMultipartUpload",
      "singleParam",
      "parseListQuery",
      "bad",
    ].includes(firstScope) &&
    ["error", "error,param", "error,ok"].includes(keys)
  )
    return "typed Files parsing result";
  if (
    path === "src/files.ts" &&
    enclosingVariable(node, "MALFORMED_HEADER") &&
    keys === "error" &&
    literal(inner) === "malformed"
  )
    return "typed Files header parser sentinel";
  if (path === "src/mcp-fakes.ts" && scope === "validateCall" && keys === "error")
    return "fake-call validation data";
  if (
    path === "src/response/catalog/anthropic-page.ts" &&
    scope === "anthropicPage" &&
    keys === "error"
  )
    return "catalog page validation result";
  if (path === "src/response/catalog/gemini-page.ts" && scope === "geminiPage" && keys === "error")
    return "catalog page validation result";
  if (
    ["src/gemini.ts", "src/bedrock-converse.ts"].includes(path) &&
    ["handleGemini", "handleConverse", "handleConverseStream"].includes(scope) &&
    keys === "error,fixture,status"
  )
    return "request journal response data";
  if (
    path === "src/server.ts" &&
    scope === "startServer/handleHttpRequest" &&
    keys === "error,fixture,source,status"
  )
    return "request journal response data";
  if (path === "src/server.ts" && scope === "planControlApiFakes" && keys === "error,position")
    return "control validation result";
  if (
    path === "src/server.ts" &&
    [
      "writeBlankTestId",
      "handleControlAPI",
      "handleControlAPI/bad",
      "handleControlAPI/validationFailed",
      "startServer/routeError",
    ].includes(scope) &&
    ["error", "error,message,rule", "details,error"].includes(keys)
  )
    return "native control API text envelope";
  if (path === "src/server.ts" && scope === "startServer/handleUpgradeRequest" && keys === "error")
    return "native websocket handshake";
  if (
    path === "src/grok-video.ts" &&
    [
      "handleGrokVideoCreate",
      "handleGrokVideoStatus",
      "proxyGrokVideoSubmit",
      "proxyGrokVideoSubmit/proxyError",
      "proxyGrokVideoRecordPoll",
      "proxyGrokVideoRecordPoll/proxyError",
    ].includes(scope) &&
    keys === "code,error"
  )
    return "native Grok video code/text envelope";
  if (
    ["src/grok-video.ts", "src/veo-video.ts", "src/openrouter-video.ts"].includes(path) &&
    [
      "proxyGrokVideoRecordPoll",
      "proxyVeoVideoRecordPoll",
      "proxyOpenRouterVideoRecordPoll",
    ].includes(scope) &&
    keys === "error" &&
    enclosingVariable(node, "video") &&
    ts.isConditionalExpression(node.parent) &&
    node.parent.whenTrue === node &&
    ts.isSpreadAssignment(node.parent.parent.parent)
  )
    return "native upstream poll-error persistence";
  if (path === "src/ollama.ts" && scope === "prepareOllamaMisbehavior" && keys === "error")
    return "native prepared Ollama text error";
  if (
    path === "src/fine-tuning.ts" &&
    scope === "handleFineTuningCreate" &&
    fields.has("training_file") &&
    fields.has("finished_at") &&
    inner.kind === ts.SyntaxKind.NullKeyword
  )
    return "native fine-tuning lifecycle data";
  if (
    path === "src/batches.ts" &&
    scope === "finish" &&
    fields.has("custom_id") &&
    fields.has("response")
  )
    return "native batch JSONL result data";
  if (
    path === "src/live-recorder.ts" &&
    scope === "createLiveRecorder/finish" &&
    keys === "category,error,kind"
  )
    return "live recording outcome";
  if (path === "src/ws-live.ts" && scope === "handleLiveSession/recordJournal" && keys === "error")
    return "live recording journal data";
  const protocolScopes: Record<string, readonly string[]> = {
    "src/agui-recorder.ts": ["proxyAndRecordAGUI", "teeUpstreamStream"],
    "src/agui-mock.ts": ["handleRequest", "start"],
    "src/mcp-handler.ts": [
      "jsonRpcError",
      "createMCPRequestHandler",
      "createMCPRequestHandler/callFake",
      "createMCPRequestHandler/rejectIdentity",
      "createMCPRequestHandler/messageOf",
    ],
    "src/mcp-recorder.ts": ["handle", "forward", "relay"],
    "src/mcp-mock.ts": ["answerMethodNotAllowed", "journalRequest"],
    "src/mcp-fakes-report.ts": ["handleFakesReportRoute"],
    "src/vector-handler.ts": ["handleQdrant", "handleChromaDB"],
    "src/vector-mock.ts": ["handleRequest", "start"],
  };
  if (protocolScopes[path]?.includes(scope) && !fields.has("type") && !fields.has("message"))
    return "native service/control protocol or journal data";
  if (
    path === "src/ws-realtime.ts" &&
    scope === "sendLiveTranscriptionFailure" &&
    keys === "content_index,error,item_id,type" &&
    literal(fields.get("type")) === "conversation.item.input_audio_transcription.failed"
  )
    return "native transcription failure event";
  if (
    path === "src/ws-realtime.ts" &&
    ["processMessage", "sendLiveTranscriptionFailure"].includes(scope) &&
    literal(fields.get("type"))?.includes("error")
  )
    return "native Realtime event/transcription";
  return undefined;
}

function productionSources(): ts.SourceFile[] {
  return program.getSourceFiles().filter((file) => {
    const path = relativeSource(file);
    return path.startsWith("src/") && !path.includes("/__tests__/") && !file.isDeclarationFile;
  });
}

function adoptionFields(node: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
  const fields = objectFields(node);
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) fields.set(property.name.text, property.name);
  }
  return fields;
}

describe("A8 common-envelope inventory", () => {
  it("indexes the remaining non-object error payload flows", () => {
    const payloads: {
      path: string;
      scope: string;
      keys: string[];
      payload: string;
      classification?: string;
    }[] = [];
    for (const file of productionSources()) {
      if (relativeSource(file) === "src/response/errors.ts") continue;
      walk(file, (node) => {
        if (!ts.isObjectLiteralExpression(node)) return;
        const fields = adoptionFields(node);
        const inner = fields.get("error");
        if (!inner || ts.isObjectLiteralExpression(inner)) return;
        payloads.push({
          path: relativeSource(node),
          scope: adoptionScope(node),
          keys: [...fields.keys()],
          payload: inner.getText().slice(0, 120),
          classification: nonObjectErrorClass(node, inner),
        });
      });
    }
    const unclassified = payloads.filter((payload) => !payload.classification);
    console.log(
      JSON.stringify({ inventory: "A8-error-flows", total: payloads.length, unclassified }),
    );
    expect(
      unclassified,
      "non-object error fields must be assigned to actual owners, native protocols or typed data flows",
    ).toEqual([]);
  });
  it("does not retain inline serializers of named top-level common templates", () => {
    const local: string[] = [];
    const shapes = new Set(["message", "message,type", "code,message,type", "__type,message"]);
    const stringify = jsonStringifySymbol();
    for (const file of productionSources()) {
      if (relativeSource(file) === "src/response/errors.ts") continue;
      walk(file, (node) => {
        if (
          !ts.isCallExpression(node) ||
          callTarget(node.expression) !== stringify ||
          !node.arguments[0] ||
          !ts.isObjectLiteralExpression(node.arguments[0])
        )
          return;
        const shape = [...adoptionFields(node.arguments[0]).keys()].sort().join(",");
        if (shapes.has(shape))
          local.push(
            `${relativeSource(node)}#${adoptionScope(node)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
      });
    }
    expect(local, "common top-level serializers must live in the shared owner").toEqual([]);
  });
  it("retains only schema references among message-free literal error objects", () => {
    const unclassified: string[] = [];
    let total = 0;
    for (const file of productionSources()) {
      if (relativeSource(file) === "src/response/errors.ts") continue;
      walk(file, (node) => {
        if (!ts.isObjectLiteralExpression(node)) return;
        const inner = adoptionFields(node).get("error");
        if (!inner || !ts.isObjectLiteralExpression(inner)) return;
        const fields = adoptionFields(inner);
        if (fields.has("message")) return;
        total += 1;
        const schema =
          (relativeSource(node) === "src/openapi.ts" &&
            enclosingVariable(node, "COMPONENTS") &&
            enclosingProperty(node, "properties") &&
            (fields.has("type") ||
              ([...fields.keys()].join(",") === "$ref" &&
                literal(fields.get("$ref"))?.startsWith("#/components/schemas/")))) ||
          (relativeSource(node) === "src/live-fixture.ts" &&
            enclosingVariable(node, "SERVER_SCHEMAS") &&
            (literal(fields.get("type")) === "object" ||
              ([...fields.keys()].join(",") === "$ref" &&
                literal(fields.get("$ref"))?.startsWith("#/$defs/"))));
        if (!schema)
          unclassified.push(
            `${relativeSource(node)}#${adoptionScope(node)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
      });
    }
    console.log(JSON.stringify({ inventory: "A8-error-schemas", total, unclassified }));
    expect(
      unclassified,
      "message-free error objects require explicit schema/native classification",
    ).toEqual([]);
  });
  it("classifies every runtime error object with a message", () => {
    const candidates: {
      path: string;
      scope: string;
      line: number;
      keys: string[];
      type?: string;
      message: string;
      classification?: string;
    }[] = [];
    for (const file of productionSources()) {
      if (relativeSource(file) === "src/response/errors.ts") continue;
      walk(file, (node) => {
        if (!ts.isObjectLiteralExpression(node)) return;
        const inner = objectFields(node).get("error");
        if (!inner || !ts.isObjectLiteralExpression(inner)) return;
        const fields = adoptionFields(inner);
        const message = fields.get("message");
        if (!message) return;
        candidates.push({
          path: relativeSource(node),
          scope: adoptionScope(node),
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          keys: [...fields.keys()],
          type: literal(fields.get("type")),
          message: message.getText().slice(0, 100),
          classification: errorObjectClass(node, inner),
        });
      });
    }
    console.log(JSON.stringify({ inventory: "A8-common-envelope", candidates }));
    expect(
      candidates
        .filter((candidate) => !candidate.classification)
        .map(({ path, scope, line }) => ({ path, scope, line })),
      "every remaining common-like runtime envelope needs an exact semantic disposition",
    ).toEqual([]);
  });
});

const strictAllocation = [
  ["P0", "helpers", 1],
  ["P0", "mcp-recorder", 1],
  ["A1", "messages", 9],
  ["A1", "bedrock", 14],
  ["A2", "responses", 6],
  ["A2", "ws-responses", 4],
  ["A2", "ws-realtime", 6],
  ["A3", "gemini", 8],
  ["A3", "gemini-interactions", 3],
  ["A3", "ws-gemini-live", 3],
  ["A3", "ws-live", 3],
  ["A4", "bedrock-converse", 13],
  ["A4", "cohere", 9],
  ["A4", "ollama", 13],
  ["A5", "byteplus-video", 10],
  ["A5", "grok-video", 10],
  ["A5", "veo-video", 10],
  ["A5", "video", 3],
  ["A5", "openrouter-video", 18],
  ["A5", "fal", 3],
  ["A6", "elevenlabs-audio", 6],
  ["A6", "elevenlabs-voice", 10],
  ["A6", "fal-audio", 6],
  ["A6", "speech", 3],
  ["A6", "transcription", 3],
  ["A6", "images", 6],
  ["A7", "server", 7],
  ["A7", "embeddings", 2],
  ["A7", "gemini-embeddings", 2],
  ["A7", "moderation", 3],
  ["A7", "rerank", 3],
  ["A7", "search", 3],
] as const;

describe("A8 complete strict adoption", () => {
  it("accounts for all32 files and201 historical calls", () => {
    expect(strictAllocation).toHaveLength(32);
    expect(new Set(strictAllocation.map(([, file]) => file)).size).toBe(32);
    expect(strictAllocation.reduce((total, [, , count]) => total + count, 0)).toBe(201);
    console.log(JSON.stringify({ audit: "A8-strict", files: 32, historicalCalls: 201 }));
  });

  it.each(strictAllocation.filter(([, file]) => file !== "helpers"))(
    "%s %s uses the shared named decisions without old wrapper calls",
    (_slot, file, expected) => {
      const node = source(`src/${file}.ts`);
      const decisions = calls(node, exported("src/response/policy.ts", "resolveRequestDecisions"));
      const journals = calls(node, exported("src/response/policy.ts", "strictOverrideField"));
      const legacy = ["resolveStrictMode", "strictOverrideField"].flatMap((name) =>
        calls(node, exported("src/helpers.ts", name)),
      );
      expect(legacy.length).toBe(0);
      expect(decisions.length).toBeGreaterThan(0);
      // A1's accepted composed inventory adds F5B's required-header journal
      // site to Messages; the historical201-call allocation remains unchanged.
      const addedRequiredHeaderJournal = file === "messages" ? 1 : 0;
      expect(
        decisions.length + journals.length,
        `${file} accepted composed policy/journal sites`,
      ).toBe(expected + addedRequiredHeaderJournal);
      for (const statement of node.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          literal(statement.moduleSpecifier) !== "./helpers.js"
        )
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        expect(
          bindings.elements
            .filter((binding) =>
              ["resolveStrictMode", "strictOverrideField"].includes(
                (binding.propertyName ?? binding.name).text,
              ),
            )
            .map((binding) => binding.name.text),
        ).toEqual([]);
      }
    },
  );

  it("retains only forwarding wrappers and the one strict-header parser", () => {
    for (const name of ["resolveStrictMode", "strictOverrideField"]) {
      expect(
        calls(named("src/helpers.ts", name), exported("src/response/policy.ts", name)).length,
      ).toBe(1);
    }
    const accesses: string[] = [];
    const data: string[] = [];
    for (const file of productionSources())
      walk(file, (node) => {
        if (!ts.isStringLiteralLike(node) || node.text !== "x-aimock-strict") return;
        if (
          relativeSource(node) === "src/recorder.ts" &&
          ts.isArrayLiteralExpression(node.parent)
        ) {
          data.push(relativeSource(node));
          return;
        }
        accesses.push(`${relativeSource(node)}#${adoptionScope(node)}`);
        expect(
          ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node,
        ).toBe(true);
      });
    expect(accesses).toEqual(["src/response/policy.ts#resolveStrictMode"]);
    expect(data).toEqual(["src/recorder.ts"]);
  });
});

const commonScopeRows = [
  ["fal", "proxyAndRecordFalQueueSubmit", "transport-failure"],
  ["fal", "respondNotFound", "route-failure"],
  ["fal-audio", "handleFalQueue", "route-failure"],
  ["fal-audio", "handleQueueStatus", "route-failure"],
  ["fal-audio", "handleQueueResult", "route-failure"],
  ["veo-video", "proxyVeoVideoSubmit", "transport-failure"],
  ["veo-video", "proxyVeoVideoRecordPoll", "transport-failure"],
  ["openrouter-video", "proxyOpenRouterVideoRecordContent", "transport-failure"],
  ["openrouter-video", "proxyOpenRouterVideoSubmit", "transport-failure"],
  ["openrouter-video", "proxyOpenRouterVideoRecordPoll", "transport-failure"],
  ["video", "handleVideoStatus", "route-failure"],
  ["grok-video", "handleGrokVideoCreate", "unknown-response"],
  ["chaos", "applyChaosAction", "misbehavior"],
] as const;

describe("A8 error-only and supplemental direct consumers", () => {
  it("binds both accepted VectorMock wrapper guards to the existing validation owner", () => {
    const builder = exported("src/response/errors.ts", "buildOpenAIError");
    for (const name of ["handleRequest", "start"]) {
      const methods: ts.MethodDeclaration[] = [];
      walk(source("src/vector-mock.ts"), (node) => {
        if (ts.isMethodDeclaration(node) && node.name.getText() === name) methods.push(node);
      });
      expect(methods.length).toBe(1);
      const guards = calls(methods[0], builder).filter(
        (call) => literal(call.arguments[0]) === "service-validation",
      );
      expect(guards.length).toBe(1);
      const details = guards[0].arguments[1];
      if (!details || !ts.isObjectLiteralExpression(details)) {
        throw new Error(`Expected literal service-validation details in VectorMock.${name}`);
      }
      expect(adoptionFields(details).get("message")?.getText()).toBe(
        '"Request body must be a JSON object"',
      );
    }
  });
  it.each(commonScopeRows)(
    "%s %s delegates %s to its actual shared owner",
    (file, handler, purpose) => {
      const matches = calls(
        named(`src/${file}.ts`, handler),
        exported("src/response/errors.ts", "renderError"),
      ).filter((call) => literal(call.arguments[1]) === purpose);
      expect(matches.length).toBe(file === "chaos" ? 2 : 1);
      for (const call of matches) expect(literal(call.arguments[0])).toBe("openai");
    },
  );

  it("keeps every legacy error serializer caller delegated through its wrapper", () => {
    expect(
      calls(
        named("src/helpers.ts", "serializeErrorResponse"),
        exported("src/response/errors.ts", "renderError"),
      ).length,
    ).toBe(1);
    const wrapper = exported("src/helpers.ts", "serializeErrorResponse");
    const consumers = productionSources()
      .filter((file) => calls(file, wrapper).length > 0)
      .map(relativeSource)
      .sort();
    expect(consumers).toEqual([
      "src/byteplus-video.ts",
      "src/embeddings.ts",
      "src/fal.ts",
      "src/grok-video.ts",
      "src/openrouter-video.ts",
      "src/responses.ts",
      "src/server.ts",
      "src/veo-video.ts",
      "src/video.ts",
    ]);
  });

  it("binds every A9 service/OpenRouter wrapper and recorder failure to the common owner", () => {
    const builder = exported("src/response/errors.ts", "buildOpenAIError");
    for (const [file, handler] of [
      ["files", "invalidRequest"],
      ["batches", "invalid"],
      ["fine-tuning", "invalid"],
      ["vector-stores", "invalid"],
      ["openrouter-chat", "serializeOpenRouterError"],
    ]) {
      expect(calls(named(`src/${file}.ts`, handler), builder).length).toBe(1);
    }
    const failures = calls(
      named("src/recorder.ts", "proxyAndRecord"),
      exported("src/response/errors.ts", "renderError"),
    ).filter((call) => literal(call.arguments[1]) === "transport-failure");
    expect(failures.length).toBe(4);
    expect(
      calls(
        named("src/api-key-auth.ts", "writeApiKeyHttpRejection"),
        exported("src/response/errors.ts", "renderError"),
      ).length,
    ).toBe(1);
  });
});

describe("A8 native-error attribution", () => {
  it.each(["anthropic-native-errors", "gemini-native-auth"])(
    "%s names only an actual exported error owner",
    (slug) => {
      const mapping = SURFACE_REGISTRY[slug];
      for (const name of mapping.builderFunctions) exported(mapping.builderFile, name);
      expect(mapping.builderFile).toBe("src/response/errors.ts");
      expect(mapping.builderFunctions).toEqual(["renderError"]);
    },
  );
});

const ownerRows = [
  ["openai-chat", "openai", ["resolve", "render"]],
  ["openrouter-chat", "openrouter", ["resolve", "render"]],
  ["openai-responses", "responses", ["render"]],
  ["openai-responses-ws", "responses", ["render"]],
  ["anthropic", "anthropic", ["resolve", "render"]],
  ["bedrock-invoke", "anthropic", ["resolve", "render"]],
  ["bedrock-invoke-stream", "anthropic", ["resolve", "render"]],
  ["gemini", "gemini", ["render"]],
  ["vertex-ai", "gemini", ["render"]],
  ["gemini-interactions", "interactions", ["render"]],
  ["cohere-chat", "cohere", ["render"]],
  ["ollama", "ollama", ["render"]],
  ["openai-realtime", "realtime", ["render"]],
  ["bedrock-converse", "converse", ["render"]],
  ["bedrock-converse-stream", "converse", ["render"]],
] as const;

// Independently frozen from the complete pre-edit registry. Only the fifteen
// allocated builderFile/builderFunctions pairs are removed from this control.
const frozenRegistryCoverage = {
  "openai-chat": {
    provider: "OpenAI Chat",
    liveCoverage: "live",
    typesFile: "src/types.ts",
  },
  "openai-responses": {
    provider: "OpenAI Responses",
    liveCoverage: "live",
    typesFile: null,
  },
  anthropic: {
    provider: "Anthropic Claude",
    liveCoverage: "live",
    typesFile: null,
  },
  "anthropic-catalog": {
    provider: "Anthropic native catalog",
    liveCoverage: "live",
    coverageNote:
      "Local catalog validation/cursor/lifecycle contracts run always. Bounded vendor comparisons require AIMOCK_NATIVE_PROVIDER_DRIFT=1 and ANTHROPIC_API_KEY; skipped comparisons establish no vendor conformance. Exact unknown-cursor behavior is undocumented.",
    builderFile: "src/response/catalog/anthropic-page.ts",
    builderFunctions: ["anthropicPage", "renderAnthropicModels"],
    typesFile: null,
  },
  "gemini-catalog": {
    provider: "Gemini native catalog",
    liveCoverage: "live",
    coverageNote:
      "Local page validation contracts run always. Bounded vendor comparisons require AIMOCK_NATIVE_PROVIDER_DRIFT=1 and GOOGLE_API_KEY; skipped comparisons establish no vendor conformance. Mock offset tokens are an implementation contract, not documented vendor tokens.",
    builderFile: "src/response/catalog/gemini-page.ts",
    builderFunctions: ["geminiPage", "renderGeminiModels"],
    typesFile: null,
  },
  "anthropic-native-errors": {
    provider: "Anthropic native authentication and version",
    liveCoverage: "live",
    coverageNote:
      "Local auth and permissive missing-version behavior run always. Bounded vendor auth/version observations require AIMOCK_NATIVE_PROVIDER_DRIFT=1; missing-version also requires ANTHROPIC_API_KEY. This records intentional default-policy divergence; it does not enforce headers.",
    builderFile: "src/response/errors.ts",
    builderFunctions: ["renderError"],
    typesFile: null,
  },
  "gemini-native-auth": {
    provider: "Gemini native authentication",
    liveCoverage: "live",
    coverageNote:
      "Local mock HTTP auth401 runs always. Bounded unauthenticated Developer API observations require AIMOCK_NATIVE_PROVIDER_DRIFT=1. Google API-key rejection may differ from the mock's configured inbound auth; no 401 vendor equivalence is assumed.",
    builderFile: "src/response/errors.ts",
    builderFunctions: ["renderError"],
    typesFile: null,
  },
  gemini: {
    provider: "Google Gemini",
    liveCoverage: "live",
    typesFile: null,
  },
  "openai-live": {
    provider: "OpenAI Live",
    liveCoverage: "live",
    coverageNote:
      "Both delegation modes exercise the primary provider WebSocket and actual aimock replay. Shapes use reviewed raw-wire descriptors; the installed OpenAI SDK has no Live types. Missing OPENAI_API_KEY skips the live legs.",
    builderFile: "src/ws-live.ts",
    builderFunctions: ["handleLiveSession"],
    typesFile: "src/live-types.ts",
    sdkShapesFile: "src/__tests__/drift/live-scenarios.ts",
  },
  "openai-realtime": {
    provider: "OpenAI Realtime",
    liveCoverage: "live",
    typesFile: null,
  },
  "openai-responses-ws": {
    provider: "OpenAI Responses WS",
    liveCoverage: "live",
    typesFile: null,
  },
  "gemini-live": {
    provider: "Gemini Live",
    liveCoverage: "live",
    builderFile: "src/ws-gemini-live.ts",
    builderFunctions: ["handleWebSocketGeminiLive"],
    typesFile: null,
  },
  "openai-embeddings": {
    provider: "OpenAI Embeddings",
    liveCoverage: "live",
    builderFile: "src/helpers.ts",
    builderFunctions: ["buildEmbeddingResponse", "generateDeterministicEmbedding"],
    typesFile: null,
    sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
  },
  "gemini-interactions": {
    provider: "Gemini Interactions",
    liveCoverage: "live",
    typesFile: null,
  },
  "cohere-chat": {
    provider: "Cohere Chat",
    liveCoverage: "live",
    typesFile: null,
  },
  rerank: {
    provider: "Cohere Rerank",
    liveCoverage: "live",
    builderFile: "src/rerank.ts",
    builderFunctions: ["handleRerank"],
    typesFile: null,
  },
  "bedrock-invoke": {
    provider: "Bedrock Invoke",
    liveCoverage: "none",
    coverageNote:
      "No live AWS leg: nothing in this repo implements SigV4 request signing (no @aws-sdk dependency, no HMAC signer), so the Bedrock legs only drive the local mock. Offline conformance only.",
    typesFile: null,
  },
  "bedrock-invoke-stream": {
    provider: "Bedrock InvokeStream",
    liveCoverage: "none",
    coverageNote:
      "No live AWS leg — see `bedrock-invoke`. The binary event-stream frames are graded against a hand-written fixture, never against Bedrock.",
    typesFile: null,
  },
  "bedrock-converse": {
    provider: "Bedrock Converse",
    liveCoverage: "none",
    coverageNote: "No live AWS leg — see `bedrock-invoke`. Offline conformance only.",
    typesFile: null,
  },
  "bedrock-converse-stream": {
    provider: "Bedrock ConverseStream",
    liveCoverage: "none",
    coverageNote: "No live AWS leg — see `bedrock-invoke`. Offline conformance only.",
    typesFile: null,
  },
  ollama: {
    provider: "Ollama",
    liveCoverage: "live",
    typesFile: null,
  },
  "fal-sync": {
    provider: "fal.ai sync-run",
    liveCoverage: "none",
    coverageNote:
      "No live fal.ai leg: `fal.drift.ts` only drives the local mock's sync-run passthrough. The QUEUE surface (`fal-queue`) does have a live canary; this one does not.",
    builderFile: "src/fal.ts",
    builderFunctions: ["handleFal", "imageResponseToFalJson", "videoResponseToFalJson"],
    typesFile: null,
  },
  "fal-queue": {
    provider: "fal.ai queue",
    liveCoverage: "live",
    builderFile: "src/fal.ts",
    builderFunctions: ["handleFal", "walkFalQueue", "resolveProgression"],
    typesFile: null,
  },
  elevenlabs: {
    provider: "ElevenLabs",
    liveCoverage: "live",
    coverageNote:
      "Live credit rests on ONE block: the `/v1/sound-generation` case fetches `api.elevenlabs.io` and grades aimock's response envelope (status, Content-Type, body presence) against the vendor's. The body is opaque audio, so no vendor-observed JSON shape exists for any route here. `/v1/music`, `/v1/music/stream` and the 400 cases are offline conformance; `/v1/music/plan` is passthrough conformance against a test-authored fixture graded against the SDK's `MusicPrompt.Raw`, with no vendor observation.",
    builderFile: "src/elevenlabs-audio.ts",
    builderFunctions: ["handleElevenLabsTTS", "handleElevenLabsAudio"],
    typesFile: null,
  },
  "elevenlabs-voice": {
    provider: "ElevenLabs Voice Design",
    liveCoverage: "none",
    coverageNote:
      "No live ElevenLabs Voice Design leg: `elevenlabs-voice.drift.ts` only drives the local mock. A key is provided in CI (test-drift.yml and fix-drift.yml pass `secrets.ELEVENLABS_API_KEY`), but no case in that file fetches the vendor with it — these routes have no vendor leg and are offline-only — so no SUCCESSFUL response from any of these routes has ever been observed here — the shapes come from `@elevenlabs/elevenlabs-js@2.68.0` serialization types, a secondary source. Offline conformance only: it reds when aimock's own serializer changes shape, never when the vendor does. Retiring this needs a funded key and one recorded design + create round-trip; the `elevenlabs` surface's live `/v1/sound-generation` leg does NOT cover these routes.",
    builderFile: "src/elevenlabs-voice.ts",
    builderFunctions: [
      "voiceDesignToJson",
      "handleElevenLabsVoiceDesign",
      "handleElevenLabsVoiceCreate",
      "buildSyntheticVoice",
    ],
    typesFile: "src/types.ts",
  },
  images: {
    provider: "OpenAI Images",
    liveCoverage: "none",
    coverageNote:
      "No live OpenAI Images leg: `images.drift.ts` only drives the local mock. Offline conformance only. `/v1/images/variations` is out of scope entirely — the endpoint is REMOVED upstream (404, zero-byte body, observed 2026-09-15) and `handleImageVariations` now replays that removal, so it is not a response builder and must not be steered at as one; it is pinned by `image-edits.test.ts`.",
    builderFile: "src/images.ts",
    builderFunctions: ["handleImages", "handleImageEdit"],
    typesFile: null,
  },
  video: {
    provider: "OpenAI Video",
    liveCoverage: "none",
    coverageNote:
      "No live OpenAI Video leg: `video.drift.ts` only drives the local mock. Offline conformance only.",
    builderFile: "src/video.ts",
    builderFunctions: ["handleVideoCreate", "handleVideoStatus"],
    typesFile: null,
  },
  moderation: {
    provider: "OpenAI Moderations",
    liveCoverage: "none",
    coverageNote:
      "No live OpenAI Moderations leg: `moderation.drift.ts` only drives the local mock. Offline conformance only.",
    builderFile: "src/moderation.ts",
    builderFunctions: ["handleModeration"],
    typesFile: null,
  },
  transcription: {
    provider: "Transcription",
    liveCoverage: "live",
    builderFile: "src/transcription.ts",
    builderFunctions: ["handleTranscription", "extractFormField", "extractBoundary"],
    typesFile: null,
  },
  "vertex-ai": {
    provider: "Vertex AI",
    liveCoverage: "none",
    coverageNote:
      "No live Vertex leg: `vertex-ai.drift.ts` only drives the local mock's Vertex-style path. A live leg needs a GCP service account and an OAuth2 token exchange, neither of which this repo does.",
    typesFile: null,
  },
  "byteplus-video": {
    provider: "BytePlus Video",
    liveCoverage: "live",
    builderFile: "src/byteplus-video.ts",
    builderFunctions: [
      "handleBytePlusVideoCreate",
      "handleBytePlusVideoStatus",
      "proxyBytePlusVideoSubmit",
      "serializeBytePlusVideoTask",
    ],
    typesFile: null,
    sdkShapesFile: "src/__tests__/drift/byteplus-video.drift.ts",
  },
  "openrouter-video": {
    provider: "OpenRouter Video",
    liveCoverage: "live",
    builderFile: "src/openrouter-video.ts",
    builderFunctions: [
      "handleOpenRouterVideoCreate",
      "handleOpenRouterVideoStatus",
      "handleOpenRouterVideoModels",
      "handleOpenRouterVideoContent",
    ],
    typesFile: null,
  },
  "openrouter-chat": {
    provider: "OpenRouter Chat",
    liveCoverage: "live",
    typesFile: "src/types.ts",
  },
};

describe("W7 attribution", () => {
  it.each(ownerRows)("%s names its actual shared primary owner", (slug, codec, functions) => {
    const mapping = SURFACE_REGISTRY[slug];
    expect(mapping.builderFile).toBe(`src/response/usage/codecs/${codec}.ts`);
    expect(mapping.builderFunctions).toEqual(functions);
  });

  it.each(ownerRows)(
    "%s shared functions resolve to real exported declarations",
    (_slug, codec, functions) => {
      for (const name of functions) exported(`src/response/usage/codecs/${codec}.ts`, name);
    },
  );

  it("preserves every registry entry and all nonallocated coverage fields", () => {
    const allocated = new Set<string>(ownerRows.map(([slug]) => slug));
    const coverage = Object.fromEntries(
      Object.entries(SURFACE_REGISTRY).map(([slug, mapping]) => {
        const { builderFile, builderFunctions, ...other } = mapping;
        return [slug, allocated.has(slug) ? other : { builderFile, builderFunctions, ...other }];
      }),
    );
    expect(coverage).toEqual(frozenRegistryCoverage);
  });
});

const codecCallInventory = [
  ["helpers.ts", "openai", "resolve", 1],
  ["helpers.ts", "openai", "render", 1],
  ["openrouter-chat.ts", "openrouter", "resolve", 1],
  ["openrouter-chat.ts", "openrouter", "render", 1],
  ["responses.ts", "responses", "render", 5],
  ["messages.ts", "anthropic", "resolve", 11],
  ["messages.ts", "anthropic", "render", 13],
  ["bedrock.ts", "anthropic", "resolve", 5],
  ["bedrock.ts", "anthropic", "render", 5],
  ["bedrock-converse.ts", "converse", "render", 2],
  ["gemini.ts", "gemini", "render", 4],
  ["gemini-interactions.ts", "interactions", "render", 2],
  ["cohere.ts", "cohere", "render", 1],
  ["ollama.ts", "ollama", "render", 3],
  ["ws-realtime.ts", "realtime", "render", 8],
] as const;

describe("W7 aggregate usage adoption", () => {
  it.each(codecCallInventory)(
    "%s resolves all %s.%s calls to the shared declaration",
    (file, codec, name, count) => {
      expect(
        calls(source(`src/${file}`), exported(`src/response/usage/codecs/${codec}.ts`, name)),
      ).toHaveLength(count);
    },
  );

  it.each([
    ["helpers.ts", "resolveUsage", "openai", "render"],
    ["openrouter-chat.ts", "augmentUsage", "openrouter", "render"],
    ["bedrock-converse.ts", "converseUsage", "converse", "render"],
    ["gemini.ts", "geminiUsageMetadata", "gemini", "render"],
    ["gemini-interactions.ts", "interactionsUsage", "interactions", "render"],
    ["cohere.ts", "cohereUsage", "cohere", "render"],
    ["ollama.ts", "DURATION_FIELDS", "ollama", "render"],
  ])(
    "%s %s delegates its projection without rebuilding native counts",
    (file, name, codec, operation) => {
      const scope = named(`src/${file}`, name);
      const nativeCountKeys = new Set([
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "promptTokenCount",
        "candidatesTokenCount",
        "totalTokenCount",
        "total_input_tokens",
        "total_output_tokens",
        "prompt_eval_count",
        "eval_count",
        "billed_units",
        "tokens",
        "inputTokens",
        "outputTokens",
        "totalTokens",
      ]);
      const duplicates: string[] = [];
      walk(scope, (node) => {
        let sharedContext = false;
        for (let parent = node.parent; parent && parent !== scope; parent = parent.parent) {
          if (!ts.isCallExpression(parent)) continue;
          const declaration = unalias(checker.getSymbolAtLocation(parent.expression))
            ?.declarations?.[0];
          if (declaration && relativeSource(declaration).startsWith("src/response/usage/"))
            sharedContext = true;
        }
        if (
          !sharedContext &&
          ts.isPropertyAssignment(node) &&
          nativeCountKeys.has(node.name.getText().replace(/^['"]|['"]$/g, ""))
        )
          duplicates.push(node.getText());
      });
      expect(duplicates).toEqual([]);
      expect(
        calls(scope, exported(`src/response/usage/codecs/${codec}.ts`, operation)).length,
      ).toBeGreaterThan(0);
    },
  );

  it("covers OpenAI ordinary completions, full applied estimation and all four streaming callers", () => {
    const usage = declaredSymbol(named("src/helpers.ts", "resolveUsage"));
    for (const name of [
      "buildTextCompletion",
      "buildToolCallCompletion",
      "buildContentWithToolCallsCompletion",
      "resolveOpenAIChatMisbehaviorUsage",
    ])
      expect(calls(named("src/helpers.ts", name), usage), name).toHaveLength(1);
    const server = source("src/server.ts");
    expect(calls(server, usage)).toHaveLength(1);
    const wrapper = declaredSymbol(named("src/server.ts", "resolveStreamingUsageTokens"));
    expect(calls(server, wrapper)).toHaveLength(4);
    expect(calls(named("src/helpers.ts", "buildUsageChunk"), usage)).toEqual([]);
  });

  it("retains OpenRouter ordinary/applied augmentation callers", () => {
    const wrapper = declaredSymbol(named("src/openrouter-chat.ts", "augmentUsage"));
    expect(calls(source("src/openrouter-chat.ts"), wrapper)).toHaveLength(2);
  });

  it("covers ten ordinary Messages positions and all applied final/delta positions", () => {
    const renders = calls(
      source("src/messages.ts"),
      exported("src/response/usage/codecs/anthropic.ts", "render"),
    );
    expect(
      renders.filter((call) => literal(call.arguments[2]) === "applied-misbehavior"),
    ).toHaveLength(3);
    expect(
      renders.filter((call) => literal(call.arguments[2]) !== "applied-misbehavior"),
    ).toHaveLength(10);
    expect(
      renders
        .filter((call) => literal(call.arguments[2]) === "applied-misbehavior")
        .map((call) => literal(call.arguments[1])),
    ).toEqual(["messages-final", "messages-delta", "messages-delta"]);
  });

  it("covers Bedrock final, start and delta projections and every helper caller", () => {
    const renders = calls(
      source("src/bedrock.ts"),
      exported("src/response/usage/codecs/anthropic.ts", "render"),
    );
    expect(renders.map((call) => literal(call.arguments[1]))).toEqual([
      "bedrock-final",
      "bedrock-final",
      "bedrock-final",
      "bedrock-start",
      "bedrock-delta",
    ]);
    for (const [name, count] of [
      ["buildBedrockInvokeMessageStart", 3],
      ["buildBedrockInvokeMessageDelta", 4],
    ] as const)
      expect(
        calls(source("src/bedrock.ts"), declaredSymbol(named("src/bedrock.ts", name))),
        name,
      ).toHaveLength(count);
  });

  it.each([
    ["bedrock-converse.ts", "converseUsage", 7],
    ["gemini.ts", "geminiUsageMetadata", 9],
    ["gemini-interactions.ts", "interactionsUsage", 6],
    ["cohere.ts", "cohereUsage", 7],
  ] as const)("%s retains every ordinary %s caller", (file, name, count) => {
    expect(calls(source(`src/${file}`), declaredSymbol(named(`src/${file}`, name)))).toHaveLength(
      Number(count),
    );
  });

  it("retains the Converse prepared usage type dependency separately from its seven calls", () => {
    const wrapper = declaredSymbol(named("src/bedrock-converse.ts", "converseUsage"));
    const queries: ts.TypeQueryNode[] = [];
    walk(source("src/bedrock-converse.ts"), (node) => {
      if (ts.isTypeQueryNode(node) && checker.getSymbolAtLocation(node.exprName) === wrapper)
        queries.push(node);
    });
    expect(queries).toHaveLength(1);
  });

  it("retains all Ollama final spreads while leaving durations with transport", () => {
    const duration = declaredSymbol(named("src/ollama.ts", "DURATION_FIELDS"));
    const spreads: ts.SpreadAssignment[] = [];
    walk(source("src/ollama.ts"), (node) => {
      if (ts.isSpreadAssignment(node) && checker.getSymbolAtLocation(node.expression) === duration)
        spreads.push(node);
    });
    expect(spreads).toHaveLength(11);
    const fields = objectFields(
      (named("src/ollama.ts", "DURATION_FIELDS") as ts.VariableDeclaration).initializer!,
    );
    expect([...fields.keys()]).toEqual([
      "done_reason",
      "total_duration",
      "load_duration",
      "prompt_eval_duration",
      "eval_duration",
    ]);
  });

  it("keeps Responses HTTP and websocket ordinary/applied builders connected", () => {
    const ws = source("src/ws-responses.ts");
    for (const name of [
      "prepareResponsesMisbehavior",
      "buildResponsesMisbehavior",
      "buildTextStreamEvents",
      "toolCallStreamEvents",
      "contentWithToolCallsStreamEvents",
    ])
      expect(calls(ws, exported("src/responses.ts", name)).length, name).toBeGreaterThan(0);
    expect(calls(ws, exported("src/response/usage/codecs/responses.ts", "render"))).toEqual([]);
  });

  it("preserves all eight Realtime chat variants without taking transcription/null ownership", () => {
    const renders = calls(
      source("src/ws-realtime.ts"),
      exported("src/response/usage/codecs/realtime.ts", "render"),
    );
    expect(renders).toHaveLength(8);
    expect(
      calls(
        named("src/ws-realtime.ts", "defaultTranscriptionUsage"),
        exported("src/response/usage/codecs/realtime.ts", "render"),
      ),
    ).toEqual([]);
    const nullUsage: ts.PropertyAssignment[] = [];
    walk(source("src/ws-realtime.ts"), (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === "usage" &&
        node.initializer.kind === ts.SyntaxKind.NullKeyword
      )
        nullUsage.push(node);
    });
    expect(nullUsage.length).toBeGreaterThan(0);
  });
});

describe("W7 shared classification and finish removal", () => {
  it("keeps validator definitions and final sanitizer distinct and shared", () => {
    const definition = exported("src/response/usage/fields.ts", "getUsageFieldDefinition");
    expect(calls(source("src/fixture-loader.ts"), definition)).toHaveLength(1);
    expect(calls(named("src/response/usage/fields.ts", "sanitizeUsage"), definition)).toHaveLength(
      1,
    );
    expect(
      calls(
        source("src/response/usage/recording.ts"),
        exported("src/response/usage/fields.ts", "sanitizeUsage"),
      ),
    ).toHaveLength(1);
    expect(
      calls(
        named("src/recorder.ts", "sanitizeRecordedUsage"),
        exported("src/response/usage/recording.ts", "captureUsage"),
      ),
    ).toHaveLength(1);
  });

  it("rejects duplicated local usage classifiers and numeric-member lists", () => {
    const duplicates: string[] = [];
    for (const file of ["src/fixture-loader.ts", "src/recorder.ts", "src/stream-collapse.ts"]) {
      walk(source(file), (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          /^(USAGE_(OBJECT|BOOLEAN|FIELD)|CACHE_CREATION_|COST_DETAILS_|PROMPT_TOKENS_DETAILS_|COMPLETION_TOKENS_DETAILS_)/.test(
            node.name.getText(),
          )
        )
          duplicates.push(`${file}:${node.name.getText()}`);
        if (
          ts.isPropertyAssignment(node) &&
          ["numericMembers", "number-or-object"].includes(
            node.name.getText().replace(/^['"]|['"]$/g, ""),
          )
        )
          duplicates.push(`${file}:${node.getText()}`);
        if (
          ts.isArrayLiteralExpression(node) &&
          node.elements.filter(
            (entry) =>
              literal(entry) === "ephemeral_5m_input_tokens" ||
              literal(entry) === "ephemeral_1h_input_tokens",
          ).length === 2
        )
          duplicates.push(`${file}:${node.getText()}`);
      });
    }
    expect(duplicates).toEqual([]);
  });

  it.each([
    ["messages.ts", "claudeStopReason", "mapAnthropicFinish"],
    ["bedrock.ts", "bedrockStopReason", "mapAnthropicFinish"],
    ["bedrock-converse.ts", "converseStopReason", "mapAnthropicFinish"],
    ["responses.ts", "responsesStatus", "mapResponsesFinish"],
    ["gemini.ts", "geminiFinishReason", "mapGeminiFinish"],
    ["cohere.ts", "cohereFinishReason", "mapCohereFinish"],
  ])("%s %s delegates the finish map without retaining a local table", (file, name, shared) => {
    const scope = named(`src/${file}`, name);
    const tables: string[] = [];
    walk(scope, (node) => {
      if (
        ts.isSwitchStatement(node) ||
        ts.isObjectLiteralExpression(node) ||
        ts.isArrayLiteralExpression(node)
      )
        tables.push(node.getText());
      if (
        ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(
          node.operatorToken.kind,
        ) &&
        [literal(node.left), literal(node.right)].some(
          (value) => value && ["stop", "tool_calls", "length", "content_filter"].includes(value),
        )
      )
        tables.push(node.getText());
    });
    expect(tables).toEqual([]);
    expect(calls(scope, exported("src/response/finish.ts", shared))).toHaveLength(1);
  });
});

describe("W7 recording adoption", () => {
  const capture = () => exported("src/response/usage/recording.ts", "captureUsage");

  it.each([
    ["collapseOpenAISSE", "collapseOpenAISSEWithResponsesTools"],
    ["collapseStreamingResponse", "collapseStreamingResponseWithResponsesTools"],
  ])("%s preserves the public delegation through %s", (wrapper, implementation) => {
    const scope = named("src/stream-collapse.ts", wrapper);
    expect(
      calls(scope, declaredSymbol(named("src/stream-collapse.ts", implementation))),
    ).toHaveLength(1);
    expect(
      calls(scope, declaredSymbol(named("src/stream-collapse.ts", "withoutResponsesToolFields"))),
    ).toHaveLength(1);
    expect(calls(scope, capture())).toHaveLength(0);
  });

  it("rejects local capture merging and final sanitation loops in the named readers", () => {
    const duplicates: string[] = [];
    for (const name of [
      "collapseOpenAISSEWithResponsesTools",
      "collapseAnthropicSSE",
      "collapseGeminiSSE",
      "collapseOllamaNDJSON",
      "collapseCohereSSE",
      "collapseBedrockEventStream",
      "collapseGeminiInteractionsSSE",
    ]) {
      const scope = named("src/stream-collapse.ts", name);
      walk(scope, (node) => {
        if (
          !ts.isBinaryExpression(node) ||
          node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
          !ts.isIdentifier(node.left)
        )
          return;
        const binding = checker.getSymbolAtLocation(node.left);
        if (
          !binding?.declarations?.some(
            (declaration) =>
              ts.isVariableDeclaration(declaration) && declaration.name.getText() === "usage",
          )
        )
          return;
        const target = ts.isCallExpression(node.right)
          ? unalias(checker.getSymbolAtLocation(node.right.expression))
          : undefined;
        if (
          !target?.declarations?.some(
            (declaration) => relativeSource(declaration) === "src/response/usage/recording.ts",
          )
        )
          duplicates.push(`${name}:${node.getText()}`);
      });
    }
    walk(named("src/recorder.ts", "sanitizeRecordedUsage"), (node) => {
      if (ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node))
        duplicates.push(node.getText());
    });
    expect(duplicates).toEqual([]);
  });

  it.each([
    ["recorder.ts", 11],
    ["stream-collapse.ts", 10],
  ] as const)("%s retains every capture call", (file, count) => {
    expect(calls(source(`src/${file}`), capture())).toHaveLength(count);
  });

  it("retains all recognized nonstream families and final sanitation contexts", () => {
    const contexts = calls(source("src/recorder.ts"), capture()).map((call) =>
      objectFields(call.arguments[0]),
    );
    expect(
      contexts.map(
        (context) => `${literal(context.get("family"))}:${literal(context.get("stage"))}`,
      ),
    ).toEqual([
      "final:final",
      "final:final",
      "transcription:nonstream",
      "interactions:nonstream",
      "openai:nonstream",
      "anthropic:nonstream",
      "gemini:nonstream",
      "bedrock-converse:nonstream",
      "cohere:nonstream",
      "ollama:nonstream",
      "ollama:nonstream",
    ]);
  });

  it.each([
    ["collapseOpenAISSEWithResponsesTools", 2],
    ["collapseAnthropicSSE", 1],
    ["collapseResponsesJSON", 1],
    ["collapseGeminiSSE", 1],
    ["collapseOllamaNDJSON", 1],
    ["collapseCohereSSE", 1],
    ["collapseBedrockEventStream", 1],
    ["collapseGeminiInteractionsSSE", 1],
    ["collapseStreamingResponseWithResponsesTools", 1],
  ] as const)("%s delegates every stream/collapsed usage reader", (name, count) => {
    expect(calls(named("src/stream-collapse.ts", name), capture())).toHaveLength(Number(count));
  });

  it("routes every recognized dispatcher return through capture with unchanged precedence and fallback", () => {
    const scope = named("src/stream-collapse.ts", "collapseStreamingResponseWithResponsesTools");
    const complete = declaredSymbol(named("src/stream-collapse.ts", "complete"));
    const returns: ts.ReturnStatement[] = [];
    const contentTypes: string[] = [];
    const providers: string[] = [];
    walk(scope, (node) => {
      if (ts.isReturnStatement(node)) returns.push(node);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "includes"
      ) {
        const text = literal(node.arguments[0]);
        if (text) contentTypes.push(text);
      }
      if (ts.isCaseClause(node)) {
        const text = literal(node.expression);
        if (text) providers.push(text);
      }
    });
    expect(contentTypes).toEqual([
      "application/vnd.amazon.eventstream",
      "application/x-ndjson",
      "text/event-stream",
    ]);
    expect(providers).toEqual([
      "openai",
      "azure",
      "openrouter",
      "byteplus",
      "anthropic",
      "gemini",
      "vertexai",
      "gemini-interactions",
      "cohere",
      "bedrock",
    ]);
    const served = returns.filter(
      (node) => node.expression && ts.isCallExpression(node.expression),
    );
    expect(served).toHaveLength(9);
    expect(
      served.every(
        (node) =>
          node.expression &&
          ts.isCallExpression(node.expression) &&
          unalias(checker.getSymbolAtLocation(node.expression.expression)) === complete,
      ),
    ).toBe(true);
    const routedFunctions = served.map((node) => {
      if (!node.expression || !ts.isCallExpression(node.expression))
        throw new Error("Missing complete return");
      const inner = node.expression.arguments[0];
      if (!ts.isCallExpression(inner)) throw new Error("Missing actual dispatcher callee");
      return unalias(checker.getSymbolAtLocation(inner.expression));
    });
    const expectedRoutes = [
      "collapseBedrockEventStream",
      "collapseOllamaNDJSON",
      "collapseOpenAISSEWithResponsesTools",
      "collapseAnthropicSSE",
      "collapseGeminiSSE",
      "collapseGeminiInteractionsSSE",
      "collapseCohereSSE",
      "collapseAnthropicSSE",
      "collapseOpenAISSEWithResponsesTools",
    ];
    expectedRoutes.forEach((name, index) => {
      expect(
        routedFunctions[index] === declaredSymbol(named("src/stream-collapse.ts", name)),
        name,
      ).toBe(true);
    });
    expect(
      returns.filter((node) => node.expression?.kind === ts.SyntaxKind.NullKeyword),
    ).toHaveLength(1);
    const context = objectFields(calls(scope, capture())[0].arguments[0]);
    expect(literal(context.get("family"))).toBe("stream-dispatch");
    expect(literal(context.get("stage"))).toBe("collapsed");
    const fallback = calls(
      scope,
      exported("src/stream-collapse.ts", "collapseOpenAISSEWithResponsesTools"),
    );
    expect(fallback).toHaveLength(2);
  });

  it("keeps capture-family precedence, accepted omission modes and sanitation in their shared owner", () => {
    const family = named("src/response/usage/recording.ts", "selectedFamily");
    const mode = named("src/response/usage/recording.ts", "mode");
    const modeCases: string[] = [];
    const contentTypes: string[] = [];
    const returnModes: string[] = [];
    const stagedModes: Array<[string | undefined, string | undefined]> = [];
    const stageConditions: ts.Expression[] = [];
    walk(family, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "includes"
      ) {
        const text = literal(node.arguments[0]);
        if (text) contentTypes.push(text);
      }
    });
    walk(mode, (node) => {
      if (ts.isCaseClause(node)) {
        const text = literal(node.expression);
        if (text) modeCases.push(text);
      }
      if (ts.isReturnStatement(node)) {
        const text = literal(node.expression);
        if (text) returnModes.push(text);
      }
      if (ts.isConditionalExpression(node)) {
        stagedModes.push([literal(node.whenTrue), literal(node.whenFalse)]);
        stageConditions.push(node.condition);
      }
    });
    expect(contentTypes).toEqual([
      "application/vnd.amazon.eventstream",
      "application/x-ndjson",
      "text/event-stream",
    ]);
    expect(modeCases).toEqual([
      "openai",
      "transcription",
      "anthropic",
      "bedrock-invoke",
      "gemini",
      "ollama",
      "cohere",
      "bedrock-converse",
      "interactions",
    ]);
    expect(returnModes).toEqual(["sanitize", "anthropic-merge", "omit"]);
    expect(stagedModes).toEqual([
      ["sanitize", "last-nonempty"],
      ["transcription-object", "last-nonempty"],
    ]);
    expect(
      stageConditions.map(
        (condition) =>
          ts.isBinaryExpression(condition) &&
          condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          condition.left.getText() === "stage" &&
          literal(condition.right),
      ),
    ).toEqual(["nonstream", "nonstream"]);
    expect(calls(mode, declaredSymbol(family))).toHaveLength(1);
    const anthroCapture = exported("src/response/usage/codecs/anthropic.ts", "capture");
    expect(
      calls(named("src/response/usage/recording.ts", "captureUsage"), anthroCapture),
    ).toHaveLength(3);
  });
});

// Keep this suite source-bound: neither retained proof paths nor historical
// source overrides are an input to CI. Historical sensitivity runs use a
// separate read-only checkout of the same test against authentic old sources.
