import { describe, test, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMock } from "../llmock.js";
import {
  clearElevenLabsVoices,
  handleElevenLabsVoiceDesign,
  handleElevenLabsVoiceGet,
  rememberElevenLabsVoice,
} from "../elevenlabs-voice.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import type { RecordConfig } from "../types.js";

const SEA_CAPTAIN = "A weathered sea captain in his sixties, gravelly, unhurried";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-voice-design-"));
}

function createUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("ElevenLabs Voice Design", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop. `mock` is assigned at the top of each test and started
    // a few lines later, so a test that throws in between leaves it
    // constructed but unstarted, and `LLMock.stop()` throws "Server not
    // started" — an afterEach throw that MASKS the real
    // assertion failure. Swallowing it is the convention here; see
    // wrapper-journal.test.ts:58 and byteplus-provider-base.test.ts:72.
    await mock?.stop().catch(() => {});
    mock = undefined;
    // The voice store is a MODULE GLOBAL (src/elevenlabs-voice.ts), not per
    // LLMock, so it outlives every server this file starts and `stop()` does
    // not touch it. Without this line "create miss under strict is 503
    // instead of synthesizing a voice" — whose whole point is that nothing was
    // remembered — passes alone and FAILS when it runs after "GET
    // /v1/voices/{id} returns a saved voice", which leaves preview_captain in
    // the store: the final GET returns 200 instead of 404.
    clearElevenLabsVoices();
  });

  test("design matches voice_description and returns previews JSON", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign(/sea captain/, {
      previews: [
        {
          generated_voice_id: "preview_captain",
          audio_base_64: "SGVsbG8=",
          media_type: "audio/mpeg",
          duration_secs: 1.2,
          language: "en",
        },
      ],
      text: "Ahoy there.",
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_description: SEA_CAPTAIN,
        model_id: "eleven_ttv_v3",
        auto_generate_text: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await res.json();
    expect(data.text).toBe("Ahoy there.");
    expect(data.previews).toHaveLength(1);
    expect(data.previews[0].generated_voice_id).toBe("preview_captain");
    expect(data.previews[0].audio_base_64).toBe("SGVsbG8=");
    expect(data.previews[0].media_type).toBe("audio/mpeg");
  });

  test("design substring match works without regex", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign("sea captain", {
      previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==" }],
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.previews[0].generated_voice_id).toBe("p1");
    expect(data.previews[0].media_type).toBe("audio/mpeg");
    expect(data.text).toBe("");
  });

  test("design missing voice_description returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: "eleven_ttv_v3" }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("voice_description");
  });

  test("design malformed JSON returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("Malformed JSON");
  });

  test("design no matching fixture returns 404", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign("sea captain", {
      previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==" }],
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: "a cheerful cartoon mouse" }),
    });

    expect(res.status).toBe(404);
  });

  test("design error fixture returns error status", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "rate limited", endpoint: "elevenlabs-voice-design" },
      response: { error: { message: "rate limit", type: "rate_limit_error" }, status: 429 },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: "rate limited voice description here" }),
    });

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error.message).toBe("rate limit");
  });

  test("design fixture does not match TTS", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign("Hello world", {
      previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==" }],
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello world" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("ElevenLabs Voice Design save + voices", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop. `mock` is assigned at the top of each test and started
    // a few lines later, so a test that throws in between leaves it
    // constructed but unstarted, and `LLMock.stop()` throws "Server not
    // started" — an afterEach throw that MASKS the real
    // assertion failure. Swallowing it is the convention here; see
    // wrapper-journal.test.ts:58 and byteplus-provider-base.test.ts:72.
    await mock?.stop().catch(() => {});
    mock = undefined;
    // The voice store is a MODULE GLOBAL (src/elevenlabs-voice.ts), not per
    // LLMock, so it outlives every server this file starts and `stop()` does
    // not touch it. Without this line "create miss under strict is 503
    // instead of synthesizing a voice" — whose whole point is that nothing was
    // remembered — passes alone and FAILS when it runs after "GET
    // /v1/voices/{id} returns a saved voice", which leaves preview_captain in
    // the store: the final GET returns 200 instead of 404.
    clearElevenLabsVoices();
  });

  test("save echoes generated_voice_id as a stable voice_id", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });

    expect(res.status).toBe(200);
    const voice = await res.json();
    expect(voice.voice_id).toBe("preview_captain");
    expect(voice.name).toBe("Captain");
    expect(voice.description).toBe(SEA_CAPTAIN);
    expect(voice.category).toBe("generated");
  });

  test("save then TTS with returned voice_id hits an existing TTS fixture", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign(/sea captain/, {
      previews: [{ generated_voice_id: "preview_captain", audio_base_64: "SGVsbG8=" }],
    });
    mock.onElevenLabsTTS("Ahoy", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    const designed = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });
    const previews = await designed.json();
    const generatedId = previews.previews[0].generated_voice_id;

    const saved = await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: generatedId,
      }),
    });
    const voice = await saved.json();

    const spoken = await fetch(`${mock.url}/v1/text-to-speech/${voice.voice_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Ahoy" }),
    });

    expect(spoken.status).toBe(200);
    expect(spoken.headers.get("content-type")).toBe("audio/mpeg");
    const buffer = await spoken.arrayBuffer();
    expect(buffer.byteLength).toBe(5);
  });

  test("save missing generated_voice_id returns 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain("generated_voice_id");
  });

  test("GET /v1/voices/{id} returns a saved voice", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });

    const res = await fetch(`${mock.url}/v1/voices/preview_captain`);
    expect(res.status).toBe(200);
    const voice = await res.json();
    expect(voice.voice_id).toBe("preview_captain");
    expect(voice.name).toBe("Captain");
  });

  test("GET unknown voice returns 404", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/voices/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("DELETE is idempotent on missing voice", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const first = await fetch(`${mock.url}/v1/voices/missing`, { method: "DELETE" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "ok" });

    const second = await fetch(`${mock.url}/v1/voices/missing`, { method: "DELETE" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "ok" });
  });

  test("DELETE removes a saved voice so GET 404s", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });

    const del = await fetch(`${mock.url}/v1/voices/preview_captain`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const get = await fetch(`${mock.url}/v1/voices/preview_captain`);
    expect(get.status).toBe(404);
  });

  test("reset clears saved voices", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });

    mock.reset();

    const res = await fetch(`${mock.url}/v1/voices/preview_captain`);
    expect(res.status).toBe(404);
  });
});

describe("ElevenLabs Voice Design record", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop. `mock` is assigned at the top of each test and started
    // a few lines later, so a test that throws in between leaves it
    // constructed but unstarted, and `LLMock.stop()` throws "Server not
    // started" — an afterEach throw that MASKS the real
    // assertion failure. Swallowing it is the convention here; see
    // wrapper-journal.test.ts:58 and byteplus-provider-base.test.ts:72.
    await mock?.stop().catch(() => {});
    mock = undefined;
    // The voice store is a MODULE GLOBAL (src/elevenlabs-voice.ts), not per
    // LLMock, so it outlives every server this file starts and `stop()` does
    // not touch it. Without this line "create miss under strict is 503
    // instead of synthesizing a voice" — whose whole point is that nothing was
    // remembered — passes alone and FAILS when it runs after "GET
    // /v1/voices/{id} returns a saved voice", which leaves preview_captain in
    // the store: the final GET returns 200 instead of 404.
    clearElevenLabsVoices();
  });

  test("records design JSON as a json fixture and replays it", async () => {
    const fixturePath = makeTmpDir();
    const upstreamPayload = {
      previews: [
        {
          generated_voice_id: "upstream_preview",
          audio_base_64: "SGVsbG8=",
          media_type: "audio/mpeg",
          duration_secs: 2.4,
          language: "en",
        },
      ],
      text: "Recorded preview text",
    };
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamPayload));
    });

    // The upstream server and the tmpdir are already live, so the `try` opens
    // BEFORE the mock is constructed: a `start()` rejection must still reach
    // the `finally` that closes them, and `afterEach` only stops the mock.
    try {
      mock = new LLMock({
        port: 0,
        record: { providers: { elevenlabs: url }, fixturePath },
      });
      await mock.start();

      const recorded = await fetch(`${mock.url}/v1/text-to-voice/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
      });
      expect(recorded.status).toBe(200);
      expect(await recorded.json()).toEqual(upstreamPayload);

      const fixtures = mock.getFixtures();
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].match.endpoint).toBe("elevenlabs-voice-design");
      expect(fixtures[0].match.userMessage).toBe(SEA_CAPTAIN);
      expect(fixtures[0].response).toEqual({ json: upstreamPayload, status: 200 });

      mock.disableRecording();
      const replayed = await fetch(`${mock.url}/v1/text-to-voice/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
      });
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(upstreamPayload);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

/**
 * Strict mode on the Voice Design surface. FOUR routes can refuse with a 503,
 * through two code paths: `missPath()` (shared by POST
 * /v1/text-to-voice/design and POST /v1/text-to-voice) and
 * `writeVoiceSlotStrictRefusal()` (shared by the miss branches of GET and
 * DELETE /v1/voices/{id}). Each of the four is reachable from a strict server
 * AND from a per-request `X-AIMock-Strict` override, and each must journal the
 * override. Without strict, the same misses answer 404 (design), a synthesized
 * voice (create), 404 (get) and an idempotent 200 (delete) — so the lenient
 * counterpart is asserted alongside every 503 to prove the guard fires only
 * where it should.
 */
describe("ElevenLabs Voice Design strict mode", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop. `mock` is assigned at the top of each test and started
    // a few lines later, so a test that throws in between leaves it
    // constructed but unstarted, and `LLMock.stop()` throws "Server not
    // started" — an afterEach throw that MASKS the real
    // assertion failure. Swallowing it is the convention here; see
    // wrapper-journal.test.ts:58 and byteplus-provider-base.test.ts:72.
    await mock?.stop().catch(() => {});
    mock = undefined;
    // The voice store is a MODULE GLOBAL (src/elevenlabs-voice.ts), not per
    // LLMock, so it outlives every server this file starts and `stop()` does
    // not touch it. Without this line "create miss under strict is 503
    // instead of synthesizing a voice" — whose whole point is that nothing was
    // remembered — passes alone and FAILS when it runs after "GET
    // /v1/voices/{id} returns a saved voice", which leaves preview_captain in
    // the store: the final GET returns 200 instead of 404.
    clearElevenLabsVoices();
  });

  interface ErrorEnvelope {
    error?: { message?: unknown; code?: unknown; type?: unknown };
  }

  async function readError(res: Response) {
    const json = (await res.json()) as ErrorEnvelope;
    return { message: json?.error?.message, code: json?.error?.code, type: json?.error?.type };
  }

  // `mock` is `LLMock | undefined` so afterEach can null it out; these helpers
  // run inside a test that has already assigned and started it. Narrow with a
  // real check rather than `!`, so a helper called before `start()` says so
  // instead of throwing an opaque property access.
  function started(): LLMock {
    if (!mock) throw new Error("test bug: helper used before the mock was started");
    return mock;
  }

  function lastEntry(path: string) {
    const entries = started()
      .journal.getAll()
      .filter((e) => e.path === path);
    return entries[entries.length - 1];
  }

  function design(headers: Record<string, string> = {}) {
    return fetch(`${started().url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });
  }

  function create(headers: Record<string, string> = {}) {
    return fetch(`${started().url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });
  }

  const STRICT = { "X-AIMock-Strict": "true" };
  const NOT_STRICT = { "X-AIMock-Strict": "false" };

  test("design miss on a strict server is 503, not 404", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    const res = await design();
    expect(res.status).toBe(503);
    const { message, code, type } = await readError(res);
    expect(message).toBe("Strict mode: no fixture matched");
    expect(code).toBe("no_fixture_match");
    expect(type).toBe("invalid_request_error");
    const entry = lastEntry("/v1/text-to-voice/design");
    expect(entry.response.status).toBe(503);
    expect(entry.response.strictOverride).toBeUndefined();
  });

  test("design miss with X-AIMock-Strict on a lenient server is 503 and journals the override", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    expect((await design()).status).toBe(404);

    const res = await design(STRICT);
    expect(res.status).toBe(503);
    expect((await readError(res)).code).toBe("no_fixture_match");
    expect(lastEntry("/v1/text-to-voice/design").response.strictOverride).toBe(true);
  });

  test("design header opt-out on a strict server restores the lenient 404", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    const res = await design(NOT_STRICT);
    expect(res.status).toBe(404);
    expect((await readError(res)).message).toBe("No fixture matched");
    expect(lastEntry("/v1/text-to-voice/design").response.strictOverride).toBe(false);
  });

  test("design hit under strict still returns the fixture 200", async () => {
    mock = new LLMock({ port: 0, strict: true });
    mock.onElevenLabsVoiceDesign(/sea captain/, {
      previews: [{ generated_voice_id: "preview_captain", audio_base_64: "SGVsbG8=" }],
      text: "Ahoy there.",
    });
    await mock.start();

    const res = await design();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe("Ahoy there.");
  });

  test("create miss under strict is 503 instead of synthesizing a voice", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    const res = await create();
    expect(res.status).toBe(503);
    expect((await readError(res)).code).toBe("no_fixture_match");
    expect(lastEntry("/v1/text-to-voice").response.status).toBe(503);

    // The 503 must be a refusal, not a silent save: nothing was remembered.
    const get = await fetch(`${mock.url}/v1/voices/preview_captain`, { headers: NOT_STRICT });
    expect(get.status).toBe(404);
  });

  test("create miss with X-AIMock-Strict on a lenient server is 503 and journals the override", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    expect((await create()).status).toBe(200);

    const res = await create(STRICT);
    expect(res.status).toBe(503);
    expect(lastEntry("/v1/text-to-voice").response.strictOverride).toBe(true);
  });

  test("GET an unknown voice under strict is 503 with the voice-scoped message", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/voices/unknown_voice`);
    expect(res.status).toBe(503);
    const { message, code } = await readError(res);
    // The refusal NAMES strict mode, like every other strict refusal in the
    // repo — a 503 here must not read like the route's own not-found answer.
    expect(message).toBe("Strict mode: voice 'unknown_voice' not found");
    expect(code).toBe("no_fixture_match");
    expect(lastEntry("/v1/voices/unknown_voice").response.status).toBe(503);
  });

  test("GET an unknown voice with X-AIMock-Strict is 503 and journals the override", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const lenient = await fetch(`${mock.url}/v1/voices/unknown_voice`);
    expect(lenient.status).toBe(404);
    expect((await readError(lenient)).code).toBe("voice_not_found");

    const res = await fetch(`${mock.url}/v1/voices/unknown_voice`, { headers: STRICT });
    expect(res.status).toBe(503);
    expect((await readError(res)).code).toBe("no_fixture_match");
    expect(lastEntry("/v1/voices/unknown_voice").response.strictOverride).toBe(true);
  });

  test("GET a saved voice under strict still returns it", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    // The save itself needs the lenient path; strict would refuse it.
    const saved = await create(NOT_STRICT);
    expect(saved.status).toBe(200);

    const res = await fetch(`${mock.url}/v1/voices/preview_captain`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { voice_id: string }).voice_id).toBe("preview_captain");
  });
});

