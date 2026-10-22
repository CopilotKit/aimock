/**
 * The drift-sync gate must return the SAME VERDICT for the SAME CHANGESET.
 *
 * OBSERVED FAILURE this file reconstructs — two consecutive scheduled `Fix Drift`
 * runs produced the byte-identical changeset key `74f6efa43753f7d0` (the same two
 * gemini deprecations, recorded the same way) and the gate accepted it only once:
 *
 *   * 2026-08-11, run 31465219443 — `reason=gate-failed`:
 *     "drift-sync-check rejected the sync [residual-critical-drift]: Clean
 *      re-collect after sync still reports 1 critical diff(s) — sync did not
 *      resolve the drift — reverted"
 *   * 2026-08-12, run 31570802134 — `reason=ok-applied`, PR #370 opened, +2/-0.
 *
 * WHY IT COULD DIFFER — gate-3 re-runs the WHOLE live drift suite
 * (`vitest --config vitest.config.drift.ts`, every provider and every surface)
 * and vetoes on its GLOBAL critical count. Nothing about that count is a function
 * of the changeset: the sync's own input is three `/models` listings, while
 * gate-3's input is a fresh live observation of every drift surface aimock has,
 * taken ~75s later. Two runs therefore share a changeset key while handing gate-3
 * different input.
 *
 * AND FOR A DEPRECATION RECORD GATE-3 CANNOT OBSERVE THE EDIT AT ALL. The edit
 * appends a family literal to `deprecatedFamilies` in model-registry.ts, and NO
 * file in the collector's suite glob (`src/__tests__/drift/**\/*.drift.ts`) reads
 * `deprecatedFamilies` — the only live model-family canary is the UNCLASSIFIED
 * direction (`unclassifiedFamilies`, live-minus-classified). The deprecation
 * direction (`detectDeprecatedFamilies`, classified-minus-live) is exercised only
 * OFFLINE with injected payloads. So a recorded deprecation provably cannot
 * change any collector output: gate-3 can neither confirm nor refute it, yet it
 * could still veto it on whatever unrelated drift the live suite happened to see
 * that morning. `assertNoLiveDeprecationCanary` below pins that premise, so if a
 * live deprecation canary is ever added this test reds and says to re-enable
 * gate-3 for the deprecation lane.
 *
 * The two fixture re-collects below are the two mornings' observations:
 *   * `recollect0812` is VERBATIM from the 2026-08-12 drift-report artifact
 *     (9131032270): zero entries, two quarantined Gemini Live WS timeouts.
 *   * `recollect0811` is a FAITHFUL RECONSTRUCTION, not a capture. The 08-11 run
 *     recorded only the COUNT ("1 critical diff(s)") — the gate prints no diff
 *     identity and `drift-report.sync-check.json` is never uploaded — so which
 *     diff it was is NOT recoverable from that run. The fixture therefore uses a
 *     real collector-emitted critical shape (the OpenAI Realtime WS-handshake
 *     diff, drift-report-collector.ts) standing in for "one critical diff
 *     somewhere in the live suite, unrelated to the gemini deprecations".
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { includeFamilies } from "./drift/model-registry.js";
import { MIN_LISTING_SIZE } from "./drift/deprecation-detector.js";
import {
  runDriftSyncCore,
  computeChangesetKey,
  SyncCoreReason,
  VOICE_SEED_SET_PROVIDER,
  MODEL_REGISTRY_REL_PATH,
  LOGIC_PIN_REL_PATH,
  type SyncCoreDeps,
  type SyncCoreOutcome,
  type ProviderChurnInput,
} from "../../scripts/drift-sync.js";
import { evaluateSyncCheck, SyncCheckReason } from "../../scripts/drift-sync-check.js";
import type { DriftReport } from "../../scripts/drift-types.js";

// ---------------------------------------------------------------------------
// The premise gate-3's deprecation-lane skip rests on.
// ---------------------------------------------------------------------------

const DRIFT_SUITE_DIR = "src/__tests__/drift";

/**
 * The collector runs exactly `src/__tests__/drift/**\/*.drift.ts`
 * (vitest.config.drift.ts). If none of those files reads `deprecatedFamilies`,
 * then appending to that ledger cannot change a single collector output — which
 * is precisely why gate-3 is skipped for a deprecation-only run.
 *
 * MUTATION-TESTABLE ON PURPOSE: add a live deprecation canary that imports
 * `deprecatedFamilies` into any `*.drift.ts` and this reds, pointing at the
 * `gate3CanObserveAppliedEdits` decision that must then change.
 */
