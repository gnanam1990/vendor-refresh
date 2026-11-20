import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, listen, api, makeSiren, drainAll, type TestEnv } from "./helpers.ts";

let env: TestEnv;
before(async () => {
  env = await listen(makeEnv());
});
after(() => env.cleanup());

async function importSupplier(siren: string, name: string) {
  const r = await api(env, env.tokens.analyst, "POST", "/v1/suppliers/import", {
    csv: `siren,legal_name\n${siren},${name}`,
    mapping: { siren: "siren", legal_name: "legal_name" },
  });
  return r.json.rows[0].supplierId as string;
}

async function requestRefresh(supplierId: string, key: string) {
  return api(env, env.tokens.analyst, "POST", `/v1/suppliers/${supplierId}/refreshes`, {
    reason: "stale evidence",
    expected_version: 1,
    key,
  });
}

test("T-007: two simultaneous requests for the same case create one reservation and one merchant ref", async () => {
  const siren = makeSiren(51000777);
  const supplierId = await importSupplier(siren, "DOUBLE SPEND SARL");
  env.providers.registry.rows.set(siren, {
    siren, legal_name: "DOUBLE SPEND SARL", status: "active",
    address: { line1: null, line2: null, postal_code: null, city: "Lille", country: "FR" },
    effective_at: "2026-11-01T00:00:00.000Z",
  });
  // Two different idempotency keys, same case -> coalesced to one refresh.
  const [r1, r2] = await Promise.all([requestRefresh(supplierId, "k-a"), requestRefresh(supplierId, "k-b")]);
  const ids = [r1.json.refresh.id, r2.json.refresh.id];
  assert.equal(ids[0], ids[1], "same refresh returned to both callers");

  const chargeCountBefore = env.providers.rail.name === "local-emulator"
    ? (env.providers.rail as any).charges.length : 0;
  await drainAll(env);

  const intents = env.db.prepare("SELECT * FROM spend_intents WHERE refresh_id = ?").all(ids[0]) as any[];
  assert.equal(intents.length, 1, "exactly one spend intent");
  assert.equal(intents[0].status, "settled");
  const receipts = env.db.prepare("SELECT * FROM receipts WHERE spend_intent_id = ?").all(intents[0].id) as any[];
  assert.equal(receipts.length, 1, "one receipt / one merchant reference");
  const charges = (env.providers.rail as any).charges;
  assert.equal(charges.length - chargeCountBefore, 1, "merchant charged exactly once");

  // Idempotent replay of the same key returns the stored operation.
  const replay = await requestRefresh(supplierId, "k-a");
  assert.equal(replay.json.refresh.id, ids[0]);
  assert.equal(replay.json.deduplicated, true);
});

test("T-008: a $0.06 quote against the $0.05 per-call cap is rejected before paid execution", async () => {
  const siren = makeSiren(52000888);
  const supplierId = await importSupplier(siren, "OVER CAP SA");
  env.providers.registry.quoteAmountMinor = 6;
  try {
    const r = await requestRefresh(supplierId, "cap-key");
    const chargesBefore = (env.providers.rail as any).charges.length;
    await drainAll(env);
    const detail = await api(env, env.tokens.approver, "GET", `/v1/refreshes/${r.json.refresh.id}`);
    assert.equal(detail.json.refresh.state, "blocked");
    assert.match(String(detail.json.refresh.block_reason), /over_per_call_cap/);
    assert.equal(detail.json.quote.state, "rejected");
    const intents = env.db.prepare("SELECT COUNT(*) c FROM spend_intents WHERE refresh_id = ?").get(r.json.refresh.id) as { c: number };
    assert.equal(intents.c, 0, "no reservation");
    assert.equal((env.providers.rail as any).charges.length, chargesBefore, "paid execution never invoked");
  } finally {
    env.providers.registry.quoteAmountMinor = 2;
  }
});

test("cumulative cap: a $0.10 policy allows five $0.02 checks then blocks the sixth", async () => {
  // T-007 settled 2 minor; run 4 more purchases then hit the cap at 10.
  const sirens = [makeSiren(53000001), makeSiren(53000002), makeSiren(53000003), makeSiren(53000004), makeSiren(53000005)];
  for (let i = 0; i < sirens.length; i++) {
    const sid = await importSupplier(sirens[i], `CAP ${i} SA`);
    env.providers.registry.rows.set(sirens[i], {
      siren: sirens[i], legal_name: `CAP ${i} SA`, status: "active",
      address: { line1: null, line2: null, postal_code: null, city: null, country: "FR" },
      effective_at: "2026-11-01T00:00:00.000Z",
    });
    const r = await requestRefresh(sid, `cum-key-${i}`);
    await drainAll(env);
    const state = (await api(env, env.tokens.approver, "GET", `/v1/refreshes/${r.json.refresh.id}`)).json.refresh.state;
    if (i < 4) assert.equal(state, "review_ready", `refresh ${i} should complete`);
    else {
      assert.equal(state, "blocked");
      const detail = await api(env, env.tokens.approver, "GET", `/v1/refreshes/${r.json.refresh.id}`);
      assert.match(String(detail.json.refresh.block_reason), /over_cumulative_cap/);
    }
  }
});

test("INV-04: an uncertain charge goes to reconciling and never redispatches", async () => {
  // Runs under tenant B so the tenant-A cumulative-cap scenario above does not
  // interfere; also exercises the second tenant's independent ledger.
  const siren = makeSiren(54000999);
  const r0 = await api(env, env.tokensB.analyst, "POST", "/v1/suppliers/import", {
    csv: `siren,legal_name\n${siren},TIMEOUT TEST SARL`,
    mapping: { siren: "siren", legal_name: "legal_name" },
  });
  const supplierId = r0.json.rows[0].supplierId;
  env.providers.registry.rows.set(siren, {
    siren, legal_name: "TIMEOUT TEST SARL", status: "active",
    address: { line1: null, line2: null, postal_code: null, city: null, country: "FR" },
    effective_at: "2026-11-01T00:00:00.000Z",
  });
  const r = await api(env, env.tokensB.analyst, "POST", `/v1/suppliers/${supplierId}/refreshes`, {
    reason: "stale evidence",
    expected_version: 1,
    key: "timeout-key",
  });
  const rail = env.providers.rail as any;
  rail.fault = "timeout";
  await drainAll(env); // reserves, then dispatch times out -> reconciling
  let detail = await api(env, env.tokensB.approver, "GET", `/v1/refreshes/${r.json.refresh.id}`);
  assert.equal(detail.json.refresh.state, "reconciling");
  const intent = detail.json.spendIntents[0];
  assert.equal(intent.status, "reconciling");

  const chargesBefore = rail.charges.length;
  await drainAll(env);
  assert.equal(rail.charges.length, chargesBefore, "no automatic second purchase");
  rail.fault = null;
});