/**
 * `GET /v1/voices/{id}` as a first-class record/replay route.
 *
 * It used to be neither: it never consulted the fixture store, and in record
 * mode it handed `proxyAndRecord` a throwaway `[]`, so the fixture the
 * recorder pushed back was discarded and every repeat GET re-hit upstream.
 * Each test below pins one half of that, and the stub hit COUNT is the
 * load-bearing assertion for the record case — a response body alone cannot
 * tell "served locally" from "proxied again".
 */
describe("ElevenLabs voice GET record + replay", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop and a module-global store clear, both for the reasons
    // spelled out on the first describe in this file.
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  test("a registered fixture serves GET /v1/voices/{id}", async () => {
    const voice = { voice_id: "voice_from_fixture", name: "Fixture Voice", category: "generated" };
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "voice_from_fixture", endpoint: "elevenlabs-voice-get" },
      response: { json: voice },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/voices/voice_from_fixture`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(voice);
  });

  test("a recorded GET is served locally on the next call and replays after recording stops", async () => {
    const fixturePath = makeTmpDir();
    const voice = { voice_id: "voice_recorded", name: "Upstream Voice", category: "generated" };
    let upstreamHits = 0;
    const { server, url } = await createUpstream((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(voice));
    });

    // The upstream server and the tmpdir are already live, so the `try` opens
    // BEFORE the mock is constructed: a `start()` rejection must still reach
    // the `finally` that closes them, and `afterEach` only stops the mock.
    try {
      mock = new LLMock({
        port: 0,
        record: { providers: { elevenlabs: url }, fixturePath },
      });
      await mock.start();

      const first = await fetch(`${mock.url}/v1/voices/voice_recorded`);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual(voice);
      expect(upstreamHits).toBe(1);

      const fixtures = mock.getFixtures();
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].match.endpoint).toBe("elevenlabs-voice-get");
      expect(fixtures[0].match.userMessage).toBe("voice_recorded");

      // The proxied GET also REMEMBERED the voice in the module-global store,
      // which is consulted by this same route — so a second GET answering
      // without a new upstream hit would be satisfied by the store alone and
      // would say nothing about the recording. Clearing the store first makes
      // the recorded FIXTURE the only thing left that can answer.
      clearElevenLabsVoices();

      // Still in record mode: the second GET must NOT reach upstream again.
      const second = await fetch(`${mock.url}/v1/voices/voice_recorded`);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(voice);
      expect(upstreamHits).toBe(1);

      mock.disableRecording();
      clearElevenLabsVoices();
      const replayed = await fetch(`${mock.url}/v1/voices/voice_recorded`);
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(voice);
      expect(upstreamHits).toBe(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("a fixture recorded on disk replays on a fresh server", async () => {
    const fixturePath = makeTmpDir();
    const voice = { voice_id: "voice_on_disk", name: "Disk Voice", category: "generated" };
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(voice));
    });

    let recorder: LLMock | undefined;
    try {
      recorder = new LLMock({ port: 0, record: { providers: { elevenlabs: url }, fixturePath } });
      await recorder.start();
      expect((await fetch(`${recorder.url}/v1/voices/voice_on_disk`)).status).toBe(200);
      await recorder.stop();
      recorder = undefined;

      const written = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(written).toHaveLength(1);

      // Fresh process-equivalent: nothing in the in-memory voice store, only disk.
      mock = new LLMock({ port: 0 });
      mock.addFixturesFromJSON(
        JSON.parse(fs.readFileSync(path.join(fixturePath, written[0]), "utf-8")).fixtures,
      );
      await mock.start();

      const replayed = await fetch(`${mock.url}/v1/voices/voice_on_disk`);
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(voice);
    } finally {
      await recorder?.stop();
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("a GET-recorded fixture does not hijack POST /v1/text-to-voice", async () => {
    const fixturePath = makeTmpDir();
    const voice = { voice_id: "no_hijack", name: "Upstream GET Voice", category: "generated" };
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(voice));
    });

    let recorder: LLMock | undefined;
    try {
      recorder = new LLMock({ port: 0, record: { providers: { elevenlabs: url }, fixturePath } });
      await recorder.start();
      expect((await fetch(`${recorder.url}/v1/voices/no_hijack`)).status).toBe(200);
      const recorded = recorder.getFixtures().map((f) => ({ ...f }));
      expect(recorded).toHaveLength(1);
      await recorder.stop();
      recorder = undefined;

      // Replay only the GET recording. A create for the SAME id must fall
      // through to the synthesized voice — while GET and create shared one
      // endpoint type, this fixture answered the create instead.
      mock = new LLMock({ port: 0 });
      mock.addFixtures(recorded);
      await mock.start();

      const created = await fetch(`${mock.url}/v1/text-to-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_name: "My Own Voice",
          voice_description: SEA_CAPTAIN,
          generated_voice_id: "no_hijack",
        }),
      });
      expect(created.status).toBe(200);
      expect(((await created.json()) as { name: string }).name).toBe("My Own Voice");
    } finally {
      await recorder?.stop();
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("a proxied create is remembered, so a GET off record mode is served locally", async () => {
    const fixturePath = makeTmpDir();
    const voice = { voice_id: "proxied_create", name: "Proxied Voice", category: "generated" };
    let upstreamHits = 0;
    const { server, url } = await createUpstream((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(voice));
    });

    // The `try` opens BEFORE the mock is constructed: a `start()` rejection
    // must still reach the `finally` that closes the upstream server and
    // removes the tmpdir, and `afterEach` only stops the mock.
    try {
      mock = new LLMock({ port: 0, record: { providers: { elevenlabs: url }, fixturePath } });
      await mock.start();

      const created = await fetch(`${mock.url}/v1/text-to-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_name: "Proxied Voice",
          voice_description: SEA_CAPTAIN,
          generated_voice_id: "proxied_create",
        }),
      });
      expect(created.status).toBe(200);
      expect(upstreamHits).toBe(1);

      // RECORDING IS TURNED OFF FIRST, on purpose. While it is on the store is
      // NOT authoritative and the GET is forwarded so the tape gets its
      // `elevenlabs-voice-get` entry — that is its own test, "record mode
      // forwards a GET for a locally-known voice and records it". What this
      // test pins is the other half: the PROXY path really did remember the
      // created voice, which is only visible once record mode stops shadowing
      // the store.
      mock.disableRecording();

      const fetched = await fetch(`${mock.url}/v1/voices/proxied_create`);
      expect(fetched.status).toBe(200);
      expect(await fetched.json()).toEqual(voice);
      expect(upstreamHits).toBe(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

/**
 * The slot routes (GET/DELETE /v1/voices/{id}) must follow the SAME discipline
 * as design/create, not a hand-authored shortcut:
 *   - a chaos gate runs first, so configured latency/drop/429 reach them;
 *   - strict is evaluated BEFORE record, the precedence `missPath()` uses, so a
 *     strict server refuses a miss instead of proxying it upstream;
 *   - the strict refusal is logged and says "strict";
 *   - DELETE takes `defaults` at all, so record mode forwards it upstream
 *     instead of answering an unconditional local 200.
 * Each test below measures the real wire (status, elapsed ms, upstream hit
 * count, captured log), never an internal call.
 */
describe("ElevenLabs voice slot routes follow the shared handler discipline", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop and a module-global store clear, both for the reasons
    // spelled out on the first describe in this file.
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  const LATENCY_MS = 200;
  const DELAYED_MIN = 150;
  const UNDELAYED_MAX = 120;

  async function timed(url: string, init?: RequestInit) {
    const t0 = Date.now();
    const res = await fetch(url, init);
    await res.text();
    return { ms: Date.now() - t0, status: res.status };
  }

  async function saveVoice(url: string, headers: Record<string, string> = {}) {
    return fetch(`${url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: "preview_captain",
      }),
    });
  }

  test("DELETE of an unknown voice under strict is a logged 503, not a silent 200", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mock = new LLMock({ port: 0, strict: true, logLevel: "warn" });
      await mock.start();

      const res = await fetch(`${mock.url}/v1/voices/unknown_voice`, { method: "DELETE" });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      expect(body.error?.code).toBe("no_fixture_match");
      expect(body.error?.message).toBe("Strict mode: voice 'unknown_voice' not found");

      const entries = mock.journal.getAll().filter((e) => e.method === "DELETE");
      expect(entries[entries.length - 1].response.status).toBe(503);

      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("STRICT");
      expect(logged).toContain("/v1/voices/unknown_voice");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("DELETE with X-AIMock-Strict on a lenient server is 503 and journals the override", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const lenient = await fetch(`${mock.url}/v1/voices/unknown_voice`, { method: "DELETE" });
    expect(lenient.status).toBe(200);

    const res = await fetch(`${mock.url}/v1/voices/unknown_voice`, {
      method: "DELETE",
      headers: { "X-AIMock-Strict": "true" },
    });
    expect(res.status).toBe(503);
    const entries = mock.journal.getAll().filter((e) => e.method === "DELETE");
    expect(entries[entries.length - 1].response.strictOverride).toBe(true);
  });

  test("DELETE of a SAVED voice under strict still succeeds", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    expect((await saveVoice(mock.url, { "X-AIMock-Strict": "false" })).status).toBe(200);

    const res = await fetch(`${mock.url}/v1/voices/preview_captain`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("the configured chaos latency delays GET and DELETE", async () => {
    mock = new LLMock({ port: 0, chaos: { latencyMs: LATENCY_MS } });
    await mock.start();

    const get = await timed(`${mock.url}/v1/voices/unknown_voice`);
    expect(get.status).toBe(404);
    expect(get.ms).toBeGreaterThanOrEqual(DELAYED_MIN);

    const del = await timed(`${mock.url}/v1/voices/unknown_voice`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(del.ms).toBeGreaterThanOrEqual(DELAYED_MIN);

    // Negative control: the same routes on a server with no chaos configured.
    await mock.stop();
    mock = new LLMock({ port: 0 });
    await mock.start();
    const fastGet = await timed(`${mock.url}/v1/voices/unknown_voice`);
    // The STATUS is asserted here too: a server that 500s quickly would satisfy
    // an elapsed-time-only control while proving nothing about the latency gate.
    expect(fastGet.status).toBe(404);
    expect(fastGet.ms).toBeLessThan(UNDELAYED_MAX);
    const fastDel = await timed(`${mock.url}/v1/voices/unknown_voice`, { method: "DELETE" });
    expect(fastDel.status).toBe(200);
    expect(fastDel.ms).toBeLessThan(UNDELAYED_MAX);
  });

  test("chaos rateLimit reaches GET and DELETE", async () => {
    mock = new LLMock({ port: 0, chaos: { rateLimitRate: 1 } });
    await mock.start();

    expect((await fetch(`${mock.url}/v1/voices/unknown_voice`)).status).toBe(429);
    expect((await fetch(`${mock.url}/v1/voices/unknown_voice`, { method: "DELETE" })).status).toBe(
      429,
    );
  });

  test("a strict GET miss refuses instead of proxying upstream", async () => {
    let upstreamHits = 0;
    const { server, url } = await createUpstream((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ voice_id: "from_upstream" }));
    });
    const fixturePath = makeTmpDir();

    try {
      mock = new LLMock({
        port: 0,
        strict: true,
        record: { providers: { elevenlabs: url }, fixturePath },
      });
      await mock.start();

      const res = await fetch(`${mock.url}/v1/voices/unknown_voice`);
      expect(res.status).toBe(503);
      // Strict beats record: the miss was REFUSED, never forwarded.
      expect(upstreamHits).toBe(0);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("record-mode DELETE forwards upstream and relays the real response", async () => {
    let upstreamHits = 0;
    let seenMethod = "";
    let seenPath = "";
    const { server, url } = await createUpstream((req, res) => {
      upstreamHits += 1;
      seenMethod = req.method ?? "";
      seenPath = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    const fixturePath = makeTmpDir();

    try {
      mock = new LLMock({
        port: 0,
        record: { providers: { elevenlabs: url }, fixturePath },
      });
      await mock.start();

      const res = await fetch(`${mock.url}/v1/voices/upstream_voice`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(upstreamHits).toBe(1);
      expect(seenMethod).toBe("DELETE");
      expect(seenPath).toBe("/v1/voices/upstream_voice");
      // The SDK's DeleteVoiceResponseModel carries exactly `status`.
      expect(await res.json()).toEqual({ status: "ok" });

      const entries = mock.journal.getAll().filter((e) => e.method === "DELETE");
      expect(entries[entries.length - 1].response.source).toBe("proxy");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

/**
 * Replay fidelity on the two JSON-replaying Voice Design routes.
 *
 * `proxyAndRecord` persists the upstream status alongside the verbatim body for
 * this surface (`src/recorder.ts:901`), so every recorded ElevenLabs error —
 * all of which carry a `detail` body, which aimock's `isErrorResponse()` never
 * claims — arrives as a `{ json, status }` fixture. Replaying those as 200 is a
 * fabricated success, which is exactly what a mock exists to prevent. That
 * recorder branch stores no headers, so `status` is the only recorded response
 * metadatum there is to honour.
 *
 * The create route additionally feeds the voice store, so the status it honours
 * also decides whether a voice was created at all, and a 2xx body with no
 * string `voice_id` must name itself rather than 404 the follow-up GET in
 * silence.
 */
describe("ElevenLabs Voice Design replay fidelity", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop and a module-global store clear, both for the reasons
    // spelled out on the first describe in this file.
    await mock?.stop().catch(() => {});
    mock = undefined;
    vi.restoreAllMocks();
    clearElevenLabsVoices();
  });

  // `mock` is `LLMock | undefined` so afterEach can null it out; these helpers
  // run inside a test that has already assigned and started it.
  function started(): LLMock {
    if (!mock) throw new Error("test bug: helper used before the mock was started");
    return mock;
  }

  function create(generatedVoiceId = "preview_captain") {
    return fetch(`${started().url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: generatedVoiceId,
      }),
    });
  }

  function lastEntry(path: string) {
    const entries = started()
      .journal.getAll()
      .filter((e) => e.path === path);
    return entries[entries.length - 1];
  }

  test("a recorded non-200 design replays with its recorded status and body", async () => {
    mock = new LLMock({ port: 0 });
    // Exactly what recorder.ts writes for a real 422 from api.elevenlabs.io:
    // the upstream `detail` envelope, verbatim, under the upstream status.
    mock.addFixture({
      match: { userMessage: "sea captain", endpoint: "elevenlabs-voice-design" },
      response: {
        json: {
          detail: [{ type: "string_too_short", loc: ["body", "voice_description"] }],
        },
        status: 422,
      },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail?: unknown[] };
    expect(Array.isArray(body.detail)).toBe(true);
    expect(lastEntry("/v1/text-to-voice/design").response.status).toBe(422);
  });

  test("a recorded non-200 create replays with its recorded status and creates no voice", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "preview_captain", endpoint: "elevenlabs-voice" },
      response: {
        json: {
          detail: {
            type: "authentication_error",
            code: "unauthorized",
            message: "Neither authorization header nor xi-api-key received, please provide one.",
          },
          voice_id: "should_not_be_stored",
        },
        status: 401,
      },
    });
    await mock.start();

    const res = await create();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail?: { code?: string } };
    expect(body.detail?.code).toBe("unauthorized");
    expect(lastEntry("/v1/text-to-voice").response.status).toBe(401);

    // A refused create created nothing.
    const get = await fetch(`${mock.url}/v1/voices/should_not_be_stored`);
    expect(get.status).toBe(404);
  });

  test("a recorded 201 create replays as 201 and still stores the voice", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "preview_captain", endpoint: "elevenlabs-voice" },
      response: { json: { voice_id: "fx_1", name: "Fixture Voice" }, status: 201 },
    });
    await mock.start();

    const res = await create();
    expect(res.status).toBe(201);
    expect(((await res.json()) as { voice_id: string }).voice_id).toBe("fx_1");

    const get = await fetch(`${mock.url}/v1/voices/fx_1`);
    expect(get.status).toBe(200);
  });

  test("a 2xx create fixture with no string voice_id is served, and says so", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "preview_captain", endpoint: "elevenlabs-voice" },
      response: { json: { name: "Nameless", category: "generated" } },
    });
    await mock.start();

    // Servable, so it is served — the authoring defect is named, not swallowed
    // and not turned into a 500.
    const res = await create();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("Nameless");

    const warned = warnSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(warned).toContain("carries no string `voice_id`");
    expect(warned).toContain("preview_captain");
  });

  test("a non-string voice_id in a create fixture is named too", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "preview_captain", endpoint: "elevenlabs-voice" },
      response: { json: { voice_id: 12345, name: "Numeric" } },
    });
    await mock.start();

    expect((await create()).status).toBe(200);
    const warned = warnSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(warned).toContain("carries no string `voice_id`");
  });

  test("a well-formed create fixture stores the voice and warns about nothing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock = new LLMock({ port: 0, logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "preview_captain", endpoint: "elevenlabs-voice" },
      response: { json: { voice_id: "fx_ok", name: "Fine" } },
    });
    await mock.start();

    expect((await create()).status).toBe(200);
    const get = await fetch(`${mock.url}/v1/voices/fx_ok`);
    expect(get.status).toBe(200);
    const warned = warnSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(warned).not.toContain("carries no string `voice_id`");
  });

  test("the voice store is keyed by the voice_id the CLIENT received", async () => {
    mock = new LLMock({ port: 0 });
    // A generated_voice_id unique to this test: the voice store is a module
    // singleton shared by every test in this file, so a reused id would make
    // the negative assertion below depend on test ORDER rather than on the
    // store's keying.
    const generated = "fidelity_preview_unstored";
    mock.addFixture({
      match: { userMessage: generated, endpoint: "elevenlabs-voice" },
      response: { json: { voice_id: "srv_123", name: "Server Named" } },
    });
    await mock.start();

    const res = await create(generated);
    const seen = ((await res.json()) as { voice_id: string }).voice_id;
    expect(seen).toBe("srv_123");

    // The id the client holds resolves; the request's generated_voice_id, which
    // the client never saw come back, does not. Pinned so a refactor cannot
    // quietly invert it.
    expect((await fetch(`${mock.url}/v1/voices/${seen}`)).status).toBe(200);
    expect((await fetch(`${mock.url}/v1/voices/${generated}`)).status).toBe(404);
  });

  test("a status-less JSON fixture still replays as 200 (default preserved)", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "sea captain", endpoint: "elevenlabs-voice-design" },
      response: { json: { previews: [], text: "Ahoy." } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });
    expect(res.status).toBe(200);
    expect(lastEntry("/v1/text-to-voice/design").response.status).toBe(200);
  });
});

/**
 * Coverage the three behaviour fixes above do not carry (finding E7). Every
 * test here pins a branch of `src/elevenlabs-voice.ts` that nothing else in
 * this file reaches:
 *   - create in RECORD mode (design and DELETE record are covered above; the
 *     create record test above proves the store hand-off, not the recording);
 *   - the exact key set `buildSyntheticVoice()` authors, against the SDK's
 *     `Voice.Raw`;
 *   - the three `server_error` 500s each replay route answers when a matched
 *     fixture cannot be served as JSON;
 *   - the chaos gate on design and on create (only the slot routes were
 *     measured above);
 *   - `voiceDesignToJson()`'s per-field fallbacks, driven through the public
 *     `onElevenLabsVoiceDesign()` registration that calls it;
 *   - create's fixture-hit ERROR branch.
 * All of them drive the real wire.
 */
describe("ElevenLabs voice design coverage gaps", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop and a module-global store clear, both for the reasons
    // spelled out on the first describe in this file.
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  // `mock` is `LLMock | undefined` so afterEach can null it out; these helpers
  // run inside a test that has already assigned and started it.
  function started(): LLMock {
    if (!mock) throw new Error("test bug: helper used before the mock was started");
    return mock;
  }

  function create(generatedVoiceId = "preview_captain", url = started().url) {
    return fetch(`${url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Captain",
        voice_description: SEA_CAPTAIN,
        generated_voice_id: generatedVoiceId,
      }),
    });
  }

  function design(url = started().url) {
    return fetch(`${url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });
  }

  test("a recorded create is written as an elevenlabs-voice fixture and replays after recording stops", async () => {
    const fixturePath = makeTmpDir();
    const upstreamVoice = { voice_id: "recorded_create", name: "Recorded Voice" };
    let upstreamHits = 0;
    const { server, url } = await createUpstream((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamVoice));
    });

    // The `try` opens BEFORE the mock is constructed: a `start()` rejection
    // must still reach the `finally` that closes the upstream server and
    // removes the tmpdir, and `afterEach` only stops the mock.
    try {
      mock = new LLMock({ port: 0, record: { providers: { elevenlabs: url }, fixturePath } });
      await mock.start();

      const recorded = await create("recorded_create");
      expect(recorded.status).toBe(200);
      expect(await recorded.json()).toEqual(upstreamVoice);
      expect(upstreamHits).toBe(1);

      // The recording itself: create declares its OWN endpoint type and matches
      // on the generated_voice_id, and the fixture must be pushed back into the
      // live array or the replay below re-hits upstream.
      const fixtures = mock.getFixtures();
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].match.endpoint).toBe("elevenlabs-voice");
      expect(fixtures[0].match.userMessage).toBe("recorded_create");
      expect(fixtures[0].response).toEqual({ json: upstreamVoice, status: 200 });

      mock.disableRecording();
      const replayed = await create("recorded_create");
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(upstreamVoice);
      expect(upstreamHits).toBe(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("the synthesized voice carries exactly the Voice.Raw keys aimock claims to author", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await create("preview_captain");
    expect(res.status).toBe(200);
    const voice = (await res.json()) as Record<string, unknown>;

    // SECONDARY, read firsthand from the npm tarball of
    // @elevenlabs/elevenlabs-js@2.68.0 at
    // serialization/types/Voice.d.ts -> `namespace Voice { interface Raw }`.
    // That is the on-wire (snake_case) shape; api/types/Voice.d.ts is its
    // camelCase client-side twin and is NOT what a raw HTTP client sees.
    const VOICE_RAW_KEYS = [
      "voice_id",
      "name",
      "samples",
      "category",
      "fine_tuning",
      "labels",
      "description",
      "preview_url",
      "available_for_tiers",
      "settings",
      "sharing",
      "high_quality_base_model_ids",
      "verified_languages",
      "collection_ids",
      "safety_control",
      "voice_verification",
      "permission_on_resource",
      "is_owner",
      "is_legacy",
      "is_mixed",
      "favorited_at_unix",
      "created_at_unix",
      "is_bookmarked",
      "recording_quality",
      "labelling_status",
      "recording_quality_reason",
    ];

    // The EXACT set aimock emits, in emission order. Change this list only
    // together with buildSyntheticVoice() and the provenance block.
    expect(Object.keys(voice)).toEqual([
      "voice_id",
      "name",
      "category",
      "description",
      "labels",
      "preview_url",
      "available_for_tiers",
      "settings",
      "sharing",
      "high_quality_base_model_ids",
      "samples",
      "safety_control",
      "voice_verification",
      "permission_on_resource",
      "is_owner",
      "is_legacy",
      "is_mixed",
    ]);

    // Nothing invented: every key emitted is a real Voice.Raw field.
    expect(Object.keys(voice).filter((k) => !VOICE_RAW_KEYS.includes(k))).toEqual([]);

    // And the declared debt: the fields a consumer reads back as undefined.
    expect(VOICE_RAW_KEYS.filter((k) => !(k in voice))).toEqual([
      "fine_tuning",
      "verified_languages",
      "collection_ids",
      "favorited_at_unix",
      "created_at_unix",
      "is_bookmarked",
      "recording_quality",
      "labelling_status",
      "recording_quality_reason",
    ]);

    // VoiceVerificationResponse.Raw's four REQUIRED fields, no more: `language`
    // and `verification_attempts` are optional there and are not authored.
    expect(Object.keys(voice.voice_verification as Record<string, unknown>)).toEqual([
      "requires_verification",
      "is_verified",
      "verification_failures",
      "verification_attempts_count",
    ]);
  });

  test("a design fixture whose response is not a JSON type is a 500 server_error", async () => {
    mock = new LLMock({ port: 0 });
    // A plausible mis-authoring: an ElevenLabs TTS audio response registered
    // against the voice-design endpoint. Neither an error nor a JSON response,
    // so the route cannot serve it at all.
    mock.addFixture({
      match: { userMessage: "sea captain", endpoint: "elevenlabs-voice-design" },
      response: { audio: "SGVsbG8=" },
    });
    await mock.start();

    const res = await design();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string; type?: string } };
    expect(body.error?.type).toBe("server_error");
    expect(body.error?.message).toBe("Fixture response is not a JSON type for voice design");
  });

  test("a create fixture whose response is not a JSON type is a 500 server_error", async () => {
    mock = new LLMock({ port: 0 });
    // The id is unique to this test on purpose: the voice store is a module
    // singleton shared across this whole file, so reusing `preview_captain`
    // would make the "nothing was stored" assertion depend on test ORDER.
    mock.addFixture({
      match: { userMessage: "unservable_create", endpoint: "elevenlabs-voice" },
      response: { audio: "SGVsbG8=" },
    });
    await mock.start();

    const res = await create("unservable_create");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string; type?: string } };
    expect(body.error?.type).toBe("server_error");
    expect(body.error?.message).toBe("Fixture response is not a JSON type for voice create");

    // Nothing was stored off an unservable fixture.
    expect((await fetch(`${mock.url}/v1/voices/unservable_create`)).status).toBe(404);
  });

  test("a GET fixture whose response is not a JSON type is a 500 server_error", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "unservable_voice", endpoint: "elevenlabs-voice-get" },
      response: { audio: "SGVsbG8=" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/voices/unservable_voice`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string; type?: string } };
    expect(body.error?.type).toBe("server_error");
    expect(body.error?.message).toBe("Fixture response is not a JSON type for voice get");
  });

  test("the chaos gate reaches POST /v1/text-to-voice/design", async () => {
    mock = new LLMock({ port: 0, chaos: { rateLimitRate: 1 } });
    mock.onElevenLabsVoiceDesign("sea captain", {
      previews: [{ generated_voice_id: "preview_captain" }],
      text: "Ahoy.",
    });
    await mock.start();

    // The gate runs even though a fixture MATCHED — chaos is not a miss path.
    expect((await design()).status).toBe(429);

    // Negative control: the same request on a chaos-free server is served.
    await mock.stop();
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign("sea captain", {
      previews: [{ generated_voice_id: "preview_captain" }],
      text: "Ahoy.",
    });
    await mock.start();
    expect((await design()).status).toBe(200);
  });

  test("the chaos gate reaches POST /v1/text-to-voice", async () => {
    mock = new LLMock({ port: 0, chaos: { rateLimitRate: 1 } });
    await mock.start();

    expect((await create("chaos_refused_create")).status).toBe(429);

    // The refused create synthesized nothing. Asking THIS server would prove
    // nothing: `rateLimitRate: 1` refuses every request, including the GET, so
    // a 429 there holds whether or not the create stored a voice. The store is
    // a MODULE GLOBAL that outlives the server, so the question is asked on a
    // chaos-free one instead, where the store is really consulted.
    await mock.stop();
    mock = new LLMock({ port: 0 });
    await mock.start();
    expect((await fetch(`${mock.url}/v1/voices/chaos_refused_create`)).status).toBe(404);

    expect((await create()).status).toBe(200);
  });

  test("voiceDesignToJson fills every omitted preview field with its documented fallback", async () => {
    mock = new LLMock({ port: 0 });
    // Only the required-by-nothing minimum: an empty generated_voice_id and no
    // audio, media type, duration, language or text at all.
    mock.onElevenLabsVoiceDesign("sea captain", {
      previews: [{ generated_voice_id: "" }],
    });
    await mock.start();

    const res = await design();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      previews: [
        {
          generated_voice_id: "aimock-preview-0",
          audio_base_64: "",
          media_type: "audio/mpeg",
          duration_secs: 0,
        },
      ],
      text: "",
    });
    // `language` is OMITTED, not defaulted: the SDK models it `language?:
    // string`, so an absent language means an absent key. `toEqual` above
    // already fails on a surplus key; this names the intent.
    const preview = ((await design().then((r) => r.json())) as { previews: object[] }).previews[0];
    expect(Object.hasOwn(preview, "language")).toBe(false);
  });

  test("a create fixture carrying an error response replays its status and stores nothing", async () => {
    mock = new LLMock({ port: 0 });
    // Unique id again — see the note on the unservable-create test above.
    mock.addFixture({
      match: { userMessage: "errored_create", endpoint: "elevenlabs-voice" },
      response: { error: { message: "Too many requests", type: "rate_limit_error" }, status: 429 },
    });
    await mock.start();

    const res = await create("errored_create");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("Too many requests");

    const entries = mock.journal.getAll().filter((e) => e.path === "/v1/text-to-voice");
    expect(entries[entries.length - 1].response.status).toBe(429);

    expect((await fetch(`${mock.url}/v1/voices/errored_create`)).status).toBe(404);
  });
});

