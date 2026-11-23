import { performance } from "node:perf_hooks";
import type { IncomingHttpHeaders } from "node:http";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import {
  flattenHeaders,
  isLiveResponse,
  resolveResponse,
  strictNoMatchLogLine,
  strictNoMatchMessage,
  wouldProxyMiss,
} from "./helpers.js";
import { normalizeLiveFixture, validateLiveClientEvent } from "./live-fixture.js";
import { createLiveRecorder, LiveRecorderError } from "./live-recorder.js";
import { applyProviderAuth } from "./provider-auth.js";
import { connectUpstreamWebSocket } from "./ws-upstream.js";
import { resolveUpstreamUrl } from "./url.js";
import {
  clampTimeout,
  DEFAULT_MAX_PROXY_BUFFER_BYTES,
  DEFAULT_MAX_PROXY_BUFFER_FRAMES,
} from "./recorder.js";
import { createLiveReplay } from "./live-replay.js";
import type {
  LiveFailureCategory,
  LiveJson,
  LiveMode,
  LiveObject,
  LiveOptions,
} from "./live-types.js";
import type { Journal } from "./journal.js";
import { matchFixtureDiagnostic } from "./router.js";
import type {
  ChatCompletionRequest,
  Fixture,
  FixtureResponse,
  HandlerDefaults,
  JournalEntry,
} from "./types.js";
import type { WebSocketConnection } from "./ws-framing.js";

export interface LiveSessionOptions {
  defaults: HandlerDefaults;
  limits: Required<LiveOptions>;
  testId: string;
  headers: IncomingHttpHeaders;
  localApiKeys?: readonly string[];
  onDispose: () => void;
}
function object(value: LiveJson | undefined): LiveObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Node otherwise turns an overflowing delay into a one-millisecond timeout. */
function scheduleLiveTimeout(callback: () => void, timeoutMs: number): () => void {
  const started = performance.now();
  const onTimeout = () => {
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining > 0) timer = setTimeout(onTimeout, Math.min(remaining, 2_147_483_647));
    else callback();
  };
  let timer = setTimeout(onTimeout, Math.min(timeoutMs, 2_147_483_647));
  return () => clearTimeout(timer);
}

/** Diagnostic copies never retain executable members or mutate replay operands. */
function liveJournalSnapshot(
  entry: Omit<JournalEntry, "id" | "timestamp">,
  secretValues: readonly string[],
): Omit<JournalEntry, "id" | "timestamp"> {
  const secrets = secretValues.filter((secret) => secret.length > 0);
  if (!secrets.length) return entry;
  const containsSecret = (value: string) => secrets.some((secret) => value.includes(secret));
  // Whole-field redaction avoids creating another secret by joining substrings.
  const marker = containsSecret("[REDACTED]") ? "" : "[REDACTED]";
  const redact = (value: string) => (containsSecret(value) ? marker : value);
  const ancestors = new Set<object>();
  const copy = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (value === null || typeof value !== "object") return value;
    if (ancestors.has(value)) return undefined;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map(copy);
      // Diagnostics contain data only; omit getters and non-JSON objects.
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        return undefined;
      return Object.fromEntries(
        Object.entries(Object.getOwnPropertyDescriptors(value))
          .filter(([, descriptor]) => descriptor.enumerable && "value" in descriptor)
          .map(([key, descriptor]) => [redact(key), copy(descriptor.value)]),
      );
    } finally {
      ancestors.delete(value);
    }
  };
  // Preserve the journal schema; copied operands are diagnostics, never replay inputs.
  return {
    ...entry,
    headers: copy(entry.headers) as JournalEntry["headers"],
    body: copy(entry.body) as JournalEntry["body"],
    response: { ...entry.response, fixture: copy(entry.response.fixture) as Fixture | null },
  };
}

