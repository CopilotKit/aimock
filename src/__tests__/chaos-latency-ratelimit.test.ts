import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  evaluateChaos,
  resolveChaosLatencyMs,
  applyChaosAction,
  awaitChaosLatency,
  responseGone,
  responseUnwritableReason,
} from "../chaos.js";
// The namespace as well as the named imports: the latch tests below want THE
// instance `createServer` imported, not a `vi.resetModules()` copy of it that
// shares no state with the servers they drive (see `freshChaosModule`).
import * as chaos from "../chaos.js";
import { createServer } from "../server.js";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";
import { createMetricsRegistry } from "../metrics.js";
import type { ChaosConfig, Fixture } from "../types.js";
import * as net from "node:net";
import { EventEmitter } from "node:events";

function textFixture(message: string): Fixture {
  return { match: { userMessage: message }, response: { content: message } };
}

interface FakeResState {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface FakeRes {
  res: http.ServerResponse;
  state: FakeResState;
}

/**
 * The slice of `ServerResponse` the chaos actions actually touch, plus the
 * EventEmitter surface `awaitChaosLatency` subscribes to, typed so the fake
 * cannot drift from the real contract without a compile error.
 */
type FakeServerResponse = EventEmitter & {
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  writeHead(status: number, headers?: Record<string, string>): FakeServerResponse;
  end(chunk?: string): FakeServerResponse;
  destroy(): FakeServerResponse;
};

/**
 * A `ServerResponse` stand-in that behaves like the real object wherever these
 * tests lean on it: `writeHead` returns `this` (the real one is chainable) and
 * throws on a second call, and `headersSent` / `writableEnded` / `destroyed`
 * flip exactly when the corresponding call happens. A fake that diverges here
 * would let a chaos action that writes headers twice, or that writes a body
 * after destroying the socket, pass unnoticed.
 *
 * It is built on a real `EventEmitter` so it carries `once`/`off` like the
 * real response: a fake without them silently SKIPS the disconnect-cancellable
 * branch of `awaitChaosLatency`, so every test using it would exercise the
 * plain-wait path only. `destroy()` emits `close`, as the real response does.
 *
 * Post-`destroy()` behaviour is not guessed at. Driving a real `http.Server`
 * on this node: `res.destroy(); res.writeHead(200); res.end("late")` throws
 * NOTHING, leaves `headersSent` and `writableEnded` BOTH true, and delivers
 * nothing to the client. The fake reproduces exactly that — the flags flip,
 * and the recorded `state`, which stands in for "what the client received",
 * stays empty — so a chaos action that writes into a socket it has already
 * torn down cannot pass here by writing into a fake that goes on accepting
 * bytes.
 */
function fakeRes(): FakeRes {
  const state: FakeResState = { status: 0, headers: {}, body: "" };
  const res: FakeServerResponse = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers?: Record<string, string>): FakeServerResponse {
      if (res.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
      res.headersSent = true;
      // Measured against a real response (see the note above): a `writeHead`
      // on a DESTROYED one neither throws nor reaches the client — the flag
      // flips, the bytes are lost. Recording them in `state` would let a chaos
      // action that writes a status line into a dead socket look, to every
      // assertion here, exactly like one that served a client.
      if (res.destroyed) return res;
      state.status = status;
      Object.assign(state.headers, headers ?? {});
      return res;
    },
    end(chunk?: string): FakeServerResponse {
      res.writableEnded = true;
      // Same measurement, same reason: `end()` after `destroy()` resolves
      // normally and sets `writableEnded`, but the chunk goes nowhere.
      if (res.destroyed) return res;
      if (typeof chunk === "string") state.body += chunk;
      return res;
    },
    destroy(): FakeServerResponse {
      if (res.destroyed) return res;
      res.destroyed = true;
      res.emit("close");
      return res;
    },
  });
  // A plain object needed `as unknown as`; a real EventEmitter overlaps the
  // response type enough for TypeScript to accept the narrowing directly.
  return { res: res as http.ServerResponse, state };
}

function journalContext() {
  return { method: "POST", path: "/v1/chat/completions", headers: {}, body: null };
}

// ---------------------------------------------------------------------------
// Timing measurement
//
// NOTHING here asserts an absolute wall-clock bound. A loaded runner inflates
// every request on the box, so `elapsed < 120ms` is a coin flip that has
// already turned `main` red in this repo. Only the DIFFERENCE between a
// delayed request and an undelayed control taken on the SAME server is stable
// under load: both samples absorb the same scheduling noise, and the delay is
// the only term that does not cancel.
//
// A fake clock would be stricter still, but `awaitChaosLatency` reaches
// `setTimeout` directly with no injection seam, and faking timers process-wide
// would also fake the HTTP server's and undici's own timers. Adding that seam
// is out of this change's boundary, so: relative bounds.
// ---------------------------------------------------------------------------

const LATENCY_MS = 200;
/** Safety factor on the configured delay — the observed delta must cover most of it. */
const DELTA_MIN = LATENCY_MS * 0.75;
/**
 * Ceiling on the observed delta, sized to catch the delay being awaited TWICE
 * (delta 2x LATENCY_MS) while clearing the real spread.
 *
 * Both terms of the delta are now the MINIMUM of `SAMPLES` runs (see
 * `fastestMs`). That symmetry is the whole point: a min-of-3 control minus a
 * SINGLE delayed shot compared two different statistics, so one scheduling
 * hiccup landing on the delayed request inflated the delta with nothing on the
 * other side to cancel it — a flaky ceiling that said nothing about the code.
 * Min-of-N on both sides makes each term the same statistic of the same noise,
 * and the delay is the only term that survives.
 *
 * That in turn buys a TIGHTER ceiling. Measured on this repo with the
 * asymmetric sampling: 50 samples over 5 runs landed in 200-218ms against a
 * configured 200ms (1.09x). Symmetric min-of-3 does not exceed that. 1.25x
 * keeps ~15% headroom over the worst observation while halving the gap to a
 * double-await, so an inflation well short of a doubled delay is now caught
 * instead of waved through.
 */
const DELTA_MAX = LATENCY_MS * 1.25;
/**
 * A floor for tests that time an awaited delay DIRECTLY (no control request to
 * subtract), where the elapsed time IS the delay plus whatever else the box is
 * doing — load can only push it up, so an absolute floor stays honest. Named
 * apart from `DELTA_MIN`, which is a bound on a DIFFERENCE and means nothing
 * as an absolute; using one for the other reads as if a control had been
 * measured when none was.
 */
const DELAY_FLOOR_MS = LATENCY_MS * 0.97;
/** Samples per measurement, reduced by min, so one scheduling hiccup cannot move it. */
const SAMPLES = 3;
/** Header override that switches latency OFF for one request on a server that has it on. */
const NO_LATENCY = { "x-aimock-chaos-latency": "0" };

const chatBody = JSON.stringify({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hello-chaos" }],
});
const streamBody = JSON.stringify({
  model: "gpt-4o",
  stream: true,
  messages: [{ role: "user", content: "hello-chaos" }],
});
const claudeBody = JSON.stringify({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello-chaos" }],
});

/** Drive one request to completion and return the elapsed milliseconds. */
async function timeRequest(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ ms: number; status: number }> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  await res.text();
  return { ms: Date.now() - t0, status: res.status };
}

/**
 * The cost of this exact route on this exact server: the fastest of `SAMPLES`
 * runs. Used for BOTH terms of every delta below — the undelayed control and
 * the delayed sample — so the two are the same statistic and the scheduling
 * noise they share actually cancels.
 */
async function fastestMs(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  expectedStatus = 200,
): Promise<number> {
  let fastest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < SAMPLES; i++) {
    const run = await timeRequest(url, body, headers);
    expect(run.status).toBe(expectedStatus);
    fastest = Math.min(fastest, run.ms);
  }
  return fastest;
}

/** The undelayed cost: the negative control every delay assertion is measured against. */
const controlMs = fastestMs;

