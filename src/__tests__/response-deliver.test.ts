import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverJson, deliverStream } from "../response/deliver.js";
import { proxyInterruption, withHangUpDetection } from "../response/proxy.js";
import { CLIENT_ABORTED, teardownReason } from "../response/lifecycle.js";
import { applyChaosAction } from "../chaos.js";
import { Journal } from "../journal.js";
import type { FrameCodec } from "../response/frame-loop.js";
import type { Fixture, JournalEntry, RecordedTimings } from "../types.js";

type Op = Record<string, unknown>;

class FakeRes extends EventEmitter {
  ops: Op[] = [];
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  headersSent = false;
  statusCode = 200;
  setHeader(name: string, value: string): void {
    this.ops.push({ op: "setHeader", name, value });
  }
  writeHead(status: number, headers?: Record<string, string>): this {
    this.ops.push({ op: "writeHead", status, headers });
    this.headersSent = true;
    return this;
  }
  write(chunk: string): boolean {
    this.ops.push({ op: "write", chunk });
    // A real write commits the status line and headers.
    this.headersSent = true;
    return true;
  }
  end(chunk?: string): this {
    this.ops.push(chunk === undefined ? { op: "end" } : { op: "end", chunk });
    this.writableEnded = true;
    this.writableFinished = true;
    return this;
  }
  destroy(): this {
    this.ops.push({ op: "destroy" });
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

const asRes = (res: FakeRes): http.ServerResponse => res as unknown as http.ServerResponse;

function entry(): JournalEntry {
  return {
    id: "e1",
    timestamp: 0,
    method: "POST",
    path: "/x",
    headers: {},
    body: null,
    response: { status: 200, fixture: null },
  };
}

function fixture(extra: Partial<Fixture> = {}): Fixture {
  return { match: {}, response: { content: "hello" }, ...extra };
}

const codec: FrameCodec<string> = {
  headers: { "Content-Type": "text/event-stream" },
  encode: (frame) => `data: ${frame}\n\n`,
};

const jsonOpts = { surface: "other" as const, payloadLength: 10, chunkSize: 5 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("deliverJson default path", () => {
  it("writes the same writeHead/end calls as today and calls the thunk exactly once", async () => {
    const res = new FakeRes();
    const body = vi.fn(() => ({ a: 1 }));
    await deliverJson(asRes(res), entry(), fixture(), body, jsonOpts);
    expect(body).toHaveBeenCalledOnce();
    expect(res.ops).toEqual([
      { op: "writeHead", status: 200, headers: { "Content-Type": "application/json" } },
      { op: "end", chunk: '{"a":1}' },
    ]);
  });

  it("does not wait when the fixture has a profile but no opt-in", async () => {
    const res = new FakeRes();
    const promise = deliverJson(
      asRes(res),
      entry(),
      fixture({ streamingProfile: { ttft: 5000 } }),
      () => ({}),
      jsonOpts,
    );
    await promise;
    expect(res.ops).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surface other with nonStreamingTiming: true does not wait (M1 row a)", async () => {
    const res = new FakeRes();
    const promise = deliverJson(
      asRes(res),
      entry(),
      fixture({ nonStreamingTiming: true, streamingProfile: { ttft: 5000 } }),
      () => ({}),
      jsonOpts,
    );
    // Flush microtasks only: no timer was armed and the reply is already written.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(res.ops).toHaveLength(2);
    await vi.runAllTimersAsync();
    await promise;
  });

  it("a throwing thunk propagates and writeHead is never called", async () => {
    const res = new FakeRes();
    await expect(
      deliverJson(
        asRes(res),
        entry(),
        fixture(),
        () => {
          throw new Error("builder failed");
        },
        jsonOpts,
      ),
    ).rejects.toThrow("builder failed");
    expect(res.ops).toEqual([]);
  });

  it("status and headers (#549): headers merged over Content-Type", async () => {
    const res = new FakeRes();
    await deliverJson(asRes(res), entry(), fixture(), () => ({ ok: true }), {
      ...jsonOpts,
      status: 201,
      headers: { "x-a": "1", "Content-Type": "application/x-json" },
    });
    expect(res.ops[0]).toEqual({
      op: "writeHead",
      status: 201,
      headers: { "Content-Type": "application/x-json", "x-a": "1" },
    });
  });
});

describe("deliverJson timed path", () => {
  const timed = fixture({
    nonStreamingTimingAllProviders: true,
    streamingProfile: { ttft: 300, tps: 10 },
  });

  it("waits the nonStreamingDelayMs total, then calls the thunk after the timer fires", async () => {
    const res = new FakeRes();
    // Hand-computed: 10 chars at chunkSize 5 is 2 chunks, ttft 300 + 1000 / 10 tps.
    const expected = 400;
    let readAt = -1;
    const body = vi.fn(() => {
      readAt = Date.now();
      return { created: Math.floor(Date.now() / 1000) };
    });
    const start = Date.now();
    const promise = deliverJson(asRes(res), entry(), timed, body, jsonOpts);
    await vi.advanceTimersByTimeAsync(expected - 1);
    expect(body).not.toHaveBeenCalled();
    expect(res.ops).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(body).toHaveBeenCalledOnce();
    expect(readAt - start).toBe(expected);
    expect(res.ops.map((o) => o.op)).toEqual(["writeHead", "end"]);
  });

  it("a client abort during the wait never calls the thunk, writes nothing, and marks the entry", async () => {
    const res = new FakeRes();
    const e = entry();
    const body = vi.fn(() => ({}));
    const promise = deliverJson(asRes(res), e, timed, body, jsonOpts);
    await vi.advanceTimersByTimeAsync(100);
    res.destroyed = true;
    res.emit("close");
    await promise;
    expect(body).not.toHaveBeenCalled();
    expect(res.ops).toEqual([]);
    // No status line was ever sent: the server-wide rule journals status 0.
    expect(e.response).toMatchObject({
      status: 0,
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("serves a NaN chunkSize (a non-numeric user value after Math.max) with no wait, as base did", async () => {
    const res = new FakeRes();
    const body = vi.fn(() => ({ ok: true }));
    await deliverJson(asRes(res), entry(), timed, body, { ...jsonOpts, chunkSize: Number.NaN });
    expect(body).toHaveBeenCalledOnce();
    expect(res.ops.map((o) => o.op)).toEqual(["writeHead", "end"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1])(
    "rejects chunkSize %s as a programming error and writes nothing",
    async (chunkSize) => {
      const res = new FakeRes();
      const body = vi.fn(() => ({}));
      await expect(
        deliverJson(asRes(res), entry(), timed, body, { ...jsonOpts, chunkSize }),
      ).rejects.toThrow(/chunkSize must be >= 1/);
      expect(body).not.toHaveBeenCalled();
      expect(res.ops).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("a client already gone at the start skips the wait, never calls the thunk, and marks the entry", async () => {
    const res = new FakeRes();
    res.destroyed = true;
    const e = entry();
    const body = vi.fn(() => ({}));
    // No timers are advanced: the call must finish without waiting.
    await deliverJson(asRes(res), e, timed, body, jsonOpts);
    expect(body).not.toHaveBeenCalled();
    expect(res.ops).toEqual([]);
    expect(e.response.interrupted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a response destroyed during the wait without a close event writes nothing and marks the entry", async () => {
    const res = new FakeRes();
    const e = entry();
    const body = vi.fn(() => ({}));
    const promise = deliverJson(asRes(res), e, timed, body, jsonOpts);
    await vi.advanceTimersByTimeAsync(100);
    res.destroyed = true;
    await vi.runAllTimersAsync();
    await promise;
    expect(body).not.toHaveBeenCalled();
    expect(res.ops).toEqual([]);
    // No close reached the lifecycle, so the reason comes from the teardown
    // fallback; no status line was sent, so the status is 0.
    expect(e.response.status).toBe(0);
    expect(e.response.interrupted).toBe(true);
    expect(e.response.interruptReason).toBe(teardownReason(asRes(res)));
    expect(e.response.interruptReason).toBeDefined();
  });

  it("a thunk that throws after the wait propagates, writes nothing, and disposes", async () => {
    const res = new FakeRes();
    const promise = deliverJson(
      asRes(res),
      entry(),
      timed,
      () => {
        throw new Error("late builder failure");
      },
      jsonOpts,
    );
    const assertion = expect(promise).rejects.toThrow("late builder failure");
    await vi.runAllTimersAsync();
    await assertion;
    expect(res.ops).toEqual([]);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("surface openai-chat honors nonStreamingTiming: true", async () => {
    const res = new FakeRes();
    const f = fixture({ nonStreamingTiming: true, streamingProfile: { ttft: 400 } });
    const promise = deliverJson(asRes(res), entry(), f, () => ({}), {
      ...jsonOpts,
      surface: "openai-chat",
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(res.ops).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(res.ops).toHaveLength(2);
  });

  it("applies the duplicate-id extension (hand-computed)", async () => {
    // 16 chars at chunkSize 3 is 6 chunks. The recorded gaps [1, 9] are
    // extended to 5 gaps by repeating the last one: 5 + 1 + 4 * 9 = 42ms.
    // Without the extension the 3 extra chunks would average the recorded
    // gaps (5ms): 5 + 1 + 9 + 3 * 5 = 30ms.
    const recorded: RecordedTimings = {
      ttftMs: 5,
      interChunkDelaysMs: [1, 9],
      totalDurationMs: 15,
    };
    const f = fixture({ nonStreamingTimingAllProviders: true, recordedTimings: recorded });
    const res = new FakeRes();
    const promise = deliverJson(asRes(res), entry(), f, () => ({}), {
      surface: "other",
      payloadLength: 16,
      chunkSize: 3,
      recordedTimings: recorded,
      duplicateId: true,
      replaySpeed: 1,
    });
    await vi.advanceTimersByTimeAsync(41);
    expect(res.ops).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(res.ops).toHaveLength(2);
    expect(recorded.interChunkDelaysMs).toEqual([1, 9]);
  });

  it("an empty payload still waits one chunk: the ttft (the Math.max(1, …) clamp)", async () => {
    // ceil(0 / 3) is 0 chunks; the clamp makes it 1, so the wait is ttft 5ms.
    const recorded: RecordedTimings = {
      ttftMs: 5,
      interChunkDelaysMs: [1, 9],
      totalDurationMs: 15,
    };
    const f = fixture({ nonStreamingTimingAllProviders: true, recordedTimings: recorded });
    const res = new FakeRes();
    const promise = deliverJson(asRes(res), entry(), f, () => ({}), {
      surface: "other",
      payloadLength: 0,
      chunkSize: 3,
      recordedTimings: recorded,
      duplicateId: true,
      replaySpeed: 1,
    });
    await vi.advanceTimersByTimeAsync(4);
    expect(res.ops).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(res.ops).toHaveLength(2);
  });
});

describe("deliverStream", () => {
  it("streams the frames with the codec and leaves a healthy entry unmarked", async () => {
    const res = new FakeRes();
    const e = entry();
    await deliverStream(asRes(res), e, fixture(), codec, ["a", "b"], {});
    expect(res.ops).toEqual([
      { op: "setHeader", name: "Content-Type", value: "text/event-stream" },
      { op: "write", chunk: "data: a\n\n" },
      { op: "write", chunk: "data: b\n\n" },
      { op: "end" },
    ]);
    expect(e.response.interrupted).toBeUndefined();
  });

  it("on a client abort: destroy, then mark, then dispose", async () => {
    const res = new FakeRes();
    const e = entry();
    const order: string[] = [];
    const origDestroy = res.destroy.bind(res);
    res.destroy = () => {
      order.push(`destroy:${String(e.response.interrupted)}`);
      return origDestroy();
    };
    // dispose() removes the close listener through `off`: record whether the
    // entry was already marked at that point.
    const origOff = res.off.bind(res);
    res.off = (event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "close") order.push(`dispose:${String(e.response.interrupted)}`);
      return origOff(event, listener);
    };
    const promise = deliverStream(asRes(res), e, fixture(), codec, ["a", "b", "c"], {
      latency: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    res.emit("close");
    await promise;
    order.push(`listeners:${res.listenerCount("close")}`);
    expect(order).toEqual(["destroy:undefined", "dispose:true", "listeners:0"]);
    expect(e.response).toMatchObject({
      status: 200,
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
    expect(res.ops.filter((o) => o.op === "write")).toHaveLength(1);
  });

  it("a truncateAfterChunks reason wins over the close its destroy causes", async () => {
    // The close is emitted synchronously inside destroy(), while the lifecycle
    // still listens, so the client cause really reaches the lifecycle.
    class SyncCloseRes extends FakeRes {
      closesSeen = 0;
      override destroy(): this {
        this.ops.push({ op: "destroy" });
        this.destroyed = true;
        this.closesSeen = this.listenerCount("close");
        this.emit("close");
        return this;
      }
    }
    const res = new SyncCloseRes();
    const e = entry();
    await deliverStream(
      asRes(res),
      e,
      fixture({ truncateAfterChunks: 2 }),
      codec,
      ["a", "b", "c"],
      {},
    );
    await vi.runAllTimersAsync();
    expect(res.closesSeen).toBe(1);
    expect(e.response.interruptReason).toBe("truncateAfterChunks");
    expect(res.ops.filter((o) => o.op === "write")).toHaveLength(2);
    expect(res.ops.at(-1)).toEqual({ op: "destroy" });
  });

  it("a response destroyed mid-stream without a close event is journaled through the teardown fallback", async () => {
    const res = new FakeRes();
    const e = entry();
    const promise = deliverStream(asRes(res), e, fixture(), codec, ["a", "b", "c"], {
      latency: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    // Gone, but no close event: the lifecycle never fired, so it has no reason.
    res.destroyed = true;
    await vi.runAllTimersAsync();
    await promise;
    expect(res.ops.filter((o) => o.op === "write")).toHaveLength(1);
    expect(e.response.interrupted).toBe(true);
    expect(e.response.interruptReason).toBe(teardownReason(asRes(res)));
    expect(e.response.interruptReason).toBeDefined();
    // The first frame committed the status line, so the status is kept.
    expect(e.response.status).toBe(200);
  });

  it("does not destroy an already-ended response when the loop reports an abort", async () => {
    const res = new FakeRes();
    const e = entry();
    const promise = deliverStream(asRes(res), e, fixture({ disconnectAfterMs: 10 }), codec, ["a"], {
      latency: 20,
    });
    await vi.advanceTimersByTimeAsync(5);
    res.writableEnded = true;
    await vi.runAllTimersAsync();
    await promise;
    expect(res.ops.some((o) => o.op === "destroy")).toBe(false);
    expect(e.response.interruptReason).toBe("disconnectAfterMs");
  });

  it("status and headers (#549): writeHead(status, merged) before the first frame", async () => {
    const res = new FakeRes();
    await deliverStream(
      asRes(res),
      entry(),
      fixture(),
      codec,
      ["a"],
      {},
      {
        status: 207,
        headers: { "x-a": "1" },
      },
    );
    expect(res.ops[0]).toEqual({
      op: "writeHead",
      status: 207,
      headers: { "Content-Type": "text/event-stream", "x-a": "1" },
    });
  });

  it("a response chaos already tore down is journaled with the chaos reason and status 0", async () => {
    // The chaos `disconnect` destroyed the response before streaming and no
    // `close` reached the lifecycle: the loop stops on a gone sink alone.
    const res = new FakeRes();
    res.destroy = function (this: FakeRes) {
      this.destroyed = true;
      return this;
    };
    applyChaosAction(
      "disconnect",
      asRes(res),
      null,
      new Journal(),
      { method: "POST", path: "/x", headers: {}, body: null },
      "fixture",
      undefined,
      undefined,
    );
    const e = entry();
    await deliverStream(asRes(res), e, fixture(), codec, ["a", "b"], {});
    expect(res.ops.filter((o) => o.op === "write")).toHaveLength(0);
    expect(e.response).toMatchObject({
      status: 0,
      interrupted: true,
      interruptReason: "disconnect",
    });
  });

  it("a server-side destroy is not attributed to the client", async () => {
    // A request socket that saw no FIN and no RST: aimock tore it down.
    const res = new FakeRes();
    Object.assign(res, { req: { socket: { writableEnded: false, errored: null } } });
    res.destroyed = true;
    const e = entry();
    await deliverStream(asRes(res), e, fixture(), codec, ["a"], {});
    expect(e.response).toMatchObject({ status: 0, interrupted: true });
    expect(e.response.interruptReason).not.toBe(CLIENT_ABORTED);
    expect(e.response.interruptReason).toBe("disconnect");
  });

  it("a client that leaves before the first write journals status 0", async () => {
    const res = new FakeRes();
    const e = entry();
    const promise = deliverStream(asRes(res), e, fixture(), codec, ["a", "b"], { latency: 50 });
    await vi.advanceTimersByTimeAsync(20);
    res.destroyed = true;
    res.emit("close");
    await promise;
    expect(res.ops.filter((o) => o.op === "write")).toHaveLength(0);
    expect(e.response).toMatchObject({
      status: 0,
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
  });

  it("on a real socket, a server destroy mid-stream is journaled as aimock's teardown", async () => {
    vi.useRealTimers();
    const e = entry();
    let done: Promise<void> = Promise.resolve();
    const server = http.createServer((_req, res) => {
      done = deliverStream(res, e, fixture(), codec, ["a", "b", "c", "d"], { latency: 60 });
      setTimeout(() => res.destroy(), 150);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", agent: false });
        req.on("response", (r) => {
          r.on("data", () => undefined);
          r.on("error", () => resolve());
          r.on("close", () => resolve());
        });
        req.on("error", () => resolve());
        req.end();
      });
      await done;
      expect(e.response).toMatchObject({
        status: 200,
        interrupted: true,
        interruptReason: "disconnect",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("on a real socket, a client hang-up mid-stream is still the client's", async () => {
    vi.useRealTimers();
    const e = entry();
    let done: Promise<void> = Promise.resolve();
    const server = http.createServer((_req, res) => {
      done = deliverStream(res, e, fixture(), codec, ["a", "b", "c", "d"], { latency: 60 });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", agent: false });
        req.on("response", (r) => {
          r.once("data", () => {
            req.destroy();
            resolve();
          });
          r.on("error", () => undefined);
        });
        req.on("error", () => undefined);
        req.end();
      });
      await expect.poll(() => e.response.interrupted, { timeout: 2000 }).toBe(true);
      await done;
      expect(e.response).toMatchObject({ status: 200, interruptReason: CLIENT_ABORTED });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("omitted status and headers give the default setHeader calls", async () => {
    const a = new FakeRes();
    const b = new FakeRes();
    await deliverStream(asRes(a), entry(), fixture(), codec, ["a"], {});
    await deliverStream(asRes(b), entry(), fixture(), codec, ["a"], {}, {});
    expect(a.ops).toEqual(b.ops);
  });
});

describe("proxy helpers", () => {
  class FakeSocket extends EventEmitter {
    destroyed = false;
    errored: Error | null = null;
    writableEnded = false;
  }

  it("withHangUpDetection reports a client-caused close before the response ended, and removes its listener", async () => {
    for (const close of [
      (s: FakeSocket) => (s.errored = new Error("ECONNRESET")),
      (s: FakeSocket) => (s.writableEnded = true),
    ]) {
      const socket = new FakeSocket();
      const req = { socket } as unknown as http.IncomingMessage;
      const result = await withHangUpDetection(req, asRes(new FakeRes()), async () => {
        close(socket);
        socket.destroyed = true;
        socket.emit("close");
        return "relayed";
      });
      expect(result).toEqual({ outcome: "relayed", clientHungUp: true });
      expect(socket.listenerCount("close")).toBe(0);
    }
  });

  it("withHangUpDetection ignores a half-close and our own tear-down", async () => {
    const socket = new FakeSocket();
    const req = { socket } as unknown as http.IncomingMessage;
    const result = await withHangUpDetection(req, asRes(new FakeRes()), async () => {
      socket.emit("end");
      socket.destroyed = true;
      socket.emit("close");
      return 1;
    });
    expect(result.clientHungUp).toBe(false);
  });

  it("withHangUpDetection ignores a close after the response ended", async () => {
    const socket = new FakeSocket();
    const req = { socket } as unknown as http.IncomingMessage;
    const res = new FakeRes();
    res.writableEnded = true;
    const result = await withHangUpDetection(req, asRes(res), async () => {
      socket.errored = new Error("x");
      socket.emit("close");
      return 1;
    });
    expect(result.clientHungUp).toBe(false);
  });

  it("withHangUpDetection reports a client already gone on entry", async () => {
    for (const gone of [
      (s: FakeSocket) => (s.destroyed = true),
      (_s: FakeSocket, r: FakeRes) => (r.destroyed = true),
    ]) {
      // The client's socket closed (Node ended our side on its FIN) or reset.
      for (const evidence of [
        (s: FakeSocket) => (s.writableEnded = true),
        (s: FakeSocket) => (s.errored = new Error("ECONNRESET")),
      ]) {
        const socket = new FakeSocket();
        const res = new FakeRes();
        gone(socket, res);
        evidence(socket);
        const req = { socket } as unknown as http.IncomingMessage;
        const result = await withHangUpDetection(req, asRes(res), async () => 1);
        expect(result.clientHungUp).toBe(true);
      }
    }
  });

  it("withHangUpDetection does not blame the client for a response aimock destroyed before entry", async () => {
    for (const gone of [
      (s: FakeSocket) => (s.destroyed = true),
      (_s: FakeSocket, r: FakeRes) => (r.destroyed = true),
    ]) {
      const socket = new FakeSocket();
      const res = new FakeRes();
      gone(socket, res);
      const req = { socket } as unknown as http.IncomingMessage;
      const result = await withHangUpDetection(req, asRes(res), async () => 1);
      expect(result.clientHungUp).toBe(false);
    }
  });

  it("withHangUpDetection removes its listener when run throws", async () => {
    const socket = new FakeSocket();
    const req = { socket } as unknown as http.IncomingMessage;
    await expect(
      withHangUpDetection(req, asRes(new FakeRes()), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("proxyInterruption names the side that tore down a mid-stream response", () => {
    const res = new FakeRes();
    expect(proxyInterruption(asRes(res), true)).toEqual({});
    res.destroyed = true;
    // No status line sent: status 0.
    expect(proxyInterruption(asRes(res), true)).toEqual({
      status: 0,
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
    res.headersSent = true;
    expect(proxyInterruption(asRes(res), true)).toEqual({
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
    expect(proxyInterruption(asRes(res), false)).toEqual({
      interrupted: true,
      interruptReason: "proxy stream destroyed",
    });
    // `end()` called on a response already torn down never finished it.
    res.writableEnded = true;
    expect(proxyInterruption(asRes(res), true)).toEqual({
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
    res.writableFinished = true;
    expect(proxyInterruption(asRes(res), true)).toEqual({});
  });
});

describe("delivery edges: answered elsewhere and fixture interruptions", () => {
  const timedFixture = fixture({
    nonStreamingTimingAllProviders: true,
    streamingProfile: { ttft: 5000 },
  });

  it("deliverJson destroys a response whose head was sent but whose body never ended", async () => {
    const res = new FakeRes();
    res.writeHead(202);
    res.statusCode = 202; // A real writeHead sets it; the fake does not.
    res.ops = [];
    const e = entry();
    const body = vi.fn(() => ({}));
    await deliverJson(asRes(res), e, fixture(), body, jsonOpts);
    expect(body).not.toHaveBeenCalled();
    expect(res.ops).toEqual([{ op: "destroy" }]);
    expect(e.response).toMatchObject({
      status: 202,
      interrupted: true,
      interruptReason: "disconnect",
    });
  });

  it("deliverJson does not destroy a response that already ended", async () => {
    const res = new FakeRes();
    res.writeHead(200);
    res.end("x");
    res.ops = [];
    const e = entry();
    await deliverJson(asRes(res), e, fixture(), () => ({}), jsonOpts);
    expect(res.ops).toEqual([]);
    expect(e.response).toMatchObject({ interrupted: true, interruptReason: "disconnect" });
  });

  it("with timing on, a response whose head was already sent is journaled at once, with no wait", async () => {
    const res = new FakeRes();
    res.writeHead(201);
    res.statusCode = 201; // A real writeHead sets it; the fake does not.
    res.ops = [];
    const e = entry();
    const body = vi.fn(() => ({}));
    let settled = false;
    const promise = deliverJson(asRes(res), e, timedFixture, body, jsonOpts).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await promise;
    expect(body).not.toHaveBeenCalled();
    expect(e.response).toMatchObject({
      status: 201,
      interrupted: true,
      interruptReason: "disconnect",
    });
  });

  it("with timing on, a response that already ended is journaled at once, with no wait", async () => {
    const res = new FakeRes();
    res.writeHead(200);
    res.end("x");
    res.ops = [];
    const e = entry();
    let settled = false;
    const promise = deliverJson(asRes(res), e, timedFixture, () => ({}), jsonOpts).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await promise;
    expect(res.ops).toEqual([]);
    expect(e.response).toMatchObject({ interrupted: true, interruptReason: "disconnect" });
  });

  it("a fixture disconnectAfterMs before the first byte keeps the journaled status (base: 200)", async () => {
    const res = new FakeRes();
    const e = entry();
    const promise = deliverStream(asRes(res), e, fixture({ disconnectAfterMs: 10 }), codec, ["a"], {
      latency: 50,
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(res.ops.some((o) => o.op === "write")).toBe(false);
    expect(e.response).toMatchObject({
      status: 200,
      interrupted: true,
      interruptReason: "disconnectAfterMs",
    });
  });

  it("a client that leaves before the first byte still journals status 0", async () => {
    const res = new FakeRes();
    const e = entry();
    const promise = deliverStream(
      asRes(res),
      e,
      fixture({ disconnectAfterMs: 100 }),
      codec,
      ["a"],
      {
        latency: 50,
      },
    );
    await vi.advanceTimersByTimeAsync(10);
    res.destroyed = true;
    res.emit("close");
    await vi.runAllTimersAsync();
    await promise;
    expect(e.response).toMatchObject({ status: 0, interruptReason: CLIENT_ABORTED });
  });

  it("deliverStream journals a response that other code ended before the stream", async () => {
    const res = new FakeRes();
    res.writeHead(200);
    res.end("x");
    res.ops = [];
    const e = entry();
    await deliverStream(asRes(res), e, fixture(), codec, ["a"], {});
    expect(res.ops).toEqual([]);
    expect(e.response).toMatchObject({ interrupted: true, interruptReason: "disconnect" });
  });

  it("deliverStream journals a response that other code ended during the stream", async () => {
    const res = new FakeRes();
    const e = entry();
    const promise = deliverStream(asRes(res), e, fixture(), codec, ["a", "b"], { latency: 50 });
    await vi.advanceTimersByTimeAsync(50);
    res.end();
    await vi.runAllTimersAsync();
    await promise;
    expect(res.ops.filter((o) => o.op === "write")).toHaveLength(1);
    expect(res.ops.some((o) => o.op === "destroy")).toBe(false);
    expect(e.response).toMatchObject({
      status: 200,
      interrupted: true,
      interruptReason: "disconnect",
    });
  });

  it("deliverStream on a response whose head was already sent does not throw: it journals and destroys", async () => {
    // A real ServerResponse throws ERR_HTTP_HEADERS_SENT from setHeader/writeHead.
    class HeadSentRes extends FakeRes {
      override setHeader(): void {
        throw Object.assign(new Error("headers sent"), { code: "ERR_HTTP_HEADERS_SENT" });
      }
      override writeHead(): this {
        throw Object.assign(new Error("headers sent"), { code: "ERR_HTTP_HEADERS_SENT" });
      }
    }
    const res = new HeadSentRes();
    res.headersSent = true;
    res.statusCode = 203;
    const e = entry();
    await expect(
      deliverStream(asRes(res), e, fixture(), codec, ["a"], {}),
    ).resolves.toBeUndefined();
    expect(res.ops).toEqual([{ op: "destroy" }]);
    expect(e.response).toMatchObject({
      status: 203,
      interrupted: true,
      interruptReason: "disconnect",
    });
  });
});
