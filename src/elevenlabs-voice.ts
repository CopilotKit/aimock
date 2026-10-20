import { renderError } from "./response/errors.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import type http from "node:http";
import type {
  ChatCompletionRequest,
  Fixture,
  HandlerDefaults,
  RawJSONResponse,
  VoiceDesignResponse,
} from "./types.js";
import {
  isErrorResponse,
  isJSONResponse,
  isJsonObject,
  flattenHeaders,
  getContext,
  getTestId,
  resolveResponse,
  strictNoMatchMessage,
  strictNoMatchLogLine,
  wouldProxyMiss,
} from "./helpers.js";
import { releaseOneShotError } from "./fixture-loader.js";
import { selectFixtureForServing } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { proxyAndRecord } from "./recorder.js";
import type { ProxyCapturedResponse, ProxyOptions } from "./recorder.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { applyChaosAsync, type ChaosAsyncOutcome } from "./chaos.js";

/**
 * ElevenLabs Voice Design record + replay: `POST /v1/text-to-voice/design`
 * (previews), `POST /v1/text-to-voice` (create a voice from a preview),
 * `GET /v1/voices/{voice_id}`, `DELETE /v1/voices/{voice_id}`.
 *
 * PROVENANCE OF EVERY WIRE FACT IN THIS FILE. Read this before changing a
 * field name, a status code, or a literal below.
 *
 * FIRSTHAND — observed by this repo against live `api.elevenlabs.io` on
 * 2026-09-15, with NO api key and with a deliberately invalid one. No
 * ElevenLabs api key is reachable from this machine (1Password holds an
 * `elevenlabs.io` web login, not a key), so only the pre-auth and auth layers
 * were ever exercised:
 *   - `POST /v1/text-to-voice/design` with a >=20-char `voice_description` and
 *     no credential -> 401
 *     `{"detail":{"type":"authentication_error","code":"unauthorized",
 *      "message":"Neither authorization header nor xi-api-key received, please
 *      provide one.","status":"needs_authorization","request_id":"<hex>"}}`.
 *     Same envelope from `GET /v1/voices/{id}`; with a bogus `xi-api-key` the
 *     message/status become `"Invalid API key"` / `"invalid_api_key"`.
 *   - `voice_description` shorter than 20 chars -> 422 with a pydantic-style
 *     `{"detail":[{"type":"string_too_short","loc":["body",
 *     "voice_description"],...}]}`; `POST /v1/text-to-voice` reports missing
 *     `voice_name` / `generated_voice_id` the same way. So the real service
 *     validates the body BEFORE it authenticates. THIS HANDLER NOW ENFORCES
 *     THAT 20-CODE-POINT MINIMUM on `POST /v1/text-to-voice/design`
 *     (`VOICE_DESCRIPTION_MIN_LENGTH`) and answers with that same `422
 *     {"detail":[...]}` envelope rather than aimock's house error shape — the
 *     one response on this surface whose real shape was observed. The `msg`
 *     STRING it fills in ("String should have at least 20 characters") is
 *     AUTHORED: the observed body was recorded with `msg` elided, so only the
 *     status, the `detail` array and the `loc`/`type` values are firsthand.
 *     ORDER ON `POST /v1/text-to-voice/design`: missing-parameter 400 ->
 *     fixture match (a registered short-description fixture still serves) ->
 *     chaos -> strict refusal / record-mode proxy (so the REAL 422 is recorded
 *     verbatim instead of pre-empted) -> this local 20-code-point 422 ->
 *     no-match 404. `POST /v1/text-to-voice` follows the same order, with its
 *     empty-string 422 in the same slot ahead of the synthesized voice.
 *     The minimum is NOT enforced on `POST /v1/text-to-voice`, whose
 *     `voice_description` bound has never been probed; that route rejects only
 *     an EMPTY description, which is short under any `min_length >= 1`.
 *   - `GET /v1/voices/aimock-nonexistent-voice` -> 400
 *     `{"detail":{"type":"invalid_request","code":"bad_request","message":"An
 *     invalid ID has been received: ...","status":"invalid_uid",...}}`.
 *   KNOWN DIVERGENCE, recorded rather than papered over: every real envelope
 *   above is keyed `detail`, while this handler still emits aimock's house
 *   `{ error: { message, type, code } }` shape — and aimock's own 400/404/503
 *   codes — for EVERY failure except the `voice_description` minimum. That is
 *   deliberate consistency with every other surface here, but it means those
 *   ERROR envelopes are NOT wire-faithful to ElevenLabs. Making the whole
 *   module speak `detail` is a FOLLOW-UP: it is a breaking change for every
 *   existing consumer of this surface, and the shapes of the OTHER failures
 *   (missing parameter, unknown voice, strict-mode refusal) have not been
 *   observed, so they cannot be authored from the one case that has. A
 *   RECORDED fixture is a second exception: it replays the upstream `detail`
 *   body verbatim under the upstream status, so it is faithful by
 *   construction.
 *
 * SECONDARY — the official client `@elevenlabs/elevenlabs-js`, pinned to the
 * exact published version `2.68.0` (`node_modules/@elevenlabs/elevenlabs-js/
 * package.json` -> `"version": "2.68.0"`). Every claim below was read out of
 * these files, at that version, and nowhere else:
 *   - `api/resources/textToVoice/client/Client.d.ts` /`.js` — the routes, and
 *     the `@throws` list for each (`UnprocessableEntityError` only);
 *   - `api/resources/textToVoice/client/requests/VoiceDesignRequestModel.d.ts`
 *     and `.../BodyCreateANewVoiceFromVoicePreviewV1TextToVoicePost.d.ts` —
 *     the request bodies;
 *   - `api/types/VoiceDesignPreviewResponse.d.ts`,
 *     `api/types/VoicePreviewResponseModel.d.ts`, `api/types/Voice.d.ts`,
 *     `api/types/HttpValidationError.d.ts`, `api/types/ValidationError.d.ts`,
 *     `api/types/ValidationErrorLocItem.d.ts` — the response models;
 *   - the matching `serialization/types/*.d.ts` `Raw` interfaces and
 *     `serialization/types/*.js` schemas — the on-wire snake_case names and
 *     each field's optional/nullable treatment;
 *   - `api/errors/UnprocessableEntityError.js` (422) and
 *     `api/errors/ConflictError.js` (409, never declared for these routes).
 * It pins:
 *   - the four routes above, and that create-from-preview is `POST
 *     /v1/text-to-voice` taking `voice_name`, `voice_description`,
 *     `generated_voice_id`, optional `labels`;
 *   - the design SUCCESS body `{ previews: [...], text }` where each preview is
 *     `{ audio_base_64, generated_voice_id, media_type, duration_secs,
 *     language? }` — `language` optional, the rest required;
 *   - `model_id` values `eleven_multilingual_ttv_v2` / `eleven_ttv_v3`;
 *   - the `Voice` object's wire fields. Every key `buildSyntheticVoice()`
 *     emits (`voice_id`, `name`, `category`, `description`, `labels`,
 *     `preview_url`, `available_for_tiers`, `settings`, `sharing`,
 *     `high_quality_base_model_ids`, `samples`, `safety_control`,
 *     `voice_verification` with its four inner keys, `permission_on_resource`,
 *     `is_owner`, `is_legacy`, `is_mixed`) appears in `Voice.Raw` /
 *     `VoiceVerificationResponse.Raw`, and `"generated"` is one of that SDK's
 *     six `VoiceCategory` tokens;
 *   - `DELETE /v1/voices/{id}` answering `{ status: "ok" }`.
 *   ElevenLabs' own documentation site is a client-rendered SPA and was NOT
 *   read; the SDK is the only document behind these shapes.
 *
 * UNVERIFIED / HAND-AUTHORED — name it, do not soften it:
 *   - NO successful response from ElevenLabs has ever been observed by this
 *     repo, for any of these four routes. There is no recorded fixture or tape
 *     for this surface anywhere in the tree; the drift test in
 *     `src/__tests__/drift/elevenlabs-voice.drift.ts` restates the same
 *     hand-authored shape it checks, so it detects mock-vs-fixture divergence
 *     only and can
 *     never detect divergence from the real API.
 *   - The VALUES `buildSyntheticVoice()` fills those fields with (`null`s, `[]`,
 *     `is_owner: true`, `is_legacy`/`is_mixed` false, the zeroed
 *     `voice_verification`) are aimock's choices for a just-created voice, not
 *     anything observed. The SDK marks all of them optional and nullable, so
 *     they are plausible, not confirmed.
 *   - `voice_id === generated_voice_id` for a created voice. AUTHORED — see
 *     `buildSyntheticVoice()`. The SDK relates the two nowhere; aimock picks
 *     the alias so a caller can GET back what it just created. No code should
 *     depend on it as a wire fact.
 *   - Re-creating an already-created `generated_voice_id` overwrites and
 *     answers 200. AUTHORED — see `rememberElevenLabsVoice()`. The real
 *     behaviour is unknown and the SDK declares no `ConflictError` for the
 *     route, so aimock warns through the module logger instead of inventing a
 *     rejection.
 *   - `Voice.Raw` carries further fields this handler never emits
 *     (`fine_tuning`, `verified_languages`, `collection_ids`,
 *     `created_at_unix`, `favorited_at_unix`, `is_bookmarked`,
 *     `recording_quality`, `labelling_status`, `recording_quality_reason`). A
 *     consumer reading them off a replayed voice gets `undefined`.
 *   The standing rule still holds: THE MOCK NEVER AUTHORS A WIRE VALUE IT DID
 *   NOT OBSERVE. This surface currently does, and this block is where that debt
 *   is declared. Recording one real design + create round-trip against a funded
 *   key would retire most of it.
 */

