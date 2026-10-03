/**
 * Proof for every MCP-fakes sample on the docs pages (docs/mcp-mock,
 * docs/control-api). Each sample is a verbatim copy of a file under
 * src/__tests__/fixtures/mcp-fakes/; this suite loads that file into a real
 * `LLMock` on a real TCP port and drives it with the real v1 MCP SDK client
 * (`@modelcontextprotocol/sdk`) over Streamable HTTP, asserting the answers
 * the docs describe. Wire-body samples (fixtures/mcp-fakes/wire/,
 * fixtures/mcp-fakes/control-api/*.response.json) are compared with the raw
 * HTTP bodies the server sent.
 *
 * Fixture files are loaded by a path relative to the fixtures directory (the
 * suite `chdir`s there, which the `forks` pool allows), so entry ids read
 * `weather/seattle.json:get_weather#0` as in the docs, not an absolute path.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LLMock } from "../llmock.js";
import { expectMcpError } from "./mcp-fakes-harness.js";

const FIXTURE_DIR = resolve(__dirname, "fixtures/mcp-fakes");
const SRC_INDEX = resolve(__dirname, "../index.ts");
const run = promisify(execFile);

const mocks: LLMock[] = [];
const clients: Client[] = [];
let originalCwd: string;
let tmpDir: string;

beforeAll(() => {
  originalCwd = process.cwd();
  process.chdir(FIXTURE_DIR);
});

afterAll(() => {
  process.chdir(originalCwd);
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "aimock-doc-samples-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const m of mocks.splice(0)) await m.stop().catch(() => {});
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Parse a JSON fixture file under the fixtures directory. */
function fixtureJson(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, rel), "utf8"));
}

/** Assert that a wire body equals the sample file (the docs copy it verbatim). */
function expectSample(actual: unknown, rel: string): void {
  expect(actual).toEqual(fixtureJson(rel));
}

/** Start an LLMock with the given fixture files loaded by relative path. */
async function startWith(...files: string[]): Promise<string> {
  const llm = new LLMock({ port: 0 });
  mocks.push(llm);
  for (const f of files) llm.loadFixtureFile(f);
  return llm.start();
}

/** Every JSON body the server sent back to one client, in order. */
type Bodies = unknown[];

/**
 * Connect a real v1 SDK client whose fetch records every JSON response body,
 * so a sample of a raw JSON-RPC error body can be compared with the wire.
 */
async function connect(
  url: string,
  headers: Record<string, string>,
): Promise<{ client: Client; bodies: Bodies }> {
  const bodies: Bodies = [];
  const recordingFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const res = await fetch(input, init);
    if (res.headers.get("content-type")?.includes("application/json")) {
      bodies.push(JSON.parse(await res.clone().text()));
    }
    return res;
  };
  const client = new Client({ name: "aimock-doc-samples", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    fetch: recordingFetch,
  });
  await client.connect(transport);
  clients.push(client);
  return { client, bodies };
}

function testIdHeader(id: string): Record<string, string> {
  return { "X-Test-Id": encodeURIComponent(id) };
}

