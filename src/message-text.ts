/**
 * The one message builder of MCP fakes: every error and warning message of
 * mcp-fakes.ts, the `FixtureLoadError` message (fixture-loader.ts) and the MCP
 * identity error messages (helpers.ts) are built here. A message is a list of
 * parts: fixed text written by aimock, kept whole, and user parts (a tool
 * name, an id, a source, a JSON path, a value, a thrown message), each quoted
 * or rendered as JSON when it is made. `build` gives the user parts their
 * shares of the message's length budget and cuts each one once, with
 * `cutText` (echo-text.ts), so the fixed text is never cut and every
 * `… (<n> more chars)` count is the true count of chars left out of that
 * part. A leaf module (it imports only constants.ts and echo-text.ts).
 */
import { MCP_FAKES_ECHO_LIMIT } from "./constants.js";
import { cutText, type CutUnits } from "./echo-text.js";

/**
 * User data in a message: its whole text, not cut until the message is built.
 * `units` is what a cut of it must not split; `max` is the most chars it may
 * take, whatever the budget: at least 1 (`Infinity` too), so a cut part
 * always keeps at least a `…`. A `max` below 1, or `NaN`, is a `RangeError`.
 *
 * @internal
 */
export class UserText {
  constructor(
    readonly text: string,
    readonly units: CutUnits,
    readonly max: number,
  ) {
    if (!(max >= 1)) throw new RangeError(`a user part max must be at least 1, got ${max}`);
    Object.freeze(this);
  }
}

/**
 * A message that is not built yet: fixed text and user parts, in order.
 *
 * @internal
 */
export class Message {
  readonly parts: readonly (string | UserText)[];

  constructor(parts: readonly (string | UserText)[]) {
    this.parts = Object.freeze([...parts]);
    Object.freeze(this);
  }
}

/** What a `msg` template may interpolate: a user part, a message, or a number. */
export type MessageValue = UserText | Message | number;

/**
 * A message from a template: its literal text is fixed text, a number is
 * fixed text, a `Message` is spliced in part by part, and a `UserText` is a
 * user part.
 *
 * @internal
 */
export function msg(strings: TemplateStringsArray, ...values: readonly MessageValue[]): Message {
  const parts: (string | UserText)[] = [];
  strings.forEach((literal, i) => {
    if (literal !== "") parts.push(literal);
    if (i >= values.length) return;
    const value = values[i];
    if (typeof value === "number") parts.push(String(value));
    else if (value instanceof Message) parts.push(...value.parts);
    else parts.push(value);
  });
  return new Message(parts);
}

/**
 * Aimock's own text as a message: a constant, a fixed list, a built-in tag,
 * or a message that was already built. Never user data.
 *
 * @internal
 */
export function fixed(text: string): Message {
  return new Message([text]);
}

/**
 * Every control char (C0, DEL, C1) and the line and paragraph separators.
 * `JSON.stringify` escapes C0 controls but keeps DEL, C1 controls and the
 * separators raw; text that is not JSON (a text `FixtureLoadError` detail) can
 * hold any of them.
 */
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const RAW_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * `text` JSON-quoted: quotes, backslashes and control chars escaped, DEL, C1
 * controls and U+2028 / U+2029 too (as `\uXXXX`), so the result is one line
 * of printable text that `JSON.parse` reads back as `text`.
 *
 * @internal
 */
export function quoteJson(text: string): string {
  return escapeRawControls(JSON.stringify(text));
}

function escapeRawControls(json: string): string {
  return json.replace(RAW_CONTROLS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * A user string as a message part: JSON-quoted by `quoteJson`, cut as JSON
 * text (never inside an escape) to its share, and never to more than `max`
 * chars.
 *
 * @internal
 */
export function quote(text: string, max: number = MCP_FAKES_ECHO_LIMIT): UserText {
  return jsonText(JSON.stringify(text), max);
}

/**
 * User data already rendered as JSON text (a value, or a JSON path whose keys
 * are JSON-quoted), as a message part: every raw control char (C0, DEL, C1)
 * and line separator in it escaped as `\uXXXX` (in JSON text they can only be
 * inside its strings), cut as JSON text.
 *
 * @internal
 */
export function jsonText(json: string, max: number = MCP_FAKES_ECHO_LIMIT): UserText {
  return new UserText(escapeRawControls(json), "json", max);
}

/**
 * Text that is not JSON as a message part, cut as text (never inside a
 * surrogate pair).
 *
 * @internal
 */
export function plainText(text: string, max: number = MCP_FAKES_ECHO_LIMIT): UserText {
  return new UserText(text, "text", max);
}

/**
 * `message` built in a budget of its own (`limit` chars), as fixed text of
 * the message it goes into: a part of a message with its own cap.
 *
 * @internal
 */
export function within(limit: number, message: Message): Message {
  return fixed(build(message, limit));
}

/**
 * The text of `message`, no longer than `limit` when its fixed text and one
 * char per user part fit in `limit`. The fixed text is kept whole. The user
 * parts share what is left: a part that fits in an equal share keeps all of
 * it, and the others split the rest (water-filling), each at most its `max`.
 * Each user part is then cut once, by `cutText`, to its share. A `limit` of
 * `Infinity` cuts each part only to its `max`. A `NaN` limit is a
 * `RangeError`; a limit too small for the fixed text still gives each
 * non-empty user part 1 char, a bare `…`.
 *
 * @internal
 */
export function build(message: Message, limit = Infinity): string {
  if (Number.isNaN(limit)) throw new RangeError("build limit must be a number, got NaN");
  const users = message.parts.filter((part): part is UserText => part instanceof UserText);
  let fixedLength = 0;
  for (const part of message.parts) if (typeof part === "string") fixedLength += part.length;
  const shares = allocate(users, limit - fixedLength);
  let i = 0;
  return message.parts
    .map((part) => (typeof part === "string" ? part : cutText(part.text, shares[i++], part.units)))
    .join("");
}

/**
 * Each user part's share of `room` chars, by water-filling: at least 1 char
 * each (a bare `…` when room runs out), but never more than the part's cap.
 */
function allocate(users: readonly UserText[], room: number): number[] {
  // `max` is at least 1 (UserText checks it), so a non-empty part's cap is too.
  const caps = users.map((u) => Math.min(u.text.length, Math.floor(u.max)));
  const order = caps.map((_, i) => i).sort((a, b) => caps[a] - caps[b]);
  const shares: number[] = new Array<number>(users.length).fill(0);
  let left = Math.max(0, room);
  order.forEach((index, k) => {
    const fair = Math.floor(left / (order.length - k));
    const share = Math.min(caps[index], Math.max(1, fair));
    shares[index] = share;
    left -= share;
  });
  return shares;
}

/**
 * The text of `message` with no cut at all: for a message that goes, as
 * text, into a user part of another message (a placeholder reason inside a
 * rendered value), which is then cut once there.
 *
 * @internal
 */
export function fullText(message: Message): string {
  return message.parts.map((part) => (typeof part === "string" ? part : part.text)).join("");
}
