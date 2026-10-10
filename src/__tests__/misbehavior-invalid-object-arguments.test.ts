/**
 * A wire that carries tool arguments as an object must JSON.parse a fixture's
 * string `arguments`, and rejects invalid JSON with aimock_invalid_tool_arguments.
 * Such a fixture is one the wire cannot serve, so a misbehavior config never
 * faults it: the response, the journal entry and the match count are exactly
 * those of the same request with no misbehavior config.
 *
 * Wires that pass the authored string through (the OpenAI wires and the
 * streaming Anthropic path, for example) still serve the fixture, so the fault
 * still applies there.
 *
 * Real surfaces: a real server over HTTP and WebSocket (Gemini Live).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture, FixtureResponse, MisbehaviorConfig } from "../types.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

let server: ServerInstance | undefined;
let ws: WSTestClient | undefined;
afterEach(async () => {
  ws?.destroy();
  ws = undefined;
  if (server) await new Promise<void>((resolve) => server!.server.close(() => resolve()));
  server = undefined;
});

type Json = Record<string, unknown>;

const fixtures: [string, FixtureResponse][] = [
  ["toolCalls", { toolCalls: [{ name: "weather", arguments: "{bad" }] }],
  [
    "blocks",
    {
      blocks: [
        { type: "text", text: "hi" },
        { type: "toolCall", name: "weather", arguments: "{bad" },
      ],
    },
  ],
];
const faults: MisbehaviorConfig[] = [
  { faults: [{ fault: "empty-response" }] },
  { faults: [{ fault: "tool-unknown-name" }] },
];

/** Strip per-run ids and timestamps so two servers' outputs compare equal. */
function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) =>
      ["id", "event_id", "timestamp", "headers", "created", "created_at"].includes(key)
        ? undefined
        : v,
    ),
  ) as unknown;
}

async function observe(
  response: FixtureResponse,
  misbehavior: MisbehaviorConfig | undefined,
  drive: (url: string) => Promise<unknown>,
) {
  const fixture: Fixture = { match: {}, response };
  server = await createServer([fixture], {
    logLevel: "silent",
    strictToolArguments: true,
    ...(misbehavior ? { misbehavior } : {}),
  });
  const output = await drive(server.url);
  const journal = (await (await fetch(`${server.url}/__aimock/journal`)).json()) as Json[];
  const matchCount = server.journal.fixtureMatchCounts.get(fixture) ?? 0;
  ws?.destroy();
  ws = undefined;
  await new Promise<void>((resolve) => server!.server.close(() => resolve()));
  server = undefined;
  return stable({ output, journal, matchCount }) as {
    output: { status: number; body: string } | unknown[];
    journal: Json[];
    matchCount: number;
  };
}

const post = (path: string, body: Json) => async (url: string) => {
  const res = await fetch(url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // SSE or NDJSON stays text.
  }
  return { status: res.status, body: parsed };
};

const livePath = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
async function geminiLive(url: string) {
  ws = await connectWebSocket(url, livePath);
  ws.send(JSON.stringify({ setup: { model: "gemini-live" } }));
  await ws.waitForMessages(1);
  ws.send(
    JSON.stringify({
      clientContent: { turns: [{ role: "user", parts: [{ text: "go" }] }], turnComplete: true },
    }),
  );
  const raw = await ws.waitForMessages(2);
  return raw.slice(1).map((m) => JSON.parse(m) as Json);
}

const messages = [{ role: "user", content: "go" }];
const rejecting: [string, (url: string) => Promise<unknown>][] = [
  [
    "Anthropic Messages",
    post("/v1/messages", { model: "claude-x", max_tokens: 64, messages, stream: false }),
  ],
  [
    "Gemini Interactions",
    post("/v1beta/interactions", { model: "gemini-2.5-flash", input: "go", stream: false }),
  ],
  ["Gemini Live", geminiLive],
  [
    "Gemini streaming",
    post("/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
      contents: [{ role: "user", parts: [{ text: "go" }] }],
    }),
  ],
  [
    "Bedrock InvokeModel",
    post("/model/anthropic.claude-x/invoke", {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 64,
      messages,
    }),
  ],
  [
    "Bedrock Converse",
    post("/model/anthropic.claude-x/converse", {
      messages: [{ role: "user", content: [{ text: "go" }] }],
    }),
  ],
  ["Ollama chat streaming", post("/api/chat", { model: "llama3", messages, stream: true })],
];

const cases = fixtures.flatMap(([f, r]) =>
  faults.map((m) => [f, m.faults[0].fault, r, m] as const),
);

describe("misbehavior never faults invalid JSON arguments on an object-arguments wire", () => {
  for (const [wire, drive] of rejecting) {
    describe(wire, () => {
      it.each(cases)("fixture %s, fault %s", async (_f, _fault, response, misbehavior) => {
        const plain = await observe(response, undefined, drive);
        const faulted = await observe(response, misbehavior, drive);
        // The baseline rejects the fixture with the coded error and journals
        // the request with its body and fixture, without a misbehavior summary.
        expect(JSON.stringify(plain.output)).toMatch(
          /aimock_invalid_tool_arguments|AIMOCK_INVALID_TOOL_ARGUMENTS/,
        );
        expect(JSON.stringify(plain.output)).not.toContain("weather_v2");
        expect(plain.journal).toHaveLength(1);
        expect(plain.journal[0].body).not.toBeNull();
        expect((plain.journal[0].response as Json).fixture).not.toBeNull();
        expect(plain.journal[0].response).not.toHaveProperty("misbehavior");
        expect(faulted).toEqual(plain);
      });
    });
  }
});

describe("wires that pass invalid JSON arguments through still apply the fault", () => {
  const passing: [string, (url: string) => Promise<unknown>][] = [
    [
      "Anthropic Messages streaming",
      post("/v1/messages", { model: "claude-x", max_tokens: 64, messages, stream: true }),
    ],
    ["OpenAI Chat Completions", post("/v1/chat/completions", { model: "gpt-4o", messages })],
  ];
  for (const [wire, drive] of passing) {
    it(`${wire}: tool-unknown-name renames the served tool`, async () => {
      const plain = await observe(fixtures[0][1], undefined, drive);
      const faulted = await observe(fixtures[0][1], faults[1], drive);
      expect((plain.output as { status: number }).status).toBe(200);
      expect((faulted.output as { status: number }).status).toBe(200);
      expect(JSON.stringify(faulted.output)).toContain("weather_v2");
      const summary = (faulted.journal[0].response as Json).misbehavior as Json;
      expect(summary).toMatchObject({ applied: true, fault: "tool-unknown-name" });
    });
  }
});
