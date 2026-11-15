/** Verify real route scheduling without measuring wall-clock intervals. */
import { expect, vi } from "vitest";
import { createServer } from "../server.js";
import * as writer from "../sse-writer.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./chaos-ws-client-a93f6c.js";

const seedHeader = "x-aimock-chaos-seed";
const keyHeader = "x-aimock-chaos-key";
const profile = { ttft: 100, tps: 10, jitter: 0.5 };
const httpFamilies = [
  "sse",
  "messages",
  "responses",
  "gemini",
  "vertex",
  "interactions",
  "cohere",
  "ndjson",
  "generate",
  "eventstream",
  "converse",
  "transcription",
] as const;
type HttpFamily = (typeof httpFamilies)[number];
type Family = HttpFamily | "realtime" | "realtime-transcription";
type Shape = "text" | "tools" | "mixed" | "blocks";
interface Scenario {
  seed?: string;
  key?: string;
  fixtureSeed?: string;
  headerSeed?: string;
  text?: string;
  query?: string;
  context?: string;
  shape?: Shape;
  wireExtra?: string;
  reverseFields?: boolean;
  afterTrigger?: boolean;
}

function httpRequest(family: HttpFamily, scenario: Scenario) {
  const text = scenario.text ?? "hello";
  const messages = [{ role: "user", content: text }];
  let path: string;
  let value: object;
  switch (family) {
    case "sse":
      path = "/v1/chat/completions";
      value = { model: "gpt-4", messages, stream: true };
      break;
    case "messages":
      path = "/v1/messages";
      value = { model: "claude-3-sonnet", messages, max_tokens: 20, stream: true };
      break;
    case "responses":
      path = "/v1/responses";
      value = { model: "gpt-4", input: text, stream: true };
      break;
    case "gemini":
    case "vertex":
      path =
        family === "gemini"
          ? "/v1beta/models/gemini-2.5-flash:streamGenerateContent"
          : "/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent";
      value = { contents: [{ role: "user", parts: [{ text }] }] };
      break;
    case "interactions":
      path = "/v1beta/interactions";
      value = { model: "gemini-2.5-flash", input: text, stream: true };
      break;
    case "cohere":
      path = "/v2/chat";
      value = { model: "command-r", messages, stream: true };
      break;
    case "ndjson":
      path = "/api/chat";
      value = { model: "llama3", messages, stream: true };
      break;
    case "generate":
      path = "/api/generate";
      value = { model: "llama3", prompt: text, stream: true };
      break;
    case "eventstream":
      path = "/model/anthropic.claude-3-sonnet/invoke-with-response-stream";
      value = { messages, max_tokens: 20 };
      break;
    case "converse":
      path = "/model/anthropic.claude-3-sonnet/converse-stream";
      value = { messages: [{ role: "user", content: [{ text }] }] };
      break;
    case "transcription": {
      const boundary = "aimock-pacing-wire";
      const fields = [
        ["model", "gpt-4o-transcribe"],
        ["stream", "true"],
        ["file", text],
      ];
      const body =
        fields
          .map(
            ([name, content]) =>
              `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${name === "file" ? '; filename="test.wav"' : ""}\r\n\r\n${content}\r\n`,
          )
          .join("") + `--${boundary}--\r\n`;
      return {
        path: "/v1/audio/transcriptions" + (scenario.query ?? ""),
        body,
        contentType: `multipart/form-data; boundary=${boundary}`,
      };
    }
  }
  return {
    path: path + (scenario.query ?? ""),
    body: JSON.stringify(value),
    contentType: "application/json",
  };
}

function fixtureResponse(shape: Shape): Fixture["response"] {
  const toolCalls = [{ name: "lookup", arguments: '{"value":123}' }];
  if (shape === "tools") return { toolCalls };
  if (shape === "mixed") return { content: "abcdef", toolCalls };
  if (shape === "blocks")
    return {
      blocks: [
        { type: "text", text: "abcdef" },
        { type: "toolCall", ...toolCalls[0] },
      ],
    };
  return { content: "abcdef" };
}

function fixtures(scenario: Scenario): Fixture[] {
  return [
    { match: { endpoint: "transcription" }, response: { transcription: { text: "abcdef" } } },
    {
      match: { endpoint: "realtime-transcription" },
      response: { transcription: { text: "abcdef" } },
    },
    { match: { userMessage: /.*/ }, response: fixtureResponse(scenario.shape ?? "text") },
  ].map((fixture) => ({
    ...fixture,
    chunkSize: 2,
    streamingProfile: profile,
    ...(scenario.fixtureSeed ? { chaos: { seed: scenario.fixtureSeed } } : {}),
  })) as Fixture[];
}

function headers(scenario: Scenario): Record<string, string> {
  return {
    ...(scenario.key !== undefined ? { [keyHeader]: scenario.key } : {}),
    ...(scenario.headerSeed ? { [seedHeader]: scenario.headerSeed } : {}),
    ...(scenario.context ? { "x-aimock-context": scenario.context } : {}),
  };
}

