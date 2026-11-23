import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Fixture } from "../types.js";
import {
  captureRawHttp,
  expectGolden,
  startGoldenServer,
  type GoldenServer,
} from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const wrongFixture: Fixture = {
  match: { userMessage: "a12 non-video", endpoint: "video", model: "grok-imagine-video" },
  response: { content: "A valid text response, not a video." },
};
const videoFixture: Fixture = {
  match: { userMessage: "a12 sora control", endpoint: "video", model: "sora-2" },
  response: {
    video: {
      id: "video_a12_control",
      status: "completed",
      url: "https://video.example/a12-sora.mp4",
    },
  },
};
const grokFixture: Fixture = {
  match: { userMessage: "a12 grok control", endpoint: "video", model: "grok-imagine-video" },
  response: {
    video: {
      id: "video_a12_grok",
      status: "completed",
      url: "https://video.example/a12-grok.mp4",
      duration: 4,
      cost: 0.03,
    },
  },
};

const requests = [
  { id: "video-status-not-found", method: "GET", path: "/v1/videos/a12_absent" },
  {
    id: "grok-wrong-fixture-type",
    method: "POST",
    path: "/v1/videos/generations",
    body: { model: "grok-imagine-video", prompt: "a12 non-video" },
  },
  {
    id: "video-create-control",
    method: "POST",
    path: "/v1/videos",
    body: { model: "sora-2", prompt: "a12 sora control" },
  },
  { id: "video-status-control", method: "GET", path: "/v1/videos/video_a12_control" },
  {
    id: "grok-native-control",
    method: "POST",
    path: "/v1/videos/generations",
    body: { model: "grok-imagine-video", prompt: "a12 grok control" },
  },
] as const;

