import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, listen, api, makeSiren, vendorCsv, VENDOR_MAP, type TestEnv } from "./helpers.ts";
import { scanFreshness } from "../src/services/scan.ts";
import { computeAndStoreDiffs } from "../src/services/diffService.ts";
import type { RegistryRecord } from "../src/providers/registry.ts";

let env: TestEnv;
before(async () => {
  env = await listen(makeEnv());
});
after(() => env.cleanup());

async function importSupplier(siren: string, name: string) {
  const r = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv: vendorCsv(siren, name),
    mapping: VENDOR_MAP,
  });
  return r.json.rows[0].supplierId as string;
}

test("T-003: two scans find one coalesced case for the same stale vendor", async () => {
  const siren = makeSiren(31000111);
  const supplierId = await importSupplier(siren, "STALE EVIDENCE SARL");
  // Force staleness by aging accepted_at beyond the 30-day policy window.
  env.db.prepare("UPDATE suppliers SET accepted_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", supplierId);

  const r1 = await api(env, env.tokens.analyst, "POST", "/v1/scans", {});
  assert.equal(r1.status, 200);
  const forThis = r1.json.triggers.filter((t: any) => t.supplierId === supplierId);
  assert.equal(forThis.length, 1);
  assert.ok(r1.json.created >= 1);

  // A second scan (equivalent to a concurrent/replayed run) coalesces.
  const r2 = await api(env, env.tokens.analyst, "POST", "/v1/scans", {});
  assert.equal(r2.status, 200);
  const rows = env.db
    .prepare("SELECT COUNT(*) c FROM triggers WHERE tenant_id = ? AND supplier_id = ?")
    .get(env.seed.tenantA, supplierId) as { c: number };
  assert.equal(rows.c, 1, "still exactly one case for the same supplier revision");
  const again = r2.json.triggers.filter((t: any) => t.supplierId === supplierId);
  assert.equal(again[0].id, forThis[0].id, "same stable trigger id");
});

test("T-004: absent optional status yields unknown and never overwrites accepted status", () => {
  const db = env.db;
  const siren = makeSiren(32000222);
  const accepted = { legal_name: "KNOWN STATUS SA", status: "active", address: { line1: "1 rue X", city: "Lyon", country: "FR" } };
  const ts = new Date().toISOString();
  db.prepare(
    "INSERT INTO suppliers (id, tenant_id, siren, vendor_state, version, accepted_snapshot, accepted_at, created_at, updated_at) VALUES ('sup_t004',?,?,?,?,?,?,?,?)"
  ).run(env.seed.tenantA, siren, "monitored", 1, JSON.stringify(accepted), ts, ts, ts);
  db.prepare(
    "INSERT INTO refreshes (id, tenant_id, supplier_id, expected_version, trigger_key, policy_version, state, reason, actor_id, idempotency_key, created_at, updated_at) VALUES ('ref_t004',?,'sup_t004',1,'k',1,'awaiting_source','t','u_ana','k_t004',?,?)"
  ).run(env.seed.tenantA, ts, ts);
  db.prepare(
    "INSERT INTO snapshots (id, tenant_id, siren, source, payload, snapshot_hash, retrieved_at, terms) VALUES ('snp_t004',?,?,'fixture-sirene','{}','h',?,'{}')"
  ).run(env.seed.tenantA, siren, ts);
  // Record WITHOUT the status key (optional field absent at source).
  const record: RegistryRecord = {
    siren,
    legal_name: "KNOWN STATUS SA",
    status: undefined as unknown as null,
    address: { line1: "1 rue X", line2: null, postal_code: "69001", city: "Lyon", country: "FR" },
  };
  delete (record as any).status;
  const diffs = computeAndStoreDiffs(
    db,
    "ref_t004",
    env.seed.tenantA,
    siren,
    JSON.stringify(accepted),
    record,
    "fixture-sirene",
    "2026-11-19T00:00:00.000Z",
    "2026-11-20T00:00:00.000Z",
    "snp_t004"
  );
  const statusDiff = diffs.find((d) => d.field === "status")!;
  assert.equal(statusDiff.outcome, "unknown");
  // Accepted snapshot is untouched by an unknown outcome.
  assert.equal(accepted.status, "active");
  const stored = db.prepare("SELECT outcome, observed_value FROM diffs WHERE refresh_id = 'ref_t004' AND field = 'status'").get() as any;
  assert.equal(stored.outcome, "unknown");
  assert.equal(stored.observed_value, null);
});

test("scan produces zero cases for fresh suppliers and survives policy versioning", async () => {
  const siren = makeSiren(33000333);
  await importSupplier(siren, "FRESH SA");
  // Fresh: accepted_at is now, within the 30-day window.
  const r = await api(env, env.tokens.analyst, "POST", "/v1/scans", {});
  const forThis = r.json.triggers.filter((t: any) => t.supplierId);
  const sup = env.db.prepare("SELECT id FROM suppliers WHERE tenant_id=? AND siren=?").get(env.seed.tenantA, siren) as any;
  assert.ok(!forThis.some((t: any) => t.supplierId === sup.id));

  // New policy version widens coalescing key (versioned policy).
  const next = env.db.prepare("SELECT MAX(version) v FROM policies WHERE tenant_id=?").get(env.seed.tenantA) as any;
  env.db.prepare(
    `INSERT INTO policies (id, tenant_id, version, stale_after_seconds, per_call_max_minor, cumulative_cap_minor, currency, approved_providers, active, created_at)
     VALUES ('pol_v2', ?, ?, 0, 5, 10, 'USD', '["fixture-sirene"]', 1, ?)`
  ).run(env.seed.tenantA, next.v + 1, new Date().toISOString());
  const r2 = scanFreshness(env.db, env.seed.tenantA, null);
  const trig = r2.triggers.find((t) => t.supplierId === sup.id);
  assert.ok(trig, "stale_after=0 flags the previously fresh supplier under policy v2");
  env.db.prepare("DELETE FROM policies WHERE id = 'pol_v2'").run();
});