async function pacing(label: string, run: () => Promise<void>): Promise<number[]> {
  const delays: number[] = [];
  const schedule = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    if (typeof ms === "number" && ms >= 50 && ms <= 150) {
      delays.push(ms);
      return schedule(callback, 0, ...args);
    }
    return schedule(callback, ms, ...args);
  });
  try {
    await run();
  } finally {
    timer.mockRestore();
  }
  expect(delays.length, `${label} must schedule profile delays`).toBeGreaterThan(0);
  return delays;
}

function reverseFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseFields);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseFields(item)]),
    );
  return value;
}

async function realtimeStream(
  url: string,
  transcription: boolean,
  scenario: Scenario,
): Promise<void> {
  const query = scenario.query ?? "";
  const target =
    "/v1/realtime" + query + (transcription ? `${query ? "&" : "?"}intent=transcription` : "");
  const ws = await connectWebSocket(url, target, headers(scenario));
  const send = (value: object) =>
    ws.send(JSON.stringify(scenario.reverseFields ? reverseFields(value) : value));
  const trigger = (value: object) => {
    const events = [value];
    if (scenario.afterTrigger)
      events.push({ type: "session.update", session: { temperature: 0.9 } });
    // One ordered frame batch, with no sleeps or elapsed-time assertion. Later
    // client data cannot alter the identity of the already-triggered response.
    ws.sendBatch(
      events.map((event) => JSON.stringify(scenario.reverseFields ? reverseFields(event) : event)),
    );
  };
  try {
    await ws.waitForMessages(1);
    if (transcription) {
      send({
        type: "transcription_session.update",
        session: { input_audio_transcription: { model: "gpt-live-transcribe" } },
      });
      await ws.waitForMessages(2);
      send({
        type: "input_audio_buffer.append",
        audio: Buffer.from(scenario.text ?? "hello").toString("base64"),
      });
      trigger({
        type: "input_audio_buffer.commit",
        ...(scenario.wireExtra ? { client_note: scenario.wireExtra } : {}),
      });
    } else {
      send({ type: "session.update", session: { output_modalities: ["text"] } });
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: scenario.text ?? "hello" }],
        },
      });
      trigger({
        type: "response.create",
        ...(scenario.wireExtra ? { client_note: scenario.wireExtra } : {}),
      });
    }
    const types: string[] = [];
    for (let count = 2; count <= 100; count++) {
      const events = (await ws.waitForMessages(count)).map(
        (message) => JSON.parse(message) as { type: string },
      );
      const done = transcription
        ? "conversation.item.input_audio_transcription.completed"
        : "response.done";
      if (events.some((event) => event.type === done)) {
        types.push(...events.map((event) => event.type));
        if (scenario.shape && scenario.shape !== "text")
          expect(types).toContain("response.function_call_arguments.delta");
        return;
      }
    }
    throw new Error("Realtime response did not complete");
  } finally {
    ws.close();
    await ws.waitForClose();
  }
}

