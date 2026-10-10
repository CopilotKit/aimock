/**
 * MCP fakes: the fake model core.
 *
 * Pure module, no I/O. It owns block validation (the bad-block cases (a)-(j)
 * listed in `MCP_FAKES_LOAD_RULES`), entry ids and the per-mount counters in
 * them, block-id and entry-id uniqueness per mount, scope matching, scope
 * tiers, argument equality, the synchronous claim step with its mismatch and
 * exhausted details (`firstDifference`), consumption state per test id with
 * its FIFO cap, the undeclared-tool policy, and the fake tools for
 * `tools/list`. One `McpFakeStore` serves one MCP mount.
 */

import { DEFAULT_TEST_ID, MCP_FAKES_ECHO_LIMIT } from "./constants.js";
import { cutText, type CutUnits } from "./echo-text.js";
import {
  FixtureLoadError,
  type FixtureLoadErrorJSON,
  type McpFakesLoadRule,
} from "./fixture-loader.js";
import {
  Message,
  build,
  fixed,
  fullText,
  jsonText,
  msg,
  plainText,
  quote,
  quoteJson,
  type MessageValue,
} from "./message-text.js";
import type {
  McpFakeCallAnswer,
  McpFakeCallMatch,
  McpFakeDeepReadonly,
  McpFakeIdentity,
  McpFakeNotification,
  McpFakeRecorded,
  McpFakeResult,
  McpFakeScope,
  McpFakeSource,
  McpFakeUndeclaredPolicy,
} from "./types.js";

// ---------------------------------------------------------------------------
// Load rules of the recorded keys FA1-FA5 (the record-replay LE values)

/**
 * The finer rules of the recorded `mcpFakes` keys FA1-FA5. A malformed FA key
 * throws `FixtureLoadError` with the rule `mcp-fakes/bad-block:h` (the rule
 * 1.44.0 gave these keys, then unknown), and its message names one of these
 * in brackets after the rule. A recorded file that breaks a `fakes:` rule
 * throws its `mcp-fakes/` value and names none of these.
 */
export const RECORD_REPLAY_LOAD_RULES = [
  "record-replay/fa-list",
  "record-replay/fa-recorded",
  "record-replay/fa-notifications",
  "record-replay/fa-duration",
  "record-replay/fa-timing",
] as const;

export type RecordReplayLoadRule = (typeof RECORD_REPLAY_LOAD_RULES)[number];

// ---------------------------------------------------------------------------
// Constants

/** Default `mount` path of a block. */
export const MCP_FAKES_DEFAULT_MOUNT = "/mcp";

/**
 * Name of the consumption state shared by requests that supply no test id:
 * the journal's `DEFAULT_TEST_ID`. The store keeps that state apart from an
 * explicitly supplied test id equal to this string;
 * `resetState(MCP_FAKES_DEFAULT_TEST_ID)` resets both.
 */
export const MCP_FAKES_DEFAULT_TEST_ID = DEFAULT_TEST_ID;

/**
 * Default FIFO cap on distinct test ids (`McpFakeStoreOptions.maxTestIds`),
 * for a mount with no journal. A mount with a journal mirrors the journal's
 * effective cap (`fixtureCountsMaxTestIdsCap`): 500 under `createServer` unless
 * the option is set, and `0` (unbounded) for a bare `Journal` or an explicit `0`.
 */
export const MCP_FAKES_DEFAULT_MAX_TEST_IDS = 500;

/**
 * Longest text an `echo` of one value produces. Defined in constants.ts so
 * that helpers.ts can share it without an import cycle.
 */
export { MCP_FAKES_ECHO_LIMIT };

/**
 * Deepest nesting of objects and arrays accepted in an `mcpFakes` value: the
 * value itself (a block, or the array of blocks) is level 1. A container
 * below this level is not copied; the input snapshot holds a "nested deeper
 * than 64 levels" value there, which the check of the enclosing field reports
 * as its own bad block.
 */
export const MCP_FAKES_MAX_DEPTH = 64;

/** The reason a container below `MCP_FAKES_MAX_DEPTH` levels is not copied. */
const DEPTH_REASON = msg`nested deeper than ${MCP_FAKES_MAX_DEPTH} levels`;

/** Longest `firstDifference` text (path plus both values), cut the same way. */
const DIFF_LIMIT = 1_000;

const BLOCK_KEYS = new Set([
  "scope",
  "mount",
  "undeclaredTools",
  "tools",
  "list",
  "recorded",
  "timing",
]);
const TOOL_KEYS = new Set(["name", "description", "inputSchema", "calls"]);
const CALL_KEYS = new Set([
  "args",
  "anyArgs",
  "result",
  "error",
  "id",
  "notifications",
  "durationMs",
]);

/**
 * C9: most events one fake event log keeps (per test id, and the untagged
 * log). Past it the oldest event is dropped and the log's report says
 * `evicted: true`. Report-only: claims and snapshots never read it.
 */
export const MCP_FAKES_MAX_EVENTS_PER_LOG = 1000;

/**
 * Largest `args` (JSON, UTF-8 bytes) an event keeps. A larger one is stored as
 * `{ __aimock_truncated: true, originalByteSize }`, the journal `capBody` shape.
 */
export const MCP_FAKES_MAX_EVENT_ARGS_BYTES = 4096;
const SCOPE_KEYS = new Set(["testId", "context"]);

// ---------------------------------------------------------------------------
// Types

/**
 * One validated call entry, with its entry id. Deeply frozen: its `args` /
 * `result` are frozen copies of the caller's values (never the caller's objects).
 */
export type ValidatedCall = Readonly<{
  /**
   * Full entry id: `<source><load>[<block>]:<local>`, where `local` is the
   * user `id` or `<tool>#<index>`.
   */
  id: string;
  /** Position in its tool's `calls`. */
  index: number;
  /** FA3: recorded notifications, in stream order. */
  notifications?: McpFakeDeepReadonly<McpFakeNotification[]>;
  /** FA4: recorded response time in ms. */
  durationMs?: number;
}> &
  McpFakeDeepReadonly<McpFakeCallMatch> &
  McpFakeDeepReadonly<McpFakeCallAnswer>;

/** One validated tool. Deeply frozen; `inputSchema` is a frozen copy. */
export interface ValidatedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: McpFakeDeepReadonly<Record<string, unknown>>;
  readonly calls: readonly ValidatedCall[];
}

/**
 * Scope tiers, most specific first. A tool's candidate entries come from the
 * first tier with an applicable block that declares it.
 */
export type McpFakeTier = "testId+context" | "testId" | "context" | "shared";

const TIER_ORDER: readonly McpFakeTier[] = ["testId+context", "testId", "context", "shared"];

/** One validated block. Deeply frozen: the store hands it out as is. */
export interface ValidatedBlock {
  /** Entry-id `source`: the file's source string, or `code#<n>` / `control-api#<n>`. */
  readonly source: string;
  /** Entry-id load suffix: `""` for the first load of a source, `@<k>` for the k-th. */
  readonly load: string;
  /** `null` when `mcpFakes` was a single object. */
  readonly blockIndex: number | null;
  /** `<source><load>[<block>]`. */
  readonly blockId: string;
  readonly scope: McpFakeScope;
  readonly tier: McpFakeTier;
  readonly mount: string;
  readonly undeclaredTools?: McpFakeUndeclaredPolicy;
  readonly tools: readonly ValidatedTool[];
  /** FA1: the recorded `tools/list`, verbatim. */
  readonly list?: McpFakeDeepReadonly<Record<string, unknown>[]>;
  /** FA2: provenance; never used for matching. */
  readonly recorded?: McpFakeDeepReadonly<McpFakeRecorded>;
  /** FA5: `"recorded"` unless the block says `"immediate"`. */
  readonly timing: "recorded" | "immediate";
}

/**
 * A validation warning: an `args` entry shadowed by an earlier `anyArgs` entry
 * of the same tool. Errors are `FixtureLoadError` instances.
 */
export interface McpFakeIssue {
  file: string | null;
  blockId: string | null;
  entryId: string | null;
  message: string;
}

export interface McpFakesValidation {
  blocks: ValidatedBlock[];
  errors: FixtureLoadError[];
  warnings: McpFakeIssue[];
}

/** A `tools/call` result. */
export type McpFakeCallToolResult = { content: unknown[] } & Record<string, unknown>;

/**
 * One declared entry as named in a mismatch claim or a snapshot. Deeply
 * frozen; `args` is a frozen copy.
 */
export type McpFakeDeclaredEntry = Readonly<{ id: string; consumed: boolean }> &
  McpFakeDeepReadonly<McpFakeCallMatch>;

/**
 * What `McpFakeStore.claim` returns. Frozen, as is everything in it that the
 * store owns (`entry`, `block`, `declared`, `matchingIds`); `result` is a
 * fresh mutable copy for the mount to send, and `received` is the caller's
 * `args` value as given (not copied or frozen), or a new `{}` when it was
 * `undefined`.
 */
export type McpFakeClaim =
  | Readonly<{
      kind: "answer";
      tool: string;
      entry: ValidatedCall;
      block: ValidatedBlock;
      tier: McpFakeTier;
      result: McpFakeCallToolResult;
    }>
  | Readonly<{
      kind: "mismatch";
      tool: string;
      received: unknown;
      declared: readonly McpFakeDeclaredEntry[];
      firstDifference: string;
    }>
  | Readonly<{
      kind: "exhausted";
      tool: string;
      received: unknown;
      matchingDeclared: number;
      matchingConsumed: number;
      matchingIds: readonly string[];
    }>
  | Readonly<{
      /**
       * The test id's consumption state was dropped by the FIFO cap, so
       * which entries it already used is unknown. Fail loud rather than replay
       * an entry; only `resetState(testId)` (or a full reset) clears this. The
       * mark never ages out.
       */
      kind: "evicted";
      tool: string;
      testId: string;
      maxTestIds: number;
    }>
  | Readonly<{ kind: "none" }>;

export interface McpFakeToolListing {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** One block of `McpFakeStore.snapshot()`. Deeply frozen. */
export interface McpFakeBlockSnapshot {
  readonly blockId: string;
  readonly source: string;
  readonly mount: string;
  readonly scope: McpFakeScope;
  readonly undeclaredTools: McpFakeUndeclaredPolicy;
  /**
   * The requested test id's consumption state was evicted by the FIFO cap. Its
   * entries then show `consumed: false` because which ones it used is unknown,
   * and a claim from it of a tool an applicable block declares fails as
   * `evicted` until it is reset.
   */
  readonly evicted: boolean;
  readonly tools: ReadonlyArray<
    Readonly<{ name: string; entries: readonly McpFakeDeclaredEntry[] }>
  >;
}

/** `Omit` over each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * RP2: one `tools/call` on a mount, as its fake event log keeps it. Every
 * `tools/call` is logged, fakes or not.
 */
export type McpFakeReportEvent = {
  /** Process-wide increasing counter (module-level in mcp-fakes.ts), set by logEvent; orders events across mounts (S4). */
  seq: number;
  tool: string;
  args: unknown;
  context: string | null;
  mount: string;
} & (
  | { outcome: "answered"; entryId: string }
  | {
      outcome: "mismatch" | "exhausted" | "not_declared" | "evicted" | "internal_error";
      code: string;
    }
  | {
      outcome: "unfaked";
      answeredBy: "handler" | "config" | "empty" | "unknown-tool" | "upstream";
    }
);

/** What callers pass to logEvent: the event without `seq` (the store assigns it). */
export type McpFakeReportEventInput = DistributiveOmit<McpFakeReportEvent, "seq">;

/**
 * RP3: this mount's part of a fake report, for one test id and context.
 * `served` and `failures` rows carry `seq`, which the report module sorts on
 * across mounts and strips from the JSON it serves.
 */
export interface McpFakeReportPart {
  evicted: boolean;
  served: { entryId: string; mount: string; tool: string; args: unknown; seq: number }[];
  unconsumed: { entryId: string; mount: string; tool: string; args?: unknown; anyArgs?: true }[];
  unfaked: { mount: string; tool: string; args: unknown; answeredBy: string }[];
  failures: { code: string; mount: string; tool: string; args: unknown; seq: number }[];
  sharedUnconsumed: { entryId: string; mount: string; tool: string }[];
}

/** The last `seq` given to an event, shared by every store in the process. */
let lastEventSeq = 0;

/**
 * An event's `args` as the log keeps it: a frozen copy when its JSON is at
 * most `MCP_FAKES_MAX_EVENT_ARGS_BYTES` UTF-8 bytes, else the journal's
 * truncation marker. A value with no JSON text (`undefined`, or one whose
 * `JSON.stringify` throws) is kept as its rendered text.
 */
function boundedArgs(args: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(args) as string | undefined;
  } catch {
    text = undefined;
  }
  if (text === undefined) return args === undefined ? undefined : echo(args);
  const size = Buffer.byteLength(text, "utf8");
  if (size > MCP_FAKES_MAX_EVENT_ARGS_BYTES) {
    return Object.freeze({ __aimock_truncated: true, originalByteSize: size });
  }
  return deepFreeze(JSON.parse(text) as unknown);
}

