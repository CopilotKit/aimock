import Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../../llmock.js";
import type { FixtureFileResponse } from "../../types.js";

export async function withClaudeFault(
  fault: unknown,
  run: (context: { mock: LLMock; url: string; client: Anthropic; raw: string[] }) => Promise<void>,
  response: FixtureFileResponse = { toolCalls: [{ name: "lookup", arguments: { city: "Paris" } }] },
) {
  const directory = await mkdtemp(join(tmpdir(), "aimock-stage3-"));
  const file = join(directory, "fixture.json");
  const mock = new LLMock({ port: 0, chunkSize: 2, metrics: true });
  const raw: string[] = [];
  let started = false;
  try {
    await writeFile(
      file,
      JSON.stringify({
        fixtures: [{ match: {}, response, ...(fault === undefined ? {} : { misbehavior: fault }) }],
      }),
    );
    mock.loadFixtureFile(file);
    const url = await mock.start();
    started = true;
    const client = new Anthropic({
      apiKey: "local-stage3",
      baseURL: url,
      maxRetries: 0,
      timeout: 5000,
      fetch: async (input, init) => {
        const result = await fetch(input, init);
        raw.push(await result.clone().text());
        return result;
      },
    });
    await run({ mock, url, client, raw });
  } finally {
    try {
      if (started) await mock.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
