import * as http from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { handleEmbeddings } from "../embeddings.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import { createServer, type ServiceFixtures } from "../server.js";
import type { Fixture, FixtureResponse, HandlerDefaults, MockServerOptions } from "../types.js";
import {
  captureHttp,
  expectGolden,
  startGoldenServer,
  startStubUpstream,
  type CapturedExchange,
  type FrameMode,
  type GoldenServer,
} from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const consumers = [
  ["server.ts", 5, 2],
  ["embeddings.ts", 1, 1],
  ["gemini-embeddings.ts", 1, 1],
  ["moderation.ts", 1, 2],
  ["rerank.ts", 1, 2],
  ["search.ts", 1, 2],
] as const;

describe("A7 source ownership", () => {
  it.each(consumers)(
    "%s adopts its frozen policy and common-error sites",
    (name, gates, journals) => {
      const path = join(sourceRoot, name);
      const program = ts.createProgram([path], { noResolve: true, noLib: true });
      const loaded = program.getSourceFile(path);
      if (!loaded) throw new Error(`Source missing: ${path}`);
      const file = loaded;
      const checker = program.getTypeChecker();
      const owners = new Map<string, ts.Symbol>();
      const legacy = new Map<string, ts.Symbol>();
      const legacyImports: string[] = [];
      for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const binding of bindings.elements) {
          const exported = (binding.propertyName ?? binding.name).text;
          const owner = resolve(
            dirname(path),
            statement.moduleSpecifier.text.replace(/\.js$/, ".ts"),
          );
          if (["resolveStrictMode", "strictOverrideField"].includes(exported)) {
            if (owner !== join(sourceRoot, "response/policy.ts")) {
              legacyImports.push(exported);
              const symbol = checker.getSymbolAtLocation(binding.name);
              if (symbol) legacy.set(exported, symbol);
            }
          }
          if (
            owner === join(sourceRoot, "response/policy.ts") ||
            owner === join(sourceRoot, "response/errors.ts")
          ) {
            const symbol = checker.getSymbolAtLocation(binding.name);
            if (symbol) owners.set(exported, symbol);
          }
        }
      }
      const calls = new Map<string, number>();
      const legacyCalls = new Map<string, number[]>();
      const copiedErrors: number[] = [];
      function inspect(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const symbol = checker.getSymbolAtLocation(node.expression);
          for (const [exported, owner] of legacy) {
            if (symbol === owner) {
              legacyCalls.set(exported, [
                ...(legacyCalls.get(exported) ?? []),
                file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
              ]);
            }
          }
          for (const [exported, owner] of owners) {
            if (symbol !== owner) continue;
            calls.set(exported, (calls.get(exported) ?? 0) + 1);
            if (exported === "resolveRequestDecisions" || exported === "strictOverrideField") {
              expect(node.arguments.map((argument) => argument.getText(file))).toEqual([
                "defaults.strict",
                "req.headers",
              ]);
            }
            if (exported === "resolveRequestDecisions") {
              if (ts.isPropertyAccessExpression(node.parent)) {
                expect(["fixtureMiss", "upstream", "reasoningSuppression"]).toContain(
                  node.parent.name.text,
                );
              } else {
                expect(
                  ts.isVariableDeclaration(node.parent),
                  "the original single snapshot may serve multiple named decisions",
                ).toBe(true);
              }
            }
          }
        }
        if (ts.isObjectLiteralExpression(node)) {
          const error = node.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) && property.name.getText(file) === "error",
          );
          if (
            error &&
            ts.isPropertyAssignment(error) &&
            ts.isObjectLiteralExpression(error.initializer)
          ) {
            const keys = error.initializer.properties.map((property) =>
              property.name?.getText(file),
            );
            const type = error.initializer.properties.find(
              (property) => property.name?.getText(file) === "type",
            );
            const commonType =
              type &&
              ts.isPropertyAssignment(type) &&
              ((ts.isStringLiteral(type.initializer) &&
                ["invalid_request_error", "server_error", "proxy_error", "not_found"].includes(
                  type.initializer.text,
                )) ||
                (ts.isConditionalExpression(type.initializer) &&
                  type.initializer.getText(file).includes("invalid_request_error")));
            const commonOpenAI = keys[0] === "message" && keys[1] === "type" && commonType;
            const commonGemini =
              name === "gemini-embeddings.ts" &&
              keys.length === 3 &&
              keys.includes("message") &&
              keys.includes("code") &&
              keys.includes("status");
            if (commonOpenAI || commonGemini)
              copiedErrors.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
          }
        }
        ts.forEachChild(node, inspect);
      }
      inspect(file);
      console.log(
        JSON.stringify({
          file: name,
          expectedPolicySites: gates + journals,
          legacyCalls: Object.fromEntries(legacyCalls),
          commonErrorCopies: copiedErrors,
        }),
      );
      expect(legacyImports, `${name} old strict/journal imports must be removed`).toEqual([]);
      expect([...legacyCalls.values()].flat(), `${name} old strict/journal calls`).toEqual([]);
      expect(owners.has("resolveRequestDecisions"), `${name} named decisions owner`).toBe(true);
      expect(owners.has("strictOverrideField"), `${name} journal owner`).toBe(true);
      expect(owners.has("renderError"), `${name} common-error owner`).toBe(true);
      expect(calls.get("resolveRequestDecisions")).toBe(gates);
      expect(calls.get("strictOverrideField")).toBe(journals);
      expect(calls.get("renderError")).toBeGreaterThan(0);
      expect(copiedErrors, `${name} remaining shared envelope copies`).toEqual([]);
    },
  );
});

