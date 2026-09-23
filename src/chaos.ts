/**
 * Chaos testing support for LLMock.
 *
 * Provides probabilistic failure injection — requests can be dropped (500),
 * returned with malformed JSON, rejected with a 429 rate limit, or have the
 * connection forcibly disconnected — plus a deterministic (non-probabilistic)
 * `latencyMs` delay applied before any of those are rolled.
 *
 * Precedence: per-request headers > fixture-level config > server-level defaults.
 * Those three levels merge FIELD-WISE — each level overrides only the fields it
 * sets. The server level is itself scoped per `X-Test-Id`, and that scope lookup
 * is a SELECTION, not a merge: a per-testId override replaces the server-wide
 * baseline wholesale. See `ChaosScope` in types.ts.
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
import { delay, writeErrorResponse } from "./sse-writer.js";
import { DEFAULT_TEST_ID } from "./constants.js";
import { describeMatch, parseStrictIntegerText, resolveTestId } from "./helpers.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

/**
 * Narrow the server-defaults argument. The discrimination is STRUCTURAL: a
 * `ChaosConfig` only ever carries the fault fields (`dropRate`,
 * `malformedRate`, `rateLimitRate`, `disconnectRate`, `latencyMs`), so the
 * presence of a `base` / `byTestId` key means a `ChaosScope`.
 *
 * Both members are optional, so `{}` satisfies BOTH types and is reported here
 * as a config, not a scope. That is not a bug to route around: an empty scope
 * and an empty config resolve to exactly the same thing (no chaos, nothing to
 * select), so no caller can observe which branch ran. The server's own defaults
 * getter (`src/server.ts`) always sets `byTestId`, so a real server's value is
 * never the ambiguous one. A THIRD variant, or a scope whose emptiness became
 * observable, would need a tagged discriminant instead of this shape test.
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
 *
 * SELECTION, NOT MERGE. A scoped override REPLACES the baseline wholesale; it
 * is not layered field-wise over it. A server started with `--chaos-latency
 * 500` whose test installs `{ dropRate: 1 }` sees drops with NO latency on that
 * test's traffic — restate `latencyMs` in the override to keep it. See
 * `ChaosScope` in types.ts for why replacement is the contract (it is what
 * separates `POST /__aimock/chaos {}` from `DELETE`), and note that the two
 * links above this one — fixture and headers, applied below — DO merge
 * field-wise. `POST`/`GET /__aimock/chaos` echo the config actually in effect
 * for the scope, and the control API warns when an install drops a field that
 * was in effect, so nothing is lost silently.
 *
 * PRESENCE of the entry is what selects, not its truthiness: the lookup asks
 * `has`, not `get`. A map built with the key mapped to `undefined` (or to an
 * empty object) is an override that was explicitly installed and says "no
 * chaos for this test" — the `POST /__aimock/chaos {}` case — so it must win
 * over `base` exactly like a populated one. Testing `get(...)` truthiness would
 * quietly demote that one shape back to the baseline, which is the merge
 * behaviour this contract exists to rule out.
 */
function resolveScopedDefaults(
  serverDefaults: ChaosDefaults | undefined,
  rawHeaders?: http.IncomingHttpHeaders,
  url?: string,
): ChaosConfig | undefined {
  if (!serverDefaults) return undefined;
  if (!isChaosScope(serverDefaults)) return serverDefaults;
  const testId = resolveTestId(rawHeaders ?? {}, url);
  if (serverDefaults.byTestId?.has(testId)) return serverDefaults.byTestId.get(testId) ?? {};
  return serverDefaults.base;
}

/**
 * Every chaos field, with its accepted upper bound and its header spelling.
 * ONE table: every source — request header, fixture chaos, server default, the
 * `POST /__aimock/chaos` control API and the `--chaos-*` CLI flags — resolves a
 * field through this entry via {@link parseChaosField}, so no source can drift
 * onto its own bound or its own idea of which fields take a whole number.
 *
 * Exported for the two surfaces that live in other modules (`src/server.ts`'s
 * control API, `src/cli.ts`'s flag parsing); in-module callers go through
 * {@link parseChaosField} too.
 */
export const CHAOS_FIELDS = {
  dropRate: { header: "x-aimock-chaos-drop", max: 1, integer: false },
  malformedRate: { header: "x-aimock-chaos-malformed", max: 1, integer: false },
  disconnectRate: { header: "x-aimock-chaos-disconnect", max: 1, integer: false },
  rateLimitRate: { header: "x-aimock-chaos-ratelimit", max: 1, integer: false },
  latencyMs: { header: "x-aimock-chaos-latency", max: 30000, integer: true },
} as const satisfies Record<string, { header: string; max: number; integer: boolean }>;

export type ChaosField = keyof typeof CHAOS_FIELDS;

export const CHAOS_FIELD_NAMES = Object.keys(CHAOS_FIELDS) as ChaosField[];

/**
 * A plain decimal RATE: digits with an optional fractional part, and nothing
 * else. Deliberately NOT what `Number()` accepts — `Number` is a full-string
 * parse (unlike `parseFloat`, which would take the `0.5` out of `"0.5abc"`),
 * but it is also a JS *literal* parse, so it happily reads `"0x1e"` as 30,
 * `"0b1"` as 1, `"1e3"` as 1000 and `"Infinity"` as Infinity. None of those is
 * a rate a caller meant to write, and `0x1` silently becoming `dropRate: 1`
 * turns a typo into a 100 % outage. A leading `+`/`-` sign, `_` separators and
 * exponents are rejected for the same reason.
 */
