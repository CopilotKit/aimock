import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMock } from "../llmock.js";
import { connectWebSocket } from "./ws-test-client.js";
import { createLiveReplay } from "../live-replay.js";
import { normalizeLiveOptions, validateLiveTranscript } from "../live-fixture.js";
import type { LiveFailureCategory, LiveObject } from "../live-types.js";
import {
  identifier,
  replaceIdentifier,
  normalizeScenario,
  normalizeCapturedScenario,
  readLiveCase,
  runLiveScenario,
} from "./live-test-support.js";

function setup() {
  const { transcript } = readLiveCase("client");
  const output: LiveObject[] = [];
  const failures: LiveFailureCategory[] = [];
  const abort = new AbortController();
  const replay = createLiveReplay(transcript, {
    send: async (event) => {
      output.push(event);
    },
    fail: (category) => {
      failures.push(category);
    },
    signal: abort.signal,
    replaySpeed: 1,
    timing: "immediate",
    limits: normalizeLiveOptions(),
  });
  return { transcript, output, failures, abort, replay };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("causal live replay", () => {
  it("waits for startup and generates fresh scoped server identities", async () => {
    const a = setup(),
      b = setup();
    await vi.advanceTimersByTimeAsync(10);
    expect(a.output).toEqual([]);
    a.replay.accept(a.transcript.entries[0].event);
    b.replay.accept(b.transcript.entries[0].event);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.output[0]?.type).toBe("session.started");
    expect(a.output[0]?.event_id).not.toBe(b.output[0]?.event_id);
    expect(a.failures).toEqual([]);
    a.replay.close();
    b.replay.close();
  });
  it("aborts all timers", () => {
    const a = setup();
    a.abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function driver(
  mode: "client" | "managed",
  overrides: Partial<Parameters<typeof createLiveReplay>[1]> = {},
) {
  const { transcript } = readLiveCase(mode);
  const output: LiveObject[] = [],
    input: LiveObject[] = [];
  const failures: LiveFailureCategory[] = [];
  const bindings = new Map<string, string>();
  const abort = new AbortController();
  const serverIndices = transcript.entries.flatMap((e, i) => (e.direction === "server" ? [i] : []));
  const replay = createLiveReplay(transcript, {
    signal: abort.signal,
    replaySpeed: 1,
    timing: "immediate",
    limits: normalizeLiveOptions(),
    send: async (event) => {
      const index = serverIndices[output.length];
      for (const b of transcript.bindings.filter((b) => b.entry === index && b.action === "define"))
        bindings.set(b.name, identifier(event, b.pointer));
      output.push(event);
    },
    fail: (category) => {
      failures.push(category);
    },
    ...overrides,
  });
  function accept(index: number) {
    const event = structuredClone(transcript.entries[index].event);
    for (const b of transcript.bindings.filter((b) => b.entry === index)) {
      if (b.action === "define") bindings.set(b.name, `client-${b.name}`);
      const value = bindings.get(b.name);
      if (!value) throw new Error(`missing test binding ${b.name}`);
      replaceIdentifier(event, b.pointer, value);
    }
    input.push(event);
    replay.accept(event);
  }
  return { transcript, output, input, failures, bindings, abort, replay, accept };
}

describe("frozen provider tapes", () => {
  it.each(["client", "managed"] as const)(
    "replays complete %s capture with fresh IDs and preserved literal fields",
    async (mode) => {
      const d = driver(mode);
      for (const [index, entry] of d.transcript.entries.entries()) {
        if (entry.direction === "client") d.accept(index);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(d.failures).toEqual([]);
      expect(normalizeScenario(d.transcript, d.input, d.output)).toEqual(
        normalizeCapturedScenario(d.transcript),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("accepts different PCM chunk boundaries and rejects a changed sample", async () => {
    const d = driver("client");
    d.accept(0);
    const entry = d.transcript.entries.find((e) => e.event.type === "session.input_audio.append")!;
    const bytes = Buffer.from(String(entry.event.audio), "base64");
    let offset = 0;
    for (const size of [2, 14, 48, bytes.length - 64]) {
      d.replay.accept({
        ...entry.event,
        audio: bytes.subarray(offset, offset + size).toString("base64"),
      });
      offset += size;
    }
    expect(d.failures).toEqual([]);
    const wrong = Buffer.from(bytes);
    wrong[12] ^= 1;
    d.replay.accept({ ...entry.event, audio: wrong.toString("base64") });
    expect(d.failures).toEqual(["fixture-mismatch"]);
  });
  it("never crosses a control boundary when coalescing PCM", () => {
    const d = driver("client");
    d.accept(0);
    const run: Buffer[] = [];
    for (const entry of d.transcript.entries.slice(1)) {
      if (entry.direction !== "client") continue;
      if (entry.event.type !== "session.input_audio.append") break;
      run.push(Buffer.from(String(entry.event.audio), "base64"));
    }
    d.replay.accept({
      type: "session.input_audio.append",
      audio: Buffer.concat([...run, Buffer.alloc(2)]).toString("base64"),
    });
    expect(d.failures).toEqual(["fixture-mismatch"]);
  });
  it("does not serialize client acceptance behind an outstanding send", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = driver("client", { send: () => blocked });
    d.accept(0);
    await vi.advanceTimersByTimeAsync(1);
    const audioIndex = d.transcript.entries.findIndex(
      (e) => e.event.type === "session.input_audio.append",
    );
    d.accept(audioIndex);
    expect(d.failures).toEqual([]);
    d.abort.abort();
    release();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([1, 2])(
    "scales recorded timing by %s without releasing before startup",
    async (replaySpeed) => {
      const d = driver("client", { timing: "recorded", replaySpeed });
      const at = d.transcript.entries.find((e) => e.direction === "server")!.atMs / replaySpeed;
      await vi.advanceTimersByTimeAsync(at + 10);
      expect(d.output).toEqual([]);
      d.accept(0);
      await vi.advanceTimersByTimeAsync(Math.floor(at) - 1);
      expect(d.output).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(d.output[0]?.type).toBe("session.started");
      d.replay.close();
    },
  );
  it("fails missing input at the bounded mismatch deadline without echoing payload", async () => {
    const d = driver("client", { limits: normalizeLiveOptions({ mismatchTimeoutMs: 20 }) });
    await vi.advanceTimersByTimeAsync(20);
    expect(d.failures).toEqual(["fixture-mismatch"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects malformed audio and extra client input fields", () => {
    const d = driver("client");
    d.accept(0);
    d.replay.accept({ type: "session.input_audio.append", audio: "AB==" });
    expect(d.failures).toEqual(["fixture-mismatch"]);
    const e = driver("client");
    e.replay.accept({ ...e.transcript.entries[0].event, extra: "unexpected" });
    expect(e.failures).toEqual(["fixture-mismatch"]);
  });
  it("rejects output pressure exceeding the configured write cap", async () => {
    const d = driver("client", { limits: normalizeLiveOptions({ maxWriteBytes: 10 }) });
    d.accept(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.failures).toEqual(["resource-limit"]);
  });
});

describe("barriers and failure isolation", () => {
  it("keeps late audio behind its barrier even after all recorded times elapsed", async () => {
    const d = driver("client");
    d.accept(0);
    await vi.advanceTimersByTimeAsync(1000);
    const firstBlocked = d.transcript.entries.find(
      (e) => e.direction === "server" && e.barrier!.audioBytes > 0,
    )!;
    expect(d.output.length).toBe(
      d.transcript.entries.filter(
        (e) => e.direction === "server" && e.barrier!.command === 1 && e.barrier!.audioBytes === 0,
      ).length,
    );
    expect(firstBlocked.barrier!.audioBytes).toBeGreaterThan(0);
    d.replay.close();
  });
  it("preserves output order while a send is blocked", async () => {
    const sent: string[] = [];
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = driver("client", {
      send: async (event) => {
        sent.push(String(event.type));
        if (sent.length === 1) await pending;
      },
    });
    d.accept(0);
    for (const [index, entry] of d.transcript.entries.entries()) {
      if (index === 0 || entry.direction !== "client") continue;
      if (entry.event.type !== "session.input_audio.append") break;
      d.accept(index);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["session.started"]);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(
      d.transcript.entries
        .filter((e) => e.direction === "server")
        .slice(0, sent.length)
        .map((e) => e.event.type),
    );
    d.replay.close();
  });
  it("rejects a reference copied from another concurrent replay", async () => {
    const a = driver("client"),
      b = driver("client");
    const reference = a.transcript.bindings.find(
      (binding) =>
        binding.owner === "server" && a.transcript.entries[binding.entry].direction === "client",
    )!;
    for (const [index, entry] of a.transcript.entries.entries()) {
      if (index >= reference.entry) break;
      if (entry.direction === "client") {
        a.accept(index);
        b.accept(index);
      }
      await vi.advanceTimersByTimeAsync(1);
    }
    const wrong = structuredClone(a.transcript.entries[reference.entry].event);
    replaceIdentifier(wrong, reference.pointer, b.bindings.get(reference.name)!);
    a.replay.accept(wrong);
    expect(a.failures).toEqual(["fixture-mismatch"]);
    expect(b.failures).toEqual([]);
    b.replay.close();
  });
  it("enforces wall duration during backpressure and absorbs late send rejection", async () => {
    let reject: (reason: Error) => void = () => {};
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const d = driver("client", {
      send: () => pending,
      limits: normalizeLiveOptions({ maxDurationMs: 20 }),
    });
    d.accept(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(d.failures).toEqual(["timeout"]);
    reject(new Error("late transport failure"));
    await Promise.resolve();
    expect(d.failures).toEqual(["timeout"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("bounds input nesting before traversal and does not invoke accessors", () => {
  const a = driver("client");
  const getter = vi.fn(() => "session.start");
  const event: LiveObject = {};
  Object.defineProperty(event, "type", { enumerable: true, get: getter });
  a.replay.accept(event);
  expect(getter).not.toHaveBeenCalled();
  expect(a.failures).toEqual(["invalid-client"]);
  const b = driver("client");
  const deep: LiveObject = {};
  let tail = deep;
  for (let i = 0; i < 40; i++) {
    const child: LiveObject = {};
    tail.next = child;
    tail = child;
  }
  b.replay.accept({ ...b.transcript.entries[0].event, extra: deep });
  expect(b.failures).toEqual(["invalid-client"]);
});

it("accepts a validated zero-byte PCM run", () => {
  const { transcript } = readLiveCase("client");
  for (const entry of transcript.entries) {
    if (entry.direction === "client" && entry.event.type === "session.input_audio.append")
      entry.event.audio = "";
    if (entry.barrier) entry.barrier.audioBytes = 0;
  }
  const fixture = validateLiveTranscript(transcript);
  const fail = vi.fn();
  const replay = createLiveReplay(fixture, {
    send: async () => {},
    fail,
    signal: new AbortController().signal,
    replaySpeed: 1,
    timing: "immediate",
    limits: normalizeLiveOptions(),
  });
  replay.accept(fixture.entries[0].event);
  replay.accept({ type: "session.input_audio.append", audio: "" });
  replay.accept({ type: "session.input_audio.append", audio: "" });
  expect(fail).not.toHaveBeenCalled();
  replay.close();
});

it.each(["same metadata", "distinct metadata", "multiple empty runs", "trailing empty"])(
  "replays empty PCM with %s through the public socket to completion",
  async (variant) => {
    vi.useRealTimers();
    const { transcript } = readLiveCase("client");
    const first = transcript.entries.findIndex(
      (entry) => entry.event.type === "session.input_audio.append",
    );
    const position =
      variant === "trailing empty"
        ? transcript.entries.findIndex(
            (entry, index) =>
              index > first &&
              entry.direction === "client" &&
              entry.event.type !== "session.input_audio.append",
          )
        : first;
    const empty = structuredClone(transcript.entries[first]);
    empty.event.audio = "";
    if (variant === "distinct metadata" || variant === "multiple empty runs")
      empty.event.tag = "first-empty-run";
    const inserted = [empty];
    if (variant === "multiple empty runs")
      inserted.push({
        ...structuredClone(empty),
        event: { ...empty.event, tag: "second-empty-run" },
      });
    transcript.entries.splice(position, 0, ...inserted);
    transcript.capture.terminalEntry += inserted.length;
    for (const binding of transcript.bindings)
      if (binding.entry >= position) binding.entry += inserted.length;
    transcript.entries.forEach((entry, index) => {
      entry.atMs = index;
    });
    const fixture = validateLiveTranscript(transcript);
    const mock = new LLMock();
    mock.on({ endpoint: "openai-live" }, { live: fixture, liveTiming: "immediate" });
    await mock.start();
    try {
      const ws = await connectWebSocket(mock.url, "/v1/live/sessions");
      try {
        const result = await runLiveScenario(ws, fixture, { clientIdPrefix: "empty-pcm" });
        expect(result.normalized).toEqual(normalizeCapturedScenario(fixture));
      } finally {
        ws.destroy();
      }
    } finally {
      await mock.stop();
    }
  },
);