/**
 * Wire-value fidelity for the Voice Design surface: the values this handler
 * AUTHORS have to match what the real API and `@elevenlabs/elevenlabs-js` can
 * actually produce, or be declared as aimock's own invention. Each case below
 * pins one such value against a cited source; see the PROVENANCE block at the
 * top of `src/elevenlabs-voice.ts`.
 */
describe("ElevenLabs Voice Design wire values", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop and a module-global store clear, both for the reasons
    // spelled out on the first describe in this file.
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  // `mock` is `LLMock | undefined` so afterEach can null it out; these helpers
  // run inside a test that has already assigned and started it.
  function started(): LLMock {
    if (!mock) throw new Error("test bug: helper used before the mock was started");
    return mock;
  }

  // 38 characters — comfortably OVER the 20-code-point minimum, not at it. The
  // boundary itself is pinned by the 19/20 cases below; this constant exists
  // only so the cases that are NOT about length clear the validator.
  const WELL_OVER_MINIMUM = "a description of exactly enough length";

  function design(voiceDescription: string) {
    return fetch(`${started().url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: voiceDescription }),
    });
  }

  // FIRSTHAND: live api.elevenlabs.io rejects a sub-20-character
  // voice_description with 422 + a pydantic `detail` array, before auth.
  test("design rejects a voice_description under 20 characters with the real 422 envelope", async () => {
    mock = new LLMock({ port: 0 });
    // NO fixture for "short": the local minimum is the LAST resort, after
    // fixture matching and after the record/strict path, so a registered
    // short-description fixture would (correctly) serve instead of 422ing.
    await mock.start();

    const res = await design("short");

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      detail?: Array<{ loc?: unknown; msg?: unknown; type?: unknown }>;
      error?: unknown;
    };
    // Keyed `detail`, never aimock's house `error` envelope, for this one field.
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.detail)).toBe(true);
    expect(body.detail).toHaveLength(1);
    // Key set pinned by @elevenlabs/elevenlabs-js@2.68.0
    // api/types/ValidationError.d.ts -> { loc, msg, type }.
    expect(Object.keys(body.detail![0]).sort()).toEqual(["loc", "msg", "type"]);
    expect(body.detail![0].loc).toEqual(["body", "voice_description"]);
    expect(body.detail![0].type).toBe("string_too_short");
    expect(body.detail![0].msg).toContain("20");
  });

  test("the 20-character boundary is exclusive below and inclusive at 20", async () => {
    mock = new LLMock({ port: 0 });
    // Keyed on the 20-character string, not on "x": a fixture that also
    // matched the 19-character request would serve it (fixtures are consulted
    // before the minimum) and the boundary would stop being measured.
    mock.onElevenLabsVoiceDesign("x".repeat(20), {
      previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==" }],
    });
    await mock.start();

    expect("x".repeat(19).length).toBe(19);
    expect((await design("x".repeat(19))).status).toBe(422);
    expect((await design("x".repeat(20))).status).toBe(200);
  });

  test("a too-short voice_description is journalled as a 422, not a 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    await design("short");

    const entries = mock.journal.getAll().filter((e) => e.path === "/v1/text-to-voice/design");
    expect(entries[entries.length - 1].response.status).toBe(422);
  });

  // A missing voice_description is a DIFFERENT failure whose real shape this
  // repo has never observed; it must keep aimock's house 400 envelope.
  test("a missing voice_description still answers the house 400, not the 422", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string }; detail?: unknown };
    expect(body.detail).toBeUndefined();
    expect(body.error?.message).toContain("voice_description");
  });

  // `language` is `language?: string` in api/types/VoicePreviewResponseModel.d.ts
  // — absent or a string, never null. The SDK's runtime schema parses an
  // incoming null away, so a null is a value no consumer can ever observe.
  test("a preview with no language omits the key rather than emitting null", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign("sea captain", {
      previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==" }],
    });
    await mock.start();

    const res = await design(SEA_CAPTAIN);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('"language"');
    const preview = (JSON.parse(raw) as { previews: Record<string, unknown>[] }).previews[0];
    expect(Object.prototype.hasOwnProperty.call(preview, "language")).toBe(false);
  });

  test("a preview WITH a language still carries it through", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign("sea captain", {
      previews: [{ generated_voice_id: "p1", audio_base_64: "QQ==", language: "en" }],
    });
    await mock.start();

    const res = await design(SEA_CAPTAIN);
    const preview = ((await res.json()) as { previews: Record<string, unknown>[] }).previews[0];
    expect(preview.language).toBe("en");
  });

  // AUTHORED: overwrite-and-200 on a reused generated_voice_id. The real
  // behaviour is unknown, so the one thing under test is that it is AUDIBLE.
  test("re-creating a voice with the same generated_voice_id warns instead of overwriting silently", async () => {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      mock = new LLMock({ port: 0, logLevel: "warn" });
      await mock.start();

      const save = (voiceName: string) =>
        fetch(`${started().url}/v1/text-to-voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            voice_name: voiceName,
            voice_description: WELL_OVER_MINIMUM,
            generated_voice_id: "preview_dup",
          }),
        });

      expect((await save("First")).status).toBe(200);
      expect(warnings.filter((w) => w.includes("preview_dup"))).toHaveLength(0);

      const second = await save("Second");
      expect(second.status).toBe(200);
      const overwriteWarnings = warnings.filter(
        (w) => w.includes("preview_dup") && w.includes("overwritten"),
      );
      expect(overwriteWarnings).toHaveLength(1);

      const stored = await fetch(`${mock.url}/v1/voices/preview_dup`);
      expect(((await stored.json()) as { name: string }).name).toBe("Second");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * The slot routes (`GET`/`DELETE /v1/voices/{id}`) as COMPOSED record/replay
 * routes. Each of the routes was made a replay route in isolation, and the
 * seams between those changes leaked: GET replayed every recorded status as
 * 200, DELETE shared create's endpoint type and recorded into a throwaway
 * array, record-mode DELETE never left the process when the voice happened to
 * be in the local store, and the strict refusal reported a hardcoded 0 skips.
 *
 * Every test here drives a REAL server over real HTTP; the upstream is a stub
 * http server, and `upstreamHits` — not a response body — is the load-bearing
 * assertion wherever the question is "did this leave the process".
 */
