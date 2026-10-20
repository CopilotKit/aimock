import type * as http from "node:http";
import crypto from "node:crypto";
import type { ChatCompletionRequest, Fixture, HandlerDefaults, RecordConfig } from "./types.js";
import {
  isJSONResponse,
  isErrorResponse,
  serializeErrorResponse,
  flattenHeaders,
  getTestId,
  resolveResponse,
  getContext,
  strictNoMatchMessage,
  strictNoMatchLogLine,
} from "./helpers.js";
import { resolveRequestDecisions, strictOverrideField } from "./response/policy.js";
import { matchFixtureDiagnostic } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import type { Journal } from "./journal.js";
import { applyChaosAsync } from "./chaos.js";
import { resolveProgression } from "./fal.js";
import {
  buildFixtureMatch,
  prepareEgressHeaders,
  persistFixture,
  sanitizeHeaderValue,
} from "./recorder.js";
import { resolveUpstreamUrl } from "./url.js";
import { readEnvelopeText, upstreamTimeoutSignal } from "./video-proxy-shared.js";

/**
 * BytePlus Ark (ModelArk / Seedance) async video task lifecycle mock. Submit
 * `POST /api/v3/contents/generations/tasks` returns `{ id }`; status
 * `GET /api/v3/contents/generations/tasks/{id}` polls
 * `queued → running → <recorded terminal status>`.
 *
 * THE FIXTURE FORMAT IS THE ARK TASK ENVELOPE ITSELF, stored as a
 * `RawJSONResponse` (`{ response: { json: … } }`) — NOT a `VideoResponse`. That
 * is the central decision of this surface and it is what lets `cancelled` and
 * `expired` (terminal states with no representation in `VideoResponse.status`)
 * record and replay natively, lets a recorded `error` object replay without
 * inventing a code, and lets `usage`, `framespersecond`, `draft_task_id` and any
 * field the vendor adds later survive because they were recorded rather than
 * enumerated.
 *
 * PROVENANCE OF EVERY WIRE FACT IN THIS FILE. One source for the TASK shapes —
 * create, poll, the `succeeded`/`failed` envelopes, the status tokens, the
 * unknown-task 404: the client library `@tanstack/ai-byteplus@0.3.4` — its
 * `wire-types.ts`, its request builders, and its author's note of live calls
 * made on 2026-07-31. That is a SECONDARY source. BytePlus's own documentation
 * is a client-rendered SPA and was never read. Exactly one layer is firsthand:
 * the keyless canary in `src/__tests__/drift/byteplus-video.drift.ts` does call
 * live Ark, and observed its AUTH-layer 401 error envelope on 2026-09-10 (see
 * the `OBSERVED_*` constants there). No SUCCESS or resource-layer response from
 * Ark has ever been observed here — the authenticated unknown-task canary is
 * still `skipIf`-gated for want of an `ARK_API_KEY` in repo secrets. So "the
 * client library's six status tokens" is a claim this repo can back, and "the
 * vendor's documented six" is not — comments below say the former. Where a fact is not even secondhand, it is named as unverified
 * rather than softened. A verification nobody performed is worse than an
 * admitted gap: it stops the next person from looking.
 *
 * The governing rule: THE MOCK NEVER AUTHORS A WIRE VALUE IT DID NOT OBSERVE.
 * On replay exactly three things are synthesized — the `id` rewrite, the
 * `queued`/`running` token on a NON-terminal poll, and withholding
 * `content`/`error`/`usage` until terminal. Nothing else. There is no default
 * error code, no default error message, no fabricated `usage`, and no
 * placeholder video url: a terminal fixture missing `content.video_url` gets a
 * named warn, not a substituted URL, because the consumer's error naming the
 * real problem beats a download of a URL aimock made up.
 *
 * `video.url` is served AS-IS — aimock does NOT proxy or capture video bytes.
 * Ark's `content.video_url` expires 24h after `updated_at`; replay warns once
 * when a fixture is served past that instant and still serves it.
 *
 * A fixture for this surface MUST carry `match.endpoint: "video"`. Without it
 * `router.ts`'s endpoint/response compatibility gate skips it (a `{ json }`
 * response is not a `VideoResponse`) before this handler ever sees it.
 */

// ─── Wire constants ─────────────────────────────────────────────────────────

/**
 * Ark's data plane lives under an `/api/v3` prefix ON THE ORIGIN, so
 * `record.providers.byteplus` is configured as an ORIGIN ONLY
 * (`https://ark.ap-southeast.bytepluses.com`) and this handler owns the whole
 * path — the same split `openrouter-video.ts` uses with `OPENROUTER_VIDEOS_PATH`.
 */
export const BYTEPLUS_VIDEO_TASKS_PATH = "/api/v3/contents/generations/tasks";

/**
 * The two NON-terminal task states, per `@tanstack/ai-byteplus@0.3.4`'s
 * `wire-types.ts:38-44` — the client library's status union, not a BytePlus
 * document. This is the primitive: "terminal" is derived as everything else,
 * so a status token the client library does not list (whether BytePlus added
 * it or the library simply never had it) records instead of proxying forever.
 * See `isBytePlusTerminalStatus`.
 */
const BYTEPLUS_NON_TERMINAL_STATUSES = new Set(["queued", "running"]);

/**
 * The six task states the client library declares. Anything outside this set is
 * a surprise — an authoring error, or a token the library does not cover.
 */
