import { setTimeout as delay } from "node:timers/promises";
import type { WSTestClient } from "./ws-test-client.js";
import { readFileSync } from "node:fs";
import type { FixtureFileEntry } from "../types.js";
import type {
  LiveBinding,
  LiveFixtureResponse,
  LiveJson,
  LiveMode,
  LiveObject,
  LiveTranscript,
} from "../live-types.js";
import { normalizeLiveFixture } from "../live-fixture.js";

/**
 * Frozen reviewed provider assets (contract v3).
 * client.json is a projected trace, not an untouched successful conversation.
 * Source client.capture.json SHA256:
 * beffb4a834a441dacfbedbf473b28de419509db353cbfa3be54b9ef492ee12f7
 * Source -> fixture indices: 0..262 -> 0..262; 267 -> 263;
 * 270 -> 264; 273 -> 265. Removed source indices:
 * 263, 264, 265, 266, 268, 269, 271, 272 (late incomplete null injections,
 * immutable/unknown-command probes, and their four correlated errors).
 * Original errors at 266, 269, 271, 272 remain separate negative-test inputs
 * in the external frozen evidence; these success fixtures do not cover them.
 * managed.json preserves all 299 events, indices 0..298 unchanged, from
 * followup/attempt2.capture.json SHA256:
 * 9b1e20bf64de6198d790b2f40c994e12ef33a90e0f114bdcde71ef9382faf823
 * Only annotated identifiers were sanitized; timestamps and PCM are intact.
 * Server barriers reflect retained causal input. Full reviewed projection.json
 * SHA256: 4e38e2a674f666807a10bf7c2e9d473552f3bc27710a04a09b794dbede473391
 * contract.json retains the reviewed artifact's original status text; review
 * approval is recorded separately, not by rewriting the frozen contract.
 */
export function readLiveCase(mode: LiveMode): {
  fixture: FixtureFileEntry & { response: LiveFixtureResponse };
  transcript: LiveTranscript;
} {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`./fixtures/live/${mode}.json`, import.meta.url), "utf8"),
  );
  if (!Array.isArray(raw) || raw.length !== 1) throw new Error("expected one fixture");
  const entry: unknown = raw[0];
  if (entry === null || typeof entry !== "object" || !("response" in entry))
    throw new Error("missing response");
  const response = normalizeLiveFixture(entry.response);
  const fixture: FixtureFileEntry & { response: LiveFixtureResponse } = {
    match: { endpoint: "openai-live", model: response.live.model },
    response,
  };
  return { fixture, transcript: response.live };
}

export interface LiveScenarioOptions {
  timeoutMs?: number;
  bindingTimeoutMs?: number;
  clientIdPrefix: string;
  fault?: { entry: number; pointer: string; value: string };
}
export interface LiveScenarioResult {
  server: LiveObject[];
  client: LiveObject[];
  bindings: Map<string, string>;
  normalized: LiveObject[];
}

