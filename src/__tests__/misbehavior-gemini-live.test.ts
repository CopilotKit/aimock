import { GoogleGenAI, Type, type LiveServerMessage } from "@google/genai";
import { expect, test } from "vitest";
import type { FixtureFileResponse, MisbehaviorFault } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";
import { withFaultFixture } from "./helpers/misbehavior-server.js";

const branches = ["audio+tools", "blocks", "legacy text+tools", "tool-only"] as const;
type Branch = (typeof branches)[number];
const schema = {
  type: Type.OBJECT,
  properties: { city: { type: Type.STRING, enum: ["Paris", "London"] } },
  required: ["city"],
  additionalProperties: false,
};
function responseFor(branch: Branch, ids = true): FixtureFileResponse {
  const toolCalls = [
    { name: "first_valid", ...(ids ? { id: "call_first" } : {}), arguments: { city: "London" } },
    { name: "lookup", ...(ids ? { id: "call_lookup" } : {}), arguments: { city: "Paris" } },
  ];
  switch (branch) {
    case "audio+tools":
      return {
        audio: { b64Json: "QUJD", contentType: "audio/pcm;rate=24000" },
        content: "Earlier text.",
        toolCalls,
      };
    case "blocks":
      return {
        blocks: [
          { type: "text", text: "Earlier text." },
          ...toolCalls.map((call) => ({ type: "toolCall" as const, ...call })),
        ],
      };
    case "legacy text+tools":
      return { content: "Earlier text.", toolCalls };
    case "tool-only":
      return { toolCalls };
  }
}
async function withLive(
  fault: MisbehaviorFault | undefined,
  branch: Branch,
  run: (ctx: {
    turn: (text?: string) => Promise<LiveServerMessage[]>;
    mock: Parameters<Parameters<typeof withFaultFixture>[1]>[0]["mock"];
  }) => Promise<void>,
  ids = true,
  jsonSchema = fault?.fault === "tool-args-schema-violation" &&
    fault.violation === "extra-property",
) {
  await withFaultFixture(
    fault === undefined ? undefined : { faults: [fault] },
    async ({ mock, url }) => {
      mock.prependFixture({
        match: { userMessage: "recovery" },
        response: { content: "Recovered." },
      });
      const client = new GoogleGenAI({
        apiKey: "local",
        httpOptions: {
          baseUrl: `${url}/openai`,
          apiVersion: "v1beta",
          retryOptions: { attempts: 1 },
        },
      });
      const messages: LiveServerMessage[] = [];
      const transportErrors: string[] = [];
      let closed = false;
      const parameters = jsonSchema
        ? {
            parametersJsonSchema: {
              ...schema,
              type: "object",
              properties: { city: { ...schema.properties.city, type: "string" } },
            },
          }
        : { parameters: schema };
      const session = await client.live.connect({
        model: "gemini-2.0-flash-live-001",
        config: {
          tools: [
            {
              functionDeclarations: [
                { name: "first_valid", ...parameters },
                { name: "lookup", ...parameters },
              ],
            },
          ],
        },
        callbacks: {
          onmessage: (message) => messages.push(message),
          onerror: (event) => transportErrors.push(event.message),
          onclose: () => {
            closed = true;
          },
        },
      });
      try {
        await expect
          .poll(() => messages.some((message) => message.setupComplete !== undefined))
          .toBe(true);
        const turn = async (text = "weather") => {
          const start = messages.length;
          session.sendClientContent({
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          });
          await expect
            .poll(() =>
              messages
                .slice(start)
                .some((message) => "error" in message || message.serverContent?.turnComplete),
            )
            .toBe(true);
          expect(transportErrors).toEqual([]);
          expect(closed).toBe(false);
          return messages.slice(start);
        };
        await run({ turn, mock });
      } finally {
        session.close();
      }
    },
    { response: responseFor(branch, ids) },
  );
}
function calls(messages: LiveServerMessage[]) {
  return messages.flatMap((message) => message.toolCall?.functionCalls ?? []);
}