const BYTEPLUS_TASK_STATUSES = new Set([
  ...BYTEPLUS_NON_TERMINAL_STATUSES,
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

/**
 * Terminal is the COMPLEMENT of the two non-terminal tokens, never a second
 * hardcoded list of the four terminal ones. An unrecognized status is treated
 * as terminal deliberately: a status absent from the client library's union is
 * far more likely to be an end state than an intermediate one, and guessing wrong
 * in that direction costs a captured fixture the operator can inspect, while
 * guessing wrong the other way costs a record run that polls until the client
 * times out and writes nothing.
 */
function isBytePlusTerminalStatus(status: string): boolean {
  return !BYTEPLUS_NON_TERMINAL_STATUSES.has(status);
}

/** Ark output URLs expire 24h after the task produced them, anchored on `updated_at`. */
const BYTEPLUS_URL_TTL_SECONDS = 24 * 60 * 60;

// ─── BytePlusVideoJobMap (TTL + bounded) ────────────────────────────────────

export const BYTEPLUS_VIDEO_MAX_ENTRIES = 10_000;
const BYTEPLUS_VIDEO_TTL_MS = 3_600_000; // 1 hour

/** Internal lifecycle position. The TERMINAL body comes from the envelope. */
type BytePlusVideoPhase = "queued" | "running" | "terminal";

/** Latches so each authoring/staleness warn fires at most once per ENVELOPE. */
interface BytePlusWarnLatches {
  unknownStatus?: boolean;
  missingUrl?: boolean;
  expiredUrl?: boolean;
  nonTerminalEnvelope?: boolean;
}

/**
 * Warn latches keyed on the ENVELOPE OBJECT, not the job. A suite that replays
 * one aged fixture across a hundred tests mints a hundred jobs off the SAME
 * envelope object (the fixture's `response.json`), and a per-job latch would
 * emit a hundred identical lines — noise, not signal. The envelope is the thing
 * being complained about, so it owns the latch. WeakMap so a fixtures reset
 * drops the latches with the fixtures.
 */
const bytePlusWarnLatches = new WeakMap<Record<string, unknown>, BytePlusWarnLatches>();

function warnLatchesFor(envelope: Record<string, unknown>): BytePlusWarnLatches {
  const existing = bytePlusWarnLatches.get(envelope);
  if (existing !== undefined) return existing;
  const fresh: BytePlusWarnLatches = {};
  bytePlusWarnLatches.set(envelope, fresh);
  return fresh;
}

interface BytePlusVideoReplayJob {
  kind: "replay";
  id: string;
  phase: BytePlusVideoPhase;
  pollCount: number;
  pollsBeforeRunning: number;
  pollsBeforeTerminal: number;
  /** The recorded/authored Ark task envelope. Never mutated. */
  envelope: Record<string, unknown>;
}

/**
 * A job whose lifecycle is proxied live upstream (record mode, no fixture
 * matched at submit). Every client poll is forwarded 1:1; on ANY terminal
 * status the envelope is captured as a fixture and the entry MUTATES into a
 * terminal replay job. All four terminal states are captured identically —
 * there is no warn-and-drop branch, which is the whole payoff of storing the
 * envelope rather than a `VideoResponse`.
 */
interface BytePlusVideoRecordJob {
  kind: "record";
  id: string;
  upstreamTaskId: string;
  upstreamPollingUrl: string;
  match: Fixture["match"];
}

export type BytePlusVideoJob = BytePlusVideoReplayJob | BytePlusVideoRecordJob;

interface BytePlusVideoEntry {
  job: BytePlusVideoJob;
  createdAt: number;
}

/**
 * Per-testId job state. Mirrors GrokVideoJobMap / OpenRouterVideoJobMap: lazy
 * TTL eviction on `get`, FIFO eviction of the oldest entries on `set` when over
 * capacity, delete-before-set TTL refresh, monotonic world-generation counter
 * for reset-mid-flight detection, no background sweep timer.
 * Keys are `${testId}:${id}`.
 */
export class BytePlusVideoJobMap {
  private readonly entries = new Map<string, BytePlusVideoEntry>();
  private worldGeneration = 0;

  get generation(): number {
    return this.worldGeneration;
  }

  get(key: string): BytePlusVideoJob | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > BYTEPLUS_VIDEO_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.job;
  }

  set(key: string, job: BytePlusVideoJob): void {
    this.entries.delete(key);
    this.entries.set(key, { job, createdAt: Date.now() });
    if (this.entries.size > BYTEPLUS_VIDEO_MAX_ENTRIES) {
      const excess = this.entries.size - BYTEPLUS_VIDEO_MAX_ENTRIES;
      const iter = this.entries.keys();
      for (let i = 0; i < excess; i++) {
        const next = iter.next();
        if (!next.done) this.entries.delete(next.value);
      }
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.worldGeneration++;
  }

  get size(): number {
    return this.entries.size;
  }
}

// ─── Match key ──────────────────────────────────────────────────────────────

interface BytePlusContentPart {
  type?: unknown;
  text?: unknown;
  image_url?: unknown;
  video_url?: unknown;
  audio_url?: unknown;
  role?: unknown;
}

/** The `{ url }` wrapper each media part carries, keyed by the part's `type`. */
function mediaUrlOf(part: BytePlusContentPart): string | undefined {
  const holder =
    part.type === "image_url"
      ? part.image_url
      : part.type === "video_url"
        ? part.video_url
        : part.type === "audio_url"
          ? part.audio_url
          : undefined;
  if (holder === null || typeof holder !== "object") return undefined;
  const url = (holder as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
}

function digest12(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Stable-enough serialisation of a part the media table could not resolve. */
function unresolvedPartToken(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return `part:${digest12(String(raw))}`;
  const part = raw as BytePlusContentPart;
  const role = typeof part.type === "string" && part.type ? part.type : "part";
  let serialised: string;
  try {
    serialised = JSON.stringify(raw) ?? String(raw);
  } catch {
    serialised = String(raw);
  }
  return `${role}:${digest12(serialised)}`;
}

/**
 * The synthetic user message a submit is matched on.
 *
 * Concatenated text of every `type: "text"` part, then ALWAYS
 * `[media: <role>:<sha256 first 12 hex>, …]` — one entry per non-text part in
 * array order, `[media: ]` when there are none. The separating newline is
 * present only when there IS text: a key with no text part is the bare
 * `[media: …]` suffix, unprefixed.
 *
 * WHY the digest: a Seedance image-to-video job carries NO text part, so a
 * text-only key would record `{ endpoint, model }` — a wildcard matching every
 * image-to-video job in the suite for that model. `persistFixture`'s
 * defective-fixture guard would not catch it either, because its `isEmptyMatch`
 * requires `endpoint` to be undefined too. Image-to-video, last-frame and
 * reference-media are first-class Seedance modes, so two recordings with the
 * same prompt and different first frames must stay distinguishable.
 *
 * WHY the marker is UNCONDITIONAL: this key lands in `match.userMessage`, which
 * the router SUBSTRING-matches by default (`useExactMatch = !!requestTransform`).
 * A conditional suffix makes the text-only key `"a guitar"` a prefix of the
 * image-to-video key `"a guitar\n[media: …]"`, so a t2v recording silently
 * serves its own video_url to an i2v request that shares the prompt — a 200
 * with the wrong bytes. Emitting `[media: ]` for the text-only case makes
 * neither key a substring of the other. Prefixing would NOT fix it: the plain
 * text is still contained in the prefixed form.
 *
 * WHY every unrecognised part still contributes: `mediaUrlOf` resolves exactly
 * `image_url` / `video_url` / `audio_url` with a `{ url: string }` wrapper, and
 * the whole wire contract here is unverified against BytePlus. Dropping the
 * parts it cannot resolve reopened both failures above — an all-unrecognised
 * content array returned `""` and minted the very wildcard this key exists to
 * prevent, and two different unrecognised parts collapsed onto one key. They
 * are digested over their own JSON instead, so they stay distinguishable
 * without the key ever carrying the part's payload.
 *
 * The digest is taken over the url string whether that is a public URL or a
 * multi-megabyte `data:` URI, and only 12 hex are kept — the match key stays
 * short and the fixture never grows a data URI.
 *
 * `role` is the declared role, else `first_frame` for an image (the default
 * `@tanstack/ai-byteplus@0.3.4` applies when a request omits the role — not a
 * BytePlus-documented default; nothing here was read from BytePlus), else the
 * part's `type` token, which is read off the request rather than drawn from any
 * role vocabulary.
 */
export function buildBytePlusMatchText(content: readonly unknown[]): string {
  const texts: string[] = [];
  const media: string[] = [];
  for (const raw of content) {
    const part = raw !== null && typeof raw === "object" ? (raw as BytePlusContentPart) : undefined;
    if (part?.type === "text") {
      if (typeof part.text === "string" && part.text) texts.push(part.text);
      continue;
    }
    const url = part === undefined ? undefined : mediaUrlOf(part);
    if (part === undefined || url === undefined) {
      media.push(unresolvedPartToken(raw));
      continue;
    }
    const role =
      typeof part.role === "string" && part.role
        ? part.role
        : part.type === "image_url"
          ? "first_frame"
          : String(part.type);
    media.push(`${role}:${digest12(url)}`);
  }
  const suffix = `[media: ${media.join(", ")}]`;
  const text = texts.join("\n");
  return text ? `${text}\n${suffix}` : suffix;
}

// ─── Job progression ────────────────────────────────────────────────────────

/**
 * Advance a replay job one poll. `queued → running → terminal` on poll-count
 * thresholds; no-op once terminal, which is what makes the extra post-terminal
 * poll the client library makes (getVideoStatus then getVideoUrl both hit this
 * endpoint) byte-identical to the one before it.
 */
function advanceJob(job: BytePlusVideoReplayJob): void {
  if (job.phase === "terminal") return;
  job.pollCount += 1;
  if (job.phase === "queued" && job.pollCount >= job.pollsBeforeRunning) {
    job.phase = "running";
  }
  if (job.pollCount >= job.pollsBeforeTerminal) {
    job.phase = "terminal";
  }
}

// ─── Serialization ──────────────────────────────────────────────────────────

/**
 * Ark's error envelope SHAPE, carrying a message only — never an invented code.
 *
 * KNOWN, DELIBERATE, UNRESOLVED DIVERGENCE. The live canary in
 * `src/__tests__/drift/byteplus-video.drift.ts` asserts that real Ark supplies a
 * string `error.code`, so a consumer that reads `error.code` off an aimock-
 * authored error (404 unknown task, 404 no fixture, 400 validation, 502 bad
 * envelope, 503 strict) sees `undefined` where live Ark would give it a token.
 *
 * We omit it rather than close the gap because we do not know the value FOR
 * THESE CLASSES. The canary is keyless and does run — it observed Ark's
 * AUTH-layer error body live on 2026-09-10 (`code: "AuthenticationError"`,
 * `type: "Unauthorized"`, `param: ""`; see the `OBSERVED_*` constants in the
 * drift file). None of the five error classes above is an auth error, so that
 * observation does not supply their codes, and `@tanstack/ai-byteplus` is not
 * installed here, so nobody has verified what the client does with a missing
 * `code` either. Minting one would put an aimock-authored token into a consumer's
 * assertions and into any fixture recorded past it, which is the failure this
 * module exists to avoid; the governing rule is that the mock never authors a
 * wire value it did not observe, and an honest absence beats a plausible
 * invention. Recorded fixtures are unaffected: a real `error.code` captured
 * from upstream replays verbatim.
 *
 * Also omitted, for the same reason and on the same terms: `type` and `param`.
 * Both ARE observed on the auth envelope, and neither is known for the five
 * classes above.
 *
 * To close it: observe a real Ark 404/400/5xx for each class (a real key is
 * needed to reach them), then carry the OBSERVED code per error class. Do not
 * guess one.
 */
function arkErrorBody(message: string): string {
  return JSON.stringify({ error: { message } });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Build the poll body for a replay job.
 *
 * Non-terminal: `{ id, model?, status, created_at? }` — the status token is the
 * ONLY synthesized value, and `content`/`error`/`usage`/`updated_at` are
 * withheld. `created_at` is a property of the task and is true at every phase;
 * `updated_at` on a recorded envelope is the timestamp of the TERMINAL
 * transition, so emitting it mid-flight would assert a field COMBINATION this
 * design has never seen from Ark and cannot source from the client library
 * either (and a consumer diffing it across polls would see it constant).
 *
 * Terminal: the stored envelope VERBATIM with `id` rewritten. Its status is
 * whatever was recorded, including `cancelled` / `expired`.
 *
 * Returns `null` when the envelope cannot produce a poll body at all (not an
 * object, or no `status`) — an authoring error the caller answers with a 502.
 */
export function serializeBytePlusVideoTask(
  job: BytePlusVideoReplayJob,
  logger: HandlerDefaults["logger"],
): Record<string, unknown> | null {
  const envelope = job.envelope;
  const status = envelope.status;
  if (typeof status !== "string" || !status) return null;

  if (job.phase !== "terminal") {
    const body: Record<string, unknown> = { id: job.id, status: job.phase };
    if (envelope.model !== undefined) body.model = envelope.model;
    if (envelope.created_at !== undefined) body.created_at = envelope.created_at;
    return body;
  }

  // Terminal: recorded envelope verbatim, id stamped.
  const warned = warnLatchesFor(envelope);

  // The one authoring error UNIQUE to this surface. Every sibling video handler
  // SYNTHESIZES the terminal status, so a fixture cannot express "terminal but
  // not terminal"; storing the envelope verbatim makes it expressible for the
  // first time. The job has reached its terminal poll and will now serve this
  // same body forever, so the client polls to its own timeout with no
  // diagnostic: the status is one of the client library's six (unknownStatus stays
  // silent) and it is a non-empty string (the 502 authoring-error path stays
  // silent). Name it, the way every other authoring error here is named.
  if (!isBytePlusTerminalStatus(status) && !warned.nonTerminalEnvelope) {
    warned.nonTerminalEnvelope = true;
    logger.warn(
      `BytePlus video fixture for job ${job.id} has reached its terminal poll but its envelope ` +
        `carries the NON-TERMINAL status "${status}" — every later poll returns this same body, ` +
        `so the client will poll it forever and fail on its own timeout. Re-record the fixture, ` +
        `or author a terminal status (succeeded, failed, cancelled, expired)`,
    );
  }

  if (!BYTEPLUS_TASK_STATUSES.has(status) && !warned.unknownStatus) {
    warned.unknownStatus = true;
    logger.warn(
      `BytePlus video fixture for job ${job.id} carries status "${status}", which is not one of ` +
        `the six the BytePlus client library declares (queued, running, succeeded, failed, ` +
        `cancelled, expired) — serving it as authored, but that library's mapStatus() THROWS on ` +
        `a status it does not recognize`,
    );
  }

  const content = asRecord(envelope.content);
  const videoUrl = content?.video_url;
  if (status === "succeeded" && typeof videoUrl !== "string" && !warned.missingUrl) {
    warned.missingUrl = true;
    logger.warn(
      `BytePlus video fixture for job ${job.id} reports status "succeeded" but carries no ` +
        `content.video_url — the client will throw "Video is not ready for download. Check ` +
        `status first." Add content.video_url to the fixture envelope`,
    );
  }

  // Gated on the SAME two facts the missing-url warn above is gated on: the
  // 24h TTL is a property of a succeeded task's OUTPUT url, so without a
  // `succeeded` status AND a url actually present there is nothing that can
  // have expired. Ungated, this told the operator that a `failed` /
  // `cancelled` / `expired` envelope — which carries no `content` at all —
  // "has a content.video_url that expired", a wire fact that is not true.
  const updatedAt = envelope.updated_at;
  if (
    status === "succeeded" &&
    typeof videoUrl === "string" &&
    typeof updatedAt === "number" &&
    Number.isFinite(updatedAt) &&
    !warned.expiredUrl
  ) {
    const expiresAt = updatedAt + BYTEPLUS_URL_TTL_SECONDS;
    if (expiresAt * 1000 < Date.now()) {
      warned.expiredUrl = true;
      logger.warn(
        `BytePlus video fixture for job ${job.id} has a content.video_url that expired at ` +
          `${new Date(expiresAt * 1000).toISOString()} (Ark output urls live 24h from ` +
          `updated_at) — serving it anyway; re-record the fixture to get a live url`,
      );
    }
  }

  return { ...envelope, id: job.id };
}

// ─── Request validation ─────────────────────────────────────────────────────

interface BytePlusVideoRequest {
  model?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

/**
 * Structurally valid journal body for a field-validation 400. Mirrors
 * grok-video / openrouter-video: `model` stays a string and `messages` is an
 * empty array; underscore-prefixed keys are stripped so a request cannot spoof
 * handler-set discriminators.
 */
function validationJournalBody(videoReq: BytePlusVideoRequest): ChatCompletionRequest {
  const rawModel = videoReq.model;
  const model =
    typeof rawModel === "string"
      ? rawModel
      : rawModel === undefined
        ? ""
        : JSON.stringify(rawModel);
  const sanitized = Object.fromEntries(
    Object.entries(videoReq).filter(([key]) => !key.startsWith("_")),
  );
  return { ...sanitized, model, messages: [] };
}

// ─── POST /api/v3/contents/generations/tasks — submit ───────────────────────

export async function handleBytePlusVideoCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: BytePlusVideoJobMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? BYTEPLUS_VIDEO_TASKS_PATH;
  const method = req.method ?? "POST";

  const fail = (status: number, message: string, body: ChatCompletionRequest | null): void => {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body,
      response: { status, fixture: null },
    });
    writeErrorResponse(res, status, arkErrorBody(message));
  };

  let videoReq: BytePlusVideoRequest;
  try {
    videoReq = JSON.parse(raw) as BytePlusVideoRequest;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : "unknown";
    fail(400, `Malformed JSON: ${detail}`, null);
    return;
  }

  if (videoReq === null || typeof videoReq !== "object" || Array.isArray(videoReq)) {
    fail(400, "Request body must be a JSON object", null);
    return;
  }

  const parsedBody = validationJournalBody(videoReq);

  // `model` is REQUIRED, never defaulted: the client library always sends it
  // (whether Ark itself rejects a request without it is unverified here), and a
  // defaulted model id would be both a value aimock never observed and a silent
  // mis-key of the fixture match. Rejecting is the safe side of that gap.
  if (typeof videoReq.model !== "string" || !videoReq.model) {
    fail(
      400,
      videoReq.model === undefined
        ? "Missing required parameter: 'model'"
        : "Invalid type for parameter: 'model' must be a non-empty string",
      parsedBody,
    );
    return;
  }

  if (!Array.isArray(videoReq.content) || videoReq.content.length === 0) {
    fail(
      400,
      videoReq.content === undefined
        ? "Missing required parameter: 'content'"
        : "Invalid type for parameter: 'content' must be a non-empty array",
      parsedBody,
    );
    return;
  }

  const syntheticReq: ChatCompletionRequest = {
    model: videoReq.model,
    messages: [{ role: "user", content: buildBytePlusMatchText(videoReq.content) }],
    _endpointType: "video",
    _videoProvider: "byteplus",
    _context: getContext(req),
  };

  const testId = getTestId(req);
  const { fixture, skippedBySequenceOrTurn } = matchFixtureDiagnostic(
    fixtures,
    syntheticReq,
    journal.getFixtureMatchCountsForTest(testId),
    defaults.requestTransform,
  );

  if (fixture) {
    journal.incrementFixtureMatchCount(fixture, fixtures, testId);
    defaults.logger.debug(`Fixture matched: ${JSON.stringify(fixture.match).slice(0, 120)}`);
  }

  if (
    await applyChaosAsync(
      res,
      fixture,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: syntheticReq },
      fixture
        ? "fixture"
        : resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss
          ? "internal"
          : defaults.record?.providers.byteplus
            ? "proxy"
            : "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  if (!fixture) {
    const fixtureMiss = resolveRequestDecisions(defaults.strict, req.headers).fixtureMiss;
    if (fixtureMiss) {
      const strictMessage = strictNoMatchMessage(skippedBySequenceOrTurn);
      defaults.logger.error(strictNoMatchLogLine(method, path, skippedBySequenceOrTurn));
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        body: syntheticReq,
        response: {
          status: 503,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
      });
      writeErrorResponse(res, 503, arkErrorBody(strictMessage));
      return;
    }

    if (defaults.record) {
      const outcome = await proxyBytePlusVideoSubmit({
        req,
        res,
        raw,
        syntheticReq,
        record: defaults.record,
        journal,
        defaults,
        jobs,
        method,
        path,
      });
      if (outcome === "handled") return;
      // "no_upstream" — fall through to 404 (fal convention).
    }

    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: 404,
        fixture: null,
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    // Name the endpoint requirement: router.ts skips a `{ json }` fixture that
    // omits `match.endpoint`, so the commonest authoring mistake on this
    // surface presents as a bare no-match with nothing pointing at the cause.
    writeErrorResponse(
      res,
      404,
      arkErrorBody(
        'No byteplus fixture matched. A byteplus video fixture must carry match.endpoint: "video" ' +
          "and a { json: <Ark task envelope> } response",
      ),
    );
    return;
  }

  const worldGeneration = jobs.generation;
  const response = await resolveResponse(fixture, syntheticReq);

  if (isErrorResponse(response)) {
    if (res.destroyed || res.writableEnded) return;
    const status = response.status ?? 500;
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status, fixture },
    });
    writeErrorResponse(res, status, serializeErrorResponse(response), {
      retryAfter: response.retryAfter,
    });
    return;
  }

  if (!isJSONResponse(response)) {
    // A VideoResponse-shaped fixture is the other likely mistake: it is what
    // every OTHER video provider in this repo takes. Say so rather than
    // half-building a body out of it.
    if (res.destroyed || res.writableEnded) return;
    defaults.logger.warn(
      "BytePlus video fixture matched but its response is not a { json: … } payload — this " +
        "surface stores the Ark task envelope verbatim, NOT a VideoResponse. Treating it as a " +
        "no-match",
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 404, fixture: null },
    });
    writeErrorResponse(
      res,
      404,
      arkErrorBody(
        "Matched byteplus fixture has a non-JSON response; expected { json: <Ark task envelope> }",
      ),
    );
    return;
  }

  const envelope = asRecord(response.json);
  if (!envelope) {
    if (res.destroyed || res.writableEnded) return;
    defaults.logger.warn(
      "BytePlus video fixture's json payload is not a JSON object — expected an Ark task envelope",
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: { status: 404, fixture: null },
    });
    writeErrorResponse(res, 404, arkErrorBody("Matched byteplus fixture's json is not an object"));
    return;
  }

  if (res.destroyed || res.writableEnded) return;
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: { status: 200, fixture },
  });

  // The `cgt-` prefix is deliberate: it is the task-id prefix documented in
  // `@tanstack/ai-byteplus@0.3.4` (`src/video/wire-types.ts`, from that author's
  // own live calls — a SECONDARY source; this repo has not observed a real Ark
  // task id), so a consumer that pattern-matches the id cannot tell replay from
  // live.
  const id = `cgt-${crypto.randomUUID()}`;
  const progression = resolveProgression(defaults.bytePlusVideo);
  const job: BytePlusVideoReplayJob = {
    kind: "replay",
    id,
    phase: "queued",
    pollCount: 0,
    pollsBeforeRunning: progression.pollsBeforeInProgress,
    pollsBeforeTerminal: progression.pollsBeforeCompleted,
    envelope,
  };
  if (progression.pollsBeforeCompleted === 0) job.phase = "terminal";

  if (jobs.generation === worldGeneration) {
    jobs.set(`${testId}:${id}`, job);
  } else {
    defaults.logger.warn(
      `BytePlus video submit resolved after a fixtures reset — not inserting job ${id} into the ` +
        `new world (its polls will 404)`,
    );
  }

  // NO testIdSuffix: the client encodeURIComponent()s the job id into the poll
  // path, so a `?testId=` suffix would be percent-encoded into the path segment
  // instead of surviving as a query string. A non-default testId must ride the
  // `x-test-id` header, which the adapter forwards via defaultHeaders.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id }));
}

