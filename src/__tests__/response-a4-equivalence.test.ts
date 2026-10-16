import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Fixture } from "../types.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  startStubUpstream,
} from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const files = ["bedrock-converse.ts", "cohere.ts", "ollama.ts"];
function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    nodes.push(child, ...descendants(child));
  });
  return nodes;
}

describe("A4 compiler-bound source ownership", () => {
  it.each(files)("%s adopts shared decisions and error templates", (name) => {
    const path = join(sourceRoot, name);
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const file = program.getSourceFile(path)!;
    const checker = program.getTypeChecker();
    const nodes = descendants(file);
    const calls = (owner: string, exported: string) => {
      const bindings = file.statements.flatMap((statement) => {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== owner
        )
          return [];
        const named = statement.importClause?.namedBindings;
        return named && ts.isNamedImports(named)
          ? named.elements.filter(
              (binding) => (binding.propertyName ?? binding.name).text === exported,
            )
          : [];
      });
      return nodes
        .filter(ts.isCallExpression)
        .filter((call) =>
          checker
            .getSymbolAtLocation(call.expression)
            ?.declarations?.some(
              (declaration) => ts.isImportSpecifier(declaration) && bindings.includes(declaration),
            ),
        );
    };
    for (const old of ["resolveStrictMode", "strictOverrideField", "serializeErrorResponse"])
      expect(calls("./helpers.js", old), old).toHaveLength(0);
    const decisions = calls("./response/policy.js", "resolveRequestDecisions");
    expect(decisions).toHaveLength(
      name === "bedrock-converse.ts" ? 9 : name === "cohere.ts" ? 6 : 8,
    );
    expect(calls("./response/policy.js", "strictOverrideField")).toHaveLength(
      name === "bedrock-converse.ts" ? 4 : name === "cohere.ts" ? 3 : 5,
    );
    for (const call of decisions) {
      expect(ts.isPropertyAccessExpression(call.parent)).toBe(true);
      if (ts.isPropertyAccessExpression(call.parent))
        expect(["fixtureMiss", "reasoningSuppression", "strictOverride"]).toContain(
          call.parent.name.text,
        );
    }
    expect(calls("./response/errors.js", "renderError")).toHaveLength(
      name === "bedrock-converse.ts" ? 16 : name === "cohere.ts" ? 18 : 25,
    );
    const writes = nodes
      .filter(ts.isCallExpression)
      .filter((call) => call.expression.getText(file) === "writeErrorResponse");
    for (const call of writes)
      expect(
        [call.arguments[2], ...descendants(call.arguments[2])]
          .filter(ts.isCallExpression)
          .filter((nested) => nested.expression.getText(file) === "JSON.stringify"),
        call.getText(file),
      ).toHaveLength(0);
  });
});

