/**
 * The one cut rule for text that MCP fakes put into a message. The message
 * builder (`build` in message-text.ts) cuts every user part of a message with
 * it, once; helpers.ts also cuts the `MCP_INVALID_UNDECLARED` `raw` field
 * with it. A leaf module (it imports only constants.ts), so every one of
 * those can use it without an import cycle.
 */
import { MCP_FAKES_ECHO_LIMIT } from "./constants.js";

/**
 * What a cut must not split. `"text"`: a surrogate pair. `"json"`: a
 * surrogate pair or a JSON escape (`\x` or `\uXXXX`); for JSON text, where a
 * backslash only ever starts an escape.
 */
export type CutUnits = "text" | "json";

/**
 * `text` cut to at most `limit` chars in all: the kept part, then `…` and the
 * count of chars left out. When even that count does not fit in `limit`, the
 * kept part is followed by a bare `…`. A `limit` below 1 has no room even for
 * that `…`, so a text longer than it is cut to `""`; the message builder
 * never asks for that (each of its user parts gets at least 1 char). The
 * kept part is a prefix of `text` that never ends inside a unit of `units`. A
 * `limit` that is not an integer is rounded down, a negative one
 * (`-Infinity` too) is 0, and a `NaN` limit is a `RangeError`.
 *
 * @internal
 */
export function cutText(
  text: string,
  limit: number = MCP_FAKES_ECHO_LIMIT,
  units: CutUnits = "text",
): string {
  if (Number.isNaN(limit)) throw new RangeError("cutText limit must be a number, got NaN");
  // A negative limit (`-Infinity` included) keeps nothing, as a limit of 0 does.
  limit = Math.max(0, Math.floor(limit));
  if (text.length <= limit) return text;
  let keep = limit;
  let suffix = "";
  for (;;) {
    suffix = `… (${text.length - keep} more chars)`;
    const room = Math.max(0, limit - suffix.length);
    if (keep <= room) break;
    keep = room;
  }
  if (keep + suffix.length > limit) {
    // Not even the count fits: keep what fits before a bare `…`.
    return limit < 1 ? "" : text.slice(0, safeEnd(text, limit - 1, units)) + "…";
  }
  // Moving the cut back by d chars grows the count by d, which adds at most
  // one digit to the suffix, so the total stays within `limit`.
  keep = safeEnd(text, keep, units);
  return text.slice(0, keep) + `… (${text.length - keep} more chars)`;
}

/** `keep`, moved back to a point that does not split a unit of `units`. */
function safeEnd(text: string, keep: number, units: CutUnits): number {
  return surrogateSafeEnd(text, units === "json" ? escapeSafeEnd(text, keep) : keep);
}

/** `keep`, or one less when the char before it is a high surrogate. */
function surrogateSafeEnd(text: string, keep: number): number {
  if (keep <= 0) return keep;
  const code = text.charCodeAt(keep - 1);
  return code >= 0xd800 && code <= 0xdbff ? keep - 1 : keep;
}

/**
 * `keep`, or the start of the JSON escape (`\x` or `\uXXXX`) that a cut at
 * `keep` would split.
 */
function escapeSafeEnd(text: string, keep: number): number {
  for (let i = 0; i < keep; i++) {
    if (text.charCodeAt(i) !== 0x5c) continue;
    const end = i + (text[i + 1] === "u" ? 6 : 2);
    if (end > keep) return i;
    i = end - 1;
  }
  return keep;
}
