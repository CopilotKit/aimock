/**
 * The per-test MCP fake report (record-replay RP1-RP8): one identity (a test
 * id, plus an optional context) across every MCP mount of one server. Each
 * mount's `MCPMock` gives its part (`fakesReportPart`, from the store's event
 * log); this module merges the parts, decides `ok` (RP5), formats the failure
 * message (RP7) and serves `GET /__aimock/mcp/fakes/report` (RP6).
 */
import type * as http from "node:http";
import type { MountList } from "./mcp-fakes-mount.js";
import { isFakeMount } from "./mcp-fakes-mount.js";
import type { McpFakeReportPart } from "./mcp-fakes.js";

type ServedRow = McpFakeReportPart["served"][number];
type FailureRow = McpFakeReportPart["failures"][number];

/**
 * RP3: the report. `served` and `failures` are in call order across mounts;
 * their rows have no `seq` (the internal ordering key the parts carry).
 */
export interface McpFakesReport {
  testId: string | null;
  context: string | null;
  ok: boolean;
  evicted: boolean;
  served: Omit<ServedRow, "seq">[];
  unconsumed: McpFakeReportPart["unconsumed"];
  unfaked: McpFakeReportPart["unfaked"];
  failures: Omit<FailureRow, "seq">[];
  sharedUnconsumed: McpFakeReportPart["sharedUnconsumed"];
}

/** RP7/RP8: thrown by the plugins under "fail" and by assertFakesReport. */
export class AimockFakesReportError extends Error {
  readonly report: McpFakesReport;
  constructor(report: McpFakesReport, message: string) {
    super(message);
    this.name = "AimockFakesReportError";
    this.report = report;
  }
}

/** TI5: a default test id cannot be inferred safely. */
export class AimockTestIdCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AimockTestIdCollisionError";
  }
}

interface ReportSource {
  fakesReportPart(testId: string | null, context: string | null, mount: string): McpFakeReportPart;
}

function isReportSource(handler: unknown): handler is ReportSource {
  return (
    typeof handler === "object" &&
    handler !== null &&
    typeof (handler as Partial<ReportSource>).fakesReportPart === "function"
  );
}

/** RP1-RP5 over every fake mount of a server. Reads only: no state changes (RP9). */
export function buildFakesReport(
  mounts: MountList,
  testId: string | null,
  context: string | null,
): McpFakesReport {
  let evicted = false;
  const served: ServedRow[] = [];
  const unconsumed: McpFakesReport["unconsumed"] = [];
  const unfaked: McpFakesReport["unfaked"] = [];
  const failures: FailureRow[] = [];
  const sharedUnconsumed: McpFakesReport["sharedUnconsumed"] = [];
  for (const { path, handler } of mounts) {
    if (!isFakeMount(handler) || !isReportSource(handler)) continue;
    const part = handler.fakesReportPart(testId, context, path);
    evicted ||= part.evicted;
    served.push(...part.served);
    unconsumed.push(...part.unconsumed);
    unfaked.push(...part.unfaked);
    failures.push(...part.failures);
    sharedUnconsumed.push(...part.sharedUnconsumed);
  }
  // `seq` is shared by every store, so it orders calls across mounts.
  served.sort((a, b) => a.seq - b.seq);
  failures.sort((a, b) => a.seq - b.seq);
  const ok = failures.length === 0 && !evicted && unconsumed.length === 0; // RP5
  return {
    testId,
    context,
    ok,
    evicted,
    served: served.map(({ entryId, mount, tool, args }) => ({ entryId, mount, tool, args })),
    unconsumed,
    unfaked,
    failures: failures.map(({ code, mount, tool, args }) => ({ code, mount, tool, args })),
    sharedUnconsumed,
  };
}

/** `value` as one line of JSON; a value with no JSON text is shown as `String(value)`. */
function jsonText(value: unknown): string {
  try {
    const text = JSON.stringify(value) as string | undefined;
    return text ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * RP7 message: a header naming the test id (and context), then one line per
 * failure, then per unconsumed entry id, then the evicted line. With
 * `failOnUnfaked`, one line per unfaked call follows.
 */
export function formatFakesReport(
  report: McpFakesReport,
  opts: { failOnUnfaked?: boolean } = {},
): string {
  const who = report.testId === null ? "no test id" : `testId ${JSON.stringify(report.testId)}`;
  const ctx = report.context === null ? "" : `, context ${JSON.stringify(report.context)}`;
  const lines = [`aimock MCP fakes report failed (${who}${ctx}):`];
  for (const f of report.failures) {
    lines.push(`  failure ${f.code}: tools/call ${f.tool} on ${f.mount} with ${jsonText(f.args)}`);
  }
  for (const u of report.unconsumed) {
    lines.push(`  unconsumed: ${u.entryId} (${u.mount} ${u.tool})`);
  }
  if (report.evicted) {
    lines.push(
      "  evicted: this test id's fake state was evicted by the per-mount test-id cap, or its event log overflowed (1000 events); the report is incomplete",
    );
  }
  if (opts.failOnUnfaked === true) {
    for (const u of report.unfaked) {
      lines.push(`  unfaked: tools/call ${u.tool} on ${u.mount} answered by ${u.answeredBy}`);
    }
  }
  return lines.join("\n");
}

/** RP8: throw `AimockFakesReportError` when the report fails (RP5, plus unfaked under `failOnUnfaked`). */
export function assertFakesReport(
  report: McpFakesReport,
  opts: { failOnUnfaked?: boolean } = {},
): void {
  const unfakedFails = opts.failOnUnfaked === true && report.unfaked.length > 0;
  if (report.ok && !unfakedFails) return;
  throw new AimockFakesReportError(report, formatFakesReport(report, opts));
}

/** The query parameters `GET /__aimock/mcp/fakes/report` accepts. */
const MCP_FAKES_REPORT_PARAMS = new Set(["testId", "context"]);

/** RP6: `GET /__aimock/mcp/fakes/report?testId=&context=`. Always answers; returns true. */
export function handleFakesReportRoute(
  res: http.ServerResponse,
  searchParams: URLSearchParams,
  mounts: MountList,
): true {
  const reply = (status: number, body: unknown): true => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return true;
  };
  for (const key of searchParams.keys()) {
    if (!MCP_FAKES_REPORT_PARAMS.has(key)) {
      return reply(400, {
        error: `Unknown query parameter: '${key}'. Supported: ${[...MCP_FAKES_REPORT_PARAMS].join(", ")}`,
      });
    }
  }
  // Empty values are not supplied, as on GET /__aimock/mcp/fakes.
  const testId = searchParams.get("testId") || null;
  const context = searchParams.get("context") || null;
  return reply(200, buildFakesReport(mounts, testId, context));
}
