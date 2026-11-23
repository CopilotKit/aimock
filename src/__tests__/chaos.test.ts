import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import {
  applyChaosAction,
  evaluateChaos,
  parseChaosNumber,
  resolveChaosLatencyMs,
} from "../chaos.js";
import { createServer, type ServerInstance } from "../server.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import { LLMock } from "../llmock.js";
import type { Fixture, ChatCompletionRequest } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: object,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", (err) => {
      // Connection reset/destroyed by chaos disconnect — treat as error
      reject(err);
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

function chatRequest(userContent: string): ChatCompletionRequest {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: userContent }],
  };
}

// ---------------------------------------------------------------------------
// Unit tests: evaluateChaos
// ---------------------------------------------------------------------------

describe("evaluateChaos", () => {
  it("returns null when no rates are set", () => {
    const result = evaluateChaos(null, undefined, undefined);
    expect(result).toBeNull();
  });

  it("returns null when all rates are 0", () => {
    const result = evaluateChaos(
      null,
      { dropRate: 0, malformedRate: 0, disconnectRate: 0 },
      undefined,
    );
    expect(result).toBeNull();
  });

  it('returns "drop" when dropRate is 1.0', () => {
    const result = evaluateChaos(null, { dropRate: 1.0 }, undefined);
    expect(result).toBe("drop");
  });

  it('returns "malformed" when malformedRate is 1.0', () => {
    const result = evaluateChaos(null, { malformedRate: 1.0 }, undefined);
    expect(result).toBe("malformed");
  });

  it('returns "disconnect" when disconnectRate is 1.0', () => {
    const result = evaluateChaos(null, { disconnectRate: 1.0 }, undefined);
    expect(result).toBe("disconnect");
  });

  it("checks drop before malformed before disconnect", () => {
    const result = evaluateChaos(
      null,
      { dropRate: 1.0, malformedRate: 1.0, disconnectRate: 1.0 },
      undefined,
    );
    expect(result).toBe("drop");
  });

  it("fixture chaos overrides server defaults", () => {
    const fixture: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "hi" },
      chaos: { malformedRate: 1.0 },
    };
    // Server says drop, fixture says malformed — fixture wins
    const result = evaluateChaos(fixture, { dropRate: 0, malformedRate: 0 }, undefined);
    expect(result).toBe("malformed");
  });

  it("header overrides fixture and server defaults", () => {
    const fixture: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "hi" },
      chaos: { malformedRate: 1.0 },
    };
    // Fixture says malformed, header says disconnect
    const headers: http.IncomingHttpHeaders = {
      "x-aimock-chaos-malformed": "0",
      "x-aimock-chaos-disconnect": "1.0",
    };
    const result = evaluateChaos(fixture, undefined, headers);
    expect(result).toBe("disconnect");
  });

  it("header drop overrides everything", () => {
    const headers: http.IncomingHttpHeaders = {
      "x-aimock-chaos-drop": "1.0",
    };
    const result = evaluateChaos(null, undefined, headers);
    expect(result).toBe("drop");
  });

  it("rejects a fixture rate > 1 rather than clamping it to 1.0", () => {
    // dropRate 5.0 is out of range: rejected outright, NOT clamped to 1.0.
    // Nothing else sets dropRate, so no chaos fires at all.
    const fixture: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "hi" },
      chaos: { dropRate: 5.0 },
    };
    const logger = { warn: vi.fn() };
    for (let i = 0; i < 20; i++) {
      const result = evaluateChaos(fixture, undefined, undefined, logger as never);
      expect(result).toBeNull();
    }
    expect(logger.warn.mock.calls[0]?.[0]).toContain("rejected dropRate value 5");
  });

  it("rejects a negative fixture rate rather than clamping it to 0", () => {
    const fixture: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "hi" },
      chaos: { dropRate: -1.0 },
    };
    const logger = { warn: vi.fn() };
    for (let i = 0; i < 50; i++) {
      expect(evaluateChaos(fixture, undefined, undefined, logger as never)).toBeNull();
    }
    expect(logger.warn.mock.calls[0]?.[0]).toContain("rejected dropRate value -1");
  });

  it("a rejected fixture value falls through to the server default", () => {
    // The fixture's out-of-range value is not applied AND not clamped — the
    // server default below it is what takes effect.
    const fixture: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "hi" },
      chaos: { dropRate: 99 },
    };
    const result = evaluateChaos(fixture, { malformedRate: 1.0 }, undefined);
    expect(result).toBe("malformed");
  });

  it("rejects an out-of-range server default rather than clamping it", () => {
    const logger = { warn: vi.fn() };
    for (let i = 0; i < 20; i++) {
      expect(evaluateChaos(null, { dropRate: 7 }, undefined, logger as never)).toBeNull();
    }
    expect(logger.warn.mock.calls[0]?.[0]).toContain("rejected dropRate value 7");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: one parser, one policy — for headers, fixtures and server config
// ---------------------------------------------------------------------------

describe("parseChaosNumber", () => {
  it("accepts in-range numbers and numeric strings", () => {
    expect(parseChaosNumber(0.5, 1)).toBe(0.5);
    expect(parseChaosNumber("0.5", 1)).toBe(0.5);
    expect(parseChaosNumber(" 500 ", 30000)).toBe(500);
    expect(parseChaosNumber(0, 1)).toBe(0);
    expect(parseChaosNumber(1, 1)).toBe(1);
  });

  it("rejects trailing garbage instead of taking the numeric prefix", () => {
    // parseFloat("0.5abc") would silently return 0.5 — Number() is a full parse.
    expect(parseChaosNumber("0.5abc", 1)).toBeUndefined();
    expect(parseChaosNumber("500abc", 30000)).toBeUndefined();
    expect(parseChaosNumber("banana", 1)).toBeUndefined();
    expect(parseChaosNumber("", 1)).toBeUndefined();
  });

  it("rejects non-finite values", () => {
    expect(parseChaosNumber("Infinity", 30000)).toBeUndefined();
    expect(parseChaosNumber(Infinity, 30000)).toBeUndefined();
    expect(parseChaosNumber(NaN, 1)).toBeUndefined();
  });

  it("rejects out-of-range values rather than clamping them", () => {
    expect(parseChaosNumber(2, 1)).toBeUndefined();
    expect(parseChaosNumber(-1, 1)).toBeUndefined();
    expect(parseChaosNumber(99999999, 30000)).toBeUndefined();
  });

  it("rejects values that are not numbers or strings", () => {
    expect(parseChaosNumber(undefined, 1)).toBeUndefined();
    expect(parseChaosNumber(null, 1)).toBeUndefined();
    expect(parseChaosNumber(true, 1)).toBeUndefined();
    expect(parseChaosNumber({}, 1)).toBeUndefined();
  });
});

describe("evaluateChaos — header value parsing and validation", () => {
  it("ignores NaN header value (e.g., 'banana') and does not trigger chaos", () => {
    const headers: http.IncomingHttpHeaders = {
      "x-aimock-chaos-drop": "banana",
    };
    for (let i = 0; i < 20; i++) {
      const result = evaluateChaos(null, undefined, headers);
      expect(result).toBeNull();
    }
  });

  it("honours the first value of an ARRAY-valued repeated header", () => {
    // Node models a repeated header as string[]; `resolveTestId` takes [0] and
    // so does chaos. Previously the array was silently dropped.
    const headers: http.IncomingHttpHeaders = {
      "x-aimock-chaos-drop": ["1", "1"],
    };
    for (let i = 0; i < 20; i++) {
      expect(evaluateChaos(null, undefined, headers)).toBe("drop");
    }
    expect(resolveChaosLatencyMs(null, undefined, { "x-aimock-chaos-latency": ["500", "0"] })).toBe(
      500,
    );
  });

  it("honours the first value of a comma-folded repeated header", () => {
    // Node folds most repeated headers into one comma-joined string.
    expect(resolveChaosLatencyMs(null, undefined, { "x-aimock-chaos-latency": "500, 500" })).toBe(
      500,
    );
    expect(evaluateChaos(null, undefined, { "x-aimock-chaos-drop": "1, 0" })).toBe("drop");
  });

  it("rejects a header with trailing garbage instead of accepting its prefix", () => {
    const logger = { warn: vi.fn() };
    expect(
      resolveChaosLatencyMs(
        null,
        undefined,
        { "x-aimock-chaos-latency": "500abc" },
        logger as never,
      ),
    ).toBe(0);
    expect(logger.warn.mock.calls[0]?.[0]).toContain(
      'x-aimock-chaos-latency: rejected latencyMs value "500abc"',
    );
  });

  it("rejects an Infinity header value", () => {
    const logger = { warn: vi.fn() };
    expect(
      resolveChaosLatencyMs(
        null,
        undefined,
        { "x-aimock-chaos-latency": "Infinity" },
        logger as never,
      ),
    ).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("rejects an out-of-range header value rather than clamping it to 1.0", () => {
    const logger = { warn: vi.fn() };
    const headers: http.IncomingHttpHeaders = { "x-aimock-chaos-drop": "2.0" };
    for (let i = 0; i < 20; i++) {
      expect(evaluateChaos(null, undefined, headers, logger as never)).toBeNull();
    }
    expect(logger.warn.mock.calls[0]?.[0]).toContain(
      'x-aimock-chaos-drop: rejected dropRate value "2.0"',
    );
  });

  it("rejects a negative header value rather than clamping it to 0", () => {
    const headers: http.IncomingHttpHeaders = { "x-aimock-chaos-drop": "-1.0" };
    for (let i = 0; i < 50; i++) {
      expect(evaluateChaos(null, undefined, headers)).toBeNull();
    }
  });

  it("a rejected header falls through to the fixture value below it", () => {
    const fixture: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "hi" },
      chaos: { malformedRate: 1.0 },
    };
    const headers: http.IncomingHttpHeaders = { "x-aimock-chaos-malformed": "5.0" };
    expect(evaluateChaos(fixture, undefined, headers)).toBe("malformed");
  });

  it("rejects an out-of-range fixture latency rather than clamping it to 30000", () => {
    // The control API answers 400 for the same value; the fixture source uses
    // the same reject-never-clamp policy, warned rather than silently applied.
    const fixture: Fixture = {
      match: { userMessage: "slow" },
      response: { content: "slow" },
      chaos: { latencyMs: 99999999 },
    };
    const logger = { warn: vi.fn() };
    expect(resolveChaosLatencyMs(fixture, undefined, undefined, logger as never)).toBe(0);
    // The source names the OFFENDING FIXTURE, not just the kind of source:
    // the warning is latched per fixture, so a bare "fixture chaos" would leave
    // a reader with N fixtures no way to tell which one carries the typo (C17).
    const warned = String(logger.warn.mock.calls[0]?.[0]);
    expect(warned).toContain("rejected latencyMs value 99999999");
    expect(warned).toContain('fixture chaos { userMessage("slow") }');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: chaos through HTTP server
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

describe("chaos integration: server-level", () => {
  it("returns 500 for all requests when dropRate is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures, { chaos: { dropRate: 1.0 } });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(500);

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });
});

describe("chaos integration: fixture-level", () => {
  it("returns malformed JSON when fixture has malformedRate 1.0", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi there" },
        chaos: { malformedRate: 1.0 },
      },
    ];
    instance = await createServer(fixtures);

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(200);

    // Body should be malformed JSON — parsing should throw
    expect(() => JSON.parse(res.body)).toThrow();
    expect(res.body).toContain("malformed");
  });
});

describe("chaos integration: header override", () => {
  it("drops request when X-AIMock-Chaos-Drop header is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures);

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"), {
      "X-AIMock-Chaos-Drop": "1.0",
    });
    expect(res.status).toBe(500);

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });
});