export interface McpFakeAddOrigin {
  /**
   * `file`: blocks keep their `source` and `blockIndex`, and the per-source
   * load counter (`@<k>`) applies.
   * `code` / `control-api`: one run-time addition; every block gets the source
   * `code#<n>` / `control-api#<n>`, whatever `source` it carried. The
   * input is one `mcpFakes` value of that addition: a single item with a null
   * `blockIndex` is the single-object form (no `[<i>]`); otherwise each block
   * is numbered by its position in the input (`[0]`, `[1]`, ...).
   */
  kind: "file" | "code" | "control-api";
}

/**
 * The origin of an add inside aimock: a public `McpFakeAddOrigin`, or
 * `record`, a run-time addition written by the MCP recorder (MR12), numbered
 * as `code` / `control-api` are, with the source `record#<n>`. Kept off the
 * public `McpFakeAddOrigin`, so that a user `Mountable.addMcpFakes` that
 * switches over its `kind` stays exhaustive.
 *
 * @internal
 */
export interface McpFakeAddOriginInternal {
  kind: McpFakeAddOrigin["kind"] | "record";
}

/** What a successful `McpFakeStore.add` / `Mountable.addMcpFakes` returns. */
export interface McpFakeAddResult {
  /** Shadowed-entry warnings of the added blocks, with their real entry ids. */
  warnings: McpFakeIssue[];
}

/**
 * `McpFakesAddError.toJSON()`: the first error's `rule`, `file`, `blockId` and
 * `entryId`, the combined `message`, and every error and warning.
 */
export interface McpFakesAddErrorJSON extends FixtureLoadErrorJSON {
  name: "McpFakesAddError";
  errors: FixtureLoadErrorJSON[];
  warnings: McpFakeIssue[];
}

/**
 * The error a failed add throws. It is a `FixtureLoadError` whose `rule`,
 * `file`, `blockId` and `entryId` are those of the first error, and whose
 * `message` is the first error's message plus the count of the others.
 * `errors` holds every error found in the input, in order (the first
 * included; see `validateBlock` for the checks that stop early), and
 * `warnings` the shadowed-entry warnings of the blocks that passed every
 * check. Both are frozen, non-writable arrays; `toJSON()` returns copies.
 */
export class McpFakesAddError extends FixtureLoadError {
  override readonly name = "McpFakesAddError";
  declare readonly errors: readonly FixtureLoadError[];
  declare readonly warnings: readonly Readonly<McpFakeIssue>[];

  constructor(errors: readonly FixtureLoadError[], warnings: readonly McpFakeIssue[]) {
    const first = errors[0];
    if (!first) throw new TypeError(build(msg`McpFakesAddError needs at least one error`));
    super({
      rule: first.rule,
      file: first.file,
      blockId: first.blockId,
      entryId: first.entryId,
      detail: "",
    });
    const more = errors.length - 1;
    this.message =
      more > 0
        ? build(
            msg`${fixed(first.message)} (and ${more} more ${fixed(more === 1 ? "error" : "errors")})`,
          )
        : first.message;
    Object.defineProperty(this, "errors", {
      value: Object.freeze([...errors]),
      enumerable: true,
      writable: false,
    });
    Object.defineProperty(this, "warnings", {
      value: Object.freeze(warnings.map((w) => Object.freeze({ ...w }))),
      enumerable: true,
      writable: false,
    });
  }

  override toJSON(): McpFakesAddErrorJSON {
    return {
      ...super.toJSON(),
      name: this.name,
      errors: this.errors.map((e) => e.toJSON()),
      warnings: this.warnings.map((w) => ({ ...w })),
    };
  }
}

// ---------------------------------------------------------------------------
// Small helpers

/** An object whose prototype is `Object.prototype` or `null` (not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The one own-key listing for input data: own, enumerable, string keys.
 * Inherited names (`constructor`, `toString`, `__proto__`) are never listed.
 *
 * @internal
 */
export function ownKeys(obj: object): string[] {
  return Object.keys(obj);
}

/**
 * The one key check: `key` is an own property of `obj`. Unlike `key in obj`,
 * it never sees the prototype chain, so `hasOwnKey({}, "constructor")` is
 * false.
 *
 * @internal
 */
export function hasOwnKey(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * `text` cut to at most `limit` chars in all, as the message builder cuts one
 * part: the kept part, then `…` and the count of chars left out. When even
 * that count does not fit in `limit`, the kept part is followed by a bare
 * `…`. Never ends the kept part inside a surrogate pair, and with `units`
 * `"json"` never inside a JSON escape. A `limit` below 1 keeps nothing
 * (`""`), as `cutText` does; a `NaN` limit is a `RangeError`. Messages do not
 * use it: they are built by `build` (message-text.ts).
 *
 * @internal
 */
export function echoText(
  text: string,
  limit = MCP_FAKES_ECHO_LIMIT,
  units: CutUnits = "text",
): string {
  // Below 1 a user part has no room for its `…`; cut it as `cutText` does.
  if (!(limit >= 1)) return cutText(text, limit, units);
  return build(msg`${units === "json" ? jsonText(text, limit) : plainText(text, limit)}`);
}

/**
 * A user value as one message part: a string is JSON-quoted (quotes and
 * control chars escaped), any other value is rendered as JSON (or as
 * `undefined`, `NaN`, `10n`, ... where JSON cannot at the top level), and a
 * snapshot placeholder, a nested bigint, a cycle, a container too deep, a
 * symbol or function, and a value whose reading throws each as a `<reason>`
 * placeholder whose user text is quoted (see `render`). The builder cuts it
 * once, to its share and to no more than its max, never inside a JSON escape
 * (`\n`, `\u0001`). Whatever the caller's code throws is caught; an error of
 * aimock's own is not.
 */
function shown(value: unknown, max = MCP_FAKES_ECHO_LIMIT): MessageValue {
  return jsonText(render(value), max);
}

/**
 * One user value as message text: `shown`, built alone, so cut to `limit`
 * chars as the builder cuts it. A `limit` below 1 keeps nothing (`""`), as
 * `cutText` does; a `NaN` limit is a `RangeError`.
 *
 * @internal
 */
export function echo(value: unknown, limit = MCP_FAKES_ECHO_LIMIT): string {
  if (!(limit >= 1)) return cutText(render(value), limit, "json");
  return build(msg`${shown(value, limit)}`);
}

function render(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return `${value}n`;
  return renderMember(() => value, "", []) ?? notJson(value);
}

/**
 * Thrown by `userCode` when code the caller supplied throws: a `toJSON`, a
 * getter, a `Proxy` trap, a `toString`. The renderer catches only this, so a
 * defect in aimock's own rendering code is never hidden as a placeholder.
 */
class UserCodeThrew {
  constructor(readonly error: unknown) {}
}

/**
 * `run()`, which touches the caller's value and so may run the caller's code;
 * whatever that code throws comes out as a `UserCodeThrew`.
 */
function userCode<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new UserCodeThrew(error);
  }
}

/** A placeholder in a rendered value: `<reason>`, the reason's text whole. */
function placeholder(reason: Message): string {
  return `<${fullText(reason)}>`;
}

/** The reason a rendered value holds where it reaches one of its own containers. */
const CIRCULAR_REASON = msg`a circular reference`;

/**
 * A value that `renderJson` gives no JSON for (a symbol, a function): a
 * placeholder that names its type and, when it has one, quotes its text.
 */
function notJson(value: unknown): string {
  const reason = msg`not a JSON value (got ${fixed(typeof value)})`;
  let text: string;
  try {
    text = userCode(() => String(value));
  } catch (err) {
    if (!(err instanceof UserCodeThrew)) throw err;
    return placeholder(reason);
  }
  return placeholder(msg`${reason}: ${quote(text)}`);
}

/**
 * One value of a rendered value, read by `read` (which may run the caller's
 * code), rendered by `renderJson`. Where the caller's code throws while it is
 * read or rendered, it renders as an "unreadable value" placeholder that
 * quotes what was thrown, and the rest of the value is kept.
 */
function renderMember(read: () => unknown, key: string, stack: object[]): string | undefined {
  try {
    return renderJson(userCode(read), key, stack);
  } catch (err) {
    if (!(err instanceof UserCodeThrew)) throw err;
    return placeholder(msg`an unreadable value (reading it threw ${describeThrown(err.error)})`);
  }
}

/**
 * `value` as `JSON.stringify` renders it, except that a snapshot placeholder,
 * a bigint below the top level, a cycle (found through `stack`, the
 * containers being rendered) and a container more than `MCP_FAKES_MAX_DEPTH`
 * levels down each render as a `<reason>` placeholder. A placeholder is known
 * by its class, never by its text, so no user value can pose as one.
 * `undefined` where `JSON.stringify` gives `undefined`. Every part it joins
 * is `JSON.stringify` output or placeholder text. Every read of the caller's
 * value goes through `userCode`, so the only error it lets out from the
 * caller's code is a `UserCodeThrew`.
 */