const DECIMAL_RATE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * The ONE way a chaos number is parsed, whatever its source.
 *
 * Two shapes, picked per field by the `CHAOS_FIELDS` table: a RATE is a plain
 * decimal in `[0, max]` (max is always 1), and an INTEGER field (`latencyMs`)
 * is a whole, non-negative count of milliseconds in `[0, max]`. `integer`
 * defaults to false so a caller that omits it gets the rate grammar.
 *
 * The VALUE rules apply to every source alike: `NaN` and non-finite values, a
 * fractional value for an integer field, negative zero, and anything outside
 * `[0, max]` are all rejected (returned as `undefined`) whether they arrived as
 * text or as a typed number. Nothing is ever clamped — a value the caller did
 * not ask for is never substituted for the one they did. Negative zero is
 * rejected rather than folded to `0` so that it matches its own text form
 * (`"-0"`, which the sign-less grammar already refuses) and so that no `-0`
 * escapes into a config object that later gets echoed back over JSON.
 *
 * The GRAMMAR above — the two regexes — is a rule about TEXT, and only a string
 * input passes through it: trailing garbage (`"0.5abc"`), non-numeric text
 * (`"banana"`), the empty string, a sign (`"+1"`, `"-0"`) and the JS
 * numeric-literal forms that are not plain decimals (`"0x1e"`, `"0b1"`,
 * `"1e3"`, `"Infinity"`) are rejected as spellings. A fixture or JSON body that
 * writes `latencyMs: 1e3` has ALREADY been through a JSON/JS parser and hands
 * this function the number `1000`, indistinguishable from a literal `1000` — so
 * it is accepted, while the header `"1e3"` is not. That asymmetry is the point,
 * not a gap: the grammar exists to stop an ambiguous *spelling* on the wire
 * (`0x1` silently becoming `dropRate: 1` turns a typo into a 100 % outage),
 * and a value that reached us as a number has no spelling left to police.
 */
export function parseChaosNumber(raw: unknown, max: number, integer = false): number | undefined {
  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string") {
    // Integer grammar shared with the files/fine-tuning list parsers via
    // parseStrictIntegerText (helpers.ts); the fractional-rate grammar and
    // every bound below stay local, so sharing the gate cannot widen them.
    if (integer) {
      const n = parseStrictIntegerText(raw.trim());
      if (n === null) return undefined;
      value = n;
    } else {
      const text = raw.trim();
      if (!DECIMAL_RATE.test(text)) return undefined;
      value = Number(text);
    }
  } else {
    return undefined;
  }
  if (!Number.isFinite(value)) return undefined;
  if (integer && !Number.isInteger(value)) return undefined;
  if (Object.is(value, -0)) return undefined;
  if (value < 0 || value > max) return undefined;
  return value;
}

/**
 * Parse a value for a NAMED chaos field, taking its bound and its integer-ness
 * from `CHAOS_FIELDS` instead of from the call site. Every entry point should
 * call this rather than `parseChaosNumber` with hand-written limits — that is
 * what makes the "ONE table" claim above true instead of aspirational.
 */
export function parseChaosField(field: ChaosField, raw: unknown): number | undefined {
  return parseChaosNumber(raw, CHAOS_FIELDS[field].max, CHAOS_FIELDS[field].integer);
}

/**
 * The single value a repeated header carries. Node models a repeat two ways —
 * as a `string[]`, and (for most headers) folded into one comma-joined string —
 * and ONE rule covers both shapes, so the two can never diverge: split on
 * commas, trim, drop empties, and the FIRST NON-EMPTY value wins.
 *
 * "Non-empty" is the load-bearing word. `x-aimock-chaos-latency: ` followed by
 * `x-aimock-chaos-latency: 500` reaches the handler as `",500"` or
 * `["", "500"]` depending on the shape; taking element `[0]` blindly made the
 * folded form warn "rejected latencyMs value \"\"" while the array form went
 * silently absent — two behaviours for one wire-level request. An empty value
 * carries no instruction, so it is skipped rather than rejected.
 *
 * A repeat whose values DISAGREE is a real misconfiguration (two different
 * rates asked for on one request), so it warns once and the first wins.
 * "Disagree" is judged on what the values MEAN, not how they are spelled:
 * `0.5, 0.50` is one rate written twice and says nothing worth warning about,
 * whereas a TEXT comparison called it a conflict. Values the parser rejects
 * have no meaning to compare, so they stand for themselves — two different
 * typos still disagree, and a typo still disagrees with a valid number.
 */
function firstHeaderValue(
  raw: string | string[] | undefined,
  field: ChaosField,
  logger?: Logger,
): string | undefined {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const values = parts
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const first = values[0];
  if (first === undefined) return undefined;
  const firstMeaning = headerValueMeaning(first, field);
  if (values.some((value) => headerValueMeaning(value, field) !== firstMeaning)) {
    logger?.warn(
      `[chaos] ${CHAOS_FIELDS[field].header}: repeated header with conflicting values ${JSON.stringify(values)} — using the first (${JSON.stringify(first)})`,
    );
  }
  return first;
}

