/**
 * Chaos testing support for LLMock.
 *
 * Provides probabilistic failure injection — requests can be dropped (500),
 * returned with malformed JSON, or have the connection forcibly disconnected.
 *
 * Precedence: per-request headers > fixture-level config > server-level defaults.
 *
 * Whether an action fires is decided by a seeded draw rather than
 * `Math.random()`, so a run that injected a fault can be replayed by feeding
 * its seed back. See ./chaos-random.ts for the properties that buys.
 */

import type * as http from "node:http";
import type { ChaosAction, ChaosConfig, ChatCompletionRequest, Fixture } from "./types.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";
import { createHash } from "node:crypto";
import { rawBodyBytes } from "./helpers.js";
import {
  ChaosRandomizer,
  createJitterSource,
  normalizeChaosSeed,
  type ChaosDraws,
  type JitterSource,
} from "./chaos-random.js";

/** Overrides the effective seed for one request. */
export const CHAOS_SEED_HEADER = "x-aimock-chaos-seed";
const CHAOS_SEED_ENCODING_HEADER = "x-aimock-chaos-seed-encoding";

/** Keep every configured seed intact while making header reports reversible. */
export function reportChaosSeedHeader(res: http.ServerResponse, seed: string): void {
  // HTTP trims outer whitespace and cannot carry arbitrary Unicode/control
  // characters. The companion header is used only when encoding is necessary;
  // a literal base64-looking seed remains literal without that companion.
  if (/^[\t\x20-\x7e\x80-\xff]*$/.test(seed) && !/^[\t ]|[\t ]$/.test(seed)) {
    res.setHeader(CHAOS_SEED_HEADER, seed);
    return;
  }
  // JSON escaping preserves even an unpaired UTF-16 surrogate in a JS seed.
  res.setHeader(CHAOS_SEED_HEADER, Buffer.from(JSON.stringify(seed), "utf8").toString("base64url"));
  res.setHeader(CHAOS_SEED_ENCODING_HEADER, "json-base64url");
}

function readChaosSeedHeader(headers: http.IncomingHttpHeaders): string | null {
  const supplied = headers[CHAOS_SEED_HEADER];
  if (typeof supplied !== "string") return null;
  if (headers[CHAOS_SEED_ENCODING_HEADER] !== "json-base64url") return supplied;
  if (!/^[A-Za-z0-9_-]+$/.test(supplied)) return null;
  const bytes = Buffer.from(supplied, "base64url");
  if (bytes.toString("base64url") !== supplied) return null;
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) return null;
  try {
    const seed: unknown = JSON.parse(decoded);
    return typeof seed === "string" ? seed : null;
  } catch {
    return null;
  }
}

/**
 * Overrides the chaos key, which is otherwise derived from the request. Lets a
 * caller group requests that differ in some field it does not care about, or
 * split ones that are identical on the wire.
 */
export const CHAOS_KEY_HEADER = "x-aimock-chaos-key";

/** Reports which occurrence of its key a chaos-affected response was. */
export const CHAOS_OCCURRENCE_HEADER = "x-aimock-chaos-occurrence";

/** Read a header that is only meaningful as a single string value. */
function headerValue(
  rawHeaders: http.IncomingHttpHeaders | undefined,
  name: string,
): string | null {
  const value = rawHeaders?.[name];
  return typeof value === "string" ? value : null;
}

/** A rate as chaos will actually apply it: absent, NaN or out of range clamps into [0, 1]. */
function clampRate(rate: number | undefined): number {
  // The same expression the per-request resolution uses, so a reported rate and
  // the rate that fires cannot disagree. An unbounded rate clamps to 1 and
  // fires on everything; NaN never fires and reads as 0, exactly as it does
  // there.
  if (rate === undefined || Number.isNaN(rate)) return 0;
  return Math.min(1, Math.max(0, rate));
}

/**
 * The three rates a server will actually fire at, so a report of them matches
 * what requests experience rather than what was typed into the config.
 */
