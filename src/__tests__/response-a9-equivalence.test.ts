import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { freemem, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenAIError, renderError, type ErrorDetails } from "../response/errors.js";
import { PROXY_BUFFER_HARD_CEILING } from "../recorder.js";
import type { Fixture, MockServerOptions } from "../types.js";
import {
  captureHttp,
  expectGolden,
  startGoldenServer,
  startStubUpstream,
  type GoldenServer,
  type CapturedExchange,
} from "./golden/harness.js";

const closes: Array<() => Promise<void>> = [];
const directories: string[] = [];
const request = { model: "openai/gpt-4o", messages: [{ role: "user", content: "a9" }] };
const headers = { "content-type": "application/json", "x-request-id": "req_a9_fixed" };
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of closes.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  if (failures.length) throw failures[0];
});

async function server(fixtures: Fixture[] = [], options: Partial<MockServerOptions> = {}) {
  const result = await startGoldenServer(fixtures, options);
  closes.push(result.close);
  return result;
}

function journal(server: GoldenServer) {
  return server.instance.journal.getAll().map((entry) => ({
    method: entry.method,
    path: entry.path,
    body: entry.body,
    requestId: entry.headers["x-request-id"],
    response: {
      status: entry.response.status,
      source: entry.response.source,
      strictOverride: entry.response.strictOverride,
      fixtureMatched: entry.response.fixture !== null,
    },
  }));
}

async function send(server: GoldenServer, path: string, body: unknown, extraHeaders = {}) {
  return captureHttp(`${server.url}${path}`, {
    method: "POST",
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify(body),
    timeoutMs: 120_000,
  });
}

/** Fixed reusable chunk; never allocate or capture the whole upstream payload. */
async function ceilingPayload(res: ServerResponse) {
  expect(PROXY_BUFFER_HARD_CEILING).toBe(256 * 1024 * 1024);
  const freeBytes = freemem();
  console.log(
    JSON.stringify({
      case: "proxy-hard-ceiling-resource",
      freeBytes,
      ceiling: PROXY_BUFFER_HARD_CEILING,
    }),
  );
  if (freeBytes < 2 * 1024 ** 3)
    throw new Error("A9 hard-ceiling witness requires 2 GiB free memory");
  const chunk = Buffer.alloc(64 * 1024, 120);
  let remaining = PROXY_BUFFER_HARD_CEILING + chunk.length;
  res.writeHead(200, { "content-type": "application/json", "content-length": remaining });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => res.destroy(new Error("A9 ceiling payload exceeded 120 seconds")),
      120_000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      res.off("drain", pump);
      res.off("error", fail);
      res.off("close", closed);
      res.off("finish", finished);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => fail(new Error("A9 ceiling payload closed before finish"));
    const finished = () => {
      cleanup();
      resolve();
    };
    const pump = () => {
      while (remaining > 0) {
        remaining -= chunk.length;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    res.once("error", fail);
    res.once("close", closed);
    res.once("finish", finished);
    pump();
  });
}

interface MatrixCell {
  id: string;
  exchange: CapturedExchange;
  journal: ReturnType<typeof journal>;
  upstreamHits?: number;
  recordedFiles?: number;
}

