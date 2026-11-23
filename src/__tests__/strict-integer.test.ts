import { describe, it, expect } from "vitest";
import { parseStrictIntegerText } from "../helpers.js";

// Grammar gate shared by the files `limit`, fine-tuning `limit` and chaos
// integer fields (see the docblock on parseStrictIntegerText): digit run or
// nothing. Anything `Number()` would read more liberally is refused.
describe("parseStrictIntegerText", () => {
  it("accepts plain digit runs", () => {
    expect(parseStrictIntegerText("0")).toBe(0);
    expect(parseStrictIntegerText("20")).toBe(20);
    expect(parseStrictIntegerText("007")).toBe(7);
    expect(parseStrictIntegerText("10000")).toBe(10000);
  });

  it("refuses every spelling Number() would read liberally", () => {
    for (const bad of [
      "",
      " 5",
      "5 ",
      "5\n",
      "+5",
      "-5",
      "-0",
      "0x10",
      "0b1",
      "1e3",
      "1E3",
      "Infinity",
      "5.0",
      "0.5",
      ".5",
      "5.",
      "1_0",
      "banana",
      "5abc",
    ]) {
      expect(parseStrictIntegerText(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuses digit runs past the safe-integer range", () => {
    expect(parseStrictIntegerText("9".repeat(30))).toBeNull();
    expect(parseStrictIntegerText(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseStrictIntegerText(`${Number.MAX_SAFE_INTEGER + 1}`)).toBeNull();
  });
});