describe("chaos integration: journal", () => {
  it("records chaosAction in the journal", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures, { chaos: { dropRate: 1.0 } });

    await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.chaosAction).toBe("drop");
  });
});

describe("chaos integration: rate 0 never fires", () => {
  it("all 20 requests succeed with rate 0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures, {
      chaos: { dropRate: 0, malformedRate: 0, disconnectRate: 0 },
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        httpPost(`${instance!.url}/v1/chat/completions`, chatRequest("hello")),
      ),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
    }
  });
});

describe("chaos integration: disconnect", () => {
  it("destroys connection when disconnectRate is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures, { chaos: { disconnectRate: 1.0 } });

    // The server destroys the connection — httpPost should reject
    await expect(
      httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello")),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Provider-specific chaos tests: Anthropic /v1/messages
// ---------------------------------------------------------------------------

function anthropicRequest(userContent: string): object {
  return {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: "user", content: userContent }],
  };
}

describe("chaos on Anthropic /v1/messages", () => {
  it("returns 500 when server-level drop rate is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi from Claude" } },
    ];
    instance = await createServer(fixtures, { chaos: { dropRate: 1.0 } });

    const res = await httpPost(`${instance.url}/v1/messages`, anthropicRequest("hello"));
    expect(res.status).toBe(500);

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });

  it("returns malformed JSON when server-level malformedRate is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi from Claude" } },
    ];
    instance = await createServer(fixtures, { chaos: { malformedRate: 1.0 } });

    const res = await httpPost(`${instance.url}/v1/messages`, anthropicRequest("hello"));
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.body)).toThrow();
    expect(res.body).toContain("malformed");
  });

  it("records chaosAction in journal for Anthropic requests", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi from Claude" } },
    ];
    instance = await createServer(fixtures, { chaos: { dropRate: 1.0 } });

    await httpPost(`${instance.url}/v1/messages`, anthropicRequest("hello"));

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.chaosAction).toBe("drop");
  });
});

