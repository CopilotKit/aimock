/**
 * Resolve an upstream URL by joining a base URL with a request pathname.
 *
 * Uses RFC 3986 relative resolution: the base URL's path prefix is preserved
 * by ensuring a trailing slash (marking it as a "directory") and stripping the
 * leading slash from the pathname (making it relative, not absolute).
 *
 * Without this, `new URL("/v1/chat/completions", "https://openrouter.ai/api")`
 * resolves to `https://openrouter.ai/v1/chat/completions` — losing the `/api` prefix.
 */
export function resolveUpstreamUrl(base: string, pathname: string): URL {
  const normalizedBase = base.endsWith("/") ? base : base + "/";
  const relativePath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return new URL(relativePath, normalizedBase);
}
