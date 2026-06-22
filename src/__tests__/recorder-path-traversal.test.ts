import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Fixture, RecordConfig } from "../types.js";
import { persistFixture } from "../recorder.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Security: the X-AIMock-Context header value becomes a directory segment in
// the recorded-fixture path (recorder.ts ~209-211). An attacker-controlled
// context containing `../` (or absolute paths / separators) must NOT let the
// written fixture escape the configured fixtures base directory.
// ---------------------------------------------------------------------------

describe("recorder context path traversal", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeBaseDir(): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-ptrav-"));
    tmpDirs.push(base);
    return base;
  }

  function buildFixture(context: string): Fixture {
    return {
      match: {
        userMessage: "hello",
        endpoint: "/v1/chat/completions",
        context,
      },
      response: { content: "hi" },
    };
  }

  function persistWithContext(base: string, context: string): string {
    const fixture = buildFixture(context);
    const result = persistFixture({
      record: { providers: {}, fixturePath: base } as RecordConfig,
      providerKey: "openai",
      testId: "__default__", // non-snapshot mode → timestamp layout uses context dir
      fixture,
      fixtures: [],
      logger: new Logger("silent"),
    });
    expect(result.kind).toBe("written");
    return (result as { kind: "written"; filepath: string }).filepath;
  }

  it("keeps a traversal context inside the fixtures base dir", () => {
    const base = makeBaseDir();
    // Where an unsanitized `../../../tmp/aimock-escape` context would land its
    // fixture directory. Clear any leftover so this assertion reflects THIS run.
    const escapeTarget = path.resolve(os.tmpdir(), "aimock-escape");
    fs.rmSync(escapeTarget, { recursive: true, force: true });

    const written = persistWithContext(base, "../../../tmp/aimock-escape");

    const resolvedBase = path.resolve(base);
    const resolvedWritten = path.resolve(written);

    expect(resolvedWritten.startsWith(resolvedBase + path.sep)).toBe(true);
    // The escaped path must not have been created outside the base.
    expect(fs.existsSync(escapeTarget)).toBe(false);
  });

  it("strips path separators and absolute-path prefixes from context", () => {
    const base = makeBaseDir();
    const written = persistWithContext(base, "/etc/passwd-dir/sub");

    const resolvedBase = path.resolve(base);
    const resolvedWritten = path.resolve(written);

    expect(resolvedWritten.startsWith(resolvedBase + path.sep)).toBe(true);
    // Exactly one directory level under base (the sanitized segment), plus file.
    const rel = path.relative(resolvedBase, resolvedWritten);
    expect(rel.split(path.sep).length).toBe(2);
  });

  it("still routes a legitimate context into its own subdirectory", () => {
    const base = makeBaseDir();
    const written = persistWithContext(base, "my-feature");

    const resolvedBase = path.resolve(base);
    const rel = path.relative(resolvedBase, path.resolve(written));
    const segments = rel.split(path.sep);
    expect(segments.length).toBe(2);
    expect(segments[0]).toBe("my-feature");
  });
});
