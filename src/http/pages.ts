import type { Router, Ctx } from "./server.ts";
import { sendHtml, redirect, sendJson } from "./server.ts";
import { escapeHtml as h } from "../domain/redact.ts";
import { allowedFields, preview, runImport } from "../services/importService.ts";
import { createSession, requireRole, type Actor } from "../auth.ts";
import type { ProviderSet } from "../providers/index.ts";

export function layout(title: string, actor: Actor | null, body: string): string {
  const userLine = actor
    ? `<span>${h(actor.name)} · ${h(actor.role)}</span> <form method="post" action="/logout" style="display:inline"><button type="submit">Sign out</button></form>`
    : `<a href="/login">Sign in</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · Vendor Refresh</title>
<style>
:root { color-scheme: light; --ink:#1a1a1a; --line:#c8c8c8; --accent:#0b4da2; }
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; color: var(--ink); margin: 0; line-height: 1.45; }
a { color: var(--accent); }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 3px solid var(--accent); outline-offset: 2px;
}
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 8px; top: 8px; background: #fff; padding: 8px; z-index: 10; }
header { display: flex; gap: 16px; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--line); }
header nav { display: flex; gap: 12px; flex-wrap: wrap; }
header .who { margin-left: auto; font-size: .9em; }
main { padding: 20px; max-width: 1100px; }
.badge { display: inline-block; padding: 1px 8px; border: 1px solid var(--line); border-radius: 10px; font-size: .8em; }
.badge.stale { background: #fff4d6; }
.badge.conflict { background: #ffe0e0; }
.badge.unknown { background: #e6e6f0; }
.badge.ok, .badge.linked, .badge.settled, .badge.accepted, .badge.review_ready { background: #dff0d8; }
.badge.error, .badge.blocked, .badge.failed, .badge.reconciling { background: #f2dede; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #f4f4f4; }
fieldset { border: 1px solid var(--line); margin: 12px 0; padding: 12px; }
label { display: block; margin: 8px 0 2px; font-weight: 600; }
input[type=text], input[type=date], select, textarea { width: 100%; max-width: 640px; padding: 6px; font: inherit; }
button, .btn { padding: 8px 14px; font: inherit; cursor: pointer; }
.error-text { color: #a40000; }
.diff-changed { background: #fff4d6; }
.diff-unknown { background: #e6e6f0; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
@media (max-width: 480px) { main { padding: 12px; } th, td { padding: 4px 6px; } }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header>
  <strong><a href="/">Vendor Refresh</a></strong>
  <nav aria-label="Primary">
    <a href="/inbox">Inbox</a>
    <a href="/suppliers">Suppliers</a>
    <a href="/invoices">Invoices</a>
    <a href="/imports/new">Import</a>
    <a href="/exceptions">Exceptions</a>
    <a href="/reconciliation">Reconciliation</a>
    <a href="/exports">Exports</a>
  </nav>
  <div class="who">${userLine}</div>
</header>
<main id="main" tabindex="-1">
${body}
</main>
<div id="live" aria-live="polite" class="skip"></div>
</body>
</html>`;
}

