/**
 * Seeded, reproducible chaos verdicts (`chaos.seed`, `--chaos-seed`,
 * `x-aimock-chaos-seed`).
 *
 * The properties are stated as relationships between runs, not as literal
 * draw values, so any correct keyed design satisfies them. Design and first
 * version of these scenarios by AnshulBhati01 in #618.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type ServerInstance } from "../server.js";
import type { ChaosConfig, Fixture, MockServerOptions } from "../types.js";

const SEED_HEADER = "x-aimock-chaos-seed";
const KEY_HEADER = "x-aimock-chaos-key";
const OCCURRENCE_HEADER = "x-aimock-chaos-occurrence";

type Outcome = "ok" | "drop" | "malformed" | "rateLimit" | "disconnect" | `other:${number}`;

interface Probe {
  outcome: Outcome;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const FIXTURES: Fixture[] = [
  { match: { userMessage: "alpha" }, response: { content: "A" } },
  { match: { userMessage: "beta" }, response: { content: "B" } },
  { match: { userMessage: "gamma" }, response: { content: "C" } },
  { match: { userMessage: "noise" }, response: { content: "N" } },
];

const servers: ServerInstance[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((done) => s.server.close(() => done()))),
  );
});

async function start(options: MockServerOptions = {}, fixtures = FIXTURES): Promise<string> {
  // A full reset empties the fixtures array it was given, so each server gets its own copy.
  const instance = await createServer(structuredClone(fixtures), { port: 0, ...options });
  servers.push(instance);
  return instance.url;
}

function rawRequest(
  url: string,
  method: string,
  body: string | null,
  headers: Record<string, string> = {},
): Promise<Probe> {
  return new Promise((resolveProbe) => {
    const req = http.request(
      url,
      { method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", () =>
          resolveProbe({ outcome: "disconnect", status: 0, headers: {}, body: "" }),
        );
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString();
          let outcome: Outcome;
          if (status === 500 && text.includes("chaos_drop")) outcome = "drop";
          else if (status === 429 && text.includes("chaos_ratelimit")) outcome = "rateLimit";
          else if (status === 200 && text.includes("<<<chaos>>>")) outcome = "malformed";
          else if (status === 200) outcome = "ok";
          else outcome = `other:${status}`;
          resolveProbe({ outcome, status, headers: res.headers, body: text });
        });
      },
    );
    req.on("error", () =>
      resolveProbe({ outcome: "disconnect", status: 0, headers: {}, body: "" }),
    );
    if (body !== null) req.write(body);
    req.end();
  });
}

function chat(url: string, message: string, headers: Record<string, string> = {}): Promise<Probe> {
  return rawRequest(
    `${url}/v1/chat/completions`,
    "POST",
    JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: message }] }),
    headers,
  );
}

/** Send `messages` one at a time, in order, and return each outcome. */
async function run(
  url: string,
  messages: string[],
  headers: Record<string, string> = {},
): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const m of messages) out.push((await chat(url, m, headers)).outcome);
  return out;
}

const RATES: ChaosConfig = {
  dropRate: 0.2,
  malformedRate: 0.2,
  rateLimitRate: 0.2,
  disconnectRate: 0.2,
};

/** 36 requests over three keys, interleaved. */
const SEQUENCE = Array.from({ length: 36 }, (_, i) => ["alpha", "beta", "gamma"][i % 3]);

async function controlChaos(
  url: string,
  method: "GET" | "POST" | "DELETE",
  body?: object,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const probe = await rawRequest(
    `${url}/__aimock/chaos`,
    method,
    body === undefined ? null : JSON.stringify(body),
    headers,
  );
  return { status: probe.status, json: probe.body ? JSON.parse(probe.body) : null };
}

