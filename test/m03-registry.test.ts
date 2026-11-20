import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, listen, api, makeSiren, vendorCsv, VENDOR_MAP, drainAll, type TestEnv } from "./helpers.ts";
import { processRefresh, dispatchSpend, fetchSource } from "../src/services/pipeline.ts";
import { drain } from "../src/worker.ts";

let env: TestEnv;
before(async () => {
  env = await listen(makeEnv());
});
after(() => env.cleanup());

async function importSupplier(siren: string, name: string, line1 = "10 rue de la Paix") {
  const r = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv: `siren,legal_name,vendor_ref,address_line1,postal_code,city,country,status\n${siren},${name},V001,"${line1}",75002,Paris,FR,active\n`,
    mapping: VENDOR_MAP,
  });
  return r.json.rows[0].supplierId as string;
}

async function requestRefresh(supplierId: string, key: string) {
  const r = await api(env, env.tokens.analyst, "POST", `/v1/suppliers/${supplierId}/refreshes`, {
    reason: "stale evidence",
    expected_version: 1,
    key,
  });
  return r;
}

test("T-005: a licensed fixture record normalizes with both timestamps on diffs", async () => {
  const siren = makeSiren(41000444);
  const supplierId = await importSupplier(siren, "OLD NAME SARL");
  env.providers.registry.rows.set(siren, {
    siren,
    legal_name: "NEW NAME SAS",
    status: "active",
    address: { line1: "99 avenue Victor Hugo", line2: null, postal_code: "75116", city: "Paris", country: "FR" },
    effective_at: "2026-10-15T00:00:00.000Z",
  });

  const r = await requestRefresh(supplierId, "t005-key");
  assert.equal(r.status, 201);
  const refreshId = r.json.refresh.id;

  await drainAll(env); // quote -> reserve -> dispatch -> fetch
  const detail = await api(env, env.tokens.approver, "GET", `/v1/refreshes/${refreshId}`);
  assert.equal(detail.json.refresh.state, "review_ready", JSON.stringify(detail.json.refresh));
  assert.equal(detail.json.quote.provider, "fixture-sirene");
  assert.equal(detail.json.quote.amount_minor, 2);
  assert.equal(detail.json.quote.metadata.environment, "local-fixture");

  const nameDiff = detail.json.diffs.find((d: any) => d.field === "legal_name");
  assert.equal(nameDiff.outcome, "changed");
  assert.equal(nameDiff.source, "fixture-sirene");
  assert.equal(nameDiff.source_effective_at, "2026-10-15T00:00:00.000Z");
  assert.ok(nameDiff.retrieved_at, "retrieved timestamp shown");

  const ev = await api(env, env.tokens.approver, "GET", `/v1/refreshes/${refreshId}/evidence`);
  assert.equal(ev.json.snapshot.sourceEffectiveAt, "2026-10-15T00:00:00.000Z");
  assert.ok(ev.json.snapshot.retrievedAt);
  assert.equal(ev.json.snapshot.terms.environment, "local-fixture");
  assert.equal(ev.json.snapshot.terms.retention.bank_account.retained, false, "bank fields never collected");
});

test("T-006: a source returning a different SIREN is quarantined and cannot update the case", async () => {
  const siren = makeSiren(42000555);
  const supplierId = await importSupplier(siren, "QUARANTINE TEST SA");
  env.providers.registry.rows.set(siren, {
    siren,
    legal_name: "QUARANTINE TEST SA",
    status: "active",
    address: { line1: "1 rue A", line2: null, postal_code: "75001", city: "Paris", country: "FR" },
    effective_at: "2026-10-01T00:00:00.000Z",
  });
  env.providers.registry.fault = "wrong_siren";
  try {
    const r = await requestRefresh(supplierId, "t006-key");
    const refreshId = r.json.refresh.id;
    await drainAll(env);
    const detail = await api(env, env.tokens.approver, "GET", `/v1/refreshes/${refreshId}`);
    assert.equal(detail.json.refresh.state, "blocked");
    assert.equal(detail.json.refresh.block_reason, "siren_mismatch");
    assert.equal(detail.json.snapshot.quarantined, 1);
    const diffCount = env.db.prepare("SELECT COUNT(*) c FROM diffs WHERE refresh_id = ?").get(refreshId) as { c: number };
    assert.equal(diffCount.c, 0, "quarantined snapshot produces no diffs");
    const snap = env.db.prepare("SELECT quarantined, quarantine_reason FROM snapshots WHERE id = ?").get(detail.json.snapshot.id) as any;
    assert.equal(snap.quarantined, 1);
    assert.match(snap.quarantine_reason, /siren_mismatch/);
  } finally {
    env.providers.registry.fault = null;
  }
});

test("unapproved provider is blocked before spend (terms gate)", async () => {
  const siren = makeSiren(43000666);
  const supplierId = await importSupplier(siren, "NO PROVIDER SA");
  env.db.prepare("UPDATE policies SET approved_providers = ? WHERE tenant_id = ? AND active = 1").run('["other-registry"]', env.seed.tenantA);
  const r = await requestRefresh(supplierId, "t-unapproved");
  await drainAll(env);
  const detail = await api(env, env.tokens.approver, "GET", `/v1/refreshes/${r.json.refresh.id}`);
  assert.equal(detail.json.refresh.state, "blocked");
  assert.match(String(detail.json.refresh.block_reason), /provider_not_approved/);
  const intents = env.db.prepare("SELECT COUNT(*) c FROM spend_intents WHERE refresh_id = ?").get(r.json.refresh.id) as { c: number };
  assert.equal(intents.c, 0, "no reservation created");
  env.db.prepare("UPDATE policies SET approved_providers = ? WHERE tenant_id = ? AND active = 1").run('["fixture-sirene"]', env.seed.tenantA);
});
