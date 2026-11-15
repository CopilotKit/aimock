/**
 * Seeded, reproducible chaos injection and injectable stream jitter.
 *
 * The properties are stated as relationships between runs rather than as
 * literal draw values, so any correct keyed design satisfies them and no
 * particular hash or generator is required.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { assertRequestJitter, assertDerivedRequestJitter } from "./chaos-pacing-a93f6c.js";
import { assertCliSeed, assertActiveProxyMalformed } from "./chaos-integration-a93f6c.js";
import { PassThrough } from "node:stream";
import * as sseWriter from "../sse-writer.js";
import * as publicApi from "../index.js";
import { LLMock } from "../llmock.js";
import { createServer, type ServerInstance } from "../server.js";
import type { ChatCompletionRequest, Fixture, SSEChunk } from "../types.js";

const SEED_HEADER = "x-aimock-chaos-seed";
const KEY_HEADER = "x-aimock-chaos-key";
const OCCURRENCE_HEADER = "x-aimock-chaos-occurrence";
const HEX16 = /^[0-9a-f]{16}$/;

/** Resolved lazily so older builds fail with a clear compatibility message. */
function newExport<T>(module: unknown, name: string, where: string): T {
  const value = (module as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new Error(`${where} does not export ${name}`);
  }
  return value as T;
}

type JitterFactory = (seed: string, key: string) => (chunkIndex: number) => number;

function jitterFactory(): JitterFactory {
  return newExport<JitterFactory>(sseWriter, "createJitterSource", "src/sse-writer.ts");
}

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

const CRLF = String.fromCharCode(13, 10);

/** POST exact bytes, for payloads that are not JSON. */
function postBytes(
  url: string,
  contentType: string,
  payload: Buffer,
  headers?: Record<string, string>,
  method = "POST",
): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(payload.length),
          ...headers,
        },
      },
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
    req.write(payload);
    req.end();
  });
}

const get = (url: string) => request(url, "GET", null);

const MULTIPART_BOUNDARY = "----aimock-family";
const MULTIPART_TYPE = `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`;

/** A well-formed multipart body, for the routes that take uploads. */
function formData(fields: Array<[string, string, string?]>): Buffer {
  const lines: string[] = [];
  for (const [name, value, filename] of fields) {
    lines.push(`--${MULTIPART_BOUNDARY}`);
    lines.push(
      filename
        ? `Content-Disposition: form-data; name="${name}"; filename="${filename}"`
        : `Content-Disposition: form-data; name="${name}"`,
    );
    if (filename) lines.push("Content-Type: application/octet-stream");
    lines.push("");
    lines.push(value);
  }
  lines.push(`--${MULTIPART_BOUNDARY}--`);
  return Buffer.from(lines.join(CRLF));
}

/** One chaos-injecting route, and how a client reaches it. */
interface FamilyRoute {
  path: string;
  /** Defaults to POST. */
  method?: string;
  /** A JSON body, for the routes that take one. */
  body?: object;
  /** Exact bytes instead, for the multipart uploads. */
  bytes?: () => Buffer;
  /** What the route needs to be reached, such as the fal target host. */
  headers?: Record<string, string>;
}

function fireRoute(url: string, route: FamilyRoute): Promise<Probe> {
  if (route.bytes) {
    return postBytes(`${url}${route.path}`, MULTIPART_TYPE, route.bytes());
  }
  return request(`${url}${route.path}`, route.method ?? "POST", route.body ?? null, route.headers);
}

function chat(text: string): ChatCompletionRequest {
  return { model: "gpt-4", messages: [{ role: "user", content: text }] };
}

/** A catch-all fixture, so an untouched request is an unambiguous valid 200. */
function catchAll(): Fixture[] {
  return [{ match: { userMessage: /.*/ }, response: { content: "ok" } }];
}

type Outcome = "drop" | "malformed" | "ok";
type Settled = Outcome | "disconnect";

function classify(probe: Probe): Outcome {
  if (probe.status === 500) return "drop";
  try {
    JSON.parse(probe.body);
    return "ok";
  } catch {
    return "malformed";
  }
}

const servers: ServerInstance[] = [];
const mocks: LLMock[] = [];

async function start(options: Record<string, unknown>, fixtures: Fixture[] = catchAll()) {
  const instance = await createServer(fixtures, options as never);
  servers.push(instance);
  return instance;
}

async function startMock(options: Record<string, unknown>) {
  const mock = new LLMock(options as never);
  mocks.push(mock);
  const url = await mock.start();
  return { mock, url };
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

/** Fire `count` requests for one message and classify each outcome. */
async function sequence(
  url: string,
  text: string,
  count: number,
  headers?: Record<string, string>,
): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (let i = 0; i < count; i++) {
    out.push(classify(await post(`${url}/v1/chat/completions`, chat(text), headers)));
  }
  return out;
}

/** The same, but tolerating a destroyed connection so disconnects can be seen. */
async function settledSequence(
  url: string,
  text: string,
  count: number,
  headers?: Record<string, string>,
): Promise<Settled[]> {
  const out: Settled[] = [];
  for (let i = 0; i < count; i++) {
    try {
      out.push(classify(await post(`${url}/v1/chat/completions`, chat(text), headers)));
    } catch {
      out.push("disconnect");
    }
  }
  return out;
}

function indicesOf<T>(outcomes: T[], wanted: T): number[] {
  return outcomes.map((o, i) => (o === wanted ? i : -1)).filter((i) => i >= 0);
}

async function chaosReport(url: string): Promise<Record<string, unknown>> {
  const res = await get(`${url}/__aimock/chaos`);
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as Record<string, unknown>;
}

function trackedKeyCount(payload: Record<string, unknown>): number {
  const value = payload.trackedKeys;
  expect(typeof value).toBe("number");
  return value as number;
}

async function expectTrackedKeyCount(url: string, expected: number) {
  expect(trackedKeyCount(await chaosReport(url))).toBe(expected);
}

interface JournalEntryShape {
  response: {
    chaosAction?: string;
    chaosSeed?: string;
    chaosKey?: string;
    chaosOccurrence?: number;
  };
}

async function journalEntries(url: string): Promise<JournalEntryShape[]> {
  return JSON.parse((await get(`${url}/__aimock/journal`)).body) as JournalEntryShape[];
}