/** POST one chat completion and return the parsed body. */
async function chat(url: string, testId: string, messages: unknown[]): Promise<unknown> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Id": encodeURIComponent(testId) },
    body: JSON.stringify({ model: "gpt-4o", messages }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe("docs sample: weather/seattle.json (single answer, object result)", () => {
  const ID = "weather › seattle";

  it("answers get_weather with structuredContent plus its JSON text", async () => {
    const url = await startWith("weather/seattle.json");
    const { client } = await connect(`${url}/mcp`, testIdHeader(ID));
    const result = await client.callTool({ name: "get_weather", arguments: { city: "Seattle" } });
    expect(result).toEqual({
      content: [{ type: "text", text: '{"tempF":60,"conditions":"rain"}' }],
      structuredContent: { tempF: 60, conditions: "rain" },
      isError: false,
    });
  });

  it("the LLM fixtures ask for the tool, then answer with its result", async () => {
    const url = await startWith("weather/seattle.json");
    const first = (await chat(url, ID, [{ role: "user", content: "weather in Seattle" }])) as {
      choices: Array<{ message: { tool_calls?: Array<{ function: { name: string } }> } }>;
    };
    expect(first.choices[0].message.tool_calls?.[0].function.name).toBe("get_weather");
    const second = (await chat(url, ID, [
      { role: "user", content: "weather in Seattle" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Seattle"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"tempF":60,"conditions":"rain"}' },
    ])) as { choices: Array<{ message: { content: string } }> };
    expect(second.choices[0].message.content).toBe("It is 60F and raining in Seattle.");
  });

  it("wire/mismatch.json is the exact body of a call with other arguments", async () => {
    const url = await startWith("weather/seattle.json");
    const { client, bodies } = await connect(`${url}/mcp`, testIdHeader(ID));
    await expectMcpError(client.callTool({ name: "get_weather", arguments: { city: "seattle" } }), {
      code: -32602,
      aimockCode: "MCP_FAKE_MISMATCH",
    });
    expectSample(bodies.at(-1), "wire/mismatch.json");
  });
});

describe("docs sample: tickets/retry.json (sequence)", () => {
  it("wire/exhausted.json is the exact body of the third call", async () => {
    const url = await startWith("tickets/retry.json");
    const { client, bodies } = await connect(
      `${url}/mcp`,
      testIdHeader("tickets › retry on timeout"),
    );
    const args = { title: "Refund" };
    const first = await client.callTool({ name: "create_ticket", arguments: args });
    expect(first).toEqual({ content: [{ type: "text", text: "upstream timeout" }], isError: true });
    const second = await client.callTool({ name: "create_ticket", arguments: args });
    expect(second).toEqual({ content: [{ type: "text", text: "TICKET-42" }], isError: false });
    await expectMcpError(client.callTool({ name: "create_ticket", arguments: args }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });
    expectSample(bodies.at(-1), "wire/exhausted.json");
  });
});

describe("docs sample: docs/search.json (any arguments, context scope)", () => {
  it("answers search_docs in order whatever the arguments, for the context only", async () => {
    const url = await startWith("docs/search.json");
    const { client } = await connect(`${url}/mcp`, { "X-AIMock-Context": "docs-search" });
    const a = await client.callTool({ name: "search_docs", arguments: { q: "refund time" } });
    expect(a).toEqual({
      content: [{ type: "text", text: "Doc A: refunds take 5 days" }],
      isError: false,
    });
    const b = await client.callTool({ name: "search_docs", arguments: { query: "help" } });
    expect(b).toEqual({
      content: [{ type: "text", text: "Doc B: contact support" }],
      isError: false,
    });
    await expectMcpError(client.callTool({ name: "search_docs", arguments: {} }), {
      code: -31010,
      aimockCode: "MCP_FAKE_EXHAUSTED",
    });

    // Without the context the block does not apply: search_docs is unknown.
    const { client: other } = await connect(`${url}/mcp`, {});
    const unknown = await other
      .callTool({ name: "search_docs", arguments: {} })
      .then(() => "resolved")
      .catch((e: unknown) => String(e));
    expect(unknown).toContain("Unknown tool: search_docs");
  });
});

describe("docs sample: account/read-only.json (closed world)", () => {
  const ID = "account › read only";

  it("answers the declared tool and denies any other", async () => {
    const url = await startWith("account/read-only.json");
    const { client, bodies } = await connect(`${url}/mcp`, testIdHeader(ID));
    const ok = await client.callTool({ name: "get_account", arguments: { id: "u1" } });
    expect(ok).toEqual({ content: [{ type: "text", text: '{"plan":"pro"}' }], isError: false });
    await expectMcpError(client.callTool({ name: "delete_account", arguments: { id: "u1" } }), {
      code: -32602,
      aimockCode: "MCP_FAKE_NOT_DECLARED",
    });
    expectSample(bodies.at(-1), "wire/not-declared.json");
  });
});

describe("docs sample: multi/travel.json (array form, one block per mount)", () => {
  it("serves each block on its own auto-mounted path", async () => {
    const url = await startWith("multi/travel.json");
    const headers = testIdHeader("travel › book trip");
    const { client: flights } = await connect(`${url}/mcp/flights`, headers);
    const f = await flights.callTool({ name: "search_flights", arguments: { to: "CDG" } });
    expect(f).toEqual({
      content: [{ type: "text", text: "UA 100 departs 09:00" }],
      isError: false,
    });
    const { client: hotels } = await connect(`${url}/mcp/hotels`, headers);
    const h = await hotels.callTool({ name: "book_hotel", arguments: { city: "Paris" } });
    expect(h).toEqual({ content: [{ type: "text", text: "HOTEL-7" }], isError: false });

    // Each mount serves only its own block.
    const crossed = await flights
      .callTool({ name: "book_hotel", arguments: { city: "Paris" } })
      .then(() => "resolved")
      .catch((e: unknown) => String(e));
    expect(crossed).toContain("Unknown tool: book_hotel");
  });
});

describe("docs sample: programmatic/load-fakes.mjs", () => {
  it("serves the file's fakes on /mcp and the code fakes on /billing", async () => {
    // The sample imports the published package name. `pnpm test` does not
    // build `dist/`, so run a copy whose one import points at the source.
    const text = readFileSync(resolve(FIXTURE_DIR, "programmatic/load-fakes.mjs"), "utf8");
    const specifier = '"@copilotkit/aimock"';
    expect(text).toContain(`from ${specifier};`);
    const copy = join(tmpDir, "load-fakes.mjs");
    writeFileSync(copy, text.replace(specifier, JSON.stringify(SRC_INDEX)));
    const sample = (await import(copy)) as { startMock(): Promise<LLMock> };
    const llm = await sample.startMock();
    mocks.push(llm);
    const { client: weather } = await connect(`${llm.url}/mcp`, testIdHeader("weather › seattle"));
    const w = await weather.callTool({ name: "get_weather", arguments: { city: "Seattle" } });
    expect(w.structuredContent).toEqual({ tempF: 60, conditions: "rain" });
    const { client: billing } = await connect(
      `${llm.url}/billing`,
      testIdHeader("billing › refund"),
    );
    const r = await billing.callTool({ name: "refund", arguments: { amount: 10 } });
    expect(r).toEqual({ content: [{ type: "text", text: "refunded 10" }], isError: false });
  });
});

describe("docs sample: control-api/*.sh with curl", () => {
  /** Run a curl sample against the real server: only the documented host is swapped. */
  async function curl(script: string, url: string): Promise<unknown> {
    const text = readFileSync(resolve(FIXTURE_DIR, script), "utf8").replaceAll(
      "http://localhost:4010",
      url,
    );
    expect(text).toContain(url);
    const { stdout } = await run("sh", ["-c", text], { cwd: FIXTURE_DIR });
    return JSON.parse(stdout);
  }

  it("POST adds the block; GET lists it with each entry's state", async () => {
    const url = await startWith();
    expectSample(
      await curl("control-api/post-fakes.sh", url),
      "control-api/post-fakes.response.json",
    );
    const { client } = await connect(`${url}/mcp`, testIdHeader("account › read only"));
    const ok = await client.callTool({ name: "get_account", arguments: { id: "u1" } });
    expect(ok).toEqual({ content: [{ type: "text", text: '{"plan":"pro"}' }], isError: false });
    expectSample(
      await curl("control-api/get-fakes.sh", url),
      "control-api/get-fakes.response.json",
    );
  });
});
