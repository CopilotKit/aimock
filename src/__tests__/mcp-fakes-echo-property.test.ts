/**
 * Property test for the bounded echo of values into MCP fakes messages.
 *
 * Over many generated inputs (seeded, deterministic: mulberry32), `echo` and
 * `echoText` output:
 * - never exceeds the limit,
 * - never shows the internal snapshot placeholder's fields,
 * - never ends its kept part inside a JSON escape or a surrogate pair, and
 *   the kept part is always a prefix of the full text.
 */
import { describe, expect, it } from "vitest";
import { MCP_FAKES_ECHO_LIMIT, echo, echoText, validateMcpFakes } from "../mcp-fakes.js";

/** mulberry32: a small, well-mixed 32-bit PRNG. Returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed_2026;
const RUNS = 2_000;

/** Chars that JSON-quote to an escape, plus plain, multi-byte and surrogate chars. */
const CHARS = [
  "a",
  "Z",
  " ",
  '"',
  "\\",
  "\n",
  "\t",
  "\r",
  "\b",
  "\f",
  "\u0000",
  "\u0001",
  "\u001f",
  "\u007f",
  "…",
  "é",
  "😀", // a surrogate pair
  "\ud800", // a lone high surrogate (JSON-quoted as \ud800)
  "\udc00", // a lone low surrogate
  "(",
  "<",
  ">",
];

/** Object keys; never `reason` or `at`, so a leaked placeholder field is unambiguous. */
const KEYS = ["k", "key two", 'q"uote', "back\\slash", "nl\n", "x".repeat(30), "é"];

class Gen {
  constructor(private readonly rand: () => number) {}

  int(max: number): number {
    return Math.floor(this.rand() * max);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  string(): string {
    const len = this.pick([0, 1, 3, 10, 60, 120, 250, 400]);
    let s = "";
    for (let i = 0; i < len; i++) s += this.pick(CHARS);
    return s;
  }

  /** A plain JSON value. */
  json(depth = 0): unknown {
    const leaf = depth > 3 || this.rand() < 0.4;
    if (leaf) {
      switch (this.int(5)) {
        case 0:
          return this.string();
        case 1:
          return this.pick([0, -1, 1.5, 1e21, 123456789]);
        case 2:
          return this.rand() < 0.5;
        case 3:
          return null;
        default:
          return this.string();
      }
    }
    const n = this.int(5);
    if (this.rand() < 0.5) return Array.from({ length: n }, () => this.json(depth + 1));
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) obj[this.pick(KEYS) + String(i)] = this.json(depth + 1);
    return obj;
  }

  /** A value that is not plain data, which the input snapshot replaces with a placeholder. */
  notPlain(): unknown {
    switch (this.int(7)) {
      case 0:
        return new Date(0);
      case 1:
        return new Map();
      case 2:
        return () => 1;
      case 3:
        return Symbol("s");
      case 4:
        return 10n;
      case 5:
        // eslint-disable-next-line no-sparse-arrays
        return [1, , 2];
      default:
        return Object.defineProperty({}, "g", { get: () => 1, enumerable: true });
    }
  }

  /** A JSON-like container with non-plain values mixed in at any level. */
  mixed(depth = 0): unknown {
    if (depth > 3 || this.rand() < 0.3) {
      return this.rand() < 0.5 ? this.notPlain() : this.json(depth + 2);
    }
    const n = 1 + this.int(4);
    if (this.rand() < 0.5) return Array.from({ length: n }, () => this.mixed(depth + 1));
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) obj[this.pick(KEYS) + String(i)] = this.mixed(depth + 1);
    return obj;
  }
}

const CUT = /…(?: \(\d+ more chars\))?$/;

/** The kept part of a cut text, or `null` when the text was not cut. */
function keptPart(out: string, full: string): string | null {
  if (out === full) return null;
  if (out === "") return "";
  const m = CUT.exec(out);
  if (!m) throw new Error(`cut text without a cut marker: ${JSON.stringify(out)}`);
  return out.slice(0, out.length - m[0].length);
}

/** Where `kept` ends inside a JSON escape (`\x` or `\uXXXX`), or `null`. */
function splitEscapeAt(kept: string): number | null {
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] !== "\\") continue;
    const len = kept[i + 1] === "u" ? 6 : 2;
    if (i + len > kept.length) return i;
    i += len - 1;
  }
  return null;
}

/** The cut after `kept` falls between the two halves of a surrogate pair of `full`. */
function splitsPair(kept: string, full: string): boolean {
  const high = kept.charCodeAt(kept.length - 1);
  const low = full.charCodeAt(kept.length);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

describe("echo / echoText properties (seeded)", () => {
  it(`hold for ${RUNS} generated JSON values at random limits`, () => {
    const g = new Gen(mulberry32(SEED));
    let cuts = 0;
    for (let run = 0; run < RUNS; run++) {
      const value = g.json();
      const limit = g.pick([0, 1, 2, 5, 12, 20, 40, 80, MCP_FAKES_ECHO_LIMIT, 1_000]);
      // A message escapes DEL, which JSON.stringify keeps raw (C1 controls and
      // the line separators too; the generator makes none of those).
      const full = JSON.stringify(value).replace(/\u007f/g, "\\u007f");
      const out = echo(value, limit);
      const ctx = `run ${run}, limit ${limit}: ${JSON.stringify(out)}`;
      expect(out.length, ctx).toBeLessThanOrEqual(limit);
      const kept = keptPart(out, full);
      if (kept === null) continue;
      cuts += 1;
      expect(full.startsWith(kept), ctx).toBe(true);
      expect(splitEscapeAt(kept), ctx).toBeNull();
      expect(splitsPair(kept, full), ctx).toBe(false);
    }
    // The generator must exercise the cut path, or the checks above are vacuous.
    expect(cuts).toBeGreaterThan(RUNS / 4);
  });

  it(`echoText never exceeds the limit and never splits a surrogate pair (${RUNS} runs)`, () => {
    const g = new Gen(mulberry32(SEED + 1));
    for (let run = 0; run < RUNS; run++) {
      const text = g.string() + g.string();
      const limit = g.int(260);
      const out = echoText(text, limit);
      const ctx = `run ${run}, limit ${limit}: ${JSON.stringify(out)}`;
      expect(out.length, ctx).toBeLessThanOrEqual(limit);
      const kept = keptPart(out, text);
      if (kept === null) continue;
      expect(text.startsWith(kept), ctx).toBe(true);
      expect(splitsPair(kept, text), ctx).toBe(false);
    }
  });

  it(`messages never show the placeholder's fields (${RUNS} runs)`, () => {
    const g = new Gen(mulberry32(SEED + 2));
    let placeholders = 0;
    for (let run = 0; run < RUNS; run++) {
      const value = g.mixed();
      const raw =
        run % 2 === 0
          ? { scope: value, tools: [{ name: "t", calls: [{ anyArgs: true, result: "x" }] }] }
          : { scope: "shared", tools: value };
      const messages = validateMcpFakes(raw, "p.json").errors.map((e) => e.message);
      for (const message of messages) {
        const ctx = `run ${run}: ${message}`;
        expect(message, ctx).not.toMatch(/"reason":|"at":/);
        if (/<[^>]*(?:not a|accessor|hole|circular)/.test(message)) placeholders += 1;
      }
    }
    expect(placeholders).toBeGreaterThan(RUNS / 10);
  });
});
