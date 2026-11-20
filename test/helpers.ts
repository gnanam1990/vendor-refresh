import { openDb, type DB } from "../src/db.ts";
import { Router, createApp } from "../src/http/server.ts";
import { registerApi } from "../src/http/api.ts";
import { registerPages } from "../src/http/pages.ts";
import { seed, makeSiren, seedCredential, type SeedResult } from "../src/seed.ts";
import { createProviderSet, type ProviderSet } from "../src/providers/index.ts";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestEnv {
  db: DB;
  server: Server;
  base: string;
  seed: SeedResult;
  providers: ProviderSet;
  tokens: Record<string, string>;
  tokensB: Record<string, string>;
  cleanup: () => void;
}

export function makeEnv(opts: { rail?: string } = {}): TestEnv {
  const db = openDb(":memory:");
  const s = seed(db);
  const providers = createProviderSet(db, { rail: opts.rail ?? "local-emulator" });
  const router = new Router();
  registerApi(router);
  registerPages(router, providers);
  const server = createApp(db, router);
  const tokens: Record<string, string> = {};
  const tokensB: Record<string, string> = {};
  return {
    db,
    server,
    base: "",
    seed: s,
    providers,
    tokens,
    tokensB,
    cleanup() {
      server.close();
    },
  };
}

export async function listen(env: TestEnv): Promise<TestEnv> {
  await new Promise<void>((res) => env.server.listen(0, res));
  env.base = `http://localhost:${(env.server.address() as AddressInfo).port}`;
  // Authenticate every seeded actor through the real credential login.
  for (const [k, uid] of Object.entries(env.seed.users)) env.tokens[k] = await loginAs(env, uid);
  for (const [k, uid] of Object.entries(env.seed.usersB)) env.tokensB[k] = await loginAs(env, uid);
  return env;
}

/** Real login over HTTP — verifies the provisioned credential server-side. */
export async function loginAs(env: TestEnv, userId: string, credential = seedCredential(userId)): Promise<string> {
  const res = await fetch(env.base + "/v1/session/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, credential }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login failed for ${userId}: ${res.status} ${JSON.stringify(body)}`);
  return body.token;
}

export async function api(
  env: TestEnv,
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(env.base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { cookie: `vr_session=${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text };
}

export { makeSiren };

export async function drainAll(env: TestEnv, rounds = 10): Promise<number> {
  const { drain } = await import("../src/worker.ts");
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const n = await drain(env.db, env.providers);
    total += n;
    if (n === 0) break;
  }
  return total;
}

export const VENDOR_CSV_HEADERS = "siren,legal_name,vendor_ref,address_line1,postal_code,city,country,status";

export function vendorCsv(siren: string, name = "ACME FRANCE SAS"): string {
  return `${VENDOR_CSV_HEADERS}\n${siren},${name},V001,"10 rue de la Paix",75002,Paris,FR,active\n`;
}

export const VENDOR_MAP: Record<string, string> = {
  siren: "siren",
  legal_name: "legal_name",
  vendor_ref: "vendor_ref",
  address_line1: "address_line1",
  postal_code: "postal_code",
  city: "city",
  country: "country",
};

export const INVOICE_MAP: Record<string, string> = {
  external_ref: "external_ref",
  siren: "siren",
  issued_at: "issued_at",
};
