import type { DB } from "../db.ts";
import { newId, now, tx } from "../db.ts";
import { activePolicy } from "./policy.ts";
import { audit } from "./audit.ts";
import { computeAndStoreDiffs } from "./diffService.ts";
import { RailError, type PaymentRail } from "../providers/rail.ts";
import type { ProviderSet } from "../providers/index.ts";

/** Minor units already committed (settled) or in flight (reserved/dispatched/reconciling). */
export function committedMinor(db: DB, tenantId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor),0) AS total FROM spend_intents
       WHERE tenant_id = ? AND status IN ('reserved','dispatched','settled','reconciling')`
    )
    .get(tenantId) as { total: number };
  return row.total;
}

function setRefreshState(db: DB, id: string, state: string, blockReason?: string | null) {
  db.prepare("UPDATE refreshes SET state = ?, block_reason = ?, updated_at = ? WHERE id = ?").run(
    state,
    blockReason ?? null,
    now(),
    id
  );
}

function blockRefresh(db: DB, refresh: Record<string, unknown>, reason: string) {
  setRefreshState(db, String(refresh.id), "blocked", reason);
  audit(db, null, String(refresh.tenant_id), "refresh.blocked", "refresh", String(refresh.id), { reason });
}

/**
 * Step 1 (queued -> reserved|blocked): obtain the provider quote, enforce
 * per-call and cumulative caps BEFORE any paid execution is invoked (T-008),
 * then persist the reservation + dispatch outbox in one transaction.
 */
export async function processRefresh(db: DB, providers: ProviderSet, refreshId: string): Promise<void> {
  const refresh = db.prepare("SELECT * FROM refreshes WHERE id = ?").get(refreshId) as Record<string, unknown> | undefined;
  if (!refresh || refresh.state !== "queued") return;
  const tenantId = String(refresh.tenant_id);
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?").get(refresh.supplier_id, tenantId) as Record<string, unknown>;
  const policy = activePolicy(db, tenantId);

  let quote;
  try {
    quote = await providers.registry.quote(String(supplier.siren));
  } catch (e) {
    blockRefresh(db, refresh, `quote_failed: ${(e as Error).message}`);
    return;
  }
  const rejectQuote = (reason: string) =>
    tx(db, () => {
      const qid = persistQuote(db, tenantId, quote, "rejected");
      db.prepare("UPDATE refreshes SET quote_id = ? WHERE id = ?").run(qid, refresh.id);
      blockRefresh(db, refresh, reason);
    });
  if (!policy.approvedProviders.includes(quote.provider)) {
    rejectQuote(`provider_not_approved: ${quote.provider}`);
    return;
  }
  if (quote.currency !== policy.currency) {
    rejectQuote(`currency_mismatch: quote ${quote.currency} vs policy ${policy.currency}`);
    return;
  }
  if (quote.amountMinor > policy.perCallMaxMinor) {
    rejectQuote(`over_per_call_cap: quote ${quote.amountMinor}${quote.currency} exceeds ${policy.perCallMaxMinor}`);
    return;
  }
  const committed = committedMinor(db, tenantId);
  if (committed + quote.amountMinor > policy.cumulativeCapMinor) {
    rejectQuote(`over_cumulative_cap: committed ${committed} + quote ${quote.amountMinor} exceeds ${policy.cumulativeCapMinor}`);
    return;
  }

  tx(db, () => {
    const quoteId = persistQuote(db, tenantId, quote, "consumed");
    const intentId = newId("spi");
    const ts = now();
    db.prepare(
      `INSERT INTO spend_intents (id, tenant_id, refresh_id, listing_id, amount_minor, currency, grant_ref, rail, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'reserved', ?, ?)`
    ).run(
      intentId,
      tenantId,
      refreshId,
      quote.listingId,
      quote.amountMinor,
      quote.currency,
      `policy:${policy.id}:v${policy.version}`,
      providers.railName,
      ts,
      ts
    );
    db.prepare("UPDATE refreshes SET state = 'reserved', quote_id = ?, updated_at = ? WHERE id = ?").run(quoteId, ts, refreshId);
    db.prepare(
      "INSERT INTO outbox (id, tenant_id, kind, payload, state, next_at, created_at, updated_at) VALUES (?,?,?,?, 'pending', ?, ?, ?)"
    ).run(newId("out"), tenantId, "spend.dispatch", JSON.stringify({ spendIntentId: intentId }), ts, ts, ts);
    audit(db, null, tenantId, "spend.reserved", "spend_intent", intentId, {
      refreshId,
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      rail: providers.railName,
    });
  });
}

function persistQuote(db: DB, tenantId: string, q: { provider: string; listingId: string; siren: string; amountMinor: number; currency: string; expiresAt: string; metadata: unknown }, state: string): string {
  const id = newId("quo");
  db.prepare(
    `INSERT INTO quotes (id, tenant_id, provider, listing_id, siren, amount_minor, currency, expires_at, metadata, state, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, tenantId, q.provider, q.listingId, q.siren, q.amountMinor, q.currency, q.expiresAt, JSON.stringify(q.metadata), state, now());
  return id;
}

