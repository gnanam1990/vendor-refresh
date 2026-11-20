import type { DB } from "../db.ts";
import { FixtureRegistry, type FixtureFault } from "./fixtureRegistry.ts";
import { LocalEmulatorRail, DisabledPassportRail, type PaymentRail } from "./rail.ts";
import type { RegistryProvider } from "./registry.ts";

export interface ProviderSet {
  registry: FixtureRegistry;
  rail: PaymentRail;
  railName: string;
}

export function createProviderSet(_db: DB, opts: { rail?: string } = {}): ProviderSet {
  const registry = new FixtureRegistry();
  const railName = opts.rail ?? "local-emulator";
  const rail: PaymentRail = railName === "kite-passport" ? new DisabledPassportRail() : new LocalEmulatorRail();
  return { registry, rail, railName };
}
