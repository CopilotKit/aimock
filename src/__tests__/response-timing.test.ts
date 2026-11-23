import { describe, expect, it } from "vitest";
import {
  extendRecordedTimings,
  misbehaviorPayloadLength,
  nonStreamingDelayMs,
  nonStreamingTimingEnabled,
  responsesOutputFrames,
  responsesPayloadLength,
  servedPayloadLength,
} from "../response/timing.js";
import { calculateTotalDelay } from "../sse-writer.js";
import { LLMock } from "../llmock.js";
import type { Fixture, FixtureResponse, RecordedTimings } from "../types.js";

const profile = { ttft: 300, tps: 10 };
const recorded: RecordedTimings = {
  ttftMs: 100,
  interChunkDelaysMs: [10, 20, 30],
  totalDurationMs: 160,
};

function fixture(extra: Partial<Fixture>): Fixture {
  return { match: {}, response: { content: "hi" }, ...extra };
}

describe("nonStreamingTimingEnabled", () => {
  const surfaces = ["openai-chat", "other"] as const;

  it("is off on both surfaces when neither field is set or both are false", () => {
    for (const surface of surfaces) {
      expect(nonStreamingTimingEnabled(fixture({ streamingProfile: profile }), surface)).toBe(
        false,
      );
      expect(
        nonStreamingTimingEnabled(
          fixture({
            streamingProfile: profile,
            nonStreamingTiming: false,
            nonStreamingTimingAllProviders: false,
          }),
          surface,
        ),
      ).toBe(false);
    }
  });

  it("nonStreamingTiming: true is on for openai-chat only", () => {
    const f = fixture({ streamingProfile: profile, nonStreamingTiming: true });
    expect(nonStreamingTimingEnabled(f, "openai-chat")).toBe(true);
    expect(nonStreamingTimingEnabled(f, "other")).toBe(false);
  });

  it("nonStreamingTimingAllProviders: true is on for both, with or without nonStreamingTiming", () => {
    for (const nonStreamingTiming of [undefined, false, true]) {
      const f = fixture({
        recordedTimings: recorded,
        nonStreamingTimingAllProviders: true,
        nonStreamingTiming,
      });
      expect(nonStreamingTimingEnabled(f, "openai-chat")).toBe(true);
      expect(nonStreamingTimingEnabled(f, "other")).toBe(true);
    }
  });

  it("nonStreamingTimingAllProviders: false never turns off nonStreamingTiming: true on OpenAI", () => {
    const f = fixture({
      streamingProfile: profile,
      nonStreamingTiming: true,
      nonStreamingTimingAllProviders: false,
    });
    expect(nonStreamingTimingEnabled(f, "openai-chat")).toBe(true);
    expect(nonStreamingTimingEnabled(f, "other")).toBe(false);
  });

  it("treats non-boolean values of either field as off", () => {
    const f = {
      ...fixture({ streamingProfile: profile }),
      nonStreamingTiming: "yes",
      nonStreamingTimingAllProviders: "yes",
    } as unknown as Fixture;
    expect(nonStreamingTimingEnabled(f, "openai-chat")).toBe(false);
    expect(nonStreamingTimingEnabled(f, "other")).toBe(false);
  });

  it("is off without a streamingProfile or recordedTimings, even when opted in", () => {
    const f = fixture({
      latency: 500,
      nonStreamingTiming: true,
      nonStreamingTimingAllProviders: true,
    });
    expect(nonStreamingTimingEnabled(f, "openai-chat")).toBe(false);
    expect(nonStreamingTimingEnabled(f, "other")).toBe(false);
  });
});

describe("nonStreamingDelayMs", () => {
  it("wraps calculateTotalDelay with the fixture profile and the given timings", () => {
    const f = fixture({ streamingProfile: profile });
    expect(nonStreamingDelayMs(f, 25, 10, undefined, 1)).toBe(
      calculateTotalDelay(25, 10, profile, undefined, 1),
    );
    expect(nonStreamingDelayMs(fixture({}), 25, 10, recorded, 2)).toBe(
      calculateTotalDelay(25, 10, undefined, recorded, 2),
    );
  });

  it("gives 0 for bare latency", () => {
    expect(nonStreamingDelayMs(fixture({ latency: 2000 }), 100, 5, undefined, 1)).toBe(0);
  });
});