describe("ElevenLabs voice slot routes: composed record + replay", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  test("a recorded GET replays under its RECORDED status, not a fabricated 200", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixtures([
      {
        match: { userMessage: "voice_401", endpoint: "elevenlabs-voice-get" },
        response: {
          json: {
            detail: {
              type: "authentication_error",
              code: "unauthorized",
              message: "Neither authorization header nor xi-api-key received, please provide one.",
            },
          },
          status: 401,
        },
      },
    ]);
    await mock.start();

    const res = await fetch(`${mock.url}/v1/voices/voice_401`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: {
        type: "authentication_error",
        code: "unauthorized",
        message: "Neither authorization header nor xi-api-key received, please provide one.",
      },
    });
  });

  test("a DELETE-recorded fixture replays on DELETE and does not hijack POST /v1/text-to-voice", async () => {
    const fixturePath = makeTmpDir();
    let upstreamHits = 0;
    const { server, url } = await createUpstream((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", recorded_by: "stub" }));
    });

    let recorder: LLMock | undefined;
    try {
      recorder = new LLMock({ port: 0, record: { providers: { elevenlabs: url }, fixturePath } });
      await recorder.start();
      expect(
        (await fetch(`${recorder.url}/v1/voices/voice_hijack`, { method: "DELETE" })).status,
      ).toBe(200);
      expect(upstreamHits).toBe(1);
      await recorder.stop();
      recorder = undefined;
      clearElevenLabsVoices();

      const written = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(written).toHaveLength(1);

      mock = new LLMock({ port: 0 });
      mock.addFixturesFromJSON(
        JSON.parse(fs.readFileSync(path.join(fixturePath, written[0]), "utf-8")).fixtures,
      );
      await mock.start();

      // Create for the SAME id must be untouched by the DELETE recording.
      const created = await fetch(`${mock.url}/v1/text-to-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_name: "My Own Voice",
          voice_description: SEA_CAPTAIN,
          generated_voice_id: "voice_hijack",
        }),
      });
      expect(created.status).toBe(200);
      expect(((await created.json()) as { name: string }).name).toBe("My Own Voice");

      // ...while DELETE replays the recording verbatim, without upstream.
      const replayed = await fetch(`${mock.url}/v1/voices/voice_hijack`, { method: "DELETE" });
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual({ status: "ok", recorded_by: "stub" });
      expect(upstreamHits).toBe(1);
    } finally {
      await recorder?.stop();
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("a recorded DELETE is kept in the live fixture set, so a repeat does not re-hit upstream", async () => {
    const fixturePath = makeTmpDir();
    let upstreamHits = 0;
    const { server, url } = await createUpstream((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    try {
      mock = new LLMock({ port: 0, record: { providers: { elevenlabs: url }, fixturePath } });
      await mock.start();

      expect((await fetch(`${mock.url}/v1/voices/voice_twice`, { method: "DELETE" })).status).toBe(
        200,
      );
      expect(upstreamHits).toBe(1);
      expect(mock.getFixtures()).toHaveLength(1);
      expect(mock.getFixtures()[0].match.endpoint).toBe("elevenlabs-voice-delete");

      expect((await fetch(`${mock.url}/v1/voices/voice_twice`, { method: "DELETE" })).status).toBe(
        200,
      );
      expect(upstreamHits).toBe(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("record mode forwards a DELETE for a LOCALLY-KNOWN voice upstream", async () => {
    const fixturePath = makeTmpDir();
    let upstreamHits = 0;
    const { server, url } = await createUpstream((_req, res) => {
      upstreamHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    try {
      // A voice created locally (no upstream involved) is in the module store.
      mock = new LLMock({ port: 0 });
      await mock.start();
      expect(
        (
          await fetch(`${mock.url}/v1/text-to-voice`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              voice_name: "Local Voice",
              voice_description: SEA_CAPTAIN,
              generated_voice_id: "voice_local",
            }),
          })
        ).status,
      ).toBe(200);
      await mock.stop();

      // The store survives `stop()` — it is a module global. A record-mode
      // DELETE must still leave the process: the store is a replay
      // convenience, not a claim about what exists upstream.
      mock = new LLMock({ port: 0, record: { providers: { elevenlabs: url }, fixturePath } });
      await mock.start();
      expect((await fetch(`${mock.url}/v1/voices/voice_local`, { method: "DELETE" })).status).toBe(
        200,
      );
      expect(upstreamHits).toBe(1);
      expect(mock.getFixtures()).toHaveLength(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("a strict GET refusal reports the sequence/turn skip count it actually saw", async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      mock = new LLMock({ port: 0, strict: true, logLevel: "warn" });
      mock.addFixtures([
        {
          match: {
            userMessage: "voice_skip",
            endpoint: "elevenlabs-voice-get",
            sequenceIndex: 1,
          },
          response: { json: { voice_id: "voice_skip" } },
        },
      ]);
      await mock.start();

      const res = await fetch(`${mock.url}/v1/voices/voice_skip`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        "1 candidate fixture(s) skipped by sequence/turn state",
      );
      expect(
        errors.filter((e) => e.includes("STRICT: 1 candidate fixture(s) skipped")),
      ).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("a registered GET fixture wins over the in-process store, audibly", async () => {
    const debugLines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      debugLines.push(args.map(String).join(" "));
    });
    try {
      mock = new LLMock({ port: 0, logLevel: "debug" });
      mock.addFixtures([
        {
          match: { userMessage: "voice_shadow", endpoint: "elevenlabs-voice-get" },
          response: { json: { voice_id: "voice_shadow", name: "FromFixture" } },
        },
      ]);
      await mock.start();

      await fetch(`${mock.url}/v1/text-to-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_name: "FromStore",
          voice_description: SEA_CAPTAIN,
          generated_voice_id: "voice_shadow",
        }),
      });

      const res = await fetch(`${mock.url}/v1/voices/voice_shadow`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { name: string }).name).toBe("FromFixture");
      expect(
        debugLines.filter(
          (l) => l.includes("shadows the in-process voice") && l.includes("voice_shadow"),
        ),
      ).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });
});

