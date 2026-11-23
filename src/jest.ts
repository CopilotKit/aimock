/**
 * Jest integration for aimock.
 *
 * Usage:
 *   import { useAimock } from "@copilotkit/aimock/jest";
 *
 *   const mock = useAimock({ fixtures: "./fixtures" });
 *
 *   it("responds", async () => {
 *     const res = await fetch(`${mock().url}/v1/chat/completions`, { ... });
 *   });
 */

/* eslint-disable no-var */
// Jest globals — available at runtime in jest test files
declare var beforeAll: (fn: () => Promise<void> | void, timeout?: number) => void;
declare var afterAll: (fn: () => Promise<void> | void, timeout?: number) => void;
declare var beforeEach: (fn: () => Promise<void> | void, timeout?: number) => void;
declare var afterEach: (fn: () => Promise<void> | void, timeout?: number) => void;
declare var expect: { getState(): { testPath?: string; currentTestName?: string } };
/* eslint-enable no-var */

import { LLMock } from "./llmock.js";
import { FixtureLoadError, MisbehaviorConfigError } from "./fixture-loader.js";
import type { MockServerOptions } from "./types.js";
import {
  FakesPluginState,
  TEST_ID_SEPARATOR,
  fakesReportMode,
  fakesTarget,
  fetchFakesReport,
  type FakesForOptions,
  type FakesReportMode,
  type FakesTarget,
} from "./fakes-plugin.js";
import { AimockTestIdCollisionError, type McpFakesReport } from "./mcp-fakes-report.js";
import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface UseAimockOptions extends MockServerOptions {
  /** Path to fixture file or directory. Loaded automatically on start. */
  fixtures?: string;
  /** If true, sets process.env.OPENAI_BASE_URL to the mock URL + /v1. */
  patchEnv?: boolean;
  /**
   * The per-test MCP fake report, read in `afterEach` (RP7): `"off"` (the
   * default), `"warn"` (print a failing report) or `"fail"` (throw
   * `AimockFakesReportError`). Not supported with `test.concurrent`: the
   * report keeps one state per `useAimock`, so concurrent tests clear and read
   * each other's identities, and Jest cannot tell this plugin that a test is
   * concurrent. Keep `"off"` for a suite with concurrent tests.
   */
  fakesReport?: FakesReportMode;
  /**
   * The directory default test ids are relative to (TI2). Defaults to
   * `process.cwd()` when `useAimock` is called; Jest does not expose
   * `rootDir` to test code.
   */
  testIdRoot?: string;
}

export interface AimockHandle {
  /** The LLMock instance. */
  readonly llm: LLMock;
  /** The server URL (e.g., http://127.0.0.1:4010). */
  readonly url: string;
}

/**
 * The handle `useAimock` returns: an `AimockHandle` plus the MCP fakes
 * helpers (RP7). A separate type, so that `AimockHandle` stays as it was and
 * code that builds its own `AimockHandle` keeps compiling.
 */
export interface AimockFakesHandle extends AimockHandle {
  /**
   * The MCP URL and headers for the fakes scoped to `testId` (RP7), and
   * registers that identity for this test's report. With no `testId`, the
   * default is `<test file relative to testIdRoot> › <currentTestName>` (TI2);
   * it is used only here and in `fakesReport`, never on LLM traffic (TI4).
   * Two tests with the same full name in one file share a default id (TI5):
   * pass an explicit `testId` for them. In `test.concurrent`, Jest can
   * report another test's name, so pass an explicit `testId` there too (with
   * `fakesReport: "off"`; the report is not supported in concurrent tests).
   */
  fakesFor(testId?: string, opts?: FakesForOptions): FakesTarget;
  /** The MCP fake report for `testId` (default as in `fakesFor`). */
  fakesReport(testId?: string, opts?: { context?: string }): Promise<McpFakesReport>;
}

/** TI2: `<testPath relative to root, with "/"> › <currentTestName>`. */
function defaultJestId(root: string): string {
  const { testPath, currentTestName } = expect.getState();
  if (!testPath || currentTestName === undefined) {
    throw new AimockTestIdCollisionError(
      "default test ids are not supported here (concurrent test or no running test); pass an explicit testId",
    );
  }
  return relative(root, testPath).split(sep).join("/") + TEST_ID_SEPARATOR + currentTestName;
}