/**
 * What one spelling of a header value MEANS, as a comparable token: the parsed
 * number when the grammar accepts it, else the raw text. Prefixed so a rejected
 * literal `"0.5"` could never compare equal to the parsed number 0.5.
 */
function headerValueMeaning(text: string, field: ChaosField): string {
  const { max, integer } = CHAOS_FIELDS[field];
  const value = parseChaosNumber(text, max, integer);
  return value === undefined ? `raw:${text}` : `num:${value}`;
}

/**
 * Where a chaos value came from, for the warning that rejects it.
 *
 * `label` is what the line CALLS the source and names the specific fixture or
 * testId scope, not just its kind: with the latch below, only the FIRST of N
 * bad values is ever printed, so a line reading "fixture chaos" alone leaves
 * the reader to guess which of N fixtures carries the typo.
 *
 * `latchKey` identifies that source for the latch and is absent for sources
 * that are never latched (per-request headers). It is deliberately NOT the
 * label: two fixtures can summarise identically (colliding predicates or
 * regexes) and must still each get their line.
 */
interface ChaosSource {
  label: string;
  latchKey?: string;
}

/** Placeholder for a level that carries no config, so nothing can be warned about. */
const NO_SOURCE: ChaosSource = { label: "(no chaos config)" };

/**
 * Static chaos config (a fixture's `chaos`, a server default) is re-read on
 * EVERY request, so an invalid value there used to warn on every request for
 * the life of the process — thousands of identical lines for one typo. Latch
 * those: once per distinct source+field+value, PER SERVER. Per-request HEADERS
 * are dynamic input and keep warning per request, because each request really
 * is a new caller making a new mistake.
 *
 * PER SERVER, not per process. The latch hangs off the server's `Logger` — one
 * is constructed per `createServer` and every handler warns through
 * `defaults.logger`, so the logger IS the server instance as far as this
 * module can see it. A module-global `Set` instead meant two `LLMock`s in one
 * process shared one latch: the second server never reported its own bad
 * value, and one server's `resetChaosWarnings` re-armed the other's. A
 * `WeakMap` so a stopped server's keys go with it — nothing else holds them.
 *
 * Cleared by `resetChaosWarnings`, which `performFullReset` calls alongside the
 * other per-server state, so a suite that resets between tests sees the warning
 * again rather than inheriting the previous test's latch.
 */
const warnedStaticRejections = new WeakMap<Logger, Set<string>>();

/**
 * Cap on distinct latched keys per server. Runtime chaos installs (`POST
 * /__aimock/chaos`, once per test in a long-lived harness) can mint unboundedly
 * many distinct bad values, and a latch that only ever grows is a leak. Past
 * the cap the OLDEST key is evicted (a `Set` iterates in insertion order), so
 * the worst case is that a long-since-warned typo warns a second time — never
 * unbounded memory.
 */
const MAX_LATCHED_REJECTIONS = 64;

/**
 * Clear ONE server's static-config rejection latch, so the next request reports
 * a bad static value again. See `warnedStaticRejections`.
 *
 * Takes that server's logger because the logger is what the latch is keyed by.
 * There is deliberately no "clear every server" form: `performFullReset` is an
 * isolation barrier for the server being reset, and reaching into a concurrent
 * server's latch is exactly the cross-talk this scoping removes.
 *
 * Does NOT clear the `applyChaos` deprecation notice (`warnedSyncApplyChaos`),
 * which is once per process by design — see the latch there.
 */
export function resetChaosWarnings(logger: Logger): void {
  warnedStaticRejections.delete(logger);
}

function warnRejected(source: ChaosSource, field: ChaosField, raw: unknown, logger?: Logger): void {
  if (!logger) return;
  if (source.latchKey !== undefined) {
    // Latched only once a logger is actually present, so a warn-less call can
    // never swallow the one line a configured logger was going to emit.
    const key = `${source.latchKey}\u0000${field}\u0000${JSON.stringify(raw)}`;
    let latched = warnedStaticRejections.get(logger);
    if (!latched) {
      latched = new Set<string>();
      warnedStaticRejections.set(logger, latched);
    }
    if (latched.has(key)) return;
    if (latched.size >= MAX_LATCHED_REJECTIONS) {
      const oldest = latched.values().next();
      if (!oldest.done) latched.delete(oldest.value);
    }
    latched.add(key);
  }
  const shape = CHAOS_FIELDS[field].integer ? "a whole number of ms" : "a number";
  logger.warn(
    `[chaos] ${source.label}: rejected ${field} value ${JSON.stringify(raw)} — must be ${shape} in [0,${CHAOS_FIELDS[field].max}]; ignoring it`,
  );
}

/**
 * Serial number per fixture OBJECT, minted on demand, so a fixture's latch key
 * is its identity rather than its (possibly colliding) description. Same reason
 * `router.ts` keys its relaxed-turnIndex throttle by object identity. A
 * `WeakMap`, so the serial dies with the fixture.
 */
const fixtureSerials = new WeakMap<Fixture, number>();
let nextFixtureSerial = 0;