const prompt = "a7 request";
const chatBody = { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] };
const routes = [
  { id: "chat", path: "/v1/chat/completions", body: chatBody, permissive: 404 },
  {
    id: "embedding",
    path: "/v1/embeddings",
    body: { model: "text-embedding-3-small", input: prompt, dimensions: 2 },
    permissive: 200,
  },
  {
    id: "gemini-embedding",
    path: "/v1beta/models/text-embedding-004:embedContent",
    body: { content: { parts: [{ text: prompt }] }, outputDimensionality: 2 },
    permissive: 200,
  },
  { id: "moderation", path: "/v1/moderations", body: { input: prompt }, permissive: 200 },
  { id: "rerank", path: "/v2/rerank", body: { query: prompt }, permissive: 200 },
  { id: "search", path: "/search", body: { query: prompt }, permissive: 200 },
] as const;
type Route = (typeof routes)[number];
const policies = [
  { id: "default-off", strict: false, header: undefined, refusal: false },
  { id: "header-on", strict: false, header: " TRUE ", refusal: true, override: true },
  { id: "default-on", strict: true, header: undefined, refusal: true },
  { id: "header-off", strict: true, header: "0", refusal: false, override: false },
  { id: "invalid-header-default-off", strict: false, header: "invalid", refusal: false },
  { id: "invalid-header-default-on", strict: true, header: "invalid", refusal: true },
] as const;

function entries(journal: Journal) {
  return journal.getAll().map((entry) => ({
    method: entry.method,
    path: entry.path,
    service: entry.service,
    body: entry.body,
    response: entry.response,
  }));
}
function json(body: unknown, header?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "a7-caller-trace",
      ...(header === undefined ? {} : { "x-aimock-strict": header }),
    },
    body: JSON.stringify(body),
  };
}
async function source(
  fixtures: Fixture[] = [],
  options: Partial<MockServerOptions> = {},
  services?: ServiceFixtures,
): Promise<GoldenServer> {
  if (!services) return startGoldenServer(fixtures, options);
  const instance = await createServer(
    fixtures,
    { port: 0, host: "127.0.0.1", latency: 0, chunkSize: 20, logLevel: "silent", ...options },
    undefined,
    services,
  );
  return {
    url: instance.url,
    instance,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => {
        instance.server.close((error) => (error ? reject(error) : resolveClose()));
        instance.server.closeAllConnections();
      });
    },
  };
}
interface Capture {
  id: string;
  wire: CapturedExchange;
  entries: ReturnType<typeof entries>;
  upstream?: Array<{
    method: string;
    path: string;
    body: string;
    strict: string | string[] | null;
  }>;
  fixtureFiles?: unknown[];
}
async function exchange(
  id: string,
  route: Route,
  init: RequestInit & { frames?: FrameMode } = json(route.body),
  fixtures: Fixture[] = [],
  options: Partial<MockServerOptions> = {},
  services?: ServiceFixtures,
): Promise<Capture> {
  const server = await source(fixtures, options, services);
  try {
    const wire = await captureHttp(server.url + route.path, init);
    return { id, wire, entries: entries(server.instance.journal) };
  } finally {
    await server.close();
  }
}
function hit(route: Route, response?: FixtureResponse): Fixture[] {
  if (route.id === "chat")
    return [
      {
        match: { userMessage: prompt },
        response: response ?? {
          content: "a7 reply",
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        },
      },
    ];
  if (route.id === "embedding" || route.id === "gemini-embedding")
    return [
      {
        match: { endpoint: "embedding", inputText: prompt },
        response: response ?? { embedding: [0.25, -0.5] },
      },
    ];
  return [];
}
function services(): ServiceFixtures {
  return {
    moderation: [
      {
        match: prompt,
        result: {
          flagged: true,
          categories: { violence: true },
          category_scores: { violence: 0.9 },
        },
      },
    ],
    rerank: [{ match: prompt, results: [{ index: 1, relevance_score: 0.75 }] }],
    search: [
      {
        match: prompt,
        results: [
          { title: "a7 result", url: "https://example.test/a7", content: "a7 content", score: 0.5 },
        ],
      },
    ],
  };
}