function renderJson(value: unknown, key: string, stack: object[]): string | undefined {
  if (userCode(() => value instanceof NotPlain)) return placeholder((value as NotPlain).reason);
  if (value !== null && (typeof value === "object" || typeof value === "bigint")) {
    const toJSON: unknown = userCode(() => (value as { toJSON?: unknown }).toJSON);
    if (typeof toJSON === "function") value = userCode(() => toJSON.call(value, key) as unknown);
  }
  if (typeof value === "bigint") return placeholder(msg`a bigint (${fixed(`${value}n`)})`);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const container = value;
  const boxed = userCode(
    () =>
      container instanceof Number || container instanceof String || container instanceof Boolean,
  );
  if (boxed) return userCode(() => JSON.stringify(container));
  if (stack.includes(container)) return placeholder(CIRCULAR_REASON);
  if (stack.length >= MCP_FAKES_MAX_DEPTH) return placeholder(DEPTH_REASON);
  stack.push(container);
  try {
    if (userCode(() => Array.isArray(container))) {
      const array = container as readonly unknown[];
      const length = userCode(() => array.length);
      const items: string[] = [];
      for (let i = 0; i < length; i++) {
        items.push(renderMember(() => array[i], String(i), stack) ?? "null");
      }
      return `[${items.join(",")}]`;
    }
    const record = container as Record<string, unknown>;
    const members: string[] = [];
    for (const k of userCode(() => ownKeys(record))) {
      const item = renderMember(() => record[k], k, stack);
      if (item !== undefined) members.push(`${JSON.stringify(k)}:${item}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    stack.pop();
  }
}

/**
 * A thrown value as a message part: its text (user text: a Proxy trap's or a
 * `toJSON`'s message) JSON-quoted; never throws.
 */
function describeThrown(err: unknown): MessageValue {
  try {
    return quote(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } catch {
    return fixed("an unprintable value");
  }
}

/**
 * A built-in `Object.prototype.toString` tag (`[object Date]`). Any other tag
 * can come from a user `Symbol.toStringTag`, so a message JSON-quotes it: it
 * then cannot pose as JSON structure or a `<...>` placeholder, and holds no
 * backslash that is not a JSON escape.
 */
const BUILTIN_TAG = /^\[object [A-Za-z][A-Za-z0-9]*\]$/;

/** A `toString` tag as a message part: a built-in one as is, any other quoted. */
function tagPart(tag: string): MessageValue {
  return BUILTIN_TAG.test(tag) ? fixed(tag) : quote(tag);
}

/**
 * A place in the caller's input that the boundary snapshot could not copy as
 * plain data. It replaces that value in the snapshot, so every later check
 * sees a non-plain value and reports its own rule with `reason`.
 */
class NotPlain {
  constructor(readonly reason: Message) {
    Object.freeze(this);
  }
}

/**
 * The input boundary: one plain-data copy of a caller's value, made once at
 * `McpFakeStore.add` / `validateMcpFakes` entry; every check after it reads
 * only the copy. It reads own, enumerable, string-keyed data properties only:
 * getters are never run and inherited fields never seen. Never throws. Where
 * the value is not plain data, the copy holds a `NotPlain`: a non-plain
 * object or array (`Date`, `Map`, a class instance, an object with a custom
 * prototype), a symbol key, an accessor property, a sparse array, an array
 * with a non-index key, a cycle, a function, symbol or bigint, or a value
 * whose reading throws (a hostile or revoked `Proxy`). Strings, numbers
 * (non-finite ones too), booleans, `null` and `undefined` are kept as is.
 * Copied objects have a `null` prototype.
 *
 * An object or array below `maxDepth` levels (the root is level 1) is not
 * read: the copy holds a "nested deeper than `MCP_FAKES_MAX_DEPTH` levels"
 * `NotPlain` there, so the copy never recurses deeper than that. Only the
 * reflective reads of the caller's value (`readShape`) are guarded by a
 * `catch`; a throw from aimock's own copy code is a bug and propagates.
 *
 * Each caller object is read once, and copied once per level it is reached
 * at: an object reached through several paths (shared references) is not
 * copied once per path, so the time is linear in the number of objects, not
 * exponential in the depth. The copy keeps that sharing. An object on a
 * cycle is still never copied without a placeholder somewhere under it.
 */
function snapshotInput(value: unknown, maxDepth = MCP_FAKES_MAX_DEPTH): unknown {
  return snapshotValue(value, { maxDepth, ancestors: [], shapes: new Map(), copies: new Map() });
}

/** The state of one `snapshotInput` call. */
interface SnapshotState {
  maxDepth: number;
  /** The objects on the path from the root to the one being copied. */
  ancestors: object[];
  /** Each caller object's one `readShape`. */
  shapes: Map<object, Shape | NotPlain>;
  /** Each caller object's copy, by the level (`ancestors.length`) it was copied at. */
  copies: Map<object, Map<number, unknown>>;
}

function snapshotValue(value: unknown, state: SnapshotState): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    return new NotPlain(msg`not a JSON value (got ${fixed(typeof value)})`);
  }
  const { ancestors } = state;
  if (ancestors.includes(value)) return new NotPlain(msg`a circular reference`);
  const level = ancestors.length;
  if (level >= state.maxDepth) {
    return new NotPlain(DEPTH_REASON);
  }
  // A copy depends only on the object and its level (the depth limit). The
  // cycle check above can differ by path, but a copy of an object on a cycle
  // always holds a placeholder, so reusing it never hides the cycle.
  let byLevel = state.copies.get(value);
  if (byLevel?.has(level)) return byLevel.get(level);
  let shape = state.shapes.get(value);
  if (shape === undefined) {
    shape = readShape(value);
    state.shapes.set(value, shape);
  }
  if (shape instanceof NotPlain) return shape;
  ancestors.push(value);
  let copy: unknown;
  try {
    copy = copyShape(shape, state);
  } finally {
    ancestors.pop();
  }
  if (!byLevel) {
    byLevel = new Map();
    state.copies.set(value, byLevel);
  }
  byLevel.set(level, copy);
  return copy;
}

/** What `readShape` read of one caller object: its own enumerable data, in key order. */
interface Shape {
  isArray: boolean;
  /** Own enumerable string keys with their values (`ACCESSOR` for a getter). */
  data: Array<[string, unknown]>;
  /** An array's own `length`. */
  length: number;
}

/**
 * Every reflective read of one caller object, and nothing else: the only
 * code a hostile or revoked `Proxy` can make throw. A throw here is the
 * caller's value being unreadable, so it becomes a `NotPlain`.
 */
function readShape(value: object): Shape | NotPlain {
  try {
    const isArray = Array.isArray(value);
    const proto: unknown = Object.getPrototypeOf(value);
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      const tag = Object.prototype.toString.call(value);
      const what = fixed(isArray ? "array" : "object");
      return new NotPlain(msg`not a plain JSON ${what} (got ${tagPart(tag)})`);
    }
    const data: Array<[string, unknown]> = [];
    for (const key of Reflect.ownKeys(value)) {
      const desc = Reflect.getOwnPropertyDescriptor(value, key);
      if (!desc?.enumerable) continue;
      if (typeof key === "symbol") return new NotPlain(msg`an object with a symbol key`);
      data.push([key, hasOwnKey(desc, "value") ? desc.value : ACCESSOR]);
    }
    const lengthDesc = isArray ? Reflect.getOwnPropertyDescriptor(value, "length") : undefined;
    const length = typeof lengthDesc?.value === "number" ? lengthDesc.value : 0;
    return { isArray, data, length };
  } catch (err) {
    return new NotPlain(msg`an unreadable value (reading it threw ${describeThrown(err)})`);
  }
}

/**
 * Most holes a sparse array may have and still be copied element by element.
 * Its `length` costs the caller nothing, so a longer one is not walked.
 */
const SPARSE_HOLE_LIMIT = 10_000;

/**
 * Copy what `readShape` read; recurses through `snapshotValue`. A hole in a
 * sparse array becomes a placeholder in its own place, so the array is still
 * an array and every other element is still checked.
 */
function copyShape(shape: Shape, state: SnapshotState): unknown {
  const { data, length } = shape;
  if (shape.isArray) {
    const own = new Map(data);
    for (const [key] of data) {
      const n = Number(key);
      if (key !== String(n) || !Number.isInteger(n) || n < 0 || n >= length) {
        return new NotPlain(msg`an array with a non-index key ${quote(key)}`);
      }
    }
    const holes = length - own.size;
    if (holes > SPARSE_HOLE_LIMIT) {
      let hole = 0;
      while (own.has(String(hole))) hole += 1;
      return new NotPlain(msg`a sparse array with ${holes} holes (the first at [${hole}])`);
    }
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const key = String(i);
      out.push(
        own.has(key)
          ? snapshotField(own.get(key), state)
          : new NotPlain(msg`a hole in a sparse array`),
      );
    }
    return out;
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of data) {
    Object.defineProperty(out, key, {
      value: snapshotField(item, state),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Marks an accessor property in `readShape` (its getter is never run). */
const ACCESSOR: unique symbol = Symbol("accessor");

function snapshotField(item: unknown, state: SnapshotState): unknown {
  return item === ACCESSOR
    ? new NotPlain(msg`an accessor property (getters are not read)`)
    : snapshotValue(item, state);
}

/**
 * A copy of `value`, a snapshot copy, with every container below `levels`
 * levels (the value itself is level 1) replaced by the depth placeholder.
 * Used by `McpFakeStore.add` for a block of an array-form `mcpFakes`, whose
 * array is level 1. It does not change `value`: a snapshot can share one copy
 * between paths at different levels. Each container is copied once per level
 * (`memo`), so shared references stay linear.
 */
function capDepth(
  value: unknown,
  levels: number,
  memo = new Map<object, Map<number, unknown>>(),
): unknown {
  if (value instanceof NotPlain || typeof value !== "object" || value === null) return value;
  if (levels < 1) return new NotPlain(DEPTH_REASON);
  let byLevel = memo.get(value);
  if (byLevel?.has(levels)) return byLevel.get(levels);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item: unknown) => capDepth(item, levels - 1, memo));
  } else {
    const src = value as Record<string, unknown>;
    const obj = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys(src)) {
      Object.defineProperty(obj, key, {
        value: capDepth(src[key], levels - 1, memo),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    out = obj;
  }
  if (!byLevel) {
    byLevel = new Map();
    memo.set(value, byLevel);
  }
  byLevel.set(levels, out);
  return out;
}

/**
 * Freeze `value` and everything under it (plain data only). A frozen object
 * is not walked again: this module freezes children before their parent, and
 * a shared child is then frozen once.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of ownKeys(obj)) deepFreeze(obj[key]);
    Object.freeze(value);
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A field is present when it is an own key whose value is not `undefined`. */
function has(raw: Record<string, unknown>, key: string): boolean {
  return hasOwnKey(raw, key) && raw[key] !== undefined;
}

/** Own keys whose value is not `undefined` (an `undefined` field is absent). */
function presentKeys(raw: Record<string, unknown>): string[] {
  return ownKeys(raw).filter((key) => raw[key] !== undefined);
}

/**
 * The first place under `value` that is not plain JSON (as `JSON.parse` could
 * produce it), or `null`. An object field set to `undefined` is absent, as in
 * `JSON.stringify`. Rejects an `undefined` array item, functions, symbols,
 * bigints, non-finite numbers, sparse-array holes and objects whose prototype
 * is not `Object.prototype` or `null` (`Date`, `Map`, class instances). Its
 * input is always the input snapshot, which holds no cycle (`snapshotInput`
 * puts a placeholder there) and no container deeper than
 * `MCP_FAKES_MAX_DEPTH`, so the recursion is bounded. A container found clean
 * is not checked again (`clean`), so a shared one is walked once.
 */
function jsonProblem(
  value: unknown,
  path: string,
  clean: WeakSet<object> = new WeakSet(),
): Message | null {
  if (value instanceof NotPlain) return msg`${pathPart(path)} is ${value.reason}`;
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : msg`${pathPart(path)} must be a finite number, got ${shown(value)}`;
  }
  if (typeof value !== "object") {
    return msg`${pathPart(path)} is not a JSON value (got ${fixed(typeof value)})`;
  }
  if (clean.has(value)) return null;
  let problem: Message | null = null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && !problem; i++) {
      problem = hasOwnKey(value, String(i))
        ? jsonProblem(value[i], `${path}[${i}]`, clean)
        : msg`${pathPart(`${path}[${i}]`)} is a hole in a sparse array`;
    }
  } else {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const tag = Object.prototype.toString.call(value);
      problem = msg`${pathPart(path)} must be a plain JSON object, got ${tagPart(tag)}`;
    } else {
      const obj = value as Record<string, unknown>;
      for (const key of presentKeys(obj)) {
        problem = jsonProblem(obj[key], pathKey(path, key), clean);
        if (problem) break;
      }
    }
  }
  if (!problem) clean.add(value);
  return problem;
}

/**
 * Deep copy of a plain JSON value (checked by `jsonProblem`), optionally
 * deep-frozen. Keys are defined, not assigned, so `"__proto__"` stays data;
 * a field set to `undefined` is left out. A container reached through several
 * paths is copied once (`memo`), and the copy shares it the same way.
 */
function copyJson(value: unknown, freeze = false, memo = new Map<object, unknown>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (memo.has(value)) return memo.get(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item: unknown) => copyJson(item, freeze, memo));
  } else {
    const src = value as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const key of presentKeys(src)) {
      Object.defineProperty(obj, key, {
        value: copyJson(src[key], freeze, memo),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    out = obj;
  }
  if (freeze) Object.freeze(out);
  memo.set(value, out);
  return out;
}

/** Block id: `<source><load>[<block>]`, with no `[<block>]` for a single-object `mcpFakes`. */
export function blockIdOf(source: string, loadSuffix: string, blockIndex: number | null): string {
  return `${source}${loadSuffix}${blockIndex === null ? "" : `[${blockIndex}]`}`;
}

function localOf(toolName: string, index: number, userId: unknown): string {
  return isNonEmptyString(userId) ? userId : `${toolName}#${index}`;
}

/**
 * Entry ids of one block: `<source><load>[<block>]:<local>`, where `local` is
 * the user `id` or `<tool>#<index>`. Flat, in tool order then `calls` order.
 */
export function entryIds(
  block: {
    blockIndex: number | null;
    tools: ReadonlyArray<{ name: string; calls: ReadonlyArray<{ id?: unknown }> }>;
  },
  source: string,
  loadSuffix: string,
): string[] {
  const prefix = blockIdOf(source, loadSuffix, block.blockIndex);
  const ids: string[] = [];
  for (const tool of block.tools) {
    tool.calls.forEach((call, index) => {
      ids.push(`${prefix}:${localOf(tool.name, index, call.id)}`);
    });
  }
  return ids;
}

function tierOf(scope: McpFakeScope): McpFakeTier {
  if (scope === "shared") return "shared";
  if (scope.testId !== undefined && scope.context !== undefined) return "testId+context";
  if (scope.testId !== undefined) return "testId";
  return "context";
}

/** Scope match: exact, case-sensitive, no normalization; `"shared"` matches every request. */
function scopeMatches(scope: McpFakeScope, identity: McpFakeIdentity): boolean {
  if (scope === "shared") return true;
  if (scope.testId !== undefined && identity.testId !== scope.testId) return false;
  if (scope.context !== undefined && identity.context !== scope.context) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Validation (bad-block cases (a)-(j), shadowed-entry warnings)

interface BlockContext {
  source: string;
  load: string;
  blockIndex: number | null;
  blockId: string;
}

/** A bad-block letter, `a` to `j`: one with a `mcp-fakes/bad-block:<letter>` rule. */
type BadBlockLetter = McpFakesLoadRule extends infer R
  ? R extends `mcp-fakes/bad-block:${infer L}`
    ? L
    : never
  : never;

function badBlock(
  ctx: { source: string | null; blockId: string | null },
  letter: BadBlockLetter,
  detail: Message,
  entryId: string | null = null,
): FixtureLoadError {
  return new FixtureLoadError({
    rule: `mcp-fakes/bad-block:${letter}`,
    file: ctx.source,
    blockId: ctx.blockId,
    entryId,
    detail,
  });
}

/** Every scope error goes to `errors`; returns the scope only when it is clean. */
function validateScope(
  raw: unknown,
  ctx: BlockContext,
  errors: FixtureLoadError[],
): McpFakeScope | null {
  if (raw === undefined) {
    errors.push(badBlock(ctx, "a", msg`block has no scope`));
    return null;
  }
  if (raw === "shared") return "shared";
  if (!isPlainObject(raw)) {
    errors.push(badBlock(ctx, "b", msg`scope must be "shared" or an object, got ${shown(raw)}`));
    return null;
  }
  const before = errors.length;
  for (const key of presentKeys(raw)) {
    if (!SCOPE_KEYS.has(key))
      errors.push(badBlock(ctx, "b", msg`scope has unknown key ${shown(key)}`));
  }
  if (!has(raw, "testId") && !has(raw, "context")) {
    errors.push(badBlock(ctx, "b", msg`scope object has neither testId nor context`));
  }
  for (const key of ["testId", "context"] as const) {
    if (has(raw, key) && !isNonEmptyString(raw[key])) {
      errors.push(
        badBlock(
          ctx,
          "b",
          msg`scope.${fixed(key)} must be a non-empty string, got ${shown(raw[key])}`,
        ),
      );
    }
  }
  if (errors.length > before) return null;
  const testId = raw.testId as string | undefined;
  const context = raw.context as string | undefined;
  if (testId !== undefined && context !== undefined) return Object.freeze({ testId, context });
  if (testId !== undefined) return Object.freeze({ testId });
  return Object.freeze({ context: context as string });
}

// ---------------------------------------------------------------------------
// `tools/call` result and tool-definition shapes
//
// A fake's `result` must be a `CallToolResult` that the `@modelcontextprotocol/sdk`
// 1.31 client accepts, and a fake tool a `Tool` its `tools/list` accepts. The
// checks are the SDK client rules that a bad value breaks: the content array,
// each item's `type` and required fields, `isError`, `structuredContent`,
// base64 `data` / `blob`, the `Annotations` and `Icon` value rules, the result
// `_meta` keys the SDK reads, and `inputSchema.type`. The SDK differential
// test (mcp-fakes-sdk-differential.test.ts) checks them against the SDK
// schemas. Two checks are aimock's own and stricter than SDK 1.31:
// - A full result must have a `content` array. The SDK defaults a missing
//   `content` to `[]`, but here an object with `isError` or
//   `structuredContent` and no `content` is far more likely a mistake (or
//   structured data meant to be served as is) than an empty answer.
// - Each `inputSchema.properties` value must be a JSON object. The SDK
//   accepts any non-null object, arrays included, but a JSON Schema property
//   schema is an object, and an array there is a fixture mistake.
// Only the full-result envelope is a closed format (a misspelled `isError`
// must not reach a client as a success); unknown keys inside a content item
// pass through, as the SDK client ignores them.

/** A check of one value; returns a problem or `null`. */
type FieldCheck = (value: unknown, path: string) => Message | null;

const mustBeString: FieldCheck = (v, p) =>
  typeof v === "string" ? null : msg`${pathPart(p)} must be a string, got ${shown(v)}`;

const mustBeNumber: FieldCheck = (v, p) =>
  typeof v === "number" ? null : msg`${pathPart(p)} must be a number, got ${shown(v)}`;

const mustBeBoolean: FieldCheck = (v, p) =>
  typeof v === "boolean" ? null : msg`${pathPart(p)} must be a boolean, got ${shown(v)}`;

const mustBeObject: FieldCheck = (v, p) =>
  isPlainObject(v) ? null : msg`${pathPart(p)} must be a JSON object, got ${shown(v)}`;

/** Base64 as the SDK's `Base64Schema` accepts it (`atob` does not throw). */
const mustBeBase64: FieldCheck = (v, p) => {
  if (typeof v === "string") {
    try {
      atob(v);
      return null;
    } catch {
      // not base64: fall through
    }
  }
  return msg`${pathPart(p)} must be a base64 string, got ${shown(v)}`;
};

function oneOf(values: readonly string[]): FieldCheck {
  const list = values.map((v) => quoteJson(v)).join(", ");
  return (v, p) =>
    typeof v === "string" && values.includes(v)
      ? null
      : msg`${pathPart(p)} must be one of ${fixed(list)}, got ${shown(v)}`;
}

function arrayOf(item: FieldCheck, noun = "an array"): FieldCheck {
  return (v, p) => {
    if (!Array.isArray(v)) return msg`${pathPart(p)} must be ${fixed(noun)}, got ${shown(v)}`;
    for (let i = 0; i < v.length; i++) {
      const problem = item(v[i], `${p}[${i}]`);
      if (problem) return problem;
    }
    return null;
  };
}

const mustBeStringArray = arrayOf(mustBeString, "an array of strings");

/**
 * An object with `required` fields and `optional` ones (an `undefined` field
 * is absent). Other keys are not checked.
 */
function shape(
  required: Readonly<Record<string, FieldCheck>>,
  optional: Readonly<Record<string, FieldCheck>> = {},
): FieldCheck {
  return (v, p) => {
    if (!isPlainObject(v)) return msg`${pathPart(p)} must be a JSON object, got ${shown(v)}`;
    for (const key of ownKeys(required)) {
      const check = required[key];
      const problem = check(has(v, key) ? v[key] : undefined, pathKey(p, key));
      if (problem) return problem;
    }
    for (const key of ownKeys(optional)) {
      const check = optional[key];
      if (!has(v, key)) continue;
      const problem = check(v[key], pathKey(p, key));
      if (problem) return problem;
    }
    return null;
  };
}

/**
 * RFC 3339 date-time with seconds and a `Z` or `±hh:mm` offset: the pattern of
 * zod's `z.iso.datetime({ offset: true })`, which the SDK uses for
 * `Annotations.lastModified`.
 */
const ISO_DATETIME =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const mustBeIsoDateTime: FieldCheck = (v, p) =>
  typeof v === "string" && ISO_DATETIME.test(v)
    ? null
    : msg`${pathPart(p)} must be an ISO 8601 date-time with seconds and an offset, got ${shown(v)}`;

const ANNOTATIONS = shape(
  {},
  {
    audience: arrayOf(oneOf(["user", "assistant"])),
    priority: (v, p) =>
      typeof v === "number" && v >= 0 && v <= 1
        ? null
        : msg`${pathPart(p)} must be a number from 0 to 1, got ${shown(v)}`,
    lastModified: mustBeIsoDateTime,
  },
);

const ICON = shape(
  { src: mustBeString },
  { mimeType: mustBeString, sizes: mustBeStringArray, theme: oneOf(["light", "dark"]) },
);

/** MCP `TextResourceContents` / `BlobResourceContents`: exactly one of text / blob. */
const RESOURCE_CONTENTS: FieldCheck = (v, p) => {
  if (!isPlainObject(v)) {
    return msg`${pathPart(p)} must be a JSON object with uri and text or blob, got ${shown(v)}`;
  }
  if (has(v, "text") === has(v, "blob"))
    return msg`${pathPart(p)} needs exactly one of text / blob`;
  const body: Record<string, FieldCheck> = has(v, "text")
    ? { text: mustBeString }
    : { blob: mustBeBase64 };
  return shape({ uri: mustBeString, ...body }, { mimeType: mustBeString, _meta: mustBeObject })(
    v,
    p,
  );
};

/** Fields every content block may carry. */
const CONTENT_COMMON = { annotations: ANNOTATIONS, _meta: mustBeObject };

/** Each MCP content block type, with its fields. */
const CONTENT_TYPES = new Map<string, FieldCheck>([
  ["text", shape({ text: mustBeString }, CONTENT_COMMON)],
  ["image", shape({ data: mustBeBase64, mimeType: mustBeString }, CONTENT_COMMON)],
  ["audio", shape({ data: mustBeBase64, mimeType: mustBeString }, CONTENT_COMMON)],
  [
    "resource_link",
    shape(
      { uri: mustBeString, name: mustBeString },
      {
        title: mustBeString,
        description: mustBeString,
        mimeType: mustBeString,
        size: mustBeNumber,
        icons: arrayOf(ICON),
        ...CONTENT_COMMON,
      },
    ),
  ],
  ["resource", shape({ resource: RESOURCE_CONTENTS }, CONTENT_COMMON)],
]);

const CONTENT_TYPE_LIST = [...CONTENT_TYPES.keys()].map((type) => quoteJson(type)).join(", ");

/** One MCP content block, checked by its `type`. */
const CONTENT_BLOCK: FieldCheck = (v, p) => {
  if (!isPlainObject(v)) return msg`${pathPart(p)} must be a content object, got ${shown(v)}`;
  const check = typeof v.type === "string" ? CONTENT_TYPES.get(v.type) : undefined;
  if (!check)
    return msg`${pathPart(p)}.type must be one of ${fixed(CONTENT_TYPE_LIST)}, got ${shown(v.type)}`;
  return check(v, p);
};

const CONTENT = arrayOf(CONTENT_BLOCK, "an array of content blocks");

/** The SDK client's `RequestMeta` keys on a result's `_meta`; other keys pass through. */
const RESULT_META = shape(
  {},
  {
    progressToken: (v, p) =>
      typeof v === "string" || Number.isSafeInteger(v)
        ? null
        : msg`${pathPart(p)} must be a string or an integer, got ${shown(v)}`,
    "io.modelcontextprotocol/related-task": shape({ taskId: mustBeString }),
  },
);

/**
 * The keys of a full `CallToolResult`. An object `result` with any of
 * them is that form, and must have a `content` array; any other object is
 * structured data.
 */
const FULL_RESULT_KEYS = new Set(["content", "isError", "structuredContent", "_meta"]);

const FULL_RESULT = shape(
  { content: CONTENT },
  { isError: mustBeBoolean, structuredContent: mustBeObject, _meta: RESULT_META },
);

function isFullResult(obj: Record<string, unknown>): boolean {
  return [...FULL_RESULT_KEYS].some((key) => has(obj, key));
}

/**
 * A valid `result`: a string; a content array; a full `CallToolResult` (`content`
 * array, optional boolean `isError`, optional object `structuredContent` and
 * `_meta`, nothing else); or a JSON object with none of those keys (served as
 * text plus `structuredContent`).
 */
function validateResult(result: unknown): Message | null {
  if (typeof result === "string") return null;
  if (!Array.isArray(result) && !isPlainObject(result)) {
    return msg`result must be a string, a content array or an object, got ${shown(result)}`;
  }
  const json = jsonProblem(result, "result");
  if (json) return json;
  if (Array.isArray(result)) return CONTENT(result, "result");
  if (!isFullResult(result)) return null;
  for (const key of presentKeys(result)) {
    if (!FULL_RESULT_KEYS.has(key)) return msg`result has unknown key ${shown(key)}`;
  }
  return FULL_RESULT(result, "result");
}

/**
 * MCP `Tool.inputSchema`: a JSON Schema object with `type: "object"` at the
 * root; `properties`, when present, maps names to schema objects, and
 * `required`, when present, lists names. Any other JSON Schema keyword is
 * allowed.
 */
const INPUT_SCHEMA = shape(
  {
    type: (v, p) => (v === "object" ? null : msg`${pathPart(p)} must be "object", got ${shown(v)}`),
  },
  {
    properties: (v, p) => {
      if (!isPlainObject(v)) return mustBeObject(v, p);
      for (const key of presentKeys(v)) {
        const problem = mustBeObject(v[key], pathKey(p, key));
        if (problem) return problem;
      }
      return null;
    },
    required: mustBeStringArray,
  },
);

function inputSchemaProblem(schema: unknown): Message | null {
  if (!isPlainObject(schema)) return mustBeObject(schema, "inputSchema");
  return jsonProblem(schema, "inputSchema") ?? INPUT_SCHEMA(schema, "inputSchema");
}

// ---------------------------------------------------------------------------
// Recorded keys FA1-FA5

/** A finite number >= 0 (FA3 `atMs`, FA4 `durationMs`). */
const mustBeNonNegative: FieldCheck = (v, p) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0
    ? null
    : msg`${pathPart(p)} must be a number >= 0, got ${shown(v)}`;

/** FA2 `recorded`. Other keys are not checked. */
const RECORDED = shape(
  {
    upstream: mustBeString,
    protocolVersion: mustBeString,
    aimockVersion: mustBeString,
    at: mustBeIsoDateTime,
  },
  { serverInfo: mustBeObject },
);

/** One FA3 notification. Other keys are not checked. */
const NOTIFICATION = shape({ atMs: mustBeNonNegative, method: mustBeString, params: mustBeObject });

/** FA1: an array of JSON objects, each with a string `name`, no name twice. */
function listProblem(v: unknown): Message | null {
  if (!Array.isArray(v)) return msg`list must be an array of tool objects, got ${shown(v)}`;
  const json = jsonProblem(v, "list");
  if (json) return json;
  const names = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const tool: unknown = v[i];
    if (!isPlainObject(tool) || typeof tool.name !== "string") {
      return msg`list[${i}] must be a tool object with a string name, got ${shown(tool)}`;
    }
    if (names.has(tool.name)) return msg`list[${i}] repeats the tool name ${quote(tool.name)}`;
    names.add(tool.name);
  }
  return null;
}

/** FA2. */
function recordedProblem(v: unknown): Message | null {
  if (!isPlainObject(v)) return msg`recorded must be a JSON object, got ${shown(v)}`;
  return jsonProblem(v, "recorded") ?? RECORDED(v, "recorded");
}

/** FA3. */
function notificationsProblem(v: unknown): Message | null {
  if (!Array.isArray(v)) return msg`notifications must be an array, got ${shown(v)}`;
  return (
    jsonProblem(v, "notifications") ??
    arrayOf(NOTIFICATION, "an array of notifications")(v, "notifications")
  );
}

/**
 * A malformed FA key of one block (and, for FA3/FA4, one entry): the 1.44.0
 * rule `mcp-fakes/bad-block:h`, with the `record-replay/fa-*` value first in
 * the message detail (`[mcp-fakes/bad-block:h] [record-replay/fa-list] ...`).
 */
function faError(
  ctx: { source: string | null; blockId: string | null },
  faRule: RecordReplayLoadRule,
  detail: Message,
  entryId: string | null = null,
): FixtureLoadError {
  return new FixtureLoadError({
    rule: "mcp-fakes/bad-block:h",
    file: ctx.source,
    blockId: ctx.blockId,
    entryId,
    detail: msg`[${fixed(faRule)}] ${detail}`,
  });
}

/**
 * Validate one call entry of the input snapshot. Every error goes to
 * `errors`; returns its entry id whether or not it is clean, so that the
 * block's entry-id uniqueness check also sees invalid entries, and the frozen call
 * only when it is clean. `toolName` is the tool's name, or a `tools[<i>]`
 * placeholder when that name is invalid.
 */
function validateCall(
  raw: unknown,
  toolName: string,
  label: Message,
  index: number,
  ctx: BlockContext,
  errors: FixtureLoadError[],
): { entryId: string; call: ValidatedCall | null } {
  const idRaw = isPlainObject(raw) ? raw.id : undefined;
  const entryId = `${ctx.blockId}:${localOf(toolName, index, idRaw)}`;
  const where = msg`${label} calls[${index}]`;
  const bad = (letter: BadBlockLetter, detail: Message): void => {
    errors.push(badBlock(ctx, letter, msg`${where} ${detail}`, entryId));
  };
  if (!isPlainObject(raw)) {
    bad("d", msg`must be an object, got ${shown(raw)}`);
    return { entryId, call: null };
  }
  const before = errors.length;
  for (const key of presentKeys(raw)) {
    if (!CALL_KEYS.has(key)) bad("h", msg`has unknown key ${shown(key)}`);
  }
  // FA3/FA4 here, where 1.44.0 rejected them as unknown keys (R13).
  if (has(raw, "notifications")) {
    const problem = notificationsProblem(raw.notifications);
    if (problem) {
      errors.push(
        faError(ctx, "record-replay/fa-notifications", msg`${where} ${problem}`, entryId),
      );
    }
  }
  if (has(raw, "durationMs")) {
    const problem = mustBeNonNegative(raw.durationMs, "durationMs");
    if (problem) {
      errors.push(faError(ctx, "record-replay/fa-duration", msg`${where} ${problem}`, entryId));
    }
  }
  if (has(raw, "id") && !isNonEmptyString(raw.id)) {
    bad("d", msg`id must be a non-empty string, got ${shown(raw.id)}`);
  }
  if (has(raw, "anyArgs") && raw.anyArgs !== true) {
    bad("j", msg`anyArgs must be true, got ${shown(raw.anyArgs)}`);
  }
  const hasArgs = has(raw, "args");
  const hasAnyArgs = has(raw, "anyArgs");
  if (hasArgs === hasAnyArgs) bad("d", msg`needs exactly one of args / anyArgs`);
  if (hasArgs) {
    const problem = isPlainObject(raw.args)
      ? jsonProblem(raw.args, "args")
      : msg`args must be a JSON object, got ${shown(raw.args)}`;
    if (problem) bad("d", problem);
  }
  const hasResult = has(raw, "result");
  const hasError = has(raw, "error");
  if (hasResult === hasError) bad("d", msg`needs exactly one of result / error`);
  if (hasError && typeof raw.error !== "string") {
    bad("d", msg`error must be a string, got ${shown(raw.error)}`);
  }
  if (hasResult) {
    const problem = validateResult(raw.result);
    if (problem) bad("d", problem);
  }
  if (errors.length > before) return { entryId, call: null };
  // Frozen copies of the snapshot: nothing the store keeps can be changed.
  const match: McpFakeCallMatch = hasArgs
    ? { args: copyJson(raw.args, true) as Record<string, unknown> }
    : { anyArgs: true };
  const answer: McpFakeCallAnswer = hasResult
    ? { result: copyJson(raw.result, true) as McpFakeResult }
    : { error: raw.error as string };
  const recorded: { notifications?: McpFakeNotification[]; durationMs?: number } = {};
  if (has(raw, "notifications")) {
    recorded.notifications = copyJson(raw.notifications, true) as McpFakeNotification[];
  }
  if (has(raw, "durationMs")) recorded.durationMs = raw.durationMs as number;
  return {
    entryId,
    call: Object.freeze({ id: entryId, index, ...match, ...answer, ...recorded }),
  };
}

/**
 * Validate one tool of the input snapshot. Every error goes to `errors`, and
 * the entry ids of all its calls (valid or not; with an invalid tool name,
 * only the user ids) to `entryIds`; returns the frozen tool only when it is
 * clean.
 */
function validateTool(
  raw: unknown,
  index: number,
  ctx: BlockContext,
  errors: FixtureLoadError[],
  entryIds: string[],
): ValidatedTool | null {
  const where = `tools[${index}]`;
  const place = msg`tools[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push(badBlock(ctx, "g", msg`${place} must be an object, got ${shown(raw)}`));
    return null;
  }
  const before = errors.length;
  for (const key of presentKeys(raw)) {
    if (!TOOL_KEYS.has(key)) {
      errors.push(badBlock(ctx, "h", msg`${place} has unknown key ${shown(key)}`));
    }
  }
  const name = isNonEmptyString(raw.name) ? raw.name : null;
  if (name === null) {
    errors.push(badBlock(ctx, "g", msg`${place} needs a string name, got ${shown(raw.name)}`));
  }
  // Where the tool's problems are: its name, or its place when the name is invalid.
  const tw = name === null ? place : msg`tool ${quote(name)}`;
  if (has(raw, "description") && typeof raw.description !== "string") {
    errors.push(
      badBlock(ctx, "g", msg`${tw} description must be a string, got ${shown(raw.description)}`),
    );
  }
  if (has(raw, "inputSchema")) {
    const problem = inputSchemaProblem(raw.inputSchema);
    if (problem) {
      errors.push(badBlock(ctx, "g", msg`${tw} ${problem}`));
    }
  }
  const calls: ValidatedCall[] = [];
  if (!Array.isArray(raw.calls) || raw.calls.length === 0) {
    errors.push(
      badBlock(ctx, "g", msg`${tw} calls must be a non-empty array, got ${shown(raw.calls)}`),
    );
  } else {
    raw.calls.forEach((rawCall: unknown, i: number) => {
      const { entryId, call } = validateCall(rawCall, name ?? where, tw, i, ctx, errors);
      // With an invalid name, a default id is a stand-in (`tools[<i>]#<n>`)
      // that names the entry in its errors but is not an id the user meant to
      // declare, so it is left out of the uniqueness checks. A user `id` does
      // not depend on the name and is checked.
      if (name !== null || (isPlainObject(rawCall) && isNonEmptyString(rawCall.id))) {
        entryIds.push(entryId);
      }
      if (call) calls.push(call);
    });
  }
  if (errors.length > before || name === null) return null;
  const tool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    calls: readonly ValidatedCall[];
  } = { name, calls: Object.freeze(calls) };
  if (typeof raw.description === "string") tool.description = raw.description;
  if (isPlainObject(raw.inputSchema)) {
    tool.inputSchema = copyJson(raw.inputSchema, true) as Record<string, unknown>;
  }
  return Object.freeze(tool);
}

