import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { evaluateChaos } from "../chaos.js";
import { createServer, type ServerInstance } from "../server.js";
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
      "x-llmock-chaos-malformed": "0",
      "x-llmock-chaos-disconnect": "1.0",
    };
    const result = evaluateChaos(fixture, undefined, headers);
    expect(result).toBe("disconnect");
  });

  it("header drop overrides everything", () => {
    const headers: http.IncomingHttpHeaders = {
      "x-llmock-chaos-drop": "1.0",
    };
    const result = evaluateChaos(null, undefined, headers);
    expect(result).toBe("drop");
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
  it("drops request when X-LLMock-Chaos-Drop header is 1.0", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello" }, response: { content: "Hi there" } },
    ];
    instance = await createServer(fixtures);

    const res = await httpPost(`${instance.url}/v1/chat/completions`, chatRequest("hello"), {
      "X-LLMock-Chaos-Drop": "1.0",
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
