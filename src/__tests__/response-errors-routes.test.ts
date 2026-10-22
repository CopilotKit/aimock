import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidFixtureToolCallError } from "../helpers.js";
import type { Fixture } from "../types.js";
import {
  captureHttp,
  captureRawHttp,
  normalize,
  normalizeHeaders,
  serializeGolden,
  startGoldenServer,
  type CapturedExchange,
  type GoldenServer,
} from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    nodes.push(child, ...descendants(child));
  });
  return nodes;
}

describe("central error source ownership", () => {
  it("binds route serializers, callbacks and auth body to the shared renderer", () => {
    const program = ts.createProgram(
      [join(sourceRoot, "server.ts"), join(sourceRoot, "api-key-auth.ts")],
      {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        skipLibCheck: true,
      },
    );
    const checker = program.getTypeChecker();
    const owner = program.getSourceFile(join(sourceRoot, "response/errors.ts"));
    const ownerSymbol = owner && checker.getSymbolAtLocation(owner);
    const renderer =
      ownerSymbol && checker.getExportsOfModule(ownerSymbol).find((s) => s.name === "renderError");
    expect(renderer).toBeDefined();
    for (const file of ["server.ts", "api-key-auth.ts"]) {
      const source = program.getSourceFile(join(sourceRoot, file));
      if (!source) throw new Error(`Missing ${file}`);
      const delegates = descendants(source)
        .filter(ts.isCallExpression)
        .filter((call) => {
          const symbol = checker.getSymbolAtLocation(call.expression);
          return (
            symbol !== undefined &&
            (symbol.flags & ts.SymbolFlags.Alias) !== 0 &&
            checker.getAliasedSymbol(symbol) === renderer
          );
        });
      expect(delegates.length, file).toBeGreaterThanOrEqual(file === "server.ts" ? 18 : 1);
      const targets = descendants(source).filter(
        (node) =>
          (ts.isFunctionDeclaration(node) &&
            [
              "invalidToolArgumentsEnvelope",
              "invalidMisbehaviorHeaderEnvelope",
              "routeError",
            ].includes(node.name?.text ?? "")) ||
          (ts.isVariableDeclaration(node) && node.name.getText() === "API_KEY_ERROR_BODY"),
      );
      for (const target of targets) {
        const serializers = descendants(target)
          .filter(ts.isCallExpression)
          .filter((call) => call.expression.getText() === "JSON.stringify");
        expect(serializers.length, target.getText().slice(0, 80)).toBe(0);
      }
      for (const assignment of descendants(source).filter(ts.isPropertyAssignment)) {
        if (assignment.name.getText() === "streamEvent") {
          expect(
            descendants(assignment)
              .filter(ts.isCallExpression)
              .some((call) => call.expression.getText() === "JSON.stringify"),
          ).toBe(false);
        }
      }
    }
  });
});