async function matrix(): Promise<MatrixCell[]> {
  const cells: MatrixCell[] = [];
  const ordinary = await server();
  for (const [id, path, body] of [
    ["files-invalid", "/v1/files", { purpose: "unsupported", content: "x", filename: "a9.txt" }],
    ["batches-invalid", "/v1/batches", []],
    ["fine-tuning-invalid", "/v1/fine_tuning/jobs", []],
    ["vector-stores-invalid", "/v1/vector_stores", []],
  ] as const) {
    ordinary.instance.journal.clear();
    cells.push({ id, exchange: await send(ordinary, path, body), journal: journal(ordinary) });
  }
  const openRouter = await server([
    { match: { userMessage: "absent" }, response: { error: { message: "absent" }, status: 403 } },
    {
      match: { userMessage: "empty" },
      response: { error: { message: "empty", metadata: {} }, status: 429, retryAfter: 7 },
    },
    {
      match: { userMessage: "nested" },
      response: {
        error: {
          message: "nested",
          metadata: { nested: { value: null }, list: [1, null], omitted: undefined },
        },
        status: 503,
      },
    },
  ]);
  for (const name of ["absent", "empty", "nested"]) {
    openRouter.instance.journal.clear();
    cells.push({
      id: `openrouter-${name}`,
      exchange: await send(openRouter, "/api/v1/chat/completions", {
        ...request,
        messages: [{ role: "user", content: name }],
      }),
      journal: journal(openRouter),
    });
  }
  openRouter.instance.journal.clear();
  cells.push({
    id: "openrouter-validation",
    exchange: await send(openRouter, "/api/v1/chat/completions", []),
    journal: journal(openRouter),
  });
  openRouter.instance.journal.clear();
  cells.push({
    id: "openrouter-no-match",
    exchange: await send(openRouter, "/api/v1/chat/completions", request),
    journal: journal(openRouter),
  });
  const strict = await server([], { strict: true });
  cells.push({
    id: "openrouter-strict",
    exchange: await send(strict, "/api/v1/chat/completions", request),
    journal: journal(strict),
  });
  const native = await server([], { policy: { requiredHeaders: "enforce" } });
  cells.push({
    id: "request-id-control",
    exchange: await send(native, "/v1/messages", {
      model: "claude-test",
      max_tokens: 8,
      messages: request.messages,
    }),
    journal: journal(native),
  });
  const legacy = await server();
  cells.push({
    id: "legacy-request-id-control",
    exchange: await send(legacy, "/v1/messages", {
      model: "claude-test",
      max_tokens: 8,
      messages: request.messages,
    }),
    journal: journal(legacy),
  });

  for (const id of [
    "proxy-invalid-url",
    "proxy-missing-credential",
    "proxy-before-headers",
    "proxy-hard-ceiling",
    "proxy-success",
    "proxy-raw-error",
  ]) {
    const fixturePath = mkdtempSync(join(tmpdir(), "aimock-a9-"));
    directories.push(fixturePath);
    const upstream = await startStubUpstream((_req, res) => {
      if (id === "proxy-before-headers") {
        res.destroy();
        return;
      }
      if (id === "proxy-hard-ceiling") return ceilingPayload(res);
      if (id === "proxy-raw-error") {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "11",
          "x-a9-raw": "preserved",
        });
        res.end(
          '{"error":{"message":"raw","metadata":{"native":null}},"arbitrary":[1,null,{"code":0}]}',
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        '{"id":"a9-fixed","object":"chat.completion","created":1700000000,"model":"openai/gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
      );
    });
    closes.push(upstream.close);
    const serving = await server([], {
      record: {
        providers: { openai: id === "proxy-invalid-url" ? "not-a-url" : upstream.url },
        fixturePath,
      },
      ...(id === "proxy-missing-credential" ? { auth: { apiKeys: ["a9-test-key"] } } : {}),
    });
    const exchange = await send(
      serving,
      "/v1/chat/completions",
      request,
      id === "proxy-missing-credential" ? { authorization: "Bearer a9-test-key" } : {},
    );
    cells.push({
      id,
      exchange,
      journal: journal(serving),
      upstreamHits: upstream.requests.length,
      recordedFiles: readdirSync(fixturePath).filter((name) => name.endsWith(".json")).length,
    });
  }
  for (const cell of cells)
    console.log(
      JSON.stringify({
        case: cell.id,
        ...cell.exchange,
        upstreamHits: cell.upstreamHits,
        recordedFiles: cell.recordedFiles,
      }),
    );
  return cells;
}

