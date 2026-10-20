import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { resetEventIdCounter, resetInteractionCounter } from "../gemini-interactions.js";
import { createServer } from "../server.js";
import type { Journal } from "../journal.js";
import type { Fixture, MockServerOptions } from "../types.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  startStubUpstream,
} from "./golden/harness.js";
import { readLiveCase, runLiveScenario } from "./live-test-support.js";
import { connectWebSocket } from "./ws-test-client.js";
import { createServer as createMisbehaviorServer } from "./helpers/misbehavior-enabled.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

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
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return [];
    return bindings.elements
      .filter((binding) => (binding.propertyName ?? binding.name).text === name)
      .map((binding) => checker.getSymbolAtLocation(binding.name));
  });
  return descendants(file).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      symbols.includes(checker.getSymbolAtLocation(node.expression)),
  );
}

describe("A3 compiler-bound policy ownership", () => {
  it.each([
    ["gemini.ts", 6, 2],
    ["gemini-interactions.ts", 1, 2],
    ["ws-gemini-live.ts", 1, 2],
    ["ws-live.ts", 1, 2],
  ] as const)("%s uses shared policy at every original read site", (name, count, journals) => {
    const path = join(sourceRoot, name);
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const file = program.getSourceFile(path)!;
    const checker = program.getTypeChecker();
    expect(boundCalls(file, checker, "helpers.ts", "resolveStrictMode")).toHaveLength(0);
    expect(boundCalls(file, checker, "helpers.ts", "strictOverrideField")).toHaveLength(0);
    const calls = boundCalls(file, checker, "response/policy.ts", "resolveRequestDecisions");
    expect(calls).toHaveLength(count);
    for (const call of calls) {
      expect(call.arguments[0]?.getText(file)).toBe("defaults.strict");
      expect(call.arguments[1]?.getText(file)).toBe(
        name === "ws-gemini-live.ts"
          ? "defaults.upgradeHeaders"
          : name === "ws-live.ts"
            ? "options.headers"
            : "req.headers",
      );
      expect(
        ts.isPropertyAccessExpression(call.parent) || ts.isVariableDeclaration(call.parent),
      ).toBe(true);
    }
    expect(boundCalls(file, checker, "response/policy.ts", "strictOverrideField")).toHaveLength(
      journals,
    );
  });
});

describe("A3 compiler-bound common error ownership", () => {
  it.each(["gemini.ts", "gemini-interactions.ts"])(
    "%s delegates all eight chat error purposes",
    (name) => {
      const path = join(sourceRoot, name);
      const program = ts.createProgram([path], { noResolve: true, noLib: true });
      const file = program.getSourceFile(path)!;
      const calls = boundCalls(file, program.getTypeChecker(), "response/errors.ts", "renderError");
      expect(calls).toHaveLength(8);
      expect(calls.map((call) => call.arguments[1]?.getText(file))).toEqual([
        '"validation"',
        '"validation"',
        '"validation"',
        '"strict-miss"',
        '"fixture-miss"',
        '"misbehavior"',
        '"fixture"',
        '"unknown-response"',
      ]);
      expect(
        descendants(file).filter(
          (node) =>
            ts.isPropertyAssignment(node) &&
            node.name.getText(file) === "error" &&
            ts.isObjectLiteralExpression(node.initializer),
        ),
      ).toHaveLength(0);
    },
  );
});

