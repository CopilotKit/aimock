import { readFileSync } from "node:fs";
import * as http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { handleBedrock, handleBedrockStream } from "../bedrock.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import { handleMessages } from "../messages.js";
import type { Fixture, HandlerDefaults, MockServerOptions } from "../types.js";
import {
  captureHttp,
  expectGolden,
  startGoldenServer,
  startStubUpstream,
  type FrameMode,
} from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const suite = "response-a1";

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    result.push(child, ...descendants(child));
  });
  return result;
}

function boundCalls(file: ts.SourceFile, checker: ts.TypeChecker, owner: string, name: string) {
  const symbols = file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return [];
    if (
      resolve(dirname(file.fileName), statement.moduleSpecifier.text.replace(/\.js$/, ".ts")) !==
      join(sourceRoot, owner)
    )
      return [];
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return [];
    return named.elements
      .filter((binding) => (binding.propertyName ?? binding.name).text === name)
      .map((binding) => checker.getSymbolAtLocation(binding.name));
  });
  return descendants(file).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      symbols.some((symbol) => symbol && symbol === checker.getSymbolAtLocation(node.expression)),
  );
}

describe("A1 source ownership", () => {
  for (const [relative, expectedDecisions, expectedErrors] of [
    ["messages.ts", { thinkingRejection: 1, fixtureMiss: 1, reasoningSuppression: 4 }, 11],
    ["bedrock.ts", { fixtureMiss: 2, reasoningSuppression: 8 }, 16],
  ] as const) {
    it(`${relative} uses bound policy and error owners at every adopted read`, () => {
      const path = join(sourceRoot, relative);
      const program = ts.createProgram([path], { noResolve: true, noLib: true });
      const file = program.getSourceFile(path);
      if (!file) throw new Error(`Missing source ${relative}`);
      const checker = program.getTypeChecker();
      const legacy = ["resolveStrictMode", "strictOverrideField"].flatMap((name) =>
        boundCalls(file, checker, "helpers.ts", name),
      );
      expect(
        legacy.map((call) => call.getText(file)),
        "legacy helper reads must be removed",
      ).toEqual([]);
      const decisions = boundCalls(file, checker, "response/policy.ts", "resolveRequestDecisions");
      expect(decisions).toHaveLength(Object.values(expectedDecisions).reduce((a, b) => a + b, 0));
      const properties = decisions.map((call) => {
        expect(call.arguments.map((argument) => argument.getText(file))).toEqual([
          "defaults.strict",
          "req.headers",
        ]);
        if (!ts.isPropertyAccessExpression(call.parent))
          throw new Error("A1 decisions must select their named purpose at the original read");
        return call.parent.name.text;
      });
      for (const [property, count] of Object.entries(expectedDecisions))
        expect(properties.filter((value) => value === property)).toHaveLength(count);
      expect(boundCalls(file, checker, "response/policy.ts", "strictOverrideField")).toHaveLength(
        4,
      );
      expect(boundCalls(file, checker, "response/errors.ts", "renderError")).toHaveLength(
        expectedErrors,
      );
      const inlineErrors = descendants(file).filter(
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(file) === "JSON.stringify" &&
          node.arguments.some(
            (argument) =>
              ts.isObjectLiteralExpression(argument) &&
              argument.properties.some(
                (property) =>
                  ts.isPropertyAssignment(property) && property.name.getText(file) === "error",
              ),
          ),
      );
      expect(inlineErrors, "common error envelopes retain their accepted shared owner").toEqual([]);
      expect(readFileSync(path, "utf8")).not.toContain('req.headers["x-aimock-strict"]');
    });
  }
});

const wires = [
  { id: "messages-json", messages: true, stream: false },
  { id: "messages-sse", messages: true, stream: true },
  { id: "bedrock-json", messages: false, stream: false },
  { id: "bedrock-aws", messages: false, stream: true },
] as const;
type Wire = (typeof wires)[number];
type Mount = "source" | "direct";
const mounts: Mount[] = ["source", "direct"];

const settings = [
  { id: "default", strict: undefined, header: undefined, status: 404, override: undefined },
  { id: "false", strict: false, header: undefined, status: 404, override: undefined },
  { id: "true", strict: true, header: undefined, status: 503, override: undefined },
  { id: "header-true", strict: false, header: " TrUe ", status: 503, override: true },
  { id: "header-one", strict: false, header: "1", status: 503, override: true },
  { id: "header-false", strict: true, header: "false", status: 404, override: false },
  { id: "header-zero", strict: true, header: "0", status: 404, override: false },
  { id: "invalid-true", strict: true, header: "invalid", status: 503, override: undefined },
  { id: "invalid-false", strict: false, header: "invalid", status: 404, override: undefined },
] as const;

