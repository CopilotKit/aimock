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
 * Fixtures in drift/fixtures/quota-exhausted-2026-10-30/ (README.md there says
 * which parts are real and which are reconstructed):
 *   - run-41012506730.json: failure messages and critical diffs copied verbatim
 *     from that run's drift-report.json artifact.
 *   - responses-http.sse / responses-ws.json: the streams the Responses legs
 *     saw. The run did not keep their bodies, so the event order comes from the
 *     run's diffs and the error object is the one OpenAI sent on the Realtime leg
 *     of the same run, for the same key.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import {
  collectDriftEntries,
  computeExitCode,
  conclusionForExitCode,
  parseProviderQuotaExhausted,
} from "../../scripts/drift-report-collector.js";
import { summarizeDriftReport } from "../../scripts/drift-slack-summary.js";
import type { DriftEntry, DriftReport, TimeoutEntry } from "../../scripts/drift-types.js";
import { parseTypedSSE } from "./drift/helpers.js";
import {
  InfraError,
  PROVIDER_QUOTA_EXHAUSTED,
  ProviderQuotaExhaustedError,
  errorBodyEvents,
  findProviderQuotaExhaustion,
  providerQuotaExhaustedError,
  throwIfProviderQuotaExhausted,
  throwIfProviderQuotaRefusal,
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
  it("finds the quota code in the real Realtime error and the reconstructed Responses streams", () => {
    expect(findProviderQuotaExhaustion(httpEvents)).toBe("credit_balance_exhausted");
    expect(findProviderQuotaExhaustion(wsEvents)).toBe("credit_balance_exhausted");
    expect(findProviderQuotaExhaustion([realtimeErrorEvent])).toBe("credit_balance_exhausted");
    // An HTTP 429 body names it at the top-level error object.
    expect(
      findProviderQuotaExhaustion([{ error: { type: "insufficient_quota", code: null } }]),
    ).toBe("insufficient_quota");
  });

  it("finds it in OpenAI's documented flat `error` event and in a lone `response.failed`", () => {
    // The Responses streaming `error` event is flat: {type, code, message, param}.
    expect(
      findProviderQuotaExhaustion([
        { type: "error", code: "insufficient_quota", message: "no credit", param: null },
      ]),
    ).toBe("insufficient_quota");
    // A stream that sends only `response.failed` names it at response.error.code.
    expect(
      findProviderQuotaExhaustion([
        {
          type: "response.failed",
          response: { status: "failed", error: { code: "credit_balance_exhausted" } },
        },
      ]),
    ).toBe("credit_balance_exhausted");
  });

  it("errorBodyEvents: a JSON body is one event; a non-JSON 429 body is logged, not dropped silently", () => {
    expect(errorBodyEvents('{"error":{"code":"insufficient_quota"}}', 429)).toEqual([
      { error: { code: "insufficient_quota" } },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(errorBodyEvents("<html>Too Many Requests</html>", 429)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("HTTP 429");
      expect(String(warn.mock.calls[0][0])).toContain("<html>Too Many Requests</html>");
    } finally {
      warn.mockRestore();
    }
  });

  it("an HTTP 429 refusal names quota from the WHOLE body, with the real status", () => {
    // OpenAI pretty-prints its error body; a long message pushes the code past
    // the 300-char cut that assertOk applies to its own error text.
    const body = JSON.stringify(
      {
        error: {
          message: "You exceeded your current quota. " + "Read the billing docs. ".repeat(20),
          type: "insufficient_quota",
          param: null,
          code: "insufficient_quota",
        },
      },
      null,
      2,
    );
    expect(body.indexOf('"type": "insufficient_quota"')).toBeGreaterThan(300);
    const err = thrownBy(() => throwIfProviderQuotaRefusal("OpenAI Embeddings", 429, body));
    expect(err).toBeInstanceOf(ProviderQuotaExhaustedError);
    expect((err as InfraError).status).toBe(429);
    expect(parseProviderQuotaExhausted(asMessage(err))).toEqual({ code: "insufficient_quota" });
    // A 429 that is a plain rate limit is not out of credit.
    expect(() =>
      throwIfProviderQuotaRefusal(
        "OpenAI Embeddings",
        429,
        '{"error":{"type":"requests","code":"rate_limit_exceeded"}}',
      ),
    ).not.toThrow();
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

  it("an HTTP 429 insufficient_quota refusal from providers.ts is infra too", () => {
    const err = thrownBy(() =>
      throwIfProviderQuotaRefusal(
        "OpenAI Embeddings",
        429,
        '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota",' +
          '"param":null,"code":"insufficient_quota"}}',
      ),
    );
    const collected = collectDriftEntries(
      results([
        failure("OpenAI Embeddings drift > embedding response shape matches", asMessage(err)),
      ]) as never,
    );
    expect(collected.timeouts[0].providerQuotaExhausted).toEqual({ code: "insufficient_quota" });
    expect(exitOf(collected)).toBe(6);
  });

  it("a Realtime REFUSAL close naming a quota code is quota, and keeps serverClose's contract", () => {
    const message =
      'WSClosedError: WebSocket closed by server during waitUntil: code=4001 reason="insufficient_quota". ' +
      "Collected 0 messages";
    const collected = collectDriftEntries(
      results([failure("OpenAI Realtime API drift > refused", message)]) as never,
    );
    expect(collected.entries).toEqual([]);
    expect(collected.timeouts).toHaveLength(1);
    expect(collected.timeouts[0].providerQuotaExhausted).toEqual({ code: "insufficient_quota" });
    // A refusal code is never recorded in serverClose (see TimeoutEntry).
    expect(collected.timeouts[0].serverClose).toBeUndefined();
    // A 1013 close whose reason is NOT a quota code is not out of credit.
    expect(
      parseProviderQuotaExhausted(
        'WSClosedError: WebSocket closed by server during waitUntil: code=1013 reason="try_again_later". Collected 0 messages',
      ),
    ).toBeNull();
  });

  it("the second pass never quarantines a quota leg beside an unparseable sibling", () => {
    // Only a run with an unparseable failure and zero drift entries runs the
    // second pass; the quota leg must still be claimed by the exit-6 lane there.
    const collected = collectDriftEntries(
      results([
        failure(
          "OpenAI Responses API drift > streaming text event sequence and shapes match",
          asMessage(thrownBy(() => throwIfProviderQuotaExhausted("OpenAI Responses", httpEvents))),
        ),
        failure("OpenAI Chat drift > bare assertion", "AssertionError: boom"),
      ]) as never,
    );
    expect(collected.timeouts.map((t) => t.testName)).toEqual([
      "OpenAI Responses API drift > streaming text event sequence and shapes match",
    ]);
    expect(collected.quarantine.map((q) => q.testName)).toEqual([
      "OpenAI Chat drift > bare assertion",
    ]);
    expect(exitOf(collected)).toBe(5);
  });

  it("a quota-only run concludes provider-quota-exhausted; any silent leg keeps live-timeout", () => {
    expect(conclusionForExitCode(6, true)).toBe("provider-quota-exhausted");
    expect(conclusionForExitCode(6, false)).toBe("live-timeout");
    expect(conclusionForExitCode(6)).toBe("live-timeout");
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

  it("says top up credit, and is the persistent provider-quota class, not real-drift", () => {
    const summary = summarizeDriftReport(report([], [quotaLeg]));
    expect(summary).toContain("*Classification:* provider-quota");
    expect(summary).not.toContain("infra-transient");
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

describe("provider quota exhaustion — Live leg on the wire", () => {
  // A loopback peer that answers the Live leg the way an out-of-credit OpenAI
  // account can: a close frame alone, an error event followed by another error,
  // or a refused upgrade. `runLiveProvider` keeps module state across modes (a
  // refusal stops later modes from paying for a session), so each test loads a
  // fresh copy of the module.
  type PeerMode = "close1013" | "quotaThenOther" | "upgrade429" | "closeDuringSends";
  const servers: Server[] = [];
  const sockets: Duplex[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0))
      await new Promise<void>((done) => server.close(() => done()));
  });

  const frame = (opcode: number, payload: Buffer) =>
    Buffer.concat([
      payload.length < 126
        ? Buffer.from([0x80 | opcode, payload.length])
        : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]),
      payload,
    ]);
  const text = (event: object) => frame(1, Buffer.from(JSON.stringify(event)));

  async function peer(mode: PeerMode): Promise<{ url: string; connects: () => number }> {
    let connects = 0;
    const server = createServer();
    server.on("upgrade", (req, socket) => {
      connects++;
      sockets.push(socket);
      socket.on("error", () => {});
      if (mode === "upgrade429") {
        const body = JSON.stringify({
          error: {
            message: "You exceeded your current quota",
            type: "insufficient_quota",
            param: null,
            code: "insufficient_quota",
          },
        });
        socket.end(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        return;
      }
      const accept = createHash("sha1")
        .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      if (mode === "closeDuringSends") {
        // Ask for three tool results, then close for quota as soon as the
        // first result arrives, while the leg is still sending the others.
        let reads = 0;
        socket.on("data", () => {
          reads++;
          if (reads === 1)
            socket.write(
              Buffer.concat(
                [
                  ...["read_red", "read_blue", "read_green"].map((name, i) => ({
                    type: "response.event",
                    event: {
                      type: "response.output_item.done",
                      item: { type: "function_call", call_id: `call_${i}`, name },
                    },
                  })),
                  { type: "response.event", event: { type: "response.completed" } },
                ].map(text),
              ),
            );
          else if (reads === 2) {
            const reason = Buffer.from("insufficient_quota.credit_balance_exhausted");
            socket.end(frame(8, Buffer.concat([Buffer.from([1013 >> 8, 1013 & 255]), reason])));
          }
        });
        return;
      }
      socket.once("data", () => {
        if (mode === "close1013") {
          const reason = Buffer.from("insufficient_quota.credit_balance_exhausted");
          socket.end(frame(8, Buffer.concat([Buffer.from([1013 >> 8, 1013 & 255]), reason])));
        } else {
          socket.write(
            Buffer.concat([
              text(realtimeErrorEvent as object),
              text({ type: "error", error: { type: "invalid_request_error", code: "expired" } }),
            ]),
          );
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    servers.push(server);
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/v1/live/sessions`, connects: () => connects };
  }

  async function freshLive() {
    vi.resetModules();
    return import("./drift/live-scenarios.js");
  }

  it.each([
    ["close1013", "credit_balance_exhausted", 0],
    ["quotaThenOther", "credit_balance_exhausted", 0],
    ["upgrade429", "insufficient_quota", 429],
  ] as const)(
    "%s: the leg names quota, and the next mode reports it without a paid connect",
    async (mode, code, status) => {
      const { runLiveProvider } = await freshLive();
      const { url, connects } = await peer(mode);
      const first = await runLiveProvider("client", "sk-test", url).then(
        () => new Error("expected a failure"),
        (err: Error) => err,
      );
      expect(first.message).toBe(
        `INFRA_ERROR: OpenAI Live — ${PROVIDER_QUOTA_EXHAUSTED} (${code})`,
      );
      expect((first as InfraError).status).toBe(status);
      const second = await runLiveProvider("managed", "sk-test", url).then(
        () => new Error("expected a failure"),
        (err: Error) => err,
      );
      expect(second.message).toBe(first.message);
      expect(connects()).toBe(1);
      expect(parseProviderQuotaExhausted(asMessage(second))).toEqual({ code });
    },
    20_000,
  );

  it("a send that fails because the quota close already arrived still reports quota", async () => {
    vi.resetModules();
    // Over wss (as api.openai.com is) a write completes on a later loop turn,
    // so a close frame can arrive between two sends. Model that on the
    // loopback peer by starting each write one loop turn later.
    const { WebSocketConnection } = await import("../ws-framing.js");
    const sendAsync = WebSocketConnection.prototype.sendAsync;
    const deferred = vi
      .spyOn(WebSocketConnection.prototype, "sendAsync")
      .mockImplementation(async function (
        this: InstanceType<typeof WebSocketConnection>,
        data: string,
        signal?: AbortSignal,
      ) {
        await new Promise((turn) => setImmediate(turn));
        return sendAsync.call(this, data, signal);
      });
    try {
      const { runLiveProvider } = await import("./drift/live-scenarios.js");
      const { url, connects } = await peer("closeDuringSends");
      const err = await runLiveProvider("client", "sk-test", url).then(
        () => new Error("expected a failure"),
        (error: Error) => error,
      );
      expect(err.message).toBe(
        `INFRA_ERROR: OpenAI Live — ${PROVIDER_QUOTA_EXHAUSTED} (credit_balance_exhausted)`,
      );
      expect(connects()).toBe(1);
      expect(parseProviderQuotaExhausted(asMessage(err))).toEqual({
        code: "credit_balance_exhausted",
      });
    } finally {
      deferred.mockRestore();
    }
  }, 20_000);
});
