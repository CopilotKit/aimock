import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_KEY,
  MIN_SECRET_LENGTH,
  REDACTED,
  RecordUnsafeError,
  decodeUrlComponent,
  knownSecrets,
  sanitizeRecording,
  scrubUrl,
  validateSecretValues,
} from "../record-sanitize.js";

// Credential-key branches for these tests: `/recorded…` and any `…/_meta…`.
const branch = (pointer: string) =>
  pointer === "/recorded" || pointer.startsWith("/recorded/") || /\/_meta(?:\/|$)/.test(pointer);

const SECRET = "s3cr3t-value-123";

function unsafeReason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof RecordUnsafeError) return err.reason;
    throw err;
  }
  return undefined;
}

describe("record-sanitize constants", () => {
  it("exports the shared credential-key regex, marker and minimum length", () => {
    expect(CREDENTIAL_KEY.test("Authorization")).toBe(true);
    expect(CREDENTIAL_KEY.test("x-api-key")).toBe(true);
    expect(CREDENTIAL_KEY.test("location")).toBe(false);
    expect(REDACTED).toBe("[REDACTED]");
    expect(MIN_SECRET_LENGTH).toBe(8);
  });

  it("RecordUnsafeError never carries a value", () => {
    const err = new RecordUnsafeError("secret-remains");
    expect(err.message).toBe("unsafe recording: secret-remains");
    expect(err.name).toBe("RecordUnsafeError");
  });

  it("decodeUrlComponent tolerates malformed escapes and keeps separators", () => {
    expect(decodeUrlComponent("a%20b")).toBe("a b");
    expect(decodeUrlComponent("a+b&c")).toBe("a+b&c");
    expect(decodeUrlComponent("%E0%A4%A")).toBeTypeOf("string");
  });
});

