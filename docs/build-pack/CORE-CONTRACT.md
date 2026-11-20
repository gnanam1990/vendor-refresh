# Vendor Refresh · acceptance contract

### FR-01 — Vendor master and invoices

Build CSV preview, explicit column mapping, SIREN validation and tenant-scoped deduplication. Save raw permitted values alongside parsed observations.

### INV-01 — Vendor master and invoices

An ambiguous match cannot link an invoice or open a paid refresh.

### FR-02 — Freshness and conflict cases

Implement a versioned clock-based policy and stable trigger coalescing per accepted supplier revision.

### INV-02 — Freshness and conflict cases

Replaying one import cannot create another billable trigger for that version.

### FR-03 — Registry adapter and terms

Define provider discovery, quoted amount, metadata, source timing and lawful field retention. Implement a real eligible source and record environment evidence.

### INV-03 — Registry adapter and terms

Every changed field identifies the source snapshot and applicable timestamp.

### FR-04 — Delegated spending and recovery

Bind the selected listing, amount, currency and grant to an intent. Use transactional reservations plus outbox, receipt matching and reconciliation.

### INV-04 — Delegated spending and recovery

Every charge belongs to one refresh; a timed-out payment cannot trigger a second purchase automatically.

### FR-05 — Field differences and decisions

Produce field-level deltas with source originals, effective dates and comparison rules. Apply an accepted decision using optimistic concurrency.

### INV-05 — Field differences and decisions

Only a current reviewed revision can become the accepted supplier snapshot.

### FR-06 — AP inbox and sensitive exceptions

Build accessible case list, decision screen, exception routing and redacted evidence preview.

### INV-06 — AP inbox and sensitive exceptions

Public company matching can never authorize a beneficiary-account change.

### FR-07 — Close, export and pilot evidence

Build paginated accepted-change export, spend reconciliation and pilot report of paid checks, unresolved items and analyst time.

### INV-07 — Close, export and pilot evidence

Dismissed, unknown and superseded observations are excluded from accepted exports.

### NFR-01 — Replayable evidence

A reviewer can reproduce the outcome from the exact input revision, actor scope, persisted decision and redacted evidence reference after a process restart.
