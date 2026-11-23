/**
 * Cohere drift tests.
 *
 * Three-way comparison: expected shape x real API x aimock output.
 * Covers /v2/chat non-streaming and streaming endpoints.
 *
 * Requires: COHERE_API_KEY
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { CohereClientV2, CohereError, type Cohere } from "cohere-ai";
import { withFaultFixture } from "../helpers/misbehavior-server.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import {
  extractShape,
  triangulate,
  compareSSESequences,
  formatDriftReport,
  type SSEEventShape,
} from "./schema.js";
import { httpPost, httpPostRaw, startDriftServer, stopDriftServer } from "./helpers.js";
import {
  COHERE_BASE_URL,
  COHERE_K5_NO_GENERATION,
  COHERE_SHAPE_LEG_NO_GENERATION,
  cohereNoGenerationError,
  cohereNoGenerationSkipReason,
  isCohereNoGenerationStreamEnd,
  isInfraStatus,
  selectCohereChatModel,
  type CohereModelEntry,
} from "./cohere-model.js";

// ---------------------------------------------------------------------------
// Credentials check
// ---------------------------------------------------------------------------

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const HAS_CREDENTIALS = !!COHERE_API_KEY;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// SDK shape stubs
// ---------------------------------------------------------------------------

/**
 * Minimal Cohere /v2/chat response shape (non-streaming).
 */
function cohereChatResponseShape() {
  return extractShape({
    id: "chat-abc123",
    finish_reason: "COMPLETE",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
    },
    usage: {
      billed_units: {
        input_tokens: 10,
        output_tokens: 5,
      },
      tokens: {
        input_tokens: 10,
        output_tokens: 5,
      },
    },
  });
}

/**
 * Minimal Cohere /v2/chat streaming event shapes, one per text-stream event type.
 */
function cohereChatStreamEventShapes(): SSEEventShape[] {
  const events: { type: string; data: object }[] = [
    {
      type: "message-start",
      data: {
        id: "chat-abc123",
        type: "message-start",
        delta: {
          message: { role: "assistant", content: [], tool_plan: "", tool_calls: [], citations: [] },
        },
      },
    },
    {
      type: "content-start",
      data: {
        type: "content-start",
        index: 0,
        delta: { message: { content: { type: "text" } } },
      },
    },
    {
      type: "content-delta",
      data: {
        type: "content-delta",
        index: 0,
        delta: { message: { content: { text: "Hel" } } },
      },
    },
    { type: "content-end", data: { type: "content-end", index: 0 } },
    {
      type: "message-end",
      data: {
        type: "message-end",
        delta: {
          finish_reason: "COMPLETE",
          usage: {
            billed_units: { input_tokens: 10, output_tokens: 5 },
            tokens: { input_tokens: 10, output_tokens: 5 },
          },
        },
      },
    },
  ];
  return events.map((e) => ({ type: e.type, dataShape: extractShape(e.data) }));
}

/**
 * Parse a Cohere v2 SSE body by the SSE spec (WHATWG event-stream): lines end
 * in `\n`, `\r\n` or `\r`; a blank line dispatches the event; `:` lines are
 * comments; one space after the field colon is optional; `id`/`retry` and
 * unknown fields are ignored; multiple `data` lines join with `\n`; a final
 * event without a blank line is still dispatched. A `data: [DONE]` sentinel
 * with no event name ends the stream and is dropped.
 *
 * Still strict on content: each event's data must be a JSON object whose
 * `type` equals the event name (an event without `event:` is named `message`
 * by the spec, so it fails that check), and nothing may follow `[DONE]`.
 */
function parseCohereSSE(body: string): { type: string; data: Record<string, unknown> }[] {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  let eventName = "";
  let dataLines: string[] = [];
  let done = false;

  const dispatch = () => {
    const name = eventName || "message";
    const hadData = dataLines.length > 0;
    const raw = dataLines.join("\n");
    eventName = "";
    dataLines = [];
    if (!hadData) return;
    if (done) throw new Error(`Cohere SSE event after [DONE]: ${JSON.stringify(raw)}`);
    if (name === "message" && raw === "[DONE]") {
      done = true;
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Cohere SSE data is not JSON: ${JSON.stringify(raw)}`);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Cohere SSE data is not an object: ${JSON.stringify(raw)}`);
    }
    const record = data as Record<string, unknown>;
    if (record.type !== name) {
      throw new Error(`Cohere SSE event name ${name} != data.type ${String(record.type)}`);
    }
    events.push({ type: name, data: record });
  };

  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // id, retry and unknown fields are ignored per the SSE spec.
  }
  dispatch();
  return events;
}

// ---------------------------------------------------------------------------
// Real API helpers
// ---------------------------------------------------------------------------

/** Skip reason for an infra status, citing the response id when the body has one. */
function cohereInfraSkipReason(status: number, body: string): string {
  let id: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      id = (parsed as Record<string, unknown>).id;
  } catch {
    id = undefined;
  }
  return `Cohere /v2/chat returned infra status ${status}${typeof id === "string" ? ` id=${id}` : ""}`;
}

async function cohereChatNonStreaming(
  model: string,
  messages: { role: string; content: string }[],
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${COHERE_BASE_URL}/v2/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      max_tokens: 10,
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function cohereChatStreaming(
  model: string,
  messages: { role: string; content: string }[],
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${COHERE_BASE_URL}/v2/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: 10,
    }),
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Live chat-model resolution
// ---------------------------------------------------------------------------

/**
 * Outcome of resolving a live Cohere chat model:
 *   - { model }        → a valid, non-deprecated chat model to drive the leg
 *   - { infra }        → the listing call hit an auth/credit/rate-limit/5xx
 *                        condition; the caller SKIPS honestly (not drift)
 *   - { unavailable }  → the listing succeeded but exposed no usable chat
 *                        model (genuinely broken state — fail loud)
 */
type ResolvedModel = { model: string } | { infra: number } | { unavailable: true };

let cohereChatModelPromise: Promise<ResolvedModel> | null = null;

/**
 * Discover a currently-valid chat model from Cohere's own model listing rather
 * than hardcoding one. Cohere retires model IDs on a schedule (command-r-plus
 * was removed 2026-04-04, which is what quarantined this leg), so the listing
 * is the only drift-resilient source of a live model name.
 */
async function resolveCohereChatModel(): Promise<ResolvedModel> {
  const res = await fetch(`${COHERE_BASE_URL}/v1/models?endpoint=chat&page_size=1000`, {
    headers: { Authorization: `Bearer ${COHERE_API_KEY}` },
  });
  if (isInfraStatus(res.status)) return { infra: res.status };
  if (!res.ok) return { unavailable: true };
  const json = (await res.json()) as { models?: CohereModelEntry[] };
  const model = selectCohereChatModel(json.models ?? []);
  return model ? { model } : { unavailable: true };
}

/** Memoized so the whole live leg makes exactly one model-listing call. */
function getCohereChatModel(): Promise<ResolvedModel> {
  if (!cohereChatModelPromise) cohereChatModelPromise = resolveCohereChatModel();
  return cohereChatModelPromise;
}

// ---------------------------------------------------------------------------
// Error shape stubs
// ---------------------------------------------------------------------------

/**
 * Cohere error envelope shape returned by aimock for validation errors
 * and no-fixture-match scenarios.
 */
