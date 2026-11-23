/**
 * Vitest setup: the agent run must stay on this machine. Any `fetch` to a host
 * other than loopback fails the request and is printed, so a hidden call to a
 * real model provider or a telemetry endpoint cannot pass unnoticed.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;

globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOOPBACK.has(url.hostname)) {
    console.log(`EXTERNAL_FETCH_BLOCKED ${url.origin}`);
    return Promise.reject(new Error(`external network call blocked: ${url.origin}`));
  }
  return realFetch(input, init);
};
