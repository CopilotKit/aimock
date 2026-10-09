import { GoogleGenAI } from "@google/genai";
import { afterEach, expect, test, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { createServer } from "../server.js";
import type { FixtureResponse, MisbehaviorConfig } from "../types.js";

let mock: LLMock | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

const shapes: { id: string; response: FixtureResponse }[] = [
  { id: "text", response: { content: "ordinary response" } },
  { id: "tool", response: { toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}' }] } },
  {
    id: "mixed",
    response: {
      content: "ordinary response",
      toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}' }],
    },
  },
];
const cells = shapes.flatMap((shape) => [false, true].map((stream) => ({ ...shape, stream })));
const fault: MisbehaviorConfig = { faults: [{ fault: "refusal", times: 1, rate: 0 }] };

async function serve(
  cell: (typeof cells)[number],
  source: "fixture" | "header" | "baseline" | "runtime" | "excluded" | "none" | "invalid",
  config: MisbehaviorConfig = fault,
) {
  mock = new LLMock({
    port: 0,
    logLevel: "silent",
    metrics: true,
    ...(source === "baseline" ? { misbehavior: config } : {}),
  });
  let calls = 0;
  mock.addFixture({
    match: { userMessage: "lookup" },
    response: () => {
      calls++;
      return cell.response;
    },
    ...(source === "fixture" ? { misbehavior: config } : {}),
    ...(source === "excluded"
      ? {
          misbehavior: {
            faults: [{ fault: "refusal", providers: ["openai-chat"] }],
          } satisfies MisbehaviorConfig,
        }
      : {}),
  });
  await mock.start();
  if (source === "runtime") {
    const configured = await fetch(`${mock.url}/__aimock/misbehavior`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "u9" },
      body: JSON.stringify(config),
    });
    expect(configured.status).toBe(200);
  }
  const client = new GoogleGenAI({ apiKey: "local-proof", httpOptions: { baseUrl: mock.url } });
  const headers = {
    "X-Test-Id": "u9",
    ...(source === "header" ? { "x-aimock-misbehavior": "refusal;rate=0" } : {}),
    ...(source === "invalid" ? { "x-aimock-misbehavior": "not-a-fault" } : {}),
  };
  let status: number | undefined;
  let raw = "";
  let error: unknown;
  try {
    const request = { model: "gemini-2.5-flash", input: "lookup", stream: cell.stream };
    const pending = client.interactions.create(request, { maxRetries: 0, timeout: 5000, headers });
    const response = await pending.asResponse();
    status = response.status;
    raw = await response.text();
  } catch (caught) {
    error = caught;
    if (caught instanceof Error && "status" in caught && typeof caught.status === "number")
      status = caught.status;
  }
  const journal = mock.getRequests();
  console.log(
    JSON.stringify({
      cell: `${cell.id}:${cell.stream}`,
      source,
      status,
      raw,
      error,
      calls,
      journal,
    }),
  );
  expect(journal).toHaveLength(1);
  if (source !== "invalid") expect(calls).toBe(1);
  const metrics = await (await fetch(`${mock.url}/metrics`)).text();
  const observation = journal[0].response.misbehavior;
  const metricRows = metrics
    .split("\n")
    .filter((row) => row.startsWith("aimock_misbehavior_total{"));
  expect(metricRows).toHaveLength(observation?.evaluations.length ?? 0);
  if (observation?.evaluations.length) {
    expect(metricRows[0]).toContain('wire="gemini-interactions"');
    expect(metricRows[0]).toMatch(/ 1$/);
    expect(metricRows[0]).toContain(
      `outcome="${observation.evaluations[0].outcome}:${observation.evaluations[0].reason}"`,
    );
  }
  return { status, raw, error, entry: journal[0], calls };
}

