/**
 * #274 slot T3 — SCOPED-OUT consumer safety for ordered `blocks`.
 *
 * The `blocks` field is honored only by the five in-scope stream builders
 * (OpenAI chat, Anthropic, Gemini, Ollama, OpenAI Responses + the WS Responses
 * dispatch). The OTHER consumers of `isContentWithToolCallsResponse` —
 * Bedrock (`/model/{id}/invoke`), Cohere (`/v2/chat`), and Gemini Interactions
 * (`/v1beta/interactions`) — were deliberately left UNCHANGED: they read only
 * `.content` / `.toolCalls` and must completely IGNORE `.blocks`.
 *
 * These tests drive each scoped-out consumer with a fixture that ALSO carries a
 * `blocks` array (in an order that differs from the legacy text-first shape).
 * The consumer must NOT crash and must serve the legacy `{content, toolCalls}`
 * payload exactly as if `blocks` were absent.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture, FixtureBlock } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// A combined content+toolCalls fixture that ALSO carries a tool-first `blocks`
// array — the exact shape the scoped-out consumers must ignore.
const toolFirstBlocks: FixtureBlock[] = [
  { type: "toolCall", name: "get_weather", arguments: '{"city":"SF"}' },
  { type: "text", text: "Let me help you" },
];

const blocksBearingFixture: Fixture = {
  match: { userMessage: "scoped-out blocks" },
  response: {
    content: "Let me help you",
    toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
    blocks: toolFirstBlocks,
  },
};

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

describe("#274 scoped-out consumers ignore `blocks` without crashing", () => {
  it("Bedrock /model/{id}/invoke serves legacy content+tool_use, ignoring blocks", async () => {
    instance = await createServer([blocksBearingFixture]);
    const res = await post(
      `${instance.url}/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: "scoped-out blocks" }],
      },
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("message");
    // Legacy text-first Anthropic shape: text content then tool_use — NOT the
    // tool-first ordering carried in `blocks` (which Bedrock must ignore).
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBe("Let me help you");
    expect(body.content[1].type).toBe("tool_use");
    expect(body.content[1].name).toBe("get_weather");
    expect(body.content[1].input).toEqual({ city: "SF" });
    expect(body.stop_reason).toBe("tool_use");
  });

  it("Cohere /v2/chat serves legacy content+tool_calls, ignoring blocks", async () => {
    instance = await createServer([blocksBearingFixture]);
    const res = await post(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "scoped-out blocks" }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    // Cohere reads only content/toolCalls; blocks is ignored, no crash.
    expect(body.message.tool_calls).toHaveLength(1);
    expect(body.message.tool_calls[0].function.name).toBe("get_weather");
    expect(body.message.tool_calls[0].function.arguments).toBe('{"city":"SF"}');
  });

  it("Gemini Interactions /v1beta/interactions serves legacy steps, ignoring blocks", async () => {
    instance = await createServer([blocksBearingFixture]);
    const res = await post(`${instance.url}/v1beta/interactions`, {
      model: "gemini-2.5-flash",
      input: "scoped-out blocks",
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    // Reads only content/toolCalls; blocks is ignored, no crash.
    expect(body.status).toBe("requires_action");
    expect(body.output_text).toBe("Let me help you");
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].type).toBe("model_output");
    expect(body.steps[1].type).toBe("function_call");
    expect(body.steps[1].name).toBe("get_weather");
  });
});
