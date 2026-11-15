/**
 * The behaviour around chaos injection and stream pacing that must survive a
 * change to how either one draws. Everything here holds at the base commit.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { assertRecorderBypass, assertRecorderCapLifecycle } from "./chaos-integration-a93f6c.js";
import { PassThrough } from "node:stream";
import { evaluateChaos, applyChaos } from "../index.js";
import { calculateDelay, writeSSEStream } from "../sse-writer.js";
import { createServer, type ServerInstance } from "../server.js";
import { LLMock } from "../llmock.js";
import { createMetricsRegistry } from "../metrics.js";
import { Journal } from "../journal.js";
import type { ChatCompletionRequest, Fixture, SSEChunk } from "../types.js";

interface Probe {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(
  url: string,
  method: string,
  body: object | null,
  headers?: Record<string, string>,
): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

const post = (url: string, body: object, headers?: Record<string, string>) =>
  request(url, "POST", body, headers);

const get = (url: string, headers?: Record<string, string>) => request(url, "GET", null, headers);

function chat(text: string): ChatCompletionRequest {
  return { model: "gpt-4", messages: [{ role: "user", content: text }] };
}

function catchAll(): Fixture[] {
  return [{ match: { userMessage: /.*/ }, response: { content: "ok" } }];
}

function isMalformed(probe: Probe): boolean {
  try {
    JSON.parse(probe.body);
    return false;
  } catch {
    return true;
  }
}

const servers: ServerInstance[] = [];
const mocks: LLMock[] = [];

async function start(options: Record<string, unknown>, fixtures: Fixture[] = catchAll()) {
  const instance = await createServer(fixtures, options as never);
  servers.push(instance);
  return instance;
}

afterEach(async () => {
  while (mocks.length) {
    const mock = mocks.pop();
    if (mock) await mock.stop();
  }
  while (servers.length) {
    const instance = servers.pop();
    if (!instance) continue;
    await new Promise<void>((resolve) => instance.server.close(() => resolve()));
  }
});

describe("chaos rates on the completions route", () => {
  it("serves the fixture when no chaos is configured", async () => {
    const { url } = await start({});
    const res = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(res.status).toBe(200);
    expect(isMalformed(res)).toBe(false);
  });

  it("drops at rate 1", async () => {
    const { url } = await start({ chaos: { dropRate: 1 } });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe("chaos_drop");
  });

  it("never drops at rate 0", async () => {
    const { url } = await start({ chaos: { dropRate: 0 } });
    for (let i = 0; i < 8; i++) {
      expect((await post(`${url}/v1/chat/completions`, chat("hi"))).status).toBe(200);
    }
  });

  it("returns invalid JSON at malformed rate 1", async () => {
    const { url } = await start({ chaos: { malformedRate: 1 } });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(res.status).toBe(200);
    expect(isMalformed(res)).toBe(true);
  });

  it("never returns invalid JSON at malformed rate 0", async () => {
    const { url } = await start({ chaos: { malformedRate: 0 } });
    for (let i = 0; i < 8; i++) {
      expect(isMalformed(await post(`${url}/v1/chat/completions`, chat("hi")))).toBe(false);
    }
  });

  it("destroys the connection at disconnect rate 1", async () => {
    const { url } = await start({ chaos: { disconnectRate: 1 } });
    await expect(post(`${url}/v1/chat/completions`, chat("hi"))).rejects.toThrow();
  });

  it("never disconnects at rate 0", async () => {
    const { url } = await start({ chaos: { disconnectRate: 0 } });
    for (let i = 0; i < 8; i++) {
      expect((await post(`${url}/v1/chat/completions`, chat("hi"))).status).toBe(200);
    }
  });

  it("clamps a rate above 1 to always firing", async () => {
    const { url } = await start({ chaos: { dropRate: 5 } });
    expect((await post(`${url}/v1/chat/completions`, chat("hi"))).status).toBe(500);
  });

  it("clamps a negative rate to never firing", async () => {
    const { url } = await start({ chaos: { dropRate: -2 } });
    expect((await post(`${url}/v1/chat/completions`, chat("hi"))).status).toBe(200);
  });

  it("prefers drop over malformed when both are certain", async () => {
    const { url } = await start({ chaos: { dropRate: 1, malformedRate: 1 } });
    expect((await post(`${url}/v1/chat/completions`, chat("hi"))).status).toBe(500);
  });

  it("prefers malformed over disconnect when both are certain", async () => {
    const { url } = await start({ chaos: { malformedRate: 1, disconnectRate: 1 } });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(res.status).toBe(200);
    expect(isMalformed(res)).toBe(true);
  });
});