describe("A9 actual equivalence", () => {
  it("matches the immutable real HTTP/service/OpenRouter/proxy matrix", async () => {
    expectGolden("response-a9", "equivalence-matrix", await matrix());
  }, 150_000);
});

describe("A9 owner contracts", () => {
  it("returns the required typed service validation whole envelope", () => {
    const body: { error: { message: string; type: string } } = buildOpenAIError(
      "service-validation",
      { message: "Service" },
    );
    expect(JSON.stringify(body)).toBe(
      '{"error":{"message":"Service","type":"invalid_request_error"}}',
    );
  });
  it.each([
    { code: 0, body: '{"error":{"code":0,"message":"OR"}}' },
    { code: 503, body: '{"error":{"code":503,"message":"OR"}}' },
    { code: 429, metadata: {}, body: '{"error":{"code":429,"message":"OR","metadata":{}}}' },
    {
      code: 403,
      metadata: { nested: { value: null }, list: [1, null], omitted: undefined },
      body: '{"error":{"code":403,"message":"OR","metadata":{"nested":{"value":null},"list":[1,null]}}}',
    },
  ])("preserves numeric-first OpenRouter envelope $code", ({ code, metadata, body }) => {
    expect(
      JSON.stringify(buildOpenAIError("openrouter-error", { code, message: "OR", metadata })),
    ).toBe(body);
  });
  it.each([
    [{ message: "Inner" }, '{"message":"Inner"}'],
    [{ message: "Inner", type: null, code: null }, '{"message":"Inner","type":null,"code":null}'],
    [{ message: "Inner", type: "", code: "" }, '{"message":"Inner","type":"","code":""}'],
    [
      { message: "Inner", type: "native", code: "code", param: "ignored" },
      '{"message":"Inner","type":"native","code":"code"}',
    ],
    [{ message: "Inner", includeParam: true }, '{"message":"Inner","param":null}'],
    [
      { message: "Inner", includeParam: true, param: "", code: null },
      '{"message":"Inner","param":"","code":null}',
    ],
  ] satisfies Array<[ErrorDetails, string]>)("preserves old inner form %#", (details, body) => {
    expect(JSON.stringify(buildOpenAIError(details))).toBe(body);
  });
  it("preserves opt-in request-ID and default transport rendering", () => {
    expect(
      renderError("messages", "thinking", { message: "M", requestId: "req_a9_fixed" }).body,
    ).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"M"},"request_id":"req_a9_fixed"}',
    );
    expect(renderError("messages", "thinking", { message: "M" }).body).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"M"}}',
    );
    expect(
      renderError("openai", "transport-failure", { message: "Proxy", type: "proxy_error" }).body,
    ).toBe('{"error":{"message":"Proxy","type":"proxy_error"}}');
  });
});

