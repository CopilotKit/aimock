import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidateCli } from "../validate-cli.js";
import { runAimockCli } from "../aimock-cli.js";

function harness(argv: string[]): { logs: string[]; errors: string[]; code: number | null } {
  const logs: string[] = [];
  const errors: string[] = [];
  let code: number | null = null;
  runValidateCli({
    argv,
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
    exit: (c) => {
      code = c;
    },
  });
  return { logs, errors, code };
}

describe("aimock validate CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimock-validate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  it("accepts a clean file with exit 0", () => {
    const f = write(
      "ok.json",
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
      }),
    );
    const r = harness([f]);
    expect(r.code).toBe(0);
    expect(r.logs.join("\n")).toContain("OK");
  });

  it("fails unreadable, unparseable, and wrong-shape files with exit 1", () => {
    const missing = harness([join(dir, "nope.json")]);
    expect(missing.code).toBe(1);
    expect(missing.errors.join("\n")).toContain("Could not read");

    const badJson = harness([write("bad.json", "{not json")]);
    expect(badJson.code).toBe(1);
    expect(badJson.errors.join("\n")).toContain("Invalid JSON");

    const wrongShape = harness([write("shape.json", JSON.stringify({ hello: 1 }))]);
    expect(wrongShape.code).toBe(1);
    expect(wrongShape.errors.join("\n")).toContain("fixtures");
  });

  it("reports fixture errors, honors --strict and --json, usage exits 2", () => {
    const badRate = write(
      "rate.json",
      JSON.stringify({
        fixtures: [
          { match: { userMessage: "hi" }, response: { content: "x" }, chaos: { dropRate: 9 } },
        ],
      }),
    );
    const r = harness([badRate]);
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toContain("dropRate");

    const j = harness(["--json", badRate]);
    expect(j.code).toBe(1);
    const doc = JSON.parse(j.logs.join("\n")) as { failed: boolean };
    expect(doc.failed).toBe(true);

    const usage = harness([]);
    expect(usage.code).toBe(2);

    const unknown = harness(["--nope", badRate]);
    expect(unknown.code).toBe(2);
  });

  it("dispatches via aimock validate and documents help", () => {
    const f = write(
      "ok2.json",
      JSON.stringify({
        fixtures: [{ match: { userMessage: "hi" }, response: { content: "hello" } }],
      }),
    );
    const logs: string[] = [];
    let code: number | null = null;
    runAimockCli({
      argv: ["validate", f],
      log: (m) => logs.push(m),
      logError: () => {},
      exit: (c) => {
        code = c;
      },
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("OK");

    const helpLogs: string[] = [];
    let helpCode: number | null = null;
    runAimockCli({
      argv: ["validate", "--help"],
      log: (m) => helpLogs.push(m),
      logError: () => {},
      exit: (c) => {
        helpCode = c;
      },
    });
    expect(helpCode).toBe(0);
    expect(helpLogs.join("\n")).toContain("aimock validate");
  });
});
