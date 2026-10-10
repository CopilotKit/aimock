import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CohereClientV2, type Cohere } from "cohere-ai";
import { expect, test } from "vitest";
import { LLMock } from "../llmock.js";

const modes = [
  { id: "E1-cohere-283-tool-json", shape: "tool", stream: false },
  { id: "E1-cohere-352-mixed-json", shape: "mixed", stream: false },
  { id: "E1-cohere-352-blocks-json", shape: "blocks", stream: false },
  { id: "E1-cohere-557-tool-stream", shape: "tool", stream: true },
  { id: "E1-cohere-691-blocks-stream", shape: "blocks", stream: true },
  { id: "E1-cohere-805-mixed-stream", shape: "mixed", stream: true },
] as const;

const argumentsCases = [
  { name: "malformed", args: '{"city":' },
  { name: "noncanonical-object", args: ' { "z": 1, "city" : "Paris" } ' },
  { name: "array", args: ' [ 1, "two" ] ' },
  { name: "null", args: "null" },
  { name: "number", args: "42" },
  { name: "boolean", args: "false" },
  { name: "string", args: '"Paris"' },
  { name: "empty", args: "" },
  { name: "missing", args: undefined },
] as const;

async function requestCohere(mode: (typeof modes)[number], args: string | undefined) {
  const directory = await mkdtemp(join(tmpdir(), "aimock-pr0-cohere-"));
  const mock = new LLMock({ port: 0, logLevel: "silent", strictToolArguments: true, chunkSize: 3 });
  const wire: { status: number; body: string }[] = [];
  const toolCall = { id: "call_pr0", name: "lookup", arguments: args };
  const response =
    mode.shape === "blocks"
      ? {
          blocks: [
            { type: "toolCall", ...toolCall },
            { type: "text", text: "Checking." },
          ],
        }
      : { toolCalls: [toolCall], ...(mode.shape === "mixed" ? { content: "Checking." } : {}) };
  try {
    const file = join(directory, "fixture.json");
    await writeFile(file, JSON.stringify({ fixtures: [{ match: {}, response }] }));
    mock.loadFixtureFile(file);
    expect(mock.getFixtures()).toHaveLength(1);
    await mock.start();
    const client = new CohereClientV2({
      token: "local-proof",
      baseUrl: mock.url,
      maxRetries: 0,
      timeoutInSeconds: 5,
      fetch: async (input, init) => {
        const result = await fetch(input, init);
        wire.push({ status: result.status, body: await result.clone().text() });
        return result;
      },
    });
    const request = {
      model: "command-r-plus",
      messages: [{ role: "user", content: "lookup" }],
    } satisfies Cohere.V2ChatRequest;
    const events: Cohere.V2ChatStreamResponse[] = [];
    let observedArguments: string | undefined;
    let content = "";
    let finishReason: string | undefined;
    if (mode.stream) {
      for await (const event of await client.chatStream(request)) events.push(event);
      observedArguments = events
        .filter((event) => event.type === "tool-call-delta")
        .map((event) => event.delta?.message?.toolCalls?.function?.arguments ?? "")
        .join("");
      content = events
        .filter((event) => event.type === "content-delta")
        .map((event) => event.delta?.message?.content?.text ?? "")
        .join("");
      const starts = events.filter((event) => event.type === "tool-call-start");
      expect(starts).toHaveLength(1);
      expect(starts[0].delta?.message?.toolCalls?.function?.name).toBe("lookup");
      finishReason = events.find((event) => event.type === "message-end")?.delta?.finishReason;
      if (mode.shape === "blocks") {
        expect(events.findIndex((event) => event.type === "tool-call-start")).toBeLessThan(
          events.findIndex((event) => event.type === "content-start"),
        );
      }
    } else {
      const result = await client.chat(request);
      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls?.[0].function?.name).toBe("lookup");
      observedArguments = result.message.toolCalls?.[0].function?.arguments;
      content =
        result.message.content
          ?.map((block) => (block.type === "text" ? block.text : ""))
          .join("") ?? "";
      finishReason = result.finishReason;
    }
    const journal = mock.getLastRequest();
    console.log(
      JSON.stringify({
        site: mode.id,
        authoredArguments: args,
        wire,
        observedArguments,
        events,
        journal,
      }),
    );
    expect(wire).toHaveLength(1);
    expect(wire[0].status).toBe(200);
    expect(journal?.response.status).toBe(200);
    expect(content).toBe(mode.shape === "tool" ? "" : "Checking.");
    expect(finishReason).toBe("TOOL_CALL");
    return observedArguments;
  } finally {
    await mock.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

// Ordered blocks require arguments before reaching Cohere; missing is valid only for legacy toolCalls.
test.each(
  modes.flatMap((mode) =>
    argumentsCases
      .filter((argument) => mode.shape !== "blocks" || argument.name !== "missing")
      .map((argument) => ({ mode, ...argument })),
  ),
)("PR0 $mode.id $name preserves authored argument bytes", async ({ mode, args }) => {
  expect(await requestCohere(mode, args)).toBe(args || "{}");
});
