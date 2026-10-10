import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import OpenAI from "openai";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enableHeldFixtureMisbehavior,
  entryToFixture as entryToFixtureHeld,
  loadFixtureFile as loadFixtureFileHeld,
  loadFixturesFromDir as loadFixturesFromDirHeld,
  markFixtureMisbehaviorEnabled,
  MisbehaviorConfigError,
  validateFixtures,
} from "../fixture-loader.js";
import {
  loadFixtureFileWithServices as loadFixtureFileWithServicesHeld,
  loadFixturesFromDirWithServices as loadFixturesFromDirWithServicesHeld,
} from "../fixture-loader-services.js";
import { getFixtureMisbehaviorPosition, fixtureMisbehaviorSourceKey } from "../misbehavior.js";
import type { Fixture, MisbehaviorConfig } from "../types.js";
import { Logger } from "../logger.js";
import { watchFixtures } from "../watcher.js";
import type { ServerInstance } from "../server.js";
import { LLMock, createServer } from "./helpers/misbehavior-enabled.js";

// Misbehavior is opt-in: the loaders hold a `misbehavior` key until a server
// with misbehavior enabled reads it. These loaders read it as that server does
// (the disabled behavior is in misbehavior-opt-in.test.ts).
function enabled<T extends Fixture[]>(fixtures: T): T {
  fixtures.forEach(enableHeldFixtureMisbehavior);
  return fixtures;
}
const entryToFixture = (...args: Parameters<typeof entryToFixtureHeld>): Fixture =>
  enabled([entryToFixtureHeld(...args)])[0];
const loadFixtureFile = (...args: Parameters<typeof loadFixtureFileHeld>) =>
  enabled(loadFixtureFileHeld(...args));
const loadFixturesFromDir = (...args: Parameters<typeof loadFixturesFromDirHeld>) =>
  enabled(loadFixturesFromDirHeld(...args));
function loadFixtureFileWithServices(
  ...args: Parameters<typeof loadFixtureFileWithServicesHeld>
): ReturnType<typeof loadFixtureFileWithServicesHeld> {
  const loaded = loadFixtureFileWithServicesHeld(...args);
  enabled(loaded.fixtures);
  return loaded;
}
function loadFixturesFromDirWithServices(
  ...args: Parameters<typeof loadFixturesFromDirWithServicesHeld>
): ReturnType<typeof loadFixturesFromDirWithServicesHeld> {
  const loaded = loadFixturesFromDirWithServicesHeld(...args);
  enabled(loaded.fixtures);
  return loaded;
}
/** Direct `validateFixtures` input, as a server with misbehavior enabled has recognized it. */
function recognized(fixtures: Fixture[]): Fixture[] {
  fixtures.forEach(markFixtureMisbehaviorEnabled);
  return fixtures;
}

