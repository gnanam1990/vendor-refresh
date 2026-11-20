# Vendor Refresh · Reuse and evidence

The owner’s GitHub inventory and selected source files were reviewed on 20 November 2026. Each link below pins the reviewed revision. Inspect current target behavior, compatibility and license at intake. If private access is unavailable, implement the specified interface independently and record that choice. This pack contains no upstream source code or credentials.

### kitepass-sdk

Pinned baseline `797f339d53dcfefe5d18ca3297ba4d2051d5c7ec` (public). Policy and spend trackers are integration candidates. Verify against the current Passport contracts and session behavior before adopting.

[policy.ts](https://github.com/gnanam1990/kitepass-sdk/blob/797f339d53dcfefe5d18ca3297ba4d2051d5c7ec/packages/core/src/policy.ts) · [spend-tracker.ts](https://github.com/gnanam1990/kitepass-sdk/blob/797f339d53dcfefe5d18ca3297ba4d2051d5c7ec/packages/core/src/spend-tracker.ts)

### flowops

Pinned baseline `c0431c67b62d069ee300773fd2549c64d746667b` (public). Adapt settlement and reconciliation outcomes to purchased job inputs. Decide who absorbs a failed delivery and reconcile late outcomes.

[ascp_settlement.go](https://github.com/gnanam1990/flowops/blob/c0431c67b62d069ee300773fd2549c64d746667b/cmd/control-plane-api/ascp_settlement.go) · [reconciliation_outcomes.go](https://github.com/gnanam1990/flowops/blob/c0431c67b62d069ee300773fd2549c64d746667b/cmd/control-plane-api/reconciliation_outcomes.go)

## Project lineage

Hackathon Atlas surfaced [SupplyPilot](https://devpost.com/software/supplypilot) as adjacent work. The user-approved project boundary is: Monitor legal name, published status and registered address for French legal entities identified by SIREN. Maintain a tenant-specific policy for freshness, approved providers and spend. Invoice import uses only vendor reference, issue date and company identity fields. Private bank and beneficiary changes are separate manual cases. No payment release, beneficiary verification or automatic ERP master update.

## External dependency

One public registry supplies a narrow set of facts. Bank ownership and payment-account changes require an independent confirmation flow. Platform interfaces are documented in [provider notes](KITE-AND-PROVIDERS.md). Market demand, integration behavior, source data access and live payment authority require separate evidence.
