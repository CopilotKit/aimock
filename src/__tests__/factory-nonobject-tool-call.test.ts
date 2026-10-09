/**
 * A factory fixture that returns a non-object `toolCalls` entry fails the same
 * way a static fixture does: a 500 with code aimock_invalid_fixture_tool_call
 * in the wire's error envelope, and a journal entry that records the error.
 * Factory normalization must not spread a string or number entry into an
 * object, or throw on a null entry, before the request-time guard runs. An
 * array entry is not an object either: it gets the same coded error, for
 * static and factory fixtures alike.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture, FixtureResponse } from "../types.js";

let mock: LLMock | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const CHAT = { model: "gpt-4o", messages: [{ role: "user", content: "go" }] };
const RESPONSES = { model: "gpt-5", input: "go" };
const MESSAGE = "Invalid fixture tool call: expected an object (toolCalls[0])";

async function post(m: LLMock, path: string, body: Record<string, unknown>) {
  const res = await fetch(`${m.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, text: await res.text() };
}

describe("factory fixture with a non-object toolCalls entry", () => {
  for (const bad of ["oops", 5, null]) {
    for (const [wire, path, body] of [
      ["Responses", "/v1/responses", RESPONSES],
      ["Chat Completions", "/v1/chat/completions", CHAT],
    ] as const) {
      it(`${JSON.stringify(bad)} on ${wire} gets the coded error and is journaled`, async () => {
        mock = new LLMock({ port: 0, logLevel: "silent" });
        const fixture: Fixture = {
          match: { userMessage: "go" },
          response: () => ({ toolCalls: [bad] }) as unknown as FixtureResponse,
        };
        mock.addFixture(fixture);
        await mock.start();

        const res = await post(mock, path, body);
        expect(res.status).toBe(500);
        expect(JSON.parse(res.text)).toEqual({
          error: {
            message: MESSAGE,
            type: "server_error",
            code: "aimock_invalid_fixture_tool_call",
          },
        });
        const entry = mock.getRequests().at(-1);
        expect(entry?.response.status).toBe(500);
        expect(entry?.response.error).toBe(MESSAGE);
      });
    }
  }
});

describe("factory fixture with a non-object blocks entry", () => {
  it("reports the same problem as a static fixture", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixture({
      match: { userMessage: "go" },
      response: () => ({ blocks: ["oops"] }) as unknown as FixtureResponse,
    });
    await mock.start();

    const res = await post(mock, "/v1/responses", RESPONSES);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text).error.message).toBe(
      "Invalid fixture block at index 0: expected an object",
    );
  });
});

describe("array toolCalls entry, static and factory", () => {
  for (const bad of [[], ["x"]]) {
    for (const kind of ["static", "factory"] as const) {
      for (const [wire, path, body] of [
        ["Responses", "/v1/responses", RESPONSES],
        ["Chat Completions", "/v1/chat/completions", CHAT],
      ] as const) {
        it(`${JSON.stringify(bad)} (${kind}) on ${wire} gets the coded error and is journaled`, async () => {
          mock = new LLMock({ port: 0, logLevel: "silent" });
          const response = { toolCalls: [bad] } as unknown as FixtureResponse;
          mock.addFixture({
            match: { userMessage: "go" },
            response: kind === "factory" ? () => response : response,
          });
          await mock.start();

          const res = await post(mock, path, body);
          expect(res.status).toBe(500);
          expect(JSON.parse(res.text)).toEqual({
            error: {
              message: MESSAGE,
              type: "server_error",
              code: "aimock_invalid_fixture_tool_call",
            },
          });
          const entry = mock.getRequests().at(-1);
          expect(entry?.response.status).toBe(500);
          expect(entry?.response.error).toBe(MESSAGE);
        });
      }
    }
  }
});

describe("array blocks entry, static and factory", () => {
  for (const kind of ["static", "factory"] as const) {
    for (const [wire, path, body] of [
      ["Responses", "/v1/responses", RESPONSES],
      ["Chat Completions", "/v1/chat/completions", CHAT],
    ] as const) {
      it(`(${kind}) on ${wire} reports "expected an object"`, async () => {
        mock = new LLMock({ port: 0, logLevel: "silent" });
        const response = { blocks: [["x"]] } as unknown as FixtureResponse;
        mock.addFixture({
          match: { userMessage: "go" },
          response: kind === "factory" ? () => response : response,
        });
        await mock.start();

        const res = await post(mock, path, body);
        expect(res.status).toBe(500);
        expect(JSON.parse(res.text).error.message).toBe(
          "Invalid fixture block at index 0: expected an object",
        );
      });
    }
  }
});
