import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture } from "../types.js";

// Base (508dd9b9) served every one of these chunkSize values: the callers
// clamp with Math.max(1, ...), so 0 and -1 become 1, and a value that is not
// a number becomes NaN, which sized a zero non-streaming wait. These rows hold
// that behavior over HTTP, through code-built fixtures and server options.

// A fixture or server option built in code (or loaded from JSON) can carry a
// non-numeric chunkSize at runtime, even though the type says number.
const NOT_A_NUMBER = "abc" as unknown as number;

const VALUES: Array<[string, number | undefined]> = [
  ["NaN", Number.NaN],
  ['"abc"', NOT_A_NUMBER],
  ["0", 0],
  ["-1", -1],
  ["undefined", undefined],
];
const PROVIDERS = ["openai", "anthropic"] as const;
const TIMINGS = ["off", "nonStreamingTiming", "nonStreamingTimingAllProviders"] as const;
const WHERE = ["fixture", "server"] as const;

const TTFT = 300;

type Provider = (typeof PROVIDERS)[number];

const rows = WHERE.flatMap((where) =>
  VALUES.flatMap(([label, value]) =>
    PROVIDERS.flatMap((provider) =>
      [false, true].flatMap((stream) =>
        TIMINGS.map((timing) => ({ where, label, value, provider, stream, timing })),
      ),
    ),
  ),
);

function request(url: string, provider: Provider, stream: boolean): Promise<Response> {
  const isOpenAI = provider === "openai";
  return fetch(`${url}${isOpenAI ? "/v1/chat/completions" : "/v1/messages"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: isOpenAI ? "gpt-4o" : "claude-3",
      ...(isOpenAI ? {} : { max_tokens: 10 }),
      stream,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

function nonStreamingContent(provider: Provider, json: unknown): unknown {
  if (provider === "openai") {
    return (json as { choices: Array<{ message: { content: unknown } }> }).choices[0].message
      .content;
  }
  return (json as { content: Array<{ text: unknown }> }).content[0].text;
}

describe("an invalid chunkSize is served as base served it", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  it.each(rows)(
    "$where chunkSize $label, $provider, stream=$stream, timing=$timing",
    async ({ where, value, provider, stream, timing }) => {
      mock = new LLMock({ port: 0, ...(where === "server" && { chunkSize: value }) });
      const fixture: Fixture = {
        match: { userMessage: "hi" },
        response: { content: "hello world" },
        ...(where === "fixture" && value !== undefined && { chunkSize: value }),
        ...(timing !== "off" && { streamingProfile: { ttft: TTFT, tps: 1000 } }),
        ...(timing === "nonStreamingTiming" && { nonStreamingTiming: true }),
        ...(timing === "nonStreamingTimingAllProviders" && {
          nonStreamingTimingAllProviders: true,
        }),
      };
      mock.addFixture(fixture);
      await mock.start();

      const started = Date.now();
      const res = await request(mock.url, provider, stream);
      const text = await res.text();
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      if (stream) return;
      expect(nonStreamingContent(provider, JSON.parse(text))).toBe("hello world");
      if (timing === "off") return;
      // A non-numeric chunkSize clamps to NaN, which base sized as a zero wait.
      const nonNumeric = value !== undefined && Number.isNaN(Number(value));
      const waits =
        !nonNumeric &&
        (timing === "nonStreamingTimingAllProviders" ||
          (timing === "nonStreamingTiming" && provider === "openai"));
      if (waits) expect(elapsed).toBeGreaterThanOrEqual(TTFT - 50);
      else expect(elapsed).toBeLessThan(TTFT - 50);
    },
  );
});