function driftSuiteFilesReferencing(symbol: string): string[] {
  return readdirSync(DRIFT_SUITE_DIR)
    .filter((f) => f.endsWith(".drift.ts"))
    .filter((f) => readFileSync(join(DRIFT_SUITE_DIR, f), "utf-8").includes(symbol));
}

/**
 * The pin file as gate-1b sees it on these runs. Every changeset here edits the
 * REGISTRY only, so HEAD and the working tree agree and gate-1b is a no-op —
 * which is itself the property being modelled: gate-1b must not have an opinion
 * about a run that did not touch the pin file.
 */
const PIN_FILE_AT_HEAD = readFileSync(LOGIC_PIN_REL_PATH, "utf-8");

describe("premise: the live drift suite cannot observe a recorded deprecation", () => {
  it("no *.drift.ts in the collector's glob reads deprecatedFamilies", () => {
    expect(driftSuiteFilesReferencing("deprecatedFamilies")).toEqual([]);
  });

  it("the collector's glob DOES read includeFamilies (so the guard above is not vacuous)", () => {
    // Same read path, same glob, a symbol that IS present — proves the scan can
    // find a reference at all, so the empty result above is a real absence.
    expect(driftSuiteFilesReferencing("includeFamilies").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The premise `needsVoiceSeedSetEdit`'s provider scope rests on.
// ---------------------------------------------------------------------------

/**
 * `needsVoiceSeedSetEdit` routes a decided voice family to a human ONLY for
 * `VOICE_SEED_SET_PROVIDER`, on the premise that voice-drift DETECTION only ever
 * runs on that provider's `/models` listing. If detection ran on another
 * provider's listing, that provider's decided voice families would be
 * auto-applied, leave the canary red, fail gate-3 and revert every night.
 *
 * What this block checks, at runtime:
 *   * voice-models.ts exports exactly the names below. The detector and the
 *     mutable seed set are module-private, and adding an export turns this red.
 *   * The one export that runs detection, `detectOpenAIVoiceModelDrift(apiKey)`,
 *     fetches api.openai.com's listing and nothing else (observed below).
 *     voice-seed-set-entry.type-test.ts checks its argument shape under
 *     `pnpm typecheck`.
 *   * `VOICE_SEED_SET_PROVIDER` is "openai". That is a constant check only;
 *     nothing here ties the constant to the URL the entry fetches.
 *
 * KNOWN LIMIT (accepted, not guarded): the exported `isVoiceModelId` and
 * `isKnownVoiceModelFamily` can be composed into the same detection over any
 * listing. A new voice canary built that way on another provider's listing
 * would leave every test here green. Anyone reviewing a new voice canary must
 * check its provider scope against `VOICE_SEED_SET_PROVIDER` in
 * scripts/drift-sync.ts.
 */
const VOICE_MODELS_EXPORTS = [
  // Runs the detection, on the OpenAI listing it fetches itself.
  "detectOpenAIVoiceModelDrift",
  // Frozen GA list. Exported because the collector's NO_GA remediation path
  // names it, and drift-collector.test.ts requires that name to be an exported
  // declaration of a drift module.
  "gaRealtimeModels",
  // Read-only membership, for scripts/drift-sync.ts's needsVoiceSeedSetEdit.
  "isKnownVoiceModelFamily",
  // Pure id-shape matcher, no seed data; drift-sync needs it next to membership.
  "isVoiceModelId",
  // Sorted copy of the seed set, for logic-pin.test.ts's DATA_FROZEN pin.
  "listKnownVoiceModelFamilies",
];

describe("premise: voice-models.ts exposes detection only through the OpenAI entry (see KNOWN LIMIT)", () => {
  it("VOICE_SEED_SET_PROVIDER is openai", () => {
    // Only compares the constant to a literal. If the realtime canary moves to
    // another provider, change this, the URL below, and the constant together.
    expect(VOICE_SEED_SET_PROVIDER).toBe("openai");
  });

  it("voice-models.ts exports exactly the reviewed runtime names (detector and seed set stay private)", async () => {
    const voiceModels = await import("./drift/voice-models.js");
    expect(Object.keys(voiceModels).sort()).toEqual(VOICE_MODELS_EXPORTS);
  });

  it("the exported GA list cannot be mutated at runtime", async () => {
    const { gaRealtimeModels } = await import("./drift/voice-models.js");
    expect(Object.isFrozen(gaRealtimeModels)).toBe(true);
  });

  it("the entry fetches only the OpenAI /models listing and detects on it", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(input instanceof Request ? input.url : String(input));
        // Served in BOTH the OpenAI (`data[].id`) and Gemini (`models[].name`)
        // shapes, so a fetcher pointed elsewhere still parses and is caught by
        // the URL assertion, not by a parse error.
        const ids = ["gpt-realtime", "gpt-live-1-mini"];
        const body = { data: ids.map((id) => ({ id })), models: ids.map((name) => ({ name })) };
        return new Response(JSON.stringify(body));
      }),
    );
    try {
      const { detectOpenAIVoiceModelDrift } = await import("./drift/voice-models.js");
      const result = await detectOpenAIVoiceModelDrift("test-key");
      expect(urls).toEqual(["https://api.openai.com/v1/models"]);
      expect(result.unknown).toEqual(["gpt-live-1-mini"]);
      expect(result.hasGA).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures — the 2026-08-11/12 changeset.
// ---------------------------------------------------------------------------

/**
 * The two families the real runs recorded. Asserted present-and-usable rather
 * than assumed: `includeFamilies` and `deprecatedFamilies` both move under this
 * repo's own automation, and a fixture that silently stops describing a real
 * candidate would assert on an empty outcome list and pass vacuously.
 */
const RECORDED_PAIR = ["gemini-2.0-flash", "gemini-2.0-flash-lite"] as const;

function geminiLiveListingWithoutRecordedPair(): string[] {
  const missing = RECORDED_PAIR.filter((f) => !includeFamilies.gemini.has(f));
  if (missing.length > 0) {
    throw new Error(
      `this reconstruction needs ${RECORDED_PAIR.join(" + ")} to still be in ` +
        `includeFamilies.gemini, but ${missing.join(", ")} is absent — the 2026-08-11 ` +
        `changeset can no longer be reconstructed from the live registry. Re-derive the ` +
        `pair from includeFamilies.gemini rather than deleting the assertions.`,
    );
  }
  const surviving = [...includeFamilies.gemini].filter(
    (f) => !(RECORDED_PAIR as readonly string[]).includes(f),
  );
  // Families plus a dated snapshot of each, so the listing clears the
  // fail-closed floor (a short listing is skipped, never a removal signal).
  const ids = [...surviving, ...surviving.map((f) => `${f}-2025-01-01`)];
  if (ids.length < MIN_LISTING_SIZE.gemini) {
    throw new Error(
      `fixture listing has ${ids.length} raw id(s), below gemini's fail-closed floor of ` +
        `${MIN_LISTING_SIZE.gemini} — the detector would SKIP instead of reporting the pair.`,
    );
  }
  return ids;
}

function fixtureRegistrySource(): string {
  return [
    "export const includeFamilies = {",
    '  gemini: set("gemini", [',
    ...[...includeFamilies.gemini].map((f) => `    "${f}",`),
    "  ]),",
    "};",
    "export const deprecatedFamilies = {",
    '  gemini: set("gemini", [',
    "    // drift-sync appends recorded deprecations here.",
    "  ]),",
    "};",
  ].join("\n");
}

/** The 2026-08-11/12 provider inputs: gemini checked, the other two not credentialed. */
function churnInputs(): ProviderChurnInput[] {
  return [{ provider: "gemini", liveModelIds: geminiLiveListingWithoutRecordedPair() }];
}

// ---------------------------------------------------------------------------
// The two mornings' live re-collect observations.
// ---------------------------------------------------------------------------

/**
 * 2026-08-11: one critical diff somewhere in the live suite. Reconstruction —
 * see the file header for exactly what was and was not recoverable.
 */
function recollect0811(): DriftReport {
  return {
    timestamp: "2026-08-11T06:30:52.000Z",
    generatedAt: "2026-08-11T06:30:52.000Z",
    conclusion: "critical",
    entries: [
      {
        provider: "OpenAI Realtime",
        scenario: "WS handshake",
        builderFile: "src/responses.ts",
        builderFunctions: [],
        typesFile: null,
        sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
        diffs: [
          {
            severity: "critical",
            issue:
              "OpenAI Realtime WS handshake did not complete — the live API returned an " +
              "error event (invalid_request_error/session_expired).",
            path: "session.session_expired",
            expected: "(handshake completes: session.created/updated received)",
            real: "error invalid_request_error: session expired",
            mock: "<no mock leg — live handshake probe>",
            id: "ws-handshake:session_expired",
          },
        ],
      },
    ],
  };
}

/** 2026-08-12: VERBATIM from drift-report artifact 9131032270 — zero entries, two quarantines. */
function recollect0812(): DriftReport {
  const wsTimeout =
    "Error: waitUntil timeout after 30000ms. Collected 0 messages: [] bodies=[]\n" +
    "    at Timeout._onTimeout (/home/runner/work/aimock/aimock/src/__tests__/drift/ws-providers.ts:319:23)";
  return {
    timestamp: "2026-08-12T06:31:23.604Z",
    generatedAt: "2026-08-12T06:31:23.604Z",
    conclusion: "quarantine",
    entries: [],
    quarantine: [
      {
        provider: "unknown",
        testName: "Gemini Live WS drift > WS text event sequence and shapes match",
        rawLocation: "src/__tests__/drift/ws-providers.ts:319:23",
        message: wsTimeout,
      },
      {
        provider: "unknown",
        testName: "Gemini Live WS drift > WS tool call event sequence matches",
        rawLocation: "src/__tests__/drift/ws-providers.ts:319:23",
        message: wsTimeout,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Driving the REAL sync core through the REAL gate.
// ---------------------------------------------------------------------------

interface RunResult {
  outcome: SyncCoreOutcome;
  changesetKey: string;
  registrySource: string;
  reverted: string[];
  recollectCalls: number;
}

/**
 * Run the real `runDriftSyncCore` over the fixture changeset, with the real
 * `evaluateSyncCheck` as the gate. Only the leaf observations are injected: the
 * registry source text (in memory), the pin result, and the live re-collect
 * report. Every decision under test — the churn diff, the mechanical edit, the
 * gate composition, the skip decision, the revert — is real code.
 */
function runSync(recollect: () => DriftReport, inputs = churnInputs()): RunResult {
  let registrySource = fixtureRegistrySource();
  const reverted: string[] = [];
  let recollectCalls = 0;

  let logicPinSource = fixtureLogicPin();
  const deps: SyncCoreDeps = {
    isReferenced: (family) => family === "gemini-2.0-flash",
    isRecorded: () => false,
    readRegistrySource: () => registrySource,
    writeRegistrySource: (text) => {
      registrySource = text;
    },
    // The sync re-pins the membership checksum in the same run it applies a
    // classification, so a harness that omits these gets a (correct) refusal
    // rather than an applied edit.
    readLogicPinSource: () => logicPinSource,
    writeLogicPinSource: (text) => {
      logicPinSource = text;
    },
    readProposalNote: () => null,
    writeProposalNote: () => {
      throw new Error("this changeset writes no proposal note");
    },
    runSyncCheck: (opts) =>
      evaluateSyncCheck(
        {
          readCommittedPinFile: () => PIN_FILE_AT_HEAD,
          readWorkingPinFile: () => PIN_FILE_AT_HEAD,
          getChangedFiles: () => [MODEL_REGISTRY_REL_PATH],
          runPinCheck: () => ({ ok: true, output: "logic-pin.test.ts passed" }),
          recollect: () => {
            recollectCalls += 1;
            return recollect();
          },
        },
        opts,
      ),
    revertFiles: (paths) => reverted.push(...paths),
    now: () => new Date("2026-08-11T06:29:00.000Z"),
  };

  const outcome = runDriftSyncCore(inputs, deps);
  return {
    outcome,
    changesetKey: computeChangesetKey(outcome),
    registrySource,
    reverted,
    recollectCalls,
  };
}

// ---------------------------------------------------------------------------
// RED: the same changeset, two verdicts.
// ---------------------------------------------------------------------------

describe("the 2026-08-11/12 changeset key 74f6efa43753f7d0", () => {
  it("both mornings really are the SAME changeset (identical key, identical edit)", () => {
    const day1 = runSync(recollect0811);
    const day2 = runSync(recollect0812);

    // The premise of the whole investigation: the key does not distinguish them.
    expect(day1.changesetKey).toBe(day2.changesetKey);
    expect(day1.changesetKey).not.toBe("");
    expect(
      day1.outcome.outcomes.map((o) => `${o.action}:${o.provider}/${o.family}`).sort(),
    ).toEqual([
      "deprecation-recorded:gemini/gemini-2.0-flash",
      "deprecation-recorded:gemini/gemini-2.0-flash-lite",
    ]);
  });

  it("the mechanical edit is CORRECT on both mornings (+2 recorded, nothing else touched)", () => {
    for (const recollect of [recollect0811, recollect0812]) {
      const { registrySource } = runSync(recollect);
      for (const family of RECORDED_PAIR) {
        expect(registrySource).toContain(`"${family}"`);
      }
      // The ledger grew and includeFamilies did NOT shrink — the mock keeps serving.
      for (const family of includeFamilies.gemini) {
        expect(registrySource).toContain(`"${family}"`);
      }
    }
  });

  it("the gate reaches the SAME verdict on both mornings", () => {
    const day1 = runSync(recollect0811);
    const day2 = runSync(recollect0812);

    expect(day1.outcome.reason).toBe(day2.outcome.reason);
    expect(day1.outcome.ok).toBe(day2.outcome.ok);
  });

  it("neither morning reverts the correct edit", () => {
    expect(runSync(recollect0811).reverted).toEqual([]);
    expect(runSync(recollect0812).reverted).toEqual([]);
  });

  it("a deprecation-only run never pays for a live re-collect it cannot learn from", () => {
    expect(runSync(recollect0811).recollectCalls).toBe(0);
    expect(runSync(recollect0812).recollectCalls).toBe(0);
  });

  it("REPEAT-COUNT PROOF: 25 runs of each morning yield exactly ONE verdict", () => {
    const verdicts = new Set<string>();
    for (let i = 0; i < 25; i++) {
      for (const recollect of [recollect0811, recollect0812]) {
        const { outcome, changesetKey } = runSync(recollect);
        verdicts.add(`${changesetKey}|${outcome.reason}|${outcome.ok}`);
      }
    }
    expect([...verdicts]).toEqual([`74f6efa43753f7d0|${SyncCoreReason.OK_APPLIED}|true`]);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — a genuinely wrong edit is still caught.
// ---------------------------------------------------------------------------

/**
 * An `added` run: a human approved a brand-new family, so the sync appends it to
 * `includeFamilies`. THAT edit IS observable by the live suite — the unclassified
 * canary stops reporting the family once it is classified — so gate-3 must run
 * and must still veto a run whose re-collect proves the drift is unresolved.
 */
function approvedNewFamilyRun(recollect: () => DriftReport): RunResult {
  let registrySource = fixtureRegistrySource();
  const reverted: string[] = [];
  let recollectCalls = 0;
  let logicPinSource = fixtureLogicPin();
  const deps: SyncCoreDeps = {
    isReferenced: () => false,
    isRecorded: () => false,
    readRegistrySource: () => registrySource,
    writeRegistrySource: (text) => {
      registrySource = text;
    },
    // The sync re-pins the membership checksum in the same run it applies a
    // classification, so a harness that omits these gets a (correct) refusal
    // rather than an applied edit.
    readLogicPinSource: () => logicPinSource,
    writeLogicPinSource: (text) => {
      logicPinSource = text;
    },
    // An already-approved note for the new family — the sync applies it.
    readProposalNote: () => "Decision: include\n",
    writeProposalNote: () => {
      throw new Error("the note already exists");
    },
    runSyncCheck: (opts) =>
      evaluateSyncCheck(
        {
          readCommittedPinFile: () => PIN_FILE_AT_HEAD,
          readWorkingPinFile: () => PIN_FILE_AT_HEAD,
          getChangedFiles: () => [MODEL_REGISTRY_REL_PATH],
          runPinCheck: () => ({ ok: true, output: "logic-pin.test.ts passed" }),
          recollect: () => {
            recollectCalls += 1;
            return recollect();
          },
        },
        opts,
      ),
    revertFiles: (paths) => reverted.push(...paths),
    now: () => new Date("2026-08-11T06:29:00.000Z"),
  };
  // A live listing that carries the whole classified set PLUS one genuinely new
  // family, so the addition half fires and the deprecation half reports nothing.
  const families = [...includeFamilies.gemini];
  const outcome = runDriftSyncCore(
    [
      {
        provider: "gemini",
        liveModelIds: [
          ...families,
          ...families.map((f) => `${f}-2025-01-01`),
          "gemini-brand-new-family",
        ],
      },
    ],
    deps,
  );
  return {
    outcome,
    changesetKey: computeChangesetKey(outcome),
    registrySource,
    reverted,
    recollectCalls,
  };
}

function reportWithUnresolvedNewFamily(): DriftReport {
  return {
    timestamp: "2026-08-11T06:30:52.000Z",
    generatedAt: "2026-08-11T06:30:52.000Z",
    conclusion: "critical",
    entries: [
      {
        provider: "Google Gemini",
        scenario: "live /models family canary",
        builderFile: "src/responses.ts",
        builderFunctions: [],
        typesFile: null,
        sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
        diffs: [
          {
            severity: "critical",
            issue: 'Unclassified model family "gemini-brand-new-family" in gemini /models',
            path: "models/gemini-brand-new-family",
            expected: "(family in includeFamilies ∪ excludeFamilies)",
            real: "gemini-brand-new-family",
            mock: "<no mock leg — live /models family canary>",
          },
        ],
      },
    ],
  };
}

describe("negative controls — the gate still refuses a wrong edit", () => {
  it("an `added` run IS gate-3-observable, so the re-collect really runs", () => {
    const run = approvedNewFamilyRun(() => ({
      timestamp: "t",
      conclusion: "clean",
      entries: [],
    }));
    expect(run.outcome.outcomes.map((o) => o.action)).toContain("added");
    expect(run.recollectCalls).toBe(1);
    expect(run.outcome.reason).toBe(SyncCoreReason.OK_APPLIED);
  });

  it("WRONG EDIT: an `added` run whose re-collect still reports the family -> reverted", () => {
    const run = approvedNewFamilyRun(reportWithUnresolvedNewFamily);
    expect(run.outcome.ok).toBe(false);
    expect(run.outcome.reason).toBe(SyncCoreReason.GATE_FAILED);
    expect(run.outcome.detail).toContain(SyncCheckReason.RESIDUAL_CRITICAL_DRIFT);
    // Both mutated files revert: the registry edit AND the pin that was moved
    // to match it. Reverting one without the other leaves a lying canary.
    expect(run.reverted).toEqual([MODEL_REGISTRY_REL_PATH, LOGIC_PIN_REL_PATH]);
  });

  it("WRONG EDIT: an off-allowlist file -> reverted, gate-1 never reaches the re-collect", () => {
    const verdict = evaluateSyncCheck({
      readCommittedPinFile: () => PIN_FILE_AT_HEAD,
      readWorkingPinFile: () => PIN_FILE_AT_HEAD,
      getChangedFiles: () => [MODEL_REGISTRY_REL_PATH, "src/__tests__/drift/sdk-shapes.ts"],
      runPinCheck: () => ({ ok: true, output: "" }),
      recollect: () => {
        throw new Error("gate-1 must refuse before any re-collect");
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.OFF_ALLOWLIST_CHANGE);
  });

  it("WRONG EDIT: a moved classification pin -> refused even on the deprecation lane", () => {
    const verdict = evaluateSyncCheck(
      {
        readCommittedPinFile: () => PIN_FILE_AT_HEAD,
        readWorkingPinFile: () => PIN_FILE_AT_HEAD,
        getChangedFiles: () => [MODEL_REGISTRY_REL_PATH],
        runPinCheck: () => ({
          ok: false,
          output: "FAIL logic-pin.test.ts > freezes PREVIEW_FAMILY",
        }),
        recollect: () => {
          throw new Error("gate-2 must refuse before any re-collect");
        },
      },
      { skipRecollect: true, skipRecollectReason: "deprecation-record-only" },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.PIN_CHECK_FAILED);
  });
});

/** DATA_FROZEN stand-in covering every key this file's runs can move. */
function fixtureLogicPin(): string {
  const keys = [
    "includeFamilies.openai",
    "includeFamilies.anthropic",
    "includeFamilies.gemini",
    "excludeFamilies.openai",
    "excludeFamilies.anthropic",
    "excludeFamilies.gemini",
  ];
  return [
    "const DATA_FROZEN = {",
    ...keys.flatMap((k, i) => [`  "${k}": {`, `    pin: "${String(i).repeat(64)}",`, "  },"]),
    "};",
    "",
  ].join("\n");
}
