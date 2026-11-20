import type { DB } from "../db.ts";
import { newId, now, tx } from "../db.ts";
import { conflict, notFound, badRequest } from "../domain/errors.ts";
import { audit } from "./audit.ts";
import type { Actor } from "../auth.ts";

/**
 * Apply a human decision with optimistic concurrency: only a current reviewed
 * revision can become the accepted supplier snapshot (INV-05). Accepting
 * increments the supplier version exactly once via compare-and-set (T-009);
 * a stale expected version conflicts (T-010).
 */
export function decide(
  db: DB,
  actor: Actor,
  refreshId: string,
  input: { expectedVersion: number; decision: "accept" | "dismiss"; reason?: string }
): { reviewId: string; supplierVersion: number } {
  if (input.decision !== "accept" && input.decision !== "dismiss") {
    throw badRequest("bad_decision", "decision must be accept or dismiss");
  }
  return tx(db, () => {
    const refresh = db
      .prepare("SELECT * FROM refreshes WHERE id = ? AND tenant_id = ?")
      .get(refreshId, actor.tenantId) as Record<string, unknown> | undefined;
    if (!refresh) throw notFound("refresh not found");
    if (refresh.state === "accepted" || refresh.state === "dismissed") {
      // Idempotent replay of the same decision.
      const prior = db
        .prepare("SELECT * FROM reviews WHERE refresh_id = ? AND actor_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(refreshId, actor.id) as Record<string, unknown> | undefined;
      if (prior && prior.decision === input.decision && prior.expected_version === input.expectedVersion) {
        return { reviewId: String(prior.id), supplierVersion: Number(prior.expected_version) + (input.decision === "accept" ? 1 : 0) };
      }
      throw conflict("already_decided", `refresh already ${refresh.state}`);
    }
    if (refresh.state !== "review_ready") {
      throw conflict("not_reviewable", `refresh is ${refresh.state}, not review_ready`);
    }
    const supplier = db
      .prepare("SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?")
      .get(refresh.supplier_id, actor.tenantId) as Record<string, unknown>;
    if (Number(supplier.version) !== input.expectedVersion || Number(refresh.expected_version) !== input.expectedVersion) {
      throw conflict(
        "stale_revision",
        `supplier is at version ${supplier.version}; the review covered version ${refresh.expected_version}`,
        { currentVersion: supplier.version, reviewVersion: refresh.expected_version }
      );
    }

    const diffs = db
      .prepare("SELECT * FROM diffs WHERE refresh_id = ? AND tenant_id = ? ORDER BY field")
      .all(refreshId, actor.tenantId) as Record<string, unknown>[];
    const reviewId = newId("rev");
    const ts = now();
    db.prepare(
      `INSERT INTO reviews (id, tenant_id, refresh_id, expected_version, actor_id, decision, reason, field_diffs, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(reviewId, actor.tenantId, refreshId, input.expectedVersion, actor.id, input.decision, input.reason ?? null, JSON.stringify(diffs), ts);

    let newVersion = Number(supplier.version);
    if (input.decision === "accept") {
      // Merge: changed fields take the observed value; unknown/unchanged keep
      // the accepted value so an absent optional status never overwrites.
      const accepted = supplier.accepted_snapshot ? JSON.parse(String(supplier.accepted_snapshot)) : {};
      for (const d of diffs) {
        if (d.outcome === "changed" && d.observed_value !== null) {
          const val = JSON.parse(String(d.observed_value));
          if (d.field === "address") {
            // Observed registry addresses arrive as a normalized joined line.
            accepted.address_text = val;
          } else {
            accepted[d.field as string] = val;
          }
        }
      }
      accepted.source = "registry_refresh";
      accepted.captured_at = ts;
      accepted.review_id = reviewId;
      const res = db
        .prepare("UPDATE suppliers SET version = version + 1, accepted_snapshot = ?, accepted_at = ?, vendor_state='monitored', updated_at = ? WHERE id = ? AND version = ?")
        .run(JSON.stringify(accepted), ts, ts, supplier.id, input.expectedVersion);
      if (res.changes !== 1) {
        throw conflict("stale_revision", "supplier version changed concurrently; re-review required");
      }
      newVersion = input.expectedVersion + 1;
      db.prepare("UPDATE refreshes SET state = 'accepted', updated_at = ? WHERE id = ?").run(ts, refreshId);
      // Older open reviews on the previous revision can no longer apply.
      db.prepare(
        `UPDATE refreshes SET state = 'superseded', updated_at = ?
         WHERE tenant_id = ? AND supplier_id = ? AND expected_version = ? AND id != ? AND state = 'review_ready'`
      ).run(ts, actor.tenantId, supplier.id, input.expectedVersion, refreshId);
      db.prepare(
        "UPDATE triggers SET state = 'closed' WHERE tenant_id = ? AND supplier_id = ? AND supplier_version = ? AND state = 'open'"
      ).run(actor.tenantId, supplier.id, input.expectedVersion);
    } else {
      db.prepare("UPDATE refreshes SET state = 'dismissed', updated_at = ? WHERE id = ?").run(ts, refreshId);
    }
    audit(db, actor, actor.tenantId, `refresh.${input.decision === "accept" ? "accepted" : "dismissed"}`, "refresh", refreshId, {
      expectedVersion: input.expectedVersion,
      newVersion,
      reason: input.reason ?? null,
    });
    return { reviewId, supplierVersion: newVersion };
  });
}