const VOICE_STORE_MAX = 10_000;

/**
 * `POST /v1/text-to-voice/design` rejects a `voice_description` shorter than
 * this. FIRSTHAND: observed against live `api.elevenlabs.io` on 2026-09-15 (see
 * the PROVENANCE block above) — a sub-20-character description comes back 422
 * with a pydantic `string_too_short` entry, BEFORE the request is even
 * authenticated, so the bound is observable without a key.
 *
 * THE UNIT IS CODE POINTS, NOT UTF-16 CODE UNITS. The bound is pydantic's
 * `min_length`, which is `len(str)` in Python — a count of code points. A
 * JavaScript `String.length` counts UTF-16 code units instead, so it
 * DOUBLE-COUNTS every non-BMP character: a 19-emoji description is 19 code
 * points to the real service (422) and 38 `.length` to JavaScript (would have
 * passed here and then failed on the wire, which is the exact class of
 * divergence this mock exists to prevent). Measure with `[...s].length`, whose
 * string iterator yields code points. Grapheme clusters are deliberately NOT
 * the unit: Python does not count those either, so `Intl.Segmenter` would
 * re-introduce the same disagreement from the other side.
 */
const VOICE_DESCRIPTION_MIN_LENGTH = 20;

/**
 * The real service answers body-validation failures with FastAPI/pydantic's
 * envelope: HTTP 422 and `{"detail":[{"loc":[...],"msg":...,"type":...}]}`.
 * The key set is pinned by `@elevenlabs/elevenlabs-js@2.68.0`
 * (`api/types/HttpValidationError.d.ts` -> `detail?: ValidationError[]`,
 * `api/types/ValidationError.d.ts` -> `{ loc, msg, type }`,
 * `serialization/types/ValidationError.d.ts` for the identical on-wire Raw),
 * and the status by `api/errors/UnprocessableEntityError.js`
 * (`statusCode: 422`), which is what that SDK throws for these routes.
 *
 * DELIBERATE DIVERGENCE FROM ITS SIBLINGS: every other validation failure in
 * this file answers aimock's house `400 {"error":{...}}`. This one does not,
 * because this is the only body-validation response on this surface whose real
 * shape this repo has actually observed. Aligning the rest is a follow-up, not
 * a licence to author the others' shapes from this one.
 */
function writeValidationError(
  res: http.ServerResponse,
  loc: Array<string | number>,
  msg: string,
  type: string,
): void {
  writeErrorResponse(res, 422, JSON.stringify({ detail: [{ loc, msg, type }] }));
}

/**
 * Voices created via POST /v1/text-to-voice, keyed by voice_id.
 *
 * MODULE-GLOBAL, deliberately: it is the same shape every other bounded store
 * here uses (`FalJobMap` in `./fal-audio.ts`, `FalQueueStateMap` in `./fal.ts`,
 * and the four video job maps), so one process shares one voice store across
 * every `LLMock` instance. `performFullReset` (`./server.ts`) clears it
 * alongside those siblings, which is what `POST /__aimock/reset` and
 * `LLMock.reset()` both route through. `stop()` does NOT clear it — no sibling
 * store is cleared on `stop()` either; reset is the isolation barrier, not
 * server teardown. A test file that creates voices must therefore reset (or
 * call `clearElevenLabsVoices()`) between tests, or a voice saved by one test
 * is still visible to the next.
 */
