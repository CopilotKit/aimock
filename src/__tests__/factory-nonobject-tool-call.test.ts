/**
 * A `toolCalls` entry that is not an object (a string, a number, an array,
 * `null`) is served exactly as 1.44.0 served it, from a static or a factory
 * fixture: no new request-time guard and no new error code. Chat Completions
 * emits the entry as a (malformed) tool call; the Responses API fails with the
 * uncoded "arguments must be a string" 500; a `null` entry fails where the
 * builder first reads it (a factory's normalization reports it as "Response
 * factory threw"). The new Responses-only `customToolCalls` key is guarded: a
 * non-object entry there is a coded 500.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { FixtureResponse } from "../types.js";

let mock: LLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const CHAT = { model: "gpt-4o", messages: [{ role: "user", content: "go" }] };
const RESPONSES = { model: "gpt-5", input: "go" };
const ARGS_ERROR = 'Invalid fixture tool call: "arguments" must be a string after normalization';

async function post(m: LLMock, path: string, body: Record<string, unknown>) {
  const res = await fetch(`${m.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, text: await res.text() };
}

async function serve(
  response: unknown,
  kind: "static" | "factory",
  responsesTools?: "legacy" | "extended",
): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent", responsesTools });
  const r = response as FixtureResponse;
  mock.addFixture({ match: { userMessage: "go" }, response: kind === "factory" ? () => r : r });
  await mock.start();
  return mock;
}

describe("non-object toolCalls entries serve as in 1.44.0", () => {
  for (const bad of ["oops", 5, [], ["x"]]) {
    for (const kind of ["static", "factory"] as const) {
      it(`${JSON.stringify(bad)} (${kind}): Chat Completions 200, Responses uncoded 500`, async () => {
        const m = await serve({ toolCalls: [bad] }, kind);
        const chat = await post(m, "/v1/chat/completions", CHAT);
        expect(chat.status, chat.text).toBe(200);
        expect(chat.text).toContain('"tool_calls"');
        const responses = await post(m, "/v1/responses", RESPONSES);
        expect(responses.status).toBe(500);
        expect(JSON.parse(responses.text)).toEqual({
          error: { message: ARGS_ERROR, type: "server_error" },
        });
        const entry = m.getRequests().at(-1);
        expect(entry?.response.status).toBe(500);
        expect(entry?.response.error).toBeUndefined();
      });
    }
  }

  it("a null entry fails where the builder reads it (static) or in factory normalization", async () => {
    let m = await serve({ toolCalls: [null] }, "static");
    expect(JSON.parse((await post(m, "/v1/chat/completions", CHAT)).text).error.message).toBe(
      "Cannot read properties of null (reading 'name')",
    );
    expect(JSON.parse((await post(m, "/v1/responses", RESPONSES)).text).error.message).toBe(
      "Cannot read properties of null (reading 'id')",
    );
    await m.stop();
    m = await serve({ toolCalls: [null] }, "factory");
    for (const [path, body] of [
      ["/v1/chat/completions", CHAT],
      ["/v1/responses", RESPONSES],
    ] as const) {
      const r = await post(m, path, body);
      expect(r.status).toBe(500);
      expect(JSON.parse(r.text).error.message).toBe(
        "Response factory threw: Cannot read properties of null (reading 'arguments')",
      );
    }
  });
});

describe("a non-object customToolCalls entry is a coded 500 on the Responses API", () => {
  for (const kind of ["static", "factory"] as const) {
    it(`(${kind})`, async () => {
      const m = await serve({ toolCalls: [], customToolCalls: ["oops"] }, kind, "extended");
      for (const stream of [false, true]) {
        const r = await post(m, "/v1/responses", { ...RESPONSES, stream });
        expect(r.status).toBe(500);
        const message = "Invalid fixture tool call: expected an object (customToolCalls[0])";
        expect(JSON.parse(r.text)).toEqual({
          error: { message, type: "server_error", code: "aimock_invalid_fixture_tool_call" },
        });
        expect(m.getRequests().at(-1)?.response).toMatchObject({ status: 500, error: message });
      }
    });
  }
});

describe("non-object blocks entries keep the 1.44.0 block errors", () => {
  it("a string block: static reports a non-object; a factory spreads it first (1.44.0)", async () => {
    let m = await serve({ blocks: ["oops"] }, "static");
    let res = await post(m, "/v1/responses", RESPONSES);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text).error.message).toBe(
      "Invalid fixture block at index 0: expected an object",
    );
    await m.stop();
    m = await serve({ blocks: ["oops"] }, "factory");
    res = await post(m, "/v1/responses", RESPONSES);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text).error.message).toBe(
      'Invalid fixture block at index 0: unknown type undefined (expected "text" or "toolCall")',
    );
  });
});
