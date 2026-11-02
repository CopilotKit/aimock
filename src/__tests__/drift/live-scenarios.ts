/**
 * Supported Live descriptors come from reviewed contract v3, not SDK typings.
 * Unknown server events are observations; comparisons concern required shapes
 * and causal invariants, never wording, latency, or audio chunk equality.
 */
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { LLMock } from "../../llmock.js";
import type { LiveJson, LiveMode, LiveObject } from "../../live-types.js";
import { UpstreamWebSocketRefusedError, connectUpstreamWebSocket } from "../../ws-upstream.js";
import type { WebSocketConnection } from "../../ws-framing.js";
import { readLiveCase, runLiveScenario } from "../live-test-support.js";
import { connectWebSocket } from "../ws-test-client.js";
import type { ShapeDiff } from "./schema.js";
import {
  ProviderQuotaExhaustedError,
  findProviderQuotaExhaustion,
  providerQuotaExhaustedError,
} from "./providers.js";
import { quotaCodeInCloseReason } from "../../../scripts/drift-quota.js";

type Observation = { direction: "client" | "server"; event: LiveObject };
function object(value: unknown): LiveObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  // Values originate from JSON parsing, LiveObject fields, or frozen fixtures.
  return value as LiveObject;
}
const contract = object(
  JSON.parse(readFileSync(new URL("../fixtures/live/contract.json", import.meta.url), "utf8")),
);
const descriptors = object(contract.schemaFreeze);
export const liveServerDescriptors = object(descriptors.serverEvents);
const definitions = object(descriptors.$defs);

/** Small evaluator for exactly the checked-in descriptor dialect. */
function conforms(value: LiveJson | undefined, schema: LiveObject): boolean {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/$defs/", "");
    if (!Object.hasOwn(definitions, name)) throw new Error("Unknown frozen Live schema reference");
    return conforms(value, object(definitions[name]));
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => conforms(value, object(s))))
    return false;
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value ?? null)) return false;
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.includes(kind)) return false;
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  if (
    Array.isArray(value) &&
    schema.items &&
    !value.every((v) => conforms(v, object(schema.items)))
  )
    return false;
  if (kind === "object") {
    const obj = object(value);
    if (
      Array.isArray(schema.required) &&
      schema.required.some((k) => typeof k !== "string" || !Object.hasOwn(obj, k))
    )
      return false;
    for (const [key, field] of Object.entries(object(schema.properties))) {
      if (Object.hasOwn(obj, key) && !conforms(obj[key], object(field))) return false;
    }
  }
  return true;
}