const elevenLabsVoices = new Map<string, Record<string, unknown>>();

export function clearElevenLabsVoices(): void {
  elevenLabsVoices.clear();
}

/**
 * Store a created voice under its own `voice_id` — the id the client sees in
 * the body we are about to write, so a follow-up `GET /v1/voices/{id}` by that
 * id hits.
 *
 * Returns `false` when the body carries no string `voice_id` and nothing was
 * stored, so the caller can say so instead of dropping the voice silently.
 *
 * AUTHORED: a second create for a `voice_id` already in the store OVERWRITES
 * the first, and still answers 200. Whether the real
 * `POST /v1/text-to-voice` accepts an already-consumed `generated_voice_id` is
 * UNKNOWN to this repo — no successful create has ever been observed, and
 * `@elevenlabs/elevenlabs-js@2.68.0` gives no signal either way: its
 * `api/resources/textToVoice/client/Client.d.ts` declares only
 * `@throws UnprocessableEntityError` for `create`, and never `ConflictError`
 * (`api/errors/ConflictError.js`), so authoring a 409 here would be inventing a
 * status nothing supports. Overwrite-and-200 is aimock's choice; it is made
 * AUDIBLE via `logger.warn` rather than silent, so a test that overwrites a
 * voice by accident can see it.
 *
 * EVICTION IS FIFO AND SILENT, by insertion order — the same rule every
 * sibling store applies (see `FalJobMap.set`, `src/fal-audio.ts:107-116`, and
 * the identical block in `fal.ts` / `openrouter-video.ts` / `grok-video.ts` /
 * `byteplus-video.ts`). Once the map exceeds `VOICE_STORE_MAX`, the
 * oldest-inserted entries are deleted with no log line and no error: a later
 * `GET /v1/voices/{id}` for an evicted voice is indistinguishable from one for
 * a voice that never existed (404, or 503 under strict). It is NOT LRU —
 * reading a voice does not refresh it, and re-saving an existing `voice_id`
 * keeps its ORIGINAL insertion slot, because `Map.set` on a present key does
 * not reorder. The cap exists to bound a long-lived mock process, not to model
 * anything ElevenLabs does; at 10k voices per process no test approaches it.
 */
export function rememberElevenLabsVoice(voice: Record<string, unknown>, logger?: Logger): boolean {
  const voiceId = typeof voice.voice_id === "string" ? voice.voice_id : undefined;
  if (!voiceId) return false;
  if (elevenLabsVoices.has(voiceId)) {
    logger?.warn(
      `ElevenLabs voice '${voiceId}' already existed and was overwritten; aimock does not know whether the real API rejects a reused generated_voice_id`,
    );
  }
  elevenLabsVoices.set(voiceId, voice);
  if (elevenLabsVoices.size > VOICE_STORE_MAX) {
    const excess = elevenLabsVoices.size - VOICE_STORE_MAX;
    const iter = elevenLabsVoices.keys();
    for (let i = 0; i < excess; i++) {
      const next = iter.next();
      if (!next.done) elevenLabsVoices.delete(next.value);
    }
  }
  return true;
}

/**
 * The status a recorded `{ json, status }` replay must answer with.
 *
 * `proxyAndRecord` persists the upstream status alongside the verbatim body for
 * this surface (`src/recorder.ts:901` — `{ json: parsedResponse, status:
 * upstreamStatus }`), and `RawJSONResponse.status` (`src/types.ts:476`) is the
 * field it lands in. Replaying every such fixture as 200 turns every recorded
 * ElevenLabs error — all of which carry a `detail` body, not aimock's house
 * error envelope, so `isErrorResponse()` never claims them — into a fabricated
 * success. `src/fal-audio.ts:1061` reads the same field the same way.
 *
 * Only `status` round-trips: that recorder branch stores no headers for a
 * verbatim-JSON recording, so there is no recorded header to honour here.
 */
function replayStatus(response: RawJSONResponse): number {
  return response.status ?? 200;
}

export function voiceDesignToJson(response: VoiceDesignResponse): RawJSONResponse {
  const previews = response.previews.map((preview, index) => {
    const entry: Record<string, unknown> = {
      generated_voice_id: preview.generated_voice_id || `aimock-preview-${index}`,
      audio_base_64: preview.audio_base_64 ?? "",
      media_type: preview.media_type ?? "audio/mpeg",
      duration_secs: preview.duration_secs ?? 0,
    };
    // `language` is OMITTED, never null, when the caller did not supply one:
    // the SDK models it `language?: string` (absent-or-string, never null) in
    // `api/types/VoicePreviewResponseModel.d.ts`, and its runtime schema
    // (`serialization/types/VoicePreviewResponseModel.js`,
    // `core.serialization.string().optional()`) parses an incoming `null` away
    // to `undefined`. A `null` here is therefore a value no SDK consumer can
    // ever observe from the real API.
    if (typeof preview.language === "string") entry.language = preview.language;
    return entry;
  });
  return {
    json: {
      previews,
      text: response.text ?? "",
    },
  };
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * The journal `source` for a chaos fault on a request no fixture answers — the
 * same rule `src/server.ts` applies, via the shared {@link wouldProxyMiss}:
 * the miss is aimock's own answer, "internal", unless record mode has an
 * ElevenLabs upstream to forward it to AND strict mode (server default or the
 * per-request `X-AIMock-Strict` header) is not refusing it first. Both halves
 * used to be hardcoded — design/create said "proxy" with no record config at
 * all, and the slot routes said "internal" while record mode was about to
 * proxy the very same miss.
 */
function noFixtureSource(
  defaults: HandlerDefaults,
  headers: http.IncomingHttpHeaders,
): "proxy" | "internal" {
  return wouldProxyMiss(
    !resolveRequestDecisions(defaults.strict, headers).upstream,
    defaults.record,
    "elevenlabs",
  )
    ? "proxy"
    : "internal";
}

function parseJsonObject(
  body: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  path: string,
  method: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: `Malformed JSON: ${detail}`,
        type: "invalid_request_error",
        code: "invalid_json",
      }).body,
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: null,
      response: { status: 400, fixture: null },
    });
    return null;
  }

  if (!isJsonObject(parsed)) {
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: "Request body must be a JSON object",
        type: "invalid_request_error",
      }).body,
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: null,
      response: { status: 400, fixture: null },
    });
    return null;
  }

  return parsed;
}

