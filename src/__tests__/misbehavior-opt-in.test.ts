import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { loadConfig, startFromConfig } from "../config-loader.js";
import { loadFixtureFile, validateFixtures } from "../fixture-loader.js";

// Misbehavior is opt-in (enableMisbehavior: true, CLI --misbehavior, config
// llm.misbehavior). Without it, every #508 input is ignored as in 1.44.0: a
// fixture `misbehavior` key is unused data, the `misbehavior` server option is
// not read, and the X-AIMock-Misbehavior header has no effect.

const directories: string[] = [];
const mocks: LLMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((mock) => mock.stop()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// Raw file entries: some values are not valid misbehavior, as a file may hold.
const entries: Record<string, object> = {
  bogus: { match: { userMessage: "go" }, response: { content: "hi" }, misbehavior: "bogus-fault" },
  unknownKey: {
    match: { userMessage: "go" },
    response: { content: "hi" },
    misbehavior: { note: "my own metadata" },
  },
  notApplicable: {
    match: { userMessage: "go" },
    response: { content: "hi" },
    misbehavior: "tool-args-invalid-json",
  },
  valid: {
    match: { userMessage: "go" },
    response: { content: "hi" },
    misbehavior: "empty-response",
  },
};

function fixtureFile(entry: object): string {
  const directory = mkdtempSync(join(tmpdir(), "aimock-opt-in-"));
  directories.push(directory);
  const file = join(directory, "fixtures.json");
  writeFileSync(file, JSON.stringify({ fixtures: [entry] }));
  return file;
}

async function chat(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "go" }] }),
  });
  return { status: response.status, body: await response.json() };
}

async function started(mock: LLMock): Promise<string> {
  mocks.push(mock);
  return mock.start();
}

describe("misbehavior not enabled (1.44.0 behavior)", () => {
  it.each(Object.entries(entries))(
    "loads and serves a fixture file with a %s misbehavior key unchanged",
    async (_name, entry) => {
      const file = fixtureFile(entry);
      const loaded = loadFixtureFile(file);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].misbehavior).toBeUndefined();
      expect(validateFixtures(loaded)).toEqual([]);
      const mock = new LLMock({ port: 0, logLevel: "silent" });
      mock.loadFixtureFile(file);
      const result = await chat(await started(mock));
      expect(result.status).toBe(200);
      expect(result.body.choices[0].message.content).toBe("hi");
    },
  );

  it("accepts any misbehavior value through addFixturesFromJSON", async () => {
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    mock.addFixturesFromJSON(JSON.stringify([entries.bogus, entries.unknownKey]));
    const result = await chat(await started(mock));
    expect(result.status).toBe(200);
    expect(result.body.choices[0].message.content).toBe("hi");
  });

  it("ignores the misbehavior server option, valid or not", async () => {
    const options = JSON.parse('{"misbehavior":"bogus"}');
    expect(() => new LLMock(options)).not.toThrow();
    const mock = new LLMock({ port: 0, logLevel: "silent", misbehavior: "empty-response" });
    mock.onMessage("go", { content: "hi" });
    const result = await chat(await started(mock));
    expect(result.body.choices[0].message.content).toBe("hi");
  });

  it.each(["garbage", "", "empty-response", "refusal;message=no"])(
    "ignores the X-AIMock-Misbehavior header %j",
    async (value) => {
      const mock = new LLMock({ port: 0, logLevel: "silent" });
      mock.onMessage("go", { content: "hi" });
      const result = await chat(await started(mock), { "X-AIMock-Misbehavior": value });
      expect(result.status).toBe(200);
      expect(result.body.choices[0].message.content).toBe("hi");
    },
  );

  it("refuses setMisbehavior and runtime-scope writes", async () => {
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    expect(() => mock.setMisbehavior("empty-response")).toThrow(/enableMisbehavior: true/);
    const url = await started(mock);
    const response = await fetch(`${url}/__aimock/misbehavior`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-id": "t1" },
      body: JSON.stringify({ faults: [{ fault: "empty-response" }] }),
    });
    expect(response.status).toBe(409);
  });

  it("aimock validate does not read misbehavior keys without --misbehavior", () => {
    const file = fixtureFile(entries.bogus);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        resolve("src/aimock-cli.ts"),
        "validate",
        file,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe("misbehavior enabled", () => {
  it("enableMisbehavior: true applies a fixture fault", async () => {
    const mock = new LLMock({ port: 0, logLevel: "silent", enableMisbehavior: true });
    mock.loadFixtureFile(fixtureFile(entries.valid));
    const result = await chat(await started(mock));
    expect(result.body.choices[0].message.content).toBe("");
  });

  it("config llm.misbehavior enables misbehavior and applies its baseline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aimock-opt-in-config-"));
    directories.push(directory);
    const fixtures = join(directory, "fixtures.json");
    writeFileSync(
      fixtures,
      JSON.stringify({ fixtures: [{ match: { userMessage: "go" }, response: { content: "hi" } }] }),
    );
    const configPath = join(directory, "aimock.json");
    writeFileSync(
      configPath,
      JSON.stringify({ llm: { fixtures, logLevel: "silent", misbehavior: "empty-response" } }),
    );
    const { llmock, url } = await startFromConfig(loadConfig(configPath));
    mocks.push(llmock);
    const result = await chat(url);
    expect(result.body.choices[0].message.content).toBe("");
  });
});
