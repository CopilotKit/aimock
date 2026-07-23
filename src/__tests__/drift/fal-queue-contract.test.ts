/**
 * Determinism guard for the LIVE fal queue-lifecycle assertion
 * (`assertLiveFalQueueEnvelopes`) — the exact function the live drift leg runs
 * against funded fal. These stub the lifecycle STATE at every observation so the
 * timing variance CI actually hits is reproduced deterministically here.
 *
 * BUG (#332 residual): funded `flux/schnell` may still be IN_PROGRESS at status
 * poll time, and fal's status endpoint answers a still-running job with a
 * non-200 2xx (202 Accepted) — the old `expect(statusPoll.status).toBe(200)`
 * hard-asserted 200 and threw the raw status envelope as an AssertionError,
 * which the drift collector could not parse → exit-5 quarantine → CI red. The
 * earlier "green" was a lucky run where the job reached COMPLETED (200) by poll
 * time.
 *   RED (pre-fix): IN_PROGRESS @ 202 status → `.toBe(200)` throws.
 *   GREEN (post-fix): the leg accepts the 2xx range → passes at ANY lifecycle
 *   state, while a 2xx-WRONG-SHAPE still reports critical drift (anti-cheat).
 */
import { describe, it, expect } from "vitest";
import { assertLiveFalQueueEnvelopes } from "./fal-queue-contract.js";
import type { FalQueueCanaryResult } from "./providers.js";

const RID = "req-inprogress-1";
const BASE = "https://queue.fal.run/fal-ai/flux/schnell/requests";

/** aimock's queue-submit body (the mock contract the live envelope is graded against). */
const MOCK_SUBMIT = {
  request_id: RID,
  status_url: `${BASE}/${RID}/status`,
  response_url: `${BASE}/${RID}`,
  cancel_url: `${BASE}/${RID}/cancel`,
  queue_position: 0,
};

/** aimock's queue-status body (always terminal COMPLETED — the mock never runs). */
const MOCK_STATUS = {
  status: "COMPLETED",
  request_id: RID,
  response_url: `${BASE}/${RID}`,
};

/** A real submit envelope for a fast funded model: IN_PROGRESS, no queue_position. */
const REAL_SUBMIT_IN_PROGRESS = {
  status: "IN_PROGRESS",
  request_id: RID,
  status_url: `${BASE}/${RID}/status`,
  response_url: `${BASE}/${RID}`,
  cancel_url: `${BASE}/${RID}/cancel`,
};

/** fal's cancel-on-a-running/completed-job error envelope: `{detail}`, no status. */
const REAL_CANCEL_DETAIL = { detail: `Request ${RID} is already completed.` };

function canaryResult(overrides: Partial<FalQueueCanaryResult> = {}): FalQueueCanaryResult {
  return {
    submit: { status: 200, body: { ...REAL_SUBMIT_IN_PROGRESS } },
    statusPoll: {
      status: 202, // still IN_PROGRESS → fal answers 202, NOT 200
      body: { status: "IN_PROGRESS", request_id: RID, response_url: `${BASE}/${RID}` },
    },
    cancel: { status: 400, body: { ...REAL_CANCEL_DETAIL } },
    ...overrides,
  };
}

