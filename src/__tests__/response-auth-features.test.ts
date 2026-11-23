import { appendFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureHttp,
  captureRawHttp,
  expectGolden,
  startGoldenServer,
  type CapturedExchange,
  type GoldenServer,
} from "./golden/harness.js";

const legacyBody =
  '{"error":{"message":"Invalid API key","type":"authentication_error","code":"invalid_api_key"}}';
const anthropicBody =
  '{"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}';
const googleBody = '{"error":{"code":401,"message":"Invalid API key","status":"UNAUTHENTICATED"}}';

function evidence(cell: string, value: unknown): void {
  if (process.env.F3_EVIDENCE_FILE)
    appendFileSync(process.env.F3_EVIDENCE_FILE, JSON.stringify({ cell, value }) + "\n");
}

function assertRejection(exchange: CapturedExchange, body: string): void {
  expect(exchange.status).toBe(401);
  expect(exchange.body).toBe(body);
  expect(exchange.headers["www-authenticate"]).toBe('Bearer realm="aimock"');
  expect(exchange.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
}

describe("native auth bodies (policy authErrors=native) on the source HTTP and installed SDK surfaces", () => {
  let server: GoldenServer;
  beforeAll(async () => {
    server = await startGoldenServer([], {
      auth: { apiKeys: ["accepted"] },
      policy: { authErrors: "native" },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it.each(["/v1/messages", "/v1/messages/count_tokens"])(
    "Anthropic %s selects by path with missing and wrong keys",
    async (path) => {
      for (const headers of [
        new Headers(),
        new Headers({ "x-api-key": "bad" }),
        new Headers({ Authorization: "Bearer bad", "anthropic-version": "2023-06-01" }),
      ]) {
        const exchange = await captureHttp(server.url + path, {
          method: "POST",
          headers,
          body: "{}",
        });
        evidence("native-auth:" + path, exchange);
        assertRejection(exchange, anthropicBody);
        expect(exchange.headers["request-id"]).toMatch(/^req_<#\d+>$/);
      }
    },
  );

  it.each([
    "/v1beta/models/gemini-test:generateContent",
    "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
    "/v1beta/models/gemini-test:countTokens",
    "/v1beta/models",
    "/v1beta/interactions",
    "/v1/projects/p/locations/l/publishers/google/models/gemini-test:generateContent",
  ])("Google %s selects by path", async (path) => {
    for (const headers of [
      new Headers(),
      new Headers({ "x-goog-api-key": "bad" }),
      new Headers({ "x-api-key": "bad", "anthropic-version": "2023-06-01" }),
    ]) {
      const exchange = await captureHttp(server.url + path, {
        method: "POST",
        headers,
        body: "{}",
      });
      evidence("native-auth:" + path, exchange);
      assertRejection(exchange, googleBody);
      expect(exchange.headers).not.toHaveProperty("request-id");
    }
  });

  it("all legacy HTTP families and every WS upgrade stay byte-identical", async () => {
    const captures: CapturedExchange[] = [];
    for (const path of [
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/embeddings",
      "/v1/models",
      "/v1/models/claude-test",
      "/model/claude-test/invoke",
      "/model/claude-test/converse",
      "/v2/chat",
      "/api/chat",
      "/v1/audio/speech",
      "/api/v1/chat/completions",
      "/v1/images/generations",
      "/other/publishers/google/models/test",
    ]) {
      const capture = await captureHttp(server.url + path, {
        method: "POST",
        headers: { "x-api-key": "bad", "anthropic-version": "2023-06-01" },
        body: "{}",
      });
      evidence("legacy-http:" + path, capture);
      assertRejection(capture, legacyBody);
      expect(capture.headers).not.toHaveProperty("request-id");
      captures.push(capture);
    }
    for (const path of [
      "/v1/realtime",
      "/v1/responses",
      "/v1/live/sessions",
      "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
      "/v1beta/models/gemini-test:generateContent",
      "/v1/messages",
      "/v1/messages/count_tokens",
    ]) {
      const raw = [
        `GET ${path} HTTP/1.1`,
        "Host: golden",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "Authorization: Bearer bad",
        "",
        "",
      ].join("\r\n");
      const capture = await captureRawHttp(server.url, raw);
      evidence("legacy-ws:" + path, capture);
      assertRejection(capture, legacyBody);
      captures.push(capture);
    }
    expectGolden("response-f3", "controls", captures);
  });

  it.each(["messages", "count"] as const)(
    "installed Anthropic SDK %s surfaces AuthenticationError and requestID",
    async (operation) => {
      const sdk = new Anthropic({ apiKey: "bad", baseURL: server.url, maxRetries: 0 });
      let caught: unknown;
      try {
        const request = {
          model: "claude-test",
          messages: [{ role: "user" as const, content: "hi" }],
        };
        if (operation === "messages") await sdk.messages.create({ ...request, max_tokens: 16 });
        else await sdk.messages.countTokens(request);
      } catch (error) {
        caught = error;
      }
      evidence(
        "sdk-anthropic-auth:" + operation,
        caught instanceof Anthropic.APIError
          ? {
              name: caught.name,
              status: caught.status,
              message: caught.message,
              requestID: caught.requestID,
              error: caught.error,
            }
          : String(caught),
      );
      expect(caught).toBeInstanceOf(Anthropic.AuthenticationError);
      if (!(caught instanceof Anthropic.APIError)) throw new Error("Expected Anthropic APIError");
      expect(caught.status).toBe(401);
      expect(caught.message).toContain("Invalid API key");
      expect(caught.requestID).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
      expect(caught.error).toEqual(JSON.parse(anthropicBody));
    },
  );

  it("installed Gemini SDK surfaces the native numeric401 error", async () => {
    const sdk = new GoogleGenAI({
      apiKey: "bad",
      httpOptions: { baseUrl: server.url, apiVersion: "v1beta" },
    });
    let caught: unknown;
    try {
      await sdk.models.generateContent({ model: "gemini-test", contents: "hi" });
    } catch (error) {
      caught = error;
    }
    evidence(
      "sdk-gemini-auth",
      caught instanceof ApiError
        ? { name: caught.name, status: caught.status, message: caught.message }
        : String(caught),
    );
    expect(caught).toBeInstanceOf(ApiError);
    if (!(caught instanceof ApiError)) throw new Error("Expected Gemini ApiError");
    expect(caught.status).toBe(401);
    expect(caught.message).toContain("Invalid API key");
    expect(caught.message).toContain("UNAUTHENTICATED");
  });

  it("installed OpenAI SDK retains its AuthenticationError", async () => {
    const sdk = new OpenAI({ apiKey: "bad", baseURL: server.url + "/v1", maxRetries: 0 });
    let caught: unknown;
    try {
      await sdk.chat.completions.create({
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
      });
    } catch (error) {
      caught = error;
    }
    evidence(
      "sdk-openai-auth",
      caught instanceof OpenAI.APIError
        ? { name: caught.name, status: caught.status, message: caught.message, code: caught.code }
        : String(caught),
    );
    expect(caught).toBeInstanceOf(OpenAI.AuthenticationError);
    if (!(caught instanceof OpenAI.APIError)) throw new Error("Expected OpenAI APIError");
    expect(caught.code).toBe("invalid_api_key");
    expect(caught.message).toContain("Invalid API key");
  });
});

// 1.45 contract: without the native opt-in, every HTTP route keeps the string
// error.code "invalid_api_key", including Anthropic and Gemini/Vertex paths.
describe("default inbound auth keeps the 1.45 legacy body on every HTTP route", () => {
  let server: GoldenServer;
  beforeAll(async () => {
    server = await startGoldenServer([], { auth: { apiKeys: ["accepted"] } });
  });
  afterAll(async () => {
    await server.close();
  });

  it.each([
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/v1beta/models/gemini-test:generateContent",
    "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
    "/v1beta/models/gemini-test:countTokens",
    "/v1beta/models",
    "/v1beta/interactions",
    "/v1/projects/p/locations/l/publishers/google/models/gemini-test:generateContent",
  ])("%s returns error.code invalid_api_key", async (path) => {
    for (const headers of [
      new Headers(),
      new Headers({ "x-api-key": "bad", "anthropic-version": "2023-06-01" }),
      new Headers({ "x-goog-api-key": "bad" }),
    ]) {
      const exchange = await captureHttp(server.url + path, {
        method: "POST",
        headers,
        body: "{}",
      });
      assertRejection(exchange, legacyBody);
      expect(exchange.headers).not.toHaveProperty("request-id");
    }
  });

  it("a request X-AIMock-Policy header opts one request into the native body", async () => {
    const exchange = await captureHttp(server.url + "/v1beta/models", {
      method: "POST",
      headers: { "x-goog-api-key": "bad", "x-aimock-policy": "authErrors=native" },
      body: "{}",
    });
    assertRejection(exchange, googleBody);
  });

  it("installed Anthropic SDK still sees error.code invalid_api_key", async () => {
    const sdk = new Anthropic({ apiKey: "bad", baseURL: server.url, maxRetries: 0 });
    let caught: unknown;
    try {
      await sdk.messages.create({
        model: "claude-test",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Anthropic.AuthenticationError);
    if (!(caught instanceof Anthropic.APIError)) throw new Error("Expected Anthropic APIError");
    expect(caught.status).toBe(401);
    expect(caught.error).toEqual(JSON.parse(legacyBody));
  });

  it("installed Gemini SDK still sees error.code invalid_api_key", async () => {
    const sdk = new GoogleGenAI({
      apiKey: "bad",
      httpOptions: { baseUrl: server.url, apiVersion: "v1beta" },
    });
    let caught: unknown;
    try {
      await sdk.models.generateContent({ model: "gemini-test", contents: "hi" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    if (!(caught instanceof ApiError)) throw new Error("Expected Gemini ApiError");
    expect(caught.status).toBe(401);
    expect(caught.message).toContain("invalid_api_key");
  });
});
