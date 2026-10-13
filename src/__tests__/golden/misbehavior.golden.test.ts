/**
 * Golden corpus, suite `misbehavior`: applied Claude-family misbehavior on
 * Anthropic Messages and on both Bedrock invoke call sites (non-stream and
 * stream). Every fixture carries usage with prompt-cache keys. The goldens pin
 * that the misbehavior path serves `prepareClaudeMisbehavior`'s estimated
 * usage in place of the fixture's; each faulted case also asserts that usage
 * is present and that neither fixture count (`input_tokens` 11,
 * `output_tokens` 7, matched as whole numbers) is on the wire. The `control`
 * cases serve the same fixture without a fault and assert both counts do
 * reach the wire, which gives the faulted checks their contrast. The cache
 * keys do not reach the wire on these transports even without a fault, so
 * the faulted no-cache-key check only guards against them appearing.
 *
 * Determinism: each fixture's `MisbehaviorConfig` has `seed: 0`, and each
 * fault sets `rate: 1` (also the default). The planner applies a fault when
 * its seeded roll is below `rate`, and every roll is below 1, so every request
 * applies the fault. Tool-call ids are fixture-authored; message ids are
 * normalized by the harness.
 */
import type { Fixture, MisbehaviorFault } from "../../types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureHttp, expectGolden, startGoldenServer, type GoldenServer } from "./harness.js";

const SUITE = "misbehavior";

const fixtureUsage = {
  input_tokens: 11,
  output_tokens: 7,
  cache_read_input_tokens: 4,
  cache_creation_input_tokens: 3,
  cache_creation: 5,
};

const response = {
  content: "Before",
  toolCalls: [{ name: "lookup", arguments: '{"city":"Paris"}', id: "toolu_fixed_1" }],
  usage: fixtureUsage,
};

const faults: Record<string, MisbehaviorFault | undefined> = {
  control: undefined,
  refusal: { fault: "refusal", message: "No.", rate: 1 },
  "stop-length-mid-tool": { fault: "stop-length-mid-tool", at: 0.4, rate: 1 },
};

const fixtures: Fixture[] = Object.entries(faults).map(([name, fault]) => ({
  match: { userMessage: `golden misbehavior ${name}` },
  response,
  ...(fault ? { misbehavior: { seed: 0, faults: [fault] } } : {}),
}));

const tools = [
  {
    name: "lookup",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

function claudeBody(name: string, extra: Record<string, unknown>) {
  return JSON.stringify({
    max_tokens: 128,
    messages: [{ role: "user", content: `golden misbehavior ${name}` }],
    tools,
    ...extra,
  });
}

const json = { "content-type": "application/json" };
const bedrockModel = "anthropic.claude-3-sonnet-20240229-v1:0";

type Transport = {
  id: string;
  path: string;
  frames?: "sse" | "aws";
  body: (name: string) => string;
};

const transports: Transport[] = [
  {
    id: "messages-nonstream",
    path: "/v1/messages",
    body: (name) => claudeBody(name, { model: "claude-sonnet-4-20250514" }),
  },
  {
    id: "messages-stream",
    path: "/v1/messages",
    frames: "sse",
    body: (name) => claudeBody(name, { model: "claude-sonnet-4-20250514", stream: true }),
  },
  {
    id: "bedrock-invoke-nonstream",
    path: `/model/${bedrockModel}/invoke`,
    body: (name) => claudeBody(name, { anthropic_version: "bedrock-2023-05-31" }),
  },
  {
    id: "bedrock-invoke-stream",
    path: `/model/${bedrockModel}/invoke-with-response-stream`,
    frames: "aws",
    body: (name) => claudeBody(name, { anthropic_version: "bedrock-2023-05-31" }),
  },
];

/**
 * Every whole-number value of `key` in `text`, a `JSON.stringify` of a
 * capture (so the key's quotes may be backslash-escaped, at any depth).
 * Whole numbers only: 11 never matches 110.
 */
function tokenCounts(text: string, key: string): number[] {
  const re = new RegExp(`\\\\*"${key}\\\\*":(\\d+)(?!\\d)`, "g");
  return [...text.matchAll(re)].map((m) => Number(m[1]));
}

let srv: GoldenServer;

beforeAll(async () => {
  srv = await startGoldenServer(fixtures, { enableMisbehavior: true });
});
afterAll(async () => {
  await srv.close();
});

describe("misbehavior golden corpus (suite: misbehavior)", () => {
  for (const transport of transports) {
    for (const name of Object.keys(faults)) {
      const caseName = `${transport.id}-${name}`;
      it(caseName, async () => {
        const got = await captureHttp(`${srv.url}${transport.path}`, {
          method: "POST",
          headers: json,
          body: transport.body(name),
          ...(transport.frames ? { frames: transport.frames } : {}),
        });
        expect(got.status).toBe(200);
        expect(got.tail).toBeUndefined();
        const text = JSON.stringify(got);
        const inputs = tokenCounts(text, "input_tokens");
        const outputs = tokenCounts(text, "output_tokens");
        // Every case reports usage; an empty list would make the checks below vacuous.
        expect(inputs, "input_tokens values").not.toEqual([]);
        expect(outputs, "output_tokens values").not.toEqual([]);
        if (name === "control") {
          // Without a fault the fixture's token counts reach the wire.
          expect(inputs).toContain(fixtureUsage.input_tokens);
          expect(outputs).toContain(fixtureUsage.output_tokens);
        } else {
          // Applied faults serve estimated usage: neither fixture count is on
          // the wire. Cache keys are absent in control too, so that check only
          // guards against them appearing.
          expect(inputs).not.toContain(fixtureUsage.input_tokens);
          expect(outputs).not.toContain(fixtureUsage.output_tokens);
          expect(text).not.toMatch(/cache_(read|creation)/);
        }
        expectGolden(SUITE, caseName, got);
      });
    }
  }
});
