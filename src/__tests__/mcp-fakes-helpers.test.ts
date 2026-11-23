import { describe, it, expect } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { decodeMcpHeaderValue, resolveMcpIdentity } from "../helpers.js";
import { echo, MCP_FAKES_ECHO_LIMIT } from "../mcp-fakes.js";
import { cutText } from "../echo-text.js";

function req(headers: IncomingHttpHeaders = {}, url = "/mcp") {
  return { headers, url };
}

/** Narrow on the shape (not on `ok`) so assertions run on the behavior. */
function resolved(r: ReturnType<typeof resolveMcpIdentity>) {
  if (!("identity" in r)) throw new Error(`expected a resolved identity, got ${JSON.stringify(r)}`);
  return r;
}

function rejected(r: ReturnType<typeof resolveMcpIdentity>) {
  if (!("error" in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  return r;
}

const resolve = (...args: Parameters<typeof resolveMcpIdentity>) =>
  resolved(resolveMcpIdentity(...args));

describe("decodeMcpHeaderValue", () => {
  it("%E2%80%BA decodes", () => {
    expect(decodeMcpHeaderValue("a.spec.ts %E2%80%BA login")).toEqual({
      value: "a.spec.ts › login",
      fellBack: false,
    });
  });

  it("%25XX round-trips to a literal %XX", () => {
    expect(decodeMcpHeaderValue("100%2541")).toEqual({ value: "100%41", fellBack: false });
  });

  it("falls back only on a URIError: any other throw propagates", () => {
    const hostile = {
      toString(): string {
        throw new TypeError("not a URIError");
      },
    };
    expect(() => decodeMcpHeaderValue(hostile as unknown as string)).toThrow(TypeError);
  });

  it("raw `applies 50% discount` falls back without a throw", () => {
    expect(() => decodeMcpHeaderValue("applies 50% discount")).not.toThrow();
    expect(decodeMcpHeaderValue("applies 50% discount")).toEqual({
      value: "applies 50% discount",
      fellBack: true,
    });
  });

  it("ASCII values with no % are unchanged", () => {
    expect(decodeMcpHeaderValue("login-test_1")).toEqual({
      value: "login-test_1",
      fellBack: false,
    });
  });
});

describe("resolveMcpIdentity: test id", () => {
  it("returns null and not-supplied when nothing is sent", () => {
    expect(resolve(req())).toEqual({
      ok: true,
      identity: { testId: null, context: null, undeclared: null },
      supplied: { testId: false, context: false, undeclared: false },
      fellBack: { testId: false, context: false },
    });
  });

  it("decodes the X-Test-Id header", () => {
    const r = resolve(req({ "x-test-id": "a.spec.ts%20%E2%80%BA%20login" }));
    expect(r.identity.testId).toBe("a.spec.ts › login");
    expect(r.supplied.testId).toBe(true);
  });

  it("falls back to the raw header when decoding throws", () => {
    const r = resolve(req({ "x-test-id": "applies 50% discount" }));
    expect(r.identity.testId).toBe("applies 50% discount");
  });

  it("reads ?testId= (decoded like the header) when no header", () => {
    const r = resolve(req({}, "/mcp?testId=a.spec.ts%20%E2%80%BA%20login"));
    expect(r.identity.testId).toBe("a.spec.ts › login");
    expect(r.supplied.testId).toBe(true);
  });

  it("order: header wins over query", () => {
    const r = resolve(req({ "x-test-id": "from-header" }, "/mcp?testId=from-query"));
    expect(r.identity.testId).toBe("from-header");
  });

  it("order: query wins over the session", () => {
    const r = resolve(req({}, "/mcp?testId=from-query"), { testId: "from-session" });
    expect(r.identity.testId).toBe("from-query");
    expect(r.supplied.testId).toBe(true);
  });

  it("uses the element of a one-element array header", () => {
    const r = resolve(req({ "x-test-id": ["only"] }));
    expect(r.identity.testId).toBe("only");
  });

  it("an empty header or query is not supplied (raw check, not resolveTestId's __default__)", () => {
    const r = resolve(req({ "x-test-id": "" }, "/mcp?testId="));
    expect(r.identity.testId).toBeNull();
    expect(r.supplied.testId).toBe(false);
  });

  it("an empty header is never rejected and falls through to the query", () => {
    const r = resolve(req({ "x-test-id": "" }, "/mcp?testId=q"));
    expect(r.identity.testId).toBe("q");
    expect(r.supplied.testId).toBe(true);
  });

  it("does not treat the literal __default__ specially: it is a supplied value", () => {
    const r = resolve(req({ "x-test-id": "__default__" }));
    expect(r.identity.testId).toBe("__default__");
    expect(r.supplied.testId).toBe(true);
  });

  it("tolerates an undefined url", () => {
    const r = resolve({ headers: {}, url: undefined });
    expect(r.identity.testId).toBeNull();
  });
});

describe("resolveMcpIdentity: context (header, ?context=)", () => {
  it("decodes the X-AIMock-Context header", () => {
    const r = resolve(req({ "x-aimock-context": "Refund%3A%20v1" }));
    expect(r.identity.context).toBe("Refund: v1");
    expect(r.supplied.context).toBe(true);
  });

  it("reads ?context= when no header", () => {
    const r = resolve(req({}, "/mcp?context=Refund%3A%20v1"));
    expect(r.identity.context).toBe("Refund: v1");
    expect(r.supplied.context).toBe(true);
  });

  it("order: header wins over query", () => {
    const r = resolve(req({ "x-aimock-context": "h" }, "/mcp?context=q"));
    expect(r.identity.context).toBe("h");
  });

  it("does not normalize case or punctuation", () => {
    const r = resolve(req({ "x-aimock-context": "refund v1" }));
    expect(r.identity.context).toBe("refund v1");
  });
});

describe("resolveMcpIdentity: per-field session inheritance", () => {
  const session = { testId: "T", context: "C", undeclared: "deny" as const };

  it("inherits every field from the session when none is supplied", () => {
    expect(resolve(req(), session)).toEqual({
      ok: true,
      identity: { testId: "T", context: "C", undeclared: "deny" },
      supplied: { testId: false, context: false, undeclared: false },
      fellBack: { testId: false, context: false },
    });
  });

  it("a per-request header wins over the session", () => {
    const r = resolve(
      req({
        "x-test-id": "T2",
        "x-aimock-context": "C2",
        "x-aimock-mcp-undeclared": "allow",
      }),
      session,
    );
    expect(r.identity).toEqual({ testId: "T2", context: "C2", undeclared: "allow" });
    expect(r.supplied).toEqual({ testId: true, context: true, undeclared: true });
  });

  it("each field resolves on its own (?testId=T bound, context sent later)", () => {
    const r = resolve(req({ "x-aimock-context": "C" }), { testId: "T" });
    expect(r.identity).toEqual({ testId: "T", context: "C", undeclared: null });
    expect(r.supplied).toEqual({ testId: false, context: true, undeclared: false });
  });

  it("a session field left unset stays null", () => {
    const r = resolve(req(), {});
    expect(r.identity).toEqual({ testId: null, context: null, undeclared: null });
  });
});

describe("resolveMcpIdentity: undeclared override", () => {
  it("parses the X-AIMock-MCP-Undeclared header (case-insensitive, trimmed)", () => {
    expect(resolve(req({ "x-aimock-mcp-undeclared": "deny" })).identity.undeclared).toBe("deny");
    expect(resolve(req({ "x-aimock-mcp-undeclared": "  ALLOW " })).identity.undeclared).toBe(
      "allow",
    );
    expect(resolve(req({ "x-aimock-mcp-undeclared": "deny" })).supplied.undeclared).toBe(true);
  });

  it("reads ?undeclared= when no header", () => {
    const r = resolve(req({}, "/mcp?undeclared=deny"));
    expect(r.identity.undeclared).toBe("deny");
    expect(r.supplied.undeclared).toBe(true);
  });

  it("header wins over query", () => {
    const r = resolve(req({ "x-aimock-mcp-undeclared": "allow" }, "/mcp?undeclared=deny"));
    expect(r.identity.undeclared).toBe("allow");
  });

  it("a blank header is not supplied and falls through to the query", () => {
    const r = resolve(req({ "x-aimock-mcp-undeclared": " " }, "/mcp?undeclared=deny"));
    expect(r.identity.undeclared).toBe("deny");
    expect(r.supplied.undeclared).toBe(true);
  });

  it("?undeclared= is case-insensitive and trimmed", () => {
    expect(resolve(req({}, "/mcp?undeclared=%20DENY%20")).identity.undeclared).toBe("deny");
  });
});

// ─── Fallback flags, shared decoding, invalid overrides, array headers ─────
// `resolved` / `rejected` narrow on the shape (not on `ok`), so the behavioral
// assertions run and fail on the behavior, not on a missing flag.

describe("resolveMcpIdentity: the decode fallback flag is exposed per header", () => {
  it("reports fellBack for a raw X-Test-Id that is not valid percent-encoding", () => {
    const r = resolved(resolveMcpIdentity(req({ "x-test-id": "applies 50% discount" })));
    expect(r.identity.testId).toBe("applies 50% discount");
    expect(r.fellBack).toEqual({ testId: true, context: false });
  });

  it("reports fellBack for a raw X-AIMock-Context, independently of X-Test-Id", () => {
    const r = resolved(
      resolveMcpIdentity(req({ "x-test-id": "a%20b", "x-aimock-context": "100% refund" })),
    );
    expect(r.fellBack).toEqual({ testId: false, context: true });
  });

  it("a cleanly decoded header, a query value or a session value never sets fellBack", () => {
    const r = resolved(
      resolveMcpIdentity(req({}, "/mcp?testId=50%25"), { context: "100% refund" }),
    );
    expect(r.fellBack).toEqual({ testId: false, context: false });
  });
});

describe("resolveMcpIdentity: the query is decoded as URLSearchParams decodes it (spec I1)", () => {
  it("a query `+` is a space, as URLSearchParams reads it; a header `+` stays a `+`", () => {
    const h = resolved(resolveMcpIdentity(req({ "x-test-id": "a+b" })));
    const q = resolved(resolveMcpIdentity(req({}, "/mcp?testId=a+b")));
    expect(h.identity.testId).toBe("a+b");
    expect(q.identity.testId).toBe("a b");
    expect(q.identity.testId).toBe(new URLSearchParams("testId=a+b").get("testId"));
  });

  it("the same holds for context, and `%2B` is a literal `+` on the query", () => {
    const h = resolved(resolveMcpIdentity(req({ "x-aimock-context": "C++ v1" })));
    const q = resolved(resolveMcpIdentity(req({}, "/mcp?context=C%2B%2B+v1")));
    expect(h.identity.context).toBe("C++ v1");
    expect(q.identity.context).toBe("C++ v1");
  });

  it("a query built with URL.searchParams resolves to the id the header resolves to", () => {
    for (const id of ["a b", "a.spec.ts › login", "1+1 = 2 & 50%", "C++ v1"]) {
      const url = new URL("http://localhost/mcp");
      url.searchParams.set("testId", id);
      url.searchParams.set("context", id);
      const q = resolved(resolveMcpIdentity(req({}, `${url.pathname}${url.search}`)));
      const h = resolved(
        resolveMcpIdentity(
          req({ "x-test-id": encodeURIComponent(id), "x-aimock-context": encodeURIComponent(id) }),
        ),
      );
      expect(q.identity).toEqual(h.identity);
      expect(q.identity.testId).toBe(id);
      expect(q.fellBack).toEqual({ testId: false, context: false });
    }
  });

  it("guard: encodeURIComponent output resolves identically on both paths", () => {
    const id = "a.spec.ts › 1+1 = 2 & 50%";
    const enc = encodeURIComponent(id);
    const h = resolved(resolveMcpIdentity(req({ "x-test-id": enc })));
    const q = resolved(resolveMcpIdentity(req({}, `/mcp?testId=${enc}`)));
    expect(h.identity.testId).toBe(id);
    expect(q.identity.testId).toBe(id);
  });
});

describe("resolveMcpIdentity: an invalid undeclared override fails loud", () => {
  it("an unrecognized X-AIMock-MCP-Undeclared value is an error, never a silent allow", () => {
    const r = rejected(resolveMcpIdentity(req({ "x-aimock-mcp-undeclared": "denied" })));
    expect(r).toEqual({
      ok: false,
      error: {
        code: "MCP_INVALID_UNDECLARED",
        status: 400,
        field: "undeclared",
        source: "header",
        raw: "denied",
        message: 'Invalid X-AIMock-MCP-Undeclared header value "denied": expected allow or deny',
      },
    });
  });

  it("an invalid header does not fall through to a valid query", () => {
    const r = rejected(
      resolveMcpIdentity(req({ "x-aimock-mcp-undeclared": "maybe" }, "/mcp?undeclared=deny")),
    );
    expect(r.error).toEqual({
      code: "MCP_INVALID_UNDECLARED",
      status: 400,
      field: "undeclared",
      source: "header",
      raw: "maybe",
      message: 'Invalid X-AIMock-MCP-Undeclared header value "maybe": expected allow or deny',
    });
  });

  it("an invalid ?undeclared= is an error even when a valid header wins", () => {
    for (const header of ["allow", "deny"]) {
      const r = rejected(
        resolveMcpIdentity(req({ "x-aimock-mcp-undeclared": header }, "/mcp?undeclared=denied")),
      );
      expect(r.error).toEqual({
        code: "MCP_INVALID_UNDECLARED",
        status: 400,
        field: "undeclared",
        source: "query",
        raw: "denied",
        message: 'Invalid ?undeclared= query parameter value "denied": expected allow or deny',
      });
    }
  });

  it("an invalid ?undeclared= is an error even when the session says deny", () => {
    const r = rejected(resolveMcpIdentity(req({}, "/mcp?undeclared=dney"), { undeclared: "deny" }));
    expect(r.error).toEqual({
      code: "MCP_INVALID_UNDECLARED",
      status: 400,
      field: "undeclared",
      source: "query",
      raw: "dney",
      message: 'Invalid ?undeclared= query parameter value "dney": expected allow or deny',
    });
  });

  it("uses the exact error text for the header and the query", () => {
    const h = rejected(resolveMcpIdentity(req({ "x-aimock-mcp-undeclared": "denied" })));
    expect(h.error.message).toBe(
      'Invalid X-AIMock-MCP-Undeclared header value "denied": expected allow or deny',
    );
    const q = rejected(resolveMcpIdentity(req({}, "/mcp?undeclared=dney")));
    expect(q.error.message).toBe(
      'Invalid ?undeclared= query parameter value "dney": expected allow or deny',
    );
  });

  it("does not percent-decode the header: only literal allow / deny are accepted", () => {
    const r = rejected(resolveMcpIdentity(req({ "x-aimock-mcp-undeclared": "de%6Ey" })));
    expect(r.error).toEqual({
      code: "MCP_INVALID_UNDECLARED",
      status: 400,
      field: "undeclared",
      source: "header",
      raw: "de%6Ey",
      message: 'Invalid X-AIMock-MCP-Undeclared header value "de%6Ey": expected allow or deny',
    });
  });
});

describe("resolveMcpIdentity: a lone query name with no `=` is not a value", () => {
  it("a bare name alone is not supplied", () => {
    const r = resolved(resolveMcpIdentity(req({}, "/mcp?testId&context")));
    expect(r.identity).toEqual({ testId: null, context: null, undeclared: null });
    expect(r.supplied).toEqual({ testId: false, context: false, undeclared: false });
  });
});

// ─── Header / query parity ──────────────────────────────────────────────────
// One table runs the same raw values through the header form and the query
// form. The resolved identity, `supplied`, `fellBack` and any error must be
// the same; only `source` and the label in the message may differ. The one
// deliberate exception: the undeclared header is compared as sent, while its
// query value is percent-decoded, so a value whose decoding changes its
// meaning (`de%6Ey`) differs between the two.

const PARITY_FIELDS = {
  testId: {
    header: "x-test-id",
    query: "testId",
    label: ["X-Test-Id header", "?testId= query parameter"],
  },
  context: {
    header: "x-aimock-context",
    query: "context",
    label: ["X-AIMock-Context header", "?context= query parameter"],
  },
  undeclared: {
    header: "x-aimock-mcp-undeclared",
    query: "undeclared",
    label: ["X-AIMock-MCP-Undeclared header", "?undeclared= query parameter"],
  },
} as const;

const PARITY_VALUES = [
  "",
  " ",
  "a+b",
  "a%2Bb",
  "50%",
  "%E2%80",
  "deny",
  "denied",
  "DENY",
  'de"ny',
  "x".repeat(50_000),
];

/** Repetition shapes: one value, or the same field sent more than once. */
const PARITY_SHAPES: ((v: string) => string[])[] = [
  (v) => [v],
  (v) => ["", v],
  (v) => [" ", v],
  (v) => [v, "deny"],
  (v) => [v, v],
];

/**
 * Pairs whose header and query forms are expected to differ: the undeclared
 * header is not percent-decoded, so `de%6Ey` means `deny` only on the query,
 * and only the query error notes a value that is not valid percent-encoding.
 * A query `+` is a space (URLSearchParams, spec I1) and a header `+` is a
 * `+`, so `a+b` is `a b` on the query and `a+b` on the header.
 */
const PARITY_EXCEPTIONS = new Set([
  "undeclared|de%6Ey",
  "undeclared|50%",
  "undeclared|%E2%80",
  "testId|a+b",
  "context|a+b",
]);

function normalize(r: ReturnType<typeof resolveMcpIdentity>, labels: readonly string[]) {
  if ("identity" in r) {
    return { identity: r.identity, supplied: r.supplied, fellBack: r.fellBack };
  }
  const rest: Record<string, unknown> = { ...r.error };
  delete rest.source;
  return { ...rest, message: labels.reduce((m, l) => m.split(l).join("<label>"), r.error.message) };
}

describe("resolveMcpIdentity: header and query parity", () => {
  for (const [field, spec] of Object.entries(PARITY_FIELDS)) {
    for (const value of [...PARITY_VALUES, "de%6Ey"]) {
      PARITY_SHAPES.forEach((shape, shapeIndex) => {
        const values = shape(value);
        const name = `${field} ${JSON.stringify(value.slice(0, 12))}${value.length > 12 ? "…" : ""} shape ${shapeIndex}`;
        it(name, () => {
          const headerValue = values.length === 1 ? values[0] : values;
          const h = resolveMcpIdentity(req({ [spec.header]: headerValue }));
          const q = resolveMcpIdentity(
            req({}, `/mcp?${values.map((v) => `${spec.query}=${v}`).join("&")}`),
          );
          if (values.length > 1) {
            // A repeated identity input is an error on both paths: no value is picked.
            for (const [r, source] of [
              [h, "header"],
              [q, "query"],
            ] as const) {
              expect(rejected(r).error).toEqual({
                code: "MCP_DUPLICATE_IDENTITY",
                status: 400,
                field,
                source,
                count: values.length,
                message: `Duplicate ${spec.label[source === "header" ? 0 : 1]}: ${values.length} values sent, expected one`,
              });
            }
          }
          if (shapeIndex === 0 && PARITY_EXCEPTIONS.has(`${field}|${value}`)) {
            expect(normalize(h, spec.label)).not.toEqual(normalize(q, spec.label));
            return;
          }
          expect(normalize(q, spec.label)).toEqual(normalize(h, spec.label));
        });
      });
    }
  }
});

describe("resolveMcpIdentity: a repeated identity input is rejected", () => {
  it.each([
    ["/mcp?testId=&testId=t1", "testId"],
    ["/mcp?testId&testId=t1", "testId"],
    ["/mcp?context=a&context=b", "context"],
    ["/mcp?undeclared=&undeclared=deny", "undeclared"],
    ["/mcp?undeclared=deny&undeclared=deny", "undeclared"],
  ])("%s is a 400, not a picked value", (url, field) => {
    const r = rejected(resolveMcpIdentity(req({}, url)));
    expect(r.error).toEqual({
      code: "MCP_DUPLICATE_IDENTITY",
      status: 400,
      field,
      source: "query",
      count: 2,
      message: `Duplicate ?${field}= query parameter: 2 values sent, expected one`,
    });
  });

  it("headersDistinct (what Node fills for a real request) is read before the joined header", () => {
    const r = rejected(
      resolveMcpIdentity({
        headers: { "x-aimock-mcp-undeclared": "deny, deny" },
        headersDistinct: { "x-aimock-mcp-undeclared": ["deny", "deny"] },
        url: "/mcp",
      }),
    );
    expect(r.error).toEqual({
      code: "MCP_DUPLICATE_IDENTITY",
      status: 400,
      field: "undeclared",
      source: "header",
      count: 2,
      message: "Duplicate X-AIMock-MCP-Undeclared header: 2 values sent, expected one",
    });
  });

  it("a repeated header is a 400 naming the header", () => {
    const r = rejected(resolveMcpIdentity(req({ "x-test-id": ["a", "b", "c"] })));
    expect(r.error).toEqual({
      code: "MCP_DUPLICATE_IDENTITY",
      status: 400,
      field: "testId",
      source: "header",
      count: 3,
      message: "Duplicate X-Test-Id header: 3 values sent, expected one",
    });
  });

  it("a duplicate query is rejected even when the header supplies the field", () => {
    const r = rejected(resolveMcpIdentity(req({ "x-test-id": "h" }, "/mcp?testId=a&testId=b")));
    expect(r.error).toEqual({
      code: "MCP_DUPLICATE_IDENTITY",
      status: 400,
      field: "testId",
      source: "query",
      count: 2,
      message: "Duplicate ?testId= query parameter: 2 values sent, expected one",
    });
  });
});

describe("resolveMcpIdentity: the decode fallback flag and raw value on the query path", () => {
  it("an undecodable ?testId= next to an X-Test-Id header still sets fellBack (header wins)", () => {
    const r = resolved(resolveMcpIdentity(req({ "x-test-id": "h" }, "/mcp?testId=%zz")));
    expect(r.identity.testId).toBe("h");
    expect(r.fellBack).toEqual({ testId: true, context: false });
  });

  it("an undecodable ?context= next to an X-AIMock-Context header still sets fellBack", () => {
    const r = resolved(
      resolveMcpIdentity(req({ "x-aimock-context": "hc" }, "/mcp?testId=t&context=100%")),
    );
    expect(r.identity).toMatchObject({ testId: "t", context: "hc" });
    expect(r.fellBack).toEqual({ testId: false, context: true });
  });

  it("a cleanly decoded query value next to a header does not set fellBack", () => {
    const r = resolved(
      resolveMcpIdentity(
        req({ "x-test-id": "h", "x-aimock-context": "hc" }, "/mcp?testId=q%20v&context=c"),
      ),
    );
    expect(r.identity).toMatchObject({ testId: "h", context: "hc" });
    expect(r.fellBack).toEqual({ testId: false, context: false });
  });

  it("a ?testId= value that is not valid percent-encoding sets fellBack", () => {
    const r = resolved(resolveMcpIdentity(req({}, "/mcp?testId=50%")));
    expect(r.identity.testId).toBe("50%");
    expect(r.fellBack).toEqual({ testId: true, context: false });
  });

  it("an invalid ?undeclared= error carries the raw (undecoded) value", () => {
    const r = rejected(resolveMcpIdentity(req({}, "/mcp?undeclared=no%70e")));
    expect(r.error).toEqual({
      code: "MCP_INVALID_UNDECLARED",
      status: 400,
      field: "undeclared",
      source: "query",
      raw: "no%70e",
      message: 'Invalid ?undeclared= query parameter value "no%70e": expected allow or deny',
    });
  });
});

describe("resolveMcpIdentity: the MCP_INVALID_UNDECLARED message is bounded and quoted", () => {
  it("echoes the value the way `echo` does, at most MCP_FAKES_ECHO_LIMIT chars in all", () => {
    const pair = "\u{1F600}";
    const values = [
      "y".repeat(50_000),
      "y".repeat(MCP_FAKES_ECHO_LIMIT - 2),
      "y".repeat(MCP_FAKES_ECHO_LIMIT - 1),
      "y".repeat(MCP_FAKES_ECHO_LIMIT),
      ...Array.from({ length: 6 }, (_, i) => "y".repeat(170 + i) + pair.repeat(40)),
    ];
    for (const value of values) {
      for (const r of [
        resolveMcpIdentity(req({ "x-aimock-mcp-undeclared": value })),
        resolveMcpIdentity(req({}, `/mcp?undeclared=${encodeURIComponent(value)}`)),
      ]) {
        const { error } = rejected(r);
        if (error.code !== "MCP_INVALID_UNDECLARED") throw new Error(error.code);
        const sent = error.source === "header" ? value : encodeURIComponent(value);
        const echoed = echo(sent);
        expect(echoed.length).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
        expect(error.raw).toBe(cutText(sent));
        const label =
          error.source === "header"
            ? "X-AIMock-MCP-Undeclared header"
            : "?undeclared= query parameter";
        expect(error.message).toBe(`Invalid ${label} value ${echoed}: expected allow or deny`);
      }
    }
  });

  it("escapes a quote in the echoed value", () => {
    const { error } = rejected(resolveMcpIdentity(req({ "x-aimock-mcp-undeclared": 'de"ny' })));
    expect(error.message).toBe(
      'Invalid X-AIMock-MCP-Undeclared header value "de\\"ny": expected allow or deny',
    );
  });
});

describe("resolveMcpIdentity: bad percent-encoding is never silent", () => {
  it("an ?undeclared= value that is not valid percent-encoding says so in the error", () => {
    for (const value of ["deny%", "allow%E2%80", "%"]) {
      const r = rejected(resolveMcpIdentity(req({}, `/mcp?undeclared=${value}`)));
      expect(r.error).toEqual({
        code: "MCP_INVALID_UNDECLARED",
        status: 400,
        field: "undeclared",
        source: "query",
        raw: value,
        message: `Invalid ?undeclared= query parameter value ${JSON.stringify(value)} (not valid percent-encoding): expected allow or deny`,
      });
    }
  });

  it("a valid percent-encoded ?undeclared= value does not get the encoding note", () => {
    const r = rejected(resolveMcpIdentity(req({}, "/mcp?undeclared=no%70e")));
    expect(r.error.message).not.toContain("percent-encoding");
  });

  it("a query name that is not valid percent-encoding matches no field and is counted", () => {
    const r = resolve(req({}, "/mcp?test%Id=zz&testId=q&cont%ext=c"));
    expect(r.identity.testId).toBe("q");
    expect(r.identity.context).toBeNull();
    expect(r.undecodedQueryNames).toBe(2);
  });

  it("a request whose query names all decode carries no undecodedQueryNames", () => {
    const r = resolve(req({}, "/mcp?test%49d=x"));
    expect(r.identity.testId).toBe("x");
    expect("undecodedQueryNames" in r).toBe(false);
  });
});

describe("resolveMcpIdentity: the MCP_INVALID_UNDECLARED raw value is bounded", () => {
  it("raw is the value as sent, unquoted and cut to at most MCP_FAKES_ECHO_LIMIT chars", () => {
    const value = "y".repeat(50_000);
    for (const [r, sent] of [
      [resolveMcpIdentity(req({ "x-aimock-mcp-undeclared": value })), value],
      [resolveMcpIdentity(req({}, `/mcp?undeclared=${value}`)), value],
    ] as const) {
      const { error } = rejected(r);
      if (error.code !== "MCP_INVALID_UNDECLARED") throw new Error(error.code);
      expect(error.raw.length).toBeLessThanOrEqual(MCP_FAKES_ECHO_LIMIT);
      expect(error.raw).toBe(cutText(sent));
      expect(error.message).toContain(` value ${echo(sent)}: `);
    }
  });
});
