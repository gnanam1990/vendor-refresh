# Vendor Refresh · Demonstration script

**Input and expected outcome.** Example policy $0.05 per call and $0.10 total. Two imports flag the same supplier version; one $0.02 source quote yields one purchase. A newer registry address and absent status field yield one address change and one unknown. Acceptance increments the supplier version exactly once. A later $0.06 quote is blocked before paid execution.

**Operator surfaces.** Analyst inbox filters stale, conflict and unknown records. Supplier detail shows original values, normalized comparisons, source effective date, retrieved date and current accepted version. Refresh panel shows quoted maximum, cap and uncertain charge. Approver can accept or dismiss with reason. Export preview includes only accepted field deltas.

**Failure to demonstrate.** Use one persisted intent before a provider call. Query a stable partner order/payment reference after timeout; if unavailable, retain the reservation and request operator reconciliation. Retry safe reads only. Recompute against the current accepted version before any decision. Restore cached evidence only within source terms.

Create a labeled, rights-cleared sample through the import or creation UI. Identify the seeded input separately from all real actions and receipts. Record with two appropriate role sessions where required, browser refresh and worker restart. Use a final export or read-only case view tied to the input revision; show any unsupported capabilities as such. Record actual outcomes next to expected outcomes in the target repo.
