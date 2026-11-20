import type { DB } from "../db.ts";
import { newId, now } from "../db.ts";
import { RULE_VERSION, normalizeText } from "../domain/normalize.ts";
import type { RegistryRecord } from "../providers/registry.ts";

export const MONITORED_FIELDS = ["legal_name", "status", "address"] as const;
export type MonitoredField = (typeof MONITORED_FIELDS)[number];

interface AcceptedSnapshot {
  legal_name?: string | null;
  status?: string | null;
  address?: { line1?: string | null; line2?: string | null; postal_code?: string | null; city?: string | null; country?: string | null } | null;
}

function acceptedField(snapshot: AcceptedSnapshot | null, field: MonitoredField): string | null {
  if (!snapshot) return null;
  if (field === "address") {
    const a = snapshot.address;
    if (!a) return null;
    return [a.line1, a.line2, a.postal_code, a.city, a.country].filter(Boolean).join(", ") || null;
  }
  return (snapshot[field] as string | null | undefined) ?? null;
}

function observedField(record: RegistryRecord, field: MonitoredField): { present: boolean; value: string | null } {
  if (field === "status") {
    // An absent optional field is unknown, never empty/null overwrite (T-004).
    if (!("status" in record) || record.status === undefined || record.status === null) {
      return { present: false, value: null };
    }
    return { present: true, value: record.status };
  }
  if (field === "legal_name") return { present: true, value: record.legal_name };
  const a = record.address;
  const joined = [a?.line1, a?.line2, a?.postal_code, a?.city, a?.country].filter(Boolean).join(", ");
  return { present: true, value: joined || null };
}

export interface ComputedDiff {
  field: MonitoredField;
  acceptedValue: string | null;
  observedValue: string | null;
  outcome: "changed" | "unchanged" | "unknown";
  observationId: string;
}

/**
 * Produce field-level deltas between the accepted snapshot and a fresh registry
 * record. Each diff cites the observation, source, applicable timestamps and
 * the comparison rule version (INV-03).
 */
export function computeAndStoreDiffs(
  db: DB,
  refreshId: string,
  tenantId: string,
  siren: string,
  acceptedSnapshotJson: string | null,
  record: RegistryRecord,
  source: string,
  sourceEffectiveAt: string | null,
  retrievedAt: string,
  snapshotId: string
): ComputedDiff[] {
  const accepted: AcceptedSnapshot | null = acceptedSnapshotJson ? JSON.parse(acceptedSnapshotJson) : null;
  const diffs: ComputedDiff[] = [];
  for (const field of MONITORED_FIELDS) {
    const obs = observedField(record, field);
    const obsId = newId("obs");
    db.prepare(
      `INSERT INTO observations (id, tenant_id, siren, field, value, source, source_effective_at, retrieved_at, snapshot_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      obsId,
      tenantId,
      siren,
      field,
      obs.present ? (obs.value === null ? null : JSON.stringify(obs.value)) : null,
      source,
      sourceEffectiveAt,
      retrievedAt,
      snapshotId
    );

    const acceptedValue = acceptedField(accepted, field);
    let outcome: ComputedDiff["outcome"];
    if (!obs.present) {
      outcome = "unknown";
    } else if (normalizeText(obs.value) === normalizeText(acceptedValue)) {
      outcome = "unchanged";
    } else {
      outcome = "changed";
    }
    // Never let an older effective record supersede newer evidence: if a newer
    // observation already exists for this field, an older-sourced value cannot
    // be a change.
    if (outcome === "changed" && sourceEffectiveAt) {
      const newer = db
        .prepare(
          `SELECT source_effective_at FROM observations
           WHERE tenant_id = ? AND siren = ? AND field = ? AND id != ?
             AND source_effective_at IS NOT NULL AND source_effective_at > ?
           ORDER BY source_effective_at DESC LIMIT 1`
        )
        .get(tenantId, siren, field, obsId, sourceEffectiveAt) as { source_effective_at: string } | undefined;
      if (newer) outcome = "unchanged";
    }

    db.prepare(
      `INSERT INTO diffs (id, tenant_id, refresh_id, field, accepted_value, observed_value, outcome,
                          source, source_effective_at, retrieved_at, rule_version, observation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      newId("dif"),
      tenantId,
      refreshId,
      field,
      acceptedValue === null ? null : JSON.stringify(acceptedValue),
      obs.present && obs.value !== null ? JSON.stringify(obs.value) : null,
      outcome,
      source,
      sourceEffectiveAt,
      retrievedAt,
      RULE_VERSION,
      obsId
    );
    diffs.push({ field, acceptedValue, observedValue: obs.present ? obs.value : null, outcome, observationId: obsId });
  }
  return diffs;
}
