import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isJsonObject } from "../helpers.js";
import type { Fixture } from "../types.js";
import {
  captureHttp,
  captureRawHttp,
  serializeGolden,
  startGoldenServer,
  type GoldenServer,
} from "./golden/harness.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    nodes.push(child, ...descendants(child));
  });
  return nodes;
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
      symbols.some((symbol) => symbol && symbol === checker.getSymbolAtLocation(node.expression)),
  );
}

describe("A2 source ownership", () => {
  for (const [relative, decisions, errors] of [
    ["responses.ts", 4, 7],
    ["ws-responses.ts", 2, 1],
    ["ws-realtime.ts", 2, 4],
  ] as const) {
    it(`${relative} binds named policy decisions and common errors to their owners`, () => {
      const path = join(sourceRoot, relative);
      const program = ts.createProgram([path], { noResolve: true, noLib: true });
      const file = program.getSourceFile(path);
      if (!file) throw new Error(`Missing source ${relative}`);
      const checker = program.getTypeChecker();
      expect(boundCalls(file, checker, "helpers.ts", "resolveStrictMode")).toHaveLength(0);
      expect(boundCalls(file, checker, "helpers.ts", "strictOverrideField")).toHaveLength(0);
      expect(
        boundCalls(file, checker, "response/policy.ts", "resolveRequestDecisions"),
      ).toHaveLength(decisions);
      expect(boundCalls(file, checker, "response/policy.ts", "strictOverrideField")).toHaveLength(
        relative === "ws-realtime.ts" ? 4 : 2,
      );
      const owner = relative === "responses.ts" ? "renderError" : "buildOpenAIError";
      const calls = boundCalls(file, checker, "response/errors.ts", owner);
      expect(calls).toHaveLength(errors);
      expect(
        calls.map((call) => ts.findAncestor(call, ts.isFunctionDeclaration)?.name?.text),
      ).toEqual(
        relative === "responses.ts"
          ? Array(7).fill("handleResponses")
          : relative === "ws-responses.ts"
            ? ["buildErrorEvent"]
            : ["buildErrorRealtimeEvent", "processMessage", "processMessage", "processMessage"],
      );
    });
  }
});

