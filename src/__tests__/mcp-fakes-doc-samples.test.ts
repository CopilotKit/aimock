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
 * Samples marked `data-sample="inline:<name>"` (MCP recording, recorded fakes,
 * the fakes report, `fakesFor`) have no file copy: their text is extracted
 * from the docs page itself and run against the real code (the built CLIs in
 * `dist/`, a real upstream MCP server, a child Vitest run). A guard checks
 * that every `data-sample` on the docs pages has a file or an inline case.
 *
 * Fixture files are loaded by a path relative to the fixtures directory (the
 * suite `chdir`s there, which the `forks` pool allows), so entry ids read
 * `weather/seattle.json:get_weather#0` as in the docs, not an absolute path.
 */
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LLMock } from "../llmock.js";
import { REPO_ROOT, expectMcpError, startCli } from "./mcp-fakes-harness.js";
import { startUpstream, type UpstreamHandle } from "./mcp-upstream-harness.js";

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

// ---------------------------------------------------------------------------
// Inline samples: the text lives only on the docs page.
// ---------------------------------------------------------------------------

const DOCS_DIR = resolve(REPO_ROOT, "docs");

/** Every inline sample name, with the docs page that holds it. */
const INLINE_SAMPLES = {
  "recorded-fakes": "mcp-mock",
  "fakes-report-curl": "control-api",
  "fakes-report-response": "control-api",
  "mcp-record-cli": "record-replay",
  "mcp-record-docker": "record-replay",
  "mcp-record-layout": "record-replay",
  "mcp-record-config": "aimock-cli",
  "fakes-for-test": "test-plugins",
  "fakes-for-fixture": "test-plugins",
} as const;
type InlineSample = keyof typeof INLINE_SAMPLES;

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Strip the highlighting spans and decode the entities of one `<code>` body. */
function codeText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) {
        return String.fromCodePoint(parseInt(name.slice(2), 16));
      }
      if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
      const ch = ENTITIES[name];
      if (ch === undefined) throw new Error(`unknown entity ${whole} in a docs sample`);
      return ch;
    });
}

/** The text of the code block marked `data-sample="inline:<name>"` on its docs page. */
function docSample(name: InlineSample): string {
  const html = readFileSync(join(DOCS_DIR, INLINE_SAMPLES[name], "index.html"), "utf8");
  const marker = `data-sample="inline:${name}"`;
  const at = html.indexOf(marker);
  expect(at, `${marker} on docs/${INLINE_SAMPLES[name]}`).toBeGreaterThan(-1);
  expect(html.indexOf(marker, at + 1), `${marker} appears once`).toBe(-1);
  const m = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html.slice(at));
  if (!m) throw new Error(`no <pre><code> after ${marker}`);
  return codeText(m[1]);
}

/** A shell sample as argv: `$ ` prompts and `\` line continuations removed. */
function shellArgs(text: string): string[] {
  return text.replace(/^\$ /gm, "").replace(/\\\n/g, " ").trim().split(/\s+/);
}

/** The `.html` docs pages, recursively. */
function docsPages(dir = DOCS_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...docsPages(path));
    else if (name.endsWith(".html")) out.push(path);
  }
  return out;
}

describe("docs samples: every data-sample has a proof", () => {
  it("names a file under fixtures/mcp-fakes or an inline case of this suite", () => {
    const names = new Set<string>();
    for (const page of docsPages()) {
      for (const m of readFileSync(page, "utf8").matchAll(/data-sample="([^"]+)"/g)) {
        names.add(m[1]);
      }
    }
    expect(names.size).toBeGreaterThan(Object.keys(INLINE_SAMPLES).length);
    for (const name of names) {
      if (name.startsWith("inline:")) {
        expect(Object.keys(INLINE_SAMPLES), name).toContain(name.slice("inline:".length));
      } else {
        expect(existsSync(resolve(FIXTURE_DIR, name)), name).toBe(true);
      }
    }
  });
});

