/**
 * Comparison normalization, versioned so rule changes are visible on diffs.
 * norm-v1: NFKD, strip diacritics, uppercase, collapse punctuation/space.
 */
export const RULE_VERSION = "norm-v1";

export function normalizeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return v === "" ? null : v;
}

export function equalNormalized(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeText(a) === normalizeText(b);
}
