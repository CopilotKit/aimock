/**
 * Golden corpus: Anthropic Messages (`POST /v1/messages`) and Bedrock invoke
 * (`POST /model/{id}/invoke` and `/invoke-with-response-stream`), stream and
 * non-stream, crossed with the fixture shapes the usage and codec refactors
 * touch: no usage, token usage, alias usage, an unknown extra numeric key,
 * cache keys, tool call, thinking and an error fixture. Plus strict-mode
 * misses (503) and the strict extended-thinking violation (400 on Messages;
 * Bedrock invoke has no thinking validator and replays the fixture, 200).
 *
 * These goldens pin today's normalized bytes. A refactor must leave every
 * file unchanged.
 * Recapture only with `pnpm golden:capture src/__tests__/golden/messages-bedrock.golden.test.ts`.
 */
import type { Fixture } from "../../types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureHttp, expectGolden, startGoldenServer, type GoldenServer } from "./harness.js";

const SUITE = "messages-bedrock";
const BEDROCK_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const json = { "content-type": "application/json" };

/** One fixture per shape, matched by a unique user message. */
const shapes: Record<string, Fixture["response"]> = {
  "no-usage": { content: "Plain reply without usage." },
  "token-usage": {
    content: "Reply with token usage.",
    usage: { input_tokens: 11, output_tokens: 7 },
  },
  "alias-usage": {
    content: "Reply with alias usage.",
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  },
  "extra-key-usage": {
    content: "Reply with an extra usage key.",
    usage: { input_tokens: 1, output_tokens: 2, foo: 9 },
  },
  "cache-keys-usage": {
    content: "Reply with cache usage keys.",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 3,
      cache_creation: 5,
    },
  },
  "tool-call": {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}', id: "toolu_fixed_1" }],
  },
  thinking: {
    content: "Answer after thinking.",
    reasoning: "Let me reason about this step by step.",
  },
  error: {
    error: { message: "Slow down, golden corpus.", type: "rate_limit_error" },
    status: 429,
  },
  "usage-output-tokens-set": {
    content: "Reply with output tokens set.",
    usage: { output_tokens: 42 },
  },
};

const fixtures: Fixture[] = [
  ...Object.entries(shapes).map(([shape, response]) => ({
    match: { userMessage: `golden ${shape}` },
    response,
  })),
  // Matched only by the thinking-violation request: the matcher uses the last
  // user turn with text, and its trailing tool_result turn has none, so the
  // match is "golden violation turn". A wire that does not validate replays this.
  { match: { userMessage: "golden violation turn" }, response: { content: "Replayed anyway." } },
];

/** A tool-loop continuation whose assistant turn does not lead with thinking. */
const thinkingViolationMessages = [
  { role: "user", content: "golden violation turn" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Calling the tool." },
      { type: "tool_use", id: "toolu_fixed_2", name: "get_weather", input: { city: "Paris" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_fixed_2", content: "sunny" }],
  },
];

type Wire = "messages" | "messages-stream" | "bedrock" | "bedrock-stream";

const wires: Wire[] = ["messages", "messages-stream", "bedrock", "bedrock-stream"];

function isStream(wire: Wire): boolean {
  return wire.endsWith("-stream");
}

function urlFor(base: string, wire: Wire): string {
  switch (wire) {
    case "messages":
    case "messages-stream":
      return `${base}/v1/messages`;
    case "bedrock":
      return `${base}/model/${BEDROCK_MODEL}/invoke`;
    case "bedrock-stream":
      return `${base}/model/${BEDROCK_MODEL}/invoke-with-response-stream`;
  }
}

function bodyFor(wire: Wire, messages: unknown[], extra: Record<string, unknown> = {}): string {
  if (wire === "messages" || wire === "messages-stream") {
    return JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 256,
      stream: wire === "messages-stream",
      messages,
      ...extra,
    });
  }
  return JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 256,
    messages,
    ...extra,
  });
}

/**
 * Capture one exchange. Success responses on stream wires are split into
 * frames; error bodies (`ok === false`) are kept whole.
 */
