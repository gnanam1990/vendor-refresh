import type { DB } from "../db.ts";
import { newId, now, tx } from "../db.ts";
import { parseCsv, previewCsv, rowsAsObjects, type CsvPreview } from "../domain/csv.ts";
import { isValidSiren, normalizeSiren } from "../domain/siren.ts";
import { badRequest } from "../domain/errors.ts";
import { maskSensitive } from "../domain/redact.ts";
import { audit } from "./audit.ts";
import type { Actor } from "../auth.ts";

/**
 * Allowlisted vendor-master fields. Only these may be mapped and persisted;
 * anything else in an uploaded file is discarded before storage.
 */
export const VENDOR_FIELDS = [
  "siren",
  "legal_name",
  "vendor_ref",
  "address_line1",
  "address_line2",
  "postal_code",
  "city",
  "country",
] as const;

/** Invoice import uses only vendor reference, issue date and company identity. */
export const INVOICE_FIELDS = ["external_ref", "siren", "vendor_ref", "issued_at"] as const;

export type ImportKind = "vendor_master" | "invoice";

export function preview(kind: ImportKind, csvText: string): CsvPreview {
  if (csvText.length > 5_000_000) throw badRequest("payload_too_large", "CSV exceeds 5MB");
  return previewCsv(csvText);
}

export function allowedFields(kind: ImportKind): readonly string[] {
  return kind === "vendor_master" ? VENDOR_FIELDS : INVOICE_FIELDS;
}

export interface ImportResult {
  importId: string;
  rowsTotal: number;
  rowsOk: number;
  rowsFailed: number;
  rows: {
    rowIndex: number;
    status: string;
    errorCode: string | null;
    errorDetail: string | null;
    supplierId: string | null;
    invoiceId: string | null;
  }[];
}

function validateMapping(kind: ImportKind, mapping: Record<string, string>): void {
  const fields = allowedFields(kind);
  for (const [field, col] of Object.entries(mapping)) {
    if (!fields.includes(field as never)) {
      throw badRequest("field_not_allowed", `field '${field}' is not importable for ${kind}`);
    }
    if (typeof col !== "string" || col.trim() === "") {
      throw badRequest("bad_mapping", `mapping for '${field}' must name a source column`);
    }
  }
  const required = kind === "vendor_master" ? ["siren", "legal_name"] : ["external_ref", "issued_at"];
  for (const r of required) {
    if (!mapping[r]) throw badRequest("mapping_missing", `mapping requires '${r}'`);
  }
}

export function runImport(
  db: DB,
  actor: Actor,
  kind: ImportKind,
  filename: string | null,
  csvText: string,
  mapping: Record<string, string>
): ImportResult {
  validateMapping(kind, mapping);
  const parsed = parseCsv(csvText);
  const headers = (parsed[0] ?? []).map((h) => h.trim());
  if (headers.length === 0) throw badRequest("empty_csv", "no header row");
  const dataRows = rowsAsObjects(headers, parsed.slice(1).filter((r) => r.some((c) => c.trim() !== "")));
  for (const col of Object.values(mapping)) {
    if (!headers.includes(col)) throw badRequest("column_missing", `mapped column '${col}' not in file`);
  }

  return tx(db, () => {
    const importId = newId("imp");
    const ts = now();
    db.prepare(
      `INSERT INTO imports (id, tenant_id, kind, filename, mapping, rows_total, actor_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(importId, actor.tenantId, kind, filename, JSON.stringify(mapping), dataRows.length, actor.id, ts);

    const results: ImportResult["rows"] = [];
    let ok = 0;
    let failed = 0;

    dataRows.forEach((rawRow, i) => {
      // Persist only mapped, allowlisted values.
      const permitted: Record<string, string> = {};
      for (const [field, col] of Object.entries(mapping)) permitted[field] = rawRow[col] ?? "";
      const rawJson = maskSensitive(JSON.stringify(permitted));

      let status = "ok";
      let errorCode: string | null = null;
      let errorDetail: string | null = null;
      let supplierId: string | null = null;
      let invoiceId: string | null = null;

      if (kind === "vendor_master") {
        const out = upsertVendorRow(db, actor, permitted);
        status = out.status;
        errorCode = out.errorCode;
        errorDetail = out.errorDetail;
        supplierId = out.supplierId;
      } else {
        const out = linkInvoiceRow(db, actor, permitted, importId);
        status = out.status;
        errorCode = out.errorCode;
        errorDetail = out.errorDetail;
        supplierId = out.supplierId;
        invoiceId = out.invoiceId;
      }

      if (status === "error") failed++;
      else ok++;
      const rowId = newId("row");
      db.prepare(
        `INSERT INTO import_rows (id, import_id, tenant_id, row_index, raw, status, error_code, error_detail, supplier_id, invoice_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(rowId, importId, actor.tenantId, i + 1, rawJson, status, errorCode, errorDetail, supplierId, invoiceId);
      results.push({ rowIndex: i + 1, status, errorCode, errorDetail, supplierId, invoiceId });
    });

    db.prepare("UPDATE imports SET rows_ok = ?, rows_failed = ? WHERE id = ?").run(ok, failed, importId);
    audit(db, actor, actor.tenantId, "import.completed", "import", importId, {
      kind,
      rowsTotal: dataRows.length,
      rowsOk: ok,
      rowsFailed: failed,
    });
    return { importId, rowsTotal: dataRows.length, rowsOk: ok, rowsFailed: failed, rows: results };
  });
}

