/**
 * Export and display safety helpers.
 * - Neutralize spreadsheet formula injection (values starting with =, +, -, @, tab, CR).
 * - Mask anything resembling a payment account number so it never reaches logs/exports.
 */

export function csvSafe(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const v = String(value);
  if (/^[\t\r ]*[=+\-@]/.test(v)) {
    return "'" + v;
  }
  return v;
}

export function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ACCOUNTISH = /\b(?:IBAN|RIB|BIC|SWIFT|account|iban)[:# ]*[A-Z0-9 ]{8,34}\b/i;
const LONG_DIGITS = /\b\d{11,34}\b/;

/** Remove account-like sequences from free text before persisting/logging. */
export function maskSensitive(text: string | null | undefined): string {
  if (!text) return "";
  return String(text)
    .replace(ACCOUNTISH, "[redacted-account-ref]")
    .replace(LONG_DIGITS, (m) => "[redacted-" + m.length + "-digits]");
}

export function toCsvCell(v: string): string {
  const s = csvSafe(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
