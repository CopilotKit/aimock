/**
 * OpenAI Fine-tuning jobs mock.
 *
 * Implements `POST /v1/fine_tuning/jobs`, `GET /v1/fine_tuning/jobs`,
 * `GET /v1/fine_tuning/jobs/{id}`, `POST .../cancel` and
 * `GET .../events` with a deterministic progression:
 *
 *   validating_files → queued → running → succeeded
 *
 * Retrieve advances the job (first → queued, second → running,
 * third+ → succeeded with a fine-tuned model name). Cancel moves a
 * non-terminal job to `cancelled` and stamps `finished_at`; cancelling a job
 * that is already terminal (`succeeded`, `cancelled` or `failed`) is a 400.
 * Events are an append-only log: every status transition the job actually
 * went through appends exactly one event, so what a polling UI reads back is
 * the job's real history.
 *
 * In-memory per process, cleared by the full reset path, journaled as
 * `service: "fine-tuning"` and chaos-gated like the other job surfaces.
 *
 * Wire shapes verified 2026-09-15 against two sources, which agreed on every
 * required set below:
 *   - openai/openai-openapi `openapi.yaml` v2.3.0 (`master`), schemas
 *     `FineTuningJob`, `FineTuningJobEvent`, `ListPaginatedFineTuningJobsResponse`,
 *     `ListFineTuningJobEventsResponse` and `CreateFineTuningJobRequest`.
 *   - Vendored `openai` SDK 4.104.0: `resources/fine-tuning/jobs/jobs.d.ts`
 *     (`FineTuningJob`, `FineTuningJob.Error`, `FineTuningJob.Hyperparameters`,
 *     `FineTuningJobEvent`) and `pagination.d.ts` `CursorPageResponse`.
 *
 * What each source requires:
 *   - `FineTuningJob` requires all fifteen of `id`, `created_at`, `error`,
 *     `fine_tuned_model`, `finished_at`, `hyperparameters`, `model`, `object`,
 *     `organization_id`, `result_files`, `seed`, `status`, `trained_tokens`,
 *     `training_file`, `validation_file`. Five of them are nullable -
 *     `error`, `fine_tuned_model`, `finished_at`, `trained_tokens` and
 *     `validation_file` - and are emitted as `null` until the lifecycle fills
 *     them in (`result_files` is required and non-nullable, so it starts as an
 *     empty array rather than `null`). `integrations` and `method` are optional
 *     in both sources and `metadata` is optional in the spec alone - SDK
 *     4.104.0's `FineTuningJob` and `JobCreateParams` do not declare it at all
 *     (`grep -c metadata resources/fine-tuning/jobs/jobs.d.ts` is 0) - and all
 *     three are emitted exactly when the create body carried them;
 *     `estimated_finish` is optional and is never emitted.
 *   - `FineTuningJobEvent` requires `id`, `object`, `created_at`, `level`,
 *     `message`; `type` and `data` are optional (we always send `type`).
 *   - Both list responses require `object`, `data`, `has_more`.
 *   - `CreateFineTuningJobRequest` declares nine properties - `model`,
 *     `training_file`, `hyperparameters`, `suffix`, `validation_file`,
 *     `integrations`, `seed`, `method` and `metadata` - and every one of them
 *     is read. That count is the spec's: SDK 4.104.0's `JobCreateParams`
 *     declares the same set minus `metadata`. It types `validation_file` as a nullable string and each
 *     `hyperparameters` member as `"auto"` or a number, with declared ranges we
 *     enforce: `n_epochs` an integer 1-50, `batch_size` an integer 1-256,
 *     `learning_rate_multiplier` a number strictly greater than 0
 *     (`minimum: 0` plus `exclusiveMinimum: true`). `hyperparameters` itself is
 *     `type: object` and is NOT marked `nullable`, so `null` is a 400 here.
 *     `suffix` is a 1-64 character string that the spec's own example shows
 *     landing in the fine-tuned model name
 *     (`ft:gpt-4o-mini:openai:custom-model-name:7p4lURel`), which is where this
 *     mock puts it too; `seed` is an integer 0-2147483647; `metadata` is at
 *     most 16 string pairs with 64-character keys and 512-character values;
 *     and the per-method hyperparameter ranges come from
 *     `FineTuneSupervisedHyperparameters`, `FineTuneDPOHyperparameters` (which
 *     is where `beta`, 0 < beta <= 2, lives) and
 *     `FineTuneReinforcementHyperparameters`.
 *
 * Not observed firsthand against api.openai.com. These details are ours, not
 * the vendor's: an event's id is `ftevent-` plus the job id's suffix (the job
 * id with its own `ftjob-` prefix stripped) plus the event's position in the
 * append-only log, which never renumbers, so an id always denotes the same
 * event across later reads and later transitions; every event is
 * `level: "info"` because this mock never emits a failure path; the 400 on
 * cancelling an already-terminal job is this mock's own contract - the spec
 * documents only a 200/`FineTuningJob` response for `cancelFineTuningJob` and
 * says nothing about repeat cancels; a `seed` the request did not carry is
 * derived from the job id (the spec says only "if a seed is not specified, one
 * will be generated for you"); `organization_id` is the fixed mock value
 * `org-aimock`; and the `result_files` entry and `trained_tokens` count
 * produced on success are deterministic stand-ins - `trained_tokens` may be 0,
 * which the spec permits (it declares `type: integer` with no `minimum`) even
 * on a succeeded job. Rejecting `validation_file: ""` is also ours; the spec
 * sets no `minLength` on either file id, but `training_file: ""` is already a
 * 400 and the two should not disagree. Four more rejections are ours, all of
 * the same shape - the spec marks none of these objects
 * `additionalProperties: false`, and this mock refuses to answer 200 having
 * ignored what the caller wrote: an unrecognized top-level create parameter, an
 * unrecognized member of `hyperparameters` or of a `method` variant (`beta`
 * belongs under `method.dpo.hyperparameters`, not in the deprecated top-level
 * object), an `integrations` list longer than the five `FineTuningJob` declares,
 * and a `limit` or `after` given more than once on a list route (the spec types
 * each as one scalar and gives no combining rule, so taking the first would
 * launder the others). Stamping `finished_at` on
 * cancel is an inference, not a vendor statement: neither source says what a
 * cancel does to the field. Both describe `finished_at` as "null if the
 * fine-tuning job is still running", and a cancelled job has stopped running,
 * so leaving it null would contradict that description - but the spec
 * documents only a 200/`FineTuningJob` for `cancelFineTuningJob` and never
 * shows the stamped body.
 */

import type * as http from "node:http";
import { flattenHeaders, generateId, isJsonObject, parseStrictIntegerText } from "./helpers.js";
import { applyChaosAsync, type ChaosAsyncOutcome } from "./chaos.js";
import type { ChaosDefaults, JournalBody } from "./types.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

export interface FineTuningJobEvent {
  id: string;
  object: "fine_tuning.job.event";
  created_at: number;
  level: "info" | "warn" | "error";
  message: string;
  type: "message";
}

