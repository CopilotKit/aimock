import { performance } from "node:perf_hooks";
import {
  bindingSites,
  normalizeLiveOptions,
  validateLiveClientEvent,
  validateLiveTranscript,
} from "./live-fixture.js";
import { sanitizeLiveTranscript, type LiveCredentialField } from "./live-sanitize.js";
import type {
  LiveBinding,
  LiveEntry,
  LiveFailureCategory,
  LiveJson,
  LiveObject,
  LiveOptions,
  LiveTranscript,
} from "./live-types.js";
import type { Fixture, RecordConfig } from "./types.js";
import { Logger } from "./logger.js";
import { DEFAULT_TEST_ID } from "./constants.js";
import {
  DEFAULT_MAX_PROXY_BUFFER_BYTES,
  DEFAULT_MAX_PROXY_BUFFER_FRAMES,
  PROXY_BUFFER_HARD_CEILING,
  persistFixture,
  type PersistFixtureResult,
} from "./recorder.js";

export interface LiveRecorderOptions {
  record: RecordConfig;
  fixtures: Fixture[];
  logger: Logger;
  testId?: string;
  live?: LiveOptions;
  /** Include the actual selected upstream credential as well as configured Live secrets. */
  secretValues?: readonly string[];
  credentialFields?: readonly LiveCredentialField[];
  provenance?: NonNullable<LiveTranscript["capture"]["provenance"]>;
}
export type LiveRecorderResult =
  | Exclude<PersistFixtureResult, { kind: "failed" }>
  | {
      kind: "failed";
      category: LiveFailureCategory;
      error: string;
    };
export class LiveRecorderError extends Error {
  constructor(readonly category: LiveFailureCategory) {
    super(`Live capture failed: ${category}`);
  }
}
function object(value: LiveJson | undefined): value is LiveObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boundedJson(value: unknown, depth = 0): value is LiveJson {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => boundedJson(v, depth + 1));
  return (
    typeof value === "object" &&
    Object.entries(value).every(
      ([key, v]) =>
        !["__proto__", "prototype", "constructor"].includes(key) && boundedJson(v, depth + 1),
    )
  );
}
function field(event: LiveObject, pointer: string): string {
  let value: LiveJson = event;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!object(value)) throw new LiveRecorderError("protocol-divergence");
    value = value[key];
  }
  if (typeof value !== "string") throw new LiveRecorderError("protocol-divergence");
  return value;
}
function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new LiveRecorderError("resource-limit");
  return result;
}

/** Capture at arrival/acceptance, before awaiting any downstream socket write.
 * Inputs are complete wire JSON strings, so byte caps apply before parse/copy.
 * The socket owner owns deadlines, mode/lifecycle forwarding checks and cleanup;
 * abort on any failed send or premature socket close before calling finish.
 */