// ---------------------------------------------------------------------------
// Provider-specific chaos tests: Gemini
// ---------------------------------------------------------------------------

function geminiRequest(userContent: string): object {
  return {
    contents: [{ role: "user", parts: [{ text: userContent }] }],
  };
}

describe("chaos on Gemini endpoint", () => {
  it("returns 500 when server-level drop rate is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi from Gemini" } },
    ];
    instance = await createServer(fixtures, { chaos: { dropRate: 1.0 } });

    const res = await httpPost(
      `${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`,
      geminiRequest("hello"),
    );
    expect(res.status).toBe(500);

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });

  it("returns malformed JSON when server-level malformedRate is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi from Gemini" } },
    ];
    instance = await createServer(fixtures, { chaos: { malformedRate: 1.0 } });

    const res = await httpPost(
      `${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`,
      geminiRequest("hello"),
    );
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.body)).toThrow();
    expect(res.body).toContain("malformed");
  });

  it("records chaosAction in journal for Gemini requests", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi from Gemini" } },
    ];
    instance = await createServer(fixtures, { chaos: { dropRate: 1.0 } });

    await httpPost(
      `${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`,
      geminiRequest("hello"),
    );

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.chaosAction).toBe("drop");
  });
});

// ---------------------------------------------------------------------------
// Provider-specific chaos tests: Bedrock
// ---------------------------------------------------------------------------

