import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { Fixture } from "../types.js";
import {
  captureHttp,
  expectGolden,
  serializeGolden,
  startGoldenServer,
  startStubUpstream,
  type CapturedExchange,
  type GoldenServer,
} from "./golden/harness.js";

const consumers = [
  ["byteplus-video", 3, 7],
  ["grok-video", 3, 7],
  ["veo-video", 3, 7],
  ["video", 1, 2],
  ["openrouter-video", 5, 13],
  ["fal", 1, 2],
] as const;

describe("A5 compiler-bound source ownership", () => {
  it.each(consumers)(
    "%s uses named shared decisions at all inventoried reads",
    (name, decisions, overrides) => {
      const path = fileURLToPath(new URL(`../${name}.ts`, import.meta.url));
      const program = ts.createProgram([path], { noResolve: true, noLib: true });
      const source = program.getSourceFile(path)!;
      const checker = program.getTypeChecker();
      const policySymbols = new Map<string, ts.Symbol>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const binding of bindings.elements) {
          const exported = (binding.propertyName ?? binding.name).text;
          if (["resolveStrictMode", "strictOverrideField"].includes(exported)) {
            expect(
              statement.moduleSpecifier.text,
              `${exported} must belong to the policy owner`,
            ).toBe("./response/policy.js");
          }
          if (statement.moduleSpecifier.text === "./response/policy.js") {
            expect(statement.importClause?.isTypeOnly || binding.isTypeOnly).toBe(false);
            const symbol = checker.getSymbolAtLocation(binding.name);
            if (symbol) policySymbols.set(exported, symbol);
          }
        }
      }
      expect(policySymbols.has("resolveRequestDecisions"), "named decision owner import").toBe(
        true,
      );
      expect(policySymbols.has("strictOverrideField"), "journal owner import").toBe(true);
      const calls = new Map<string, ts.CallExpression[]>();
      function inspect(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          expect(node.expression.text, "legacy strict bit call must be removed").not.toBe(
            "resolveStrictMode",
          );
          const symbol = checker.getSymbolAtLocation(node.expression);
          for (const [exported, owner] of policySymbols) {
            if (symbol !== owner) continue;
            calls.set(exported, [...(calls.get(exported) ?? []), node]);
            expect(node.arguments.map((argument) => argument.getText(source))).toEqual([
              "defaults.strict",
              "req.headers",
            ]);
            if (exported === "resolveRequestDecisions") {
              expect(ts.isPropertyAccessExpression(node.parent)).toBe(true);
              if (ts.isPropertyAccessExpression(node.parent)) {
                expect(["fixtureMiss", "upstream"]).toContain(node.parent.name.text);
              }
            }
          }
        }
        ts.forEachChild(node, inspect);
      }
      inspect(source);
      expect(calls.get("resolveRequestDecisions")).toHaveLength(decisions);
      expect(calls.get("strictOverrideField")).toHaveLength(overrides);
    },
  );

  it.each(["video", "openrouter-video", "fal"])("%s delegates common error envelopes", (name) => {
    const path = fileURLToPath(new URL(`../${name}.ts`, import.meta.url));
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const source = program.getSourceFile(path)!;
    const checker = program.getTypeChecker();
    let renderer: ts.Symbol | undefined;
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "./response/errors.js"
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const binding = bindings.elements.find(
        (element) => (element.propertyName ?? element.name).text === "renderError",
      );
      if (binding && !binding.isTypeOnly && !statement.importClause?.isTypeOnly)
        renderer = checker.getSymbolAtLocation(binding.name);
    }
    expect(renderer, "shared common error renderer import").toBeDefined();
    let rendererCalls = 0;
    function inspect(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        if (renderer && checker.getSymbolAtLocation(node.expression) === renderer) rendererCalls++;
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText(source) === "JSON" &&
          node.expression.name.text === "stringify"
        ) {
          const outer = node.arguments[0];
          if (outer && ts.isObjectLiteralExpression(outer)) {
            const error = outer.properties.find(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) && property.name.getText(source) === "error",
            );
            if (error && ts.isObjectLiteralExpression(error.initializer)) {
              const keys = error.initializer.properties.map((property) =>
                property.name?.getText(source),
              );
              const type = error.initializer.properties.find(
                (property): property is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(property) && property.name.getText(source) === "type",
              );
              expect(
                Boolean(
                  keys.includes("message") &&
                  type &&
                  ts.isStringLiteral(type.initializer) &&
                  ["invalid_request_error", "server_error"].includes(type.initializer.text),
                ),
                "common errors must be rendered by their shared owner",
              ).toBe(false);
            }
          }
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    expect(rendererCalls).toBeGreaterThan(0);
  });
});