async function capture(
  srv: GoldenServer,
  wire: Wire,
  messages: unknown[],
  opts: { ok: boolean; extra?: Record<string, unknown> },
) {
  const frames =
    isStream(wire) && opts.ok ? (wire === "messages-stream" ? "sse" : "aws") : undefined;
  const got = await captureHttp(urlFor(srv.url, wire), {
    method: "POST",
    headers: json,
    body: bodyFor(wire, messages, opts.extra),
    frames,
  });
  expect(got.tail).toBeUndefined();
  return got;
}

let srv: GoldenServer;
let strictSrv: GoldenServer;

beforeAll(async () => {
  srv = await startGoldenServer(fixtures);
  strictSrv = await startGoldenServer(fixtures, { strict: true });
});
afterAll(async () => {
  await srv.close();
  await strictSrv.close();
});

describe("fixture shapes x wires (suite: messages-bedrock)", () => {
  for (const wire of wires) {
    for (const shape of Object.keys(shapes)) {
      if (shape === "usage-output-tokens-set") continue;
      const ok = shape !== "error";
      it(`${wire}-${shape}`, async () => {
        const got = await capture(srv, wire, [{ role: "user", content: `golden ${shape}` }], {
          ok,
        });
        expect(got.status).toBe(ok ? 200 : 429);
        expectGolden(SUITE, `${wire}-${shape}`, got);
      });
    }
  }
});

describe("pinned quirks", () => {
  // On the non-misbehavior path, Bedrock invoke streaming writes
  // `usage: { output_tokens: 0 }` on `message_delta` regardless of the
  // fixture's usage.
  it("bedrock-stream-usage-output-tokens-set", async () => {
    const got = await capture(
      srv,
      "bedrock-stream",
      [{ role: "user", content: "golden usage-output-tokens-set" }],
      { ok: true },
    );
    const delta = got.frames?.find((f) =>
      (f as { decodedBytes?: string }).decodedBytes?.includes('"message_delta"'),
    ) as { decodedBytes: string } | undefined;
    expect(delta).toBeDefined();
    expect(JSON.parse(delta!.decodedBytes).usage).toEqual({ output_tokens: 0 });
    expectGolden(SUITE, "bedrock-stream-usage-output-tokens-set", got);
  });

  // Anthropic Messages streaming carries the fixture's output_tokens (42)
  // on `message_delta` instead.
  it("messages-stream-usage-output-tokens-set", async () => {
    const got = await capture(
      srv,
      "messages-stream",
      [{ role: "user", content: "golden usage-output-tokens-set" }],
      { ok: true },
    );
    const delta = got.frames?.find(
      (f): f is string => typeof f === "string" && f.startsWith("event: message_delta\n"),
    );
    expect(delta).toBeDefined();
    const data = delta!.slice(delta!.indexOf("\ndata: ") + "\ndata: ".length);
    expect((JSON.parse(data) as { usage?: unknown }).usage).toEqual({ output_tokens: 42 });
    expectGolden(SUITE, "messages-stream-usage-output-tokens-set", got);
  });
});

describe("strict mode", () => {
  for (const wire of wires) {
    it(`${wire}-strict-miss`, async () => {
      const got = await capture(strictSrv, wire, [{ role: "user", content: "golden no match" }], {
        ok: false,
      });
      expect(got.status).toBe(503);
      expectGolden(SUITE, `${wire}-strict-miss`, got);
    });
  }

  for (const wire of wires) {
    // Messages rejects the violation with 400 under strict; Bedrock invoke has
    // no thinking validator today, so it replays the matched fixture.
    const messagesWire = wire === "messages" || wire === "messages-stream";
    it(`${wire}-strict-thinking-violation`, async () => {
      const got = await capture(strictSrv, wire, thinkingViolationMessages, {
        ok: !messagesWire,
        extra: { thinking: { type: "enabled", budget_tokens: 1024 } },
      });
      expect(got.status).toBe(messagesWire ? 400 : 200);
      expectGolden(SUITE, `${wire}-strict-thinking-violation`, got);
    });
  }
});
