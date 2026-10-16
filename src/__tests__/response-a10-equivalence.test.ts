import { describe, expect, test, vi } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import type { GoldenServer, CapturedExchange } from "./golden/harness.js";
import {
  captureRawHttp,
  expectGolden,
  startGoldenServer,
  startStubUpstream,
} from "./golden/harness.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VEO_SUBMIT = "/v1beta/models/veo-3.1-generate-preview:predictLongRunning";
const VEO_OPERATION = "operations/a10-veo-operation";
const OR_JOB = "a10-openrouter-job";
const AUTH = "Bearer a10-local-key";
const HOST = "a10-local.test";
const HEADERS = {
  host: HOST,
  authorization: AUTH,
  "content-type": "application/json",
  "x-aimock-strict": "false",
};
const OWNER = resolve(ROOT, "src/response/errors.ts");
const WRITER = resolve(ROOT, "src/sse-writer.ts");

const SITES = [
  { id: "veo-submit-proxy-failure", file: "veo-video.ts", functionName: "proxyVeoVideoSubmit" },
  { id: "veo-poll-proxy-failure", file: "veo-video.ts", functionName: "proxyVeoVideoRecordPoll" },
  {
    id: "openrouter-content-proxy-failure",
    file: "openrouter-video.ts",
    functionName: "proxyOpenRouterVideoRecordContent",
  },
  {
    id: "openrouter-submit-proxy-failure",
    file: "openrouter-video.ts",
    functionName: "proxyOpenRouterVideoSubmit",
  },
  {
    id: "openrouter-poll-proxy-failure",
    file: "openrouter-video.ts",
    functionName: "proxyOpenRouterVideoRecordPoll",
  },
] as const;

type FailureCase = (typeof SITES)[number]["id"];
type CaseId = FailureCase | "veo-native-poll-control" | "openrouter-native-content-control";
type JsonCapture = {
  status: number;
  contentType: string | null;
  body: string;
};
type Exchange = { step: string; wire: CapturedExchange | JsonCapture };
type UpstreamCapture = {
  method: string;
  url: string;
  authorization: string | undefined;
  strictOverride: string | string[] | undefined;
  body: string;
};

function captureRequest(url: string, payload?: unknown): Promise<CapturedExchange> {
  const target = new URL(url);
  const body = payload === undefined ? "" : JSON.stringify(payload);
  return captureRawHttp(
    url,
    [
      `${payload === undefined ? "GET" : "POST"} ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${HOST}`,
      `Authorization: ${AUTH}`,
      "Content-Type: application/json",
      "X-Aimock-Strict: false",
      "Connection: close",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"),
  );
}

function parsedBody(body: string | undefined): unknown {
  if (body === undefined) throw new Error("Expected a complete JSON body");
  const parsed: unknown = JSON.parse(body);
  return parsed;
}

function stringField(body: unknown, field: string): string {
  if (body === null || typeof body !== "object" || !(field in body)) {
    throw new Error(`Missing native setup field ${field}`);
  }
  const value: unknown = Reflect.get(body, field);
  if (typeof value !== "string" || !value) throw new Error(`Invalid native setup field ${field}`);
  return value;
}

function assertProxyFailure(wire: CapturedExchange): void {
  expect(wire.status).toBe(502);
  expect(wire.headers["content-type"]).toContain("application/json");
  const body = parsedBody(wire.body);
  if (body === null || typeof body !== "object" || !("error" in body)) {
    throw new Error("Expected the actual proxy error envelope");
  }
  const error: unknown = body.error;
  if (error === null || typeof error !== "object")
    throw new Error("Expected a native error object");
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(error)).toEqual(["message", "type"]);
  expect(stringField(error, "type")).toBe("proxy_error");
  expect(stringField(error, "message")).toMatch(/^Proxy to upstream failed: .+/);
}

