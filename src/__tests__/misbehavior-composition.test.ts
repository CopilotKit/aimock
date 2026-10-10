import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { expect, test, vi } from "vitest";
import * as sseWriter from "../sse-writer.js";
import type { Fixture, FixtureFile } from "../types.js";
import { LLMock } from "./helpers/misbehavior-enabled.js";

const testId = "recording-lifecycle";
const upstreamArguments = { city: "Tokyo" };

function clientFor(url: string) {
  return new OpenAI({ apiKey: "local", baseURL: `${url}/v1`, maxRetries: 0, timeout: 5000 });
}

function requestFor(message: string): OpenAI.ChatCompletionCreateParamsNonStreaming {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: message }],
    tools: [
      {
        type: "function",
        function: {
          name: "weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
  };
}

test("recording keeps upstream truth, merges authored faults, and replays under a runtime scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aimock-misbehavior-recording-"));
  const snapshotPath = join(dir, testId, "openai.json");
  const preserved = {
    match: { userMessage: "authored old entry" },
    response: { content: "preserved text" },
    misbehavior: { seed: 77, faults: [{ fault: "empty-response" }] },
  };
  const upstream = new LLMock({ port: 0, logLevel: "silent" });
  const replay = new LLMock({ port: 0, logLevel: "silent" });
  let recorder: LLMock | undefined;
  let upstreamStarted = false;
  let recorderStarted = false;
  let replayStarted = false;
  try {
    await mkdir(join(dir, testId));
    await writeFile(snapshotPath, JSON.stringify({ fixtures: [preserved] }));
    upstream.addFixture({
      match: { userMessage: "record tools" },
      response: {
        toolCalls: [
          { id: "call_upstream", name: "weather", arguments: JSON.stringify(upstreamArguments) },
        ],
      },
    });
    upstream.addFixture({
      match: { userMessage: "record text" },
      response: { content: "Upstream truth stays intact" },
    });
    const upstreamUrl = await upstream.start();
    upstreamStarted = true;
    recorder = new LLMock({
      port: 0,
      logLevel: "silent",
      misbehavior: "empty-response",
      record: { providers: { openai: upstreamUrl }, fixturePath: dir },
    });
    const recordClient = clientFor(await recorder.start());
    recorderStarted = true;
    const headers = { "x-test-id": testId };
    const tools = await recordClient.chat.completions.create(requestFor("record tools"), {
      headers,
    });
    const text = await recordClient.chat.completions.create(requestFor("record text"), { headers });
    expect(tools.choices[0].message.tool_calls).toEqual([
      {
        id: "call_upstream",
        type: "function",
        function: { name: "weather", arguments: JSON.stringify(upstreamArguments) },
      },
    ]);
    expect(text.choices[0].message.content).toBe("Upstream truth stays intact");
    expect(upstream.getRequests()).toHaveLength(2);
    const captured = recorder.getRequests();
    expect(captured).toHaveLength(2);
    for (const entry of captured) {
      expect(entry.response).toMatchObject({ status: 200, source: "proxy", fixture: null });
      expect.soft(entry.response.misbehavior).toEqual({
        applied: false,
        source: "server",
        wire: "openai-chat",
        reason: "proxied",
        evaluations: [],
      });
    }
    const snapshotBeforeReplay = await readFile(snapshotPath, "utf8");
    const snapshot: FixtureFile = JSON.parse(snapshotBeforeReplay);
    expect(snapshot.fixtures).toHaveLength(3);
    expect(snapshot.fixtures[0]).toEqual(preserved);
    expect(snapshot.fixtures.slice(1).every((entry) => !Object.hasOwn(entry, "misbehavior"))).toBe(
      true,
    );
    expect(snapshot.fixtures[1].response).toHaveProperty(
      "toolCalls.0.arguments",
      JSON.stringify(upstreamArguments),
    );
    expect(snapshot.fixtures[2].response).toHaveProperty("content", "Upstream truth stays intact");
    await recorder.stop();
    recorderStarted = false;
    await upstream.stop();
    upstreamStarted = false;

    replay.loadFixtureFile(snapshotPath);
    const replayUrl = await replay.start();
    replayStarted = true;
    const replayClient = clientFor(replayUrl);
    const configured = await fetch(`${replayUrl}/__aimock/misbehavior`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ seed: 19, faults: [{ fault: "tool-args-invalid-json", times: 1 }] }),
    });
    expect(configured.status).toBe(200);
    const faulted = await replayClient.chat.completions.create(requestFor("record tools"), {
      headers,
    });
    const args = faulted.choices[0].message.tool_calls?.[0].function.arguments;
    expect(typeof args).toBe("string");
    expect(args).not.toBe(JSON.stringify(upstreamArguments));
    expect(() => JSON.parse(args ?? "")).toThrow();
    const exhausted = await replayClient.chat.completions.create(requestFor("record tools"), {
      headers,
    });
    expect(exhausted.choices[0].message.tool_calls?.[0].function.arguments).toBe(
      JSON.stringify(upstreamArguments),
    );
    const unaffected = await replayClient.chat.completions.create(requestFor("record tools"), {
      headers: { "x-test-id": "outside-scope" },
    });
    expect(unaffected.choices[0].message.tool_calls?.[0].function.arguments).toBe(
      JSON.stringify(upstreamArguments),
    );
    const entries = replay.getRequests();
    expect(entries).toHaveLength(3);
    expect(entries[0].response.misbehavior).toMatchObject({
      applied: true,
      source: "scope",
      fault: "tool-args-invalid-json",
      ordinal: 0,
      servedToolCalls: [{ name: "weather", arguments: args }],
    });
    expect(entries[1].response.misbehavior).toMatchObject({
      applied: false,
      source: "scope",
      reason: "times-exhausted",
    });
    expect(entries[2].response).not.toHaveProperty("misbehavior");
    expect(await readFile(snapshotPath, "utf8")).toBe(snapshotBeforeReplay);
    console.log(
      JSON.stringify({
        phase: "recording-lifecycle",
        tools,
        text,
        captured,
        snapshot,
        faulted,
        exhausted,
        unaffected,
        replay: entries,
      }),
    );
  } finally {
    if (replayStarted) await replay.stop();
    if (recorderStarted) await recorder?.stop();
    if (upstreamStarted) await upstream.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function withStrictFixture(
  strict: boolean,
  run: (context: {
    mock: LLMock;
    send: (message: string, fault?: string) => Promise<{ status: number; body: unknown }>;
  }) => Promise<void>,
) {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict });
  mock.addFixture({
    match: { userMessage: "known greeting" },
    response: { content: "Hello from fixture" },
  });
  const url = await mock.start();
  try {
    await run({
      mock,
      send: async (message, fault) => {
        const response = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Test-Id": `strict-${strict}`,
            ...(fault === undefined ? {} : { "X-AIMock-Misbehavior": fault }),
          },
          body: JSON.stringify(requestFor(message)),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    await mock.stop();
  }
}

test.each([false, true])(
  "P1b strict=%s matched supported fault preserves applicability",
  async (strict) => {
    await withStrictFixture(strict, async ({ mock, send }) => {
      const control = await send("known greeting");
      const faulted = await send("known greeting", "empty-response");
      const entries = mock.getRequests();
      console.log(JSON.stringify({ cell: "matched-supported", strict, control, faulted, entries }));
      expect(control).toMatchObject({
        status: 200,
        body: { choices: [{ message: { content: "Hello from fixture" }, finish_reason: "stop" }] },
      });
      expect(faulted).toMatchObject({
        status: 200,
        body: { choices: [{ message: { content: "" }, finish_reason: "stop" }] },
      });
      expect(entries).toHaveLength(2);
      expect(entries[0].response).not.toHaveProperty("misbehavior");
      expect(entries[1].response.misbehavior).toMatchObject({
        applied: true,
        source: "header",
        fault: "empty-response",
        evaluations: [{ entryIndex: 0, fault: "empty-response", outcome: "applied", ordinal: 0 }],
      });
    });
  },
);

test.each([false, true])(
  "P1b strict=%s matched inapplicable explicit fault returns the same 501",
  async (strict) => {
    await withStrictFixture(strict, async ({ mock, send }) => {
      const control = await send("known greeting");
      const rejected = await send("known greeting", "tool-args-invalid-json");
      const entries = mock.getRequests();
      console.log(
        JSON.stringify({ cell: "matched-inapplicable", strict, control, rejected, entries }),
      );
      expect(control.status).toBe(200);
      expect(rejected).toMatchObject({
        status: 501,
        body: {
          error: { code: "aimock_misbehavior_not_applicable", type: "invalid_request_error" },
        },
      });
      expect(entries).toHaveLength(2);
      expect(entries[0].response).not.toHaveProperty("misbehavior");
      expect(entries[1].response).toMatchObject({
        status: 501,
        misbehavior: {
          applied: false,
          source: "header",
          fault: "tool-args-invalid-json",
          reason: "not-applicable",
          evaluations: [
            {
              entryIndex: 0,
              fault: "tool-args-invalid-json",
              outcome: "error",
              reason: "not-applicable",
            },
          ],
        },
      });
      expect(entries[1].response.misbehavior).not.toHaveProperty("ordinal");
    });
  },
);

test.each([false, true])(
  "P1b strict=%s unmatched response remains unchanged with configured faults",
  async (strict) => {
    await withStrictFixture(strict, async ({ mock, send }) => {
      const control = await send("missing request");
      const configured = await send("missing request", "empty-response");
      const entries = mock.getRequests();
      console.log(JSON.stringify({ cell: "unmatched", strict, control, configured, entries }));
      expect(control.status).toBe(strict ? 503 : 404);
      expect(configured).toEqual(control);
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.response).toMatchObject({ status: control.status, fixture: null });
        expect(entry.response).not.toHaveProperty("misbehavior");
      }
    });
  },
);