function invariants(mode: LiveMode, observations: Observation[]) {
  const server = observations.filter((e) => e.direction === "server").map((e) => e.event);
  const client = observations.filter((e) => e.direction === "client").map((e) => e.event);
  const has = (type: string) => server.some((e) => e.type === type);
  const index = (type: string) => observations.findIndex((e) => e.event.type === type);
  const start = object(server[0]?.session),
    end = object(server.at(-1)?.session);
  const audio = server.filter((e) => e.type === "session.output_audio.delta");
  const usages = server
    .filter((e) => e.type === "session.usage.updated" || e.type === "session.closed")
    .map((e) => object(e.usage).seconds);
  const delegated = server
    .filter((e) => e.type === "session.delegation.created")
    .map((e) => object(e.delegation));
  const calls = server
    .filter(
      (e) => e.type === "response.event" && object(e.event).type === "response.output_item.done",
    )
    .map((e) => object(object(e.event).item))
    .filter((i) => i.type === "function_call");
  const results = client
    .filter((e) => e.type === "response.item.create")
    .map((e) => object(e.item));
  const continuation = index("response.create");
  const completedAfter = observations
    .slice(continuation + 1)
    .some(
      (e) =>
        e.direction === "server" &&
        e.event.type === "response.event" &&
        object(e.event.event).type === "response.completed",
    );
  const responses = server.filter((e) => e.type === "response.event").map((e) => object(e.event));
  const originalResponse = responses.find((e) => e.type === "response.created");
  const resumedResponse = observations
    .slice(continuation + 1)
    .find(
      (e) =>
        e.direction === "server" &&
        e.event.type === "response.event" &&
        object(e.event.event).type === "response.created",
    );
  const originalId = object(originalResponse?.response).id;
  const resumed = object(object(resumedResponse?.event.event).response);
  const common = {
    requiredShapes: server.every(
      (e) =>
        typeof e.type === "string" &&
        (!Object.hasOwn(liveServerDescriptors, e.type) ||
          conforms(e, object(liveServerDescriptors[e.type]))),
    ),
    successfulLifecycle:
      server[0]?.type === "session.started" &&
      server.at(-1)?.type === "session.closed" &&
      server.at(-1)?.reason === "close_requested" &&
      start.id === end.id &&
      typeof start.id === "string" &&
      start.model === "gpt-live-1",
    requestedMode: object(start.delegation).type === (mode === "client" ? "client" : "responses"),
    substantiveAudio:
      audio.length > 0 &&
      audio.every(
        (e) =>
          typeof e.delta === "string" &&
          e.delta.length > 0 &&
          Buffer.from(e.delta, "base64").toString("base64") === e.delta &&
          Buffer.from(e.delta, "base64").length % 2 === 0,
      ),
    inputTranscript: server.some(
      (e) =>
        e.type === "session.input_transcript.delta" &&
        typeof e.delta === "string" &&
        e.delta.trim().length > 0,
    ),
    outputTranscript: server.some(
      (e) =>
        e.type === "session.output_transcript.delta" &&
        typeof e.delta === "string" &&
        e.delta.trim().length > 0,
    ),
    cumulativeUsage:
      usages.length >= 2 &&
      usages.every(
        (n, i) => typeof n === "number" && n >= 0 && (i === 0 || n >= Number(usages[i - 1])),
      ),
    noErrors: !has("error") && !has("aimock.error"),
    delegationAfterSpeech:
      delegated.length > 0 &&
      index("session.delegation.created") > index("session.input_audio.append"),
  };
  return {
    ...common,
    managedResponseIdentity:
      mode === "client" ||
      (typeof originalId === "string" &&
        delegated.some((d) => d.response_id === originalId) &&
        typeof resumed.id === "string" &&
        resumed.id !== originalId &&
        resumed.previous_response_id === originalId &&
        responses.some(
          (e) =>
            e.type === "response.completed" &&
            object(e.response).id === resumed.id &&
            object(e.response).status === "completed",
        )),
    modeContinuation:
      mode === "client"
        ? has("session.thinking.appended") &&
          has("session.commentary.appended") &&
          client
            .filter(
              (e) => e.type === "session.thinking.append" || e.type === "session.commentary.append",
            )
            .every(
              (e) => e.delegation_id === null || delegated.some((d) => d.id === e.delegation_id),
            ) &&
          index("session.commentary.appended") > index("session.commentary.append")
        : calls.length >= 2 &&
          new Set(calls.map((c) => c.name)).has("read_red") &&
          new Set(calls.map((c) => c.name)).has("read_blue") &&
          calls.every((c) => results.some((r) => r.call_id === c.call_id)) &&
          continuation > 0 &&
          observations.every(
            (e, i) => e.event.type !== "response.item.create" || i < continuation,
          ) &&
          completedAfter,
  };
}

export function compareLiveInvariants(
  mode: LiveMode,
  real: Observation[],
  mock: Observation[],
): ShapeDiff[] {
  const actual = invariants(mode, real),
    replay = invariants(mode, mock);
  return Object.entries(actual).flatMap(([name, passed]) => {
    const mocked = Object.entries(replay).find(([key]) => key === name)?.[1];
    return passed && mocked
      ? []
      : [
          {
            path: `Live:${mode}:${name}`,
            severity: "critical" as const,
            issue: "Supported Live scenario invariant failed",
            expected: "true (reviewed provider contract)",
            real: String(passed),
            mock: String(mocked),
          },
        ];
  });
}

export async function runLiveMock(mode: LiveMode): Promise<Observation[]> {
  const { transcript } = readLiveCase(mode);
  const mock = new LLMock();
  mock.onLive({}, transcript);
  let ws;
  try {
    await mock.start();
    ws = await connectWebSocket(mock.url, "/v1/live/sessions");
    const result = await runLiveScenario(ws, transcript, {
      clientIdPrefix: `drift-${mode}`,
      timeoutMs: 45_000,
    });
    let c = 0,
      s = 0;
    return transcript.entries.map((e) => ({
      direction: e.direction,
      event: e.direction === "client" ? result.client[c++] : result.server[s++],
    }));
  } finally {
    ws?.destroy();
    await mock.stop();
  }
}

