import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import type { Logger } from "./logger.js";

export const REMOTE_FETCH_TIMEOUT_MS = 10_000;
export const REMOTE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Private / reserved address ranges blocked by default to prevent SSRF.
 *
 * The list covers RFC1918 / CGNAT / loopback / link-local / cloud-metadata /
 * ULA / multicast / unspecified — any destination that could let an attacker
 * pivot a fetch into the local network or cloud control plane via a hostile
 * `--fixtures` URL.  Set `AIMOCK_ALLOW_PRIVATE_URLS=1` to opt out (required
 * for local dev / tests that target 127.0.0.1).
 */
const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local / cloud metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
  ["255.255.255.255", 32], // broadcast
];

const PRIVATE_V6_RANGES: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // ULA
  ["fe80::", 10], // link-local
];

function buildBlockList(): BlockList {
  const bl = new BlockList();
  for (const [addr, prefix] of PRIVATE_V4_RANGES) bl.addSubnet(addr, prefix, "ipv4");
  for (const [addr, prefix] of PRIVATE_V6_RANGES) bl.addSubnet(addr, prefix, "ipv6");
  return bl;
}

const PRIVATE_BLOCKLIST: BlockList = buildBlockList();

/**
 * Returns true if `address` is a literal IP (v4 or v6) that falls in any
 * blocked range (loopback, RFC1918, CGNAT, link-local, cloud-metadata,
 * ULA, multicast, unspecified, reserved).  Returns false for public IPs
 * and for non-literal hostnames.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false; // not a literal IP
  // BlockList.check's "ipv6" bucket does not match v4-mapped ::ffff:a.b.c.d
  // automatically — unwrap to the underlying v4 address and recurse.
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
  }
  return PRIVATE_BLOCKLIST.check(address, family === 4 ? "ipv4" : "ipv6");
}

function privateUrlsAllowed(): boolean {
  const v = process.env.AIMOCK_ALLOW_PRIVATE_URLS;
  return v === "1" || v === "true";
}

/**
 * Throws if `hostname` resolves to (or literally is) a private / reserved
 * address, unless `AIMOCK_ALLOW_PRIVATE_URLS=1` is set.  If the hostname is
 * not a literal IP, all resolved addresses are checked — any blocked
 * address in the set rejects the host.
 */
export async function assertAllowedHost(hostname: string): Promise<void> {
  if (privateUrlsAllowed()) return;

  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new Error(
        `Refusing to fetch from private address ${hostname}: not allowed by default (set AIMOCK_ALLOW_PRIVATE_URLS=1 to override)`,
      );
    }
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch (err) {
    // DNS failure is not an SSRF signal — let the fetch itself surface the
    // resolution error with its own (more detailed) message.
    void err;
    return;
  }
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) {
      throw new Error(
        `Refusing to fetch from ${hostname}: resolves to private address ${a.address} (set AIMOCK_ALLOW_PRIVATE_URLS=1 to override)`,
      );
    }
  }
}

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
    // SSRF defense: reject private / reserved destinations before any network
    // I/O, unless explicitly opted in via AIMOCK_ALLOW_PRIVATE_URLS=1.
    const parsed = new URL(url);
    await assertAllowedHost(parsed.hostname);

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
    // Redirects are disabled: following a 3xx into a different scheme or host
    // would bypass the scheme check and SSRF denylist.  Upstream services
    // should serve the final URL directly (e.g. GitHub raw content URLs).
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "<none>";
      throw new Error(
        `redirect not allowed: upstream returned ${res.status} → ${location} (configure the upstream to serve the final URL directly; redirects are disabled to prevent scheme-bypass)`,
      );
    }
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
