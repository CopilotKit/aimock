import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

const branches = ["audio+tools", "blocks", "legacy text+tools", "tool-only"] as const;
type Branch = (typeof branches)[number];
const malformed = '{"city":';
const advice = "Use a wire that carries tool arguments as a string to test malformed JSON.";
let mock: LLMock | undefined;
let directory: string | undefined;
let session: Session | undefined;

afterEach(async () => {
  session?.close();
  session = undefined;
  await mock?.stop();
  mock = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function responseFor(branch: Branch, args: string | undefined) {
  const toolCalls = [
    { name: "first_valid", id: "call_first", arguments: '{"ok":true}' },
    { name: "lookup", id: "call_lookup", arguments: args },
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
          ...toolCalls.map((call) => ({ type: "toolCall", ...call })),
        ],
      };
    case "legacy text+tools":
      return { content: "Earlier text.", toolCalls };
    case "tool-only":
      return { toolCalls };
  }
}

async function connect(branch: Branch, args: string | undefined) {
  directory = await mkdtemp(join(tmpdir(), "aimock-pr0-gemini-live-"));
  const file = join(directory, "fixtures.json");
  await writeFile(
    file,
    JSON.stringify({
      fixtures: [
        { match: { userMessage: "recovery" }, response: { content: "Recovered." } },
        { match: { userMessage: "lookup" }, response: responseFor(branch, args) },
      ],
    }),
  );
  mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.loadFixtureFile(file);
  await mock.start();
  const client = new GoogleGenAI({
    apiKey: "local-test-key",
    httpOptions: {
      // A path avoids the SDK serializing an origin as a trailing slash + /ws.
      // aimock already strips this documented compatibility prefix on upgrade.
      baseUrl: `${mock.url}/openai`,
      apiVersion: "v1beta",
      retryOptions: { attempts: 1 },
    },
  });
  const messages: LiveServerMessage[] = [];
  const transportErrors: string[] = [];
  let closed = false;
  session = await client.live.connect({
    model: "gemini-2.0-flash-live-001",
    callbacks: {
      onmessage: (message) => messages.push(message),
      onerror: (event) => transportErrors.push(event.message),
      onclose: () => {
        closed = true;
      },
    },
  });
  await expect
    .poll(() => messages.some((message) => message.setupComplete !== undefined))
    .toBe(true);
  const activeSession = session;
  async function turn(text: string) {
    const start = messages.length;
    activeSession.sendClientContent({
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
  }
  return { turn, messages };
}

function toolArguments(messages: LiveServerMessage[]) {
  return messages
    .flatMap((message) => message.toolCall?.functionCalls ?? [])
    .map((call) => call.args);
}

test.each(branches)(
  "PR0 Gemini Live %s rejects malformed arguments before any content and recovers",
  async (branch) => {
    const { turn, messages } = await connect(branch, malformed);
    const rejected = await turn("lookup");
    const journal = mock?.getRequests();
    console.log(
      JSON.stringify({ branch, authoredArguments: malformed, messages: rejected, journal }),
    );
    expect.soft(rejected).toHaveLength(1);
    expect.soft(rejected[0]).toEqual({
      error: {
        code: 13,
        status: "INTERNAL",
        message: expect.stringContaining("invalid JSON arguments"),
      },
    });
    expect.soft(JSON.stringify(rejected)).toContain(advice);
    expect
      .soft(rejected.filter((message) => message.serverContent || message.toolCall))
      .toEqual([]);
    expect.soft(journal).toHaveLength(1);
    expect.soft(journal?.[0]?.response.status).toBe(500);
    expect.soft(journal?.[0]?.response.error).toContain("invalid JSON arguments");
    const recovery = await turn("recovery");
    console.log(JSON.stringify({ branch, recovery, journal: mock?.getRequests() }));
    expect(recovery.map((message) => message.text ?? "").join("")).toBe("Recovered.");
    expect(messages.filter((message) => message.setupComplete)).toHaveLength(1);
    expect(mock?.getRequests()).toHaveLength(2);
    expect(mock?.getLastRequest()?.response.status).toBe(200);
  },
);

const controls = [
  { label: "valid object", args: ' { "city" : "Paris" } ', expected: { city: "Paris" } },
  { label: "empty", args: "", expected: {} },
  { label: "missing", args: undefined, expected: {} },
  { label: "primitive", args: "7", expected: 7 },
  { label: "array", args: '[1,"two"]', expected: [1, "two"] },
  { label: "null", args: "null", expected: null },
];

for (const branch of branches) {
  // Blocks require an arguments field in resolveFixtureBlocks before this parse site.
  const branchControls = controls.filter(
    (control) => branch !== "blocks" || control.args !== undefined,
  );
  test.each(branchControls)(
    `PR0 Gemini Live ${branch} preserves $label arguments`,
    async ({ label, args, expected }) => {
      const { turn } = await connect(branch, args);
      const messages = await turn("lookup");
      console.log(
        JSON.stringify({
          branch,
          control: label,
          authoredArguments: args,
          messages,
          journal: mock?.getRequests(),
        }),
      );
      expect(toolArguments(messages)).toEqual([{ ok: true }, expected]);
      expect(messages.some((message) => "error" in message)).toBe(false);
      expect(mock?.getRequests()).toHaveLength(1);
      expect(mock?.getLastRequest()?.response.status).toBe(200);
    },
  );
}
