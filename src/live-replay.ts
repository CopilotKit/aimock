import { randomUUID } from "node:crypto";
import type {
  LiveBinding,
  LiveFailureCategory,
  LiveJson,
  LiveObject,
  LiveOptions,
  LiveTranscript,
} from "./live-types.js";

export interface LiveReplayOptions {
  send: (event: LiveObject) => Promise<void>;
  fail: (category: LiveFailureCategory, detail: string) => void;
  signal: AbortSignal;
  replaySpeed: number;
  timing: "recorded" | "immediate";
  limits: Required<LiveOptions>;
}
// Inspect descriptors before serialization: in-process callers must not smuggle
// getters, cycles, prototypes, or unbounded nesting into the receive path.
function boundedJson(root: LiveObject, limit: number): boolean {
  let budget = limit;
  function visit(value: LiveJson, depth: number): boolean {
    if (depth > 32 || --budget < 0) return false;
    if (typeof value === "string") {
      budget -= Buffer.byteLength(value);
      return budget >= 0;
    }
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    for (const key of Object.keys(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) return false;
      budget -= Buffer.byteLength(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !visit(descriptor.value, depth + 1))
        return false;
    }
    return budget >= 0;
  }
  return visit(root, 0);
}
function canonical(value: LiveJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function field(
  event: LiveObject,
  pointer: string,
): { parent: LiveObject | LiveJson[]; key: string } {
  const parts = pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  const key = parts.pop()!;
  let parent: LiveJson = event;
  for (const part of parts) {
    if (parent === null || typeof parent !== "object") throw new Error("missing identifier");
    parent = Array.isArray(parent) ? parent[Number(part)] : parent[part];
  }
  if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, key))
    throw new Error("missing identifier");
  return { parent, key };
}
function read(event: LiveObject, pointer: string): LiveJson {
  const { parent, key } = field(event, pointer);
  return Array.isArray(parent) ? parent[Number(key)] : parent[key];
}
function replace(event: LiveObject, pointer: string, value: string): void {
  const { parent, key } = field(event, pointer);
  if (Array.isArray(parent)) parent[Number(key)] = value;
  else parent[key] = value;
}
// Namespace comes from the reviewed operand, never the author's arbitrary binding name.
function namespace(binding: LiveBinding): string {
  const p = binding.pointer;
  if (p.endsWith("client_event_id")) return "client-event";
  if (p === "/event_id") return `${binding.owner}-event`;
  if (p === "/session/id") return "session";
  if (p === "/delegation/id" || p === "/delegation_id") return "delegation";
  if (p.endsWith("/call_id")) return "tool-call";
  if (p === "/event/item/id" || p === "/event/item_id") return "response-item";
  return "response";
}
function decode(value: LiveJson, remaining: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("invalid audio");
  const size = (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (size % 2 || size > remaining) throw new Error("invalid audio size");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("invalid audio encoding");
  return bytes;
}
interface Control {
  kind: "control";
  index: number;
}
interface Audio {
  kind: "audio";
  bytes: Buffer;
  metadata: LiveObject;
}

/** Accepts synchronously; the single output pump alone waits for transport pressure.
 * The caller supplies a validated, immutable transcript and owns cancellation of send(). */
export function createLiveReplay(
  transcript: LiveTranscript,
  options: LiveReplayOptions,
): { accept(event: LiveObject): void; close(): void } {
  if (!Number.isFinite(options.replaySpeed) || options.replaySpeed <= 0)
    throw new Error("replaySpeed must be positive");
  const { limits } = options;
  const annotations = new Map<number, LiveBinding[]>();
  for (const binding of transcript.bindings) {
    const bucket = annotations.get(binding.entry) ?? [];
    bucket.push(binding);
    annotations.set(binding.entry, bucket);
  }
  for (const bucket of annotations.values())
    bucket.sort((a, b) => Number(a.action === "reference") - Number(b.action === "reference"));
  const tape: (Control | Audio)[] = [];
  const servers: number[] = [];
  const audioChunks = new Map<Audio, Buffer[]>();
  let fixtureBytes = 0;
  for (const [index, entry] of transcript.entries.entries()) {
    if (entry.direction === "server") {
      servers.push(index);
      continue;
    }
    if (entry.event.type !== "session.input_audio.append") {
      tape.push({ kind: "control", index });
      continue;
    }
    const bytes = decode(entry.event.audio, limits.maxDecodedAudioBytes - fixtureBytes);
    fixtureBytes += bytes.length;
    const metadata = { ...entry.event };
    delete metadata.audio;
    const previous = tape.at(-1);
    // Annotated audio commands retain their original frame boundary. Plain PCM runs
    // coalesce across intervening server output, never across a client control.
    if (annotations.has(index)) {
      tape.push({ kind: "control", index });
      continue;
    }
    if (previous?.kind === "audio" && canonical(previous.metadata) === canonical(metadata))
      audioChunks.get(previous)!.push(bytes);
    else {
      const run: Audio = { kind: "audio", bytes, metadata };
      tape.push(run);
      audioChunks.set(run, [bytes]);
    }
  }
  for (const [run, chunks] of audioChunks) run.bytes = Buffer.concat(chunks);
  audioChunks.clear();
  const values = new Map<string, string>();
  const reverse = new Map<string, string>();
  let cursor = 0,
    offset = 0,
    command = 0,
    audioBytes = 0,
    totalAudio = 0,
    next = 0;
  let stopped = false,
    sending = false,
    start: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const created = Date.now();
  let lastActivity = created,
    missingSince = created;
  function close() {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    options.signal.removeEventListener("abort", close);
  }
  function fail(category: LiveFailureCategory, detail: string) {
    if (!stopped) {
      close();
      options.fail(category, detail);
    }
  }
  function bind(binding: LiveBinding, value: string) {
    const existing = values.get(binding.name);
    if (binding.action === "reference") {
      if (existing !== value) throw new Error("identifier reference mismatch");
    } else {
      const key = JSON.stringify([namespace(binding), value]);
      if (existing !== undefined || reverse.has(key))
        throw new Error("identifier bijection mismatch");
      values.set(binding.name, value);
      reverse.set(key, binding.name);
    }
  }
  function eligible() {
    const barrier = transcript.entries[servers[next]]?.barrier;
    return (
      barrier !== undefined &&
      (command > barrier.command ||
        (command === barrier.command && audioBytes >= barrier.audioBytes))
    );
  }
  function due() {
    return options.timing === "immediate"
      ? 0
      : transcript.entries[servers[next]].atMs / options.replaySpeed;
  }
  function schedule() {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    const now = Date.now();
    const deadlines = [
      (start ?? created) + limits.maxDurationMs,
      lastActivity + limits.idleTimeoutMs,
    ];
    if (cursor < tape.length && (next >= servers.length || !eligible()))
      deadlines.push(missingSince + limits.mismatchTimeoutMs);
    if (!sending && start !== undefined && next < servers.length && eligible())
      deadlines.push(start + due());
    timer = setTimeout(tick, Math.max(0, Math.min(2_147_483_647, Math.min(...deadlines) - now)));
  }
  function tick() {
    timer = undefined;
    if (stopped) return;
    const now = Date.now();
    if (
      now >= (start ?? created) + limits.maxDurationMs ||
      now >= lastActivity + limits.idleTimeoutMs
    ) {
      fail("timeout", "live replay deadline exceeded");
      return;
    }
    if (
      cursor < tape.length &&
      (next >= servers.length || !eligible()) &&
      now >= missingSince + limits.mismatchTimeoutMs
    ) {
      fail("fixture-mismatch", "expected client input deadline exceeded");
      return;
    }
    if (
      !sending &&
      start !== undefined &&
      next < servers.length &&
      eligible() &&
      now >= start + due()
    )
      void pump();
    schedule();
  }
  async function pump() {
    sending = true;
    try {
      while (
        !stopped &&
        start !== undefined &&
        next < servers.length &&
        eligible() &&
        Date.now() >= start + due()
      ) {
        const index = servers[next];
        const event = structuredClone(transcript.entries[index].event);
        for (const binding of annotations.get(index) ?? []) {
          if (binding.action === "define") bind(binding, `aimock-${randomUUID()}`);
          const value = values.get(binding.name);
          if (value === undefined) throw new Error("unavailable identifier");
          replace(event, binding.pointer, value);
        }
        if (Buffer.byteLength(JSON.stringify(event)) > limits.maxWriteBytes) {
          fail("resource-limit", "live output exceeds write limit");
          break;
        }
        await options.send(event);
        if (stopped) break;
        next++;
        lastActivity = Date.now();
        missingSince = Date.now();
        if (next === servers.length) close();
      }
    } catch {
      fail("protocol-divergence", "live output failed");
    } finally {
      sending = false;
      schedule();
    }
  }
  function accept(event: LiveObject): void {
    if (stopped) return;
    try {
      if (!boundedJson(event, limits.maxMessageBytes)) {
        fail("invalid-client", "live input must be bounded JSON");
        return;
      }
      if (Buffer.byteLength(JSON.stringify(event)) > limits.maxMessageBytes) {
        fail("resource-limit", "live input exceeds message limit");
        return;
      }
      let expected = tape[cursor];
      const metadata = { ...event };
      delete metadata.audio;
      // Empty frames do not advance PCM position, even at the end of a run.
      // Move past exhausted runs when the next input changes metadata or supplies
      // more bytes/a control, without crossing an unfinished run or control.
      while (
        expected?.kind === "audio" &&
        offset === expected.bytes.length &&
        !(event.audio === "" && canonical(metadata) === canonical(expected.metadata))
      ) {
        expected = tape[++cursor];
        offset = 0;
      }
      if (!expected) throw new Error("unexpected client input");
      if (expected.kind === "audio") {
        const bytes = decode(
          event.audio,
          Math.min(limits.maxDecodedAudioBytes - totalAudio, expected.bytes.length - offset),
        );
        if (
          canonical(metadata) !== canonical(expected.metadata) ||
          !bytes.equals(expected.bytes.subarray(offset, offset + bytes.length))
        )
          throw new Error("audio mismatch");
        offset += bytes.length;
        audioBytes += bytes.length;
        totalAudio += bytes.length;
      } else {
        const template = structuredClone(transcript.entries[expected.index].event);
        for (const binding of annotations.get(expected.index) ?? []) {
          const value = read(event, binding.pointer);
          if (typeof value !== "string" || !value.length) throw new Error("missing identifier");
          bind(binding, value);
          replace(template, binding.pointer, value);
        }
        if (canonical(template) !== canonical(event)) throw new Error("command mismatch");
        if (event.type === "session.input_audio.append") {
          const bytes = decode(event.audio, limits.maxDecodedAudioBytes - totalAudio);
          audioBytes += bytes.length;
          totalAudio += bytes.length;
        } else {
          command++;
          audioBytes = 0;
        }
        cursor++;
      }
      start ??= Date.now();
      lastActivity = Date.now();
      missingSince = Date.now();
      schedule();
    } catch {
      fail("fixture-mismatch", "client input does not match live fixture");
    }
  }
  options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) close();
  else schedule();
  return { accept, close };
}
