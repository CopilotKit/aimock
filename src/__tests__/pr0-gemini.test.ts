import { ApiError, GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

let mock: LLMock | undefined;
let directory: string | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const shapes = ["tool-only", "content-tool", "blocks", "audio-tool"] as const;
const cases = [false, true].flatMap((vertex) =>
  [false, true].flatMap((stream) =>
    shapes.map((shape) => ({
      id: `${vertex ? "vertex" : "gemini"}-${stream ? "stream" : "nonstream"}-${shape}`,
      vertex,
      stream,
      shape,
    })),
  ),
);

function fixtureResponse(shape: (typeof shapes)[number], args: string | undefined) {
  // The disk fixture intentionally omits arguments for the missing-value control.
  const tool = {
    id: "call_pr0",
    name: "lookup",
    ...(args === undefined ? {} : { arguments: args }),
  };
  switch (shape) {
    case "tool-only":
      return { toolCalls: [tool] };
    case "content-tool":
      return { content: "PR0 preceding text", toolCalls: [tool] };
    case "blocks":
      return {
        blocks: [
          { type: "text", text: "PR0 preceding text" },
          { type: "toolCall", ...tool },
        ],
      };
    case "audio-tool":
      return { audio: "SGVsbG8=", format: "mp3", content: "PR0 preceding text", toolCalls: [tool] };
  }
}

async function requestGemini(scenario: (typeof cases)[number], args: string | undefined) {
  directory = mkdtempSync(join(tmpdir(), "pr0-gemini-"));
  const path = join(directory, "fixture.json");
  writeFileSync(
    path,
    JSON.stringify({ fixtures: [{ match: {}, response: fixtureResponse(scenario.shape, args) }] }),
  );
  mock = new LLMock({ port: 0, logLevel: "silent" });
  mock.loadFixtureFile(path);
  await mock.start();

  const model = "gemini-2.5-flash";
  const resource = scenario.vertex
    ? `projects/pr0/locations/us-central1/publishers/google/models/${model}`
    : `models/${model}`;
  const apiVersion = scenario.vertex ? "v1" : "v1beta";
  const action = scenario.stream ? "streamGenerateContent" : "generateContent";
  const response = await fetch(
    `${mock.url}/${apiVersion}/${resource}:${action}${scenario.stream ? "?alt=sse" : ""}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "lookup" }] }] }),
      signal: AbortSignal.timeout(5000),
    },
  );
  const wire = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
  const client = new GoogleGenAI({
    vertexai: scenario.vertex,
    apiKey: "pr0-local-key",
    httpOptions: { baseUrl: mock.url, apiVersion, timeout: 5000, retryOptions: { attempts: 1 } },
  });
  const chunks: GenerateContentResponse[] = [];
  let sdkError: unknown;
  try {
    const request = { model: scenario.vertex ? resource : model, contents: "lookup" };
    if (scenario.stream) {
      for await (const chunk of await client.models.generateContentStream(request))
        chunks.push(chunk);
    } else {
      chunks.push(await client.models.generateContent(request));
    }
  } catch (error) {
    sdkError = error;
  }
  const journal = mock.getRequests();
  console.log(
    JSON.stringify({
      id: scenario.id,
      authoredArguments: args ?? "<missing>",
      wire,
      chunks,
      sdkError:
        sdkError instanceof Error
          ? {
              name: sdkError.name,
              message: sdkError.message,
              status: sdkError instanceof ApiError ? sdkError.status : undefined,
            }
          : sdkError,
      journal,
    }),
  );
  expect(journal).toHaveLength(2); // One HTTP probe + one SDK request; retries are disabled.
  for (const entry of journal) expect(entry.path).toContain(`/${apiVersion}/${resource}:${action}`);
  return { wire, chunks, sdkError, journal };
}

test.each(cases)(
  "PR0 $id rejects malformed object-wire arguments before output",
  async (scenario) => {
    const { wire, chunks, sdkError, journal } = await requestGemini(scenario, '{"city":');
    expect.soft(wire.status).toBe(500);
    expect.soft(wire.contentType).toContain("application/json");
    expect.soft(wire.body).not.toContain("data: ");
    expect.soft(wire.body).not.toContain("PR0 preceding text");
    expect.soft(wire.body).not.toContain("SGVsbG8=");
    expect.soft(wire.body).toContain("invalid JSON arguments");
    if (wire.status === 500) {
      expect
        .soft(JSON.parse(wire.body))
        .toMatchObject({ error: { code: 500, status: "INTERNAL" } });
    }
    // @google/genai 1.50.1 reports a retryable 500 as Error when attempts=1,
    // before parsing the provider envelope. The raw request asserts its status.
    expect.soft(sdkError).toBeInstanceOf(Error);
    expect.soft(sdkError).toMatchObject({ message: "Retryable HTTP Error: Internal Server Error" });
    expect.soft(chunks).toHaveLength(0);
    for (const entry of journal) {
      expect.soft(entry.response.status).toBe(500);
      expect.soft(entry.response.error).toContain("invalid JSON arguments");
    }
  },
);

const controls = [
  { label: "valid-object", args: '{ "city": "Paris" }', expected: { city: "Paris" } },
  { label: "valid-array", args: '["Paris", 2]', expected: ["Paris", 2] },
  { label: "valid-number", args: "42", expected: 42 },
  { label: "valid-null", args: "null", expected: null },
  { label: "empty", args: "", expected: {} },
  { label: "missing", args: undefined, expected: {} },
];
// Missing block arguments are rejected by the existing block-shape guard before
// this parser; missing legacy tool arguments reach it and remain positive controls.
test.each(
  cases.flatMap((scenario) =>
    controls
      .filter((control) => scenario.shape !== "blocks" || control.label !== "missing")
      .map((control) => ({ ...scenario, ...control })),
  ),
)("PR0 $id control $label preserves parsed arguments", async (scenario) => {
  const { wire, chunks, sdkError, journal } = await requestGemini(scenario, scenario.args);
  expect(wire.status).toBe(200);
  expect(sdkError).toBeUndefined();
  const calls = chunks.flatMap((chunk) => chunk.functionCalls ?? []);
  expect(calls).toEqual([{ id: "call_pr0", name: "lookup", args: scenario.expected }]);
  for (const entry of journal) {
    expect(entry.response.status).toBe(200);
    expect(entry.response.error).toBeUndefined();
  }
});
