import type { IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { createServer } from "../server.js";
import { Logger } from "../logger.js";
import type { HandlerDefaults, MockServerOptions } from "../types.js";
import * as policy from "../response/policy.js";
import { captureHttp } from "./golden/harness.js";

afterEach(() => vi.restoreAllMocks());

function optionsWithPolicy(value: unknown, strict = false): MockServerOptions {
  const options: MockServerOptions = { port: 0, logLevel: "silent", strict };
  // Exercise untyped JavaScript callers without claiming an invalid value is typed.
  Reflect.set(options, "policy", value);
  return options;
}

async function openSurface(surface: "LLMock" | "createServer", options: MockServerOptions) {
  if (surface === "LLMock") {
    const mock = new LLMock(options);
    mock.addFixture({ match: { userMessage: "hello" }, response: { content: "ok" } });
    await mock.start();
    return { url: mock.url, close: () => mock.stop() };
  }
  const instance = await createServer(
    [{ match: { userMessage: "hello" }, response: { content: "ok" } }],
    options,
  );
  return {
    url: instance.url,
    defaults: instance.defaults,
    close: () =>
      new Promise<void>((resolve, reject) => {
        instance.server.close((error) => (error ? reject(error) : resolve()));
        instance.server.closeAllConnections();
      }),
  };
}

function completion(url: string, message = "hello", headers?: IncomingHttpHeaders) {
  return captureHttp(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(
        Object.entries(headers ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: message }] }),
  });
}

describe("real policy option warnings", () => {
  const invalid = [
    ["unknown", { unknown: "enforce" }, "Ignoring policy.unknown: unknown policy key."],
    [
      "boolean",
      { requiredHeaders: true },
      'Ignoring policy.requiredHeaders: expected "off" or "enforce".',
    ],
  ] as const;
  for (const surface of ["LLMock", "createServer"] as const) {
    it.each(invalid)(
      `${surface} warns and ignores %s even with silent logging`,
      async (id, value, warning) => {
        const warnings = vi.spyOn(console, "warn");
        const server = await openSurface(surface, optionsWithPolicy(value));
        try {
          const response = await completion(server.url);
          const observed = warnings.mock.calls.map((args) => args.join(" "));
          console.log(
            JSON.stringify({
              case: `${surface}-${id}`,
              status: response.status,
              warnings: observed,
            }),
          );
          expect(response.status).toBe(200);
          expect(response.body).toContain('"content":"ok"');
          expect(observed).toContain(`[aimock] ${warning}`);
        } finally {
          await server.close();
        }
      },
    );
  }

  it("LLMock constructor reports invalid options before start without changing the caller object", () => {
    const warnings = vi.spyOn(console, "warn");
    const options = optionsWithPolicy({ requiredHeaders: 1 });
    const original = Reflect.get(options, "policy");
    new LLMock(options);
    expect(warnings.mock.calls).toEqual([
      ["[aimock]", 'Ignoring policy.requiredHeaders: expected "off" or "enforce".'],
    ]);
    expect(Reflect.get(options, "policy")).toBe(original);
  });
});

describe("real default and strict controls", () => {
  for (const surface of ["LLMock", "createServer"] as const) {
    it(`${surface} keeps ordinary responses and mutable strict options independent of policy`, async () => {
      const warnings = vi.spyOn(console, "warn");
      const options = optionsWithPolicy({ requiredHeaders: "ENFORCE" });
      const server = await openSurface(surface, options);
      try {
        expect((await completion(server.url)).status).toBe(200);
        expect((await completion(server.url, "missing")).status).toBe(404);
        options.strict = true;
        expect((await completion(server.url, "missing")).status).toBe(503);
        expect(
          (await completion(server.url, "missing", { "x-aimock-strict": "false" })).status,
        ).toBe(404);
        expect(
          (await completion(server.url, "missing", { "x-aimock-strict": "invalid" })).status,
        ).toBe(503);
        expect(warnings.mock.calls).toEqual([]);
      } finally {
        await server.close();
      }
    });
  }
});

function defaults(value?: unknown, strict?: boolean): HandlerDefaults {
  const input: HandlerDefaults = {
    latency: 0,
    chunkSize: 20,
    replaySpeed: 1,
    logger: new Logger("warn"),
    strict,
  };
  if (value !== undefined) Reflect.set(input, "policy", value);
  return input;
}

