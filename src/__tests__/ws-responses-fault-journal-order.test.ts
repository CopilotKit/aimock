/**
 * A fixture the Responses WebSocket transport cannot serve (malformed
 * `citations`, or a non-image generated file) answers the WebSocket error
 * event with the fixture error's aimock code. The journal must say what
 * happened, as on HTTP `/v1/responses`: the entry carries the matched fixture
 * and status 500, and no misbehavior fault is recorded as applied, in the
 * entry or in `aimock_misbehavior_total`.
 *
 * Real surface: a real aimock server over a real WebSocket, reading its own
 * journal and /metrics.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ServerInstance } from "../server.js";
import type { Fixture, FixtureResponse, MisbehaviorFault, TextResponse } from "../types.js";
import { createServer } from "./helpers/misbehavior-enabled.js";
import { connectWebSocket } from "./ws-test-client.js";

const CITE = "aimock_invalid_fixture_citation";
const FILES = "aimock_unsupported_generated_file";
const badCitations = [{ url: "https://example.com", startIndex: 0, endIndex: 999 }];
const pdf = [{ mimeType: "application/pdf", data: "JVBERi0=" }];
const text = "Hello world.";
const toolCalls = [{ name: "lookup", arguments: '{"q":"x"}' }];

interface Cell {
  name: string;
  /** A servable fixture response. */
  response: FixtureResponse;
  /** What makes it unservable on the Responses API. */
  unservable: Pick<TextResponse, "files" | "citations">;
  code: string;
  /** What the journal error names. */
  errorNames: string;
  fault?: MisbehaviorFault;
}

const cells: Cell[] = [
  {
    name: "text + bad citations, no fault",
    response: { content: text },
    unservable: { citations: badCitations },
    code: CITE,
    errorNames: "citations",
  },
  {
    name: "text + non-image file, no fault",
    response: { content: text },
    unservable: { files: pdf },
    code: FILES,
    errorNames: "application/pdf",
  },
  {
    name: "tool-unknown-name + bad citations",
    response: { content: text, toolCalls },
    unservable: { citations: badCitations },
    code: CITE,
    errorNames: "citations",
    fault: { fault: "tool-unknown-name" },
  },
  {
    name: "tool-unknown-name + non-image file",
    response: { content: text, toolCalls },
    unservable: { files: pdf },
    code: FILES,
    errorNames: "application/pdf",
    fault: { fault: "tool-unknown-name" },
  },
];

let instance: ServerInstance | undefined;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = undefined;
  }
});

function fixtureFor(cell: Cell, response: FixtureResponse): Fixture {
  return {
    match: {},
    response,
    ...(cell.fault ? { misbehavior: { faults: [{ ...cell.fault, rate: 1 }] } } : {}),
  };
}

/** Send one response.create and collect events through the terminal one. */
async function exchange(url: string): Promise<Record<string, unknown>[]> {
  const ws = await connectWebSocket(url, "/v1/responses");
  try {
    ws.send(JSON.stringify({ type: "response.create", model: "gpt-4o", input: "go" }));
    const events: Record<string, unknown>[] = [];
    const deadline = Date.now() + 5000;
    for (;;) {
      const messages = await ws.waitForMessages(
        events.length + 1,
        Math.max(1, deadline - Date.now()),
      );
      const event = JSON.parse(messages.at(-1)!) as Record<string, unknown>;
      events.push(event);
      if (event.type === "error" || event.type === "response.completed") return events;
    }
  } finally {
    ws.close();
  }
}

function appliedMetricLines(metrics: string): string[] {
  return metrics
    .split("\n")
    .filter(
      (line) => line.startsWith("aimock_misbehavior_total{") && line.includes('outcome="applied"'),
    );
}

describe("Responses WebSocket: an unservable fixture is journaled as a 500 with its fixture", () => {
  for (const cell of cells) {
    it(cell.name, async () => {
      const fixture = fixtureFor(cell, { ...cell.response, ...cell.unservable });
      instance = await createServer([fixture], { metrics: true });
      const events = await exchange(instance.url);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      const error = events[0].error as { type?: string; code?: string; message?: string };
      expect(error.type).toBe("server_error");
      expect(error.code).toBe(cell.code);
      expect(error.message).toContain(cell.errorNames);

      const entries = instance.journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].method).toBe("WS");
      expect(entries[0].response.status).toBe(500);
      expect(entries[0].response.fixture).toBe(fixture);
      expect(entries[0].response.error).toContain(cell.errorNames);
      const applied = (entries[0].response.misbehavior?.evaluations ?? []).filter(
        (row) => row.outcome === "applied",
      );
      expect(applied).toEqual([]);

      const metrics = await (await fetch(`${instance.url}/metrics`)).text();
      expect(appliedMetricLines(metrics)).toEqual([]);
    });
  }
});

describe("Responses WebSocket: the same fixture made servable is still served", () => {
  for (const cell of cells) {
    it(cell.name, async () => {
      const fixture = fixtureFor(cell, cell.response);
      instance = await createServer([fixture], { metrics: true });
      const events = await exchange(instance.url);

      expect(events.at(-1)?.type).toBe("response.completed");

      const entries = instance.journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(200);
      expect(entries[0].response.fixture).toBe(fixture);
      const outcomes = (entries[0].response.misbehavior?.evaluations ?? []).map(
        (row) => row.outcome,
      );
      expect(outcomes).toEqual(cell.fault ? ["applied"] : []);

      const metrics = await (await fetch(`${instance.url}/metrics`)).text();
      expect(appliedMetricLines(metrics)).toHaveLength(cell.fault ? 1 : 0);
    });
  }
});