export type FineTuningJobStatus =
  | "validating_files"
  | "queued"
  | "running"
  | "succeeded"
  | "cancelled"
  | "failed";

/**
 * The statuses a job never leaves. Single source of truth: both `advance()`
 * (which refuses to move a terminal job) and the cancel handler (which rejects
 * a terminal job) read this set, so the two cannot drift apart again.
 */
const TERMINAL_STATUSES = new Set<FineTuningJobStatus>(["succeeded", "cancelled", "failed"]);

function isTerminal(status: FineTuningJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface FineTuningJobError {
  code: string;
  message: string;
  param: string | null;
}

/** Each member is `"auto"` or a number, per `CreateFineTuningJobRequest`. */
export interface FineTuningJobHyperparameters {
  n_epochs?: number | "auto";
  batch_size?: number | "auto";
  learning_rate_multiplier?: number | "auto";
}

/**
 * One `integrations` entry, per `FineTuningIntegration`: `wandb` is the only
 * type the spec declares, and `project` is the only member it requires.
 */
export interface FineTuningJobIntegration {
  type: "wandb";
  wandb: { project: string; name?: string | null; entity?: string | null; tags?: string[] };
}

/**
 * One `method` variant's configuration. `grader` is required by
 * `FineTuneReinforcementMethod` and only meaningful there; its own schema tree
 * is not modelled, so it is carried through as the JSON object the caller sent.
 */
export interface FineTuningJobMethodConfig {
  hyperparameters?: Record<string, number | string>;
  grader?: Record<string, unknown>;
}

/** `FineTuneMethod`: a required `type` plus that type's optional configuration. */
export interface FineTuningJobMethod {
  type: "supervised" | "dpo" | "reinforcement";
  supervised?: FineTuningJobMethodConfig;
  dpo?: FineTuningJobMethodConfig;
  reinforcement?: FineTuningJobMethodConfig;
}

/**
 * Every field the vendor marks required is non-optional here, nullable ones
 * included; the three the vendor marks optional are present only on a job
 * whose create body carried them.
 */
export interface FineTuningJob {
  id: string;
  object: "fine_tuning.job";
  model: string;
  training_file: string;
  validation_file: string | null;
  status: FineTuningJobStatus;
  created_at: number;
  finished_at: number | null;
  fine_tuned_model: string | null;
  hyperparameters: FineTuningJobHyperparameters;
  error: FineTuningJobError | null;
  organization_id: string;
  result_files: string[];
  seed: number;
  trained_tokens: number | null;
  integrations?: FineTuningJobIntegration[];
  method?: FineTuningJobMethod;
  metadata?: Record<string, string>;
}

/** Stable stand-in for the owning org; the vendor requires the field, not a value. */
const ORGANIZATION_ID = "org-aimock";

const jobs = new Map<string, FineTuningJob>();
const polls = new Map<string, number>();
/**
 * The append-only event log per job id, kept beside the job rather than on it
 * so it never leaks into the `fine_tuning.job` payload. `appendEvent` is the
 * only writer of entries, and only by pushing, so an event's index — and
 * therefore its id — is fixed the moment it is recorded. The one other writer
 * is `clearFineTuningStore`, which empties the whole map: a reset drops every
 * log wholesale and never renumbers a surviving one.
 */
const eventLogs = new Map<string, FineTuningJobEvent[]>();
/**
 * The last second this module stamped, which is what `stamp()` reads and
 * writes. Module-wide rather than per job: a per-job clamp says nothing about
 * two different jobs, and ordering ACROSS jobs is what the list endpoint's
 * newest-first page rests on.
 */
let lastStamp = 0;

/**
 * The one clock the whole surface stamps from.
 *
 * The invariant: every timestamp this module ever exposes - every job's
 * `created_at`, every event's `created_at`, and every `finished_at` - is
 * non-decreasing in the order the module produced it, whichever way the wall
 * clock moves between two stamps, and across all jobs rather than within one.
 * The per-job reading is a consequence: a job's own stamps are a subsequence
 * of the module's, so they are non-decreasing too.
 *
 * Wall clock is the source, so a forward-running clock shows through
 * unchanged; a backwards step (NTP correction, a resumed VM, a test driving
 * `Date.now`) is absorbed by holding the previous value rather than emitting a
 * history that reads out of order. That makes this the only place a
 * fine-tuning timestamp may come from - a second clamp somewhere downstream is
 * exactly what used to be able to undo this one.
 */
function stamp(): number {
  lastStamp = Math.max(Math.floor(Date.now() / 1000), lastStamp);
  return lastStamp;
}

/**
 * The `suffix` the create body asked for, per job id. Kept beside the job
 * because `suffix` is a member of `CreateFineTuningJobRequest` and NOT of
 * `fine_tuning.job`: storing it on the job would put a field on the wire that
 * the vendor never sends. It is read once, when the job succeeds and takes its
 * `fine_tuned_model` name.
 */
const suffixes = new Map<string, string>();

export function clearFineTuningStore(): void {
  jobs.clear();
  polls.clear();
  eventLogs.clear();
  lastStamp = 0;
  suffixes.clear();
}

type Defaults = { logger: Logger; chaos?: ChaosDefaults; registry?: MetricsRegistry };

/**
 * Journal one fine-tuning request.
 *
 * `body` is the request body the handler actually parsed (create), and is null
 * in three cases: the bodyless GET/cancel routes, a create whose body never
 * parsed into a JSON object, and any request the chaos gate faulted — `chaosHit`
 * journals through `applyChaosAsync` with `body: null` because it rolls before
 * the body is read at all. Recording it otherwise is what makes "inspect the
 * request you sent" work against this surface: every create that got as far as
 * a parsed JSON object carries it, every rejection included, because those are
 * exactly the 400s whose offending payload a caller needs to read back.
 *
 * `path` is the raw request URL, query string INCLUDED. That is not cosmetic:
 * `entry.path` is the only place an untagged-by-header `?testId=` survives into
 * the journal, and `journalEntryTestId` (server.ts) parses it back out of
 * `entry.path` to serve `GET /__aimock/journal?testId=…`. Stripping the query
 * here — as `fal.ts` does with its `pathname` — silently drops every
 * query-tagged fine-tuning request out of its own test's slice. It also matches
 * the repo majority (images, responses, messages, moderation, embeddings,
 * rerank, cohere, gemini, search and vector all journal `req.url`). A caller
 * that wants route-level grouping should match on `service` or on a prefix,
 * not on string equality against a bare path.
 *
 * One route reaches a response without reaching this function: a
 * `POST /v1/fine_tuning/jobs` whose body read throws (over the size cap, or a
 * socket error) is caught in `server.ts` and answered 500 before
 * `handleFineTuningCreate` runs, so it is never journaled. That is deliberate
 * consistency, not an oversight — every sibling route's body-read catch in
 * `server.ts` (responses, messages, cohere, moderation, embeddings, rerank,
 * the video surfaces) writes the same unjournaled 500. Journaling it here alone
 * would make fine-tuning the one surface whose journal disagrees with the rest.
 *
 * `source: "internal"` marks the entry as served by aimock's own synthetic job
 * logic rather than a fixture or a proxy, which is the same value this file's
 * own chaos gate passes for a faulted request. It is a rare value elsewhere:
 * `grep -rn 'source: "internal"' src/*.ts` finds it on exactly two other
 * writers, `images.ts`'s removed-endpoint 404 and `openrouter-video.ts`'s
 * models listing synthesized after a failed proxy attempt — every other
 * service's synthesized journal writes `source: "proxy"`. Fine-tuning is the
 * one surface where every entry carries it, success and error alike, because
 * no fixture or proxy ever serves this store.
 */
function journalFt(
  journal: Journal,
  method: string,
  path: string,
  headers: Record<string, string>,
  status: number,
  body: JournalBody | null = null,
): void {
  journal.add({
    method,
    path,
    headers,
    body,
    service: "fine-tuning",
    response: { status, fixture: null, source: "internal" },
  });
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function invalid(message: string): { error: { message: string; type: string } } {
  return { error: { message, type: "invalid_request_error" } };
}

/**
 * Roll the chaos dice for one fine-tuning request. Returns true when a fault
 * fired and the response is already written, so the caller returns early.
 *
 * CORS headers go on BEFORE the roll, because a fault writes the response
 * itself and never reaches `writeJson` (the only other place this file sets
 * them). Without this a browser client under chaos reads an opaque CORS
 * failure instead of the 429/500/malformed body the chaos config asked for —
 * exactly the fault it is trying to exercise, hidden. `setCorsHeaders` uses
 * `res.setHeader`, so the later `writeHead` on the non-fault path merges with
 * it rather than replacing it, and setting them twice is a no-op.
 * `src/images.ts` orders it the same way (CORS at the top of the handler,
 * chaos gate after).
 */
async function chaosHit(
  req: http.IncomingMessage,
  journal: Journal,
  defaults: Defaults,
  method: string,
  path: string,
  res: http.ServerResponse,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<ChaosAsyncOutcome> {
  setCorsHeaders(res);
  return await applyChaosAsync(
    res,
    null,
    defaults.chaos,
    req.headers,
    req.url,
    journal,
    {
      method,
      path,
      headers: flattenHeaders(req.headers),
      body: null,
      service: "fine-tuning",
    },
    "internal",
    defaults.registry,
    defaults.logger,
  );
}

/**
 * Record one thing that just happened to `job`. Call sites append only at the
 * moment of the transition they describe, so the log is the job's real
 * history rather than a reconstruction from its current status.
 *
 * `created_at` comes from `stamp()`, so a log that reads out of order is not
 * representable. Returns the second it stamped, which is what a terminal
 * transition assigns to `finished_at` so that nothing can follow the finish.
 */
function appendEvent(job: FineTuningJob, message: string): number {
  const log = eventLogs.get(job.id) ?? [];
  const createdAt = stamp();
  log.push({
    id: `ftevent-${job.id.replace(/^ftjob-/, "")}-${log.length}`,
    object: "fine_tuning.job.event",
    created_at: createdAt,
    level: "info",
    message,
    type: "message",
  });
  eventLogs.set(job.id, log);
  return createdAt;
}

function advance(job: FineTuningJob): FineTuningJob {
  if (isTerminal(job.status)) {
    return job;
  }
  const n = (polls.get(job.id) ?? 0) + 1;
  polls.set(job.id, n);
  if (n === 1) {
    job.status = "queued";
    appendEvent(job, "Training file validated, job queued");
  } else if (n === 2) {
    job.status = "running";
    appendEvent(job, "Training started");
  } else {
    job.status = "succeeded";
    // `ft:<model>:<org>:<suffix>:<id>`, from the spec's own worked example for
    // `suffix`: "a `suffix` of "custom-model-name" would produce a model name
    // like `ft:gpt-4o-mini:openai:custom-model-name:7p4lURel`". A job created
    // without a `suffix` keeps the four-segment name this mock has always
    // emitted rather than inventing an empty segment the spec never shows.
    const suffix = suffixes.get(job.id);
    const tail = suffix === undefined ? "" : `${suffix}:`;
    job.fine_tuned_model = `ft:${job.model}:aimock:${tail}${job.id.slice(-6)}`;
    // `result_files` is required and NOT nullable, so it starts as an empty
    // array and gains its entry here; `trained_tokens` is the nullable one and
    // stays null until this point.
    job.result_files = [`file-${job.id.replace(/^ftjob-/, "")}`];
    job.trained_tokens = job.seed % 100000;
    // The finish IS the last event, so they share one stamp: `finished_at` can
    // be neither before an earlier event nor before the one announcing it.
    job.finished_at = appendEvent(job, `Training complete, model ${job.fine_tuned_model}`);
  }
  return job;
}

function eventsFor(job: FineTuningJob): FineTuningJobEvent[] {
  // A copy: callers order the page themselves (newest-first), and the
  // append-only log must never be reordered under them.
  return [...(eventLogs.get(job.id) ?? [])];
}

/** `limit` default for both fine-tuning list endpoints (openai-openapi v2.3.0). */
const DEFAULT_PAGE_LIMIT = 20;
/** Upper bound we enforce on `limit`. Ours, not the vendor's — see `paginate`. */
const MAX_PAGE_LIMIT = 100;

export type Page<T> = { object: "list"; data: T[]; has_more: boolean };
export type PageResult<T> = { ok: true; page: Page<T> } | { ok: false; message: string };

/**
 * The query parameters of a request target.
 *
 * The query is everything after the FIRST `?`, per RFC 3986 section 3.4
 * ("The query component ... is terminated by a number sign (#) character or by
 * the end of the URI") read together with RFC 9112 section 3.2: a request
 * target is an origin-form `absolute-path [ "?" query ]` and carries no
 * fragment component at all. Both halves of that matter here:
 *
 *   - `split("?")[1]` truncates at a SECOND `?`, which is a legal literal
 *     inside a query, so `?a=1?b=2&limit=5` used to lose `limit` entirely.
 *     Slicing from the first `?` keeps it.
 *   - `new URL(target, base).searchParams` — what the router and the other
 *     query-reading mocks use — truncates at a `#` instead, because `URL`
 *     implements the fragment rule that a request target does not have. A
 *     caller that sends `?after=abc#def` on the wire means the cursor
 *     `abc#def`; reading it as `abc` is the same silent truncation one `?`
 *     along, and it turns a bad cursor into a plausible-looking one. An origin
 *     server sees no fragment, so neither does this.
 *
 * `new URLSearchParams(string)` cannot throw, so there is no parse failure to
 * swallow and no defaults-fallback to hide one: every byte of the target after
 * the first `?` is query data by definition. (A target malformed enough to
 * break `new URL` never reaches this module — `src/server.ts` builds a `URL`
 * to route on and fails there first.)
 */
function queryParams(url: string | undefined): URLSearchParams {
  const target = url ?? "/";
  const start = target.indexOf("?");
  return new URLSearchParams(start === -1 ? "" : target.slice(start + 1));
}

/**
 * The RAW query text a parameter was sent with - what the caller typed, before
 * percent- and `+`-decoding - or null when it was not sent at all.
 *
 * The unknown-`after` 400 below quotes the offending cursor, and the docs
 * promise it quotes "what you sent". `URLSearchParams` hands back the DECODED
 * value, so `?after=a%2Bb` was refused as `'a+b'` and `?after=a+b` as `'a b'` -
 * neither of which appears anywhere in the request the caller is staring at,
 * which is the one thing an error quoting a value is for.
 *
 * Pair splitting mirrors `URLSearchParams` itself, which splits on `&` alone
 * (`;` has not been a separator since the URL spec absorbed it), and the NAME
 * is matched through the platform's own decoder - one `URLSearchParams` per
 * pair - so an encoded spelling of the name still matches and nothing here
 * hand-rolls the percent codec. Only the VALUE is kept as raw text.
 */
function rawParam(url: string | undefined, name: string): string | null {
  const target = url ?? "/";
  const start = target.indexOf("?");
  if (start === -1) return null;
  for (const pair of target.slice(start + 1).split("&")) {
    if (pair.length === 0) continue;
    const [decodedName] = new URLSearchParams(pair).keys();
    if (decodedName !== name) continue;
    const eq = pair.indexOf("=");
    return eq === -1 ? "" : pair.slice(eq + 1);
  }
  return null;
}

/**
 * The single value of a query parameter, or the 400 a repeated one earns.
 *
 * `URLSearchParams.get` answers with the FIRST of a repeated parameter, which
 * launders the rest: `?limit=1&limit=abc` used to page at 1 and never look at
 * `abc`, so a caller building a URL twice over got a silent success where the
 * value it actually meant was invalid. The spec declares each of `limit` and
 * `after` as a single scalar (`listPaginatedFineTuningJobs`,
 * `listFineTuningEvents`) and gives no combining rule for a repeat, so a repeat
 * is a caller error here. That the 400 (rather than last-wins, or first-wins)
 * is ours, not the vendor's, is recorded in this module's header.
 */
function singleParam(
  params: URLSearchParams,
  name: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const all = params.getAll(name);
  if (all.length > 1) {
    return {
      ok: false,
      message: `Invalid parameter: '${name}' was given ${all.length} times; it takes a single value`,
    };
  }
  return { ok: true, value: all.length === 0 ? null : all[0] };
}

/**
 * Cursor page over an array already ordered newest-first, mirroring the
 * `after`/`limit` params both fine-tuning list endpoints accept. `has_more`
 * reports whether anything was left behind, so it is never a constant.
 *
 * Sourced 2026-09-15 from openai/openai-openapi `openapi.yaml` v2.3.0
 * (`listPaginatedFineTuningJobs`, `listFineTuningEvents`) and the vendored
 * `openai` SDK 4.104.0 `pagination.d.ts`/`pagination.js` `CursorPage`:
 *   - `after` is a free-form string id; `CursorPage.nextPageInfo()` feeds the
 *     LAST id of the page back as `after`, and `hasNextPage()` stops on
 *     `has_more: false`. Confirmed by the spec.
 *   - `limit` is `type: integer, default: 20` on both endpoints. Confirmed by
 *     the spec; the default is the vendor's.
 *
 * Three rules the spec does NOT state, chosen here and flagged as ours:
 *   - Upper bound 100 on `limit`. The spec declares no `maximum`. We enforce
 *     one so an oversized page fails loudly instead of being silently clamped,
 *     and 100 is the number our own docs page already advertises.
 *   - An `after` that matches no item is a 400 rather than a silent page 1.
 *     Returning page 1 makes the SDK's `CursorPage` auto-paginator restart from
 *     the top forever on a stale cursor; failing loudly is the whole point of a
 *     mock. Not observed against api.openai.com.
 *   - Newest-first ordering. Neither list endpoint accepts an `order` param and
 *     the spec never states a direction; the `listFineTuningEvents` example
 *     response lists the completion event ahead of the earlier
 *     model-created event, which reads as reverse-chronological.
 */
export function paginate<T extends { id: string }>(
  items: T[],
  url: string | undefined,
): PageResult<T> {
  const params = queryParams(url);
  const readLimit = singleParam(params, "limit");
  if (!readLimit.ok) return { ok: false, message: readLimit.message };
  const rawLimit = readLimit.value;
  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== null) {
    const n = parseStrictIntegerText(rawLimit);
    if (n === null || n < 1 || n > MAX_PAGE_LIMIT) {
      // Quoted from the RAW query text, like the `after` message below, so
      // `?limit=%2B5` is refused as `'%2B5'` rather than as the `'+5'` the
      // caller never wrote (see `rawParam`).
      return {
        ok: false,
        message: `Invalid parameter: 'limit' must be an integer between 1 and ${MAX_PAGE_LIMIT}, got '${rawParam(url, "limit") ?? rawLimit}'`,
      };
    }
    limit = n;
  }
  const readAfter = singleParam(params, "after");
  if (!readAfter.ok) return { ok: false, message: readAfter.message };
  const after = readAfter.value;
  let start = 0;
  if (after !== null) {
    const idx = items.findIndex((it) => it.id === after);
    if (idx === -1) {
      // Quoted so the message still names the offending value when the caller
      // sent `?after=`, which `URLSearchParams` reads as the empty string, and
      // quoted from the RAW query text so the value in the message is the one
      // the caller wrote rather than its decoding (see `rawParam`).
      return {
        ok: false,
        message: `Invalid parameter: 'after' is not a known cursor: '${rawParam(url, "after") ?? after}'`,
      };
    }
    start = idx + 1;
  }
  const rest = items.slice(start);
  return {
    ok: true,
    page: { object: "list", data: rest.slice(0, limit), has_more: rest.length > limit },
  };
}

/** Write a paginated list, or the 400 its `after`/`limit` params earned. */
function writePage<T extends { id: string }>(
  res: http.ServerResponse,
  journal: Journal,
  req: http.IncomingMessage,
  method: string,
  path: string,
  items: T[],
  setCorsHeaders: (res: http.ServerResponse) => void,
): void {
  const result = paginate(items, req.url);
  const status = result.ok ? 200 : 400;
  journalFt(journal, method, path, flattenHeaders(req.headers), status);
  writeJson(res, status, result.ok ? result.page : invalid(result.message), setCorsHeaders);
}

/**
 * Deterministic seed in the spec's `[0, 2147483647]` range, derived from the
 * job id so repeated reads of the same job report the same seed.
 */
function seedFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  }
  return (h >>> 0) % 2147483648;
}

