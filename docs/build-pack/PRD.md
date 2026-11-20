# Vendor Refresh · Product requirements

## Product decision

Monitor legal name, published status and registered address for French legal entities identified by SIREN. Maintain a tenant-specific policy for freshness, approved providers and spend. Invoice import uses only vendor reference, issue date and company identity fields. Private bank and beneficiary changes are separate manual cases. No payment release, beneficiary verification or automatic ERP master update.

**Buyer and commercial hypothesis.** Accounts-payable teams managing French suppliers. Charge per monitored supplier and paid recheck. Pitch an AP outsourcing company first.

**People and responsibilities.** AP analysts manage vendor evidence. A budget owner authorizes paid registry purchases. An AP approver accepts or dismisses changes. Finance admins can export accepted evidence. Supplier contacts have no write access.

## Customer journey

An AP analyst imports a vendor master and invoice, links by verified SIREN, sees why a field is stale or conflicting, requests a refresh, reviews the evidence diff and accepts a new version. The finance lead exports accepted changes and reconciles the source-provider charge separately.

## Acceptance scene

Example policy $0.05 per call and $0.10 total. Two imports flag the same supplier version; one $0.02 source quote yields one purchase. A newer registry address and absent status field yield one address change and one unknown. Acceptance increments the supplier version exactly once. A later $0.06 quote is blocked before paid execution.

## Behaviors for the team

- **FR-01 · Vendor master and invoices.** Build CSV preview, explicit column mapping, SIREN validation and tenant-scoped deduplication. Save raw permitted values alongside parsed observations.
- **FR-02 · Freshness and conflict cases.** Implement a versioned clock-based policy and stable trigger coalescing per accepted supplier revision.
- **FR-03 · Registry adapter and terms.** Define provider discovery, quoted amount, metadata, source timing and lawful field retention. Implement a real eligible source and record environment evidence.
- **FR-04 · Delegated spending and recovery.** Bind the selected listing, amount, currency and grant to an intent. Use transactional reservations plus outbox, receipt matching and reconciliation.
- **FR-05 · Field differences and decisions.** Produce field-level deltas with source originals, effective dates and comparison rules. Apply an accepted decision using optimistic concurrency.
- **FR-06 · AP inbox and sensitive exceptions.** Build accessible case list, decision screen, exception routing and redacted evidence preview.
- **FR-07 · Close, export and pilot evidence.** Build paginated accepted-change export, spend reconciliation and pilot report of paid checks, unresolved items and analyst time.

The [acceptance contract](CORE-CONTRACT.md) defines the fail/hold conditions for each requirement. Show the operator the responsible actor, decision reason, missing input and next possible action.

## Demand and release evidence

Recruit an AP outsourcer with permission to share a redacted master. Compare analyst time and correctly identified field changes on 30 consenting vendor records with a manual check of the same source. Capture provider, price, terms and available fields during capability verification. Price per monitored vendor plus an explicit paid-refresh line.

Track completed cases over attempted cases, human exceptions, time to resolution and direct provider costs. Preserve the denominator and separate demonstration records from pilot records. Compare with the buyer's current manual workflow on the same cases. The adjacent Atlas project is [SupplyPilot](https://devpost.com/software/supplypilot); customer willingness to pay requires pilot evidence.

## Larger team scope

- Registry-source adapters and versioned field normalization
- Entity links across suppliers and subsidiaries, stale-snapshot policies
- Review queues with reasons, exception escalation and ERP export
- Spend attribution, registry payload retention and bulk monitoring

These are product surfaces for a substantial team backlog. Size independently deliverable changes from real integrations, acceptance cases and findings. Around 500 meaningful commits is a scope preference. Actual change count follows the implementation.