function evidence(id: string, value: unknown) {
  const bytes = serializeGolden(value);
  if (process.env.A3_BASELINE_DIR)
    expect(bytes).toBe(readFileSync(join(process.env.A3_BASELINE_DIR, `${id}.json`), "utf8"));
  if (process.env.A3_CAPTURE_DIR) {
    mkdirSync(process.env.A3_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.A3_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

function journal(source: Journal) {
  return source.getAll().map((entry) => ({
    ...entry,
    headers: {
      ...entry.headers,
      ...(entry.headers.host ? { host: "<ephemeral-host>" } : {}),
      ...(entry.headers["sec-websocket-key"] ? { "sec-websocket-key": "<handshake-key>" } : {}),
    },
  }));
}

// Direct creation retains the mutable configuration object, whereas the
// generic golden helper copies options. This pins actual strict read timing.
async function mutableServer(fixtures: Fixture[], options: MockServerOptions, misbehavior = false) {
  const instance = await (misbehavior ? createMisbehaviorServer : createServer)(fixtures, options);
  return {
    instance,
    url: instance.url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        instance.closeLiveSessions();
        instance.server.close((error) => (error ? reject(error) : resolve()));
        instance.server.closeAllConnections();
      }),
  };
}
const routes = {
  gemini: "/v1beta/models/gemini-2.0-flash:generateContent",
  vertex:
    "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent",
  interactions: "/v1beta/interactions",
} as const;
type Wire = keyof typeof routes;
function request(wire: Wire, text: string, streaming = false) {
  return wire === "interactions"
    ? { model: "gemini-2.0-flash", input: text, stream: streaming }
    : { contents: [{ role: "user", parts: [{ text }] }] };
}
function route(wire: Wire, streaming: boolean) {
  return streaming && wire !== "interactions"
    ? routes[wire].replace(":generateContent", ":streamGenerateContent?alt=sse")
    : routes[wire];
}

describe("A3 real HTTP policy/error equivalence", () => {
  for (const wire of ["gemini", "vertex", "interactions"] as const) {
    it(`${wire} strict grammar and mutable request defaults`, async () => {
      const config: MockServerOptions = { strict: false, logLevel: "silent" };
      const server = await mutableServer([], config);
      try {
        for (const [index, [strict, header, status]] of [
          [false, undefined, 404],
          [false, " TRUE ", 503],
          [true, "0", 404],
          [true, "invalid", 503],
          [false, "invalid", 404],
          [true, undefined, 503],
        ].entries()) {
          config.strict = strict === true;
          const got = await captureHttp(`${server.url}${routes[wire]}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-test-id": `a3-${wire}-${index}`,
              ...(typeof header === "string" ? { "x-aimock-strict": header } : {}),
            },
            body: JSON.stringify(request(wire, "miss")),
          });
          expect(got.status).toBe(status);
          evidence(`${wire}-strict-${index}`, {
            exchange: got,
            journal: journal(server.instance.journal),
          });
        }
      } finally {
        await server.close();
      }
    });

    it(`${wire} validation/fixture errors preserve native bytes and retry headers`, async () => {
      const server = await startGoldenServer([
        {
          match: { userMessage: "fail" },
          response: {
            error: { message: "Limited", type: "RESOURCE_EXHAUSTED" },
            status: 429,
            retryAfter: 7,
          },
        },
        { match: { userMessage: "default-error" }, response: { error: { message: "Default" } } },
        { match: { userMessage: "unknown" }, response: () => ({ json: { unsupported: true } }) },
      ]);
      try {
        for (const [id, body] of [
          ["malformed", "{"],
          ["nonobject", "null"],
          ["shape", JSON.stringify(wire === "interactions" ? { input: 42 } : { contents: "bad" })],
          ["fixture", JSON.stringify(request(wire, "fail"))],
          ["fixture-default", JSON.stringify(request(wire, "default-error"))],
          ["unknown", JSON.stringify(request(wire, "unknown"))],
        ]) {
          const got = await captureHttp(`${server.url}${routes[wire]}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          expect(got.status).toBe(
            id === "fixture" ? 429 : id === "fixture-default" || id === "unknown" ? 500 : 400,
          );
          evidence(`${wire}-${id}`, { exchange: got, journal: journal(server.instance.journal) });
        }
      } finally {
        await server.close();
      }
    });

    it(`${wire} native misbehavior error purposes remain byte-identical`, async () => {
      const server = await mutableServer(
        [
          {
            match: { userMessage: "refusal" },
            response: { content: "Answer" },
            misbehavior: { faults: [{ fault: "refusal", rate: 0 }] },
          },
        ],
        { logLevel: "silent" },
        true,
      );
      try {
        const got = await captureHttp(`${server.url}${routes[wire]}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request(wire, "refusal")),
        });
        expect(got.status).toBe(501);
        evidence(`${wire}-misbehavior`, {
          exchange: got,
          journal: journal(server.instance.journal),
        });
      } finally {
        await server.close();
      }
    });

    for (const streaming of [false, true]) {
      it(`${wire} ${streaming ? "SSE" : "JSON"} reasoning and late configuration reads`, async () => {
        const config: MockServerOptions = { strict: false, logLevel: "silent" };
        const server = await mutableServer(
          [
            {
              match: { userMessage: "reason" },
              response: { content: "Answer", reasoning: "Think" },
            },
            {
              match: { userMessage: "late" },
              response: async () => {
                config.strict = true;
                return { content: "Answer", reasoning: "Think" };
              },
            },
          ],
          config,
        );
        try {
          for (const text of ["reason", "late"]) {
            config.strict = false;
            resetEventIdCounter();
            resetInteractionCounter();
            const got = await captureHttp(`${server.url}${route(wire, streaming)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request(wire, text, streaming)),
              frames: streaming ? "sse" : undefined,
            });
            expect(got.status).toBe(200);
            evidence(`${wire}-${streaming ? "sse" : "json"}-${text}`, {
              exchange: got,
              journal: journal(server.instance.journal),
            });
          }
        } finally {
          await server.close();
        }
      });
    }

    it(`${wire} strict suppresses real proxy; false override relays actual upstream bytes`, async () => {
      const upstream = await startStubUpstream((_req, res) => {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "9",
          "x-native": "kept",
        });
        res.end('{"error":{"code":429,"message":"Upstream limit","status":"RESOURCE_EXHAUSTED"}}');
      });
      const directory = mkdtempSync(join(tmpdir(), "a3-record-"));
      const server = await startGoldenServer([], {
        strict: true,
        record: {
          providers: { [wire === "vertex" ? "vertexai" : "gemini"]: upstream.url },
          fixturePath: directory,
        },
      });
      try {
        for (const header of ["true", "false"]) {
          const got = await captureHttp(`${server.url}${routes[wire]}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-aimock-strict": header,
              "x-goog-api-key": "a3-local",
              authorization: "Bearer a3-local",
            },
            body: JSON.stringify(request(wire, "proxy")),
          });
          expect(got.status).toBe(header === "true" ? 503 : 502);
          evidence(`${wire}-proxy-${header}`, {
            exchange: got,
            journal: journal(server.instance.journal),
            upstreamCalls: upstream.requests.length,
          });
        }
        expect(upstream.requests).toHaveLength(1);
      } finally {
        await server.close();
        await upstream.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

const geminiLivePath =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
function geminiTurn(text: string) {
  return JSON.stringify({
    clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
  });
}
describe("A3 real live WebSocket policy equivalence", () => {
  for (const strict of [false, true]) {
    it(`Gemini Live preserves upgrade snapshot and strict ${strict} miss`, async () => {
      const config: MockServerOptions = { strict, logLevel: "silent" };
      const server = await mutableServer([], config);
      const ws = await connectWebSocket(server.url, geminiLivePath);
      try {
        ws.send(JSON.stringify({ setup: { model: "gemini-2.0-flash" } }));
        await ws.waitForMessages(1);
        config.strict = !strict;
        ws.send(geminiTurn("miss"));
        const close = strict ? await ws.waitForCloseFrame() : undefined;
        if (!strict) await ws.waitForMessages(2);
        evidence(`gemini-live-snapshot-${strict}`, {
          frames: ws.getMessages(),
          close,
          journal: journal(server.instance.journal),
        });
        expect(server.instance.journal.getAll()[0].response.status).toBe(strict ? 503 : 404);
      } finally {
        ws.destroy();
        await server.close();
      }
    });
    it(`OpenAI Live reads mutable defaults at session startup (${strict})`, async () => {
      const config: MockServerOptions = { strict: !strict, logLevel: "silent" };
      const server = await mutableServer([], config);
      const ws = await connectWebSocket(server.url, "/v1/live/sessions", {
        "x-test-id": "a3-live",
      });
      try {
        config.strict = strict;
        ws.send(JSON.stringify(readLiveCase("client").transcript.entries[0].event));
        const close = await ws.waitForCloseFrame();
        evidence(`openai-live-start-${strict}`, {
          frames: ws.getMessages(),
          close,
          journal: journal(server.instance.journal),
        });
        expect(server.instance.journal.getAll()).toHaveLength(strict ? 1 : 0);
      } finally {
        ws.destroy();
        await server.close();
      }
    });
  }
  it("Gemini Live false upgrade override preserves fixture/error/miss events", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi" } },
      {
        match: { userMessage: "fail" },
        response: { error: { message: "Limited", type: "RESOURCE_EXHAUSTED" }, status: 429 },
      },
    ];
    const server = await startGoldenServer(fixtures, { strict: true });
    const ws = await connectWebSocket(server.url, geminiLivePath, { "x-aimock-strict": "false" });
    try {
      ws.send(JSON.stringify({ setup: { model: "gemini-2.0-flash" } }));
      await ws.waitForMessages(1);
      ws.send(geminiTurn("hello"));
      await ws.waitForMessages(3);
      ws.send(geminiTurn("fail"));
      await ws.waitForMessages(4);
      ws.send(geminiTurn("miss"));
      await ws.waitForMessages(5);
      evidence("gemini-live-events", {
        frames: ws.getMessages(),
        journal: journal(server.instance.journal),
      });
      expect(server.instance.journal.getAll().map((entry) => entry.response.status)).toEqual([
        200, 429, 404,
      ]);
    } finally {
      ws.destroy();
      await server.close();
    }
  });
  it("OpenAI Live false upgrade override proxies a real complete session", async () => {
    const { transcript } = readLiveCase("client");
    for (const entry of transcript.entries) entry.atMs = Math.floor(entry.atMs / 100);
    const upstream = await startGoldenServer([
      {
        match: { endpoint: "openai-live" },
        response: { live: transcript, liveTiming: "immediate" },
      },
    ]);
    const directory = mkdtempSync(join(tmpdir(), "a3-live-record-"));
    const server = await startGoldenServer([], {
      strict: true,
      record: { providers: { openai: upstream.url }, fixturePath: directory },
    });
    const ws = await connectWebSocket(server.url, "/v1/live/sessions", {
      "x-aimock-strict": "false",
    });
    try {
      const result = await runLiveScenario(ws, transcript, {
        clientIdPrefix: "a3-live",
        timeoutMs: 5000,
      });
      evidence("openai-live-proxy", {
        frames: result.normalized,
        journal: journal(server.instance.journal),
      });
      expect(upstream.instance.journal.getAll()).toHaveLength(1);
    } finally {
      ws.destroy();
      await server.close();
      await upstream.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
});