describe("seeded chaos: reproducibility", () => {
  it("two fresh servers with the same seed produce the same verdict sequence", async () => {
    const a = await start({ chaos: { ...RATES, seed: "replay-me" } });
    const b = await start({ chaos: { ...RATES, seed: "replay-me" } });
    const first = await run(a, SEQUENCE);
    const second = await run(b, SEQUENCE);
    expect(second).toEqual(first);
    // Every action kind is exercised, so this is not a vacuous all-"ok" match.
    for (const kind of ["ok", "drop", "malformed", "rateLimit", "disconnect"] as const) {
      expect(first).toContain(kind);
    }
  });

  it("different seeds give different sequences", async () => {
    const a = await start({ chaos: { ...RATES, seed: "seed-one" } });
    const b = await start({ chaos: { ...RATES, seed: "seed-two" } });
    expect(await run(b, SEQUENCE)).not.toEqual(await run(a, SEQUENCE));
  });

  it("accepts a numeric seed and treats it as its decimal string", async () => {
    const a = await start({ chaos: { ...RATES, seed: 42 } });
    const b = await start({ chaos: { ...RATES, seed: "42" } });
    expect(await run(b, SEQUENCE)).toEqual(await run(a, SEQUENCE));
  });

  it("an unrelated request inserted mid-sequence does not change the keyed verdicts", async () => {
    const plain = await start({ chaos: { ...RATES, seed: "order" } });
    const noisy = await start({ chaos: { ...RATES, seed: "order" } });
    const baseline = await run(plain, SEQUENCE);

    const withNoise: Outcome[] = [];
    for (let i = 0; i < SEQUENCE.length; i++) {
      if (i % 5 === 2) await chat(noisy, "noise");
      withNoise.push((await chat(noisy, SEQUENCE[i])).outcome);
    }
    expect(withNoise).toEqual(baseline);
  });

  it("raising one rate does not reshuffle which requests another rate picks", async () => {
    const low = await start({ chaos: { malformedRate: 0.3, seed: "streams" } });
    const high = await start({
      chaos: { malformedRate: 0.3, disconnectRate: 0.5, seed: "streams" },
    });
    const lowRun = await run(low, SEQUENCE);
    const highRun = await run(high, SEQUENCE);
    // malformed is checked before disconnect, so every malformed verdict stays put.
    lowRun.forEach((outcome, i) => {
      if (outcome === "malformed") expect(highRun[i]).toBe("malformed");
    });
  });
});

describe("seeded chaos: seed sources", () => {
  it("the x-aimock-chaos-seed header seeds an otherwise unseeded server", async () => {
    const a = await start({ chaos: RATES });
    const b = await start({ chaos: RATES });
    const header = { [SEED_HEADER]: "from-header" };
    expect(await run(b, SEQUENCE, header)).toEqual(await run(a, SEQUENCE, header));
  });

  it("the header seed overrides the server seed", async () => {
    const a = await start({ chaos: { ...RATES, seed: "server-a" } });
    const b = await start({ chaos: { ...RATES, seed: "server-b" } });
    const header = { [SEED_HEADER]: "shared" };
    expect(await run(b, SEQUENCE, header)).toEqual(await run(a, SEQUENCE, header));
  });

  it("a fixture seed overrides the server seed", async () => {
    const seeded = FIXTURES.map((f) => ({ ...f, chaos: { seed: "fixture-seed" } }));
    const a = await start({ chaos: { ...RATES, seed: "server-a" } }, seeded);
    const b = await start({ chaos: { ...RATES, seed: "server-b" } }, seeded);
    expect(await run(b, SEQUENCE)).toEqual(await run(a, SEQUENCE));
  });

  it("the runtime control sets, echoes and replays the seed", async () => {
    const a = await start();
    const b = await start();
    for (const url of [a, b]) {
      const set = await controlChaos(url, "POST", { ...RATES, seed: "runtime" });
      expect(set.status).toBe(200);
      expect(set.json).toEqual({ chaos: { ...RATES, seed: "runtime" } });
      const got = await controlChaos(url, "GET");
      expect(got.json).toEqual({ chaos: { ...RATES, seed: "runtime" } });
    }
    expect(await run(b, SEQUENCE)).toEqual(await run(a, SEQUENCE));
  });

  it("the runtime control rejects an unusable seed with 400", async () => {
    const url = await start();
    for (const seed of ["", "   ", "has space", true, {}, Number.NaN]) {
      const res = await controlChaos(url, "POST", { dropRate: 1, seed });
      expect(res.status, JSON.stringify(seed)).toBe(400);
    }
  });
});