/** The delayed request must cost at least the configured latency MORE than its control. */
function expectDelayed(label: string, delayedMs: number, baselineMs: number): void {
  const delta = delayedMs - baselineMs;
  expect(
    delta,
    `${label}: delayed=${delayedMs}ms control=${baselineMs}ms delta=${delta}ms, want >= ${DELTA_MIN}ms`,
  ).toBeGreaterThanOrEqual(DELTA_MIN);
  expect(
    delta,
    `${label}: delta=${delta}ms exceeds the ${DELTA_MAX}ms sanity ceiling (delay applied twice?)`,
  ).toBeLessThan(DELTA_MAX);
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Wait until `ready()` is true, or give up at `budgetMs`. Returns whether the
 * condition was ever met, so the caller asserts on the condition instead of on
 * a fixed sleep having been long enough. A fixed sleep is two bugs in one: too
 * short and a loaded runner fails a healthy build, too long and every run pays
 * for the worst case.
 */
async function pollUntil(ready: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (ready()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The shape of one raw-socket request, and of every gate case below. */
interface RawRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
}

/**
 * THE raw-socket abort helper. Writes `request` on a fresh socket and hangs up
 * `afterMs` in, before any response; resolves at the hang-up.
 *
 * There used to be three near-identical copies of this with three different
 * error policies, and the loosest of them — `sock.on("error", () => {})` —
 * made every absence assertion downstream of it vacuous: a socket that never
 * connected (server gone, wrong port) looked exactly like one the server was
 * still sitting on, so "nothing was journalled" was trivially true and the
 * test burned its whole budget before timing out with no mention of the real
 * fault. One helper, one policy: an error BEFORE the deliberate destroy
 * REJECTS and names itself; the ECONNRESET our own destroy provokes is
 * expected and ignored. The pending timer is cleared on every exit, so a
 * rejected connect leaves nothing armed to fire into a finished test.
 */
function abortMidFlight(port: number, request: RawRequest, afterMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    const sock = net.connect(port, "127.0.0.1", () => {
      const { method, path, headers = {}, body = null } = request;
      let head = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`;
      for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
      if (body !== null) head += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
      sock.write(`${head}\r\n${body ?? ""}`);
      timer = setTimeout(() => finish(), afterMs);
    });
    sock.on("error", (err) => finish(err));
  });
}

/** The chat request the disconnect tests abort. */
const CHAT_REQUEST: RawRequest = {
  method: "POST",
  path: "/v1/chat/completions",
  headers: { "Content-Type": "application/json" },
  body: chatBody,
};

/**
 * The first captured line carrying EVERY needle, or `undefined`.
 *
 * Deliberately not "some line has A and some line has B": the claim these
 * tests make is that ONE line names both the gate and what happened to it. Two
 * separate `lines.some(...)` calls pass when the path came from an unrelated
 * request log and the outcome from a different gate entirely.
 */
function lineWith(lines: string[], needles: string[]): string | undefined {
  return lines.find((l) => needles.every((n) => l.includes(n)));
}

/**
 * Poll captured server-side log lines until ONE line carries every needle, and
 * return how long that took from `t0`. `-1` means it never arrived in budget.
 */
async function msUntilLogged(
  lines: string[],
  needles: string[],
  t0: number,
  budgetMs: number,
): Promise<number> {
  const found = await pollUntil(() => lineWith(lines, needles) !== undefined, budgetMs);
  return found ? Date.now() - t0 : -1;
}

/** Capture the server's `logLevel: "debug"` output (Logger.debug -> console.log). */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

/** Capture everything the default `Logger` warns (it writes via console.warn). */
function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

/**
 * The debug line every SPLIT chaos gate emits when the client is gone by the
 * time its latency delay finishes. Paired with the gate's path (same line) it
 * is the POSITIVE CONTROL for every "nothing was journalled" assertion here:
 * it proves the request reached the handler and the handler ran to the
 * post-latency re-check. Without it an empty journal is also what a request
 * that never arrived produces.
 */
const GONE_AFTER_LATENCY = "after the latency delay — not served, not journalled";

/**
 * A fresh `chaos.js` instance.
 *
 * Needed for exactly ONE thing: the `applyChaos` deprecation notice latches in
 * a module-level boolean, once per PROCESS by design, so re-arming it means a
 * new module. Every other latch in `chaos.ts` is keyed by the caller's
 * `Logger` (a `WeakMap`), so a test that wants a clean latch makes a new
 * logger — and a test that drives a real server MUST NOT reset modules at all,
 * or it ends up asserting against a different `chaos.ts` than the one
 * `createServer` imported.
 */
async function freshChaosModule() {
  vi.resetModules();
  return import("../chaos.js");
}

describe("chaos latency + ratelimit", () => {
  it("evaluateChaos fires rateLimit at rate 1.0 and never at rate 0", () => {
    expect(evaluateChaos(null, { rateLimitRate: 1.0 }, undefined)).toBe("rateLimit");
    expect(evaluateChaos(null, { rateLimitRate: 0 }, undefined)).toBe(null);
  });

  it("evaluateChaos lets the ratelimit header override a 0 server rate", () => {
    expect(evaluateChaos(null, { rateLimitRate: 0 }, { "x-aimock-chaos-ratelimit": "1" })).toBe(
      "rateLimit",
    );
  });

  it("resolveChaosLatencyMs resolves, rejects out-of-range and defaults to 0", () => {
    expect(resolveChaosLatencyMs(null, { latencyMs: 150 }, undefined)).toBe(150);
    // Out of range: rejected, not clamped to 30000 — one policy for every source.
    expect(resolveChaosLatencyMs(null, { latencyMs: 50000 }, undefined)).toBe(0);
    expect(resolveChaosLatencyMs(null, undefined, undefined)).toBe(0);
  });

  it("resolveChaosLatencyMs precedence is header > fixture > server", () => {
    const slowFixture: Fixture = {
      match: {},
      response: { content: "x" },
      chaos: { latencyMs: 77 },
    };
    // header > server
    expect(
      resolveChaosLatencyMs(null, { latencyMs: 10 }, { "x-aimock-chaos-latency": "250" }),
    ).toBe(250);
    // fixture > server
    expect(resolveChaosLatencyMs(slowFixture, { latencyMs: 5 }, undefined)).toBe(77);
    // header > FIXTURE — the link the other two do not cover. With only the
    // pair above, swapping the fixture and header arms of the chain still
    // satisfies both: the header still beats the server default, and the
    // fixture still beats it too. All three sources have to be in play at once
    // for the ORDER between the top two to be pinned at all.
    expect(
      resolveChaosLatencyMs(slowFixture, { latencyMs: 5 }, { "x-aimock-chaos-latency": "250" }),
    ).toBe(250);
    // ...and a REJECTED header is not a header: the documented policy is that
    // an invalid value is simply not set, so the next level down applies. The
    // fixture wins here — 77, not the 1000 that "1e3" would have meant and not
    // the 5 a header that silenced the whole chain would have left.
    expect(
      resolveChaosLatencyMs(slowFixture, { latencyMs: 5 }, { "x-aimock-chaos-latency": "1e3" }),
    ).toBe(77);
  });

  it("rateLimit action writes 429 with Retry-After and journals", () => {
    const journal = new Journal();
    const fake = fakeRes();
    applyChaosAction(
      "rateLimit",
      fake.res,
      null,
      journal,
      journalContext(),
      "internal",
      undefined,
      undefined,
    );
    expect(fake.state.status).toBe(429);
    expect(fake.state.headers["Retry-After"]).toBe("1");
    expect(fake.res.headersSent).toBe(true);
    expect(fake.res.writableEnded).toBe(true);
    expect(fake.res.destroyed).toBe(false);
    expect(JSON.parse(fake.state.body)).toEqual({
      error: {
        message: "Chaos: rate limit exceeded",
        type: "rate_limit_error",
        code: "chaos_ratelimit",
      },
    });
    expect(journal.getAll()[0].response.status).toBe(429);
  });

  it("disconnect action destroys the response without writing a status", () => {
    const journal = new Journal();
    const fake = fakeRes();
    applyChaosAction(
      "disconnect",
      fake.res,
      null,
      journal,
      journalContext(),
      "internal",
      undefined,
      undefined,
    );
    expect(fake.res.destroyed).toBe(true);
    expect(fake.res.headersSent).toBe(false);
    expect(fake.res.writableEnded).toBe(false);
    expect(fake.state.status).toBe(0);
    expect(journal.getAll()[0].response.status).toBe(0);
    expect(journal.getAll()[0].response.chaosAction).toBe("disconnect");
  });

  it("disconnect action tears down a real socket so the client sees a transport error", async () => {
    const journal = new Journal();
    const server = http.createServer((_req, res) => {
      applyChaosAction(
        "disconnect",
        res,
        null,
        journal,
        journalContext(),
        "internal",
        undefined,
        undefined,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      await expect(
        fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: chatBody }),
      ).rejects.toThrow();
      expect(journal.getAll()[0].response.status).toBe(0);
      expect(journal.getAll()[0].response.chaosAction).toBe("disconnect");
    } finally {
      await closeServer(server);
    }
  });

  it("server 429s via header and control API round-trips new fields", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {});
    try {
      const rl = await fetch(`${instance.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-aimock-chaos-ratelimit": "1",
        },
        body: chatBody,
      });
      expect(rl.status).toBe(429);
      expect(rl.headers.get("retry-after")).toBe("1");

      const set = await fetch(`${instance.url}/__aimock/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latencyMs: LATENCY_MS, rateLimitRate: 0 }),
      });
      expect(set.status).toBe(200);
      expect(((await set.json()) as { chaos: { latencyMs: number } }).chaos.latencyMs).toBe(
        LATENCY_MS,
      );

      // The round trip is only worth anything if the installed latency is
      // OBSERVED on the wire afterwards, measured against a latency-off
      // control on the same server.
      const base = await controlMs(`${instance.url}/v1/chat/completions`, chatBody, NO_LATENCY);
      const ok = await fastestMs(`${instance.url}/v1/chat/completions`, chatBody);
      expectDelayed("control-API latency", ok, base);

      const bad = await fetch(`${instance.url}/__aimock/chaos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latencyMs: 99999 }),
      });
      expect(bad.status).toBe(400);

      // A rejected update must leave the installed config untouched — both as
      // reported by the control API and as applied on the wire.
      const after = await fetch(`${instance.url}/__aimock/chaos`);
      expect(after.status).toBe(200);
      expect(((await after.json()) as { chaos: unknown }).chaos).toEqual({
        latencyMs: LATENCY_MS,
        rateLimitRate: 0,
      });
      const stillDelayed = await fastestMs(`${instance.url}/v1/chat/completions`, chatBody);
      expectDelayed("latency survives a rejected update", stillDelayed, base);
    } finally {
      await closeServer(instance.server);
    }
  });

  it("async helper delays before applying terminal chaos", async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    const fake = fakeRes();
    const t0 = Date.now();
    const fired = await applyChaosAsync(
      fake.res,
      null,
      { latencyMs: LATENCY_MS, rateLimitRate: 1.0 },
      {},
      "/v1/chat/completions",
      journal,
      journalContext(),
      "internal",
    );
    const elapsed = Date.now() - t0;
    // "handled", not "unwritable": the action really fired on a live response.
    expect(fired).toBe("handled");
    expect(fake.state.status).toBe(429);
    // Ordering, not throughput: the 429 cannot have been written before the
    // delay was awaited, so the elapsed time covers the configured latency.
    expect(elapsed).toBeGreaterThanOrEqual(DELAY_FLOOR_MS);
  });
});

