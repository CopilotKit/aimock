import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveRecorder } from "../live-recorder.js";
import { Logger } from "../logger.js";
import { validateLiveTranscript } from "../live-fixture.js";
import { readLiveCase } from "./live-test-support.js";
import type { LiveTranscript } from "../live-types.js";
import type { Fixture } from "../types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(extra: Partial<Parameters<typeof createLiveRecorder>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "live-recorder-"));
  dirs.push(dir);
  const fixtures: Fixture[] = [];
  const recorder = createLiveRecorder({
    record: { providers: {}, fixturePath: dir },
    fixtures,
    logger: new Logger(),
    ...extra,
  });
  return { dir, fixtures, recorder };
}
function feed(
  recorder: ReturnType<typeof createLiveRecorder>,
  transcript: LiveTranscript,
  count = transcript.entries.length,
) {
  for (const entry of transcript.entries.slice(0, count))
    recorder[entry.direction === "client" ? "acceptClient" : "acceptServer"](
      JSON.stringify(entry.event),
      entry.atMs,
    );
}
function exported(result: ReturnType<ReturnType<typeof createLiveRecorder>["finish"]>) {
  if (result.kind !== "written") throw new Error("expected persisted capture");
  const raw = JSON.parse(readFileSync(result.filepath, "utf8"));
  return validateLiveTranscript(raw.fixtures.at(-1).response.live);
}
describe("complete Live recording", () => {
  it.each(["client", "managed"] as const)(
    "annotates and atomically persists retained %s capture",
    (mode) => {
      const t = readLiveCase(mode).transcript;
      const original = structuredClone(t);
      const { recorder, dir, fixtures } = setup();
      feed(recorder, t);
      expect(readdirSync(dir)).toEqual([]);
      const result = recorder.finish();
      const saved = exported(result);
      expect(saved.entries.map((e) => e.barrier)).toEqual(t.entries.map((e) => e.barrier));
      expect(saved.bindings.length).toBe(t.bindings.length);
      expect(saved.bindings.filter((b) => b.origin === "imported-context").length).toBe(
        t.bindings.filter((b) => b.origin === "imported-context").length,
      );
      expect(saved.capture.source).toBe("provider");
      expect(fixtures).toHaveLength(1);
      expect(readdirSync(dir).every((f) => !f.includes(".tmp"))).toBe(true);
      expect(recorder.finish()).toEqual(result);
      expect(fixtures).toHaveLength(1);
      expect(t).toEqual(original);
    },
  );
  it("does not persist missing terminal, aborted or proxy-only sessions", () => {
    const t = readLiveCase("client").transcript;
    for (const action of ["incomplete", "abort", "proxyOnly"] as const) {
      const { recorder, dir, fixtures } = setup(
        action === "proxyOnly" ? { record: { providers: {}, proxyOnly: true } } : {},
      );
      feed(recorder, t, action === "incomplete" ? t.entries.length - 1 : t.entries.length);
      if (action === "abort") recorder.abort("upstream-connect");
      expect(recorder.finish().kind).toBe(action === "proxyOnly" ? "skipped" : "failed");
      expect(readdirSync(dir)).toEqual([]);
      expect(fixtures).toEqual([]);
    }
  });
  it("sanitizes metadata separately while preserving semantic secret rejection", () => {
    const t = readLiveCase("client").transcript;
    t.entries[1].event.metadata = { Authorization: "Bearer harmless-recorder-marker" };
    const { recorder } = setup({ secretValues: ["harmless-recorder-marker"] });
    feed(recorder, t);
    expect(JSON.stringify(exported(recorder.finish()))).not.toContain("harmless-recorder-marker");
    t.entries[1].event.future = "harmless-recorder-marker";
    const unsafe = setup({ secretValues: ["harmless-recorder-marker"] });
    feed(unsafe.recorder, t);
    expect(unsafe.recorder.finish()).toMatchObject({ kind: "failed", category: "unsafe-export" });
    expect(readdirSync(unsafe.dir)).toEqual([]);
  });
  it.each([false, true])("bounds bytes/frames in proxyOnly=%s", (proxyOnly) => {
    const t = readLiveCase("client").transcript;
    for (const limit of [{ maxProxyBufferBytes: 1 }, { maxProxyBufferFrames: 1 }]) {
      const { recorder, fixtures } = setup({ record: { providers: {}, proxyOnly, ...limit } });
      expect(() => feed(recorder, t)).toThrow("resource-limit");
      expect(recorder.finish()).toMatchObject({ kind: "failed", category: "resource-limit" });
      expect(fixtures).toEqual([]);
    }
  });
  it("rejects invalid limits before capture", () => {
    for (const n of [0, -1, NaN, Infinity, 1.5])
      expect(() => setup({ record: { providers: {}, maxProxyBufferFrames: n } })).toThrow(
        "resource-limit",
      );
  });
  it("rejects invalid client JSON, wrong reference, regressing time and post-terminal data", () => {
    const t = readLiveCase("client").transcript;
    const invalid = setup();
    expect(() => invalid.recorder.acceptClient('{"type":"unknown"}', 0)).toThrow("invalid-client");
    const timing = setup();
    timing.recorder.acceptClient(JSON.stringify(t.entries[0].event), 10);
    expect(() => timing.recorder.acceptServer(JSON.stringify(t.entries[1].event), 9)).toThrow(
      "protocol-divergence",
    );
    const wrong = setup();
    feed(wrong.recorder, t, 2);
    expect(() =>
      wrong.recorder.acceptClient(
        JSON.stringify({
          type: "session.thinking.append",
          delegation_id: "wrong",
          content: "hello",
        }),
        t.entries[1].atMs + 1,
      ),
    ).toThrow("protocol-divergence");
    const terminal = setup();
    feed(terminal.recorder, t);
    expect(() =>
      terminal.recorder.acceptServer('{"type":"future"}', t.entries.at(-1)!.atMs),
    ).toThrow("protocol-divergence");
    expect(terminal.recorder.finish().kind).toBe("failed");
  });
  it("rejects invalid PCM, directional audio and duration limits", () => {
    const t = readLiveCase("client").transcript;
    const { recorder } = setup({ live: { maxDecodedAudioBytes: 2 } });
    feed(recorder, t, 2);
    expect(() =>
      recorder.acceptClient(
        JSON.stringify({ type: "session.input_audio.append", audio: "AAAAAA==" }),
        t.entries[1].atMs + 1,
      ),
    ).toThrow("resource-limit");
    const malformed = setup();
    feed(malformed.recorder, t, 2);
    expect(() =>
      malformed.recorder.acceptServer(
        JSON.stringify({ type: "session.output_audio.delta", delta: "!bad" }),
        t.entries[1].atMs + 1,
      ),
    ).toThrow("protocol-divergence");
    const duration = setup({ live: { maxDurationMs: 1 } });
    expect(() => feed(duration.recorder, t)).toThrow("timeout");
  });
  it("does not persist provider errors or unsuccessful closure", () => {
    const t = readLiveCase("client").transcript;
    const error = setup();
    feed(error.recorder, t, 2);
    expect(() =>
      error.recorder.acceptServer(
        '{"type":"error","error":{"message":"private"}}',
        t.entries[1].atMs + 1,
      ),
    ).toThrow("protocol-divergence");
    expect(error.recorder.finish()).toMatchObject({
      kind: "failed",
      category: "protocol-divergence",
    });
    t.entries.at(-1)!.event.reason = "connection_lost";
    const failed = setup();
    expect(() => feed(failed.recorder, t)).toThrow("incomplete-capture");
    expect(readdirSync(failed.dir)).toEqual([]);
  });
  it("cleans temporary bytes after a real rename failure", () => {
    const { recorder, dir, fixtures } = setup({ testId: "capture" });
    mkdirSync(join(dir, "capture", "openai-live.json"), { recursive: true });
    feed(recorder, readLiveCase("client").transcript);
    expect(recorder.finish()).toMatchObject({ kind: "failed", category: "incomplete-capture" });
    expect(readdirSync(join(dir, "capture"))).toEqual(["openai-live.json"]);
    expect(fixtures).toEqual([]);
  });
  it("preserves unknown bounded events and forwards raised duration limits to sanitation", () => {
    const t = readLiveCase("client").transcript;
    for (const e of t.entries) e.atMs += 120001;
    t.entries.splice(2, 0, {
      direction: "server",
      atMs: t.entries[1].atMs,
      event: { type: "future.event", payload: { literal: true } },
    });
    const { recorder } = setup({ live: { maxDurationMs: 1000000 } });
    feed(recorder, t);
    const result = recorder.finish();
    if (result.kind !== "written") throw new Error("expected saved fixture");
    const raw = JSON.parse(readFileSync(result.filepath, "utf8"));
    expect(
      validateLiveTranscript(raw.fixtures[0].response.live, { maxDurationMs: 1000000 }).entries[2]
        .event,
    ).toEqual({ type: "future.event", payload: { literal: true } });
  });
  it("refuses malformed provider session snapshots before persistence", () => {
    const t = readLiveCase("client").transcript;
    const session = t.entries[1].event.session;
    if (!session || typeof session !== "object" || Array.isArray(session))
      throw new Error("missing session");
    delete session.status;
    const { recorder, dir } = setup();
    feed(recorder, t);
    expect(recorder.finish()).toMatchObject({ kind: "failed", category: "protocol-divergence" });
    expect(readdirSync(dir)).toEqual([]);
  });
  it("reports safe persistence failure without registering or leaving temp files", () => {
    const { recorder, dir, fixtures } = setup({ testId: "capture" });
    writeFileSync(join(dir, "capture"), "block directory");
    feed(recorder, readLiveCase("client").transcript);
    expect(recorder.finish()).toMatchObject({ kind: "failed", category: "incomplete-capture" });
    expect(fixtures).toEqual([]);
  });
});