/** Owns a single transport, replay cursor and every cancellation deadline. */
export function handleLiveSession(
  ws: WebSocketConnection,
  fixtures: Fixture[],
  journal: Journal,
  options: LiveSessionOptions,
): () => void {
  const { defaults, limits, testId } = options;
  // HTTP accepts positive finite milliseconds; the connector requires whole safe milliseconds.
  const normalizeRecordTimeout = (value: number | undefined) =>
    Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(clampTimeout(value, 30_000)));
  const upstreamTimeoutMs = normalizeRecordTimeout(defaults.record?.upstreamTimeoutMs);
  const bodyTimeoutMs = normalizeRecordTimeout(defaults.record?.bodyTimeoutMs);
  const controller = new AbortController();
  let state: "awaiting-start" | "active" | "closing" | "closed" = "awaiting-start";
  let mode: LiveMode | undefined;
  let starting = false;
  const pending: LiveObject[] = [];
  let pendingBytes = 0;
  const maxPendingBytes = Math.min(
    limits.maxBufferedBytes,
    defaults.record?.maxProxyBufferBytes ?? DEFAULT_MAX_PROXY_BUFFER_BYTES,
  );
  const maxPendingFrames = defaults.record?.maxProxyBufferFrames ?? DEFAULT_MAX_PROXY_BUFFER_FRAMES;
  let upstream: WebSocketConnection | undefined;
  let recorder: ReturnType<typeof createLiveRecorder> | undefined;
  let recordingSecrets: string[] = [];
  let terminalReceived = false;
  let captureStarted: number | undefined;
  let recordingJournaled = false;
  let upstreamIdle: (() => void) | undefined;
  let replay: ReturnType<typeof createLiveReplay> | undefined;
  const deadline = scheduleLiveTimeout(
    () => fail("timeout", "Live session duration exceeded"),
    limits.maxDurationMs,
  );
  const startup = scheduleLiveTimeout(
    () => fail("timeout", "Live startup deadline exceeded"),
    defaults.record ? upstreamTimeoutMs : limits.idleTimeoutMs,
  );

  function recordJournal(category?: LiveFailureCategory) {
    if (recordingJournaled || !recorder) return;
    recordingJournaled = true;
    journal.add(
      liveJournalSnapshot(
        {
          method: "WS",
          path: "/v1/live/sessions",
          headers: { "x-test-id": testId },
          body: { model: "gpt-live-1", messages: [] },
          response: {
            status: category ? 502 : 200,
            fixture: null,
            source: "proxy",
            ...strictOverrideField(defaults.strict, options.headers),
            ...(category ? { error: category } : {}),
          },
        },
        [...limits.secretValues, ...recordingSecrets],
      ),
    );
  }
  function cleanup() {
    if (state === "closed") return;
    state = "closed";
    deadline();
    startup();
    upstreamIdle?.();
    recordJournal("incomplete-capture");
    recorder?.abort();
    upstream?.destroy();
    pending.length = 0;
    pendingBytes = 0;
    replay?.close();
    controller.abort();
    ws.removeListener("message", receive);
    ws.removeListener("close", cleanup);
    ws.removeListener("error", cleanup);
    options.onDispose();
  }
  function dispose() {
    if (state === "closed") return;
    ws.close(1001, "Live session disposed");
    cleanup();
  }
  function fail(category: LiveFailureCategory, message: string) {
    if (state === "closed" || state === "closing") return;
    state = "closing";
    recorder?.abort(category);
    recordJournal(category);
    // The safe diagnostic contains no caller payload, fixture data or credential.
    ws.send(JSON.stringify({ type: "aimock.error", error: { category, message } }));
    ws.close(category === "resource-limit" ? 1009 : 1008, "Live session failed");
    cleanup();
  }
  function receive(data: string) {
    if (state === "closed" || state === "closing") return;
    let event: LiveObject;
    try {
      event = validateLiveClientEvent(JSON.parse(data), limits);
    } catch {
      fail("invalid-client", "Invalid Live client command");
      return;
    }
    if (starting) {
      if (event.type === "session.start") {
        fail("invalid-client", "Live session has already started");
        return;
      }
      const bytes = Buffer.byteLength(data);
      if (bytes > maxPendingBytes - pendingBytes || pending.length >= maxPendingFrames) {
        fail("resource-limit", "Live startup input queue exceeded");
        return;
      }
      pendingBytes += bytes;
      pending.push(event);
      return;
    }
    accept(event);
  }
  function recordingError(error: unknown) {
    fail(
      error instanceof LiveRecorderError
        ? error.category
        : error instanceof Error && error.message === "WebSocket write limit exceeded"
          ? "resource-limit"
          : "upstream-connect",
      "Live recording failed",
    );
  }
  function touchUpstream() {
    upstreamIdle?.();
    upstreamIdle = scheduleLiveTimeout(
      () => fail("timeout", "Live upstream idle deadline exceeded"),
      bodyTimeoutMs,
    );
  }
  function forward(event: LiveObject) {
    if (!upstream || !recorder || terminalReceived) return;
    try {
      const raw = JSON.stringify(event);
      const now = performance.now();
      captureStarted ??= now;
      recorder.acceptClient(raw, Math.floor(now - captureStarted));
      void upstream.sendAsync(raw, controller.signal).catch(recordingError);
    } catch (error) {
      recordingError(error);
    }
  }
  async function startRecording(first: LiveObject) {
    const record = defaults.record;
    if (!record?.providers.openai) {
      fail("fixture-mismatch", "No matching Live fixture");
      return;
    }
    starting = true;
    try {
      const base = new URL(record.providers.openai);
      if (base.username || base.password || base.search || base.hash)
        throw new Error("Invalid URL");
      base.pathname = base.pathname.replace(/\/v1\/?$/, "/");
      const target = resolveUpstreamUrl(base.href, "/v1/live/sessions");
      const headers: Record<string, string> = {};
      const incoming = options.headers.authorization;
      const credential = incoming?.match(/^\s*(?:Bearer|Key)\s+(.+)$/i)?.[1].trim();
      if (incoming && !options.localApiKeys?.includes(credential ?? ""))
        headers.Authorization = incoming;
      applyProviderAuth(headers, target, "openai", record.providerKeys?.openai);
      const selected = headers.Authorization?.replace(/^\s*(?:Bearer|Key)\s+/i, "").trim();
      recordingSecrets = [...(selected ? [selected] : []), ...(options.localApiKeys ?? [])];
      recorder = createLiveRecorder({
        record,
        fixtures,
        logger: defaults.logger,
        testId,
        live: limits,
        secretValues: recordingSecrets,
        provenance: {
          host: target.host,
          path: "/v1/live/sessions",
          observedAt: new Date().toISOString(),
          referenceVersion: "gpt-live-1-observed-v3",
          sanitationVersion: 1,
        },
      });
      upstream = await connectUpstreamWebSocket(
        target,
        headers,
        limits,
        controller.signal,
        upstreamTimeoutMs,
      );
      if (controller.signal.aborted) {
        upstream.destroy();
        return;
      }
      upstream.on("activity", touchUpstream);
      upstream.on("message", (raw: string) => {
        if (controller.signal.aborted) return;
        touchUpstream();
        try {
          // Capture at provider arrival, before downstream backpressure settles.
          recorder!.acceptServer(
            raw,
            captureStarted === undefined ? 0 : Math.floor(performance.now() - captureStarted),
          );
          const output: unknown = JSON.parse(raw);
          if (!output || typeof output !== "object" || !("type" in output))
            throw new Error("Invalid event");
          if (output.type === "session.started") {
            startup();
            starting = false;
            state = "active";
            const queued = pending.splice(0);
            pendingBytes = 0;
            for (const event of queued) {
              if (controller.signal.aborted) break;
              accept(event);
            }
          }
          const terminal = output.type === "session.closed";
          if (terminal) terminalReceived = true;
          void ws.sendAsync(raw, controller.signal).then(() => {
            if (!terminal || controller.signal.aborted) return;
            const result = recorder!.finish();
            if (result.kind === "failed") {
              fail(result.category, "Live capture export failed");
              return;
            }
            recordJournal();
            ws.close(1000, "Live session complete");
            cleanup();
          }, recordingError);
        } catch (error) {
          recordingError(error);
        }
      });
      upstream.on("error", () => fail("upstream-connect", "Live upstream connection failed"));
      upstream.on("close", (code: number) => {
        if (!terminalReceived)
          fail(
            code === 1009 ? "resource-limit" : "incomplete-capture",
            "Live upstream closed before completion",
          );
      });
      touchUpstream();
      // Only startup is forwarded until the provider acknowledges the session.
      // The bounded queue retains commands that the caller pipelined meanwhile.
      forward(first);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/HTTP 401/.test(message)) fail("upstream-auth", "Live upstream authentication refused");
      else if (/HTTP (403|404|429)/.test(message))
        fail("upstream-access", "Live upstream access refused");
      else recordingError(error);
    }
  }
  function startReplay(
    fixture: Fixture,
    request: ChatCompletionRequest,
    first: LiveObject,
    raw: FixtureResponse,
  ) {
    if (state === "closed" || state === "closing") return;
    try {
      if (!isLiveResponse(raw)) throw new Error("not a Live fixture");
      const response = normalizeLiveFixture(raw, limits);
      replay = createLiveReplay(response.live, {
        limits,
        signal: controller.signal,
        timing: response.liveTiming ?? "recorded",
        replaySpeed: fixture.replaySpeed ?? defaults.replaySpeed,
        fail,
        send: async (output) => {
          await ws.sendAsync(JSON.stringify(output), controller.signal);
          if (output.type === "session.closed" && !controller.signal.aborted) {
            ws.close(1000, "Live session complete");
            cleanup();
          }
        },
      });
    } catch {
      fail("protocol-divergence", "Invalid Live replay configuration");
      return;
    }
    journal.add(
      liveJournalSnapshot(
        {
          method: "WS",
          path: "/v1/live/sessions",
          headers: { ...flattenHeaders(options.headers), "x-test-id": testId },
          body: request,
          response: { status: 200, fixture },
        },
        limits.secretValues,
      ),
      fixture,
    );
    startup();
    starting = false;
    state = "active";
    replay.accept(first);
    const queued = pending.splice(0);
    pendingBytes = 0;
    for (const event of queued) {
      if (controller.signal.aborted) break;
      accept(event);
    }
  }
  function accept(event: LiveObject) {
    if (state === "closed" || state === "closing") return;
    if (state === "awaiting-start") {
      const session = object(event.session);
      const audio = object(session?.audio);
      const format = object(audio?.format);
      const delegation = object(session?.delegation);
      if (
        event.type !== "session.start" ||
        session?.model !== "gpt-live-1" ||
        format?.type !== "audio/pcm" ||
        format.rate !== 24000 ||
        (delegation?.type !== "client" && delegation?.type !== "responses")
      ) {
        fail(
          "invalid-client",
          "Live requires session.start with explicit model, PCM24 audio and delegation",
        );
        return;
      }
      mode = delegation.type === "client" ? "client" : "managed";
      const request: ChatCompletionRequest = {
        model: session.model,
        messages: [],
        _endpointType: "openai-live",
        session: structuredClone(session),
      };
      let fixture: Fixture | null;
      let skippedBySequenceOrTurn: number;
      try {
        ({ fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
          fixtures,
          request,
          journal.getFixtureMatchCountsForTest(testId),
          defaults.requestTransform,
        ));
      } catch {
        fail("protocol-divergence", "Live fixture selection failed");
        return;
      }
      if (!fixture) {
        const decisions = resolveRequestDecisions(defaults.strict, options.headers);
        if (decisions.fixtureMiss) {
          const message = strictNoMatchMessage(skippedBySequenceOrTurn);
          defaults.logger.error(
            strictNoMatchLogLine("WS", "/v1/live/sessions", skippedBySequenceOrTurn),
          );
          // A rejected startup is diagnostic only: retain test ownership, never
          // caller authorization or session content, and do not create a recorder.
          journal.add(
            liveJournalSnapshot(
              {
                method: "WS",
                path: "/v1/live/sessions",
                headers: { "x-test-id": testId },
                body: { model: request.model, messages: [] },
                response: {
                  status: 503,
                  fixture: null,
                  ...strictOverrideField(defaults.strict, options.headers),
                },
              },
              limits.secretValues,
            ),
          );
          fail("fixture-mismatch", message);
        } else if (wouldProxyMiss(!decisions.upstream, defaults.record, "openai")) {
          void startRecording(event);
        } else {
          fail("fixture-mismatch", "No matching Live fixture");
        }
        return;
      }
      journal.incrementFixtureMatchCount(fixture, fixtures, testId);
      if (typeof fixture.response === "function") {
        starting = true;
        const selected = fixture;
        void resolveResponse(selected, request).then(
          (response) => startReplay(selected, request, event, response),
          () => fail("protocol-divergence", "Live response factory failed"),
        );
      } else startReplay(fixture, request, event, fixture.response);
      return;
    } else if (event.type === "session.start") {
      fail("invalid-client", "Live session has already started");
      return;
    }
    if (event.type === "session.update") {
      const patch = object(event.session);
      const delegation = object(patch?.delegation);
      const backend = object(delegation?.responses);
      if (
        mode !== "managed" ||
        !patch ||
        !delegation ||
        !backend ||
        Object.keys(patch).some((key) => key !== "delegation") ||
        Object.keys(delegation).some((key) => key !== "type" && key !== "responses") ||
        (delegation.type !== undefined && delegation.type !== "responses") ||
        Object.keys(backend).some((key) => key !== "instructions") ||
        !Object.hasOwn(backend, "instructions")
      ) {
        fail("invalid-client", "Only managed backend instructions can be updated");
        return;
      }
    }
    // Input acceptance is synchronous; output pressure never serializes duplex input.
    if (upstream) forward(event);
    else replay?.accept(event);
  }
  ws.on("message", receive);
  ws.on("close", cleanup);
  ws.on("error", cleanup);
  return dispose;
}
