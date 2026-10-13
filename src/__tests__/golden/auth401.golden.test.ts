/**
 * Golden corpus: the inbound-auth 401 written by the API-key gate, one case
 * per route family, for a wrong key and for a missing key.
 *
 * Case-name prefixes mark intent (a naming convention for reviewers; no code
 * reads them):
 * - `openai-*`: routes whose 401 is the shared OpenAI-shaped error body today
 *   (chat, Responses, shared `/v1/models`, Bedrock, Ollama, OpenRouter,
 *   WebSocket upgrade). These bytes must stay identical.
 * - `replaced-*`: Anthropic and Gemini/Vertex routes. These goldens are
 *   expected to be replaced by provider-format goldens later.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureHttp,
  captureRawHttp,
  expectGolden,
  startGoldenServer,
  type CapturedExchange,
  type GoldenServer,
} from "./harness.js";

const SUITE = "auth401";

let srv: GoldenServer;

beforeAll(async () => {
  srv = await startGoldenServer([], { auth: { apiKeys: ["good"] } });
});

afterAll(async () => {
  await srv.close();
});

const chatBody = JSON.stringify({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
});

const geminiBody = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });

interface HttpCase {
  name: string;
  method: "GET" | "POST";
  path: string;
  /** Headers carrying the wrong key (`bad`). Dropped for the missing-key variant. */
  keyHeaders: Record<string, string>;
  /** Non-credential headers sent in both variants. */
  headers?: Record<string, string>;
  body?: string;
}

const json = { "content-type": "application/json" };

const HTTP_CASES: HttpCase[] = [
  {
    name: "openai-chat",
    method: "POST",
    path: "/v1/chat/completions",
    keyHeaders: { authorization: "Bearer bad" },
    headers: json,
    body: chatBody,
  },
  {
    name: "openai-responses",
    method: "POST",
    path: "/v1/responses",
    keyHeaders: { authorization: "Bearer bad" },
    headers: json,
    body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
  },
  {
    name: "openai-shared-models",
    method: "GET",
    path: "/v1/models",
    keyHeaders: { "x-api-key": "bad" },
  },
  {
    name: "openai-shared-models-anthropic-version",
    method: "GET",
    path: "/v1/models",
    keyHeaders: { "x-api-key": "bad" },
    headers: { "anthropic-version": "2023-06-01" },
  },
  {
    name: "openai-bedrock",
    method: "POST",
    path: "/model/x/invoke",
    keyHeaders: { authorization: "Bearer bad" },
    headers: json,
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  },
  {
    name: "openai-ollama",
    method: "POST",
    path: "/api/chat",
    keyHeaders: { authorization: "Bearer bad" },
    headers: json,
    body: JSON.stringify({ model: "llama3", messages: [{ role: "user", content: "hi" }] }),
  },
  {
    name: "openai-openrouter-chat",
    method: "POST",
    path: "/api/v1/chat/completions",
    keyHeaders: { authorization: "Bearer bad" },
    headers: json,
    body: chatBody,
  },
  {
    name: "openai-openrouter-models",
    method: "GET",
    path: "/api/v1/models",
    keyHeaders: { authorization: "Bearer bad" },
  },
  {
    name: "replaced-anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    keyHeaders: { "x-api-key": "bad" },
    headers: { ...json, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  },
  {
    name: "replaced-gemini-generate",
    method: "POST",
    path: "/v1beta/models/gemini-2.5-flash:generateContent",
    keyHeaders: { "x-goog-api-key": "bad" },
    headers: json,
    body: geminiBody,
  },
  {
    name: "replaced-vertex-generate",
    method: "POST",
    path: "/v1/projects/p/locations/l/publishers/google/models/gemini-2.5-flash:generateContent",
    keyHeaders: { authorization: "Bearer bad" },
    headers: json,
    body: geminiBody,
  },
];

function assertRejected(got: CapturedExchange): void {
  expect(got.status).toBe(401);
  expect(got.headers["www-authenticate"]).toBeDefined();
  expect(got.headers["content-type"]).toBeDefined();
}

describe("inbound-auth 401 per route family", () => {
  for (const c of HTTP_CASES) {
    for (const variant of ["wrong-key", "missing-key"] as const) {
      const caseName = variant === "wrong-key" ? c.name : `${c.name}-missing-key`;
      it(caseName, async () => {
        const headers = {
          ...(c.headers ?? {}),
          ...(variant === "wrong-key" ? c.keyHeaders : {}),
        };
        const got = await captureHttp(`${srv.url}${c.path}`, {
          method: c.method,
          headers,
          body: c.body,
        });
        assertRejected(got);
        expectGolden(SUITE, caseName, got);
      });
    }
  }

  // The upgrade gate writes its 401 straight to the socket
  // (`writeApiKeyUpgradeRejection`), so capture the raw HTTP response.
  const upgrade = (keyLine: string): string =>
    [
      "GET /v1/realtime HTTP/1.1",
      "Host: golden",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      ...(keyLine ? [keyLine] : []),
      "",
      "",
    ].join("\r\n");

  it("openai-ws-upgrade", async () => {
    const got = await captureRawHttp(srv.url, upgrade("Authorization: Bearer bad"));
    assertRejected(got);
    expectGolden(SUITE, "openai-ws-upgrade", got);
  });

  it("openai-ws-upgrade-missing-key", async () => {
    const got = await captureRawHttp(srv.url, upgrade(""));
    assertRejected(got);
    expectGolden(SUITE, "openai-ws-upgrade-missing-key", got);
  });
});
