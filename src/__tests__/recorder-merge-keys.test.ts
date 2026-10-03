/**
 * F9 / B5: the recorder's snapshot merge keeps every existing top-level key
 * it does not own. It still rewrites `fixtures`, `_warnings` and `_warning`.
 *
 * Real surface: an upstream LLMock (the "provider") and a recording LLMock
 * pointed at it, both listening on real TCP ports. One chat request with an
 * `X-Test-Id` header merges into a pre-created snapshot file.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";
import { slugifyTestId } from "../helpers.js";

const TEST_ID = "recorder merge > keeps unknown keys";

let upstream: LLMock | undefined;
let recorder: LLMock | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  await recorder?.stop();
  recorder = undefined;
  await upstream?.stop();
  upstream = undefined;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function recordInto(existing: unknown): Promise<Record<string, unknown>> {
  upstream = new LLMock({ port: 0, logLevel: "silent" });
  upstream.onMessage("hello", { content: "hi from upstream" });
  await upstream.start();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-merge-keys-"));
  const snapshotPath = path.join(tmpDir, slugifyTestId(TEST_ID), "openai.json");
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(existing, null, 2));

  recorder = new LLMock({
    port: 0,
    logLevel: "silent",
    record: { providers: { openai: upstream.url }, fixturePath: tmpDir },
  });
  await recorder.start();

  const res = await fetch(`${recorder.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Id": TEST_ID },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(res.status).toBe(200);
  await res.text();

  return JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as Record<string, unknown>;
}

const MCP_FAKES = {
  "/mcp": {
    tools: [{ name: "lookup", calls: [{ args: { q: "x" }, result: { content: [] } }] }],
  },
};

describe("recorder snapshot merge keeps unknown top-level keys (F9, B5)", () => {
  it("keeps mcpFakes and custom keys and appends the new fixture", async () => {
    const written = await recordInto({ fixtures: [], mcpFakes: MCP_FAKES, custom: 1 });

    expect(written.mcpFakes).toEqual(MCP_FAKES);
    expect(written.custom).toBe(1);
    expect(Array.isArray(written.fixtures)).toBe(true);
    expect(written.fixtures as unknown[]).toHaveLength(1);
  });

  it("treats a missing fixtures key as [] and keeps the other keys", async () => {
    const written = await recordInto({ mcpFakes: MCP_FAKES });

    expect(written.mcpFakes).toEqual(MCP_FAKES);
    expect(written.fixtures as unknown[]).toHaveLength(1);
  });

  it("still owns the warning keys: a stale empty _warning is not carried forward", async () => {
    const written = await recordInto({ fixtures: [], _warning: "", custom: "kept" });

    expect(written.custom).toBe("kept");
    expect(written).not.toHaveProperty("_warning");
    expect(written).not.toHaveProperty("_warnings");
  });

  it("rewrites existing warnings rather than copying them verbatim", async () => {
    const written = await recordInto({
      fixtures: [],
      _warnings: ["earlier warning", "earlier warning", 7],
      custom: true,
    });

    expect(written.custom).toBe(true);
    expect(written._warnings).toEqual(["earlier warning"]);
    expect(written._warning).toBe("earlier warning");
  });
});