describe("assertLiveFalQueueEnvelopes — state-agnostic across lifecycle timing (#332)", () => {
  it("GREEN: IN_PROGRESS at submit AND 202 at status poll AND {detail} cancel → passes", () => {
    // The exact residual-bug timing: job never reaches COMPLETED before poll.
    expect(() =>
      assertLiveFalQueueEnvelopes(canaryResult(), MOCK_SUBMIT, MOCK_STATUS),
    ).not.toThrow();
  });

  it("GREEN: COMPLETED at 200 (the lucky-race path) → still passes", () => {
    const live = canaryResult({
      statusPoll: {
        status: 200,
        body: { status: "COMPLETED", request_id: RID, response_url: `${BASE}/${RID}` },
      },
      cancel: { status: 400, body: { status: "ALREADY_COMPLETED" } },
    });
    expect(() => assertLiveFalQueueEnvelopes(live, MOCK_SUBMIT, MOCK_STATUS)).not.toThrow();
  });

  it("GREEN: IN_QUEUE at 200 with CANCELLATION_REQUESTED cancel → passes", () => {
    const live = canaryResult({
      submit: {
        status: 200,
        body: { ...REAL_SUBMIT_IN_PROGRESS, status: "IN_QUEUE", queue_position: 3 },
      },
      statusPoll: {
        status: 200,
        body: { status: "IN_QUEUE", request_id: RID, response_url: `${BASE}/${RID}` },
      },
      cancel: { status: 200, body: { status: "CANCELLATION_REQUESTED" } },
    });
    expect(() => assertLiveFalQueueEnvelopes(live, MOCK_SUBMIT, MOCK_STATUS)).not.toThrow();
  });

  it("GREEN: cancel of a still-running job returns HTTP 202 (CANCELLATION_REQUESTED) → passes", () => {
    // fal answers a cancel while the job is running/queued with a non-200 2xx
    // (202 Accepted), NOT 200 — the residual timing-intolerant `[200, 400]`
    // check flaked on exactly this. Cancel is graded on shape, not a fixed code.
    const live = canaryResult({
      cancel: { status: 202, body: { status: "CANCELLATION_REQUESTED" } },
    });
    expect(() => assertLiveFalQueueEnvelopes(live, MOCK_SUBMIT, MOCK_STATUS)).not.toThrow();
  });

  it("GREEN: HTTP status codes are IGNORED at status + cancel — arbitrary codes with valid shape pass", () => {
    // The whole point of the shape-only approach: no lifecycle step asserts a
    // specific HTTP code. Even oddball codes pass as long as the envelope SHAPE
    // is intact — the code is pure timing noise.
    const live = canaryResult({
      statusPoll: {
        status: 418,
        body: { status: "IN_PROGRESS", request_id: RID, response_url: `${BASE}/${RID}` },
      },
      cancel: { status: 409, body: { status: "ALREADY_COMPLETED" } },
    });
    expect(() => assertLiveFalQueueEnvelopes(live, MOCK_SUBMIT, MOCK_STATUS)).not.toThrow();
  });

  it("ANTI-CHEAT: a 2xx status envelope with a WRONG-TYPE field still reports critical drift", () => {
    // 202 IN_PROGRESS (so the HTTP-code + status checks all pass) but
    // response_url is a NUMBER where the mock has a string — a genuine shape
    // drift that state-tolerance must NOT swallow.
    const live = canaryResult({
      statusPoll: {
        status: 202,
        body: { status: "IN_PROGRESS", request_id: RID, response_url: 12345 },
      },
    });
    expect(() => assertLiveFalQueueEnvelopes(live, MOCK_SUBMIT, MOCK_STATUS)).toThrow();
  });

  it("ANTI-CHEAT: a 2xx submit envelope with a WRONG-TYPE field still reports critical drift", () => {
    const live = canaryResult({
      submit: {
        status: 200,
        body: { ...REAL_SUBMIT_IN_PROGRESS, request_id: 999 }, // number where mock has string
      },
    });
    expect(() => assertLiveFalQueueEnvelopes(live, MOCK_SUBMIT, MOCK_STATUS)).toThrow();
  });

  it("ANTI-CHEAT: a cancel envelope with a WRONG-TYPE status still reports critical drift", () => {
    // Cancel HTTP code is ignored, but the envelope SHAPE is still graded — a
    // status that is a NUMBER where the contract has a string is real drift.
    const live = canaryResult({
      cancel: { status: 202, body: { status: 12345 } },
    });
    expect(() => assertLiveFalQueueEnvelopes(live, MOCK_SUBMIT, MOCK_STATUS)).toThrow();
  });

  it("GUARD: an unrecognized lifecycle status is still rejected", () => {
    const live = canaryResult({
      statusPoll: {
        status: 202,
        body: { status: "WAT_IS_THIS", request_id: RID, response_url: `${BASE}/${RID}` },
      },
    });
    expect(() => assertLiveFalQueueEnvelopes(live, MOCK_SUBMIT, MOCK_STATUS)).toThrow();
  });
});
