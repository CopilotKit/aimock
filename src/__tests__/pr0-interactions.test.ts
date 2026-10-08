import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
let fixtureDirectory: string | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
  fixtureDirectory = undefined;
});

const branches = [
  { id: "object-step", stream: false, mixed: false },
  { id: "tool-only-sse", stream: true, mixed: false },
  { id: "mixed-sse", stream: true, mixed: true },
] as const;

async function requestArguments(branch: (typeof branches)[number], args: string | undefined) {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "aimock-pr0-interactions-"));
  const path = join(fixtureDirectory, "fixtures.json");
  await writeFile(
    path,
    JSON.stringify({
      fixtures: [
        {
          match: {},
          response: {
            ...(branch.mixed ? { content: "Before tool." } : {}),
            toolCalls: [
              {
                id: "call_pr0",
                name: "lookup",
                ...(args === undefined ? {} : { arguments: args }),
              },
            ],
          },
        },
      ],
    }),
  );
  mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.loadFixtureFile(path);
  await mock.start();
  const client = new GoogleGenAI({ apiKey: "local-proof", httpOptions: { baseUrl: mock.url } });
  const options = { maxRetries: 0, timeout: 5000 };
  let status: number | undefined;
  let raw = "";
  let decoded: unknown;
  let clientError: unknown;
  try {
    if (branch.stream) {
      const pending = client.interactions.create(
        { model: "gemini-2.5-flash", input: "lookup", stream: true },
        options,
      );
      const response = await pending.asResponse();
      status = response.status;
      const body = response.clone().text();
      const events: unknown[] = [];
      for await (const event of await pending) events.push(event);
      decoded = events;
      raw = await body;
    } else {
      const pending = client.interactions.create(
        { model: "gemini-2.5-flash", input: "lookup", stream: false },
        options,
      );
      const response = await pending.asResponse();
      status = response.status;
      const body = response.clone().text();
      decoded = await pending;
      raw = await body;
    }
  } catch (error) {
    clientError = error;
    if (error instanceof Error && "status" in error && typeof error.status === "number")
      status = error.status;
  }
  const journal = mock.getRequests();
  console.log(
    JSON.stringify({
      branch: branch.id,
      authoredArguments: args ?? "<missing>",
      status,
      raw,
      decoded,
      clientError,
      journal,
    }),
  );
  expect(journal).toHaveLength(1);
  return { status, raw, decoded, clientError, journal };
}

function wireArguments(branch: (typeof branches)[number], raw: string): unknown {
  if (!branch.stream) {
    const decoded: unknown = JSON.parse(raw);
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "steps" in decoded &&
      Array.isArray(decoded.steps)
    ) {
      const step: unknown = decoded.steps[0];
      if (typeof step === "object" && step !== null && "arguments" in step) return step.arguments;
    }
    throw new Error("Missing function-call step");
  }
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line): unknown => JSON.parse(line.slice(6)))
    .flatMap((event) => {
      if (typeof event !== "object" || event === null || !("delta" in event)) return [];
      const delta = event.delta;
      if (
        typeof delta !== "object" ||
        delta === null ||
        !("type" in delta) ||
        delta.type !== "arguments_delta" ||
        !("arguments" in delta) ||
        typeof delta.arguments !== "string"
      )
        return [];
      return [delta.arguments];
    })
    .join("");
}

test.each(branches)(
  "PR0 Interactions $id preserves malformed arguments or rejects object wire",
  async (branch) => {
    const args = '{"city":';
    const result = await requestArguments(branch, args);
    if (branch.stream) {
      expect(result.status).toBe(200);
      expect(result.clientError).toBeUndefined();
      expect(wireArguments(branch, result.raw)).toBe(args);
    } else {
      expect(result.status).toBe(500);
      expect(result.clientError).toBeInstanceOf(Error);
      expect(String(result.clientError)).toContain("invalid JSON arguments");
      expect(String(result.clientError)).toContain(
        "Use a wire that carries tool arguments as a string to test malformed JSON.",
      );
      expect(result.journal[0].response.status).toBe(500);
      expect(result.journal[0].response.error).toContain("invalid JSON arguments");
    }
  },
);

const controls = [undefined, "", '{ "city": "Paris" }', '[1,"x"]', "42", "null"];
test.each(branches.flatMap((branch) => controls.map((args) => ({ branch, args }))))(
  "PR0 Interactions control $branch.id arguments=$args",
  async ({ branch, args }) => {
    const result = await requestArguments(branch, args);
    expect(result.clientError).toBeUndefined();
    expect(result.status).toBe(200);
    const value: unknown = JSON.parse(args || "{}");
    expect(wireArguments(branch, result.raw)).toEqual(
      branch.stream ? JSON.stringify(value) : value,
    );
  },
);
