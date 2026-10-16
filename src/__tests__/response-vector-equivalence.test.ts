import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { Journal } from "../journal.js";
import { LLMock } from "../llmock.js";
import { createMetricsRegistry } from "../metrics.js";
import { VectorMock } from "../vector-mock.js";
import { captureRawHttp, expectGolden } from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const requests = [
  { id: "non-object-null", body: "null", status: 400 },
  { id: "non-object-array", body: "[]", status: 400 },
  { id: "non-object-scalar", body: '"vector scalar"', status: 400 },
  { id: "native-query", body: '{"vector":[1,0],"topK":1}', status: 200 },
  { id: "malformed-json", body: '{"vector":', status: 400 },
] as const;
const headers = {
  host: "vector.local",
  connection: "close",
  "content-type": "application/json",
  "x-request-id": "vector-caller-trace",
};

function seededVector() {
  return new VectorMock({ host: "127.0.0.1", port: 0 })
    .addCollection("default", { dimension: 2 })
    .upsert("default", [{ id: "v1", values: [1, 0] }])
    .onQuery("default", (query) => {
      expect(query).toMatchObject({ vector: [1, 0], topK: 1, collection: "default" });
      return [{ id: "v1", score: 1 }];
    });
}

function rawRequest(path: string, body: string) {
  return [
    `POST ${path} HTTP/1.1`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    `content-length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

async function withCleanup(action: () => Promise<void>, cleanup: () => Promise<void>) {
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    await action();
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (!primaryFailed) throw error;
  }
  if (primaryFailed) throw primaryError;
}

describe("actual vector equivalence", () => {
  it("preserves both real wrapper surfaces, native query and parser controls", async () => {
    const matrix: Array<{
      request: { id: string; method: string; path: string; headers: typeof headers; body: string };
      wire: Awaited<ReturnType<typeof captureRawHttp>>;
      entries: ReturnType<Journal["getAll"]>;
      metricsBefore: string;
      metricsAfter: string;
      stateBefore: ReturnType<VectorMock["health"]>;
      stateAfter: ReturnType<VectorMock["health"]>;
    }> = [];
    for (const surface of ["mounted", "standalone"] as const) {
      const vector = seededVector();
      const journal = new Journal();
      const registry = createMetricsRegistry();
      const llm = surface === "mounted" ? new LLMock({ host: "127.0.0.1", port: 0 }) : null;
      llm?.mount("/vector", vector);
      const url = llm ? await llm.start() : await vector.start();
      vector.setJournal(journal);
      vector.setRegistry(registry);
      const path = surface === "mounted" ? "/vector/query" : "/query";
      await withCleanup(
        async () => {
          for (const request of requests) {
            const id = `${surface}-${request.id}`;
            const before = journal.getAll().length;
            const metricsBefore = registry.serialize();
            const stateBefore = vector.health();
            const wire = await captureRawHttp(url, rawRequest(path, request.body));
            const entries = journal.getAll().slice(before);
            const metricsAfter = registry.serialize();
            const stateAfter = vector.health();
            expect(wire.status, id).toBe(request.status);
            expect(wire.headers["content-type"], id).toBe("application/json");
            expect(entries, id).toHaveLength(1);
            expect(entries[0], id).toMatchObject({
              method: "POST",
              path,
              headers: { ...headers, "content-length": String(Buffer.byteLength(request.body)) },
              body: null,
              service: "vector",
              response: { status: request.status, fixture: null },
            });
            expect(entries[0], id).not.toHaveProperty("source");
            expect(vector.getRequests()).toEqual(journal.getAll());
            expect(stateBefore).toEqual({ status: "ok", collections: 1 });
            expect(stateAfter).toEqual(stateBefore);
            if (request.id.startsWith("non-object")) {
              expect(wire.body, id).toBe(
                '{"error":{"message":"Request body must be a JSON object","type":"invalid_request_error"}}',
              );
              expect(metricsAfter).toBe(metricsBefore);
            } else if (request.id === "malformed-json") {
              expect(JSON.parse(wire.body ?? ""), id).toEqual({
                error: expect.stringMatching(/^Malformed JSON body:/),
              });
              expect(metricsAfter).toBe(metricsBefore);
            } else {
              const native = JSON.parse(wire.body ?? "");
              expect(native, id).toEqual({ matches: [{ id: "v1", score: 1 }] });
              expect(native, id).not.toHaveProperty("error");
            }
            console.log(JSON.stringify({ case: id, status: wire.status, body: wire.body }));
            matrix.push({
              request: { id, method: "POST", path, headers, body: request.body },
              wire,
              entries,
              metricsBefore,
              metricsAfter,
              stateBefore,
              stateAfter,
            });
          }
        },
        async () => {
          if (llm) await llm.stop();
          else await vector.stop();
        },
      );
    }
    expectGolden("response-vector", "equivalence-matrix", matrix);
  });
});

describe("vector cleanup failures", () => {
  it.each([
    ["mounted", true],
    ["mounted", false],
    ["standalone", true],
    ["standalone", false],
  ] as const)(
    "%s preserves primary=%s and awaits failing teardown",
    async (surface, failPrimary) => {
      const vector = seededVector();
      const llm = surface === "mounted" ? new LLMock({ host: "127.0.0.1", port: 0 }) : null;
      llm?.mount("/vector", vector);
      const url = llm ? await llm.start() : await vector.start();
      const path = surface === "mounted" ? "/vector/query" : "/query";
      const primary = new Error("a14 primary repro failure");
      const cleanup = new Error("a14 cleanup repro failure");
      let stopped = false;
      await expect(
        withCleanup(
          async () => {
            const wire = await captureRawHttp(url, rawRequest(path, requests[0].body));
            expect(wire.status).toBe(400);
            expect(wire.body).toBe(
              '{"error":{"message":"Request body must be a JSON object","type":"invalid_request_error"}}',
            );
            console.log(
              JSON.stringify({
                case: `${surface}-cleanup-${failPrimary ? "dual" : "only"}`,
                status: wire.status,
                body: wire.body,
              }),
            );
            if (failPrimary) throw primary;
          },
          async () => {
            if (llm) await llm.stop();
            else await vector.stop();
            stopped = true;
            throw cleanup;
          },
        ),
      ).rejects.toBe(failPrimary ? primary : cleanup);
      expect(stopped).toBe(true);
    },
  );
});

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    nodes.push(child, ...descendants(child));
  });
  return nodes;
}

describe("vector source ownership", () => {
  it.each(["handleRequest", "start"])(
    "%s serializes the actual shared service-validation envelope exactly once",
    (name) => {
      const sourcePath = join(sourceRoot, "vector-mock.ts");
      const ownerPath = join(sourceRoot, "response/errors.ts");
      const program = ts.createProgram([sourcePath, ownerPath], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      });
      const source = program.getSourceFile(sourcePath);
      const owner = program.getSourceFile(ownerPath);
      expect(source).toBeDefined();
      expect(owner).toBeDefined();
      if (!source || !owner) throw new Error("Missing actual source/owner");
      const checker = program.getTypeChecker();
      const ownerModule = checker.getSymbolAtLocation(owner);
      expect(ownerModule).toBeDefined();
      if (!ownerModule) throw new Error("Missing actual owner module");
      const shared = checker
        .getExportsOfModule(ownerModule)
        .find((symbol) => symbol.name === "buildOpenAIError");
      expect(shared).toBeDefined();
      const vectorClass = source.statements.find(
        (node): node is ts.ClassDeclaration =>
          ts.isClassDeclaration(node) && node.name?.text === "VectorMock",
      );
      expect(vectorClass).toBeDefined();
      if (!vectorClass) throw new Error("Missing actual VectorMock class");
      const method = vectorClass.members.find(
        (node): node is ts.MethodDeclaration =>
          ts.isMethodDeclaration(node) && node.name.getText(source) === name,
      );
      expect(method?.body).toBeDefined();
      if (!method?.body) throw new Error(`Missing actual ${name} body`);
      const guards = descendants(method.body).filter(
        (node): node is ts.IfStatement =>
          ts.isIfStatement(node) &&
          node.expression.getText(source).includes("!isJsonObject(parsed)"),
      );
      expect(guards).toHaveLength(1);
      const guard = guards[0];
      expect(guard.expression.getText(source)).toBe(
        name === "handleRequest"
          ? "!isJsonObject(parsed)"
          : 'req.method !== "GET" && !isJsonObject(parsed)',
      );
      const writers = descendants(guard.thenStatement).filter(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) && node.expression.getText(source) === "res.end",
      );
      expect(writers).toHaveLength(1);
      expect(writers[0].arguments).toHaveLength(1);
      const serialized = writers[0].arguments[0];
      expect(ts.isCallExpression(serialized)).toBe(true);
      if (!ts.isCallExpression(serialized)) throw new Error("Missing outgoing serialization");
      expect(serialized.expression.getText(source)).toBe("JSON.stringify");
      expect(serialized.arguments).toHaveLength(1);
      const body = serialized.arguments[0];
      expect(ts.isCallExpression(body), "qualified assembly must call shared owner").toBe(true);
      if (!ts.isCallExpression(body)) return;
      expect(ts.isIdentifier(body.expression)).toBe(true);
      const imported = checker.getSymbolAtLocation(body.expression);
      expect(imported?.flags && imported.flags & ts.SymbolFlags.Alias).toBeTruthy();
      if (!imported || !(imported.flags & ts.SymbolFlags.Alias))
        throw new Error("Missing owner alias");
      expect(checker.getAliasedSymbol(imported)).toBe(shared);
      expect(body.arguments).toHaveLength(2);
      expect(body.arguments[0].getText(source)).toBe('"service-validation"');
      const details = body.arguments[1];
      expect(ts.isObjectLiteralExpression(details)).toBe(true);
      if (!ts.isObjectLiteralExpression(details)) throw new Error("Missing exact owner details");
      expect(details.properties).toHaveLength(1);
      const message = details.properties[0];
      expect(ts.isPropertyAssignment(message)).toBe(true);
      if (!ts.isPropertyAssignment(message)) throw new Error("Missing exact message field");
      expect(message.name.getText(source)).toBe("message");
      expect(message.initializer.getText(source)).toBe('"Request body must be a JSON object"');
    },
  );
});
