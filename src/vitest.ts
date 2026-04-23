/**
 * Vitest integration for aimock.
 *
 * Usage:
 *   import { useAimock } from "@copilotkit/aimock/vitest";
 *
 *   const mock = useAimock({ fixtures: "./fixtures" });
 *
 *   it("responds", async () => {
 *     const res = await fetch(`${mock().url}/v1/chat/completions`, { ... });
 *   });
 */

import { beforeAll, afterAll, beforeEach } from "vitest";
import { LLMock } from "./llmock.js";
import { loadFixtureFile, loadFixturesFromDir } from "./fixture-loader.js";
import type { Fixture, MockServerOptions } from "./types.js";
import { statSync } from "node:fs";
import { resolve } from "node:path";

export interface UseAimockOptions extends MockServerOptions {
  /** Path to fixture file or directory. Loaded automatically on start. */
  fixtures?: string;
  /** If true, sets process.env.OPENAI_BASE_URL to the mock URL + /v1. */
  patchEnv?: boolean;
}

export interface AimockHandle {
  /** The LLMock instance. */
  readonly llm: LLMock;
  /** The server URL (e.g., http://127.0.0.1:4010). */
  readonly url: string;
}

/**
 * Start an aimock server for the duration of the test suite.
 *
 * - `beforeAll`: starts the server and optionally loads fixtures
 * - `beforeEach`: resets fixture match counts (not fixtures themselves)
 * - `afterAll`: stops the server
 *
 * Returns a getter function — call it inside tests to access the handle.
 */
export function useAimock(options: UseAimockOptions = {}): () => AimockHandle {
  let handle: AimockHandle | null = null;
  let origOpenaiUrl: string | undefined;
  let origAnthropicUrl: string | undefined;

  beforeAll(async () => {
    const { fixtures: fixturePath, patchEnv, ...serverOpts } = options;
    const llm = new LLMock(serverOpts);

    if (fixturePath) {
      const resolved = resolve(fixturePath);
      const loadedFixtures = loadFixtures(resolved);
      for (const f of loadedFixtures) {
        llm.addFixture(f);
      }
    }

    const url = await llm.start();

    if (patchEnv !== false) {
      origOpenaiUrl = process.env.OPENAI_BASE_URL;
      origAnthropicUrl = process.env.ANTHROPIC_BASE_URL;
      process.env.OPENAI_BASE_URL = `${url}/v1`;
      process.env.ANTHROPIC_BASE_URL = `${url}/v1`;
    }

    handle = { llm, url };
  });

  beforeEach(() => {
    if (handle) {
      handle.llm.resetMatchCounts();
    }
  });

  afterAll(async () => {
    if (handle) {
      if (options.patchEnv !== false) {
        if (origOpenaiUrl !== undefined) process.env.OPENAI_BASE_URL = origOpenaiUrl;
        else delete process.env.OPENAI_BASE_URL;
        if (origAnthropicUrl !== undefined) process.env.ANTHROPIC_BASE_URL = origAnthropicUrl;
        else delete process.env.ANTHROPIC_BASE_URL;
      }
      await handle.llm.stop();
      handle = null;
    }
  });

  return () => {
    if (!handle) {
      throw new Error("useAimock(): server not started — are you calling this inside a test?");
    }
    return handle;
  };
}

function loadFixtures(fixturePath: string): Fixture[] {
  try {
    const stat = statSync(fixturePath);
    if (stat.isDirectory()) {
      return loadFixturesFromDir(fixturePath);
    }
    return loadFixtureFile(fixturePath);
  } catch (err) {
    console.warn(
      `[aimock] Failed to load fixtures from ${fixturePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export { LLMock } from "./llmock.js";
export type { MockServerOptions, Fixture } from "./types.js";