// Setup needs the actual native job IDs and local polling URL before golden
// normalization. Only real HTTP response bytes populate this capture.
async function createRecordJob(mock: GoldenServer, provider: "veo" | "openrouter") {
  const path = provider === "veo" ? VEO_SUBMIT : "/api/v1/videos";
  const payload =
    provider === "veo"
      ? { instances: [{ prompt: "a10 real record job" }] }
      : { model: "bytedance/seedance-2.0", prompt: "a10 real record job" };
  const body = JSON.stringify(payload);
  const wire = await new Promise<JsonCapture>((resolve, reject) => {
    const outgoing = request(
      `${mock.url}${path}`,
      {
        method: "POST",
        headers: { ...HEADERS, "content-length": Buffer.byteLength(body) },
        signal: AbortSignal.timeout(5000),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("aborted", () =>
          reject(new Error("Actual record-job setup response was aborted")),
        );
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers["content-type"] ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
  expect(wire.status).toBe(provider === "veo" ? 200 : 202);
  const native = parsedBody(wire.body);
  const nativePoll = provider === "openrouter" ? new URL(stringField(native, "polling_url")) : null;
  if (nativePoll) expect(nativePoll.host).toBe(HOST);
  return {
    wire,
    poll:
      provider === "veo"
        ? `${mock.url}/v1beta/${stringField(native, "name")}`
        : `${mock.url}${nativePoll?.pathname}${nativePoll?.search}`,
    content:
      provider === "openrouter"
        ? `${mock.url}/api/v1/videos/${stringField(native, "id")}/content?index=0`
        : null,
  };
}

async function runCase(id: CaseId) {
  const provider = id.startsWith("veo-") ? "veo" : "openrouter";
  const directory = mkdtempSync(join(tmpdir(), "aimock-a10-"));
  const exchanges: Exchange[] = [];
  const logs: string[] = [];
  // This spy observes existing logging only. Responses and failure callbacks
  // come from the real source server and an actual failing localhost socket.
  const logObserver = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  });
  let failure: "submit" | "poll" | "content" | null = null;
  let pollComplete = false;
  let upstreamUrl = "";
  const upstream = await startStubUpstream((request, response) => {
    const url = new URL(request.url, "http://a10-upstream");
    const endpoint =
      request.method === "POST" ? "submit" : url.pathname.endsWith("/content") ? "content" : "poll";
    if (failure === endpoint) {
      response.destroy();
      return;
    }
    if (endpoint === "content") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("a10 native video bytes");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (provider === "veo") {
      response.end(
        JSON.stringify(
          endpoint === "submit" ? { name: VEO_OPERATION } : { name: VEO_OPERATION, done: false },
        ),
      );
      return;
    }
    response.end(
      JSON.stringify(
        endpoint === "submit"
          ? { id: OR_JOB, polling_url: `${upstreamUrl}/api/v1/videos/${OR_JOB}`, status: "pending" }
          : pollComplete
            ? {
                id: OR_JOB,
                status: "completed",
                unsigned_urls: [`${upstreamUrl}/api/v1/videos/${OR_JOB}/content?index=0`],
                usage: { cost: 0.25 },
              }
            : { id: OR_JOB, status: "pending" },
      ),
    );
  }).catch((error: unknown) => {
    logObserver.mockRestore();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  });
  upstreamUrl = upstream.url;
  let mock: GoldenServer | undefined;
  let result:
    | {
        id: CaseId;
        exchanges: Exchange[];
        journal: CapturedExchange;
        upstream: UpstreamCapture[];
        recorded: string[];
        logs: string[];
      }
    | undefined;
  let primary: { error: unknown } | undefined;
  try {
    mock = await startGoldenServer([], {
      strict: true,
      logLevel: "warn",
      record: {
        providers: { [provider]: upstream.url },
        fixturePath: directory,
        // Keep the failing content case a real live record job. The native
        // recording control waits for eager capture before requesting replay.
        proxyOnly: id === "openrouter-content-proxy-failure",
      },
    });
    if (id.endsWith("submit-proxy-failure")) {
      failure = "submit";
      const path = provider === "veo" ? VEO_SUBMIT : "/api/v1/videos";
      const payload =
        provider === "veo"
          ? { instances: [{ prompt: "a10 submit failure" }] }
          : { model: "bytedance/seedance-2.0", prompt: "a10 submit failure" };
      const wire = await captureRequest(`${mock.url}${path}`, payload);
      assertProxyFailure(wire);
      exchanges.push({ step: "target", wire });
      expect(upstream.requests).toHaveLength(1);
    } else {
      const job = await createRecordJob(mock, provider);
      exchanges.push({ step: "actual-record-job-submit", wire: job.wire });
      expect(upstream.requests).toHaveLength(1);
      if (id.includes("content")) {
        pollComplete = true;
        const poll = await captureRequest(job.poll);
        expect(poll.status).toBe(200);
        expect(parsedBody(poll.body)).toMatchObject({ status: "completed" });
        exchanges.push({ step: "actual-native-completed-poll", wire: poll });
        if (job.content === null)
          throw new Error("Content case needs a real OpenRouter record job");
        if (id.endsWith("proxy-failure")) {
          failure = "content";
        } else {
          await expect
            .poll(() => readdirSync(directory).filter((name) => name.endsWith(".json")).length)
            .toBe(1);
        }
        const wire = await captureRequest(job.content);
        process.stdout.write(
          JSON.stringify({
            surface: "actual-A10-content-setup",
            id,
            status: wire.status,
            upstreamRequests: upstream.requests.map((entry) => ({
              method: entry.method,
              url: entry.url,
            })),
          }) + "\n",
        );
        if (id.endsWith("proxy-failure")) {
          assertProxyFailure(wire);
        } else {
          expect(wire.status).toBe(200);
          expect(wire.headers["content-type"]).toContain("video/mp4");
          expect(wire.body).toBe("a10 native video bytes");
        }
        exchanges.push({ step: "target", wire });
        expect(upstream.requests).toHaveLength(3);
      } else {
        const control = await captureRequest(job.poll);
        expect(control.status).toBe(200);
        expect(parsedBody(control.body)).toMatchObject(
          provider === "veo" ? { done: false } : { status: "pending" },
        );
        exchanges.push({ step: "native-nonterminal-poll-control", wire: control });
        if (id.endsWith("proxy-failure")) {
          failure = "poll";
          const wire = await captureRequest(job.poll);
          assertProxyFailure(wire);
          exchanges.push({ step: "target", wire });
          expect(upstream.requests).toHaveLength(3);
        } else {
          expect(upstream.requests).toHaveLength(2);
        }
      }
    }
    const filenames = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (id.endsWith("proxy-failure")) {
      expect(filenames).toEqual([]);
      expect(logs.join("\n")).toContain("proxy failed:");
    }
    const journal = await captureRequest(`${mock.url}/v1/_requests`);
    expect(journal.status).toBe(200);
    expect(journal.body).toContain('"source":"proxy"');
    expect(journal.body, "actual incoming journal Host must be stable before freezing").toContain(
      HOST,
    );
    result = {
      id,
      exchanges,
      journal,
      upstream: upstream.requests.map((entry) => ({
        method: entry.method,
        url: entry.url,
        authorization: entry.headers.authorization,
        strictOverride: entry.headers["x-aimock-strict"],
        body: entry.body,
      })),
      recorded: filenames.map((name) => readFileSync(join(directory, name), "utf8")),
      logs,
    };
    process.stdout.write(
      JSON.stringify({
        surface: "actual-A10",
        id,
        targetStatuses: exchanges
          .filter((entry) => entry.step === "target")
          .map((entry) => entry.wire.status),
        actualRecordJob: exchanges.some((entry) => entry.step === "actual-record-job-submit"),
        upstreamCount: upstream.requests.length,
        recordedCount: filenames.length,
        journalHostVerified: true,
        journalSourceProxyVerified: true,
      }) + "\n",
    );
  } catch (error) {
    primary = { error };
  }
  const cleanup = await Promise.allSettled([mock?.close(), upstream.close()]);
  logObserver.mockRestore();
  rmSync(directory, { recursive: true, force: true });
  if (primary) throw primary.error;
  const cleanupErrors = cleanup.filter((outcome) => outcome.status === "rejected");
  if (cleanupErrors.length)
    throw new Error(`A10 cleanup failed: ${cleanupErrors.map(String).join("; ")}`);
  if (!result) throw new Error(`A10 case ${id} did not produce a capture`);
  return result;
}

function sourceOwnership() {
  const config = ts.readConfigFile(resolve(ROOT, "tsconfig.test.json"), ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;
  const program = ts.createProgram({
    rootNames: [
      resolve(ROOT, "src/veo-video.ts"),
      resolve(ROOT, "src/openrouter-video.ts"),
      OWNER,
      WRITER,
    ],
    options,
  });
  const checker = program.getTypeChecker();
  function exportedSymbol(path: string, name: string) {
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`Missing actual owner source ${path}`);
    const module = checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`Missing actual module symbol ${path}`);
    const symbol = checker.getExportsOfModule(module).find((item) => item.name === name);
    if (!symbol) throw new Error(`Missing actual exported owner ${name}`);
    return symbol;
  }
  function boundSymbol(node: ts.Node) {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  }
  return {
    program,
    checker,
    boundSymbol,
    renderer: exportedSymbol(OWNER, "renderError"),
    writer: exportedSymbol(WRITER, "writeErrorResponse"),
  };
}

describe("actual A10 equivalence", () => {
  test("preserves all five real proxy failures, actual job setup and native controls", async () => {
    const matrix: Awaited<ReturnType<typeof runCase>>[] = [];
    for (const site of SITES) matrix.push(await runCase(site.id));
    matrix.push(await runCase("veo-native-poll-control"));
    matrix.push(await runCase("openrouter-native-content-control"));
    console.log(
      JSON.stringify({ surface: "actual-A10", cases: matrix.length, ids: matrix.map((c) => c.id) }),
    );
    expectGolden("response-a10", "equivalence-matrix", matrix);
  });
});

describe("A10 source ownership", () => {
  const ownership = sourceOwnership();
  for (const site of SITES) {
    test(`${site.id} delegates its exact exercised proxy502 body to the import-bound shared owner`, () => {
      const source = ownership.program.getSourceFile(resolve(ROOT, "src", site.file));
      if (!source) throw new Error(`Missing qualified source ${site.file}`);
      const outer = source.statements.find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === site.functionName,
      );
      if (!outer?.body) throw new Error(`Missing qualified function ${site.functionName}`);
      let callback: ts.ArrowFunction | undefined;
      function locate(node: ts.Node): void {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "proxyError" &&
          node.initializer &&
          ts.isArrowFunction(node.initializer)
        ) {
          callback = node.initializer;
        }
        ts.forEachChild(node, locate);
      }
      locate(outer.body);
      if (!callback) throw new Error(`Missing qualified callback ${site.functionName}.proxyError`);
      const writes: ts.CallExpression[] = [];
      function locateWrites(node: ts.Node): void {
        if (
          ts.isCallExpression(node) &&
          ownership.boundSymbol(node.expression) === ownership.writer
        ) {
          writes.push(node);
        }
        ts.forEachChild(node, locateWrites);
      }
      locateWrites(callback.body);
      expect(writes.length, `${site.id} exact callback writer count`).toBe(1);
      const write = writes[0];
      expect(write.arguments[1]?.getText(source)).toBe("502");
      const body = write.arguments[2];
      const delegates = Boolean(
        body && ts.isPropertyAccessExpression(body) && body.name.text === "body",
      );
      process.stdout.write(
        JSON.stringify({
          surface: "A10-source-ownership",
          id: site.id,
          functionName: site.functionName,
          writerCount: writes.length,
          line: source.getLineAndCharacterOfPosition(write.getStart(source)).line + 1,
          delegates,
        }) + "\n",
      );
      expect(
        delegates,
        `${site.id} local proxy502 body must delegate to the import-bound owner`,
      ).toBe(true);
      if (!body || !ts.isPropertyAccessExpression(body) || !ts.isCallExpression(body.expression)) {
        throw new Error(`${site.id} requires the shared serialized body`);
      }
      const render = body.expression;
      expect(
        ownership.boundSymbol(render.expression) === ownership.renderer,
        `${site.id} renderer must bind to the shared owner`,
      ).toBe(true);
      expect(render.arguments[0]?.getText(source)).toBe('"openai"');
      expect(render.arguments[1]?.getText(source)).toBe('"transport-failure"');
      const details = render.arguments[2];
      if (!details || !ts.isObjectLiteralExpression(details))
        throw new Error("Missing explicit transport details");
      const properties = details.properties.filter(ts.isPropertyAssignment);
      const type = properties.find((item) => item.name.getText(source) === "type");
      const message = properties.find((item) => item.name.getText(source) === "message");
      expect(type?.initializer.getText(source)).toBe('"proxy_error"');
      if (!message || !ts.isTemplateExpression(message.initializer))
        throw new Error("Missing native proxy message");
      expect(message.initializer.head.text).toBe("Proxy to upstream failed: ");
      expect(message.initializer.templateSpans).toHaveLength(1);
      expect(
        ownership.boundSymbol(message.initializer.templateSpans[0].expression) ===
          ownership.checker.getSymbolAtLocation(callback.parameters[0].name),
        `${site.id} native message must bind to its callback parameter`,
      ).toBe(true);
    });
  }
});