/**
 * Start an aimock server for the duration of the test suite.
 *
 * - `beforeAll`: starts the server and optionally loads fixtures (LLM fixtures and
 *   `mcpFakes` blocks; a bad `mcpFakes` block fails `beforeAll`)
 * - `beforeEach`: closes Live sessions and resets fixture match counts and MCP fake
 *   consumption (not fixtures or fakes)
 * - `afterEach`: closes Live sessions owned by this helper's server, then checks
 *   the MCP fake report under `fakesReport: "warn" | "fail"`
 * - `afterAll`: stops the server
 *
 * Returns a getter function — call it inside tests to access the handle.
 *
 * NOTE: Jest globals (beforeAll, afterAll, beforeEach, afterEach) must be available
 * in the test environment. This works with the default jest configuration.
 */
export function useAimock(options: UseAimockOptions = {}): () => AimockFakesHandle {
  let handle: AimockFakesHandle | null = null;
  let origOpenaiUrl: string | undefined;
  let origAnthropicUrl: string | undefined;
  const root = resolve(options.testIdRoot ?? process.cwd());
  let state = new FakesPluginState("off");

  beforeAll(async () => {
    const { fixtures: fixturePath, patchEnv, fakesReport, testIdRoot, ...serverOpts } = options;
    void testIdRoot; // read above, when useAimock is called
    state = new FakesPluginState(fakesReportMode(fakesReport));
    const llm = new LLMock(serverOpts);

    if (fixturePath) {
      loadFixtures(llm, resolve(fixturePath));
    }

    const url = await llm.start();

    if (patchEnv !== false) {
      origOpenaiUrl = process.env.OPENAI_BASE_URL;
      origAnthropicUrl = process.env.ANTHROPIC_BASE_URL;
      process.env.OPENAI_BASE_URL = `${url}/v1`;
      process.env.ANTHROPIC_BASE_URL = `${url}/v1`;
    }

    handle = {
      llm,
      url,
      fakesFor(testId?: string, opts: FakesForOptions = {}): FakesTarget {
        const id = testId ?? defaultJestId(root); // TI4: an explicit id wins
        state.register(id, opts.context ?? null);
        return fakesTarget(url, id, opts);
      },
      fakesReport(testId?: string, opts: { context?: string } = {}): Promise<McpFakesReport> {
        return fetchFakesReport(url, testId ?? defaultJestId(root), opts.context ?? null);
      },
    };
  });

  beforeEach(() => {
    if (handle) {
      handle.llm.closeLiveSessions();
      handle.llm.resetMatchCounts();
      state.beforeEach(handle.llm);
    }
  });

  afterEach(async () => {
    handle?.llm.closeLiveSessions();
    if (handle) await state.afterEach(handle.llm, handle.url);
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

/**
 * Load a fixture file or directory into `llm`: its LLM fixtures and its
 * `mcpFakes` blocks, which the LLMock buffers and auto-mounts at start (F12).
 * A `FixtureLoadError` (a bad `mcpFakes` block) or a `MisbehaviorConfigError`
 * (a bad fixture `misbehavior` key, thrown only with `enableMisbehavior: true`)
 * propagates and fails `beforeAll`; any other load failure is only warned
 * about, as before.
 */
function loadFixtures(llm: LLMock, fixturePath: string): void {
  try {
    const stat = statSync(fixturePath);
    if (stat.isDirectory()) {
      llm.loadFixtureDir(fixturePath);
    } else {
      llm.loadFixtureFile(fixturePath);
    }
  } catch (err) {
    if (err instanceof FixtureLoadError || err instanceof MisbehaviorConfigError) throw err;
    console.warn(
      `[aimock] Failed to load fixtures from ${fixturePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export { LLMock } from "./llmock.js";
export type { MockServerOptions, Fixture } from "./types.js";
export type { FakesForOptions, FakesReportMode, FakesTarget } from "./fakes-plugin.js";
export type { McpFakesReport } from "./mcp-fakes-report.js";
