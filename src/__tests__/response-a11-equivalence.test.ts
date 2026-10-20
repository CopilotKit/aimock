import * as http from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { falJobs, handleFalQueue } from "../fal-audio.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import type { Fixture, HandlerDefaults } from "../types.js";
import {
  captureRawHttp,
  expectGolden,
  startGoldenServer,
  startStubUpstream,
  type CapturedExchange,
  type GoldenServer,
} from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const qualified = [
  ["fal.ts", "proxyAndRecordFalQueueSubmit", "catch", "transport-failure"],
  ["fal.ts", "respondNotFound", "all", "route-failure"],
  ["fal-audio.ts", "handleFalQueue", "errorBody", "route-failure"],
  ["fal-audio.ts", "handleQueueStatus", "missingJob", "route-failure"],
  ["fal-audio.ts", "handleQueueResult", "missingJob", "route-failure"],
] as const;

function nodes(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(node: ts.Node): void {
    found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

describe("A11 exact common-body ownership", () => {
  it.each(qualified)(
    "%s %s delegates its qualified %s branch",
    (name, handler, branch, purpose) => {
      const path = join(sourceRoot, name);
      const program = ts.createProgram([path], { noResolve: true, noLib: true });
      const source = program.getSourceFile(path);
      if (!source) throw new Error(`Missing source: ${path}`);
      const checker = program.getTypeChecker();
      const symbols: ts.Symbol[] = [];
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        const owner = resolve(
          dirname(path),
          statement.moduleSpecifier.text.replace(/\.js$/, ".ts"),
        );
        if (owner !== join(sourceRoot, "response/errors.ts")) continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text !== "renderError") continue;
          const symbol = checker.getSymbolAtLocation(binding.name);
          if (symbol) symbols.push(symbol);
        }
      }
      const declaration = source.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === handler,
      );
      if (!declaration?.body) throw new Error(`Missing qualified function: ${handler}`);
      const candidates = nodes(declaration.body);
      const scope =
        branch === "all"
          ? declaration.body
          : candidates.find((node) => {
              if (branch === "catch") return ts.isCatchClause(node);
              if (branch === "errorBody")
                return ts.isVariableDeclaration(node) && node.name.getText(source) === "errorBody";
              return ts.isIfStatement(node) && node.expression.getText(source) === "!job";
            });
      if (!scope) throw new Error(`Missing qualified branch: ${handler}/${branch}`);
      const scoped = nodes(scope);
      const copied = scoped.filter((node) => {
        if (!ts.isObjectLiteralExpression(node)) return false;
        return node.properties.some((property) => {
          if (
            !ts.isPropertyAssignment(property) ||
            property.name.getText(source) !== "error" ||
            !ts.isObjectLiteralExpression(property.initializer)
          )
            return false;
          return property.initializer.properties.some(
            (field) =>
              ts.isPropertyAssignment(field) &&
              field.name.getText(source) === "type" &&
              ts.isStringLiteral(field.initializer) &&
              ["not_found", "proxy_error"].includes(field.initializer.text),
          );
        });
      });
      const delegates = scoped.filter((node): node is ts.CallExpression => {
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
        const symbol = checker.getSymbolAtLocation(node.expression);
        return symbols.some((owner) => owner === symbol);
      });
      console.log(
        JSON.stringify({
          file: name,
          handler,
          branch,
          copies: copied.map(
            (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          ),
          ownerCalls: delegates.length,
        }),
      );
      expect(
        symbols.length,
        "renderer import must bind to the shared errors owner",
      ).toBeGreaterThan(0);
      expect(
        copied.map((node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1),
        "qualified outgoing common assembly must be removed",
      ).toEqual([]);
      expect(delegates.length, "exact branch must call its import-bound owner once").toBe(1);
      expect(
        delegates[0].arguments.slice(0, 2).map((argument) => argument.getText(source)),
      ).toEqual(['"openai"', `"${purpose}"`]);
      expect(
        ts.isPropertyAccessExpression(delegates[0].parent) && delegates[0].parent.name.text,
      ).toBe("body");
      if (branch === "errorBody") {
        const writes = candidates.filter(
          (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && node.expression.getText(source) === "res.end",
        );
        expect(
          writes.some((write) => write.arguments[0]?.getText(source) === "errorBody"),
          "serialized unknown-endpoint body must not be stringified again",
        ).toBe(true);
      }
    },
  );
});

const caller = "a11-caller-trace";
const testId = "a11-job-controls";
const model = "fal-ai/a11-model";
const headers = { "x-request-id": caller, "x-test-id": testId };
const queueHeaders = { ...headers, "x-fal-target-host": "queue.fal.run" };
const prompt = "a11 positive job";
const audioFixture: Fixture = {
  match: { endpoint: "fal-audio", userMessage: prompt },
  response: { audio: "SGVsbG8=", format: "wav" },
};
const falFixture: Fixture = {
  match: { endpoint: "fal", userMessage: prompt },
  response: { json: { images: [{ url: "https://example.test/a11-image.png" }] } },
};

function entries(journal: Journal) {
  return journal.getAll().map((entry) => ({
    method: entry.method,
    path: entry.path,
    body: entry.body,
    response: entry.response,
  }));
}
function post(body: unknown, selectedHeaders = headers): RequestInit {
  return {
    method: "POST",
    headers: { ...selectedHeaders, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
function requestId(wire: CapturedExchange): string {
  // P0 keeps actual bytes under this non-enumerable symbol so golden
  // normalization does not lose cross-capture identity. Read it only for
  // chaining the actual submitted job, without changing the shared harness.
  const symbol = Object.getOwnPropertySymbols(wire).find((key) => key.description === "golden.raw");
  if (!symbol) throw new Error("Expected P0 actual raw exchange");
  const raw: unknown = Reflect.get(wire, symbol);
  if (!raw || typeof raw !== "object" || !("body" in raw) || typeof raw.body !== "string")
    throw new Error("Expected actual submitted response body");
  const body: unknown = JSON.parse(raw.body);
  if (
    !body ||
    typeof body !== "object" ||
    !("request_id" in body) ||
    typeof body.request_id !== "string"
  )
    throw new Error("Expected actual job request_id");
  return body.request_id;
}

async function capture(url: string, init: RequestInit): Promise<CapturedExchange> {
  const target = new URL(url);
  const body = init.body ?? "";
  if (typeof body !== "string") throw new Error("A11 requests require explicit string bodies");
  const outgoing = new Headers(init.headers);
  outgoing.set("host", "a11.local");
  outgoing.set("connection", "close");
  outgoing.set("accept-encoding", "identity");
  if (body) outgoing.set("content-length", String(Buffer.byteLength(body)));
  const lines = [
    `${init.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`,
    ...Array.from(outgoing, ([key, value]) => `${key}: ${value}`),
    "",
    body,
  ];
  return captureRawHttp(url, lines.join("\r\n"));
}
function expectError(wire: CapturedExchange, status: number, message: string, type: string): void {
  expect(wire.status).toBe(status);
  expect(wire.body).toBe(JSON.stringify({ error: { message, type } }));
}

interface Capture {
  id: string;
  wire: CapturedExchange;
  entries: ReturnType<typeof entries>;
  upstream?: { method: string; path: string; body: string; strict: string | string[] | null }[];
  fixtureFiles?: string[];
}

async function exchange(
  server: GoldenServer,
  id: string,
  path: string,
  init: RequestInit,
): Promise<Capture> {
  const before = server.instance.journal.getAll().length;
  const wire = await capture(server.url + path, init);
  const actual = server.instance.journal.getAll().slice(before);
  expect(actual[0]?.headers.host, `${id}: actual incoming Host`).toBe("a11.local");
  const captured = entries(server.instance.journal).slice(before);
  expect(captured, id).toHaveLength(1);
  expect(captured[0].path).toBe(path);
  expect(captured[0].response.status).toBe(wire.status);
  return { id, wire, entries: captured };
}

async function proxyFailure(): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), "aimock-a11-record-"));
  const upstream = await startStubUpstream((_req, res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("a11-controlled-submit-failure");
  });
  let server: GoldenServer | undefined;
  try {
    server = await startGoldenServer([], {
      record: { providers: { fal: upstream.url }, fixturePath: dir },
    });
    const capture = await exchange(
      server,
      "fal-submit-proxy-failure",
      `/fal/${model}`,
      post({ prompt: "a11 record failure" }, queueHeaders),
    );
    expectError(
      capture.wire,
      502,
      "Proxy to upstream failed: Submit 503: a11-controlled-submit-failure",
      "proxy_error",
    );
    expect(capture.entries[0].response.source).toBe("proxy");
    expect(capture.entries[0].response.fixture).toBeNull();
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].url).toBe(`/${model}`);
    expect(upstream.requests[0].method).toBe("POST");
    const fixtureFiles = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(fixtureFiles).toEqual([]);
    return {
      ...capture,
      upstream: upstream.requests.map((request) => ({
        method: request.method,
        path: request.url,
        body: request.body,
        strict: request.headers["x-aimock-strict"] ?? null,
      })),
      fixtureFiles,
    };
  } finally {
    try {
      await server?.close();
    } finally {
      try {
        await upstream.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

async function directUnknownEndpoint(): Promise<Capture[]> {
  const journal = new Journal();
  const defaults: HandlerDefaults = {
    latency: 0,
    chunkSize: 20,
    replaySpeed: 1,
    logger: new Logger("silent"),
    strict: false,
  };
  const failures: unknown[] = [];
  const pending: Promise<void>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", (error) => {
      failures.push(error);
      res.destroy();
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      pending.push(
        handleFalQueue(
          req,
          res,
          Buffer.concat(chunks).toString(),
          req.url ?? "/",
          [audioFixture],
          defaults,
          journal,
        ).catch((error: unknown) => {
          failures.push(error);
          res.destroy();
        }),
      );
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  let result: Capture[] | undefined;
  let primary: { error: unknown } | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    const url = `http://127.0.0.1:${address.port}`;
    const path = "/fal/a11-unknown-endpoint";
    const unknown = await capture(url + path, { headers });
    expect(journal.getAll()[0]?.headers.host, "direct actual incoming Host").toBe("a11.local");
    expectError(unknown, 404, "Unknown fal.ai endpoint", "not_found");
    expect(entries(journal)).toHaveLength(1);
    const first: Capture = {
      id: "fal-audio-unknown-endpoint",
      wire: unknown,
      entries: entries(journal),
    };
    const positive = await capture(`${url}/fal/run/${model}`, post({ prompt }));
    expect(positive.status).toBe(200);
    await Promise.all(pending);
    expect(failures).toEqual([]);
    result = [
      first,
      { id: "fal-audio-direct-positive", wire: positive, entries: entries(journal).slice(1) },
    ];
  } catch (error) {
    primary = { error };
  }
  const cleanup = await Promise.allSettled([
    new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
      server.closeAllConnections();
    }),
    Promise.all(pending),
  ]);
  for (const outcome of cleanup) if (outcome.status === "rejected") failures.push(outcome.reason);
  if (primary) throw primary.error;
  if (failures.length)
    throw new Error(`A11 direct handler failure: ${failures.map(String).join("; ")}`);
  if (!result) throw new Error("A11 direct handler produced no capture");
  return result;
}

