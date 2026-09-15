/**
 * Chaos testing support for LLMock.
 *
 * Provides probabilistic failure injection — requests can be dropped (500),
 * returned with malformed JSON, or have the connection forcibly disconnected.
 *
 * Precedence: per-request headers > fixture-level config > server-level defaults
 * (and the server level is itself scoped per `X-Test-Id` — see `ChaosScope`).
 */

import type * as http from "node:http";
import type {
  ChaosAction,
  ChaosConfig,
  ChaosDefaults,
  ChaosScope,
  ChatCompletionRequest,
  Fixture,
} from "./types.js";
import { writeErrorResponse } from "./sse-writer.js";
import { resolveTestId } from "./helpers.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

/**
 * Narrow the server-defaults argument. A `ChaosScope` is distinguishable from a
 * `ChaosConfig` by construction: the latter only ever carries the three rates.
 */
export function isChaosScope(defaults: ChaosDefaults): defaults is ChaosScope {
  return "base" in defaults || "byTestId" in defaults;
}

/**
 * Pick the server-level chaos config that applies to THIS request: the override
 * installed for its testId, else the server-wide baseline. The testId is
 * resolved by `resolveTestId` — the same helper `getTestId` and the control API
 * use — so a harness that tags by `?testId=` lands in the same scope its chaos
 * override was stored under, and the two sides cannot disagree.
 */
function resolveScopedDefaults(
  serverDefaults: ChaosDefaults | undefined,
  rawHeaders?: http.IncomingHttpHeaders,
  url?: string,
): ChaosConfig | undefined {
  if (!serverDefaults) return undefined;
  if (!isChaosScope(serverDefaults)) return serverDefaults;
  const scoped = serverDefaults.byTestId?.get(resolveTestId(rawHeaders ?? {}, url));
  if (scoped) return scoped;
  return serverDefaults.base;
}

/**
 * Resolve chaos config from headers, fixture, and server defaults.
 * Header values override fixture values, which override server defaults
 * (which are themselves per-testId — see `ChaosScope`).
 */
