import type { DB } from "../db.ts";
import { newId, now, tx } from "../db.ts";
import { badRequest } from "../domain/errors.ts";
import { maskSensitive } from "../domain/redact.ts";
import { audit } from "./audit.ts";
import type { Actor } from "../auth.ts";

/**
 * Sensitive exceptions: bank/beneficiary change requests are ALWAYS referred
 * to an independent manual flow (INV-06). Public company matching can never
 * authorize such a change, so the case is created pre-referred and any
 * account-like detail is masked before it touches storage or logs.
 */
export function createException(
  db: DB,
  actor: Actor,
  input: { kind: string; supplierId?: string; invoiceId?: string; detail: string }
): { id: string; state: string } {
  const allowed = ["bank_change", "beneficiary_change", "other"];
  if (!allowed.includes(input.kind)) throw badRequest("bad_kind", `kind must be one of ${allowed.join(", ")}`);
  const sensitive = input.kind === "bank_change" || input.kind === "beneficiary_change";
  return tx(db, () => {
    const id = newId("exc");
    const state = sensitive ? "referred" : "open";
    const detail = maskSensitive(input.detail ?? "");
    db.prepare(
      `INSERT INTO exceptions (id, tenant_id, kind, supplier_id, invoice_id, detail, state, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, actor.tenantId, input.kind, input.supplierId ?? null, input.invoiceId ?? null, detail, state, now());
    audit(db, actor, actor.tenantId, sensitive ? "exception.referred" : "exception.created", "exception", id, {
      kind: input.kind,
      supplierId: input.supplierId ?? null,
    });
    return { id, state };
  });
}
