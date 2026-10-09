import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "../server.js";
import { LLMock } from "../llmock.js";
import type { FixtureResponse, MisbehaviorConfig } from "../types.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  vi.restoreAllMocks();
});

const modelId = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const body = JSON.stringify({
  anthropic_version: "bedrock-2023-05-31",
  max_tokens: 128,
  messages: [{ role: "user", content: "weather" }],
  tools: [{ name: "weather", input_schema: { type: "object" } }],
});
const fault: MisbehaviorConfig = { faults: [{ fault: "content-filter", rate: 1, times: 1 }] };
const tool = { id: "call_weather", name: "weather", arguments: '{"city":"Paris"}' };
const shapes: Array<{ shape: string; response: FixtureResponse }> = [
  { shape: "text", response: { content: "sunny" } },
  { shape: "tool", response: { toolCalls: [tool] } },
  { shape: "mixed", response: { content: "sunny", toolCalls: [tool] } },
  {
    shape: "blocks",
    response: {
      content: "",
      toolCalls: [],
      blocks: [
        { type: "toolCall", ...tool },
        { type: "text", text: "sunny" },
      ],
    },
  },
];
const modes = ["invoke", "invoke-with-response-stream"] as const;

async function request(mode: (typeof modes)[number], headers: Record<string, string> = {}) {
  const result = await fetch(`${mock!.url}/model/${modelId}/${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Id": "u5", ...headers },
    body,
    signal: AbortSignal.timeout(5000),
  });
  const bytes = Buffer.from(await result.arrayBuffer());
  // Raw frame companion; official SDK coverage lives in the positive Invoke suite.
  const wire = result.headers.get("content-type")?.includes("eventstream")
    ? bytes.toString("base64")
    : bytes.toString("utf8");
  console.log(
    JSON.stringify({
      mode,
      status: result.status,
      headers: Object.fromEntries(result.headers),
      wire,
      journal: mock!.getRequests(),
    }),
  );
  const events: unknown[] = [];
  if (result.headers.get("content-type")?.includes("eventstream")) {
    for (let offset = 0; offset < bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      const headerLength = bytes.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThanOrEqual(16 + headerLength);
      expect(offset + length).toBeLessThanOrEqual(bytes.length);
      const payload = JSON.parse(
        bytes.subarray(offset + 12 + headerLength, offset + length - 4).toString("utf8"),
      );
      events.push(
        typeof payload.bytes === "string"
          ? JSON.parse(Buffer.from(payload.bytes, "base64").toString("utf8"))
          : payload,
      );
      offset += length;
    }
  }
  return { result, wire, events };
}

for (const mode of modes) {
  test.each(shapes)(
    `U5 ${mode} $shape fixture fails loud after exactly one factory resolution`,
    async ({ response }) => {
      let calls = 0;
      mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
      mock.addFixture({
        match: { userMessage: "not this request" },
        response: { content: "wrong fixture" },
      });
      mock.addFixture({
        match: { userMessage: "weather" },
        misbehavior: fault,
        response: (request) => {
          calls++;
          expect(request.model).toBe(modelId);
          expect(request.messages[0]).toEqual({ role: "user", content: "weather" });
          expect(request.stream).toBe(mode !== "invoke");
          return response;
        },
      });
      await mock.start();
      const { result, wire } = await request(mode);
      expect(result.status).toBe(501);
      expect(JSON.parse(wire)).toMatchObject({
        __type: "NotImplementedException",
        code: "aimock_misbehavior_unsupported",
      });
      expect(result.headers.get("x-amzn-errortype")).toBe("NotImplementedException");
      expect(calls).toBe(1);
      expect(mock.getRequests()).toHaveLength(1);
      expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
        wire: "bedrock-invoke",
        source: "fixture",
        applied: false,
        evaluations: [
          {
            entryIndex: 0,
            fault: "content-filter",
            outcome: "error",
            reason: "unsupported-on-wire",
          },
        ],
      });
    },
  );

  test(`U5 ${mode} header fails loud; malformed header remains 400`, async () => {
    mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
    mock.addFixture({ match: {}, response: { content: "sunny" } });
    await mock.start();
    expect((await request(mode, { "X-Aimock-Misbehavior": "content-filter" })).result.status).toBe(
      501,
    );
    expect(mock.getLastRequest()?.response.misbehavior?.source).toBe("header");
    expect((await request(mode, { "X-Aimock-Misbehavior": "{" })).result.status).toBe(400);
  });

  test.each(["server", "scope"] as const)(
    `U5 ${mode} %s skips unavailable without rolls and preserves normal output`,
    async (source) => {
      const warnings = vi.spyOn(console, "warn");
      mock = new LLMock({
        port: 0,
        logLevel: "warn",
        metrics: true,
        ...(source === "server" ? { misbehavior: fault } : {}),
      });
      mock.addFixture({
        match: {},
        response: { content: "sunny", usage: { input_tokens: 7, output_tokens: 9 } },
      });
      await mock.start();
      if (source === "scope") {
        const install = await fetch(`${mock.url}/__aimock/misbehavior`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Test-Id": "u5" },
          body: JSON.stringify(fault),
        });
        expect(install.status).toBe(200);
      }
      const { result, wire, events } = await request(mode);
      expect(result.status).toBe(200);
      if (mode !== "invoke") {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "sunny" },
          }),
        );
        expect(events.at(-1)).toMatchObject({ type: "message_stop" });
      }
      if (mode === "invoke")
        expect(JSON.parse(wire)).toMatchObject({
          content: [{ type: "text", text: "sunny" }],
          usage: { input_tokens: 7, output_tokens: 9 },
        });
      expect(mock.getRequests()).toHaveLength(1);
      const summary = mock.getLastRequest()?.response.misbehavior;
      expect(summary).toMatchObject({
        source,
        applied: false,
        reason: "unsupported-on-wire",
        wire: "bedrock-invoke",
      });
      expect(summary?.evaluations).toEqual([
        {
          entryIndex: 0,
          fault: "content-filter",
          outcome: "skipped",
          reason: "unsupported-on-wire",
        },
      ]);
      const metrics = await (await fetch(`${mock.url}/metrics`)).text();
      expect(metrics).toContain(
        'aimock_misbehavior_total{fault="content-filter",outcome="skipped:unsupported-on-wire",wire="bedrock-invoke"} 1',
      );
      expect((await request(mode)).result.status).toBe(200);
      expect(mock.getRequests()).toHaveLength(2);
      expect(mock.getLastRequest()?.response.misbehavior?.evaluations).toEqual(
        summary?.evaluations,
      );
      expect(
        warnings.mock.calls.filter((args) =>
          args.some((arg) => typeof arg === "string" && arg.includes("[misbehavior]")),
        ),
      ).toHaveLength(1);
    },
  );

  test(`U5 ${mode} absent config, opt-out and provider exclusion stay successful`, async () => {
    mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
    mock.addFixture({ match: {}, response: { toolCalls: [tool] } });
    await mock.start();
    expect((await request(mode)).result.status).toBe(200);
    expect(mock.getLastRequest()?.response.misbehavior).toBeUndefined();
    mock.setMisbehavior({ faults: [] });
    expect((await request(mode)).result.status).toBe(200);
    expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
      reason: "disabled",
      evaluations: [],
    });
    mock.setMisbehavior({ faults: [{ fault: "content-filter", providers: ["openai-chat"] }] });
    expect((await request(mode)).result.status).toBe(200);
    expect(mock.getLastRequest()?.response.misbehavior).toMatchObject({
      reason: "provider-excluded",
      evaluations: [{ reason: "provider-excluded" }],
    });
  });

  test(`U5 ${mode} official AWS SDK recognizes unavailable error discriminator`, async () => {
    mock = new LLMock({ port: 0, logLevel: "silent", metrics: true });
    mock.addFixture({ match: {}, misbehavior: fault, response: { content: "sunny" } });
    await mock.start();
    const client = new BedrockRuntimeClient({
      endpoint: mock.url,
      region: "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler(),
    });
    try {
      const input = { modelId, body, contentType: "application/json" };
      const invoke =
        mode === "invoke"
          ? client.send(new InvokeModelCommand(input))
          : client.send(new InvokeModelWithResponseStreamCommand(input));
      await expect(
        invoke.catch((error: unknown) => {
          console.log(JSON.stringify({ mode, sdkError: error, journal: mock?.getRequests() }));
          throw error;
        }),
      ).rejects.toMatchObject({
        name: "NotImplementedException",
        $metadata: { httpStatusCode: 501 },
      });
      expect(mock.getRequests()).toHaveLength(1);
    } finally {
      client.destroy();
    }
  });
}

for (const mode of modes) {
  test.each([-1, 1])(
    `U5-A1 ${mode} direct-createServer rate=%s logs exactly one native error`,
    async (rate) => {
      const errors = vi.spyOn(console, "error");
      const instance = await createServer(
        [
          {
            match: {},
            response: { content: "sunny" },
            misbehavior: { faults: [{ fault: "content-filter", rate }] },
          },
        ],
        { port: 0, logLevel: "warn", metrics: true },
      );
      try {
        const response = await fetch(`${instance.url}/model/${modelId}/${mode}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Test-Id": "u5-a1" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        const wire = await response.json();
        const entries = instance.journal.getAll();
        const metrics = await (await fetch(`${instance.url}/metrics`)).text();
        console.log(
          JSON.stringify({
            finding: "U5-A1",
            mode,
            rate,
            status: response.status,
            wire,
            entries,
            errorLogs: errors.mock.calls,
            metrics,
          }),
        );
        expect(response.status).toBe(501);
        expect(response.headers.get("x-amzn-errortype")).toBe("NotImplementedException");
        expect(wire).toMatchObject({
          __type: "NotImplementedException",
          code: rate < 0 ? "aimock_misbehavior_not_applicable" : "aimock_misbehavior_unsupported",
        });
        expect(entries).toHaveLength(1);
        if (rate < 0) {
          expect(entries[0].response.misbehavior).toMatchObject({
            applied: false,
            source: "fixture",
            wire: "bedrock-invoke",
            evaluations: [],
          });
          expect(metrics).not.toMatch(/^aimock_misbehavior_total\{/m);
        } else {
          expect(entries[0].response.misbehavior?.evaluations).toEqual([
            {
              entryIndex: 0,
              fault: "content-filter",
              outcome: "error",
              reason: "unsupported-on-wire",
            },
          ]);
          expect(metrics).toContain(
            'aimock_misbehavior_total{fault="content-filter",outcome="error:unsupported-on-wire",wire="bedrock-invoke"} 1',
          );
        }
        expect(errors).toHaveBeenCalledTimes(1);
        expect(errors.mock.calls[0]).toEqual([
          "[aimock]",
          expect.stringContaining("bedrock-invoke"),
        ]);
        if (rate < 0)
          expect(errors.mock.calls[0]).toEqual(["[aimock]", expect.stringContaining(wire.message)]);
      } finally {
        instance.closeLiveSessions();
        await new Promise<void>((resolve, reject) =>
          instance.server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
}