describe("seeded chaos: the occurrence registry", () => {
  it("re-installing chaos through the runtime control rewinds the sequence", async () => {
    const url = await start();
    await controlChaos(url, "POST", { ...RATES, seed: "rewind" });
    const first = await run(url, SEQUENCE);
    expect(first).toContain("drop");
    await controlChaos(url, "POST", { ...RATES, seed: "rewind" });
    expect(await run(url, SEQUENCE)).toEqual(first);
  });

  it("a full reset rewinds the sequence", async () => {
    const url = await start({ chaos: { ...RATES, seed: "reset" } });
    // A full reset also empties the fixtures, so a request chaos spares is a 404
    // after it instead of a 200. Compare the chaos verdicts only.
    const verdicts = (outcomes: Outcome[]) =>
      outcomes.map((o) => (o === "ok" || o === "other:404" ? "spared" : o));
    const first = verdicts(await run(url, SEQUENCE));
    expect((await rawRequest(`${url}/__aimock/reset`, "POST", null)).status).toBe(200);
    expect(verdicts(await run(url, SEQUENCE))).toEqual(first);
  });

  it("without a reset the sequence moves on rather than repeating", async () => {
    const url = await start({ chaos: { dropRate: 0.5, seed: "moves-on" } });
    const occurrences: string[] = [];
    for (let i = 0; i < 4; i++) {
      const probe = await chat(url, "alpha", { "x-aimock-chaos-drop": "1" });
      occurrences.push(String(probe.headers[OCCURRENCE_HEADER]));
    }
    expect(occurrences).toEqual(["0", "1", "2", "3"]);
  });

  it("respects chaosKeysMax: the least recently used key is evicted first", async () => {
    const url = await start({ chaos: { dropRate: 1, seed: "cap" }, chaosKeysMax: 2 });
    const occurrence = async (m: string) => String((await chat(url, m)).headers[OCCURRENCE_HEADER]);
    expect(await occurrence("alpha")).toBe("0");
    expect(await occurrence("beta")).toBe("0");
    expect(await occurrence("alpha")).toBe("1"); // alpha is now most recent
    expect(await occurrence("gamma")).toBe("0"); // evicts beta, the LRU key
    expect(await occurrence("alpha")).toBe("2"); // alpha survived
    expect(await occurrence("beta")).toBe("0"); // beta was evicted and restarts
  });
});

describe("seeded chaos: reporting on a chaos hit", () => {
  it("puts the seed, key and occurrence on the response and in the journal", async () => {
    const instance = await createServer(structuredClone(FIXTURES), {
      port: 0,
      chaos: { dropRate: 1, seed: "report" },
    });
    servers.push(instance);
    const probe = await chat(instance.url, "alpha");
    expect(probe.outcome).toBe("drop");
    expect(probe.headers[SEED_HEADER]).toBe("report");
    expect(probe.headers[KEY_HEADER]).toMatch(/^[0-9a-f]{16}$/);
    expect(probe.headers[OCCURRENCE_HEADER]).toBe("0");
    const entry = instance.journal.getAll().at(-1);
    expect(entry?.response).toMatchObject({
      chaosAction: "drop",
      chaosSeed: "report",
      chaosKey: probe.headers[KEY_HEADER],
      chaosOccurrence: 0,
    });
  });

  it("keys the request by its body, not by headers", async () => {
    const url = await start({ chaos: { dropRate: 1, seed: "keys" } });
    const a = await chat(url, "alpha", { "x-unrelated": "1" });
    const b = await chat(url, "alpha", { "x-unrelated": "2" });
    const c = await chat(url, "beta");
    expect(b.headers[KEY_HEADER]).toBe(a.headers[KEY_HEADER]);
    expect(c.headers[KEY_HEADER]).not.toBe(a.headers[KEY_HEADER]);
  });
});

describe("seeded chaos: other provider surfaces", () => {
  it("replays on the Anthropic messages and embeddings endpoints", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "alpha" }, response: { content: "A" } },
      { match: { inputText: "embed-me" }, response: { embedding: [0.1, 0.2] } },
    ];
    const send = async (url: string): Promise<Outcome[]> => {
      const out: Outcome[] = [];
      for (let i = 0; i < 16; i++) {
        const messages = await rawRequest(
          `${url}/v1/messages`,
          "POST",
          JSON.stringify({
            model: "claude-3",
            max_tokens: 10,
            messages: [{ role: "user", content: "alpha" }],
          }),
        );
        const embeddings = await rawRequest(
          `${url}/v1/embeddings`,
          "POST",
          JSON.stringify({ model: "text-embedding-3-small", input: "embed-me" }),
        );
        out.push(messages.outcome, embeddings.outcome);
      }
      return out;
    };
    const a = await start({ chaos: { dropRate: 0.5, seed: "providers" } }, fixtures);
    const b = await start({ chaos: { dropRate: 0.5, seed: "providers" } }, fixtures);
    const first = await send(a);
    expect(await send(b)).toEqual(first);
    expect(first).toContain("drop");
    expect(first).toContain("ok");
  });
});

