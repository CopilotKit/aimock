/**
 * Provider out-of-credit vocabulary, shared by the drift harness (which detects
 * it on the real provider's wire and throws the marker below) and the drift
 * report collector (which recognizes ONLY that structured evidence). One list,
 * so the producer and the classifier cannot disagree about which codes mean
 * "top up credit".
 */

/**
 * OpenAI error `code` / `type` values that mean the account has no credit or
 * quota left. OpenAI names it with these in every place it reports it: an HTTP
 * 429 body, an in-band `error` / `response.failed` event, and a Realtime 1013
 * close reason (`insufficient_quota.credit_balance_exhausted`). Most specific
 * first: a Realtime close reason carries both, and the report names the first.
 */
export const PROVIDER_QUOTA_CODES: readonly string[] = [
  "credit_balance_exhausted",
  "insufficient_quota",
];

/** The fixed text every quota-exhausted leg reports. */
export const PROVIDER_QUOTA_EXHAUSTED = "provider quota exhausted — top up credit";

export function isProviderQuotaCode(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_QUOTA_CODES.includes(value);
}

/**
 * The quota code named by a WebSocket close reason, or null. A Realtime close
 * reason is a dotted pair (`insufficient_quota.credit_balance_exhausted`), so
 * the reason is split into its dot-separated tokens and matched exactly; the
 * most specific code wins.
 */
export function quotaCodeInCloseReason(reason: string): string | null {
  const tokens = reason.split(".").map((t) => t.trim());
  return PROVIDER_QUOTA_CODES.find((code) => tokens.includes(code)) ?? null;
}

/**
 * The marker a drift leg's InfraError carries when the provider said the
 * account is out of credit. The collector keys off this exact line, never off
 * a quota code appearing somewhere in free text.
 */
export function providerQuotaMarker(provider: string, code: string): string {
  return `INFRA_ERROR: ${provider} — ${PROVIDER_QUOTA_EXHAUSTED} (${code})`;
}

const MARKER_LINE = new RegExp(
  `^(?:InfraError: )?INFRA_ERROR: .+ — ${PROVIDER_QUOTA_EXHAUSTED} \\(([a-z_]+)\\)$`,
);

/**
 * The quota code from a failure whose FIRST line is the {@link providerQuotaMarker}
 * (optionally behind vitest's `InfraError: ` name prefix), or null. Anchoring to
 * the first line means an assertion that merely quotes the marker (`expected …
 * to throw …`) is never mistaken for it.
 */
export function parseProviderQuotaMarker(failureMessage: string): string | null {
  const firstLine = failureMessage.split("\n", 1)[0];
  const match = firstLine.match(MARKER_LINE);
  return match && isProviderQuotaCode(match[1]) ? match[1] : null;
}
