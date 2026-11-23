import { describe, expect, it } from "vitest";
import {
  normalizeLiveFixture,
  validateLiveClientEvent,
  validateLiveTranscript,
  DEFAULT_LIVE_OPTIONS,
  normalizeLiveOptions,
} from "../live-fixture.js";
import type { LiveTranscript, LiveEntry } from "../live-types.js";

// Authored startup/close excerpt from the independently reviewed client projection.
const sample: LiveTranscript = {
  version: 1,
  model: "gpt-live-1",
  mode: "client",
  audio: {
    encoding: "pcm16le",
    sampleRateHz: 24000,
    channels: 1,
  },
  configuration: {
    model: "gpt-live-1",
    instructions:
      "You are testing fictional sensor readings. Be concise. Always delegate sensor checks to the backend. While checks are pending, say you are still listening. Keep backend checks running if the user interrupts. Speak returned sensor readings briefly.",
    audio: {
      format: {
        type: "audio/pcm",
        rate: 24000,
      },
      output: {
        voice: "marin",
      },
    },
    delegation: {
      type: "client",
    },
  },
  entries: [
    {
      direction: "client",
      atMs: 155,
      event: {
        type: "session.start",
        event_id: "sanitized-client-event-0",
        session: {
          model: "gpt-live-1",
          instructions:
            "You are testing fictional sensor readings. Be concise. Always delegate sensor checks to the backend. While checks are pending, say you are still listening. Keep backend checks running if the user interrupts. Speak returned sensor readings briefly.",
          audio: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            output: {
              voice: "marin",
            },
          },
          delegation: {
            type: "client",
          },
        },
      },
    },
    {
      direction: "server",
      atMs: 614,
      event: {
        event_id: "sanitized-server-event-0",
        type: "session.started",
        client_event_id: "sanitized-client-event-0",
        session: {
          id: "sanitized-session-0",
          expires_at: 1789676841,
          model: "gpt-live-1",
          instructions:
            "You are testing fictional sensor readings. Be concise. Always delegate sensor checks to the backend. While checks are pending, say you are still listening. Keep backend checks running if the user interrupts. Speak returned sensor readings briefly.",
          audio: {
            output: {
              voice: "marin",
            },
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
          },
          delegation: {
            type: "client",
          },
          status: "active",
          input: [],
        },
      },
      barrier: {
        command: 1,
        audioBytes: 0,
      },
    },
    {
      direction: "client",
      atMs: 33615,
      event: {
        type: "session.close",
        event_id: "sanitized-client-event-4",
      },
    },
    {
      direction: "server",
      atMs: 34247,
      event: {
        event_id: "sanitized-server-event-36",
        type: "session.closed",
        reason: "close_requested",
        session: {
          id: "sanitized-session-0",
          expires_at: 1789676841,
          model: "gpt-live-1",
          instructions:
            "You are testing fictional sensor readings. Be concise. Always delegate sensor checks to the backend. While checks are pending, say you are still listening. Keep backend checks running if the user interrupts. Speak returned sensor readings briefly.",
          audio: {
            output: {
              voice: "marin",
            },
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
          },
          delegation: {
            type: "client",
          },
          status: "active",
          input: [],
        },
        usage: {
          seconds: 13,
        },
        client_event_id: "sanitized-client-event-4",
      },
      barrier: {
        command: 2,
        audioBytes: 0,
      },
    },
  ],
  bindings: [
    {
      entry: 0,
      pointer: "/event_id",
      name: "client-event:0",
      action: "define",
      owner: "client",
    },
    {
      entry: 1,
      pointer: "/event_id",
      name: "server-event:0",
      action: "define",
      owner: "server",
    },
    {
      entry: 1,
      pointer: "/client_event_id",
      name: "client-event:0",
      action: "reference",
      owner: "client",
    },
    {
      entry: 1,
      pointer: "/session/id",
      name: "session:0",
      action: "define",
      owner: "server",
    },
    {
      entry: 2,
      pointer: "/event_id",
      name: "client-event:4",
      action: "define",
      owner: "client",
    },
    {
      entry: 3,
      pointer: "/event_id",
      name: "server-event:36",
      action: "define",
      owner: "server",
    },
    {
      entry: 3,
      pointer: "/client_event_id",
      name: "client-event:4",
      action: "reference",
      owner: "client",
    },
    {
      entry: 3,
      pointer: "/session/id",
      name: "session:0",
      action: "reference",
      owner: "server",
    },
  ],
  capture: {
    source: "authored",
    complete: true,
    terminalEntry: 3,
  },
};
const fixture = () => structuredClone(sample);

