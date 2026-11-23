import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { mapAnthropicFinish } from "../response/finish.js";
import { createServer } from "../server.js";

async function withBedrockClient<T>(
  finishReason: string | undefined,
  request: (client: BedrockRuntimeClient) => Promise<T>,
) {
  const instance = await createServer(
    [
      {
        match: { userMessage: "hello" },
        response: { content: "hello", ...(finishReason !== undefined && { finishReason }) },
      },
    ],
    { port: 0, logLevel: "silent" },
  );
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    endpoint: instance.url,
    credentials: { accessKeyId: "offline", secretAccessKey: "offline" },
    requestHandler: new NodeHttpHandler(),
    maxAttempts: 1,
  });
  try {
    return await request(client);
  } finally {
    client.destroy();
    await new Promise<void>((resolve, reject) => {
      instance.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function requestConverseText(finishReason?: string) {
  return withBedrockClient(finishReason, (client) =>
    client.send(
      new ConverseCommand({
        modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        messages: [{ role: "user", content: [{ text: "hello" }] }],
      }),
    ),
  );
}

async function requestInvokeStopReason(finishReason: string | undefined, streaming: boolean) {
  return withBedrockClient(finishReason, async (client) => {
    const input = {
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      contentType: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    };
    if (!streaming) {
      const result = await client.send(new InvokeModelCommand(input));
      const message = JSON.parse(new TextDecoder().decode(result.body));
      return message.stop_reason;
    }
    const result = await client.send(new InvokeModelWithResponseStreamCommand(input));
    if (!result.body) throw new Error("InvokeStream response must contain an event stream");
    for await (const event of result.body) {
      if (!event.chunk?.bytes) continue;
      const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
      if (chunk.type === "message_delta") return chunk.delta.stop_reason;
    }
    throw new Error("InvokeStream response must contain a message_delta event");
  });
}

describe("Bedrock Invoke caller defaults", () => {
  it.each([
    [undefined, false],
    ["", false],
    [undefined, true],
    ["", true],
  ] as const)("uses end_turn for finishReason %j with streaming %j", async (reason, streaming) => {
    expect(await requestInvokeStopReason(reason, streaming)).toBe("end_turn");
  });
});

describe("Bedrock Converse caller defaults", () => {
  it.each([undefined, ""])("uses end_turn for finishReason %j", async (reason) => {
    const result = await requestConverseText(reason);
    expect(result.output?.message?.content).toEqual([{ text: "hello" }]);
    expect(result.stopReason).toBe("end_turn");
  });
});

describe("Bedrock Converse forwarded finish reasons", () => {
  it.each([
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
  ])("forwards finishReason %s as %s", async (reason, expected) => {
    const result = await requestConverseText(reason);
    expect(result.output?.message?.content).toEqual([{ text: "hello" }]);
    expect(result.stopReason).toBe(expected);
  });
});

describe("Anthropic finish source ownership", () => {
  it.each([
    ["messages.ts", "claudeStopReason"],
    ["bedrock.ts", "bedrockStopReason"],
    ["bedrock-converse.ts", "converseStopReason"],
  ])("%s retains its falsy default and delegates the mapping", (name, wrapper) => {
    const path = fileURLToPath(new URL(`../${name}`, import.meta.url));
    const file = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const bindings = file.statements.flatMap((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        resolve(dirname(path), statement.moduleSpecifier.text) !==
          resolve(dirname(path), "response/finish.js")
      )
        return [];
      const named = statement.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) return [];
      return named.elements
        .filter((binding) => (binding.propertyName ?? binding.name).text === "mapAnthropicFinish")
        .map((binding) => binding.name.text);
    });
    const declaration = file.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === wrapper,
    );
    expect(declaration?.body?.statements).toHaveLength(2);
    const returned = declaration?.body?.statements[1];
    expect(returned && ts.isReturnStatement(returned)).toBe(true);
    if (
      !returned ||
      !ts.isReturnStatement(returned) ||
      !returned.expression ||
      !ts.isCallExpression(returned.expression) ||
      !ts.isIdentifier(returned.expression.expression)
    )
      throw new Error("finish wrapper must return the imported mapping call");
    expect(bindings).toContain(returned.expression.expression.text);
    expect(returned.expression.arguments).toHaveLength(1);
  });
});

describe("Anthropic finish owner", () => {
  it.each([
    ["stop", "end_turn"],
    ["tool_calls", "tool_use"],
    ["length", "max_tokens"],
    ["future_reason", "future_reason"],
    ["", ""],
    ["end_turn", "end_turn"],
  ])("maps %j to %j without choosing a caller default", (reason, expected) => {
    expect(mapAnthropicFinish(reason)).toBe(expected);
  });
});
