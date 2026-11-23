/** Raw primary WebSocket canary; OpenAI 4.x has no Live SDK types. */
import { describe, expect, it } from "vitest";
import { formatDriftReport } from "./schema.js";
import { compareLiveInvariants, runLiveProvider, runLiveMock } from "./live-scenarios.js";

const key = process.env.OPENAI_API_KEY;

describe.skipIf(!key)("OpenAI Live API drift", () => {
  for (const mode of ["client", "managed"] as const) {
    it(`${mode} lifecycle`, async () => {
      if (!key) throw new Error("OPENAI_API_KEY is absent");
      const real = await runLiveProvider(mode, key);
      const mock = await runLiveMock(mode);
      const diffs = compareLiveInvariants(mode, real, mock);
      // Registry attribution is provided by the collector integration slot.
      // Avoid formatting an empty report: that would hide a missing registry
      // entry behind an unrelated failure on otherwise successful wire legs.
      expect(
        diffs,
        diffs.length
          ? formatDriftReport(`OpenAI Live (${mode} lifecycle)`, diffs, "openai-live")
          : undefined,
      ).toEqual([]);
    }, 95_000);
  }
});