// The OpenAI chat formulas this must equal (src/server.ts at the base SHA):
//   text      (effReasoning?.length ?? 0) + response.content.length
//   tool      (effReasoning?.length ?? 0) + Σ(tc.name + tc.arguments)
//   combined  (effReasoning?.length ?? 0) + content + Σ(tc.name + tc.arguments),
//             blocks resolved through resolveFixtureBlockOutcome
describe("servedPayloadLength", () => {
  it("text: reasoning + content", () => {
    expect(servedPayloadLength({ content: "Hello world" })).toBe(11);
    expect(servedPayloadLength({ content: "Hello world" }, "Think.")).toBe(17);
  });

  it("tool calls: reasoning + each name + arguments", () => {
    const r: FixtureResponse = {
      toolCalls: [
        { name: "get_weather", arguments: '{"city":"NYC"}' },
        { name: "t", arguments: "{}" },
      ],
    };
    expect(servedPayloadLength(r)).toBe(11 + 14 + 1 + 2);
    expect(servedPayloadLength(r, "abc")).toBe(3 + 11 + 14 + 1 + 2);
  });

  it("combined: content + each tool call", () => {
    const r: FixtureResponse = {
      content: "Checking.",
      toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
    };
    expect(servedPayloadLength(r, "r")).toBe(1 + 9 + 11 + 13);
  });

  it("blocks: resolved text plus each tool block, ignoring the legacy fields", () => {
    const r: FixtureResponse = {
      blocks: [
        { type: "text", text: "Lead." },
        { type: "toolCall", name: "get_time", arguments: "{}" },
        { type: "text", text: "Tail." },
      ],
    };
    expect(servedPayloadLength(r)).toBe(5 + 5 + 8 + 2);
    expect(servedPayloadLength(r, "abc")).toBe(3 + 5 + 5 + 8 + 2);
  });

  it("blocks win over the legacy content and toolCalls fields", () => {
    const r: FixtureResponse = {
      content: "legacy content",
      toolCalls: [{ name: "legacy_tool", arguments: '{"a":1}' }],
      blocks: [{ type: "text", text: "Block." }],
    };
    expect(servedPayloadLength(r, "rr")).toBe(2 + 6);
  });

  it("gives just the reasoning length for a response with no served text", () => {
    expect(servedPayloadLength({ error: { message: "x", type: "y" } }, "ab")).toBe(2);
  });
});

describe("responsesPayloadLength", () => {
  it("counts customToolCalls after toolCalls: each name + input", () => {
    const r: FixtureResponse = {
      toolCalls: [{ name: "f", arguments: "{}" }],
      customToolCalls: [{ type: "custom", name: "apply_patch", input: "patch body" }],
    };
    expect(responsesPayloadLength(r, "ab")).toBe(2 + 1 + 2 + 11 + 10);
    // OpenAI chat's length leaves the custom call out.
    expect(servedPayloadLength(r, "ab")).toBe(2 + 1 + 2);
  });

  it("resolves responsesBlocks, custom calls included", () => {
    const r: FixtureResponse = {
      responsesBlocks: [
        { type: "text", text: "Lead." },
        { type: "customToolCall", name: "run", input: "ls -la" },
      ],
    };
    expect(responsesPayloadLength(r)).toBe(5 + 3 + 6);
  });

  it("takes responsesBlocks over blocks, as the Responses wire serves", () => {
    const r: FixtureResponse = {
      blocks: [{ type: "text", text: "x" }],
      responsesBlocks: [{ type: "text", text: "Served text." }],
    };
    expect(responsesPayloadLength(r)).toBe(12);
    expect(servedPayloadLength(r)).toBe(1);
  });

  it("equals servedPayloadLength for a fixture without the Responses keys", () => {
    const rows: FixtureResponse[] = [
      { content: "Hello world" },
      { toolCalls: [{ name: "t", arguments: "{}" }] },
      { content: "c", toolCalls: [{ name: "t", arguments: "{}" }] },
      { blocks: [{ type: "toolCall", name: "get_time", arguments: "{}" }] },
    ];
    for (const r of rows) expect(responsesPayloadLength(r, "r")).toBe(servedPayloadLength(r, "r"));
  });

  it("is the length misbehaviorPayloadLength uses when passed", () => {
    const plan = {
      response: {
        toolCalls: [],
        customToolCalls: [{ type: "custom" as const, name: "run", input: "ls" }],
      } as FixtureResponse,
    };
    expect(misbehaviorPayloadLength(plan, undefined, responsesPayloadLength)).toBe(5);
    expect(misbehaviorPayloadLength(plan, undefined)).toBe(0);
  });
});

describe("responsesOutputFrames", () => {
  const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };
  const url = { url: "https://example.com/a" };

  it("counts one frame per citation and five per generated file on a text turn", () => {
    const r: FixtureResponse = { content: "Cited.", citations: [url, url], files: [png] };
    expect(responsesOutputFrames(r)).toBe(2 + 5);
  });

  it("counts them on a combined turn", () => {
    const r: FixtureResponse = {
      content: "Cited.",
      toolCalls: [{ name: "t", arguments: "{}" }],
      citations: [url],
      files: [png, png],
    };
    expect(responsesOutputFrames(r)).toBe(1 + 10);
  });

  it("counts files but no citations on a tool-only turn", () => {
    const r: FixtureResponse = { toolCalls: [{ name: "t", arguments: "{}" }], files: [png] };
    expect(responsesOutputFrames(r)).toBe(5);
  });

  it("is 0 without citations or files, and never throws on a malformed value", () => {
    expect(responsesOutputFrames({ content: "plain" })).toBe(0);
    const malformed = { content: "x", citations: "nope", files: 7 } as unknown as FixtureResponse;
    expect(responsesOutputFrames(malformed)).toBe(0);
    expect(responsesOutputFrames({ error: { message: "x", type: "y" } })).toBe(0);
  });
});

