import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, listen, api, makeSiren, vendorCsv, VENDOR_MAP, INVOICE_MAP, type TestEnv } from "./helpers.ts";

let env: TestEnv;
before(async () => {
  env = await listen(makeEnv());
});
after(() => env.cleanup());

test("T-001: importing the same valid supplier twice yields one supplier and two receipts", async () => {
  const siren = makeSiren(55212022);
  const csv = vendorCsv(siren, "DUPONT & CIE");
  const r1 = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv,
    mapping: VENDOR_MAP,
    filename: "master-1.csv",
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.rowsOk, 1);

  const r2 = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv,
    mapping: VENDOR_MAP,
    filename: "master-2.csv",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.rows[0].status, "duplicate");

  const list = await api(env, env.tokens.analyst, "GET", "/v1/suppliers");
  const matching = list.json.suppliers.filter((s: any) => s.siren === siren);
  assert.equal(matching.length, 1, "exactly one tenant supplier for the SIREN");
  assert.equal(matching[0].accepted_snapshot.legal_name, "DUPONT & CIE");

  const imps = env.db.prepare("SELECT COUNT(*) c FROM imports WHERE tenant_id = ? AND kind = 'vendor_master'").get(env.seed.tenantA) as { c: number };
  assert.ok(imps.c >= 2, "two import receipts persisted");
});

test("T-002: nine-digit value in the wrong column and a name-only row return per-row errors", async () => {
  // phone column carries a 9-digit number that fails Luhn; siren col empty on row 3.
  const csv = [
    "phone,siren,legal_name,vendor_ref",
    "014725836,014725836,BAD COLUMN SA,V100", // 9-digit phone mapped as siren -> checksum fail
    ",,NAME ONLY SARL,V101", // no siren at all
  ].join("\n");
  const r = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv,
    mapping: { siren: "phone", legal_name: "legal_name", vendor_ref: "vendor_ref" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.rowsTotal, 2);
  assert.equal(r.json.rowsFailed, 2);
  assert.equal(r.json.rows[0].errorCode, "invalid_siren_checksum");
  assert.equal(r.json.rows[1].errorCode, "missing_siren");
  const suppliers = (await api(env, env.tokens.analyst, "GET", "/v1/suppliers")).json.suppliers;
  assert.ok(!suppliers.some((s: any) => s.accepted_snapshot?.legal_name === "NAME ONLY SARL"));
});

test("T-002b: name-only row (valid column, empty siren) errors without creating a supplier", async () => {
  const siren = makeSiren(44123456);
  const csv = `siren,legal_name\n${siren},GOOD SA\n,ORPHAN NAME SARL`;
  const r = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv,
    mapping: { siren: "siren", legal_name: "legal_name" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.rows[0].status, "ok");
  assert.equal(r.json.rows[1].errorCode, "missing_siren");
});

test("INV-01: invoice links only by verified SIREN; name-only invoice is refused", async () => {
  const siren = makeSiren(73282932);
  await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv: vendorCsv(siren, "VERIFIED LINK SA"),
    mapping: VENDOR_MAP,
  });
  const csv = [
    "external_ref,siren,issued_at,vendor_ref",
    `INV-100,${siren},2026-11-01,V001`,
    "INV-101,,2026-11-02,V001", // name-only -> unlinked, never guessed
  ].join("\n");
  const r = await api(env, env.tokens.analyst, "POST", "/v1/invoices/import", { csv, mapping: INVOICE_MAP });
  assert.equal(r.status, 200);
  assert.equal(r.json.rows[0].status, "ok");
  assert.equal(r.json.rows[1].errorCode, "no_verified_siren");
  const inv = await api(env, env.tokens.analyst, "GET", "/v1/invoices");
  const i100 = inv.json.invoices.find((i: any) => i.external_ref === "INV-100");
  const i101 = inv.json.invoices.find((i: any) => i.external_ref === "INV-101");
  assert.equal(i100.status, "linked");
  assert.ok(i100.supplier_id);
  assert.equal(i101.supplier_id, null);
});

test("cross-tenant SIREN does not deduplicate", async () => {
  const siren = makeSiren(98712345);
  await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", { csv: vendorCsv(siren, "TENANT A SA"), mapping: VENDOR_MAP });
  const rb = await api(env, env.tokensB.analyst, "POST", "/v1/suppliers/import", { csv: vendorCsv(siren, "TENANT B SA"), mapping: VENDOR_MAP });
  assert.equal(rb.json.rows[0].status, "ok", "different tenant gets its own supplier row");
  const listA = (await api(env, env.tokens.analyst, "GET", "/v1/suppliers")).json.suppliers;
  const listB = (await api(env, env.tokensB.analyst, "GET", "/v1/suppliers")).json.suppliers;
  assert.equal(listA.filter((s: any) => s.siren === siren).length, 1);
  assert.equal(listB.filter((s: any) => s.siren === siren).length, 1);
});

test("supplier_contact cannot import (read-only)", async () => {
  const r = await api(env, env.tokens.supplier, "POST", "/v1/suppliers/import", {
    csv: vendorCsv(makeSiren(11111111)),
    mapping: VENDOR_MAP,
  });
  assert.equal(r.status, 403);
});