function buildSyntheticReq(
  parsed: Record<string, unknown>,
  matchText: string,
  endpoint: "elevenlabs-voice-design" | "elevenlabs-voice",
  modelFallback: string,
  req: http.IncomingMessage,
): ChatCompletionRequest {
  return {
    model: typeof parsed.model_id === "string" ? parsed.model_id : modelFallback,
    messages: [{ role: "user", content: matchText }],
    _endpointType: endpoint,
    _context: getContext(req),
  };
}

async function missPath(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  syntheticReq: ChatCompletionRequest,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
  path: string,
  method: string,
  body: string,
  skippedBySequenceOrTurn: number,
  proxyOptions?: ProxyOptions,
): Promise<"handled" | "miss"> {
  const effectiveStrict = resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss;
  if (effectiveStrict) {
    const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
    defaults.logger.error(strictNoMatchLogLine(method, path, skippedBySequenceOrTurn));
    writeErrorResponse(
      res,
      503,
      renderError("openai", "strict-miss", {
        message: strictMessage,
        type: "invalid_request_error",
        code: "no_fixture_match",
      }).body,
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: {
        status: 503,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    return "handled";
  }

  if (defaults.record) {
    const outcome = await proxyAndRecord(
      req,
      res,
      syntheticReq,
      "elevenlabs",
      req.url ?? path,
      fixtures,
      defaults,
      body,
      proxyOptions,
    );
    if (outcome === "handled_by_hook") return "handled";
    if (outcome !== "not_configured") {
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        service: "elevenlabs-voice",
        body: syntheticReq,
        response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
      });
      return "handled";
    }
  }

  return "miss";
}

function writeNoMatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  syntheticReq: ChatCompletionRequest,
  defaults: HandlerDefaults,
  journal: Journal,
  path: string,
  method: string,
): void {
  writeErrorResponse(
    res,
    404,
    renderError("openai", "fixture-miss", {
      message: "No fixture matched",
      type: "invalid_request_error",
      code: "no_fixture_match",
    }).body,
  );
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    service: "elevenlabs-voice",
    body: syntheticReq,
    response: {
      status: 404,
      fixture: null,
      ...strictOverrideField(defaults.strict, req.headers),
    },
  });
}

/**
 * Builds the `beforeWriteResponse` observer for the voice routes. It NEVER
 * handles the response — it returns `false` so `proxyAndRecord` relays the
 * upstream bytes and the caller still journals the `"relayed"` outcome — it
 * only copies a successfully proxied voice object into the in-process store, so
 * a follow-up `GET /v1/voices/{id}` answers from memory exactly as it does
 * after an in-process create instead of hitting upstream a second time.
 *
 * It is a FACTORY OVER THE LOGGER, not a bare function, because the store has
 * exactly two things worth saying and neither can be said without one: the
 * AUTHORED overwrite of an already-stored `voice_id`, which
 * `rememberElevenLabsVoice` documents as made AUDIBLE rather than silent, and a
 * 2xx voice body carrying no string `voice_id`, which it reports by returning
 * `false`. Both are already reported on the in-process and fixture-replay paths
 * (see the `create` handler's `defaults.logger` calls); passing the observer a
 * bare function dropped both on EVERY proxy path, which is the one path where
 * the body came from somewhere aimock does not control.
 */
function rememberProxiedVoice(logger: Logger): (captured: ProxyCapturedResponse) => false {
  return (captured: ProxyCapturedResponse): false => {
    if (captured.status < 200 || captured.status >= 300) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(captured.body.toString("utf-8"));
    } catch (err) {
      // ONLY a malformed upstream body is swallowed: a non-JSON 2xx carries no
      // voice to remember and the relay is unaffected. `JSON.parse` throws
      // `SyntaxError` and nothing else, so ANY other error came from a genuine
      // defect in this hook and must propagate — `proxyAndRecord` turns a
      // rejected hook into `beforeWriteResponse hook failed for <provider>`
      // (`src/recorder.ts`), which is a visible failure instead of a voice that
      // vanished under the label "upstream sent HTML".
      if (err instanceof SyntaxError) return false;
      throw err;
    }

    if (!isJsonObject(parsed)) return false;
    if (!rememberElevenLabsVoice(parsed, logger)) {
      logger.warn(
        `ElevenLabs relayed a ${captured.status} voice body from upstream that carries no ` +
          `string \`voice_id\` — the voice was NOT stored, so a follow-up ` +
          `GET /v1/voices/{id} will miss and re-hit upstream instead of replaying from ` +
          `memory. Upstream body: ${captured.body.toString("utf-8").slice(0, 200)}`,
      );
    }
    return false;
  };
}

function buildSyntheticVoice(parsed: Record<string, unknown>): Record<string, unknown> {
  // AUTHORED: `voice_id === generated_voice_id`. Nothing in
  // `@elevenlabs/elevenlabs-js@2.68.0` says the created voice keeps the
  // preview's id — `api/resources/textToVoice/client/requests/
  // BodyCreateANewVoiceFromVoicePreviewV1TextToVoicePost.d.ts` documents
  // `generatedVoiceId` only as "the generated_voice_id to create", and the
  // returned `api/types/Voice.d.ts` relates `voiceId` to it nowhere. This is
  // aimock's choice so that a caller can GET the voice it just created; treat
  // it as a mock convention, not a wire fact, and do not build logic on it.
  const generatedVoiceId = String(parsed.generated_voice_id);
  const labels =
    parsed.labels && typeof parsed.labels === "object" && !Array.isArray(parsed.labels)
      ? (parsed.labels as Record<string, unknown>)
      : {};
  return {
    voice_id: generatedVoiceId,
    name: String(parsed.voice_name),
    category: "generated",
    description: String(parsed.voice_description),
    labels,
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
  };
}

