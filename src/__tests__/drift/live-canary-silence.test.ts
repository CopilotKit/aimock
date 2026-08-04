/**
 * ANTI-SILENCE guard for the live TEXT-lane model-family canary — a
 * fetch-stubbed, OFFLINE, end-to-end harness over the real chain.
 *
 * RECORD CORRECTION. Commit `4b26308` ("test(drift): move the live-canary
 * anti-silence work to the guard PR (#349)") removed the previous anti-silence
 * mechanism and said the work had moved to #349. It had not: #349 has since
 * merged and neither `LIVE_CANARY_LEGS` nor the `freezes liveLeg.*` pins exist
 * on it or on `main` — `git grep LIVE_CANARY_LEGS` returns nothing. The work was
 * DELETED, not moved. The commit message on main cannot be rewritten, so this
 * file is where the coverage actually landed. The original mechanism pinned
 * SPANS OF TEXT and was defeated four times at four successive frames (detector,
 * `describe.skipIf` gate, call site, fetcher); one of those pins even held
 * regardless of production code, because the substring it matched is supplied by
 * vitest's own `toEqual` diff output. Text-span pinning cannot close this class
 * by extension, so this harness observes the chain's OUTPUT instead.
 *
 * WHAT IT DOES. `globalThis.fetch` is stubbed to serve a provider `/models`
 * payload containing families that no classification rule covers, then the REAL
 * chain is driven — `listOpenAIModels` (the fetcher) →
 * `runUnclassifiedFamilyCanary` (the canary's call site) →
 * `assertNoUnclassifiedFamilies` → `unclassifiedFamilies` (the detector) →
 * `formatDriftReport` (the formatter) — and the assertion is BEHAVIOURAL: a
 * failure must come out, and its text must parse through the collector's own
 * `parseDriftBlock` into a `critical` entry per offending family, carrying the
 * `API DRIFT DETECTED:` marker the collector routes on. Silencing at ANY of
 * those four frames reddens this file.
 *
 * Parsing the failure with the REAL collector — rather than substring-matching
 * the family name — is what keeps the assertion non-vacuous: vitest's diff does
 * print the family names, but it cannot produce the numbered
 * `[critical] … / Path: / SDK: / Real: / Mock:` block `parseDriftBlock` requires.
 *
 * OFFLINE BY CONSTRUCTION. The stub is installed per-test and throws on any URL
 * other than the provider listing endpoint, so this file cannot reach the
 * network even if the chain changes which host it calls; the recorded URL list is
 * asserted too, which also proves the fetcher really ran rather than being
 * bypassed. No API key is read from the environment — a literal placeholder is
 * passed in.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runUnclassifiedFamilyCanary } from "./text-drift.js";
import { includeFamilies } from "./model-registry.js";
import { parseDriftBlock, extractProviderName } from "../../../scripts/drift-report-collector.js";

/** The only URL this suite's stub will serve. Anything else throws. */
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/** Verbatim the context string the OpenAI live leg in `models.drift.ts` passes. */
const CANARY_CONTEXT = "OpenAI Chat (live /models family canary)";

/**
 * The literal the collector routes on — verified against the header regex in
 * `scripts/drift-report-collector.ts`'s `parseDriftBlock`
 * (`text.match(/API DRIFT DETECTED:\s*(.+)/)`), and emitted by
 * `formatDriftReport` in `schema.ts`.
 */
const DRIFT_MARKER = "API DRIFT DETECTED:";

/**
 * Synthetic families that no rule classifies, deliberately TWO of them and
 * deliberately named nothing else in the repo uses: a detector special-cased to
 * keep one example family and drop the rest would still red this harness.
 * Single-digit tails are not stripped by `normalizeModelFamily`, so each id
 * normalizes to itself. Sorted, because `unclassifiedFamilies` sorts.
 */
const UNCLASSIFIED_FAMILIES = ["gpt-quasar-7", "gpt-zephyr"];

/** A listing every classification rule already covers — the negative control. */
function fullyClassifiedListing(): string[] {
  return [...includeFamilies.openai];
}

let fetchedUrls: string[] = [];
let realFetch: typeof globalThis.fetch;

function stubModelsListing(modelIds: string[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchedUrls.push(url);
    if (url !== OPENAI_MODELS_URL) {
      throw new Error(
        `OFFLINE HARNESS: refusing to reach ${url} — this suite makes no network calls`,
      );
    }
    return new Response(JSON.stringify({ data: modelIds.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

/**
 * Drive the real canary leg against a stubbed listing. Returns the failure
 * message, or `null` if the chain produced no failure at all (i.e. it is
 * silent).
 */
async function driveCanary(modelIds: string[]): Promise<string | null> {
  stubModelsListing(modelIds);
  try {
    await runUnclassifiedFamilyCanary("openai", "sk-offline-stub-not-a-real-key", CANARY_CONTEXT);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  fetchedUrls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("live TEXT-lane family canary: end-to-end anti-silence harness", () => {
  it("emits a collector-routable drift report when the live listing carries an unclassified family", async () => {
    const message = await driveCanary([...fullyClassifiedListing(), ...UNCLASSIFIED_FAMILIES]);

    expect(
      message,
      "the canary chain produced NO failure for a listing containing unclassified families — " +
        "it is SILENCED somewhere between the fetcher and the assertion",
    ).not.toBeNull();

    // The fetcher really ran, through the stub, and reached nothing else.
    expect(fetchedUrls).toEqual([OPENAI_MODELS_URL]);

    // The marker the collector routes on must be in the payload.
    expect(message).toContain(DRIFT_MARKER);

    // …and the payload must actually PARSE through the collector's own parser,
    // which no amount of vitest diff noise can satisfy.
    const block = parseDriftBlock(message!);
    expect(
      block,
      "the failure text does not parse as a drift block — the collector would quarantine it",
    ).not.toBeNull();
    expect(block!.context).toBe(CANARY_CONTEXT);
    expect(extractProviderName(block!.context)).toBe("OpenAI Chat");

    // One critical entry per offending family, each naming the family.
    expect(block!.diffs.map((d) => d.path).sort()).toEqual(
      UNCLASSIFIED_FAMILIES.map((family) => `models/${family}`),
    );
    expect(block!.diffs.map((d) => d.severity)).toEqual(
      UNCLASSIFIED_FAMILIES.map(() => "critical"),
    );
    for (const family of UNCLASSIFIED_FAMILIES) {
      expect(block!.diffs.some((d) => d.issue.includes(family))).toBe(true);
      expect(block!.diffs.some((d) => d.real === family)).toBe(true);
    }
  });

  it("KNOWN-NEGATIVE control: stays green when every family in the listing is classified", async () => {
    const message = await driveCanary(fullyClassifiedListing());

    expect(
      message,
      "a fully-classified listing produced a drift failure — this guard fires on healthy input",
    ).toBeNull();
    expect(fetchedUrls).toEqual([OPENAI_MODELS_URL]);
  });

  it("is offline by construction: the stub refuses every URL but the listing endpoint", async () => {
    stubModelsListing(fullyClassifiedListing());

    await expect(globalThis.fetch("https://api.openai.com/v1/chat/completions")).rejects.toThrow(
      /OFFLINE HARNESS: refusing to reach/,
    );
    expect(fetchedUrls).toEqual(["https://api.openai.com/v1/chat/completions"]);
  });
});
