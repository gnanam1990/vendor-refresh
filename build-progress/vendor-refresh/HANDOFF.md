# Vendor Refresh · Session handoff

## State: ALL 7 MODULES ACCEPTED (local proof). External integrations recorded below.

- Target repository / branch / tested SHA: this repo, `devin/vendor-refresh`, see `testedSha` in STATUS.json
- Verified from clean checkout `.clean-checkout` (git clone of HEAD): `npm test` → 26/26 pass; `node scripts/acceptance.mjs` → all 7 reference steps pass.

## Stack (zero npm dependencies)

Node ≥22.18 native TypeScript (strip-types — erasable syntax only), `node:sqlite` for storage + outbox, `node:test`, server-rendered accessible HTML. No package installs needed.

## Run

- `npm test` — unit + real-DB/HTTP integration tests
- `npm start` — API + web console + worker (`VR_PORT`, `VR_DB`, `VR_RAIL`, `VR_FIXTURE_DATA`, `VR_STALE_AFTER`, `VR_SEED`)
- `node scripts/acceptance.mjs` — end-to-end reference replay incl. mid-flow restart
- Sign in at `/login` with seeded users: u_ana (analyst), u_ben (budget owner), u_carol (approver), u_fay (finance), u_sven (supplier, read-only); tenant B: u_olga/u_omar/u_olive.

## What works

M01 CSV preview + explicit allowlisted mapping + Luhn SIREN + tenant dedup + invoice link by verified SIREN only. M02 versioned staleness policy, trigger coalescing per accepted revision. M03 fixture-sirene adapter: quote/execute/status, per-snapshot terms + retention + dual timestamps, wrong-SIREN quarantine. M04 spend intents: per-call ($0.05) + cumulative ($0.10) caps pre-dispatch, one reservation/merchant-ref per case, reconciling on uncertain charge, no auto-redispatch. M05 field diffs + CAS decision (exactly-once version increment, stale → 409). M06 inbox/decision/exception UI, bank changes pre-referred + masked. M07 tenant-bound paginated export, formula-safe CSV, reconciliation + pilot report.

## External dependencies — exact missing proof

1. **Live SIRENE registry** — unavailable in this run; `fixture-sirene` (VR_FIXTURE_DATA JSON) is the labeled substitute. Missing: real service identifier, endpoint, network, quote/execute against an authorized test environment.
2. **Kite Passport paid execution** — not authorized; `VR_RAIL=kite-passport` fails closed (`external_authority_required`, refresh blocked, intent stays reserved). Missing: owner authority covering seller, rail, amount, purpose; effective payment-source check at dispatch (session vs allowance fallback).
3. **AP-outsourcer pilot** — not started; needs consenting redacted master + manual-comparison evidence for 30 records.

## Resume

Next agent: `git checkout devin/vendor-refresh && npm test`. To wire a live registry, implement `RegistryProvider` (src/providers/registry.ts) and add its name to the tenant policy `approved_providers`. To enable real payment, implement `PaymentRail` (src/providers/rail.ts) behind the same reservation/outbox flow — never dispatch without a recorded grant.
