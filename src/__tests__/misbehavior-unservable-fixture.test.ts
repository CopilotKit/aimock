/**
 * A fixture the wire cannot serve for a reason other than its tool calls (a
 * malformed text block or an unknown block type) behaves exactly as it does
 * with no misbehavior config: same response, same journal entry, same Gemini
 * Live history and fixture match count. A misbehavior config, whether it
 * excludes the wire or targets it, never faults the fixture and never makes
 * the planner throw before the handler journals the request.
 *
 * Real surfaces: a real server over WebSocket (Realtime, Gemini Live) and
 * HTTP (Gemini Interactions).
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

const livePath = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const fixtures: [string, FixtureResponse][] = [
  ["malformed text block", { blocks: [{ type: "text" }] } as unknown as FixtureResponse],
  ["unknown block type", { blocks: [{ type: "image", url: "x" }] } as unknown as FixtureResponse],
];
const configs: [string, MisbehaviorConfig][] = [
  ["excludes the wire", { faults: [{ fault: "empty-response", providers: ["anthropic"] }] }],
  ["targets the wire", { faults: [{ fault: "empty-response" }] }],
];

type Json = Record<string, unknown>;

/** Strip per-run ids, timestamps and headers so two servers' outputs compare equal. */
function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) =>
      ["event_id", "id", "timestamp", "headers"].includes(key) ? undefined : v,
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
    ...(misbehavior ? { misbehavior } : {}),
  });
  const output = await drive(server.url);
  const journal = (await (await fetch(`${server.url}/__aimock/journal`)).json()) as unknown;
  const matchCount = server.journal.fixtureMatchCounts.get(fixture) ?? 0;
  ws?.destroy();
  ws = undefined;
  await new Promise<void>((resolve) => server!.server.close(() => resolve()));
  server = undefined;
  return stable({ output, journal, matchCount }) as {
    output: unknown;
    journal: Json[];
    matchCount: number;
  };
}

async function realtime(url: string) {
  ws = await connectWebSocket(url, "/v1/realtime");
  await ws.waitForMessages(1);
  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
    }),
  );
  await ws.waitForMessages(2);
  ws.send(JSON.stringify({ type: "response.create" }));
  const raw = await ws.waitForMessages(3);
  return raw.slice(2).map((m) => JSON.parse(m) as Json);
}

async function geminiLive(url: string) {
  ws = await connectWebSocket(url, livePath);
  ws.send(JSON.stringify({ setup: { model: "gemini-live" } }));
  await ws.waitForMessages(1);
  const events: Json[] = [];
  for (const text of ["go", "again"]) {
    const count = ws.getMessages().length + 1;
    ws.send(
      JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
      }),
    );
    events.push(JSON.parse((await ws.waitForMessages(count))[count - 1]) as Json);
  }
  return events;
}

const interactions = (stream: boolean) => async (url: string) => {
  const res = await fetch(`${url}/v1beta/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gemini-2.5-flash", input: "go", stream }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: await res.text() };
};

const wires: [string, (url: string) => Promise<unknown>][] = [
  ["OpenAI Realtime", realtime],
  ["Gemini Live", geminiLive],
  ["Gemini Interactions", interactions(false)],
  ["Gemini Interactions streaming", interactions(true)],
];

describe("misbehavior never changes how an unservable fixture is reported", () => {
  for (const [wire, drive] of wires) {
    describe(wire, () => {
      it.each(fixtures.flatMap(([f, r]) => configs.map(([c, m]) => [f, c, r, m] as const)))(
        "%s, misbehavior config %s",
        async (_f, _c, response, misbehavior) => {
          const plain = await observe(response, undefined, drive);
          const faulted = await observe(response, misbehavior, drive);
          // The baseline: the request is journaled with its body and fixture,
          // and carries no misbehavior summary.
          expect(plain.journal.length).toBeGreaterThan(0);
          for (const entry of plain.journal) {
            expect(entry.body).not.toBeNull();
            expect((entry.response as Json).fixture).not.toBeNull();
            expect(entry.response).not.toHaveProperty("misbehavior");
          }
          expect(faulted).toEqual(plain);
        },
      );
    });
  }

  it("Gemini Live keeps the first user turn in history exactly as with no config", async () => {
    const [, response] = fixtures[0];
    const faulted = await observe(response, configs[0][1], geminiLive);
    const history = faulted.journal.map((entry) => (entry.body as { messages: unknown }).messages);
    expect(history).toEqual([
      [{ role: "user", content: "go" }],
      [
        { role: "user", content: "go" },
        { role: "user", content: "again" },
      ],
    ]);
  });
});
