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

import { beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { RunnerTestCase, RunnerTestSuite } from "vitest";
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
import { resolve } from "node:path";

export interface UseAimockOptions extends MockServerOptions {
  /** Path to fixture file or directory. Loaded automatically on start. */
  fixtures?: string;
  /** If true, sets process.env.OPENAI_BASE_URL to the mock URL + /v1. */
  patchEnv?: boolean;
  /**
   * The per-test MCP fake report, read in `afterEach` (RP7): `"off"` (the
   * default), `"warn"` (print a failing report) or `"fail"` (throw
   * `AimockFakesReportError`). Not supported in concurrent tests: under
   * `"warn"` or `"fail"`, a concurrent test fails in `beforeEach`.
   */
  fakesReport?: FakesReportMode;
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
   * default is `<file> › <describe…> › <test>` (TI1); it is used only here and
   * in `fakesReport`, never on LLM traffic (TI4). Throws
   * `AimockTestIdCollisionError` when two tests share a default id, in a
   * concurrent test, or outside a test.
   */
  fakesFor(testId?: string, opts?: FakesForOptions): FakesTarget;
  /** The MCP fake report for `testId` (default as in `fakesFor`). */
  fakesReport(testId?: string, opts?: { context?: string }): Promise<McpFakesReport>;
}

/** TI1: `<file> › <name1> › … › <nameN>`; unnamed suites add no segment. */
function defaultVitestId(task: Readonly<RunnerTestCase>): string {
  const names: string[] = [];
  for (
    let suite: RunnerTestSuite | undefined = task.suite;
    suite !== undefined && suite !== task.file;
    suite = suite.suite
  ) {
    if (suite.name !== "") names.unshift(suite.name);
  }
  return [task.file.name, ...names, task.name].join(TEST_ID_SEPARATOR);
}

/**
 * Start an aimock server for the duration of the test suite.
 *
 * - `beforeAll`: starts the server and optionally loads fixtures (LLM fixtures and
 *   `mcpFakes` blocks; a bad `mcpFakes` block fails `beforeAll`)
 * - `beforeEach`: closes Live sessions and resets fixture match counts and MCP fake
 *   consumption (not fixtures or fakes); under `fakesReport: "warn" | "fail"` it
 *   throws in a concurrent test, which the per-test report does not support
 * - `afterEach`: closes Live sessions owned by this helper's server, then checks
 *   the MCP fake report under `fakesReport: "warn" | "fail"`
 * - `afterAll`: stops the server
 *
 * Returns a getter function — call it inside tests to access the handle.
 */
export function useAimock(options: UseAimockOptions = {}): () => AimockFakesHandle {
  let handle: AimockFakesHandle | null = null;
  let origOpenaiUrl: string | undefined;
  let origAnthropicUrl: string | undefined;
  let state = new FakesPluginState("off");
  /** TI5: default id -> the `task.id` that first used it; fresh per `beforeAll`. */
  let idMap = new Map<string, string>();
  let current: Readonly<RunnerTestCase> | null = null;

  function resolveTestId(testId: string | undefined): string {
    if (testId !== undefined) return testId; // TI4: an explicit id wins
    if (current === null) {
      throw new AimockTestIdCollisionError(
        "fakesFor() needs a running test; pass an explicit testId",
      );
    }
    if (current.concurrent === true) {
      throw new AimockTestIdCollisionError(
        "default test ids are not supported in concurrent tests; pass an explicit testId",
      );
    }
    const id = defaultVitestId(current);
    const owner = idMap.get(id);
    if (owner !== undefined && owner !== current.id) {
      throw new AimockTestIdCollisionError(
        `two tests share the default test id ${JSON.stringify(id)}; pass an explicit testId`,
      );
    }
    idMap.set(id, current.id);
    return id;
  }

  /**
   * The report keeps one state per `useAimock`, so concurrent tests would
   * clear and read each other's identities: under `"warn"` or `"fail"`, a
   * concurrent test is refused in `beforeEach` (and not reported on).
   */
  function refusesConcurrent(task: Readonly<RunnerTestCase>): boolean {
    return state.mode !== "off" && task.concurrent === true;
  }

  beforeAll(async () => {
    const { fixtures: fixturePath, patchEnv, fakesReport, ...serverOpts } = options;
    state = new FakesPluginState(fakesReportMode(fakesReport));
    idMap = new Map();
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
        const id = resolveTestId(testId);
        state.register(id, opts.context ?? null);
        return fakesTarget(url, id, opts);
      },
      fakesReport(testId?: string, opts: { context?: string } = {}): Promise<McpFakesReport> {
        return fetchFakesReport(url, resolveTestId(testId), opts.context ?? null);
      },
    };
  });

  beforeEach((ctx) => {
    current = ctx.task;
    if (refusesConcurrent(ctx.task)) {
      throw new Error(
        'useAimock(): fakesReport is not supported in concurrent tests; set fakesReport: "off" for this suite or run it sequentially',
      );
    }
    if (handle) {
      handle.llm.closeLiveSessions();
      handle.llm.resetMatchCounts();
      state.beforeEach(handle.llm);
    }
  });

  afterEach(async (ctx) => {
    try {
      handle?.llm.closeLiveSessions();
      if (handle && !refusesConcurrent(ctx.task)) await state.afterEach(handle.llm, handle.url);
    } finally {
      current = null;
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