describe("seeded chaos: streaming jitter", () => {
  it("a seeded stream draws its jitter from the seed, not Math.random", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "stream" },
        response: { content: "abcdefghijklmnopqrstuvwxyz" },
        chunkSize: 2,
        streamingProfile: { ttft: 1, tps: 1000, jitter: 0.5 },
      },
    ];
    const url = await start({ chaos: { seed: "jitter" } }, fixtures);
    const random = vi.spyOn(Math, "random");
    const probe = await rawRequest(
      `${url}/v1/chat/completions`,
      "POST",
      JSON.stringify({
        model: "gpt-4",
        stream: true,
        messages: [{ role: "user", content: "stream" }],
      }),
    );
    expect(probe.status).toBe(200);
    expect(probe.body).toContain("[DONE]");
    expect(random).not.toHaveBeenCalled();
  });
});

describe("unseeded chaos is unchanged", () => {
  it("adds no header, journal field or metric when no seed is set", async () => {
    const instance = await createServer(structuredClone(FIXTURES), {
      port: 0,
      metrics: true,
      chaos: { dropRate: 1 },
    });
    servers.push(instance);
    const probe = await chat(instance.url, "alpha");
    expect(probe.outcome).toBe("drop");
    const chaosHeaders = Object.keys(probe.headers).filter((h) => h.startsWith("x-aimock-chaos"));
    expect(chaosHeaders).toEqual([]);
    const entry = instance.journal.getAll().at(-1);
    expect(Object.keys(entry?.response ?? {}).sort()).toEqual(
      ["chaosAction", "fixture", "source", "status"].sort(),
    );
    const metrics = await rawRequest(`${instance.url}/metrics`, "GET", null);
    expect(metrics.body).not.toMatch(/seed|occurrence/i);
  });

  it("still decides through Math.random, one draw per configured rate", async () => {
    const url = await start({ chaos: { dropRate: 0.5, malformedRate: 0.5 } });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect((await chat(url, "alpha")).outcome).toBe("ok");
    expect(random).toHaveBeenCalledTimes(2);
    random.mockReturnValue(0);
    expect((await chat(url, "alpha")).outcome).toBe("drop");
  });
});

// ─── CLI ────────────────────────────────────────────────────────────────────

const CLI_PATH = resolve(__dirname, "../../dist/cli.js");

function spawnCli(args: string[]): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolveStart, reject) => {
    const child = execFile("node", [CLI_PATH, ...args]);
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI did not start: ${out}`));
    }, 10_000);
    const onData = (d: Buffer | string) => {
      out += String(d);
      const m = /listening on (http:\/\/\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolveStart({ url: m[1], child });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`CLI exited: ${out}`));
    });
  });
}

describe.skipIf(!existsSync(CLI_PATH))("seeded chaos: --chaos-seed", () => {
  it("two CLI servers started with the same --chaos-seed replay the same verdicts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chaos-seed-cli-"));
    const children: ChildProcess[] = [];
    try {
      const fixturePath = join(dir, "fixtures.json");
      writeFileSync(fixturePath, JSON.stringify({ fixtures: FIXTURES }));
      const args = ["--fixtures", fixturePath, "--port", "0", "--chaos-drop", "0.5"];
      const a = await spawnCli([...args, "--chaos-seed", "cli-seed"]);
      children.push(a.child);
      const b = await spawnCli([...args, "--chaos-seed", "cli-seed"]);
      children.push(b.child);
      const first = await run(a.url, SEQUENCE);
      expect(await run(b.url, SEQUENCE)).toEqual(first);
      expect(first).toContain("drop");
      expect(first).toContain("ok");
    } finally {
      for (const c of children) {
        c.removeAllListeners("exit");
        c.kill();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