describe("misbehaviorPayloadLength", () => {
  const text: FixtureResponse = { content: "The full answer." };
  const tools: FixtureResponse = { toolCalls: [{ name: "f", arguments: "{}" }] };

  it("matches OpenAI's selection for the three stop plans on a text response", () => {
    expect(
      misbehaviorPayloadLength({ response: text, stop: "refusal", refusal: "No." }, "rr"),
    ).toBe(3);
    expect(misbehaviorPayloadLength({ response: text, stop: "refusal" }, "rr")).toBe(0);
    expect(misbehaviorPayloadLength({ response: text, stop: "content_filter" }, "rr")).toBe(0);
    expect(misbehaviorPayloadLength({ response: text, reasoning: "thinking..." }, "rr")).toBe(11);
  });

  it("refusal wins over reasoning, as in OpenAI's selection order", () => {
    expect(
      misbehaviorPayloadLength(
        { response: text, stop: "refusal", refusal: "No", reasoning: "long reasoning" },
        undefined,
      ),
    ).toBe(2);
  });

  it("gives the served length when the response is not a text response", () => {
    expect(
      misbehaviorPayloadLength({ response: tools, stop: "refusal", refusal: "No." }, "rr"),
    ).toBe(servedPayloadLength(tools, "rr"));
    expect(misbehaviorPayloadLength({ response: tools, reasoning: "xyz" }, undefined)).toBe(
      servedPayloadLength(tools),
    );
  });

  it("gives the served length for other faults on a text response", () => {
    expect(misbehaviorPayloadLength({ response: text, stop: "length" }, "rr")).toBe(
      servedPayloadLength(text, "rr"),
    );
  });
});

describe("extendRecordedTimings", () => {
  it("extends the gaps to frameCount - 1 by repeating the last gap (hand-computed)", () => {
    const empty = { ...recorded, interChunkDelaysMs: [] };
    const cases: Array<[RecordedTimings, number, number[]]> = [
      [recorded, 0, [10, 20, 30]],
      [recorded, 1, [10, 20, 30]],
      [recorded, 4, [10, 20, 30]],
      [recorded, 6, [10, 20, 30, 30, 30]],
      [recorded, 9, [10, 20, 30, 30, 30, 30, 30, 30]],
      [empty, 0, []],
      [empty, 4, [0, 0, 0]],
    ];
    for (const [t, frames, gaps] of cases) {
      expect(extendRecordedTimings(t, frames, true)).toEqual({ ...t, interChunkDelaysMs: gaps });
    }
    expect(extendRecordedTimings(undefined, 9, true)).toBeUndefined();
    expect(extendRecordedTimings(undefined, 9, false)).toBeUndefined();
  });

  it("returns the same object when not a duplicate plan", () => {
    expect(extendRecordedTimings(recorded, 9, false)).toBe(recorded);
  });

  it("gives the hand-computed non-stream total for a K4 plan on OpenAI chat and on another provider", () => {
    // The shared misbehavior path: chunkCount = max(1, ceil(len / chunkSize)),
    // then extendRecordedTimings, then nonStreamingDelayMs. OpenAI chat and a
    // non-OpenAI provider feed it the same fixture-level inputs.
    const f = fixture({
      recordedTimings: { ttftMs: 5, interChunkDelaysMs: [1, 9], totalDurationMs: 15 },
      nonStreamingTimingAllProviders: true,
    });
    const plan = {
      response: {
        toolCalls: [
          { name: "a", arguments: '{"x":1}', id: "c1" },
          { name: "b", arguments: '{"y":2}', id: "c1" },
        ],
      } as FixtureResponse,
    };
    // "a" + '{"x":1}' + "b" + '{"y":2}' = 16 chars; at chunkSize 3 that is
    // 6 chunks, so the recorded gaps [1, 9] are extended to 5 gaps.
    const length = misbehaviorPayloadLength(plan, undefined);
    expect(length).toBe(16);
    const extended = extendRecordedTimings(f.recordedTimings, Math.max(1, Math.ceil(16 / 3)), true);
    expect(extended?.interChunkDelaysMs).toEqual([1, 9, 9, 9, 9]);
    // An empty payload is clamped to one chunk: no gap is added.
    const emptyExtended = extendRecordedTimings(f.recordedTimings, Math.max(1, 0), true);
    expect(emptyExtended?.interChunkDelaysMs).toEqual([1, 9]);
    for (const surface of ["openai-chat", "other"] as const) {
      expect(nonStreamingTimingEnabled(f, surface)).toBe(true);
      // ttft 5 + 1 + 4 gaps of 9 = 42. Unextended, the 3 extra chunks would
      // average the recorded gaps (5): 5 + 1 + 9 + 3 * 5 = 30.
      expect(nonStreamingDelayMs(f, length, 3, extended, 1)).toBe(42);
      expect(nonStreamingDelayMs(f, length, 3, f.recordedTimings, 1)).toBe(30);
      // An empty payload still pays one chunk (the Math.max(1, …) clamp): ttft 5.
      expect(nonStreamingDelayMs(f, 0, 3, emptyExtended, 1)).toBe(5);
    }
  });
});