/** Name and latch-identify the fixture whose `chaos` block is being read. */
function fixtureSource(fixture: Fixture): ChaosSource {
  let serial = fixtureSerials.get(fixture);
  if (serial === undefined) {
    serial = nextFixtureSerial++;
    fixtureSerials.set(fixture, serial);
  }
  return {
    label: `fixture chaos ${describeMatch(fixture.match, -1)}`,
    latchKey: `fixture#${serial}`,
  };
}

/**
 * Name and latch-identify the server-level config this request resolved to. A
 * per-testId override and the server-wide baseline are DIFFERENT sources — a
 * typo in one must not latch the other silent — so the testId is part of both
 * the label and the key.
 *
 * Mirrors the selection in `resolveScopedDefaults` (which is the authority):
 * the baseline is the scope's `DEFAULT_TEST_ID` entry, so an untagged request
 * reads as the plain server default rather than an override named after an
 * internal sentinel.
 */
function serverSource(
  serverDefaults: ChaosDefaults | undefined,
  rawHeaders: http.IncomingHttpHeaders | undefined,
  url: string | undefined,
): ChaosSource {
  if (serverDefaults && isChaosScope(serverDefaults)) {
    const testId = resolveTestId(rawHeaders ?? {}, url);
    if (testId !== DEFAULT_TEST_ID && serverDefaults.byTestId?.has(testId)) {
      return {
        label: `server chaos default (testId ${JSON.stringify(testId)})`,
        latchKey: `server:${testId}`,
      };
    }
  }
  return { label: "server chaos default", latchKey: "server" };
}

/** Read one field from the request headers. */
function readHeaderField(
  rawHeaders: http.IncomingHttpHeaders | undefined,
  field: ChaosField,
  logger?: Logger,
): number | undefined {
  const text = firstHeaderValue(rawHeaders?.[CHAOS_FIELDS[field].header], field, logger);
  if (text === undefined) return undefined;
  const value = parseChaosField(field, text);
  // A header is dynamic per-request input: warn EVERY time, never latched —
  // hence no `latchKey`.
  if (value === undefined) warnRejected({ label: CHAOS_FIELDS[field].header }, field, text, logger);
  return value;
}

/** Read one field from a config object — a fixture's chaos, or the server default. */
function readConfigField(
  config: ChaosConfig | undefined,
  field: ChaosField,
  source: ChaosSource,
  logger?: Logger,
): number | undefined {
  const raw = config?.[field];
  if (raw === undefined) return undefined;
  const value = parseChaosField(field, raw);
  // Static config, re-read every request: warn once per distinct bad value,
  // per source, per server.
  if (value === undefined) warnRejected(source, field, raw, logger);
  return value;
}

/**
 * Resolve chaos config from headers, fixture, and server defaults.
 * Header values override fixture values, which override server defaults —
 * field-wise at each step, so a level that sets only `dropRate` leaves the
 * level below's `latencyMs` intact. The server defaults are themselves selected
 * per-testId first, and THAT step replaces rather than merges (see
 * `resolveScopedDefaults` and `ChaosScope`).
 *
 * Every source goes through the same parser and the same ONE out-of-range
 * policy — reject and warn, never clamp (see `ChaosConfig`). A rejected value
 * is simply not set, so the next level of precedence applies. All three levels
 * are parsed even when a higher one wins, so a bad value is always reported
 * rather than hidden by the override above it.
 *
 * Exported so a caller that needs BOTH the latency delay and the terminal
 * action resolves once per request and threads the result through, instead of
 * parsing (and re-warning about) the same headers twice on the hot path.
 */
export function resolveChaosConfig(
  fixture: Fixture | null,
  serverDefaults?: ChaosDefaults,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
  url?: string,
): ChaosConfig {
  const serverConfig = resolveScopedDefaults(serverDefaults, rawHeaders, url);
  const resolved: ChaosConfig = {};
  // Resolved once, not per field: minting a fixture serial and re-resolving the
  // testId five times per request would be pure hot-path waste. `NO_SOURCE` is
  // never read — a config-less level returns before it touches the source.
  const fixtureFrom = fixture ? fixtureSource(fixture) : NO_SOURCE;
  const serverFrom = serverConfig ? serverSource(serverDefaults, rawHeaders, url) : NO_SOURCE;

  for (const field of CHAOS_FIELD_NAMES) {
    const fromHeader = readHeaderField(rawHeaders, field, logger);
    const fromFixture = readConfigField(fixture?.chaos, field, fixtureFrom, logger);
    const fromServer = readConfigField(serverConfig, field, serverFrom, logger);
    const value = fromHeader ?? fromFixture ?? fromServer;
    if (value !== undefined) resolved[field] = value;
  }

  return resolved;
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
  resolved?: ChaosConfig,
): number {
  const config = resolved ?? resolveChaosConfig(fixture, serverDefaults, rawHeaders, logger, url);
  return config.latencyMs ?? 0;
}

