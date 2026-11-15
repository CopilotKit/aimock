/** Integration checks shared by the existing chaos cases. No wall-clock pacing assertions. */
import { expect, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, Logger, proxyAndRecord } from "../index.js";
import type { ChatCompletionRequest } from "../types.js";

const seedHeader = "x-aimock-chaos-seed";
const keyHeader = "x-aimock-chaos-key";
const occurrenceHeader = "x-aimock-chaos-occurrence";
const chat: ChatCompletionRequest = {
  model: "gpt-4",
  messages: [{ role: "user", content: "hello" }],
  stream: true,
};

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function post(url: string, body: object, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

export async function assertCliSeed(seed = "cli-replay-seed"): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aimock-seed-cli-"));
  const fixtures = join(dir, "fixtures.json");
  writeFileSync(fixtures, JSON.stringify([{ match: {}, response: { content: "ok" } }]));
  const reservation = http.createServer();
  const cliUrl = await listen(reservation);
  await close(reservation);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../cli.ts", import.meta.url)),
      "--fixtures",
      fixtures,
      "--port",
      new URL(cliUrl).port,
      "--host",
      "127.0.0.1",
      "--chaos-drop",
      "1",
      "--chaos-seed",
      seed,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "close");
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let finished = false;
      const stop = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(cliUrl);
      };
      const timeout = setTimeout(() => stop(new Error(`CLI did not start: ${output}`)), 10000);
      const probe = async () => {
        while (!finished) {
          try {
            const response = await fetch(`${cliUrl}/__aimock/chaos`, {
              signal: AbortSignal.timeout(500),
            });
            await response.text();
            if (response.ok) {
              stop();
              return;
            }
          } catch {
            /* The process has not opened its listener yet. */
          }
          if (!finished) await new Promise<void>((ready) => setTimeout(ready, 25));
        }
      };
      void probe();
      child.once("error", (error) => stop(error));
      child.once("exit", (code) => {
        stop(new Error(`CLI exited (${code}): ${output}`));
      });
    });
    const state = await (await fetch(`${url}/__aimock/chaos`)).json();
    expect(state).toMatchObject({ dropRate: 1 });
    expect(state.seed).toEqual(expect.any(String));
    expect(state.seed.trim().length).toBeGreaterThan(0);
    if (seed.trim()) expect(state.seed).toBe(seed);
    const response = await post(`${url}/v1/chat/completions`, chat);
    expect(response.status).toBe(500);
    expect(response.headers.get(seedHeader)).toBe(state.seed);
    expect(response.headers.get(keyHeader)).toMatch(/^[0-9a-f]{16}$/);
    expect(response.headers.get(occurrenceHeader)).toBe("0");
    expect(await response.json()).toMatchObject({ error: { code: "chaos_drop" } });
    const reset = await post(`${url}/__aimock/chaos/reset`, {});
    expect(await reset.json()).toEqual({ reset: true, seed: state.seed });
    expect((await (await fetch(`${url}/__aimock/chaos`)).json()).seed).toBe(state.seed);
  } finally {
    child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function assertActiveProxyMalformed(): Promise<void> {
  let contacts = 0;
  const upstream = http.createServer((_req, res) => {
    contacts++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    const tick = setInterval(() => res.write(": active\n\n"), 20);
    res.on("close", () => clearInterval(tick));
  });
  const url = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), "aimock-active-proxy-"));
  try {
    for (const proxyOnly of [false, true]) {
      const instance = await createServer([], {
        port: 0,
        chaos: { seed: "active-stream", malformedRate: 1 },
        record: { providers: { openai: url }, fixturePath: dir, proxyOnly },
      });
      try {
        // Prove the route can relay an active, unfinished upstream when chaos is off.
        const live = await post(`${instance.url}/v1/chat/completions`, chat, {
          "x-aimock-chaos-malformed": "0",
        });
        expect(live.headers.get("content-type")).toContain("text/event-stream");
        const reader = live.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel();
        const beforeMalformed = contacts;

        const response = await post(`${instance.url}/v1/chat/completions`, chat);
        const body = await response.text();
        expect(contacts, "malformed must not contact upstream").toBe(beforeMalformed);
        expect(response.status).toBe(200);
        expect(() => JSON.parse(body)).toThrow();
        expect(response.headers.get(seedHeader)).toBe("active-stream");
        expect(response.headers.get(keyHeader)).toMatch(/^[0-9a-f]{16}$/);
        expect(response.headers.get(occurrenceHeader)).toBe("1");
        expect(
          instance.journal.getAll().find((entry) => entry.response.chaosAction === "malformed")
            ?.response,
        ).toMatchObject({
          chaosSeed: "active-stream",
          chaosKey: response.headers.get(keyHeader),
          chaosOccurrence: 1,
        });
      } finally {
        await close(instance.server);
      }
    }
    // Reserve and close a local port, making connection refusal deterministic
    // without relying on a well-known port being unused on the host.
    const unavailable = http.createServer();
    const unreachable = await listen(unavailable);
    await close(unavailable);
    for (const proxyOnly of [false, true]) {
      const instance = await createServer([], {
        port: 0,
        logLevel: "silent",
        chaos: { seed: "unavailable-upstream", malformedRate: 1 },
        record: { providers: { openai: unreachable }, fixturePath: dir, proxyOnly },
      });
      try {
        for (let occurrence = 0; occurrence < 2; occurrence++) {
          const response = await post(`${instance.url}/v1/chat/completions`, chat);
          expect(response.status).toBe(200);
          const awaitedBody = await response.text();
          expect(() => JSON.parse(awaitedBody)).toThrow();
          expect(response.headers.get(seedHeader)).toBe("unavailable-upstream");
          expect(response.headers.get(keyHeader)).toMatch(/^[0-9a-f]{16}$/);
          expect(response.headers.get(occurrenceHeader)).toBe(String(occurrence));
        }
      } finally {
        await close(instance.server);
      }
    }
  } finally {
    await close(upstream);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Recording caps must not invoke a callback promised after persistence. */
export async function assertRecorderCapLifecycle(): Promise<void> {
  const body = JSON.stringify({
    choices: [{ message: { role: "assistant", content: "complete" } }],
  });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
  const upstreamUrl = await listen(upstream);
  try {
    for (const cap of [Buffer.byteLength(body), Buffer.byteLength(body) - 1]) {
      const dir = mkdtempSync(join(tmpdir(), "aimock-recorder-cap-"));
      const fixtures: Parameters<typeof proxyAndRecord>[5] = [];
      let result: unknown;
      let resolveRelay!: () => void;
      let rejectRelay!: (error: unknown) => void;
      const relayed = new Promise<void>((resolve, reject) => {
        resolveRelay = resolve;
        rejectRelay = reject;
      });
      const before = vi.fn();
      const gateway = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          proxyAndRecord(
            req,
            res,
            { ...chat, stream: false },
            "openai",
            "/v1/chat/completions",
            fixtures,
            {
              logger: new Logger("silent"),
              record: {
                providers: { openai: upstreamUrl },
                fixturePath: dir,
                maxProxyBufferBytes: cap,
              },
            },
            JSON.stringify({ ...chat, stream: false }),
            {
              beforeWriteResponse: (captured) => {
                before(captured.body.toString(), fixtures.length);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end('{"replacement":true}');
                return true;
              },
            },
          ).then((value) => {
            result = value;
            resolveRelay();
          }, rejectRelay);
        });
      });
      try {
        const url = await listen(gateway);
        const response = await post(url + "/v1/chat/completions", { ...chat, stream: false });
        const received = await response.text();
        await relayed;
        expect(response.status).toBe(200);
        if (cap === Buffer.byteLength(body)) {
          expect(before).toHaveBeenCalledExactlyOnceWith(body, 1);
          expect(received).toBe('{"replacement":true}');
          expect(result).toBe("handled_by_hook");
        } else {
          expect(before).not.toHaveBeenCalled();
          expect(fixtures).toHaveLength(0);
          expect(received).toBe(body);
          expect(result).toBe("relayed");
        }
      } finally {
        await close(gateway);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    await close(upstream);
  }
}

