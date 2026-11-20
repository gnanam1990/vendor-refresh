/**
 * Minimal RFC-4180-ish CSV parser: quoted fields, embedded commas/newlines,
 * CRLF handling. Returns rows of string cells.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface CsvPreview {
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
}

export function previewCsv(text: string, sampleSize = 5): CsvPreview {
  const rows = parseCsv(text);
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const data = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  return {
    headers,
    sampleRows: data.slice(0, sampleSize),
    totalRows: data.length,
  };
}

export function rowsAsObjects(headers: string[], rows: string[][]): Record<string, string>[] {
  return rows.map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => {
      o[h] = r[i] ?? "";
    });
    return o;
  });
}