function evidence(id: string, got: CapturedExchange) {
  const bytes = serializeGolden(got);
  if (process.env.E1_BASELINE_DIR)
    expect(bytes).toBe(readFileSync(join(process.env.E1_BASELINE_DIR, `${id}.json`), "utf8"));
  if (process.env.E1_CAPTURE_DIR) {
    mkdirSync(process.env.E1_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.E1_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

const toolMessage = "Invalid fixture tool call: name must be a non-empty string (toolCalls[0])";
const toolCode = "aimock_invalid_fixture_tool_call";
const routes = [
  { id: "openai", path: "/v1/chat/completions" },
  { id: "responses", path: "/v1/responses" },
  { id: "messages", path: "/v1/messages" },
  { id: "cohere", path: "/v2/chat" },
  { id: "ollama", path: "/api/chat" },
  { id: "ollama-generate", path: "/api/generate" },
  { id: "interactions", path: "/v1beta/interactions" },
  { id: "gemini", path: "/v1beta/models/gemini-2.5-flash:generateContent" },
  {
    id: "vertex",
    path: "/v1/projects/p/locations/l/publishers/google/models/gemini-2.5-flash:generateContent",
  },
  { id: "bedrock", path: "/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke" },
  {
    id: "bedrock-stream",
    path: "/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke-with-response-stream",
  },
  { id: "converse", path: "/model/anthropic.claude-3-5-sonnet-20241022-v2:0/converse" },
  {
    id: "converse-stream",
    path: "/model/anthropic.claude-3-5-sonnet-20241022-v2:0/converse-stream",
  },
  { id: "openrouter", path: "/api/v1/chat/completions" },
] as const;

function requestBody(text: string, id = "") {
  return JSON.stringify({
    model: "gpt-4o",
    max_tokens: 64,
    anthropic_version: "bedrock-2023-05-31",
    stream: false,
    messages: [{ role: "user", content: id.startsWith("converse") ? [{ text }] : text }],
    input: text,
    prompt: text,
    contents: [{ role: "user", parts: [{ text }] }],
  });
}

const fixtures: Fixture[] = [
  {
    match: {},
    response: {
      get toolCalls(): never {
        throw new InvalidFixtureToolCallError(0, "name must be a non-empty string");
      },
    },
  },
];
let server: GoldenServer;
let crash: GoldenServer;
let auth: GoldenServer;
let nativeAuth: GoldenServer;
beforeAll(async () => {
  server = await startGoldenServer(fixtures, { enableMisbehavior: true });
  crash = await startGoldenServer([
    {
      match: {},
      response: {
        get content(): never {
          throw new Error("route boom");
        },
      },
    },
  ]);
  auth = await startGoldenServer([], { auth: { apiKeys: ["good"] } });
  nativeAuth = await startGoldenServer([], {
    auth: { apiKeys: ["good"] },
    policy: { authErrors: "native" },
  });
});
afterAll(async () => {
  await server?.close();
  await crash?.close();
  await auth?.close();
  await nativeAuth?.close();
});

function expectedToolBody(id: string) {
  if (id === "ollama") return JSON.stringify({ error: toolMessage, code: toolCode });
  if (id === "interactions")
    return JSON.stringify({ error: { code: toolCode, message: toolMessage } });
  if (id === "gemini" || id === "vertex")
    return JSON.stringify({
      error: {
        code: 500,
        message: toolMessage,
        status: "INTERNAL",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "AIMOCK_INVALID_FIXTURE_TOOL_CALL",
            domain: "aimock",
            metadata: { code: toolCode },
          },
        ],
      },
    });
  if (id === "messages")
    return JSON.stringify({
      type: "error",
      error: { type: "api_error", code: toolCode, message: toolMessage },
    });
  if (id.startsWith("bedrock") || id.startsWith("converse"))
    return JSON.stringify({
      __type: "InternalServerException",
      message: toolMessage,
      reason: toolCode,
    });
  if (id === "openrouter")
    return JSON.stringify({
      error: { code: 500, message: toolMessage, metadata: { reason: toolCode } },
    });
  return JSON.stringify({ error: { message: toolMessage, type: "server_error", code: toolCode } });
}

function expectedMisbehaviorBody(id: string) {
  const message =
    'aimock_misbehavior_invalid: misbehavior/bad-value at headers.x-aimock-misbehavior: invalid value "typo"';
  const code = "aimock_misbehavior_invalid";
  if (id.startsWith("ollama")) return JSON.stringify({ error: message });
  if (id === "cohere") return JSON.stringify({ message });
  if (id === "interactions") return JSON.stringify({ error: { code, message } });
  if (id === "gemini" || id === "vertex")
    return JSON.stringify({ error: { code: 400, message, status: "INVALID_ARGUMENT" } });
  if (id === "messages")
    return JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", code, message },
    });
  if (id.startsWith("bedrock") || id.startsWith("converse"))
    return JSON.stringify({ __type: "ValidationException", message });
  return JSON.stringify({ error: { message, type: "invalid_request_error", code } });
}

describe("actual central route responses", () => {
  it.each(routes)("preserves $id tool callback", async ({ id, path }) => {
    const got = await captureHttp(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "e1-fixed" },
      body: requestBody("tool", id),
    });
    expect(got.status).toBe(500);
    expect(got.body).toBe(expectedToolBody(id));
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["access-control-allow-origin"]).toBe("*");
    expect(got.headers["x-request-id"]).toBe("e1-fixed");
    expect(got.body).not.toContain('"usage"');
    evidence(`tool-${id}`, got);
  });
  it.each(routes)("preserves $id route crash", async ({ id, path }) => {
    const got = await captureHttp(`${crash.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "e1-fixed" },
      body: requestBody("crash", id),
    });
    expect(got.status).toBe(500);
    expect(got.body).toBe(
      id === "openrouter"
        ? '{"error":{"code":500,"message":"route boom"}}'
        : '{"error":{"message":"route boom","type":"server_error"}}',
    );
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.body).not.toContain('"usage"');
    evidence(`crash-${id}`, got);
  });
  it.each(routes)("captures $id invalid misbehavior rejection", async ({ id, path }) => {
    const got = await captureHttp(`${server.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aimock-misbehavior": "typo",
        "x-request-id": "e1-fixed",
      },
      body: requestBody("reject"),
    });
    expect(got.status).toBe(400);
    expect(got.body).toBe(expectedMisbehaviorBody(id));
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["access-control-allow-origin"]).toBe("*");
    expect(got.body).not.toContain('"usage"');
    evidence(`misbehavior-${id}`, got);
  });
  it("preserves invalid request target rejection", async () => {
    const got = await captureRawHttp(
      server.url,
      "GET / HTTP/1.1\r\nHost: [invalid\r\nX-Request-Id: e1-fixed\r\nConnection: close\r\n\r\n",
    );
    expect(got.status).toBe(400);
    expect(got.body).toBe(
      '{"error":{"message":"Invalid request target","type":"invalid_request_error"}}',
    );
    evidence("invalid-target", got);
  });
});

const authBody =
  '{"error":{"message":"Invalid API key","type":"authentication_error","code":"invalid_api_key"}}';
