import { afterEach, expect, test, vi } from "vitest";
import type { FixtureResponse, MisbehaviorConfig } from "../types.js";
import { LLMock, createServer } from "./helpers/misbehavior-enabled.js";

const tool = { name: "weather", arguments: '{"city":"Paris"}' };
const shapes = [
  { endpoint: "chat", name: "text", response: { content: "Sunny" } },
  { endpoint: "chat", name: "tools", response: { toolCalls: [tool] } },
  { endpoint: "chat", name: "mixed", response: { content: "Sunny", toolCalls: [tool] } },
  {
    endpoint: "chat",
    name: "blocks",
    response: {
      blocks: [
        { type: "toolCall", ...tool },
        { type: "text", text: "Sunny" },
      ],
    },
  },
  { endpoint: "generate", name: "text", response: { content: "Sunny" } },
] satisfies { endpoint: string; name: string; response: FixtureResponse }[];
const cells = shapes.flatMap((shape) => [false, true].map((stream) => ({ ...shape, stream })));
const config: MisbehaviorConfig = { faults: [{ fault: "empty-response", rate: 0, times: 1 }] };
// Chat now supports K6; refusal remains permanently unavailable. Generate retains K6 guards.
const permanentConfig: MisbehaviorConfig = { faults: [{ fault: "refusal", rate: 0, times: 1 }] };
const modes = ["fixture", "header", "scope", "server", "excluded", "none"] as const;
type Source = (typeof modes)[number] | "invalid";
let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