/** What `validateBlock` found for one block. */
interface BlockOutcome {
  /** The deeply frozen block, or `null` when it has any error. */
  block: ValidatedBlock | null;
  /**
   * Distinct entry ids of every call the block declares, valid or not, for
   * the caller's cross-block uniqueness check.
   */
  entryIds: string[];
  /** Shadowed-entry warnings; only a clean block has any. */
  warnings: McpFakeIssue[];
}

/**
 * Validate one block of the input snapshot. Every check runs and each problem
 * goes to `errors` (no first-stop), with two limits: a block, tool or call
 * entry that is not an object is not checked further, and one `result` or
 * `inputSchema` value reports only its first problem. Entry-id uniqueness
 * inside the block is checked here over every declared entry, valid or not;
 * uniqueness across blocks is the caller's.
 */
function validateBlock(
  raw: unknown,
  source: string,
  blockIndex: number | null,
  load: string,
  errors: FixtureLoadError[],
): BlockOutcome {
  const ctx: BlockContext = {
    source,
    load,
    blockIndex,
    blockId: blockIdOf(source, load, blockIndex),
  };
  if (!isPlainObject(raw)) {
    errors.push(badBlock(ctx, "i", msg`mcpFakes block must be an object, got ${shown(raw)}`));
    return { block: null, entryIds: [], warnings: [] };
  }
  const before = errors.length;
  for (const key of presentKeys(raw)) {
    if (!BLOCK_KEYS.has(key))
      errors.push(badBlock(ctx, "h", msg`block has unknown key ${shown(key)}`));
  }
  // The FA keys are checked here, where 1.44.0 rejected them as unknown keys,
  // so a block with a bad FA key and another error keeps the 1.44.0 first
  // rule, `mcp-fakes/bad-block:h` (R13).
  if (has(raw, "list")) {
    const problem = listProblem(raw.list);
    if (problem) errors.push(faError(ctx, "record-replay/fa-list", problem));
  }
  if (has(raw, "recorded")) {
    const problem = recordedProblem(raw.recorded);
    if (problem) errors.push(faError(ctx, "record-replay/fa-recorded", problem));
  }
  let timing: "recorded" | "immediate" = "recorded";
  if (has(raw, "timing")) {
    if (raw.timing === "recorded" || raw.timing === "immediate") {
      timing = raw.timing;
    } else {
      errors.push(
        faError(
          ctx,
          "record-replay/fa-timing",
          msg`timing must be "recorded" or "immediate", got ${shown(raw.timing)}`,
        ),
      );
    }
  }
  const scope = validateScope(raw.scope, ctx, errors);

  let undeclared: McpFakeUndeclaredPolicy | undefined;
  if (has(raw, "undeclaredTools")) {
    if (raw.undeclaredTools === "allow" || raw.undeclaredTools === "deny") {
      undeclared = raw.undeclaredTools;
    } else {
      errors.push(
        badBlock(
          ctx,
          "g",
          msg`undeclaredTools must be "allow" or "deny", got ${shown(raw.undeclaredTools)}`,
        ),
      );
    }
  }
  if (scope === "shared" && undeclared === "deny") {
    errors.push(badBlock(ctx, "c", msg`scope "shared" cannot have undeclaredTools "deny"`));
  }
  let mount = MCP_FAKES_DEFAULT_MOUNT;
  if (has(raw, "mount")) {
    if (typeof raw.mount === "string" && raw.mount.startsWith("/")) {
      mount = raw.mount;
    } else {
      errors.push(
        badBlock(ctx, "g", msg`mount must be a string starting with "/", got ${shown(raw.mount)}`),
      );
    }
  }

  const tools: ValidatedTool[] = [];
  const declaredIds: string[] = [];
  if (!Array.isArray(raw.tools)) {
    errors.push(badBlock(ctx, "g", msg`tools must be an array, got ${shown(raw.tools)}`));
  } else if (raw.tools.length === 0) {
    // Bad block (g): an empty `tools` is allowed only on a scoped `deny` block,
    // where it closes the world. A block with `deny` and a bad scope reports
    // only the scope error; without `deny`, the empty `tools` is reported too.
    if (undeclared !== "deny" || scope === "shared") {
      errors.push(
        badBlock(
          ctx,
          "g",
          msg`tools is empty; an empty tools array (tools: []) is allowed only on a scoped (not "shared") block with undeclaredTools "deny"`,
        ),
      );
    }
  } else {
    // (e) is keyed on the raw name, so a duplicate is found even when the
    // first declaration is invalid. A duplicate's entries, user ids included,
    // are left out of the id-uniqueness checks (in the block, and across
    // blocks and the mount): its default ids repeat the first declaration's
    // by construction. The block already fails (e), so no load is lost.
    const names = new Set<string>();
    raw.tools.forEach((rawTool: unknown, i: number) => {
      const name = isPlainObject(rawTool) && isNonEmptyString(rawTool.name) ? rawTool.name : null;
      const duplicate = name !== null && names.has(name);
      if (duplicate) {
        errors.push(badBlock(ctx, "e", msg`tool ${quote(name)} is declared twice in one block`));
      } else if (name !== null) {
        names.add(name);
      }
      const tool = validateTool(rawTool, i, ctx, errors, duplicate ? [] : declaredIds);
      if (tool && !duplicate) tools.push(tool);
    });
  }

  // Entry-id uniqueness inside the block: every later occurrence of an id is an offender.
  const seen = new Set<string>();
  for (const id of declaredIds) {
    if (seen.has(id)) {
      errors.push(badBlock(ctx, "f", msg`entry id ${quote(id)} is not unique`, id));
    }
    seen.add(id);
  }
  const entryIds = [...seen];
  if (errors.length > before || scope === null) return { block: null, entryIds, warnings: [] };

  // Shadowed-entry warning: an args entry after an anyArgs entry of the same tool.
  const warnings: McpFakeIssue[] = [];
  for (const tool of tools) {
    let lastAny: ValidatedCall | null = null;
    for (const call of tool.calls) {
      if (call.anyArgs) {
        lastAny = call;
      } else if (lastAny) {
        warnings.push({
          file: source,
          blockId: ctx.blockId,
          entryId: call.id,
          message: build(
            msg`entry ${quote(call.id)} is shadowed until the preceding anyArgs entry ${quote(lastAny.id)} is consumed`,
          ),
        });
      }
    }
  }

  const block: ValidatedBlock = Object.freeze({
    source,
    load,
    blockIndex,
    blockId: ctx.blockId,
    scope,
    tier: tierOf(scope),
    mount,
    ...(undeclared !== undefined ? { undeclaredTools: undeclared } : {}),
    tools: Object.freeze(tools),
    ...(has(raw, "list") ? { list: copyJson(raw.list, true) as Record<string, unknown>[] } : {}),
    ...(has(raw, "recorded") ? { recorded: copyJson(raw.recorded, true) as McpFakeRecorded } : {}),
    timing,
  });
  return { block, entryIds, warnings };
}

