export interface AnthropicCatalogPage {
  ids: string[];
  hasMore: boolean;
  firstId: string | null;
  lastId: string | null;
}

/** Cursor paging and lifecycle filtering for the native Anthropic catalog. */
export function anthropicPage(
  ids: readonly string[],
  query: URLSearchParams,
): { page: AnthropicCatalogPage; error?: never } | { error: string; page?: never } {
  const rawLimit = query.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (
    rawLimit !== null &&
    (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 1000)
  )
    return { error: "limit must be an integer between 1 and 1000" };
  const lifecycle = [...new Set([...query.getAll("lifecycle"), ...query.getAll("lifecycle[]")])];
  if (
    lifecycle.length > 3 ||
    lifecycle.some((value) => !["active", "deprecated", "retired"].includes(value))
  )
    return { error: "lifecycle must contain active, deprecated, or retired" };
  const empty = (): AnthropicCatalogPage => ({
    ids: [],
    hasMore: false,
    firstId: null,
    lastId: null,
  });
  const after = query.get("after_id");
  const before = query.get("before_id");
  const afterIndex = after === null ? -1 : ids.indexOf(after);
  const beforeIndex = before === null ? ids.length : ids.indexOf(before);
  if (after !== null && afterIndex === -1) return { error: `Model with id ${after} not found` };
  if (before !== null && beforeIndex === -1) return { error: `Model with id ${before} not found` };
  if (lifecycle.length > 0 && !lifecycle.includes("active")) return { page: empty() };
  const available = ids.slice(afterIndex + 1, beforeIndex);
  // The SDK continues backward whenever before_id is present, retaining after_id.
  const selected = before !== null ? available.slice(-limit) : available.slice(0, limit);
  return {
    page: {
      ids: selected,
      hasMore: available.length > selected.length,
      firstId: selected[0] ?? null,
      lastId: selected.at(-1) ?? null,
    },
  };
}