describe("docs sample: recorded fakes (docs/mcp-mock#recorded-fakes)", () => {
  const ID = "research › long task";

  it("replays the recorded list, result, progress notifications and timing", async () => {
    const text = docSample("recorded-fakes");
    const file = join(tmpDir, "research--long-task", "mcp.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    const sample = JSON.parse(text) as {
      mcpFakes: { list: Array<{ name: string; description: string }> };
    };

    const url = await startWith(file);
    const { client } = await connect(`${url}/mcp`, testIdHeader(ID));

    const { tools } = await client.listTools();
    expect(tools.map((t) => [t.name, t.description])).toEqual(
      sample.mcpFakes.list.map((t) => [t.name, t.description]),
    );

    const echo = await client.callTool({ name: "echo", arguments: { message: "hi" } });
    expect(echo.content).toEqual([{ type: "text", text: "Echo: hi" }]);

    const progress: number[] = [];
    const started = Date.now();
    const long = await client.callTool(
      { name: "trigger-long-running-operation", arguments: { duration: 2, steps: 2 } },
      undefined,
      { onprogress: (p) => progress.push(p.progress) },
    );
    const elapsed = Date.now() - started;
    expect(long.content).toEqual([{ type: "text", text: "Long running operation completed." }]);
    expect(progress).toEqual([1, 2]);
    expect(elapsed).toBeGreaterThanOrEqual(0.8 * 2009);

    await expectMcpError(client.callTool({ name: "echo", arguments: { message: "bye" } }), {
      code: -32602,
      aimockCode: "MCP_FAKE_MISMATCH",
    });
  }, 30_000);
});

describe("docs sample: the fakes report route (docs/control-api#mcp-fakes-report)", () => {
  it("the curl sample answers the documented report after one call", async () => {
    const url = await startWith("tickets/retry.json");
    const { client } = await connect(`${url}/mcp`, testIdHeader("tickets › retry on timeout"));
    await client.callTool({ name: "create_ticket", arguments: { title: "Refund" } });

    const script = docSample("fakes-report-curl").replaceAll("http://localhost:4010", url);
    expect(script).toContain(url);
    const { stdout } = await run("sh", ["-c", script]);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(docSample("fakes-report-response")));
  });
});