/**
 * Wire fidelity + observability on the boundaries the earlier blocks step over:
 * the PROXY path's silence, the empty `voice_description`, and the UNIT the
 * 20-character minimum is measured in.
 *
 * Every case here exercises the real HTTP surface of a started `LLMock` (and,
 * for the proxy cases, a second real upstream server on its own port), because
 * all three defects live in the seam between the handler and something outside
 * it — a logger it was never handed, a truthiness test, and JavaScript's
 * disagreement with Python about what a "character" is.
 */
describe("ElevenLabs Voice Design wire fidelity and proxy observability", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  // 19 code points, 38 UTF-16 code units. The whole point of this constant is
  // that `.length` and `[...s].length` disagree about it, and pydantic — whose
  // `min_length` is Python's `len(str)` — counts the way the SECOND one does.
  const EMOJI_19_CODE_POINTS = "\u{1F600}".repeat(19);
  const EMOJI_20_CODE_POINTS = "\u{1F600}".repeat(20);

  function design(base: string, description: string): Promise<Response> {
    return fetch(`${base}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: description }),
    });
  }

  test("an EMPTY voice_description is too-short (422 detail), not missing (400 house error)", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await design(mock.url, "");

    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: Array<Record<string, unknown>> };
    expect(body.detail).toHaveLength(1);
    expect(body.detail[0].loc).toEqual(["body", "voice_description"]);
    expect(body.detail[0].type).toBe("string_too_short");
    expect(body.detail[0].msg).toBe("String should have at least 20 characters");
  });

  test("a voice_description that is absent or not a string is still the house 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    for (const body of [{}, { voice_description: 42 }, { voice_description: null }]) {
      const res = await fetch(`${mock.url}/v1/text-to-voice/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as { error: { message: string } };
      expect(parsed.error.message).toContain("voice_description");
    }
  });

  test("the 20-character minimum counts CODE POINTS, so 19 emoji are rejected", async () => {
    mock = new LLMock({ port: 0 });
    // Deliberately UNREGISTERED: the minimum now runs after fixture matching,
    // so a fixture on this description would serve and the bound would never
    // be exercised. If the bound were measured in UTF-16 code units this
    // request would clear it and fall through to the no-match 404, so 422 vs
    // 404 is the discriminator.
    await mock.start();

    // Guard the premise: this string is under the bound by code points and
    // comfortably OVER it by `.length`.
    expect([...EMOJI_19_CODE_POINTS].length).toBe(19);
    expect(EMOJI_19_CODE_POINTS.length).toBe(38);

    const res = await design(mock.url, EMOJI_19_CODE_POINTS);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: Array<Record<string, unknown>> };
    expect(body.detail[0].type).toBe("string_too_short");
  });

  test("20 emoji clear the minimum and match a fixture", async () => {
    mock = new LLMock({ port: 0 });
    mock.onElevenLabsVoiceDesign(EMOJI_20_CODE_POINTS, {
      previews: [{ generated_voice_id: "p20", audio_base_64: "QQ==" }],
      text: "twenty",
    });
    await mock.start();

    expect([...EMOJI_20_CODE_POINTS].length).toBe(20);

    const res = await design(mock.url, EMOJI_20_CODE_POINTS);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe("twenty");
  });

  // The proxy path is the one path where the voice body came from somewhere
  // aimock does not control, so it is the path where a silent drop costs most.
  test("a PROXIED create warns on an overwrite and on a 2xx body with no voice_id", async () => {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const { server, url } = await createUpstream((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(raw || "{}") as { voice_name?: string };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          parsed.voice_name === "NoIdAtAll"
            ? JSON.stringify({ name: "NoIdAtAll", category: "generated" })
            : JSON.stringify({
                voice_id: "vx_upstream",
                name: parsed.voice_name,
                category: "generated",
              }),
        );
      });
    });
    try {
      mock = new LLMock({
        port: 0,
        logLevel: "warn",
        record: { providers: { elevenlabs: url }, fixturePath: makeTmpDir() },
      });
      await mock.start();
      const base = mock.url;

      // Distinct descriptions so each create MISSES the fixture the previous
      // one recorded and actually reaches upstream again.
      const create = (voiceName: string, suffix: string) =>
        fetch(`${base}/v1/text-to-voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            voice_name: voiceName,
            voice_description: `${SEA_CAPTAIN} ${suffix}`,
            generated_voice_id: `gen_${voiceName}`,
          }),
        });

      expect((await create("First", "alpha")).status).toBe(200);
      expect(warnings.filter((w) => w.includes("vx_upstream"))).toHaveLength(0);

      // Upstream hands back the SAME voice_id: an overwrite of a voice the
      // store already holds.
      expect((await create("Second", "beta")).status).toBe(200);
      const overwrite = warnings.filter(
        (w) => w.includes("vx_upstream") && w.includes("overwritten"),
      );
      expect(overwrite).toHaveLength(1);

      // A 2xx voice body with no `voice_id` at all: nothing is stored, and
      // saying so is the only way a caller learns why its GET will miss.
      expect((await create("NoIdAtAll", "gamma")).status).toBe(200);
      const noId = warnings.filter(
        (w) => w.includes("no string `voice_id`") && w.includes("NoIdAtAll"),
      );
      expect(noId).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      await closeServer(server);
    }
  });

  test("a proxied NON-JSON 2xx body is relayed verbatim and remembers nothing", async () => {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const { server, url } = await createUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>not a voice</html>");
      });
    });
    try {
      mock = new LLMock({
        port: 0,
        logLevel: "warn",
        record: { providers: { elevenlabs: url }, fixturePath: makeTmpDir() },
      });
      await mock.start();

      const res = await fetch(`${mock.url}/v1/text-to-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_name: "Html",
          voice_description: SEA_CAPTAIN,
          generated_voice_id: "gen_html",
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("not a voice");
      // A malformed body is the one thing the hook swallows: no voice to
      // remember, and no voice_id to complain about either.
      expect(warnings.filter((w) => w.includes("voice_id"))).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      await closeServer(server);
    }
  });

  test("every drift file the PROVENANCE block cites actually exists", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "elevenlabs-voice.ts"),
      "utf-8",
    );
    const cited = [...source.matchAll(/src\/__tests__\/drift\/([\w.-]+\.drift\.ts)/g)].map(
      (m) => m[1],
    );
    // A citation that names no file is worse than no citation: it sends the
    // next reader to a drift test that does not cover what the comment claims.
    expect(cited.length).toBeGreaterThan(0);
    for (const file of cited) {
      expect(
        fs.existsSync(path.join(import.meta.dirname, "drift", file)),
        `PROVENANCE cites src/__tests__/drift/${file}, which does not exist`,
      ).toBe(true);
    }
    // The voice legs live in the voice-specific drift file, not the TTS one.
    expect(cited).toContain("elevenlabs-voice.drift.ts");
  });
});

