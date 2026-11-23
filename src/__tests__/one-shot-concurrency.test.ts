import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";

const embedding = { path: "/v1/embeddings", method: "POST", body: { model: "m", input: "hello" } };
const chat = {
  path: "/v1/chat/completions",
  method: "POST",
  body: { model: "m", messages: [{ role: "user", content: "hello" }] },
};
const surfaces = [
  embedding,
  {
    path: "/v1/text-to-voice/design",
    method: "POST",
    body: { voice_description: "A warm narrator voice" },
  },
  {
    path: "/v1/text-to-voice",
    method: "POST",
    body: {
      voice_name: "Narrator",
      voice_description: "A warm narrator voice",
      generated_voice_id: "preview",
    },
  },
  { path: "/v1/voices/example", method: "GET" },
  { path: "/v1/voices/example", method: "DELETE" },
];
type Surface = { path: string; method: string; body?: object };
let mock: LLMock;
afterEach(async () => {
  await mock?.stop();
});
async function start() {
  let selected!: () => void;
  const selection = new Promise<void>((resolve) => {
    selected = resolve;
  });
  mock = new LLMock({
    logLevel: "silent",
    requestTransform: (req) => {
      selected();
      return req;
    },
  });
  mock.onEmbedding("hello", { embedding: [0.1, 0.2] });
  mock.onMessage("hello", { content: "ok" });
  for (const endpoint of [
    "elevenlabs-voice-design",
    "elevenlabs-voice",
    "elevenlabs-voice-get",
    "elevenlabs-voice-delete",
  ] as const) {
    mock.addFixture({
      match: { endpoint },
      response: { json: { voice_id: "example", status: "ok", previews: [] } },
    });
  }
  await mock.start();
  mock.setChaos({ latencyMs: 100 });
  mock.nextRequestError(500, { message: "INJECTED" });
  return { selection };
}
async function send(surface: Surface, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const res = await fetch(mock.url + surface.path, {
    method: surface.method,
    headers: { "content-type": "application/json", ...headers },
    body: surface.body ? JSON.stringify(surface.body) : undefined,
    signal,
  });
  await res.text();
  return res.status;
}
describe("one-shot errors across awaited serving selection", () => {
  it.each(surfaces)("serves exactly once for $method $path", async (surface) => {
    const { selection } = await start();
    const statuses = await Promise.all([send(surface), send(surface)]);
    await selection;
    expect(statuses.sort()).toEqual([200, 500]);
    expect(await send(surface)).toBe(200);
  });
  it("shares exclusion with chat", async () => {
    const { selection } = await start();
    const pending = send(embedding);
    await selection;
    expect((await Promise.all([pending, send(chat)])).sort()).toEqual([200, 500]);
  });
  it.each(surfaces)("releases a chaos-interrupted $method $path claim", async (surface) => {
    const { selection } = await start();
    expect(await send(surface, { "x-aimock-chaos-ratelimit": "1" })).toBe(429);
    await selection;
    expect(await send(surface)).toBe(500);
    expect(await send(surface)).toBe(200);
  });
  it.each(surfaces)("releases a cancelled $method $path claim", async (surface) => {
    const { selection } = await start();
    const queued = mock.getFixtures().length;
    const controller = new AbortController();
    const pending = send(surface, {}, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await selection;
    const claimedCount = mock.getFixtures().length;
    controller.abort();
    await rejected;
    expect(claimedCount).toBe(queued - 1);
    await expect.poll(() => mock.getFixtures().length).toBe(queued);
    expect(await send(surface)).toBe(500);
    expect(await send(surface)).toBe(200);
  });
  it.each(surfaces)("does not resurrect a reset $method $path claim", async (surface) => {
    const { selection } = await start();
    const pending = send(surface, { "x-aimock-chaos-ratelimit": "1" });
    await selection;
    mock.clearFixtures();
    expect(await pending).toBe(429);
    expect(mock.getFixtures()).toHaveLength(0);
    mock.onEmbedding("hello", { embedding: [0.1] });
    expect(await send(embedding)).toBe(200);
  });
});
