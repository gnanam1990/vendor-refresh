import type { DB } from "../db.ts";
import { newId, now, tx } from "../db.ts";
import { activePolicy } from "./policy.ts";
import { badRequest, conflict, notFound } from "../domain/errors.ts";
import { audit } from "./audit.ts";
import { triggerKeyFor } from "./scan.ts";
import type { Actor } from "../auth.ts";

const OPEN_REFRESH_STATES = ["queued", "reserved", "awaiting_source", "review_ready", "reconciling"];

export function createRefresh(
  db: DB,
  actor: Actor,
  supplierId: string,
  input: { reason: string; expectedVersion: number; key?: string; triggerId?: string }
): { refresh: Record<string, unknown>; deduplicated: boolean } {
  if (!input.reason || input.reason.trim() === "") throw badRequest("missing_reason", "a refresh reason is required");
  if (typeof input.expectedVersion !== "number" || input.expectedVersion < 1) {
    throw badRequest("missing_version", "expected_version is required");
  }
  const key = input.key?.trim() || null;
  if (!key) throw badRequest("missing_key", "an idempotency key is required");

  const supplier = db
    .prepare("SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?")
    .get(supplierId, actor.tenantId) as Record<string, unknown> | undefined;
  if (!supplier) throw notFound("supplier not found");
  if (supplier.vendor_state === "archived") throw conflict("supplier_archived", "archived suppliers cannot be refreshed");
  if (supplier.version !== input.expectedVersion) {
    throw conflict("stale_revision", `supplier is at version ${supplier.version}, not ${input.expectedVersion}`, {
      currentVersion: supplier.version,
    });
  }

  return tx(db, () => {
    // Idempotent retry: same key + same payload returns the stored operation.
    const prior = db
      .prepare("SELECT * FROM refreshes WHERE tenant_id = ? AND idempotency_key = ?")
      .get(actor.tenantId, key) as Record<string, unknown> | undefined;
    if (prior) {
      const same =
        prior.supplier_id === supplierId &&
        prior.expected_version === input.expectedVersion &&
        prior.reason === input.reason;
      if (!same) {
        throw conflict("idempotency_conflict", "idempotency key was used with a different payload");
      }
      return { refresh: prior, deduplicated: true };
    }

    // Coalescing: one open refresh per accepted supplier revision (INV-02).
    const open = db
      .prepare(
        `SELECT * FROM refreshes WHERE tenant_id = ? AND supplier_id = ? AND expected_version = ?
         AND state IN (${OPEN_REFRESH_STATES.map(() => "?").join(",")}) ORDER BY created_at LIMIT 1`
      )
      .get(actor.tenantId, supplierId, input.expectedVersion, ...OPEN_REFRESH_STATES) as
      | Record<string, unknown>
      | undefined;
    if (open) return { refresh: open, deduplicated: true };

    const policy = activePolicy(db, actor.tenantId);
    const triggerId = input.triggerId ?? null;
    let triggerKey: string;
    if (triggerId) {
      const trg = db
        .prepare("SELECT * FROM triggers WHERE id = ? AND tenant_id = ?")
        .get(triggerId, actor.tenantId) as Record<string, unknown> | undefined;
      if (!trg) throw notFound("trigger not found");
      if (trg.supplier_id !== supplierId) throw badRequest("trigger_mismatch", "trigger belongs to a different supplier");
      if (trg.supplier_version !== input.expectedVersion) {
        throw conflict("stale_trigger", "trigger was raised against a different supplier version");
      }
      triggerKey = String(trg.trigger_key);
    } else {
      triggerKey = triggerKeyFor(supplierId, input.expectedVersion, policy.version, "manual");
    }

    const id = newId("ref");
    const ts = now();
    db.prepare(
      `INSERT INTO refreshes (id, tenant_id, supplier_id, expected_version, trigger_key, policy_version,
                             state, reason, actor_id, idempotency_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'queued', ?,?,?,?,?)`
    ).run(id, actor.tenantId, supplierId, input.expectedVersion, triggerKey, policy.version, input.reason, actor.id, key, ts, ts);
    db.prepare(
      "INSERT INTO outbox (id, tenant_id, kind, payload, state, next_at, created_at, updated_at) VALUES (?,?,?, 'pending', ?, ?, ?)"
    ).run(newId("out"), actor.tenantId, "refresh.process", JSON.stringify({ refreshId: id }), ts, ts, ts);
    if (triggerId) {
      db.prepare("UPDATE triggers SET state = 'consumed', refresh_id = ? WHERE id = ?").run(id, triggerId);
    }
    audit(db, actor, actor.tenantId, "refresh.requested", "refresh", id, {
      supplierId,
      expectedVersion: input.expectedVersion,
      triggerKey,
    });
    const refresh = db.prepare("SELECT * FROM refreshes WHERE id = ?").get(id) as Record<string, unknown>;
    return { refresh, deduplicated: false };
  });
}