async function exchange(server: GoldenServer, request: (typeof requests)[number]) {
  const before = server.instance.journal.getAll().length;
  const headers = {
    host: "a12.local",
    connection: "close",
    "content-type": "application/json",
    "x-request-id": "a12-caller-trace",
  };
  const body = "body" in request ? JSON.stringify(request.body) : "";
  const rawRequest = [
    `${request.method} ${request.path} HTTP/1.1`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    `content-length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
  const wire = await captureRawHttp(server.url, rawRequest);
  const entries = server.instance.journal.getAll().slice(before);
  return { headers, wire, entries };
}

describe("actual A12 equivalence", () => {
  it("preserves both qualified errors, journals and native video controls", async () => {
    const server = await startGoldenServer([wrongFixture, videoFixture, grokFixture], {
      grokVideo: { pollsBeforeInProgress: 0, pollsBeforeCompleted: 0 },
    });
    try {
      const matrix: Array<{
        request: (typeof requests)[number] & {
          headers: Awaited<ReturnType<typeof exchange>>["headers"];
        };
        wire: Awaited<ReturnType<typeof exchange>>["wire"];
        entries: Awaited<ReturnType<typeof exchange>>["entries"];
      }> = [];
      for (const request of requests) {
        const { headers, wire, entries } = await exchange(server, request);
        expect(entries, request.id).toHaveLength(1);
        expect(entries[0].headers.host, request.id).toBe("a12.local");
        expect(entries[0].path, request.id).toBe(request.path);
        expect(entries[0].method, request.id).toBe(request.method);
        expect(wire.headers["content-type"], request.id).toContain("application/json");

        if (request.id === "video-status-not-found") {
          expect(wire.status).toBe(404);
          expect(wire.body).toBe(
            '{"error":{"message":"Video a12_absent not found","type":"not_found"}}',
          );
          expect(entries[0].body).toBeNull();
          expect(entries[0].response).toMatchObject({ status: 404, fixture: null });
        } else if (request.id === "grok-wrong-fixture-type") {
          expect(wire.status).toBe(500);
          expect(wire.body).toBe(
            '{"error":{"message":"Fixture response is not a video type","type":"server_error"}}',
          );
          expect(entries[0].response.status).toBe(500);
          expect(entries[0].response.fixture).toBe(wrongFixture);
          expect(entries[0].body).toMatchObject({
            model: "grok-imagine-video",
            messages: [{ role: "user", content: "a12 non-video" }],
          });
        } else {
          expect(wire.status, request.id).toBe(200);
          expect(entries[0].response.status, request.id).toBe(200);
          if (request.id === "grok-native-control") {
            expect(entries[0].response.fixture).toBe(grokFixture);
            expect(wire.body).toMatch(/^\{"request_id":"[^"\s]+"\}$/);
          } else if (request.id === "video-status-control") {
            expect(entries[0].response.fixture).toBeNull();
            expect(entries[0].body).toBeNull();
            expect(JSON.parse(wire.body ?? "")).toMatchObject({
              id: "video_a12_control",
              status: "completed",
              url: "https://video.example/a12-sora.mp4",
            });
          } else {
            expect(entries[0].response.fixture).toBe(videoFixture);
          }
        }
        console.log(JSON.stringify({ case: request.id, status: wire.status, body: wire.body }));
        matrix.push({ request: { ...request, headers }, wire, entries });
      }
      expectGolden("response-a12", "equivalence-matrix", matrix);
    } finally {
      await server.close();
    }
  });
});

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    nodes.push(child, ...descendants(child));
  });
  return nodes;
}

const targets = [
  {
    file: "video.ts",
    functionName: "handleVideoStatus",
    status: "404",
    purpose: "route-failure",
    message: "`Video ${videoId} not found`",
    type: "not_found",
  },
  {
    file: "grok-video.ts",
    functionName: "handleGrokVideoCreate",
    status: "500",
    purpose: "unknown-response",
    message: '"Fixture response is not a video type"',
    type: "server_error",
  },
] as const;

describe("A12 source ownership", () => {
  it.each(targets)(
    "$functionName delegates only its qualified body to the actual owner",
    (target) => {
      const program = ts.createProgram(
        [join(sourceRoot, target.file), join(sourceRoot, "response/errors.ts")],
        {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          skipLibCheck: true,
        },
      );
      const source = program.getSourceFile(join(sourceRoot, target.file));
      const owner = program.getSourceFile(join(sourceRoot, "response/errors.ts"));
      if (!source || !owner) throw new Error("Missing qualified source or error owner");
      const checker = program.getTypeChecker();
      const ownerSymbol = checker.getSymbolAtLocation(owner);
      const renderer =
        ownerSymbol &&
        checker.getExportsOfModule(ownerSymbol).find((symbol) => symbol.name === "renderError");
      expect(renderer).toBeDefined();
      const handler = source.statements.find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === target.functionName,
      );
      if (!handler?.body) throw new Error(`Missing ${target.functionName}`);
      const branches = descendants(handler.body).filter((node): node is ts.IfStatement => {
        if (
          !ts.isIfStatement(node) ||
          !ts.isPrefixUnaryExpression(node.expression) ||
          node.expression.operator !== ts.SyntaxKind.ExclamationToken
        )
          return false;
        const operand = node.expression.operand;
        return target.file === "video.ts"
          ? ts.isIdentifier(operand) && operand.text === "entry"
          : ts.isCallExpression(operand) &&
              ts.isIdentifier(operand.expression) &&
              operand.expression.text === "isVideoResponse";
      });
      expect(branches, "exact exercised absence/type guard").toHaveLength(1);
      const writers = descendants(branches[0].thenStatement).filter(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "writeErrorResponse" &&
          ts.isNumericLiteral(node.arguments[1]) &&
          node.arguments[1].text === target.status,
      );
      expect(writers, "exact qualified status writer").toHaveLength(1);
      const body = writers[0].arguments[2];
      expect(
        ts.isPropertyAccessExpression(body),
        "qualified writer must consume the owner .body",
      ).toBe(true);
      if (!ts.isPropertyAccessExpression(body)) return;
      expect(body.name.text).toBe("body");
      expect(ts.isCallExpression(body.expression)).toBe(true);
      if (!ts.isCallExpression(body.expression)) return;
      const call = body.expression;
      const imported = checker.getSymbolAtLocation(call.expression);
      expect(
        imported && (imported.flags & ts.SymbolFlags.Alias) !== 0,
        "renderer must resolve through an import alias",
      ).toBe(true);
      if (!imported || (imported.flags & ts.SymbolFlags.Alias) === 0) return;
      expect(checker.getAliasedSymbol(imported)).toBe(renderer);
      expect(call.arguments[0].getText(source)).toBe('"openai"');
      expect(call.arguments[1].getText(source)).toBe(JSON.stringify(target.purpose));
      const details = call.arguments[2];
      expect(ts.isObjectLiteralExpression(details)).toBe(true);
      if (!ts.isObjectLiteralExpression(details)) return;
      expect(details.properties.map((property) => property.name?.getText(source))).toEqual([
        "message",
        "type",
      ]);
      const values = details.properties
        .filter(ts.isPropertyAssignment)
        .map((property) => property.initializer.getText(source));
      expect(values).toEqual([target.message, JSON.stringify(target.type)]);
      // Only the two exercised branches are constrained; native video/result bodies remain independent.
    },
  );
});
