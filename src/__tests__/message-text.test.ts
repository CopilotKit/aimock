/**
 * The message builder (message-text.ts): fixed text is kept whole, each user
 * part is quoted or rendered when it is made and cut once to its share of the
 * budget, and each cut counts the chars it left out of its own part.
 */
import { describe, expect, it } from "vitest";
import { MCP_FAKES_ECHO_LIMIT } from "../constants.js";
import {
  Message,
  UserText,
  build,
  fixed,
  fullText,
  jsonText,
  msg,
  plainText,
  quote,
  quoteJson,
  within,
} from "../message-text.js";

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

/** Chars that quote to an escape, plus plain and surrogate chars; never `§`. */
const CHARS = [
  "k",
  " ",
  '"',
  "\\",
  "\n",
  "\t",
  "\u0000",
  "\u0001",
  "\u001f",
  "\u0085",
  "\u2028",
  "😀",
  "é",
];

const CUT = /… \((\d+) more chars\)$|…$/;

/** Where `kept` ends inside a JSON escape (`\x` or `\uXXXX`). */
function endsInsideEscape(kept: string): boolean {
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] !== "\\") continue;
    const end = i + (kept[i + 1] === "u" ? 6 : 2);
    if (end > kept.length) return true;
    i = end - 1;
  }
  return false;
}

function endsOnHighSurrogate(kept: string): boolean {
  const c = kept.charCodeAt(kept.length - 1);
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * Check one cut part: `out` is `full`, or a prefix of it followed by `…` and
 * the true count of chars left out of `full`. Returns whether it was cut.
 */
function checkPart(out: string, part: UserText, ctx: string): boolean {
  if (out === part.text) return false;
  const m = CUT.exec(out);
  expect(m, `${ctx}: no cut mark in ${JSON.stringify(out)}`).not.toBeNull();
  const kept = out.slice(0, out.length - (m as RegExpExecArray)[0].length);
  expect(part.text.startsWith(kept), ctx).toBe(true);
  if (m?.[1] !== undefined) expect(kept.length + Number(m[1]), ctx).toBe(part.text.length);
  if (part.units === "json") expect(endsInsideEscape(kept), ctx).toBe(false);
  expect(endsOnHighSurrogate(kept), ctx).toBe(false);
  return true;
}

describe("msg", () => {
  it("keeps literals and numbers as fixed text and splices nested messages", () => {
    const inner = msg`tool ${quote("a")}`;
    const message = msg`${inner} calls[${3}] got ${jsonText("5")}`;
    expect(message.parts).toEqual(["tool ", quote("a"), " calls[", "3", "] got ", jsonText("5")]);
    expect(build(message)).toBe('tool "a" calls[3] got 5');
  });

  it("fixed text is a message of one fixed part", () => {
    expect(fixed("x").parts).toEqual(["x"]);
    expect(build(msg`a ${fixed("b")} c`)).toBe("a b c");
  });

  it("messages and parts are frozen", () => {
    const message = msg`a ${quote("b")}`;
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.parts)).toBe(true);
    expect(Object.isFrozen(message.parts[1])).toBe(true);
    expect(message).toBeInstanceOf(Message);
  });
});

describe("quote", () => {
  it("escapes quotes, backslashes, C0 and C1 controls and the line separators", () => {
    const text = 'a"b\\c\n\u0000\u001b\u0085\u009b\u2028\u2029';
    const out = quoteJson(text);
    expect(out).toBe('"a\\"b\\\\c\\n\\u0000\\u001b\\u0085\\u009b\\u2028\\u2029"');
    expect(JSON.parse(out)).toBe(text);
    expect(out).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
    expect(quote(text).text).toBe(out);
    expect(quote(text).units).toBe("json");
  });

  it("is cut to MCP_FAKES_ECHO_LIMIT by default", () => {
    expect(build(msg`${quote("x".repeat(1_000))}`).length).toBeLessThanOrEqual(
      MCP_FAKES_ECHO_LIMIT,
    );
  });
});

