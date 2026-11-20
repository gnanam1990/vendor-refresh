import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, listen, api, makeSiren, drainAll, type TestEnv } from "./helpers.ts";

let env: TestEnv;
before(async () => {
  env = await listen(makeEnv());
});
after(() => env.cleanup());

async function importSupplier(siren: string, name: string, status = "active") {
  const r = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv: `siren,legal_name,status\n${siren},${name},${status}`,
    mapping: { siren: "siren", legal_name: "legal_name" },
  });
  return r.json.rows[0].supplierId as string;
}

async function runRefreshToReview(siren: string, supplierId: string, key: string, registryRow?: any) {
  env.providers.registry.rows.set(siren, registryRow ?? {
    siren, legal_name: "X", status: "active",
    address: { line1: "99 avenue Victor Hugo", line2: null, postal_code: "75116", city: "Paris", country: "FR" },
    effective_at: "2026-10-15T00:00:00.000Z",
  });
  const r = await api(env, env.tokens.analyst, "POST", `/v1/suppliers/${supplierId}/refreshes`, {
    reason: "stale evidence", expected_version: 1, key,
  });
  assert.equal(r.status, 201);
  await drainAll(env);
  const detail = await api(env, env.tokens.approver, "GET", `/v1/refreshes/${r.json.refresh.id}`);
  assert.equal(detail.json.refresh.state, "review_ready", JSON.stringify(detail.json.refresh.block_reason));
  return { refreshId: r.json.refresh.id as string, detail: detail.json };
}

test("T-009: accepting the address diff increments the version exactly once and preserves history", async () => {
  const siren = makeSiren(61000123);
  const supplierId = await importSupplier(siren, "ADDRESS MOVE SA");
  const { refreshId, detail } = await runRefreshToReview(siren, supplierId, "t009-key", {
    siren, legal_name: "ADDRESS MOVE SA", status: "active",
    address: { line1: "99 avenue Victor Hugo", line2: null, postal_code: "75116", city: "Paris", country: "FR" },
    effective_at: "2026-10-15T00:00:00.000Z",
  });
  const addressDiff = detail.diffs.find((d: any) => d.field === "address");
  assert.equal(addressDiff.outcome, "changed");

  const before = env.db.prepare("SELECT version FROM suppliers WHERE id = ?").get(supplierId) as any;
  const r = await api(env, env.tokens.approver, "POST", `/v1/refreshes/${refreshId}/decision`, {
    expected_version: 1, decision: "accept", reason: "registry evidence reviewed",
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after1 = env.db.prepare("SELECT version, accepted_snapshot FROM suppliers WHERE id = ?").get(supplierId) as any;
  assert.equal(after1.version, before.version + 1, "exactly one version increment");
  const snap = JSON.parse(after1.accepted_snapshot);
  assert.equal(snap.address_text, "99 avenue Victor Hugo, 75116, Paris, FR");
  assert.equal(snap.review_id, r.json.reviewId);

  // History preserved: review row, diffs and refresh state remain queryable.
  const review = env.db.prepare("SELECT * FROM reviews WHERE id = ?").get(r.json.reviewId) as any;
  assert.ok(review);
  assert.equal(JSON.parse(review.field_diffs).length, 3);
  const diffs = env.db.prepare("SELECT COUNT(*) c FROM diffs WHERE refresh_id = ?").get(refreshId) as any;
  assert.equal(diffs.c, 3);

  // Re-accepting the same decided refresh does not double-increment.
  const again = await api(env, env.tokens.approver, "POST", `/v1/refreshes/${refreshId}/decision`, {
    expected_version: 1, decision: "accept", reason: "registry evidence reviewed",
  });
  const final = env.db.prepare("SELECT version FROM suppliers WHERE id = ?").get(supplierId) as any;
  assert.equal(final.version, after1.version, "no second increment on replayed decision");
});

test("T-010: approving a stale revision conflicts", async () => {
  const siren = makeSiren(62000234);
  const supplierId = await importSupplier(siren, "STALE TAB SA");
  const { refreshId } = await runRefreshToReview(siren, supplierId, "t010-key", {
    siren, legal_name: "STALE TAB SA", status: "active",
    address: { line1: "5 rue Neuve", line2: null, postal_code: "69001", city: "Lyon", country: "FR" },
    effective_at: "2026-10-15T00:00:00.000Z",
  });
  // Supplier advanced to v2 by another decision path meanwhile.
  env.db.prepare("UPDATE suppliers SET version = 2 WHERE id = ?").run(supplierId);
  const r = await api(env, env.tokens.approver, "POST", `/v1/refreshes/${refreshId}/decision`, {
    expected_version: 1, decision: "accept", reason: "stale tab submit",
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "stale_revision");
  const refresh = env.db.prepare("SELECT state FROM refreshes WHERE id = ?").get(refreshId) as any;
  assert.equal(refresh.state, "review_ready", "conflicted decision leaves the review pending");
});

test("an older source observation cannot roll the record back", async () => {
  const siren = makeSiren(63000345);
  const supplierId = await importSupplier(siren, "ROLLBACK SA");
  // Newer observation for legal_name already on file.
  env.db.prepare(
    `INSERT INTO observations (id, tenant_id, siren, field, value, source, source_effective_at, retrieved_at, snapshot_id)
     VALUES ('obs_newer', ?, ?, 'legal_name', '"ROLLBACK SA NEW"', 'fixture-sirene', '2026-11-15T00:00:00.000Z', '2026-11-16T00:00:00.000Z', NULL)`
  ).run(env.seed.tenantA, siren);
  const { refreshId } = await runRefreshToReview(siren, supplierId, "rollback-key", {
    siren, legal_name: "ANCIENT NAME", status: "active",
    address: { line1: null, line2: null, postal_code: null, city: null, country: "FR" },
    effective_at: "2026-01-01T00:00:00.000Z", // older effective record
  });
  const detail = (await api(env, env.tokens.approver, "GET", `/v1/refreshes/${refreshId}`)).json;
  const nameDiff = detail.diffs.find((d: any) => d.field === "legal_name");
  assert.equal(nameDiff.outcome, "unchanged", "older effective record cannot claim a change");
});

test("decision requires approver role; analyst gets 403", async () => {
  const siren = makeSiren(64000456);
  const supplierId = await importSupplier(siren, "ROLE CHECK SA");
  const { refreshId } = await runRefreshToReview(siren, supplierId, "role-key");
  const r = await api(env, env.tokens.analyst, "POST", `/v1/refreshes/${refreshId}/decision`, {
    expected_version: 1, decision: "accept",
  });
  assert.equal(r.status, 403);
});
