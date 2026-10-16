import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ChaosConfig, Fixture } from "../types.js";
import { captureHttp, captureRawHttp, expectGolden, startGoldenServer } from "./golden/harness.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const chaosPath = resolve(root, "src/chaos.ts");
const ownerPath = resolve(root, "src/response/errors.ts");
const writerPath = resolve(root, "src/sse-writer.ts");
const snapshotPath = resolve(
  root,
  "src/__tests__/golden/__snapshots__/response-a13/equivalence-matrix.json",
);
const baselineChaosHash = "338bce9f13db2229e82afb0edf9e7c8330800f1f6a62a8978e3c9f6b5cf96de7";
const request = { model: "gpt-4", messages: [{ role: "user", content: "a13 baseline" }] };
const requestBody = JSON.stringify(request);
const rawRequest = [
  "POST /v1/chat/completions HTTP/1.1",
  "Host: a13.local",
  "Content-Type: application/json",
  `Content-Length: ${Buffer.byteLength(requestBody)}`,
  "Connection: close",
  "X-Request-Id: a13_trace",
  "X-Test-Id: a13",
  "",
  requestBody,
].join("\r\n");
const cases: Array<{ id: string; action: "drop" | "rateLimit" | null; chaos: ChaosConfig }> = [
  { id: "chaos-drop", action: "drop", chaos: { dropRate: 1 } },
  { id: "chaos-rate-limit", action: "rateLimit", chaos: { rateLimitRate: 1 } },
  { id: "chaos-off-native-success", action: null, chaos: { dropRate: 0, rateLimitRate: 0 } },
];
const bodies = {
  drop: '{"error":{"message":"Chaos: request dropped","type":"server_error","code":"chaos_drop"}}',
  rateLimit:
    '{"error":{"message":"Chaos: rate limit exceeded","type":"rate_limit_error","code":"chaos_ratelimit"}}',
};

async function captureMatrix() {
  if (process.env.GOLDEN_WRITE === "1") {
    if (existsSync(snapshotPath)) throw new Error("A13 matrix is frozen; recapture is forbidden");
    const hash = createHash("sha256").update(readFileSync(chaosPath)).digest("hex");
    if (hash !== baselineChaosHash) throw new Error("A13 capture requires untouched production");
  }
  const rows = [];
  for (const cell of cases) {
    const fixture: Fixture = {
      match: { userMessage: "a13 baseline" },
      response: { content: "a13 native success" },
      chaos: cell.chaos,
    };
    const server = await startGoldenServer([fixture], { metrics: true });
    try {
      const exchange = await captureRawHttp(server.url, rawRequest);
      const journal = server.instance.journal.getAll().map((entry) => ({
        method: entry.method,
        path: entry.path,
        headers: Object.fromEntries(
          Object.entries(entry.headers).sort(([a], [b]) => a.localeCompare(b)),
        ),
        body: entry.body,
        response: entry.response,
      }));
      const metrics = await captureHttp(`${server.url}/metrics`);
      expect(metrics.status).toBe(200);
      const chaosCounters = (metrics.body ?? "")
        .split("\n")
        .filter((line) => line.startsWith("aimock_chaos_triggered_total{"))
        .sort();
      rows.push({ ...cell, request, exchange, journal, chaosCounters });
    } finally {
      await server.close();
    }
  }
  return rows;
}

let captured: ReturnType<typeof captureMatrix> | undefined;
const matrix = () => (captured ??= captureMatrix());

it("actual journal Host witness", async () => {
  const fixture: Fixture = {
    match: { userMessage: "a13 baseline" },
    response: { content: "a13 native success" },
    chaos: { dropRate: 0, rateLimitRate: 0 },
  };
  const server = await startGoldenServer([fixture], { metrics: true });
  try {
    const exchange = await captureRawHttp(server.url, rawRequest);
    expect(exchange.status).toBe(200);
    const journal = server.instance.journal.getAll();
    expect(journal).toHaveLength(1);
    expect(journal[0].headers.host).toBe("a13.local");
  } finally {
    await server.close();
  }
});

function verifyActual(rows: Awaited<ReturnType<typeof captureMatrix>>) {
  expect(rows.map((row) => row.id)).toEqual(cases.map((cell) => cell.id));
  for (const row of rows) {
    expect(row.journal).toHaveLength(1);
    expect(row.journal[0]).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { host: "a13.local", "x-request-id": "a13_trace", "x-test-id": "a13" },
    });
    expect(row.journal[0].response.fixture).toMatchObject({
      match: { userMessage: "a13 baseline" },
      response: { content: "a13 native success" },
      chaos: row.chaos,
    });
    if (row.action) {
      expect(row.journal[0].response.source).toBe("fixture");
      const status = row.action === "drop" ? 500 : 429;
      expect(row.exchange.status).toBe(status);
      expect(row.exchange.body).toBe(bodies[row.action]);
      expect(row.journal[0].response).toMatchObject({ status, chaosAction: row.action });
      expect(row.chaosCounters).toEqual([
        `aimock_chaos_triggered_total{action="${row.action}",source="fixture"} 1`,
      ]);
      if (row.action === "rateLimit") {
        expect(row.exchange.headers["retry-after"]).toMatch(/^\d+$/);
        expect(row.exchange.headers).toHaveProperty("x-ratelimit-limit-requests");
        expect(row.exchange.headers).toHaveProperty("x-ratelimit-remaining-requests");
      } else expect(row.exchange.headers).not.toHaveProperty("retry-after");
    } else {
      expect(Object.hasOwn(row.journal[0].response, "source")).toBe(false);
      expect(row.exchange.status).toBe(200);
      const body: { choices: Array<{ message: { content: string }; finish_reason: string }> } =
        JSON.parse(row.exchange.body ?? "");
      expect(body.choices).toMatchObject([
        { message: { content: "a13 native success" }, finish_reason: "stop" },
      ]);
      expect(row.journal[0].response).not.toHaveProperty("chaosAction");
      expect(row.chaosCounters).toEqual([]);
    }
  }
  expectGolden("response-a13", "equivalence-matrix", rows);
}