interface MediaRequest {
  model?: string;
  prompt?: string;
  content?: { type: string; text: string }[];
  instances?: { prompt: string }[];
}

interface MediaSubmitIdentity {
  id?: string;
  request_id?: string;
  name?: string;
}

interface MediaUpstreamReply extends MediaSubmitIdentity {
  status?: string;
  done?: boolean;
  progress?: number;
  usage?: { cost: number };
  images?: { url: string }[];
}

interface MediaCase {
  name: string;
  provider: string;
  path: string;
  body: MediaRequest;
  fixture: Fixture;
  poll?: (body: MediaSubmitIdentity) => string;
  submitReply: MediaUpstreamReply;
  pollReply: MediaUpstreamReply;
}

const cases: MediaCase[] = [
  {
    name: "byteplus",
    provider: "byteplus",
    path: "/api/v3/contents/generations/tasks",
    body: { model: "seedance-1-0-pro-fast-251015", content: [{ type: "text", text: "fixture" }] },
    fixture: {
      match: { endpoint: "video", userMessage: "fixture" },
      response: {
        json: {
          status: "succeeded",
          model: "seedance-1-0-pro-fast-251015",
          content: { video_url: "https://media.example/video.mp4" },
        },
      },
    },
    poll: (body) => `/api/v3/contents/generations/tasks/${body.id}`,
    submitReply: { id: "up-byteplus" },
    pollReply: { id: "up-byteplus", status: "running" },
  },
  {
    name: "grok",
    provider: "grok",
    path: "/v1/videos/generations",
    body: { model: "grok-imagine-video", prompt: "fixture" },
    fixture: {
      match: { endpoint: "video", userMessage: "fixture" },
      response: {
        video: { id: "fixture-video", status: "completed", url: "https://media.example/video.mp4" },
      },
    },
    poll: (body) => `/v1/videos/${body.request_id}`,
    submitReply: { request_id: "up-grok" },
    pollReply: { status: "pending", progress: 12 },
  },
  {
    name: "veo",
    provider: "veo",
    path: "/v1beta/models/veo-3.0-generate-001:predictLongRunning",
    body: { instances: [{ prompt: "fixture" }] },
    fixture: {
      match: { endpoint: "video", userMessage: "fixture" },
      response: {
        video: { id: "fixture-video", status: "completed", url: "https://media.example/video.mp4" },
      },
    },
    poll: (body) => `/v1beta/${body.name}`,
    submitReply: { name: "operations/up-veo" },
    pollReply: { name: "operations/up-veo", done: false },
  },
  {
    name: "openai",
    provider: "openai",
    path: "/v1/videos",
    body: { model: "sora-2", prompt: "fixture" },
    fixture: {
      match: { endpoint: "video", userMessage: "fixture" },
      response: {
        video: { id: "fixture-video", status: "completed", url: "https://media.example/video.mp4" },
      },
    },
    submitReply: { id: "up-openai", status: "queued" },
    pollReply: {},
  },
  {
    name: "openrouter",
    provider: "openrouter",
    path: "/api/v1/videos",
    body: { model: "bytedance/seedance-2.0", prompt: "fixture" },
    fixture: {
      match: { endpoint: "video", userMessage: "fixture" },
      response: {
        video: { id: "fixture-video", status: "completed", b64: "bWVkaWE=", cost: 0.25 },
      },
    },
    poll: (body) => `/api/v1/videos/${body.id}`,
    submitReply: { id: "up-openrouter", status: "queued" },
    pollReply: { id: "up-openrouter", status: "completed", usage: { cost: 0.25 } },
  },
  {
    name: "fal",
    provider: "fal",
    path: "/fal/fal-ai/flux/dev",
    body: { prompt: "fixture" },
    fixture: {
      match: { endpoint: "fal", userMessage: "fixture" },
      response: { json: { images: [{ url: "https://media.example/image.png" }] } },
    },
    submitReply: { images: [{ url: "https://media.example/upstream.png" }] },
    pollReply: {},
  },
];