/**
 * Why a response can no longer carry chaos bytes. These are NOT the same
 * event, and they do NOT foreclose the same actions — a caller that treats
 * them alike either logs a lie or skips work it could still have done:
 *
 * - `"chaos-disconnected"` — WE destroyed it, via the `disconnect` chaos
 *   action. From the outside that is indistinguishable from a client hang-up,
 *   so the response is marked on the way out and reported apart from one.
 * - `"already-ended"` — the body was ended by someone else on this handler.
 *   The client got a response, just not ours. Checked BEFORE `destroyed`,
 *   because a normally-ended response whose connection is torn down afterwards
 *   is an ended response, not a disconnect; the old order blamed the client
 *   for a response it had received in full.
 * - `"client-gone"` — the socket was destroyed with nothing ended on it. The
 *   client hung up; whatever we were about to send is undeliverable and must
 *   not be journalled.
 * - `"headers-sent"` — a status line is already committed. NOT death: the
 *   connection may well still be healthy. Only the actions that need a status
 *   line of their own (`drop`, `malformed`, `rateLimit`) are foreclosed —
 *   `disconnect` is a bare `res.destroy()` and still works, and the
 *   deterministic latency is still meaningful.
 *
 * The first three are collectively "gone": see {@link responseGone}.
 */
export type ResponseUnwritableReason =
  | "chaos-disconnected"
  | "already-ended"
  | "client-gone"
  | "headers-sent";

/**
 * Responses this module destroyed itself, through the `disconnect` chaos
 * action. A `WeakSet` rather than a marker property on the response: it adds
 * nothing to the object's shape (so a `ServerResponse` test double stays a
 * faithful stand-in) and the entry goes away with the response.
 */
const chaosDisconnectedResponses = new WeakSet<http.ServerResponse>();

/**
 * The reason this response can no longer carry a fresh status line, or `null`
 * while it can. Checked most-specific first: our own teardown, then an ended
 * body, then a destroyed socket, then a committed status line.
 */
export function responseUnwritableReason(
  res: http.ServerResponse,
): ResponseUnwritableReason | null {
  if (chaosDisconnectedResponses.has(res)) return "chaos-disconnected";
  if (res.writableEnded) return "already-ended";
  if (res.destroyed) return "client-gone";
  if (res.headersSent) return "headers-sent";
  return null;
}

/**
 * The reason this response is GONE — dead for every purpose, chaos or not —
 * or `null` while anything at all can still be done with it. `"headers-sent"`
 * is deliberately NOT one of these.
 */
export function responseGoneReason(
  res: http.ServerResponse,
): Exclude<ResponseUnwritableReason, "headers-sent"> | null {
  const reason = responseUnwritableReason(res);
  return reason === null || reason === "headers-sent" ? null : reason;
}

/**
 * True once nothing can be delivered on this response at all: the client hung
 * up, the body was already ended, or our own `disconnect` action destroyed it.
 *
 * This is the predicate the streaming surfaces guard their post-`await` writes
 * with (`grok-video.ts`, `veo-video.ts` — which hand-rolled
 * `res.destroyed || res.writableEnded`, i.e. this minus the chaos-teardown
 * case), and the one the SPLIT chaos gates in `src/server.ts` — the ones that
 * call `awaitChaosLatency` and `evaluateChaos` separately instead of going
 * through `applyChaosAsync` — have to re-check themselves after the await.
 * Without that check a client that hangs up mid-delay still gets a full
 * response built, "served" into a dead socket and JOURNALLED (C13).
 */
export function responseGone(res: http.ServerResponse): boolean {
  return responseGoneReason(res) !== null;
}

/**
 * True once the response can no longer carry a FRESH STATUS LINE, for any of
 * the reasons {@link responseUnwritableReason} enumerates — {@link
 * responseGone} plus `headers-sent`. Guard a `writeHead` with this; decide
 * whether there is any point continuing at all with `responseGone`.
 */
export function responseUnwritable(res: http.ServerResponse): boolean {
  return responseUnwritableReason(res) !== null;
}

/** Human-readable gloss per reason, so a skipped chaos action logs what actually happened. */
const UNWRITABLE_DESCRIPTION: Record<ResponseUnwritableReason, string> = {
  "chaos-disconnected": "the chaos disconnect action had already destroyed it",
  "already-ended": "the response was already ended",
  "client-gone": "the client disconnected",
  "headers-sent": "a status line was already committed",
};

/** The gloss for one reason. Exported so the split gates in `src/server.ts` log the same words. */
export function describeUnwritableReason(reason: ResponseUnwritableReason): string {
  return UNWRITABLE_DESCRIPTION[reason];
}

/**
 * What {@link applyChaosAsync} reports back. Read it as the ANSWER TO ONE
 * QUESTION — "must the caller stop?" — because that is how every call site
 * spells it: `if (await applyChaosAsync(...)) return;`.
 *
 * - `false` — the caller CARRIES ON and serves the request. Either no chaos
 *   fired, or the action that was rolled could not be applied and was skipped
 *   without touching the response (a body action on a headers-sent response).
 *   A skip must never abandon a healthy body the handler was about to finish.
 * - `"handled"` — a terminal chaos action was applied and journalled; the
 *   response is spoken for.
 * - `"unwritable"` — the response was GONE by the time the latency delay
 *   finished (client hung up, body already ended, or our own `disconnect`
 *   destroyed it). Nothing was written, nothing was journalled, no metric was
 *   counted — and there is nothing left to serve, so the caller stops.
 *
 * Both non-`false` members are truthy strings, so every existing call site
 * keeps its meaning while callers that want the reason can read it.
 */
export type ChaosAsyncOutcome = false | "handled" | "unwritable";