describe("chaos seed reporting", () => {
  it("reports the configured seed and the effective rates", async () => {
    const { url } = await start({
      chaos: { dropRate: 0.5, malformedRate: 0.25, disconnectRate: 0, seed: "pinned-seed" },
    });
    const payload = await chaosReport(url);
    expect(payload.seed).toBe("pinned-seed");
    expect(payload.dropRate).toBe(0.5);
    expect(payload.malformedRate).toBe(0.25);
    expect(payload.disconnectRate).toBe(0);
    await assertCliSeed();
  }, 20000);

  it("reports zeroed rates and a seed when nothing is configured", async () => {
    const { url } = await start({});
    const payload = await chaosReport(url);
    expect(payload.dropRate).toBe(0);
    expect(payload.malformedRate).toBe(0);
    expect(payload.disconnectRate).toBe(0);
    expect(typeof payload.seed).toBe("string");
    expect((payload.seed as string).length).toBeGreaterThan(0);
  });

  it("reports a generated seed when none was configured", async () => {
    const { url } = await start({ chaos: { dropRate: 0.5 } });
    const payload = await chaosReport(url);
    expect(typeof payload.seed).toBe("string");
    expect((payload.seed as string).length).toBeGreaterThan(0);
  });

  it("replays an unseeded run from the seed it reported", async () => {
    const original = await start({ chaos: { dropRate: 0.5 } });
    const reported = (await chaosReport(original.url)).seed as string;
    const observed = await sequence(original.url, "hello", 30);
    const replay = await start({ chaos: { dropRate: 0.5, seed: reported } });
    expect(await sequence(replay.url, "hello", 30)).toEqual(observed);
  });

  it("exposes the same seed on the server instance as the control endpoint", async () => {
    const instance = await start({ chaos: { dropRate: 0.5, seed: "instance-seed" } });
    expect(instance.chaosSeed).toBe("instance-seed");
    expect((await chaosReport(instance.url)).seed).toBe(instance.chaosSeed);
  });

  it("exposes a generated seed on the server instance too", async () => {
    const instance = await start({ chaos: { malformedRate: 1 } });
    expect(typeof instance.chaosSeed).toBe("string");
    expect(instance.chaosSeed.length).toBeGreaterThan(0);
  });

  it("exposes a configured seed on the programmatic mock", async () => {
    const { mock, url } = await startMock({ chaos: { dropRate: 1, seed: "mock-seed" } });
    expect(mock.chaosSeed).toBe("mock-seed");
    expect((await chaosReport(url)).seed).toBe("mock-seed");
    expect((await post(`${url}/v1/chat/completions`, chat("hi"))).headers[SEED_HEADER]).toBe(
      "mock-seed",
    );

    // Rates stay tunable while the mock runs, but the run has one seed. A
    // reporter that kept naming the old one while the draws followed a new one
    // would describe a run nobody can reproduce. The rate goes off and then on
    // again so that the edits are seen to land: a mock that quietly discarded
    // every edit would keep the right seed for the wrong reason.
    mock.setChaos({ dropRate: 0, seed: "changed-after-start" });
    const quiet = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(quiet.headers[SEED_HEADER]).toBeUndefined();
    expect(mock.chaosSeed).toBe("mock-seed");
    expect((await chaosReport(url)).seed).toBe("mock-seed");

    mock.setChaos({ dropRate: 1, seed: "changed-again" });
    const loud = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(loud.status).toBe(500);
    expect(loud.headers[SEED_HEADER]).toBe("mock-seed");
  });

  it("exposes a generated seed on the programmatic mock", async () => {
    const { mock, url } = await startMock({ chaos: { dropRate: 0.5 } });
    expect(typeof mock.chaosSeed).toBe("string");
    expect(mock.chaosSeed.length).toBeGreaterThan(0);
    const generated = mock.chaosSeed;
    expect((await chaosReport(url)).seed).toBe(generated);

    mock.setChaos({ dropRate: 0, seed: "changed-generated-after-start" });
    const quiet = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(quiet.headers[SEED_HEADER]).toBeUndefined();
    expect(mock.chaosSeed).toBe(generated);
    expect((await chaosReport(url)).seed).toBe(generated);

    mock.setChaos({ dropRate: 1, seed: "changed-generated-again" });
    const loud = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(loud.status).toBe(500);
    expect(loud.headers[SEED_HEADER]).toBe(generated);
  });

  it("counts the keys it is tracking", async () => {
    const { url } = await start({ chaos: { dropRate: 0 } });
    await post(`${url}/v1/chat/completions`, chat("one"));
    await post(`${url}/v1/chat/completions`, chat("two"));
    await post(`${url}/v1/chat/completions`, chat("one"));
    await expectTrackedKeyCount(url, 2);
  });

  it("publishes the seed on the metrics endpoint", async () => {
    const { url } = await start({ chaos: { dropRate: 0.5, seed: "scraped" }, metrics: true });
    const res = await get(`${url}/metrics`);
    expect(res.status).toBe(200);
    const lines = res.body.split("\n");
    const line = lines.find(
      (l) => l.startsWith("aimock_chaos_seed_info") && l.includes('seed="scraped"'),
    );
    expect(line).toBeDefined();
    expect(line?.trim().endsWith("1")).toBe(true);
  });

  it("publishes the seed even when no chaos is configured", async () => {
    const instance = await start({ metrics: true });
    const res = await get(`${instance.url}/metrics`);
    const line = res.body
      .split("\n")
      .find(
        (l) => l.startsWith("aimock_chaos_seed_info") && l.includes(`seed="${instance.chaosSeed}"`),
      );
    expect(line).toBeDefined();
    expect(line?.trim().endsWith("1")).toBe(true);
  });

  it("announces the coordinates on an affected response and not on a clean one", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "polarity" } });
    const affected = await post(`${url}/v1/chat/completions`, chat("x"));
    expect(affected.headers[SEED_HEADER]).toBe("polarity");
    expect(affected.headers[KEY_HEADER]).toMatch(HEX16);
    expect(affected.headers[OCCURRENCE_HEADER]).toBe("0");

    const quiet = await start({ chaos: { dropRate: 0, seed: "polarity" } });
    const clean = await post(`${quiet.url}/v1/chat/completions`, chat("x"));
    expect(classify(clean)).toBe("ok");
    expect(clean.headers[SEED_HEADER]).toBeUndefined();
    expect(clean.headers[KEY_HEADER]).toBeUndefined();
    expect(clean.headers[OCCURRENCE_HEADER]).toBeUndefined();
  });

  it("puts the seed, key and occurrence on a dropped response", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "hdr" } });
    const first = await post(`${url}/v1/chat/completions`, chat("x"));
    expect(first.status).toBe(500);
    expect(first.headers[SEED_HEADER]).toBe("hdr");
    expect(first.headers[KEY_HEADER]).toMatch(HEX16);
    expect(first.headers[OCCURRENCE_HEADER]).toBe("0");
    const second = await post(`${url}/v1/chat/completions`, chat("x"));
    expect(second.headers[OCCURRENCE_HEADER]).toBe("1");
    expect(second.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
  });

  it("puts the seed, key and occurrence on a malformed response", async () => {
    const { url } = await start({ chaos: { malformedRate: 1, seed: "hdr2" } });
    const res = await post(`${url}/v1/chat/completions`, chat("x"));
    expect(classify(res)).toBe("malformed");
    expect(res.headers[SEED_HEADER]).toBe("hdr2");
    expect(res.headers[KEY_HEADER]).toMatch(HEX16);
    expect(res.headers[OCCURRENCE_HEADER]).toBe("0");

    // The journal records the same three for a malformed action, as it does
    // for a drop and for a disconnect.
    const entry = (await journalEntries(url)).find((e) => e.response.chaosAction === "malformed");
    expect(entry).toBeDefined();
    expect(entry?.response.chaosSeed).toBe("hdr2");
    expect(entry?.response.chaosKey).toBe(res.headers[KEY_HEADER]);
    expect(entry?.response.chaosOccurrence).toBe(0);
    await assertActiveProxyMalformed();
  }, 20000);

  it("records the seed, key and occurrence in the journal entry", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "journalled" } });
    await post(`${url}/v1/chat/completions`, chat("x"));
    await post(`${url}/v1/chat/completions`, chat("x"));
    const chaosEntries = (await journalEntries(url)).filter(
      (e) => e.response.chaosAction === "drop",
    );
    expect(chaosEntries).toHaveLength(2);
    expect(chaosEntries[0].response.chaosSeed).toBe("journalled");
    expect(chaosEntries[0].response.chaosKey).toMatch(HEX16);
    expect(chaosEntries.map((e) => e.response.chaosOccurrence)).toEqual([0, 1]);
  });

  it("records all three coordinates for a disconnect, which cannot carry headers", async () => {
    const { url } = await start({ chaos: { disconnectRate: 1, seed: "disc" } });
    await expect(post(`${url}/v1/chat/completions`, chat("x"))).rejects.toThrow();
    const entry = (await journalEntries(url)).find((e) => e.response.chaosAction === "disconnect");
    expect(entry).toBeDefined();
    expect(entry?.response.chaosSeed).toBe("disc");
    expect(entry?.response.chaosKey).toMatch(HEX16);
    expect(entry?.response.chaosOccurrence).toBe(0);
  });

  it("leaves the journal free of every coordinate when nothing fired", async () => {
    const { url } = await start({ chaos: { dropRate: 0, seed: "quiet" } });
    await post(`${url}/v1/chat/completions`, chat("x"));
    const entries = await journalEntries(url);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.response.chaosAction).toBeUndefined();
      expect(entry.response.chaosSeed).toBeUndefined();
      expect(entry.response.chaosKey).toBeUndefined();
      expect(entry.response.chaosOccurrence).toBeUndefined();
    }
    await expectTrackedKeyCount(url, 1);

    // A decision was still taken, so the counter moved: four more silent
    // requests, then one the header makes fire, which reports occurrence 5.
    for (let i = 0; i < 4; i++) await post(`${url}/v1/chat/completions`, chat("x"));
    const fired = await post(`${url}/v1/chat/completions`, chat("x"), {
      "x-aimock-chaos-drop": "1",
    });
    expect(fired.status).toBe(500);
    expect(fired.headers[OCCURRENCE_HEADER]).toBe("5");
  });
});

describe("reproducibility", () => {
  it("two servers with the same seed produce the same outcome sequence", async () => {
    const a = await start({ chaos: { dropRate: 0.5, seed: "repro" } });
    const b = await start({ chaos: { dropRate: 0.5, seed: "repro" } });
    const first = await sequence(a.url, "hello", 40);
    expect(await sequence(b.url, "hello", 40)).toEqual(first);
  });

  it("repeats the same sequence after a chaos reset", async () => {
    const { url } = await start({ chaos: { dropRate: 0.5, seed: "mix" } });
    const outcomes = await sequence(url, "hello", 40);
    await request(`${url}/__aimock/chaos/reset`, "POST", {});
    expect(await sequence(url, "hello", 40)).toEqual(outcomes);
  });

  it("different seeds diverge while each stays reproducible", async () => {
    // Sampled rather than pinned to one pair. Any two seeds may agree over a
    // finite prefix without either being wrong, but a design that ignores the
    // seed agrees over every pair, so a sample that separates rules it out.
    const shapes = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const instance = await start({ chaos: { dropRate: 0.5, seed: `diverge-${i}` } });
      shapes.add((await sequence(instance.url, "hello", 24)).join(","));
    }
    expect(shapes.size).toBeGreaterThan(1);

    const a = await start({ chaos: { dropRate: 0.5, seed: "seed-a" } });
    const aAgain = await start({ chaos: { dropRate: 0.5, seed: "seed-a" } });
    const first = await sequence(a.url, "hello", 40);
    expect(await sequence(aAgain.url, "hello", 40)).toEqual(first);
  });

  it("all three action kinds are reproducible together", async () => {
    const config = { dropRate: 0.3, malformedRate: 0.3, disconnectRate: 0.3, seed: "three" };
    const a = await start({ chaos: config });
    const b = await start({ chaos: config });
    const first = await settledSequence(a.url, "hello", 40);
    expect(await settledSequence(b.url, "hello", 40)).toEqual(first);
  });

  it("the chaos reset rewinds the sequence and keeps the seed", async () => {
    const { url } = await start({ chaos: { dropRate: 0.5, seed: "rewind" } });
    const first = await sequence(url, "hello", 24);
    const reset = await request(`${url}/__aimock/chaos/reset`, "POST", {});
    expect(reset.status).toBe(200);
    const payload = JSON.parse(reset.body) as { reset: boolean; seed?: string };
    expect(payload.reset).toBe(true);
    expect(payload.seed ?? reset.headers[SEED_HEADER]).toBe("rewind");
    expect(await sequence(url, "hello", 24)).toEqual(first);
  });

  it("the chaos reset clears the tracked-key count", async () => {
    const { url } = await start({ chaos: { dropRate: 0 } });
    await post(`${url}/v1/chat/completions`, chat("a"));
    await post(`${url}/v1/chat/completions`, chat("b"));
    await request(`${url}/__aimock/chaos/reset`, "POST", {});
    await expectTrackedKeyCount(url, 0);
  });

  it("the full reset rewinds the chaos sequence and clears the count", async () => {
    const { url } = await start({ chaos: { dropRate: 0.5, seed: "fullreset" } });
    const first = await sequence(url, "hello", 28);
    await request(`${url}/__aimock/reset`, "POST", {});
    const afterReset = await chaosReport(url);
    expect(trackedKeyCount(afterReset)).toBe(0);
    expect(afterReset.seed).toBe("fullreset");
    await request(`${url}/__aimock/fixtures`, "POST", {
      fixtures: [{ match: { userMessage: "hello" }, response: { content: "ok" } }],
    });
    expect(await sequence(url, "hello", 28)).toEqual(first);
  });

  it("the full reset announces the seed it kept", async () => {
    const { url } = await start({ chaos: { dropRate: 0.5, seed: "reset-reports" } });
    await sequence(url, "hello", 3);
    const res = await request(`${url}/__aimock/reset`, "POST", {});
    expect(res.status).toBe(200);
    // Resetting between tests only replays if the reply still names the seed.
    // The body stays exactly `{ reset: true }`, which this route already
    // promises, so the seed rides the header the chaos responses use.
    expect(res.headers[SEED_HEADER]).toBe("reset-reports");
    expect(JSON.parse(res.body)).toEqual({ reset: true });
    expect((await chaosReport(url)).seed).toBe("reset-reports");
  });

  it("clearing only the journal does not rewind, but a chaos reset does", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "journalonly" } });
    expect(
      (await post(`${url}/v1/chat/completions`, chat("hello"))).headers[OCCURRENCE_HEADER],
    ).toBe("0");
    const before = await chaosReport(url);

    const cleared = await request(`${url}/__aimock/reset/journal`, "POST", {});
    expect(cleared.status).toBe(200);
    const after = await chaosReport(url);
    expect(trackedKeyCount(after)).toBe(trackedKeyCount(before));
    expect(after.seed).toBe("journalonly");
    expect(
      (await post(`${url}/v1/chat/completions`, chat("hello"))).headers[OCCURRENCE_HEADER],
    ).toBe("1");

    await request(`${url}/__aimock/chaos/reset`, "POST", {});
    await expectTrackedKeyCount(url, 0);
    expect(
      (await post(`${url}/v1/chat/completions`, chat("hello"))).headers[OCCURRENCE_HEADER],
    ).toBe("0");
  });
});

