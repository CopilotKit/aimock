/**
 * #518 R2-F1/F2/F3 — the control-API fixture listing and the journal show a
 * loaded fixture exactly as 1.44.0 did unless the server runs with
 * `responsesTools: "extended"`. 1.44.0 dropped `match.toolNamespace` at load,
 * kept `customToolCalls` / `responsesBlocks` as written, and never counted
 * `responsesBlocks` toward the listed `responseKind`.
 *
 * The legacy expectations below are the bytes published 1.44.0 returns for the
 * same fixture file and requests.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { createServer, type ServerInstance } from "../server.js";
import { loadFixtureFile, normalizeResponse } from "../fixture-loader.js";
import { isCombinedFixtureResponse, isContentWithToolCallsResponse } from "../helpers.js";
import {
  collapseOpenAISSE,
  collapseOpenAISSEWithResponsesTools,
  collapseStreamingResponse,
  collapseStreamingResponseWithResponsesTools,
} from "../stream-collapse.js";
import type { Fixture, FixtureFileEntry, FixtureFileResponse, FixtureResponse } from "../types.js";

const ENTRIES: FixtureFileEntry[] = [
  {
    match: { userMessage: "k1" },
    response: { content: "ok", responsesBlocks: [{ type: "text", text: "ok" }] },
  } as FixtureFileEntry,
  {
    match: { userMessage: "k4" },
    response: {
      toolCalls: [{ name: "f", arguments: "{}" }],
      responsesBlocks: [{ type: "text", text: "ok" }],
    },
  } as FixtureFileEntry,
  {
    match: { userMessage: "ctc" },
    response: {
      content: "ok",
      customToolCalls: [{ name: "p", input: "x" }],
      responsesBlocks: [{ type: "toolCall", name: "f", arguments: { a: 1 } }],
    },
  } as FixtureFileEntry,
  { match: { userMessage: "tns", toolNamespace: "nsX" }, response: { content: "TNS" } },
  {
    match: { userMessage: "tn2", toolName: "t", toolNamespace: "nsX" },
    response: { content: "TN2" },
  },
];

const LEGACY_LISTING =
  '[{"index":0,"match":{"userMessage":"k1"},"responseKind":"text"},' +
  '{"index":1,"match":{"userMessage":"k4"},"responseKind":"toolCalls"},' +
  '{"index":2,"match":{"userMessage":"ctc"},"responseKind":"text"},' +
  '{"index":3,"match":{"userMessage":"tns"},"responseKind":"text"},' +
  '{"index":4,"match":{"userMessage":"tn2","toolName":"t"},"responseKind":"text"}]';

const EXTENDED_LISTING =
  '[{"index":0,"match":{"userMessage":"k1"},"responseKind":"contentWithToolCalls"},' +
  '{"index":1,"match":{"userMessage":"k4"},"responseKind":"contentWithToolCalls"},' +
  '{"index":2,"match":{"userMessage":"ctc"},"responseKind":"contentWithToolCalls"},' +
  '{"index":3,"match":{"userMessage":"tns","toolNamespace":"nsX"},"responseKind":"text"},' +
  '{"index":4,"match":{"userMessage":"tn2","toolName":"t","toolNamespace":"nsX"},' +
  '"responseKind":"text"}]';

const LEGACY_CTC =
  '{"match":{"userMessage":"ctc"},"response":{"content":"ok",' +
  '"customToolCalls":[{"name":"p","input":"x"}],' +
  '"responsesBlocks":[{"type":"toolCall","name":"f","arguments":{"a":1}}]}}';

const EXTENDED_CTC =
  '{"match":{"userMessage":"ctc"},"response":{"content":"ok",' +
  '"customToolCalls":[{"name":"p","input":"x","type":"custom"}],' +
  '"responsesBlocks":[{"type":"toolCall","name":"f","arguments":"{\\"a\\":1}"}]}}';

let dir: string | undefined;
let mock: LLMock | undefined;
let server: ServerInstance | undefined;

afterEach(async () => {
  await mock?.stop();
  mock = undefined;
  if (server) await new Promise<void>((resolve) => server!.server.close(() => resolve()));
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function fixtureFile(): string {
  dir = mkdtempSync(join(tmpdir(), "responses-tools-surfaces-"));
  const file = join(dir, "fx.json");
  writeFileSync(file, JSON.stringify({ fixtures: ENTRIES }));
  return file;
}

async function listing(url: string): Promise<string> {
  const body = (await (await fetch(`${url}/__aimock/fixtures?include=fixtures`)).json()) as {
    fixtures: unknown[];
  };
  return JSON.stringify(body.fixtures);
}

/** Send the requests, then return each journal entry's fixture as JSON. */
async function journalFixtures(url: string): Promise<string[]> {
  const send = (path: string, body: object) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.text());
  await send("/v1/chat/completions", {
    model: "gpt-4o",
    messages: [{ role: "user", content: "ctc" }],
  });
  await send("/v1/responses", {
    model: "gpt-4o",
    input: "tns",
    tools: [{ type: "namespace", name: "nsX", tools: [{ type: "function", name: "t" }] }],
  });
  const entries = (await (await fetch(`${url}/__aimock/journal`)).json()) as {
    response: { fixture: unknown };
  }[];
  return entries.map((e) => JSON.stringify(e.response.fixture));
}

