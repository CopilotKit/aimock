// The recorded session: one test id, five tool calls (the same set as
// examples/mcp-record-proof). The record client and the Mastra agent test
// both import this; python/replay.py keeps its own copy of the same list.

/** The test id the recording is scoped to (`?testId=` on the MCP URL). */
export const TEST_ID = "mcp › record";

/** @type {[string, Record<string, unknown>][]} [tool name, arguments], in call order. */
export const CALLS = [
  ["echo", { message: "hi" }],
  ["get-sum", { a: 1, b: 2 }],
  ["get-structured-content", { location: "New York" }],
  ["trigger-long-running-operation", { duration: 2, steps: 2 }],
  ["get-env", {}],
];