const headers = {
  "content-type": "application/json",
  authorization: "Bearer media-test",
  "x-forwarded-host": "media.example",
  "x-forwarded-proto": "https",
  "x-fal-target-host": "fal.run",
};

const rawBodies = new WeakMap<CapturedExchange, string>();

async function request(
  server: GoldenServer,
  path: string,
  body?: unknown,
  strict?: string,
): Promise<CapturedExchange> {
  const url = `${server.url}${path}`;
  const fetch = globalThis.fetch;
  let rawBody = "";
  const observer = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await fetch(input, init);
    if (String(input) === url) rawBody = await response.clone().text();
    return response;
  });
  try {
    const exchange = await captureHttp(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, ...(strict === undefined ? {} : { "x-aimock-strict": strict }) },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    rawBodies.set(exchange, rawBody);
    return exchange;
  } finally {
    observer.mockRestore();
  }
}

function journal(server: GoldenServer) {
  return server.instance.journal
    .getAll()
    .map(({ method, path, body, response }) => ({ method, path, body, response }));
}

function submitIdentity(exchange: CapturedExchange) {
  const raw = rawBodies.get(exchange);
  if (raw === undefined) throw new Error("Actual response bytes are missing");
  const body: unknown = JSON.parse(raw);
  if (body === null || typeof body !== "object") throw new Error("Submit body must be an object");
  return {
    id: "id" in body && typeof body.id === "string" ? body.id : undefined,
    request_id:
      "request_id" in body && typeof body.request_id === "string" ? body.request_id : undefined,
    name: "name" in body && typeof body.name === "string" ? body.name : undefined,
  };
}

