/**
 * Misbehavior is opt-in (`enableMisbehavior: true`): without it the
 * `misbehavior` option, fixture keys and the X-AIMock-Misbehavior header are
 * ignored, as in 1.44.0. The misbehavior suites test the feature itself, so
 * they build their servers through these, which turn it on unless a test
 * passes `enableMisbehavior: false`. The disabled behavior is tested in
 * misbehavior-opt-in.test.ts.
 */
import { LLMock as BaseLLMock } from "../../llmock.js";
import { createServer as baseCreateServer } from "../../server.js";
import type { ResolvedInboundAuth } from "../../api-key-auth.js";
import type { MockServerOptions } from "../../types.js";

function enabled(options: MockServerOptions | undefined): MockServerOptions {
  if (options === undefined) return { enableMisbehavior: true };
  options.enableMisbehavior ??= true;
  return options;
}

export class LLMock extends BaseLLMock {
  constructor(options?: MockServerOptions, resolvedInboundAuth?: ResolvedInboundAuth) {
    super(enabled(options), resolvedInboundAuth);
  }
}

export const createServer: typeof baseCreateServer = (fixtures, options, ...rest) =>
  baseCreateServer(fixtures, enabled(options), ...rest);