// Permanent refusal exclusion; the former temporary empty-response cases are
// preserved externally and replaced by positive K6 SDK proof.
const explicitSources = ["fixture", "header"] as const;
test.each(cells.flatMap((cell) => explicitSources.map((source) => ({ cell, source }))))(
  "rejects unavailable $source $cell.id stream=$cell.stream before rolling",
  async ({ cell, source }) => {
    const result = await serve(cell, source);
    expect(result.status).toBe(501);
    expect(String(result.error)).toContain("aimock_misbehavior_unsupported");
    expect(result.entry.response.misbehavior).toMatchObject({
      source,
      wire: "gemini-interactions",
      applied: false,
      reason: "unsupported-on-wire",
      evaluations: [
        { entryIndex: 0, fault: "refusal", outcome: "error", reason: "unsupported-on-wire" },
      ],
    });
    expect(result.entry.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
  },
);
const scopedSources = ["baseline", "runtime"] as const;
test.each(cells.flatMap((cell) => scopedSources.map((source) => ({ cell, source }))))(
  "skips unavailable $source $cell.id stream=$cell.stream without rolling",
  async ({ cell, source }) => {
    const result = await serve(cell, source);
    expect(result.status).toBe(200);
    expect(result.raw).toContain(cell.id === "tool" ? "lookup" : "ordinary response");
    expect(result.entry.response.misbehavior).toMatchObject({
      source: source === "runtime" ? "scope" : "server",
      wire: "gemini-interactions",
      reason: "unsupported-on-wire",
      evaluations: [{ entryIndex: 0, outcome: "skipped", reason: "unsupported-on-wire" }],
    });
    expect(result.entry.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
  },
);
test.each(cells)("preserves no-config $id stream=$stream", async (cell) => {
  const result = await serve(cell, "none");
  expect(result.status).toBe(200);
  expect(result.raw).toContain(cell.id === "tool" ? "lookup" : "ordinary response");
  expect(result.entry.response.misbehavior).toBeUndefined();
});
test.each(cells)("filters provider $id stream=$stream", async (cell) => {
  const result = await serve(cell, "excluded");
  expect(result.status).toBe(200);
  expect(result.entry.response.misbehavior).toMatchObject({
    reason: "provider-excluded",
    evaluations: [{ outcome: "skipped", reason: "provider-excluded" }],
  });
});
test.each([false, true])("rejects malformed header stream=%s", async (stream) => {
  const result = await serve({ ...shapes[0], stream }, "invalid");
  expect(result.status).toBe(400);
  expect(result.calls).toBe(0);
});

test.each([false, true])("classifies resolved non-chat response stream=%s", async (stream) => {
  const result = await serve(
    { id: "error", response: { error: { message: "authored failure" }, status: 429 }, stream },
    "fixture",
  );
  expect(result.status).toBe(501);
  expect(String(result.error)).toContain("aimock_misbehavior_not_applicable");
  expect(result.entry.response.misbehavior).toMatchObject({
    reason: "not-applicable",
    evaluations: [{ outcome: "error", reason: "not-applicable" }],
  });
});

const diagnosticCases = [false, true].flatMap((stream) =>
  [false, true].map((malformed) => ({ stream, malformed })),
);
test.each(diagnosticCases)(
  "direct-server diagnostic malformed=$malformed stream=$stream logs once",
  async ({ stream, malformed }) => {
    const errors = vi.spyOn(console, "error");
    const server = await createServer(
      [
        {
          match: {},
          response: { content: "ordinary response" },
          misbehavior: { faults: [{ fault: "refusal", rate: malformed ? -1 : 0 }] },
        },
      ],
      { port: 0, logLevel: "warn", metrics: true },
    );
    try {
      const response = await fetch(`${server.url}/v1beta/interactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gemini-2.5-flash", input: "lookup", stream }),
      });
      const body: unknown = await response.json();
      const journal = server.journal.getAll();
      const metricRows = (await (await fetch(`${server.url}/metrics`)).text())
        .split("\n")
        .filter((row) => row.startsWith("aimock_misbehavior_total{"));
      console.log(
        JSON.stringify({
          stream,
          malformed,
          status: response.status,
          body,
          journal,
          errors: errors.mock.calls,
          metricRows,
        }),
      );
      expect(response.status).toBe(501);
      expect(body).toMatchObject({
        error: {
          code: malformed ? "aimock_misbehavior_not_applicable" : "aimock_misbehavior_unsupported",
        },
      });
      expect(journal).toHaveLength(1);
      expect(journal[0].response.misbehavior?.evaluations).toHaveLength(malformed ? 0 : 1);
      expect(metricRows).toHaveLength(malformed ? 0 : 1);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0].join(" ")).toContain("gemini-interactions");
      expect(errors.mock.calls[0].join(" ")).toContain(
        malformed ? "misbehavior/bad-value" : "unsupported-on-wire",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.server.close((error) => (error ? reject(error) : resolve())),
      );
      errors.mockRestore();
    }
  },
);

const objectWireLimits: MisbehaviorConfig[] = [
  { faults: [{ fault: "tool-args-invalid-json" }] },
  { faults: [{ fault: "tool-args-schema-violation", violation: "not-object" }] },
];
test.each(
  objectWireLimits.flatMap((config) =>
    ["fixture", "baseline", "runtime"].map((source) => ({ config, source }) as const),
  ),
)("nonstream permanent limit $config.faults source=$source", async ({ config, source }) => {
  if (source !== "fixture" && source !== "baseline" && source !== "runtime")
    throw new Error("Unexpected source");
  const result = await serve({ ...shapes[1], stream: false }, source, config);
  expect(result.status).toBe(source === "fixture" ? 501 : 200);
  expect(result.entry.response.misbehavior).toMatchObject({
    reason: "unsupported-on-wire",
    evaluations: [
      { reason: "unsupported-on-wire", outcome: source === "fixture" ? "error" : "skipped" },
    ],
  });
  expect(result.entry.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
});
test.each(["fixture", "baseline", "runtime"] as const)(
  "scoped applicable skip source=%s",
  async (source) => {
    const result = await serve({ ...shapes[0], stream: true }, source, {
      faults: [{ fault: "tool-args-invalid-json" }],
    });
    expect(result.status).toBe(source === "fixture" ? 501 : 200);
    expect(result.entry.response.misbehavior).toMatchObject({
      reason: "not-applicable",
      evaluations: [
        { reason: "not-applicable", outcome: source === "fixture" ? "error" : "skipped" },
      ],
    });
    expect(result.entry.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
  },
);

test.each(
  [false, true].flatMap((stream) =>
    (["fixture", "baseline", "runtime"] as const).map((source) => ({ stream, source })),
  ),
)(
  "content-filter remains unsupported stream=$stream source=$source",
  async ({ stream, source }) => {
    const result = await serve({ ...shapes[0], stream }, source, {
      faults: [{ fault: "content-filter" }],
    });
    expect(result.status).toBe(source === "fixture" ? 501 : 200);
    expect(result.entry.response.misbehavior).toMatchObject({
      reason: "unsupported-on-wire",
      evaluations: [
        { reason: "unsupported-on-wire", outcome: source === "fixture" ? "error" : "skipped" },
      ],
    });
    expect(result.entry.response.misbehavior?.evaluations[0]).not.toHaveProperty("ordinal");
  },
);