async function recordCase(
  route: Route,
  strict: boolean,
  header?: string,
  chaos?: MockServerOptions["chaos"],
): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), "aimock-a7-record-"));
  const upstream = await startStubUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        route.id === "chat"
          ? {
              id: "chatcmpl-a7-upstream-fixed",
              object: "chat.completion",
              created: 1700000000,
              model: "gpt-4o-mini",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "a7 upstream" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
            }
          : route.id === "embedding"
            ? {
                object: "list",
                model: "text-embedding-3-small",
                data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
                usage: { prompt_tokens: 2, total_tokens: 2 },
              }
            : { embedding: { values: [0.1, 0.2] } },
      ),
    );
  });
  let server: GoldenServer | undefined;
  try {
    const provider = route.id === "gemini-embedding" ? "gemini" : "openai";
    server = await source([], {
      strict,
      chaos,
      record: { providers: { [provider]: upstream.url }, fixturePath: dir },
    });
    const wire = await captureHttp(server.url + route.path, json(route.body, header));
    const proxy = !strict || header === "false";
    const isService = ["moderation", "rerank", "search"].includes(route.id);
    const expectedHits = proxy && (!chaos || chaos.malformedRate === 1) && !isService ? 1 : 0;
    expect(upstream.requests).toHaveLength(expectedHits);
    if (expectedHits)
      await expect
        .poll(() => readdirSync(dir).filter((file) => file.endsWith(".json")).length)
        .toBe(1);
    const fixtureFiles: unknown[] = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")));
    const captured: Capture = {
      id: `${route.id}-${chaos ? "chaos" : "record"}-${strict ? "strict" : "off"}${header ? "-header-off" : ""}`,
      wire,
      entries: entries(server.instance.journal),
      upstream: upstream.requests.map((request) => ({
        method: request.method,
        path: request.url,
        body: request.body,
        strict: request.headers["x-aimock-strict"] ?? null,
      })),
      fixtureFiles,
    };
    for (const request of captured.upstream ?? []) expect(request.strict).toBeNull();
    return captured;
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

async function directEmbedding(
  id: string,
  strict: boolean,
  header?: string,
  fixtures: Fixture[] = [],
  body: unknown = routes[1].body,
): Promise<Capture> {
  const journal = new Journal();
  const defaults: HandlerDefaults = {
    latency: 0,
    chunkSize: 20,
    replaySpeed: 1,
    logger: new Logger("silent"),
    strict,
  };
  const errors: unknown[] = [];
  const pending: Promise<void>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", (error) => {
      errors.push(error);
      res.destroy();
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () =>
      pending.push(
        handleEmbeddings(
          req,
          res,
          Buffer.concat(chunks).toString(),
          fixtures,
          journal,
          defaults,
          () => {},
        ).catch((error: unknown) => {
          errors.push(error);
          res.destroy();
        }),
      ),
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  let result: Capture | undefined;
  let primary: { error: unknown } | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const wire = await captureHttp(
      `http://127.0.0.1:${address.port}/v1/embeddings`,
      json(body, header),
    );
    await Promise.all(pending);
    expect(errors).toEqual([]);
    result = { id, wire, entries: entries(journal) };
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
  for (const outcome of cleanup) if (outcome.status === "rejected") errors.push(outcome.reason);
  if (primary) throw primary.error;
  if (errors.length) throw new Error(`A7 direct handler failure: ${errors.map(String).join("; ")}`);
  if (!result) throw new Error("A7 direct handler did not produce a capture");
  return result;
}

describe("actual A7 equivalence", () => {
  it("preserves the frozen real HTTP, direct, upstream, journal and complete SSE matrix", async () => {
    const matrix: Capture[] = [];
    for (const route of routes) {
      for (const policy of policies) {
        const capture = await exchange(
          `${route.id}-miss-${policy.id}`,
          route,
          json(route.body, policy.header),
          [],
          { strict: policy.strict },
        );
        expect(capture.wire.status, capture.id).toBe(policy.refusal ? 503 : route.permissive);
        expect(capture.entries).toHaveLength(1);
        if (
          "override" in policy &&
          (policy.refusal || !["embedding", "gemini-embedding"].includes(route.id))
        )
          expect(capture.entries[0].response.strictOverride).toBe(policy.override);
        else expect(capture.entries[0].response).not.toHaveProperty("strictOverride");
        matrix.push(capture);
      }
      for (const header of [undefined, "false"]) {
        const capture = await exchange(
          `${route.id}-hit-${header ? "header-off" : "strict"}`,
          route,
          json(route.body, header),
          hit(route),
          { strict: true },
          services(),
        );
        expect(capture.wire.status, capture.id).toBe(200);
        matrix.push(capture);
      }
      for (const [id, body] of [
        ["malformed", "{"],
        ["nonobject", "null"],
      ]) {
        const capture = await exchange(`${route.id}-validation-${id}`, route, {
          ...json(route.body),
          body,
        });
        expect(capture.wire.status, capture.id).toBe(400);
        matrix.push(capture);
      }
    }

    const guards = [
      { route: routes[0], id: "messages-missing", body: {} },
      { route: routes[0], id: "message-null", body: { ...chatBody, messages: [null] } },
      { route: routes[0], id: "tools-invalid", body: { ...chatBody, tools: "bad" } },
      {
        route: routes[0],
        id: "function-null",
        body: { ...chatBody, tools: [{ type: "function", function: null }] },
      },
      { route: routes[1], id: "input-missing", body: { model: "text-embedding-3-small" } },
      { route: routes[1], id: "model-missing", body: { input: prompt, dimensions: 2 } },
      { route: routes[1], id: "input-invalid", body: { ...routes[1].body, input: {} } },
      { route: routes[1], id: "dimensions-invalid", body: { ...routes[1].body, dimensions: -1 } },
      { route: routes[2], id: "parts-invalid", body: { content: { parts: {} } } },
      { route: routes[2], id: "part-null", body: { content: { parts: [null] } } },
      {
        route: routes[2],
        id: "dimensions-invalid",
        body: { ...routes[2].body, outputDimensionality: -1 },
      },
      { route: routes[3], id: "input-invalid", body: { input: {} } },
      { route: routes[4], id: "query-invalid", body: { query: {} } },
      { route: routes[5], id: "query-invalid", body: { query: {} } },
    ];
    for (const guard of guards) {
      const capture = await exchange(
        `${guard.route.id}-${guard.id}`,
        guard.route,
        json(guard.body),
      );
      expect(capture.wire.status, capture.id).toBe(400);
      matrix.push(capture);
    }
    for (const route of routes.slice(0, 3)) {
      const error = {
        error: { message: "a7 fixture error", type: "rate_limit_error", code: "a7_error" },
        status: 429,
        retryAfter: 7,
      };
      const capture = await exchange(
        `${route.id}-fixture-error`,
        route,
        json(route.body),
        hit(route, error),
      );
      expect(capture.wire.status).toBe(429);
      expect(capture.wire.headers["retry-after"]).toBe("7");
      matrix.push(capture);
      const wrong = await exchange(
        `${route.id}-unknown-fixture`,
        route,
        json(route.body),
        hit(route, route.id === "chat" ? { embedding: [1, 2] } : { content: "wrong response" }),
      );
      expect(wrong.wire.status).toBe(500);
      matrix.push(wrong);
      for (const policy of [{ strict: false }, { strict: true }, { strict: true, header: "false" }])
        matrix.push(
          await recordCase(route, policy.strict, "header" in policy ? policy.header : undefined),
        );
      const exhausted = hit(route);
      exhausted[0].match.sequenceIndex = 0;
      const server = await source(exhausted, { strict: true });
      try {
        const first = await captureHttp(server.url + route.path, json(route.body));
        const second = await captureHttp(server.url + route.path, json(route.body));
        expect(first.status).toBe(200);
        expect(second.status).toBe(503);
        expect(second.body).toContain("skipped by sequence/turn state");
        matrix.push(
          { id: `${route.id}-sequence-hit`, wire: first, entries: [] },
          {
            id: `${route.id}-sequence-exhausted`,
            wire: second,
            entries: entries(server.instance.journal),
          },
        );
      } finally {
        await server.close();
      }
    }
    for (const route of routes.slice(3)) matrix.push(await recordCase(route, true, "false"));
    for (const chaos of [{ rateLimitRate: 1 }, { malformedRate: 1 }]) {
      for (const header of [undefined, "false"]) {
        const capture = await recordCase(routes[0], true, header, chaos);
        capture.id += "rateLimitRate" in chaos ? "-rate-limit" : "-malformed";
        expect(capture.entries[0].response.source).toBe(header ? "proxy" : "internal");
        matrix.push(capture);
      }
    }

    const tool = { id: "call_a7_fixed", name: "lookup", arguments: '{"q":"a7"}' };
    const reasoningShapes = [
      { id: "text", response: { content: "a7 reply" } },
      { id: "tools", response: { toolCalls: [tool] } },
      { id: "combined", response: { content: "a7 reply", toolCalls: [tool] } },
      { id: "applied-text", response: { content: "a7 reply" }, applied: true },
    ] satisfies Array<{ id: string; response: FixtureResponse; applied?: boolean }>;
    for (const shape of reasoningShapes)
      for (const strict of [false, true])
        for (const stream of [false, true]) {
          const response: FixtureResponse = {
            ...shape.response,
            reasoning: "a7 reasoning",
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          };
          const capture = await exchange(
            `chat-reasoning-${shape.id}-${strict ? "strict" : "off"}-${stream ? "sse" : "http"}`,
            routes[0],
            {
              ...json({ ...chatBody, stream, stream_options: { include_usage: true } }),
              ...(stream ? { frames: "sse" as const } : {}),
            },
            hit(routes[0], response),
            {
              strict,
              ...(shape.applied
                ? {
                    enableMisbehavior: true,
                    misbehavior: {
                      seed: 0,
                      faults: [{ fault: "refusal", rate: 1, message: "a7 refusal" }],
                    },
                  }
                : {}),
            },
          );
          expect(capture.wire.status).toBe(200);
          if (!shape.applied) {
            const text = capture.wire.body ?? capture.wire.frames?.join("\n") ?? "";
            expect(text.includes("a7 reasoning"), capture.id).toBe(!strict);
          }
          if (stream) {
            expect(capture.wire.frames?.at(-1)).toBe("data: [DONE]");
            expect(capture.wire.tail).toBeUndefined();
          }
          matrix.push(capture);
        }
    for (const [id, response, status] of [
      ["unsupported-audio", { audio: "/wAB", format: "wav" }, 422],
      [
        "unsupported-custom-tool-callback",
        {
          responsesBlocks: [
            { type: "text", text: "a7" },
            { type: "customToolCall", id: "ctc_a7_fixed", name: "lookup", input: "a7" },
          ],
        },
        500,
      ],
    ] satisfies Array<[string, FixtureResponse, number]>) {
      const capture = await exchange(
        `chat-${id}`,
        routes[0],
        json(chatBody),
        hit(routes[0], response),
        { responsesTools: "extended" },
      );
      expect(capture.wire.status).toBe(status);
      expect(capture.entries).toHaveLength(1);
      expect(capture.entries[0].response.status).toBe(status);
      matrix.push(capture);
    }
    const evaluation = await exchange(
      "chat-misbehavior-evaluation-error",
      routes[0],
      {
        ...json(chatBody),
        headers: {
          "content-type": "application/json",
          "x-request-id": "a7-caller-trace",
          "x-aimock-misbehavior": "tool-args-invalid-json; tool=lookup",
        },
      },
      hit(routes[0]),
      { enableMisbehavior: true },
    );
    expect(evaluation.wire.status).toBe(501);
    expect(evaluation.entries).toHaveLength(1);
    matrix.push(evaluation);
    matrix.push(await directEmbedding("direct-embedding-hit", true, undefined, hit(routes[1])));
    for (const policy of policies.slice(0, 4))
      matrix.push(
        await directEmbedding(`direct-embedding-${policy.id}`, policy.strict, policy.header),
      );
    matrix.push(
      await directEmbedding("direct-embedding-model-default", false, undefined, [], {
        input: prompt,
        dimensions: 2,
      }),
    );

    for (const path of ["/a7-not-found", "/v1/_requests?limit=bad", "/v1/voices/%ZZ"]) {
      const server = await source();
      try {
        matrix.push({
          id: `server-${path}`,
          wire: await captureHttp(server.url + path),
          entries: entries(server.instance.journal),
        });
      } finally {
        await server.close();
      }
    }
    expect(new Set(matrix.map((capture) => capture.id)).size).toBe(matrix.length);
    console.log(
      JSON.stringify({
        surface: "actual-A7",
        cases: matrix.length,
        ids: matrix.map((capture) => capture.id),
      }),
    );
    const nativeJsonBodies = matrix.flatMap((capture, rowIndex) =>
      capture.id.endsWith("-validation-malformed") ? [[rowIndex, "wire", "body"] as const] : [],
    );
    expectGolden("response-a7", "equivalence-matrix", matrix, { nativeJsonBodies });
  }, 30000);
});