/**
 * Standalone validation of a raw `mcpFakes` value (one object, or an array of
 * blocks) from one `source`. It takes the plain-data snapshot of `raw`
 * (getters are not run, inherited fields not read) and reports every
 * bad-block case (a)-(j) found as a `FixtureLoadError` naming the source and
 * block; entry-id collisions inside a block are (f). Never throws. Ids use the
 * first-load form (empty `load`). The store does not use this function:
 * `McpFakeStore.add` runs the same per-block checks (`validateBlock`) with its
 * own load suffix, and adds the entry-id check across blocks (against the
 * mount and the earlier blocks of the same input). `blocks` holds only the
 * clean blocks (deeply frozen), `warnings` only their shadowed-entry warnings.
 */
export function validateMcpFakes(raw: unknown, source: string): McpFakesValidation {
  const errors: FixtureLoadError[] = [];
  const warnings: McpFakeIssue[] = [];
  const blocks: ValidatedBlock[] = [];
  const input = snapshotInput(raw);
  let items: Array<{ raw: unknown; blockIndex: number | null }>;
  if (Array.isArray(input) && input.length === 0) {
    // Bad block (i): an empty array declares nothing, so it fails loud.
    errors.push(badBlock({ source, blockId: null }, "i", msg`mcpFakes is an empty array`));
    return { blocks, errors, warnings };
  } else if (Array.isArray(input)) {
    items = input.map((item: unknown, i: number) => ({ raw: item, blockIndex: i }));
  } else if (isPlainObject(input)) {
    items = [{ raw: input, blockIndex: null }];
  } else {
    errors.push(
      badBlock(
        { source, blockId: null },
        "i",
        msg`mcpFakes must be an object or an array, got ${shown(input)}`,
      ),
    );
    return { blocks, errors, warnings };
  }
  // Entry ids of different blocks of one source cannot collide: each id
  // starts with its own `<source>[<i>]`. Collisions across sources, or with
  // blocks already loaded, are checked by `McpFakeStore.add`.
  for (const item of items) {
    const outcome = validateBlock(item.raw, source, item.blockIndex, "", errors);
    if (outcome.block) {
      blocks.push(outcome.block);
      warnings.push(...outcome.warnings);
    }
  }
  return { blocks, errors, warnings };
}