/**
 * Whether {@link applyChaosAction} actually did the thing. `"skipped"` means
 * the response could not take that particular action (see
 * {@link ResponseUnwritableReason}) and NOTHING happened: no write, no journal
 * entry, no metric. It is not a failure — it is the caller's cue that the
 * request is still its to finish.
 */
export type ChaosActionOutcome = "applied" | "skipped";

/**
 * Await the deterministic latency delay configured for this request, if any.
 * Fixed (never randomised or jittered) so replay stays deterministic. Returns
 * immediately when no latency is configured. Handlers that roll the chaos dice
 * themselves (branching on the action before dispatching) call this first;
 * handlers that just need "delay, then maybe fail" use `applyChaosAsync`.
 *
 * Pass `res` so a client that hangs up mid-delay CANCELS the pending timer
 * (via the cancellable `delay(ms, signal)` helper) instead of leaving it armed
 * for up to the 30s cap. The wait resolves early on disconnect — callers must
 * re-check the response is still writable afterwards, which every chaos write
 * path does through `responseUnwritable`.
 *
 * The disconnect signal is taken from the RESPONSE, not the request: an
 * `IncomingMessage` is auto-destroyed as soon as its body has been fully read,
 * so `req.destroyed` / `req`'s `close` event fire on every healthy request and
 * would cancel the delay for everyone. `res`'s `close` before a write can only
 * mean the connection was terminated prematurely.
 */
export async function awaitChaosLatency(
  fixture: Fixture | null,
  serverDefaults?: ChaosDefaults,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
  url?: string,
  res?: http.ServerResponse,
  resolved?: ChaosConfig,
): Promise<void> {
  const delayMs = resolveChaosLatencyMs(fixture, serverDefaults, rawHeaders, logger, url, resolved);
  if (delayMs <= 0) return;

  // `res` is optional: without anything to listen on, fall back to a plain wait.
  if (!res) {
    await delay(delayMs);
    return;
  }

  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  // Subscribe and unsubscribe must be guarded the SAME way: a test double may
  // carry only part of the EventEmitter surface, and an unconditional
  // `res.off(...)` in the `finally` would throw a TypeError out of an
  // otherwise-normal completion — turning the delay into a rejection. So we
  // only ever remove what we actually added, through the remover we verified
  // exists at subscribe time (`off` is the modern alias of `removeListener`;
  // a double carrying neither simply keeps the short-lived per-request
  // listener rather than blowing up the caller).
  let unsubscribe: (() => void) | undefined;
  // GONE, not merely unwritable: a response whose status line is already
  // committed is still live, and its configured delay is still meaningful.
  // Aborting on `headersSent` zeroed the latency for every post-headers gate.
  if (responseGone(res)) {
    controller.abort();
  } else if (typeof res.once === "function") {
    res.once("close", onClose);
    if (typeof res.off === "function") unsubscribe = () => res.off("close", onClose);
    else if (typeof res.removeListener === "function")
      unsubscribe = () => res.removeListener("close", onClose);
  }
  try {
    await delay(delayMs, controller.signal);
  } finally {
    unsubscribe?.();
  }
}

/**
 * Evaluate chaos config and return the triggered action, or null if none.
 *
 * THE RATES DO NOT ROLL INDEPENDENTLY. Each is a separate `Math.random()` draw
 * taken in a fixed order — drop → malformed → rateLimit → disconnect — and the
 * first draw that hits returns immediately, so the ones after it are never
 * rolled at all. A rate is therefore the probability that ITS draw hits GIVEN
 * that no earlier rate fired, not the share of requests that end in that fault.
 * Only `dropRate`, first in the chain, is unconditional.
 *
 * Worked example: `{ dropRate: 0.5, rateLimitRate: 0.5 }` yields ~50 % drops
 * and ~25 % rate limits (0.5 x 0.5 — half the requests never reach the second
 * draw), not 50 % of each. To exercise two faults at their nominal frequency,
 * configure them on separate requests rather than in one config.
 */