describe("live fixture validation", () => {
  it("clones a bounded successful transcript", () => {
    const t = fixture();
    expect(normalizeLiveFixture({ live: t }).live).toEqual(t);
    expect(validateLiveTranscript(t)).not.toBe(t);
  });
  it("rejects a future server barrier", () => {
    const t = fixture();
    t.entries[1].barrier = { command: 999999, audioBytes: 0 };
    expect(() => validateLiveTranscript(t)).toThrow(/entries\[1\].*barrier/);
  });
  it("exports finite defaults", () => {
    expect(DEFAULT_LIVE_OPTIONS.maxSessions).toBe(16);
  });
});

function insert(t: LiveTranscript, entry: LiveEntry) {
  const index = t.entries.length - 2;
  t.entries.splice(index, 0, entry);
  for (const binding of t.bindings) if (binding.entry >= index) binding.entry++;
  t.capture.terminalEntry++;
  return index;
}
function withImportedResponse() {
  const t = fixture();
  const index = insert(t, {
    direction: "server",
    atMs: t.entries[1].atMs,
    barrier: { command: 1, audioBytes: 0 },
    event: {
      type: "response.event",
      event_id: "response-event",
      event: {
        type: "response.created",
        response: { id: "current-response", previous_response_id: "imported-response" },
      },
    },
  });
  t.bindings.push(
    {
      entry: index,
      pointer: "/event_id",
      name: "server-event:response",
      owner: "server",
      action: "define",
    },
    {
      entry: index,
      pointer: "/event/response/id",
      name: "response:current",
      owner: "server",
      action: "define",
    },
    {
      entry: index,
      pointer: "/event/response/previous_response_id",
      name: "response:imported",
      owner: "server",
      action: "define",
      origin: "imported-context",
    },
  );
  return { t, index };
}

describe("bounded JSON and transcript contracts", () => {
  it.each([
    ["version", { version: 2 }],
    ["model", { model: "other" }],
    ["mode", { mode: "other" }],
    ["audio", { audio: { encoding: "pcm16le", sampleRateHz: 16000, channels: 1 } }],
    ["capture.complete", { capture: { source: "authored", complete: false, terminalEntry: 3 } }],
    [
      "capture.terminalEntry",
      { capture: { source: "authored", complete: true, terminalEntry: 1 } },
    ],
  ])("rejects invalid %s", (field, patch) => {
    expect(() => validateLiveTranscript({ ...fixture(), ...patch })).toThrow(field);
  });
  it("rejects cycles without invoking accessors", () => {
    const t = fixture();
    t.configuration.loop = t.configuration;
    expect(() => validateLiveTranscript(t)).toThrow(/cycle/);
    const input = {
      get live() {
        throw new Error("getter invoked");
      },
    };
    expect(() => normalizeLiveFixture(input)).toThrow(/own data property/);
  });
  it("rejects non-JSON values and unsafe properties", () => {
    for (const value of [
      NaN,
      undefined,
      new Date(),
      () => 0,
      Object.create({ inherited: 1 }),
      JSON.parse('{"__proto__":1}'),
    ]) {
      expect(() => validateLiveTranscript({ ...fixture(), extra: value })).toThrow();
    }
  });
  it("rejects sparse arrays and excessive depth", () => {
    expect(() => validateLiveTranscript({ ...fixture(), extra: new Array(2) })).toThrow(/dense/);
    let deep: object = {};
    for (let i = 0; i < 33; i++) deep = { deep };
    expect(() => validateLiveTranscript({ ...fixture(), extra: deep })).toThrow(/depth/);
  });
  it("preserves bounded unknown server fields and events", () => {
    const t = fixture();
    insert(t, {
      direction: "server",
      atMs: t.entries[1].atMs,
      barrier: { command: 1, audioBytes: 0 },
      event: {
        type: "future.event",
        future: { array: [null, 1, "literal"], unchanged: "sanitized-session-0" },
      },
    });
    expect(validateLiveTranscript(t)).toEqual(t);
  });
  it("rejects unknown client commands and incomplete known server shapes", () => {
    const t = fixture();
    t.entries[2].event.type = "invented.command";
    expect(() => validateLiveTranscript(t)).toThrow(/entries\[2\].event.type/);
    const s = fixture();
    delete s.entries[1].event.session;
    expect(() => validateLiveTranscript(s)).toThrow(/entries\[1\].event.session/);
  });
  it("requires startup configuration equality independent of object order", () => {
    const t = fixture();
    t.entries[0].event.session = Object.fromEntries(Object.entries(t.configuration).reverse());
    expect(validateLiveTranscript(t)).toEqual(t);
    t.entries[0].event.session = { ...t.configuration, instructions: "changed" };
    expect(() => validateLiveTranscript(t)).toThrow(/entries\[0\].event.session/);
  });
  it("rejects absent explicit mode/audio configuration", () => {
    const t = fixture();
    delete t.configuration.delegation;
    expect(() => validateLiveTranscript(t)).toThrow(/configuration.delegation/);
    const s = fixture();
    delete s.configuration.audio;
    expect(() => validateLiveTranscript(s)).toThrow(/configuration.audio/);
  });
  it("validates options and timing", () => {
    for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => normalizeLiveOptions({ maxSessions: value })).toThrow(/maxSessions/);
    expect(normalizeLiveOptions({ maxSessions: 2 }).maxSessions).toBe(2);
    expect(() => normalizeLiveFixture({ live: fixture(), liveTiming: "fast" })).toThrow(
      /liveTiming/,
    );
    expect(normalizeLiveFixture({ live: fixture(), liveTiming: "immediate" }).liveTiming).toBe(
      "immediate",
    );
  });
});