function evidence(id: string, value: unknown) {
  const bytes = serializeGolden(value);
  if (process.env.A2_BASELINE_DIR)
    expect(bytes).toBe(readFileSync(join(process.env.A2_BASELINE_DIR, `${id}.json`), "utf8"));
  if (process.env.A2_CAPTURE_DIR) {
    mkdirSync(process.env.A2_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.A2_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

const fixtures: Fixture[] = [
  { match: { userMessage: "text" }, response: { content: "Answer", reasoning: "Reason" } },
  {
    match: { userMessage: "tool" },
    response: { toolCalls: [{ name: "lookup", arguments: "{}" }], reasoning: "Reason" },
  },
  {
    match: { userMessage: "combined" },
    response: {
      content: "Answer",
      toolCalls: [{ name: "lookup", arguments: "{}" }],
      reasoning: "Reason",
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

const overrides = [
  { id: "default-lenient", strict: false, header: undefined, status: 404, override: undefined },
  { id: "default-strict", strict: true, header: undefined, status: 503, override: undefined },
  { id: "header-true", strict: false, header: " TrUe ", status: 503, override: true },
  { id: "header-false", strict: true, header: " 0 ", status: 404, override: false },
  { id: "header-invalid", strict: true, header: "invalid", status: 503, override: undefined },
] as const;

function journal(server: GoldenServer) {
  return server.instance.journal.getAll().map((entry) => ({
    method: entry.method,
    path: entry.path,
    body: entry.body,
    strictHeader: entry.headers["x-aimock-strict"],
    response: entry.response,
    responseKeys: Object.keys(entry.response),
  }));
}

function assertOverride(server: GoldenServer, override: boolean | undefined) {
  const entry = server.instance.journal.getLast();
  expect(entry).not.toBeNull();
  expect(entry?.response.strictOverride).toBe(override);
  expect(Object.prototype.hasOwnProperty.call(entry?.response ?? {}, "strictOverride")).toBe(
    override !== undefined,
  );
}

async function until(client: WSTestClient, terminal: string) {
  for (let count = client.getMessages().length + 1; count < 100; count++) {
    const frames = await client.waitForMessages(count);
    const last: unknown = JSON.parse(frames.at(-1)!);
    if (isJsonObject(last) && last.type === terminal) return frames;
  }
  throw new Error(`Missing terminal ${terminal}`);
}

async function withWs(
  server: GoldenServer,
  path: string,
  headers: Record<string, string>,
  run: (client: WSTestClient) => Promise<void>,
) {
  const client = await connectWebSocket(server.url, path, headers);
  try {
    await run(client);
  } finally {
    client.close();
    await client.waitForClose();
  }
}

async function prepareRealtime(client: WSTestClient, text: string) {
  await client.waitForMessages(1);
  client.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    }),
  );
  await client.waitForMessages(2);
}

describe("A2 actual HTTP and WebSocket equivalence", () => {
  for (const setting of overrides) {
    it(`HTTP miss ${setting.id}`, async () => {
      const server = await startGoldenServer([], { strict: setting.strict });
      try {
        const got = await captureHttp(`${server.url}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(setting.header === undefined ? {} : { "x-aimock-strict": setting.header }),
          },
          body: JSON.stringify({ model: "gpt-4", input: "miss" }),
        });
        expect(got.status).toBe(setting.status);
        assertOverride(server, setting.override);
        evidence(`http-miss-${setting.id}`, { got, journal: journal(server) });
      } finally {
        await server.close();
      }
    });
    for (const wire of ["responses", "realtime", "transcription"] as const) {
      it(`${wire} miss ${setting.id}`, async () => {
        const server = await startGoldenServer([], { strict: setting.strict });
        try {
          await withWs(
            server,
            wire === "responses"
              ? "/v1/responses"
              : wire === "transcription"
                ? "/v1/realtime?intent=transcription"
                : "/v1/realtime",
            setting.header === undefined ? {} : { "x-aimock-strict": setting.header },
            async (client) => {
              if (wire === "realtime") await prepareRealtime(client, "miss");
              if (wire === "transcription") {
                await client.waitForMessages(1);
                client.send(
                  JSON.stringify({
                    type: "transcription_session.update",
                    session: { input_audio_transcription: { model: "whisper-1" } },
                  }),
                );
                await client.waitForMessages(2);
              }
              client.send(
                JSON.stringify(
                  wire === "responses"
                    ? {
                        type: "response.create",
                        model: "gpt-4",
                        input: [{ role: "user", content: "miss" }],
                      }
                    : {
                        type:
                          wire === "transcription"
                            ? "input_audio_buffer.commit"
                            : "response.create",
                      },
                ),
              );
              const close = setting.status === 503 ? await client.waitForCloseFrame() : undefined;
              if (close) expect(close.code).toBe(1008);
              else
                await until(
                  client,
                  wire === "responses"
                    ? "error"
                    : wire === "transcription"
                      ? "conversation.item.input_audio_transcription.failed"
                      : "response.done",
                );
              assertOverride(server, setting.override);
              evidence(`${wire}-miss-${setting.id}`, {
                frames: client.getMessages(),
                close,
                journal: journal(server),
              });
            },
          );
        } finally {
          await server.close();
        }
      });
    }
  }

  for (const [id, body, status] of [
    ["malformed", "{", 400],
    ["null", "null", 400],
    ["input-invalid", '{"model":"gpt-4","input":3}', 400],
    ["fixture-error", '{"model":"gpt-4","input":"error"}', 429],
  ] as const) {
    it(`HTTP ${id}`, async () => {
      const server = await startGoldenServer(fixtures);
      try {
        const got = await captureHttp(`${server.url}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(got.status).toBe(status);
        evidence(`http-${id}`, { got, journal: journal(server) });
      } finally {
        await server.close();
      }
    });
  }

  for (const strict of [false, true])
    for (const shape of ["text", "tool", "combined"])
      for (const wire of ["http", "stream", "responses"] as const) {
        it(`${wire} reasoning ${shape} strict=${strict}`, async () => {
          const server = await startGoldenServer(fixtures, { strict });
          try {
            const request = { model: "gpt-4", input: [{ role: "user", content: shape }] };
            if (wire !== "responses") {
              const got = await captureHttp(`${server.url}/v1/responses`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ...request, stream: wire === "stream" }),
                frames: wire === "stream" ? "sse" : undefined,
              });
              expect(got.status).toBe(200);
              evidence(`${wire}-reasoning-${shape}-${strict}`, { got, journal: journal(server) });
            } else
              await withWs(server, "/v1/responses", {}, async (client) => {
                client.send(JSON.stringify({ type: "response.create", ...request }));
                const frames = await until(client, "response.completed");
                evidence(`${wire}-reasoning-${shape}-${strict}`, {
                  frames,
                  journal: journal(server),
                });
              });
          } finally {
            await server.close();
          }
        });
      }

  for (const wire of ["responses", "realtime"] as const)
    for (const scenario of [
      "malformed",
      "wrong-type",
      "fixture-error",
      "misbehavior-invalid",
      "misbehavior-inapplicable",
    ] as const) {
      if (wire === "realtime" && scenario === "wrong-type") continue;
      it(`${wire} ${scenario}`, async () => {
        const scoped: Fixture[] = fixtures.map((fixture) =>
          fixture.match.userMessage !== "text"
            ? fixture
            : {
                ...fixture,
                ...(scenario === "misbehavior-invalid"
                  ? { misbehavior: { faults: [{ fault: "empty-response", rate: -1 }] } }
                  : scenario === "misbehavior-inapplicable"
                    ? { misbehavior: { faults: [{ fault: "tool-args-invalid-json" }] } }
                    : {}),
              },
        );
        const server = await startGoldenServer(scoped, { enableMisbehavior: true });
        try {
          await withWs(server, `/v1/${wire}`, {}, async (client) => {
            if (wire === "realtime")
              await prepareRealtime(client, scenario === "fixture-error" ? "error" : "text");
            client.send(
              scenario === "malformed"
                ? "{"
                : JSON.stringify({
                    type: scenario === "wrong-type" ? "unknown" : "response.create",
                    model: "gpt-4",
                    input: [
                      { role: "user", content: scenario === "fixture-error" ? "error" : "text" },
                    ],
                  }),
            );
            const frames = await until(
              client,
              wire === "realtime" && scenario === "fixture-error" ? "response.done" : "error",
            );
            evidence(`${wire}-${scenario}`, { frames, journal: journal(server) });
          });
        } finally {
          await server.close();
        }
      });
    }

  for (const header of ["typo", "tool-args-invalid-json"]) {
    it(`HTTP misbehavior ${header}`, async () => {
      const server = await startGoldenServer(fixtures, { enableMisbehavior: true });
      try {
        const got = await captureHttp(`${server.url}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-aimock-misbehavior": header },
          body: JSON.stringify({ model: "gpt-4", input: "text" }),
        });
        expect(got.status).toBe(header === "typo" ? 400 : 501);
        evidence(`http-misbehavior-${header}`, { got, journal: journal(server) });
      } finally {
        await server.close();
      }
    });
  }
  for (const [id, session] of [
    ["invalid-type", { type: "invalid" }],
    ["translation-model", { type: "translation", model: "gpt-4" }],
    ["transcription-model", { type: "transcription", model: "gpt-4" }],
  ] as const) {
    it(`Realtime session ${id}`, async () => {
      const server = await startGoldenServer([]);
      try {
        await withWs(server, "/v1/realtime", {}, async (client) => {
          await client.waitForMessages(1);
          client.send(JSON.stringify({ type: "session.update", session }));
          const frames = await until(client, "error");
          evidence(`realtime-session-${id}`, frames);
        });
      } finally {
        await server.close();
      }
    });
  }
  for (const response of [
    { error: { message: "Audio limited", type: "rate_limit_error", code: "limited" }, status: 429 },
    { content: "Wrong shape" },
  ] as const) {
    it(`Realtime transcription fixture ${"error" in response ? "error" : "wrong-shape"}`, async () => {
      const server = await startGoldenServer([
        { match: { endpoint: "realtime-transcription" }, response },
      ]);
      try {
        await withWs(server, "/v1/realtime?intent=transcription", {}, async (client) => {
          await client.waitForMessages(1);
          client.send(
            JSON.stringify({
              type: "transcription_session.update",
              session: { input_audio_transcription: { model: "whisper-1" } },
            }),
          );
          await client.waitForMessages(2);
          client.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          const frames = await until(client, "conversation.item.input_audio_transcription.failed");
          evidence(`realtime-transcription-${"error" in response ? "error" : "wrong-shape"}`, {
            frames,
            journal: journal(server),
          });
        });
      } finally {
        await server.close();
      }
    });
  }
  for (const path of ["/v1/responses", "/v1/realtime"]) {
    it(`HTTP/WS authentication ${path}`, async () => {
      const server = await startGoldenServer([], { auth: { apiKeys: ["good"] } });
      try {
        const got = await captureRawHttp(
          server.url,
          [
            `GET ${path} HTTP/1.1`,
            "Host: golden",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "Authorization: Bearer bad",
            "",
            "",
          ].join("\r\n"),
        );
        expect(got.status).toBe(401);
        evidence(`auth-${path.slice(4)}`, got);
      } finally {
        await server.close();
      }
    });
  }
});