for (const branch of branches) {
  test(`Live SDK K1 ${branch} emits only malformed completion and recovers`, async () => {
    await withLive(
      { fault: "tool-args-invalid-json", tool: "lookup" },
      branch,
      async ({ turn, mock }) => {
        const messages = await turn();
        console.log(
          JSON.stringify({
            cell: `K1/${branch}`,
            messages,
            response: mock.getLastRequest()?.response,
          }),
        );
        expect(messages).toEqual([
          { serverContent: { turnComplete: true, turnCompleteReason: "MALFORMED_FUNCTION_CALL" } },
        ]);
        expect(mock.getRequests()).toHaveLength(1);
        expect(mock.getLastRequest()?.response).toMatchObject({
          status: 200,
          misbehavior: {
            applied: true,
            ordinal: 0,
            servedToolCalls: [],
            evaluations: [{ outcome: "applied" }],
          },
        });
        const recovery = await turn("recovery");
        expect(recovery.map((message) => message.text ?? "").join("")).toBe("Recovered.");
        expect(mock.getRequests()).toHaveLength(2);
      },
    );
  });
  test(`Live SDK ${branch} no-fault control preserves objects and IDs`, async () => {
    await withLive(undefined, branch, async ({ turn, mock }) => {
      const messages = await turn();
      expect(calls(messages)).toEqual([
        { name: "first_valid", id: "call_first", args: { city: "London" } },
        { name: "lookup", id: "call_lookup", args: { city: "Paris" } },
      ]);
      expect(mock.getLastRequest()?.response).not.toHaveProperty("misbehavior");
      expect(messages.some((message) => "error" in message)).toBe(false);
    });
  });
  test(`Live SDK K6 ${branch} emits empty text then separate completion`, async () => {
    await withLive({ fault: "empty-response" }, branch, async ({ turn, mock }) => {
      const messages = await turn();
      console.log(
        JSON.stringify({
          cell: `K6/${branch}`,
          messages,
          response: mock.getLastRequest()?.response,
        }),
      );
      expect(messages).toEqual([
        { serverContent: { modelTurn: { parts: [{ text: "" }] } } },
        { serverContent: { turnComplete: true } },
      ]);
      expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
        applied: true,
        servedToolCalls: [],
      });
    });
  });
}

const violations = ["missing-required", "wrong-type", "extra-property", "enum-mismatch"] as const;
test.each(branches.flatMap((branch) => violations.map((violation) => ({ branch, violation }))))(
  "Live SDK K2 $branch/$violation delivers object violation and exact metadata",
  async ({ branch, violation }) => {
    await withLive(
      { fault: "tool-args-schema-violation", violation, tool: "lookup" },
      branch,
      async ({ turn, mock }) => {
        const messages = await turn();
        const actual = calls(messages);
        console.log(
          JSON.stringify({
            cell: `K2/${violation}`,
            messages,
            response: mock.getLastRequest()?.response,
          }),
        );
        expect(actual).toHaveLength(2);
        expect(actual[0].args).toEqual({ city: "London" });
        const args = actual[1].args;
        if (violation === "extra-property")
          expect(mock.getLastRequest()?.body).toMatchObject({
            tools: [
              { function: { parameters: { additionalProperties: false } } },
              { function: { parameters: { additionalProperties: false } } },
            ],
          });
        if (violation === "missing-required") expect(args).toEqual({});
        if (violation === "wrong-type") expect(typeof args?.city).not.toBe("string");
        if (violation === "extra-property") expect(Object.keys(args ?? {})).toHaveLength(2);
        if (violation === "enum-mismatch") expect(["Paris", "London"]).not.toContain(args?.city);
        expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls).toEqual(
          actual.map((call) => ({
            name: call.name,
            id: call.id,
            arguments: JSON.stringify(call.args),
          })),
        );
      },
    );
  },
);
test.each(branches)("Live SDK K3 %s replaces selected non-first name", async (branch) => {
  await withLive(
    { fault: "tool-unknown-name", tool: "lookup", name: "undeclared" },
    branch,
    async ({ turn, mock }) => {
      const messages = await turn();
      console.log(
        JSON.stringify({ cell: "K3", messages, response: mock.getLastRequest()?.response }),
      );
      expect(calls(messages).map((call) => call.name)).toEqual(["first_valid", "undeclared"]);
      expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls?.[1].name).toBe(
        "undeclared",
      );
    },
  );
});
test.each(branches.flatMap((branch) => [true, false].map((ids) => ({ branch, ids }))))(
  "Live SDK K4 $branch shares actual emitted IDs (supplied=$ids)",
  async ({ branch, ids }) => {
    await withLive(
      { fault: "tool-call-id-duplicate", tool: "lookup" },
      branch,
      async ({ turn, mock }) => {
        const messages = await turn();
        const actual = calls(messages);
        console.log(
          JSON.stringify({
            cell: `K4/${ids}`,
            messages,
            response: mock.getLastRequest()?.response,
          }),
        );
        expect(actual).toHaveLength(2);
        expect(actual[0].id).toBeTruthy();
        expect(actual[0].id).toBe(actual[1].id);
        if (ids) expect(actual[0].id).toBe("call_lookup");
        expect(mock.getLastRequest()?.response.misbehavior?.servedToolCalls).toEqual(
          actual.map((call) => ({
            name: call.name,
            id: call.id,
            arguments: JSON.stringify(call.args),
          })),
        );
      },
      ids,
    );
  },
);
test("Live SDK times1 applies once and preserves the next ordinary turn", async () => {
  await withLive(
    { fault: "tool-args-invalid-json", times: 1 },
    "tool-only",
    async ({ turn, mock }) => {
      expect(await turn()).toEqual([
        { serverContent: { turnComplete: true, turnCompleteReason: "MALFORMED_FUNCTION_CALL" } },
      ]);
      expect(calls(await turn())).toHaveLength(2);
      expect(mock.getRequests()).toHaveLength(2);
      expect(mock.getRequests()[1].response.misbehavior).toMatchObject({
        applied: false,
        reason: "times-exhausted",
      });
    },
  );
});