describe("actual A13 equivalence", () => {
  it("preserves deterministic actions, native success, headers, journals and metrics", async () => {
    verifyActual(await matrix());
  });
});

let compiler: ts.Program | undefined;
function ownershipProgram() {
  return (compiler ??= ts.createProgram([chaosPath, ownerPath, writerPath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  }));
}

function nodesWhere<T extends ts.Node>(
  parent: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const results: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) results.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parent);
  return results;
}

describe("A13 source ownership", () => {
  it.each(["drop", "rateLimit"] as const)(
    "%s real exercised body delegates to the exact imported shared owner",
    async (action) => {
      verifyActual(await matrix());
      const program = ownershipProgram();
      const checker = program.getTypeChecker();
      const source = program.getSourceFile(chaosPath);
      const owner = program.getSourceFile(ownerPath);
      const writer = program.getSourceFile(writerPath);
      if (!source || !owner || !writer) throw new Error("Required A13 source input missing");
      const target = nodesWhere(source, ts.isFunctionDeclaration).find(
        (node) => node.name?.text === "applyChaosAction",
      );
      if (!target) throw new Error("Qualified applyChaosAction declaration missing");
      const clause = nodesWhere(target, ts.isCaseClause).find(
        (node) => ts.isStringLiteral(node.expression) && node.expression.text === action,
      );
      if (!clause) throw new Error(`Qualified ${action} branch missing`);
      const resolveSymbol = (node: ts.Node) => {
        const symbol = checker.getSymbolAtLocation(node);
        return symbol && symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      };
      const writerDeclaration = nodesWhere(writer, ts.isFunctionDeclaration).find(
        (node) => node.name?.text === "writeErrorResponse",
      );
      const ownerDeclaration = nodesWhere(owner, ts.isFunctionDeclaration).find(
        (node) => node.name?.text === "renderError",
      );
      if (!writerDeclaration?.name || !ownerDeclaration?.name)
        throw new Error("Accepted writer/shared owner declaration missing");
      const writerSymbol = resolveSymbol(writerDeclaration.name);
      const ownerSymbol = resolveSymbol(ownerDeclaration.name);
      if (!writerSymbol || !ownerSymbol) throw new Error("Shared declaration symbol unresolved");
      const writes = nodesWhere(clause, ts.isCallExpression).filter(
        (node) => resolveSymbol(node.expression) === writerSymbol,
      );
      expect(writes.length).toBe(1);
      const write = writes[0];
      expect(write.arguments[1].getText(source)).toBe(action === "drop" ? "500" : "429");
      const body = write.arguments[2];
      expect(ts.isPropertyAccessExpression(body), `${action}: local body assembly remains`).toBe(
        true,
      );
      if (!ts.isPropertyAccessExpression(body) || body.name.text !== "body")
        throw new Error(`${action}: outgoing body must select the shared serialized body`);
      expect(ts.isCallExpression(body.expression)).toBe(true);
      if (!ts.isCallExpression(body.expression)) throw new Error("Shared owner call missing");
      const render = body.expression;
      expect(resolveSymbol(render.expression) === ownerSymbol).toBe(true);
      expect(render.arguments[0].getText(source)).toBe('"openai"');
      expect(render.arguments[1].getText(source)).toBe('"misbehavior"');
      const details = render.arguments[2];
      if (!ts.isObjectLiteralExpression(details)) throw new Error("Literal owner details missing");
      expect(details.properties.every(ts.isPropertyAssignment)).toBe(true);
      expect(
        details.properties.map((property) =>
          ts.isPropertyAssignment(property) ? property.name.getText(source) : "",
        ),
      ).toEqual(["message", "type", "code"]);
      const values = details.properties.map((property) =>
        ts.isPropertyAssignment(property) ? property.initializer.getText(source) : "",
      );
      expect(values).toEqual(
        action === "drop"
          ? ['"Chaos: request dropped"', '"server_error"', '"chaos_drop"']
          : ['"Chaos: rate limit exceeded"', '"rate_limit_error"', '"chaos_ratelimit"'],
      );
    },
  );
});
