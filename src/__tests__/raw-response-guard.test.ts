import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { isRawResponse } from "../helpers.js";
import { LLMock } from "../llmock.js";
import type { FixtureResponse } from "../types.js";

// The internal raw-response guard and fixture kind (#549 T2).

/** Built from JSON so deliberately odd shapes need no cast. */
function response(json: string): FixtureResponse {
  return JSON.parse(json);
}

const raw = '"raw":{"wire":"openai-chat","json":{}}';

describe("isRawResponse", () => {
  it.each([
    ["a raw object", `{${raw}}`, true],
    ["a raw object with events only", '{"raw":{"wire":"anthropic","events":[]}}', true],
    ["an empty raw object (shape checked later)", '{"raw":{}}', true],
    ["raw: null", '{"raw":null}', false],
    ["raw: array", '{"raw":[]}', false],
    ["raw: string", '{"raw":"x"}', false],
    ["no raw key", '{"other":1}', false],
  ])("%s -> %s", (_label, json, expected) => {
    expect(isRawResponse(response(json))).toBe(expected);
  });

  it.each([
    "content",
    "toolCalls",
    "blocks",
    "responsesBlocks",
    "customToolCalls",
    "error",
    "embedding",
    "image",
    "images",
    "audio",
    "transcription",
    "video",
    "json",
    "live",
  ])("is false when the existing marker %s is present", (marker) => {
    expect(isRawResponse(response(`{${raw},"${marker}":null}`))).toBe(false);
  });
});

describe("raw fixture kind", () => {
  let mock: LLMock | undefined;
  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  it('/__aimock/fixtures?include=fixtures reports responseKind "raw"', async () => {
    mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    mock.addFixture({
      match: { userMessage: "x" },
      response: { raw: { wire: "openai-chat", json: { ok: true } } },
    });
    await mock.start();
    const res = await fetch(`${mock.url}/__aimock/fixtures?include=fixtures`);
    const body = (await res.json()) as { fixtures: { responseKind: string }[] };
    expect(body.fixtures.map((f) => f.responseKind)).toEqual(["raw"]);
  });
});

describe("public surface", () => {
  it("exports the RawResponse, RawWireId and WireId types", () => {
    expectTypeOf<import("../index.js").WireId>().toEqualTypeOf<import("../types.js").WireId>();
    expectTypeOf<import("../index.js").RawWireId>().toEqualTypeOf<
      Exclude<import("../types.js").WireId, "openai-realtime" | "gemini-live"> | "ollama-generate"
    >();
    expectTypeOf<import("../index.js").RawResponse>().toEqualTypeOf<
      import("../types.js").RawResponse
    >();
  });

  it("does not export isRawResponse", async () => {
    expect("isRawResponse" in (await import("../index.js"))).toBe(false);
  });
});
