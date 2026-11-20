# Vendor Refresh · Test plan

Every test begins NOT_RUN. [Registry](requirements.json) links each test to one module and its requirement. Run fast domain tests first, then real database/worker integration and normal browser entry points. External integration evidence states its environment and provider.

## Reference end-to-end acceptance

Example policy $0.05 per call and $0.10 total. Two imports flag the same supplier version; one $0.02 source quote yields one purchase. A newer registry address and absent status field yield one address change and one unknown. Acceptance increments the supplier version exactly once. A later $0.06 quote is blocked before paid execution.

Run from a clean checkout. Capture the action through the UI or supported API, restart at an uncertain boundary, inspect the recovered record with a second authorized session and export the allowed outcome. Verify a different tenant cannot access it. Exercise the chosen provider against an authorized sandbox/test environment; a local boundary emulator is suitable for deterministic fault injection. Qualify each result by environment.

## Module tests

### T-001 — Vendor master and invoices • expected behavior

Status: NOT_RUN

Import the same valid supplier twice and observe one tenant supplier and two import receipts.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-002 — Vendor master and invoices • failure boundary

Status: NOT_RUN

A nine-digit value from the wrong column and a name-only row return per-row errors.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-003 — Freshness and conflict cases • expected behavior

Status: NOT_RUN

Two concurrent scans find one case for the same stale vendor.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-004 — Freshness and conflict cases • failure boundary

Status: NOT_RUN

An absent optional status yields unknown and never overwrites accepted status.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-005 — Registry adapter and terms • expected behavior

Status: NOT_RUN

Normalize a public sample record with a licensed reference and display both timestamps.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-006 — Registry adapter and terms • failure boundary

Status: NOT_RUN

A source returning a different SIREN is quarantined and cannot update the case.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-007 — Delegated spending and recovery • expected behavior

Status: NOT_RUN

Two simultaneous $0.02 requests for the same case create one reservation and one merchant reference.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-008 — Delegated spending and recovery • failure boundary

Status: NOT_RUN

A $0.06 quote against a $0.05 cap is rejected before paid execution is invoked.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-009 — Field differences and decisions • expected behavior

Status: NOT_RUN

Accept the address diff and observe exactly one version increment and preserved history.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-010 — Field differences and decisions • failure boundary

Status: NOT_RUN

Approving a stale tab returns conflict; an older source observation cannot roll the record back.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-011 — AP inbox and sensitive exceptions • expected behavior

Status: NOT_RUN

A user can navigate from invoice discrepancy through review to accepted record by keyboard.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-012 — AP inbox and sensitive exceptions • failure boundary

Status: NOT_RUN

A bank-change request is referred for independent handling without storing an account in logs.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-013 — Close, export and pilot evidence • expected behavior

Status: NOT_RUN

Replay import to export with one accepted change and reconcile the sole $0.02 receipt.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-014 — Close, export and pilot evidence • failure boundary

Status: NOT_RUN

A cross-tenant cursor or spreadsheet formula in a source field cannot leak data or execute on export.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.