export function evaluateChaos(
  fixture: Fixture | null,
  serverDefaults?: ChaosDefaults,
  rawHeaders?: http.IncomingHttpHeaders,
  logger?: Logger,
  url?: string,
  resolved?: ChaosConfig,
): ChaosAction | null {
  const config = resolved ?? resolveChaosConfig(fixture, serverDefaults, rawHeaders, logger, url);

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
 * action fired (caller returns early), false to proceed.
 *
 * This is the ONLY entrypoint that honours `latencyMs`, so it is the one every
 * route handler must use: `src/__tests__/chaos-async-call-sites.test.ts` fails
 * the build if any module outside this file rolls chaos without an awaited
 * latency dominating the roll. That guard skips this file wholesale — it
 * defines the primitives — so the `applyChaos(...)` delegation below is neither
 * checked by it nor a control for it. The guard proves it is not vacuous its
 * own way: synthetic fixtures for each evasion shape, a floor on the number of
 * files scanned and chaos imports resolved, and a reconciliation of its name
 * sets against this file's real exports.
 *
 * The delay is tied to the response socket, so a client that disconnects during
 * it cancels the timer. When that happens (or the response went away for any
 * other reason while we waited) the dice are never rolled: returns
 * `"unwritable"` so the caller returns early, with nothing written and nothing
 * journalled — a response that was never sent must not appear in the journal.
 *
 * A response that merely has its HEADERS SENT is NOT gone, and is not
 * short-circuited: the delay is still awaited and the dice are still rolled.
 * `disconnect` needs no status line and is applied; the three body actions
 * are skipped and the call reports `false`, because the caller still has a
 * healthy response to finish and `if (outcome) return;` would abandon it.
 *
 * The return value is a {@link ChaosAsyncOutcome}, not a boolean, so callers
 * can tell "chaos fired" from "the response was already dead" — two outcomes
 * the old `true` conflated. Both are truthy, so the standard call shape
 * `if (await applyChaosAsync(...)) return;` keeps working unchanged; a caller
 * that cares compares against `"handled"` / `"unwritable"`.
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
): Promise<ChaosAsyncOutcome> {
  // Resolve ONCE per request: the latency await and the terminal-action roll
  // share the same config, so headers are parsed (and warned about) exactly once.
  const resolved = resolveChaosConfig(fixture, serverDefaults, rawHeaders, logger, requestUrl);
  await awaitChaosLatency(fixture, serverDefaults, rawHeaders, logger, requestUrl, res, resolved);
  // Only a GONE response short-circuits here. `headers-sent` falls through to
  // the roll: `disconnect` still applies to it, and a body action that cannot
  // is skipped inside `applyChaosAction`, which reports `false` so the caller
  // finishes the body it was already streaming.
  const gone = responseGoneReason(res);
  if (gone !== null) {
    logger?.debug(
      `[chaos] not applying chaos to ${context.method} ${context.path}: ` +
        `${UNWRITABLE_DESCRIPTION[gone]} — nothing written, nothing journalled`,
    );
    return "unwritable";
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
    resolved,
  )
    ? "handled"
    : false;
}

interface ChaosJournalContext {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: ChatCompletionRequest | null;
  /**
   * Service tag copied onto the chaos-path journal entry, so a faulted request
   * stays selectable by `GET /__aimock/journal?service=<name>` exactly like the
   * handler's own non-chaos entries. Handlers that tag their normal journal
   * writes MUST pass it here too, or their chaos traffic falls out of that
   * filter. Optional because the OpenAI-surface handlers journal untagged.
   */
  service?: string;
}

/**
 * Apply chaos to a request. Returns true if chaos was applied (caller should
 * return early), false if the request should proceed normally.
 *
 * Synchronous, and therefore SKIPS the configured `latencyMs` delay — it cannot
 * await. It IS exported (the async wrapper and this module's tests call it by
 * name), but it is not the public surface: no handler may call it —
 * `src/__tests__/chaos-async-call-sites.test.ts` fails the build if one does —
 * and the barrel deliberately publishes `applyChaosDeprecated` under the name
 * `applyChaos` instead, so library consumers who still call it are told about
 * the latency gap. See both below.
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
  resolved?: ChaosConfig,
): boolean {
  const action = evaluateChaos(fixture, serverDefaults, rawHeaders, logger, requestUrl, resolved);
  if (!action) return false;
  // "Rolled" is not "applied": an action the response could not take is a
  // no-op, and reporting it as a hit would make the caller abandon a request
  // nothing has answered.
  return (
    applyChaosAction(action, res, fixture, journal, context, source, registry, logger) === "applied"
  );
}

/**
 * One-shot latch for the deprecation notice below: warn once per process, not
 * per request.
 *
 * PER PROCESS, and deliberately not cleared by `resetChaosWarnings` /
 * `performFullReset` — unlike `warnedStaticRejections`, which IS per server and
 * IS cleared. The two latches guard different kinds of fact. A rejected static
 * chaos value describes THIS server's configuration, which a reset may change,
 * so a reset suite must hear about it again. This notice describes the
 * EMBEDDER'S CODE — a call site that still imports the sync `applyChaos` — and
 * a `reset()` cannot change that: re-emitting it per test would print the same
 * unchanged migration instruction once per test with nothing new to say. The
 * deprecation policy (`docs/deprecation-policy/index.html`) is about which
 * upstream endpoints aimock keeps mocking and says nothing about notice
 * frequency, so the choice is ours; the message states it ("Warned once per
 * process.") so nobody reads the single line as "it only happened once".
 */
let warnedSyncApplyChaos = false;

/**
 * Public, deprecated wrapper around the synchronous {@link applyChaos}. The
 * barrel (`src/index.ts`) exports this under the name `applyChaos`, which has
 * been part of the published API since v1.10.0 — removing it outright would
 * break embedders silently, so it stays and says so instead.
 *
 * @deprecated Use {@link applyChaosAsync}. The synchronous form cannot await,
 * so it silently ignores the configured chaos latency (`latencyMs`,
 * `--chaos-latency`, `x-aimock-chaos-latency`): the fault rates still roll, but
 * no delay is injected. Every fault behaviour is otherwise identical.
 */
