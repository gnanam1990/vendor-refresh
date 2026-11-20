import type { Router, Ctx } from "./server.ts";
import { sendJson } from "./server.ts";
import { createSession, requireRole, assertCanWrite } from "../auth.ts";
import { runImport, preview, allowedFields, type ImportKind } from "../services/importService.ts";
import { scanFreshness, openCaseList } from "../services/scan.ts";
import { createRefresh } from "../services/refreshService.ts";
import { decide } from "../services/decisionService.ts";
import { createException } from "../services/exceptionService.ts";
import { acceptedExport, exportCsv, reconciliation, pilotReport } from "../services/exportService.ts";
import { badRequest, notFound } from "../domain/errors.ts";
import { newId } from "../db.ts";

function csvAndMapping(body: unknown): { csv: string; mapping: Record<string, string>; filename: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.csv !== "string" || b.csv.trim() === "") throw badRequest("missing_csv", "csv text is required");
  if (typeof b.mapping !== "object" || b.mapping === null) throw badRequest("missing_mapping", "explicit column mapping is required");
  return { csv: b.csv, mapping: b.mapping as Record<string, string>, filename: typeof b.filename === "string" ? b.filename : null };
}

export function registerApi(r: Router): void {
  // Local development login: pick a seeded user. No passwords in this build.
  r.post("/v1/session/dev-login", (ctx: Ctx) => {
    const userId = String((ctx.body as Record<string, unknown>).user_id ?? "");
    const token = createSession(ctx.db, userId);
    ctx.res.setHeader("set-cookie", `vr_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
    sendJson(ctx.res, 200, { ok: true, token });
  }, "optional");

  r.post("/v1/session/logout", (ctx: Ctx) => {
    ctx.res.setHeader("set-cookie", "vr_session=; Path=/; Max-Age=0");
    sendJson(ctx.res, 200, { ok: true });
  }, "optional");

  r.get("/v1/me", (ctx: Ctx) => {
    sendJson(ctx.res, 200, { actor: ctx.actor });
  });

  r.post("/v1/imports/preview", (ctx: Ctx) => {
    requireRole(ctx.actor!, "import");
    const b = ctx.body as Record<string, unknown>;
    const kind = b.kind as ImportKind;
    if (kind !== "vendor_master" && kind !== "invoice") throw badRequest("bad_kind", "kind must be vendor_master or invoice");
    const p = preview(kind, String(b.csv ?? ""));
    sendJson(ctx.res, 200, { ...p, allowedFields: allowedFields(kind) });
  });

  r.post("/v1/suppliers/import", (ctx: Ctx) => {
    assertCanWrite(ctx.actor!);
    requireRole(ctx.actor!, "import");
    const { csv, mapping, filename } = csvAndMapping(ctx.body);
    sendJson(ctx.res, 200, runImport(ctx.db, ctx.actor!, "vendor_master", filename, csv, mapping));
  });

  r.post("/v1/invoices/import", (ctx: Ctx) => {
    assertCanWrite(ctx.actor!);
    requireRole(ctx.actor!, "import");
    const { csv, mapping, filename } = csvAndMapping(ctx.body);
    sendJson(ctx.res, 200, runImport(ctx.db, ctx.actor!, "invoice", filename, csv, mapping));
  });

  r.get("/v1/suppliers", (ctx: Ctx) => {
    const rows = ctx.db
      .prepare(
        `SELECT id, siren, vendor_state, version, accepted_snapshot, accepted_at, created_at
         FROM suppliers WHERE tenant_id = ? ORDER BY created_at`
      )
      .all(ctx.actor!.tenantId) as Record<string, unknown>[];
    sendJson(ctx.res, 200, {
      suppliers: rows.map((s) => ({ ...s, accepted_snapshot: s.accepted_snapshot ? JSON.parse(String(s.accepted_snapshot)) : null })),
    });
  });

  r.get("/v1/suppliers/:id", (ctx: Ctx) => {
    const s = ctx.db
      .prepare("SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?")
      .get(ctx.params.id, ctx.actor!.tenantId) as Record<string, unknown> | undefined;
    if (!s) throw notFound("supplier not found");
    const invoices = ctx.db
      .prepare("SELECT id, external_ref, siren, issued_at, status, error_code, created_at FROM invoices WHERE supplier_id = ? AND tenant_id = ?")
      .all(s.id, ctx.actor!.tenantId);
    sendJson(ctx.res, 200, {
      supplier: { ...s, accepted_snapshot: s.accepted_snapshot ? JSON.parse(String(s.accepted_snapshot)) : null },
      invoices,
    });
  });

  r.post("/v1/scans", (ctx: Ctx) => {
    requireRole(ctx.actor!, "request_refresh");
    const at = (ctx.body as Record<string, unknown>)?.at as string | undefined;
    sendJson(ctx.res, 200, scanFreshness(ctx.db, ctx.actor!.tenantId, ctx.actor, at));
  });

  r.get("/v1/triggers", (ctx: Ctx) => {
    const rows = ctx.db
      .prepare(
        `SELECT t.*, s.siren, json_extract(s.accepted_snapshot,'$.legal_name') AS legal_name
         FROM triggers t JOIN suppliers s ON s.id = t.supplier_id
         WHERE t.tenant_id = ? ORDER BY t.created_at DESC`
      )
      .all(ctx.actor!.tenantId);
    sendJson(ctx.res, 200, { triggers: rows });
  });

  r.get("/v1/inbox", (ctx: Ctx) => {
    const kind = ctx.query.get("kind") ?? undefined;
    sendJson(ctx.res, 200, { cases: openCaseList(ctx.db, ctx.actor!.tenantId, kind) });
  });

  r.post("/v1/suppliers/:id/refreshes", (ctx: Ctx) => {
    requireRole(ctx.actor!, "request_refresh");
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const out = createRefresh(ctx.db, ctx.actor!, ctx.params.id, {
      reason: String(b.reason ?? ""),
      expectedVersion: Number(b.expected_version),
      key: b.key != null ? String(b.key) : null!,
      triggerId: b.trigger_id != null ? String(b.trigger_id) : undefined,
    });
    sendJson(ctx.res, out.deduplicated ? 200 : 201, out);
  });

  r.get("/v1/refreshes/:id", (ctx: Ctx) => {
    const refresh = ctx.db
      .prepare("SELECT * FROM refreshes WHERE id = ? AND tenant_id = ?")
      .get(ctx.params.id, ctx.actor!.tenantId) as Record<string, unknown> | undefined;
    if (!refresh) throw notFound("refresh not found");
    const diffs = ctx.db.prepare("SELECT * FROM diffs WHERE refresh_id = ? ORDER BY field").all(refresh.id) as Record<string, unknown>[];
    const intents = ctx.db.prepare("SELECT * FROM spend_intents WHERE refresh_id = ?").all(refresh.id);
    const quote = refresh.quote_id ? ctx.db.prepare("SELECT * FROM quotes WHERE id = ?").get(refresh.quote_id) : null;
    const snapshot = refresh.snapshot_id
      ? (ctx.db.prepare("SELECT id, source, retrieved_at, source_effective_at, terms, quarantined, quarantine_reason FROM snapshots WHERE id = ?").get(refresh.snapshot_id) as Record<string, unknown>)
      : null;
    sendJson(ctx.res, 200, {
      refresh,
      quote: quote ? { ...quote, metadata: JSON.parse(String((quote as any).metadata)) } : null,
      spendIntents: intents,
      diffs: diffs.map((d) => ({
        ...d,
        accepted_value: d.accepted_value ? JSON.parse(String(d.accepted_value)) : null,
        observed_value: d.observed_value ? JSON.parse(String(d.observed_value)) : null,
      })),
      snapshot: snapshot ? { ...snapshot, terms: JSON.parse(String(snapshot.terms)) } : null,
    });
  });

  r.post("/v1/refreshes/:id/decision", (ctx: Ctx) => {
    requireRole(ctx.actor!, "decide");
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const out = decide(ctx.db, ctx.actor!, ctx.params.id, {
      expectedVersion: Number(b.expected_version),
      decision: String(b.decision) as "accept" | "dismiss",
      reason: b.reason != null ? String(b.reason) : undefined,
    });
    sendJson(ctx.res, 200, out);
  });

  r.get("/v1/refreshes/:id/evidence", (ctx: Ctx) => {
    const refresh = ctx.db
      .prepare("SELECT snapshot_id FROM refreshes WHERE id = ? AND tenant_id = ?")
      .get(ctx.params.id, ctx.actor!.tenantId) as Record<string, unknown> | undefined;
    if (!refresh || !refresh.snapshot_id) throw notFound("no evidence for this refresh");
    const snap = ctx.db
      .prepare("SELECT * FROM snapshots WHERE id = ? AND tenant_id = ?")
      .get(refresh.snapshot_id, ctx.actor!.tenantId) as Record<string, unknown> | undefined;
    if (!snap) throw notFound("snapshot not found");
    // Redacted evidence preview: structure + field retention, payload summarized.
    const payload = JSON.parse(String(snap.payload)) as Record<string, unknown>;
    sendJson(ctx.res, 200, {
      snapshot: {
        id: snap.id,
        source: snap.source,
        snapshotHash: snap.snapshot_hash,
        retrievedAt: snap.retrieved_at,
        sourceEffectiveAt: snap.source_effective_at,
        quarantined: !!snap.quarantined,
        quarantineReason: snap.quarantine_reason,
        terms: JSON.parse(String(snap.terms)),
        payloadFields: Object.keys(payload),
      },
    });
  });

  r.get("/v1/invoices", (ctx: Ctx) => {
    const status = ctx.query.get("status");
    const rows = status
      ? ctx.db.prepare("SELECT * FROM invoices WHERE tenant_id = ? AND status = ? ORDER BY created_at").all(ctx.actor!.tenantId, status)
      : ctx.db.prepare("SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at").all(ctx.actor!.tenantId);
    sendJson(ctx.res, 200, { invoices: rows });
  });

  r.post("/v1/exceptions", (ctx: Ctx) => {
    requireRole(ctx.actor!, "refer_exception");
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const out = createException(ctx.db, ctx.actor!, {
      kind: String(b.kind ?? ""),
      supplierId: b.supplier_id != null ? String(b.supplier_id) : undefined,
      invoiceId: b.invoice_id != null ? String(b.invoice_id) : undefined,
      detail: String(b.detail ?? ""),
    });
    sendJson(ctx.res, 201, out);
  });

  r.get("/v1/exceptions", (ctx: Ctx) => {
    const rows = ctx.db
      .prepare("SELECT * FROM exceptions WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(ctx.actor!.tenantId);
    sendJson(ctx.res, 200, { exceptions: rows });
  });

  r.get("/v1/exports/accepted", (ctx: Ctx) => {
    requireRole(ctx.actor!, "export");
    const cursor = ctx.query.get("cursor");
    const out = acceptedExport(ctx.db, ctx.actor!.tenantId, cursor);
    if (ctx.query.get("format") === "csv") {
      ctx.res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=accepted-changes.csv",
      });
      ctx.res.end(exportCsv(out.rows));
      return;
    }
    sendJson(ctx.res, 200, out);
  });

  r.get("/v1/reconciliation", (ctx: Ctx) => {
    sendJson(ctx.res, 200, reconciliation(ctx.db, ctx.actor!.tenantId));
  });

  r.get("/v1/reports/pilot", (ctx: Ctx) => {
    sendJson(ctx.res, 200, pilotReport(ctx.db, ctx.actor!.tenantId));
  });

  r.get("/v1/imports/:id", (ctx: Ctx) => {
    const imp = ctx.db
      .prepare("SELECT * FROM imports WHERE id = ? AND tenant_id = ?")
      .get(ctx.params.id, ctx.actor!.tenantId) as Record<string, unknown> | undefined;
    if (!imp) throw notFound("import not found");
    const rows = ctx.db.prepare("SELECT row_index, raw, status, error_code, error_detail, supplier_id, invoice_id FROM import_rows WHERE import_id = ? ORDER BY row_index").all(imp.id);
    sendJson(ctx.res, 200, { import: imp, rows });
  });
}
