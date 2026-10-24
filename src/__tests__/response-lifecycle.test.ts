import { EventEmitter } from "node:events";
import type * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ABORTED,
  httpLifecycle,
  markInterrupted,
  wsLifecycle,
} from "../response/lifecycle.js";
import { applyChaosAction } from "../chaos.js";
import { Journal } from "../journal.js";
import type { Fixture, JournalEntry } from "../types.js";
import type { WebSocketConnection } from "../ws-framing.js";

class FakeRes extends EventEmitter {
  writableFinished = false;
  writableEnded = false;
  destroyed = false;
  headersSent = false;
}

class FakeWs extends EventEmitter {
  isClosed = false;
  destroy(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit("close", 1006, "Connection destroyed");
  }
}

const asRes = (res: FakeRes): http.ServerResponse => res as unknown as http.ServerResponse;
const asWs = (ws: FakeWs): WebSocketConnection => ws as unknown as WebSocketConnection;

/**
 * The request socket state the lifecycle reads. `readableEnded` is the bare
 * FIN, which is not a hang-up; Node ending our write side on it
 * (`writableEnded`) or a reset (`errored`) is.
 */
interface FakeSocketState {
  readableEnded: boolean;
  writableEnded: boolean;
  errored: Error | null;
}

function withSocket(res: FakeRes, socket: FakeSocketState): FakeRes {
  Object.assign(res, { req: { socket } });
  return res;
}

const plain: Fixture = { match: {}, response: { content: "hi" } };
const truncate2: Fixture = { ...plain, truncateAfterChunks: 2 };
const disconnect50: Fixture = { ...plain, disconnectAfterMs: 50 };

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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("httpLifecycle", () => {
  it("aborts with cause client when the response closes before it finished", () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    expect(lifecycle.signal.aborted).toBe(false);
    res.emit("close");
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.cause()).toBe("client");
    expect(lifecycle.reason()).toBe(CLIENT_ABORTED);
    lifecycle.dispose();
  });

  it("ignores a close after the response finished", () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    res.writableFinished = true;
    res.emit("close");
    expect(lifecycle.signal.aborted).toBe(false);
    expect(lifecycle.cause()).toBeUndefined();
    expect(lifecycle.reason()).toBeUndefined();
    lifecycle.dispose();
  });

  it("keeps the fixture reason when the fixture abort is followed by the resulting close", () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(asRes(res), truncate2, { streaming: true });
    lifecycle.tick();
    lifecycle.tick();
    expect(lifecycle.signal.aborted).toBe(true);
    res.destroyed = true;
    res.emit("close");
    expect(lifecycle.cause()).toBe("fixture");
    expect(lifecycle.reason()).toBe("truncateAfterChunks");
    lifecycle.dispose();
  });

  it("keeps the client cause when the client closes first and the fixture aborts after", () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(asRes(res), truncate2, { streaming: true });
    res.emit("close");
    expect(lifecycle.cause()).toBe("client");
    lifecycle.tick();
    lifecycle.tick();
    expect(lifecycle.cause()).toBe("client");
    expect(lifecycle.reason()).toBe(CLIENT_ABORTED);
    lifecycle.dispose();
  });

  it("aborts at once when the client is already gone at construction", () => {
    const res = new FakeRes();
    res.destroyed = true;
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.cause()).toBe("client");
    lifecycle.dispose();
  });

  it("never classifies an already-ended response as a client abort", () => {
    const res = new FakeRes();
    res.writableEnded = true;
    res.destroyed = true;
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    expect(lifecycle.signal.aborted).toBe(false);
    expect(lifecycle.cause()).toBeUndefined();
    lifecycle.dispose();
  });

  it("never classifies a chaos-disconnected response as a client abort", () => {
    const res = new FakeRes();
    const destroy = vi.fn(() => {
      res.destroyed = true;
    });
    Object.assign(res, { destroy });
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
    expect(destroy).toHaveBeenCalledOnce();
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.cause()).toBe("server");
    expect(lifecycle.reason()).toBe("disconnect");
    lifecycle.dispose();
  });

  it("attributes a close with no client FIN or RST on the socket to aimock", () => {
    const res = withSocket(new FakeRes(), {
      readableEnded: false,
      writableEnded: false,
      errored: null,
    });
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    res.destroyed = true;
    res.emit("close");
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.cause()).toBe("server");
    expect(lifecycle.reason()).toBe("disconnect");
    lifecycle.dispose();
  });

  it("attributes a close after the client FIN, which Node answers by ending our side, to the client", () => {
    const socket: FakeSocketState = { readableEnded: false, writableEnded: false, errored: null };
    const res = withSocket(new FakeRes(), socket);
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    socket.readableEnded = true;
    socket.writableEnded = true;
    res.destroyed = true;
    res.emit("close");
    expect(lifecycle.cause()).toBe("client");
    expect(lifecycle.reason()).toBe(CLIENT_ABORTED);
    lifecycle.dispose();
  });

  it("does not treat a FIN alone as a client hang-up", () => {
    const socket: FakeSocketState = { readableEnded: true, writableEnded: false, errored: null };
    const res = withSocket(new FakeRes(), socket);
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    res.destroyed = true;
    res.emit("close");
    expect(lifecycle.cause()).toBe("server");
    expect(lifecycle.reason()).toBe("disconnect");
    lifecycle.dispose();
  });

  it("attributes a close after a client RST (socket error) to the client", () => {
    const res = withSocket(new FakeRes(), {
      readableEnded: false,
      writableEnded: false,
      errored: new Error("read ECONNRESET"),
    });
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    res.destroyed = true;
    res.emit("close");
    expect(lifecycle.cause()).toBe("client");
    expect(lifecycle.reason()).toBe(CLIENT_ABORTED);
    lifecycle.dispose();
  });

  it("aborts with cause server when aimock already destroyed the response at construction", () => {
    const res = withSocket(new FakeRes(), {
      readableEnded: false,
      writableEnded: false,
      errored: null,
    });
    res.destroyed = true;
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.cause()).toBe("server");
    expect(lifecycle.reason()).toBe("disconnect");
    lifecycle.dispose();
  });

  it("creates no fixture interruption when not streaming", () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(asRes(res), truncate2, { streaming: false });
    lifecycle.tick();
    lifecycle.tick();
    lifecycle.tick();
    expect(lifecycle.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const timed = httpLifecycle(asRes(res), disconnect50, { streaming: false });
    expect(vi.getTimerCount()).toBe(0);
    lifecycle.dispose();
    timed.dispose();
  });

  it("aborts with the fixture reason when disconnectAfterMs fires", () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(asRes(res), disconnect50, { streaming: true });
    vi.advanceTimersByTime(50);
    expect(lifecycle.cause()).toBe("fixture");
    expect(lifecycle.reason()).toBe("disconnectAfterMs");
    lifecycle.dispose();
  });

  it("dispose removes the close listener and clears the disconnectAfterMs timer", () => {
    const res = new FakeRes();
    const lifecycle = httpLifecycle(asRes(res), disconnect50, { streaming: true });
    expect(res.listenerCount("close")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    lifecycle.dispose();
    expect(res.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    res.emit("close");
    expect(lifecycle.signal.aborted).toBe(false);
  });

  it("does not throw for a partial double without once/off", () => {
    const partial = { writableFinished: false } as unknown as http.ServerResponse;
    const lifecycle = httpLifecycle(partial, null, { streaming: true });
    expect(lifecycle.signal.aborted).toBe(false);
    expect(() => lifecycle.tick()).not.toThrow();
    expect(() => lifecycle.dispose()).not.toThrow();
  });

  it("removes through removeListener when off is absent", () => {
    const res = new FakeRes();
    const remover = vi.spyOn(res, "removeListener");
    Object.defineProperty(res, "off", { value: undefined });
    const lifecycle = httpLifecycle(asRes(res), plain, { streaming: true });
    lifecycle.dispose();
    expect(remover).toHaveBeenCalledWith("close", expect.any(Function));
    expect(res.listenerCount("close")).toBe(0);
  });
});

