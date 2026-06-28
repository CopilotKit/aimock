/**
 * #274 — Two F0-reachable validator/resolver defects on the `blocks` path.
 *
 * BUG A (programmatic crash): `addFixture`/`addFixtures`/`prependFixture` store
 * a RAW fixture with no `normalizeResponse` pass, so a `toolCall` block written
 * with an OBJECT `arguments` value reaches `resolveFixtureBlocks` unchanged.
 * That resolver previously REQUIRED a string and threw, so real dispatch
 * returned HTTP >= 500. The fix makes `resolveFixtureBlocks` tolerant: it
 * stringifies an object `arguments` (mirroring `normalizeResponse`'s
 * `JSON.stringify`) so the programmatic path is safe. The file-load path is
 * unchanged because string `arguments` stay byte-identical.
 *
 * BUG C (spurious hard error): a fixture `{ content: "", blocks: [...] }` raised
 * a "content is empty string" HARD error at validate even though the builder
 * ignores `content` whenever a non-empty `blocks` array is present (`content`
 * is a legacy mirror). The fix suppresses the empty-content error when
 * non-empty `blocks` drive the output; fixtures WITHOUT blocks still error.
 *
 * NOTE: the empty-TEXT-block rule (`validateBlocks` rejecting `{type:"text",
 * text:""}`) is intentionally strict and is NOT changed here.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryToFixture, validateFixtures } from "../fixture-loader.js";
import { resolveFixtureBlocks } from "../helpers.js";
import { LLMock } from "../llmock.js";

let mock: LLMock | null = null;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "blocks-tolerance-"));
});

afterEach(async () => {
  if (mock) {
    await mock.stop();
    mock = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("BUG A — toolCall block with OBJECT arguments on the programmatic path", () => {
  it("resolveFixtureBlocks stringifies object arguments instead of throwing", () => {
    const blocks = [{ type: "toolCall", name: "f", arguments: { a: 1 } }] as unknown as Parameters<
      typeof resolveFixtureBlocks
    >[0];
    const resolved = resolveFixtureBlocks(blocks);
    const arg = (resolved[0] as { arguments: unknown }).arguments;
    expect(typeof arg).toBe("string");
    expect(arg).toBe(JSON.stringify({ a: 1 }));
  });

  it("string arguments stay byte-identical (file-load path unchanged)", () => {
    const blocks = [{ type: "toolCall", name: "f", arguments: '{"a":1}' }] as unknown as Parameters<
      typeof resolveFixtureBlocks
    >[0];
    const resolved = resolveFixtureBlocks(blocks);
    expect((resolved[0] as { arguments: unknown }).arguments).toBe('{"a":1}');
  });

  it("addFixture with object block arguments dispatches without HTTP >= 500", async () => {
    mock = new LLMock({ port: 0 });
    // addFixture stores RAW — no normalizeResponse. Object args reach the resolver.
    mock.addFixture({
      match: { userMessage: "hi" },
      response: {
        blocks: [{ type: "toolCall", name: "get_weather", arguments: { city: "NYC" } }],
      },
    } as never);
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    const body = await res.text();
    expect(res.status).toBeLessThan(500);
    // The stringified arguments must reach the wire.
    expect(body).toContain("NYC");
  });
});

describe("BUG C — content:'' alongside a non-empty blocks array", () => {
  it("validateFixtures does NOT raise 'content is empty string' when blocks drive output", () => {
    const fixtures = [
      entryToFixture({
        match: { userMessage: "hi" },
        response: { content: "", blocks: [{ type: "text", text: "hello" }] },
      } as never),
    ];
    const errors = validateFixtures(fixtures).filter((i) => i.severity === "error");
    expect(errors.some((e) => /content is empty string/.test(e.message))).toBe(false);
  });

  it("validateFixtures STILL raises 'content is empty string' WITHOUT blocks", () => {
    const fixtures = [
      entryToFixture({
        match: { userMessage: "hi" },
        response: { content: "" },
      } as never),
    ];
    const errors = validateFixtures(fixtures).filter((i) => i.severity === "error");
    expect(errors.some((e) => /content is empty string/.test(e.message))).toBe(true);
  });

  it("the empty-TEXT-block rule stays strict (unchanged)", () => {
    const fixtures = [
      entryToFixture({
        match: { userMessage: "hi" },
        response: { content: "", blocks: [{ type: "text", text: "" }] },
      } as never),
    ];
    const errors = validateFixtures(fixtures).filter((i) => i.severity === "error");
    expect(errors.some((e) => /text is empty string/.test(e.message))).toBe(true);
  });

  it("a content:'' + non-empty blocks fixture loads clean and streams", async () => {
    const filePath = join(tmpDir, "content-empty-blocks.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        fixtures: [
          {
            match: { userMessage: "stream please" },
            response: { content: "", blocks: [{ type: "text", text: "Here you go." }] },
          },
        ],
      }),
      "utf-8",
    );

    mock = new LLMock({ port: 0 });
    mock.loadFixtureFile(filePath);
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "stream please" }],
        stream: true,
      }),
    });
    const body = await res.text();
    expect(res.status).toBeLessThan(500);
    expect(body).toContain("Here you go.");
  });
});
