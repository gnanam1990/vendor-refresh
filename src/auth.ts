import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { forbidden, unauthorized } from "./domain/errors.ts";

export type Role = "ap_analyst" | "budget_owner" | "ap_approver" | "finance_admin" | "supplier_contact";

export interface Actor {
  id: string;
  tenantId: string;
  name: string;
  role: Role;
}

/** Provision an opaque credential for a user; stored only as a salted scrypt hash. */
export function setCredential(db: DB, userId: string, credential: string): void {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(credential, salt, 32).toString("hex");
  db.prepare("UPDATE users SET credential_hash = ?, credential_salt = ? WHERE id = ?").run(
    hash,
    salt,
    userId
  );
}

export function verifyCredential(db: DB, userId: string, credential: string): boolean {
  const u = db
    .prepare("SELECT credential_hash, credential_salt FROM users WHERE id = ?")
    .get(userId) as { credential_hash: string | null; credential_salt: string | null } | undefined;
  if (!u?.credential_hash || !u.credential_salt) return false;
  const candidate = scryptSync(credential, u.credential_salt, 32);
  return timingSafeEqual(candidate, Buffer.from(u.credential_hash, "hex"));
}

/** Real local authenticator: a session is minted only after the credential verifies. */
export function login(db: DB, userId: string, credential: string): string {
  if (!verifyCredential(db, userId, credential)) throw unauthorized("invalid user or credential");
  return createSession(db, userId);
}

export function createSession(db: DB, userId: string): string {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) throw unauthorized("unknown user");
  const token = newId("sess");
  const exp = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(
    token,
    userId,
    now(),
    exp
  );
  return token;
}

export function actorForToken(db: DB, token: string | null | undefined): Actor | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.tenant_id, u.name, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, now()) as { id: string; tenant_id: string; name: string; role: Role } | undefined;
  if (!row) return null;
  return { id: row.id, tenantId: row.tenant_id, name: row.name, role: row.role };
}

const WRITE_ROLES: Record<string, Role[]> = {
  import: ["ap_analyst", "finance_admin"],
  request_refresh: ["ap_analyst"],
  authorize_spend: ["budget_owner"],
  decide: ["ap_approver"],
  export: ["finance_admin"],
  refer_exception: ["ap_analyst", "ap_approver", "finance_admin"],
};

export function requireRole(actor: Actor, action: keyof typeof WRITE_ROLES): void {
  if (!WRITE_ROLES[action].includes(actor.role)) {
    throw forbidden(`role ${actor.role} may not perform ${action}`);
  }
}

/** supplier_contact has no write access at all. */
export function assertCanWrite(actor: Actor): void {
  if (actor.role === "supplier_contact") throw forbidden("supplier contacts are read-only");
}