const fixtures: Fixture[] = [
  {
    match: { userMessage: "text" },
    response: { content: "Answer", reasoning: "Reason", reasoningSignature: "signature" },
  },
  {
    match: { userMessage: "tool" },
    response: {
      toolCalls: [{ name: "lookup", arguments: "{}" }],
      reasoning: "Reason",
      reasoningSignature: "signature",
    },
  },
  {
    match: { userMessage: "combined" },
    response: {
      content: "Answer",
      toolCalls: [{ name: "lookup", arguments: "{}" }],
      reasoning: "Reason",
      reasoningSignature: "signature",
    },
  },
  {
    match: { userMessage: "error" },
    response: {
      error: { message: "Limited", type: "rate_limit_error", code: "limited" },
      status: 429,
    },
  },
];

function body(wire: Wire, text: string, model = "gpt-4") {
  return {
    ...(wire.messages
      ? { model, stream: wire.stream }
      : { anthropic_version: "bedrock-2023-05-31" }),
    max_tokens: 100,
    messages: [{ role: "user", content: text }],
  };
}

function path(wire: Wire, model = "gpt-4") {
  return wire.messages
    ? "/v1/messages"
    : `/model/${model}/${wire.stream ? "invoke-with-response-stream" : "invoke"}`;
}

function journalCapture(journal: Journal) {
  return journal.getAll().map((entry) => ({
    method: entry.method,
    path: entry.path,
    body: entry.body,
    response: entry.response,
    responseKeys: Object.keys(entry.response),
  }));
}

async function open(
  mount: Mount,
  wire: Wire,
  inputFixtures: Fixture[],
  options: Partial<MockServerOptions> = {},
  model = "gpt-4",
) {
  if (mount === "source") {
    const server = await startGoldenServer(inputFixtures, options);
    return { url: server.url, journal: server.instance.journal, close: server.close };
  }
  // Existing direct-call mounts are private to their suite. This mount supplies real HTTP objects
  // and invokes only A1's exported handlers, with caller-owned HandlerDefaults.
  const journal = new Journal();
  const defaults: HandlerDefaults = {
    latency: 0,
    chunkSize: 20,
    replaySpeed: 1,
    logger: new Logger("silent"),
    strict: options.strict,
    policy: options.policy,
    record: options.record,
    misbehavior: options.enableMisbehavior ? { byTestId: new Map() } : undefined,
    misbehaviorCounters: journal,
  };
  const failures: unknown[] = [];
  const invocations: Promise<void>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", (error) => {
      failures.push(error);
      res.destroy();
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const noCors = () => {};
      const run = wire.messages
        ? handleMessages(req, res, raw, inputFixtures, journal, defaults, noCors)
        : (wire.stream ? handleBedrockStream : handleBedrock)(
            req,
            res,
            raw,
            model,
            inputFixtures,
            journal,
            defaults,
            noCors,
          );
      invocations.push(
        run.catch((error: unknown) => {
          failures.push(error);
          res.destroy();
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing direct handler port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    journal,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await Promise.all(invocations);
      if (failures.length)
        throw new Error(`Direct handler failed: ${failures.map(String).join("; ")}`);
    },
  };
}

async function send(
  server: Awaited<ReturnType<typeof open>>,
  wire: Wire,
  payload: unknown,
  headers: http.OutgoingHttpHeaders = {},
  model = "gpt-4",
  successfulStream = false,
) {
  const requestHeaders = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined) requestHeaders.set(name, String(value));
  const frames: FrameMode | undefined =
    wire.stream && successfulStream ? (wire.messages ? "sse" : "aws") : undefined;
  return captureHttp(`${server.url}${path(wire, model)}`, {
    method: "POST",
    headers: requestHeaders,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    frames,
  });
}

function assertOverride(journal: Journal, expected: boolean | undefined) {
  const response = journal.getLast()?.response;
  expect(response?.strictOverride).toBe(expected);
  expect(Object.prototype.hasOwnProperty.call(response ?? {}, "strictOverride")).toBe(
    expected !== undefined,
  );
}

