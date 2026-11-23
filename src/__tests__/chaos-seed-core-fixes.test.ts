/**
 * Fixes to the seeded-chaos core found in review of #618:
 *
 *   1. A seed the server reports must replay byte-for-byte through the seed
 *      header, and a repeated seed header with conflicting values warns.
 *   2. An unseeded verdict carries no seeded origin and no seeded jitter, even
 *      after a seeded verdict earlier in the same request scope.
 *   3. Direct callers (no server) can reset the seeded occurrence counters.
 *   4. An invalid seed handed in through `resolved` warns.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer, type ServerInstance } from "../server.js";
import { evaluateChaos, applyChaos, applyChaosAction } from "../chaos.js";
import { currentChaosJitter, currentChaosOrigin, runInChaosRequestScope } from "../chaos-random.js";
import { Journal } from "../journal.js";
import type { ChaosAction, ChaosConfig, Fixture, MockServerOptions } from "../types.js";

const SEED_HEADER = "x-aimock-chaos-seed";
const KEY_HEADER = "x-aimock-chaos-key";
const OCCURRENCE_HEADER = "x-aimock-chaos-occurrence";

const FIXTURES: Fixture[] = [{ match: { userMessage: "alpha" }, response: { content: "A" } }];

const servers: ServerInstance[] = [];
const plainServers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    ...servers.splice(0).map((s) => new Promise<void>((done) => s.server.close(() => done()))),
    ...plainServers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))),
  ]);
});

async function start(options: MockServerOptions = {}): Promise<string> {
  const instance = await createServer(structuredClone(FIXTURES), { port: 0, ...options });
  servers.push(instance);
  return instance.url;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  url: string,
  method: string,
  body: string | null,
  headers: http.OutgoingHttpHeaders = {},
): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = http.request(
      url,
      { method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolveReply({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function chat(url: string, headers: http.OutgoingHttpHeaders = {}): Promise<Reply> {
  return request(
    `${url}/v1/chat/completions`,
    "POST",
    JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "alpha" }] }),
    headers,
  );
}

/** Every line the servers' loggers (and anything else) printed through console.warn. */
function captureWarnings(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

describe("finding 1: a reported seed replays byte-for-byte through the seed header", () => {
  it("the runtime control refuses a seed the header could not carry (a comma)", async () => {
    const url = await start();
    const reply = await request(
      `${url}/__aimock/chaos`,
      "POST",
      JSON.stringify({ seed: "run,7", dropRate: 1 }),
    );
    expect(reply.status).toBe(400);
  });

  it("a server seed with a comma is rejected, never reported", async () => {
    const warnings = captureWarnings();
    const url = await start({ chaos: { seed: "run,7", dropRate: 1 }, logLevel: "warn" });
    const reply = await chat(url);
    expect(reply.status).toBe(500);
    expect(reply.headers[SEED_HEADER]).toBeUndefined();
    expect(warnings.join("\n")).toContain("run,7");
  });

  it("every seed a server reports replays to the same verdict through the header", async () => {
    const seeded = await start({ chaos: { seed: "ci-run_7.a/b", dropRate: 1 } });
    const first = await chat(seeded);
    const reported = first.headers[SEED_HEADER];
    expect(reported).toBe("ci-run_7.a/b");

    const fresh = await start({ chaos: { dropRate: 1 } });
    const replay = await chat(fresh, { [SEED_HEADER]: String(reported) });
    expect(replay.headers[SEED_HEADER]).toBe(reported);
    expect(replay.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
    expect(replay.headers[OCCURRENCE_HEADER]).toBe(first.headers[OCCURRENCE_HEADER]);
  });

  it("a seed header carrying a comma is not silently shortened", async () => {
    const warnings = captureWarnings();
    const url = await start({ chaos: { dropRate: 1 }, logLevel: "warn" });
    await chat(url, { [SEED_HEADER]: "run,7" });
    expect(warnings.join("\n")).toMatch(/x-aimock-chaos-seed.*conflicting values/);
  });

  it("a repeated seed header with conflicting values warns and uses the first", async () => {
    const warnings = captureWarnings();
    const url = await start({ chaos: { dropRate: 1 }, logLevel: "warn" });
    const reply = await chat(url, { [SEED_HEADER]: ["first-seed", "second-seed"] });
    expect(reply.headers[SEED_HEADER]).toBe("first-seed");
    const text = warnings.join("\n");
    expect(text).toContain(SEED_HEADER);
    expect(text).toContain("repeated header with conflicting values");
  });

  it("a repeated seed header that agrees does not warn", async () => {
    const warnings = captureWarnings();
    const url = await start({ chaos: { dropRate: 1 }, logLevel: "warn" });
    const reply = await chat(url, { [SEED_HEADER]: ["same-seed", "same-seed"] });
    expect(reply.headers[SEED_HEADER]).toBe("same-seed");
    expect(warnings.join("\n")).not.toContain("conflicting");
  });
});

/** Serve one request on a plain Node server, running `handle` inside a chaos request scope. */
async function serveOnce(
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Reply> {
  const server = http.createServer((req, res) => {
    runInChaosRequestScope(() => handle(req, res));
  });
  plainServers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  return request(`http://127.0.0.1:${port}/v1/chat/completions`, "POST", "{}");
}

const CONTEXT = { method: "POST", path: "/v1/chat/completions", headers: {}, body: null };

describe("finding 2: an unseeded verdict never inherits a seeded origin", () => {
  it("applyChaos: seeded decision then unseeded hit in one scope reports no seed and uses Math.random", async () => {
    const journal = new Journal();
    let jitterAfter: unknown = "unset";
    let originAfter: unknown = "unset";
    let randomCalls = -1;
    const reply = await serveOnce((req, res) => {
      // A seeded verdict that does not fire: it records origin and jitter in the scope.
      const seededResolved: ChaosConfig = { seed: "seeded-earlier", dropRate: 0.000001 };
      evaluateChaos(null, undefined, req.headers, undefined, req.url, seededResolved);
      expect(currentChaosOrigin()).toBeDefined();
      const random = vi.spyOn(Math, "random");
      const applied = applyChaos(
        res,
        null,
        undefined,
        req.headers,
        req.url,
        journal,
        CONTEXT,
        "internal",
        undefined,
        undefined,
        { dropRate: 1 },
      );
      randomCalls = random.mock.calls.length;
      random.mockRestore();
      jitterAfter = currentChaosJitter();
      originAfter = currentChaosOrigin();
      expect(applied).toBe(true);
    });
    expect(reply.status).toBe(500);
    expect(reply.headers[SEED_HEADER]).toBeUndefined();
    expect(reply.headers[KEY_HEADER]).toBeUndefined();
    expect(reply.headers[OCCURRENCE_HEADER]).toBeUndefined();
    const entry = journal.getAll()[0];
    expect(entry?.response.chaosAction).toBe("drop");
    expect(entry?.response).not.toHaveProperty("chaosSeed");
    expect(entry?.response).not.toHaveProperty("chaosKey");
    expect(entry?.response).not.toHaveProperty("chaosOccurrence");
    expect(randomCalls).toBe(1);
    expect(jitterAfter).toBeUndefined();
    expect(originAfter).toBeUndefined();
  });

  it("split gate: seeded then unseeded evaluateChaos, then applyChaosAction, reports no seed", async () => {
    const journal = new Journal();
    const reply = await serveOnce((req, res) => {
      evaluateChaos(null, undefined, req.headers, undefined, req.url, {
        seed: "seeded-earlier",
        dropRate: 0.000001,
      });
      const action = evaluateChaos(null, undefined, req.headers, undefined, req.url, {
        dropRate: 1,
      });
      expect(action).toBe("drop");
      applyChaosAction(
        action as ChaosAction,
        res,
        null,
        journal,
        CONTEXT,
        "internal",
        undefined,
        undefined,
      );
    });
    expect(reply.status).toBe(500);
    expect(reply.headers[SEED_HEADER]).toBeUndefined();
    expect(journal.getAll()[0]?.response).not.toHaveProperty("chaosSeed");
  });
});