export class LiveScenarioWireError extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}
function isBoundedJson(value: unknown, depth = 0): value is LiveJson {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isBoundedJson(v, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).every(
    ([key, v]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && isBoundedJson(v, depth + 1),
  );
}
function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/")) throw new Error("identifier pointer must select a field");
  const parts = pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.some((p) => ["__proto__", "prototype", "constructor"].includes(p)))
    throw new Error("unsafe pointer");
  return parts;
}
function child(value: LiveJson, key: string): LiveJson {
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
    throw new Error(`missing identifier field ${key}`);
  if (Array.isArray(value)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error("invalid array pointer");
    return value[Number(key)];
  }
  return value[key];
}
export function identifier(event: LiveObject, pointer: string): string {
  let value: LiveJson = event;
  for (const key of pointerParts(pointer)) value = child(value, key);
  if (typeof value !== "string") throw new Error("annotated identifier is not a string");
  return value;
}
export function replaceIdentifier(event: LiveObject, pointer: string, replacement: string): void {
  const parts = pointerParts(pointer);
  const last = parts.pop();
  if (last === undefined) throw new Error("empty identifier pointer");
  let parent: LiveJson = event;
  for (const key of parts) parent = child(parent, key);
  child(parent, last);
  if (parent === null || typeof parent !== "object") throw new Error("invalid identifier parent");
  if (Array.isArray(parent)) parent[Number(last)] = replacement;
  else parent[last] = replacement;
}
function bindValue(bindings: Map<string, string>, binding: LiveBinding, value: string): void {
  const known = bindings.get(binding.name);
  if (binding.action === "reference") {
    if (known === undefined || known !== value)
      throw new Error(`reference mismatch ${binding.name}`);
    return;
  }
  if (known !== undefined && known !== value) throw new Error(`definition changed ${binding.name}`);
  const namespace = binding.name.split(":")[0];
  for (const [name, existing] of bindings) {
    if (name !== binding.name && name.split(":")[0] === namespace && existing === value)
      throw new Error("non-bijective identifiers");
  }
  bindings.set(binding.name, value);
}
export function serverEvents(t: LiveTranscript): LiveObject[] {
  return t.entries.filter((e) => e.direction === "server").map((e) => e.event);
}
export function normalizeScenario(
  t: LiveTranscript,
  client: LiveObject[],
  server: LiveObject[],
): LiveObject[] {
  const maps = new Map<string, string>();
  let c = 0,
    s = 0;
  const normalized = t.entries.map((entry, index) => {
    const actual = entry.direction === "client" ? client[c++] : server[s++];
    if (!actual) throw new Error(`missing ${entry.direction} entry ${index}`);
    const copy = structuredClone(actual);
    for (const b of t.bindings.filter((b) => b.entry === index)) {
      bindValue(maps, b, identifier(copy, b.pointer));
      replaceIdentifier(copy, b.pointer, `binding:${b.name}`);
    }
    return copy;
  });
  if (c !== client.length || s !== server.length) throw new Error("unexpected extra events");
  return normalized;
}
export function normalizeCapturedScenario(t: LiveTranscript): LiveObject[] {
  return normalizeScenario(
    t,
    t.entries.filter((e) => e.direction === "client").map((e) => e.event),
    serverEvents(t),
  );
}
export async function runLiveScenario(
  ws: WSTestClient,
  t: LiveTranscript,
  options: LiveScenarioOptions,
): Promise<
  LiveScenarioResult & {
    observations: {
      entry: number;
      atMs: number;
      sentPosition: { command: number; audioBytes: number };
    }[];
  }