export function registerPages(r: Router, _providers: ProviderSet): void {
  r.get("/login", (ctx: Ctx) => {
    const users = ctx.db.prepare("SELECT u.id, u.name, u.role, t.name AS tenant FROM users u JOIN tenants t ON t.id=u.tenant_id ORDER BY u.tenant_id, u.name").all() as Record<string, string>[];
    sendHtml(ctx.res, 200, layout("Sign in", ctx.actor, `
      <h1>Sign in (local development)</h1>
      <p>This build uses seeded local identities; pick the actor to act as. Roles are enforced server-side.</p>
      <form method="post" action="/login">
        <fieldset><legend>Choose an actor</legend>
        ${users.map((u) => `<label style="font-weight:400"><input type="radio" name="user_id" value="${h(u.id)}" required> ${h(u.name)} — ${h(u.role)} (${h(u.tenant)})</label>`).join("")}
        </fieldset>
        <button type="submit">Sign in</button>
      </form>`));
  }, "optional");

  r.post("/login", (ctx: Ctx) => {
    const userId = String((ctx.body as Record<string, unknown>).user_id ?? "");
    const token = createSession(ctx.db, userId);
    ctx.res.setHeader("set-cookie", `vr_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
    redirect(ctx.res, "/inbox");
  }, "optional");

  r.post("/logout", (ctx: Ctx) => {
    ctx.res.setHeader("set-cookie", "vr_session=; Path=/; Max-Age=0");
    redirect(ctx.res, "/login");
  }, "optional");

  r.get("/", (ctx: Ctx) => redirect(ctx.res, "/inbox"), "optional");

  r.get("/suppliers", (ctx: Ctx) => {
    const rows = ctx.db.prepare("SELECT * FROM suppliers WHERE tenant_id = ? ORDER BY created_at").all(ctx.actor!.tenantId) as Record<string, unknown>[];
    sendHtml(ctx.res, 200, layout("Suppliers", ctx.actor, `
      <h1>Suppliers</h1>
      <table><caption class="skip">Tenant suppliers</caption>
      <thead><tr><th scope="col">Legal name</th><th scope="col">SIREN</th><th scope="col">State</th><th scope="col">Version</th><th scope="col">Accepted at</th></tr></thead>
      <tbody>${rows.map((s) => {
        const snap = s.accepted_snapshot ? JSON.parse(String(s.accepted_snapshot)) : {};
        return `<tr><td><a href="/suppliers/${h(String(s.id))}">${h(snap.legal_name ?? "(unnamed)")}</a></td><td>${h(String(s.siren))}</td><td><span class="badge ${h(String(s.vendor_state))}">${h(String(s.vendor_state))}</span></td><td>${s.version}</td><td>${h(String(s.accepted_at ?? "—"))}</td></tr>`;
      }).join("")}</tbody></table>`));
  });

  r.get("/imports/new", (ctx: Ctx) => {
    requireRole(ctx.actor!, "import");
    sendHtml(ctx.res, 200, layout("Import", ctx.actor, `
      <h1>Import vendor master or invoice file</h1>
      <p>Only allowlisted fields are stored: paste CSV, preview, then map columns explicitly.</p>
      <form method="post" action="/imports/preview">
        <label for="kind">File kind</label>
        <select id="kind" name="kind">
          <option value="vendor_master">Vendor master</option>
          <option value="invoice">Invoices</option>
        </select>
        <label for="csv">CSV content</label>
        <textarea id="csv" name="csv" rows="8" required></textarea>
        <p><button type="submit">Preview</button></p>
      </form>`));
  });

  r.post("/imports/preview", (ctx: Ctx) => {
    requireRole(ctx.actor!, "import");
    const b = ctx.body as Record<string, string>;
    const kind = b.kind === "invoice" ? "invoice" : "vendor_master";
    const p = preview(kind, b.csv ?? "");
    const fields = allowedFields(kind);
    const required = kind === "vendor_master" ? ["siren", "legal_name"] : ["external_ref", "issued_at"];
    sendHtml(ctx.res, 200, layout("Import preview", ctx.actor, `
      <h1>Preview — ${h(kind)}</h1>
      <p>${p.totalRows} data rows found. Map each target field to a source column before importing.</p>
      <table><caption>Sample rows</caption>
      <thead><tr>${p.headers.map((x) => `<th scope="col">${h(x)}</th>`).join("")}</tr></thead>
      <tbody>${p.sampleRows.map((r2) => `<tr>${r2.map((c) => `<td>${h(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <form method="post" action="/imports/commit">
        <input type="hidden" name="kind" value="${h(kind)}">
        <input type="hidden" name="csv" value="${h(b.csv ?? "")}">
        <fieldset><legend>Column mapping (explicit, required)</legend>
        ${fields.map((f) => `
          <label for="map_${h(f)}">${h(f)}${required.includes(f) ? " (required)" : ""}</label>
          <select id="map_${h(f)}" name="map_${h(f)}" ${required.includes(f) ? "required" : ""}>
            <option value="">— not imported —</option>
            ${p.headers.map((col) => `<option value="${h(col)}" ${col.toLowerCase() === f ? "selected" : ""}>${h(col)}</option>`).join("")}
          </select>`).join("")}
        </fieldset>
        <button type="submit">Import ${p.totalRows} rows</button>
      </form>`));
  });

  r.post("/imports/commit", (ctx: Ctx) => {
    requireRole(ctx.actor!, "import");
    const b = ctx.body as Record<string, string>;
    const kind = b.kind === "invoice" ? "invoice" : "vendor_master";
    const mapping: Record<string, string> = {};
    for (const f of allowedFields(kind)) {
      const v = b[`map_${f}`];
      if (v) mapping[f] = v;
    }
    const result = runImport(ctx.db, ctx.actor!, kind, "web-upload.csv", b.csv ?? "", mapping);
    sendHtml(ctx.res, 200, layout("Import result", ctx.actor, `
      <h1>Import complete</h1>
      <p>Receipt <code>${h(result.importId)}</code>: ${result.rowsOk} ok, ${result.rowsFailed} failed of ${result.rowsTotal}.</p>
      <table><caption>Row results</caption>
      <thead><tr><th scope="col">Row</th><th scope="col">Status</th><th scope="col">Reason</th><th scope="col">Link</th></tr></thead>
      <tbody>${result.rows.map((row) => `<tr>
        <td>${row.rowIndex}</td>
        <td><span class="badge ${h(row.status)}">${h(row.status)}</span></td>
        <td>${h(row.errorCode ? `${row.errorCode}: ${row.errorDetail}` : (row.errorDetail ?? ""))}</td>
        <td>${row.supplierId ? `<a href="/suppliers/${h(row.supplierId)}">supplier</a>` : ""}</td>
      </tr>`).join("")}</tbody></table>
      <p><a href="/inbox">Back to inbox</a></p>`));
  });
}