describe("responsesTools keys on control-API surfaces", () => {
  it("default mode: listing and journal match 1.44.0 for a loaded file", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.loadFixtureFile(fixtureFile());
    await mock.start();
    expect(await listing(mock.url)).toBe(LEGACY_LISTING);
    expect(await journalFixtures(mock.url)).toEqual([
      LEGACY_CTC,
      '{"match":{"userMessage":"tns"},"response":{"content":"TNS"}}',
    ]);
  });

  it("default mode: addFixturesFromJSON and on() match 1.44.0", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixturesFromJSON(ENTRIES.slice(2, 4));
    await mock.start();
    expect(await journalFixtures(mock.url)).toEqual([
      LEGACY_CTC,
      '{"match":{"userMessage":"tns"},"response":{"content":"TNS"}}',
    ]);
    await mock.stop();

    mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.on(ENTRIES[2].match, ENTRIES[2].response);
    await mock.start();
    expect((await journalFixtures(mock.url))[0]).toBe(LEGACY_CTC);
  });

  it("extended mode: listing and journal apply and normalize the keys", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    mock.loadFixtureFile(fixtureFile());
    await mock.start();
    expect(await listing(mock.url)).toBe(EXTENDED_LISTING);
    expect(await journalFixtures(mock.url)).toEqual([
      EXTENDED_CTC,
      '{"match":{"userMessage":"tns","toolNamespace":"nsX"},"response":{"content":"TNS"}}',
    ]);
  });

  it("extended mode: on() normalizes as before", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    mock.on(ENTRIES[2].match, ENTRIES[2].response);
    await mock.start();
    expect((await journalFixtures(mock.url))[0]).toBe(EXTENDED_CTC);
  });

  it("extended createServer applies the keys of loadFixtureFile output before any request", async () => {
    server = await createServer(loadFixtureFile(fixtureFile()), {
      port: 0,
      logLevel: "silent",
      responsesTools: "extended",
    });
    expect(await listing(server.url)).toBe(EXTENDED_LISTING);
    expect((await journalFixtures(server.url))[0]).toBe(EXTENDED_CTC);
  });

  it("extended createServer matches on the held toolNamespace before any listing", async () => {
    dir = mkdtempSync(join(tmpdir(), "responses-tools-surfaces-"));
    const file = join(dir, "ns.json");
    writeFileSync(
      file,
      JSON.stringify({
        fixtures: [
          { match: { userMessage: "q", toolNamespace: "nsOther" }, response: { content: "WRONG" } },
          { match: { userMessage: "q", toolNamespace: "nsX" }, response: { content: "RIGHT" } },
        ],
      }),
    );
    server = await createServer(loadFixtureFile(file), {
      port: 0,
      logLevel: "silent",
      responsesTools: "extended",
    });
    const res = await fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "q",
        tools: [{ type: "namespace", name: "nsX", tools: [{ type: "function", name: "t" }] }],
      }),
    });
    expect(await res.text()).toContain("RIGHT");
  });

  it("normalizeResponse leaves customToolCalls and responsesBlocks as written, as 1.44.0 did", () => {
    const raw = ENTRIES[2].response as FixtureFileResponse;
    expect(JSON.stringify(normalizeResponse(raw))).toBe(JSON.stringify(raw));
  });
});