test("P1d time-disconnected applied stream retains the full prepared usage of its uninterrupted counterpart", async () => {
  const prompt = "interrupted usage";
  const authoredArguments = JSON.stringify({ city: "Tokyo ".repeat(70) });
  const faultedArguments = authoredArguments.slice(0, Math.floor(authoredArguments.length / 2));
  const response = {
    toolCalls: [{ id: "call_usage", name: "weather", arguments: authoredArguments }],
    usage: { promptTokens: 900, completionTokens: 901 },
  };
  const originalResponse = structuredClone(response);
  const fixture: Fixture = {
    match: {},
    response,
    misbehavior: "tool-args-invalid-json",
    chunkSize: 8,
    streamingProfile: { ttft: 0, tps: 50 },
  };
  // Call-through observation of the real writer's prepared usage argument.
  // This is server-side accounting, not evidence that an interrupted client received usage.
  const writer = vi.spyOn(sseWriter, "writeSSEStream");
  try {
    const observations = [];
    for (const disconnectAfterMs of [undefined, 80]) {
      const mock = new LLMock({ port: 0, logLevel: "silent" });
      mock.addFixture({
        ...fixture,
        ...(disconnectAfterMs === undefined ? {} : { disconnectAfterMs }),
      });
      const client = clientFor(await mock.start());
      const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
      let transportError: unknown;
      try {
        try {
          const stream = await client.chat.completions.create({
            ...requestFor(prompt),
            stream: true,
            stream_options: { include_usage: true },
          });
          for await (const chunk of stream) chunks.push(chunk);
        } catch (error) {
          transportError = error;
        }
        const entries = mock.getRequests();
        expect(entries).toHaveLength(1);
        observations.push({ disconnectAfterMs, chunks, transportError, entry: entries[0] });
      } finally {
        await mock.stop();
      }
    }
    expect(writer).toHaveBeenCalledTimes(2);
    const options = writer.mock.calls.map((call) => call[2]);
    const preparedUsage = options.map((option) =>
      typeof option === "object" ? option.usageChunk?.usage : undefined,
    );
    const expectedUsage = {
      prompt_tokens: Math.ceil(prompt.length / 4),
      completion_tokens: Math.ceil(("weather" + faultedArguments).length / 4),
      total_tokens:
        Math.ceil(prompt.length / 4) + Math.ceil(("weather" + faultedArguments).length / 4),
    };
    const [complete, interrupted] = observations;
    const deliveredArguments = (chunks: OpenAI.Chat.Completions.ChatCompletionChunk[]) =>
      chunks
        .flatMap((chunk) =>
          chunk.choices.flatMap(
            (choice) =>
              choice.delta.tool_calls?.map((call) => call.function?.arguments ?? "") ?? [],
          ),
        )
        .join("");
    console.log(
      JSON.stringify({
        cell: "P1d-disconnect-prepared-usage",
        expectedUsage,
        preparedUsage,
        observations: observations.map((observation) => ({
          ...observation,
          transportError: String(observation.transportError),
        })),
      }),
    );
    expect(preparedUsage).toEqual([expectedUsage, expectedUsage]);
    expect(complete.transportError).toBeUndefined();
    expect(complete.chunks.find((chunk) => chunk.usage)?.usage).toEqual(expectedUsage);
    expect(deliveredArguments(complete.chunks)).toBe(faultedArguments);
    expect(complete.entry.response).not.toHaveProperty("interrupted");
    expect(interrupted.transportError).toBeDefined();
    expect(interrupted.chunks.length).toBeGreaterThan(0);
    expect(interrupted.chunks.length).toBeLessThan(complete.chunks.length);
    expect(interrupted.chunks.some((chunk) => chunk.usage)).toBe(false);
    expect(deliveredArguments(interrupted.chunks).length).toBeLessThan(faultedArguments.length);
    expect(
      interrupted.chunks.some((chunk) =>
        chunk.choices.some((choice) => choice.finish_reason !== null),
      ),
    ).toBe(false);
    expect(interrupted.entry.response).toMatchObject({
      interrupted: true,
      interruptReason: "disconnectAfterMs",
    });
    expect(interrupted.entry.response.misbehavior).toEqual(complete.entry.response.misbehavior);
    expect(interrupted.entry.response.misbehavior).toMatchObject({
      applied: true,
      fault: "tool-args-invalid-json",
      servedToolCalls: [{ id: "call_usage", name: "weather", arguments: faultedArguments }],
    });
    expect(response).toEqual(originalResponse);
  } finally {
    writer.mockRestore();
  }
});
