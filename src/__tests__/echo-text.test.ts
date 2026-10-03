/**
 * The one cut rule for MCP fakes messages, at every place that cuts: `echo`
 * and `echoText` (mcp-fakes.ts), the `MCP_INVALID_UNDECLARED` value echo
 * (helpers.ts) and the `FixtureLoadError` message parts (fixture-loader.ts).
 * Also: a user string that spells the internal placeholder mark text is
 * echoed as that string, never as a placeholder.
 */
import { describe, expect, it } from "vitest";
import { cutText } from "../echo-text.js";
import { FixtureLoadError } from "../fixture-loader.js";
import { resolveMcpIdentity } from "../helpers.js";
import { MCP_FAKES_ECHO_LIMIT, echo, echoText, validateMcpFakes } from "../mcp-fakes.js";

const LABELS = {
  header: "X-AIMock-MCP-Undeclared header",
  query: "?undeclared= query parameter",
} as const;

/**
 * The `MCP_INVALID_UNDECLARED` message for `value`, sent as a header and as a
 * query, with the value as sent (the query value still percent-encoded).
 */
function undeclaredMessages(
  value: string,
): { source: keyof typeof LABELS; sent: string; message: string }[] {
  const query = encodeURIComponent(value);
  return [
    resolveMcpIdentity({ headers: { "x-aimock-mcp-undeclared": value }, url: "/mcp" }),
    resolveMcpIdentity({ headers: {}, url: `/mcp?undeclared=${query}` }),
  ].map((r, i) => {
    if (!("error" in r) || r.error.code !== "MCP_INVALID_UNDECLARED") {
      throw new Error(`expected MCP_INVALID_UNDECLARED, got ${JSON.stringify(r)}`);
    }
    return {
      source: r.error.source as keyof typeof LABELS,
      sent: i === 0 ? value : query,
      message: r.error.message,
    };
  });
}

/**
 * True when `kept` ends inside a JSON escape (`\x` or `\uXXXX`). Reads
 * `kept` as JSON-quoted text, where a backslash only ever starts an escape.
 */
function endsInsideEscape(kept: string): boolean {
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] !== "\\") continue;
    const end = i + (kept[i + 1] === "u" ? 6 : 2);
    if (end > kept.length) return true;
    i = end - 1;
  }
  return false;
}

/** The echoed value of an `MCP_INVALID_UNDECLARED` message. */
function echoedValue(message: string, source: keyof typeof LABELS): string {
  const head = `Invalid ${LABELS[source]} value `;
  const tail = ": expected allow or deny";
  expect(message.startsWith(head) && message.endsWith(tail), message).toBe(true);
  return message.slice(head.length, message.length - tail.length);
}

describe("the MCP_INVALID_UNDECLARED value echo cuts the way `echo` does", () => {
  it("gives the literal cut text", () => {
    const [header] = undeclaredMessages("a".repeat(150) + "\n".repeat(40));
    expect(header.message).toBe(
      "Invalid X-AIMock-MCP-Undeclared header value " +
        '"' +
        "a".repeat(150) +
        "\\n".repeat(16) +
        "… (49 more chars): expected allow or deny",
    );
    const [quote] = undeclaredMessages("a".repeat(197) + '"'.repeat(40));
    expect(quote.message).toBe(
      "Invalid X-AIMock-MCP-Undeclared header value " +
        '"' +
        "a".repeat(182) +
        "… (96 more chars): expected allow or deny",
    );
  });

  it("never splits a JSON escape at the cut point", () => {
    // Quotes, backslashes and control chars JSON-quote to `\"`, `\\`, `\n`;
    // sweeping the plain prefix moves the cut across every escape position.
    // The checks are independent of the cut: a prefix of the JSON-quoted
    // value, never inside an escape, and a count that adds up.
    for (const tail of ['"', "\\", "\n", "\u0001"]) {
      for (let i = 140; i < MCP_FAKES_ECHO_LIMIT; i++) {
        const value = "a".repeat(i) + tail.repeat(40);
        for (const { source, sent, message } of undeclaredMessages(value)) {
          const label = `tail ${JSON.stringify(tail)}, prefix ${i}, ${source}`;
          const full = JSON.stringify(sent);
          const echoed = echoedValue(message, source);
          const match = /^([^…]*)… \((\d+) more chars\)$/.exec(echoed);
          expect(match, label).not.toBeNull();
          const kept = match![1];
          expect(echoed.length, label).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
          expect(full.startsWith(kept), label).toBe(true);
          expect(endsInsideEscape(kept), label).toBe(false);
          expect(Number(match![2]), label).toBe(full.length - kept.length);
          // The cut leaves no room for one more whole escape or char.
          expect(echoed.length, label).toBeGreaterThan(MCP_FAKES_ECHO_LIMIT - 6);
        }
      }
    }
  });
});