describe("order independence", () => {
  it("interleaving two keys does not change either key's sequence", async () => {
    const interleaved = await start({ chaos: { dropRate: 0.5, seed: "order" } });
    const alpha: Outcome[] = [];
    const beta: Outcome[] = [];
    for (let i = 0; i < 24; i++) {
      alpha.push(classify(await post(`${interleaved.url}/v1/chat/completions`, chat("alpha"))));
      beta.push(classify(await post(`${interleaved.url}/v1/chat/completions`, chat("beta"))));
    }

    const grouped = await start({ chaos: { dropRate: 0.5, seed: "order" } });
    expect(await sequence(grouped.url, "alpha", 24)).toEqual(alpha);
    expect(await sequence(grouped.url, "beta", 24)).toEqual(beta);
  });

  it("an unrelated key inserted mid-run does not shift the run", async () => {
    const plain = await start({ chaos: { dropRate: 0.5, seed: "insert" } });
    const baseline = await sequence(plain.url, "subject", 20);

    const noisy = await start({ chaos: { dropRate: 0.5, seed: "insert" } });
    const observed: Outcome[] = [];
    for (let i = 0; i < 20; i++) {
      if (i === 7 || i === 13) {
        await post(`${noisy.url}/v1/chat/completions`, chat(`noise-${i}`));
      }
      observed.push(classify(await post(`${noisy.url}/v1/chat/completions`, chat("subject"))));
    }
    expect(observed).toEqual(baseline);
  });

  it("two keys get distinct sequences, each reproducible on its own", async () => {
    const { url } = await start({ chaos: { dropRate: 0.5, seed: "distinct" } });
    // Same sampling argument as for seeds: two particular keys may agree over
    // a finite prefix, but a design that ignores the key agrees everywhere.
    const perKey = new Map<string, Outcome[]>();
    for (let i = 0; i < 6; i++) {
      const text = `subject-${i}`;
      perKey.set(text, await sequence(url, text, 20));
    }
    expect(new Set([...perKey.values()].map((o) => o.join(","))).size).toBeGreaterThan(1);

    const replay = await start({ chaos: { dropRate: 0.5, seed: "distinct" } });
    for (const [text, outcomes] of perKey) {
      expect(await sequence(replay.url, text, 20), `${text} did not replay`).toEqual(outcomes);
    }
  });

  it("concurrent requests for one key still cover each occurrence exactly once", async () => {
    const serial = await start({ chaos: { dropRate: 0.5, seed: "concurrent" } });
    const expected = await sequence(serial.url, "hello", 24);

    const replay = await start({ chaos: { dropRate: 0.5, seed: "concurrent" } });
    expect(await sequence(replay.url, "hello", 24)).toEqual(expected);

    const parallel = await start({ chaos: { dropRate: 0.5, seed: "concurrent" } });
    const settled = await Promise.all(
      Array.from({ length: 24 }, () =>
        post(`${parallel.url}/v1/chat/completions`, chat("hello")).then(classify),
      ),
    );
    expect([...settled].sort()).toEqual([...expected].sort());
  });

  it("a key's occurrence keeps counting however many other keys arrive", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "volume" } });
    const first = await post(`${url}/v1/chat/completions`, chat("subject"));
    expect(first.headers[OCCURRENCE_HEADER]).toBe("0");
    for (let i = 0; i < 200; i++) {
      await post(`${url}/v1/chat/completions`, chat(`filler-${i}`));
    }
    const again = await post(`${url}/v1/chat/completions`, chat("subject"));
    expect(again.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
    expect(again.headers[OCCURRENCE_HEADER]).toBe("1");
    await expectTrackedKeyCount(url, 201);
  });
});

describe("stream independence", () => {
  it("raising dropRate does not change which requests come back malformed", async () => {
    const quiet = await start({ chaos: { dropRate: 0, malformedRate: 0.5, seed: "streams" } });
    const withoutDrops = await sequence(quiet.url, "hello", 40);

    const loud = await start({ chaos: { dropRate: 0.5, malformedRate: 0.5, seed: "streams" } });
    const withDrops = await sequence(loud.url, "hello", 40);

    for (let i = 0; i < withDrops.length; i++) {
      if (withDrops[i] === "drop") continue;
      expect(withDrops[i]).toBe(withoutDrops[i]);
    }
  });

  it("enabling disconnect does not change the drop pattern", async () => {
    const plain = await start({ chaos: { dropRate: 0.5, seed: "disc-stream" } });
    const drops = indicesOf(await sequence(plain.url, "hello", 40), "drop");

    const both = await start({
      chaos: { dropRate: 0.5, disconnectRate: 0.5, seed: "disc-stream" },
    });
    const observed = await settledSequence(both.url, "hello", 40);
    expect(indicesOf<Settled>(observed, "drop")).toEqual(drops);
  });

  it("malformed at rate 1 leaves no request untouched, reproducibly", async () => {
    const config = { dropRate: 0.5, malformedRate: 1, seed: "starve" };
    const { url } = await start({ chaos: config });
    const outcomes = await sequence(url, "hello", 40);
    expect(indicesOf(outcomes, "ok")).toEqual([]);
    const replay = await start({ chaos: config });
    expect(await sequence(replay.url, "hello", 40)).toEqual(outcomes);
  });

  it("draws each kind from its own stream, not one shared draw", async () => {
    // One draw shared by the three kinds picks the same requests for all of
    // them at the same rate, for every seed. Independent streams may coincide
    // on any one seed, so sample several and require at least one to separate.
    const separatedPairs = [false, false, false];
    for (let i = 0; i < 4; i++) {
      const seed = `streams-apart-${i}`;
      const drop = await start({ chaos: { dropRate: 0.5, seed } });
      const dropIdx = indicesOf(await sequence(drop.url, "hello", 24), "drop");
      const malformed = await start({ chaos: { malformedRate: 0.5, seed } });
      const malformedIdx = indicesOf(await sequence(malformed.url, "hello", 24), "malformed");
      const disconnect = await start({ chaos: { disconnectRate: 0.5, seed } });
      const disconnectIdx = indicesOf<Settled>(
        await settledSequence(disconnect.url, "hello", 24),
        "disconnect",
      );
      const shapes = [dropIdx.join(","), malformedIdx.join(","), disconnectIdx.join(",")];
      separatedPairs[0] ||= shapes[0] !== shapes[1];
      separatedPairs[1] ||= shapes[0] !== shapes[2];
      separatedPairs[2] ||= shapes[1] !== shapes[2];
    }
    expect(separatedPairs, "each pair of action streams must separate").toEqual([true, true, true]);

    const once = await start({ chaos: { dropRate: 0.5, seed: "streams-apart-0" } });
    const observed = await sequence(once.url, "hello", 24);
    const replay = await start({ chaos: { dropRate: 0.5, seed: "streams-apart-0" } });
    expect(await sequence(replay.url, "hello", 24)).toEqual(observed);
  });

  it("prefers malformed over disconnect when both would fire", async () => {
    const { url } = await start({
      chaos: { malformedRate: 1, disconnectRate: 1, seed: "order-md" },
    });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(classify(res)).toBe("malformed");
    expect(res.headers[SEED_HEADER]).toBe("order-md");
    expect(res.headers[OCCURRENCE_HEADER]).toBe("0");
  });

  it("prefers drop over both of the others when all three would fire", async () => {
    const { url } = await start({
      chaos: { dropRate: 1, malformedRate: 1, disconnectRate: 1, seed: "order-all" },
    });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(classify(res)).toBe("drop");
    expect(res.headers[SEED_HEADER]).toBe("order-all");
    expect(res.headers[OCCURRENCE_HEADER]).toBe("0");
  });
});