function resolveChaosConfig(
  fixture: Fixture | null,
  serverDefaults?: ChaosDefaults,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
  url?: string,
): ChaosConfig {
  const base: ChaosConfig = { ...resolveScopedDefaults(serverDefaults, rawHeaders, url) };

  // Fixture-level overrides server defaults
  if (fixture?.chaos) {
    if (fixture.chaos.dropRate !== undefined) base.dropRate = fixture.chaos.dropRate;
    if (fixture.chaos.malformedRate !== undefined) base.malformedRate = fixture.chaos.malformedRate;
    if (fixture.chaos.disconnectRate !== undefined)
      base.disconnectRate = fixture.chaos.disconnectRate;
    if (fixture.chaos.latencyMs !== undefined) base.latencyMs = fixture.chaos.latencyMs;
    if (fixture.chaos.rateLimitRate !== undefined) base.rateLimitRate = fixture.chaos.rateLimitRate;
  }

  // Header overrides everything
  if (rawHeaders) {
    const dropHeader = rawHeaders["x-aimock-chaos-drop"];
    const malformedHeader = rawHeaders["x-aimock-chaos-malformed"];
    const disconnectHeader = rawHeaders["x-aimock-chaos-disconnect"];
    const latencyHeader = rawHeaders["x-aimock-chaos-latency"];
    const rateLimitHeader = rawHeaders["x-aimock-chaos-ratelimit"];

    if (typeof dropHeader === "string") {
      const val = parseFloat(dropHeader);
      if (isNaN(val)) {
        logger?.warn(`[chaos] x-aimock-chaos-drop: invalid value "${dropHeader}", ignoring`);
      } else {
        if (val < 0 || val > 1) {
          logger?.warn(`[chaos] x-aimock-chaos-drop: value ${val} out of range [0,1], clamping`);
        }
        base.dropRate = Math.min(1, Math.max(0, val));
      }
    }
    if (typeof malformedHeader === "string") {
      const val = parseFloat(malformedHeader);
      if (isNaN(val)) {
        logger?.warn(
          `[chaos] x-aimock-chaos-malformed: invalid value "${malformedHeader}", ignoring`,
        );
      } else {
        if (val < 0 || val > 1) {
          logger?.warn(
            `[chaos] x-aimock-chaos-malformed: value ${val} out of range [0,1], clamping`,
          );
        }
        base.malformedRate = Math.min(1, Math.max(0, val));
      }
    }
    if (typeof disconnectHeader === "string") {
      const val = parseFloat(disconnectHeader);
      if (isNaN(val)) {
        logger?.warn(
          `[chaos] x-aimock-chaos-disconnect: invalid value "${disconnectHeader}", ignoring`,
        );
      } else {
        if (val < 0 || val > 1) {
          logger?.warn(
            `[chaos] x-aimock-chaos-disconnect: value ${val} out of range [0,1], clamping`,
          );
        }
        base.disconnectRate = Math.min(1, Math.max(0, val));
      }
    }
    if (typeof latencyHeader === "string") {
      const val = parseFloat(latencyHeader);
      if (isNaN(val)) {
        logger?.warn(`[chaos] x-aimock-chaos-latency: invalid value "${latencyHeader}", ignoring`);
      } else {
        if (val < 0 || val > 30000) {
          logger?.warn(
            `[chaos] x-aimock-chaos-latency: value ${val} out of range [0,30000], clamping`,
          );
        }
        base.latencyMs = Math.min(30000, Math.max(0, val));
      }
    }
    if (typeof rateLimitHeader === "string") {
      const val = parseFloat(rateLimitHeader);
      if (isNaN(val)) {
        logger?.warn(
          `[chaos] x-aimock-chaos-ratelimit: invalid value "${rateLimitHeader}", ignoring`,
        );
      } else {
        if (val < 0 || val > 1) {
          logger?.warn(
            `[chaos] x-aimock-chaos-ratelimit: value ${val} out of range [0,1], clamping`,
          );
        }
        base.rateLimitRate = Math.min(1, Math.max(0, val));
      }
    }
  }

  // Clamp all resolved rates to [0, 1] regardless of source.
  // Header values are already clamped above; this covers fixture-level and server defaults.
  if (base.dropRate !== undefined) base.dropRate = Math.min(1, Math.max(0, base.dropRate));
  if (base.malformedRate !== undefined)
    base.malformedRate = Math.min(1, Math.max(0, base.malformedRate));
  if (base.disconnectRate !== undefined)
    base.disconnectRate = Math.min(1, Math.max(0, base.disconnectRate));
  if (base.rateLimitRate !== undefined)
    base.rateLimitRate = Math.min(1, Math.max(0, base.rateLimitRate));
  if (base.latencyMs !== undefined) base.latencyMs = Math.min(30000, Math.max(0, base.latencyMs));

  return base;
}

/**
 * Resolve the deterministic latency delay (ms) for this request.
 * Precedence is header > fixture > server, same as the rates. Returns 0
 * when no latency is configured. Exported so async handlers can await the
 * delay BEFORE evaluating terminal chaos actions.
 */
export function resolveChaosLatencyMs(
  fixture: Fixture | null,
  serverDefaults?: ChaosDefaults,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
  url?: string,
): number {
  const config = resolveChaosConfig(fixture, serverDefaults, rawHeaders, logger, url);
  return config.latencyMs ?? 0;
}

/**
 * Evaluate chaos config and return the triggered action, or null if none.
 * Checks in order: drop, malformed, rateLimit, disconnect — first hit wins.
 */
export function evaluateChaos(
  fixture: Fixture | null,
  serverDefaults?: ChaosDefaults,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
  url?: string,
): ChaosAction | null {
  const config = resolveChaosConfig(fixture, serverDefaults, rawHeaders, logger, url);

  if (config.dropRate !== undefined && config.dropRate > 0 && Math.random() < config.dropRate) {
    return "drop";
  }
  if (
    config.malformedRate !== undefined &&
    config.malformedRate > 0 &&
    Math.random() < config.malformedRate
  ) {
    return "malformed";
  }
  if (
    config.rateLimitRate !== undefined &&
    config.rateLimitRate > 0 &&
    Math.random() < config.rateLimitRate
  ) {
    return "rateLimit";
  }
  if (
    config.disconnectRate !== undefined &&
    config.disconnectRate > 0 &&
    Math.random() < config.disconnectRate
  ) {
    return "disconnect";
  }

  return null;
}

