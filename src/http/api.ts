import type { Router, Ctx } from "./server.ts";
import { sendJson } from "./server.ts";
import { createSession, requireRole, assertCanWrite } from "../auth.ts";
import { runImport, preview, allowedFields, type ImportKind } from "../services/importService.ts";
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

  r.get("/v1/invoices", (ctx: Ctx) => {
    const status = ctx.query.get("status");
    const rows = status
      ? ctx.db.prepare("SELECT * FROM invoices WHERE tenant_id = ? AND status = ? ORDER BY created_at").all(ctx.actor!.tenantId, status)
      : ctx.db.prepare("SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at").all(ctx.actor!.tenantId);
    sendJson(ctx.res, 200, { invoices: rows });
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