let providerRefused = false;
// Set when the refusal was an out-of-credit error, so the legs that follow report
// the same infra cause instead of a bare "earlier provider refusal".
let refusalQuotaCode: string | null = null;

/**
 * The failure a Live `error` event becomes. Provider error text stays redacted;
 * only an out-of-credit code is named, because that is infra, not drift.
 */
export function liveProviderErrorFailure(event: LiveObject): Error {
  const code = findProviderQuotaExhaustion([event]);
  if (code !== null) return providerQuotaExhaustedError("OpenAI Live", code);
  return new Error("OpenAI Live provider error; configured access or scenario unavailable");
}

const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";

/**
 * Run one Live mode against the provider. `endpoint` exists for tests: the
 * upstream connector accepts a plain-text URL only for a loopback peer.
 */
export async function runLiveProvider(
  mode: LiveMode,
  apiKey: string,
  endpoint: string = OPENAI_LIVE_SESSIONS_URL,
): Promise<Observation[]> {
  if (providerRefused)
    throw refusalQuotaCode !== null
      ? providerQuotaExhaustedError("OpenAI Live", refusalQuotaCode)
      : new Error("OpenAI Live unavailable: earlier provider refusal; no retry");
  const started = performance.now(),
    abort = new AbortController();
  const observations: Observation[] = [];
  let ws: WebSocketConnection | undefined,
    failure: Error | undefined,
    wireBytes = 0,
    closed = false,
    closeFrame: { code: number; reason: string } | undefined;
  let sentAudio = 0,
    streamingAt: number | undefined,
    sentClose = false,
    delegated = false,
    continued = false;
  const calls = new Map<string, LiveObject>();
  const configuration = readLiveCase(mode).transcript.configuration;
  // Reviewed, owned synthetic speech; no microphone, TTS API, or extra secrets.
  const input = Buffer.concat(
    readLiveCase("client")
      .transcript.entries.filter(
        (e) => e.direction === "client" && e.event.type === "session.input_audio.append",
      )
      .map((e) => Buffer.from(String(e.event.audio), "base64")),
  );
  if (input.length > 480_000) throw new Error("Owned input exceeds ten seconds");
  const store = (direction: "client" | "server", event: LiveObject, bytes: number) => {
    wireBytes += bytes;
    if (wireBytes > 8 * 1024 * 1024 || observations.length >= 5000)
      throw new Error("Live canary capture limit exceeded");
    observations.push({ direction, event });
  };
  const send = async (event: LiveObject) => {
    const raw = JSON.stringify(event);
    store("client", event, Buffer.byteLength(raw));
    await ws!.sendAsync(raw, abort.signal);
  };
  const deadline = setTimeout(() => abort.abort(), 45_000);
  try {
    ws = await connectUpstreamWebSocket(
      new URL(endpoint),
      { Authorization: `Bearer ${apiKey}` },
      {},
      abort.signal,
      15_000,
    );
    ws.on("message", (raw: string) => {
      try {
        const event = object(JSON.parse(raw));
        store("server", event, Buffer.byteLength(raw));
        if (event.type === "error") {
          providerRefused = true;
          // The first cause wins: a later frame never replaces a recorded
          // out-of-credit refusal with a generic one.
          refusalQuotaCode ??= findProviderQuotaExhaustion([event]);
          failure ??= liveProviderErrorFailure(event);
        }
      } catch {
        failure ??= new Error("OpenAI Live malformed or oversized capture");
      }
    });
    ws.on("error", () => {
      failure ??= new Error("OpenAI Live transport failed");
    });
    ws.on("close", (code: number, reason: string) => {
      // An out-of-credit session can end with only a close frame
      // (1013 `insufficient_quota.credit_balance_exhausted`) and no `error` event.
      const quotaCode = quotaCodeInCloseReason(String(reason ?? ""));
      if (quotaCode !== null) {
        providerRefused = true;
        refusalQuotaCode ??= quotaCode;
        failure ??= providerQuotaExhaustedError("OpenAI Live", quotaCode);
      }
      closeFrame ??= { code, reason: String(reason ?? "") };
      closed = true;
    });
    await send({ type: "session.start", event_id: "drift_start", session: configuration });
    let cursor = 0;
    while (!abort.signal.aborted) {
      if (failure) throw failure;
      for (; cursor < observations.length; cursor++) {
        const { direction, event } = observations[cursor];
        if (direction !== "server") continue;
        if (event.type === "session.started") streamingAt ??= performance.now();
        if (event.type === "session.closed") return observations;
        if (event.type === "session.delegation.created" && mode === "client" && !delegated) {
          delegated = true;
          const id = object(event.delegation).id;
          if (typeof id !== "string") throw new Error("Live delegation missing identifier");
          await send({
            type: "session.thinking.append",
            event_id: "drift_thinking",
            delegation_id: id,
            content: "The fictional sensor checks are pending.",
          });
          await send({
            type: "session.commentary.append",
            event_id: "drift_result",
            delegation_id: id,
            content:
              "The fictional red sensor reads seven and the blue sensor reads nine. Both checks are complete.",
          });
        }
        if (event.type === "response.event") {
          const nested = object(event.event),
            item = object(nested.item);
          if (
            nested.type === "response.output_item.done" &&
            item.type === "function_call" &&
            typeof item.call_id === "string"
          )
            calls.set(item.call_id, item);
          if (nested.type === "response.completed" && !continued && calls.size >= 2) {
            continued = true;
            for (const [id, call] of calls)
              await send({
                type: "response.item.create",
                event_id: `drift_result_${calls.size}_${call.name}`,
                item: {
                  type: "function_call_output",
                  call_id: id,
                  output: JSON.stringify({ value: call.name === "read_red" ? 7 : 9 }),
                },
              });
            await send({ type: "response.create", event_id: "drift_continue" });
          }
        }
      }
      if (failure) throw failure;
      if (closed) {
        const frame = closeFrame
          ? ` (close code ${closeFrame.code}${closeFrame.reason ? `: ${closeFrame.reason}` : ""})`
          : "";
        throw new Error(
          `OpenAI Live closed without terminal event; observed ${observations.filter((e) => e.direction === "server").length} messages${frame}`,
        );
      }
      if (streamingAt !== undefined) {
        const elapsed = performance.now() - streamingAt;
        if (sentAudio < input.length && elapsed >= 200 + sentAudio / 48) {
          await send({
            type: "session.input_audio.append",
            audio: input.subarray(sentAudio, sentAudio + 4800).toString("base64"),
          });
          sentAudio += 4800;
        }
        if (elapsed >= 20_000 && !sentClose) {
          sentClose = true;
          await send({ type: "session.close", event_id: "drift_close" });
        }
      }
      await delay(10);
    }
    throw new Error(
      `waitUntil timeout after 45000ms. Collected ${observations.filter((e) => e.direction === "server").length} messages: OpenAI Live session.closed`,
    );
  } catch (error) {
    // A send can fail with "WebSocket closed" after the quota close or error
    // event was recorded. Report the recorded quota cause, not the send error.
    if (failure instanceof ProviderQuotaExhaustedError && error !== failure) throw failure;
    if (error instanceof UpstreamWebSocketRefusedError) {
      // A refused upgrade names out-of-credit in its error envelope. Record it
      // so the next Live mode reports the same cause without a paid connect.
      const quotaCode = findProviderQuotaExhaustion([
        { code: error.errorCode, type: error.errorType },
      ]);
      if (quotaCode !== null) {
        providerRefused = true;
        refusalQuotaCode ??= quotaCode;
        throw providerQuotaExhaustedError("OpenAI Live", quotaCode, error.status);
      }
    }
    if (error instanceof Error && /HTTP (401|403|429)/.test(error.message)) providerRefused = true;
    if (error instanceof Error && error.message === "Upstream WebSocket upgrade timed out")
      throw new Error("waitUntil timeout after 15000ms. Collected 0 messages: OpenAI Live upgrade");
    throw error;
  } finally {
    clearTimeout(deadline);
    abort.abort();
    ws?.destroy();
    const events = observations.filter((e) => e.direction === "server").map((e) => e.event);
    const usage =
      events.filter((e) => e.type === "session.usage.updated" || e.type === "session.closed").at(-1)
        ?.usage ?? null;
    console.log(
      JSON.stringify({
        liveCanary: mode,
        elapsedMs: Math.round(performance.now() - started),
        serverEvents: events.length,
        inputBytes: sentAudio,
        usage,
        unknownEvents: [
          ...new Set(
            events
              .filter(
                (e) => typeof e.type === "string" && !Object.hasOwn(liveServerDescriptors, e.type),
              )
              .map((e) => e.type),
          ),
        ],
      }),
    );
  }
}