function blockEntryIds(block: ValidatedBlock): string[] {
  return block.tools.flatMap((t) => t.calls.map((c) => c.id));
}

// ---------------------------------------------------------------------------
// `tools/call` result shapes

/**
 * Turn a call entry's `result` or `error` into a `tools/call` result. The
 * returned object is a fresh copy the caller may change. A full
 * `CallToolResult` (validation guarantees any object with one of its keys
 * has a `content` array) is copied unchanged, with no `isError` added;
 * every other shape sets `isError`. Throws when the entry has
 * neither (validation makes that a bad block (d)).
 */
export function toCallToolResult(
  call: McpFakeDeepReadonly<McpFakeCallAnswer>,
): McpFakeCallToolResult {
  if (call.error !== undefined) {
    return { content: [{ type: "text", text: call.error }], isError: true };
  }
  const result: unknown = call.result;
  if (result === undefined || result === null) {
    throw new Error(build(msg`toCallToolResult: call entry has neither result nor error`));
  }
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }], isError: false };
  }
  if (Array.isArray(result)) {
    return { content: copyJson(result) as unknown[], isError: false };
  }
  const obj = copyJson(result) as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    return { ...obj, content: obj.content as unknown[] };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// Argument equality

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = ownKeys(a);
    const bk = ownKeys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => hasOwnKey(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Argument equality: key order ignored, array order matters, no coercion,
 * numbers equal as parsed JSON, absent `arguments` is `{}`, non-object
 * `arguments` never equals an `args` entry (only an `anyArgs` entry matches
 * it).
 */
export function mcpArgsEqual(expected: Record<string, unknown>, received: unknown): boolean {
  const actual = received === undefined ? {} : received;
  if (!isPlainObject(actual)) return false;
  return jsonEqual(expected, actual);
}

/**
 * `path` and one more key: `.key` for a short identifier, else `[<key>]` with
 * the key JSON-quoted whole. The path is cut once, where a message shows it
 * (`pathPart`).
 */
function pathKey(path: string, key: string): string {
  return key.length <= MCP_FAKES_ECHO_LIMIT && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${quoteJson(key)}]`;
}

/**
 * A JSON path (built by `pathKey`) as a message part: user data, cut as JSON
 * text, so the cut never splits an escape of a quoted key.
 */
function pathPart(path: string): MessageValue {
  return jsonText(path);
}

function diffAt(path: string, expected: unknown, received: unknown): Message | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(received)) {
      return msg`${pathPart(path)}: expected an array, received ${shown(received)}`;
    }
    if (expected.length !== received.length) {
      return msg`${pathPart(path)}: expected an array of length ${expected.length}, received length ${received.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const d = diffAt(`${path}[${i}]`, expected[i], received[i]);
      if (d) return d;
    }
    return null;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(received)) {
      return msg`${pathPart(path)}: expected an object, received ${shown(received)}`;
    }
    for (const key of ownKeys(expected)) {
      const p = pathKey(path, key);
      if (!hasOwnKey(received, key)) {
        return msg`${pathPart(p)}: expected ${shown(expected[key])}, received nothing (key missing)`;
      }
      const d = diffAt(p, expected[key], received[key]);
      if (d) return d;
    }
    for (const key of ownKeys(received)) {
      if (!hasOwnKey(expected, key)) {
        return msg`${pathPart(pathKey(path, key))}: unexpected key, received ${shown(received[key])}`;
      }
    }
    return null;
  }
  if (expected === received) return null;
  return msg`${pathPart(path)}: expected ${shown(expected)}, received ${shown(received)}`;
}

/**
 * A JSON path to the first unequal value, with both values (the mismatch
 * detail). Returns `""` when `mcpArgsEqual(expected, received)` holds. The
 * path and each value are cut at `MCP_FAKES_ECHO_LIMIT` chars and the whole
 * text at 1000, each part once.
 */
export function firstDifference(expected: Record<string, unknown>, received: unknown): string {
  const diff = diffAt("$", expected, received === undefined ? {} : received);
  return diff ? build(diff, DIFF_LIMIT) : "";
}

/**
 * Approximate count of differences, used to pick the closest declared entry.
 * A key or array element present on one side only counts as 1, whatever its
 * subtree size.
 */
function diffCount(expected: unknown, received: unknown): number {
  if (Array.isArray(expected) && Array.isArray(received)) {
    const n = Math.max(expected.length, received.length);
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (i >= expected.length || i >= received.length) count += 1;
      else count += diffCount(expected[i], received[i]);
    }
    return count;
  }
  if (isPlainObject(expected) && isPlainObject(received)) {
    let count = 0;
    for (const key of new Set([...ownKeys(expected), ...ownKeys(received)])) {
      const inE = hasOwnKey(expected, key);
      const inR = hasOwnKey(received, key);
      count += inE && inR ? diffCount(expected[key], received[key]) : 1;
    }
    return count;
  }
  return jsonEqual(expected, received) ? 0 : 1;
}

function callMatches(call: ValidatedCall, received: unknown): boolean {
  return call.anyArgs === true || (call.args !== undefined && mcpArgsEqual(call.args, received));
}

// ---------------------------------------------------------------------------
// The store (one per MCP mount)

export interface McpFakeStoreOptions {
  /**
   * FIFO cap on distinct test ids that keep consumption state; `0` is
   * unbounded. Default 500. A value that is not a non-negative safe integer
   * throws a `RangeError`.
   */
  maxTestIds?: number;
}

export interface McpFakeSelection {
  tier: McpFakeTier;
  entries: Array<{ block: ValidatedBlock; entry: ValidatedCall }>;
}

export class McpFakeStore {
  private blocks: ValidatedBlock[] = [];
  /** Entry id → the block id that owns it, for every loaded entry. */
  private ids = new Map<string, string>();
  /** Block id → its `source`, for every loaded block. */
  private blockIds = new Map<string, string>();
  /**
   * Consumption state: supplied test id → consumed entry ids. Map insertion
   * order is the FIFO order of the cap.
   */
  private consumed = new Map<string, Set<string>>();
  /** Consumed entry ids for requests with no test id. Never evicted. */
  private untagged = new Set<string>();
  /**
   * Test ids whose state the cap evicted. A claim from one of them, of a tool
   * an applicable block declares, is `evicted` until the test id is reset; a
   * mark never ages out, because a forgotten mark would silently replay
   * entries the test id already consumed. Memory stays bounded per evicted
   * test id: one id string, against the entry-id set the cap dropped. The set only grows with distinct test ids, and every
   * reset door clears it (`resetState`, `clear`). A cap of `0` evicts
   * nothing, so marks made under an earlier cap stay until reset.
   */
  private evicted = new Set<string>();
  /**
   * The last `<n>` of `code#<n>` / `control-api#<n>` used by a run-time
   * addition (see `nextRuntimeNumber`). Never rewound.
   */
  private runtimeAdds = 0;
  /**
   * The `<k>` of `@<k>`: loads per source string, skipping a `@<k>` that a
   * loaded block id already starts (see `add`). Never rewound.
   */
  private loadCounts = new Map<string, number>();
  private maxTestIds: number;
  /**
   * RP2 fake event logs: supplied test id → its events, oldest first. Map
   * insertion order is the FIFO order of the test-id cap.
   */
  private events = new Map<string, McpFakeReportEvent[]>();
  /** The event log of requests with no test id: a ring of the newest events. */
  private untaggedEvents: McpFakeReportEvent[] = [];
  /** The untagged event log dropped an event (C9). */
  private untaggedOverflow = false;
  /**
   * C9: test ids whose event log overflowed or was evicted, so their report
   * is incomplete (`evicted: true`). Report-only: `claim`, `snapshot` and
   * `policy` never read it, so tool calls are unchanged.
   */
  private reportOverflow = new Set<string>();

  constructor(options: McpFakeStoreOptions = {}) {
    this.maxTestIds = checkCap(options.maxTestIds ?? MCP_FAKES_DEFAULT_MAX_TEST_IDS);
  }

  /**
   * Set the FIFO cap on distinct test ids; an MCP mount can pass the
   * journal's `fixtureCountsMaxTestIdsCap`. A lower cap evicts the oldest test
   * ids at once. `0` is unbounded: nothing is evicted, and test ids already
   * marked evicted stay marked until reset. An invalid cap throws a
   * `RangeError` and leaves the cap unchanged.
   */
  setMaxTestIds(cap: number): void {
    this.maxTestIds = checkCap(cap);
    this.enforceCap();
  }

