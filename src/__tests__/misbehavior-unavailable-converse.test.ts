import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  BedrockRuntimeClient,
  BedrockRuntimeServiceException,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { expect, test, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { createServer } from "../server.js";
import type { FixtureResponse, MisbehaviorConfig, MisbehaviorFaultId } from "../types.js";

const request: ConverseCommandInput = {
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  messages: [{ role: "user", content: [{ text: "weather" }] }],
};
const tool = { id: "call_weather", name: "weather", arguments: '{"city":"Paris"}' };
const shapes: { shape: string; response: FixtureResponse }[] = [
  { shape: "text", response: { content: "Paris" } },
  { shape: "tool", response: { toolCalls: [tool] } },
  { shape: "combined", response: { content: "Paris", toolCalls: [tool] } },
  {
    shape: "blocks",
    response: {
      blocks: [
        { type: "toolCall", ...tool },
        { type: "text", text: "Paris" },
      ],
    },
  },
];
const modes = shapes.flatMap((shape) => [false, true].map((stream) => ({ ...shape, stream })));
const excluded: MisbehaviorConfig = {
  faults: [{ fault: "empty-response", providers: ["openai-chat"] }],
};

type Source = "fixture" | "header" | "baseline" | "runtime" | "excluded" | "none" | "invalid";
async function observe(
  response: FixtureResponse,
  stream: boolean,
  source: Source,
  fault: MisbehaviorFaultId = "empty-response",
) {
  let calls = 0;
  const mock = new LLMock({
    port: 0,
    logLevel: "silent",
    latency: 0,
    metrics: true,
    ...(source === "baseline" ? { misbehavior: fault } : {}),
  });
  mock.addFixture({
    match: { userMessage: "weather" },
    response: () => {
      calls++;
      return response;
    },
    ...(source === "fixture" ? { misbehavior: fault } : {}),
    ...(source === "excluded" ? { misbehavior: excluded } : {}),
  });
  await mock.start();
  if (source === "runtime") {
    const control = await fetch(`${mock.url}/__aimock/misbehavior`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faults: [{ fault, rate: 0, times: 1 }] }),
    });
    expect(control.status).toBe(200);
  }
  const client = new BedrockRuntimeClient({
    endpoint: mock.url,
    region: "us-east-1",
    maxAttempts: 1,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    requestHandler: new NodeHttpHandler(),
  });
  try {
    const wire = await fetch(
      `${mock.url}/model/${encodeURIComponent(request.modelId!)}/converse${stream ? "-stream" : ""}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(source === "header" ? { "x-aimock-misbehavior": fault } : {}),
          ...(source === "invalid" ? { "x-aimock-misbehavior": "not-a-fault" } : {}),
        },
        body: JSON.stringify({ messages: request.messages }),
        signal: AbortSignal.timeout(5000),
      },
    );
    const bytes = Buffer.from(await wire.arrayBuffer());
    const entries = mock.getRequests().filter((entry) => entry.path.includes("/model/"));
    console.log(
      JSON.stringify({
        source,
        fault,
        stream,
        response,
        status: wire.status,
        errorType: wire.headers.get("x-amzn-errortype"),
        body: bytes.toString(wire.status === 200 && stream ? "base64" : "utf8"),
        entries,
        calls,
      }),
    );
    expect(entries).toHaveLength(1);
    expect(calls).toBe(source === "invalid" ? 0 : 1);
    const summary = entries[0].response.misbehavior;
    const explicitError =
      (source === "fixture" || source === "header") &&
      (fault === "refusal" || fault === "tool-args-schema-violation");
    const applied = !explicitError && ["fixture", "header", "baseline"].includes(source);
    if (explicitError) {
      expect(wire.status).toBe(501);
      expect(wire.headers.get("x-amzn-errortype")).toBe("InternalServerException");
      expect(summary).toMatchObject({
        applied: false,
        wire: "bedrock-converse",
        source,
        evaluations: [
          {
            entryIndex: 0,
            fault,
            outcome: "error",
            reason: fault === "refusal" ? "unsupported-on-wire" : "not-applicable",
          },
        ],
      });
    } else if (source === "invalid") {
      expect(wire.status).toBe(400);
      expect(bytes.toString()).toContain("aimock_misbehavior_invalid");
    } else {
      expect(wire.status).toBe(200);
      if (source === "none") expect(summary).toBeUndefined();
      else if (applied)
        expect(summary).toMatchObject({
          applied: true,
          wire: "bedrock-converse",
          evaluations: [{ entryIndex: 0, fault, outcome: "applied", ordinal: 0 }],
        });
      else {
        expect(summary).toMatchObject({
          applied: false,
          wire: "bedrock-converse",
          evaluations: [
            {
              entryIndex: 0,
              fault,
              outcome: "skipped",
              reason: source === "excluded" ? "provider-excluded" : "not-rolled",
            },
          ],
        });
        if (source === "excluded") expect(summary?.evaluations[0]).not.toHaveProperty("ordinal");
        else expect(summary?.evaluations[0].ordinal).toBe(0);
      }
    }
    // Official SDK decodes both the native error and normal event stream on the same server.
    if (source !== "header" && source !== "invalid") {
      const send = async () => {
        if (stream) {
          const result = await client.send(new ConverseStreamCommand(request), {
            abortSignal: AbortSignal.timeout(5000),
          });
          const events = [];
          for await (const event of result.stream ?? []) events.push(event);
          expect(events.at(-1)?.metadata?.usage?.inputTokens).toBe(applied ? 2 : 0);
          return result.$metadata.httpStatusCode;
        }
        const result = await client.send(new ConverseCommand(request), {
          abortSignal: AbortSignal.timeout(5000),
        });
        expect(result.usage?.inputTokens).toBe(applied ? 2 : 0);
        return result.$metadata.httpStatusCode;
      };
      if (explicitError) {
        const error = await send().catch((error: unknown) => error);
        console.log(JSON.stringify({ source, stream, sdkError: error }));
        expect(error).toBeInstanceOf(BedrockRuntimeServiceException);
        expect(error).toMatchObject({
          name: "InternalServerException",
          $metadata: { httpStatusCode: 501 },
        });
      } else expect(await send()).toBe(200);
      expect(mock.getRequests().filter((entry) => entry.path.includes("/model/"))).toHaveLength(2);
      expect(calls).toBe(2);
    }
    const metrics = await (await fetch(`${mock.url}/metrics`)).text();
    const rows = metrics.split("\n").filter((line) => line.startsWith("aimock_misbehavior_total{"));
    if (source === "none" || source === "invalid") expect(rows).toHaveLength(0);
    else {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('wire="bedrock-converse"');
      expect(rows[0]).toContain(`fault="${fault}"`);
      expect(rows[0]).toMatch(new RegExp(` ${source === "header" ? 1 : 2}$`));
    }
  } finally {
    client.destroy();
    await mock.stop();
  }
}

for (const source of [
  "fixture",
  "header",
  "baseline",
  "runtime",
  "excluded",
  "none",
  "invalid",
] as const) {
  test.each(modes)(
    `Converse transition ${source} $shape stream=$stream`,
    async ({ response, stream }) => {
      await observe(response, stream, source);
    },
  );
}

// Stage5: temporary unavailable cells become applied outputs; permanent limits remain native errors.
const unavailableFaults: MisbehaviorFaultId[] = [
  "tool-args-invalid-json",
  "tool-args-schema-violation",
  "tool-unknown-name",
  "tool-call-id-duplicate",
  "stop-length-mid-tool",
  "refusal",
  "content-filter",
  "reasoning-only",
];
test.each(unavailableFaults.flatMap((fault) => [false, true].map((stream) => ({ fault, stream }))))(
  "Converse transition family $fault stream=$stream",
  async ({ fault, stream }) => {
    await observe({ toolCalls: [tool] }, stream, "fixture", fault);
  },
);

// createServer accepts fixture objects directly, so the native boundary must
// report malformed effective config even when normal LLMock validation is bypassed.
test.each([false, true].flatMap((stream) => [false, true].map((invalid) => ({ stream, invalid }))))(
  "Converse direct config diagnostic stream=$stream invalid=$invalid",
  async ({ stream, invalid }) => {
    const instance = await createServer(
      [
        {
          match: { userMessage: "weather" },
          response: { content: "Paris" },
          misbehavior: { faults: [{ fault: "refusal", ...(invalid ? { rate: NaN } : {}) }] },
        },
      ],
      { port: 0, logLevel: "warn", metrics: true },
    );
    const errors = vi.spyOn(instance.defaults.logger, "error");
    const ordinals = vi.spyOn(instance.journal, "nextOrdinal");
    const firings = vi.spyOn(instance.journal, "recordFiring");
    const client = new BedrockRuntimeClient({
      endpoint: instance.url,
      region: "us-east-1",
      maxAttempts: 1,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
      requestHandler: new NodeHttpHandler(),
    });
    try {
      let failure: unknown;
      try {
        if (stream)
          await client.send(new ConverseStreamCommand(request), {
            abortSignal: AbortSignal.timeout(5000),
          });
        else
          await client.send(new ConverseCommand(request), {
            abortSignal: AbortSignal.timeout(5000),
          });
      } catch (error) {
        failure = error;
      }
      const entries = instance.journal.getAll();
      const metrics = await (await fetch(`${instance.url}/metrics`)).text();
      const rows = metrics
        .split("\n")
        .filter((line) => line.startsWith("aimock_misbehavior_total{"));
      console.log(
        JSON.stringify({
          stream,
          invalid,
          failure,
          entries,
          errors: errors.mock.calls,
          rows,
          ordinalCalls: ordinals.mock.calls.length,
          firingCalls: firings.mock.calls.length,
        }),
      );
      expect(failure).toBeInstanceOf(BedrockRuntimeServiceException);
      expect(failure).toMatchObject({
        name: "InternalServerException",
        $metadata: { httpStatusCode: 501 },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(501);
      expect(ordinals).not.toHaveBeenCalled();
      expect(firings).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(1);
      if (invalid) {
        expect(errors).toHaveBeenCalledWith(entries[0].response.error);
        expect(entries[0].response.error).toContain("misbehavior/bad-value");
        expect(entries[0].response.error).toContain("rate");
        expect(entries[0].response.misbehavior?.evaluations).toEqual([]);
        expect(rows).toEqual([]);
      } else {
        expect(entries[0].response.misbehavior?.evaluations).toHaveLength(1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain('outcome="error:unsupported-on-wire"');
        expect(rows[0]).toMatch(/ 1$/);
      }
    } finally {
      errors.mockRestore();
      ordinals.mockRestore();
      firings.mockRestore();
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        instance.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
