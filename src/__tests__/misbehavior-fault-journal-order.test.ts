/**
 * A misbehavior fault applied to a fixture that cannot be served (generated
 * `files` on a wire with no projection for them, or malformed `citations`)
 * answers a coded 500. The journal must say what happened: the entry carries
 * the matched fixture and status 500, and the fault is NOT recorded as
 * applied, in the entry or in `aimock_misbehavior_total`. The request was
 * never served with the fault, so counting it would lie.
 *
 * Real surface: a real aimock server over HTTP, reading its own journal and
 * /metrics.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerInstance } from "../server.js";
import type { Fixture, FixtureResponse, MisbehaviorFault, TextResponse, WireId } from "../types.js";
import { createServer } from "./helpers/misbehavior-enabled.js";

const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };
const badCitations = [{ url: "https://example.com", startIndex: 0, endIndex: 999 }];

interface Route {
  name: string;
  path: string;
  body: Record<string, unknown>;
  code: string;
  /** The `wire` label the misbehavior counter carries for this route. */
  wire: WireId;
}

const chatBody = { model: "gpt-4o", messages: [{ role: "user", content: "go" }] };
const messagesBody = {
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "go" }],
};
// Gemini serves a renamed tool through its ordinary builders only when the
// request declares tools.
const geminiBody = {
  contents: [{ role: "user", parts: [{ text: "go" }] }],
  tools: [{ functionDeclarations: [{ name: "lookup", parameters: { type: "object" } }] }],
};
const responsesBody = { model: "gpt-4o", input: "go" };

interface Cell {
  wire: string;
  routes: Route[];
  /** A servable fixture response. */
  response: FixtureResponse;
  /** What makes it unservable on this wire. */
  unservable: Pick<TextResponse, "files" | "citations">;
  fault: MisbehaviorFault;
}

function both(
  name: string,
  path: string,
  body: Record<string, unknown>,
  code: string,
  wire: WireId,
): Route[] {
  const streamPath = path.includes(":generateContent")
    ? path.replace(":generateContent", ":streamGenerateContent?alt=sse")
    : path;
  return [
    { name, path, body, code, wire },
    {
      name: `${name} stream`,
      path: streamPath,
      body: streamPath === path ? { ...body, stream: true } : body,
      code,
      wire,
    },
  ];
}

const FILES = "aimock_unsupported_generated_file";
const CITE = "aimock_invalid_fixture_citation";
const chatFiles = both("Chat", "/v1/chat/completions", chatBody, FILES, "openai-chat");
const chatCite = both("Chat", "/v1/chat/completions", chatBody, CITE, "openai-chat");
const messagesFiles = both("Anthropic", "/v1/messages", messagesBody, FILES, "anthropic");
const messagesCite = both("Anthropic", "/v1/messages", messagesBody, CITE, "anthropic");
const geminiCite = both(
  "Gemini",
  "/v1beta/models/gemini-2.0-flash:generateContent",
  geminiBody,
  CITE,
  "gemini",
);
const responsesCite = both("Responses", "/v1/responses", responsesBody, CITE, "openai-responses");

const text = "Hello world.";
const toolCalls = [{ name: "lookup", arguments: '{"q":"x"}' }];

