import type { DB } from "../db.ts";

/**
 * Payment rail contract. charge() is the only paid side effect; inquire()
 * reconciles a stable partner reference after an uncertain outcome.
 */

export interface ChargeResult {
  remoteRef: string;
  status: "settled" | "pending" | "failed";
  receipt: Record<string, unknown>;
}

export class RailError extends Error {
  uncertain: boolean;
  code: string;
  constructor(message: string, uncertain: boolean, code: string = "rail_error") {
    super(message);
    this.uncertain = uncertain;
    this.code = code;
  }
}

export interface PaymentRail {
  name: string;
  charge(intent: {
    id: string;
    refreshId: string;
    amountMinor: number;
    currency: string;
    grantRef: string;
    listingId: string;
  }): Promise<ChargeResult>;
  inquire(remoteRef: string): Promise<{ status: "settled" | "pending" | "failed" | "unknown" }>;
}

/**
 * Local emulator — a team-controlled, explicitly labeled merchant. Deterministic
 * for tests; `fault` injects timeouts/failures. Settles synchronously otherwise.
 */
export class LocalEmulatorRail implements PaymentRail {
  name = "local-emulator";
  fault: null | "timeout" | "decline" | "unavailable" = null;
  charges: { intentId: string; amountMinor: number; remoteRef: string }[] = [];
  private seq = 0;

  async charge(intent: { id: string; refreshId: string; amountMinor: number; currency: string; grantRef: string; listingId: string }): Promise<ChargeResult> {
    if (this.fault === "timeout") {
      throw new RailError("merchant timed out; charge outcome unknown", true, "timeout");
    }
    if (this.fault === "unavailable") {
      throw new RailError("merchant unavailable before charge", false, "unavailable");
    }
    const remoteRef = `loc_${(++this.seq).toString().padStart(6, "0")}_${intent.id.slice(-8)}`;
    if (this.fault === "decline") {
      this.charges.push({ intentId: intent.id, amountMinor: intent.amountMinor, remoteRef });
      return { remoteRef, status: "failed", receipt: { remote_ref: remoteRef, amount_minor: intent.amountMinor, currency: intent.currency, status: "failed", reason: "declined" } };
    }
    this.charges.push({ intentId: intent.id, amountMinor: intent.amountMinor, remoteRef });
    return {
      remoteRef,
      status: "settled",
      receipt: {
        remote_ref: remoteRef,
        amount_minor: intent.amountMinor,
        currency: intent.currency,
        status: "settled",
        merchant: "local-emulator",
        environment: "local-fixture",
      },
    };
  }

  async inquire(remoteRef: string) {
    if (this.fault === "timeout") return { status: "pending" as const };
    const c = this.charges.find((x) => x.remoteRef === remoteRef);
    return { status: c ? ("settled" as const) : ("unknown" as const) };
  }
}

/**
 * Kite Passport rail — session-bound paid execution requires owner authority
 * (seller, rail, amount, purpose) that is not granted in this run. The rail
 * therefore fails closed at dispatch: intents stay reserved and no paid call
 * is ever attempted.
 */
export class DisabledPassportRail implements PaymentRail {
  name = "kite-passport";
  async charge(): Promise<ChargeResult> {
    throw new RailError(
      "external authority unavailable: session-bound paid execution is not authorized in this environment",
      false,
      "external_authority_required"
    );
  }
  async inquire() {
    return { status: "unknown" as const };
  }
}