// Wiring regression: the latency knob used to be resolved, validated and
// clamped on every entry point and then never awaited by any handler — a
// configured 3000ms delay measured ~0ms on the wire. These tests measure
// ELAPSED TIME through a real server RELATIVE to an undelayed control on that
// same server, so deleting the `awaitChaosLatency` call (or reverting a
// handler to the sync `applyChaos`) turns them red while a loaded runner does
// not. The delay is fixed, never jittered, so replay stays deterministic; the
// values here are kept small so the suite stays fast.
describe("chaos latency is actually applied on the wire", () => {
  it("delays the chat, streaming and Anthropic paths from server-level config, and not with latency off", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {
      chaos: { latencyMs: LATENCY_MS },
    });
    try {
      const routes: Array<{ label: string; url: string; body: string }> = [
        { label: "chat", url: `${instance.url}/v1/chat/completions`, body: chatBody },
        { label: "stream", url: `${instance.url}/v1/chat/completions`, body: streamBody },
        { label: "anthropic", url: `${instance.url}/v1/messages`, body: claudeBody },
      ];
      for (const route of routes) {
        // Negative control FIRST: the same route on the same server with
        // latency switched off by header. Proves the delay is attributable to
        // the config and not to the route being slow.
        const base = await controlMs(route.url, route.body, NO_LATENCY);
        const delayed = await fastestMs(route.url, route.body);
        expectDelayed(route.label, delayed, base);
      }
    } finally {
      await closeServer(instance.server);
    }
  });

  it("delays from a per-request header and from fixture-level chaos, and not otherwise", async () => {
    const plain = textFixture("hello-chaos");
    const slowFixture: Fixture = {
      match: { userMessage: "slow-fixture" },
      chaos: { latencyMs: LATENCY_MS },
      response: { content: "slow-fixture" },
    };
    const instance = await createServer([plain, slowFixture], {});
    try {
      const url = `${instance.url}/v1/chat/completions`;
      // Negative control on the SAME server: no header, no fixture chaos.
      const base = await controlMs(url, chatBody);

      const withHeader = await fastestMs(url, chatBody, {
        "x-aimock-chaos-latency": String(LATENCY_MS),
      });
      expectDelayed("header latency", withHeader, base);

      const fixtureLevel = await fastestMs(
        url,
        JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "slow-fixture" }],
        }),
      );
      expectDelayed("fixture latency", fixtureLevel, base);
    } finally {
      await closeServer(instance.server);
    }
  });

  it("scopes control-API latency to the installing testId and does not leak", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {});
    try {
      const set = await fetch(`${instance.url}/__aimock/chaos?testId=slow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latencyMs: LATENCY_MS }),
      });
      expect(set.status).toBe(200);

      // The control is the testId that never configured chaos: if it inherited
      // the override there would be no measurable gap between the two.
      const chatFast = await controlMs(`${instance.url}/v1/chat/completions?testId=fast`, chatBody);
      const chatSlow = await timeRequest(
        `${instance.url}/v1/chat/completions?testId=slow`,
        chatBody,
      );
      expect(chatSlow.status).toBe(200);
      expectDelayed("scoped chat", chatSlow.ms, chatFast);

      // Anthropic path honours the same scope.
      const claudeFast = await controlMs(`${instance.url}/v1/messages?testId=fast`, claudeBody);
      const claudeSlow = await timeRequest(`${instance.url}/v1/messages?testId=slow`, claudeBody);
      expect(claudeSlow.status).toBe(200);
      expectDelayed("scoped anthropic", claudeSlow.ms, claudeFast);
    } finally {
      await closeServer(instance.server);
    }
  });

  it("awaits the latency BEFORE writing an unchanged 429 when rate limiting is configured alongside it", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {
      chaos: { rateLimitRate: 1, latencyMs: LATENCY_MS },
    });
    try {
      const url = `${instance.url}/v1/chat/completions`;
      // Control: the same 429, same server, latency switched off by header.
      const base = await controlMs(url, chatBody, NO_LATENCY, 429);

      const t0 = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody,
      });
      const payload = await res.json();
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("1");
      // Same OpenAI-shaped rate-limit header set writeErrorResponse() emits on
      // every other 429 — the chaos 429 must not diverge from it.
      expect(res.headers.get("x-ratelimit-limit-requests")).toBe("60");
      expect(res.headers.get("x-ratelimit-limit-tokens")).toBe("150000");
      expect(res.headers.get("x-ratelimit-remaining-requests")).toBe("0");
      expect(res.headers.get("x-ratelimit-remaining-tokens")).toBe("0");
      expect(res.headers.get("x-ratelimit-reset-requests")).toBe("1s");
      expect(res.headers.get("x-ratelimit-reset-tokens")).toBe("6m0s");
      // The divergent short names must be gone.
      expect(res.headers.get("x-ratelimit-remaining")).toBeNull();
      expect(res.headers.get("x-ratelimit-reset")).toBeNull();
      expect(payload).toEqual({
        error: {
          message: "Chaos: rate limit exceeded",
          type: "rate_limit_error",
          code: "chaos_ratelimit",
        },
      });
      // Ordering proof: a 429 written before the delay was awaited would land
      // as fast as the latency-off control.
      expectDelayed("429 after latency", elapsed, base);
    } finally {
      await closeServer(instance.server);
    }
  });
});

// Write-after-abort regression: the latency delay can park a request for up to
// 30s, and the client is free to hang up during it. Before the guard, the
// pending `setTimeout` ran free past the disconnect and `applyChaosAction`
// then wrote headers/body to a destroyed socket (silently discarded) AND
// journalled a 429 the client never received — a phantom entry. These tests
// use a REAL socket abort (no fake `res`), so deleting the `responseUnwritable`
// guard or the `delay(ms, signal)` abort wiring turns them red.
describe("chaos does not write to (or journal) a response the client abandoned", () => {
  const portOf = (server: http.Server): number => (server.address() as net.AddressInfo).port;

  /** Long enough that "cancelled" and "waited it out" cannot be confused. */
  const CANCEL_LATENCY_MS = 3000;
  /** Small enough to keep the suite fast; long enough to abort well inside it. */
  const ABORT_LATENCY_MS = 300;
  /**
   * The cancelled wait must unwind within this fraction of the delay it was
   * cancelled out of. Expressed against CANCEL_LATENCY_MS rather than as a
   * wall-clock constant, per the policy at the top of this file: an uncancelled
   * wait lands at ~CANCEL_LATENCY_MS and cannot squeeze under a third of it,
   * however loaded the box is.
   */
  const CANCEL_BUDGET_MS = CANCEL_LATENCY_MS / 3;

  it("cancels the pending latency timer as soon as the client disconnects", async () => {
    let elapsed = -1;
    let journalledAfterAbort = -1;
    const journal = new Journal();

    // `async` + `await`, not a floated `void ...then()`: a rejection from the
    // floated form had nowhere to go and would have surfaced as an
    // unhandled rejection attributed to whichever test happened to be running.
    const server = http.createServer(async (_req, res) => {
      const t0 = Date.now();
      await awaitChaosLatency(null, { latencyMs: CANCEL_LATENCY_MS }, {}, undefined, "/", res);
      elapsed = Date.now() - t0;
      // The write path must also refuse to act on the dead response.
      applyChaosAction(
        "rateLimit",
        res,
        null,
        journal,
        { method: "POST", path: "/v1/chat/completions", headers: {}, body: null },
        "internal",
        undefined,
        undefined,
      );
      journalledAfterAbort = journal.getAll().length;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      await abortMidFlight(portOf(server), CHAT_REQUEST, 100);
      // Poll for the handler to resume rather than sleeping a fixed 400ms: the
      // fixed sleep could return with `elapsed` still -1 on a slow runner and
      // fail a build that was working. Waiting the full CANCEL_BUDGET_MS is
      // also what makes the bound below meaningful — an UNcancelled wait is
      // still parked when the budget runs out, so `resumed` is false.
      const resumed = await pollUntil(() => elapsed >= 0, CANCEL_BUDGET_MS);
      expect(resumed, `handler never resumed within ${CANCEL_BUDGET_MS}ms`).toBe(true);
      // Cancelled promptly — not the full CANCEL_LATENCY_MS.
      expect(
        elapsed,
        `cancelled wait took ${elapsed}ms of a ${CANCEL_LATENCY_MS}ms delay`,
      ).toBeLessThan(CANCEL_BUDGET_MS);
      expect(journalledAfterAbort).toBe(0);
      expect(journal.getAll()).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // C13: latency ONLY — no `rateLimitRate`, no `dropRate`. With a terminal
  // action configured the server returns early inside the chaos block, which
  // masked the real hole: on the NORMAL path the chat gate awaited the delay
  // and then, without re-checking writability, built and "served" the full
  // fixture response into a dead socket and JOURNALLED it. Re-adding a
  // terminal rate makes this test green again on broken source, so it must
  // stay latency-only.
  it("journals nothing for an aborted request but still serves a patient one", async () => {
    // Spy and server are both acquired INSIDE the try: installed outside it, a
    // `createServer` throw skips the `finally` and leaves `console.log` mocked
    // for every later test in the run, plus a server still listening.
    let lines: string[] | undefined;
    let restore: (() => void) | undefined;
    let instance: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      ({ lines, restore } = captureLogs());
      instance = await createServer([textFixture("hello-chaos")], {
        chaos: { latencyMs: ABORT_LATENCY_MS },
        logLevel: "debug",
      });
      await abortMidFlight(Number(new URL(instance.url).port), CHAT_REQUEST, 80);
      // POSITIVE CONTROL, and a deadline instead of a fixed sleep: wait for the
      // gate's own line saying the request DID reach it and was declined after
      // the delay. Sleeping 700ms and finding an empty journal proves nothing —
      // a request that never arrived leaves an empty journal too.
      const declined = await msUntilLogged(
        lines,
        [CHAT_REQUEST.path, GONE_AFTER_LATENCY],
        Date.now(),
        ABORT_LATENCY_MS * 4,
      );
      expect(declined, "the chat gate never reported the aborted request").toBeGreaterThanOrEqual(
        0,
      );
      // No phantom entry for the response that was never delivered.
      expect(instance.journal.getAll()).toHaveLength(0);

      // Control on the SAME server: a client that waits is still served.
      const res = await fetch(`${instance.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody,
      });
      expect(res.status).toBe(200);
      const entries = instance.journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(200);
    } finally {
      if (instance) await closeServer(instance.server);
      restore?.();
    }
  });
});

