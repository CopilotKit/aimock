/**
 * ElevenLabs Voice Design conformance — `POST /v1/text-to-voice/design` and
 * `POST /v1/text-to-voice`.
 *
 * LIVE COVERAGE: NONE. Read this before adding a row that says "Covered".
 *
 * Not one leg in this file reaches `api.elevenlabs.io`. That is the ONLY
 * reason there is no live coverage: a key is WIRED into CI — both drift
 * workflows (`.github/workflows/test-drift.yml`, `fix-drift.yml`) pass
 * `secrets.ELEVENLABS_API_KEY` as `ELEVENLABS_API_KEY` to the drift run;
 * whether that secret is populated is not visible from the repo — but no case
 * here fetches the vendor with it, so setting the key changes nothing in this
 * file. These routes have no vendor leg; they are offline-only. No successful
 * Voice Design response has been observed from this repo — see the provenance
 * block at the top of `src/elevenlabs-voice.ts`.
 * Earning "live" here means adding a leg that spends Voice Design credits
 * against the real service, not flipping the registry.
 * These cases drive the LOCAL aimock server and grade its output against the
 * SDK-derived shapes below, which is offline CONFORMANCE (it reds when
 * aimock's own builder changes shape) and NOT drift detection: nothing in this
 * loop can observe the vendor. The `elevenlabs-voice` surface is therefore
 * declared `liveCoverage: "none"` in `surface-registry.ts` and listed under
 * `unverifiedSurfaces` on every run, so a green run never reads as verified.
 *
 * The routes live in their OWN file, apart from `elevenlabs.drift.ts`, on
 * purpose: `drift-collector.test.ts` re-derives live-capability per emitting
 * FILE, so folding these mock-only legs in beside the live
 * `/v1/sound-generation` fetch would make them inherit a "live" derivation they
 * have not earned.
 *
 * SDK SHAPES BELOW are read off `@elevenlabs/elevenlabs-js@2.68.0`
 * (`serialization/types/*.d.ts` `Raw` interfaces), the same secondary source
 * `src/elevenlabs-voice.ts` cites. They are NOT recorded vendor responses.
 *
 * Requires: no credentials. Runs unconditionally.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LLMock } from "../../llmock.js";
import { clearElevenLabsVoices } from "../../elevenlabs-voice.js";
import type { VoiceDesignResponse } from "../../types.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";

// ---------------------------------------------------------------------------
// SDK reference shapes (@elevenlabs/elevenlabs-js@2.68.0 `Raw` interfaces)
// ---------------------------------------------------------------------------

/**
 * `POST /v1/text-to-voice/design` success envelope: `{ previews, text }`, each
 * preview `{ audio_base_64, generated_voice_id, media_type, duration_secs,
 * language? }`.
 */
const SDK_DESIGN_RESPONSE = {
  previews: [
    {
      generated_voice_id: "sdk_preview_id",
      audio_base_64: "SGVsbG8=",
      media_type: "audio/mpeg",
      duration_secs: 1.2,
      language: "en",
    },
  ],
  text: "Sample speech.",
} as const;

const SDK_DESIGN_PREVIEW = SDK_DESIGN_RESPONSE.previews[0];

/**
 * The preview keys the SDK marks REQUIRED. `language` is the one optional
 * field: `api/types/VoicePreviewResponseModel.d.ts` declares `language?:
 * string` and `serialization/types/VoicePreviewResponseModel.js` builds it as
 * `core.serialization.string().optional()`, so a preview that carries no
 * language must OMIT the key rather than send `null` — a `null` there parses
 * away to `undefined` and is a value no SDK consumer can observe.
 */
const SDK_DESIGN_PREVIEW_REQUIRED = {
  generated_voice_id: SDK_DESIGN_PREVIEW.generated_voice_id,
  audio_base_64: SDK_DESIGN_PREVIEW.audio_base_64,
  media_type: SDK_DESIGN_PREVIEW.media_type,
  duration_secs: SDK_DESIGN_PREVIEW.duration_secs,
} as const;

/**
 * The `Voice` object `POST /v1/text-to-voice` answers with, restricted to the
 * keys aimock's `buildSyntheticVoice()` emits. Every key here appears in
 * `Voice.Raw` / `VoiceVerificationResponse.Raw`.
 */
const SDK_VOICE_EMITTED = {
  voice_id: "sdk_voice_id",
  name: "Captain",
  category: "generated",
  description: "A weathered sea captain in his sixties, gravelly, unhurried",
  labels: {},
  preview_url: null,
  available_for_tiers: [],
  settings: null,
  sharing: null,
  high_quality_base_model_ids: [],
  samples: null,
  safety_control: null,
  voice_verification: {
    requires_verification: false,
    is_verified: false,
    verification_failures: [],
    verification_attempts_count: 0,
  },
  permission_on_resource: null,
  is_owner: true,
  is_legacy: false,
  is_mixed: false,
} as const;

