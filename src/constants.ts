/** Sentinel testId used when no explicit test scope is provided. */
export const DEFAULT_TEST_ID = "__default__";

/**
 * Longest text (in characters) an `echo` of one value produces in an error
 * message, a bad-block detail or a `firstDifference` side. A longer value is
 * cut so that the kept part, `…` and the count of chars left out together
 * fit in this limit. Exported from mcp-fakes.ts as well.
 */
export const MCP_FAKES_ECHO_LIMIT = 200;