function bedrockRequest(userContent: string): object {
  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    messages: [{ role: "user", content: userContent }],
  };
}

describe("chaos on Bedrock endpoint", () => {
  it("returns 500 when server-level drop rate is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi from Bedrock" } },
    ];
    instance = await createServer(fixtures, { chaos: { dropRate: 1.0 } });

    const res = await httpPost(
      `${instance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/invoke`,
      bedrockRequest("hello"),
    );
    expect(res.status).toBe(500);

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });

  it("returns malformed JSON when server-level malformedRate is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi from Bedrock" } },
    ];
    instance = await createServer(fixtures, { chaos: { malformedRate: 1.0 } });

    const res = await httpPost(
      `${instance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/invoke`,
      bedrockRequest("hello"),
    );
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.body)).toThrow();
    expect(res.body).toContain("malformed");
  });

  it("records chaosAction in journal for Bedrock requests", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi from Bedrock" } },
    ];
    instance = await createServer(fixtures, { chaos: { dropRate: 1.0 } });

    await httpPost(
      `${instance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/invoke`,
      bedrockRequest("hello"),
    );

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.chaosAction).toBe("drop");
  });
});

// ---------------------------------------------------------------------------
// Fixture-level chaos on non-OpenAI provider
// ---------------------------------------------------------------------------