// ─── GET /api/v3/contents/generations/tasks/{id} — status poll ──────────────

export async function handleBytePlusVideoStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  fixtures: Fixture[],
  journal: Journal,
  defaults: HandlerDefaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
  jobs: BytePlusVideoJobMap,
): Promise<void> {
  setCorsHeaders(res);
  const path = req.url ?? `${BYTEPLUS_VIDEO_TASKS_PATH}/${id}`;
  const method = req.method ?? "GET";
  const testId = getTestId(req);
  const key = `${testId}:${id}`;

  if (
    await applyChaosAsync(
      res,
      null,
      defaults.chaos,
      req.headers,
      req.url,
      journal,
      { method, path, headers: flattenHeaders(req.headers), body: null },
      "internal",
      defaults.registry,
      defaults.logger,
    )
  )
    return;

  const job = jobs.get(key);
  if (!job) {
    // Ark's error envelope SHAPE, with NO `code`. What Ark actually returns for
    // an aged-out task is UNVERIFIED: the client library reads a dotted
    // `error.code` off an open-ended vocabulary and splices it into the
    // consumer-visible error string, and the drift canary asserts a string
    // `code`. That canary does run, but what it observed live is Ark's AUTH
    // envelope, not a 404 for an unknown task — so this class's code remains
    // unobserved. Minting a code to fill the gap would put an aimock-authored
    // token into a consumer's assertion; see `arkErrorBody`.
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 404, fixture: null },
    });
    writeErrorResponse(
      res,
      404,
      arkErrorBody(
        `Unknown video task id "${id}" — no such job for this test scope. It was never created, ` +
          `it belongs to a different x-test-id, or it aged out of aimock's 1h job TTL`,
      ),
    );
    return;
  }

  if (job.kind === "record") {
    if (!resolveRequestDecisions(defaults.strict, req.headers).upstream) {
      defaults.logger.error(
        `STRICT: video task ${id} is proxied live upstream (record mode) — refusing the upstream poll`,
      );
      journal.add({
        method,
        path,
        headers: flattenHeaders(req.headers),
        body: null,
        response: {
          status: 503,
          fixture: null,
          ...strictOverrideField(defaults.strict, req.headers),
        },
      });
      writeErrorResponse(
        res,
        503,
        arkErrorBody(
          `Strict mode: video task ${id} is proxied live upstream (record mode) — nothing reaches ` +
            `an upstream under strict mode`,
        ),
      );
      return;
    }
    await proxyBytePlusVideoRecordPoll({
      req,
      res,
      job,
      key,
      testId,
      fixtures,
      journal,
      defaults,
      jobs,
      method,
      path,
    });
    return;
  }

  if (res.destroyed || res.writableEnded) return;
  advanceJob(job);
  jobs.set(key, job);

  const body = serializeBytePlusVideoTask(job, defaults.logger);
  if (!body) {
    defaults.logger.warn(
      `BytePlus video fixture for job ${id} has an envelope that is not a usable Ark task body ` +
        `(missing or non-string "status") — a fixture that cannot produce a poll body is an ` +
        `authoring error`,
    );
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: { status: 502, fixture: null },
    });
    writeErrorResponse(
      res,
      502,
      arkErrorBody(
        `Fixture envelope for video task ${id} carries no "status" — expected an Ark task envelope`,
      ),
    );
    return;
  }

  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: null,
    response: { status: 200, fixture: null },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── Record mode: live interactive proxy (submit) ───────────────────────────