export function applyChaosDeprecated(
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
  if (!warnedSyncApplyChaos) {
    warnedSyncApplyChaos = true;
    const notice =
      "applyChaos() is deprecated and ignores the configured chaos latency " +
      "(latencyMs / --chaos-latency / x-aimock-chaos-latency): it is synchronous and " +
      "cannot await the delay. Use `await applyChaosAsync(...)` instead — same arguments, " +
      "same fault behaviour, plus the latency. (Warned once per process.)";
    // Route through the caller's logger when there is one: every other line
    // this module emits honours it, and a raw console.warn ignores the
    // configured log level and bypasses whatever the embedder captures. The
    // `console.warn` fallback (with the prefix `Logger` would have added) keeps
    // the notice visible for the many call sites that pass no logger at all.
    if (logger) logger.warn(notice);
    else console.warn(`[aimock] ${notice}`);
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

/**
 * Apply a specific (already-rolled) chaos action. Exposed so callers that roll
 * the dice themselves can dispatch without re-rolling — important when the
 * caller wants to branch on the action before committing (e.g. pre-flight vs.
 * post-response phases).
 *
 * `source` is required (not optional) so callers can't silently omit it on
 * one branch and journal an ambiguous entry. Pass `"fixture"` when a fixture
 * matched (or would have), `"proxy"` when the request was headed for the proxy
 * path, and `"internal"` — the value most call sites pass — for aimock's own
 * built-in endpoints, which are neither.
 *
 * A chaos action can be dispatched an arbitrarily long time after the request
 * arrived (up to the 30s latency cap), by which point the client may be gone.
 * Writing to a destroyed socket is silently lost, so counting the action and
 * journalling a status the client never received would be a lie. When the
 * response cannot take THIS action this is a no-op: no metric, no journal
 * entry, no write, and the return value says `"skipped"`. The journal
 * vocabulary has no "aborted" chaos status — the entry is omitted rather than
 * invented.
 *
 * "Cannot take this action" is per-action, not one bit. A GONE response
 * (client hung up, body ended, already chaos-destroyed) forecloses everything.
 * A response whose HEADERS ARE SENT forecloses only the three actions that
 * write a status line of their own — `disconnect` is a bare `res.destroy()`
 * and is applied normally.
 *
 * `logger` is REQUIRED (not optional, not defaulted) because every branch
 * above can decline to act, and a skip nobody can see is the bug this
 * parameter exists to prevent: one call site had quietly omitted it. It is
 * typed `Logger | undefined` rather than `Logger` because the public,
 * deprecated `applyChaos` wrapper's own logger is optional and threads through
 * here — arity is what the compiler enforces, and that is what catches the
 * omission.
 */
export function applyChaosAction(
  action: ChaosAction,
  res: http.ServerResponse,
  fixture: Fixture | null,
  journal: Journal,
  context: ChaosJournalContext,
  source: "fixture" | "proxy" | "internal",
  registry: MetricsRegistry | undefined,
  logger: Logger | undefined,
): ChaosActionOutcome {
  const unwritable = responseUnwritableReason(res);
  // `headers-sent` blocks only the actions that need a status line; every
  // other reason means the response is gone and blocks all of them.
  if (unwritable !== null && (unwritable !== "headers-sent" || action !== "disconnect")) {
    logger?.debug(
      `[chaos] skipping ${action} on ${context.method} ${context.path}: ` +
        `${UNWRITABLE_DESCRIPTION[unwritable]} — no metric, no journal entry, no write`,
    );
    return "skipped";
  }

  switch (action) {
    // Every case journals AFTER its write, for the same reason the metric
    // below is counted after: a `writeHead` that throws (a socket torn down
    // between the guard above and the call) must not leave behind a journal
    // entry for a response the client never received.
    case "drop": {
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
      journal.add({
        ...context,
        response: { status: 500, fixture, chaosAction: "drop", source },
      });
      break;
    }
    case "malformed": {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{malformed json: <<<chaos>>>");
      journal.add({
        ...context,
        response: { status: 200, fixture, chaosAction: "malformed", source },
      });
      break;
    }
    case "rateLimit": {
      // Route through writeErrorResponse() so the chaos 429 carries the same
      // OpenAI-shaped rate-limit header set (Retry-After + RATE_LIMIT_HEADERS)
      // as every other 429 in the repo, instead of a second hand-rolled set.
      writeErrorResponse(
        res,
        429,
        JSON.stringify({
          error: {
            message: "Chaos: rate limit exceeded",
            type: "rate_limit_error",
            code: "chaos_ratelimit",
          },
        }),
      );
      journal.add({
        ...context,
        response: { status: 429, fixture, chaosAction: "rateLimit", source },
      });
      break;
    }
    case "disconnect": {
      // The status the client actually saw: the one already on the wire when
      // the response was committed before this teardown, else 0 (nothing was
      // ever sent). Journalling 0 for a committed response claimed the client
      // got no status line when it had.
      const status = res.headersSent ? res.statusCode : 0;
      // Marked BEFORE the teardown so anything reacting to `close` already
      // sees this as OUR disconnect rather than a client hang-up.
      chaosDisconnectedResponses.add(res);
      res.destroy();
      journal.add({
        ...context,
        response: { status, fixture, chaosAction: "disconnect", source },
      });
      break;
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return "skipped";
    }
  }

  // Counted AFTER the write, never before: a write that throws (a socket torn
  // down between the guard above and the call) must not leave behind a metric
  // for bytes that never went out.
  registry?.incrementCounter("aimock_chaos_triggered_total", { action, source });
  return "applied";
}