  /**
   * Take one plain-data snapshot of `sources` and `origin` (getters are not
   * run, inherited fields not read, holes, symbol keys, proxies that throw and
   * non-plain objects are errors), validate the whole snapshot, derive entry
   * ids and their counters, check that every block id and every entry id is
   * unique against the mount and inside the input (bad block (f), naming the
   * block that already owns the id and, for a block id, that block's source),
   * then append. Every block is checked,
   * valid or not (no first-stop; `validateBlock` says which checks stop
   * early). On any error, throws one `McpFakesAddError` carrying every error
   * found, and the warnings of the blocks that passed every check, and adds
   * nothing (no counter is consumed); it never throws anything else for a bad
   * input (a throw from a defect in aimock itself is not caught). An empty
   * input, an invalid `origin` or an invalid source item (not an object, an
   * empty `source`, a `blockIndex` that is not `null` or a non-negative
   * integer) is a bad block (i).
   *
   * With `kind: "file"`, consecutive sources with the same `source` string
   * and increasing `blockIndex` form one load (one `@<k>`). A load whose
   * derived block ids a loaded block already has (a file named `"a@2"`
   * starts the ids of `@2`; a file named `"a[0]"` has the id of block 0 of
   * the first load) takes the next free `@<k>`, so a file name never blocks
   * later loads of another source. A file loaded after the block whose id
   * its name spells is still the bad block (f). With a run-time origin,
   * blocks are numbered per `McpFakeAddOrigin`; a block given with a null
   * `blockIndex` keeps the single-object depth limit.
   */
  add(sources: readonly McpFakeSource[], origin: McpFakeAddOriginInternal): McpFakeAddResult {
    const originData = snapshotInput(origin);
    const kind = isPlainObject(originData) ? originData.kind : undefined;
    if (kind !== "file" && kind !== "code" && kind !== "control-api" && kind !== "record") {
      const detail = isPlainObject(originData)
        ? msg`origin.kind must be "file", "code", "control-api" or "record", got ${shown(kind)}`
        : msg`origin must be an object { kind }, got ${shown(originData)}`;
      throw new McpFakesAddError([badBlock({ source: null, blockId: null }, "i", detail)], []);
    }
    const runtimeNumber = kind === "file" ? null : this.nextRuntimeNumber(kind);
    const runtimeSource = runtimeNumber === null ? null : `${kind}#${runtimeNumber}`;
    // The blocks sit two levels down (the array, then `{ source, blockIndex, raw }`),
    // so the snapshot counts the depth limit from each `raw`. A block of an
    // array-form `mcpFakes` (a non-null block index) is level 2, as in
    // `validateMcpFakes`; `capDepth` takes the one level more off it below.
    const input = snapshotInput(sources, MCP_FAKES_MAX_DEPTH + 2);
    if (!Array.isArray(input) || input.length === 0) {
      const detail = Array.isArray(input)
        ? msg`mcpFakes holds no blocks`
        : msg`the blocks to add must be an array, got ${shown(input)}`;
      throw new McpFakesAddError(
        [badBlock({ source: runtimeSource, blockId: null }, "i", detail)],
        [],
      );
    }

    const errors: FixtureLoadError[] = [];
    const warnings: McpFakeIssue[] = [];
    const accepted: ValidatedBlock[] = [];
    /** Entry id → owning block id, for this input. */
    const newIds = new Map<string, string>();
    /** Block id → source, for this input. */
    const newBlockIds = new Map<string, string>();
    const pendingLoads = new Map<string, number>();
    const items: Array<{
      position: number;
      source: string;
      blockIndex: number | null;
      raw: unknown;
    }> = [];
    input.forEach((item: unknown, position: number) => {
      const fail = (detail: Message, file: string | null = runtimeSource): void => {
        errors.push(
          badBlock({ source: file, blockId: null }, "i", msg`blocks[${position}] ${detail}`),
        );
      };
      if (!isPlainObject(item)) {
        fail(msg`must be an object { source, blockIndex, raw }, got ${shown(item)}`);
        return;
      }
      const { source, blockIndex } = item;
      // A run-time origin replaces `source`, so only a file source is checked.
      if (runtimeSource === null && !isNonEmptyString(source)) {
        fail(msg`source must be a non-empty string, got ${shown(source)}`);
        return;
      }
      const sourceText = typeof source === "string" ? source : "";
      const index =
        blockIndex === null ||
        (typeof blockIndex === "number" && Number.isSafeInteger(blockIndex) && blockIndex >= 0)
          ? blockIndex
          : undefined;
      if (index === undefined) {
        fail(
          msg`blockIndex must be null or a non-negative integer, got ${shown(blockIndex)}`,
          runtimeSource ?? sourceText,
        );
        return;
      }
      items.push({ position, source: sourceText, blockIndex: index, raw: item.raw });
    });
    const singleObject = input.length === 1 && items.length === 1 && items[0].blockIndex === null;

    /** Two consecutive file items with one source and a rising block index are one load. */
    const sameLoad = (
      prev: (typeof items)[number] | undefined,
      item: (typeof items)[number],
    ): boolean =>
      prev !== undefined &&
      prev.source === item.source &&
      prev.blockIndex !== null &&
      item.blockIndex !== null &&
      item.blockIndex > prev.blockIndex;
    let load = "";
    for (const [at, item] of items.entries()) {
      const source = runtimeSource ?? item.source;
      let blockIndex = item.blockIndex;
      if (runtimeSource === null) {
        if (!sameLoad(items[at - 1], item)) {
          // The block indices of this load, to check its derived block ids below.
          const indices: number[] = [];
          for (
            let j = at;
            j < items.length && (j === at || sameLoad(items[j - 1], items[j]));
            j++
          ) {
            const index = items[j].blockIndex;
            if (index !== null) indices.push(index);
          }
          let k = (pendingLoads.get(source) ?? this.loadCounts.get(source) ?? 0) + 1;
          // A file source can spell a block id this load derives: `"a@2"` (a
          // load suffix) or `"a[0]"` (a block index). Skip a taken `@<k>` as
          // `nextRuntimeNumber` skips a taken `<n>`: otherwise every later load
          // of `source` would collide, and fail, on the same block id.
          while (
            k > 1
              ? this.blockIdPrefixTaken(blockIdOf(source, `@${k}`, null), newBlockIds)
              : indices.some((index) => {
                  const derived = blockIdOf(source, "", index);
                  // Taken by a file whose name is that id (its first,
                  // single-object load), not by a block that derives it.
                  return (this.blockIds.get(derived) ?? newBlockIds.get(derived)) === derived;
                })
          )
            k += 1;
          pendingLoads.set(source, k);
          load = k === 1 ? "" : `@${k}`;
        }
      } else {
        blockIndex = singleObject ? null : item.position;
      }
      // The depth limit follows the form the block was given in: a block given
      // with a null block index is a single-object block (level 1), even when a
      // run-time add numbers it.
      const raw = item.blockIndex === null ? item.raw : capDepth(item.raw, MCP_FAKES_MAX_DEPTH - 1);
      const outcome = validateBlock(raw, source, blockIndex, load, errors);
      // Id uniqueness on the mount, for invalid blocks too: their ids are what the
      // user meant to declare, so a collision with them is reported now. A
      // `source` can spell another load's suffix (`"a@2"`), so block ids are
      // checked as well as entry ids. A block whose id is taken reports that
      // one collision, not one per entry: every entry id starts with it.
      const blockId = blockIdOf(source, load, blockIndex);
      const blockOwner = this.blockIds.get(blockId) ?? newBlockIds.get(blockId);
      let collided = blockOwner !== undefined;
      if (blockOwner !== undefined) {
        errors.push(
          badBlock(
            { source, blockId },
            "f",
            blockCollisionDetail(source, blockOwner, this.blockIds.has(blockId)),
          ),
        );
      } else {
        newBlockIds.set(blockId, source);
      }
      for (const id of outcome.entryIds) {
        const loaded = this.ids.get(id);
        const earlier = newIds.get(id);
        if (!newIds.has(id)) newIds.set(id, blockId);
        if (blockOwner !== undefined) continue;
        const where =
          loaded !== undefined
            ? msg`is already loaded on this mount, in block ${quote(loaded)}`
            : earlier !== undefined
              ? msg`collides with an entry of block ${quote(earlier)} earlier in the same input`
              : null;
        if (where === null) continue;
        errors.push(badBlock({ source, blockId }, "f", msg`entry id ${quote(id)} ${where}`, id));
        collided = true;
      }
      if (outcome.block && !collided) {
        accepted.push(outcome.block);
        warnings.push(...outcome.warnings);
      }
    }
    if (errors.length > 0) throw new McpFakesAddError(errors, warnings);

    for (const [source, k] of pendingLoads) this.loadCounts.set(source, k);
    if (runtimeNumber !== null) this.runtimeAdds = runtimeNumber;
    for (const [id, owner] of newIds) this.ids.set(id, owner);
    for (const [blockId, source] of newBlockIds) this.blockIds.set(blockId, source);
    this.blocks.push(...accepted);
    return { warnings };
  }

  /**
   * The `<n>` for the next run-time add of `kind`: one more than the last one
   * used, skipping any number whose `<kind>#<n>` already starts a loaded block
   * id (and so every entry id of that block). A file source may be spelled
   * `code#1`; without the skip, every later run-time add would collide with it
   * and fail, and a failed add does not advance `<n>`. Blocks loaded after a
   * run-time add still collide with it as usual (the later block fails).
   */
  private nextRuntimeNumber(kind: "code" | "control-api" | "record"): number {
    let n = this.runtimeAdds + 1;
    while (this.blockIdPrefixTaken(`${kind}#${n}`)) n += 1;
    return n;
  }

  /**
   * A loaded block id (or one in `pending`, the blocks earlier in the same
   * input) starts with `prefix` and does not go on with a digit, so `prefix`
   * would start a colliding block or entry id (`a@2` is taken by `a@2` and
   * `a@2[0]`, not by `a@23`).
   */
  private blockIdPrefixTaken(prefix: string, pending?: ReadonlyMap<string, string>): boolean {
    for (const ids of [this.blockIds, pending ?? new Map<string, string>()]) {
      for (const blockId of ids.keys()) {
        if (blockId.startsWith(prefix) && !/^[0-9]/.test(blockId.slice(prefix.length))) {
          return true;
        }
      }
    }
    return false;
  }

  /** Unload every fake and its state. The id counters (`<n>`, `<k>`) are kept. */
  clear(): void {
    this.blocks = [];
    this.ids.clear();
    this.blockIds.clear();
    this.resetState();
  }

  /**
   * Reset consumption state for one test id, or all. Also clears an
   * `evicted` mark. `MCP_FAKES_DEFAULT_TEST_ID` resets the untagged state as
   * well as an explicit test id of that name. That matches
   * `Journal.clearMatchCounts` (which `LLMock.resetMatchCounts` calls), where
   * untagged requests and an explicit `__default__` share one key.
   */
  resetState(testId?: string): void {
    if (testId === undefined) {
      this.consumed.clear();
      this.untagged.clear();
      this.evicted.clear();
      this.events.clear();
      this.reportOverflow.clear();
      this.untaggedEvents = [];
      this.untaggedOverflow = false;
      return;
    }
    this.consumed.delete(testId);
    this.evicted.delete(testId);
    this.events.delete(testId);
    this.reportOverflow.delete(testId);
    if (testId === MCP_FAKES_DEFAULT_TEST_ID) {
      this.untagged.clear();
      this.untaggedEvents = [];
      this.untaggedOverflow = false;
    }
  }

  /**
   * MR12: mark entries consumed for `testId` (null = untagged), as a claim
   * would. Ids not loaded on this mount are ignored, and so is a test id the
   * cap evicted (its claims fail as `evicted` until it is reset).
   */
  markConsumed(testId: string | null, entryIds: readonly string[]): void {
    if (testId !== null && this.evicted.has(testId)) return;
    const known = entryIds.filter((entryId) => this.ids.has(entryId));
    if (known.length === 0) return;
    const state = this.stateFor(testId);
    for (const entryId of known) state.add(entryId);
  }

  /**
   * AM7/FA1: the `list` of the most specific applicable tier that has one,
   * else null. Inside a tier, the first block in load order with a `list`.
   */
  recordedList(identity: McpFakeIdentity): readonly Record<string, unknown>[] | null {
    const blocks = this.applicable(identity);
    for (const tier of TIER_ORDER) {
      const block = blocks.find((b) => b.tier === tier && b.list !== undefined);
      if (block?.list) return block.list;
    }
    return null;
  }

  /** FA5 timing and the FA3/FA4 values of an answered entry (for MR15 framing). */
  replayOf(entryId: string): {
    timing: "recorded" | "immediate";
    notifications: readonly McpFakeNotification[];
    durationMs: number | undefined;
  } | null {
    for (const block of this.blocks) {
      for (const tool of block.tools) {
        const entry = tool.calls.find((c) => c.id === entryId);
        if (entry) {
          return {
            timing: block.timing,
            notifications: entry.notifications ?? NO_NOTIFICATIONS,
            durationMs: entry.durationMs,
          };
        }
      }
    }
    return null;
  }

  /** C7: true when any loaded call entry has a `notifications/message` (gates logging). */
  hasRecordedLogs(): boolean {
    return this.blocks.some((block) =>
      block.tools.some((tool) =>
        tool.calls.some((call) =>
          call.notifications?.some((n) => n.method === "notifications/message"),
        ),
      ),
    );
  }