describe("audio barriers", () => {
  it.each(["AA=", "AA A", "AAA", "AAB=", "AA=="])("rejects malformed or odd PCM %s", (audio) => {
    const t = fixture();
    insert(t, {
      direction: "client",
      atMs: t.entries[1].atMs,
      event: { type: "session.input_audio.append", audio },
    });
    expect(() => validateLiveTranscript(t)).toThrow(/event.audio/);
  });
  it("accepts sample barriers inside an adjacent audio run", () => {
    const t = fixture();
    const index = insert(t, {
      direction: "client",
      atMs: t.entries[1].atMs,
      event: { type: "session.input_audio.append", audio: "AAAAAAAA" },
    });
    t.entries.splice(index + 1, 0, {
      direction: "server",
      atMs: t.entries[1].atMs,
      barrier: { command: 1, audioBytes: 2 },
      event: { type: "future.event" },
    });
    t.capture.terminalEntry++;
    for (const b of t.bindings) if (b.entry > index) b.entry++;
    expect(validateLiveTranscript(t)).toEqual(t);
    t.entries[index + 1].barrier = { command: 1, audioBytes: 8 };
    expect(() => validateLiveTranscript(t)).toThrow(/barrier/);
  });
  it("rejects odd and decreasing barriers, backward time and client barriers", () => {
    const t = fixture();
    t.entries[1].barrier = { command: 1, audioBytes: 1 };
    expect(() => validateLiveTranscript(t)).toThrow(/barrier/);
    const s = fixture();
    s.entries[3].barrier = { command: 0, audioBytes: 0 };
    expect(() => validateLiveTranscript(s)).toThrow(/barrier/);
    const u = fixture();
    u.entries[2].atMs = 0;
    expect(() => validateLiveTranscript(u)).toThrow(/atMs/);
    const v = fixture();
    v.entries[0].barrier = { command: 0, audioBytes: 0 };
    expect(() => validateLiveTranscript(v)).toThrow(/barrier/);
  });
  it("checks decoded audio limits before decoding", () => {
    const t = fixture();
    insert(t, {
      direction: "client",
      atMs: t.entries[1].atMs,
      event: { type: "session.input_audio.append", audio: "AAAAAAAA" },
    });
    expect(() => validateLiveTranscript(t, { maxDecodedAudioBytes: 2 })).toThrow(
      /audio byte limit/,
    );
    expect(() => validateLiveTranscript(fixture(), { maxMessageBytes: 32 })).toThrow(
      /message byte limit/,
    );
  });
});