/**
 * One hyperparameter's declared domain, in the shape `readHyper` reads it.
 *
 * The tag is explicit rather than inferred from which optional fields a rule
 * happens to carry: `"integer"` vs `"number"` IS the spec's `type:`, and a
 * table whose meaning depends on the absence of a key silently changes
 * behaviour the moment a bound is added or dropped.
 *
 *   - `integer` / `number`: the spec spells each of these as a `oneOf` of the
 *     string `"auto"` and a bounded numeric, so `"auto"` is legal for every
 *     rule of either kind. `max: null` means the spec declares no upper bound.
 *   - `enum`: a plain `type: string, enum: [...]` with NO `"auto"` member
 *     (`reasoning_effort` is the only one), so `"auto"` is a 400 there.
 */
type HyperRule =
  | { kind: "integer"; min: number; max: number | null }
  | { kind: "number"; exclusiveMin: number; max: number | null }
  | { kind: "enum"; values: readonly string[] };

type HyperTable = Readonly<Record<string, HyperRule>>;

/**
 * The three members `CreateFineTuningJobRequest.hyperparameters` and
 * `FineTuneSupervisedHyperparameters` both declare, quoted from
 * openai/openai-openapi `openapi.yaml` v2.3.0 (`master`):
 *   - `n_epochs`: `type: integer, minimum: 1, maximum: 50`
 *   - `batch_size`: `type: integer, minimum: 1, maximum: 256`
 *   - `learning_rate_multiplier`: `type: number, minimum: 0,
 *     exclusiveMinimum: true` — strictly greater than zero, hence no `max`.
 *
 * The vendored SDK's `JobCreateParams.Hyperparameters` types each member as
 * `"auto" | number`, which is as much as TypeScript can say; the bounds only
 * exist in the spec, so they are enforced here from it.
 */