describe("actual A11 equivalence", () => {
  it("preserves all five distinct branches and actual positive job/native lifecycle controls", async () => {
    const matrix: Capture[] = [await proxyFailure()];
    const server = await startGoldenServer([falFixture, audioFixture]);
    try {
      const absent = await exchange(
        server,
        "fal-request-not-found",
        `/fal/${model}/requests/a11-missing/status`,
        { headers: queueHeaders },
      );
      expectError(absent.wire, 404, "Request a11-missing not found", "not_found");
      matrix.push(absent);
      for (const [id, suffix] of [
        ["fal-audio-status-not-found", "/status"],
        ["fal-audio-result-not-found", ""],
      ] as const) {
        const capture = await exchange(server, id, `/fal/queue/requests/a11-missing${suffix}`, {
          headers,
        });
        expectError(capture.wire, 404, "Request a11-missing not found", "not_found");
        expect(capture.entries[0].body).toBeNull();
        expect(capture.entries[0].response.fixture).toBeNull();
        matrix.push(capture);
      }
      const falSubmit = await exchange(
        server,
        "fal-positive-submit",
        `/fal/${model}`,
        post({ prompt }, queueHeaders),
      );
      expect(falSubmit.wire.status).toBe(200);
      const falId = requestId(falSubmit.wire);
      matrix.push(falSubmit);
      for (const [id, suffix] of [
        ["fal-positive-status", "/status"],
        ["fal-positive-result", ""],
      ] as const) {
        const capture = await exchange(server, id, `/fal/${model}/requests/${falId}${suffix}`, {
          headers: queueHeaders,
        });
        expect(capture.wire.status).toBe(200);
        expect(capture.wire.body).toContain(
          suffix ? "COMPLETED" : "https://example.test/a11-image.png",
        );
        matrix.push(capture);
      }
      const audioSubmit = await exchange(
        server,
        "fal-audio-positive-submit",
        `/fal/queue/submit/${model}`,
        post({ prompt }),
      );
      expect(audioSubmit.wire.status).toBe(200);
      const audioId = requestId(audioSubmit.wire);
      matrix.push(audioSubmit);
      const audioStatus = await exchange(
        server,
        "fal-audio-positive-status",
        `/fal/queue/requests/${audioId}/status`,
        { headers },
      );
      expect(audioStatus.wire.status).toBe(200);
      expect(audioStatus.wire.body).toContain("COMPLETED");
      matrix.push(audioStatus);
      const key = `${testId}:${audioId}`;
      const completed = falJobs.get(key);
      if (!completed) throw new Error("Actual audio submission did not seed its job");
      // Native lifecycle control: keep the actual HTTP-created identity and put its
      // public job store into the existing pending state; no handler or API fake.
      falJobs.set(key, { ...completed, status: "IN_PROGRESS", result: null });
      try {
        const pendingResult = await exchange(
          server,
          "fal-audio-native-not-ready",
          `/fal/queue/requests/${audioId}`,
          { headers },
        );
        expectError(pendingResult.wire, 409, "Job result not yet available", "not_ready");
        matrix.push(pendingResult);
      } finally {
        falJobs.set(key, completed);
      }
      const audioResult = await exchange(
        server,
        "fal-audio-positive-result",
        `/fal/queue/requests/${audioId}`,
        { headers },
      );
      expect(audioResult.wire.status).toBe(200);
      expect(audioResult.wire.body).toContain("generated_audio.wav");
      matrix.push(audioResult);
    } finally {
      await server.close();
    }
    matrix.push(...(await directUnknownEndpoint()));
    console.log(
      JSON.stringify({
        surface: "actual-A11",
        cases: matrix.length,
        verifiedIncomingHost: "a11.local",
        ids: matrix.map((capture) => capture.id),
      }),
    );
    expectGolden("response-a11", "equivalence-matrix", matrix);
  });
});
