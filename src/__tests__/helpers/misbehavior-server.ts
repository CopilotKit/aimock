import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import type { FixtureFileResponse, FixtureFileToolCall } from "../../types.js";
import { LLMock } from "./misbehavior-enabled.js";

export async function withFaultFixture(
  misbehavior: unknown,
  run: (ctx: { mock: LLMock; url: string; client: OpenAI }) => Promise<void>,
  options: { arguments?: FixtureFileToolCall["arguments"]; response?: FixtureFileResponse } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "aimock-misbehavior-"));
  const file = join(dir, "fixture.json");
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  let started = false;
  try {
    await writeFile(
      file,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "weather" },
            response: options.response ?? {
              toolCalls: [
                {
                  id: "call_weather",
                  name: "weather",
                  arguments: options.arguments ?? { city: "Paris" },
                },
              ],
            },
            ...(misbehavior === undefined ? {} : { misbehavior }),
          },
        ],
      }),
    );
    mock.loadFixtureFile(file);
    const url = await mock.start();
    started = true;
    await run({
      mock,
      url,
      client: new OpenAI({ apiKey: "local", baseURL: `${url}/v1`, maxRetries: 0, timeout: 5000 }),
    });
  } finally {
    try {
      if (started) await mock.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