/**
 * `Voice.Raw` keys aimock deliberately does NOT emit. Named here so the
 * omission is a declared, asserted divergence rather than an accident — a
 * consumer reading one off a replayed voice gets `undefined`.
 */
const SDK_VOICE_KEYS_NOT_EMITTED = [
  "fine_tuning",
  "verified_languages",
  "collection_ids",
  "created_at_unix",
  "favorited_at_unix",
  "is_bookmarked",
  "recording_quality",
  "labelling_status",
  "recording_quality_reason",
];

/** aimock's house error envelope. NOT ElevenLabs' `detail`-keyed envelope. */
const AIMOCK_ERROR_ENVELOPE = {
  error: {
    message: "Missing required parameter: 'voice_description'",
    type: "invalid_request_error",
  },
};

// ---------------------------------------------------------------------------
// Fixture INPUT — fed through the real serializer by the builder below
// ---------------------------------------------------------------------------

/**
 * The user-facing fixture shape. `LLMock.onElevenLabsVoiceDesign()` runs it
 * through `voiceDesignToJson()` — the production serializer — so what the
 * server returns is the serializer's own output, not a verbatim copy of this
 * object. That is what makes a serializer mutation red here.
 */
const VOICE_DESIGN_SOURCE: VoiceDesignResponse = {
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
};

const VOICE_DESCRIPTION = "A weathered sea captain in his sixties, gravelly, unhurried";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let mock: LLMock;

beforeAll(async () => {
  const server = new LLMock({ port: 0 });
  server.onElevenLabsVoiceDesign(VOICE_DESCRIPTION, VOICE_DESIGN_SOURCE);
  await server.start();
  // Assigned only once started: `afterAll` below skips `stop()` otherwise,
  // because `stop()` on an unstarted LLMock throws and that throw would REPLACE
  // the `beforeAll` failure in the report.
  mock = server;
});

