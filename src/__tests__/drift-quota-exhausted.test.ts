/**
 * Provider quota exhaustion is infra, not drift.
 *
 * On the 2026-10-30 scheduled run (Drift Tests 41012506730) the OpenAI drift
 * account ran out of credit. Realtime sessions closed with 1013
 * `insufficient_quota.credit_balance_exhausted`, the Responses legs got an
 * `error` / `response.failed` event right after `response.created`, and Live
 * was refused. The collector reported "real API emits event type error but
 * mock does not" as critical drift and failed the run.
 *
 * Fixtures in drift/fixtures/quota-exhausted-2026-10-30/:
 *   - run-41012506730.json: failure messages and critical diffs copied verbatim
 *     from that run's drift-report.json artifact.
 *   - responses-http.sse / responses-ws.json: the streams the Responses legs
 *     saw. The run did not keep their bodies, so the event order comes from the
 *     run's diffs and the error object is the one OpenAI sent on the Realtime leg
 *     of the same run, for the same key.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  collectDriftEntries,
  computeExitCode,
  parseProviderQuotaExhausted,
} from "../../scripts/drift-report-collector.js";
import { summarizeDriftReport } from "../../scripts/drift-slack-summary.js";
import type { DriftEntry, DriftReport, TimeoutEntry } from "../../scripts/drift-types.js";
import { parseTypedSSE } from "./drift/helpers.js";
import {
  InfraError,
  PROVIDER_QUOTA_EXHAUSTED,
  findProviderQuotaExhaustion,
  providerQuotaExhaustedError,
  throwIfProviderQuotaExhausted,
} from "./drift/providers.js";
import { liveProviderErrorFailure } from "./drift/live-scenarios.js";
import { formatDriftReport, type ShapeDiff } from "./drift/schema.js";

const FIXTURES = new URL("./drift/fixtures/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");

interface RunFixture {
  realtimeServerClose: { testName: string; message: string }[];
  liveQuarantine: { testName: string; message: string }[];
  responsesStreamingDiffs: ShapeDiff[];
  responsesWsDiffs: ShapeDiff[];
}
const run: RunFixture = JSON.parse(fixture("quota-exhausted-2026-10-30/run-41012506730.json"));
const httpEvents = parseTypedSSE(fixture("quota-exhausted-2026-10-30/responses-http.sse")).map(
  (e) => e.data,
);
const wsEvents: unknown[] = JSON.parse(fixture("quota-exhausted-2026-10-30/responses-ws.json"));
const realtimeErrorEvent: unknown = JSON.parse(
  run.realtimeServerClose[0].message.match(/bodies=\[(.*)\] Transport/)![1],
);

type Failure = {
  ancestorTitles: string[];
  title: string;
  status: string;
  failureMessages: string[];
};
const failure = (testName: string, message: string): Failure => {
  const [ancestor, title] = testName.split(" > ");
  return { ancestorTitles: [ancestor], title, status: "failed", failureMessages: [message] };
};
const results = (failures: Failure[]) => ({
  testResults: [{ name: "drift", assertionResults: failures }],
});
const thrownBy = (fn: () => void): Error => {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
};
const asMessage = (err: Error) => `${err.name}: ${err.message}`;
const exitOf = (collected: ReturnType<typeof collectDriftEntries>) =>
  computeExitCode(
    collected.entries.reduce(
      (n, e) => n + e.diffs.filter((d) => d.severity === "critical").length,
      0,
    ),
    collected.quarantine.length,
    false,
    collected.timeouts.length,
  );

describe("provider quota exhaustion — leg side", () => {
  it("finds the quota code in the real error events of every OpenAI surface", () => {
    expect(findProviderQuotaExhaustion(httpEvents)).toBe("credit_balance_exhausted");
    expect(findProviderQuotaExhaustion(wsEvents)).toBe("credit_balance_exhausted");
    expect(findProviderQuotaExhaustion([realtimeErrorEvent])).toBe("credit_balance_exhausted");
    // An HTTP 429 body names it at the top-level error object.
    expect(
      findProviderQuotaExhaustion([{ error: { type: "insufficient_quota", code: null } }]),
    ).toBe("insufficient_quota");
  });

  it("NEGATIVE CONTROL: a healthy provider stream has no quota code", () => {
    const healthy = parseTypedSSE(fixture("openai-responses-k9-full-summary.sse")).map(
      (e) => e.data,
    );
    expect(findProviderQuotaExhaustion(healthy)).toBeNull();
    expect(() => throwIfProviderQuotaExhausted("OpenAI Responses", healthy)).not.toThrow();
  });

  it("a Responses leg reports the quota stream as an InfraError, not a drift report", () => {
    const err = thrownBy(() => throwIfProviderQuotaExhausted("OpenAI Responses", httpEvents));
    expect(err).toBeInstanceOf(InfraError);
    // In band on an accepted stream: there is no failing HTTP status to report.
    expect((err as InfraError).status).toBe(0);
    expect(err.message).toContain(PROVIDER_QUOTA_EXHAUSTED);
    expect(err.message).not.toMatch(/drift/i);
  });

  it("a Live error event carrying a quota code names it; other errors stay redacted", () => {
    const quota = liveProviderErrorFailure(realtimeErrorEvent as never);
    expect(quota.message).toContain(PROVIDER_QUOTA_EXHAUSTED);
    const other = liveProviderErrorFailure({
      type: "error",
      error: { type: "invalid_request_error", code: "unknown_parameter" },
    });
    expect(other.message).toBe(
      "OpenAI Live provider error; configured access or scenario unavailable",
    );
  });
});

describe("provider quota exhaustion — collector side", () => {
  // The run's failures, as the fixed legs now report them.
  const fixedRun = () =>
    results([
      failure(
        "OpenAI Responses API drift > streaming text event sequence and shapes match",
        asMessage(thrownBy(() => throwIfProviderQuotaExhausted("OpenAI Responses", httpEvents))),
      ),
      failure(
        "OpenAI Responses WS drift > WS text event sequence and shapes match",
        asMessage(thrownBy(() => throwIfProviderQuotaExhausted("OpenAI Responses WS", wsEvents))),
      ),
      ...run.realtimeServerClose.map((t) => failure(t.testName, t.message)),
      failure(
        run.liveQuarantine[0].testName,
        asMessage(liveProviderErrorFailure(realtimeErrorEvent as never)),
      ),
      failure(
        run.liveQuarantine[1].testName,
        asMessage(providerQuotaExhaustedError("OpenAI Live", "credit_balance_exhausted")),
      ),
    ]);

  it("classifies every out-of-credit leg as infra: no drift, no quarantine, exit 6", () => {
    const collected = collectDriftEntries(fixedRun() as never);
    expect(collected.entries).toEqual([]);
    expect(collected.quarantine).toEqual([]);
    expect(collected.timeouts).toHaveLength(7);
    for (const t of collected.timeouts)
      expect(t.providerQuotaExhausted).toEqual({ code: "credit_balance_exhausted" });
    expect(exitOf(collected)).toBe(6);
  });

  it("keeps the real Realtime 1013 close frame on the record", () => {
    const realtime = collectDriftEntries(
      results(run.realtimeServerClose.map((t) => failure(t.testName, t.message))) as never,
    ).timeouts;
    expect(realtime).toHaveLength(3);
    for (const t of realtime) {
      expect(t.serverClose).toEqual({
        code: 1013,
        reason: "insufficient_quota.credit_balance_exhausted",
      });
      expect(t.providerQuotaExhausted).toEqual({ code: "credit_balance_exhausted" });
    }
  });

  it("a real critical drift beside the quota legs still wins (exit 2)", () => {
    const genuine: ShapeDiff = {
      path: "SSE:response.output_text.annotation.added",
      severity: "critical",
      issue:
        'LLMOCK DRIFT — real API emits event type "response.output_text.annotation.added" but mock does not',
      expected: "response.output_text.annotation.added",
      real: "response.output_text.annotation.added",
      mock: "<absent>",
    };
    const input = fixedRun();
    input.testResults[0].assertionResults.push(
      failure(
        "OpenAI Responses API drift > streaming tool call event sequence matches",
        "AssertionError: " +
          formatDriftReport(
            "OpenAI Responses (streaming tool call events)",
            [genuine],
            "openai-responses",
          ),
      ),
    );
    const collected = collectDriftEntries(input as never);
    expect(collected.entries).toHaveLength(1);
    expect(collected.entries[0].diffs[0].path).toBe(genuine.path);
    expect(exitOf(collected)).toBe(2);
  });

  it("NEGATIVE CONTROL: drift reports and assertions that mention a quota code stay drift", () => {
    // The run's own drift report: real diffs, no error body. Still drift — the
    // collector does not guess billing from an event name.
    const asReported = collectDriftEntries(
      results([
        failure(
          "OpenAI Responses API drift > streaming text event sequence and shapes match",
          "AssertionError: " +
            formatDriftReport(
              "OpenAI Responses (streaming text events)",
              run.responsesStreamingDiffs,
              "openai-responses",
            ),
        ),
      ]) as never,
    );
    expect(asReported.entries[0].diffs.map((d) => d.id)).toEqual([
      "SSE:error",
      "SSE:response.failed",
    ]);
    expect(exitOf(asReported)).toBe(2);

    // A drift block whose VALUES contain a quota code (the error-shape legs).
    const errorShape: ShapeDiff = {
      path: "error.type",
      severity: "critical",
      issue: "Native response value differs",
      expected: "insufficient_quota",
      real: "insufficient_quota",
      mock: "rate_limit_exceeded",
    };
    const shape = collectDriftEntries(
      results([
        failure(
          "OpenAI Chat drift > quota error shape matches",
          "AssertionError: " +
            formatDriftReport("OpenAI Chat (quota error)", [errorShape], "openai-chat"),
        ),
      ]) as never,
    );
    expect(shape.timeouts).toEqual([]);
    expect(exitOf(shape)).toBe(2);

    // A bare assertion on a quota value is drift-like, never infra.
    expect(
      parseProviderQuotaExhausted(
        "AssertionError: expected 'rate_limit' to be 'insufficient_quota'",
      ),
    ).toBeNull();
  });

  // Real failure messages from a drift leg that exercised the mock-side
  // insufficient_quota fixture (openai-chat.drift.ts) and regressed: a
  // toStrictEqual, a toThrow, and a thrown Error echoing the mock body. Each
  // names the code but carries no provider evidence, so each is a test failure.
  const maskedAssertions = [
    "AssertionError: expected 'insufficient_quota' to strictly equal 'insufficient_quota_v2'\n" +
      "    at src/__tests__/drift/openai-chat.drift.ts:36:29",
    "AssertionError: expected [Function] to throw error including 'rate_limit_exceeded' but got 'mock said insufficient_quota'\n" +
      "    at Proxy.<anonymous> (node_modules/@vitest/expect/dist/index.js:1420:16)",
    'Error: unexpected mock error body {"error":{"message":"You exceeded your current quota","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}\n' +
      "    at src/__tests__/drift/openai-chat.drift.ts:46:58",
    // An assertion that QUOTES the marker is not the marker.
    `AssertionError: expected [Function] to throw error including 'x' but got '${asMessage(
      providerQuotaExhaustedError("OpenAI Chat", "insufficient_quota"),
    )}'`,
  ];

  it.each(maskedAssertions)(
    "NEGATIVE CONTROL: a real test failure that only names a quota code stays a failure (%#)",
    (message) => {
      expect(parseProviderQuotaExhausted(message)).toBeNull();
      const collected = collectDriftEntries(
        results([failure("OpenAI Chat drift > mock quota envelope", message)]) as never,
      );
      expect(collected.timeouts).toEqual([]);
      expect(collected.quarantine).toHaveLength(1);
      expect(exitOf(collected)).toBe(5);
    },
  );
});

describe("provider quota exhaustion — Slack summary", () => {
  const quotaLeg: TimeoutEntry = {
    testName: "OpenAI Realtime API drift > WS text event sequence and shapes match (GA)",
    rawLocation: "",
    serverClose: { code: 1013, reason: "insufficient_quota.credit_balance_exhausted" },
    providerQuotaExhausted: { code: "credit_balance_exhausted" },
    message: run.realtimeServerClose[0].message,
  };
  const report = (entries: DriftEntry[], timeouts: TimeoutEntry[]): DriftReport => ({
    timestamp: "2026-10-30T06:12:56.000Z",
    entries,
    quarantine: [],
    timeouts,
  });

  it("says top up credit, and is the infra class, not real-drift", () => {
    const summary = summarizeDriftReport(report([], [quotaLeg]));
    expect(summary).toContain("*Classification:* infra-transient");
    expect(summary).toContain("Provider quota exhausted — top up credit");
    expect(summary).toContain("not API drift");
    expect(summary).not.toContain("real-drift");
  });

  it("real drift still headlines as real-drift and keeps the quota line", () => {
    const drift: DriftEntry = {
      provider: "OpenAI Responses",
      scenario: "streaming text events",
      builderFile: "src/responses.ts",
      builderFunctions: [],
      typesFile: null,
      sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
      diffs: [{ ...run.responsesStreamingDiffs[0] }],
    };
    const summary = summarizeDriftReport(report([drift], [quotaLeg]));
    expect(summary).toContain("*Classification:* real-drift");
    expect(summary).toContain("Provider quota exhausted — top up credit");
  });
});