describe("chaos precedence", () => {
  it("a header rate overrides the server default", async () => {
    const { url } = await start({ chaos: { dropRate: 0 } });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"), {
      "x-aimock-chaos-drop": "1",
    });
    expect(res.status).toBe(500);
  });

  it("a header rate of 0 suppresses a server default of 1", async () => {
    const { url } = await start({ chaos: { dropRate: 1 } });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"), {
      "x-aimock-chaos-drop": "0",
    });
    expect(res.status).toBe(200);
  });

  it("a fixture rate overrides the server default", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: /.*/ }, response: { content: "ok" }, chaos: { dropRate: 1 } },
    ];
    const { url } = await start({ chaos: { dropRate: 0 } }, fixtures);
    expect((await post(`${url}/v1/chat/completions`, chat("hi"))).status).toBe(500);
  });

  it("a header rate beats a fixture rate", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: /.*/ }, response: { content: "ok" }, chaos: { dropRate: 1 } },
    ];
    const { url } = await start({}, fixtures);
    const res = await post(`${url}/v1/chat/completions`, chat("hi"), {
      "x-aimock-chaos-drop": "0",
    });
    expect(res.status).toBe(200);
  });

  it("clamps an out-of-range header rate", async () => {
    const { url } = await start({ chaos: { dropRate: 0 } });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"), {
      "x-aimock-chaos-drop": "9",
    });
    expect(res.status).toBe(500);
  });

  it("ignores an unparseable header rate", async () => {
    const { url } = await start({ chaos: { dropRate: 0 } });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"), {
      "x-aimock-chaos-drop": "not-a-number",
    });
    expect(res.status).toBe(200);
  });

  it("reads each kind from its own header", async () => {
    const malformed = await start({});
    expect(
      isMalformed(
        await post(`${malformed.url}/v1/chat/completions`, chat("hi"), {
          "x-aimock-chaos-malformed": "1",
        }),
      ),
    ).toBe(true);
    const disconnect = await start({});
    await expect(
      post(`${disconnect.url}/v1/chat/completions`, chat("hi"), {
        "x-aimock-chaos-disconnect": "1",
      }),
    ).rejects.toThrow();
  });
});

