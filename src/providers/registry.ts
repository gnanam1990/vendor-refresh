import { createHash } from "node:crypto";

/**
 * Registry provider contract (seller adapter capabilities):
 * discover/quote -> execute -> status. Refund/cancel only where documented.
 * Everything a provider returns carries its own source timing so downstream
 * diffs can cite the applicable timestamp (INV-03).
 */

export interface RegistryQuote {
  provider: string;
  listingId: string;
  siren: string;
  amountMinor: number;
  currency: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
}

export interface RegistryRecord {
  siren: string;
  legal_name: string | null;
  status: string | null; // absent (not null-able distinction): may be undefined in payload
  address: {
    line1: string | null;
    line2: string | null;
    postal_code: string | null;
    city: string | null;
    country: string | null;
  };
}

export interface RegistryFetchResult {
  remoteRef: string;
  record: RegistryRecord;
  rawPayload: Record<string, unknown>;
  sourceEffectiveAt: string | null;
  retrievedAt: string;
  snapshotHash: string;
  terms: Record<string, unknown>;
}

export interface RegistryStatus {
  remoteRef: string;
  state: "available" | "pending" | "failed" | "unknown";
  result?: RegistryFetchResult;
}

export interface RegistryProvider {
  name: string;
  /** Discover whether the provider can serve this SIREN and quote a price. */
  quote(siren: string): Promise<RegistryQuote>;
  /** Execute a purchase against a previously reserved listing/order. */
  execute(order: { listingId: string; siren: string; remoteRef: string }): Promise<RegistryFetchResult>;
  /** Re-inspect a stable partner order/payment reference after uncertainty. */
  status(remoteRef: string): Promise<RegistryStatus>;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Fields the registry may lawfully retain per snapshot, with retention basis. */
export const FIELD_RETENTION = {
  legal_name: { retained: true, basis: "public registry field" },
  status: { retained: true, basis: "public registry field" },
  address: { retained: true, basis: "public registry field" },
  bank_account: { retained: false, basis: "never collected" },
  beneficiary: { retained: false, basis: "never collected" },
} as const;
