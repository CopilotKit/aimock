import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeErrorResponse } from "../helpers.js";
import {
  buildOpenAIError,
  renderError,
  type ErrorDetails,
  type ErrorPurpose,
} from "../response/errors.js";
import type { ErrorWire } from "../response/profiles.js";
import type { ErrorResponse, Fixture } from "../types.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  startStubUpstream,
  type GoldenServer,
} from "./golden/harness.js";
import { connectWebSocket } from "./ws-test-client.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

const completionContracts: {
  wire: ErrorWire;
  purpose: ErrorPurpose;
  details: ErrorDetails;
  body: string;
}[] = [
  {
    wire: "openai",
    purpose: "validation",
    details: { message: "Invalid", code: "invalid_json" },
    body: '{"error":{"message":"Invalid","type":"invalid_request_error","code":"invalid_json"}}',
  },
  {
    wire: "openai",
    purpose: "strict-miss",
    details: { message: "Miss", code: "no_fixture_match" },
    body: '{"error":{"message":"Miss","type":"invalid_request_error","code":"no_fixture_match"}}',
  },
  {
    wire: "openai",
    purpose: "fixture-miss",
    details: { message: "Miss", code: null },
    body: '{"error":{"message":"Miss","type":"invalid_request_error","code":null}}',
  },
  {
    wire: "openai",
    purpose: "validation",
    details: { message: "Invalid", type: "", code: "" },
    body: '{"error":{"message":"Invalid","type":"","code":""}}',
  },
  {
    wire: "openai",
    purpose: "validation",
    details: { message: "Invalid" },
    body: '{"error":{"message":"Invalid","type":"invalid_request_error"}}',
  },
  {
    wire: "openai",
    purpose: "misbehavior",
    details: { message: "Fault", type: "api_error", code: "fault" },
    body: '{"error":{"message":"Fault","type":"api_error","code":"fault"}}',
  },
  {
    wire: "gemini",
    purpose: "validation",
    details: { message: "Invalid", bodyCode: 400, status: "INVALID_ARGUMENT" },
    body: '{"error":{"message":"Invalid","code":400,"status":"INVALID_ARGUMENT"}}',
  },
  {
    wire: "gemini",
    purpose: "strict-miss",
    details: { message: "Miss", bodyCode: 404, status: "NOT_FOUND" },
    body: '{"error":{"message":"Miss","code":404,"status":"NOT_FOUND"}}',
  },
  {
    wire: "gemini",
    purpose: "fixture-miss",
    details: { message: "Miss", bodyCode: 404, status: "NOT_FOUND" },
    body: '{"error":{"message":"Miss","code":404,"status":"NOT_FOUND"}}',
  },
  {
    wire: "gemini",
    purpose: "unknown-response",
    details: { message: "Unknown", bodyCode: 500, status: "INTERNAL" },
    body: '{"error":{"message":"Unknown","code":500,"status":"INTERNAL"}}',
  },
  {
    wire: "gemini",
    purpose: "fixture",
    details: { message: "Limited", bodyCode: 429, status: "RESOURCE_EXHAUSTED" },
    body: '{"error":{"code":429,"message":"Limited","status":"RESOURCE_EXHAUSTED"}}',
  },
  {
    wire: "gemini",
    purpose: "fixture",
    details: { message: "Empty", bodyCode: 0, status: "" },
    body: '{"error":{"code":0,"message":"Empty","status":""}}',
  },
  {
    wire: "gemini",
    purpose: "misbehavior",
    details: { message: "Fault", bodyCode: 501, status: "NOT_IMPLEMENTED" },
    body: '{"error":{"code":501,"message":"Fault","status":"NOT_IMPLEMENTED"}}',
  },
  ...(
    [
      "validation",
      "strict-miss",
      "fixture-miss",
      "fixture",
      "misbehavior",
      "unknown-response",
    ] as const
  ).map((purpose) => ({
    wire: "interactions" as const,
    purpose,
    details: { message: "Invalid" },
    body: '{"error":{"code":"INVALID_ARGUMENT","message":"Invalid"}}',
  })),
  {
    wire: "interactions",
    purpose: "fixture",
    details: { message: "Empty", code: "" },
    body: '{"error":{"code":"","message":"Empty"}}',
  },
  {
    wire: "interactions",
    purpose: "misbehavior",
    details: { message: "Null", code: null },
    body: '{"error":{"code":"INVALID_ARGUMENT","message":"Null"}}',
  },
  {
    wire: "interactions",
    purpose: "tool-argument",
    details: { message: "Missing" },
    body: '{"error":{"message":"Missing"}}',
  },
  {
    wire: "interactions",
    purpose: "invalid-misbehavior-header",
    details: { message: "Missing" },
    body: '{"error":{"message":"Missing"}}',
  },
  {
    wire: "bedrock-converse",
    purpose: "misbehavior",
    details: { message: "Fault", type: "InternalServerException", code: "fault" },
    body: '{"__type":"InternalServerException","message":"Fault","code":"fault"}',
  },
  {
    wire: "bedrock",
    purpose: "misbehavior",
    details: { message: "Fault", type: "InternalServerException", code: "fault" },
    body: '{"__type":"InternalServerException","code":"fault","message":"Fault"}',
  },
  {
    wire: "cohere",
    purpose: "misbehavior",
    details: { message: "Fault", code: "fault" },
    body: '{"message":"Fault","code":"fault"}',
  },
  {
    wire: "ollama",
    purpose: "misbehavior",
    details: { message: "Fault", code: "fault" },
    body: '{"error":"fault: Fault"}',
  },
  {
    wire: "ollama",
    purpose: "misbehavior",
    details: { message: "Fault" },
    body: '{"error":"undefined: Fault"}',
  },
  {
    wire: "ollama",
    purpose: "misbehavior",
    details: { message: "Fault", code: null },
    body: '{"error":"null: Fault"}',
  },
];

