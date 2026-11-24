/**
 * Seeded chaos: two crash fixes (CR round 3 of #618), over the real server.
 *
 * 1. A seeded request with a deeply nested JSON body is keyed, not crashed:
 *    the body canonicalizer has no recursion depth limit.
 * 2. A BigInt seed (untyped JS config) is rejected with a warning; the warning
 *    itself does not throw.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture, MockServerOptions } from "../types.js";

const SEED_HEADER = "x-aimock-chaos-seed";
const KEY_HEADER = "x-aimock-chaos-key";

const FIXTURES: Fixture[] = [{ match: { userMessage: "alpha" }, response: { content: "A" } }];

interface Probe {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: ServerInstance[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((done) => s.server.close(() => done()))),
  );
});

async function start(
  options: MockServerOptions = {},
  fixtures: Fixture[] = FIXTURES,
): Promise<string> {
  const instance = await createServer(
    fixtures.map((f) => ({ ...f })),
    { port: 0, ...options },
  );
  servers.push(instance);
  return instance.url;
}

function rawRequest(
  url: string,
  method: string,
  body: string | null,
  headers: Record<string, string> = {},
): Promise<Probe> {
  return new Promise((resolveProbe, reject) => {
    const req = http.request(
      url,
      { method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolveProbe({
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

function chatBody(extra = ""): string {
  return `{"model":"gpt-4","messages":[{"role":"user","content":"alpha"}]${extra}}`;
}

function chat(url: string, body: string, headers: Record<string, string> = {}): Promise<Probe> {
  return rawRequest(`${url}/v1/chat/completions`, "POST", body, headers);
}

function warnings(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => call.map(String).join(" "));
}

// ─── 1. deep bodies ─────────────────────────────────────────────────────────

describe("a seeded request with a deeply nested body", () => {
  // Deep enough to overflow a recursive canonicalizer (~2k levels), but below
  // the depth at which JSON.stringify overflows on Node 20-24 (~5.8k levels),
  // which the request journal hits on every served request.
  const DEPTH = 3_500;
  const deep = chatBody(`,"deep":${"[".repeat(DEPTH)}${"]".repeat(DEPTH)}`);

  it("is served unseeded (control)", async () => {
    const url = await start();
    const probe = await chat(url, deep);
    expect(probe.status).toBe(200);
  });

  it("is served seeded, with no chaos rolled", async () => {
    const url = await start();
    const probe = await chat(url, deep, { [SEED_HEADER]: "s1" });
    expect(probe.status).toBe(200);
    expect(probe.body).toContain('"A"');
  });

  it("gets a stable key when chaos fires", async () => {
    const url = await start();
    const headers = { [SEED_HEADER]: "s1", "x-aimock-chaos-drop": "1" };
    const first = await chat(url, deep, headers);
    const second = await chat(url, deep, headers);
    expect(first.status).toBe(500);
    expect(first.body).toContain("chaos_drop");
    expect(first.headers[KEY_HEADER]).toMatch(/^[0-9a-f]{16}$/);
    expect(second.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
    // A different deep body gets a different key.
    const other = await chat(
      url,
      chatBody(`,"deep":${"[".repeat(DEPTH)}1${"]".repeat(DEPTH)}`),
      headers,
    );
    expect(other.headers[KEY_HEADER]).toMatch(/^[0-9a-f]{16}$/);
    expect(other.headers[KEY_HEADER]).not.toBe(first.headers[KEY_HEADER]);
  });

  it("keys a deep object body by its sorted keys, like a shallow one", async () => {
    const url = await start();
    const headers = { [SEED_HEADER]: "s1", "x-aimock-chaos-drop": "1" };
    const n = 50_000;
    const ab = `${'{"a":1,"b":'.repeat(n)}0${"}".repeat(n)}`;
    const ba = `${'{"b":'.repeat(n)}0${',"a":1}'.repeat(n)}`;
    const first = await chat(url, chatBody(`,"deep":${ab}`), headers);
    const second = await chat(url, chatBody(`,"deep":${ba}`), headers);
    expect(first.headers[KEY_HEADER]).toMatch(/^[0-9a-f]{16}$/);
    expect(second.headers[KEY_HEADER]).toBe(first.headers[KEY_HEADER]);
  });
});

// ─── 2. BigInt seed ─────────────────────────────────────────────────────────

describe("a BigInt seed from an untyped JS config", () => {
  it("is rejected with a warning at startup and requests are still served", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await start({
      logLevel: "warn",
      chaos: { seed: 42n } as unknown as MockServerOptions["chaos"],
    });
    const probe = await chat(url, chatBody());
    expect(probe.status).toBe(200);
    expect(probe.headers[SEED_HEADER]).toBeUndefined();
    expect(warnings(warn).some((line) => line.includes("seed") && line.includes("42n"))).toBe(true);
  });

  it("on a fixture is rejected with a warning and the request is served", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await start({ logLevel: "warn" }, [
      {
        match: { userMessage: "alpha" },
        response: { content: "A" },
        chaos: { seed: 7n } as unknown as Fixture["chaos"],
      },
    ]);
    const probe = await chat(url, chatBody());
    expect(probe.status).toBe(200);
    expect(probe.body).toContain('"A"');
    expect(warnings(warn).some((line) => line.includes("rejected seed 7n"))).toBe(true);
  });
});
