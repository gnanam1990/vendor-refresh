import { FIELD_RETENTION, hashPayload, type RegistryFetchResult, type RegistryProvider, type RegistryQuote, type RegistryRecord, type RegistryStatus } from "./registry.ts";
import { newId } from "../db.ts";

/**
 * Fixture SIRENE — a team-controlled, explicitly labeled registry emulator.
 * It stands in for the real public French registry adapter for local runs and
 * tests. Records are synthetic; quotes are deterministic ($0.02 USD). It is
 * also the fault-injection point: `fault` controls execute/status outcomes.
 */

export type FixtureFault =
  | null
  | "wrong_siren" // returns a record for a different SIREN -> quarantine path
  | "timeout" // status stays pending; execute throws uncertain error
  | "unavailable" // quote/status fail closed
  | "missing_status"; // record lacks the optional status field

interface FixtureRow {
  siren: string;
  legal_name: string;
  status?: string;
  address: RegistryRecord["address"];
  effective_at: string;
}

export class FixtureRegistry implements RegistryProvider {
  name = "fixture-sirene";
  fault: FixtureFault = null;
  quoteAmountMinor = 2;
  quoteCurrency = "USD";
  rows: Map<string, FixtureRow>;

  constructor(rows?: FixtureRow[]) {
    this.rows = new Map((rows ?? defaultFixtureRows()).map((r) => [r.siren, r]));
  }

  async quote(siren: string): Promise<RegistryQuote> {
    if (this.fault === "unavailable") throw new Error("fixture-sirene unavailable");
    return {
      provider: this.name,
      listingId: `lst_${this.name}_entity`,
      siren,
      amountMinor: this.quoteAmountMinor,
      currency: this.quoteCurrency,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      metadata: {
        environment: "local-fixture",
        description: "entity profile: legal name, published status, registered address",
        fields: ["legal_name", "status", "address"],
        terms: "fixture data for local verification only; no real registry data",
      },
    };
  }

  async execute(order: { listingId: string; siren: string; remoteRef: string }): Promise<RegistryFetchResult> {
    if (this.fault === "timeout") {
      const e = new Error("fixture-sirene timed out; outcome uncertain");
      (e as Error & { uncertain?: boolean }).uncertain = true;
      throw e;
    }
    if (this.fault === "unavailable") throw new Error("fixture-sirene unavailable");
    const row = this.rows.get(order.siren);
    const wrongSiren = this.fault === "wrong_siren" ? "999999999" : order.siren;
    const includeStatus = this.fault !== "missing_status";
    const record: RegistryRecord = row
      ? {
          siren: wrongSiren,
          legal_name: row.legal_name,
          status: includeStatus ? row.status ?? "active" : (undefined as unknown as string | null),
          address: row.address,
        }
      : {
          siren: wrongSiren,
          legal_name: `UNKNOWN ENTITY ${order.siren}`,
          status: includeStatus ? "unknown" : (undefined as unknown as string | null),
          address: { line1: null, line2: null, postal_code: null, city: null, country: "FR" },
        };
    const rawPayload: Record<string, unknown> = { record, listing_id: order.listingId };
    if (!includeStatus) delete (record as { status?: string | null }).status;
    const retrievedAt = new Date().toISOString();
    return {
      remoteRef: order.remoteRef,
      record,
      rawPayload,
      sourceEffectiveAt: row?.effective_at ?? retrievedAt,
      retrievedAt,
      snapshotHash: hashPayload(rawPayload),
      terms: {
        provider: this.name,
        environment: "local-fixture",
        license: "fixture data, no reuse restrictions",
        retention: FIELD_RETENTION,
      },
    };
  }

  async status(remoteRef: string): Promise<RegistryStatus> {
    if (this.fault === "timeout") return { remoteRef, state: "pending" };
    if (this.fault === "unavailable") throw new Error("fixture-sirene unavailable");
    return { remoteRef, state: "unknown" };
  }
}

function defaultFixtureRows(): FixtureRow[] {
  // Synthetic Luhn-valid SIRENs produced by the seed helper where needed; the
  // rows below are keyed by whatever SIREN callers register.
  return [];
}
