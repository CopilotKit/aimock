import type { FixtureToolCall } from "../../types.js";

/**
 * The `arguments` of a collapsed function call. Collapse results type
 * `toolCalls` as {@link FixtureToolCall} (a Responses custom call has `input`,
 * not `arguments`), so tests that read `arguments` narrow here; a custom call
 * fails the test.
 */
export function fnArgs(tc: FixtureToolCall | undefined): string {
  if (!tc || tc.type === "custom") {
    throw new Error(`expected a function tool call, got ${JSON.stringify(tc)}`);
  }
  return tc.arguments;
}
