import type * as http from "node:http";
import type { RecordConfig } from "./types.js";
import type { Logger } from "./logger.js";
import { DEFAULT_TEST_ID } from "./constants.js";
import { clampTimeout } from "./recorder.js";

/**
 * Shared upstream-proxy helpers for the async video-generation handlers
 * (OpenRouter / Veo / Grok). These are the provider-agnostic primitives every
 * live record-mode proxy needs: request-base derivation behind a forwarding
 * proxy, testId URL-suffix embedding, upstream timeout signals, and bounded
 * idle-based body reads. They were extracted verbatim from openrouter-video.ts
 * so all three handlers share one implementation rather than triplicating it.
 *
 * NOT included here (byte-download only, OpenRouter-specific):
 * `fetchHeadersWithTimeout` and the streaming content relay. Veo serves the
 * Files-API uri as-is and Grok serves `video.url` as-is — neither downloads
 * video bytes — so those stay private to openrouter-video.ts.
 */

/**
 * First non-empty value of a possibly array-typed, possibly comma-joined
 * header. An empty header value or a leading-comma list (", host") would
 * otherwise yield "" — triggering a spurious rejection warn and discarding
 * valid later entries — so empty segments are skipped.
 */
export function firstForwardedValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw === undefined) return undefined;
  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

// Conservative host[:port] shape for x-forwarded-host. Spaces, slashes,
// userinfo, or any other URL-structure character would corrupt (or smuggle
// paths into) the generated URLs the value is interpolated into. Underscores
// are admitted: the value feeds URL-string interpolation, not DNS validation,
// and underscore hostnames are routine in docker-compose/k8s networks
// (e.g. my_project_aimock:4010).
const FORWARDED_HOST_RE = /^[a-zA-Z0-9._-]+(:\d+)?$/;
// Bracketed IPv6 literal host[:port], e.g. [::1] or [::1]:8080 — the bare
// RE above cannot admit ":" inside the host without also admitting junk.
const FORWARDED_HOST_IPV6_RE = /^\[[0-9a-fA-F:.]+\](:\d+)?$/;

export function requestBase(req: http.IncomingMessage, logger: Logger): string {
  // Honor x-forwarded-proto and x-forwarded-host so generated URLs survive a
  // TLS-terminating or host-rewriting proxy in front of the mock. First
  // non-empty value wins on comma-joined lists.
  const candidate = firstForwardedValue(req.headers["x-forwarded-proto"])?.toLowerCase();
  // Allowlist http/https — any other value (ws, junk header data) falls back.
  const proto = candidate === "http" || candidate === "https" ? candidate : "http";
  // Like the proto allowlist, a forwarded host that doesn't look like a bare
  // host[:port] (or a bracketed IPv6 literal) falls back to the Host header —
  // with a warn, so a misconfigured proxy isn't silently ignored.
  const fwdHost = firstForwardedValue(req.headers["x-forwarded-host"]);
  // The Host fallback gets the same host[:port] validation — a junk Host
  // (e.g. "evil.com/path") could otherwise smuggle URL structure into the
  // generated URLs. No warn: a missing/odd Host is transport-level noise,
  // unlike a misconfigured proxy's x-forwarded-host.
  const rawHost = req.headers.host;
  let host =
    rawHost !== undefined &&
    (FORWARDED_HOST_RE.test(rawHost) || FORWARDED_HOST_IPV6_RE.test(rawHost))
      ? rawHost
      : "localhost";
  if (fwdHost !== undefined) {
    if (FORWARDED_HOST_RE.test(fwdHost) || FORWARDED_HOST_IPV6_RE.test(fwdHost)) {
      host = fwdHost;
    } else {
      logger.warn(
        `x-forwarded-host value rejected, falling back to Host header: ${JSON.stringify(fwdHost.slice(0, 100))}`,
      );
    }
  }
  return `${proto}://${host}`;
}

/**
 * Query-string suffix embedding the request's testId into generated URLs
 * (polling_url, unsigned_urls). The provider SDK fetches these URLs with
 * standard Authorization but no aimock-specific headers (no x-test-id) — so
 * the testId must travel in the URL for getTestId's `?testId=` fallback to
 * resolve the right job scope. The default testId is omitted to keep
 * single-tenant URLs clean.
 */
export function testIdSuffix(testId: string, sep: "?" | "&"): string {
  return testId === DEFAULT_TEST_ID ? "" : `${sep}testId=${encodeURIComponent(testId)}`;
}

