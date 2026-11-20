# Vendor Refresh · Master build prompt

Build Vendor Refresh in the repository supplied with this pack. The product's first complete journey is the following.

An AP analyst imports a vendor master and invoice, links by verified SIREN, sees why a field is stale or conflicting, requests a refresh, reviews the evidence diff and accepts a new version. The finance lead exports accepted changes and reconciles the source-provider charge separately.

## Intake

Read repository instructions and inspect the current branch, HEAD, uncommitted work, existing architecture, locked dependencies, test commands and any ongoing implementation. Check [source baselines](SOURCES.md) before reusing upstream work. Record whether this is a dedicated greenfield project or an extension. For an existing implementation, trace each claimed capability from its real entry point before assigning completion. Preserve user changes.

## Build

Follow [the module index](MODULES.md). Drive changes from observable failing behavior. Implement actual domain rules, authorization, UI/API, storage and recovery. Use test doubles for deterministic fault injection and pair them with real local integration tests. Keep independent work moving when a partner dependency blocks one path. Expose each blocked external feature honestly in the UI and status ledger.

## Evidence and exit

Example policy $0.05 per call and $0.10 total. Two imports flag the same supplier version; one $0.02 source quote yields one purchase. A newer registry address and absent status field yield one address change and one unknown. Acceptance increments the supplier version exactly once. A later $0.06 quote is blocked before paid execution.

Show the normal workflow in a clean checkout, exercise failure and restart, and leave evidence tied to the exact tested revision. A recorded demo uses the running product and permitted inputs. Verify logs, screenshots and exports are redacted. Local building and testing begin when the owner invokes this prompt for the supplied target. Remote publishing, deployment, paid calls, account creation, signing and public submissions need action-specific authority. Use the owner’s existing grants when applicable.

After every module, and before yielding, update the [continuation records](DELIVERY.md). Tell the next agent what already works, what failed, the last command, and the first concrete operation to perform.