describe("A1 actual runtime equivalence", () => {
  for (const mount of mounts)
    for (const wire of wires) {
      for (const setting of settings) {
        it(`${mount} ${wire.id} miss ${setting.id}`, async () => {
          const server = await open(mount, wire, [], { strict: setting.strict });
          try {
            const got = await send(
              server,
              wire,
              body(wire, "miss"),
              setting.header === undefined ? {} : { "x-aimock-strict": setting.header },
            );
            expect(got.status).toBe(setting.status);
            assertOverride(server.journal, setting.override);
            expectGolden(suite, `${mount}-${wire.id}-miss-${setting.id}`, {
              got,
              journal: journalCapture(server.journal),
            });
          } finally {
            await server.close();
          }
        });
      }
      for (const shape of ["text", "tool", "combined"] as const)
        for (const strict of [false, true]) {
          it(`${mount} ${wire.id} reasoning ${shape} ${strict}`, async () => {
            const server = await open(mount, wire, fixtures, { strict });
            try {
              const got = await send(server, wire, body(wire, shape), {}, "gpt-4", true);
              expect(got.status).toBe(200);
              expectGolden(suite, `${mount}-${wire.id}-reasoning-${shape}-${strict}`, {
                got,
                journal: journalCapture(server.journal),
              });
            } finally {
              await server.close();
            }
          });
        }
      for (const strict of [false, true]) {
        it(`${mount} ${wire.id} applied misbehavior ${strict}`, async () => {
          const server = await open(mount, wire, fixtures, { strict, enableMisbehavior: true });
          try {
            const got = await send(
              server,
              wire,
              body(wire, "combined"),
              {
                "x-aimock-misbehavior": "empty-response",
              },
              "gpt-4",
              true,
            );
            expect(got.status).toBe(200);
            expect(server.journal.getLast()?.response.misbehavior?.fault).toBe("empty-response");
            expectGolden(suite, `${mount}-${wire.id}-misbehavior-${strict}`, {
              got,
              journal: journalCapture(server.journal),
            });
          } finally {
            await server.close();
          }
        });
      }
      for (const error of ["malformed", "invalid", "fixture", "misbehavior"] as const) {
        it(`${mount} ${wire.id} ${error} error`, async () => {
          const server = await open(mount, wire, fixtures, { enableMisbehavior: true });
          try {
            const payload =
              error === "malformed"
                ? "{"
                : error === "invalid"
                  ? {}
                  : body(wire, error === "fixture" ? "error" : "text");
            const got = await send(
              server,
              wire,
              payload,
              error === "misbehavior" ? { "x-aimock-misbehavior": "typo" } : {},
            );
            expect(got.status).toBe(error === "fixture" ? 429 : 400);
            expectGolden(
              suite,
              `${mount}-${wire.id}-error-${error}`,
              { got, journal: journalCapture(server.journal) },
              error === "malformed" ? { nativeJsonBodies: [["got", "body"]] } : undefined,
            );
          } finally {
            await server.close();
          }
        });
      }
    }

  for (const mount of mounts)
    for (const strict of [false, true]) {
      it(`${mount} thinking violation ${strict}`, async () => {
        const wire = wires[0];
        const server = await open(
          mount,
          wire,
          [{ match: { toolCallId: "tu_1" }, response: { content: "Sunny" } }],
          { strict: !strict },
        );
        try {
          const got = await send(
            server,
            wire,
            {
              model: "claude-3-7-sonnet-20250219",
              max_tokens: 1024,
              thinking: { type: "enabled", budget_tokens: 1024 },
              messages: [
                { role: "user", content: "text" },
                {
                  role: "assistant",
                  content: [{ type: "tool_use", id: "tu_1", name: "lookup", input: {} }],
                },
                {
                  role: "user",
                  content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Sunny" }],
                },
              ],
            },
            { "x-aimock-strict": strict ? "true" : "false" },
          );
          expect(got.status).toBe(strict ? 400 : 200);
          assertOverride(server.journal, strict ? true : undefined);
          expectGolden(suite, `${mount}-thinking-${strict}`, {
            got,
            journal: journalCapture(server.journal),
          });
        } finally {
          await server.close();
        }
      });
      it(`${mount} required-header rejection journal ${strict}`, async () => {
        const wire = wires[0];
        const server = await open(mount, wire, fixtures, {
          strict: !strict,
          policy: { requiredHeaders: "enforce" },
        });
        try {
          const got = await send(server, wire, body(wire, "text"), {
            "x-aimock-strict": String(strict),
          });
          expect(got.status).toBe(400);
          assertOverride(server.journal, strict);
          expect(server.journal.getLast()?.response.source).toBe("internal");
          expectGolden(suite, `${mount}-required-header-${strict}`, {
            got,
            journal: journalCapture(server.journal),
          });
        } finally {
          await server.close();
        }
      });
    }

  for (const wire of wires)
    for (const strict of [false, true]) {
      it(`${wire.id} local upstream eligibility ${strict}`, async () => {
        const upstream = await startStubUpstream((_req, res) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end('{"error":{"message":"Local upstream failure"}}');
        });
        const server = await open("source", wire, [], {
          strict,
          record: {
            providers: { anthropic: upstream.url, bedrock: upstream.url },
            proxyOnly: true,
          },
        });
        try {
          const got = await send(server, wire, body(wire, "miss"));
          expect(got.status).toBe(strict ? 503 : 502);
          expect(upstream.requests).toHaveLength(strict ? 0 : 1);
          expectGolden(suite, `${wire.id}-upstream-${strict}`, {
            got,
            upstreamHits: upstream.requests.length,
            journal: journalCapture(server.journal),
          });
        } finally {
          await server.close();
          await upstream.close();
        }
      });
      it(`${wire.id} skipped sequence miss ${strict}`, async () => {
        const server = await open(
          "source",
          wire,
          [{ match: { userMessage: "skip", sequenceIndex: 3 }, response: { content: "Answer" } }],
          { strict },
        );
        try {
          const got = await send(server, wire, body(wire, "skip"));
          expect(got.status).toBe(strict ? 503 : 404);
          expectGolden(suite, `${wire.id}-sequence-${strict}`, {
            got,
            journal: journalCapture(server.journal),
          });
        } finally {
          await server.close();
        }
      });
    }
});