/**
 * Async chaos entrypoint: awaits the deterministic latency delay (when
 * configured) BEFORE rolling terminal actions. Returns true when a terminal
 * action fired (caller returns early), false to proceed. Existing sync
 * `applyChaos` callers are untouched — this is additive.
 */
export async function applyChaosAsync(
  res: http.ServerResponse,
  fixture: Fixture | null,
  serverDefaults: ChaosDefaults | undefined,
  rawHeaders: http.IncomingHttpHeaders,
  requestUrl: string | undefined,
  journal: Journal,
  context: ChaosJournalContext,
  source: "fixture" | "proxy" | "internal",
  registry?: MetricsRegistry,
  logger?: Logger,
): Promise<boolean> {
  const delayMs = resolveChaosLatencyMs(fixture, serverDefaults, rawHeaders, logger, requestUrl);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return applyChaos(
    res,
    fixture,
    serverDefaults,
    rawHeaders,
    requestUrl,
    journal,
    context,
    source,
    registry,
    logger,
  );
}

interface ChaosJournalContext {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: ChatCompletionRequest | null;
}

/**
 * Apply chaos to a request. Returns true if chaos was applied (caller should
 * return early), false if the request should proceed normally.
 *
 * `requestUrl` is the RAW `req.url` (query string included) — chaos scoping
 * resolves the testId from it exactly as `getTestId` does, so `?testId=` tagged
 * traffic is not silently unscoped. It is required, not optional, so a new
 * handler cannot forget it.
 *
 * `source` is required so the invariant "this handler only applies chaos in
 * the <X> phase" is enforced at the type level. A future handler that grows
 * a proxy path MUST pass `"proxy"` explicitly; the default can't drift silently.
 */
export function applyChaos(
  res: http.ServerResponse,
  fixture: Fixture | null,
  serverDefaults: ChaosDefaults | undefined,
  rawHeaders: http.IncomingHttpHeaders,
  requestUrl: string | undefined,
  journal: Journal,
  context: ChaosJournalContext,
  source: "fixture" | "proxy" | "internal",
  registry?: MetricsRegistry,
  logger?: Logger,
): boolean {
  const action = evaluateChaos(fixture, serverDefaults, rawHeaders, logger, requestUrl);
  if (!action) return false;
  applyChaosAction(action, res, fixture, journal, context, source, registry);
  return true;
}

/**
 * Apply a specific (already-rolled) chaos action. Exposed so callers that roll
 * the dice themselves can dispatch without re-rolling — important when the
 * caller wants to branch on the action before committing (e.g. pre-flight vs.
 * post-response phases).
 *
 * `source` is required (not optional) so callers can't silently omit it on
 * one branch and journal an ambiguous entry. Pass `"fixture"` when a fixture
 * matched (or would have) and `"proxy"` when the request was headed for the
 * proxy path.
 */
export function applyChaosAction(
  action: ChaosAction,
  res: http.ServerResponse,
  fixture: Fixture | null,
  journal: Journal,
  context: ChaosJournalContext,
  source: "fixture" | "proxy" | "internal",
  registry?: MetricsRegistry,
): void {
  if (registry) {
    registry.incrementCounter("aimock_chaos_triggered_total", { action, source });
  }

  switch (action) {
    case "drop": {
      journal.add({
        ...context,
        response: { status: 500, fixture, chaosAction: "drop", source },
      });
      writeErrorResponse(
        res,
        500,
        JSON.stringify({
          error: {
            message: "Chaos: request dropped",
            type: "server_error",
            code: "chaos_drop",
          },
        }),
      );
      return;
    }
    case "malformed": {
      journal.add({
        ...context,
        response: { status: 200, fixture, chaosAction: "malformed", source },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{malformed json: <<<chaos>>>");
      return;
    }
    case "rateLimit": {
      journal.add({
        ...context,
        response: { status: 429, fixture, chaosAction: "rateLimit", source },
      });
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "1",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1",
      });
      res.end(
        JSON.stringify({
          error: {
            message: "Chaos: rate limit exceeded",
            type: "rate_limit_error",
            code: "chaos_ratelimit",
          },
        }),
      );
      return;
    }
    case "disconnect": {
      journal.add({
        ...context,
        response: { status: 0, fixture, chaosAction: "disconnect", source },
      });
      res.destroy();
      return;
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return;
    }
  }
}