interface RowOutcome {
  status: string;
  errorCode: string | null;
  errorDetail: string | null;
  supplierId: string | null;
  invoiceId: string | null;
}

function upsertVendorRow(db: DB, actor: Actor, v: Record<string, string>): RowOutcome {
  const rawSiren = (v.siren ?? "").trim();
  if (rawSiren === "") {
    return {
      status: "error",
      errorCode: "missing_siren",
      errorDetail: "row has no SIREN; name-only rows cannot create suppliers",
      supplierId: null,
      invoiceId: null,
    };
  }
  const siren = normalizeSiren(rawSiren);
  if (siren === null) {
    return {
      status: "error",
      errorCode: "invalid_siren",
      errorDetail: "SIREN must be nine digits",
      supplierId: null,
      invoiceId: null,
    };
  }
  if (!isValidSiren(siren)) {
    return {
      status: "error",
      errorCode: "invalid_siren_checksum",
      errorDetail: "SIREN fails the Luhn checksum; check the mapped column",
      supplierId: null,
      invoiceId: null,
    };
  }
  const name = (v.legal_name ?? "").trim();
  if (name === "") {
    return {
      status: "error",
      errorCode: "missing_legal_name",
      errorDetail: "legal_name is required",
      supplierId: null,
      invoiceId: null,
    };
  }

  const existing = db
    .prepare("SELECT id FROM suppliers WHERE tenant_id = ? AND siren = ?")
    .get(actor.tenantId, siren) as { id: string } | undefined;
  if (existing) {
    return { status: "duplicate", errorCode: null, errorDetail: "matched existing tenant supplier", supplierId: existing.id, invoiceId: null };
  }

  const id = newId("sup");
  const ts = now();
  const snapshot = {
    legal_name: name,
    status: (v.status ?? "") || null,
    address: {
      line1: v.address_line1 || null,
      line2: v.address_line2 || null,
      postal_code: v.postal_code || null,
      city: v.city || null,
      country: v.country || "FR",
    },
    source: "vendor_master_import",
    captured_at: ts,
    vendor_ref: v.vendor_ref || null,
  };
  db.prepare(
    `INSERT INTO suppliers (id, tenant_id, siren, vendor_state, version, accepted_snapshot, accepted_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, actor.tenantId, siren, "unverified", 1, JSON.stringify(snapshot), ts, ts, ts);
  audit(db, actor, actor.tenantId, "supplier.created", "supplier", id, { siren });
  return { status: "ok", errorCode: null, errorDetail: null, supplierId: id, invoiceId: null };
}

function linkInvoiceRow(db: DB, actor: Actor, v: Record<string, string>, importId: string): RowOutcome {
  const ext = (v.external_ref ?? "").trim();
  const issuedAt = (v.issued_at ?? "").trim();
  if (ext === "") {
    return { status: "error", errorCode: "missing_external_ref", errorDetail: "invoice reference required", supplierId: null, invoiceId: null };
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(issuedAt)) {
    return { status: "error", errorCode: "bad_issue_date", errorDetail: "issued_at must be an ISO date", supplierId: null, invoiceId: null };
  }

  const rawSiren = (v.siren ?? "").trim();
  // Identity resolution is by verified SIREN only; a name or vendor_ref alone
  // can never link an invoice (INV-01, ambiguous matches are refused).
  let supplierId: string | null = null;
  let status = "unlinked";
  let errorCode: string | null = null;
  let errorDetail: string | null = null;
  let siren: string | null = null;

  if (rawSiren === "") {
    errorCode = "no_verified_siren";
    errorDetail = "invoice carries no SIREN; name-only identity is refused";
  } else {
    siren = normalizeSiren(rawSiren);
    if (siren === null || !isValidSiren(siren)) {
      status = "error";
      errorCode = "invalid_siren";
      errorDetail = "invoice SIREN is not a valid nine-digit identifier";
    } else {
      const matches = db
        .prepare("SELECT id FROM suppliers WHERE tenant_id = ? AND siren = ?")
        .all(actor.tenantId, siren) as { id: string }[];
      if (matches.length === 0) {
        errorCode = "unknown_supplier";
        errorDetail = "no tenant supplier with this verified SIREN";
      } else if (matches.length > 1) {
        status = "error";
        errorCode = "ambiguous_match";
        errorDetail = "multiple suppliers match; invoice cannot be linked";
      } else {
        supplierId = matches[0].id;
        status = "linked";
      }
    }
  }

  const id = newId("inv");
  db.prepare(
    `INSERT INTO invoices (id, tenant_id, external_ref, supplier_id, siren, issued_at, raw, status, error_code, import_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    actor.tenantId,
    ext,
    supplierId,
    siren,
    issuedAt,
    maskSensitive(JSON.stringify(v)),
    status,
    errorCode,
    importId,
    now()
  );
  if (status === "error") return { status, errorCode, errorDetail, supplierId: null, invoiceId: id };
  if (errorCode) {
    return { status: "error", errorCode, errorDetail, supplierId: null, invoiceId: id };
  }
  return { status: "ok", errorCode: null, errorDetail: null, supplierId, invoiceId: id };
}