test("Live raw WS K1 is a native completion frame, not a transport error", async () => {
  await withFaultFixture({ faults: [{ fault: "tool-args-invalid-json" }] }, async ({ url }) => {
    const ws = await connectWebSocket(
      url,
      "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    );
    try {
      ws.send(JSON.stringify({ setup: { model: "gemini-live" } }));
      await ws.waitForMessages(1);
      ws.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: "weather" }] }],
            turnComplete: true,
          },
        }),
      );
      const frames = (await ws.waitForMessages(2)).slice(1);
      console.log(JSON.stringify({ cell: "raw-K1", frames }));
      expect(frames).toEqual([
        '{"serverContent":{"turnComplete":true,"turnCompleteReason":"MALFORMED_FUNCTION_CALL"}}',
      ]);
    } finally {
      ws.destroy();
    }
  });
});

test("Live runtime times1 is scoped to the upgrade test ID across turns", async () => {
  await withFaultFixture(undefined, async ({ url, mock }) => {
    const installed = await fetch(`${url}/__aimock/misbehavior`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-id": "live-runtime" },
      body: JSON.stringify({ faults: [{ fault: "tool-args-invalid-json", times: 1 }] }),
    });
    expect(installed.status).toBe(200);
    const ws = await connectWebSocket(
      url,
      "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?testId=live-runtime",
    );
    try {
      ws.send(JSON.stringify({ setup: { model: "gemini-live" } }));
      await ws.waitForMessages(1);
      const turn = async () => {
        const start = ws.getMessages().length;
        ws.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "weather" }] }],
              turnComplete: true,
            },
          }),
        );
        for (let count = start + 1; ; count++) {
          const frames = await ws.waitForMessages(count);
          const frame = frames[count - 1];
          if (frame.includes('"error"') || frame.includes('"turnComplete":true'))
            return frames.slice(start);
        }
      };
      const first = await turn();
      const second = await turn();
      console.log(
        JSON.stringify({ cell: "runtime-times1", first, second, journal: mock.getRequests() }),
      );
      expect(first).toEqual([
        '{"serverContent":{"turnComplete":true,"turnCompleteReason":"MALFORMED_FUNCTION_CALL"}}',
      ]);
      expect(second.some((frame) => frame.includes('"functionCalls"'))).toBe(true);
      expect(mock.getRequests()).toHaveLength(2);
      expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
        source: "scope",
        applied: true,
        ordinal: 0,
      });
      expect(mock.getRequests()[1].response.misbehavior).toMatchObject({
        source: "scope",
        applied: false,
        reason: "times-exhausted",
      });
    } finally {
      ws.destroy();
    }
  });
});

test("Live SDK native parametersJsonSchema no-fault control preserves args and normalized schema", async () => {
  await withLive(
    undefined,
    "tool-only",
    async ({ turn, mock }) => {
      expect(calls(await turn()).map((call) => call.args)).toEqual([
        { city: "London" },
        { city: "Paris" },
      ]);
      expect(mock.getLastRequest()?.body).toMatchObject({
        tools: [
          { function: { parameters: { type: "object", additionalProperties: false } } },
          { function: { parameters: { type: "object", additionalProperties: false } } },
        ],
      });
      expect(mock.getLastRequest()?.response).not.toHaveProperty("misbehavior");
    },
    true,
    true,
  );
});

test("Live applied K3 retains native malformed-authored error journaling and recovery", async () => {
  await withLive(
    { fault: "tool-unknown-name", name: "undeclared" },
    "tool-only",
    async ({ turn, mock }) => {
      const fixture = mock.getFixtures().find((entry) => entry.match.userMessage === "weather");
      if (!fixture) throw new Error("weather fixture missing");
      fixture.response = { toolCalls: [{ name: "lookup", arguments: '{"city":' }] };
      const messages = await turn();
      console.log(
        JSON.stringify({ cell: "K3-authored-invalid", messages, journal: mock.getRequests() }),
      );
      expect(messages).toEqual([
        {
          error: {
            code: 13,
            status: "INTERNAL",
            message: expect.stringContaining("invalid JSON arguments"),
          },
        },
      ]);
      expect(mock.getRequests()).toHaveLength(1);
      expect(mock.getLastRequest()?.response).toMatchObject({
        status: 500,
        error: expect.stringContaining("invalid JSON arguments"),
      });
      expect((await turn("recovery")).map((message) => message.text ?? "").join("")).toBe(
        "Recovered.",
      );
    },
  );
});