const directories: string[] = [];
const response = { toolCalls: [{ name: "weather", arguments: { city: "Paris" } }] };
function fixtureFile(entries: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), "aimock-loading-"));
  directories.push(directory);
  const file = join(directory, "fixtures.json");
  writeFileSync(file, JSON.stringify({ fixtures: entries }));
  return { directory, file };
}
function entry(misbehavior: unknown, fixtureResponse: unknown = response) {
  return { match: { userMessage: "weather" }, response: fixtureResponse, misbehavior };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("fixture misbehavior loading", () => {
  it("rejects an actual unknown-fault file with its precise source and value", () => {
    const { file } = fixtureFile([entry({ faults: [{ fault: "unknown-fault" }] })]);
    expect(() => loadFixtureFile(file)).toThrowError(MisbehaviorConfigError);
    try {
      loadFixtureFile(file);
    } catch (error) {
      expect(error).toBeInstanceOf(MisbehaviorConfigError);
      if (!(error instanceof MisbehaviorConfigError)) throw error;
      expect(error.toJSON()).toMatchObject({
        rule: "misbehavior/bad-value",
        file,
      });
      expect(error.message).toContain("fixtures[0].misbehavior.faults[0].fault");
      expect(error.message).toContain("unknown-fault");
      expect(error.toJSON()).not.toHaveProperty("blockId");
      expect(error.toJSON()).not.toHaveProperty("entryId");
    }
  });

  it.each([
    [{ faults: [], typo: true }, "misbehavior/unknown-key"],
    [{ faults: [{ fault: "tool-args-invalid-json", typo: true }] }, "misbehavior/unknown-key"],
    [{ faults: [{ fault: "tool-args-invalid-json", rate: 2 }] }, "misbehavior/bad-value"],
    [{ faults: [{ fault: "tool-args-invalid-json", times: 0 }] }, "misbehavior/bad-value"],
    [{ faults: [{ fault: "tool-args-invalid-json", style: "unknown" }] }, "misbehavior/bad-value"],
    [{ faults: [{ fault: "stop-length-mid-tool", at: 1 }] }, "misbehavior/bad-value"],
    [{ faults: [], seed: 0.5 }, "misbehavior/bad-value"],
    [
      { faults: [{ fault: "tool-args-invalid-json", providers: ["unknown"] }] },
      "misbehavior/bad-value",
    ],
    [
      { faults: [{ fault: "content-filter", providers: ["anthropic"] }] },
      "misbehavior/unsupported-on-wire",
    ],
    [
      { faults: [{ fault: "tool-args-invalid-json", tool: "missing" }] },
      "misbehavior/not-applicable",
    ],
  ])("rejects invalid config %j", (config, rule) => {
    const { file } = fixtureFile([entry(config)]);
    expect(() => loadFixtureFile(file)).toThrowError(expect.objectContaining({ rule, file }));
  });

  it("rejects faults on a static response without tools", () => {
    const { file } = fixtureFile([entry("tool-args-invalid-json", { content: "hello" })]);
    expect(() => loadFixtureFile(file)).toThrowError(
      expect.objectContaining({ rule: "misbehavior/not-applicable" }),
    );
  });

  it("preserves and normalizes shorthand in shared entry parsing", () => {
    const fixture = entryToFixture({ match: {}, response, misbehavior: "tool-args-invalid-json" });
    expect(fixture.misbehavior).toEqual({ faults: [{ fault: "tool-args-invalid-json" }] });
  });

  it("preserves empty overrides and defers request-dependent schema applicability", () => {
    const { file } = fixtureFile([entry({ faults: [] }), entry("tool-args-schema-violation")]);
    expect(loadFixtureFile(file).map((fixture) => fixture.misbehavior)).toEqual([
      { faults: [] },
      { faults: [{ fault: "tool-args-schema-violation" }] },
    ]);
  });

  it.each(["file", "directory"])(
    "rejects the entire %s batch before LLMock adds any fixtures",
    (surface) => {
      const { file, directory } = fixtureFile([entry({ faults: [] }), entry("unknown-fault")]);
      const mock = new LLMock({ logLevel: "silent" });
      mock.addFixture({ match: { userMessage: "existing" }, response: { content: "kept" } });
      expect(() =>
        surface === "file" ? mock.loadFixtureFile(file) : mock.loadFixtureDir(directory),
      ).toThrowError(MisbehaviorConfigError);
      expect(mock.getFixtures()).toHaveLength(1);
      expect(mock.getFixtures()[0].match.userMessage).toBe("existing");
      expect(() => loadFixturesFromDir(directory)).toThrowError(MisbehaviorConfigError);
    },
  );
});

describe("logical loader sources", () => {
  const source = "https://fixtures.example.test/nested/weather.json?revision=1";
  const config: MisbehaviorConfig = {
    seed: 27,
    faults: [{ fault: "tool-args-invalid-json", rate: 0.5 }],
  };
  const directoryLoaders = [
    { name: "ordinary", load: loadFixturesFromDir },
    {
      name: "services",
      load: (directory: string) => loadFixturesFromDirWithServices(directory).fixtures,
    },
  ];

  it("reports the URL label instead of its downloaded physical path", () => {
    const { file } = fixtureFile([entry("unknown-fault")]);
    expect(() => loadFixtureFileWithServices(file, undefined, undefined, source)).toThrowError(
      expect.objectContaining({ file: source, message: expect.stringContaining(source) }),
    );
  });

  it("replays the same logical URL fault sequence through the real OpenAI SDK after separate downloads", async () => {
    const downloads: string[] = [];
    const body = JSON.stringify({
      fixtures: [
        { match: { userMessage: "unrelated" }, response: { content: "unused" } },
        entry(config),
      ],
    });
    const fixtureServer = createHttpServer((request, reply) => {
      downloads.push(request.url ?? "");
      reply.writeHead(200, { "Content-Type": "application/json" });
      reply.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      fixtureServer.once("error", reject);
      fixtureServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = fixtureServer.address();
      if (address === null || typeof address === "string") throw new Error("Missing fixture port");
      const logicalSource = `http://127.0.0.1:${address.port}/nested/weather.json?revision=1`;
      const physicalFiles = [fixtureFile([]).file, fixtureFile([]).file];
      expect(physicalFiles[0]).not.toBe(physicalFiles[1]);
      const sequences: string[][] = [];
      const sourceKeys: string[] = [];
      for (const physicalFile of physicalFiles) {
        const download = await fetch(logicalSource);
        expect(download.status).toBe(200);
        writeFileSync(physicalFile, await download.text());
        const loaded = loadFixtureFileWithServices(
          physicalFile,
          undefined,
          undefined,
          logicalSource,
        ).fixtures;
        expect(loaded.map(getFixtureMisbehaviorPosition)).toEqual([
          `${logicalSource}#0`,
          `${logicalSource}#1`,
        ]);
        const mock = new LLMock({ port: 0, logLevel: "silent" });
        mock.addFixtures(loaded);
        const active = mock.getFixtures()[1];
        expect(active.match).toEqual(loaded[1].match);
        expect(getFixtureMisbehaviorPosition(active)).toBe(`${logicalSource}#1`);
        const sourceKey = fixtureMisbehaviorSourceKey(active, config);
        expect(sourceKey).toBe(fixtureMisbehaviorSourceKey(loaded[1], config));
        sourceKeys.push(sourceKey);
        const url = await mock.start();
        try {
          const client = new OpenAI({
            apiKey: "local",
            baseURL: `${url}/v1`,
            maxRetries: 0,
            timeout: 5000,
          });
          const sequence: string[] = [];
          for (let ordinal = 0; ordinal < 64; ordinal++) {
            const completion = await client.chat.completions.create(
              {
                model: "local",
                messages: [{ role: "user", content: "weather" }],
                stream: false,
              },
              { headers: { "X-Test-Id": "logical-url-sequence" } },
            );
            const calls = completion.choices[0].message.tool_calls;
            expect(calls).toHaveLength(1);
            const call = calls?.[0];
            if (call?.type !== "function") throw new Error("Missing function tool call");
            expect(call.function.name).toBe("weather");
            sequence.push(call.function.arguments);
          }
          const applied = sequence.map((argumentsText) => {
            try {
              expect(JSON.parse(argumentsText)).toEqual({ city: "Paris" });
              return false;
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              return true;
            }
          });
          expect(applied).toContain(true);
          expect(applied).toContain(false);
          const requests = mock.getRequests();
          expect(requests).toHaveLength(64);
          expect(requests.map((request) => request.response.misbehavior?.applied)).toEqual(applied);
          console.log(
            "L1b real SDK logical URL sequence",
            JSON.stringify({
              logicalSource,
              physicalFile,
              position: getFixtureMisbehaviorPosition(active),
              sourceKey,
              seed: config.seed,
              testId: "logical-url-sequence",
              sequence,
              applied,
            }),
          );
          sequences.push(sequence);
        } finally {
          await mock.stop();
        }
      }
      expect(downloads).toEqual([
        "/nested/weather.json?revision=1",
        "/nested/weather.json?revision=1",
      ]);
      expect(sourceKeys[0]).toBe(sourceKeys[1]);
      expect(sequences[0]).toEqual(sequences[1]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        fixtureServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(directoryLoaders)(
    "reports nested root-relative errors with $name loading",
    ({ load }) => {
      const { directory } = fixtureFile([]);
      mkdirSync(join(directory, "nested", "deep"), { recursive: true });
      writeFileSync(
        join(directory, "nested", "deep", "bad.json"),
        JSON.stringify({ fixtures: [entry("unknown-fault")] }),
      );
      expect(() => load(directory)).toThrowError(
        expect.objectContaining({
          file: "nested/deep/bad.json",
          message: expect.stringContaining("fixtures[0].misbehavior"),
        }),
      );
    },
  );

  it("uses logical URL and original entry indices for seeded source identity", () => {
    const first = fixtureFile([{ match: [], response }, entry(config), entry(config)]);
    const second = fixtureFile([{ match: [], response }, entry(config), entry(config)]);
    const left = loadFixtureFileWithServices(first.file, undefined, undefined, source).fixtures;
    const right = loadFixtureFileWithServices(second.file, undefined, undefined, source).fixtures;
    expect(left.map((fixture) => fixtureMisbehaviorSourceKey(fixture, config))).toEqual(
      right.map((fixture) => fixtureMisbehaviorSourceKey(fixture, config)),
    );
    expect(left.map(getFixtureMisbehaviorPosition)).toEqual([`${source}#1`, `${source}#2`]);
    expect(fixtureMisbehaviorSourceKey(left[0], config)).not.toBe(
      fixtureMisbehaviorSourceKey(left[1], config),
    );
    expect(left[0]).not.toHaveProperty("loadPosition");
  });

  it.each(directoryLoaders)(
    "preserves nested root-relative positions with $name loading",
    ({ load }) => {
      const { directory } = fixtureFile([entry({ faults: [] })]);
      mkdirSync(join(directory, "nested", "deep"), { recursive: true });
      writeFileSync(
        join(directory, "nested", "deep", "valid.json"),
        JSON.stringify({ fixtures: [entry(config), entry(config)] }),
      );
      expect(load(directory).map(getFixtureMisbehaviorPosition)).toEqual([
        "fixtures.json#0",
        "nested/deep/valid.json#0",
        "nested/deep/valid.json#1",
      ]);
    },
  );

  it("retains single-file spelling in both loader families even without misbehavior", () => {
    const { file } = fixtureFile([{ match: {}, response }]);
    expect(loadFixtureFile(file).map(getFixtureMisbehaviorPosition)).toEqual([`${file}#0`]);
    expect(loadFixtureFileWithServices(file).fixtures.map(getFixtureMisbehaviorPosition)).toEqual([
      `${file}#0`,
    ]);
  });
});

describe("programmatic misbehavior acceptance", () => {
  const response = { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] };
  const config: MisbehaviorConfig = { faults: [{ fault: "tool-args-invalid-json" }] };
  const invalid: MisbehaviorConfig = {
    faults: [{ fault: "tool-args-invalid-json", rate: 2 }],
  };
  const acceptors = [
    {
      name: "addFixture",
      add: (mock: LLMock, misbehavior: MisbehaviorConfig) =>
        mock.addFixture({ match: {}, response, misbehavior }),
    },
    {
      name: "addFixtures",
      add: (mock: LLMock, misbehavior: MisbehaviorConfig) =>
        mock.addFixtures([
          { match: {}, response },
          { match: {}, response, misbehavior },
        ]),
    },
    {
      name: "prependFixture",
      add: (mock: LLMock, misbehavior: MisbehaviorConfig) =>
        mock.prependFixture({ match: {}, response, misbehavior }),
    },
    {
      name: "on",
      add: (mock: LLMock, misbehavior: MisbehaviorConfig) => mock.on({}, response, { misbehavior }),
    },
    {
      name: "onMessage",
      add: (mock: LLMock, misbehavior: MisbehaviorConfig) =>
        mock.onMessage("weather", response, { misbehavior }),
    },
    {
      name: "addFixturesFromJSON",
      add: (mock: LLMock, misbehavior: MisbehaviorConfig) =>
        mock.addFixturesFromJSON([
          { match: {}, response },
          { match: {}, response, misbehavior },
        ]),
    },
  ];

  describe.each([false, true])("started=%s", (started) => {
    it.each(acceptors)(
      "$name rejects invalid input without changing the served queue",
      async ({ add }) => {
        const mock = new LLMock({ port: 0, logLevel: "silent" });
        mock.onMessage("weather", { content: "kept" });
        if (started) await mock.start();
        try {
          let failure: unknown;
          try {
            add(mock, invalid);
          } catch (error) {
            failure = error;
          }
          if (!started) await mock.start();
          const result = await fetch(`${mock.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "test",
              messages: [{ role: "user", content: "weather" }],
            }),
          });
          const body: unknown = await result.json();
          expect(result.status).toBe(200);
          expect(body).toMatchObject({ choices: [{ message: { content: "kept" } }] });
          expect(failure).toBeInstanceOf(MisbehaviorConfigError);
          expect(failure).toMatchObject({
            rule: "misbehavior/bad-value",
            file: expect.stringMatching(/^code#\d+$/),
          });
          expect(mock.getFixtures()).toHaveLength(1);
        } finally {
          await mock.stop();
        }
      },
    );

    it.each(acceptors)(
      "$name assigns unique code positions to accepted fixtures",
      async ({ add }) => {
        const mock = new LLMock({ port: 0, logLevel: "silent" });
        if (started) await mock.start();
        try {
          add(mock, config);
          const positions = mock.getFixtures().map(getFixtureMisbehaviorPosition);
          expect(positions.every((position) => /^code#\d+$/.test(position ?? ""))).toBe(true);
          expect(new Set(positions).size).toBe(positions.length);
          mock.clearFixtures();
          add(mock, config);
          expect(
            mock
              .getFixtures()
              .map(getFixtureMisbehaviorPosition)
              .every((position) => !positions.includes(position)),
          ).toBe(true);
        } finally {
          if (started) await mock.stop();
        }
      },
    );
  });

  it.each([false, true])(
    "re-additions keep independent real journal counters, started=%s",
    async (started) => {
      const mock = new LLMock({ port: 0, logLevel: "silent" });
      mock.addFixture({ match: {}, response, misbehavior: config });
      const first = mock.getFixtures()[0];
      const firstPosition = getFixtureMisbehaviorPosition(first);
      if (started) await mock.start();
      try {
        mock.addFixture(first);
        if (!started) await mock.start();
        const [left, right] = mock.getFixtures();
        const key = {
          testId: "re-add",
          sourceKey: fixtureMisbehaviorSourceKey(left, config),
          entryIndex: 0,
        };
        const otherKey = { ...key, sourceKey: fixtureMisbehaviorSourceKey(right, config) };
        mock.journal.recordFiring(key);
        expect(mock.journal.nextOrdinal(key)).toBe(0);
        expect(mock.journal.getFiringCount(otherKey)).toBe(0);
        expect(mock.journal.nextOrdinal(otherKey)).toBe(0);
        expect(otherKey.sourceKey).not.toBe(key.sourceKey);
        expect(getFixtureMisbehaviorPosition(first)).toBe(firstPosition);
        expect(getFixtureMisbehaviorPosition(right)).toBe("code#1");
      } finally {
        await mock.stop();
      }
    },
  );

  it("assigns destination positions when reusing another instance's accepted fixture", () => {
    const source = new LLMock().addFixture({ match: {}, response });
    const accepted = source.getFixtures()[0];
    const destination = new LLMock().addFixture({ match: {}, response });
    destination.addFixtures([accepted, accepted]);
    expect(destination.getFixtures().map(getFixtureMisbehaviorPosition)).toEqual([
      "code#0",
      "code#1",
      "code#2",
    ]);
    expect(getFixtureMisbehaviorPosition(accepted)).toBe("code#0");
    expect(
      new Set(
        destination.getFixtures().map((fixture) => fixtureMisbehaviorSourceKey(fixture, config)),
      ).size,
    ).toBe(3);
  });

  it("rejects statically inapplicable programmatic faults", () => {
    const mock = new LLMock();
    expect(() => mock.on({}, { content: "no tools" }, { misbehavior: config })).toThrowError(
      expect.objectContaining({ rule: "misbehavior/not-applicable" }),
    );
    expect(mock.getFixtures()).toHaveLength(0);
  });

  it("preserves loaded identities through live normalization clones", () => {
    const loaded = loadFixtureFile("fixtures/openai-live-client.json")[0];
    const mock = new LLMock().addFixture(loaded);
    expect(mock.getFixtures()[0]).not.toBe(loaded);
    expect(getFixtureMisbehaviorPosition(mock.getFixtures()[0])).toBe(
      "fixtures/openai-live-client.json#0",
    );
    expect(mock.getFixtures()[0]).not.toHaveProperty("loadPosition");
  });
});

describe("normal CLI startup misbehavior diagnostics", () => {
  describe.each([false, true])("strict=%s", (strict) => {
    it.each(["silent", "warn", "info", "debug"])(
      "rejects malformed config without --validate-on-load at log level %s",
      (logLevel) => {
        const { file } = fixtureFile([
          entry({ faults: [{ fault: "tool-args-invalid-json", rate: 2 }] }),
        ]);
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            createRequire(import.meta.url).resolve("tsx"),
            resolve("src/cli.ts"),
            "--fixtures",
            file,
            "--port",
            "0",
            "--host",
            "127.0.0.1",
            "--log-level",
            logLevel,
            "--misbehavior",
            ...(strict ? ["--strict"] : []),
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`"${file}": [misbehavior/bad-value]`);
        expect(result.stderr).toContain("fixtures[0].misbehavior.faults[0].rate");
        expect(result.stderr).toContain("2");
      },
      10000,
    );
  });
});

describe("actual validate command misbehavior diagnostics", () => {
  function validate(args: string[], cwd?: string) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        resolve("src/aimock-cli.ts"),
        "validate",
        "--misbehavior",
        ...args,
      ],
      { encoding: "utf8", cwd, timeout: 15000 },
    );
    expect(result.error).toBeUndefined();
    return result;
  }

  it.each([
    {
      config: { faults: [], typo: "unexpected" },
      rule: "unknown-key",
      path: ".typo",
      value: "unexpected",
      fixtureResponse: response,
    },
    {
      config: { faults: [{ fault: "tool-args-invalid-json", rate: 2 }] },
      rule: "bad-value",
      path: ".faults[0].rate",
      value: "2",
      fixtureResponse: response,
    },
    {
      config: "tool-args-invalid-json",
      rule: "not-applicable",
      path: ".faults[0]",
      value: "tool-args-invalid-json",
      fixtureResponse: { content: "hello" },
    },
    {
      config: { faults: [{ fault: "content-filter", providers: ["anthropic"] }] },
      rule: "unsupported-on-wire",
      path: ".faults[0]",
      value: "content-filter",
      fixtureResponse: response,
    },
  ])(
    "reports $rule with logical source, original index, path and value",
    ({ config, rule, path, value, fixtureResponse }) => {
      const { directory } = fixtureFile([]);
      mkdirSync(join(directory, "nested"));
      writeFileSync(
        join(directory, "nested", "case.json"),
        JSON.stringify({ fixtures: [null, entry(config, fixtureResponse)] }),
      );
      for (const json of [false, true]) {
        const result = validate([...(json ? ["--json"] : []), directory]);
        expect(result.status).toBe(1);
        const report = json
          ? (JSON.parse(result.stdout) as {
              files: { errors: { index?: number; message: string }[] }[];
            })
          : undefined;
        const output = report
          ? (report.files.flatMap((file) => file.errors).find((error) => error.index === 1)
              ?.message ?? "")
          : result.stderr;
        expect(output).toContain(`misbehavior/${rule}`);
        expect(output).toContain(`"nested/case.json": [misbehavior/${rule}]`);
        expect(output).toContain(`fixtures[1].misbehavior${path}`);
        expect(output).toContain(value);
        expect(output).not.toContain("could not be converted");
      }
    },
  );

  it("does not repeat probabilistic warnings in the cross-file pass", () => {
    const config = { faults: [{ fault: "tool-args-invalid-json", rate: 0.5 }] };
    const first = fixtureFile([entry(config)]);
    const second = fixtureFile([entry(config)]);
    const result = validate(["--json", first.file, second.file]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      files: { warnings: { index: number; message: string }[] }[];
    };
    for (const file of report.files) {
      expect(
        file.warnings.filter(({ message }) => message.includes("probabilistic fault")),
      ).toEqual([
        {
          index: 0,
          message:
            "probabilistic fault without a seed is reproducible only per test id order; set seed to pin it",
        },
      ]);
    }
  });

  it("keeps a named relative source spelling", () => {
    const { directory } = fixtureFile([entry("unknown-fault")]);
    const result = validate(["./fixtures.json"], directory);
    expect(result.stderr).toContain('"./fixtures.json": [misbehavior/bad-value]');
    expect(result.stderr).toContain("fixtures[0].misbehavior");
  });

  it.each([
    { rate: 0.5, warn: true },
    { rate: 0, warn: true },
    { rate: 1, warn: false },
    { rate: undefined, warn: false },
    { rate: 0.5, seed: 0, warn: false },
    { rate: 0.5, seed: "random", warn: false },
    { rate: 0.5, times: 1, warn: false },
  ])(
    "warns only for the specified unseeded probabilistic case %j",
    ({ rate, seed, times, warn }) => {
      const { file } = fixtureFile([
        entry({ seed, faults: [{ fault: "tool-args-invalid-json", rate, times }] }),
      ]);
      for (const strict of [false, true]) {
        const result = validate(["--json", ...(strict ? ["--strict"] : []), file]);
        const report = JSON.parse(result.stdout) as {
          files: { warnings: { message: string }[] }[];
        };
        const warnings = report.files[0].warnings.filter(({ message }) =>
          message.includes(
            "probabilistic fault without a seed is reproducible only per test id order; set seed to pin it",
          ),
        );
        expect(warnings).toHaveLength(warn ? 1 : 0);
        expect(result.status).toBe(strict && warn ? 1 : 0);
      }
    },
  );

  it.each([
    { toolCalls: [{ name: "weather", arguments: "{broken" }] },
    { blocks: [{ type: "toolCall", name: "weather", arguments: "{broken" }] },
  ])("retains authored-invalid JSON as an error with the B5 hint %j", (fixtureResponse) => {
    const { file } = fixtureFile([
      { match: { userMessage: "weather" }, response: fixtureResponse },
    ]);
    const result = validate(["--json", file]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as { files: { errors: { message: string }[] }[] };
    expect(report.files[0].errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(
            "to send invalid JSON on purpose, use `misbehavior: tool-args-invalid-json`",
          ),
        }),
      ]),
    );
  });
});

describe("shared validateFixtures misbehavior diagnostics", () => {
  const validResponse = { toolCalls: [{ name: "weather", arguments: '{"city":"Paris"}' }] };
  it.each([
    { config: { faults: [], typo: true }, rule: "unknown-key" },
    { config: { faults: [{ fault: "tool-args-invalid-json", rate: 2 }] }, rule: "bad-value" },
    { config: "tool-args-invalid-json", rule: "not-applicable", response: { content: "hello" } },
    {
      config: { faults: [{ fault: "content-filter", providers: ["anthropic"] }] },
      rule: "unsupported-on-wire",
    },
  ])("reports $rule on direct input", ({ config, rule, response }) => {
    const fixtures: Fixture[] = JSON.parse(
      JSON.stringify([entry(config, response ?? validResponse)]),
    );
    const before = JSON.stringify(fixtures);
    expect(validateFixtures(recognized(fixtures))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          fixtureIndex: 0,
          message: expect.stringContaining(`misbehavior/${rule}`),
        }),
      ]),
    );
    expect(JSON.stringify(fixtures)).toBe(before);
  });

  it.each([
    { rate: 0.5, warn: true },
    { rate: 0, warn: true },
    { rate: 1, warn: false },
    { rate: undefined, warn: false },
    { rate: 0.5, seed: 0, warn: false },
    { rate: 0.5, seed: "random", warn: false },
    { rate: 0.5, times: 1, warn: false },
  ])("only returns the specified probabilistic warning %j", ({ rate, seed, times, warn }) => {
    const fixtures: Fixture[] = JSON.parse(
      JSON.stringify([
        entry({ seed, faults: [{ fault: "tool-args-invalid-json", rate, times }] }, validResponse),
      ]),
    );
    expect(validateFixtures(recognized(fixtures))).toEqual(
      warn
        ? [
            {
              severity: "warning",
              fixtureIndex: 0,
              message:
                "probabilistic fault without a seed is reproducible only per test id order; set seed to pin it",
            },
          ]
        : [],
    );
  });

  it.each([
    { toolCalls: [{ name: "weather", arguments: "{broken" }] },
    { content: "check", toolCalls: [{ name: "weather", arguments: "{broken" }] },
    { blocks: [{ type: "toolCall", name: "weather", arguments: "{broken" }] },
  ])("adds B5 to the existing error for %j", (response) => {
    const fixtures: Fixture[] = JSON.parse(
      JSON.stringify([{ match: { userMessage: "weather" }, response }]),
    );
    const errors = validateFixtures(fixtures).filter((result) => result.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      "to send invalid JSON on purpose, use `misbehavior: tool-args-invalid-json`",
    );
  });
});

// Run real plugin hooks in a child runner: a failing beforeAll must not fail
// this parent suite. As in mcp-fakes-plugins, Jest uses Vitest's compatible globals.
describe("actual plugin misbehavior diagnostics", () => {
  function runPlugin(plugin: string, fixturePath: string) {
    const directory = mkdtempSync(resolve(".aimock-plugin-loading-"));
    directories.push(directory);
    const testFile = join(directory, "plugin.test.ts");
    const configFile = join(directory, "vitest.config.mjs");
    writeFileSync(
      configFile,
      `export default ${JSON.stringify({
        test: {
          root: directory,
          include: ["plugin.test.ts"],
          globals: true,
          pool: "forks",
          maxWorkers: 1,
          fileParallelism: false,
        },
      })};`,
    );
    writeFileSync(
      testFile,
      `import { useAimock } from ${JSON.stringify(resolve(`src/${plugin}.ts`))};
const mock = useAimock({ fixtures: ${JSON.stringify(fixturePath)}, port: 0, patchEnv: false, logLevel: "silent", enableMisbehavior: true });
it("serves the loaded fixture over HTTP", async () => {
  const result = await fetch(mock().url + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "weather" }] }),
  });
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body.choices[0].message).toBeDefined();
});`,
    );
    const result = spawnSync(
      process.execPath,
      [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", configFile],
      { encoding: "utf8", timeout: 15000, env: { ...process.env, NO_COLOR: "1", CI: "1" } },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, output: result.stdout + result.stderr };
  }

  describe.each(["vitest", "jest"])("%s plugin", (plugin) => {
    // KNOWN DEPENDENCY: the plugins' loadFixtures rethrows only FixtureLoadError
    // and logs any other load error as a warning, so a MisbehaviorConfigError
    // does not yet fail beforeAll. The fix is one `|| err instanceof
    // MisbehaviorConfigError` in src/vitest.ts and src/jest.ts (owned by the
    // #509 track). `it.fails` keeps the required behavior here and turns red
    // once the plugins propagate the error: then change it back to `it.each`.
    it.fails.each([
      {
        surface: "file",
        config: { faults: [], typo: "unexpected" },
        rule: "unknown-key",
        path: ".typo",
        value: "unexpected",
        fixtureResponse: response,
      },
      {
        surface: "directory",
        config: { faults: [{ fault: "tool-args-invalid-json", rate: 2 }] },
        rule: "bad-value",
        path: ".faults[0].rate",
        value: "2",
        fixtureResponse: response,
      },
      {
        surface: "file",
        config: "tool-args-invalid-json",
        rule: "not-applicable",
        path: ".faults[0]",
        value: "tool-args-invalid-json",
        fixtureResponse: { content: "hello" },
      },
      {
        surface: "directory",
        config: { faults: [{ fault: "content-filter", providers: ["anthropic"] }] },
        rule: "unsupported-on-wire",
        path: ".faults[0]",
        value: "content-filter",
        fixtureResponse: response,
      },
    ])(
      "propagates $rule from a $surface through beforeAll",
      ({ surface, config, rule, path, value, fixtureResponse }) => {
        const { file, directory } = fixtureFile([entry(config, fixtureResponse)]);
        const result = runPlugin(plugin, surface === "file" ? file : directory);
        expect(result.status, result.output).toBe(1);
        expect(result.output).toContain("MisbehaviorConfigError:");
        expect(result.output).toContain(`[misbehavior/${rule}]`);
        expect(result.output).toContain(surface === "file" ? file : "fixtures.json");
        expect(result.output).toContain(`fixtures[0].misbehavior${path}`);
        expect(result.output).toContain(value);
        expect(result.output).toMatch(/Tests\s+1 skipped \(1\)/);
        expect(result.output).not.toContain("[aimock] Failed to load fixtures");
      },
      20000,
    );

    it("starts and serves HTTP with a valid empty misbehavior override", () => {
      const { file } = fixtureFile([entry({ faults: [] })]);
      const result = runPlugin(plugin, file);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toMatch(/Tests\s+1 passed \(1\)/);
    }, 20000);
  });
});

describe("actual watcher invalid misbehavior reload", () => {
  async function withWatchedFile(
    run: (context: {
      mock: ServerInstance;
      fixtures: Fixture[];
      rejectReload: () => Promise<void>;
      chat: () => Promise<unknown>;
    }) => Promise<void>,
  ) {
    const { file } = fixtureFile([entry({ faults: [] }, { content: "active answer" })]);
    const fixtures = loadFixtureFile(file);
    const mock = await createServer(fixtures, { port: 0, logLevel: "silent" });
    const logger = new Logger("silent");
    const errors = vi.spyOn(logger, "error");
    let loads = 0;
    const watcher = watchFixtures(
      file,
      fixtures,
      () => {
        loads++;
        return loadFixtureFile(file);
      },
      { logger },
    );
    async function chat() {
      const result = await fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-Id": "watch" },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "weather" }] }),
      });
      expect(result.status).toBe(200);
      const body: unknown = await result.json();
      return body;
    }
    try {
      await run({
        mock,
        fixtures,
        chat,
        rejectReload: async () => {
          writeFileSync(
            file,
            JSON.stringify({
              fixtures: [entry("unknown-fault", { content: "invalid replacement" })],
            }),
          );
          await expect.poll(() => loads, { timeout: 5000 }).toBeGreaterThan(0);
          const after = await chat();
          console.log(
            "L3d watcher reload",
            JSON.stringify({
              loads,
              after,
              errors: errors.mock.calls.map((args) =>
                args.map((arg) => (arg instanceof Error ? arg.message : arg)),
              ),
            }),
          );
          expect(after).toMatchObject({ choices: [{ message: { content: "active answer" } }] });
          expect(errors).toHaveBeenCalledWith(
            "Failed to reload fixtures:",
            expect.objectContaining({
              rule: "misbehavior/bad-value",
              file,
              message: expect.stringContaining("fixtures[0].misbehavior"),
            }),
          );
          expect(errors).toHaveBeenCalledWith(
            "Previous fixtures remain active. Fix the error and save again to retry.",
          );
        },
      });
    } finally {
      watcher.close();
      errors.mockRestore();
      await new Promise<void>((resolve, reject) => {
        mock.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  it("keeps the old served fixture after a real invalid file change", async () => {
    await withWatchedFile(async ({ fixtures, chat, rejectReload }) => {
      const active = fixtures[0];
      expect(await chat()).toMatchObject({ choices: [{ message: { content: "active answer" } }] });
      await rejectReload();
      expect(fixtures).toEqual([active]);
      expect(fixtures[0]).toBe(active);
    });
  });

  it("preserves runtime scopes and existing journal counters on rejected reload", async () => {
    await withWatchedFile(async ({ mock, fixtures, chat, rejectReload }) => {
      const config: MisbehaviorConfig = {
        seed: 29,
        faults: [{ fault: "empty-response", times: 1 }],
      };
      async function scope(testId: string, method: "GET" | "POST") {
        const result = await fetch(`${mock.url}/__aimock/misbehavior`, {
          method,
          headers: { "Content-Type": "application/json", "X-Test-Id": testId },
          ...(method === "POST" ? { body: JSON.stringify(config) } : {}),
        });
        expect(result.status).toBe(200);
        const body: unknown = await result.json();
        return body;
      }
      const installed = await scope("watch", "POST");
      expect(installed).toEqual({ misbehavior: config });
      expect(await scope("other", "GET")).toEqual({ misbehavior: { faults: [] } });
      expect(await chat()).toMatchObject({ choices: [{ message: { content: "active answer" } }] });
      const active = fixtures[0];
      const matches = mock.journal.getFixtureMatchCount(active, "watch");
      expect(matches).toBe(1);
      // Seed real journal state directly: renderer delivery is a later integration gate.
      const key = { testId: "watch", sourceKey: "scope:watch", entryIndex: 0 };
      mock.journal.recordFiring(key);
      expect(mock.journal.nextOrdinal(key)).toBe(0);
      await rejectReload();
      expect(mock.journal.getFiringCount(key)).toBe(1);
      expect(mock.journal.nextOrdinal(key)).toBe(1);
      expect(mock.journal.getFixtureMatchCount(active, "watch")).toBe(matches + 1);
      expect(await scope("watch", "GET")).toEqual(installed);
      expect(await scope("other", "GET")).toEqual({ misbehavior: { faults: [] } });
      console.log(
        "L3d preserved runtime state",
        JSON.stringify({
          installed,
          firings: mock.journal.getFiringCount(key),
          nextOrdinalBeforeCheck: 1,
          matches: mock.journal.getFixtureMatchCount(active, "watch"),
        }),
      );
    });
  });
});