// Double-resolve regression: the chaos config used to be resolved TWICE per
// request — once to await the latency delay and again to roll the terminal
// action — so every invalid / out-of-range chaos header was parsed twice and
// warned about twice. These tests COUNT the warnings emitted for a single
// request; reverting to two independent resolutions turns them red (count 2).
// `-1` is used as the out-of-range value because it is rejected outright (so
// the effective delay is 0ms) and the assertion costs no wall-clock time.
describe("chaos config is resolved once per request", () => {
  // Wording follows the single reject-never-clamp policy (`warnRejected`).
  const OUT_OF_RANGE_LATENCY = '[chaos] x-aimock-chaos-latency: rejected latencyMs value "-1"';

  it("warns exactly once per request on the server chat path", async () => {
    // The spy and the server are both acquired INSIDE the try. Installed
    // outside it, a `createServer` throw skipped the `finally` and left
    // `console.warn` mocked (and the server, if it had come up, listening) for
    // the rest of the process — every later test in the run silently lost its
    // warnings to this test's array.
    let lines: string[] | undefined;
    let restore: (() => void) | undefined;
    let instance: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      ({ lines, restore } = captureWarnings());
      instance = await createServer([textFixture("hello-chaos")], { logLevel: "warn" });
      const res = await fetch(`${instance.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-aimock-chaos-latency": "-1",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello-chaos" }],
        }),
      });
      await res.text();
      expect(res.status).toBe(200);
      expect(lines.filter((l) => l.includes(OUT_OF_RANGE_LATENCY))).toHaveLength(1);
    } finally {
      if (instance) await closeServer(instance.server);
      restore?.();
    }
  });

  it("warns exactly once per call through applyChaosAsync", async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const { Logger } = await import("../logger.js");
    const { lines, restore } = captureWarnings();
    try {
      const journal = new Journal();
      const { res } = fakeRes();
      await applyChaosAsync(
        res,
        null,
        undefined,
        { "x-aimock-chaos-latency": "-1" },
        "/v1/chat/completions",
        journal,
        { method: "POST", path: "/v1/chat/completions", headers: {}, body: null },
        "internal",
        undefined,
        new Logger("warn"),
      );
      expect(lines.filter((l) => l.includes(OUT_OF_RANGE_LATENCY))).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

// C10 regression: the two server-side fal chaos gates awaited the configured
// latency WITHOUT passing `res`, so the delay was not cancellable. A client
// that hung up mid-delay left the handler waiting out the full latency (and
// everything after it) instead of unwinding at the disconnect. Every other
// handler call site threads `res` through. These tests abort a real socket
// early and measure, server-side, WHEN the handler actually got to run — the
// instant it logs that the client is gone. Pre-fix both fal cases land at
// ~LATENCY_MS; post-fix they land at the abort, like the chat control.
describe("fal chaos latency is cancelled by a client disconnect", () => {
  /**
   * Deliberately much larger than the module-level `LATENCY_MS`: the proof is
   * that the handler unwinds at the abort rather than at the delay, so the two
   * instants have to be far apart. Named distinctly so it does not shadow the
   * module constant that `DELTA_MIN` / `DELTA_MAX` are derived from.
   */
  const FAL_LATENCY_MS = 1500;
  const ABORT_AT_MS = 80;
  /**
   * The cancelled request must land within this fraction of the delay it was
   * cancelled out of. Relative to `FAL_LATENCY_MS`, not a wall-clock constant:
   * generous enough to absorb scheduling jitter, and less than half the delay,
   * so an uncancelled wait (which lands at ~FAL_LATENCY_MS) cannot pass.
   */
  const CANCELLED_BUDGET_MS = FAL_LATENCY_MS * 0.45;

  // C13: the cancellation used to be observed by polling the JOURNAL. That
  // worked only because the server journalled a response it had never
  // delivered — the very phantom entry C13 removes. It is now observed through
  // the handler's own "the client disconnected after the latency delay" debug
  // line, emitted at the instant the handler resumes, so the timing claim is
  // unchanged while the journal is free to stay (correctly) empty.
  interface FalAbortCase extends RawRequest {
    name: string;
    /** The path fragment the gate's own log line must carry, on that same line. */
    needle: string;
  }

  // One case per fal gate that awaits chaos latency in `src/server.ts`.
  const CASES: FalAbortCase[] = [
    {
      name: "the x-fal-target-host general gate (queue submit)",
      method: "POST",
      path: "/fal/queue/submit/fal-ai/flux",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ prompt: "hello" }),
      needle: "/fal/queue/submit/",
    },
    {
      name: "the legacy /fal/queue/requests gate",
      method: "GET",
      path: "/fal/queue/requests/missing-id",
      headers: {},
      body: null,
      needle: "/fal/queue/requests/",
    },
  ];

  for (const c of CASES) {
    it(`unwinds at the disconnect on ${c.name}`, async () => {
      // Spy and server are both acquired inside the try: installed outside it,
      // a `createServer` throw skipped the `finally`, leaving `console.log`
      // mocked for every later test in the run and the server listening.
      let lines: string[] | undefined;
      let restore: (() => void) | undefined;
      let instance: Awaited<ReturnType<typeof createServer>> | undefined;
      try {
        ({ lines, restore } = captureLogs());
        instance = await createServer([textFixture("hello-chaos")], {
          chaos: { latencyMs: FAL_LATENCY_MS },
          logLevel: "debug",
        });
        const port = Number(new URL(instance.url).port);
        const t0 = Date.now();
        // Awaited, not floated: the floating call left an armed `setTimeout`
        // behind that fired after the test had finished, and a rejection from
        // it (see `abortMidFlight`) had nowhere to go. It resolves at
        // ABORT_AT_MS, an order of magnitude inside the delay being cancelled,
        // so the measurement below is unaffected.
        await abortMidFlight(port, c, ABORT_AT_MS);
        // BOTH needles on ONE line: the gate's path and the outcome. Asserted
        // separately (two `lines.some(...)` calls) the path could come from an
        // unrelated request log and the outcome from a different gate, and the
        // measurement would belong to neither.
        const falMs = await msUntilLogged(
          lines,
          [c.needle, "the client disconnected after the latency delay"],
          t0,
          FAL_LATENCY_MS + CANCELLED_BUDGET_MS,
        );
        expect(
          falMs,
          `no single log line named ${c.needle} AND the disconnect`,
        ).toBeGreaterThanOrEqual(0);
        expect(falMs).toBeLessThan(CANCELLED_BUDGET_MS);
        // C13: cancelled means cancelled — nothing was served, so nothing is
        // journalled. This is the assertion that used to say the opposite.
        expect(instance.journal.getAll()).toHaveLength(0);
      } finally {
        if (instance) await closeServer(instance.server);
        restore?.();
      }
    });
  }

  it("still honours the full delay for a client that does not hang up", async () => {
    // Small enough to keep the suite fast, large enough that a skipped delay
    // cannot clear the floor below.
    const PATIENT_LATENCY_MS = 300;
    const instance = await createServer([textFixture("hello-chaos")], {
      chaos: { latencyMs: PATIENT_LATENCY_MS },
    });
    try {
      const t0 = Date.now();
      const res = await fetch(`${instance.url}/fal/queue/submit/fal-ai/flux`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
        body: JSON.stringify({ prompt: "hello" }),
      });
      await res.text();
      const elapsed = Date.now() - t0;
      // A FLOOR derived from the configured delay, not a hand-typed 290: load
      // can only push this up, so the bound stays honest on a busy runner, and
      // it now moves with PATIENT_LATENCY_MS instead of silently decoupling
      // from it. The small haircut absorbs timer-resolution rounding.
      expect(
        elapsed,
        `patient client returned in ${elapsed}ms, want >= the configured ${PATIENT_LATENCY_MS}ms`,
      ).toBeGreaterThanOrEqual(PATIENT_LATENCY_MS * 0.97);
      expect(instance.journal.getAll()).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// Listener add/remove symmetry in awaitChaosLatency
//
// The disconnect-cancellable wait subscribes to the response's `close` event.
// Subscribe and unsubscribe must be guarded by the SAME predicate: a response
// double that carries `once` but not `off` used to reach an unconditional
// `res.off(...)` in the `finally`, so a perfectly normal completion threw a
// TypeError and the awaited delay REJECTED. The cases below pin both halves of
// the guard, and the EventEmitter-backed fake proves the cancellable branch is
// actually reached under the local fake (it never was while the fake lacked
// `once`).
// ---------------------------------------------------------------------------

/** Latency long enough to measure, short enough not to slow the suite. */
const SYM_LATENCY_MS = 120;
/** Floor for "the full delay was actually awaited" (scheduler slop tolerated). */
const SYM_DELAY_FLOOR_MS = SYM_LATENCY_MS * 0.75;

describe("awaitChaosLatency listener symmetry", () => {
  it("resolves for a response double that has once but no off", async () => {
    const added: { event: string; listener: () => void }[] = [];
    const halfEmitter = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      once(event: string, listener: () => void): void {
        added.push({ event, listener });
      },
    };
    const t0 = Date.now();
    await expect(
      awaitChaosLatency(
        null,
        { latencyMs: SYM_LATENCY_MS },
        undefined,
        undefined,
        undefined,
        halfEmitter as unknown as http.ServerResponse,
      ),
    ).resolves.toBeUndefined();
    // Subscribed (so the guard did take the cancellable branch) and still
    // waited the whole delay, because nothing ever closed.
    expect(added.map((a) => a.event)).toEqual(["close"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SYM_DELAY_FLOOR_MS);
  });

  it("resolves for a response double that has neither once nor off", async () => {
    const inert = { headersSent: false, writableEnded: false, destroyed: false };
    const t0 = Date.now();
    await expect(
      awaitChaosLatency(
        null,
        { latencyMs: SYM_LATENCY_MS },
        undefined,
        undefined,
        undefined,
        inert as unknown as http.ServerResponse,
      ),
    ).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SYM_DELAY_FLOOR_MS);
  });

  it("removes the close listener it added from a real emitter response", async () => {
    const fake = fakeRes();
    const emitter = fake.res as unknown as EventEmitter;
    await awaitChaosLatency(null, { latencyMs: 10 }, undefined, undefined, undefined, fake.res);
    expect(emitter.listenerCount("close")).toBe(0);
  });

  it("cancels a long delay when the fake response closes mid-wait", async () => {
    const fake = fakeRes();
    const t0 = Date.now();
    const timer = setTimeout(() => fake.res.destroy(), 50);
    try {
      await awaitChaosLatency(null, { latencyMs: 2000 }, undefined, undefined, undefined, fake.res);
    } finally {
      clearTimeout(timer);
    }
    const elapsed = Date.now() - t0;
    expect(elapsed, `cancelled wait took ${elapsed}ms, want < 500ms`).toBeLessThan(500);
    expect((fake.res as unknown as EventEmitter).listenerCount("close")).toBe(0);
  });

  it("delivers nothing after destroy(), like a destroyed real response", () => {
    const fake = fakeRes();
    fake.res.destroy();
    // Neither call throws on a real destroyed response, and both flip their
    // flag; what does NOT happen is delivery. `state` is what the client got.
    fake.res.writeHead(503, { "X-Late": "1" });
    fake.res.end("late bytes");
    expect(fake.state.status).toBe(0);
    expect(fake.state.headers).toEqual({});
    expect(fake.state.body).toBe("");
    expect(fake.res.destroyed).toBe(true);
    expect(fake.res.headersSent).toBe(true);
    expect(fake.res.writableEnded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C13: a request whose chaos latency was CANCELLED must not be served and must
// not be journalled, and the return contract must say which of the two things
// happened.
//
// The hole these cover: `applyChaosAsync` re-checks writability after the
// await, but the three SPLIT gates in `src/server.ts` (chat completions, the
// `x-fal-target-host` general fal gate, the legacy `/fal/queue/requests` gate)
// call `awaitChaosLatency` and `evaluateChaos` separately and did NOT. With
// latency configured and NO terminal action, a client that hung up mid-delay
// got a full response built, "served" into a dead socket and journalled — a
// phantom entry claiming bytes the client never received.
//
// Every case here runs latency-ONLY. A terminal rate would return early inside
// the chaos block and hide the normal path, which is exactly what used to make
// this class of bug invisible.
// ---------------------------------------------------------------------------
describe("a cancelled chaos latency neither serves nor journals (C13)", () => {
  const C13_LATENCY_MS = 600;
  const C13_ABORT_AT_MS = 80;

  interface SplitGateCase extends RawRequest {
    name: string;
    /** The path fragment this gate logs, used as the positive control below. */
    needle: string;
  }

  // One case per split gate in `src/server.ts`, enumerated by grepping for the
  // sites that call `awaitChaosLatency` and `evaluateChaos` separately.
  const SPLIT_GATES: SplitGateCase[] = [
    {
      name: "the chat completions gate",
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "Content-Type": "application/json" },
      body: chatBody,
      needle: "/v1/chat/completions",
    },
    {
      name: "the x-fal-target-host general fal gate",
      method: "POST",
      path: "/fal/queue/submit/fal-ai/flux",
      headers: { "Content-Type": "application/json", "x-fal-target-host": "queue.fal.run" },
      body: JSON.stringify({ prompt: "hello" }),
      needle: "/fal/queue/submit/",
    },
    {
      name: "the legacy /fal/queue/requests gate",
      method: "GET",
      path: "/fal/queue/requests/missing-id",
      headers: {},
      body: null,
      needle: "/fal/queue/requests/",
    },
  ];

  for (const gate of SPLIT_GATES) {
    it(`journals nothing when the client hangs up mid-delay on ${gate.name}`, async () => {
      // Spy and server inside the try, so a `createServer` throw cannot leave
      // `console.log` mocked for the rest of the run (see C15).
      let lines: string[] | undefined;
      let restore: (() => void) | undefined;
      let instance: Awaited<ReturnType<typeof createServer>> | undefined;
      try {
        ({ lines, restore } = captureLogs());
        instance = await createServer([textFixture("hello-chaos")], {
          chaos: { latencyMs: C13_LATENCY_MS },
          logLevel: "debug",
        });
        const port = Number(new URL(instance.url).port);
        await abortMidFlight(port, gate, C13_ABORT_AT_MS);
        // POSITIVE CONTROL. `journal === []` is what a working gate produces —
        // and also what a request that never reached the server produces, what
        // a route that 404s before the chaos gate produces, and what a handler
        // deleted outright produces. So wait for THIS gate to say, on one
        // line, that it saw this request and declined it after the delay. Only
        // then is the empty journal evidence of anything.
        //
        // It doubles as the deadline: the fixed `C13_LATENCY_MS + 400` sleep it
        // replaces was simultaneously too short for a loaded runner and paid in
        // full by every green run.
        const declined = await msUntilLogged(
          lines,
          [gate.needle, GONE_AFTER_LATENCY],
          Date.now(),
          C13_LATENCY_MS * 4,
        );
        expect(
          declined,
          `${gate.name} never logged that it handled and declined the aborted request`,
        ).toBeGreaterThanOrEqual(0);
        expect(instance.journal.getAll()).toEqual([]);
      } finally {
        if (instance) await closeServer(instance.server);
        restore?.();
      }
    });
  }

  it("still serves and journals exactly once for a patient client", async () => {
    const instance = await createServer([textFixture("hello-chaos")], {
      chaos: { latencyMs: C13_LATENCY_MS },
    });
    try {
      const res = await fetch(`${instance.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody,
      });
      const payload = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(res.status).toBe(200);
      expect(payload.choices[0].message.content).toBe("hello-chaos");
      const entries = instance.journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });
});

