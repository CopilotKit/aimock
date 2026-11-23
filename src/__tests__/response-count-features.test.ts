import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizePathLabel } from "../metrics.js";
import { matchRouteDefinition } from "../route-registry.js";
import {
  captureHttp,
  startGoldenServer,
  startStubUpstream,
  type GoldenServer,
} from "./golden/harness.js";

const anthropicPath = "/v1/messages/count_tokens";
const geminiPath = "/v1beta/models/gemini-test:countTokens";
const anthropicBody = {
  model: "claude-test",
  system: "abcd",
  messages: [{ role: "user" as const, content: "abcdefgh" }],
  tools: [{ name: "lookup", description: "Find", input_schema: { type: "object" as const } }],
};
const geminiBody = {
  systemInstruction: { parts: [{ text: "abcd" }] },
  contents: [{ role: "user", parts: [{ text: "abcdefgh" }] }],
  tools: [
    {
      functionDeclarations: [
        { name: "lookup", description: "Find", parameters: { type: "object" } },
      ],
    },
  ],
};

function evidence(cell: string, value: unknown): void {
  if (process.env.F3_EVIDENCE_FILE)
    appendFileSync(process.env.F3_EVIDENCE_FILE, JSON.stringify({ cell, value }) + "\n");
}

async function post(server: GoldenServer, cell: string, path: string, body: unknown) {
  const exchange = await captureHttp(server.url + path, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  evidence(cell, exchange);
  return exchange;
}

describe("deterministic counts through the source HTTP server", () => {
  let server: GoldenServer;
  beforeAll(async () => {
    server = await startGoldenServer([
      {
        match: { model: "claude-test" },
        response: { content: "unused", usage: { input_tokens: 999 } },
      },
      {
        match: { model: "gemini-test" },
        response: { content: "unused", usage: { input_tokens: 999 } },
      },
    ]);
  });
  afterAll(async () => {
    await server.close();
  });

  it.each([
    ["anthropic-system-tools", anthropicPath, anthropicBody, '{"input_tokens":29}'],
    ["gemini-system-tools", geminiPath, geminiBody, '{"totalTokens":29}'],
    ["gemini-wrapper", geminiPath, { generateContentRequest: geminiBody }, '{"totalTokens":29}'],
    [
      "anthropic-text",
      anthropicPath,
      { messages: [{ role: "user", content: "hello" }] },
      '{"input_tokens":2}',
    ],
    [
      "gemini-text",
      geminiPath,
      { contents: [{ parts: [{ text: "hello" }] }] },
      '{"totalTokens":2}',
    ],
    ["anthropic-empty", anthropicPath, { messages: [] }, '{"input_tokens":1}'],
    ["gemini-empty", geminiPath, { contents: [] }, '{"totalTokens":1}'],
    [
      "a4-anthropic-empty-system",
      anthropicPath,
      { messages: [], system: [] },
      '{"input_tokens":1}',
    ],
    ["a4-gemini-absent-parts", geminiPath, { contents: [{}] }, '{"totalTokens":1}'],
    ["a4-gemini-empty-parts", geminiPath, { contents: [{ parts: [] }] }, '{"totalTokens":1}'],
    [
      "a4-gemini-absent-system-parts",
      geminiPath,
      { contents: [], systemInstruction: {} },
      '{"totalTokens":1}',
    ],
    [
      "a4-gemini-empty-system-parts",
      geminiPath,
      { contents: [], systemInstruction: { parts: [] } },
      '{"totalTokens":1}',
    ],
    ["anthropic-empty-tools", anthropicPath, { messages: [], tools: [] }, '{"input_tokens":1}'],
    ["gemini-empty-tools", geminiPath, { contents: [], tools: [] }, '{"totalTokens":1}'],
    [
      "gemini-ignored-tools",
      geminiPath,
      { contents: [], tools: [{ googleSearch: {} }] },
      '{"totalTokens":1}',
    ],
    [
      "gemini-outer-tools",
      geminiPath,
      { tools: geminiBody.tools, generateContentRequest: { contents: [] } },
      '{"totalTokens":1}',
    ],
    [
      "anthropic-system-blocks",
      anthropicPath,
      { system: [{ type: "text", text: "abcdefgh" }], messages: [] },
      '{"input_tokens":2}',
    ],
    [
      "count-text-anthropic-tool-result",
      anthropicPath,
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_count_test", name: "lookup", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_count_test",
                content: [{ type: "text", text: "abcdefgh" }],
              },
            ],
          },
        ],
      },
      '{"input_tokens":2}',
    ],
    [
      "count-text-anthropic-ignored-role",
      anthropicPath,
      { messages: [{ role: "unknown", content: [{ type: "text", text: { toString: 0 } }] }] },
      '{"input_tokens":1}',
    ],
    [
      "count-text-gemini-ignored-role",
      geminiPath,
      { contents: [{ role: "unknown", parts: [{ text: { toString: 0 } }] }] },
      '{"totalTokens":1}',
    ],
    [
      "count-text-anthropic-ignored-nontext",
      anthropicPath,
      { messages: [{ role: "assistant", content: [{ type: "thinking", text: { toString: 0 } }] }] },
      '{"input_tokens":1}',
    ],
    [
      "count-text-gemini-ignored-thought",
      geminiPath,
      { contents: [{ parts: [{ thought: true, text: { toString: 0 } }] }] },
      '{"totalTokens":1}',
    ],
  ])("%s returns exact estimated input", async (cell, path, body, expectedBody) => {
    const exchange = await post(server, String(cell), String(path), body);
    expect(exchange.status).toBe(200);
    expect(exchange.body).toBe(expectedBody);
  });

  it.each([
    ["anthropic-missing", anthropicPath, {}],
    ["anthropic-array", anthropicPath, []],
    ["anthropic-null", anthropicPath, null],
    ["anthropic-messages-shape", anthropicPath, { messages: "bad" }],
    ["anthropic-message-shape", anthropicPath, { messages: [null] }],
    ["anthropic-content-shape", anthropicPath, { messages: [{ role: "user", content: {} }] }],
    [
      "count-text-anthropic-message-object",
      anthropicPath,
      { messages: [{ role: "user", content: [{ type: "text", text: { toString: 0 } }] }] },
    ],
    [
      "count-text-anthropic-system-object",
      anthropicPath,
      { messages: [], system: [{ type: "text", text: { toString: 0 } }] },
    ],
    [
      "count-text-anthropic-tool-result-object",
      anthropicPath,
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_count_test", name: "lookup", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_count_test",
                content: [{ type: "text", text: { toString: 0 } }],
              },
            ],
          },
        ],
      },
    ],
    ["anthropic-tools-shape", anthropicPath, { messages: [], tools: [null] }],
    ["a4-anthropic-system-object", anthropicPath, { messages: [], system: {} }],
    ["a4-anthropic-system-null-element", anthropicPath, { messages: [], system: [null] }],
    ["a4-anthropic-system-null", anthropicPath, { messages: [], system: null }],
    ["gemini-missing", geminiPath, {}],
    ["gemini-null", geminiPath, null],
    ["gemini-wrapper-shape", geminiPath, { generateContentRequest: null }],
    ["gemini-wrapper-missing", geminiPath, { generateContentRequest: {} }],
    ["gemini-contents-shape", geminiPath, { contents: "bad" }],
    ["gemini-content-shape", geminiPath, { contents: [null] }],
    ["gemini-parts-shape", geminiPath, { contents: [{ parts: "bad" }] }],
    [
      "count-text-gemini-message-object",
      geminiPath,
      { contents: [{ parts: [{ text: { toString: 0 } }] }] },
    ],
    [
      "count-text-gemini-system-object",
      geminiPath,
      { contents: [], systemInstruction: { parts: [{ text: { toString: 0 } }] } },
    ],
    ["a4-gemini-null-parts", geminiPath, { contents: [{ parts: null }] }],
    [
      "a4-gemini-system-null-element",
      geminiPath,
      { contents: [], systemInstruction: { parts: [null] } },
    ],
    ["gemini-system-shape", geminiPath, { contents: [], systemInstruction: "bad" }],
    [
      "gemini-declarations-shape",
      geminiPath,
      { contents: [], tools: [{ functionDeclarations: "bad" }] },
    ],
  ])("%s is a dialect400", async (cell, path, body) => {
    const exchange = await post(server, String(cell), String(path), body);
    const entry = server.instance.journal.getAll().at(-1);
    evidence(String(cell) + ":journal", entry);
    expect(exchange.status).toBe(400);
    expect(JSON.parse(exchange.body ?? "null")).toMatchObject(
      path === anthropicPath
        ? { type: "error", error: { type: "invalid_request_error", message: expect.any(String) } }
        : { error: { code: 400, status: "INVALID_ARGUMENT", message: expect.any(String) } },
    );
    expect(entry).toMatchObject({
      path,
      body: null,
      response: { status: 400, source: "internal", fixture: null },
    });
  });

  it.each([anthropicPath, geminiPath])("malformed JSON stays dialect400 on %s", async (path) => {
    const exchange = await captureHttp(server.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    evidence("malformed:" + path, exchange);
    expect(exchange.status).toBe(400);
    expect(JSON.parse(exchange.body ?? "null").error.message).toContain("Malformed JSON body");
  });

  it("installed Anthropic SDK countTokens receives the native count", async () => {
    const sdk = new Anthropic({ apiKey: "local", baseURL: server.url, maxRetries: 0 });
    try {
      const result = await sdk.messages.countTokens(anthropicBody);
      evidence("sdk-anthropic-count", result);
      expect(result.input_tokens).toBe(29);
    } catch (error) {
      evidence("sdk-anthropic-count", { error: String(error) });
      throw error;
    }
  });

  it("installed Gemini SDK countTokens receives the native count", async () => {
    const sdk = new GoogleGenAI({
      apiKey: "local",
      httpOptions: { baseUrl: server.url, apiVersion: "v1beta" },
    });
    try {
      const result = await sdk.models.countTokens({ model: "gemini-test", contents: "hello" });
      evidence("sdk-gemini-count", result);
      expect(result.totalTokens).toBe(2);
    } catch (error) {
      evidence("sdk-gemini-count", { error: String(error) });
      throw error;
    }
  });

  it("count routes have registry, OpenAPI and metrics attribution", async () => {
    const response = await fetch(server.url + "/__aimock/openapi.json");
    const schema = await response.json();
    for (const [path, template] of [
      [anthropicPath, anthropicPath],
      [geminiPath, "/v1beta/models/{model}:countTokens"],
    ]) {
      expect(matchRouteDefinition("POST", path)?.path).toBe(template);
      expect(normalizePathLabel(path)).toBe(template);
      expect(schema.paths[template].post.requestBody).toBeDefined();
      expect(schema.paths[template].post.responses["200"]).toBeDefined();
    }
  });
});