export async function handleElevenLabsVoiceDesign(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<void> {
  const path = req.url ?? "/v1/text-to-voice/design";
  const method = req.method ?? "POST";

  const parsed = parseJsonObject(body, req, res, journal, path, method);
  if (!parsed) return;

  // ONLY a non-string (or absent) `voice_description` is MISSING. An empty
  // string is PRESENT AND TOO SHORT: a truthiness test here folded `""` into
  // the missing case and answered aimock's house 400, while the real service
  // answers the same firsthand-observed 422 `string_too_short` it answers for
  // every other sub-minimum description (PROVENANCE block above). `""` is the
  // shortest such description there is, so it is the one case where the house
  // 400 and the observed 422 disagree most visibly.
  const description =
    typeof parsed.voice_description === "string" ? parsed.voice_description : undefined;

  const syntheticReq = buildSyntheticReq(
    parsed,
    description ?? "",
    "elevenlabs-voice-design",
    "eleven_multilingual_ttv_v2",
    req,
  );

  if (description === undefined) {
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: "Missing required parameter: 'voice_description'",
        type: "invalid_request_error",
      }).body,
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status: 400, fixture: null },
    });
    return;
  }

  const testId = getTestId(req);
  const matchCounts = journal.getFixtureMatchCountsForTest(testId);
  const { fixture, skippedBySequenceOrTurn } = selectFixtureForServing(
    fixtures,
    syntheticReq,
    matchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      {
        method,
        path,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        service: "elevenlabs-voice",
      },
      fixture ? "fixture" : noFixtureSource(defaults, req.headers),
      defaults.registry,
      defaults.logger,
    )
  ) {
    releaseOneShotError(fixtures, fixture);
    return;
  }

  if (!fixture) {
    const outcome = await missPath(
      req,
      res,
      syntheticReq,
      fixtures,
      defaults,
      journal,
      path,
      method,
      body,
      skippedBySequenceOrTurn,
    );
    if (outcome === "handled") return;

    // THE LOCAL MINIMUM IS THE LAST RESORT, NOT THE FIRST GATE. It used to run
    // ahead of fixture matching and ahead of `missPath`, which meant a
    // registered short-description fixture could never be served and — worse —
    // record mode answered aimock's own AUTHORED `msg` instead of forwarding,
    // so the one response on this surface whose real shape was observed could
    // never be recorded. `missPath` has already refused (strict) or proxied and
    // recorded (record) by the time we get here, so this only fires when
    // nothing else can answer.
    // Code points, not `.length`: see `VOICE_DESCRIPTION_MIN_LENGTH`.
    if ([...description].length < VOICE_DESCRIPTION_MIN_LENGTH) {
      writeValidationError(
        res,
        ["body", "voice_description"],
        `String should have at least ${VOICE_DESCRIPTION_MIN_LENGTH} characters`,
        "string_too_short",
      );
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        service: "elevenlabs-voice",
        body: syntheticReq,
        response: { status: 422, fixture: null },
      });
      return;
    }

    writeNoMatch(req, res, syntheticReq, defaults, journal, path, method);
    return;
  }

  const response = await resolveResponse(fixture, syntheticReq);

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    writeErrorResponse(res, status, renderError("openai", "fixture", response.error).body, {
      retryAfter: response.retryAfter,
    });
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status, fixture },
    });
    return;
  }

  if (!isJSONResponse(response)) {
    writeErrorResponse(
      res,
      500,
      renderError("openai", "unknown-response", {
        message: "Fixture response is not a JSON type for voice design",
        type: "server_error",
      }).body,
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    return;
  }

  const status = replayStatus(response);
  writeJson(res, status, response.json);
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    service: "elevenlabs-voice",
    body: syntheticReq,
    response: { status, fixture },
  });
}

export async function handleElevenLabsVoiceCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<void> {
  const path = req.url ?? "/v1/text-to-voice";
  const method = req.method ?? "POST";

  const parsed = parseJsonObject(body, req, res, journal, path, method);
  if (!parsed) return;

  // ONLY a non-string (or absent) field is MISSING here, for the same reason
  // the design handler stopped folding `""` into the missing case: an empty
  // string is PRESENT AND TOO SHORT, and the house 400 said the caller had
  // omitted a field it had actually sent. `voice_name` and `generated_voice_id`
  // follow the same rule as `voice_description`.
  const missing =
    typeof parsed.voice_name !== "string"
      ? "voice_name"
      : typeof parsed.voice_description !== "string"
        ? "voice_description"
        : typeof parsed.generated_voice_id !== "string"
          ? "generated_voice_id"
          : null;
  const tooShort =
    parsed.voice_name === ""
      ? "voice_name"
      : parsed.voice_description === ""
        ? "voice_description"
        : parsed.generated_voice_id === ""
          ? "generated_voice_id"
          : null;

  const syntheticReq = buildSyntheticReq(
    parsed,
    typeof parsed.generated_voice_id === "string" ? parsed.generated_voice_id : "",
    "elevenlabs-voice",
    "eleven_multilingual_ttv_v2",
    req,
  );

  if (missing) {
    writeErrorResponse(
      res,
      400,
      renderError("openai", "validation", {
        message: `Missing required parameter: '${missing}'`,
        type: "invalid_request_error",
      }).body,
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status: 400, fixture: null },
    });
    return;
  }

  const testId = getTestId(req);
  const matchCounts = journal.getFixtureMatchCountsForTest(testId);
  const { fixture, skippedBySequenceOrTurn } = selectFixtureForServing(
    fixtures,
    syntheticReq,
    matchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      {
        method,
        path,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        service: "elevenlabs-voice",
      },
      fixture ? "fixture" : noFixtureSource(defaults, req.headers),
      defaults.registry,
      defaults.logger,
    )
  ) {
    releaseOneShotError(fixtures, fixture);
    return;
  }

  if (!fixture) {
    const outcome = await missPath(
      req,
      res,
      syntheticReq,
      fixtures,
      defaults,
      journal,
      path,
      method,
      body,
      skippedBySequenceOrTurn,
      { beforeWriteResponse: rememberProxiedVoice(defaults.logger) },
    );
    if (outcome === "handled") return;

    // THE LOCAL MINIMUM IS THE LAST RESORT, NOT THE FIRST GATE — same position
    // as the design handler's, for the same reasons: a registered fixture,
    // chaos, strict and the record proxy all get their turn first, so record
    // mode forwards and records the REAL 422 instead of authoring one.
    // An EMPTY string is the one length this route can answer without
    // authoring an unobserved bound: it is under ANY `min_length >= 1`, so
    // `string_too_short` holds whatever the real minimum on
    // `POST /v1/text-to-voice` turns out to be. THE 20-CODE-POINT BOUND IS
    // DELIBERATELY NOT ENFORCED HERE — that minimum was observed on
    // `/v1/text-to-voice/design` only (PROVENANCE block), and this route's
    // bounds have never been probed. The `msg` string is AUTHORED, like its
    // design sibling's.
    if (tooShort) {
      writeValidationError(
        res,
        ["body", tooShort],
        "String should have at least 1 character",
        "string_too_short",
      );
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        service: "elevenlabs-voice",
        body: syntheticReq,
        response: { status: 422, fixture: null },
      });
      return;
    }

    const voice = buildSyntheticVoice(parsed);
    rememberElevenLabsVoice(voice, defaults.logger);
    writeJson(res, 200, voice);
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status: 200, fixture: null },
    });
    return;
  }

  const response = await resolveResponse(fixture, syntheticReq);

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    writeErrorResponse(res, status, renderError("openai", "fixture", response.error).body, {
      retryAfter: response.retryAfter,
    });
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status, fixture },
    });
    return;
  }

  if (!isJSONResponse(response)) {
    writeErrorResponse(
      res,
      500,
      renderError("openai", "unknown-response", {
        message: "Fixture response is not a JSON type for voice create",
        type: "server_error",
      }).body,
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    return;
  }

  const status = replayStatus(response);

  // Store the voice under the `voice_id` the CLIENT is about to see (this same
  // body), so its follow-up `GET /v1/voices/{id}` by the id it received hits.
  // Only a 2xx replay creates a voice: a recorded 4xx/5xx `detail` body carries
  // no voice, and remembering it would resurrect the fabricated-success bug
  // from the other side.
  //
  // A 2xx body with no string `voice_id` is an AUTHORING error, not an
  // unservable fixture: the body is still what the recording says the client
  // gets, so serve it and name the defect, the way `src/byteplus-video.ts:469`
  // and `:479` name an envelope that is servable but will strand the client
  // later. (The 500 `server_error` treatment a few lines above — and in
  // `src/fal-audio.ts:1071` — is reserved for a response that CANNOT be served
  // at all, which this one can.)
  if (status >= 200 && status < 300) {
    const remembered =
      isJsonObject(response.json) && rememberElevenLabsVoice(response.json, defaults.logger);
    if (!remembered) {
      defaults.logger.warn(
        `ElevenLabs voice create fixture matched generated_voice_id ` +
          `"${String(parsed.generated_voice_id)}" but its json carries no string \`voice_id\` — ` +
          `the voice was NOT stored, so a follow-up GET /v1/voices/{id} will 404 with a ` +
          `"voice not found" message that points at the id instead of at the fixture. Add a ` +
          `string voice_id to the fixture's json`,
      );
    }
  }

  writeJson(res, status, response.json);
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    service: "elevenlabs-voice",
    body: syntheticReq,
    response: { status, fixture },
  });
}