afterAll(async () => {
  if (mock) await mock.stop();
  // The `/v1/text-to-voice` case below ("the created voice carries exactly the
  // Voice keys aimock claims to emit") writes `preview_captain` into the
  // MODULE-GLOBAL voice store (src/elevenlabs-voice.ts), which `stop()` does
  // not clear — it is not per-server state. Today `vitest.config.drift.ts` and
  // `vitest.config.ts` have disjoint `include` globs so this file can never
  // share a process with elevenlabs-voice.test.ts, and vitest isolates each
  // file anyway, so this is defensive rather than a leak anyone has observed.
  // It costs one call and removes the whole question — and this is the file
  // that actually saves a voice.
  clearElevenLabsVoices();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpPost(
  url: string,
  body: object,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        // A socket error or an abort AFTER the headers arrive settles nothing
        // on `req`, so without these two the promise stays pending and the
        // failure surfaces as a 60s testTimeout with no cause named.
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("response aborted before end")));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** Sorted own-key list, or `[]` for a non-object — never throws on a surprise. */
function sortedKeys(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ElevenLabs Voice Design conformance (offline) — /v1/text-to-voice/design", () => {
  it("serializer output carries exactly the SDK's preview and envelope keys", async () => {
    const res = await httpPost(`${mock.url}/v1/text-to-voice/design`, {
      voice_description: VOICE_DESCRIPTION,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.text);

    // FULL key-set equality, both directions: a dropped field AND an added or
    // renamed one both fail. The previous version of this case rebuilt the
    // "mock" side out of the expected shape's own keys, so neither could.
    expect(sortedKeys(body), "design envelope keys vs SDK envelope keys").toEqual(
      sortedKeys(SDK_DESIGN_RESPONSE),
    );
    expect(Array.isArray(body.previews), "previews is an array").toBe(true);
    expect(body.previews).toHaveLength(1);
    expect(sortedKeys(body.previews[0]), "preview keys vs SDK preview keys").toEqual(
      sortedKeys(SDK_DESIGN_PREVIEW),
    );

    const diffs = triangulate(
      extractShape(SDK_DESIGN_RESPONSE),
      extractShape(SDK_DESIGN_RESPONSE),
      extractShape(body),
    );
    const report = formatDriftReport(
      "ElevenLabs /v1/text-to-voice/design (offline conformance)",
      diffs,
      "elevenlabs-voice",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("serializer fills the optional preview fields the SDK marks optional", async () => {
    // Same route, a fixture that omits every optional field — the defaults are
    // the serializer's own, so dropping one shows up as a missing key.
    const bare = new LLMock({ port: 0 });
    bare.onElevenLabsVoiceDesign(VOICE_DESCRIPTION, {
      previews: [{ generated_voice_id: "", audio_base_64: "" }],
    });
    // The server is constructed above the `try`; `start()` (which binds the
    // port) and the request run inside it, so a failure in either still reaches
    // the `finally`. `started` guards `stop()` because stopping an unstarted
    // LLMock throws and would hide the original error.
    let started = false;
    try {
      await bare.start();
      started = true;
      const res = await httpPost(`${bare.url}/v1/text-to-voice/design`, {
        voice_description: VOICE_DESCRIPTION,
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.text);
      expect(sortedKeys(body), "design envelope keys vs SDK envelope keys").toEqual(
        sortedKeys(SDK_DESIGN_RESPONSE),
      );
      expect(
        sortedKeys(body.previews[0]),
        "preview keys vs the SDK's REQUIRED preview keys",
      ).toEqual(sortedKeys(SDK_DESIGN_PREVIEW_REQUIRED));
      // Defaults the serializer substitutes, pinned by value.
      expect(body.previews[0].generated_voice_id).toBe("aimock-preview-0");
      expect(body.previews[0].media_type).toBe("audio/mpeg");
      expect(body.previews[0].duration_secs).toBe(0);
      // OMITTED, not null: the SDK models `language` optional, so no language
      // in means no key out.
      expect(Object.hasOwn(body.previews[0], "language")).toBe(false);
      expect(body.text).toBe("");
    } finally {
      if (started) await bare.stop();
    }
  });

  it("missing voice_description returns 400 with aimock's error envelope", async () => {
    const res = await httpPost(`${mock.url}/v1/text-to-voice/design`, {});

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.text);
    // KNOWN DIVERGENCE: the real service answers a missing or short body field
    // with 422 `{ detail: [ { type, loc, msg, ... } ] }` — an ARRAY, and body
    // validation runs before auth, so it was observed keyless on 2026-09-15 —
    // and an auth failure with 401 `{ detail: { type, code, message, status,
    // request_id } }`, an object. aimock answers its house 400 envelope on
    // purpose; this pins aimock's contract, not ElevenLabs'.
    expect(sortedKeys(body)).toEqual(sortedKeys(AIMOCK_ERROR_ENVELOPE));
    expect(sortedKeys(body.error)).toEqual(sortedKeys(AIMOCK_ERROR_ENVELOPE.error));

    const diffs = triangulate(
      extractShape(AIMOCK_ERROR_ENVELOPE),
      extractShape(AIMOCK_ERROR_ENVELOPE),
      extractShape(body),
    );
    const report = formatDriftReport(
      "ElevenLabs /v1/text-to-voice/design 400 error (offline conformance)",
      diffs,
      "elevenlabs-voice",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

describe("ElevenLabs Voice Design conformance (offline) — /v1/text-to-voice", () => {
  it("the created voice carries exactly the Voice keys aimock claims to emit", async () => {
    const res = await httpPost(`${mock.url}/v1/text-to-voice`, {
      voice_name: "Captain",
      voice_description: VOICE_DESCRIPTION,
      generated_voice_id: "preview_captain",
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.text);

    // FULL key set. The previous version copied four keys off the expected
    // shape onto the "mock" side, so the other thirteen could vanish green.
    expect(sortedKeys(body), "voice keys vs SDK-emitted Voice keys").toEqual(
      sortedKeys(SDK_VOICE_EMITTED),
    );
    expect(
      sortedKeys(body.voice_verification),
      "voice_verification keys vs SDK VoiceVerificationResponse keys",
    ).toEqual(sortedKeys(SDK_VOICE_EMITTED.voice_verification));

    // The declared omission, asserted so it stays declared.
    for (const key of SDK_VOICE_KEYS_NOT_EMITTED) {
      expect(body, `Voice.Raw key aimock does not emit: ${key}`).not.toHaveProperty(key);
    }

    expect(body.voice_id).toBe("preview_captain");
    expect(body.name).toBe("Captain");
    expect(body.category).toBe("generated");

    const diffs = triangulate(
      extractShape(SDK_VOICE_EMITTED),
      extractShape(SDK_VOICE_EMITTED),
      extractShape(body),
    );
    const report = formatDriftReport(
      "ElevenLabs /v1/text-to-voice (offline conformance)",
      diffs,
      "elevenlabs-voice",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("missing generated_voice_id returns 400 with aimock's error envelope", async () => {
    const res = await httpPost(`${mock.url}/v1/text-to-voice`, {
      voice_name: "Captain",
      voice_description: VOICE_DESCRIPTION,
    });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.text);
    expect(sortedKeys(body)).toEqual(sortedKeys(AIMOCK_ERROR_ENVELOPE));
    expect(sortedKeys(body.error)).toEqual(sortedKeys(AIMOCK_ERROR_ENVELOPE.error));
    expect(body.error.message).toBe("Missing required parameter: 'generated_voice_id'");
  });
});