async function captureCase(testCase: MediaCase) {
  const upstream = await startStubUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    if (req.url.endsWith("/content?index=0")) res.end("media-bytes");
    else if (req.url.startsWith("/api/v1/videos/models"))
      res.end('{ "data": [{ "id": "upstream-video" }] }\n');
    else if (testCase.name === "openrouter")
      res.end(
        JSON.stringify(
          req.method === "POST"
            ? {
                ...testCase.submitReply,
                polling_url: `${upstream.url}/api/v1/videos/up-openrouter`,
              }
            : {
                ...testCase.pollReply,
                unsigned_urls: [`${upstream.url}/api/v1/videos/up-openrouter/content?index=0`],
              },
        ),
      );
    else res.end(JSON.stringify(req.method === "POST" ? testCase.submitReply : testCase.pollReply));
  });
  const fixturePath = mkdtempSync(join(tmpdir(), "aimock-a5-"));
  const results: unknown[] = [];
  try {
    for (const serverStrict of [false, true]) {
      const server = await startGoldenServer([], {
        strict: serverStrict,
        record: { providers: { [testCase.provider]: upstream.url }, fixturePath, proxyOnly: true },
      });
      try {
        const before = upstream.requests.length;
        const blocked = await request(server, testCase.path, testCase.body, "true");
        expect(blocked.status, `${testCase.name}: ${blocked.body}`).toBe(503);
        expect(upstream.requests).toHaveLength(before);
        const allowed = await request(server, testCase.path, testCase.body, "false");
        expect(allowed.status).toBe(testCase.name === "openrouter" ? 202 : 200);
        const body = submitIdentity(allowed);
        const polls: CapturedExchange[] = [];
        if (testCase.poll) {
          const pollPath = testCase.poll(body);
          const hits = upstream.requests.length;
          polls.push(await request(server, pollPath, undefined, "true"));
          expect(polls[0].status).toBe(503);
          expect(upstream.requests).toHaveLength(hits);
          polls.push(await request(server, pollPath, undefined, "false"));
          expect(polls[1].status).toBe(200);
          if (testCase.name === "openrouter") {
            const contentPath = `${pollPath}/content?index=0`;
            const contentHits = upstream.requests.length;
            polls.push(await request(server, contentPath, undefined, "true"));
            expect(polls[2].status).toBe(503);
            expect(upstream.requests).toHaveLength(contentHits);
            polls.push(await request(server, contentPath, undefined, "false"));
            expect(polls[3].status).toBe(200);
          }
        }
        if (testCase.name === "openrouter") {
          polls.push(await request(server, "/api/v1/videos/models", undefined, "true"));
          polls.push(await request(server, "/api/v1/videos/models", undefined, "false"));
        }
        results.push({ serverStrict, blocked, allowed, polls, journal: journal(server) });
      } finally {
        await server.close();
      }
    }
    for (const serverStrict of [false, true]) {
      const server = await startGoldenServer([testCase.fixture], { strict: serverStrict });
      try {
        const missBody =
          testCase.name === "byteplus"
            ? { ...testCase.body, content: [{ type: "text", text: "miss" }] }
            : testCase.name === "veo"
              ? { instances: [{ prompt: "miss" }] }
              : { ...testCase.body, prompt: "miss" };
        const miss = await request(server, testCase.path, missBody);
        expect(miss.status).toBe(serverStrict ? 503 : 404);
        const flipped = await request(
          server,
          testCase.path,
          missBody,
          serverStrict ? "false" : "true",
        );
        expect(flipped.status).toBe(serverStrict ? 404 : 503);
        const invalid = await request(server, testCase.path, "null");
        const commonErrors: CapturedExchange[] = [];
        if (["openai", "openrouter", "fal"].includes(testCase.name)) {
          commonErrors.push(await request(server, testCase.path, "{"));
          commonErrors.push(await request(server, testCase.path, {}));
          commonErrors.push(await request(server, testCase.path, { ...testCase.body, prompt: 42 }));
        }
        const fixture = await request(server, testCase.path, testCase.body, "true");
        expect(fixture.status).toBe(testCase.name === "openrouter" ? 202 : 200);
        const polls: CapturedExchange[] = [];
        if (testCase.poll) {
          const body = submitIdentity(fixture);
          polls.push(await request(server, testCase.poll(body), undefined, "true"));
          expect(polls[0].status).toBe(200);
        }
        results.push({
          serverStrict,
          miss,
          flipped,
          invalid,
          commonErrors,
          fixture,
          polls,
          journal: journal(server),
        });
      } finally {
        await server.close();
      }
    }
    expect(readdirSync(fixturePath)).toEqual([]);
    if (["openai", "openrouter", "fal"].includes(testCase.name)) {
      const server = await startGoldenServer([
        { ...testCase.fixture, response: { content: "wrong kind" } },
      ]);
      try {
        const wrongKind = await request(server, testCase.path, testCase.body);
        expect(wrongKind.status).toBe(500);
        results.push({ wrongKind, journal: journal(server) });
      } finally {
        await server.close();
      }
    }
    return {
      name: testCase.name,
      results,
      upstream: upstream.requests.map(({ method, url, body, headers: received }) => ({
        method,
        url,
        body,
        authorization: received.authorization,
        strict: received["x-aimock-strict"] ?? null,
      })),
      recordedFiles: readdirSync(fixturePath),
    };
  } finally {
    await upstream.close();
    rmSync(fixturePath, { recursive: true, force: true });
  }
}

it("A5 real HTTP matrix preserves strict overrides, fixture polling and local upstream bytes", async () => {
  const matrix: Awaited<ReturnType<typeof captureCase>>[] = [];
  for (const testCase of cases) matrix.push(await captureCase(testCase));
  const nativeJsonBodies = matrix.flatMap((capture, caseIndex) =>
    ["openai", "openrouter", "fal"].includes(capture.name)
      ? capture.results.flatMap((result, resultIndex) =>
          result !== null &&
          typeof result === "object" &&
          "commonErrors" in result &&
          Array.isArray(result.commonErrors) &&
          result.commonErrors.length > 0
            ? [[caseIndex, "results", resultIndex, "commonErrors", 0, "body"] as const]
            : [],
        )
      : [],
  );
  expectGolden("response-a5", "runtime-matrix", matrix, { nativeJsonBodies });
  const directory = process.env.A5_EVIDENCE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    const bytes = serializeGolden(matrix);
    const baseline = join(directory, "runtime-matrix.baseline.json");
    if (process.env.A5_CAPTURE_PHASE === "baseline") writeFileSync(baseline, bytes, { flag: "wx" });
    else {
      expect(bytes).toBe(readFileSync(baseline, "utf8"));
      writeFileSync(join(directory, "runtime-matrix.candidate.json"), bytes);
    }
  }
}, 30000);