describe("descriptor-owned identifier bindings", () => {
  it("accepts a narrow imported previous response identity", () => {
    const { t } = withImportedResponse();
    expect(validateLiveTranscript(t)).toEqual(t);
  });
  it.each(["/event/response/id", "/event_id", "/literal"])(
    "rejects illegal import at %s",
    (ptr) => {
      const { t } = withImportedResponse();
      const b = t.bindings.at(-1)!;
      b.pointer = ptr;
      expect(() => validateLiveTranscript(t)).toThrow(/bindings/);
    },
  );
  it("rejects imported client ownership and imported references", () => {
    const { t } = withImportedResponse();
    t.bindings.at(-1)!.owner = "client";
    expect(() => validateLiveTranscript(t)).toThrow(/owner/);
    const { t: s } = withImportedResponse();
    s.bindings.at(-1)!.action = "reference";
    expect(() => validateLiveTranscript(s)).toThrow(/origin/);
  });
  it("preserves null and absent identifiers without binding", () => {
    for (const absent of [false, true]) {
      const { t, index } = withImportedResponse();
      t.bindings.pop();
      const nested = t.entries[index].event.event;
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) throw new Error("nested");
      const response = nested.response;
      if (!response || typeof response !== "object" || Array.isArray(response))
        throw new Error("response");
      if (absent) delete response.previous_response_id;
      else response.previous_response_id = null;
      expect(validateLiveTranscript(t)).toEqual(t);
    }
  });
  it("rejects forward references, missing annotations and namespace aliases", () => {
    const t = fixture();
    t.bindings[0].action = "reference";
    expect(() => validateLiveTranscript(t)).toThrow(/reference/);
    const s = fixture();
    s.bindings.shift();
    expect(() => validateLiveTranscript(s)).toThrow(/missing identifier binding/);
    const u = fixture();
    u.bindings[1].name = u.bindings[0].name;
    expect(() => validateLiveTranscript(u)).toThrow(/duplicate identity/);
  });
  it("rejects wrong references and dangerous pointers", () => {
    const t = fixture();
    t.entries[3].event.client_event_id = "wrong";
    expect(() => validateLiveTranscript(t)).toThrow(/bijection/);
    const s = fixture();
    s.bindings[0].pointer = "/__proto__/id";
    expect(() => validateLiveTranscript(s)).toThrow(/unsafe segment/);
  });
});

it("validates a large bounded PCM append without regex stack exhaustion", () => {
  const t = fixture();
  insert(t, {
    direction: "client",
    atMs: t.entries[1].atMs,
    event: { type: "session.input_audio.append", audio: "AAAA".repeat(200_000) },
  });
  expect(validateLiveTranscript(t)).toEqual(t);
});

it("accepts only the observed sparse managed instructions patch", () => {
  const t = fixture();
  t.mode = "managed";
  t.configuration.delegation = {
    type: "responses",
    responses: { model: "gpt-5.6-luna", instructions: "initial" },
  };
  t.entries[0].event.session = structuredClone(t.configuration);
  for (const entry of t.entries.filter((entry) => entry.direction === "server")) {
    const session = entry.event.session;
    if (!session || typeof session !== "object" || Array.isArray(session))
      throw new Error("session");
    session.delegation = structuredClone(t.configuration.delegation);
  }
  const terminalSession = t.entries.at(-1)!.event.session;
  if (!terminalSession || typeof terminalSession !== "object" || Array.isArray(terminalSession))
    throw new Error("terminal session");
  terminalSession.delegation = {
    type: "responses",
    responses: { model: "gpt-5.6-luna", instructions: "updated" },
  };
  const index = insert(t, {
    direction: "client",
    atMs: t.entries[1].atMs,
    event: {
      type: "session.update",
      session: { delegation: { type: "responses", responses: { instructions: "updated" } } },
    },
  });
  t.entries.at(-1)!.barrier = { command: 3, audioBytes: 0 };
  expect(validateLiveTranscript(t)).toEqual(t);
  t.entries[index].event.session = {
    delegation: { type: "responses", responses: { model: "other" } },
  };
  expect(() => validateLiveTranscript(t)).toThrow(/observed backend instructions/);
});

it("accepts documented graceful remote termination", () => {
  const t = fixture();
  t.entries.at(-1)!.event.reason = "remote_hangup";
  expect(validateLiveTranscript(t)).toEqual(t);
});
it.each(["expired", "content", "connection_lost"])(
  "rejects unsuccessful termination %s",
  (reason) => {
    const t = fixture();
    t.entries.at(-1)!.event.reason = reason;
    expect(() => validateLiveTranscript(t)).toThrow(/successful server session.closed/);
  },
);

it("rejects a server snapshot changing the configured delegation owner", () => {
  const t = fixture();
  const session = t.entries[1].event.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) throw new Error("session");
  session.delegation = { type: "responses", responses: { model: "gpt-5.6-luna" } };
  expect(() => validateLiveTranscript(t)).toThrow(/entries\[1\].event.session.delegation/);
});

it("rejects inherited schema-map names as unknown client commands", () => {
  const t = fixture();
  t.entries[2].event.type = "constructor";
  expect(() => validateLiveTranscript(t)).toThrow(/unsupported client command/);
});