/**
 * Proxy an unmatched submit to the configured upstream and answer the client
 * with a mock-rewritten `{ id }`. The upstream lifecycle is then driven
 * interactively by the client's own polls. Returns "no_upstream" when record
 * mode has no byteplus provider URL — the caller falls through to 404.
 */
async function proxyBytePlusVideoSubmit(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  raw: string;
  syntheticReq: ChatCompletionRequest;
  record: RecordConfig;
  journal: Journal;
  defaults: HandlerDefaults;
  jobs: BytePlusVideoJobMap;
  method: string;
  path: string;
}): Promise<"handled" | "no_upstream"> {
  const { req, res, raw, syntheticReq, record, journal, defaults, jobs, method, path } = args;

  const upstreamBase = record.providers.byteplus;
  if (!upstreamBase) {
    defaults.logger.warn(`No upstream URL configured for provider "byteplus" — cannot proxy`);
    return "no_upstream";
  }

  const proxyError = (msg: string): "handled" => {
    defaults.logger.error(`BytePlus video submit proxy failed: ${msg}`);
    if (res.destroyed || res.writableEnded) return "handled";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: 502,
        fixture: null,
        source: "proxy",
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    writeErrorResponse(res, 502, arkErrorBody(`Proxy to upstream failed: ${msg}`));
    return "handled";
  };

  // The configured base is an ORIGIN; this handler owns the whole path,
  // including the /api/v3 prefix.
  let submitUrl: URL;
  try {
    submitUrl = resolveUpstreamUrl(upstreamBase, BYTEPLUS_VIDEO_TASKS_PATH);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return proxyError(`Invalid upstream URL: ${upstreamBase} (${msg})`);
  }

  defaults.logger.warn(`NO FIXTURE MATCH — proxying video submit to ${submitUrl.toString()}`);

  const worldGeneration = jobs.generation;

  let fetched: { status: number; contentType: string | null; text: string };
  try {
    const headers = prepareEgressHeaders(req, submitUrl, "byteplus", record.providerKeys?.byteplus);
    if (!headers) return proxyError("No configured provider credential");
    const upstreamRes = await fetch(submitUrl, {
      method: "POST",
      headers,
      // Raw body, verbatim: Ark rejects an inapplicable option outright rather
      // than ignoring it, so every model-specific field must arrive untouched.
      body: raw,
      signal: upstreamTimeoutSignal(record),
    });
    fetched = {
      status: upstreamRes.status,
      contentType: upstreamRes.headers.get("content-type"),
      text: await readEnvelopeText(upstreamRes, record),
    };
  } catch (err) {
    return proxyError(err instanceof Error ? err.message : "Unknown proxy error");
  }

  if (fetched.status === 401 || fetched.status === 403) {
    defaults.logger.warn(
      `Upstream rejected the video submit (${fetched.status}) — relaying the upstream status`,
    );
    if (res.destroyed || res.writableEnded) return "handled";
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: syntheticReq,
      response: {
        status: fetched.status,
        fixture: null,
        source: "proxy",
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
    res.writeHead(fetched.status, { "Content-Type": fetched.contentType ?? "application/json" });
    res.end(fetched.text);
    return "handled";
  }

  if (fetched.status < 200 || fetched.status >= 300) {
    return proxyError(`Submit ${fetched.status}: ${fetched.text.slice(0, 200)}`);
  }

  let upstreamTaskId: string;
  {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fetched.text);
    } catch {
      return proxyError(`Submit returned non-JSON: ${fetched.text.slice(0, 200)}`);
    }
    const envelope = asRecord(parsed);
    if (!envelope) return proxyError("Submit response is not a JSON object");
    upstreamTaskId = String(envelope.id ?? "").trim();
    if (!upstreamTaskId) return proxyError("Submit response missing id");
  }

  const upstreamPollingUrl = resolveUpstreamUrl(
    upstreamBase,
    `${BYTEPLUS_VIDEO_TASKS_PATH}/${encodeURIComponent(upstreamTaskId)}`,
  ).toString();

  const testId = getTestId(req);
  const matchRequest = defaults.requestTransform
    ? defaults.requestTransform(syntheticReq)
    : syntheticReq;
  const id = `cgt-${crypto.randomUUID()}`;
  const job: BytePlusVideoRecordJob = {
    kind: "record",
    id,
    upstreamTaskId,
    upstreamPollingUrl,
    match: buildFixtureMatch(matchRequest, record),
  };
  if (jobs.generation === worldGeneration) {
    jobs.set(`${testId}:${id}`, job);
  } else {
    defaults.logger.warn(
      `BytePlus video submit for upstream task ${upstreamTaskId} completed after a fixtures ` +
        `reset — not inserting the job into the new world (its polls will 404)`,
    );
  }

  if (res.destroyed || res.writableEnded) return "handled";
  journal.add({
    method,
    path,
    headers: flattenHeaders(req.headers),
    body: syntheticReq,
    response: {
      status: 200,
      fixture: null,
      source: "proxy",
      ...strictOverrideField(defaults.strict, req.headers),
    },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id }));
  return "handled";
}

