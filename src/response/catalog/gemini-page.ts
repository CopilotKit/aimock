export interface GeminiCatalogPage {
  ids: string[];
  nextPageToken?: string;
}

/** Offset tokens are canonical base64-encoded nonnegative integer offsets. */
export function geminiPage(
  ids: readonly string[],
  query: URLSearchParams,
): { page: GeminiCatalogPage; error?: never } | { error: string; page?: never } {
  const rawSize = query.get("pageSize");
  const size = rawSize === null ? 50 : Number(rawSize);
  if (rawSize !== null && (!/^\d+$/.test(rawSize) || !Number.isInteger(size) || size < 0))
    return { error: "pageSize must be a nonnegative integer" };
  const limit = Math.min(size || 50, 1000);
  const token = query.get("pageToken");
  let offset = 0;
  if (token !== null) {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    offset = Number(decoded);
    if (
      !/^\d+$/.test(decoded) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      Buffer.from(decoded).toString("base64") !== token
    )
      return { error: "pageToken must be a valid catalog offset token" };
  }
  const selected = ids.slice(offset, offset + limit);
  return {
    page: {
      ids: selected,
      ...(offset + selected.length < ids.length
        ? { nextPageToken: Buffer.from(String(offset + selected.length)).toString("base64") }
        : {}),
    },
  };
}