describe("public policy parser and resolver contract", () => {
  it("matches exact keys and case-insensitive enum strings; rejects other values", () => {
    expect(typeof policy.parsePolicyEntry).toBe("function");
    expect(policy.parsePolicyEntry("requiredHeaders", "EnFoRcE")).toEqual({
      ok: true,
      key: "requiredHeaders",
      value: "enforce",
    });
    expect(policy.parsePolicyEntry("requiredHeaders", "OFF")).toEqual({
      ok: true,
      key: "requiredHeaders",
      value: "off",
    });
    for (const value of [true, false, 1, 0, "1", "", " off ", "unknown", null, undefined]) {
      expect(policy.parsePolicyEntry("requiredHeaders", value).ok).toBe(false);
    }
    expect(policy.parsePolicyEntry("RequiredHeaders", "enforce").ok).toBe(false);
  });

  it("ignores invalid object entries independently and warns for malformed containers", () => {
    expect(typeof policy.parsePolicy).toBe("function");
    const warnings: string[] = [];
    expect(
      policy.parsePolicy({ unknown: "enforce", requiredHeaders: "ENFORCE" }, (warning) =>
        warnings.push(warning),
      ),
    ).toEqual({ requiredHeaders: "enforce" });
    expect(warnings).toEqual(["Ignoring policy.unknown: unknown policy key."]);
    for (const value of [null, [], true, 1, "requiredHeaders=enforce"]) {
      const observed: string[] = [];
      expect(policy.parsePolicy(value, (warning) => observed.push(warning))).toEqual({});
      expect(observed).toEqual(["Ignoring policy: expected an object."]);
    }
    expect(
      policy.parsePolicy(undefined, () => {
        throw new Error("absent policy warned");
      }),
    ).toEqual({});
  });

  it("trims header entries and retains the last valid duplicate despite isolated failures", () => {
    expect(typeof policy.parsePolicyHeader).toBe("function");
    const warnings: string[] = [];
    expect(
      policy.parsePolicyHeader(
        {
          "x-aimock-policy":
            " requiredHeaders=EnFoRcE , unknown=off, malformed, requiredHeaders=off, requiredHeaders=invalid ",
        },
        (warning) => warnings.push(warning),
      ),
    ).toEqual({ requiredHeaders: "off" });
    expect(warnings).toEqual([
      "Ignoring policy.unknown: unknown policy key.",
      'Ignoring policy entry "malformed": expected key=value.',
      'Ignoring policy.requiredHeaders: expected "off" or "enforce".',
    ]);
    expect(
      policy.parsePolicyHeader(
        { "x-aimock-policy": ["requiredHeaders=invalid", "requiredHeaders=ENFORCE"] },
        () => {},
      ),
    ).toEqual({ requiredHeaders: "enforce" });
  });

  it("resolves off, server, header in order independently from the preserved strict bit", () => {
    expect(typeof policy.resolvePolicy).toBe("function");
    expect(policy.resolvePolicy(defaults())).toEqual({ strict: false, requiredHeaders: "off" });
    expect(policy.resolvePolicy(defaults(undefined, true))).toEqual({
      strict: true,
      requiredHeaders: "off",
    });
    expect(
      policy.resolvePolicy(defaults({ requiredHeaders: "enforce" }, true), {
        "x-aimock-strict": "false",
      }),
    ).toEqual({ strict: false, requiredHeaders: "enforce" });
    expect(
      policy.resolvePolicy(defaults({ requiredHeaders: "enforce" }, true), {
        "x-aimock-policy": "requiredHeaders=off",
      }),
    ).toEqual({ strict: true, requiredHeaders: "off" });
    expect(
      policy.resolvePolicy(defaults({ requiredHeaders: "off" }), {
        "x-aimock-policy": "requiredHeaders=enforce",
      }),
    ).toEqual({ strict: false, requiredHeaders: "enforce" });
    const warnings: string[] = [];
    expect(
      policy.resolvePolicy(
        defaults({ requiredHeaders: "enforce" }),
        { "x-aimock-policy": "requiredHeaders=invalid" },
        (warning) => warnings.push(warning),
      ),
    ).toEqual({ strict: false, requiredHeaders: "enforce" });
    expect(warnings).toEqual(['Ignoring policy.requiredHeaders: expected "off" or "enforce".']);
  });

  it("reads each strict/policy input once and freezes the resolved value", () => {
    expect(typeof policy.resolvePolicy).toBe("function");
    let strictReads = 0;
    let policyReads = 0;
    let headerReads = 0;
    const input = defaults();
    Object.defineProperties(input, {
      strict: {
        get: () => {
          strictReads++;
          return true;
        },
      },
      policy: {
        get: () => {
          policyReads++;
          return { requiredHeaders: "enforce" };
        },
      },
    });
    const headers: IncomingHttpHeaders = {};
    Object.defineProperty(headers, "x-aimock-policy", {
      get: () => {
        headerReads++;
        return "requiredHeaders=off";
      },
    });
    const resolved = policy.resolvePolicy(input, headers);
    expect(resolved).toEqual({ strict: true, requiredHeaders: "off" });
    expect([strictReads, policyReads, headerReads]).toEqual([1, 1, 1]);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("createServer carries current caller policy through HandlerDefaults without snapshotting options", async () => {
    expect(typeof policy.resolvePolicy).toBe("function");
    const options = optionsWithPolicy({ requiredHeaders: "enforce" });
    const server = await openSurface("createServer", options);
    try {
      expect(server.defaults).toBeDefined();
      if (!server.defaults) throw new Error("missing server defaults");
      expect(policy.resolvePolicy(server.defaults).requiredHeaders).toBe("enforce");
      Reflect.set(options, "policy", { requiredHeaders: "off" });
      expect(policy.resolvePolicy(server.defaults).requiredHeaders).toBe("off");
    } finally {
      await server.close();
    }
  });
});