describe("completed common owner contracts", () => {
  it.each(completionContracts)(
    "$wire $purpose preserves supplied fields and order",
    ({ wire, purpose, details, body }) => {
      expect(renderError(wire, purpose, details).body).toBe(body);
    },
  );

  it("builds the same typed inner OpenAI error without inventing a type or code", () => {
    const details = { message: "Fault", type: "api_error", code: "fault" };
    expect(JSON.stringify({ error: buildOpenAIError(details) })).toBe(
      renderError("openai", "misbehavior", details).body,
    );
    expect(JSON.stringify(buildOpenAIError({ message: "Only message" }))).toBe(
      '{"message":"Only message"}',
    );
    expect(JSON.stringify(buildOpenAIError({ message: "Empty", type: "", code: null }))).toBe(
      '{"message":"Empty","type":"","code":null}',
    );
  });
});

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    nodes.push(child, ...descendants(child));
  });
  return nodes;
}

describe("Error template source ownership", () => {
  it("binds every representative consumer to the shared renderer", () => {
    const files = ["helpers.ts", "messages.ts", "bedrock.ts"];
    const program = ts.createProgram(
      files.map((file) => join(sourceRoot, file)),
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
    expect(renderer !== undefined).toBe(true);
    for (const file of files) {
      const consumer = program.getSourceFile(join(sourceRoot, file));
      if (!consumer) throw new Error(`Missing source ${file}`);
      const calls = descendants(consumer).filter(ts.isCallExpression);
      const sharedCalls = calls.filter((call) => {
        const symbol = checker.getSymbolAtLocation(call.expression);
        return (
          symbol !== undefined &&
          (symbol.flags & ts.SymbolFlags.Alias) !== 0 &&
          checker.getAliasedSymbol(symbol) === renderer
        );
      });
      expect(sharedCalls.length).toBeGreaterThanOrEqual(
        file === "helpers.ts" ? 1 : file === "messages.ts" ? 10 : 16,
      );
      const localEnvelopes = descendants(consumer).filter(
        (node) =>
          ts.isPropertyAssignment(node) &&
          (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
          node.name.text === "error" &&
          ts.isObjectLiteralExpression(node.initializer) &&
          node.initializer.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
              property.name.text === "message",
          ),
      );
      expect(localEnvelopes.length).toBe(file === "helpers.ts" ? 2 : 0);
    }
  });
});

function evidence(id: string, value: unknown) {
  const bytes = serializeGolden(value);
  if (process.env.E0_BASELINE_DIR)
    expect(bytes).toBe(readFileSync(join(process.env.E0_BASELINE_DIR, `${id}.json`), "utf8"));
  if (process.env.E0_CAPTURE_DIR) {
    mkdirSync(process.env.E0_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.E0_CAPTURE_DIR, `${id}.json`), bytes);
  }
}