describe("fixture-level chaos on non-OpenAI provider", () => {
  it("applies fixture-level chaos only to matched Anthropic fixture", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "chaotic" },
        response: { content: "You will not see this" },
        chaos: { dropRate: 1.0 },
      },
      {
        match: { userMessage: "safe" },
        response: { content: "This is safe" },
      },
    ];
    instance = await createServer(fixtures);

    // "chaotic" fixture should be dropped
    const chaotic = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "chaotic" }],
    });
    expect(chaotic.status).toBe(500);
    const chaoticBody = JSON.parse(chaotic.body);
    expect(chaoticBody.error.code).toBe("chaos_drop");

    // "safe" fixture should succeed normally
    const safe = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "safe" }],
    });
    expect(safe.status).toBe(200);
    const safeBody = JSON.parse(safe.body);
    expect(safeBody.content[0].text).toBe("This is safe");
  });

  it("fixture-level malformedRate applies through Gemini endpoint", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "break-it" },
        response: { content: "Nope" },
        chaos: { malformedRate: 1.0 },
      },
    ];
    instance = await createServer(fixtures);

    const res = await httpPost(`${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "break-it" }] }],
    });
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.body)).toThrow();
    expect(res.body).toContain("malformed");
  });

  it("fixture-level dropRate applies through Bedrock endpoint", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "drop-me" },
        response: { content: "Never seen" },
        chaos: { dropRate: 1.0 },
      },
    ];
    instance = await createServer(fixtures);

    const res = await httpPost(
      `${instance.url}/model/anthropic.claude-3-haiku-20240307-v1:0/invoke`,
      {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1024,
        messages: [{ role: "user", content: "drop-me" }],
      },
    );
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });
});

// ---------------------------------------------------------------------------
// logLevel: "silent" — invalid chaos headers must not throw or output warnings
// ---------------------------------------------------------------------------

describe("chaos with logLevel silent: invalid header is ignored gracefully", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proceeds normally and does not throw when x-aimock-chaos-drop is not a number", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures, { logLevel: "silent" });

    // "notanumber" parses to NaN — should be silently ignored, request proceeds normally
    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"), {
      "X-AIMock-Chaos-Drop": "notanumber",
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe("Hi there");
  });

  it("does not call console.warn when evaluateChaos is called without a logger and header is invalid", () => {
    // When evaluateChaos is used directly (public API) without a logger, invalid header values
    // must not produce console.warn output — the caller has no logger to suppress it.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // "notanumber" parses to NaN — old code would call console.warn; new code uses logger?.warn (no-op)
    evaluateChaos(null, undefined, { "x-aimock-chaos-drop": "notanumber" });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: ONE validation policy across all three request-time
// sources, over real HTTP. Out-of-range/malformed input is rejected at every
// source — the same answer the control API has always given (400) — instead of
// being silently clamped (fixture/server) or half-parsed (headers).
// ---------------------------------------------------------------------------

describe("chaos integration: invalid input is rejected, never clamped", () => {
  it("rejects an out-of-range fixture latency instead of clamping it to 30000", async () => {
    // Before: 99999999 was silently clamped to 30000 and the request hung for
    // 30s. The default test timeout is the assertion.
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Hi there" },
        chaos: { latencyMs: 99999999 },
      },
    ];
    instance = await createServer(fixtures);

    const started = Date.now();
    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects a header with trailing garbage instead of taking its numeric prefix", async () => {
    // parseFloat("1abc") === 1 would have dropped every request.
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures);

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"), {
      "X-AIMock-Chaos-Drop": "1abc",
    });
    expect(res.status).toBe(200);
  });

  it("rejects an out-of-range header instead of clamping it to 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures);

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"), {
      "X-AIMock-Chaos-Drop": "2.0",
    });
    expect(res.status).toBe(200);
  });

  it("honours the first value of a repeated (comma-folded) header", async () => {
    // Node folds a repeated header into one comma-joined string; the first
    // value wins, exactly as `resolveTestId` takes the first array element.
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures);

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"), {
      "X-AIMock-Chaos-Drop": "1.0, 1.0",
    });
    expect(res.status).toBe(500);
  });

  it("the control API rejects the same out-of-range value with 400 (the policy's precedent)", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures);

    const res = await httpPost(`${instance.url}/__aimock/chaos`, { latencyMs: 99999999 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Chaos outcomes are journalled as they actually happened (F5). Each case here
// was RED before the fix: a phantom entry for a write that threw, `status: 0`
// for a disconnect on a committed response, a rolled `malformed` on the
// no-fixture non-proxied path that vanished into a 404, a fake request body on
// the fal chaos gates, and a startup warning that promised clamping the runtime
// never does.
// ---------------------------------------------------------------------------

async function httpGet(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("chaos journal entries record what actually happened", () => {
  it("applies and journals a rolled malformed on the no-fixture, non-proxied path", async () => {
    instance = await createServer([], { chaos: { malformedRate: 1 } });

    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatRequest("nothing matches"),
    );
    // Before: 404 "No fixture matched" — the rolled action was never applied.
    expect(res.status).toBe(200);
    expect(res.body).toBe("{malformed json: <<<chaos>>>");

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response).toMatchObject({
      status: 200,
      fixture: null,
      chaosAction: "malformed",
    });
  });

  it("journals body: null on both fal chaos gates instead of a fake request", async () => {
    instance = await createServer([], { chaos: { dropRate: 1 } });

    const general = await httpPost(
      `${instance.url}/fal/fal-ai/flux/dev`,
      { prompt: "x" },
      { "x-fal-target-host": "queue.fal.run" },
    );
    const queue = await httpGet(`${instance.url}/fal/queue/requests/abc/status`);
    expect(general.status).toBe(500);
    expect(queue.status).toBe(500);

    const entries = instance.journal.getAll();
    expect(entries.map((e) => e.body)).toEqual([null, null]);
    expect(entries.map((e) => e.response.chaosAction)).toEqual(["drop", "drop"]);
  });

  it("warns that an out-of-range chaos default is rejected, not clamped", async () => {
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args.join(" "));
    });
    try {
      instance = await createServer([], {
        logLevel: "warn",
        chaos: { dropRate: 2, latencyMs: 99999 },
      });
    } finally {
      warn.mockRestore();
    }
    const lines = warned.filter((l) => l.includes("Chaos "));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain("will be clamped");
      expect(line).toContain("rejected at runtime");
    }
  });

  it("disconnect on a committed response journals the status already sent", async () => {
    const journal = new Journal();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      applyChaosAction(
        "disconnect",
        res,
        null,
        journal,
        { method: "GET", path: "/committed", headers: {}, body: null },
        "internal",
        undefined,
        new Logger("silent"),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      await expect(httpGet(`http://127.0.0.1:${port}/committed`)).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    // Before: `status: 0`, claiming the client got no status line.
    expect(entries[0].response).toMatchObject({ status: 200, chaosAction: "disconnect" });
  });

  it("leaves no journal entry when the chaos write itself throws", () => {
    const journal = new Journal();
    const throwing = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writeHead() {
        throw new Error("ERR_STREAM_DESTROYED");
      },
      end() {},
      destroy() {},
      setHeader() {},
    } as unknown as http.ServerResponse;
    for (const action of ["drop", "malformed", "rateLimit"] as const) {
      expect(() =>
        applyChaosAction(
          action,
          throwing,
          null,
          journal,
          { method: "POST", path: "/x", headers: {}, body: null },
          "internal",
          undefined,
          new Logger("silent"),
        ),
      ).toThrow("ERR_STREAM_DESTROYED");
    }
    // Before: one phantom entry per action, journalled before the write.
    expect(journal.getAll()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// G4/G6: the startup chaos check and the no-fixture chaos gate.
// ---------------------------------------------------------------------------

describe("chaos startup validation uses the ONE chaos table", () => {
  it("warns at startup for a fractional latencyMs in the runtime's words", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      instance = await createServer([], { logLevel: "warn", chaos: { latencyMs: 250.5 } });
      const startup = warn.mock.calls.map((c) => c.join(" "));
      // Before: the hand-rolled `< 0 || > 30000` check said nothing for 250.5,
      // and the runtime then rejected the default on every request.
      const line = startup.find((l) => l.includes("latencyMs") && l.includes("250.5"));
      expect(line).toBeDefined();
      expect(line).toContain("must be a whole number of ms in [0,30000]");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns at startup for a NaN dropRate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      instance = await createServer([], { logLevel: "warn", chaos: { dropRate: NaN } });
      const startup = warn.mock.calls.map((c) => c.join(" "));
      expect(startup.some((l) => l.includes("dropRate") && l.includes("null"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("chaos no-fixture gate labels the journal source truthfully", () => {
  it("journals a malformed roll with no fixture and no proxy as source internal", async () => {
    instance = await createServer([], { chaos: { malformedRate: 1.0 } });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.body)).toThrow();

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    // Before: `source: "proxy"` on a request nothing ever proxied.
    expect(entries[0].response).toMatchObject({ chaosAction: "malformed", source: "internal" });
  });

  it("journals a drop roll with no fixture and no proxy as source internal", async () => {
    instance = await createServer([], { chaos: { dropRate: 1.0 } });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(500);

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    // Same mislabel on the drop/disconnect/rateLimit gate: nothing was proxied.
    expect(entries[0].response).toMatchObject({ chaosAction: "drop", source: "internal" });
  });

  it("journals a drop roll as source internal when record mode has no upstream for the chat provider", async () => {
    // Record mode is ON, but only for anthropic — `/v1/chat/completions` maps
    // to the openai key, which has no upstream, so the miss is aimock's own 404.
    instance = await createServer([], {
      record: { providers: { anthropic: "http://127.0.0.1:9/" } },
    });

    // Same miss, no chaos: answered internally, never forwarded.
    const miss = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(miss.status).toBe(404);

    const chaosHeaders = { "X-Test-Id": "source-no-upstream" };
    await httpPost(`${instance.url}/__aimock/chaos`, { dropRate: 1 }, chaosHeaders);
    const res = await httpPost(
      `${instance.url}/v1/chat/completions`,
      chatRequest("hello"),
      chaosHeaders,
    );
    expect(res.status).toBe(500);

    const entries = instance.journal.getAll().filter((e) => e.response.chaosAction === "drop");
    expect(entries).toHaveLength(1);
    // Before: "proxy" because ANY record config was present — the provider
    // key was never checked against `record.providers`.
    expect(entries[0].response).toMatchObject({ chaosAction: "drop", source: "internal" });
  });

  it("journals a drop roll as source proxy when record mode has an upstream for the chat provider", async () => {
    instance = await createServer([], {
      chaos: { dropRate: 1.0 },
      record: { providers: { openai: "http://127.0.0.1:9/" } },
    });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(500);

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response).toMatchObject({ chaosAction: "drop", source: "proxy" });
  });

  it("journals a drop roll as source internal under strict mode even with a proxy upstream", async () => {
    // Strict refuses every miss before the record gate — nothing is ever
    // proxied, so a chaos fault on the miss is aimock's own answer.
    instance = await createServer([], {
      strict: true,
      chaos: { dropRate: 1.0 },
      record: { providers: { openai: "http://127.0.0.1:9/" } },
    });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(500);

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response).toMatchObject({ chaosAction: "drop", source: "internal" });
  });

  it("honours a per-request X-AIMock-Strict header in the no-fixture source label", async () => {
    instance = await createServer([], {
      chaos: { dropRate: 1.0 },
      record: { providers: { openai: "http://127.0.0.1:9/" } },
    });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"), {
      "X-AIMock-Strict": "true",
    });
    expect(res.status).toBe(500);

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response).toMatchObject({ chaosAction: "drop", source: "internal" });
  });

  it("applies a malformed roll on a strict-mode miss as source internal even with a proxy upstream", async () => {
    // Strict refuses the miss before the record gate, so the malformed body is
    // aimock's own answer. The malformed gate used to defer to the proxy path
    // whenever ANY upstream existed, and strict then answered 503 instead —
    // the rolled fault was never applied or journalled.
    instance = await createServer([], {
      strict: true,
      chaos: { malformedRate: 1.0 },
      record: { providers: { openai: "http://127.0.0.1:9/" } },
    });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(200);
    expect(res.body).toBe("{malformed json: <<<chaos>>>");

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response).toMatchObject({ chaosAction: "malformed", source: "internal" });
  });
});