describe("FixtureLoadError cuts its parts to literal expected texts", () => {
  const pair = "\u{1F600}";
  // [input, the detail as cut, the file / block id / entry id as quoted and cut]
  const cases: [string, string, string][] = [
    [
      "y".repeat(50_000),
      "y".repeat(180) + "… (49820 more chars)",
      '"' + "y".repeat(179) + "… (49822 more chars)",
    ],
    [
      "é".repeat(MCP_FAKES_ECHO_LIMIT + 1),
      "é".repeat(183) + "… (18 more chars)",
      '"' + "é".repeat(182) + "… (20 more chars)",
    ],
    [
      "y".repeat(170) + pair.repeat(40),
      "y".repeat(170) + pair.repeat(6) + "… (68 more chars)",
      '"' + "y".repeat(170) + pair.repeat(6) + "… (69 more chars)",
    ],
    [
      "y".repeat(171) + pair.repeat(40),
      "y".repeat(171) + pair.repeat(6) + "… (68 more chars)",
      '"' + "y".repeat(171) + pair.repeat(5) + "… (71 more chars)",
    ],
    [
      "y".repeat(172) + pair.repeat(40),
      "y".repeat(172) + pair.repeat(5) + "… (70 more chars)",
      '"' + "y".repeat(172) + pair.repeat(5) + "… (71 more chars)",
    ],
    [
      "y".repeat(173) + pair.repeat(40),
      "y".repeat(173) + pair.repeat(5) + "… (70 more chars)",
      '"' + "y".repeat(173) + pair.repeat(4) + "… (73 more chars)",
    ],
    [
      "y".repeat(174) + pair.repeat(40),
      "y".repeat(174) + pair.repeat(4) + "… (72 more chars)",
      '"' + "y".repeat(174) + pair.repeat(4) + "… (73 more chars)",
    ],
    [
      "y".repeat(175) + pair.repeat(40),
      "y".repeat(175) + pair.repeat(4) + "… (72 more chars)",
      '"' + "y".repeat(175) + pair.repeat(3) + "… (75 more chars)",
    ],
    [
      "y".repeat(176) + pair.repeat(40),
      "y".repeat(176) + pair.repeat(3) + "… (74 more chars)",
      '"' + "y".repeat(176) + pair.repeat(3) + "… (75 more chars)",
    ],
    [
      "y".repeat(177) + pair.repeat(40),
      "y".repeat(177) + pair.repeat(3) + "… (74 more chars)",
      '"' + "y".repeat(177) + pair.repeat(2) + "… (77 more chars)",
    ],
  ];

  it.each(cases.map(([t, c, q], i) => [i, t, c, q]))(
    "file, block id, entry id and detail (case %i)",
    (_i, t, c, q) => {
      const err = new FixtureLoadError({
        rule: "mcp-fakes/bad-block:g",
        file: t,
        blockId: t,
        entryId: t,
        detail: t,
      });
      expect(c.length).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
      expect(q.length).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
      expect(err.message).toBe(`${q}, block ${q}, entry ${q}: [mcp-fakes/bad-block:g] ${c}`);
      expect(echoText(t)).toBe(c);
    },
  );
});

describe("cutText with a limit that is not an integer", () => {
  it("floors the limit, never prints a fractional count", () => {
    expect(cutText("a".repeat(300), 100.5)).toBe("a".repeat(82) + "… (218 more chars)");
    expect(cutText("a".repeat(300), 100.5)).toBe(cutText("a".repeat(300), 100));
  });

  it("a NaN limit is a RangeError", () => {
    expect(() => cutText("a".repeat(300), NaN)).toThrow(RangeError);
  });

  it.each([[-Infinity], [-1], [-5.5], [-1_000]])(
    "a negative limit (%d) keeps the at-most-limit contract: nothing is kept",
    (limit) => {
      for (const units of ["text", "json"] as const) {
        const out = cutText("a".repeat(300), limit, units);
        expect(out).toBe("");
        expect(out.length).toBeLessThanOrEqual(Math.max(0, limit));
      }
    },
  );
});

describe("a user string that spells the placeholder mark is not a placeholder", () => {
  const MARK = "\u0000aimock-placeholder:0\u0000";

  it("next to a placeholder in an array", () => {
    const messages = validateMcpFakes({ scope: [MARK, new Date(0)], tools: [] }, "f").errors.map(
      (e) => e.message,
    );
    const scope = messages.find((m) => m.includes("[mcp-fakes/bad-block:b]"));
    expect(scope).toContain(`got [${JSON.stringify(MARK)},<not a plain JSON object`);
  });

  it("next to a placeholder in an object", () => {
    const calls = {
      x: MARK,
      get y() {
        return 1;
      },
    };
    const messages = validateMcpFakes(
      { scope: "shared", tools: [{ name: "t", calls }] },
      "f",
    ).errors.map((e) => e.message);
    expect(messages).toContain(
      `"f", block "f": [mcp-fakes/bad-block:g] tool "t" calls must be a non-empty array, got ` +
        `{"x":${JSON.stringify(MARK)},"y":<an accessor property (getters are not read)>}`,
    );
  });

  it("with no placeholder in the value", () => {
    expect(echo([MARK])).toBe(`[${JSON.stringify(MARK)}]`);
  });
});

describe("cutText with a limit below 1", () => {
  it("keeps nothing, as its doc says: not even a bare …", () => {
    expect(cutText("abc", 0)).toBe("");
    expect(cutText("abc", 0.5, "json")).toBe("");
    expect(cutText("", 0)).toBe("");
    expect(cutText("abc", 1)).toBe("…");
  });
});