describe("public exports keep their 1.44.0 results for the new keys", () => {
  const withBlocks: Record<string, FixtureResponse> = {
    contentAndBlocks: {
      content: "ok",
      responsesBlocks: [{ type: "text", text: "ok" }],
    } as unknown as FixtureResponse,
    blocksOnly: { responsesBlocks: [{ type: "text", text: "ok" }] } as unknown as FixtureResponse,
    toolCallsAndBlocks: {
      toolCalls: [{ name: "f", arguments: "{}" }],
      responsesBlocks: [{ type: "text", text: "ok" }],
    } as unknown as FixtureResponse,
  };

  it("isContentWithToolCallsResponse ignores responsesBlocks; the internal guard counts it", () => {
    for (const response of Object.values(withBlocks)) {
      expect(isContentWithToolCallsResponse(response)).toBe(false);
      expect(isCombinedFixtureResponse(response)).toBe(true);
    }
    const combined = { content: "ok", toolCalls: [{ name: "f", arguments: "{}" }] };
    expect(isContentWithToolCallsResponse(combined)).toBe(true);
    expect(isContentWithToolCallsResponse({ blocks: [{ type: "text", text: "ok" }] })).toBe(true);
  });

  it("collapse drops Responses namespaces and custom calls; the recorder's variant keeps them", async () => {
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    mock.addFixturesFromJSON([
      {
        match: { userMessage: "combo" },
        response: {
          content: "before",
          customToolCalls: [{ name: "apply_patch", input: "PATCH" }],
          toolCalls: [{ name: "list", arguments: "{}", namespace: "mcp__gh" }],
        },
      } as FixtureFileEntry,
    ]);
    await mock.start();
    const sse = await (
      await fetch(`${mock.url}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: "combo", stream: true }),
      })
    ).text();
    for (const collapsed of [
      collapseOpenAISSE(sse),
      collapseStreamingResponse("text/event-stream", "openai", sse),
    ]) {
      expect(collapsed).not.toHaveProperty("customToolCalls");
      expect(collapsed?.toolCalls).toEqual([
        { name: "list", arguments: "{}", id: expect.any(String) },
      ]);
      expect(Object.keys(collapsed?.toolCalls?.[0] ?? {})).toEqual(["name", "arguments", "id"]);
    }
    for (const collapsed of [
      collapseOpenAISSEWithResponsesTools(sse),
      collapseStreamingResponseWithResponsesTools("text/event-stream", "openai", sse),
    ]) {
      expect(collapsed?.customToolCalls?.[0]).toMatchObject({
        name: "apply_patch",
        input: "PATCH",
      });
      expect(collapsed?.toolCalls?.[0]).toMatchObject({ namespace: "mcp__gh" });
    }
  });
});

/**
 * #518 R3-F2 — the responsesTools mode belongs to each server, never to the
 * fixtures it was given. Two servers that share one fixture array, or one
 * `loadFixtureFile` result, each behave exactly as if they ran alone: the
 * legacy one as 1.44.0, the extended one with the keys applied.
 */
describe("servers that share fixtures keep their own responsesTools mode", () => {
  const shared: ServerInstance[] = [];
  afterEach(async () => {
    for (const s of shared.splice(0)) await new Promise<void>((r) => s.server.close(() => r()));
  });

  async function start(fixtures: Fixture[], mode: "legacy" | "extended"): Promise<ServerInstance> {
    const s = await createServer(fixtures, {
      port: 0,
      logLevel: "silent",
      ...(mode === "extended" && { responsesTools: "extended" }),
    });
    shared.push(s);
    return s;
  }

  /** Wire, listing and journal of one server, against what that mode shows alone. */
  async function expectMode(url: string, mode: "legacy" | "extended"): Promise<void> {
    // A Responses request that offers no namespace: only legacy ignores `toolNamespace`.
    const res = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "tns",
        tools: [{ type: "function", name: "t", parameters: {} }],
      }),
    });
    const text = await res.text();
    if (mode === "legacy") {
      expect(res.status).toBe(200);
      expect(text).toContain("TNS");
    } else {
      expect(res.status).toBe(404);
    }
    expect(await listing(url)).toBe(mode === "legacy" ? LEGACY_LISTING : EXTENDED_LISTING);
    const journal = await journalFixtures(url);
    expect(journal.slice(-2)).toEqual(
      mode === "legacy"
        ? [LEGACY_CTC, '{"match":{"userMessage":"tns"},"response":{"content":"TNS"}}']
        : [
            EXTENDED_CTC,
            '{"match":{"userMessage":"tns","toolNamespace":"nsX"},"response":{"content":"TNS"}}',
          ],
    );
  }

  it.each([
    ["legacy first", ["legacy", "extended"] as const],
    ["extended first", ["extended", "legacy"] as const],
  ])("one fixture array, %s", async (_label, order) => {
    const fixtures = loadFixtureFile(fixtureFile());
    const servers: Record<string, ServerInstance> = {};
    for (const mode of order) servers[mode] = await start(fixtures, mode);
    // The extended server serves first, so a leak would reach the legacy one.
    await expectMode(servers.extended.url, "extended");
    await expectMode(servers.legacy.url, "legacy");
    expect(await listing(servers.extended.url)).toBe(EXTENDED_LISTING);
  });

  it.each([
    ["legacy first", ["legacy", "extended"] as const],
    ["extended first", ["extended", "legacy"] as const],
  ])("one loadFixtureFile result in two arrays, %s", async (_label, order) => {
    const fixtures = loadFixtureFile(fixtureFile());
    const before = JSON.stringify(fixtures);
    const servers: Record<string, ServerInstance> = {};
    for (const mode of order) servers[mode] = await start([...fixtures], mode);
    await expectMode(servers.extended.url, "extended");
    await expectMode(servers.legacy.url, "legacy");
    // The caller's fixture objects are as loadFixtureFile returned them.
    expect(JSON.stringify(fixtures)).toBe(before);
  });

  it("an extended LLMock leaves caller fixtures it was given as they were loaded", async () => {
    const fixtures = loadFixtureFile(fixtureFile());
    const before = JSON.stringify(fixtures);
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    mock.addFixtures(fixtures);
    await mock.start();
    const legacy = await start(fixtures, "legacy");
    await expectMode(mock.url, "extended");
    await expectMode(legacy.url, "legacy");
    expect(JSON.stringify(fixtures)).toBe(before);
  });
});

/**
 * #518 R4 — an extended server reads a caller fixture with held keys through
 * its extended view, but every identity API names the caller's object:
 * getFixtureMatchCount, findByFixture, the count-map keys and
 * JournalEntry.response.fixture. The journal JSON still shows the extended
 * form. Expected values are what 608a4842 (which marked fixtures in place)
 * returned for the same calls.
 */
describe("an extended server keeps the caller's fixture objects", () => {
  /** k1 x2, ctc, tns (no namespace offered: 404), tn2 (namespace offered). */
  async function drive(url: string): Promise<number[]> {
    const statuses: number[] = [];
    const send = async (input: string, tools?: object[]) => {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input, ...(tools && { tools }) }),
      });
      await res.text();
      statuses.push(res.status);
    };
    await send("k1");
    await send("k1");
    await send("ctc");
    await send("tns", [{ type: "function", name: "t", parameters: {} }]);
    await send("tn2", [
      { type: "namespace", name: "nsX", tools: [{ type: "function", name: "t" }] },
    ]);
    return statuses;
  }

  function expectIdentity(
    journal: ServerInstance["journal"],
    caller: readonly Fixture[],
    statuses: number[],
  ) {
    expect(statuses).toEqual([200, 200, 200, 404, 200]);
    expect(caller.map((f) => journal.getFixtureMatchCount(f))).toEqual([2, 0, 1, 0, 1]);
    expect(caller.map((f) => journal.findByFixture(f).length)).toEqual([2, 0, 1, 0, 1]);
    const keys = [...journal.fixtureMatchCounts.keys()];
    expect(keys.map((k) => caller.indexOf(k))).toEqual([0, 2, 4]);
    expect([...journal.getFixtureMatchCountsForTest("__default__").keys()]).toEqual(keys);
    const refs = journal
      .getAll()
      .map((e) => (e.response.fixture ? caller.indexOf(e.response.fixture) : null));
    expect(refs).toEqual([0, 0, 2, null, 4]);
  }

  it("createServer(loadFixtureFile output)", async () => {
    const caller = loadFixtureFile(fixtureFile());
    const before = JSON.stringify(caller);
    server = await createServer(caller, {
      port: 0,
      logLevel: "silent",
      responsesTools: "extended",
    });
    expectIdentity(server.journal, caller, await drive(server.url));
    const journal = (await (await fetch(`${server.url}/__aimock/journal`)).json()) as {
      response: { fixture: unknown };
    }[];
    expect(JSON.stringify(journal[2].response.fixture)).toBe(EXTENDED_CTC);
    expect(await listing(server.url)).toBe(EXTENDED_LISTING);
    expect(JSON.stringify(caller)).toBe(before);
  });

  it("LLMock.addFixtures(loadFixtureFile output)", async () => {
    const caller = loadFixtureFile(fixtureFile());
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    mock.addFixtures(caller);
    await mock.start();
    mock.getFixtures().forEach((f, i) => expect(f).toBe(caller[i]));
    expectIdentity(mock.journal, caller, await drive(mock.url));
    const journal = (await (await fetch(`${mock.url}/__aimock/journal`)).json()) as {
      response: { fixture: unknown };
    }[];
    expect(JSON.stringify(journal[2].response.fixture)).toBe(EXTENDED_CTC);
  });
});

/**
 * #518 R4-F2 — fixtures POSTed to an extended server's control API join the
 * caller's array as 1.44.0 made them; that server reads them through its view.
 * A legacy server sharing the array lists and journals them as 1.44.0 did.
 */
describe("control-API fixtures on a shared array keep each server's mode", () => {
  const started: ServerInstance[] = [];
  afterEach(async () => {
    for (const s of started.splice(0)) await new Promise<void>((r) => s.server.close(() => r()));
  });

  it.each([
    ["legacy first", ["legacy", "extended"] as const],
    ["extended first", ["extended", "legacy"] as const],
  ])("POST to the extended server, %s", async (_label, order) => {
    const shared: Fixture[] = [];
    const servers: Record<string, ServerInstance> = {};
    for (const mode of order) {
      const s = await createServer(shared, {
        port: 0,
        logLevel: "silent",
        ...(mode === "extended" && { responsesTools: "extended" }),
      });
      started.push(s);
      servers[mode] = s;
    }
    const posted = await fetch(`${servers.extended.url}/__aimock/fixtures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures: ENTRIES }),
    });
    expect(await posted.json()).toEqual({ added: ENTRIES.length });
    // The caller's array holds the fixtures as 1.44.0 made them.
    expect(JSON.stringify(shared.map((f) => f.match))).toBe(
      '[{"userMessage":"k1"},{"userMessage":"k4"},{"userMessage":"ctc"},' +
        '{"userMessage":"tns"},{"userMessage":"tn2","toolName":"t"}]',
    );
    expect(await listing(servers.legacy.url)).toBe(LEGACY_LISTING);
    expect(await journalFixtures(servers.legacy.url)).toEqual([
      LEGACY_CTC,
      '{"match":{"userMessage":"tns"},"response":{"content":"TNS"}}',
    ]);
    expect(await listing(servers.extended.url)).toBe(EXTENDED_LISTING);
    const extendedJournal = await journalFixtures(servers.extended.url);
    expect(extendedJournal[0]).toBe(EXTENDED_CTC);
    // The namespaced Responses request matches only on the extended server.
    expect(extendedJournal[1]).toBe(
      '{"match":{"userMessage":"tns","toolNamespace":"nsX"},"response":{"content":"TNS"}}',
    );
  });

  it("an extended LLMock's own array holds POSTed fixtures in the extended form", async () => {
    // No other server reads an LLMock's array, so its fixtures are marked in place, as before.
    mock = new LLMock({ port: 0, logLevel: "silent", responsesTools: "extended" });
    await mock.start();
    await fetch(`${mock.url}/__aimock/fixtures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures: ENTRIES }),
    });
    expect(JSON.stringify(mock.getFixtures()[2])).toBe(EXTENDED_CTC);
    expect(mock.getFixtures()[3].match).toEqual({ userMessage: "tns", toolNamespace: "nsX" });
  });

  it("an extended server still validates the keys it reads", async () => {
    const shared: Fixture[] = [];
    server = await createServer(shared, {
      port: 0,
      logLevel: "silent",
      responsesTools: "extended",
    });
    const res = await fetch(`${server.url}/__aimock/fixtures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fixtures: [{ match: { userMessage: "bad" }, response: { customToolCalls: [{ name: 3 }] } }],
      }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("customToolCalls[0].name");
    expect(shared).toHaveLength(0);
  });
});
