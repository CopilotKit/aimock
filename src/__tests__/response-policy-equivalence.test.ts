import type { IncomingHttpHeaders } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { resolveStrictMode, strictOverrideField } from "../helpers.js";
import { LLMock } from "../llmock.js";
import { MCPMock } from "../mcp-mock.js";
import { serializeGolden } from "./golden/harness.js";
import { startUpstream } from "./mcp-upstream-harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const policyPath = join(sourceRoot, "response/policy.ts");
const policy = existsSync(policyPath) ? await import("../response/policy.js") : undefined;

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    result.push(child, ...descendants(child));
  });
  return result;
}

function importedCalls(
  file: ts.SourceFile,
  checker: ts.TypeChecker,
  exported: string,
  ownerPath = policyPath,
) {
  const bindings = file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return [];
    if (
      resolve(dirname(file.fileName), statement.moduleSpecifier.text.replace(/\.js$/, ".ts")) !==
      ownerPath
    )
      return [];
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return [];
    return named.elements
      .filter((binding) => (binding.propertyName ?? binding.name).text === exported)
      .map((binding) => checker.getSymbolAtLocation(binding.name));
  });
  return descendants(file).filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.includes(checker.getSymbolAtLocation(node.expression)),
  );
}

describe("policy source ownership", () => {
  it.each([
    ["helpers.ts", "resolveStrictMode", "resolveStrictMode"],
    ["helpers.ts", "strictOverrideField", "strictOverrideField"],
    ["mcp-recorder.ts", "answerByFake", "resolveRequestDecisions"],
  ])("%s %s delegates to policy %s", (name, consumer, exported) => {
    const path = join(sourceRoot, name);
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const file = program.getSourceFile(path)!;
    const calls = importedCalls(file, program.getTypeChecker(), exported);
    const owners = calls.map((call) => {
      const owner = ts.findAncestor(
        call,
        (node) => ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node),
      );
      return owner && (ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner))
        ? owner.name?.getText(file)
        : undefined;
    });
    expect(owners, `${consumer} must call the policy import binding`).toContain(consumer);
    if (name === "helpers.ts") {
      const wrapper = file.statements.find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === consumer,
      )!;
      expect(wrapper.body?.statements).toHaveLength(1);
      expect(ts.isReturnStatement(wrapper.body!.statements[0])).toBe(true);
    } else {
      const oldCalls = importedCalls(
        file,
        program.getTypeChecker(),
        "resolveStrictMode",
        join(sourceRoot, "helpers.ts"),
      );
      expect(oldCalls).toHaveLength(0);
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.arguments.map((argument) => argument.getText(file))).toEqual([
        "this.config.strict",
        "x.req.headers",
      ]);
      expect(ts.isPropertyAccessExpression(call.parent)).toBe(true);
      if (ts.isPropertyAccessExpression(call.parent))
        expect(call.parent.name.text).toBe("mcpRecordingStrict");
      const answerBranch = descendants(file).find(
        (node): node is ts.IfStatement =>
          ts.isIfStatement(node) && node.expression.getText(file) === 'claim.kind === "answer"',
      );
      expect(answerBranch).toBeDefined();
      expect(call.pos).toBeGreaterThan(answerBranch!.end);
    }
  });

  it("the parser grammar belongs only to the policy owner", () => {
    expect(existsSync(policyPath), "shared policy owner exists").toBe(true);
    const helpers = ts.createSourceFile(
      "helpers.ts",
      readFileSync(join(sourceRoot, "helpers.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const strictHeaderReads = descendants(helpers).filter(
      (node) =>
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "x-aimock-strict",
    );
    expect(strictHeaderReads).toHaveLength(0);
  });
});