describe("standalone client event validation", () => {
  it("clones a captured startup command and unknown bounded fields", () => {
    const event = { ...fixture().entries[0].event, future: { nested: [null, "literal", 1] } };
    const validated = validateLiveClientEvent(event);
    expect(validated).toEqual(event);
    expect(validated).not.toBe(event);
    expect(validated.future).not.toBe(event.future);
  });
  it.each([
    null,
    [],
    {},
    { type: "constructor" },
    { type: "toString" },
    { type: "unknown.command" },
    { type: "session.start", session: { model: 42 } },
  ])("rejects invalid command shape %#", (event) => {
    expect(() => validateLiveClientEvent(event)).toThrow();
  });
  it("keeps lifecycle and documented-only coverage policy with the caller", () => {
    for (const event of [
      { type: "session.start", session: { model: "gpt-live-1" } },
      { type: "session.close" },
      { type: "session.input_audio.mute" },
      { type: "session.update", session: {} },
    ])
      expect(validateLiveClientEvent(event)).toEqual(event);
  });
  it("checks canonical PCM and per-event decoded limits", () => {
    expect(validateLiveClientEvent({ type: "session.input_audio.append", audio: "AAA=" })).toEqual({
      type: "session.input_audio.append",
      audio: "AAA=",
    });
    for (const audio of ["AA==", "AAB=", "AAA", "AA A"])
      expect(() => validateLiveClientEvent({ type: "session.input_audio.append", audio })).toThrow(
        /event.audio/,
      );
    expect(() =>
      validateLiveClientEvent(
        { type: "session.input_audio.append", audio: "AAAAAAAA" },
        { maxDecodedAudioBytes: 2 },
      ),
    ).toThrow(/decoded audio byte limit/);
  });
  it("applies the message ceiling during clone and rejects unsafe runtime data", () => {
    expect(() =>
      validateLiveClientEvent(
        { type: "session.close", extra: "x".repeat(1000) },
        { maxMessageBytes: 100 },
      ),
    ).toThrow(/JSON byte limit/);
    const event = fixture().entries[0].event;
    event.cycle = event;
    expect(() => validateLiveClientEvent(event)).toThrow(/cycle/);
    expect(() =>
      validateLiveClientEvent({
        get type() {
          throw new Error("getter executed");
        },
      }),
    ).toThrow(/enumerable data property/);
    expect(() => validateLiveClientEvent({ type: "session.close", number: NaN })).toThrow(
      /finite JSON/,
    );
  });
});

describe("barriers cover referenced client definitions", () => {
  it("rejects a terminal reference to a command beyond its barrier", () => {
    const t = fixture();
    t.entries[3].barrier = { command: 1, audioBytes: 0 };
    expect(() => validateLiveTranscript(t)).toThrow(/entries\[3\].*barrier.*referenced client/);
    t.entries[3].barrier = { command: 2, audioBytes: 0 };
    expect(validateLiveTranscript(t)).toEqual(t);
  });
  it("requires the complete defining audio append, not just an earlier sample", () => {
    const t = fixture();
    const input = insert(t, {
      direction: "client",
      atMs: t.entries[1].atMs,
      event: { type: "session.input_audio.append", audio: "AAAAAA==", event_id: "audio-command" },
    });
    const output = insert(t, {
      direction: "server",
      atMs: t.entries[1].atMs,
      barrier: { command: 1, audioBytes: 2 },
      event: { type: "future.audio.ack", client_event_id: "audio-command" },
    });
    t.bindings.push(
      {
        entry: input,
        pointer: "/event_id",
        name: "client-event:audio",
        owner: "client",
        action: "define",
      },
      {
        entry: output,
        pointer: "/client_event_id",
        name: "client-event:audio",
        owner: "client",
        action: "reference",
      },
    );
    expect(() => validateLiveTranscript(t)).toThrow(/barrier.*referenced client/);
    t.entries[output].barrier = { command: 1, audioBytes: 4 };
    expect(validateLiveTranscript(t)).toEqual(t);
    // A later control resets audioBytes but is still causally after the audio definition.
    t.entries.at(-1)!.event.client_event_id = "audio-command";
    const terminalReference = t.bindings.find(
      (binding) =>
        binding.entry === t.capture.terminalEntry && binding.pointer === "/client_event_id",
    );
    if (!terminalReference) throw new Error("missing terminal reference");
    terminalReference.name = "client-event:audio";
    expect(validateLiveTranscript(t)).toEqual(t);
  });
});
