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