// The return value used to be a bare boolean, so "chaos fired" and "the
// response was already dead" were indistinguishable to every one of the 36
// call sites. Both stay truthy — `if (await applyChaosAsync(...)) return;`
// keeps its meaning — but the reason is now readable.
describe("applyChaosAsync reports WHY it returned", () => {
  it('returns "handled" when a terminal action actually fired', async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    const { res, state } = fakeRes();
    const outcome = await applyChaosAsync(
      res,
      null,
      { rateLimitRate: 1 },
      {},
      "/v1/chat/completions",
      journal,
      journalContext(),
      "internal",
    );
    expect(outcome).toBe("handled");
    expect(state.status).toBe(429);
    expect(journal.getAll()).toHaveLength(1);
  });

  it("returns false when no action fired, so the caller proceeds", async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    const { res } = fakeRes();
    const outcome = await applyChaosAsync(
      res,
      null,
      {},
      {},
      "/v1/chat/completions",
      journal,
      journalContext(),
      "internal",
    );
    expect(outcome).toBe(false);
    expect(journal.getAll()).toEqual([]);
  });

  it('returns "unwritable" — not "handled" — for a response that is already gone', async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    const { res, state } = fakeRes();
    res.destroy();
    const outcome = await applyChaosAsync(
      res,
      null,
      { rateLimitRate: 1 },
      {},
      "/v1/chat/completions",
      journal,
      journalContext(),
      "internal",
    );
    expect(outcome).toBe("unwritable");
    // Nothing written, nothing journalled: the dead-response branch is not a
    // chaos hit and must not be reported as one.
    expect(state.status).toBe(0);
    expect(journal.getAll()).toEqual([]);
  });

  it("stays truthy in the standard call shape for both non-false outcomes", async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    for (const setup of [
      () => fakeRes().res,
      () => {
        const { res } = fakeRes();
        res.destroy();
        return res;
      },
    ]) {
      const outcome = await applyChaosAsync(
        setup(),
        null,
        { rateLimitRate: 1 },
        {},
        "/v1/chat/completions",
        journal,
        journalContext(),
        "internal",
      );
      expect(Boolean(outcome)).toBe(true);
    }
  });
});

// `responseUnwritable` collapsed three different situations into one bit, so
// the skip log said "client aborted or ended" even when the socket was healthy
// and someone had merely committed a status line first.
describe("responseUnwritableReason distinguishes the three ways a response dies", () => {
  it("names a destroyed socket as client-gone", async () => {
    const { responseUnwritableReason, responseUnwritable } = await import("../chaos.js");
    const { res } = fakeRes();
    expect(responseUnwritableReason(res)).toBeNull();
    expect(responseUnwritable(res)).toBe(false);
    res.destroy();
    expect(responseUnwritableReason(res)).toBe("client-gone");
    expect(responseUnwritable(res)).toBe(true);
  });

  it("names an ended body as already-ended", async () => {
    const { responseUnwritableReason } = await import("../chaos.js");
    const { res } = fakeRes();
    res.writeHead(200);
    res.end("done");
    expect(responseUnwritableReason(res)).toBe("already-ended");
  });

  it("names a committed status line as headers-sent, not as a disconnect", async () => {
    const { responseUnwritableReason } = await import("../chaos.js");
    const { res } = fakeRes();
    res.writeHead(200);
    expect(responseUnwritableReason(res)).toBe("headers-sent");
  });
});