// ─── Record mode: live interactive proxy (status poll + eager capture) ──────

/**
 * Proxy a status poll 1:1 and relay the result with the mock id substituted.
 *
 * An upstream 4xx is RELAYED VERBATIM rather than converted to 502 — a 404 in
 * particular, because the client has a deliberate 404 branch that keeps Ark's
 * own code/message on purpose, and converting it would make record mode behave
 * differently from live Ark for exactly the case that branch exists to serve.
 * 5xx and transport failures become 502.
 *
 * On ANY terminal status the rewritten body is relayed immediately and the
 * envelope is captured. All four terminal states are captured identically:
 * there is no warn-and-drop branch, so a task cancelled from the Ark console
 * mid-record yields an artifact rather than a warning and an empty directory.
 */
async function proxyBytePlusVideoRecordPoll(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  job: BytePlusVideoRecordJob;
  key: string;
  testId: string;
  fixtures: Fixture[];
  journal: Journal;
  defaults: HandlerDefaults;
  jobs: BytePlusVideoJobMap;
  method: string;
  path: string;
}): Promise<void> {
  const { req, res, job, key, testId, fixtures, journal, defaults, jobs, method, path } = args;
  const logger = defaults.logger;

  const journalProxy = (status: number): void => {
    journal.add({
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      response: {
        status,
        fixture: null,
        source: "proxy",
        ...strictOverrideField(defaults.strict, req.headers),
      },
    });
  };

  const proxyError = (msg: string): void => {
    logger.error(`BytePlus video poll proxy failed: ${msg}`);
    if (res.destroyed || res.writableEnded) return;
    journalProxy(502);
    writeErrorResponse(res, 502, arkErrorBody(`Proxy to upstream failed: ${msg}`));
  };

  const record = defaults.record;
  if (!record) {
    proxyError("record mode is no longer configured for an in-flight record job");
    return;
  }

  let fetched: { status: number; contentType: string | null; text: string };
  try {
    const target = new URL(job.upstreamPollingUrl);
    const headers = prepareEgressHeaders(req, target, "byteplus", record.providerKeys?.byteplus);
    if (!headers) {
      proxyError("No configured provider credential");
      return;
    }
    const upstreamRes = await fetch(job.upstreamPollingUrl, {
      headers,
      signal: upstreamTimeoutSignal(record),
    });
    fetched = {
      status: upstreamRes.status,
      contentType: upstreamRes.headers.get("content-type"),
      text: await readEnvelopeText(upstreamRes, record),
    };
  } catch (err) {
    proxyError(err instanceof Error ? err.message : "Unknown proxy error");
    return;
  }

  // Relay EVERY 4xx verbatim (see the doc-comment): the client's 404 branch is
  // deliberate, and a 401/403 is a credential fact the operator must see.
  if (fetched.status >= 400 && fetched.status < 500) {
    logger.warn(
      `Upstream returned ${fetched.status} for video task ${job.upstreamTaskId} — relaying it verbatim`,
    );
    if (res.destroyed || res.writableEnded) return;
    journalProxy(fetched.status);
    res.writeHead(fetched.status, { "Content-Type": fetched.contentType ?? "application/json" });
    res.end(fetched.text);
    return;
  }

  if (fetched.status < 200 || fetched.status >= 300) {
    proxyError(`Status ${fetched.status}: ${fetched.text.slice(0, 200)}`);
    return;
  }

  let upstreamBody: Record<string, unknown>;
  {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fetched.text);
    } catch {
      proxyError(`Status returned non-JSON: ${fetched.text.slice(0, 200)}`);
      return;
    }
    const envelope = asRecord(parsed);
    if (!envelope) {
      proxyError("Status response is not a JSON object");
      return;
    }
    upstreamBody = envelope;
  }

  // The mock id is the ONLY rewrite; every other field passes through verbatim,
  // which is what makes this path robust to vendor additions.
  const relayBody: Record<string, unknown> = { ...upstreamBody, id: job.id };

  const relayJson = (body: Record<string, unknown>): void => {
    if (res.destroyed || res.writableEnded) return;
    journalProxy(200);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Terminal is derived from the NON-terminal pair, not from a second copy of
  // the four terminal tokens: a vendor-added end state is captured rather than
  // proxied until the client gives up.
  //
  // The status must FIRST clear what replay demands of it — a non-empty string,
  // the exact predicate `serializeBytePlusVideoTask` applies. Coercing instead
  // (`String(status ?? "")`) turned an absent status into `""` and a numeric
  // `123` into `"123"`, and since terminal is the COMPLEMENT of the non-terminal
  // pair, both read as terminal. Capture then wrote an envelope replay cannot
  // serve and swapped the job to replay, so every later poll 502s on that same
  // envelope and a corrected upstream response is never fetched for the job —
  // and the unusable fixture is on disk. Treating it as NOT terminal relays it
  // verbatim and leaves the job upstream-backed, which is also what lets a
  // later well-formed response record normally.
  //
  // Scope: this is malformed-upstream robustness only. Ark is not known to emit
  // such a body, and non-2xx / non-JSON / non-object bodies are rejected above.
  const rawStatus = upstreamBody.status;
  const upstreamStatus = typeof rawStatus === "string" ? rawStatus : "";

  if (!upstreamStatus || !isBytePlusTerminalStatus(upstreamStatus)) {
    if (jobs.get(key) === job) jobs.set(key, job); // TTL refresh
    relayJson(relayBody);
    return;
  }

  if (record.proxyOnly) {
    if (jobs.get(key) === job) jobs.set(key, job); // TTL refresh
    relayJson(relayBody);
    return;
  }

  // THE capture gate, and the only one — map identity, checked once, here.
  //
  // It does two jobs at once. (a) It serializes two concurrent terminal polls:
  // both awaited upstream, and whichever resumes second finds that the first
  // already swapped the replay job into the map, so it relays without
  // capturing again. (b) It is the world-generation guard: a fixtures reset
  // clears the job map, so a job the map no longer holds belongs to a world
  // that is gone, and persisting would push a stale fixture into the NEXT
  // world's array. Either way the right answer is the same — relay what
  // upstream said, persist nothing, say nothing.
  //
  // There is NO await between here and the persist below, which is why one
  // check suffices. Two things previously sat on this path and could not fire:
  // a `job.capturing` flag (set and cleared inside a single tick, so never
  // observable by another poll) and a second copy of this identity check
  // inside the capture body, whose warning named a fixtures reset that this
  // check had already ruled out one statement earlier. Both are gone. If the
  // capture is ever made asynchronous, re-check identity immediately before
  // `persistFixture` — that is the point where it would start to matter.
  if (jobs.get(key) !== job) {
    relayJson(relayBody);
    return;
  }

  // Capture BEFORE relaying, so a persist failure can still ride an
  // X-AIMock-Record-Error header on this response — grok-video.ts:1105's
  // ordering. Nothing here downloads bytes: the capture is a synchronous
  // persist plus a map swap, so relaying after it costs the client one
  // filesystem write, and openrouter-video.ts:2521's "the relay left before the
  // capture started" constraint (which forced it to drop the header) does not
  // apply.
  captureBytePlusVideoRecordFixture({
    job,
    key,
    testId,
    fixtures,
    defaults,
    jobs,
    record,
    upstreamBody,
    res,
  });

  relayJson(relayBody);
}