/**
 * The bound on the module-global voice store. `rememberElevenLabsVoice()`
 * documents a SILENT, FIFO, non-LRU eviction with one non-obvious invariant —
 * re-saving a voice id already in the store keeps its ORIGINAL insertion slot,
 * because `Map.set` on a present key does not reorder — and none of that was
 * executed by any test: the cap is 10 000 voices, which no route-level test
 * approaches. The exported entry point is driven directly here so the eviction
 * arithmetic (`>` vs `>=`, and draining exactly the excess) is pinned at a cost
 * of milliseconds, and the READ side goes through a real `GET /v1/voices/{id}`
 * so an evicted voice is observed the way a consumer observes it: a 404 that
 * looks exactly like a voice that never existed.
 */
describe("ElevenLabs voice store bound", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop and a module-global store clear, both for the reasons
    // spelled out on the first describe in this file. The clear matters more
    // here than anywhere else in the file: this block fills the store to its
    // cap.
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  // `VOICE_STORE_MAX` is a module-private constant in `src/elevenlabs-voice.ts`.
  // It is mirrored rather than exported: changing the cap there must be a
  // deliberate change here too, and this test is where the change gets read.
  const VOICE_STORE_MAX = 10_000;

  test("the store evicts the OLDEST INSERTION past the cap, and re-saving does not refresh a slot", async () => {
    clearElevenLabsVoices();
    for (let i = 0; i < VOICE_STORE_MAX; i++) {
      expect(rememberElevenLabsVoice({ voice_id: `bulk_${i}`, name: `Voice ${i}` })).toBe(true);
    }

    mock = new LLMock({ port: 0 });
    await mock.start();

    // AT the cap nothing has been evicted yet: the guard is `>`, not `>=`.
    expect((await fetch(`${mock.url}/v1/voices/bulk_0`)).status).toBe(200);
    expect((await fetch(`${mock.url}/v1/voices/bulk_1`)).status).toBe(200);

    // Re-saving an id already present must NOT move it to the back of the
    // insertion order — if it did, the eviction below would take `bulk_1`.
    expect(rememberElevenLabsVoice({ voice_id: "bulk_0", name: "Re-saved" })).toBe(true);

    // One voice past the cap evicts exactly one: the oldest INSERTED.
    expect(rememberElevenLabsVoice({ voice_id: "bulk_over", name: "Newest" })).toBe(true);

    expect((await fetch(`${mock.url}/v1/voices/bulk_0`)).status).toBe(404);
    expect((await fetch(`${mock.url}/v1/voices/bulk_1`)).status).toBe(200);

    const newest = await fetch(`${mock.url}/v1/voices/bulk_over`);
    expect(newest.status).toBe(200);
    expect(((await newest.json()) as { name: string }).name).toBe("Newest");
  });
});

/**
 * Three things the slot routes (`GET`/`DELETE /v1/voices/{id}`) used to skip
 * while design and create honoured them. Each test below is a real HTTP round
 * trip against a live server (and, for the record case, a second real upstream
 * on its own port) because all three defects live in handler ORDERING and in
 * the route's url parsing — neither is observable from a unit call.
 *
 *   - FIXTURE-LEVEL chaos. The slot chaos gate ran before the fixture match and
 *     was handed `null`, so a `chaos` block authored ON a fixture was silently
 *     dropped here while `POST /v1/text-to-voice/design` honoured the identical
 *     block. Server-level chaos always worked, which is why this went unseen.
 *   - THE STORE SHADOWING RECORD MODE ON GET. `DELETE` already guarded its
 *     store branch with `!defaults.record`; `GET` did not, so a voice this
 *     process happened to know about was answered locally and the tape got no
 *     `elevenlabs-voice-get` entry at all. A later replay run, which has only
 *     the tape, then 404s on the GET that "worked" while recording.
 *   - PERCENT-ENCODED IDS. The router handed the handler the RAW path segment
 *     while the store is keyed by the id as it appears in JSON, so any id
 *     carrying a space or a slash was unreachable through the route that is
 *     supposed to serve it.
 */
describe("ElevenLabs voice slot-route parity with design/create", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    // Best-effort stop and a module-global store clear, both for the reasons
    // spelled out on the first describe in this file.
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  test("a fixture-level chaos block reaches GET /v1/voices/{id}", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "voice_fixture_chaos", endpoint: "elevenlabs-voice-get" },
      response: { json: { voice_id: "voice_fixture_chaos", name: "Chaotic" } },
      chaos: { rateLimitRate: 1 },
    });
    await mock.start();

    expect((await fetch(`${mock.url}/v1/voices/voice_fixture_chaos`)).status).toBe(429);
  });

  test("a fixture-level chaos block reaches DELETE /v1/voices/{id}", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "voice_fixture_chaos_del", endpoint: "elevenlabs-voice-delete" },
      response: { json: { status: "ok" } },
      chaos: { rateLimitRate: 1 },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/voices/voice_fixture_chaos_del`, { method: "DELETE" });
    expect(res.status).toBe(429);
  });

  test("a chaos-free fixture still serves the slot routes", async () => {
    // Negative control for the two tests above: moving the chaos gate behind
    // the fixture match must not turn an ordinary fixture hit into a refusal.
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "voice_no_chaos", endpoint: "elevenlabs-voice-get" },
      response: { json: { voice_id: "voice_no_chaos", name: "Calm" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/voices/voice_no_chaos`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("Calm");
  });

  test("record mode forwards a GET for a locally-known voice and records it", async () => {
    const fixturePath = makeTmpDir();
    const voice = { voice_id: "record_over_store", name: "Upstream Voice", category: "generated" };
    let getHits = 0;
    let postHits = 0;
    const { server, url } = await createUpstream((req, res) => {
      if (req.method === "GET") getHits++;
      else postHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(voice));
    });

    // The upstream server and the tmpdir are already live, so the `try` opens
    // BEFORE the mock is constructed, exactly as the record tests above do.
    try {
      mock = new LLMock({ port: 0, record: { providers: { elevenlabs: url }, fixturePath } });
      await mock.start();

      // A proxied create leaves the voice in the module-global store.
      const created = await fetch(`${mock.url}/v1/text-to-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_name: "Upstream Voice",
          voice_description: SEA_CAPTAIN,
          generated_voice_id: "record_over_store",
        }),
      });
      expect(created.status).toBe(200);
      expect(postHits).toBe(1);

      // THE ASSERTION: record mode is not allowed to answer that GET from the
      // store. It forwards, and the tape gains the GET entry a later replay
      // run needs.
      const fetched = await fetch(`${mock.url}/v1/voices/record_over_store`);
      expect(fetched.status).toBe(200);
      expect(getHits).toBe(1);
      expect(
        mock.getFixtures().filter((f) => f.match.endpoint === "elevenlabs-voice-get"),
      ).toHaveLength(1);

      // And the recording is load-bearing: the repeat replays it rather than
      // re-hitting upstream a second time.
      expect((await fetch(`${mock.url}/v1/voices/record_over_store`)).status).toBe(200);
      expect(getHits).toBe(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("a voice id needing percent-encoding is reachable on GET and DELETE", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    for (const id of ["voice with space", "voice/with/slash"]) {
      const created = await fetch(`${mock.url}/v1/text-to-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_name: "Encoded",
          voice_description: SEA_CAPTAIN,
          generated_voice_id: id,
        }),
      });
      expect(created.status).toBe(200);
      expect(((await created.json()) as { voice_id: string }).voice_id).toBe(id);

      const encoded = encodeURIComponent(id);
      const got = await fetch(`${mock.url}/v1/voices/${encoded}`);
      expect(got.status).toBe(200);
      expect(((await got.json()) as { voice_id: string }).voice_id).toBe(id);

      const deleted = await fetch(`${mock.url}/v1/voices/${encoded}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect((await fetch(`${mock.url}/v1/voices/${encoded}`)).status).toBe(404);
    }
  });

  test("a malformed percent-escape in the voice id is a 400, not a 500", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/voices/%E0%A4%A`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "invalid_request_error",
    );
  });
});

