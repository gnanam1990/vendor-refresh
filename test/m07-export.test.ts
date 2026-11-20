import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, listen, api, makeSiren, drainAll, vendorCsv, VENDOR_MAP, type TestEnv } from "./helpers.ts";
import { toCsvCell } from "../src/domain/redact.ts";

let env: TestEnv;
before(async () => {
  env = await listen(makeEnv());
});
after(() => env.cleanup());

test("T-013: replay import to export with one accepted change and reconcile the sole $0.02 receipt", async () => {
  const siren = makeSiren(81000789);
  const csv = vendorCsv(siren, "EXPORT FLOW SA");
  // Import twice — replay coalesces to one supplier, two receipts (INV-02).
  await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", { csv, mapping: VENDOR_MAP });
  const r2 = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", { csv, mapping: VENDOR_MAP });
  const supplierId = r2.json.rows[0].supplierId;

  env.providers.registry.rows.set(siren, {
    siren, legal_name: "EXPORT FLOW SA", status: "active",
    address: { line1: "7 rue de la Pompe", line2: null, postal_code: "75116", city: "Paris", country: "FR" },
    effective_at: "2026-11-10T00:00:00.000Z",
  });
  const rr = await api(env, env.tokens.analyst, "POST", `/v1/suppliers/${supplierId}/refreshes`, {
    reason: "pilot replay", expected_version: 1, key: "t013-key",
  });
  const refreshId = rr.json.refresh.id;
  await drainAll(env);

  const dec = await api(env, env.tokens.approver, "POST", `/v1/refreshes/${refreshId}/decision`, {
    expected_version: 1, decision: "accept", reason: "verified",
  });
  assert.equal(dec.status, 200);

  // Export: exactly the accepted address change, nothing else.
  const ex = await api(env, env.tokens.finance, "GET", "/v1/exports/accepted");
  assert.equal(ex.status, 200);
  const mine = ex.json.rows.filter((row: any) => row.siren === siren);
  // Accepted deltas: address (new value) and status (previously unset).
  assert.deepEqual(mine.map((row: any) => row.field).sort(), ["address", "status"]);
  const addr = mine.find((row: any) => row.field === "address");
  assert.equal(addr.acceptedTo, "7 rue de la Pompe, 75116, Paris, FR");

  // Reconcile the sole $0.02 receipt.
  const rec = await api(env, env.tokens.finance, "GET", "/v1/reconciliation");
  const intent = rec.json.intents.find((i: any) => i.refresh_id === refreshId);
  assert.equal(intent.amount_minor, 2);
  assert.equal(intent.status, "settled");
  assert.equal(intent.receipt_count, 1);
  const receipt = rec.json.receipts.find((rc: any) => rc.spend_intent_id === intent.id);
  assert.equal(receipt.remote_ref, intent.remote_ref);

  const pilot = await api(env, env.tokens.finance, "GET", "/v1/reports/pilot");
  assert.ok(pilot.json.paidChecks.settled >= 1);
});

test("T-014: a cross-tenant cursor cannot leak data; a formula in a source field cannot execute on export", async () => {
  // Mint a tenant-A-shaped cursor and present it as tenant B.
  const sirenA = makeSiren(82000111);
  await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv: vendorCsv(sirenA, "TENANT A SECRET SA"), mapping: VENDOR_MAP,
  });
  const foreignCursor = Buffer.from(JSON.stringify({ t: env.seed.tenantA, r: "rev_x", c: "2026-01-01" })).toString("base64url");
  const cross = await api(env, env.tokensB.finance, "GET", `/v1/exports/accepted?cursor=${encodeURIComponent(foreignCursor)}`);
  assert.equal(cross.status, 403);

  // Tenant B cannot see tenant A supplier either.
  const supA = env.db.prepare("SELECT id FROM suppliers WHERE tenant_id=? AND siren=?").get(env.seed.tenantA, sirenA) as any;
  const peek = await api(env, env.tokensB.analyst, "GET", `/v1/suppliers/${supA.id}`);
  assert.equal(peek.status, 404);

  // Formula-injection: import a supplier whose legal_name is a spreadsheet formula.
  const sirenF = makeSiren(83000222);
  await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv: `siren,legal_name\n${sirenF},"=HYPERLINK(""http://evil"",""x"")"`,
    mapping: { siren: "siren", legal_name: "legal_name" },
  });
  const supF = env.db.prepare("SELECT id FROM suppliers WHERE tenant_id=? AND siren=?").get(env.seed.tenantA, sirenF) as any;
  env.providers.registry.rows.set(sirenF, {
    siren: sirenF, legal_name: "=cmd|'/c calc'!A0", status: "active",
    address: { line1: "1 rue X", line2: null, postal_code: "75001", city: "Paris", country: "FR" },
    effective_at: "2026-11-01T00:00:00.000Z",
  });
  const rr = await api(env, env.tokens.analyst, "POST", `/v1/suppliers/${supF.id}/refreshes`, {
    reason: "injection check", expected_version: 1, key: "t014-key",
  });
  await drainAll(env);
  await api(env, env.tokens.approver, "POST", `/v1/refreshes/${rr.json.refresh.id}/decision`, {
    expected_version: 1, decision: "accept", reason: "verified",
  });
  const csvRes = await fetch(env.base + "/v1/exports/accepted?format=csv", {
    headers: { cookie: `vr_session=${env.tokens.finance}` },
  });
  const text = await csvRes.text();
  // Every cell carrying attacker-controlled text is prefixed with a quote.
  const dataLines = text.split("\r\n").slice(1).filter(Boolean);
  for (const line of dataLines) {
    const cells = line.split(",");
    for (const c of cells) assert.doesNotMatch(c, /^[=+\-@]/, `unescaped formula cell: ${c}`);
  }
  assert.match(text, /'=cmd|'=HYPERLINK/, "formula content is inertly quoted");
});

test("csv cell safety unit checks", () => {
  assert.equal(toCsvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(toCsvCell("+42"), "'+42");
  assert.equal(toCsvCell("-1"), "'-1");
  assert.equal(toCsvCell("@x"), "'@x");
  assert.equal(toCsvCell("normal"), "normal");
  assert.equal(toCsvCell('has "quote"'), '"has ""quote"""');
});