describe("A9 owner binding", () => {
  it("retains one implementation shared by the typed contracts and render path", () => {
    const owner = ts.createSourceFile(
      "errors.ts",
      readFileSync(join(sourceRoot, "response/errors.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const builders = owner.statements
      .filter(ts.isFunctionDeclaration)
      .filter((node) => node.name?.text === "buildOpenAIError" && node.body);
    expect(builders).toHaveLength(1);
    const render = owner.statements
      .filter(ts.isFunctionDeclaration)
      .find((node) => node.name?.text === "renderError");
    const calls: string[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
        calls.push(node.expression.text);
      ts.forEachChild(node, walk);
    };
    if (!render) throw new Error("Expected renderError declaration");
    walk(render);
    expect(calls).toContain("buildOpenAIError");
    const suite = ts.createSourceFile(
      "response-a9-equivalence.test.ts",
      readFileSync(fileURLToPath(import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      suite.statements
        .filter(ts.isImportDeclaration)
        .some(
          (node) =>
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === "../response/errors.js" &&
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.some(
              (element) => element.name.text === "buildOpenAIError",
            ),
        ),
    ).toBe(true);
  });
});

function consumerSource(relative: string) {
  return ts.createSourceFile(
    relative,
    readFileSync(join(sourceRoot, relative), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function ownerImport(source: ts.SourceFile, name: string) {
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "./response/errors.js"
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const imported = bindings.elements.find(
      (element) => (element.propertyName ?? element.name).text === name,
    );
    if (imported) return imported.name.text;
  }
  return undefined;
}

function expectOwnerCall(
  source: ts.SourceFile,
  expression: ts.Expression | undefined,
  name: string,
  purpose: string,
) {
  expect(expression && ts.isCallExpression(expression)).toBe(true);
  if (!expression || !ts.isCallExpression(expression)) throw new Error("Expected owner call");
  const bound = ownerImport(source, name);
  expect(bound).toBeDefined();
  expect(ts.isIdentifier(expression.expression) && expression.expression.text).toBe(bound);
  const purposeArgument = expression.arguments[name === "renderError" ? 1 : 0];
  expect(purposeArgument && ts.isStringLiteral(purposeArgument) && purposeArgument.text).toBe(
    purpose,
  );
  return expression;
}

function helperReturn(source: ts.SourceFile, name: string) {
  const helper = source.statements
    .filter(ts.isFunctionDeclaration)
    .find((node) => node.name?.text === name);
  if (!helper?.body) throw new Error(`Missing consumer helper ${name}`);
  return helper.body.statements.find(ts.isReturnStatement)?.expression;
}

describe("A9 consumer ownership", () => {
  it.each([
    ["files.ts", "invalidRequest"],
    ["batches.ts", "invalid"],
    ["fine-tuning.ts", "invalid"],
    ["vector-stores.ts", "invalid"],
  ])("delegates %s %s directly to the typed service owner", (relative, helper) => {
    const source = consumerSource(relative);
    expectOwnerCall(source, helperReturn(source, helper), "buildOpenAIError", "service-validation");
  });

  it("delegates the OpenRouter serializer directly to the typed numeric/metadata owner", () => {
    const source = consumerSource("openrouter-chat.ts");
    const serialized = helperReturn(source, "serializeOpenRouterError");
    expect(serialized && ts.isCallExpression(serialized)).toBe(true);
    if (!serialized || !ts.isCallExpression(serialized))
      throw new Error("Missing OpenRouter serializer call");
    expect(serialized.expression.getText(source)).toBe("JSON.stringify");
    expectOwnerCall(source, serialized.arguments[0], "buildOpenAIError", "openrouter-error");
  });

  it.each([
    "Invalid upstream URL: ",
    "No configured provider credential",
    "Proxy to upstream failed: ",
    "Upstream response exceeds ",
  ])("delegates only the recorder-local %s body to transport rendering", (prefix) => {
    const source = consumerSource("recorder.ts");
    const proxy = source.statements
      .filter(ts.isFunctionDeclaration)
      .find((node) => node.name?.text === "proxyAndRecord");
    if (!proxy?.body) throw new Error("Missing proxyAndRecord body");
    const calls: ts.CallExpression[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const details = node.arguments[2];
        if (details && ts.isObjectLiteralExpression(details)) {
          const message = details.properties
            .filter(ts.isPropertyAssignment)
            .find((property) => property.name.getText(source) === "message")?.initializer;
          if (
            message &&
            ((ts.isTemplateExpression(message) && message.head.text.startsWith(prefix)) ||
              (ts.isStringLiteral(message) && message.text.startsWith(prefix)))
          )
            calls.push(node);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(proxy.body);
    expect(calls).toHaveLength(1);
    const call = expectOwnerCall(source, calls[0], "renderError", "transport-failure");
    expect(call.arguments[0]?.getText(source)).toBe('"openai"');
    expect(call.parent && ts.isPropertyAccessExpression(call.parent) && call.parent.name.text).toBe(
      "body",
    );
  });
});