const SUPERVISED_HYPER_RULES = {
  n_epochs: { kind: "integer", min: 1, max: 50 },
  batch_size: { kind: "integer", min: 1, max: 256 },
  learning_rate_multiplier: { kind: "number", exclusiveMin: 0, max: null },
} as const satisfies HyperTable;

/**
 * The deprecated top-level `hyperparameters` object. The spec declares exactly
 * the three supervised members on it — `beta` and the reinforcement knobs live
 * only under `method`, and the description says this whole object "is now
 * deprecated in favor of `method`".
 */
const LEGACY_HYPER_RULES = SUPERVISED_HYPER_RULES;

/**
 * `FineTuneDPOHyperparameters`: the supervised three plus `beta`, declared
 * `type: number, minimum: 0, exclusiveMinimum: true, maximum: 2`.
 */
const DPO_HYPER_RULES = {
  ...SUPERVISED_HYPER_RULES,
  beta: { kind: "number", exclusiveMin: 0, max: 2 },
} as const satisfies HyperTable;

/**
 * `FineTuneReinforcementHyperparameters`: the supervised three plus
 * `reasoning_effort` (`enum: [default, low, medium, high]`, no `"auto"`),
 * `compute_multiplier` (`minimum: 0.00001, exclusiveMinimum: true,
 * maximum: 10`), and `eval_interval`/`eval_samples` (`type: integer,
 * minimum: 1`, no declared maximum).
 */