const helperErrors: ErrorResponse[] = [
  { error: { message: "Default error" }, status: 503 },
  { error: { message: "Explicit error", type: "", param: "", code: "" }, status: 400 },
  {
    error: { message: "Rate limited", type: "rate_limit_error", param: "model", code: "quota" },
    retryAfter: 7,
  },
];
const expectedHelperBodies = [
  '{"error":{"message":"Default error","type":"server_error","param":null,"code":null}}',
  '{"error":{"message":"Explicit error","type":"","param":"","code":""}}',
  '{"error":{"message":"Rate limited","type":"rate_limit_error","param":"model","code":"quota"}}',
];
describe("helper error bytes", () => {
  it.each(helperErrors.map((response, index) => ({ response, index })))(
    "preserves helper error $index",
    ({ response, index }) => {
      const body = serializeErrorResponse(response);
      expect(body).toBe(expectedHelperBodies[index]);
      expect(renderError("openai", "fixture", response.error).body).toBe(body);
      expect(Object.keys(JSON.parse(body).error)).toEqual(["message", "type", "param", "code"]);
      expect(body).not.toContain('"status"');
      evidence(`helper-${index}`, body);
    },
  );
});

const fixtures: Fixture[] = [
  {
    match: { userMessage: "fixture-default" },
    response: { error: { message: "Default fixture" }, status: 429, retryAfter: 7 },
  },
  {
    match: { userMessage: "fixture-empty" },
    response: {
      error: { message: "Empty type fixture", type: "", code: "ignored", param: "ignored" },
      status: 502,
    },
  },
  {
    match: { userMessage: "tool-arguments" },
    response: { toolCalls: [{ name: "lookup", arguments: "{bad", id: "toolu_fixed_1" }] },
  },
  {
    match: { userMessage: "unknown-response" },
    response: { embedding: [0.1, 0.2, 0.3] },
  },
  { match: { userMessage: "control" }, response: { content: "Reply" } },
];
const completionRoutes = [
  { wire: "openai", path: "/v1/responses", request: { model: "gpt-4o", input: "control" } },
  {
    wire: "gemini",
    path: "/v1beta/models/gemini-2.0-flash:generateContent",
    request: { contents: [{ role: "user", parts: [{ text: "control" }] }] },
  },
  {
    wire: "interactions",
    path: "/v1beta/interactions",
    request: { model: "gemini-2.0-flash", input: "control" },
  },
  {
    wire: "bedrock-converse",
    path: "/model/anthropic.claude-3-haiku-20240307-v1:0/converse",
    request: { messages: [{ role: "user", content: [{ text: "control" }] }] },
  },
  {
    wire: "cohere",
    path: "/v2/chat",
    request: { model: "command-r-plus", messages: [{ role: "user", content: "control" }] },
  },
  {
    wire: "ollama",
    path: "/api/chat",
    request: { model: "llama3.2", stream: false, messages: [{ role: "user", content: "control" }] },
  },
] as const;