describe("recordedTimings with a missing optional field, over HTTP", () => {
  // A fixture built in code can omit `interChunkDelaysMs` (the file loader
  // fills it in; `addFixture` does not). Each row is what base 508dd9b9
  // answered for the same request. Base never waited on a non-streaming
  // reply unless `nonStreamingTiming: true` was set on OpenAI chat, so every
  // other non-streaming row must answer 200.
  const content = "x".repeat(40);
  const noGaps: Partial<RecordedTimings> = { ttftMs: 1, totalDurationMs: 1 };
  const noTtft: Partial<RecordedTimings> = { interChunkDelaysMs: [1, 1], totalDurationMs: 2 };
  const flags = {
    off: {},
    nonStreamingTiming: { nonStreamingTiming: true },
    allProviders: { nonStreamingTimingAllProviders: true },
    both: { nonStreamingTiming: true, nonStreamingTimingAllProviders: true },
  } as const;
  type FlagName = keyof typeof flags;
  type Row = {
    provider: "openai" | "anthropic";
    stream: boolean;
    flag: FlagName;
    timings: "noGaps" | "noTtft";
    duplicate?: boolean;
    status: number;
  };

  // Base 500s only where it summed the gaps: OpenAI chat, stream:false,
  // nonStreamingTiming: true, with more than one chunk.
  const baseStatus = (r: Omit<Row, "status">): number =>
    r.provider === "openai" &&
    !r.stream &&
    r.timings === "noGaps" &&
    (r.flag === "nonStreamingTiming" || r.flag === "both")
      ? 500
      : 200;
  const rows: Row[] = [];
  for (const provider of ["openai", "anthropic"] as const)
    for (const stream of [false, true])
      for (const flag of Object.keys(flags) as FlagName[])
        for (const timings of ["noGaps", "noTtft"] as const) {
          const row = { provider, stream, flag, timings };
          rows.push({ ...row, status: baseStatus(row) });
        }
  for (const flag of Object.keys(flags) as FlagName[]) {
    const row = {
      provider: "openai" as const,
      stream: false,
      flag,
      timings: "noGaps" as const,
      duplicate: true,
    };
    rows.push({ ...row, status: baseStatus(row) });
  }

  const key = (r: Omit<Row, "status">) =>
    `${r.provider}-${r.stream ? "stream" : "json"}-${r.flag}-${r.timings}${r.duplicate ? "-dup" : ""}`;

  it.each(rows.map((r) => [key(r), r] as const))("%s answers as base did", async (_, row) => {
    const timings = row.timings === "noGaps" ? noGaps : noTtft;
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixture({
      match: { userMessage: key(row) },
      response: row.duplicate
        ? {
            toolCalls: [
              { name: "a", arguments: content },
              { name: "b", arguments: content },
            ],
          }
        : { content },
      chunkSize: 4,
      recordedTimings: timings as RecordedTimings,
      ...(row.duplicate ? { misbehavior: "tool-call-id-duplicate" as const } : {}),
      ...flags[row.flag],
    });
    const url = await mock.start();
    try {
      const messages = [{ role: "user", content: key(row) }];
      const res =
        row.provider === "openai"
          ? await fetch(`${url}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: "gpt-4o", stream: row.stream, messages }),
            })
          : await fetch(`${url}/v1/messages`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": "k",
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 64,
                stream: row.stream,
                messages,
              }),
            });
      expect(res.status).toBe(row.status);
      // A streamed reply with no gaps is cut short on base too (the frame
      // loop reads the missing array); only its status is pinned here.
      if (row.stream && row.timings === "noGaps") {
        await res.body?.cancel();
        return;
      }
      const body = await res.text();
      if (row.status === 200 && !row.duplicate)
        expect(body).toContain(row.stream ? "xxxx" : content);
    } finally {
      await mock.stop();
    }
  });
});