const cells: Cell[] = [
  // Chat fault terminals (refusal / content-filter / reasoning-only).
  {
    wire: "chat refusal + files",
    routes: chatFiles,
    response: { content: text },
    unservable: { files: [png] },
    fault: { fault: "refusal" },
  },
  {
    wire: "chat reasoning-only + files",
    routes: chatFiles,
    response: { content: text },
    unservable: { files: [png] },
    fault: { fault: "reasoning-only", reasoning: "Thinking." },
  },
  // Chat ordinary builders under an applied fault.
  {
    wire: "chat tool-args-invalid-json + files (tool calls)",
    routes: chatFiles,
    response: { toolCalls },
    unservable: { files: [png] },
    fault: { fault: "tool-args-invalid-json" },
  },
  {
    wire: "chat tool-args-invalid-json + files (content + tool calls)",
    routes: chatFiles,
    response: { content: text, toolCalls },
    unservable: { files: [png] },
    fault: { fault: "tool-args-invalid-json" },
  },
  {
    wire: "chat tool-unknown-name + bad citations (content + tool calls)",
    routes: chatCite,
    response: { content: text, toolCalls },
    unservable: { citations: badCitations },
    fault: { fault: "tool-unknown-name" },
  },
  // Anthropic applied fault.
  {
    wire: "anthropic refusal + files",
    routes: messagesFiles,
    response: { content: text },
    unservable: { files: [png] },
    fault: { fault: "refusal" },
  },
  {
    wire: "anthropic tool-unknown-name + bad citations",
    routes: messagesCite,
    response: { content: text, toolCalls },
    unservable: { citations: badCitations },
    fault: { fault: "tool-unknown-name" },
  },
  // Gemini and Responses applied faults.
  {
    wire: "gemini tool-unknown-name + bad citations",
    routes: geminiCite,
    response: { content: text, toolCalls },
    unservable: { citations: badCitations },
    fault: { fault: "tool-unknown-name" },
  },
  {
    wire: "responses tool-unknown-name + bad citations",
    routes: responsesCite,
    response: { content: text, toolCalls },
    unservable: { citations: badCitations },
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

function misbehaviorLines(metrics: string): string[] {
  return metrics.split("\n").filter((line) => line.startsWith("aimock_misbehavior_total{"));
}

describe("a fault on a fixture that cannot be served is journaled as a 500, not an applied fault", () => {
  for (const cell of cells) {
    for (const route of cell.routes) {
      it(`${cell.wire} — ${route.name}`, async () => {
        const fixture: Fixture = {
          match: {},
          response: { ...cell.response, ...cell.unservable },
          misbehavior: { faults: [{ ...cell.fault, rate: 1 }] },
        };
        instance = await createServer([fixture], { metrics: true });
        const res = await fetch(`${instance.url}${route.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(route.body),
        });
        const raw = await res.text();
        expect(res.status).toBe(500);
        expect(raw).toContain(route.code);

        const entries = instance.journal.getAll();
        expect(entries).toHaveLength(1);
        expect(entries[0].response.status).toBe(500);
        expect(entries[0].response.fixture).toBe(fixture);
        expect(entries[0].response.error).toContain(route.code === FILES ? "files" : "citations");
        // Exact recorded state: the entry carries no misbehavior record at all,
        // so nothing claims the fault was applied.
        expect(entries[0].response.misbehavior).toBeUndefined();

        // And the counter has no series at all, applied or otherwise.
        const metrics = await (await fetch(`${instance.url}/metrics`)).text();
        expect(misbehaviorLines(metrics)).toEqual([]);
      });
    }
  }
});

describe("the same fault on a servable fixture is still recorded as applied", () => {
  for (const cell of cells) {
    for (const route of cell.routes) {
      it(`${cell.wire} — ${route.name}`, async () => {
        const fixture: Fixture = {
          match: {},
          response: cell.response,
          misbehavior: { faults: [{ ...cell.fault, rate: 1 }] },
        };
        instance = await createServer([fixture], { metrics: true });
        const res = await fetch(`${instance.url}${route.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(route.body),
        });
        await res.text();
        expect(res.status).toBe(200);

        const entries = instance.journal.getAll();
        expect(entries).toHaveLength(1);
        expect(entries[0].response.status).toBe(200);
        expect(entries[0].response.fixture).toBe(fixture);
        const record = entries[0].response.misbehavior;
        expect(record?.applied).toBe(true);
        expect(record?.fault).toBe(cell.fault.fault);
        expect(record?.evaluations.map((row) => [row.fault, row.outcome])).toEqual([
          [cell.fault.fault, "applied"],
        ]);

        // The counter holds exactly one series for this fault, with value 1.
        const metrics = await (await fetch(`${instance.url}/metrics`)).text();
        expect(misbehaviorLines(metrics)).toEqual([
          `aimock_misbehavior_total{fault="${cell.fault.fault}",outcome="applied",wire="${route.wire}"} 1`,
        ]);
      });
    }
  }
});

/** The request body with its user text ("go") replaced, so a fixture can match it. */
function withUserText(body: Record<string, unknown>, userText: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body).replace('"go"', JSON.stringify(userText))) as Record<
    string,
    unknown
  >;
}

