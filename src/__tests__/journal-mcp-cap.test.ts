import { describe, expect, it } from "vitest";
import type { Fixture } from "../types.js";
import { Journal } from "../journal.js";

const fixture = { match: { userMessage: "x" }, response: { content: "y" } } as Fixture;

/** Test ids whose match counts the journal still holds after `n` distinct ids. */
function retained(option: number | undefined, n = 10): number {
  const journal = new Journal({ fixtureCountsMaxTestIds: option });
  for (let i = 0; i < n; i++) journal.incrementFixtureMatchCount(fixture, undefined, `t${i}`);
  let kept = 0;
  for (let i = 0; i < n; i++) if (journal.getFixtureMatchCount(fixture, `t${i}`) > 0) kept++;
  return kept;
}

const capOf = (option: number | undefined): number =>
  new Journal({ fixtureCountsMaxTestIds: option }).fixtureCountsMaxTestIdsCap;

describe("Journal.fixtureCountsMaxTestIdsCap against what the journal keeps", () => {
  it.each([1, 1.5, 3, 7.9])("is the number of test ids kept for cap option %s", (option) => {
    expect(capOf(option)).toBe(retained(option));
  });

  it.each([0.5, 0.001])(
    "for cap option %s the journal keeps no test id and the getter returns 1",
    (option) => {
      expect(retained(option)).toBe(0);
      expect(capOf(option)).toBe(1);
    },
  );
});