describe("actual legacy auth bytes", () => {
  // Default contract from 1.45: every HTTP route keeps the string error.code.
  it.each(routes)("preserves $id auth", async ({ id, path }) => {
    const got = await captureHttp(`${auth.url}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer bad", "x-request-id": "e1-fixed" },
      body: requestBody("auth"),
    });
    expect(got.status).toBe(401);
    expect(got.body).toBe(authBody);
    expect(got.headers["content-length"]).toBe(String(Buffer.byteLength(authBody)));
    expect(got.headers).not.toHaveProperty("request-id");
    expect(got.headers["www-authenticate"]).toBe('Bearer realm="aimock"');
    evidence(`auth-${id}`, got);
  });
  it.each(routes)(
    "returns $id native auth only with policy authErrors=native",
    async ({ id, path }) => {
      const got = await captureHttp(`${nativeAuth.url}${path}`, {
        method: "POST",
        headers: { authorization: "Bearer bad", "x-request-id": "e1-fixed" },
        body: requestBody("auth"),
      });
      expect(got.status).toBe(401);
      const expectedBody =
        id === "messages"
          ? '{"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}'
          : id === "interactions" || id === "gemini" || id === "vertex"
            ? '{"error":{"code":401,"message":"Invalid API key","status":"UNAUTHENTICATED"}}'
            : authBody;
      expect(got.body).toBe(expectedBody);
      expect(got.headers["content-length"]).toBe(String(Buffer.byteLength(expectedBody)));
      if (id === "messages") expect(got.headers["request-id"]).toMatch(/^req_<#\d+>$/);
      else if (id === "interactions" || id === "gemini" || id === "vertex")
        expect(got.headers).not.toHaveProperty("request-id");
      expect(got.headers["www-authenticate"]).toBe('Bearer realm="aimock"');
    },
  );
  it.each([
    "/v1/realtime",
    "/v1/responses",
    "/v1/live",
    "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  ])("preserves upgrade auth at %s", async (path) => {
    const got = await captureRawHttp(
      auth.url,
      `GET ${path} HTTP/1.1\r\nHost: golden\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer bad\r\n\r\n`,
    );
    expect(got.status).toBe(401);
    expect(got.body).toBe(authBody);
    expect(got.headers).toEqual({
      "content-length": "94",
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="aimock"',
    });
    evidence(`auth-upgrade-${path.split("/").join("_")}`, got);
  });
});

describe("actual stream failure frames", () => {
  it.each(
    routes.filter(({ id }) =>
      [
        "openai",
        "messages",
        "cohere",
        "responses",
        "interactions",
        "gemini",
        "vertex",
        "openrouter",
      ].includes(id),
    ),
  )("preserves $id terminal callback", async ({ id, path }) => {
    const streaming = await startGoldenServer([
      {
        match: {},
        response: { content: "one two three four five six seven eight", id: "e1-stream-fixed" },
        streamingProfile: {
          ttft: 0,
          get tps(): never {
            throw new Error("mid-stream boom");
          },
        },
      },
    ]);
    try {
      const got = await new Promise<{
        status: number;
        body: string;
        headers: Record<string, string>;
        aborted: boolean;
      }>((resolve, reject) => {
        const streamPath = path.replace(":generateContent", ":streamGenerateContent");
        const req = http.request(
          `${streaming.url}${streamPath}`,
          { method: "POST", headers: { "content-type": "application/json" } },
          (res) => {
            const chunks: Buffer[] = [];
            const headerEntries: [string, string][] = [];
            for (let index = 0; index < res.rawHeaders.length; index += 2) {
              headerEntries.push([res.rawHeaders[index], res.rawHeaders[index + 1]]);
            }
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            const finish = () =>
              resolve({
                status: res.statusCode ?? 0,
                body: normalize(Buffer.concat(chunks).toString("utf8")),
                headers: normalizeHeaders(headerEntries),
                aborted: !res.complete,
              });
            res.on("end", finish);
            res.on("aborted", finish);
            res.on("error", finish);
          },
        );
        req.on("error", reject);
        req.end(requestBody("stream", id).replace('"stream":false', '"stream":true'));
      });
      expect(got.status).toBe(200);
      expect(got.aborted).toBe(true);
      expect(got.headers["content-type"]).toMatch(/^text\/event-stream/);
      expect(got.headers["access-control-allow-origin"]).toBe("*");
      const error =
        id === "openrouter"
          ? '{"error":{"code":500,"message":"mid-stream boom"}}'
          : id === "openai"
            ? '{"error":{"message":"mid-stream boom","type":"server_error"}}'
            : '{"error":{"message":"mid-stream boom"}}';
      const event = ["messages", "cohere", "responses"].includes(id) ? "event: error\n" : "";
      expect(got.body.endsWith(`${event}data: ${error}\n\n`)).toBe(true);
      expect(got.body).not.toContain("[DONE]");
      expect(streaming.instance.journal.getLast()?.response.interruptReason).toBe(
        "handler crashed mid-stream",
      );
      evidence(`stream-${id}`, { status: got.status, headers: got.headers, body: got.body });
    } finally {
      await streaming.close();
    }
  });
});