async function post(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("a fixture that cannot be served spends no fault budget and no seed ordinal", () => {
  for (const cell of cells) {
    for (const route of cell.routes) {
      it(`${cell.wire} — ${route.name}`, async () => {
        // A server-wide fault with `times: 1` is shared by every fixture, so
        // the unservable request and the servable one draw on the same budget.
        const fault = { ...cell.fault, rate: 1, times: 1 } as MisbehaviorFault;
        const fixtures = (): Fixture[] => [
          { match: { userMessage: "bad" }, response: { ...cell.response, ...cell.unservable } },
          { match: { userMessage: "good" }, response: cell.response },
        ];

        // Control: the servable request alone, on a fresh server.
        instance = await createServer(fixtures(), { misbehavior: { faults: [fault] } });
        const control = await post(
          `${instance.url}${route.path}`,
          withUserText(route.body, "good"),
        );
        await control.text();
        expect(control.status).toBe(200);
        const controlRow = instance.journal.getAll()[0].response.misbehavior?.evaluations[0];
        expect(controlRow?.outcome).toBe("applied");
        await new Promise<void>((resolve) => instance!.server.close(() => resolve()));

        instance = await createServer(fixtures(), { misbehavior: { faults: [fault] } });
        const bad = await post(`${instance.url}${route.path}`, withUserText(route.body, "bad"));
        expect(await bad.text()).toContain(route.code);
        expect(bad.status).toBe(500);
        const good = await post(`${instance.url}${route.path}`, withUserText(route.body, "good"));
        await good.text();
        expect(good.status).toBe(200);

        const entries = instance.journal.getAll();
        expect(entries).toHaveLength(2);
        const rows = entries[1].response.misbehavior?.evaluations ?? [];
        expect(rows.map((row) => row.outcome)).toEqual(["applied"]);
        // The same ordinal as the request alone: the rejected one drew none.
        expect(rows[0].ordinal).toBe(controlRow?.ordinal);
      });
    }
  }
});

interface PendingRequest {
  /** Resolves with the status, or 0 when the request was aborted. */
  done: Promise<number>;
  abort: () => void;
}

function startRequest(url: string, body: Record<string, unknown>): PendingRequest {
  const payload = JSON.stringify(body);
  let req: http.ClientRequest | undefined;
  const done = new Promise<number>((resolve) => {
    req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", () => resolve(0));
    req.end(payload);
  });
  return { done, abort: () => req?.destroy() };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll the server journal until `ready` holds for its entries, or 5s pass. A
 * fixed sleep assumes the request reached the server in time, which a loaded
 * machine does not promise.
 */
async function pollJournal<T>(
  read: () => Promise<T[]> | T[],
  ready: (entries: T[]) => boolean,
): Promise<T[]> {
  const deadline = Date.now() + 5_000;
  let entries = await read();
  while (!ready(entries) && Date.now() < deadline) {
    await sleep(10);
    entries = await read();
  }
  return entries;
}

interface TimedCell {
  name: string;
  response: FixtureResponse;
  fault: MisbehaviorFault;
}

// One cell per non-stream Chat branch: fault terminal, text, tool calls, content + tool calls.
const timedCells: TimedCell[] = [
  { name: "refusal terminal", response: { content: text }, fault: { fault: "refusal" } },
  { name: "text", response: { content: text }, fault: { fault: "empty-response" } },
  { name: "tool calls", response: { toolCalls }, fault: { fault: "tool-unknown-name" } },
  {
    name: "content + tool calls",
    response: { content: text, toolCalls },
    fault: { fault: "tool-unknown-name" },
  },
];

const WAIT_MS = 600;

describe("a non-stream Chat reply records its fault before the timing wait", () => {
  for (const cell of timedCells) {
    const fixture = (): Fixture => ({
      match: {},
      response: cell.response,
      misbehavior: { faults: [{ ...cell.fault, rate: 1 } as MisbehaviorFault] },
      streamingProfile: { ttft: WAIT_MS, tps: 1_000_000 },
      nonStreamingTiming: true,
    });

    it(`${cell.name}: the journal shows the applied fault while the reply waits`, async () => {
      instance = await createServer([fixture()]);
      const pending = startRequest(`${instance.url}/v1/chat/completions`, chatBody);
      const url = `${instance.url}/__aimock/journal`;
      const journal = await pollJournal(
        async () =>
          (await (await fetch(url)).json()) as {
            response: { status: number; misbehavior?: { applied: boolean } };
          }[],
        (entries) => entries.length > 0,
      );
      expect(journal).toHaveLength(1);
      expect(journal[0].response.status).toBe(200);
      expect(journal[0].response.misbehavior?.applied).toBe(true);
      expect(await pending.done).toBe(200);
    });

    it(`${cell.name}: a client that hangs up during the wait is journaled as not served`, async () => {
      instance = await createServer([fixture()]);
      const pending = startRequest(`${instance.url}/v1/chat/completions`, chatBody);
      const journal = instance.journal;
      // Hang up only once the server has the request, during its wait.
      await pollJournal(
        () => journal.getAll(),
        (entries) => entries.length > 0,
      );
      pending.abort();
      expect(await pending.done).toBe(0);
      const entries = await pollJournal(
        () => journal.getAll(),
        (all) => all[0]?.response.interrupted === true,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(0);
      expect(entries[0].response.interrupted).toBe(true);
      expect(entries[0].response.interruptReason).toBe("client aborted");
      // The fault was prepared for this request; the entry still says which.
      expect(entries[0].response.misbehavior?.applied).toBe(true);
    });
  }
});