export function effectiveChaosRates(config: ChaosConfig | undefined): {
  dropRate: number;
  malformedRate: number;
  disconnectRate: number;
} {
  return {
    dropRate: clampRate(config?.dropRate),
    malformedRate: clampRate(config?.malformedRate),
    disconnectRate: clampRate(config?.disconnectRate),
  };
}

/**
 * Resolve chaos config from headers, fixture, and server defaults.
 * Header values override fixture values, which override server defaults.
 */
function resolveChaosConfig(
  fixture: Fixture | null,
  serverDefaults?: ChaosConfig,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
  omitServerSeed = true,
): ChaosConfig {
  const base: ChaosConfig = { ...serverDefaults };

  // Server instances keep their fixed seed on the randomizer. Legacy exported
  // helpers have no server-owned randomizer, so they must keep a configured
  // seed here instead of silently turning seeded configs back into fresh runs.
  if (omitServerSeed) delete base.seed;

  // Fixture-level overrides server defaults
  if (fixture?.chaos) {
    if (fixture.chaos.dropRate !== undefined) base.dropRate = fixture.chaos.dropRate;
    if (fixture.chaos.malformedRate !== undefined) base.malformedRate = fixture.chaos.malformedRate;
    if (fixture.chaos.disconnectRate !== undefined)
      base.disconnectRate = fixture.chaos.disconnectRate;
    if (fixture.chaos.seed !== undefined) base.seed = fixture.chaos.seed;
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

    // A companion encoding header permits lossless replay of seeds that HTTP
    // otherwise trims or rejects. Without it, a header value is always literal.
    const seedHeader = rawHeaders[CHAOS_SEED_HEADER];
    if (typeof seedHeader === "string") {
      const normalized = normalizeChaosSeed(readChaosSeedHeader(rawHeaders));
      if (normalized === null) {
        logger?.warn(`[chaos] ${CHAOS_SEED_HEADER}: unusable value, ignoring`);
      } else {
        base.seed = normalized;
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
 * What a request is, for keying its draws: taken off the wire rather than from
 * whatever shape a handler normalized it into. A fixture-router projection
 * drops fields the caller did vary, and a normalized body can carry internal
 * routing fields the caller never sent; either one makes two different requests
 * share a key, or one request change key for no reason.
 */
export interface ChaosRequestContext {
  method: string;
  /** The request target, query string included. */
  path: string;
  body: unknown;
}

/**
 * The body material a key is derived from.
 *
 * JSON is parsed, so the object-key-order exception can apply to it. Anything
 * else is opaque and every byte counts, including a trailing multipart epilogue
 * that trimming would drop and binary parts a UTF-8 decode would mangle, so it
 * is keyed by a digest of the bytes as received. The digest stands in for the
 * bytes: distinct payloads keep distinct keys without carrying a whole upload
 * through the hash.
 */
function chaosBodyMaterial(req: http.IncomingMessage, rawBody?: string | null): unknown {
  // Only an empty string is no body. A body of one space is a body, and keying
  // it as absent would put it on the same sequence as a request that sent
  // nothing at all. Absence is undefined rather than null, because a body of
  // literal `null` parses to null and is a different request.
  const bytes = rawBodyBytes(req);
  rawBody = bytes?.toString() ?? rawBody;
  if (typeof rawBody !== "string" || rawBody.length === 0) return undefined;
  const decoded = Buffer.from(rawBody, "utf8");
  // Reversible or nothing. Decoding replaces every byte it cannot read, and
  // parsing what comes out does not undo that: a raw 0xff inside a JSON string
  // arrives here as the replacement character, so keying the parse would hand
  // it the key of a body that really sent one. A body whose bytes do not
  // survive the round trip is opaque, whatever shape the text has taken.
  if (bytes === undefined || bytes.equals(decoded)) {
    try {
      return { kind: "json", value: JSON.parse(rawBody) };
    } catch {
      // Not JSON after all, so it is keyed by its bytes like any other body.
    }
  }
  return {
    kind: "bytes",
    sha256: createHash("sha256")
      .update(bytes ?? decoded)
      .digest("hex"),
  };
}

/**
 * The chaos identity of a request. Pass the body exactly as it arrived; a
 * bodiless route can omit it and be keyed by method and target alone.
 */
export function chaosIdentity(
  req: http.IncomingMessage,
  rawBody?: string | null,
): ChaosRequestContext {
  const identity: ChaosRequestContext = {
    method: req.method ?? "GET",
    path: req.url ?? "/",
    body: chaosBodyMaterial(req, rawBody),
  };
  identityOwner.set(identity, req);
  return identity;
}

/**
 * Which request an identity was built for, and where that request's verdicts
 * were drawn from. WeakMaps for the same reason the raw bodies are kept in one:
 * nothing is attached to objects the rest of the server passes around, and an
 * entry goes away with the request that owns it.
 */
const identityOwner = new WeakMap<ChaosRequestContext, http.IncomingMessage>();
const drawnAt = new WeakMap<http.IncomingMessage, { seed: string; key: string }>();

/** Note where a request's verdicts came from, for whatever else it needs. */
function rememberChaosCoordinates(identity: ChaosRequestContext, seed: string, key: string): void {
  const owner = identityOwner.get(identity);
  if (owner) drawnAt.set(owner, { seed, key });
}

/**
 * The jitter source for a request, on the seed and key its chaos verdicts were
 * drawn from, so replaying a seed replays a run's pacing as well as its faults.
 *
 * Occurrence is deliberately not part of it: pacing belongs to the request, not
 * to how many have come before, so the same request streams the same way every
 * time. Asking costs nothing, draws nothing and moves no verdict. Undefined
 * until a decision has been taken for this request, which leaves a caller on
 * the unseeded default it already had.
 */
export function chaosJitterFor(req: http.IncomingMessage): JitterSource | undefined {
  const at = drawnAt.get(req);
  return at ? createJitterSource(at.seed, at.key) : undefined;
}

/** Where a chaos verdict came from, enough to reproduce it. */
export interface ChaosOrigin {
  /** Effective seed: the header's, else the fixture's, else the server's. */
  seed: string;
  /** Opaque key for this request's identity. */
  key: string;
  /** 0 for this key's first decision under this seed, then 1, 2, ... */
  occurrence: number;
}

/** A verdict plus its coordinates. */
export interface ChaosDecision extends ChaosOrigin {
  action: ChaosAction | null;
}

/**
 * Whether a rate fires against its draw. Absent or zero never fires and 1 or
 * more always fires, whatever the draw was — but the draw is computed either
 * way, by the caller, before any rate is consulted. That ordering is the whole
 * point: a rate change adds or removes firings without shifting which requests
 * the other rates pick.
 */
function chaosFires(rate: number | undefined, draw: number): boolean {
  if (rate === undefined || rate <= 0) return false;
  if (rate >= 1) return true;
  return draw < rate;
}

/** First hit wins, in the documented order: drop, malformed, disconnect. */
function selectChaosAction(config: ChaosConfig, draws: ChaosDraws): ChaosAction | null {
  if (chaosFires(config.dropRate, draws.drop)) return "drop";
  if (chaosFires(config.malformedRate, draws.malformed)) return "malformed";
  if (chaosFires(config.disconnectRate, draws.disconnect)) return "disconnect";
  return null;
}

/**
 * Decide chaos for one request, returning the action together with the seed,
 * key and occurrence behind it. Consumes one occurrence of the request's key,
 * so call it once per request.
 */
export function decideChaos(
  fixture: Fixture | null,
  serverDefaults: ChaosConfig | undefined,
  rawHeaders: http.IncomingHttpHeaders | undefined,
  identity: ChaosRequestContext,
  randomizer: ChaosRandomizer,
  logger?: Logger,
  omitServerSeed = true,
): ChaosDecision {
  const config = resolveChaosConfig(fixture, serverDefaults, rawHeaders, logger, omitServerSeed);
  const draws = randomizer.draw({
    method: identity.method,
    path: identity.path,
    body: identity.body,
    keyOverride: headerValue(rawHeaders, CHAOS_KEY_HEADER),
    seed: config.seed,
  });
  rememberChaosCoordinates(identity, draws.seed, draws.key);
  return {
    action: selectChaosAction(config, draws),
    seed: draws.seed,
    key: draws.key,
    occurrence: draws.occurrence,
  };
}

/**
 * Evaluate chaos config and return the triggered action, or null if none.
 * Checks in order: drop, malformed, disconnect — first hit wins.
 *
 * For callers with no request identity to key on. When a seed is supplied in
 * the config or header, the throwaway randomizer still draws from that seed, so
 * this exported helper preserves the new seeded chaos contract.
 */
export function evaluateChaos(
  fixture: Fixture | null,
  serverDefaults?: ChaosConfig,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
): ChaosAction | null {
  return decideChaos(
    fixture,
    serverDefaults,
    rawHeaders,
    { method: "POST", path: "/", body: null },
    new ChaosRandomizer(),
    logger,
    false,
  ).action;
}

/** The journal fields that record where a verdict came from, or none. */
function chaosOriginFields(origin?: ChaosOrigin): {
  chaosSeed?: string;
  chaosKey?: string;
  chaosOccurrence?: number;
} {
  if (!origin) return {};
  return { chaosSeed: origin.seed, chaosKey: origin.key, chaosOccurrence: origin.occurrence };
}

/**
 * Put the verdict's coordinates on the response, so a client that sees an
 * injected 500 can read the seed straight off it instead of going to the
 * journal. Best effort: a disconnect never gets to send headers, and the proxy
 * malformed path may already have flushed them.
 */
function announceChaosOrigin(res: http.ServerResponse, origin?: ChaosOrigin): void {
  if (!origin || res.headersSent) return;
  reportChaosSeedHeader(res, origin.seed);
  res.setHeader(CHAOS_KEY_HEADER, origin.key);
  res.setHeader(CHAOS_OCCURRENCE_HEADER, String(origin.occurrence));
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
  source: "fixture" | "proxy" | "internal",
  registry?: MetricsRegistry,
  logger?: Logger,
  randomizer?: ChaosRandomizer,
  identity?: ChaosRequestContext,
): boolean {
  return prepareChaos(
    res,
    fixture,
    serverDefaults,
    rawHeaders,
    journal,
    context,
    source,
    registry,
    logger,
    randomizer,
    identity,
  ).handled;
}

/** Decide once and apply the selected chaos action before any proxying can commit bytes. */
export function prepareChaos(
  res: http.ServerResponse,
  fixture: Fixture | null,
  serverDefaults: ChaosConfig | undefined,
  rawHeaders: http.IncomingHttpHeaders,
  journal: Journal,
  context: ChaosJournalContext,
  source: "fixture" | "proxy" | "internal",
  registry?: MetricsRegistry,
  logger?: Logger,
  randomizer?: ChaosRandomizer,
  identity?: ChaosRequestContext,
): { handled: boolean } {
  const hasServerRandomizer = randomizer !== undefined;
  const decision = decideChaos(
    fixture,
    serverDefaults,
    rawHeaders,
    identity ?? context,
    randomizer ?? new ChaosRandomizer(),
    logger,
    hasServerRandomizer,
  );
  if (!decision.action) return { handled: false };
  applyChaosAction(decision.action, res, fixture, journal, context, source, registry, decision);
  return { handled: true };
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
  origin?: ChaosOrigin,
): void {
  if (registry) {
    registry.incrementCounter("aimock_chaos_triggered_total", { action, source });
  }

  const coordinates = chaosOriginFields(origin);
  announceChaosOrigin(res, origin);

  switch (action) {
    case "drop": {
      journal.add({
        ...context,
        response: { status: 500, fixture, chaosAction: "drop", source, ...coordinates },
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
        response: { status: 200, fixture, chaosAction: "malformed", source, ...coordinates },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{malformed json: <<<chaos>>>");
      return;
    }
    case "disconnect": {
      journal.add({
        ...context,
        response: { status: 0, fixture, chaosAction: "disconnect", source, ...coordinates },
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
