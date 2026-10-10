import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { loadConfig, startFromConfig } from "../config-loader.js";
import type { ServerInstance } from "../server.js";
import { DEFAULT_TEST_ID } from "../constants.js";
import * as serverModule from "../server.js";
import type { MisbehaviorConfig, MisbehaviorFaultId } from "../types.js";
import * as llmockModule from "../llmock.js";
import { getFixtureMisbehaviorPosition } from "../misbehavior.js";
import { LLMock, createServer } from "./helpers/misbehavior-enabled.js";

describe("fixture additions over localhost HTTP", () => {
  let mock: llmockModule.LLMock;
  const valid = {
    match: { userMessage: "added" },
    response: { content: "added answer" },
    misbehavior: "empty-response",
  };

  beforeEach(async () => {
    mock = new LLMock();
    mock.onMessage("existing", { content: "existing answer" });
    await mock.start();
  });
  afterEach(async () => mock.stop());

  async function post(fixtures: unknown[]) {
    const response = await fetch(`${mock.url}/__aimock/fixtures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixtures }),
    });
    const result = { status: response.status, body: await response.json() };
    console.log("C2c localhost fixture POST", JSON.stringify(result));
    return result;
  }

  it("rejects a mixed batch with every loader error and appends nothing", async () => {
    const result = await post([
      valid,
      { ...valid, misbehavior: { faults: [], typo: true } },
      { ...valid, misbehavior: { faults: [{ fault: "empty-response", rate: 2 }] } },
    ]);
    const listing = await fetch(`${mock.url}/__aimock/fixtures`);
    const count = await listing.json();
    console.log("C2c count after invalid batch", JSON.stringify(count));
    expect(count).toEqual({ count: 1 });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("Validation failed");
    expect(result.body.details).toHaveLength(2);
    expect(result.body.details).toEqual([
      expect.objectContaining({
        name: "MisbehaviorConfigError",
        rule: "misbehavior/unknown-key",
        file: "control-api#0",
        message: expect.stringContaining("fixtures[1].misbehavior.typo"),
      }),
      expect.objectContaining({
        name: "MisbehaviorConfigError",
        rule: "misbehavior/bad-value",
        file: "control-api#0",
        message: expect.stringContaining("fixtures[2].misbehavior.faults[0].rate"),
      }),
    ]);
    expect(mock.getFixtures()[0].response).toEqual({ content: "existing answer" });
    expect(await post([valid])).toEqual({ status: 200, body: { added: 1 } });
    expect(mock.getFixtures()).toHaveLength(2);
    expect(mock.getFixtures()[1].misbehavior).toEqual({ faults: [{ fault: "empty-response" }] });
  });

  it("serves an API-added fixture fault through the official SDK and matching journal", async () => {
    expect(await post([valid])).toEqual({ status: 200, body: { added: 1 } });
    const client = new OpenAI({
      apiKey: "local",
      baseURL: `${mock.url}/v1`,
      maxRetries: 0,
      timeout: 5000,
    });
    const request = {
      model: "gpt-4",
      messages: [{ role: "user", content: "added" }],
    } satisfies OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    const { data, response } = await client.chat.completions.create(request).withResponse();
    const entries = mock.getRequests();
    console.log("V1 control fixture SDK and journal", JSON.stringify({ data, entries }));
    expect(response.status).toBe(200);
    expect(data.choices).toHaveLength(1);
    expect(data.choices[0].message.content ?? "").toBe("");
    expect(data.choices[0].message.tool_calls ?? []).toEqual([]);
    expect(data.choices[0].finish_reason).toBe("stop");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions",
      body: request,
      response: {
        status: 200,
        misbehavior: {
          applied: true,
          source: "fixture",
          wire: "openai-chat",
          evaluations: [{ entryIndex: 0, fault: "empty-response", outcome: "applied" }],
        },
      },
    });
    expect(entries[0].response.fixture).toBe(mock.getFixtures()[1]);
  });

  it("assigns distinct control identities across batches and fixture deletion", async () => {
    expect(await post([valid, valid])).toEqual({ status: 200, body: { added: 2 } });
    expect(mock.getFixtures().slice(1).map(getFixtureMisbehaviorPosition)).toEqual([
      "control-api#0#0",
      "control-api#0#1",
    ]);
    const deleted = await fetch(`${mock.url}/__aimock/fixtures`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await post([valid])).toEqual({ status: 200, body: { added: 1 } });
    expect(getFixtureMisbehaviorPosition(mock.getFixtures()[0])).toBe("control-api#1#0");
  });
});

describe("config-file misbehavior defaults", () => {
  let directory: string;
  const servers: llmockModule.LLMock[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "aimock-misbehavior-config-"));
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function configFromFile(misbehavior?: unknown) {
    const fixturePath = join(directory, "fixtures.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hello" }, response: { content: "configured answer" } }],
      }),
    );
    const configPath = join(directory, "aimock.json");
    writeFileSync(
      configPath,
      JSON.stringify({ llm: { fixtures: fixturePath, logLevel: "silent", misbehavior } }),
    );
    return loadConfig(configPath);
  }

  async function start(misbehavior?: unknown) {
    const result = await startFromConfig(configFromFile(misbehavior));
    servers.push(result.llmock);
    return result;
  }

  async function responseContent(url: string) {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    return body.choices[0].message.content;
  }

  it.each([
    "empty-response",
    { seed: 7, faults: [{ fault: "empty-response", times: 1 }] },
    { faults: [] },
  ])("forwards valid config to construction: %j", async (misbehavior) => {
    const construction = vi.spyOn(llmockModule, "createLLMockWithResolvedAuth");
    await start(misbehavior);
    expect(construction.mock.calls[0][0].misbehavior).toEqual(
      typeof misbehavior === "string" ? { faults: [{ fault: misbehavior }] } : misbehavior,
    );
  });

  // 1.44.0 ignored llm.misbehavior, so a value it accepted keeps starting: an
  // invalid value warns and leaves misbehavior disabled (1.44.0 behavior).
  it.each([
    [{ faults: [], typo: true }, "misbehavior/unknown-key"],
    [{ faults: [{ fault: "empty-response", rate: 2 }] }, "misbehavior/bad-value"],
    [null, "misbehavior/bad-value"],
    ["unknown-fault", "misbehavior/bad-value"],
  ])(
    "warns about bad raw config, leaves misbehavior disabled and serves as 1.44.0: %j",
    async (misbehavior, rule) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const construction = vi.spyOn(llmockModule, "createLLMockWithResolvedAuth");
      const { url } = await start(misbehavior);
      expect(construction.mock.calls[0][0].misbehavior).toBeUndefined();
      expect(construction.mock.calls[0][0].enableMisbehavior).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "[aimock]",
        expect.stringMatching(
          new RegExp(`^${rule}: llm\\.misbehavior.*Ignoring llm\\.misbehavior`),
        ),
      );
      expect(await responseContent(url)).toBe("configured answer");
    },
  );

  it("keeps config without misbehavior unchanged over HTTP", async () => {
    const { url } = await start();
    expect(await responseContent(url)).toBe("configured answer");
  });

  // Run before edits and again after runtime integration; retained as the C1 real-surface gate.
  it.runIf(process.env.AIMOCK_C1_HTTP_PROOF === "1")(
    "honors raw config fault defaults over real localhost HTTP",
    async () => {
      const { url } = await start("empty-response");
      expect(await responseContent(url)).toBe("");
    },
  );
});

describe("programmatic misbehavior defaults", () => {
  const servers: llmockModule.LLMock[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  async function start(misbehavior?: MisbehaviorConfig | MisbehaviorFaultId) {
    const mock = new LLMock({ misbehavior });
    mock.onMessage("hello", { content: "original answer" });
    await mock.start();
    servers.push(mock);
    return mock;
  }

  it.runIf(process.env.AIMOCK_C2A_HTTP_PROOF === "1")(
    "honors options over real localhost HTTP",
    async () => {
      const mock = await start("empty-response");
      const response = await fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      console.log("C2a localhost actual content:", JSON.stringify(body.choices[0].message.content));
      expect(body.choices[0].message.content).toBe("");
    },
  );

  it("rejects invalid construction options with a rule-prefixed TypeError", () => {
    const invalid = JSON.parse('{"faults":[],"typo":true}');
    expect(() => new LLMock({ misbehavior: invalid })).toThrow(/^misbehavior\/unknown-key/);
  });

  it("validates setters before and after start without replacing the current baseline", async () => {
    const mock = new LLMock();
    const invalid = JSON.parse('{"faults":[{"fault":"empty-response","rate":2}]}');
    expect(() => mock.setMisbehavior(invalid)).toThrow(/^misbehavior\/bad-value/);
    expect(mock.setMisbehavior("empty-response")).toBe(mock);
    expect(mock.clearMisbehavior()).toBe(mock);
    const creation = vi.spyOn(serverModule, "createServer");
    await mock.start();
    servers.push(mock);
    const running = await creation.mock.results[0].value;
    expect(running.defaults.misbehavior?.baseline).toBeUndefined();
    running.defaults.misbehavior?.byTestId.set("specific", { faults: [] });
    running.defaults.misbehavior?.byTestId.set(DEFAULT_TEST_ID, { faults: [] });
    expect(mock.setMisbehavior("empty-response")).toBe(mock);
    expect(running.defaults.misbehavior?.baseline).toEqual({
      faults: [{ fault: "empty-response" }],
    });
    const scope = running.defaults.misbehavior;
    const effectiveDefault = scope?.byTestId.get(DEFAULT_TEST_ID) ?? scope?.baseline;
    console.log(
      "C2a actual running-server default after setter:",
      JSON.stringify(effectiveDefault),
    );
    expect(effectiveDefault).toEqual({ faults: [{ fault: "empty-response" }] });
    expect(scope?.byTestId.get("specific")).toEqual({ faults: [] });

    expect(() => mock.setMisbehavior(invalid)).toThrow(TypeError);
    expect(running.defaults.misbehavior?.baseline).toEqual({
      faults: [{ fault: "empty-response" }],
    });
    expect(mock.setMisbehavior({ faults: [] })).toBe(mock);

    expect(() => mock.setMisbehavior(invalid)).toThrow(TypeError);
    expect(mock.clearMisbehavior()).toBe(mock);
    expect(running.defaults.misbehavior?.baseline).toBeUndefined();
    expect(running.defaults.misbehavior?.byTestId.size).toBe(0);
    creation.mockRestore();
  });
});

describe("server semantic scope ownership", () => {
  const servers: ServerInstance[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        ({ server }) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    vi.restoreAllMocks();
  });

  it("installs independent scopes and the actual Journal counter owner", async () => {
    const first = await createServer([], { misbehavior: "empty-response" });
    servers.push(first);
    const second = await createServer([]);
    servers.push(second);
    expect(first.defaults.misbehavior?.baseline).toEqual({ faults: [{ fault: "empty-response" }] });
    expect(first.defaults.misbehaviorCounters).toBe(first.journal);
    first.defaults.misbehavior?.byTestId.set("isolated", { faults: [] });
    expect(second.defaults.misbehavior?.byTestId.size).toBe(0);
  });

  it("rejects invalid direct server options", async () => {
    const invalid = JSON.parse('{"faults":[],"seed":0.5}');
    await expect(createServer([], { misbehavior: invalid })).rejects.toThrow(
      /^misbehavior\/bad-value/,
    );
  });

  it("exposes one chosen random seed and logs it once", async () => {
    const log = vi.spyOn(console, "log");
    const first = await createServer([], {
      logLevel: "info",
      misbehavior: { seed: "random", faults: [] },
    });
    servers.push(first);
    const second = await createServer([], {
      logLevel: "info",
      misbehavior: { seed: "random", faults: [] },
    });
    servers.push(second);
    const seed = first.defaults.misbehavior?.baseline?.seed;
    expect(typeof seed).toBe("number");
    expect(second.defaults.misbehavior?.baseline?.seed).toBe(seed);
    expect(
      log.mock.calls.filter((args) =>
        args.some((arg) => String(arg).startsWith("Misbehavior random seed:")),
      ),
    ).toHaveLength(1);
  });
});

describe("misbehavior control routes over localhost HTTP", () => {
  let mock: llmockModule.LLMock;
  const baseline = { seed: 7, faults: [{ fault: "empty-response" }] } as const;
  const replacement = { faults: [{ fault: "content-filter" }] } as const;

  beforeEach(async () => {
    mock = new LLMock({ misbehavior: { ...baseline, faults: [...baseline.faults] } });
    await mock.start();
  });
  afterEach(async () => mock.stop());

  async function control(method: string, body?: unknown, query = "", testId?: string) {
    const response = await fetch(`${mock.url}/__aimock/misbehavior${query}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(testId !== undefined ? { "X-Test-Id": testId } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = { status: response.status, body: await response.json() };
    console.log("C2b HTTP", method, query, testId ?? "untagged", JSON.stringify(result));
    return result;
  }

  it.each(["GET", "POST", "DELETE"])("exposes %s on the real control endpoint", async (method) => {
    const result = await control(method, method === "POST" ? replacement : undefined);
    expect(result).toEqual({
      status: 200,
      body: { misbehavior: method === "POST" ? replacement : baseline },
    });
  });

  it("exposes the catalog and wire support", async () => {
    const result = await control("GET", undefined, "/catalog");
    expect(result.status).toBe(200);
    expect(result.body.catalog).toHaveProperty("empty-response");
    expect(result.body.WIRE_SUPPORT).toHaveProperty("openai-chat");
  });

  it("replaces whole configs, selects header before query, and deletes into current baseline", async () => {
    expect((await control("POST", replacement)).status).toBe(200);
    expect((await control("GET", undefined, "?testId=other")).body).toEqual({
      misbehavior: replacement,
    });
    expect((await control("POST", {}, "?testId=query", "header")).body).toEqual({
      misbehavior: { faults: [] },
    });
    expect((await control("GET", undefined, "?testId=header")).body).toEqual({
      misbehavior: { faults: [] },
    });
    expect((await control("GET", undefined, "?testId=query")).body).toEqual({
      misbehavior: replacement,
    });
    expect((await control("DELETE", undefined, "?testId=header")).body).toEqual({
      misbehavior: replacement,
    });
    await control("POST", {}, "?testId=keep");
    expect((await control("DELETE")).body).toEqual({ misbehavior: baseline });
    expect((await control("GET", undefined, "?testId=keep")).body).toEqual({
      misbehavior: { faults: [] },
    });
  });

  it("retains prior scope after invalid input and rejects blank identity", async () => {
    await control("POST", replacement, "?testId=one");
    for (const [invalid, rule, message] of [
      [null, "misbehavior/bad-value", "misbehavior/bad-value at misbehavior: invalid value null"],
      [[], "misbehavior/bad-value", "misbehavior/bad-value at misbehavior: invalid value []"],
      [
        { faults: [], typo: true },
        "misbehavior/unknown-key",
        "misbehavior/unknown-key at misbehavior.typo: invalid value true",
      ],
      [
        { faults: [{ fault: "empty-response", rate: 2 }] },
        "misbehavior/bad-value",
        "misbehavior/bad-value at misbehavior.faults[0].rate: invalid value 2",
      ],
    ] as const) {
      expect(await control("POST", invalid, "?testId=one")).toEqual({
        status: 400,
        body: { error: "Validation failed", rule, message },
      });
      expect((await control("GET", undefined, "?testId=one")).body).toEqual({
        misbehavior: replacement,
      });
    }
    const malformed = await fetch(`${mock.url}/__aimock/misbehavior?testId=one`, {
      method: "POST",
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect((await control("GET", undefined, "?testId=one")).body).toEqual({
      misbehavior: replacement,
    });
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(
        (await control(method, method === "POST" ? {} : undefined, "?testId=one", " ")).status,
      ).toBe(400);
    }
    expect((await control("GET")).body).toEqual({ misbehavior: baseline });
  });

  it("keeps route state consistent with setters and clears", async () => {
    await control("POST", replacement);
    await control("POST", {}, "?testId=named");
    mock.setMisbehavior("empty-response");
    const changed = { faults: [{ fault: "empty-response" }] };
    expect((await control("GET")).body).toEqual({ misbehavior: changed });
    expect((await control("GET", undefined, "?testId=named")).body).toEqual({
      misbehavior: { faults: [] },
    });
    expect((await control("DELETE")).body).toEqual({ misbehavior: changed });
    mock.clearMisbehavior();
    expect((await control("GET", undefined, "?testId=named")).body).toEqual({
      misbehavior: { faults: [] },
    });
  });

  it("resolves random seed to a replayable number", async () => {
    const result = await control("POST", { seed: "random", faults: [] });
    expect(result.status).toBe(200);
    expect(result.body.misbehavior.seed).toEqual(expect.any(Number));
    expect((await control("GET")).body).toEqual(result.body);
  });
});