/**
 * RECORD MODE AND THE LOCAL VALIDATORS. Three places where aimock's own
 * answer used to pre-empt, or outlive, what upstream actually said:
 *
 *   - a record-mode DELETE dropped the local voice BEFORE forwarding and never
 *     reconsidered, so an upstream refusal lost a voice the fixture-replay
 *     branch would have kept (it evicts only on 2xx);
 *   - the 20-code-point `voice_description` 422 ran ahead of fixture matching
 *     AND ahead of the proxy, so a registered short-description fixture was
 *     unreachable and the one response on this surface whose real shape was
 *     observed could never be recorded;
 *   - `POST /v1/text-to-voice` folded `voice_description: ""` into MISSING and
 *     told the caller it had omitted a field it had sent.
 *
 * Every test drives a REAL server over real HTTP against a stub upstream, and
 * reads the outcome the way a consumer does (status + a follow-up GET), not
 * through the store. Note the relayed status on a proxied failure is 502 by
 * design (`src/recorder.ts`: successes -> 200, errors -> 502); the UPSTREAM
 * status survives in the recorded fixture, which is what the replay asserts.
 */
describe("ElevenLabs voice record mode vs the local validators", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  test("a record-mode DELETE evicts the local voice only when upstream answers 2xx", async () => {
    let upstreamHits = 0;
    const { server, url } = await createUpstream((req, res) => {
      upstreamHits += 1;
      const ok = (req.url ?? "").includes("upstream_ok");
      res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? { status: "ok" } : { detail: "upstream exploded" }));
    });
    const fixturePath = makeTmpDir();

    try {
      mock = new LLMock({
        port: 0,
        record: { providers: { elevenlabs: url }, fixturePath },
      });
      await mock.start();

      rememberElevenLabsVoice({ voice_id: "upstream_boom", name: "Boom" });
      rememberElevenLabsVoice({ voice_id: "upstream_ok", name: "Ok" });

      const refused = await fetch(`${mock.url}/v1/voices/upstream_boom`, { method: "DELETE" });
      expect(refused.status).toBe(502);
      const accepted = await fetch(`${mock.url}/v1/voices/upstream_ok`, { method: "DELETE" });
      expect(accepted.status).toBe(200);
      expect(upstreamHits).toBe(2);

      // Read the store the way a consumer does. Recording off first, so a GET
      // miss is the plain 404 rather than another proxy round trip.
      mock.disableRecording();
      expect((await fetch(`${mock.url}/v1/voices/upstream_boom`)).status).toBe(200);
      expect((await fetch(`${mock.url}/v1/voices/upstream_ok`)).status).toBe(404);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("a record-mode short voice_description is forwarded, and the real 422 is recorded and replayed", async () => {
    let upstreamHits = 0;
    const upstreamBody = {
      detail: [
        {
          type: "string_too_short",
          loc: ["body", "voice_description"],
          msg: "UPSTREAM REAL MSG",
        },
      ],
    };
    const { server, url } = await createUpstream((req, res) => {
      upstreamHits += 1;
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamBody));
    });
    const fixturePath = makeTmpDir();

    try {
      mock = new LLMock({
        port: 0,
        record: { providers: { elevenlabs: url }, fixturePath },
      });
      await mock.start();

      const recorded = await fetch(`${mock.url}/v1/text-to-voice/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_description: "short" }),
      });
      // The local gate did NOT answer: the request reached upstream and the
      // upstream body came back verbatim (relayed as 502 per the recorder's
      // error mapping).
      expect(upstreamHits).toBe(1);
      expect(recorded.status).toBe(502);
      expect(await recorded.json()).toEqual(upstreamBody);

      const designFixtures = mock
        .getFixtures()
        .filter((f) => f.match.endpoint === "elevenlabs-voice-design");
      expect(designFixtures).toHaveLength(1);
      expect(designFixtures[0].response).toEqual({ json: upstreamBody, status: 422 });

      mock.disableRecording();
      const replayed = await fetch(`${mock.url}/v1/text-to-voice/design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_description: "short" }),
      });
      // The recorded UPSTREAM status, and the real `msg` the provenance block
      // says this repo has never been able to record until now.
      expect(replayed.status).toBe(422);
      expect(await replayed.json()).toEqual(upstreamBody);
      expect(upstreamHits).toBe(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("in replay mode a registered short-description fixture is served, and an unregistered one still 422s", async () => {
    mock = new LLMock({ port: 0 });
    const previews = {
      previews: [
        {
          generated_voice_id: "preview_calm",
          audio_base_64: "SGVsbG8=",
          media_type: "audio/mpeg",
          duration_secs: 1.5,
        },
      ],
      text: "sample",
    };
    // 13 code points — legal `onElevenLabsVoiceDesign` usage that the old
    // gate-first ordering made permanently unreachable.
    mock.onElevenLabsVoiceDesign("calm narrator", previews);
    await mock.start();

    const served = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: "calm narrator" }),
    });
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual(previews);

    const refused = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: "tiny" }),
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({
      detail: [
        {
          loc: ["body", "voice_description"],
          msg: "String should have at least 20 characters",
          type: "string_too_short",
        },
      ],
    });
  });

  test("create answers an EMPTY voice_description with string_too_short, not the missing-parameter 400", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_name: "Empty",
        voice_description: "",
        generated_voice_id: "preview_empty",
      }),
    });
    expect(res.status).toBe(422);
    // `1 character`, not `20`: this route's minimum has never been probed, and
    // an empty string is short under any `min_length >= 1`.
    expect(await res.json()).toEqual({
      detail: [
        {
          loc: ["body", "voice_description"],
          msg: "String should have at least 1 character",
          type: "string_too_short",
        },
      ],
    });

    // An ABSENT description keeps the house 400 it has always answered.
    const absent = await fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_name: "Absent", generated_voice_id: "preview_absent" }),
    });
    expect(absent.status).toBe(400);
  });
});

