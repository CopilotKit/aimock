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
import type { MetricsRegistry } from "./metrics.js";

/**
 * Resolve chaos config from headers, fixture, and server defaults.
 * Header values override fixture values, which override server defaults.
 */
function resolveChaosConfig(
  fixture: Fixture | null,
  serverDefaults?: ChaosConfig,
  rawHeaders?: http.IncomingHttpHeaders,
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
    const dropHeader = rawHeaders["x-llmock-chaos-drop"];
    const malformedHeader = rawHeaders["x-llmock-chaos-malformed"];
    const disconnectHeader = rawHeaders["x-llmock-chaos-disconnect"];

    if (typeof dropHeader === "string") {
      const val = parseFloat(dropHeader);
      if (isNaN(val)) {
        console.warn(`[chaos] x-llmock-chaos-drop: invalid value "${dropHeader}", ignoring`);
      } else {
        if (val < 0 || val > 1) {
          console.warn(`[chaos] x-llmock-chaos-drop: value ${val} out of range [0,1], clamping`);
        }
        base.dropRate = Math.min(1, Math.max(0, val));
      }
    }
    if (typeof malformedHeader === "string") {
      const val = parseFloat(malformedHeader);
      if (isNaN(val)) {
        console.warn(
          `[chaos] x-llmock-chaos-malformed: invalid value "${malformedHeader}", ignoring`,
        );
      } else {
        if (val < 0 || val > 1) {
          console.warn(
            `[chaos] x-llmock-chaos-malformed: value ${val} out of range [0,1], clamping`,
          );
        }
        base.malformedRate = Math.min(1, Math.max(0, val));
      }
    }
    if (typeof disconnectHeader === "string") {
      const val = parseFloat(disconnectHeader);
      if (isNaN(val)) {
        console.warn(
          `[chaos] x-llmock-chaos-disconnect: invalid value "${disconnectHeader}", ignoring`,
        );
      } else {
        if (val < 0 || val > 1) {
          console.warn(
            `[chaos] x-llmock-chaos-disconnect: value ${val} out of range [0,1], clamping`,
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
): ChaosAction | null {
  const config = resolveChaosConfig(fixture, serverDefaults, rawHeaders);

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
  body: ChatCompletionRequest;
}

/**
 * Apply chaos to a request. Returns true if chaos was applied (caller should
 * return early), false if the request should proceed normally.
 */
export function applyChaos(
  res: http.ServerResponse,
  fixture: Fixture | null,
  serverDefaults: ChaosConfig | undefined,
  rawHeaders: http.IncomingHttpHeaders,
  journal: Journal,
  context: ChaosJournalContext,
  registry?: MetricsRegistry,
): boolean {
  const action = evaluateChaos(fixture, serverDefaults, rawHeaders);
  if (!action) return false;

  if (registry) {
    registry.incrementCounter("llmock_chaos_triggered_total", { action });
  }

  switch (action) {
    case "drop": {
      journal.add({
        ...context,
        response: { status: 500, fixture, chaosAction: "drop" },
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
      return true;
    }
    case "malformed": {
      journal.add({
        ...context,
        response: { status: 200, fixture, chaosAction: "malformed" },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{malformed json: <<<chaos>>>");
      return true;
    }
    case "disconnect": {
      journal.add({
        ...context,
        response: { status: 0, fixture, chaosAction: "disconnect" },
      });
      res.destroy();
      return true;
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return false;
    }
  }
}
