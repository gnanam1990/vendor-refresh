import type { DB } from "../db.ts";
import { notFound } from "../domain/errors.ts";

export interface Policy {
  id: string;
  tenantId: string;
  version: number;
  staleAfterSeconds: number;
  perCallMaxMinor: number;
  cumulativeCapMinor: number;
  currency: string;
  approvedProviders: string[];
}

export function activePolicy(db: DB, tenantId: string): Policy {
  const row = db
    .prepare(
      `SELECT id, tenant_id, version, stale_after_seconds, per_call_max_minor,
              cumulative_cap_minor, currency, approved_providers
       FROM policies WHERE tenant_id = ? AND active = 1
       ORDER BY version DESC LIMIT 1`
    )
    .get(tenantId) as
    | {
        id: string;
        tenant_id: string;
        version: number;
        stale_after_seconds: number;
        per_call_max_minor: number;
        cumulative_cap_minor: number;
        currency: string;
        approved_providers: string;
      }
    | undefined;
  if (!row) throw notFound("no active policy for tenant");
  return {
    id: row.id,
    tenantId: row.tenant_id,
    version: row.version,
    staleAfterSeconds: row.stale_after_seconds,
    perCallMaxMinor: row.per_call_max_minor,
    cumulativeCapMinor: row.cumulative_cap_minor,
    currency: row.currency,
    approvedProviders: JSON.parse(row.approved_providers) as string[],
  };
}
