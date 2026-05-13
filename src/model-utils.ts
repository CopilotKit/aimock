const DATE_SUFFIX_RE = /[-](\d{8}(-v\d+([:.]\d+)*)?)$|[-]\d{4}-\d{2}-\d{2}$/;

export function normalizeModelName(
  model: string | undefined,
  skipNormalization?: boolean,
): string | undefined {
  if (!model || skipNormalization) return model;
  return model.replace(DATE_SUFFIX_RE, "");
}
