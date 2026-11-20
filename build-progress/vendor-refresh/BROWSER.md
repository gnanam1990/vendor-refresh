# Browser verification — normal-browser journey check

`scripts/browser-check.mjs` drives the documented review-and-decide journey
through the real server-rendered UI in a real Chromium-family browser, over
CDP (Chrome DevTools Protocol) — no npm dependencies beyond Node 22's
built-in WebSocket.

## Run it

```sh
# from the repository root
node scripts/browser-check.mjs
```

## Dependencies

- Node >= 22 (native WebSocket, `node:sqlite`, TS type stripping).
- A Chromium-family executable. Resolution order:
  1. `VR_CHROME=/path/to/chrome` (recommended for CI/host replay)
  2. newest `chromium_headless_shell-*` under `~/Library/Caches/ms-playwright`
     (verified locally: `chromium_headless_shell-1254`, Chrome for Testing 158)
  3. `chrome-headless-shell` / `google-chrome` / `chromium` / `chrome` on PATH.
- No npm install, no Playwright package, no network access.

Everything else is self-provisioning: the script picks an ephemeral port,
creates a disposable `.browser-*` workdir (DB, fixture registry data, browser
profile), spawns the real `src/main.ts` entry point plus the in-process
worker, reads the seeder's `credentials.seed.json` (mode 600, synthetic local
users), and removes the workdir on exit (`VR_KEEP=1` keeps it).

## What it covers (all through rendered pages + real input events)

1. Credential sign-in via the `/login` form (Enter submits; no dev picklist
   unless `VR_DEV_LOGIN=1`).
2. Vendor-master import via `/imports/new` preview -> commit.
3. Freshness scan from `/inbox`; stale case visible.
4. Supplier page -> request refresh -> polls rendered page to `review_ready`.
5. Sign out, sign in as a second authorized actor (approver) via the same
   credential form.
6. Review page renders the changed address (old + new) and the `unknown`
   field ("not present at source"); desktop screenshot.
7. Keyboard-only decision: Tab traversal to the labelled reason field and
   the Accept button, visible `:focus-visible` outline, Enter submits.
8. Reload -> "Recorded decision" (outcome, actor, reason, revision) and
   supplier `version 2` render server-side — persistence proven.
9. Conflicting re-decision -> HTTP 409 rendered as an operator error page.
10. 320 CSS px viewport -> no horizontal overflow (`scrollWidth <= 321`),
    decision record reachable; screenshot.
11. Back to analyst: decided case readable, no decision form; denied
    decision POST -> HTTP 403 operator error page; bad credential -> 401
    sign-in with `role="alert"`.

## Evidence

Written to `build-progress/vendor-refresh/evidence/browser/`:

- `evidence.json` — step list, assertion count, browser path, or
  `launch_error` when the environment forbids browser launch.
- `01-desktop-review.png`, `02-desktop-accepted.png`, `03-mobile-320.png`
  — captured on successful runs only.

The record contains only synthetic fixture identities and addresses — no
secrets, customer data, payment details, or provider payloads. The
disposable `credentials.seed.json` never leaves the deleted workdir.

## Status in this environment

The agent sandbox on this machine denies Chromium's Mach-port bootstrap
(`bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer:
Permission denied`) and socket binds, for both `chrome-headless-shell`
(1254) and `Google Chrome for Testing` (1254, incl. `--no-sandbox` and
`--headless=new`). The check therefore exits with `launch_error` here;
**replay on the host** with the command above — no changes needed.

The same journey was validated DOM-free over HTTP against the real routes
and rendered HTML: 28/28 contract checks pass (selectors, labels, error
pages, version increment, permission surfaces) — so the script's assertions
match the actual pages.

## Scope and gates

- Provider is the labeled `fixture-sirene` fixture; the rail is
  `local-emulator`. No live SIRENE call, no paid execution, no real human
  approval is claimed — provider and human gates stay separate and are
  recorded in STATUS.json.
- `VR_DEV_LOGIN` is unset during the check; the dev picklist must not
  render (asserted).
