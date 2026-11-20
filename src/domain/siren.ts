/**
 * SIREN: nine-digit French legal entity identifier.
 * Normalization preserves leading zeros; validation applies the Luhn checksum.
 */

export function normalizeSiren(raw: string): string | null {
  const digits = String(raw).replace(/[\s.\-]/g, "");
  if (!/^\d{9}$/.test(digits)) return null;
  return digits;
}

export function isValidSiren(raw: string): boolean {
  const n = normalizeSiren(raw);
  if (n === null) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = n.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Compute the Luhn check digit for an 8-digit base (used to build fixture SIRENs). */
export function luhnCheckDigit(base8: string): number {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let d = base8.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}