const REINFORCEMENT_HYPER_RULES = {
  ...SUPERVISED_HYPER_RULES,
  reasoning_effort: { kind: "enum", values: ["default", "low", "medium", "high"] },
  compute_multiplier: { kind: "number", exclusiveMin: 0.00001, max: 10 },
  eval_interval: { kind: "integer", min: 1, max: null },
  eval_samples: { kind: "integer", min: 1, max: null },
} as const satisfies HyperTable;

/** How a rule reads in an error message, so the caller learns the domain. */
function describeRule(rule: HyperRule): string {
  if (rule.kind === "enum") {
    return `one of ${rule.values.map((v) => `"${v}"`).join(", ")}`;
  }
  const upper = rule.max === null ? "" : ` and at most ${rule.max}`;
  const lower =
    rule.kind === "integer"
      ? `an integer at least ${rule.min}`
      : `a number greater than ${rule.exclusiveMin}`;
  return `${lower}${upper}, or the string "auto"`;
}

/**
 * Reads one hyperparameter against its rule. Anything outside the rule is a
 * caller error, never a silent drop — a mock that accepted `n_epochs: 0` would
 * let a bug reach the real API instead of failing where it is cheap to see.
 *
 * `path` names the object the member came from (`hyperparameters`,
 * `method.dpo.hyperparameters`, …) so the message points at the thing the
 * caller actually wrote.
 */
function readHyper(
  table: HyperTable,
  path: string,
  key: string,
  value: unknown,
): { ok: true; value: number | string } | { ok: false; message: string } {
  // Own property only: `table[key]` walks `Object.prototype`, so `toString`
  // and friends would resolve to an inherited function instead of `undefined`.
  const rule = Object.hasOwn(table, key) ? table[key] : undefined;
  // `readHyperObject` rejects an unknown key first, so this only fires for a
  // direct caller; it is the same 400 either way.
  if (rule === undefined) return { ok: false, message: unknownMemberMessage(table, path, key) };
  const bad = {
    ok: false as const,
    message: `Invalid parameter: '${path}.${key}' must be ${describeRule(rule)}`,
  };
  if (rule.kind === "enum") {
    return typeof value === "string" && rule.values.includes(value) ? { ok: true, value } : bad;
  }
  if (value === "auto") return { ok: true, value: "auto" };
  if (typeof value !== "number" || !Number.isFinite(value)) return bad;
  if (rule.max !== null && value > rule.max) return bad;
  if (rule.kind === "integer") {
    return value >= rule.min && Number.isInteger(value) ? { ok: true, value } : bad;
  }
  return value > rule.exclusiveMin ? { ok: true, value } : bad;
}

/** The 400 an unrecognised member of a rule-table-backed object earns. */
function unknownMemberMessage(table: HyperTable, path: string, key: string): string {
  return (
    `Invalid parameter: '${path}.${key}' is not a recognized member of '${path}'; ` +
    `it accepts ${Object.keys(table).join(", ")}`
  );
}

/**
 * Reads a whole hyperparameters object against its rule table.
 *
 * An unrecognised member is a 400 rather than a silent drop. The spec does not
 * mark these objects `additionalProperties: false`, so this rule is ours, not
 * the vendor's — and it is the point of the surface: `{n_epochs: 3, beta: 0.5}`
 * used to answer 200 echoing only `n_epochs`, so a caller who put a real DPO
 * hyperparameter (`FineTuneDPOHyperparameters.beta`) in the deprecated
 * top-level object instead of under `method.dpo.hyperparameters` was told it
 * had been accepted. Naming the members the object does take is what turns
 * that into a fixable message.
 */
function readHyperObject(
  table: HyperTable,
  path: string,
  raw: Record<string, unknown>,
): { ok: true; value: Record<string, number | string> } | { ok: false; message: string } {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    // `key in table` would walk `Object.prototype`, letting `toString`,
    // `constructor`, `valueOf` and `__proto__` through this gate.
    if (!Object.hasOwn(table, key)) {
      return { ok: false, message: unknownMemberMessage(table, path, key) };
    }
    const read = readHyper(table, path, key, value);
    if (!read.ok) return read;
    out[key] = read.value;
  }
  return { ok: true, value: out };
}

