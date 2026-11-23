import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture, FixtureBlock } from "../types.js";

const text: FixtureBlock = { type: "text", text: "BLOCK_TEXT" };
const tool: FixtureBlock = {
  type: "toolCall",
  name: "weather",
  arguments: '{"city":"NYC"}',
  id: "call_authored",
};
const empty: FixtureBlock = { type: "text", text: "" };
const cases: {
  name: string;
  response: Fixture["response"];
  text: string;
  tools: boolean;
  order: string[];
  override?: boolean;
}[] = [
  {
    name: "text only",
    response: { blocks: [text] },
    text: "BLOCK_TEXT",
    tools: false,
    order: ["text"],
  },
  { name: "tool only", response: { blocks: [tool] }, text: "", tools: true, order: ["tool"] },
  {
    name: "tool first",
    response: { blocks: [tool, text] },
    text: "BLOCK_TEXT",
    tools: true,
    order: ["tool", "text"],
  },
  {
    name: "text first",
    response: { blocks: [text, tool] },
    text: "BLOCK_TEXT",
    tools: true,
    order: ["text", "tool"],
  },
  {
    name: "trailing empty text",
    response: { blocks: [tool, empty] },
    text: "",
    tools: true,
    order: ["tool", "text"],
  },
  {
    name: "empty text only",
    response: { blocks: [empty] },
    text: "",
    tools: false,
    order: ["text"],
  },
  {
    name: "conflicting legacy",
    response: {
      content: "LEGACY_TEXT",
      toolCalls: [{ name: "legacy_tool", arguments: "{}" }],
      blocks: [text],
    },
    text: "BLOCK_TEXT",
    tools: false,
    order: ["text"],
  },
  {
    name: "length override",
    response: { blocks: [text], finishReason: "length" },
    text: "BLOCK_TEXT",
    tools: false,
    order: ["text"],
    override: true,
  },
  {
    name: "empty blocks fallback",
    response: { content: "BLOCK_TEXT", toolCalls: [tool], blocks: [] },
    text: "BLOCK_TEXT",
    tools: true,
    order: ["text", "tool"],
  },
  {
    name: "legacy empty tools fallback",
    response: { content: "BLOCK_TEXT", toolCalls: [], blocks: [] },
    text: "BLOCK_TEXT",
    tools: false,
    order: ["text"],
  },
];

// These local wire views describe the fields asserted below; production encoders
// intentionally keep their response interfaces private.
interface CohereWire {
  type?: string;
  finish_reason?: string;
  message?: {
    content: { text: string }[];
    tool_calls: { id: string; function: { name: string; arguments: string } }[];
  };
  delta?: {
    finish_reason?: string;
    message?: {
      content?: { text?: string };
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } };
    };
  };
}
interface InteractionStep {
  type: string;
  id?: string;
  name?: string;
  arguments?: { city: string };
  content?: { text: string }[];
}
interface InteractionWire {
  event_type?: string;
  status?: string;
  output_text?: string;
  steps?: InteractionStep[];
  step?: InteractionStep;
  delta?: { type?: string; text?: string; arguments?: string };
  interaction?: { status: string };
}

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});
async function request(provider: string, stream: boolean, response: Fixture["response"]) {
  mock = new LLMock({ port: 0 });
  mock.addFixture({ match: { userMessage: "outcome" }, response });
  await mock.start();
  const res = await fetch(
    `${mock.url}${provider === "cohere" ? "/v2/chat" : "/v1beta/interactions"}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        provider === "cohere"
          ? { model: "command-r-plus", messages: [{ role: "user", content: "outcome" }], stream }
          : { model: "gemini-2.5-flash", input: "outcome", stream },
      ),
    },
  );
  expect(res.status).toBe(200);
  const body = await res.text();
  return stream
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
    : [body];
}

for (const provider of ["cohere", "interactions"]) {
  for (const stream of [false, true]) {
    describe(`${provider} blocks outcomes stream=${stream}`, () => {
      it.each(cases)("$name", async (testCase) => {
        const raw = await request(provider, stream, testCase.response);
        const legacyEmpty = testCase.name === "legacy empty tools fallback";
        if (provider === "cohere") {
          const wire: CohereWire[] = raw.map((line) => JSON.parse(line));
          const terminal = stream
            ? wire.filter((e) => e.type === "message-end").map((e) => e.delta?.finish_reason)
            : [wire[0].finish_reason];
          const content = stream
            ? wire
                .filter((e) => e.type === "content-delta")
                .map((e) => e.delta?.message?.content?.text ?? "")
                .join("")
            : wire[0].message?.content.map((e) => e.text).join("");
          const calls = stream
            ? wire
                .filter((e) => e.type === "tool-call-start")
                .map((e) => e.delta?.message?.tool_calls)
            : (wire[0].message?.tool_calls ?? []);
          expect(content).toBe(testCase.text);
          expect(calls).toHaveLength(testCase.tools ? 1 : 0);
          if (testCase.tools) {
            expect(calls[0]?.id).toBe("call_authored");
            expect(calls[0]?.function?.name).toBe("weather");
            const args = stream
              ? wire
                  .filter((e) => e.type === "tool-call-delta")
                  .map((e) => e.delta?.message?.tool_calls?.function?.arguments ?? "")
                  .join("")
              : calls[0]?.function?.arguments;
            expect(JSON.parse(args ?? "null")).toEqual({ city: "NYC" });
          }
          if (stream)
            expect(
              wire
                .filter((e) => e.type === "tool-call-start" || e.type === "content-start")
                .map((e) => (e.type === "tool-call-start" ? "tool" : "text")),
            ).toEqual(testCase.order);
          expect(terminal).toEqual([
            testCase.override
              ? "MAX_TOKENS"
              : testCase.tools || legacyEmpty
                ? "TOOL_CALL"
                : "COMPLETE",
          ]);
        } else {
          const wire: InteractionWire[] = raw.map((line) => JSON.parse(line));
          const terminal = stream
            ? wire
                .filter((e) => e.event_type === "interaction.completed")
                .map((e) => e.interaction?.status)
            : [wire[0].status];
          const steps = stream
            ? wire.flatMap((e) => (e.event_type === "step.start" && e.step ? [e.step] : []))
            : (wire[0].steps ?? []);
          const calls = steps.filter((e) => e.type === "function_call");
          const content = stream
            ? wire
                .filter((e) => e.event_type === "step.delta" && e.delta?.type === "text")
                .map((e) => e.delta?.text ?? "")
                .join("")
            : wire[0].output_text;
          expect(content).toBe(testCase.text);
          expect(steps.map((e) => (e.type === "function_call" ? "tool" : "text"))).toEqual(
            testCase.order,
          );
          expect(calls).toHaveLength(testCase.tools ? 1 : 0);
          if (testCase.tools) {
            expect(calls[0].id).toBe("call_authored");
            expect(calls[0].name).toBe("weather");
            const args = stream
              ? JSON.parse(
                  wire
                    .filter((e) => e.delta?.type === "arguments_delta")
                    .map((e) => e.delta?.arguments ?? "")
                    .join(""),
                )
              : calls[0].arguments;
            expect(args).toEqual({ city: "NYC" });
          }
          if (stream)
            expect(
              wire
                .filter((e) => e.event_type === "interaction.created")
                .map((e) => e.interaction?.status),
            ).toEqual(["in_progress"]);
          expect(terminal).toEqual([
            testCase.tools || legacyEmpty ? "requires_action" : "completed",
          ]);
        }
      });
    });
  }
}