// ---------------------------------------------------------------------------
// Terminal actions OTHER than rateLimit, through the async entrypoint.
//
// Everything above that drives `applyChaosAsync` to a terminal action uses
// `rateLimitRate`, so `drop` and `malformed` were only ever exercised through
// the SYNC `applyChaos` / `evaluateChaos` (see chaos.test.ts). That left the
// async wrapper's contract unproven for two of its four actions: a wrapper
// that awaited the delay and then returned `false` for them — or journalled
// them under the wrong status — would have been invisible here.
//
// Each case also checks the delay is awaited BEFORE the write, which is the
// property this whole file exists to protect: the action cannot land faster
// than the latency it was configured with.
// ---------------------------------------------------------------------------
describe("applyChaosAsync delays and then fires the non-rateLimit actions too", () => {
  it('writes and journals a 500 for "drop", after the configured delay', async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    const { res, state } = fakeRes();

    const t0 = Date.now();
    const outcome = await applyChaosAsync(
      res,
      null,
      { latencyMs: LATENCY_MS, dropRate: 1 },
      {},
      "/v1/chat/completions",
      journal,
      journalContext(),
      "internal",
    );
    const elapsed = Date.now() - t0;

    expect(outcome).toBe("handled");
    expect(state.status).toBe(500);
    expect(JSON.parse(state.body)).toEqual({
      error: { message: "Chaos: request dropped", type: "server_error", code: "chaos_drop" },
    });
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.status).toBe(500);
    expect(entries[0].response.chaosAction).toBe("drop");
    // Ordering, not throughput: the 500 cannot predate the delay it was
    // configured behind.
    expect(elapsed).toBeGreaterThanOrEqual(DELAY_FLOOR_MS);
  });

  it('writes unparseable JSON under a 200 for "malformed", after the delay', async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    const { res, state } = fakeRes();

    const t0 = Date.now();
    const outcome = await applyChaosAsync(
      res,
      null,
      { latencyMs: LATENCY_MS, malformedRate: 1 },
      {},
      "/v1/chat/completions",
      journal,
      journalContext(),
      "internal",
    );
    const elapsed = Date.now() - t0;

    expect(outcome).toBe("handled");
    expect(state.status).toBe(200);
    // The point of the action: a 200 with a JSON content type whose body does
    // NOT parse, so a client's happy path hits its own parser error.
    expect(state.headers["Content-Type"]).toBe("application/json");
    expect(() => JSON.parse(state.body)).toThrow();
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.status).toBe(200);
    expect(entries[0].response.chaosAction).toBe("malformed");
    expect(elapsed).toBeGreaterThanOrEqual(DELAY_FLOOR_MS);
  });

  it('returns "unwritable" for drop and malformed on a dead response', async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    for (const defaults of [{ dropRate: 1 }, { malformedRate: 1 }]) {
      const journal = new Journal();
      const { res, state } = fakeRes();
      res.destroy();
      const outcome = await applyChaosAsync(
        res,
        null,
        defaults,
        {},
        "/v1/chat/completions",
        journal,
        journalContext(),
        "internal",
      );
      expect(outcome).toBe("unwritable");
      expect(state.status).toBe(0);
      expect(journal.getAll()).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// C14: chaos config parsing, repeated headers, and logging honesty.
//
// Four defects, one class — the chaos config layer said one thing and did
// another:
//   1. `parseChaosNumber` documented a strict full-string parse but leaned on
//      `Number()`, which reads JS numeric LITERALS: `0x1` became `dropRate: 1`
//      (a 100% outage from a typo) and `1e3` became a 1s latency.
//   2. A repeated header whose first value was empty behaved differently in its
//      two wire shapes: the comma-folded `",500"` warned "rejected ... \"\"" and
//      dropped the 500, while the array `["", "500"]` went silently absent.
//   3. An invalid STATIC value (a server default, a fixture's chaos) is re-read
//      on every request, so one typo warned forever — once per request, for the
//      life of the process.
//   4. The deprecation notice for the sync `applyChaos` export accepted a
//      `logger` and then ignored it, writing straight to `console.warn`.
//
// Each test below pins the fixed behaviour AND names the pre-fix symptom, so a
// revert turns them red rather than merely un-asserted.
// ---------------------------------------------------------------------------
describe("C14: chaos config parsing and logging honesty", () => {
  describe("parseChaosNumber: a plain decimal, not a JS numeric literal", () => {
    it("rejects hex, binary, octal, exponent and Infinity forms for a rate", async () => {
      const { parseChaosNumber } = chaos;
      // Pre-fix every one of these parsed: 0x1 -> 1 (drop EVERY request),
      // 0b1 -> 1, 1e-1 -> 0.1, and "Infinity" was only caught downstream.
      for (const raw of ["0x1", "0X1", "0b1", "0o1", "1e-1", "+0.5", "Infinity", "1_0"]) {
        expect(parseChaosNumber(raw, 1)).toBeUndefined();
      }
    });

    it("rejects exponent and hex forms for the latency field too", async () => {
      const { parseChaosNumber } = chaos;
      // "1e3" used to become a 1000ms delay nobody wrote.
      for (const raw of ["1e3", "0x1e", "2.5e2", "-0", "Infinity"]) {
        expect(parseChaosNumber(raw, 30000, true)).toBeUndefined();
      }
    });

    it("rejects a fractional latency, which is not a whole count of ms", async () => {
      const { parseChaosNumber } = chaos;
      expect(parseChaosNumber("250.5", 30000, true)).toBeUndefined();
      expect(parseChaosNumber(250.5, 30000, true)).toBeUndefined();
      expect(parseChaosNumber("250", 30000, true)).toBe(250);
      expect(parseChaosNumber(250, 30000, true)).toBe(250);
    });

    it("still accepts the plain decimals it always did", async () => {
      const { parseChaosNumber } = chaos;
      expect(parseChaosNumber("0.5", 1)).toBe(0.5);
      expect(parseChaosNumber(".5", 1)).toBe(0.5);
      expect(parseChaosNumber("1", 1)).toBe(1);
      expect(parseChaosNumber("0", 1)).toBe(0);
      expect(parseChaosNumber(" 500 ", 30000, true)).toBe(500);
    });

    it("rejects an exotic header value end to end instead of applying chaos", async () => {
      // The whole point: `x-aimock-chaos-drop: 0x1` must NOT drop the request.
      const { evaluateChaos: evalChaos, resolveChaosLatencyMs: latencyOf } = chaos;
      const logger = { warn: vi.fn() };
      for (let i = 0; i < 30; i++) {
        expect(evalChaos(null, undefined, { "x-aimock-chaos-drop": "0x1" }, logger as never)).toBe(
          null,
        );
      }
      expect(latencyOf(null, undefined, { "x-aimock-chaos-latency": "1e3" }, logger as never)).toBe(
        0,
      );
      expect(logger.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        'rejected dropRate value "0x1"',
      );
    });
  });

  describe("repeated headers: the first NON-EMPTY value wins, in both shapes", () => {
    it("uses the value when the first of a repeat is empty — array and folded alike", async () => {
      const { resolveChaosLatencyMs: latencyOf } = chaos;
      const logger = { warn: vi.fn() };
      // Pre-fix: the folded form warned 'rejected latencyMs value ""' and
      // returned 0; the array form silently returned 0 with no warning at all.
      expect(
        latencyOf(null, undefined, { "x-aimock-chaos-latency": ",500" }, logger as never),
      ).toBe(500);
      expect(
        latencyOf(null, undefined, { "x-aimock-chaos-latency": ["", "500"] }, logger as never),
      ).toBe(500);
      // Same wire request, same answer, and NEITHER shape is "rejected".
      expect(logger.warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("rejected");
    });

    it("treats a wholly empty header as absent, with no warning", async () => {
      const { resolveChaosLatencyMs: latencyOf } = chaos;
      const logger = { warn: vi.fn() };
      for (const raw of ["", " ", ",", ", ,", [], ["", ""]] as (string | string[])[]) {
        expect(
          latencyOf(null, { latencyMs: 42 }, { "x-aimock-chaos-latency": raw }, logger as never),
        ).toBe(42); // falls through to the server default, i.e. header absent
      }
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("warns once when a repeat carries values that disagree, and takes the first", async () => {
      const { resolveChaosLatencyMs: latencyOf } = chaos;
      const logger = { warn: vi.fn() };
      expect(
        latencyOf(null, undefined, { "x-aimock-chaos-latency": ["500", "0"] }, logger as never),
      ).toBe(500);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(String(logger.warn.mock.calls[0]?.[0])).toContain("conflicting values");

      // Agreeing repeats are not a misconfiguration: silent.
      const quiet = { warn: vi.fn() };
      expect(
        latencyOf(null, undefined, { "x-aimock-chaos-latency": "500, 500" }, quiet as never),
      ).toBe(500);
      expect(quiet.warn).not.toHaveBeenCalled();
    });
  });

  describe("static config warns once; per-request headers warn every time", () => {
    it("warns once for one invalid server default across many live requests", async () => {
      // Spy and server are both acquired INSIDE the try (C15): installed
      // outside it, a `createServer` throw skips the `finally`, leaving
      // `console.warn` mocked for every later test in the run — which silently
      // swallows the very warnings the rest of this describe asserts on — and
      // a server still listening.
      let lines: string[] | undefined;
      let restore: (() => void) | undefined;
      let instance: Awaited<ReturnType<typeof createServer>> | undefined;
      try {
        ({ lines, restore } = captureWarnings());
        // 1.5 is out of range for a rate: rejected, so no chaos fires either.
        instance = await createServer([textFixture("hello-chaos")], {
          logLevel: "warn",
          chaos: { dropRate: 1.5 },
        });
        const captured = lines;
        const hits = (): number =>
          captured.filter((l) => l.includes("rejected dropRate value 1.5")).length;
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`${instance.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: chatBody,
          });
          await res.text();
          expect(res.status).toBe(200); // rejected, never clamped to a drop
        }
        // Pre-fix this was 5, and 10 after the next five.
        expect(hits()).toBe(1);
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`${instance.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: chatBody,
          });
          await res.text();
        }
        expect(hits()).toBe(1);
      } finally {
        if (instance) await closeServer(instance.server);
        restore?.();
      }
    });

    it("warns once per DISTINCT bad static value, not once overall", async () => {
      const { resolveChaosConfig, resetChaosWarnings } = chaos;
      const logger = { warn: vi.fn() };
      // The latch is keyed by the logger, so the reset names the logger too.
      resetChaosWarnings(logger as never);
      for (let i = 0; i < 4; i++)
        resolveChaosConfig(null, { dropRate: 7 }, undefined, logger as never);
      for (let i = 0; i < 4; i++)
        resolveChaosConfig(null, { dropRate: 9 }, undefined, logger as never);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      const all = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(all).toContain("rejected dropRate value 7");
      expect(all).toContain("rejected dropRate value 9");
    });

    it("keeps warning per request for an invalid HEADER — dynamic input is not latched", async () => {
      const { resolveChaosConfig } = chaos;
      const logger = { warn: vi.fn() };
      for (let i = 0; i < 4; i++) {
        resolveChaosConfig(null, undefined, { "x-aimock-chaos-drop": "2.0" }, logger as never);
      }
      expect(logger.warn).toHaveBeenCalledTimes(4);
    });

    it("resetChaosWarnings re-arms the latch, so a reset suite sees the typo again", async () => {
      const { resolveChaosConfig, resetChaosWarnings } = chaos;
      const logger = { warn: vi.fn() };
      resolveChaosConfig(null, { dropRate: 3 }, undefined, logger as never);
      resolveChaosConfig(null, { dropRate: 3 }, undefined, logger as never);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      resetChaosWarnings(logger as never);
      resolveChaosConfig(null, { dropRate: 3 }, undefined, logger as never);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("a logger-less call does not consume the latch a real logger would use", async () => {
      const { resolveChaosConfig } = chaos;
      resolveChaosConfig(null, { dropRate: 4 }, undefined, undefined);
      const logger = { warn: vi.fn() };
      resolveChaosConfig(null, { dropRate: 4 }, undefined, logger as never);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("the deprecation notice honours the injected logger", () => {
    it("goes to the logger, and NOT to console.warn, when a logger is passed", async () => {
      const { applyChaosDeprecated } = await freshChaosModule();
      const { lines, restore } = captureWarnings();
      try {
        const logger = { warn: vi.fn(), debug: vi.fn() };
        const { res } = fakeRes();
        applyChaosDeprecated(
          res,
          null,
          undefined,
          {},
          "/v1/chat/completions",
          new Journal(),
          journalContext(),
          "internal",
          undefined,
          logger as never,
        );
        const notice = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
        expect(notice).toContain("applyChaos() is deprecated");
        expect(notice).toContain("applyChaosAsync");
        // Pre-fix the line went straight to console.warn, ignoring the logger
        // (and its configured level) entirely.
        expect(lines.filter((l) => l.includes("applyChaos() is deprecated"))).toHaveLength(0);
      } finally {
        restore();
      }
    });

    it("still falls back to console.warn for the call sites that pass no logger", async () => {
      const { applyChaosDeprecated } = await freshChaosModule();
      const { lines, restore } = captureWarnings();
      try {
        const { res } = fakeRes();
        applyChaosDeprecated(
          res,
          null,
          undefined,
          {},
          "/v1/chat/completions",
          new Journal(),
          journalContext(),
          "internal",
        );
        expect(lines.filter((l) => l.includes("applyChaos() is deprecated"))).toHaveLength(1);
      } finally {
        restore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// C17 — the C14 warning latches were wrongly scoped and uninformative.
//
// Four pre-fix symptoms, all reproduced against live servers before the fix:
//   1. `warnedStaticRejections` was a module-global Set shared by every server
//      in the process, though `performFullReset` documented it as per-server
//      state. Two LLMocks with the SAME bad value warned ONCE between them, and
//      one server's `reset()` re-armed the other's latch.
//   2. The deprecation notice's latch was never cleared by anything, unlike its
//      sibling. That is now the DOCUMENTED choice (it describes the embedder's
//      code, which a reset cannot change), and it is pinned here.
//   3. The latch key omitted fixture identity and the message said only
//      "fixture chaos", so of N fixtures carrying the same typo exactly one
//      warned and the line named none of them.
//   4. The repeated-header conflict check compared header TEXT, so
//      `0.5, 0.50` — one rate written twice — warned about a conflict.
// ---------------------------------------------------------------------------
describe("C17: chaos warning latches are per-server and name their source", () => {
  function body(message: string): string {
    return JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: message }] });
  }

  async function post(
    url: string,
    message: string,
    headers: Record<string, string> = {},
  ): Promise<void> {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body(message),
    });
    await res.text();
  }

  it("two servers in ONE process each report their own bad value, and reset is per-server", async () => {
    const { lines, restore } = captureWarnings();
    const a = new LLMock({ logLevel: "warn", chaos: { dropRate: 1.5 } });
    const b = new LLMock({ logLevel: "warn", chaos: { dropRate: 1.5 } });
    a.addFixture(textFixture("hello-chaos"));
    b.addFixture(textFixture("hello-chaos"));
    const hits = (): number =>
      lines.filter((l) => l.includes("rejected dropRate value 1.5")).length;
    try {
      const urlA = await a.start();
      const urlB = await b.start();

      for (let i = 0; i < 3; i++) await post(urlA, "hello-chaos");
      expect(hits()).toBe(1); // latched after the first request, as before
      for (let i = 0; i < 3; i++) await post(urlB, "hello-chaos");
      // Pre-fix this stayed at 1: B inherited A's process-global latch and
      // never said a word about its own misconfiguration.
      expect(hits()).toBe(2);

      // A's reset re-arms A only — B's latch is not the same object.
      a.reset();
      a.addFixture(textFixture("hello-chaos"));
      await post(urlA, "hello-chaos");
      expect(hits()).toBe(3);
      await post(urlB, "hello-chaos");
      expect(hits()).toBe(3);

      // ...and B's own reset re-arms B.
      b.reset();
      b.addFixture(textFixture("hello-chaos"));
      await post(urlB, "hello-chaos");
      expect(hits()).toBe(4);
    } finally {
      await a.stop();
      await b.stop();
      restore();
    }
  });

  it("resetChaosWarnings clears only the named server's latch", async () => {
    const { resolveChaosConfig, resetChaosWarnings } = chaos;
    const one = { warn: vi.fn() };
    const two = { warn: vi.fn() };
    resolveChaosConfig(null, { dropRate: 7 }, undefined, one as never);
    resolveChaosConfig(null, { dropRate: 7 }, undefined, two as never);
    expect(one.warn).toHaveBeenCalledTimes(1);
    expect(two.warn).toHaveBeenCalledTimes(1); // pre-fix: 0, silenced by `one`
    resetChaosWarnings(one as never);
    resolveChaosConfig(null, { dropRate: 7 }, undefined, one as never);
    resolveChaosConfig(null, { dropRate: 7 }, undefined, two as never);
    expect(one.warn).toHaveBeenCalledTimes(2);
    expect(two.warn).toHaveBeenCalledTimes(1); // pre-fix: re-armed by one's reset
  });

  it("bounds the latch: past the cap the oldest key is evicted, not the newest kept forever", async () => {
    const { resolveChaosConfig } = chaos;
    const logger = { warn: vi.fn() };
    // 64 distinct bad values fill the cap; the 65th evicts the first.
    for (let i = 0; i < 65; i++)
      resolveChaosConfig(null, { dropRate: 2 + i }, undefined, logger as never);
    expect(logger.warn).toHaveBeenCalledTimes(65);
    // The oldest key is gone, so its value warns again...
    resolveChaosConfig(null, { dropRate: 2 }, undefined, logger as never);
    expect(logger.warn).toHaveBeenCalledTimes(66);
    // ...while a still-latched one stays quiet.
    resolveChaosConfig(null, { dropRate: 60 }, undefined, logger as never);
    expect(logger.warn).toHaveBeenCalledTimes(66);
  });

  it("names the FIXTURE, so N fixtures sharing one typo each get a line", async () => {
    const { lines, restore } = captureWarnings();
    const mock = new LLMock({ logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "alpha" },
      response: { content: "a" },
      chaos: { latencyMs: 45000 },
    });
    mock.addFixture({
      match: { userMessage: "beta" },
      response: { content: "b" },
      chaos: { latencyMs: 45000 },
    });
    try {
      const url = await mock.start();
      await post(url, "alpha");
      await post(url, "beta");
      const warned = lines.filter((l) => l.includes("rejected latencyMs value 45000"));
      // Pre-fix: ONE line, reading "fixture chaos" and naming neither fixture.
      expect(warned).toHaveLength(2);
      expect(warned.some((l) => l.includes('userMessage("alpha")'))).toBe(true);
      expect(warned.some((l) => l.includes('userMessage("beta")'))).toBe(true);
    } finally {
      await mock.stop();
      restore();
    }
  });

  it("names the testId scope, so a scoped override and the baseline do not latch each other", async () => {
    const { resolveChaosConfig } = chaos;
    const logger = { warn: vi.fn() };
    const byTestId = new Map([["scoped", { dropRate: 5 }]]);
    const defaults = { base: { dropRate: 5 }, byTestId };
    resolveChaosConfig(null, defaults, undefined, logger as never, "/v1/chat/completions");
    resolveChaosConfig(
      null,
      defaults,
      undefined,
      logger as never,
      "/v1/chat/completions?testId=scoped",
    );
    // Pre-fix both shared the source string "server chaos default": one line.
    expect(logger.warn).toHaveBeenCalledTimes(2);
    const all = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).toContain('server chaos default (testId "scoped")');
  });

  it("a repeated header that AGREES is not a conflict, however it is spelled", async () => {
    const { resolveChaosConfig } = chaos;
    const logger = { warn: vi.fn() };
    const resolved = resolveChaosConfig(
      null,
      undefined,
      { "x-aimock-chaos-drop": "0.5, 0.50" },
      logger as never,
    );
    // Pre-fix: "repeated header with conflicting values" — a TEXT comparison.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(resolved.dropRate).toBe(0.5);
  });

  it("a repeated header whose values really differ still warns", async () => {
    const { resolveChaosConfig } = chaos;
    const logger = { warn: vi.fn() };
    resolveChaosConfig(null, undefined, { "x-aimock-chaos-drop": "0.5, 0.25" }, logger as never);
    const all = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).toContain("repeated header with conflicting values");
  });

  it("an unparseable repeat stands for itself: a typo still disagrees with a number", async () => {
    const { resolveChaosConfig } = chaos;
    const logger = { warn: vi.fn() };
    resolveChaosConfig(null, undefined, { "x-aimock-chaos-drop": "0.5, banana" }, logger as never);
    const all = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).toContain("repeated header with conflicting values");
  });

  it("the deprecation notice stays once per process — resetChaosWarnings does not re-arm it", async () => {
    const { applyChaosDeprecated, resetChaosWarnings } = await freshChaosModule();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const call = (): void => {
      const { res } = fakeRes();
      applyChaosDeprecated(
        res,
        null,
        undefined,
        {},
        "/v1/chat/completions",
        new Journal(),
        journalContext(),
        "internal",
        undefined,
        logger as never,
      );
    };
    call();
    const notices = (): number =>
      logger.warn.mock.calls.filter((c) => String(c[0]).includes("applyChaos() is deprecated"))
        .length;
    expect(notices()).toBe(1);
    resetChaosWarnings(logger as never);
    call();
    // Documented behaviour: the notice is about the CALLER'S CODE, which a
    // reset cannot change, so it is not re-armed with the config latch.
    expect(notices()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C18: writability is THREE states, not one bit, and the outcome value must be
// safe for the `if (await applyChaosAsync(...)) return;` idiom every handler
// uses.
//
// The model these tests pin:
//
//   client-gone / already-ended / chaos-disconnected  → the response is GONE.
//       Nothing can be done: no delay, no action, no metric, no journal entry.
//       `applyChaosAsync` reports `"unwritable"` (truthy) so the caller stops.
//   headers-sent  → a status line is committed but the socket is healthy.
//       Body actions (drop / malformed / rateLimit) are impossible, but
//       `disconnect` — a bare `res.destroy()` — still is, and the configured
//       latency is still meaningful. A skipped body action reports `false`
//       so the caller CARRIES ON and finishes serving its healthy body.
//
// No chaos gate in `src/server.ts` currently runs after a `writeHead`, so
// there is no live route that reaches the headers-sent branch today: these
// drive it through a headers-sent double instead. It is a trap armed for the
// first post-`writeHead` gate, not a live bug — hence unit-level proof.
// ---------------------------------------------------------------------------
describe("C18: headers-sent is not death, and the outcome is safe to branch on", () => {
  /** A live response that has committed a status line but not ended or died. */
  function headersSentRes(): FakeRes {
    const fake = fakeRes();
    fake.res.writeHead(200, { "Content-Type": "text/event-stream" });
    return fake;
  }

  it("still awaits the configured latency once headers are committed", async () => {
    const { res } = headersSentRes();
    const t0 = Date.now();
    await awaitChaosLatency(null, { latencyMs: 200 }, {}, undefined, "/", res);
    const elapsed = Date.now() - t0;
    // Pre-fix `awaitChaosLatency` aborted immediately on `headersSent`, zeroing
    // the delay for every post-headers gate.
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  it("fires disconnect on an already-committed response", async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    const { res } = headersSentRes();
    const outcome = await applyChaosAsync(
      res,
      null,
      { disconnectRate: 1 },
      {},
      "/v1/chat/completions",
      journal,
      journalContext(),
      "internal",
    );
    expect(outcome).toBe("handled");
    expect(res.destroyed).toBe(true);
    expect(journal.getAll()[0].response.chaosAction).toBe("disconnect");
  });

  it("returns falsy for a body action that cannot run on a committed response", async () => {
    const { applyChaosAsync } = await import("../chaos.js");
    const journal = new Journal();
    const { res, state } = headersSentRes();
    const outcome = await applyChaosAsync(
      res,
      null,
      { dropRate: 1 },
      {},
      "/v1/chat/completions",
      journal,
      journalContext(),
      "internal",
    );
    // The ubiquitous `if (outcome) return;` must NOT abandon a healthy body.
    expect(Boolean(outcome)).toBe(false);
    expect(state.status).toBe(200);
    expect(res.destroyed).toBe(false);
    expect(res.writableEnded).toBe(false);
    expect(journal.getAll()).toEqual([]);
  });

  it("names a normally-ended response on a torn-down connection already-ended", async () => {
    const { responseUnwritableReason } = await import("../chaos.js");
    const { res } = fakeRes();
    res.writeHead(200);
    res.end("done");
    res.destroy();
    // Pre-fix this checked `destroyed` first and logged "the client disconnected"
    // about a response the client received in full.
    expect(responseUnwritableReason(res)).toBe("already-ended");
  });

  it("distinguishes our own disconnect action from a client hang-up", async () => {
    const journal = new Journal();
    const { res } = fakeRes();
    applyChaosAction(
      "disconnect",
      res,
      null,
      journal,
      journalContext(),
      "internal",
      undefined,
      undefined,
    );
    expect(responseUnwritableReason(res)).toBe("chaos-disconnected");
    expect(responseGone(res)).toBe(true);
    // A client that hangs up on its own is still client-gone.
    const other = fakeRes();
    other.res.destroy();
    expect(responseUnwritableReason(other.res)).toBe("client-gone");
  });

  it("counts the chaos metric only after the write actually happened", async () => {
    const journal = new Journal();
    const { res } = fakeRes();
    const registry = createMetricsRegistry();
    vi.spyOn(res, "writeHead").mockImplementation(() => {
      throw new Error("ERR_STREAM_DESTROYED");
    });
    expect(() =>
      applyChaosAction(
        "drop",
        res,
        null,
        journal,
        journalContext(),
        "internal",
        registry,
        undefined,
      ),
    ).toThrow("ERR_STREAM_DESTROYED");
    // Pre-fix the counter was bumped BEFORE the write, so a throw left the
    // action counted but never sent.
    expect(registry.serialize()).not.toContain("aimock_chaos_triggered_total");

    // Control: the same action on a writable response IS counted.
    const ok = fakeRes();
    applyChaosAction(
      "drop",
      ok.res,
      null,
      journal,
      journalContext(),
      "internal",
      registry,
      undefined,
    );
    expect(registry.serialize()).toContain('aimock_chaos_triggered_total{action="drop"');
  });
});

/**
 * ONE table, ONE grammar, whatever the entry point (C19).
 *
 * Chaos config arrives from five places — request headers, fixture `chaos`,
 * server defaults, `POST /__aimock/chaos` and the `--chaos-*` CLI flags — and
 * they used to disagree: the control API had its own re-typed bounds and no
 * integer check (it answered 200 to `latencyMs: 250.5`, echoed it from `GET`,
 * and the resolver then silently dropped it at request time), the CLI re-typed
 * `1` / `30000` as literals, and a typed number skipped every VALUE rule the
 * string path applied (`-0` survived as `-0`). These pin the shared behaviour.
 */
describe("chaos config: one parser and one table across every entry point", () => {
  /** A fresh `chaos.js` instance, so no module-level warning latch leaks in. */
  describe("the VALUE rules apply to typed numbers, not just to text", () => {
    it("rejects negative zero from a number exactly as it rejects the string", async () => {
      const { parseChaosField } = chaos;
      expect(parseChaosField("dropRate", -0)).toBeUndefined();
      expect(parseChaosField("dropRate", "-0")).toBeUndefined();
      expect(parseChaosField("latencyMs", -0)).toBeUndefined();
      // Positive zero is a real, meaningful value and stays accepted.
      expect(parseChaosField("dropRate", 0)).toBe(0);
      expect(Object.is(parseChaosField("dropRate", 0), -0)).toBe(false);
    });

    it("rejects a fractional, non-finite or out-of-range number for the field's own bound", async () => {
      const { parseChaosField, CHAOS_FIELDS } = chaos;
      expect(parseChaosField("latencyMs", 250.5)).toBeUndefined();
      expect(parseChaosField("latencyMs", Number.NaN)).toBeUndefined();
      expect(parseChaosField("latencyMs", Number.POSITIVE_INFINITY)).toBeUndefined();
      expect(parseChaosField("latencyMs", CHAOS_FIELDS.latencyMs.max + 1)).toBeUndefined();
      expect(parseChaosField("latencyMs", CHAOS_FIELDS.latencyMs.max)).toBe(
        CHAOS_FIELDS.latencyMs.max,
      );
      expect(parseChaosField("dropRate", 1.0001)).toBeUndefined();
      expect(parseChaosField("dropRate", 0.5)).toBe(0.5);
    });

    it("warns, naming the field, when a fixture's typed number is rejected", async () => {
      const { resolveChaosConfig } = chaos;
      const logger = { warn: vi.fn() };
      const fixture: Fixture = {
        match: { userMessage: "x" },
        response: { content: "x" },
        chaos: { dropRate: -0, latencyMs: 250.5 },
      };
      expect(resolveChaosConfig(fixture, undefined, undefined, logger as never)).toEqual({});
      const lines = logger.warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("fixture chaos") && l.includes("dropRate"))).toBe(true);
      expect(lines.some((l) => l.includes("fixture chaos") && l.includes("latencyMs"))).toBe(true);
    });

    it("still accepts a number that only LOOKS like a rejected spelling", async () => {
      // `1e3` in a fixture or a JSON body has already been through a JSON
      // parser and reaches us as the number 1000 — indistinguishable from a
      // literal 1000, so it is accepted. The grammar polices TEXT: the same
      // value spelled `"1e3"` on a header is rejected. This asymmetry is the
      // documented contract, not a gap, and it is pinned so a future change
      // has to be deliberate.
      const { parseChaosField } = chaos;
      expect(parseChaosField("latencyMs", 1e3)).toBe(1000);
      expect(parseChaosField("latencyMs", "1e3")).toBeUndefined();
    });
  });

  describe("POST /__aimock/chaos validates through the shared table", () => {
    it("400s a fractional latencyMs instead of storing a value it will never apply", async () => {
      const instance = await createServer([textFixture("hello-chaos")], {});
      try {
        const bad = await fetch(`${instance.url}/__aimock/chaos`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-test-id": "frac" },
          body: JSON.stringify({ latencyMs: 250.5 }),
        });
        expect(bad.status).toBe(400);
        const body = (await bad.json()) as { error: string };
        // The field must be named — "invalid body" leaves the caller guessing.
        expect(body.error).toContain("latencyMs");

        // Nothing was stored: GET reports the (empty) config actually in effect.
        const get = await fetch(`${instance.url}/__aimock/chaos`, {
          headers: { "x-test-id": "frac" },
        });
        expect(await get.json()).toEqual({ chaos: {} });
      } finally {
        await closeServer(instance.server);
      }
    });

    it("400s an out-of-range rate or latency, and accepts a valid install", async () => {
      // `-0` is deliberately absent: `JSON.stringify(-0)` is `"0"`, so negative
      // zero cannot survive the wire to this endpoint at all. It is reachable
      // only through the in-process config paths, pinned above.
      const instance = await createServer([textFixture("hello-chaos")], {});
      try {
        for (const body of [{ dropRate: 1.5 }, { latencyMs: 30001 }, { latencyMs: -1 }]) {
          const res = await fetch(`${instance.url}/__aimock/chaos`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-test-id": "bounds" },
            body: JSON.stringify(body),
          });
          expect(res.status).toBe(400);
          const failure = (await res.json()) as { error: string };
          expect(failure.error).toContain(Object.keys(body)[0]);
        }
        const ok = await fetch(`${instance.url}/__aimock/chaos`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-test-id": "bounds" },
          body: JSON.stringify({ latencyMs: 250, dropRate: 0 }),
        });
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ chaos: { latencyMs: 250, dropRate: 0 } });
      } finally {
        await closeServer(instance.server);
      }
    });
  });

  describe("the CLI reads the bounds out of the table", () => {
    it("does not re-type any chaos bound as a literal", async () => {
      // The drift this guards is invisible at runtime until someone changes a
      // cap: a hand-written `30000` in cli.ts keeps the flag on the old limit
      // with no compile error. Checked at the source, because that IS the
      // defect — two sources of one number.
      const { readFileSync } = await import("node:fs");
      const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
      expect(cli).toContain("parseChaosField");
      expect(cli).not.toContain("parseChaosNumber");
      const chaosSection = cli.slice(cli.indexOf("chaos-drop"));
      expect(chaosSection).not.toMatch(/parseChaos\w+\([^)]*,\s*\d/);
    });
  });

  describe("a byTestId entry that is present selects, whatever its value", () => {
    it("selects an explicitly-installed empty override instead of falling back to base", async () => {
      const { resolveChaosConfig } = chaos;
      const base = { latencyMs: 700 };
      // `undefined` and `{}` are both "an override was installed for t1, and it
      // asks for no chaos" — neither may leak the baseline's 700ms back in.
      // The `undefined` value is off-type (the map is declared
      // `ReadonlyMap<string, ChaosConfig>`), so it is built and cast here the
      // way an untyped JS caller would hand it over: that is precisely the
      // shape the `has`-based lookup is defensive about, and a test that could
      // only express the well-typed half would not exercise it.
      const installations: Array<ChaosConfig | undefined> = [undefined, {}];
      for (const installed of installations) {
        const byTestId = new Map([["t1", installed]]) as ReadonlyMap<string, ChaosConfig>;
        expect(resolveChaosConfig(null, { base, byTestId }, { "x-test-id": "t1" })).toEqual({});
      }
      // Controls: an absent key still falls back, and a populated override
      // still REPLACES (not merges over) the baseline.
      const scope = { base, byTestId: new Map([["t1", { dropRate: 0 }]]) };
      expect(resolveChaosConfig(null, scope, { "x-test-id": "other" })).toEqual({ latencyMs: 700 });
      expect(resolveChaosConfig(null, scope, { "x-test-id": "t1" })).toEqual({ dropRate: 0 });
    });

    it("reports an empty object as a config, and both empties resolve to no chaos", async () => {
      // `{}` satisfies ChaosScope and ChaosConfig alike, so the structural test
      // cannot tell them apart — pinned because the docstring says so and
      // because both branches must stay observationally identical.
      const { isChaosScope, resolveChaosConfig } = chaos;
      expect(isChaosScope({})).toBe(false);
      expect(isChaosScope({ byTestId: new Map() })).toBe(true);
      expect(resolveChaosConfig(null, {}, undefined)).toEqual({});
      expect(resolveChaosConfig(null, { byTestId: new Map() }, undefined)).toEqual({});
    });
  });
});