/**
 * Every property `CreateFineTuningJobRequest` declares (openai-openapi v2.3.0).
 *
 * Each one is read below; nothing on this list is accepted and dropped, and
 * anything NOT on it is a 400. The spec does not mark the request object
 * `additionalProperties: false`, so rejecting an unknown key is this mock's
 * rule, not the vendor's: a create body is written once and reused for months,
 * and a typo that answers 200 having ignored the field is exactly the bug a
 * mock exists to catch.
 */
const CREATE_KEYS = [
  "model",
  "training_file",
  "hyperparameters",
  "suffix",
  "validation_file",
  "integrations",
  "seed",
  "method",
  "metadata",
] as const;

/** The members of the deprecated top-level `hyperparameters`, as the job echoes them. */
const LEGACY_HYPER_KEYS = [
  "n_epochs",
  "batch_size",
  "learning_rate_multiplier",
] as const satisfies readonly (keyof typeof LEGACY_HYPER_RULES)[];

/** `Metadata` in the spec: at most 16 pairs, keys <= 64 chars, values <= 512. */
const METADATA_MAX_PAIRS = 16;
const METADATA_MAX_KEY = 64;
const METADATA_MAX_VALUE = 512;

/** `CreateFineTuningJobRequest.suffix`: `minLength: 1, maxLength: 64`. */
const SUFFIX_MAX_LENGTH = 64;

/** `CreateFineTuningJobRequest.seed`: `minimum: 0, maximum: 2147483647`. */
const SEED_MAX = 2147483647;

/** `FineTuningJob.integrations`: `maxItems: 5`. */
const MAX_INTEGRATIONS = 5;

export type Read<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Length in Unicode CODE POINTS, which is the unit the spec's limits are in.
 *
 * Every `maxLength` quoted in this module is a pydantic `max_length` on the
 * vendor's side, and pydantic counts code points; `String.prototype.length`
 * counts UTF-16 code units, which is the same number only while the string
 * stays inside the BMP. One astral character - an emoji, a rarer CJK
 * ideograph, a musical symbol - counts two there, so a `suffix` of exactly 64
 * characters holding one used to earn a 400 the real API would not send, and a
 * caller that trusted the mock would have shortened a name that was legal.
 */
function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * `suffix`, per its spec description: "A string of up to 64 characters that
 * will be added to your fine-tuned model name. For example, a `suffix` of
 * "custom-model-name" would produce a model name like
 * `ft:gpt-4o-mini:openai:custom-model-name:7p4lURel`." It is declared
 * `type: string, minLength: 1, maxLength: 64, nullable: true, default: null`,
 * so `null` means "no suffix" and `""` is a 400.
 */
function readSuffix(value: unknown): Read<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    codePointLength(value) > SUFFIX_MAX_LENGTH
  ) {
    return {
      ok: false,
      message: `Invalid parameter: 'suffix' must be a string of 1 to ${SUFFIX_MAX_LENGTH} characters or null`,
    };
  }
  return { ok: true, value };
}

/**
 * `seed`, per its spec description: "The seed controls the reproducibility of
 * the job ... If a seed is not specified, one will be generated for you", and
 * declared `type: integer, nullable: true, minimum: 0, maximum: 2147483647`.
 * `null` and absence both mean "generate one", which is what `seedFor` does.
 */
function readSeed(value: unknown): Read<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > SEED_MAX) {
    return {
      ok: false,
      message: `Invalid parameter: 'seed' must be an integer between 0 and ${SEED_MAX} or null`,
    };
  }
  return { ok: true, value };
}

/**
 * `metadata`, per the shared `Metadata` schema: an object of string values, at
 * most 16 pairs, keys at most 64 characters and values at most 512, or `null`.
 * `FineTuningJob` declares `metadata` too, so what is accepted is echoed back.
 */
export function readMetadata(value: unknown): Read<Record<string, string> | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isJsonObject(value)) {
    return { ok: false, message: "Invalid parameter: 'metadata' must be a JSON object or null" };
  }
  const entries = Object.entries(value);
  if (entries.length > METADATA_MAX_PAIRS) {
    return {
      ok: false,
      message: `Invalid parameter: 'metadata' accepts at most ${METADATA_MAX_PAIRS} key-value pairs, got ${entries.length}`,
    };
  }
  // `metadata` keys are the caller's own namespace, so `__proto__` is an
  // ordinary key here and is echoed back like any other. Writing it onto an
  // object literal would instead hit `Object.prototype`'s `__proto__` setter,
  // which ignores a string value silently - a 200 that dropped the pair, and a
  // pair count that no longer matches what reads back.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of entries) {
    const keyLength = codePointLength(key);
    if (keyLength > METADATA_MAX_KEY) {
      return {
        ok: false,
        message: `Invalid parameter: 'metadata' keys are at most ${METADATA_MAX_KEY} characters, got ${keyLength}`,
      };
    }
    if (typeof entry !== "string" || codePointLength(entry) > METADATA_MAX_VALUE) {
      return {
        ok: false,
        message: `Invalid parameter: 'metadata.${key}' must be a string of at most ${METADATA_MAX_VALUE} characters`,
      };
    }
    out[key] = entry;
  }
  return { ok: true, value: out };
}

/**
 * One `integrations` entry. The spec requires both `type` and `wandb`, types
 * `type` as the single-member enum `wandb`, and requires `project` inside
 * `wandb`; `name` and `entity` are nullable strings and `tags` an array of
 * strings. `FineTuningJob.integrations` caps the list at `maxItems: 5` — the
 * request schema declares no cap, so enforcing the response's here is ours.
 */
function readIntegration(index: number, raw: unknown): Read<FineTuningJobIntegration> {
  const at = `integrations[${index}]`;
  if (!isJsonObject(raw)) {
    return { ok: false, message: `Invalid parameter: '${at}' must be a JSON object` };
  }
  for (const key of Object.keys(raw)) {
    if (key !== "type" && key !== "wandb") {
      return {
        ok: false,
        message: `Invalid parameter: '${at}.${key}' is not a recognized member of '${at}'; it accepts type, wandb`,
      };
    }
  }
  if (raw["type"] !== "wandb") {
    return { ok: false, message: `Invalid parameter: '${at}.type' must be the string "wandb"` };
  }
  const wandb = raw["wandb"];
  if (!isJsonObject(wandb)) {
    return { ok: false, message: `Invalid parameter: '${at}.wandb' must be a JSON object` };
  }
  for (const key of Object.keys(wandb)) {
    if (key !== "project" && key !== "name" && key !== "entity" && key !== "tags") {
      return {
        ok: false,
        message: `Invalid parameter: '${at}.wandb.${key}' is not a recognized member of '${at}.wandb'; it accepts project, name, entity, tags`,
      };
    }
  }
  const project = wandb["project"];
  if (typeof project !== "string" || project.length === 0) {
    return {
      ok: false,
      message: `Invalid parameter: '${at}.wandb.project' must be a non-empty string`,
    };
  }
  const value: FineTuningJobIntegration = { type: "wandb", wandb: { project } };
  for (const key of ["name", "entity"] as const) {
    const member = wandb[key];
    if (member === undefined) continue;
    if (member !== null && typeof member !== "string") {
      return {
        ok: false,
        message: `Invalid parameter: '${at}.wandb.${key}' must be a string or null`,
      };
    }
    value.wandb[key] = member;
  }
  const tags = wandb["tags"];
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
      return {
        ok: false,
        message: `Invalid parameter: '${at}.wandb.tags' must be an array of strings`,
      };
    }
    value.wandb.tags = tags.filter((tag): tag is string => typeof tag === "string");
  }
  return { ok: true, value };
}

