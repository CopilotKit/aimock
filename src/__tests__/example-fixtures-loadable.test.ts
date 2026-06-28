/**
 * The shipped, copy-pasteable example fixtures under `fixtures/examples/llm/`
 * must stay genuinely loadable — not merely well-formed JSON. The docs page
 * (`docs/examples/index.html`) tells authors to copy these files verbatim, so a
 * fixture that parses but fails recognition/validation would silently rot and
 * mislead anyone who copies it.
 *
 * This loads the on-disk `blocks-tool-first.json` THROUGH THE REAL LOADER
 * (`loadFixtureFile`, the same entry the mock server uses), then runs the real
 * `validateFixtures` pass and asserts:
 *   - the loader returns the fixture (it swallows read/parse/shape errors into a
 *     warning + empty array, so a non-empty result already proves it loaded),
 *   - the blocks-only response is a recognized type (no hard validation errors),
 *   - the resolved blocks are tool-first (toolCall before text) — the exact
 *     ordering the docs example promises and that plain content/toolCalls cannot
 *     express.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadFixtureFile, validateFixtures } from "../fixture-loader.js";
import { isContentWithToolCallsResponse, resolveFixtureBlocks } from "../helpers.js";
import type { FixtureBlock } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, "..", "..", "fixtures", "examples", "llm");

describe("shipped example fixtures load cleanly through the real loader", () => {
  it("blocks-tool-first.json loads, validates, and is tool-first", () => {
    const fixtures = loadFixtureFile(join(exampleDir, "blocks-tool-first.json"));

    // The loader returns [] on read/parse/shape failure, so a non-empty result
    // already proves the file genuinely loaded (not just parsed in isolation).
    expect(fixtures).toHaveLength(1);

    const response = fixtures[0].response;
    expect(typeof response).not.toBe("function");
    // Blocks-only fixtures are recognized via the BLOCKS-ONLY clause (#274 F0).
    expect(isContentWithToolCallsResponse(response as object)).toBe(true);

    // No hard validation errors — the file is genuinely valid, not just JSON.
    const errors = validateFixtures(fixtures).filter((r) => r.severity === "error");
    expect(errors).toEqual([]);

    const blocks = resolveFixtureBlocks((response as { blocks: FixtureBlock[] }).blocks);
    const types = blocks.map((b) => b.type);
    expect(types.indexOf("toolCall")).toBeLessThan(types.indexOf("text"));
  });
});
