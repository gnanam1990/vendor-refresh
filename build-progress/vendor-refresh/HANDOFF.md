# Vendor Refresh · Session handoff

- Target repository / branch / tested SHA: this repo, `devin/vendor-refresh`
- Current module and owner: Devin (SWE-2 High, local)
- Completed behavior: see STATUS.json module states
- Stack: Node 22 native TS (type stripping), node:sqlite, node:test, server-rendered HTML. Zero npm dependencies.
- Run: `npm test` · `npm start` (VR_PORT, VR_DB, VR_RAIL env). Seed: `npm run seed`.
- External dependencies: real SIRENE registry + session-bound paid execution (Kite Passport rail) are NOT authorized in this run — `kite-passport` rail fails closed; `local-emulator` rail and `fixture-sirene` registry are the labeled local substitutes.
- Next action: continue numbered modules in docs/build-pack/MODULES.md.