/**
 * The synthetic request the slot routes (GET/DELETE /v1/voices/{id}) match and
 * journal on. The voice id stands in for the user message so the entry carries
 * the one thing that identifies the request.
 *
 * The endpoint type is the CALLER's, not a constant: ONE ROUTE, ONE ENDPOINT
 * TYPE. GET declares "elevenlabs-voice-get" and DELETE declares
 * "elevenlabs-voice-delete", so neither route's fixtures can ever be confused
 * with the create route's ("elevenlabs-voice") — all three would otherwise
 * carry the same voice id as their match text and answer for one another.
 */
function buildVoiceSlotReq(
  req: http.IncomingMessage,
  voiceId: string,
  endpointType: "elevenlabs-voice-get" | "elevenlabs-voice-delete",
): ChatCompletionRequest {
  return {
    model: "eleven_multilingual_ttv_v2",
    messages: [{ role: "user", content: voiceId }],
    _endpointType: endpointType,
    _context: getContext(req),
  };
}

/**
 * Gate a slot route on chaos exactly as {@link handleElevenLabsVoiceDesign} and
 * {@link handleElevenLabsVoiceCreate} gate theirs: the same `applyChaosAsync`
 * call, awaited BEFORE anything is served, so a configured latency/drop/429
 * applies to a store hit as well as to a miss. It is called AFTER the fixture
 * match and is handed the fixture that matched, because chaos can be authored
 * ON a fixture (`Fixture.chaos`, folded in by `chaos.ts`): passing null here
 * dropped a fixture-level `chaos` block on the floor for these two routes
 * while design/create honoured the identical block. The journal source follows
 * the same fixture/no-fixture split design/create use, via the same
 * {@link noFixtureSource}: "internal" when this process answers the miss,
 * "proxy" when record mode has an ElevenLabs upstream and would forward it.
 *
 * `applyChaosAsync` reads the per-testId chaos scope off `req.url`, which is
 * why the raw url — not the fallback `path` — is what it is handed, matching
 * design/create. The context carries `service: "elevenlabs-voice"` like every
 * other journal write in this module, so a faulted request stays selectable by
 * `GET /__aimock/journal?service=elevenlabs-voice`.
 */
async function gateVoiceSlotChaos(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  syntheticReq: ChatCompletionRequest,
  fixture: Fixture | null,
  defaults: HandlerDefaults,
  journal: Journal,
  path: string,
  method: string,
): Promise<ChaosAsyncOutcome> {
  return await applyChaosAsync(
    res,
    fixture,
    defaults.chaos,
    req.headers,
    req.url,
    journal,
    {
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      service: "elevenlabs-voice",
    },
    fixture ? "fixture" : noFixtureSource(defaults, req.headers),
    defaults.registry,
    defaults.logger,
  );
}

/**
 * Refuse a slot-route miss under strict mode, mirroring {@link missPath}: the
 * refusal is LOGGED through the shared `strictNoMatchLogLine` and the client
 * message names strict mode, so a strict 503 is never mistaken for the route's
 * own 404.
 *
 * `skippedBySequenceOrTurn` is the count `selectFixtureForServing` handed the
 * caller. Both slot routes are fixture routes now, so a candidate fixture CAN
 * be skipped by sequence/turn state here exactly as on create — hardcoding 0
 * told every such refusal "no fixture matched" when the truth was "a fixture
 * matched the content and was held back by its sequenceIndex". When the count
 * is non-zero the client message switches to the shared
 * {@link strictNoMatchMessage} wording that names it; otherwise the
 * voice-specific message is kept, since naming the id is the more useful thing
 * to say when nothing matched at all.
 */
function writeVoiceSlotStrictRefusal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  syntheticReq: ChatCompletionRequest,
  defaults: HandlerDefaults,
  journal: Journal,
  path: string,
  method: string,
  voiceId: string,
  skippedBySequenceOrTurn: number,
): void {
  defaults.logger.error(strictNoMatchLogLine(method, path, skippedBySequenceOrTurn));
  writeErrorResponse(
    res,
    503,
    renderError("openai", "strict-miss", {
      message:
        skippedBySequenceOrTurn > 0
          ? strictNoMatchMessage(skippedBySequenceOrTurn)
          : `Strict mode: voice '${voiceId}' not found`,
      type: "invalid_request_error",
      code: "no_fixture_match",
    }).body,
  );
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    service: "elevenlabs-voice",
    body: syntheticReq,
    response: {
      status: 503,
      fixture: null,
      ...strictOverrideField(defaults.strict, req.headers),
    },
  });
}

