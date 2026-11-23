/**
 * The MCP fakes part of the Vitest and Jest plugins (record-replay RP7, TI):
 * `fakesFor` targets, the per-test fake report check in `afterEach`, and the
 * state both adapters share. The default test id itself is built by each
 * adapter (TI1 Vitest, TI2 Jest), and it is used only by the fakes helpers
 * (TI4): nothing here tags LLM or control traffic.
 */
import type { LLMock } from "./llmock.js";
import {
  AimockFakesReportError,
  formatFakesReport,
  type McpFakesReport,
} from "./mcp-fakes-report.js";
import { MCP_FAKES_DEFAULT_TEST_ID } from "./mcp-fakes.js";

/** RP7: what `afterEach` does with a failing report. `"off"` is the default. */
export type FakesReportMode = "off" | "warn" | "fail";

/** RP7: what `fakesFor` returns, for an MCP client. */
export interface FakesTarget {
  /** The test id the URL and headers carry (explicit, or the inferred default). */
  testId: string;
  /** The mount URL with `?testId=` (and `&context=`). */
  mcpUrl: string;
  /** The matching `X-Test-Id` / `X-AIMock-Context` headers, URI-encoded. */
  headers: Record<string, string>;
}

export interface FakesForOptions {
  /** The context the fake blocks are scoped to. */
  context?: string;
  /** The MCP mount path (default `"/mcp"`). */
  mount?: string;
}

/** TI1/TI2 separator: space, U+203A, space. */
export const TEST_ID_SEPARATOR = " › ";

const FAKES_REPORT_MODES: readonly FakesReportMode[] = ["off", "warn", "fail"];

/** The `fakesReport` option, checked: an unknown mode fails `beforeAll`. */
export function fakesReportMode(mode: FakesReportMode | undefined): FakesReportMode {
  if (mode === undefined) return "off";
  if (!FAKES_REPORT_MODES.includes(mode)) {
    throw new Error(
      `useAimock(): fakesReport must be one of ${FAKES_REPORT_MODES.map((m) => JSON.stringify(m)).join(", ")}; got ${JSON.stringify(mode)}`,
    );
  }
  return mode;
}

/**
 * The URL and headers that reach the fakes scoped to `testId` (and
 * `opts.context`) at `opts.mount`. `URLSearchParams` writes a space as `+`,
 * which the mount reads back as a space in the query.
 */
export function fakesTarget(url: string, testId: string, opts: FakesForOptions = {}): FakesTarget {
  const mount = opts.mount ?? "/mcp";
  const query = new URLSearchParams({ testId });
  const headers: Record<string, string> = { "X-Test-Id": encodeURIComponent(testId) };
  if (opts.context) {
    query.set("context", opts.context);
    headers["X-AIMock-Context"] = encodeURIComponent(opts.context);
  }
  return { testId, mcpUrl: `${url}${mount}?${query.toString()}`, headers };
}

/** RP6: read `GET /__aimock/mcp/fakes/report` for one identity. */
export async function fetchFakesReport(
  url: string,
  testId: string | null,
  context: string | null,
): Promise<McpFakesReport> {
  const query = new URLSearchParams();
  if (testId !== null) query.set("testId", testId);
  if (context !== null) query.set("context", context);
  const res = await fetch(`${url}/__aimock/mcp/fakes/report?${query.toString()}`);
  if (!res.ok) {
    throw new Error(`aimock fakes report: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as McpFakesReport;
}

/** One identity the report checks; `null` means none supplied. */
export interface FakesIdentity {
  testId: string | null;
  context: string | null;
}

function identityKey(testId: string | null, context: string | null): string {
  return `${testId ?? ""}\u0000${context ?? ""}`;
}

/** Per-`useAimock` state shared by the Vitest and Jest adapters. */
export class FakesPluginState {
  private readonly registered = new Map<string, FakesIdentity>();
  /** RP7 (b): id of the last journal entry when the test started (C2). */
  private marker: string | null = null;

  constructor(readonly mode: FakesReportMode) {}

  /** Start of a test, after the match-count reset. */
  beforeEach(llm: LLMock): void {
    this.registered.clear();
    this.marker = llm.getLastRequest()?.id ?? null;
  }

  /** RP7 (a): `fakesFor` registers the identity for the current test. */
  register(testId: string, context: string | null): void {
    this.registered.set(identityKey(testId, context), { testId, context });
  }

  /**
   * RP7 (a) and (b): the registered identities, plus every (test id, context)
   * an MCP request carried since the marker. If the marker entry is gone
   * (FIFO cap or a cleared journal), every remaining entry is newer.
   */
  identities(llm: LLMock): FakesIdentity[] {
    const all = llm.getRequests();
    const at = this.marker === null ? -1 : all.findIndex((e) => e.id === this.marker);
    const newer = at >= 0 ? all.slice(at + 1) : all;
    const out = new Map(this.registered);
    for (const entry of newer) {
      if (entry.service !== "mcp" || entry.testId === undefined) continue;
      const testId = entry.testId === MCP_FAKES_DEFAULT_TEST_ID ? null : entry.testId;
      const context = entry.context ?? null;
      out.set(identityKey(testId, context), { testId, context });
    }
    return [...out.values()];
  }

  /**
   * End of a test, before the next reset: read each identity's report.
   * Under `"fail"`, a report with `ok: false` throws `AimockFakesReportError`
   * (the first failing report, with every failing report's text); under
   * `"warn"`, the text goes to `console.warn`. An unconsumed entry two
   * reports share (an entry scoped by test id only, checked with and without
   * a context) is listed once.
   */
  async afterEach(llm: LLMock, url: string): Promise<void> {
    if (this.mode === "off") return;
    const failing: McpFakesReport[] = [];
    const lines: string[] = [];
    const unconsumedSeen = new Set<string>();
    for (const id of this.identities(llm)) {
      const report = await fetchFakesReport(url, id.testId, id.context);
      if (report.ok) continue;
      failing.push(report);
      for (const line of formatFakesReport(report).split("\n")) {
        if (line.startsWith("  unconsumed: ")) {
          if (unconsumedSeen.has(line)) continue;
          unconsumedSeen.add(line);
        }
        lines.push(line);
      }
    }
    if (failing.length === 0) return;
    const text = lines.join("\n");
    if (this.mode === "warn") {
      console.warn(text);
      return;
    }
    throw new AimockFakesReportError(failing[0], text);
  }
}
