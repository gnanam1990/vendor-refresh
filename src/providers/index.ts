import type { DB } from "../db.ts";
import { FixtureRegistry, type FixtureFault } from "./fixtureRegistry.ts";
import { LocalEmulatorRail, DisabledPassportRail, type PaymentRail } from "./rail.ts";
import type { RegistryProvider } from "./registry.ts";

export interface ProviderSet {
  registry: FixtureRegistry;
  rail: PaymentRail;
  railName: string;
}

export function createProviderSet(_db: DB, opts: { rail?: string; fixtureData?: string } = {}): ProviderSet {
  const fixtureData = opts.fixtureData ?? process.env.VR_FIXTURE_DATA;
  const registry = fixtureData ? FixtureRegistry.fromFile(fixtureData) : new FixtureRegistry();
  const railName = opts.rail ?? "local-emulator";
  const rail: PaymentRail = railName === "kite-passport" ? new DisabledPassportRail() : new LocalEmulatorRail();
  return { registry, rail, railName };
}
