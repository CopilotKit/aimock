/**
 * Seeded chaos: server lifecycle fixes (CR round 1 of #618).
 *
 * - An untagged chaos control (POST or DELETE `/__aimock/chaos`) changes the
 *   server-wide baseline, so it rewinds every testId that inherits it, not only
 *   the default one.
 * - `LLMock.setChaos` / `clearChaos` (the `defaults.chaos` setter) rewind the
 *   seeded counters the same way the HTTP control does.
 * - The fal chaos gates key a request by its parsed body, like every other
 *   route, and key a bodiless request as bodiless.
 * - CORS exposes the seeded chaos response headers.
 * - An invalid `chaosKeysMax` and an eviction at the key cap are logged.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { createServer, type ServerInstance } from "../server.js";
import { LLMock } from "../llmock.js";
import type { Fixture, MockServerOptions } from "../types.js";

const OCCURRENCE_HEADER = "x-aimock-chaos-occurrence";

const FIXTURES: Fixture[] = [
  { match: { userMessage: "alpha" }, response: { content: "A" } },
  { match: { userMessage: "beta" }, response: { content: "B" } },
  { match: { userMessage: "gamma" }, response: { content: "C" } },
];

interface Probe {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: ServerInstance[] = [];
const mocks: LLMock[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((done) => s.server.close(() => done()))),
  );
  await Promise.all(mocks.splice(0).map((m) => m.stop()));
});

async function start(options: MockServerOptions = {}): Promise<string> {
  const instance = await createServer(structuredClone(FIXTURES), { port: 0, ...options });
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

function chat(url: string, message: string, headers: Record<string, string> = {}): Promise<Probe> {
  return rawRequest(
    `${url}/v1/chat/completions`,
    "POST",
    JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: message }] }),
    headers,
  );
}

/** The occurrence a seeded drop reported for one chat request. */
async function occurrence(
  url: string,
  message: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const probe = await chat(url, message, headers);
  expect(probe.status).toBe(500);
  return String(probe.headers[OCCURRENCE_HEADER]);
}

async function control(
  url: string,
  method: "POST" | "DELETE",
  body?: object,
  headers: Record<string, string> = {},
): Promise<void> {
  const probe = await rawRequest(
    `${url}/__aimock/chaos`,
    method,
    body === undefined ? null : JSON.stringify(body),
    headers,
  );
  expect(probe.status).toBe(200);
}

const T1 = { "x-test-id": "t1" };
const T2 = { "x-test-id": "t2" };

describe("untagged chaos control rewinds every scope that inherits the baseline", () => {
  it("an untagged POST rewinds a tagged testId that has no override of its own", async () => {
    const url = await start();
    await control(url, "POST", { dropRate: 1, seed: "base" });
    expect(await occurrence(url, "alpha", T1)).toBe("0");
    expect(await occurrence(url, "alpha", T1)).toBe("1");
    // Re-installing the same baseline must replay t1's run from occurrence 0.
    await control(url, "POST", { dropRate: 1, seed: "base" });
    expect(await occurrence(url, "alpha", T1)).toBe("0");
  });

  it("an untagged DELETE rewinds a tagged testId that inherits the baseline", async () => {
    const url = await start({ chaos: { dropRate: 1, seed: "boot" } });
    expect(await occurrence(url, "alpha", T1)).toBe("0");
    await control(url, "POST", { dropRate: 1, seed: "override" });
    await control(url, "DELETE");
    // Back on the construction baseline: t1's run under "boot" replays.
    expect(await occurrence(url, "alpha", T1)).toBe("0");
  });

  it("does not rewind a testId that holds its own override", async () => {
    const url = await start();
    await control(url, "POST", { dropRate: 1, seed: "own" }, T2);
    expect(await occurrence(url, "alpha", T2)).toBe("0");
    await control(url, "POST", { dropRate: 1, seed: "base" });
    expect(await occurrence(url, "alpha", T2)).toBe("1");
    await control(url, "DELETE");
    expect(await occurrence(url, "alpha", T2)).toBe("2");
  });
});

describe("LLMock.setChaos / clearChaos rewind seeded counters", () => {
  async function startMock(): Promise<LLMock> {
    const mock = new LLMock({ port: 0 });
    mock.addFixtures(structuredClone(FIXTURES));
    await mock.start();
    mocks.push(mock);
    return mock;
  }

  it("calling setChaos again with the same seed replays the sequence", async () => {
    const mock = await startMock();
    mock.setChaos({ dropRate: 1, seed: "api" });
    expect(await occurrence(mock.url, "alpha")).toBe("0");
    expect(await occurrence(mock.url, "alpha", T1)).toBe("0");
    expect(await occurrence(mock.url, "alpha")).toBe("1");
    mock.setChaos({ dropRate: 1, seed: "api" });
    expect(await occurrence(mock.url, "alpha")).toBe("0");
    expect(await occurrence(mock.url, "alpha", T1)).toBe("0");
  });

  it("clearChaos then setChaos with the same seed replays the sequence", async () => {
    const mock = await startMock();
    mock.setChaos({ dropRate: 1, seed: "api" });
    expect(await occurrence(mock.url, "alpha")).toBe("0");
    mock.clearChaos();
    mock.setChaos({ dropRate: 1, seed: "api" });
    expect(await occurrence(mock.url, "alpha")).toBe("0");
  });
});