// ---------------------------------------------------------------------------
// A one-shot error claimed BEFORE a reset must not be re-armed AFTER it. The
// chat handler claims at selection and releases on every non-serving exit
// (client gone mid-latency, terminal chaos action, malformed). If the queue is
// cleared between the claim and the release, the release used to unshift the
// stale injection into the freshly cleared array — so the FIRST request of the
// next test, which registered nothing and reset first, got the previous
// test's 503. Reset is the isolation barrier every parallel harness leans on.
// ---------------------------------------------------------------------------
describe("chaos: a one-shot claimed before a reset is not re-armed into the reset queue", () => {
  let mock: LLMock | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = null;
    }
  });

  function chat(url: string, headers: Record<string, string> = {}, signal?: AbortSignal) {
    return fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(chatRequest("hello")),
      signal,
    });
  }

  /**
   * Claim the one-shot with a request parked in the chaos-latency delay, run
   * `clear` while it is parked, then let the request leave WITHOUT being
   * served (client abort → release). Returns after the release has run.
   */
  async function claimThenClearThenRelease(url: string, clear: () => Promise<unknown> | unknown) {
    const ac = new AbortController();
    const inflight = chat(url, { "x-aimock-chaos-latency": "600" }, ac.signal).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await clear();
    ac.abort();
    await inflight;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it("LLMock.reset() between claim and release: the next request is served normally", async () => {
    mock = new LLMock();
    await mock.start();
    mock.nextRequestError(503, { message: "injected" });

    await claimThenClearThenRelease(mock.url, () => mock!.reset());

    // Pre-fix: the release put the injection back into the reset array.
    expect(mock.getFixtures()).toHaveLength(0);
    mock.onMessage("hello", { content: "plain ok" });
    const next = await chat(mock.url);
    expect(next.status).toBe(200);
    expect((await next.json()).choices[0].message.content).toBe("plain ok");
  });

  it("POST /__aimock/reset between claim and release: the next request is served normally", async () => {
    mock = new LLMock();
    await mock.start();
    mock.nextRequestError(503, { message: "injected" });

    await claimThenClearThenRelease(mock.url, async () => {
      const res = await fetch(`${mock!.url}/__aimock/reset`, { method: "POST" });
      expect(res.status).toBe(200);
    });

    const listing = await (await fetch(`${mock.url}/__aimock/fixtures?include=fixtures`)).json();
    expect(listing.count).toBe(0);
    mock.onMessage("hello", { content: "plain ok" });
    expect((await chat(mock.url)).status).toBe(200);
  });

  it("LLMock.clearFixtures() and DELETE /__aimock/fixtures invalidate the claim the same way", async () => {
    mock = new LLMock();
    await mock.start();

    mock.nextRequestError(503, { message: "injected" });
    await claimThenClearThenRelease(mock.url, () => {
      mock!.clearFixtures();
    });
    expect(mock.getFixtures()).toHaveLength(0);

    mock.nextRequestError(503, { message: "injected" });
    await claimThenClearThenRelease(mock.url, async () => {
      const res = await fetch(`${mock!.url}/__aimock/fixtures`, { method: "DELETE" });
      expect(res.status).toBe(200);
    });
    expect(mock.getFixtures()).toHaveLength(0);

    mock.onMessage("hello", { content: "plain ok" });
    expect((await chat(mock.url)).status).toBe(200);
  });

  it("a one-shot queued AFTER the reset still releases and re-arms normally", async () => {
    // The guard must key on the claim's generation, not disable release: a
    // fresh one-shot claimed post-reset and dropped by chaos stays pending.
    mock = new LLMock();
    mock.onMessage("hello", { content: "plain ok" });
    await mock.start();
    await mock.reset();
    mock.onMessage("hello", { content: "plain ok" });
    mock.nextRequestError(503, { message: "injected" });

    await chat(mock.url, { "x-aimock-chaos-drop": "1" });
    const next = await chat(mock.url);
    expect(next.status).toBe(503);
    expect((await next.json()).error.message).toBe("injected");
    expect((await chat(mock.url)).status).toBe(200);
  });
});
