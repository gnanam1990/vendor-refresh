import type { DB } from "../db.ts";
import { forbidden, badRequest } from "../domain/errors.ts";
import { toCsvCell } from "../domain/redact.ts";

const PAGE_SIZE = 25;

/**
 * Accepted-change export: only field deltas from accepted refreshes whose
 * outcome is 'changed'. Dismissed, unknown and superseded evidence is excluded
 * (INV-07). The cursor is bound to the issuing tenant — a cursor minted for
 * another tenant is rejected rather than silently scoped (T-014).
 */
function encodeCursor(tenantId: string, lastReviewId: string, lastCreatedAt: string): string {
  return Buffer.from(JSON.stringify({ t: tenantId, r: lastReviewId, c: lastCreatedAt })).toString("base64url");
}

function decodeCursor(cursor: string, tenantId: string): { r: string; c: string } {
  let obj: { t?: string; r?: string; c?: string };
  try {
    obj = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badRequest("bad_cursor", "cursor is not decodable");
  }
  if (obj.t !== tenantId) throw forbidden("cursor was issued to a different tenant");
  if (typeof obj.r !== "string" || typeof obj.c !== "string") throw badRequest("bad_cursor", "cursor is malformed");
  return { r: obj.r, c: obj.c };
}

export interface ExportRow {
  reviewId: string;
  refreshId: string;
  supplierId: string;
  siren: string;
  field: string;
  acceptedFrom: string | null;
  acceptedTo: string | null;
  decidedBy: string;
  decisionReason: string | null;
  decidedAt: string;
  source: string | null;
  sourceEffectiveAt: string | null;
  retrievedAt: string | null;
  ruleVersion: string;
}

export function acceptedExport(
  db: DB,
  tenantId: string,
  cursor: string | null
): { rows: ExportRow[]; nextCursor: string | null } {
  const after = cursor ? decodeCursor(cursor, tenantId) : null;
  // Page on accepted reviews first, then attach their changed diffs.
  const reviews = db
    .prepare(
      `SELECT r.id, r.refresh_id, r.actor_id, r.reason, r.created_at,
              s.id AS supplier_id, s.siren
       FROM reviews r
       JOIN refreshes f ON f.id = r.refresh_id
       JOIN suppliers s ON s.id = f.supplier_id
       WHERE r.tenant_id = ? AND r.decision = 'accept' AND f.state = 'accepted'
         ${after ? "AND (r.created_at > ? OR (r.created_at = ? AND r.id > ?))" : ""}
       ORDER BY r.created_at, r.id
       LIMIT ?`
    )
    .all(...(after ? [tenantId, after.c, after.c, after.r, PAGE_SIZE + 1] : [tenantId, PAGE_SIZE + 1])) as Record<string, unknown>[];

  let nextCursor: string | null = null;
  let page = reviews;
  if (reviews.length > PAGE_SIZE) {
    page = reviews.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    nextCursor = encodeCursor(tenantId, String(last.id), String(last.created_at));
  }

  const rows: ExportRow[] = [];
  for (const rv of page) {
    const diffs = db
      .prepare("SELECT * FROM diffs WHERE refresh_id = ? AND outcome = 'changed' ORDER BY field")
      .all(rv.refresh_id) as Record<string, unknown>[];
    for (const d of diffs) {
      rows.push({
        reviewId: String(rv.id),
        refreshId: String(rv.refresh_id),
        supplierId: String(rv.supplier_id),
        siren: String(rv.siren),
        field: String(d.field),
        acceptedFrom: d.accepted_value ? JSON.parse(String(d.accepted_value)) : null,
        acceptedTo: d.observed_value ? JSON.parse(String(d.observed_value)) : null,
        decidedBy: String(rv.actor_id),
        decisionReason: (rv.reason as string) ?? null,
        decidedAt: String(rv.created_at),
        source: (d.source as string) ?? null,
        sourceEffectiveAt: (d.source_effective_at as string) ?? null,
        retrievedAt: (d.retrieved_at as string) ?? null,
        ruleVersion: String(d.rule_version),
      });
    }
  }
  return { rows, nextCursor };
}