describe("rate independence", () => {
  it("raising dropRate only ever adds drops", async () => {
    const low = await start({ chaos: { dropRate: 0.25, seed: "monotone" } });
    const high = await start({ chaos: { dropRate: 0.75, seed: "monotone" } });
    const lowOutcomes = await sequence(low.url, "hello", 60);
    const lowDrops = indicesOf(lowOutcomes, "drop");
    const highDrops = indicesOf(await sequence(high.url, "hello", 60), "drop");
    expect(highDrops.length).toBeGreaterThanOrEqual(lowDrops.length);
    for (const i of lowDrops) {
      expect(highDrops).toContain(i);
    }
    const replay = await start({ chaos: { dropRate: 0.25, seed: "monotone" } });
    expect(await sequence(replay.url, "hello", 60)).toEqual(lowOutcomes);
  });

  it("raising malformedRate only ever adds malformed responses without perturbing disconnect draws", async () => {
    const low = await start({ chaos: { malformedRate: 0.25, seed: "monotone-m" } });
    const high = await start({ chaos: { malformedRate: 0.75, seed: "monotone-m" } });
    const lowOutcomes = await sequence(low.url, "hello", 60);
    const lowHits = indicesOf(lowOutcomes, "malformed");
    const highHits = indicesOf(await sequence(high.url, "hello", 60), "malformed");
    expect(highHits.length).toBeGreaterThanOrEqual(lowHits.length);
    for (const i of lowHits) {
      expect(highHits).toContain(i);
    }
    const replay = await start({ chaos: { malformedRate: 0.25, seed: "monotone-m" } });
    expect(await sequence(replay.url, "hello", 60)).toEqual(lowOutcomes);

    const lowWithDisconnect = await start({
      chaos: { malformedRate: 0.25, disconnectRate: 0.5, seed: "monotone-md" },
    });
    const highWithDisconnect = await start({
      chaos: { malformedRate: 0.75, disconnectRate: 0.5, seed: "monotone-md" },
    });
    const lowMixed = await settledSequence(lowWithDisconnect.url, "hello", 60);
    const highMixed = await settledSequence(highWithDisconnect.url, "hello", 60);
    for (let i = 0; i < lowMixed.length; i++) {
      if (lowMixed[i] === "malformed" || highMixed[i] === "malformed") continue;
      expect(highMixed[i]).toBe(lowMixed[i]);
    }
  });

  it("raising disconnectRate only ever adds disconnects without perturbing malformed draws", async () => {
    const low = await start({ chaos: { disconnectRate: 0.25, seed: "monotone-d" } });
    const high = await start({ chaos: { disconnectRate: 0.75, seed: "monotone-d" } });
    const lowOutcomes = await settledSequence(low.url, "hello", 60);
    const lowHits = indicesOf<Settled>(lowOutcomes, "disconnect");
    const highHits = indicesOf<Settled>(await settledSequence(high.url, "hello", 60), "disconnect");
    expect(highHits.length).toBeGreaterThanOrEqual(lowHits.length);
    for (const i of lowHits) {
      expect(highHits).toContain(i);
    }
    const replay = await start({ chaos: { disconnectRate: 0.25, seed: "monotone-d" } });
    expect(await settledSequence(replay.url, "hello", 60)).toEqual(lowOutcomes);

    const lowWithMalformed = await start({
      chaos: { malformedRate: 0.5, disconnectRate: 0.25, seed: "monotone-dm" },
    });
    const highWithMalformed = await start({
      chaos: { malformedRate: 0.5, disconnectRate: 0.75, seed: "monotone-dm" },
    });
    expect(
      indicesOf(await settledSequence(highWithMalformed.url, "hello", 60), "malformed"),
    ).toEqual(indicesOf(await settledSequence(lowWithMalformed.url, "hello", 60), "malformed"));
  }, 20000);

  it("is monotone across four rates at once", async () => {
    const sets: number[][] = [];
    for (const rate of [0.1, 0.35, 0.6, 0.9]) {
      const instance = await start({ chaos: { dropRate: rate, seed: "ladder" } });
      sets.push(indicesOf(await sequence(instance.url, "hello", 60), "drop"));
    }
    for (let i = 1; i < sets.length; i++) {
      expect(sets[i].length).toBeGreaterThanOrEqual(sets[i - 1].length);
      for (const index of sets[i - 1]) {
        expect(sets[i]).toContain(index);
      }
    }
    const replay = await start({ chaos: { dropRate: 0.1, seed: "ladder" } });
    expect(indicesOf(await sequence(replay.url, "hello", 60), "drop")).toEqual(sets[0]);
  });

  it("drop rate 0 never fires and 1 always fires, still under a seed", async () => {
    const never = await start({ chaos: { dropRate: 0, seed: "edges" } });
    expect(await sequence(never.url, "hello", 12)).toEqual(Array(12).fill("ok"));
    const always = await start({ chaos: { dropRate: 1, seed: "edges" } });
    expect(await sequence(always.url, "hello", 12)).toEqual(Array(12).fill("drop"));
    const res = await post(`${always.url}/v1/chat/completions`, chat("hello"));
    expect(res.headers[SEED_HEADER]).toBe("edges");
    expect(res.headers[OCCURRENCE_HEADER]).toBe("12");
  });

  it("disconnect rate 0 never fires and 1 always fires", async () => {
    const never = await start({ chaos: { disconnectRate: 0, seed: "edges-d" } });
    expect(await settledSequence(never.url, "hello", 12)).toEqual(Array(12).fill("ok"));
    const always = await start({ chaos: { disconnectRate: 1, seed: "edges-d" } });
    expect(await settledSequence(always.url, "hello", 12)).toEqual(Array(12).fill("disconnect"));
    const occurrences = (await journalEntries(always.url))
      .filter((e) => e.response.chaosAction === "disconnect")
      .map((e) => e.response.chaosOccurrence);
    expect(occurrences).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("an out-of-range rate is clamped, not wrapped", async () => {
    const over = await start({ chaos: { dropRate: 5, seed: "clamp" } });
    expect(await sequence(over.url, "hello", 8)).toEqual(Array(8).fill("drop"));
    const under = await start({ chaos: { dropRate: -3, seed: "clamp" } });
    expect(await sequence(under.url, "hello", 8)).toEqual(Array(8).fill("ok"));
    const payload = await chaosReport(over.url);
    expect(payload.seed).toBe("clamp");
    expect(payload.dropRate).toBe(1);
    expect((await chaosReport(under.url)).dropRate).toBe(0);

    const malformedOver = await start({ chaos: { malformedRate: 5, seed: "clamp-m" } });
    expect(await sequence(malformedOver.url, "hello", 4)).toEqual(Array(4).fill("malformed"));
    expect((await chaosReport(malformedOver.url)).malformedRate).toBe(1);
    const malformedUnder = await start({ chaos: { malformedRate: -3, seed: "clamp-m" } });
    expect(await sequence(malformedUnder.url, "hello", 4)).toEqual(Array(4).fill("ok"));
    expect((await chaosReport(malformedUnder.url)).malformedRate).toBe(0);

    const disconnectOver = await start({ chaos: { disconnectRate: 5, seed: "clamp-d" } });
    expect(await settledSequence(disconnectOver.url, "hello", 4)).toEqual(
      Array(4).fill("disconnect"),
    );
    expect((await chaosReport(disconnectOver.url)).disconnectRate).toBe(1);
    const disconnectUnder = await start({ chaos: { disconnectRate: -3, seed: "clamp-d" } });
    expect(await settledSequence(disconnectUnder.url, "hello", 4)).toEqual(Array(4).fill("ok"));
    expect((await chaosReport(disconnectUnder.url)).disconnectRate).toBe(0);
  });

  it("a rate change does not disturb another key's verdicts", async () => {
    const low = await start({ chaos: { dropRate: 0.3, seed: "crosskey" } });
    const alphaLow = await sequence(low.url, "alpha", 30);
    const betaLow = await sequence(low.url, "beta", 30);
    const high = await start({ chaos: { dropRate: 0.9, seed: "crosskey" } });
    const alphaHigh = await sequence(high.url, "alpha", 30);
    const betaHigh = await sequence(high.url, "beta", 30);
    for (const i of indicesOf(alphaLow, "drop")) expect(alphaHigh[i]).toBe("drop");
    for (const i of indicesOf(betaLow, "drop")) expect(betaHigh[i]).toBe("drop");
    const replay = await start({ chaos: { dropRate: 0.3, seed: "crosskey" } });
    expect(await sequence(replay.url, "alpha", 30)).toEqual(alphaLow);
    expect(await sequence(replay.url, "beta", 30)).toEqual(betaLow);
  });

  it("a drop rate supplied by header draws from the same stream", async () => {
    const configured = await start({ chaos: { dropRate: 0.5, seed: "hdrrate" } });
    const fromConfig = await sequence(configured.url, "hello", 30);
    const headerDriven = await start({ chaos: { dropRate: 0, seed: "hdrrate" } });
    expect(await sequence(headerDriven.url, "hello", 30, { "x-aimock-chaos-drop": "0.5" })).toEqual(
      fromConfig,
    );
  });

  it("a malformed rate supplied by header draws from the same stream", async () => {
    const configured = await start({ chaos: { malformedRate: 0.5, seed: "hdr-malformed" } });
    const fromConfig = await sequence(configured.url, "hello", 30);
    const headerDriven = await start({ chaos: { malformedRate: 0, seed: "hdr-malformed" } });
    expect(
      await sequence(headerDriven.url, "hello", 30, { "x-aimock-chaos-malformed": "0.5" }),
    ).toEqual(fromConfig);
  });

  it("a disconnect rate supplied by header draws from the same stream", async () => {
    const configured = await start({ chaos: { disconnectRate: 0.5, seed: "hdr-disconnect" } });
    const fromConfig = await settledSequence(configured.url, "hello", 30);
    const headerDriven = await start({ chaos: { disconnectRate: 0, seed: "hdr-disconnect" } });
    expect(
      await settledSequence(headerDriven.url, "hello", 30, {
        "x-aimock-chaos-disconnect": "0.5",
      }),
    ).toEqual(fromConfig);
  });
});

describe("chaos key derivation", () => {
  it("ignores JSON key order in the body", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "keyorder" } });
    const first = await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
    });
    const second = await post(`${url}/v1/chat/completions`, {
      messages: [{ content: "hi", role: "user" }],
      model: "gpt-4",
    });
    expect(first.headers[KEY_HEADER]).toMatch(HEX16);
    expect(second.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
    expect(second.headers[OCCURRENCE_HEADER]).toBe("1");

    // Only object key order is immaterial; array order is part of the body.
    const forward = await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    });
    const reversed = await post(`${url}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [
        { role: "user", content: "second" },
        { role: "user", content: "first" },
      ],
    });
    expect(reversed.headers[KEY_HEADER]).not.toBe(forward.headers[KEY_HEADER]);
    expect(reversed.headers[OCCURRENCE_HEADER]).toBe("0");

    const nested = { ...chat("mime"), metadata: { outer: { a: 1, b: [2, { c: 3, d: 4 }] } } };
    const reordered = {
      metadata: { outer: { b: [2, { d: 4, c: 3 }], a: 1 } },
      messages: nested.messages,
      model: nested.model,
    };
    let key: unknown;
    let occurrence = 0;
    for (const contentType of ["application/json", "text/plain", "application/octet-stream"]) {
      for (const body of [nested, reordered]) {
        const response = await postBytes(
          `${url}/v1/chat/completions`,
          contentType,
          Buffer.from(JSON.stringify(body)),
        );
        expect(response.headers[KEY_HEADER]).toMatch(HEX16);
        key ??= response.headers[KEY_HEADER];
        expect(response.headers[KEY_HEADER]).toBe(key);
        expect(response.headers[OCCURRENCE_HEADER]).toBe(String(occurrence++));
      }
    }
  });

  it("treats a different body as a different key", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "keybody" } });
    const first = await post(`${url}/v1/chat/completions`, chat("one"));
    const second = await post(`${url}/v1/chat/completions`, chat("two"));
    expect(second.headers[KEY_HEADER]).not.toBe(first.headers[KEY_HEADER]);
    expect(second.headers[OCCURRENCE_HEADER]).toBe("0");

    // Sending nothing is not the same request as sending the four bytes
    // `null`, even though JSON reads the second as an empty value.
    const storage = "/fal/storage/upload/initiate";
    const falStorage = { "x-fal-target-host": "rest.fal.ai" };
    const nothing = await request(`${url}${storage}`, "POST", null, falStorage);
    const literalNull = await postBytes(
      `${url}${storage}`,
      "application/json",
      Buffer.from("null"),
      falStorage,
    );
    expect(nothing.headers[KEY_HEADER]).toMatch(HEX16);
    expect(literalNull.headers[KEY_HEADER]).toMatch(HEX16);
    expect(literalNull.headers[KEY_HEADER]).not.toBe(nothing.headers[KEY_HEADER]);
    expect(nothing.headers[OCCURRENCE_HEADER]).toBe("0");
    expect(literalNull.headers[OCCURRENCE_HEADER]).toBe("0");

    const shaped = (inner: Buffer) =>
      Buffer.concat([
        Buffer.from('{"model":"gpt-4","messages":[{"role":"user","content":"'),
        inner,
        Buffer.from('"}]}'),
      ]);
    const target = `${url}/v1/chat/completions`;
    const rawByte = await postBytes(target, "application/json", shaped(Buffer.from([0xff])));
    const encoded = await postBytes(target, "application/json", shaped(Buffer.from("\ufffd")));
    expect(rawByte.status).toBe(500);
    expect(encoded.status).toBe(500);
    expect(rawByte.headers[KEY_HEADER]).toMatch(HEX16);
    expect(encoded.headers[KEY_HEADER]).toMatch(HEX16);
    expect(encoded.headers[KEY_HEADER]).not.toBe(rawByte.headers[KEY_HEADER]);

    // JSON.parse creates an own __proto__ member; ordinary object assignment
    // must not erase it during canonicalization. Check nested values as well.
    for (const nested of [false, true]) {
      const plain = chat("prototype-member");
      const variants = [
        JSON.stringify({ ...plain, extra: { a: 1 } }),
        JSON.stringify({ ...plain, extra: { a: 1 } }).replace(
          '"a":1',
          nested ? '"a":1,"child":{"__proto__":{"x":1}}' : '"a":1,"__proto__":{"x":1}',
        ),
        JSON.stringify({ ...plain, extra: { a: 1 } }).replace(
          '"a":1',
          nested ? '"child":{"__proto__":{"x":1}},"a":1' : '"__proto__":{"x":1},"a":1',
        ),
      ];
      await request(`${url}/__aimock/chaos/reset`, "POST", {});
      const responses = [];
      for (const value of variants)
        responses.push(await postBytes(target, "application/json", Buffer.from(value)));
      expect(responses.map((response) => response.status)).toEqual([500, 500, 500]);
      expect(responses[1].headers[KEY_HEADER]).not.toBe(responses[0].headers[KEY_HEADER]);
      expect(responses[2].headers[KEY_HEADER]).toBe(responses[1].headers[KEY_HEADER]);
      expect(responses.map((response) => response.headers[OCCURRENCE_HEADER])).toEqual([
        "0",
        "0",
        "1",
      ]);
    }
  });

  it("varies with the query string", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "keyquery" } });
    const plain = await post(`${url}/v1/chat/completions`, chat("hi"));
    const queried = await post(`${url}/v1/chat/completions?attempt=2`, chat("hi"));
    expect(plain.headers[KEY_HEADER]).toMatch(HEX16);
    expect(queried.headers[KEY_HEADER]).toMatch(HEX16);
    expect(queried.headers[KEY_HEADER]).not.toBe(plain.headers[KEY_HEADER]);
    expect(queried.headers[OCCURRENCE_HEADER]).toBe("0");

    const ordered = await post(`${url}/v1/chat/completions?a=1&b=2`, chat("hi"));
    const reordered = await post(`${url}/v1/chat/completions?b=2&a=1`, chat("hi"));
    expect(reordered.headers[KEY_HEADER]).not.toBe(ordered.headers[KEY_HEADER]);

    const repeated = await post(`${url}/v1/chat/completions?a=1&a=2`, chat("hi"));
    const repeatedReordered = await post(`${url}/v1/chat/completions?a=2&a=1`, chat("hi"));
    expect(repeatedReordered.headers[KEY_HEADER]).not.toBe(repeated.headers[KEY_HEADER]);

    const lowercaseEscape = await post(`${url}/v1/chat/completions?path=%2f`, chat("hi"));
    const uppercaseEscape = await post(`${url}/v1/chat/completions?path=%2F`, chat("hi"));
    expect(uppercaseEscape.headers[KEY_HEADER]).not.toBe(lowercaseEscape.headers[KEY_HEADER]);
  });

  it("ignores unrelated headers", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "keyheaders" } });
    const first = await post(`${url}/v1/chat/completions`, chat("hi"), {
      "x-request-id": "first-call",
    });
    const second = await post(`${url}/v1/chat/completions`, chat("hi"), {
      "x-request-id": "second-call",
      "user-agent": "probe/1.0",
    });
    expect(first.headers[KEY_HEADER]).toMatch(HEX16);
    expect(second.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
    expect(second.headers[OCCURRENCE_HEADER]).toBe("1");
  });

  it("ignores a header the router folds into the body before matching", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "keycontext" } });
    const first = await post(`${url}/v1/chat/completions`, chat("hi"), {
      "x-aimock-context": "alpha",
    });
    const second = await post(`${url}/v1/chat/completions`, chat("hi"), {
      "x-aimock-context": "beta",
    });
    expect(first.headers[KEY_HEADER]).toMatch(HEX16);
    expect(second.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
    expect(second.headers[OCCURRENCE_HEADER]).toBe("1");
  });

  it("keys the body as it was sent, not as a handler narrows it", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "keyfull" } });
    const small = await post(`${url}/v1/images/generations`, {
      model: "dall-e-3",
      prompt: "a cat",
      size: "256x256",
    });
    const large = await post(`${url}/v1/images/generations`, {
      model: "dall-e-3",
      prompt: "a cat",
      size: "1024x1024",
    });
    expect(small.headers[KEY_HEADER]).toMatch(HEX16);
    expect(large.headers[KEY_HEADER]).not.toBe(small.headers[KEY_HEADER]);
    expect(large.headers[OCCURRENCE_HEADER]).toBe("0");

    const message = {
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 12,
    };
    const limited = await post(`${url}/v1/messages`, message);
    const expanded = await post(`${url}/v1/messages`, { ...message, max_tokens: 24 });
    expect(limited.headers[KEY_HEADER]).toMatch(HEX16);
    expect(expanded.headers[KEY_HEADER]).toMatch(HEX16);
    expect(expanded.headers[KEY_HEADER]).not.toBe(limited.headers[KEY_HEADER]);
    expect(expanded.headers[OCCURRENCE_HEADER]).toBe("0");
    const same = await post(`${url}/v1/messages`, message, {
      "x-aimock-context": "routing-only",
      "x-request-id": "other",
    });
    expect(same.headers[KEY_HEADER]).toBe(limited.headers[KEY_HEADER]);
    expect(same.headers[OCCURRENCE_HEADER]).toBe("1");

    // Gemini inserts a default role and joins text parts when adapting the
    // request. Equivalent adapted messages still have different wire bodies.
    for (const target of [
      "/v1beta/models/gemini-2.5-flash:generateContent",
      "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent",
    ]) {
      const variants = [
        { contents: [{ parts: [{ text: "hello world" }] }] },
        { contents: [{ role: "user", parts: [{ text: "hello world" }] }] },
        { contents: [{ role: "user", parts: [{ text: "hello " }, { text: "world" }] }] },
      ];
      const keys = new Set<string>();
      for (const body of variants) {
        const first = await post(`${url}${target}`, body);
        expect(first.status, target).toBe(500);
        expect(first.headers[KEY_HEADER], target).toMatch(HEX16);
        expect(first.headers[OCCURRENCE_HEADER], target).toBe("0");
        keys.add(first.headers[KEY_HEADER] as string);
        const replay = await post(`${url}${target}`, body, {
          "x-aimock-context": "adapter-only",
          "x-request-id": "other",
        });
        expect(replay.headers[KEY_HEADER], target).toBe(first.headers[KEY_HEADER]);
        expect(replay.headers[OCCURRENCE_HEADER], target).toBe("1");
      }
      expect(keys.size, target).toBe(variants.length);
    }
  });

  it("groups requests with different bodies under an explicit key", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "keyoverride" } });
    const first = await post(`${url}/v1/chat/completions`, chat("one"), {
      [KEY_HEADER]: "one-logical-call",
    });
    const second = await post(`${url}/v1/chat/completions`, chat("two"), {
      [KEY_HEADER]: "one-logical-call",
    });
    // Reduced, not echoed: the label supplies the identity and then takes the
    // shape every other identity has.
    expect(first.headers[KEY_HEADER]).toMatch(HEX16);
    expect(second.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
    expect(second.headers[OCCURRENCE_HEADER]).toBe("1");
  });

  it("splits otherwise identical requests under different explicit keys", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "keysplit" } });
    const first = await post(`${url}/v1/chat/completions`, chat("same"), {
      [KEY_HEADER]: "left",
    });
    const second = await post(`${url}/v1/chat/completions`, chat("same"), {
      [KEY_HEADER]: "right",
    });
    expect(first.headers[KEY_HEADER]).toMatch(HEX16);
    expect(second.headers[KEY_HEADER]).toMatch(HEX16);
    expect(second.headers[KEY_HEADER]).not.toBe(first.headers[KEY_HEADER]);
    expect(second.headers[OCCURRENCE_HEADER]).toBe("0");
  });

  it("ignores a blank explicit key and keys off the request", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "keyblank" } });
    const derived = await post(`${url}/v1/chat/completions`, chat("same"));
    const blank = await post(`${url}/v1/chat/completions`, chat("same"), {
      [KEY_HEADER]: "   ",
    });
    expect(blank.headers[KEY_HEADER]).toBe(derived.headers[KEY_HEADER]);
    expect(blank.headers[OCCURRENCE_HEADER]).toBe("1");
  });

  it("an explicit key changes the verdict sequence, not just the label", async () => {
    const plain = await start({ chaos: { dropRate: 0.5, seed: "keyverdict" } });
    const derived = await sequence(plain.url, "hello", 20);

    // An implementation that echoes the override but still keys off the
    // request gives every override the derived sequence. One override can
    // match it by chance; a sample of them all matching cannot be chance.
    const grouped = await start({ chaos: { dropRate: 0.5, seed: "keyverdict" } });
    const pinned = new Map<string, Outcome[]>();
    const shapes = new Set<string>([derived.join(",")]);
    for (let i = 0; i < 6; i++) {
      const label = `pinned-${i}`;
      const outcomes = await sequence(grouped.url, "hello", 20, { [KEY_HEADER]: label });
      pinned.set(label, outcomes);
      shapes.add(outcomes.join(","));
    }
    expect(shapes.size).toBeGreaterThan(1);

    const replay = await start({ chaos: { dropRate: 0.5, seed: "keyverdict" } });
    for (const [label, outcomes] of pinned) {
      expect(
        await sequence(replay.url, "hello", 20, { [KEY_HEADER]: label }),
        `${label} did not replay`,
      ).toEqual(outcomes);
    }
  });
});

describe("seed precedence", () => {
  function seededFixture(seed: string | number): Fixture[] {
    return [
      {
        match: { userMessage: /.*/ },
        response: { content: "ok" },
        chaos: { dropRate: 1, seed },
      },
    ];
  }

  it("the request header overrides the server seed", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "server-seed" } });
    const res = await post(`${url}/v1/chat/completions`, chat("hi"), {
      [SEED_HEADER]: "request-seed",
    });
    expect(res.headers[SEED_HEADER]).toBe("request-seed");
  });

  it("a header seed makes two differently seeded servers agree", async () => {
    const a = await start({ chaos: { dropRate: 0.5, seed: "server-a" } });
    const b = await start({ chaos: { dropRate: 0.5, seed: "server-b" } });
    const first = await sequence(a.url, "hello", 30, { [SEED_HEADER]: "shared" });
    expect(await sequence(b.url, "hello", 30, { [SEED_HEADER]: "shared" })).toEqual(first);
  });

  it("a fixture seed overrides the server seed", async () => {
    const { url } = await start({ chaos: { seed: "server-seed" } }, seededFixture("fixture-seed"));
    const res = await post(`${url}/v1/chat/completions`, chat("hi"));
    expect(res.headers[SEED_HEADER]).toBe("fixture-seed");

    // The reported seed has to be the one the draws came from rather than a
    // label attached afterwards, so run a rate that does not fire every time:
    // two servers sharing only the fixture seed must agree request for request,
    // and the sequence must replay after a rewind.
    const shared = (): Fixture[] => [
      {
        match: { userMessage: /.*/ },
        response: { content: "ok" },
        chaos: { dropRate: 0.5, seed: "shared-fixture" },
      },
    ];
    const a = await start({ chaos: { seed: "server-a" } }, shared());
    const b = await start({ chaos: { seed: "server-b" } }, shared());
    const sequenceA = await sequence(a.url, "hello", 30);
    expect(await sequence(b.url, "hello", 30)).toEqual(sequenceA);

    await request(`${a.url}/__aimock/chaos/reset`, "POST", {});
    expect(await sequence(a.url, "hello", 30)).toEqual(sequenceA);
  });

  it("numeric server and fixture seeds are normalized to decimal strings", async () => {
    for (const value of [4242, 0, -7, 3.5]) {
      const { url } = await start({ chaos: { seed: "server-seed" } }, seededFixture(value));
      const res = await post(`${url}/v1/chat/completions`, chat("hi"));
      expect(res.headers[SEED_HEADER]).toBe(String(value));

      const global = await start({ chaos: { dropRate: 1, seed: value } });
      expect((await chaosReport(global.url)).seed).toBe(String(value));
      const dropped = await post(`${global.url}/v1/chat/completions`, chat("hi"));
      expect(dropped.headers[SEED_HEADER]).toBe(String(value));
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      const fixture = await start({ chaos: { seed: "finite-fallback" } }, seededFixture(value));
      const dropped = await post(`${fixture.url}/v1/chat/completions`, chat("hi"));
      expect(dropped.status).toBe(500);
      expect(dropped.headers[SEED_HEADER]).toBe("finite-fallback");
      const global = await start({ chaos: { seed: value, dropRate: 1 } });
      const generated = (await chaosReport(global.url)).seed as string;
      expect(generated).toEqual(expect.any(String));
      expect(generated.trim()).not.toBe("");
      expect(["NaN", "Infinity", "-Infinity"]).not.toContain(generated);
      for (let occurrence = 0; occurrence < 2; occurrence++) {
        const response = await post(`${global.url}/v1/chat/completions`, chat("hi"));
        expect(response.headers[SEED_HEADER]).toBe(generated);
        expect(response.headers[OCCURRENCE_HEADER]).toBe(String(occurrence));
      }
      expect(
        JSON.parse((await request(`${global.url}/__aimock/chaos/reset`, "POST", {})).body),
      ).toEqual({ reset: true, seed: generated });
    }
  });

  it("the header seed beats the fixture seed", async () => {
    const { url } = await start({ chaos: { seed: "server-seed" } }, seededFixture("fixture-seed"));
    const res = await post(`${url}/v1/chat/completions`, chat("hi"), {
      [SEED_HEADER]: "header-seed",
    });
    expect(res.headers[SEED_HEADER]).toBe("header-seed");

    // A nonblank configured string is opaque, including outer whitespace.
    // The control API and journal retain the original string. Replay through
    // the public server configuration without prescribing how a solver
    // represents characters that HTTP headers cannot carry unchanged.
    for (const seed of [" replay ", "\treplay\t", "snowman ☃", "two\nlines", "\ud800"]) {
      const server = await start({ chaos: { dropRate: 1, seed } });
      expect(server.chaosSeed).toBe(seed);
      expect((await chaosReport(server.url)).seed).toBe(seed);
      const first = await post(`${server.url}/v1/chat/completions`, chat("seed"));
      expect(first.status).toBe(500);
      expect(first.headers[SEED_HEADER]).toEqual(expect.any(String));
      expect(first.headers[OCCURRENCE_HEADER]).toBe("0");
      expect((await journalEntries(server.url)).at(-1)?.response.chaosSeed).toBe(seed);

      const replay = await start({ chaos: { dropRate: 1, seed } });
      const repeated = await post(`${replay.url}/v1/chat/completions`, chat("seed"));
      expect(repeated.status).toBe(first.status);
      expect(repeated.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
      expect(repeated.headers[SEED_HEADER]).toBe(first.headers[SEED_HEADER]);
      expect(repeated.headers[OCCURRENCE_HEADER]).toBe("0");

      const fixture = await start({ chaos: { seed: "server", dropRate: 0 } }, seededFixture(seed));
      const matched = await post(`${fixture.url}/v1/chat/completions`, chat("seed"));
      expect(matched.status).toBe(500);
      expect(matched.headers[SEED_HEADER]).toBe(first.headers[SEED_HEADER]);
      expect((await journalEntries(fixture.url)).at(-1)?.response.chaosSeed).toBe(seed);
      expect(matched.headers[OCCURRENCE_HEADER]).toBe("0");
    }
  });

  it("blank seeds fall through at every precedence level", async () => {
    const plain = await start({ chaos: { dropRate: 1, seed: "fallback" } });
    const server = await post(`${plain.url}/v1/chat/completions`, chat("hi"), {
      [SEED_HEADER]: "  ",
    });
    expect(server.status).toBe(500);
    expect(server.headers[SEED_HEADER]).toBe("fallback");

    // With a fixture in the chain the blank header must land on the fixture.
    const withFixture = await start(
      { chaos: { seed: "server-seed" } },
      seededFixture("fixture-seed"),
    );
    const res = await post(`${withFixture.url}/v1/chat/completions`, chat("hi"), {
      [SEED_HEADER]: "   ",
    });
    expect(res.headers[SEED_HEADER]).toBe("fixture-seed");

    const blankFixture = await start({ chaos: { seed: "server-seed" } }, [
      {
        match: { userMessage: /.*/ },
        response: { content: "ok" },
        chaos: { dropRate: 1, seed: "   " },
      },
    ]);
    expect(
      (await post(`${blankFixture.url}/v1/chat/completions`, chat("hi"))).headers[SEED_HEADER],
    ).toBe("server-seed");

    const blankGlobal = await start({ chaos: { dropRate: 1, seed: "   " } });
    const generated = await post(`${blankGlobal.url}/v1/chat/completions`, chat("hi"));
    expect(generated.headers[SEED_HEADER]).toEqual(expect.any(String));
    expect(generated.headers[SEED_HEADER]).not.toBe("   ");
    await assertCliSeed("");
    await assertCliSeed("   ");
  });

  it("an overridden seed keeps its own occurrence sequence", async () => {
    const plain = await start({ chaos: { dropRate: 0.5, seed: "base" } });
    const baseline = await sequence(plain.url, "hello", 20);

    const mixed = await start({ chaos: { dropRate: 0.5, seed: "base" } });
    const observed: Outcome[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 5 === 0) {
        await post(`${mixed.url}/v1/chat/completions`, chat("hello"), {
          [SEED_HEADER]: "interloper",
        });
      }
      observed.push(classify(await post(`${mixed.url}/v1/chat/completions`, chat("hello"))));
    }
    expect(observed).toEqual(baseline);
  });

  it("counts a seed override as its own tracked key", async () => {
    const { url } = await start({ chaos: { dropRate: 0, seed: "tracked" } });
    await post(`${url}/v1/chat/completions`, chat("hello"));
    await post(`${url}/v1/chat/completions`, chat("hello"), { [SEED_HEADER]: "other" });
    await expectTrackedKeyCount(url, 2);
  });
});

describe("provider endpoints", () => {
  const embedding = { model: "text-embedding-3-small", input: "hi" };
  const message = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  };

  it("seeds chaos on the embeddings endpoint", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "embed" } });
    const res = await post(`${url}/v1/embeddings`, embedding);
    expect(res.status).toBe(500);
    expect(res.headers[SEED_HEADER]).toBe("embed");
    expect(res.headers[KEY_HEADER]).toMatch(HEX16);
    expect(res.headers[OCCURRENCE_HEADER]).toBe("0");
  });

  it("seeds chaos on the messages endpoint", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "messages" } });
    const res = await post(`${url}/v1/messages`, message);
    expect(res.status).toBe(500);
    expect(res.headers[SEED_HEADER]).toBe("messages");
    expect(res.headers[KEY_HEADER]).toMatch(HEX16);
    expect(res.headers[OCCURRENCE_HEADER]).toBe("0");
  });

  it("seeds chaos on the image generation endpoint", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "images" } });
    const res = await post(`${url}/v1/images/generations`, { prompt: "a cat", model: "dall-e-3" });
    expect(res.status).toBe(500);
    expect(res.headers[SEED_HEADER]).toBe("images");
    expect(res.headers[KEY_HEADER]).toMatch(HEX16);
    expect(res.headers[OCCURRENCE_HEADER]).toBe("0");
  });

  it("seeds a malformed response on a provider endpoint", async () => {
    const { url } = await start({ chaos: { malformedRate: 1, seed: "embed-malformed" } });
    const res = await post(`${url}/v1/embeddings`, embedding);
    expect(classify(res)).toBe("malformed");
    expect(res.headers[SEED_HEADER]).toBe("embed-malformed");
    expect(res.headers[OCCURRENCE_HEADER]).toBe("0");
  });

  it("honours a header seed on a provider endpoint", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "embed-server" } });
    const res = await post(`${url}/v1/embeddings`, embedding, {
      [SEED_HEADER]: "embed-request",
    });
    expect(res.headers[SEED_HEADER]).toBe("embed-request");
  });

  /**
   * Every route that injects chaos, including the multipart uploads and the
   * lifecycle polls. The polls roll before they look a job up, so an id that
   * was never created still exercises the decision path.
   */
  const familyRoutes: FamilyRoute[] = (() => {
    const embed = { model: "text-embedding-3-small", input: "hi" };
    const anthropic = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    };
    const missing = "never-created";
    // The fal routes are selected by target host, so each carries its own.
    const falQueue = { "x-fal-target-host": "queue.fal.run" };
    const falSync = { "x-fal-target-host": "fal.run" };
    const falStorage = { "x-fal-target-host": "rest.fal.ai" };
    return [
      { path: "/v1/chat/completions", body: chat("hi") },
      { path: "/v1/embeddings", body: embed },
      {
        path: "/openai/deployments/text-embedding-3-small/embeddings",
        body: { input: "hi" },
      },
      { path: "/v1/messages", body: anthropic },
      { path: "/v1/responses", body: { model: "gpt-4", input: "hi" } },
      { path: "/v1/images/generations", body: { model: "dall-e-3", prompt: "a cat" } },
      {
        path: "/v1/images/edits",
        bytes: () =>
          formData([
            ["model", "dall-e-2"],
            ["prompt", "a cat"],
            ["image", "PNGDATA", "a.png"],
          ]),
      },
      {
        path: "/v1/images/variations",
        bytes: () =>
          formData([
            ["model", "dall-e-2"],
            ["image", "PNGDATA", "a.png"],
          ]),
      },
      { path: "/v1/audio/speech", body: { model: "tts-1", input: "hi", voice: "alloy" } },
      {
        path: "/v1/audio/translations",
        bytes: () =>
          formData([
            ["model", "whisper-1"],
            ["file", "AAAA", "a.wav"],
          ]),
      },
      { path: "/v1/text-to-speech/voice-1", body: { text: "hi" } },
      { path: "/v1/videos", body: { model: "sora-2", prompt: "a cat" } },
      { path: "/v1/videos/generations", body: { prompt: "a cat" } },
      { path: `/v1/videos/${missing}`, method: "GET" },
      { path: "/api/v1/videos", body: { model: "veo-3", prompt: "a cat" } },
      { path: "/api/v1/videos/models", method: "GET" },
      { path: `/api/v1/videos/${missing}`, method: "GET" },
      { path: `/api/v1/videos/${missing}/content`, method: "GET" },
      {
        path: "/api/v3/contents/generations/tasks",
        body: {
          model: "seedance-1-0-pro",
          content: [{ type: "text", text: "a cat" }],
        },
      },
      { path: `/contents/generations/tasks/${missing}`, method: "GET" },
      {
        path: "/v2/chat",
        body: { model: "command-r", messages: [{ role: "user", content: "hi" }] },
      },
      { path: "/v2/embed", body: { model: "embed-v3", texts: ["hi"] } },
      { path: "/api/chat", body: { model: "llama3", messages: [{ role: "user", content: "hi" }] } },
      { path: "/api/generate", body: { model: "llama3", prompt: "hi" } },
      { path: "/api/embeddings", body: { model: "llama3", prompt: "hi" } },
      {
        path: "/v1beta/models/gemini-2.5-flash:generateContent",
        body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      },
      {
        path: "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
        body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      },
      {
        path: "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent",
        body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      },
      {
        path: "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent",
        body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      },
      {
        path: "/v1beta/models/text-embedding-004:embedContent",
        body: { content: { parts: [{ text: "hi" }] } },
      },
      { path: "/v1beta/interactions", body: { model: "gemini-2.5-flash", input: "hi" } },
      {
        path: "/v1beta/models/veo-3.0-generate-001:predictLongRunning",
        body: { instances: [{ prompt: "a cat" }] },
      },
      { path: `/v1beta/operations/${missing}`, method: "GET" },
      {
        path: "/model/anthropic.claude-3-sonnet/invoke",
        body: { messages: [{ role: "user", content: "hi" }], max_tokens: 16 },
      },
      {
        path: "/model/anthropic.claude-3-sonnet/converse",
        body: { messages: [{ role: "user", content: [{ text: "hi" }] }] },
      },
      // The streaming Bedrock routes are separate handlers behind separate
      // paths, so the non-streaming ones above do not reach them.
      {
        path: "/model/anthropic.claude-3-sonnet/invoke-with-response-stream",
        body: { messages: [{ role: "user", content: "hi" }], max_tokens: 16 },
      },
      {
        path: "/model/anthropic.claude-3-sonnet/converse-stream",
        body: { messages: [{ role: "user", content: [{ text: "hi" }] }] },
      },
      // Sound generation and music go through the audio handler, not the
      // text-to-speech one covered above.
      { path: "/v1/sound-generation", body: { text: "a door" } },
      { path: "/v1/music", body: { prompt: "piano" } },
      // The current fal routes, chosen by target host rather than by prefix.
      {
        path: `/fal/fal-ai/flux/dev/requests/${missing}/cancel`,
        method: "PUT",
        body: {},
        headers: falQueue,
      },
      { path: "/fal/fal-ai/flux/dev", body: { input: { prompt: "a cat" } }, headers: falSync },
      {
        path: "/fal/storage/upload/initiate",
        body: { content_type: "image/png" },
        headers: falStorage,
      },
    ];
  })();

  it("replays a fractional run across every provider family after a rewind", async () => {
    const { url } = await start({ chaos: { dropRate: 0.5, seed: "families-replay" } });
    const run = async () => {
      const out: string[] = [];
      for (let round = 0; round < 3; round++) {
        for (const route of familyRoutes) {
          const res = await fireRoute(url, route);
          // The occurrence goes in beside the status: a route that answers the
          // same way whether or not chaos fired still records whether it did.
          out.push(`${route.path}:${res.status}:${res.headers[OCCURRENCE_HEADER] ?? "-"}`);
        }
      }
      return out;
    };
    const first = await run();
    await request(`${url}/__aimock/chaos/reset`, "POST", {});
    expect(await run()).toEqual(first);

    const { mock, url: grokUrl } = await startMock({
      port: 0,
      chaos: { dropRate: 0.5, seed: "grok-status-replay" },
    });
    mock.addFixture({
      match: { userMessage: "status replay", endpoint: "video" },
      response: { video: { id: "vid_grok_replay", status: "completed" } },
    });
    const submit = await post(
      `${grokUrl}/v1/videos/generations`,
      { model: "grok-imagine-video", prompt: "status replay" },
      { "x-aimock-chaos-drop": "0" },
    );
    expect(submit.status).toBe(200);
    const requestId = (JSON.parse(submit.body) as { request_id: string }).request_id;
    const poll = async () => {
      const out: string[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await request(`${grokUrl}/v1/videos/${requestId}`, "GET", null);
        out.push(`${res.status}:${res.headers[OCCURRENCE_HEADER] ?? "-"}`);
      }
      return out;
    };
    const grokFirst = await poll();
    await request(`${grokUrl}/__aimock/chaos/reset`, "POST", {});
    expect(await poll()).toEqual(grokFirst);
  });

  it("seeds chaos the same way on every provider family and route alias", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "families" } });
    const keys = new Set<string>();
    for (const route of familyRoutes) {
      const res = await fireRoute(url, route);
      expect(res.status, `${route.path} was not dropped`).toBe(500);
      expect(res.headers[SEED_HEADER], `${route.path} reported no seed`).toBe("families");
      expect(res.headers[KEY_HEADER], `${route.path} reported no key`).toMatch(HEX16);
      expect(res.headers[OCCURRENCE_HEADER], `${route.path} did not start at 0`).toBe("0");
      keys.add(res.headers[KEY_HEADER] as string);
    }
    expect(keys.size).toBe(familyRoutes.length);
    await expectTrackedKeyCount(url, familyRoutes.length);

    const { mock, url: grokUrl } = await startMock({
      port: 0,
      chaos: { dropRate: 1, seed: "grok-status" },
    });
    mock.addFixture({
      match: { userMessage: "poll status", endpoint: "video" },
      response: { video: { id: "vid_grok_status", status: "completed" } },
    });
    const submit = await post(
      `${grokUrl}/v1/videos/generations`,
      { model: "grok-imagine-video", prompt: "poll status" },
      { "x-aimock-chaos-drop": "0" },
    );
    expect(submit.status).toBe(200);
    const requestId = (JSON.parse(submit.body) as { request_id: string }).request_id;
    const status = await request(`${grokUrl}/v1/videos/${requestId}`, "GET", null);
    expect(status.status).toBe(500);
    expect(status.headers[SEED_HEADER]).toBe("grok-status");
    expect(status.headers[KEY_HEADER]).toMatch(HEX16);
    expect(status.headers[OCCURRENCE_HEADER]).toBe("0");
  });

  it("seeds chaos on the transcription endpoint, keyed by the multipart body", async () => {
    const boundary = "----aimock-transcribe";
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const upload = (name: string) =>
      Buffer.from(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="model"',
          "",
          "whisper-1",
          `--${boundary}`,
          `Content-Disposition: form-data; name="file"; filename="${name}"`,
          "Content-Type: audio/wav",
          "",
          "AAAA",
          `--${boundary}--`,
        ].join(CRLF),
      );

    const certain = await start({ chaos: { dropRate: 1, seed: "transcribe" } });
    const target = `${certain.url}/v1/audio/transcriptions`;
    const first = await postBytes(target, contentType, upload("a.wav"));
    const second = await postBytes(target, contentType, upload("a.wav"));
    expect(first.status).toBe(500);
    expect(first.headers[SEED_HEADER]).toBe("transcribe");
    expect(first.headers[OCCURRENCE_HEADER]).toBe("0");
    expect(second.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
    expect(second.headers[OCCURRENCE_HEADER]).toBe("1");

    const other = await postBytes(target, contentType, upload("b.wav"));
    expect(other.headers[KEY_HEADER]).not.toBe(first.headers[KEY_HEADER]);
    expect(other.headers[OCCURRENCE_HEADER]).toBe("0");

    const fractional = await start({ chaos: { dropRate: 0.5, seed: "transcribe-replay" } });
    const run = async () => {
      const out: number[] = [];
      for (let i = 0; i < 12; i++) {
        out.push(
          (
            await postBytes(
              `${fractional.url}/v1/audio/transcriptions`,
              contentType,
              upload("a.wav"),
            )
          ).status,
        );
      }
      return out;
    };
    const before = await run();
    await request(`${fractional.url}/__aimock/chaos/reset`, "POST", {});
    expect(await run()).toEqual(before);
  });

  it("keys each endpoint separately", async () => {
    const { url } = await start({ chaos: { dropRate: 1, seed: "perendpoint" } });
    const chatRes = await post(`${url}/v1/chat/completions`, chat("hi"));
    const embedRes = await post(`${url}/v1/embeddings`, embedding);
    const messageRes = await post(`${url}/v1/messages`, message);
    const keys = new Set([
      chatRes.headers[KEY_HEADER],
      embedRes.headers[KEY_HEADER],
      messageRes.headers[KEY_HEADER],
    ]);
    expect(keys.size).toBe(3);
    expect(embedRes.headers[OCCURRENCE_HEADER]).toBe("0");
    await expectTrackedKeyCount(url, 3);
  });

  it("reproduces a mixed-endpoint run from the seed", async () => {
    const run = async () => {
      const { url } = await start({ chaos: { dropRate: 0.5, seed: "mixed-endpoints" } });
      const out: string[] = [];
      for (let i = 0; i < 12; i++) {
        out.push(String((await post(`${url}/v1/chat/completions`, chat("hi"))).status));
        out.push(String((await post(`${url}/v1/embeddings`, embedding)).status));
      }
      return out;
    };
    const first = await run();
    expect(await run()).toEqual(first);
  });
});

describe("injectable stream jitter", () => {
  const profile = { ttft: 100, tps: 10, jitter: 0.5 };

  it("uses the supplied draw instead of Math.random", () => {
    expect(sseWriter.calculateDelay(1, profile, 0, undefined, 1, () => 0)).toBeCloseTo(50, 6);
    expect(sseWriter.calculateDelay(1, profile, 0, undefined, 1, () => 0.25)).toBeCloseTo(75, 6);
    expect(sseWriter.calculateDelay(1, profile, 0, undefined, 1, () => 0.5)).toBeCloseTo(100, 6);
    expect(sseWriter.calculateDelay(1, profile, 0, undefined, 1, () => 0.75)).toBeCloseTo(125, 6);
  });

  it("passes the chunk index to the source", async () => {
    const seen: number[] = [];
    const source = (chunkIndex: number) => {
      seen.push(chunkIndex);
      return 0.5;
    };
    for (let i = 0; i < 5; i++) {
      sseWriter.calculateDelay(i, profile, 0, undefined, 1, source);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);

    const stream = new PassThrough();
    stream.resume();
    const res = {
      setHeader() {},
      writeHead() {},
      write(data: string) {
        stream.write(data);
      },
      end(data?: string) {
        if (data !== undefined) stream.write(data);
        stream.end();
      },
    } as unknown as http.ServerResponse;
    const chunks: SSEChunk[] = [0, 1, 2].map((i) => ({
      id: `c${i}`,
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4",
      choices: [{ index: 0, delta: { content: `t${i}` }, finish_reason: null }],
    })) as unknown as SSEChunk[];
    const jitterSource = vi.fn<(chunkIndex: number) => number>(() => 0.5);
    await sseWriter.writeSSEStream(res, chunks, {
      streamingProfile: { ttft: 0, tps: 10000, jitter: 0.5 },
      jitterSource,
    });
    expect(jitterSource.mock.calls.map((call) => call[0])).toEqual([0, 1, 2]);
  });

  it("applies the same band to the first chunk's ttft", () => {
    expect(sseWriter.calculateDelay(0, profile, 0, undefined, 1, () => 0)).toBeCloseTo(50, 6);
    expect(sseWriter.calculateDelay(0, profile, 0, undefined, 1, () => 0.75)).toBeCloseTo(125, 6);
  });

  it("divides by the replay speed after jittering", () => {
    const single = sseWriter.calculateDelay(3, profile, 0, undefined, 1, () => 0.75);
    const double = sseWriter.calculateDelay(3, profile, 0, undefined, 2, () => 0.75);
    expect(double).toBeCloseTo(single / 2, 6);
  });

  it("ignores the source when jitter is not configured", () => {
    const flat = { ttft: 100, tps: 10, jitter: 0 };
    expect(sseWriter.calculateDelay(1, flat, 0, undefined, 1, () => 0)).toBe(100);
    expect(sseWriter.calculateDelay(1, flat, 0, undefined, 1, () => 0.75)).toBe(100);
    expect(sseWriter.calculateDelay(1, profile, 0, undefined, 1, () => 0)).toBeCloseTo(50, 6);
  });

  it("ignores the source for a delay that did not come from the profile", () => {
    const fallbackOnly = { jitter: 0.5 };
    const refuse = () => {
      throw new Error("the jitter source must not be consulted here");
    };
    expect(sseWriter.calculateDelay(1, fallbackOnly, 80, undefined, 1, refuse)).toBe(80);

    // Recorded timings replay measured spacing, so jitter has no part in them.
    const recorded = { ttftMs: 25, interChunkDelaysMs: [5, 7], totalDurationMs: 37 };
    expect(sseWriter.calculateDelay(0, undefined, 99, recorded, 1, refuse)).toBe(25);
    expect(sseWriter.calculateDelay(2, undefined, 99, recorded, 1, refuse)).toBe(7);

    const fromProfile = { tps: 10, jitter: 0.5 };
    expect(sseWriter.calculateDelay(1, fromProfile, 80, undefined, 1, () => 0.75)).toBeCloseTo(
      125,
      6,
    );
  });

  it("is unreproducible without a source and reproducible with one", async () => {
    // Omitting the source must still reach Math.random rather than some fixed
    // stand-in, so drive it with known draws and read the delays back.
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValueOnce(0).mockReturnValueOnce(0.75).mockReturnValueOnce(0.25);
      expect(sseWriter.calculateDelay(1, profile, 0, undefined, 1)).toBeCloseTo(50, 6);
      expect(sseWriter.calculateDelay(1, profile, 0, undefined, 1)).toBeCloseTo(125, 6);
      expect(sseWriter.calculateDelay(1, profile, 0, undefined, 1)).toBeCloseTo(75, 6);
      expect(random).toHaveBeenCalledTimes(3);
    } finally {
      random.mockRestore();
    }

    const source = jitterFactory()("fixed", "key");
    const untouched = vi.spyOn(Math, "random");
    try {
      const seeded = new Set(
        Array.from({ length: 60 }, () =>
          sseWriter.calculateDelay(1, profile, 0, undefined, 1, source),
        ),
      );
      expect(seeded.size).toBe(1);
      // A supplied source replaces Math.random rather than sitting beside it.
      expect(untouched).not.toHaveBeenCalled();
    } finally {
      untouched.mockRestore();
    }
    await assertRequestJitter();
  }, 60000);

  it("exposes a seeded source that is pure in its seed and key", () => {
    const create = jitterFactory();
    expect(newExport(publicApi, "createJitterSource", "src/index.ts")).toBe(create);
    const left = create("s", "k");
    const right = create("s", "k");
    for (let i = 0; i < 20; i++) expect(right(i)).toBe(left(i));
    const expected = Array.from({ length: 20 }, (_, index) => create("s", "k")(index));
    for (const index of [19, 0, 7, 7, 1, 19, 0]) expect(left(index)).toBe(expected[index]);
  });

  it("draws jitter inside the unit interval", () => {
    const source = jitterFactory()("range", "key");
    for (let i = 0; i < 200; i++) {
      expect(source(i)).toBeGreaterThanOrEqual(0);
      expect(source(i)).toBeLessThan(1);
    }
  });

  it("varies the seeded source by chunk index", () => {
    const source = jitterFactory()("chunks", "key");
    const values = Array.from({ length: 40 }, (_, i) => source(i));
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it("varies the seeded source by seed", () => {
    const create = jitterFactory();
    const values = Array.from({ length: 12 }, (_, i) => create(`seed-${i}`, "key")(0));
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it("varies the seeded source by key", async () => {
    const create = jitterFactory();
    const values = Array.from({ length: 12 }, (_, i) => create("seed", `key-${i}`)(0));
    expect(new Set(values).size).toBeGreaterThan(1);
    await assertDerivedRequestJitter();
  }, 60000);
});