describe("build", () => {
  it("keeps the fixed text whole however long the user parts are", () => {
    const out = build(
      msg`tool ${quote("n".repeat(1_000))} is declared twice in one block`,
      MCP_FAKES_ECHO_LIMIT,
    );
    expect(out.length).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
    expect(out.startsWith('tool "nnn')).toBe(true);
    expect(out.endsWith(" is declared twice in one block")).toBe(true);
  });

  it("gives a short part all of it and splits the rest between the long ones", () => {
    const a = quote("a".repeat(500));
    const b = quote("b");
    const c = quote("c".repeat(500));
    const out = build(msg`${a}|${b}|${c}`, 100);
    const [pa, pb, pc] = out.split("|");
    expect(pb).toBe('"b"');
    expect(out.length).toBeLessThanOrEqual(100);
    expect(Math.abs(pa.length - pc.length)).toBeLessThanOrEqual(1);
    for (const [o, p] of [
      [pa, a],
      [pc, c],
    ] as const) {
      expect(checkPart(o, p, "split")).toBe(true);
    }
  });

  it("cuts each part to its max with no budget", () => {
    const out = build(msg`${quote("x".repeat(500), 30)}`);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(checkPart(out, quote("x".repeat(500), 30), "max")).toBe(true);
  });

  it("within builds a part in a budget of its own", () => {
    const detail = msg`entry id ${quote("i".repeat(500))} is not unique`;
    const out = build(msg`${quote("f".repeat(500))}: [rule] ${within(80, detail)}`);
    const tail = out.slice(out.indexOf(": [rule] ") + ": [rule] ".length);
    expect(tail.length).toBeLessThanOrEqual(80);
    expect(tail.endsWith(" is not unique")).toBe(true);
  });

  it("fullText cuts nothing", () => {
    const long = "x".repeat(1_000);
    expect(fullText(msg`a ${quote(long, 5)} ${plainText(long, 5)}`)).toBe(
      `a ${JSON.stringify(long)} ${long}`,
    );
  });
});

describe("build properties (seeded)", () => {
  const SEP = "§";

  it("over part lengths from 0 to past every budget, with escapes everywhere", () => {
    const rand = mulberry32(0x6d5_2026);
    const int = (n: number): number => Math.floor(rand() * n);
    let cuts = 0;
    let runs = 0;
    for (let length = 0; length <= MCP_FAKES_ECHO_LIMIT + 60; length += 1) {
      for (let rep = 0; rep < 6; rep++) {
        runs += 1;
        const count = 1 + int(4);
        const users: UserText[] = [];
        const literals: string[] = [];
        for (let i = 0; i < count; i++) {
          const len = rep === 0 ? length : int(length + 1);
          let text = "";
          for (let j = 0; j < len; j++) text += CHARS[int(CHARS.length)];
          const max = [MCP_FAKES_ECHO_LIMIT, 40, 1_000][int(3)];
          users.push(
            int(3) === 0
              ? plainText(text, max)
              : int(2) === 0
                ? quote(text, max)
                : jsonText(quoteJson(text), max),
          );
          literals.push(` fixed ${i} `.repeat(int(3)));
        }
        const limit = [MCP_FAKES_ECHO_LIMIT, int(400), Infinity][int(3)];
        const parts: (string | UserText)[] = [];
        users.forEach((u, i) => parts.push(literals[i], SEP, u, SEP));
        const out = build(new Message(parts), limit);
        const fixedLength = parts.reduce<number>(
          (n, p) => n + (typeof p === "string" ? p.length : 0),
          0,
        );
        const ctx = `length ${length}, rep ${rep}, limit ${limit}: ${JSON.stringify(out)}`;
        if (fixedLength + count <= limit) expect(out.length, ctx).toBeLessThanOrEqual(limit);
        const pieces = out.split(SEP);
        expect(pieces).toHaveLength(2 * count + 1);
        users.forEach((u, i) => {
          expect(pieces[2 * i].endsWith(literals[i]), ctx).toBe(true);
          if (checkPart(pieces[2 * i + 1], u, ctx)) cuts += 1;
        });
      }
    }
    expect(runs).toBeGreaterThan(1_000);
    // The sweep must reach the cut often, or its checks are vacuous.
    expect(cuts).toBeGreaterThan(runs / 2);
  });
});

describe("DEL (U+007F) is escaped with the other raw controls", () => {
  it("quoteJson and jsonText escape DEL, C1 controls and the line separators", () => {
    expect(quoteJson("a\u007fb")).toBe('"a\\u007fb"');
    expect(jsonText('"a\u007f\u0085 "').text).toBe('"a\\u007f\\u0085\\u2028"');
    expect(quoteJson("\u007f")).not.toMatch(/\p{Cc}/u);
  });
});

describe("build checks max and limit", () => {
  it.each([[0], [-1], [-Infinity], [0.5], [Number.NaN]])(
    "a user part max of %d is a RangeError",
    (max) => {
      expect(() => quote("abc", max)).toThrow(RangeError);
      expect(() => jsonText('"abc"', max)).toThrow(RangeError);
      expect(() => plainText("abc", max)).toThrow(RangeError);
      expect(() => new UserText("abc", "text", max)).toThrow(RangeError);
    },
  );

  it("a NaN limit is a RangeError from build itself", () => {
    expect(() => build(msg`a ${quote("b")}`, Number.NaN)).toThrow(
      /^build limit must be a number, got NaN$/,
    );
  });

  it("a user part keeps at least a bare … however small the budget", () => {
    expect(build(msg`[${quote("abcdef", 1)}]`)).toBe("[…]");
    expect(build(msg`[${quote("abc")}|${quote("def")}]`, 0)).toBe("[…|…]");
    expect(build(msg`[${quote("abc")}]`, -Infinity)).toBe("[…]");
  });
});
