# Vendor Refresh · Technical design

## Architecture and ownership

Preserve an established target repo's stack and conventions. For a greenfield target the proposed baseline is a typed HTTP application, PostgreSQL, a supervised background worker and a role-aware web console. Use object storage for large evidence, opaque references in the database, and server-side authorization on retrieval. A transaction writes a domain decision and its outbox row together. A worker processes external side effects and stores a durable result independently of the browser session.

**Actors.** AP analysts manage vendor evidence. A budget owner authorizes paid registry purchases. An AP approver accepts or dismisses changes. Finance admins can export accepted evidence. Supplier contacts have no write access.

## Domain schema

Supplier(tenant,id,siren,version,accepted_snapshot); InvoiceRef(tenant,id,external_ref,vendor_id,issued_at); Observation(id,siren,field,value,source,source_effective_at,retrieved_at,snapshot_hash); Refresh(id,tenant,supplier_id,expected_version,trigger_key,policy_version,quote_id,state); SpendIntent(id,refresh_id,currency,max_minor,remote_ref,status); Review(id,refresh_id,field_diffs,expected_version,actor,decision); unique(tenant,siren), unique(tenant,trigger_key), unique(spend_intent.id). Store source terms, attribution and field retention limits with each snapshot.

Index tenant-scoped business keys, workflow status and pending work. Version migrations and test forward migration from a populated previous schema. Write quantities and currency using explicit units and integer minor or token units. Persist the precision alongside provider amounts. A comparison involving different currencies requires an explicit valuation source and timestamp.

## HTTP and worker boundaries

POST /v1/suppliers/import validates rows and returns row-level reasons; POST /v1/invoices/import links invoice fields; POST /v1/suppliers/{id}/refreshes requires reason, expected version and key; GET /v1/refreshes/{id} returns purchase state and field provenance; POST /v1/refreshes/{id}/decision requires current version; GET /v1/exports/accepted?cursor= streams tenant-scoped changes.

Apply tenant membership and action scope on the server. Use a durable idempotency key on commands that can trigger work or payment. An identical retry returns the stored operation reference. A different payload under the same key yields a conflict. Keep polling and webhooks causally tied to the original operation. Apply provider signature verification when supported and reject unverified callbacks as evidence of settlement.

## Decision procedure

Normalize SIREN as nine digits preserving leading zeros. Use an explicit supplier link and refuse a name-only identity merge. Compare normalized names/addresses with a versioned rule while retaining source text; a missing field is unknown. Compare source effective time and retrieval time separately. Coalesce concurrent triggers against the same accepted version and freshness policy. Reserve a priced eligible listing within per-call and cumulative caps before dispatch. Never replace a newer observation with an older effective record. Require a human decision to advance the accepted version.

## State model

Vendor is unverified, monitored or archived. A refresh moves queued → reserved → awaiting_source → review_ready → accepted or dismissed. An uncertain charge goes to reconciling; a stale base goes to superseded. Missing data stays flagged as unknown. An unsupported or unavailable source ends as blocked, with a reason.

## Recovery

Use one persisted intent before a provider call. Query a stable partner order/payment reference after timeout; if unavailable, retain the reservation and request operator reconciliation. Retry safe reads only. Recompute against the current accepted version before any decision. Restore cached evidence only within source terms.

Use a compare-and-set version or row lock for conflicting decisions. Persist an intent before dispatch. If the provider cannot establish what happened, expose a pending-reconciliation state and stop automatic redispatch. Reconcile with the original provider reference, exact amount and scope. Maintain append-only corrections where users depend on the original evidence.

## Operations and integration

Record operation ID, actor role, decision code, latency and the external reference in access-controlled logs. Track stalled operations by age and surface them to the responsible role. Run migrations before workers, test a process restart during an in-flight request, and check convergence from an independently restored database. Deploy web and worker with separate credentials. See [the integration contract](KITE-AND-PROVIDERS.md) and [the tests](TEST-PLAN.md).
