# Vendor Refresh · Operator and customer experience

## Work surfaces and primary interaction

Analyst inbox filters stale, conflict and unknown records. Supplier detail shows original values, normalized comparisons, source effective date, retrieved date and current accepted version. Refresh panel shows quoted maximum, cap and uncertain charge. Approver can accept or dismiss with reason. Export preview includes only accepted field deltas.

**Walkthrough.** An AP analyst imports a vendor master and invoice, links by verified SIREN, sees why a field is stale or conflicting, requests a refresh, reviews the evidence diff and accepts a new version. The finance lead exports accepted changes and reconciles the source-provider charge separately.

## Interaction contract

Start a returning user in their permitted work queue. Open a record on a stable, shareable internal route. Keep input revisions, current state, decision explanation and evidence within the same case. Put actor, cost, scope and irreversible consequences beside the relevant confirmation. After submission, show the persisted operation ID and allow navigation away while the worker runs.

Support loading, empty, in-progress, pending external confirmation, denied, stale revision, completed-with-findings and unavailable states where applicable. Render server values after refresh. Preserve drafts on recoverable errors, show why a retry is or is not allowed, and make partial evidence individually identifiable.

## Accessibility acceptance

Use native controls, keyboard-visible focus, accessible names and text equivalents for status colors. On mobile show the primary task and decision before secondary details. Keep tables navigable with explicit headers, respect reduced motion, announce saved/submitted states and focus the first invalid field. Verify the case flow with keyboard-only navigation at 320 CSS pixels and with screen-reader status announcements. Include the client-appropriate redacted view in the browser proof.