describe.each([false, true])("count array text rejection (strict=%s)", (strict) => {
  let server: GoldenServer;
  beforeAll(async () => {
    server = await startGoldenServer([], { strict });
  });
  afterAll(async () => {
    await server.close();
  });

  it.each([
    {
      cell: "anthropic-message-array",
      path: anthropicPath,
      body: { messages: [{ role: "user", content: [{ type: "text", text: ["abcdefgh"] }] }] },
      message: "content text must not be an object or array",
    },
    {
      cell: "anthropic-system-array",
      path: anthropicPath,
      body: { messages: [], system: [{ type: "text", text: ["abcdefgh"] }] },
      message: "system text must not be an object or array",
    },
    {
      cell: "anthropic-tool-result-array",
      path: anthropicPath,
      body: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_count_array", name: "lookup", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_count_array",
                content: [{ type: "text", text: ["abcdefgh"] }],
              },
            ],
          },
        ],
      },
      message: "tool_result content text must not be an object or array",
    },
    {
      cell: "gemini-message-array",
      path: geminiPath,
      body: { contents: [{ parts: [{ text: ["abcdefgh"] }] }] },
      message: "content text must not be an object or array",
    },
    {
      cell: "gemini-system-array",
      path: geminiPath,
      body: { contents: [], systemInstruction: { parts: [{ text: ["abcdefgh"] }] } },
      message: "systemInstruction text must not be an object or array",
    },
  ])("$cell is a dialect400", async ({ cell, path, body, message }) => {
    const exchange = await post(server, `${cell}:strict=${strict}`, path, body);
    const entry = server.instance.journal.getAll().at(-1);
    evidence(`${cell}:strict=${strict}:journal`, entry);
    expect(exchange.status).toBe(400);
    expect(JSON.parse(exchange.body ?? "null")).toEqual(
      path === anthropicPath
        ? { type: "error", error: { type: "invalid_request_error", message } }
        : { error: { code: 400, status: "INVALID_ARGUMENT", message } },
    );
    expect(entry).toMatchObject({
      path,
      body: null,
      response: { status: 400, source: "internal", fixture: null },
    });
  });
});