/**
 * Proxy a slot-route miss upstream in record mode. Returns "handled" when the
 * upstream answer was relayed (or a hook took over), "miss" when no upstream is
 * configured for the provider — `proxyAndRecord` already warns on that path, so
 * the caller falls through to its own miss answer.
 */
async function proxyVoiceSlotMiss(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  syntheticReq: ChatCompletionRequest,
  defaults: HandlerDefaults,
  journal: Journal,
  path: string,
  method: string,
  fixtures: Fixture[] = [],
  proxyOptions?: ProxyOptions,
): Promise<"handled" | "miss"> {
  const outcome = await proxyAndRecord(
    req,
    res,
    syntheticReq,
    "elevenlabs",
    req.url ?? path,
    fixtures,
    defaults,
    "",
    proxyOptions,
  );
  if (outcome === "handled_by_hook") return "handled";
  if (outcome === "not_configured") return "miss";
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    service: "elevenlabs-voice",
    body: syntheticReq,
    response: { status: res.statusCode ?? 200, fixture: null, source: "proxy" },
  });
  return "handled";
}

/**
 * Replay a fixture that matched on a slot route (`GET`/`DELETE /v1/voices/{id}`).
 *
 * Both slot routes replay identically, so the body lives here once: resolve,
 * relay an error envelope under its own status, refuse a non-JSON response,
 * and otherwise write the recorded JSON under {@link replayStatus} — the
 * UPSTREAM status the recorder persisted, not a hardcoded 200. GET used to
 * hardcode 200, which turned every recorded ElevenLabs failure (a `detail`
 * body that `isErrorResponse()` never claims) into a fabricated success.
 *
 * Returns the status actually written, or `null` when the fixture could not be
 * served as a success (an error envelope was relayed, or the response was not
 * JSON at all). DELETE uses that to decide whether the local store entry is
 * gone.
 */
async function replayVoiceSlotFixture(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  syntheticReq: ChatCompletionRequest,
  fixture: Fixture,
  journal: Journal,
  path: string,
  method: string,
  routeLabel: string,
): Promise<number | null> {
  const response = await resolveResponse(fixture, syntheticReq);

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    writeErrorResponse(res, status, renderError("openai", "fixture", response.error).body, {
      retryAfter: response.retryAfter,
    });
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status, fixture },
    });
    return null;
  }

  if (!isJSONResponse(response)) {
    writeErrorResponse(
      res,
      500,
      renderError("openai", "unknown-response", {
        message: `Fixture response is not a JSON type for ${routeLabel}`,
        type: "server_error",
      }).body,
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status: 500, fixture },
    });
    return null;
  }

  const status = replayStatus(response);
  writeJson(res, status, response.json);
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    service: "elevenlabs-voice",
    body: syntheticReq,
    response: { status, fixture },
  });
  return status;
}

/**
 * FIXTURE BEFORE STORE, on both slot routes.
 *
 * A registered or recorded fixture is explicit authoring intent and wins over
 * the in-process voice store, which is a replay CONVENIENCE populated as a
 * side effect of create. That is the order every other replay route in this
 * repo uses — fixture match first, internal state only on a miss — and without
 * it a fixture authored specifically for `GET /v1/voices/{id}` (a recorded 401,
 * say) was silently unreachable for any id that create had already stored.
 *
 * The shadowing is AUDIBLE rather than silent: when a fixture wins over a
 * present store entry this logs at debug, so a test whose store entry stopped
 * being served can see why.
 */
function logVoiceSlotShadow(
  defaults: HandlerDefaults,
  method: string,
  path: string,
  voiceId: string,
): void {
  defaults.logger.debug(
    `ElevenLabs ${method} ${path}: a matching fixture shadows the in-process voice ` +
      `store entry for '${voiceId}' — the fixture is being served`,
  );
}

export async function handleElevenLabsVoiceGet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  voiceId: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<void> {
  const path = req.url ?? `/v1/voices/${voiceId}`;
  const method = req.method ?? "GET";

  // DISTINCT endpoint type from the create route on purpose. GET used to
  // declare "elevenlabs-voice", the same type `POST /v1/text-to-voice`
  // declares, with the voice_id as the match text on both sides — so a fixture
  // recorded on GET became a first-class candidate for create (and hijacked
  // it), while create's own fixtures could be handed to GET. One route, one
  // endpoint type; `src/router.ts` and `src/recorder.ts` both know this name.
  const syntheticReq = buildVoiceSlotReq(req, voiceId, "elevenlabs-voice-get");

  // GET is a first-class replay route, exactly like design and create: a
  // registered or previously recorded fixture serves it. Without this the
  // route could only ever answer from the in-process store, so nothing
  // recorded to disk was reachable on a later run. See
  // {@link logVoiceSlotShadow} for why the fixture is consulted BEFORE the
  // store. The match runs BEFORE the chaos gate — and the count is incremented
  // before it, as design/create do — so a fixture-level `chaos` block reaches
  // the gate; see {@link gateVoiceSlotChaos}.
  const testId = getTestId(req);
  const matchCounts = journal.getFixtureMatchCountsForTest(testId);
  const { fixture, skippedBySequenceOrTurn } = selectFixtureForServing(
    fixtures,
    syntheticReq,
    matchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (await gateVoiceSlotChaos(req, res, syntheticReq, fixture, defaults, journal, path, method)) {
    releaseOneShotError(fixtures, fixture);
    return;
  }

  const stored = elevenLabsVoices.get(voiceId);

  if (fixture) {
    if (stored) logVoiceSlotShadow(defaults, method, path, voiceId);
    await replayVoiceSlotFixture(
      req,
      res,
      syntheticReq,
      fixture,
      journal,
      path,
      method,
      "voice get",
    );
    return;
  }

  const serveStored = (voice: Record<string, unknown>): void => {
    writeJson(res, 200, voice);
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: { status: 200, fixture: null },
    });
  };

  // IN RECORD MODE THE LOCAL STORE IS NOT AUTHORITATIVE, the same guard DELETE
  // carries. Answering a locally-known voice from memory kept the GET out of
  // the tape entirely — a proxied create left the voice in the store, so no
  // `elevenlabs-voice-get` fixture was ever recorded and the replay run, which
  // has only the tape, 404'd on the GET that "worked" while recording.
  if (stored && !defaults.record) {
    serveStored(stored);
    return;
  }

  // STRICT BEFORE RECORD, the precedence missPath() uses. A strict server
  // refuses the miss outright; it must not silently proxy it upstream.
  if (resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss) {
    writeVoiceSlotStrictRefusal(
      req,
      res,
      syntheticReq,
      defaults,
      journal,
      path,
      method,
      voiceId,
      skippedBySequenceOrTurn,
    );
    return;
  }

  if (defaults.record) {
    // The REAL fixtures array, not a throwaway `[]`: `persistFixture`
    // (`src/recorder.ts`) pushes the freshly recorded fixture into whatever
    // array it is handed, so passing a discarded literal made the live server
    // forget what it had just recorded and re-hit upstream on every
    // subsequent GET.
    const outcome = await proxyVoiceSlotMiss(
      req,
      res,
      syntheticReq,
      defaults,
      journal,
      path,
      method,
      fixtures,
      { beforeWriteResponse: rememberProxiedVoice(defaults.logger) },
    );
    if (outcome === "handled") return;
    // Record mode is on but NO ElevenLabs upstream is configured (`--record`
    // aimed at another provider): the proxy cannot forward, and the create
    // that handed this id out was synthesized locally on that same path. The
    // store is the only thing that knows the voice, so it answers.
    if (stored) {
      serveStored(stored);
      return;
    }
  }

  writeErrorResponse(
    res,
    404,
    renderError("openai", "fixture-miss", {
      message: `Voice '${voiceId}' not found`,
      type: "invalid_request_error",
      code: "voice_not_found",
    }).body,
  );
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    service: "elevenlabs-voice",
    body: syntheticReq,
    response: { status: 404, fixture: null, ...strictOverrideField(defaults.strict, req.headers) },
  });
}