/** Exercise the public recorder API independently of the server's chaos policy. */
export async function assertRecorderBypass(): Promise<void> {
  const frames = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(frames);
  });
  const url = await listen(upstream);
  const before = vi.fn(() => false);
  const bypass = vi.fn();
  const dir = mkdtempSync(join(tmpdir(), "aimock-public-proxy-"));
  let resolveRelay!: () => void;
  let rejectRelay!: (error: unknown) => void;
  const relayed = new Promise<void>((resolve, reject) => {
    resolveRelay = resolve;
    rejectRelay = reject;
  });
  const gateway = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      proxyAndRecord(
        req,
        res,
        chat,
        "openai",
        "/v1/chat/completions",
        [],
        {
          logger: new Logger("silent"),
          record: { providers: { openai: url }, fixturePath: dir, proxyOnly: true },
        },
        JSON.stringify(chat),
        { beforeWriteResponse: before, onHookBypassed: bypass },
      ).then(() => resolveRelay(), rejectRelay);
    });
  });
  try {
    const gatewayUrl = await listen(gateway);
    const response = await post(`${gatewayUrl}/v1/chat/completions`, chat);
    expect(await response.text()).toBe(frames);
    await relayed;
    expect(before).not.toHaveBeenCalled();
    expect(bypass).toHaveBeenCalledExactlyOnceWith("sse_streamed");
  } finally {
    await close(gateway);
    await close(upstream);
    rmSync(dir, { recursive: true, force: true });
  }
}
