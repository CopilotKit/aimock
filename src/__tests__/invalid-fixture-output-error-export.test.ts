import { describe, expect, it } from "vitest";
import * as aimock from "../index.js";
import { InvalidFixtureOutputError as FromHelpers, fixtureFiles } from "../helpers.js";

describe("InvalidFixtureOutputError export", () => {
  it("is exported from the package entry point as the class the helpers throw", () => {
    expect(aimock.InvalidFixtureOutputError).toBe(FromHelpers);
    let thrown: unknown;
    try {
      fixtureFiles("not-an-array");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(aimock.InvalidFixtureOutputError);
  });
});
