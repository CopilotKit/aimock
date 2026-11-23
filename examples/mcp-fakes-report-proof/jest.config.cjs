/* global module */
/** The Jest half of the HC1 proof: only the CommonJS tests under `jest/`. */
module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/jest/**/*.test.cjs"],
};