describe("wsLifecycle", () => {
  it("aborts with cause client on a WS close", () => {
    const ws = new FakeWs();
    const lifecycle = wsLifecycle(asWs(ws), plain);
    ws.emit("close", 1006, "gone");
    expect(lifecycle.cause()).toBe("client");
    expect(lifecycle.reason()).toBe(CLIENT_ABORTED);
    lifecycle.dispose();
  });

  it("aborts at once when the socket is already closed", () => {
    const ws = new FakeWs();
    ws.isClosed = true;
    const lifecycle = wsLifecycle(asWs(ws), plain);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.cause()).toBe("client");
    lifecycle.dispose();
  });

  it("keeps the fixture reason when truncateAfterChunks fires and ws.destroy() closes", () => {
    const ws = new FakeWs();
    const lifecycle = wsLifecycle(asWs(ws), truncate2);
    lifecycle.tick();
    lifecycle.tick();
    ws.destroy();
    expect(lifecycle.cause()).toBe("fixture");
    expect(lifecycle.reason()).toBe("truncateAfterChunks");
    lifecycle.dispose();
  });

  it("keeps the fixture reason when disconnectAfterMs fires and ws.destroy() closes", () => {
    const ws = new FakeWs();
    const lifecycle = wsLifecycle(asWs(ws), disconnect50);
    vi.advanceTimersByTime(50);
    ws.destroy();
    expect(lifecycle.cause()).toBe("fixture");
    expect(lifecycle.reason()).toBe("disconnectAfterMs");
    lifecycle.dispose();
  });

  it("always owns the fixture signal, and dispose clears its timer and listener", () => {
    const ws = new FakeWs();
    const lifecycle = wsLifecycle(asWs(ws), disconnect50);
    expect(vi.getTimerCount()).toBe(1);
    expect(ws.listenerCount("close")).toBe(1);
    lifecycle.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(ws.listenerCount("close")).toBe(0);
  });
});

describe("markInterrupted", () => {
  it("sets interrupted and the reason, and never touches status", () => {
    const e = entry();
    markInterrupted(e, CLIENT_ABORTED);
    expect(e.response).toEqual({
      status: 200,
      fixture: null,
      interrupted: true,
      interruptReason: CLIENT_ABORTED,
    });
  });

  it("never overwrites an existing reason, and never erases it with undefined", () => {
    const e = entry();
    markInterrupted(e, "truncateAfterChunks");
    markInterrupted(e, CLIENT_ABORTED);
    markInterrupted(e, undefined);
    expect(e.response.interruptReason).toBe("truncateAfterChunks");
    expect(e.response.status).toBe(200);
  });

  it("marks interrupted without a reason when none is known", () => {
    const e = entry();
    markInterrupted(e, undefined);
    expect(e.response.interrupted).toBe(true);
    expect("interruptReason" in e.response).toBe(false);
  });
});