it.each([false, true])(
  "counts stay internal with no recording or upstream hits (proxyOnly=%s)",
  async (proxyOnly) => {
    const upstream = await startStubUpstream((_req, res) => {
      res.writeHead(500);
      res.end("unexpected egress");
    });
    const directory = mkdtempSync(join(tmpdir(), "aimock-f3-count-"));
    const server = await startGoldenServer([], {
      record: {
        providers: { anthropic: upstream.url, gemini: upstream.url },
        fixturePath: directory,
        proxyOnly,
      },
    });
    try {
      const first = await post(
        server,
        `local-count:${proxyOnly}:anthropic`,
        anthropicPath,
        anthropicBody,
      );
      const second = await post(server, `local-count:${proxyOnly}:gemini`, geminiPath, {
        generateContentRequest: geminiBody,
      });
      evidence("no-egress:" + proxyOnly, {
        hits: upstream.requests.length,
        files: readdirSync(directory),
        journal: server.instance.journal.getAll(),
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(upstream.requests).toEqual([]);
      expect(readdirSync(directory)).toEqual([]);
      const entries = server.instance.journal.getAll();
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.path)).toEqual([anthropicPath, geminiPath]);
      for (const entry of entries)
        expect(entry.response).toMatchObject({ status: 200, source: "internal", fixture: null });
      expect(entries[0].body).toMatchObject({
        model: "claude-test",
        messages: [
          { role: "system", content: "abcd" },
          { role: "user", content: "abcdefgh" },
        ],
      });
      expect(entries[1].body).toMatchObject({
        model: "gemini-test",
        messages: [
          { role: "system", content: "abcd" },
          { role: "user", content: "abcdefgh" },
        ],
      });
    } finally {
      await server.close();
      await upstream.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