  /**
   * RP2: append one event to the identity's log, with the next process-wide
   * `seq` and its `args` bounded (`MCP_FAKES_MAX_EVENT_ARGS_BYTES`). A log
   * past `MCP_FAKES_MAX_EVENTS_PER_LOG` drops its oldest event and its report
   * says `evicted: true`; a new test id past the test-id cap evicts the
   * oldest test id's log the same way (C9). Never touches consumption state.
   */
  logEvent(identity: McpFakeIdentity, event: McpFakeReportEventInput): void {
    lastEventSeq += 1;
    const stored = Object.freeze({
      ...event,
      args: boundedArgs(event.args),
      seq: lastEventSeq,
    }) satisfies McpFakeReportEvent;
    const testId = identity.testId;
    if (testId === null) {
      this.untaggedEvents.push(stored);
      if (this.untaggedEvents.length > MCP_FAKES_MAX_EVENTS_PER_LOG) {
        this.untaggedEvents.shift();
        this.untaggedOverflow = true;
      }
      return;
    }
    let log = this.events.get(testId);
    if (!log) {
      log = [];
      this.events.set(testId, log);
      this.enforceEventCap();
    }
    log.push(stored);
    if (log.length > MCP_FAKES_MAX_EVENTS_PER_LOG) {
      log.shift();
      this.reportOverflow.add(testId);
    }
  }

  /**
   * RP3 parts for this mount (report assembly is src/mcp-fakes-report.ts).
   * `served`, `failures` and `unfaked` come from the events whose context is
   * exactly `context`, in `seq` order; `unconsumed` (tiers `testId+context`
   * and `testId`) and `sharedUnconsumed` (tiers `context` and `shared`) are
   * the applicable entries of this store that `testId` has not consumed,
   * labelled with `mount`, the path the store's mock is served at. Every
   * block in the store answers there (`claim` does not read `block.mount`),
   * so none is left out by its own `mount` value: a mock that loaded its own
   * fakes (default mount "/mcp") and is mounted at another path still reports
   * them. Reads only: building a report changes no state.
   */
  reportPart(testId: string | null, context: string | null, mount: string): McpFakeReportPart {
    const part: McpFakeReportPart = {
      evicted:
        testId === null
          ? this.untaggedOverflow
          : this.evicted.has(testId) || this.reportOverflow.has(testId),
      served: [],
      unconsumed: [],
      unfaked: [],
      failures: [],
      sharedUnconsumed: [],
    };
    const log = testId === null ? this.untaggedEvents : (this.events.get(testId) ?? []);
    for (const event of log) {
      if (event.context !== context) continue;
      const { seq, tool, args } = event;
      if (event.outcome === "answered") {
        part.served.push({ entryId: event.entryId, mount: event.mount, tool, args, seq });
      } else if (event.outcome === "unfaked") {
        part.unfaked.push({ mount: event.mount, tool, args, answeredBy: event.answeredBy });
      } else {
        part.failures.push({ code: event.code, mount: event.mount, tool, args, seq });
      }
    }
    const used = this.stateOf(testId);
    for (const block of this.applicable({ testId, context, undeclared: null })) {
      const own = block.tier === "testId+context" || block.tier === "testId";
      for (const tool of block.tools) {
        for (const call of tool.calls) {
          if (used?.has(call.id)) continue;
          if (!own) {
            part.sharedUnconsumed.push({ entryId: call.id, mount, tool: tool.name });
          } else if (call.args) {
            part.unconsumed.push({
              entryId: call.id,
              mount,
              tool: tool.name,
              args: copyJson(call.args),
            });
          } else {
            part.unconsumed.push({ entryId: call.id, mount, tool: tool.name, anyArgs: true });
          }
        }
      }
    }
    return part;
  }

  /** Every entry id on this mount, in load order. */
  allEntryIds(): string[] {
    return this.blocks.flatMap(blockEntryIds);
  }

  /** The blocks whose scope matches `identity`, in load order. A frozen list of frozen blocks. */
  applicable(identity: McpFakeIdentity): readonly ValidatedBlock[] {
    return Object.freeze(this.blocks.filter((b) => scopeMatches(b.scope, identity)));
  }

  /** The candidate entries for `tool` from the most specific tier declaring it. */
  selectTier(tool: string, identity: McpFakeIdentity): McpFakeSelection | null {
    const blocks = this.applicable(identity);
    for (const tier of TIER_ORDER) {
      const entries: McpFakeSelection["entries"] = [];
      for (const block of blocks) {
        if (block.tier !== tier) continue;
        const t = block.tools.find((x) => x.name === tool);
        if (t) for (const entry of t.calls) entries.push({ block, entry });
      }
      if (entries.length > 0) return { tier, entries };
    }
    return null;
  }

  /**
   * Find the first unconsumed matching entry of the selected tier (load order,
   * then `calls` order) and mark it consumed, synchronously (no `await`
   * between find and mark), so concurrent calls never share an entry. The
   * result is built and checked to serialize as JSON before the entry is
   * marked, so a result that cannot be sent throws and leaves the entry
   * unconsumed. An `anyArgs` entry answers any `arguments`, a non-object
   * value included; only an `args` entry needs an object.
   */
  claim(tool: string, args: unknown, identity: McpFakeIdentity): McpFakeClaim {
    const selection = this.selectTier(tool, identity);
    if (!selection) return Object.freeze({ kind: "none" });
    const testId = identity.testId;
    if (testId !== null && this.evicted.has(testId)) {
      return Object.freeze({ kind: "evicted", tool, testId, maxTestIds: this.maxTestIds });
    }
    const used = this.stateOf(testId);
    const received = args === undefined ? {} : args;

    for (const { block, entry } of selection.entries) {
      if (used?.has(entry.id)) continue;
      if (!callMatches(entry, received)) continue;
      let result: McpFakeCallToolResult;
      try {
        result = toCallToolResult(entry);
      } catch (err) {
        throw new Error(
          build(
            msg`MCP fake entry ${quote(entry.id)}: its tools/call result cannot be built: ${describeThrown(err)}`,
          ),
          { cause: err },
        );
      }
      try {
        JSON.stringify(result);
      } catch (err) {
        throw new Error(
          build(
            msg`MCP fake entry ${quote(entry.id)}: result cannot be serialized as JSON: ${describeThrown(err)}`,
          ),
          { cause: err },
        );
      }
      this.stateFor(testId).add(entry.id);
      return Object.freeze({ kind: "answer", tool, entry, block, tier: selection.tier, result });
    }

    const matching = selection.entries.filter(({ entry }) => callMatches(entry, received));
    if (matching.length > 0) {
      return Object.freeze({
        kind: "exhausted",
        tool,
        received,
        matchingDeclared: matching.length,
        matchingConsumed: matching.filter(({ entry }) => used?.has(entry.id)).length,
        matchingIds: Object.freeze(matching.map(({ entry }) => entry.id)),
      });
    }

    // Closest = lowest `diffCount`; a tie goes to the first candidate in
    // load/declaration order (the order claims use), hence the strict `<`.
    let closest: ValidatedCall | null = null;
    let best = Infinity;
    for (const { entry } of selection.entries) {
      if (!entry.args) continue;
      const score = diffCount(entry.args, received);
      if (score < best) {
        best = score;
        closest = entry;
      }
    }
    return Object.freeze({
      kind: "mismatch",
      tool,
      received,
      declared: deepFreeze(selection.entries.map(({ entry }) => declaredEntry(entry, used))),
      firstDifference: closest?.args ? firstDifference(closest.args, received) : "",
    });
  }

  /**
   * The undeclared-tool policy, first of: `override` (`null` or omitted falls
   * back to `identity.undeclared`, the request's or session's
   * `X-AIMock-MCP-Undeclared` / `?undeclared=` value) → `deny` when any
   * applicable scoped block says `deny` → `allow`.
   */
  policy(
    identity: McpFakeIdentity,
    override: McpFakeUndeclaredPolicy | null = null,
  ): McpFakeUndeclaredPolicy {
    const effective = override ?? identity.undeclared;
    if (effective) return effective;
    for (const block of this.applicable(identity)) {
      if (block.scope !== "shared" && block.undeclaredTools === "deny") return "deny";
    }
    return "allow";
  }

  /** Tool names any applicable block (any tier) declares, in load order. */
  declaredTools(identity: McpFakeIdentity): string[] {
    const names = new Set<string>();
    for (const block of this.applicable(identity)) for (const t of block.tools) names.add(t.name);
    return [...names];
  }

  /**
   * Fake tools for `tools/list`, metadata from the most specific
   * tier declaring each tool; inside that tier, the first block in load order
   * that declares it. A tool with no `inputSchema` lists `{ type: "object" }`.
   * Merging with registered tools is the mount's job.
   */
  listTools(identity: McpFakeIdentity): McpFakeToolListing[] {
    return this.declaredTools(identity).map((name) => {
      const selection = this.selectTier(name, identity);
      const tool = selection?.entries[0].block.tools.find((t) => t.name === name);
      const listing: McpFakeToolListing = {
        name,
        inputSchema: tool?.inputSchema
          ? (copyJson(tool.inputSchema) as Record<string, unknown>)
          : { type: "object" },
      };
      if (tool?.description !== undefined) listing.description = tool.description;
      return listing;
    });
  }

  /**
   * For `GET /__aimock/mcp/fakes`: applicable blocks with consumed state for
   * `testId`. For a test id the cap evicted, every block says `evicted: true`.
   * Deeply frozen.
   */
  snapshot(testId: string | null, context: string | null): readonly McpFakeBlockSnapshot[] {
    const used = this.stateOf(testId);
    const evicted = testId !== null && this.evicted.has(testId);
    const blocks = this.applicable({ testId, context, undeclared: null }).map((block) => ({
      blockId: block.blockId,
      source: block.source,
      mount: block.mount,
      scope: block.scope,
      undeclaredTools: block.undeclaredTools ?? "allow",
      evicted,
      tools: block.tools.map((t) => ({
        name: t.name,
        entries: t.calls.map((c) => declaredEntry(c, used)),
      })),
    }));
    return deepFreeze(blocks);
  }

  /** The consumed ids for `testId` (`null`: untagged), without creating state. */
  private stateOf(testId: string | null): ReadonlySet<string> | undefined {
    return testId === null ? this.untagged : this.consumed.get(testId);
  }

  private stateFor(testId: string | null): Set<string> {
    if (testId === null) return this.untagged;
    let set = this.consumed.get(testId);
    if (!set) {
      set = new Set();
      this.consumed.set(testId, set);
      this.enforceCap();
    }
    return set;
  }

  /**
   * FIFO cap: evict the oldest test ids until the cap holds, marking each
   * evicted. A cap of `0` evicts nothing. The marks are not capped (see
   * `evicted`).
   */
  private enforceCap(): void {
    if (this.maxTestIds === 0) return;
    for (const oldest of this.consumed.keys()) {
      if (this.consumed.size <= this.maxTestIds) break;
      this.consumed.delete(oldest);
      this.evicted.add(oldest);
      // Its events no longer match its consumption state (C9).
      if (this.events.delete(oldest)) this.reportOverflow.add(oldest);
    }
    this.enforceEventCap();
  }

  /**
   * The test-id FIFO cap on event logs: evict the oldest logs until the cap
   * holds, marking each in the report-only `reportOverflow` (never `evicted`).
   */
  private enforceEventCap(): void {
    if (this.maxTestIds === 0) return;
    for (const oldest of this.events.keys()) {
      if (this.events.size <= this.maxTestIds) break;
      this.events.delete(oldest);
      this.reportOverflow.add(oldest);
    }
  }
}

/** `replayOf` notifications of an entry that recorded none. */
const NO_NOTIFICATIONS: readonly McpFakeNotification[] = Object.freeze([]);

/**
 * The detail of a block-id collision (bad block (f)). The message prefix
 * already names the block id, so the detail names the two sources.
 */
function blockCollisionDetail(source: string, owner: string, loaded: boolean): Message {
  return loaded
    ? msg`block id (this block's source: ${quote(source)}) is already loaded on this mount by source ${quote(owner)}`
    : msg`block id (this block's source: ${quote(source)}) collides with a block earlier in the same input, from source ${quote(owner)}`;
}

/** The test-id cap: a non-negative safe integer, `0` meaning unbounded. Anything else throws. */
function checkCap(cap: number): number {
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new RangeError(
      build(
        msg`MCP fakes maxTestIds must be a non-negative integer (0 = unbounded), got ${shown(cap)}`,
      ),
    );
  }
  return cap;
}

function declaredEntry(
  entry: ValidatedCall,
  used: ReadonlySet<string> | undefined,
): McpFakeDeclaredEntry {
  const consumed = used?.has(entry.id) ?? false;
  return entry.args
    ? { id: entry.id, args: copyJson(entry.args) as Record<string, unknown>, consumed }
    : { id: entry.id, anyArgs: true, consumed };
}