function cohereErrorShape() {
  return extractShape({
    error: {
      message: "Some error message",
      type: "invalid_request_error",
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cohere error shapes", () => {
  it("malformed JSON returns 400 with error envelope", async () => {
    const res = await httpPostRaw(`${instance.url}/v2/chat`, "{not valid json");

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body);
    const sdkShape = cohereErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Cohere /v2/chat malformed JSON error", diffs, "cohere-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("missing model field returns 400 with error envelope", async () => {
    const res = await httpPost(`${instance.url}/v2/chat`, {
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body);
    const sdkShape = cohereErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Cohere /v2/chat missing model error", diffs, "cohere-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("missing messages array returns 400 with error envelope", async () => {
    const res = await httpPost(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
    });

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body);
    const sdkShape = cohereErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "Cohere /v2/chat missing messages error",
      diffs,
      "cohere-chat",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("no fixture match returns 404 with error envelope", async () => {
    const res = await httpPost(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "this will not match any fixture" }],
    });

    expect(res.status).toBe(404);

    const body = JSON.parse(res.body);
    const sdkShape = cohereErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "Cohere /v2/chat no fixture match error",
      diffs,
      "cohere-chat",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

describe.skipIf(!HAS_CREDENTIALS)("Cohere drift", () => {
  it("non-streaming /v2/chat shape matches", async (ctx) => {
    const resolved = await getCohereChatModel();
    if ("infra" in resolved) {
      // Provider-side auth/credit/rate-limit/5xx — honest skip, not drift.
      ctx.skip(`Cohere model listing returned infra status ${resolved.infra}`);
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error(
        "Cohere /v1/models?endpoint=chat exposed no usable non-deprecated chat model",
      );
    }
    const model = resolved.model;

    const sdkShape = cohereChatResponseShape();
    const messages = [{ role: "user", content: "Say hello" }];

    const [realRes, mockRes] = await Promise.all([
      cohereChatNonStreaming(model, messages),
      httpPost(`${instance.url}/v2/chat`, {
        model,
        messages,
        stream: false,
      }),
    ]);

    if (isInfraStatus(realRes.status)) {
      // Real API hit a transient provider-side condition — honest skip.
      ctx.skip(cohereInfraSkipReason(realRes.status, realRes.body));
      return;
    }
    // This request sends no tools, so only NO_VALID_RESPONSE_GENERATED applies.
    const noGeneration = cohereNoGenerationError(
      realRes.status,
      realRes.body,
      COHERE_SHAPE_LEG_NO_GENERATION,
    );
    if (noGeneration) {
      // Upstream generated nothing (exact 422 no-generation envelope). There is
      // no success envelope to compare, so this send is an honest skip.
      ctx.skip(cohereNoGenerationSkipReason([noGeneration]));
      return;
    }

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      const realShape = extractShape(JSON.parse(realRes.body));
      const mockShape = extractShape(JSON.parse(mockRes.body));

      const diffs = triangulate(sdkShape, realShape, mockShape);
      const report = formatDriftReport("Cohere /v2/chat (non-streaming)", diffs, "cohere-chat");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });

  it("streaming /v2/chat shape matches", async (ctx) => {
    const resolved = await getCohereChatModel();
    if ("infra" in resolved) {
      // Provider-side auth/credit/rate-limit/5xx — honest skip, not drift.
      ctx.skip(`Cohere model listing returned infra status ${resolved.infra}`);
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error(
        "Cohere /v1/models?endpoint=chat exposed no usable non-deprecated chat model",
      );
    }
    const model = resolved.model;

    const messages = [{ role: "user", content: "Say hello" }];

    const [realRes, mockRes] = await Promise.all([
      cohereChatStreaming(model, messages),
      httpPost(`${instance.url}/v2/chat`, {
        model,
        messages,
        stream: true,
      }),
    ]);

    if (isInfraStatus(realRes.status)) {
      // Real API hit a transient provider-side condition — honest skip.
      ctx.skip(cohereInfraSkipReason(realRes.status, realRes.body));
      return;
    }
    // This request sends no tools, so only NO_VALID_RESPONSE_GENERATED applies.
    const noGeneration = cohereNoGenerationError(
      realRes.status,
      realRes.body,
      COHERE_SHAPE_LEG_NO_GENERATION,
    );
    if (noGeneration) {
      // Upstream generated nothing (exact 422 no-generation envelope). There is
      // no success envelope to compare, so this send is an honest skip.
      ctx.skip(cohereNoGenerationSkipReason([noGeneration]));
      return;
    }

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBe(200);

    const realEvents = parseCohereSSE(realRes.body);
    const mockEvents = parseCohereSSE(mockRes.body);
    expect(realEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const realEnd = realEvents.at(-1);
    if (
      realEnd?.type === "message-end" &&
      isCohereNoGenerationStreamEnd(
        cohereRecord(realEnd.data.delta),
        COHERE_SHAPE_LEG_NO_GENERATION,
      )
    ) {
      // Upstream generated nothing: a 200 stream whose message-end is
      // finish_reason ERROR with empty usage. No success terminal to compare.
      expect(
        realEvents.some((e) => e.type === "content-start"),
        "content before no-generation terminal",
      ).toBe(false);
      ctx.skip(
        cohereNoGenerationSkipReason([
          { errorType: "NO_VALID_RESPONSE_GENERATED", id: cohereString(realEvents[0].data.id) },
        ]),
      );
      return;
    }

    for (const [side, events] of [
      ["real", realEvents],
      ["mock", mockEvents],
    ] as const) {
      expect(events[0].type, `${side} stream must open with message-start`).toBe("message-start");
      expect(events.at(-1)?.type, `${side} stream must close with message-end`).toBe("message-end");
    }

    const diffs = compareSSESequences(
      cohereChatStreamEventShapes(),
      realEvents.map((e) => ({ type: e.type, dataShape: extractShape(e.data) })),
      mockEvents.map((e) => ({ type: e.type, dataShape: extractShape(e.data) })),
    );
    const report = formatDriftReport("Cohere /v2/chat (streaming events)", diffs, "cohere-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

describe("parseCohereSSE", () => {
  it("parses recorded live event: + data: frames and drops the [DONE] sentinel", async () => {
    const body = (
      await readFile(new URL("./fixtures/cohere-k5-stream.sse", import.meta.url))
    ).toString();
    const events = parseCohereSSE(body);
    expect(events.length).toBeGreaterThan(2);
    expect(events[0].type).toBe("message-start");
    expect(events.at(-1)?.type).toBe("message-end");
    for (const e of events) expect(e.data.type).toBe(e.type);
  });

  it("parses aimock's stream as a non-empty event list", async () => {
    const res = await httpPost(`${instance.url}/v2/chat`, {
      model: "command-a-03-2025",
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = parseCohereSSE(res.body);
    expect(events.map((e) => e.type)).toEqual([
      "message-start",
      "content-start",
      "content-delta",
      "content-end",
      "message-end",
    ]);
  });

  it("accepts legal SSE variants a server or proxy may send", () => {
    const start = '{"type":"message-start","id":"x"}';
    const end = '{"type":"message-end","delta":{}}';
    const expected = ["message-start", "message-end"];
    const variants: Record<string, string> = {
      canonical: `event: message-start\ndata: ${start}\n\nevent: message-end\ndata: ${end}\n\ndata: [DONE]\n\n`,
      "single trailing newline": `event: message-start\ndata: ${start}\n\nevent: message-end\ndata: ${end}\n`,
      "no trailing newline": `event: message-start\ndata: ${start}\n\nevent: message-end\ndata: ${end}`,
      "no space after colon": `event:message-start\ndata:${start}\n\nevent:message-end\ndata:${end}\n\n`,
      "keepalive comments": `: ping\n\nevent: message-start\n:mid-frame comment\ndata: ${start}\n\n:\n\nevent: message-end\ndata: ${end}\n\n`,
      "id and retry fields": `retry: 3000\n\nid: 1\nevent: message-start\ndata: ${start}\n\nid: 2\nevent: message-end\nretry: 10\ndata: ${end}\n\n`,
      CRLF: `event: message-start\r\ndata: ${start}\r\n\r\nevent: message-end\r\ndata: ${end}\r\n\r\ndata: [DONE]\r\n\r\n`,
      CR: `event: message-start\rdata: ${start}\r\revent: message-end\rdata: ${end}\r\r`,
      "multi-line data": `event: message-start\ndata: {"type":\ndata: "message-start"}\n\nevent: message-end\ndata: ${end}\n\n`,
    };
    for (const [name, body] of Object.entries(variants)) {
      expect(
        parseCohereSSE(body).map((e) => e.type),
        name,
      ).toEqual(expected);
    }
  });

  it("rejects malformed data, mismatched names and events after [DONE]", () => {
    expect(() => parseCohereSSE("event: message-start\ndata: {not json\n\n")).toThrow(/not JSON/);
    expect(() => parseCohereSSE("event: content-end\ndata: [1]\n\n")).toThrow(/not an object/);
    expect(() => parseCohereSSE("event: content-end\ndata: null\n\n")).toThrow(/not an object/);
    expect(() => parseCohereSSE('event: content-end\ndata: {"type":"content-start"}\n\n')).toThrow(
      /event name/,
    );
    // No event: line -> the spec names it "message", which never matches data.type.
    expect(() => parseCohereSSE('data: {"type":"message-start"}\n\n')).toThrow(/event name/);
    expect(() =>
      parseCohereSSE('data: [DONE]\n\nevent: content-end\ndata: {"type":"content-end"}\n\n'),
    ).toThrow(/after \[DONE\]/);
  });
});

// Local SDK and retained capture checks are independent of native credentials.
type CohereWireObservation = {
  requestBody: string | undefined;
  status: number;
  contentType: string | null;
  bytes: number[];
  complete: boolean;
};

function observeCohereFetch(
  wire: CohereWireObservation[],
  { maxBytes = 262144, timeoutMs = 5000 } = {},
): typeof fetch {
  return async (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const response = await fetch(input, { ...init, signal });
    const observation: CohereWireObservation = {
      requestBody: typeof init?.body === "string" ? init.body : undefined,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: [],
      complete: false,
    };
    wire.push(observation);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Cohere response has no body");
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (observation.bytes.length + value.length > maxBytes) {
          throw new Error("Cohere response exceeds byte ceiling");
        }
        for (const byte of value) observation.bytes.push(byte);
      }
      // Reject malformed UTF-8 before the SDK performs permissive decoding.
      const bytes = Uint8Array.from(observation.bytes);
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      observation.complete = true;
      // The SDK receives exactly the captured bytes, never reserialized JSON/SSE.
      return new Response(bytes, { status: response.status, headers: response.headers });
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  };
}

for (const cell of [
  { name: "object quarter", stream: false, at: 0.25 },
  { name: "stream quarter", stream: true, at: 0.25 },
  { name: "stream half", stream: true, at: 0.5 },
  { name: "stream three-quarters", stream: true, at: 0.75 },
]) {
  it(`P1 Cohere K5 local ${cell.name}`, async () => {
    await withFaultFixture(
      { faults: [{ fault: "stop-length-mid-tool", at: cell.at }] },
      async ({ mock, url }) => {
        const wire: CohereWireObservation[] = [];
        const client = new CohereClientV2({
          token: "local",
          baseUrl: url,
          maxRetries: 0,
          timeoutInSeconds: 5,
          fetch: observeCohereFetch(wire),
        });
        const request = {
          model: "command-r-plus",
          messages: [{ role: "user", content: "weather" }],
        } satisfies Cohere.V2ChatRequest;
        const events: Cohere.V2ChatStreamResponse[] = [];
        let object: Cohere.V2ChatResponse | undefined;
        let args = "";
        let finish: string | undefined;
        try {
          if (cell.stream) {
            for await (const event of await client.chatStream(request)) {
              events.push(event);
              if (event.type === "tool-call-delta")
                args += event.delta?.message?.toolCalls?.function?.arguments ?? "";
              if (event.type === "message-end") finish = event.delta?.finishReason;
            }
          } else {
            object = await client.chat(request);
            args = object.message.toolCalls?.[0].function?.arguments ?? "";
            finish = object.finishReason;
          }
        } finally {
          const proofDirectory = process.env.AIMOCK_COHERE_K5_PROOF_DIR;
          if (proofDirectory)
            await writeFile(
              join(proofDirectory, `${cell.name.replaceAll(" ", "-")}.json`),
              JSON.stringify(
                { cell, request, wire, object, events, args, finish, journal: mock.getRequests() },
                null,
                2,
              ),
            );
        }
        expect(wire).toHaveLength(1);
        expect(wire[0].status).toBe(200);
        expect(wire[0].complete).toBe(true);
        expect(wire[0].contentType).toContain(
          cell.stream ? "text/event-stream" : "application/json",
        );
        expect(args).toBe(
          '{"city":"Paris"}'.slice(0, Math.floor('{"city":"Paris"}'.length * cell.at)),
        );
        expect(finish).toBe(cell.stream ? "TOOL_CALL" : "MAX_TOKENS");
        expect(
          compareCohereK5(wire[0], cell.stream, cell.stream ? events : object, "weather")
            .classification,
        ).toBe("TARGET");
        expect(mock.getRequests()).toHaveLength(1);
        expect(mock.getLastRequest()?.response.misbehavior?.applied).toBe(true);
      },
    );
  }, 55000);
}

it("P1 Cohere K5 local rejects actual HTTP error without retry", async () => {
  await withFaultFixture(undefined, async ({ url }) => {
    const wire: CohereWireObservation[] = [];
    const client = new CohereClientV2({
      token: "local",
      baseUrl: url,
      maxRetries: 0,
      timeoutInSeconds: 5,
      fetch: observeCohereFetch(wire),
    });
    await expect(
      client.chat({
        model: "command-r-plus",
        messages: [{ role: "user", content: "no matching fixture" }],
      }),
    ).rejects.toThrow();
    expect(wire).toHaveLength(1);
    expect(wire[0].status).toBe(404);
    expect(wire[0].complete).toBe(true);
  });
}, 55000);

it("P1 Cohere K5 local enforces byte ceiling on actual aimock body", async () => {
  await withFaultFixture(undefined, async ({ url }) => {
    const wire: CohereWireObservation[] = [];
    const client = new CohereClientV2({
      token: "local",
      baseUrl: url,
      maxRetries: 0,
      timeoutInSeconds: 5,
      fetch: observeCohereFetch(wire, { maxBytes: 1 }),
    });
    await expect(
      client.chat({ model: "command-r-plus", messages: [{ role: "user", content: "weather" }] }),
    ).rejects.toThrow("byte ceiling");
    expect(wire).toHaveLength(1);
    expect(wire[0].status).toBe(200);
    expect(wire[0].complete).toBe(false);
    expect(wire[0].bytes.length).toBeLessThanOrEqual(1);
  });
}, 55000);

it("P1 Cohere K5 local deadline aborts an actual stalled HTTP body", async () => {
  // Transport-only control: an incomplete body over loopback, not a fake LLM reply.
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: ");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local server address");
    const wire: CohereWireObservation[] = [];
    await expect(
      observeCohereFetch(wire, { timeoutMs: 100 })(`http://127.0.0.1:${address.port}`),
    ).rejects.toThrow();
    expect(wire).toHaveLength(1);
    expect(wire[0].bytes).toEqual([...Buffer.from("data: ")]);
    expect(wire[0].complete).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 55000);

const capturedCohere = [
  {
    stream: false,
    file: "cohere-k5-object.raw",
    hash: "83cee73384208d8aa4d2b278d84aec0e4a19513d1c1751f07db718c587fb24f7",
  },
  {
    stream: true,
    file: "cohere-k5-stream.sse",
    hash: "acd3032d46feaec7b6436a563a5d989927c356ab546861341dffd999c5641c38",
  },
];

async function decodeCohereCapture(bytes: Uint8Array, stream: boolean) {
  // Replay genuine retained provider bytes over loopback through the installed SDK.
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const wire: CohereWireObservation[] = [];
    const client = new CohereClientV2({
      token: "local",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
      timeoutInSeconds: 5,
      fetch: observeCohereFetch(wire),
    });
    const request = {
      model: "command-a-03-2025",
      messages: [{ role: "user" as const, content: "weather" }],
    };
    const events: Cohere.V2ChatStreamResponse[] = [];
    const object = stream ? undefined : await client.chat(request);
    if (stream) for await (const event of await client.chatStream(request)) events.push(event);
    expect(wire).toHaveLength(1);
    expect(wire[0].bytes).toEqual([...bytes]);
    return { wire: wire[0], object, events };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it.each(capturedCohere)("P1 Cohere genuine captured contract $file", async (capture) => {
  const bytes = await readFile(new URL(`./fixtures/${capture.file}`, import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(capture.hash);
  const decoded = await decodeCohereCapture(bytes, capture.stream);
  const proofDirectory = process.env.AIMOCK_COHERE_K5_PROOF_DIR;
  if (proofDirectory)
    await writeFile(
      join(proofDirectory, `${capture.file}.decoded.json`),
      JSON.stringify(decoded, null, 2),
    );
  expect(
    compareCohereK5(
      decoded.wire,
      capture.stream,
      capture.stream ? decoded.events : decoded.object,
      "record_numbers",
    ).classification,
  ).toBe(capture.stream ? "TARGET" : "NOT_TRIGGERED");
});

function cohereRecord(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "expected object");
  return value as Record<string, unknown>;
}
function cohereString(value: unknown): string {
  assert.equal(typeof value, "string", "expected string");
  return value as string;
}
function cohereUsage(value: unknown) {
  const usage = cohereRecord(value);
  for (const key of ["tokens", "billed_units"]) {
    const units = cohereRecord(usage[key]);
    for (const name of ["input_tokens", "output_tokens"]) {
      const count = units[name];
      assert(typeof count === "number" && Number.isFinite(count) && count >= 0, "invalid usage");
    }
  }
  if (usage.cached_tokens !== undefined)
    assert(
      typeof usage.cached_tokens === "number" &&
        Number.isFinite(usage.cached_tokens) &&
        usage.cached_tokens >= 0,
      "invalid cached usage",
    );
  return usage;
}
function cohereCall(value: unknown) {
  const call = cohereRecord(value);
  assert.equal(call.type, "function");
  const fn = cohereRecord(call.function);
  const id = cohereString(call.id);
  const name = cohereString(fn.name);
  assert(id.length > 0 && name.length > 0, "empty tool identity");
  return { id, name, arguments: cohereString(fn.arguments) };
}
function cohereContent(value: unknown) {
  assert(Array.isArray(value), "invalid content");
  return value
    .map((entry) => {
      const block = cohereRecord(entry);
      assert.equal(block.type, "text");
      return cohereString(block.text);
    })
    .join("");
}
// SDK recursively camel-cases documented wire fields. Normalize field names only;
// strings (including incomplete arguments), arrays and values remain untouched.
function cohereFieldNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cohereFieldNames);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key.replaceAll("_", "").toLowerCase(), cohereFieldNames(item)]),
    );
  return value;
}

interface CohereK5Options {
  /**
   * Live Cohere leg only: accept the exact upstream no-generation outcomes
   * (a 422 NO_TOOL_CALL_OR_RESPONSE_GENERATED envelope on either send, or a
   * stream whose message-end is finish_reason ERROR with empty usage) as
   * UPSTREAM_NO_GENERATION. The aimock and replay legs leave it off and stay strict.
   */
  live?: boolean;
}

function readCohereK5(
  wire: CohereWireObservation,
  stream: boolean,
  expectedTool: string,
  options: CohereK5Options = {},
) {
  if (options.live && wire.status === 422) {
    // A 422 is a JSON envelope whichever send (object or stream) it answers.
    assert.equal(wire.complete, true, "incomplete response");
    assert(/^application\/json(?:;|$)/i.test(wire.contentType ?? ""), "wrong content type");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(wire.bytes));
    // The K5 request sends a REQUIRED tool, so only the tool-request code applies.
    const upstream = cohereNoGenerationError(wire.status, text, COHERE_K5_NO_GENERATION);
    assert(upstream, "HTTP failure");
    return {
      classification: "UPSTREAM_NO_GENERATION" as const,
      finish: "ERROR",
      calls: [] as ReturnType<typeof cohereCall>[],
      usage: {} as Record<string, unknown>,
      raw: JSON.parse(text) as unknown,
      upstream,
    };
  }
  assert.equal(wire.status, 200, "HTTP failure");
  assert.equal(wire.complete, true, "incomplete response");
  assert(wire.bytes.length > 0 && wire.bytes.length <= 262144, "invalid body size");
  assert(
    (stream ? /^text\/event-stream(?:;|$)/i : /^application\/json(?:;|$)/i).test(
      wire.contentType ?? "",
    ),
    "wrong content type",
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(wire.bytes));
  const calls: ReturnType<typeof cohereCall>[] = [];
  const argumentDeltaCounts: number[] = [];
  let finish: string;
  let usage: Record<string, unknown>;
  let raw: unknown;
  if (!stream) {
    const body = cohereRecord(JSON.parse(text));
    assert.equal(body.error, undefined, "API error envelope");
    assert(cohereString(body.id).length > 0, "empty response id");
    const message = cohereRecord(body.message);
    assert.equal(message.role, "assistant");
    const content = message.content === undefined ? "" : cohereContent(message.content);
    if (message.tool_plan !== undefined) cohereString(message.tool_plan);
    if (message.citations !== undefined) {
      assert(Array.isArray(message.citations), "invalid citations");
      assert.equal(message.citations.length, 0, "unexpected citations for tool request");
    }
    if (message.tool_calls !== undefined) {
      assert(Array.isArray(message.tool_calls), "invalid tools");
      calls.push(...message.tool_calls.map(cohereCall));
    }
    assert(calls.length > 0 || content.length > 0, "missing message output");
    finish = cohereString(body.finish_reason);
    usage = cohereUsage(body.usage);
    raw = body;
    assert(finish !== "TOOL_CALL" || calls.length > 0, "tool terminal without tool");
    assert(
      calls.length === 0 || ["TOOL_CALL", "MAX_TOKENS"].includes(finish),
      "contradictory tool terminal",
    );
  } else {
    const normalized = text.replaceAll("\r\n", "\n");
    assert(!normalized.includes("\r") && normalized.endsWith("\n\n"), "incomplete SSE framing");
    const frames = normalized.split("\n\n");
    assert.equal(frames.pop(), "");
    assert.equal(frames.pop(), "data: [DONE]", "missing terminal sentinel");
    const events = frames.map((frame) => {
      const lines = frame.split("\n");
      assert.equal(lines.length, 2, "unsupported SSE frame");
      assert(lines[1].startsWith("data: "), "missing SSE data");
      const event = cohereRecord(JSON.parse(lines[1].slice(6)));
      assert.equal(lines[0], `event: ${event.type}`, "SSE event name mismatch");
      return event;
    });
    assert(events.length >= 2, "missing lifecycle");
    assert.equal(events[0].type, "message-start");
    assert.equal(events.at(-1)?.type, "message-end");
    let activeTool: number | undefined;
    let activeContent: number | undefined;
    let contentCount = 0;
    let ended = false;
    for (const [position, event] of events.entries()) {
      assert(!ended, "event after terminal");
      switch (event.type) {
        case "message-start": {
          assert.equal(position, 0, "duplicate message start");
          assert(cohereString(event.id).length > 0, "empty response id");
          assert.equal(cohereRecord(cohereRecord(event.delta).message).role, "assistant");
          break;
        }
        case "tool-plan-delta":
          assert.equal(calls.length, 0, "tool plan after tool");
          cohereString(cohereRecord(cohereRecord(event.delta).message).tool_plan);
          break;
        case "content-start": {
          assert.equal(calls.length, 0, "content after tool");
          assert.equal(activeContent, undefined, "overlapping content");
          assert.equal(event.index, contentCount++, "invalid content index");
          activeContent = event.index as number;
          const content = cohereRecord(cohereRecord(cohereRecord(event.delta).message).content);
          assert.equal(content.type, "text");
          if (content.text !== undefined) cohereString(content.text);
          break;
        }
        case "content-delta":
          assert(
            activeContent !== undefined && event.index === activeContent,
            "content delta outside block",
          );
          cohereString(cohereRecord(cohereRecord(cohereRecord(event.delta).message).content).text);
          break;
        case "content-end":
          assert(
            activeContent !== undefined && event.index === activeContent,
            "content closure outside block",
          );
          activeContent = undefined;
          break;
        case "tool-call-start":
          assert.equal(activeContent, undefined, "unclosed content");
          assert.equal(activeTool, undefined, "overlapping tool");
          assert.equal(event.index, calls.length, "invalid tool index");
          activeTool = calls.length;
          calls.push(cohereCall(cohereRecord(cohereRecord(event.delta).message).tool_calls));
          assert.equal(calls[activeTool].arguments, "", "tool opener arguments must be empty");
          argumentDeltaCounts.push(0);
          break;
        case "tool-call-delta": {
          assert(
            activeTool !== undefined && event.index === activeTool,
            "tool delta outside block",
          );
          const fn = cohereRecord(
            cohereRecord(cohereRecord(cohereRecord(event.delta).message).tool_calls).function,
          );
          calls[activeTool].arguments += cohereString(fn.arguments);
          argumentDeltaCounts[activeTool]++;
          break;
        }
        case "tool-call-end":
          assert(
            activeTool !== undefined && event.index === activeTool,
            "tool closure outside block",
          );
          activeTool = undefined;
          break;
        case "message-end":
          assert.equal(activeContent, undefined, "unclosed content");
          assert.equal(activeTool, undefined, "unclosed tool");
          assert.equal(position, events.length - 1, "early terminal");
          ended = true;
          break;
        default:
          assert.fail("unsupported event schema");
      }
    }
    const delta = cohereRecord(events.at(-1)?.delta);
    if (options.live && isCohereNoGenerationStreamEnd(delta, COHERE_K5_NO_GENERATION)) {
      assert.equal(calls.length, 0, "tool before no-generation terminal");
      assert.equal(contentCount, 0, "content before no-generation terminal");
      return {
        classification: "UPSTREAM_NO_GENERATION" as const,
        finish: "ERROR",
        calls,
        usage: {} as Record<string, unknown>,
        raw: events as unknown,
        upstream: {
          errorType: "NO_TOOL_CALL_OR_RESPONSE_GENERATED" as const,
          id: cohereString(events[0].id),
        },
      };
    }
    finish = cohereString(delta.finish_reason);
    usage = cohereUsage(delta.usage);
    raw = events;
  }
  assert(
    ["COMPLETE", "STOP_SEQUENCE", "MAX_TOKENS", "TOOL_CALL"].includes(finish),
    "failed or unknown terminal",
  );
  assert(
    calls.every((call) => call.name === expectedTool),
    "unexpected tool",
  );
  assert.equal(new Set(calls.map((call) => call.id)).size, calls.length, "duplicate tool id");
  const cuts = calls.filter((call) => {
    assert(call.arguments.length > 0, "empty tool arguments");
    let value: unknown;
    try {
      value = JSON.parse(call.arguments);
    } catch {
      return true;
    }
    const args = cohereRecord(value);
    cohereString(args[expectedTool === "record_numbers" ? "payload" : "city"]);
    return false;
  });
  assert(finish !== "TOOL_CALL" || calls.length > 0, "tool terminal without tool");
  assert(cuts.length <= 1, "multiple cut tools");
  if (cuts.length) {
    assert.equal(calls.at(-1), cuts[0], "tool after cut");
    if (stream)
      assert(argumentDeltaCounts[calls.indexOf(cuts[0])] > 0, "cut tool requires argument deltas");
    assert.equal(finish, stream ? "TOOL_CALL" : "MAX_TOKENS", "wrong cut terminal");
  }
  return {
    classification: cuts.length === 1 ? ("TARGET" as const) : ("NOT_TRIGGERED" as const),
    finish,
    calls,
    usage,
    raw,
    upstream: undefined,
  };
}
function compareCohereK5(
  wire: CohereWireObservation,
  stream: boolean,
  sdk: unknown,
  expectedTool: string,
  options: CohereK5Options = {},
) {
  const parsed = readCohereK5(wire, stream, expectedTool, options);
  assert.deepEqual(cohereFieldNames(sdk), cohereFieldNames(parsed.raw), "raw/SDK disagreement");
  if (stream && parsed.classification !== "UPSTREAM_NO_GENERATION")
    assert.equal(parsed.classification, "TARGET", "stream K5 did not trigger");
  return parsed;
}

const cohereK5Request = {
  model: "command-a-03-2025",
  messages: [
    {
      role: "user",
      content:
        "Use record_numbers now. Set payload to the first 2000 positive integers in ascending order, separated by commas. Do not abbreviate or omit any integer.",
    },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "record_numbers",
        description: "Record the full comma-separated integer sequence.",
        parameters: {
          type: "object",
          properties: { payload: { type: "string" } },
          required: ["payload"],
        },
      },
    },
  ],
  toolChoice: "REQUIRED",
  maxTokens: 128,
  temperature: 0,
} satisfies Cohere.V2ChatRequest;

// One ordered invocation: ordinary object nontrigger does not suppress stream;
// a transport/schema/API error rejects immediately. The outer drift collector
// can retry its entire run up to 3 times (scripts/drift-retry.ts), so this
// two-send/256-token bound is per invocation, not the whole daily budget.
async function runCohereK5Modes(baseUrl: string, token: string, options: CohereK5Options = {}) {
  const results = [];
  let attempts = 0;
  for (const stream of [false, true]) {
    const wire: CohereWireObservation[] = [];
    const observe = observeCohereFetch(wire, { timeoutMs: 45000 });
    const client = new CohereClientV2({
      token,
      baseUrl,
      maxRetries: 0,
      timeoutInSeconds: 45,
      fetch: async (input, init) => {
        assert(attempts < 2, "Cohere K5 send budget exhausted");
        attempts++;
        return observe(input, init);
      },
    });
    const events: Cohere.V2ChatStreamResponse[] = [];
    let object: Cohere.V2ChatResponse | undefined;
    try {
      if (!stream)
        object = await client.chat(cohereK5Request, {
          maxRetries: 0,
          timeoutInSeconds: 45,
          abortSignal: AbortSignal.timeout(45000),
        });
      else
        for await (const event of await client.chatStream(cohereK5Request, {
          maxRetries: 0,
          timeoutInSeconds: 45,
          abortSignal: AbortSignal.timeout(45000),
        }))
          events.push(event);
    } catch (error) {
      // Live only: the exact 422 no-generation envelope is an upstream
      // outcome, not a transport/schema failure. Anything else rethrows.
      if (!options.live || !(error instanceof CohereError) || error.statusCode !== 422) throw error;
      assert.equal(wire.length, 1, "unexpected send count");
      let parsed: ReturnType<typeof readCohereK5>;
      try {
        parsed = readCohereK5(wire[0], stream, "record_numbers", options);
      } catch (rejection) {
        // Keep both the SDK error and why the classifier refused the 422.
        throw new Error(
          `Cohere K5 ${stream ? "stream" : "object"} 422 is not an accepted no-generation outcome: ${
            rejection instanceof Error ? rejection.message : String(rejection)
          }`,
          { cause: { sdk: error, classifier: rejection } },
        );
      }
      results.push({ stream, ...parsed });
      continue;
    }
    assert.equal(wire.length, 1, "unexpected send count");
    const parsed = compareCohereK5(
      wire[0],
      stream,
      stream ? events : object,
      "record_numbers",
      options,
    );
    results.push({ stream, ...parsed });
  }
  assert.equal(attempts, 2);
  return results;
}

/**
 * When every K5 send came back UPSTREAM_NO_GENERATION nothing was compared, so
 * the run is a skip (with the upstream codes and ids), never a pass.
 */
function cohereK5SkipReason(results: Awaited<ReturnType<typeof runCohereK5Modes>>) {
  const outcomes = results.map((result) => result.upstream);
  if (outcomes.length === 0 || !outcomes.every((outcome) => outcome !== undefined)) return null;
  return cohereNoGenerationSkipReason(outcomes as NonNullable<(typeof outcomes)[number]>[]);
}

async function runCohereK5Live(
  ctx: { skip: (note?: string) => never },
  baseUrl: string,
  token: string,
) {
  const results = await runCohereK5Modes(baseUrl, token, { live: true });
  const skip = cohereK5SkipReason(results);
  if (skip) ctx.skip(skip);
  return results;
}

it.skipIf(!HAS_CREDENTIALS)(
  "P1 Cohere native K5 object modeled and stream observed comparison",
  async (ctx) => {
    assert(COHERE_API_KEY, "configured Cohere credential missing");
    const results = await runCohereK5Live(ctx, COHERE_BASE_URL, COHERE_API_KEY);
    console.log(
      JSON.stringify({
        cohereK5: results.map(({ stream, classification, finish, usage }) => ({
          stream,
          classification,
          finish,
          usage,
        })),
      }),
    );
  },
  95000,
);

it("P1 Cohere K5 genuine object nontrigger still schedules genuine stream through SDK", async () => {
  const object = await readFile(new URL("./fixtures/cohere-k5-object.raw", import.meta.url));
  const stream = await readFile(new URL("./fixtures/cohere-k5-stream.sse", import.meta.url));
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    response.writeHead(200, {
      "content-type": body.stream ? "text/event-stream" : "application/json",
    });
    response.end(body.stream ? stream : object);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const results = await runCohereK5Modes(`http://127.0.0.1:${address.port}`, "local");
    expect(results.map((result) => result.classification)).toEqual(["NOT_TRIGGERED", "TARGET"]);
    expect(requests.map((request) => Boolean(request.stream))).toEqual([false, true]);
    expect(
      requests.every((request) => request.max_tokens === 128 && request.tool_choice === "REQUIRED"),
    ).toBe(true);
    expect(requests.reduce((sum, request) => sum + Number(request.max_tokens), 0)).toBe(256);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

const capturedCohereNoGeneration = {
  object: {
    file: "cohere-k5-no-generation-object.raw",
    hash: "d477ff3e66355ecef2b231dd7b1e0a64d3505978d5bf017477350d96e679a547",
  },
  stream: {
    file: "cohere-k5-no-generation-stream.sse",
    hash: "08870d11ffdf04786d62c507cd569914e87bb08c2cc905aa76cba81371883c23",
  },
};

async function readCohereNoGenerationCaptures() {
  const read = async ({ file, hash }: { file: string; hash: string }) => {
    const bytes = await readFile(new URL(`./fixtures/${file}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
    return bytes;
  };
  return {
    object: await read(capturedCohereNoGeneration.object),
    stream: await read(capturedCohereNoGeneration.stream),
  };
}

// Genuine live Cohere captures (2026-10-11): with tool_choice REQUIRED the model
// sometimes generates nothing — a 422 NO_TOOL_CALL_OR_RESPONSE_GENERATED on the
// object send, or a 200 stream whose message-end is finish_reason ERROR with
// usage {}. Served over loopback so the SDK and the wire reader see real bytes.
interface CohereReplay {
  status: number;
  contentType: string;
  body: Uint8Array;
}

async function withCohereReplayServer(
  replies: { object: CohereReplay; stream: CohereReplay },
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const reply = body.stream ? replies.stream : replies.object;
    response.writeHead(reply.status, { "content-type": reply.contentType });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function withCohereNoGenerationServer(
  bytes: { object: Uint8Array; stream: Uint8Array },
  run: (baseUrl: string) => Promise<void>,
) {
  await withCohereReplayServer(
    {
      object: { status: 422, contentType: "application/json", body: bytes.object },
      stream: { status: 200, contentType: "text/event-stream", body: bytes.stream },
    },
    run,
  );
}

class CohereTestSkip extends Error {}
const recordingSkipContext = {
  skip: (note?: string): never => {
    throw new CohereTestSkip(note);
  },
};

it("P1 Cohere K5 live run is a skip, not a pass, when every send generated nothing", async () => {
  const bytes = await readCohereNoGenerationCaptures();
  const objectId = JSON.parse(bytes.object.toString()).id as string;
  const streamId = JSON.parse(bytes.stream.toString().split("\n")[1].slice(6)).id as string;
  await withCohereNoGenerationServer(bytes, async (baseUrl) => {
    const skipped = await runCohereK5Live(recordingSkipContext, baseUrl, "local").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(skipped).toBeInstanceOf(CohereTestSkip);
    const reason = (skipped as Error).message;
    expect(reason).toContain(`NO_TOOL_CALL_OR_RESPONSE_GENERATED id=${objectId}`);
    expect(reason).toContain(`NO_TOOL_CALL_OR_RESPONSE_GENERATED id=${streamId}`);
  });
  // One compared send is enough to make the run a real pass.
  const object = await readFile(new URL("./fixtures/cohere-k5-object.raw", import.meta.url));
  await withCohereReplayServer(
    {
      object: { status: 200, contentType: "application/json", body: object },
      stream: { status: 200, contentType: "text/event-stream", body: bytes.stream },
    },
    async (baseUrl) => {
      const results = await runCohereK5Live(recordingSkipContext, baseUrl, "local");
      expect(results.map((result) => result.classification)).toEqual([
        "NOT_TRIGGERED",
        "UPSTREAM_NO_GENERATION",
      ]);
    },
  );
});

it("P1 Cohere K5 live leg accepts a 422 no-generation reply on the stream send", async () => {
  // CONSTRUCTED: a 422 on the K5 *stream* send has not been observed live
  // (it was observed on the K5 object send and on the shape leg's stream send).
  // The body is the genuine K5 object capture, so only the routing is synthetic.
  const bytes = await readCohereNoGenerationCaptures();
  const object = await readFile(new URL("./fixtures/cohere-k5-object.raw", import.meta.url));
  const replies = (body: Uint8Array) => ({
    object: { status: 200, contentType: "application/json", body: object },
    stream: { status: 422, contentType: "application/json", body },
  });
  await withCohereReplayServer(replies(bytes.object), async (baseUrl) => {
    const results = await runCohereK5Modes(baseUrl, "local", { live: true });
    expect(results.map((result) => [result.stream, result.classification])).toEqual([
      [false, "NOT_TRIGGERED"],
      [true, "UPSTREAM_NO_GENERATION"],
    ]);
    await expect(runCohereK5Modes(baseUrl, "local")).rejects.toThrow();
  });
  // A no-tools code on the tool request is refused, and the refusal keeps the
  // classifier's reason as well as the SDK error.
  const wrongCode = Buffer.from(
    JSON.stringify({
      ...JSON.parse(bytes.object.toString()),
      error_type: "NO_VALID_RESPONSE_GENERATED",
    }),
  );
  await withCohereReplayServer(replies(wrongCode), async (baseUrl) => {
    const refused = await runCohereK5Modes(baseUrl, "local", { live: true }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain(
      "Cohere K5 stream 422 is not an accepted no-generation outcome: HTTP failure",
    );
    const cause = (refused as Error).cause as { sdk: unknown; classifier: unknown };
    expect(cause.sdk).toBeInstanceOf(CohereError);
    expect(cause.classifier).toBeInstanceOf(Error);
  });
});

it("P1 Cohere K5 live leg accepts genuine upstream no-generation captures", async () => {
  const bytes = await readCohereNoGenerationCaptures();
  await withCohereNoGenerationServer(bytes, async (baseUrl) => {
    const results = await runCohereK5Modes(baseUrl, "local", { live: true });
    expect(results.map((result) => [result.stream, result.classification])).toEqual([
      [false, "UPSTREAM_NO_GENERATION"],
      [true, "UPSTREAM_NO_GENERATION"],
    ]);
  });
});

it("P1 Cohere K5 strict leg still rejects genuine upstream no-generation captures", async () => {
  const bytes = await readCohereNoGenerationCaptures();
  await withCohereNoGenerationServer(bytes, async (baseUrl) => {
    await expect(runCohereK5Modes(baseUrl, "local")).rejects.toThrow();
  });
  const observation = (raw: Uint8Array, streaming: boolean, status: number) => ({
    requestBody: undefined,
    status,
    contentType: streaming ? "text/event-stream" : "application/json",
    bytes: [...raw],
    complete: true,
  });
  expect(() => readCohereK5(observation(bytes.stream, true, 200), true, "record_numbers")).toThrow(
    "expected object",
  );
  expect(() =>
    readCohereK5(observation(bytes.object, false, 422), false, "record_numbers"),
  ).toThrow("HTTP failure");
});

it("P1 Cohere K5 live leg rejects mutated no-generation shapes", async () => {
  const bytes = await readCohereNoGenerationCaptures();
  const live = { live: true };
  const observation = (raw: Uint8Array | string, streaming: boolean, status: number) => ({
    requestBody: undefined,
    status,
    contentType: streaming ? "text/event-stream" : "application/json",
    bytes: [...Buffer.from(raw)],
    complete: true,
  });
  const stream = bytes.stream.toString();
  const toolStart =
    'event: tool-call-start\ndata: {"type":"tool-call-start","index":0,"delta":{"message":{"tool_calls":{"id":"record_numbers_x","type":"function","function":{"name":"record_numbers","arguments":""}}}}}\n\n' +
    'event: tool-call-end\ndata: {"type":"tool-call-end","index":0}\n\n';
  const contentBlock =
    'event: content-start\ndata: {"type":"content-start","index":0,"delta":{"message":{"content":{"type":"text","text":""}}}}\n\n' +
    'event: content-delta\ndata: {"type":"content-delta","index":0,"delta":{"message":{"content":{"text":"hi"}}}}\n\n' +
    'event: content-end\ndata: {"type":"content-end","index":0}\n\n';
  const streamMutants: [string, string][] = [
    ["non-empty usage", stream.replace('"usage":{}', '"usage":{"tokens":{}}')],
    [
      "other error type",
      stream.replace(
        '"error_type":"NO_TOOL_CALL_OR_RESPONSE_GENERATED"',
        '"error_type":"INTERNAL"',
      ),
    ],
    ["other finish", stream.replace('"finish_reason":"ERROR"', '"finish_reason":"COMPLETE"')],
    ["missing error", stream.replace(/"error":"[^"]*",/, "")],
    ["extra key", stream.replace('"usage":{}', '"usage":{},"extra":1')],
    [
      "tool before terminal",
      stream.replace("event: message-end", toolStart + "event: message-end"),
    ],
    [
      "content before terminal",
      stream.replace("event: message-end", contentBlock + "event: message-end"),
    ],
  ];
  for (const [name, mutant] of streamMutants) {
    expect(mutant, name).not.toBe(stream);
    expect(
      () => readCohereK5(observation(mutant, true, 200), true, "record_numbers", live),
      name,
    ).toThrow();
  }
  const object = JSON.parse(bytes.object.toString());
  const objectMutants: [string, unknown, number][] = [
    ["other status", object, 400],
    ["other error type", { ...object, error_type: "NO_VALID_RESPONSE_GENERATED" }, 422],
    ["extra key", { ...object, usage: {} }, 422],
    ["empty id", { ...object, id: "" }, 422],
  ];
  for (const [name, body, status] of objectMutants)
    expect(
      () =>
        readCohereK5(
          observation(JSON.stringify(body), false, status),
          false,
          "record_numbers",
          live,
        ),
      name,
    ).toThrow();
  expect(
    readCohereK5(observation(bytes.stream, true, 200), true, "record_numbers", live).classification,
  ).toBe("UPSTREAM_NO_GENERATION");
  // Each guard is pinned by the specific failure it raises.
  expect(() =>
    readCohereK5(
      observation(
        stream.replace("event: message-end", contentBlock + "event: message-end"),
        true,
        200,
      ),
      true,
      "record_numbers",
      live,
    ),
  ).toThrow("content before no-generation terminal");
  const genuine422 = observation(bytes.object, false, 422);
  expect(readCohereK5(genuine422, false, "record_numbers", live).classification).toBe(
    "UPSTREAM_NO_GENERATION",
  );
  expect(() =>
    readCohereK5({ ...genuine422, complete: false }, false, "record_numbers", live),
  ).toThrow("incomplete response");
  expect(() =>
    readCohereK5({ ...genuine422, contentType: "text/plain" }, false, "record_numbers", live),
  ).toThrow("wrong content type");
  expect(() =>
    readCohereK5({ ...genuine422, contentType: "text/event-stream" }, true, "record_numbers", live),
  ).toThrow("wrong content type");
});

it("P1 Cohere K5 native coordinator fails fast on actual HTTP authentication error", async () => {
  let attempts = 0;
  const server = createServer((_request, response) => {
    attempts++;
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"message":"Unauthorized"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    await expect(runCohereK5Modes(`http://127.0.0.1:${address.port}`, "local")).rejects.toThrow();
    expect(attempts).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("P1 Cohere captured derivatives reject contradictory lifecycle and object schema", async () => {
  const stream = await readFile(new URL("./fixtures/cohere-k5-stream.sse", import.meta.url));
  const object = await readFile(new URL("./fixtures/cohere-k5-object.raw", import.meta.url));
  const observation = (bytes: Uint8Array, streaming: boolean): CohereWireObservation => ({
    requestBody: undefined,
    status: 200,
    contentType: streaming ? "text/event-stream" : "application/json",
    bytes: [...bytes],
    complete: true,
  });
  const text = stream.toString();
  const frames = text.split("\n\n").filter(Boolean);
  const first = frames[0];
  const end = frames.find((frame) => frame.startsWith("event: message-end"));
  const close = frames.find((frame) => frame.startsWith("event: tool-call-end"));
  const start = frames.find((frame) => frame.startsWith("event: tool-call-start"));
  assert(end && close && start);
  const changed = (values: string[]) => Buffer.from(values.join("\n\n") + "\n\n");
  const malformedStreams: [string, Uint8Array][] = [
    ["missing sentinel", changed(frames.slice(0, -1))],
    ["duplicate sentinel", changed([...frames, "data: [DONE]"])],
    ["post-sentinel event", changed([...frames, close])],
    ["misplaced sentinel", changed(["data: [DONE]", ...frames.slice(0, -1)])],
    ["missing start", changed(frames.slice(1))],
    ["duplicate start", changed([first, ...frames])],
    ["missing terminal", changed(frames.filter((frame) => frame !== end))],
    ["duplicate terminal", changed([...frames.slice(0, -1), end, "data: [DONE]"])],
    ["missing tool start", changed(frames.filter((frame) => frame !== start))],
    ["missing closure", changed(frames.filter((frame) => frame !== close))],
    [
      "duplicate closure",
      changed(frames.flatMap((frame) => (frame === close ? [close, close] : [frame]))),
    ],
    [
      "duplicate tool start",
      changed(frames.flatMap((frame) => (frame === start ? [start, start] : [frame]))),
    ],
    [
      "wrong closure index",
      changed(
        frames.map((frame) => (frame === close ? close.replace('"index":0', '"index":1') : frame)),
      ),
    ],
    [
      "delta after closure",
      changed(
        frames.flatMap((frame) =>
          frame === close
            ? [close, frames.find((part) => part.startsWith("event: tool-call-delta"))!]
            : [frame],
        ),
      ),
    ],
    [
      "missing usage",
      changed(
        frames.map((frame) =>
          frame === end ? end.replace('"usage":', '"missing_usage":') : frame,
        ),
      ),
    ],
    ["negative index", Buffer.from(text.replace('"index":0', '"index":-1'))],
    ["empty tool id", Buffer.from(text.replace(/"id":"record_numbers_[^"]+"/, '"id":""'))],
    [
      "wrong terminal",
      Buffer.from(text.replace('"finish_reason":"TOOL_CALL"', '"finish_reason":"MAX_TOKENS"')),
    ],
    [
      "failed terminal",
      Buffer.from(text.replace('"finish_reason":"TOOL_CALL"', '"finish_reason":"ERROR"')),
    ],
    ["broken outer JSON", Buffer.from(text.replace("data: {", "data: {bad:"))],
    ["truncated frame", stream.subarray(0, stream.length - 2)],
    ["invalid UTF8", Uint8Array.from([...stream, 255])],
  ];
  for (const [name, bytes] of malformedStreams)
    expect(() => readCohereK5(observation(bytes, true), true, "record_numbers"), name).toThrow();
  for (const overrides of [
    { status: 401 },
    { complete: false },
    { contentType: "text/plain" },
    { bytes: [] },
    { bytes: new Array(262145).fill(32) },
  ])
    expect(() =>
      readCohereK5({ ...observation(object, false), ...overrides }, false, "record_numbers"),
    ).toThrow();
  const base = JSON.parse(object.toString());
  const malformedObjects = [
    { ...base, finish_reason: "ERROR" },
    { ...base, finish_reason: "TIMEOUT" },
    { ...base, finish_reason: "TOOL_CALL" },
    { ...base, id: "" },
    { ...base, usage: {} },
    { ...base, message: { role: "assistant" } },
    { ...base, message: { ...base.message, role: "user" } },
    { ...base, message: { ...base.message, content: [{ type: "text", text: 42 }] } },
    { ...base, message: { ...base.message, tool_calls: {} } },
  ];
  for (const body of malformedObjects)
    expect(() =>
      readCohereK5(observation(Buffer.from(JSON.stringify(body)), false), false, "record_numbers"),
    ).toThrow();
  const decoded = await decodeCohereCapture(stream, true);
  expect(() =>
    compareCohereK5(decoded.wire, true, decoded.events.slice(1), "record_numbers"),
  ).toThrow("raw/SDK disagreement");
  const repaired = structuredClone(decoded.events);
  const deltas = repaired.filter((event) => event.type === "tool-call-delta");
  for (const [index, event] of deltas.entries()) {
    assert(event.delta?.message?.toolCalls?.function);
    event.delta.message.toolCalls.function.arguments = index === 0 ? '{"payload":"1"}' : "";
  }
  expect(() => compareCohereK5(decoded.wire, true, repaired, "record_numbers")).toThrow(
    "raw/SDK disagreement",
  );
});

it("P1 Cohere repaired captured stream is not accepted as K5", async () => {
  const original = await readFile(new URL("./fixtures/cohere-k5-stream.sse", import.meta.url));
  let first = true;
  const frames = original
    .toString()
    .split("\n\n")
    .filter(Boolean)
    .flatMap((frame) => {
      if (!frame.startsWith("event: tool-call-delta")) return [frame];
      if (!first) return [];
      first = false;
      const event = JSON.parse(frame.split("\n")[1].slice(6));
      event.delta.message.tool_calls.function.arguments = '{"payload":"1"}';
      return [`event: tool-call-delta\ndata: ${JSON.stringify(event)}`];
    });
  const derivative = Buffer.from(frames.join("\n\n") + "\n\n");
  const decoded = await decodeCohereCapture(derivative, true);
  expect(() => compareCohereK5(decoded.wire, true, decoded.events, "record_numbers")).toThrow(
    "stream K5 did not trigger",
  );
});

it("P1 Cohere start-only captured arguments cannot bypass delta lifecycle", async () => {
  const original = await readFile(new URL("./fixtures/cohere-k5-stream.sse", import.meta.url));
  const frames = original
    .toString()
    .split("\n\n")
    .filter(Boolean)
    .flatMap((frame) => {
      if (frame.startsWith("event: tool-call-delta")) return [];
      if (!frame.startsWith("event: tool-call-start")) return [frame];
      const event = JSON.parse(frame.split("\n")[1].slice(6));
      event.delta.message.tool_calls.function.arguments = '{"payload":"1';
      return [`event: tool-call-start\ndata: ${JSON.stringify(event)}`];
    });
  const derivative = Buffer.from(frames.join("\n\n") + "\n\n");
  const decoded = await decodeCohereCapture(derivative, true);
  expect(decoded.events.filter((event) => event.type === "tool-call-delta")).toHaveLength(0);
  let classification: string | undefined;
  let rejection: string | undefined;
  try {
    classification = compareCohereK5(
      decoded.wire,
      true,
      decoded.events,
      "record_numbers",
    ).classification;
  } catch (error) {
    assert(error instanceof Error);
    rejection = error.message;
  }
  const proofDirectory = process.env.AIMOCK_COHERE_K5_PROOF_DIR;
  if (proofDirectory) {
    await writeFile(join(proofDirectory, "start-only.raw.sse"), derivative);
    await writeFile(
      join(proofDirectory, "start-only.json"),
      JSON.stringify({ classification, rejection, decoded }, null, 2),
    );
  }
  expect(classification).toBeUndefined();
  expect(rejection).toContain("tool opener arguments must be empty");
});
