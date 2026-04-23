/**
 * Chaos testing support for LLMock.
 *
 * Provides probabilistic failure injection — requests can be dropped (500),
 * returned with malformed JSON, or have the connection forcibly disconnected.
 *
 * Precedence: per-request headers > fixture-level config > server-level defaults.
 */

import type * as http from "node:http";
import type { ChaosAction, ChaosConfig, ChatCompletionRequest, Fixture } from "./types.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

/**
 * Resolve chaos config from headers, fixture, and server defaults.
 * Header values override fixture values, which override server defaults.
 */
function resolveChaosConfig(
  fixture: Fixture | null,
  serverDefaults?: ChaosConfig,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
): ChaosConfig {
  const base: ChaosConfig = { ...serverDefaults };

  // Fixture-level overrides server defaults
  if (fixture?.chaos) {
    if (fixture.chaos.dropRate !== undefined) base.dropRate = fixture.chaos.dropRate;
    if (fixture.chaos.malformedRate !== undefined) base.malformedRate = fixture.chaos.malformedRate;
    if (fixture.chaos.disconnectRate !== undefined)
      base.disconnectRate = fixture.chaos.disconnectRate;
  }

  // Header overrides everything
  if (rawHeaders) {
    const dropHeader = rawHeaders["x-aimock-chaos-drop"];
    const malformedHeader = rawHeaders["x-aimock-chaos-malformed"];
    const disconnectHeader = rawHeaders["x-aimock-chaos-disconnect"];

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
  }

  // Clamp all resolved rates to [0, 1] regardless of source.
  // Header values are already clamped above; this covers fixture-level and server defaults.
  if (base.dropRate !== undefined) base.dropRate = Math.min(1, Math.max(0, base.dropRate));
  if (base.malformedRate !== undefined)
    base.malformedRate = Math.min(1, Math.max(0, base.malformedRate));
  if (base.disconnectRate !== undefined)
    base.disconnectRate = Math.min(1, Math.max(0, base.disconnectRate));

  return base;
}

/**
 * Evaluate chaos config and return the triggered action, or null if none.
 * Checks in order: drop, malformed, disconnect — first hit wins.
 */
export function evaluateChaos(
  fixture: Fixture | null,
  serverDefaults?: ChaosConfig,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
): ChaosAction | null {
  const config = resolveChaosConfig(fixture, serverDefaults, rawHeaders, logger);

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
    config.disconnectRate !== undefined &&
    config.disconnectRate > 0 &&
    Math.random() < config.disconnectRate
  ) {
    return "disconnect";
  }

  return null;
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
 * `source` is required so the invariant "this handler only applies chaos in
 * the <X> phase" is enforced at the type level. A future handler that grows
 * a proxy path MUST pass `"proxy"` explicitly; the default can't drift silently.
 */
export function applyChaos(
  res: http.ServerResponse,
  fixture: Fixture | null,
  serverDefaults: ChaosConfig | undefined,
  rawHeaders: http.IncomingHttpHeaders,
  journal: Journal,
  context: ChaosJournalContext,
  source: "fixture" | "proxy",
  registry?: MetricsRegistry,
  logger?: Logger,
): boolean {
  const action = evaluateChaos(fixture, serverDefaults, rawHeaders, logger);
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
  source: "fixture" | "proxy",
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