describe("chaos journal and metrics", () => {
  it("journals a drop with its action and source", async () => {
    const { url } = await start({ chaos: { dropRate: 1 } });
    await post(`${url}/v1/chat/completions`, chat("hi"));
    const entries = JSON.parse((await get(`${url}/__aimock/journal`)).body) as Array<{
      response: { status: number; chaosAction?: string; source?: string };
    }>;
    const entry = entries.find((e) => e.response.chaosAction === "drop");
    expect(entry).toBeDefined();
    expect(entry?.response.status).toBe(500);
    expect(entry?.response.source).toBe("fixture");
  });

  it("journals a malformed response with status 200", async () => {
    const { url } = await start({ chaos: { malformedRate: 1 } });
    await post(`${url}/v1/chat/completions`, chat("hi"));
    const entries = JSON.parse((await get(`${url}/__aimock/journal`)).body) as Array<{
      response: { status: number; chaosAction?: string };
    }>;
    const entry = entries.find((e) => e.response.chaosAction === "malformed");
    expect(entry?.response.status).toBe(200);
  });

  it("journals a disconnect with status 0", async () => {
    const { url } = await start({ chaos: { disconnectRate: 1 } });
    await expect(post(`${url}/v1/chat/completions`, chat("hi"))).rejects.toThrow();
    const entries = JSON.parse((await get(`${url}/__aimock/journal`)).body) as Array<{
      response: { status: number; chaosAction?: string };
    }>;
    const entry = entries.find((e) => e.response.chaosAction === "disconnect");
    expect(entry?.response.status).toBe(0);
  });

  it("leaves the journal free of a chaos action when nothing fires", async () => {
    const { url } = await start({ chaos: { dropRate: 0 } });
    await post(`${url}/v1/chat/completions`, chat("hi"));
    const entries = JSON.parse((await get(`${url}/__aimock/journal`)).body) as Array<{
      response: { chaosAction?: string };
    }>;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.response.chaosAction).toBeUndefined();
  });

  it("counts a triggered action on the metrics endpoint", async () => {
    const { url } = await start({ chaos: { dropRate: 1 }, metrics: true });
    await post(`${url}/v1/chat/completions`, chat("hi"));
    const metrics = await get(`${url}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.body).toContain("aimock_chaos_triggered_total");
    expect(metrics.body).toContain('action="drop"');
  });
});

describe("evaluateChaos", () => {
  it("returns null with no configuration", () => {
    expect(evaluateChaos(null, undefined, undefined)).toBeNull();
  });

  it("returns null with every rate at zero", () => {
    expect(
      evaluateChaos(null, { dropRate: 0, malformedRate: 0, disconnectRate: 0 }, undefined),
    ).toBeNull();
  });

  it("returns each action at its own rate of 1", () => {
    expect(evaluateChaos(null, { dropRate: 1 }, undefined)).toBe("drop");
    expect(evaluateChaos(null, { malformedRate: 1 }, undefined)).toBe("malformed");
    expect(evaluateChaos(null, { disconnectRate: 1 }, undefined)).toBe("disconnect");
  });

  it("keeps drop ahead of the other two", () => {
    expect(
      evaluateChaos(null, { dropRate: 1, malformedRate: 1, disconnectRate: 1 }, undefined),
    ).toBe("drop");
  });

  it("honours a fixture's rate", () => {
    const fixture: Fixture = {
      match: { userMessage: /.*/ },
      response: { content: "ok" },
      chaos: { malformedRate: 1 },
    };
    expect(evaluateChaos(fixture, undefined, undefined)).toBe("malformed");
  });

  it("honours a header rate over a fixture rate", () => {
    const fixture: Fixture = {
      match: { userMessage: /.*/ },
      response: { content: "ok" },
      chaos: { dropRate: 1 },
    };
    expect(evaluateChaos(fixture, undefined, { "x-aimock-chaos-drop": "0" })).toBeNull();
  });

  it("clamps header rates into range", () => {
    expect(evaluateChaos(null, undefined, { "x-aimock-chaos-drop": "4" })).toBe("drop");
    expect(evaluateChaos(null, { dropRate: 1 }, { "x-aimock-chaos-drop": "-4" })).toBeNull();
  });
});

describe("applyChaos", () => {
  function collectResponse() {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    let status: number | undefined;
    const headers: Record<string, string> = {};
    const res = {
      headersSent: false,
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      writeHead(code: number) {
        status = code;
      },
      write(data: string) {
        stream.write(data);
      },
      end(data?: string) {
        if (data !== undefined) stream.write(data);
        stream.end();
      },
      destroy() {
        stream.end();
      },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => Buffer.concat(chunks).toString() };
  }

  const context = {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {},
    body: null,
  };

  it("reports false and writes nothing when no action fires", () => {
    const { res, status } = collectResponse();
    const journal = new Journal();
    expect(applyChaos(res, null, { dropRate: 0 }, {}, journal, context, "fixture")).toBe(false);
    expect(status()).toBeUndefined();
    expect(journal.getAll()).toHaveLength(0);
  });

  it("reports true and journals when an action fires", () => {
    const { res, status } = collectResponse();
    const journal = new Journal();
    expect(applyChaos(res, null, { dropRate: 1 }, {}, journal, context, "proxy")).toBe(true);
    expect(status()).toBe(500);
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.chaosAction).toBe("drop");
    expect(entries[0].response.source).toBe("proxy");
  });

  it("increments the metrics counter for the action and source", () => {
    const { res } = collectResponse();
    const registry = createMetricsRegistry();
    applyChaos(res, null, { malformedRate: 1 }, {}, new Journal(), context, "internal", registry);
    const serialized = registry.serialize();
    expect(serialized).toContain('action="malformed"');
    expect(serialized).toContain('source="internal"');
  });
});

describe("calculateDelay", () => {
  it("returns the fallback latency with no profile", () => {
    expect(calculateDelay(0, undefined, 40)).toBe(40);
    expect(calculateDelay(3, undefined, 40)).toBe(40);
  });

  it("returns zero with neither profile nor latency", () => {
    expect(calculateDelay(0)).toBe(0);
  });

  it("uses ttft for the first chunk and tps afterwards", () => {
    const profile = { ttft: 80, tps: 50 };
    expect(calculateDelay(0, profile, 0)).toBe(80);
    expect(calculateDelay(1, profile, 0)).toBe(20);
  });

  it("falls back to latency when the profile sets no usable rate", () => {
    expect(calculateDelay(2, { ttft: 80 }, 30)).toBe(30);
  });

  it("leaves the delay untouched when jitter is zero", () => {
    const profile = { ttft: 100, tps: 10, jitter: 0 };
    expect(calculateDelay(1, profile, 0)).toBe(100);
    expect(calculateDelay(0, profile, 0)).toBe(100);
  });

  it("keeps a jittered delay inside its band", () => {
    const profile = { ttft: 100, tps: 10, jitter: 0.5 };
    const random = vi.spyOn(Math, "random");
    try {
      for (let i = 0; i < 40; i++) {
        random.mockReturnValue(i / 40);
        const delay = calculateDelay(i, profile, 0);
        expect(delay).toBeGreaterThanOrEqual(50);
        expect(delay).toBeLessThanOrEqual(150);
      }
    } finally {
      random.mockRestore();
    }
  });

  it("prefers recorded timings over the fallback latency", () => {
    const recorded = { ttftMs: 25, interChunkDelaysMs: [5, 7], totalDurationMs: 37 };
    expect(calculateDelay(0, undefined, 99, recorded)).toBe(25);
    expect(calculateDelay(1, undefined, 99, recorded)).toBe(5);
    expect(calculateDelay(2, undefined, 99, recorded)).toBe(7);
  });

  it("averages recorded inter-chunk delays past the end", () => {
    const recorded = { ttftMs: 25, interChunkDelaysMs: [4, 8], totalDurationMs: 37 };
    expect(calculateDelay(5, undefined, 0, recorded)).toBe(6);
  });

  it("divides every delay by the replay speed", () => {
    const profile = { ttft: 100, tps: 10 };
    expect(calculateDelay(0, profile, 0, undefined, 2)).toBe(50);
    expect(calculateDelay(1, profile, 0, undefined, 4)).toBe(25);
  });

  it("never returns a negative delay", () => {
    expect(calculateDelay(0, undefined, -50)).toBe(0);
  });
});

describe("writeSSEStream", () => {
  function mockResponse() {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    const headers: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      writeHead() {},
      write(data: string) {
        stream.write(data);
      },
      end(data?: string) {
        if (data !== undefined) stream.write(data);
        stream.end();
      },
    } as unknown as http.ServerResponse;
    return { res, output: () => Buffer.concat(chunks).toString(), headers: () => headers };
  }

  function makeChunks(count: number): SSEChunk[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `c${i}`,
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4",
      choices: [{ index: 0, delta: { content: `t${i}` }, finish_reason: null }],
    })) as unknown as SSEChunk[];
  }

  it("writes every chunk and terminates the stream", async () => {
    const { res, output } = mockResponse();
    await writeSSEStream(res, makeChunks(3), { latency: 0 });
    const text = output();
    for (let i = 0; i < 3; i++) expect(text).toContain(`"id":"c${i}"`);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    await assertRecorderBypass();
    await assertRecorderCapLifecycle();
  });

  it("sets the event-stream headers", async () => {
    const { res, headers } = mockResponse();
    await writeSSEStream(res, makeChunks(1), { latency: 0 });
    expect(headers()["Content-Type"]).toBe("text/event-stream");
  });

  it("emits a usage chunk before the terminator when given one", async () => {
    const { res, output } = mockResponse();
    const usage = makeChunks(1)[0];
    await writeSSEStream(res, makeChunks(1), { latency: 0, usageChunk: usage });
    const text = output();
    expect(text.indexOf('"id":"c0"')).toBeLessThan(text.lastIndexOf("data: [DONE]"));
  });

  it("accepts a bare latency in place of an options object", async () => {
    const { res, output } = mockResponse();
    await writeSSEStream(res, makeChunks(2), 0);
    expect(output()).toContain('"id":"c1"');
  });
});

describe("the control API", () => {
  it("answers health", async () => {
    const { url } = await start({});
    const res = await get(`${url}/__aimock/health`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("reports and clears the fixture count", async () => {
    const { url } = await start({});
    expect(JSON.parse((await get(`${url}/__aimock/fixtures`)).body).count).toBe(1);
    const cleared = await request(`${url}/__aimock/fixtures`, "DELETE", null);
    expect(cleared.status).toBe(200);
    expect(JSON.parse((await get(`${url}/__aimock/fixtures`)).body).count).toBe(0);
  });

  it("adds fixtures dynamically", async () => {
    const { url } = await start({}, []);
    const added = await request(`${url}/__aimock/fixtures`, "POST", {
      fixtures: [{ match: { userMessage: "hi" }, response: { content: "added" } }],
    });
    expect(added.status).toBe(200);
    expect(JSON.parse((await get(`${url}/__aimock/fixtures`)).body).count).toBe(1);
    const res = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(res.status).toBe(200);
    expect(res.body).toContain("added");
  });

  it("clears journal entries on the journal reset", async () => {
    const { url } = await start({});
    await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(JSON.parse((await get(`${url}/__aimock/journal`)).body).length).toBeGreaterThan(0);
    await request(`${url}/__aimock/reset/journal`, "POST", {});
    expect(JSON.parse((await get(`${url}/__aimock/journal`)).body)).toHaveLength(0);
  });

  it("clears fixtures and the journal on the full reset", async () => {
    const { url } = await start({});
    await post(`${url}/v1/chat/completions`, chat("hi"));
    const reset = await request(`${url}/__aimock/reset`, "POST", {});
    expect(JSON.parse(reset.body).reset).toBe(true);
    expect(JSON.parse((await get(`${url}/__aimock/journal`)).body)).toHaveLength(0);
    expect(JSON.parse((await get(`${url}/__aimock/fixtures`)).body).count).toBe(0);
  });
});

describe("chaos on the other provider routes", () => {
  it("drops an embeddings request", async () => {
    const { url } = await start({ chaos: { dropRate: 1 } });
    const res = await post(`${url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hi",
    });
    expect(res.status).toBe(500);
  });

  it("drops a messages request", async () => {
    const { url } = await start({ chaos: { dropRate: 1 } });
    const res = await post(`${url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(500);
  });

  it("drops an image generation request", async () => {
    const { url } = await start({ chaos: { dropRate: 1 } });
    const res = await post(`${url}/v1/images/generations`, { prompt: "a cat", model: "dall-e-3" });
    expect(res.status).toBe(500);
  });

  it("serves an embeddings request untouched when chaos is off", async () => {
    const { url } = await start({});
    const res = await post(`${url}/v1/embeddings`, {
      model: "text-embedding-3-small",
      input: "hi",
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).data).toHaveLength(1);
  });

  it("drops a general fal request", async () => {
    const mock = new LLMock({ port: 0, chaos: { dropRate: 1 } });
    mocks.push(mock);
    mock.onFalQueue(/flux/, { images: [{ url: "https://example.com/cat.png" }] });
    const url = await mock.start();
    const res = await post(
      `${url}/fal/fal-ai/flux/dev`,
      { input: { prompt: "a cat" } },
      { "x-fal-target-host": "queue.fal.run" },
    );
    expect(res.status).toBe(500);
  });

  it("serves a general fal request untouched when chaos is off", async () => {
    const mock = new LLMock({ port: 0 });
    mocks.push(mock);
    mock.onFalQueue(/flux/, { images: [{ url: "https://example.com/cat.png" }] });
    const url = await mock.start();
    const res = await post(
      `${url}/fal/fal-ai/flux/dev`,
      { input: { prompt: "a cat" } },
      { "x-fal-target-host": "queue.fal.run" },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).request_id).toBeDefined();
  });
});