/** `integrations`: a nullable array of the entries above. */
function readIntegrations(value: unknown): Read<FineTuningJobIntegration[] | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) {
    return { ok: false, message: "Invalid parameter: 'integrations' must be an array or null" };
  }
  if (value.length > MAX_INTEGRATIONS) {
    return {
      ok: false,
      message: `Invalid parameter: 'integrations' accepts at most ${MAX_INTEGRATIONS} entries, got ${value.length}`,
    };
  }
  const out: FineTuningJobIntegration[] = [];
  for (const [index, entry] of value.entries()) {
    const read = readIntegration(index, entry);
    if (!read.ok) return read;
    out.push(read.value);
  }
  return { ok: true, value: out };
}

/** The rule table each `method` variant's `hyperparameters` is read against. */
const METHOD_HYPER_RULES = {
  supervised: SUPERVISED_HYPER_RULES,
  dpo: DPO_HYPER_RULES,
  reinforcement: REINFORCEMENT_HYPER_RULES,
} as const;

const METHOD_TYPES = ["supervised", "dpo", "reinforcement"] as const;

/**
 * `method`, per `FineTuneMethod`: `type` is required and is one of
 * `supervised`, `dpo`, `reinforcement`, and each of those names an optional
 * sub-object carrying that method's `hyperparameters`. `FineTuneReinforcementMethod`
 * additionally requires a `grader`, so `type: "reinforcement"` requires one
 * whether or not the `reinforcement` sub-object is present at all — the
 * requirement is keyed on the chosen `type`, not on the sub-object happening
 * to be there.
 *
 * Only the chosen type's sub-object is accepted. `FineTuneMethod` leaves all
 * three optional and says nothing about a configuration for a type that was
 * not chosen, and neither does SDK 4.104.0's `JobCreateParams.Method`; every
 * example in the spec pairs a `type` with that type's own configuration and
 * no other (`createFineTuningJob`, the "Reinforcement" example). With the real
 * API's behaviour uncitable, a stray configuration is rejected rather than
 * accepted-and-ignored: this mock never takes a member it then drops.
 *
 * The grader itself (`GraderStringCheck` | `GraderTextSimilarity` |
 * `GraderPython` | `GraderScoreModel` | `GraderMulti`) is a schema tree of its
 * own that this mock does not model: it is required to be a JSON object and is
 * then echoed back verbatim on the job. That is a deliberate pass-through, not
 * a drop — what the caller sent is what the caller reads back.
 *
 * `FineTuningJob` declares `method`, so an accepted method is echoed.
 */
function readMethod(value: unknown): Read<FineTuningJobMethod | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isJsonObject(value)) {
    return { ok: false, message: "Invalid parameter: 'method' must be a JSON object or null" };
  }
  for (const key of Object.keys(value)) {
    if (key !== "type" && !METHOD_TYPES.some((t) => t === key)) {
      return {
        ok: false,
        message: `Invalid parameter: 'method.${key}' is not a recognized member of 'method'; it accepts type, ${METHOD_TYPES.join(", ")}`,
      };
    }
  }
  const type = METHOD_TYPES.find((t) => t === value["type"]);
  if (type === undefined) {
    return {
      ok: false,
      message: `Invalid parameter: 'method.type' must be one of ${METHOD_TYPES.map((t) => `"${t}"`).join(", ")}`,
    };
  }
  const method: FineTuningJobMethod = { type };
  for (const variant of METHOD_TYPES) {
    if (variant !== type && value[variant] !== undefined) {
      return {
        ok: false,
        message: `Invalid parameter: 'method.${variant}' configures the "${variant}" method, but 'method.type' is "${type}"; a method carries only its own configuration`,
      };
    }
  }
  const supplied = value[type];
  // A reinforcement method requires a `grader`; an absent `reinforcement`
  // object is therefore an empty one, read here so the `grader` check below
  // rejects it instead of the method slipping through unconfigured.
  const raw = supplied === undefined && type === "reinforcement" ? {} : supplied;
  if (raw !== undefined) {
    if (!isJsonObject(raw)) {
      return { ok: false, message: `Invalid parameter: 'method.${type}' must be a JSON object` };
    }
    const allowed = type === "reinforcement" ? ["grader", "hyperparameters"] : ["hyperparameters"];
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) {
        return {
          ok: false,
          message: `Invalid parameter: 'method.${type}.${key}' is not a recognized member of 'method.${type}'; it accepts ${allowed.join(", ")}`,
        };
      }
    }
    const config: FineTuningJobMethodConfig = {};
    if (type === "reinforcement") {
      const grader = raw["grader"];
      if (!isJsonObject(grader)) {
        return {
          ok: false,
          message:
            "Invalid parameter: 'method.reinforcement.grader' is required and must be a JSON object",
        };
      }
      config.grader = grader;
    }
    const hyper = raw["hyperparameters"];
    if (hyper !== undefined) {
      if (!isJsonObject(hyper)) {
        return {
          ok: false,
          message: `Invalid parameter: 'method.${type}.hyperparameters' must be a JSON object`,
        };
      }
      const read = readHyperObject(
        METHOD_HYPER_RULES[type],
        `method.${type}.hyperparameters`,
        hyper,
      );
      if (!read.ok) return read;
      config.hyperparameters = read.value;
    }
    method[type] = config;
  }
  return { ok: true, value: method };
}