describe("S2 known secrets", () => {
  it("(a) takes the Bearer token and the whole header value", () => {
    const secrets = knownSecrets({
      headers: { authorization: "Bearer tok-abcdefgh-1234" },
      upstreamUrl: "http://h/mcp",
      secretValues: [],
    });
    expect(secrets).toContain("tok-abcdefgh-1234");
    expect(secrets).toContain("Bearer tok-abcdefgh-1234");
  });

  it("(a) takes the decoded Basic user and password", () => {
    const encoded = Buffer.from("alice-user:hunter2-password").toString("base64");
    const secrets = knownSecrets({
      headers: { Authorization: `Basic ${encoded}` },
      upstreamUrl: "http://h/mcp",
      secretValues: [],
    });
    expect(secrets).toContain(encoded);
    expect(secrets).toContain("alice-user");
    expect(secrets).toContain("hunter2-password");
  });

  it("(a) takes recognized API-key headers and ignores other headers", () => {
    const secrets = knownSecrets({
      headers: {
        "x-api-key": "key-value-123456",
        "x-goog-api-key": "goog-value-1234",
        accept: "application/json",
      },
      upstreamUrl: "http://h/mcp",
      secretValues: [],
    });
    expect(secrets).toContain("key-value-123456");
    expect(secrets).toContain("goog-value-1234");
    expect(secrets).not.toContain("application/json");
  });

  it("(b) takes the configured upstreamAuth value and its parts", () => {
    const secrets = knownSecrets({
      headers: {},
      upstreamAuth: { name: "Authorization", value: "Bearer upstream-token-99" },
      upstreamUrl: "http://h/mcp",
      secretValues: [],
    });
    expect(secrets).toContain("upstream-token-99");
  });

  it("(c) takes the userinfo and every query value of the upstream URL, never the path", () => {
    const secrets = knownSecrets({
      headers: {},
      upstreamUrl:
        "http://url-user-1:url-pass-12@h/servers/weather-server/mcp?region=eu-west-1&key=query-secret-1",
      secretValues: [],
    });
    expect(secrets).toContain("url-user-1");
    expect(secrets).toContain("url-pass-12");
    expect(secrets).toContain("query-secret-1");
    expect(secrets).not.toContain("weather-server");
  });

  it("(a)-(c) ignore values shorter than 8 characters", () => {
    const secrets = knownSecrets({
      headers: { authorization: "Bearer abcd" },
      upstreamUrl: "http://u:p@h/mcp?k=short",
      secretValues: [],
    });
    // The whole header value (11 characters) still qualifies; its short parts do not.
    expect(secrets).toEqual(["Bearer abcd"]);
  });

  it("(d) includes secretValues, longest first, de-duplicated", () => {
    const secrets = knownSecrets({
      headers: { authorization: `Bearer ${SECRET}` },
      upstreamUrl: "http://h/mcp",
      secretValues: [SECRET, "another-secret-value-long"],
    });
    expect(secrets.filter((s) => s === SECRET)).toHaveLength(1);
    for (let i = 1; i < secrets.length; i++) {
      expect(secrets[i - 1].length).toBeGreaterThanOrEqual(secrets[i].length);
    }
  });

  it("(d) start check rejects an entry shorter than 8 characters, never naming it", () => {
    expect(() => validateSecretValues(["abcd"])).toThrow(
      "record.secretValues entry shorter than 8 characters",
    );
    try {
      validateSecretValues(["abcd"]);
    } catch (err) {
      expect((err as Error).message).not.toContain("abcd");
    }
    expect(() => validateSecretValues([SECRET])).not.toThrow();
    expect(() => validateSecretValues([])).not.toThrow();
  });

  it("replaces each occurrence with [REDACTED] and names the pointer, never the value", () => {
    const { value, warnings } = sanitizeRecording(
      { calls: [{ result: { content: [{ type: "text", text: `a ${SECRET} b ${SECRET}` }] } }] },
      [SECRET],
      branch,
    );
    expect(value.calls[0].result.content[0].text).toBe(`a ${REDACTED} b ${REDACTED}`);
    expect(warnings).toEqual(["/calls/0/result/content/0/text: redacted a known secret"]);
    expect(warnings.join("\n")).not.toContain(SECRET);
  });

  it("redacts a Bearer token, Basic credentials and URL secrets found in recorded strings", () => {
    const encoded = Buffer.from("alice-user:hunter2-password").toString("base64");
    const secrets = knownSecrets({
      headers: { authorization: `Basic ${encoded}`, "x-api-key": "bearer-ish-token-1" },
      upstreamUrl: "http://h/mcp?key=query-secret-1",
      secretValues: [SECRET],
    });
    const { value } = sanitizeRecording(
      {
        calls: [
          {
            result: {
              content: [
                { type: "text", text: "user alice-user pw hunter2-password" },
                { type: "text", text: "q query-secret-1 k bearer-ish-token-1 s " + SECRET },
              ],
            },
          },
        ],
      },
      secrets,
      branch,
    );
    const text = JSON.stringify(value);
    expect(text).not.toContain("alice-user");
    expect(text).not.toContain("hunter2-password");
    expect(text).not.toContain("query-secret-1");
    expect(text).not.toContain("bearer-ish-token-1");
    expect(text).not.toContain(SECRET);
  });

  // Each recorded text holds the secret in exactly one form, which only one
  // `secretForms` variant produces.
  it.each([
    ["lowercase-hex encoding", "pa/ss:word12", "pa%2fss%3aword12"],
    ["decoded base with + read as space", "pa+ss+word12", "pa ss word12"],
    ["encodeURIComponent with + for space", "pa ss(w)rd!*x", "pa+ss(w)rd!*x"],
    ["encodeURI encoding", "pa ss:word12", "pa%20ss:word12"],
    ["derived form of exactly 8 characters", "abc%20defg", "abc defg"],
  ])("redacts a secret seen only in its %s", (_name, secret, form) => {
    const { value, warnings } = sanitizeRecording({ text: `a ${form} b` }, [secret], branch);
    expect(value.text).toBe(`a ${REDACTED} b`);
    expect(warnings).toEqual(["/text: redacted a known secret"]);
  });

  it("drops a derived form shorter than 8 characters", () => {
    const { value, warnings } = sanitizeRecording({ text: "a abc def b" }, ["abc%20def"], branch);
    expect(value.text).toBe("a abc def b");
    expect(warnings).toEqual([]);
  });

  it("a 4-character header token is ignored (not redacted anywhere)", () => {
    const secrets = knownSecrets({
      headers: { authorization: "Bearer abcd" },
      upstreamUrl: "http://h/mcp",
      secretValues: [],
    });
    const { value, warnings } = sanitizeRecording({ text: "abcd abcd" }, secrets, branch);
    expect(value.text).toBe("abcd abcd");
    expect(warnings).toEqual([]);
  });
});