async function measure(family: Family, scenario: Scenario = {}): Promise<number[]> {
  const create = (
    writer as unknown as {
      createJitterSource: (seed: string, key: string) => (index: number) => number;
    }
  ).createJitterSource;
  expect(create).toBeTypeOf("function");
  const seed = scenario.seed ?? "run-a";
  const instance = await createServer(fixtures(scenario), {
    port: 0,
    chaos: { seed },
    logLevel: "silent",
  });
  const label = `${family}/${scenario.shape ?? "text"}/${scenario.key === undefined ? "derived" : "explicit"}`;
  const effectiveSeed = scenario.headerSeed ?? scenario.fixtureSeed ?? seed;
  try {
    let reportedKey: string | null = null;
    let eventIndices: number[] | undefined;
    let run: () => Promise<void>;
    if (family === "realtime" || family === "realtime-transcription") {
      // An explicit identity is endpoint-independent. Ordinary WebSocket keys
      // have no response headers; those are checked by relational runs below.
      if (scenario.key?.trim()) {
        const probe = await fetch(`${instance.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers(scenario),
            "x-aimock-chaos-drop": "1",
          },
          body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
        });
        expect(probe.headers.get(seedHeader)).toBe(effectiveSeed);
        reportedKey = probe.headers.get(keyHeader);
        await probe.text();
      }
      run = () => realtimeStream(instance.url, family === "realtime-transcription", scenario);
    } else {
      const request = httpRequest(family, scenario);
      const invoke = (drop: boolean) =>
        fetch(instance.url + request.path, {
          method: "POST",
          headers: {
            "Content-Type": request.contentType,
            ...headers(scenario),
            ...(drop ? { "x-aimock-chaos-drop": "1" } : {}),
          },
          body: request.body,
          signal: AbortSignal.timeout(5000),
        });
      // Probe the exact same wire target and bytes with only an action header
      // changed. This works for both derived and explicitly supplied keys.
      const probe = await invoke(true);
      expect(probe.status, label).toBe(500);
      expect(probe.headers.get(seedHeader), label).toBe(effectiveSeed);
      reportedKey = probe.headers.get(keyHeader);
      expect(reportedKey).toMatch(/^[0-9a-f]{16}$/);
      await probe.text();
      run = async () => {
        const response = await invoke(false);
        expect(response.status, label).toBe(200);
        expect(response.headers.get("content-type"), label).toContain(
          family === "ndjson" || family === "generate"
            ? "application/x-ndjson"
            : family === "eventstream" || family === "converse"
              ? "application/vnd.amazon.eventstream"
              : "text/event-stream",
        );
        const output = Buffer.from(await response.arrayBuffer());
        expect(output.byteLength).toBeGreaterThan(0);
        // Interactions framing events share the next content-delta index;
        // derive indices from the actual protocol events, not an assumed count.
        if (family === "interactions") {
          let index = 0;
          eventIndices = output
            .toString()
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => {
              const event = JSON.parse(line.slice(6)) as { event_type: string };
              const current = index;
              if (event.event_type === "step.delta") index++;
              return current;
            });
        }
      };
    }
    const delays = await pacing(label, run);
    if (reportedKey !== null) {
      const source = create(effectiveSeed, reportedKey);
      for (let i = 0; i < delays.length; i++)
        expect(delays[i], `${label} chunk ${i}`).toBeCloseTo(
          100 * (1 + (source(eventIndices?.[i] ?? i) * 2 - 1) * 0.5),
          6,
        );
    }
    // Occurrences advance, but the request's pacing does not. Insert a foreign
    // identity to expose accidental use of one global advancing jitter stream.
    await fetch(`${instance.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [keyHeader]: "unrelated",
        "x-aimock-chaos-drop": "1",
      },
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "other" }] }),
    }).then((response) => response.text());
    expect(await pacing(label, run), label).toEqual(delays);
    return delays;
  } finally {
    instance.server.closeAllConnections();
    await new Promise<void>((resolve) => instance.server.close(() => resolve()));
  }
}

export async function assertRequestJitter(): Promise<void> {
  for (const family of [...httpFamilies, "realtime", "realtime-transcription"] as Family[]) {
    const first = await measure(family, { key: "key-a" });
    expect(await measure(family, { key: "key-a" }), family).toEqual(first);
    expect(await measure(family, { key: "key-a", seed: "run-b" }), family).not.toEqual(first);
    expect(await measure(family, { key: "key-b" }), family).not.toEqual(first);
    expect(
      await measure(family, { key: "key-a", seed: "other", fixtureSeed: "run-a" }),
      family,
    ).toEqual(first);
    expect(
      await measure(family, {
        key: "key-a",
        seed: "other",
        fixtureSeed: "fixture",
        headerSeed: "run-a",
      }),
      family,
    ).toEqual(first);
    // Writers and route handlers dispatch text, tools, and combined responses
    // separately. Each call site must forward the request's seeded source.
    if (
      family !== "generate" &&
      family !== "transcription" &&
      family !== "realtime-transcription"
    ) {
      for (const shape of ["tools", "mixed", "blocks"] as const)
        await measure(family, { key: "key-a", shape });
    }
  }
}

export async function assertDerivedRequestJitter(): Promise<void> {
  const defaults = new Map<string, number[]>();
  for (const family of httpFamilies) {
    const first = await measure(family);
    defaults.set(family, first);
    expect(await measure(family), family).toEqual(first);
    expect(await measure(family, { text: "different body" }), family).not.toEqual(first);
    expect(await measure(family, { query: "?attempt=2" }), family).not.toEqual(first);
    expect(await measure(family, { context: "routing-only" }), family).toEqual(first);
    expect(await measure(family, { key: "  " }), family).toEqual(first);
  }
  // Same writer, equivalent input shape, distinct endpoint paths.
  expect(defaults.get("gemini")).not.toEqual(defaults.get("vertex"));
  for (const family of ["realtime", "realtime-transcription"] as const) {
    const first = await measure(family);
    expect(await measure(family), family).toEqual(first);
    expect(await measure(family, { afterTrigger: true }), `${family}/history boundary`).toEqual(
      first,
    );
    expect(await measure(family, { context: "alpha" }), family).toEqual(first);
    expect(await measure(family, { context: "beta" }), family).toEqual(first);
    expect(await measure(family, { reverseFields: true }), family).toEqual(first);
    expect(await measure(family, { query: "?attempt=1" }), family).not.toEqual(first);
    expect(await measure(family, { query: "?attempt=2" }), family).not.toEqual(
      await measure(family, { query: "?attempt=1" }),
    );
    expect(await measure(family, { text: "different frame body" }), family).not.toEqual(first);
    expect(
      await measure(family, { wireExtra: "not in the router projection" }),
      family,
    ).not.toEqual(first);
    expect(await measure(family, { key: " " }), family).toEqual(first);
  }
}