export function createLiveRecorder(options: LiveRecorderOptions) {
  const limits = normalizeLiveOptions(options.live);
  const maxBytes = Math.min(
    limit(options.record.maxProxyBufferBytes, DEFAULT_MAX_PROXY_BUFFER_BYTES),
    PROXY_BUFFER_HARD_CEILING,
  );
  const maxFrames = limit(options.record.maxProxyBufferFrames, DEFAULT_MAX_PROXY_BUFFER_FRAMES);
  const started = performance.now();
  const entries: LiveEntry[] = [];
  const bindings: LiveBinding[] = [];
  const identities = new Map<string, { name: string; owner: "client" | "server" }>();
  let configuration: LiveObject | undefined;
  let bytes = 0,
    frames = 0,
    lastTime = 0,
    command = 0,
    audioBytes = 0;
  const audioTotals = { client: 0, server: 0 };
  let terminal = false;
  let failure: LiveFailureCategory | undefined;
  let result: LiveRecorderResult | undefined;
  function clear() {
    entries.length = 0;
    bindings.length = 0;
    identities.clear();
    configuration = undefined;
  }
  function abort(category: LiveFailureCategory = "incomplete-capture") {
    if (result) return;
    failure ??= category;
    clear();
  }
  function fail(category: LiveFailureCategory): never {
    abort(category);
    throw new LiveRecorderError(failure ?? category);
  }
  function annotate(event: LiveObject, direction: "client" | "server") {
    const sites = [...bindingSites(event, direction)].sort(
      (a, b) =>
        Number(!a[1].define) - Number(!b[1].define) ||
        Number(!a[1].imported) - Number(!b[1].imported),
    );
    for (const [pointer, site] of sites) {
      const value = field(event, pointer);
      const key = JSON.stringify([site.namespace, value]);
      const known = identities.get(key);
      if (known && known.owner !== site.owner) fail("protocol-divergence");
      if (!known && !site.define && !site.imported) fail("protocol-divergence");
      const name = known?.name ?? `${site.namespace}:${identities.size}`;
      if (!known) identities.set(key, { name, owner: site.owner });
      if (!options.record.proxyOnly)
        bindings.push({
          entry: entries.length,
          pointer,
          name,
          owner: site.owner,
          action: known ? "reference" : "define",
          ...(!known && !site.define && site.imported
            ? { origin: "imported-context" as const }
            : {}),
        });
    }
  }
  function accept(
    direction: "client" | "server",
    raw: string,
    atMs = Math.floor(performance.now() - started),
  ) {
    if (result) throw new LiveRecorderError("incomplete-capture");
    if (failure) throw new LiveRecorderError(failure);
    if (terminal) fail("protocol-divergence");
    if (!Number.isSafeInteger(atMs) || atMs < lastTime) fail("protocol-divergence");
    if (atMs > limits.maxDurationMs) fail("timeout");
    const length = Buffer.byteLength(raw);
    if (length > limits.maxMessageBytes || length > maxBytes - bytes || frames >= maxFrames)
      fail("resource-limit");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      fail(direction === "client" ? "invalid-client" : "protocol-divergence");
    }
    if (!boundedJson(value) || !object(value) || typeof value.type !== "string")
      fail(direction === "client" ? "invalid-client" : "protocol-divergence");
    const event = value;
    if (frames === 0 && (direction !== "client" || event.type !== "session.start"))
      fail("invalid-client");
    if (event.type === "session.start") {
      if (frames !== 0 || direction !== "client" || !object(event.session)) fail("invalid-client");
      configuration = event.session;
    }
    if (event.type === "error") fail("protocol-divergence");
    if (event.type === "session.closed") {
      if (
        direction !== "server" ||
        !["close_requested", "remote_hangup"].includes(String(event.reason))
      )
        fail("incomplete-capture");
      terminal = true;
    }
    let decoded = 0;
    if (
      (direction === "client" && event.type === "session.input_audio.append") ||
      (direction === "server" && event.type === "session.output_audio.delta")
    ) {
      const pcm = event[direction === "client" ? "audio" : "delta"];
      if (
        typeof pcm !== "string" ||
        pcm.length % 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pcm)
      )
        fail(direction === "client" ? "invalid-client" : "protocol-divergence");
      decoded = (pcm.length / 4) * 3 - (pcm.endsWith("==") ? 2 : pcm.endsWith("=") ? 1 : 0);
      if (decoded % 2) fail(direction === "client" ? "invalid-client" : "protocol-divergence");
      if (decoded > limits.maxDecodedAudioBytes - audioTotals[direction]) fail("resource-limit");
      if (Buffer.from(pcm, "base64").toString("base64") !== pcm) fail("protocol-divergence");
      audioTotals[direction] += decoded;
    }
    if (direction === "client") {
      try {
        validateLiveClientEvent(event, limits);
      } catch {
        fail("invalid-client");
      }
    }
    if (direction === "client") {
      if (event.type === "session.input_audio.append") audioBytes += decoded;
      else {
        command++;
        audioBytes = 0;
      }
    }
    bytes += length;
    frames++;
    lastTime = atMs;
    try {
      annotate(event, direction);
    } catch {
      fail("protocol-divergence");
    }
    if (!options.record.proxyOnly) {
      entries.push({
        direction,
        atMs,
        event,
        ...(direction === "server" ? { barrier: { command, audioBytes } } : {}),
      });
    }
  }
  function finish(): LiveRecorderResult {
    if (result) return result;
    if (!terminal && !failure) abort("incomplete-capture");
    if (failure)
      return (result = {
        kind: "failed",
        category: failure,
        error: `Live capture failed: ${failure}`,
      });
    if (options.record.proxyOnly) {
      clear();
      return (result = { kind: "skipped" });
    }
    if (!configuration || !object(configuration.delegation)) {
      abort();
      return finish();
    }
    const mode = configuration.delegation.type === "client" ? "client" : "managed";
    let transcript: LiveTranscript;
    try {
      transcript = validateLiveTranscript(
        {
          version: 1,
          model: "gpt-live-1",
          mode,
          audio: { encoding: "pcm16le", sampleRateHz: 24000, channels: 1 },
          configuration,
          entries,
          bindings,
          capture: {
            source: "provider",
            complete: true,
            terminalEntry: entries.length - 1,
            ...(options.provenance ? { provenance: options.provenance } : {}),
          },
        },
        limits,
      );
    } catch {
      abort("protocol-divergence");
      return finish();
    }
    try {
      transcript = sanitizeLiveTranscript(
        transcript,
        [...limits.secretValues, ...(options.secretValues ?? [])],
        options.credentialFields,
        limits,
      );
    } catch {
      abort("unsafe-export");
      return finish();
    }
    const fixture: Fixture = {
      match: { endpoint: "openai-live", model: "gpt-live-1" },
      response: { live: transcript },
    };
    // Existing persistence diagnostics include configured paths. Do not expose those
    // through Live's safe journal/error surface; report only a category here.
    const persisted = persistFixture({
      record: options.record,
      providerKey: "openai",
      filePrefix: "openai-live",
      testId: options.testId ?? DEFAULT_TEST_ID,
      fixture,
      fixtures: options.fixtures,
      logger: new Logger("silent"),
    });
    clear();
    if (persisted.kind === "failed") {
      options.logger.warn("Live capture persistence failed");
      return (result = {
        kind: "failed",
        category: "incomplete-capture",
        error: "Live capture persistence failed",
      });
    }
    options.logger.info("Complete Live capture recorded");
    return (result = persisted);
  }
  return {
    acceptClient: (raw: string, atMs?: number) => accept("client", raw, atMs),
    acceptServer: (raw: string, atMs?: number) => accept("server", raw, atMs),
    finish,
    abort,
  };
}