describe("ElevenLabs voice GET in record mode without an ElevenLabs upstream", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  const createBody = JSON.stringify({
    voice_name: "Captain",
    voice_description: SEA_CAPTAIN,
    generated_voice_id: "preview_norecord_upstream",
  });

  test("a voice created while --record targets another provider is served by GET and evicted by DELETE", async () => {
    const fixturePath = makeTmpDir();
    try {
      // Record mode is ON, but only for openai — no ElevenLabs upstream, so the
      // create synthesizes locally and GET's proxy attempt is `not_configured`.
      mock = new LLMock({
        port: 0,
        record: { providers: { openai: "http://127.0.0.1:9/" }, fixturePath },
      });
      await mock.start();

      const created = await fetch(`${mock.url}/v1/text-to-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: createBody,
      });
      expect(created.status).toBe(200);
      const voice = (await created.json()) as { voice_id: string };
      expect(voice.voice_id).toBe("preview_norecord_upstream");

      const got = await fetch(`${mock.url}/v1/voices/${voice.voice_id}`);
      expect(got.status).toBe(200);
      expect(await got.json()).toEqual(voice);

      const deleted = await fetch(`${mock.url}/v1/voices/${voice.voice_id}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);

      const gone = await fetch(`${mock.url}/v1/voices/${voice.voice_id}`);
      expect(gone.status).toBe(404);
      expect(((await gone.json()) as { error: { code: string } }).error.code).toBe(
        "voice_not_found",
      );
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("with an ElevenLabs upstream configured, GET of a locally-known voice still forwards and records", async () => {
    let upstreamHits = 0;
    const { server, url } = await createUpstream((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ voice_id: "known_upstream", name: "From upstream" }));
    });
    const fixturePath = makeTmpDir();
    try {
      mock = new LLMock({ port: 0, record: { providers: { elevenlabs: url }, fixturePath } });
      await mock.start();
      rememberElevenLabsVoice({ voice_id: "known_upstream", name: "From store" });

      const got = await fetch(`${mock.url}/v1/voices/known_upstream`);
      expect(got.status).toBe(200);
      expect(await got.json()).toEqual({ voice_id: "known_upstream", name: "From upstream" });
      expect(upstreamHits).toBe(1);
      expect(fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("with recording off, GET is served from the store without any proxy attempt", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    rememberElevenLabsVoice({ voice_id: "known_local", name: "Local" });

    const got = await fetch(`${mock.url}/v1/voices/known_local`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ voice_id: "known_local", name: "Local" });
  });
});

/**
 * `POST /v1/text-to-voice` follows the same handler ORDER as its design
 * sibling: missing-parameter 400 -> fixture match -> chaos -> strict refusal /
 * record-mode proxy -> the local 422 -> synthesize. The empty-string 422 used
 * to run FIRST, which made a registered fixture unreachable, bypassed chaos and
 * strict, and in record mode authored a 422 the recorder never saw. And
 * "missing" means ABSENT: a present-but-empty `voice_name` or
 * `generated_voice_id` is too short, not missing, exactly as `voice_description`
 * already was.
 */
describe("ElevenLabs voice create: parameter validation sits where design's does", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  const EMPTY_DESCRIPTION = {
    voice_name: "Empty",
    voice_description: "",
    generated_voice_id: "preview_empty",
  };

  function create(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    if (!mock) throw new Error("test bug: helper used before the mock was started");
    return fetch(`${mock.url}/v1/text-to-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  function tooShort(field: string) {
    return {
      detail: [
        {
          loc: ["body", field],
          msg: "String should have at least 1 character",
          type: "string_too_short",
        },
      ],
    };
  }

  test("record mode forwards an empty voice_description; the real 422 is recorded and replayed", async () => {
    let upstreamHits = 0;
    const upstreamBody = {
      detail: [
        { type: "string_too_short", loc: ["body", "voice_description"], msg: "UPSTREAM REAL MSG" },
      ],
    };
    const { server, url } = await createUpstream((_req, res) => {
      upstreamHits += 1;
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamBody));
    });
    const fixturePath = makeTmpDir();

    try {
      mock = new LLMock({
        port: 0,
        record: { providers: { elevenlabs: url }, fixturePath },
      });
      await mock.start();

      const recorded = await create(EMPTY_DESCRIPTION);
      expect(upstreamHits).toBe(1);
      expect(recorded.status).toBe(502);
      expect(await recorded.json()).toEqual(upstreamBody);

      const createFixtures = mock
        .getFixtures()
        .filter((f) => f.match.endpoint === "elevenlabs-voice");
      expect(createFixtures).toHaveLength(1);
      expect(createFixtures[0].response).toEqual({ json: upstreamBody, status: 422 });

      mock.disableRecording();
      const replayed = await create(EMPTY_DESCRIPTION);
      expect(replayed.status).toBe(422);
      expect(await replayed.json()).toEqual(upstreamBody);
      expect(upstreamHits).toBe(1);
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test("a registered create fixture is served for an empty voice_description", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "preview_empty", endpoint: "elevenlabs-voice" },
      response: { json: { voice_id: "voice_from_fixture", name: "Empty" } },
    });
    await mock.start();

    const res = await create(EMPTY_DESCRIPTION);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { voice_id: string }).voice_id).toBe("voice_from_fixture");
  });

  test("a fixture-level chaos block reaches create ahead of the empty-description 422", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "preview_empty", endpoint: "elevenlabs-voice" },
      response: { json: { voice_id: "voice_chaos", name: "Empty" } },
      chaos: { rateLimitRate: 1 },
    });
    await mock.start();

    expect((await create(EMPTY_DESCRIPTION)).status).toBe(429);
  });

  test("strict mode refuses an unmatched empty-description create before the local 422", async () => {
    mock = new LLMock({ port: 0, strict: true });
    await mock.start();

    const res = await create(EMPTY_DESCRIPTION);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("no_fixture_match");
  });

  test("replay mode, unregistered: empty voice_description still 422s and an absent one still 400s", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const empty = await create(EMPTY_DESCRIPTION);
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual(tooShort("voice_description"));

    const absent = await create({ voice_name: "Absent", generated_voice_id: "preview_absent" });
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({
      error: {
        message: "Missing required parameter: 'voice_description'",
        type: "invalid_request_error",
      },
    });
  });

  test("an empty voice_name or generated_voice_id is too short, not missing", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const emptyName = await create({
      voice_name: "",
      voice_description: SEA_CAPTAIN,
      generated_voice_id: "preview_name",
    });
    expect(emptyName.status).toBe(422);
    expect(await emptyName.json()).toEqual(tooShort("voice_name"));

    const absentName = await create({
      voice_description: SEA_CAPTAIN,
      generated_voice_id: "preview_name",
    });
    expect(absentName.status).toBe(400);
    expect(((await absentName.json()) as { error: { message: string } }).error.message).toBe(
      "Missing required parameter: 'voice_name'",
    );

    const emptyId = await create({
      voice_name: "Captain",
      voice_description: SEA_CAPTAIN,
      generated_voice_id: "",
    });
    expect(emptyId.status).toBe(422);
    expect(await emptyId.json()).toEqual(tooShort("generated_voice_id"));

    const absentId = await create({ voice_name: "Captain", voice_description: SEA_CAPTAIN });
    expect(absentId.status).toBe(400);
    expect(((await absentId.json()) as { error: { message: string } }).error.message).toBe(
      "Missing required parameter: 'generated_voice_id'",
    );
  });
});

/**
 * F6: no voice journal entry carried a `service` tag, so
 * `GET /__aimock/journal?service=elevenlabs-voice` selected nothing even
 * though the unfiltered journal showed the traffic. Every branch — design,
 * create, the GET/DELETE slot routes, their 400/404s, and the chaos gates —
 * now tags itself the way files/fine-tuning/batches do.
 */
describe("ElevenLabs voice journal entries carry service", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop().catch(() => {});
    mock = undefined;
    clearElevenLabsVoices();
  });

  type Entry = { method: string; path: string; service?: string; response: { status: number } };
  const journal = async (base: string, qs = ""): Promise<Entry[]> =>
    (await (await fetch(`${base}/__aimock/journal${qs}`)).json()) as Entry[];

  test("?service=elevenlabs-voice selects every voice route outcome", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const post = (route: string, body: unknown): Promise<Response> =>
      fetch(`${mock!.url}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // design: 404 (no fixture), 400 (missing description), 400 (malformed JSON)
    expect(
      (await post("/v1/text-to-voice/design", { voice_description: SEA_CAPTAIN })).status,
    ).toBe(404);
    expect((await post("/v1/text-to-voice/design", {})).status).toBe(400);
    expect(
      (
        await fetch(`${mock.url}/v1/text-to-voice/design`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    // create: 200, then the slot routes on the saved voice
    expect(
      (
        await post("/v1/text-to-voice", {
          voice_name: "Captain",
          voice_description: SEA_CAPTAIN,
          generated_voice_id: "preview_captain",
        })
      ).status,
    ).toBe(200);
    expect((await fetch(`${mock.url}/v1/voices/preview_captain`)).status).toBe(200);
    expect(
      (await fetch(`${mock.url}/v1/voices/preview_captain`, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await fetch(`${mock.url}/v1/voices/preview_captain`)).status).toBe(404);

    const all = (await journal(mock.url)).filter(
      (e) => e.path.includes("/v1/text-to-voice") || e.path.includes("/v1/voices/"),
    );
    expect(all.map((e) => e.response.status)).toEqual([404, 400, 400, 200, 200, 200, 404]);
    for (const e of all) expect(e.service, `${e.method} ${e.path}`).toBe("elevenlabs-voice");

    const filtered = await journal(mock.url, "?service=elevenlabs-voice");
    expect(filtered).toHaveLength(all.length);
  });

  test("a chaos-faulted voice request stays selectable by service", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    const testId = "voice-journal-chaos";
    const headers = { "Content-Type": "application/json", "X-Test-Id": testId };
    await fetch(`${mock.url}/__aimock/chaos`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rateLimitRate: 1 }),
    });
    const design = await fetch(`${mock.url}/v1/text-to-voice/design`, {
      method: "POST",
      headers,
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });
    expect(design.status).toBe(429);
    const get = await fetch(`${mock.url}/v1/voices/nobody`, { headers });
    expect(get.status).toBe(429);

    const tagged = (await journal(mock.url, `?service=elevenlabs-voice&testId=${testId}`)).map(
      (e) => e.response.status,
    );
    expect(tagged).toEqual([429, 429]);
  });
});

/**
 * H5: the no-fixture chaos gates hardcoded their journal `source` — design and
 * create said "proxy" with no record config at all, and the GET/DELETE slot
 * gate said "internal" while record mode was about to proxy the very same
 * miss. Every voice gate now applies the rule `src/server.ts` applies: the
 * label is "internal" unless record mode has an ElevenLabs upstream.
 *
 * And every voice journal write used to land BEFORE its response write, so a
 * `writeHead` that threw left a phantom entry for a response the client never
 * got — the inverse of the journal-after-write rule files.ts and chaos.ts
 * follow. Every site now journals after the write succeeds.
 */
describe("ElevenLabs voice journal truth", () => {
  let mock: LLMock | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    await mock?.stop().catch(() => {});
    mock = undefined;
    if (upstream) await closeServer(upstream);
    upstream = undefined;
    clearElevenLabsVoices();
  });

  type Entry = { method: string; path: string; response: { status: number; source?: string } };
  const testId = "voice-journal-truth";
  const headers = { "Content-Type": "application/json", "X-Test-Id": testId };
  const dropEverything = (base: string): Promise<Response> =>
    fetch(`${base}/__aimock/chaos`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dropRate: 1 }),
    });
  const faultBoth = async (base: string): Promise<string[]> => {
    const design = await fetch(`${base}/v1/text-to-voice/design`, {
      method: "POST",
      headers,
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });
    expect(design.status).toBe(500);
    const get = await fetch(`${base}/v1/voices/nobody`, { headers });
    expect(get.status).toBe(500);
    const entries = (await (
      await fetch(`${base}/__aimock/journal?service=elevenlabs-voice&testId=${testId}`)
    ).json()) as Entry[];
    expect(entries.map((e) => e.method)).toEqual(["POST", "GET"]);
    return entries.map((e) => e.response.source ?? "<none>");
  };

  test("a no-fixture chaos fault with no record config journals source internal on every route", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    await dropEverything(mock.url);
    expect(await faultBoth(mock.url)).toEqual(["internal", "internal"]);
  });

  test("a no-fixture chaos fault under record mode with an ElevenLabs upstream journals source proxy on every route", async () => {
    const up = await createUpstream((_req, res) => {
      res.writeHead(500);
      res.end("chaos must have answered before this");
    });
    upstream = up.server;
    mock = new LLMock({
      port: 0,
      record: { providers: { elevenlabs: up.url }, fixturePath: makeTmpDir() },
    });
    await mock.start();
    await dropEverything(mock.url);
    expect(await faultBoth(mock.url)).toEqual(["proxy", "proxy"]);
  });

  test("a no-fixture chaos fault under strict mode with an ElevenLabs upstream journals source internal on every route", async () => {
    // Strict refuses every miss before record mode gets to forward it, so
    // nothing here was ever going to be proxied.
    const up = await createUpstream((_req, res) => {
      res.writeHead(500);
      res.end("chaos must have answered before this");
    });
    upstream = up.server;
    mock = new LLMock({
      port: 0,
      strict: true,
      record: { providers: { elevenlabs: up.url }, fixturePath: makeTmpDir() },
    });
    await mock.start();
    await dropEverything(mock.url);
    expect(await faultBoth(mock.url)).toEqual(["internal", "internal"]);
  });

  test("a no-fixture chaos fault under a record config with no providers map journals source internal instead of throwing", async () => {
    // A JS caller (or a hand-built config) can hand over `record: {}`. The
    // voice label rule used to read `.providers.elevenlabs` unguarded, so the
    // chaos gate threw before the drop was written or journalled. Driven
    // through the handler directly: the full server has its own unguarded
    // `record.providers.byteplus` read in its routing, outside this rule.
    const journal = new Journal();
    const defaults = {
      latency: 0,
      chunkSize: 0,
      replaySpeed: 1,
      logger: new Logger("silent"),
      record: {} as RecordConfig,
      chaos: { dropRate: 1 },
    };
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void handleElevenLabsVoiceDesign(
          req,
          res,
          Buffer.concat(chunks).toString(),
          [],
          defaults,
          journal,
        );
      });
    });
    upstream = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    const design = await fetch(`http://127.0.0.1:${port}/v1/text-to-voice/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_description: SEA_CAPTAIN }),
    });
    expect(design.status).toBe(500);
    // Before: the TypeError surfaced as an unhandled rejection with no body
    // written — this is the chaos drop's own body.
    expect(((await design.json()) as { error: { code: string } }).error.code).toBe("chaos_drop");
    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response).toMatchObject({ chaosAction: "drop", source: "internal" });
  });

  test("a response write that throws leaves no journal entry behind", async () => {
    const journal = new Journal();
    const defaults = { latency: 0, chunkSize: 0, replaySpeed: 1, logger: new Logger("silent") };
    const res = {
      setHeader(): void {},
      writeHead(): never {
        throw new Error("writeHead refused");
      },
      end(): void {},
    } as unknown as http.ServerResponse;

    // design: the no-fixture 404 (`writeNoMatch`)
    const design = {
      url: "/v1/text-to-voice/design",
      method: "POST",
      headers: { "content-type": "application/json" },
    } as unknown as http.IncomingMessage;
    await expect(
      handleElevenLabsVoiceDesign(
        design,
        res,
        JSON.stringify({ voice_description: SEA_CAPTAIN }),
        [],
        defaults,
        journal,
      ),
    ).rejects.toThrow("writeHead refused");

    // slot GET: the stored-voice 200 (`serveStored`)
    rememberElevenLabsVoice({ voice_id: "stored" });
    const get = {
      url: "/v1/voices/stored",
      method: "GET",
      headers: {},
    } as unknown as http.IncomingMessage;
    await expect(
      handleElevenLabsVoiceGet(get, res, "stored", [], defaults, journal),
    ).rejects.toThrow("writeHead refused");

    expect(journal.getAll()).toEqual([]);
  });
});
