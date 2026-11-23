/**
 * `validateFixtures` never throws on a fixture whose `chaos` is not a plain
 * object. `chaos: null` threw a TypeError (so it never validated) and is now a
 * validation error on every validating entry path (`validateFixtures`,
 * `addFixturesFromJSON`, the CLI's `--validate-on-load`). An array or a
 * primitive validated clean and is ignored at request time, so it stays
 * loadable with a warning. A fixture with no `chaos` key, or a valid `chaos`
 * object, validates as before.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { entryToFixture, validateFixtures } from "../fixture-loader.js";
import { LLMock } from "../llmock.js";
import type { FixtureFileEntry } from "../types.js";
import { assertBuiltCliIsCurrent } from "./helpers/built-cli.js";

const NULL_MESSAGE = "chaos must be an object";
const IGNORED_MESSAGE = "chaos must be an object; it is ignored";

const IGNORED_SHAPES: [string, unknown][] = [
  ["an array", [0.5]],
  ["a string", "drop"],
  ["a number", 0.5],
  ["a boolean", true],
];

function entries(chaos: unknown, withChaos = true): FixtureFileEntry[] {
  const entry: Record<string, unknown> = {
    match: { userMessage: "chaos-shape" },
    response: { content: "ok" },
  };
  if (withChaos) entry.chaos = chaos;
  return JSON.parse(JSON.stringify([entry]));
}

function chaosFindings(chaos: unknown, withChaos = true) {
  const fixtures = entries(chaos, withChaos).map((e) => entryToFixture(e));
  return validateFixtures(fixtures).filter((r) => r.message.startsWith("chaos"));
}

describe("validateFixtures: chaos must be a plain object", () => {
  it("chaos as null is a validation error, not a TypeError", () => {
    expect(chaosFindings(null)).toEqual([
      { severity: "error", fixtureIndex: 0, message: NULL_MESSAGE },
    ]);
  });

  it.each(IGNORED_SHAPES)("chaos as %s is a warning and stays loadable", (_label, chaos) => {
    expect(chaosFindings(chaos)).toEqual([
      { severity: "warning", fixtureIndex: 0, message: IGNORED_MESSAGE },
    ]);
  });

  it("a fixture with no chaos key has no chaos finding", () => {
    expect(chaosFindings(undefined, false)).toEqual([]);
  });

  it("a valid chaos object has no chaos finding", () => {
    expect(chaosFindings({ dropRate: 0.5, latencyMs: 10, seed: 42 })).toEqual([]);
  });

  it.each([
    ["a comma", "run,7"],
    ["a space", "has space"],
    ["an empty string", ""],
    ["a non-finite number", Number.POSITIVE_INFINITY],
    ["a boolean", true],
  ])("an invalid chaos.seed (%s) is a warning and stays loadable", (_label, seed) => {
    // Built directly, not through `entries`: JSON would turn Infinity into null.
    const fixture = entryToFixture({
      match: { userMessage: "chaos-shape" },
      response: { content: "ok" },
      chaos: { dropRate: 0.5, seed },
    } as unknown as FixtureFileEntry);
    expect(validateFixtures([fixture]).filter((r) => r.message.startsWith("chaos"))).toEqual([
      {
        severity: "warning",
        fixtureIndex: 0,
        message:
          "chaos.seed must be a finite number or 1-128 visible ASCII characters without spaces or commas; it is ignored",
      },
    ]);
  });

  it("an invalid chaos field in an object is still reported per field", () => {
    expect(chaosFindings({ dropRate: 2 })).toEqual([
      {
        severity: "error",
        fixtureIndex: 0,
        message: "chaos.dropRate must be a number between 0 and 1",
      },
    ]);
  });
});

describe("addFixturesFromJSON: chaos shape", () => {
  it("chaos as null is rejected with the validation finding, not a TypeError", () => {
    let thrown: unknown;
    try {
      new LLMock({ logLevel: "silent" }).addFixturesFromJSON(entries(null));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain(NULL_MESSAGE);
  });

  it.each(IGNORED_SHAPES)("chaos as %s still loads", (_label, chaos) => {
    expect(() =>
      new LLMock({ logLevel: "silent" }).addFixturesFromJSON(entries(chaos)),
    ).not.toThrow();
  });
});

describe("CLI --validate-on-load: chaos shape", () => {
  const CLI_PATH = resolve(__dirname, "../../dist/cli.js");
  /** Same start budget as the other CLI tests (`waitForOutput(/listening on/i, 5000)`). */
  const CLI_TIMEOUT_MS = 5_000;

  async function runCli(chaos: unknown): Promise<{ stderr: string; code: number | null }> {
    assertBuiltCliIsCurrent(CLI_PATH);
    const dir = mkdtempSync(join(tmpdir(), "aimock-chaos-shape-"));
    try {
      const file = join(dir, "fixtures.json");
      writeFileSync(file, JSON.stringify({ fixtures: entries(chaos) }));
      return await new Promise((done, fail) => {
        // A valid file starts a server: stop it once it is listening.
        const cp = execFile(process.execPath, [
          CLI_PATH,
          "-f",
          file,
          "-p",
          "0",
          "--validate-on-load",
        ]);
        let err = "";
        let out = "";
        // Neither exited nor listening in time: kill it and fail, never hang.
        const timer = setTimeout(() => {
          cp.removeAllListeners("close");
          cp.kill("SIGKILL");
          fail(new Error(`CLI neither exited nor started listening: ${out}${err}`));
        }, CLI_TIMEOUT_MS);
        cp.stderr?.on("data", (d) => (err += d));
        cp.stdout?.on("data", (d) => {
          out += d;
          if (/listening on/i.test(out)) cp.kill("SIGTERM");
        });
        cp.on("close", (code) => {
          clearTimeout(timer);
          done({ stderr: err, code });
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("chaos as null fails validation with the finding, not a TypeError", async () => {
    const { stderr, code } = await runCli(null);
    expect(stderr).not.toMatch(/TypeError/);
    expect(stderr).toContain(`Fixture 0: ${NULL_MESSAGE}`);
    expect(code).toBe(1);
  }, 20_000);

  it.each(IGNORED_SHAPES)(
    "chaos as %s does not fail validation",
    async (_label, chaos) => {
      const { stderr, code } = await runCli(chaos);
      expect(stderr).not.toMatch(/TypeError|Validation failed/);
      expect(code).not.toBe(1);
    },
    20_000,
  );
});