/**
 * Step 2 (reserved -> awaiting_source|reconciling|blocked): the single paid
 * side effect. An uncertain outcome parks the intent in reconciling and never
 * redispatches automatically (INV-04).
 */
export async function dispatchSpend(db: DB, providers: ProviderSet, spendIntentId: string): Promise<void> {
  const intent = db.prepare("SELECT * FROM spend_intents WHERE id = ?").get(spendIntentId) as Record<string, unknown> | undefined;
  if (!intent || intent.status !== "reserved") return;
  const refresh = db.prepare("SELECT * FROM refreshes WHERE id = ?").get(intent.refresh_id) as Record<string, unknown>;
  const tenantId = String(intent.tenant_id);

  try {
    await providers.rail.charge({
      id: String(intent.id),
      refreshId: String(intent.refresh_id),
      amountMinor: Number(intent.amount_minor),
      currency: String(intent.currency),
      grantRef: String(intent.grant_ref),
      listingId: String(intent.listing_id),
    }).then(async (res) => {
      tx(db, () => {
        // Receipt matching is keyed on the stable partner reference; a retried
        // callback for the same remote_ref is ignored (INV-04).
        db.prepare(
          `INSERT OR IGNORE INTO receipts (id, tenant_id, spend_intent_id, remote_ref, amount_minor, currency, status, payload, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(newId("rcp"), tenantId, intent.id, res.remoteRef, res.status === "failed" ? 0 : Number(intent.amount_minor), intent.currency, res.status, JSON.stringify(res.receipt), now());
        db.prepare("UPDATE spend_intents SET status = ?, remote_ref = ?, updated_at = ? WHERE id = ?").run(
          res.status === "settled" ? "settled" : res.status === "pending" ? "dispatched" : "failed",
          res.remoteRef,
          now(),
          intent.id
        );
        const ts = now();
        if (res.status === "settled") {
          db.prepare("UPDATE refreshes SET state = 'awaiting_source', updated_at = ? WHERE id = ?").run(ts, refresh.id);
          db.prepare(
            "INSERT INTO outbox (id, tenant_id, kind, payload, state, next_at, created_at, updated_at) VALUES (?,?,?,?, 'pending', ?, ?, ?)"
          ).run(newId("out"), tenantId, "source.fetch", JSON.stringify({ refreshId: refresh.id, spendIntentId: intent.id }), ts, ts, ts);
        } else if (res.status === "pending") {
          db.prepare("UPDATE refreshes SET state = 'reconciling', updated_at = ? WHERE id = ?").run(ts, refresh.id);
        } else {
          db.prepare("UPDATE refreshes SET state = 'blocked', block_reason = 'payment_failed', updated_at = ? WHERE id = ?").run(ts, refresh.id);
        }
        audit(db, null, tenantId, "spend.dispatched", "spend_intent", String(intent.id), {
          remoteRef: res.remoteRef,
          status: res.status,
        });
      });
    });
  } catch (e) {
    const err = e as RailError;
    tx(db, () => {
      if (err instanceof RailError && err.uncertain) {
        db.prepare("UPDATE spend_intents SET status = 'reconciling', failure = ?, updated_at = ? WHERE id = ?").run(err.message, now(), intent.id);
        db.prepare("UPDATE refreshes SET state = 'reconciling', updated_at = ? WHERE id = ?").run(now(), refresh.id);
        audit(db, null, tenantId, "spend.uncertain", "spend_intent", String(intent.id), { error: err.message });
      } else if (err instanceof RailError && err.code === "external_authority_required") {
        db.prepare("UPDATE spend_intents SET status = 'reserved', failure = ?, updated_at = ? WHERE id = ?").run(err.message, now(), intent.id);
        db.prepare("UPDATE refreshes SET state = 'blocked', block_reason = ?, updated_at = ? WHERE id = ?").run(err.code, now(), refresh.id);
        audit(db, null, tenantId, "spend.blocked_no_authority", "spend_intent", String(intent.id), { error: err.message });
      } else {
        db.prepare("UPDATE spend_intents SET status = 'failed', failure = ?, updated_at = ? WHERE id = ?").run(err.message, now(), intent.id);
        db.prepare("UPDATE refreshes SET state = 'blocked', block_reason = 'dispatch_failed', updated_at = ? WHERE id = ?").run(now(), refresh.id);
        audit(db, null, tenantId, "spend.failed", "spend_intent", String(intent.id), { error: err.message });
      }
    });
  }
}

/** Manual reconciliation of an uncertain intent via the stable remote ref. */
export async function reconcileSpend(db: DB, providers: ProviderSet, spendIntentId: string, actor: { id: string; role: string } | null): Promise<{ status: string }> {
  const intent = db.prepare("SELECT * FROM spend_intents WHERE id = ?").get(spendIntentId) as Record<string, unknown> | undefined;
  if (!intent) return { status: "not_found" };
  const remoteRef = intent.remote_ref as string | null;
  if (!remoteRef) return { status: "no_remote_ref" };
  const res = await providers.rail.inquire(remoteRef);
  const tenantId = String(intent.tenant_id);
  tx(db, () => {
    if (res.status === "settled") {
      db.prepare("UPDATE spend_intents SET status = 'settled', updated_at = ? WHERE id = ?").run(now(), intent.id);
      audit(db, actor as never, tenantId, "spend.reconciled_settled", "spend_intent", String(intent.id), { remoteRef });
    } else if (res.status === "failed" || res.status === "unknown") {
      db.prepare("UPDATE spend_intents SET status = 'reconciling', updated_at = ? WHERE id = ?").run(now(), intent.id);
    }
  });
  return { status: res.status };
}

/**
 * Step 3 (awaiting_source -> review_ready|blocked): execute the registry order,
 * persist the snapshot + observations, quarantine identity mismatches, compute
 * diffs.
 */
export async function fetchSource(db: DB, providers: ProviderSet, refreshId: string): Promise<void> {
  const refresh = db.prepare("SELECT * FROM refreshes WHERE id = ?").get(refreshId) as Record<string, unknown> | undefined;
  if (!refresh || refresh.state !== "awaiting_source") return;
  const tenantId = String(refresh.tenant_id);
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(refresh.supplier_id) as Record<string, unknown>;
  const intent = db.prepare("SELECT * FROM spend_intents WHERE refresh_id = ? AND status = 'settled' ORDER BY created_at DESC LIMIT 1").get(refreshId) as Record<string, unknown> | undefined;
  const quote = refresh.quote_id ? (db.prepare("SELECT * FROM quotes WHERE id = ?").get(refresh.quote_id) as Record<string, unknown>) : null;
  const remoteRef = (intent?.remote_ref as string) ?? `unpaid_${refreshId}`;

  let result;
  try {
    result = await providers.registry.execute({
      listingId: quote ? String(quote.listing_id) : "lst_fixture-sirene_entity",
      siren: String(supplier.siren),
      remoteRef,
    });
  } catch (e) {
    const err = e as Error & { uncertain?: boolean };
    if (err.uncertain) {
      setRefreshState(db, refreshId, "reconciling");
      audit(db, null, tenantId, "source.uncertain", "refresh", refreshId, { error: err.message });
    } else {
      blockRefresh(db, refresh, `source_failed: ${err.message}`);
    }
    return;
  }

  tx(db, () => {
    const snapId = newId("snp");
    const quarantined = result.record.siren !== String(supplier.siren);
    db.prepare(
      `INSERT INTO snapshots (id, tenant_id, siren, source, payload, snapshot_hash, retrieved_at, source_effective_at, terms, quarantined, quarantine_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      snapId,
      tenantId,
      String(supplier.siren),
      providers.registry.name,
      JSON.stringify(result.rawPayload),
      result.snapshotHash,
      result.retrievedAt,
      result.sourceEffectiveAt,
      JSON.stringify(result.terms),
      quarantined ? 1 : 0,
      quarantined ? `siren_mismatch: source returned ${result.record.siren}` : null
    );
    db.prepare("UPDATE refreshes SET snapshot_id = ?, updated_at = ? WHERE id = ?").run(snapId, now(), refreshId);

    if (quarantined) {
      setRefreshState(db, refreshId, "blocked", "siren_mismatch");
      audit(db, null, tenantId, "snapshot.quarantined", "snapshot", snapId, {
        expected: supplier.siren,
        got: result.record.siren,
      });
      return;
    }

    computeAndStoreDiffs(
      db,
      refreshId,
      tenantId,
      String(supplier.siren),
      supplier.accepted_snapshot as string | null,
      result.record,
      providers.registry.name,
      result.sourceEffectiveAt,
      result.retrievedAt,
      snapId
    );
    setRefreshState(db, refreshId, "review_ready");
    audit(db, null, tenantId, "refresh.review_ready", "refresh", refreshId, { snapshotId: snapId });
  });
}

export async function processOutboxRow(db: DB, providers: ProviderSet, row: Record<string, unknown>): Promise<void> {
  const payload = JSON.parse(String(row.payload)) as Record<string, string>;
  if (row.kind === "refresh.process") await processRefresh(db, providers, payload.refreshId);
  else if (row.kind === "spend.dispatch") await dispatchSpend(db, providers, payload.spendIntentId);
  else if (row.kind === "source.fetch") await fetchSource(db, providers, payload.refreshId);
}
