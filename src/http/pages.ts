import type { Router, Ctx } from "./server.ts";
import { sendHtml, redirect, sendJson } from "./server.ts";
import { escapeHtml as h } from "../domain/redact.ts";
import { allowedFields, preview, runImport } from "../services/importService.ts";
import { createSession, requireRole, type Actor } from "../auth.ts";
import { openCaseList, scanFreshness } from "../services/scan.ts";
import { createRefresh } from "../services/refreshService.ts";
import { decide } from "../services/decisionService.ts";
import { createException } from "../services/exceptionService.ts";
import { activePolicy } from "../services/policy.ts";
import { notFound } from "../domain/errors.ts";
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

  r.get("/inbox", (ctx: Ctx) => {
    const kind = ctx.query.get("kind") ?? "";
    const cases = openCaseList(ctx.db, ctx.actor!.tenantId, kind || undefined);
    const filterLink = (k: string, label: string) =>
      `<a class="btn" href="/inbox${k ? `?kind=${k}` : ""}"${kind === k ? ' aria-current="true"' : ""}>${label}</a>`;
    sendHtml(ctx.res, 200, layout("Inbox", ctx.actor, `
      <h1>Work inbox</h1>
      <p>${filterLink("", "All")} ${filterLink("stale", "Stale")} ${filterLink("conflict", "Conflict")} ${filterLink("unknown", "Unknown")}</p>
      ${cases.length === 0 ? "<p>No open cases.</p>" : ""}
      <table><caption class="skip">Cases requiring attention</caption>
      <thead><tr><th scope="col">Kind</th><th scope="col">Supplier</th><th scope="col">SIREN</th><th scope="col">Reason</th><th scope="col">Action</th></tr></thead>
      <tbody>${cases.map((c: any) => `<tr>
        <td><span class="badge ${h(c.kind)}">${h(c.kind)}</span></td>
        <td><a href="/suppliers/${h(c.supplier_id)}">${h(c.legal_name ?? "(unnamed)")}</a></td>
        <td>${h(c.siren)}</td>
        <td>${h(c.reason ?? `${c.field}: ${c.accepted_value ?? "—"} → ${c.observed_value ?? "unknown"}`)}</td>
        <td>${c.refresh_id ? `<a class="btn" href="/refreshes/${h(c.refresh_id)}">Review</a>` : `<a class="btn" href="/suppliers/${h(c.supplier_id)}#refresh">Open</a>`}</td>
      </tr>`).join("")}</tbody></table>
      <form method="post" action="/scan"><button type="submit">Run freshness scan</button></form>`));
  });

  r.post("/scan", (ctx: Ctx) => {
    requireRole(ctx.actor!, "request_refresh");
    scanFreshness(ctx.db, ctx.actor!.tenantId, ctx.actor);
    redirect(ctx.res, "/inbox");
  });

  r.get("/suppliers/:id", (ctx: Ctx) => {
    const s = ctx.db.prepare("SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?").get(ctx.params.id, ctx.actor!.tenantId) as any;
    if (!s) throw notFound("supplier not found");
    const snap = s.accepted_snapshot ? JSON.parse(s.accepted_snapshot) : {};
    const refreshes = ctx.db.prepare("SELECT id, state, reason, created_at FROM refreshes WHERE supplier_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 10").all(s.id, ctx.actor!.tenantId) as any[];
    const triggers = ctx.db.prepare("SELECT id, kind, reason, state FROM triggers WHERE supplier_id = ? AND tenant_id = ? AND state = 'open'").all(s.id, ctx.actor!.tenantId) as any[];
    const canRequest = ctx.actor!.role === "ap_analyst" && s.vendor_state !== "archived";
    const address = snap.address_text ?? [snap.address?.line1, snap.address?.line2, snap.address?.postal_code, snap.address?.city, snap.address?.country].filter(Boolean).join(", ");
    sendHtml(ctx.res, 200, layout("Supplier", ctx.actor, `
      <h1>${h(snap.legal_name ?? "(unnamed)")}</h1>
      <p>SIREN <code>${h(s.siren)}</code> · state <span class="badge ${h(s.vendor_state)}">${h(s.vendor_state)}</span> · accepted version ${s.version} · accepted at ${h(s.accepted_at ?? "—")}</p>
      <section aria-labelledby="accepted"><h2 id="accepted">Accepted evidence</h2>
      <table><tbody>
        <tr><th scope="row">Legal name</th><td>${h(snap.legal_name ?? "—")}</td></tr>
        <tr><th scope="row">Status</th><td>${h(snap.status ?? "—")}</td></tr>
        <tr><th scope="row">Registered address</th><td>${h(address || "—")}</td></tr>
        <tr><th scope="row">Source</th><td>${h(snap.source ?? "—")} · captured ${h(snap.captured_at ?? "—")}</td></tr>
      </tbody></table></section>
      ${triggers.length ? `<section aria-labelledby="trig"><h2 id="trig">Open cases</h2><ul>${triggers.map((t: any) => `<li><span class="badge ${h(t.kind)}">${h(t.kind)}</span> ${h(t.reason)}</li>`).join("")}</ul></section>` : ""}
      ${canRequest ? `<section aria-labelledby="refresh"><h2 id="refresh">Request refresh</h2>
      <form method="post" action="/suppliers/${h(s.id)}/refreshes">
        <p>Current version <strong>${s.version}</strong>; the refresh must name this version to proceed.</p>
        <input type="hidden" name="expected_version" value="${s.version}">
        <input type="hidden" name="key" value="web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}">
        ${triggers[0] ? `<input type="hidden" name="trigger_id" value="${h(triggers[0].id)}">` : ""}
        <label for="reason">Reason</label>
        <input type="text" id="reason" name="reason" required value="${triggers[0] ? h(triggers[0].reason) : ""}">
        <p><button type="submit">Request paid refresh</button></p>
      </form></section>` : ""}
      <section aria-labelledby="recent"><h2 id="recent">Recent refreshes</h2>
      <ul>${refreshes.map((f: any) => `<li><a href="/refreshes/${h(f.id)}"><code>${h(f.id)}</code></a> — <span class="badge ${h(f.state)}">${h(f.state)}</span> ${h(f.reason)}</li>`).join("") || "<li>none</li>"}</ul></section>`));
  });

  r.post("/suppliers/:id/refreshes", (ctx: Ctx) => {
    requireRole(ctx.actor!, "request_refresh");
    const b = ctx.body as Record<string, string>;
    const out = createRefresh(ctx.db, ctx.actor!, ctx.params.id, {
      reason: b.reason ?? "",
      expectedVersion: Number(b.expected_version),
      key: b.key,
      triggerId: b.trigger_id || undefined,
    });
    redirect(ctx.res, `/refreshes/${out.refresh.id}`);
  });

  r.get("/refreshes/:id", (ctx: Ctx) => {
    const f = ctx.db.prepare("SELECT * FROM refreshes WHERE id = ? AND tenant_id = ?").get(ctx.params.id, ctx.actor!.tenantId) as any;
    if (!f) throw notFound("refresh not found");
    const s = ctx.db.prepare("SELECT * FROM suppliers WHERE id = ?").get(f.supplier_id) as any;
    const snap = s.accepted_snapshot ? JSON.parse(s.accepted_snapshot) : {};
    const diffs = ctx.db.prepare("SELECT * FROM diffs WHERE refresh_id = ? ORDER BY field").all(f.id) as any[];
    const intents = ctx.db.prepare("SELECT * FROM spend_intents WHERE refresh_id = ?").all(f.id) as any[];
    const quote = f.quote_id ? ctx.db.prepare("SELECT * FROM quotes WHERE id = ?").get(f.quote_id) as any : null;
    const policy = activePolicy(ctx.db, ctx.actor!.tenantId);
    const canDecide = ctx.actor!.role === "ap_approver" && f.state === "review_ready";
    sendHtml(ctx.res, 200, layout(`Refresh ${f.id}`, ctx.actor, `
      <h1>Refresh case</h1>
      <p><a href="/suppliers/${h(s.id)}">${h(snap.legal_name ?? s.siren)}</a> · state <span class="badge ${h(f.state)}">${h(f.state)}</span>
      ${f.block_reason ? ` · <span class="error-text">${h(f.block_reason)}</span>` : ""}</p>
      <section aria-labelledby="cost"><h2 id="cost">Purchase state</h2>
      <table><tbody>
        <tr><th scope="row">Quoted max</th><td>${quote ? `${quote.amount_minor} ${quote.currency} (listing ${h(quote.listing_id)})` : "not quoted yet"}</td></tr>
        <tr><th scope="row">Policy caps</th><td>${policy.perCallMaxMinor} ${policy.currency} per call · ${policy.cumulativeCapMinor} ${policy.currency} total (policy v${policy.version})</td></tr>
        ${intents.map((i: any) => `<tr><th scope="row">Spend intent</th><td>${i.amount_minor} ${i.currency} — <span class="badge ${h(i.status)}">${h(i.status)}</span>${i.remote_ref ? ` · ref <code>${h(i.remote_ref)}</code>` : " · pending merchant ref"}${i.status === "reconciling" ? " · <strong>uncertain charge — manual reconciliation required</strong>" : ""}</td></tr>`).join("")}
      </tbody></table></section>
      <section aria-labelledby="diffs"><h2 id="diffs">Field differences</h2>
      ${diffs.length === 0 ? "<p>No diffs yet — evidence not fetched.</p>" : `
      <table><thead><tr><th scope="col">Field</th><th scope="col">Accepted</th><th scope="col">Observed</th><th scope="col">Outcome</th><th scope="col">Source timing</th></tr></thead>
      <tbody>${diffs.map((d: any) => {
        const av = d.accepted_value ? JSON.parse(d.accepted_value) : null;
        const ov = d.observed_value ? JSON.parse(d.observed_value) : null;
        return `<tr class="diff-${h(d.outcome)}">
          <td>${h(d.field)}</td><td>${h(av ?? "—")}</td><td>${h(ov ?? (d.outcome === "unknown" ? "not present at source" : "—"))}</td>
          <td><span class="badge ${h(d.outcome === "changed" ? "conflict" : d.outcome)}">${h(d.outcome)}</span></td>
          <td>effective ${h(d.source_effective_at ?? "—")} · retrieved ${h(d.retrieved_at ?? "—")} · ${h(d.source)} · rule ${h(d.rule_version)}</td></tr>`;
      }).join("")}</tbody></table>`}</section>
      ${canDecide ? `<section aria-labelledby="decision"><h2 id="decision">Decision (version ${f.expected_version})</h2>
      <p>Accepting applies the observed values and increments the supplier to version ${f.expected_version + 1}. This cannot be undone except by a new accepted refresh.</p>
      <form method="post" action="/refreshes/${h(f.id)}/decision">
        <input type="hidden" name="expected_version" value="${f.expected_version}">
        <label for="dreason">Reason (required)</label>
        <input type="text" id="dreason" name="reason" required>
        <p>
          <button type="submit" name="decision" value="accept">Accept new evidence</button>
          <button type="submit" name="decision" value="dismiss">Dismiss</button>
        </p>
      </form></section>` : f.state === "review_ready" ? "<p>Awaiting an AP approver decision.</p>" : ""}
      <p><a href="/inbox">Back to inbox</a></p>`));
  });

  r.post("/refreshes/:id/decision", (ctx: Ctx) => {
    requireRole(ctx.actor!, "decide");
    const b = ctx.body as Record<string, string>;
    decide(ctx.db, ctx.actor!, ctx.params.id, {
      expectedVersion: Number(b.expected_version),
      decision: b.decision as "accept" | "dismiss",
      reason: b.reason,
    });
    redirect(ctx.res, `/refreshes/${ctx.params.id}`);
  });

  r.get("/invoices", (ctx: Ctx) => {
    const rows = ctx.db.prepare(
      `SELECT i.*, json_extract(s.accepted_snapshot,'$.legal_name') AS legal_name
       FROM invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id
       WHERE i.tenant_id = ? ORDER BY i.created_at DESC`
    ).all(ctx.actor!.tenantId) as any[];
    sendHtml(ctx.res, 200, layout("Invoices", ctx.actor, `
      <h1>Invoices</h1>
      <table><thead><tr><th scope="col">Reference</th><th scope="col">Issued</th><th scope="col">SIREN</th><th scope="col">Status</th><th scope="col">Supplier</th><th scope="col">Reason</th></tr></thead>
      <tbody>${rows.map((i: any) => `<tr>
        <td>${h(i.external_ref)}</td><td>${h(i.issued_at)}</td><td>${h(i.siren ?? "—")}</td>
        <td><span class="badge ${h(i.status)}">${h(i.status)}</span></td>
        <td>${i.supplier_id ? `<a href="/suppliers/${h(i.supplier_id)}">${h(i.legal_name ?? i.supplier_id)}</a>` : "—"}</td>
        <td>${h(i.error_code ?? "")}</td></tr>`).join("")}</tbody></table>`));
  });

  r.get("/exceptions", (ctx: Ctx) => {
    const rows = ctx.db.prepare("SELECT * FROM exceptions WHERE tenant_id = ? ORDER BY created_at DESC").all(ctx.actor!.tenantId) as any[];
    const canCreate = ["ap_analyst", "ap_approver", "finance_admin"].includes(ctx.actor!.role);
    sendHtml(ctx.res, 200, layout("Exceptions", ctx.actor, `
      <h1>Sensitive exceptions</h1>
      <p>Bank and beneficiary changes are always referred to an independent manual flow; public company evidence never authorizes them.</p>
      ${canCreate ? `<form method="post" action="/exceptions">
        <label for="kind">Kind</label>
        <select id="kind" name="kind"><option value="bank_change">Bank account change</option><option value="beneficiary_change">Beneficiary change</option><option value="other">Other</option></select>
        <label for="detail">Detail (do not paste account numbers — they are masked)</label>
        <input type="text" id="detail" name="detail" required>
        <p><button type="submit">Create referral</button></p>
      </form>` : ""}
      <table><thead><tr><th scope="col">Kind</th><th scope="col">State</th><th scope="col">Detail</th><th scope="col">Created</th></tr></thead>
      <tbody>${rows.map((e: any) => `<tr><td>${h(e.kind)}</td><td><span class="badge ${h(e.state)}">${h(e.state)}</span></td><td>${h(e.detail)}</td><td>${h(e.created_at)}</td></tr>`).join("")}</tbody></table>`));
  });

  r.post("/exceptions", (ctx: Ctx) => {
    requireRole(ctx.actor!, "refer_exception");
    const b = ctx.body as Record<string, string>;
    const out = createException(ctx.db, ctx.actor!, { kind: b.kind, detail: b.detail });
    redirect(ctx.res, "/exceptions");
  });
}
