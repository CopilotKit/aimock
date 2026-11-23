import { describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import { validateLiveTranscript } from "../live-fixture.js";
import { sanitizeLiveTranscript } from "../live-sanitize.js";
import type { LiveObject, LiveTranscript } from "../live-types.js";
import {
  identifier,
  replaceIdentifier,
  normalizeCapturedScenario,
  readLiveCase,
  runLiveScenario,
} from "./live-test-support.js";
import { connectWebSocket } from "./ws-test-client.js";

const marker = "harmless-sanitize-marker";
function setup(metadata: LiveObject = {}) {
  const { transcript } = readLiveCase("managed");
  transcript.entries[1].event.metadata = metadata;
  return transcript;
}
function sanitizeMetadata(metadata: LiveObject) {
  return sanitizeLiveTranscript(setup(metadata), [marker]).entries[1].event.metadata;
}
function unsafe(transcript: LiveTranscript) {
  expect(() => sanitizeLiveTranscript(transcript, [marker])).toThrow("unsafe-export");
  try {
    sanitizeLiveTranscript(transcript, [marker]);
  } catch (error) {
    expect(String(error)).not.toContain(marker);
  }
}

describe("retained Live sanitation", () => {
  it("removes credential keys and substitutes markers only in removable metadata", () => {
    expect(
      sanitizeMetadata({
        headers: { AUTHORIZATION: `Bearer ${marker}`, "Sec-WebSocket-Protocol": marker },
        note: `hello ${marker}`,
        [marker]: "hidden",
        safe: { count: 2 },
      }),
    ).toEqual({ headers: {}, note: "hello [REDACTED]", safe: { count: 2 } });
  });
  it("strips URL userinfo and credential query fields, preserving ordinary query data", () => {
    expect(
      sanitizeMetadata({
        url: `https://user:password@example.test/p?api_key=${marker}&keep=yes#access_token=abc`,
      }),
    ).toEqual({ url: "https://example.test/p?keep=yes" });
  });
  it("strips percent-encoded credential fragment names from metadata URLs", () => {
    expect(sanitizeMetadata({ url: "https://example.test/#%74oken=opaque" })).toEqual({
      url: "https://example.test/",
    });
  });
  it("rejects percent-encoded credential fragment names in semantic URLs", () => {
    const transcript = setup();
    transcript.entries[1].event.instructions = "https://example.test/#%74oken=opaque";
    unsafe(transcript);
  });
  it.each(["%68armless-sanitize-marker", "%zz%68armless-sanitize-marker"])(
    "rejects known secrets in percent-encoded URL paths: %s",
    (path) => {
      const url = `https://example.test/${path}`;
      unsafe(setup({ url }));
      const transcript = setup();
      transcript.entries[1].event.instructions = url;
      unsafe(transcript);
    },
  );
  it("preserves clean malformed URL fragments byte-for-byte in semantic fields", () => {
    const transcript = setup();
    transcript.entries[1].event.instructions = "https://example.invalid/#%zz";
    expect(sanitizeLiveTranscript(transcript).entries[1].event.instructions).toBe(
      "https://example.invalid/#%zz",
    );
  });
  it.each([marker, "%68armless-sanitize-marker", "token=opaque"])(
    "rejects secret-bearing malformed semantic URL fragments: %s",
    (fragment) => {
      const transcript = setup();
      transcript.entries[1].event.instructions = `https://example.invalid/#%zz&${fragment}`;
      unsafe(transcript);
    },
  );
  it("removes explicitly described metadata fields without granting semantic deletion", () => {
    const transcript = setup({ vendorCredential: "opaque", keep: true });
    expect(
      sanitizeLiveTranscript(
        transcript,
        [],
        [{ pointer: "/entries/1/event/metadata/vendorCredential" }],
      ).entries[1].event.metadata,
    ).toEqual({ keep: true });
    expect(() =>
      sanitizeLiveTranscript(transcript, [], [{ pointer: "/entries/0/event/session/model" }]),
    ).toThrow("unsafe-export");
  });
  it("preserves original input and safe unknown nested metadata", () => {
    const transcript = setup({ custom: { arr: [null, true, 42, "literal"] } });
    const original = structuredClone(transcript);
    sanitizeLiveTranscript(transcript, [marker]);
    expect(transcript).toEqual(original);
    expect(sanitizeMetadata({ custom: { arr: [null, true, 42, "literal"] } })).toEqual({
      custom: { arr: [null, true, 42, "literal"] },
    });
  });
  it.each(["content", "delta", "audio", "arguments", "instructions"])(
    "rejects secret in semantic %s instead of changing it",
    (field) => {
      const transcript = setup();
      transcript.entries[1].event[field] = marker;
      unsafe(transcript);
    },
  );
  it("does not treat credential-like schema property names as retained credentials", () => {
    const transcript = setup();
    transcript.entries[1].event.custom = {
      tools: [{ parameters: { properties: { api_key: { type: "string" } } } }],
    };
    expect(sanitizeLiveTranscript(transcript).entries[1].event.custom).toEqual(
      transcript.entries[1].event.custom,
    );
  });
  it("rejects a secret in a semantic object key", () => {
    const transcript = setup();
    transcript.entries[1].event.custom = { tools: [{ [marker]: "value" }] };
    unsafe(transcript);
  });
  it("rejects provider errors without exposing their secret text", () => {
    const transcript = setup();
    transcript.entries[2].event = {
      type: "error",
      error: { type: "server_error", code: "failed", message: marker },
    };
    unsafe(transcript);
  });
  it("rejects secret-bearing unknown data instead of silently changing its meaning", () => {
    const transcript = setup();
    transcript.entries[1].event.future = marker;
    unsafe(transcript);
  });
  it("remaps annotated imported and observed IDs bijectively and preserves literal equal strings", () => {
    const transcript = setup();
    const imported = transcript.bindings.find((b) => b.origin === "imported-context");
    expect(imported).toBeDefined();
    if (!imported) throw new Error("reviewed import missing");
    const originalId = identifier(transcript.entries[imported.entry].event, imported.pointer);
    transcript.entries[1].event.metadata = { literal: originalId };
    const result = sanitizeLiveTranscript(transcript);
    const ids = new Map<string, string>();
    for (const binding of result.bindings) {
      const value = identifier(result.entries[binding.entry].event, binding.pointer);
      if (ids.has(binding.name)) expect(value).toBe(ids.get(binding.name));
      else {
        expect([...ids.values()]).not.toContain(value);
        ids.set(binding.name, value);
      }
    }
    expect(identifier(result.entries[imported.entry].event, imported.pointer)).not.toBe(originalId);
    expect(result.entries[1].event.metadata).toEqual({ literal: originalId });
    expect(sanitizeLiveTranscript(transcript)).toEqual(result);
    expect(validateLiveTranscript(result)).toEqual(result);
  });
  it("redacts reviewed provider identity and encrypted-state metadata", () => {
    const transcript = setup();
    const nested = transcript.entries.find(
      (entry) =>
        entry.event.type === "response.event" &&
        typeof entry.event.event === "object" &&
        entry.event.event !== null &&
        !Array.isArray(entry.event.event) &&
        entry.event.event.response,
    );
    if (!nested) throw new Error("reviewed response missing");
    const event = nested.event.event;
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new Error("missing event");
    const response = event.response;
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("missing response");
    response.user = "opaque-provider-user";
    response.prompt_cache_key = "opaque-provider-cache";
    const encrypted = transcript.entries.find((entry) => {
      const nested = entry.event.event;
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) return false;
      const item = nested.item;
      return (
        nested.type === "response.output_item.done" &&
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.type === "reasoning"
      );
    });
    if (!encrypted) throw new Error("reviewed encrypted-state item missing");
    const body = encrypted.event.event;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("missing body");
    const item = body.item;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("missing item");
    item.encrypted_content = "opaque-provider-encrypted";
    expect(() => validateLiveTranscript(transcript)).not.toThrow();
    const result = sanitizeLiveTranscript(transcript);
    expect(JSON.stringify(result).includes("opaque-provider")).toBe(false);
  });
  it("never retains an original ID that collides with its generated ID format", () => {
    const transcript = setup();
    const name = transcript.bindings[0].name;
    for (const binding of transcript.bindings.filter((b) => b.name === name)) {
      replaceIdentifier(transcript.entries[binding.entry].event, binding.pointer, "live-id-1");
    }
    const result = sanitizeLiveTranscript(transcript);
    expect(identifier(result.entries[0].event, result.bindings[0].pointer)).not.toBe("live-id-1");
    expect(validateLiveTranscript(result)).toEqual(result);
  });
  it.each([
    { subtype: "future.custom", itemType: "reasoning" },
    { subtype: "response.output_text.delta", itemType: "future.custom" },
  ])(
    "does not redact similarly named operands in $subtype / $itemType",
    ({ subtype, itemType }) => {
      const transcript = setup();
      const entry = transcript.entries.find((e) => {
        const nested = e.event.event;
        return (
          e.event.type === "response.event" &&
          nested &&
          typeof nested === "object" &&
          !Array.isArray(nested) &&
          nested.type === "response.output_text.delta"
        );
      });
      if (!entry) throw new Error("response event missing");
      const nested = entry.event.event;
      if (!nested || typeof nested !== "object" || Array.isArray(nested))
        throw new Error("nested event missing");
      nested.type = subtype;
      nested.item = { type: itemType, encrypted_content: marker };
      expect(() => validateLiveTranscript(transcript)).not.toThrow();
      unsafe(transcript);
    },
  );
  it("scans unexpected metadata shapes before JSON escaping can obscure a secret", () => {
    const transcript = setup();
    const secret = "harmless-line\nmarker";
    const entry = transcript.entries.find((e) => {
      const nested = e.event.event;
      return (
        nested &&
        typeof nested === "object" &&
        !Array.isArray(nested) &&
        nested.type === "response.completed"
      );
    });
    if (!entry) throw new Error("completed response missing");
    const event = entry.event.event;
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new Error("event missing");
    const response = event.response;
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("response missing");
    response.user = { future: secret };
    expect(() => validateLiveTranscript(transcript)).not.toThrow();
    expect(() => sanitizeLiveTranscript(transcript, [secret])).toThrow("unsafe-export");
  });
  it("honors effective validation bounds without weakening default or invalid-bound rejection", () => {
    const transcript = setup();
    for (const entry of transcript.entries) entry.atMs *= 10;
    expect(() => validateLiveTranscript(transcript, { maxDurationMs: 300000 })).not.toThrow();
    expect(() => sanitizeLiveTranscript(transcript)).toThrow("unsafe-export");
    const result = sanitizeLiveTranscript(transcript, [], [], { maxDurationMs: 300000 });
    expect(result.entries.map((entry) => entry.atMs)).toEqual(
      transcript.entries.map((entry) => entry.atMs),
    );
    expect(() => sanitizeLiveTranscript(transcript, [], [], { maxDurationMs: 1000 })).toThrow(
      "unsafe-export",
    );
    expect(() => sanitizeLiveTranscript(transcript, [], [], { maxDurationMs: NaN })).toThrow(
      "unsafe-export",
    );
  });
  it("rejects malformed inputs and descriptors without reflecting values", () => {
    const transcript = setup();
    transcript.bindings[0].pointer = `/${marker}`;
    unsafe(transcript);
    expect(() =>
      sanitizeLiveTranscript(setup(), [], [{ pointer: "/entries/1/event/metadata/~2" }]),
    ).toThrow("unsafe-export");
  });
  it.each(["client", "managed"] as const)(
    "replays sanitized actual %s projection through the public WebSocket API",
    async (mode) => {
      const { transcript } = readLiveCase(mode);
      const sanitized = sanitizeLiveTranscript(transcript);
      expect(normalizeCapturedScenario(sanitized)).toEqual(
        normalizeCapturedScenario({
          ...transcript,
          bindings: transcript.bindings.map((binding, i) => ({
            ...binding,
            name: sanitized.bindings[i].name,
          })),
        }),
      );
      const mock = new LLMock();
      mock.on(
        { endpoint: "openai-live", model: "gpt-live-1" },
        { live: sanitized, liveTiming: "immediate" },
      );
      await mock.start();
      try {
        const ws = await connectWebSocket(mock.url, "/v1/live/sessions");
        const result = await runLiveScenario(ws, sanitized, { clientIdPrefix: "sanitized-client" });
        expect(result.normalized).toEqual(normalizeCapturedScenario(sanitized));
      } finally {
        await mock.stop();
      }
    },
    60000,
  );
});