/**
 * Capture a terminal record job into a fixture (PERSIST only — NO byte
 * download) and mutate the map entry into a terminal replay job.
 *
 * Runs BEFORE the caller relays, and is fully synchronous, so a persist failure
 * still reaches the client as an `X-AIMock-Record-Error` header rather than
 * only as a log line behind a 200 the client cannot distinguish from a clean
 * record.
 *
 * The upstream `id` is REMOVED at capture: replay stamps its own, and keeping a
 * real Ark task id in a committed artifact leaks it for no benefit.
 */
function captureBytePlusVideoRecordFixture(args: {
  job: BytePlusVideoRecordJob;
  key: string;
  testId: string;
  fixtures: Fixture[];
  defaults: HandlerDefaults;
  jobs: BytePlusVideoJobMap;
  record: RecordConfig;
  upstreamBody: Record<string, unknown>;
  res: http.ServerResponse;
}): void {
  const { job, key, testId, fixtures, defaults, jobs, record, upstreamBody, res } = args;
  const logger = defaults.logger;

  try {
    const { id: _discardedUpstreamId, ...envelope } = upstreamBody;
    void _discardedUpstreamId;

    const persistResult = persistFixture({
      record,
      providerKey: "byteplus",
      testId,
      fixture: { match: job.match, response: { json: envelope } },
      fixtures,
      logger,
    });
    if (persistResult.kind === "failed" && !res.headersSent) {
      res.setHeader("X-AIMock-Record-Error", sanitizeHeaderValue(persistResult.error));
    }

    jobs.set(key, {
      kind: "replay",
      id: job.id,
      phase: "terminal",
      pollCount: 0,
      pollsBeforeRunning: 0,
      pollsBeforeTerminal: 0,
      envelope,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `BytePlus video capture for task ${job.upstreamTaskId} failed unexpectedly (${msg}) — ` +
        `fixture not persisted; the job keeps proxying live`,
    );
  }
}
