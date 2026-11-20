import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, listen, api, makeSiren, drainAll, vendorCsv, VENDOR_MAP, type TestEnv } from "./helpers.ts";

let env: TestEnv;
before(async () => {
  env = await listen(makeEnv());
});
after(() => env.cleanup());

async function page(env: TestEnv, token: string, path: string) {
  const res = await fetch(env.base + path, { headers: { cookie: `vr_session=${token}` } });
  return { status: res.status, html: await res.text() };
}

async function postForm(env: TestEnv, token: string, path: string, fields: Record<string, string>) {
  const res = await fetch(env.base + path, {
    method: "POST",
    headers: { cookie: `vr_session=${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
}

test("T-011: navigate from invoice discrepancy through review to accepted record (keyboard-native controls)", async () => {
  const siren = makeSiren(71000678);
  // Vendor master import
  const imp = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv: vendorCsv(siren, "KEYBOARD FLOW SA"), mapping: VENDOR_MAP,
  });
  const supplierId = imp.json.rows[0].supplierId;
  // Invoice linked by verified SIREN.
  const inv = await api(env, env.tokens.analyst, "POST", "/v1/invoices/import", {
    csv: `external_ref,siren,issued_at\nINV-200,${siren},2026-11-01`, mapping: { external_ref: "external_ref", siren: "siren", issued_at: "issued_at" },
  });
  assert.equal(inv.json.rows[0].status, "ok");

  // Age the evidence and scan so the case appears in the analyst inbox.
  env.db.prepare("UPDATE suppliers SET accepted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(supplierId);
  const scan = await api(env, env.tokens.analyst, "POST", "/v1/scans", {});
  assert.ok(scan.json.triggers.some((t: any) => t.supplierId === supplierId));

  // Every step is a real link or native form — fully keyboard operable.
  const inbox = await page(env, env.tokens.analyst, "/inbox");
  assert.equal(inbox.status, 200);
  assert.match(inbox.html, /href="\/suppliers\//, "inbox links to supplier detail");
  const supplier = await page(env, env.tokens.analyst, `/suppliers/${supplierId}`);
  assert.match(supplier.html, /action="\/suppliers\/[^"]+\/refreshes"/, "refresh request is a native form");
  assert.match(supplier.html, /name="expected_version" value="1"/);

  const req = await postForm(env, env.tokens.analyst, `/suppliers/${supplierId}/refreshes`, {
    reason: "invoice discrepancy review",
    expected_version: "1",
    key: "web-t011",
  });
  assert.equal(req.status, 303);
  const refreshId = req.location!.split("/refreshes/")[1];
  env.providers.registry.rows.set(siren, {
    siren, legal_name: "KEYBOARD FLOW SA", status: "active",
    address: { line1: "3 boulevard Haussmann", line2: null, postal_code: "75009", city: "Paris", country: "FR" },
    effective_at: "2026-10-20T00:00:00.000Z",
  });
  await drainAll(env);

  // Approver sees the case with the decision form (radio-free native submit buttons).
  const review = await page(env, env.tokens.approver, `/refreshes/${refreshId}`);
  assert.equal(review.status, 200);
  assert.match(review.html, /name="decision" value="accept"/);
  assert.match(review.html, /name="decision" value="dismiss"/);
  assert.match(review.html, /Field differences/);

  const dec = await postForm(env, env.tokens.approver, `/refreshes/${refreshId}/decision`, {
    expected_version: "1", decision: "accept", reason: "evidence verified",
  });
  assert.equal(dec.status, 303);
  const final = await api(env, env.tokens.analyst, "GET", `/v1/suppliers/${supplierId}`);
  assert.equal(final.json.supplier.version, 2);
  assert.equal(final.json.supplier.vendor_state, "monitored");
});

test("T-012: bank-change request is referred for independent handling without storing an account", async () => {
  const detail = "Supplier asked to change RIB FR76 3000 4000 5012 3456 7890 185 urgently";
  const r = await api(env, env.tokens.analyst, "POST", "/v1/exceptions", {
    kind: "bank_change",
    detail,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.state, "referred");

  const stored = env.db.prepare("SELECT * FROM exceptions WHERE id = ?").get(r.json.id) as any;
  assert.equal(stored.state, "referred");
  assert.doesNotMatch(stored.detail, /3000|4000|5012|3456/, "account digits masked before storage");
  assert.match(stored.detail, /redacted/);

  // Nothing account-like lands in the audit log either.
  const logs = env.db.prepare("SELECT detail FROM audit_log WHERE entity = 'exception' AND entity_id = ?").all(stored.id) as any[];
  for (const l of logs) assert.doesNotMatch(l.detail, /3000|4000|5012|3456/);

  // The exceptions page shows the referral.
  const pg = await page(env, env.tokens.analyst, "/exceptions");
  assert.match(pg.html, /referred/);
  assert.doesNotMatch(pg.html, /3000 4000/);
});

test("unauthenticated requests are rejected; unknown refresh id 404s", async () => {
  const res = await fetch(env.base + "/inbox");
  assert.equal(res.status, 401);
  const missing = await page(env, env.tokens.approver, "/refreshes/ref_nonexistent");
  assert.equal(missing.status, 404);
});