> {
  const start = performance.now();
  const deadline = start + (options.timeoutMs ?? 50000);
  const controller = new AbortController();
  const bindings = new Map<string, string>();
  const client: LiveObject[] = [],
    server: LiveObject[] = [];
  const serverIndices = t.entries.flatMap((e, i) => (e.direction === "server" ? [i] : []));
  let wireBytes = 0;
  let sentPosition = { command: 0, audioBytes: 0 };
  const observations: {
    entry: number;
    atMs: number;
    sentPosition: { command: number; audioBytes: number };
  }[] = [];
  let socketClosed = false;
  void ws.waitForClose().then(() => {
    socketClosed = true;
  });
  function checkDeadline() {
    if (performance.now() > deadline) throw new Error("scenario deadline exceeded");
  }
  async function tick() {
    checkDeadline();
    await delay(1, undefined, { signal: controller.signal });
  }
  function drainReceived() {
    const messages = ws.getMessages();
    if (messages.length > serverIndices.length) throw new Error("unexpected server events");
    while (server.length < messages.length) {
      const text = messages[server.length];
      wireBytes += Buffer.byteLength(text);
      if (wireBytes > 64 * 1024 * 1024) throw new Error("scenario data cap exceeded");
      const event: unknown = JSON.parse(text);
      if (
        !isBoundedJson(event) ||
        event === null ||
        typeof event !== "object" ||
        Array.isArray(event)
      )
        throw new Error("expected bounded server object");
      const observed = event;
      if (observed.type === "aimock.error") {
        const error = observed.error;
        if (
          error !== null &&
          typeof error === "object" &&
          !Array.isArray(error) &&
          typeof error.category === "string"
        )
          throw new LiveScenarioWireError(error.category);
        throw new Error("malformed aimock error");
      }
      const index = serverIndices[server.length];
      const barrier = t.entries[index].barrier;
      if (
        !barrier ||
        sentPosition.command < barrier.command ||
        (sentPosition.command === barrier.command && sentPosition.audioBytes < barrier.audioBytes)
      ) {
        throw new Error(`server barrier unsatisfied ${index}`);
      }
      observations.push({
        entry: index,
        atMs: performance.now() - start,
        sentPosition: { ...sentPosition },
      });
      if (observed.type !== t.entries[index].event.type)
        throw new Error(`server event divergence ${index}`);
      for (const b of t.bindings.filter((b) => b.entry === index)) {
        if (b.action === "define" && b.owner !== "server")
          throw new Error("server defines client-owned ID");
        bindValue(bindings, b, identifier(observed, b.pointer));
      }
      server.push(observed);
    }
  }
  const receiving = (async () => {
    let completeSince: number | undefined;
    while (true) {
      drainReceived();
      if (socketClosed) {
        if (server.length !== serverIndices.length)
          throw new Error("socket closed before expected server events");
        break;
      }
      if (server.length === serverIndices.length) {
        completeSince ??= performance.now();
        if (performance.now() - completeSince > 1000)
          throw new Error("server close deadline exceeded");
      }
      await tick();
    }
  })();
  const sending = (async () => {
    for (const [index, entry] of t.entries.entries()) {
      if (entry.direction !== "client") continue;
      while (performance.now() < start + entry.atMs) await tick();
      const event = structuredClone(entry.event);
      const annotations = t.bindings.filter((b) => b.entry === index);
      for (const b of annotations.filter((b) => b.action === "define")) {
        if (b.owner !== "client") throw new Error("client defines server-owned ID");
        const value = `${options.clientIdPrefix}-${b.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        replaceIdentifier(event, b.pointer, value);
        bindValue(bindings, b, value);
      }
      const waitingSince = performance.now();
      while (annotations.some((b) => b.action === "reference" && !bindings.has(b.name))) {
        if (performance.now() - waitingSince > (options.bindingTimeoutMs ?? 5000))
          throw new Error(`missing definition for client entry ${index}`);
        await tick();
      }
      for (const b of annotations) {
        if (b.action === "define") {
          if (b.owner !== "client") throw new Error("client defines server-owned ID");
          const value = `${options.clientIdPrefix}-${b.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
          replaceIdentifier(event, b.pointer, value);
          bindValue(bindings, b, value);
        } else {
          const value = bindings.get(b.name);
          if (value === undefined) throw new Error("missing bound reference");
          replaceIdentifier(event, b.pointer, value);
        }
      }
      if (options.fault?.entry === index)
        replaceIdentifier(event, options.fault.pointer, options.fault.value);
      const text = JSON.stringify(event);
      wireBytes += Buffer.byteLength(text);
      if (wireBytes > 64 * 1024 * 1024) throw new Error("scenario data cap exceeded");
      drainReceived();
      ws.send(text);
      client.push(event);
      if (event.type === "session.input_audio.append") {
        if (typeof event.audio !== "string") throw new Error("invalid client audio");
        sentPosition.audioBytes += Buffer.from(event.audio, "base64").length;
      } else sentPosition = { command: sentPosition.command + 1, audioBytes: 0 };
    }
  })();
  try {
    await Promise.all([receiving, sending]);
    return {
      server,
      client,
      bindings,
      observations,
      normalized: normalizeScenario(t, client, server),
    };
  } finally {
    controller.abort();
    await Promise.allSettled([receiving, sending]);
    ws.close();
  }
}
