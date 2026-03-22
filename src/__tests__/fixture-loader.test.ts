import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtureFile, loadFixturesFromDir } from "../fixture-loader.js";

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

  it("warns and skips subdirectories, still loads sibling JSON files", () => {
    writeJson(tmpDir, "a-valid.json", {
      fixtures: [{ match: { userMessage: "top" }, response: { content: "yes" } }],
    });
    const subDir = join(tmpDir, "nested");
    mkdirSync(subDir);
    writeJson(subDir, "inner.json", {
      fixtures: [{ match: { userMessage: "deep" }, response: { content: "nope" } }],
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.userMessage).toBe("top");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping subdirectory"));
    warn.mockRestore();
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
});