export function exportCsv(rows: ExportRow[]): string {
  const header = ["siren", "supplier_id", "field", "accepted_from", "accepted_to", "decided_at", "decided_by", "source", "source_effective_at", "retrieved_at", "rule_version", "review_id", "refresh_id", "decision_reason"];
  const lines = [header.map(toCsvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.siren, r.supplierId, r.field, r.acceptedFrom ?? "", r.acceptedTo ?? "", r.decidedAt, r.decidedBy, r.source ?? "", r.sourceEffectiveAt ?? "", r.retrievedAt ?? "", r.ruleVersion, r.reviewId, r.refreshId, r.decisionReason ?? ""]
        .map(toCsvCell)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** Spend reconciliation: intents vs receipts, one charge per refresh. */
export function reconciliation(db: DB, tenantId: string) {
  const intents = db
    .prepare(
      `SELECT i.id, i.refresh_id, i.amount_minor, i.currency, i.status, i.remote_ref, i.rail, i.created_at,
              s.siren,
              (SELECT COUNT(*) FROM receipts rc WHERE rc.spend_intent_id = i.id) AS receipt_count
       FROM spend_intents i JOIN refreshes f ON f.id = i.refresh_id JOIN suppliers s ON s.id = f.supplier_id
       WHERE i.tenant_id = ? ORDER BY i.created_at DESC`
    )
    .all(tenantId) as Record<string, unknown>[];
  const receipts = db.prepare("SELECT * FROM receipts WHERE tenant_id = ? ORDER BY created_at DESC").all(tenantId) as Record<string, unknown>[];
  return {
    intents,
    receipts,
    totals: {
      settledMinor: intents.filter((i) => i.status === "settled").reduce((a, i) => a + Number(i.amount_minor), 0),
      reconcilingCount: intents.filter((i) => i.status === "reconciling").length,
      unreceipted: intents.filter((i) => Number(i.receipt_count) === 0 && i.status !== "reserved").length,
    },
  };
}

/** Pilot evidence: attempted vs completed cases, exceptions, paid checks, latency. */
export function pilotReport(db: DB, tenantId: string) {
  const q = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Record<string, unknown>;
  const refreshes = q(
    `SELECT COUNT(*) total,
            SUM(state='accepted') accepted,
            SUM(state='dismissed') dismissed,
            SUM(state='blocked') blocked,
            SUM(state='reconciling') reconciling,
            SUM(state IN ('queued','reserved','awaiting_source','review_ready')) in_flight
     FROM refreshes WHERE tenant_id = ?`, tenantId);
  const spend = q(
    `SELECT COUNT(*) intents,
            SUM(status='settled') settled,
            SUM(status='reconciling') uncertain
     FROM spend_intents WHERE tenant_id = ?`, tenantId);
  const latency = q(
    `SELECT AVG((julianday(r.created_at) - julianday(f.created_at)) * 86400.0) avg_seconds
     FROM reviews r JOIN refreshes f ON f.id = r.refresh_id WHERE r.tenant_id = ?`, tenantId);
  const exceptions = q(`SELECT COUNT(*) c, SUM(state='referred') referred FROM exceptions WHERE tenant_id = ?`, tenantId);
  const exports = q(
    `SELECT COUNT(*) accepted_changes FROM reviews r JOIN refreshes f ON f.id = r.refresh_id
     JOIN diffs d ON d.refresh_id = f.id AND d.outcome='changed'
     WHERE r.tenant_id = ? AND r.decision='accept' AND f.state='accepted'`, tenantId);
  return {
    environment: "local",
    cases: { attempted: refreshes.total, accepted: refreshes.accepted, dismissed: refreshes.dismissed, blocked: refreshes.blocked, reconciling: refreshes.reconciling, inFlight: refreshes.in_flight },
    paidChecks: { intents: spend.intents, settled: spend.settled, uncertain: spend.uncertain },
    humanExceptions: { total: exceptions.c, referred: exceptions.referred },
    analystTime: { avgDecisionSeconds: latency.avg_seconds ?? null },
    acceptedFieldChanges: exports.accepted_changes,
  };
}