/**
 * DELETE /v1/voices/{voice_id}. A first-class record/replay route, exactly
 * like GET: chaos, then a fixture match, then the in-process store, then
 * strict, then record, then the lenient answer.
 *
 * The success body is `{ status: "ok" }` — SECONDARY, from
 * `@elevenlabs/elevenlabs-js@2.68.0`: `voices.delete()` parses the response as
 * `DeleteVoiceResponseModel`, whose only wire field is `status: string`, and
 * whose doc comment reads "The status of the voice deletion request. If the
 * request was successful, the status will be 'ok'." In record mode nothing is
 * authored at all — the upstream's own response is relayed AND recorded.
 *
 * IN RECORD MODE THE LOCAL STORE IS NOT AUTHORITATIVE. A locally-known voice
 * used to be deleted from the map and answered 200 without the request ever
 * leaving the process, so the real voice leaked upstream and the tape got a
 * hole exactly where the delete belonged. Record mode forwards regardless of
 * what the store knows; the store is a replay convenience, not a claim about
 * what exists upstream. It still evicts ONLY on a 2xx from upstream, the same
 * rule the fixture-replay branch applies: a refused delete must not lose the
 * local voice.
 *
 * A miss on a LENIENT server stays an idempotent 200: deleting an id that was
 * never saved is not an error on this surface.
 */
export async function handleElevenLabsVoiceDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  voiceId: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  journal: Journal,
): Promise<void> {
  const path = req.url ?? `/v1/voices/${voiceId}`;
  const method = req.method ?? "DELETE";

  // Its OWN endpoint type, for the same reason GET has one: DELETE used to
  // declare "elevenlabs-voice" with the voice id as its match text — byte for
  // byte what `POST /v1/text-to-voice` declares — so a recorded DELETE
  // (`{"status":"ok"}`) was a first-class candidate for create and hijacked it
  // on the next run.
  const syntheticReq = buildVoiceSlotReq(req, voiceId, "elevenlabs-voice-delete");

  // Match (and count) BEFORE the chaos gate, exactly as GET and design/create
  // do, so a fixture-level `chaos` block reaches the gate.
  const testId = getTestId(req);
  const matchCounts = journal.getFixtureMatchCountsForTest(testId);
  const { fixture, skippedBySequenceOrTurn } = selectFixtureForServing(
    fixtures,
    syntheticReq,
    matchCounts,
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
  }

  if (await gateVoiceSlotChaos(req, res, syntheticReq, fixture, defaults, journal, path, method)) {
    releaseOneShotError(fixtures, fixture);
    return;
  }

  const stored = elevenLabsVoices.has(voiceId);

  if (fixture) {
    if (stored) logVoiceSlotShadow(defaults, method, path, voiceId);
    const status = await replayVoiceSlotFixture(
      req,
      res,
      syntheticReq,
      fixture,
      journal,
      path,
      method,
      "voice delete",
    );
    // Only a 2xx replay says the voice is gone. A replayed 4xx/5xx is the
    // recording saying the delete did NOT happen, so the local entry stays.
    if (status !== null && status >= 200 && status < 300) elevenLabsVoices.delete(voiceId);
    return;
  }

  if (stored && !defaults.record) {
    elevenLabsVoices.delete(voiceId);
    writeJson(res, 200, { status: "ok" });
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      service: "elevenlabs-voice",
      body: syntheticReq,
      response: {
        status: 200,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    return;
  }

  // STRICT BEFORE RECORD, the precedence missPath() and GET both use.
  if (resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss) {
    writeVoiceSlotStrictRefusal(
      req,
      res,
      syntheticReq,
      defaults,
      journal,
      path,
      method,
      voiceId,
      skippedBySequenceOrTurn,
    );
    return;
  }

  if (defaults.record) {
    // Evict ONLY on a 2xx from upstream, the same rule the fixture-replay
    // branch above applies: an upstream 4xx/5xx is upstream saying the delete
    // did NOT happen, and dropping the entry anyway lost a local voice to a
    // refusal. `beforeWriteResponse` observes the captured upstream status and
    // returns `false`, so `proxyAndRecord` still relays the bytes and the
    // caller still journals the `"relayed"` outcome.
    // The REAL fixtures array, for the same reason GET passes it: the
    // throwaway `[]` this used to pass meant every recorded DELETE was
    // discarded on the spot, never replayed, and every repeat re-hit upstream.
    const outcome = await proxyVoiceSlotMiss(
      req,
      res,
      syntheticReq,
      defaults,
      journal,
      path,
      method,
      fixtures,
      {
        beforeWriteResponse: (captured): false => {
          if (captured.status >= 200 && captured.status < 300) {
            elevenLabsVoices.delete(voiceId);
          }
          return false;
        },
      },
    );
    if (outcome === "handled") return;
  }

  elevenLabsVoices.delete(voiceId);
  writeJson(res, 200, { status: "ok" });
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    service: "elevenlabs-voice",
    body: syntheticReq,
    response: { status: 200, fixture: null, ...strictOverrideField(defaults.strict, req.headers) },
  });
}