function requestBody(endpoint: string, stream: boolean | undefined) {
  return {
    model: "llama3.1",
    ...(endpoint === "generate"
      ? { prompt: "weather" }
      : { messages: [{ role: "user", content: "weather" }] }),
    stream,
  };
}
async function serve(
  response: FixtureResponse,
  endpoint: string,
  stream: boolean | undefined,
  source: Source,
  fault: MisbehaviorConfig = endpoint === "chat" ? permanentConfig : config,
  factory = true,
) {
  let calls = 0;
  mock = new LLMock({ port: 0, latency: 0, logLevel: "silent", metrics: true });
  mock.addFixture({
    match: { userMessage: "weather" },
    response: factory
      ? () => {
          calls++;
          return response;
        }
      : response,
    ...(source === "fixture" ? { misbehavior: fault } : {}),
    ...(source === "excluded"
      ? {
          misbehavior: {
            faults: [{ fault: "empty-response", providers: ["openai-chat"] }],
          } satisfies MisbehaviorConfig,
        }
      : {}),
  });
  if (source === "server" || source === "invalid") mock.setMisbehavior(fault);
  const url = await mock.start();
  if (source === "scope") {
    expect(
      (
        await fetch(`${url}/__aimock/misbehavior`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-id": "ollama-guard" },
          body: JSON.stringify(fault),
        })
      ).status,
    ).toBe(200);
  }
  const result = await fetch(`${url}/api/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-id": "ollama-guard",
      ...(source === "header"
        ? {
            "x-aimock-misbehavior": `${endpoint === "chat" ? "refusal" : "empty-response"}; rate=0`,
          }
        : {}),
      ...(source === "invalid" ? { "x-aimock-misbehavior": "not-a-fault" } : {}),
    },
    body: JSON.stringify(requestBody(endpoint, stream)),
  });
  const body = await result.text();
  const entries = mock.getRequests();
  const metrics = await (await fetch(`${url}/metrics`)).text();
  console.log(
    JSON.stringify({
      endpoint,
      stream,
      source,
      response,
      status: result.status,
      body,
      calls,
      entries,
    }),
  );
  return { status: result.status, body, entries, calls, metrics };
}

// Permanent chat refusal guards and unchanged generate K6 guards.
// Positive chat faults are covered in misbehavior-ollama.test.ts; stage1 proof is preserved externally.
for (const source of modes) {
  test.each(cells)(
    `${source}: $endpoint $name stream=$stream`,
    async ({ endpoint, response, stream }) => {
      const result = await serve(response, endpoint, stream, source);
      const explicit = source === "fixture" || source === "header";
      expect(result.status).toBe(explicit ? 501 : 200);
      expect(result.calls).toBe(1);
      expect(result.entries).toHaveLength(1);
      if (source === "none") {
        expect(result.entries[0]?.response).not.toHaveProperty("misbehavior");
        expect(result.metrics).not.toContain("aimock_misbehavior_total{");
      } else {
        const reason = source === "excluded" ? "provider-excluded" : "unsupported-on-wire";
        expect(result.entries[0]?.response.misbehavior).toMatchObject({
          applied: false,
          wire: "ollama",
          source: source === "excluded" ? "fixture" : source,
          reason,
          evaluations: [
            {
              entryIndex: 0,
              fault: endpoint === "chat" && source !== "excluded" ? "refusal" : "empty-response",
              outcome: explicit ? "error" : "skipped",
              reason,
            },
          ],
        });
        expect(result.entries[0]?.response.misbehavior?.evaluations).toHaveLength(1);
        expect(result.entries[0]?.response.misbehavior?.evaluations[0]).not.toHaveProperty(
          "ordinal",
        );
        expect(result.metrics).toContain(
          `outcome="${explicit ? "error" : "skipped"}:${reason}",wire="ollama"} 1`,
        );
      }
      if (explicit)
        expect(JSON.parse(result.body)).toMatchObject({
          error: expect.stringContaining("aimock_misbehavior_unsupported"),
        });
      else {
        const chunks = result.body
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(chunks.at(-1)).toMatchObject({ done: true, eval_count: 0, total_duration: 0 });
        if ("content" in response || "blocks" in response) expect(result.body).toContain("Sunny");
        if (endpoint === "chat" && ("toolCalls" in response || "blocks" in response))
          expect(result.body).toContain('"arguments":{"city":"Paris"}');
      }
    },
  );
}

for (const endpoint of ["chat", "generate"]) {
  test(`${endpoint}: malformed header precedes scoped skip`, async () => {
    const result = await serve({ content: "Sunny" }, endpoint, false, "invalid");
    expect(result.status).toBe(400);
    expect(result.body).toContain("aimock_misbehavior_invalid");
    expect(result.calls).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.metrics).not.toContain("aimock_misbehavior_total{");
  });
  test(`${endpoint}: omitted stream uses streaming guard on endpoint-ambiguous static fixture`, async () => {
    const result = await serve(
      { content: "Sunny" },
      endpoint,
      undefined,
      "fixture",
      endpoint === "chat" ? permanentConfig : config,
      false,
    );
    expect(result.status).toBe(501);
    expect(result.calls).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.response.misbehavior?.reason).toBe("unsupported-on-wire");
  });
  for (const source of ["fixture", "scope"] as const) {
    test(`${endpoint}: ${source} unavailable tool family is guarded before candidate preparation`, async () => {
      const result = await serve({ content: "Sunny" }, endpoint, false, source, {
        faults: [{ fault: "tool-args-invalid-json" }],
      });
      expect(result.status).toBe(source === "fixture" ? 501 : 200);
      expect(result.entries).toHaveLength(1);
      expect(result.calls).toBe(1);
      expect(result.entries[0]?.response.misbehavior?.reason).toBe(
        endpoint === "chat" ? "not-applicable" : "unsupported-on-wire",
      );
      if (source === "fixture")
        expect(result.body).toContain(
          endpoint === "chat"
            ? "aimock_misbehavior_not_applicable"
            : "aimock_misbehavior_unsupported",
        );
    });
    test(`${endpoint}: ${source} non-chat response observation`, async () => {
      const result = await serve(
        { error: { message: "fixture failure" }, status: 429 },
        endpoint,
        false,
        source,
      );
      expect(result.status).toBe(source === "fixture" ? 501 : 429);
      expect(result.entries).toHaveLength(1);
      expect(result.calls).toBe(1);
      expect(result.entries[0]?.response.misbehavior?.reason).toBe("not-applicable");
    });
  }
  for (const stream of [false, true]) {
    test(`${endpoint}: no-row parse diagnostic and evaluated error log once, stream=${stream}`, async () => {
      for (const invalid of [true, false]) {
        const logs = vi.spyOn(console, "error");
        const server = await createServer(
          [
            {
              match: {},
              response: { content: "Sunny" },
              misbehavior: invalid
                ? { faults: [{ fault: "empty-response", rate: 2 }] }
                : endpoint === "chat"
                  ? permanentConfig
                  : config,
            },
          ],
          { port: 0, latency: 0, logLevel: "warn", metrics: true },
        );
        try {
          const result = await fetch(`${server.url}/api/${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(requestBody(endpoint, stream)),
          });
          const body = await result.json();
          const entries = server.journal.getAll();
          const metrics = await (await fetch(`${server.url}/metrics`)).text();
          console.log(
            JSON.stringify({
              phase: "error-log",
              endpoint,
              stream,
              invalid,
              status: result.status,
              body,
              entries,
              logs: logs.mock.calls,
            }),
          );
          expect(result.status).toBe(501);
          expect(body).toMatchObject({
            error: expect.stringContaining(
              invalid ? "aimock_misbehavior_not_applicable" : "aimock_misbehavior_unsupported",
            ),
          });
          expect(entries).toHaveLength(1);
          expect(entries[0]?.response.misbehavior?.evaluations).toHaveLength(invalid ? 0 : 1);
          expect(logs).toHaveBeenCalledTimes(1);
          expect(logs.mock.calls[0]?.join(" ")).toContain(
            invalid
              ? body.error
              : `${endpoint === "chat" ? "refusal" : "empty-response"} error:unsupported-on-wire on ollama`,
          );
          if (invalid) expect(metrics).not.toContain("aimock_misbehavior_total{");
          else expect(metrics).toContain('outcome="error:unsupported-on-wire",wire="ollama"} 1');
        } finally {
          logs.mockRestore();
          await new Promise<void>((resolve, reject) =>
            server.server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      }
    });
  }
}

test("chat: stop-length nonstreaming remains unsupported", async () => {
  const result = await serve({ toolCalls: [tool] }, "chat", false, "fixture", {
    faults: [{ fault: "stop-length-mid-tool" }],
  });
  expect(result.status).toBe(501);
  expect(result.entries[0]?.response.misbehavior?.reason).toBe("unsupported-on-wire");
});

test("generate: scoped tools retain existing direct rejection with observation", async () => {
  const result = await serve({ toolCalls: [tool] }, "generate", false, "scope");
  expect(result.status).toBe(400);
  expect(result.body).toContain("Tool call fixtures are not supported on /api/generate");
  expect(result.calls).toBe(1);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.response.misbehavior?.reason).toBe("unsupported-on-wire");
});

for (const endpoint of ["chat", "generate"]) {
  test(`${endpoint}: unknown response branch preserves status and records scoped skip`, async () => {
    const result = await serve({ embedding: [0.1] }, endpoint, false, "scope");
    expect(result.status).toBe(500);
    expect(result.calls).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.response.misbehavior?.reason).toBe("not-applicable");
  });
}
