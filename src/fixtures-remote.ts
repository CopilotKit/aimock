import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import type { Logger } from "./logger.js";

export const REMOTE_FETCH_TIMEOUT_MS = 10_000;
export const REMOTE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export interface RemoteResolveOptions {
  validateOnLoad: boolean;
  logger: Logger;
  /** Override fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Override cache root (tests). */
  cacheRoot?: string;
  /** Override timeout (tests). */
  timeoutMs?: number;
  /** Override max response size (tests). */
  maxBytes?: number;
}

export interface ResolvedLocalFixture {
  /** Original value as passed on the CLI (for logging). */
  source: string;
  /** Filesystem path — downstream code treats this identically to a --fixtures path. */
  path: string;
}

/**
 * Returns true if `value` looks like a URL (has a scheme followed by ://).
 * Path inputs like ./fixtures or /tmp/x never start with a scheme.
 */
export function looksLikeUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

/**
 * Returns the default on-disk cache root for fetched fixtures.
 * Honors $XDG_CACHE_HOME when set, otherwise falls back to ~/.cache.
 */
export function defaultCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
  return join(base, "aimock", "fixtures");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Resolve a single --fixtures value to a local filesystem path.
 *
 * Behavior:
 * - Filesystem path → return as-is.
 * - https://, http:// URL → fetch JSON (once) to the on-disk cache; return the cached path.
 *   On fetch failure, fall back to a pre-existing cached copy if present (warn + continue).
 *   If --validate-on-load is set and no cache is usable, throws.
 * - Any other scheme (file://, ftp://, ...) → throws.
 */
export async function resolveFixturesValue(
  value: string,
  opts: RemoteResolveOptions,
): Promise<ResolvedLocalFixture> {
  if (!looksLikeUrl(value)) {
    return { source: value, path: pathResolve(value) };
  }

  const lower = value.toLowerCase();
  if (!lower.startsWith("https://") && !lower.startsWith("http://")) {
    // Extract the scheme for a clearer error
    const match = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
    const scheme = match ? match[1] : "unknown";
    throw new Error(
      `Unsupported --fixtures URL scheme "${scheme}" in ${value} (only https:// and http:// are supported)`,
    );
  }

  return await resolveHttpFixture(value, opts);
}

async function resolveHttpFixture(
  url: string,
  opts: RemoteResolveOptions,
): Promise<ResolvedLocalFixture> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const timeoutMs = opts.timeoutMs ?? REMOTE_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? REMOTE_MAX_BYTES;

  const digest = sha256Hex(url);
  const cacheDir = join(cacheRoot, digest);
  const cacheFile = join(cacheDir, "fixtures.json");

  try {
    const body = await fetchWithLimits(url, fetchImpl, timeoutMs, maxBytes);
    // Parse to verify it is valid JSON before caching — fail loud if not.
    JSON.parse(body);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, body, "utf-8");
    opts.logger.info(`Fetched ${url} (${body.length} bytes) → cached at ${cacheFile}`);
    return { source: url, path: cacheFile };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cacheExists = cacheFileExists(cacheFile);
    if (cacheExists) {
      opts.logger.warn(
        `upstream fetch failed for ${url} (${msg}); using cached copy at ${cacheFile}`,
      );
      return { source: url, path: cacheFile };
    }
    if (opts.validateOnLoad) {
      throw new Error(`Failed to fetch ${url} and no cached copy available: ${msg}`);
    }
    opts.logger.warn(
      `upstream fetch failed for ${url} (${msg}); no cached copy available — skipping`,
    );
    // Signal "no path" by returning a sentinel with empty path — callers detect and skip.
    return { source: url, path: "" };
  }
}

function cacheFileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

async function fetchWithLimits(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    // Early reject on over-large Content-Length when the server reports it.
    const len = res.headers.get("content-length");
    if (len) {
      const n = Number(len);
      if (Number.isFinite(n) && n > maxBytes) {
        throw new Error(`response too large: content-length ${n} exceeds limit ${maxBytes} bytes`);
      }
    }

    // Stream and enforce the limit incrementally in case Content-Length is absent/lying.
    if (!res.body) {
      const text = await res.text();
      if (Buffer.byteLength(text, "utf-8") > maxBytes) {
        throw new Error(`response too large: body exceeds limit ${maxBytes} bytes`);
      }
      return text;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // ignore cancel errors
          }
          throw new Error(`response too large: body exceeds limit ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("utf-8");
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.message === "timeout")) {
      throw new Error(`fetch timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