function evidence(id: string, value: unknown) {
  const bytes = serializeGolden(value);
  if (process.env.A4_BASELINE_DIR)
    expect(bytes, id).toBe(readFileSync(join(process.env.A4_BASELINE_DIR, `${id}.json`), "utf8"));
  if (process.env.A4_CAPTURE_DIR) {
    mkdirSync(process.env.A4_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.A4_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

const routes = [
  { id: "converse", path: "/model/anthropic.claude-3-haiku-20240307-v1:0/converse" },
  { id: "converse-stream", path: "/model/anthropic.claude-3-haiku-20240307-v1:0/converse-stream" },
  { id: "cohere", path: "/v2/chat" },
  { id: "cohere-embed", path: "/v2/embed" },
  { id: "ollama", path: "/api/chat" },
  { id: "ollama-generate", path: "/api/generate" },
  { id: "ollama-embed", path: "/api/embed" },
  { id: "ollama-embeddings", path: "/api/embeddings" },
] as const;
function requestBody(id: string, text: string, stream = false, model?: string) {
  return {
    model: model ?? (id.startsWith("cohere") ? "command-r-plus" : "llama3.2"),
    messages: [{ role: "user", content: id.startsWith("converse") ? [{ text }] : text }],
    prompt: text,
    input: text,
    texts: [text],
    stream,
    input_type: "search_document",
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    toolConfig: {
      tools: [{ toolSpec: { name: "lookup", inputSchema: { json: { type: "object" } } } }],
    },
  };
}

describe("A4 actual source-server HTTP equivalence", () => {
  it.each(
    routes.filter((route) => !route.id.endsWith("embed") && !route.id.endsWith("embeddings")),
  )("$id unavailable misbehavior payload", async (route) => {
    const server = await startGoldenServer(
      [
        {
          match: {},
          response: { content: "Reply" },
          misbehavior: {
            seed: 0,
            faults: [
              {
                fault:
                  route.id === "cohere"
                    ? "content-filter"
                    : route.id.startsWith("converse")
                      ? "refusal"
                      : "tool-unknown-name",
                rate: 1,
              },
            ],
          },
        },
      ],
      { enableMisbehavior: true },
    );
    try {
      const got = await captureHttp(`${server.url}${route.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "a4.local" },
        body: JSON.stringify(requestBody(route.id, "hit")),
      });
      expect(got.status).toBe(501);
      evidence(`${route.id}-unavailable`, {
        got,
        journal: server.instance.journal.getAll().map(({ headers, ...entry }) => ({
          ...entry,
          headers: { ...headers, host: "127.0.0.1:<port>" },
        })),
      });
    } finally {
      await server.close();
    }
  });
  for (const route of routes) {
    it.each([
      "malformed",
      "null",
      "shape",
      "strict",
      "lenient",
      "override-true",
      "override-false",
      "invalid-header",
      "fixture-error",
      "unknown-response",
    ])(`${route.id} %s`, async (kind) => {
      const fixtures: Fixture[] =
        kind === "fixture-error"
          ? [
              {
                match: {},
                response: {
                  error: {
                    message: "authored error",
                    type: "authored_type",
                    code: "authored_code",
                    param: "authored_param",
                  },
                  status: 429,
                  retryAfter: 7,
                },
              },
            ]
          : kind === "unknown-response"
            ? [{ match: {}, response: {} }]
            : [];
      const strict = ["strict", "override-false", "invalid-header"].includes(kind);
      const server = await startGoldenServer(fixtures, { strict });
      try {
        const body =
          kind === "malformed"
            ? "{"
            : kind === "null"
              ? "null"
              : JSON.stringify(
                  kind === "shape"
                    ? { model: "llama3.2", messages: 7, texts: 7, prompt: 7, input: 7 }
                    : requestBody(route.id, "miss"),
                );
        const header =
          kind === "override-true"
            ? " TRUE "
            : kind === "override-false"
              ? "0"
              : kind === "invalid-header"
                ? "invalid"
                : undefined;
        const got = await captureHttp(`${server.url}${route.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",

            ...(header === undefined ? {} : { "x-aimock-strict": header }),
          },
          body,
        });
        expect(got.status).toBe(
          kind === "fixture-error"
            ? 429
            : kind === "unknown-response"
              ? 500
              : ["malformed", "null", "shape"].includes(kind)
                ? 400
                : ["strict", "override-true", "invalid-header"].includes(kind)
                  ? 503
                  : route.id.endsWith("embed") || route.id.endsWith("embeddings")
                    ? 200
                    : 404,
        );
        evidence(`${route.id}-${kind}`, {
          got,
          journal: server.instance.journal.getAll().map(({ headers, ...entry }) => ({
            ...entry,
            headers: { ...headers, host: "127.0.0.1:<port>" },
          })),
        });
      } finally {
        await server.close();
      }
    });
  }

  for (const route of routes.filter(
    (r) => !r.id.endsWith("embed") && !r.id.endsWith("embeddings"),
  )) {
    for (const stream of [false, true]) {
      if (route.id.startsWith("converse") && stream !== route.id.endsWith("stream")) continue;
      it.each(["text", "tools", "combined", "blocks", "misbehavior"])(
        `${route.id} stream=${stream} %s`,
        async (shape) => {
          const toolCalls = [{ name: "lookup", arguments: "{}", id: "call_fixed_a4" }];
          const response =
            shape === "tools"
              ? { toolCalls }
              : shape === "combined" || shape === "misbehavior"
                ? { content: "Before", toolCalls, reasoning: "thinking" }
                : shape === "blocks"
                  ? {
                      blocks: [
                        { type: "text" as const, text: "Before" },
                        { type: "toolCall" as const, ...toolCalls[0] },
                      ],
                      reasoning: "thinking",
                    }
                  : { content: "Reply", reasoning: "thinking" };
          const server = await startGoldenServer(
            [
              {
                match: {},
                response,
                ...(shape === "misbehavior"
                  ? {
                      misbehavior: {
                        seed: 0,
                        faults: [
                          {
                            fault: "tool-args-invalid-json" as const,
                            style: "truncated" as const,
                            rate: 1,
                          },
                        ],
                      },
                    }
                  : {}),
              },
            ],
            { enableMisbehavior: true, strict: false },
          );
          try {
            const got = await captureHttp(`${server.url}${route.path}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",

                "x-aimock-strict": "true",
              },
              body: JSON.stringify(requestBody(route.id, "hit", stream)),
              ...(stream && shape !== "misbehavior"
                ? {
                    frames: route.id.startsWith("converse")
                      ? ("aws" as const)
                      : route.id === "cohere"
                        ? ("sse" as const)
                        : ("ndjson" as const),
                  }
                : {}),
            });
            expect(got.status).toBe(
              shape === "misbehavior" && route.id === "ollama-generate"
                ? 501
                : shape === "misbehavior" && route.id === "ollama" && !stream
                  ? 500
                  : route.id === "ollama-generate" && shape !== "text"
                    ? 400
                    : 200,
            );
            evidence(`${route.id}-${stream}-${shape}`, {
              got,
              journal: server.instance.journal.getAll().map(({ headers, ...entry }) => ({
                ...entry,
                headers: { ...headers, host: "127.0.0.1:<port>" },
              })),
            });
          } finally {
            await server.close();
          }
        },
      );
    }
  }

  it.each(routes)("$id proxy decision and strict refusal", async (route) => {
    const upstream = await startStubUpstream((_req, res) => {
      res.writeHead(202, {
        "content-type": "application/json",
        "x-a4-upstream": "yes",
      });
      res.end('{"upstream":"fixed"}');
    });
    const dir = mkdtempSync(join(tmpdir(), "aimock-a4-proxy-"));
    const server = await startGoldenServer([], {
      record: {
        providers: { bedrock: upstream.url, cohere: upstream.url, ollama: upstream.url },
        fixturePath: join(dir, "fixtures.json"),
        proxyOnly: true,
      },
      strict: true,
    });
    try {
      for (const strict of ["false", "true"]) {
        const got = await captureHttp(`${server.url}${route.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",

            "x-aimock-strict": strict,
          },
          body: JSON.stringify(requestBody(route.id, "proxy")),
        });
        expect(got.status).toBe(strict === "true" ? 503 : 200);
        evidence(`${route.id}-proxy-${strict}`, {
          got,
          journal: server.instance.journal
            .getAll()
            .map(({ headers, ...entry }) => ({
              ...entry,
              headers: { ...headers, host: "127.0.0.1:<port>" },
            }))
            .at(-1),
          upstreamRequests: upstream.requests.map(({ method, url, body }) => ({
            method,
            url,
            body,
          })),
        });
      }
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await server.close();
      await upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
