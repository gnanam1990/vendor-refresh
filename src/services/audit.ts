import type { DB } from "../db.ts";
import { newId, now } from "../db.ts";
import { maskSensitive } from "../domain/redact.ts";
import type { Actor } from "../auth.ts";

export function audit(
  db: DB,
  actor: Actor | null,
  tenantId: string,
  action: string,
  entity: string,
  entityId: string,
  detail: Record<string, unknown> = {}
): void {
  db.prepare(
    `INSERT INTO audit_log (id, tenant_id, actor_id, actor_role, action, entity, entity_id, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    newId("aud"),
    tenantId,
    actor?.id ?? null,
    actor?.role ?? "system",
    action,
    entity,
    entityId,
    maskSensitive(JSON.stringify(detail)),
    now()
  );
}