describe("S3 URLs", () => {
  const hasSecret = (s: string) => s.includes(SECRET);
  const onPathSecret = (): never => {
    throw new RecordUnsafeError("secret-in-path");
  };

  it("leaves non-URLs and clean URLs byte-for-byte intact", () => {
    expect(scrubUrl("not a url", hasSecret, onPathSecret)).toBe("not a url");
    expect(scrubUrl("http://h/servers/weather-server/mcp", hasSecret, onPathSecret)).toBe(
      "http://h/servers/weather-server/mcp",
    );
  });

  it("removes userinfo", () => {
    expect(scrubUrl("http://u:p@h/x", hasSecret, onPathSecret)).toBe("http://h/x");
  });

  it("removes query params with a credential key or a secret value", () => {
    expect(scrubUrl(`http://h/x?api_key=zzz&keep=1&other=${SECRET}`, hasSecret, onPathSecret)).toBe(
      "http://h/x?keep=1",
    );
  });

  it("removes a fragment that holds a secret", () => {
    expect(scrubUrl(`http://h/x#${SECRET}`, hasSecret, onPathSecret)).toBe("http://h/x");
    expect(scrubUrl("http://h/x#token=abc", hasSecret, onPathSecret)).toBe("http://h/x");
    expect(scrubUrl("http://h/x#section", hasSecret, onPathSecret)).toBe("http://h/x#section");
  });

  it("calls onPathSecret for a secret in the decoded path", () => {
    expect(
      unsafeReason(() =>
        scrubUrl(`http://h/a/${encodeURIComponent(SECRET)}/b`, hasSecret, onPathSecret),
      ),
    ).toBe("secret-in-path");
  });

  it("sanitizeRecording scrubs URL strings and keeps a name-only path", () => {
    const { value, warnings } = sanitizeRecording(
      {
        recorded: { upstream: "http://h/servers/weather-server/mcp" },
        calls: [{ result: { content: [{ type: "text", text: "http://u:p@h/x?token=a&keep=1" }] } }],
      },
      [SECRET],
      branch,
    );
    expect(value.recorded.upstream).toBe("http://h/servers/weather-server/mcp");
    expect(value.calls[0].result.content[0].text).toBe("http://h/x?keep=1");
    expect(warnings).toEqual(["/calls/0/result/content/0/text: removed credentials from a URL"]);
  });

  it("S6: a secret in a URL path throws RecordUnsafeError(secret-in-path)", () => {
    expect(
      unsafeReason(() => sanitizeRecording({ text: `http://h/${SECRET}/mcp` }, [SECRET], branch)),
    ).toBe("secret-in-path");
  });
});

describe("S4 credential-shaped keys", () => {
  it("removes them inside recorded and any _meta; keeps them in args and result.content", () => {
    const input = {
      recorded: { upstream: "http://h/mcp", authorization: "x", nested: { "X-API-Key": "y" } },
      calls: [
        {
          args: { authorization: "schema-prop", token: "t" },
          result: {
            _meta: { password: "p", keep: 1 },
            content: [{ type: "text", text: "hi", secret: "kept" }],
          },
          _meta: { cookie: "c" },
        },
      ],
    };
    const { value } = sanitizeRecording(input, [], branch);
    expect(value.recorded).toEqual({ upstream: "http://h/mcp", nested: {} });
    expect(value.calls[0].args).toEqual({ authorization: "schema-prop", token: "t" });
    expect(value.calls[0].result._meta).toEqual({ keep: 1 });
    expect(value.calls[0].result.content[0]).toEqual({ type: "text", text: "hi", secret: "kept" });
    expect(value.calls[0]._meta).toEqual({});
  });

  it("does not mutate its input", () => {
    const input = { recorded: { authorization: "x" }, text: SECRET };
    const before = JSON.stringify(input);
    sanitizeRecording(input, [SECRET], branch);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps a __proto__ key as an own data property", () => {
    const input = JSON.parse('{"args":{"__proto__":{"a":1}}}') as { args: object };
    const { value } = sanitizeRecording(input, [], branch);
    expect(Object.hasOwn(value.args, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(value.args)).toBe(Object.prototype);
  });
});

describe("S6 fail closed", () => {
  it("throws secret-remains when a secret is left anywhere (a key name)", () => {
    expect(
      unsafeReason(() => sanitizeRecording({ args: { [`k-${SECRET}`]: 1 } }, [SECRET], branch)),
    ).toBe("secret-remains");
  });

  it("does not throw once every occurrence is redacted", () => {
    expect(() => sanitizeRecording({ a: [SECRET, { b: SECRET }] }, [SECRET], branch)).not.toThrow();
  });
});

describe("S7 pattern warnings", () => {
  const cases: [string, string][] = [
    ["sk-proj-abcdefghijklmnop1234", "OpenAI API key"],
    ["sk-ant-api03-abcdefghijklmnop", "Anthropic API key"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "GitHub token"],
    ["github_pat_11ABCDEFG0123456789_abcdefghij", "GitHub token"],
    ["xoxb-123456789012-abcdefghij", "Slack token"],
    ["AKIAABCDEFGHIJKLMNOP", "AWS access key"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "JWT"],
  ];
  for (const [token, kind] of cases) {
    it(`warns on ${kind} without redacting`, () => {
      const { value, warnings } = sanitizeRecording({ text: `see ${token} here` }, [], branch);
      expect(value.text).toBe(`see ${token} here`);
      expect(warnings).toEqual([`/text: looks like a ${kind} token`]);
      expect(warnings.join("\n")).not.toContain(token);
    });
  }

  it("does not warn on ordinary text", () => {
    const { warnings } = sanitizeRecording(
      { text: "risk-free task-list AKIA short eyJ.only" },
      [],
      branch,
    );
    expect(warnings).toEqual([]);
  });
});
