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
