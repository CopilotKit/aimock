import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryToFixture, loadFixtureFile, loadFixturesFromDir } from "../fixture-loader.js";
import type {
  FixtureFileEntry,
  ToolCallResponse,
  TextResponse,
  ContentWithToolCallsResponse,
} from "../types.js";

/* ------------------------------------------------------------------ *
 * vi.mock for node:fs — defaults to the real implementation so that  *
 * every test using real files keeps working.  Individual tests in    *
 * the "fs error paths" describe block override specific functions.   *
 * ------------------------------------------------------------------ */
const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: fsMocks.readFileSync.mockImplementation(actual.readFileSync),
    readdirSync: fsMocks.readdirSync.mockImplementation(actual.readdirSync),
    statSync: fsMocks.statSync.mockImplementation(actual.statSync),
  };
});

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fixture-loader-test-"));
}

function writeJson(dir: string, name: string, content: unknown): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, JSON.stringify(content), "utf-8");
  return filePath;
}

describe("loadFixtureFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    // Restore console spies that individual tests create via vi.spyOn(console, "warn").
    // We cannot use vi.restoreAllMocks() here because the top-level vi.mock("node:fs")
    // overrides would also be wiped, breaking subsequent tests.
    if ("mockRestore" in console.warn) {
      (console.warn as ReturnType<typeof vi.spyOn>).mockRestore();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a single fixture file with a userMessage match", () => {
    const filePath = writeJson(tmpDir, "greeting.json", {
      fixtures: [
        {
          match: { userMessage: "hello" },
          response: { content: "Hello!" },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.userMessage).toBe("hello");
    expect(fixtures[0].response).toEqual({ content: "Hello!" });
  });

  it("loads all match fields correctly", () => {
    const filePath = writeJson(tmpDir, "full-match.json", {
      fixtures: [
        {
          match: { toolCallId: "call_123", toolName: "get_weather", model: "gpt-4" },
          response: { toolCalls: [{ name: "get_weather", arguments: "{}" }] },
          latency: 200,
          chunkSize: 10,
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    const f = fixtures[0];
    expect(f.match.toolCallId).toBe("call_123");
    expect(f.match.toolName).toBe("get_weather");
    expect(f.match.model).toBe("gpt-4");
    expect(f.latency).toBe(200);
    expect(f.chunkSize).toBe(10);
  });

  it("keeps userMessage as a string (no RegExp conversion)", () => {
    const filePath = writeJson(tmpDir, "string-match.json", {
      fixtures: [
        {
          match: { userMessage: "hello world" },
          response: { content: "Hi!" },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(typeof fixtures[0].match.userMessage).toBe("string");
    expect(fixtures[0].match.userMessage).toBe("hello world");
  });

  it("copies endpoint match field from JSON", () => {
    const filePath = writeJson(tmpDir, "endpoint.json", {
      fixtures: [
        {
          match: { inputText: "hello world", endpoint: "embedding" },
          response: { embedding: [0.1, -0.2, 0.3] },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.endpoint).toBe("embedding");
  });

  it("leaves match.endpoint undefined when not present in JSON", () => {
    const filePath = writeJson(tmpDir, "no-endpoint.json", {
      fixtures: [
        {
          match: { userMessage: "hello" },
          response: { content: "Hi!" },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures[0].match.endpoint).toBeUndefined();
  });

  it("loads inputText match field from JSON", () => {
    const filePath = writeJson(tmpDir, "embed.json", {
      fixtures: [
        {
          match: { inputText: "hello world" },
          response: { embedding: [0.1, -0.2, 0.3] },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.inputText).toBe("hello world");
  });

  it("loads responseFormat match field from JSON", () => {
    const filePath = writeJson(tmpDir, "json-mode.json", {
      fixtures: [
        {
          match: { userMessage: "give json", responseFormat: "json_object" },
          response: { content: '{"key":"value"}' },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.responseFormat).toBe("json_object");
  });

  it("omits latency and chunkSize when not present in JSON", () => {
    const filePath = writeJson(tmpDir, "no-optional.json", {
      fixtures: [
        {
          match: { userMessage: "hi" },
          response: { content: "hey" },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures[0].latency).toBeUndefined();
    expect(fixtures[0].chunkSize).toBeUndefined();
  });

  it("passes through truncateAfterChunks when set", () => {
    const filePath = writeJson(tmpDir, "truncate.json", {
      fixtures: [
        {
          match: { userMessage: "truncate me" },
          response: { content: "partial" },
          truncateAfterChunks: 3,
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].truncateAfterChunks).toBe(3);
  });

  it("passes through disconnectAfterMs when set", () => {
    const filePath = writeJson(tmpDir, "disconnect.json", {
      fixtures: [
        {
          match: { userMessage: "disconnect me" },
          response: { content: "partial" },
          disconnectAfterMs: 500,
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].disconnectAfterMs).toBe(500);
  });

  it("passes through both truncateAfterChunks and disconnectAfterMs together", () => {
    const filePath = writeJson(tmpDir, "both-interruptions.json", {
      fixtures: [
        {
          match: { userMessage: "both" },
          response: { content: "partial" },
          truncateAfterChunks: 5,
          disconnectAfterMs: 1000,
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].truncateAfterChunks).toBe(5);
    expect(fixtures[0].disconnectAfterMs).toBe(1000);
  });

  it("streamingProfile passthrough from JSON", () => {
    const filePath = writeJson(tmpDir, "streaming-profile.json", {
      fixtures: [
        {
          match: { userMessage: "profile" },
          response: { content: "Hello!" },
          streamingProfile: { ttft: 50, tps: 100, jitter: 0.1 },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].streamingProfile).toEqual({ ttft: 50, tps: 100, jitter: 0.1 });
  });

  it("chaos config passthrough from JSON", () => {
    const filePath = writeJson(tmpDir, "chaos.json", {
      fixtures: [
        {
          match: { userMessage: "chaos" },
          response: { content: "Hello!" },
          chaos: { dropRate: 0.5 },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].chaos).toEqual({ dropRate: 0.5 });
  });

  it("passes through sequenceIndex from JSON fixtures", () => {
    const filePath = writeJson(tmpDir, "sequence.json", {
      fixtures: [
        {
          match: { userMessage: "plan", sequenceIndex: 0 },
          response: { content: "Step 1" },
        },
        {
          match: { userMessage: "plan", sequenceIndex: 1 },
          response: { content: "Step 2" },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0].match.sequenceIndex).toBe(0);
    expect(fixtures[1].match.sequenceIndex).toBe(1);
  });

  it("omits sequenceIndex when not present in JSON", () => {
    const filePath = writeJson(tmpDir, "no-sequence.json", {
      fixtures: [
        {
          match: { userMessage: "hello" },
          response: { content: "Hi!" },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures[0].match.sequenceIndex).toBeUndefined();
  });

  it("omits truncateAfterChunks and disconnectAfterMs when not present in JSON", () => {
    const filePath = writeJson(tmpDir, "no-interruptions.json", {
      fixtures: [
        {
          match: { userMessage: "plain" },
          response: { content: "complete" },
        },
      ],
    });

    const fixtures = loadFixtureFile(filePath);
    expect(fixtures[0].truncateAfterChunks).toBeUndefined();
    expect(fixtures[0].disconnectAfterMs).toBeUndefined();
  });

  it("warns and returns empty array for invalid JSON", () => {
    const filePath = join(tmpDir, "bad.json");
    writeFileSync(filePath, "{ not valid json", "utf-8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"), expect.anything());
    warn.mockRestore();
  });

  it("warns and returns empty array when fixtures key is missing", () => {
    const filePath = writeJson(tmpDir, "no-fixtures.json", { something: [] });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fixtures"));
    warn.mockRestore();
  });

  it("warns and returns empty array when fixtures is not an array", () => {
    const filePath = writeJson(tmpDir, "bad-fixtures.json", { fixtures: "oops" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixtures = loadFixtureFile(filePath);
    expect(fixtures).toHaveLength(0);
    warn.mockRestore();
  });

  it("warns and returns empty array for a non-existent file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixtures = loadFixtureFile(join(tmpDir, "does-not-exist.json"));
    expect(fixtures).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read file"),
      expect.anything(),
    );
    warn.mockRestore();
  });
});

describe("loadFixturesFromDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    // Restore console spies that individual tests create via vi.spyOn(console, "warn").
    // We cannot use vi.restoreAllMocks() here because the top-level vi.mock("node:fs")
    // overrides would also be wiped, breaking subsequent tests.
    if ("mockRestore" in console.warn) {
      (console.warn as ReturnType<typeof vi.spyOn>).mockRestore();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads multiple files and concatenates fixtures in alphabetical file order", () => {
    writeJson(tmpDir, "b-second.json", {
      fixtures: [{ match: { userMessage: "b" }, response: { content: "B" } }],
    });
    writeJson(tmpDir, "a-first.json", {
      fixtures: [{ match: { userMessage: "a" }, response: { content: "A" } }],
    });

    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0].match.userMessage).toBe("a");
    expect(fixtures[1].match.userMessage).toBe("b");
  });

  it("returns all fixtures from multiple entries in one file", () => {
    writeJson(tmpDir, "multi.json", {
      fixtures: [
        { match: { userMessage: "one" }, response: { content: "1" } },
        { match: { userMessage: "two" }, response: { content: "2" } },
        { match: { userMessage: "three" }, response: { content: "3" } },
      ],
    });

    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(3);
  });

  it("skips invalid JSON files with a warning, still loads valid ones", () => {
    writeJson(tmpDir, "a-valid.json", {
      fixtures: [{ match: { userMessage: "ok" }, response: { content: "yes" } }],
    });
    writeFileSync(join(tmpDir, "b-invalid.json"), "{ bad json", "utf-8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"), expect.anything());
    warn.mockRestore();
  });

  it("skips files without a fixtures array, still loads valid ones", () => {
    writeJson(tmpDir, "a-bad.json", { notFixtures: true });
    writeJson(tmpDir, "b-good.json", {
      fixtures: [{ match: { userMessage: "hi" }, response: { content: "hey" } }],
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.userMessage).toBe("hi");
    warn.mockRestore();
  });

  it("ignores non-.json files", () => {
    writeFileSync(join(tmpDir, "readme.txt"), "ignore me", "utf-8");
    writeFileSync(join(tmpDir, "notes.md"), "# ignore", "utf-8");
    writeJson(tmpDir, "actual.json", {
      fixtures: [{ match: { userMessage: "real" }, response: { content: "yes" } }],
    });

    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(1);
  });

  it("returns empty array for an empty directory", () => {
    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(0);
  });

  it("returns empty array and warns for a non-existent directory", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixtures = loadFixturesFromDir(join(tmpDir, "does-not-exist"));
    expect(fixtures).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read directory"),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("loads fixtures from a nested subdirectory when given that path directly", () => {
    const subDir = join(tmpDir, "sub");
    mkdirSync(subDir);
    writeJson(subDir, "fixtures.json", {
      fixtures: [{ match: { userMessage: "nested" }, response: { content: "found" } }],
    });

    const fixtures = loadFixturesFromDir(subDir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.userMessage).toBe("nested");
  });

  it("recurses one level into subdirectories (snapshot-style layout)", () => {
    writeJson(tmpDir, "a-valid.json", {
      fixtures: [{ match: { userMessage: "top" }, response: { content: "yes" } }],
    });
    const subDir = join(tmpDir, "greeting--hello-world");
    mkdirSync(subDir);
    writeJson(subDir, "openai.json", {
      fixtures: [{ match: { userMessage: "deep" }, response: { content: "found" } }],
    });

    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0].match.userMessage).toBe("top");
    expect(fixtures[1].match.userMessage).toBe("deep");
  });

  it("loads multiple provider files from one snapshot subdirectory", () => {
    const subDir = join(tmpDir, "test-greeting");
    mkdirSync(subDir);
    writeJson(subDir, "anthropic.json", {
      fixtures: [{ match: { userMessage: "hi anthropic" }, response: { content: "A" } }],
    });
    writeJson(subDir, "openai.json", {
      fixtures: [{ match: { userMessage: "hi openai" }, response: { content: "O" } }],
    });

    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(2);
    // Alphabetical order within subdirectory
    expect(fixtures[0].match.userMessage).toBe("hi anthropic");
    expect(fixtures[1].match.userMessage).toBe("hi openai");
  });

  it("loads fixtures from multiple snapshot subdirectories in alphabetical order", () => {
    const subA = join(tmpDir, "a-test");
    const subB = join(tmpDir, "b-test");
    mkdirSync(subA);
    mkdirSync(subB);
    writeJson(subA, "openai.json", {
      fixtures: [{ match: { userMessage: "a" }, response: { content: "A" } }],
    });
    writeJson(subB, "openai.json", {
      fixtures: [{ match: { userMessage: "b" }, response: { content: "B" } }],
    });

    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0].match.userMessage).toBe("a");
    expect(fixtures[1].match.userMessage).toBe("b");
  });

  it("does not recurse deeper than one level", () => {
    const subDir = join(tmpDir, "level1");
    const deepDir = join(subDir, "level2");
    mkdirSync(subDir);
    mkdirSync(deepDir);
    writeJson(subDir, "openai.json", {
      fixtures: [{ match: { userMessage: "one" }, response: { content: "1" } }],
    });
    writeJson(deepDir, "openai.json", {
      fixtures: [{ match: { userMessage: "two" }, response: { content: "2" } }],
    });

    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.userMessage).toBe("one");
  });

  it("top-level JSON files come before subdirectory fixtures", () => {
    writeJson(tmpDir, "z-top.json", {
      fixtures: [{ match: { userMessage: "top" }, response: { content: "T" } }],
    });
    const subDir = join(tmpDir, "a-sub");
    mkdirSync(subDir);
    writeJson(subDir, "openai.json", {
      fixtures: [{ match: { userMessage: "sub" }, response: { content: "S" } }],
    });

    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(2);
    // Top-level files load first (regardless of sort order vs subdirectory names)
    expect(fixtures[0].match.userMessage).toBe("top");
    expect(fixtures[1].match.userMessage).toBe("sub");
  });

  it("ignores non-.json files inside subdirectories", () => {
    const subDir = join(tmpDir, "test-sub");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "readme.txt"), "ignore me", "utf-8");
    writeJson(subDir, "openai.json", {
      fixtures: [{ match: { userMessage: "real" }, response: { content: "yes" } }],
    });

    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.userMessage).toBe("real");
  });
});

/* ------------------------------------------------------------------ *
 * fs error paths (uses the vi.mock overrides declared at top level)  *
 * ------------------------------------------------------------------ */
describe("fixture-loader fs error paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loadFixtureFile warns and returns empty when readFileSync throws EACCES", () => {
    fsMocks.readFileSync.mockImplementation(() => {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = loadFixtureFile("/some/protected-file.json");
    expect(result).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read file"),
      expect.anything(),
    );
  });

  it("loadFixturesFromDir silently skips a file when statSync throws ENOENT", () => {
    fsMocks.readdirSync.mockReturnValue(["a.json", "vanished.json", "b.json"]);
    fsMocks.statSync.mockImplementation((p: unknown) => {
      if (String(p).includes("vanished.json")) {
        const err = new Error("no such file") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return { isDirectory: () => false };
    });
    fsMocks.readFileSync.mockImplementation((p: unknown) => {
      return JSON.stringify({
        fixtures: [{ match: { userMessage: String(p) }, response: { content: "ok" } }],
      });
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = loadFixturesFromDir("/fake/dir");

    // vanished.json is silently skipped (ENOENT is not warned about per the source)
    expect(result).toHaveLength(2);

    const statWarns = warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("Could not stat"),
    );
    expect(statWarns).toHaveLength(0);
  });

  it("loadFixturesFromDir warns when statSync throws a non-ENOENT error (e.g. EACCES)", () => {
    fsMocks.readdirSync.mockReturnValue(["ok.json", "noperm.json"]);
    fsMocks.statSync.mockImplementation((p: unknown) => {
      if (String(p).includes("noperm.json")) {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return { isDirectory: () => false };
    });
    fsMocks.readFileSync.mockImplementation(() => {
      return JSON.stringify({
        fixtures: [{ match: { userMessage: "x" }, response: { content: "y" } }],
      });
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = loadFixturesFromDir("/fake/dir");

    // noperm.json is skipped but a warning IS emitted for non-ENOENT errors
    expect(result).toHaveLength(1);

    const statWarns = warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("Could not stat"),
    );
    expect(statWarns).toHaveLength(1);
    expect(statWarns[0][0]).toContain("noperm.json");
  });
});

// ---------------------------------------------------------------------------
// validateFixtures
// ---------------------------------------------------------------------------

import { validateFixtures } from "../fixture-loader.js";
import type { Fixture } from "../types.js";

function makeFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    match: { userMessage: "test" },
    response: { content: "Hello" },
    ...overrides,
  };
}

describe("validateFixtures", () => {
  it("returns no results for valid fixtures", () => {
    const fixtures = [
      makeFixture({ match: { userMessage: "hello" } }),
      makeFixture({
        match: { userMessage: "weather" },
        response: { toolCalls: [{ name: "fn", arguments: "{}" }] },
      }),
      makeFixture({
        match: { userMessage: "error" },
        response: { error: { message: "err", type: "e" }, status: 500 },
      }),
    ];
    expect(validateFixtures(fixtures)).toEqual([]);
  });

  // --- Error checks ---

  it("error: unrecognized response type", () => {
    const fixtures = [makeFixture({ response: { foo: "bar" } as never })];
    const results = validateFixtures(fixtures);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("error");
    expect(results[0].message).toContain("not a recognized type");
  });

  it("error: empty content string", () => {
    const fixtures = [makeFixture({ response: { content: "" } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("empty string"))).toBe(
      true,
    );
  });

  it("warning: empty toolCalls array", () => {
    const fixtures = [makeFixture({ response: { toolCalls: [] } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "warning" && r.message.includes("empty"))).toBe(true);
  });

  it("error: toolCalls with empty name", () => {
    const fixtures = [makeFixture({ response: { toolCalls: [{ name: "", arguments: "{}" }] } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("name is empty"))).toBe(
      true,
    );
  });

  it("error: toolCalls with invalid JSON arguments", () => {
    const fixtures = [
      makeFixture({ response: { toolCalls: [{ name: "fn", arguments: "not json" }] } }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("not valid JSON")),
    ).toBe(true);
  });

  it("error: error response with empty message", () => {
    const fixtures = [
      makeFixture({ response: { error: { message: "", type: "e" }, status: 500 } }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("error.message is empty")),
    ).toBe(true);
  });

  it("error: error response with invalid status code", () => {
    const fixtures = [
      makeFixture({ response: { error: { message: "err", type: "e" }, status: 999 } }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("not a valid HTTP status")),
    ).toBe(true);
  });

  it("accepts status code at lower boundary (100)", () => {
    const fixtures = [
      makeFixture({ response: { error: { message: "err", type: "e" }, status: 100 } }),
    ];
    const results = validateFixtures(fixtures);
    const statusErrors = results.filter(
      (r) => r.severity === "error" && r.message.includes("not a valid HTTP status"),
    );
    expect(statusErrors).toHaveLength(0);
  });

  it("rejects status code below lower boundary (99)", () => {
    const fixtures = [
      makeFixture({ response: { error: { message: "err", type: "e" }, status: 99 } }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("not a valid HTTP status")),
    ).toBe(true);
  });

  it("accepts status code at upper boundary (599)", () => {
    const fixtures = [
      makeFixture({ response: { error: { message: "err", type: "e" }, status: 599 } }),
    ];
    const results = validateFixtures(fixtures);
    const statusErrors = results.filter(
      (r) => r.severity === "error" && r.message.includes("not a valid HTTP status"),
    );
    expect(statusErrors).toHaveLength(0);
  });

  it("error status accepted when omitted (defaults to 500 at runtime)", () => {
    const fixtures = [makeFixture({ response: { error: { message: "err", type: "e" } } })];
    const results = validateFixtures(fixtures);
    const statusErrors = results.filter(
      (r) => r.severity === "error" && r.message.includes("not a valid HTTP status"),
    );
    expect(statusErrors).toHaveLength(0);
  });

  it("error: negative latency", () => {
    const fixtures = [makeFixture({ latency: -1 })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("latency"))).toBe(true);
  });

  it("error: chunkSize < 1", () => {
    const fixtures = [makeFixture({ chunkSize: 0 })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("chunkSize"))).toBe(
      true,
    );
  });

  it("error: truncateAfterChunks < 1", () => {
    const fixtures = [makeFixture({ truncateAfterChunks: 0 })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("truncateAfterChunks")),
    ).toBe(true);
  });

  it("error: negative disconnectAfterMs", () => {
    const fixtures = [makeFixture({ disconnectAfterMs: -1 })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("disconnectAfterMs")),
    ).toBe(true);
  });

  it("error: streamingProfile.ttft is negative", () => {
    const fixtures = [makeFixture({ streamingProfile: { ttft: -1 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("ttft"))).toBe(true);
  });

  it("no error: streamingProfile.ttft is 0", () => {
    const fixtures = [makeFixture({ streamingProfile: { ttft: 0 } })];
    const results = validateFixtures(fixtures);
    expect(results.filter((r) => r.message.includes("ttft"))).toHaveLength(0);
  });

  it("error: streamingProfile.tps is 0", () => {
    const fixtures = [makeFixture({ streamingProfile: { tps: 0 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("tps"))).toBe(true);
  });

  it("error: streamingProfile.tps is negative", () => {
    const fixtures = [makeFixture({ streamingProfile: { tps: -5 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("tps"))).toBe(true);
  });

  it("error: streamingProfile.jitter is negative", () => {
    const fixtures = [makeFixture({ streamingProfile: { jitter: -0.1 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("jitter"))).toBe(true);
  });

  it("error: streamingProfile.jitter is > 1", () => {
    const fixtures = [makeFixture({ streamingProfile: { jitter: 1.5 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("jitter"))).toBe(true);
  });

  it("no error: streamingProfile with valid values", () => {
    const fixtures = [makeFixture({ streamingProfile: { ttft: 100, tps: 50, jitter: 0.1 } })];
    expect(validateFixtures(fixtures)).toHaveLength(0);
  });

  it("error: chaos.dropRate is > 1", () => {
    const fixtures = [makeFixture({ chaos: { dropRate: 1.5 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("dropRate"))).toBe(
      true,
    );
  });

  it("error: chaos.dropRate is negative", () => {
    const fixtures = [makeFixture({ chaos: { dropRate: -0.1 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("dropRate"))).toBe(
      true,
    );
  });

  it("error: chaos.malformedRate is > 1", () => {
    const fixtures = [makeFixture({ chaos: { malformedRate: 2.0 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("malformedRate"))).toBe(
      true,
    );
  });

  it("error: chaos.disconnectRate is > 1", () => {
    const fixtures = [makeFixture({ chaos: { disconnectRate: 5.0 } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("disconnectRate")),
    ).toBe(true);
  });

  it("no error: chaos with boundary values (0 and 1)", () => {
    const fixtures = [
      makeFixture({ chaos: { dropRate: 0, malformedRate: 1, disconnectRate: 0.5 } }),
    ];
    expect(validateFixtures(fixtures)).toHaveLength(0);
  });

  // --- match.turnIndex / match.hasToolResult type checks ---

  it("error: turnIndex is negative", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", turnIndex: -1 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("turnIndex"))).toBe(
      true,
    );
  });

  it("error: turnIndex is a float", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", turnIndex: 1.5 } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("turnIndex"))).toBe(
      true,
    );
  });

  it("error: turnIndex is a string", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", turnIndex: "zero" as never } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("turnIndex"))).toBe(
      true,
    );
  });

  it("no error: turnIndex is 0 (falsy but valid)", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", turnIndex: 0 } })];
    const results = validateFixtures(fixtures);
    expect(results.filter((r) => r.message.includes("turnIndex"))).toHaveLength(0);
  });

  it("no error: turnIndex is a positive integer", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", turnIndex: 3 } })];
    const results = validateFixtures(fixtures);
    expect(results.filter((r) => r.message.includes("turnIndex"))).toHaveLength(0);
  });

  it("error: hasToolResult is a string", () => {
    const fixtures = [
      makeFixture({ match: { userMessage: "test", hasToolResult: "yes" as never } }),
    ];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("hasToolResult"))).toBe(
      true,
    );
  });

  it("no error: hasToolResult is false (falsy but valid)", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", hasToolResult: false } })];
    const results = validateFixtures(fixtures);
    expect(results.filter((r) => r.message.includes("hasToolResult"))).toHaveLength(0);
  });

  it("no error: hasToolResult is true", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", hasToolResult: true } })];
    const results = validateFixtures(fixtures);
    expect(results.filter((r) => r.message.includes("hasToolResult"))).toHaveLength(0);
  });

  // --- match.systemMessage type checks ---

  it("error: systemMessage is a number", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", systemMessage: 42 as never } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("systemMessage"))).toBe(
      true,
    );
  });

  it("no error: systemMessage is a string", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", systemMessage: "Atai" } })];
    const results = validateFixtures(fixtures);
    expect(results.filter((r) => r.message.includes("systemMessage"))).toHaveLength(0);
  });

  it("no error: systemMessage is a non-empty array of strings", () => {
    const fixtures = [
      makeFixture({ match: { userMessage: "test", systemMessage: ["Atai", "PST"] } }),
    ];
    const results = validateFixtures(fixtures);
    expect(results.filter((r) => r.message.includes("systemMessage"))).toHaveLength(0);
  });

  it("error: systemMessage is an empty array", () => {
    const fixtures = [makeFixture({ match: { userMessage: "test", systemMessage: [] as never } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) =>
          r.severity === "error" &&
          r.message.includes("systemMessage") &&
          r.message.includes("at least one"),
      ),
    ).toBe(true);
  });

  it("error: systemMessage array contains a non-string element", () => {
    const fixtures = [
      makeFixture({
        match: { userMessage: "test", systemMessage: ["ok", 42 as never] },
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) =>
          r.severity === "error" &&
          r.message.includes("systemMessage[1]") &&
          r.message.includes("must be a string"),
      ),
    ).toBe(true);
  });

  // --- Warning checks ---

  it("warning: duplicate userMessage", () => {
    const fixtures = [
      makeFixture({ match: { userMessage: "hello" } }),
      makeFixture({ match: { userMessage: "hello" } }),
    ];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "warning" && r.message.includes("duplicate"))).toBe(
      true,
    );
  });

  it("no warning: same userMessage but different turnIndex", () => {
    const fixtures = [
      makeFixture({ match: { userMessage: "hello", turnIndex: 0 } }),
      makeFixture({ match: { userMessage: "hello", turnIndex: 1 } }),
    ];
    const results = validateFixtures(fixtures);
    const duplicateWarnings = results.filter(
      (r) => r.severity === "warning" && r.message.includes("duplicate"),
    );
    expect(duplicateWarnings).toHaveLength(0);
  });

  it("no warning: same userMessage but different hasToolResult", () => {
    const fixtures = [
      makeFixture({ match: { userMessage: "hello", hasToolResult: false } }),
      makeFixture({ match: { userMessage: "hello", hasToolResult: true } }),
    ];
    const results = validateFixtures(fixtures);
    const duplicateWarnings = results.filter(
      (r) => r.severity === "warning" && r.message.includes("duplicate"),
    );
    expect(duplicateWarnings).toHaveLength(0);
  });

  it("no warning: same userMessage but different sequenceIndex", () => {
    const fixtures = [
      makeFixture({ match: { userMessage: "hello", sequenceIndex: 0 } }),
      makeFixture({ match: { userMessage: "hello", sequenceIndex: 1 } }),
    ];
    const results = validateFixtures(fixtures);
    const duplicateWarnings = results.filter(
      (r) => r.severity === "warning" && r.message.includes("duplicate"),
    );
    expect(duplicateWarnings).toHaveLength(0);
  });

  it("warning: same userMessage with identical turnIndex/hasToolResult/sequenceIndex", () => {
    const fixtures = [
      makeFixture({ match: { userMessage: "hello", turnIndex: 1, hasToolResult: true } }),
      makeFixture({ match: { userMessage: "hello", turnIndex: 1, hasToolResult: true } }),
    ];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "warning" && r.message.includes("duplicate"))).toBe(
      true,
    );
  });

  it("warning: catch-all not in last position", () => {
    const fixtures = [makeFixture({ match: {} }), makeFixture({ match: { userMessage: "hello" } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "warning" && r.message.includes("catch-all"))).toBe(
      true,
    );
  });

  it("no warning for catch-all in last position", () => {
    const fixtures = [makeFixture({ match: { userMessage: "hello" } }), makeFixture({ match: {} })];
    const results = validateFixtures(fixtures);
    const catchAllWarnings = results.filter(
      (r) => r.severity === "warning" && r.message.includes("catch-all"),
    );
    expect(catchAllWarnings).toHaveLength(0);
  });

  it("reports both errors and warnings together", () => {
    const fixtures = [
      makeFixture({ match: {}, response: { content: "" } }), // catch-all + empty content
      makeFixture({ match: { userMessage: "hello" } }),
    ];
    const results = validateFixtures(fixtures);
    const errors = results.filter((r) => r.severity === "error");
    const warnings = results.filter((r) => r.severity === "warning");
    expect(errors.length).toBeGreaterThan(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  // --- Embedding response checks ---

  it("returns no results for a valid embedding fixture", () => {
    const fixtures = [
      makeFixture({
        match: { inputText: "hello" },
        response: { embedding: [0.1, -0.2, 0.3] },
      }),
    ];
    expect(validateFixtures(fixtures)).toEqual([]);
  });

  it("error: empty embedding array", () => {
    const fixtures = [
      makeFixture({
        match: { inputText: "hello" },
        response: { embedding: [] },
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("embedding array is empty")),
    ).toBe(true);
  });

  it("error: non-number embedding elements", () => {
    const fixtures = [
      makeFixture({
        match: { inputText: "hello" },
        response: { embedding: [0.1, "bad" as unknown as number, 0.3] },
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("not a number"))).toBe(
      true,
    );
  });

  it("error: reasoning is not a string", () => {
    const fixtures = [makeFixture({ response: { content: "hi", reasoning: 123 } as never })];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) => r.severity === "error" && r.message.includes("reasoning must be a string"),
      ),
    ).toBe(true);
  });

  it("warning: reasoning is empty string", () => {
    const fixtures = [makeFixture({ response: { content: "hi", reasoning: "" } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "warning" && r.message.includes("reasoning is empty")),
    ).toBe(true);
  });

  it("error: webSearches is not an array", () => {
    const fixtures = [
      makeFixture({ response: { content: "hi", webSearches: "not-array" } as never }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) => r.severity === "error" && r.message.includes("webSearches must be an array"),
      ),
    ).toBe(true);
  });

  it("error: webSearches element is not a string", () => {
    const fixtures = [
      makeFixture({ response: { content: "hi", webSearches: ["valid", 42] } as never }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) => r.severity === "error" && r.message.includes("webSearches[1] is not a string"),
      ),
    ).toBe(true);
  });

  it("accepts valid reasoning and webSearches", () => {
    const fixtures = [
      makeFixture({
        response: { content: "hi", reasoning: "thinking...", webSearches: ["query1", "query2"] },
      }),
    ];
    expect(validateFixtures(fixtures)).toEqual([]);
  });

  it("warning: webSearches is empty array", () => {
    const fixtures = [makeFixture({ response: { content: "hi", webSearches: [] } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) => r.severity === "warning" && r.message.includes("webSearches is empty array"),
      ),
    ).toBe(true);
  });

  it("warning: webSearches element is empty string", () => {
    const fixtures = [makeFixture({ response: { content: "hi", webSearches: ["valid", ""] } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) => r.severity === "warning" && r.message.includes("webSearches[1] is empty string"),
      ),
    ).toBe(true);
  });

  // --- ResponseOverrides validation ---

  it("error: created as a string", () => {
    const fixtures = [makeFixture({ response: { content: "hi", created: "2024-01-01" as never } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes('override "created"')),
    ).toBe(true);
  });

  it("error: usage as a string", () => {
    const fixtures = [makeFixture({ response: { content: "hi", usage: "bad" as never } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes('override "usage"')),
    ).toBe(true);
  });

  it("error: usage with non-numeric field", () => {
    const fixtures = [
      makeFixture({
        response: { content: "hi", usage: { prompt_tokens: "ten" as never } },
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) => r.severity === "error" && r.message.includes('override "usage.prompt_tokens"'),
      ),
    ).toBe(true);
  });

  it("error: finishReason as a number", () => {
    const fixtures = [makeFixture({ response: { content: "hi", finishReason: 42 as never } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes('override "finishReason"')),
    ).toBe(true);
  });

  it("rejects non-string id", () => {
    const fixtures = [makeFixture({ response: { content: "hi", id: 123 as never } })];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes('override "id"'))).toBe(
      true,
    );
  });

  it("rejects non-string model", () => {
    const fixtures = [makeFixture({ response: { content: "hi", model: true as never } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes('override "model"')),
    ).toBe(true);
  });

  it("rejects non-string role", () => {
    const fixtures = [makeFixture({ response: { content: "hi", role: 42 as never } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes('override "role"')),
    ).toBe(true);
  });

  it("rejects non-string systemFingerprint", () => {
    const fixtures = [
      makeFixture({ response: { content: "hi", systemFingerprint: null as never } }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) => r.severity === "error" && r.message.includes('override "systemFingerprint"'),
      ),
    ).toBe(true);
  });

  it("rejects negative created", () => {
    const fixtures = [makeFixture({ response: { content: "hi", created: -1 } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes('override "created"')),
    ).toBe(true);
  });

  it("rejects usage as array", () => {
    const fixtures = [makeFixture({ response: { content: "hi", usage: [1, 2, 3] as never } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes('override "usage"')),
    ).toBe(true);
  });

  it("rejects usage as null", () => {
    const fixtures = [makeFixture({ response: { content: "hi", usage: null as never } })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes('override "usage"')),
    ).toBe(true);
  });

  it("warns about unknown fields on response", () => {
    // A response with only a typo field like "finishreason" (no content/toolCalls/error)
    // is not recognized as any valid type
    const fixtures = [makeFixture({ response: { finishreason: "stop" } as never })];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("not a recognized type")),
    ).toBe(true);
  });

  it("warns about unknown fields on ContentWithToolCallsResponse", () => {
    // A CWTC with an extra typo field still validates the known parts
    const fixtures = [
      makeFixture({
        response: {
          content: "hi",
          toolCalls: [{ name: "fn", arguments: "{}" }],
          finishreason: "stop",
        } as never,
      }),
    ];
    const results = validateFixtures(fixtures);
    // No error — the CWTC is valid; extra fields are silently ignored
    const errors = results.filter((r) => r.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("warns on empty content in ContentWithToolCallsResponse", () => {
    // CWTC with empty content triggers the TextResponse empty-content error
    // since isTextResponse also matches
    const fixtures = [
      makeFixture({
        response: {
          content: "",
          toolCalls: [{ name: "fn", arguments: "{}" }],
        },
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("empty"))).toBe(true);
  });

  it("rejects empty toolCalls in ContentWithToolCallsResponse", () => {
    const fixtures = [
      makeFixture({
        response: {
          content: "hi",
          toolCalls: [],
        },
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.message.includes("empty"))).toBe(true);
  });

  it("rejects missing tool name in ContentWithToolCallsResponse", () => {
    const fixtures = [
      makeFixture({
        response: {
          content: "hi",
          toolCalls: [{ name: "", arguments: "{}" }],
        },
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes("name is empty"))).toBe(
      true,
    );
  });

  it("rejects invalid JSON arguments in ContentWithToolCallsResponse", () => {
    const fixtures = [
      makeFixture({
        response: {
          content: "hi",
          toolCalls: [{ name: "fn", arguments: "not json" }],
        },
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some((r) => r.severity === "error" && r.message.includes("not valid JSON")),
    ).toBe(true);
  });

  it("rejects non-string reasoning in ContentWithToolCallsResponse", () => {
    const fixtures = [
      makeFixture({
        response: {
          content: "hi",
          toolCalls: [{ name: "fn", arguments: "{}" }],
          reasoning: 123,
        } as never,
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) => r.severity === "error" && r.message.includes("reasoning must be a string"),
      ),
    ).toBe(true);
  });

  it("rejects non-array webSearches in ContentWithToolCallsResponse", () => {
    const fixtures = [
      makeFixture({
        response: {
          content: "hi",
          toolCalls: [{ name: "fn", arguments: "{}" }],
          webSearches: "not-array",
        } as never,
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(
      results.some(
        (r) => r.severity === "error" && r.message.includes("webSearches must be an array"),
      ),
    ).toBe(true);
  });

  it("warns about unknown usage fields", () => {
    // Usage with a typo field — all fields are validated as numbers, and promt_tokens
    // is treated as a number field (just an unfamiliar name, still accepted if numeric)
    const fixtures = [
      makeFixture({
        response: { content: "hi", usage: { promt_tokens: 10 } as never },
      }),
    ];
    const results = validateFixtures(fixtures);
    // No error — unknown numeric fields in usage are silently accepted
    const usageErrors = results.filter(
      (r) => r.severity === "error" && r.message.includes("promt_tokens"),
    );
    expect(usageErrors).toHaveLength(0);
  });

  it("rejects non-string id on ToolCallResponse", () => {
    const fixtures = [
      makeFixture({
        response: {
          toolCalls: [{ name: "fn", arguments: "{}" }],
          id: 123,
        } as never,
      }),
    ];
    const results = validateFixtures(fixtures);
    expect(results.some((r) => r.severity === "error" && r.message.includes('override "id"'))).toBe(
      true,
    );
  });

  it("warns about unknown fields on ToolCallResponse", () => {
    // ToolCallResponse with extra typo field — silently ignored since toolCalls is valid
    const fixtures = [
      makeFixture({
        response: {
          toolCalls: [{ name: "fn", arguments: "{}" }],
          finishreason: "tool_calls",
        } as never,
      }),
    ];
    const results = validateFixtures(fixtures);
    // No error — the ToolCallResponse is valid; extra fields are silently ignored
    const errors = results.filter((r) => r.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("accepts valid overrides without errors", () => {
    const fixtures = [
      makeFixture({
        response: {
          content: "hi",
          id: "chatcmpl-123",
          created: 1700000000,
          model: "gpt-4",
          finishReason: "stop",
          role: "assistant",
          systemFingerprint: "fp_abc",
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
      }),
    ];
    const results = validateFixtures(fixtures);
    // No override-related errors
    const overrideErrors = results.filter(
      (r) => r.severity === "error" && r.message.includes("override"),
    );
    expect(overrideErrors).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 *  Auto-stringify: object arguments / content in fixture files        *
 * ------------------------------------------------------------------ */

describe("auto-stringify JSON objects in fixture entries", () => {
  it("stringifies object arguments in toolCalls", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: { city: "SF", temp: 72 } }],
      },
    };
    const fixture = entryToFixture(entry);
    const tc = (fixture.response as ToolCallResponse).toolCalls[0];
    expect(tc.arguments).toBe('{"city":"SF","temp":72}');
  });

  it("leaves string arguments unchanged (backward compat)", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
      },
    };
    const fixture = entryToFixture(entry);
    const tc = (fixture.response as ToolCallResponse).toolCalls[0];
    expect(tc.arguments).toBe('{"city":"SF"}');
  });

  it("stringifies object content (structured output)", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: {
        content: { result: "success", score: 42 },
      },
    };
    const fixture = entryToFixture(entry);
    expect((fixture.response as TextResponse).content).toBe('{"result":"success","score":42}');
  });

  it("leaves string content unchanged", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: { content: "Hello, world!" },
    };
    const fixture = entryToFixture(entry);
    expect((fixture.response as TextResponse).content).toBe("Hello, world!");
  });

  it("passes systemMessage through entryToFixture", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test", systemMessage: "name=Atai" },
      response: { content: "ok" },
    };
    const fixture = entryToFixture(entry);
    expect(fixture.match.systemMessage).toBe("name=Atai");
  });

  it("stringifies nested objects in arguments", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: {
        toolCalls: [
          {
            name: "complex_call",
            arguments: { outer: { inner: [1, 2, 3] }, flag: true },
          },
        ],
      },
    };
    const fixture = entryToFixture(entry);
    const tc = (fixture.response as ToolCallResponse).toolCalls[0];
    expect(tc.arguments).toBe('{"outer":{"inner":[1,2,3]},"flag":true}');
  });

  it("handles content + toolCalls response with both object fields", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: {
        content: { summary: "done" },
        toolCalls: [{ name: "save", arguments: { id: 1 } }],
      },
    };
    const fixture = entryToFixture(entry);
    const resp = fixture.response as ContentWithToolCallsResponse;
    expect(resp.content).toBe('{"summary":"done"}');
    expect(resp.toolCalls[0].arguments).toBe('{"id":1}');
  });

  it("preserves ResponseOverrides fields through normalization", () => {
    const entry = {
      match: { userMessage: "test" },
      response: {
        content: { key: "value" },
        id: "custom-id",
        model: "custom-model",
        created: 1234567890,
        finishReason: "stop",
        role: "assistant",
        systemFingerprint: "fp-123",
        usage: { prompt_tokens: 10 },
      },
    };
    const fixture = entryToFixture(entry as unknown as FixtureFileEntry);
    const r = fixture.response as Record<string, unknown>;
    expect(r.content).toBe('{"key":"value"}'); // stringified
    expect(r.id).toBe("custom-id");
    expect(r.model).toBe("custom-model");
    expect(r.created).toBe(1234567890);
    expect(r.finishReason).toBe("stop");
    expect(r.role).toBe("assistant");
    expect(r.systemFingerprint).toBe("fp-123");
    expect(r.usage).toEqual({ prompt_tokens: 10 });
  });

  it("stringifies array content", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: { content: [1, 2, 3] as never },
    };
    const fixture = entryToFixture(entry);
    expect((fixture.response as TextResponse).content).toBe("[1,2,3]");
  });

  it("passes null content through unchanged", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: { content: null as never },
    };
    const fixture = entryToFixture(entry);
    expect((fixture.response as TextResponse).content).toBeNull();
  });

  it("stringifies array arguments in toolCalls", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: {
        toolCalls: [{ name: "fn", arguments: [1, 2] as never }],
      },
    };
    const fixture = entryToFixture(entry);
    const tc = (fixture.response as ToolCallResponse).toolCalls[0];
    expect(tc.arguments).toBe("[1,2]");
  });

  it("null arguments pass through unchanged", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: {
        toolCalls: [{ name: "fn", arguments: null as never }],
      },
    };
    const fixture = entryToFixture(entry);
    const tc = (fixture.response as ToolCallResponse).toolCalls[0];
    expect(tc.arguments).toBeNull();
  });

  it("mixed string/object arguments", () => {
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: {
        toolCalls: [
          { name: "fn1", arguments: '{"a":1}' },
          { name: "fn2", arguments: { b: 2 } },
        ],
      },
    };
    const fixture = entryToFixture(entry);
    const tcs = (fixture.response as ToolCallResponse).toolCalls;
    expect(tcs[0].arguments).toBe('{"a":1}');
    expect(tcs[1].arguments).toBe('{"b":2}');
  });

  it("does not mutate the original entry object", () => {
    const args = { city: "SF" };
    const entry: FixtureFileEntry = {
      match: { userMessage: "test" },
      response: {
        toolCalls: [{ name: "get_weather", arguments: args }],
      },
    };
    entryToFixture(entry);
    // Original object should be untouched
    expect(typeof args).toBe("object");
    expect(args.city).toBe("SF");
  });

  it("end-to-end: JSON round-trip through serialize + parse + entryToFixture", () => {
    // Simulate the full JSON file round-trip: author writes JSON with object
    // arguments, it gets serialized to disk, parsed back, and loaded.
    const fixtureData = {
      fixtures: [
        {
          match: { userMessage: "weather" },
          response: {
            toolCalls: [{ name: "get_weather", arguments: { city: "SF", temp: 72 } }],
          },
        },
        {
          match: { userMessage: "structured" },
          response: {
            content: { answer: 42, nested: { key: "val" } },
          },
        },
      ],
    };
    // Serialize -> parse (same as writing JSON to disk and reading it back)
    const parsed = JSON.parse(JSON.stringify(fixtureData)) as { fixtures: FixtureFileEntry[] };
    const fixtures = parsed.fixtures.map(entryToFixture);

    expect(fixtures).toHaveLength(2);

    const tc = (fixtures[0].response as ToolCallResponse).toolCalls[0];
    expect(tc.arguments).toBe('{"city":"SF","temp":72}');

    expect((fixtures[1].response as TextResponse).content).toBe(
      '{"answer":42,"nested":{"key":"val"}}',
    );
  });
});
