import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  stripTeraTemplate,
  deriveMatchFromFilename,
  convertFile,
  convertDirectory,
} from "../../scripts/convert-vidaimock.js";
import type { AimockFixtureFile } from "../../scripts/convert-vidaimock.js";
import { loadFixtureFile } from "../fixture-loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "vidaimock-convert-test-"));
}

function writeTemplate(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// stripTeraTemplate
// ---------------------------------------------------------------------------

describe("stripTeraTemplate", () => {
  it("strips simple Tera variable expressions", () => {
    const input = "{{ model }}\n---\n{{ content }}";
    const result = stripTeraTemplate(input);
    expect(result).toBe("[model]\n---\n[content]");
  });

  it("removes Tera comment blocks", () => {
    const input = "{# This is a comment #}Hello world";
    expect(stripTeraTemplate(input)).toBe("Hello world");
  });

  it("removes Tera block tags", () => {
    const input = "{% if show %}visible{% endif %}";
    expect(stripTeraTemplate(input)).toBe("visible");
  });

  it("extracts content from a JSON response template with Tera expressions", () => {
    // This is what a VidaiMock Tera template file looks like on disk —
    // Tera expressions sit where JSON string values would normally be.
    const input = `{
  "id": "chatcmpl-{{ id }}",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": {{ response_text }}
      }
    }
  ]
}`;
    // The bare {{ response_text }} (no surrounding quotes) gets replaced
    // with a quoted placeholder, making valid JSON that the extractor parses.
    const result = stripTeraTemplate(input);
    expect(result).toBe("[response_text]");
  });

  it("extracts literal content from a JSON response template", () => {
    const input = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello there!",
          },
        },
      ],
    });
    expect(stripTeraTemplate(input)).toBe("Hello there!");
  });

  it("returns empty-ish text for an empty template", () => {
    expect(stripTeraTemplate("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// deriveMatchFromFilename
// ---------------------------------------------------------------------------

describe("deriveMatchFromFilename", () => {
  it("strips extension and converts underscores to spaces", () => {
    expect(deriveMatchFromFilename("tell_me_a_joke.tera")).toBe("tell me a joke");
  });

  it("strips leading numeric prefix", () => {
    expect(deriveMatchFromFilename("003-weather.txt")).toBe("weather");
  });

  it("handles hyphens", () => {
    expect(deriveMatchFromFilename("my-greeting.json")).toBe("my greeting");
  });

  it("handles path with directories", () => {
    expect(deriveMatchFromFilename("/some/path/hello_world.tera")).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// convertFile — single template
// ---------------------------------------------------------------------------

describe("convertFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("converts a simple Tera template to a fixture", () => {
    const fp = writeTemplate(tmpDir, "greeting.tera", "Hello! How can I help?");
    const fixture = convertFile(fp);
    expect(fixture).not.toBeNull();
    expect(fixture!.match.userMessage).toBe("greeting");
    expect(fixture!.response.content).toBe("Hello! How can I help?");
  });

  it("converts a JSON response template", () => {
    const json = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "I am a mock." } }],
    });
    const fp = writeTemplate(tmpDir, "mock_response.json", json);
    const fixture = convertFile(fp);
    expect(fixture).not.toBeNull();
    expect(fixture!.match.userMessage).toBe("mock response");
    expect(fixture!.response.content).toBe("I am a mock.");
  });

  it("returns null for a non-existent file", () => {
    expect(convertFile(join(tmpDir, "nope.tera"))).toBeNull();
  });

  it("handles malformed templates gracefully (empty file)", () => {
    const fp = writeTemplate(tmpDir, "empty.tera", "");
    expect(convertFile(fp)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// convertDirectory
// ---------------------------------------------------------------------------

describe("convertDirectory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("converts all template files in a directory", () => {
    writeTemplate(tmpDir, "greeting.tera", "Hello!");
    writeTemplate(tmpDir, "farewell.txt", "Goodbye!");
    writeTemplate(tmpDir, "ignored.md", "Should be skipped");

    const fixtures = convertDirectory(tmpDir);
    expect(fixtures).toHaveLength(2);

    const matches = fixtures.map((f) => f.match.userMessage).sort();
    expect(matches).toEqual(["farewell", "greeting"]);
  });

  it("returns empty array for an empty directory", () => {
    expect(convertDirectory(tmpDir)).toEqual([]);
  });

  it("returns empty array for a non-existent directory", () => {
    expect(convertDirectory(join(tmpDir, "nope"))).toEqual([]);
  });

  it("skips subdirectories", () => {
    writeTemplate(tmpDir, "root.tera", "Root template");
    mkdirSync(join(tmpDir, "subdir"));
    writeTemplate(join(tmpDir, "subdir"), "nested.tera", "Nested");

    const fixtures = convertDirectory(tmpDir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].match.userMessage).toBe("root");
  });
});

// ---------------------------------------------------------------------------
// Output validity — end-to-end check
// ---------------------------------------------------------------------------

describe("aimock fixture output validity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces valid aimock fixture JSON from a directory", () => {
    writeTemplate(tmpDir, "hello.tera", "Hi there!");
    writeTemplate(
      tmpDir,
      "joke.json",
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Why did the chicken..." } }],
      }),
    );

    const fixtures = convertDirectory(tmpDir);
    const output: AimockFixtureFile = { fixtures };
    const json = JSON.stringify(output, null, 2);

    // Must be valid JSON
    const parsed = JSON.parse(json) as AimockFixtureFile;
    expect(parsed.fixtures).toHaveLength(2);

    // Every fixture must have the required shape
    for (const f of parsed.fixtures) {
      expect(f).toHaveProperty("match.userMessage");
      expect(f).toHaveProperty("response.content");
      expect(typeof f.match.userMessage).toBe("string");
      expect(typeof f.response.content).toBe("string");
    }
  });

  it("round-trips through loadFixtureFile", () => {
    writeTemplate(tmpDir, "greeting.tera", "Hello from VidaiMock!");
    writeTemplate(
      tmpDir,
      "weather.json",
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Sunny and warm" } }],
      }),
    );

    // Convert VidaiMock templates to aimock fixture format
    const fixtures = convertDirectory(tmpDir);
    const output: AimockFixtureFile = { fixtures };

    // Write to disk as an aimock fixture file
    const outPath = join(tmpDir, "converted-fixtures.json");
    writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

    // Load it back via aimock's fixture loader
    const loaded = loadFixtureFile(outPath);
    expect(loaded).toHaveLength(2);

    // Verify that the loaded fixtures have match/response data intact
    const messages = loaded.map((f) => f.match.userMessage).sort();
    expect(messages).toEqual(["greeting", "weather"]);

    for (const f of loaded) {
      const resp = f.response as { content?: string };
      expect(typeof resp.content).toBe("string");
      expect(resp.content!.length).toBeGreaterThan(0);
    }
  });
});