export async function handleFineTuningCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  raw: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/fine_tuning/jobs";
  const method = req.method ?? "POST";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch (err) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(
      res,
      400,
      invalid(`Malformed JSON: ${err instanceof Error ? err.message : "unknown"}`),
      setCorsHeaders,
    );
    return;
  }
  if (!isJsonObject(body)) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid("Request body must be a JSON object"), setCorsHeaders);
    return;
  }
  // Recorded verbatim rather than reshaped into a synthetic chat request that
  // would misreport what the caller actually sent. `JournalBody` covers the
  // non-chat member, so this needs no cast — and must not have one: the body
  // is still unvalidated here (the checks below are what reject it), so any
  // claim about its shape at this point would be a claim about arbitrary JSON.
  const journaledBody: JournalBody = body;
  /**
   * Every rejection below journals the parsed body before answering: these are
   * exactly the 400s whose offending payload a caller needs to read back.
   */
  const reject = (message: string): void => {
    journalFt(journal, method, path, flattenHeaders(req.headers), 400, journaledBody);
    writeJson(res, 400, invalid(message), setCorsHeaders);
  };
  for (const key of Object.keys(body)) {
    if (!CREATE_KEYS.some((known) => known === key)) {
      reject(
        `Invalid parameter: '${key}' is not a recognized request parameter; this endpoint accepts ${CREATE_KEYS.join(", ")}`,
      );
      return;
    }
  }
  const trainingFile = body["training_file"];
  const model = body["model"];
  if (typeof trainingFile !== "string" || trainingFile.length === 0) {
    reject("Invalid parameter: 'training_file' must be a non-empty string");
    return;
  }
  if (typeof model !== "string" || model.length === 0) {
    reject("Invalid parameter: 'model' must be a non-empty string");
    return;
  }
  const validationFile = body["validation_file"];
  // `null` is legal - the spec marks `validation_file` `nullable: true` - but
  // `""` is not a file id. The spec sets no `minLength` on either file id; the
  // empty-string rejection is this mock's, and it matches `training_file`
  // above rather than disagreeing with it.
  if (
    validationFile !== undefined &&
    validationFile !== null &&
    (typeof validationFile !== "string" || validationFile.length === 0)
  ) {
    reject("Invalid parameter: 'validation_file' must be a non-empty string or null");
    return;
  }
  const hyper = body["hyperparameters"];
  // `null` is rejected with everything else that is not an object: the spec
  // types `hyperparameters` as `type: object` and, unlike its siblings
  // `suffix`, `validation_file` and `integrations`, never marks it
  // `nullable: true`.
  if (hyper !== undefined && !isJsonObject(hyper)) {
    reject("Invalid parameter: 'hyperparameters' must be a JSON object");
    return;
  }
  const hyperparameters: FineTuningJobHyperparameters = {};
  if (isJsonObject(hyper)) {
    const read = readHyperObject(LEGACY_HYPER_RULES, "hyperparameters", hyper);
    if (!read.ok) {
      reject(read.message);
      return;
    }
    for (const key of LEGACY_HYPER_KEYS) {
      const value = read.value[key];
      // Every rule in this table is an `integer`/`number` kind, so a value
      // that survived it is a number or the string "auto". The guard proves
      // that to the type; it is not a filter, and cannot drop anything.
      if (typeof value === "number" || value === "auto") hyperparameters[key] = value;
    }
  }
  const suffix = readSuffix(body["suffix"]);
  if (!suffix.ok) {
    reject(suffix.message);
    return;
  }
  const seed = readSeed(body["seed"]);
  if (!seed.ok) {
    reject(seed.message);
    return;
  }
  const integrations = readIntegrations(body["integrations"]);
  if (!integrations.ok) {
    reject(integrations.message);
    return;
  }
  const jobMethod = readMethod(body["method"]);
  if (!jobMethod.ok) {
    reject(jobMethod.message);
    return;
  }
  const metadata = readMetadata(body["metadata"]);
  if (!metadata.ok) {
    reject(metadata.message);
    return;
  }
  const id = generateId("ftjob");
  const job: FineTuningJob = {
    id,
    object: "fine_tuning.job",
    model,
    training_file: trainingFile,
    validation_file: typeof validationFile === "string" ? validationFile : null,
    status: "validating_files",
    created_at: stamp(),
    finished_at: null,
    fine_tuned_model: null,
    hyperparameters,
    error: null,
    organization_id: ORGANIZATION_ID,
    result_files: [],
    seed: seed.value ?? seedFor(id),
    trained_tokens: null,
  };
  // The three optional job properties are set only when the caller sent them:
  // the spec lists none of them in `FineTuningJob.required`, so emitting
  // `"method": null` on every job would be a field the vendor never sends.
  if (integrations.value !== null) job.integrations = integrations.value;
  if (jobMethod.value !== null) job.method = jobMethod.value;
  if (metadata.value !== null) job.metadata = metadata.value;
  // `suffix` is NOT a property of `fine_tuning.job`, so it is kept beside the
  // job rather than on it, the way the event log is; it is observable only
  // through the `fine_tuned_model` name the job takes when it succeeds.
  if (suffix.value !== null) suffixes.set(job.id, suffix.value);
  jobs.set(job.id, job);
  polls.set(job.id, 0);
  appendEvent(job, "Job created, validating training file");
  journalFt(journal, method, path, flattenHeaders(req.headers), 200, journaledBody);
  writeJson(res, 200, job, setCorsHeaders);
}

export async function handleFineTuningList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? "/v1/fine_tuning/jobs";
  const method = req.method ?? "GET";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  // Newest-first. `stamp()` is monotonic module-wide, so insertion order is
  // unconditionally non-decreasing in `created_at` - a job created later never
  // carries an earlier second, whichever way the wall clock moved - and
  // reversing it is therefore both newest-first and the stable total order a
  // cursor walk needs. Sorting on `created_at` would not be: it has one-second
  // resolution, so ties are the normal case and a sort cannot order them.
  const all = [...jobs.values()].reverse();
  writePage(res, journal, req, method, path, all, setCorsHeaders);
}

export async function handleFineTuningRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/fine_tuning/jobs/${id}`;
  const method = req.method ?? "GET";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const job = jobs.get(id);
  if (!job) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such fine-tuning job: ${id}`), setCorsHeaders);
    return;
  }
  journalFt(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, advance(job), setCorsHeaders);
}

export async function handleFineTuningCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/fine_tuning/jobs/${id}/cancel`;
  const method = req.method ?? "POST";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const job = jobs.get(id);
  if (!job) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such fine-tuning job: ${id}`), setCorsHeaders);
    return;
  }
  if (isTerminal(job.status)) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 400);
    writeJson(res, 400, invalid(`Job ${id} is already terminal (${job.status})`), setCorsHeaders);
    return;
  }
  job.status = "cancelled";
  // A cancelled job is finished, and the wire type declares `finished_at` null
  // only "if the fine-tuning job is still running" - so stamp it the same way
  // `advance()` stamps it on `succeeded`: from the cancellation event itself,
  // which keeps the finish at or after every timestamp that preceded it.
  job.finished_at = appendEvent(job, "Job cancelled by user");
  journalFt(journal, method, path, flattenHeaders(req.headers), 200);
  writeJson(res, 200, job, setCorsHeaders);
}

export async function handleFineTuningEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  journal: Journal,
  defaults: Defaults,
  setCorsHeaders: (res: http.ServerResponse) => void,
): Promise<void> {
  const path = req.url ?? `/v1/fine_tuning/jobs/${id}/events`;
  const method = req.method ?? "GET";
  if (await chaosHit(req, journal, defaults, method, path, res, setCorsHeaders)) return;
  const job = jobs.get(id);
  if (!job) {
    journalFt(journal, method, path, flattenHeaders(req.headers), 404);
    writeJson(res, 404, invalid(`No such fine-tuning job: ${id}`), setCorsHeaders);
    return;
  }
  writePage(res, journal, req, method, path, eventsFor(job).reverse(), setCorsHeaders);
}