function assertCapture(id: string, value: unknown) {
  const bytes = serializeGolden(value);
  const directory = process.env.P0_CAPTURE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${id}.json`);
    if (process.env.P0_CAPTURE_WRITE === "1") writeFileSync(file, bytes);
    else expect(bytes, id).toBe(readFileSync(file, "utf8"));
  }
}

const headers: Array<IncomingHttpHeaders | undefined> = [
  undefined,
  {},
  ...["true", "1", "false", "0", "  TRUE  ", " False ", " 1 ", " 0 ", "", "yes", "tr ue"].map(
    (value) => ({ "x-aimock-strict": value }),
  ),
  { "x-aimock-strict": [] },
  { "x-aimock-strict": ["false", "true"] },
  { "x-aimock-strict": [" TRUE ", "false"] },
  { "x-aimock-strict": ["invalid", "true"] },
];

describe("policy direct helper preservation", () => {
  it("captures public helper grammar and override suppliedness", () => {
    assertCapture(
      "helpers",
      [undefined, false, true].flatMap((serverDefault) =>
        headers.map((rawHeaders) => ({
          serverDefault,
          rawHeaders,
          strict: resolveStrictMode(serverDefault, rawHeaders),
          override: strictOverrideField(serverDefault, rawHeaders),
        })),
      ),
    );
    expect(resolveStrictMode(undefined)).toBe(false);
    expect(resolveStrictMode(true, { "x-aimock-strict": ["invalid", "false"] })).toBe(true);
    expect(strictOverrideField(undefined, { "x-aimock-strict": "false" })).toEqual({});
    expect(strictOverrideField(true, { "x-aimock-strict": "false" })).toEqual({
      strictOverride: false,
    });
  });
});

describe("named request decisions", () => {
  it("uses the preserved grammar for every frozen decision and override", () => {
    expect(policy, "shared policy owner exists").toBeDefined();
    if (!policy) return;
    for (const serverDefault of [undefined, false, true]) {
      for (const rawHeaders of headers) {
        const strict = resolveStrictMode(serverDefault, rawHeaders);
        const decisions = policy.resolveRequestDecisions(serverDefault, rawHeaders);
        expect(decisions).toEqual({
          strict,
          fixtureMiss: strict,
          upstream: !strict,
          reasoningSuppression: strict,
          thinkingRejection: strict,
          mcpRecordingStrict: strict,
          strictOverride: strict !== (serverDefault ?? false) ? strict : undefined,
        });
        expect(Object.isFrozen(decisions)).toBe(true);
        expect(Reflect.set(decisions, "strict", !strict)).toBe(false);
      }
    }
  });

  it("reads the strict header once to derive all decisions", () => {
    expect(policy, "shared policy owner exists").toBeDefined();
    if (!policy) return;
    let reads = 0;
    const rawHeaders = {
      get "x-aimock-strict"() {
        return ++reads === 1 ? "true" : "false";
      },
    };
    expect(policy.resolveRequestDecisions(false, rawHeaders)).toMatchObject({
      strict: true,
      upstream: false,
      mcpRecordingStrict: true,
      strictOverride: true,
    });
    expect(reads).toBe(1);
  });
});

interface McpCase {
  id: string;
  strict: boolean;
  header?: string;
  mode: "mismatch" | "allow" | "deny" | "answer" | "evicted";
  error?: string;
}
const mcpCases: McpCase[] = [
  {
    id: "mismatch-header-true",
    strict: false,
    header: "true",
    mode: "mismatch",
    error: "MCP_FAKE_MISMATCH",
  },
  { id: "mismatch-header-false", strict: true, header: "false", mode: "mismatch" },
  {
    id: "mismatch-invalid-strict",
    strict: true,
    header: "invalid",
    mode: "mismatch",
    error: "MCP_FAKE_MISMATCH",
  },
  { id: "mismatch-invalid-loose", strict: false, header: "invalid", mode: "mismatch" },
  { id: "undeclared-allow", strict: false, mode: "allow" },
  { id: "undeclared-strict", strict: true, mode: "allow", error: "MCP_FAKE_NOT_DECLARED" },
  {
    id: "undeclared-deny",
    strict: false,
    header: "false",
    mode: "deny",
    error: "MCP_FAKE_NOT_DECLARED",
  },
  { id: "declared-answer-strict", strict: true, header: "true", mode: "answer" },
  {
    id: "evicted-loose",
    strict: false,
    header: "false",
    mode: "evicted",
    error: "MCP_FAKE_EVICTED",
  },
];

async function captureMcp(c: McpCase) {
  const upstream = await startUpstream();
  const fixturePath = mkdtempSync(join(tmpdir(), "aimock-policy-"));
  const llm = new LLMock({ port: 0, logLevel: "silent", fixtureCountsMaxTestIds: 1 });
  const mcp = new MCPMock();
  mcp.loadFakes({
    scope: c.mode === "evicted" ? "shared" : { testId: c.id },
    undeclaredTools: c.mode === "deny" ? "deny" : "allow",
    tools: [
      {
        name: c.mode === "allow" || c.mode === "deny" ? "known" : "echo",
        calls: [{ args: { message: "fake" }, result: "local" }],
      },
    ],
  });
  mcp.enableRecording({ upstream: upstream.url, fixturePath, strict: c.strict });
  llm.mount("/mcp", mcp);
  const clients: Client[] = [];
  const wires: Array<{ status: number; contentType: string | null; body: string }> = [];
  try {
    const base = await llm.start();
    async function connect(testId: string) {
      const client = new Client({ name: "policy-preservation", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp?testId=${testId}`), {
          requestInit: { headers: c.header ? { "x-aimock-strict": c.header } : {} },
          fetch: async (url, init) => {
            const response = await fetch(url, init);
            if (typeof init?.body === "string" && init.body.includes('"method":"tools/call"')) {
              wires.push({
                status: response.status,
                contentType: response.headers.get("content-type"),
                body: await response.clone().text(),
              });
            }
            return response;
          },
        }),
      );
      return client;
    }
    const client = await connect(c.id);
    if (c.mode === "evicted") {
      await client.callTool({ name: "echo", arguments: { message: "fake" } });
      const second = await connect("eviction-control");
      await second.callTool({ name: "echo", arguments: { message: "fake" } });
      wires.length = 0;
    }
    const args = { message: c.mode === "answer" || c.mode === "evicted" ? "fake" : "live" };
    if (c.error) {
      await expect(client.callTool({ name: "echo", arguments: args })).rejects.toMatchObject({
        data: { aimock: { code: c.error } },
      });
    } else {
      const result = await client.callTool({ name: "echo", arguments: args });
      expect(result.content).toEqual([
        { type: "text", text: c.mode === "answer" ? "local" : "Echo: live" },
      ]);
    }
    const recorded = existsSync(join(fixturePath, c.id, "mcp.json"));
    expect(recorded).toBe(!c.error && c.mode !== "answer");
    assertCapture(c.id, {
      wires,
      journal: llm
        .getRequests()
        .filter(
          (entry) => entry.body && "method" in entry.body && entry.body.method === "tools/call",
        )
        .map((entry) => entry.response),
      recorded,
    });
    expect(wires).toHaveLength(1);
    if (c.error) expect(JSON.parse(wires[0].body).error).toBeDefined();
  } catch (error) {
    if (error instanceof McpError) throw new Error(`${c.id}: ${error.message}`, { cause: error });
    throw error;
  } finally {
    for (const client of clients.reverse()) await client.close();
    await llm.stop();
    await upstream.stop();
    rmSync(fixturePath, { recursive: true, force: true });
  }
}

describe("policy real MCP preservation", () => {
  it.each(mcpCases)("$id", captureMcp, 30_000);
});
