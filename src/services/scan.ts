import type { DB } from "../db.ts";
import { newId, now, tx } from "../db.ts";
import { activePolicy, type Policy } from "./policy.ts";
import { audit } from "./audit.ts";
import type { Actor } from "../auth.ts";

/**
 * Freshness scan: flags each supplier whose accepted evidence is older than the
 * tenant policy. Triggers coalesce per (supplier, accepted version, policy
 * version) via a stable unique trigger key — replaying or running the scan
 * concurrently cannot create a second case for the same revision (INV-02).
 */
export function triggerKeyFor(supplierId: string, version: number, policyVersion: number, kind: string): string {
  return `${kind}:sup:${supplierId}:v${version}:p${policyVersion}`;
}

export interface ScanResult {
  scanned: number;
  created: number;
  coalesced: number;
  triggers: { id: string; supplierId: string; kind: string }[];
}

export function scanFreshness(db: DB, tenantId: string, actor: Actor | null, at?: string): ScanResult {
  const policy = activePolicy(db, tenantId);
  const nowTs = at ?? now();
  const cutoff = new Date(Date.parse(nowTs) - policy.staleAfterSeconds * 1000).toISOString();
  const suppliers = db
    .prepare(
      `SELECT id, version, accepted_at, vendor_state FROM suppliers
       WHERE tenant_id = ? AND vendor_state != 'archived'`
    )
    .all(tenantId) as { id: string; version: number; accepted_at: string | null; vendor_state: string }[];

  return tx(db, () => {
    let created = 0;
    let coalesced = 0;
    const triggers: ScanResult["triggers"] = [];
    for (const s of suppliers) {
      const basis = s.accepted_at;
      const stale = basis === null || basis < cutoff;
      if (!stale) continue;
      const key = triggerKeyFor(s.id, s.version, policy.version, "stale");
      const reason =
        basis === null
          ? "no accepted evidence for this supplier"
          : `accepted evidence from ${basis} is older than policy staleness (${policy.staleAfterSeconds}s, policy v${policy.version})`;
      const id = newId("trg");
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO triggers (id, tenant_id, supplier_id, supplier_version, policy_version, trigger_key, kind, reason, state, created_at)
           VALUES (?,?,?,?,?,?,?,?, 'open', ?)`
        )
        .run(id, tenantId, s.id, s.version, policy.version, key, "stale", reason, nowTs);
      if (res.changes === 1) {
        created++;
        triggers.push({ id, supplierId: s.id, kind: "stale" });
        audit(db, actor, tenantId, "trigger.created", "trigger", id, { supplierId: s.id, key });
      } else {
        coalesced++;
        const existing = db.prepare("SELECT id FROM triggers WHERE tenant_id=? AND trigger_key=?").get(tenantId, key) as { id: string };
        triggers.push({ id: existing.id, supplierId: s.id, kind: "stale" });
      }
    }
    return { scanned: suppliers.length, created, coalesced, triggers };
  });
}

export function openCaseList(
  db: DB,
  tenantId: string,
  filter?: string
): Record<string, unknown>[] {
  const kindFilter = filter && ["stale", "conflict", "unknown"].includes(filter) ? filter : null;
  const rows = db
    .prepare(
      `SELECT t.id, t.kind, t.reason, t.state, t.created_at, t.supplier_id, t.refresh_id,
              s.siren, s.version AS supplier_version,
              json_extract(s.accepted_snapshot,'$.legal_name') AS legal_name
       FROM triggers t JOIN suppliers s ON s.id = t.supplier_id
       WHERE t.tenant_id = ? ${kindFilter ? "AND t.kind = ?" : ""}
       ORDER BY t.created_at DESC`
    )
    .all(...(kindFilter ? [tenantId, kindFilter] : [tenantId])) as Record<string, unknown>[];
  // Unknown/conflict outcomes discovered by diffs surface under the refresh's case.
  const diffCases = db
    .prepare(
      `SELECT d.refresh_id AS id,
              CASE d.outcome WHEN 'changed' THEN 'conflict' ELSE 'unknown' END AS kind,
              (d.field || ' differs') AS reason, d.field, d.observed_value, d.accepted_value,
              r.supplier_id, s.siren, s.version AS supplier_version,
              json_extract(s.accepted_snapshot,'$.legal_name') AS legal_name,
              r.created_at, r.state
       FROM diffs d JOIN refreshes r ON r.id = d.refresh_id JOIN suppliers s ON s.id = r.supplier_id
       WHERE d.tenant_id = ? AND d.outcome != 'unchanged' AND r.state = 'review_ready'
         ${kindFilter ? "AND (CASE d.outcome WHEN 'changed' THEN 'conflict' ELSE 'unknown' END) = ?" : ""}`
    )
    .all(...(kindFilter ? [tenantId, kindFilter] : [tenantId])) as Record<string, unknown>[];
  return [...rows, ...diffCases];
}