// Real socket timing controls: no fake clock, SDK replacement, or in-memory transport.
const timingCases = [
  {
    name: "K1 latency",
    fault: "tool-args-invalid-json",
    settings: { latency: 120 },
    minimum: 100,
    mode: "complete",
  },
  {
    name: "K6 latency",
    fault: "empty-response",
    settings: { latency: 120 },
    minimum: 100,
    mode: "complete",
  },
  {
    name: "K1 recorded TTFT with replay speed",
    fault: "tool-args-invalid-json",
    settings: {
      latency: 0,
      recordedTimings: { ttftMs: 240, interChunkDelaysMs: [] },
      replaySpeed: 2,
    },
    minimum: 100,
    mode: "complete",
  },
  {
    name: "K6 recorded TTFT with replay speed",
    fault: "empty-response",
    settings: {
      latency: 0,
      recordedTimings: { ttftMs: 240, interChunkDelaysMs: [] },
      replaySpeed: 2,
    },
    minimum: 100,
    mode: "complete",
  },
  {
    name: "K6 truncates after empty modelTurn",
    fault: "empty-response",
    settings: { latency: 120, truncateAfterChunks: 1 },
    minimum: 100,
    mode: "truncate",
  },
  {
    name: "K1 timed disconnect before first frame",
    fault: "tool-args-invalid-json",
    settings: { latency: 300, disconnectAfterMs: 30 },
    minimum: 0,
    mode: "disconnect",
  },
  {
    name: "K6 timed disconnect before first frame",
    fault: "empty-response",
    settings: { latency: 300, disconnectAfterMs: 30 },
    minimum: 0,
    mode: "disconnect",
  },
  {
    name: "ordinary latency control",
    fault: undefined,
    settings: { latency: 120 },
    minimum: 100,
    mode: "complete",
  },
] as const;

test.each(timingCases)(
  "Live real WS timing $name",
  async ({ name, fault, settings, minimum, mode }) => {
    await withFaultFixture(
      fault === undefined ? undefined : { faults: [{ fault }] },
      async ({ url, mock }) => {
        const fixture = mock.getFixtures().find((entry) => entry.match.userMessage === "weather");
        if (!fixture) throw new Error("weather fixture missing");
        Object.assign(fixture, settings);
        const ws = await connectWebSocket(
          url,
          "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
        );
        let closed = false;
        void ws.waitForClose().then(() => {
          closed = true;
        });
        try {
          ws.send(JSON.stringify({ setup: { model: "gemini-live" } }));
          await ws.waitForMessages(1);
          const start = performance.now();
          ws.send(
            JSON.stringify({
              clientContent: {
                turns: [{ role: "user", parts: [{ text: "weather" }] }],
                turnComplete: true,
              },
            }),
          );
          let firstFrameMs: number | undefined;
          if (mode === "disconnect") {
            await new Promise((resolve) => setTimeout(resolve, 180));
          } else {
            await ws.waitForMessages(2);
            firstFrameMs = performance.now() - start;
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          const frames = ws.getMessages().slice(1);
          const response = mock.getLastRequest()?.response;
          console.log(JSON.stringify({ cell: name, firstFrameMs, closed, frames, response }));
          if (mode === "disconnect") {
            expect(frames).toEqual([]);
            expect(closed).toBe(true);
            expect(response).toMatchObject({
              interrupted: true,
              interruptReason: "disconnectAfterMs",
            });
          } else {
            expect(firstFrameMs).toBeGreaterThanOrEqual(minimum);
            if (mode === "truncate") {
              expect(frames).toEqual(['{"serverContent":{"modelTurn":{"parts":[{"text":""}]}}}']);
              expect(closed).toBe(true);
              expect(response).toMatchObject({
                interrupted: true,
                interruptReason: "truncateAfterChunks",
              });
            } else {
              expect(closed).toBe(false);
              expect(frames.at(-1)).toContain('"turnComplete":true');
              expect(response).not.toHaveProperty("interrupted");
            }
          }
          expect(mock.getRequests()).toHaveLength(1);
          if (fault !== undefined)
            expect(response?.misbehavior).toMatchObject({ applied: true, servedToolCalls: [] });
          else expect(response).not.toHaveProperty("misbehavior");
        } finally {
          ws.destroy();
        }
      },
    );
  },
);