/** Default upstream timeout for the live lifecycle proxy (matches recorder.ts). */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Abort signal for the SMALL-JSON upstream fetches on this surface (submit,
 * status poll, models listing), honoring `record.upstreamTimeoutMs` with the
 * same clamp conventions as recorder.ts (non-finite / non-positive values
 * fall back to the 30s default). Note the nuance (documented on
 * RecordConfig.upstreamTimeoutMs): these envelope-sized fetches use the value
 * as a TOTAL deadline via AbortSignal.timeout — indistinguishable from a
 * socket-idle timeout for small bodies. The byte-bearing content fetches use
 * `fetchHeadersWithTimeout` + `readBodyIdle` instead, which implement true
 * idle semantics. An abort rejects the fetch and surfaces through the
 * caller's existing failure path (502 proxy_error on submit/poll, models
 * synthesis fallback).
 */
export function upstreamTimeoutSignal(record: RecordConfig | undefined): AbortSignal {
  return AbortSignal.timeout(clampTimeout(record?.upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS));
}

/**
 * Buffer a fetch Response body with IDLE-based timeout semantics: a timer
 * clamped from `record.bodyTimeoutMs` (30s default — same clamp as
 * recorder.ts) is re-armed for every chunk, so a steadily-dripping body of
 * any total duration completes and only a silent mid-body stall rejects.
 * When `cap` > 0 the byte count is enforced DURING the read: on exceed the
 * stream is cancelled and `{ overCap: true }` is returned with NOTHING
 * oversized retained in memory — the cap is a memory guard as much as a
 * disk guard.
 */
export async function readBodyIdle(
  res: Response,
  record: RecordConfig | undefined,
  cap = 0,
): Promise<{ overCap: false; buf: Buffer } | { overCap: true; bytesRead: number }> {
  const body = res.body;
  if (!body) return { overCap: false, buf: Buffer.alloc(0) };
  const idleMs = clampTimeout(record?.bodyTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      let idleTimer: NodeJS.Timeout | undefined;
      // A stream error landing AFTER the idle timeout has already won the
      // race must never become an unhandledRejection (process crash) — attach
      // a no-op rejection handler to the read promise BEFORE racing.
      // Promise.race subscribes to its inputs too, so this is deliberate
      // defense-in-depth pinning the invariant against a refactor that races
      // the read differently; the race below still observes the rejection
      // normally when the read loses first.
      const readPromise = reader.read();
      readPromise.catch(() => {});
      const result = await Promise.race([
        readPromise,
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new Error(`Upstream response body idle for ${idleMs}ms`)),
            idleMs,
          );
        }),
      ]).finally(() => clearTimeout(idleTimer));
      if (result.done) break;
      total += result.value.byteLength;
      if (cap > 0 && total > cap) {
        return { overCap: true, bytesRead: total };
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    // Idle expiry and the over-cap early return leave the stream open —
    // release it. After a normal completion this is a no-op.
    void reader.cancel().catch(() => {});
  }
  return { overCap: false, buf: Buffer.concat(chunks) };
}

/**
 * Cap on the small-JSON upstream envelope bodies (submit, status poll, models
 * listing) buffered before parse/relay. Envelopes are KB-scale in practice —
 * 1 MB is generous headroom even for a large models listing — and they are
 * buffered in full, so an unbounded `text()` would be a memory hole on a
 * hostile upstream.
 */
export const VIDEO_PROXY_ENVELOPE_BODY_CAP = 1024 * 1024;

/**
 * Bounded read of a small-JSON upstream envelope body (submit, status poll,
 * models listing): readBodyIdle's idle semantics plus the envelope cap. An
 * over-cap body is a hard failure — the throw surfaces through each caller's
 * existing failure path (502 proxy_error on submit/poll, models synthesis
 * fallback) without retaining anything oversized in memory.
 */
export async function readEnvelopeText(
  res: Response,
  record: RecordConfig | undefined,
): Promise<string> {
  const read = await readBodyIdle(res, record, VIDEO_PROXY_ENVELOPE_BODY_CAP);
  if (read.overCap) {
    throw new Error(
      `Upstream envelope body exceeded ${VIDEO_PROXY_ENVELOPE_BODY_CAP} bytes (read aborted at ${read.bytesRead})`,
    );
  }
  return read.buf.toString("utf8");
}