describe("docs samples: MCP recording (docs/record-replay, docs/aimock-cli)", () => {
  let upstream: UpstreamHandle;
  const ID = "search › refund policy";

  beforeAll(async () => {
    upstream = await startUpstream();
  }, 60_000);

  afterAll(async () => {
    await upstream?.stop();
  });

  /** Swap the documented upstream (`http://<host>:<port>/mcp`) for the real one. */
  function withUpstream(arg: string): string {
    return arg.replace(/https?:\/\/[^/\s"]+\/mcp/, upstream.url);
  }

  /** One echo call through a real SDK client, with the test id header. */
  async function echo(url: string, id: string, message: string): Promise<unknown> {
    const { client } = await connect(url, testIdHeader(id));
    try {
      return await client.callTool({ name: "echo", arguments: { message } });
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** The recording path the layout sample shows, under `fixtures`. */
  function layoutFile(fixtures: string): string {
    const lines = docSample("mcp-record-layout").split("\n");
    expect(lines.map((l) => l.trim())).toEqual([
      "fixtures/recorded/",
      "search--refund-policy/",
      "mcp.json",
    ]);
    return join(fixtures, "recorded", "search--refund-policy", "mcp.json");
  }

  for (const [name, after] of [
    ["mcp-record-cli", "llmock"],
    ["mcp-record-docker", "ghcr.io/copilotkit/aimock"],
  ] as const) {
    it(`${name}: records the upstream at the documented path, which replays offline`, async () => {
      const argv = shellArgs(docSample(name));
      expect(argv).toContain(after);
      if (name === "mcp-record-docker") {
        // The image's entry point is the llmock bin, so the arguments after
        // the image name are llmock arguments.
        expect(readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8")).toContain(
          'ENTRYPOINT ["node", "dist/cli.js"]',
        );
      }
      const fixtures = join(tmpDir, "fixtures");
      mkdirSync(fixtures);
      const args = argv
        .slice(argv.indexOf(after) + 1)
        .map((a) => (a === "./fixtures" || a === "/fixtures" ? fixtures : a))
        .map((a) => (a === "0.0.0.0" ? "127.0.0.1" : a))
        .map(withUpstream);
      expect(args).toContain(`/mcp=${upstream.url}`);

      const rec = await startCli(args);
      let live: unknown;
      try {
        live = await echo(`${rec.url}/mcp`, ID, "refund policy");
      } finally {
        await rec.stop();
      }
      expect(live).toEqual({ content: [{ type: "text", text: "Echo: refund policy" }] });

      const file = layoutFile(fixtures);
      const recorded = JSON.parse(readFileSync(file, "utf8")) as {
        mcpFakes: { scope: unknown; mount: string; tools: Array<{ name: string }> };
      };
      expect(recorded.mcpFakes.scope).toEqual({ testId: ID });
      expect(recorded.mcpFakes.mount).toBe("/mcp");
      expect(recorded.mcpFakes.tools.map((t) => t.name)).toEqual(["echo"]);

      // Replay: the same --fixtures, no --mcp-record, so nothing is forwarded.
      const replay = await startCli(["-f", fixtures]);
      try {
        expect(await echo(`${replay.url}/mcp`, ID, "refund policy")).toEqual(live);
        const { client } = await connect(`${replay.url}/mcp`, testIdHeader(ID));
        await expectMcpError(client.callTool({ name: "echo", arguments: { message: "other" } }), {
          code: -32602,
          aimockCode: "MCP_FAKE_MISMATCH",
        });
      } finally {
        await replay.stop();
      }
    }, 60_000);
  }

  it("mcp-record-config: aimock --config records /mcp and only forwards /search", async () => {
    const fixtures = join(tmpDir, "fixtures");
    mkdirSync(fixtures);
    const config = docSample("mcp-record-config");
    const configText = config
      .replace('"./fixtures"', JSON.stringify(fixtures))
      .replace(/"https?:\/\/[^"]+\/mcp"/g, JSON.stringify(upstream.url));
    const parsed = JSON.parse(configText) as {
      llm: { record: { mcp: Record<string, unknown> } };
    };
    expect(Object.keys(parsed.llm.record.mcp)).toEqual(["/mcp", "/search"]);
    const configFile = join(tmpDir, "aimock.json");
    writeFileSync(configFile, configText);

    const cli = await startCli(["--config", configFile], "dist/aimock-cli.js");
    try {
      expect(await echo(`${cli.url}/mcp`, ID, "refund policy")).toEqual({
        content: [{ type: "text", text: "Echo: refund policy" }],
      });
      expect(await echo(`${cli.url}/search`, "search › proxy only", "hello")).toEqual({
        content: [{ type: "text", text: "Echo: hello" }],
      });
    } finally {
      await cli.stop();
    }
    expect(existsSync(join(fixtures, "recorded", "search--refund-policy", "mcp.json"))).toBe(true);
    expect(readdirSync(join(fixtures, "recorded"))).toEqual(["search--refund-policy"]);
  }, 60_000);
});

describe("docs sample: fakesFor and fakesReport in Vitest (docs/test-plugins#fakes-for)", () => {
  /**
   * Run the sample as its own Vitest project: test/weather.spec.ts and
   * fixtures/weather.json under a directory inside the repo (so the sample's
   * imports resolve from the repo's node_modules). Only the plugin import is
   * pointed at the source, as `pnpm test` does not build dist/.
   */
  async function runSample(fixture: string): Promise<{ code: number | null; output: string }> {
    const dir = mkdtempSync(join(REPO_ROOT, "src/__tests__/fixtures/docs-sample-"));
    try {
      const spec = docSample("fakes-for-test");
      const specifier = '"@copilotkit/aimock/vitest"';
      expect(spec).toContain(`from ${specifier};`);
      mkdirSync(join(dir, "test"));
      mkdirSync(join(dir, "fixtures"));
      writeFileSync(
        join(dir, "test/weather.spec.ts"),
        spec.replace(specifier, JSON.stringify(resolve(REPO_ROOT, "src/vitest.ts"))),
      );
      writeFileSync(join(dir, "fixtures/weather.json"), fixture);
      writeFileSync(
        join(dir, "vitest.config.mjs"),
        `export default { test: { root: ${JSON.stringify(dir)}, include: ["test/**/*.spec.ts"], pool: "forks" } };\n`,
      );
      const vitestBin = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");
      return await new Promise((res, rej) => {
        const cp = spawn(
          process.execPath,
          [vitestBin, "run", "--config", join(dir, "vitest.config.mjs")],
          {
            cwd: dir,
            env: { ...process.env, CI: "1", NO_COLOR: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        cp.stdout.setEncoding("utf8").on("data", (d: string) => (output += d));
        cp.stderr.setEncoding("utf8").on("data", (d: string) => (output += d));
        cp.on("error", rej);
        cp.on("close", (code) => res({ code, output }));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("passes with the documented default test id", async () => {
    const { code, output } = await runSample(docSample("fakes-for-fixture"));
    expect(code, output).toBe(0);
    expect(output).toMatch(/Tests\s+1 passed \(1\)/);
  }, 60_000);

  it('fakesReport: "fail" fails the same test when a declared entry is never called', async () => {
    const fixture = JSON.parse(docSample("fakes-for-fixture")) as {
      mcpFakes: { tools: Array<{ calls: unknown[] }> };
    };
    fixture.mcpFakes.tools[0].calls.push({
      id: "never-called",
      args: { city: "Paris" },
      result: "sun",
    });
    const { code, output } = await runSample(JSON.stringify(fixture));
    expect(code, output).toBe(1);
    expect(output).toContain(
      'aimock MCP fakes report failed (testId "test/weather.spec.ts › weather › seattle")',
    );
    expect(output).toContain("unconsumed: weather.json:never-called (/mcp get_weather)");
  }, 60_000);
});