describe("completed owner matches real unchanged HTTP callers", () => {
  for (const path of ["/v1/responses", "/v1/realtime"]) {
    it(`${path} WebSocket preserves the actual common inner error`, async () => {
      const client = await connectWebSocket(server.url, path);
      try {
        const initialCount = path === "/v1/realtime" ? 1 : 0;
        if (initialCount) await client.waitForMessages(initialCount);
        client.send("{bad");
        const frames = await client.waitForMessages(initialCount + 1);
        completionEvidence(`${path === "/v1/realtime" ? "realtime" : "responses"}-ws`, { frames });
        const event = JSON.parse(frames[initialCount]);
        expect(event.type).toBe("error");
        expect(event.error.code).toBe("invalid_json");
        expect(Object.keys(event.error)).toEqual(["message", "type", "code"]);
        expect(JSON.stringify(buildOpenAIError(event.error))).toBe(JSON.stringify(event.error));
      } finally {
        client.destroy();
      }
    });
  }
  for (const route of completionRoutes) {
    it(`${route.wire} misbehavior preserves the actual caller body`, async () => {
      const exchange = await captureHttp(`${server.url}${route.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-aimock-misbehavior":
            route.wire === "bedrock-converse" ||
            route.wire === "gemini" ||
            route.wire === "interactions"
              ? "refusal"
              : route.wire === "cohere"
                ? "content-filter"
                : "tool-call-id-duplicate",
        },
        body: JSON.stringify(route.request),
      });
      completionEvidence(`${route.wire}-misbehavior`, exchange);
      expect(exchange.status).toBe(501);
      const parsed = JSON.parse(exchange.body!);
      const native = parsed.error && typeof parsed.error === "object" ? parsed.error : parsed;
      const details: ErrorDetails =
        route.wire === "ollama"
          ? {
              code: parsed.error.slice(0, parsed.error.indexOf(": ")),
              message: parsed.error.slice(parsed.error.indexOf(": ") + 2),
            }
          : {
              message: native.message,
              type: native.type ?? native.__type,
              code: typeof native.code === "string" ? native.code : undefined,
              bodyCode: typeof native.code === "number" ? native.code : undefined,
              status: native.status,
            };
      expect(renderError(route.wire, "misbehavior", details).body).toBe(exchange.body);
      if (route.wire === "bedrock-converse") {
        expect(Object.keys(parsed)).toEqual(["__type", "message", "code"]);
        expect(renderError(route.wire, "misbehavior", details).headers).toEqual({
          "x-amzn-errortype": exchange.headers["x-amzn-errortype"],
        });
      }
    });
  }
  for (const route of completionRoutes.slice(0, 3)) {
    it(`${route.wire} validation preserves the actual caller body`, async () => {
      const exchange = await captureHttp(`${server.url}${route.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad",
      });
      completionEvidence(`${route.wire}-validation`, exchange);
      expect(exchange.status).toBe(400);
      const { error } = JSON.parse(exchange.body!);
      expect(
        renderError(route.wire, "validation", {
          message: error.message,
          type: error.type,
          code: typeof error.code === "string" ? error.code : undefined,
          bodyCode: typeof error.code === "number" ? error.code : undefined,
          status: error.status,
        }).body,
      ).toBe(exchange.body);
    });
  }
  for (const wire of ["gemini", "interactions"] as const) {
    it(`${wire} fixture preserves the actual caller body`, async () => {
      const route = completionRoutes.find((candidate) => candidate.wire === wire)!;
      const request =
        wire === "gemini"
          ? { contents: [{ role: "user", parts: [{ text: "fixture-default" }] }] }
          : { model: "gemini-2.0-flash", input: "fixture-default" };
      const exchange = await captureHttp(`${server.url}${route.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      completionEvidence(`${wire}-fixture`, exchange);
      expect(exchange.status).toBe(429);
      const { error } = JSON.parse(exchange.body!);
      expect(
        renderError(wire, "fixture", {
          message: error.message,
          code: typeof error.code === "string" ? error.code : undefined,
          bodyCode: typeof error.code === "number" ? error.code : undefined,
          status: error.status,
        }).body,
      ).toBe(exchange.body);
    });
  }
});

function completionEvidence(id: string, exchange: unknown) {
  const bytes = serializeGolden(exchange);
  if (process.env.E2_BASELINE_DIR)
    expect(bytes).toBe(readFileSync(join(process.env.E2_BASELINE_DIR, `${id}.json`), "utf8"));
  if (process.env.E2_CAPTURE_DIR) {
    mkdirSync(process.env.E2_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.E2_CAPTURE_DIR, `${id}.json`), bytes);
  }
}
const wires = ["messages", "messages-stream", "bedrock", "bedrock-stream"] as const;
type Wire = (typeof wires)[number];
let server: GoldenServer;
let proxy: GoldenServer;
let upstream: Awaited<ReturnType<typeof startStubUpstream>>;
let recordingDir: string;
beforeAll(async () => {
  server = await startGoldenServer(fixtures, {
    enableMisbehavior: true,
    strictToolArguments: true,
  });
  upstream = await startStubUpstream((_request, response) => {
    response.destroy();
  });
  recordingDir = mkdtempSync(join(tmpdir(), "aimock-errors-"));
  proxy = await startGoldenServer([], {
    record: {
      providers: { anthropic: upstream.url, bedrock: upstream.url },
      fixturePath: join(recordingDir, "fixtures.json"),
    },
  });
});
afterAll(async () => {
  await server?.close();
  await proxy?.close();
  await upstream?.close();
  if (recordingDir) rmSync(recordingDir, { recursive: true, force: true });
});

function path(wire: Wire) {
  return wire.startsWith("messages")
    ? "/v1/messages"
    : `/model/anthropic.claude-3-5-sonnet-20241022-v2:0/${wire.endsWith("stream") ? "invoke-with-response-stream" : "invoke"}`;
}
function body(wire: Wire, text: string, extra: object = {}) {
  return JSON.stringify({
    model: "claude-sonnet-4-5",
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 256,
    stream: wire.endsWith("stream"),
    messages: [{ role: "user", content: text }],
    ...extra,
  });
}

// Native JSON diagnostics vary with Node; envelope fields and order must not.
function malformedDiagnostic() {
  try {
    JSON.parse("{bad");
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Malformed input unexpectedly parsed");
}

function expectedBody(wire: Wire, id: string) {
  const bedrock = wire.startsWith("bedrock");
  const validationMessages = {
    malformed: `Malformed JSON: ${malformedDiagnostic()}`,
    nonobject: "Request body must be a JSON object",
    "messages-shape": bedrock
      ? "Invalid request: messages[0] must be an object"
      : "messages entries must be JSON objects",
    "tools-shape": bedrock
      ? "Invalid request: tools[0] must be an object"
      : "tools entries must not be null",
    "strict-miss": "Strict mode: no fixture matched",
    miss: "No fixture matched",
  };
  switch (id) {
    case "malformed":
    case "nonobject":
    case "messages-shape":
    case "tools-shape":
    case "strict-miss":
    case "miss":
      return JSON.stringify({
        error: { message: validationMessages[id], type: "invalid_request_error" },
      });
    case "fixture-default":
    case "fixture-empty":
      return JSON.stringify({
        type: "error",
        error: {
          type: id === "fixture-default" ? "api_error" : "",
          message: id === "fixture-default" ? "Default fixture" : "Empty type fixture",
        },
      });
    case "misbehavior": {
      const code = "aimock_misbehavior_not_applicable";
      const message = `tool-call-id-duplicate on ${bedrock ? "bedrock-invoke" : "anthropic"}: not-applicable: Response has no tool calls`;
      return bedrock
        ? JSON.stringify({ __type: "NotImplementedException", code, message })
        : JSON.stringify({ type: "error", error: { type: "api_error", code, message } });
    }
    case "transport-failure":
      return '{"error":{"message":"Proxy to upstream failed: socket hang up","type":"proxy_error"}}';
    case "unknown-response":
      return '{"error":{"message":"Fixture response did not match any known type","type":"server_error"}}';
    case "tool-arguments": {
      if (wire.endsWith("stream")) return undefined;
      const message =
        'aimock: fixture tool call "lookup" has invalid JSON arguments; this wire carries arguments as an object. ' +
        `Use a wire that carries tool arguments as a string to test malformed JSON. (${malformedDiagnostic()})`;
      return bedrock
        ? JSON.stringify({
            __type: "InternalServerException",
            message,
            reason: "aimock_invalid_tool_arguments",
          })
        : JSON.stringify({
            type: "error",
            error: { type: "api_error", code: "aimock_invalid_tool_arguments", message },
          });
    }
    case "thinking":
      if (!bedrock)
        return JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "messages.1.content.0: when `thinking` is enabled, a tool-loop continuation assistant turn must begin with a `thinking` block; got `text`.",
          },
        });
    // Falls through: Bedrock replays despite the Messages thinking invariant.
    case "control":
      if (wire.endsWith("stream")) return undefined;
      return JSON.stringify({
        id: "msg_<#1>",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Reply" }],
        model: bedrock ? "anthropic.claude-3-5-sonnet-20241022-v2:0" : "claude-sonnet-4-5",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    default:
      throw new Error(`Missing permanent body expectation for ${id}`);
  }
}

function expectedFrames(wire: Wire, tool: boolean) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_<#1>",
        type: "message",
        role: "assistant",
        content: [],
        model:
          wire === "messages-stream"
            ? "claude-sonnet-4-5"
            : "anthropic.claude-3-5-sonnet-20241022-v2:0",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: "toolu_fixed_1", name: "lookup", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? { type: "input_json_delta", partial_json: "{bad" }
        : { type: "text_delta", text: "Reply" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    },
    { type: "message_stop" },
  ];
  return wire === "messages-stream"
    ? events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`)
    : events.map((event) => ({
        headers: {
          ":content-type": "application/json",
          ":event-type": "chunk",
          ":message-type": "event",
        },
        payload: '{"bytes":"<base64:decodedBytes>"}',
        decodedBytes: JSON.stringify(event),
      }));
}

function expectedHeaders(wire: Wire, id: string, frames?: "sse" | "aws") {
  return {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "X-Total-Count, X-Request-Id",
    ...(frames === "sse" ? { "cache-control": "no-cache" } : {}),
    "content-type":
      frames === "sse"
        ? "text/event-stream"
        : frames === "aws"
          ? "application/vnd.amazon.eventstream"
          : "application/json",
    ...(id === "fixture-default"
      ? {
          "retry-after": "7",
          "x-ratelimit-limit-requests": "60",
          "x-ratelimit-limit-tokens": "150000",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-remaining-tokens": "0",
          "x-ratelimit-reset-requests": "1s",
          "x-ratelimit-reset-tokens": "6m0s",
        }
      : {}),
    ...(id === "misbehavior" && wire.startsWith("bedrock")
      ? { "x-amzn-errortype": "NotImplementedException" }
      : {}),
    "x-request-id": "req-<#0>",
  };
}
async function capture(
  id: string,
  wire: Wire,
  raw: string,
  status: number,
  headers: object = {},
  source = server,
  frames?: "sse" | "aws",
) {
  const captured = await captureHttp(`${source.url}${path(wire)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
    frames,
  });
  expect(captured.status).toBe(status);
  expect(captured.headers).toEqual(expectedHeaders(wire, id, frames));
  expect(captured.body).toBe(expectedBody(wire, id));
  expect(captured.bodyBase64).toBeUndefined();
  expect(captured.tail).toBeUndefined();
  expect(JSON.stringify(captured.frames)).toBe(
    frames ? JSON.stringify(expectedFrames(wire, id === "tool-arguments")) : undefined,
  );
  evidence(`${wire}-${id}`, captured);
  return captured;
}

describe.each(wires)("real %s error surfaces", (wire) => {
  it("preserves malformed JSON", async () => {
    await capture("malformed", wire, "{bad", 400);
  });
  it("preserves non-object validation", async () => {
    await capture("nonobject", wire, "null", 400);
  });
  it("preserves messages validation", async () => {
    await capture("messages-shape", wire, body(wire, "control", { messages: [null] }), 400);
  });
  it("preserves tool validation", async () => {
    await capture("tools-shape", wire, body(wire, "control", { tools: [null] }), 400);
  });
  it("preserves strict misses", async () => {
    await capture("strict-miss", wire, body(wire, "missing"), 503, { "x-aimock-strict": "true" });
  });
  it("preserves non-strict misses", async () => {
    await capture("miss", wire, body(wire, "missing"), 404);
  });
  it("preserves unknown-response error bytes", async () => {
    await capture("unknown-response", wire, body(wire, "unknown-response"), 500);
  });
  it.each(["default", "empty"])("preserves fixture error %s", async (variant) => {
    const got = await capture(
      `fixture-${variant}`,
      wire,
      body(wire, `fixture-${variant}`),
      variant === "default" ? 429 : 502,
    );
    expect(got.body).toBe(
      JSON.stringify({
        type: "error",
        error: {
          type: variant === "default" ? "api_error" : "",
          message: variant === "default" ? "Default fixture" : "Empty type fixture",
        },
      }),
    );
    if (variant === "default") expect(got.headers["retry-after"]).toBe("7");
  });
  it("preserves malformed fixture tool arguments", async () => {
    const streams = wire.endsWith("stream");
    const got = await capture(
      "tool-arguments",
      wire,
      body(wire, "tool-arguments"),
      streams ? 200 : 500,
      {},
      server,
      streams ? (wire === "messages-stream" ? "sse" : "aws") : undefined,
    );
    if (streams) return;
    expect(got.body).toContain("aimock_invalid_tool_arguments");
    const toolError: { error?: { message: string }; message?: string } = JSON.parse(got.body ?? "");
    const message = toolError.message ?? toolError.error?.message;
    if (message === undefined) throw new Error("Missing tool-argument message");
    expect(
      renderError(wire.startsWith("bedrock") ? "bedrock" : "messages", "tool-argument", {
        message,
        code: "aimock_invalid_tool_arguments",
      }).body,
    ).toBe(got.body);
    if (wire.startsWith("bedrock")) {
      expect(Object.keys(JSON.parse(got.body ?? "")).join(",")).toBe("__type,message,reason");
      expect(got.headers["x-amzn-errortype"]).toBeUndefined();
    }
  });
  it("preserves handler misbehavior errors", async () => {
    await capture("misbehavior", wire, body(wire, "control"), 501, {
      "x-aimock-misbehavior": "tool-call-id-duplicate",
    });
  });
  it("preserves transport-failure response", async () => {
    const got = await capture("transport-failure", wire, body(wire, "missing"), 502, {}, proxy);
    expect(
      renderError(wire.startsWith("bedrock") ? "bedrock" : "messages", "transport-failure", {
        message: "Proxy to upstream failed: socket hang up",
      }).body,
    ).toBe(got.body);
  });
  it("preserves thinking invariant and Bedrock replay", async () => {
    const messages = [
      { role: "user", content: "control" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling tool" },
          { type: "tool_use", id: "toolu_fixed_2", name: "lookup", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_fixed_2", content: "ok" }],
      },
    ];
    const rejects = wire.startsWith("messages");
    await capture(
      "thinking",
      wire,
      body(wire, "control", { messages, thinking: { type: "enabled", budget_tokens: 128 } }),
      rejects ? 400 : 200,
      { "x-aimock-strict": "true" },
      server,
      !rejects && wire.endsWith("stream") ? "aws" : undefined,
    );
  });
  it("preserves successful stream framing control", async () => {
    await capture(
      "control",
      wire,
      body(wire, "control"),
      200,
      {},
      server,
      wire === "messages-stream" ? "sse" : wire === "bedrock-stream" ? "aws" : undefined,
    );
  });
});
