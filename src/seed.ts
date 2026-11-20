import { writeFileSync } from "node:fs";
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { setCredential } from "./auth.ts";
import { luhnCheckDigit } from "./domain/siren.ts";

export interface SeedResult {
  tenantA: string;
  tenantB: string;
  users: Record<string, string>;
  usersB: Record<string, string>;
}

/**
 * Provisioned credential for a seeded local demo user. Synthetic fixture value:
 * a real scrypt-verified secret provisioned server-side, unique per user.
 * VR_SEED_CREDENTIAL_PREFIX overrides the prefix (e.g. per-environment secrets).
 */
export function seedCredential(userId: string): string {
  return `${process.env.VR_SEED_CREDENTIAL_PREFIX ?? "localdev"}-${userId}`;
}

export interface SeedOpts {
  /** If set, write provisioned credentials here (mode 600) for local operator use. */
  credFile?: string;
}

/** Build a Luhn-valid SIREN from a numeric base for fixtures/tests. */
export function makeSiren(base: number): string {
  const b8 = String(base).padStart(8, "0").slice(-8);
  return b8 + luhnCheckDigit(b8);
}

export function seed(db: DB, opts: SeedOpts = {}): SeedResult {
  const t = now();
  const tenantA = "t_acme";
  const tenantB = "t_other";
  db.prepare("INSERT OR IGNORE INTO tenants (id, name) VALUES (?,?)").run(tenantA, "Acme AP pilot");
  db.prepare("INSERT OR IGNORE INTO tenants (id, name) VALUES (?,?)").run(tenantB, "Other Org");

  const mkUser = (id: string, tenant: string, name: string, role: string) => {
    db.prepare("INSERT OR IGNORE INTO users (id, tenant_id, name, role) VALUES (?,?,?,?)").run(id, tenant, name, role);
    return id;
  };
  const users = {
    analyst: mkUser("u_ana", tenantA, "Ana Analyst", "ap_analyst"),
    owner: mkUser("u_ben", tenantA, "Ben Budgetowner", "budget_owner"),
    approver: mkUser("u_carol", tenantA, "Carol Approver", "ap_approver"),
    finance: mkUser("u_fay", tenantA, "Fay Finance", "finance_admin"),
    supplier: mkUser("u_sven", tenantA, "Sven Supplier", "supplier_contact"),
  };
  const usersB = {
    analyst: mkUser("u_olga", tenantB, "Olga Outsider", "ap_analyst"),
    approver: mkUser("u_omar", tenantB, "Omar Outsider", "ap_approver"),
    finance: mkUser("u_olive", tenantB, "Olive Outsider", "finance_admin"),
  };

  // Provision a real credential (salted scrypt hash) for every seeded identity.
  const creds: Record<string, string> = {};
  for (const uid of [...Object.values(users), ...Object.values(usersB)]) {
    creds[uid] = seedCredential(uid);
    setCredential(db, uid, creds[uid]);
  }
  if (opts.credFile) {
    writeFileSync(opts.credFile, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  }

  // Policy v1: $0.05 per call, $0.10 cumulative cap (acceptance-scene values).
  // VR_STALE_AFTER overrides the staleness window for demos/tests.
  const staleAfter = Number(process.env.VR_STALE_AFTER ?? 30 * 24 * 3600);
  db.prepare(
    `INSERT OR IGNORE INTO policies
       (id, tenant_id, version, stale_after_seconds, per_call_max_minor, cumulative_cap_minor, currency, approved_providers, active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(newId("pol"), tenantA, 1, staleAfter, 5, 10, "USD", JSON.stringify(["fixture-sirene"]), 1, t);
  db.prepare(
    `INSERT OR IGNORE INTO policies
       (id, tenant_id, version, stale_after_seconds, per_call_max_minor, cumulative_cap_minor, currency, approved_providers, active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(newId("pol"), tenantB, 1, staleAfter, 5, 10, "USD", JSON.stringify(["fixture-sirene"]), 1, t);

  return { tenantA, tenantB, users, usersB };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDb } = await import("./db.ts");
  const db = openDb(process.env.VR_DB ?? "vendor-refresh.db");
  const r = seed(db);
  console.log("seeded", JSON.stringify(r, null, 2));
}
